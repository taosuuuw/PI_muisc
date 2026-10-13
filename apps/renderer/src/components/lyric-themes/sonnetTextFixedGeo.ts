/**
 * 商籁「**普通歌词背后的固定几何**」（照抄 folia `sonnet/sonnetTextFixedGeo.ts`，AGPL-3.0）。
 *
 * 上游文件头原文："Plans and draws deterministic fixed geometry that sits **behind ordinary Sonnet text**."
 * ⇒ 这不是"重镜头固定几何"（那是另一套 ✓），而是**普通歌词背后**的一小撮确定性装饰 ✓：
 * **hollow**（空心系）4 种 + **solid**（实心系）3 种 = **7 种** ✓。
 *
 * === 与 folia 的差异（照实记）===
 * · `orb-hatch` 上游把**竖弦**画在一个**子 `Graphics`** 上 ✓；我方**摊平成同一份图元清单** ✓
 *   （画序不变：先实心圆、后竖弦 ✓）。
 * · "框体旋转"上游写在 `graphic.rotation` ✓；我方放进几何结果的 `rotation` 字段 ✓，由渲染层施加 ✓。
 * · 上游的 `drawMusicSteps` / `drawBentLines` 里"两色交替"用 `index % 2` 决定 primary/secondary ✓，
 *   我方同样用 `colorKey` 表达 ✓（渲染层换色 ✓）。
 */

export const SONNET_TEXT_FIXED_GEO_HOLLOW_VARIANTS = [
  'straight-frame',
  'rotated-frame',
  'orbit-crosshair',
  'split-arches',
] as const;

export const SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS = [
  'orb-hatch',
  'music-steps',
  'bent-lines',
] as const;

export type SonnetTextFixedGeoHollowVariant = (typeof SONNET_TEXT_FIXED_GEO_HOLLOW_VARIANTS)[number];
export type SonnetTextFixedGeoSolidVariant = (typeof SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS)[number];

export type SonnetTextFixedGeoPlan =
  | { readonly category: 'hollow'; readonly variant: SonnetTextFixedGeoHollowVariant }
  | { readonly category: 'solid'; readonly variant: SonnetTextFixedGeoSolidVariant };

/** `music-steps` 的 8 根柱子高度比（上游逐字给出 ✓）。 */
export const SONNET_TEXT_FIXED_GEO_MUSIC_STEP_HEIGHTS = [
  0.24, 0.35, 0.2, 0.82, 0.3, 0.1, 0.23, 0.16,
] as const;

/** 空心的四变体按 `floor(seed / divisor) + offset` 取（上游 `resolveHollowVariant` ✓）。 */
function resolveHollowVariant(
  seed: number,
  divisor: number,
  offset: number,
): SonnetTextFixedGeoHollowVariant {
  const index = Math.floor(seed / divisor) + offset;
  const length = SONNET_TEXT_FIXED_GEO_HOLLOW_VARIANTS.length;
  return SONNET_TEXT_FIXED_GEO_HOLLOW_VARIANTS[((index % length) + length) % length]!;
}

/**
 * 选哪一种（上游 `resolveSonnetTextFixedGeoPlan` ✓）：
 * · **合唱镜**：`chorusSeed = ((seed % 10) + 10) % 10`；**`< 9`（即 90%）走 hollow**（`divisor 10 / offset chorusSeed` ✓），
 *   否则 solid（`solidVariants[floor(seed / 10) % 3]` ✓）；
 * · **非合唱镜**：`legacyType = ((seed % 4) + 4) % 4`；**1 或 2 走 hollow**（`divisor 4 / offset legacyType` ✓），
 *   否则 solid（`solidVariants[floor(seed / 4) % 3]` ✓）。
 */
