import { describe, expect, it } from 'vitest';
import {
  buildCombinedRainFieldPixels,
  buildDynamicRainFieldPixels,
  buildStaticRainFieldPixels,
  combinedFieldDivisor,
  combinedFieldMapSize,
  fieldCoverageAt,
  FIELD_NEUTRAL,
  prepareCombinedRainFieldBase,
} from './rain-field-map';
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
  RAIN_FIXED_STEP,
  stageControlledMergeReplay,
  stepRainSimulation,
} from './rain-simulation';
import { rainBlobRadiusScale } from './rain-shape';

const SHAPE: RainShape = {
  squash: 1,
  tiltDeg: 0,
  wobble: 0.06,
  wobblePhase: 0.3,
};

const VIEWPORT = { width: 200, height: 200 };
const MAP = { width: 200, height: 200 };

function bead(id: number, left: number, top: number, size: number): RainBead {
  return {
    id,
    leftPercent: left,
    topPercent: top,
    sizePx: size,
    opacity: 0.8,
    shape: SHAPE,
    mergeable: false,
  };
}

function cycle(): RainDynamicCycle {
  return {
    startLeftPercent: 50,
    startTopPercent: 50,
    baseSizePx: 20,
    attachSeconds: 0.2,
    initialAttachSeconds: 0.19,
    band: [1, 99],
    driftPercent: 0,
    wobblePercent: 0,
    wobbleWaves: 1,
    wobblePhase: 0,
    pauses: [],
    gravity: 0,
    drag: 0,
    releaseSpeed: 0,
    maxSpeed: 100,
    trailLengthPx: 60,
    trailFadeSeconds: 2,
    shape: SHAPE,
  };
}

function layout(beads: RainBead[], drops: RainDynamicDrop[] = []): RainLayout {
  return { beads, trails: [], dynamicDrops: drops, lenses: [] };
}

function at(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const index = (Math.round(y) * MAP.width + Math.round(x)) * 4;
  return {
    r: pixels[index] ?? 0,
    g: pixels[index + 1] ?? 0,
    b: pixels[index + 2] ?? 0,
    a: pixels[index + 3] ?? 0,
  };
}

