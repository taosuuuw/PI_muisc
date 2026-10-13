/**
 * 商籁**重镜头固定几何**（照抄 folia `sonnet/sonnetFixedGeoVariants.ts`，AGPL-3.0）。
 *
 * 上游做的是什么：重镜头（`type-impact` / `fragment-collage`）里有一组**"印刷块"**图形 ——
 * 实心块 + 空心描边 + **斜线网纹**；这些块**相对相机反向旋转**，所以看起来像"钉在画面上的稳定印刷块" ✓。
 * 八种构图由种子选（`mixSonnetSeed(seed, 0x85ebca6b) % 8`），强调色按 `seed % 2` 在 `primary`/`secondary` 间交替 ✓。
 *
 * 本文件只出**纯数据**（图元清单），不碰 Pixi；真正的画法（含网纹的**遮罩裁剪**）在渲染层 ✓。
 *
 * === 与 folia 的差异（照实记）===
 * · 上游的**斜线网纹**用"白矩形 `mask`"裁剪（只让斜线出现在指定矩形内）✗；
 *   我们这里把网纹出成 `{x, y, w, h, spacing}` 这样的**区域描述**，
 *   渲染层若一时做不了遮罩，可以先按区域画线（边缘会略有出入）—— **这条差异登记在 `CREDITS.md`** ✓；
 * · 第 5 档 `corner-els` 与第 6 档 `twin-wedges` 的**内部小矩形/三角顶点**，
 *   我当时只取到概括写法（`arm`/`thick`/`wx`/`hx` 这些量纲是明确的，个别偏移量是推断的）✗
 *   ⇒ 这两档标注为**近似**（下面注释里都写了"近似"二字）✓，其余六档是照抄数值 ✓。
 */

import { mixSonnetSeed } from './sonnetGeo';

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

export type SonnetFixedGeoVariant = (typeof SONNET_FIXED_GEO_VARIANTS)[number];

export type SonnetFixedGeoStyle = 'fill' | 'stroke';

interface SonnetFixedGeoBase {
  readonly style: SonnetFixedGeoStyle;
  readonly alpha: number;
  /** 描边宽度（`style === 'fill'` 时无意义）✓。 */
  readonly width: number;
  /** `true` 用强调色（上游的 `accent`）、`false` 用 `primary` ✓。 */
  readonly accent: boolean;
}

