/**
 * 莫奈（monet）**几何与动效数值**的自查（长期保留，`pnpm test` 的默认 include 会自动收进来）。
 *
 * 这里钉的都是「照 folia 的数值表实现」这件事本身：缩放曲线、三态公式、行间距、
 * 轨道锚点、扫光几何、辉光包络、装饰粒子分布。改这些数值时它必须红，
 * 否则「逐帧逼近」就无从谈起。
 */

import { describe, expect, it } from 'vitest';
import {
  MONET_LARGE_SCREEN_MAX_SCALE,
  MONET_LARGE_SCREEN_MIN_PX,
  buildMonetDecorParticles,
  buildMonetGraphemeOffsets,
  estimateMonetWrappedLines,
  monetSweepMaskImage,
  positionMonetRailEntries,
  resolveMonetFillWidth,
  resolveMonetFontPx,
  resolveMonetGlow,
  resolveMonetGlowRadii,
  resolveMonetInactiveScale,
  resolveMonetLargeScreenScale,
  resolveMonetLineGap,
  resolveMonetLineTone,
  resolveMonetRailHeightPx,
  resolveMonetSweepEdgeSoftness,
  resolveMonetSweepGeometry,
  sampleMonetSpectrumProfile,
} from './monetLayout';

describe('monet 大屏缩放与字号', () => {
  it('1536px 及以下不缩放，2200px 到 1.16，中间线性', () => {
    expect(resolveMonetLargeScreenScale(1200, 1200)).toBe(1);
    expect(resolveMonetLargeScreenScale(MONET_LARGE_SCREEN_MIN_PX, 1280)).toBe(1);
    expect(resolveMonetLargeScreenScale(2200, 2200)).toBeCloseTo(MONET_LARGE_SCREEN_MAX_SCALE, 6);
    const middle = resolveMonetLargeScreenScale(1868, 1868);
    expect(middle).toBeGreaterThan(1);
    expect(middle).toBeLessThan(MONET_LARGE_SCREEN_MAX_SCALE);
  });

  it('容器宽为 0 时退回视口宽，两者都为 0 时退回 1280', () => {
    expect(resolveMonetLargeScreenScale(0, 2200)).toBeCloseTo(MONET_LARGE_SCREEN_MAX_SCALE, 6);
    expect(resolveMonetLargeScreenScale(0, 0)).toBe(1);
  });

  it('三档字号走 clamp(下限, 视口比例, 上限)，并乘上 fontScale 与 layoutScale', () => {
    const narrow = resolveMonetFontPx(800, 1, 1);
    // 800px 宽：2.75vw = 22px，被下限 1.34rem = 21.44px 顶住 ⇒ 取 22。
    expect(narrow.lyric).toBeCloseTo(800 * 0.0275, 6);
    const wide = resolveMonetFontPx(4000, 1, 1);
    // 4000px 宽：2.75vw = 110px，被上限 2.28rem = 36.48px 顶住。
    expect(wide.lyric).toBeCloseTo(2.28 * 16, 6);
    const scaled = resolveMonetFontPx(800, 1.2, 1.16);
    expect(scaled.lyric).toBeCloseTo(narrow.lyric * 1.2 * 1.16, 6);
  });
});

