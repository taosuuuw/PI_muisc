/**
 * 海报方块排版（`poster-blocks`）的**契约自查**。
 *
 * 这四条断言是**主人提供的上游单测**（`test/unit/visualizer/sonnetPosterBlocksLayout.test.ts`）的移植 ——
 * 上游实现文件的源码我们只拿到头尾，但这份测试把对外契约钉死了，所以先拿它当验收标准：
 *   ①陪衬能绕到主角**右侧**（左边缘 ≥ 主角右边缘、竖向与主角重叠）；
 *   ②陪衬按阅读顺序**顶边不回折**（`y − h/2` 单调不减）；
 *   ③**任意两块不重叠**（连 1 主角 + 1 次主角 + 28 块陪衬的稠密用例也要满足）；
 *   ④**同种子确定、换种子构图变**。
 *
 * 注意：我们这一版的分区流算法是**自己写的**（按流单元逐行排），不是上游那段
 * `attemptFlowLayout` 的逐字移植 —— 差异已登记在 `docs/PLAN.md` 第 81 轮。
 */

import { describe, expect, it } from 'vitest';
import { layoutSonnetPosterBlocks, type SonnetPosterBlockBox } from './sonnetPosterBlocksLayout';

const box = (
  measuredWidth: number,
  measuredHeight: number,
  role: 'hero' | 'semi-hero' | 'support',
): SonnetPosterBlockBox => ({
  isHero: role === 'hero',
  isSemiHero: role === 'semi-hero',
  displayText: role,
  fontScale: role === 'hero' ? 4.4 : role === 'semi-hero' ? 3.1 : 1.15,
  measuredWidth,
  measuredHeight,
  x: 0,
  y: 0,
  rotation: 0,
  vertical: false,
  layoutDirection: 'horizontal',
  enterX: 0,
  enterY: 0,
});

const makeBoxes = (): SonnetPosterBlockBox[] => [
  box(128, 42, 'support'),
  box(184, 68, 'semi-hero'),
  box(360, 142, 'hero'),
  box(116, 40, 'support'),
  box(152, 40, 'support'),
  box(208, 66, 'semi-hero'),
  box(104, 40, 'support'),
];

/** 两块在 x 或 y 上分离（上游用例里的同一条判据）。 */
const separated = (first: SonnetPosterBlockBox, second: SonnetPosterBlockBox): boolean =>
  first.x + first.measuredWidth / 2 <= second.x - second.measuredWidth / 2 ||
  second.x + second.measuredWidth / 2 <= first.x - first.measuredWidth / 2 ||
  first.y + first.measuredHeight / 2 <= second.y - second.measuredHeight / 2 ||
  second.y + second.measuredHeight / 2 <= first.y - first.measuredHeight / 2;

describe('商籁海报方块排版（契约）', () => {
  it('陪衬绕到主角右侧折行；陪衬顶边不回折；任意两块不重叠', () => {
    const boxes = makeBoxes();
    const plan = layoutSonnetPosterBlocks(boxes, 1280, 720, 40, 28);
    const hero = boxes.find((item) => item.isHero) as SonnetPosterBlockBox;
    const supports = boxes.filter((item) => !item.isHero && !item.isSemiHero);
    const heroRight = hero.x + hero.measuredWidth / 2;
    const heroTop = hero.y - hero.measuredHeight / 2;
    const heroBottom = hero.y + hero.measuredHeight / 2;

    expect(
      supports.some(
        (item) =>
          item.x - item.measuredWidth / 2 >= heroRight &&
          item.y + item.measuredHeight / 2 > heroTop &&
          item.y - item.measuredHeight / 2 < heroBottom,
      ),
    ).toBe(true);
    supports.slice(1).forEach((item, index) => {
      const previous = supports[index] as SonnetPosterBlockBox;
      expect(item.y - item.measuredHeight / 2).toBeGreaterThanOrEqual(
        previous.y - previous.measuredHeight / 2 - 0.001,
      );
    });
    for (let firstIndex = 0; firstIndex < boxes.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < boxes.length; secondIndex += 1) {
        const first = boxes[firstIndex] as SonnetPosterBlockBox;
        const second = boxes[secondIndex] as SonnetPosterBlockBox;
        expect(separated(first, second), `第 ${firstIndex} 与 ${secondIndex} 块叠在一起`).toBe(true);
      }
    }
    expect(plan.placements).toEqual(boxes);
  });

  it('同种子结果一致；换种子构图要变', () => {
    const first = layoutSonnetPosterBlocks(makeBoxes(), 1280, 720, 40, 12);
    const repeated = layoutSonnetPosterBlocks(makeBoxes(), 1280, 720, 40, 12);
    const alternate = layoutSonnetPosterBlocks(makeBoxes(), 1280, 720, 40, 13);

    expect(first.placements.map((item) => [item.x, item.y, item.fontScale])).toEqual(
      repeated.placements.map((item) => [item.x, item.y, item.fontScale]),
    );
    expect(alternate.placements.map((item) => item.x)).not.toEqual(first.placements.map((item) => item.x));
  });

  it('稠密歌词组也不会跑出有限值之外、且互不重叠', () => {
    const boxes = [
      box(420, 150, 'hero'),
      box(230, 76, 'semi-hero'),
      ...Array.from({ length: 28 }, (_, index) => box(72 + (index % 5) * 18, 38, 'support')),
    ];
    layoutSonnetPosterBlocks(boxes, 1280, 720, 32, 98);

    expect(boxes.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true);
    for (let firstIndex = 0; firstIndex < boxes.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < boxes.length; secondIndex += 1) {
        const first = boxes[firstIndex] as SonnetPosterBlockBox;
        const second = boxes[secondIndex] as SonnetPosterBlockBox;
        expect(separated(first, second), `第 ${firstIndex} 与 ${secondIndex} 块叠在一起`).toBe(true);
      }
    }
  });
});
