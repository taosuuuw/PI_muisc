/**
 * 凝彩字形运动层的自查用例（数值来自上游 `temperaEnterStyles.ts` 与 `temperaMotion.ts`）。
 *
 * 守的是"照抄的那些系数"与几条**容易想当然**的行为：
 * · 方向档的距离来自 `hypot(enterX, enterY)`（不来自方向）；
 * · `stamp` **没有回响**；`swing` 的旋转额外加 ±0.95；
 * · 透明度走**短窗口**（`min(settle, 1.35)`）而位移走**长窗口**；
 * · 零长字素**不脉冲**；
 * · `motion = 0` 把入场**拉回静止姿态**（不是反向）。
 */

import { describe, expect, it } from 'vitest';
import {
  TEMPERA_ENTER_STYLES,
  TEMPERA_MAX_REVEAL_WINDOW,
  resolveTemperaEnterFrame,
  resolveTemperaGlyphMotion,
  type TemperaGlyphMotionInput,
} from './temperaGlyphMotion';

const baseInput = {
  enterX: 30,
  enterY: 40,
  enterRotation: 0.2,
  enterScale: 0.8,
};

const glyph = (over: Partial<TemperaGlyphMotionInput> = {}): TemperaGlyphMotionInput => ({
  startTime: 10,
  settleTime: 11,
  endTime: 10.5,
  enterX: 30,
  enterY: 40,
  enterRotation: 0.2,
  enterScale: 0.8,
  rotation: 0.05,
  enterStyle: 'slide',
  releaseTime: 13,
  trackingX: 12,
  trackingY: -8,
  ...over,
});

describe('凝彩入场样式（照抄系数）', () => {
  it('七种样式都在表里；方向档的距离一律 = hypot(enterX, enterY)', () => {
    expect(TEMPERA_ENTER_STYLES).toHaveLength(7);
    const magnitude = Math.hypot(30, 40); // = 50
    // travel = 1（刚起步）时，方向档的位移长度应当等于 magnitude。
    for (const style of ['from-left', 'from-right', 'from-above', 'from-below'] as const) {
      const frame = resolveTemperaEnterFrame(style, baseInput, 1, 0);
      expect(Math.hypot(frame.x, frame.y)).toBeCloseTo(magnitude, 6);
      // 旋转按 0.4 缩放。
      expect(frame.rotation).toBeCloseTo(0.2 * 0.4, 6);
      expect(frame.echo).toBeCloseTo(1, 6);
    }
    // 方向不同 ⇒ 起点不同（from-left 往左、from-right 往右）。
    expect(resolveTemperaEnterFrame('from-left', baseInput, 1, 0).x).toBeLessThan(0);
    expect(resolveTemperaEnterFrame('from-right', baseInput, 1, 0).x).toBeGreaterThan(0);
  });

  it('swing 绕自身中心转进来；stamp 是原地砸下且**没有回响**；slide 直直进来', () => {
    const swing = resolveTemperaEnterFrame('swing', baseInput, 1, 0);
    expect(swing.x).toBeCloseTo(30 * 0.6, 6);
    expect(swing.y).toBeCloseTo(40 * 0.6, 6);
    // 旋转 = (enterRotation + sign(enterRotation) × 0.95) × travel = 1.15
    expect(swing.rotation).toBeCloseTo(1.15, 6);
    expect(swing.echo).toBeCloseTo(0.8, 6);

    const stamp = resolveTemperaEnterFrame('stamp', baseInput, 1, 0);
    expect(stamp.x).toBe(0);
    expect(stamp.y).toBe(0);
    // 从过大砸下来：1 + travel × 0.7。
    expect(stamp.scaleX).toBeCloseTo(1.7, 6);
    expect(stamp.scaleY).toBeCloseTo(1.7, 6);
    expect(stamp.echo).toBe(0);

    const slide = resolveTemperaEnterFrame('slide', baseInput, 1, 0);
    expect(slide.x).toBeCloseTo(30, 6);
    expect(slide.y).toBeCloseTo(40, 6);
    expect(slide.echo).toBeCloseTo(1, 6);
  });

  it('收尾走 softBack 回弹：linear = 1 时缩放精确收到 1', () => {
    for (const style of TEMPERA_ENTER_STYLES) {
      const end = resolveTemperaEnterFrame(style, baseInput, 0, 1);
      // stamp 的 scale 是 1 + travel × 0.7，travel = 0 ⇒ 也是 1。
      expect(end.scaleX).toBeCloseTo(1, 3);
      expect(end.scaleY).toBeCloseTo(1, 3);
      expect(end.x).toBeCloseTo(0, 6);
      expect(end.y).toBeCloseTo(0, 6);
    }
  });
});

