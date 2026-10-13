/**
 * 商籁图标"分布与时机"规则的用例（第 543 轮）。全部**手算** ✓。
 * 重点：**band 分布**（哪些粒子带图标 ✓）、**归一化取模**（seed 取负也对 ✓）、
 * **时长三重 min/max 的三条分支**（preferred / scene×0.18 / scene 各命中一次 ✓）。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_ICON_FALLBACK_NAME,
  buildSonnetIconParticleIndices,
  buildSonnetIconTextureKey,
  resolveSonnetIconEntryDelay,
  resolveSonnetIconEntryDuration,
  resolveSonnetIconEntryPhase,
  resolveSonnetIconNames,
} from './sonnetIcons';

describe('商籁图标：名字清洗与兜底', () => {
  it('空数组 / 全空格 ⇒ 兜底 Flower', () => {
    expect(SONNET_ICON_FALLBACK_NAME).toBe('Flower');
    expect(resolveSonnetIconNames([])).toEqual(['Flower']);
    expect(resolveSonnetIconNames(['   ', ''])).toEqual(['Flower']);
    expect(resolveSonnetIconNames(undefined)).toEqual(['Flower']);
  });

  it('非空就保留原样（末项的空格我们不清洗 —— 只判断"非空"）', () => {
    expect(resolveSonnetIconNames(['A', ' B '])).toEqual(['A', ' B ']);
    expect(resolveSonnetIconNames(['Flower'])).toEqual(['Flower']);
  });
});

describe('商籁图标：粒子分布', () => {
  it('`(2, 4, 0)` ⇒ [null, 0, null, 1]（k = min(4, max(1, 2)) = 2）', () => {
    expect(buildSonnetIconParticleIndices(2, 4, 0)).toEqual([null, 0, null, 1]);
  });

  it('图标数为 0 ⇒ 全 null，长度 = 粒子数', () => {
    expect(buildSonnetIconParticleIndices(0, 3, 7)).toEqual([null, null, null]);
    expect(buildSonnetIconParticleIndices(-2, 2, 0)).toEqual([null, null]);
  });

  it('只有 1 个图标 ⇒ 只有最后一个粒子带它（k = min(4, max(1, 1)) = 1）', () => {
    expect(buildSonnetIconParticleIndices(1, 4, 0)).toEqual([null, null, null, 0]);
  });

  it('图标数 ≥ 粒子数 ⇒ 每个粒子都出图标，下标按 seed 轮转', () => {
    expect(buildSonnetIconParticleIndices(6, 4, 0)).toEqual([0, 1, 2, 3]);
    expect(buildSonnetIconParticleIndices(6, 4, 2)).toEqual([2, 3, 4, 5]);
  });

  it('**seed 取负**也一定落进 [0, iconCount)', () => {
    // k = min(4, max(ceil(4/4)=1, 3)) = 3 ✓
    // i=0：band 0 → floor(1×3/4)=0 ⇒ **不出图标**（我第一版漏了这一步 ✗）；i=1..3 各出一个 ⇒ 见下 ✓
    const indices = buildSonnetIconParticleIndices(3, 4, -1);
    expect(indices).toEqual([null, 2, 0, 1]); // ((−1+i) % 3 + 3) % 3 ✓
    for (const value of indices) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(3);
    }
  });

  it('粒子数为 0 或负数 ⇒ 空数组', () => {
    expect(buildSonnetIconParticleIndices(3, 0, 5)).toEqual([]);
    expect(buildSonnetIconParticleIndices(3, -1, 5)).toEqual([]);
  });

  it('**`ceil(n/4)` 这条下限**：图标多于 n/4 时，带图标的粒子数被抬到"每个图标至少一次"', () => {
    // n = 8、图标 4 ⇒ ceil(8/4) = 2，但 max(2, 4) = 4 ⇒ k = 4（而不是 2）⇒ 8 个粒子里有 4 个带图标
    const indices = buildSonnetIconParticleIndices(4, 8, 0);
    expect(indices.filter((value) => value !== null)).toHaveLength(4);
    // 且四个下标互不相同（"每个图标都被用上" ✓）
    expect(new Set(indices.filter((value) => value !== null)).size).toBe(4);
  });
});

describe('商籁图标：入场相位 / 时长 / 延迟', () => {
  it('相位：两端 0.04 / 0.86；单个或零个 ⇒ 0.12；越界被夹', () => {
    expect(resolveSonnetIconEntryPhase(0, 2)).toBeCloseTo(0.04, 12);
    expect(resolveSonnetIconEntryPhase(1, 2)).toBeCloseTo(0.86, 12);
    expect(resolveSonnetIconEntryPhase(0, 3)).toBeCloseTo(0.04, 12);
    expect(resolveSonnetIconEntryPhase(1, 3)).toBeCloseTo(0.45, 12);
    expect(resolveSonnetIconEntryPhase(2, 3)).toBeCloseTo(0.86, 12);
    expect(resolveSonnetIconEntryPhase(0, 1)).toBeCloseTo(0.12, 12);
    expect(resolveSonnetIconEntryPhase(0, 0)).toBeCloseTo(0.12, 12);
    expect(resolveSonnetIconEntryPhase(-5, 3)).toBeCloseTo(0.04, 12);
    expect(resolveSonnetIconEntryPhase(99, 3)).toBeCloseTo(0.86, 12);
  });

  it('时长：三条分支各命中一次（preferred / scene×0.18 / scene）', () => {
    // scene×0.18 = 1.8 最小 ⇒ 1.8 ✓
    expect(resolveSonnetIconEntryDuration(10, 5)).toBeCloseTo(1.8, 12);
    // preferred 0.02 最小 ⇒ 0.02 ✓
    expect(resolveSonnetIconEntryDuration(10, 0.02)).toBeCloseTo(0.02, 12);
    // scene 本身最小（scene = 0.05，而 max(0.08, 0.009) = 0.08 > 0.05）⇒ 0.05 ✓
    expect(resolveSonnetIconEntryDuration(0.05, 5)).toBeCloseTo(0.05, 12);
    // scene 为 0 或负 ⇒ 先兜到 0.01 ⇒ 结果 0.01 ✓
    expect(resolveSonnetIconEntryDuration(0, 5)).toBeCloseTo(0.01, 12);
  });

  it('延迟：phase 0 ⇒ 0；phase 1 ⇒ scene − duration；相位越界被夹；scene 小于 duration ⇒ 0', () => {
    expect(resolveSonnetIconEntryDelay(0, 10, 2)).toBeCloseTo(0, 12);
    expect(resolveSonnetIconEntryDelay(1, 10, 2)).toBeCloseTo(8, 12);
    expect(resolveSonnetIconEntryDelay(2, 10, 2)).toBeCloseTo(8, 12); // clamp01(2) = 1 ✓
    expect(resolveSonnetIconEntryDelay(-3, 10, 2)).toBeCloseTo(0, 12);
    expect(resolveSonnetIconEntryDelay(1, 1, 2)).toBeCloseTo(0, 12); // max(0, −1) ✓
    expect(resolveSonnetIconEntryDelay(0.5, 4, 2)).toBeCloseTo(1, 12);
  });
});

describe('商籁图标：纹理键', () => {
  it('拼接格式 name|color|strokeWidth|size|resolution', () => {
    expect(buildSonnetIconTextureKey('Flower', '#fff', 2, 64, 2)).toBe('Flower|#fff|2|64|2');
    expect(buildSonnetIconTextureKey('A', 'b', 1.5, 32, 1)).toBe('A|b|1.5|32|1');
  });
});
