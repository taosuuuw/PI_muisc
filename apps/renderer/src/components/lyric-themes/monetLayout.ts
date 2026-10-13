/**
 * 莫奈 = `monet`（folia-major 的 `src/components/visualizer/monet/`）的**纯几何与动效数值**。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**（`chthollyphile/folia-major@main`）。这里**只借鉴数值与做法**：
 * 下面每一条数值都能在 folia 的源码里找到出处（文件与量名写在各自注释里），
 * 但**每一个表达式都是在本仓库里重新写的**，没有拷贝任何 folia 源码文本。
 *
 * 与 folia 的结构差异（写清楚，免得以后拿它当 1:1）：
 * - folia 的画布是「左列（艺人 / 竖线 / 标题 / 专辑 / 歌词轨道 / 描述胶囊）+ 右列肖像 + 左下音频条」，
 *   这里的版式、字号公式、间距比例、扫光几何、辉光包络、装饰粒子分布**逐条对齐**；
 * - folia 用 framer-motion 的 spring 驱动滚动与缩放，这里用 CSS 过渡 + 一个 rAF 直接写
 *   `transform`（本仓库既有主题都不引 framer-motion），弹簧参数照样用它的 142/28/0.82 与 150/30/0.78；
 * - folia 的 `measureMonetLineLayout` 依赖 `@chenglou/pretext` 做精确富文本测量，我们**没有这个依赖**，
 *   换行行数改用 canvas `measureText` 逐字素累计估算（`estimateMonetWrappedLines`）；
 * - folia 的音频条读真实 AnalyserNode 频谱，本仓库没有 WebAudio（见 `lib/audio-bands.ts` 的说明），
 *   输入换成**伪能量派生的伪频谱**，但**形状算法（锚点表 / log 插值 / contour / 噪声底 / 幂压缩）
 *   与包络公式逐条照它的**。
 */

import { clamp } from './types';

/* ------------------------------------------------------------------ *
 * 数值表（folia: monet/monetLyricsModel.ts / monetLyricMotion.ts / AudioOverlay.tsx）
 * ------------------------------------------------------------------ */

/** 根字号（folia 用 `rem` 写上下限，再乘 `ROOT_FONT_PX` 换 px）。 */
export const MONET_ROOT_FONT_PX = 16;
/** 大屏整体缩放：低于 2xl 不缩放（folia: MONET_LARGE_SCREEN_MIN_PX）。 */
export const MONET_LARGE_SCREEN_MIN_PX = 1536;
export const MONET_LARGE_SCREEN_FULL_PX = 2200;
export const MONET_LARGE_SCREEN_MAX_SCALE = 1.16;
/** 行容器 / 肖像 / 轨道的基准尺寸（folia: MONET_ROW_BASE_MAX_WIDTH_PX 等）。 */
export const MONET_ROW_BASE_MAX_WIDTH_PX = 1520;
export const MONET_RAIL_BASE_MAX_WIDTH_PX = 780;
export const MONET_RAIL_BASE_MAX_HEIGHT_PX = 520;
export const MONET_PORTRAIT_BASE_MAX_PX = 430;
export const MONET_PORTRAIT_INNER_BASE_MAX_PX = 380;
/** 轨道至少要撑下几行（folia: MONET_RAIL_MIN_ROWS）。 */
export const MONET_RAIL_MIN_ROWS = 7;
/** 行间距：基准 px + 随字号的比例（folia: MONET_ACTIVE/INACTIVE_GAP_*）。 */
export const MONET_ACTIVE_GAP_PX = 18;
export const MONET_INACTIVE_GAP_PX = 14;
export const MONET_ACTIVE_GAP_RATIO = 0.49;
export const MONET_INACTIVE_GAP_RATIO = 0.38;
/** 当前句的纵向焦点（folia: `railHeight * 0.46`）。 */
export const MONET_FOCUS_CENTER_RATIO = 0.46;
/** 前后各留几行（folia: `before: 2, after: 2`）。 */
export const MONET_VISIBLE_BEFORE = 2;
export const MONET_VISIBLE_AFTER = 2;
/** 滚动 / 缩放弹簧（folia: monetLyricMotion.ts 的 MONET_SCROLL_SPRING / MONET_SCALE_SPRING）。 */
export const MONET_SCROLL_SPRING = { stiffness: 142, damping: 28, mass: 0.82 } as const;
export const MONET_SCALE_SPRING = { stiffness: 150, damping: 30, mass: 0.78 } as const;
/** 肖像交叉淡入（folia: MONET_PORTRAIT_FADE_MS，1 秒以内，和背景层的换图同一档）。 */
export const MONET_PORTRAIT_FADE_MS = 900;
export const MONET_PORTRAIT_MAX_LAYERS = 4;
/** 装饰粒子（folia: MonetFloatingDecor 的 PARTICLE_COUNT 与三条取模公式）。 */
export const MONET_DECOR_PARTICLE_COUNT = 10;
/** 音频条（folia: AudioOverlay 的 BAR_COUNT）。 */
export const MONET_AUDIO_BAR_COUNT = 72;
/** 动效强度：folia 用 `theme.animationIntensity === 'chaotic'` 决定肖像要不要一直飘。 */
export const MONET_PORTRAIT_FLOAT = {
  duration: 9,
  y: 18,
  x: 9,
  rotate: 1.2,
} as const;
/** 行进出场（folia: MonetRailLine 的 initial / exit）。 */
export const MONET_ENTER_OFFSET_PX = 34;
export const MONET_EXIT_OFFSET_PX = 38;
export const MONET_EXIT_MS = 200;

