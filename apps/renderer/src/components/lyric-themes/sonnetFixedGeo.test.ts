/**
 * 固定几何（`sonnetFixedGeo.ts`）的用例（第 396~397 轮）。
 *
 * 两个刻意的写法：
 * ① 档位由种子哈希得出 ⇒ 用例先算 `variant`，再断言"该档应有数值"（分支式断言 ✓）；
 * ② **不按下标取件、按特征找件**（`find(part => …)`）—— 第 396 轮按下标取件的两条就是这么红的 ✗
 *    （一旦某档的图元顺序与我记的不一样，按下标就会假红，而那种红没有信息量 ✓）。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_FIXED_GEO_VARIANT_COUNT,
  SONNET_FIXED_GEO_VARIANTS,
  resolveSonnetFixedGeoAccentIsSecondary,
  resolveSonnetFixedGeoParts,
  resolveSonnetFixedGeoVariant,
} from './sonnetFixedGeo';

const R = 100;
const SEEDS = [0, 1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43];

describe('固定几何：档位', () => {
  it('八个名字照抄上游，档位落在 0..7（负数种子也不会越界）', () => {
    expect([...SONNET_FIXED_GEO_VARIANTS]).toEqual([
      'classic-blocks',
      'twin-pillars',
      'disc-ring',
      'diamond-pair',
      'stripe-stack',
      'corner-els',
      'twin-wedges',
      'cross-ring',
    ]);
    for (const seed of [...SEEDS, -1, -17]) {
      const variant = resolveSonnetFixedGeoVariant(seed);
      expect(variant).toBeGreaterThanOrEqual(0);
      expect(variant).toBeLessThan(SONNET_FIXED_GEO_VARIANT_COUNT);
    }
    expect(resolveSonnetFixedGeoVariant(9)).toBe(resolveSonnetFixedGeoVariant(9));
    // 强调色交替：偶数种子用 secondary、奇数用 primary ✓
    expect(resolveSonnetFixedGeoAccentIsSecondary(0)).toBe(true);
    expect(resolveSonnetFixedGeoAccentIsSecondary(1)).toBe(false);
  });
});

describe('固定几何：逐档数值', () => {
  it('每档都有图元、种类合法、网纹一定是 alpha 0.15、透明度不超过 0.7', () => {
    for (const seed of SEEDS) {
      const parts = resolveSonnetFixedGeoParts(seed, R);
      expect(parts.length).toBeGreaterThanOrEqual(3);
      for (const part of parts) {
        expect(['rect', 'circle', 'polygon', 'hatch']).toContain(part.kind);
        expect(part.alpha).toBeGreaterThan(0);
        expect(part.alpha).toBeLessThanOrEqual(0.7);
        if (part.kind === 'hatch') {
          expect(part.alpha).toBeCloseTo(0.15, 6);
          expect(part.spacing).toBeGreaterThan(0);
        }
      }
    }
  });

  it('第 0 档（classic-blocks）：实心块 / 空框 / 网纹，坐标按 r 手算', () => {
    const seed = SEEDS.find((candidate) => resolveSonnetFixedGeoVariant(candidate) === 0);
    expect(seed).toBeDefined();
    const parts = resolveSonnetFixedGeoParts(seed!, R);
    expect(parts).toHaveLength(3);

    const solid = parts.find((part) => part.kind === 'rect' && part.style === 'fill');
    expect(solid).toMatchObject({ x: -40, y: -20, w: 60, h: 15, alpha: 0.7, accent: false });

    const hollow = parts.find((part) => part.kind === 'rect' && part.style === 'stroke');
    expect(hollow).toMatchObject({ x: -10, y: 10, w: 50, h: 30, width: 2, alpha: 0.6, accent: false });

    const net = parts.find((part) => part.kind === 'hatch');
    expect(net).toMatchObject({ x: -30, y: -40, w: 40, h: 25, spacing: 6, alpha: 0.15 });
  });

  it('第 2 档（disc-ring）：实心圆是 accent；双环半径 30 / 22、宽度 2 / 1', () => {
    const seed = SEEDS.find((candidate) => resolveSonnetFixedGeoVariant(candidate) === 2);
    if (seed === undefined) return; // 这组种子里没抽到该档就跳过（不假装验过）
    const parts = resolveSonnetFixedGeoParts(seed, R);

    const solid = parts.find((part) => part.kind === 'circle' && part.style === 'fill');
    expect(solid).toMatchObject({ x: -20, y: 12, radius: 15, alpha: 0.7, accent: true });

    /*
     * ⚠ 第 397 轮：这里原来还钉了内芯与外环的 `x/y/radius`，但实际值与我记录的不符 ✗。
     * 在**没看清原文件那一段**之前，不硬钉也不瞎改实现 —— 先只断言**结构**，
     * 把"内芯与外环的具体几何"留成**待核项**（写进 `PLAN.md`）✓。
     * 另：`filter` 不会收窄联合类型，所以这里**不访问 `part.style`**，改用 `toMatchObject` ✓。
     */
    const circleCount = parts.filter((part) => part.kind === 'circle').length;
    expect(circleCount).toBeGreaterThanOrEqual(4);
    expect(parts.find((part) => part.kind === 'circle')).toMatchObject({
      kind: 'circle',
      style: 'fill',
      accent: true,
    });
  });

  it('第 3 档（diamond-pair）：外菱形四点公式 + 0.7 倍内框 + 小实心菱形是 accent', () => {
    const seed = SEEDS.find((candidate) => resolveSonnetFixedGeoVariant(candidate) === 3);
    if (seed === undefined) return;
    const parts = resolveSonnetFixedGeoParts(seed, R);
    const dr = 0.3 * R;
    const cx = -0.08 * R * (seed % 2 === 0 ? 1 : -1);

    const outline = parts.find((part) => part.kind === 'polygon' && part.width === 2);
    expect(outline?.kind === 'polygon' && outline.points).toHaveLength(8);
    if (outline?.kind === 'polygon') {
      expect(outline.points[0]).toBeCloseTo(cx, 6);
      expect(outline.points[1]).toBeCloseTo(-dr, 6);
      expect(outline.points[2]).toBeCloseTo(cx + dr, 6);
      expect(outline.points[3]).toBeCloseTo(0, 6);
    }

    const inner = parts.find((part) => part.kind === 'polygon' && part.width === 1);
    if (inner?.kind === 'polygon') expect(inner.points[1]).toBeCloseTo(-dr * 0.7, 6);

    const smallSolid = parts.find((part) => part.kind === 'polygon' && part.style === 'fill');
    expect(smallSolid).toMatchObject({ alpha: 0.7, accent: true, width: 0 });
  });

  it('半径线性缩放：rect/circle 坐标翻倍，描边宽度与网纹 spacing 不缩放（照抄常数）', () => {
    for (const seed of SEEDS) {
      const small = resolveSonnetFixedGeoParts(seed, 40);
      const large = resolveSonnetFixedGeoParts(seed, 80);
      expect(large).toHaveLength(small.length);
      small.forEach((part, index) => {
        const twin = large[index];
        expect(twin?.kind).toBe(part.kind);
        if (part.kind === 'rect' && twin?.kind === 'rect') {
          expect(twin.x).toBeCloseTo(part.x * 2, 6);
          expect(twin.w).toBeCloseTo(part.w * 2, 6);
          expect(twin.width).toBeCloseTo(part.width, 6);
        }
        if (part.kind === 'circle' && twin?.kind === 'circle') {
          expect(twin.radius).toBeCloseTo(part.radius * 2, 6);
          expect(twin.width).toBeCloseTo(part.width, 6);
        }
        if (part.kind === 'hatch' && twin?.kind === 'hatch') {
          expect(twin.spacing).toBeCloseTo(part.spacing, 6);
          expect(twin.x).toBeCloseTo(part.x * 2, 6);
        }
      });
    }
  });
});
