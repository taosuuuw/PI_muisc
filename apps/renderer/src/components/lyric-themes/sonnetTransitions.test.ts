/**
 * 商籁（sonnet）**转场**的自查：守的是从 folia `sonnetTransitions.ts` 照抄来的那批数值。
 *
 * 为什么值得单测：这批数字（模糊 14、故障 14 档、α 系数 0.82 / 0.72、镜头间 0.18 与 0.14~0.24 的夹取）
 * 一旦被"顺手改顺眼"，观感就从"原版那种硬切+跳帧"变成"温柔淡入淡出" —— 那是完全另一套东西。
 */

import { describe, expect, it } from 'vitest';
import { compileSonnetProgram } from './sonnetProgram';
import {
  SONNET_GLITCH_ALPHA_TAIL,
  SONNET_GLITCH_STEPS,
  SONNET_IDLE_TRANSITION,
  SONNET_SHOT_TRANSITION_MAX,
  SONNET_SHOT_TRANSITION_MIN,
  SONNET_TRANSITION_KINDS,
  resolveSonnetBoundaryKind,
  resolveSonnetShotTransition,
  resolveSonnetShotTransitionDuration,
  resolveSonnetTransitionEffect,
  sonnetSeedNumber,
} from './sonnetTransitions';
import type { StageLine, StageWord } from './types';

