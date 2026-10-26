import {
  rainSizeScale,
  type RainDynamicCycle,
  type RainDynamicDrop,
  type RainLayout,
  type RainShape,
} from './rain-layout';

/**
 * 雨窗的**动态水珠仿真**（纯函数，不碰 DOM）。
 *
 * 这里刻意不用 CSS keyframes：上一版的 6 颗水珠共用一条 18~38 秒的匀速循环，所有水珠
 * 的节奏一样，看起来像传送带。这一版每颗水珠有自己的状态机：
 *
 *   附着积聚（慢慢变大、吸掉周围小珠）
 *     → 释放（初速度很小）
 *     → 重力加速（速度越来越快）
 *     → 遇钉点停顿（0.3~1.4 秒，湿痕停止生长并变淡）
 *     → 继续滑（可能再停、可能合并别的水珠）
 *     → 滑出画面（本体淡出，湿痕按年龄逐渐消失）
 *     → 隔几秒换一套参数、换一个位置重新积聚
 *
 * 时间推进用固定步长（1/60 秒），所以 rAF 的抖动不会改变轨迹；测试里也能一步步复现。
 * 位置换算成 CSS px 后才交给组件，仿真本身只依赖窗口宽高。
 */

export interface RainViewport {
  width: number;
  height: number;
}

export interface RainTrailPoint {
  x: number;
  y: number;
  /** 这个点存在了多久（秒）；越大越淡。 */
  age: number;
  /** 生成时的水珠直径 px。 */
  size: number;
}

export type RainDropPhase = 'attached' | 'sliding' | 'paused' | 'finished';

/** 水珠淡出后留在玻璃上的湿痕；本体换位置以后它还会自己淡一会儿。 */
export interface RainResidualTrail {
  points: RainTrailPoint[];
  fadeSeconds: number;
}

export interface RainDropState {
  /** 在 `layout.dynamicDrops` 里的下标。 */
  index: number;
  /** 当前用第几轮生命周期参数。 */
  cycleIndex: number;
  phase: RainDropPhase;
  /** 当前阶段已经过的秒数。 */
  phaseTime: number;
  /** 水珠中心（CSS px）。 */
  x: number;
  y: number;
  /** 当前半径（CSS px，会因合并变大）。 */
  radius: number;
  /** 这一轮积聚完成时的基准半径。 */
  baseRadius: number;
  /** 当前下滑速度 px/s（附着/停顿/结束时为 0）。 */
  speed: number;
  opacity: number;
  /** 身后湿痕的点，旧 → 新。 */
  trail: RainTrailPoint[];
  /** 合并闪光 0~1，快速衰减。 */
  mergeFlash: number;
  /** 本轮已经合并了几颗（防止滚成巨球）。 */
  mergeCount: number;
  /** 已经经过的钉点下标。 */
  pauseIndex: number;
  releaseX: number;
  releaseY: number;
  /** 从释放点到滑出画面的纵向距离 px。 */
  travelSpan: number;
  shape: RainShape;
}

export interface RainDirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface StaticBeadPx {
  id: number;
  x: number;
  y: number;
  radius: number;
  mergeable: boolean;
}

export interface RainSimulationState {
  readonly drops: RainDropState[];
  /** 水珠滑走/被合并后留下的湿痕，继续按年龄淡出。 */
  readonly residualTrails: RainResidualTrail[];
  /** 已被动态水珠吸走的静态珠 id；静态 canvas 重绘时跳过。 */
  readonly consumedBeads: Set<number>;
  /** 自上次读取以来需要重绘的静态 canvas 区域。 */
  readonly dirtyRects: RainDirtyRect[];
  readonly beadPx: readonly StaticBeadPx[];
  readonly layout: RainLayout;
  readonly viewport: RainViewport;
  /** 仿真时间（秒，含预热）。 */
  time: number;
  /** 未消化的固定步长。 */
  accumulator: number;
  /** 累计合并次数（静态珠 + 动态水珠）。 */
  merges: number;
}

/** 固定步长：60Hz。 */
export const RAIN_FIXED_STEP = 1 / 60;

/** 创建时先空转这么久，让第一帧就有「已经挂了一会儿」的水珠。 */
export const RAIN_WARMUP_SECONDS = 3.8;

