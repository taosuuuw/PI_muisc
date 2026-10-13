/**
 * 莫奈背景管线（照抄上游 `monetBackgroundPipeline.ts` 的做法，第 281 轮动工）。
 *
 * **上游做的是什么**：生成并缓存一张 `1920×1080` 的静态海报背景图 ——
 * 铺底色 → 画封面（cover 裁切，可选 blur）→ **逐像素**做灰度/饱和度/wash → 叠四层 overlay
 * → `toDataURL('image/jpeg', 0.92)`；缓存键是「输入内容的 JSON」。
 *
 * **为什么必须画布、不能 CSS**：wash 是**逐像素的「亮度 → 颜色」映射**
 * （`resolveMonetWashColor`），不是一张固定渐变 —— CSS 渐变在数学上没法等价。
 *
 * **本文件的切分**（为了能单测）：
 * - `applyMonetBackgroundPixels(...)`：**纯函数**，直接对 `Uint8ClampedArray` 做后处理 ⇒ 可测；
 * - `getMonetBackgroundCacheKey(...)`：**纯函数** ⇒ 可测；
 * - `buildMonetBackgroundDataUrl` / `resolveMonetBackgroundDataUrl`：薄薄的 canvas/DOM 包装（不测，靠冒烟看图）。
 *
 * **我们这侧刻意省略的上游能力**（都写在这里备查，不做无声省略）：
 * ① 上游支持 `backgroundSource: 'uploaded-global'`（用户上传的全局背景）——我们目前只有封面；
 * ② 上游支持 `backgroundWashColorMode: 'custom'` + `backgroundWashCustomColor` —— 我们只用 accent；
 * ③ 上游的 `checkCanvasFilterSupport()` 是为 iOS Safari 的 `ctx.filter` 静默失效做的兜底 ——
 *    我们若某天要用 blur，再照抄那个探测。
 *
 * **我们这侧多出来的一项**（反向的差异，同样登记）：
 * ④ `tuning.glowScale`：上游 tuning 里没有这个字段，它是「背景氛围光」开关的抓手
 *    （`glowScale: 0` ⇒ 不画那团「封面暖光」），见 `MonetBackgroundTuning.glowScale` 的注释。
 */

import {
  MONET_FALLBACK_DARK,
  MONET_FALLBACK_LIGHT,
  MONET_OVERLAY_STOPS,
  MONET_STREAK_COUNT,
  type MonetRgb,
  resolveMonetOverlayAlpha,
  resolveMonetStreaks,
  resolveMonetWashColor,
  toMonetRgb,
} from './monetWash';

/** 上游写死的画布尺寸（`:6~7`）。 */
export const MONET_BACKGROUND_WIDTH = 1920;
export const MONET_BACKGROUND_HEIGHT = 1080;

/** 上游导出的是 **JPEG、质量 0.92**（`:348`）。 */
export const MONET_BACKGROUND_JPEG_QUALITY = 0.92;

/** 上游后处理用的 Rec.709 亮度（0~255 口径，`:28`）。 */
export const monetPixelLuminance = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const mix = (from: number, to: number, amount: number): number => from + (to - from) * amount;

/** 本模块需要的主题三色（字符串形式，允许是 `var(...)` —— 那时会给兜底色）。 */
export interface MonetBackgroundTheme {
  readonly backgroundColor: string;
  readonly primaryColor: string;
  readonly accentColor: string;
}

/** 本模块支持的调参子集（对应上游 `MonetBackgroundTuning` 里我们能表达的部分）。 */
export interface MonetBackgroundTuning {
  /** 封面模糊（0~60）；`0` 就跳过 `ctx.filter`（也省掉那个平台探测）。 */
  readonly blurPx: number;
  /** overlay 强度（0~1）。 */
  readonly overlayOpacity: number;
  /** 灰度（0~1）。 */
  readonly grayscale: number;
  /** 饱和度（0 = 灰、1 = 原样、2 = 加浓）。 */
  readonly saturation: number;
  /** 逐像素 wash 强度（0~1）。 */
  readonly wash: number;
  /** 是否烤入那 18 根竖条。 */
  readonly streaksEnabled: boolean;
  /**
   * **「封面暖光」的倍率 0~1**（`0` = 这团光一点都不画）——**这一项是我们自己的扩展，上游没有**。
   *
   * 上游那四层 overlay 里，只有第二层是**打在背景上的光**：`leftBloom`
   * （圆心 `18% / 34%`、半径 `55%` 宽、峰值 alpha = `overlay × 0.42` 的 accent 径向渐变，
   * 见 `paintMonetBackgroundOverlay`）；另外三层是对角洗色、右侧薄幕与竖条。
   *
   * 为什么需要这一项：设置页那枚「背景氛围光」关掉时，**烤图里也不该再有那团光** ——
   * 否则开关只关得掉 CSS 那层 `__bloom`（它只在没有烤图时出场），烤进去的那团照旧留着，
   * 看画面上就是「开关没生效」。同理，莫奈主题自己那张烤图也是这团光的来源之一。
   *
   * **缺省（`undefined`）按 `1` 算**：老调用点不传这一项时，位图逐像素与改造前一致。
   */
  readonly glowScale?: number;
}