describe('凝彩字形运动求值（照抄系数与窗口口径）', () => {
  it('起点不可见前 alpha = 0；位移/缩放走**长窗口**、透明度走**短窗口**', () => {
    const g = glyph({ startTime: 10, settleTime: 10.2 }); // settle 窗口只有 0.2 秒
    const before = resolveTemperaGlyphMotion(g, 9.9, 1);
    expect(before.visible).toBe(false);
    // reveal 用 min(window, 1.35)：窗口短 ⇒ 用 0.2，所以很早就亮满。
    expect(resolveTemperaGlyphMotion(g, 10.2, 1).alpha).toBeGreaterThan(0.9);
    // 长窗口时（settle 被拉到 3 秒），透明度上限仍是 1.35 秒。
    const stretched = glyph({ startTime: 0, settleTime: 3 });
    expect(resolveTemperaGlyphMotion(stretched, TEMPERA_MAX_REVEAL_WINDOW, 1).alpha).toBeCloseTo(1, 6);
    // 而位移在 1.35 秒时还没归零（因为 travel 用的是 3 秒的窗口）。
    expect(Math.abs(resolveTemperaGlyphMotion(stretched, TEMPERA_MAX_REVEAL_WINDOW, 1).x)).toBeGreaterThan(0);
    expect(resolveTemperaGlyphMotion(stretched, 3, 1).x).toBeCloseTo(0, 6);
  });

  it('零长字素（并进词里的标点）不脉冲；正常字素会隆起', () => {
    const punct = glyph({ startTime: 10, endTime: 10, settleTime: 10.4 });
    const mid = resolveTemperaGlyphMotion(punct, 10.1, 1);
    /*
     * **写用例时的自我更正**：我原以为"此刻 travel 还大 ⇒ scale > 1"，
     * 实测 `0.9556` —— 错。入场是**从 `enterScale = 0.8` 收到 1**，
     * 过程里永远 **≤ 1**（回弹只体现在接近 1 时的过冲），所以这里应当断言"小于 1、且大于起点"。
     */
    expect(mid.scaleX).toBeGreaterThan(0.79);
    expect(mid.scaleX).toBeLessThan(1);
    /*
     * 比较"有没有隆起"必须**只改演唱时长**：两个不同构造的字形窗口不同，
     * 位移/缩放的进度也就不同，直接比会得出错误结论（我第一版就是这样写的）。
     */
    const sung = glyph({ startTime: 10, endTime: 11, settleTime: 11.2 });
    const zeroLength = { ...sung, endTime: 10 };
    expect(resolveTemperaGlyphMotion(sung, 10.06, 1).scaleX).toBeGreaterThan(
      resolveTemperaGlyphMotion(zeroLength, 10.06, 1).scaleX,
    );
  });

  it('释放把字距撑开：只作用在 tracking 方向、motion = 0 时完全不生效', () => {
    const g = glyph({ endTime: 10.5, settleTime: 11, releaseTime: 13 });
    const late = resolveTemperaGlyphMotion(g, 13, 1);
    const early = resolveTemperaGlyphMotion(g, 11, 1);
    // x/y 里含 drift = tracking × spread；晚期 spread 更大 ⇒ 偏移更远。
    expect(Math.abs(late.x - early.x) + Math.abs(late.y - early.y)).toBeGreaterThan(0);
    const still = resolveTemperaGlyphMotion(g, 13, 0);
    // motion = 0 ⇒ 无 drift、无隆起，且缩放回到"静止姿态"（= 1）。
    expect(still.scaleX).toBeCloseTo(1, 6);
    expect(still.scaleY).toBeCloseTo(1, 6);
    expect(still.x).toBeCloseTo(0, 6);
    // 回响也随之消失。
    expect(still.echoAlpha).toBeCloseTo(0, 6);
  });
});
