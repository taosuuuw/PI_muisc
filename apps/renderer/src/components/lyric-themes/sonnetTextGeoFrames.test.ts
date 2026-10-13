/**
 * 「每个词背后的局部固定几何」帧级桥接（`sonnetTextGeoFrames.ts`）的用例。
 *
 * 对手是上游 `sonnet/sonnetTextViewBuilder.ts:340~389` 与 `sonnet/sonnetTextFixedGeo.ts`：
 * seed 公式、合唱判据、26/15 阈值、四条排除条件（decoration / 非词形 / 无字形 / 与边框互斥）、
 * 以及"时序取第一个字形"这条契约，逐条钉住。
 * 随机量（命中与否）不钉具体词，只断言"阈值区间 + 同输入同输出 + 分布落在大致比例内"。
 */

import { describe, expect, it } from 'vitest';
import { resolveSonnetFrameDecorSpec } from './sonnetFrameDecor';
import {
  SONNET_FRAME_DECOR_SEED_SALT,
  SONNET_FRAME_DECOR_SEED_STRIDE,
} from './sonnetFrameDecorFrames';
import { mixSonnetSeed } from './sonnetGeo';
import {
  SONNET_TEXT_GEO_CHORUS_ROLL,
  SONNET_TEXT_GEO_SEED_STRIDE,
  resolveSonnetTextGeoFrames,
  resolveSonnetTextGeoSeed,
  type SonnetTextGeoRunLike,
} from './sonnetTextGeoFrames';

function makeRun(overrides: Partial<SonnetTextGeoRunLike> = {}): SonnetTextGeoRunLike {
  return {
    text: 'word',
    fontPx: 80,
    x: 100,
    y: 200,
    rotation: 0,
    emphasis: false,
    role: 'support',
    isWordLike: true,
    enterX: 0,
    enterY: 300,
    tracking: [{ startTime: 5.2, settleTime: 5.9 }, { startTime: 5.4, settleTime: 6.1 }],
    ...overrides,
  };
}

const OPTIONS = {
  frameShotSeed: 12345,
  paragraphKind: 'verse',
} as const;

/** 上游 seed 公式：字符码求和 + `segmentIndex × 13` ✓。 */
describe('词级几何：seed 公式（照抄上游）', () => {
  it('字符码求和 + segmentIndex × 13（逐 code unit，不是 code point）', () => {
    // 'ab' = 97 + 98 = 195；index 2 ⇒ 195 + 26 = 221。
    expect(resolveSonnetTextGeoSeed('ab', 2)).toBe(195 + 2 * SONNET_TEXT_GEO_SEED_STRIDE);
    expect(SONNET_TEXT_GEO_SEED_STRIDE).toBe(13);
    // 中文按 code unit 求和：'微' = 0x5fae = 24494。
    expect(resolveSonnetTextGeoSeed('微', 0)).toBe(0x5fae);
    // 同一个词、不同段下标 ⇒ 不同 seed（上游就是这样区分的 ✓）。
    expect(resolveSonnetTextGeoSeed('word', 0)).not.toBe(resolveSonnetTextGeoSeed('word', 1));
  });
});