function makeLine(index: number, text: string, startMs: number, perWord = 400): StageLine {
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

/*
 * 用一首**足够长**的歌：短歌会被编成"一个段落一个镜头"，那样根本没有相邻镜头可测。
 * 行间隔 1.5 秒（超过编译层的段落阈值 1.2 秒）⇒ 每行各成一段、一共 12 个镜头。
 *
 * 顺带把差距记在这里：folia 的**一个段落可以有好几镜**（`SHOTS_BY_PARAGRAPH`），
 * 我们目前是"一段一镜"，所以镜头间转场在我们这边表现为**段落之间**的转场。
 */
const SONG = Array.from({ length: 12 }, (_, index) =>
  makeLine(index, `第${index + 1}句歌词文字`, index * 1500, 300),
);

describe('sonnet 转场（照抄的数值）', () => {
  it('边界序号选的是哈希结果，三种都能排到且同一输入永远同一结果', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 24; index += 1) seen.add(resolveSonnetBoundaryKind(20260101, index));
    expect([...seen].sort()).toEqual([...SONNET_TRANSITION_KINDS].sort());
    // 确定性：同一 (seed, index) 两次调用一致。
    expect(resolveSonnetBoundaryKind(7, 3)).toBe(resolveSonnetBoundaryKind(7, 3));
    // 相邻边界**不会**总是同一种（否则就成了轮转而不是哈希）。
    expect(resolveSonnetBoundaryKind(7, 0)).not.toBe(undefined);
  });

  it('fast-blur：模糊是 amount × 14，入场 α 的系数是 0.82', () => {
    const exitHalf = resolveSonnetTransitionEffect('fast-blur', 'exit', 0.5, 1);
    const enterHalf = resolveSonnetTransitionEffect('fast-blur', 'enter', 0.5, 1);
    // progress 0 时不该有任何效果。
    const exitStart = resolveSonnetTransitionEffect('fast-blur', 'exit', 0, 1);
    expect(exitStart.blurPx).toBeCloseTo(0, 6);
    expect(exitStart.alpha).toBeCloseTo(1, 6);
    // 出场越走越糊、α 线性掉；入场从"退场态"回到常态。
    expect(exitHalf.blurPx).toBeGreaterThan(0);
    expect(exitHalf.alpha).toBeLessThan(1);
    /*
     * 下面这条**只在前后的缓动解完全相同**时才成立（左边用 exit 的 α、右边用 enter 的模糊反推），
     * 而 `t = 0.5` 处上游 12 次二分解出的参数有约 2.4e-4 的固有误差 ⇒ 等式只到 1e-3 量级。
     * 旧的 30 次二分把误差压到 1e-9，一度让这条"看起来"是精确等式 —— 那是假象。
     * 第 95 轮与上游对齐迭代次数（12）后，容差如实放到 3 位小数。
     */
    expect(exitHalf.alpha).toBeCloseTo(1 - enterHalf.blurPx / 14, 3);
    const enterStart = resolveSonnetTransitionEffect('fast-blur', 'enter', 0, 1);
    expect(enterStart.alpha).toBeCloseTo(1 - 0.82, 6);
    // 模糊上限就是 14px。
    expect(resolveSonnetTransitionEffect('fast-blur', 'exit', 1, 1).blurPx).toBeCloseTo(14, 6);
  });

  it('mono-glitch：14 档跳帧，出场只有最后 14% 才真的暗下去', () => {
    const early = resolveSonnetTransitionEffect('mono-glitch', 'exit', 0.4, 11);
    const late = resolveSonnetTransitionEffect('mono-glitch', 'exit', 0.95, 11);
    // 中途 α 保持 1：这是"跳帧"不是"淡出"。
    expect(early.alpha).toBeCloseTo(1, 6);
    expect(late.alpha).toBeLessThan(1);
    expect(late.alpha).toBeCloseTo(
      1 - (0.95 - SONNET_GLITCH_ALPHA_TAIL) / (1 - SONNET_GLITCH_ALPHA_TAIL),
      6,
    );
    // 档位是离散的：相邻两帧的 glitchSeed 只会按 0.173 跳。
    const stepA = resolveSonnetTransitionEffect('mono-glitch', 'exit', 0.01, 5).glitchSeed;
    const stepB = resolveSonnetTransitionEffect('mono-glitch', 'exit', 1 / SONNET_GLITCH_STEPS + 0.001, 5).glitchSeed;
    expect(stepB - stepA).toBeCloseTo(0.173, 6);
    // 模糊与缩放都不参与。
    expect(early.blurPx).toBe(0);
    expect(early.scale).toBe(1);
  });

  it('camera-pull 刻意不缩放（缩了就会露出场景滤镜的边界）', () => {
    for (const progress of [0, 0.25, 0.5, 1]) {
      const frame = resolveSonnetTransitionEffect('camera-pull', 'exit', progress, 3);
      expect(frame.scale).toBe(1);
      expect(frame.blurPx).toBe(0);
      expect(frame.glitch).toBe(0);
    }
    expect(resolveSonnetTransitionEffect('camera-pull', 'enter', 0, 3).alpha).toBeCloseTo(0.28, 6);
    expect(resolveSonnetTransitionEffect('camera-pull', 'exit', 1, 3).alpha).toBeCloseTo(0, 6);
  });

  it('镜头之间的转场时长夹在 0.06~0.10 秒（**主动偏差**：主人要"句间快速硬切"）', () => {
    expect(resolveSonnetShotTransitionDuration(0, 10)).toBeCloseTo(SONNET_SHOT_TRANSITION_MAX, 6);
    expect(resolveSonnetShotTransitionDuration(0, 0.2)).toBeCloseTo(SONNET_SHOT_TRANSITION_MIN, 6);
    // 中间档仍按 0.18 系数算，但会被**新的上限**夹住：1 秒间隔 ⇒ 0.18 ⇒ 夹到 0.10。
    expect(resolveSonnetShotTransitionDuration(0, 1)).toBeCloseTo(SONNET_SHOT_TRANSITION_MAX, 6);
  });

  it('整首歌里每两个相邻镜头之间都排得出一段转场（这是原版最有辨识度的节奏）', () => {
    const program = compileSonnetProgram(SONG, { seed: 'shot-transition' });
    const shots = program.paragraphs.flatMap((paragraph) => paragraph.shots);
    expect(shots.length).toBeGreaterThanOrEqual(2);
    const seed = sonnetSeedNumber(program.seed);
    let activeCount = 0;
    for (let index = 0; index + 1 < shots.length; index += 1) {
      const current = shots[index];
      const next = shots[index + 1];
      if (current === undefined || next === undefined) continue;
      const duration = resolveSonnetShotTransitionDuration(current.startTime, next.startTime);
      // 转场窗口的正中间必然在转场中。
      const middle = next.startTime - duration / 2;
      const frame = resolveSonnetShotTransition(shots, index, middle, seed);
      if (frame !== SONNET_IDLE_TRANSITION) activeCount += 1;
    }
    expect(activeCount).toBeGreaterThanOrEqual(1);
  });

  it('只有一镜时不产生转场', () => {
    const program = compileSonnetProgram([makeLine(0, '甲乙', 0, 400)], { seed: 'single' });
    const shots = program.paragraphs.flatMap((paragraph) => paragraph.shots);
    if (shots.length < 2) {
      expect(resolveSonnetShotTransition(shots, 0, 0, 1)).toBe(SONNET_IDLE_TRANSITION);
    }
    // 空数组也必须安静。
    expect(resolveSonnetShotTransition([], 0, 0, 1)).toBe(SONNET_IDLE_TRANSITION);
  });
});
