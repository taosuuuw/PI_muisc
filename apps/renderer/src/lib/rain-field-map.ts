import { dynamicDropMetrics, rainSizeScale, type RainLayout, type RainShape } from './rain-layout';
import { rainBlobRadiusScale } from './rain-shape';
import { LENS_FILTER_SCALE } from './rain-lens-map';
import {
  dynamicTrailHeadGapPx,
  dynamicTrailLengthForCycle,
  trimTrailPoints,
  type RainSimulationState,
} from './rain-simulation';

/**
 * 共享水体场图。
 *
 * 这是这一版光学架构的核心：不再给「2 颗动态 + 65 颗静态」单独做透镜，而是把
 * **全部可见静态珠**画进一张低频静态场，把**全部可见滑滴 + 水路**画进一张节流动态场。
 *
 * 通道约定（faDisplacementMap + coverage）：
 * - R/G：法线偏折方向，128 为中性；
 * - B：水体 coverage，0 = 无水，255 = 水体内；滤镜把 B 提成 alpha，用它在
 *   “略柔的玻璃背景”和“水珠内清晰折射”之间合成；
 * - A：静态场全不透明；动态场外部透明、洞/水体内部不透明，叠在静态场上面。
 *
 * 外面的法线永远是中性 RG+B0，不会让无水区域整屏偏移。
 */

export const FIELD_NEUTRAL = 128;

export const TRANSPARENT_FIELD_URL =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="none"/></svg>',
  );

export interface RainFieldSize {
  width: number;
  height: number;
}

export interface RainFieldBuild {
  url: string;
  mapWidth: number;
  mapHeight: number;
  coveragePixels: number;
  coveredBeads: number;
  coveredDrops: number;
  coveredTrails: number;
  buildMs: number;
}

export interface RainFieldPixelsResult {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  coveragePixels: number;
  coveredBeads: number;
  coveredDrops: number;
  coveredTrails: number;
}

