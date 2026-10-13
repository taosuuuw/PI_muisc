import { describe, expect, it } from 'vitest';

import {
  TEMPERA_PASS_RESOLUTION_INHERIT,
  compressedPassResolution,
  resolveTemperaPassResolution,
  type TemperaPassResolutionTuning,
} from './temperaPassResolution';

const ON: TemperaPassResolutionTuning = { postProcessTextureCompression: true };
const OFF: TemperaPassResolutionTuning = { postProcessTextureCompression: false };

describe('compressedPassResolution（上游 `Math.min(1, renderResolution)`）', () => {
  it('超过 1 的一律压到 1', () => {
    expect(compressedPassResolution(2)).toBe(1);
    expect(compressedPassResolution(1.5)).toBe(1);
    // 上游默认 textureResolution=1.5，经档位吸附后可能是 1.2047 之类，仍要压到 1。
    expect(compressedPassResolution(1.2047)).toBe(1);
    expect(compressedPassResolution(1.0000001)).toBe(1);
  });

  it('≤1 的原样保留（不放大、不取整）', () => {
    expect(compressedPassResolution(1)).toBe(1);
    expect(compressedPassResolution(0.75)).toBe(0.75);
    expect(compressedPassResolution(0.5)).toBe(0.5);
  });

  it('对任意输入都不超过 1', () => {
    for (const r of [0.25, 0.5, 0.87, 1, 1.25, 1.5, 2, 3]) {
      expect(compressedPassResolution(r)).toBeLessThanOrEqual(1);
    }
  });

  it('输入越大结果不减小（非严格单调）', () => {
    const xs = [0.25, 0.5, 1, 1.5, 2];
    const ys = xs.map((x) => compressedPassResolution(x));
    for (let i = 1; i < ys.length; i += 1) {
      // 开 `noUncheckedIndexedAccess`，索引访问是 `number | undefined`，这里显式收窄。
      const prev = ys[i - 1] ?? 0;
      const cur = ys[i] ?? 0;
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });
});

describe('resolveTemperaPassResolution', () => {
  it('关掉压缩 ⇒ 一律 `inherit`（这才是保住反色正确的那一支）', () => {
    for (const r of [0.5, 1, 1.5, 2]) {
      expect(resolveTemperaPassResolution(OFF, r)).toBe(TEMPERA_PASS_RESOLUTION_INHERIT);
    }
  });

  it('开启压缩 ⇒ 与 compressedPassResolution 完全一致', () => {
    for (const r of [0.25, 0.5, 1, 1.2047, 1.5, 2]) {
      expect(resolveTemperaPassResolution(ON, r)).toBe(compressedPassResolution(r));
    }
  });

  it('`inherit` 是字符串哨兵，不能与数字混淆', () => {
    expect(typeof resolveTemperaPassResolution(OFF, 1.5)).toBe('string');
    expect(typeof resolveTemperaPassResolution(ON, 1.5)).toBe('number');
  });

  it('开启压缩时结果恒为数字且 ≤1（可直接交给 pixi 的 filter resolution）', () => {
    for (const r of [0.1, 0.9, 1, 1.5, 2]) {
      const v = resolveTemperaPassResolution(ON, r);
      expect(typeof v).toBe('number');
      expect(v as number).toBeLessThanOrEqual(1);
      expect(v as number).toBeGreaterThan(0);
    }
  });
});
