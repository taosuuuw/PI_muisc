/**
 * 莫奈漂移（`monetDrift.ts`）的用例（第 408 轮补）。
 *
 * 两部分：**手算的三个档位**（0 / 0.5 / 1）与**一条不变量** ——
 * 预放大必须大于"缩放幅度 + 位移幅度"（这是上游那句"预先放大以免露边"的可验证形式 ✓）。
 */

import { describe, expect, it } from 'vitest';
import {
  MONET_DRIFT_CYCLE_SECONDS,
  MONET_DRIFT_DEFAULT,
  resolveMonetBackgroundDrift,
  resolveMonetBackgroundDriftStyle,
} from './monetDrift';

const expectDrift = (
  strength: number,
  scaleRange: number,
  translatePercent: number,
  preScale: number,
): void => {
  const drift = resolveMonetBackgroundDrift(strength);
  expect(drift.scaleRange).toBeCloseTo(scaleRange, 6);
  expect(drift.translatePercent).toBeCloseTo(translatePercent, 6);
  expect(drift.preScale).toBeCloseTo(preScale, 6);
  expect(drift.durationSeconds).toBe(MONET_DRIFT_CYCLE_SECONDS);
};

describe('莫奈漂移：三个档位手算', () => {
  it('strength = 0：不动，但**仍然预放大 1.02**（上游"图片预先放大一点"的体现）', () => {
    // scaleRange 0、translatePercent 0 ⇒ preScale = (1 + 0 + 0) × 1.02 = 1.02
    expectDrift(0, 0, 0, 1.02);
  });

  it('strength = 0.5（上游默认）：缩放 3%、位移 0.6%、预放大 1.05672', () => {
    // 0.5 × 0.06 = 0.03；0.5 × 1.2 = 0.6；(1 + 0.03 + 0.006) × 1.02 = 1.036 × 1.02
    expectDrift(0.5, 0.03, 0.6, 1.05672);
  });

  it('strength = 1：缩放 6%、位移 1.2%、预放大 1.09344', () => {
    // (1 + 0.06 + 0.012) × 1.02 = 1.072 × 1.02
    expectDrift(1, 0.06, 1.2, 1.09344);
  });

  it('越界夹取：负数按 0、超过 1 按 1', () => {
    expect(resolveMonetBackgroundDrift(-3)).toEqual(resolveMonetBackgroundDrift(0));
    expect(resolveMonetBackgroundDrift(9)).toEqual(resolveMonetBackgroundDrift(1));
  });
});

describe('莫奈漂移：不露边不变量', () => {
  it('任何 strength 下，预放大都严格大于"缩放幅度 + 位移幅度"', () => {
    for (const strength of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      const drift = resolveMonetBackgroundDrift(strength);
      const excursion = drift.scaleRange + drift.translatePercent / 100;
      expect(drift.preScale - 1).toBeGreaterThan(excursion);
      expect(drift.preScale).toBeGreaterThanOrEqual(1);
    }
  });

  it('幅度随强度单调不减', () => {
    const sequence = [0, 0.2, 0.4, 0.6, 0.8, 1].map((strength) =>
      resolveMonetBackgroundDrift(strength),
    );
    sequence.forEach((drift, index) => {
      if (index === 0) return;
      const previous = sequence[index - 1]!;
      expect(drift.scaleRange).toBeGreaterThanOrEqual(previous.scaleRange);
      expect(drift.translatePercent).toBeGreaterThanOrEqual(previous.translatePercent);
      expect(drift.preScale).toBeGreaterThanOrEqual(previous.preScale);
    });
  });
});

describe('莫奈漂移：样式字符串', () => {
  it('单位与小数位（preScale 四位、translate 三位、duration 带 s）', () => {
    const style = resolveMonetBackgroundDriftStyle(0.5);
    expect(style.preScale).toBe('1.0567'); // toFixed(4)
    expect(style.duration).toBe('18s');
    expect(style.translate).toBe('0.600'); // toFixed(3)
  });
});

describe('莫奈漂移：默认值与"不弄脏缓存"的边界', () => {
  it('默认值照抄上游 DEFAULT_MONET_BACKGROUND_TUNING：enabled / strength = true / 0.5', () => {
    expect(MONET_DRIFT_DEFAULT.enabled).toBe(true);
    expect(MONET_DRIFT_DEFAULT.strength).toBe(0.5);
    // 默认强度喂进映射应当与手算一致（这条把"默认值"和"映射"绑在一起，防两边各改各的 ✓）。
    expect(resolveMonetBackgroundDrift(MONET_DRIFT_DEFAULT.strength).preScale).toBeCloseTo(1.05672, 6);
  });

  it('样式的四个键都在（含 `scaleRange`，动画两端点要靠它）', () => {
    const style = resolveMonetBackgroundDriftStyle(MONET_DRIFT_DEFAULT.strength);
    expect(Object.keys(style).sort()).toEqual(['duration', 'preScale', 'scaleRange', 'translate']);
    expect(style.preScale).toBe('1.0567'); // toFixed(4)
    expect(style.scaleRange).toBe('0.0300'); // 0.5 × 0.06 = 0.03 ⇒ toFixed(4)
    expect(style.duration).toBe('18s');
    expect(style.translate).toBe('0.600'); // toFixed(3)
  });

  it('本模块只出"DOM 侧参数"：不含任何位图/缓存相关字段（边界写死在注释里 ✓）', () => {
    // 四个数的语义：倍数 / 秒 / 百分比 —— 都不参与位图烘焙 ✓
    const drift = resolveMonetBackgroundDrift(MONET_DRIFT_DEFAULT.strength);
    expect(Object.keys(drift).sort()).toEqual([
      'durationSeconds',
      'preScale',
      'scaleRange',
      'translatePercent',
    ]);
  });
});