export function resolveSonnetTextFixedGeoPlan(
  seed: number,
  isChorusEffect: boolean,
): SonnetTextFixedGeoPlan {
  if (isChorusEffect) {
    const chorusSeed = ((seed % 10) + 10) % 10;
    if (chorusSeed < 9) {
      return { category: 'hollow', variant: resolveHollowVariant(seed, 10, chorusSeed) };
    }
    /*
     * ⚠ 第 473 轮修：**这里也漏了负数正化** ✗ —— 第 472 轮我只修了非合唱那一处 ✓，
     * 结果用例的"负种子全扫"精确地把它抓了出来 ✓（`seed = −1` 时 `floor(−1 / 10) = −1` ⇒ 下标 −1 ✗）。
     * 现在与另一处统一：`((index % n) + n) % n` ✓。
     */
    const chorusSolidIndex = Math.floor(seed / 10) % SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS.length;
    const chorusSolidLength = SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS.length;
    return {
      category: 'solid',
      variant: SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS[
        ((chorusSolidIndex % chorusSolidLength) + chorusSolidLength) % chorusSolidLength
      ]!,
    };
  }
  const legacyType = ((seed % 4) + 4) % 4;
  if (legacyType === 1 || legacyType === 2) {
    return { category: 'hollow', variant: resolveHollowVariant(seed, 4, legacyType) };
  }
  /*
   * ⚠ 第 472 轮修：这里原来是 `Math.floor(seed / 4) % 3` ✗ ——
   * **负数种子**时 `Math.floor(-1 / 4) = -1` ⇒ `-1 % 3 = -1` ⇒ 下标 −1 ⇒ 取到 `undefined` ✗✗
   * （`hollow` 分支有正化、**solid 分支漏了** ✓）。现在统一按 `((x % n) + n) % n` 正化 ✓。
   */
  const solidIndex = Math.floor(seed / 4) % SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS.length;
  return {
    category: 'solid',
    variant: SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS[
      ((solidIndex % SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS.length) +
        SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS.length) %
        SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS.length
    ]!,
  };
}

export interface SonnetTextFixedGeoGeometryInput {
  readonly seed: number;
  readonly isChorusEffect: boolean;
  readonly fontSize: number;
  /** 排版宽度（上游 `layoutWidth` ✓）。 */
  readonly layoutWidth: number;
}

export interface SonnetTextFixedGeoGeometry {
  /** `isChorusEffect ? 1.5 + (seed % 5) × 0.3 : 1` ✓。 */
  readonly scaleMultiplier: number;
  /** `max(fontSize × 2.5 × scale, layoutWidth × 0.12 × scale)` ✓。 */
  readonly width: number;
  /** `max(fontSize × 1.8 × scale, layoutWidth × 0.08 × scale)` ✓。 */
  readonly height: number;
  /** `(isChorusEffect ? 0.4 : 0.25) + (seed % 10) × 0.03` ✓。 */
  readonly alpha: number;
  /** `seed % 2 === 0` 时用次要色，否则主色 ✓。 */
  readonly accentIsSecondary: boolean;
  /** 框类描边宽度：`max(1.5, fontSize × 0.02)` ✓。 */
  readonly frameStrokeWidth: number;
  /** `rotated-frame` 专用：`π / 4` ✓（其余为 0 ✓ —— 由 `resolveSonnetTextFixedGeoRotation` 算 ✓）。 */
  readonly rotation: number;
  /** 直框在**合唱且偶数种子**时多画一个 `× 0.6` 的内框 ✓。 */
  readonly innerFrame: boolean;
}

/**
 * 框体旋转：只有 `rotated-frame` 转 `π / 4` ✓，其余为 0 ✓。
 * ⚠ 第 471 轮补：`resolveSonnetTextFixedGeoGeometry` 只拿到 `seed/fontSize/layoutWidth` ✓，
 * **它不知道选了哪种变体** ✗ ⇒ 旋转必须由**变体**决定 ⇒ 单独一个函数 ✓（写用例时发现原设计漏了这一步 ✓）。
 */
export function resolveSonnetTextFixedGeoRotation(plan: SonnetTextFixedGeoPlan): number {
  return plan.category === 'hollow' && plan.variant === 'rotated-frame' ? Math.PI / 4 : 0;
}

export function resolveSonnetTextFixedGeoGeometry(
  input: SonnetTextFixedGeoGeometryInput,
): SonnetTextFixedGeoGeometry {
  const scaleMultiplier = input.isChorusEffect ? 1.5 + (input.seed % 5) * 0.3 : 1;
  return {
    scaleMultiplier,
    width: Math.max(
      input.fontSize * 2.5 * scaleMultiplier,
      input.layoutWidth * 0.12 * scaleMultiplier,
    ),
    height: Math.max(
      input.fontSize * 1.8 * scaleMultiplier,
      input.layoutWidth * 0.08 * scaleMultiplier,
    ),
    alpha: (input.isChorusEffect ? 0.4 : 0.25) + (input.seed % 10) * 0.03,
    accentIsSecondary: input.seed % 2 === 0,
    frameStrokeWidth: Math.max(1.5, input.fontSize * 0.02),
    rotation: 0,
    innerFrame: input.isChorusEffect && input.seed % 2 === 0,
  };
}

