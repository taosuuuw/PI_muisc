/**
 * 商籁**背景装饰层**（照抄 folia `sonnet/sonnetBackgroundDecor.ts`，AGPL-3.0）。
 *
 * 上游做的是什么：背景层上飘着**一小把装饰粒子**（`type-impact` 24 个、其余镜头 12 个），
 * 按 **6 种种子档位**摆成不同构图 —— 上游注释说得很直白："让相邻镜头读起来像**不同的装饰体系**" ✓。
 * 粒子形状从每种档位自己的**三形状调色板**里按种子取，颜色在 `primary` / `secondary` 之间**交替** ✓。
 *
 * 上游还有"图标精灵"一路（`iconTextures` 非空时把部分粒子换成 sprite）——
 * 那是**可选装饰**（`hasIcons = iconTextures.length > 0`），所以我们这层**只做形状粒子**，
 * 不假装有图标（见 `CREDITS.md`）✓。
 *
 * 本文件只放**纯函数**：给定种子/画布/镜头种类 ⇒ 产出粒子清单。
 * 真正画到屏幕上是渲染层的事（与 `sonnetGuides` 同样的分层）✓。
 */

import { mixSonnetSeed, sonnetHash01 } from './sonnetGeo';

export const SONNET_BACKGROUND_DECOR_VARIANT_COUNT = 6;

export const SONNET_BACKGROUND_DECOR_VARIANTS = [
  'scatter',
  'orbit',
  'edge-band',
  'corner-clusters',
  'constellation',
  'twin-columns',
] as const;

export type SonnetBackgroundDecorVariant = (typeof SONNET_BACKGROUND_DECOR_VARIANTS)[number];

/** 十种装饰形状（与上游 `SonnetDecorShape` 一一对应）✓。 */
export type SonnetDecorShape =
  | 'square'
  | 'diamond'
  | 'sparkle'
  | 'plus'
  | 'ring'
  | 'triangle'
  | 'hexagon'
  | 'bar'
  | 'dot'
  | 'chevron';

/** 六种档位各自的**三形状调色板**（照抄，顺序也照抄）✓。 */
export const SONNET_DECOR_SHAPE_PALETTES: readonly (readonly SonnetDecorShape[])[] = [
  ['square', 'diamond', 'sparkle'],
  ['ring', 'hexagon', 'dot'],
  ['bar', 'plus', 'square'],
  ['triangle', 'diamond', 'plus'],
  ['dot', 'ring', 'sparkle'],
  ['chevron', 'bar', 'hexagon'],
];

/** 粒子数：重字镜（`type-impact`）24，其余 12（照抄上游）✓。 */
export const resolveSonnetDecorParticleCount = (kind: string): number =>
  kind === 'type-impact' ? 24 : 12;

/** 档位（照抄上游：`mixSonnetSeed(seed, 0xc2b2ae35) % 6`）✓。 */
export function resolveSonnetBackgroundDecorVariant(seed: number): number {
  const mixed = mixSonnetSeed(seed, 0xc2b2ae35);
  return ((mixed % SONNET_BACKGROUND_DECOR_VARIANT_COUNT) + SONNET_BACKGROUND_DECOR_VARIANT_COUNT) %
    SONNET_BACKGROUND_DECOR_VARIANT_COUNT;
}

/** 抖动：`(hash01(seed, index, salt) − 0.5) × range`（照抄上游的 `jitter`）✓。 */
const jitter = (seed: number, index: number, salt: number, range: number): number =>
  (sonnetHash01(seed, index, salt) - 0.5) * range;

