/**
 * `apps/desktop/src/main/downloads.ts` 行为锁（M5 下载与本地库，见 docs/PLAN.md 的 M5 行）。
 *
 * 下载是**唯一会写用户磁盘、且跨进程重启还要接着干**的功能，所以这里钉三类承诺：
 *
 * 1. **纯函数**（文件名清洗、扩展名推导、Content-Range 解析、清单清洗、对账）：
 *    全离线、可穷举边界。文件名要能落到 Windows 上真的建得出来；清单坏了要能读得下去。
 * 2. **状态机**：queued/downloading/paused/done/error/missing 的跃迁必须和磁盘实况一致。
 *    尤其是「暂停」——它只能来自用户意图，不能被 abort 的异常顺手写成 error。
 * 3. **断点续传 / 如实降级**：上游回 206 就接着下；回 200 就从头下，并且**日志里说清楚**
 *    「本次改为重新下载」。绝不把「从头再来」伪装成「续传成功」。
 *
 * 全程不联网、不起进程：上游用一个本地 `fetch` 替身，目标目录建在 `os.tmpdir()` 下（afterAll 删掉）。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadTask } from '@pi/ipc';
import type { Quality, ResolveAttempt, ResolvedAudio, Song } from '@pi/shared';
import type { StorageDriver } from '@pi/store';
import {
  DOWNLOAD_STORE_KEY,
  DownloadsManager,
  buildDownloadFileName,
  extensionForAudio,
  findPlayableDownload,
  parseContentLength,
  parseContentRange,
  qualityExtensionHint,
  reconcileRows,
  reconcileStatus,
  sanitizeFileName,
  sanitizeStoredRows,
  songFromTask,
  type StoredDownloadRow,
  uniqueFilePath,
  urlAudioExtension,
} from './downloads.js';

/* ------------------------------------------------------------------ *
 * 脚手架
 * ------------------------------------------------------------------ */

/** 内存版 StorageDriver：够用、可断言、不碰磁盘（真正的 JSON 驱动另有自己的测试）。 */
class FakeStore implements StorageDriver {
  readonly kind = 'fake';
  readonly data = new Map<string, unknown>();
  readonly writes: string[] = [];

  constructor(initial?: Record<string, unknown>) {
    for (const [key, value] of Object.entries(initial ?? {})) this.data.set(key, value);
  }

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.get(key) as T | undefined);
  }

  set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
    this.writes.push(key);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.data.delete(key));
  }

  has(key: string): Promise<boolean> {
    return Promise.resolve(this.data.has(key));
  }

  list<T>(domain: string): Promise<T[]> {
    const prefix = `${domain}.`;
    return Promise.resolve(
      [...this.data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value as T),
    );
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const fakeLog = (): { lines: string[]; log: (message: string, detail?: unknown) => void } => {
  const lines: string[] = [];
  return {
    lines,
    log: (message: string) => {
      lines.push(message);
    },
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件成立；超时抛错（比固定 sleep 稳，也比 `expect.poll` 好读）。 */
async function waitFor(predicate: () => boolean, label = '条件', timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`等待超时：${label}`);
}

function makeSong(id: number, name = `歌 ${id}`, artists = ['歌手甲']): Song {
  return {
    id,
    name,
    artists: artists.map((artist, index) => ({ id: index + 1, name: artist })),
    album: { id: 9, name: '专辑名', coverUrl: 'https://example.com/cover.jpg' },
    durationMs: 200_000,
  };
}

function audioFor(quality: Quality, container: 'mp3' | 'flac' = 'mp3'): ResolvedAudio {
  return {
    url: `https://cdn.example.com/audio/${quality}.${container}`,
    quality,
    probe: { container, evidence: 'test' },
    via: 'test-source',
    upstreamHeaders: { referer: 'https://example.com/' },
  };
}

/** 默认的解析器替身：给一个 mp3 直链。 */
const resolveOk = (quality: Quality = 'exhigh') => () =>
  Promise.resolve({ audio: audioFor(quality), attempts: [] });

const resolveNone = () => Promise.resolve({ audio: null, attempts: [] });

function makeBytes(size: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (seed + i) % 251;
  return bytes;
}

/** 一个支持 Range 的上游：带 `range: bytes=N-` 就回 206 + 正确切片。 */
function rangeAwareFetch(bytes: Uint8Array, calls: { range?: string }[]) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    void url;
    const headers = init?.headers as Record<string, string> | undefined;
    const range = headers?.['range'];
    calls.push(range === undefined ? {} : { range });
    if (range === undefined) {
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        }),
      );
    }
    const start = Number.parseInt(/bytes=(\d+)-/.exec(range)?.[1] ?? '0', 10);
    const slice = bytes.slice(start);
    return Promise.resolve(
      new Response(slice, {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
          'content-length': String(slice.length),
        },
      }),
    );
  };
}

/** 一个不支持 Range 的上游：无论要什么都回 200 + 全量。 */
function stubbornFetch(bytes: Uint8Array) {
  return (): Promise<Response> =>
    Promise.resolve(
      new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }),
    );
}

