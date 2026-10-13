/**
 * 「普通歌词背后的固定几何」（`sonnetTextFixedGeo.ts`）的用例（第 471 轮补）。
 * 手算基准：`fontSize 40 / layoutWidth 1000`；
 * `seed 1 + 合唱` ⇒ `s = 1.5 + 0.3 = 1.8`；`seed 0 + 非合唱` ⇒ `s = 1`。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_TEXT_FIXED_GEO_HOLLOW_VARIANTS,
  SONNET_TEXT_FIXED_GEO_MUSIC_STEP_HEIGHTS,
  SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS,
  resolveSonnetTextFixedGeoDraws,
  resolveSonnetTextFixedGeoGeometry,
  resolveSonnetTextFixedGeoHatchLines,
  resolveSonnetTextFixedGeoPlan,
  resolveSonnetTextFixedGeoRotation,
  type SonnetTextFixedGeoDraw,
  type SonnetTextFixedGeoPlan,
} from './sonnetTextFixedGeo';

const geometryFor = (seed: number, isChorusEffect: boolean) =>
  resolveSonnetTextFixedGeoGeometry({ seed, isChorusEffect, fontSize: 40, layoutWidth: 1000 });

const planFor = (seed: number, isChorusEffect: boolean) =>
  resolveSonnetTextFixedGeoPlan(seed, isChorusEffect);

const drawsFor = (plan: SonnetTextFixedGeoPlan, geometry: ReturnType<typeof geometryFor>) =>
  resolveSonnetTextFixedGeoDraws(plan, {
    ...geometry,
    rotation: resolveSonnetTextFixedGeoRotation(plan),
  });

describe('背后几何：选择判据', () => {
  it('四种变体与三种变体各自成表（4 + 3）', () => {
    expect([...SONNET_TEXT_FIXED_GEO_HOLLOW_VARIANTS]).toEqual([
      'straight-frame',
      'rotated-frame',
      'orbit-crosshair',
      'split-arches',
    ]);
    expect([...SONNET_TEXT_FIXED_GEO_SOLID_VARIANTS]).toEqual([
      'orb-hatch',
      'music-steps',
      'bent-lines',
    ]);
    expect(SONNET_TEXT_FIXED_GEO_MUSIC_STEP_HEIGHTS).toEqual([
      0.24, 0.35, 0.2, 0.82, 0.3, 0.1, 0.23, 0.16,
    ]);
  });

  it('合唱镜：chorusSeed 0..8 全走 hollow（divisor 10 / offset chorusSeed）', () => {
    expect(planFor(0, true)).toEqual({ category: 'hollow', variant: 'straight-frame' }); // 0 + 0
    expect(planFor(1, true)).toEqual({ category: 'hollow', variant: 'rotated-frame' }); // 0 + 1
    expect(planFor(2, true)).toEqual({ category: 'hollow', variant: 'orbit-crosshair' }); // 0 + 2
    expect(planFor(3, true)).toEqual({ category: 'hollow', variant: 'split-arches' }); // 0 + 3
    expect(planFor(12, true)).toEqual({ category: 'hollow', variant: 'split-arches' }); // 1 + 2
    for (let seed = 0; seed < 9; seed += 1) {
      expect(planFor(seed, true).category).toBe('hollow');
    }
  });

  it('合唱镜：chorusSeed 9（即 seed 个位为 9）走 solid，按 floor(seed / 10) % 3 取档', () => {
    expect(planFor(9, true)).toEqual({ category: 'solid', variant: 'orb-hatch' }); // 0
    expect(planFor(19, true)).toEqual({ category: 'solid', variant: 'music-steps' }); // 1
    expect(planFor(29, true)).toEqual({ category: 'solid', variant: 'bent-lines' }); // 2
    expect(planFor(39, true)).toEqual({ category: 'solid', variant: 'orb-hatch' }); // 3 % 3 = 0
  });

  it('非合唱镜：legacyType 1 / 2 走 hollow（divisor 4 / offset legacyType），0 / 3 走 solid', () => {
    expect(planFor(1, false)).toEqual({ category: 'hollow', variant: 'rotated-frame' }); // 0 + 1
    expect(planFor(2, false)).toEqual({ category: 'hollow', variant: 'orbit-crosshair' }); // 0 + 2
    expect(planFor(6, false)).toEqual({ category: 'hollow', variant: 'split-arches' }); // 1 + 2
    expect(planFor(0, false)).toEqual({ category: 'solid', variant: 'orb-hatch' });
    expect(planFor(3, false)).toEqual({ category: 'solid', variant: 'orb-hatch' });
    expect(planFor(4, false)).toEqual({ category: 'solid', variant: 'music-steps' }); // 1
    expect(planFor(8, false)).toEqual({ category: 'solid', variant: 'bent-lines' }); // 2
  });

  it('负种子也稳（取模都做了正化，不会再取到 undefined）', () => {
    /*
     * ⚠ 第 472 轮修：原来这两条写的是"负数种子 == 某个正数种子" ✗ —— **那个期望本身就错** ✓：
     * `seed = −1` 的 `legacyType = ((−1 % 4) + 4) % 4 = 3` ⇒ 走 solid，
     * 而 `floor(−1 / 4) = −1` ⇒ 正化后下标 `((−1 % 3) + 3) % 3 = 2` ⇒ **bent-lines** ✓；
     * `seed = 3` 则是 solid、`floor(3 / 4) = 0` ⇒ 下标 0 ⇒ **orb-hatch** ✓ ⇒ **两者本来就不相同** ✓。
     * 所以改成断言"**正化后的确切档**"，并把一段负~正区间**全扫一遍**（永不为 undefined ✓）。
     */
    expect(planFor(-1, false)).toEqual({ category: 'solid', variant: 'bent-lines' });
    expect(planFor(-1, true)).toEqual({ category: 'solid', variant: 'bent-lines' });
    for (let seed = -12; seed <= 12; seed += 1) {
      for (const chorus of [false, true]) {
        const plan = planFor(seed, chorus);
        expect(plan.variant).toBeDefined();
        expect(plan.category === 'hollow' || plan.category === 'solid').toBe(true);
      }
    }
  });
});

