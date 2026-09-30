import { describe, expect, it } from 'vitest';
import {
  QUICK_SWIPE_DOMINANCE,
  QUICK_SWIPE_LATCH_THRESHOLD,
  QUICK_SWIPE_THRESHOLD,
  QUICK_SWIPE_UNLOCKED,
  QUICK_TREND_THRESHOLD,
  quickDragTrend,
  quickSwipeDirection,
  quickSwipeLatch,
} from './quick-swipe';

/**
 * 第十六轮第 6 条：快捷球的手势方向判定。
 *
 * 这四条断言锁住的是「点」与「划」的分界，以及四个方向的正负号——
 * 方向搞反（上划当成下划）在手动测试里极难发现，因为两张卡片都长得像拍立得。
 */
describe('quickSwipeDirection', () => {
  it('没过阈值一律算点击（两轴都为 0 也是）', () => {
    expect(quickSwipeDirection(0, 0)).toBeNull();
    expect(quickSwipeDirection(QUICK_SWIPE_THRESHOLD - 1, 0)).toBeNull();
    expect(quickSwipeDirection(0, -(QUICK_SWIPE_THRESHOLD - 1))).toBeNull();
    // 两轴各自都没过线，即使勾股长也还是点击。
    expect(quickSwipeDirection(20, 20)).toBeNull();
  });

  it('刚好到阈值就成立（边界含等号）', () => {
    expect(quickSwipeDirection(QUICK_SWIPE_THRESHOLD, 0)).toBe('right');
    expect(quickSwipeDirection(-QUICK_SWIPE_THRESHOLD, 0)).toBe('left');
    expect(quickSwipeDirection(0, QUICK_SWIPE_THRESHOLD)).toBe('down');
    expect(quickSwipeDirection(0, -QUICK_SWIPE_THRESHOLD)).toBe('up');
  });

  it('屏幕坐标系：右/下为正，左/上为负', () => {
    expect(quickSwipeDirection(120, 4)).toBe('right');
    expect(quickSwipeDirection(-120, -4)).toBe('left');
    expect(quickSwipeDirection(6, 120)).toBe('down');
    expect(quickSwipeDirection(-6, -120)).toBe('up');
  });

  it('对角线（主轴压不过副轴）不判方向', () => {
    expect(quickSwipeDirection(60, 60)).toBeNull();
    // 36 / 33 只差 1.09 倍，咬得太近，判不出来。
    expect(quickSwipeDirection(36, 33)).toBeNull();
    expect(quickSwipeDirection(100, 90)).toBeNull();
    expect(quickSwipeDirection(-100, -90)).toBeNull();
  });

  it('主副轴差出 1.2 倍以上就认主轴', () => {
    // 45 / 35 = 1.285 > 1.2 → 右
    expect(quickSwipeDirection(45, 35)).toBe('right');
    // 35 / 45 → 下
    expect(quickSwipeDirection(35, 45)).toBe('down');
  });

  it('阈值可覆盖（组件把它透传给调用方方便调手感的场景）', () => {
    expect(quickSwipeDirection(10, 0, 10)).toBe('right');
    expect(quickSwipeDirection(9, 0, 10)).toBeNull();
    expect(quickSwipeDirection(0, -80, 40)).toBe('up');
  });

  it('导出常量自洽：DOMINANCE 大于 1，否则任何方向都判不出来', () => {
    expect(QUICK_SWIPE_DOMINANCE).toBeGreaterThan(1);
    expect(QUICK_SWIPE_THRESHOLD).toBeGreaterThan(0);
  });
});

/**
 * 用户 m00002 第 3 条：方向锁。
 *
 * 锁住的核心场景是那条原话——「拖拽圆球向右划，它就不能改变方向换成向上或向下的暗槽，
 * 除非把圆球划回原基准点」。这几条断言把「锁死」「回到基准点才解锁」「锁定前可反悔」
 * 三件事分别钉住；第 3 条还特意先用 `quickDragTrend` 证明**没有锁的话本来会翻成 up**，
 * 否则这条测试可能因为位移写得太小而在假阳性下通过。
 */
