/**
 * 封面取色 → 主题调色（用户 m08768 第 5 条：播放页沉浸式背景）。
 *
 * 数值与做法借鉴自 folia-major 的 `src/utils/builtinTheme/`（`coverPaletteAnalysis.ts` /
 * `generateBuiltinDualTheme.ts` / `themeColorRanges.ts` / `themeColorMath.ts`）：
 * 50×50 采样、贪婪挑互异色、加权中位切分、按权重随机的配色方案、背景色档（ink/tinted/rich）、
 * `coverWeight` 混合、以及 primary 9 / accent 3.2 / secondary 4.5 三档对比度下限与
 * 「每步 0.02、最多 50 步、朝远离背景亮度的方向」的调亮方式。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**：这里只借鉴它的**数值、结构与做法**，
 * **没有拷贝任何 folia 源码文本**，下面每个表达式都是在本仓库里按同一口径重写的。
 *
 * === 为什么取色可能失败（重要） ===
 * 网易云图片 CDN **不返回 CORS 头**，而生产环境页面是 `file://`（见 apps/desktop/src/main/index.ts
 * 的 loadFile 分支），所以 https 封面在 canvas 上必然被污染、`getImageData()` 抛 SecurityError。
 * 主进程取字节转 `blob:` 的方案（docs/PLAN.md §4.1）目前**还没有 IPC 通道**，本轮也不允许改
 * packages/ipc 与 apps/desktop，所以这里只能走渲染进程 canvas：
 * - 隐藏探针图**试一次** `crossOrigin='anonymous'`（CDN 支持 CORS 时就能取到色）；
 * - 取不到 / 抛错 / 全被过滤掉 → 老老实实返回空数组，由调用方回退中性色；
 * - 可见的模糊封面走的是**不带 crossOrigin** 的 `<img>`（见 ImmersiveBackground.tsx），
 *   所以那层永远不会因为这次探针失败而白掉。cover.ts 头注释里「不要硬试」说的是可见封面，
 *   与这里的隐藏探针不冲突。
 */

/** 采样画布边长（folia 把封面先画到 50×50 再取像素）。 */
const SAMPLE_SIZE = 50;
/** 采样步长：每 2px 取一个像素（50/2 = 25 × 25 = 625 个样本）。 */
const SAMPLE_STEP = 2;
/** 透明度低于这个值的像素直接丢掉（封面常见透明边）。 */
const MIN_ALPHA = 128;
/** 严格档：`saturation > 0.2` 且明度落在 `(30, 220)`（folia 的明度是 0..255 口径）。 */
const MIN_SATURATION = 0.2;
const MIN_LIGHTNESS = 30;
const MAX_LIGHTNESS = 220;
/**
 * 放松档的明度下界。父书原文只有「不够就放宽到 100 取回退」六个字，有两种读法：
 * ①把明度下界抬到 100、只留偏亮的像素；②把「100」当成采样数量上限。
 * 这里按 ① 实现（`l > 100`，同时去掉 220 的上界），因为 ② 对一张已经缩到 50×50 的图
 * 没有任何意义。这条读法差异在交接报告里已声明。
 */
const FALLBACK_MIN_LIGHTNESS = 100;
/** 互异色判定：RGB 欧氏距离要**大于**这个值，两个 swatch 才能同时留在调色板上。 */
const MIN_SWATCH_DISTANCE = 20;
/** 量化位移：每通道右移 4 位 → 16 档（folia 的 `QUANTIZATION_SHIFT`）。 */
const QUANTIZATION_SHIFT = 4;
/** 中位切分的目标色数：够铺一套主题；再多就都是同族近似色了。 */
const PALETTE_SIZE = 6;
/** 最终调色板上限（贪婪互异色 + 中位切分补充色）。 */
const MAX_PALETTE_SIZE = 8;

/** 主色之外，辅色（support）的最低饱和度门槛。 */
const SUPPORT_MIN_SATURATION = 0.15;
/** 辅色与主色的环形色相差必须落在这个闭区间里（太小是同一族，太大就跳到对面了）。 */
const SUPPORT_HUE_MIN = 25;
const SUPPORT_HUE_MAX = 160;