/** 矩形（x/y 是**左上角**，与上游 `rect(x, y, w, h)` 一致）✓。 */
export interface SonnetFixedGeoRect extends SonnetFixedGeoBase {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SonnetFixedGeoCircle extends SonnetFixedGeoBase {
  readonly kind: 'circle';
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface SonnetFixedGeoPolygon extends SonnetFixedGeoBase {
  readonly kind: 'polygon';
  readonly points: readonly number[];
}

/** 斜线网纹区域（渲染层按 `spacing` 画 45° 斜线，并尽量裁进这个矩形）✓。 */
export interface SonnetFixedGeoHatch {
  readonly kind: 'hatch';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly spacing: number;
  readonly alpha: number;
  readonly accent: boolean;
}

export type SonnetFixedGeoPart =
  | SonnetFixedGeoRect
  | SonnetFixedGeoCircle
  | SonnetFixedGeoPolygon
  | SonnetFixedGeoHatch;

/** 档位（照抄上游：`mixSonnetSeed(seed, 0x85ebca6b) % 8`）✓。 */
export function resolveSonnetFixedGeoVariant(seed: number): number {
  const mixed = mixSonnetSeed(seed, 0x85ebca6b);
  return ((mixed % SONNET_FIXED_GEO_VARIANT_COUNT) + SONNET_FIXED_GEO_VARIANT_COUNT) %
    SONNET_FIXED_GEO_VARIANT_COUNT;
}

/** 网纹统一画法：`{x,y,w,h,spacing}`，描边宽度 1、alpha 0.15（照抄上游 `drawHatching`）✓。 */
const hatch = (x: number, y: number, w: number, h: number, spacing: number): SonnetFixedGeoHatch => ({
  kind: 'hatch',
  x,
  y,
  w,
  h,
  spacing,
  alpha: 0.15,
  accent: false,
});

const fillRect = (x: number, y: number, w: number, h: number, alpha: number, accent: boolean): SonnetFixedGeoRect => ({
  kind: 'rect',
  style: 'fill',
  x,
  y,
  w,
  h,
  width: 0,
  alpha,
  accent,
});

const strokeRect = (x: number, y: number, w: number, h: number, width: number, alpha: number): SonnetFixedGeoRect => ({
  kind: 'rect',
  style: 'stroke',
  x,
  y,
  w,
  h,
  width,
  alpha,
  accent: false,
});

const circlePart = (
  x: number,
  y: number,
  radius: number,
  style: SonnetFixedGeoStyle,
  width: number,
  alpha: number,
  accent: boolean,
): SonnetFixedGeoCircle => ({ kind: 'circle', x, y, radius, style, width, alpha, accent });

/** 菱形（以 `(cx, cy)` 为中心、半径 `radius`）✓ —— 上游用 `moveTo/lineTo` 四点闭合。 */
const diamond = (
  cx: number,
  cy: number,
  radius: number,
  style: SonnetFixedGeoStyle,
  width: number,
  alpha: number,
  accent: boolean,
): SonnetFixedGeoPolygon => ({
  kind: 'polygon',
  points: [cx, cy - radius, cx + radius, cy, cx, cy + radius, cx - radius, cy],
  style,
  width,
  alpha,
  accent,
});

const triangle = (
  points: readonly number[],
  style: SonnetFixedGeoStyle,
  width: number,
  alpha: number,
  accent: boolean,
): SonnetFixedGeoPolygon => ({ kind: 'polygon', points, style, width, alpha, accent });

/**
 * 八种构图的图元清单（坐标**已乘 `radius`**，与上游的 `r` 单位一致）✓。
 *
 * 上游入口：`buildSonnetFixedGeo({ pixi, layer, variant, radius, seed, primary, secondary })`，
 * 其中 `accent = seed % 2 === 0 ? secondary : primary`、`switch (variant % 8)`、`default` 走第 0 档 ✓。
 */
export function resolveSonnetFixedGeoParts(seed: number, radius: number): readonly SonnetFixedGeoPart[] {
  const variant = resolveSonnetFixedGeoVariant(seed);
  const r = radius;
  const direction = seed % 2 === 0 ? 1 : -1;

  switch (variant) {
    case 1:
      // twin-pillars：一根实心柱（含内衬）+ 一根空框柱（含内框）+ 网纹。
      return [
        fillRect(-0.34 * r, -0.28 * r, 0.12 * r, 0.56 * r, 0.65, true),
        fillRect(-0.34 * r + 0.035 * r, -0.28 * r + 0.035 * r, 0.05 * r, 0.49 * r, 0.35, false),
        strokeRect(0.06 * r, -0.34 * r, 0.28 * r, 0.68 * r, 2, 0.6),
        strokeRect(0.06 * r + 0.04 * r, -0.34 * r + 0.04 * r, 0.2 * r, 0.6 * r, 1, 0.3),
        hatch(-0.14 * r, -0.2 * r, 0.12 * r, 0.4 * r, 5),
      ];
    case 2:
      // disc-ring：实心小圆（含内芯）+ 同心双环 + 网纹。
      return [
        circlePart(-0.2 * r, 0.12 * r, 0.15 * r, 'fill', 0, 0.7, true),
        circlePart(-0.2 * r, 0.12 * r, 0.06 * r, 'fill', 0, 0.5, false),
        circlePart(0.14 * r, -0.06 * r, 0.3 * r, 'stroke', 2, 0.6, false),
        circlePart(0.14 * r, -0.06 * r, 0.22 * r, 'stroke', 1, 0.3, false),
        hatch(0.02 * r, -0.14 * r, 0.24 * r, 0.16 * r, 5),
      ];
    case 3: {
      // diamond-pair：外菱形（含 0.7 倍内框）+ 偏侧小实心菱形 + 网纹。
      const dr = 0.3 * r;
      const cx = -0.08 * r * direction;
      const sr = 0.11 * r;
      const sx = 0.3 * r * direction;
      return [
        diamond(cx, 0, dr, 'stroke', 2, 0.6, false),
        diamond(cx, 0, dr * 0.7, 'stroke', 1, 0.3, false),
        diamond(sx, -0.2 * r, sr, 'fill', 0, 0.7, true),
        hatch(sx - sr * 0.8, 0.16 * r, sr * 1.6, sr * 1.2, 4),
      ];
    }
    case 4:
      // stripe-stack：三条粗细不同的横条（一实一框一细）+ 竖条网纹。
      return [
        fillRect(-0.36 * r * direction - 0.2 * r, -0.26 * r, 0.56 * r, 0.09 * r, 0.7, true),
        strokeRect(-0.28 * r, -0.06 * r, 0.56 * r, 0.16 * r, 2, 0.6),
        fillRect(-0.2 * r * direction, 0.2 * r, 0.4 * r, 0.045 * r, 0.5, false),
        hatch(0.26 * r * direction, -0.3 * r, 0.12 * r, 0.6 * r, 5),
      ];
    case 5: {
      // corner-els（**近似**）：两组 L 形角标（一实一框镜像）+ 中心方框 + 网纹。
      const arm = 0.24 * r;
      const thick = 0.07 * r;
      const sx = direction;
      return [
        // 左上 L：竖条 + 横条（实心 accent）
        fillRect(-arm * sx - thick / 2, -arm, thick, arm, 0.7, true),
        fillRect(-arm * sx - thick / 2, -arm, arm, thick, 0.7, true),
        // 右下 L：竖条 + 横条（描边 primary，用方向镜像）
        strokeRect(arm * sx - thick / 2, 0, thick, arm, 2, 0.55),
        strokeRect(arm * sx - arm, arm - thick, arm, thick, 2, 0.55),
        strokeRect(-0.13 * r, -0.13 * r, 0.26 * r, 0.26 * r, 2, 0.6),
        hatch(-0.09 * r * direction, 0.02 * r, 0.16 * r, 0.1 * r, 4),
      ];
    }
    case 6: {
      // twin-wedges（**近似**）：实心上楔 + 空心下楔（含内三角）+ 网纹。
      const wx = -0.06 * r * direction;
      const hx = 0.06 * r * direction;
      const halfWidth = 0.24 * r;
      return [
        triangle(
          [wx, -0.3 * r, wx + halfWidth, 0.02 * r, wx - halfWidth, 0.02 * r],
          'fill',
          0,
          0.6,
          true,
        ),
        triangle(
          [hx, 0.3 * r, hx + halfWidth, -0.02 * r, hx - halfWidth, -0.02 * r],
          'stroke',
          2,
          0.6,
          false,
        ),
        triangle(
          [hx, 0.3 * r - 0.06 * r, hx + halfWidth * 0.62, -0.02 * r + 0.03 * r, hx - halfWidth * 0.62, -0.02 * r + 0.03 * r],
          'stroke',
          1,
          0.3,
          false,
        ),
        hatch(-0.3 * r * direction - 0.05 * r, 0.1 * r, 0.2 * r, 0.18 * r, 5),
      ];
    }
    case 7: {
      // cross-ring：十字（含竖横两条）+ 双环 + 网纹。
      const cx = (seed % 3 - 1) * 0.08 * r;
      const arm = 0.17 * r;
      const thick = 0.075 * r;
      return [
        fillRect(cx - thick / 2, -arm, thick, arm * 2, 0.7, true),
        fillRect(cx - arm, -thick / 2, arm * 2, thick, 0.7, true),
        circlePart(cx, 0, 0.3 * r, 'stroke', 2, 0.6, false),
        circlePart(cx, 0, 0.36 * r, 'stroke', 1, 0.25, false),
        hatch(cx + 0.18 * r, 0.14 * r, 0.16 * r, 0.16 * r, 4),
      ];
    }
    default:
      // 0 classic-blocks（也是 default）：一块实心 + 一块空框 + 网纹 ✓。
      return [
        fillRect(-0.4 * r, -0.2 * r, 0.6 * r, 0.15 * r, 0.7, false),
        strokeRect(-0.1 * r, 0.1 * r, 0.5 * r, 0.3 * r, 2, 0.6),
        hatch(-0.3 * r, -0.4 * r, 0.4 * r, 0.25 * r, 6),
      ];
  }
}

/** 这一档用的强调色是 `secondary` 还是 `primary`（照抄上游 `accent` 的判据）✓。 */
export const resolveSonnetFixedGeoAccentIsSecondary = (seed: number): boolean => seed % 2 === 0;

/* ------------------------------------------------------------------ *
 * 网纹 → 斜线清单
 * ------------------------------------------------------------------ */

export interface SonnetFixedGeoLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly alpha: number;
}

/**
 * 把一块网纹区域展开成 **45° 斜线清单** —— 照抄上游 `drawHatching` 的循环：
 * `for (i = −w; i < w + h; i += spacing) moveTo(x + i, y) → lineTo(x + i + h, y + h)` ✓
 * （所以每条线的水平跨度正好等于区域高度 `h` ✓，起点从 `x − w` 一路铺到 `x + w + h` ✓）。
 *
 * ⚠ 上游用**白矩形遮罩**把这些线裁进区域里；我们这边出的是"线的原始清单 + 区域描述"，
 * 渲染层若做不了遮罩就会**溢出区域**（差异已登记 `CREDITS.md`）✗ —— 但线本身与上游**同一条公式** ✓。
 */
export function resolveSonnetFixedGeoHatchLines(
  part: SonnetFixedGeoHatch,
): readonly SonnetFixedGeoLine[] {
  const lines: SonnetFixedGeoLine[] = [];
  if (part.spacing <= 0) return lines;
  for (let offset = -part.w; offset < part.w + part.h; offset += part.spacing) {
    lines.push({
      x1: part.x + offset,
      y1: part.y,
      x2: part.x + offset + part.h,
      y2: part.y + part.h,
      alpha: part.alpha,
    });
  }
  return lines;
}

/** 展开后的"线"图元（`kind: 'line'`）✓。 */
export interface SonnetFixedGeoLineItem {
  readonly kind: 'line';
  readonly line: SonnetFixedGeoLine;
}

/** 逐档把网纹都展开（其余图元原样保留），渲染层按 `kind` 分派即可 ✓。 */
export function resolveSonnetFixedGeoDraws(
  parts: readonly SonnetFixedGeoPart[],
): readonly (SonnetFixedGeoPart | SonnetFixedGeoLineItem)[] {
  return parts.flatMap((part): (SonnetFixedGeoPart | SonnetFixedGeoLineItem)[] =>
    part.kind === 'hatch'
      ? resolveSonnetFixedGeoHatchLines(part).map(
          (line): SonnetFixedGeoLineItem => ({ kind: 'line', line }),
        )
      : [part],
  );
}
