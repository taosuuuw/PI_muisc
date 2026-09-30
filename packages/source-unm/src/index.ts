/**
 * L1 第三方聚合源（UnblockNeteaseMusic，docs/ADR/0001-音源解析链.md）。
 *
 * ## 为什么是「库调用」而不是「装个代理服务」
 *
 * UNM 官方形态是一个反向代理 + 系统代理/hosts 劫持。那套东西对本应用是灾难：
 * 改用户系统设置、装证书、还要常驻一个 HTTP 服务。好在它导出的就是一个普通函数
 * （`src/provider/match.js` 末尾 `module.exports = match`），我们可以**直接调用**，
 * 不碰系统、不起服务。
 *
 * ## 三个必须记住的坑（都踩过或验证过）
 *
 * 1. 若干环境变量是 UNM 在**模块加载时**读的（`ENABLE_FLAC`、`LOG_LEVEL`、`JSON_LOG`、
 *    `QQ_COOKIE`…）。必须在第一次 `require` **之前**设好，所以加载走懒执行的
 *    {@link loadUnm}，而不是文件顶部的 `import`（ESM 的 import 会被提升，顺序保证不了）。
 * 2. 失败时它 reject 的东西**不一定是 Error**：默认路径抛 `AggregateError`，
 *    `FOLLOW_SOURCE_ORDER` 模式下可能抛一个**裸字符串**，`check()` 甚至 `reject(undefined)`。
 *    所以 catch 之后不能假设 `error instanceof Error`。
 * 3. 它没有「音质参数」：音质由全局 `ENABLE_FLAC` 控制，输出里用 `br === 999000`
 *    表示 FLAC（`fLaC` 魔数被 decode 成 999 再乘 1000）。
 *
 * ## 授权
 *
 * `@unblockneteasemusic/server` 是 **LGPL-3.0-only**：我们**不修改**它、也不把它打进
 * 主进程 bundle（esbuild 里标 external），以独立 npm 包的形式随应用分发，
 * 从而保留用户自行替换该模块的能力（LGPL 的 relink 要求）。第三方源默认关闭，
 * 首次启用需要用户二次确认——这是 docs/PLAN.md §2.5 的账号安全红线。
 */

import { createRequire } from 'node:module';
import type { Quality, ResolvedAudio } from '@pi/shared';
import { NEUTRAL_UPSTREAM_HEADERS, bitrateFloorKbps, isLosslessQuality } from '@pi/source-core';
import type { MatchInput, MusicSource } from '@pi/source-core';

export const UNM_SOURCE_ID = 'unm';
export const UNM_SOURCE_LABEL = '第三方聚合（UNM）';

/** UNM 用这个 br 值表示无损 FLAC（见文件头注释）。 */
export const UNM_FLAC_BR = 999_000;

/**
 * 默认平台顺序。
 *
 * 顺序只在 `FOLLOW_SOURCE_ORDER=true` 时有意义（我们就是这么设的），此时是
 * **串行试探、先成功先返回**，所以顺序直接决定延迟：
 *
 * - `bodian`：**放第一位**。2026-09-25 在本机实测（`node scripts/probe-unm.mjs`）：只有它出结果，
 *   3.8–5.9 秒返回 `br=999000`（FLAC）；酷狗 114ms 就 `No audioData!`、咪咕 2.1 秒同样无货
 *   （它们返回 HTML，被 UNM 当 JSON 解析→报错）。先问能出货的那家，延迟减半。
 * - `kugou`：无损最强且不需要 cookie，理论上是首选；本机无货所以退居第二。
 * - `migu`：次之，同样不需要 cookie。
 * - `ytdlp`/`qq`/`joox`/`bilibili`：要么需要外部二进制、要么需要登录 cookie，**不默认启用**。
 */
export const UNM_DEFAULT_PROVIDERS: readonly string[] = ['bodian', 'kugou', 'migu'];

/**
 * UNM 层的超时预算。
 *
 * 责任链默认给每个源 8 秒，但实测「串行试探三个平台」在冷启动时会超过 8 秒
 * （冒烟里就是 `unm ✗ UNM 匹配超时（8006ms）`）。第三方源本来就是官方失败后的
 * 兜底，用户对一个变灰的歌多等几秒可以接受，拿不到无损才是真的不能用。
 */
export const UNM_MATCH_TIMEOUT_MS = 20_000;

/** UNM 返回的数据结构（`AudioData`）。 */
export interface UnmAudioData {
  size?: number;
  /** 码率（bps）。FLAC 恒为 999000。 */
  br?: number | null;
  url?: string;
  md5?: string | null;
  /** 命中的平台 key，如 `kugou`。 */
  source?: string;
}

