/**
 * 逐字入场运动 / 色差 / 半主角回声（`sonnetGlyphMotion.ts`）的自查。
 *
 * 这一层是**纯函数**，钉的是"某个字在某时刻应该长什么样"：
 * · 没轮到的字（`time < startTime`）α = 0；入场从 `0.16 / 0.86` 起、落位到 `1 / 1`；
 * · 落位后字身不再变化（没有退场）；
 * · 色差副本入场时分离最大、落位后保留 20%；
 * · 半主角回声一次性：前 20% 线性升、后 80% 平方淡出，`p ≥ 1` 后彻底消失。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_CA_COPY_ALPHA_BODY,
  SONNET_CA_COPY_ALPHA_EMPHASIS,
  SONNET_CA_MERGE_RETAIN,
  SONNET_CA_OFFSET_BODY,
  SONNET_CA_OFFSET_EMPHASIS,
  SONNET_ECHO_LAYER_ALPHAS,
  SONNET_ECHO_LAYER_FACTORS,
  SONNET_ECHO_MAX_DURATION,
  SONNET_ECHO_MIN_DURATION,
  SONNET_ECHO_SPREAD_RATIO,
  SONNET_GLYPH_CORE_ALPHA_BASE,
  SONNET_GLYPH_HALO_ALPHA_DECAY,
  SONNET_GLYPH_HALO_SCALE_BASE,
  SONNET_GLYPH_HALO_SCALE_DECAY,
  SONNET_GLYPH_IMPACT_SCALE_FLOOR,
  SONNET_GLYPH_SCALE_FLOOR,
  resolveSonnetEchoDuration,
  resolveSonnetEchoEnvelope,
  resolveSonnetGlyphMotion,
  resolveSonnetLayoutNormal,
  type SonnetGlyphMotionInput,
} from './sonnetGlyphMotion';

const START = 1;
const SETTLE = 1.5;
const FONT_PX = 200;
const SHOT_DURATION = 4;
const ECHO_DURATION = resolveSonnetEchoDuration(SHOT_DURATION);

const baseInput = (
  time: number,
  overrides: Partial<SonnetGlyphMotionInput> = {},
): SonnetGlyphMotionInput =>
  ({
    startTime: START,
    settleTime: SETTLE,
    time,
    finalRotation: 0,
    entryRotation: 0,
    enterX: 40,
    enterY: -30,
    emphasis: false,
    shotKind: 'editorial-column',
    role: 'support',
    fontPx: FONT_PX,
    normal: { x: 0, y: 1 },
    shotDuration: SHOT_DURATION,
    echoSide: 1,
    ...overrides,
  }) as SonnetGlyphMotionInput;

/** 字身那些"落位后必须冻结"的量（回声是有时限的，单独测）。 */
const bodySnapshot = (frame: ReturnType<typeof resolveSonnetGlyphMotion>) => [
  frame.alpha,
  frame.scale,
  frame.haloScale,
  frame.haloAlpha,
  frame.rotation,
  frame.offsetX,
  frame.offsetY,
  frame.caOffset,
  frame.caCopyAlpha,
];

