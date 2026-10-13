/**
 * 商籁**阅读窗口**的用例（本轮取景语义纠正的那一层）。
 *
 * 这里守的是主人点名的新目标：
 * ① **当前可读词组 + 左右各一个近邻块**（既不是只剩 1~2 字，也不是一屏塞几句）；
 * ② 长多行 / 密唱**只取局部**（窗口字数远小于整镜字数）；
 * ③ 旧行与远未来**进不了窗口**（时间门 + 空间半径）；
 * ④ 空间上分散的块**撑不爆窗口**（软跨度上限）；
 * ⑤ 窗口随时间是**连续**的（密采样无台阶、换块不跳）；
 * ⑥ seek 一致（纯函数）；日文 / 英文 / 小窗口都成立。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_EMPTY_READING_WINDOW,
  SONNET_READING_CONTEXT_BLOCKS,
  SONNET_READING_MAX_SPAN_X,
  SONNET_READING_MAX_SPAN_Y,
  resolveSonnetReadingWindow,
  type SonnetReadingBlock,
} from './sonnetReadingWindow';

const VIEWPORT = { viewportWidth: 1000, viewportHeight: 600 } as const;

/**
 * 一个"词块"：默认 2 字、横排 200px 宽（中心 ±100）、高 60px（中心 ±30）。
 * 只给 `startTime/endTime` 与 `centerX` 就能摆出一个词。
 */
function word(
  overrides: Partial<SonnetReadingBlock> & Pick<SonnetReadingBlock, 'startTime' | 'endTime'>,
): SonnetReadingBlock {
  const centerX = overrides.centerX ?? 0;
  const centerY = overrides.centerY ?? 300;
  const charCount = overrides.charCount ?? 2;
  return {
    text: overrides.text ?? '甲乙',
    lineIndex: overrides.lineIndex ?? 0,
    isWordLike: overrides.isWordLike ?? true,
    charCount,
    centerX,
    centerY,
    minX: centerX - 100,
    maxX: centerX + 100,
    minY: centerY - 30,
    maxY: centerY + 30,
    ...overrides,
  };
}

/** 三个词、每词 0.8 秒、间隔 1.2 秒、落点相距 300px 的一行。 */
const LINE: readonly SonnetReadingBlock[] = [
  word({ startTime: 0, endTime: 0.8, centerX: 100, text: '甲乙' }),
  word({ startTime: 2, endTime: 2.8, centerX: 400, text: '丙丁' }),
  word({ startTime: 4, endTime: 4.8, centerX: 700, text: '戊己' }),
];

/** 12 个词、每词 0.5 秒（密唱）、落点相距 150px 的长句。 */
const DENSE_LINE: readonly SonnetReadingBlock[] = Array.from({ length: 12 }, (_unused, index) =>
  word({
    startTime: index * 0.5,
    endTime: index * 0.5 + 0.45,
    centerX: 100 + index * 150,
    text: `词${index}`,
    charCount: 2,
  }),
);

