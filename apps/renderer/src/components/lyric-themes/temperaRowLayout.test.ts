/**
 * 凝彩断行/行高的自查用例（数值与判定顺序来自上游 `temperaLayout.ts`）。
 *
 * 守四件事：① 换歌词行**必然**换排版行；② 行首词的 `leadingGap` **不计**；
 * ③ 每行预算按行序号摆动（同 seed 可复现、换 seed 会变）；④ 行高落在
 * `fontSize × 最大 scale × [1.02, 1.12]` 区间内。
 */

import { describe, expect, it } from 'vitest';
import { TEMPERA_ENTER_STYLES } from './temperaGlyphMotion';
import {
  TEMPERA_MIN_FONT_SIZE,
  TEMPERA_ROW_BUDGET_BASE,
  TEMPERA_ROW_BUDGET_SPAN,
  TEMPERA_ROW_HEIGHT_BASE,
  TEMPERA_ROW_HEIGHT_SPAN,
  composeTemperaPlacements,
  fitTemperaLayout,
  packTemperaRows,
  resolveTemperaGlyphLanding,
  resolveTemperaRowBudget,
  resolveTemperaRowHeight,
  resolveTemperaRowPlacement,
  resolveTemperaWordPlacement,
  resolveTemperaWordScales,
  rotateAbout,
  type TemperaMeasuredWord,
  type TemperaRow,
  type TemperaRowWord,
} from './temperaRowLayout';

const word = (over: Partial<TemperaRowWord> = {}): TemperaRowWord => ({
  width: 100,
  leadingGap: 20,
  lineIndex: 0,
  scale: 1,
  ...over,
});