const MAX_DT = 0.1;
const MAX_STEPS_PER_FRAME = 8;
const MAX_TRAIL_POINTS = 96;
const MAX_MERGES_PER_DROP = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(value: number): number {
  const inverse = 1 - value;
  return 1 - inverse * inverse * inverse;
}

function cycleOf(drop: RainDynamicDrop, cycleIndex: number): RainDynamicCycle {
  const cycle = drop.cycles[cycleIndex % drop.cycles.length];
  if (!cycle) throw new Error('动态水珠缺少生命周期参数');
  return cycle;
}

function beadRadius(beadSizePx: number, sizeScale: number): number {
  return Math.max(0.35, (beadSizePx * sizeScale) / 2);
}

function dropOpacity(phase: RainDropPhase, phaseTime: number, progress: number): number {
  // 附着期也别淡到看不见：0.55 起步，积聚完成到 1。
  if (phase === 'attached') return 0.55 + 0.45 * clamp(progress, 0, 1);
  if (phase === 'finished') return Math.max(0, 1 - phaseTime / 0.42);
  return 1;
}

function detachTrail(
  state: RainSimulationState,
  drop: RainDropState,
  cycle: RainDynamicCycle,
): void {
  if (drop.trail.length < 2) return;
  // 复制点：drop.trail 马上会被清空给下一轮用，残留湿痕必须留下自己的副本。
  const points = drop.trail.map((point) => ({ ...point }));
  state.residualTrails.push({ points, fadeSeconds: cycle.trailFadeSeconds });
  if (state.residualTrails.length > 18) state.residualTrails.shift();
}

function resetDrop(
  drop: RainDropState,
  def: RainDynamicDrop,
  cycleIndex: number,
  viewport: RainViewport,
  sizeScale: number,
): void {
  const cycle = cycleOf(def, cycleIndex);
  const baseRadius = (cycle.baseSizePx * sizeScale) / 2;
  const attachProgress = clamp(cycle.initialAttachSeconds / cycle.attachSeconds, 0, 0.999);
  drop.cycleIndex = cycleIndex;
  drop.phase = 'attached';
  drop.phaseTime = cycle.initialAttachSeconds;
  drop.radius = baseRadius * (0.55 + 0.45 * easeOutCubic(attachProgress));
  drop.baseRadius = baseRadius;
  drop.x = (cycle.startLeftPercent / 100) * viewport.width;
  drop.y = (cycle.startTopPercent / 100) * viewport.height;
  drop.speed = 0;
  drop.opacity = dropOpacity('attached', drop.phaseTime, attachProgress);
  drop.trail = [];
  drop.mergeFlash = 0;
  drop.mergeCount = 0;
  drop.pauseIndex = 0;
  drop.releaseX = drop.x;
  drop.releaseY = drop.y;
  drop.travelSpan = Math.max(160, viewport.height + 80 - drop.y);
  drop.shape = cycle.shape;
}

/** 建一场仿真；`warmupSeconds` 只用于测试/特殊场景，正常用默认。 */
export function createRainSimulation(
  layout: RainLayout,
  viewport: RainViewport,
  warmupSeconds = RAIN_WARMUP_SECONDS,
): RainSimulationState {
  const safeViewport: RainViewport = {
    width: Math.max(2, viewport.width),
    height: Math.max(2, viewport.height),
  };
  const sizeScale = rainSizeScale(safeViewport.width);
  const beadPx: StaticBeadPx[] = layout.beads.map((bead) => ({
    id: bead.id,
    x: (bead.leftPercent / 100) * safeViewport.width,
    y: (bead.topPercent / 100) * safeViewport.height,
    radius: beadRadius(bead.sizePx, sizeScale),
    mergeable: bead.mergeable,
  }));

  const drops: RainDropState[] = layout.dynamicDrops.map((def, index) => {
    const placeholderShape = cycleOf(def, 0).shape;
    const drop: RainDropState = {
      index,
      cycleIndex: 0,
      phase: 'attached',
      phaseTime: 0,
      x: 0,
      y: 0,
      radius: 1,
      baseRadius: 1,
      speed: 0,
      opacity: 0,
      trail: [],
      mergeFlash: 0,
      mergeCount: 0,
      pauseIndex: 0,
      releaseX: 0,
      releaseY: 0,
      travelSpan: 1,
      shape: placeholderShape,
    };
    resetDrop(drop, def, 0, safeViewport, sizeScale);
    return drop;
  });

  const state: RainSimulationState = {
    drops,
    residualTrails: [],
    consumedBeads: new Set<number>(),
    dirtyRects: [],
    beadPx,
    layout,
    viewport: safeViewport,
    time: 0,
    accumulator: 0,
    merges: 0,
  };

  const warmupSteps = Math.max(0, Math.round(warmupSeconds / RAIN_FIXED_STEP));
  for (let step = 0; step < warmupSteps; step += 1) {
    stepOnce(state, RAIN_FIXED_STEP);
  }
  // 预热期间的合并已经画进初始 canvas，不需要当成脏区。
  state.dirtyRects.length = 0;
  state.accumulator = 0;
  return state;
}

