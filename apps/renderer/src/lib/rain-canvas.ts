import { rainSizeScale, type RainBead, type RainLayout, type RainTrail } from './rain-layout';
import { mergeDirtyRects, type RainDirtyRect, type RainSimulationState } from './rain-simulation';

/**
 * 把雨画到两张 canvas 上：
 * - **静态层**：附着水珠 + 残留水痕 + 水痕串珠，换歌/改窗口尺寸/合并掉小珠时画一次；
 * - **动态层**：只有会滑落水珠身后的湿痕，每帧重画（1x，面积小、笔触少）。
 *
 * 统一原则：**不把 blur 当折射**。canvas 只画水珠的暗边、极小高光和湿痕；真正弯折背景
 * 的是 SVG `feDisplacementMap`（见 `rain-refraction-map.ts` / `RainWindow.tsx`）。
 *
 * 视觉上去掉上一版的三样东西：
 * 1. 完整白圈（会读成肥皂泡）；
 * 2. 每颗小珠都点一个纯白高光（远看像雪）；
 * 3. 又直又长的亮线（像玻璃划痕）。
 * 新画法是不规则团块、偏心暗边 + 极小冷白高光，水痕短、弯、淡。
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
  const radius = (bead.sizePx * scale) / 2 + 4;
  return { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 };
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
  const count = radius > 5 ? 14 : 10;
  const points: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const ripple =
      Math.sin(angle * 3 + bead.shape.wobblePhase) * 0.55 +
      Math.sin(angle * 5 - bead.shape.wobblePhase * 0.7) * 0.25;
    const rr = radius * (1 + bead.shape.wobble * ripple);
    points.push({ x: Math.cos(angle) * rr, y: Math.sin(angle) * rr });
  }
  const first = points[0];
  const second = points[1];
  if (!first || !second) return;
  const startX = (first.x + second.x) / 2;
  const startY = (first.y + second.y) / 2;
  ctx.moveTo(startX, startY);
  for (let index = 1; index <= count; index += 1) {
    const current = points[index % count];
    const next = points[(index + 1) % count];
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
    const halo = ctx.createRadialGradient(0, 0, r * 0.86, 0, 0, r * 1.16);
    halo.addColorStop(0, 'rgba(3, 8, 16, 0)');
    halo.addColorStop(0.55, `rgba(3, 8, 16, ${0.11 * opacity})`);
    halo.addColorStop(1, 'rgba(3, 8, 16, 0)');
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.16, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();
  }

  traceBlob(ctx, r, bead);

  // 本体：中心偏透（让真实/折射背景透出来），边缘压暗到能一眼看出轮廓。
  const body = ctx.createRadialGradient(-r * 0.2, -r * 0.24, r * 0.04, 0, 0, r);
  body.addColorStop(0, `rgba(232, 246, 255, ${0.1 * opacity})`);
  body.addColorStop(0.45, `rgba(190, 222, 246, ${0.05 * opacity})`);
  body.addColorStop(0.72, `rgba(${DARK}, ${0.1 * opacity})`);
  body.addColorStop(0.89, `rgba(${DARK}, ${0.34 * opacity})`);
  body.addColorStop(0.97, `rgba(${DARK}, ${0.48 * opacity})`);
  body.addColorStop(1, `rgba(${DARK}, 0)`);
  ctx.fillStyle = body;
  ctx.fill();

  /*
   * 上缘/左上只画一小段冷白，不画完整一圈。
   * 完整白圈 + 中心透明 = 肥皂泡；一段偏心的高光 = 水。
   */
  if (r > 1.4) {
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.86, Math.PI * 1.08, Math.PI * 1.52);
    ctx.strokeStyle = `rgba(240, 250, 255, ${0.55 * opacity})`;
    ctx.lineWidth = Math.max(0.5, r * 0.08);
    ctx.stroke();
  }

  // 右下暗边：给一点体积，也把折射层在边缘淡出时那圈接缝压住。
  if (r > 1.1) {
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.84, Math.PI * 0.04, Math.PI * 0.78);
    ctx.strokeStyle = `rgba(${DARK}, ${0.4 * opacity})`;
    ctx.lineWidth = Math.max(0.5, r * 0.12);
    ctx.stroke();
  }

  // 偏左上的一颗高光。小珠也画，但尺寸随之收小，不做「雪点」。
  if (r > 0.85) {
    const glintRadius = Math.max(0.4, r * (r < 2 ? 0.2 : 0.26));
    const glintAlpha = (0.24 + 0.4 * Math.min(1, (r - 0.85) / 3.4)) * opacity;
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
 * 只重画被动态水珠吸走的小珠所在区域。
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
}

function paintTrailPoints(
  ctx: CanvasRenderingContext2D,
  points: readonly TrailPointLike[],
  fadeSeconds: number,
  maxLength: number,
  opacity: number,
  width: number,
): void {
  if (points.length < 2) return;
  // 从最新点往回取，累计路程超过最大长度就停；这样湿痕不会拖成一条长线。
  const visible: TrailPointLike[] = [];
  let distance = 0;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (!point) continue;
    const next = visible[0];
    if (next) distance += Math.hypot(next.x - point.x, next.y - point.y);
    if (distance > maxLength) break;
    visible.unshift(point);
  }
  if (visible.length < 2) return;

  for (let index = 1; index < visible.length; index += 1) {
    const a = visible[index - 1];
    const b = visible[index];
    if (!a || !b) continue;
    const headness = index / visible.length;
    const ageAlpha = Math.max(0, 1 - a.age / (fadeSeconds * 1.25));
    const alpha = 0.17 * ageAlpha * (0.2 + 0.8 * headness) * opacity;
    if (alpha <= 0.002) continue;
    // 一条很淡的暗色底 + 一条更细的冷白线：深浅背景都能读出「湿」，但不会像亮划痕。
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = `rgba(4, 10, 20, ${alpha * 0.5})`;
    ctx.lineWidth = Math.max(0.8, 1.1 + width * 0.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = `rgba(${COOL}, ${alpha})`;
    ctx.lineWidth = Math.max(0.5, 0.75 + width * 0.55);
    ctx.stroke();
  }
}

/**
 * 动态湿痕层。
 *
 * 只画滑动水珠身后那一小段：点按年龄变淡，头部清楚、尾部消失；宽度 1px 上下。
 * 水珠滑走/被合并后，湿痕会「交接」到 `residualTrails`，继续淡完，不会跟着本体瞬移。
 * 这一层每帧清空重画，但只有 1x 分辨率和几条短痕，代价远小于逐帧画几百颗水珠。
 */
export function paintDynamicTrails(
  ctx: CanvasRenderingContext2D,
  state: RainSimulationState,
  size: RainCanvasSize,
): void {
  ctx.clearRect(0, 0, size.width, size.height);
  const scale = rainSizeScale(size.width);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const drop of state.drops) {
    if (drop.trail.length < 2) continue;
    const def = state.layout.dynamicDrops[drop.index];
    const cycle = def?.cycles[drop.cycleIndex];
    const fadeSeconds = cycle?.trailFadeSeconds ?? 2;
    const maxLength = (cycle?.trailLengthPx ?? 90) * scale * 1.4;
    paintTrailPoints(ctx, drop.trail, fadeSeconds, maxLength, drop.opacity, drop.radius / 30);
  }

  for (const residual of state.residualTrails) {
    paintTrailPoints(ctx, residual.points, residual.fadeSeconds, 210 * scale, 0.72, 0.85);
  }

  ctx.restore();
}
