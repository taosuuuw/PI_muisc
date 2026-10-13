/**
 * 商籁（sonnet）的**装饰图形语汇**：固定几何（8 档）与每族背景（网格 / 散方块）。
 *
 * 数值与做法照抄 folia（`sonnet/sonnetFixedGeoVariants.ts` 与 `sonnet/sonnetShotMg.ts` 的 bg 层），
 * 代码在本仓库重写。三处按原版意图保留：
 *
 * 1. **固定几何是"印在纸上的版块"**：实心块 + 空心框 + 斜线网三件套，相机推拉时它不跟着转
 *    （原版把它挂在独立的 `fixedGeoLayer` 上、由运行时反向补偿相机的旋转）。
 * 2. **斜线网在原版里靠遮罩裁进矩形**（`hatch.mask = rect`）。我们没有逐图形的遮罩，
 *    改成**把线段裁到矩形**（Liang–Barsky），视觉结果等价。
 * 3. **取色**：原版的 `primary` 走我们的"主色"档（tone 1）、`accent` 走"强调"档（tone 2）；
 *    `accent` 只在偶数种子时才是另一个颜色（`seed % 2 === 0 ? secondary : primary`）。
 */

/** 一条图形指令：多边形顶点已算成最终画面坐标，渲染层不做二次变换。 */
export interface SonnetShapeSpec {
  readonly id: string;
  readonly polygon: readonly number[];
  /** -1 表示不填。 */
  readonly fillTone: number;
  readonly fillAlpha: number;
  /** -1 表示不描。 */
  readonly strokeTone: number;
  readonly strokeWidth: number;
  readonly strokeAlpha: number;
  readonly alpha: number;
  readonly delay: number;
  readonly span: number;
}

/** 主色档与强调档（见文件头的取色说明）。 */
export const SONNET_DECOR_PRIMARY_TONE = 1;
export const SONNET_DECOR_ACCENT_TONE = 2;

export function sonnetShape(
  id: string,
  polygon: readonly number[],
  options: Partial<Omit<SonnetShapeSpec, 'id' | 'polygon'>> = {},
): SonnetShapeSpec {
  return {
    id,
    polygon,
    fillTone: options.fillTone ?? -1,
    fillAlpha: options.fillAlpha ?? 0,
    strokeTone: options.strokeTone ?? SONNET_DECOR_PRIMARY_TONE,
    strokeWidth: options.strokeWidth ?? 2,
    strokeAlpha: options.strokeAlpha ?? 0.6,
    alpha: options.alpha ?? 1,
    delay: options.delay ?? 0,
    span: options.span ?? 0.6,
  };
}

export interface SonnetDecorViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * 矩形多边形。
 *
 * **末点回到起点**：帧层给出的多边形是被渲染层当**路径**描边的（`Graphics.poly()`），
 * 不闭合就会在起止边之间留一道豁口 —— 原版的 `rect()` / `circle()` 都是闭合图形。
 */
export function rectPolygon(x: number, y: number, width: number, height: number): number[] {
  return [x, y, x + width, y, x + width, y + height, x, y + height, x, y];
}

export function circlePolygon(cx: number, cy: number, radius: number, segments = 48): number[] {
  const points: number[] = [];
  for (let step = 0; step < segments; step += 1) {
    const angle = (step / segments) * Math.PI * 2;
    points.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  }
  points.push(cx + radius, cy);
  return points;
}

/** 菱形（原版是四条 `lineTo` 回到起点描边，这里给成闭合多边形）。 */
export function diamondPolygon(cx: number, cy: number, radius: number): number[] {
  return [cx, cy - radius, cx + radius, cy, cx, cy + radius, cx - radius, cy, cx, cy - radius];
}

/* ------------------------------------------------------------------ *
 * 斜线网：把 45° 线段裁到矩形里（等价于原版拿矩形当遮罩）
 * ------------------------------------------------------------------ */

/** Liang–Barsky：把线段裁到轴对齐矩形，返回裁剪后的端点；完全在外就返回 null。 */
export function clipSegmentToRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const edges: readonly [number, number][] = [
    [-dx, x1 - left],
    [dx, right - x1],
    [-dy, y1 - top],
    [dy, bottom - y1],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      // 与这条边平行：完全在外侧就整段丢掉。
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return {
    x1: x1 + t0 * dx,
    y1: y1 + t0 * dy,
    x2: x1 + t1 * dx,
    y2: y1 + t1 * dy,
  };
}

