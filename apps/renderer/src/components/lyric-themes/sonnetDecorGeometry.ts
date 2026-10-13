/**
 * 商籁背景装饰的**几何层**：把 `sonnetBackgroundDecor.ts` 给的粒子折算成**可直接下笔的图元**
 * （折线 / 圆），**不引用 Pixi、不碰 DOM** ✓（与 `sonnetGuideGeometry.ts` 同一分工）。
 *
 * === 与 folia 的差异（照实记）===
 * 上游的 `sparkle` 是**四段二次曲线**。我们这里是"折线/圆"这一套原语，
 * 所以 `sparkle` 用**八点星形折线**近似（顶点半径 `p × 1.5`、内凹点 `p × 0.62`）✗ ——
 * **这是我们的近似，不是上游原样**，已登记在 `CREDITS.md` ✓。
 * 其余九种形状（`square/diamond/plus/ring/triangle/hexagon/bar/dot/chevron`）都按上游的点序列与描边参数生成 ✓。
 *
 * 坐标约定：所有点都是**相对粒子中心**的 ✓；粒子的 `rotation` 由渲染层施加，本层不旋转 ✓。
 */

import type { SonnetDecorParticle } from './sonnetBackgroundDecor';

export type SonnetDecorDrawKind = 'fill' | 'stroke';

export interface SonnetDecorDraw {
  readonly kind: SonnetDecorDrawKind;
  /** 扁平点列 `[x0,y0,x1,y1,…]`；圆用 `circle` 时这里是空数组 ✓。 */
  readonly points: readonly number[];
  /** 圆：与 `points` 互斥（`kind === 'fill'` 的实心圆）✓。 */
  readonly circle?: { readonly x: number; readonly y: number; readonly radius: number };
  /** 折线是否闭合（`fill` 一律闭合；`stroke` 的 `chevron` 不闭合）✓。 */
  readonly closed: boolean;
  /** 描边宽度（`kind === 'stroke'` 时有意义）✓。 */
  readonly width: number;
  /** **已经乘过形状系数与粒子 alpha** 的最终不透明度 ✓。 */
  readonly alpha: number;
}

/** 圆用多少段折线（描边圆）✓。 */
const CIRCLE_SEGMENTS = 24;

const circlePoints = (radius: number): number[] => {
  const points: number[] = [];
  for (let index = 0; index < CIRCLE_SEGMENTS; index += 1) {
    const angle = (index / CIRCLE_SEGMENTS) * Math.PI * 2;
    points.push(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  return points;
};

const rectPoints = (halfWidth: number, halfHeight: number): number[] => [
  -halfWidth,
  -halfHeight,
  halfWidth,
  -halfHeight,
  halfWidth,
  halfHeight,
  -halfWidth,
  halfHeight,
];

/**
 * 一颗粒子画成什么（照抄上游 `drawShape` 的**点序列与 alpha 系数**）✓。
 *
 * 上游的系数：`diamond ×0.85`、`sparkle ×1.2`（我们的近似也用 1.2 ✓）、`plus ×0.9`、`ring ×0.9`、
 * `triangle ×0.85`、`hexagon ×1`（描边）、`bar ×0.85`、`dot ×1`、`chevron ×1`、`square ×1` ✓。
 */
export function resolveSonnetDecorGeometry(
  particle: SonnetDecorParticle,
): readonly SonnetDecorDraw[] {
  const size = particle.size;
  const alpha = particle.alpha;
  switch (particle.shape) {
    case 'diamond':
      return [
        {
          kind: 'fill',
          points: [0, -size, size, 0, 0, size, -size, 0],
          closed: true,
          width: 0,
          alpha: alpha * 0.85,
        },
      ];
    case 'square':
      return [
        {
          kind: 'fill',
          points: rectPoints(size / 2, size / 2),
          closed: true,
          width: 0,
          alpha,
        },
      ];
    case 'bar':
      return [
        {
          kind: 'fill',
          points: rectPoints(size, size * 0.18),
          closed: true,
          width: 0,
          alpha: alpha * 0.85,
        },
      ];
    case 'plus': {
      const arm = size * 0.34;
      return [
        {
          kind: 'fill',
          points: rectPoints(arm, size),
          closed: true,
          width: 0,
          alpha: alpha * 0.9,
        },
        {
          kind: 'fill',
          points: rectPoints(size, arm),
          closed: true,
          width: 0,
          alpha: alpha * 0.9,
        },
      ];
    }
    case 'triangle':
      return [
        {
          kind: 'fill',
          points: [0, -size, size * 0.9, size * 0.7, -size * 0.9, size * 0.7],
          closed: true,
          width: 0,
          alpha: alpha * 0.85,
        },
      ];
    case 'ring':
      return [
        {
          kind: 'stroke',
          points: circlePoints(size),
          closed: true,
          width: Math.max(1, size * 0.22),
          alpha: alpha * 0.9,
        },
      ];
    case 'dot':
      return [
        { kind: 'fill', points: [], circle: { x: 0, y: 0, radius: size * 0.34 }, closed: true, width: 0, alpha },
      ];
    case 'hexagon': {
      // 上游：7 个点（首尾同点）、`angle = jπ/3`、`x = sin·size`、`y = −cos·size`，描边 `max(1, size×0.16)`。
      const points: number[] = [];
      for (let corner = 0; corner <= 6; corner += 1) {
        const angle = (corner * Math.PI) / 3;
        points.push(Math.sin(angle) * size, -Math.cos(angle) * size);
      }
      return [
        {
          kind: 'stroke',
          points,
          closed: false,
          width: Math.max(1, size * 0.16),
          alpha,
        },
      ];
    }
    case 'chevron': {
      // 上游：`(−0.5,−0.55) → (0.35,0) → (−0.5,0.55)`（×size），描边 `max(1.5, size×0.2)`。
      return [
        {
          kind: 'stroke',
          points: [
            -0.5 * size,
            -0.55 * size,
            0.35 * size,
            0,
            -0.5 * size,
            0.55 * size,
          ],
          closed: false,
          width: Math.max(1.5, size * 0.2),
          alpha,
        },
      ];
    }
    case 'sparkle': {
      /*
       * ⚠ **我们的近似**：上游是四段二次曲线（顶点半径 `size × 1.5`）。
       * 这里用八点星形折线（外顶点 `1.5 size`、内凹点 `0.62 size`）逼近同一轮廓 ✓（差异已登记）。
       */
      const points: number[] = [];
      for (let vertex = 0; vertex < 8; vertex += 1) {
        const angle = (vertex / 8) * Math.PI * 2;
        const radius = vertex % 2 === 0 ? size * 1.5 : size * 0.62;
        points.push(Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
      return [{ kind: 'fill', points, closed: true, width: 0, alpha: alpha * 1.2 }];
    }
    default:
      return [
        {
          kind: 'fill',
          points: rectPoints(size / 2, size / 2),
          closed: true,
          width: 0,
          alpha,
        },
      ];
  }
}

/** 一层装饰的全部图元（渲染层只管按 `x/y/rotation` 摆放）✓。 */
export interface SonnetDecorDrawItem {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly primary: boolean;
  readonly draws: readonly SonnetDecorDraw[];
}

export function resolveSonnetDecorDrawItems(
  particles: readonly SonnetDecorParticle[],
): readonly SonnetDecorDrawItem[] {
  return particles.map((particle) => ({
    x: particle.x,
    y: particle.y,
    rotation: particle.rotation,
    primary: particle.primary,
    draws: resolveSonnetDecorGeometry(particle),
  }));
}
