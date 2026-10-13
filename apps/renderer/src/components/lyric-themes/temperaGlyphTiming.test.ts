/**
 * 凝彩逐字时序落库的自查用例（数值来自上游 `temperaLayout.ts` 的 `applyGlyphTiming`）。
 *
 * 三条规则各守一条：
 * · 归位 = `0.34` 下限 + 到本镜歌词结束所剩距离 × `stretch`（`stretch = 1` 时正好落在结束时刻）；
 * · 释放 = `max(endTime, settleTime) + max(0.5, 本行跨时长)`；
 * · 力臂 = 位置 − **位置算术平均**（所以全部力臂之和为 0）。
 */

import { describe, expect, it } from 'vitest';
import {
  TEMPERA_DEFAULT_SETTLE_STRETCH,
  TEMPERA_MIN_SETTLE_SECONDS,
  applyTemperaGlyphTiming,
  type TemperaTimingPlacement,
} from './temperaGlyphTiming';

const placement = (over: Partial<TemperaTimingPlacement> = {}): TemperaTimingPlacement => ({
  lineIndex: 0,
  startTime: 0,
  endTime: 1,
  x: 0,
  y: 0,
  ...over,
});

describe('凝彩逐字时序落库（照抄上游规则）', () => {
  it('归位：stretch = 0 时一律只给 0.34 秒下限；stretch = 1 时正好落在本镜歌词结束', () => {
    const placements = [placement({ startTime: 0, endTime: 1 }), placement({ startTime: 2, endTime: 3 })];
    // 本镜歌词结束 = 3。
    const noStretch = applyTemperaGlyphTiming(placements, 0);
    expect(noStretch[0]?.settleTime).toBeCloseTo(TEMPERA_MIN_SETTLE_SECONDS, 6);
    expect(noStretch[1]?.settleTime).toBeCloseTo(2 + TEMPERA_MIN_SETTLE_SECONDS, 6);
    const full = applyTemperaGlyphTiming(placements, 1);
    expect(full[0]?.settleTime).toBeCloseTo(3, 6);
    expect(full[1]?.settleTime).toBeCloseTo(3, 6);
    // 默认 0.5：第一个字在"下限 + 所剩距离的一半"处归位。
    const half = applyTemperaGlyphTiming(placements);
    expect(TEMPERA_DEFAULT_SETTLE_STRETCH).toBe(0.5);
    expect(half[0]?.settleTime).toBeCloseTo(0.34 + (3 - 0 - 0.34) * 0.5, 6);
  });

  it('归位不会早于下限：已经很靠近结束的字，仍然拿到完整的 0.34 秒', () => {
    const placements = [placement({ startTime: 0, endTime: 0.5 }), placement({ startTime: 0.4, endTime: 0.5 })];
    const timed = applyTemperaGlyphTiming(placements, 1);
    // 第二个字的 reach = max(0, 0.5 − 0.4 − 0.34) = 0 ⇒ 恰好 0.4 + 0.34。
    expect(timed[1]?.settleTime).toBeCloseTo(0.74, 6);
  });

  it('释放：跟"本行跨多长"走，最短 0.5 秒；且不早于归位', () => {
    const shortLine = [placement({ lineIndex: 0, startTime: 0, endTime: 0.2 })];
    const timedShort = applyTemperaGlyphTiming(shortLine, 0);
    // 行跨 0.2 秒 ⇒ span 取 0.5 下限；releaseTime = max(endTime, settle) + 0.5。
    expect(timedShort[0]?.releaseTime).toBeCloseTo(Math.max(0.2, 0.34) + 0.5, 6);

    const longLine = [
      placement({ lineIndex: 0, startTime: 0, endTime: 4 }),
      placement({ lineIndex: 0, startTime: 3, endTime: 6 }),
      placement({ lineIndex: 1, startTime: 7, endTime: 8 }),
    ];
    const timed = applyTemperaGlyphTiming(longLine, 0);
    // 第 0 行跨 0 ~ 6 ⇒ span = 6。
    expect(timed[0]?.releaseTime).toBeCloseTo(Math.max(4, 0.34) + 6, 6);
  });

  it('力臂：中心是**位置算术平均**，所以全部力臂之和为 0', () => {
    const placements = [placement({ x: 0, y: 0 }), placement({ x: 10, y: -4 }), placement({ x: 20, y: 8 })];
    const timed = applyTemperaGlyphTiming(placements);
    const sumX = timed.reduce((sum, item) => sum + item.trackingX, 0);
    const sumY = timed.reduce((sum, item) => sum + item.trackingY, 0);
    expect(sumX).toBeCloseTo(0, 6);
    expect(sumY).toBeCloseTo(0, 6);
    // 中心 = (10, 4/3)，所以第一个字的力臂是 (0 − 10, 0 − 4/3)。
    expect(timed[0]?.trackingX).toBeCloseTo(-10, 6);
    expect(timed[0]?.trackingY).toBeCloseTo(-4 / 3, 6);
  });

  it('空输入与非法 stretch：空数组原样返回空，非法 stretch 回落 0.5', () => {
    expect(applyTemperaGlyphTiming([])).toEqual([]);
    const placements = [placement({ startTime: 0, endTime: 3 })];
    const broken = applyTemperaGlyphTiming(placements, Number.NaN);
    const fallback = applyTemperaGlyphTiming(placements, TEMPERA_DEFAULT_SETTLE_STRETCH);
    expect(broken[0]?.settleTime).toBeCloseTo(fallback[0]?.settleTime ?? 0, 6);
    // 超出范围的 stretch 会被夹住。
    const over = applyTemperaGlyphTiming(placements, 5);
    const one = applyTemperaGlyphTiming(placements, 1);
    expect(over[0]?.settleTime).toBeCloseTo(one[0]?.settleTime ?? 0, 6);
  });
});