function addDirty(
  state: RainSimulationState,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  // 合并成一个外接矩形，最多保留 8 个；重绘时再统一合并。
  const rect: RainDirtyRect = {
    x: Math.floor(x - 4),
    y: Math.floor(y - 4),
    width: Math.ceil(width + 8),
    height: Math.ceil(height + 8),
  };
  state.dirtyRects.push(rect);
  if (state.dirtyRects.length > 8) {
    const merged = mergeDirtyRects(state.dirtyRects);
    state.dirtyRects.length = 0;
    state.dirtyRects.push(...merged);
  }
}

/** 1D 区间合并，供静态 canvas 重绘用（也导出给测试）。 */
export function mergeDirtyRects(rects: readonly RainDirtyRect[]): RainDirtyRect[] {
  if (rects.length < 2) return rects.map((rect) => ({ ...rect }));
  const sorted = rects.map((rect) => ({ ...rect })).sort((a, b) => a.x - b.x || a.y - b.y);
  const merged: RainDirtyRect[] = [];
  for (const rect of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      rect.x <= last.x + last.width &&
      rect.y <= last.y + last.height &&
      rect.x + rect.width >= last.x &&
      rect.y + rect.height >= last.y
    ) {
      const right = Math.max(last.x + last.width, rect.x + rect.width);
      const bottom = Math.max(last.y + last.height, rect.y + rect.height);
      last.x = Math.min(last.x, rect.x);
      last.y = Math.min(last.y, rect.y);
      last.width = right - last.x;
      last.height = bottom - last.y;
    } else {
      merged.push(rect);
    }
  }
  return merged;
}

function pushTrail(drop: RainDropState): void {
  const last = drop.trail[drop.trail.length - 1];
  if (last && Math.hypot(drop.x - last.x, drop.y - last.y) < 2.5) return;
  drop.trail.push({ x: drop.x, y: drop.y, age: 0, size: drop.radius * 2 });
  if (drop.trail.length > MAX_TRAIL_POINTS)
    drop.trail.splice(0, drop.trail.length - MAX_TRAIL_POINTS);
}

function ageTrail(drop: RainDropState, cycle: RainDynamicCycle, dt: number): void {
  const maxAge = cycle.trailFadeSeconds * 1.7;
  for (const point of drop.trail) point.age += dt;
  while (drop.trail.length > 0 && (drop.trail[0]?.age ?? 0) > maxAge) drop.trail.shift();
}

function absorbBead(state: RainSimulationState, drop: RainDropState, bead: StaticBeadPx): void {
  if (state.consumedBeads.has(bead.id)) return;
  state.consumedBeads.add(bead.id);
  // 体积近似相加，半径按平方和开根：合并后不会突然变成巨球。
  const nextRadius = Math.sqrt(drop.radius * drop.radius + bead.radius * bead.radius * 0.72);
  drop.radius = Math.min(drop.baseRadius * 1.65, nextRadius);
  // 合并后变重、变快；真正的终端速度在 stepDrop 里由 cycle.maxSpeed 收口。
  drop.speed += 5.5;
  drop.mergeFlash = 1;
  drop.mergeCount += 1;
  state.merges += 1;
  addDirty(state, bead.x, bead.y, bead.radius * 2, bead.radius * 2);
}

