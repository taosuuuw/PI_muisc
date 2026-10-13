/**
 * 商籁引导线的**几何层**：把 `sonnetGuides.ts` 算出的"这一帧该画什么"进一步折算成
 * **可以直接下笔的图元**（折线段 + 圆点 + 圆环），**不引用 Pixi、不碰 DOM** ✓。
 *
 * 为什么拆这一层：上游是在 `Graphics` 上边算边画；我们这边把"算"与"画"分开 ——
 * 这样几何层可以**单独单测**（手算坐标），渲染层只剩"把数组喂给 Graphics"这一件事 ✓。
 *
 * === 四件装饰都按上游的 `update(progress)` 做成动态 ===
 * ① **星轨**：沿贝塞尔画 `i / steps × drawProgress` 段 ⇒ 头在贝塞尔上走，不是钉在原点；
 * ② **丝线**（S 曲线 / 交叉 ribbon）：`headT/tailT` 滑动区间，只画中间那段有限尾段，
 *    渐细渐亮 + 头部圆 + 白芯 + 外圈 **follow circle**（`rings`）；
 * ③ **矩形 spline**：头从 `p0` 长到 `p1`、尾再追上来 ⇒ 是"生长"而不是一次性摆一根棍，外加白亮芯；
 * ④ **碎屑**：向外爆开。
 *
 * 上游"何时画、画到几分"的判定在 `sonnetGuides.ts`（纯函数、可测 ✓），这里只管**图元** ✓。
 * 随机源在 `sonnetGuides.ts` 已确定性化（`createSonnetRandomStream`）⇒ 同一时刻同一画面 ✓。
 */

import {
  SONNET_GUIDE_SPLINE_CORE_ALPHA,
  SONNET_GUIDE_SPLINE_CORE_SCALE,
  SONNET_GUIDE_SPLINE_GROW_SCALE,
  SONNET_GUIDE_SPLINE_LINGER,
  SONNET_GUIDE_SPLINE_TAIL_LAG,
  SONNET_GUIDE_THREAD_ALPHA_SCALE,
  SONNET_GUIDE_THREAD_CORE_RADIUS_ACCENT,
  SONNET_GUIDE_THREAD_CORE_RADIUS_SUPPORT,
  SONNET_GUIDE_THREAD_HEAD_ALPHA,
  SONNET_GUIDE_THREAD_HEAD_RADIUS_ACCENT,
  SONNET_GUIDE_THREAD_HEAD_RADIUS_SUPPORT,
  SONNET_GUIDE_THREAD_LINGER,
  SONNET_GUIDE_THREAD_PRE_ROLL,
  SONNET_GUIDE_THREAD_RING_ALPHA,
  SONNET_GUIDE_THREAD_RING_RADIUS_ACCENT,
  SONNET_GUIDE_THREAD_RING_RADIUS_SUPPORT,
  SONNET_GUIDE_THREAD_RING_WIDTH_ACCENT,
  SONNET_GUIDE_THREAD_RING_WIDTH_SUPPORT,
  SONNET_GUIDE_THREAD_SPAN,
  SONNET_GUIDE_THREAD_STEPS,
  SONNET_GUIDE_THREAD_TAIL,
  SONNET_GUIDE_TRAIL_STEPS,
  clamp01,
  resolveSonnetGuideBurst,
  resolveSonnetGuideDrawProgress,
  resolveSonnetGuideFade,
  resolveSonnetGuideIntensity,
  type SonnetGuideFrame,
  type SonnetGuidePoint,
} from './sonnetGuides';

/** 一段**折线**：`points` 是扁平的 `[x0,y0,x1,y1,…]`（坐标原点 = 该引导线的锚点）✓。 */
export interface SonnetGuideStroke {
  readonly points: readonly number[];
  readonly width: number;
  readonly alpha: number;
  /** 主角用强调色、否则用次色（渲染层据此选色）✓。 */
  readonly accent: boolean;
  /**
   * **白亮芯**（上游丝线与矩形 spline 各画一条纯白细线 ✓）。
   * 主题层不管色板、直接上白 ⇒ 这一位必须在数据里说清。
   */
  readonly core: boolean;
}

/** 一个**实心圆点**（头部发光点、丝线头、碎屑里的圆）✓。 */
export interface SonnetGuideDisc {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly alpha: number;
  /** 白色 = 上游那些"内芯高光"（不随主题色变）✓。 */
  readonly white: boolean;
  readonly accent: boolean;
}

