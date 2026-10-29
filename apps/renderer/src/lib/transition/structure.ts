import { logMelSpectrogram } from './mel';

/**
 * 音乐结构段落检测（P4 补：真正的「段落对齐」）。
 *
 * 为什么需要它：拍网格只能保证「长度落在整小节」，但 DJ 式的混音点是**段落边界**——
 * 旧歌最后一个副歌结束、新歌副歌开始，两边在结构上对得上，才像人在打碟。只知道 BPM
 * 的话，很容易在「主歌中间」硬切。
 *
 * 做法是经典的「自相似矩阵 + novelty」：
 * 1. 把整首歌压成 0.5 秒一帧的 log-Mel 特征（50fps → 2fps）；
 * 2. 两两帧算余弦相似度，得到自相似矩阵（SSM）；
 * 3. 用「棋盘核」沿对角线滑动，找结构突变点（novelty 峰值）→ 段落边界；
 * 4. 段与段之间比平均特征，相似的归为同一类（A/B/A → A 出现两次）→ 重复段。
 *
 * 精度比不上专门的段落模型（如 All-in-One），但它不需要模型、跑一遍只要几百毫秒，
 * 足够回答「副歌大概从哪开始、到哪结束」。找不到重复段时如实返回少量段，
 * 调用方回退到原来的「提前 4 小节」策略。
 */
export interface Section {
  startSec: number;
  endSec: number;
  /** 同类段编号：相同编号表示这几段互为重复（A/B/A 里的两个 A）。 */
  classId: number;
}

export interface StructureResult {
  sections: Section[];
  /** 重复次数最多的类（通常就是副歌）；没有重复段时为 `null`。 */
  chorusClassId: number | null;
}

/** 特征池化到多长一帧（秒）。结构不需要高时间分辨率。 */
const POOL_SEC = 0.5;
/** 最短段落，太碎的边界直接并掉。 */
const MIN_SECTION_SEC = 4;
/** 两段算「同一类」的余弦相似度阈值。 */
const SAME_SECTION = 0.8;
/** novelty 峰值门限：均值 + 这个倍数 × 标准差。 */
const PEAK_K = 0.6;

/** 把 50fps 的 mel 谱池化成 2fps 的特征向量。 */
function poolFeatures(
  data: Float32Array,
  frames: number,
  bands: number,
): { vectors: Float32Array[]; frameRate: number } {
  const framesPerPool = Math.max(1, Math.round(POOL_SEC * (22_050 / 441)));
  const count = Math.max(1, Math.floor(frames / framesPerPool));
  const vectors: Float32Array[] = [];
  for (let pool = 0; pool < count; pool += 1) {
    const vector = new Float32Array(bands);
    const from = pool * framesPerPool;
    const to = Math.min(frames, from + framesPerPool);
    for (let frame = from; frame < to; frame += 1) {
      for (let band = 0; band < bands; band += 1) {
        vector[band] = (vector[band] as number) + (data[frame * bands + band] ?? 0);
      }
    }
    // 归一化：结构比对的是「音色分布长得像不像」，不是音量大小。
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let band = 0; band < bands; band += 1) vector[band] = (vector[band] as number) / norm;
    vectors.push(vector);
  }
  return { vectors, frameRate: 1 / POOL_SEC };
}

function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/** 自相似矩阵（对称，只算上三角）。 */
function selfSimilarity(vectors: Float32Array[]): Float32Array[] {
  const n = vectors.length;
  const matrix: Float32Array[] = Array.from({ length: n }, () => new Float32Array(n));
  for (let i = 0; i < n; i += 1) {
    for (let j = i; j < n; j += 1) {
      const value = cosine(vectors[i] as Float32Array, vectors[j] as Float32Array);
      (matrix[i] as Float32Array)[j] = value;
      (matrix[j] as Float32Array)[i] = value;
    }
  }
  return matrix;
}

/**
 * novelty：棋盘核沿对角线滑动。
 *
 * 直觉是「左边像左边、右边像右边，但左右之间不像」——那正是一个段落边界；
 * 段落内部则是四块都像。
 */
function noveltyCurve(ssm: Float32Array[], window: number): Float32Array {
  const n = ssm.length;
  const curve = new Float32Array(n);
  for (let i = window; i < n - window; i += 1) {
    let sum = 0;
    for (let a = 1; a <= window; a += 1) {
      for (let b = 1; b <= window; b += 1) {
        const same = (ssm[i - a] as Float32Array)[i - b] as number;
        const cross = (ssm[i - a] as Float32Array)[i + b] as number;
        const cross2 = (ssm[i + a] as Float32Array)[i - b] as number;
        const same2 = (ssm[i + a] as Float32Array)[i + b] as number;
        sum += same + same2 - cross - cross2;
      }
    }
    curve[i] = sum / (window * window * 4);
  }
  return curve;
}

