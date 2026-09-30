/**
 * M5 下载管理器（主进程侧）。
 *
 * 职责：把「解析出来的可播地址」真正落成磁盘上的文件，并维护一份能跨重启恢复的下载清单。
 *
 * 设计要点：
 * 1. **不 import electron、不 import services**：本文件只依赖 `@pi/shared` / `@pi/ipc` 的类型与
 *    `@pi/store` 的存储抽象，目录、音质夹逼、直链解析全部由构造参数注入。
 *    这样它能在 vitest 里被完整单测（含真下载到临时目录）。
 * 2. **并发固定 2 条**：下载是长连接 + 写盘，并发太高既抢带宽也抢磁盘；两条足够打满家用带宽。
 * 3. **进度两级节流**：进度变化只更新内存并节流推送（约 4 次/秒），写盘再慢一档（1 秒一次），
 *    状态跃迁（queued→downloading→done/error/paused）则**立即**推送 + 立即写盘。
 * 4. **暂停语义如实**：
 *    - 上游支持 HTTP `Range`（我们带 `Range: bytes=<已写字节>-` 过去，回 `206`）→ 从 `.part` 继续；
 *    - 上游不支持（回 `200`）→ 老老实实从头重下，并打印
 *      `[pi/downloads] 上游不支持 Range（HTTP 200）…本次改为重新下载`；
 *    - 无论哪种，界面上看到的字节数永远是 `.part` 文件在磁盘上的**真实**大小。
 * 5. **绝不假装成功**：启动对账发现文件没了只把状态标成 `missing`，不删记录、不静默忽略。
 *
 * 与渲染层的契约见 `@pi/ipc` 的 `DownloadTask` / `CH.downloads*` / `EVT.downloadsChanged`。
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { DOWNLOAD_STATUS_VALUES, type DownloadStatus, type DownloadTask } from '@pi/ipc';
import {
  QUALITY_LABEL,
  type Quality,
  type ResolveAttempt,
  type ResolvedAudio,
  type Song,
} from '@pi/shared';
import type { StorageDriver } from '@pi/store';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 同时下载的任务数。 */
export const DOWNLOAD_CONCURRENCY = 2;
/** 进度推送节流：250ms ≈ 4 次/秒（界面够顺滑，又不会刷爆 IPC）。 */
export const DOWNLOAD_EVENT_INTERVAL_MS = 250;
/** 进度写盘节流：1s 一次。JSON 驱动本身还有 500ms 去抖，实际磁盘压力很小。 */
export const DOWNLOAD_PERSIST_INTERVAL_MS = 1000;
/** 下载清单的存储 key（`downloads.json`）。 */
export const DOWNLOAD_STORE_KEY = 'downloads.tasks';

/** 认得的音频后缀（用于从 URL 猜扩展名，和 `@pi/source-local` 的 AUDIO_EXTENSIONS 对齐）。 */
const AUDIO_EXTENSIONS = new Set([
  'flac',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'wav',
  'ape',
  'wma',
]);

/** Windows 不允许的字符 + 控制字符。`/` 与 `\` 也在内，否则会写到别的目录去。 */
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Windows 保留设备名：叫 `con.mp3` 的文件在 Windows 上根本建不出来。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** 文件名主干长度上限（给扩展名和 ` (123)` 后缀留余量）。 */
const MAX_BASENAME = 120;

/* ------------------------------------------------------------------ *
 * 纯函数（都能单测，不碰网络/全局状态）
 * ------------------------------------------------------------------ */

/**
 * 清洗一段用户数据当文件名用。
 *
 * 三件事：替换非法字符、去掉结尾的点/空格（Windows 会静默截断）、限制长度。
 * 清洗后为空或是保留设备名时退回 `fallback`——**文件名可以丑，但不能为空或建不出来**。
 */
export function sanitizeFileName(raw: string, fallback: string): string {
  // 先把换行/制表符压成一个空格，再把剩下的非法字符换成下划线。
  // 顺序反了会把「歌\n名」写成「歌_名」——技术上没错，但读起来莫名其妙。
  let out = raw.replace(/\s+/g, ' ').trim();
  out = out.replace(ILLEGAL_FILENAME_CHARS, '_');
  out = out.replace(/[. ]+$/u, '');
  if (out.length > MAX_BASENAME) out = out.slice(0, MAX_BASENAME).replace(/[. ]+$/u, '');
  if (out === '' || WINDOWS_RESERVED.test(out)) return fallback;
  return out;
}

