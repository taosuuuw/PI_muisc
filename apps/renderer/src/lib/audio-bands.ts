/**
 * 「音频能量」这一层（用户 m08768 第 5 条）。
 *
 * === 结论：我们没有接 WebAudio，这里是伪能量 ===
 *
 * folia-major 的浮层缩放由 AnalyserNode 的实时频谱驱动。PI 这里**故意不接**，硬证据两条：
 * 1. 播放用的 `<audio>` 是 `lib/audio-engine.ts` 里的单例 `new Audio()`，**不设 crossOrigin**；
 *    它加载的地址是主进程的本地媒体服务器 `http://127.0.0.1:<port>/audio/<key>?t=<token>`
 *    （apps/desktop/src/main/media-server.ts），而该服务器的转发响应头白名单里**没有
 *    `access-control-allow-origin`** —— 也就是说这是一份「跨源且无 CORS」的媒体。
 * 2. `MediaElementAudioSourceNode` / `captureStream()` 对无 CORS 的跨源媒体会输出**零样本**：
 *    一旦接上，波形全是 0（更糟的是有些实现会让播放直接变哑），而我们要的是背景，不是播放器本身。
 * 另外全仓目前**没有任何 AudioContext**，接进来还要处理「context suspended → 首次用户手势才能 resume」
 * 的时序问题，收益与风险完全不成比例。
 *
 * 所以：能量改由**行时长 + 副歌标记 + 按 song.id 派生的种子抖动**驱动（0~1，行级粒度），
 * 平滑交给 CSS 过渡（0.9s），不新增任何每帧计算。宁可少一个效果，也不能影响播放。
 *
 * === folia 的规格（只作为记录，不参与运行） ===
 * 如果将来主进程给音频加了 CORS 头（或在同一台服务器上返回 `Access-Control-Allow-Origin`），
 * 按下面这份规格接就是对齐的。folia-major 是 **AGPL-3.0**：这里只记数值与思路，
 * **没有拷贝任何 folia 源码文本**。
 */

import type { LyricLine } from '@pi/shared';

import { hashSeed, mulberry32 } from './cover-palette';

/** folia 的分析器口径：接的时候照这张表填，不用再回去翻它的源码。 */
export const FOLIA_ANALYSER_SPEC = {
  /** 1024 点 FFT，bin ≈ 21.5Hz。 */
  fftSize: 1024,
  binHz: 21.5,
  /** 五段频带（Hz，闭区间）。 */
  bands: {
    bass: [20, 150],
    lowMid: [150, 400],
    mid: [400, 1200],
    vocal: [1000, 3500],
    treble: [3500, 12000],
  },
  /** 频带值的非线性提升：`process(v, boost) = (v / 255) ** boost * 255`。 */
  processBoost: 3,
  /** 能量取 bass 与 lowMid 的均值再过一次 process。 */
  audioPowerExpression: 'process((bass + lowMid) / 2, 3)',
  /** 平滑：一阶低通系数约 0.1（或 spring stiffness 300 / damping 30）。 */
  smoothingAlpha: 0.1,
  spring: { stiffness: 300, damping: 30 },
  /** 形状缩放：输入 [10, 200] → 输出 [0.95, 1.45]。 */
  shapeScaleInput: [10, 200],
  shapeScaleOutput: [0.95, 1.45],
} as const;

/** 行时长会被夹在这个区间里算能量（太短/太长的行都不该把背景甩飞）。 */
const MIN_LINE_MS = 400;
const MAX_LINE_MS = 12000;
/** 最后一行没有「下一行」可以减，给个兜底行时长。 */
const LAST_LINE_FALLBACK_MS = 4000;
/** 能量公式：底噪 + 快节奏加成 + 副歌加成 + 种子抖动，最后夹到 0~1。 */
const BASE_ENERGY = 0.3;
const SHORT_LINE_BONUS = 0.25;
const CHORUS_BONUS = 0.35;
const JITTER = 0.12;
/** 形状缩放（对齐 folia 的 [10,200] → [0.95,1.45]，只是把输入压到 0~1）。 */
const SHAPE_SCALE_MIN = 0.95;
const SHAPE_SCALE_RANGE = 0.5;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 这一行唱多久（`下一行.timeMs - 本行.timeMs`，最后一行的兜底是 4s）。 */
export function lineDurationMs(
  lines: readonly LyricLine[],
  index: number,
  fallbackMs: number = LAST_LINE_FALLBACK_MS,
): number {
  const line = lines[index];
  if (!line) return fallbackMs;
  const next = lines[index + 1];
  if (!next) return fallbackMs;
  const duration = next.timeMs - line.timeMs;
  return duration > 0 ? clampNumber(duration, MIN_LINE_MS, MAX_LINE_MS) : fallbackMs;
}

export interface PseudoEnergyInput {
  readonly lines: readonly LyricLine[];
  /** 当前唱到第几行（-1 表示还没开始）。 */
  readonly index: number;
  /** `detectChorus` 的结果：副歌行更亮更活跃一点。 */
  readonly chorus: ReadonlySet<number>;
  /** `song.id` 派生的种子：同一首歌每次渲染得到同一条能量曲线。 */
  readonly seed: number;
}

/**
 * 伪能量（0~1）。确定性：同一个 `seed + index + lines` 永远得到同一个值。
 * 行越短（唱得越快）、命中副歌，能量越高；再叠一点种子抖动，免得每行都落在同一个数上。
 * 接上真频谱之前，这就是形状缩放的输入。
 */
export function pseudoEnergy({ lines, index, chorus, seed }: PseudoEnergyInput): number {
  const duration = lineDurationMs(lines, index);
  const shortness = clamp01(1 - duration / MAX_LINE_MS);
  const rand = mulberry32(hashSeed(seed, index + 1));
  const jitter = (rand() - 0.5) * 2 * JITTER;
  const chorusBonus = chorus.has(index) ? CHORUS_BONUS : 0;
  return clamp01(BASE_ENERGY + shortness * SHORT_LINE_BONUS + chorusBonus + jitter);
}

/** 能量 0~1 → 形状缩放 0.95~1.45（folia 的 `shapeScaleOutput`）。 */
export function energyToScale(power: number): number {
  return SHAPE_SCALE_MIN + clamp01(power) * SHAPE_SCALE_RANGE;
}
