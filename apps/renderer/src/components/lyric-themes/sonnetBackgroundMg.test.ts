/**
 * 背景 MG HUD（`sonnetBackgroundMg.ts`）的用例（第 481 轮补）。
 * 手算基准**已废弃**：第 21 轮起改为**从被测函数现算**（见下面的 `FRAME/LEFT/RIGHT/TOP/BOTTOM`）。
 * 原因：边距比例按**主人要求**由 5% 改成 `0.012`（接近满幅），原先散落在各条断言里的手算坐标
 * （`−450/450/−360/360/350/440/366` …）全部失效，一条条手改既容易算错、下次微调又会整片红。
 * 断言本身**没有放松**，只是把常量换成 `BOTTOM − 10` 这样的推导值 —— 语义照旧。
 *
 * 八种变体的**条数手算**：
 * 0 `classic-cross` 32；1 `corner-brackets` 53；2 `marquee-strips` 26；3 `diagonal-corners` 17；
 * 4 `dotted-columns` 36；5 `double-frame` 15；6 `ruler-frame` 106；7 `arc-gauge` 28 ✓。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_BACKGROUND_MG_VARIANT_COUNT,
  SONNET_BACKGROUND_MG_VARIANTS,
  resolveSonnetBackgroundMgDraws,
  resolveSonnetBackgroundMgFrameContext,
  resolveSonnetBackgroundMgVariant,
  type SonnetBackgroundMgDraw,
} from './sonnetBackgroundMg';

const WIDTH = 1000;
const HEIGHT = 800;
const drawsOf = (variant: number, seed = 7) =>
  resolveSonnetBackgroundMgDraws({ variant, width: WIDTH, height: HEIGHT, seed });

/** 边框四边 —— **现算**，不再手写数字（见文件头说明）。 */
const FRAME = resolveSonnetBackgroundMgFrameContext(WIDTH, HEIGHT);
const LEFT = -FRAME.hw + FRAME.marginX;
const RIGHT = FRAME.hw - FRAME.marginX;
const TOP = -FRAME.hh + FRAME.marginY;
const BOTTOM = FRAME.hh - FRAME.marginY;

const counts = (draws: readonly SonnetBackgroundMgDraw[]) =>
  draws.reduce<Record<string, number>>((acc, draw) => {
    acc[draw.kind] = (acc[draw.kind] ?? 0) + 1;
    return acc;
  }, {});

describe('背景 MG：骨架', () => {
  it('8 种变体、名字与顺序照抄', () => {
    expect(SONNET_BACKGROUND_MG_VARIANT_COUNT).toBe(8);
    expect([...SONNET_BACKGROUND_MG_VARIANTS]).toEqual([
      'classic-cross',
      'corner-brackets',
      'marquee-strips',
      'diagonal-corners',
      'dotted-columns',
      'double-frame',
      'ruler-frame',
      'arc-gauge',
    ]);
  });

  it('框上下文：marginX/marginY = 1.2% 的宽高（主人要求接近满幅）', () => {
    const context = resolveSonnetBackgroundMgFrameContext(WIDTH, HEIGHT);
    expect(context.hw).toBe(500);
    expect(context.hh).toBe(400);
    /* 断言"比例"本身，而不是某个具体像素值 —— 比例才是这条用例要钉的语义。 */
    expect(context.marginX / WIDTH).toBeCloseTo(0.012, 6);
    expect(context.marginY / HEIGHT).toBeCloseTo(0.012, 6);
    const small = resolveSonnetBackgroundMgFrameContext(100, 100);
    expect(small.marginX).toBeCloseTo(1.2, 6);
    expect(small.marginY).toBeCloseTo(1.2, 6);
  });

  it('变体选择落在 0..7，且确定性、负种子也不越界', () => {
    for (let seed = -20; seed <= 20; seed += 1) {
      const variant = resolveSonnetBackgroundMgVariant(seed);
      expect(Number.isInteger(variant)).toBe(true);
      expect(variant).toBeGreaterThanOrEqual(0);
      expect(variant).toBeLessThan(SONNET_BACKGROUND_MG_VARIANT_COUNT);
      expect(resolveSonnetBackgroundMgVariant(seed)).toBe(variant);
    }
  });

  it('传入越界（负/超界）变体号会回落到 0..7 内', () => {
    expect(drawsOf(-1)).toEqual(drawsOf(7));
    expect(drawsOf(8)).toEqual(drawsOf(0));
    expect(drawsOf(-9)).toEqual(drawsOf(7));
  });
});