/**
 * 斜线网（照抄 folia 的 `drawHatching`）：从 `x - w` 起每 `spacing` 画一条 45° 线，
 * 线长按矩形直径给足，再裁进矩形。原版线宽 1、透明度 0.15。
 */
export function buildHatchShapes(
  idPrefix: string,
  x: number,
  y: number,
  width: number,
  height: number,
  spacing: number,
  options: { readonly tone?: number; readonly alpha?: number } = {},
): SonnetShapeSpec[] {
  const tone = options.tone ?? SONNET_DECOR_PRIMARY_TONE;
  const alpha = options.alpha ?? 0.15;
  const shapes: SonnetShapeSpec[] = [];
  let index = 0;
  for (let offset = -width; offset < width + height; offset += spacing) {
    const clipped = clipSegmentToRect(
      x + offset,
      y,
      x + offset + height,
      y + height,
      x,
      y,
      x + width,
      y + height,
    );
    if (clipped === null) continue;
    shapes.push(
      sonnetShape(`${idPrefix}-${index}`, [clipped.x1, clipped.y1, clipped.x2, clipped.y2], {
        strokeTone: tone,
        strokeWidth: 1,
        strokeAlpha: alpha,
        span: 0.5,
      }),
    );
    index += 1;
  }
  return shapes;
}

/* ------------------------------------------------------------------ *
 * 固定几何：8 档（照抄 folia 的 `SONNET_FIXED_GEO_VARIANTS`）
 * ------------------------------------------------------------------ */

export const SONNET_FIXED_GEO_VARIANT_COUNT = 8;

export const SONNET_FIXED_GEO_VARIANTS = [
  'classic-blocks',
  'twin-pillars',
  'disc-ring',
  'diamond-pair',
  'stripe-stack',
  'corner-els',
  'twin-wedges',
  'cross-ring',
] as const;

/**
 * 32 位种子混合。**这是替身**：原版调的是 `mixSonnetSeed(seed, 0x85ebca6b)`，那个实现没取到；
 * 这里用同族的 xor-shift 混合，接口与取模方式（`% 8`）照原版。
 */
