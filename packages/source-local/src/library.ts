/**
 * 本地音乐库（M2.5 H6 的 L4 层）。
 *
 * 定位：责任链的**最后一层**。前面所有源（官方、UNM、LX 插件）都拿不到时，
 * 才去看看用户自己的音乐文件夹里有没有同一首歌——这既是最稳的兜底
 * （本地文件不会失效、不用会员、不虚标），也是对用户已有文件的尊重。
 *
 * 两条设计原则：
 * 1. **认歌不认路径**：只靠「歌名 + 歌手 +（可选）时长」匹配，所以文件名解析必须宽容，
 *    因为用户的命名千奇百怪（`01. 周杰伦 - 晴天.flac`、`晴天.mp3`、`艺术家-标题.m4a`…）。
 * 2. **宁可漏，不可错**：本地层匹配错了等于放错歌，而且用户很难看出问题来源。
 *    所以规则是硬条件（歌名必须对上、时长必须对得上），不是加权算分凑阈值。
 */

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MatchInput } from '@pi/source-core';

/** 我们认得的音频后缀（小写、不含点）。 */
export const AUDIO_EXTENSIONS: readonly string[] = [
  'flac',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'wav',
  'ape',
  'wma',
];

export interface LocalTrack {
  /** 稳定 id（绝对路径的 sha1 前 12 位）——同一首歌移动位置后会变，这没关系。 */
  id: string;
  path: string;
  title: string;
  artists: string[];
  albumName?: string;
  durationMs?: number;
  /** 不含点的小写后缀，例如 `flac`。 */
  ext: string;
  sizeBytes?: number;
}

export function isAudioFile(fileName: string): boolean {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext);
}

export function extensionOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

/**
 * 从文件名猜「歌名 / 歌手」。
 *
 * 支持的常见形态（`-` 也接受 `－`、`—`、`–` 这些全角/长破折号）：
 * - `周杰伦 - 晴天.flac` → artists `['周杰伦']`，title `晴天`
 * - `01. 周杰伦 - 晴天.mp3` → 去掉音轨号后同上
 * - `01 - 晴天.mp3` → 数字当音轨号，title `晴天`
 * - `晴天.mp3` → artists `[]`，title `晴天`
 *
 * **故意不猜**「同名不同版本」这类信息：版本差异（现场版/翻唱）如果文件名里没写，
 * 我们就没有办法区分，只能靠时长兜底。猜错版本比不匹配更糟。
 */
export function parseTrackFileName(fileName: string): { title: string; artists: string[] } {
  const base = path.basename(fileName, path.extname(fileName)).trim();
  // 去音轨号：`01. `、`1 - `、`003_` 之类。只有当前缀是纯数字时才动它。
  const withoutIndex = base.replace(/^\s*\d{1,3}\s*[.\-_、]\s*/, '');
  const compact = withoutIndex.trim() === '' ? base : withoutIndex.trim();

  const parts = compact.split(/\s*[-–—－]\s*/).filter((part) => part !== '');
  if (parts.length >= 2) {
    const artists = parts
      .slice(0, -1)
      .join(' - ')
      .split(/[、,，&/]/)
      .map((name) => name.trim())
      .filter((name) => name !== '');
    const title = parts[parts.length - 1]?.trim() ?? '';
    if (title !== '') return { title, artists };
  }

  // 纯数字前缀且在分隔符之后没别的内容（例如 `01.mp3`）：当作无标题信息。
  return { title: compact, artists: [] };
}

/**
 * 归一化：用于「这两首歌是不是同一首」的判断。
 *
 * 去掉大小写差异、空白、常见标点、`feat.`/`ft.` 后面的合作歌手、以及括号里的
 * 版本说明——但**保留括号里的「live/伴奏」这类字样**会更好吗？不会：
 * 版本说明放在括号里时我们无法判断它是「标签」还是「真正的歌名差异」，
 * 所以统一剥掉；版本区分交给时长。
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    // `\b` 只认 ASCII 单词字符，所以「`晴天feat阿信`」这种不加空格的写法也会被截断
    // （中文旁边天然构成边界）。代价：标题里嵌了独立的 `feat`/`ft`/`with` 也会被截——
    // 那只造成漏匹配，方向是安全的；详见本函数的注释。
    .replace(/\b(feat|ft|with)\b.*$/i, '')
    .replace(/[\s\-_·・.,，。!！?？'"“”‘’、:：;；/\\|]+/g, '')
    .trim();
}

export interface LocalMatchResult {
  track: LocalTrack;
  /** 用于日志与 attempt 详情的人话解释。 */
  reason: string;
}

/**
 * 判断一个本地文件是不是这首歌。
 *
 * 硬条件（全部要满足）：
 * 1. 歌名归一化后相等，或一方包含另一方；
 * 2. 双方都有歌手信息时，至少要有一位歌手归一化后相等或互相包含；
 * 3. 双方都有时长时，差距不超过 3 秒（或时长的 5%，取较大的那个）。
 *
 * 不满足就返回 undefined——**没有「凑合匹配」这一档**。
 */
