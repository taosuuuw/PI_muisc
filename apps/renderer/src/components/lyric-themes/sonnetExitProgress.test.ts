/**
 * 逐字运动的**帧层时间契约**（文件名是历史包袱：它原先测的是已删除的"退场曲线"）。
 *
 * 1. `waiting`（`time < startTime`）的字 α = 0；`startTime` 那一刻 α = 0.16、scale = 0.86；
 * 2. **落位之后到镜头末尾**，每个字的 `deltaX/deltaY/alpha/scale/halo/rotation` 一个都不再变
 *    （文字稳定连贯；画面上的持续运动交给镜头）；
 * 3. 同一时刻**跳出再跳回**逐字段一致（seek 可重放）。
 */

import { describe, expect, it } from 'vitest';
import { compileSonnetProgram } from './sonnetProgram';
import {
  buildSonnetFrame,
  resolveSonnetGlyphMotionDuration,
  type SonnetFrame,
} from './sonnetFrame';
import type { StageLine, StageWord } from './types';

const VIEWPORT = { width: 1180, height: 760 };

function makeLine(index: number, text: string, startMs: number, perWord = 500): StageLine {
  const chars = [...text];
  const words: StageWord[] = chars.map((char, position) => ({
    text: char,
    startMs: startMs + position * perWord,
    endMs: startMs + (position + 1) * perWord,
  }));
  return {
    index,
    timeMs: startMs,
    text,
    durationMs: chars.length * perWord,
    hint: 'normal',
    words,
    starts: words.map((word) => word.startMs),
    ends: words.map((word) => word.endMs),
  };
}

const TEXT = '甲乙丙丁';
const PROGRAM = compileSonnetProgram([makeLine(0, TEXT, 1000, 500)], {
  seed: 'glyph-time-contract',
});
const SHOT = PROGRAM.paragraphs[0]?.shots[0];

/*
 * 逐字时间轴**相对镜头起点**给（而不是写死绝对秒数）：这样"第一个字在镜头开始后才唱"
 * "最后一个字落位时镜头还没结束"两件事都由构造保证，换夹具也不会因为镜头区间变了而假红。
 */
const SHOT_START = SHOT?.startTime ?? 1;
const FIRST_GLYPH_START = SHOT_START + 0.1;
const GLYPH_STEP = 0.3;

/** 每个字**开始唱**的绝对时间。 */
const GLYPH_START = [...TEXT].map((char, index) => ({
  char,
  startTime: FIRST_GLYPH_START + index * GLYPH_STEP,
}));

const input = (timeSec: number): Parameters<typeof buildSonnetFrame>[0] => ({
  program: PROGRAM,
  timeSec,
  viewport: VIEWPORT,
  inkColor: '#fff',
  emphasisColor: '#f00',
  glyphsByLine: new Map([[
    0,
    GLYPH_START.map(({ char, startTime }) => ({
      char,
      startTime,
      endTime: startTime + GLYPH_STEP,
    })),
  ]]),
});

/** 这一镜里"最后一个字落位"的绝对时间 —— 所有字都不再变的起点。 */
const settleAll = (): number => {
  if (SHOT === undefined) throw new Error('这一镜没编译出来');
  const motionDuration = resolveSonnetGlyphMotionDuration({
    startTime: SHOT.startTime,
    endTime: SHOT.endTime,
  });
  return Math.max(...GLYPH_START.map((glyph) => glyph.startTime)) + motionDuration;
};

const bodyOf = (frame: SonnetFrame) => frame.glyphs.filter((glyph) => !glyph.ghost);
const byChar = (frame: SonnetFrame, char: string) =>
  bodyOf(frame).filter((glyph) => glyph.char === char);

describe('逐字入场的时间契约（退场已按上游移除）', () => {
  it('没轮到的字 α = 0；轮到的第一个字从 0.16 / 0.86 起手', () => {
    const waitingFrame = buildSonnetFrame(input(SHOT_START + 0.05));
    expect(bodyOf(waitingFrame).length).toBeGreaterThan(0);
    // 全部字都还没开始唱 ⇒ 一个都不亮。
    for (const glyph of bodyOf(waitingFrame)) {
      expect(glyph.alpha, `${glyph.char} 不该亮`).toBe(0);
      expect(glyph.scale).toBeCloseTo(0.86, 9);
    }
    // 第一个字刚开始那一刻：α = 0.16、scale = 0.86；后面的字仍然 α = 0。
    const startedFrame = buildSonnetFrame(input(FIRST_GLYPH_START));
    const first = byChar(startedFrame, '甲');
    expect(first.length).toBeGreaterThan(0);
    for (const glyph of first) {
      expect(glyph.alpha).toBeCloseTo(0.16, 6);
      expect(glyph.scale).toBeCloseTo(0.86, 6);
    }
    for (const char of ['乙', '丙', '丁']) {
      for (const glyph of byChar(startedFrame, char)) {
        expect(glyph.alpha, `${char} 还不该亮`).toBe(0);
      }
    }
  });

  it('**落位之后到镜头末尾**：deltaX/deltaY/alpha/scale/rotation 逐值不变', () => {
    if (SHOT === undefined) return;
    const settled = buildSonnetFrame(input(settleAll()));
    expect(bodyOf(settled).length).toBeGreaterThan(0);
    for (const glyph of bodyOf(settled)) {
      expect(glyph.alpha, `${glyph.char} 落位后该是全亮`).toBeCloseTo(1, 9);
      expect(glyph.scale, `${glyph.char} 落位后该是本来大小`).toBeCloseTo(1, 9);
      /* 位移可能是 `-0`（`(1−1) × 负数`）⇒ 用绝对值断言。 */
      expect(Math.abs(glyph.deltaX)).toBe(0);
      expect(Math.abs(glyph.deltaY)).toBe(0);
    }
    /*
     * 从"全部落位"到镜头末尾再量两次：字形数组必须**逐字段完全一致**。
     * 这条正是"没有退场"的判据 —— 有退场时 delta 会重新变大、alpha 会掉。
     */
    const snapshot = (frame: SonnetFrame): unknown[][] =>
      bodyOf(frame).map((glyph) => [
        glyph.char,
        glyph.x,
        glyph.y,
        glyph.deltaX,
        glyph.deltaY,
        glyph.alpha,
        glyph.scale,
        glyph.haloAlpha,
        glyph.haloScale,
        glyph.rotation,
        glyph.fontPx,
      ]);
    const nearEnd = SHOT.endTime - 0.01;
    const samples = [settleAll(), (settleAll() + nearEnd) / 2, nearEnd];
    const expected = snapshot(settled);
    for (const time of samples) {
      expect(snapshot(buildSonnetFrame(input(time))), `t=${time.toFixed(2)} 时字变了`).toEqual(
        expected,
      );
    }
  });

  it('seek 可重放：同一时刻"跳出去再跳回来"逐字段一致', () => {
    const time = settleAll() - 0.05;
    const first = buildSonnetFrame(input(time));
    buildSonnetFrame(input(time + 2));
    buildSonnetFrame(input(time - 0.3));
    expect(buildSonnetFrame(input(time))).toEqual(first);
  });
});