/** 颜色键：渲染层把 `primary` / `secondary` 换成主题色 ✓。 */
export type SonnetTextFixedGeoColorKey = 'primary' | 'secondary';

export type SonnetTextFixedGeoDraw =
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetTextFixedGeoColorKey;
    }
  | {
      readonly kind: 'circle';
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      /** `0` 表示**填充**（上游 `orb-hatch` 的实心圆 ✓），否则描边 ✓。 */
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetTextFixedGeoColorKey;
    }
  | {
      readonly kind: 'arc';
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly startAngle: number;
      readonly endAngle: number;
      readonly anticlockwise: boolean;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetTextFixedGeoColorKey;
    }
  | {
      readonly kind: 'polyline';
      /** 成对的 `x, y`（上游的 `moveTo` / `lineTo` / `quadraticCurveTo` 都折成折线 ✓）。 */
      readonly points: readonly number[];
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetTextFixedGeoColorKey;
    }
  | {
      readonly kind: 'curved';
      readonly fromX: number;
      readonly fromY: number;
      readonly controlX: number;
      readonly controlY: number;
      readonly toX: number;
      readonly toY: number;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetTextFixedGeoColorKey;
    };

/** `orb-hatch` 的竖弦（上游在子 `Graphics` 里画 ✓ 我们摊平 ✓）。 */
export function resolveSonnetTextFixedGeoHatchLines(
  width: number,
  alpha: number,
  colorKey: SonnetTextFixedGeoColorKey = 'primary',
): readonly SonnetTextFixedGeoDraw[] {
  const radius = width * 0.5;
  const spacing = Math.max(4, width * 0.05);
  const draws: SonnetTextFixedGeoDraw[] = [];
  /*
   * ⚠ 第 472 轮改：原来是 `for (offset = −r; offset < r; offset += spacing)` ✗ ——
   * **浮点累加**会让最后一次比较悄悄多走一轮（用例里 216 宽得到 **21** 条，按公式应是 20 ✓）。
   * 现在改成**整数下标**：`offset = −r + i × spacing`，条数 = `ceil(2r / spacing)` ✓（确定性 ✓）。
   */
  const count = Math.ceil((radius * 2) / spacing);
  for (let index = 0; index < count; index += 1) {
    const offset = -radius + index * spacing;
    const lineHeight = Math.sqrt(Math.max(0, radius * radius - offset * offset));
    const x = offset + radius * 0.4;
    draws.push({
      kind: 'polyline',
      points: [x, -lineHeight + radius * 0.4, x, lineHeight + radius * 0.4],
      strokeWidth: 1.5,
      alpha: alpha * 0.6,
      colorKey,
    });
  }
  return draws;
}

/**
 * 出图元（7 种变体逐条照抄 ✓）。
 * `plan.category === 'hollow'` 时用 `frameStrokeWidth` ✓；`solid` 的三种各有自己的宽度公式 ✓。
 */