export function matchLocalTrack(
  input: Pick<MatchInput, 'title' | 'artists' | 'durationMs'>,
  track: LocalTrack,
): LocalMatchResult | undefined {
  const wantedTitle = normalizeForMatch(input.title);
  const candidateTitle = normalizeForMatch(track.title);
  if (wantedTitle === '' || candidateTitle === '') return undefined;

  const titleOk =
    wantedTitle === candidateTitle ||
    wantedTitle.includes(candidateTitle) ||
    candidateTitle.includes(wantedTitle);
  if (!titleOk) return undefined;

  const wantedArtists = input.artists.map(normalizeForMatch).filter((name) => name !== '');
  const candidateArtists = track.artists.map(normalizeForMatch).filter((name) => name !== '');
  let artistNote = '文件名没有歌手信息';
  if (wantedArtists.length > 0 && candidateArtists.length > 0) {
    const hit = candidateArtists.some((candidate) =>
      wantedArtists.some((wanted) => wanted === candidate || wanted.includes(candidate) || candidate.includes(wanted)),
    );
    if (!hit) return undefined;
    artistNote = '歌手对得上';
  }

  const wantedDuration = input.durationMs ?? 0;
  let durationNote = '时长未知';
  if (wantedDuration > 0 && track.durationMs !== undefined && track.durationMs > 0) {
    const tolerance = Math.max(3_000, track.durationMs * 0.05);
    const delta = Math.abs(track.durationMs - wantedDuration);
    if (delta > tolerance) return undefined;
    durationNote = `时长差 ${(delta / 1000).toFixed(1)}s`;
  }

  return { track, reason: `${artistNote} · ${durationNote}` };
}

/**
 * 本地音乐库。**纯内存**：扫描是外面的事（`scanAudioDirectory`），
 * 这样匹配逻辑可以在单测里完全离线跑。
 */
export class LocalLibrary {
  private readonly tracks: readonly LocalTrack[];

  constructor(tracks: readonly LocalTrack[] = []) {
    this.tracks = [...tracks];
  }

  get size(): number {
    return this.tracks.length;
  }

  list(): readonly LocalTrack[] {
    return this.tracks;
  }

  /** 找出唯一的候选；多个候选时取时长最接近的那个（时长都不知道就取第一个）。 */
  find(input: Pick<MatchInput, 'title' | 'artists' | 'durationMs'>): LocalMatchResult | undefined {
    let best: LocalMatchResult | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const track of this.tracks) {
      const matched = matchLocalTrack(input, track);
      if (!matched) continue;
      const wanted = input.durationMs ?? 0;
      const delta =
        wanted > 0 && track.durationMs !== undefined ? Math.abs(track.durationMs - wanted) : 0;
      if (delta < bestDelta) {
        best = matched;
        bestDelta = delta;
      }
    }
    return best;
  }
}

export interface ScanOptions {
  /** 递归子目录？默认 true——用户的音乐文件夹几乎一定有按专辑分的子目录。 */
  recursive?: boolean;
  /** 上限，防止指向 `C:\` 时扫出十万个文件。 */
  limit?: number;
  /** 非致命问题（某个子目录读不了等）通过它上报，不影响整体结果。 */
  onWarn?(message: string, detail?: unknown): void;
}

/**
 * 扫描一个文件夹，建成曲库。
 *
 * 只读目录名与文件名，**不解析音频标签**（那需要额外依赖；M2.5 的 L4 只需要能对上歌名）。
 * 目录不存在或读不了时返回空库并 warn——用户填错路径不该让音源体系起不来。
 */
export async function scanAudioDirectory(
  dir: string,
  options: ScanOptions = {},
): Promise<LocalTrack[]> {
  const recursive = options.recursive ?? true;
  const limit = options.limit ?? 2_000;
  const tracks: LocalTrack[] = [];

  async function walk(current: string): Promise<void> {
    if (tracks.length >= limit) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      options.onWarn?.(`读不了目录 ${current}`, error);
      return;
    }
    for (const entry of entries) {
      if (tracks.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(full);
        continue;
      }
      if (!entry.isFile() || !isAudioFile(entry.name)) continue;
      const parsed = parseTrackFileName(entry.name);
      const ext = extensionOf(entry.name);
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await stat(full)).size;
      } catch {
        // 拿不到大小不影响匹配（本地探针会再读一遍头部）。
      }
      tracks.push({
        id: createHash('sha1').update(full, 'utf8').digest('hex').slice(0, 12),
        path: full,
        title: parsed.title,
        artists: parsed.artists,
        ext,
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      });
    }
  }

  await walk(dir);
  return tracks;
}