describe('逐字入场运动（照抄上游 sonnetShotFrame 的逐字那一段）', () => {
  it('没轮到的字：α = 0（完全不出场）', () => {
    const waiting = resolveSonnetGlyphMotion(baseInput(START - 0.5));
    expect(waiting.waiting).toBe(true);
    expect(waiting.alpha).toBe(0);
    expect(waiting.haloAlpha).toBe(0);
    /*
     * 位移仍是**入场矢量本身**：这是"还没开始走"的正确定义（`offset = (1 − p) × motion`，p = 0）。
     * 渲染层靠 `alpha = 0` 让它看不见，所以"等在画面外"不会露出半个字。
     */
    expect(waiting.offsetX).toBeCloseTo(40, 9);
    expect(waiting.offsetY).toBeCloseTo(-30, 9);
    expect(waiting.scale).toBeCloseTo(SONNET_GLYPH_SCALE_FLOOR, 9);
  });

  it('刚开始入场那一刻：α = 0.16、scale = 0.86、光晕 α = 1（上游的截距）', () => {
    const started = resolveSonnetGlyphMotion(baseInput(START));
    expect(started.waiting).toBe(false);
    expect(started.progress).toBeCloseTo(0, 9);
    expect(started.alpha).toBeCloseTo(SONNET_GLYPH_CORE_ALPHA_BASE, 9);
    expect(started.alpha).toBeCloseTo(0.16, 9);
    expect(started.scale).toBeCloseTo(0.86, 9);
    expect(started.haloAlpha).toBeCloseTo(1, 9);
    expect(started.haloScale).toBeCloseTo(SONNET_GLYPH_HALO_SCALE_BASE * 0.86, 9);
  });

  it('落位：α = 1、scale = 1、位移 = 0、rotation = 版式角度、光晕收到 0.72', () => {
    const settled = resolveSonnetGlyphMotion(
      baseInput(SETTLE, { finalRotation: 0.25, entryRotation: -0.035 }),
    );
    expect(settled.progress).toBe(1);
    expect(settled.alpha).toBeCloseTo(1, 9);
    expect(settled.scale).toBeCloseTo(1, 9);
    /* 位移的符号可能是 `-0`（`(1−1) × 负数`）⇒ 用绝对值断言，别被 `Object.is` 绊住。 */
    expect(Math.abs(settled.offsetX)).toBe(0);
    expect(Math.abs(settled.offsetY)).toBe(0);
    expect(settled.rotation).toBeCloseTo(0.25, 9);
    expect(settled.haloAlpha).toBeCloseTo(1 - SONNET_GLYPH_HALO_ALPHA_DECAY, 9);
    expect(settled.haloScale).toBeCloseTo(
      SONNET_GLYPH_HALO_SCALE_BASE - SONNET_GLYPH_HALO_SCALE_DECAY,
      9,
    );
  });

  it('**落位之后字身不再变**（只有入场，没有退场）', () => {
    const atSettle = resolveSonnetGlyphMotion(baseInput(SETTLE, { finalRotation: 0.1 }));
    for (const time of [SETTLE, SETTLE + 0.001, SETTLE + 4, SETTLE + 60]) {
      const later = resolveSonnetGlyphMotion(baseInput(time, { finalRotation: 0.1 }));
      expect(bodySnapshot(later)).toEqual(bodySnapshot(atSettle));
    }
  });

  it('入场是**逐字错峰**的：进度只随这个字自己的 `[startTime, settleTime]` 走', () => {
    const early = resolveSonnetGlyphMotion(baseInput(START + 0.1));
    const later = resolveSonnetGlyphMotion(baseInput(START + 0.4));
    expect(early.progress).toBeGreaterThan(0);
    expect(later.progress).toBeGreaterThan(early.progress);
    expect(later.alpha).toBeGreaterThan(early.alpha);
    expect(Math.abs(later.offsetX)).toBeLessThan(Math.abs(early.offsetX));
    expect(later.scale).toBeGreaterThan(early.scale);
  });

  it('旋转 = 版式角度 + 入场偏转 × (1 − p)；入场偏转落位后归零', () => {
    const started = resolveSonnetGlyphMotion(
      baseInput(START, { finalRotation: 0.2, entryRotation: 0.055 }),
    );
    expect(started.rotation).toBeCloseTo(0.2 + 0.055, 9);
    const settled = resolveSonnetGlyphMotion(
      baseInput(SETTLE, { finalRotation: 0.2, entryRotation: 0.055 }),
    );
    expect(settled.rotation).toBeCloseTo(0.2, 9);
  });

  it('`type-impact` 的强调字用 0.52 起手；其他镜头种类/非强调字用 0.86', () => {
    const impact = resolveSonnetGlyphMotion(
      baseInput(START, { emphasis: true, shotKind: 'type-impact' }),
    );
    expect(impact.scale).toBeCloseTo(SONNET_GLYPH_IMPACT_SCALE_FLOOR, 9);
    expect(impact.scale).toBeCloseTo(0.52, 9);
    // 强调字但**不是** type-impact ⇒ 与普通字同档（上游判据是"且"）。
    const otherKind = resolveSonnetGlyphMotion(
      baseInput(START, { emphasis: true, shotKind: 'mask-reveal' }),
    );
    expect(otherKind.scale).toBeCloseTo(0.86, 9);
    // 非强调字即使在 type-impact 里也不吃那一档。
    const plain = resolveSonnetGlyphMotion(
      baseInput(START, { emphasis: false, shotKind: 'type-impact' }),
    );
    expect(plain.scale).toBeCloseTo(0.86, 9);
  });

  it('seek 可重放：调用顺序与次数都不影响同一时刻的取值', () => {
    const at = 1.2;
    const first = resolveSonnetGlyphMotion(
      baseInput(at, { finalRotation: -0.15, entryRotation: 0.035 }),
    );
    resolveSonnetGlyphMotion(baseInput(at + 3));
    resolveSonnetGlyphMotion(baseInput(at - 0.9));
    const second = resolveSonnetGlyphMotion(
      baseInput(at, { finalRotation: -0.15, entryRotation: 0.035 }),
    );
    expect(second).toEqual(first);
  });

  it('`motion` 倍率只缩放入场位移，不影响 α / 缩放 / 光晕（上游同口径）', () => {
    const motion = 1;
    const scaled = resolveSonnetGlyphMotion(baseInput(START + 0.1, { motion: 2 }));
    const plain = resolveSonnetGlyphMotion(baseInput(START + 0.1, { motion }));
    expect(scaled.alpha).toBeCloseTo(plain.alpha, 12);
    expect(scaled.scale).toBeCloseTo(plain.scale, 12);
    expect(scaled.offsetX).toBeCloseTo(plain.offsetX * 2, 9);
    expect(scaled.offsetY).toBeCloseTo(plain.offsetY * 2, 9);
  });
});