/* ------------------------------------------------------------------ *
 * 尺寸 / 字号
 * ------------------------------------------------------------------ */

/**
 * 大屏整体缩放系数（folia: `resolveMonetLargeScreenScale`）。
 *
 * 1536px 及以下恒为 1（所有既有窗口的版式一个像素都不动），到 2200px 线性升到 1.16。
 * 字号与左列宽共用这个系数，所以「列宽 : 字号」的比例不变 ⇒ 放大不会改变换行。
 */
export function resolveMonetLargeScreenScale(
  containerWidthPx: number,
  viewportWidthPx: number,
): number {
  const reference =
    containerWidthPx > 0 ? containerWidthPx : viewportWidthPx > 0 ? viewportWidthPx : 1280;
  if (reference <= MONET_LARGE_SCREEN_MIN_PX) return 1;
  const progress = Math.min(
    1,
    (reference - MONET_LARGE_SCREEN_MIN_PX) /
      (MONET_LARGE_SCREEN_FULL_PX - MONET_LARGE_SCREEN_MIN_PX),
  );
  return 1 + (MONET_LARGE_SCREEN_MAX_SCALE - 1) * progress;
}

/**
 * `clamp(minRem, preferredVw, maxRem)` 的 px 读数（folia: `resolveClampFontPx`）。
 *
 * 用**容器宽**而不是 `window.innerWidth`：播放页把舞台铺满整页，两者接近，但容器宽才是真的舞台宽
 * （预览框嵌在大屏里时也必须按自己的盒子缩放，而不是按显示器）。
 */
export function resolveMonetClampFontPx(
  minRem: number,
  preferredVw: number,
  maxRem: number,
  containerWidthPx: number,
): number {
  const reference = containerWidthPx > 0 ? containerWidthPx : 1280;
  return Math.min(
    maxRem * MONET_ROOT_FONT_PX,
    Math.max(minRem * MONET_ROOT_FONT_PX, reference * (preferredVw / 100)),
  );
}

/** 三档字号（folia: VisualizerMonet 里那三行 `resolveClampFontPx`）。 */
export function resolveMonetFontPx(
  containerWidthPx: number,
  fontScale: number,
  layoutScale: number,
): { readonly lyric: number; readonly inactive: number; readonly translation: number } {
  return {
    lyric: resolveMonetClampFontPx(1.34, 2.75, 2.28, containerWidthPx) * fontScale * layoutScale,
    inactive:
      resolveMonetClampFontPx(1.08, 2, 1.48, containerWidthPx) * fontScale * layoutScale,
    translation:
      resolveMonetClampFontPx(0.94, 1.28, 1.14, containerWidthPx) * fontScale * layoutScale,
  };
}

/* ------------------------------------------------------------------ *
 * 行状态与色调（folia: resolveLineTone / resolveMonetTone）
 * ------------------------------------------------------------------ */

export type MonetLineStatus = 'waiting' | 'active' | 'passed';