/** 强调色的色相抖动：`±(rand - 0.5) * 16` 度。 */
const ACCENT_JITTER_DEG = 16;
/** 背景色相的轻微漂移，让同一封面在不同歌上不至于完全雷同。 */
const BACKGROUND_HUE_DRIFT_DEG = 10;

/** 只有封面本身就几乎无彩（`baseSaturation < 0.18`）时才允许 monochrome 方案。 */
const MONOCHROME_MAX_SATURATION = 0.18;

/** 对比度下限（folia 的三档：正文最严，强调色最松）。 */
export const PRIMARY_MIN_CONTRAST = 9;
export const ACCENT_MIN_CONTRAST = 3.2;
export const SECONDARY_MIN_CONTRAST = 4.5;
/** 调亮/调暗的步长与步数上限（0.02 × 50 = 明度轴全程，够推到黑或白）。 */
const CONTRAST_STEP = 0.02;
const CONTRAST_MAX_STEPS = 50;
/** 背景亮度高于这个值就当「亮底」，前景色要往暗处推，否则往亮处推。 */
const DARK_FOREGROUND_LUMINANCE = 0.35;

/** 三个前景色的初始明度（真正的值由对比度循环推出来，这里只是起点）。 */
const PRIMARY_LIGHTNESS_DARK = 0.94;
const PRIMARY_LIGHTNESS_LIGHT = 0.14;
const ACCENT_LIGHTNESS_DARK = 0.64;
const ACCENT_LIGHTNESS_LIGHT = 0.45;
const SECONDARY_LIGHTNESS_DARK = 0.72;
const SECONDARY_LIGHTNESS_LIGHT = 0.38;
const PRIMARY_MAX_SATURATION = 0.22;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** 一份主题的四个颜色（组件再和歌词情绪合成完整契约，见 lyric-mood.ts）。 */
export interface ThemeColors {
  readonly backgroundColor: string;
  readonly primaryColor: string;
  readonly accentColor: string;
  readonly secondaryColor: string;
}

interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

interface Sample {
  readonly rgb: Rgb;
  readonly saturation: number;
}

interface Bucket {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly weight: number;
}

type ColorScheme =
  | 'duotone'
  | 'analogous'
  | 'complementary'
  | 'split'
  | 'triadic'
  | 'monochrome';

/** 配色方案权重（folia 是「按权重随机」挑一种）。 */
const SCHEME_WEIGHTS: Readonly<Record<ColorScheme, number>> = {
  duotone: 3,
  analogous: 3,
  complementary: 2,
  split: 1,
  triadic: 1,
  monochrome: 2,
};

/**
 * 背景色档（folia 的 `BACKGROUND_TONES`）：亮暗各有一组 `l` / `s` 区间。
 * `ink` 最暗最灰、`tinted` 居中、`rich` 最艳——封面越有颜色，越可能抽到 `rich`。
 */
const BACKGROUND_TONES = {
  ink: { dark: { l: [0.055, 0.085], s: [0.1, 0.22] }, light: { l: [0.94, 0.965], s: [0.05, 0.12] } },
  tinted: { dark: { l: [0.075, 0.11], s: [0.2, 0.36] }, light: { l: [0.92, 0.95], s: [0.1, 0.2] } },
  rich: { dark: { l: [0.095, 0.14], s: [0.32, 0.5] }, light: { l: [0.9, 0.935], s: [0.18, 0.3] } },
} as const;

type BackgroundTone = keyof typeof BACKGROUND_TONES;

const TONE_WEIGHTS: Readonly<Record<BackgroundTone, number>> = { ink: 34, tinted: 36, rich: 30 };

/** 取色结果缓存：同一张封面 URL 只探测一次（切歌来回切不会重复加载）。 */
const paletteCache = new Map<string, Promise<readonly Rgb[]>>();

