/**
 * 网纹展开（`resolveSonnetFixedGeoHatchLines` / `resolveSonnetFixedGeoDraws`）的用例（第 399 轮补）。
 * 期望值手算：偏移从 `−w` 起、步长 `spacing`、到 `< w + h` 为止 ⇒ 条数固定；
 * 每条线的水平跨度**等于区域高度 `h`**（上游用 `lineTo(x + i + h, y + h)` ✓）。
 */

import { describe, expect, it } from 'vitest';
import {
  resolveSonnetFixedGeoDraws,
  resolveSonnetFixedGeoHatchLines,
  resolveSonnetFixedGeoParts,
  resolveSonnetFixedGeoVariant,
  type SonnetFixedGeoHatch,
} from './sonnetFixedGeo';

const HATCH: SonnetFixedGeoHatch = {
  kind: 'hatch',
  x: 100,
  y: 50,
  w: 40,
  h: 25,
  spacing: 6,
  alpha: 0.15,
  accent: false,
};

describe('固定几何：网纹 → 斜线', () => {
  it('条数 = ceil((w + h + w) / spacing) = ceil(105 / 6) = 18', () => {
    const lines = resolveSonnetFixedGeoHatchLines(HATCH);
    expect(lines).toHaveLength(18);
  });

  it('第一条线：从 (x − w, y) 画到 (x − w + h, y + h)，跨度为 h', () => {
    const first = resolveSonnetFixedGeoHatchLines(HATCH)[0];
    expect(first?.x1).toBeCloseTo(60, 6); // 100 − 40
    expect(first?.y1).toBeCloseTo(50, 6);
    expect(first?.x2).toBeCloseTo(85, 6); // 60 + 25
    expect(first?.y2).toBeCloseTo(75, 6);
    expect(first?.alpha).toBeCloseTo(0.15, 6);
  });

  it('递增关系：每条线相对前一条右移 spacing，且所有线跨度都等于 h', () => {
    const lines = resolveSonnetFixedGeoHatchLines(HATCH);
    lines.forEach((line, index) => {
      expect(line.x2 - line.x1).toBeCloseTo(HATCH.h, 6);
      expect(line.y2 - line.y1).toBeCloseTo(HATCH.h, 6);
      if (index > 0) {
        const previous = lines[index - 1]!;
        expect(line.x1 - previous.x1).toBeCloseTo(HATCH.spacing, 6);
      }
    });
  });

  it('spacing ≤ 0 时返回空数组（不进入死循环）', () => {
    expect(resolveSonnetFixedGeoHatchLines({ ...HATCH, spacing: 0 })).toEqual([]);
  });

  it('摊平后：网纹变成线、其余图元原样保留（数量对得上）', () => {
    // 随便挑一个种子，按它自己的档位来断言（不猜哈希值 ✓）。
    const seed = 5;
    const parts = resolveSonnetFixedGeoParts(seed, 100);
    const hatchParts = parts.filter((part) => part.kind === 'hatch');
    const others = parts.length - hatchParts.length;
    const expectedLines = hatchParts.reduce(
      (sum, part) => (part.kind === 'hatch' ? sum + resolveSonnetFixedGeoHatchLines(part).length : sum),
      0,
    );
    const draws = resolveSonnetFixedGeoDraws(parts);
    expect(draws).toHaveLength(others + expectedLines);
    expect(draws.some((draw) => draw.kind === 'hatch')).toBe(false);
    expect(draws.some((draw) => draw.kind === 'line')).toBe(expectedLines > 0);
    // 档位本身也顺手核一下没变。
    expect(resolveSonnetFixedGeoVariant(seed)).toBeGreaterThanOrEqual(0);
  });
});