/** 单张 combined 场的静态原图；按 seed+viewport 只准备一次。 */
export interface RainFieldBase extends RainFieldPixelsResult {
  mapWidth: number;
  mapHeight: number;
  prepareMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 静态场用全分辨率（<=1600px），4K 才降一档；所有微珠都要留下 coverage。 */
export function staticFieldDivisor(width: number): number {
  return width > 1800 ? 2 : 1;
}

/** 动态场比分批编码；半分辨率在 1182 宽下约 591×386。 */
export function dynamicFieldDivisor(width: number): number {
  // 30Hz 的单张半屏 PNG 编码是主瓶颈；目标窗宽取 1/3，法线仍由浏览器放大。
  return width > 1800 ? 4 : 3;
}

function mapSize(viewport: RainFieldSize, divisor: number): RainFieldSize {
  return {
    width: Math.max(1, Math.round(viewport.width / divisor)),
    height: Math.max(1, Math.round(viewport.height / divisor)),
  };
}

interface FieldStampOptions {
  /** 希望的最大像素偏折；内部会换算成 0~127 的 R/G。 */
  targetOffsetPx: number;
  /** 水体内部的 alpha 系数；洞用 1。 */
  opacity: number;
  /** 洞：水体区域写中性 RG/B0/A255，用来抹掉静态场旧透镜。 */
  neutralHole: boolean;
  /** 静态场 A 固定 255；动态场 A 由 coverage*opacity 得出。 */
  staticAlpha: boolean;
  tiltDeg: number;
  shape: RainShape;
  radiusX: number;
  radiusY: number;
  cx: number;
  cy: number;
}

function stampBlob(
  data: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  options: FieldStampOptions,
  countCoverage: (amount: number) => void,
): void {
  const { cx, cy, radiusX, radiusY, shape } = options;
  if (radiusX < 0.1 || radiusY < 0.1) return;
  const maxRadius = Math.max(radiusX, radiusY) * (1 + shape.wobble) * 1.16;
  const minX = Math.max(0, Math.floor(cx - maxRadius));
  const maxX = Math.min(width - 1, Math.ceil(cx + maxRadius));
  const minY = Math.max(0, Math.floor(cy - maxRadius));
  const maxY = Math.min(height - 1, Math.ceil(cy + maxRadius));
  if (minX > maxX || minY > maxY) return;
  const angle = (options.tiltDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const maxOffset = clamp(
    Math.round((options.targetOffsetPx / LENS_FILTER_SCALE) * 255),
    1,
    127,
  );
  let covered = 0;

  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      /*
       * 顺序必须是「先在屏幕坐标上逆旋转，再分别除 radiusX/radiusY」。
       * canvas 是 rotate(tilt) 后 scale(1,squash)；先归一化再旋转会让倾斜扁珠
       * 的场图和 canvas 壳错位，这是上一版的真实 bug。
       */
      const screenDx = px + 0.5 - cx;
      const screenDy = py + 0.5 - cy;
      const rotatedX = screenDx * cos + screenDy * sin;
      const rotatedY = -screenDx * sin + screenDy * cos;
      const lx = rotatedX / radiusX;
      const ly = rotatedY / radiusY;
      const dist = Math.hypot(lx, ly);
      if (dist > 1.2) continue;
      const localAngle = Math.atan2(ly, lx);
      const edge = rainBlobRadiusScale(shape, localAngle);
      const q = dist / edge;
      if (q > 1) continue;
      // 内部 coverage 接近实心；只在最外缘软收，不能再稀释成淡轮廓。
      const coverage = q <= 0.9 ? 1 : (1 - q) / 0.1;
      if (coverage <= 0.01) continue;
      const index = (py * width + px) * 4;
      if (options.neutralHole) {
        data[index] = FIELD_NEUTRAL;
        data[index + 1] = FIELD_NEUTRAL;
        data[index + 2] = 0;
        data[index + 3] = 255;
        covered += coverage;
        continue;
      }

      // 凸透镜采样向中心；R/G 符号不能向外，否则只会读出“外凸但空”的灰壳。
      const nx = dist > 0.0001 ? lx / dist : 0;
      const ny = dist > 0.0001 ? ly / dist : 0;
      const screenNx = nx * cos - ny * sin;
      const screenNy = nx * sin + ny * cos;
      const fade = q <= 0.84 ? 1 : (1 - q) / 0.16;
      const magnitude = maxOffset * Math.pow(q, 1.12) * fade * 1.08;
      const alpha = options.staticAlpha ? 1 : coverage * options.opacity;
      const b = Math.round(coverage * options.opacity * 255);
      if (b <= (data[index + 2] ?? 0) && alpha <= (data[index + 3] ?? 0) / 255) continue;
      data[index] = Math.round(FIELD_NEUTRAL - screenNx * magnitude);
      data[index + 1] = Math.round(FIELD_NEUTRAL - screenNy * magnitude);
      data[index + 2] = Math.max(data[index + 2] ?? 0, b);
      data[index + 3] = Math.max(
        data[index + 3] ?? 0,
        Math.round(alpha * 255),
      );
      covered += coverage;
    }
  }
  if (covered > 0) countCoverage(covered);
}

interface TrailPointLike {
  x: number;
  y: number;
  age: number;
  size: number;
}

function stampWetPath(
  data: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  points: readonly TrailPointLike[],
  halfWidth: number,
  targetOffsetPx: number,
  strength: number,
  alphaScale: number,
  countCoverage: (amount: number) => void,
): void {
  if (points.length < 2 || halfWidth < 0.2 || strength <= 0) return;
  const widthPx = Math.max(0.55, halfWidth);
  const maxOffset = clamp(
    Math.round((targetOffsetPx / LENS_FILTER_SCALE) * 255),
    1,
    80,
  );
  let covered = 0;

  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const length = Math.sqrt(lengthSq);
    if (length < 0.02) continue;
    const nx = -dy / length;
    const ny = dx / length;
    const extent = widthPx + 1.2;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - extent));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + extent));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - extent));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + extent));
    const ageFraction = clamp(a.age, 0, 1);

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const qx = px + 0.5 - a.x;
        const qy = py + 0.5 - a.y;
        const t = lengthSq > 0 ? clamp((qx * dx + qy * dy) / lengthSq, 0, 1) : 0;
        const cx = a.x + dx * t;
        const cy = a.y + dy * t;
        const dist = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
        if (dist > widthPx) continue;
        const profile = Math.pow(1 - dist / widthPx, 1.35);
        const coverage = profile * strength * (1 - ageFraction * 0.55);
        if (coverage <= 0.01) continue;
        const index = (py * width + px) * 4;
        const bValue = Math.round(coverage * 255);
        const alpha = Math.min(1, coverage * alphaScale);
        if (bValue <= (data[index + 2] ?? 0) && alpha <= (data[index + 3] ?? 0) / 255) {
          continue;
        }
        data[index] = Math.round(FIELD_NEUTRAL + nx * maxOffset * profile);
        data[index + 1] = Math.round(FIELD_NEUTRAL + ny * maxOffset * profile);
        data[index + 2] = Math.max(data[index + 2] ?? 0, bValue);
        data[index + 3] = Math.max(data[index + 3] ?? 0, Math.round(alpha * 255));
        covered += coverage;
      }
    }
  }
  countCoverage(covered);
}