/**
 * 一个**描边圆环**（上游丝线头部那圈"跟手环" `follow circle` ✓）。
 *
 * 它和 `discs` 分开：上游那一笔是 `stroke` 而不是 `fill` ✓ ——
 * 之前没有这一位时，"外圈"只能当实心圆画，观感是**一坨**而不是**一圈** ✗。
 */
export interface SonnetGuideRing {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly width: number;
  readonly alpha: number;
  readonly accent: boolean;
}

/** 一个**小多边形**（碎屑里的方块/十字/菱形；`points` 同样是扁平数组）✓。 */
export interface SonnetGuideShapeDraw {
  readonly points: readonly number[];
  readonly alpha: number;
  readonly accent: boolean;
  readonly rotation: number;
}

export interface SonnetGuideGeometry {
  readonly strokes: readonly SonnetGuideStroke[];
  readonly discs: readonly SonnetGuideDisc[];
  readonly rings: readonly SonnetGuideRing[];
  readonly shapes: readonly SonnetGuideShapeDraw[];
}

/** 三次贝塞尔在 `t` 处的点（上游 `getBezier` 的同一取法 ✓）。 */
function cubicAt(
  p0: SonnetGuidePoint,
  p1: SonnetGuidePoint,
  p2: SonnetGuidePoint,
  p3: SonnetGuidePoint,
  t: number,
): { x: number; y: number } {
  const inverse = 1 - t;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * t;
  const c = 3 * inverse * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * 把一段贝塞尔按 `steps` 等分、只取 `[fromT, toT]` 区间，逐段出折线 ✓。
 *
 * `intensity = (i / steps)²`（越靠头部越亮 ✓）、宽度与 alpha 由调用方给的函数算 ✓ ——
 * 这是上游**星轨**与**丝线**共用的画法（两处只是宽度/alpha 公式不同 ✓）。
 */
function sampleCurve(
  curve: readonly [SonnetGuidePoint, SonnetGuidePoint, SonnetGuidePoint, SonnetGuidePoint],
  fromT: number,
  toT: number,
  steps: number,
  widthAt: (intensity: number) => number,
  alphaAt: (intensity: number) => number,
  accent: boolean,
  core: boolean,
  out: SonnetGuideStroke[],
): void {
  if (!(toT > fromT)) return;
  let previous = cubicAt(curve[0], curve[1], curve[2], curve[3], fromT);
  for (let index = 1; index <= steps; index += 1) {
    const intensity = resolveSonnetGuideIntensity(index, steps);
    const stepT = fromT + (index / steps) * (toT - fromT);
    const point = cubicAt(curve[0], curve[1], curve[2], curve[3], stepT);
    const alpha = alphaAt(intensity);
    if (alpha > 0) {
      out.push({
        points: [previous.x, previous.y, point.x, point.y],
        width: widthAt(intensity),
        alpha,
        accent,
        core,
      });
    }
    previous = point;
  }
}

/** 淡出小于这个值就当作"已经没了"（浮点边界，理由见 `resolveSonnetGuideGeometry` 内的注释）✓。 */
const SONNET_GUIDE_FADE_EPSILON = 1e-6;

/**
 * 一帧引导线的**图元清单**（注意：全部坐标都是**相对锚点**的，渲染层把节点放到 `anchorX/anchorY` 即可）✓。
 */
export function resolveSonnetGuideGeometry(guide: SonnetGuideFrame): SonnetGuideGeometry {
  const { plan, progress } = guide;
  const fade = resolveSonnetGuideFade(progress);
  /*
   * **浮点边界**（用例抓到的真事）：`progress = 0.7` 时 `(0.7 − 0.4) / 0.3` 在二进制里是 `0.9999999999999998`，
   * 于是 `fade` 是 `2.2e-16` 而不是 `0` —— 直接判 `fade <= 0` 会**继续画一堆肉眼看不见的图元** ✗。
   * 所以这里把"小到看不见"统一按 0 处理 ✓（同一条理由也适用于上游：它同样会画出这些零 alpha 图元，
   * 只是 Pixi 那边看不出来；我们显式归零，省下每帧几十个无用的 `stroke` 调用 ✓）。
   */
  if (fade <= SONNET_GUIDE_FADE_EPSILON) {
    return { strokes: [], discs: [], rings: [], shapes: [] };
  }

  const strokeAlpha = plan.strokeAlpha;
  const accent = plan.accent;
  /*
   * **画到几分**（上游 `drawProgress = min(1, max(0, progress / 0.35))`）：
   * 只有领头那一段跟着 `drawProgress` 走（头在贝塞尔上移动），不是一开场就把整条画满。
   */
  const draw = resolveSonnetGuideDrawProgress(progress);
  const burst = resolveSonnetGuideBurst(progress);

  /* --- 星轨：从入场点扫到 `drawProgress`（**头在动** ✓） --- */
  const strokes: SonnetGuideStroke[] = [];
  const origin: SonnetGuidePoint = { x: 0, y: 0 };
  const trailAlphaAt = (intensity: number): number =>
    Math.min(1, intensity * strokeAlpha * fade * 1.6);
  const trailWidthAt = (intensity: number): number =>
    (accent ? 2.5 : 1.5) + intensity * (accent ? 5 : 3);
  sampleCurve(
    [plan.curve[0], plan.curve[1], plan.curve[2], origin],
    0,
    draw,
    SONNET_GUIDE_TRAIL_STEPS,
    trailWidthAt,
    trailAlphaAt,
    accent,
    false,
    strokes,
  );

  const discs: SonnetGuideDisc[] = [];
  const rings: SonnetGuideRing[] = [];
  /* --- 星轨头部：外圆（主题色）+ 内白圆，落在**贝塞尔上当前那一点** ✓ --- */
  const head = cubicAt(plan.curve[0], plan.curve[1], plan.curve[2], origin, draw);
  if (draw > 0) {
    discs.push({
      x: head.x,
      y: head.y,
      radius: accent ? 14 : 9,
      alpha: 0.5 * fade,
      white: false,
      accent,
    });
    discs.push({
      x: head.x,
      y: head.y,
      radius: accent ? 4.5 : 3,
      alpha: fade,
      white: true,
      accent,
    });
  }

  /*
   * --- 丝线轨迹（S 曲线 / 交叉 ribbon）：**只画 headT→tailT 那一段有限尾段** ✓ ---
   *
   * 上游逐行：`localProg = (progress − delay) / 0.55`；只在 `localProg > −0.15` 且 `fadeOut > 0` 时算；
   * `headT = min(1, localProg)`、`tailT = max(0, localProg − 0.35)`（彗尾长度 ✓）；
   * 只有 `headT > tailT` 才画线；头部圆与 follow circle 只在 `0 < headT < 1` 时画 ✓。
   */
  for (const trail of plan.threads) {
    const localProgress = (progress - trail.delay) / SONNET_GUIDE_THREAD_SPAN;
    if (!(localProgress > -SONNET_GUIDE_THREAD_PRE_ROLL)) continue;
    if (!(localProgress < SONNET_GUIDE_THREAD_LINGER)) continue;
    const headT = Math.min(1, localProgress);
    const tailT = Math.max(0, localProgress - SONNET_GUIDE_THREAD_TAIL);
    if (headT > tailT) {
      sampleCurve(
        trail.curve,
        tailT,
        headT,
        SONNET_GUIDE_THREAD_STEPS,
        (intensity) => (accent ? 2 : 1) + intensity * (accent ? 5 : 2.5),
        (intensity) => intensity * strokeAlpha * fade * SONNET_GUIDE_THREAD_ALPHA_SCALE,
        accent,
        false,
        strokes,
      );
    }
    if (headT > 0 && headT < 1) {
      const headPosition = cubicAt(trail.curve[0], trail.curve[1], trail.curve[2], trail.curve[3], headT);
      discs.push({
        x: headPosition.x,
        y: headPosition.y,
        radius: accent ? SONNET_GUIDE_THREAD_HEAD_RADIUS_ACCENT : SONNET_GUIDE_THREAD_HEAD_RADIUS_SUPPORT,
        alpha: SONNET_GUIDE_THREAD_HEAD_ALPHA * fade,
        white: false,
        accent,
      });
      discs.push({
        x: headPosition.x,
        y: headPosition.y,
        radius: accent ? SONNET_GUIDE_THREAD_CORE_RADIUS_ACCENT : SONNET_GUIDE_THREAD_CORE_RADIUS_SUPPORT,
        alpha: fade,
        white: true,
        accent,
      });
      /* 外圈"跟手环"（上游 `graphics.circle(...).stroke(...)` ⇒ 描边而不是实心 ✓）。 */
      rings.push({
        x: headPosition.x,
        y: headPosition.y,
        radius: accent ? SONNET_GUIDE_THREAD_RING_RADIUS_ACCENT : SONNET_GUIDE_THREAD_RING_RADIUS_SUPPORT,
        width: accent ? SONNET_GUIDE_THREAD_RING_WIDTH_ACCENT : SONNET_GUIDE_THREAD_RING_WIDTH_SUPPORT,
        alpha: SONNET_GUIDE_THREAD_RING_ALPHA * fade,
        accent,
      });
    }
  }

  /* --- 矩形 spline：头先长出去、尾再追上来（**生长** ✓），外加一条白亮芯 ✓ --- */
  const spline = plan.spline;
  if (spline !== null) {
    const localProgress = (progress - spline.delay) / spline.duration;
    if (localProgress > 0 && localProgress < SONNET_GUIDE_SPLINE_LINGER) {
      const headT = clamp01(localProgress * SONNET_GUIDE_SPLINE_GROW_SCALE);
      const tailT = clamp01((localProgress - SONNET_GUIDE_SPLINE_TAIL_LAG) * SONNET_GUIDE_SPLINE_GROW_SCALE);
      if (headT > tailT) {
        const endX = spline.originX + Math.cos(spline.angle) * spline.length;
        const endY = spline.originY + Math.sin(spline.angle) * spline.length;
        const headX = spline.originX + (endX - spline.originX) * headT;
        const headY = spline.originY + (endY - spline.originY) * headT;
        const tailX = spline.originX + (endX - spline.originX) * tailT;
        const tailY = spline.originY + (endY - spline.originY) * tailT;
        strokes.push({
          points: [tailX, tailY, headX, headY],
          width: spline.thickness,
          alpha: strokeAlpha * fade * 0.7,
          accent,
          core: false,
        });
        strokes.push({
          points: [tailX, tailY, headX, headY],
          width: spline.thickness * SONNET_GUIDE_SPLINE_CORE_SCALE,
          alpha: strokeAlpha * fade * SONNET_GUIDE_SPLINE_CORE_ALPHA,
          accent,
          core: true,
        });
      }
    }
  }

  /* --- 碎屑：圆 / 方块 / 十字 / 菱形，向外爆开（**追加在最后** ⇒ 前面的顺序恒为"星轨头 → 丝线头" ✓） --- */
  const shapes: SonnetGuideShapeDraw[] = [];
  const splashDiscs: SonnetGuideDisc[] = [];
  const ease = 1 - Math.pow(1 - burst, 3);
  for (const shape of plan.shapes) {
    const distance = shape.speed * ease;
    const x = Math.cos(shape.angle) * distance;
    const y = Math.sin(shape.angle) * distance;
    const scale = 1 - burst * 0.4;
    const alpha = (1 - burst) * shape.alpha;
    if (alpha <= 0) continue;
    if (shape.kind === 'circle') {
      splashDiscs.push({ x, y, radius: shape.size * scale, alpha, white: false, accent });
      continue;
    }
    const size = shape.size * scale;
    const rotation = shape.rotationSpeed * burst;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const corners: ReadonlyArray<readonly [number, number]> =
      shape.kind === 'diamond'
        ? [
            [0, -size],
            [size, 0],
            [0, size],
            [-size, 0],
          ]
        : shape.kind === 'rect'
          ? [
              [-size, -size],
              [size, -size],
              [size, size],
              [-size, size],
            ]
          : [
              [0, -size],
              [0, size],
              [-size * 0.22, 0],
              [size * 0.22, 0],
            ];
    const points: number[] = [];
    for (const [cornerX, cornerY] of corners) {
      points.push(x + cornerX * cos - cornerY * sin, y + cornerX * sin + cornerY * cos);
    }
    shapes.push({ points, alpha, accent, rotation });
  }

  /*
   * 碎屑的圆**统一追加在最后** ✓ —— 这样 `discs` 里的顺序恒为
   * "星轨头（2 个，若有）→ 每条丝线的头（主题色圆 + 白芯）→ 碎屑的圆"，
   * `discs.length − splashDiscs.length` 就是"头"那几个 ✓（用例据此把两者分开数 ✓）。
   */
  discs.push(...splashDiscs);

  return { strokes, discs, rings, shapes };
}

/** 只给测试与渲染层用的边界：这一帧到底有没有东西可画 ✓。 */
export function hasSonnetGuideGeometry(geometry: SonnetGuideGeometry): boolean {
  return (
    geometry.strokes.length > 0 ||
    geometry.discs.length > 0 ||
    geometry.rings.length > 0 ||
    geometry.shapes.length > 0
  );
}

/** 进度夹取（渲染层偶尔会传入超出 [0,1] 的插值结果）✓。 */
export const clampSonnetGuideProgress = clamp01;