export function resolveSonnetTextFixedGeoDraws(
  plan: SonnetTextFixedGeoPlan,
  geometry: SonnetTextFixedGeoGeometry,
): readonly SonnetTextFixedGeoDraw[] {
  const { width: w, height: h, alpha, frameStrokeWidth: frameStroke } = geometry;
  const mainKey: SonnetTextFixedGeoColorKey = geometry.accentIsSecondary ? 'secondary' : 'primary';
  const otherKey: SonnetTextFixedGeoColorKey = geometry.accentIsSecondary ? 'primary' : 'secondary';
  const draws: SonnetTextFixedGeoDraw[] = [];

  switch (plan.variant) {
    case 'straight-frame': {
      draws.push({
        kind: 'rect',
        x: -w / 2,
        y: -h / 2,
        width: w,
        height: h,
        strokeWidth: frameStroke,
        alpha,
        colorKey: mainKey,
      });
      if (geometry.innerFrame) {
        const innerW = w * 0.6;
        const innerH = h * 0.6;
        draws.push({
          kind: 'rect',
          x: -innerW / 2,
          y: -innerH / 2,
          width: innerW,
          height: innerH,
          strokeWidth: frameStroke,
          alpha: alpha * 0.7,
          colorKey: otherKey,
        });
      }
      return draws;
    }
    case 'rotated-frame': {
      const rw = w * 0.8;
      const rh = h * 0.8;
      draws.push({
        kind: 'rect',
        x: -rw / 2,
        y: -rh / 2,
        width: rw,
        height: rh,
        strokeWidth: frameStroke,
        alpha,
        colorKey: mainKey,
      });
      return draws;
    }
    case 'orbit-crosshair': {
      const radius = Math.min(w, h) * 0.46;
      draws.push({
        kind: 'circle',
        x: 0,
        y: 0,
        radius,
        strokeWidth: 1.5,
        alpha,
        colorKey: mainKey,
      });
      for (const direction of [-1, 1]) {
        draws.push({
          kind: 'circle',
          x: direction * w * 0.17,
          y: 0,
          radius: radius * 0.72,
          strokeWidth: 1,
          alpha: alpha * 0.72,
          colorKey: otherKey,
        });
      }
      draws.push({
        kind: 'polyline',
        points: [-w * 0.62, 0, w * 0.62, 0],
        strokeWidth: 1,
        alpha: alpha * 0.64,
        colorKey: mainKey,
      });
      draws.push({
        kind: 'polyline',
        points: [0, -h * 0.62, 0, h * 0.62],
        strokeWidth: 1,
        alpha: alpha * 0.64,
        colorKey: mainKey,
      });
      return draws;
    }
    case 'split-arches': {
      const halfWidth = w * 0.46;
      const archRadius = Math.min(w * 0.34, h * 0.52);
      for (const direction of [-1, 1]) {
        const x = direction * halfWidth;
        // 竖线 → 拱 → 竖线（上游是一段路径 ✓）
        draws.push({
          kind: 'polyline',
          points: [x, h * 0.42, x, 0],
          strokeWidth: 1.5,
          alpha,
          colorKey: direction < 0 ? mainKey : otherKey,
        });
        draws.push({
          kind: 'arc',
          x,
          y: 0,
          radius: archRadius * 0.72,
          startAngle: Math.PI,
          endAngle: 0,
          anticlockwise: false,
          strokeWidth: 1.5,
          alpha,
          colorKey: direction < 0 ? mainKey : otherKey,
        });
        draws.push({
          kind: 'arc',
          x,
          y: 0,
          radius: archRadius * 0.48,
          startAngle: Math.PI,
          endAngle: 0,
          anticlockwise: false,
          strokeWidth: 1,
          alpha: alpha * 0.58,
          colorKey: direction < 0 ? otherKey : mainKey,
        });
      }
      draws.push({
        kind: 'polyline',
        points: [-halfWidth, h * 0.42, halfWidth, h * 0.42],
        strokeWidth: 2,
        alpha: alpha * 0.72,
        colorKey: mainKey,
      });
      return draws;
    }
    case 'orb-hatch': {
      draws.push({
        kind: 'circle',
        x: 0,
        y: 0,
        radius: w * 0.5,
        strokeWidth: 0,
        alpha: alpha * 0.15,
        colorKey: mainKey,
      });
      draws.push(...resolveSonnetTextFixedGeoHatchLines(w, alpha, mainKey));
      return draws;
    }
    case 'music-steps': {
      const heights = SONNET_TEXT_FIXED_GEO_MUSIC_STEP_HEIGHTS;
      const spacing = w / (heights.length + 1);
      const strokeWidth = Math.max(2, h * 0.025);
      heights.forEach((heightRatio, index) => {
        const x = -w / 2 + spacing * (index + 1);
        const baseline = h * (0.12 - index * 0.035);
        draws.push({
          kind: 'polyline',
          points: [
            x - spacing * 0.12,
            baseline - (h * heightRatio) / 2,
            x + spacing * 0.12,
            baseline + (h * heightRatio) / 2,
          ],
          strokeWidth,
          alpha: alpha * 0.52,
          colorKey: index % 2 === 0 ? mainKey : otherKey,
        });
      });
      return draws;
    }
    case 'bent-lines': {
      const strokeWidth = Math.max(2, h * 0.022);
      for (let index = 0; index < 5; index += 1) {
        const x = -w * 0.34 + index * w * 0.17;
        const topY = -h * (0.42 - index * 0.035);
        const elbowY = -h * (0.08 - index * 0.025);
        const bottomY = h * (0.35 + index * 0.035);
        draws.push({
          kind: 'curved',
          fromX: x - w * 0.16,
          fromY: topY,
          controlX: x,
          controlY: elbowY,
          toX: x - w * 0.015,
          toY: bottomY,
          strokeWidth,
          alpha: alpha * 0.52,
          colorKey: index % 2 === 0 ? mainKey : otherKey,
        });
      }
      return draws;
    }
    default: {
      return draws;
    }
  }
}
