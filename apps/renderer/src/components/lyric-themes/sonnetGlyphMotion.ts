/**
 * 商籁逐字入场运动、色差（双副本）与半主角空心回声的**纯函数**求值。
 *
 * 算法与数值借鉴自 folia-major 的 sonnet 模块（AGPL-3.0）：
 * https://github.com/chthollyphile/folia-major
 * 出处：`sonnet/sonnetShotFrame.ts`（逐字入场、色差并入、回声包络）、
 * `sonnet/sonnetTextViewBuilder.ts`（色差副本的颜色/基准偏移/透明度、回声样式与法向）。
 * 本文件按本仓库风格独立实现，不复制上游源码正文。
 *
 * 三条语义：
 * 1. 没轮到的字 α = 0；入场从 `0.16` 起、落位到 1，落位后**不再变化**（没有退场）。
 * 2. 色差副本入场时分离最大，落位后只留 20% 的初始分离；透明度由字身透明度统一控制。
 * 3. 半主角回声是一次性的：沿版面法向分离，前 20% 线性升、后 80% 平方淡出，`p ≥ 1` 后彻底消失。
 *
 * 全部按**绝对时间**求值、没有累加状态 ⇒ 同一时刻反复求值逐值相同（seek 可重放）。
 */

import { easeSonnetInOut, resolveSegmentProgress, type SonnetShotKindName } from './sonnetMotion';
import type { SonnetSegmentRole } from './sonnetTypography';

/* 逐字入场（上游同一档的数值） */
export const SONNET_GLYPH_CORE_ALPHA_BASE = 0.16;
export const SONNET_GLYPH_CORE_ALPHA_RANGE = 0.84;
export const SONNET_GLYPH_HALO_ALPHA_DECAY = 0.28;
export const SONNET_GLYPH_SCALE_FLOOR = 0.86;
export const SONNET_GLYPH_SCALE_RANGE = 0.14;
export const SONNET_GLYPH_IMPACT_SCALE_FLOOR = 0.52;
export const SONNET_GLYPH_IMPACT_SCALE_RANGE = 0.48;
export const SONNET_GLYPH_HALO_SCALE_BASE = 1.08;
export const SONNET_GLYPH_HALO_SCALE_DECAY = 0.08;

/* 色差（青/红双副本）与半主角回声 */
export const SONNET_CA_OFFSET_EMPHASIS = 0.025;
export const SONNET_CA_OFFSET_BODY = 0.01;
export const SONNET_CA_COPY_ALPHA_EMPHASIS = 0.8;
export const SONNET_CA_COPY_ALPHA_BODY = 0.5;
/** 落位后保留的分离比例：`1 − 0.8 = 0.2`。 */
export const SONNET_CA_MERGE_RETAIN = 0.2;
export const SONNET_ECHO_MIN_DURATION = 0.4;
export const SONNET_ECHO_MAX_DURATION = 0.7;
export const SONNET_ECHO_DURATION_RATIO = 0.12;
export const SONNET_ECHO_DURATION_BIAS = 0.1;
/** 回声分离距离 = 字号 × 这个比例（再乘 `spread` 与层倍率）。 */
export const SONNET_ECHO_SPREAD_RATIO = 0.85;
export const SONNET_ECHO_LAYER_FACTORS = [1, 1.7] as const;
export const SONNET_ECHO_LAYER_ALPHAS = [0.3, 0.16] as const;

export interface SonnetGlyphMotionFrame {
  /** 入场进度 `p ∈ [0,1]`。 */
  readonly progress: number;
  readonly waiting: boolean;
  /** 字身透明度（未乘主题层的全局系数）。 */
  readonly alpha: number;
  readonly scale: number;
  readonly haloScale: number;
  readonly haloAlpha: number;
  readonly rotation: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** 色差副本当前的分离量（落位后 = 初始值的 20%）。 */
  readonly caOffset: number;
  /** 色差副本各自的透明度（强调 0.8 / 其余 0.5）。 */
  readonly caCopyAlpha: number;
  /** 回声时长（秒）与进度；`echoActive` 只在 `0 < p < 1` 且角色是半主角时为真。 */
  readonly echoDuration: number;
  readonly echoProgress: number;
  readonly echoActive: boolean;
  /** 两层回声的透明度（包络 × 0.3 / × 0.16）。 */
  readonly echoAlpha1: number;
  readonly echoAlpha2: number;
  /** 两层回声相对字心的位移（沿版面法向，已含方向、层倍率与 `spread`）。 */
  readonly echoOffset1X: number;
  readonly echoOffset1Y: number;
  readonly echoOffset2X: number;
  readonly echoOffset2Y: number;
}

export interface SonnetGlyphMotionInput {
  readonly startTime: number;
  readonly settleTime: number;
  readonly time: number;
  /** 版式角度（竖排、旋转块）。 */
  readonly finalRotation: number;
  readonly entryRotation: number;
  readonly enterX: number;
  readonly enterY: number;
  readonly emphasis: boolean;
  readonly shotKind: SonnetShotKindName;
  readonly role: SonnetSegmentRole;
  /** 实际使用的字号（色差基准偏移与回声距离都按它算）。 */
  readonly fontPx: number;
  /** 版面法向（wrapper 局部坐标的单位向量），见 `resolveSonnetLayoutNormal`。 */
  readonly normal: { readonly x: number; readonly y: number };
  /** 这一镜的时长（秒），回声时长按它算。 */
  readonly shotDuration: number;
  /** 回声的确定性左右侧（+1 / −1）。 */
  readonly echoSide: number;
  /** 入场位移倍率（主题的动画强度档）；缺省 1。 */
  readonly motion?: number;
}

