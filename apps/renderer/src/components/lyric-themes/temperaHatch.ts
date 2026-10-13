/**
 * 凝彩（tempera）的**网线语汇**：网线填充、波浪边、页边散字行。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**。这里只取**数值与做法**，代码逐行自己写：
 * · 角度四选一 `-45° / 45° / -60° / 30°`、密度三档 `9 / 13 / 18px`、线宽 `max(0.8, spacing×(0.16~0.30))`
 *   —— 取自 folia 的 `buildHatchSpec`（它说「密度档要粗，同一块形状才读成一个调子而不是摩尔纹」）；
 * · 网线裁剪：folia 用**半平面裁剪**，我们改用**旋转到局部坐标 + 扫描线求交排序**，结果等价、写法不同；
 * · 波浪边 `sin(progress·2π·1.5)` + 端点抖动 0.5 倍振幅、散字行的尺寸/角度抖动系数也照抄。
 *
 * 纯函数、无 Pixi 依赖 —— 与帧层一样可单测。
 */

import { temperaHash01 } from './temperaProgram';

const TAU = Math.PI * 2;
/** 一屏网线最多这么多条（folia 同值）；再多只是浪费。 */
const MAX_HATCH_LINES = 320;

export interface TemperaHatchSpec {
  /** 弧度：形状**内部**的网线方向。 */
  readonly angle: number;
  /** 相邻两条平行线的间距（px）。 */
  readonly spacing: number;
  /** 线宽（px）。 */
  readonly width: number;
}

export interface TemperaHatchLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface TemperaDecorMark {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly rotation: number;
}

/**
 * 由种子挑一组网线参数（folia: `buildHatchSpec`）。
 * 角度只四选一、密度只三档：档位粗，同一块形状才会读成"一个调子"。
 */
export function buildHatchSpec(seed: number, salt: number, scale = 1): TemperaHatchSpec {
  const angleIndex = Math.floor(temperaHash01(seed, 1, salt) * 4);
  const angle = [-Math.PI / 4, Math.PI / 4, -Math.PI / 3, Math.PI / 6][angleIndex] ?? Math.PI / 4;
  const density = Math.floor(temperaHash01(seed, 2, salt) * 3);
  const spacing = ([9, 13, 18][density] ?? 13) * scale;
  const width = Math.max(0.8, spacing * (0.16 + temperaHash01(seed, 3, salt) * 0.14));
  return { angle, spacing, width };
}

/** 矩形 → 多边形顶点（与帧层的 `rectPolygon` 同义；放在这里是为了网线层不必反向依赖帧层）。 */
export function hatchRectPolygon(x: number, y: number, width: number, height: number): number[] {
  return [x, y, x + width, y, x + width, y + height, x, y + height];
}

/** 圆的凸多边形近似（folia: `circlePolygon`）—— 网线裁剪器只认凸多边形，圆窗靠它开口。 */
export function circlePolygon(cx: number, cy: number, radius: number, segments = 28): number[] {
  const points: number[] = [];
  const count = Math.max(6, Math.round(segments));
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * TAU;
    points.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  }
  return points;
}

/** 菱形（folia: `diamondPolygon`）—— frame 族的同心菱框靠它。 */
export function diamondPolygon(cx: number, cy: number, rx: number, ry: number): number[] {
  return [cx, cy - ry, cx + rx, cy, cx, cy + ry, cx - rx, cy];
}

/**
 * 把一块多边形填成平行网线（folia: `buildHatchLines`）。
 *
 * 做法：① 把多边形绕其中心旋转 `-angle`，让网线方向变成水平；
 * ② 按 `spacing` 逐条水平扫描线求与各边的交点，排序后两两配对成线段；
 * ③ 需要生长动画（`coverage < 1`）时，把每条线段朝它的中点收进去；
 * ④ 再旋转回原坐标系。
 * `coverage` 用来做入场时的"从形状中心长开"（folia 的 `grow`）。
 */