function createStaticPixels(width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let index = 0; index < data.length; index += 4) {
    data[index] = FIELD_NEUTRAL;
    data[index + 1] = FIELD_NEUTRAL;
    data[index + 2] = 0;
    data[index + 3] = 255;
  }
  return data;
}

function createDynamicPixels(width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let index = 0; index < data.length; index += 4) {
    data[index] = FIELD_NEUTRAL;
    data[index + 1] = FIELD_NEUTRAL;
    data[index + 2] = 0;
    data[index + 3] = 0;
  }
  return data;
}

function uniqueCoveragePixels(data: Uint8ClampedArray<ArrayBuffer>): number {
  let count = 0;
  // B 是 coverage；低于阈值只是抗锯齿边，不算实际水体 footprint。
  for (let index = 2; index < data.length; index += 4) {
    if ((data[index] ?? 0) > 16) count += 1;
  }
  return count;
}

function staticTrailPoints(
  trail: RainLayout['trails'][number],
  scale: number,
  mapScale: number,
): TrailPointLike[] {
  const length = Math.min(trail.lengthPx * scale, 190);
  const points: TrailPointLike[] = [];
  for (let index = 0; index <= 18; index += 1) {
    const t = index / 18;
    const x =
      trail.curvePx * scale * t * t +
      trail.wavePx * scale * Math.sin(t * Math.PI * 2 + trail.wavePhase) * t * (1 - t);
    points.push({
      x: x * mapScale,
      y: length * t * mapScale,
      age: 0,
      size: trail.widthPx * scale,
    });
  }
  return points;
}

/** 纯像素静态场：测试和浏览器共用，不依赖 DOM。 */
export function buildStaticRainFieldPixels(
  layout: RainLayout,
  viewport: RainFieldSize,
  map: RainFieldSize,
): RainFieldPixelsResult {
  const width = Math.max(1, Math.round(map.width));
  const height = Math.max(1, Math.round(map.height));
  const data = createStaticPixels(width, height);
  const scale = rainSizeScale(Math.max(1, viewport.width));
  const mapScale = width / Math.max(1, viewport.width);
  const yScale = height / Math.max(1, viewport.height);
  let coveragePixels = 0;
  let coveredBeads = 0;
  let coveredTrails = 0;
  const count = (amount: number): void => {
    coveragePixels += Math.max(1, Math.round(amount));
  };

  for (const trail of layout.trails) {
    const points = staticTrailPoints(trail, scale, mapScale).map((point) => ({
      ...point,
      x: point.x + (trail.leftPercent / 100) * width,
      y: point.y + (trail.topPercent / 100) * height,
    }));
    if (points.length > 1) {
      stampWetPath(
        data,
        width,
        height,
        points,
        Math.max(0.8, trail.widthPx * scale * mapScale * 0.8),
        3.2,
        Math.min(0.58, trail.opacity * 2.5),
        0.7,
        count,
      );
      coveredTrails += 1;
    }
  }

  for (const bead of layout.beads) {
    const cx = (bead.leftPercent / 100) * width;
    const cy = (bead.topPercent / 100) * height;
    const radius = (bead.sizePx * scale) / 2;
    stampBlob(
      data,
      width,
      height,
      {
        cx,
        cy,
        radiusX: radius * mapScale,
        // canvas 用 ctx.scale(1, squash) 画同一颗珠；场图这里也把纵向半径乘上 squash。
        radiusY: radius * yScale * clamp(bead.shape.squash, 0.6, 1.6),
        shape: bead.shape,
        tiltDeg: bead.shape.tiltDeg,
        // 尺寸直接决定偏折；小珠也能产生局部翻转，大珠足够明显。
        targetOffsetPx: clamp(bead.sizePx * 0.68, 2.5, 24),
        opacity: 1,
        neutralHole: false,
        staticAlpha: true,
      },
      count,
    );
    coveredBeads += 1;
  }
  coveragePixels = uniqueCoveragePixels(data);
  return {
    pixels: data,
    coveragePixels,
    coveredBeads,
    coveredDrops: 0,
    coveredTrails,
  };
}

