/**
 * 凝彩缓动原语的自查用例（数值全部来自上游 `tempera/temperaMotionEasing.ts`）。
 *
 * 守三件事：① 贝塞尔的端点与"12 次二分"带来的固有误差量级；
 * ② `inOut` 是 **0.62 / 0.32** 这条（不要跟商籁的 0.65 / 0.35 混）；
 * ③ `softBack` 的 `c = 1.42` 到底给出多少过冲、峰值在哪 —— 这些是"手感"的量化描述。
 */

import { describe, expect, it } from 'vitest';
import {
  clamp01,
  easeTemperaEnter,
  easeTemperaInOut,
  easeTemperaSoftBack,
  resolveCubicBezier,
} from './temperaEasing';

describe('凝彩缓动（照抄上游数值）', () => {
  it('贝塞尔：端点精确、单调不减、12 次二分的误差量级在 1e-3 内', () => {
    expect(resolveCubicBezier(0.62, 0, 0.32, 1, 0)).toBe(0);
    expect(resolveCubicBezier(0.62, 0, 0.32, 1, 1)).toBe(1);
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(9)).toBe(1);
    let previous = -1;
    for (let step = 0; step <= 50; step += 1) {
      const value = easeTemperaEnter(step / 50);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    /*
     * **写用例时的自我更正**：我一开始按商籁那条（对称 0.65/0.35）的经验，
     * 断言"中点应在 0.5 附近" —— 实测差 **0.0634**。这不是二分误差，而是**曲线形状**：
     * `0.62 / 0.32` 是**不对称**控制点，所以在 `x = 0.5` 处 `y ≈ 0.5634`（已经走过一半多）。
     * 这条更正本身就是"凝彩 ≠ 商籁缓动"的硬证据。
     */
    expect(easeTemperaInOut(0.5)).toBeGreaterThan(0.5);
    expect(easeTemperaInOut(0.5)).toBeCloseTo(0.5634, 3);
  });

  it('inOut 用的是 0.62 / 0.32，与商籁那条 0.65 / 0.35 不是同一条曲线', () => {
    const tempera = easeTemperaInOut(0.25);
    const sonnetLike = resolveCubicBezier(0.65, 0, 0.35, 1, 0.25);
    // 控制点不同 ⇒ 四分之一处应当能量出差别（同一条曲线时这里会相等）。
    expect(Math.abs(tempera - sonnetLike)).toBeGreaterThan(1e-3);
    // 不对称曲线的特征：前半段慢于后半段（0.75 处的"补足量"大于 0.25 处）。
    expect(1 - easeTemperaInOut(0.75)).toBeLessThan(easeTemperaInOut(0.25));
  });

  it('softBack：两端精确落在 0/1，中途有过冲（c = 1.42 的回弹）', () => {
    expect(easeTemperaSoftBack(0)).toBeCloseTo(0, 6);
    expect(easeTemperaSoftBack(1)).toBeCloseTo(1, 6);
    let peak = 0;
    let peakAt = 0;
    for (let step = 0; step <= 200; step += 1) {
      const t = step / 200;
      const value = easeTemperaSoftBack(t);
      if (value > peak) {
        peak = value;
        peakAt = t;
      }
    }
    // 有回弹 ⇒ 必定过冲；且过冲发生在后半程（收尾那一下）。
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.1);
    expect(peakAt).toBeGreaterThan(0.6);
  });
});
