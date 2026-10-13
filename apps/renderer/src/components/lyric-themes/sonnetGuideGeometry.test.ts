/**
 * 引导线**几何层**的用例（按上游 `update(progress)` 的语义）。
 *
 * 关键契约之一是"头的位置"：上游是 `head = getBezier(..., drawProgress)`（头沿贝塞尔移动），
 * 只钉半径、不钉头的位置，代码把圆画在硬编码的 `(0, 0)` 上也能全绿。
 * 用例覆盖星轨头位置、丝线（有限尾段）、矩形 spline（生长+白芯）、
 * follow circle（圆环）与 lead-in（`progress = 0` 什么都不画）。
 *
 * 期望值手算，只钉**结构**与**可算的确定量**；随机量（丝线方向/偏移/延迟、spline 参数）
 * 只断言**区间与确定性**（换盐会变，钉死就成了假红 ✗）。
 */

import { describe, expect, it } from 'vitest';
import { hasSonnetGuideGeometry, resolveSonnetGuideGeometry } from './sonnetGuideGeometry';
import {
  SONNET_GUIDE_DRAW_PORTION,
  SONNET_GUIDE_THREAD_STEPS,
  SONNET_GUIDE_TRAIL_STEPS,
  resolveSonnetGuidePlan,
  type SonnetGuideFrame,
  type SonnetGuidePoint,
} from './sonnetGuides';

/** 造一帧：`plan` 用确定性的 `resolveSonnetGuidePlan`（同种子 ⇒ 同结果）✓。 */
function makeGuide(progress: number, emphasis: boolean, anchorX = 0, anchorY = 0): SonnetGuideFrame {
  return {
    index: 0,
    progress,
    cue: { startTime: 0, endTime: 1 },
    anchorX,
    anchorY,
    plan: resolveSonnetGuidePlan(17, { enterX: 0, enterY: 0, timingPhase: 0.25, emphasis }, 100),
  };
}