/** 慢速流：把 bytes 拆成若干块、每隔 delayMs 推一块，并支持被取消（暂停用）。 */
function slowFetch(bytes: Uint8Array, chunkSize: number, delayMs: number) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    void url;
    const headers = init?.headers as Record<string, string> | undefined;
    const range = headers?.['range'];
    const start = range === undefined ? 0 : Number.parseInt(/bytes=(\d+)-/.exec(range)?.[1] ?? '0', 10);
    const sliced = bytes.slice(start);
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let offset = 0;
        const push = (): void => {
          if (cancelled) return;
          if (offset >= sliced.length) {
            controller.close();
            return;
          }
          try {
            controller.enqueue(sliced.slice(offset, offset + chunkSize));
          } catch {
            return;
          }
          offset += chunkSize;
          timer = setTimeout(push, delayMs);
        };
        push();
      },
      cancel() {
        cancelled = true;
        if (timer) clearTimeout(timer);
      },
    });
    const status = range === undefined ? 200 : 206;
    const responseHeaders: Record<string, string> = {
      'content-length': String(sliced.length),
    };
    if (status === 206) {
      responseHeaders['content-range'] =
        `bytes ${start}-${bytes.length - 1}/${bytes.length}`;
    }
    return Promise.resolve(new Response(stream, { status, headers: responseHeaders }));
  };
}

interface Harness {
  manager: DownloadsManager;
  store: FakeStore;
  dir: string;
  logs: string[];
  events: DownloadTask[][];
}

interface ManagerOptions {
  dir: string;
  store?: FakeStore;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  resolve?: (song: Song, level: Quality) => Promise<{
    audio: ResolvedAudio | null;
    attempts: ResolveAttempt[];
  }>;
  quality?: Quality;
  concurrency?: number;
  eventIntervalMs?: number;
  persistIntervalMs?: number;
  fileExists?: (filePath: string) => boolean;
  init?: boolean;
}

async function makeManager(options: ManagerOptions): Promise<Harness> {
  const store = options.store ?? new FakeStore();
  const sink = fakeLog();
  const events: DownloadTask[][] = [];
  const manager = new DownloadsManager({
    store,
    storeKey: DOWNLOAD_STORE_KEY,
    resolveDir: () => Promise.resolve(options.dir),
    pickQuality: () => Promise.resolve(options.quality ?? 'exhigh'),
    resolve: options.resolve ?? (() => resolveOk(options.quality ?? 'exhigh')()),
    log: sink.log,
    fetchImpl: (options.fetchImpl ?? rangeAwareFetch(new Uint8Array(0), [])) as typeof fetch,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.eventIntervalMs !== undefined ? { eventIntervalMs: options.eventIntervalMs } : {}),
    ...(options.persistIntervalMs !== undefined
      ? { persistIntervalMs: options.persistIntervalMs }
      : {}),
    ...(options.fileExists !== undefined ? { fileExists: options.fileExists } : {}),
  });
  manager.onChange((tasks) => {
    events.push(tasks);
  });
  if (options.init !== false) await manager.init();
  return { manager, store, dir: options.dir, logs: sink.lines, events };
}

function makeStoredTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = 1_000;
  return {
    id: 'task-1',
    songId: 1,
    name: '歌 1',
    artists: '歌手甲',
    album: '专辑名',
    quality: 'exhigh',
    qualityLabel: '极高',
    status: 'done',
    receivedBytes: 10,
    totalBytes: 10,
    filePath: path.join(os.tmpdir(), 'pi-downloads-missing', 'a.mp3'),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let tempRoot = '';

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-downloads-'));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 1. 纯函数：文件名
 * ------------------------------------------------------------------ */

describe('文件名清洗与拼装', () => {
  it('替换非法字符、压掉控制字符，并去掉结尾的点与空格', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j', 'fallback')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('晴天. ', 'fallback')).toBe('晴天');
    expect(sanitizeFileName('  a   b  ', 'fallback')).toBe('a b');
    expect(sanitizeFileName('a\nb\tc', 'fallback')).toBe('a b c');
  });

  it('空串与 Windows 保留名退回 fallback（留空会写出个没有名字的文件）', () => {
    expect(sanitizeFileName('', 'song-7')).toBe('song-7');
    expect(sanitizeFileName('   ', 'song-7')).toBe('song-7');
    expect(sanitizeFileName('...', 'song-7')).toBe('song-7');
    expect(sanitizeFileName('con', 'song-7')).toBe('song-7');
    expect(sanitizeFileName('COM1', 'song-7')).toBe('song-7');
    // 只是以保留名开头不算：`conan.mp3` 是合法文件名。
    expect(sanitizeFileName('conan', 'song-7')).toBe('conan');
  });

  it('过长的主干会被截断', () => {
    const name = 'x'.repeat(500);
    expect(sanitizeFileName(name, 'fallback').length).toBeLessThanOrEqual(120);
  });

  it('拼成「歌手 - 歌名.ext」，没有歌手时只用歌名', () => {
    expect(buildDownloadFileName({ name: '晴天', artists: '周杰伦', songId: 1, ext: 'mp3' })).toBe(
      '周杰伦 - 晴天.mp3',
    );
    expect(buildDownloadFileName({ name: '晴天', artists: '', songId: 1, ext: 'flac' })).toBe(
      '晴天.flac',
    );
    expect(
      buildDownloadFileName({ name: '晴天', artists: '周杰伦/费玉清', songId: 1, ext: 'MP3' }),
    ).toBe('周杰伦_费玉清 - 晴天.mp3');
  });
});

