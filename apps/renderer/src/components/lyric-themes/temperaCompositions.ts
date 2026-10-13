/**
 * 凝彩（tempera）的**构图语汇**：把一族的 shot 变成一组"要画什么"的面板 / 缝 / 线条 / 网线。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**（`chthollyphile/folia-major@main`）。这里**只取数值与做法**：
 * 每一族的顶点、比例、切点随机、入场位移 / 延迟 / 时长都照它的构图文件逐条抄**数值**，
 * 但表达式与结构是我们在本仓库里重写的，没有拷贝 folia 源码文本。
 * 面板的统一装配（延迟按序号错落 0.05、时长 0.5、透明度 0.96、其中一块叠网线）也照它的 `addPanels`。
 *
 * === 覆盖范围（照实记） ===
 * · `split` 族（13 种）：在 `temperaFrame.ts` 里（第一批落地）。
 * · `band` 族（9 种）：本文件。
 * · 其余十一族：还没实现，帧里带 `fallback: true` 的兜底构图，按族往下换。
 */

import {
  buildCrossRow,
  buildDotGrid,
  buildDotRow,
  buildHatchLines,
  buildHatchSpec,
  buildScribblePath,
  buildWavyPath,
  circlePolygon,
  diamondPolygon,
} from './temperaHatch';
import type { TemperaDecorMark, TemperaHatchLine, TemperaHatchSpec } from './temperaHatch';
import { temperaHash01 } from './temperaProgram';
import type { TemperaShotKind } from './temperaKinds';
import {
  annularSectorPolygon,
  arcRibbonPolygon,
  buildDiscField,
  discPolygons,
  ellipsePolygon,
  heartPolygon,
  lobedPolygon,
  rotatePolygon,
  roundedRectPolygon,
  scallopBandPolygon,
  starPolygon,
} from './temperaCurves';
import type { TemperaDisc } from './temperaCurves';

export interface TemperaViewport {
  readonly width: number;
  readonly height: number;
}

/** 一块面板上叠的网线（folia 的 `drawHatchFill`）。 */
export interface TemperaHatchSurface {
  readonly spec: TemperaHatchSpec;
  /** 网线的色阶档（0~3）。 */
  readonly tone: number;
  readonly alpha: number;
  /** 入场时从形状中心"长开"（folia 的 `grow`）。 */
  readonly grow: boolean;
}

export interface TemperaPanelSpec {
  /** 多边形顶点，平铺 `[x0, y0, x1, y1, …]`（px，**绝对坐标**）。 */
  readonly points: readonly number[];
  /** 0~3 → `tones.tone[i]`。 */
  readonly tone: number;
  readonly alpha: number;
  /** 入场延迟（shot 内比例 0~1）。 */
  readonly delay: number;
  /** 入场时长（shot 内比例）。 */
  readonly span: number;
  /** 入场位移（px，从该处滑到 0）。 */
  readonly enter: readonly [number, number];
  readonly hatch: TemperaHatchSurface | null;
  /**
   * 这块板上**挖掉的孔**（每个孔是一组多边形顶点）。
   *
   * aperture 族是"冲孔板"：一整片色板，中间干净地开一个洞，露出外壳的活动背景当主体。
   * 孔靠渲染层的 `Graphics.cut()` 从填充里减掉 —— 不是"在洞的位置再画一个背景色形状"
   * （folia 的原文也强调过这点：靠上面盖一块来假装洞，改一次绘制顺序就会露馅）。
   */
  readonly holes: readonly (readonly number[])[];
  /**
   * 整块面板自己的旋转（弧度）与旋转中心（px）。folia 的 poster 族用 `createGroup(rotation, pivotX, pivotY)`
   * 把"斜的重块"放进一个旋转组里，所以顶点仍是绝对坐标，靠这两个值绕锚点转。
   */
  readonly rotation: number;
  readonly pivot: readonly [number, number] | null;
}

export interface TemperaSeamSpec {
  readonly points: readonly number[];
  readonly delay: number;
}

/** 一条线条 / 折线（folia 的 `drawLines` / `drawPolyline`）。 */
export interface TemperaStrokeSpec {
  readonly points: readonly number[];
  readonly tone: number;
  readonly width: number;
  readonly alpha: number;
  readonly delay: number;
  readonly span: number;
  readonly enter: readonly [number, number];
  /** 闭合折线（波浪边、斜带这类要成形的用它）。 */
  readonly closed: boolean;
}

export interface TemperaCompositionSpec {
  readonly panels: readonly TemperaPanelSpec[];
  readonly seams: readonly TemperaSeamSpec[];
  readonly strokes: readonly TemperaStrokeSpec[];
  /** 这一族还没实现、走的是兜底构图（渲染层与探针据此记一次诊断，不静默）。 */
  readonly fallback: boolean;
}

/** 矩形 → 多边形顶点（folia: `rectPolygon`）。 */
export function rectPolygon(x: number, y: number, w: number, h: number): number[] {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

/** 构图的原始描述（装配前）。 */
export interface RawPanel {
  readonly polygon: readonly number[];
  readonly tone: number;
  readonly enterDX: number;
  readonly enterDY: number;
  /** 覆盖默认值（folia 默认：延迟 `index×0.05`、时长 `0.5`、透明度 `0.96`）。 */
  readonly delay?: number;
  readonly span?: number;
  readonly alpha?: number;
  readonly hatch?: TemperaHatchSurface | null;
  readonly rotation?: number;
  readonly pivot?: readonly [number, number] | null;
  readonly holes?: readonly (readonly number[])[];
}

/** 面板统一装配：延迟按序号错落，其中一块叠上网线（folia: `addPanels`）。 */
export function packPanels(
  panels: readonly RawPanel[],
  hatchIndex: number,
  fallbackHatch: TemperaHatchSurface | null = null,
): TemperaPanelSpec[] {
  return panels.map((panel, index) => ({
    points: [...panel.polygon],
    tone: panel.tone,
    alpha: panel.alpha ?? 0.96,
    delay: panel.delay ?? index * 0.05,
    span: panel.span ?? 0.5,
    enter: [panel.enterDX, panel.enterDY] as const,
    hatch: panel.hatch ?? (index === hatchIndex ? fallbackHatch : null),
    rotation: panel.rotation ?? 0,
    pivot: panel.pivot ?? null,
    holes: panel.holes ?? [],
  }));
}

/** 缝：一条压在两块面板交界上的深色窄条（folia: `addSeam`，延迟 0.16、时长 0.5）。 */
export function seamRect(points: readonly number[], delay = 0.16): TemperaSeamSpec {
  return { points: [...points], delay };
}

/**
 * 一条折线。`points` 一律是**连续折线**的顶点序列（`[x0,y0,x1,y1,…]`）——
 * 要画两条互不相连的线，就调用两次（早先我把"每 4 个数一段"混进同一个字段，
 * 渲染层就得猜语义；统一成折线更好读，也更好测）。
 */
const line = (
  points: readonly number[],
  tone: number,
  width: number,
  alpha: number,
  delay: number,
  enterDX = 0,
  enterDY = 0,
  closed = false,
): TemperaStrokeSpec => ({
  points: [...points],
  tone,
  width,
  alpha,
  delay,
  span: 0.5,
  enter: [enterDX, enterDY],
  closed,
});

/**
 * 兜底构图：还没实现的族先画一条**有结构**的横带构图。
 *
 * 它不是"占位灰块"：暗底 + 亮带 + 两条缝 + 两块压角，明暗与层次都在，
 * 所以按族补齐之前，落在这些镜头上的画面也读得出「色块 PV」的味道。
 */
export function fallbackComposition(
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec {
  const { width, height } = viewport;
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
        },
        {
          polygon: rectPolygon(-bleed, height * 0.24, width + bleed * 2, height * 0.2),
          tone: 3,
          enterDX: 0,
          enterDY: -height * 0.3,
        },
        {
          polygon: rectPolygon(width * 0.06, height * 0.52, width * 0.62, height * 0.34),
          tone: 2,
          enterDX: -width * 0.22,
          enterDY: 0,
        },
        {
          polygon: rectPolygon(width * 0.74, height * 0.58, width * 0.26, height * 0.26),
          tone: 1,
          enterDX: width * 0.22,
          enterDY: 0,
        },
      ],
      1,
    ),
    seams: [
      seamRect(rectPolygon(-bleed, height * 0.24 - 1.5, width + bleed * 2, 3)),
      seamRect(rectPolygon(width * 0.06 - 1.5, height * 0.52, 3, height * 0.34)),
    ],
    strokes: [],
    fallback: true,
  };
}

/* ------------------------------------------------------------------ *
 * band 族（folia: compositions/temperaBandCompositions.ts）
 *
 * 横向的层理。凝彩的镜头是**纵向流**，所以这些横带读起来是"景深" ——
 * 一次 shot 交接因此像下潜，而不像切镜头。
 * ------------------------------------------------------------------ */

/** 一条横带压在画面中部，两条引导线贴着它的上下沿；歌词在中调上反色。 */
function bandStrip(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const bandY = height * 0.37;
  const bandHeight = height * 0.3;
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, bandY, width + bleed * 2, bandHeight),
          tone: 2,
          enterDX: -width * 0.5,
          enterDY: 0,
          alpha: 0.96,
          span: 0.55,
        },
      ],
      0,
    ),
    seams: [],
    strokes: [
      line([-bleed, bandY - 10, width + bleed, bandY - 22], 3, 1.4, 0.75, 0.12, width * 0.25),
      line(
        [-bleed, bandY + bandHeight + 22, width + bleed, bandY + bandHeight + 10],
        3,
        1.4,
        0.75,
        0.12,
        width * 0.25,
      ),
    ],
    fallback: false,
  };
}

/** 一条水线：上亮下密，中间一条起波纹的弯月面。 */
function horizonBand(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const waterline = height * (0.5 + temperaHash01(seed, 1, 23) * 0.12);
  const water = rectPolygon(-bleed, waterline, width + bleed * 2, height - waterline + bleed);
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, waterline + bleed),
          tone: 0,
          enterDX: 0,
          enterDY: -height * 0.3,
          alpha: 0.94,
          span: 0.55,
        },
        {
          polygon: water,
          tone: 2,
          enterDX: 0,
          enterDY: height * 0.3,
          alpha: 0.95,
          span: 0.55,
          delay: 0.05,
        },
      ],
      1,
      { spec: { ...buildHatchSpec(seed, 29), angle: 0 }, tone: 3, alpha: 0.55, grow: true },
    ),
    seams: [],
    strokes: [
      line(buildWavyPath(seed, 31, -bleed, width + bleed, waterline, height * 0.012, 30), 3, 2.2, 0.85, 0.16),
    ],
    fallback: false,
  };
}

/** 越往下越密的层理。 */
function deepDive(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const bandHeight = (height + bleed * 2) / 4;
  const panels: RawPanel[] = [];
  const strokes: TemperaStrokeSpec[] = [];
  for (let index = 0; index < 4; index += 1) {
    const top = -bleed + bandHeight * index;
    panels.push({
      polygon: rectPolygon(-bleed, top, width + bleed * 2, bandHeight + 1),
      tone: index,
      enterDX: 0,
      enterDY: height * 0.3,
      alpha: 0.95,
      span: 0.55,
      delay: index * 0.06,
    });
    if (index === 0) continue;
    strokes.push(
      line(
        buildWavyPath(seed, 37 + index, -bleed, width + bleed, top, height * 0.008, 24),
        3,
        1.6,
        0.5,
        index * 0.06 + 0.05,
      ),
    );
  }
  return { panels: packPanels(panels, -1), seams: [], strokes, fallback: false };
}

/** 不用离散面板，改用密度梯度铺满：同一个网线角度，间距一路收紧。 */
function toneRamp(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const spec = buildHatchSpec(seed, 41);
  const panels: RawPanel[] = [
    {
      polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
      tone: 0,
      enterDX: 0,
      enterDY: 0,
      alpha: 0.92,
      span: 0.5,
    },
  ];
  const steps = 4;
  const columnWidth = (width + bleed * 2) / steps;
  for (let index = 0; index < steps; index += 1) {
    panels.push({
      polygon: rectPolygon(-bleed + columnWidth * index, -bleed, columnWidth, height + bleed * 2),
      tone: 0,
      enterDX: 0,
      enterDY: 0,
      alpha: 0,
      delay: index * 0.06,
      span: 0.55,
      hatch: {
        spec: { ...spec, spacing: spec.spacing * (1.6 - index * 0.32) },
        tone: 3,
        alpha: 0.6,
        grow: true,
      },
    });
  }
  return { panels: packPanels(panels, -1), seams: [], strokes: [], fallback: false };
}

/** 两条轨道夹出一条亮缝，歌词站在缝里。 */
function doubleBand(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const slot = height * (0.2 + temperaHash01(seed, 51, 43) * 0.08);
  const rail = height * 0.3;
  const top = (height - slot) / 2 - rail;
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, top, width + bleed * 2, rail),
          tone: 2,
          enterDX: -width * 0.4,
          enterDY: 0,
          alpha: 0.95,
          span: 0.55,
        },
        {
          polygon: rectPolygon(-bleed, top + rail + slot, width + bleed * 2, rail),
          tone: 3,
          enterDX: width * 0.4,
          enterDY: 0,
          alpha: 0.95,
          span: 0.55,
          delay: 0.07,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [],
    fallback: false,
  };
}

/** 一条离了水平的带，两头都跑出画面。 */
function tiltBand(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const lean = height * (0.14 + temperaHash01(seed, 53, 47) * 0.14);
  const half = height * 0.17;
  const band = [
    -bleed,
    height / 2 + lean - half,
    width + bleed,
    height / 2 - lean - half,
    width + bleed,
    height / 2 - lean + half,
    -bleed,
    height / 2 + lean + half,
  ];
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
        {
          polygon: band,
          tone: 3,
          enterDX: -width * 0.35,
          enterDY: 0,
          alpha: 0.95,
          span: 0.55,
          delay: 0.06,
          hatch: { spec: { ...buildHatchSpec(seed, 59), angle: Math.PI / 2 }, tone: 0, alpha: 0.3, grow: true },
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [line(band, 0, 1.2, 0.35, 0.12, 0, 0, true)],
    fallback: false,
  };
}

/** 上下两条重轨压住画幅，中间留空。 */
function edgeRails(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const rail = height * (0.16 + temperaHash01(seed, 61, 53) * 0.06);
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, rail + bleed),
          tone: 2,
          enterDX: 0,
          enterDY: -height * 0.2,
          alpha: 0.94,
          span: 0.55,
        },
        {
          polygon: rectPolygon(-bleed, height - rail, width + bleed * 2, rail + bleed),
          tone: 2,
          enterDX: 0,
          enterDY: height * 0.2,
          alpha: 0.94,
          span: 0.55,
          delay: 0.06,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      line([-bleed, rail + 8, width + bleed, rail + 8], 3, 1.2, 0.6, 0.16, width * 0.2),
      line([-bleed, height - rail - 8, width + bleed, height - rail - 8], 3, 1.2, 0.6, 0.16, width * 0.2),
    ],
    fallback: false,
  };
}

/** 一整片满幅色调，网线朝一边越收越紧 —— 是一堵"色调墙"，不是一条带。 */
function gradientWall(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const spec = buildHatchSpec(seed, 67);
  const downward = temperaHash01(seed, 71, 59) > 0.5;
  const steps = 5;
  const bandHeight = height / steps;
  const panels: RawPanel[] = [
    {
      polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
      tone: 1,
      enterDX: 0,
      enterDY: 0,
      alpha: 0.94,
      span: 0.5,
    },
  ];
  for (let index = 0; index < steps; index += 1) {
    const rank = downward ? index : steps - 1 - index;
    const top = bandHeight * index - (index === 0 ? bleed : 0);
    const bottom = bandHeight * (index + 1) + (index === steps - 1 ? bleed : 0);
    panels.push({
      polygon: rectPolygon(-bleed, top, width + bleed * 2, bottom - top),
      tone: 1,
      enterDX: 0,
      enterDY: 0,
      alpha: 0,
      delay: index * 0.05,
      span: 0.55,
      hatch: {
        spec: { ...spec, spacing: spec.spacing * (1.9 - rank * 0.34) },
        tone: 3,
        alpha: 0.55,
        grow: true,
      },
    });
  }
  return { panels: packPanels(panels, -1), seams: [], strokes: [], fallback: false };
}

/** 一级级往里退的阶梯层理。 */
function terrace(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const bandHeight = height / 4;
  const panels: RawPanel[] = [
    {
      polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
      tone: 0,
      enterDX: 0,
      enterDY: 0,
      alpha: 0.9,
      span: 0.5,
    },
  ];
  for (let index = 0; index < 4; index += 1) {
    const left = width * index * 0.14 - bleed;
    const top = bandHeight * index - (index === 0 ? bleed : 0);
    const bottom = bandHeight * (index + 1) + (index === 3 ? bleed : 1);
    panels.push({
      polygon: rectPolygon(left, top, width + bleed * 2 - left - bleed, bottom - top),
      tone: index,
      enterDX: -width * 0.25,
      enterDY: 0,
      alpha: 0.94,
      delay: index * 0.06,
      span: 0.55,
    });
  }
  return { panels: packPanels(panels, -1), seams: [], strokes: [], fallback: false };
}

const BAND_BUILDERS: Partial<
  Record<TemperaShotKind, (seed: number, viewport: TemperaViewport, bleed: number) => TemperaCompositionSpec>
> = {
  'band-strip': bandStrip,
  'horizon-band': horizonBand,
  'deep-dive': deepDive,
  'tone-ramp': toneRamp,
  'double-band': doubleBand,
  'tilt-band': tiltBand,
  'edge-rails': edgeRails,
  'gradient-wall': gradientWall,
  terrace,
};

/** band 族；`null` = 这个 kind 不属本族（交给别族或兜底）。 */
export function buildTemperaBandComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec | null {
  const builder = BAND_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed);
}

/* ------------------------------------------------------------------ *
 * frame 族（folia: compositions/temperaFrameCompositions.ts）
 *
 * 带框的"窗口"。它把字句拢在一小块安静的地方，让周围的调子去做戏 ——
 * 一个段落需要喘口气时，就切到这一族。
 * ------------------------------------------------------------------ */

/** folia 的 `palette.ink`（深墨）在我们这里对应四档里最深的那一档。 */
const INK_TONE = 3;

