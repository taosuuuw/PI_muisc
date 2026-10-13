/**
 * `planTemperaLayout` 的端到端自查（用**假测量**跑通整条链，不依赖字体/DOM）。
 *
 * 守：① 字形一个不少（空白字素会被装配层跳过这条路径也覆盖）；② 拟合轮数与字号是合理的；
 * ③ 行号带得出来（两行歌词 ⇒ 两种 `lineIndex`）；④ 确定性（同输入两次结果全等）。
 */

import { describe, expect, it } from 'vitest';
import { planTemperaLayout, resolveTemperaLayoutRegion, type TemperaPlanWord } from './temperaLayoutPlan';

const measure = (char: string, fontPx: number): number => (char.trim().length > 0 ? fontPx * 0.9 : 0);

const word = (over: Partial<TemperaPlanWord> = {}): TemperaPlanWord => ({
  lineIndex: 0,
  glyphs: ['甲', '乙'],
  isWordLike: true,
  spacedBefore: false,
  ...over,
});

const options = () => ({
  seed: 5,
  region: { centerX: 500, centerY: 300, width: 600, height: 300, align: 'center' as const },
  baseFontSize: 48,
  fontScale: 1,
  lines: [
    [
      word({ glyphs: ['主', '角', '词'] }),
      word({ glyphs: ['其', '余'], spacedBefore: true, segmentIndex: 1 }),
    ],
    [word({ lineIndex: 1, glyphs: ['二', '行'] })],
  ],
  measure,
  enter: [0.35, -0.45] as const,
});

describe('凝彩排版计划（端到端，假测量）', () => {
  it('字形一个不少、拟合在 4 轮内、行号带得出来、结果确定', () => {
    const plan = planTemperaLayout(options());
    // 3 + 2 + 2 = 7 个字形。
    expect(plan.placements).toHaveLength(7);
    expect(plan.fontSize).toBeGreaterThan(0);
    expect(plan.attempts).toBeLessThanOrEqual(4);
    // 两行歌词 ⇒ 两种 lineIndex。
    expect(new Set(plan.placements.map((item) => item.lineIndex)).size).toBe(2);
    // 坐标有限、入场缩放落在区间内。
    plan.placements.forEach((item) => {
      expect(Number.isFinite(item.x)).toBe(true);
      expect(Number.isFinite(item.y)).toBe(true);
      expect(item.enterScale).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(item.enterScale).toBeLessThanOrEqual(0.9 + 1e-9);
    });
    // 确定性。
    const again = planTemperaLayout(options());
    expect(again.fontSize).toBeCloseTo(plan.fontSize, 12);
    expect(again.placements).toEqual(plan.placements);
  });

  it('构图 profile → 排版区域与入场基准（照抄 resolveRegion / resolveEnterVector）', () => {
    const profile = {
      region: { cx: 0.5, cy: 0.4, w: 0.8, h: 0.3, align: 'center' as const, rotation: 0.03, fontScale: 0.9 },
      enter: [0.35, -0.45] as const,
    };
    const resolved = resolveTemperaLayoutRegion({ profile, width: 1000, height: 800, fontSize: 50 });
    // 区域按画布比例换算。
    expect(resolved.region.centerX).toBeCloseTo(500, 6);
    expect(resolved.region.centerY).toBeCloseTo(320, 6);
    expect(resolved.region.width).toBeCloseTo(800, 6);
    expect(resolved.region.height).toBeCloseTo(240, 6);
    expect(resolved.region.fontScale).toBeCloseTo(0.9, 6);
    // 入场以**字号**为单位：0.35 × 50 = 17.5、(0.45 × 50) = 22.5 ⇒ 角度与距离可对。
    expect(resolved.baseMagnitude).toBeCloseTo(Math.hypot(17.5, -22.5), 6);
    expect(resolved.baseAngle).toBeCloseTo(Math.atan2(-22.5, 17.5), 6);
    // 距离确实随字号走（不是画布）。
    const bigger = resolveTemperaLayoutRegion({ profile, width: 1000, height: 800, fontSize: 100 });
    expect(bigger.baseMagnitude).toBeCloseTo(resolved.baseMagnitude * 2, 6);
  });

  it('逐词字号真的贯穿到落点：主角词的字号约为其余词的 1.5 倍以上', () => {
    /*
     * 这条把第 162/163 轮"看图看不出大小差"的疑点**变成可执行断言**：
     * 只要一句里有"长词 + 短词"，长词（主角档 1.34~1.60）与短词（其余档 0.70~0.86）
     * 的字号比必然 ≥ 1.34 / 0.86 ≈ 1.56 —— 与插图无关，只与分词结果有关。
     */
    const plan = planTemperaLayout({
      ...options(),
      lines: [
        [
          word({ glyphs: ['あ', 'い', 'う', 'え', 'お'] }),
          word({ glyphs: ['い', 'え'], spacedBefore: true, segmentIndex: 1 }),
        ],
      ],
    });
    const hero = plan.placements.filter((item) => item.segmentIndex === 0);
    const rest = plan.placements.filter((item) => item.segmentIndex === 1);
    expect(hero).toHaveLength(5);
    expect(rest).toHaveLength(2);
    expect((hero[0]?.fontSize ?? 0) / (rest[0]?.fontSize ?? 1)).toBeGreaterThan(1.5);
    // 同一个词内字号一致（"一个词一种字号"）。
    expect(new Set(hero.map((item) => item.fontSize)).size).toBe(1);
    expect(new Set(rest.map((item) => item.fontSize)).size).toBe(1);
  });

  it('空白字素不会被产出（即使被喂进来）', () => {
    const plan = planTemperaLayout({
      ...options(),
      lines: [[word({ glyphs: ['甲', ' ', '乙'] })]],
    });
    expect(plan.placements.map((item) => item.char)).toEqual(['甲', '乙']);
  });

  it('区域很小 ⇒ 字号被缩下去（拟合真的在起作用）', () => {
    const wide = planTemperaLayout(options());
    const tiny = planTemperaLayout({
      ...options(),
      region: { centerX: 100, centerY: 100, width: 120, height: 60, align: 'center' as const },
    });
    expect(tiny.fontSize).toBeLessThan(wide.fontSize);
  });
});