describe('扩展名推导', () => {
  it('从 URL 认扩展名，忽略 query 与 hash；不认识的返回 undefined', () => {
    expect(urlAudioExtension('https://cdn/a/b.flac?token=1')).toBe('flac');
    expect(urlAudioExtension('https://cdn/a/b.m4a#x')).toBe('m4a');
    expect(urlAudioExtension('https://cdn/a/b.mp3')).toBe('mp3');
    expect(urlAudioExtension('https://cdn/a/b.exe')).toBeUndefined();
    expect(urlAudioExtension('https://cdn/a/b')).toBeUndefined();
    expect(urlAudioExtension('mystream?a=1')).toBeUndefined();
  });

  it('音质兜底：无损系按 flac 猜，其余按 mp3 猜', () => {
    expect(qualityExtensionHint('lossless')).toBe('flac');
    expect(qualityExtensionHint('hires')).toBe('flac');
    expect(qualityExtensionHint('jymaster')).toBe('flac');
    expect(qualityExtensionHint('flac24bit')).toBe('flac');
    expect(qualityExtensionHint('standard')).toBe('mp3');
    expect(qualityExtensionHint('exhigh')).toBe('mp3');
  });

  it('实测容器 > URL 后缀 > 音质猜测（顺序不能反：猜出来的名字会骗人）', () => {
    expect(extensionForAudio(audioFor('lossless', 'flac'))).toBe('flac');
    expect(
      extensionForAudio({
        ...audioFor('exhigh', 'mp3'),
        probe: { container: 'unknown', evidence: 'pending' },
      }),
    ).toBe('mp3');
    expect(
      extensionForAudio({
        ...audioFor('lossless'),
        url: 'https://cdn/stream?id=1',
        probe: { container: 'unknown', evidence: 'pending' },
      }),
    ).toBe('flac');
    expect(
      extensionForAudio({
        ...audioFor('exhigh'),
        url: 'https://cdn/x.m4a',
        probe: { container: 'unknown', evidence: 'pending' },
      }),
    ).toBe('m4a');
  });
});

describe('Content-Range / Content-Length 解析', () => {
  it('解析 206 的 content-range，含总量', () => {
    expect(parseContentRange('bytes 0-1023/2048')).toEqual({ start: 0, end: 1023, total: 2048 });
    expect(parseContentRange('bytes 1024-2047/2048')).toEqual({
      start: 1024,
      end: 2047,
      total: 2048,
    });
  });

  it('总量是 `*` 时不编造 total（界面宁可显示「不确定」）', () => {
    expect(parseContentRange('bytes 0-99/*')).toEqual({ start: 0, end: 99 });
  });

  it('格式不对 / 区间倒挂 / 空值一律 undefined', () => {
    expect(parseContentRange(null)).toBeUndefined();
    expect(parseContentRange('items 0-1/2')).toBeUndefined();
    expect(parseContentRange('bytes 10-1/20')).toBeUndefined();
    expect(parseContentRange('bytes 0-1/0')).toEqual({ start: 0, end: 1 });
  });

  it('content-length 只认正整数', () => {
    expect(parseContentLength('2048')).toBe(2048);
    expect(parseContentLength('0')).toBeUndefined();
    expect(parseContentLength('-5')).toBeUndefined();
    expect(parseContentLength('abc')).toBeUndefined();
    expect(parseContentLength(null)).toBeUndefined();
  });
});

describe('目标路径去重', () => {
  it('不冲突时原样使用', () => {
    expect(uniqueFilePath('C:\\dl', 'a.mp3', [], 7)).toBe(path.join('C:\\dl', 'a.mp3'));
  });

  it('撞名时插歌曲 id，再撞就继续加序号（保证一文件一记录）', () => {
    const dir = 'C:\\dl';
    const first = path.join(dir, 'a.mp3');
    const second = uniqueFilePath(dir, 'a.mp3', [first], 7);
    expect(second).toBe(path.join(dir, 'a (7).mp3'));
    const third = uniqueFilePath(dir, 'a.mp3', [first, second], 7);
    expect(third).toBe(path.join(dir, 'a (7-2).mp3'));
  });
});

/* ------------------------------------------------------------------ *
 * 2. 纯函数：清单与对账
 * ------------------------------------------------------------------ */