/**
 * 这份 tuning 实际要用的暖光倍率（缺省 1、夹 0~1）。
 *
 * 单独抽成函数是为了让**缓存键**与**绘制**用同一个口径 —— 一处写 `?? 1`、另一处漏写，
 * 就会出现「键没变但图该变」的假缓存（那正是这一项最容易踩的坑）。
 */
export const resolveMonetGlowScale = (tuning: MonetBackgroundTuning): number =>
  clamp(tuning.glowScale ?? 1, 0, 1);

/**
 * **上游默认值**（`SOURCE`：folia 公开仓库 `src/types.ts` 的 `DEFAULT_MONET_BACKGROUND_TUNING`，
 * 第 284 轮取到）。六个强度值照抄，**不是我们拍的数**：
 * `blur 6 / overlay 0.74 / grayscale 0 / saturation 1.05 / wash 0.34 / streaks true`。
 *
 * 上游同一份默认值里还有 `backgroundSource: 'cover-derived'`、`backgroundLayout: 'full-overlay'`、
 * `backgroundWashColorMode: 'theme'` —— **正好是我们实现的这个子集**；
 * `driftEnabled/driftStrength` 属 DOM 侧 transform，按上游注释**不进缓存键**，故本模块不涉及。
 */
export const MONET_BACKGROUND_DEFAULT_TUNING: MonetBackgroundTuning = {
  blurPx: 6,
  overlayOpacity: 0.74,
  grayscale: 0,
  saturation: 1.05,
  wash: 0.34,
  streaksEnabled: true,
  /*
   * **这一项不是上游的值**（上游没有这个字段）：它是我们给「背景氛围光」开关留的抓手，
   * 缺省 `1` 就是上游原值 —— 于是「不传」与「传 1」烤出来的位图逐像素相同。
   */
  glowScale: 1,
};

/**
 * 按设置页那枚「背景氛围光」组装一份烤图参数（`backgroundGlow === false` ⇒ `glowScale: 0`）。
 *
 * **两处烤图都必须走它**，否则开关只关得掉一半：
 * - 公共背景那张烤图（`ImmersiveBackground.tsx`，六套 DOM 主题看到的底图）；
 * - 莫奈主题自己那张烤图（`MonetTheme.tsx`，它整幅盖住窗口、公共那几层根本露不出来）。
 *
 * `overrides` 是给调用点传「上游默认值之外还要改的东西」用的（公共背景那张要关竖条）。
 * 只接受 `Partial`，所以调用点不能悄悄把上游的六个强度值写成别的数。
 */
export const monetBackgroundTuningFor = (
  backgroundGlow: boolean,
  overrides: Partial<MonetBackgroundTuning> = {},
): MonetBackgroundTuning => ({
  ...MONET_BACKGROUND_DEFAULT_TUNING,
  glowScale: backgroundGlow ? 1 : 0,
  ...overrides,
});

/**
 * **逐像素后处理**（照抄上游 `applyBackgroundPostProcessing`，`:143~201`）：
 * 就地改 `data`（RGBA，长度 = `width × height × 4`）。
 *
 * 顺序与上游一致：**先灰度 → 再饱和度 → 最后 wash**；每一步都跳过 alpha=0 的像素；
 * `t` 取**该像素自己的亮度/255**。三个参数都"无事可做"时**原样返回**（上游也有这个早退）。
 */
