/**
 * `monetWash` 的用例：明暗定向规则（暗的当 shadow、亮的当 highlight）。
 *
 * 守两件事：① 无论谁亮谁暗，结果都满足 `luminance(shadow) <= luminance(highlight)`；
 * ② 两个颜色互换参数时结果**只是交换**，不会整体反过来。
 */

import { describe, expect, it } from 'vitest';
import {
  MONET_FALLBACK_DARK,
  MONET_FALLBACK_LIGHT,
  monetRelativeLuminance,
  resolveMonetWashCssVars,
  resolveMonetWashEndpoints,
  toMonetRgb,
} from './monetWash';

const DARK = { r: 20, g: 20, b: 24 };
const LIGHT = { r: 240, g: 240, b: 240 };

describe('莫奈底色明暗定向', () => {
  it('相对亮度用 Rec.709 权重', () => {
    expect(monetRelativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(255, 6);
    expect(monetRelativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 6);
    // 纯绿最亮、纯蓝最暗（权重的直接后果）。
    expect(monetRelativeLuminance({ r: 0, g: 255, b: 0 })).toBeGreaterThan(
      monetRelativeLuminance({ r: 255, g: 0, b: 0 }),
    );
    expect(monetRelativeLuminance({ r: 255, g: 0, b: 0 })).toBeGreaterThan(
      monetRelativeLuminance({ r: 0, g: 0, b: 255 }),
    );
  });

  it('深底浅主 ⇒ 底当 shadow；浅底深主 ⇒ 主当 shadow', () => {
    expect(resolveMonetWashEndpoints(DARK, LIGHT)).toEqual({ shadow: DARK, highlight: LIGHT });
    expect(resolveMonetWashEndpoints(LIGHT, DARK)).toEqual({ shadow: DARK, highlight: LIGHT });
    expect(resolveMonetWashEndpoints(MONET_FALLBACK_DARK, MONET_FALLBACK_LIGHT)).toEqual({
      shadow: MONET_FALLBACK_DARK,
      highlight: MONET_FALLBACK_LIGHT,
    });
  });

  it('亮度相等时按传入顺序（background 当 shadow），不抛错', () => {
    const same = { r: 128, g: 128, b: 128 };
    expect(resolveMonetWashEndpoints(same, { r: 128, g: 128, b: 128 }).shadow).toEqual(same);
  });

  it('颜色落成：`rgb()` 直接解析；解析不了给兜底（不依赖 DOM 的那条路径）', () => {
    expect(toMonetRgb('rgb(240, 240, 240)', null)).toEqual({ r: 240, g: 240, b: 240 });
    expect(toMonetRgb('rgb(10,10,12)', null)).toEqual({ r: 10, g: 10, b: 12 });
    // 解析不了的输入（含 `var(...)` 链在没有元素时的情形）⇒ 落到兜底色。
    expect(toMonetRgb('var(--pi-monet-surface)', null)).toEqual(MONET_FALLBACK_DARK);
    expect(toMonetRgb('not-a-color', null)).toEqual(MONET_FALLBACK_DARK);
    expect(toMonetRgb('not-a-color', null, MONET_FALLBACK_LIGHT)).toEqual(MONET_FALLBACK_LIGHT);
  });

  it('一步给出 CSS 变量值：暗的进 shadow、亮的进 highlight（顺序无关）', () => {
    const dark = 'rgb(20, 20, 24)';
    const light = 'rgb(240, 240, 240)';
    expect(resolveMonetWashCssVars(dark, light, null)).toEqual({
      shadow: 'rgb(20, 20, 24)',
      highlight: 'rgb(240, 240, 240)',
    });
    // 参数顺序反过来，结果**不变**（规则自己会把暗的挑出来）。
    expect(resolveMonetWashCssVars(light, dark, null)).toEqual({
      shadow: 'rgb(20, 20, 24)',
      highlight: 'rgb(240, 240, 240)',
    });
    // 落不了色时用**分别**给的深/浅兜底：shadow 仍是暗的那头。
    const fallback = resolveMonetWashCssVars('var(--x)', 'var(--y)', null);
    expect(fallback.shadow).toBe('rgb(10, 10, 12)');
    expect(fallback.highlight).toBe('rgb(245, 245, 245)');
  });

  it('结果永远满足 "shadow 不比 highlight 亮"', () => {
    const samples = [DARK, LIGHT, MONET_FALLBACK_DARK, MONET_FALLBACK_LIGHT, { r: 90, g: 120, b: 60 }];
    samples.forEach((first) => {
      samples.forEach((second) => {
        const { shadow, highlight } = resolveMonetWashEndpoints(first, second);
        expect(monetRelativeLuminance(shadow)).toBeLessThanOrEqual(
          monetRelativeLuminance(highlight) + 1e-9,
        );
      });
    });
  });
});