describe('monet 行三态与间距', () => {
  it('当前句 fixed 在 opacity 1 / scale 1 / blur 0，墨色 alpha 0.34', () => {
    const tone = resolveMonetLineTone('active', 0, 0.8);
    expect(tone).toMatchObject({ opacity: 1, scale: 1, blurPx: 0, baseAlpha: 0.34, active: true });
    expect(tone.zIndex).toBe(4);
  });

  it('等待行按距离衰减：opacity / scale / blur 三档都对得上公式', () => {
    const near = resolveMonetLineTone('waiting', 1, 0.8);
    expect(near.opacity).toBeCloseTo(0.72, 6);
    expect(near.scale).toBeCloseTo(0.8, 6);
    expect(near.blurPx).toBeCloseTo(0.7, 6);
    expect(near.baseAlpha).toBeCloseTo(0.46, 6);

    const second = resolveMonetLineTone('waiting', 2, 0.8);
    expect(second.opacity).toBeCloseTo(0.54, 6);
    expect(second.scale).toBeCloseTo(0.8 * 0.9, 6);
    expect(second.blurPx).toBeCloseTo(1.8, 6);
  });

  it('唱过的行用另一条更暗的曲线（scale 有 0.68 的地板）', () => {
    const passed = resolveMonetLineTone('passed', 3, 0.9);
    expect(passed.opacity).toBeCloseTo(0.28, 6);
    // 0.9 × 0.9² = 0.729，还在 0.68 的地板之上。
    expect(passed.scale).toBeCloseTo(0.9 * 0.9 * 0.9, 6);
    expect(passed.blurPx).toBeCloseTo(1.1 + 2 * 0.7, 6);
    expect(passed.baseAlpha).toBeCloseTo(0.36, 6);
    // 距离再远就压到地板上。
    expect(resolveMonetLineTone('passed', 6, 0.9).scale).toBeCloseTo(0.68, 6);
  });

  it('非当前句的字号系数夹在 0.72 ~ 0.92', () => {
    expect(resolveMonetInactiveScale(20, 40)).toBeCloseTo(0.72, 6);
    expect(resolveMonetInactiveScale(36, 40)).toBeCloseTo(0.9, 6);
    expect(resolveMonetInactiveScale(40, 40)).toBeCloseTo(0.92, 6);
  });

  it('相邻行里有当前句时用大间距，否则用小的那档', () => {
    expect(resolveMonetLineGap(true, false, 36)).toBeCloseTo(Math.max(18, 36 * 0.49), 6);
    expect(resolveMonetLineGap(false, true, 36)).toBeCloseTo(Math.max(18, 36 * 0.49), 6);
    expect(resolveMonetLineGap(false, false, 36)).toBeCloseTo(Math.max(14, 36 * 0.38), 6);
    // 字号很小时由固定 px 兜底。
    expect(resolveMonetLineGap(false, false, 10)).toBe(14);
  });
});

describe('monet 轨道定位', () => {
  it('当前句的中心钉在轨道高的 46%，上下按「行高 + gap」逐行推开', () => {
    const positions = positionMonetRailEntries(
      [
        { scaledHeightPx: 40, active: false },
        { scaledHeightPx: 50, active: true },
        { scaledHeightPx: 40, active: false },
      ],
      520,
      36,
    );
    expect(positions[1]).toBeCloseTo(520 * 0.46 - 25, 6);
    expect(positions[2]).toBeCloseTo(
      (positions[1] ?? 0) + 50 + Math.max(18, 36 * 0.49),
      6,
    );
    expect(positions[0]).toBeCloseTo(
      (positions[1] ?? 0) - 40 - Math.max(18, 36 * 0.49),
      6,
    );
  });

  it('没有当前句时退到第一行当锚点（不会整条轨道跑偏）', () => {
    const positions = positionMonetRailEntries(
      [
        { scaledHeightPx: 40, active: false },
        { scaledHeightPx: 40, active: false },
      ],
      520,
      36,
    );
    expect(positions[0]).toBeCloseTo(520 * 0.46 - 20, 6);
    expect(positions[1]).toBeGreaterThan(positions[0] ?? 0);
  });

  it('轨道高度取 max(520 × layoutScale, 字号 × 1.18 × 7)', () => {
    expect(resolveMonetRailHeightPx(36, 1)).toBe(520);
    // 60px 字号算出来 495.6，还不如基准 520，所以仍是 520。
    expect(resolveMonetRailHeightPx(60, 1)).toBe(520);
    // 80px 字号才顶上去。
    expect(resolveMonetRailHeightPx(80, 1)).toBe(Math.round(80 * 1.18 * 7));
    expect(resolveMonetRailHeightPx(36, 1.16)).toBe(Math.round(520 * 1.16));
  });
});