export const applyMonetBackgroundPixels = (
  data: Uint8ClampedArray,
  theme: MonetBackgroundTheme,
  tuning: MonetBackgroundTuning,
): void => {
  const grayscale = clamp(tuning.grayscale, 0, 1);
  const saturation = clamp(tuning.saturation, 0, 2);
  const wash = clamp(tuning.wash, 0, 1);
  if (grayscale <= 0 && Math.abs(saturation - 1) < 0.001 && wash <= 0) return;

  const background = toMonetRgb(theme.backgroundColor, null, MONET_FALLBACK_DARK);
  const primary = toMonetRgb(theme.primaryColor, null, MONET_FALLBACK_LIGHT);
  const accent = toMonetRgb(theme.accentColor, null, background);

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;

    let r = data[index] ?? 0;
    let g = data[index + 1] ?? 0;
    let b = data[index + 2] ?? 0;

    const luminance = monetPixelLuminance(r, g, b);

    if (grayscale > 0) {
      r = mix(r, luminance, grayscale);
      g = mix(g, luminance, grayscale);
      b = mix(b, luminance, grayscale);
    }

    if (Math.abs(saturation - 1) >= 0.001) {
      const current = monetPixelLuminance(r, g, b);
      r = current + (r - current) * saturation;
      g = current + (g - current) * saturation;
      b = current + (b - current) * saturation;
    }

    if (wash > 0) {
      const washColor: MonetRgb = resolveMonetWashColor(
        clamp(luminance / 255, 0, 1),
        background,
        accent,
        primary,
      );
      r = mix(r, washColor.r, wash);
      g = mix(g, washColor.g, wash);
      b = mix(b, washColor.b, wash);
    }

    data[index] = Math.round(clamp(r, 0, 255));
    data[index + 1] = Math.round(clamp(g, 0, 255));
    data[index + 2] = Math.round(clamp(b, 0, 255));
  }
};

/** 缓存键的输入（＝上游 `BuildMonetBackgroundOptions` 去掉我们不做的那几项）。 */
export interface MonetBackgroundOptions {
  readonly coverUrl: string | null | undefined;
  readonly theme: MonetBackgroundTheme;
  readonly tuning: MonetBackgroundTuning;
}

/**
 * 缓存键（照抄上游 `getMonetBackgroundCacheKey`，`:242~268` 的**思路**）：
 * **凡是会改变位图的东西都进键**，不会改变位图的都不进。
 * 上游注释点明过一条判据：`drift`（DOM 侧 transform）**不进**，而 `streaksEnabled`（烤进位图）**必须进**。
 * 我们这里列 `blurPx / overlayOpacity / grayscale / saturation / wash / streaksEnabled` 六项（都在位图里），
 * 外加我们自己的第七项 `glowScale`（那团暖光也在位图里，而且缺省 `1` 与显式 `1` 必须同键 ——
 * 「不传」不能平白多烤一张图）。
 */
export const getMonetBackgroundCacheKey = (options: MonetBackgroundOptions): string =>
  JSON.stringify({
    coverUrl: options.coverUrl ?? null,
    theme: {
      backgroundColor: options.theme.backgroundColor,
      primaryColor: options.theme.primaryColor,
      accentColor: options.theme.accentColor,
    },
    tuning: {
      blurPx: options.tuning.blurPx,
      overlayOpacity: options.tuning.overlayOpacity,
      grayscale: options.tuning.grayscale,
      saturation: options.tuning.saturation,
      wash: options.tuning.wash,
      streaksEnabled: options.tuning.streaksEnabled,
      // 取值走 `resolveMonetGlowScale`：绘制与键必须同一个口径（缺省 1）。
      glowScale: resolveMonetGlowScale(options.tuning),
    },
  });

/** 与上游同构的缓存：键 → Promise（**失败的结果也会留在里面**，上游亦如此）。 */
const monetBackgroundCache = new Map<string, Promise<string | null>>();

const loadImage = async (src: string): Promise<HTMLImageElement> => {
  const image = new Image();
  if (src.startsWith('http://') || src.startsWith('https://')) image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  const loadPromise = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
  });
  image.src = src;
  try {
    await image.decode();
  } catch {
    await loadPromise;
  }
  return image;
};

