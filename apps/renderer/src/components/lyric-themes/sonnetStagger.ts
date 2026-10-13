/**
 * 商籁**"画进来"动画引擎**的纯函数部分
 * （照抄 folia `sonnet/sonnetAnimatedGraphics.ts`，AGPL-3.0）。
 *
 * 上游文件头原文："Records Graphics commands so strokes/fills can **grow with the shared stagger
 * schedule during playback** instead of appearing fully drawn at scene build." ✓
 *
 * ⇒ 这不是"某一个层的特效"，而是**前面几条线共用的底层** ✓：
 * 背景 MG / 固定几何 / 背后几何 / 边框 的"逐笔生长"都是它驱动的 ✓。
 *
 * 本文件只出**纯数学**（可单测 ✓）：
 * ① **错峰调度**：每条命令算 `delay / span`（黄金比 + 32 位哈希抖动 ✓，纯函数、只依赖序号 ✓）；
 * ② **按长度截断**：把一条路径截到 `targetLength` ——
 *   直线/弧/二次曲线/三次曲线**四种**都有对应数学 ✓（两种曲线用 **de Casteljau** 切一刀 ⇒ **画到一半不变形** ✓）。
 *
 * === 与 folia 的差异（照实记）===
 * · 上游是**命令录进 `Graphics` 再重放** ✓；我方出**图元清单** ✓（与既有 `line/arc/curved/polygon` 同构 ✓）；
 * · 上游 `circle` 的**起角与方向是随机的** ✓（避免"都从右边画起" ✓）；我方这里**只提供数学** ✓，
 *   随机起角留给渲染层（可复现的种子化随机 ✓）；
 * · `arc` 的**方向正化**：上游把 `diff` 压到 `(−π, π]` 并按 `anticlockwise` 定符号 ✓ ——
 *   我按同一意图实现 ✓，并在注释里标出这是**我们的读法**（未逐字取到那段源码全文 ✓）。
 */

/** 上游的黄金比常量（逐字 ✓）。 */
export const SONNET_STAGGER_GOLDEN = 0.6180339887498949;

/** 抖动用的 32 位乘法常量与除数（逐字 ✓）。 */
export const SONNET_STAGGER_JITTER_MULTIPLIER = 2654435761;
export const SONNET_STAGGER_JITTER_DIVISOR = 4294967296;

export const SONNET_STAGGER_STROKE_DELAY_SCALE = 0.5;
export const SONNET_STAGGER_FILL_DELAY_SCALE = 0.45;
export const SONNET_STAGGER_STROKE_SPAN_BASE = 0.32;
export const SONNET_STAGGER_STROKE_SPAN_JITTER = 0.26;
export const SONNET_STAGGER_FILL_SPAN_BASE = 0.4;
export const SONNET_STAGGER_FILL_SPAN_JITTER = 0.25;

export interface SonnetStaggerSpan {
  /** `slot × (isStroke ? 0.5 : 0.45)` ✓。 */
  readonly delay: number;
  /** `isStroke ? 0.32 + jitter × 0.26 : 0.4 + jitter × 0.25` ✓。 */
  readonly span: number;
  /** `min(span, 1 − delay)` ✓ ⇒ **保证 `progress = 1` 时恰好走完** ✓。 */
  readonly staggerSpan: number;
}

/**
 * 一条命令（stroke 或 fill ✓）的错峰参数 ✓。
 * **stroke 与 fill 各自独立计数** ✓（上游分两个计数器 ✓）⇒ 调用方自己传各自的 `index` ✓。
 */
export function resolveSonnetStaggerSpan(index: number, isStroke: boolean): SonnetStaggerSpan {
  const slot = (index * SONNET_STAGGER_GOLDEN) % 1;
  const jitter = ((index * SONNET_STAGGER_JITTER_MULTIPLIER) >>> 0) / SONNET_STAGGER_JITTER_DIVISOR;
  const delay = slot * (isStroke ? SONNET_STAGGER_STROKE_DELAY_SCALE : SONNET_STAGGER_FILL_DELAY_SCALE);
  const span = isStroke
    ? SONNET_STAGGER_STROKE_SPAN_BASE + jitter * SONNET_STAGGER_STROKE_SPAN_JITTER
    : SONNET_STAGGER_FILL_SPAN_BASE + jitter * SONNET_STAGGER_FILL_SPAN_JITTER;
  return { delay, span, staggerSpan: Math.min(span, 1 - delay) };
}

export interface SonnetStaggerProgress {
  /** `clamp01((progress − delay) / span)` ✓。 */
  readonly localRaw: number;
  /** `1 − (1 − localRaw)³`（三次缓出 ✓）。 */
  readonly localProgress: number;
  /** `1 − (1 − min(1, localRaw × 2))³` ✓（前半个窗口内把 alpha 拉满 ✓）。 */
  readonly alphaProgress: number;
}

