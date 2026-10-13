/**
 * "画进来"引擎的用例（`sonnetStagger.ts`，第 487 轮补）。
 * 手算基准：
 * · `index = 0` ⇒ `slot 0` ⇒ `delay 0`；`index = 1` ⇒ `slot = φ = 0.6180339887498949` ⇒ stroke `delay = 0.30901699437494745` ✓
 * · 直线 (0,0)→(10,0) 长 10 ✓；二次 (0,0)–(10,0)–(20,0) 长 20 ✓；三次 (0,0)–(0,10)–(10,10)–(10,0) 长 30 ✓
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_STAGGER_GOLDEN,
  SONNET_STAGGER_JITTER_DIVISOR,
  SONNET_STAGGER_JITTER_MULTIPLIER,
  resolveSonnetPartialDraws,
  resolveSonnetPartialSegment,
  resolveSonnetPathLength,
  resolveSonnetStaggerProgress,
  resolveSonnetStaggerSpan,
  sonnetPathArc,
  sonnetPathBezier,
  sonnetPathLine,
  sonnetPathQuadratic,
} from './sonnetStagger';

const PHI = SONNET_STAGGER_GOLDEN;

describe('画进来：错峰调度', () => {
  it('index 0 ⇒ delay 0、span 0.32（stroke）/ 0.4（fill）', () => {
    const stroke = resolveSonnetStaggerSpan(0, true);
    expect(stroke.delay).toBe(0);
    expect(stroke.span).toBeCloseTo(0.32, 9);
    expect(stroke.staggerSpan).toBeCloseTo(0.32, 9);
    const fill = resolveSonnetStaggerSpan(0, false);
    expect(fill.delay).toBe(0);
    expect(fill.span).toBeCloseTo(0.4, 9);
  });

  it('index 1 ⇒ slot = φ（1 × φ % 1 = φ）⇒ stroke delay = φ / 2', () => {
    const stroke = resolveSonnetStaggerSpan(1, true);
    expect(stroke.delay).toBeCloseTo(PHI / 2, 9);
    /*
     * ⚠ 第 487 轮修：抖动**不是** `φ` ✗ —— 它是 `2654435761 / 2^32` ✓，
     * 与 `φ` 只差在第 10 位小数（0.618033988749**89** vs 0.618033988749**89**… 尾数不同 ✓）
     * ⇒ 直接用两个常量算，别拿 `φ` 代替 ✓（差 5e-10，`toBeCloseTo(…, 9)` 会红 ✓）。
     */
    const jitter = SONNET_STAGGER_JITTER_MULTIPLIER / SONNET_STAGGER_JITTER_DIVISOR;
    expect(stroke.span).toBeCloseTo(0.32 + jitter * 0.26, 9);
    const fill = resolveSonnetStaggerSpan(1, false);
    expect(fill.delay).toBeCloseTo(PHI * 0.45, 9);
    expect(fill.span).toBeCloseTo(0.4 + jitter * 0.25, 9);
  });

  it('index 9 的 fill：slot = (9φ) % 1 = 0.5623058987490537', () => {
    const fill = resolveSonnetStaggerSpan(9, false);
    expect(fill.delay).toBeCloseTo(0.5623058987490537 * 0.45, 9);
  });

  it('任何一条都满足 staggerSpan ≤ 1 − delay（保证 progress = 1 时走完）', () => {
    for (let index = 0; index < 64; index += 1) {
      for (const isStroke of [true, false]) {
        const span = resolveSonnetStaggerSpan(index, isStroke);
        expect(span.staggerSpan).toBeLessThanOrEqual(1 - span.delay + 1e-12);
        expect(span.staggerSpan).toBeLessThanOrEqual(span.span + 1e-12);
        expect(span.delay).toBeGreaterThanOrEqual(0);
        expect(span.delay).toBeLessThan(1);
      }
    }
  });

  it('进度三段：三次缓出 + 前半个窗口把 alpha 拉满', () => {
    const span = resolveSonnetStaggerSpan(0, true); // delay 0 / span 0.32
    expect(resolveSonnetStaggerProgress(0, span)).toEqual({
      localRaw: 0,
      localProgress: 0,
      alphaProgress: 0,
    });
    const half = resolveSonnetStaggerProgress(0.16, span); // localRaw 0.5
    expect(half.localRaw).toBeCloseTo(0.5, 9);
    expect(half.localProgress).toBeCloseTo(1 - 0.5 ** 3, 9); // 0.875 ✓
    expect(half.alphaProgress).toBeCloseTo(1, 9); // min(1, 1) ⇒ 拉满 ✓
    const done = resolveSonnetStaggerProgress(1, span);
    expect(done.localProgress).toBeCloseTo(1, 9);
    expect(done.alphaProgress).toBeCloseTo(1, 9);
  });
});

