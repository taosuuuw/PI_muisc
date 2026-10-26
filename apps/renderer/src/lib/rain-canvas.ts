import { rainSizeScale, type RainBead, type RainLayout, type RainTrail } from './rain-layout';
import { rainBlobTracePoints } from './rain-shape';
import {
  dynamicTrailHeadGapPx,
  dynamicTrailLengthForCycle,
  mergeDirtyRects,
  trimTrailPoints,
  type RainDirtyRect,
  type RainSimulationState,
} from './rain-simulation';

/**
 * 把雨画到两张 canvas 上：
 * - **静态层**：附着水珠 + 残留水痕 + 水痕串珠，换歌/改窗口尺寸/合并掉小珠时画一次；
 * - **动态层**：活跃滑行湿痕 + 已交接的残留湿路，每帧重画（1x，路径分段批画）。
 *
 * 统一原则：**不把 blur 当折射**。canvas 只画水珠的暗边、极小高光和湿痕；真正弯折背景
 * 的是 SVG `feDisplacementMap`（见 `rain-refraction-map.ts` / `RainWindow.tsx`）。
 *
 * 视觉上去掉上一版的三样东西：
 * 1. 完整白圈（会读成肥皂泡）；
 * 2. 每颗小珠都点一个纯白高光（远看像雪）；
 * 3. 又直又长的亮线（像玻璃划痕）。
 * 新画法是不规则团块、偏心暗边 + 极小冷白高光；静态旧水痕保持短、弯、淡，
 * 动态滑行湿路则由 `paintDynamicTrails` 画成更长的湿润水路。
 */

const COOL = '216, 238, 255';
const DARK = '4, 10, 20';

export interface RainCanvasSize {
  width: number;
  height: number;
}

export interface RainPaintOptions {
  /** 已被动态水珠吸走的静态珠 id。 */
  consumed?: ReadonlySet<number>;
}

interface Point {
  x: number;
  y: number;
}

function isBeadVisible(bead: RainBead, size: RainCanvasSize, scale: number): Point | null {
  const x = (bead.leftPercent / 100) * size.width;
  const y = (bead.topPercent / 100) * size.height;
  const radius = (bead.sizePx * scale) / 2 + 2;
  if (x + radius < 0 || x - radius > size.width || y + radius < 0 || y - radius > size.height) {
    return null;
  }
  return { x, y };
}

function trailBounds(trail: RainTrail, size: RainCanvasSize, scale: number): RainDirtyRect {
  const x = (trail.leftPercent / 100) * size.width;
  const y = (trail.topPercent / 100) * size.height;
  const length = Math.min(trail.lengthPx * scale, 190);
  const reach = Math.abs(trail.curvePx * scale) + Math.abs(trail.wavePx * scale) + 8;
  return {
    x: x - reach,
    y: y - 4,
    width: reach * 2 + 4,
    height: length + 12,
  };
}

function beadBounds(bead: RainBead, size: RainCanvasSize, scale: number): RainDirtyRect {
  const x = (bead.leftPercent / 100) * size.width;
  const y = (bead.topPercent / 100) * size.height;
  const radius = (bead.sizePx * scale) / 2;
  // 静态珠会 squash/tilt，还有 1.16r halo；脏区按最大可见范围留足。
  const squash = Math.min(1.6, Math.max(0.6, bead.shape.squash));
  const wobble = 1 + Math.min(0.12, Math.max(0, bead.shape.wobble));
  const extent = radius * Math.max(1, squash) * wobble * 1.18 + 6;
  return { x: x - extent, y: y - extent, width: extent * 2, height: extent * 2 };
}

