/**
 * 凝彩「字形重影」层的自查用例（数值来自上游 `tempera/temperaTextView.ts` 原文）。
 *
 * 守的是四件容易写错的事：
 * · 阴影偏移是**相对字号**的（`0.06em` / `0.08em`），不是像素常量；
 * · 阴影不透明度是正文的 `0.34` 折（跟着正文一起淡入淡出）；
 * · 回响的偏移是 `1 + i × 0.85` 倍的**入场位移**、不透明度除以 `i + 1.4`；
 * · `echoAlpha` 恰好等于阈值 `0.004` 时**不显示**（上游是严格大于），
 *   且正文不可见时整组回响一起收掉。
 */

import { describe, expect, it } from 'vitest';
import {
  TEMPERA_ECHO_ALPHA_DIVISOR,
  TEMPERA_ECHO_DEPTH_STEP,
  TEMPERA_ECHO_LAYERS,
  TEMPERA_ECHO_VISIBLE_MIN,
  TEMPERA_SHADOW_ALPHA,
  TEMPERA_SHADOW_OFFSET_X,
  TEMPERA_SHADOW_OFFSET_Y,
  resolveTemperaEchoCopies,
  resolveTemperaShadowAlpha,
  resolveTemperaShadowOffset,
} from './temperaGlyphEcho';

describe('凝彩字形重影：上游常数', () => {
  it('阴影偏移与不透明度逐值与上游一致', () => {
    expect(TEMPERA_SHADOW_OFFSET_X).toBe(0.06);
    expect(TEMPERA_SHADOW_OFFSET_Y).toBe(0.08);
    expect(TEMPERA_SHADOW_ALPHA).toBe(0.34);
  });

  it('回响的层数 / 深度步长 / 透明度分母 / 可见阈值逐值与上游一致', () => {
    expect(TEMPERA_ECHO_LAYERS).toBe(2);
    expect(TEMPERA_ECHO_DEPTH_STEP).toBe(0.85);
    expect(TEMPERA_ECHO_ALPHA_DIVISOR).toBe(1.4);
    expect(TEMPERA_ECHO_VISIBLE_MIN).toBe(0.004);
  });
});

describe('凝彩字形重影：阴影拷贝', () => {
  it('偏移按字号等比（100px ⇒ 6px / 8px）', () => {
    expect(resolveTemperaShadowOffset(100)).toEqual({ dx: 6, dy: 8 });
  });

  it('偏移随字号线性缩放（50px 是 100px 的一半）', () => {
    const half = resolveTemperaShadowOffset(50);
    expect(half.dx).toBeCloseTo(3, 6);
    expect(half.dy).toBeCloseTo(4, 6);
  });

  it('不透明度是正文的 0.34 折', () => {
    expect(resolveTemperaShadowAlpha(1)).toBeCloseTo(0.34, 6);
    expect(resolveTemperaShadowAlpha(0.5)).toBeCloseTo(0.17, 6);
    // 正文没亮起来时影子也不能亮。
    expect(resolveTemperaShadowAlpha(0)).toBe(0);
  });
});

describe('凝彩字形重影：运动回响', () => {
  it('两层：偏移 1× / 1.85×，不透明度 ÷1.4 与 ÷2.4', () => {
    const copies = resolveTemperaEchoCopies(30, -40, 0.5, true);
    expect(copies).toHaveLength(2);
    expect(copies[0]).toMatchObject({ dx: 30, dy: -40, alpha: 0.5 / 1.4, visible: true });
    expect(copies[1]).toMatchObject({
      dx: 30 * 1.85,
      dy: -40 * 1.85,
      alpha: 0.5 / 2.4,
      visible: true,
    });
  });

  it('阈值是**严格大于**：恰好 0.004 时整组隐藏', () => {
    const atThreshold = resolveTemperaEchoCopies(10, 10, TEMPERA_ECHO_VISIBLE_MIN, true);
    expect(atThreshold.every((copy) => copy.visible)).toBe(false);
    const above = resolveTemperaEchoCopies(10, 10, TEMPERA_ECHO_VISIBLE_MIN + 0.001, true);
    expect(above.every((copy) => copy.visible)).toBe(true);
  });

  it('正文不可见时回响一起收掉（哪怕 echoAlpha 很大）', () => {
    const copies = resolveTemperaEchoCopies(10, 10, 1, false);
    expect(copies.every((copy) => copy.visible)).toBe(false);
    // 偏移与不透明度照算（上游也不清零，只是不显示）。
    expect(copies[0]?.alpha).toBeCloseTo(1 / 1.4, 6);
  });

  it('没有入场位移时（stamp）两层都落在基准点上且不透明度为 0', () => {
    const copies = resolveTemperaEchoCopies(0, 0, 0, true);
    expect(copies.map((copy) => [copy.dx, copy.dy, copy.visible])).toEqual([
      [0, 0, false],
      [0, 0, false],
    ]);
  });
});
