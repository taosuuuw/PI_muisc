/**
 * 装饰性开放边框的**图元清单**（照抄 folia `sonnet/sonnetFrameDecor.ts`，AGPL-3.0）。
 *
 * 与 `sonnetFrameDecor.ts` 分工：那边管**选择与几何常数** ✓，这边把几何**展开成可直接画的图元** ✓
 * （线段 / 多边形 / 圆 ✓，都带 `alpha` 与"颜色键" ✓ —— 颜色由渲染层按主题填 ✓）。
 *
 * === 与 folia 的差异（照实记）===
 * · 上游**边是"逐边生长"**的：`sideProgress` 决定每条边画到哪 ✓ ⇒ 我们这里出的是**"部分线段"**
 *   （起点 → 按进度插值出的端点 ✓）；
 * · 上游**角饰**四档里，**第 2 档（`brackets`）的内层括号臂长**与
 *   **第 3 档（`corner-triangles`）三角形的具体顶点** ✗，我只取到概括写法（`arm` / `size` 与"朝外的等腰三角、
 *   方向用 ±1/√2" ✓）⇒ 这两处**标注为近似** ✓（其余档的半径/偏移/alpha 都是照抄 ✓）；
 * · 上游的**虚线档**是"在已生长的那段里只画完整的虚线" ✓ ⇒ 我们这里**照这个语义**展开成多条短线 ✓
 *   （`dash`/`dashGap` 来自 `sonnetFrameDecor.ts` ✓）；
 * · **`brackets` 档的菱形挂在"四边中点"**（不是四角 ✗）⇒ 本文件把它作为**独立的边中点图元**输出 ✓。
 */

import {
  SONNET_FRAME_DECOR_ORNAMENT_KINDS,
  resolveSonnetFrameDecorGeometry,
  resolveSonnetFrameDecorOrnamentProgress,
  resolveSonnetFrameDecorSideProgress,
  type SonnetFrameDecorGeometry,
  type SonnetFrameDecorOrnamentKind,
} from './sonnetFrameDecor';

const SQRT_HALF = Math.SQRT1_2;

/** 图元用哪种颜色（渲染层按主题映射 ✓）。 */
export type SonnetFrameDecorColorKey = 'frame' | 'ornament' | 'white';

export type SonnetFrameDecorDraw =
  | {
      readonly kind: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly width: number;
      readonly alpha: number;
      readonly colorKey: SonnetFrameDecorColorKey;
    }
  | {
      readonly kind: 'polygon';
      readonly points: readonly number[];
      readonly closed: boolean;
      readonly width: number;
      readonly alpha: number;
      readonly colorKey: SonnetFrameDecorColorKey;
    }
  | {
      readonly kind: 'circle';
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly width: number;
      readonly alpha: number;
      readonly colorKey: SonnetFrameDecorColorKey;
    };