describe('画进来：路径长度', () => {
  it('直线 = hypot；二次 = 两段之和；三次 = 三段之和', () => {
    expect(sonnetPathLine(0, 0, 10, 0).length).toBeCloseTo(10, 9);
    expect(sonnetPathQuadratic(0, 0, 10, 0, 20, 0).length).toBeCloseTo(20, 9);
    expect(sonnetPathBezier(0, 0, 0, 10, 10, 10, 10, 0).length).toBeCloseTo(30, 9);
    expect(resolveSonnetPathLength([sonnetPathLine(0, 0, 3, 4), sonnetPathLine(3, 4, 3, 4)])).toBeCloseTo(5, 9);
  });

  it('弧：长度 = |Δ| × r；角差压到 (−π, π]', () => {
    expect(sonnetPathArc(0, 0, 10, 0, Math.PI).length).toBeCloseTo(Math.PI * 10, 9);
    // 0 → 3π/2 压成 −π/2（短的那边）
    const wrapped = sonnetPathArc(0, 0, 10, 0, (Math.PI * 3) / 2);
    expect(wrapped.angleDelta).toBeCloseTo(-Math.PI / 2, 9);
    expect(wrapped.length).toBeCloseTo((Math.PI / 2) * 10, 9);
    // 反向：角差被压到 (−π, π] ⇒ 一律走**短边**（`−π/2`），`anticlockwise = false` 不会把它推成长边 ✓
    //（⚠ 第 487 轮修：我原来期望 `+3π/2` ✗ —— 那与"正化到 (−π, π]"自相矛盾 ✗；
    // 要与上游一致就得接受"弧扫角 ≤ π"，**画整圆要用 circle** ✓）
    const back = sonnetPathArc(0, 0, 10, Math.PI / 2, 0);
    expect(back.angleDelta).toBeCloseTo(-Math.PI / 2, 9);
    expect(back.length).toBeCloseTo((Math.PI / 2) * 10, 9);
    // anticlockwise = true ⇒ 取反方向（这里原本就是负向 ⇒ 保持负向 ✓）
    const reversed = sonnetPathArc(0, 0, 10, Math.PI / 2, 0, true);
    expect(reversed.angleDelta).toBeCloseTo(-Math.PI / 2, 9);
  });
});

describe('画进来：按长度截断（de Casteljau）', () => {
  it('直线 ratio 0.5 ⇒ 中点', () => {
    const draws = resolveSonnetPartialDraws([sonnetPathLine(0, 0, 10, 0)], 5);
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ kind: 'line', x1: 0, y1: 0 });
    expect(draws[0]!.kind === 'line' && draws[0]!.x2).toBeCloseTo(5, 9);
    expect(draws[0]!.kind === 'line' && draws[0]!.y2).toBeCloseTo(0, 9);
  });

  it('二次 ratio 0.5 ⇒ 新控制点 (from + c) / 2、新终点 = 曲线中点', () => {
    const draws = resolveSonnetPartialDraws([sonnetPathQuadratic(0, 0, 10, 0, 20, 0)], 10);
    const curve = draws[0]!;
    expect(curve.kind).toBe('quadratic');
    expect(curve.kind === 'quadratic' && curve.controlX).toBeCloseTo(5, 9);
    expect(curve.kind === 'quadratic' && curve.toX).toBeCloseTo(10, 9); // B(0.5) x ✓
    expect(curve.kind === 'quadratic' && curve.toY).toBeCloseTo(0, 9);
  });

  it('三次 ratio 0.5 ⇒ 终点就是曲线中点 (5, 7.5)（三层 de Casteljau 自检）', () => {
    const draws = resolveSonnetPartialDraws([sonnetPathBezier(0, 0, 0, 10, 10, 10, 10, 0)], 15);
    const curve = draws[0]!;
    expect(curve.kind).toBe('bezier');
    expect(curve.kind === 'bezier' && curve.toX).toBeCloseTo(5, 9);
    expect(curve.kind === 'bezier' && curve.toY).toBeCloseTo(7.5, 9);
    // 与标准三次贝塞尔公式对拍 ✓
    const t = 0.5;
    const bx = 3 * (1 - t) ** 2 * t * 0 + 3 * (1 - t) * t ** 2 * 10 + t ** 3 * 10;
    const by = 3 * (1 - t) ** 2 * t * 10 + 3 * (1 - t) * t ** 2 * 10 + t ** 3 * 0;
    expect(curve.kind === 'bezier' && curve.toX).toBeCloseTo(bx, 9);
    expect(curve.kind === 'bezier' && curve.toY).toBeCloseTo(by, 9);
  });

  it('弧 ratio 0.5 ⇒ 末角 = start + Δ / 2', () => {
    const arc = sonnetPathArc(0, 0, 10, 0, Math.PI);
    const partial = resolveSonnetPartialSegment(arc, 0.5);
    expect(partial.kind).toBe('arc');
    expect(partial.kind === 'arc' && partial.endAngle).toBeCloseTo(Math.PI / 2, 9);
  });

  it('整段照画 + 末段截断：目标超过总长画完、为 0 画空', () => {
    const segments = [sonnetPathLine(0, 0, 10, 0), sonnetPathLine(10, 0, 10, 10)];
    expect(resolveSonnetPartialDraws(segments, 0)).toEqual([]);
    expect(resolveSonnetPartialDraws(segments, 12)).toHaveLength(2);
    const second = resolveSonnetPartialDraws(segments, 12)[1]!;
    expect(second.kind === 'line' && second.y2).toBeCloseTo(2, 9);
    expect(resolveSonnetPartialDraws(segments, 999)).toHaveLength(2);
    const full = resolveSonnetPartialDraws(segments, 999)[1]!;
    expect(full.kind === 'line' && full.y2).toBeCloseTo(10, 9);
  });
});
