/**
 * 离线音频分析（P3 的「证据层」）。
 *
 * 这里只做**纯数学**：输入一段已解码、已降采样的单声道 PCM，输出一份 `TrackProfileCore`。
 * 不做 IO、不碰 `<audio>`、不建 AudioContext —— 所以它能被单测用合成信号直接钉住。
 *
 * 为什么要这套东西：P2 的交叉时长是写死的 5 秒。真实素材的结尾有长有短，有的收得很干净、
 * 有的拖着一大段混响尾巴；把两者按同一个窗口叠起来，短的会「拦腰截断」、长的会「空一大截」。
 * 分析要回答的就是「这首歌还剩多少可听内容」「它是怎么收的」。
 *
 * **为什么是 DSP 而不是 Beat This!**：模型（8.1MB）+ 推理运行时（onnxruntime，几十 MB）
 * 是两件重依赖，本项目当前拿不到（npm 安装被受限环境挡住）。`detectBeat` 是兜底路径，
 * 可用率显著低于 Beat This!（folia 实测其内置估算器约 20% 可用、Beat This! F=1.0），
 * 所以 profile 里带 `confidence`，低置信度的结果按「不知道」处理，由调用方回退到固定窗口。
 */
export interface TrackProfileCore {
  /** 全曲时长（毫秒）。 */
  durationMs: number;
  /** 估算出的 BPM；`null` = 没测出来。 */
  bpm: number | null;
  /** 第一拍相对歌曲开头的偏移（秒）；`null` = 没有网格。 */
  beatOffsetSec: number | null;
  /** 拍长（秒）；`null` = 没有网格。 */
  beatPeriodSec: number | null;
  /** 拍网格的置信度 0~1（拍点位置上的 onset 能量占比）。 */
  confidence: number;
  tail: {
    /** 结尾有多少秒几乎没有内容（静音/尾音）。 */
    silenceSec: number;
    /** 最后 15 秒里「有声」的比例 0~1。 */
    activityRatio: number;
  };
  head: {
    /** 开头有多少秒几乎没有内容。 */
    silenceSec: number;
    /** 一上来就是满电平（没有前奏、直接从主歌/副歌起）。 */
    startsHot: boolean;
  };
}

/**
 * 分析用的帧长与步长（22050Hz 下约 46ms 一窗、11.6ms 一跳）。
 *
 * 跳长取 256 而不是 512：512 时 120 BPM 只有 21.5 帧/拍，取整造成的相位漂移能在十几拍里
 * 累积到半秒，自相关会锁到倍频（两拍对齐得更准）。256 时一拍约 43 帧，漂移小一个量级。
 */
const FRAME = 1024;
const HOP = 256;
/** 判定「有声」的门限：峰值帧能量的这一比例。低于它当静音。 */
const SILENCE_RATIO = 0.02;
/** 绝对下限：数字静音（全零）也要能判成静音。 */
const SILENCE_FLOOR = 1e-4;
/** BPM 搜索范围。 */
const MIN_BPM = 60;
const MAX_BPM = 200;
/** 拍点置信度低于这个数就当没测出来（≈ 随机情况下拍点能量占比）。 */
const MIN_CONFIDENCE = 0.25;

/**
 * 把解码后的 AudioBuffer 降成单声道、目标采样率的 Float32Array。
 *
 * 用「区间平均」而不是抽样：抽样会把高频混叠进拍点检测，区间平均天然带一点低通。
 * 对 3 分钟的歌这一步是 O(n)，几十毫秒，可以接受。
 */
export function downmixAndDownsample(
  source: {
    numberOfChannels: number;
    length: number;
    sampleRate: number;
    getChannelData(channel: number): Float32Array;
  },
  targetRate = 22_050,
): Float32Array {
  const channels = Math.max(1, source.numberOfChannels);
  const ratio = source.sampleRate / targetRate;
  const outLength = Math.max(1, Math.floor(source.length / ratio));
  const out = new Float32Array(outLength);
  const data: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) data.push(source.getChannelData(channel));
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(source.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const samples = data[channel] as Float32Array;
      for (let j = start; j < end; j += 1) sum += samples[j] ?? 0;
    }
    out[i] = sum / ((end - start) * channels);
  }
  return out;
}