export interface SonnetDecorPlacement {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

/**
 * 六种档位的摆法（照抄上游 `resolvePlacement`，`hw = 宽/2`、`hh = 高/2`、`radius = min(宽, 高)`）✓。
 *
 * 坐标以**画布中心**为原点（渲染层要么把层居中、要么自己加半个画布 ✓ —— 统一在这里保持"中心原点"）。
 */
export function resolveSonnetDecorPlacement(
  variant: number,
  index: number,
  count: number,
  seed: number,
  width: number,
  height: number,
): SonnetDecorPlacement {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const radius = Math.min(width, height);
  const baseRotation = sonnetHash01(seed, index, 11) * Math.PI * 2;

  switch (variant) {
    case 1: {
      // orbit：奇数/偶数分两圈，绕中心公转，纵向压 0.86。
      const ring = index % 2;
      const orbitRadius = radius * (0.36 + ring * 0.26);
      const angle = (count === 0 ? 0 : index / count) * Math.PI * 4 + jitter(seed, index, 13, 0.35);
      return {
        x: Math.cos(angle) * orbitRadius,
        y: Math.sin(angle) * orbitRadius * 0.86,
        rotation: angle + Math.PI / 2,
      };
    }
    case 2: {
      // edge-band：沿上下两条边带铺开，分两排。
      const side = index % 2 === 0 ? -1 : 1;
      const half = Math.max(1, Math.floor(count / 2));
      const t = (Math.floor(index / 2) + 0.5) / half;
      return {
        x: -halfWidth + width * (0.06 + 0.88 * t) + jitter(seed, index, 17, width * 0.03),
        y: side * halfHeight * 0.78 + jitter(seed, index, 19, height * 0.05),
        rotation: side < 0 ? 0 : Math.PI,
      };
    }
    case 3: {
      // corner-clusters：四角成团。
      const corner = index % 4;
      const signX = corner % 2 === 0 ? -1 : 1;
      const signY = corner < 2 ? -1 : 1;
      return {
        x: signX * halfWidth * 0.68 + jitter(seed, index, 23, width * 0.12),
        y: signY * halfHeight * 0.62 + jitter(seed, index, 29, height * 0.12),
        rotation: baseRotation,
      };
    }
    case 4: {
      // constellation：6×4 网格（星图）。
      const column = index % 6;
      const row = Math.floor(index / 6) % 4;
      return {
        x: -halfWidth * 0.8 + (column / 5) * halfWidth * 1.6 + jitter(seed, index, 31, width * 0.06),
        y: -halfHeight * 0.72 + (row / 3) * halfHeight * 1.44 + jitter(seed, index, 37, height * 0.06),
        rotation: baseRotation,
      };
    }
    case 5: {
      // twin-columns：左右两列。
      const side = index % 2 === 0 ? -1 : 1;
      const half = Math.max(1, Math.ceil(count / 2));
      const t = (Math.floor(index / 2) + 0.5) / half;
      return {
        x: side * halfWidth * 0.74 + jitter(seed, index, 41, width * 0.04),
        y: -halfHeight * 0.8 + t * halfHeight * 1.6 + jitter(seed, index, 43, height * 0.05),
        rotation: side < 0 ? Math.PI : 0,
      };
    }
    default:
      // scatter（0 档，也是缺省）：整幅散点。
      return {
        x: -halfWidth + width * sonnetHash01(seed, index, 47),
        y: -halfHeight + height * sonnetHash01(seed, index, 53),
        rotation: baseRotation,
      };
  }
}

export interface SonnetDecorParticle {
  readonly index: number;
  readonly shape: SonnetDecorShape;
  /** 名义半尺寸（上游 `pSize = 4 + (seed + i) % 12`）✓。 */
  readonly size: number;
  /** `true` 用 `primary`、`false` 用 `secondary`（上游按 `i % 2` 交替）✓。 */
  readonly primary: boolean;
  /** 这个粒子的整体不透明度（上游 `0.55 + hash01(seed, i, 59) × 0.3`）✓。 */
  readonly alpha: number;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

/**
 * 一整层的粒子清单（形状 + 尺寸 + 配色 + 位置 + 自转）✓。
 *
 * 顺序与上游一致：先按 `i` 取"形状/尺寸/颜色/透明度"，再用档位摆法定位 ✓。
 */
export function resolveSonnetDecorParticles(
  seed: number,
  kind: string,
  width: number,
  height: number,
): readonly SonnetDecorParticle[] {
  const variant = resolveSonnetBackgroundDecorVariant(seed);
  const palette = SONNET_DECOR_SHAPE_PALETTES[variant] ?? SONNET_DECOR_SHAPE_PALETTES[0]!;
  const count = resolveSonnetDecorParticleCount(kind);
  const particles: SonnetDecorParticle[] = [];
  for (let index = 0; index < count; index += 1) {
    const shape = palette[(seed + index) % palette.length] ?? palette[0]!;
    const placement = resolveSonnetDecorPlacement(variant, index, count, seed, width, height);
    particles.push({
      index,
      shape,
      size: 4 + ((seed + index) % 12),
      primary: index % 2 === 0,
      alpha: 0.55 + sonnetHash01(seed, index, 59) * 0.3,
      x: placement.x,
      y: placement.y,
      rotation: placement.rotation,
    });
  }
  return particles;
}
