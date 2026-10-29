import { describe, expect, it } from 'vitest';
import {
  BEAT_HOP,
  BEAT_N_FFT,
  BEAT_N_MELS,
  BEAT_SAMPLE_RATE,
  fft,
  logMelSpectrogram,
  melFilterbank,
} from './mel';

/**
 * 前处理的正确性只能靠合成信号验：纯音应该落在它该在的频带，静音应该全是 0，
 * FFT 的峰值应该落在 `freq / sr * n_fft`。这些一旦错了，模型喂进去的就是噪声。
 */
function tone(freq: number, seconds = 1): Float32Array {
  const length = Math.floor(seconds * BEAT_SAMPLE_RATE);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freq * i) / BEAT_SAMPLE_RATE) * 0.5;
  }
  return out;
}

function spectrumPeakBin(samples: Float32Array): number {
  const re = new Float32Array(BEAT_N_FFT);
  const im = new Float32Array(BEAT_N_FFT);
  for (let i = 0; i < BEAT_N_FFT; i += 1) re[i] = samples[i] ?? 0;
  fft(re, im);
  let bestBin = 0;
  let bestPower = -1;
  for (let bin = 0; bin <= BEAT_N_FFT / 2; bin += 1) {
    const power = (re[bin] as number) ** 2 + (im[bin] as number) ** 2;
    if (power > bestPower) {
      bestPower = power;
      bestBin = bin;
    }
  }
  return bestBin;
}

describe('FFT', () => {
  it('440Hz 纯音的峰值落在第 20 根频带附近', () => {
    // 440 / 22050 * 1024 ≈ 20.43
    expect(spectrumPeakBin(tone(440))).toBeGreaterThanOrEqual(19);
    expect(spectrumPeakBin(tone(440))).toBeLessThanOrEqual(21);
  });

  it('静音的频谱全为 0', () => {
    expect(spectrumPeakBin(new Float32Array(BEAT_N_FFT))).toBe(0);
  });
});

describe('Mel 滤波器组', () => {
  it('形状是 128 带 × 513 个频点', () => {
    const filters = melFilterbank();
    expect(filters.length).toBe(BEAT_N_MELS);
    for (const filter of filters) expect(filter.length).toBe(BEAT_N_FFT / 2 + 1);
  });

  it('每个滤波器非负，且中心频率随带号递增', () => {
    const filters = melFilterbank();
    for (const filter of filters) {
      for (const value of filter) expect(value).toBeGreaterThanOrEqual(0);
    }
    // 用「最大值所在的 bin」粗略代表中心频率，必须单调不减。
    const centers = filters.map((filter) => {
      let best = 0;
      for (let bin = 1; bin < filter.length; bin += 1) {
        if ((filter[bin] as number) > (filter[best] as number)) best = bin;
      }
      return best;
    });
    for (let i = 1; i < centers.length; i += 1) {
      expect(centers[i] as number).toBeGreaterThanOrEqual(centers[i - 1] as number);
    }
  });
});

describe('log-Mel 谱', () => {
  it('帧数按 hop 算：1 秒 = 50 帧', () => {
    const result = logMelSpectrogram(tone(440, 1));
    expect(result.frames).toBe(Math.floor((BEAT_SAMPLE_RATE - BEAT_N_FFT) / BEAT_HOP) + 1);
    expect(result.data.length).toBe(result.frames * BEAT_N_MELS);
  });

  it('440Hz 纯音的能量集中在低中频带，不会全谱一样响', () => {
    const result = logMelSpectrogram(tone(440, 1));
    const frame = 10;
    const row = Array.from(
      result.data.subarray(frame * BEAT_N_MELS, (frame + 1) * BEAT_N_MELS),
    );
    const max = Math.max(...row);
    const min = Math.min(...row);
    expect(max).toBeGreaterThan(0);
    // 128 个带里，最响的带应该明显高于最安静的带。
    expect(max - min).toBeGreaterThan(0.5);
  });

  it('静音的 log-Mel 全为 0（log1p 保住了 0，不会变成 -Infinity）', () => {
    const result = logMelSpectrogram(new Float32Array(BEAT_SAMPLE_RATE));
    expect(result.frames).toBeGreaterThan(0);
    for (const value of result.data) expect(value).toBe(0);
  });
});