/** 逐帧 RMS。 */
export function frameEnergy(samples: Float32Array): Float32Array {
  const frames = Math.max(1, Math.floor((samples.length - FRAME) / HOP) + 1);
  const energy = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * HOP;
    let sum = 0;
    for (let i = 0; i < FRAME; i += 1) {
      const value = samples[start + i] ?? 0;
      sum += value * value;
    }
    energy[frame] = Math.sqrt(sum / FRAME);
  }
  return energy;
}

/** onset 包络：帧能量的正差分（只留「变响」的瞬间）。 */
export function onsetEnvelope(energy: Float32Array): Float32Array {
  const onset = new Float32Array(energy.length);
  for (let i = 1; i < energy.length; i += 1) {
    onset[i] = Math.max(0, (energy[i] ?? 0) - (energy[i - 1] ?? 0));
  }
  return onset;
}

/**
 * 拍点检测：自相关找周期 + 相位投票定第一拍。
 *
 * 返回的 `confidence` 是「落在拍点上的 onset 能量占比」——随机信号大约 2/lag，
 * 有明确节拍的信号会高得多。调用方应该按置信度决定用不用它。
 */
export function detectBeat(
  onset: Float32Array,
  sampleRate: number,
): { bpm: number; offsetSec: number; periodSec: number; confidence: number } | null {
  const frameRate = sampleRate / HOP;
  const minLag = Math.max(2, Math.floor((frameRate * 60) / MAX_BPM));
  const maxLag = Math.ceil((frameRate * 60) / MIN_BPM);
  if (onset.length < maxLag * 2) return null;

  let bestLag = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  /*
   * 只算一阶自相关会锁到**倍频**：脉冲串在「两个拍」的间隔上同样相关，而分母
   * `onset.length - lag` 让长 lag 的分数偏高，于是 120 BPM 被报成 60。
   * 改成 comb 评分：把 lag、2×lag、3×lag 的相关按 1/k 加权求和——真正的拍周期在
   * 每一个整数倍上都有能量，倍频则缺了最短的那一项。
   */
  const scoreAt = (lag: number): number => {
    let total = 0;
    let count = 0;
    for (let k = 1; k <= 3; k += 1) {
      const step = lag * k;
      if (step >= onset.length) break;
      let sum = 0;
      for (let i = 0; i + step < onset.length; i += 1) sum += (onset[i] ?? 0) * (onset[i + step] ?? 0);
      total += sum / (onset.length - step) / k;
      count += 1;
    }
    return count > 0 ? total / count : 0;
  };
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const score = scoreAt(lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || bestScore <= 0) return null;

  /*
   * 折半：脉冲串在「两拍」和「一拍」的间隔上同样相关，所以上面选出的可能是倍频
   * （120 BPM 被报成 60）。只要一半的周期仍有接近的分数，就说明那才是真正的拍——
   * 音乐里的 BPM 约定取较快的那一档。邻域各试一帧，整数帧近似带来的相位误差在
   * 短窗口里比长窗口小。
   */
  const bestAround = (center: number): { lag: number; score: number } => {
    let best = { lag: center, score: scoreAt(center) };
    for (const lag of [center - 1, center + 1]) {
      if (lag < minLag || lag > maxLag) continue;
      const score = scoreAt(lag);
      if (score > best.score) best = { lag, score };
    }
    return best;
  };
  let picked = { lag: bestLag, score: bestScore };
  while (picked.lag > minLag) {
    const half = Math.round(picked.lag / 2);
    if (half < minLag) break;
    const candidate = bestAround(half);
    if (candidate.score >= picked.score * 0.6) picked = candidate;
    else break;
  }
  bestLag = picked.lag;

  // 相位：把 onset 按 lag 折叠，找能量最集中的那一格。
  let bestPhase = 0;
  let bestPhaseScore = Number.NEGATIVE_INFINITY;
  for (let phase = 0; phase < bestLag; phase += 1) {
    let sum = 0;
    for (let i = phase; i < onset.length; i += bestLag) sum += onset[i] ?? 0;
    if (sum > bestPhaseScore) {
      bestPhaseScore = sum;
      bestPhase = phase;
    }
  }

  // 置信度：拍点附近两帧内的 onset 能量占全部的比例。
  let onBeat = 0;
  let total = 0;
  for (let i = 0; i < onset.length; i += 1) {
    total += onset[i] ?? 0;
    const distance = (((i - bestPhase) % bestLag) + bestLag) % bestLag;
    if (distance <= 1 || distance >= bestLag - 1) onBeat += onset[i] ?? 0;
  }
  const confidence = total > 0 ? onBeat / total : 0;

  return {
    bpm: (60 * frameRate) / bestLag,
    offsetSec: bestPhase / frameRate,
    periodSec: bestLag / frameRate,
    confidence,
  };
}