export function mixSonnetDecorSeed(seed: number, salt: number): number {
  let value = (Math.trunc(seed) ^ salt) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value = (value ^ (value >>> 15)) >>> 0;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

export function resolveSonnetFixedGeoVariant(seed: number): number {
  return mixSonnetDecorSeed(seed, 0x85ebca6b) % SONNET_FIXED_GEO_VARIANT_COUNT;
}

interface FixedGeoContext {
  shapes: SonnetShapeSpec[];
  cx: number;
  cy: number;
  r: number;
  seed: number;
  /** true 时强调色那一部分改用强调档。 */
  accentIsSecondary: boolean;
}

const accentTone = (context: FixedGeoContext): number =>
  context.accentIsSecondary ? SONNET_DECOR_ACCENT_TONE : SONNET_DECOR_PRIMARY_TONE;

const fill = (
  context: FixedGeoContext,
  id: string,
  polygon: readonly number[],
  tone: number,
  alpha: number,
  delay = 0,
): void => {
  context.shapes.push(
    sonnetShape(id, polygon, { fillTone: tone, fillAlpha: alpha, strokeTone: -1, delay }),
  );
};

const stroke = (
  context: FixedGeoContext,
  id: string,
  polygon: readonly number[],
  width: number,
  alpha: number,
  delay = 0,
): void => {
  context.shapes.push(
    sonnetShape(id, polygon, {
      strokeTone: SONNET_DECOR_PRIMARY_TONE,
      strokeWidth: width,
      strokeAlpha: alpha,
      delay,
    }),
  );
};

const hatch = (
  context: FixedGeoContext,
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  spacing: number,
): void => {
  context.shapes.push(...buildHatchShapes(id, x, y, width, height, spacing));
};

/** 第 0 档：实心块 + 空心框 + 斜线网的"三件套"（原版这一档就是最初的形态）。 */
function drawClassicBlocks(context: FixedGeoContext): void {
  const { cx, cy, r } = context;
  fill(context, 'fg-block', rectPolygon(cx - r * 0.4, cy - r * 0.2, r * 0.6, r * 0.15), SONNET_DECOR_PRIMARY_TONE, 0.7);
  stroke(context, 'fg-frame', rectPolygon(cx - r * 0.1, cy + r * 0.1, r * 0.5, r * 0.3), 2, 0.6);
  hatch(context, 'fg-hatch', cx - r * 0.3, cy - r * 0.4, r * 0.4, r * 0.25, 6);
}

/** 第 1 档：一根实心柱 + 一个更高的空心框，中间夹一条网。 */
function drawTwinPillars(context: FixedGeoContext): void {
  const { cx, cy, r } = context;
  fill(context, 'fg-pillar', rectPolygon(cx - r * 0.34, cy - r * 0.28, r * 0.12, r * 0.56), accentTone(context), 0.65);
  fill(
    context,
    'fg-pillar-core',
    rectPolygon(cx - r * 0.34 + r * 0.035, cy - r * 0.28 + r * 0.035, r * 0.05, r * 0.49),
    SONNET_DECOR_PRIMARY_TONE,
    0.35,
    0.04,
  );
  stroke(context, 'fg-frame', rectPolygon(cx + r * 0.06, cy - r * 0.34, r * 0.28, r * 0.68), 2, 0.6);
  stroke(
    context,
    'fg-frame-inner',
    rectPolygon(cx + r * 0.1, cy - r * 0.3, r * 0.2, r * 0.6),
    1,
    0.3,
    0.06,
  );
  hatch(context, 'fg-hatch', cx - r * 0.14, cy - r * 0.2, r * 0.12, r * 0.4, 5);
}

/** 第 2 档：实心圆盘 + 同心空心环 + 一条网弦。 */
function drawDiscRing(context: FixedGeoContext): void {
  const { cx, cy, r } = context;
  fill(context, 'fg-disc', circlePolygon(cx - r * 0.2, cy + r * 0.12, r * 0.15), accentTone(context), 0.7);
  fill(
    context,
    'fg-disc-core',
    circlePolygon(cx - r * 0.2, cy + r * 0.12, r * 0.06, 32),
    SONNET_DECOR_PRIMARY_TONE,
    0.5,
    0.04,
  );
  stroke(context, 'fg-ring', circlePolygon(cx + r * 0.14, cy - r * 0.06, r * 0.3), 2, 0.6);
  stroke(context, 'fg-ring-inner', circlePolygon(cx + r * 0.14, cy - r * 0.06, r * 0.22, 40), 1, 0.3, 0.06);
  hatch(context, 'fg-hatch', cx + r * 0.02, cy - r * 0.14, r * 0.24, r * 0.16, 5);
}

/** 第 3 档：大空心菱形 + 小实心菱形。 */
function drawDiamondPair(context: FixedGeoContext): void {
  const { cx, cy, r } = context;
  const direction = context.seed % 2 === 0 ? 1 : -1;
  const dr = r * 0.3;
  const dx = cx - r * 0.08 * direction;
  stroke(context, 'fg-diamond', diamondPolygon(dx, cy, dr), 2, 0.6);
  stroke(context, 'fg-diamond-inner', diamondPolygon(dx, cy, dr * 0.7), 1, 0.3, 0.06);
  const sr = r * 0.11;
  const sx = cx + r * 0.3 * direction;
  const sy = cy - r * 0.2;
  fill(context, 'fg-diamond-solid', diamondPolygon(sx, sy, sr), accentTone(context), 0.7);
  hatch(context, 'fg-hatch', sx - sr * 0.8, cy + r * 0.16, sr * 1.6, sr * 1.2, 4);
}

/** 第 4 档：三条错开的横条（实心 / 空心 / 细强调）。 */
function drawStripeStack(context: FixedGeoContext): void {
  const { cx, cy, r } = context;
  const direction = context.seed % 2 === 0 ? 1 : -1;
  fill(
    context,
    'fg-stripe',
    rectPolygon(cx - r * 0.36 * direction - r * 0.2, cy - r * 0.26, r * 0.56, r * 0.09),
    accentTone(context),
    0.7,
  );
  stroke(context, 'fg-stripe-frame', rectPolygon(cx - r * 0.28, cy - r * 0.06, r * 0.56, r * 0.16), 2, 0.6, 0.04);
  fill(
    context,
    'fg-stripe-thin',
    rectPolygon(cx - r * 0.2 * direction, cy + r * 0.2, r * 0.4, r * 0.045),
    SONNET_DECOR_PRIMARY_TONE,
    0.5,
    0.08,
  );
  hatch(context, 'fg-hatch', cx + r * 0.26 * direction, cy - r * 0.3, r * 0.12, r * 0.6, 5);
}

/** 第 5 档：对角线上一对粗 L 角 + 中间一个空心方块。 */
function drawCornerEls(context: FixedGeoContext): void {
  const { cx, cy, r } = context;
  const direction = context.seed % 2 === 0 ? 1 : -1;
  const arm = r * 0.24;
  const thick = r * 0.07;
  const x1 = cx - r * 0.3 * direction;
  const y1 = cy - r * 0.24;
  fill(
    context,
    'fg-corner-1h',
    rectPolygon(direction < 0 ? x1 - arm : x1, y1, arm, thick),
    accentTone(context),
    0.7,
  );
  fill(
    context,
    'fg-corner-1v',
    rectPolygon(direction < 0 ? x1 - arm : x1, y1, thick, arm),
    accentTone(context),
    0.7,
    0.03,
  );
  const x2 = cx + r * 0.3 * direction;
  const y2 = cy + r * 0.24;
  fill(
    context,
    'fg-corner-2h',
    rectPolygon(direction < 0 ? x2 : x2 - arm, y2 - thick, arm, thick),
    SONNET_DECOR_PRIMARY_TONE,
    0.55,
    0.06,
  );
  fill(
    context,
    'fg-corner-2v',
    rectPolygon(direction < 0 ? x2 + arm - thick : x2 - thick, y2 - arm, thick, arm),
    SONNET_DECOR_PRIMARY_TONE,
    0.55,
    0.09,
  );
  stroke(context, 'fg-center-frame', rectPolygon(cx - r * 0.13, cy - r * 0.13, r * 0.26, r * 0.26), 2, 0.6, 0.12);
  hatch(context, 'fg-hatch', cx - r * 0.09 * direction, cy + r * 0.02, r * 0.16, r * 0.1, 4);
}

/** 第 6 档：一个实心向上楔形对着一个空心向下楔形。 */
function drawTwinWedges(context: FixedGeoContext): void {
  const { cx, cy, r } = context;
  const direction = context.seed % 2 === 0 ? 1 : -1;
  const wx = cx - r * 0.14 * direction;
  fill(
    context,
    'fg-wedge',
    [wx, cy - r * 0.3, wx + r * 0.24, cy + r * 0.02, wx - r * 0.24, cy + r * 0.02],
    accentTone(context),
    0.6,
  );
  const hx = cx + r * 0.16 * direction;
  stroke(
    context,
    'fg-wedge-hollow',
    [hx, cy + r * 0.3, hx + r * 0.24, cy - r * 0.02, hx - r * 0.24, cy - r * 0.02],
    2,
    0.6,
    0.04,
  );
  stroke(
    context,
    'fg-wedge-hollow-inner',
    [hx, cy + r * 0.2, hx + r * 0.15, cy, hx - r * 0.15, cy],
    1,
    0.3,
    0.08,
  );
  hatch(context, 'fg-hatch', cx - r * 0.3 * direction - r * 0.05, cy + r * 0.1, r * 0.2, r * 0.18, 5);
}

/** 第 7 档：实心十字落在空心环里，旁边一块网。 */
function drawCrossRing(context: FixedGeoContext): void {
  const { cx, cy, r } = context;
  const ccx = cx + (context.seed % 3 - 1) * r * 0.08;
  const arm = r * 0.17;
  const thick = r * 0.075;
  fill(
    context,
    'fg-cross-h',
    rectPolygon(ccx - arm, cy - thick / 2, arm * 2, thick),
    accentTone(context),
    0.7,
  );
  fill(
    context,
    'fg-cross-v',
    rectPolygon(ccx - thick / 2, cy - arm, thick, arm * 2),
    accentTone(context),
    0.7,
    0.03,
  );
  stroke(context, 'fg-cross-ring', circlePolygon(ccx, cy, r * 0.3), 2, 0.6, 0.06);
  stroke(context, 'fg-cross-ring-outer', circlePolygon(ccx, cy, r * 0.36, 56), 1, 0.25, 0.1);
  hatch(context, 'fg-hatch', ccx + r * 0.18, cy + r * 0.14, r * 0.16, r * 0.16, 4);
}

/**
 * 固定几何：**画布正中**、以 `radius = min(宽, 高)` 为尺度（照抄 folia 的 `radius` 与调用点）。
 * 原版把它挂在镜头的固定层上、相机推拉时反向补偿；我们这一版先按"始终居中"画。
 */
export function buildSonnetFixedGeoShapes(
  viewport: SonnetDecorViewport,
  variant: number,
  seed: number,
): SonnetShapeSpec[] {
  const context: FixedGeoContext = {
    shapes: [],
    cx: viewport.width / 2,
    cy: viewport.height / 2,
    r: Math.min(viewport.width, viewport.height),
    seed,
    accentIsSecondary: seed % 2 === 0,
  };
  switch (((variant % SONNET_FIXED_GEO_VARIANT_COUNT) + SONNET_FIXED_GEO_VARIANT_COUNT) % SONNET_FIXED_GEO_VARIANT_COUNT) {
    case 1:
      drawTwinPillars(context);
      break;
    case 2:
      drawDiscRing(context);
      break;
    case 3:
      drawDiamondPair(context);
      break;
    case 4:
      drawStripeStack(context);
      break;
    case 5:
      drawCornerEls(context);
      break;
    case 6:
      drawTwinWedges(context);
      break;
    case 7:
      drawCrossRing(context);
      break;
    default:
      drawClassicBlocks(context);
  }
  return context.shapes;
}

/* ------------------------------------------------------------------ *
 * 每族背景（照抄 folia `sonnetShotMg.ts` 里 bg 层的那三个分支）
 * ------------------------------------------------------------------ */

/**
 * 背景层：
 * - `editorial-column`：**严格网格** —— 6 条竖线 + 4 条横线（各 0.15 透明度）+ 中间那个 60% 的空心大方框。
 * - `quiet-tableau` / `mask-reveal`（以及走同一兜底分支的 `tracking-ribbon` / `poster-blocks`）：
 *   **5 个撒开的小方块**，位置与大小都由种子决定。
 * - `type-impact` / `fragment-collage`：原版这一族的大图形在别处（几何层），这里不给背景，另行绘制。
 */
export function buildSonnetBackgroundShapes(
  viewport: SonnetDecorViewport,
  kind: string,
  seed: number,
): SonnetShapeSpec[] {
  const { width, height } = viewport;
  const hw = width / 2;
  const hh = height / 2;
  const shapes: SonnetShapeSpec[] = [];
  if (kind === 'editorial-column') {
    for (let index = 1; index <= 6; index += 1) {
      const x = -hw + width * (index / 7);
      shapes.push(
        sonnetShape(`bg-grid-v${index}`, [x, -hh, x, hh], {
          strokeTone: SONNET_DECOR_PRIMARY_TONE,
          strokeWidth: 1,
          strokeAlpha: 0.15,
        }),
      );
    }
    for (let index = 1; index <= 4; index += 1) {
      const y = -hh + height * (index / 5);
      shapes.push(
        sonnetShape(`bg-grid-h${index}`, [-hw, y, hw, y], {
          strokeTone: SONNET_DECOR_PRIMARY_TONE,
          strokeWidth: 1,
          strokeAlpha: 0.15,
        }),
      );
    }
    shapes.push(
      sonnetShape('bg-grid-frame', rectPolygon(-hw + width * 0.2, -hh + height * 0.2, width * 0.6, height * 0.6), {
        strokeTone: SONNET_DECOR_PRIMARY_TONE,
        strokeWidth: 4,
        strokeAlpha: 0.5,
      }),
    );
    return shapes;
  }
  if (kind === 'type-impact' || kind === 'fragment-collage') return shapes;
  for (let index = 0; index < 5; index += 1) {
    const size = 10 + (seed % (index + 1)) * 5;
    const x = -hw + width * (0.2 + ((seed * 11 + index) % 60) / 100);
    const y = -hh + height * (0.2 + ((seed * 17 + index) % 60) / 100);
    shapes.push(
      sonnetShape(`bg-dot-${index}`, rectPolygon(x, y, size, size), {
        fillTone: SONNET_DECOR_PRIMARY_TONE,
        fillAlpha: 0.4,
        strokeTone: -1,
        delay: index * 0.05,
      }),
    );
  }
  return shapes;
}
