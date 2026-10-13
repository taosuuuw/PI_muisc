/**
 * 商籁镜头追踪的用例（第 516 轮）。
 * 全部**手算**：段中心 = 首尾中点；焦点 = 中心 + (精确位置 − 中心) × `trackingFactor`（默认 0.5 ✓）。
 */

import { describe, expect, it } from 'vitest';
import {
  resolveSonnetCameraTrackingGlyphs,
  resolveSonnetSegmentCameraFocus,
  type SonnetCameraTrackingGlyph,
} from './sonnetCameraTracking';

const glyph = (baseX: number, baseY: number, startTime: number): SonnetCameraTrackingGlyph => ({
  baseX,
  baseY,
  startTime,
});

describe('商籁镜头追踪：滤掉装饰节点', () => {
  it('`isBackgroundShape === true` 的会被滤掉，其余保留（含未标注的）', () => {
    const kept = resolveSonnetCameraTrackingGlyphs([
      { ...glyph(0, 0, 0), isBackgroundShape: true },
      glyph(1, 2, 3),
      { ...glyph(4, 5, 6), isBackgroundShape: false },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept.map((item) => item.startTime)).toEqual([3, 6]);
  });

  it('空数组 ⇒ 空数组', () => {
    expect(resolveSonnetCameraTrackingGlyphs([])).toEqual([]);
  });
});

describe('商籁镜头追踪：焦点', () => {
  // 首尾：(0,0)@0 与 (100,50)@2 ⇒ 段中心 = (50,25) ✓
  const pair = [glyph(0, 0, 0), glyph(100, 50, 2)];

  it('空数组 ⇒ (0,0)', () => {
    expect(resolveSonnetSegmentCameraFocus([], 1)).toEqual({ x: 0, y: 0 });
  });

  it('早于首字 ⇒ 首字位往中心拉一半；(25, 12.5)', () => {
    expect(resolveSonnetSegmentCameraFocus(pair, -5)).toEqual({ x: 25, y: 12.5 });
    expect(resolveSonnetSegmentCameraFocus(pair, 0)).toEqual({ x: 25, y: 12.5 });
  });

  it('晚于末字 ⇒ 末字位往中心拉一半；(75, 37.5)', () => {
    expect(resolveSonnetSegmentCameraFocus(pair, 2)).toEqual({ x: 75, y: 37.5 });
    expect(resolveSonnetSegmentCameraFocus(pair, 99)).toEqual({ x: 75, y: 37.5 });
  });

  it('正中间 ⇒ 精确位置恰是段中心 ⇒ 焦点就是 (50,25)', () => {
    expect(resolveSonnetSegmentCameraFocus(pair, 1)).toEqual({ x: 50, y: 25 });
  });

  it('`trackingFactor = 1` ⇒ 不做任何拉伸，焦点就是精确位置', () => {
    expect(resolveSonnetSegmentCameraFocus(pair, 0, 1)).toEqual({ x: 0, y: 0 });
    expect(resolveSonnetSegmentCameraFocus(pair, 1, 1)).toEqual({ x: 50, y: 25 });
    expect(resolveSonnetSegmentCameraFocus(pair, 2, 1)).toEqual({ x: 100, y: 50 });
  });

  it('`trackingFactor = 0` ⇒ 焦点恒等于段中心', () => {
    expect(resolveSonnetSegmentCameraFocus(pair, 0, 0)).toEqual({ x: 50, y: 25 });
    expect(resolveSonnetSegmentCameraFocus(pair, 1, 0)).toEqual({ x: 50, y: 25 });
    expect(resolveSonnetSegmentCameraFocus(pair, 2, 0)).toEqual({ x: 50, y: 25 });
  });

  it('三个字：取到正确的那一段插值', () => {
    // (0,0)@0、(10,0)@1、(20,0)@2；t=1.5 落在第 2 段 ⇒ 精确 x = 15 ⇒ 中心 x = 10 ⇒ 焦点 = 10 + 5×0.5 = 12.5 ✓
    const three = [glyph(0, 0, 0), glyph(10, 0, 1), glyph(20, 0, 2)];
    expect(resolveSonnetSegmentCameraFocus(three, 1.5)).toEqual({ x: 12.5, y: 0 });
  });

  it('两字同一时刻（Δ = 0）不会除零：走 `max(0.001, …)` 那条', () => {
    const same = [glyph(0, 0, 1), glyph(8, 4, 1)];
    const focus = resolveSonnetSegmentCameraFocus(same, 1);
    // t = 1 ⇒ `time <= first.startTime` ⇒ 直接回首字位（中心 (4,2) 拉一半 ⇒ (2,1)）
    expect(focus).toEqual({ x: 2, y: 1 });
    // 夹在中间时刻（这里时间比首字小、又比末字大是不可能的，用 1.0005 走插值分支的前置判断）
    expect(Number.isFinite(resolveSonnetSegmentCameraFocus(same, 1.0005).x)).toBe(true);
  });

  it('单字 ⇒ 段中心就是它自己 ⇒ 焦点恒为它（三种 trackingFactor 都一样）', () => {
    const one = [glyph(30, 40, 5)];
    expect(resolveSonnetSegmentCameraFocus(one, 0)).toEqual({ x: 30, y: 40 });
    expect(resolveSonnetSegmentCameraFocus(one, 5)).toEqual({ x: 30, y: 40 });
    expect(resolveSonnetSegmentCameraFocus(one, 9)).toEqual({ x: 30, y: 40 });
    expect(resolveSonnetSegmentCameraFocus(one, 9, 0)).toEqual({ x: 30, y: 40 });
  });
});

/**
 * **段内插值改成 C¹**（本轮修"镜头一顿一顿"的那一层）。
 *
 * 上游是分段线性：段内斜率恒定、字与字的交点处斜率突变；这一层上面还压着 5 抽头
 * 时间平滑（±0.12s），折线的斜率跳变被平均后仍是**台阶**（`.tmp/sonnet-probe/pivot.txt`
 * 实测真实帧层读数：每约 0.13 秒一次 2.04× / 0.51× 的速度跳变）。
 * 这里守住两条：交点两侧速度连续（C¹），以及"采样加密不会让速度台阶变大"
 * —— 这正是旧版线性插值做不到的（台阶/dt 会一直长大）。
 */
describe('商籁镜头追踪：段内插值是 C¹（速度台阶）', () => {
  /* 间距刻意不匀（真实歌词的字素时长就是这样）✓ */
  const knots = [glyph(0, 0, 0), glyph(120, 0, 0.2), glyph(150, 0, 0.9), glyph(400, 0, 1.1)];

  /** 交点两侧的单侧导数（`trackingFactor = 1` 时直读精确位置）✓。 */
  const derivativeAt = (time: number, h: number, side: -1 | 1): number => {
    const here = resolveSonnetSegmentCameraFocus(knots, time, 1).x;
    const there = resolveSonnetSegmentCameraFocus(knots, time + side * h, 1).x;
    return (there - here) / (side * h);
  };
  /** 交点两侧导数的差：C¹ ⇒ 随 h 一起缩小；折线 ⇒ 恒等于速度台阶（与 h 无关）✓。 */
  const slopeGap = (time: number, h: number): number =>
    Math.abs(derivativeAt(time, h, -1) - derivativeAt(time, h, 1));

  it('每个字的交点两侧速度连续（旧版线性插值在这里斜率是跳的）', () => {
    for (const knot of [0.2, 0.9]) {
      /* 差分步长缩小两个数量级 ⇒ 两侧速度的差也跟着缩小 ⇒ 极限处相等（C¹）✓ */
      expect(slopeGap(knot, 1e-4)).toBeLessThan(slopeGap(knot, 1e-2) * 0.2);
      expect(slopeGap(knot, 1e-6)).toBeLessThan(0.05);
    }
    /* 落点值不受影响：交点处仍然是那个字自己的位置 ✓ */
    expect(resolveSonnetSegmentCameraFocus(knots, 0.2, 1).x).toBeCloseTo(120, 9);
    expect(resolveSonnetSegmentCameraFocus(knots, 0.9, 1).x).toBeCloseTo(150, 9);
  });

  /** 旧版的分段线性（+往段中心拉一半），只用于对照"速度台阶会长大"✓。 */
  const legacyLinearFocus = (time: number): number => {
    const first = knots[0]!;
    const last = knots[knots.length - 1]!;
    const center = (first.baseX + last.baseX) / 2;
    const apply = (exact: number): number => center + (exact - center) * 0.5;
    if (time <= first.startTime) return apply(first.baseX);
    if (time >= last.startTime) return apply(last.baseX);
    for (let index = 0; index + 1 < knots.length; index += 1) {
      const current = knots[index]!;
      const next = knots[index + 1]!;
      if (time < current.startTime || time > next.startTime) continue;
      const progress = (time - current.startTime) / Math.max(0.001, next.startTime - current.startTime);
      return apply(current.baseX + (next.baseX - current.baseX) * progress);
    }
    return apply(first.baseX);
  };

  /** 一趟采样里"相邻两帧速度之差 / 帧长"的最大值（= 采样出来的最大加速度）✓。 */
  const maxAccel = (sample: (time: number) => number, dt: number): number => {
    const positions: number[] = [];
    for (let step = 0; step * dt <= 1.1 + 1e-9; step += 1) positions.push(sample(step * dt));
    let worst = 0;
    for (let index = 2; index < positions.length; index += 1) {
      const first = (positions[index - 1]! - positions[index - 2]!) / dt;
      const second = (positions[index]! - positions[index - 1]!) / dt;
      worst = Math.max(worst, Math.abs(second - first) / dt);
    }
    return worst;
  };

  it('采样加密一个数量级：新曲线读数基本不变，旧折线按 1/dt 长大', () => {
    const smooth = {
      coarse: maxAccel((time) => resolveSonnetSegmentCameraFocus(knots, time, 1).x, 1 / 60),
      fine: maxAccel((time) => resolveSonnetSegmentCameraFocus(knots, time, 1).x, 1 / 600),
    };
    const legacy = {
      coarse: maxAccel(legacyLinearFocus, 1 / 60),
      fine: maxAccel(legacyLinearFocus, 1 / 600),
    };
    /* C¹ ⇒ 加密后读数同量级 ✓ */
    expect(smooth.fine).toBeLessThan(smooth.coarse * 4 + 1e-6);
    /* 折线 ⇒ 台阶/dt 随采样加密线性增长（≥ 4 倍）✓ */
    expect(legacy.fine).toBeGreaterThan(legacy.coarse * 4);
  });
});
