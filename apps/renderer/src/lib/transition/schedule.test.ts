import { describe, expect, it } from 'vitest';
import {
  CROSSFADE_SEC,
  PREFETCH_LEAD_SEC,
  shouldArmNext,
  shouldStartCrossfade,
  type TransitionPhase,
} from './schedule';

/**
 * 这两个判定的错误方式都是「差几秒」：预取太晚就变成空档，太早会白解析；
 * 交叉点判定错会把两首歌切哑。所以每个边界都钉一遍。
 */
describe('该不该预取下一首', () => {
  it('还剩 15 秒：太早，不预取', () => {
    expect(shouldArmNext(PREFETCH_LEAD_SEC + 3, 'idle')).toBe(false);
  });

  it('进入 12 秒窗口：预取', () => {
    expect(shouldArmNext(PREFETCH_LEAD_SEC, 'idle')).toBe(true);
  });

  it('只剩 5 秒（已到交叉点，来不及了）：不预取', () => {
    expect(shouldArmNext(CROSSFADE_SEC, 'idle')).toBe(false);
  });

  it('窗口下界之内（6.5 秒）：仍然预取', () => {
    expect(shouldArmNext(CROSSFADE_SEC + 1.5, 'idle')).toBe(true);
  });

  it('不是 idle（正在解析/已就绪/正在交叉）：不再重复触发', () => {
    const busy: TransitionPhase[] = ['arming', 'ready', 'fading'];
    for (const status of busy) expect(shouldArmNext(8, status)).toBe(false);
  });

  it('剩余时间无效（NaN / 0 / 负数）：不预取', () => {
    expect(shouldArmNext(Number.NaN, 'idle')).toBe(false);
    expect(shouldArmNext(0, 'idle')).toBe(false);
    expect(shouldArmNext(-3, 'idle')).toBe(false);
  });
});

describe('该不该开始交叉', () => {
  it('只剩 4 秒且已就绪：开始', () => {
    expect(shouldStartCrossfade(CROSSFADE_SEC - 1, 'ready')).toBe(true);
  });

  it('还剩 6 秒：不到点，不开始', () => {
    expect(shouldStartCrossfade(CROSSFADE_SEC + 1, 'ready')).toBe(false);
  });

  it('没就绪（地址还没到手）：绝不开始', () => {
    expect(shouldStartCrossfade(2, 'idle')).toBe(false);
    expect(shouldStartCrossfade(2, 'arming')).toBe(false);
    expect(shouldStartCrossfade(2, 'fading')).toBe(false);
  });

  it('剩余时间无效：不开始', () => {
    expect(shouldStartCrossfade(Number.NaN, 'ready')).toBe(false);
    expect(shouldStartCrossfade(0, 'ready')).toBe(false);
  });
});
