import { describe, expect, it } from 'vitest';
import type { AudioProbe, Quality } from '@pi/shared';
import {
  LOSSLESS_QUALITIES,
  bitrateFloorKbps,
  isLosslessQuality,
  qualityFromProbe,
} from './quality.js';

function probe(container: AudioProbe['container'], extra: Partial<AudioProbe> = {}): AudioProbe {
  return { container, evidence: 'test', ...extra };
}

describe('isLosslessQuality', () => {
  it('认得官方与第三方两套无损档位名', () => {
    for (const quality of ['lossless', 'hires', 'jymaster', 'flac', 'flac24bit'] as Quality[]) {
      expect(isLosslessQuality(quality)).toBe(true);
      expect(LOSSLESS_QUALITIES).toContain(quality);
    }
  });

  it('不把有损档位当无损', () => {
    for (const quality of ['standard', 'higher', 'exhigh'] as Quality[]) {
      expect(isLosslessQuality(quality)).toBe(false);
    }
  });
});

describe('bitrateFloorKbps', () => {
  it('有损档位有码率下限，无损档位没有', () => {
    expect(bitrateFloorKbps('standard')).toBe(64);
    expect(bitrateFloorKbps('higher')).toBe(192);
    expect(bitrateFloorKbps('exhigh')).toBe(320);
    expect(bitrateFloorKbps('lossless')).toBeUndefined();
    expect(bitrateFloorKbps('hires')).toBeUndefined();
  });
});

describe('qualityFromProbe', () => {
  it('FLAC 至少是无损，48kHz 以内记 lossless', () => {
    expect(qualityFromProbe(probe('flac', { sampleRate: 44_100 }), 'standard')).toBe('lossless');
    expect(qualityFromProbe(probe('flac', { sampleRate: 48_000 }), 'lossless')).toBe('lossless');
  });

  it('采样率超过 48kHz 记 hires', () => {
    expect(qualityFromProbe(probe('flac', { sampleRate: 96_000 }), 'lossless')).toBe('hires');
    expect(qualityFromProbe(probe('wav', { sampleRate: 192_000 }), 'lossless')).toBe('hires');
  });

  it('只有自称 flac24bit 时才保留这个档位名', () => {
    expect(qualityFromProbe(probe('flac', { sampleRate: 44_100 }), 'flac24bit')).toBe('flac24bit');
    expect(qualityFromProbe(probe('flac', { sampleRate: 44_100 }), 'hires')).toBe('lossless');
  });

  it('第三方把 128k mp3 标成 flac 时，按实测降级（虚标要被抓出来）', () => {
    expect(qualityFromProbe(probe('mp3', { bitrateKbps: 128 }), 'flac')).toBe('standard');
    expect(qualityFromProbe(probe('mp3', { bitrateKbps: 192 }), 'lossless')).toBe('higher');
    expect(qualityFromProbe(probe('mp3', { bitrateKbps: 321 }), 'hires')).toBe('exhigh');
  });

  it('mp3 永远不可能因为码率高就变成无损', () => {
    const result = qualityFromProbe(probe('mp3', { bitrateKbps: 1000 }), 'lossless');
    expect(result).toBe('exhigh');
    expect(isLosslessQuality(result)).toBe(false);
  });

  it('拿不到码率时保留自称，但绝不高于 exhigh', () => {
    expect(qualityFromProbe(probe('mp3'), 'higher')).toBe('higher');
    expect(qualityFromProbe(probe('unknown'), 'lossless')).toBe('exhigh');
    expect(qualityFromProbe(probe('unknown'), 'jymaster')).toBe('exhigh');
    expect(qualityFromProbe(probe('unknown'), 'standard')).toBe('standard');
  });

  it('码率为 0 视同拿不到，不当成有效证据', () => {
    expect(qualityFromProbe(probe('mp3', { bitrateKbps: 0 }), 'exhigh')).toBe('exhigh');
    expect(qualityFromProbe(probe('mp3', { bitrateKbps: 0 }), 'hires')).toBe('exhigh');
  });
});