/** 找 novelty 的局部峰值，并强制最小段长。 */
function findBoundaries(curve: Float32Array, minGap: number): number[] {
  let mean = 0;
  for (const value of curve) mean += value;
  mean /= Math.max(1, curve.length);
  let variance = 0;
  for (const value of curve) variance += (value - mean) ** 2;
  const std = Math.sqrt(variance / Math.max(1, curve.length));
  // 下限：曲线几乎全平时（例如整首一个音色），std 接近 0，不给下限就会「处处是峰」。
  const threshold = Math.max(mean + PEAK_K * std, Math.max(1e-4, mean * 0.15));

  const candidates: number[] = [];
  for (let i = 1; i < curve.length - 1; i += 1) {
    const value = curve[i] as number;
    if (value < threshold) continue;
    if (value < (curve[i - 1] as number) || value < (curve[i + 1] as number)) continue;
    candidates.push(i);
  }
  // 贪心去重：按强度从大到小保留，间隔不小于 minGap。
  candidates.sort((a, b) => (curve[b] as number) - (curve[a] as number));
  const kept: number[] = [];
  for (const index of candidates) {
    if (kept.every((other) => Math.abs(other - index) >= minGap)) kept.push(index);
  }
  kept.sort((a, b) => a - b);
  return kept;
}

/**
 * 检测段落。
 *
 * `durationSec` 用来给最后一段收尾（特征帧可能比实际时长略短）。
 */
export function detectSections(
  samples: Float32Array,
  durationSec: number,
): StructureResult {
  const { data, frames, bands } = logMelSpectrogram(samples);
  if (frames < 40 || durationSec <= 0) return { sections: [], chorusClassId: null };

  // 全静音（或近乎全静音）：SSM 全是 0，novelty 区分不出任何东西，
  // 不拦的话「所有点都是局部最大」会切出一堆假段落。
  let energy = 0;
  for (const value of data) energy = Math.max(energy, value);
  if (energy < 1e-6) return { sections: [], chorusClassId: null };

  const { vectors } = poolFeatures(data, frames, bands);
  if (vectors.length < 8) return { sections: [], chorusClassId: null };

  const ssm = selfSimilarity(vectors);
  const window = Math.max(2, Math.round(2 / POOL_SEC)); // 2 秒
  const curve = noveltyCurve(ssm, window);
  const minGap = Math.max(2, Math.round(MIN_SECTION_SEC / POOL_SEC));
  const boundaries = findBoundaries(curve, minGap);

  // 拼成段落（首尾补上 0 与总时长）。
  const edges = [0, ...boundaries, vectors.length];
  const sections: Section[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const start = edges[i] as number;
    const end = edges[i + 1] as number;
    if (end <= start) continue;
    sections.push({
      startSec: start * POOL_SEC,
      endSec: i === edges.length - 2 ? durationSec : end * POOL_SEC,
      classId: -1,
    });
  }
  if (sections.length === 0) return { sections: [], chorusClassId: null };

  // 段间相似度 → 贪心聚类（A/B/A 里的两个 A 会被归到同一类）。
  const segmentVectors = sections.map((section, index) => {
    const from = Math.floor(section.startSec / POOL_SEC);
    const to = Math.min(vectors.length, Math.ceil(section.endSec / POOL_SEC));
    const mean = new Float32Array(bands);
    let count = 0;
    for (let frame = from; frame < to; frame += 1) {
      const vector = vectors[frame];
      if (!vector) continue;
      for (let band = 0; band < bands; band += 1) mean[band] = (mean[band] as number) + (vector[band] as number);
      count += 1;
    }
    if (count > 0) for (let band = 0; band < bands; band += 1) mean[band] = (mean[band] as number) / count;
    return { mean, index };
  });

  let nextClass = 0;
  for (const entry of segmentVectors) {
    const existing = sections.find((section) => section.classId >= 0);
    if (!existing) {
      sections[entry.index]!.classId = nextClass;
      nextClass += 1;
      continue;
    }
    // 与已有各类的代表段比相似度，取最像的。
    let bestClass = -1;
    let bestScore = SAME_SECTION;
    for (let classId = 0; classId < nextClass; classId += 1) {
      const representative = segmentVectors.find(
        (candidate) => sections[candidate.index]?.classId === classId,
      );
      if (!representative) continue;
      const score = cosine(entry.mean, representative.mean);
      if (score > bestScore) {
        bestScore = score;
        bestClass = classId;
      }
    }
    if (bestClass >= 0) {
      sections[entry.index]!.classId = bestClass;
    } else {
      sections[entry.index]!.classId = nextClass;
      nextClass += 1;
    }
  }

  // 重复次数最多的类 = 副歌候选；只出现一次的（intro/outro 常是这样）不算。
  const counts = new Map<number, number>();
  for (const section of sections) counts.set(section.classId, (counts.get(section.classId) ?? 0) + 1);
  let chorusClassId: number | null = null;
  let bestCount = 1;
  for (const [classId, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      chorusClassId = classId;
    }
  }

  return { sections, chorusClassId };
}
