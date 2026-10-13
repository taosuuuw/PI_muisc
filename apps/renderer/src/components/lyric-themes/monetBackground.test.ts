/**
 * `monetBackground` 的可测部分（第 281 轮）：**逐像素后处理**与**缓存键**。
 * 画布那层（`loadImage` / `toDataURL`）不在这里测，靠冒烟看图。
 *
 * 期望值全部手算 —— 手算在本会话已经纠过我三次期望值的错。
 */

import { describe, expect, it } from 'vitest';
import {
  applyMonetBackgroundPixels,
  getMonetBackgroundCacheKey,
  MONET_BACKGROUND_DEFAULT_TUNING,
  monetBackgroundTuningFor,
  monetPixelLuminance,
  resolveMonetGlowScale,
  type MonetBackgroundTheme,
  type MonetBackgroundTuning,
} from './monetBackground';

const THEME: MonetBackgroundTheme = {
  backgroundColor: 'rgb(10, 10, 12)',
  primaryColor: 'rgb(245, 245, 245)',
  accentColor: 'rgb(200, 0, 0)',
};

/** ⚠ 这里**不写** `glowScale`：缺省就是 1（＝上游原值），这条 fixture 顺便替它当回归。 */
const IDLE: MonetBackgroundTuning = {
  blurPx: 0,
  overlayOpacity: 0,
  grayscale: 0,
  saturation: 1,
  wash: 0,
  streaksEnabled: true,
};

const pixels = (...rgba: number[]): Uint8ClampedArray => new Uint8ClampedArray(rgba);

describe('莫奈背景逐像素后处理（上游 applyBackgroundPostProcessing）', () => {
  it('Rec.709 亮度是 0~255 口径', () => {
    expect(monetPixelLuminance(255, 255, 255)).toBeCloseTo(255, 6);
    expect(monetPixelLuminance(0, 0, 0)).toBeCloseTo(0, 6);
    // 纯红：0.2126 × 255 = 54.213
    expect(monetPixelLuminance(255, 0, 0)).toBeCloseTo(54.213, 3);
  });

  it('三个参数都"无事可做"时原样不动（上游的早退）', () => {
    const data = pixels(12, 34, 56, 255);
    applyMonetBackgroundPixels(data, THEME, IDLE);
    expect([...data]).toEqual([12, 34, 56, 255]);
  });

  it('grayscale=1 ⇒ 三通道都等于该像素的亮度（纯红 255,0,0 ⇒ 54）', () => {
    const data = pixels(255, 0, 0, 255);
    applyMonetBackgroundPixels(data, THEME, { ...IDLE, grayscale: 1 });
    expect([...data]).toEqual([54, 54, 54, 255]);
  });

  it('saturation=2 ⇒ 以亮度为中心拉大差距（手算 (100,150,200) ⇒ (57,157,255)）', () => {
    const data = pixels(100, 150, 200, 255);
    applyMonetBackgroundPixels(data, THEME, { ...IDLE, saturation: 2 });
    expect([...data]).toEqual([57, 157, 255, 255]);
  });

  it('wash=1 且像素全黑 ⇒ 取 t=0 那端（＝较暗的那个端点色）', () => {
    // background L=10.2（暗）⇒ shadow=background ⇒ t=0 时 wash 色就是它。
    const data = pixels(0, 0, 0, 255);
    applyMonetBackgroundPixels(data, THEME, { ...IDLE, wash: 1 });
    expect([...data]).toEqual([10, 10, 12, 255]);
  });

  it('wash=1 且像素全白 ⇒ 取 t=1 那端（＝较亮的那个端点色）', () => {
    const data = pixels(255, 255, 255, 255);
    applyMonetBackgroundPixels(data, THEME, { ...IDLE, wash: 1 });
    expect([...data]).toEqual([245, 245, 245, 255]);
  });

  it('alpha=0 的像素一律跳过（灰度/wash 都不动它）', () => {
    const data = pixels(255, 0, 0, 0);
    applyMonetBackgroundPixels(data, THEME, { ...IDLE, grayscale: 1, wash: 1 });
    expect([...data]).toEqual([255, 0, 0, 0]);
  });

  it('多像素只改 RGB、不动 alpha（顺序：先灰度、再饱和度）', () => {
    // ⚠ 第二像素是「纯蓝」——**蓝的亮度不是 0**（0.0722 × 255 = 18.41 ⇒ 18）。
    // 我第一版把它当成 0 写了，被这条红测试纠正：灰度mixes 每个通道**朝亮度**靠，
    // 而亮度是"三通道加权和"，纯蓝也有一点亮度。这正是"期望值必须手算到底"的意思。
    const data = pixels(255, 0, 0, 128, 0, 0, 255, 200);
    applyMonetBackgroundPixels(data, THEME, { ...IDLE, grayscale: 1 });
    expect([...data]).toEqual([54, 54, 54, 128, 18, 18, 18, 200]);
  });
});