interface Corner {
  readonly x: number;
  readonly y: number;
  /** 朝**画面内侧**的方向（±1 ✓）。 */
  readonly sx: number;
  readonly sy: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 四个角（左上 → 右上 → 右下 → 左下 ✓），`sx/sy` 指向内侧 ✓。 */
export function resolveSonnetFrameDecorCorners(geometry: SonnetFrameDecorGeometry): readonly Corner[] {
  const { halfW, halfH } = geometry;
  return [
    { x: -halfW, y: -halfH, sx: 1, sy: 1 },
    { x: halfW, y: -halfH, sx: -1, sy: 1 },
    { x: halfW, y: halfH, sx: -1, sy: -1 },
    { x: -halfW, y: halfH, sx: 1, sy: -1 },
  ];
}

/** 四条边（上 → 右 → 下 → 左 ✓），两端各按 `cornerGap` 内缩 ✓（"四角永不闭合" ✓）。 */
function resolveSides(geometry: SonnetFrameDecorGeometry): readonly (readonly [number, number, number, number])[] {
  const { halfW, halfH, cornerGap: gap } = geometry;
  return [
    [-halfW + gap, -halfH, halfW - gap, -halfH],
    [halfW, -halfH + gap, halfW, halfH - gap],
    [halfW - gap, halfH, -halfW + gap, halfH],
    [-halfW, halfH - gap, -halfW, -halfH + gap],
  ];
}

/** 边长（用于虚线条数 ✓）。 */
const sideLength = (side: readonly [number, number, number, number]): number =>
  Math.hypot(side[2] - side[0], side[3] - side[1]);

/**
 * 把"部分生长的一段"展开成图元 ✓：不虚线 ⇒ 一条线段 ✓；虚线 ⇒ 只画**完整**的若干小段 ✓
 * （上游语义："只画已经生长到的那段里完整的虚线" ✓）。
 */
function buildSides(
  geometry: SonnetFrameDecorGeometry,
  eased: number,
  withDashes: boolean,
): SonnetFrameDecorDraw[] {
  const draws: SonnetFrameDecorDraw[] = [];
  resolveSides(geometry).forEach((side, index) => {
    const progress = resolveSonnetFrameDecorSideProgress(eased, index);
    if (progress <= 0) return;
    const [x1, y1, x2, y2] = side;
    const endX = x1 + (x2 - x1) * progress;
    const endY = y1 + (y2 - y1) * progress;

    if (!withDashes) {
      draws.push({
        kind: 'line',
        x1,
        y1,
        x2: endX,
        y2: endY,
        width: geometry.strokeWidth,
        alpha: 0.85,
        colorKey: 'frame',
      });
      return;
    }

    // 虚线：沿已生长的长度按 (dash + gap) 铺，**只铺完整的小段** ✓
    const drawn = sideLength(side) * progress;
    const stride = geometry.dash + geometry.dashGap;
    const count = Math.floor(drawn / stride);
    const ux = (x2 - x1) / sideLength(side);
    const uy = (y2 - y1) / sideLength(side);
    for (let i = 0; i < count; i += 1) {
      const start = i * stride;
      const stop = start + geometry.dash;
      draws.push({
        kind: 'line',
        x1: x1 + ux * start,
        y1: y1 + uy * start,
        x2: x1 + ux * stop,
        y2: y1 + uy * stop,
        width: geometry.strokeWidth,
        alpha: 0.85,
        colorKey: 'frame',
      });
    }
  });
  return draws;
}

/** 四角角饰 ✓（四档各按上游写法；`brackets` 的内层臂长与 `corner-triangles` 的顶点为**近似** ✓）。 */
function buildOrnaments(
  geometry: SonnetFrameDecorGeometry,
  eased: number,
): SonnetFrameDecorDraw[] {
  const draws: SonnetFrameDecorDraw[] = [];
  const kind: SonnetFrameDecorOrnamentKind = geometry.ornamentKind;
  const { pad, strokeWidth } = geometry;

  if (kind === 'brackets') {
    // 这一档的菱形挂在"边中点"上 ⇒ 与四角无关，先单独处理 ✓
    const midSize = Math.min(7, Math.max(3.5, pad * 0.45));
    resolveSides(geometry).forEach((side) => {
      const mx = (side[0] + side[2]) / 2;
      const my = (side[1] + side[3]) / 2;
      const progress = clamp01((eased - 0.35) / 0.55);
      if (progress <= 0) return;
      draws.push({
        kind: 'polygon',
        points: [mx, my - midSize * progress, mx + midSize * progress, my, mx, my + midSize * progress, mx - midSize * progress, my],
        closed: true,
        width: 0,
        alpha: 0.85 * progress,
        colorKey: 'ornament',
      });
    });
  }

  resolveSonnetFrameDecorCorners(geometry).forEach((corner, index) => {
    const op = resolveSonnetFrameDecorOrnamentProgress(eased, index);
    if (op <= 0) return;
    const { x, y, sx, sy } = corner;

    if (kind === 'corner-ticks') {
      const arm = Math.min(12, Math.max(5, pad * 0.8));
      const offset = 3;
      const alpha = 0.9 * Math.min(1, op);
      draws.push({
        kind: 'line',
        x1: x + sx * offset,
        y1: y + sy * offset,
        x2: x + sx * (offset + arm),
        y2: y + sy * offset,
        width: strokeWidth,
        alpha,
        colorKey: 'ornament',
      });
      draws.push({
        kind: 'line',
        x1: x + sx * offset,
        y1: y + sy * offset,
        x2: x + sx * offset,
        y2: y + sy * (offset + arm),
        width: strokeWidth,
        alpha,
        colorKey: 'ornament',
      });
      return;
    }

    if (kind === 'corner-flowers') {
      const radius = Math.min(9, Math.max(4, pad * 0.55));
      const petal = radius * 0.44 * op;
      const petals: readonly (readonly [number, number])[] = [
        [x - radius, y],
        [x + radius, y],
        [x, y - radius],
        [x, y + radius],
      ];
      petals.forEach(([px, py]) => {
        draws.push({
          kind: 'circle',
          x: px,
          y: py,
          radius: petal,
          width: 0,
          alpha: 0.85,
          colorKey: 'ornament',
        });
      });
      draws.push({
        kind: 'circle',
        x,
        y,
        radius: radius * 0.3 * op,
        width: 0,
        alpha: 0.5,
        colorKey: 'white',
      });
      return;
    }

    if (kind === 'brackets') {
      const arm = Math.min(14, Math.max(6, pad));
      const offset = 2.5;
      const innerArm = arm * 0.62; // **近似**：上游内层臂长没取到确切比例 ✗
      // 外层：直角括号（两条线，都朝内侧 ✓）
      const outerAlpha = 0.9 * Math.min(1, op);
      draws.push({
        kind: 'line',
        x1: x + sx * offset,
        y1: y + sy * (offset + arm),
        x2: x + sx * offset,
        y2: y + sy * offset,
        width: strokeWidth * 1.4,
        alpha: outerAlpha,
        colorKey: 'ornament',
      });
      draws.push({
        kind: 'line',
        x1: x + sx * offset,
        y1: y + sy * offset,
        x2: x + sx * (offset + arm),
        y2: y + sy * offset,
        width: strokeWidth * 1.4,
        alpha: outerAlpha,
        colorKey: 'ornament',
      });
      // 内层：同样形状、更细更淡 ✓
      const innerAlpha = 0.5 * Math.min(1, op);
      const innerOffset = offset + 3;
      draws.push({
        kind: 'line',
        x1: x + sx * innerOffset,
        y1: y + sy * (innerOffset + innerArm),
        x2: x + sx * innerOffset,
        y2: y + sy * innerOffset,
        width: strokeWidth * 0.8,
        alpha: innerAlpha,
        colorKey: 'ornament',
      });
      draws.push({
        kind: 'line',
        x1: x + sx * innerOffset,
        y1: y + sy * innerOffset,
        x2: x + sx * (innerOffset + innerArm),
        y2: y + sy * innerOffset,
        width: strokeWidth * 0.8,
        alpha: innerAlpha,
        colorKey: 'ornament',
      });
      return;
    }

    // corner-triangles（**近似**：上游只说"朝外的等腰三角 + 方向用 ±1/√2" ✗）
    const size = Math.min(9, Math.max(4, pad * 0.6)) * op;
    const offset = 2;
    draws.push({
      kind: 'polygon',
      points: [
        x + sx * offset,
        y + sy * offset,
        x + sx * offset + sx * size * SQRT_HALF * 2,
        y + sy * offset,
        x + sx * offset,
        y + sy * offset + sy * size * SQRT_HALF * 2,
      ],
      closed: true,
      width: 0,
      alpha: 0.8,
      colorKey: 'ornament',
    });
    draws.push({
      kind: 'circle',
      x,
      y,
      radius: strokeWidth,
      width: 0,
      alpha: 0.9 * Math.min(1, op),
      colorKey: 'ornament',
    });
  });

  return draws;
}

export interface SonnetFrameDecorFrameInput {
  readonly fontSize: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly variant: number;
  /** 0~1 的**原始**进度（缓动由渲染层套 ✓）。 */
  readonly eased: number;
}

/** 一帧的全部图元 ✓（先四边、再角饰 ⇒ 画序与上游一致：边先长、角饰后弹 ✓）。 */
export function resolveSonnetFrameDecorDraws(
  input: SonnetFrameDecorFrameInput,
): readonly SonnetFrameDecorDraw[] {
  const geometry = resolveSonnetFrameDecorGeometry(input);
  const eased = clamp01(input.eased);
  const withDashes =
    input.variant % SONNET_FRAME_DECOR_ORNAMENT_KINDS.length ===
    SONNET_FRAME_DECOR_ORNAMENT_KINDS.indexOf('corner-triangles');
  return [...buildSides(geometry, eased, withDashes), ...buildOrnaments(geometry, eased)];
}
