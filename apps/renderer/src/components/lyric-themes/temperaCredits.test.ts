import { describe, expect, it } from 'vitest';

import { resolveTemperaCreditsFrame } from './temperaCredits';

const END = 10;

describe('凝彩片尾：阶段判定', () => {
  it('active 的阈值是 finalEndTime + 0.35', () => {
    expect(resolveTemperaCreditsFrame(END + 0.34, END).active).toBe(false);
    expect(resolveTemperaCreditsFrame(END + 0.35, END).active).toBe(false);
    expect(resolveTemperaCreditsFrame(END + 0.36, END).active).toBe(true);
  });

  it('末段尾巴结束之前：歌词全亮、海报不可见', () => {
    const frame = resolveTemperaCreditsFrame(END - 1, END);
    expect(frame.lyricAlpha).toBe(1);
    expect(frame.posterAlpha).toBe(0);
    expect(frame.posterOffsetY).toBeCloseTo(0.06, 10);
    expect(frame.posterScale).toBeCloseTo(0.96, 10);
  });
});

describe('凝彩片尾：两条淡出的端点', () => {
  it('歌词：+0.1s 起淡、+1.0s 淡完', () => {
    expect(resolveTemperaCreditsFrame(END + 0.1, END).lyricAlpha).toBeCloseTo(1, 10);
    expect(resolveTemperaCreditsFrame(END + 1.0, END).lyricAlpha).toBeCloseTo(0, 10);
  });

  it('海报：+0.9s 起升、+2.0s 升完', () => {
    expect(resolveTemperaCreditsFrame(END + 0.9, END).posterAlpha).toBeCloseTo(0, 10);
    expect(resolveTemperaCreditsFrame(END + 2.0, END).posterAlpha).toBeCloseTo(1, 10);
  });

  it('海报升完时：偏移归零、缩放到 1', () => {
    const frame = resolveTemperaCreditsFrame(END + 2.0, END);
    expect(frame.posterOffsetY).toBeCloseTo(0, 10);
    expect(frame.posterScale).toBeCloseTo(1, 10);
  });
});

describe('凝彩片尾：单调与量值范围（在各自的窗口内采样）', () => {
  const samples = (from: number, to: number, count: number): number[] =>
    Array.from({ length: count }, (_, index) => from + ((to - from) * index) / (count - 1));

  it('歌词不透明度单调不增、且始终落在 0~1', () => {
    const values = samples(END + 0.1, END + 1.0, 24).map((t) => resolveTemperaCreditsFrame(t, END).lyricAlpha);
    for (let i = 1; i < values.length; i += 1) expect(values[i] ?? 0).toBeLessThanOrEqual(values[i - 1] ?? 0);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(-1e-9);
      expect(value).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('海报不透明度单调不减；偏移与缩放同向收敛到 0 / 1', () => {
    const frames = samples(END + 0.9, END + 2.0, 24).map((t) => resolveTemperaCreditsFrame(t, END));
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i]?.posterAlpha ?? 0).toBeGreaterThanOrEqual(frames[i - 1]?.posterAlpha ?? 0);
      expect(frames[i]?.posterOffsetY ?? 0).toBeLessThanOrEqual(frames[i - 1]?.posterOffsetY ?? 0);
      expect(frames[i]?.posterScale ?? 0).toBeGreaterThanOrEqual(frames[i - 1]?.posterScale ?? 0);
    }
    for (const frame of frames) {
      expect(frame.posterOffsetY).toBeGreaterThanOrEqual(-1e-9);
      expect(frame.posterOffsetY).toBeLessThanOrEqual(0.06 + 1e-9);
      expect(frame.posterScale).toBeGreaterThanOrEqual(0.96 - 1e-9);
      expect(frame.posterScale).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('海报的升起晚于歌词的淡出开始（前者 +0.9s，后者 +0.1s）', () => {
    const early = resolveTemperaCreditsFrame(END + 0.5, END);
    expect(early.lyricAlpha).toBeLessThan(1);
    expect(early.posterAlpha).toBe(0);
  });
});
