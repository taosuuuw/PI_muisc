/**
 * 商籁引导线（`sonnetGuides.ts`）的用例（第 342 轮补）。
 *
 * 期望值**全部手算**；凡是"随机"的地方，因为我们改成了 `sonnetHash01` 确定性取值，
 * 所以这里只断言**结构性事实**（个数、区间、确定性），**不钉具体随机值** ——
 * 钉了就会在换盐或换种子时假红，而那种红没有信息量。
 */

import { describe, expect, it } from 'vitest';
import {
  resolveSonnetGuideBurst,
  resolveSonnetGuideCue,
  resolveSonnetGuideDrawProgress,
  resolveSonnetGuideFade,
  resolveSonnetGuideFrames,
  resolveSonnetGuideIntensity,
  resolveSonnetGuideMaxAlpha,
  resolveSonnetGuidePlan,
  resolveSonnetGuideStroke,
  type SonnetGuidePlacement,
} from './sonnetGuides';

const HERO: SonnetGuidePlacement = { enterX: 0, enterY: 0, timingPhase: 0.25, emphasis: true };
const SUPPORT: SonnetGuidePlacement = { enterX: 0, enterY: 0, timingPhase: 0.75, emphasis: false };

describe('引导线时机（上游 resolveSonnetGuideCue）', () => {
  it('lead = clamp(0.18 + 段时长 × 0.1, 0.2, 0.38)，窗口收在文字起点 + 0.65', () => {
    // span 2 ⇒ 0.18 + 0.2 = 0.38（正好等于上限）。
    expect(resolveSonnetGuideCue(0, 2, 5)).toEqual({ startTime: 5 - 0.38, endTime: 5.65 });
    // span 0.1 ⇒ 0.19 ⇒ 被下限抬到 0.2。
    expect(resolveSonnetGuideCue(0, 0.1, 0)).toEqual({ startTime: -0.2, endTime: 0.65 });
    // 超长段 ⇒ 被上限压到 0.38。
    expect(resolveSonnetGuideCue(0, 100, 0)).toEqual({ startTime: -0.38, endTime: 0.65 });
    // 缺省 textStartTime = 段起点。
    expect(resolveSonnetGuideCue(3, 4).endTime).toBeCloseTo(3.65, 6);
  });
});

describe('引导线包络（四个纯函数）', () => {
  it('drawProgress = clamp(p / 0.35)', () => {
    expect(resolveSonnetGuideDrawProgress(0)).toBe(0);
    expect(resolveSonnetGuideDrawProgress(0.175)).toBeCloseTo(0.5, 6);
    expect(resolveSonnetGuideDrawProgress(0.35)).toBeCloseTo(1, 6);
    expect(resolveSonnetGuideDrawProgress(9)).toBe(1);
  });

  it('fade = 1 − clamp((p − 0.4) / 0.3)：0.4 处刚到 1、0.7 处到底 0', () => {
    expect(resolveSonnetGuideFade(0.4)).toBeCloseTo(1, 6);
    expect(resolveSonnetGuideFade(0.55)).toBeCloseTo(0.5, 6);
    expect(resolveSonnetGuideFade(0.7)).toBeCloseTo(0, 6);
    expect(resolveSonnetGuideFade(1)).toBeCloseTo(0, 6);
  });

  it('burst = clamp((p − 0.3) / 0.7)', () => {
    expect(resolveSonnetGuideBurst(0.3)).toBe(0);
    expect(resolveSonnetGuideBurst(0.65)).toBeCloseTo(0.5, 6);
    expect(resolveSonnetGuideBurst(1)).toBeCloseTo(1, 6);
  });

  it('intensity = (i / steps)²（越靠头部越亮）', () => {
    expect(resolveSonnetGuideIntensity(0, 20)).toBe(0);
    expect(resolveSonnetGuideIntensity(10, 20)).toBeCloseTo(0.25, 6);
    expect(resolveSonnetGuideIntensity(20, 20)).toBeCloseTo(1, 6);
    // steps 为 0 时不除零。
    expect(resolveSonnetGuideIntensity(3, 0)).toBe(0);
  });

  it('主笔描边与整体上限：主角 1.8 / 0.82 / 0.95，其他 1 / 0.55 / 0.7', () => {
    expect(resolveSonnetGuideStroke(true)).toEqual({ width: 1.8, alpha: 0.82 });
    expect(resolveSonnetGuideStroke(false)).toEqual({ width: 1, alpha: 0.55 });
    expect(resolveSonnetGuideMaxAlpha(true)).toBe(0.95);
    expect(resolveSonnetGuideMaxAlpha(false)).toBe(0.7);
  });
});