describe('背后几何：尺寸/透明度', () => {
  it('合唱 seed 1：s 1.8 ⇒ 216 × 144、alpha 0.43、primary、内框关', () => {
    const geometry = geometryFor(1, true);
    expect(geometry.scaleMultiplier).toBeCloseTo(1.8, 6);
    expect(geometry.width).toBeCloseTo(216, 6); // max(180, 216)
    expect(geometry.height).toBeCloseTo(144, 6); // max(129.6, 144)
    expect(geometry.alpha).toBeCloseTo(0.43, 6); // 0.4 + 0.03
    expect(geometry.accentIsSecondary).toBe(false);
    expect(geometry.innerFrame).toBe(false);
    expect(geometry.frameStrokeWidth).toBeCloseTo(1.5, 6); // max(1.5, 0.8)
  });

  it('非合唱 seed 0：s 1 ⇒ 120 × 80、alpha 0.25、secondary', () => {
    const geometry = geometryFor(0, false);
    expect(geometry.scaleMultiplier).toBe(1);
    expect(geometry.width).toBeCloseTo(120, 6); // max(100, 120)
    expect(geometry.height).toBeCloseTo(80, 6); // max(72, 80)
    expect(geometry.alpha).toBeCloseTo(0.25, 6);
    expect(geometry.accentIsSecondary).toBe(true);
  });

  it('合唱 + 偶数种子才有内框；框描边随字号（fontSize 200 ⇒ 4）', () => {
    expect(geometryFor(2, true).innerFrame).toBe(true);
    expect(geometryFor(3, true).innerFrame).toBe(false);
    expect(geometryFor(0, false).innerFrame).toBe(false);
    const big = resolveSonnetTextFixedGeoGeometry({
      seed: 0,
      isChorusEffect: false,
      fontSize: 200,
      layoutWidth: 1000,
    });
    expect(big.frameStrokeWidth).toBeCloseTo(4, 6); // 200 × 0.02
  });

  it('旋转只有 rotated-frame 是 π/4，其余为 0', () => {
    expect(resolveSonnetTextFixedGeoRotation(planFor(1, true))).toBeCloseTo(Math.PI / 4, 6);
    expect(resolveSonnetTextFixedGeoRotation(planFor(0, true))).toBe(0);
    expect(resolveSonnetTextFixedGeoRotation(planFor(0, false))).toBe(0);
  });
});