function intersects(a: RainDirtyRect, b: RainDirtyRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * 画一颗水珠的不规则轮廓。
 *
 * 十几颗点按半径扰动围一圈，再用二次曲线穿过相邻点的中点，得到柔软但不规则的团块。
 * 比正圆更像「挂在玻璃上的水」；小到 2px 以下就退回椭圆，省计算也看不出差别。
 */
function traceBlob(ctx: CanvasRenderingContext2D, radius: number, bead: RainBead): void {
  ctx.beginPath();
  if (radius < 1.8) {
    ctx.ellipse(0, 0, radius, radius, 0, 0, Math.PI * 2);
    return;
  }
  const points = rainBlobTracePoints(bead.shape, radius, radius > 5 ? 14 : 10);
  const first = points[0];
  const second = points[1];
  if (!first || !second) return;
  const startX = (first.x + second.x) / 2;
  const startY = (first.y + second.y) / 2;
  ctx.moveTo(startX, startY);
  for (let index = 1; index <= points.length; index += 1) {
    const current = points[index % points.length];
    const next = points[(index + 1) % points.length];
    if (!current || !next) continue;
    ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }
  ctx.closePath();
}

function paintBead(
  ctx: CanvasRenderingContext2D,
  bead: RainBead,
  x: number,
  y: number,
  scale: number,
): void {
  const r = (bead.sizePx * scale) / 2;
  if (r < 0.35) return;
  // 很淡的小珠也保底一点存在感，不然浅色背景下会整片「化」掉。
  const opacity = Math.max(0.3, bead.opacity);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((bead.shape.tiltDeg * Math.PI) / 180);
  ctx.scale(1, bead.shape.squash);

  /*
   * 水珠贴在玻璃上会有一圈很淡的接触阴影。没有它，浅色背景下小珠会整个「化」进背景；
   * 只给 r>1.8 的中大珠，外圈用 0 收干净，不会连成一片黑。
   */
  if (r > 1.8) {
    const halo = ctx.createRadialGradient(0, 0, r * 0.88, 0, 0, r * 1.12);
    halo.addColorStop(0, 'rgba(3, 8, 16, 0)');
    halo.addColorStop(0.58, `rgba(3, 8, 16, ${0.045 * opacity})`);
    halo.addColorStop(1, 'rgba(3, 8, 16, 0)');
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.12, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();
  }

  traceBlob(ctx, r, bead);

  // 只留一层几乎看不出的中心湿膜；真正的轮廓/体积交给共享法线场。
  // 不再画完整暗环，完整灰环正是“肥皂泡/灰珍珠”的来源。
  if (r > 0.75) {
    const film = ctx.createRadialGradient(-r * 0.2, -r * 0.24, 0, 0, 0, r);
    film.addColorStop(0, `rgba(232, 246, 255, ${0.035 * opacity})`);
    film.addColorStop(0.6, `rgba(190, 222, 246, ${0.014 * opacity})`);
    film.addColorStop(1, 'rgba(190, 222, 246, 0)');
    ctx.fillStyle = film;
    ctx.fill();
  }

  /*
   * 上缘/左上只画一小段冷白，不画完整一圈。
   * 完整白圈 + 中心透明 = 肥皂泡；一段偏心的高光 = 水。
   */
  if (r > 1.4) {
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.88, Math.PI * 0.98, Math.PI * 1.46);
    ctx.strokeStyle = `rgba(240, 250, 255, ${0.28 * opacity})`;
    ctx.lineWidth = Math.max(0.4, r * 0.055);
    ctx.stroke();
  }

  // 右下暗边：短、窄、不对称；只做局部体积，不闭合。
  if (r > 1.1) {
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.86, Math.PI * 0.08, Math.PI * 0.68);
    ctx.strokeStyle = `rgba(${DARK}, ${0.25 * opacity})`;
    ctx.lineWidth = Math.max(0.4, r * 0.075);
    ctx.stroke();
  }

  // 偏左上的一颗很小高光；不是固定白点，强度随尺寸压住。
  if (r > 0.85) {
    const glintRadius = Math.max(0.35, r * (r < 2 ? 0.16 : 0.2));
    const glintAlpha = (0.13 + 0.2 * Math.min(1, (r - 0.85) / 3.4)) * opacity;
    const glint = ctx.createRadialGradient(
      -r * 0.34,
      -r * 0.37,
      0,
      -r * 0.34,
      -r * 0.37,
      glintRadius,
    );
    glint.addColorStop(0, `rgba(255, 255, 255, ${glintAlpha})`);
    glint.addColorStop(0.45, `rgba(255, 255, 255, ${glintAlpha * 0.3})`);
    glint.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.beginPath();
    ctx.arc(-r * 0.34, -r * 0.37, glintRadius, 0, Math.PI * 2);
    ctx.fillStyle = glint;
    ctx.fill();
  }

  // 底部焦散：只给大珠，极淡；不是一圈亮边。
  if (r > 4) {
    const caustic = ctx.createRadialGradient(r * 0.2, r * 0.48, 0, r * 0.2, r * 0.48, r * 0.24);
    caustic.addColorStop(0, `rgba(235, 248, 255, ${0.12 * opacity})`);
    caustic.addColorStop(1, 'rgba(235, 248, 255, 0)');
    ctx.beginPath();
    ctx.arc(r * 0.2, r * 0.48, r * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = caustic;
    ctx.fill();
  }

  ctx.restore();
}

