import { describe, expect, it } from 'vitest';
import {
  buildRainLayout,
  type RainBead,
  type RainDynamicCycle,
  type RainDynamicDrop,
  type RainLayout,
  type RainShape,
} from './rain-layout';
import {
  createRainSimulation,
  mergeDirtyRects,
  RAIN_FIXED_STEP,
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

function layout(dynamicDrops: RainDynamicDrop[], beads: RainBead[] = []): RainLayout {
  return { beads, trails: [], dynamicDrops, lenses: [] };
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

  it('滑出画面后本体淡出、湿痕点按年龄被回收', () => {
    const sim = createRainSimulation(
      layout([
        drop(
          0,
          [
            cycle({
              startTopPercent: 80,
              attachSeconds: 0.1,
              initialAttachSeconds: 0.09,
              gravity: 1200,
              maxSpeed: 1200,
              trailFadeSeconds: 0.4,
            }),
          ],
          0.2,
        ),
      ]),
      VIEWPORT,
      0,
    );
    expect(advanceUntil(sim, () => sim.drops[0]?.phase === 'finished')).toBe(true);
    const finishTrail = sim.drops[0]?.trail.length ?? 0;
    // 滑出/重来以后，旧湿痕先交接给 residualTrails，不会跟着本体瞬移。
    expect(advanceUntil(sim, () => sim.residualTrails.length > 0, 2)).toBe(true);
    // 再走一段时间，旧湿痕点应该被回收（至少不比刚结束时更多）。
    advance(sim, 1.2);
    expect(sim.drops[0]?.trail.length ?? 0).toBeLessThanOrEqual(finishTrail);
    // 残留湿痕有上限，不会越积越多。
    expect(sim.residualTrails.length).toBeLessThanOrEqual(18);
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
});