describe('词级几何：命中条件（上游 shouldAddBgShape）', () => {
  it('合唱段落一律按"合唱效果"算；非合唱段里 seed % 100 < 35 也算', () => {
    const chorus = resolveSonnetTextGeoFrames([makeRun()], { ...OPTIONS, paragraphKind: 'chorus' });
    expect(chorus[0]?.isChorusEffect).toBe(true);
    /*
     * 非合唱段要找一个 `seed % 100 < 35` 的词来验 ✓（随便试几个词面即可，公式是确定的 ✓）。
     */
    const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'];
    const frames = resolveSonnetTextGeoFrames(
      words.map((text) => makeRun({ text })),
      OPTIONS,
    );
    for (const frame of frames) {
      const seed = resolveSonnetTextGeoSeed(words[frame.index] ?? '', frame.index);
      expect(frame.isChorusEffect).toBe(seed % 100 < SONNET_TEXT_GEO_CHORUS_ROLL);
    }
    expect(frames.some((frame) => frame.isChorusEffect)).toBe(true);
    expect(chorus[0]?.seed).toBe(resolveSonnetTextGeoSeed('word', 0));
  });

  it('四条排除：装饰字 / 非词形 / 没有字形 / 与边框互斥', () => {
    /* ① 装饰字。 */
    const decoration = resolveSonnetTextGeoFrames([makeRun({ role: 'decoration' })], OPTIONS);
    expect(decoration[0]?.motion).toBeUndefined();
    /* ② 非词形（标点、空白等）。 */
    const notWord = resolveSonnetTextGeoFrames([makeRun({ isWordLike: false })], OPTIONS);
    expect(notWord[0]?.motion).toBeUndefined();
    /* ③ 没有字形（拿不到 tracking）。 */
    const noGlyph = resolveSonnetTextGeoFrames([makeRun({ tracking: [] })], OPTIONS);
    expect(noGlyph[0]?.motion).toBeUndefined();
    const noTracking = resolveSonnetTextGeoFrames([makeRun({ tracking: undefined })], OPTIONS);
    expect(noTracking[0]?.motion).toBeUndefined();
  });

  it('**与边框互斥**：凡 `frameDecor.applied` 为真的 run，一定没有词级几何', () => {
    /*
     * 用**同一组常数**独立复算边框取档（这是上游那条注释的硬要求 ✓），
     * 再拿一批不同 seed 的 run 去核对"两边不会同时命中" ✓。
     */
    const runs = Array.from({ length: 200 }, (_unused, index) =>
      makeRun({ text: `w${index}`, x: index * 3 }),
    );
    const frames = resolveSonnetTextGeoFrames(runs, OPTIONS);
    let decorApplied = 0;
    let bothApplied = 0;
    frames.forEach((frame, index) => {
      const hash = mixSonnetSeed(
        OPTIONS.frameShotSeed + index * SONNET_FRAME_DECOR_SEED_STRIDE,
        SONNET_FRAME_DECOR_SEED_SALT,
      );
      if (!resolveSonnetFrameDecorSpec(hash).applied) return;
      decorApplied += 1;
      if (frame.motion !== undefined) bothApplied += 1;
    });
    // 概率 0.4 ⇒ 200 个里应当有一批命中（用区间断言，避免换盐时的假红 ✓）。
    expect(decorApplied).toBeGreaterThan(40);
    expect(decorApplied).toBeLessThan(140);
    // **一条都不许同时命中** ✓。
    expect(bothApplied).toBe(0);
  });

  it('命中比例落在阈值内（非合唱 ≈15%、合唱 ≈26%，按"排除边框之后"的分母算）', () => {
    const runs = Array.from({ length: 400 }, (_unused, index) =>
      makeRun({ text: `w${index}`, x: index * 3 }),
    );
    const count = (paragraphKind: string): { hits: number; eligible: number } => {
      const frames = resolveSonnetTextGeoFrames(runs, { ...OPTIONS, paragraphKind });
      let hits = 0;
      let eligible = 0;
      frames.forEach((frame, index) => {
        const hash = mixSonnetSeed(
          OPTIONS.frameShotSeed + index * SONNET_FRAME_DECOR_SEED_STRIDE,
          SONNET_FRAME_DECOR_SEED_SALT,
        );
        if (resolveSonnetFrameDecorSpec(hash).applied) return;
        eligible += 1;
        if (frame.motion !== undefined) hits += 1;
      });
      return { hits, eligible };
    };
    const support = count('verse');
    const chorus = count('chorus');
    /*
     * 非合唱：`seed % 100 < 15` 的**占比 15%**，但其中一部分是合唱效果词（阈值 26%）⇒ 总命中率
     * 落在 15%~26% 之间 ✓；合唱段全按 26% ✓。用宽区间断言（离散 seed 的抽样波动 ✓）。
     */
    const supportRate = support.hits / support.eligible;
    const chorusRate = chorus.hits / chorus.eligible;
    expect(supportRate).toBeGreaterThan(0.1);
    expect(supportRate).toBeLessThan(0.35);
    expect(chorusRate).toBeGreaterThan(0.15);
    expect(chorusRate).toBeLessThan(0.38);
  });
});

