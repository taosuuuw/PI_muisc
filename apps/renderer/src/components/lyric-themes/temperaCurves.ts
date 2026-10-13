/**
 * 凝彩（tempera）的**圆润几何**：圆、圆角矩形、旋转、多瓣云朵、扇贝花边、心形、环扇形、星芒、下垂丝带，以及一片圆的散布场。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**。这里**只借鉴数值与做法**，每个函数都在本仓库里重写：
 * 段数下限、归一化方式（云朵除以 `1+swell`、心形先量 bbox 再映射）、星芒第一个尖朝**上**（`rotation - π/2`）、
 * 扇贝边带用**两条 y**（平边 `flatY` + 凸起基线 `baseY`）而不是"高度 + 方向"、丝带的 `y` 是**中心线**（上下各 `thickness/2`）、
 * 散布场用**抖动格点**（列数由 `√(count·宽/高)` 定）而不是纯随机 —— 这些都在下面逐条注明了出处。
 *
 * 另一个照抄的约束：**凸性是有用的**。`buildHatchLines` 用半平面裁剪，只对**凸**形状成立，
 * 所以只有 `ellipsePolygon` / `roundedRectPolygon` / `rotatePolygon` 的结果能拿去上网线；
 * 云朵、心形、星芒、扇贝、丝带都是**凹**的，只能填色与描边（Pixi 用 earcut 三角化，填是没问题的）。
 */

import { temperaHash01 } from './temperaProgram';

const TAU = Math.PI * 2;

/** 构图空间里的一个圆（`drawDiscs` / `drawRings` 收的就是一串这个）。 */
export interface TemperaDisc {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** **凸**。椭圆的多边形近似（`ry` 与 `rx` 可以不同）。 */
export function ellipsePolygon(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  segments = 32,
): number[] {
  const count = Math.max(8, Math.round(segments));
  const points: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * TAU;
    points.push(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry);
  }
  return points;
}

/** **凸**。贴纸板：四角是四分之一圆弧的矩形。圆角只会往里收，所以仍是凸的。 */
export function roundedRectPolygon(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  cornerSegments = 6,
): number[] {
  const limit = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  const steps = Math.max(1, Math.round(cornerSegments));
  const corners: readonly (readonly [number, number, number])[] = [
    [x + width - limit, y + limit, -Math.PI / 2],
    [x + width - limit, y + height - limit, 0],
    [x + limit, y + height - limit, Math.PI / 2],
    [x + limit, y + limit, Math.PI],
  ];
  const points: number[] = [];
  for (const [cornerX, cornerY, start] of corners) {
    for (let step = 0; step <= steps; step += 1) {
      const angle = start + (step / steps) * (Math.PI / 2);
      points.push(cornerX + Math.cos(angle) * limit, cornerY + Math.sin(angle) * limit);
    }
  }
  return points;
}

/** 绕枢轴旋转一组顶点。**凸性保持不变**，所以能上网线的形状旋完仍能上网线。 */
export function rotatePolygon(
  polygon: readonly number[],
  cx: number,
  cy: number,
  angle: number,
): number[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const points: number[] = [];
  for (let index = 0; index + 1 < polygon.length; index += 2) {
    const dx = (polygon[index] ?? 0) - cx;
    const dy = (polygon[index + 1] ?? 0) - cy;
    points.push(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
  }
  return points;
}

/**
 * **凹**。带 `lobes` 个正弦凸起的轮廓。
 *
 * 关键是那一步**归一化**：`scale = (1 + cos(θ·lobes)·swell) / (1 + swell)` ——
 * 除以 `1 + swell` 之后，形状仍然**正好**落在 `rx / ry` 盒子里（不归一化会胖出去，
 * 调用方按 `rx/ry` 给尺寸就不准了）。振幅小读成云或蕾丝圆牌，大一点读成玫瑰花窗。
 */
export function lobedPolygon(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  lobes: number,
  amplitude: number,
  segments = 96,
): number[] {
  const count = Math.max(24, Math.round(segments));
  const petals = Math.max(1, Math.round(lobes));
  const swell = Math.max(0, amplitude);
  const points: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * TAU;
    const scale = (1 + Math.cos(angle * petals) * swell) / (1 + swell);
    points.push(cx + Math.cos(angle) * rx * scale, cy + Math.sin(angle) * ry * scale);
  }
  return points;
}

/**
 * **凹**。花边带：一条平边在 `flatY`，一排**相切**的半圆凸起挂在 `baseY`。
 *
 * 两处照抄的细节：凸起半径取**凸起宽度的一半**（所以只靠 `bumps` 就能决定蕾丝多细），
 * 以及凸起从右往左走（这样它接在平边上时是一个绕向）。
 * 方向由 `baseY` 与 `flatY` 的高低决定 —— 所以是**两个 y**，不是一个"高度 + 方向"。
 */
export function scallopBandPolygon(
  x0: number,
  x1: number,
  flatY: number,
  baseY: number,
  bumps: number,
  segmentsPerBump = 10,
): number[] {
  const count = Math.max(1, Math.round(bumps));
  const steps = Math.max(3, Math.round(segmentsPerBump));
  const span = (x1 - x0) / count;
  const radius = Math.abs(span) / 2;
  const direction = baseY >= flatY ? 1 : -1;
  const points: number[] = [x0, flatY, x1, flatY];
  for (let bump = count - 1; bump >= 0; bump -= 1) {
    const centerX = x0 + span * (bump + 0.5);
    for (let step = 0; step <= steps; step += 1) {
      const angle = (step / steps) * Math.PI;
      points.push(
        centerX + Math.cos(angle) * (span / 2),
        baseY + direction * Math.sin(angle) * radius,
      );
    }
  }
  return points;
}