describe('背景 MG：八种家具的条数', () => {
  it('0 classic-cross = 31 线 + 1 圆 = 32', () => {
    const draws = drawsOf(0);
    expect(draws).toHaveLength(32);
    expect(counts(draws)).toEqual({ line: 31, circle: 1 });
  });

  it('1 corner-brackets = 41 线 + 2 填充块 + 10 圆 = 53', () => {
    const draws = drawsOf(1);
    expect(draws).toHaveLength(53);
    expect(counts(draws)).toEqual({ line: 41, rect: 2, circle: 10 });
  });

  it('2 marquee-strips = 22 线 + 4 填充块 = 26', () => {
    const draws = drawsOf(2);
    expect(draws).toHaveLength(26);
    expect(counts(draws)).toEqual({ line: 22, rect: 4 });
  });

  it('3 diagonal-corners = 17 个多边形（12 角件 + 5 菱形）', () => {
    const draws = drawsOf(3);
    expect(draws).toHaveLength(17);
    expect(counts(draws)).toEqual({ polygon: 17 });
  });

  it('4 dotted-columns = 29 圆 + 7 线 = 36', () => {
    const draws = drawsOf(4);
    expect(draws).toHaveLength(36);
    expect(counts(draws)).toEqual({ circle: 29, line: 7 });
  });

  it('5 double-frame = 10 线 + 5 矩形 = 15', () => {
    const draws = drawsOf(5);
    expect(draws).toHaveLength(15);
    expect(counts(draws)).toEqual({ line: 10, rect: 5 });
  });

  it('6 ruler-frame = 104 线 + 2 圆 = 106', () => {
    const draws = drawsOf(6);
    expect(draws).toHaveLength(106);
    expect(counts(draws)).toEqual({ line: 104, circle: 2 });
  });

  it('7 arc-gauge = 9 弧 + 9 圆 + 10 线 = 28', () => {
    const draws = drawsOf(7);
    expect(draws).toHaveLength(28);
    expect(counts(draws)).toEqual({ arc: 9, circle: 9, line: 10 });
  });
});