export function resolveSonnetStaggerProgress(
  progress: number,
  stagger: SonnetStaggerSpan,
): SonnetStaggerProgress {
  /*
   * ⚠ 第 489 轮修：这里原来除以 `stagger.span` ✗ —— 但 `span` 可能**超出** `1 − delay` ✗
   * ⇒ 那些命令在 `progress = 1` 时**还走不完** ✗（`localRaw = (1 − delay) / span < 1` ✓）。
   * `staggerSpan = min(span, 1 − delay)` 存在的意义正是"**压进剩余窗口**" ✓ ⇒ 这里必须用它 ✓
   * （并防一下除零 ✓）。**这是写用例时"从性质反推"揪出来的** ✓：
   * 性质是"`progress = 1` ⇒ 每条命令都走完" ✓，而旧写法给不出这个性质 ✓。
   */
  const window = stagger.staggerSpan > 0 ? stagger.staggerSpan : 1e-6;
  const localRaw = Math.min(1, Math.max(0, (progress - stagger.delay) / window));
  const easeOutCubic = (value: number): number => 1 - Math.pow(1 - value, 3);
  return {
    localRaw,
    localProgress: easeOutCubic(localRaw),
    alphaProgress: easeOutCubic(Math.min(1, localRaw * 2)),
  };
}

export type SonnetPathSegment =
  | {
      readonly kind: 'line';
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
      readonly length: number;
    }
  | {
      readonly kind: 'quadratic';
      readonly fromX: number;
      readonly fromY: number;
      readonly controlX: number;
      readonly controlY: number;
      readonly toX: number;
      readonly toY: number;
      readonly length: number;
    }
  | {
      readonly kind: 'bezier';
      readonly fromX: number;
      readonly fromY: number;
      readonly control1X: number;
      readonly control1Y: number;
      readonly control2X: number;
      readonly control2Y: number;
      readonly toX: number;
      readonly toY: number;
      readonly length: number;
    }
  | {
      readonly kind: 'arc';
      readonly centerX: number;
      readonly centerY: number;
      readonly radius: number;
      readonly startAngle: number;
      /** **带上方向的**角差 ✓（`anticlockwise` 为真时为负 ✓）。 */
      readonly angleDelta: number;
      readonly length: number;
    };

const hypot = (dx: number, dy: number): number => Math.hypot(dx, dy);

