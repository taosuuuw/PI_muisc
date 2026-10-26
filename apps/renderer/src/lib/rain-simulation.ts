import {
  dynamicDropMetrics,
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
 *     → 滑出画面（本体淡出；湿痕立即交接，独立残留数秒后消失）
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

/**
 * 水珠离开/被吞并后留在玻璃上的湿痕快照。
 *
 * `points` 是固定坐标，不跟本体走；`age` 从交接那一刻重新计时，和本体的
 * finished/opacity 完全解耦。这样本体 0.42 秒淡没、甚至重生，旧水迹仍留在原地。
 */
export interface RainResidualTrail {
  points: RainTrailPoint[];
  /** 交接后经过的秒数；决定残留整体淡出。 */
  age: number;
  /** 从清楚到消失的秒数（约 5~8 秒）。 */
  fadeSeconds: number;
  /** 交接时按速度/窗口算出的可见路径长度 CSS px。 */
  maxLengthPx: number;
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
  /**
   * 已吸走小珠折算出的“额外面积”（px²）。
   *
   * 半径不能每 tick 只用自然成长公式重算，否则吸进来的质量下一 tick 就没了。
   * 自然成长半径和这块额外面积按平方和合成，再统一收上限。
   */
  absorbedArea: number;
  /** 是否被别的水珠吞并（不是自然滑出）；吞并后保持不可见直到重生。 */
  absorbed: boolean;
  /** 当前下滑速度 px/s（附着/停顿/结束时为 0）。 */
  speed: number;
  opacity: number;
  /** 身后湿痕的点，旧 → 新。 */
  trail: RainTrailPoint[];
  /** 合并闪光 0~1，快速衰减。 */
  mergeFlash: number;
  /** 本轮已经合并了几颗，仅供统计/测试；尺寸由 MAX_RADIUS_FACTOR 收口。 */
  mergeCount: number;
  /** 已经经过的钉点下标。 */
  pauseIndex: number;
  releaseX: number;
  releaseY: number;
  /** 从释放点到滑出画面的纵向距离 px。 */
  travelSpan: number;
  shape: RainShape;
  /**
   * 仅 DEV 回放使用：固定横向路径，避免真实 cycle 的漂移把受控相遇带偏。
   * 正常仿真/reset 永远不设；碰撞、吸收、面积、速度仍走完全相同逻辑。
   */
  stageFixedX?: number;
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
  shape: RainShape;
  /** 是否在静态折射图里有对应透镜；和碰撞资格无关。 */
  hasLens: boolean;
}

export interface RainSimulationState {
  readonly drops: RainDropState[];
  /** 水珠滑走/被合并后交接的固定湿痕；和本体 opacity 完全解耦。 */
  readonly residualTrails: RainResidualTrail[];
  /** 已被动态水珠吸走的静态珠 id；静态 canvas 重绘时跳过。 */
  readonly consumedBeads: Set<number>;
  /** 被吸走且原本有静态透镜的珠 id；静态折射图要低频重烤。 */
  readonly consumedLenses: Set<number>;
  /** 每吃掉一颗透镜珠 +1；RainWindow 用它触发低频重烤，而不是逐帧。 */
  lensRevision: number;
  /** 静态珠被吃的时间，用于长时间播放后确定性重新润湿。 */
  readonly beadConsumedAt: Map<number, number>;
  /** 上次重新润湿的仿真时间，限制全屏静态场重烤频率。 */
  lastWetRestoreAt: number;
  /** 已重新润湿的静态珠数量（探针/测试）。 */
  restoredBeads: number;
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
  /** 仅 DEV 回放：给 snapshot 说明当前场景和目标静态珠。 */
  replay?: {
    scenario: RainReplayScenario;
    targetBeadId: number | null;
    note: string;
  };
}

/** 固定步长：60Hz。 */
export const RAIN_FIXED_STEP = 1 / 60;

/** 创建时先空转这么久，让第一帧就有「已经挂了一会儿」的水珠。 */
export const RAIN_WARMUP_SECONDS = 3.8;

const MAX_DT = 0.1;
const MAX_STEPS_PER_FRAME = 8;
/** 单颗水珠的活跃轨迹点上限；按 2.5px 间距约够 550px 路径。 */
export const MAX_TRAIL_POINTS = 220;
/** 同时保留的残留湿痕条数上限，避免长时间运行越积越多。 */
export const MAX_RESIDUAL_TRAILS = 10;
/** 合并后的尺寸上限（相对 baseRadius），避免一颗水珠滚成整屏巨球。 */
const MAX_RADIUS_FACTOR = 1.9;
/** 被吸走的静态珠在 14~19 秒后、且没有水珠压在上面时确定性重新润湿。 */
const WET_RESTORE_MIN_AGE_SECONDS = 14;
const WET_RESTORE_INTERVAL_SECONDS = 1.4;
const WET_RESTORE_SAFE_GAP_PX = 18;

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

/** 当前阶段“只靠自然积聚”应有的半径（不含吸进来的额外面积）。 */
function naturalRadius(drop: RainDropState, cycle: RainDynamicCycle): number {
  if (drop.phase === 'attached') {
    const progress = clamp(drop.phaseTime / cycle.attachSeconds, 0, 1);
    return drop.baseRadius * (0.55 + 0.45 * easeOutCubic(progress));
  }
  // 释放后本体已经长满；之后只靠 absorbedArea 变大。
  return drop.baseRadius;
}

/** 把自然成长和吸收面积合成当前半径，并统一收上限。 */
function syncRadius(drop: RainDropState, cycle: RainDynamicCycle): void {
  const natural = naturalRadius(drop, cycle);
  const maxRadius = drop.baseRadius * MAX_RADIUS_FACTOR;
  drop.radius = Math.min(
    maxRadius,
    Math.sqrt(natural * natural + Math.max(0, drop.absorbedArea)),
  );
}

/**
 * 本次滑行应该显示/保留多长的湿路（CSS px）。
 *
 * 基础长度来自这一轮布局，再按**稳定速度参数**把快速滑过的长路径补足；窗口高一点也略长。
 * 夹在 180~450 之间：既不会只留一小截，也不会变成跨半屏的粗线。
 *
 * 注意：活跃绘制和 detach 必须传同一个稳定速度（见 `dynamicTrailLengthForCycle`），
 * 不能传当前瞬时 speed；否则钉点停顿 speed=0 时长度会瞬间从 308 缩到 198。
 */
export function dynamicTrailLengthPx(
  baseLengthPx: number,
  speedPxPerSec: number,
  viewportHeight: number,
): number {
  const base = Number.isFinite(baseLengthPx) ? Math.max(0, baseLengthPx) : 220;
  const speed = Number.isFinite(speedPxPerSec) ? Math.max(0, speedPxPerSec) : 0;
  const viewportFactor = clamp(
    (Number.isFinite(viewportHeight) ? viewportHeight : 900) / 900,
    0.9,
    1.2,
  );
  return Math.round(Math.min(450, Math.max(180, (base + speed * 0.7) * viewportFactor)));
}

/**
 * 一轮 lifecycle 内固定的水迹长度上限。
 *
 * `maxSpeed` 在整轮里不变，所以加速、减速、钉点停顿、合并、自然滑出交接都得到
 * 同一个可见范围；旧残迹只按自己的 age 淡出，不会因为当前 speed=0 被截短。
 */
export function dynamicTrailLengthForCycle(
  cycle: Pick<RainDynamicCycle, 'trailLengthPx' | 'maxSpeed'>,
  viewportHeight: number,
): number {
  return dynamicTrailLengthPx(cycle.trailLengthPx, cycle.maxSpeed, viewportHeight);
}

/**
 * 水滴后方需要空出的距离（CSS px）。
 *
 * 这个间隙从**水滴中心**算起，比水滴半径再多 6~10px。没有它，湿迹会直接从
 * 本体中心连出来，视觉上就是“圆头 + 尾巴”。活跃绘制和 detach 共用同一个值，
 * 所以交接时可见起点不会跳。
 */
export function dynamicTrailHeadGapPx(radiusPx: number): number {
  const radius = Number.isFinite(radiusPx) ? Math.max(0, radiusPx) : 0;
  return Math.min(36, Math.max(12, radius * 1.15 + 6));
}

/**
 * 从点列尾部（头部）往回取：先跳过 headGapPx，再截出最多 maxLengthPx。
 * 返回旧→新；不修改入参。canvas 活跃绘制和 residual 交接共用同一套裁剪。
 */
export function trimTrailPoints<T extends { x: number; y: number }>(
  points: readonly T[],
  maxLengthPx: number,
  headGapPx = 0,
): T[] {
  if (points.length < 2) return [];
  let end = points.length - 1;
  let gap = 0;
  while (end > 0 && gap < headGapPx) {
    const a = points[end];
    const b = points[end - 1];
    if (!a || !b) {
      end -= 1;
      continue;
    }
    gap += Math.hypot(a.x - b.x, a.y - b.y);
    end -= 1;
  }
  if (end <= 0 && headGapPx > 0) return [];

  const kept: T[] = [];
  let distance = 0;
  for (let index = end; index >= 0; index -= 1) {
    const point = points[index];
    if (!point) continue;
    const next = kept[0];
    if (next) distance += Math.hypot(next.x - point.x, next.y - point.y);
    if (distance > maxLengthPx && kept.length > 0) break;
    kept.unshift(point);
  }
  return kept;
}

function detachTrail(
  state: RainSimulationState,
  drop: RainDropState,
  cycle: RainDynamicCycle,
): void {
  if (drop.trail.length < 2) return;
  // 用整轮稳定的 maxSpeed，而不是交接瞬间的 speed；这样自然滑出/吞并时
  // 可见范围与停顿前完全一致。
  const maxLengthPx = dynamicTrailLengthForCycle(cycle, state.viewport.height);
  const headGapPx = dynamicTrailHeadGapPx(drop.radius);
  const visible = trimTrailPoints(drop.trail, maxLengthPx, headGapPx);
  // 残留是一条独立快照：点年龄清零，之后由 residual.age 统一计时。
  const points = visible.map((point) => ({ ...point, age: 0 }));
  if (points.length < 2) return;
  const fadeSeconds = Math.min(8, Math.max(5, cycle.trailFadeSeconds));
  state.residualTrails.push({ points, age: 0, fadeSeconds, maxLengthPx });
  if (state.residualTrails.length > MAX_RESIDUAL_TRAILS) {
    state.residualTrails.splice(0, state.residualTrails.length - MAX_RESIDUAL_TRAILS);
  }
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
  drop.absorbedArea = 0;
  drop.absorbed = false;
  drop.trail = [];
  drop.mergeFlash = 0;
  drop.mergeCount = 0;
  drop.pauseIndex = 0;
  drop.releaseX = drop.x;
  drop.releaseY = drop.y;
  drop.travelSpan = Math.max(160, viewport.height + 80 - drop.y);
  drop.shape = cycle.shape;
  drop.stageFixedX = undefined;
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
  const lensIds = new Set(layout.lenses.map((lens) => lens.beadId));
  const beadPx: StaticBeadPx[] = layout.beads.map((bead) => ({
    id: bead.id,
    x: (bead.leftPercent / 100) * safeViewport.width,
    y: (bead.topPercent / 100) * safeViewport.height,
    radius: beadRadius(bead.sizePx, sizeScale),
    shape: bead.shape,
    hasLens: lensIds.has(bead.id),
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
      absorbedArea: 0,
      absorbed: false,
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
    consumedLenses: new Set<number>(),
    lensRevision: 0,
    beadConsumedAt: new Map<number, number>(),
    lastWetRestoreAt: -Infinity,
    restoredBeads: 0,
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
  // 活跃轨迹只受“路径长度/点数”限制，不按残留的 5~8 秒去删；否则慢速长滑时
  // 水迹会在本体还在滑的时候就先消失。这里给一个宽松的兜底寿命。
  const maxAge = Math.max(12, cycle.trailFadeSeconds * 2);
  for (const point of drop.trail) point.age += dt;
  while (drop.trail.length > 0 && (drop.trail[0]?.age ?? 0) > maxAge) drop.trail.shift();
}

function beadDirtyExtent(bead: StaticBeadPx): number {
  // 静态珠会按 squash 纵向拉伸、按 tilt 旋转，还有 1.16r 的接触 halo；
  // 脏区按最大可见范围再留 8px，避免大珠擦不干净。
  const squash = clamp(bead.shape.squash, 0.6, 1.6);
  const wobble = 1 + clamp(bead.shape.wobble, 0, 0.12);
  return bead.radius * Math.max(1, squash) * wobble * 1.18 + 8;
}

function absorbBead(
  state: RainSimulationState,
  drop: RainDropState,
  bead: StaticBeadPx,
  cycle: RainDynamicCycle,
): void {
  if (state.consumedBeads.has(bead.id)) return;
  state.consumedBeads.add(bead.id);
  state.beadConsumedAt.set(bead.id, state.time);
  // 吸收的是“面积”，不是直接写当前半径：下一 tick 自然成长公式重算时，这块质量仍会叠加。
  drop.absorbedArea += bead.radius * bead.radius * 0.72;
  syncRadius(drop, cycle);
  // 合并后变重、变快；真正的终端速度在 stepDrop 里由 cycle.maxSpeed 收口。
  drop.speed = Math.min(cycle.maxSpeed, drop.speed + 5.5);
  drop.mergeFlash = Math.min(0.35, drop.mergeFlash + 0.2);
  drop.mergeCount += 1;
  state.merges += 1;
  if (bead.hasLens) {
    state.consumedLenses.add(bead.id);
    state.lensRevision += 1;
  }
  const extent = beadDirtyExtent(bead);
  addDirty(state, bead.x - extent, bead.y - extent, extent * 2, extent * 2);
}

interface ContactEllipse {
  rx: number;
  ry: number;
}

function contactForDrop(
  state: RainSimulationState,
  drop: RainDropState,
  sizeScale: number,
): ContactEllipse {
  const def = state.layout.dynamicDrops[drop.index];
  const cycle = def?.cycles[drop.cycleIndex];
  if (!cycle) return { rx: Math.max(0.5, drop.radius), ry: Math.max(0.5, drop.radius) };
  const metrics = dynamicDropMetrics(
    cycle.baseSizePx * sizeScale,
    drop.radius,
    drop.speed,
    cycle.shape.squash,
  );
  return {
    rx: Math.max(0.5, metrics.width / 2),
    ry: Math.max(0.5, metrics.height / 2),
  };
}

function beadContactRadius(bead: StaticBeadPx): number {
  const squash = clamp(bead.shape.squash, 0.6, 1.6);
  return bead.radius * Math.max(1, squash) * (1 + clamp(bead.shape.wobble, 0, 0.12));
}

/**
 * 相对运动扫掠 + 椭圆归一化距离。
 *
 * 把两个形状的和看成“半径和”的椭圆；沿本步相对位移找最近点。
 * 这样高速水珠跨过对方时，不会因为只看末帧而穿透。
 */
function minSweptNormalizedDistance(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
  rx: number,
  ry: number,
): number {
  const x0 = ax0 - bx0;
  const y0 = ay0 - by0;
  const dx = ax1 - bx1 - x0;
  const dy = ay1 - by1 - y0;
  const ix = 1 / Math.max(0.0001, rx * rx);
  const iy = 1 / Math.max(0.0001, ry * ry);
  const denominator = dx * dx * ix + dy * dy * iy;
  const t =
    denominator > 1e-9
      ? clamp(-(x0 * dx * ix + y0 * dy * iy) / denominator, 0, 1)
      : 0;
  const nx = (x0 + dx * t) / Math.max(0.01, rx);
  const ny = (y0 + dy * t) / Math.max(0.01, ry);
  return Math.hypot(nx, ny);
}

function previousFor(previous: readonly { x: number; y: number }[], index: number, drop: RainDropState) {
  const point = previous[index];
  // 附着/停顿不会移动；刚 respawn 的 finished→attached 也不应拿旧屏幕坐标做扫掠。
  return drop.phase === 'sliding' && point ? point : { x: drop.x, y: drop.y };
}

function dropsTouch(
  state: RainSimulationState,
  a: RainDropState,
  aPrev: { x: number; y: number },
  b: RainDropState,
  bPrev: { x: number; y: number },
  sizeScale: number,
): boolean {
  const ca = contactForDrop(state, a, sizeScale);
  const cb = contactForDrop(state, b, sizeScale);
  return (
    minSweptNormalizedDistance(
      aPrev.x,
      aPrev.y,
      a.x,
      a.y,
      bPrev.x,
      bPrev.y,
      b.x,
      b.y,
      ca.rx + cb.rx,
      ca.ry + cb.ry,
    ) <= 1.002
  );
}

function dropTouchesBead(
  state: RainSimulationState,
  drop: RainDropState,
  previous: { x: number; y: number },
  bead: StaticBeadPx,
  sizeScale: number,
): { touches: boolean; distance: number } {
  const contact = contactForDrop(state, drop, sizeScale);
  const beadReach = beadContactRadius(bead);
  const distance = minSweptNormalizedDistance(
    previous.x,
    previous.y,
    drop.x,
    drop.y,
    bead.x,
    bead.y,
    bead.x,
    bead.y,
    contact.rx + beadReach,
    contact.ry + beadReach,
  );
  return { touches: distance <= 1.002, distance };
}

/** 只合并真正接触的动态实体；按相位/尺寸/索引选唯一存活者，结果不依赖数组顺序。 */
function findDynamicGroups(
  state: RainSimulationState,
  previous: readonly { x: number; y: number }[],
  sizeScale: number,
): RainDropState[][] {
  const activeIndices: number[] = [];
  for (let index = 0; index < state.drops.length; index += 1) {
    const drop = state.drops[index];
    if (drop && drop.phase !== 'finished') activeIndices.push(index);
  }
  const parent = new Map<number, number>();
  for (const index of activeIndices) parent.set(index, index);

  const find = (index: number): number => {
    let current = index;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      if (next === undefined) break;
      current = next;
    }
    return current;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (let first = 0; first < activeIndices.length; first += 1) {
    const ai = activeIndices[first];
    const a = ai === undefined ? undefined : state.drops[ai];
    if (!a || ai === undefined) continue;
    for (let second = first + 1; second < activeIndices.length; second += 1) {
      const bi = activeIndices[second];
      const b = bi === undefined ? undefined : state.drops[bi];
      if (!b || bi === undefined) continue;
      const aPrev = previousFor(previous, ai, a);
      const bPrev = previousFor(previous, bi, b);
      if (dropsTouch(state, a, aPrev, b, bPrev, sizeScale)) union(ai, bi);
    }
  }

  const groups = new Map<number, RainDropState[]>();
  for (const index of activeIndices) {
    const root = find(index);
    const drop = state.drops[index];
    if (!drop) continue;
    const group = groups.get(root) ?? [];
    group.push(drop);
    groups.set(root, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function phaseRank(drop: RainDropState): number {
  if (drop.phase === 'sliding') return 0;
  if (drop.phase === 'paused') return 1;
  return 2;
}

function mergeDynamicGroup(
  state: RainSimulationState,
  group: RainDropState[],
): void {
  const survivor = [...group].sort((a, b) => {
    return (
      phaseRank(a) - phaseRank(b) ||
      b.radius - a.radius ||
      a.index - b.index
    );
  })[0];
  if (!survivor) return;
  const survivorDef = state.layout.dynamicDrops[survivor.index];
  const survivorCycle = survivorDef?.cycles[survivor.cycleIndex];
  if (!survivorCycle) return;

  const others = group.filter((drop) => drop !== survivor);
  // 必须在清被吞者速度之前快照整组最大向下速度；否则读到的全是 0。
  const inheritedSpeed = group.reduce(
    (fastest, drop) => Math.max(fastest, drop.speed),
    0,
  );
  for (const other of others) {
    other.absorbedArea = 0;
    // 被吞者的质量按面积并入存活者；不再有 8 次上限，尺寸用 MAX_RADIUS_FACTOR 收口。
    survivor.absorbedArea += other.radius * other.radius;
    const otherDef = state.layout.dynamicDrops[other.index];
    const otherCycle = otherDef?.cycles[other.cycleIndex];
    if (otherCycle) detachTrail(state, other, otherCycle);
    other.trail = [];
    other.phase = 'finished';
    other.phaseTime = 0;
    other.speed = 0;
    other.opacity = 0;
    other.absorbed = true;
    other.mergeFlash = 0;
    survivor.mergeCount += 1;
    state.merges += 1;
  }

  // 存活者保留自己的位置/路径，不被拉回旧预设 x；只增大面积、继承向下速度。
  syncRadius(survivor, survivorCycle);
  if (survivor.phase === 'sliding') {
    survivor.speed = Math.min(survivorCycle.maxSpeed, inheritedSpeed + 3);
  }
  survivor.mergeFlash = Math.min(0.35, survivor.mergeFlash + 0.2);
  if (survivor.phase === 'attached') {
    const progress = clamp(survivor.phaseTime / survivorCycle.attachSeconds, 0, 1);
    survivor.opacity = dropOpacity('attached', survivor.phaseTime, progress);
  }
}

function absorbStaticBeads(
  state: RainSimulationState,
  previous: readonly { x: number; y: number }[],
  sizeScale: number,
): boolean {
  const candidates: Array<{
    drop: RainDropState;
    bead: StaticBeadPx;
    distance: number;
  }> = [];

  for (let index = 0; index < state.drops.length; index += 1) {
    const drop = state.drops[index];
    if (!drop || drop.phase === 'finished') continue;
    const prev = previousFor(previous, index, drop);
    for (const bead of state.beadPx) {
      if (state.consumedBeads.has(bead.id)) continue;
      const hit = dropTouchesBead(state, drop, prev, bead, sizeScale);
      if (!hit.touches) continue;
      candidates.push({ drop, bead, distance: hit.distance });
    }
  }

  // 同颗静态珠被两颗擦边水珠碰到时，归最近的一颗；避免数组顺序决定归属。
  candidates.sort(
    (a, b) => a.distance - b.distance || a.drop.index - b.drop.index || a.bead.id - b.bead.id,
  );
  let absorbed = false;
  for (const candidate of candidates) {
    if (candidate.drop.phase === 'finished') continue;
    if (state.consumedBeads.has(candidate.bead.id)) continue;
    const def = state.layout.dynamicDrops[candidate.drop.index];
    const cycle = def?.cycles[candidate.drop.cycleIndex];
    if (!cycle) continue;
    absorbBead(state, candidate.drop, candidate.bead, cycle);
    absorbed = true;
  }
  return absorbed;
}

/**
 * 固定步末尾统一处理碰撞：
 * - 动态-动态先找连通组，3 滴连锁也一次成组；
 * - 再处理动态-静态（包括大透镜珠）；
 * - 尺寸变大后可能碰到新目标，所以有界迭代，直到本步没有新的接触。
 */
function resolveCollisions(
  state: RainSimulationState,
  initialPrevious: readonly { x: number; y: number }[],
  sizeScale: number,
): void {
  let previous = initialPrevious.map((point) => ({ ...point }));
  for (let pass = 0; pass < 16; pass += 1) {
    let changed = false;
    const groups = findDynamicGroups(state, previous, sizeScale);
    for (const group of groups) {
      mergeDynamicGroup(state, group);
      changed = true;
    }
    if (absorbStaticBeads(state, previous, sizeScale)) changed = true;
    if (!changed) break;
    // 合并/吸收后位置和尺寸都变了；下一轮用当前坐标，避免重复扫掠整段旧路径。
    previous = state.drops.map((drop) => ({ x: drop.x, y: drop.y }));
  }
}

/**
 * 长时间播放的确定性重新润湿。
 *
 * 静态珠被吃后不会立刻在水滴脚下回来：至少等 14~19 秒、且所有水滴都离它
 * 一个安全距离之外，才恢复一颗。恢复会推进 `lensRevision`，让静态共享场低频重烤；
 * 其他非透镜珠的恢复同样需要重烤，不能只靠动态洞。
 */
function restoreWetBeads(state: RainSimulationState): void {
  if (state.time - state.lastWetRestoreAt < WET_RESTORE_INTERVAL_SECONDS) return;
  for (const bead of state.beadPx) {
    if (!state.consumedBeads.has(bead.id)) continue;
    const consumedAt = state.beadConsumedAt.get(bead.id);
    if (consumedAt === undefined) continue;
    const age = state.time - consumedAt;
    if (age < WET_RESTORE_MIN_AGE_SECONDS + (bead.id % 5)) continue;
    const occupied = state.drops.some((drop) => {
      if (drop.phase === 'finished') return false;
      return (
        Math.hypot(drop.x - bead.x, drop.y - bead.y) <
        drop.radius + bead.radius + WET_RESTORE_SAFE_GAP_PX
      );
    });
    if (occupied) continue;

    state.consumedBeads.delete(bead.id);
    state.beadConsumedAt.delete(bead.id);
    if (bead.hasLens) state.consumedLenses.delete(bead.id);
    // 这里是“重新加入静态场”的事件，不是把 revision 回退；仍只增不减。
    state.lensRevision += 1;
    state.restoredBeads += 1;
    state.lastWetRestoreAt = state.time;
    const extent = beadDirtyExtent(bead);
    addDirty(state, bead.x - extent, bead.y - extent, extent * 2, extent * 2);
    return;
  }
}

function finishExitedDrops(state: RainSimulationState): void {
  for (const drop of state.drops) {
    if (drop.phase !== 'sliding') continue;
    const def = state.layout.dynamicDrops[drop.index];
    const cycle = def?.cycles[drop.cycleIndex];
    if (!cycle) continue;
    if (drop.y - drop.radius > state.viewport.height + 2) {
      detachTrail(state, drop, cycle);
      drop.trail = [];
      drop.phase = 'finished';
      drop.phaseTime = 0;
      drop.speed = 0;
      drop.opacity = 0;
      drop.absorbed = false;
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
    // 被吞并的小滴不能走自然淡出曲线：0.42 秒后它会“复活”成约 0.96 不透明度。
    // 吞并后一直保持不可见，直到 respawn 重置。
    drop.opacity = drop.absorbed ? 0 : dropOpacity('finished', drop.phaseTime, 1);
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
    // 自然成长 + 已吸收面积；再吸收新珠时 absorbBead 会立刻 sync。
    syncRadius(drop, cycle);
    drop.opacity = dropOpacity('attached', drop.phaseTime, progress);
    if (progress >= 1) {
      drop.phase = 'sliding';
      drop.phaseTime = 0;
      // 释放时把自然半径从“成长中”切到“已长满”，吸收面积仍然叠加。
      syncRadius(drop, cycle);
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
  drop.x =
    drop.stageFixedX ??
    (xPercent / 100) * state.viewport.width;

  // 钉点：到点就停。停在**当前实际位置**，不要回退到精确的 at —— 一个 60Hz
  // step 可能刚越过 at 最多约 3px，回退会让已经画出的水迹头部缩短 1~2px。
  const pause = cycle.pauses[drop.pauseIndex];
  if (pause && rawProgress >= pause.at && previousY < drop.y) {
    // 把当前实际位置补进轨迹，停顿时可见范围不缩。
    pushTrail(drop);
    drop.phase = 'paused';
    drop.phaseTime = 0;
    drop.speed = 0;
    drop.opacity = 1;
    return;
  }

  pushTrail(drop);
}

function stepOnce(state: RainSimulationState, dt: number): void {
  state.time += dt;
  const sizeScale = rainSizeScale(state.viewport.width);
  // 先记录上一位置：碰撞扫掠需要它，但绝不能在某颗水珠的 stepDrop 里就地合并。
  const previous = state.drops.map((drop) => ({ x: drop.x, y: drop.y }));
  for (const def of state.layout.dynamicDrops) {
    const drop = state.drops[def.id];
    if (!drop) continue;
    stepDrop(state, drop, def, dt, sizeScale);
  }
  // 所有水滴推进完，统一处理接触/扫掠/链式合并；不受数组顺序或提前 return 影响。
  resolveCollisions(state, previous, sizeScale);
  finishExitedDrops(state);
  restoreWetBeads(state);
  // 残留湿痕：坐标固定，只有自己的 age 在走；到 5~8 秒整条移除。
  for (let index = state.residualTrails.length - 1; index >= 0; index -= 1) {
    const residual = state.residualTrails[index];
    if (!residual) continue;
    residual.age += dt;
    if (residual.age >= residual.fadeSeconds || residual.points.length < 2) {
      state.residualTrails.splice(index, 1);
    }
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

export interface RainReplayDropSnapshot {
  index: number;
  phase: RainDropPhase;
  opacity: number;
  radius: number;
  x: number;
  y: number;
  absorbed: boolean;
  mergeCount: number;
}

export type RainReplayScenario = 'dynamic' | 'static';

export interface RainReplayTargetSnapshot {
  beadId: number;
  x: number;
  y: number;
  radius: number;
  hasLens: boolean;
  consumed: boolean;
}

export interface RainReplaySnapshot {
  time: number;
  scenario: RainReplayScenario;
  note: string;
  visibleDrops: number;
  drops: RainReplayDropSnapshot[];
  target: RainReplayTargetSnapshot | null;
  consumedBeads: number;
  consumedLenses: number;
  merges: number;
  residuals: number;
  lensRevision: number;
}

/** 只读快照；DEV 回放和测试用，不参与渲染。 */
export function snapshotRainReplay(state: RainSimulationState): RainReplaySnapshot {
  const drops = state.drops.map((drop) => ({
    index: drop.index,
    phase: drop.phase,
    opacity: drop.opacity,
    radius: drop.radius,
    x: drop.x,
    y: drop.y,
    absorbed: drop.absorbed,
    mergeCount: drop.mergeCount,
  }));
  const targetId = state.replay?.targetBeadId;
  const targetBead =
    targetId === null || targetId === undefined
      ? undefined
      : state.beadPx.find((bead) => bead.id === targetId);
  return {
    time: state.time,
    scenario: state.replay?.scenario ?? 'dynamic',
    note: state.replay?.note ?? '',
    visibleDrops: drops.filter((drop) => drop.phase !== 'finished' && drop.opacity > 0.02)
      .length,
    drops,
    target: targetBead
      ? {
          beadId: targetBead.id,
          x: targetBead.x,
          y: targetBead.y,
          radius: targetBead.radius,
          hasLens: targetBead.hasLens,
          consumed: state.consumedBeads.has(targetBead.id),
        }
      : null,
    consumedBeads: state.consumedBeads.size,
    consumedLenses: state.consumedLenses.size,
    merges: state.merges,
    residuals: state.residualTrails.length,
    lensRevision: state.lensRevision,
  };
}

function hideOtherReplayDrops(
  state: RainSimulationState,
  keepA: RainDropState,
  keepB: RainDropState | null,
): void {
  for (const drop of state.drops) {
    drop.trail = [];
    drop.mergeFlash = 0;
    drop.mergeCount = 0;
    drop.absorbedArea = 0;
    drop.absorbed = false;
    drop.stageFixedX = undefined;
    if (drop !== keepA && drop !== keepB) {
      drop.phase = 'finished';
      drop.phaseTime = -100000;
      drop.absorbed = true;
      drop.opacity = 0;
      drop.speed = 0;
    }
  }
  state.residualTrails.length = 0;
}

function corridorStaticCount(
  state: RainSimulationState,
  x: number,
  top: number,
  bottom: number,
  halfWidth: number,
): number {
  let count = 0;
  for (const bead of state.beadPx) {
    if (state.consumedBeads.has(bead.id)) continue;
    if (bead.y < top || bead.y > bottom) continue;
    if (Math.abs(bead.x - x) <= halfWidth + bead.radius) count += 1;
  }
  return count;
}

function hideCorridorStaticBeads(
  state: RainSimulationState,
  x: number,
  top: number,
  bottom: number,
  halfWidth: number,
): number {
  let hidden = 0;
  for (const bead of state.beadPx) {
    if (state.consumedBeads.has(bead.id)) continue;
    if (bead.y < top || bead.y > bottom) continue;
    if (Math.abs(bead.x - x) > halfWidth + bead.radius) continue;
    state.consumedBeads.add(bead.id);
    if (bead.hasLens) {
      state.consumedLenses.add(bead.id);
      state.lensRevision += 1;
    }
    const extent = beadDirtyExtent(bead);
    addDirty(state, bead.x - extent, bead.y - extent, extent * 2, extent * 2);
    hidden += 1;
  }
  return hidden;
}

function pickClearReplayX(
  state: RainSimulationState,
  yTop: number,
  yBottom: number,
  halfWidth: number,
  preferredX: number,
): { x: number; corridor: number } {
  const width = state.viewport.width;
  const candidates = [
    preferredX,
    width * 0.12,
    width * 0.18,
    width * 0.24,
    width * 0.76,
    width * 0.82,
    width * 0.88,
  ];
  let best = { x: preferredX, corridor: Number.POSITIVE_INFINITY };
  for (const candidate of candidates) {
    const x = clamp(candidate, 24, width - 24);
    const corridor = corridorStaticCount(state, x, yTop, yBottom, halfWidth);
    if (corridor < best.corridor) best = { x, corridor };
  }
  return best;
}

/**
 * DEV-only controlled replay:
 * - `dynamic`（默认）：一颗滑动滴在约 0.9 秒内追上暂停滴，2 → 1；
 * - `static`：一颗真实布局里的未消费大透镜珠，动态滴从上方约 90px 同 x 逼近并吞掉它。
 *
 * 其他动态滴冻结到 finished；静态珠不伪造、不清空，static 目标直接用
 * `state.beadPx` 里的真实透镜珠。碰撞/吸收仍走正常 step。
 * `stageFixedX` 只固定 DEV 回放的横向路径，避免 cycle 漂移让受控相遇跑偏。
 */
export function stageControlledMergeReplay(
  state: RainSimulationState,
  scenario: RainReplayScenario = 'dynamic',
): RainReplaySnapshot | null {
  const first = state.drops[0];
  if (!first) return null;
  const sizeScale = rainSizeScale(state.viewport.width);
  const height = state.viewport.height;
  const width = state.viewport.width;
  const second = state.drops[1] ?? null;

  if (scenario === 'static') {
    hideOtherReplayDrops(state, first, null);
    // 目标必须是当前真实布局里、尚未被吃、仍有静态透镜的珠。
    const targetCandidates = state.beadPx
      .filter(
        (bead) =>
          bead.hasLens &&
          !state.consumedBeads.has(bead.id) &&
          // 大透镜珠（layout 的 9.2~20.5px 大珠）；中等透镜留给普通动态合并。
          bead.radius >= 3.8 &&
          bead.y > 150 &&
          bead.y < height - 100 &&
          bead.x > 20 &&
          bead.x < width - 20,
      )
      .map((bead) => {
        const radiusDrop = Math.max(8, Math.min(14, (bead.radius + 8)));
        const top = bead.y - (radiusDrop + bead.radius + 80) - 30;
        const corridor = corridorStaticCount(
          state,
          bead.x,
          top,
          bead.y - 2,
          radiusDrop + 12,
        );
        return { bead, radiusDrop, corridor };
      })
      .sort(
        (a, b) =>
          a.corridor - b.corridor ||
          b.bead.radius - a.bead.radius ||
          b.bead.y - a.bead.y,
      );
    const chosen = targetCandidates[0];
    if (!chosen) {
      first.phase = 'finished';
      first.phaseTime = -100000;
      first.absorbed = true;
      first.opacity = 0;
      first.speed = 0;
      first.stageFixedX = undefined;
      state.replay = {
        scenario,
        targetBeadId: null,
        note: 'no unconsumed large lens bead available',
      };
      return snapshotRainReplay(state);
    }
    const { bead: target, radiusDrop, corridor } = chosen;
    const startY = target.y - (radiusDrop + target.radius + 80);
    first.phase = 'sliding';
    first.phaseTime = 0;
    // 80px + 20px/s 初速，在现有 92~186 重力下约 0.8~1.0 秒。
    first.speed = 20;
    first.opacity = 1;
    first.x = target.x;
    first.y = Math.max(24, startY);
    first.radius = radiusDrop;
    first.baseRadius = radiusDrop;
    first.absorbedArea = 0;
    first.absorbed = false;
    first.pauseIndex = 0;
    first.trail = [];
    first.releaseX = first.x;
    first.releaseY = first.y;
    first.travelSpan = 1000;
    first.stageFixedX = target.x;
    state.replay = {
      scenario,
      targetBeadId: target.id,
      note: `real layout lens bead; target hasLens=${target.hasLens}; corridorStaticBeads=${corridor}; other static beads remain visible`,
    };
    return snapshotRainReplay(state);
  }

  if (!second) return null;
  const secondDef = state.layout.dynamicDrops[second.index];
  const secondCycle = secondDef?.cycles[second.cycleIndex];
  if (!secondCycle) return null;
  hideOtherReplayDrops(state, first, second);
  const radiusA = Math.max(8, Math.min(14, (secondCycle.baseSizePx * sizeScale) / 2));
  const radiusB = Math.max(7, Math.min(13, radiusA * 0.8));
  const bY = height * 0.28;
  const aY = bY + radiusA + radiusB + 90;
  const picked = pickClearReplayX(
    state,
    bY - 30,
    aY + 30,
    Math.max(radiusA, radiusB) + 14,
    (secondCycle.startLeftPercent / 100) * width,
  );
  // 动态回放只清掉这条通道里的无关静态珠；dirty/透镜 revision 同步，其余静态照常。
  const hiddenStatic = hideCorridorStaticBeads(
    state,
    picked.x,
    bY - 30,
    aY + 30,
    Math.max(radiusA, radiusB) + 14,
  );

  first.phase = 'paused';
  first.phaseTime = -100000;
  first.speed = 0;
  first.opacity = 1;
  first.x = picked.x;
  first.y = aY;
  first.radius = radiusA;
  first.baseRadius = radiusA;
  first.absorbedArea = 0;
  first.absorbed = false;
  first.pauseIndex = 0;
  first.releaseX = first.x;
  first.releaseY = first.y;
  first.travelSpan = Math.max(160, height + 80 - first.y);
  first.stageFixedX = picked.x;

  second.phase = 'sliding';
  second.phaseTime = 0;
  // 从静止起走真实 gravity，90px 约 0.8 秒接近。
  second.speed = 0;
  second.opacity = 1;
  second.x = picked.x;
  second.y = bY;
  second.radius = radiusB;
  second.baseRadius = radiusB;
  second.absorbedArea = 0;
  second.absorbed = false;
  second.pauseIndex = 0;
  second.releaseX = picked.x;
  second.releaseY = bY;
  second.travelSpan = 1000;
  second.stageFixedX = picked.x;
  second.trail = [];

  state.replay = {
    scenario,
    targetBeadId: null,
    note: `dynamic approach surface gap=${aY - bY - radiusA - radiusB}px; corridorStaticBeads=${picked.corridor}; hiddenStaticBeads=${hiddenStatic}; fixed stage x`,
  };
  return snapshotRainReplay(state);
}