describe('莫奈背景默认值（上游 src/types.ts 的 DEFAULT_MONET_BACKGROUND_TUNING）', () => {
  it('六个强度值逐一对照上游（照抄，不是我们拍的数）', () => {
    expect(MONET_BACKGROUND_DEFAULT_TUNING.blurPx).toBe(6);
    expect(MONET_BACKGROUND_DEFAULT_TUNING.overlayOpacity).toBe(0.74);
    expect(MONET_BACKGROUND_DEFAULT_TUNING.grayscale).toBe(0);
    expect(MONET_BACKGROUND_DEFAULT_TUNING.saturation).toBe(1.05);
    expect(MONET_BACKGROUND_DEFAULT_TUNING.wash).toBe(0.34);
    expect(MONET_BACKGROUND_DEFAULT_TUNING.streaksEnabled).toBe(true);
  });

  it('第七项 `glowScale` 是**我们加的**（上游没有这个字段），默认 1 ＝ 上游原值', () => {
    expect(MONET_BACKGROUND_DEFAULT_TUNING.glowScale).toBe(1);
  });

  it('默认值下 wash 与 overlay 都**真的会生效**（不是退化配置）', () => {
    // wash 0.34 > 0 ⇒ 逐像素那步会动手；overlay 0.74 > 0 ⇒ 四层 overlay 会叠。
    expect(MONET_BACKGROUND_DEFAULT_TUNING.wash).toBeGreaterThan(0);
    expect(MONET_BACKGROUND_DEFAULT_TUNING.overlayOpacity).toBeGreaterThan(0);
    // grayscale 0 + saturation 1.05（≠1）⇒ 只有饱和度那步在动。
    expect(MONET_BACKGROUND_DEFAULT_TUNING.grayscale).toBe(0);
  });
});

/*
 * 「背景氛围光」开关 → 烤图参数（本轮修正的契约）。
 *
 * 为什么这几条值得单独钉：这团暖光有**两个出口**（CSS 那层 `__bloom` 与烤进位图的
 * `leftBloom`），只关掉前者时画面上照旧是亮的 —— 正是用户报的「并不是在所有歌词动效
 * 都能正常使用」。这里钉的是后者的三件事：开关↔倍率的映射、缺省＝1、以及**缓存键必须换**。
 */
describe('莫奈背景的「封面暖光」倍率（背景氛围光开关）', () => {
  it('缺省（不传）= 1；显式 1 与不传是**同一个**倍率', () => {
    expect(resolveMonetGlowScale(IDLE)).toBe(1);
    expect(resolveMonetGlowScale({ ...IDLE, glowScale: 1 })).toBe(1);
  });

  it('超过上下界的输入被夹到 0~1（不把负 alpha 喂给 canvas）', () => {
    expect(resolveMonetGlowScale({ ...IDLE, glowScale: -3 })).toBe(0);
    expect(resolveMonetGlowScale({ ...IDLE, glowScale: 9 })).toBe(1);
  });

  it('`monetBackgroundTuningFor(false)` ⇒ 0（关掉光）、`(true)` ⇒ 1（一字不改）', () => {
    expect(monetBackgroundTuningFor(false).glowScale).toBe(0);
    expect(monetBackgroundTuningFor(true).glowScale).toBe(1);
  });

  it('它给的其余六项就是上游默认值（开关只动那一团光，不动别的）', () => {
    const { glowScale: _glow, ...rest } = monetBackgroundTuningFor(false);
    expect(rest).toEqual({
      blurPx: MONET_BACKGROUND_DEFAULT_TUNING.blurPx,
      overlayOpacity: MONET_BACKGROUND_DEFAULT_TUNING.overlayOpacity,
      grayscale: MONET_BACKGROUND_DEFAULT_TUNING.grayscale,
      saturation: MONET_BACKGROUND_DEFAULT_TUNING.saturation,
      wash: MONET_BACKGROUND_DEFAULT_TUNING.wash,
      streaksEnabled: MONET_BACKGROUND_DEFAULT_TUNING.streaksEnabled,
    });
  });

  it('overrides 能盖掉默认（公共背景那张要关竖条：`streaksEnabled: false`）', () => {
    const tuning = monetBackgroundTuningFor(false, { streaksEnabled: false });
    expect(tuning.streaksEnabled).toBe(false);
    expect(tuning.glowScale).toBe(0);
  });
});