function trailPoint(trail: RainTrail, t: number, scale: number): Point {
  const length = Math.min(trail.lengthPx * scale, 190);
  const x =
    trail.curvePx * scale * t * t +
    trail.wavePx * scale * Math.sin(t * Math.PI * 2 + trail.wavePhase) * t * (1 - t);
  return { x, y: length * t };
}

function paintTrail(
  ctx: CanvasRenderingContext2D,
  trail: RainTrail,
  x: number,
  y: number,
  scale: number,
): void {
  const steps = 16;
  ctx.save();
  ctx.translate(x, y);
  ctx.lineCap = 'round';
  for (let index = 0; index < steps; index += 1) {
    const t0 = index / steps;
    const t1 = (index + 1) / steps;
    const a = trailPoint(trail, t0, scale);
    const b = trailPoint(trail, t1, scale);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    // 越往下越淡、越细；整体透明度只有 0.05~0.17，不抢歌词。
    const alpha = trail.opacity * (1 - t0 * 0.58);
    ctx.strokeStyle = `rgba(${COOL}, ${alpha})`;
    ctx.lineWidth = Math.max(0.4, trail.widthPx * scale * (1 - t0 * 0.52));
    ctx.stroke();
  }
  ctx.restore();

  for (const bead of trail.beads) {
    const point = trailPoint(trail, bead.at, scale);
    paintBead(
      ctx,
      {
        id: -1,
        leftPercent: 0,
        topPercent: 0,
        sizePx: bead.sizePx,
        opacity: bead.opacity,
        shape: {
          squash: 1,
          tiltDeg: 0,
          wobble: 0.05,
          wobblePhase: bead.at * 6,
        },
        mergeable: false,
      },
      x + point.x,
      y + point.y,
      scale,
    );
  }
}

function paintAll(
  ctx: CanvasRenderingContext2D,
  layout: RainLayout,
  size: RainCanvasSize,
  options: RainPaintOptions,
  clip: RainDirtyRect | null,
): void {
  const scale = rainSizeScale(size.width);
  const consumed = options.consumed;
  for (const trail of layout.trails) {
    if (clip && !intersects(trailBounds(trail, size, scale), clip)) continue;
    const x = (trail.leftPercent / 100) * size.width;
    const y = (trail.topPercent / 100) * size.height;
    paintTrail(ctx, trail, x, y, scale);
  }
  for (const bead of layout.beads) {
    if (consumed?.has(bead.id)) continue;
    if (clip && !intersects(beadBounds(bead, size, scale), clip)) continue;
    const point = isBeadVisible(bead, size, scale);
    if (!point) continue;
    paintBead(ctx, bead, point.x, point.y, scale);
  }
}

/** 整张静态雨层重画（换歌 / 改窗口尺寸时）。 */
export function paintStaticRain(
  ctx: CanvasRenderingContext2D,
  layout: RainLayout,
  size: RainCanvasSize,
  options: RainPaintOptions = {},
): void {
  ctx.clearRect(0, 0, size.width, size.height);
  paintAll(ctx, layout, size, options, null);
}

/**
 * 只重画被动态水珠吸走的静态珠所在区域。
 *
 * 合并一颗小珠就重画 700 颗渐变会卡一下；这里把脏区合并、裁剪，只碰落在框里的水珠/水痕。
 * 如果脏区和别的珠重叠，也会一起重画，不会擦出洞。
 */
