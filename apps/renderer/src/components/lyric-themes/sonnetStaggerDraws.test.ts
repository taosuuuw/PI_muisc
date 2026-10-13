/**
 * 「图元清单 → 错峰生长」适配层用例（`sonnetStaggerDraws.ts`，第 489 轮补）。
 * 手算基准：直线 (0,0)→(10,0) 长 10 ✓；二次 (0,0)-(10,0)-(20,0) 长 20 ✓；
 * 弧 `r 10 / 0 → π` 长 `10π` ✓；圆 `r 10 / stroke 2` 长 `20π` ✓（**填充圆长 0** ✓）；
 * 三角形 (0,0)-(10,0)-(10,10) 闭合 ⇒ `10 + 10 + 10√2` ✓；矩形 `w 20` ⇒ **20**（按宽度擦除 ✓）。
 */

import { describe, expect, it } from 'vitest';
import {
  resolveSonnetStaggerableLength,
  resolveSonnetStaggeredDraw,
  resolveSonnetStaggeredDraws,
  type SonnetStaggerableDraw,
  type SonnetStaggeredDraw,
} from './sonnetStaggerDraws';

const line = (x2 = 10): SonnetStaggerableDraw => ({
  kind: 'line',
  x1: 0,
  y1: 0,
  x2,
  y2: 0,
  strokeWidth: 1,
  alpha: 0.5,
  colorKey: 'primary',
});

const filledCircle: SonnetStaggerableDraw = {
  kind: 'circle',
  x: 0,
  y: 0,
  radius: 5,
  strokeWidth: 0,
  alpha: 0.8,
  colorKey: 'secondary',
};

const strokedRect: SonnetStaggerableDraw = {
  kind: 'rect',
  x: 0,
  y: 0,
  width: 20,
  height: 8,
  strokeWidth: 2,
  alpha: 0.6,
  colorKey: 'primary',
};

const triangle = (closed: boolean): SonnetStaggerableDraw => ({
  kind: 'polygon',
  points: [0, 0, 10, 0, 10, 10],
  closed,
  strokeWidth: 1,
  alpha: 0.4,
  colorKey: 'primary',
});

describe('生长适配：长度', () => {
  it('直线 / 二次 / 弧 / 圆 / 矩形（按宽）', () => {
    expect(resolveSonnetStaggerableLength(line())).toBeCloseTo(10, 9);
    expect(
      resolveSonnetStaggerableLength({
        kind: 'quadratic',
        fromX: 0,
        fromY: 0,
        controlX: 10,
        controlY: 0,
        toX: 20,
        toY: 0,
        strokeWidth: 1,
        alpha: 1,
        colorKey: 'primary',
      }),
    ).toBeCloseTo(20, 9);
    expect(
      resolveSonnetStaggerableLength({
        kind: 'arc',
        x: 0,
        y: 0,
        radius: 10,
        startAngle: 0,
        endAngle: Math.PI,
        strokeWidth: 2,
        alpha: 1,
        colorKey: 'primary',
      }),
    ).toBeCloseTo(Math.PI * 10, 9);
    expect(
      resolveSonnetStaggerableLength({
        kind: 'circle',
        x: 0,
        y: 0,
        radius: 10,
        strokeWidth: 2,
        alpha: 1,
        colorKey: 'primary',
      }),
    ).toBeCloseTo(Math.PI * 20, 9);
    expect(resolveSonnetStaggerableLength(filledCircle)).toBe(0); // 填充 ⇒ 不生长 ✓
    expect(resolveSonnetStaggerableLength(strokedRect)).toBeCloseTo(20, 9); // 按宽度 ✓
  });

  it('多边形：开口 = 边数 − 1、闭合 = 边数；三角形闭合含斜边 10√2', () => {
    const open = resolveSonnetStaggerableLength(triangle(false));
    const closed = resolveSonnetStaggerableLength(triangle(true));
    expect(open).toBeCloseTo(20, 9); // 10 + 10 ✓
    expect(closed - open).toBeCloseTo(Math.hypot(10, 10), 9);
  });
});

