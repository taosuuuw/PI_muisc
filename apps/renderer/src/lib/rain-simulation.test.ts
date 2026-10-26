import { describe, expect, it } from 'vitest';
import {
  buildRainLayout,
  rainSizeScale,
  type RainBead,
  type RainDynamicCycle,
  type RainDynamicDrop,
  type RainLayout,
  type RainShape,
} from './rain-layout';
import {
  createRainSimulation,
  dynamicTrailLengthForCycle,
  dynamicTrailLengthPx,
  MAX_RESIDUAL_TRAILS,
  MAX_TRAIL_POINTS,
  mergeDirtyRects,
  RAIN_FIXED_STEP,
  snapshotRainReplay,
  stageControlledMergeReplay,
  stepRainSimulation,
  summarizeSimulation,
  takeDirtyRects,
  type RainSimulationState,
  type RainViewport,
} from './rain-simulation';

const VIEWPORT: RainViewport = { width: 1200, height: 900 };

const SHAPE: RainShape = {
  squash: 1,
  tiltDeg: 0,
  wobble: 0.04,
  wobblePhase: 0,
};

function cycle(overrides: Partial<RainDynamicCycle> = {}): RainDynamicCycle {
  return {
    startLeftPercent: 20,
    startTopPercent: 10,
    baseSizePx: 20,
    attachSeconds: 0.2,
    initialAttachSeconds: 0.19,
    band: [1, 34],
    driftPercent: 0,
    wobblePercent: 0,
    wobbleWaves: 1,
    wobblePhase: 0,
    pauses: [],
    gravity: 300,
    drag: 0,
    releaseSpeed: 2,
    maxSpeed: 1000,
    trailLengthPx: 80,
    trailFadeSeconds: 2,
    shape: SHAPE,
    ...overrides,
  };
}

function drop(id: number, cycles: RainDynamicCycle[], respawnSeconds = 2): RainDynamicDrop {
  return { id, cycles, respawnSeconds };
}

function layout(
  dynamicDrops: RainDynamicDrop[],
  beads: RainBead[] = [],
  lenses: RainLayout['lenses'] = [],
): RainLayout {
  return { beads, trails: [], dynamicDrops, lenses };
}

function bead(id: number, left: number, top: number, sizePx = 4): RainBead {
  return {
    id,
    leftPercent: left,
    topPercent: top,
    sizePx,
    opacity: 0.5,
    shape: SHAPE,
    mergeable: true,
  };
}

function advance(sim: RainSimulationState, seconds: number): void {
  const steps = Math.max(1, Math.round(seconds / RAIN_FIXED_STEP));
  for (let index = 0; index < steps; index += 1) stepRainSimulation(sim, RAIN_FIXED_STEP);
}

function advanceUntil(sim: RainSimulationState, predicate: () => boolean, maxSeconds = 8): boolean {
  const maxSteps = Math.round(maxSeconds / RAIN_FIXED_STEP);
  for (let index = 0; index < maxSteps; index += 1) {
    stepRainSimulation(sim, RAIN_FIXED_STEP);
    if (predicate()) return true;
  }
  return false;
}