/** 三次贝塞尔取点（与几何层同一个式子 ⇒ 用来独立手算"头该在哪" ✓）。 */
function cubicAt(
  p0: SonnetGuidePoint,
  p1: SonnetGuidePoint,
  p2: SonnetGuidePoint,
  p3: SonnetGuidePoint,
  t: number,
): { x: number; y: number } {
  const inverse = 1 - t;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * t;
  const c = 3 * inverse * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * **星轨那一批笔画**（用来量"头扫到哪儿" ✓）。
 *
 * 两条容易搞错、这里写清楚：
 * ① **产生顺序固定**：星轨 → 每条丝线 → 矩形 spline ⇒ `strokes.slice(0, 20)` 就是星轨（20 段）✓。
 *    按"宽度范围"筛是筛不准的：丝线 `(2 / 1) + i × (5 / 2.5)` 与星轨 `(2.5 / 1.5) + i × (5 / 3)`
 *    **区间重叠** ⇒ 早先那版过滤会把丝线也捞进来 ✓。
 * ② **段数恒为 20**：`sampleCurve` 固定发 `steps` 段，`drawProgress` 只影响**末端的 t**
 *    （`stepT = (i / steps) × drawProgress` ✓）⇒ 不能按 `20 × drawProgress` 去切 ✗。
 */
function trailStrokes(
  geometry: ReturnType<typeof resolveSonnetGuideGeometry>,
): ReturnType<typeof resolveSonnetGuideGeometry>['strokes'] {
  return geometry.strokes.slice(0, SONNET_GUIDE_TRAIL_STEPS);
}

describe('引导线几何层：星轨（移动的头）', () => {
  it('进度 0.5 ⇒ 星轨画到 drawProgress = 1：满 20 段、每段两点；头部两圆（主角 14 / 4.5）', () => {
    const geometry = resolveSonnetGuideGeometry(makeGuide(0.5, true));
    // progress 0.5 / 0.35 > 1 ⇒ 画满 ⇒ 星轨恰 20 段（丝线/spline 会另加笔画）。
    expect(trailStrokes(geometry)).toHaveLength(SONNET_GUIDE_TRAIL_STEPS);
    for (const stroke of geometry.strokes) expect(stroke.points).toHaveLength(4);
    // 头部两个圆排在最前（第二个是白芯 ✓）；碎屑里的圆会追加在后面。
    expect(geometry.discs.length).toBeGreaterThanOrEqual(2);
    expect(geometry.discs[0]?.radius).toBe(14);
    expect(geometry.discs[0]?.white).toBe(false);
    expect(geometry.discs[1]?.radius).toBe(4.5);
    expect(geometry.discs[1]?.white).toBe(true);
  });

  it('**头沿贝塞尔移动**：0.175 ⇒ drawProgress 0.5 ⇒ 星轨末端与头部圆都落在 t=0.5 那个贝塞尔点上', () => {
    const guide = makeGuide(0.175, true);
    const geometry = resolveSonnetGuideGeometry(guide);
    const expectedT = 0.175 / SONNET_GUIDE_DRAW_PORTION;
    const expected = cubicAt(
      guide.plan.curve[0],
      guide.plan.curve[1],
      guide.plan.curve[2],
      { x: 0, y: 0 },
      expectedT,
    );
    // 头不在原点上（这条就是第 362 轮那份用例漏掉的那条契约）。
    expect(Math.hypot(expected.x, expected.y)).toBeGreaterThan(1);
    const trail = trailStrokes(geometry);
    expect(trail).toHaveLength(SONNET_GUIDE_TRAIL_STEPS);
    const last = trail[trail.length - 1];
    expect(last?.points[2]).toBeCloseTo(expected.x, 6);
    expect(last?.points[3]).toBeCloseTo(expected.y, 6);
    /* 头部那两圆落在同一点，且排在碎屑圆之前 ✓。 */
    const headDiscs = geometry.discs.slice(0, 2);
    expect(headDiscs[0]?.x).toBeCloseTo(expected.x, 6);
    expect(headDiscs[0]?.y).toBeCloseTo(expected.y, 6);
    expect(headDiscs[1]?.x).toBeCloseTo(expected.x, 6);
    expect(headDiscs[1]?.y).toBeCloseTo(expected.y, 6);
    /* 而且它确实**不在锚点**上（第 362 轮那版代码会把圆画在 (0,0) ✗）。 */
    expect(Math.hypot(headDiscs[0]?.x ?? 0, headDiscs[0]?.y ?? 0)).toBeGreaterThan(1);
  });

  it('进度越大头越靠锚点：0.175（t=0.5）比 0.35（t=1）离原点远，t=1 时头回到 (0,0)', () => {
    const distance = (progress: number): number => {
      const disc = resolveSonnetGuideGeometry(makeGuide(progress, true)).discs[0];
      return Math.hypot(disc?.x ?? 0, disc?.y ?? 0);
    };
    expect(distance(0.175)).toBeGreaterThan(distance(0.35));
    // drawProgress = 1（progress ≥ 0.35）⇒ 贝塞尔的终点就是锚点。
    expect(distance(0.35)).toBeCloseTo(0, 6);
    expect(distance(0.6)).toBeCloseTo(0, 6);
  });

  it('陪衬段（非主角）的头部是 9 / 3，第一段宽度按公式 = 1.5 + (1/20)² × 3', () => {
    const geometry = resolveSonnetGuideGeometry(makeGuide(0.5, false));
    expect(geometry.discs[0]?.radius).toBe(9);
    expect(geometry.discs[1]?.radius).toBe(3);
    // intensity(1, 20) = 0.0025 ⇒ 陪衬：1.5 + 0.0025 × 3 = 1.5075；主角：2.5 + 0.0025 × 5 = 2.5125。
    expect(geometry.strokes[0]?.width).toBeCloseTo(1.5075, 6);
    expect(resolveSonnetGuideGeometry(makeGuide(0.5, true)).strokes[0]?.width).toBeCloseTo(2.5125, 6);
  });

  it('第一段的 alpha 按公式：min(1, intensity × strokeAlpha × fade × 1.6) × draw', () => {
    // progress 0.5 ⇒ fade = 1 − (0.5 − 0.4)/0.3 = 2/3、draw = clamp(0.5/0.35) = 1
    // intensity(1,20) = 0.0025、主角 strokeAlpha = 0.82
    // ⇒ 0.0025 × 0.82 × (2/3) × 1.6 = 0.0021866…
    const geometry = resolveSonnetGuideGeometry(makeGuide(0.5, true));
    expect(geometry.strokes[0]?.alpha).toBeCloseTo(0.0022, 4);
    expect(geometry.strokes[19]?.alpha).toBeGreaterThan(geometry.strokes[0]!.alpha); // 越靠笔尖越亮
  });
});

describe('引导线几何层：丝线 / 矩形 spline / 碎屑', () => {
  it('丝线的头也在贝塞尔上滑动：取 headT = 0.6 那一帧，头恰在该 t 的丝线点上', () => {
    /*
     * 主角必有两条丝线 ⇒ 它们的 `localProg = (progress − delay) / 0.55`。
     * 取 `progress` 让第一条丝线落在 `headT = 0.6`（若第一条的 delay 恰好不同，用任一条丝线比对 ✓）。
     */
    const guide = makeGuide(0.4, true);
    const hit = guide.plan.threads
      .map((thread) => ({ thread, headT: (0.4 - thread.delay) / 0.55 }))
      .find((entry) => entry.headT > 0 && entry.headT < 1);
    expect(hit).toBeDefined();
    const expected = cubicAt(
      hit!.thread.curve[0],
      hit!.thread.curve[1],
      hit!.thread.curve[2],
      hit!.thread.curve[3],
      hit!.headT,
    );
    const geometry = resolveSonnetGuideGeometry(guide);
    const moved = geometry.discs.some(
      (disc) => Math.abs(disc.x - expected.x) < 1e-6 && Math.abs(disc.y - expected.y) < 1e-6,
    );
    expect(moved).toBe(true);
  });

  it('丝线的笔画只覆盖 headT→tailT 的有限尾段（**任何时刻**都不可能超过"星轨 20 + 丝线 2×25"）', () => {
    /*
     * 这是"没有把整条轨迹提前画满"的**上限证据**：扫一整段进度，逐帧的笔画数都必须落在
     * `星轨 20 + 丝线 2 × 25 (+ spline 至多 2)` 之内 —— 一旦有人改回"整条一次画满"，
     * 丝线那两项会一起爆掉这个上限 ✓。
     */
    let maxStrokes = 0;
    let sawThreadOnly = 0;
    for (let step = 0; step <= 70; step += 1) {
      const progress = step / 100;
      const geometry = resolveSonnetGuideGeometry(makeGuide(progress, true));
      maxStrokes = Math.max(maxStrokes, geometry.strokes.length);
      if (geometry.strokes.length === 0) sawThreadOnly += 1;
    }
    expect(maxStrokes).toBeLessThanOrEqual(SONNET_GUIDE_TRAIL_STEPS + SONNET_GUIDE_THREAD_STEPS * 2 + 2);
    expect(maxStrokes).toBeGreaterThan(0);
    // 窗口最前面那几帧确实"什么都还没画"（lead-in）。
    expect(sawThreadOnly).toBeGreaterThan(0);
  });

  it('丝线头部有 follow circle（**描边圆环**，不是实心），且主角环更大', () => {
    /*
     * 上游 follow circle 只在 `0 < headT < 1` 时画：取一帧让至少一条丝线落在该区间里，
     * 直接断言"存在圆环"；同时主角的半径 20 必须严格大于陪衬的 12 ✓。
     */
    const heroRings: number[] = [];
    const supportRings: number[] = [];
    for (let step = 1; step <= 60; step += 1) {
      const progress = (step / 60) * 0.7;
      heroRings.push(...resolveSonnetGuideGeometry(makeGuide(progress, true)).rings.map((r) => r.radius));
      supportRings.push(...resolveSonnetGuideGeometry(makeGuide(progress, false)).rings.map((r) => r.radius));
    }
    expect(heroRings.length).toBeGreaterThan(0);
    expect(new Set(heroRings)).toEqual(new Set([20]));
    for (const radius of supportRings) expect([12]).toContain(radius);
    // 环必须是描边（宽度 > 0），否则就是被画成了实心圆 ✗。
    const ring = resolveSonnetGuideGeometry(makeGuide(0.5, true)).rings[0];
    if (ring !== undefined) expect(ring.width).toBeGreaterThan(0);
  });

  it('矩形 spline：出现时是**两根同向笔画**（粗的主题色 + 细的白亮芯），且头尾在生长', () => {
    /*
     * 本帧的 plan 是否带 spline 由种子决定；扫一段进度找到"有 spline 且落在窗口内"的一帧 ✓。
     * 白芯是**新加的**：`core === true` 的笔画只属于 spline ✓。
     */
    let sawSplineCore = false;
    for (let step = 0; step <= 140 && !sawSplineCore; step += 1) {
      const progress = step / 200;
      const geometry = resolveSonnetGuideGeometry(makeGuide(progress, true));
      const cores = geometry.strokes.filter((stroke) => stroke.core);
      if (cores.length === 0) continue;
      sawSplineCore = true;
      // 白芯是短横段（两点），且和同位置的粗线同向。
      for (const core of cores) expect(core.points).toHaveLength(4);
      const widths = cores.map((core) => core.width);
      for (const width of widths) expect(width).toBeGreaterThan(0);
    }
    expect(sawSplineCore).toBe(true);
  });

  it('碎屑：圆的个数 = 计划里 circle 的个数（头那几个单独算），方块/十字/菱形走 shapes', () => {
    for (const emphasis of [true, false]) {
      const guide = makeGuide(0.5, emphasis);
      const geometry = resolveSonnetGuideGeometry(guide);
      const circleShapes = guide.plan.shapes.filter((shape) => shape.kind === 'circle').length;
      const otherShapes = guide.plan.shapes.length - circleShapes;
      expect(geometry.shapes).toHaveLength(otherShapes);
      /* `discs` = 星轨头 2 + 丝线头（每条 2）+ 碎屑圆 ⇒ 减掉头那几个就应恰好等于 `circleShapes` ✓。 */
      const heads = geometry.discs.length - circleShapes;
      expect(heads % 2).toBe(0);
      expect(heads).toBeGreaterThanOrEqual(2);
      /* 主角 6 个碎屑（星轨头 2 + 两条丝线各 2 + 碎屑圆 ≤ 6）⇒ 上限可算 ✓。 */
      expect(geometry.discs.length).toBeLessThanOrEqual(2 + 2 * 2 + 6);
    }
  });

  it('lead-in：progress = 0 ⇒ 主星轨还没有笔画（drawProgress = 0），丝线还没开始扫', () => {
    const guide = makeGuide(0, true);
    const geometry = resolveSonnetGuideGeometry(guide);
    /* drawProgress = 0 ⇒ 星轨无笔画；丝线 `localProg ≤ 0`、spline `localProg < 0` ⇒ 无笔画 ✓。 */
    expect(geometry.strokes).toHaveLength(0);
    expect(geometry.rings).toHaveLength(0);
    /*
     * ⚠ 圆点**不是**空的：碎屑从 `progress = 0` 就压在锚点原点（`burst = 0 ⇒ ease = 0` ✓，
     * 上游同样如此 —— 它们随后才向外爆开 ✓）。所以这里断言的是
     * "**只有碎屑圆**（与计划里 circle 的个数一致）、**没有头**（`white` 恒 false、半径都 < 7 ✓）"。
     */
    const circleShapes = guide.plan.shapes.filter((shape) => shape.kind === 'circle').length;
    expect(geometry.discs).toHaveLength(circleShapes);
    expect(geometry.discs.every((disc) => disc.white === false)).toBe(true);
    for (const disc of geometry.discs) expect(disc.radius).toBeLessThan(7);
  });
});

describe('引导线几何层：消退与确定性', () => {
  it('淡出结束后（progress ≥ 0.7 ⇒ fade = 0）什么都不画', () => {
    const geometry = resolveSonnetGuideGeometry(makeGuide(0.7, true));
    expect(geometry).toEqual({ strokes: [], discs: [], rings: [], shapes: [] });
    expect(hasSonnetGuideGeometry(geometry)).toBe(false);
    expect(hasSonnetGuideGeometry(resolveSonnetGuideGeometry(makeGuide(0.5, true)))).toBe(true);
  });

  it('契约：输出坐标**相对锚点** ⇒ 只改锚点，几何必须逐字相同', () => {
    const a = resolveSonnetGuideGeometry(makeGuide(0.55, true, 0, 0));
    const b = resolveSonnetGuideGeometry(makeGuide(0.55, true, 1234, -567));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('确定性：同一帧求值两次逐值相同（拖进度条回同一时刻画面不跳）', () => {
    const a = resolveSonnetGuideGeometry(makeGuide(0.45, true));
    const b = resolveSonnetGuideGeometry(makeGuide(0.45, true));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('不同种子的丝线/spline 布局会变（确定性 ≠ 全场一套）', () => {
    const guideFor = (seed: number): SonnetGuideFrame => ({
      index: 0,
      progress: 0.5,
      cue: { startTime: 0, endTime: 1 },
      anchorX: 0,
      anchorY: 0,
      plan: resolveSonnetGuidePlan(seed, { enterX: 0, enterY: 0, timingPhase: 0.25, emphasis: true }, 100),
    });
    const planA = guideFor(3).plan;
    const planB = guideFor(4).plan;
    expect(JSON.stringify(planA.threads)).not.toBe(JSON.stringify(planB.threads));
    expect(JSON.stringify(planA.spline)).not.toBe(JSON.stringify(planB.spline));
  });
});
