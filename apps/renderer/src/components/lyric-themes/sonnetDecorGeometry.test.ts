/**
 * 装饰几何层（`sonnetDecorGeometry.ts`）的用例（第 387 轮补，第 388 轮修正）。
 * 期望值**全部手算**：点数、闭合性、描边宽度公式、以及"形状系数 × 粒子 alpha"的最终 alpha ✓。
 *
 * ⚠ **坐标一律用 closeTo 比较**：像 `10 × 0.18` 这种十进制小数在二进制里是 `1.7999999999999998`，
 * 用 `toEqual` 钉死会**假红**（第 387 轮就是这么红的 ✗）——那种红没有信息量，所以改成容差比较 ✓。
 */

import { describe, expect, it } from 'vitest';
import type { SonnetDecorParticle, SonnetDecorShape } from './sonnetBackgroundDecor';
import { resolveSonnetDecorDrawItems, resolveSonnetDecorGeometry } from './sonnetDecorGeometry';

const particle = (shape: SonnetDecorShape, size = 10, alpha = 0.7): SonnetDecorParticle => ({
  index: 0,
  shape,
  size,
  primary: true,
  alpha,
  x: 12,
  y: -34,
  rotation: 0.5,
});

/** 逐个数按容差比较（点列是扁平数组，长度也必须一致）✓。 */
const expectPointsClose = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, 6);
  });
};

describe('装饰几何层：十种形状的点数与闭合性', () => {
  it('hexagon = 7 个点、不闭合、描边 max(1, p×0.16)', () => {
    const draws = resolveSonnetDecorGeometry(particle('hexagon'));
    expect(draws).toHaveLength(1);
    expect(draws[0]?.kind).toBe('stroke');
    expect(draws[0]?.points).toHaveLength(14); // 7 点 × 2 个数
    expect(draws[0]?.closed).toBe(false);
    expect(draws[0]?.width).toBeCloseTo(1.6, 6);
    expect(draws[0]?.alpha).toBeCloseTo(0.7, 6); // 无形状系数
    // 第 1 个点是 (sin0, −cos0) × p = (0, −10)；第 4 个点是 j=3 ⇒ (sinπ, −cosπ) × p = (0, 10)
    expectPointsClose(draws[0]?.points ?? [], [0, -10, 8.660254, -5, 8.660254, 5, 0, 10, -8.660254, 5, -8.660254, -5, 0, -10]);
  });

  it('plus（十字）= 两条 fill，alpha ×0.9，臂宽 p×0.34', () => {
    const draws = resolveSonnetDecorGeometry(particle('plus', 10, 0.7));
    expect(draws).toHaveLength(2);
    expect(draws.every((draw) => draw.kind === 'fill')).toBe(true);
    expect(draws[0]?.alpha).toBeCloseTo(0.63, 6); // 0.7 × 0.9
    // rect(±arm × ±p)：arm = 10 × 0.34 = 3.4
    expectPointsClose(draws[0]?.points ?? [], [-3.4, -10, 3.4, -10, 3.4, 10, -3.4, 10]);
    // rect(±p × ±arm)
    expectPointsClose(draws[1]?.points ?? [], [-10, -3.4, 10, -3.4, 10, 3.4, -10, 3.4]);
  });

  it('chevron 三个点、不闭合、描边 max(1.5, p×0.2)', () => {
    const draws = resolveSonnetDecorGeometry(particle('chevron', 10, 0.7));
    expect(draws).toHaveLength(1);
    expectPointsClose(draws[0]?.points ?? [], [-5, -5.5, 3.5, 0, -5, 5.5]);
    expect(draws[0]?.width).toBeCloseTo(2, 6);
    expect(draws[0]?.closed).toBe(false);
  });

  it('dot 是实心圆（半径 p×0.34、点列为空）', () => {
    const draws = resolveSonnetDecorGeometry(particle('dot', 10, 0.7));
    expect(draws[0]?.kind).toBe('fill');
    expect(draws[0]?.points).toEqual([]);
    expect(draws[0]?.circle?.x).toBeCloseTo(0, 6);
    expect(draws[0]?.circle?.y).toBeCloseTo(0, 6);
    expect(draws[0]?.circle?.radius).toBeCloseTo(3.4, 6);
  });

  it('ring 是 24 段折线描边、宽 max(1, p×0.22)、alpha ×0.9、闭合', () => {
    const draws = resolveSonnetDecorGeometry(particle('ring', 10, 0.7));
    expect(draws[0]?.kind).toBe('stroke');
    expect(draws[0]?.points).toHaveLength(48); // 24 段 × 2
    expect(draws[0]?.width).toBeCloseTo(2.2, 6);
    expect(draws[0]?.alpha).toBeCloseTo(0.63, 6);
    expect(draws[0]?.closed).toBe(true);
  });

  it('diamond / bar / triangle 的系数都是 ×0.85，点序列手算', () => {
    const diamond = resolveSonnetDecorGeometry(particle('diamond', 10, 0.7));
    expectPointsClose(diamond[0]?.points ?? [], [0, -10, 10, 0, 0, 10, -10, 0]);
    expect(diamond[0]?.alpha).toBeCloseTo(0.595, 6);

    const bar = resolveSonnetDecorGeometry(particle('bar', 10, 0.7));
    expectPointsClose(bar[0]?.points ?? [], [-10, -1.8, 10, -1.8, 10, 1.8, -10, 1.8]);
    expect(bar[0]?.alpha).toBeCloseTo(0.595, 6);

    const triangle = resolveSonnetDecorGeometry(particle('triangle', 10, 0.7));
    expectPointsClose(triangle[0]?.points ?? [], [0, -10, 9, 7, -9, 7]);
    expect(triangle[0]?.alpha).toBeCloseTo(0.595, 6);
  });

  it('square 无系数（alpha 原样）；sparkle 是**我们的近似**（8 点，×1.2）', () => {
    const square = resolveSonnetDecorGeometry(particle('square', 10, 0.7));
    expectPointsClose(square[0]?.points ?? [], [-5, -5, 5, -5, 5, 5, -5, 5]);
    expect(square[0]?.alpha).toBeCloseTo(0.7, 6);

    const sparkle = resolveSonnetDecorGeometry(particle('sparkle', 10, 0.7));
    expect(sparkle[0]?.points).toHaveLength(16); // 8 点 × 2
    expect(sparkle[0]?.alpha).toBeCloseTo(0.84, 6); // 0.7 × 1.2
    // 外顶点半径 15、内凹 6.2（近似参数，写死在用例里当"契约"）
    expect(sparkle[0]?.points[0]).toBeCloseTo(15, 6);
    expect(sparkle[0]?.points[2]).toBeCloseTo(Math.cos(Math.PI / 4) * 6.2, 6);
  });
});

describe('装饰几何层：整层输出', () => {
  it('把粒子的位置/旋转/配色透传，图元与单粒子一致', () => {
    const particles = [particle('dot', 8, 0.6), particle('chevron', 8, 0.6)];
    const items = resolveSonnetDecorDrawItems(particles);
    expect(items).toHaveLength(2);
    expect(items[0]?.x).toBe(12);
    expect(items[0]?.y).toBe(-34);
    expect(items[0]?.rotation).toBe(0.5);
    expect(items[0]?.primary).toBe(true);
    expect(JSON.stringify(items[0]?.draws)).toBe(JSON.stringify(resolveSonnetDecorGeometry(particles[0]!)));
    expect(JSON.stringify(items[1]?.draws)).toBe(JSON.stringify(resolveSonnetDecorGeometry(particles[1]!)));
  });
});