describe('rain-simulation 动态水珠', () => {
  it('同一场仿真在相同时间步下完全确定', () => {
    const rain = buildRainLayout(7);
    const first = createRainSimulation(rain, VIEWPORT, 0);
    const second = createRainSimulation(rain, VIEWPORT, 0);
    advance(first, 2.4);
    advance(second, 2.4);
    expect(summarizeSimulation(first)).toEqual(summarizeSimulation(second));
    expect(first.drops.map((d) => [d.x, d.y, d.radius, d.phase])).toEqual(
      second.drops.map((d) => [d.x, d.y, d.radius, d.phase]),
    );
  });

  it('预热后所有水珠都在一个明确状态里，数量不丢', () => {
    const rain = buildRainLayout(42);
    const sim = createRainSimulation(rain, VIEWPORT);
    const summary = summarizeSimulation(sim);
    expect(summary.attached + summary.sliding + summary.paused + summary.finished).toBe(
      rain.dynamicDrops.length,
    );
    expect(summary.time).toBeGreaterThan(3);
  });

  it('释放后重力加速，速度单调变快（不是匀速）', () => {
    const sim = createRainSimulation(layout([drop(0, [cycle()])]), VIEWPORT, 0);
    advanceUntil(sim, () => sim.drops[0]?.phase === 'sliding');
    const dropState = sim.drops[0];
    expect(dropState?.phase).toBe('sliding');
    const firstSpeed = dropState?.speed ?? 0;
    advance(sim, 0.3);
    const secondSpeed = sim.drops[0]?.speed ?? 0;
    expect(secondSpeed).toBeGreaterThan(firstSpeed);
  });

  it('遇到钉点会停住，停够时间再继续滑', () => {
    const sim = createRainSimulation(
      layout([
        drop(0, [
          cycle({
            pauses: [{ at: 0.08, seconds: 0.45 }],
            gravity: 500,
            releaseSpeed: 6,
          }),
        ]),
      ]),
      VIEWPORT,
      0,
    );
    expect(advanceUntil(sim, () => sim.drops[0]?.phase === 'paused')).toBe(true);
    const paused = sim.drops[0];
    expect(paused?.speed).toBe(0);
    expect(paused?.phaseTime).toBeLessThan(0.45);
    // 停顿期间湿痕不再长出新点（旧点可能因年龄被回收，但不会增加）。
    const trailLength = paused?.trail.length ?? 0;
    advance(sim, 0.2);
    expect(sim.drops[0]?.trail.length ?? 0).toBeLessThanOrEqual(trailLength);
    advance(sim, 0.4);
    expect(sim.drops[0]?.phase).toBe('sliding');
  });

  it('积聚/滑落时会吸走可合并的小珠，半径变大', () => {
    const sim = createRainSimulation(
      layout(
        [drop(0, [cycle({ attachSeconds: 1, initialAttachSeconds: 0.5 })])],
        [bead(0, 20.3, 10.1, 5)],
      ),
      VIEWPORT,
      0,
    );
    const initialRadius = sim.drops[0]?.radius ?? 0;
    advance(sim, 0.5);
    expect(sim.consumedBeads.has(0)).toBe(true);
    expect(sim.drops[0]?.radius ?? 0).toBeGreaterThan(initialRadius);
    expect(sim.merges).toBeGreaterThan(0);
    expect(takeDirtyRects(sim).length).toBeGreaterThan(0);
  });

  it('两颗滑动水珠撞上时大的吸收小的，不会互相穿过去', () => {
    const sim = createRainSimulation(
      layout([
        drop(0, [cycle({ baseSizePx: 26, initialAttachSeconds: 0.19 })]),
        drop(1, [cycle({ baseSizePx: 14, initialAttachSeconds: 0.19 })]),
      ]),
      VIEWPORT,
      0,
    );
    advance(sim, 1.2);
    const finished = sim.drops.filter((item) => item.phase === 'finished');
    expect(finished.length).toBeGreaterThanOrEqual(1);
    expect(sim.merges).toBeGreaterThanOrEqual(1);
    const big = sim.drops.find((item) => item.phase !== 'finished');
    expect(big?.radius ?? 0).toBeGreaterThan(8);
  });

  it('被吞并的小滴跨多帧保持不可见，残留湿痕继续淡去，重生后才恢复', () => {
    const releaseBig = cycle({
      baseSizePx: 26,
      startTopPercent: 10,
      attachSeconds: 2,
      initialAttachSeconds: 1.9,
      gravity: 300,
    });
    // 先分开，避免测试在初始位置就反复合并；后面再手动制造一次受控相遇。
    const releaseSmall = cycle({
      baseSizePx: 14,
      startTopPercent: 60,
      attachSeconds: 2,
      initialAttachSeconds: 1.9,
      gravity: 300,
    });
    // 重生后给一个长附着期，避免测试还没断言就再次滑走。
    const nextLife = cycle({ attachSeconds: 20, initialAttachSeconds: 0.5 });
    const sim = createRainSimulation(
      layout([
        drop(0, [releaseBig, nextLife], 1.5),
        drop(1, [releaseSmall, nextLife], 1.5),
      ]),
      VIEWPORT,
      0,
    );

    // 先让两颗都进入滑行，再给被吞并的小滴补一条足够长的湿痕；
    // 太短的两点会整体落在“水滴后方间隙”里，按设计不应留下残迹。
    expect(advanceUntil(sim, () => sim.drops[1]?.phase === 'sliding')).toBe(true);
    const small = sim.drops[1];
    const big = sim.drops[0];
    expect(small).toBeDefined();
    expect(big).toBeDefined();
    if (!small || !big) return;
    // 受控相遇：两颗都已滑行，把小的放到大的可见轮廓接触处。
    small.x = big.x;
    small.y = big.y;
    small.trail = [
      { x: small.x, y: small.y - 80, age: 0, size: small.radius * 2 },
      { x: small.x, y: small.y - 40, age: 0, size: small.radius * 2 },
      { x: small.x, y: small.y, age: 0, size: small.radius * 2 },
    ];

    expect(advanceUntil(sim, () => sim.drops[1]?.absorbed === true, 2)).toBe(true);
    expect(sim.drops[1]?.phase).toBe('finished');
    expect(sim.drops[1]?.opacity).toBe(0);
    expect(sim.residualTrails.length).toBeGreaterThan(0);
    // 吞并交接也用整轮 maxSpeed 的稳定长度，不取决于交接瞬间 speed。
    expect(sim.residualTrails[0]?.maxLengthPx).toBe(
      dynamicTrailLengthForCycle(releaseSmall, VIEWPORT.height),
    );

    const residualPoints = sim.residualTrails[0]?.points.map((point) => ({
      x: point.x,
      y: point.y,
    }));

    // 跨越 60 个 tick（约 1 秒）：不能因为 finished 分支重算 opacity 又“复活”成 0.96；
    // 旧湿痕也不能跟着本体移动或重新交接。
    for (let index = 0; index < 60; index += 1) stepRainSimulation(sim, RAIN_FIXED_STEP);
    expect(sim.drops[1]?.phase).toBe('finished');
    expect(sim.residualTrails[0]?.points.map((point) => ({ x: point.x, y: point.y }))).toEqual(
      residualPoints,
    );
    expect(sim.drops[1]?.absorbed).toBe(true);
    expect(sim.drops[1]?.opacity).toBe(0);

    // 重生后换到下一轮长附着，恢复可见；吞并留下的残迹不能再来一条重复的。
    advance(sim, 0.8);
    expect(sim.drops[1]?.phase).toBe('attached');
    expect(sim.drops[1]?.absorbed).toBe(false);
    expect(sim.drops[1]?.opacity ?? 0).toBeGreaterThan(0);
    expect(sim.residualTrails).toHaveLength(1);
  });

  it('积聚中吸进来的面积跨多帧保留，释放时不会被成长公式覆盖', () => {
    const sim = createRainSimulation(
      layout(
        [
          drop(0, [
            cycle({
              baseSizePx: 20,
              attachSeconds: 3,
              initialAttachSeconds: 1.5,
              gravity: 200,
            }),
          ]),
        ],
        [bead(0, 20.4, 10.2, 14)],
      ),
      VIEWPORT,
      0,
    );
    const smallDrop = sim.drops[0];
    expect(smallDrop).toBeDefined();
    if (!smallDrop) return;

    advance(sim, 0.1);
    expect(sim.consumedBeads.has(0)).toBe(true);
    const afterAbsorb = smallDrop.radius;
    expect(afterAbsorb).toBeGreaterThan(9.4);

    // 还在附着期：自然成长公式重算后，吸收面积必须还在。
    advance(sim, 1);
    const stillAttached = smallDrop.radius;
    expect(stillAttached).toBeGreaterThanOrEqual(afterAbsorb - 0.001);
    expect(stillAttached).toBeGreaterThan(9.6);

    // 释放时切到 baseRadius 的自然半径，吸收面积同样不能丢。
    expect(advanceUntil(sim, () => smallDrop.phase === 'sliding', 5)).toBe(true);
    const atRelease = smallDrop.radius;
    expect(atRelease).toBeGreaterThanOrEqual(stillAttached - 0.001);
    expect(atRelease).toBeGreaterThan(9.8);

    advance(sim, 0.4);
    expect(smallDrop.radius).toBeGreaterThanOrEqual(atRelease - 0.001);
  });

  it('合并尺寸有上限，不会滚成整屏巨球', () => {
    const manyBeads = Array.from({ length: 12 }, (_, index) =>
      bead(index, 20.1, 10.1, 14),
    );
    const sim = createRainSimulation(
      layout(
        [
          drop(0, [
            cycle({
              baseSizePx: 20,
              attachSeconds: 2,
              initialAttachSeconds: 1,
            }),
          ]),
        ],
        manyBeads,
      ),
      VIEWPORT,
      0,
    );
    advance(sim, 0.6);
    const baseRadius = (20 * rainSizeScale(VIEWPORT.width)) / 2;
    expect(sim.drops[0]?.radius ?? 0).toBeLessThanOrEqual(baseRadius * 1.9 + 0.001);
    expect(sim.drops[0]?.radius ?? 0).toBeGreaterThan(baseRadius);
  });

  it('自然滑出立即交接：本体 opacity=0 后原轨迹仍在、跨重生不动、最后回收', () => {
    const slide = cycle({
      startTopPercent: 80,
      attachSeconds: 0.1,
      initialAttachSeconds: 0.09,
      gravity: 1200,
      maxSpeed: 1200,
      trailLengthPx: 220,
      trailFadeSeconds: 6,
    });
    const nextLife = cycle({ attachSeconds: 20, initialAttachSeconds: 0.5 });
    const sim = createRainSimulation(
      layout([drop(0, [slide, nextLife], 0.2)]),
      VIEWPORT,
      0,
    );
    expect(advanceUntil(sim, () => sim.drops[0]?.phase === 'finished')).toBe(true);

    // 关键：不是等到 respawn 才交接，而是在 finished 的同一 tick 就有固定快照。
    const body = sim.drops[0];
    expect(body?.opacity).toBe(0);
    expect(body?.trail).toHaveLength(0);
    expect(sim.residualTrails).toHaveLength(1);
    const residual = sim.residualTrails[0];
    expect(residual).toBeDefined();
    if (!residual) return;
    const fixedPoints = residual.points.map((point) => [point.x, point.y] as const);
    expect(residual.maxLengthPx).toBeGreaterThanOrEqual(180);
    // 交接长度必须和活跃绘制共用同一稳定周期上限，不能取决于交接瞬间 speed。
    expect(residual.maxLengthPx).toBe(dynamicTrailLengthForCycle(slide, VIEWPORT.height));
    expect(residual.fadeSeconds).toBeGreaterThanOrEqual(5);

    // 重生到下一轮长附着；残留仍在原坐标，不跟本体瞬移。
    advance(sim, 1.0);
    expect(sim.drops[0]?.phase).toBe('attached');
    expect(sim.residualTrails).toHaveLength(1);
    expect(sim.residualTrails[0]?.points.map((point) => [point.x, point.y] as const)).toEqual(
      fixedPoints,
    );

    // 5~8 秒后自然回收，而不是靠本体淡出。
    advance(sim, 6.2);
    expect(sim.residualTrails).toHaveLength(0);
  });

  it('轨迹长度按轮次稳定 maxSpeed/窗口落在 180~450px，活跃/残留点数长期有界', () => {
    expect(dynamicTrailLengthPx(80, 0, 900)).toBeGreaterThanOrEqual(180);
    expect(dynamicTrailLengthPx(330, 174, 900)).toBeLessThanOrEqual(450);
    expect(dynamicTrailLengthPx(330, 174, 900)).toBeGreaterThanOrEqual(400);
    expect(dynamicTrailLengthPx(180, 0, 600)).toBe(180);
    expect(dynamicTrailLengthPx(Number.NaN, Number.NaN, Number.NaN)).toBeGreaterThanOrEqual(180);
    // 稳定上限：220 base + maxSpeed 174、900 高 => (220 + 121.8) => 342。
    expect(dynamicTrailLengthForCycle({ trailLengthPx: 220, maxSpeed: 174 }, 900)).toBe(342);
    expect(dynamicTrailLengthForCycle({ trailLengthPx: 220, maxSpeed: 174 }, 900)).toBe(
      dynamicTrailLengthPx(220, 174, 900),
    );
    // 验收反馈里的具体数字：base220 / viewport772，speed174=308；速度归零仍应是 308，
    // 不能退化成 base 的 198。
    expect(dynamicTrailLengthForCycle({ trailLengthPx: 220, maxSpeed: 174 }, 772)).toBe(308);
    expect(dynamicTrailLengthForCycle({ trailLengthPx: 220, maxSpeed: 174 }, 772)).not.toBe(
      dynamicTrailLengthPx(220, 0, 772),
    );

    const sim = createRainSimulation(buildRainLayout(3), VIEWPORT, 0);
    advance(sim, 30);
    for (const drop of sim.drops) {
      expect(drop.trail.length).toBeLessThanOrEqual(MAX_TRAIL_POINTS);
    }
    expect(sim.residualTrails.length).toBeLessThanOrEqual(MAX_RESIDUAL_TRAILS);
    for (const residual of sim.residualTrails) {
      expect(residual.points.length).toBeLessThanOrEqual(MAX_TRAIL_POINTS);
      expect(residual.age).toBeLessThanOrEqual(residual.fadeSeconds);
    }
  });

  it('动态水珠始终留在各自的两侧带里，不折到歌词中心', () => {
    const rain = buildRainLayout(5);
    const sim = createRainSimulation(rain, VIEWPORT, 0);
    advance(sim, 8);
    for (const item of sim.drops) {
      const cycleDef = rain.dynamicDrops[item.index]?.cycles[item.cycleIndex];
      if (!cycleDef) continue;
      const xPercent = (item.x / VIEWPORT.width) * 100;
      expect(xPercent).toBeGreaterThanOrEqual(cycleDef.band[0] - 0.001);
      expect(xPercent).toBeLessThanOrEqual(cycleDef.band[1] + 0.001);
    }
  });

  it('脏区合并：重叠的矩形合成一个，分离的保留', () => {
    const merged = mergeDirtyRects([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
      { x: 100, y: 0, width: 5, height: 5 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ x: 0, y: 0, width: 15, height: 15 });
  });

  it('可见轮廓一接触就吸收静态珠（含大透镜珠），脏区覆盖整个大珠', () => {
    const topPercent = 10 + (16 / VIEWPORT.height) * 100;
    const lensBead = {
      ...bead(0, 20, topPercent, 20),
      mergeable: false,
    };
    const sim = createRainSimulation(
      layout(
        [drop(0, [cycle({ attachSeconds: 2, initialAttachSeconds: 1.9 })])],
        [lensBead],
        [
          {
            beadId: 0,
            leftPercent: lensBead.leftPercent,
            topPercent: lensBead.topPercent,
            sizePx: lensBead.sizePx,
            opacity: lensBead.opacity,
            shape: lensBead.shape,
            targetOffsetPx: 8,
          },
        ],
      ),
      VIEWPORT,
      0,
    );
    advance(sim, RAIN_FIXED_STEP);

    // 旧逻辑要求中心距 < 0.62*(r1+r2)，16px 会漏掉；新逻辑按可见轮廓接触就吃。
    expect(sim.consumedBeads.has(0)).toBe(true);
    expect(sim.consumedLenses.has(0)).toBe(true);
    expect(sim.lensRevision).toBe(1);
    expect(sim.drops[0]?.radius ?? 0).toBeGreaterThan(8.5);

    const cx = (lensBead.leftPercent / 100) * VIEWPORT.width;
    const cy = (lensBead.topPercent / 100) * VIEWPORT.height;
    const rects = takeDirtyRects(sim);
    expect(
      rects.some(
        (rect) =>
          rect.x <= cx - 16 &&
          rect.y <= cy - 16 &&
          rect.x + rect.width >= cx + 16 &&
          rect.y + rect.height >= cy + 16,
      ),
    ).toBe(true);
  });

  it('滑动追上附着滴：只剩一颗、继承向下运动、跨帧不缩回旧路径', () => {
    const follower = cycle({
      startTopPercent: 10,
      baseSizePx: 24,
      attachSeconds: 0.2,
      initialAttachSeconds: 0.19,
      gravity: 600,
      maxSpeed: 400,
    });
    const target = cycle({
      startTopPercent: 25,
      baseSizePx: 22,
      attachSeconds: 20,
      initialAttachSeconds: 0.1,
      gravity: 0,
      maxSpeed: 100,
    });
    const sim = createRainSimulation(
      layout([drop(0, [follower]), drop(1, [target])]),
      VIEWPORT,
      0,
    );
    expect(advanceUntil(sim, () => sim.drops[1]?.absorbed === true, 5)).toBe(true);
    expect(sim.drops[0]?.phase).toBe('sliding');
    expect(sim.drops[1]?.phase).toBe('finished');
    expect(sim.drops[1]?.opacity).toBe(0);
    expect(sim.drops.filter((drop) => drop.phase !== 'finished')).toHaveLength(1);
    const survivor = sim.drops[0];
    expect(survivor).toBeDefined();
    if (!survivor) return;
    const yAfterMerge = survivor.y;
    const radiusAfterMerge = survivor.radius;
    advance(sim, 0.4);
    expect(survivor.phase).toBe('sliding');
    expect(survivor.y).toBeGreaterThan(yAfterMerge);
    expect(survivor.radius).toBeGreaterThanOrEqual(radiusAfterMerge - 0.001);
    expect(sim.drops[1]?.phase).toBe('finished');
  });

  it('滑动追上停顿滴：停顿中的滴也被真实接触吞并', () => {
    const follower = cycle({
      startTopPercent: 10,
      baseSizePx: 24,
      attachSeconds: 0.2,
      initialAttachSeconds: 0.19,
      gravity: 600,
      maxSpeed: 400,
    });
    const pausedTarget = cycle({
      startTopPercent: 25,
      baseSizePx: 22,
      attachSeconds: 0.2,
      initialAttachSeconds: 0.19,
      gravity: 500,
      maxSpeed: 300,
      pauses: [{ at: 0.01, seconds: 5 }],
    });
    const sim = createRainSimulation(
      layout([drop(0, [follower]), drop(1, [pausedTarget])]),
      VIEWPORT,
      0,
    );
    expect(advanceUntil(sim, () => sim.drops[1]?.phase === 'paused', 2)).toBe(true);
    expect(advanceUntil(sim, () => sim.drops[1]?.absorbed === true, 5)).toBe(true);
    expect(sim.drops[0]?.phase).toBe('sliding');
    expect(sim.drops[1]?.phase).toBe('finished');
  });

  it('滑动追上更慢的滑动滴，数组顺序不影响“接触即合成”', () => {
    const fast = cycle({
      startTopPercent: 10,
      baseSizePx: 24,
      attachSeconds: 0.2,
      initialAttachSeconds: 0.19,
      gravity: 600,
      maxSpeed: 500,
    });
    const slow = cycle({
      startTopPercent: 25,
      baseSizePx: 22,
      attachSeconds: 0.2,
      initialAttachSeconds: 0.19,
      gravity: 100,
      maxSpeed: 100,
    });
    const sim = createRainSimulation(
      layout([drop(0, [fast]), drop(1, [slow])]),
      VIEWPORT,
      0,
    );
    expect(advanceUntil(sim, () => sim.drops[1]?.absorbed === true, 6)).toBe(true);
    expect(sim.drops[0]?.phase).toBe('sliding');
    expect(sim.drops[1]?.phase).toBe('finished');
  });

  it('合并速度在清被吞者之前快照：慢的大滴吃快的小滴仍继承快速度', () => {
    const slowBig = cycle({ maxSpeed: 1000 });
    const fastSmall = cycle({ maxSpeed: 1000 });
    const sim = createRainSimulation(
      layout([drop(0, [slowBig]), drop(1, [fastSmall])]),
      VIEWPORT,
      0,
    );
    const big = sim.drops[0];
    const small = sim.drops[1];
    expect(big).toBeDefined();
    expect(small).toBeDefined();
    if (!big || !small) return;

    for (const item of [big, small]) {
      item.phase = 'sliding';
      item.phaseTime = 0;
      item.absorbedArea = 0;
      item.x = 240;
      item.y = 400;
      item.opacity = 1;
      item.absorbed = false;
      item.pauseIndex = 0;
      item.trail = [];
    }
    big.baseRadius = 13;
    big.radius = 13;
    big.speed = 20;
    small.baseRadius = 8;
    small.radius = 8;
    small.speed = 300;

    advance(sim, RAIN_FIXED_STEP);
    expect(small.absorbed).toBe(true);
    expect(big.absorbed).toBe(false);
    // 若在清零 other.speed 之后再取最大速度，这里会退化成 ~23。
    expect(big.speed).toBeGreaterThanOrEqual(300);
    expect(big.speed).toBeLessThanOrEqual(1003);
  });

  it('高速跨越用扫掠检测，不会因为只看末帧而穿透', () => {
    const sim = createRainSimulation(
      layout([
        drop(0, [cycle({ startLeftPercent: 20, maxSpeed: 10000 })]),
        drop(1, [cycle({ startLeftPercent: 20, maxSpeed: 10000 })]),
      ]),
      VIEWPORT,
      0,
    );
    const fast = sim.drops[0];
    const stopped = sim.drops[1];
    expect(fast).toBeDefined();
    expect(stopped).toBeDefined();
    if (!fast || !stopped) return;

    fast.phase = 'sliding';
    fast.phaseTime = 0;
    fast.baseRadius = 10;
    fast.radius = 10;
    fast.absorbedArea = 0;
    fast.x = 240;
    fast.y = 200;
    fast.releaseX = 240;
    fast.releaseY = 200;
    fast.travelSpan = 10000;
    fast.speed = 6000;
    fast.opacity = 1;
    fast.absorbed = false;
    fast.pauseIndex = 0;
    fast.trail = [];

    stopped.phase = 'paused';
    stopped.phaseTime = 0;
    stopped.baseRadius = 10;
    stopped.radius = 10;
    stopped.absorbedArea = 0;
    stopped.x = 240;
    stopped.y = 240;
    stopped.speed = 0;
    stopped.opacity = 1;
    stopped.absorbed = false;
    stopped.pauseIndex = 0;
    stopped.trail = [];

    advance(sim, RAIN_FIXED_STEP);
    // 末帧 fast 已越过 stopped 60px；没有 swept 就会漏判。
    expect(stopped.absorbed).toBe(true);
    expect(stopped.phase).toBe('finished');
    expect(sim.drops.filter((drop) => drop.phase !== 'finished')).toHaveLength(1);
  });

  it('同一组接触水珠换数组顺序，最终存活数与合成半径一致', () => {
    const build = (radii: number[]): RainSimulationState => {
      const sim = createRainSimulation(
        layout(
          radii.map((_, index) =>
            drop(index, [cycle({ attachSeconds: 20, initialAttachSeconds: 0 })]),
          ),
        ),
        VIEWPORT,
        0,
      );
      sim.drops.forEach((item, index) => {
        item.phase = 'paused';
        item.phaseTime = 0;
        item.baseRadius = radii[index] ?? 10;
        item.radius = radii[index] ?? 10;
        item.absorbedArea = 0;
        item.x = 240;
        item.y = 400;
        item.speed = 0;
        item.opacity = 1;
        item.absorbed = false;
        item.trail = [];
      });
      advance(sim, RAIN_FIXED_STEP);
      return sim;
    };
    const first = build([8, 11, 14]);
    const second = build([14, 11, 8]);
    const firstSurvivor = first.drops.find((item) => item.phase !== 'finished');
    const secondSurvivor = second.drops.find((item) => item.phase !== 'finished');
    expect(first.drops.filter((item) => item.phase !== 'finished')).toHaveLength(1);
    expect(second.drops.filter((item) => item.phase !== 'finished')).toHaveLength(1);
    expect(firstSurvivor?.radius ?? 0).toBeCloseTo(secondSurvivor?.radius ?? 0, 4);
    expect(first.merges).toBe(second.merges);
  });

  it('DEV 回放能把“一滑一停”摆成清晰相遇，合并前后探针可读', () => {
    const sim = createRainSimulation(
      layout([
        drop(0, [cycle({ attachSeconds: 20 })]),
        drop(1, [cycle({ startTopPercent: 20, attachSeconds: 20 })]),
      ]),
      VIEWPORT,
      0,
    );
    const before = stageControlledMergeReplay(sim);
    expect(before).not.toBeNull();
    if (!before) return;
    expect(before.scenario).toBe('dynamic');
    expect(before.target).toBeNull();
    expect(before.visibleDrops).toBe(2);
    const activeBefore = before.drops.filter((item) => item.phase !== 'finished');
    expect(activeBefore).toHaveLength(2);
    const paused = activeBefore.find((item) => item.phase === 'paused');
    const sliding = activeBefore.find((item) => item.phase === 'sliding');
    expect(paused).toBeDefined();
    expect(sliding).toBeDefined();
    if (!paused || !sliding) return;
    const surfaceGap =
      Math.abs(paused.y - sliding.y) - paused.radius - sliding.radius;
    expect(surfaceGap).toBeGreaterThanOrEqual(80);
    expect(surfaceGap).toBeLessThanOrEqual(100);

    const startedAt = sim.time;
    expect(advanceUntil(sim, () => snapshotRainReplay(sim).visibleDrops === 1, 2)).toBe(true);
    const elapsed = sim.time - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(0.7);
    expect(elapsed).toBeLessThanOrEqual(1.2);
    const after = snapshotRainReplay(sim);
    expect(after.visibleDrops).toBe(1);
    expect(after.merges).toBeGreaterThan(before.merges);
    expect(after.drops.filter((item) => item.phase !== 'finished')).toHaveLength(1);
  });

  it('DEV static 回放用真实布局大透镜珠，从上方真实接触后消失并触发透镜重烤', () => {
    const rain = buildRainLayout(17);
    const sim = createRainSimulation(rain, VIEWPORT, 0);
    const before = stageControlledMergeReplay(sim, 'static');
    expect(before).not.toBeNull();
    if (!before) return;
    expect(before.scenario).toBe('static');
    expect(before.target).not.toBeNull();
    if (!before.target) return;
    expect(before.target.hasLens).toBe(true);
    expect(before.target.radius).toBeGreaterThanOrEqual(3.8);
    expect(before.target.consumed).toBe(false);
    expect(rain.lenses.some((lens) => lens.beadId === before.target?.beadId)).toBe(true);
    // static 目标来自真实 beadPx；其余动态滴隐藏，但其余静态珠不伪造。
    expect(before.drops.filter((item) => item.phase !== 'finished')).toHaveLength(1);
    expect(before.consumedBeads).toBe(0);

    const startedAt = sim.time;
    expect(
      advanceUntil(
        sim,
        () => snapshotRainReplay(sim).target?.consumed === true,
        2,
      ),
    ).toBe(true);
    const elapsed = sim.time - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(0.7);
    expect(elapsed).toBeLessThanOrEqual(1.2);
    const after = snapshotRainReplay(sim);
    expect(after.scenario).toBe('static');
    expect(after.target?.beadId).toBe(before.target.beadId);
    expect(after.target?.consumed).toBe(true);
    expect(after.time).toBeGreaterThan(before.time);
    expect(after.consumedLenses).toBeGreaterThan(before.consumedLenses);
    expect(after.lensRevision).toBeGreaterThan(before.lensRevision);
    expect(after.consumedBeads).toBeGreaterThan(0);
  });

  it('两颗纯附着水珠真实重叠也合成一颗，不套两个可见轮廓', () => {
    const sim = createRainSimulation(
      layout([
        drop(0, [cycle({ attachSeconds: 20, initialAttachSeconds: 0 })]),
        drop(1, [cycle({ attachSeconds: 20, initialAttachSeconds: 0 })]),
      ]),
      VIEWPORT,
      0,
    );
    for (const item of sim.drops) {
      item.phase = 'attached';
      // 接近长满，避免附着成长公式把测试刚设的半径立刻压回 5.5。
      item.phaseTime = 19;
      item.baseRadius = 10;
      item.radius = 10;
      item.absorbedArea = 0;
      item.x = 240;
      item.y = 400;
      item.speed = 0;
      item.opacity = 1;
      item.absorbed = false;
      item.trail = [];
    }
    advance(sim, RAIN_FIXED_STEP);
    expect(sim.drops.filter((item) => item.phase !== 'finished')).toHaveLength(1);
    expect(sim.drops.filter((item) => item.absorbed)).toHaveLength(1);
    expect(sim.drops.find((item) => item.phase !== 'finished')?.radius ?? 0).toBeGreaterThan(13);
  });

  it('三滴链式接触只留一个存活者，面积近似相加', () => {
    const sim = createRainSimulation(
      layout([
        drop(0, [cycle({ attachSeconds: 20 })]),
        drop(1, [cycle({ attachSeconds: 20 })]),
        drop(2, [cycle({ attachSeconds: 20 })]),
      ]),
      VIEWPORT,
      0,
    );
    for (const item of sim.drops) {
      item.phase = 'paused';
      item.phaseTime = 0;
      item.baseRadius = 10;
      item.radius = 10;
      item.absorbedArea = 0;
      item.x = 240;
      item.y = 400;
      item.speed = 0;
      item.opacity = 1;
      item.absorbed = false;
      item.pauseIndex = 0;
      item.trail = [];
    }
    advance(sim, RAIN_FIXED_STEP);
    expect(sim.drops.filter((drop) => drop.phase !== 'finished')).toHaveLength(1);
    expect(sim.drops.filter((drop) => drop.absorbed).length).toBe(2);
    const survivor = sim.drops.find((drop) => drop.phase !== 'finished');
    expect(survivor?.radius ?? 0).toBeGreaterThan(16);
    expect(survivor?.mergeCount).toBe(2);
  });

  it('被吃静态珠长时间后、远离水滴才确定性重新润湿并触发静态场 revision', () => {
    const rain = layout(
      [drop(0, [cycle({ attachSeconds: 2, initialAttachSeconds: 1.9 })])],
      [bead(0, 20, 10, 16)],
    );
    const sim = createRainSimulation(rain, VIEWPORT, 0);
    advance(sim, RAIN_FIXED_STEP);
    expect(sim.consumedBeads.has(0)).toBe(true);
    expect(sim.restoredBeads).toBe(0);
    const revisionBefore = sim.lensRevision;

    const item = sim.drops[0];
    if (item) {
      item.phase = 'finished';
      item.opacity = 0;
      item.x = 1000;
      item.y = 1000;
    }
    sim.beadConsumedAt.set(0, -100);
    sim.lastWetRestoreAt = -Infinity;
    advance(sim, RAIN_FIXED_STEP);
    expect(sim.consumedBeads.has(0)).toBe(false);
    expect(sim.restoredBeads).toBe(1);
    expect(sim.lensRevision).toBeGreaterThan(revisionBefore);
    expect(takeDirtyRects(sim).length).toBeGreaterThan(0);
  });

  it('重新润湿不会在水滴脚下立刻发生', () => {
    const rain = layout(
      [drop(0, [cycle({ attachSeconds: 2, initialAttachSeconds: 1.9 })])],
      [bead(0, 20, 10, 16)],
    );
    const sim = createRainSimulation(rain, VIEWPORT, 0);
    advance(sim, RAIN_FIXED_STEP);
    expect(sim.consumedBeads.has(0)).toBe(true);
    sim.beadConsumedAt.set(0, -100);
    sim.lastWetRestoreAt = -Infinity;
    advance(sim, RAIN_FIXED_STEP);
    expect(sim.restoredBeads).toBe(0);
    expect(sim.consumedBeads.has(0)).toBe(true);
  });

  it('吸满 8 颗后仍会接触第 9 颗；尺寸只受上限控制', () => {
    const beads = Array.from({ length: 9 }, (_, index) => bead(index, 20, 10, 14));
    const sim = createRainSimulation(
      layout([drop(0, [cycle({ attachSeconds: 2, initialAttachSeconds: 1.9 })])], beads),
      VIEWPORT,
      0,
    );
    advance(sim, RAIN_FIXED_STEP);
    expect(sim.consumedBeads.size).toBe(9);
    expect(sim.drops[0]?.mergeCount).toBe(9);
    expect((sim.drops[0]?.radius ?? 0)).toBeLessThanOrEqual(
      (sim.drops[0]?.baseRadius ?? 0) * 1.9 + 0.001,
    );
  });
});