describe('凝彩断行与行高（照抄上游规则）', () => {
  it('预算与行高的区间：72%~100% 与 1.02~1.12 倍', () => {
    for (let rowIndex = 0; rowIndex < 20; rowIndex += 1) {
      const budget = resolveTemperaRowBudget(3, rowIndex, 1000);
      expect(budget).toBeGreaterThanOrEqual(1000 * TEMPERA_ROW_BUDGET_BASE - 1e-9);
      expect(budget).toBeLessThanOrEqual(1000 * (TEMPERA_ROW_BUDGET_BASE + TEMPERA_ROW_BUDGET_SPAN) + 1e-9);
      const height = resolveTemperaRowHeight(3, rowIndex, 40, 1.5);
      expect(height).toBeGreaterThanOrEqual(40 * 1.5 * TEMPERA_ROW_HEIGHT_BASE - 1e-9);
      expect(height).toBeLessThanOrEqual(
        40 * 1.5 * (TEMPERA_ROW_HEIGHT_BASE + TEMPERA_ROW_HEIGHT_SPAN) + 1e-9,
      );
    }
  });

  it('换歌词行必然换排版行；同一个词行内不再断', () => {
    const rows = packTemperaRows(
      [word({ lineIndex: 0 }), word({ lineIndex: 0 }), word({ lineIndex: 1 }), word({ lineIndex: 1 })],
      10000,
      5,
      40,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.words.every((item) => item.lineIndex === 0)).toBe(true);
    expect(rows[1]?.words.every((item) => item.lineIndex === 1)).toBe(true);
  });

  it('行宽只累加"首词宽度 + 后续 宽度+前置间距"（行首不计 leadingGap）', () => {
    const rows = packTemperaRows([word({ width: 100, leadingGap: 20 }), word({ width: 50, leadingGap: 30 })], 10000, 1, 40);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.width).toBeCloseTo(100 + 50 + 30, 6);
  });

  it('预算摆动真的会让断点变化：同样的词、不同的 seed ⇒ 行数/分组可能不同', () => {
    const words = Array.from({ length: 12 }, () => word({ width: 100, leadingGap: 0 }));
    // 最大宽度 400 ⇒ 每行 4 个左右；预算在 288~400 之间摆动 ⇒ 断点取决于该行 seed。
    const a = packTemperaRows(words, 400, 1, 40).map((row) => row.words.length);
    // 至少同 seed 可复现。
    expect(packTemperaRows(words, 400, 1, 40).map((row) => row.words.length)).toEqual(a);
    /*
     * **写用例时的自我更正**：我一开始断言"换 seed 必然断得不同" —— 实测 seed 1 与 2 恰好相同，
     * 测试失败。**那是测试写错了，不是实现错了**：预算摆动只是让断点**可能**变化，
     * 单个种子对不能保证不同。改成"扫多个种子，至少有一个与基准不同"，
     * 这样陈述的是机制（摆动真的在起作用），而不是某个具体种子的巧合。
     */
    const others = [2, 3, 4, 5, 6, 7, 8].map((seed) =>
      packTemperaRows(words, 400, seed, 40).map((row) => row.words.length),
    );
    expect(others.some((split) => JSON.stringify(split) !== JSON.stringify(a))).toBe(true);
  });

  it('词级摆放与三层旋转落点：角度区间、顺序不可换、全零角时位置不变', () => {
    // 词级旋转 ±0.035、纵向微移 ±0.045 × 字号。
    for (let wordSalt = 0; wordSalt < 20; wordSalt += 1) {
      const placed = resolveTemperaWordPlacement(11, wordSalt, 40, 300);
      expect(Math.abs(placed.rotation)).toBeLessThanOrEqual(0.035 + 1e-9);
      expect(Math.abs(placed.shiftY)).toBeLessThanOrEqual(40 * 0.045 + 1e-9);
      expect(placed.centerY).toBeCloseTo(300 + placed.shiftY, 6);
    }
    // 三层旋转全为 0 ⇒ 落点就是原坐标。
    const flat = resolveTemperaGlyphLanding({
      localX: 12,
      wordCenterX: 10,
      wordCenterY: 20,
      wordRotation: 0,
      rowCenterX: 0,
      rowCenterY: 0,
      rowRotation: 0,
      regionCenterX: 100,
      regionCenterY: 200,
      regionRotation: 0,
    });
    expect(flat.x).toBeCloseTo(12, 6);
    expect(flat.y).toBeCloseTo(20, 6);
    /*
     * **顺序不可换**：手工按"词→行→区域"重算一遍，结果必须相等；
     * 而按"区域→行→词"的顺序重算则**不应**相等（除非角度恰好为 0）。
     */
    const input = {
      localX: 30,
      wordCenterX: 10,
      wordCenterY: 20,
      wordRotation: 0.05,
      rowCenterX: 40,
      rowCenterY: 0,
      rowRotation: -0.03,
      regionCenterX: 100,
      regionCenterY: 200,
      regionRotation: 0.02,
    };
    const step1 = rotateAbout(input.localX, input.wordCenterY, input.wordCenterX, input.wordCenterY, input.wordRotation);
    const step2 = rotateAbout(step1.x, step1.y, input.rowCenterX, input.rowCenterY, input.rowRotation);
    const inOrder = rotateAbout(step2.x, step2.y, input.regionCenterX, input.regionCenterY, input.regionRotation);
    expect(resolveTemperaGlyphLanding(input).x).toBeCloseTo(inOrder.x, 6);
    expect(resolveTemperaGlyphLanding(input).y).toBeCloseTo(inOrder.y, 6);

    const rev1 = rotateAbout(input.localX, input.wordCenterY, input.regionCenterX, input.regionCenterY, input.regionRotation);
    const rev2 = rotateAbout(rev1.x, rev1.y, input.rowCenterX, input.rowCenterY, input.rowRotation);
    const reversed = rotateAbout(rev2.x, rev2.y, input.wordCenterX, input.wordCenterY, input.wordRotation);
    expect(Math.abs(reversed.x - inOrder.x) + Math.abs(reversed.y - inOrder.y)).toBeGreaterThan(1e-6);
  });

  it('逐词字号：主角落在 1.34~1.60、其余 0.70~0.86；主角候选是"最长或次长"的实词', () => {
    const lengths = [1, 4, 3, 2];
    for (let seed = 0; seed < 12; seed += 1) {
      const scales = resolveTemperaWordScales(lengths, seed, 0);
      expect(scales).toHaveLength(4);
      const heroCount = scales.filter((scale) => scale >= 1.34).length;
      // 每行**恰好一个**主角。
      expect(heroCount).toBe(1);
      scales.forEach((scale) => {
        if (scale >= 1.34) {
          expect(scale).toBeLessThanOrEqual(1.6 + 1e-9);
        } else {
          expect(scale).toBeGreaterThanOrEqual(0.7 - 1e-9);
          expect(scale).toBeLessThanOrEqual(0.86 + 1e-9);
        }
      });
      // 主角只能是候选里的（字素数 ≥ 最长 − 1 ⇒ 索引 1 或 2）。
      const heroIndex = scales.findIndex((scale) => scale >= 1.34);
      expect([1, 2]).toContain(heroIndex);
    }
    // 没有任何实词（长度全 0）⇒ 整行都是"其余"。
    const none = resolveTemperaWordScales([0, 0], 3, 0);
    expect(none.every((scale) => scale < 1)).toBe(true);
    // 确定性。
    expect(resolveTemperaWordScales(lengths, 7, 2)).toEqual(resolveTemperaWordScales(lengths, 7, 2));
  });

  it('四轮收缩拟合：装得下就停；装不下按 fit 缩并最多 4 轮；字号有 14 的下限', () => {
    // 行宽/行高与字号成正比：装不下时 fit 会把字号一次算到刚好。
    const buildRows = (fontSize: number) => [
      { words: [], width: fontSize * 100, height: fontSize * 20 },
    ];
    // 区域 500 × 300：字号 10 时宽 1000 > 500 ⇒ 需要缩到 5。
    const sizes: number[] = [];
    const tight = fitTemperaLayout({
      baseFontSize: 10,
      fontScale: 1,
      regionWidth: 500,
      regionHeight: 300,
      buildRows: (fontSize) => {
        sizes.push(fontSize);
        return [{ words: [], width: fontSize * 100, height: fontSize * 20 }];
      },
      maxAttempts: 4,
    });
    /*
     * **写用例时的自我更正**：我原以为"最终字号也不会低于 14"，实测是 5 ⇒ 我错了：
     * 上游的 `Math.max(14, …)` **只管初值**，之后的每一轮是直接 `fontSize ×= fit`，
     * 所以**最终可以落到 14 以下**。这里改成断言"初值被 14 顶住、最终确实缩下去了"。
     */
    expect(sizes[0]).toBe(TEMPERA_MIN_FONT_SIZE);
    expect(tight.fontSize).toBeLessThan(TEMPERA_MIN_FONT_SIZE);
    expect(tight.attempts).toBeLessThanOrEqual(4);
    // 装得下：一轮就停。
    const loose = fitTemperaLayout({
      baseFontSize: 10,
      fontScale: 1,
      regionWidth: 5000,
      regionHeight: 5000,
      buildRows,
    });
    expect(loose.attempts).toBe(1);
    // 初值被 14 顶住 ⇒ 装得下时**最终就是 14**（不是 base 的 10）。同一处 floor 的第二种后果。
    expect(loose.fontSize).toBe(TEMPERA_MIN_FONT_SIZE);
    // 需要缩：字号 100 时宽 10000、区域宽 500 ⇒ 首轮 fit = 0.05，第二轮起就装得下。
    const shrink = fitTemperaLayout({
      baseFontSize: 100,
      fontScale: 1,
      regionWidth: 500,
      regionHeight: 100000,
      buildRows,
    });
    expect(shrink.attempts).toBe(2);
    expect(shrink.fontSize).toBeCloseTo(5, 6);
    expect(shrink.rows[0]?.width).toBeCloseTo(500, 6);
  });

  it('整块装配：索引带得出来、入场四项齐全、坐标有限且纵向围绕区域中心', () => {
    const word = (
      width: number,
      leadingGap: number,
      lineIndex: number,
      scale: number,
      chars: string[],
    ): TemperaMeasuredWord => ({
      width,
      leadingGap,
      lineIndex,
      scale,
      segmentIndex: lineIndex,
      glyphs: chars.map((char, index) => ({ char, offset: index * 20, width: 20 })),
    });
    const rows: TemperaRow<TemperaMeasuredWord>[] = [
      { words: [word(40, 0, 0, 1.4, ['主', '角'])], width: 40, height: 50 },
      { words: [word(60, 12, 0, 0.8, ['其', '余', '词'])], width: 72, height: 40 },
    ];
    const region = { centerX: 500, centerY: 300, width: 800, align: 'center' as const, rotation: 0.02 };
    const composed = composeTemperaPlacements({
      seed: 21,
      region,
      fontSize: 40,
      baseAngle: 0.3,
      baseMagnitude: 55,
      rows,
    });
    // 5 个字形（空白字会被跳过，这里没有空白）。
    expect(composed).toHaveLength(5);
    expect(composed.map((item) => item.rowIndex)).toEqual([0, 0, 1, 1, 1]);
    expect(composed.map((item) => item.wordIndex)).toEqual([0, 0, 0, 0, 0]);
    expect(composed.map((item) => item.glyphIndex)).toEqual([0, 1, 0, 1, 2]);
    composed.forEach((item) => {
      expect(Number.isFinite(item.x)).toBe(true);
      expect(Number.isFinite(item.y)).toBe(true);
      expect(item.fontSize).toBeGreaterThan(0);
      expect(item.enterScale).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(item.enterScale).toBeLessThanOrEqual(0.9 + 1e-9);
      expect(TEMPERA_ENTER_STYLES).toContain(item.enterStyle);
    });
    // 纵向：两行合起来（50 + 40 = 90）以区域中心为中线 ⇒ 平均 y 贴近 300（词级微移会让它略偏）。
    const meanY = composed.reduce((sum, item) => sum + item.y, 0) / composed.length;
    expect(Math.abs(meanY - 300)).toBeLessThan(12);
    // 确定性。
    expect(
      composeTemperaPlacements({ seed: 21, region, fontSize: 40, baseAngle: 0.3, baseMagnitude: 55, rows }),
    ).toEqual(composed);
  });

  it('空输入返回空数组', () => {
    expect(packTemperaRows([], 400, 1, 40)).toEqual([]);
  });

  it('行摆放：center 用带符号 drift，left/right 贴区域边缘且只用 |drift| × 0.6', () => {
    const region = { centerX: 500, centerY: 300, width: 800, align: 'center' as const };
    for (let rowIndex = 0; rowIndex < 20; rowIndex += 1) {
      const placed = resolveTemperaRowPlacement(9, rowIndex, region, 200, 50, 100);
      // 倾斜区间 ±0.03（`(v − 0.5) × 0.06`）。
      expect(Math.abs(placed.rotation)).toBeLessThanOrEqual(0.03 + 1e-9);
      // center 对齐：行中心 = 区域中心 + drift（带符号）。
      expect(placed.centerX).toBeCloseTo(500 + placed.drift, 6);
      // 纵向：行中心 = 游标 + 行高的一半。
      expect(placed.centerY).toBeCloseTo(100 + 25, 6);
      // 错开幅度不超过区域宽的 3%。
      expect(Math.abs(placed.drift)).toBeLessThanOrEqual(region.width * 0.03 + 1e-9);
    }
    // left：行从区域左缘开始（行中心 = 左缘 + 半宽 + |drift| × 0.6）。
    const left = resolveTemperaRowPlacement(9, 3, { ...region, align: 'left' }, 200, 50, 0);
    expect(left.centerX).toBeCloseTo(500 - 400 + 100 + Math.abs(left.drift) * 0.6, 6);
    // right：行贴着区域右缘（行中心 = 右缘 − 半宽 − |drift| × 0.6）。
    const right = resolveTemperaRowPlacement(9, 3, { ...region, align: 'right' }, 200, 50, 0);
    expect(right.centerX).toBeCloseTo(500 + 400 - 100 - Math.abs(right.drift) * 0.6, 6);
    // 确定性：同 seed 同行序结果一致。
    expect(resolveTemperaRowPlacement(9, 3, region, 200, 50, 0)).toEqual(
      resolveTemperaRowPlacement(9, 3, region, 200, 50, 0),
    );
  });
});