function mergeStaticBeads(
  state: RainSimulationState,
  drop: RainDropState,
  canMerge: boolean,
): void {
  if (!canMerge || drop.mergeCount >= MAX_MERGES_PER_DROP) return;
  for (const bead of state.beadPx) {
    if (!bead.mergeable || state.consumedBeads.has(bead.id)) continue;
    // 只吸「已经滑到的、身体附近」的珠子；身后的不吸。
    if (bead.y < drop.y - drop.radius * 1.8) continue;
    const reach = drop.radius * 0.78 + bead.radius + 1.4;
    if (Math.hypot(bead.x - drop.x, bead.y - drop.y) > reach) continue;
    absorbBead(state, drop, bead);
    if (drop.mergeCount >= MAX_MERGES_PER_DROP) break;
  }
}

function mergeDrops(state: RainSimulationState): void {
  for (let first = 0; first < state.drops.length; first += 1) {
    const a = state.drops[first];
    if (!a || a.phase === 'finished' || a.phase === 'attached') continue;
    for (let second = first + 1; second < state.drops.length; second += 1) {
      const b = state.drops[second];
      if (!b || b.phase === 'finished' || b.phase === 'attached') continue;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance > (a.radius + b.radius) * 0.62) continue;
      const big = a.radius >= b.radius ? a : b;
      const small = big === a ? b : a;
      big.radius = Math.min(
        big.baseRadius * 1.9,
        Math.sqrt(big.radius * big.radius + small.radius * small.radius * 0.65),
      );
      big.speed += 7;
      big.mergeFlash = 1;
      big.mergeCount += 1;
      const smallDef = state.layout.dynamicDrops[small.index];
      const smallCycle = smallDef?.cycles[small.cycleIndex];
      if (smallCycle) detachTrail(state, small, smallCycle);
      small.phase = 'finished';
      small.phaseTime = 0;
      small.speed = 0;
      small.opacity = 0;
      state.merges += 1;
      // 这一对被合并了；本次不再拿刚刚出局的 small 继续配对。
      break;
    }
  }
}

function stepDrop(
  state: RainSimulationState,
  drop: RainDropState,
  def: RainDynamicDrop,
  dt: number,
  sizeScale: number,
): void {
  const cycle = cycleOf(def, drop.cycleIndex);
  drop.mergeFlash = Math.max(0, drop.mergeFlash - dt * 2.4);
  ageTrail(drop, cycle, dt);

  if (drop.phase === 'finished') {
    drop.phaseTime += dt;
    drop.opacity = dropOpacity('finished', drop.phaseTime, 1);
    if (drop.phaseTime >= def.respawnSeconds) {
      detachTrail(state, drop, cycle);
      const nextCycle = (drop.cycleIndex + 1) % def.cycles.length;
      resetDrop(drop, def, nextCycle, state.viewport, sizeScale);
    }
    return;
  }

  if (drop.phase === 'attached') {
    drop.phaseTime += dt;
    const progress = clamp(drop.phaseTime / cycle.attachSeconds, 0, 1);
    drop.radius = drop.baseRadius * (0.55 + 0.45 * easeOutCubic(progress));
    drop.opacity = dropOpacity('attached', drop.phaseTime, progress);
    // 积聚到 35% 之后开始吸收周围的小珠：先长身体，再被吸走。
    mergeStaticBeads(state, drop, progress > 0.35);
    if (progress >= 1) {
      drop.phase = 'sliding';
      drop.phaseTime = 0;
      drop.speed = cycle.releaseSpeed;
      drop.pauseIndex = 0;
      drop.releaseX = drop.x;
      drop.releaseY = drop.y;
      drop.travelSpan = Math.max(160, state.viewport.height + 80 - drop.y);
      drop.trail = [{ x: drop.x, y: drop.y, age: 0, size: drop.radius * 2 }];
      drop.opacity = 1;
    }
    return;
  }

  if (drop.phase === 'paused') {
    drop.phaseTime += dt;
    drop.speed = 0;
    drop.opacity = 1;
    if (drop.phaseTime >= (cycle.pauses[drop.pauseIndex]?.seconds ?? 0.4)) {
      drop.phase = 'sliding';
      drop.phaseTime = 0;
      drop.pauseIndex += 1;
      drop.speed = Math.max(4.5, cycle.releaseSpeed * 0.7);
      drop.y += 0.2;
    }
    return;
  }

  // sliding
  drop.phaseTime += dt;
  drop.speed += cycle.gravity * dt;
  drop.speed *= Math.exp(-cycle.drag * dt);
  drop.speed = Math.min(cycle.maxSpeed, drop.speed);
  const previousY = drop.y;
  drop.y += drop.speed * dt;

  const rawProgress = clamp((drop.y - drop.releaseY) / drop.travelSpan, 0, 1.2);
  const travelProgress = clamp(rawProgress, 0, 1);
  const wobble =
    cycle.wobblePercent *
    Math.sin(travelProgress * Math.PI * 2 * cycle.wobbleWaves + cycle.wobblePhase) *
    Math.sin(Math.PI * travelProgress);
  const xPercent = clamp(
    cycle.startLeftPercent + cycle.driftPercent * travelProgress + wobble,
    cycle.band[0],
    cycle.band[1],
  );
  drop.x = (xPercent / 100) * state.viewport.width;

  // 钉点：到点就停，停在精确的 at 位置，湿痕也在这里停止生长。
  const pause = cycle.pauses[drop.pauseIndex];
  if (pause && rawProgress >= pause.at && previousY < drop.y) {
    drop.y = drop.releaseY + pause.at * drop.travelSpan;
    drop.x =
      (clamp(
        cycle.startLeftPercent +
          cycle.driftPercent * pause.at +
          cycle.wobblePercent *
            Math.sin(pause.at * Math.PI * 2 * cycle.wobbleWaves + cycle.wobblePhase) *
            Math.sin(Math.PI * pause.at),
        cycle.band[0],
        cycle.band[1],
      ) /
        100) *
      state.viewport.width;
    drop.phase = 'paused';
    drop.phaseTime = 0;
    drop.speed = 0;
    drop.opacity = 1;
    return;
  }

  pushTrail(drop);
  mergeStaticBeads(state, drop, true);
  mergeDrops(state);

  if (drop.y - drop.radius > state.viewport.height + 2) {
    drop.phase = 'finished';
    drop.phaseTime = 0;
    drop.speed = 0;
    drop.opacity = 0;
  }
}