describe('色差双副本（入场分离 → 落位保留 20%）', () => {
  it('没轮到：还没亮（字身 α = 0），但偏移已经是"待分离"的基准值', () => {
    const waiting = resolveSonnetGlyphMotion(baseInput(START - 0.2));
    expect(waiting.alpha).toBe(0);
    expect(waiting.caOffset).toBeCloseTo(FONT_PX * SONNET_CA_OFFSET_BODY, 9);
    expect(waiting.caCopyAlpha).toBeCloseTo(SONNET_CA_COPY_ALPHA_BODY, 9);
  });

  it('入场分离最大、随着落位收拢；落位后**恰好保留 20%**', () => {
    const atStart = resolveSonnetGlyphMotion(baseInput(START));
    const mid = resolveSonnetGlyphMotion(baseInput((START + SETTLE) / 2));
    const settled = resolveSonnetGlyphMotion(baseInput(SETTLE));
    const base = FONT_PX * SONNET_CA_OFFSET_BODY;
    expect(atStart.caOffset).toBeCloseTo(base, 9);
    expect(mid.caOffset).toBeLessThan(atStart.caOffset);
    expect(settled.caOffset).toBeCloseTo(base * SONNET_CA_MERGE_RETAIN, 9);
    // 落位之后再往后也不再收（不会收到 0）。
    expect(resolveSonnetGlyphMotion(baseInput(SETTLE + 30)).caOffset).toBeCloseTo(
      base * SONNET_CA_MERGE_RETAIN,
      9,
    );
  });

  it('强调字的基准偏移更大、副本更亮（0.025 / 0.8 对 0.010 / 0.5）', () => {
    const body = resolveSonnetGlyphMotion(baseInput(START));
    const emphasis = resolveSonnetGlyphMotion(baseInput(START, { emphasis: true }));
    expect(emphasis.caOffset).toBeCloseTo(FONT_PX * SONNET_CA_OFFSET_EMPHASIS, 9);
    expect(emphasis.caOffset).toBeGreaterThan(body.caOffset);
    expect(body.caCopyAlpha).toBeCloseTo(SONNET_CA_COPY_ALPHA_BODY, 9);
    expect(emphasis.caCopyAlpha).toBeCloseTo(SONNET_CA_COPY_ALPHA_EMPHASIS, 9);
  });

  it('重放确定性：同一时刻算两次，色差与回声的每个字段都相同', () => {
    const at = START + 0.12;
    const options = { emphasis: true, role: 'semi-hero' as const };
    const first = resolveSonnetGlyphMotion(baseInput(at, options));
    resolveSonnetGlyphMotion(baseInput(at + 1.7, options));
    expect(resolveSonnetGlyphMotion(baseInput(at, options))).toEqual(first);
  });
});