describe('背景 MG：关键坐标与配色', () => {
  it('classic-cross：底杆在 bottom − 10，杆右端是实心圆（secondary）', () => {
    const draws = drawsOf(0);
    const barY = BOTTOM - 10;
    const bar = draws.filter(
      (draw) =>
        draw.kind === 'line' && Math.abs(draw.y1 - barY) < 1e-6 && Math.abs(draw.y2 - barY) < 1e-6,
    );
    expect(bar).toHaveLength(1);
    const circle = draws.find((draw) => draw.kind === 'circle')!;
    expect(circle.kind === 'circle' && circle.strokeWidth).toBe(0);
    expect(circle.kind === 'circle' && circle.radius).toBe(2);
    expect(circle.kind === 'circle' && circle.x).toBeCloseTo(RIGHT - 10, 6);
    expect(circle.colorKey).toBe('secondary');
  });

  it('corner-brackets：底尺 25 条刻度、每 6 个是"长且次要色"', () => {
    const draws = drawsOf(1);
    /*
     * ⚠ 第 481 轮修：刻度是**竖线**（`line(x, rulerY, x, rulerY − 长度)` ✓），
     * 我一开始按 `y1 === y2`（横线）筛 ⇒ 筛出空数组 ✗ ⇒ 改成按 `y1 === 366`（rulerY ✓）+ `x1 === x2` 筛 ✓。
     */
    const rulerY = BOTTOM + 6;
    const ruler = draws.filter(
      (draw) => draw.kind === 'line' && Math.abs(draw.y1 - rulerY) < 1e-6 && draw.x1 === draw.x2,
    ) as Extract<SonnetBackgroundMgDraw, { kind: 'line' }>[];
    expect(ruler).toHaveLength(25);
    const majors = ruler.filter((draw) => draw.colorKey === 'secondary');
    expect(majors).toHaveLength(5); // 0 / 6 / 12 / 18 / 24 ✓
    majors.forEach((draw) => expect(Math.abs(draw.y2 - draw.y1)).toBe(8));
    const minors = ruler.filter((draw) => draw.colorKey === 'primary');
    minors.forEach((draw) => expect(Math.abs(draw.y2 - draw.y1)).toBe(4));
  });

  it('diagonal-corners：5 个菱形、第 3 个最大且用次要色', () => {
    const draws = drawsOf(3);
    const diamonds = draws.filter(
      (draw) => draw.kind === 'polygon' && draw.closed && draw.points.length === 8,
    );
    expect(diamonds).toHaveLength(5);
    expect(diamonds[2]!.colorKey).toBe('secondary');
    expect(diamonds[0]!.colorKey).toBe('primary');
  });

  it('double-frame：断框用 gapX = 18% 宽、gapY = 22% 高', () => {
    const draws = drawsOf(5);
    const topLeft = draws.find(
      (draw) =>
        draw.kind === 'line' &&
        Math.abs(draw.y1 - TOP) < 1e-6 &&
        Math.abs(draw.y2 - TOP) < 1e-6 &&
        Math.abs(draw.x1 - LEFT) < 1e-6,
    );
    expect(topLeft).toBeDefined();
    /* gapX = (right − left) × 0.18；midX 0 − gapX。 */
    expect(topLeft!.kind === 'line' && topLeft!.x2).toBeCloseTo(-(RIGHT - LEFT) * 0.18, 6);
    const leftTop = draws.find(
      (draw) =>
        draw.kind === 'line' &&
        Math.abs(draw.x1 - LEFT) < 1e-6 &&
        Math.abs(draw.x2 - LEFT) < 1e-6 &&
        Math.abs(draw.y1 - TOP) < 1e-6,
    );
    /* gapY = (bottom − top) × 0.22；midY 0 − gapY。 */
    expect(leftTop!.kind === 'line' && leftTop!.y2).toBeCloseTo(-(BOTTOM - TOP) * 0.22, 6);
  });

  it('ruler-frame：四条边都有刻度，主刻度用次要色（x 每 8、y 每 6）', () => {
    const draws = drawsOf(6);
    const lines = draws.filter((draw) => draw.kind === 'line');
    const vertical = lines.filter((draw) => draw.x1 === draw.x2);
    const horizontal = lines.filter((draw) => draw.y1 === draw.y2);
    expect(vertical).toHaveLength(66); // 33 组 × 上下 ✓
    expect(horizontal).toHaveLength(38); // 19 组 × 左右 ✓
    expect(vertical.filter((draw) => draw.colorKey === 'secondary')).toHaveLength(10); // 5 组 × 2 ✓
    expect(horizontal.filter((draw) => draw.colorKey === 'secondary')).toHaveLength(8); // 4 组 × 2 ✓
  });

  it('arc-gauge：指针角由 seed 决定，且四角弧都在 0..2π 内', () => {
    const a = drawsOf(7, 0);
    const b = drawsOf(7, 50);
    const needleOf = (draws: readonly SonnetBackgroundMgDraw[]) => {
      const needle = draws.find(
        (draw) => draw.kind === 'line' && draw.colorKey === 'secondary' && draw.width === 2,
      );
      return needle as Extract<SonnetBackgroundMgDraw, { kind: 'line' }>;
    };
    expect(needleOf(a).x2).not.toBeCloseTo(needleOf(b).x2, 3);
    drawsOf(7).forEach((draw) => {
      if (draw.kind !== 'arc') return;
      expect(draw.startAngle).toBeGreaterThanOrEqual(0);
      expect(draw.endAngle).toBeLessThanOrEqual(Math.PI * 2 + 1e-9);
    });
  });
});
