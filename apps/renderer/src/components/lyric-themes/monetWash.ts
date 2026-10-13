/**
 * 莫奈底色的「明暗定向」规则（照抄上游 `monetBackgroundPipeline.ts:23~40`，第 218 轮补上）。
 *
 * 上游那份 361 行的背景管线会**生成并缓存一张 1920×1080 的静态海报背景图**。
 * **状态更新（第 278~282 轮）**：主人已拍板"整条 Canvas 管线搬过来"，所以本文件**不再只是"一条规则"**——
 * 它同时承载那条规则的**逐像素用法**（`resolveMonetWashColor`）、overlay 的透明度与条纹位置；
 * 真正的 canvas 层在 `monetBackground.ts`。
 * ~~（早先的注释写"我们这侧是 CSS 渐变"——那已被推翻：wash 是逐像素映射，CSS 渐变无法等价。）~~
 *
 * 本文件里那条核心规则：
 *
 * > 按**相对亮度**把两个颜色里暗的那个当 `shadow`、亮的当 `highlight`。
 *
 * 否则深色封面遇上浅色主题时，渐变会"倒过来"，看起来像贴错了一层 —— 这是可感的差异，
 * 不只是实现细节。
 */

import { parseRgb, resolveCssColor } from './types';

/** 一个 RGB 三通道（0~255）。 */
export interface MonetRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * 把一个可能是**CSS 变量链**的颜色落成 `MonetRgb`（拿不到就给兜底）。
 *
 * 用仓库里那套惯用法（见 `CadenzaTheme.tsx:1345` / `FumeTheme.tsx:1905`）：
 * **先 `parseRgb` 试解析，失败再用 `resolveCssColor` 让元素把 `var(...)` 落成计算色**。
 * 直接 parse 一个 `var()` 链会失败 —— 这个坑在临时记忆里挂过一条，别再踩。
 */
export const toMonetRgb = (
  value: string,
  root: HTMLElement | null,
  fallback: MonetRgb = MONET_FALLBACK_DARK,
): MonetRgb => {
  const direct = parseRgb(value);
  const parsed = direct ?? parseRgb(resolveCssColor(root, value));
  if (parsed === null) return fallback;
  const channels = parsed as { r?: number; g?: number; b?: number };
  return {
    r: typeof channels.r === 'number' ? channels.r : fallback.r,
    g: typeof channels.g === 'number' ? channels.g : fallback.g,
    b: typeof channels.b === 'number' ? channels.b : fallback.b,
  };
};

/** 兜底色（上游 `:23~24`）：拿不到封面色时用它俩。 */
export const MONET_FALLBACK_DARK: MonetRgb = { r: 10, g: 10, b: 12 };
export const MONET_FALLBACK_LIGHT: MonetRgb = { r: 245, g: 245, b: 245 };

/** 相对亮度（Rec.709 权重，上游同口径 `:28`）。 */
export const monetRelativeLuminance = (color: MonetRgb): number =>
  0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

/**
 * 决定"谁当 shadow、谁当 highlight"：**暗的当 shadow、亮的当 highlight**。
 *
 * 亮度相等时按传入顺序（background 当 shadow）—— 上游的 `<=` 就是这个意思。
 */
export const resolveMonetWashEndpoints = (
  background: MonetRgb,
  primary: MonetRgb,
): { shadow: MonetRgb; highlight: MonetRgb } =>
  monetRelativeLuminance(background) <= monetRelativeLuminance(primary)
    ? { shadow: background, highlight: primary }
    : { shadow: primary, highlight: background };