/** 版面法向：横排取竖直方向、竖排取水平方向，再按版式角度转回 wrapper 局部坐标。 */
export function resolveSonnetLayoutNormal(
  vertical: boolean,
  rotation: number,
): { x: number; y: number } {
  const screenX = vertical ? 1 : 0;
  const screenY = vertical ? 0 : 1;
  const cosine = Math.cos(-rotation);
  const sine = Math.sin(-rotation);
  return {
    x: screenX * cosine - screenY * sine,
    y: screenX * sine + screenY * cosine,
  };
}

/** 半主角回声的时长：`min(0.7, max(0.4, 镜长 × 0.12 + 0.1))`。 */
export function resolveSonnetEchoDuration(shotDuration: number): number {
  return Math.min(
    SONNET_ECHO_MAX_DURATION,
    Math.max(
      SONNET_ECHO_MIN_DURATION,
      Math.max(0, shotDuration) * SONNET_ECHO_DURATION_RATIO + SONNET_ECHO_DURATION_BIAS,
    ),
  );
}

/** 回声包络：前 20% 线性升到 1，后 80% 平方衰减到 0；两端之外都是 0。 */
export function resolveSonnetEchoEnvelope(progress: number): number {
  if (progress <= 0 || progress >= 1) return 0;
  return progress <= 0.2 ? progress / 0.2 : Math.pow(1 - (progress - 0.2) / 0.8, 2);
}

export function resolveSonnetGlyphMotion(input: SonnetGlyphMotionInput): SonnetGlyphMotionFrame {
  const motion = input.motion ?? 1;
  const progress = resolveSegmentProgress(input.startTime, input.settleTime, input.time);
  const waiting = input.time < input.startTime;
  const offset = (1 - progress) * motion;
  const scale =
    input.emphasis && input.shotKind === 'type-impact'
      ? SONNET_GLYPH_IMPACT_SCALE_FLOOR + progress * SONNET_GLYPH_IMPACT_SCALE_RANGE
      : SONNET_GLYPH_SCALE_FLOOR + progress * SONNET_GLYPH_SCALE_RANGE;
  const coreAlpha = waiting
    ? 0
    : SONNET_GLYPH_CORE_ALPHA_BASE + progress * SONNET_GLYPH_CORE_ALPHA_RANGE;

  /* 色差：入场时分离最大，落位后收到 `SONNET_CA_MERGE_RETAIN`。 */
  const caBase =
    input.fontPx * (input.emphasis ? SONNET_CA_OFFSET_EMPHASIS : SONNET_CA_OFFSET_BODY);
  const caOffset = caBase * (1 - (1 - SONNET_CA_MERGE_RETAIN) * easeSonnetInOut(progress));

  /* 回声：只有半主角有；进度用**未缓动**的线性值。 */
  const echoDuration = resolveSonnetEchoDuration(input.shotDuration);
  const echoProgress = Math.min(1, Math.max(0, (input.time - input.startTime) / echoDuration));
  const echoActive = input.role === 'semi-hero' && echoProgress > 0 && echoProgress < 1;
  const envelope = echoActive ? resolveSonnetEchoEnvelope(echoProgress) : 0;
  /* 不在回声窗口里时把位移也归零：渲染层即使误用这些字段也画不出东西。 */
  const spread = echoActive
    ? input.fontPx * SONNET_ECHO_SPREAD_RATIO * (1 - Math.pow(1 - echoProgress, 3))
    : 0;
  const distance1 = spread * SONNET_ECHO_LAYER_FACTORS[0] * input.echoSide;
  const distance2 = spread * SONNET_ECHO_LAYER_FACTORS[1] * input.echoSide;

  return {
    progress,
    waiting,
    alpha: coreAlpha,
    scale,
    haloScale: scale * (SONNET_GLYPH_HALO_SCALE_BASE - progress * SONNET_GLYPH_HALO_SCALE_DECAY),
    haloAlpha: waiting ? 0 : 1 - progress * SONNET_GLYPH_HALO_ALPHA_DECAY,
    rotation: input.finalRotation + input.entryRotation * offset,
    offsetX: input.enterX * offset,
    offsetY: input.enterY * offset,
    caOffset,
    caCopyAlpha: input.emphasis ? SONNET_CA_COPY_ALPHA_EMPHASIS : SONNET_CA_COPY_ALPHA_BODY,
    echoDuration,
    echoProgress,
    echoActive,
    echoAlpha1: envelope * SONNET_ECHO_LAYER_ALPHAS[0],
    echoAlpha2: envelope * SONNET_ECHO_LAYER_ALPHAS[1],
    echoOffset1X: input.normal.x * distance1,
    echoOffset1Y: input.normal.y * distance1,
    echoOffset2X: input.normal.x * distance2,
    echoOffset2Y: input.normal.y * distance2,
  };
}