describe('莫奈背景缓存键（上游 getMonetBackgroundCacheKey 的判据）', () => {
  it('同输入 ⇒ 同键；换封面 URL ⇒ 换键', () => {
    const a = getMonetBackgroundCacheKey({ coverUrl: 'x.jpg', theme: THEME, tuning: IDLE });
    const b = getMonetBackgroundCacheKey({ coverUrl: 'x.jpg', theme: THEME, tuning: IDLE });
    const c = getMonetBackgroundCacheKey({ coverUrl: 'y.jpg', theme: THEME, tuning: IDLE });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('**烤进位图的东西必须进键**：streaks 一开关就换键（上游注释明确要求）', () => {
    const on = getMonetBackgroundCacheKey({ coverUrl: 'x', theme: THEME, tuning: IDLE });
    const off = getMonetBackgroundCacheKey({
      coverUrl: 'x',
      theme: THEME,
      tuning: { ...IDLE, streaksEnabled: false },
    });
    expect(on).not.toBe(off);
  });

  it('暖光倍率也进键：关掉氛围光必须换一张图，否则会命中缓存里那张带光的', () => {
    const on = getMonetBackgroundCacheKey({ coverUrl: 'x', theme: THEME, tuning: IDLE });
    const off = getMonetBackgroundCacheKey({
      coverUrl: 'x',
      theme: THEME,
      tuning: { ...IDLE, glowScale: 0 },
    });
    expect(off).not.toBe(on);
  });

  it('但「不传」与「显式 1」必须同键（缺省不该平白多烤一张图）', () => {
    const absent = getMonetBackgroundCacheKey({ coverUrl: 'x', theme: THEME, tuning: IDLE });
    const explicit = getMonetBackgroundCacheKey({
      coverUrl: 'x',
      theme: THEME,
      tuning: { ...IDLE, glowScale: 1 },
    });
    expect(explicit).toBe(absent);
  });

  it('主题三色任何一个变了都要换键（wash 依赖它们）', () => {
    const base = getMonetBackgroundCacheKey({ coverUrl: 'x', theme: THEME, tuning: IDLE });
    const other = getMonetBackgroundCacheKey({
      coverUrl: 'x',
      theme: { ...THEME, accentColor: 'rgb(0, 200, 0)' },
      tuning: IDLE,
    });
    expect(base).not.toBe(other);
  });

  it('七个调参项逐一变化都能换键（没漏项）', () => {
    const base = getMonetBackgroundCacheKey({ coverUrl: 'x', theme: THEME, tuning: IDLE });
    const variants: MonetBackgroundTuning[] = [
      { ...IDLE, blurPx: 8 },
      { ...IDLE, overlayOpacity: 0.5 },
      { ...IDLE, grayscale: 0.5 },
      { ...IDLE, saturation: 1.5 },
      { ...IDLE, wash: 0.5 },
      { ...IDLE, streaksEnabled: false },
      { ...IDLE, glowScale: 0 },
    ];
    for (const tuning of variants) {
      expect(getMonetBackgroundCacheKey({ coverUrl: 'x', theme: THEME, tuning })).not.toBe(base);
    }
  });
});
