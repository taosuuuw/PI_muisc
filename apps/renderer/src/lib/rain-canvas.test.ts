import { describe, expect, it } from 'vitest';
import { paintDynamicTrails, TRAIL_MAX_STROKES_PER_PATH } from './rain-canvas';
import type { RainDynamicCycle, RainDynamicDrop, RainLayout, RainShape } from './rain-layout';
import {
  createRainSimulation,
  dynamicTrailHeadGapPx,
  MAX_RESIDUAL_TRAILS,
  RAIN_FIXED_STEP,
  stepRainSimulation,
  type RainSimulationState,
} from './rain-simulation';

const SHAPE: RainShape = {
  squash: 1,
  tiltDeg: 0,
  wobble: 0.04,
  wobblePhase: 0,
};

const CYCLE: RainDynamicCycle = {
  startLeftPercent: 20,
  startTopPercent: 80,
  baseSizePx: 20,
  attachSeconds: 0.1,
  initialAttachSeconds: 0.09,
  band: [1, 34],
  driftPercent: 0,
  wobblePercent: 0,
  wobbleWaves: 1,
  wobblePhase: 0,
  pauses: [],
  gravity: 1200,
  drag: 0,
  releaseSpeed: 2,
  maxSpeed: 1200,
  trailLengthPx: 220,
  trailFadeSeconds: 6,
  shape: SHAPE,
};

const LAYOUT: RainLayout = {
  beads: [],
  trails: [],
  dynamicDrops: [{ id: 0, cycles: [CYCLE], respawnSeconds: 2 } satisfies RainDynamicDrop],
  lenses: [],
};

const VIEWPORT = { width: 1200, height: 900 };

interface RecordedStroke {
  style: string;
  width: number;
  points: Array<readonly [number, number]>;
}

/**
 * 一个最小的记录型 2D context：水迹绘制如果绕过真实 canvas API（例如偷偷改 DOM
 * 或用别的方式），这里就不会有 stroke，测试会直接失败。
 */
class RecordingContext {
  readonly strokes: RecordedStroke[] = [];
  lineCap = 'butt';
  lineJoin = 'miter';
  strokeStyle = '';
  lineWidth = 1;
  private current: Array<readonly [number, number]> = [];

  clearRect(): void {
    // 水迹层每帧先清空；这里不需要记录。
  }

  save(): void {}
  restore(): void {}

  beginPath(): void {
    this.current = [];
  }

  moveTo(x: number, y: number): void {
    this.current.push([x, y]);
  }

  lineTo(x: number, y: number): void {
    this.current.push([x, y]);
  }

  stroke(): void {
    this.strokes.push({
      style: this.strokeStyle,
      width: this.lineWidth,
      points: this.current.map((point) => [point[0], point[1]] as const),
    });
  }
}

function advanceUntilFinished(sim: RainSimulationState): void {
  for (let index = 0; index < 600; index += 1) {
    stepRainSimulation(sim, RAIN_FIXED_STEP);
    if (sim.drops[0]?.phase === 'finished') return;
  }
  throw new Error('测试水珠没有在预期时间内滑出');
}

function paintedYSpan(context: RecordingContext): number {
  const ys = context.strokes.flatMap((stroke) => stroke.points.map(([, y]) => y));
  if (ys.length < 2) return 0;
  return Math.max(...ys) - Math.min(...ys);
}

function paintedKeys(context: RecordingContext): string[] {
  return context.strokes.flatMap((stroke) =>
    stroke.points.map(
      ([x, y]) =>
        `${stroke.style}|${stroke.width.toFixed(2)}|${x.toFixed(2)}|${y.toFixed(2)}`,
    ),
  );
}