/** cover 式裁切（`scale = max(w/iw, h/ih)`、居中；上游 `drawCoverCropped`，`:87~105`）。 */
const drawCoverCropped = (
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
): void => {
  const dimensions = image as CanvasImageSource & Partial<Record<'width' | 'height', unknown>>;
  const imageWidth = typeof dimensions.width === 'number' ? dimensions.width : width;
  const imageHeight = typeof dimensions.height === 'number' ? dimensions.height : height;
  if (!imageWidth || !imageHeight) return;
  const scale = Math.max(width / imageWidth, height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
};

/**
 * 画出那四层 overlay（上游 `paintMonetOverlay`，`:203~240`）：
 * 对角渐变 → 左光晕 → 右薄幕 → 18 根竖条。颜色与透明度**全部照抄上游**；
 * 唯一的例外是第二层那团左光晕会乘上 `glowScale`（我们的「背景氛围光」开关，见下面注释）。
 */
export const paintMonetBackgroundOverlay = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: MonetBackgroundTheme,
  tuning: MonetBackgroundTuning,
): void => {
  const overlay = clamp(tuning.overlayOpacity, 0, 1);
  /**
   * 「封面暖光」的倍率（缺省 1）：设置页那枚「背景氛围光」关掉时是 0 ⇒ 下面那团
   * `leftBloom` 的 alpha 也归零。其余三层（对角洗色 / 右侧薄幕 / 竖条）不受它影响 ——
   * 它们是**底色与压暗**，不是光。
   */
  const glowScale = resolveMonetGlowScale(tuning);
  const channels: Record<'accent' | 'background' | 'primary', string> = {
    accent: theme.accentColor,
    background: theme.backgroundColor,
    primary: theme.primaryColor,
  };

  const diagonal = context.createLinearGradient(0, 0, width, height);
  for (const stop of MONET_OVERLAY_STOPS) {
    const alpha = resolveMonetOverlayAlpha(stop.base, stop.gain, overlay);
    diagonal.addColorStop(stop.offset, withAlpha(channels[stop.channel], alpha));
  }
  context.fillStyle = diagonal;
  context.fillRect(0, 0, width, height);

  const leftBloom = context.createRadialGradient(
    width * 0.18,
    height * 0.34,
    0,
    width * 0.18,
    height * 0.34,
    width * 0.55,
  );
  leftBloom.addColorStop(0, withAlpha(theme.accentColor, overlay * 0.42 * glowScale));
  leftBloom.addColorStop(1, withAlpha(theme.backgroundColor, 0));
  // `glowScale === 0` 时整层跳过：不留一个「alpha 全 0 的空渐变」在管线里（省一次全幅填色，
  // 也让「关掉 = 这层不存在」在代码里看得见）。
  if (glowScale > 0) {
    context.fillStyle = leftBloom;
    context.fillRect(0, 0, width, height);
  }

  const rightVeil = context.createLinearGradient(width * 0.45, 0, width, 0);
  rightVeil.addColorStop(0, withAlpha(theme.backgroundColor, 0));
  rightVeil.addColorStop(1, withAlpha(theme.backgroundColor, 0.18 + overlay * 0.38));
  context.fillStyle = rightVeil;
  context.fillRect(0, 0, width, height);

  if (!tuning.streaksEnabled) return;
  context.fillStyle = withAlpha(theme.backgroundColor, 0.1 + overlay * 0.08);
  for (const streak of resolveMonetStreaks(width, height)) {
    context.fillRect(streak.x, streak.y, 1, streak.height);
  }
};

/** 把颜色与 alpha 拼成 `rgba(...)`；解析不了的输入原样返回（不猜）。 */
const withAlpha = (color: string, alpha: number): string => {
  const rgb = toMonetRgb(color, null, MONET_FALLBACK_DARK);
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${clamp(alpha, 0, 1)})`;
};

/** 生成那张背景图（上游 `buildMonetBackgroundDataUrl`，`:315~349`）。失败一律返回 `null`。 */
export const buildMonetBackgroundDataUrl = async (
  options: MonetBackgroundOptions,
): Promise<string | null> => {
  const sourceUrl = options.coverUrl ?? null;
  if (sourceUrl === null || sourceUrl === '') return null;

  const image = await loadImage(sourceUrl);
  const canvas = document.createElement('canvas');
  canvas.width = MONET_BACKGROUND_WIDTH;
  canvas.height = MONET_BACKGROUND_HEIGHT;
  const context = canvas.getContext('2d');
  if (context === null) return null;

  context.fillStyle = options.theme.backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.save();
  const blurPx = clamp(options.tuning.blurPx, 0, 60);
  if (blurPx > 0) context.filter = `blur(${blurPx}px)`;
  drawCoverCropped(context, image, canvas.width, canvas.height);
  context.restore();

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  applyMonetBackgroundPixels(imageData.data, options.theme, options.tuning);
  context.putImageData(imageData, 0, 0);

  paintMonetBackgroundOverlay(context, canvas.width, canvas.height, options.theme, options.tuning);

  return canvas.toDataURL('image/jpeg', MONET_BACKGROUND_JPEG_QUALITY);
};

/** 带缓存的入口（上游 `resolveMonetBackgroundDataUrl`，`:351~361`）：**失败结果同样入缓存**。 */
export const resolveMonetBackgroundDataUrl = (
  options: MonetBackgroundOptions,
): Promise<string | null> => {
  const cacheKey = getMonetBackgroundCacheKey(options);
  const cached = monetBackgroundCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const next = buildMonetBackgroundDataUrl(options).catch(() => null);
  monetBackgroundCache.set(cacheKey, next);
  return next;
};

/** 竖条根数对外暴露一次，方便别处断言"上游是 18 根"。 */
export { MONET_STREAK_COUNT };