export interface MonetLineTone {
  readonly opacity: number;
  readonly scale: number;
  readonly blurPx: number;
  /** 常态墨色（folia 写的是 `primaryColor` 加一个 alpha）。 */
  readonly baseAlpha: number;
  readonly active: boolean;
  readonly zIndex: number;
}

/**
 * 一行该是什么样（folia: `resolveLineTone`，数值逐条对齐）：
 * - 当前句：`opacity 1 / scale 1 / blur 0`、常态墨色 alpha **0.34**、字重 600；
 * - 等待中的行：`opacity clamp(0.72-(d-1)*0.18, 0.36, 0.72)`、`scale clamp(inactive*0.9^(d-1), 0.68, 0.92)`、
 *   `blur d===1 ? 0.7 : 1.8+(d-2)*0.8`、墨色 alpha **0.46**；
 * - 唱过的行：`opacity clamp(0.52-(d-1)*0.12, 0.28, 0.52)`、`blur 1.1+(d-1)*0.7`、墨色 alpha **0.36`。
 */
export function resolveMonetLineTone(
  status: MonetLineStatus,
  offset: number,
  inactiveScale: number,
): MonetLineTone {
  if (status === 'active') {
    return { opacity: 1, scale: 1, blurPx: 0, baseAlpha: 0.34, active: true, zIndex: 4 };
  }
  const distance = Math.max(Math.abs(offset), 1);
  const waiting = status === 'waiting';
  return {
    opacity: waiting
      ? clamp(0.72 - (distance - 1) * 0.18, 0.36, 0.72)
      : clamp(0.52 - (distance - 1) * 0.12, 0.28, 0.52),
    scale: clamp(inactiveScale * 0.9 ** (distance - 1), 0.68, 0.92),
    blurPx: waiting
      ? distance === 1
        ? 0.7
        : 1.8 + (distance - 2) * 0.8
      : 1.1 + (distance - 1) * 0.7,
    baseAlpha: waiting ? 0.46 : 0.36,
    active: false,
    zIndex: waiting ? 3 - distance : 2 - distance,
  };
}

/** 非当前句的字号系数（folia: `clamp(inactiveFontPx / lyricFontPx, 0.72, 0.92)`）。 */
export function resolveMonetInactiveScale(
  inactiveFontPx: number,
  lyricFontPx: number,
): number {
  return clamp(inactiveFontPx / Math.max(lyricFontPx, 1), 0.72, 0.92);
}

/** 相邻两行之间的间距（folia: `resolveLineGap`）。 */
export function resolveMonetLineGap(
  previousActive: boolean,
  nextActive: boolean,
  lyricFontPx: number,
): number {
  return previousActive || nextActive
    ? Math.max(MONET_ACTIVE_GAP_PX, lyricFontPx * MONET_ACTIVE_GAP_RATIO)
    : Math.max(MONET_INACTIVE_GAP_PX, lyricFontPx * MONET_INACTIVE_GAP_RATIO);
}

/* ------------------------------------------------------------------ *
 * 轨道定位（folia: buildPositionedEntries）
 * ------------------------------------------------------------------ */

export interface MonetRailEntryHeight {
  /** 这一行缩放后的视觉高度（px）。 */
  readonly scaledHeightPx: number;
  readonly active: boolean;
}

/**
 * 把可见的几行摆到轨道上（folia: `buildPositionedEntries` 的两段循环）。
 *
 * 当前句的中心钉在 `railHeight * 0.46`，往下逐行 `前一行.y + 前一行高 + gap`，
 * 往上 `后一行.y - 本行高 - gap`。`anchorIndex` 是「offset === 0」那一行。
 */
export function positionMonetRailEntries(
  heights: readonly MonetRailEntryHeight[],
  railHeightPx: number,
  lyricFontPx: number,
): number[] {
  const count = heights.length;
  if (count === 0) return [];
  const anchorIndex = Math.max(
    0,
    heights.findIndex((entry) => entry.active),
  );
  const focusCenterY = railHeightPx * MONET_FOCUS_CENTER_RATIO;
  const positions = new Array<number>(count).fill(0);
  const anchorHeight = heights[anchorIndex]?.scaledHeightPx ?? 0;
  positions[anchorIndex] = focusCenterY - anchorHeight / 2;

  for (let index = anchorIndex + 1; index < count; index += 1) {
    const previous = heights[index - 1];
    const current = heights[index];
    if (previous === undefined || current === undefined) continue;
    positions[index] =
      (positions[index - 1] ?? 0) +
      previous.scaledHeightPx +
      resolveMonetLineGap(previous.active, current.active, lyricFontPx);
  }

  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const current = heights[index];
    const next = heights[index + 1];
    if (current === undefined || next === undefined) continue;
    positions[index] =
      (positions[index + 1] ?? 0) -
      current.scaledHeightPx -
      resolveMonetLineGap(current.active, next.active, lyricFontPx);
  }

  return positions;
}