describe('半主角空心回声（一次性，前 20% 升 / 后 80% 平方淡出）', () => {
  it('时长：`min(0.7, max(0.4, 镜长 × 0.12 + 0.1))`', () => {
    expect(resolveSonnetEchoDuration(0)).toBeCloseTo(SONNET_ECHO_MIN_DURATION, 9);
    expect(resolveSonnetEchoDuration(1)).toBeCloseTo(0.4, 9);
    expect(resolveSonnetEchoDuration(4)).toBeCloseTo(0.58, 9);
    expect(resolveSonnetEchoDuration(60)).toBeCloseTo(SONNET_ECHO_MAX_DURATION, 9);
  });

  it('包络：`p ≤ 0.2` 线性升到 1，之后平方衰减到 0，两端之外为 0', () => {
    expect(resolveSonnetEchoEnvelope(0)).toBe(0);
    expect(resolveSonnetEchoEnvelope(0.1)).toBeCloseTo(0.5, 9);
    expect(resolveSonnetEchoEnvelope(0.2)).toBeCloseTo(1, 9);
    expect(resolveSonnetEchoEnvelope(0.6)).toBeCloseTo(0.25, 9);
    expect(resolveSonnetEchoEnvelope(1)).toBe(0);
    expect(resolveSonnetEchoEnvelope(2)).toBe(0);
    expect(resolveSonnetEchoEnvelope(-1)).toBe(0);
  });

  it('早 / 中 / 晚：升 → 峰值 → 淡出，且 `p ≥ 1` 后**彻底消失**', () => {
    const at = (time: number) => resolveSonnetGlyphMotion(baseInput(time, { role: 'semi-hero' }));
    const early = at(START + ECHO_DURATION * 0.1);
    const peak = at(START + ECHO_DURATION * 0.2);
    const late = at(START + ECHO_DURATION * 0.8);
    const gone = at(START + ECHO_DURATION);
    expect(early.echoActive).toBe(true);
    expect(early.echoAlpha1).toBeGreaterThan(0);
    expect(peak.echoAlpha1).toBeCloseTo(SONNET_ECHO_LAYER_ALPHAS[0], 9);
    expect(peak.echoAlpha2).toBeCloseTo(SONNET_ECHO_LAYER_ALPHAS[1], 9);
    expect(late.echoAlpha1).toBeLessThan(peak.echoAlpha1);
    expect(late.echoAlpha1).toBeGreaterThan(0);
    // 结束那一刻：不再活跃，两层都为 0、位移也归零。
    expect(gone.echoActive).toBe(false);
    expect(gone.echoAlpha1).toBe(0);
    expect(gone.echoAlpha2).toBe(0);
    expect(Math.abs(gone.echoOffset1X)).toBe(0);
    expect(Math.abs(gone.echoOffset1Y)).toBe(0);
    // 还在入场之前也不该有回声。
    expect(at(START - 0.01).echoActive).toBe(false);
  });

  it('普通字（非半主角）没有任何回声', () => {
    for (const role of ['hero', 'support', 'decoration'] as const) {
      const frame = resolveSonnetGlyphMotion(baseInput(START + ECHO_DURATION * 0.2, { role }));
      expect(frame.echoActive, `${role} 不该有回声`).toBe(false);
      expect(frame.echoAlpha1).toBe(0);
      expect(frame.echoAlpha2).toBe(0);
      expect(frame.echoOffset1X).toBe(0);
      expect(frame.echoOffset2X).toBe(0);
    }
  });

  it('沿版面法向分离：两层同侧、层倍率 1.7，距离随 spread 单调张开', () => {
    const at = (time: number, echoSide = 1) =>
      resolveSonnetGlyphMotion(baseInput(time, { role: 'semi-hero', echoSide }));
    const far = at(START + ECHO_DURATION * 0.2);
    const near = at(START + ECHO_DURATION * 0.05);
    // 法向 (0,1) ⇒ 位移全在 y；两层同号。
    expect(far.echoOffset1X).toBe(0);
    expect(far.echoOffset2X).toBe(0);
    expect(Math.sign(far.echoOffset1Y)).toBe(Math.sign(far.echoOffset2Y));
    expect(far.echoOffset2Y / far.echoOffset1Y).toBeCloseTo(
      SONNET_ECHO_LAYER_FACTORS[1] / SONNET_ECHO_LAYER_FACTORS[0],
      9,
    );
    expect(Math.abs(far.echoOffset1Y)).toBeGreaterThan(Math.abs(near.echoOffset1Y));
    // 左右由 `echoSide` 决定（同一条版面上是确定的）。
    expect(at(START + ECHO_DURATION * 0.2, -1).echoOffset1Y).toBeCloseTo(-far.echoOffset1Y, 9);
    // 最大距离 = 字号 × 0.85（p → 1 时 spread → 1，但那时已经不可见，所以用包络峰值处近似）。
    expect(Math.abs(far.echoOffset1Y)).toBeLessThanOrEqual(
      FONT_PX * SONNET_ECHO_SPREAD_RATIO * SONNET_ECHO_LAYER_FACTORS[0] + 1e-9,
    );
  });

  it('版面法向：横排取竖直、竖排取水平，并随版式角度旋转', () => {
    expect(resolveSonnetLayoutNormal(false, 0)).toEqual({ x: 0, y: 1 });
    expect(resolveSonnetLayoutNormal(true, 0)).toEqual({ x: 1, y: 0 });
    /* 按 `−rotation` 转回 wrapper 局部坐标：版式转 +90° 时，"竖直法向"落到 +x 上。 */
    const rotated = resolveSonnetLayoutNormal(false, Math.PI / 2);
    expect(rotated.x).toBeCloseTo(1, 9);
    expect(rotated.y).toBeCloseTo(0, 9);
    const turned = resolveSonnetLayoutNormal(true, Math.PI / 2);
    expect(turned.x).toBeCloseTo(0, 9);
    expect(turned.y).toBeCloseTo(-1, 9);
  });
});