export type UnmMatchFn = (
  id: number,
  source?: string[],
  data?: unknown,
) => Promise<UnmAudioData>;

/** 成功结果的缓存时长。第三方直链带签名，通常能撑几小时，但我们只信 10 分钟。 */
export const UNM_CACHE_TTL_MS = 10 * 60_000;
/** 失败/未匹配的负缓存时长，避免连点下一首时把第三方接口打爆。 */
export const UNM_MISS_TTL_MS = 60_000;

interface UnmCacheEntry {
  /** `null` 表示负缓存（未匹配或抛错）。 */
  audio: ResolvedAudio | null;
  expiresAt: number;
}

/**
 * 极小的 TTL 缓存（Map + 显式过期）。
 *
 * UNM 自己也有内存缓存，但它在库模式下**永远不会被清理**，而且我们没法按
 * 「用户改了设置」来让它失效。自己再挡一层，才能既省请求又能在设置变化时立刻生效。
 */
export class UnmCache {
  private readonly entries = new Map<string, UnmCacheEntry>();

  constructor(private readonly maxEntries = 64) {}

  get(key: string, now: number): UnmCacheEntry | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return hit;
  }

  set(key: string, entry: UnmCacheEntry): void {
    // Map 保持插入顺序：删最老的键即可，不需要真 LRU（命中率差异可以忽略）。
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, entry);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface UnmSourceOptions {
  /** 平台顺序，默认 {@link UNM_DEFAULT_PROVIDERS}。未知名字会被 UNM 静默丢弃。 */
  providers?: readonly string[];
  /** 加载器。默认从 node_modules 懒加载真实模块；测试时可注入假实现。 */
  load?: () => UnmMatchFn;
  /**
   * 是否允许第三方给出无损。
   *
   * 是个**函数**而不是布尔值：设置随时可能被用户改（settings 面板），
   * 而音源对象是长生命周期的，构造时读一次会把旧设置焊死。
   */
  allowLossless?: () => boolean;
  /** 结果缓存。默认每个音源实例一个；测试可注入只读假实现。 */
  cache?: UnmCache;
  cacheTtlMs?: number;
  missTtlMs?: number;
  /** 便于测试注入时钟。 */
  now?: () => number;
  log?(message: string, detail?: unknown): void;
}

/** 缓存键：同一首歌在不同期望档位下可能拿到不同结果，所以档位要进键。 */
function cacheKey(input: MatchInput, providers: readonly string[]): string {
  return `${input.songId}:${input.quality}:${providers.join(',')}`;
}

/** br → 我们自己的音质档位。UNM 只区分「无损 / 320k / 192k / 更低」。 */
export function qualityFromBitrate(br: number | null | undefined): Quality {
  const value = br ?? 0;
  if (value >= UNM_FLAC_BR) return 'flac';
  if (value >= 320_000) return 'exhigh';
  if (value >= 192_000) return 'higher';
  return 'standard';
}

let cachedMatch: UnmMatchFn | undefined;

/**
 * 懒加载 UNM。
 *
 * 顺序很重要：**先设环境变量，再 require**。`ENABLE_FLAC` 决定所有平台要不要取无损；
 * `JSON_LOG=true` 关掉 pino-pretty（它会在 Electron 里起 worker 线程，还可能往已经关闭的
 * stdout 写日志）；`LOG_LEVEL=error` 让它安静。
 */
export function loadUnm(): UnmMatchFn {
  if (cachedMatch) return cachedMatch;
  process.env['ENABLE_FLAC'] ??= 'true';
  process.env['JSON_LOG'] ??= 'true';
  process.env['LOG_LEVEL'] ??= 'error';
  const require = createRequire(import.meta.url);
  const loaded: unknown = require('@unblockneteasemusic/server');
  const fn =
    typeof loaded === 'function'
      ? (loaded as UnmMatchFn)
      : (loaded as { default?: UnmMatchFn }).default;
  if (typeof fn !== 'function') {
    throw new Error('@unblockneteasemusic/server 没有导出 match 函数，版本可能变了');
  }
  cachedMatch = fn;
  return fn;
}

/** 把 UNM 那些「不是 Error 的失败」整理成人能看懂的一句话。 */
export function describeUnmFailure(error: unknown): string {
  if (error instanceof AggregateError) {
    const inner = error.errors.map((item) => describeUnmFailure(item)).filter(Boolean);
    return inner.length > 0 ? `所有平台都没匹配到（${inner.join('；')}）` : '所有平台都没匹配到';
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === undefined) return '匹配被拒绝（UNM 在探测失败时会 reject(undefined)）';
  return String(error);
}