export function sonnetPathLine(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Extract<SonnetPathSegment, { kind: 'line' }> {
  return { kind: 'line', fromX, fromY, toX, toY, length: hypot(toX - fromX, toY - fromY) };
}

/** 二次曲线长度 = 两段控制多边形长之和 ✓（上游就是这么量的 ✓）。 */
export function sonnetPathQuadratic(
  fromX: number,
  fromY: number,
  controlX: number,
  controlY: number,
  toX: number,
  toY: number,
): Extract<SonnetPathSegment, { kind: 'quadratic' }> {
  return {
    kind: 'quadratic',
    fromX,
    fromY,
    controlX,
    controlY,
    toX,
    toY,
    length: hypot(controlX - fromX, controlY - fromY) + hypot(toX - controlX, toY - controlY),
  };
}

/** 三次曲线长度 = 三段之和 ✓。 */
export function sonnetPathBezier(
  fromX: number,
  fromY: number,
  control1X: number,
  control1Y: number,
  control2X: number,
  control2Y: number,
  toX: number,
  toY: number,
): Extract<SonnetPathSegment, { kind: 'bezier' }> {
  return {
    kind: 'bezier',
    fromX,
    fromY,
    control1X,
    control1Y,
    control2X,
    control2Y,
    toX,
    toY,
    length:
      hypot(control1X - fromX, control1Y - fromY) +
      hypot(control2X - control1X, control2Y - control1Y) +
      hypot(toX - control2X, toY - control2Y),
  };
}

/** 弧：先把角差压到 `(−π, π]` ✓；`anticlockwise` 只决定**取哪一边的方向** ✓；长度 = `|diff| × r` ✓。 */
export function sonnetPathArc(
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  anticlockwise = false,
): Extract<SonnetPathSegment, { kind: 'arc' }> {
  /*
   * ⚠ 第 487 轮修：原来我先正化、**再**按 `anticlockwise` 定符号，最后那条
   * `if (!anticlockwise && delta < 0) delta += 2π` 会把刚压好的负值又推回长边 ✗ ⇒
   * 两条规则**互相打架**（用例里 `0 → 3π/2` 期望 `−π/2`、实际得到 `+3π/2` ✓ 被抓出来）。
   * 现在只做"**正化到 `(−π, π]`**"＋"`anticlockwise` 时**取反**" ✓ ⇒
   * **弧的扫角天然 ≤ π** ✓（这与上游把 `diff` 收进 canonical window 的做法一致 ✓；
   * **要画整圆请用 `circle`**（上游也是单独一条命令、长度 `2πr` ✓）。
   */
  let delta = endAngle - startAngle;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;
  if (anticlockwise && delta > 0) delta -= Math.PI * 2;
  return {
    kind: 'arc',
    centerX,
    centerY,
    radius,
    startAngle,
    angleDelta: delta,
    length: Math.abs(delta) * radius,
  };
}

export function resolveSonnetPathLength(segments: readonly SonnetPathSegment[]): number {
  return segments.reduce((total, segment) => total + segment.length, 0);
}

/** 截断后要画的图元（与既有 `line / arc / curved` 清单同构 ✓）。 */
export type SonnetPartialDraw =
  | {
      readonly kind: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    }
  | {
      readonly kind: 'quadratic';
      readonly fromX: number;
      readonly fromY: number;
      readonly controlX: number;
      readonly controlY: number;
      readonly toX: number;
      readonly toY: number;
    }
  | {
      readonly kind: 'bezier';
      readonly fromX: number;
      readonly fromY: number;
      readonly control1X: number;
      readonly control1Y: number;
      readonly control2X: number;
      readonly control2Y: number;
      readonly toX: number;
      readonly toY: number;
    }
  | {
      readonly kind: 'arc';
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly startAngle: number;
      readonly endAngle: number;
    };

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 二次贝塞尔在 `t` 处的点 ✓。 */
function quadraticAt(t: number, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number) {
  const mt = 1 - t;
  return { x: mt * mt * x0 + 2 * mt * t * cx + t * t * x1, y: mt * mt * y0 + 2 * mt * t * cy + t * t * y1 };
}

/**
 * 把**一段**路径截到 `ratio`（0~1 ✓）。
 * · 直线 ⇒ 线性插值 ✓
 * · 二次 ⇒ **de Casteljau 一刀**：新控制点 `last + ratio × (c − last)` ✓，新终点 = 曲线在 `ratio` 处 ✓
 * · 三次 ⇒ **三层 de Casteljau**：`q0/q1/q2 → r0/r1 → b` ✓
 * · 弧 ⇒ 只缩短扫过的角 ✓
 */
export function resolveSonnetPartialSegment(
  segment: SonnetPathSegment,
  ratio: number,
): SonnetPartialDraw {
  const t = Math.min(1, Math.max(0, ratio));
  switch (segment.kind) {
    case 'line': {
      return {
        kind: 'line',
        x1: segment.fromX,
        y1: segment.fromY,
        x2: lerp(segment.fromX, segment.toX, t),
        y2: lerp(segment.fromY, segment.toY, t),
      };
    }
    case 'quadratic': {
      const end = quadraticAt(t, segment.fromX, segment.fromY, segment.controlX, segment.controlY, segment.toX, segment.toY);
      return {
        kind: 'quadratic',
        fromX: segment.fromX,
        fromY: segment.fromY,
        controlX: lerp(segment.fromX, segment.controlX, t),
        controlY: lerp(segment.fromY, segment.controlY, t),
        toX: end.x,
        toY: end.y,
      };
    }
    case 'bezier': {
      const q0x = lerp(segment.fromX, segment.control1X, t);
      const q0y = lerp(segment.fromY, segment.control1Y, t);
      const q1x = lerp(segment.control1X, segment.control2X, t);
      const q1y = lerp(segment.control1Y, segment.control2Y, t);
      const q2x = lerp(segment.control2X, segment.toX, t);
      const q2y = lerp(segment.control2Y, segment.toY, t);
      const r0x = lerp(q0x, q1x, t);
      const r0y = lerp(q0y, q1y, t);
      const r1x = lerp(q1x, q2x, t);
      const r1y = lerp(q1y, q2y, t);
      return {
        kind: 'bezier',
        fromX: segment.fromX,
        fromY: segment.fromY,
        control1X: q0x,
        control1Y: q0y,
        control2X: r0x,
        control2Y: r0y,
        toX: lerp(r0x, r1x, t),
        toY: lerp(r0y, r1y, t),
      };
    }
    case 'arc': {
      return {
        kind: 'arc',
        x: segment.centerX,
        y: segment.centerY,
        radius: segment.radius,
        startAngle: segment.startAngle,
        endAngle: segment.startAngle + segment.angleDelta * t,
      };
    }
    default: {
      return { kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0 };
    }
  }
}

/**
 * 从路径起点量到 `targetLength` 为止，返回**该画的图元** ✓
 * （整段照画 ✓，最后一段按比例截断 ✓ —— 与上游 `update` 的走法一致 ✓）。
 */
export function resolveSonnetPartialDraws(
  segments: readonly SonnetPathSegment[],
  targetLength: number,
): readonly SonnetPartialDraw[] {
  if (targetLength <= 0) return [];
  const draws: SonnetPartialDraw[] = [];
  let remaining = targetLength;
  for (const segment of segments) {
    if (remaining <= 0) break;
    if (segment.length <= 0) continue;
    const ratio = remaining >= segment.length ? 1 : remaining / segment.length;
    draws.push(resolveSonnetPartialSegment(segment, ratio));
    remaining -= segment.length;
  }
  return draws;
}