/**
 * 分析主体。输入降采样后的单声道 PCM，输出 `TrackProfileCore`。
 *
 * `durationMs` 由调用方给（解码出来的时长），不从样本数推：有些容器带尾部填充。
 */
export function analyzeSamples(
  samples: Float32Array,
  sampleRate: number,
  durationMs: number,
): TrackProfileCore {
  const energy = frameEnergy(samples);
  const frames = energy.length;
  const frameMs = (HOP / sampleRate) * 1000;

  let peak = 0;
  for (const value of energy) peak = Math.max(peak, value);
  const threshold = Math.max(peak * SILENCE_RATIO, SILENCE_FLOOR);

  // 尾部静音：从后往前找最后一个有声帧。
  let lastActive = frames - 1;
  while (lastActive > 0 && (energy[lastActive] ?? 0) < threshold) lastActive -= 1;
  const tailSilenceSec = Math.max(0, (frames - 1 - lastActive) * frameMs) / 1000;

  // 头部静音：从前往后找第一个有声帧。
  let firstActive = 0;
  while (firstActive < frames - 1 && (energy[firstActive] ?? 0) < threshold) firstActive += 1;
  const headSilenceSec = (firstActive * frameMs) / 1000;

  // 「一上来就满电平」：前 2 秒的平均能量达到全曲平均的 1.4 倍。
  const headFrames = Math.max(1, Math.round(2000 / frameMs));
  let headSum = 0;
  for (let i = 0; i < Math.min(headFrames, frames); i += 1) headSum += energy[i] ?? 0;
  const headMean = headSum / Math.max(1, Math.min(headFrames, frames));
  let allSum = 0;
  for (const value of energy) allSum += value;
  const overallMean = allSum / Math.max(1, frames);
  const startsHot = overallMean > 0 && headMean > overallMean * 1.4;

  // 最后 15 秒的「有声比例」。
  const tailFrames = Math.min(frames, Math.round(15000 / frameMs));
  let activeFrames = 0;
  for (let i = frames - tailFrames; i < frames; i += 1) {
    if ((energy[i] ?? 0) >= threshold) activeFrames += 1;
  }
  const activityRatio = tailFrames > 0 ? activeFrames / tailFrames : 0;

  const beat = detectBeat(onsetEnvelope(energy), sampleRate);
  const usable = beat !== null && beat.confidence >= MIN_CONFIDENCE && beat.periodSec > 0;

  return {
    durationMs,
    bpm: usable ? Math.round(beat.bpm * 10) / 10 : null,
    beatOffsetSec: usable ? beat.offsetSec : null,
    beatPeriodSec: usable ? beat.periodSec : null,
    confidence: beat ? Math.round(beat.confidence * 1000) / 1000 : 0,
    tail: {
      silenceSec: Math.round(tailSilenceSec * 100) / 100,
      activityRatio: Math.round(activityRatio * 1000) / 1000,
    },
    head: {
      silenceSec: Math.round(headSilenceSec * 100) / 100,
      startsHot,
    },
  };
}

/** 帧率（帧/秒），给需要把时间换算成帧的下游用。 */
export function frameRateOf(sampleRate: number): number {
  return sampleRate / HOP;
}