/**
 * 轨道高度：`max(520 * layoutScale, 字号 * 1.18 * 7)`（folia: `railMaxHeightPx`）。
 * 外层再夹一道 `clamp(280px, 52vh, 它)`。
 */
export function resolveMonetRailHeightPx(lyricFontPx: number, layoutScale: number): number {
  return Math.round(
    Math.max(MONET_RAIL_BASE_MAX_HEIGHT_PX * layoutScale, lyricFontPx * 1.18 * MONET_RAIL_MIN_ROWS),
  );
}

/** 轨道宽度上限：`780 * layoutScale`（folia: `railMaxWidthPx`）。 */
export function resolveMonetRailWidthPx(layoutScale: number): number {
  return Math.round(MONET_RAIL_BASE_MAX_WIDTH_PX * layoutScale);
}

/* ------------------------------------------------------------------ *
 * 逐字扫光（folia: monetLyricMotion.resolveMonetFillWidth + MonetWordSweep 的 mask）
 * ------------------------------------------------------------------ */

/** 一行的逐字素累计宽度（`offsets[0] === 0`，`offsets[n]` 是整行宽）。 */
export function buildMonetGraphemeOffsets(
  widths: readonly number[],
): number[] {
  const offsets = new Array<number>(widths.length + 1).fill(0);
  let total = 0;
  for (let index = 0; index < widths.length; index += 1) {
    total += widths[index] ?? 0;
    offsets[index + 1] = total;
  }
  return offsets;
}

/**
 * 扫光前沿的宽度（folia: `resolveMonetFillWidth`，无逐字时间戳时的比例回退那一段）。
 *
 * 有逐字时间戳时 folia 会在字素之间线性插值；我们的 `StageLine` 每个字素本来就带
 * `startMs / endMs`，所以这里对**单个字素**求值，等价于它那段的插值。
 */
export function resolveMonetFillWidth(
  timeSec: number,
  startSec: number,
  endSec: number,
  fullWidthPx: number,
): number {
  if (timeSec <= startSec) return 0;
  if (timeSec >= endSec) return fullWidthPx;
  return fullWidthPx * ((timeSec - startSec) / Math.max(0.001, endSec - startSec));
}

/** 扫光边缘的柔和度（folia: `resolveMonetSweepEdgeSoftness` = `clamp(fontPx*0.45, 6, 16)`）。 */
export function resolveMonetSweepEdgeSoftness(fontPx: number): number {
  return Math.max(Math.min(fontPx * 0.45, 16), 6);
}

export interface MonetSweepGeometry {
  /** 完全不透明段的终点（px）。 */
  readonly solidEndPx: number;
  readonly featherStartPx: number;
  readonly featherEndPx: number;
}

/**
 * 扫光遮罩的四段式几何（folia: `MonetWordSweep` 的 `maskImage` useTransform）。
 *
 * `sweepEnd = filled + softness * progress`：让柔和的尾缘在词的结束时间刚好完全扫过它。
 * 遮罩写成 `linear-gradient(90deg, 黑 0, 黑 solidEnd, 0.92 黑 featherStart, 透明 featherEnd, 透明 100%)`。
 */
export function resolveMonetSweepGeometry(
  filledWidthPx: number,
  fullWidthPx: number,
  edgeSoftnessPx: number,
): MonetSweepGeometry {
  if (fullWidthPx <= 0) {
    return { solidEndPx: 0, featherStartPx: 0, featherEndPx: 0 };
  }
  const progress = clamp(filledWidthPx / fullWidthPx, 0, 1);
  const sweepEnd = filledWidthPx + edgeSoftnessPx * progress;
  return {
    solidEndPx: Math.max(sweepEnd - edgeSoftnessPx, 0),
    featherStartPx: Math.max(sweepEnd - edgeSoftnessPx * 0.55, 0),
    featherEndPx: Math.max(sweepEnd, 0),
  };
}