/** 把一行十字记号转成线段（folia: `drawCrossMarks`；每个十字是两笔，带自己的抖动角）。 */
function crossMarks(
  marks: readonly TemperaDecorMark[],
  tone: number,
  width: number,
  alpha: number,
  delay: number,
): TemperaStrokeSpec[] {
  return marks.flatMap((mark, index) => {
    const cos = Math.cos(mark.rotation);
    const sin = Math.sin(mark.rotation);
    const arm = mark.size;
    const rotate = (dx: number, dy: number): [number, number] => [
      mark.x + dx * cos - dy * sin,
      mark.y + dx * sin + dy * cos,
    ];
    const horizontal = [rotate(-arm, 0), rotate(arm, 0)] as const;
    const vertical = [rotate(0, -arm), rotate(0, arm)] as const;
    return [
      line([...horizontal[0], ...horizontal[1]], tone, width, alpha, delay + index * 0.02),
      line([...vertical[0], ...vertical[1]], tone, width, alpha, delay + index * 0.02),
    ];
  });
}

/** 把一行方点转成线段（folia: `drawSquareMarks`；每个方点是闭合的四笔）。 */
function squareMarks(
  marks: readonly TemperaDecorMark[],
  tone: number,
  alpha: number,
  delay: number,
): TemperaStrokeSpec[] {
  return marks.map((mark, index) => {
    const half = mark.size * 0.5;
    const cos = Math.cos(mark.rotation);
    const sin = Math.sin(mark.rotation);
    const point = (dx: number, dy: number): number[] => [
      mark.x + dx * cos - dy * sin,
      mark.y + dx * sin + dy * cos,
    ];
    const points = [
      ...point(-half, -half),
      ...point(half, -half),
      ...point(half, half),
      ...point(-half, half),
    ];
    return line(points, tone, 1.4, alpha, delay + index * 0.02, 0, 0, true);
  });
}

/** 圆心 / 菱形中心的 `n` 层同心描边（folia: `drawConcentricDiamonds`）。 */
function concentricDiamonds(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  count: number,
): number[][] {
  const rings: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    const scale = 1 - index / count;
    rings.push(diamondPolygon(cx, cy, rx * scale, ry * scale));
  }
  return rings;
}

/** 带框的菱窗：中间一片网线菱形 + 三层同心菱框。 */
function frameWindow(seed: number, viewport: TemperaViewport, _bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const cx = width / 2;
  const cy = height / 2;
  const rx = width * 0.42;
  const ry = height * 0.44;
  const strokes: TemperaStrokeSpec[] = concentricDiamonds(cx, cy, rx, ry, 3).map((ring, index) =>
    line(ring, INK_TONE, 1.6, 0.9, 0.08 + index * 0.03, 0, height * 0.06, true),
  );
  return {
    panels: packPanels(
      [
        {
          polygon: diamondPolygon(cx, cy, rx * 0.78, ry * 0.78),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0,
          span: 0.6,
          delay: 0,
          hatch: { spec: buildHatchSpec(seed, 23, 1.4), tone: 1, alpha: 0.45, grow: true },
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      ...strokes,
      ...crossMarks(
        buildCrossRow(seed, 29, width * 0.08, height * 0.14, 3, width * 0.045, 8),
        3,
        1.8,
        0.85,
        0.22,
      ),
      ...squareMarks(
        buildDotRow(seed, 37, width * 0.92, height * 0.62, 4, height * 0.06, 7),
        3,
        0.8,
        0.28,
      ),
    ],
    fallback: false,
  };
}

/** 两个错位的矩形：字句坐在其中一个里，压着另一个的边。 */
function doubleFrame(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const offset = width * 0.05;
  const box = rectPolygon(width * 0.16, height * 0.2, width * 0.68, height * 0.6);
  const shifted = rectPolygon(
    width * 0.16 + offset,
    height * 0.2 + offset * 0.6,
    width * 0.68,
    height * 0.6,
  );
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
        {
          polygon: shifted,
          tone: 2,
          enterDX: offset * 3,
          enterDY: 0,
          alpha: 0.8,
          span: 0.55,
          delay: 0.06,
        },
        {
          polygon: box,
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0,
          span: 0.55,
          delay: 0.1,
          hatch: { spec: buildHatchSpec(seed, 43), tone: 3, alpha: 0.4, grow: true },
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [line(box, INK_TONE, 3.5, 0.9, 0.14, 0, -height * 0.08, true)],
    fallback: false,
  };
}

/** 圆窗：整片网线打底，开一个干净的圆。 */
function circleWindow(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const radius = Math.min(width, height) * 0.34;
  const circle = circlePolygon(width / 2, height / 2, radius);
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 2,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.92,
          span: 0.5,
          hatch: { spec: buildHatchSpec(seed, 47), tone: 3, alpha: 0.4, grow: true },
        },
        {
          polygon: circle,
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.95,
          span: 0.55,
          delay: 0.08,
        },
        {
          polygon: circlePolygon(width / 2, height / 2, radius * 1.12),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0,
          span: 0.5,
          delay: 0.2,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      line(circle, INK_TONE, 3, 0.9, 0.14, 0, 0, true),
      line(circlePolygon(width / 2, height / 2, radius * 1.12), INK_TONE, 1.2, 0.55, 0.2, 0, 0, true),
    ],
    fallback: false,
  };
}

/** 一侧的阶梯括号：读起来是页边标尺，而不是一个关起来的盒子。 */
function ladderFrame(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const left = width * 0.14;
  const strokes: TemperaStrokeSpec[] = [];
  for (let index = 0; index < 5; index += 1) {
    const y = height * (0.18 + index * 0.14);
    const run = width * (0.06 + index * 0.03);
    strokes.push(
      line([left, y, left + run, y], 3, index % 2 === 0 ? 3 : 1.4, 0.85, index * 0.05, -width * 0.1),
      line([left, y, left, y + height * 0.14], 3, index % 2 === 0 ? 3 : 1.4, 0.85, index * 0.05, -width * 0.1),
    );
  }
  strokes.push(
    line([width * 0.9, -bleed, width * 0.9, height + bleed], 3, 1.4, 0.6, 0.28, 0, height * 0.2),
  );
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
      ],
      -1,
    ),
    seams: [],
    strokes,
    fallback: false,
  };
}

/** 四角的 L 形括号。 */
function cornerBrackets(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const inset = Math.min(width, height) * 0.12;
  const arm = Math.min(width, height) * 0.16;
  const corners: readonly (readonly [number, number, number, number])[] = [
    [inset, inset, 1, 1],
    [width - inset, inset, -1, 1],
    [inset, height - inset, 1, -1],
    [width - inset, height - inset, -1, -1],
  ];
  const strokes: TemperaStrokeSpec[] = corners.flatMap(([x, y, sx, sy], index) => [
    line(
      [x, y, x + sx * arm, y],
      INK_TONE,
      3.5,
      0.9,
      index * 0.05,
      sx * width * 0.06,
      sy * height * 0.06,
    ),
    line(
      [x, y, x, y + sy * arm],
      INK_TONE,
      3.5,
      0.9,
      index * 0.05,
      sx * width * 0.06,
      sy * height * 0.06,
    ),
  ]);
  const dotted = temperaHash01(seed, 2, 53) > 0.5;
  strokes.push(
    ...(dotted
      ? squareMarks(buildDotRow(seed, 59, width * 0.5, height * 0.16, 3, width * 0.03, 6, 0), 3, 0.8, 0.24)
      : crossMarks(buildCrossRow(seed, 61, width * 0.44, height * 0.84, 3, width * 0.04, 7), 3, 1.8, 0.8, 0.24)),
  );
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 1,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
      ],
      -1,
    ),
    seams: [],
    strokes,
    fallback: false,
  };
}

/** 一个内缩的淡矩形：拢住一句话最安静的方式。 */
function insetBox(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const box = rectPolygon(width * 0.14, height * 0.2, width * 0.72, height * 0.6);
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
        {
          polygon: box,
          tone: 2,
          enterDX: 0,
          enterDY: height * 0.06,
          alpha: 0.55,
          span: 0.55,
          delay: 0.05,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [line(box, INK_TONE, 2.4, 0.85, 0.1, 0, 0, true)],
    fallback: false,
  };
}

/** 一对相向的方括号，字句坐在两颌之间。 */
function bracketPair(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const inset = width * 0.16;
  const arm = width * 0.09;
  const top = height * 0.26;
  const bottom = height * 0.74;
  const sides: readonly (1 | -1)[] = [1, -1];
  // 每侧三条**独立**线段（横臂 / 竖梁 / 横臂）：连成一条折线会多出两根斜线。
  const strokes: TemperaStrokeSpec[] = sides.flatMap((side, index) => {
    const x = side === 1 ? inset : width - inset;
    const enterDX = side * width * 0.08;
    return [
      line([x, top, x + side * arm, top], INK_TONE, 4, 0.9, index * 0.07, enterDX),
      line([x, top, x, bottom], INK_TONE, 4, 0.9, index * 0.07, enterDX),
      line([x, bottom, x + side * arm, bottom], INK_TONE, 4, 0.9, index * 0.07, enterDX),
    ];
  });
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 1,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
      ],
      -1,
    ),
    seams: [],
    strokes,
    fallback: false,
  };
}

/** 拱窗：一个半圆骑在矩形上。 */
function archWindow(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const radius = width * 0.24;
  const cx = width / 2;
  const shoulder = height * 0.42;
  const arch = circlePolygon(cx, shoulder, radius, 48);
  const body = rectPolygon(cx - radius, shoulder, radius * 2, height * 0.4);
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 2,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.92,
          span: 0.5,
        },
        {
          polygon: arch,
          tone: 0,
          enterDX: 0,
          enterDY: -height * 0.08,
          alpha: 0.95,
          span: 0.55,
          delay: 0.05,
        },
        {
          polygon: body,
          tone: 0,
          enterDX: 0,
          enterDY: height * 0.08,
          alpha: 0.95,
          span: 0.55,
          delay: 0.05,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      line(arch, INK_TONE, 2.4, 0.8, 0.12, 0, 0, true),
      line(body, INK_TONE, 2.4, 0.8, 0.12, 0, 0, true),
    ],
    fallback: false,
  };
}

/** 3×3 的细格：歌词横穿中间那一行。 */
function gridCells(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const left = width * 0.12;
  const top = height * 0.18;
  const cellWidth = (width * 0.76) / 3;
  const cellHeight = (height * 0.64) / 3;
  const panels: RawPanel[] = [
    {
      polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
      tone: 0,
      enterDX: 0,
      enterDY: 0,
      alpha: 0.9,
      span: 0.5,
    },
  ];
  const strokes: TemperaStrokeSpec[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const cell = rectPolygon(
        left + cellWidth * column,
        top + cellHeight * row,
        cellWidth,
        cellHeight,
      );
      const index = row * 3 + column;
      if (row === 1 && column === 1) {
        panels.push({
          polygon: cell,
          tone: 3,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.75,
          span: 0.5,
          delay: index * 0.03,
        });
      }
      strokes.push(line(cell, 3, 1.2, 0.6, index * 0.03, 0, 0, true));
    }
  }
  return { panels: packPanels(panels, -1), seams: [], strokes, fallback: false };
}

/** 钥匙孔：圆头压一条窄缝。 */
function keyhole(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const radius = Math.min(width, height) * 0.19;
  const cx = width / 2;
  const cy = height * 0.36;
  const head = circlePolygon(cx, cy, radius, 48);
  const shaft = rectPolygon(cx - radius * 0.55, cy, radius * 1.1, height * 0.46);
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 3,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.94,
          span: 0.5,
        },
        {
          polygon: head,
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.96,
          span: 0.55,
          delay: 0.05,
        },
        {
          polygon: shaft,
          tone: 0,
          enterDX: 0,
          enterDY: height * 0.1,
          alpha: 0.96,
          span: 0.55,
          delay: 0.08,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [line(head, INK_TONE, 2, 0.7, 0.14, 0, 0, true)],
    fallback: false,
  };
}

const FRAME_BUILDERS: Partial<
  Record<TemperaShotKind, (seed: number, viewport: TemperaViewport, bleed: number) => TemperaCompositionSpec>
> = {
  'frame-window': frameWindow,
  'double-frame': doubleFrame,
  'circle-window': circleWindow,
  'ladder-frame': ladderFrame,
  'corner-brackets': cornerBrackets,
  'inset-box': insetBox,
  'bracket-pair': bracketPair,
  'arch-window': archWindow,
  'grid-cells': gridCells,
  keyhole,
};

/** frame 族；`null` = 这个 kind 不属本族。 */
export function buildTemperaFrameComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec | null {
  const builder = FRAME_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed);
}

/* ------------------------------------------------------------------ *
 * poster 族（folia: compositions/temperaPosterCompositions.ts）
 *
 * 斜的大重块。这一族是**最响**的构图：一块占压倒性的实色，字句必须跟它较劲 ——
 * 也正是这种地方，文字反色（difference filter）在 folia 里最看得出来。
 *
 * 注意坐标系：folia 用 `createGroup(rotation, pivotX, pivotY)` 把形状放进一个**以 pivot 为原点**的
 * 旋转组里，所以它写的局部坐标要加上 pivot 才是屏幕坐标。我们这边顶点一律存**绝对坐标**，
 * 另用 `rotation` + `pivot` 让渲染层绕锚点转。
 * ------------------------------------------------------------------ */

/** 把以 pivot 为原点的矩形转成绝对坐标顶点。 */
const localRect = (
  pivotX: number,
  pivotY: number,
  x: number,
  y: number,
  width: number,
  height: number,
): number[] => rectPolygon(pivotX + x, pivotY + y, width, height);

/** 把以 pivot 为原点的菱形转成绝对坐标顶点。 */
const localDiamond = (
  pivotX: number,
  pivotY: number,
  x: number,
  y: number,
  rx: number,
  ry: number,
): number[] => diamondPolygon(pivotX + x, pivotY + y, rx, ry);

/** 一块斜的大菱形 + 一块带网线的菱形 + 一条波浪线，整组斜 -0.06 弧度。 */
function posterPanel(seed: number, viewport: TemperaViewport, _bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const pivotX = width / 2;
  const pivotY = height / 2;
  const rotation = -0.06;
  const hatched = localDiamond(pivotX, pivotY, width * 0.2, -height * 0.06, width * 0.3, height * 0.48);
  const wave = buildWavyPath(seed, 43, -width * 0.6, width * 0.6, height * 0.42, height * 0.02)
    .reduce<number[]>((accumulator, value, index) => {
      if (index % 2 === 0) accumulator.push(pivotX + value);
      else accumulator.push(pivotY + value);
      return accumulator;
    }, []);
  return {
    panels: packPanels(
      [
        {
          polygon: localDiamond(pivotX, pivotY, -width * 0.12, 0, width * 0.42, height * 0.66),
          tone: INK_TONE,
          enterDX: -width * 0.6,
          enterDY: 0,
          alpha: 0.92,
          span: 0.55,
          rotation,
          pivot: [pivotX, pivotY],
        },
        {
          polygon: hatched,
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0,
          span: 0.55,
          delay: 0.08,
          hatch: { spec: buildHatchSpec(seed, 41), tone: 3, alpha: 0.7, grow: true },
          rotation,
          pivot: [pivotX, pivotY],
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      line(hatched, INK_TONE, 2, 0.8, 0.12, 0, 0, true),
      { ...line(wave, 3, 2, 0.7, 0.2, 0, height * 0.1), span: 0.5 },
    ],
    fallback: false,
  };
}

/** 三个越来越小的菱形往画外走，字句骑在最大的那个上。 */
function diamondStack(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const tones = [INK_TONE, 3, 2];
  const panels: RawPanel[] = [
    {
      polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
      tone: 0,
      enterDX: 0,
      enterDY: 0,
      alpha: 0.9,
      span: 0.5,
    },
  ];
  tones.forEach((tone, index) => {
    const scale = 1 - index * 0.28;
    panels.push({
      polygon: diamondPolygon(
        width * (0.34 + index * 0.24),
        height * (0.52 - index * 0.14),
        width * 0.3 * scale,
        height * 0.46 * scale,
      ),
      tone,
      enterDX: width * 0.25,
      enterDY: -height * 0.12,
      alpha: 0.93,
      span: 0.55,
      delay: index * 0.07,
    });
  });
  return { panels: packPanels(panels, -1), seams: [], strokes: [], fallback: false };
}

/** 一道横扫画面的宽斜杠，反向的网线压在上面。 */
function slashPoster(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const lean = height * 0.34;
  const band = [
    -bleed,
    height * 0.24 + lean,
    width + bleed,
    height * 0.24 - lean,
    width + bleed,
    height * 0.72 - lean,
    -bleed,
    height * 0.72 + lean,
  ];
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
        {
          polygon: band,
          tone: 3,
          enterDX: -width * 0.4,
          enterDY: 0,
          alpha: 0.94,
          span: 0.55,
          delay: 0.05,
          hatch: {
            spec: { ...buildHatchSpec(seed, 67), angle: Math.PI / 3 },
            tone: 0,
            alpha: 0.3,
            grow: true,
          },
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [line(band, INK_TONE, 2.2, 0.8, 0.14, 0, 0, true)],
    fallback: false,
  };
}

/** 一个横贯画面的箭头楔（呼应参考图里的屋顶线母题）。 */
function arrowWedge(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const apex = height * (0.24 + temperaHash01(seed, 3, 71) * 0.14);
  const thickness = height * 0.2;
  const chevron = [
    -bleed,
    height + bleed,
    width * 0.5,
    apex,
    width + bleed,
    height + bleed,
    width + bleed,
    height + bleed,
    width * 0.5,
    apex + thickness,
    -bleed,
    height + bleed,
  ];
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
        {
          polygon: [-bleed, height + bleed, width * 0.5, apex, width + bleed, height + bleed],
          tone: 3,
          enterDX: 0,
          enterDY: height * 0.3,
          alpha: 0.94,
          span: 0.55,
          delay: 0.05,
        },
        {
          polygon: chevron,
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0,
          span: 0.55,
          delay: 0.1,
          hatch: {
            spec: { ...buildHatchSpec(seed, 73), angle: -Math.PI / 4 },
            tone: 0,
            alpha: 0.35,
            grow: true,
          },
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      line(
        [-bleed, height * 0.9, width * 0.5, apex - thickness * 0.4, width + bleed, height * 0.9],
        INK_TONE,
        2,
        0.7,
        0.16,
        0,
        -height * 0.1,
      ),
    ],
    fallback: false,
  };
}

/** 一块从侧边推进来的重物，字句留在露出来的纸面上。 */
function edgeBleed(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const fromLeft = temperaHash01(seed, 4, 79) > 0.5;
  const cover = width * 0.42;
  const mass = fromLeft
    ? rectPolygon(-bleed, -bleed, cover + bleed, height + bleed * 2)
    : rectPolygon(width - cover, -bleed, cover + bleed, height + bleed * 2);
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
        {
          polygon: mass,
          tone: INK_TONE,
          enterDX: (fromLeft ? -1 : 1) * width * 0.4,
          enterDY: 0,
          alpha: 0.93,
          span: 0.55,
          delay: 0.05,
          hatch: { spec: buildHatchSpec(seed, 83), tone: 0, alpha: 0.22, grow: true },
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [],
    fallback: false,
  };
}

/** 一个贴着某条边的三角，几乎占满画面。 */
function triangleMass(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const fromLeft = temperaHash01(seed, 91, 89) > 0.5;
  const apexX = fromLeft ? width * 1.02 : -width * 0.02;
  const triangle = [
    fromLeft ? -bleed : width + bleed,
    -bleed,
    fromLeft ? -bleed : width + bleed,
    height + bleed,
    apexX,
    height * (0.3 + temperaHash01(seed, 93, 97) * 0.3),
  ];
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
        {
          polygon: triangle,
          tone: 3,
          enterDX: (fromLeft ? -1 : 1) * width * 0.35,
          enterDY: 0,
          alpha: 0.94,
          span: 0.55,
          delay: 0.05,
          hatch: { spec: buildHatchSpec(seed, 101), tone: 0, alpha: 0.24, grow: true },
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [],
    fallback: false,
  };
}

/** 两条反向斜带交叉，叠在一起的地方调子翻倍。 */
function ribbonCross(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const half = height * 0.14;
  const lean = height * 0.3;
  const ribbon = (sign: number): number[] => [
    -bleed,
    height / 2 + sign * lean - half,
    width + bleed,
    height / 2 - sign * lean - half,
    width + bleed,
    height / 2 - sign * lean + half,
    -bleed,
    height / 2 + sign * lean + half,
  ];
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
        {
          polygon: ribbon(1),
          tone: 2,
          enterDX: -width * 0.3,
          enterDY: 0,
          alpha: 0.8,
          span: 0.55,
          delay: 0.05,
        },
        {
          polygon: ribbon(-1),
          tone: 3,
          enterDX: width * 0.3,
          enterDY: 0,
          alpha: 0.8,
          span: 0.55,
          delay: 0.11,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [],
    fallback: false,
  };
}

/** 一个大到只有肩部在画面里的圆盘。 */
function halfDisc(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const fromRight = temperaHash01(seed, 103, 107) > 0.5;
  const radius = Math.hypot(width, height) * 0.62;
  const disc = circlePolygon(fromRight ? width + radius * 0.55 : -radius * 0.55, height * 0.5, radius, 64);
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
        {
          polygon: disc,
          tone: 3,
          enterDX: (fromRight ? 1 : -1) * width * 0.3,
          enterDY: 0,
          alpha: 0.94,
          span: 0.55,
          delay: 0.05,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [line(disc, INK_TONE, 2, 0.6, 0.12, 0, 0, true)],
    fallback: false,
  };
}

/** 三块错位旋转的板叠在一起，像随手丢在桌上的纸。 */
function stackedSlabs(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const pivotX = width / 2;
  const pivotY = height / 2;
  const tones = [1, 2, 3];
  const panels: RawPanel[] = [
    {
      polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
      tone: 0,
      enterDX: 0,
      enterDY: 0,
      alpha: 0.9,
      span: 0.5,
    },
  ];
  tones.forEach((tone, index) => {
    panels.push({
      polygon: localRect(
        pivotX,
        pivotY,
        -width * (0.42 - index * 0.05),
        -height * (0.3 - index * 0.03),
        width * (0.84 - index * 0.1),
        height * (0.6 - index * 0.06),
      ),
      tone,
      enterDX: width * 0.2,
      enterDY: height * 0.12,
      alpha: 0.93,
      span: 0.55,
      delay: index * 0.07,
      rotation: -0.09 + index * 0.08,
      pivot: [pivotX, pivotY],
    });
  });
  return { panels: packPanels(panels, -1), seams: [], strokes: [], fallback: false };
}

/** 两块楔子从相对的边咬进来，中间留出一个沙漏形的纸面。 */
function wedgePair(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const waist = width * (0.2 + temperaHash01(seed, 109, 113) * 0.1);
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
        },
        {
          polygon: [-bleed, -bleed, (width - waist) / 2, height / 2, -bleed, height + bleed],
          tone: 3,
          enterDX: -width * 0.25,
          enterDY: 0,
          alpha: 0.94,
          span: 0.55,
          delay: 0.05,
        },
        {
          polygon: [width + bleed, -bleed, (width + waist) / 2, height / 2, width + bleed, height + bleed],
          tone: 3,
          enterDX: width * 0.25,
          enterDY: 0,
          alpha: 0.94,
          span: 0.55,
          delay: 0.11,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [],
    fallback: false,
  };
}

