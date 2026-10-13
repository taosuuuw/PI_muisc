/**
 * 进度条换算层的用例（用户上一轮第 1 条：进度条前面一小节点不动）。
 *
 * 这里钉的是**换算本身**：指针落点 → 毫秒、两端夹紧、量不到轨道时不乱报位置。
 * 「指针真的能落到轨道上」属于 DOM 命中测试，「按下/拖动只挪填充、松手才 seek」属于时序，
 * 分别靠冒烟（`PI_SMOKE_UI=1`）与真机看 —— 照实写清，别把单元测试当成品验收。
 */
import { describe, expect, it } from 'vitest';

import { progressTargetMs } from './progress';

/** 一条 200px 宽、左沿在 x=100 的轨道，总长 4 分钟。 */
const RECT = { left: 100, width: 200 };
const TOTAL = 240_000;

describe('progressTargetMs（指针 x → 目标毫秒）', () => {
  it('轨道左沿 = 0、右沿 = 总时长', () => {
    expect(progressTargetMs(100, RECT, TOTAL)).toBe(0);
    expect(progressTargetMs(300, RECT, TOTAL)).toBe(TOTAL);
  });

  it('比例是线性的：正中间 = 一半', () => {
    expect(progressTargetMs(200, RECT, TOTAL)).toBe(120_000);
    // 四分之一处：240000 × 0.25
    expect(progressTargetMs(150, RECT, TOTAL)).toBe(60_000);
  });

  it('**前面那一小节**（用户贴的图 1）不再是死区：已播起点往后 12px 也能算出位置', () => {
    // 12px / 200px = 6% ⇒ 14400ms；改造前这里正落在透明滑块上，点下去没反应。
    expect(progressTargetMs(112, RECT, TOTAL)).toBe(14_400);
    // 连已播胶囊最左端（8px）也给得出位置，而不是 0。
    expect(progressTargetMs(108, RECT, TOTAL)).toBe(9_600);
  });

  it('指针拖出轨道两头也夹在 [0, total] 内', () => {
    expect(progressTargetMs(-500, RECT, TOTAL)).toBe(0);
    expect(progressTargetMs(9_999, RECT, TOTAL)).toBe(TOTAL);
  });

  it('量不到轨道（宽 0）或时长未知时返回 0，不编造位置', () => {
    expect(progressTargetMs(200, { left: 0, width: 0 }, TOTAL)).toBe(0);
    expect(progressTargetMs(200, RECT, 0)).toBe(0);
    expect(progressTargetMs(200, RECT, -1)).toBe(0);
    expect(progressTargetMs(200, RECT, Number.NaN)).toBe(0);
  });

  it('结果是整数毫秒（`<audio>.currentTime` 只吃秒，但 store 里存毫秒）', () => {
    const ms = progressTargetMs(137, RECT, 187_333);
    expect(Number.isInteger(ms)).toBe(true);
  });
});
