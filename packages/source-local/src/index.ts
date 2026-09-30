/**
 * L4 本地源（docs/ADR/0001-音源解析链.md 的最后一层）。
 *
 * ## 它解决什么问题
 *
 * 有些歌官方永远变灰、第三方也匹配不到，但用户自己的硬盘上就有——可能是买的、
 * 可能是自己压的。责任链走完前面所有层都拿不到时，来这里按「歌名 + 歌手 + 时长」
 * 找一遍，比弹一个「播放失败」有用得多。
 *
 * ## 为什么它最不容易出事
 *
 * 本地文件不联网、不虚标、不需要 cookie、不会失效。唯一的风险是**匹配错**——
 * 那会放出一首完全无关的歌，而用户往往看不出问题在链路哪一层。所以
 * {@link matchLocalTrack} 用的是硬条件而不是打分排序：宁可漏，不可错。
 *
 * ## 与媒体代理的配合
 *
 * 本地文件不需要经过网络，但**仍然要走媒体代理**（`127.0.0.1/audio/<key>`）：
 * 渲染进程在 CSP 与 `file://` 之外，不能直接读盘；代理顺带把 Range 请求
 * （拖动进度条）也实现了。所以这里给出的 `url` 只是「这歌在哪」的说明，
 * 真正给渲染进程的是主进程 `publish()` 生成的代理地址。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Quality, ResolvedAudio } from '@pi/shared';
import type { MatchInput, MusicSource } from '@pi/source-core';
import { LocalLibrary, type LocalMatchResult } from './library.js';

export const LOCAL_SOURCE_ID = 'local';
export const LOCAL_SOURCE_LABEL = '本地文件';

/**
 * 本地查找是纯内存 + 一次文件名匹配，理论上微秒级。给 3 秒是给
 * 「曲库刚被重扫、还在建索引」留余量，不是真的需要这么久。
 */
export const LOCAL_MATCH_TIMEOUT_MS = 3_000;

/** 无损后缀：这些天生就是无损容器，不需要看码率。 */
const LOSSLESS_EXTENSIONS: readonly string[] = ['flac', 'ape', 'wav'];

/**
 * 从后缀猜档位。
 *
 * 猜错的代价很小：责任链的探针会用文件头 + 文件大小/时长算出真实码率，
 * 不一致时会写成 `claimedQuality`（UI 上显示「标称 X，实测只到 Y」）。
 * `ape`/`wav` 归到 `lossless` 而不是 `flac`：它们的容器不是 FLAC，
 * 硬件与解码链路也不一样，夸大成 flac 只会误导。
 */
export function qualityFromExtension(ext: string): Quality {
  const normalized = ext.replace(/^\./, '').toLowerCase();
  if (LOSSLESS_EXTENSIONS.includes(normalized)) return 'lossless';
  // mp3/m4a/aac/ogg/opus/wma 都可能从 128k 到 320k，先按最高的自称，探针会实测校正。
  return 'exhigh';
}

export interface LocalSourceOptions {
  /**
   * 取当前曲库。
   *
   * 是**函数**而不是实例：用户随时可能换文件夹 / 重扫，音源对象是长生命周期的，
   * 构造时抓一个引用会把旧曲库焊死（和 `allowLossless` 同样的理由）。
   */
  library: () => LocalLibrary;
  log?(message: string, detail?: unknown): void;
}

/** 把匹配到的本地曲目变成责任链认识的解析结果。 */
export function localAudioFor(matched: LocalMatchResult): ResolvedAudio {
  const { track } = matched;
  const sizeText =
    track.sizeBytes !== undefined ? `${(track.sizeBytes / 1024 / 1024).toFixed(1)}MB` : '大小未知';
  return {
    url: pathToFileURL(track.path).href,
    quality: qualityFromExtension(track.ext),
    probe: {
      container: 'unknown',
      evidence: `pending-probe（local:${path.basename(track.path)} ${sizeText}）`,
    },
    via: LOCAL_SOURCE_ID,
    localPath: track.path,
  };
}

export function createLocalSource(options: LocalSourceOptions): MusicSource {
  return {
    id: LOCAL_SOURCE_ID,
    label: LOCAL_SOURCE_LABEL,
    tier: 'local',
    needsCookie: false,
    timeoutMs: LOCAL_MATCH_TIMEOUT_MS,
    // 本地文件什么容器都可能，所以 8 个档位都算候选；真实档位由探针实测决定。
    qualities: ['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jymaster', 'flac', 'flac24bit'],

    async match(input: MatchInput, signal: AbortSignal): Promise<ResolvedAudio | null> {
      if (signal.aborted) return null;
      const library = options.library();
      if (library.size === 0) return null;

      const matched = library.find(input);
      if (!matched) return null;

      options.log?.('[pi/source-local] 本地曲库命中', {
        file: matched.track.path,
        reason: matched.reason,
      });
      return localAudioFor(matched);
    },
  };
}

export {
  AUDIO_EXTENSIONS,
  LocalLibrary,
  extensionOf,
  isAudioFile,
  matchLocalTrack,
  normalizeForMatch,
  parseTrackFileName,
  scanAudioDirectory,
} from './library.js';
export type { LocalMatchResult, LocalTrack, ScanOptions } from './library.js';