/** 纯像素动态场：洞、动态水路、全部可见滑滴。 */
export function buildDynamicRainFieldPixels(
  state: RainSimulationState,
  map: RainFieldSize,
): RainFieldPixelsResult {
  const width = Math.max(1, Math.round(map.width));
  const height = Math.max(1, Math.round(map.height));
  const data = createDynamicPixels(width, height);
  const viewport = state.viewport;
  const mapScale = width / Math.max(1, viewport.width);
  const yScale = height / Math.max(1, viewport.height);
  const scale = rainSizeScale(Math.max(1, viewport.width));
  let coveragePixels = 0;
  let coveredDrops = 0;
  let coveredTrails = 0;
  const count = (amount: number): void => {
    coveragePixels += Math.max(1, Math.round(amount));
  };

  // 1) 先放已消费静态珠的中性洞：静态场还没重烤时也不会留幽灵透镜。
  for (const bead of state.beadPx) {
    if (!state.consumedBeads.has(bead.id)) continue;
    const radius = bead.radius;
    stampBlob(
      data,
      width,
      height,
      {
        cx: bead.x * mapScale,
        cy: bead.y * yScale,
        radiusX: radius * mapScale * 1.06,
        radiusY: radius * yScale * 1.06,
        shape: bead.shape,
        tiltDeg: bead.shape.tiltDeg,
        targetOffsetPx: 1,
        opacity: 1,
        neutralHole: true,
        staticAlpha: true,
      },
      count,
    );
  }

  // 2) 全部可见滑滴的活跃水路 + 已交接残留水路。
  for (const drop of state.drops) {
    const def = state.layout.dynamicDrops[drop.index];
    const cycle = def?.cycles[drop.cycleIndex];
    if (!cycle) continue;
    if (drop.phase !== 'finished' && drop.trail.length >= 2) {
      const maxLength = dynamicTrailLengthForCycle(cycle, viewport.height);
      const visible = trimTrailPoints(drop.trail, maxLength, dynamicTrailHeadGapPx(drop.radius));
      const points = visible.map((point) => ({
        x: point.x * mapScale,
        y: point.y * yScale,
        age: 0,
        size: point.size,
      }));
      stampWetPath(
        data,
        width,
        height,
        points,
        Math.max(1.3, drop.radius * 0.25) * mapScale,
        3.4,
        0.62,
        0.78,
        count,
      );
      coveredTrails += 1;
    }
  }
  for (const residual of state.residualTrails) {
    const points = residual.points.map((point) => ({
      x: point.x * mapScale,
      y: point.y * yScale,
      age: residual.age / Math.max(0.001, residual.fadeSeconds),
      size: point.size,
    }));
    stampWetPath(
      data,
      width,
      height,
      points,
      Math.max(1.2, residual.points[0]?.size ? residual.points[0].size * 0.1 : 1.4) *
        mapScale,
      3,
      0.5,
      0.68,
      count,
    );
    coveredTrails += 1;
  }

  // 3) 全部可见动态水滴本体。
  for (const drop of state.drops) {
    if (drop.phase === 'finished' || drop.opacity <= 0.02) continue;
    const def = state.layout.dynamicDrops[drop.index];
    const cycle = def?.cycles[drop.cycleIndex];
    if (!cycle) continue;
    const baseDiameter = cycle.baseSizePx * scale;
    const metrics = dynamicDropMetrics(
      baseDiameter,
      drop.radius,
      drop.speed,
      cycle.shape.squash,
    );
    if (metrics.width < 1 || metrics.height < 1) continue;
    stampBlob(
      data,
      width,
      height,
      {
        cx: drop.x * mapScale,
        cy: drop.y * yScale,
        radiusX: (metrics.width / 2) * mapScale,
        radiusY: (metrics.height / 2) * yScale,
        shape: cycle.shape,
        tiltDeg: 0,
        targetOffsetPx: clamp(
          Math.max(metrics.width, metrics.height) * 0.68,
          3,
          24,
        ),
        opacity: 1,
        neutralHole: false,
        staticAlpha: false,
      },
      count,
    );
    coveredDrops += 1;
  }

  coveragePixels = uniqueCoveragePixels(data);
  return {
    pixels: data,
    coveragePixels,
    coveredBeads: 0,
    coveredDrops,
    coveredTrails,
  };
}