const POSTER_BUILDERS: Partial<
  Record<TemperaShotKind, (seed: number, viewport: TemperaViewport, bleed: number) => TemperaCompositionSpec>
> = {
  'poster-panel': posterPanel,
  'diamond-stack': diamondStack,
  'slash-poster': slashPoster,
  'arrow-wedge': arrowWedge,
  'edge-bleed': edgeBleed,
  'triangle-mass': triangleMass,
  'ribbon-cross': ribbonCross,
  'half-disc': halfDisc,
  'stacked-slabs': stackedSlabs,
  'wedge-pair': wedgePair,
};

/** poster 族；`null` = 这个 kind 不属本族。 */
export function buildTemperaPosterComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec | null {
  const builder = POSTER_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed);
}

/* ------------------------------------------------------------------ *
 * sparse 族（folia: compositions/temperaSparseCompositions.ts）
 *
 * 近乎空白的构图，留给"喘气"的段落：细线、点阵、手绘笔画，几乎没有色调块面，
 * 所以字句读起来像耳语。这一族多数**连一块面板都没有** —— 画面全靠线条撑。
 * ------------------------------------------------------------------ */

/** folia 的 `palette.line`：细线用的中调灰。 */
const LINE_TONE = 1;

/** 三条横细线，等宽居中。 */
function quietLine(seed: number, viewport: TemperaViewport, _bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const gridWidth = width * 0.7;
  const gridX = (width - gridWidth) / 2;
  const strokes = [0.38, 0.5, 0.62].map((ratio, index) =>
    line(
      [gridX, height * ratio, gridX + gridWidth, height * ratio],
      LINE_TONE,
      1,
      1,
      index * 0.08,
      (index % 2 === 0 ? -1 : 1) * width * 0.2,
    ),
  );
  strokes.push(
    line(
      buildScribblePath(seed, 47, width * 0.2, height * 0.26, Math.min(width, height) * 0.09, 2),
      3,
      1.6,
      0.7,
      0.24,
    ),
  );
  // 草簇：从一个基线点扇出去的几笔短线。
  const tuftX = width * 0.82;
  const tuftY = height * 0.74;
  for (let index = 0; index < 6; index += 1) {
    const lean = (temperaHash01(seed, index, 59) - 0.5) * 34;
    strokes.push(
      line(
        [tuftX + index * 7, tuftY, tuftX + index * 7 + lean, tuftY - 24 - index * 3],
        3,
        1.4,
        0.7,
        0.3,
      ),
    );
  }
  return { panels: [], seams: [], strokes, fallback: false };
}

/** 一片点阵，朝一边变稀，字句浮在稀的那半边。 */
function starfieldDots(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const spacing = Math.max(24, Math.sqrt((width * height) / 900));
  const marks = buildDotGrid(width + bleed, height + bleed, spacing, 2.6);
  const dense = marks.filter((mark) => mark.y > height * 0.45);
  const sparse = marks.filter(
    (mark) => mark.y <= height * 0.45 && (mark.x + mark.y) % 3 < 1,
  );
  return {
    panels: [],
    seams: [],
    strokes: [
      ...squareMarks(dense, 3, 0.45, 0).map((stroke) => ({ ...stroke, enter: [0, height * 0.2] as const })),
      ...squareMarks(sparse, 3, 0.25, 0.08).map((stroke) => ({ ...stroke, enter: [0, -height * 0.15] as const })),
      line([-bleed, height * 0.45, width + bleed, height * 0.45], 3, 1.2, 0.5, 0.2, width * 0.2),
    ],
    fallback: false,
  };
}

/** 一层层起伏的同心线，像贴着水面往下看。 */
function rippleLines(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const strokes: TemperaStrokeSpec[] = [];
  for (let index = 0; index < 7; index += 1) {
    const y = height * (0.16 + index * 0.11);
    const amplitude = height * (0.006 + index * 0.004);
    strokes.push(
      line(
        buildWavyPath(seed, 89 + index, -bleed, width + bleed, y, amplitude, 26),
        3,
        index % 3 === 0 ? 2 : 1.1,
        0.55,
        index * 0.045,
        (index % 2 === 0 ? -1 : 1) * width * 0.15,
      ),
    );
  }
  return { panels: [], seams: [], strokes, fallback: false };
}

/** 满幅的细线格：6 列 × 4 行的发丝线。 */
function hairGrid(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const columns = 6;
  const rows = 4;
  const strokes: TemperaStrokeSpec[] = [];
  for (let index = 0; index <= columns; index += 1) {
    const x = (width / columns) * index;
    strokes.push(line([x, -bleed, x, height + bleed], LINE_TONE, 1, 0.8, 0, 0, -height * 0.1));
  }
  for (let index = 0; index <= rows; index += 1) {
    const y = (height / rows) * index;
    strokes.push(line([-bleed, y, width + bleed, y], LINE_TONE, 1, 0.8, 0.08, width * 0.1));
  }
  return { panels: [], seams: [], strokes, fallback: false };
}

