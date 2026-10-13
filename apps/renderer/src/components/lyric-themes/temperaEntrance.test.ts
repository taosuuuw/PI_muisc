/**
 * 凝彩入场四项的自查用例（盐值与取值范围来自上游 `temperaLayout.ts`）。
 *
 * 守四件事：① 同一个词里的字形**样式一致**（"一个词一种入场"）；② 盐是**词盐 → 字形盐**的两级派生；
 * ③ 角度与距离的抖动落在规定区间内；④ 同一个 seed + 同一组索引**必然可复现**（确定性的前提）。
 */

import { describe, expect, it } from 'vitest';
import { TEMPERA_ENTER_STYLES } from './temperaGlyphMotion';
import {
  TEMPERA_ENTRANCE_SCALE_BASE,
  TEMPERA_ENTRANCE_SCALE_SPAN,
  resolveTemperaEntrance,
  resolveTemperaEnterStyle,
  resolveTemperaGlyphSalt,
  resolveTemperaWordSalt,
  type TemperaEntranceInput,
} from './temperaEntrance';

const input = (over: Partial<TemperaEntranceInput> = {}): TemperaEntranceInput => ({
  seed: 42,
  rowIndex: 0,
  wordIndex: 0,
  glyphIndex: 0,
  baseAngle: 0.4,
  baseMagnitude: 50,
  ...over,
});

describe('凝彩入场四项（照抄盐值与公式）', () => {
  it('盐是两级派生：词盐 = 行×37 + 词序，字形盐 = 词盐×53 + 字形序', () => {
    expect(resolveTemperaWordSalt(0, 0)).toBe(0);
    expect(resolveTemperaWordSalt(2, 3)).toBe(2 * 37 + 3);
    expect(resolveTemperaGlyphSalt(5, 2)).toBe(5 * 53 + 2);
  });

  it('入场样式按**词**挑：同一个词的字形拿到同一种样式；不同词基本不同', () => {
    const wordSalt = resolveTemperaWordSalt(1, 2);
    const style = resolveTemperaEnterStyle(7, wordSalt);
    for (let glyphIndex = 0; glyphIndex < 8; glyphIndex += 1) {
      const fields = resolveTemperaEntrance(input({ seed: 7, rowIndex: 1, wordIndex: 2, glyphIndex }));
      expect(fields.enterStyle).toBe(style);
    }
    // 样式一定是七种之一。
    expect(TEMPERA_ENTER_STYLES).toContain(style);
  });

  it('角度抖动 ±0.85 弧度、距离倍率 0.55~1.60、缩放 0.6~0.9、旋转 ±0.35', () => {
    for (let glyphIndex = 0; glyphIndex < 40; glyphIndex += 1) {
      const fields = resolveTemperaEntrance(input({ glyphIndex }));
      const angle = Math.atan2(fields.enterY, fields.enterX);
      const magnitude = Math.hypot(fields.enterX, fields.enterY);
      expect(Math.abs(angle - 0.4)).toBeLessThanOrEqual(0.85 + 1e-9);
      expect(magnitude).toBeGreaterThanOrEqual(50 * 0.55 - 1e-9);
      expect(magnitude).toBeLessThanOrEqual(50 * 1.6 + 1e-9);
      expect(fields.enterRotation).toBeGreaterThanOrEqual(-0.35 - 1e-9);
      expect(fields.enterRotation).toBeLessThanOrEqual(0.35 + 1e-9);
      expect(fields.enterScale).toBeGreaterThanOrEqual(TEMPERA_ENTRANCE_SCALE_BASE - 1e-9);
      expect(fields.enterScale).toBeLessThanOrEqual(
        TEMPERA_ENTRANCE_SCALE_BASE + TEMPERA_ENTRANCE_SCALE_SPAN + 1e-9,
      );
    }
  });

  it('确定性：同一个 seed + 同一组索引必然给出同一结果；换 seed 或换字形序就会变', () => {
    const a = resolveTemperaEntrance(input());
    const b = resolveTemperaEntrance(input());
    expect(b).toEqual(a);
    const otherGlyph = resolveTemperaEntrance(input({ glyphIndex: 1 }));
    const otherSeed = resolveTemperaEntrance(input({ seed: 43 }));
    // 至少有一项不同（抖动是按盐分别生成的）。
    expect(
      otherGlyph.enterX !== a.enterX ||
        otherGlyph.enterRotation !== a.enterRotation ||
        otherGlyph.enterScale !== a.enterScale,
    ).toBe(true);
    expect(otherSeed.enterScale !== a.enterScale || otherSeed.enterRotation !== a.enterRotation).toBe(true);
  });
});