describe('quickSwipeLatch', () => {
  it('位移没过趋势线：既没倾向也没锁（暗槽不摊开）', () => {
    expect(quickSwipeLatch(QUICK_SWIPE_UNLOCKED, 0, 0)).toEqual({
      direction: null,
      trend: null,
    });
    expect(quickSwipeLatch(QUICK_SWIPE_UNLOCKED, QUICK_TREND_THRESHOLD - 1, 0)).toEqual({
      direction: null,
      trend: null,
    });
    expect(quickSwipeLatch(QUICK_SWIPE_UNLOCKED, 0, -(QUICK_TREND_THRESHOLD - 1))).toEqual({
      direction: null,
      trend: null,
    });
  });

  it('过了趋势线但没过锁定线：只有候选，还能反悔', () => {
    // 9 ≤ 12 < 24 → 槽亮成 right，但还没锁。
    expect(quickSwipeLatch(QUICK_SWIPE_UNLOCKED, 12, 0)).toEqual({
      direction: null,
      trend: 'right',
    });
    // 同一个候选态下换个方向拖，候选跟着换（这一段就是留给用户反悔的）。
    // 12/14 的勾股长 18.44 仍 < 24，所以只是换了候选、没有锁死。
    expect(quickSwipeLatch({ direction: null, trend: 'right' }, 12, 14)).toEqual({
      direction: null,
      trend: 'down',
    });
  });

  it('过了锁定线就锁死；锁死之后反着拖、垂直拖都不改方向', () => {
    const locked = quickSwipeLatch(QUICK_SWIPE_UNLOCKED, QUICK_SWIPE_LATCH_THRESHOLD, 0);
    expect(locked).toEqual({ direction: 'right', trend: 'right' });

    // 先证明「没有锁的话本来就该翻成 up」——否则下面那条断言可能在假阳性下通过。
    expect(quickDragTrend(40, -90)).toBe('up');
    // 用户原话的场景：向右划出去之后往上拖，暗槽必须还是 right。
    expect(quickSwipeLatch(locked, 40, -90)).toEqual({ direction: 'right', trend: 'right' });
    expect(quickSwipeLatch(locked, -80, 0)).toEqual({ direction: 'right', trend: 'right' });
    expect(quickSwipeLatch(locked, 5, 60)).toEqual({ direction: 'right', trend: 'right' });
  });

  it('只有把球划回基准点附近才解锁（欧氏距离 ≤ 锁定线）', () => {
    const locked = quickSwipeLatch(QUICK_SWIPE_UNLOCKED, 30, 0);
    expect(locked.direction).toBe('right');

    // 回到原点：解锁。
    expect(quickSwipeLatch(locked, 0, 0)).toEqual(QUICK_SWIPE_UNLOCKED);
    // 离开基准点但仍在半径内（10,10 → 14.14）：也算回来了，解锁。
    expect(quickSwipeLatch(locked, 10, 10)).toEqual(QUICK_SWIPE_UNLOCKED);
    // 刚好踩在半径上（20,20 → 28.28 > 24）：还没回来，保持锁定。
    expect(quickSwipeLatch(locked, 20, 20)).toEqual({ direction: 'right', trend: 'right' });
    // 沿锁定方向往回退到 23px：距离够了，同样解锁（不要求走另一轴）。
    expect(quickSwipeLatch(locked, 23, 0)).toEqual(QUICK_SWIPE_UNLOCKED);
  });

  it('解锁之后可以重新选一个方向并重新锁上', () => {
    const locked = quickSwipeLatch(QUICK_SWIPE_UNLOCKED, 30, 0);
    const free = quickSwipeLatch(locked, 0, 0);
    expect(free).toEqual(QUICK_SWIPE_UNLOCKED);
    // 从原点往上划出去 → 这次锁 up。
    expect(quickSwipeLatch(free, 0, -40)).toEqual({ direction: 'up', trend: 'up' });
  });

  it('锁定线与既有两条线的关系：趋势线 ≤ 锁定线 ≤ 正式判定线', () => {
    expect(QUICK_SWIPE_LATCH_THRESHOLD).toBeGreaterThanOrEqual(QUICK_TREND_THRESHOLD);
    expect(QUICK_SWIPE_LATCH_THRESHOLD).toBeLessThanOrEqual(QUICK_SWIPE_THRESHOLD);
  });
});