/** 一侧页边压一条粗竖线，旁边挂几个定位方点。 */
function marginRule(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const fromLeft = temperaHash01(seed, 121, 127) > 0.5;
  const x = fromLeft ? width * 0.12 : width * 0.88;
  const marks = [0, 1, 2].map((index) => ({
    x: x + (fromLeft ? 22 : -22),
    y: height * (0.32 + index * 0.18),
    size: 7,
    rotation: 0,
  }));
  return {
    panels: packPanels(
      [
        {
          polygon: rectPolygon(x - 3, -bleed, 6, height + bleed * 2),
          tone: 3,
          enterDX: 0,
          enterDY: height * 0.15,
          alpha: 0.9,
          span: 0.6,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: squareMarks(marks, 3, 0.8, 0.22),
    fallback: false,
  };
}

/** 点阵沿一条对角线变稀。 */
function dotDrift(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const spacing = Math.max(22, Math.sqrt((width * height) / 1200));
  const marks = buildDotGrid(width + bleed, height + bleed, spacing, 2.4);
  const span = width + height;
  const near = marks.filter((mark) => mark.x + mark.y > span * 0.5);
  const far = marks.filter(
    (mark) => mark.x + mark.y <= span * 0.5 && (mark.x + mark.y) % 2 < 1,
  );
  return {
    panels: [],
    seams: [],
    strokes: [
      ...squareMarks(near, 3, 0.5, 0).map((stroke) => ({ ...stroke, enter: [width * 0.12, 0] as const })),
      ...squareMarks(far, 3, 0.24, 0.08).map((stroke) => ({ ...stroke, enter: [-width * 0.12, 0] as const })),
    ],
    fallback: false,
  };
}

/** 圆心在画面外的同心圆，只有几段弧扫过画面。 */
function arcSweep(seed: number, viewport: TemperaViewport, _bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const cx = width * (temperaHash01(seed, 131, 137) > 0.5 ? 1.15 : -0.15);
  const cy = height * 1.05;
  const base = Math.hypot(width, height) * 0.42;
  const strokes: TemperaStrokeSpec[] = [];
  for (let index = 0; index < 5; index += 1) {
    strokes.push(
      line(
        circlePolygon(cx, cy, base + index * base * 0.22, 72),
        3,
        index % 2 === 0 ? 1.8 : 1,
        0.55,
        index * 0.05,
        0,
        height * 0.08,
        true,
      ),
    );
  }
  return { panels: [], seams: [], strokes, fallback: false };
}

/** 近乎空白的纸，只有一个小定位记号 —— 段落前的那口呼吸。 */
function blankPage(seed: number, viewport: TemperaViewport, _bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  return {
    panels: [],
    seams: [],
    strokes: [
      line([width * 0.18, height * 0.7, width * 0.36, height * 0.7], LINE_TONE, 1.4, 0.8, 0, -width * 0.12),
      line(
        buildScribblePath(seed, 139, width * 0.82, height * 0.26, Math.min(width, height) * 0.06, 2),
        3,
        1.4,
        0.6,
        0.28,
      ),
    ],
    fallback: false,
  };
}

const SPARSE_BUILDERS: Partial<
  Record<TemperaShotKind, (seed: number, viewport: TemperaViewport, bleed: number) => TemperaCompositionSpec>
> = {
  'quiet-line': quietLine,
  'starfield-dots': starfieldDots,
  'ripple-lines': rippleLines,
  'hair-grid': hairGrid,
  'margin-rule': marginRule,
  'dot-drift': dotDrift,
  'arc-sweep': arcSweep,
  'blank-page': blankPage,
};

/** sparse 族；`null` = 这个 kind 不属本族。 */
export function buildTemperaSparseComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec | null {
  const builder = SPARSE_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed);
}

/* ------------------------------------------------------------------ *
 * cinema 族（folia: compositions/temperaCinemaCompositions.ts）
 *
 * 电影遮片：一整块实色，中间**按画幅开一个洞**。洞是留给歌词的，
 * 于是周围的色调读起来是"遮片"而不是"色块"，反色滤镜也因此有一条硬边可以切字。
 *
 * 两个照抄的做法：
 * ① 洞用**四根条**拼出来，而不是"带洞的形状" —— 条是凸的，网线裁剪器才吃得下，而且每根条能各自入场；
 * ② 窗口尺寸用**真实像素**算（`fitWindow`），不用视口比例 —— 否则"正方形"窗口在不同屏幕上不是正方形。
 * ------------------------------------------------------------------ */

export interface TemperaWindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 在画面里放一个给定画幅的窗口（folia: `fitWindow`，按真实像素保比例）。 */
export function fitTemperaWindow(
  width: number,
  height: number,
  aspect: number,
  fill: number,
): TemperaWindowRect {
  const maxWidth = width * fill;
  const maxHeight = height * fill;
  const windowWidth = Math.min(maxWidth, maxHeight * aspect);
  const windowHeight = windowWidth / aspect;
  return {
    x: (width - windowWidth) / 2,
    y: (height - windowHeight) / 2,
    width: windowWidth,
    height: windowHeight,
  };
}

/** 遮片的四根条 + 窗口内沿的一条细线（folia: `addMatte`）。 */
function matteBars(
  hole: TemperaWindowRect,
  viewport: TemperaViewport,
  bleed: number,
): RawPanel[] {
  const { width, height } = viewport;
  return [
    {
      polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, hole.y + bleed),
      tone: 3,
      enterDX: 0,
      enterDY: -height * 0.2,
      alpha: 0.96,
      span: 0.5,
      delay: 0,
    },
    {
      polygon: rectPolygon(
        -bleed,
        hole.y + hole.height,
        width + bleed * 2,
        height - hole.y - hole.height + bleed,
      ),
      tone: 3,
      enterDX: 0,
      enterDY: height * 0.2,
      alpha: 0.96,
      span: 0.5,
      delay: 0.04,
    },
    {
      polygon: rectPolygon(-bleed, hole.y, hole.x + bleed, hole.height),
      tone: 3,
      enterDX: -width * 0.2,
      enterDY: 0,
      alpha: 0.96,
      span: 0.5,
      delay: 0.08,
    },
    {
      polygon: rectPolygon(
        hole.x + hole.width,
        hole.y,
        width - hole.x - hole.width + bleed,
        hole.height,
      ),
      tone: 3,
      enterDX: width * 0.2,
      enterDY: 0,
      alpha: 0.96,
      span: 0.5,
      delay: 0.12,
    },
  ];
}

/** 窗口里先铺一层淡调 + 一片网线，免得洞就是一块光秃秃的地。 */
function windowWash(
  hole: TemperaWindowRect,
  seed: number,
  alpha: number,
): RawPanel {
  const polygon = rectPolygon(hole.x, hole.y, hole.width, hole.height);
  return {
    polygon,
    tone: 0,
    enterDX: 0,
    enterDY: 0,
    alpha,
    span: 0.55,
    hatch: { spec: buildHatchSpec(seed, 149, 1.5), tone: 3, alpha: 0.2, grow: true },
  };
}

/** 一个画幅的遮片（folia: `matte(aspect, fill, washAlpha)` 工厂）。 */
function cinemaMatte(
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
  aspect: number,
  fillBase: number,
): TemperaCompositionSpec {
  // 同样的画幅也要因为种子略有出入（folia: `jitteredFill`，±0.03）。
  const fill = fillBase + (temperaHash01(seed, 157, 163) - 0.5) * 0.06;
  const hole = fitTemperaWindow(viewport.width, viewport.height, aspect, fill);
  const bars = matteBars(hole, viewport, bleed);
  return {
    panels: packPanels([windowWash(hole, seed, 0.35), ...bars], -1),
    seams: [],
    strokes: [
      line(
        rectPolygon(hole.x, hole.y, hole.width, hole.height),
        INK_TONE,
        1.6,
        0.5,
        0.2,
        0,
        0,
        true,
      ),
      // 遮片上的定位刻线，对着窗口的角。
      line(
        [hole.x, hole.y - viewport.height * 0.05, hole.x, hole.y - viewport.height * 0.02],
        0,
        2,
        0.6,
        0.26,
      ),
      line(
        [
          hole.x + hole.width,
          hole.y + hole.height + viewport.height * 0.02,
          hole.x + hole.width,
          hole.y + hole.height + viewport.height * 0.05,
        ],
        0,
        2,
        0.6,
        0.26,
      ),
    ],
    fallback: false,
  };
}

/** 两个并排的窗口，歌词占左边宽的那个。 */
function cinemaTwin(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const inset = height * 0.16;
  const gutter = width * 0.04;
  const left: TemperaWindowRect = {
    x: width * 0.08,
    y: inset,
    width: width * 0.5,
    height: height - inset * 2,
  };
  const right: TemperaWindowRect = {
    x: left.x + left.width + gutter,
    y: inset + height * 0.1,
    width: width * 0.28,
    height: height - inset * 2 - height * 0.2,
  };
  const panels: RawPanel[] = [
    {
      polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
      tone: 3,
      enterDX: 0,
      enterDY: 0,
      alpha: 0.96,
      span: 0.5,
    },
  ];
  const holes: readonly TemperaWindowRect[] = [left, right];
  holes.forEach((hole, index) => {
    panels.push({
      polygon: rectPolygon(hole.x, hole.y, hole.width, hole.height),
      tone: 0,
      enterDX: (index === 0 ? -1 : 1) * width * 0.14,
      enterDY: 0,
      alpha: index === 0 ? 0.4 : 0.85,
      span: 0.55,
      delay: index * 0.08,
    });
  });
  panels.push({
    polygon: rectPolygon(right.x, right.y, right.width, right.height),
    tone: 0,
    enterDX: 0,
    enterDY: 0,
    alpha: 0,
    span: 0.6,
    delay: 0.24,
    hatch: { spec: buildHatchSpec(151, 1), tone: 3, alpha: 0.35, grow: true },
  });
  return {
    panels: packPanels(panels, -1),
    seams: [],
    strokes: holes.map((hole, index) =>
      line(
        rectPolygon(hole.x, hole.y, hole.width, hole.height),
        INK_TONE,
        1.6,
        0.5,
        0.16 + index * 0.05,
        0,
        0,
        true,
      ),
    ),
    fallback: false,
  };
}

const CINEMA_ASPECTS: readonly (readonly [TemperaShotKind, number, number])[] = [
  ['cinema-scope', 2.39, 0.88],
  ['cinema-wide', 1.85, 0.84],
  ['cinema-academy', 1.33, 0.78],
  ['cinema-square', 1, 0.72],
  ['cinema-portrait', 0.75, 0.72],
  ['cinema-tall', 0.5625, 0.72],
];

/** cinema 族；`null` = 这个 kind 不属本族。 */
export function buildTemperaCinemaComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec | null {
  if (kind === 'cinema-twin') return cinemaTwin(seed, viewport, bleed);
  const entry = CINEMA_ASPECTS.find(([candidate]) => candidate === kind);
  if (entry === undefined) return null;
  return cinemaMatte(seed, viewport, bleed, entry[1], entry[2]);
}

/* ------------------------------------------------------------------ *
 * charm 族（folia: compositions/temperaCharmCompositions.ts）
 *
 * 圆润家族，照的是"视觉小说宣传 PV"的运动设计：泡泡、花边、心、星芒、贴纸板。
 * 别的族都用直边把画面切开，这一族是把**曲线形状放在一片平地上** ——
 * 于是字句读起来像印在贴纸上，而不是骑在面板接缝上。
 *
 * 两条把它拴在凝彩整体风格上的规矩（folia 原文强调）：**描边必须留着**（没有描边的软形状
 * 会溶进底色，反色滤镜就没有边可切），以及**这里什么都不跟音频脉动**。
 * ------------------------------------------------------------------ */

/** 每一张都从一片平地开始，曲线形状叠在上面（folia: `addField`）。 */
function field(tone: number, viewport: TemperaViewport, bleed: number, alpha = 0.92): RawPanel {
  return {
    polygon: rectPolygon(-bleed, -bleed, viewport.width + bleed * 2, viewport.height + bleed * 2),
    tone,
    enterDX: 0,
    enterDY: 0,
    alpha,
    span: 0.5,
  };
}

/** 一组圆 → 面板（渲染层复用面板机制画圆）。 */
function discPanels(
  discs: readonly TemperaDisc[],
  tone: number,
  alpha: number,
  delay: number,
  enterDY = 0,
  enterDX = 0,
): RawPanel[] {
  return discPolygons(discs).map((polygon, index) => ({
    polygon,
    tone,
    enterDX,
    enterDY,
    alpha,
    span: 0.6,
    delay: delay + index * 0.01,
  }));
}

/** 一组圆 → 闭合描边（圆环）。 */
function ringStrokes(
  discs: readonly TemperaDisc[],
  tone: number,
  width: number,
  alpha: number,
  delay: number,
  enterDY = 0,
): TemperaStrokeSpec[] {
  return discPolygons(discs).map((polygon, index) =>
    line(polygon, tone, width, alpha, delay + index * 0.01, 0, enterDY, true),
  );
}

/** 泡泡往上漂过字句：大小两级，大的承调子、小的漂在上面。 */
function bubbleDrift(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const big = buildDiscField(seed, 11, width, height, 8, unit * 0.115);
  const small = buildDiscField(seed, 17, width, height, 13, unit * 0.042);
  const highlights = big.slice(0, 2).map((disc) => ({
    x: disc.x - disc.radius * 0.36,
    y: disc.y - disc.radius * 0.36,
    radius: disc.radius * 0.16,
  }));
  return {
    panels: packPanels(
      [
        field(0, viewport, bleed),
        ...discPanels(big, 2, 0.88, 0.05, height * 0.16),
        ...discPanels(small, 3, 0.7, 0.18, height * 0.22),
        ...discPanels(highlights, 0, 0.85, 0.28),
      ],
      -1,
    ),
    seams: [],
    strokes: ringStrokes(big, INK_TONE, 2, 0.55, 0.12, height * 0.12),
    fallback: false,
  };
}

/** 多瓣圆牌：宣传 PV 往里面丢一句旁白的那种云朵框。 */
function cloudWindow(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const cx = width / 2;
  const cy = height * 0.52;
  const rx = width * 0.3;
  const ry = height * 0.3;
  const cloud = lobedPolygon(cx, cy, rx, ry, 9, 0.1);
  const tail: TemperaDisc[] = [
    { x: cx - rx * 1.16, y: cy + ry * 0.66, radius: unit * 0.035 },
    { x: cx - rx * 1.32, y: cy + ry * 0.9, radius: unit * 0.02 },
  ];
  return {
    panels: packPanels(
      [
        field(2, viewport, bleed),
        {
          polygon: lobedPolygon(cx, cy + height * 0.025, rx * 1.05, ry * 1.05, 9, 0.1),
          tone: 3,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.5,
          span: 0.6,
          delay: 0.04,
        },
        {
          polygon: cloud,
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.96,
          span: 0.55,
          delay: 0.08,
        },
        ...discPanels(tail, 0, 0.92, 0.22),
      ],
      -1,
    ),
    seams: [],
    strokes: [line(cloud, INK_TONE, 2.4, 0.85, 0.12, 0, 0, true)],
    fallback: false,
  };
}

/** 三个尺寸的心往外走，最大的那个驮着字。 */
function heartBurst(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const lean = temperaHash01(seed, 3, 83) > 0.5 ? 1 : -1;
  const cx = width * 0.5;
  const cy = height * 0.52;
  const rx = width * 0.32;
  const ry = height * 0.4;
  const main = rotatePolygon(heartPolygon(cx, cy, rx, ry), cx, cy, lean * 0.06);
  const offset = rotatePolygon(
    heartPolygon(cx + lean * width * 0.022, cy + height * 0.025, rx, ry),
    cx,
    cy,
    lean * 0.06,
  );
  const panels: RawPanel[] = [
    field(3, viewport, bleed, 0.94),
    { polygon: offset, tone: 1, enterDX: 0, enterDY: 0, alpha: 0.6, span: 0.6, delay: 0.04 },
    { polygon: main, tone: 0, enterDX: 0, enterDY: height * 0.1, alpha: 0.95, span: 0.55, delay: 0.08 },
  ];
  [0.4, 0.24].forEach((scale, index) => {
    const x = lean > 0 ? width * (0.88 + index * 0.08) : width * (0.12 - index * 0.08);
    const y = height * (0.24 + index * 0.42);
    panels.push({
      polygon: rotatePolygon(
        heartPolygon(x, y, rx * scale, ry * scale),
        x,
        y,
        -lean * 0.22,
      ),
      tone: 1,
      enterDX: lean * width * 0.12,
      enterDY: 0,
      alpha: 0.9,
      span: 0.5,
      delay: 0.2 + index * 0.06,
    });
  });
  return {
    panels: packPanels(panels, -1),
    seams: [],
    strokes: [
      line(main, INK_TONE, 3, 0.9, 0.14, 0, height * 0.08, true),
      ...ringStrokes([{ x: cx + lean * width * 0.022, y: cy + height * 0.025, radius: rx * 0.4 }], INK_TONE, 2, 0.6, 0.22),
    ],
    fallback: false,
  };
}

/** 闪闪：几乎空白的底上撒两档四角星芒。 */
function sparkleField(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const seeds = buildDiscField(seed, 23, width, height, 9, unit * 0.07);
  const stars: RawPanel[] = seeds.slice(0, 5).map((disc, index) => ({
    // 腰要细，四角星才读成"一闪"，而不是一个十字。
    polygon: starPolygon(disc.x, disc.y, disc.radius, disc.radius * 0.16, 4, temperaHash01(seed, index, 29) * 0.9),
    tone: 3,
    enterDX: 0,
    enterDY: 0,
    alpha: 0.9,
    span: 0.5,
    delay: 0.06 + index * 0.05,
  }));
  return {
    panels: packPanels(
      [
        field(0, viewport, bleed, 0.88),
        ...stars,
        ...discPanels(
          seeds.slice(5).map((disc) => ({ ...disc, radius: disc.radius * 0.22 })),
          3,
          0.7,
          0.24,
        ),
      ],
      -1,
    ),
    seams: [],
    strokes: [
      line([width * 0.08, height * 0.74, width * 0.92, height * 0.72], 3, 1.2, 0.5, 0.3, -width * 0.12),
    ],
    fallback: false,
  };
}

/** 花瓣从一个画外的毂上扇出来，外加它们来的那朵花蕊。 */
function petalArc(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const fromLeft = temperaHash01(seed, 5, 89) > 0.5;
  const hubX = fromLeft ? -width * 0.1 : width * 1.1;
  const hubY = height * 0.12;
  const rx = width * 0.26;
  const ry = height * 0.085;
  const panels: RawPanel[] = [field(1, viewport, bleed)];
  const strokes: TemperaStrokeSpec[] = [];
  for (let index = 0; index < 5; index += 1) {
    const base = ellipsePolygon(hubX + (fromLeft ? rx : -rx), hubY, rx, ry, 28);
    const petal = rotatePolygon(base, hubX, hubY, (fromLeft ? 1 : -1) * (0.18 + index * 0.3));
    panels.push({
      polygon: petal,
      tone: index % 2 === 0 ? 2 : 0,
      enterDX: 0,
      enterDY: -height * 0.1,
      alpha: 0.9,
      span: 0.55,
      delay: index * 0.05,
    });
    strokes.push(line(petal, INK_TONE, 1.6, 0.5, 0.06 + index * 0.05, 0, 0, true));
  }
  panels.push({
    polygon: lobedPolygon(hubX, hubY, width * 0.11, width * 0.11, 6, 0.34),
    tone: 3,
    enterDX: 0,
    enterDY: 0,
    alpha: 0.9,
    span: 0.5,
    delay: 0.28,
  });
  panels.push(
    ...discPanels(
      [0, 1, 2].map((index) => ({
        x: fromLeft ? width * (0.78 + index * 0.07) : width * (0.22 - index * 0.07),
        y: height * (0.7 + index * 0.1),
        radius: height * (0.03 - index * 0.006),
      })),
      3,
      0.75,
      0.32,
    ),
  );
  return { panels: packPanels(panels, -1), seams: [], strokes, fallback: false };
}

/** 两条花边从上下收进来，歌词坐在中间那条亮缝里。 */
function scallopBand(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  // 扇贝边带收的是**两条 y**：平边 `flatY` 与凸起基线 `baseY`，方向由它俩谁高谁低决定。
  const topFlat = -bleed;
  const topBase = -bleed + height * 0.28;
  const bottomFlat = height + bleed;
  const bottomBase = height + bleed - height * 0.72;
  const top = scallopBandPolygon(-bleed, width + bleed, topFlat, topBase, 9);
  const bottom = scallopBandPolygon(-bleed, width + bleed, bottomFlat, bottomBase, 9);
  // 珠子钉在两个凸起相交的尖上，才读成"缝在花边上"而不是"撒在上面" —— 所以按凸起间距排。
  const pitch = (width + bleed * 2) / 9;
  const beads: TemperaDisc[] = Array.from({ length: 5 }, (_unused, index) => ({
    x: -bleed + pitch * (index + 2),
    y: topBase,
    radius: Math.min(width, height) * 0.018,
  }));
  return {
    panels: packPanels(
      [
        field(0, viewport, bleed, 0.9),
        {
          polygon: top,
          tone: 2,
          enterDX: 0,
          enterDY: -height * 0.18,
          alpha: 0.92,
          span: 0.55,
          delay: 0.04,
        },
        {
          polygon: bottom,
          tone: 3,
          enterDX: 0,
          enterDY: height * 0.18,
          alpha: 0.92,
          span: 0.55,
          delay: 0.1,
        },
        ...discPanels(beads, INK_TONE, 0.7, 0.26),
      ],
      -1,
    ),
    seams: [],
    strokes: [
      line(top, INK_TONE, 2, 0.75, 0.14, 0, -height * 0.12, true),
      line(bottom, INK_TONE, 2, 0.75, 0.18, 0, height * 0.12, true),
    ],
    fallback: false,
  };
}

/** 一条横贯画面的丝带，上面钉一个蝴蝶结 —— 宣传片的字幕条。 */
function ribbonLoop(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const sag =
    height *
    (0.06 + temperaHash01(seed, 7, 97) * 0.05) *
    (temperaHash01(seed, 9, 97) > 0.5 ? 1 : -1);
  const band = arcRibbonPolygon(-bleed, width + bleed, height * 0.5, height * 0.3, sag);
  const echo = arcRibbonPolygon(-bleed, width + bleed, height * 0.68, height * 0.06, -sag);
  const knotX = width * (temperaHash01(seed, 11, 97) > 0.5 ? 0.24 : 0.76);
  const knotY =
    height * 0.5 + Math.sin(((knotX + bleed) / (width + bleed * 2)) * Math.PI) * sag;
  const panels: RawPanel[] = [
    field(1, viewport, bleed),
    { polygon: echo, tone: 3, enterDX: -width * 0.16, enterDY: 0, alpha: 0.7, span: 0.6, delay: 0.04 },
    { polygon: band, tone: 0, enterDX: width * 0.18, enterDY: 0, alpha: 0.95, span: 0.55, delay: 0.08 },
  ];
  const strokes: TemperaStrokeSpec[] = [
    line(band, INK_TONE, 2.6, 0.85, 0.14, width * 0.14, 0, true),
  ];
  ([-1, 1] as const).forEach((side, index) => {
    const loop = rotatePolygon(
      ellipsePolygon(knotX + side * width * 0.055, knotY, width * 0.05, height * 0.07, 26),
      knotX,
      knotY,
      side * 0.3,
    );
    panels.push({
      polygon: loop,
      tone: 3,
      enterDX: side * width * 0.06,
      enterDY: 0,
      alpha: 0.92,
      span: 0.5,
      delay: 0.2 + index * 0.04,
    });
    strokes.push(line(loop, INK_TONE, 2, 0.8, 0.24 + index * 0.04, 0, 0, true));
  });
  const knot = roundedRectPolygon(
    knotX - width * 0.018,
    knotY - height * 0.035,
    width * 0.036,
    height * 0.07,
    height * 0.02,
  );
  panels.push({ polygon: knot, tone: 3, enterDX: 0, enterDY: 0, alpha: 0.95, span: 0.5, delay: 0.28 });
  strokes.push(line(knot, INK_TONE, 2, 0.85, 0.3, 0, 0, true));
  return { panels: packPanels(panels, -1), seams: [], strokes, fallback: false };
}

/** 贴纸板：圆角面板、双线内框、四个铆钉。这一族里最安静的一张。 */
function roundPlate(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const plate = roundedRectPolygon(width * 0.16, height * 0.24, width * 0.68, height * 0.52, unit * 0.11);
  const inner = roundedRectPolygon(width * 0.19, height * 0.29, width * 0.62, height * 0.42, unit * 0.08);
  const pins: TemperaDisc[] = [
    { x: width * 0.22, y: height * 0.3, radius: unit * 0.016 },
    { x: width * 0.78, y: height * 0.3, radius: unit * 0.016 },
    { x: width * 0.22, y: height * 0.7, radius: unit * 0.016 },
    { x: width * 0.78, y: height * 0.7, radius: unit * 0.016 },
  ];
  return {
    panels: packPanels(
      [
        field(2, viewport, bleed),
        {
          polygon: plate,
          tone: 0,
          enterDX: 0,
          enterDY: height * 0.06,
          alpha: 0.95,
          span: 0.55,
          delay: 0.05,
        },
        {
          // 圆角矩形是凸的，网线裁剪器能直接填它（多瓣的牌子就只能不上网线）。
          polygon: inner,
          tone: 0,
          enterDX: 0,
          enterDY: 0,
          alpha: 0,
          span: 0.6,
          delay: 0.1,
          hatch: { spec: buildHatchSpec(seed, 101, 1.3), tone: 1, alpha: 0.35, grow: true },
        },
        ...discPanels(pins, INK_TONE, 0.75, 0.22),
      ],
      -1,
    ),
    seams: [],
    strokes: [
      line(plate, INK_TONE, 3, 0.9, 0.12, 0, 0, true),
      line(inner, 3, 1.2, 0.55, 0.16, 0, 0, true),
    ],
    fallback: false,
  };
}

/** 一圈柔光：从偏心毂上射出宽楔形，再叠圆盘与圆环。 */
function haloBurst(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const cx = width * (0.44 + temperaHash01(seed, 13, 103) * 0.12);
  const cy = height * 0.5;
  const reach = Math.hypot(width, height) * 0.7;
  const wedges = 14;
  const panels: RawPanel[] = [field(0, viewport, bleed)];
  // 隔一个画一个：留出的空隙才让这一圈读成柔光，而不是晕。
  for (let index = 0; index < wedges; index += 2) {
    const angle = (index / wedges) * Math.PI * 2 + temperaHash01(seed, index, 107) * 0.09;
    const spread = 0.11;
    panels.push({
      polygon: [
        cx,
        cy,
        cx + Math.cos(angle - spread) * reach,
        cy + Math.sin(angle - spread) * reach,
        cx + Math.cos(angle + spread) * reach,
        cy + Math.sin(angle + spread) * reach,
      ],
      tone: 2,
      enterDX: 0,
      enterDY: 0,
      alpha: 0.55,
      span: 0.6,
      delay: 0.04 + index * 0.012,
    });
  }
  panels.push({
    polygon: ellipsePolygon(cx, cy, unit * 0.34, unit * 0.34, 48),
    tone: 0,
    enterDX: 0,
    enterDY: 0,
    alpha: 0.94,
    span: 0.55,
    delay: 0.14,
  });
  const rings: readonly (readonly [number, number])[] = [
    [0.34, 3],
    [0.44, 1.4],
  ];
  return {
    panels: packPanels(panels, -1),
    seams: [],
    strokes: rings.map(([scale, width2], index) =>
      line(
        ellipsePolygon(cx, cy, unit * scale, unit * scale, 48),
        INK_TONE,
        width2,
        0.75,
        0.2 + index * 0.06,
        0,
        0,
        true,
      ),
    ),
    fallback: false,
  };
}

const CHARM_BUILDERS: Partial<
  Record<TemperaShotKind, (seed: number, viewport: TemperaViewport, bleed: number) => TemperaCompositionSpec>
> = {
  'bubble-drift': bubbleDrift,
  'cloud-window': cloudWindow,
  'heart-burst': heartBurst,
  'sparkle-field': sparkleField,
  'petal-arc': petalArc,
  'scallop-band': scallopBand,
  'ribbon-loop': ribbonLoop,
  'round-plate': roundPlate,
  'halo-burst': haloBurst,
};

/** charm 族；`null` = 这个 kind 不属本族。 */
export function buildTemperaCharmComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec | null {
  const builder = CHARM_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed);
}