describe('引导线图元清单（确定性版本）', () => {
  it('起点退路：没有入场矢量时按 timingPhase 定符号，横 1.8×字号、纵 −0.9×字号', () => {
    const early = resolveSonnetGuidePlan(11, HERO, 100);
    // timingPhase 0.25 < 0.5 ⇒ 反向。
    expect(early.startX).toBeCloseTo(-180, 6);
    expect(early.startY).toBeCloseTo(-90, 6);
    const late = resolveSonnetGuidePlan(11, SUPPORT, 100);
    expect(late.startX).toBeCloseTo(180, 6);
    // 给了入场矢量就用它。
    const given = resolveSonnetGuidePlan(11, { ...HERO, enterX: 7, enterY: -3 }, 100);
    expect(given.startX).toBe(7);
    expect(given.startY).toBe(-3);
  });

  it('贝塞尔控制点 = (sx×0.6, sy×0.4) 与 (sx×0.2, sy×0.1)，终点恒为原点', () => {
    const plan = resolveSonnetGuidePlan(11, HERO, 100);
    expect(plan.curve[0]).toEqual({ x: plan.startX, y: plan.startY });
    expect(plan.curve[1].x).toBeCloseTo(plan.startX * 0.6, 6);
    expect(plan.curve[1].y).toBeCloseTo(plan.startY * 0.4, 6);
    expect(plan.curve[2].x).toBeCloseTo(plan.startX * 0.2, 6);
    expect(plan.curve[2].y).toBeCloseTo(plan.startY * 0.1, 6);
  });

  it('碎屑个数与丝线条数：主角 6 个 + 必有 2 条；其他 3 个 + 至多 2 条', () => {
    const hero = resolveSonnetGuidePlan(7, HERO, 100);
    expect(hero.shapes).toHaveLength(6);
    expect(hero.threads).toHaveLength(2);
    expect(hero.maxAlpha).toBe(0.95);
    expect(hero.strokeWidth).toBe(1.8);

    const support = resolveSonnetGuidePlan(7, SUPPORT, 100);
    expect(support.shapes).toHaveLength(3);
    expect(support.threads.length).toBeLessThanOrEqual(2);
    expect(support.maxAlpha).toBe(0.7);
    expect(support.strokeWidth).toBe(1);
  });

  it('碎屑的数值区间照抄上游（尺寸/速度/转速/角度/种类都在范围内）', () => {
    const plan = resolveSonnetGuidePlan(23, HERO, 100);
    for (const shape of plan.shapes) {
      expect(shape.size).toBeGreaterThanOrEqual(3);
      expect(shape.size).toBeLessThanOrEqual(6.5); // 3 + 1×3.5
      expect(shape.speed).toBeGreaterThanOrEqual(15);
      expect(shape.speed).toBeLessThanOrEqual(60); // (15 + 45) × 1
      expect(shape.rotationSpeed).toBeGreaterThanOrEqual(-4);
      expect(shape.rotationSpeed).toBeLessThanOrEqual(4);
      expect(shape.angle).toBeGreaterThanOrEqual(0);
      expect(shape.angle).toBeLessThanOrEqual(Math.PI * 2);
      expect(['circle', 'rect', 'cross', 'diamond']).toContain(shape.kind);
    }
  });

  it('同种子 ⇒ 完全一致；换种子 ⇒ 清单会变（确定性 + 有效随机）', () => {
    const a = resolveSonnetGuidePlan(99, HERO, 100);
    const b = resolveSonnetGuidePlan(99, HERO, 100);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = resolveSonnetGuidePlan(100, HERO, 100);
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });
});

describe('帧层桥接（当前该画哪些引导线）', () => {
  /** 段：2 秒长、文字起点 5；行：0~10 秒。⇒ 引导线窗口 [4.62, 5.65]。 */
  const SEGMENT = {
    segmentStartTime: 3,
    segmentEndTime: 5,
    textStartTime: 5,
    lineStartTime: 0,
    lineEndTime: 10,
    enterX: 0,
    enterY: 0,
    emphasis: true,
  } as const;

  it('窗口外没有、窗口内有；进度按整个窗口归一（中点 = 0.5）', () => {
    expect(resolveSonnetGuideFrames(1, [SEGMENT], 100, 4.5)).toHaveLength(0);
    expect(resolveSonnetGuideFrames(1, [SEGMENT], 100, 5.8)).toHaveLength(0);
    // 窗口 [4.62, 5.65]，跨度 1.03 ⇒ 中点 5.135 ⇒ progress = 0.5。
    const middle = resolveSonnetGuideFrames(1, [SEGMENT], 100, 5.135);
    expect(middle).toHaveLength(1);
    expect(middle[0]?.progress).toBeCloseTo(0.5, 6);
    // 起点就是 0。
    expect(resolveSonnetGuideFrames(1, [SEGMENT], 100, 4.62)[0]?.progress).toBe(0);
  });

  it('时序相位取"段起点在行内的相对位置"，决定入场方向', () => {
    // (3 − 0) / 10 = 0.3 < 0.5 ⇒ 反向 ⇒ startX = −1.8 × 字号。
    const early = resolveSonnetGuideFrames(1, [SEGMENT], 100, 5.0);
    expect(early[0]?.plan.startX).toBeCloseTo(-180, 6);
    // 把段挪到行后半（起点 8）⇒ 相位 0.8 > 0.5 ⇒ 正向。
    const late = resolveSonnetGuideFrames(
      1,
      [{ ...SEGMENT, segmentStartTime: 8, textStartTime: 8 }],
      100,
      8,
    );
    expect(late[0]?.plan.startX).toBeCloseTo(180, 6);
  });

  it('多段同时命中时按段下标各自成帧，且每段种子互不相同（装饰不撞拍）', () => {
    const second = { ...SEGMENT, segmentStartTime: 3.4, textStartTime: 5, emphasis: false };
    const frames = resolveSonnetGuideFrames(5, [SEGMENT, second], 100, 5.1);
    expect(frames.map((frame) => frame.index)).toEqual([0, 1]);
    // 非主角那一段按 SUPPORT 的规则（3 个碎屑、上限 0.7）。
    expect(frames[1]?.plan.shapes).toHaveLength(3);
    expect(frames[1]?.plan.maxAlpha).toBe(0.7);
  });
});