/**
 * 种子随机数（mulberry32）。
 *
 * 为什么不用 `Math.random`：同一首歌每次渲染（切歌回来、窗口尺寸变化引起的重渲染）都必须
 * 铺出**一模一样**的几何图形，否则背景会「抖」。这个 9 行的小工具放在本模块，是因为取色
 * 最先用到它，audio-bands.ts 与 ImmersiveBackground.tsx 复用同一份实现。
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把两个整数搅成一个种子（`song.id` 派生，同名同曲稳定）。 */
export function hashSeed(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** HSL（h 度量、s/l 0..1）→ RGB。 */
function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const saturation = clamp01(s);
  const lightness = clamp01(l);
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / delta) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  return { h: ((h % 360) + 360) % 360, s, l };
}

function rgbToHex(rgb: Rgb): string {
  const channel = (value: number) =>
    Math.round(clampNumber(value, 0, 255)).toString(16).padStart(2, '0');
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

/** 两个色相的环形差（0..180）。 */
function hueDelta(a: number, b: number): number {
  const diff = Math.abs(((a - b) % 360) + 360) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function rgbDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/** WCAG 相对亮度。 */
function relativeLuminance(rgb: Rgb): number {
  const linear = (channel: number) => {
    const c = clampNumber(channel, 0, 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 把一个前景色沿明度轴推到对比度合规（folia 的 `themeColorMath`）。
 * 方向由**背景亮度**决定：背景亮（> 0.35）就往暗推，否则往亮推；每步 0.02、最多 50 步。
 * 推不到就返回走过的最后一个值——宁可稍微不达标，也不能让颜色变成 NaN 或抛错。
 */
function enforceContrast(color: Hsl, background: Rgb, minContrast: number): Rgb {
  const darken = relativeLuminance(background) > DARK_FOREGROUND_LUMINANCE;
  let lightness = color.l;
  for (let step = 0; step < CONTRAST_MAX_STEPS; step += 1) {
    const rgb = hslToRgb(color.h, color.s, lightness);
    if (contrastRatio(rgb, background) >= minContrast) return rgb;
    lightness = clamp01(darken ? lightness - CONTRAST_STEP : lightness + CONTRAST_STEP);
  }
  return hslToRgb(color.h, color.s, lightness);
}

/** 取不到封面时用的中性主题：不是纯灰——留一点冷色相，白底/暗底都不至于死板。 */
export function neutralThemeColors(dark: boolean): ThemeColors {
  return dark
    ? {
        backgroundColor: '#101418',
        primaryColor: '#e8eef6',
        accentColor: '#7aa2ff',
        secondaryColor: '#9fb3c8',
      }
    : {
        backgroundColor: '#f2f5fa',
        primaryColor: '#1a1d24',
        accentColor: '#2f6bff',
        secondaryColor: '#55617a',
      };
}

/**
 * 从封面 URL 取调色板。**永不 reject**：加载失败、跨源污染、一个像素都不合规，一律返回 `[]`，
 * 调用方据此回退中性色（绝不允许空白或抛错）。
 */
export function extractCoverPalette(url: string | undefined): Promise<readonly Rgb[]> {
  if (!url) return Promise.resolve([]);
  const cached = paletteCache.get(url);
  if (cached) return cached;
  const task = readCoverPalette(url).catch(() => [] as readonly Rgb[]);
  paletteCache.set(url, task);
  return task;
}

async function readCoverPalette(url: string): Promise<readonly Rgb[]> {
  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  let pixels: Uint8ClampedArray;
  try {
    // 跨源污染就是在这里抛 SecurityError —— 这是最可能的失败点，必须接住。
    pixels = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return [];
  }
  let samples = collectSamples(pixels, false);
  if (distinctSwatches(samples).length < 2) samples = collectSamples(pixels, true);
  const palette: Rgb[] = [];
  const push = (color: Rgb) => {
    if (palette.length >= MAX_PALETTE_SIZE) return;
    if (palette.every((picked) => rgbDistance(picked, color) > MIN_SWATCH_DISTANCE)) palette.push(color);
  };
  for (const color of distinctSwatches(samples)) push(color);
  for (const color of quantizeSwatches(samples)) push(color);
  return palette.length > 0 ? palette : quantizeSwatches(samples);
}

/** 隐藏探针：只在这里试一次 `crossOrigin`，失败就交给调用方回退中性色。 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cover palette probe failed: ${url}`));
    image.src = url;
  });
}

function collectSamples(pixels: Uint8ClampedArray, relaxed: boolean): Sample[] {
  const samples: Sample[] = [];
  for (let y = 0; y < SAMPLE_SIZE; y += SAMPLE_STEP) {
    for (let x = 0; x < SAMPLE_SIZE; x += SAMPLE_STEP) {
      const offset = (y * SAMPLE_SIZE + x) * 4;
      if ((pixels[offset + 3] ?? 0) < MIN_ALPHA) continue;
      const rgb: Rgb = { r: pixels[offset] ?? 0, g: pixels[offset + 1] ?? 0, b: pixels[offset + 2] ?? 0 };
      const hsl = rgbToHsl(rgb);
      const lightness255 = hsl.l * 255;
      if (relaxed) {
        if (lightness255 <= FALLBACK_MIN_LIGHTNESS) continue;
      } else if (hsl.s <= MIN_SATURATION || lightness255 <= MIN_LIGHTNESS || lightness255 >= MAX_LIGHTNESS) {
        continue;
      }
      samples.push({ rgb, saturation: hsl.s });
    }
  }
  return samples;
}

/** 按饱和度降序、贪婪挑「互相距离 > 20」的互异色（folia 的做法）。 */
function distinctSwatches(samples: readonly Sample[]): Rgb[] {
  const sorted = [...samples].sort((a, b) => b.saturation - a.saturation);
  const picked: Rgb[] = [];
  for (const sample of sorted) {
    if (picked.every((color) => rgbDistance(color, sample.rgb) > MIN_SWATCH_DISTANCE)) picked.push(sample.rgb);
  }
  return picked;
}

function buildBuckets(samples: readonly Sample[]): Bucket[] {
  const accumulator = new Map<number, { weight: number; sumR: number; sumG: number; sumB: number }>();
  for (const sample of samples) {
    const key =
      ((sample.rgb.r >> QUANTIZATION_SHIFT) << 8) |
      ((sample.rgb.g >> QUANTIZATION_SHIFT) << 4) |
      (sample.rgb.b >> QUANTIZATION_SHIFT);
    const entry = accumulator.get(key);
    if (entry) {
      entry.weight += 1;
      entry.sumR += sample.rgb.r;
      entry.sumG += sample.rgb.g;
      entry.sumB += sample.rgb.b;
    } else {
      accumulator.set(key, { weight: 1, sumR: sample.rgb.r, sumG: sample.rgb.g, sumB: sample.rgb.b });
    }
  }
  const buckets: Bucket[] = [];
  for (const entry of accumulator.values()) {
    buckets.push({
      r: entry.sumR / entry.weight,
      g: entry.sumG / entry.weight,
      b: entry.sumB / entry.weight,
      weight: entry.weight,
    });
  }
  return buckets;
}

/** 盒子里最宽的通道（中位切分永远沿最宽的那一维切）。 */
function widestChannel(box: readonly Bucket[]): { channel: 'r' | 'g' | 'b'; range: number } {
  let best: { channel: 'r' | 'g' | 'b'; range: number } = { channel: 'r', range: -1 };
  for (const channel of ['r', 'g', 'b'] as const) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const bucket of box) {
      if (bucket[channel] < min) min = bucket[channel];
      if (bucket[channel] > max) max = bucket[channel];
    }
    const range = max - min;
    if (range > best.range) best = { channel, range };
  }
  return best;
}

function averageColor(box: readonly Bucket[]): Rgb {
  let weight = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (const bucket of box) {
    weight += bucket.weight;
    sumR += bucket.r * bucket.weight;
    sumG += bucket.g * bucket.weight;
    sumB += bucket.b * bucket.weight;
  }
  const divisor = weight > 0 ? weight : 1;
  return { r: sumR / divisor, g: sumG / divisor, b: sumB / divisor };
}

/**
 * 加权中位切分（folia 的取法）：
 * 每轮挑「最宽通道范围 × √权重」最大的盒子，沿它的最宽通道排序后按**加权中点**切成两半，
 * 直到色数到 `PALETTE_SIZE`。箱子数有上限所以循环一定会停，不需要额外的收敛保护。
 */
function quantizeSwatches(samples: readonly Sample[]): Rgb[] {
  const buckets = buildBuckets(samples);
  if (buckets.length === 0) return [];
  let boxes: Bucket[][] = [buckets];
  while (boxes.length < PALETTE_SIZE) {
    let target = -1;
    let targetChannel: 'r' | 'g' | 'b' = 'r';
    let bestScore = 0;
    for (let index = 0; index < boxes.length; index += 1) {
      const box = boxes[index];
      if (!box || box.length < 2) continue;
      const widest = widestChannel(box);
      if (widest.range <= 0) continue;
      let weight = 0;
      for (const bucket of box) weight += bucket.weight;
      const score = widest.range * Math.sqrt(weight);
      if (score > bestScore) {
        bestScore = score;
        target = index;
        targetChannel = widest.channel;
      }
    }
    if (target < 0) break;
    const box = boxes[target];
    if (!box) break;
    const sorted = [...box].sort((a, b) => a[targetChannel] - b[targetChannel]);
    let total = 0;
    for (const bucket of sorted) total += bucket.weight;
    let accumulated = 0;
    let cut = 0;
    for (let index = 0; index < sorted.length; index += 1) {
      accumulated += sorted[index]?.weight ?? 0;
      if (accumulated >= total / 2) {
        cut = index + 1;
        break;
      }
    }
    if (cut <= 0 || cut >= sorted.length) cut = Math.max(1, Math.floor(sorted.length / 2));
    const left = sorted.slice(0, cut);
    const right = sorted.slice(cut);
    if (left.length === 0 || right.length === 0) break;
    boxes = [...boxes.slice(0, target), left, right, ...boxes.slice(target + 1)];
  }
  return boxes.map((box) => averageColor(box));
}

function pickScheme(rand: () => number, baseSaturation: number): ColorScheme {
  const candidates = (Object.keys(SCHEME_WEIGHTS) as ColorScheme[]).filter(
    (scheme) => scheme !== 'monochrome' || baseSaturation < MONOCHROME_MAX_SATURATION,
  );
  let total = 0;
  for (const scheme of candidates) total += SCHEME_WEIGHTS[scheme];
  let roll = rand() * total;
  for (const scheme of candidates) {
    roll -= SCHEME_WEIGHTS[scheme];
    if (roll <= 0) return scheme;
  }
  return candidates[candidates.length - 1] ?? 'duotone';
}

function schemeHues(
  scheme: ColorScheme,
  baseHue: number,
  supportHue: number | undefined,
  rand: () => number,
): { accent: number; secondary: number } {
  switch (scheme) {
    case 'analogous': {
      const spread = 20 + rand() * 15;
      const sign = rand() < 0.5 ? -1 : 1;
      return { accent: baseHue + spread * sign, secondary: baseHue - spread * sign };
    }
    case 'complementary':
      return { accent: baseHue + 150 + rand() * 30, secondary: supportHue ?? baseHue + 180 };
    case 'split':
      return { accent: baseHue + 150, secondary: baseHue + 210 };
    case 'triadic':
      return { accent: baseHue + 120, secondary: baseHue - 120 };
    case 'monochrome':
      return { accent: baseHue, secondary: baseHue };
    case 'duotone':
    default:
      return { accent: supportHue ?? baseHue + 180, secondary: baseHue };
  }
}

function pickTone(rand: () => number, baseSaturation: number): BackgroundTone {
  const tones = Object.keys(TONE_WEIGHTS) as BackgroundTone[];
  let total = 0;
  for (const tone of tones) total += toneWeight(tone, baseSaturation);
  let roll = rand() * total;
  for (const tone of tones) {
    roll -= toneWeight(tone, baseSaturation);
    if (roll <= 0) return tone;
  }
  return 'tinted';
}

/** 封面越有颜色，越可能抽到 `rich`（背景更舍得用彩色）。 */
function toneWeight(tone: BackgroundTone, baseSaturation: number): number {
  return tone === 'rich' ? TONE_WEIGHTS.rich * (0.5 + baseSaturation) : TONE_WEIGHTS[tone];
}

/**
 * 调色板 → 四个主题色。
 *
 * - 主色（base）：饱和度最高的 swatch（封面最有「颜色」的地方最能代表它的气质）；
 * - 辅色（support）：第一个 `s >= 0.15` 且与主色环形色相差在 [25, 160] 的 swatch；
 * - 配色方案、背景色档、明暗都由**种子随机**决定，所以同一首歌永远得到同一套色；
 * - `coverWeight = 0.55 + 0.45 * clamp01(baseSaturation / 0.7)` 决定封面颜色「洗」进背景多少；
 * - 最后按 primary 9 / accent 3.2 / secondary 4.5 推对比度。
 */
export function deriveThemeColors(swatches: readonly Rgb[], seed: number, dark: boolean): ThemeColors {
  if (swatches.length === 0) return neutralThemeColors(dark);
  const rand = mulberry32(hashSeed(seed, 0x7e11));
  const hslSwatches = swatches.map((rgb) => ({ rgb, hsl: rgbToHsl(rgb) }));
  const base =
    [...hslSwatches].sort((a, b) => b.hsl.s - a.hsl.s || b.hsl.l - a.hsl.l)[0] ?? hslSwatches[0];
  if (!base) return neutralThemeColors(dark);
  const baseHue = base.hsl.h;
  const baseSaturation = base.hsl.s;

  let support: Hsl | undefined;
  for (const swatch of hslSwatches) {
    if (swatch.hsl.s < SUPPORT_MIN_SATURATION) continue;
    const delta = hueDelta(swatch.hsl.h, baseHue);
    if (delta >= SUPPORT_HUE_MIN && delta <= SUPPORT_HUE_MAX) {
      support = swatch.hsl;
      break;
    }
  }

  const scheme = pickScheme(rand, baseSaturation);
  const hues = schemeHues(scheme, baseHue, support?.h, rand);
  const accentHue = hues.accent + (rand() - 0.5) * ACCENT_JITTER_DEG;

  // 主色越艳，背景越敢吃它的颜色（folia 的 coverWeight）。
  const coverWeight = 0.55 + 0.45 * clamp01(baseSaturation / 0.7);
  const tone = pickTone(rand, baseSaturation);
  const toneRange = BACKGROUND_TONES[tone][dark ? 'dark' : 'light'];
  const backgroundLightness = toneRange.l[0] + (toneRange.l[1] - toneRange.l[0]) * rand();
  const backgroundSaturation =
    (toneRange.s[0] + (toneRange.s[1] - toneRange.s[0]) * rand()) * (0.4 + 0.6 * coverWeight);
  const backgroundHue = baseHue + (rand() - 0.5) * BACKGROUND_HUE_DRIFT_DEG;

  const backgroundRgb = hslToRgb(backgroundHue, backgroundSaturation, backgroundLightness);
  const primary = enforceContrast(
    {
      h: baseHue,
      s: Math.min(baseSaturation, PRIMARY_MAX_SATURATION),
      l: dark ? PRIMARY_LIGHTNESS_DARK : PRIMARY_LIGHTNESS_LIGHT,
    },
    backgroundRgb,
    PRIMARY_MIN_CONTRAST,
  );
  const accent = enforceContrast(
    {
      h: accentHue,
      s: clampNumber(support?.s ?? baseSaturation, 0.35, 0.85),
      l: dark ? ACCENT_LIGHTNESS_DARK : ACCENT_LIGHTNESS_LIGHT,
    },
    backgroundRgb,
    ACCENT_MIN_CONTRAST,
  );
  const secondary = enforceContrast(
    {
      h: hues.secondary,
      s: clampNumber(baseSaturation * 0.7, 0.12, 0.5),
      l: dark ? SECONDARY_LIGHTNESS_DARK : SECONDARY_LIGHTNESS_LIGHT,
    },
    backgroundRgb,
    SECONDARY_MIN_CONTRAST,
  );

  return {
    backgroundColor: rgbToHex(backgroundRgb),
    primaryColor: rgbToHex(primary),
    accentColor: rgbToHex(accent),
    secondaryColor: rgbToHex(secondary),
  };
}