function stepOnce(state: RainSimulationState, dt: number): void {
  state.time += dt;
  const sizeScale = rainSizeScale(state.viewport.width);
  for (const def of state.layout.dynamicDrops) {
    const drop = state.drops[def.id];
    if (!drop) continue;
    stepDrop(state, drop, def, dt, sizeScale);
  }
  // 残留湿痕：继续按年龄淡出；点掉光或太老就整条移除。
  for (let index = state.residualTrails.length - 1; index >= 0; index -= 1) {
    const residual = state.residualTrails[index];
    if (!residual) continue;
    const maxAge = residual.fadeSeconds * 1.7;
    for (const point of residual.points) point.age += dt;
    while (residual.points.length > 0 && (residual.points[0]?.age ?? 0) > maxAge) {
      residual.points.shift();
    }
    if (residual.points.length < 2) state.residualTrails.splice(index, 1);
  }
}

/** 推进仿真。`dt` 会被夹到 0.1 秒，内部再拆成固定 1/60 步。 */
export function stepRainSimulation(state: RainSimulationState, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  state.accumulator += Math.min(dt, MAX_DT);
  let steps = 0;
  while (state.accumulator >= RAIN_FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
    stepOnce(state, RAIN_FIXED_STEP);
    state.accumulator -= RAIN_FIXED_STEP;
    steps += 1;
  }
  if (steps >= MAX_STEPS_PER_FRAME) state.accumulator = 0;
}

/** 取走并清空静态 canvas 的脏区；组件在每帧结尾调用。 */
export function takeDirtyRects(state: RainSimulationState): RainDirtyRect[] {
  if (state.dirtyRects.length === 0) return [];
  const merged = mergeDirtyRects(state.dirtyRects);
  state.dirtyRects.length = 0;
  return merged;
}

/** 供 UI 探针/测试读的汇总。 */
export interface RainSimulationSummary {
  attached: number;
  sliding: number;
  paused: number;
  finished: number;
  merges: number;
  time: number;
}

export function summarizeSimulation(state: RainSimulationState): RainSimulationSummary {
  let attached = 0;
  let sliding = 0;
  let paused = 0;
  let finished = 0;
  for (const drop of state.drops) {
    if (drop.phase === 'attached') attached += 1;
    else if (drop.phase === 'sliding') sliding += 1;
    else if (drop.phase === 'paused') paused += 1;
    else finished += 1;
  }
  return { attached, sliding, paused, finished, merges: state.merges, time: state.time };
}