describe('monet 逐字扫光', () => {
  it('累计宽度从 0 起、末项等于整行宽', () => {
    expect(buildMonetGraphemeOffsets([10, 20, 30])).toEqual([0, 10, 30, 60]);
    expect(buildMonetGraphemeOffsets([])).toEqual([0]);
  });

  it('填充宽度在起点为 0、终点为满、中间线性', () => {
    expect(resolveMonetFillWidth(5, 5, 7, 100)).toBe(0);
    expect(resolveMonetFillWidth(7, 5, 7, 100)).toBe(100);
    expect(resolveMonetFillWidth(6, 5, 7, 100)).toBeCloseTo(50, 6);
  });

  it('边缘柔和度夹在 6 ~ 16px', () => {
    expect(resolveMonetSweepEdgeSoftness(5)).toBe(6);
    expect(resolveMonetSweepEdgeSoftness(20)).toBe(9);
    expect(resolveMonetSweepEdgeSoftness(80)).toBe(16);
  });

  it('遮罩四段式：solidEnd 在 featherStart 之前，featherEnd 随进度外扩', () => {
    const start = resolveMonetSweepGeometry(0, 100, 10);
    expect(start).toEqual({ solidEndPx: 0, featherStartPx: 0, featherEndPx: 0 });
    const half = resolveMonetSweepGeometry(50, 100, 10);
    expect(half.featherEndPx).toBeCloseTo(55, 6);
    expect(half.solidEndPx).toBeCloseTo(45, 6);
    expect(half.featherStartPx).toBeCloseTo(49.5, 6);
    // 扫完之后还要多走一个柔和度的距离，尾缘才算完全离开这个词。
    const done = resolveMonetSweepGeometry(100, 100, 10);
    expect(done.featherEndPx).toBeCloseTo(110, 6);
  });

  it('遮罩字符串把几何写成 90deg 的四段 linear-gradient', () => {
    const mask = monetSweepMaskImage(resolveMonetSweepGeometry(50, 100, 10));
    expect(mask).toContain('linear-gradient(90deg');
    expect(mask).toContain('rgba(0, 0, 0, 1) 0px');
    expect(mask).toContain('rgba(0, 0, 0, 1) 45.00px');
    expect(mask).toContain('rgba(0, 0, 0, 0) 55.00px');
  });
});

describe('monet 辉光包络', () => {
  it('起点为 0、rise 结束时到 1、尾端回到 0，且全程在 0~1', () => {
    const start = 10;
    const end = 12;
    const lineEnd = 14;
    expect(resolveMonetGlow(9, start, end, lineEnd)).toBe(0);
    expect(resolveMonetGlow(start, start, end, lineEnd)).toBe(0);
    const rise = Math.max(0.001, end - start) * 1.18;
    expect(resolveMonetGlow(start + rise, start, end, lineEnd)).toBeCloseTo(1, 6);
    expect(resolveMonetGlow(lineEnd + 5, start, end, lineEnd)).toBeCloseTo(0, 6);
    for (const time of [10, 10.5, 11, 11.5, 12, 13, 14, 15]) {
      const value = resolveMonetGlow(time, start, end, lineEnd);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('两个辉光半径按字号，副歌那一档更大', () => {
    expect(resolveMonetGlowRadii(40, false)).toEqual({ radiusOne: 11, radiusTwo: 26, maxAlpha: 0.88 });
    expect(resolveMonetGlowRadii(40, true)).toEqual({ radiusOne: 18, radiusTwo: 36, maxAlpha: 1 });
  });
});

describe('monet 折行估算与装饰', () => {
  it('贪心折行：放不下就换行，空输入至少一行', () => {
    expect(estimateMonetWrappedLines([], 100)).toBe(1);
    expect(estimateMonetWrappedLines([60, 30], 100)).toBe(1);
    expect(estimateMonetWrappedLines([60, 60], 100)).toBe(2);
    expect(estimateMonetWrappedLines([120], 100)).toBe(1);
  });

  it('十个装饰粒子的分布与 folia 的取模公式一致且在合法范围内', () => {
    const particles = buildMonetDecorParticles();
    expect(particles).toHaveLength(10);
    expect(particles[0]).toMatchObject({
      id: 0,
      // x = ((0 × 127 + 43) % 80) + 10 = 53；y = ((0 × 211 + 17) % 80) + 5 = 22。
      xPercent: 53,
      yPercent: 22,
      sizePx: 46,
      rotation: 0,
      durationSec: 20,
      delaySec: 0,
      reverse: true,
    });
    for (const particle of particles) {
      expect(particle.xPercent).toBeGreaterThanOrEqual(10);
      expect(particle.xPercent).toBeLessThan(90);
      expect(particle.yPercent).toBeGreaterThanOrEqual(5);
      expect(particle.yPercent).toBeLessThan(85);
      expect(particle.opacity).toBeGreaterThan(0);
      expect(particle.opacity).toBeLessThan(0.2);
    }
  });

  it('频谱轮廓恒在 0~1，且低频端比高频端高', () => {
    const bands = [0.9, 0.7, 0.5, 0.4, 0.3];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const value = sampleMonetSpectrumProfile(bands, t);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(sampleMonetSpectrumProfile(bands, 0)).toBeGreaterThan(
      sampleMonetSpectrumProfile(bands, 1),
    );
  });
});
