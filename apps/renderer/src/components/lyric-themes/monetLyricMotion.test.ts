/**
 * `monetLyricMotion.ts` 的用例 —— 该文件第 215 轮清理后**只剩一处**上游做法：
 * 音频条的一阶低通（其余重复实现已删除，见文件头的废弃说明）。
 */

import { describe, expect, it } from 'vitest';
import { MONET_AUDIO_LOWPASS_ALPHA, applyMonetLowPass } from './monetLyricMotion';

describe('莫奈残留件：音频条一阶低通', () => {
  it('默认 α = 0.12：从 0 向 100 靠一步得 12', () => {
    expect(MONET_AUDIO_LOWPASS_ALPHA).toBeCloseTo(0.12, 6);
    expect(applyMonetLowPass(0, 100)).toBeCloseTo(12, 6);
    expect(applyMonetLowPass(0, 100, 0.5)).toBeCloseTo(50, 6);
  });

  it('α 被夹到 0~1：0 原地不动、1 直接到位、越界等同边界', () => {
    expect(applyMonetLowPass(10, 100, 0)).toBeCloseTo(10, 6);
    expect(applyMonetLowPass(10, 100, 1)).toBeCloseTo(100, 6);
    expect(applyMonetLowPass(10, 100, -3)).toBeCloseTo(10, 6);
    expect(applyMonetLowPass(10, 100, 7)).toBeCloseTo(100, 6);
  });

  it('反复调用会收敛（这是"平滑"该有的样子）', () => {
    let value = 0;
    for (let step = 0; step < 200; step += 1) value = applyMonetLowPass(value, 100);
    expect(value).toBeCloseTo(100, 6);
  });
});