/**
 * 单张 combined 场：
 * - 1184 级目标窗口用 1/3（395 宽），降低 CPU copy/stamp 预算；
 * - <=1000 的小窗口仍保持 1/2；
 * - 4K 继续降到 1/4，至少不比旧分辨率更高。
 */
export function combinedFieldDivisor(width: number): number {
  if (width > 2400) return 4;
  if (width > 1000) return 3;
  return 2;
}

export function combinedFieldMapSize(viewport: RainFieldSize): RainFieldSize {
  return mapSize(viewport, combinedFieldDivisor(viewport.width));
}

/** 一次性生成全部静态珠/静态水路的 RG+B 原图；之后的批次只 copy。 */
export function prepareCombinedRainFieldBase(
  layout: RainLayout,
  viewport: RainFieldSize,
): RainFieldBase {
  const started = typeof performance === 'undefined' ? 0 : performance.now();
  const map = combinedFieldMapSize(viewport);
  const result = buildStaticRainFieldPixels(layout, viewport, map);
  return {
    ...result,
    mapWidth: map.width,
    mapHeight: map.height,
    prepareMs: (typeof performance === 'undefined' ? 0 : performance.now()) - started,
  };
}

/**
 * 单张 combined 场的逐批像素：
 * 从缓存静态原图 copy，再覆写消费洞、动态水路和全部可见水滴。
 * 不会重新绘 700 颗静态珠，也不会产生第二张动态图。
 */