export function paintStaticRainRegion(
  ctx: CanvasRenderingContext2D,
  layout: RainLayout,
  size: RainCanvasSize,
  rects: readonly RainDirtyRect[],
  options: RainPaintOptions = {},
): void {
  if (rects.length === 0) return;
  const merged = mergeDirtyRects(rects);
  for (const rect of merged) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
    paintAll(ctx, layout, size, options, rect);
    ctx.restore();
  }
}

interface TrailPointLike {
  x: number;
  y: number;
  age: number;
  size: number;
}

interface TrailSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  nx: number;
  ny: number;
  /** 从水滴直径和稳定空间噪声推出的边缘宽度。 */
  width: number;
  /** 这一段的平均水珠直径，用于决定底膜带宽。 */
  diameter: number;
  /** 稳定空间噪声判定这里是湿斑；底膜只在这些区间画。 */
  film: boolean;
  dark: boolean;
  light: boolean;
  bead: boolean;
  midX: number;
  midY: number;
}

/** 按稳定湿膜值分 5 档批画；不是按路径相对头部比例。 */
const TRAIL_BUCKETS = 5;
/** 单条水迹参与路径构建的最大点数；更长的点列按步长抽样。 */
const TRAIL_RENDER_POINTS = 140;
/** 单条水迹最多画几颗极小残珠。 */
const MAX_TRAIL_BEADS = 4;
/** 一条水迹最多几段很淡的底膜带；避免把水迹画成荧光笔。 */
const MAX_TRAIL_FILM_BANDS = 3;
/** 每条水迹的 stroke 上限：5 档 × 暗/亮 + 底膜带 + 暗/亮残珠。 */
export const TRAIL_MAX_STROKES_PER_PATH =
  TRAIL_BUCKETS * 2 + MAX_TRAIL_FILM_BANDS + 2;

/**
 * 稳定空间噪声。输入的是世界坐标，不是“距头部多远”或帧号，所以：
 * - 新点加入不会让已有花纹滑动；
 * - 活跃转残留后坐标不变，花纹不变；
 * - 不同水珠也不会用同一套节奏。
 */
function stableWet(x: number, y: number, phase: number): number {
  const a = Math.sin(x * 0.041 + y * 0.067 + phase);
  const b = Math.sin(x * 0.017 - y * 0.029 + phase * 0.63 + 1.9);
  return Math.min(1, Math.max(0, 0.5 + 0.32 * a + 0.18 * b));
}

function buildTrailSegments(
  points: readonly TrailPointLike[],
  maxLengthPx: number,
  headGapPx: number,
): TrailSegment[] {
  if (points.length < 2 || maxLengthPx <= 0) return [];
  const visible = trimTrailPoints(points, maxLengthPx, headGapPx);
  if (visible.length < 2) return [];

  // 路径太长时等距抽样，保住首尾；140 个点足够一条 450px 的曲线。
  const stride = Math.max(1, Math.ceil((visible.length - 1) / (TRAIL_RENDER_POINTS - 1)));
  const sampled: TrailPointLike[] = [];
  for (let index = 0; index < visible.length; index += stride) {
    const point = visible[index];
    if (point) sampled.push(point);
  }
  const last = visible[visible.length - 1];
  if (last && sampled[sampled.length - 1] !== last) sampled.push(last);
  if (sampled.length < 2) return [];

  const segments: TrailSegment[] = [];
  for (let index = 1; index < sampled.length; index += 1) {
    const a = sampled[index - 1];
    const b = sampled[index];
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.05) continue;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const wet = stableWet(midX, midY, 0.4);
    const darkWet = stableWet(midX + 3.1, midY - 2.7, 1.7);
    const lightWet = stableWet(midX - 2.9, midY + 4.4, 3.1);
    const beadWet = stableWet(midX + 5.1, midY + 3.3, 4.2);
    const averageSize = (a.size + b.size) / 2;
    segments.push({
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      nx: -(b.y - a.y) / length,
      ny: (b.x - a.x) / length,
      width: Math.min(
        3.2,
        Math.max(0.65, averageSize * 0.055 * (0.62 + 0.86 * wet)),
      ),
      diameter: averageSize,
      // 只在稳定湿斑区间加底膜；干断处不加宽条。
      film: wet >= 0.5,
      // 暗边/亮边的出现位置用两套不同的稳定噪声：不再是一对等距平行线。
      dark: darkWet > 0.32,
      light: lightWet > 0.4,
      bead: beadWet > 0.84,
      midX,
      midY,
    });
  }
  return segments;
}