export function buildHatchLines(
  polygon: readonly number[],
  spec: TemperaHatchSpec,
  coverage = 1,
): TemperaHatchLine[] {
  if (polygon.length < 6 || spec.spacing <= 0) return [];
  const count = Math.floor(polygon.length / 2);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < count; index += 1) {
    xs.push(polygon[index * 2] ?? 0);
    ys.push(polygon[index * 2 + 1] ?? 0);
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  if (diagonal <= 0) return [];

  // ① 旋转到"网线水平"的局部坐标系。
  const cos = Math.cos(-spec.angle);
  const sin = Math.sin(-spec.angle);
  const local: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const dxRaw = (xs[index] ?? 0) - centerX;
    const dyRaw = (ys[index] ?? 0) - centerY;
    local.push(dxRaw * cos - dyRaw * sin, dxRaw * sin + dyRaw * cos);
  }

  const localMinY = Math.min(...local.filter((_value, index) => index % 2 === 1));
  const localMaxY = Math.max(...local.filter((_value, index) => index % 2 === 1));
  const clampedCoverage = Math.min(1, Math.max(0, coverage));
  const lines: TemperaHatchLine[] = [];
  const backCos = Math.cos(spec.angle);
  const backSin = Math.sin(spec.angle);

  // ② 逐条扫描线求交并配对（用中心对称的步长扫过整块形状）。
  const startStep = Math.ceil(localMinY / spec.spacing);
  const endStep = Math.floor(localMaxY / spec.spacing);
  for (let step = startStep; step <= endStep; step += 1) {
    if (lines.length >= MAX_HATCH_LINES) break;
    const scanY = step * spec.spacing;
    const crossings: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const ax = local[index * 2] ?? 0;
      const ay = local[index * 2 + 1] ?? 0;
      const bx = local[((index + 1) % count) * 2] ?? 0;
      const by = local[((index + 1) % count) * 2 + 1] ?? 0;
      // 半开区间判定，避免顶点被数两次。
      if (ay === by) continue;
      const lower = Math.min(ay, by);
      const upper = Math.max(ay, by);
      if (scanY < lower || scanY >= upper) continue;
      const t = (scanY - ay) / (by - ay);
      crossings.push(ax + (bx - ax) * t);
    }
    if (crossings.length < 2) continue;
    crossings.sort((left, right) => left - right);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const from = crossings[index] ?? 0;
      const to = crossings[index + 1] ?? 0;
      if (to - from < 0.5) continue;
      let start = from;
      let end = to;
      if (clampedCoverage < 1) {
        const mid = (from + to) / 2;
        start = mid + (from - mid) * clampedCoverage;
        end = mid + (to - mid) * clampedCoverage;
      }
      // ④ 旋转回原坐标系。
      lines.push({
        x1: centerX + start * backCos - scanY * backSin,
        y1: centerY + start * backSin + scanY * backCos,
        x2: centerX + end * backCos - scanY * backSin,
        y2: centerY + end * backSin + scanY * backCos,
      });
    }
  }
  return lines;
}

/** 起伏的水平边（folia: `buildWavyPath`）—— 海报式构图的下沿就靠它，`sin(progress·2π·1.5)`。 */
export function buildWavyPath(
  seed: number,
  salt: number,
  x0: number,
  x1: number,
  y: number,
  amplitude: number,
  steps = 24,
): number[] {
  const points: number[] = [];
  const safeSteps = Math.max(2, Math.round(steps));
  for (let index = 0; index <= safeSteps; index += 1) {
    const progress = index / safeSteps;
    const wave = Math.sin(progress * TAU * 1.5 + temperaHash01(seed, 0, salt) * TAU);
    const jitter = (temperaHash01(seed, index, salt) - 0.5) * amplitude * 0.5;
    points.push(x0 + (x1 - x0) * progress, y + wave * amplitude + jitter);
  }
  return points;
}

/** 沿一个方向等距排开的一行记号，每个都带种子抖动（folia: `buildMarkRow`）。 */
export function buildMarkRow(
  seed: number,
  salt: number,
  x: number,
  y: number,
  count: number,
  spacing: number,
  size: number,
  angle: number,
): TemperaDecorMark[] {
  const marks: TemperaDecorMark[] = [];
  const total = Math.max(0, Math.round(count));
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  for (let index = 0; index < total; index += 1) {
    const jitter = (temperaHash01(seed, index, salt) - 0.5) * spacing * 0.16;
    const distance = index * spacing + jitter;
    marks.push({
      x: x + dx * distance,
      y: y + dy * distance,
      size: size * (0.82 + temperaHash01(seed, index, salt + 3) * 0.36),
      rotation: (temperaHash01(seed, index, salt + 11) - 0.5) * 0.3,
    });
  }
  return marks;
}

/** 十字记号行（folia: `buildCrossRow`，默认 size 9、方向水平）。 */
export function buildCrossRow(
  seed: number,
  salt: number,
  x: number,
  y: number,
  count: number,
  spacing: number,
  size = 9,
  angle = 0,
): TemperaDecorMark[] {
  return buildMarkRow(seed, salt, x, y, count, spacing, size, angle);
}