describe('已下载记录的挑选', () => {
  it('只认 done 且有路径的，多条时取最近更新的', () => {
    const old = makeStoredTask({ id: 'a', updatedAt: 1 });
    const fresh = makeStoredTask({ id: 'b', updatedAt: 9 });
    const paused = makeStoredTask({ id: 'c', status: 'paused', updatedAt: 99 });
    const empty = makeStoredTask({ id: 'd', filePath: '', updatedAt: 100 });
    expect(findPlayableDownload([old, fresh, paused, empty], 1)?.id).toBe('b');
    expect(findPlayableDownload([paused], 1)).toBeUndefined();
    expect(findPlayableDownload([old], 2)).toBeUndefined();
  });

  it('从任务反推歌词页要用的歌曲信息，歌手按「、」拆开', () => {
    const song = songFromTask(
      makeStoredTask({ songId: 42, name: '晴天', artists: '周杰伦、费玉清', album: '叶惠美' }),
    );
    expect(song.id).toBe(42);
    expect(song.name).toBe('晴天');
    expect(song.artists.map((artist) => artist.name)).toEqual(['周杰伦', '费玉清']);
    expect(song.album?.name).toBe('叶惠美');
    expect(song.album?.coverUrl).toBeUndefined();
  });

  it('没有专辑/歌手时不硬造空对象', () => {
    const song = songFromTask(makeStoredTask({ artists: '', album: '' }));
    expect(song.artists).toEqual([]);
    expect(song.album).toBeUndefined();
  });
});

describe('启动对账（按磁盘实况修正状态，绝不删记录）', () => {
  it('done 但文件没了 → missing；missing 但文件回来了 → done', () => {
    expect(reconcileStatus(makeStoredTask(), true)).toBeUndefined();
    expect(reconcileStatus(makeStoredTask(), false)).toBe('missing');
    expect(reconcileStatus(makeStoredTask({ status: 'missing' }), true)).toBe('done');
    expect(reconcileStatus(makeStoredTask({ status: 'missing' }), false)).toBeUndefined();
  });

  it('上次被杀掉的 downloading 一律降为 paused（它没有人在跑）', () => {
    expect(reconcileStatus(makeStoredTask({ status: 'downloading' }), true)).toBe('paused');
  });

  it('queued/error 不受文件系统影响', () => {
    expect(reconcileStatus(makeStoredTask({ status: 'queued' }), false)).toBeUndefined();
    expect(reconcileStatus(makeStoredTask({ status: 'error' }), false)).toBeUndefined();
  });

  it('整份清单对账后给出 changed 标记，行数一条不少', () => {
    const rows: StoredDownloadRow[] = [
      { task: makeStoredTask({ id: 'a', filePath: path.join(tempRoot, 'r-a.mp3') }) },
      {
        task: makeStoredTask({
          id: 'b',
          status: 'missing',
          filePath: path.join(tempRoot, 'r-b.mp3'),
        }),
      },
      {
        task: makeStoredTask({
          id: 'c',
          status: 'downloading',
          filePath: path.join(tempRoot, 'r-c.mp3'),
        }),
      },
    ];
    const result = reconcileRows(rows, (filePath) => filePath.endsWith('r-a.mp3'), () => 5);
    expect(result.changed).toBe(true);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((row) => row.task.status)).toEqual(['done', 'missing', 'paused']);
  });

  it('没有变化时 changed=false（避免没必要的写盘与事件）', () => {
    const rows: StoredDownloadRow[] = [{ task: makeStoredTask({ status: 'queued' }) }];
    expect(reconcileRows(rows, () => false).changed).toBe(false);
  });
});