export function createUnmSource(options: UnmSourceOptions = {}): MusicSource {
  const providers = [...(options.providers ?? UNM_DEFAULT_PROVIDERS)];
  const load = options.load ?? loadUnm;
  const allowLossless = options.allowLossless ?? (() => true);
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.cacheTtlMs ?? UNM_CACHE_TTL_MS;
  const missTtlMs = options.missTtlMs ?? UNM_MISS_TTL_MS;
  const cache = options.cache ?? new UnmCache();

  return {
    id: UNM_SOURCE_ID,
    label: UNM_SOURCE_LABEL,
    tier: 'unm',
    // 第三方源永远不碰 cookie。
    needsCookie: false,
    // 它要串行试多个平台，用自己更宽的预算（见 UNM_MATCH_TIMEOUT_MS）。
    timeoutMs: UNM_MATCH_TIMEOUT_MS,
    // 它给什么档位由全局 ENABLE_FLAC 与平台决定，理论上 8 个档位都可能出现。
    qualities: ['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jymaster', 'flac', 'flac24bit'],

    async match(input: MatchInput, signal: AbortSignal): Promise<ResolvedAudio | null> {
      const key = cacheKey(input, providers);
      const at = now();
      const cached = cache.get(key, at);
      if (cached) {
        if (!cached.audio) return null;
        // 缓存命中也要复查设置：用户刚关掉「允许第三方无损」时，旧缓存不能把无损放过去。
        if (isLosslessQuality(cached.audio.quality) && !allowLossless()) return null;
        options.log?.('[pi/source-unm] 命中缓存', { key, via: cached.audio.via });
        return cached.audio;
      }

      const match = load();
      // 这两个是 UNM 在**调用时**读的：按顺序试、别用「谁快用谁」。
      process.env['FOLLOW_SOURCE_ORDER'] ??= 'true';

      let data: UnmAudioData;
      try {
        data = await raceWithSignal(
          match(input.songId, providers, undefined),
          signal,
          'UNM 匹配超时',
        );
      } catch (error) {
        // 调用方取消（用户跳歌、责任链给别的源让路）**不是**「这个源没有货」，
        // 绝不能写负缓存：否则同一首歌接下来一分钟会被静默判定成「第三方没资源」，
        // 而且错误类型也从 timeout 变成 null，责任链的 attempts 记录会跟着失真。
        if (signal.aborted) throw error;
        // 失败也缓存一小会儿：一首热门歌连续重试会把第三方接口打成限流。
        // 过期时间从**失败时刻**算，不是从调用开始时刻算——一次跑满 20 秒的失败
        // 不该让「一分钟负缓存」缩水成 40 秒。
        cache.set(key, { audio: null, expiresAt: now() + missTtlMs });
        throw error;
      }

      const url = data?.url;
      if (!url) {
        cache.set(key, { audio: null, expiresAt: now() + missTtlMs });
        return null;
      }

      const quality = qualityFromBitrate(data.br);
      const provider = data.source ?? 'unknown';
      const brText = data.br ? `${Math.round(data.br / 1000)}kbps` : '码率未知';

      // 用户关掉「允许第三方补无损」时，第三方给的无损一律不采纳（宁可听官方 320k）。
      // 注意这里**不写缓存**：这是我们的策略决定，不是这个音源的真实能力，
      // 用户一改设置就该立刻生效。
      if (isLosslessQuality(quality) && !allowLossless()) {
        options.log?.('[pi/source-unm] 第三方无损已被设置禁止，忽略', { provider, br: data.br });
        return null;
      }

      const audio: ResolvedAudio = {
        url,
        // 如实报告 UNM 给到的档位；责任链会用字节嗅探再校正一次（第三方虚标很常见）。
        quality,
        probe: { container: 'unknown', evidence: `pending-probe（unm:${provider} ${brText}）` },
        via: UNM_SOURCE_ID,
        // 第三方直链**绝不能**带网易 Referer，所以显式给中性头。
        upstreamHeaders: NEUTRAL_UPSTREAM_HEADERS,
      };
      cache.set(key, { audio, expiresAt: now() + ttlMs });
      return audio;
    },
  };
}

/**
 * UNM 的 `match()` 不接受 AbortSignal，所以超时只能靠竞速。
 * 注意要摘掉监听器：一首歌解析上百次的话，不摘会一直堆在 signal 上。
 */
async function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<T> {
  if (signal.aborted) throw new Error(timeoutMessage);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(timeoutMessage));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** 供测试与排障：某个音质至少要多少码率才算达标。 */
export function unmetBitrateFloor(quality: Quality, br: number | null | undefined): boolean {
  const floor = bitrateFloorKbps(quality);
  if (floor === undefined) return false;
  return (br ?? 0) < floor * 1000;
}
