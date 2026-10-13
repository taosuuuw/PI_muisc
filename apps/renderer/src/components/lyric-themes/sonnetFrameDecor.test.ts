/**
 * 装饰性开放边框（`sonnetFrameDecor.ts`）的用例（第 432 轮补）。
 * 期望值：选择判据与几何常数**逐条对上游**（`sonnetFrameDecor.ts`），其余手算 ✓。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_FRAME_DECOR_DIM_MULTIPLIER,
  SONNET_FRAME_DECOR_ORNAMENT_KINDS,
  SONNET_FRAME_DECOR_PROBABILITY,
  resolveSonnetFrameDecorGeometry,
  resolveSonnetFrameDecorOrnamentProgress,
  resolveSonnetFrameDecorSideProgress,
  resolveSonnetFrameDecorSpec,
} from './sonnetFrameDecor';

describe('边框装饰：选择（概率与档位）', () => {
  it('常量照抄上游：概率 0.4、四档、调暗 0.55', () => {
    expect(SONNET_FRAME_DECOR_PROBABILITY).toBe(0.4);
    expect(SONNET_FRAME_DECOR_ORNAMENT_KINDS).toHaveLength(4);
    expect(SONNET_FRAME_DECOR_DIM_MULTIPLIER).toBe(0.55);
  });

  it('概率阈值是 `(hash & 1023) / 1024 < 0.4`：409 命中、410 不命中', () => {
    // 409 / 1024 = 0.399414... < 0.4 ⇒ 命中
    expect(resolveSonnetFrameDecorSpec(409).applied).toBe(true);
    // 410 / 1024 = 0.40039... ⇒ 不命中（边界另一侧）
    expect(resolveSonnetFrameDecorSpec(410).applied).toBe(false);
    expect(resolveSonnetFrameDecorSpec(0).applied).toBe(true);
    expect(resolveSonnetFrameDecorSpec(1023).applied).toBe(false);
  });

  it('档位是 `(hash >>> 10) % 4`：1024 的整数倍正好给出 1/2/3/0', () => {
    expect(resolveSonnetFrameDecorSpec(1024).variant).toBe(1);
    expect(resolveSonnetFrameDecorSpec(2048).variant).toBe(2);
    expect(resolveSonnetFrameDecorSpec(3072).variant).toBe(3);
    expect(resolveSonnetFrameDecorSpec(4096).variant).toBe(0);
  });

  it('负数/小数哈希也不会出界（先取绝对值取整再 `>>> 0`）', () => {
    for (const hash of [-1, -1024, 12.7, -12.7]) {
      const spec = resolveSonnetFrameDecorSpec(hash);
      expect(spec.variant).toBeGreaterThanOrEqual(0);
      expect(spec.variant).toBeLessThan(4);
    }
  });
});

describe('边框装饰：几何（clamp 与四分之一转）', () => {
  const geo = (overrides: Partial<Parameters<typeof resolveSonnetFrameDecorGeometry>[0]> = {}) =>
    resolveSonnetFrameDecorGeometry({
      fontSize: 100,
      width: 200,
      height: 100,
      rotation: 0,
      variant: 0,
      ...overrides,
    });

  it('fontSize 100 ⇒ pad 顶到上限 20、strokeWidth 顶到 2.2、dash 顶到 8', () => {
    const g = geo();
    expect(g.pad).toBe(20); // clamp(22, 8, 20)
    expect(g.halfW).toBe(120); // 200/2 + 20
    expect(g.halfH).toBe(70); // 100/2 + 20
    expect(g.cornerGap).toBeCloseTo(21, 6); // clamp(70 × 0.3, 6, 30)
    expect(g.strokeWidth).toBe(2.2); // clamp(3, 1.2, 2.2)
    expect(g.dash).toBe(8); // clamp(14, 5, 8)
    expect(g.dashGap).toBeCloseTo(5.6, 6);
    expect(g.swapped).toBe(false);
    expect(g.ornamentKind).toBe('corner-ticks');
  });

  it('fontSize 20 ⇒ pad 顶到下限 8、strokeWidth 顶到 1.2、dash 顶到 5', () => {
    const g = geo({ fontSize: 20 });
    expect(g.pad).toBe(8); // clamp(4.4, 8, 20)
    expect(g.strokeWidth).toBe(1.2); // clamp(0.6, 1.2, 2.2)
    expect(g.dash).toBe(5); // clamp(2.8, 5, 8)
  });

  it('variant 1 的角口更大（比例 0.42 而不是 0.3）', () => {
    expect(geo({ variant: 1 }).cornerGap).toBeCloseTo(29.4, 6); // 70 × 0.42
    expect(geo({ variant: 1 }).ornamentKind).toBe('corner-flowers');
  });

  it('四分之一转（π/2 的奇数倍）会把宽高换过来算；π 的倍数不换', () => {
    const quarter = geo({ rotation: Math.PI / 2 });
    expect(quarter.swapped).toBe(true);
    expect(quarter.halfW).toBe(70); // 用 height/2 + pad
    expect(quarter.halfH).toBe(120); // 用 width/2 + pad

    expect(geo({ rotation: Math.PI }).swapped).toBe(false);
    expect(geo({ rotation: (Math.PI / 2) * 3 }).swapped).toBe(true);
    // 容差 1e-6：极其接近 0 的旋转按"没转"算 ✓
    expect(geo({ rotation: 1e-7 }).swapped).toBe(false);
  });
});

describe('边框装饰：两组进度（四边依次、四角依次）', () => {
  it('四边：`clamp01((eased − side × 0.2) / 0.4)`', () => {
    // ⚠ 这几条一律用容差比较：`0.2 − 0.2`、`1 − 0.6` 这类二进制浮点不保证精确 ✗
    //（第 432 轮就是被"精确相等"咬了一口 ✓）。
    expect(resolveSonnetFrameDecorSideProgress(0.2, 0)).toBeCloseTo(0.5, 6);
    expect(resolveSonnetFrameDecorSideProgress(0.2, 1)).toBeCloseTo(0, 6);
    expect(resolveSonnetFrameDecorSideProgress(0.2, 3)).toBeCloseTo(0, 6);
    expect(resolveSonnetFrameDecorSideProgress(1, 0)).toBeCloseTo(1, 6); // 2.5 ⇒ 夹到 1
    expect(resolveSonnetFrameDecorSideProgress(1, 3)).toBeCloseTo(1, 6); // 恰好 1（浮点余量被夹掉）
  });

  it('四角：`clamp01((eased − 0.35 − corner × 0.14) / 0.3)`，每角晚 0.14', () => {
    expect(resolveSonnetFrameDecorOrnamentProgress(0.35, 0)).toBeCloseTo(0, 6);
    expect(resolveSonnetFrameDecorOrnamentProgress(0.65, 0)).toBeCloseTo(1, 6);
    expect(resolveSonnetFrameDecorOrnamentProgress(0.65, 1)).toBeCloseTo(0.5333333, 5);
    /*
     * ⚠ 第 432 轮这里我原本写 `toBe(0)`，**算错了** ✗：
     * 第 2 个角的起点是 `0.35 + 0.28 = 0.63`，所以 `eased = 0.65` 时它**已经**起了个头
     * `(0.65 − 0.63) / 0.3 = 0.0666…` ✓。要它还是 0，得取 `eased ≤ 0.63` ✓（下面那条就是）。
     */
    expect(resolveSonnetFrameDecorOrnamentProgress(0.65, 2)).toBeCloseTo(0.0666667, 5);
    expect(resolveSonnetFrameDecorOrnamentProgress(0.63, 2)).toBeCloseTo(0, 6);
    expect(resolveSonnetFrameDecorOrnamentProgress(0.65, 3)).toBeCloseTo(0, 6);
    expect(resolveSonnetFrameDecorOrnamentProgress(1, 3)).toBeCloseTo(0.7666667, 5);
  });
});