describe('生长适配：逐帧画法', () => {
  const allDraws: readonly SonnetStaggerableDraw[] = [
    line(),
    filledCircle,
    strokedRect,
    triangle(true),
  ];

  it('progress = 1 ⇒ 没有一条是 hidden（每条都走完 ✓）', () => {
    const staggered = resolveSonnetStaggeredDraws(allDraws, 1);
    expect(staggered).toHaveLength(4);
    staggered.forEach((item) => expect(item.kind).not.toBe('hidden'));
    // 描边类应当画满：末段的终点 = 原始终点 ✓
    const first = staggered[0]!;
    expect(first.kind).toBe('stroke');
    if (first.kind === 'stroke') {
      const part = first.parts[first.parts.length - 1]!;
      expect(part.kind === 'line' && part.x2).toBeCloseTo(10, 6);
    }
  });

  it('progress = 0 ⇒ 全部 hidden（连 index 0 也是 localRaw 0 ✓）', () => {
    const staggered = resolveSonnetStaggeredDraws(allDraws, 0);
    staggered.forEach((item) => expect(item.kind).toBe('hidden'));
  });

  it('矩形走 rect-wipe：width = w × localProgress，且不是按周长长', () => {
    const wipe = resolveSonnetStaggeredDraw(strokedRect, { index: 0, progress: 1 });
    expect(wipe.kind).toBe('rect-wipe');
    expect(wipe.kind === 'rect-wipe' && wipe.width).toBeCloseTo(20, 9);
    expect(wipe.kind === 'rect-wipe' && wipe.height).toBeCloseTo(8, 9);
    const half = resolveSonnetStaggeredDraw(strokedRect, { index: 0, progress: 0.16 }); // localRaw 0.5 ⇒ 0.875
    expect(half.kind === 'rect-wipe' && half.width).toBeCloseTo(20 * 0.875, 9);
  });

  it('填充圆走 fill：不截断、只渐显', () => {
    const filled = resolveSonnetStaggeredDraw(filledCircle, { index: 0, progress: 1 });
    expect(filled.kind).toBe('fill');
    expect(filled.kind === 'fill' && filled.alpha).toBeCloseTo(0.8, 9);
    /*
     * ⚠ 第 489 轮修：这里原来直接写 `early.alpha` ✗ ⇒ TS2339（联合类型里 `hidden` 没有 `alpha` ✓）
     * ⇒ 统一改成 `x.kind === 'fill' && x.alpha` 的**收窄写法** ✓（教训：联合类型上取属性必须先收窄 ✓）。
     */
    // 前半个窗口就把 alpha 拉满 ⇒ progress 0.16（localRaw 0.5）时已是 0.8 ✓
    const early = resolveSonnetStaggeredDraw(filledCircle, { index: 0, progress: 0.16 });
    expect(early.kind).toBe('fill');
    expect(early.kind === 'fill' && early.alpha).toBeCloseTo(0.8, 9);
    // 刚露头时（localRaw 0.25）alpha = (1 − 0.5³) = 0.875 × 0.8 ✓
    const barely = resolveSonnetStaggeredDraw(filledCircle, { index: 0, progress: 0.08 });
    expect(barely.kind).toBe('fill');
    expect(barely.kind === 'fill' && barely.alpha).toBeCloseTo(0.8 * (1 - 0.5 ** 3), 9);
  });

  it('多边形：闭合 ⇒ 画满时 3 段、开口 ⇒ 2 段', () => {
    const closed = resolveSonnetStaggeredDraw(triangle(true), { index: 0, progress: 1 });
    expect(closed.kind === 'stroke' && closed.parts).toHaveLength(3);
    const open = resolveSonnetStaggeredDraw(triangle(false), { index: 0, progress: 1 });
    expect(open.kind === 'stroke' && open.parts).toHaveLength(2);
  });

  it('alpha 随进度单调不减（同一索引）', () => {
    let previous = -1;
    for (const progress of [0.05, 0.1, 0.2, 0.4, 0.7, 1]) {
      const item: SonnetStaggeredDraw = resolveSonnetStaggeredDraw(line(), { index: 3, progress });
      const alpha = item.kind === 'hidden' ? 0 : item.kind === 'stroke' ? item.alpha : 0;
      expect(alpha).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = alpha;
    }
    expect(previous).toBeCloseTo(0.5, 9); // 最终回到图元自带 alpha ✓
  });

  it('高序号命令在 progress = 1 也能走完（staggerSpan 被压过之后）', () => {
    for (let index = 0; index < 40; index += 1) {
      const item = resolveSonnetStaggeredDraw(line(), { index, progress: 1 });
      expect(item.kind).not.toBe('hidden');
      if (item.kind === 'stroke') {
        const part = item.parts[item.parts.length - 1]!;
        expect(part.kind === 'line' && part.x2).toBeCloseTo(10, 6);
      }
    }
  });
});