/** 方点行（folia: `buildDotRow`，默认 size 4、方向竖直）。 */
export function buildDotRow(
  seed: number,
  salt: number,
  x: number,
  y: number,
  count: number,
  spacing: number,
  size = 4,
  angle = Math.PI / 2,
): TemperaDecorMark[] {
  return buildMarkRow(seed, salt, x, y, count, spacing, size, angle);
}

/**
 * **印刷颗粒**（第 635 轮的简化实现）。
 *
 * 上游凝彩在整场景上挂了一层 `pixi.NoiseFilter({ noise: tuning.postProcessGrain * 0.35 })`
 * （`temperaSceneBuilder.ts:360~366`）。但我们的反色滤镜依赖 backdrop 拷贝，而"常驻在场景上的滤镜
 * 会夺走那份拷贝"是这条链上最容易坏的东西（第 617 轮就是为此让转场模糊只在模糊时挂）。
 * 所以这里用**确定性随机小点**直接在纸层上画出颗粒：观感（印刷感）一致，
 * 但**不引入第二层全屏滤镜**、也就没有 backdrop 冲突。
 *
 * ⚠ 必须**确定性**：同一个 `seed + 尺寸` 必须得到同一批点，否则 seek 会闪。
 * 这里用本地 hash（不跨模块引用），保证这个文件零额外依赖。
 */
const grainHash = (value: number): number => {
  const mixed = Math.sin(value * 12.9898) * 43758.5453;
  return mixed - Math.floor(mixed);
};

export function buildGrainMarks(
  seed: number,
  width: number,
  height: number,
  density: number,
): TemperaDecorMark[] {
  const marks: TemperaDecorMark[] = [];
  const count = Math.max(0, Math.floor((width * height) / Math.max(1, density)));
  for (let index = 0; index < count; index += 1) {
    marks.push({
      x: grainHash(seed + index * 3.1) * width,
      y: grainHash(seed + index * 7.7 + 1.3) * height,
      size: 0.8 + grainHash(seed + index * 11.3 + 2.7) * 1.4,
      rotation: 0,
    });
  }
  return marks;
}

/** 方点阵（folia: `buildDotGrid`）：按 `spacing` 铺满 `width × height`，尺寸统一。 */
export function buildDotGrid(
  width: number,
  height: number,
  spacing: number,
  size: number,
): TemperaDecorMark[] {
  const marks: TemperaDecorMark[] = [];
  const step = Math.max(4, spacing);
  // 从半格起步，点阵才不会在边上挤成一条。
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      marks.push({ x, y, size, rotation: 0 });
    }
  }
  return marks;
}

/**
 * 手绘乱线（folia: `buildScribblePath`）：一条从中心往外绕出去、半径一路抖动的螺旋折线。
 *
 * 说明：folia 这个生成器的**实现文本本轮没取到**（抓取时被截断），所以半径抖动与圈进方式
 * 是按"看起来像随手画的圈"自拟的；调用方给的半径与圈数（0.06~0.09 倍短边、2 圈）照它的用法。
 */
export function buildScribblePath(
  seed: number,
  salt: number,
  cx: number,
  cy: number,
  radius: number,
  turns = 2,
): number[] {
  const points: number[] = [];
  const steps = 48;
  const total = Math.max(0.5, turns);
  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps;
    const angle = progress * TAU * total;
    const wobble = 0.62 + temperaHash01(seed, index, salt) * 0.76;
    const reach = radius * wobble * (0.3 + 0.7 * progress);
    points.push(cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach);
  }
  return points;
}

/** 一至三条浅斜线，横穿整个画面（folia: `buildCrossingLines`，倾角 0.07~0.18 弧度）。 */export function buildCrossingLines(
  seed: number,
  salt: number,
  width: number,
  height: number,
  count: number,
): TemperaHatchLine[] {
  const total = Math.min(3, Math.max(0, Math.round(count)));
  const lines: TemperaHatchLine[] = [];
  for (let index = 0; index < total; index += 1) {
    const anchorY = height * (0.18 + temperaHash01(seed, index, salt) * 0.64);
    const sign = temperaHash01(seed, index, salt + 5) > 0.5 ? 1 : -1;
    const angle = sign * (0.07 + temperaHash01(seed, index, salt + 9) * 0.11);
    // 两头都伸到画面外：这一层会跟着构图滑动，线在框边截断就会明显地"脱开"构图。
    const reach = width * 0.9;
    lines.push({
      x1: -width * 0.3,
      y1: anchorY - Math.tan(angle) * reach,
      x2: width * 1.3,
      y2: anchorY + Math.tan(angle) * reach,
    });
  }
  return lines;
}