/**
 * 目标文件名：`歌手 - 歌名.ext`。
 *
 * 没有歌手时只用歌名（纯音乐、或者上游没给歌手）；都没有时用 `song-<id>`。
 */
export function buildDownloadFileName(input: {
  name: string;
  artists: string;
  songId: number;
  ext: string;
}): string {
  const fallback = `song-${input.songId}`;
  const title = sanitizeFileName(input.name, fallback);
  const artist = sanitizeFileName(input.artists, '');
  const ext = sanitizeFileName(input.ext, 'mp3').toLowerCase();
  const stem = artist === '' ? title : `${artist} - ${title}`;
  return `${sanitizeFileName(stem, fallback)}.${ext}`;
}

/** 从 URL 里取扩展名（去掉 query/hash）；取不到或不是音频后缀时返回 undefined。 */
export function urlAudioExtension(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // 直链不一定是合法 URL（少数源给的是相对地址），退化成手工切一刀。
    pathname = url.split(/[?#]/, 1)[0] ?? url;
  }
  const dot = pathname.lastIndexOf('.');
  if (dot === -1) return undefined;
  const ext = pathname.slice(dot + 1).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext) ? ext : undefined;
}

/** 拿不到实测容器时，按请求的音质猜一个扩展名（无损档一律按 flac 猜）。 */
export function qualityExtensionHint(quality: Quality): string {
  switch (quality) {
    case 'lossless':
    case 'hires':
    case 'jymaster':
    case 'flac':
    case 'flac24bit':
      return 'flac';
    default:
      return 'mp3';
  }
}

/**
 * 落盘用的扩展名：**优先实测容器**（探针嗅探出来的才是真的），
 * 其次直链后缀，最后才按音质猜。猜的那一步永远只是兜底。
 */
export function extensionForAudio(audio: ResolvedAudio): string {
  const container = audio.probe.container;
  if (container !== 'unknown') return container;
  const fromUrl = urlAudioExtension(audio.url);
  if (fromUrl !== undefined) return fromUrl;
  return qualityExtensionHint(audio.quality);
}

/**
 * 解析 `content-range: bytes 1024-2047/4096`。
 *
 * 拿不到总长（`/*`）时不编造，`total` 留空——界面上应该显示「不确定」而不是一条假进度条。
 * 格式不对就返回 undefined，调用方退回 `content-length`。
 */
export function parseContentRange(
  header: string | null,
): { start: number; end: number; total?: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(header.trim());
  if (!match) return undefined;
  const start = Number.parseInt(match[1] ?? '', 10);
  const end = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const rawTotal = match[3];
  if (rawTotal === undefined || rawTotal === '*') return { start, end };
  const total = Number.parseInt(rawTotal, 10);
  if (!Number.isFinite(total) || total <= 0) return { start, end };
  return { start, end, total };
}