describe('背后几何：七种图元', () => {
  const counts = (draws: readonly SonnetTextFixedGeoDraw[]) =>
    draws.reduce<Record<string, number>>((acc, draw) => {
      acc[draw.kind] = (acc[draw.kind] ?? 0) + 1;
      return acc;
    }, {});

  it('straight-frame：无内框 1 条；有内框 2 条（内框 ×0.6）', () => {
    const plain = drawsFor({ category: 'hollow', variant: 'straight-frame' }, geometryFor(1, true));
    expect(counts(plain)).toEqual({ rect: 1 });
    const plainDraw = plain[0]!;
    expect(plainDraw.kind === 'rect' && plainDraw.width).toBeCloseTo(216, 6);
    /*
     * ⚠ 第 472 轮修：`seed = 2` 的 `s = 1.5 + 2 × 0.3 = 2.1` ✓ ⇒
     * 宽度 = `max(40 × 2.5 × 2.1, 1000 × 0.12 × 2.1)` = `max(210, 252)` = **252** ✓
     * （原来我拿 `seed 1` 的 216 去乘 0.6 ✗，所以算出 129.6 与实际 151.2 对不上 ✓）。
     */
    const doubledGeometry = geometryFor(2, true);
    expect(doubledGeometry.scaleMultiplier).toBeCloseTo(2.1, 6);
    expect(doubledGeometry.width).toBeCloseTo(252, 6);
    expect(doubledGeometry.innerFrame).toBe(true);
    const doubled = drawsFor({ category: 'hollow', variant: 'straight-frame' }, doubledGeometry);
    expect(counts(doubled)).toEqual({ rect: 2 });
    const inner = doubled[1]!;
    expect(inner.kind === 'rect' && inner.width).toBeCloseTo(252 * 0.6, 6);
    expect(inner.kind === 'rect' && inner.height).toBeCloseTo(doubledGeometry.height * 0.6, 6);
    expect(inner.alpha).toBeCloseTo(doubledGeometry.alpha * 0.7, 6);
  });

  it('rotated-frame：1 条 rect 且尺寸 ×0.8', () => {
    const draws = drawsFor({ category: 'hollow', variant: 'rotated-frame' }, geometryFor(1, true));
    expect(counts(draws)).toEqual({ rect: 1 });
    const frame = draws[0]!;
    expect(frame.kind === 'rect' && frame.width).toBeCloseTo(216 * 0.8, 6);
    expect(frame.kind === 'rect' && frame.height).toBeCloseTo(144 * 0.8, 6);
  });

  it('orbit-crosshair：大圆 1 + 左右双圆 2 + 横竖准星 2 = 5 条', () => {
    const geometry = geometryFor(1, true);
    const draws = drawsFor({ category: 'hollow', variant: 'orbit-crosshair' }, geometry);
    expect(counts(draws)).toEqual({ circle: 3, polyline: 2 });
    const big = draws[0]!;
    expect(big.kind === 'circle' && big.radius).toBeCloseTo(Math.min(216, 144) * 0.46, 6);
    const side = draws[1]!;
    expect(side.kind === 'circle' && side.x).toBeCloseTo(-216 * 0.17, 6);
    expect(side.kind === 'circle' && side.radius).toBeCloseTo(Math.min(216, 144) * 0.46 * 0.72, 6);
  });

  it('split-arches：两拱各 3 条 + 底线 1 条 = 7 条，拱角 π→0', () => {
    const geometry = geometryFor(1, true);
    const draws = drawsFor({ category: 'hollow', variant: 'split-arches' }, geometry);
    expect(counts(draws)).toEqual({ polyline: 3, arc: 4 });
    const arc = draws.find((draw) => draw.kind === 'arc')!;
    expect(arc.kind === 'arc' && arc.startAngle).toBeCloseTo(Math.PI, 6);
    expect(arc.kind === 'arc' && arc.endAngle).toBe(0);
    expect(arc.kind === 'arc' && arc.radius).toBeCloseTo(Math.min(216 * 0.34, 144 * 0.52) * 0.72, 6);
    const baseline = draws[draws.length - 1]!;
    expect(baseline.kind === 'polyline' && baseline.points[1]).toBeCloseTo(144 * 0.42, 6);
  });

  it('orb-hatch：1 个实心圆（strokeWidth 0）+ 竖弦；弦数 = ceil(w / spacing)', () => {
    const geometry = geometryFor(1, true);
    const draws = drawsFor({ category: 'solid', variant: 'orb-hatch' }, geometry);
    const circle = draws[0]!;
    expect(circle.kind === 'circle' && circle.strokeWidth).toBe(0);
    expect(circle.kind === 'circle' && circle.radius).toBeCloseTo(216 * 0.5, 6);
    expect(circle.alpha).toBeCloseTo(0.43 * 0.15, 6);
    const hatch = draws.slice(1);
    const spacing = Math.max(4, 216 * 0.05);
    expect(hatch).toHaveLength(Math.ceil((216 * 0.5 * 2) / spacing));
    expect(hatch[0]!.kind).toBe('polyline');
    expect(hatch[0]!.alpha).toBeCloseTo(0.43 * 0.6, 6);
    // 弦长公式：offset = −r 时 lineHeight = 0
    expect(hatch[0]!.kind === 'polyline' && hatch[0]!.points[1]).toBeCloseTo(0 + 216 * 0.5 * 0.4, 6);
  });

  it('music-steps：恒 8 条，位置/基线按公式，颜色交替', () => {
    const geometry = geometryFor(1, true);
    const draws = drawsFor({ category: 'solid', variant: 'music-steps' }, geometry);
    expect(draws).toHaveLength(8);
    const spacing = 216 / 9;
    draws.forEach((draw, index) => {
      const x = -108 + spacing * (index + 1);
      expect(draw.kind === 'polyline' && draw.points[0]).toBeCloseTo(x - spacing * 0.12, 6);
      expect(draw.kind === 'polyline' && draw.points[2]).toBeCloseTo(x + spacing * 0.12, 6);
      const baseline = 144 * (0.12 - index * 0.035);
      expect(draw.kind === 'polyline' && draw.points[1]).toBeCloseTo(
        baseline - (144 * SONNET_TEXT_FIXED_GEO_MUSIC_STEP_HEIGHTS[index]!) / 2,
        6,
      );
      expect(draw.colorKey).toBe(index % 2 === 0 ? 'primary' : 'secondary');
      expect(draw.strokeWidth).toBeCloseTo(Math.max(2, 144 * 0.025), 6);
    });
  });

  it('bent-lines：恒 5 条曲线，端点/拐点按公式，颜色交替', () => {
    const geometry = geometryFor(1, true);
    const draws = drawsFor({ category: 'solid', variant: 'bent-lines' }, geometry);
    expect(draws).toHaveLength(5);
    draws.forEach((draw, index) => {
      const x = -216 * 0.34 + index * 216 * 0.17;
      expect(draw.kind === 'curved' && draw.fromY).toBeCloseTo(-144 * (0.42 - index * 0.035), 6);
      expect(draw.kind === 'curved' && draw.controlY).toBeCloseTo(-144 * (0.08 - index * 0.025), 6);
      expect(draw.kind === 'curved' && draw.toY).toBeCloseTo(144 * (0.35 + index * 0.035), 6);
      expect(draw.kind === 'curved' && draw.controlX).toBeCloseTo(x, 6);
      expect(draw.colorKey).toBe(index % 2 === 0 ? 'primary' : 'secondary');
    });
  });

  it('竖弦单独成函数：间距下界 4（窄宽时）与弦长公式', () => {
    const narrow = resolveSonnetTextFixedGeoHatchLines(40, 0.5);
    // r = 20、spacing = max(4, 2) = 4 ⇒ 40 / 4 = 10 条 ✓
    expect(narrow).toHaveLength(10);
    expect(narrow[0]!.kind === 'polyline' && narrow[0]!.points[0]).toBeCloseTo(-20 + 8, 6);
    expect(narrow[0]!.alpha).toBeCloseTo(0.3, 6);
    expect(narrow[0]!.colorKey).toBe('primary');
  });
});