const rgbCss = (color: MonetRgb): string =>
  `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;

/**
 * 一步给出**可以直接挂到 style 上的两个 CSS 变量值**（省得主题端写多行、也就少一处出错的地方）。
 *
 * `root` 传**真实元素**（`rootRef.current`）——`var(...)` 链要靠它落色，传 `null` 会静默退到兜底色。
 */
export const resolveMonetWashCssVars = (
  surface: string,
  primary: string,
  root: HTMLElement | null,
): { shadow: string; highlight: string } => {
  const wash = resolveMonetWashEndpoints(
    toMonetRgb(surface, root, MONET_FALLBACK_DARK),
    toMonetRgb(primary, root, MONET_FALLBACK_LIGHT),
  );
  return { shadow: rgbCss(wash.shadow), highlight: rgbCss(wash.highlight) };
};

/* ==================== 上游 `monetBackgroundPipeline` 里"不需要 DOM"的那部分 ==================== */
/*
 * 上游那 361 行里，**逐像素 wash** 是整套做法的核心：它不是"一张渐变图"，而是
 * **把每个像素自己的归一化亮度映射成一个颜色**（`resolveWashColor`）⇒
 * **CSS 渐变在数学上不可能等价**（这也是主人拍板"整条 Canvas 管线搬过来"的原因）。
 * 下面把那部分**不依赖 DOM 的数学**单独落地；画布层（取图 / 像素循环 / toDataURL / 缓存）另做，
 * 免得把可测逻辑埋进 canvas 里。
 */

/** 两段插值的中点（上游 `resolveWashColor` 里的 `0.55`）。 */
export const MONET_WASH_MIDPOINT = 0.55;

/** 两个 `MonetRgb` 按比例混合（上游 `mix`；返回浮点通道，取整发生在写回像素时）。 */
const mixRgb = (from: MonetRgb, to: MonetRgb, amount: number): MonetRgb => ({
  r: from.r + (to.r - from.r) * amount,
  g: from.g + (to.g - from.g) * amount,
  b: from.b + (to.b - from.b) * amount,
});

/**
 * 逐像素 wash 映射（照抄上游 `monetBackgroundPipeline.ts:118~140`）：
 * 先按亮度把 `background`/`primary` 排成 shadow/highlight（＝本文件第 56~67 行那条规则），然后
 * `t ≤ 0.55` ⇒ `mix(shadow → accent, t / 0.55)`；`t > 0.55` ⇒ `mix(accent → highlight, (t − 0.55) / 0.45)`。
 *
 * `t` 是**该像素自己的**归一化亮度（`clamp(luminance / 255, 0, 1)`）；函数内再夹一次 0~1。
 */
export const resolveMonetWashColor = (
  normalizedLuminance: number,
  background: MonetRgb,
  accent: MonetRgb,
  primary: MonetRgb,
): MonetRgb => {
  const { shadow, highlight } = resolveMonetWashEndpoints(background, primary);
  const t = Math.min(1, Math.max(0, normalizedLuminance));
  if (t <= MONET_WASH_MIDPOINT) return mixRgb(shadow, accent, t / MONET_WASH_MIDPOINT);
  return mixRgb(accent, highlight, (t - MONET_WASH_MIDPOINT) / (1 - MONET_WASH_MIDPOINT));
};

/** overlay 对角渐变的三个停靠（上游 `paintMonetOverlay` 第一层，`:211~214`）。 */
export const MONET_OVERLAY_STOPS = [
  { offset: 0, channel: 'accent', base: 0.08, gain: 0.62 },
  { offset: 0.44, channel: 'background', base: 0.16, gain: 0.58 },
  { offset: 1, channel: 'primary', base: 0.06, gain: 0.36 },
] as const;

/** 某个停靠在给定 overlay 强度下的透明度：`base + overlay × gain`，夹 0~1。 */
export const resolveMonetOverlayAlpha = (base: number, gain: number, overlay: number): number => {
  const o = Math.min(1, Math.max(0, overlay));
  return Math.min(1, Math.max(0, base + o * gain));
};

/** 条纹根数（上游 `for index < 18`，`:235`）。 */
export const MONET_STREAK_COUNT = 18;

export interface MonetStreak {
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

/**
 * 条纹位置（照抄上游 `:235~239` 的**取模伪随机** —— 无 RNG，所以可复现）：
 * `x = (i×127) % width`、`y = ((i×211) % height) − 40`、高 `height × 0.28`。
 */
export const resolveMonetStreaks = (width: number, height: number): MonetStreak[] =>
  Array.from({ length: MONET_STREAK_COUNT }, (_, index) => ({
    x: (index * 127) % width,
    y: ((index * 211) % height) - 40,
    height: height * 0.28,
  }));