describe('清单清洗（盘上的 JSON 可能是坏的）', () => {
  it('非数组 / 垃圾项 / 缺关键字段的行直接丢掉', () => {
    expect(sanitizeStoredRows(undefined)).toEqual([]);
    expect(sanitizeStoredRows('nope')).toEqual([]);
    expect(sanitizeStoredRows([null, 1, 'x', {}])).toEqual([]);
    expect(sanitizeStoredRows([{ task: { id: 'a' } }])).toEqual([]);
  });

  it('保住完整行（含原始 song），并按 id 去重', () => {
    const song = makeSong(1);
    const rows = sanitizeStoredRows([
      { task: makeStoredTask({ id: 'a' }), song },
      { task: makeStoredTask({ id: 'a' }), song },
      { task: makeStoredTask({ id: 'b' }) },
    ]);
    expect(rows.map((row) => row.task.id)).toEqual(['a', 'b']);
    expect(rows[0]?.song?.name).toBe('歌 1');
    expect(rows[1]?.song).toBeUndefined();
  });

  it('song 与任务的 songId 对不上就丢弃 song，但保住任务', () => {
    const rows = sanitizeStoredRows([{ task: makeStoredTask({ id: 'a', songId: 5 }), song: makeSong(1) }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.song).toBeUndefined();
  });

  it('字段类型不对（字节数不是数字）按 0 兜底，不整行丢掉', () => {
    const rows = sanitizeStoredRows([
      { task: { ...makeStoredTask({ id: 'a' }), receivedBytes: 'x', totalBytes: null } },
    ]);
    expect(rows[0]?.task.receivedBytes).toBe(0);
    expect(rows[0]?.task.totalBytes).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 管理器：真下载到临时目录
 * ------------------------------------------------------------------ */

describe('下载管理器：新增与完成', () => {
  it('add 进队列即返回，下完后磁盘上是完整文件、状态与字节数都对', async () => {
    const dir = path.join(tempRoot, 'ok');
    const bytes = makeBytes(4096, 3);
    const calls: { range?: string }[] = [];
    const h = await makeManager({ dir, fetchImpl: rangeAwareFetch(bytes, calls) });

    const afterAdd = await h.manager.add(makeSong(1));
    expect(afterAdd).toHaveLength(1);
    expect(afterAdd[0]?.status === 'queued' || afterAdd[0]?.status === 'downloading').toBe(true);
    expect(afterAdd[0]?.quality).toBe('exhigh');
    expect(afterAdd[0]?.qualityLabel).toBe('极高');
    expect(afterAdd[0]?.filePath.endsWith('歌手甲 - 歌 1.mp3')).toBe(true);
    expect(afterAdd[0]?.filePath.startsWith(dir)).toBe(true);

    await waitFor(() => h.manager.list()[0]?.status === 'done', '下载完成');
    const task = h.manager.list()[0];
    expect(task?.receivedBytes).toBe(4096);
    expect(task?.totalBytes).toBe(4096);
    expect(task?.error).toBeUndefined();
    expect(await readFile(task?.filePath ?? '', null)).toEqual(Buffer.from(bytes));
    expect(calls[0]?.range).toBeUndefined();
    expect(existsSync(`${task?.filePath}.part`)).toBe(false);
    await h.manager.dispose();
  });

  it('实测容器优先决定扩展名：请求 mp3、实测 flac，就落成 .flac', async () => {
    const dir = path.join(tempRoot, 'container');
    const bytes = makeBytes(512, 1);
    const h = await makeManager({
      dir,
      fetchImpl: stubbornFetch(bytes),
      resolve: () => Promise.resolve({ audio: audioFor('lossless', 'flac'), attempts: [] }),
      quality: 'lossless',
    });
    await h.manager.add(makeSong(2));
    await waitFor(() => h.manager.list()[0]?.status === 'done', '下载完成');
    expect(h.manager.list()[0]?.filePath.endsWith('.flac')).toBe(true);
    await h.manager.dispose();
  });

  it('同一首歌重复 add 不会排第二条', async () => {
    const dir = path.join(tempRoot, 'dedupe');
    const h = await makeManager({ dir, resolve: resolveNone });
    await h.manager.add(makeSong(3));
    await waitFor(() => h.manager.list()[0]?.status === 'error', '解析失败成为 error');
    const again = await h.manager.add(makeSong(3));
    expect(again).toHaveLength(1);
    expect(again[0]?.songId).toBe(3);
    await h.manager.dispose();
  });

  it('error 状态下再 add 一次等于重试：这次解析成功就变成 done', async () => {
    const dir = path.join(tempRoot, 'retry-by-add');
    const bytes = makeBytes(256, 21);
    let firstAttempt = true;
    const h = await makeManager({
      dir,
      resolve: () => {
        if (firstAttempt) return Promise.resolve({ audio: null, attempts: [] });
        return Promise.resolve({ audio: audioFor('exhigh'), attempts: [] });
      },
      fetchImpl: stubbornFetch(bytes),
    });
    const [task] = await h.manager.add(makeSong(3));
    await waitFor(() => h.manager.list()[0]?.status === 'error', '第一次解析失败');
    firstAttempt = false;
    await h.manager.add(makeSong(3));
    await waitFor(() => h.manager.list()[0]?.status === 'done', '再 add 之后下载完成');
    expect(h.manager.list()).toHaveLength(1);
    expect(h.manager.list()[0]?.id).toBe(task?.id);
    expect(h.manager.list()[0]?.error).toBeUndefined();
    await h.manager.dispose();
  });

  it('解析不到任何音源 → error 且带上大白话原因（不是静默失败）', async () => {
    const dir = path.join(tempRoot, 'noaudio');
    const h = await makeManager({ dir, resolve: resolveNone });
    await h.manager.add(makeSong(4));
    await waitFor(() => h.manager.list()[0]?.status === 'error', '成为 error');
    expect(h.manager.list()[0]?.error).toContain('所有音源都没拿到可下载地址');
    expect(h.manager.list()[0]?.filePath).toBeTruthy();
    await h.manager.dispose();
  });

  it('上游 HTTP 500 → error，并保留原因', async () => {
    const dir = path.join(tempRoot, 'http500');
    const h = await makeManager({
      dir,
      fetchImpl: () => Promise.resolve(new Response('boom', { status: 500 })),
    });
    await h.manager.add(makeSong(5));
    await waitFor(() => h.manager.list()[0]?.status === 'error', '成为 error');
    expect(h.manager.list()[0]?.error).toContain('HTTP 500');
    await h.manager.dispose();
  });

  it('没有任何监听器时事件也不会把下载搞崩（onChange 退订后照常跑）', async () => {
    const dir = path.join(tempRoot, 'nolistener');
    const bytes = makeBytes(64, 2);
    const h = await makeManager({ dir, fetchImpl: stubbornFetch(bytes) });
    const unsubscribe = h.manager.onChange(() => {
      throw new Error('监听器故意抛错');
    });
    unsubscribe();
    await h.manager.add(makeSong(6));
    await waitFor(() => h.manager.list()[0]?.status === 'done', '下载完成');
    await h.manager.dispose();
  });

  it('list() 按创建时间倒序，返回的是副本（外部改不动内部状态）', async () => {
    const dir = path.join(tempRoot, 'order');
    const bytes = makeBytes(32, 4);
    const h = await makeManager({
      dir,
      fetchImpl: slowFetch(bytes, 16, 5),
      concurrency: 1,
    });
    await h.manager.add(makeSong(11));
    await h.manager.add(makeSong(12));
    const list = h.manager.list();
    expect(list.map((task) => task.songId)).toEqual([12, 11]);
    list[0]!.status = 'paused';
    expect(h.manager.list()[0]?.status).not.toBe('paused');
    await h.manager.dispose();
  });
});

describe('下载管理器：并发与节流', () => {
  it('并发上限 2：三条任务同时排队，任一时刻最多两条在下载', async () => {
    const dir = path.join(tempRoot, 'concurrency');
    const bytes = makeBytes(4096, 5);
    let inFlight = 0;
    let maxInFlight = 0;
    const h = await makeManager({
      dir,
      concurrency: 2,
      fetchImpl: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(60);
        inFlight -= 1;
        return new Response(bytes, { status: 200 });
      },
    });
    await h.manager.add(makeSong(21));
    await h.manager.add(makeSong(22));
    await h.manager.add(makeSong(23));
    await waitFor(() => h.manager.list().every((task) => task.status === 'done'), '三条都下完');
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(h.manager.list()).toHaveLength(3);
    await h.manager.dispose();
  });

  it('进度推送被节流：20 个数据块的下载不会推出 20 次事件', async () => {
    const dir = path.join(tempRoot, 'throttle');
    const bytes = makeBytes(20 * 512, 6);
    const h = await makeManager({ dir, fetchImpl: slowFetch(bytes, 512, 0) });
    await h.manager.add(makeSong(31));
    await waitFor(() => h.manager.list()[0]?.status === 'done', '下载完成');
    // 状态跃迁（排队→下载中→完成）必须逐次推；进度则按 ~4 次/秒合并。
    expect(h.events.length).toBeGreaterThanOrEqual(3);
    expect(h.events.length).toBeLessThan(12);
    const last = h.events.at(-1)?.[0];
    expect(last?.status).toBe('done');
    await h.manager.dispose();
  });

  it('状态跃迁立即推送：add 后马上就能收到一条 queued/downloading', async () => {
    const dir = path.join(tempRoot, 'immediate');
    const bytes = makeBytes(256, 7);
    const h = await makeManager({ dir, fetchImpl: slowFetch(bytes, 128, 40), eventIntervalMs: 10_000 });
    await h.manager.add(makeSong(41));
    expect(h.events.at(-1)?.[0]?.songId).toBe(41);
    await h.manager.dispose();
  });
});

describe('下载管理器：暂停 / 续传 / 重试 / 移除', () => {
  it('暂停保留 .part 且状态是 paused（abort 不能被写成 error）', async () => {
    const dir = path.join(tempRoot, 'pause');
    const bytes = makeBytes(8 * 1024, 8);
    const h = await makeManager({ dir, fetchImpl: slowFetch(bytes, 512, 20) });
    const [task] = await h.manager.add(makeSong(51));
    await waitFor(() => h.manager.list()[0]?.status === 'downloading', '开始下载');
    await sleep(60);
    await h.manager.pause(task?.id ?? '');
    expect(h.manager.list()[0]?.status).toBe('paused');
    const part = `${h.manager.list()[0]?.filePath}.part`;
    const partial = await stat(part);
    expect(partial.size).toBeGreaterThan(0);
    expect(partial.size).toBeLessThan(bytes.length);
    expect(h.manager.list()[0]?.receivedBytes).toBe(partial.size);
    await h.manager.dispose();
  });

  it('支持 Range 时暂停后能从断点接着下，内容仍然逐字节完整', async () => {
    const dir = path.join(tempRoot, 'resume');
    const bytes = makeBytes(16 * 1024, 9);
    const h = await makeManager({
      dir,
      fetchImpl: (input, init) => slowFetch(bytes, 1024, 15)(input, init),
    });
    // 先手动埋一个「上一次下到一半」的 .part，模拟重启后的续传输入。
    await mkdir(dir, { recursive: true });
    const [task] = await h.manager.add(makeSong(52));
    const filePath = task?.filePath ?? '';
    await writeFile(`${filePath}.part`, bytes.slice(0, 4096));
    // init 之外再跑一次「按磁盘同步 .part 大小」的路径：直接 resume 即可（download 里会读盘）。
    await h.manager.resume(task?.id ?? '');
    await waitFor(() => h.manager.list()[0]?.status === 'done', '续传完成');
    expect(await readFile(filePath, null)).toEqual(Buffer.from(bytes));
    await h.manager.dispose();
  });

  it('上游不支持 Range：如实记日志「本次改为重新下载」，并保证文件仍完整', async () => {
    const dir = path.join(tempRoot, 'norange');
    const bytes = makeBytes(4096, 10);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, '歌手甲 - 歌 1.mp3');
    // 直接埋一条「上次下到 1024 字节就停了」的记录：这样 resume 时一定会带 Range 出去。
    await writeFile(`${filePath}.part`, bytes.slice(0, 1024));
    const store = new FakeStore({
      [DOWNLOAD_STORE_KEY]: [
        {
          task: makeStoredTask({
            id: 'y',
            songId: 1,
            status: 'paused',
            filePath,
            receivedBytes: 1024,
            totalBytes: 4096,
          }),
          song: makeSong(1),
        },
      ],
    });
    const h = await makeManager({ dir, store, fetchImpl: stubbornFetch(bytes) });
    await h.manager.resume('y');
    await waitFor(() => h.manager.list()[0]?.status === 'done', '重新下载完成');
    expect(h.logs.some((line) => line.includes('不支持 Range'))).toBe(true);
    expect(h.logs.some((line) => line.includes('改为重新下载'))).toBe(true);
    expect(await readFile(filePath, null)).toEqual(Buffer.from(bytes));
    expect(h.manager.list()[0]?.receivedBytes).toBe(4096);
    await h.manager.dispose();
  });

  it('resume 不动已经在跑的与已完成的（不打断用户正在听的下载）', async () => {
    const dir = path.join(tempRoot, 'resumeguard');
    const bytes = makeBytes(1024, 11);
    const h = await makeManager({ dir, fetchImpl: slowFetch(bytes, 256, 30) });
    const [task] = await h.manager.add(makeSong(54));
    await waitFor(() => h.manager.list()[0]?.status === 'downloading', '开始下载');
    const before = h.manager.list()[0]?.updatedAt;
    await h.manager.resume(task?.id ?? '');
    expect(h.manager.list()[0]?.status).toBe('downloading');
    expect(h.manager.list()[0]?.updatedAt).toBeGreaterThanOrEqual(before ?? 0);
    await h.manager.dispose();
  });

  it('retry 把 error 拉回队列并清掉错误原因', async () => {
    const dir = path.join(tempRoot, 'retry');
    const bytes = makeBytes(64, 12);
    let fail = true;
    const h = await makeManager({
      dir,
      resolve: () => Promise.resolve({ audio: audioFor('exhigh'), attempts: [] }),
      fetchImpl: () => {
        if (fail) return Promise.resolve(new Response('nope', { status: 502 }));
        return Promise.resolve(new Response(bytes, { status: 200 }));
      },
    });
    const [task] = await h.manager.add(makeSong(55));
    await waitFor(() => h.manager.list()[0]?.status === 'error', '第一次失败');
    expect(h.manager.list()[0]?.error).toContain('HTTP 502');
    fail = false;
    await h.manager.retry(task?.id ?? '');
    await waitFor(() => h.manager.list()[0]?.status === 'done', '重试成功');
    expect(h.manager.list()[0]?.error).toBeUndefined();
    await h.manager.dispose();
  });

  it('remove 默认只删记录、文件留在下载目录；deleteFile=true 才连文件（含 .part）一起删', async () => {
    const dir = path.join(tempRoot, 'remove');
    const bytes = makeBytes(128, 13);
    const h = await makeManager({ dir, fetchImpl: stubbornFetch(bytes) });
    const [task] = await h.manager.add(makeSong(56));
    await waitFor(() => h.manager.list()[0]?.status === 'done', '下载完成');
    const filePath = task?.filePath ?? '';
    await h.manager.remove(task?.id ?? '');
    expect(h.manager.list()).toHaveLength(0);
    expect(existsSync(filePath)).toBe(true);

    const [second] = await h.manager.add(makeSong(56));
    await waitFor(() => h.manager.list()[0]?.status === 'done', '再次下载完成');
    const secondPath = second?.filePath ?? '';
    await h.manager.remove(second?.id ?? '', true);
    expect(existsSync(secondPath)).toBe(false);
    expect(existsSync(`${secondPath}.part`)).toBe(false);
    await h.manager.dispose();
  });

  it('移除正在下载的任务：连接被掐断，且不会「复活」成 done', async () => {
    const dir = path.join(tempRoot, 'remove-running');
    const bytes = makeBytes(8 * 1024, 14);
    const h = await makeManager({ dir, fetchImpl: slowFetch(bytes, 256, 20) });
    const [task] = await h.manager.add(makeSong(57));
    await waitFor(() => h.manager.list()[0]?.status === 'downloading', '开始下载');
    await h.manager.remove(task?.id ?? '');
    expect(h.manager.list()).toHaveLength(0);
    await sleep(120);
    expect(h.manager.list()).toHaveLength(0);
    expect(existsSync(task?.filePath ?? 'x')).toBe(false);
    await h.manager.dispose();
  });

  it('操作一个不存在的 id 是安全的空操作', async () => {
    const dir = path.join(tempRoot, 'unknown-id');
    const h = await makeManager({ dir });
    expect(await h.manager.pause('nope')).toEqual([]);
    expect(await h.manager.resume('nope')).toEqual([]);
    expect(await h.manager.retry('nope')).toEqual([]);
    expect(await h.manager.remove('nope')).toEqual([]);
    await h.manager.dispose();
  });
});

describe('下载管理器：持久化与重启对账', () => {
  it('任务落盘时带着原始 song（重启后要重新解析直链：歌手、时长不能丢）', async () => {
    const dir = path.join(tempRoot, 'persist');
    const bytes = makeBytes(64, 15);
    const h = await makeManager({ dir, fetchImpl: stubbornFetch(bytes) });
    const song = makeSong(61, '夜曲', ['周杰伦', '费玉清']);
    await h.manager.add(song);
    await waitFor(() => h.manager.list()[0]?.status === 'done', '下载完成');
    const stored = h.store.data.get(DOWNLOAD_STORE_KEY) as StoredDownloadRow[] | undefined;
    expect(stored).toHaveLength(1);
    expect(stored?.[0]?.task.status).toBe('done');
    expect(stored?.[0]?.song?.durationMs).toBe(200_000);
    expect(stored?.[0]?.song?.artists.map((artist) => artist.name)).toEqual(['周杰伦', '费玉清']);
    await h.manager.dispose();
  });

  it('重启后文件被删 → missing（不删记录、不假装还能播）', async () => {
    const dir = path.join(tempRoot, 'reconcile-missing');
    const bytes = makeBytes(64, 16);
    const h = await makeManager({ dir, fetchImpl: stubbornFetch(bytes) });
    await h.manager.add(makeSong(62));
    await waitFor(() => h.manager.list()[0]?.status === 'done', '下载完成');
    const filePath = h.manager.list()[0]?.filePath ?? '';
    await h.manager.dispose();
    const snapshot = h.store.data.get(DOWNLOAD_STORE_KEY);

    // 模拟「用户手删了文件」后重启：同一个 store 喂给新管理器。
    await rm(filePath, { force: true });
    const store2 = new FakeStore({ [DOWNLOAD_STORE_KEY]: snapshot });
    const h2 = await makeManager({ dir, store: store2 });
    expect(h2.manager.list()).toHaveLength(1);
    expect(h2.manager.list()[0]?.status).toBe('missing');
    // 对账结果要写回盘，否则下次启动还是错的。
    const persisted = store2.data.get(DOWNLOAD_STORE_KEY) as StoredDownloadRow[] | undefined;
    expect(persisted?.[0]?.task.status).toBe('missing');
    await h2.manager.dispose();
  });

  it('重启后 downloading → paused，并按 .part 的真实大小回填进度', async () => {
    const dir = path.join(tempRoot, 'reconcile-partial');
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, '歌手甲 - 歌 1.mp3');
    await writeFile(`${filePath}.part`, makeBytes(777, 17));
    const store = new FakeStore({
      [DOWNLOAD_STORE_KEY]: [
        {
          task: makeStoredTask({
            id: 'x',
            songId: 1,
            status: 'downloading',
            filePath,
            receivedBytes: 5,
            totalBytes: 4096,
          }),
          song: makeSong(1),
        },
      ],
    });
    const h = await makeManager({ dir, store, init: true });
    expect(h.manager.list()[0]?.status).toBe('paused');
    expect(h.manager.list()[0]?.receivedBytes).toBe(777);
    await h.manager.dispose();
  });

  it('坏的清单文件不会让管理器起不来（读失败 → 从空清单继续）', async () => {
    const dir = path.join(tempRoot, 'broken-store');
    const store = new FakeStore();
    store.get = () => Promise.reject(new Error('JSON 坏了'));
    const h = await makeManager({ dir, store });
    expect(h.manager.list()).toEqual([]);
    expect(h.logs.some((line) => line.includes('下载清单读取失败'))).toBe(true);
    await h.manager.dispose();
  });

  it('dispose 会写入最终状态（退出前不丢字节）', async () => {
    const dir = path.join(tempRoot, 'dispose');
    const bytes = makeBytes(8 * 1024, 18);
    const h = await makeManager({ dir, fetchImpl: slowFetch(bytes, 512, 20) });
    await h.manager.add(makeSong(63));
    await waitFor(() => h.manager.list()[0]?.status === 'downloading', '开始下载');
    await sleep(60);
    await h.manager.dispose();
    const stored = h.store.data.get(DOWNLOAD_STORE_KEY) as StoredDownloadRow[] | undefined;
    expect(stored?.[0]?.task.receivedBytes).toBeGreaterThan(0);
    expect(h.manager.list()[0]?.receivedBytes).toBeGreaterThan(0);
  });
});