export function buildCombinedRainFieldPixels(
  base: RainFieldBase,
  state: RainSimulationState,
): RainFieldPixelsResult {
  const width = base.mapWidth;
  const height = base.mapHeight;
  const data = new Uint8ClampedArray(base.pixels);
  const viewport = state.viewport;
  const mapScale = width / Math.max(1, viewport.width);
  const yScale = height / Math.max(1, viewport.height);
  const scale = rainSizeScale(Math.max(1, viewport.width));
  let coveragePixels = 0;
  let coveredDrops = 0;
  let coveredTrails = 0;
  const count = (amount: number): void => {
    coveragePixels += Math.max(1, Math.round(amount));
  };

  for (const bead of state.beadPx) {
    if (!state.consumedBeads.has(bead.id)) continue;
    const radius = bead.radius;
    stampBlob(
      data,
      width,
      height,
      {
        cx: bead.x * mapScale,
        cy: bead.y * yScale,
        radiusX: radius * mapScale * 1.06,
        radiusY: radius * yScale * 1.06,
        shape: bead.shape,
        tiltDeg: bead.shape.tiltDeg,
        targetOffsetPx: 1,
        opacity: 1,
        neutralHole: true,
        staticAlpha: true,
      },
      count,
    );
  }

  for (const drop of state.drops) {
    const def = state.layout.dynamicDrops[drop.index];
    const cycle = def?.cycles[drop.cycleIndex];
    if (!cycle) continue;
    if (drop.phase !== 'finished' && drop.trail.length >= 2) {
      const maxLength = dynamicTrailLengthForCycle(cycle, viewport.height);
      const visible = trimTrailPoints(drop.trail, maxLength, dynamicTrailHeadGapPx(drop.radius));
      const points = visible.map((point) => ({
        x: point.x * mapScale,
        y: point.y * yScale,
        age: 0,
        size: point.size,
      }));
      stampWetPath(
        data,
        width,
        height,
        points,
        Math.max(1.3, drop.radius * 0.25) * mapScale,
        3.4,
        0.62,
        0.78,
        count,
      );
      coveredTrails += 1;
    }
  }
  for (const residual of state.residualTrails) {
    const points = residual.points.map((point) => ({
      x: point.x * mapScale,
      y: point.y * yScale,
      age: residual.age / Math.max(0.001, residual.fadeSeconds),
      size: point.size,
    }));
    stampWetPath(
      data,
      width,
      height,
      points,
      Math.max(1.2, residual.points[0]?.size ? residual.points[0].size * 0.1 : 1.4) *
        mapScale,
      3,
      0.5,
      0.68,
      count,
    );
    coveredTrails += 1;
  }

  for (const drop of state.drops) {
    if (drop.phase === 'finished' || drop.opacity <= 0.02) continue;
    const def = state.layout.dynamicDrops[drop.index];
    const cycle = def?.cycles[drop.cycleIndex];
    if (!cycle) continue;
    const baseDiameter = cycle.baseSizePx * scale;
    const metrics = dynamicDropMetrics(
      baseDiameter,
      drop.radius,
      drop.speed,
      cycle.shape.squash,
    );
    if (metrics.width < 1 || metrics.height < 1) continue;
    stampBlob(
      data,
      width,
      height,
      {
        cx: drop.x * mapScale,
        cy: drop.y * yScale,
        radiusX: (metrics.width / 2) * mapScale,
        radiusY: (metrics.height / 2) * yScale,
        shape: cycle.shape,
        tiltDeg: 0,
        targetOffsetPx: clamp(
          Math.max(metrics.width, metrics.height) * 0.68,
          3,
          24,
        ),
        opacity: 1,
        neutralHole: false,
        staticAlpha: true,
      },
      count,
    );
    coveredDrops += 1;
  }

  return {
    pixels: data,
    coveragePixels: uniqueCoveragePixels(data),
    coveredBeads: base.coveredBeads,
    coveredDrops,
    coveredTrails,
  };
}

let staticCanvas: HTMLCanvasElement | null = null;
let dynamicCanvas: HTMLCanvasElement | null = null;

function encodeField(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  dynamic: boolean,
): string {
  if (typeof document === 'undefined') return TRANSPARENT_FIELD_URL;
  const canvas = dynamic ? dynamicCanvas : staticCanvas;
  const target = canvas ?? document.createElement('canvas');
  target.width = width;
  target.height = height;
  const ctx = target.getContext('2d');
  if (!ctx) return TRANSPARENT_FIELD_URL;
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  if (dynamic) dynamicCanvas = target;
  else staticCanvas = target;
  return target.toDataURL('image/png');
}

export function buildStaticRainField(
  layout: RainLayout,
  viewport: RainFieldSize,
): RainFieldBuild {
  const started = typeof performance === 'undefined' ? 0 : performance.now();
  const divisor = staticFieldDivisor(viewport.width);
  const map = mapSize(viewport, divisor);
  const result = buildStaticRainFieldPixels(layout, viewport, map);
  const url = encodeField(result.pixels, map.width, map.height, false);
  return {
    ...result,
    url,
    mapWidth: map.width,
    mapHeight: map.height,
    buildMs: (typeof performance === 'undefined' ? 0 : performance.now()) - started,
  };
}

export function buildDynamicRainField(state: RainSimulationState): RainFieldBuild {
  const started = typeof performance === 'undefined' ? 0 : performance.now();
  const divisor = dynamicFieldDivisor(state.viewport.width);
  const map = mapSize(state.viewport, divisor);
  const result = buildDynamicRainFieldPixels(state, map);
  const url = encodeField(result.pixels, map.width, map.height, true);
  return {
    ...result,
    url,
    mapWidth: map.width,
    mapHeight: map.height,
    buildMs: (typeof performance === 'undefined' ? 0 : performance.now()) - started,
  };
}

/** 测试/诊断：某点是否在水体 coverage 内。 */
export function fieldCoverageAt(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  x: number,
  y: number,
): number {
  const index = (Math.round(y) * width + Math.round(x)) * 4;
  return (pixels[index + 2] ?? 0) / 255;
}