describe('商籁阅读窗口：当前词组 + 左右近邻', () => {
  it('当前块 + 左右各一块：3 块 6 字，且当前块的完整落位一定在窗口里', () => {
    const window = resolveSonnetReadingWindow(LINE, 2.4, VIEWPORT);
    expect(window.activeIndex).toBe(1);
    expect(window.memberIndices).toEqual([0, 1, 2]);
    expect(window.blockCount).toBe(3);
    expect(window.wordCount).toBe(3);
    expect(window.charCount).toBe(6);
    /* 当前块（300..500 / 270..330）完整落在窗口里 ⇒ 永远不会"只剩一两字" */
    expect(window.minX).toBeLessThanOrEqual(300);
    expect(window.maxX).toBeGreaterThanOrEqual(500);
    expect(window.minY).toBeLessThanOrEqual(270);
    expect(window.maxY).toBeGreaterThanOrEqual(330);
    /* 邻块也真的参与进来：窗口比当前块（200 宽）宽，但不覆盖整行（800 宽） */
    expect(window.maxX - window.minX).toBeGreaterThan(200);
    expect(window.maxX - window.minX).toBeLessThan(800);
  });

  it('无论唱到哪一块，当前块都是窗口成员', () => {
    for (const time of [-0.5, 0, 0.4, 1.4, 2.0, 2.4, 3.6, 4.4, 6]) {
      const window = resolveSonnetReadingWindow(LINE, time, VIEWPORT);
      expect(window.activeIndex, `t=${time}`).toBeGreaterThanOrEqual(0);
      expect(window.memberIndices, `t=${time}`).toContain(window.activeIndex);
      expect(window.charCount, `t=${time}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('时间范围取真实 cue（不是整段等比例推进）', () => {
    const window = resolveSonnetReadingWindow(LINE, 2.4, VIEWPORT);
    expect(window.startTime).toBeCloseTo(0, 9);
    expect(window.endTime).toBeCloseTo(4.8, 9);
    const single = resolveSonnetReadingWindow([LINE[1] as SonnetReadingBlock], 2.4, VIEWPORT);
    expect(single.startTime).toBeCloseTo(2, 9);
    expect(single.endTime).toBeCloseTo(2.8, 9);
  });
});

describe('商籁阅读窗口：长句 / 密唱只取局部', () => {
  it('12 个词的长句：窗口最多 3 块 6 字（不是整句 24 字、也不是十几个词）', () => {
    const totalChars = DENSE_LINE.reduce((sum, block) => sum + block.charCount, 0);
    expect(totalChars).toBe(24);
    const window = resolveSonnetReadingWindow(DENSE_LINE, 3.2, VIEWPORT);
    expect(window.blockCount).toBeLessThanOrEqual(SONNET_READING_CONTEXT_BLOCKS);
    expect(window.charCount).toBeLessThanOrEqual(6);
    /* 窗口宽度远小于整行（整行从 0 到 1850），也远小于视口宽 */
    expect(window.maxX - window.minX).toBeLessThan(0.45 * VIEWPORT.viewportWidth);
    /* 当前那一块仍然完整可读 */
    const active = DENSE_LINE[window.activeIndex];
    expect(active).toBeDefined();
    expect(window.minX).toBeLessThanOrEqual((active as SonnetReadingBlock).minX);
    expect(window.maxX).toBeGreaterThanOrEqual((active as SonnetReadingBlock).maxX);
  });

  it('单位时间内块越多，窗口覆盖的**时间范围**越短（窗口跟着唱词密度收放）', () => {
    const sparse = resolveSonnetReadingWindow(LINE, 2.4, VIEWPORT);
    const denseWindow = resolveSonnetReadingWindow(DENSE_LINE, 3.2, VIEWPORT);
    const sparseSpan = sparse.endTime - sparse.startTime;
    const denseSpan = denseWindow.endTime - denseWindow.startTime;
    expect(denseSpan).toBeLessThan(sparseSpan);
  });
});

describe('商籁阅读窗口：旧行与远未来不进窗口', () => {
  it('远未来 / 旧行（时间上很远）的块权重趋零 ⇒ 窗口读数与"没有它们"时一致', () => {
    const base = resolveSonnetReadingWindow(LINE, 2.4, VIEWPORT);
    const decoys: readonly SonnetReadingBlock[] = [
      word({ startTime: -25, endTime: -24.2, centerX: 100, text: '旧行', lineIndex: 0 }),
      word({ startTime: 30, endTime: 30.8, centerX: 400, text: '未来', lineIndex: 1 }),
    ];
    const withDecoys = resolveSonnetReadingWindow([...LINE, ...decoys], 2.4, VIEWPORT);
    /* 诱饵块排在最后 ⇒ 真实三块的**下标不变**，读数可以逐项对比。 */
    expect(withDecoys.memberIndices).toEqual(base.memberIndices);
    expect(withDecoys.activeIndex).toBe(base.activeIndex);
    expect(withDecoys.charCount).toBe(base.charCount);
    expect(withDecoys.centerX).toBeCloseTo(base.centerX, 6);
    expect(withDecoys.minX).toBeCloseTo(base.minX, 6);
    expect(withDecoys.maxX).toBeCloseTo(base.maxX, 6);
  });

  it('上一行、空间上偏远的块被压成非成员（兼顾空间位置）', () => {
    const base = resolveSonnetReadingWindow(LINE, 2.4, VIEWPORT);
    const oldLine = word({
      startTime: 0.5,
      endTime: 1,
      centerX: 1300,
      centerY: 300,
      text: '旧行',
      lineIndex: 9,
    });
    const withOldLine = resolveSonnetReadingWindow([...LINE, oldLine], 2.4, VIEWPORT);
    expect(withOldLine.memberIndices).not.toContain(3);
    expect(withOldLine.memberIndices).toContain(1);
    /* 窗口没有被这一块拉过去，也没有被撑大 */
    expect(withOldLine.centerX).toBeLessThan(base.centerX + 60);
    expect(withOldLine.maxX - withOldLine.minX).toBeLessThan(0.6 * VIEWPORT.viewportWidth);
  });
});

describe('商籁阅读窗口：软跨度上限（远块不撑爆窗口）', () => {
  it('窗口宽 / 高永远不会超过视口比例上限', () => {
    const scattered: readonly SonnetReadingBlock[] = [
      word({ startTime: 2, endTime: 2.8, centerX: 100, centerY: 300 }),
      word({ startTime: 2, endTime: 2.8, centerX: 5000, centerY: 300 }),
      word({ startTime: 2, endTime: 2.8, centerX: -4000, centerY: -3000 }),
    ];
    const window = resolveSonnetReadingWindow(scattered, 2.4, VIEWPORT);
    expect(window.maxX - window.minX).toBeLessThanOrEqual(SONNET_READING_MAX_SPAN_X * VIEWPORT.viewportWidth + 1e-6);
    expect(window.maxY - window.minY).toBeLessThanOrEqual(SONNET_READING_MAX_SPAN_Y * VIEWPORT.viewportHeight + 1e-6);
  });
});

describe('商籁阅读窗口：窗口切换连续（无硬切台阶）', () => {
  const windowAt = (time: number) => resolveSonnetReadingWindow(DENSE_LINE, time, VIEWPORT);

  it('密采样下窗口中心 / 尺寸都没有跳变，且确实经历了换块', () => {
    const dt = 1 / 240;
    const actives = new Set<number>();
    let previous: { readonly cx: number; readonly cy: number; readonly halfW: number; readonly halfH: number } | null =
      null;
    let worstStep = 0;
    for (let step = 0; step * dt <= 6; step += 1) {
      const window = windowAt(step * dt);
      actives.add(window.activeIndex);
      const current = {
        cx: window.centerX,
        cy: window.centerY,
        halfW: (window.maxX - window.minX) / 2,
        halfH: (window.maxY - window.minY) / 2,
      };
      if (previous !== null) {
        worstStep = Math.max(
          worstStep,
          Math.abs(current.cx - previous.cx),
          Math.abs(current.cy - previous.cy),
          Math.abs(current.halfW - previous.halfW),
          Math.abs(current.halfH - previous.halfH),
        );
      }
      previous = current;
    }
    /*
     * 每个 1/240s 步长里窗口中心 / 半宽变化都要小。判据取 DENSE_LINE 的块间距（150px）的一小部分：
     * 真正的"硬切"会一步跳 150px 以上，这里只允许十几 px（≈ 眼看不到跳变）。
     */
    expect(worstStep).toBeLessThan(40);
    /* 这段扫描里必须真的换过块，否则这条"连续"就没测到切换点 */
    expect(actives.size).toBeGreaterThan(2);
  });

  it('加密采样不给窗口中心制造"跳变"（硬切会按 1/dt 长大；折点只会停在有限加速度）', () => {
    const scan = (dt: number): { readonly worstStep: number; readonly worstAccel: number } => {
      const centers: number[] = [];
      for (let step = 0; step * dt <= 6 + 1e-9; step += 1) centers.push(windowAt(step * dt).centerX);
      let worstStep = 0;
      let worstAccel = 0;
      for (let index = 1; index < centers.length; index += 1) {
        const speed = ((centers[index] ?? 0) - (centers[index - 1] ?? 0)) / dt;
        worstStep = Math.max(worstStep, Math.abs((centers[index] ?? 0) - (centers[index - 1] ?? 0)));
        if (index >= 2) {
          const previousSpeed = ((centers[index - 1] ?? 0) - (centers[index - 2] ?? 0)) / dt;
          worstAccel = Math.max(worstAccel, Math.abs(speed - previousSpeed) / dt);
        }
      }
      return { worstStep, worstAccel };
    };
    const coarse = scan(1 / 60);
    const middle = scan(1 / 240);
    const fine = scan(1 / 600);
    /* 步长必须随采样变密而变小（硬切会保持"一整跳"不变） */
    expect(fine.worstStep).toBeLessThan(coarse.worstStep);
    /* 加速度不许按 1/dt 长大（跳变会 ×~10；折点只停在有限值 ⇒ 远小于 3 倍） */
    expect(fine.worstAccel).toBeLessThan(middle.worstAccel * 3 + 1e-6);
  });
});

describe('商籁阅读窗口：seek 一致与边界输入', () => {
  it('同一时刻、同一输入 ⇒ 逐值相同（纯函数、无状态）', () => {
    expect(resolveSonnetReadingWindow(LINE, 2.4, VIEWPORT)).toEqual(
      resolveSonnetReadingWindow(LINE, 2.4, VIEWPORT),
    );
    expect(resolveSonnetReadingWindow(DENSE_LINE, 3.2, VIEWPORT)).toEqual(
      resolveSonnetReadingWindow(DENSE_LINE, 3.2, VIEWPORT),
    );
  });

  it('空输入 / 全是无效块 ⇒ 空窗口（渲染层据此不施加取景）', () => {
    expect(resolveSonnetReadingWindow([], 1, VIEWPORT)).toEqual(SONNET_EMPTY_READING_WINDOW);
    expect(
      resolveSonnetReadingWindow([word({ startTime: 1, endTime: 2, charCount: 0 })], 1.5, VIEWPORT),
    ).toEqual(SONNET_EMPTY_READING_WINDOW);
    expect(SONNET_EMPTY_READING_WINDOW.activeIndex).toBe(-1);
  });
});

describe('商籁阅读窗口：日文 / 英文 / 小窗口', () => {
  it('日文（2 字词、0.6 秒一个）：窗口仍是当前词 + 左右各一', () => {
    const japanese: readonly SonnetReadingBlock[] = Array.from({ length: 8 }, (_unused, index) =>
      word({
        startTime: index * 0.6,
        endTime: index * 0.6 + 0.55,
        centerX: 200 + index * 180,
        text: ['言葉', 'ふれ', 'また', 'きみ', 'そら', 'うた', 'ゆめ', 'ひかり'][index] ?? '言葉',
        charCount: 2,
      }),
    );
    const window = resolveSonnetReadingWindow(japanese, 2.1, VIEWPORT);
    expect(window.blockCount).toBeLessThanOrEqual(SONNET_READING_CONTEXT_BLOCKS);
    expect(window.charCount).toBeLessThanOrEqual(6);
    expect(window.memberIndices).toContain(window.activeIndex);
  });

  it('英文（长单词、字多）：窗口用"块数"限流，不让一屏塞满', () => {
    const english: readonly SonnetReadingBlock[] = Array.from({ length: 10 }, (_unused, index) =>
      word({
        startTime: index * 0.4,
        endTime: index * 0.4 + 0.38,
        centerX: 120 + index * 170,
        text: ['hello', 'world', 'again', 'tonight', 'stay', 'here'][index % 6] ?? 'hello',
        charCount: 5,
      }),
    );
    const window = resolveSonnetReadingWindow(english, 1.8, VIEWPORT);
    expect(window.blockCount).toBeLessThanOrEqual(SONNET_READING_CONTEXT_BLOCKS);
    expect(window.charCount).toBeLessThanOrEqual(SONNET_READING_CONTEXT_BLOCKS * 5);  });

  it('竖排（同列上下堆叠）：窗口高度受限、当前块仍完整在内', () => {
    const vertical: readonly SonnetReadingBlock[] = [
      word({ startTime: 0, endTime: 0.5, centerX: 300, centerY: 100, text: '言' }),
      word({ startTime: 0.6, endTime: 1.1, centerX: 300, centerY: 350, text: '葉' }),
      word({ startTime: 1.2, endTime: 1.7, centerX: 300, centerY: 600, text: 'ふ' }),
      word({ startTime: 1.8, endTime: 2.3, centerX: 300, centerY: 850, text: 'れ' }),
    ];
    const window = resolveSonnetReadingWindow(vertical, 1.25, VIEWPORT);
    expect(window.activeIndex).toBe(2);
    expect(window.minY).toBeLessThanOrEqual(570);
    expect(window.maxY).toBeGreaterThanOrEqual(630);
    expect(window.maxY - window.minY).toBeLessThanOrEqual(
      SONNET_READING_MAX_SPAN_Y * VIEWPORT.viewportHeight + 1e-6,
    );
  });

  it('极小视口：跨度上限按小视口收缩（不会算出比画面还大的窗口）', () => {
    const small = { viewportWidth: 320, viewportHeight: 200 } as const;
    const window = resolveSonnetReadingWindow(DENSE_LINE, 3.2, small);
    expect(window.maxX - window.minX).toBeLessThanOrEqual(
      SONNET_READING_MAX_SPAN_X * small.viewportWidth + 1e-6,
    );
    expect(window.maxY - window.minY).toBeLessThanOrEqual(
      SONNET_READING_MAX_SPAN_Y * small.viewportHeight + 1e-6,
    );
    expect(window.blockCount).toBeGreaterThan(0);
  });
});