/* ------------------------------------------------------------------ *
 * aperture 族（folia: compositions/temperaApertureCompositions.ts）
 *
 * 冲孔板：一整片平色板，中间**干净地开一个洞**，让外壳的活动背景成为这个镜头的主体。
 * 洞的形状就是整个构图 —— 所以这一族几乎不带别的几何：一块装饰过的板会跟自己的窗口抢戏。
 *
 * 两个照抄的做法：
 * ① 洞用 `Graphics.cut()` 从填充里**减掉**，不是"在洞上再盖一块"（folia 的注释专门讲过：
 *    靠盖一块来假装洞，改一次绘制顺序就会露馅）；孔的内沿单独描一条线（`addHoleLip`）。
 * ② 洞的位置各族**写死**、不按种子镜像 —— 因为"必须避开的排版区域"也是写死的数据。
 * ------------------------------------------------------------------ */

/** 一整片板 + 要挖掉的孔（folia: `addCutField`）。 */
function cutField(
  tone: number,
  viewport: TemperaViewport,
  bleed: number,
  holes: readonly (readonly number[])[],
  alpha = 0.94,
): RawPanel {
  return {
    polygon: rectPolygon(-bleed, -bleed, viewport.width + bleed * 2, viewport.height + bleed * 2),
    tone,
    enterDX: 0,
    enterDY: 0,
    alpha,
    span: 0.5,
    holes,
  };
}

/** 孔的内沿描边（folia: `addHoleLip`）—— 有了它洞才像"切出来的"而不是"没画到"。 */
function holeLip(
  hole: readonly number[],
  width: number,
  alpha: number,
  delay: number,
): TemperaStrokeSpec {
  return line(hole, INK_TONE, width, alpha, delay, 0, 0, true);
}