/** 把几何拼成 `mask-image` 字符串（folia 那一行模板，数值取自上面的几何）。 */
export function monetSweepMaskImage(geometry: MonetSweepGeometry): string {
  return (
    'linear-gradient(90deg, rgba(0, 0, 0, 1) 0px, ' +
    `rgba(0, 0, 0, 1) ${geometry.solidEndPx.toFixed(2)}px, ` +
    `rgba(0, 0, 0, 0.92) ${geometry.featherStartPx.toFixed(2)}px, ` +
    `rgba(0, 0, 0, 0) ${geometry.featherEndPx.toFixed(2)}px, ` +
    'rgba(0, 0, 0, 0) 100%)'
  );
}

/* ------------------------------------------------------------------ *
 * 辉光包络（folia: monetLyricMotion.resolveMonetGlow）
 * ------------------------------------------------------------------ */

const smoothstep = (value: number): number => value * value * (3 - 2 * value);

/**
 * 逐词辉光的绝对时间包络（folia: `resolveMonetGlow`）：
 * `rise = max(0.001, end-start) * 1.18` ⇒ `peak = start + rise`；
 * `tail = max(lineEnd, end + 1.05)`；上升与下降都用 smoothstep。
 */
export function resolveMonetGlow(
  timeSec: number,
  startSec: number,
  endSec: number,
  lineEndSec: number,
): number {
  if (timeSec <= startSec) return 0;
  const rise = Math.max(0.001, endSec - startSec) * 1.18;
  const peak = startSec + rise;
  const tail = Math.max(lineEndSec, endSec + 1.05);
  if (timeSec <= peak) {
    return smoothstep(clamp((timeSec - startSec) / rise, 0, 1));
  }
  return smoothstep(
    1 - clamp((timeSec - peak) / Math.max(0.18, tail - peak), 0, 1),
  );
}

/**
 * 辉光的两个半径（folia: `MonetWordSweep` 的 `radiusOne` / `radiusTwo`）。
 * 副歌那两档更大：0.45 / 0.90 倍字号，否则 0.28 / 0.65。
 */
export function resolveMonetGlowRadii(fontPx: number, isChorus: boolean): {
  readonly radiusOne: number;
  readonly radiusTwo: number;
  readonly maxAlpha: number;
} {
  return {
    radiusOne: Math.round(fontPx * (isChorus ? 0.45 : 0.28)),
    radiusTwo: Math.round(fontPx * (isChorus ? 0.9 : 0.65)),
    maxAlpha: isChorus ? 1 : 0.88,
  };
}

/* ------------------------------------------------------------------ *
 * 换行行数估算（替代 folia 的 pretext 测量）
 * ------------------------------------------------------------------ */

/**
 * 一行歌词按 `maxWidthPx` 会折成几行、最高一行多高。
 *
 * folia 用 `@chenglou/pretext` 的 `measureRichInlineStats(prepared, maxWidth)` 精确测量
 * （定时词是 `inline-block`，浏览器只能在词之间断行）。我们没这个依赖，所以用
 * `wordWidths`（调用方用 canvas 量好的每个**词**的宽度）做一次贪心折行：
 * 这是**估算**，不是测量 —— 只用来给轨道预留高度，量偏了最多多留或少留一点空隙。
 */
export function estimateMonetWrappedLines(
  wordWidths: readonly number[],
  maxWidthPx: number,
): number {
  const limit = Math.max(maxWidthPx, 1);
  let lines = 1;
  let cursor = 0;
  for (const width of wordWidths) {
    if (cursor > 0 && cursor + width > limit) {
      lines += 1;
      cursor = width;
    } else {
      cursor += width;
    }
  }
  return Math.max(lines, 1);
}

/* ------------------------------------------------------------------ *
 * 装饰粒子（folia: MonetFloatingDecor.buildParticles）
 * ------------------------------------------------------------------ */

export interface MonetDecorParticle {
  readonly id: number;
  readonly xPercent: number;
  readonly yPercent: number;
  readonly sizePx: number;
  readonly rotation: number;
  readonly durationSec: number;
  readonly delaySec: number;
  readonly opacity: number;
  readonly reverse: boolean;
}

