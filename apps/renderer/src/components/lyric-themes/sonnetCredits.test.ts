/**
 * 商籁片尾时间线的用例（第 524 轮）。
 * 除了几个**端点**（可手算 ✓），重点放**性质**：
 * 随 `elapsed` 增大 ⇒ `lyricAlpha` 单调不增、`posterAlpha` 单调不减、`posterScale` 单调不减 ✓
 * —— 这是"退场/入场不会倒退"的直接保证 ✓（也是我第 489 轮学到的教训：**性质比点值更能抓 bug** ✓）。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_CREDITS_LYRIC_BLUR_MAX,
  SONNET_CREDITS_POSTER_OFFSET_Y,
  SONNET_CREDITS_POSTER_SCALE_FROM,
  hasSonnetCreditsMetadata,
  normalizeSonnetCreditsValue,
  resolveSonnetCreditsFrame,
} from './sonnetCredits';

describe('商籁片尾：元数据判定', () => {
  it('归一：去空格；空串 / null / undefined ⇒ ""', () => {
    expect(normalizeSonnetCreditsValue('  hello  ')).toBe('hello');
    expect(normalizeSonnetCreditsValue('')).toBe('');
    expect(normalizeSonnetCreditsValue(null)).toBe('');
    expect(normalizeSonnetCreditsValue(undefined)).toBe('');
  });

  it('三个字段任一非空 ⇒ true；全空/全空格 ⇒ false', () => {
    expect(hasSonnetCreditsMetadata({})).toBe(false);
    expect(hasSonnetCreditsMetadata({ title: '   ' })).toBe(false);
    expect(hasSonnetCreditsMetadata({ title: '', artist: null, album: undefined })).toBe(false);
    expect(hasSonnetCreditsMetadata({ artist: 'Aimer' })).toBe(true);
    expect(hasSonnetCreditsMetadata({ album: '  x ' })).toBe(true);
    expect(hasSonnetCreditsMetadata({ title: 'T' })).toBe(true);
  });
});

describe('商籁片尾：时间线端点', () => {
  it('未到末句结束（含恰好 0）⇒ 不激活，且是"起始位"', () => {
    for (const time of [-5, 0, 9.99]) {
      const frame = resolveSonnetCreditsFrame(time, 10);
      expect(frame.active).toBe(false);
      expect(frame.lyricAlpha).toBe(1);
      expect(frame.lyricBlur).toBe(0);
      expect(frame.posterAlpha).toBe(0);
      expect(frame.posterOffsetY).toBeCloseTo(SONNET_CREDITS_POSTER_OFFSET_Y, 12);
      expect(frame.posterScale).toBeCloseTo(SONNET_CREDITS_POSTER_SCALE_FROM, 12);
    }
  });

  it('海报延迟 0.38s 未到 ⇒ 海报仍为 0 / 起始偏移 / 起始缩放', () => {
    const frame = resolveSonnetCreditsFrame(10.2, 10);
    expect(frame.active).toBe(true);
    expect(frame.posterAlpha).toBeCloseTo(0, 12);
    expect(frame.posterOffsetY).toBeCloseTo(SONNET_CREDITS_POSTER_OFFSET_Y, 12);
    expect(frame.posterScale).toBeCloseTo(SONNET_CREDITS_POSTER_SCALE_FROM, 12);
    // 歌词已经在退场路上 ✓
    expect(frame.lyricAlpha).toBeLessThan(1);
    expect(frame.lyricAlpha).toBeGreaterThan(0);
  });

  it('歌词退场历时 1.25s：到点 ⇒ alpha 0、blur 到上限 18', () => {
    const frame = resolveSonnetCreditsFrame(11.25, 10);
    expect(frame.lyricAlpha).toBeCloseTo(0, 12);
    expect(frame.lyricBlur).toBeCloseTo(SONNET_CREDITS_LYRIC_BLUR_MAX, 12);
  });

  it('很久之后 ⇒ 海报完全到位（alpha 1、偏移 0、缩放 1），歌词保持退净', () => {
    const frame = resolveSonnetCreditsFrame(60, 10);
    expect(frame.active).toBe(true);
    expect(frame.lyricAlpha).toBeCloseTo(0, 12);
    expect(frame.lyricBlur).toBeCloseTo(SONNET_CREDITS_LYRIC_BLUR_MAX, 12);
    expect(frame.posterAlpha).toBeCloseTo(1, 12);
    expect(frame.posterOffsetY).toBeCloseTo(0, 12);
    expect(frame.posterScale).toBeCloseTo(1, 12);
  });
});

describe('商籁片尾：性质（扫一遍时间轴）', () => {
  it('歌词 alpha 单调不增且始终在 [0,1]；blur 单调不减且不超过 18', () => {
    let previousAlpha = Number.POSITIVE_INFINITY;
    let previousBlur = Number.NEGATIVE_INFINITY;
    for (let elapsed = 0; elapsed <= 4; elapsed += 0.02) {
      const frame = resolveSonnetCreditsFrame(10 + elapsed, 10);
      expect(frame.lyricAlpha).toBeLessThanOrEqual(previousAlpha + 1e-12);
      expect(frame.lyricBlur).toBeGreaterThanOrEqual(previousBlur - 1e-12);
      expect(frame.lyricAlpha).toBeGreaterThanOrEqual(0);
      expect(frame.lyricAlpha).toBeLessThanOrEqual(1);
      expect(frame.lyricBlur).toBeGreaterThanOrEqual(0);
      expect(frame.lyricBlur).toBeLessThanOrEqual(SONNET_CREDITS_LYRIC_BLUR_MAX + 1e-12);
      previousAlpha = frame.lyricAlpha;
      previousBlur = frame.lyricBlur;
    }
  });

  it('海报 alpha / 缩放单调不减，偏移单调不增，且都在端点之内', () => {
    let previousAlpha = Number.NEGATIVE_INFINITY;
    let previousScale = Number.NEGATIVE_INFINITY;
    let previousOffset = Number.POSITIVE_INFINITY;
    for (let elapsed = 0; elapsed <= 4; elapsed += 0.02) {
      const frame = resolveSonnetCreditsFrame(10 + elapsed, 10);
      expect(frame.posterAlpha).toBeGreaterThanOrEqual(previousAlpha - 1e-12);
      expect(frame.posterScale).toBeGreaterThanOrEqual(previousScale - 1e-12);
      expect(frame.posterOffsetY).toBeLessThanOrEqual(previousOffset + 1e-12);
      expect(frame.posterAlpha).toBeGreaterThanOrEqual(0);
      expect(frame.posterAlpha).toBeLessThanOrEqual(1);
      expect(frame.posterScale).toBeGreaterThanOrEqual(SONNET_CREDITS_POSTER_SCALE_FROM - 1e-12);
      expect(frame.posterScale).toBeLessThanOrEqual(1 + 1e-12);
      expect(frame.posterOffsetY).toBeGreaterThanOrEqual(0);
      expect(frame.posterOffsetY).toBeLessThanOrEqual(SONNET_CREDITS_POSTER_OFFSET_Y + 1e-12);
      previousAlpha = frame.posterAlpha;
      previousScale = frame.posterScale;
      previousOffset = frame.posterOffsetY;
    }
  });

  it('海报在歌词退出之后再开始（时间上"接棒"而不是同时）', () => {
    // 0.38 < 1.25 ⇒ 海报起步时歌词还没走完；但海报走到一半（0.38+1.55/2 ≈ 1.155）时歌词已快没了
    const early = resolveSonnetCreditsFrame(10 + 0.1, 10);
    expect(early.posterAlpha).toBeCloseTo(0, 12);
    expect(early.lyricAlpha).toBeLessThan(1); // 歌词已经动了
    const mid = resolveSonnetCreditsFrame(10 + 0.96, 10);
    expect(mid.lyricAlpha).toBeLessThan(early.lyricAlpha);
    expect(mid.posterAlpha).toBeGreaterThan(0);
  });
});