describe('rain-field-map 共享水体场', () => {
  it('统一 shape 半径是确定性的，并且 wobble 会真的改变轮廓', () => {
    const a = rainBlobRadiusScale(SHAPE, 0.4);
    const b = rainBlobRadiusScale(SHAPE, 0.4);
    const c = rainBlobRadiusScale(SHAPE, 1.7);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBeGreaterThan(0.45);
  });

  it('combined 场按窗口降档，目标窗 1/3、小窗 1/2、4K 1/4', () => {
    expect(combinedFieldDivisor(1000)).toBe(2);
    expect(combinedFieldDivisor(1001)).toBe(3);
    expect(combinedFieldDivisor(1184)).toBe(3);
    expect(combinedFieldDivisor(2401)).toBe(4);
    expect(combinedFieldMapSize({ width: 1184, height: 772 })).toEqual({
      width: 395,
      height: 257,
    });
  });

  it('真实布局全部静态珠进 combined 1/3 场，footprint 8~16%', () => {
    const rain = buildRainLayout(186016);
    const viewport = { width: 1184, height: 772 };
    const map = combinedFieldMapSize(viewport);
    const result = buildStaticRainFieldPixels(rain, viewport, map);
    let footprint = 0;
    for (let index = 2; index < result.pixels.length; index += 4) {
      if ((result.pixels[index] ?? 0) > 16) footprint += 1;
    }
    expect(rain.beads.length).toBeGreaterThan(500);
    expect(result.coveredBeads).toBe(rain.beads.length);
    expect(footprint / (map.width * map.height)).toBeGreaterThan(0.08);
    expect(footprint / (map.width * map.height)).toBeLessThan(0.16);
  });

  it('场图先逆旋转再除 radiusX/Y；tilt45+squash1.6 长轴 0.8 处仍在内', () => {
    const squashed: RainBead = {
      ...bead(0, 50, 50, 40),
      shape: { ...SHAPE, squash: 1.6, tiltDeg: 45, wobble: 0 },
    };
    const result = buildStaticRainFieldPixels(layout([squashed]), VIEWPORT, MAP);
    const radius = (40 * rainSizeScale(VIEWPORT.width)) / 2;
    const longAxis = radius * 1.6 * 0.8;
    const px = 100 - longAxis * Math.SQRT1_2;
    const py = 100 + longAxis * Math.SQRT1_2;
    expect(fieldCoverageAt(result.pixels, MAP.width, px, py)).toBeGreaterThan(0.5);
  });

  it('凸透镜在右侧边缘向中心采样：R 应低于中性 128，而不是向外', () => {
    const rain = layout([
      {
        ...bead(0, 50, 50, 40),
        shape: { ...SHAPE, squash: 1, tiltDeg: 0, wobble: 0 },
      },
    ]);
    const result = buildStaticRainFieldPixels(rain, VIEWPORT, MAP);
    const radius = (40 * rainSizeScale(VIEWPORT.width)) / 2;
    const edge = at(result.pixels, 100 + radius * 0.55, 100);
    expect(edge.r).toBeLessThan(FIELD_NEUTRAL);
    expect(edge.b).toBeGreaterThan(200);
  });

  it('静态场覆盖全部可见珠，外部保持中性 RG / B0，且边缘有真实偏折', () => {
    const rain = layout([bead(0, 50, 50, 20), bead(1, 25, 25, 10)]);
    const result = buildStaticRainFieldPixels(rain, VIEWPORT, MAP);
    const radius = (20 * rainSizeScale(VIEWPORT.width)) / 2;
    const center = at(result.pixels, 100, 100);
    const corner = at(result.pixels, 1, 1);
    const edge = at(result.pixels, 100 + radius * 0.65, 100);

    expect(result.coveredBeads).toBe(2);
    expect(result.coveragePixels).toBeGreaterThan(0);
    expect(fieldCoverageAt(result.pixels, MAP.width, 100, 100)).toBeGreaterThan(0.7);
    expect(center.a).toBe(255);
    expect(Math.abs(edge.r - FIELD_NEUTRAL)).toBeGreaterThan(0);
    expect(corner.r).toBe(FIELD_NEUTRAL);
    expect(corner.g).toBe(FIELD_NEUTRAL);
    expect(corner.b).toBe(0);
    expect(corner.a).toBe(255);
  });

  it('静态原图保留全部珠；消费清理由动态中性洞在最终合成完成', () => {
    const rain = layout([bead(0, 50, 50, 20)]);
    const result = buildStaticRainFieldPixels(rain, VIEWPORT, MAP);
    const center = at(result.pixels, 100, 100);
    expect(result.coveredBeads).toBe(1);
    expect(center.b).toBeGreaterThan(0);
    expect(center.r).not.toBe(FIELD_NEUTRAL);
  });

  it('动态场包含全部可见滑滴和活跃水路；外部 A0 不污染静态场', () => {
    const drop: RainDynamicDrop = { id: 0, cycles: [cycle()], respawnSeconds: 2 };
    const sim = createRainSimulation(layout([], [drop]), VIEWPORT, 0);
    const item = sim.drops[0];
    expect(item).toBeDefined();
    if (!item) return;
    item.phase = 'sliding';
    item.opacity = 1;
    item.x = 100;
    item.y = 100;
    item.radius = 10;
    item.baseRadius = 10;
    item.speed = 0;
    item.trail = [
      { x: 100, y: 48, age: 0, size: 20 },
      { x: 100, y: 58, age: 0, size: 20 },
      { x: 100, y: 70, age: 0, size: 20 },
      { x: 100, y: 100, age: 0, size: 20 },
    ];

    const result = buildDynamicRainFieldPixels(sim, MAP);
    const center = at(result.pixels, 100, 100);
    const trail = at(result.pixels, 100, 55);
    const outside = at(result.pixels, 2, 2);
    expect(result.coveredDrops).toBe(1);
    expect(result.coveredTrails).toBe(1);
    expect(center.b).toBeGreaterThan(0);
    expect(center.a).toBeGreaterThan(0);
    expect(trail.b).toBeGreaterThan(0);
    expect(outside.a).toBe(0);
    expect(outside.r).toBe(FIELD_NEUTRAL);
  });

  it('附着/滑行/停顿的全部可见动态滴都进入同一张场图', () => {
    const drops: RainDynamicDrop[] = [0, 1, 2].map((id) => ({
      id,
      cycles: [cycle()],
      respawnSeconds: 2,
    }));
    const sim = createRainSimulation(layout([], drops), VIEWPORT, 0);
    const phases = ['attached', 'sliding', 'paused'] as const;
    sim.drops.forEach((item, index) => {
      item.phase = phases[index] ?? 'sliding';
      item.opacity = 1;
      item.x = 50 + index * 50;
      item.y = 100;
      item.radius = 10;
      item.baseRadius = 10;
      item.speed = index === 1 ? 20 : 0;
      item.trail = [];
    });
    const result = buildDynamicRainFieldPixels(sim, MAP);
    expect(result.coveredDrops).toBe(3);
    for (let index = 0; index < 3; index += 1) {
      const point = at(result.pixels, 50 + index * 50, 100);
      expect(point.b).toBeGreaterThan(0);
      expect(point.a).toBeGreaterThan(0);
    }
  });

  it('combined 场缓存静态基图：覆写不会改 base，洞遮旧珠，恢复后原样出现', () => {
    const rain = layout([bead(0, 50, 50, 20)]);
    const base = prepareCombinedRainFieldBase(rain, VIEWPORT);
    const snapshot = base.pixels.slice();
    const sim = createRainSimulation(rain, VIEWPORT, 0);
    const centerX = base.mapWidth * 0.5;
    const centerY = base.mapHeight * 0.5;
    expect(fieldCoverageAt(base.pixels, base.mapWidth, centerX, centerY)).toBeGreaterThan(0);

    sim.consumedBeads.add(0);
    const withHole = buildCombinedRainFieldPixels(base, sim);
    const index = (Math.round(centerY) * base.mapWidth + Math.round(centerX)) * 4;
    expect(withHole.pixels[index + 2] ?? -1).toBe(0);
    expect(withHole.pixels[index + 3] ?? 0).toBe(255);
    expect(withHole.pixels[index] ?? -1).toBe(FIELD_NEUTRAL);
    expect(withHole.pixels[index + 1] ?? -1).toBe(FIELD_NEUTRAL);
    expect(base.pixels).toEqual(snapshot);

    sim.consumedBeads.delete(0);
    const restored = buildCombinedRainFieldPixels(base, sim);
    expect(fieldCoverageAt(restored.pixels, base.mapWidth, centerX, centerY)).toBeGreaterThan(0);
    expect(restored.coveredBeads).toBe(1);
  });

  it('真实 static 回放：静态原图只烤一次，动态场中性洞在最终合成里清掉目标', () => {
    const viewport = { width: 300, height: 300 };
    const rain = buildRainLayout(17);
    const sim = createRainSimulation(rain, viewport, 0);
    const staged = stageControlledMergeReplay(sim, 'static');
    expect(staged?.target).not.toBeNull();
    if (!staged?.target) return;
    const map = { width: 300, height: 300 };
    const before = buildStaticRainFieldPixels(rain, viewport, map);
    const targetX = (staged.target.x / viewport.width) * map.width;
    const targetY = (staged.target.y / viewport.height) * map.height;
    expect(
      fieldCoverageAt(before.pixels, map.width, targetX, targetY),
    ).toBeGreaterThan(0);

    for (let index = 0; index < 300; index += 1) {
      stepRainSimulation(sim, RAIN_FIXED_STEP);
      if (sim.consumedBeads.has(staged.target.beadId)) break;
    }
    expect(sim.consumedBeads.has(staged.target.beadId)).toBe(true);
    const afterDynamic = buildDynamicRainFieldPixels(sim, map);
    const holeIndex =
      (Math.round(targetY) * map.width + Math.round(targetX)) * 4;
    // 静态原图仍有旧珠，但动态洞 B0/A255 会盖掉它；这是最终合成判据。
    expect(afterDynamic.pixels[holeIndex + 2] ?? -1).toBe(0);
    expect(afterDynamic.pixels[holeIndex + 3] ?? 0).toBe(255);
  });

  it('已消费静态珠在动态场里写中性洞，盖住旧静态透镜', () => {
    const rain = layout([bead(0, 50, 50, 20)], [
      { id: 0, cycles: [cycle()], respawnSeconds: 2 },
    ]);
    const sim = createRainSimulation(rain, VIEWPORT, 0);
    sim.consumedBeads.add(0);
    const item = sim.drops[0];
    if (item) {
      item.phase = 'finished';
      item.opacity = 0;
    }
    const result = buildDynamicRainFieldPixels(sim, MAP);
    const hole = at(result.pixels, 100, 100);
    expect(hole.b).toBe(0);
    expect(hole.r).toBe(FIELD_NEUTRAL);
    expect(hole.g).toBe(FIELD_NEUTRAL);
    expect(hole.a).toBe(255);
    expect(result.coveredDrops).toBe(0);
  });
});