/** `content-length` 的正整数版本；拿不到/不合法就 undefined。 */
export function parseContentLength(header: string | null): number | undefined {
  if (!header) return undefined;
  const value = Number.parseInt(header, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 目标路径去重：同名不同版本的两首歌会算出同一个文件名，
 * 撞了就在扩展名前插一个 ` (歌曲 id)`，保证「一个文件属于一条记录」。
 */
export function uniqueFilePath(
  dir: string,
  fileName: string,
  taken: readonly string[],
  songId: number,
): string {
  const ext = path.extname(fileName);
  const stem = ext === '' ? fileName : fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  let attempt = 0;
  while (taken.includes(candidate) && attempt < 50) {
    attempt += 1;
    const suffix = attempt === 1 ? `${songId}` : `${songId}-${attempt}`;
    candidate = path.join(dir, `${stem} (${suffix})${ext}`);
  }
  return candidate;
}

/**
 * 从任务反推一份**最小可用**的歌曲元信息。
 *
 * 只在清单里没存住原始 `song` 时用（老文件、手工改过的文件）。
 * `id` 填 0 是刻意的：这些 id 只用于展示，第三方音源匹配**只认名字**，
 * 编一个假 id 反而会让人以为它是真的。
 */
export function songFromTask(task: DownloadTask): Song {
  const artists = task.artists
    .split('、')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return {
    id: task.songId,
    name: task.name,
    artists: artists.map((name) => ({ id: 0, name })),
    ...(task.album === ''
      ? {}
      : {
          album: {
            id: 0,
            name: task.album,
            ...(task.coverUrl ? { coverUrl: task.coverUrl } : {}),
          },
        }),
  };
}

/**
 * 挑出「能拿来离线播放」的那条下载记录。
 *
 * 只有真正下完（`done`）的记录才算数：`paused`/`error` 的文件是半个，播了只会更糟。
 * 同一首歌有多条记录时取最近更新的那条。
 */
export function findPlayableDownload(
  tasks: readonly DownloadTask[],
  songId: number,
): DownloadTask | undefined {
  return tasks
    .filter((task) => task.songId === songId && task.status === 'done' && task.filePath !== '')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/**
 * 启动对账：按**磁盘实况**修正清单状态，但绝不删记录。
 *
 * - `done` 但文件没了 → `missing`（用户手动删了 / 换机器了 / 盘挂了）；
 * - `missing` 但文件又在了 → `done`（用户把文件放回来了，或者上次是临时读不到）；
 * - `downloading` → `paused`（进程上次被杀掉了；下一层再按 `.part` 的真实大小同步字节数）。
 */
export function reconcileStatus(
  task: DownloadTask,
  fileExists: boolean,
): DownloadStatus | undefined {
  switch (task.status) {
    case 'done':
      return fileExists ? undefined : 'missing';
    case 'missing':
      return fileExists ? 'done' : undefined;
    case 'downloading':
      return 'paused';
    default:
      return undefined;
  }
}

/** 对整份清单跑一遍 `reconcileStatus`；返回新数组与「是否真有改动」。 */
export function reconcileRows<T extends { task: DownloadTask }>(
  rows: readonly T[],
  fileExists: (filePath: string) => boolean,
  now: () => number = () => Date.now(),
): { rows: T[]; changed: boolean } {
  let changed = false;
  const next = rows.map((row) => {
    const status = reconcileStatus(row.task, fileExists(row.task.filePath));
    if (status === undefined || status === row.task.status) return row;
    changed = true;
    const task: DownloadTask = { ...row.task, status, updatedAt: now() };
    // 文件不在了就没有「上次为什么失败」可谈：留着旧错误只会让人以为是新问题。
    if (status !== 'missing') delete task.error;
    return { ...row, task } as T;
  });
  return { rows: next, changed };
}

/* ------------------------------------------------------------------ *
 * 持久化形状
 * ------------------------------------------------------------------ */

/**
 * 落盘的一行 = 对外可见的任务 + 原始歌曲元信息。
 *
 * 为什么要存 `song`：重启后要继续下载/重试必须**重新解析一次直链**，
 * 而解析链需要歌手、时长这些信息，光靠拍平的 `artists` 字符串还原不出来（时长直接丢了）。
 */
export interface StoredDownloadRow {
  task: DownloadTask;
  song?: Song;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStatus(value: unknown): DownloadStatus | undefined {
  return typeof value === 'string' && (DOWNLOAD_STATUS_VALUES as readonly string[]).includes(value)
    ? (value as DownloadStatus)
    : undefined;
}

function readQuality(value: unknown): Quality | undefined {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(QUALITY_LABEL, value)
    ? (value as Quality)
    : undefined;
}

function readTask(value: unknown): DownloadTask | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const id = readNonEmptyString(row['id']);
  const songId = readFiniteNumber(row['songId']);
  const filePath = readNonEmptyString(row['filePath']);
  const status = readStatus(row['status']);
  const quality = readQuality(row['quality']);
  // 这五个字段缺任何一个，这条记录就不可能被正确地继续下载或播放——宁可丢掉并记日志。
  if (
    id === undefined ||
    songId === undefined ||
    filePath === undefined ||
    status === undefined ||
    quality === undefined
  ) {
    return undefined;
  }
  const updatedAt = readFiniteNumber(row['updatedAt']) ?? 0;
  const qualityLabel = readNonEmptyString(row['qualityLabel']);
  const coverUrl = readNonEmptyString(row['coverUrl']);
  const error = readNonEmptyString(row['error']);
  return {
    id,
    songId,
    name: readNonEmptyString(row['name']) ?? `song-${songId}`,
    artists: typeof row['artists'] === 'string' ? row['artists'] : '',
    album: typeof row['album'] === 'string' ? row['album'] : '',
    ...(coverUrl ? { coverUrl } : {}),
    quality,
    ...(qualityLabel ? { qualityLabel } : {}),
    status,
    receivedBytes: readFiniteNumber(row['receivedBytes']) ?? 0,
    totalBytes: readFiniteNumber(row['totalBytes']) ?? 0,
    filePath,
    ...(error ? { error } : {}),
    createdAt: readFiniteNumber(row['createdAt']) ?? updatedAt,
    updatedAt,
  };
}

function readSong(value: unknown, songId: number): Song | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (readFiniteNumber(raw['id']) !== songId) return undefined;
  const name = readNonEmptyString(raw['name']);
  if (name === undefined) return undefined;
  const artistsRaw = raw['artists'];
  const artists: Song['artists'] = [];
  if (Array.isArray(artistsRaw)) {
    for (const entry of artistsRaw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const artist = entry as Record<string, unknown>;
      const artistName = readNonEmptyString(artist['name']);
      if (artistName === undefined) continue;
      artists.push({ id: readFiniteNumber(artist['id']) ?? 0, name: artistName });
    }
  }
  const albumRaw = raw['album'];
  let album: Song['album'];
  if (typeof albumRaw === 'object' && albumRaw !== null) {
    const albumRow = albumRaw as Record<string, unknown>;
    const albumName = readNonEmptyString(albumRow['name']);
    if (albumName !== undefined) {
      const albumCover = readNonEmptyString(albumRow['coverUrl']);
      album = {
        id: readFiniteNumber(albumRow['id']) ?? 0,
        name: albumName,
        ...(albumCover ? { coverUrl: albumCover } : {}),
      };
    }
  }
  const durationMs = readFiniteNumber(raw['durationMs']);
  return {
    id: songId,
    name,
    artists,
    ...(album ? { album } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/**
 * 清洗盘上读到的整份清单。
 *
 * 存储层是 JSON 文件（见 ADR-0002），用户/杀软/同步盘都可能把它改坏。
 * 这里的原则是「坏行丢掉，好行保住」：宁可少一条记录，也不能让整个列表打不开。
 */
export function sanitizeStoredRows(raw: unknown): StoredDownloadRow[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const rows: StoredDownloadRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const wrapper = entry as Record<string, unknown>;
    const task = readTask(wrapper['task']);
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    const song = readSong(wrapper['song'], task.songId);
    rows.push(song ? { task, song } : { task });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * 下载管理器
 * ------------------------------------------------------------------ */

export interface DownloadsManagerOptions {
  /** 持久化驱动（`downloads.tasks` → `downloads.json`）。 */
  store: StorageDriver;
  /** 存储 key；默认 `DOWNLOAD_STORE_KEY`。 */
  storeKey?: string;
  /** 当前的下载目录（设置里的 `downloadDir`，为空时由调用方给默认值）。 */
  resolveDir: () => Promise<string>;
  /** 这次下载实际用哪个档位（设置偏好 + 账号能力夹逼）。 */
  pickQuality: (song: Song, level?: Quality) => Promise<Quality>;
  /** 解析直链；`audio: null` 表示所有音源都没拿到可下载地址。 */
  resolve: (
    song: Song,
    level: Quality,
  ) => Promise<{ audio: ResolvedAudio | null; attempts: ResolveAttempt[] }>;
  /** 解析前的准备（这里用来等内嵌 API 起来）；失败只记日志，不阻断。 */
  beforeResolve?: () => Promise<void>;
  log?: (message: string, detail?: unknown) => void;
  /** 并发数，默认 `DOWNLOAD_CONCURRENCY`。 */
  concurrency?: number;
  /** 进度推送节流，默认 `DOWNLOAD_EVENT_INTERVAL_MS`。 */
  eventIntervalMs?: number;
  /** 进度写盘节流，默认 `DOWNLOAD_PERSIST_INTERVAL_MS`。 */
  persistIntervalMs?: number;
  /** 注入 fetch，便于单测。 */
  fetchImpl?: typeof fetch;
  /** 注入时钟，便于单测节流。 */
  now?: () => number;
  /** 注入「文件在不在」，便于单测对账。默认 `fs.existsSync`。 */
  fileExists?: (filePath: string) => boolean;
}

interface DownloadRow {
  task: DownloadTask;
  song: Song;
}

/** 从任务里读出 `.part` 文件的大小；不存在/读不到都返回 undefined。 */
async function partSize(filePath: string): Promise<number | undefined> {
  try {
    const info = await stat(`${filePath}.part`);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/** 读取文件大小（用于下完后按磁盘实数校正进度）；失败返回 undefined。 */
async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

function describeNoAudio(attempts: readonly ResolveAttempt[]): string {
  if (attempts.length === 0) return '所有音源都没拿到可下载地址';
  const detail = attempts
    .map((attempt) => `${attempt.sourceId}${attempt.detail ? `(${attempt.detail})` : ''}`)
    .join('、');
  return `所有音源都没拿到可下载地址：${detail}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DownloadsManager {
  private rows: DownloadRow[] = [];
  /** 正在跑的任务：id → 用于暂停/移除的 abort 控制器。 */
  private readonly running = new Map<string, AbortController>();
  private readonly listeners = new Set<(tasks: DownloadTask[]) => void>();
  private readonly store: StorageDriver;
  private readonly storeKey: string;
  private readonly concurrency: number;
  private readonly eventIntervalMs: number;
  private readonly persistIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly fileExists: (filePath: string) => boolean;
  private readonly log: (message: string, detail?: unknown) => void;
  /** 写盘串行链：保证「后写的快照一定覆盖先写的」，不会乱序落盘。 */
  private persistChain: Promise<void> = Promise.resolve();
  private lastPersistAt = 0;
  private lastEmitAt = 0;
  private emitTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private readonly options: DownloadsManagerOptions;

  constructor(options: DownloadsManagerOptions) {
    this.options = options;
    this.store = options.store;
    this.storeKey = options.storeKey ?? DOWNLOAD_STORE_KEY;
    this.concurrency = Math.max(1, options.concurrency ?? DOWNLOAD_CONCURRENCY);
    this.eventIntervalMs = Math.max(0, options.eventIntervalMs ?? DOWNLOAD_EVENT_INTERVAL_MS);
    this.persistIntervalMs = Math.max(0, options.persistIntervalMs ?? DOWNLOAD_PERSIST_INTERVAL_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.fileExists = options.fileExists ?? ((filePath) => existsSync(filePath));
    this.log = options.log ?? ((message, detail) => console.warn(message, detail));
  }

  /* ---------------------------------------------------------------- *
   * 读
   * ---------------------------------------------------------------- */

  /** 整份清单的快照（新下载的在前）。返回的是副本，调用方改不动内部状态。 */
  list(): DownloadTask[] {
    // 先倒序、再按 createdAt 排：同一毫秒内点两下「下载」很常见，
    // 没有这个 tie-break，界面每次刷新顺序都可能变。
    return [...this.rows]
      .reverse()
      .sort((a, b) => b.task.createdAt - a.task.createdAt)
      .map((row) => ({ ...row.task }));
  }

  /** 订阅变更（用于推 `downloads:changed`）。返回退订函数。 */
  onChange(listener: (tasks: DownloadTask[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ---------------------------------------------------------------- *
   * 生命周期
   * ---------------------------------------------------------------- */

  /**
   * 读清单 → 按磁盘同步 `.part` 大小 → 对账状态 → 继续跑上次没跑完的 `queued`。
   *
   * 只自动恢复 `queued`：`paused` 是用户的明确意图（不许偷偷自动开始），
   * `error` 也是——重试要用户点。
   */
  async init(): Promise<void> {
    await this.load();
    await this.syncPartialSizes();
    const { rows, changed } = reconcileRows(this.rows, (filePath) => this.fileExists(filePath), this.now);
    this.rows = rows;
    if (changed) await this.persist(true);
    this.emit(true);
    this.pump();
  }

  /** 退出前收尾：停掉所有连接、把最后的状态落盘。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    try {
      await this.persist(true);
    } catch (error) {
      this.log('[pi/downloads] 退出前写盘失败', error);
    }
  }

  /* ---------------------------------------------------------------- *
   * 写（IPC 入口）
   * ---------------------------------------------------------------- */

  /**
   * 加入下载。
   *
   * **同一首歌只保留一条记录**：重复点「下载」不会排出第二条排队项。
   * 如果已有记录处于 `error`/`missing`，这一下就等于「重试」（顺手清掉错误）；
   * 处于 `done`/`queued`/`downloading`/`paused` 时原样返回，不改用户在队列里的意图。
   * 想换音质重下，就先 `downloads:remove` 再 `downloads:add`。
   *
   * 返回时任务已经进队列但**还没解析直链**：解析可能要几秒，不能让界面等。
   * 目标文件名先用音质猜的扩展名占位，真正开始下载时按实测容器修正。
   */
  async add(song: Song, level?: Quality): Promise<DownloadTask[]> {
    const existing = this.rows.find((row) => row.task.songId === song.id);
    if (existing) {
      if (existing.task.status === 'error' || existing.task.status === 'missing') {
        existing.task.status = 'queued';
        delete existing.task.error;
        existing.task.updatedAt = this.now();
        await this.commit();
        this.pump();
      }
      return this.list();
    }

    const quality = await this.options.pickQuality(song, level);
    const dir = path.resolve(await this.options.resolveDir());
    const artists = song.artists.map((artist) => artist.name).join('、');
    const createdAt = this.now();
    const task: DownloadTask = {
      id: randomUUID(),
      songId: song.id,
      name: song.name,
      artists,
      album: song.album?.name ?? '',
      ...(song.album?.coverUrl ? { coverUrl: song.album.coverUrl } : {}),
      quality,
      qualityLabel: QUALITY_LABEL[quality],
      status: 'queued',
      receivedBytes: 0,
      totalBytes: 0,
      filePath: '',
      createdAt,
      updatedAt: createdAt,
    };
    task.filePath = uniqueFilePath(
      dir,
      buildDownloadFileName({
        name: task.name,
        artists,
        songId: task.songId,
        ext: qualityExtensionHint(quality),
      }),
      this.takenPaths(),
      task.songId,
    );
    this.rows.push({ task, song });
    await this.commit();
    this.pump();
    return this.list();
  }

  /**
   * 暂停。
   *
   * 已经在下载的：先把状态落成 `paused` 再 abort——不然 abort 抛出的异常会把任务标成 `error`。
   * `.part` 文件**保留**：支持 Range 的上游下次能接着下。
   */
  async pause(id: string): Promise<DownloadTask[]> {
    const row = this.find(id);
    if (!row) return this.list();
    const { task } = row;
    if (task.status === 'queued' || task.status === 'downloading') {
      const wasDownloading = task.status === 'downloading';
      task.status = 'paused';
      task.updatedAt = this.now();
      if (wasDownloading) this.running.get(id)?.abort();
      await this.commit();
    }
    return this.list();
  }

  /** 继续：`paused` → `queued`，然后立刻把它交给空闲的并发位。 */
  async resume(id: string): Promise<DownloadTask[]> {
    const row = this.find(id);
    if (!row) return this.list();
    if (row.task.status === 'queued' || row.task.status === 'downloading') return this.list();
    if (row.task.status === 'done') return this.list();
    row.task.status = 'queued';
    delete row.task.error;
    row.task.updatedAt = this.now();
    await this.commit();
    this.pump();
    return this.list();
  }

  /** 重试：`error`/`missing` → `queued`。已有 `.part` 的话续传，没有就从 0 开始。 */
  async retry(id: string): Promise<DownloadTask[]> {
    const row = this.find(id);
    if (!row) return this.list();
    if (row.task.status === 'downloading' || row.task.status === 'queued') return this.list();
    // 「记录还在、文件没了」时字节数必须清零：否则界面上会挂着一条永远不动的进度。
    const wasMissing = row.task.status === 'missing';
    row.task.status = 'queued';
    delete row.task.error;
    if (wasMissing) row.task.receivedBytes = 0;
    row.task.updatedAt = this.now();
    await this.commit();
    this.pump();
    return this.list();
  }

  /**
   * 移除记录。
   *
   * `deleteFile` 为真时连磁盘上的音频（含 `.part`）一起删；默认只删记录，
   * 文件留在下载目录里——那是用户自己的文件，删不删该由用户说了算。
   */
  async remove(id: string, deleteFile = false): Promise<DownloadTask[]> {
    const index = this.rows.findIndex((row) => row.task.id === id);
    const row = this.rows[index];
    if (!row) return this.list();
    this.rows.splice(index, 1);
    const controller = this.running.get(id);
    this.running.delete(id);
    controller?.abort();
    if (deleteFile) await this.deleteFiles(row.task.filePath);
    await this.commit();
    this.pump();
    return this.list();
  }

  /* ---------------------------------------------------------------- *
   * 队列与单任务执行
   * ---------------------------------------------------------------- */

  private find(id: string): DownloadRow | undefined {
    return this.rows.find((row) => row.task.id === id);
  }

  private isStale(id: string): boolean {
    return !this.rows.some((row) => row.task.id === id);
  }

  private takenPaths(): string[] {
    return this.rows.map((row) => row.task.filePath);
  }

  /** 把空闲的并发位填满。每次都从清单头部挑，保证「先加的先下」。 */
  private pump(): void {
    if (this.disposed) return;
    let slots = this.concurrency - this.running.size;
    if (slots <= 0) return;
    for (const row of this.rows) {
      if (slots <= 0) break;
      if (row.task.status !== 'queued' || this.running.has(row.task.id)) continue;
      slots -= 1;
      void this.run(row.task.id);
    }
  }

  private async run(id: string): Promise<void> {
    const row = this.find(id);
    if (!row || this.running.has(id) || row.task.status !== 'queued') return;
    const controller = new AbortController();
    this.running.set(id, controller);
    const { task } = row;
    try {
      task.status = 'downloading';
      delete task.error;
      task.updatedAt = this.now();
      await this.commit();

      if (this.options.beforeResolve) {
        try {
          await this.options.beforeResolve();
        } catch (error) {
          this.log('[pi/downloads] 解析前的准备工作失败，继续尝试解析', error);
        }
      }

      const { audio, attempts } = await this.options.resolve(row.song, task.quality);
      if (this.isStale(id)) return;
      if (!audio) throw new Error(describeNoAudio(attempts));

      await this.download(row, audio, controller);
      if (this.isStale(id)) return;
      task.updatedAt = this.now();
      await this.commit();
    } catch (error) {
      if (this.isStale(id)) return;
      if (controller.signal.aborted || task.status === 'paused') {
        // 用户主动暂停：字节还留在 .part 里，这不是错误。
        console.info(`[pi/downloads] 已暂停：${task.name}`);
      } else {
        task.status = 'error';
        task.error = errorMessage(error);
        console.warn(`[pi/downloads] 下载失败：${task.name}`, error);
      }
      task.updatedAt = this.now();
      await this.commit();
    } finally {
      this.running.delete(id);
      this.pump();
    }
  }

  /**
   * 真正去拉字节。
   *
   * 目标路径先按实测容器修正（只在**还没有 `.part`** 时改，避免把已有进度写丢），
   * 然后带 `Range` 续传（`.part` 非空时），流式写入 + 边写边报进度。
   */
  private async download(
    row: DownloadRow,
    audio: ResolvedAudio,
    controller: AbortController,
  ): Promise<void> {
    const { task } = row;
    const dir = path.dirname(task.filePath);

    if ((await partSize(task.filePath)) === undefined) {
      const taken = this.rows
        .filter((other) => other.task.id !== task.id)
        .map((other) => other.task.filePath);
      const next = uniqueFilePath(
        dir,
        buildDownloadFileName({
          name: task.name,
          artists: task.artists,
          songId: task.songId,
          ext: extensionForAudio(audio),
        }),
        taken,
        task.songId,
      );
      if (next !== task.filePath) {
        task.filePath = next;
        task.updatedAt = this.now();
        this.emit(true);
      }
    }

    await mkdir(path.dirname(task.filePath), { recursive: true });
    const part = `${task.filePath}.part`;
    // 磁盘上的 `.part` 才是字节数的唯一真相（进程被杀过时内存里的数字不作数）。
    const start = (await partSize(task.filePath)) ?? 0;
    if (start !== task.receivedBytes) {
      task.receivedBytes = start;
      task.updatedAt = this.now();
    }

    const headers: Record<string, string> = { ...(audio.upstreamHeaders ?? {}) };
    if (start > 0) headers['range'] = `bytes=${start}-`;
    const response = await this.fetchImpl(audio.url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 206) {
      throw new Error(`上游返回 HTTP ${response.status}`);
    }
    const body = response.body;
    if (body === null) throw new Error('上游没有返回响应体');

    let resumeFrom = start;
    if (start > 0 && response.status !== 206) {
      // 如实记录：这个上游不吃 Range，暂停就等于重新下。
      this.log(
        `[pi/downloads] 上游不支持 Range（HTTP ${response.status}），${task.name} 本次改为重新下载`,
      );
      resumeFrom = 0;
    }

    const declared = parseContentRange(response.headers.get('content-range'));
    const contentLength = parseContentLength(response.headers.get('content-length'));
    const total =
      declared?.total ?? (resumeFrom > 0 && contentLength !== undefined
        ? resumeFrom + contentLength
        : contentLength);
    task.totalBytes = total ?? 0;
    task.receivedBytes = resumeFrom;
    task.updatedAt = this.now();
    this.emit(true);

    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        task.receivedBytes += chunk.length;
        task.updatedAt = this.now();
        this.emit(false);
        void this.persist(false);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(body as unknown as WebReadableStream),
      counter,
      createWriteStream(part, { flags: resumeFrom > 0 ? 'a' : 'w' }),
      { signal: controller.signal },
    );

    if (this.isStale(task.id)) return;
    await rename(part, task.filePath);
    const size = (await fileSize(task.filePath)) ?? task.receivedBytes;
    task.status = 'done';
    delete task.error;
    // 进度按**磁盘实数**收尾：不猜、不四舍五入，也不把 totalBytes 报得比文件还小。
    task.receivedBytes = size;
    task.totalBytes = size > 0 ? size : task.totalBytes;
  }

  private async deleteFiles(filePath: string): Promise<void> {
    for (const target of [filePath, `${filePath}.part`]) {
      try {
        await rm(target, { force: true });
      } catch (error) {
        this.log(`[pi/downloads] 删除文件失败：${target}`, error);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 持久化与事件
   * ---------------------------------------------------------------- */

  private async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.store.get<unknown>(this.storeKey);
    } catch (error) {
      this.log('[pi/downloads] 下载清单读取失败，本次从空开始', error);
      raw = undefined;
    }
    this.rows = sanitizeStoredRows(raw).map((row) => ({
      task: row.task,
      song: row.song ?? songFromTask(row.task),
    }));
  }

  /** 把磁盘上 `.part` 的真实大小同步回内存（进程被杀过时内存里的进度是不可信的）。 */
  private async syncPartialSizes(): Promise<void> {
    for (const row of this.rows) {
      const { task } = row;
      if (task.status === 'done') continue;
      const size = await partSize(task.filePath);
      const next = size ?? 0;
      if (next !== task.receivedBytes) {
        task.receivedBytes = next;
        task.updatedAt = this.now();
      }
    }
  }

  /** 状态跃迁：立即推送 + 立即写盘，调用方可以 await 它「已经落盘」。 */
  private async commit(): Promise<void> {
    this.emit(true);
    await this.persist(true);
  }

  private snapshot(): StoredDownloadRow[] {
    return this.rows.map((row) => ({
      task: { ...row.task },
      song: { ...row.song },
    }));
  }

  /**
   * 节流写盘。返回的 Promise 表示「这一轮写盘结束」，调用方一般不必等
   * （进度路径上等它反而会拖慢下载）。
   */
  private persist(force: boolean): Promise<void> {
    const at = this.now();
    if (!force && at - this.lastPersistAt < this.persistIntervalMs) return this.persistChain;
    this.lastPersistAt = at;
    const snapshot = this.snapshot();
    this.persistChain = this.persistChain
      .then(() => this.store.set(this.storeKey, snapshot))
      .catch((error: unknown) => {
        this.log('[pi/downloads] 下载清单写盘失败', error);
      });
    return this.persistChain;
  }

  /** 节流推送。`force` 用于状态跃迁（必须让界面立刻看到）。 */
  private emit(force: boolean): void {
    const at = this.now();
    if (force) {
      this.clearEmitTimer();
      this.flushEmit(at);
      return;
    }
    const elapsed = at - this.lastEmitAt;
    if (elapsed >= this.eventIntervalMs) {
      this.flushEmit(at);
      return;
    }
    if (this.emitTimer) return;
    const delay = Math.max(1, this.eventIntervalMs - elapsed);
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.flushEmit(this.now());
    }, delay);
    this.emitTimer.unref?.();
  }

  private clearEmitTimer(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
  }

  private flushEmit(at: number): void {
    this.lastEmitAt = at;
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.log('[pi/downloads] 下载事件监听器抛错', error);
      }
    }
  }
}