function strokeOffsetSegments(
  ctx: CanvasRenderingContext2D,
  segments: readonly TrailSegment[],
  offset: number,
  lineWidth: number,
  color: string,
  side: 1 | -1,
): void {
  if (segments.length === 0) return;
  ctx.beginPath();
  for (const segment of segments) {
    const off = offset * side;
    ctx.moveTo(segment.ax + segment.nx * off, segment.ay + segment.ny * off);
    ctx.lineTo(segment.bx + segment.nx * off, segment.by + segment.ny * off);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/**
 * 画“玻璃上的薄湿膜”：
 * - 不再按 headness 做头宽尾细；宽窄来自稳定空间噪声，沿路径有湿斑和干断；
 * - 暗边/亮边由两套不同噪声决定，且偏移量不同，不会形成两条等距平行线；
 * - 中间不填充，背景能透出来；
 * - 最多 5 档 × 2 条边 + 3 条底膜带 + 2 条残珠路径 = 15 次 stroke。
 *
 * `headGapPx` 让湿膜从水滴后方一小段之外才开始，避免“头 + 尾”连接。
 */
function paintTrailPath(
  ctx: CanvasRenderingContext2D,
  points: readonly TrailPointLike[],
  maxLengthPx: number,
  headGapPx: number,
  ageFraction: number,
): void {
  if (ageFraction >= 1) return;
  const segments = buildTrailSegments(points, maxLengthPx, headGapPx);
  if (segments.length === 0) return;
  // 前段保持清楚、最后一段自然收掉；5~8 秒的残留不会过早淡成看不见。
  const ageAlpha = Math.max(0, 1 - ageFraction * ageFraction * ageFraction);

  // 先在稳定湿斑区间铺一层很淡、较宽的透明底膜，再叠断续边缘。
  // 只取前 3 段，透明度压得很低；它不是整条亮线，也不是荧光笔。
  const filmBands: TrailSegment[][] = [];
  let currentBand: TrailSegment[] = [];
  for (const segment of segments) {
    if (segment.film) {
      currentBand.push(segment);
    } else if (currentBand.length > 0) {
      if (currentBand.length >= 2) filmBands.push(currentBand);
      currentBand = [];
    }
  }
  if (currentBand.length >= 2) filmBands.push(currentBand);
  for (const band of filmBands.slice(0, MAX_TRAIL_FILM_BANDS)) {
    const first = band[0];
    if (!first) continue;
    const filmWidth = Math.min(10, Math.max(2.5, first.diameter * 0.3));
    ctx.beginPath();
    ctx.moveTo(first.ax, first.ay);
    for (const segment of band) ctx.lineTo(segment.bx, segment.by);
    // 中性偏冷的灰蓝，低 alpha；亮/暗背景都能读到一层薄膜，但不会像荧光笔。
    ctx.strokeStyle = `rgba(170, 198, 214, ${0.034 * ageAlpha})`;
    ctx.lineWidth = filmWidth;
    ctx.stroke();
  }

  const buckets: TrailSegment[][] = Array.from({ length: TRAIL_BUCKETS }, () => []);
  const beads: TrailSegment[] = [];
  for (const segment of segments) {
    // 按**这一段自己的稳定宽度**分档，而不是按整条路径的平均值：
    // 新点加入时不会改变老点的档位/宽度，纹理不会抖。
    const bucket = Math.min(
      TRAIL_BUCKETS - 1,
      Math.max(0, Math.floor(((segment.width - 0.65) / 2.55) * TRAIL_BUCKETS)),
    );
    buckets[bucket]?.push(segment);
    if (segment.bead && beads.length < MAX_TRAIL_BEADS) beads.push(segment);
  }

  for (let bucket = 0; bucket < TRAIL_BUCKETS; bucket += 1) {
    const bucketSegments = buckets[bucket] ?? [];
    if (bucketSegments.length === 0) continue;
    const bucketMix = (bucket + 0.5) / TRAIL_BUCKETS;
    const bucketWidth = 0.8 + bucketMix * 2.2;

    // 暗边和亮边不是同一组线段：各自有自己的断续位置。
    const darkSegments = bucketSegments.filter((segment) => segment.dark);
    const lightSegments = bucketSegments.filter((segment) => segment.light);
    const darkAlpha = Math.min(0.26, ageAlpha * (0.06 + 0.16 * bucketMix));
    const lightAlpha = Math.min(0.3, ageAlpha * (0.08 + 0.14 * bucketMix));
    const edgeWidth = bucketWidth;
    const darkOffset = 0.7 + bucketWidth * 0.5 + bucketMix * 0.35;
    const lightOffset = 0.55 + bucketWidth * 0.34 + (1 - bucketMix) * 0.4;

    if (darkSegments.length > 0 && darkAlpha > 0.002) {
      strokeOffsetSegments(
        ctx,
        darkSegments,
        darkOffset,
        Math.max(0.55, edgeWidth * 0.58),
        `rgba(${DARK}, ${darkAlpha})`,
        1,
      );
    }
    if (lightSegments.length > 0 && lightAlpha > 0.002) {
      strokeOffsetSegments(
        ctx,
        lightSegments,
        lightOffset,
        Math.max(0.4, edgeWidth * 0.4),
        `rgba(${COOL}, ${lightAlpha})`,
        -1,
      );
    }
  }

  if (beads.length > 0 && ageAlpha > 0.01) {
    // 极小残珠：用极短圆头线段画，不引入 gradient/glow，也不逐颗 stroke。
    ctx.beginPath();
    for (const bead of beads) {
      ctx.moveTo(bead.midX, bead.midY);
      ctx.lineTo(bead.midX + 0.01, bead.midY);
    }
    ctx.strokeStyle = `rgba(${DARK}, ${0.12 * ageAlpha})`;
    ctx.lineWidth = 2.4;
    ctx.stroke();

    ctx.beginPath();
    for (const bead of beads) {
      ctx.moveTo(bead.midX - 0.5, bead.midY - 0.4);
      ctx.lineTo(bead.midX - 0.49, bead.midY - 0.4);
    }
    ctx.strokeStyle = `rgba(${COOL}, ${0.16 * ageAlpha})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

/**
 * 动态湿痕层。
 *
 * 活跃水迹画当前滑行路径；水滴滑出/被吞并的那一刻，仿真立即把路径快照交给
 * `residualTrails`，这里只按残留自己的 age 淡出，**不乘 drop.opacity**，也不等 respawn。
 * 轨迹固定在原坐标，不会随水滴重生瞬移；5~8 秒后由仿真回收。
 *
 * 每帧清空 1x 小画布，每条水迹最多 `TRAIL_MAX_STROKES_PER_PATH` 次 stroke，
 * 不做逐点多层描边，也不新增 DOM/滤镜。
 */
export function paintDynamicTrails(
  ctx: CanvasRenderingContext2D,
  state: RainSimulationState,
  size: RainCanvasSize,
): void {
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const drop of state.drops) {
    if (drop.trail.length < 2) continue;
    const def = state.layout.dynamicDrops[drop.index];
    const cycle = def?.cycles[drop.cycleIndex];
    if (!cycle) continue;
    // 长度按整轮 maxSpeed 固定，不能用当前 speed：钉点停顿 speed=0 时
    // 已经画出的 308px 水迹不能瞬间缩成 198px。
    const maxLengthPx = dynamicTrailLengthForCycle(cycle, state.viewport.height);
    // 水滴后方留一段空位，避免头部和湿膜连成“圆头 + 尾巴”。
    const headGapPx = dynamicTrailHeadGapPx(drop.radius);
    // 活跃水迹不乘本体 opacity：本体是否淡出/被吞并由仿真在交接时处理。
    paintTrailPath(ctx, drop.trail, maxLengthPx, headGapPx, 0);
  }

  for (const residual of state.residualTrails) {
    // residual 在交接时已经按同一个 headGap 裁掉；这里不再二次留空。
    paintTrailPath(
      ctx,
      residual.points,
      residual.maxLengthPx,
      0,
      residual.age / Math.max(0.001, residual.fadeSeconds),
    );
  }

  ctx.restore();
}
