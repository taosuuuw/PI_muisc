/**
 * 音质映射与「以实测为准」的校正（docs/PLAN.md 任务组 H5「真实音质校验」）。
 *
 * 核心原则：**接口自称的音质只是线索，字节证据才是结论**。
 * 第三方源会虚标（把 128k 的 mp3 说成无损），官方也会降级（hires 没上架就给 lossless），
 * 所以责任链拿到嗅探结果后要用这里把 `quality` 改写一遍，UI 徽标只认改写后的值。
 */

import { qualityRank, type AudioProbe, type Quality } from '@pi/shared';

/** 无损档位（含第三方源专用的 flac/flac24bit）。 */
export const LOSSLESS_QUALITIES: readonly Quality[] = [
  'lossless',
  'hires',
  'jymaster',
  'flac',
  'flac24bit',
];

export function isLosslessQuality(quality: Quality): boolean {
  return LOSSLESS_QUALITIES.includes(quality);
}

/** 有损档位的最低码率要求（kbps）。无损档位没有码率下限，返回 undefined。 */
export function bitrateFloorKbps(quality: Quality): number | undefined {
  switch (quality) {
    case 'exhigh':
      return 320;
    case 'higher':
      return 192;
    case 'standard':
      return 64;
    default:
      return undefined;
  }
}

/**
 * 用实测结果给音质「正名」。
 *
 * - FLAC/WAV 容器 → 至少无损；采样率 > 48kHz 记 hires（这是 hi-res 的定义）；
 * - 有损容器 → 按实测码率落到 exhigh / higher / standard，
 *   但**不会**因为码率就升到无损档（mp3 永远不是无损，哪怕 320k）。
 */
export function qualityFromProbe(probe: AudioProbe, claimed: Quality): Quality {
  if (probe.container === 'flac' || probe.container === 'wav') {
    const sampleRate = probe.sampleRate ?? 0;
    if (sampleRate > 48_000) return 'hires';
    // 24bit 无法从容器头可靠区分（FLAC 的位深在 STREAMINFO 里，但我们只当提示用）。
    return claimed === 'flac24bit' ? 'flac24bit' : 'lossless';
  }

  const kbps = probe.bitrateKbps;
  if (kbps !== undefined && kbps >= 320) return 'exhigh';
  if (kbps !== undefined && kbps >= 192) return 'higher';
  if (kbps !== undefined && kbps > 0) return 'standard';
  // 完全没拿到码率（有些 CDN 不给 content-length）：保留接口自称，但绝不高于 exhigh。
  return qualityRank(claimed) > qualityRank('exhigh') ? 'exhigh' : claimed;
}