describe('paintDynamicTrails 行为', () => {
  it('body opacity=0、active trail 清空后，原位置残留水迹仍然真的被画出来', () => {
    const sim = createRainSimulation(LAYOUT, VIEWPORT, 0);
    advanceUntilFinished(sim);
    expect(sim.drops[0]?.opacity).toBe(0);
    expect(sim.drops[0]?.trail).toHaveLength(0);
    expect(sim.residualTrails).toHaveLength(1);

    const context = new RecordingContext();
    paintDynamicTrails(context as unknown as CanvasRenderingContext2D, sim, VIEWPORT);

    expect(context.strokes.length).toBeGreaterThan(0);
    // 不再锁死“双线 10 次”；只约束新的有限图元预算。
    expect(context.strokes.length).toBeLessThanOrEqual(TRAIL_MAX_STROKES_PER_PATH);
    const allPoints = context.strokes.flatMap((stroke) => stroke.points);
    expect(allPoints.length).toBeGreaterThan(4);
    // 轨迹应落在这颗水珠滑过的下半屏，而不是被清到 0,0 或丢掉。
    expect(allPoints.some(([x, y]) => y > 600 && x >= 0 && x <= VIEWPORT.width)).toBe(true);
    expect(context.strokes.every((stroke) => stroke.width > 0)).toBe(true);
    expect(context.strokes.some((stroke) => stroke.style.includes('rgba('))).toBe(true);
  });

  it('活跃湿迹从水滴后方留出空位，不会连成一个头加一根尾', () => {
    const gapCycle: RainDynamicCycle = {
      ...CYCLE,
      startTopPercent: 20,
      gravity: 600,
      maxSpeed: 300,
    };
    const gapLayout: RainLayout = {
      beads: [],
      trails: [],
      dynamicDrops: [{ id: 0, cycles: [gapCycle], respawnSeconds: 2 }],
      lenses: [],
    };
    const sim = createRainSimulation(gapLayout, VIEWPORT, 0);
    let drop = sim.drops[0];
    for (let index = 0; index < 600; index += 1) {
      stepRainSimulation(sim, RAIN_FIXED_STEP);
      drop = sim.drops[0];
      if (drop?.phase === 'sliding' && drop.trail.length >= 20) break;
    }
    expect(drop?.phase).toBe('sliding');
    if (!drop) return;
    expect(drop.trail.length).toBeGreaterThanOrEqual(20);

    const context = new RecordingContext();
    paintDynamicTrails(context as unknown as CanvasRenderingContext2D, sim, VIEWPORT);
    const points = context.strokes.flatMap((stroke) => stroke.points);
    expect(points.length).toBeGreaterThan(4);
    const nearest = Math.min(
      ...points.map(([x, y]) => Math.hypot(x - drop.x, y - drop.y)),
    );
    const expectedGap = dynamicTrailHeadGapPx(drop.radius);
    // 水迹起点至少退到本体半径之外，并额外留出几像素。
    expect(expectedGap).toBeGreaterThan(drop.radius + 3);
    expect(nearest).toBeGreaterThanOrEqual(expectedGap - 1);
  });

  it('新增轨迹点不会改变已有湿膜的位置/宽度/明暗档位', () => {
    const stableCycle: RainDynamicCycle = {
      ...CYCLE,
      startTopPercent: 20,
      gravity: 300,
      maxSpeed: 174,
    };
    const stableLayout: RainLayout = {
      beads: [],
      trails: [],
      dynamicDrops: [{ id: 0, cycles: [stableCycle], respawnSeconds: 2 }],
      lenses: [],
    };
    const sim = createRainSimulation(stableLayout, VIEWPORT, 0);
    let drop = sim.drops[0];
    for (let index = 0; index < 300; index += 1) {
      stepRainSimulation(sim, RAIN_FIXED_STEP);
      drop = sim.drops[0];
      if (drop?.phase === 'sliding' && drop.trail.length >= 12) break;
    }
    expect(drop?.phase).toBe('sliding');
    if (!drop) return;
    const firstLength = drop.trail.length;

    const before = new RecordingContext();
    paintDynamicTrails(before as unknown as CanvasRenderingContext2D, sim, VIEWPORT);
    const beforeKeys = new Set(paintedKeys(before));

    for (let index = 0; index < 60; index += 1) {
      stepRainSimulation(sim, RAIN_FIXED_STEP);
      if ((sim.drops[0]?.trail.length ?? 0) > firstLength) break;
    }
    expect(sim.drops[0]?.trail.length ?? 0).toBeGreaterThan(firstLength);
    const after = new RecordingContext();
    paintDynamicTrails(after as unknown as CanvasRenderingContext2D, sim, VIEWPORT);

    // 新增点可以追加新 stroke；但已经画出的点必须在同一位置/同一宽度/同一明暗档位，
    // 不能因为“按全长比例”或桶平均值变化而滑走/换花纹。
    const afterKeys = new Set(paintedKeys(after));
    for (const key of beforeKeys) expect(afterKeys.has(key)).toBe(true);
  });

  it('钉点停顿时已有水迹不被截短，也不另造残迹', () => {
    const pauseCycle: RainDynamicCycle = {
      ...CYCLE,
      startTopPercent: 20,
      gravity: 600,
      maxSpeed: 174,
      pauses: [{ at: 0.6, seconds: 1.2 }],
    };
    const pauseLayout: RainLayout = {
      beads: [],
      trails: [],
      dynamicDrops: [{ id: 0, cycles: [pauseCycle], respawnSeconds: 2 }],
      lenses: [],
    };
    const sim = createRainSimulation(pauseLayout, VIEWPORT, 0);

    let beforePauseSpan = 0;
    let afterPauseSpan = 0;
    for (let index = 0; index < 1200; index += 1) {
      stepRainSimulation(sim, RAIN_FIXED_STEP);
      const drop = sim.drops[0];
      if (!drop) break;
      if (drop.phase === 'sliding') {
        const context = new RecordingContext();
        paintDynamicTrails(context as unknown as CanvasRenderingContext2D, sim, VIEWPORT);
        beforePauseSpan = Math.max(beforePauseSpan, paintedYSpan(context));
      }
      if (drop.phase === 'paused') {
        const context = new RecordingContext();
        paintDynamicTrails(context as unknown as CanvasRenderingContext2D, sim, VIEWPORT);
        afterPauseSpan = paintedYSpan(context);
        expect(drop.speed).toBe(0);
        break;
      }
    }

    // 停顿前已经画到稳定上限（342px）；speed=0 不能把它缩成 base=220px。
    // 采样/分档会带来约 1~2px 的端点取整差异，但绝不能出现 ~100px 的截短。
    expect(beforePauseSpan).toBeGreaterThan(300);
    expect(afterPauseSpan).toBeGreaterThan(300);
    expect(afterPauseSpan).toBeGreaterThanOrEqual(beforePauseSpan - 4);
    expect(sim.residualTrails).toHaveLength(0);
  });

  it('多条残留的 stroke 次数有硬上限（有限图元预算 × 残留数）', () => {
    const sim = createRainSimulation(LAYOUT, VIEWPORT, 0);
    advanceUntilFinished(sim);
    const base = sim.residualTrails[0];
    expect(base).toBeDefined();
    if (!base) return;
    for (let index = 1; index < MAX_RESIDUAL_TRAILS; index += 1) {
      sim.residualTrails.push({
        points: base.points.map((point) => ({ ...point, x: point.x + index * 2 })),
        age: 1,
        fadeSeconds: base.fadeSeconds,
        maxLengthPx: base.maxLengthPx,
      });
    }

    const context = new RecordingContext();
    paintDynamicTrails(context as unknown as CanvasRenderingContext2D, sim, VIEWPORT);
    expect(context.strokes.length).toBeGreaterThan(0);
    expect(context.strokes.length).toBeLessThanOrEqual(
      MAX_RESIDUAL_TRAILS * TRAIL_MAX_STROKES_PER_PATH,
    );
  });
});
