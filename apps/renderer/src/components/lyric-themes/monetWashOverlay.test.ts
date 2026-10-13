/**
 * 上游 `monetBackgroundPipeline` 里"不需要 DOM"那部分的用例（第 280 轮）。
 *
 * 期望值全部**手算**，不是把实现抄一遍 —— 这条纪律在本会话已经救过三次。
 */

import { describe, expect, it } from 'vitest';
import {
  MONET_OVERLAY_STOPS,
  MONET_STREAK_COUNT,
  MONET_WASH_MIDPOINT,
  resolveMonetOverlayAlpha,
  resolveMonetStreaks,
  resolveMonetWashColor,
} from './monetWash';

const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };
const RED = { r: 200, g: 0, b: 0 };

describe('莫奈逐像素 wash（上游 resolveWashColor）', () => {
  it('中点常量就是上游那个 0.55', () => {
    expect(MONET_WASH_MIDPOINT).toBeCloseTo(0.55, 6);
  });

  it('t=0 ⇒ 纯 shadow；t=0.55 ⇒ 纯 accent；t=1 ⇒ 纯 highlight（端点不该被中点插值污染）', () => {
    const atZero = resolveMonetWashColor(0, BLACK, RED, WHITE);
    const atMid = resolveMonetWashColor(0.55, BLACK, RED, WHITE);
    const atOne = resolveMonetWashColor(1, BLACK, RED, WHITE);
    expect(atZero).toEqual(BLACK);
    expect(atMid).toEqual(RED);
    expect(atOne).toEqual(WHITE);
  });

  it('前半段在中点处正好等于 accent（按比例插值，不是跳变）', () => {
    // t = 0.275 ⇒ 0.275/0.55 = 0.5 ⇒ shadow 与 accent 各一半。
    const half = resolveMonetWashColor(0.275, BLACK, { r: 100, g: 100, b: 100 }, WHITE);
    expect(half).toEqual({ r: 50, g: 50, b: 50 });
  });

  it('后半段同理，且越界会被夹到 0~1', () => {
    // t = 0.775 ⇒ (0.775−0.55)/0.45 = 0.5 ⇒ accent 与 highlight 各一半（accent=100 ⇒ 177.5）。
    const half = resolveMonetWashColor(0.775, BLACK, { r: 100, g: 100, b: 100 }, WHITE);
    expect(half.r).toBeCloseTo(177.5, 6);
    expect(resolveMonetWashColor(-5, BLACK, RED, WHITE)).toEqual(BLACK);
    expect(resolveMonetWashColor(9, BLACK, RED, WHITE)).toEqual(WHITE);
  });

  it('明暗顺序由 wash 规则决定：background 比 primary 亮时，两端的角色会互换', () => {
    const atZero = resolveMonetWashColor(0, WHITE, RED, BLACK); // 白底 ⇒ shadow=primary(黑)
    const atOne = resolveMonetWashColor(1, WHITE, RED, BLACK); // highlight=background(白)
    expect(atZero).toEqual(BLACK);
    expect(atOne).toEqual(WHITE);
  });
});

describe('莫奈 overlay 透明度与条纹（上游 paintMonetOverlay）', () => {
  it('三个停靠的系数就是上游写的那组数', () => {
    expect(MONET_OVERLAY_STOPS.map((stop) => [stop.offset, stop.channel, stop.base, stop.gain])).toEqual([
      [0, 'accent', 0.08, 0.62],
      [0.44, 'background', 0.16, 0.58],
      [1, 'primary', 0.06, 0.36],
    ]);
  });

  it('overlay=0 / 1 的透明度（手算：base+gain×overlay，并夹 0~1）', () => {
    expect(resolveMonetOverlayAlpha(0.08, 0.62, 0)).toBeCloseTo(0.08, 6);
    expect(resolveMonetOverlayAlpha(0.08, 0.62, 1)).toBeCloseTo(0.7, 6);
    expect(resolveMonetOverlayAlpha(0.16, 0.58, 1)).toBeCloseTo(0.74, 6);
    expect(resolveMonetOverlayAlpha(0.06, 0.36, 1)).toBeCloseTo(0.42, 6);
    // 越界夹住
    expect(resolveMonetOverlayAlpha(0.08, 0.62, -3)).toBeCloseTo(0.08, 6);
    expect(resolveMonetOverlayAlpha(0.9, 0.9, 5)).toBeCloseTo(1, 6);
  });

  it('条纹 18 根，位置就是取模公式（x=(i×127)%w、y=((i×211)%h)−40、高 0.28h）', () => {
    expect(MONET_STREAK_COUNT).toBe(18);
    const streaks = resolveMonetStreaks(1920, 1080);
    expect(streaks).toHaveLength(18);
    expect(streaks[0]).toEqual({ x: 0, y: -40, height: 1080 * 0.28 });
    expect(streaks[1]).toEqual({ x: 127, y: 171, height: 1080 * 0.28 });
    expect(streaks[2]).toEqual({ x: 254, y: 382, height: 1080 * 0.28 });
    // 最后一根：17×127 = 2159 ⇒ 2159 % 1920 = 239；17×211 = 3587 ⇒ 3587 % 1080 = 347 ⇒ y = 307。
    expect(streaks[17]?.x).toBe(239);
    expect(streaks[17]?.y).toBe(307);
  });

  it('换尺寸时仍是同一套取模规则（1930 宽下第 16 根会回绕）', () => {
    const streaks = resolveMonetStreaks(1000, 500);
    // 8×127 = 1016 ⇒ 1016 % 1000 = 16。
    expect(streaks[8]?.x).toBe(16);
    // 8×211 = 1688 ⇒ 1688 % 500 = 188 ⇒ y = 148。
    expect(streaks[8]?.y).toBe(148);
  });
});