/** 偏心圆孔 + 一条从画面外推进来的横梁，洞因此读成"装上去的"。 */
function irisHole(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const cx = width * 0.68;
  const cy = height * 0.42;
  const radius = unit * 0.3;
  const hole = circlePolygon(cx, cy, radius, 56);
  return {
    panels: packPanels(
      [
        cutField(2, viewport, bleed, [hole]),
        {
          polygon: rectPolygon(-bleed, cy - unit * 0.035, cx - radius * 0.7 + bleed, unit * 0.07),
          tone: 3,
          enterDX: -width * 0.12,
          enterDY: 0,
          alpha: 0.9,
          span: 0.55,
          delay: 0.14,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      holeLip(hole, 3, 0.9, 0.08),
      line(
        circlePolygon(cx, cy, radius * 1.14, 48),
        3,
        1.4,
        0.6,
        0.2,
        0,
        0,
        true,
      ),
    ],
    fallback: false,
  };
}

/** 一条横贯的狭缝：上下两块厚料承着字句，洞因此读成"地平线"而不是窗。 */
function slotRail(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const top = height * 0.22;
  const slot = rectPolygon(-bleed, top, width + bleed * 2, height * 0.16);
  return {
    panels: packPanels(
      [
        cutField(3, viewport, bleed, [slot]),
        {
          polygon: rectPolygon(width * 0.66, top - height * 0.06, width * 0.12, height * 0.28),
          tone: 1,
          enterDX: 0,
          enterDY: -height * 0.1,
          alpha: 0.95,
          span: 0.55,
          delay: 0.16,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      holeLip(slot, 2.4, 0.8, 0.1),
      line([-bleed, top + height * 0.22, width + bleed, top + height * 0.22], 1, 1.4, 0.55, 0.22, width * 0.14),
    ],
    fallback: false,
  };
}

/** 两侧各一排齿孔：夹在中间的那片才是画面。 */
function punchRow(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const radius = unit * 0.028;
  const holes: number[][] = [];
  for (let index = 0; index < 9; index += 1) {
    const x = width * (0.08 + index * 0.105);
    holes.push(circlePolygon(x, height * 0.14, radius, 20));
    holes.push(circlePolygon(x, height * 0.86, radius, 20));
  }
  return {
    panels: packPanels([cutField(2, viewport, bleed, holes)], -1),
    seams: [],
    strokes: ([0.22, 0.78] as const).map((y, index) =>
      line(
        [0, height * y, width, height * y],
        3,
        1.6,
        0.6,
        0.12 + index * 0.04,
        (index === 0 ? 1 : -1) * width * 0.12,
      ),
    ),
    fallback: false,
  };
}

/** 片门：中间那个大矩形是曝光框，两侧小孔是拉片孔。 */
function filmGate(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const gate = rectPolygon(width * 0.2, height * 0.1, width * 0.6, height * 0.52);
  const holes: number[][] = [gate];
  for (let index = 0; index < 4; index += 1) {
    const y = height * (0.14 + index * 0.13);
    holes.push(rectPolygon(width * 0.08, y, width * 0.05, height * 0.06));
    holes.push(rectPolygon(width * 0.87, y, width * 0.05, height * 0.06));
  }
  return {
    panels: packPanels(
      [
        cutField(3, viewport, bleed, holes),
        {
          polygon: rectPolygon(width * 0.2, height * 0.68, width * 0.6, height * 0.1),
          tone: 3,
          enterDX: 0,
          enterDY: 0,
          alpha: 0,
          span: 0.6,
          delay: 0.18,
          hatch: { spec: buildHatchSpec(seed, 131, 1.2), tone: 1, alpha: 0.5, grow: true },
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [holeLip(gate, 3, 0.9, 0.08)],
    fallback: false,
  };
}

/** 一个十字孔，开得偏高，下半块厚料全留给字句。 */
function crossVent(_seed: number, viewport: TemperaViewport, _bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const cx = width * 0.5;
  const cy = height * 0.38;
  const arm = unit * 0.3;
  const bar = unit * 0.1;
  const cross = [
    cx - bar, cy - arm, cx + bar, cy - arm, cx + bar, cy - bar,
    cx + arm, cy - bar, cx + arm, cy + bar, cx + bar, cy + bar,
    cx + bar, cy + arm, cx - bar, cy + arm, cx - bar, cy + bar,
    cx - arm, cy + bar, cx - arm, cy - bar, cx - bar, cy - bar,
  ];
  return {
    panels: packPanels([cutField(2, viewport, _bleed, [cross])], -1),
    seams: [],
    strokes: [
      holeLip(cross, 2.6, 0.85, 0.1),
      line(circlePolygon(cx, cy, arm * 1.24, 48), 3, 1.2, 0.5, 0.2, 0, 0, true),
    ],
    fallback: false,
  };
}

/** 百叶：一排斜缝，越往下越薄。 */
function louvre(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const holes: number[][] = [];
  for (let index = 0; index < 6; index += 1) {
    const y = height * (0.08 + index * 0.1);
    const lean = height * 0.03;
    const thickness = height * (0.05 - index * 0.004);
    holes.push([
      -bleed, y, width + bleed, y - lean,
      width + bleed, y - lean + thickness, -bleed, y + thickness,
    ]);
  }
  return {
    panels: packPanels(
      [
        cutField(3, viewport, bleed, holes),
        {
          polygon: rectPolygon(width * 0.1, height * 0.72, width * 0.08, height * 0.2),
          tone: 1,
          enterDX: 0,
          enterDY: height * 0.1,
          alpha: 0.9,
          span: 0.55,
          delay: 0.2,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [],
    fallback: false,
  };
}

/** 玫瑰窗：环被切成十二段打掉，段间的辐条与环内的轮毂仍归板所有。 */
function ringEye(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const cx = width * 0.5;
  const cy = height * 0.5;
  const inner = unit * 0.31;
  const outer = unit * 0.44;
  const segments = 12;
  const gap = 0.03;
  const holes = Array.from({ length: segments }, (_unused, index) => {
    const start = (index / segments) * Math.PI * 2 + gap;
    const end = ((index + 1) / segments) * Math.PI * 2 - gap;
    return annularSectorPolygon(cx, cy, inner, outer, start, end, 8);
  });
  return {
    panels: packPanels([cutField(2, viewport, bleed, holes)], -1),
    seams: [],
    strokes: [
      // 内外两个环：它们就是板被留住的那两圈。
      line(circlePolygon(cx, cy, inner, 72), INK_TONE, 2.4, 0.85, 0.12, 0, 0, true),
      line(circlePolygon(cx, cy, outer, 72), INK_TONE, 2.4, 0.85, 0.12, 0, 0, true),
    ],
    fallback: false,
  };
}

/** 一侧往下递减的方孔。 */
function notchStack(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const holes: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const size = unit * (0.26 - index * 0.05);
    holes.push(rectPolygon(width * (0.6 + index * 0.06), height * (0.1 + index * 0.19), size, size));
  }
  return {
    panels: packPanels([cutField(3, viewport, bleed, holes)], -1),
    seams: [],
    strokes: holes.map((hole, index) => holeLip(hole, 2, 0.75, 0.1 + index * 0.04)),
    fallback: false,
  };
}

/** 从顶边楔进来的一道口子；下半块厚料完整留给字句。 */
function wedgeGap(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const apexX = width * (0.4 + temperaHash01(seed, 3, 137) * 0.2);
  const wedge = [width * 0.1, -bleed, width * 0.92, -bleed, apexX, height * 0.56];
  return {
    panels: packPanels([cutField(2, viewport, bleed, [wedge])], -1),
    seams: [],
    strokes: [
      holeLip(wedge, 3, 0.9, 0.08),
      line([apexX, height * 0.58, apexX, height + bleed], 3, 1.6, 0.6, 0.18, 0, height * 0.12),
    ],
    fallback: false,
  };
}

/** 筛子：小孔朝一边变稀，背景因此像一片渐暗的光透进来。 */
function dotSieve(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const holes: number[][] = [];
  for (let row = 0; row < 6; row += 1) {
    // 五列而不是九列：衰减必须在排版区之前就归零，否则最后几颗会直接打在字句那半边。
    for (let column = 0; column < 5; column += 1) {
      const density = 1 - column / 4.5;
      if (temperaHash01(seed, row * 9 + column, 139) > density) continue;
      const x = width * (0.06 + column * 0.105) + (row % 2 === 0 ? 0 : width * 0.05);
      holes.push(circlePolygon(x, height * (0.1 + row * 0.16), unit * 0.045 * density + unit * 0.012, 18));
    }
  }
  return { panels: packPanels([cutField(1, viewport, bleed, holes, 0.92)], -1), seams: [], strokes: [], fallback: false };
}

const APERTURE_BUILDERS: Partial<
  Record<TemperaShotKind, (seed: number, viewport: TemperaViewport, bleed: number) => TemperaCompositionSpec>
> = {
  'iris-hole': irisHole,
  'slot-rail': slotRail,
  'punch-row': punchRow,
  'film-gate': filmGate,
  'cross-vent': crossVent,
  'louvre-slats': louvre,
  'ring-eye': ringEye,
  'notch-stack': notchStack,
  'wedge-gap': wedgeGap,
  'dot-sieve': dotSieve,
};

/** aperture 族；`null` = 这个 kind 不属本族。 */
export function buildTemperaApertureComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec | null {
  const builder = APERTURE_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed);
}

/* ------------------------------------------------------------------ *
 * signal 族（folia: compositions/temperaSignalCompositions.ts）
 *
 * 仪表盘：细线、刻度、括号、重复的板条 —— 全是**刻意量过**而不是"有表现力"的装饰，
 * 读起来像一张印出来的图。整幅画面里只允许那一块重物是响的，字句跟它共处一帧。
 *
 * 有几种族的洞是**打在那块重物上**而不是打在底板上（洞跟着形状走，不留在它背后）；
 * `axis-caps` 尤其讲究：它把孔**同时**从底板和长条上切掉 —— 只切长条的话，
 * 透过孔看到的是底板而不是背景，**洞只有背后什么都空着才算窗**。
 * ------------------------------------------------------------------ */

/** 以 `(cx, cy)` 为中心的矩形，沿 `angle` 长 `length`、宽 `width`（folia: `axisRect`）。 */
function axisRect(
  cx: number,
  cy: number,
  length: number,
  width: number,
  angle: number,
): number[] {
  return rotatePolygon(rectPolygon(cx - length / 2, cy - width / 2, length, width), cx, cy, angle);
}

/** 形状要在任意流向角下都跑出画面两头，需要多长（folia: `flowSpan`）。 */
function flowSpan(viewport: TemperaViewport): number {
  return Math.hypot(viewport.width, viewport.height) * 1.6;
}

/** 一组独立线段 → 一组描边（`drawLines` 的等价物）。 */
function lineBatch(
  lines: readonly (readonly [number, number, number, number])[],
  tone: number,
  width: number,
  alpha: number,
  delay: number,
  enterDX = 0,
  enterDY = 0,
): TemperaStrokeSpec[] {
  return lines.map(([x1, y1, x2, y2], index) =>
    line([x1, y1, x2, y2], tone, width, alpha, delay + index * 0.01, enterDX, enterDY),
  );
}

/** 准星：满幅十字、一个方框、四角刻度；交叉点下面那块实心就是字句站的地方。 */
function sightMark(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const cx = width * 0.5;
  const cy = height * 0.5;
  const corners: readonly (readonly [number, number, number, number])[] = [
    [0.2, 0.32, 1, 1],
    [0.8, 0.32, -1, 1],
    [0.2, 0.68, 1, -1],
    [0.8, 0.68, -1, -1],
  ];
  return {
    panels: packPanels(
      [
        field(0, viewport, bleed),
        {
          polygon: rectPolygon(width * 0.24, height * 0.36, width * 0.52, height * 0.28),
          tone: 2,
          enterDX: 0,
          enterDY: height * 0.06,
          alpha: 0.94,
          span: 0.55,
          delay: 0.1,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      ...lineBatch(
        [
          [-bleed, cy, width + bleed, cy],
          [cx, -bleed, cx, height + bleed],
        ],
        3,
        1.4,
        0.6,
        0.04,
        width * 0.1,
      ),
      line(
        rectPolygon(width * 0.2, height * 0.32, width * 0.6, height * 0.36),
        INK_TONE,
        2.4,
        0.85,
        0.16,
        0,
        0,
        true,
      ),
      ...corners.flatMap(([fx, fy, sx, sy], index) => {
        const x = width * fx;
        const y = height * fy;
        return lineBatch(
          [
            [x, y, x + sx * width * 0.04, y],
            [x, y, x, y + sy * height * 0.05],
          ],
          INK_TONE,
          3,
          0.8,
          0.2 + index * 0.03,
        );
      }),
    ],
    fallback: false,
  };
}

/** 表盘：实心环、一圈刻度、一根粗指针；轮毂留实心给字句。 */
function dialScale(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const cx = width * 0.5;
  const cy = height * 0.5;
  const ticks = Array.from({ length: 24 }, (_unused, index) => {
    const angle = (index / 24) * Math.PI * 2;
    const inner = unit * (index % 6 === 0 ? 0.46 : 0.475);
    return [
      cx + Math.cos(angle) * inner,
      cy + Math.sin(angle) * inner,
      cx + Math.cos(angle) * unit * 0.5,
      cy + Math.sin(angle) * unit * 0.5,
    ] as const;
  });
  const pointer = 0.4 + temperaHash01(seed, 5, 149) * 0.5;
  const pointerAngle = pointer * Math.PI * 2;
  return {
    panels: packPanels(
      [
        field(1, viewport, bleed),
        {
          // 这里是**画一个环**，不是"圆盘挖个洞"：轮毂要承字句，所以它得是不透明的实底，
          // 而不是一个"背后恰好有东西"的开口。
          polygon: annularSectorPolygon(cx, cy, unit * 0.34, unit * 0.44, 0, Math.PI * 2 - 0.006, 60),
          tone: 3,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.92,
          span: 0.6,
          delay: 0.05,
        },
        {
          polygon: axisRect(
            cx + Math.cos(pointerAngle) * unit * 0.2,
            cy + Math.sin(pointerAngle) * unit * 0.2,
            unit * 0.4,
            unit * 0.035,
            pointerAngle,
          ),
          tone: INK_TONE,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.9,
          span: 0.5,
          delay: 0.2,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: lineBatch(ticks, INK_TONE, 1.6, 0.7, 0.14),
    fallback: false,
  };
}

/** 雪佛龙一路重复往下，其中一根反相 —— 重复让交接无形，那一根例外才是眼睛落点。 */
function chevronRun(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const focus = 2;
  const panels: RawPanel[] = [field(0, viewport, bleed)];
  for (let index = 0; index < 5; index += 1) {
    const y = height * (0.02 + index * 0.24);
    const rise = height * 0.12;
    const thickness = height * 0.07;
    panels.push({
      polygon: [
        -bleed, y,
        width * 0.5, y - rise,
        width + bleed, y,
        width + bleed, y + thickness,
        width * 0.5, y - rise + thickness,
        -bleed, y + thickness,
      ],
      tone: index === focus ? 3 : 2,
      enterDX: 0,
      enterDY: -height * 0.12,
      alpha: index === focus ? 0.95 : 0.7,
      span: 0.55,
      delay: index * 0.04,
    });
  }
  return { panels: packPanels(panels, -1), seams: [], strokes: [], fallback: false };
}

/** 贴着一边的计数栏，那一根长记号是焦点。 */
function tallyColumn(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const x = width * 0.82;
  const marks = Array.from({ length: 11 }, (_unused, index) => {
    const long = index % 4 === 0;
    return [x, height * (0.1 + index * 0.075), x + width * (long ? 0.12 : 0.06), height * (0.1 + index * 0.075)] as const;
  });
  return {
    panels: packPanels(
      [
        field(0, viewport, bleed),
        {
          polygon: rectPolygon(x - width * 0.02, height * 0.4, width * 0.16, height * 0.12),
          tone: 3,
          enterDX: width * 0.14,
          enterDY: 0,
          alpha: 0.95,
          span: 0.55,
          delay: 0.16,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      ...lineBatch(marks, 3, 2.4, 0.75, 0.06, width * 0.1),
      line([x, height * 0.06, x, height * 0.92], INK_TONE, 1.6, 0.6, 0.2),
    ],
    fallback: false,
  };
}

/** 细线格：填一格、另外两格干净地打穿。 */
function gridFocus(_seed: number, viewport: TemperaViewport, _bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const left = width * 0.08;
  const top = height * 0.12;
  const cellWidth = (width * 0.84) / 4;
  const cellHeight = (height * 0.76) / 3;
  const cell = (column: number, row: number): number[] =>
    rectPolygon(left + cellWidth * column, top + cellHeight * row, cellWidth, cellHeight);
  const gridLines: (readonly [number, number, number, number])[] = [];
  for (let column = 0; column <= 4; column += 1) {
    gridLines.push([
      left + cellWidth * column,
      top,
      left + cellWidth * column,
      top + cellHeight * 3,
    ]);
  }
  for (let row = 0; row <= 3; row += 1) {
    gridLines.push([left, top + cellHeight * row, left + cellWidth * 4, top + cellHeight * row]);
  }
  return {
    panels: packPanels(
      [
        cutField(1, viewport, _bleed, [cell(0, 0), cell(3, 2)]),
        {
          polygon: cell(3, 0),
          tone: 3,
          enterDX: width * 0.08,
          enterDY: 0,
          alpha: 0.95,
          span: 0.55,
          delay: 0.08,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      holeLip(cell(0, 0), 2, 0.7, 0.1),
      holeLip(cell(3, 2), 2, 0.7, 0.14),
      ...lineBatch(gridLines, 3, 1.2, 0.6, 0.16),
    ],
    fallback: false,
  };
}

/** 一根贯穿画面的重轴，中间钻一个孔口，两头各一块端帽。孔跟着长条走，不留在它背后。 */
function axisCaps(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const cx = width * 0.5;
  const cy = height * 0.42;
  const port = circlePolygon(cx, cy, unit * 0.08, 32);
  const bar = axisRect(cx, cy, flowSpan(viewport), unit * 0.22, flowAngle);
  const panels: RawPanel[] = [
    cutField(0, viewport, bleed, [port], 0.92),
    {
      polygon: bar,
      tone: 3,
      enterDX: 0,
      enterDY: 0,
      alpha: 0.94,
      span: 0.6,
      delay: 0.05,
      // 孔**同时**从底板与长条上切掉：只切长条的话，透过孔看到的是底板而不是背景。
      holes: [port],
    },
  ];
  ([1, -1] as const).forEach((side, index) => {
    const distance = unit * 0.46;
    panels.push({
      polygon: axisRect(
        cx + Math.cos(flowAngle) * distance * side,
        cy + Math.sin(flowAngle) * distance * side,
        unit * 0.1,
        unit * 0.34,
        flowAngle,
      ),
      tone: INK_TONE,
      enterDX: 0,
      enterDY: 0,
      alpha: 0.85,
      span: 0.5,
      delay: 0.16 + index * 0.04,
    });
  });
  return {
    panels: packPanels(panels, -1),
    seams: [],
    strokes: [line(port, INK_TONE, 2.4, 0.85, 0.12, 0, 0, true)],
    fallback: false,
  };
}

/** 宽窄交替的板条；最宽的那根留给字句，所以用浅调，其余收拢在它两侧。 */
function strobeSlats(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const widths = [0.06, 0.03, 0.09, 0.04, 0.34, 0.04, 0.08, 0.03, 0.06];
  const panels: RawPanel[] = [field(0, viewport, bleed)];
  let cursor = width * 0.03;
  widths.forEach((fraction, index) => {
    const wide = fraction > 0.2;
    panels.push({
      polygon: rectPolygon(cursor, -bleed, width * fraction, height + bleed * 2),
      tone: wide ? 2 : 3,
      enterDX: 0,
      enterDY: (index % 2 === 0 ? 1 : -1) * height * 0.14,
      alpha: wide ? 0.9 : 0.85,
      span: 0.55,
      delay: index * 0.03,
    });
    cursor += width * (fraction + 0.02);
  });
  return { panels: packPanels(panels, -1), seams: [], strokes: [], fallback: false };
}

/** 三张同尺寸的板套印错位，最上面那张钻一个贯穿整叠的定位孔。 */
function offsetPlate(_seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const step = unit * 0.06;
  const hole = circlePolygon(width * 0.72, height * 0.36, unit * 0.05, 28);
  const panels: RawPanel[] = [cutField(0, viewport, bleed, [hole], 0.9)];
  ([1, 2, 3] as const).forEach((tone, index) => {
    panels.push({
      polygon: rectPolygon(
        width * 0.2 + step * index,
        height * 0.2 + step * index,
        width * 0.5,
        height * 0.5,
      ),
      tone,
      enterDX: -step * 2,
      enterDY: -step,
      alpha: index === 2 ? 0.95 : 0.8,
      span: 0.55,
      delay: index * 0.06,
      // 一钻贯三张：底板与每张板都在同一处被开同一个口，才真的透得过去。
      holes: [hole],
    });
  });
  return {
    panels: packPanels(panels, -1),
    seams: [],
    strokes: [line(hole, INK_TONE, 2, 0.8, 0.22, 0, 0, true)],
    fallback: false,
  };
}

/** 从画外轮毂射出的梳齿射线，外加一个实心扇区当重物。 */
function radialComb(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const hubX = width * 1.06;
  const hubY = height * 1.1;
  const reach = Math.hypot(width, height) * 1.3;
  const rays = Array.from({ length: 11 }, (_unused, index) => {
    const angle = Math.PI + 0.16 + index * 0.062;
    return [hubX, hubY, hubX + Math.cos(angle) * reach, hubY + Math.sin(angle) * reach] as const;
  });
  const start = Math.PI + 0.44;
  const end = Math.PI + 0.56;
  return {
    panels: packPanels(
      [
        field(1, viewport, bleed),
        {
          polygon: [
            hubX, hubY,
            hubX + Math.cos(start) * reach, hubY + Math.sin(start) * reach,
            hubX + Math.cos(end) * reach, hubY + Math.sin(end) * reach,
          ],
          tone: 3,
          enterDX: 0,
          enterDY: 0,
          alpha: 0.95,
          span: 0.6,
          delay: 0.14,
        },
        {
          polygon: rectPolygon(width * 0.06, height * 0.08, width * 0.2, height * 0.14),
          tone: 3,
          enterDX: 0,
          enterDY: 0,
          alpha: 0,
          span: 0.6,
          delay: 0.24,
          hatch: { spec: buildHatchSpec(seed, 151), tone: 3, alpha: 0.4, grow: true },
        },
      ],
      -1,
    ),
    seams: [],
    strokes: lineBatch(rays, 3, 2.6, 0.8, 0.06),
    fallback: false,
  };
}

/** 取景器：画面下部的开口围一圈括号，字句坐在上面的板上。 */
function bracketTarget(_seed: number, viewport: TemperaViewport, _bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const box = rectPolygon(width * 0.28, height * 0.54, width * 0.44, height * 0.34);
  const arm = Math.min(width, height) * 0.08;
  const corners: readonly (readonly [number, number, number, number])[] = [
    [0.28, 0.54, 1, 1],
    [0.72, 0.54, -1, 1],
    [0.28, 0.88, 1, -1],
    [0.72, 0.88, -1, -1],
  ];
  return {
    panels: packPanels([cutField(2, viewport, _bleed, [box])], -1),
    seams: [],
    strokes: [
      holeLip(box, 2.4, 0.85, 0.08),
      ...corners.flatMap(([fx, fy, sx, sy], index) => {
        const x = width * fx + sx * width * 0.03;
        const y = height * fy + sy * height * 0.04;
        return lineBatch(
          [
            [x, y, x + sx * arm, y],
            [x, y, x, y + sy * arm],
          ],
          INK_TONE,
          3.5,
          0.9,
          0.12 + index * 0.04,
          sx * width * 0.05,
        );
      }),
      line([width * 0.1, height * 0.44, width * 0.9, height * 0.44], 3, 1.6, 0.6, 0.24, -width * 0.1),
    ],
    fallback: false,
  };
}

const SIGNAL_BUILDERS: Partial<
  Record<
    TemperaShotKind,
    (
      seed: number,
      viewport: TemperaViewport,
      bleed: number,
      flowAngle: number,
    ) => TemperaCompositionSpec
  >
> = {
  'sight-mark': sightMark,
  'dial-scale': dialScale,
  'chevron-run': chevronRun,
  'tally-column': tallyColumn,
  'grid-focus': gridFocus,
  'axis-caps': axisCaps,
  'strobe-slats': strobeSlats,
  'offset-plate': offsetPlate,
  'radial-comb': radialComb,
  'bracket-target': bracketTarget,
};

/**
 * signal 族；`null` = 这个 kind 不属本族。
 *
 * signal 与 corridor 两族需要 `flowAngle`（前者的轴、后者的通道都要顺着流向），
 * 所以它们各自多收一个参数，由 `buildTemperaComposition` 从 shot 上取。
 */
export function buildTemperaSignalComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle = Math.PI / 2,
): TemperaCompositionSpec | null {
  const builder = SIGNAL_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed, flowAngle);
}

/* ------------------------------------------------------------------ *
 * corridor 族（folia: compositions/temperaCorridorCompositions.ts）
 *
 * **沿着镜头的行进方向**开的洞。这一族是专为"交接"造的：相邻镜头顺着流向互相滑过去，
 * 而一条与流向**平行**的通道在滑的过程中看上去还是同一条通道，两个镜头之间的接缝就不读成剪辑；
 * 背景也一直在移动的开口里连续可见，而不是随每一次切换忽隐忽现。
 *
 * 三个照抄的做法：
 * ① 两头都**锚在画面之外** —— 一条看得见尽头的通道是一个"形状"，而形状会出卖剪辑；
 * ② 流向角要**拉回它自己的竖直轴一半**（`channelAxis`）：通道必须与行进方向平行，否则交接读成两段，
 *    但通道很长，原始倾角（最大约 14°）在 720 高的画面上会把两端横向带走约 90px —— 足够把开口挪到字句底下。
 *    砍掉一半倾角，方向还在、走位减半，一次交接里剩下几像素的错位看不出来；
 * ③ 横向单位向量**强制指向画面 +x 半边**（`acrossFlow`）：流向以竖直为主但有的镜头朝上、有的朝下，
 *    原始垂线会翻边，而排版区是**写死的数据** —— 不归一化符号的话，"偏移 +n"有时会把开口送到字句下面。
 * ------------------------------------------------------------------ */

/** 流向角拉回竖直轴一半（folia: `channelAxis`）。 */
export function channelAxis(flowAngle: number): number {
  const axis = (Math.sin(flowAngle) >= 0 ? 1 : -1) * (Math.PI / 2);
  return axis + (flowAngle - axis) * 0.5;
}

/** 垂直于通道轴的单位向量，永远指向画面 +x 半边（folia: `acrossFlow`）。 */
export function acrossFlow(angle: number): { x: number; y: number } {
  const across = angle + Math.PI / 2;
  const sign = Math.cos(across) >= 0 ? 1 : -1;
  return { x: Math.cos(across) * sign, y: Math.sin(across) * sign };
}

/** 从画面中心横向偏移 `offset` 之后的点（folia: `acrossPoint`）。 */
export function acrossPoint(
  viewport: TemperaViewport,
  flowAngle: number,
  offset: number,
): { x: number; y: number } {
  const across = acrossFlow(channelAxis(flowAngle));
  return {
    x: viewport.width / 2 + across.x * offset,
    y: viewport.height / 2 + across.y * offset,
  };
}

/** 从画面中心沿轴走 `distance`、再横向偏 `offset` 的点（folia: `flowPoint`）。 */
export function flowPoint(
  viewport: TemperaViewport,
  flowAngle: number,
  distance: number,
  offset: number,
): { x: number; y: number } {
  const base = acrossPoint(viewport, flowAngle, offset);
  const angle = channelAxis(flowAngle);
  return {
    x: base.x + Math.cos(angle) * distance,
    y: base.y + Math.sin(angle) * distance,
  };
}

/** 一条贯穿画面的通道（folia: `channel`）：以偏移处为中心、沿轴的超长矩形。 */
function channelRect(
  viewport: TemperaViewport,
  flowAngle: number,
  offset: number,
  width: number,
): number[] {
  const centre = acrossPoint(viewport, flowAngle, offset);
  return axisRect(centre.x, centre.y, flowSpan(viewport), width, channelAxis(flowAngle));
}

/** 通道两侧各压一条发丝线（folia: `addRails`）。 */
function channelRails(
  viewport: TemperaViewport,
  flowAngle: number,
  offset: number,
  width: number,
  alpha = 0.55,
): TemperaStrokeSpec[] {
  const angle = channelAxis(flowAngle);
  const half = flowSpan(viewport) / 2;
  return ([1, -1] as const).map((side, index) => {
    const start = flowPoint(viewport, flowAngle, -half, offset + side * width);
    const end = flowPoint(viewport, flowAngle, half, offset + side * width);
    return line(
      [start.x, start.y, end.x, end.y],
      3,
      1.4,
      alpha,
      0.18 + index * 0.03,
      Math.cos(angle) * viewport.width * 0.08,
      Math.sin(angle) * viewport.height * 0.08,
    );
  });
}

/** 一条宽通道开在一侧，两条边都压着栏杆。 */
function flowChannel(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const unit = Math.min(viewport.width, viewport.height);
  const slot = channelRect(viewport, flowAngle, viewport.width * 0.26, unit * 0.3);
  return {
    panels: packPanels([cutField(2, viewport, bleed, [slot])], -1),
    seams: [],
    strokes: [
      holeLip(slot, 2.6, 0.85, 0.08),
      ...channelRails(viewport, flowAngle, viewport.width * 0.26, unit * 0.19),
    ],
    fallback: false,
  };
}

/** 两条通道，字句站在中间的肋上。 */
function twinChannel(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const unit = Math.min(viewport.width, viewport.height);
  const slots = [
    channelRect(viewport, flowAngle, -viewport.width * 0.34, unit * 0.16),
    channelRect(viewport, flowAngle, viewport.width * 0.34, unit * 0.16),
  ];
  return {
    panels: packPanels([cutField(3, viewport, bleed, slots)], -1),
    seams: [],
    strokes: slots.map((slot, index) => holeLip(slot, 2.4, 0.8, 0.1 + index * 0.04)),
    fallback: false,
  };
}

/** 芦苇：外侧各四条发丝通道，中间留一条干净的列给字句。 */
function reedRun(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const unit = Math.min(viewport.width, viewport.height);
  const slots: number[][] = [];
  for (const side of [1, -1] as const) {
    for (let index = 0; index < 4; index += 1) {
      slots.push(
        channelRect(
          viewport,
          flowAngle,
          side * viewport.width * (0.22 + index * 0.08),
          unit * 0.035,
        ),
      );
    }
  }
  return {
    panels: packPanels([cutField(1, viewport, bleed, slots, 0.9)], -1),
    seams: [],
    strokes: channelRails(viewport, flowAngle, 0, viewport.width * 0.17, 0.4),
    fallback: false,
  };
}

/** 越走越窄的通道：这一族里唯一**不是平移不变**的开口，所以它读成"通道到了某个地方"。 */
function taperChannel(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const unit = Math.min(viewport.width, viewport.height);
  const half = flowSpan(viewport) / 2;
  const wide = unit * 0.24;
  const narrow = unit * 0.06;
  const offset = viewport.width * 0.24;
  const corners = [
    flowPoint(viewport, flowAngle, -half, offset - wide),
    flowPoint(viewport, flowAngle, -half, offset + wide),
    flowPoint(viewport, flowAngle, half, offset + narrow),
    flowPoint(viewport, flowAngle, half, offset - narrow),
  ];
  const slot = corners.flatMap((point) => [point.x, point.y]);
  return {
    panels: packPanels([cutField(2, viewport, bleed, [slot])], -1),
    seams: [],
    strokes: [holeLip(slot, 2.6, 0.85, 0.08)],
    fallback: false,
  };
}

/** 沿行进线钻四个孔，用一条发丝线串起来。 */
function chainPorts(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const unit = Math.min(viewport.width, viewport.height);
  const offset = viewport.width * 0.28;
  const spacing = viewport.height * 0.26;
  const ports = [-1.5, -0.5, 0.5, 1.5].map((step) =>
    flowPoint(viewport, flowAngle, step * spacing, offset),
  );
  const holes = ports.map((port) => circlePolygon(port.x, port.y, unit * 0.11, 40));
  const head = flowPoint(viewport, flowAngle, -spacing * 2.4, offset);
  const tail = flowPoint(viewport, flowAngle, spacing * 2.4, offset);
  return {
    panels: packPanels([cutField(3, viewport, bleed, holes)], -1),
    seams: [],
    strokes: [
      ...holes.map((hole, index) => holeLip(hole, 2.4, 0.85, 0.1 + index * 0.01)),
      line([head.x, head.y, tail.x, tail.y], 1, 1.6, 0.6, 0.18),
    ],
    fallback: false,
  };
}

/** 切成虚线的通道，虚线之间留着实心的"枕木"。 */
function dashChannel(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const unit = Math.min(viewport.width, viewport.height);
  const offset = viewport.width * 0.24;
  const step = viewport.height * 0.32;
  const angle = channelAxis(flowAngle);
  const slots = [-1.5, -0.5, 0.5, 1.5].map((index) => {
    const centre = flowPoint(viewport, flowAngle, index * step, offset);
    return axisRect(centre.x, centre.y, step * 0.72, unit * 0.22, angle);
  });
  return {
    panels: packPanels([cutField(2, viewport, bleed, slots)], -1),
    seams: [],
    strokes: slots.map((slot, index) => holeLip(slot, 2.2, 0.8, 0.08 + index * 0.03)),
    fallback: false,
  };
}

/** 车厢窗：圆角开口按固定间距一格格过去。 */
function windowRun(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const unit = Math.min(viewport.width, viewport.height);
  const offset = viewport.width * 0.27;
  // 间距必须容下窗口加上它的内沿，否则这一排会读成一串连着的格子。
  const step = viewport.height * 0.36;
  const angle = channelAxis(flowAngle);
  const slots = [-1.5, -0.5, 0.5, 1.5].map((index) => {
    const centre = flowPoint(viewport, flowAngle, index * step, offset);
    const size = unit * 0.2;
    return rotatePolygon(
      roundedRectPolygon(centre.x - size, centre.y - size * 0.62, size * 2, size * 1.24, size * 0.3),
      centre.x,
      centre.y,
      angle + Math.PI / 2,
    );
  });
  return {
    panels: packPanels([cutField(3, viewport, bleed, slots)], -1),
    seams: [],
    strokes: slots.map((slot, index) => holeLip(slot, 2.4, 0.85, 0.08 + index * 0.03)),
    fallback: false,
  };
}

/** 这一族里最宽的通道，被一条实心带横跨 —— 字句骑在带上，于是读成背景之上的桥。 */
function bridgeSpan(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const unit = Math.min(viewport.width, viewport.height);
  const slot = channelRect(viewport, flowAngle, 0, unit * 0.62);
  // 带子刻意比字句需要的更厚：它会跟着通道歪，歪掉的带子两端会先掉高度。
  const band = axisRect(
    viewport.width / 2,
    viewport.height / 2,
    flowSpan(viewport),
    viewport.height * 0.46,
    channelAxis(flowAngle) + Math.PI / 2,
  );
  return {
    panels: packPanels(
      [
        cutField(3, viewport, bleed, [slot]),
        {
          polygon: band,
          tone: 2,
          enterDX: -viewport.width * 0.16,
          enterDY: 0,
          alpha: 0.95,
          span: 0.6,
          delay: 0.12,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      holeLip(slot, 2.6, 0.8, 0.08),
      line(band, INK_TONE, 2, 0.7, 0.2, viewport.width * 0.1, 0, true),
    ],
    fallback: false,
  };
}

/** 两条通道，各自在对方畅通处被系断 —— 枕木交替，于是这一对读成"编织"而不是两条平行槽。 */
function braidChannel(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const unit = Math.min(viewport.width, viewport.height);
  const angle = channelAxis(flowAngle);
  const pitch = viewport.height * 0.42;
  const slots: number[][] = [];
  for (const side of [1, -1] as const) {
    // 两侧之间错开半个间距就是全部的机关：一条被系断的地方，另一条正畅通。
    for (let index = -1; index <= 1; index += 1) {
      const centre = flowPoint(
        viewport,
        flowAngle,
        index * pitch + side * pitch * 0.5,
        side * viewport.width * 0.32,
      );
      slots.push(axisRect(centre.x, centre.y, pitch * 0.78, unit * 0.16, angle));
    }
  }
  return {
    panels: packPanels([cutField(2, viewport, bleed, slots)], -1),
    seams: [],
    strokes: slots.map((slot, index) => holeLip(slot, 2.2, 0.8, 0.08 + index * 0.025)),
    fallback: false,
  };
}

/** 通道两侧刻上横档 —— 把通道当成一把量尺。 */
function portLadder(
  _seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle: number,
): TemperaCompositionSpec {
  const unit = Math.min(viewport.width, viewport.height);
  const offset = viewport.width * 0.3;
  const slot = channelRect(viewport, flowAngle, offset, unit * 0.14);
  const rungs: TemperaStrokeSpec[] = [];
  for (let index = 0; index < 9; index += 1) {
    const distance = (index - 4) * viewport.height * 0.13;
    const long = index % 3 === 0;
    const inner = flowPoint(viewport, flowAngle, distance, offset - unit * 0.09);
    const outer = flowPoint(viewport, flowAngle, distance, offset - unit * (long ? 0.22 : 0.15));
    rungs.push(line([inner.x, inner.y, outer.x, outer.y], 3, 2, 0.7, 0.14 + index * 0.01));
  }
  return {
    panels: packPanels([cutField(1, viewport, bleed, [slot])], -1),
    seams: [],
    strokes: [holeLip(slot, 2.2, 0.8, 0.08), ...rungs],
    fallback: false,
  };
}

const CORRIDOR_BUILDERS: Partial<
  Record<
    TemperaShotKind,
    (
      seed: number,
      viewport: TemperaViewport,
      bleed: number,
      flowAngle: number,
    ) => TemperaCompositionSpec
  >
> = {
  'flow-channel': flowChannel,
  'twin-channel': twinChannel,
  'reed-run': reedRun,
  'taper-channel': taperChannel,
  'chain-ports': chainPorts,
  'dash-channel': dashChannel,
  'window-run': windowRun,
  'bridge-span': bridgeSpan,
  'braid-channel': braidChannel,
  'port-ladder': portLadder,
};

/** corridor 族；`null` = 这个 kind 不属本族（它同样需要流向角）。 */
export function buildTemperaCorridorComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
  flowAngle = Math.PI / 2,
): TemperaCompositionSpec | null {
  const builder = CORRIDOR_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed, flowAngle);
}

/** 把一条线段集合铺成网线（渲染层用它；抽在这里是为了纯函数可单测）。 */
export function hatchLinesOf(
  polygon: readonly number[],
  surface: TemperaHatchSurface,
  coverage = 1,
): TemperaHatchLine[] {
  return buildHatchLines(polygon, surface.spec, coverage);
}

/* ------------------------------------------------------------------ *
 * monolith 工具箱（folia: compositions/temperaMonolithKit.ts）
 *
 * 野兽派的词汇，`monolith` 与 `terrain` 两族共用：一块巨大的哑光体块、两三根**横贯整幅画面**的发丝线、
 * 一个面上的一排直纹、几个小小的测量记号。体块自己就能撑起这一镜，所以其余东西**刻意做得很薄** ——
 * 被装饰包围的巨石就不再是巨石了。
 *
 * 两条照抄的规矩：
 * ① **每一块体块至少有一边跑出画面**。四边都在画内的实心块读起来像"摆在纸上的一件东西"；
 *    同一个块被画面裁掉一边，读起来才像"大到装不下它" —— 这就是全部的效果。
 * ② 直纹要用**凸的**面片（`buildHatchLines` 靠半平面裁剪），所以调用方传的是体块上切下来的凸片，
 *    而不是体块本身（体块通常是阶梯状或带缺口的）。
 *
 * 实现风格：folia 用命令式 `ctx.add()`，我们这里是"工厂返回 spec"，所以用一个**收集器**把
 * `ground / mass / faceRuling / ...` 的调用攒起来，调用点因此与 folia 逐行对照。
 * ------------------------------------------------------------------ */

interface MonolithMassOptions {
  readonly alpha?: number;
  readonly delay?: number;
  readonly span?: number;
  readonly enterDX?: number;
  readonly enterDY?: number;
  /** 墨色轮廓。与另一块体块相接（而不是立在地面上）的块要关掉它。 */
  readonly edge?: boolean;
  readonly edgeWidth?: number;
  /** 这块体块上要**一起**挖掉的孔（阶梯井/桥面那种"一钻贯到底"的开口）。 */
  readonly holes?: readonly (readonly number[])[];
}

interface MonolithKit {
  /** 体块立在上面的满幅地面。 */
  ground(tone: number, alpha?: number): void;
  /** 一块体块：填充 +（默认开着的）墨色轮廓。 */
  mass(polygon: readonly number[], tone: number, options?: MonolithMassOptions): void;
  /** 一个面上的一排直纹（面片必须是凸的）。 */
  faceRuling(face: readonly number[], salt: number, tone?: number, alpha?: number): void;
  /** 两三根**横贯整幅画面**的浅角度发丝线。 */
  surveyLines(count?: number, salt?: number): void;
  /** 两个对角上的测量记号。 */
  cornerTicks(): void;
  /** 停在角落的一圈松松的"走线"。 */
  wireTrace(cx: number, cy: number, radius: number): void;
  readonly panels: RawPanel[];
  readonly strokes: TemperaStrokeSpec[];
}

/** 纸色：与体块相对的那一端，测量线与刻度用它。 */
const PAPER_TONE = 0;

function createMonolithKit(seed: number, viewport: TemperaViewport, bleed: number): MonolithKit {
  const panels: RawPanel[] = [];
  const strokes: TemperaStrokeSpec[] = [];
  const unit = Math.min(viewport.width, viewport.height);
  return {
    panels,
    strokes,
    ground(tone, alpha = 0.94) {
      panels.push({
        polygon: rectPolygon(
          -bleed,
          -bleed,
          viewport.width + bleed * 2,
          viewport.height + bleed * 2,
        ),
        tone,
        enterDX: 0,
        enterDY: 0,
        alpha,
        span: 0.5,
        delay: 0,
      });
    },
    mass(polygon, tone, options = {}) {
      const delay = options.delay ?? 0.04;
      const enterDX = options.enterDX ?? 0;
      const enterDY = options.enterDY ?? 0;
      panels.push({
        polygon: [...polygon],
        tone,
        enterDX,
        enterDY,
        alpha: options.alpha ?? 0.95,
        span: options.span ?? 0.6,
        delay,
        ...(options.holes === undefined ? {} : { holes: options.holes }),
      });
      if (options.edge === false) return;
      strokes.push(
        line(
          [...polygon],
          INK_TONE,
          options.edgeWidth ?? 2.4,
          0.8,
          delay + 0.06,
          enterDX * 0.6,
          enterDY * 0.6,
          true,
        ),
      );
    },
    faceRuling(face, salt, tone = 3, alpha = 0.5) {
      panels.push({
        polygon: [...face],
        tone,
        enterDX: 0,
        enterDY: 0,
        // 面片自己是空心的，只出网线（`alpha: 0`）；网线带 `grow`，所以是从中间长开的。
        alpha: 0,
        span: 0.65,
        delay: 0.16,
        hatch: { spec: buildHatchSpec(seed, salt, 0.7), tone, alpha, grow: true },
      });
    },
    surveyLines(count = 3, salt = 211) {
      const total = Math.max(1, count);
      for (let index = 0; index < total; index += 1) {
        const anchor = viewport.height * (0.16 + ((index * 0.31 + (seed % 7) * 0.04) % 0.7));
        const lean = viewport.height * (index % 2 === 0 ? 0.22 : -0.16);
        strokes.push(
          line(
            [-bleed, anchor - lean, viewport.width + bleed, anchor + lean],
            PAPER_TONE,
            1,
            0.45,
            0.2 + (salt % 3) * 0.02 + index * 0.01,
            viewport.width * 0.2,
          ),
        );
      }
    },
    cornerTicks() {
      const inset = unit * 0.06;
      const arm = unit * 0.05;
      const corners: readonly (readonly [number, number])[] = [
        [1, 1],
        [-1, -1],
      ];
      corners.forEach(([sx, sy], index) => {
        const x = sx > 0 ? inset : viewport.width - inset;
        const y = sy > 0 ? inset : viewport.height - inset;
        strokes.push(
          line([x, y, x + sx * arm, y], PAPER_TONE, 1.6, 0.6, 0.26 + index * 0.04),
          line([x, y, x, y + sy * arm], PAPER_TONE, 1.6, 0.6, 0.26 + index * 0.04),
        );
      });
    },
    wireTrace(cx, cy, radius) {
      // folia 把这条线放进一个"以 (cx, cy) 为原点"的组里，因为 `drift` 是绕节点自身原点缩放旋转的；
      // 我们没有节点组，所以直接把圆心画在 (cx, cy)，效果一致。
      strokes.push(line(buildScribblePath(seed, 199, cx, cy, radius, 1), PAPER_TONE, 1.2, 0.4, 0.3));
    },
  };
}

/* ------------------------------------------------------------------ *
 * monolith 族（folia: compositions/temperaMonolithCompositions.ts）
 *
 * 野兽派：一块巨大的哑光实心块被画面裁切，字句坐在它的**剪影上**。
 * 字句**横跨剪影**放在背景实心的地方 —— 一个字一半在体块上一半在外，正是反色滤镜效果最好的位置；
 * 若某族把地面开向背景，排版区就整个移到体块上（绝不允许横跨开口）。
 * ------------------------------------------------------------------ */

/** 一座山峰状体块，只有一面打直纹（两面都打会读成纹理，而不是受光的面）。 */
function apexMass(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const kit = createMonolithKit(seed, viewport, bleed);
  const apexX = width * (0.46 + temperaHash01(seed, 3, 227) * 0.12);
  const apexY = height * 0.38;
  kit.ground(0);
  kit.mass([-bleed, height + bleed, apexX, apexY, width + bleed, height + bleed], 2, {
    enterDY: height * 0.1,
  });
  kit.faceRuling(
    [apexX, apexY, width + bleed, height + bleed, apexX + width * 0.24, height + bleed],
    229,
  );
  kit.surveyLines(3);
  kit.cornerTicks();
  kit.wireTrace(width * 0.12, height * 0.84, unit * 0.09);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 阶梯状的山：每一层都是自己的节点，所以整叠是**往上长**出来的。 */
function ziggurat(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  kit.ground(0);
  const tones = [3, 2, 2, 1];
  for (let course = 0; course < 4; course += 1) {
    const half = width * (0.44 - course * 0.09);
    const top = height * (0.9 - course * 0.13) - height * 0.13;
    kit.mass(rectPolygon(width / 2 - half, top, half * 2, height * 0.13 + bleed), tones[course] ?? 2, {
      delay: 0.04 + course * 0.05,
      enterDY: height * 0.08,
      edgeWidth: 2,
    });
  }
  kit.surveyLines(2);
  kit.cornerTicks();
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 一面几乎顶满画面的墙，前缘一道深缝。 */
function slabWall(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const kit = createMonolithKit(seed, viewport, bleed);
  const edge = width * 0.36;
  kit.ground(0);
  kit.mass(rectPolygon(edge, -bleed, width - edge + bleed, height + bleed * 2), 2, { edge: false });
  kit.strokes.push(
    line([edge, -bleed, edge, height + bleed], INK_TONE, 3.5, 0.9, 0.1, width * 0.06),
  );
  kit.faceRuling(rectPolygon(width * 0.62, height * 0.1, width * 0.3, height * 0.8), 233);
  kit.surveyLines(3);
  kit.wireTrace(width * 0.16, height * 0.24, unit * 0.08);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 挑出去悬在空中的梁，只留一小段支撑 —— 那一段就是"悬臂"的全部意思。 */
function cantilever(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  kit.ground(0);
  kit.mass(rectPolygon(0.16 * width, height * 0.5, width * 0.1, height * 0.5 + bleed), 3, {
    delay: 0.02,
    enterDY: height * 0.1,
    edge: false,
  });
  kit.mass(rectPolygon(-bleed, height * 0.34, width * 0.78 + bleed, height * 0.16), 2, {
    delay: 0.08,
    enterDX: -width * 0.14,
  });
  kit.faceRuling(
    rectPolygon(width * 0.3, height * 0.36, width * 0.44, height * 0.12),
    239,
    PAPER_TONE,
    0.35,
  );
  kit.surveyLines(2);
  kit.cornerTicks();
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 两根塔柱抬一条过梁；柱间的开间是**从地面裁掉**的，所以那片空是天空而不是纸。 */
function pylonPair(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  const bay = rectPolygon(width * 0.26, height * 0.3, width * 0.48, height * 0.7 + bleed);
  kit.panels.push(cutField(0, viewport, bleed, [bay], 0.94));
  kit.strokes.push(holeLip(bay, 2, 0.6, 0.12));
  ([0.1, 0.74] as const).forEach((x, index) => {
    kit.mass(rectPolygon(width * x, height * 0.28, width * 0.16, height * 0.72 + bleed), 3, {
      delay: 0.04 + index * 0.05,
      enterDY: height * 0.08,
      edgeWidth: 2,
    });
  });
  kit.mass(rectPolygon(width * 0.04, height * 0.14, width * 0.92, height * 0.16), 2, {
    delay: 0.14,
    enterDY: -height * 0.1,
  });
  kit.surveyLines(2);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 碉堡：一条观察缝**同时**从地面和体块上切掉（只切体块的话，缝里看到的只是它背后的纸）。 */
function bunkerSlit(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  const slit = rectPolygon(-bleed, height * 0.62, width + bleed * 2, height * 0.06);
  kit.panels.push(cutField(0, viewport, bleed, [slit], 0.94));
  /*
   * 体块做成**上下两段**、在缝的两侧停住。画成一整块再把缝切掉也行，
   * 但"两半从相反方向进场"才是让这个开口读成**被撬开**的原因。
   */
  kit.panels.push({
    polygon: rectPolygon(-bleed, height * 0.34, width + bleed * 2, height * 0.28),
    tone: 3,
    enterDX: 0,
    enterDY: -height * 0.08,
    alpha: 0.95,
    span: 0.6,
    delay: 0.05,
  });
  kit.panels.push({
    polygon: rectPolygon(-bleed, height * 0.68, width + bleed * 2, height * 0.32 + bleed),
    tone: 3,
    enterDX: 0,
    enterDY: height * 0.1,
    alpha: 0.95,
    span: 0.6,
    delay: 0.08,
  });
  kit.strokes.push(
    line([-bleed, height * 0.34, width + bleed, height * 0.34], INK_TONE, 3, 0.85, 0.14),
  );
  kit.faceRuling(
    rectPolygon(width * 0.08, height * 0.72, width * 0.36, height * 0.2),
    241,
    PAPER_TONE,
    0.3,
  );
  kit.surveyLines(2);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 三层基座，一层比一层往里收。 */
function plinthStack(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  kit.ground(0);
  kit.mass(rectPolygon(width * 0.06, height * 0.72, width * 0.88, height * 0.28 + bleed), 3, {
    edgeWidth: 2,
  });
  kit.mass(rectPolygon(width * 0.16, height * 0.52, width * 0.68, height * 0.2), 2, {
    delay: 0.08,
    edgeWidth: 2,
  });
  kit.mass(rectPolygon(width * 0.28, height * 0.34, width * 0.44, height * 0.18), 1, {
    delay: 0.14,
    enterDY: height * 0.06,
  });
  kit.faceRuling(rectPolygon(width * 0.2, height * 0.76, width * 0.6, height * 0.16), 243);
  kit.surveyLines(3);
  kit.cornerTicks();
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 一排扶壁：地面开一条带，鳍片插在带里 —— 所以缝隙之间不必各自再挖一次洞。 */
function buttressRun(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  const band = rectPolygon(-bleed, height * 0.42, width + bleed * 2, height * 0.58 + bleed);
  kit.panels.push(cutField(0, viewport, bleed, [band], 0.94));
  for (let index = 0; index < 5; index += 1) {
    const left = width * (index * 0.2 + 0.01);
    kit.mass(
      [
        left, height + bleed,
        left + width * 0.09, height * 0.42,
        left + width * 0.17, height + bleed,
      ],
      index % 2 === 0 ? 3 : 2,
      { delay: 0.04 + index * 0.04, enterDY: height * 0.12, edgeWidth: 2 },
    );
  }
  kit.strokes.push(
    line([-bleed, height * 0.42, width + bleed, height * 0.42], INK_TONE, 2.4, 0.8, 0.2, -width * 0.1),
  );
  kit.surveyLines(2);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 一整块被掏掉中段 —— 开口是全族最大的，而上方留出的那条带正好给字句站。 */
function voidCore(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const kit = createMonolithKit(seed, viewport, bleed);
  const core = rectPolygon(width * 0.22, height * 0.34, width * 0.56, height * 0.46);
  kit.panels.push(cutField(2, viewport, bleed, [core], 0.95));
  kit.strokes.push(holeLip(core, 3.5, 0.9, 0.08));
  kit.faceRuling(rectPolygon(width * 0.04, height * 0.36, width * 0.14, height * 0.42), 247, 3, 0.45);
  kit.surveyLines(3);
  kit.cornerTicks();
  kit.wireTrace(width * 0.86, height * 0.86, unit * 0.08);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 一整块沿对角线剪开、两半互相推过去。 */
function shearBlock(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  const left = width * 0.14;
  const right = width * 0.86;
  const top = height * 0.2;
  const bottom = height * 0.8;
  const cutTop = width * 0.56;
  const cutBottom = width * 0.44;
  kit.ground(0);
  kit.mass([left, top, cutTop, top, cutBottom, bottom, left, bottom], 2, {
    enterDX: -width * 0.08,
    enterDY: -height * 0.03,
    edgeWidth: 2,
  });
  kit.mass(
    [
      cutTop + width * 0.03, top + height * 0.04,
      right, top + height * 0.04,
      right, bottom + height * 0.04,
      cutBottom + width * 0.03, bottom + height * 0.04,
    ],
    3,
    { delay: 0.1, enterDX: width * 0.08, enterDY: height * 0.03, edgeWidth: 2 },
  );
  kit.surveyLines(2);
  kit.strokes.push(
    line(
      rectPolygon(width * 0.1, height * 0.16, width * 0.8, height * 0.68),
      PAPER_TONE,
      1.2,
      0.35,
      0.28,
      0,
      0,
      true,
    ),
  );
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

const MONOLITH_BUILDERS: Partial<
  Record<TemperaShotKind, (seed: number, viewport: TemperaViewport, bleed: number) => TemperaCompositionSpec>
> = {
  'apex-mass': apexMass,
  ziggurat,
  'slab-wall': slabWall,
  cantilever,
  'pylon-pair': pylonPair,
  'bunker-slit': bunkerSlit,
  'plinth-stack': plinthStack,
  'buttress-run': buttressRun,
  'void-core': voidCore,
  'shear-block': shearBlock,
};

/** monolith 族；`null` = 这个 kind 不属本族。 */
export function buildTemperaMonolithComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec | null {
  const builder = MONOLITH_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed);
}

/* ------------------------------------------------------------------ *
 * terrain 族（folia: compositions/temperaTerrainCompositions.ts）
 *
 * 野兽派的那一半：体块读成**地景与结构**（山脊、跨度、桥墩、护坡），而不是"一件东西"。
 * 与 monolith 同一套规矩（一块主控实心体、薄薄的测量记号、全部被画面裁切），
 * 不同的是它做出来的**地平线是"画面身处其中"**，而不是"看着它"。
 * ------------------------------------------------------------------ */

/** 一道山脊。山脊就是构图本身，字句被排成**横跨它最高的那段**。 */
function ridgeLine(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const kit = createMonolithKit(seed, viewport, bleed);
  const lift = temperaHash01(seed, 5, 251) * 0.06;
  kit.ground(0);
  kit.mass(
    [
      -bleed, height * (0.68 + lift),
      width * 0.34, height * (0.4 + lift),
      width * 0.62, height * (0.58 + lift),
      width + bleed, height * (0.34 + lift),
      width + bleed, height + bleed,
      -bleed, height + bleed,
    ],
    2,
    { enterDY: height * 0.08 },
  );
  kit.faceRuling(
    [
      width * 0.34, height * (0.42 + lift),
      width * 0.62, height * (0.6 + lift),
      width * 0.62, height + bleed,
      width * 0.34, height + bleed,
    ],
    253,
    3,
    0.45,
  );
  kit.surveyLines(3);
  kit.cornerTicks();
  kit.wireTrace(width * 0.1, height * 0.86, unit * 0.08);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 两块**永远碰不上**的体块。它们之间那道缝被切到背景，于是它成了画面里唯一发光的东西。 */
function chasm(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  const gap = rectPolygon(width * 0.46, -bleed, width * 0.1, height + bleed * 2);
  kit.panels.push(cutField(1, viewport, bleed, [gap], 0.94));
  kit.mass(rectPolygon(-bleed, height * 0.3, width * 0.46 + bleed, height * 0.7 + bleed), 2, {
    enterDX: -width * 0.1,
    edgeWidth: 2,
  });
  kit.mass(rectPolygon(width * 0.56, height * 0.2, width * 0.44 + bleed, height * 0.8 + bleed), 3, {
    delay: 0.08,
    enterDX: width * 0.1,
    edgeWidth: 2,
  });
  kit.surveyLines(2);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 从上方压下来的屋檐，以及它撞上的墙和投下的影。 */
function overhang(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  kit.ground(0);
  kit.mass(rectPolygon(-bleed, -bleed, width + bleed * 2, height * 0.34 + bleed), 3, {
    enterDY: -height * 0.1,
    edgeWidth: 3,
  });
  kit.mass(rectPolygon(width * 0.72, height * 0.34, width * 0.28 + bleed, height * 0.66 + bleed), 2, {
    delay: 0.08,
    enterDX: width * 0.1,
    edge: false,
  });
  // 影子是一层**淡洗**，不是一块体块：它自己不能承字句。
  kit.panels.push({
    polygon: rectPolygon(-bleed, height * 0.34, width + bleed * 2, height * 0.14),
    tone: 1,
    enterDX: 0,
    enterDY: 0,
    alpha: 0.5,
    span: 0.6,
    delay: 0.16,
  });
  kit.surveyLines(3);
  kit.cornerTicks();
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 阶梯井：一层层往里退，退到一口**贯穿每一层**的竖井。 */
function stepWell(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  const shaft = rectPolygon(width * 0.36, height * 0.6, width * 0.28, height * 0.4 + bleed);
  kit.panels.push(cutField(1, viewport, bleed, [shaft], 0.94));
  const courses: readonly (readonly [number, number, number, number])[] = [
    [0.14, 0.3, 0.72, 2],
    [0.24, 0.44, 0.52, 3],
  ];
  courses.forEach(([x, y, width_, tone], index) => {
    kit.mass(rectPolygon(width * x, height * y, width * width_, height * (1 - y) + bleed), tone, {
      delay: 0.06 + index * 0.06,
      enterDY: height * 0.06,
      edge: false,
      // 每一层都带着**同一口**竖井：一钻贯到底，井才真的通。
      holes: [shaft],
    });
  });
  kit.strokes.push(holeLip(shaft, 3, 0.85, 0.18));
  kit.surveyLines(2);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 立在开出来的水带里的桥墩，上面跑着它们抬的桥面。 */
function pierRow(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  const water = rectPolygon(-bleed, height * 0.46, width + bleed * 2, height * 0.54 + bleed);
  kit.panels.push(cutField(1, viewport, bleed, [water], 0.94));
  [0.04, 0.28, 0.52, 0.76].forEach((x, index) => {
    kit.mass(rectPolygon(width * x, height * 0.46, width * 0.14, height * 0.54 + bleed), 3, {
      delay: 0.06 + index * 0.04,
      enterDY: height * 0.1,
      edge: false,
    });
  });
  /*
   * 桥面必须**比字句的框还深**：它是开出来的水带上方唯一的实心物，
   * 挂在水带外的任何一角都会直接坐在裸背景上。
   */
  kit.mass(rectPolygon(-bleed, height * 0.32, width + bleed * 2, height * 0.16), 2, {
    delay: 0.02,
    enterDX: -width * 0.12,
    edgeWidth: 2,
  });
  kit.surveyLines(2);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 带肋的护坡，两端都跑出画面。 */
function revetment(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  kit.ground(0);
  kit.mass(
    [
      -bleed, height * 0.72,
      width * 0.62, height * 0.3,
      width + bleed, height * 0.34,
      width + bleed, height + bleed,
      -bleed, height + bleed,
    ],
    2,
    { enterDY: height * 0.1 },
  );
  for (let index = 0; index < 9; index += 1) {
    const x = width * (0.04 + index * 0.11);
    const top = height * (0.72 - (x / (width * 0.62)) * 0.42);
    kit.strokes.push(
      line([x, Math.max(top, height * 0.3) + height * 0.03, x - width * 0.03, height + bleed], 3, 2.4, 0.5, 0.16 + index * 0.01),
    );
  }
  kit.surveyLines(3);
  kit.cornerTicks();
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 一个远大于画面的东西的**一个角**，外加一大片什么都没有。这是这一族说"尺度"最安静的方式。 */
function towerCrop(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const kit = createMonolithKit(seed, viewport, bleed);
  kit.ground(0);
  kit.mass(rectPolygon(width * 0.58, height * 0.18, width * 0.42 + bleed, height * 0.82 + bleed), 3, {
    enterDX: width * 0.08,
    enterDY: height * 0.06,
    edgeWidth: 3,
  });
  kit.faceRuling(rectPolygon(width * 0.62, height * 0.26, width * 0.12, height * 0.6), 257, PAPER_TONE, 0.3);
  kit.surveyLines(2);
  kit.wireTrace(width * 0.2, height * 0.7, unit * 0.1);
  kit.cornerTicks();
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 一根两端支座都在画外的过梁：这一镜只剩下**跨度**本身。 */
function lintel(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, bleed);
  kit.ground(0);
  kit.mass(rectPolygon(-bleed, height * 0.4, width + bleed * 2, height * 0.2), 2, {
    enterDX: -width * 0.16,
    edgeWidth: 3,
  });
  ([0.18, 0.66] as const).forEach((x, index) => {
    kit.mass(rectPolygon(width * x, height * 0.6, width * 0.16, height * 0.12), 3, {
      delay: 0.12 + index * 0.04,
      enterDY: height * 0.06,
      edge: false,
    });
  });
  kit.surveyLines(3);
  kit.cornerTicks();
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 从画外一个点扇形散开的碎板 —— 同一块体块**垮掉之后**的样子。 */
function rubbleFan(seed: number, viewport: TemperaViewport, _bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const kit = createMonolithKit(seed, viewport, _bleed);
  const hubX = -width * 0.12;
  const hubY = height * 1.12;
  kit.ground(0);
  for (let index = 0; index < 5; index += 1) {
    const angle = -1.24 + index * 0.19 + temperaHash01(seed, index, 259) * 0.05;
    const reach = Math.hypot(width, height) * (0.5 + index * 0.09);
    const slab = rectPolygon(
      hubX + reach * 0.34,
      hubY - height * 0.06,
      reach * 0.5,
      height * 0.12 + index * 8,
    );
    kit.mass(rotatePolygon(slab, hubX, hubY, angle), index % 2 === 0 ? 2 : 3, {
      delay: 0.04 + index * 0.05,
      enterDX: -width * 0.06,
      enterDY: height * 0.06,
      edgeWidth: 2,
    });
  }
  kit.surveyLines(2);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

/** 一根日晷针和它投下的影子：两块体块，其中一块只是一条**方向**。 */
function gnomon(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const kit = createMonolithKit(seed, viewport, bleed);
  kit.ground(0);
  kit.panels.push({
    polygon: [
      width * 0.42, height * 0.86,
      width + bleed, height * 0.6,
      width + bleed, height * 0.78,
      width * 0.46, height * 0.94,
    ],
    tone: 1,
    enterDX: width * 0.1,
    enterDY: 0,
    alpha: 0.6,
    span: 0.65,
    delay: 0.1,
  });
  kit.mass(
    [
      width * 0.3, height + bleed,
      width * 0.36, height * 0.16,
      width * 0.42, height * 0.16,
      width * 0.46, height + bleed,
    ],
    3,
    { delay: 0.04, enterDY: height * 0.08, edgeWidth: 2 },
  );
  kit.surveyLines(3);
  kit.cornerTicks();
  kit.wireTrace(width * 0.8, height * 0.82, unit * 0.08);
  return { panels: packPanels(kit.panels, -1), seams: [], strokes: kit.strokes, fallback: false };
}

const TERRAIN_BUILDERS: Partial<
  Record<TemperaShotKind, (seed: number, viewport: TemperaViewport, bleed: number) => TemperaCompositionSpec>
> = {
  'ridge-line': ridgeLine,
  chasm,
  overhang,
  'step-well': stepWell,
  'pier-row': pierRow,
  revetment,
  'tower-crop': towerCrop,
  lintel,
  'rubble-fan': rubbleFan,
  gnomon,
};

/** terrain 族；`null` = 这个 kind 不属本族。 */
export function buildTemperaTerrainComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec | null {
  const builder = TERRAIN_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed);
}

/* ------------------------------------------------------------------ *
 * monogatari 族（folia: compositions/temperaMonogatariCompositions.ts）
 *
 * 「物语」式的过场卡：一整片**从边到边**的平色，字句就是整幅画面。
 * 这一族**刻意几乎不带几何** —— 前后两镜已经把戏做完了，这张卡是它们之间那一拍静默。
 *
 * 照抄的两个做法：
 * ① 底色**交替取色调阶梯的两端**（`hash01(seed,167,173) > 0.5` 走深端、否则走浅端），
 *    同一首歌里连着两张卡才会读成一次**切换**而不是一次停留；
 * ② 这一族的填充是 **alpha 1**（不是别族的 0.94 上下）—— 卡片要真的像一张卡纸，不能透出背景。
 * ------------------------------------------------------------------ */

/** 这一张卡取阶梯的哪一端。 */
function pickMonogatariField(seed: number): number {
  return temperaHash01(seed, 167, 173) > 0.5 ? 3 : 0;
}

/** 从边到边的一整片平色（alpha 1）。 */
function monogatariField(tone: number, viewport: TemperaViewport, bleed: number): RawPanel {
  return {
    polygon: rectPolygon(-bleed, -bleed, viewport.width + bleed * 2, viewport.height + bleed * 2),
    tone,
    enterDX: 0,
    enterDY: 0,
    alpha: 1,
    span: 0.45,
    delay: 0,
  };
}

/** 光卡：一片平色，别的什么都没有，字句自己扛。 */
function monogatariCard(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  return {
    panels: packPanels([monogatariField(pickMonogatariField(seed), viewport, bleed)], -1),
    seams: [],
    strokes: [
      // 最底下一条发丝线，像标题卡会带的那道页脚。
      line([width * 0.12, height * 0.9, width * 0.88, height * 0.9], PAPER_TONE, 1.2, 0.45, 0.22, width * 0.15),
    ],
    fallback: false,
  };
}

/** 带一条重横规的卡：把画面切成两半。 */
function monogatariRule(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const y = height * (0.62 + temperaHash01(seed, 179, 181) * 0.08);
  return {
    panels: packPanels(
      [
        monogatariField(pickMonogatariField(seed), viewport, bleed),
        {
          polygon: rectPolygon(-bleed, y, width + bleed * 2, height * 0.012),
          tone: PAPER_TONE,
          enterDX: -width * 0.3,
          enterDY: 0,
          alpha: 0.85,
          span: 0.55,
          delay: 0.12,
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [
      line([-bleed, y + height * 0.05, width + bleed, y + height * 0.05], PAPER_TONE, 1, 0.35, 0.2, width * 0.2),
    ],
    fallback: false,
  };
}

/** 一边压一条对比色书脊的卡，像装订过的书页。 */
function monogatariEdge(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const field = pickMonogatariField(seed);
  const band = width * (0.1 + temperaHash01(seed, 191, 193) * 0.05);
  const fromLeft = temperaHash01(seed, 197, 199) > 0.5;
  const spine = rectPolygon(fromLeft ? -bleed : width - band, -bleed, band + bleed, height + bleed * 2);
  return {
    panels: packPanels(
      [
        monogatariField(field, viewport, bleed),
        {
          polygon: spine,
          // 书脊取**底色的反端**，所以它总是在对比里。
          tone: field === 3 ? 0 : 3,
          enterDX: (fromLeft ? -1 : 1) * width * 0.2,
          enterDY: 0,
          alpha: 0.95,
          span: 0.55,
          delay: 0.1,
          hatch: { spec: buildHatchSpec(seed, 211), tone: PAPER_TONE, alpha: 0.2, grow: true },
        },
      ],
      -1,
    ),
    seams: [],
    strokes: [],
    fallback: false,
  };
}

/** 两条竖线夹出一栏字句：这张卡读成一段"堆起来的说明"。 */
function monogatariStack(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const column = width * 0.5;
  return {
    panels: packPanels([monogatariField(pickMonogatariField(seed), viewport, bleed)], -1),
    seams: [],
    strokes: [
      line(
        [(width - column) / 2, -bleed, (width - column) / 2, height + bleed],
        PAPER_TONE,
        1.1,
        0.4,
        0.14,
        0,
        height * 0.12,
      ),
      line(
        [(width + column) / 2, -bleed, (width + column) / 2, height + bleed],
        PAPER_TONE,
        1.1,
        0.4,
        0.14,
        0,
        height * 0.12,
      ),
    ],
    fallback: false,
  };
}

/** 最响的那张：底色取到阶梯的**最远端**、字句最大、外加一排记号。 */
function monogatariFlash(seed: number, viewport: TemperaViewport, bleed: number): TemperaCompositionSpec {
  const { width, height } = viewport;
  const marks = buildCrossRow(seed, 223, width * 0.1, height * 0.18, 4, width * 0.05, 10);
  const half = (mark: (typeof marks)[number]): number => mark.size / 2;
  const strokes = marks.flatMap((mark) => {
    const cos = Math.cos(mark.rotation);
    const sin = Math.sin(mark.rotation);
    const arm = (dx: number, dy: number): readonly [number, number] => [
      mark.x + dx * cos - dy * sin,
      mark.y + dx * sin + dy * cos,
    ];
    const size = half(mark);
    return [
      line([...arm(-size, -size), ...arm(size, size)], PAPER_TONE, 2.4, 0.6, 0.2, -width * 0.1),
      line([...arm(-size, size), ...arm(size, -size)], PAPER_TONE, 2.4, 0.6, 0.2, -width * 0.1),
    ];
  });
  return {
    panels: packPanels([monogatariField(3, viewport, bleed)], -1),
    seams: [],
    strokes,
    fallback: false,
  };
}

const MONOGATARI_BUILDERS: Partial<
  Record<TemperaShotKind, (seed: number, viewport: TemperaViewport, bleed: number) => TemperaCompositionSpec>
> = {
  'monogatari-card': monogatariCard,
  'monogatari-rule': monogatariRule,
  'monogatari-edge': monogatariEdge,
  'monogatari-stack': monogatariStack,
  'monogatari-flash': monogatariFlash,
};

/** monogatari 族；`null` = 这个 kind 不属本族。 */
export function buildTemperaMonogatariComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
): TemperaCompositionSpec | null {
  const builder = MONOGATARI_BUILDERS[kind];
  return builder === undefined ? null : builder(seed, viewport, bleed);
}