/**
 * 那十个飘着的花瓣 / 图标（folia: `buildParticles`，公式逐条照抄）。
 * 确定性：同一份列表每次渲染得到同一组，不会每一帧乱跳。
 */
export function buildMonetDecorParticles(
  count: number = MONET_DECOR_PARTICLE_COUNT,
): MonetDecorParticle[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: index,
    xPercent: ((index * 127 + 43) % 80) + 10,
    yPercent: ((index * 211 + 17) % 80) + 5,
    sizePx: 46 + ((index * 53) % 40),
    rotation: (index * 97) % 360,
    durationSec: 20 + ((index * 71) % 20),
    delaySec: ((index * 41) % 80) / 10,
    opacity: 0.06 + ((index * 31) % 12) / 100,
    reverse: index % 2 === 0,
  }));
}

/* ------------------------------------------------------------------ *
 * 音频条形状（folia: AudioOverlay）
 * ------------------------------------------------------------------ */

/**
 * 五段频带 → 11 个锚点（folia: `buildSpectrumAnchors`，系数逐条照抄）。
 * 本仓库没有 AnalyserNode，`bands` 由 `pseudoMonetBands` 派生，但**形状算法一致**。
 */
export function buildMonetSpectrumAnchors(bands: readonly number[]): number[] {
  const bass = bands[0] ?? 0;
  const lowMid = bands[1] ?? 0;
  const mid = bands[2] ?? 0;
  const vocal = bands[3] ?? 0;
  const treble = bands[4] ?? 0;
  return [
    bass * 1.08,
    bass * 0.96,
    bass * 0.74 + lowMid * 0.26,
    lowMid,
    lowMid * 0.58 + mid * 0.42,
    mid,
    mid * 0.42 + vocal * 0.58,
    vocal,
    vocal * 0.48 + treble * 0.52,
    treble,
    treble * 0.82,
  ].map((value) => clamp(value, 0, 1));
}

/** 在锚点之间按 log 刻度插值，再叠一层 contour（folia: `sampleSpectrumProfile`）。 */
export function sampleMonetSpectrumProfile(
  bands: readonly number[],
  normalizedIndex: number,
): number {
  const index = clamp(normalizedIndex, 0, 1);
  const anchors = buildMonetSpectrumAnchors(bands);
  const logIndex = Math.log10(1 + index * 9);
  const scaled = logIndex * (anchors.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(lower + 1, anchors.length - 1);
  const interpolation = scaled - lower;
  const lowerValue = anchors[lower] ?? 0;
  const upperValue = anchors[upper] ?? lowerValue;
  const value = lowerValue + (upperValue - lowerValue) * interpolation;
  const contour =
    0.92 +
    Math.sin(index * Math.PI * 3.4 - Math.PI * 0.3) * 0.08 +
    Math.sin(index * Math.PI * 9.2 + Math.PI * 0.2) * 0.035;
  return clamp(value * contour, 0, 1);
}

/**
 * 伪频谱五段（0~1）。
 *
 * folia 读的是 AnalyserNode 的 bass / lowMid / mid / vocal / treble；本仓库没有 WebAudio
 * （`lib/audio-bands.ts` 有完整说明），所以这里拿**行级伪能量**（行越短、命中副歌越高）
 * 派生出五段，形状还是「低频 > 高频」的常规频谱斜率，音频条的轮廓因此仍然成立。
 * 确定性：同一个 `energy` + `seed` 永远同一组值。
 */
export function pseudoMonetBands(energy: number, seed: number): number[] {
  const base = clamp(energy, 0, 1);
  const tilt = [1.05, 0.98, 0.9, 0.82, 0.72];
  return tilt.map((factor, index) => {
    const jitter = Math.sin(seed * 0.7 + index * 2.399) * 0.5 + 0.5;
    return clamp(base * factor * (0.72 + jitter * 0.42), 0, 1);
  });
}

/** 单根柱子的高度（folia: 柱状模式那一行 `barHeight`，含 `envelope = sin(π·t)`）。 */
export function monetBarHeight(
  heightPx: number,
  normalizedIndex: number,
  bandValue: number,
  energy: number,
  pulse: number,
): number {
  const envelope = Math.sin(normalizedIndex * Math.PI);
  return heightPx * (0.02 + (energy * 0.04 + bandValue * 0.82 + pulse * 0.02) * envelope);
}