describe('词级几何：给的参数与时序', () => {
  it('命中时：x/y/rotation/fontPx 抄 placement，时序取**第一个字形**', () => {
    /* 挑一个确定命中的 run：先用一次求解找出命中项，再逐字段核对。 */
    const runs = Array.from({ length: 50 }, (_unused, index) =>
      makeRun({
        text: `w${index}`,
        x: 10 + index,
        y: 20 + index,
        rotation: 0.1,
        fontPx: 60 + index,
        enterX: -30,
        enterY: 40,
        tracking: [{ startTime: 1.25, settleTime: 1.85 }],
      }),
    );
    const frames = resolveSonnetTextGeoFrames(runs, OPTIONS);
    const hit = frames.find((frame) => frame.motion !== undefined);
    expect(hit).toBeDefined();
    const run = runs[hit!.index]!;
    expect(hit?.x).toBe(run.x);
    expect(hit?.y).toBe(run.y);
    expect(hit?.rotation).toBe(run.rotation);
    expect(hit?.fontPx).toBe(run.fontPx);
    expect(hit?.motion?.startTime).toBe(1.25); // 首字起点
    expect(hit?.motion?.settleTime).toBe(1.85); // 首字落位
    expect(hit?.motion?.enterX).toBe(run.enterX);
    expect(hit?.motion?.enterY).toBe(run.enterY);
    expect(hit?.motion?.finalRotation).toBe(run.rotation);
    /* 上游 `zDepth = −0.5 − (seed % 5) × 0.1`。 */
    expect(hit?.zDepth).toBeCloseTo(-0.5 - ((hit!.seed % 5) * 0.1), 6);
  });

  it('**长词首字先落位**：`settleTime` 取首字自己的落位时刻，不是段的结束时间', () => {
    /*
     * 一个长词里首字 5.6 秒就落位、末字 8.4 秒才落位。桥接必须取**首字**那一个数；
     * 若拿段的结束时间（这里就是末字的落位 8.4）顶替，几何会一直悬着。
     */
    const runs = Array.from({ length: 50 }, (_unused, index) =>
      makeRun({
        text: `L${index}`,
        tracking: [
          { startTime: 5.0, settleTime: 5.6 },
          { startTime: 6.2, settleTime: 7.0 },
          { startTime: 7.6, settleTime: 8.4 },
        ],
      }),
    );
    const frames = resolveSonnetTextGeoFrames(runs, OPTIONS);
    const hit = frames.find((frame) => frame.motion !== undefined);
    expect(hit).toBeDefined();
    expect(hit?.motion?.startTime).toBe(5.0);
    expect(hit?.motion?.settleTime).toBe(5.6);
    // 首字落位早于末字落位。
    expect(hit?.motion?.settleTime).toBeLessThan(8.4);
  });

  it('**换 song provided 首字晚于 run.start**：入场时刻跟真实首字走', () => {
    /*
     * 逐字时间轴（`provided`）说第一个字形 7.4 秒之后才开始，远晚于段的起唱时刻；
     * 几何必须等首字，入场/落位都取 tracking 里那一个。
     */
    const starts = Array.from({ length: 50 }, (_unused, index) => 7.4 + index * 0.01);
    const runs = starts.map((firstStart, index) =>
      makeRun({
        text: `p${index}`,
        tracking: [{ startTime: firstStart, settleTime: firstStart + 0.6 }],
      }),
    );
    const frames = resolveSonnetTextGeoFrames(runs, OPTIONS);
    const hit = frames.find((frame) => frame.motion !== undefined);
    expect(hit).toBeDefined();
    const firstStart = starts[hit!.index] ?? 0;
    expect(firstStart).toBeGreaterThanOrEqual(7.4);
    expect(hit?.motion?.startTime).toBe(firstStart);
    expect(hit?.motion?.settleTime).toBe(firstStart + 0.6);
  });

  it('逐 run 一条（含未命中）⇒ 下标与 runs 一一对应，池节点不会错位', () => {
    const runs = [makeRun({ text: 'a' }), makeRun({ text: 'b' }), makeRun({ text: 'c' })];
    const frames = resolveSonnetTextGeoFrames(runs, OPTIONS);
    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.index)).toEqual([0, 1, 2]);
    expect(frames.map((frame) => frame.seed)).toEqual(
      runs.map((run, index) => resolveSonnetTextGeoSeed(run.text, index)),
    );
  });

  it('确定性：同输入两次求解逐值相同（拖动进度条回同一时刻画面不跳）', () => {
    const runs = Array.from({ length: 30 }, (_unused, index) => makeRun({ text: `x${index}` }));
    expect(JSON.stringify(resolveSonnetTextGeoFrames(runs, OPTIONS))).toBe(
      JSON.stringify(resolveSonnetTextGeoFrames(runs, OPTIONS)),
    );
  });
});