/**
 * **凹**。经典参数方程心形：先按曲线自身尺度采样，**量出 bbox 再映射进 `rx / ry` 盒**。
 * 这样调用方跟别的形状一样给半径就行，不用去背曲线自带的尺度。
 * 纵轴取反：那个参数方程是写给"数学向上"的坐标系，而构图是 y 向下的。
 */
export function heartPolygon(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  segments = 64,
): number[] {
  const count = Math.max(16, Math.round(segments));
  const raw: number[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    const t = (index / count) * TAU;
    const x = Math.sin(t) ** 3 * 16;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    raw.push(x, y);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const halfWidth = Math.max(1e-6, (maxX - minX) / 2);
  const halfHeight = Math.max(1e-6, (maxY - minY) / 2);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const points: number[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    points.push(
      cx + (((raw[index] ?? 0) - midX) / halfWidth) * rx,
      cy + (((raw[index + 1] ?? 0) - midY) / halfHeight) * ry,
    );
  }
  return points;
}

/**
 * **凹**。圆环的一段，从 `startAngle` 到 `endAngle`。
 * 一圈这样的扇形被打掉之后，**段与段之间的辐条、以及环围出来的轮毂都还站着** ——
 * 玫瑰窗就是靠这个从板上冲出一个环、而中间不掉下去。
 */
export function annularSectorPolygon(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
  segments = 10,
): number[] {
  const steps = Math.max(2, Math.round(segments));
  const points: number[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = startAngle + ((endAngle - startAngle) * step) / steps;
    points.push(cx + Math.cos(angle) * outerRadius, cy + Math.sin(angle) * outerRadius);
  }
  for (let step = steps; step >= 0; step -= 1) {
    const angle = startAngle + ((endAngle - startAngle) * step) / steps;
    points.push(cx + Math.cos(angle) * innerRadius, cy + Math.sin(angle) * innerRadius);
  }
  return points;
}

/**
 * **凹**。四个尖 + 细腰就是视觉小说那种"一闪"；尖更多就读成星。
 * 第一个尖朝**上**（`rotation - π/2`）—— 这是照抄的角度起点，少了它星芒会整体转 90°。
 */
export function starPolygon(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  points: number,
  rotation = 0,
): number[] {
  const tips = Math.max(3, Math.round(points));
  const polygon: number[] = [];
  for (let index = 0; index < tips * 2; index += 1) {
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const angle = rotation - Math.PI / 2 + (index / (tips * 2)) * TAU;
    polygon.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  }
  return polygon;
}

/**
 * **凹**。中心线沿半个正弦波下垂、两端平切的带子 —— 所以它可以跑出画面两边，
 * 仍然读成一条完整的弧。
 *
 * `y` 是**中心线**：上下各 `thickness / 2`（我第一版把 `y` 当成上缘，整条带子会偏半个厚度）。
 */
export function arcRibbonPolygon(
  x0: number,
  x1: number,
  y: number,
  thickness: number,
  sag: number,
  steps = 28,
): number[] {
  const count = Math.max(4, Math.round(steps));
  const half = thickness / 2;
  const top: number[] = [];
  const bottom: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    const progress = index / count;
    const x = x0 + (x1 - x0) * progress;
    const centre = y + Math.sin(progress * Math.PI) * sag;
    top.push(x, centre - half);
    bottom.push(x, centre + half);
  }
  const points = [...top];
  for (let index = bottom.length - 2; index >= 0; index -= 2) {
    points.push(bottom[index] ?? 0, bottom[index + 1] ?? 0);
  }
  return points;
}

/**
 * 一片**抖动格点**上的圆：格点保证覆盖在整幅画面上是均匀的（纯随机会结块、会留空），
 * 而每格内部的抖动才是"不读成点阵"的原因。半径在 `0.55~1.30` 倍之间散开。
 */
export function buildDiscField(
  seed: number,
  salt: number,
  width: number,
  height: number,
  count: number,
  radius: number,
): TemperaDisc[] {
  const total = Math.max(0, Math.round(count));
  if (total === 0 || width <= 0 || height <= 0) return [];
  const columns = Math.max(1, Math.round(Math.sqrt(total * (width / height))));
  const rows = Math.max(1, Math.ceil(total / columns));
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const discs: TemperaDisc[] = [];
  for (let index = 0; index < total; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    discs.push({
      x: cellWidth * (column + 0.15 + temperaHash01(seed, index, salt) * 0.7),
      y: cellHeight * (row + 0.15 + temperaHash01(seed, index, salt + 3) * 0.7),
      radius: radius * (0.55 + temperaHash01(seed, index, salt + 7) * 0.75),
    });
  }
  return discs;
}

/** 把一组圆转成多边形顶点（渲染层复用面板机制画圆）。 */
export function discPolygons(discs: readonly TemperaDisc[], segments = 32): number[][] {
  return discs.map((disc) => ellipsePolygon(disc.x, disc.y, disc.radius, disc.radius, segments));
}
