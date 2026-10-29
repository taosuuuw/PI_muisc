/**
 * Beat This! 的前处理：22050Hz 单声道 → 128 带 log-Mel 谱（P3·Beat This! 接入）。
 *
 * 契约来自模型作者与 `mosynthkey/beat_this_cpp` 的 ONNX 说明：
 * `n_fft=1024, hop=441, n_mels=128, Slaney 刻度`，输入张量 `(batch, frames, 128)`，
 * 输出 `beat` / `downbeat` 两路 logits。
 *
 * 为什么自己算而不是调库：项目里没有 torch/librosa，而这段是纯定点数学——FFT + 三角滤波器组，
 * 手写比引一个几十 MB 的依赖靠谱，也能用纯音/静音单测逐条钉住。
 */

/** Beat This! 的采样率。 */
export const BEAT_SAMPLE_RATE = 22_050;
/** STFT 窗长。 */
export const BEAT_N_FFT = 1024;
/** STFT 跳长（22050/441 = 50 帧/秒，与模型的 50fps 对齐）。 */
export const BEAT_HOP = 441;
/** Mel 带数。 */
export const BEAT_N_MELS = 128;
/** 模型的分块长度（帧）与块间重叠。 */
export const BEAT_CHUNK_FRAMES = 1500;
export const BEAT_CHUNK_BORDER = 6;

/**
 * 原地 radix-2 FFT（长度必须是 2 的幂）。
 *
 * 只在 STFT 里用一次尺寸（1024），所以不追求极致，写清楚就行。
 */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let j = 0; j < half; j += 1) {
        const a = i + j;
        const b = a + half;
        const vR = (re[b] as number) * curR - (im[b] as number) * curI;
        const vI = (re[b] as number) * curI + (im[b] as number) * curR;
        const uR = re[a] as number;
        const uI = im[a] as number;
        re[a] = uR + vR;
        im[a] = uI + vI;
        re[b] = uR - vR;
        im[b] = uI - vI;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
}

/** Slaney 的 Hz → Mel（1000Hz 以下线性、以上对数）。 */
function hzToMel(hz: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / logStep;
}

function melToHz(mel: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return mel < minLogMel ? mel * fSp : minLogHz * Math.exp(logStep * (mel - minLogMel));
}

/**
 * 生成三角 Mel 滤波器组：`[bands][bins]`。
 *
 * bins 是 `nFft/2 + 1`（正频率，含 Nyquist）。每个三角在相邻中心频率之间从 0 升到 1 再降到 0，
 * 面积归一化到 2/(中心右 - 中心左)（Slaney 的 `norm='slaney'`），这样各带能量量级可比。
 */
export function melFilterbank(
  sampleRate = BEAT_SAMPLE_RATE,
  nFft = BEAT_N_FFT,
  bands = BEAT_N_MELS,
  fMin = 0,
  fMax = sampleRate / 2,
): Float32Array[] {
  const bins = Math.floor(nFft / 2) + 1;
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  const centers = new Float32Array(bands + 2);
  for (let i = 0; i < bands + 2; i += 1) {
    centers[i] = melToHz(melMin + ((melMax - melMin) * i) / (bands + 1));
  }
  const filters: Float32Array[] = [];
  for (let band = 0; band < bands; band += 1) {
    const filter = new Float32Array(bins);
    const left = centers[band] as number;
    const center = centers[band + 1] as number;
    const right = centers[band + 2] as number;
    for (let bin = 0; bin < bins; bin += 1) {
      const freq = (bin * sampleRate) / nFft;
      if (freq >= left && freq <= center && center > left) {
        filter[bin] = (freq - left) / (center - left);
      } else if (freq > center && freq <= right && right > center) {
        filter[bin] = (right - freq) / (right - center);
      }
    }
    // Slaney 面积归一化。
    const width = right - left;
    if (width > 0) {
      const scale = 2 / width;
      for (let bin = 0; bin < bins; bin += 1) filter[bin] = (filter[bin] as number) * scale;
    }
    filters.push(filter);
  }
  return filters;
}

/** 预计算好的滤波器组（模型只要这一套参数）。 */
let cachedFilters: Float32Array[] | undefined;

export function beatMelFilters(): Float32Array[] {
  if (!cachedFilters) cachedFilters = melFilterbank();
  return cachedFilters;
}

/**
 * 计算 log-Mel 谱：返回 `frames × 128` 的扁平数组（按帧优先）。
 *
 * 先乘汉宁窗再 FFT，取功率谱，乘滤波器组成 Mel 能量，最后 `log1p`。
 * `log1p` 与 Beat This! 训练时一致（它压住大动态、又不让静音变成 `-inf`）。
 */
export function logMelSpectrogram(samples: Float32Array): {
  data: Float32Array;
  frames: number;
  bands: number;
} {
  const bands = BEAT_N_MELS;
  const nFft = BEAT_N_FFT;
  const hop = BEAT_HOP;
  const bins = Math.floor(nFft / 2) + 1;
  const filters = beatMelFilters();
  const frames = samples.length < nFft ? 0 : Math.floor((samples.length - nFft) / hop) + 1;
  const data = new Float32Array(Math.max(0, frames * bands));
  const window = new Float32Array(nFft);
  for (let i = 0; i < nFft; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nFft - 1));
  const re = new Float32Array(nFft);
  const im = new Float32Array(nFft);
  const power = new Float32Array(bins);

  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * hop;
    for (let i = 0; i < nFft; i += 1) {
      re[i] = (samples[start + i] ?? 0) * (window[i] as number);
      im[i] = 0;
    }
    fft(re, im);
    for (let bin = 0; bin < bins; bin += 1) {
      const r = re[bin] as number;
      const i = im[bin] as number;
      power[bin] = r * r + i * i;
    }
    for (let band = 0; band < bands; band += 1) {
      const filter = filters[band] as Float32Array;
      let sum = 0;
      for (let bin = 0; bin < bins; bin += 1) sum += (filter[bin] as number) * (power[bin] as number);
      data[frame * bands + band] = Math.log1p(Math.max(0, sum));
    }
  }
  return { data, frames, bands };
}
