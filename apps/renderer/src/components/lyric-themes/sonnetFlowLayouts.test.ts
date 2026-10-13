/**
 * 商籁（sonnet）**排版打包**的自查。
 *
 * 这一层是纯函数：给一组量好的字块，算出它们摆在哪。这里的用例盯的是**照抄 folia 的那几条几何关系**
 * （社论栏五档各自的锚点、栏序、眉题/绕柱规则），而不是逐像素的坐标 —— 原版的盒子尺寸来自
 * `@chenglou/pretext` 真实测量，我们用的是估算，硬钉坐标只会在补测量时到处改红。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_SAFE_HALF_H_RATIO,
  SONNET_SAFE_HALF_W_RATIO,
  layoutEditorialColumn,
  resolveSonnetFlowGaps,
  type SonnetFlowBox,
  type SonnetFlowContext,
} from './sonnetFlowLayouts';

const WIDTH = 1180;
const HEIGHT = 760;
const BASE = 60;

function makeBoxes(scales: readonly number[], heroIndex: number): SonnetFlowBox[] {
  return scales.map((scale, index) => ({
    index,
    isHero: index === heroIndex,
    isSemiHero: false,
    fontScale: scale,
    measuredWidth: BASE * scale * 2.4,
    measuredHeight: BASE * scale * 1.2,
    // 竖排尺寸：用例里按"逐字成列"造（宽 = 一个字，高 = 三个字的步进）。
    verticalMeasuredWidth: BASE * scale,
    verticalMeasuredHeight: BASE * scale * 0.9 * 3,
    verticalFontScale: scale,
    vertical: false,
    layoutDirection: 'horizontal',
    rotation: 0,
    x: 0,
    y: 0,
    enterX: 0,
    enterY: 0,
  }));
}

function makeContext(boxes: SonnetFlowBox[], heroIndex: number): SonnetFlowContext {
  const { flowGap, stackGap } = resolveSonnetFlowGaps(BASE);
  return { boxes, heroIndex, width: WIDTH, height: HEIGHT, flowGap, stackGap };
}

/** 主角 4.0、两个陪衬 1.2：三块，够跑完五档。 */
const run = (variant: number, secondaryHeroIndex = -1): SonnetFlowBox[] => {
  const boxes = makeBoxes([1.2, 4, 1.2], 1);
  layoutEditorialColumn(makeContext(boxes, 1), variant, secondaryHeroIndex);
  return boxes;
};

describe('商籁 社论栏五档（照抄 folia 的 layoutEditorialColumn）', () => {
  it('第 0 档 竖排双栏：主角柱在左 15%，**早词在它右边、晚词在它左边**', () => {
    const boxes = run(0);
    const hero = boxes[1];
    expect(hero?.x).toBeCloseTo(-WIDTH * 0.15, 6);
    expect(boxes[0]?.x ?? 0).toBeGreaterThan(hero?.x ?? 0);
    expect(boxes[2]?.x ?? 0).toBeLessThan(hero?.x ?? 0);
    // 竖排档：栏内方向是"竖着摞"。
    expect(boxes.every((box) => box.layoutDirection === 'vertical')).toBe(true);
  });

  it('第 1 档 右对齐杂志栏：所有块都落在右侧（x 上限 = 宽 × 0.28）', () => {
    const boxes = run(1);
    for (const box of boxes) {
      expect(box.x + box.measuredWidth / 2).toBeLessThanOrEqual(WIDTH * 0.28 + 0.5);
      expect(box.layoutDirection).toBe('vertical');
    }
  });

  it('第 2 档 杂志眉题：主角上移到 -25% 高度，早词成眉题**在它上方**、晚词成对排在**下方**', () => {
    const boxes = run(2);
    const hero = boxes[1];
    expect(hero?.y).toBeCloseTo(-HEIGHT * 0.25, 6);
    expect((boxes[0]?.y ?? 0) + (boxes[0]?.measuredHeight ?? 0) / 2).toBeLessThan(hero?.y ?? 0);
    expect((boxes[2]?.y ?? 0) - (boxes[2]?.measuredHeight ?? 0) / 2).toBeGreaterThan(hero?.y ?? 0);
    expect(boxes.every((box) => box.layoutDirection === 'horizontal')).toBe(true);
  });

  it('第 3 档 双主行：两块分属两条不同的行高（错开，不是挤在一行）', () => {
    const boxes = makeBoxes([1.2, 3.8, 2.6], 1);
    layoutEditorialColumn(makeContext(boxes, 1), 3, 2);
    const rows = new Set(boxes.map((box) => Math.round(box.y * 100) / 100));
    expect(rows.size).toBe(2);
    // 台阶错位：两条行各往相反方向挪了 12% 行宽，所以 x 的跨度比"单行居中"更宽。
    expect(Math.abs((boxes[1]?.x ?? 0) - (boxes[2]?.x ?? 0))).toBeGreaterThan(30);
  });

  it('第 4 档 Logo 徽章：主角竖柱贴一侧（左边缘压 -40% 宽），其余块绕它排、都落在安全区里', () => {
    const boxes = makeBoxes([1.25, 4.2, 1.25, 1.25], 1);
    layoutEditorialColumn(makeContext(boxes, 1), 4, -1);
    const hero = boxes[1];
    // 主角不在末位 ⇒ 柱子贴"流起点"那一侧：柱**左边缘**正好压在 -40% 宽处（照抄 folia）。
    expect((hero?.x ?? 0) - (hero?.measuredWidth ?? 0) / 2).toBeCloseTo(-WIDTH * 0.4, 6);
    expect(hero?.layoutDirection).toBe('vertical');
    for (const box of boxes) {
      if (box === hero) continue;
      expect(box.layoutDirection).toBe('horizontal');
      expect(Math.abs(box.x)).toBeLessThanOrEqual(WIDTH * SONNET_SAFE_HALF_W_RATIO + 0.5);
      expect(Math.abs(box.y)).toBeLessThanOrEqual(HEIGHT * SONNET_SAFE_HALF_H_RATIO + 0.5);
    }
  });

  it('五档都真的会动：同一组盒子在五档下的落点两两不同', () => {
    const fingerprints = [0, 1, 2, 3, 4].map((variant) =>
      run(variant, variant === 3 ? 2 : -1)
        .map((box) => `${box.x.toFixed(1)},${box.y.toFixed(1)}`)
        .join('|'),
    );
    expect(new Set(fingerprints).size).toBe(5);
  });
});
