/**
 * 商籁（sonnet）的**引导线 / 定位标记**（照抄 folia `sonnet/sonnetGuides.ts`，AGPL-3.0）。
 *
 * 上游做的是什么：**每个语义段在文字抵达之前，先"画一道引导线 + 抛一把几何碎屑"**，
 * 一路持续到文字入场后 0.65 秒。构成四件：
 * ① 贝塞尔**星轨**（渐细渐亮，头部一个发光点）；② 1~2 条**丝线轨迹**（S 曲线 / 交叉环）；
 * ③ 一个**矩形 spline**（现代 HUD 风）；④ **3~6 个随机小几何**（圆 / 方 / 十字 / 菱形）向外爆开。
 *
 * === 与 folia 的差异（照实记）===
 * 上游这一层用**裸 `Math.random()`**（形状种类、尺寸、角度、延迟、速度全是随机）——
 * **上游自己都不 seek-stable**。本仓库的原则是**确定性 + 拖动进度条可复现**，
 * 所以这里把随机源换成 `sonnetHash01(seed, index, salt)`（`sonnetGeo.ts` 里那份，与上游同式），
 * **数值区间照抄上游**，只是"取值方式"由随机改为按种子确定。
 * ⇒ **这是我们的决定**，不是复刻；登记在 `CREDITS.md`。
 *
 * **丝线 / 交叉 ribbon / 矩形 spline 的精确参数**按上游 `:106~146` 与 `:194~259` 逐点取齐：
 * S 曲线与交叉 ribbon 的控制点、`headT/tailT` 滑动区间（`0.55` 窗口 / `0.35` 彗尾）、
 * 渐细渐亮公式、follow circle 半径，以及矩形 spline 的 `length/thickness/angle/rx/ry/duration`。
 * 上游"按调用次序取随机数"的写法用 `createSonnetRandomStream(seed, salt)` 确定性化
 * （按**调用序号**而不是元素下标取值）。
 *
 * === 本文件只放"算得出、测得动"的部分 ===
 * 纯函数：给定段时长/放置/种子/字号 ⇒ 产出**图元清单**。
 * 真正把它画到屏幕上是渲染层的事（Pixi 或 DOM 都行），不在本文件里。
 */

import { createSonnetRandomStream, sonnetHash01 } from './sonnetGeo';

/* ------------------------------------------------------------------ *
 * 时机
 * ------------------------------------------------------------------ */

export const SONNET_GUIDE_LEAD_BASE = 0.18;
export const SONNET_GUIDE_LEAD_RATIO = 0.1;
export const SONNET_GUIDE_LEAD_MIN = 0.2;
export const SONNET_GUIDE_LEAD_MAX = 0.38;
/** 文字入场之后还留多久（上游注释：让装饰"爆开并淡出"）。 */
export const SONNET_GUIDE_TAIL = 0.65;

export interface SonnetGuideCue {
  readonly startTime: number;
  readonly endTime: number;
}

/**
 * 引导线的存活窗口（照抄上游 `resolveSonnetGuideCue`）：
 * `leadDuration = clamp(0.18 + 段时长 × 0.1, 0.2, 0.38)`；
 * 起点在**文字起点之前** `leadDuration`，终点在文字起点之后 `0.65s`。
 */
export function resolveSonnetGuideCue(
  segmentStartTime: number,
  segmentEndTime: number,
  textStartTime = segmentStartTime,
): SonnetGuideCue {
  const span = Math.max(0, segmentEndTime - segmentStartTime);
  const leadDuration = Math.min(
    SONNET_GUIDE_LEAD_MAX,
    Math.max(SONNET_GUIDE_LEAD_MIN, SONNET_GUIDE_LEAD_BASE + span * SONNET_GUIDE_LEAD_RATIO),
  );
  return { startTime: textStartTime - leadDuration, endTime: textStartTime + SONNET_GUIDE_TAIL };
}

/* ------------------------------------------------------------------ *
 * 几何与进度包络
 * ------------------------------------------------------------------ */

/** 星轨分段数（上游画 20 段，`intensity = (i / steps)²`）。 */
export const SONNET_GUIDE_TRAIL_STEPS = 20;
/** 丝线分段数（上游画 25 段）。 */
export const SONNET_GUIDE_THREAD_STEPS = 25;
/** 丝线彗尾长度（上游 `tailT = max(0, localProg − 0.35)`）。 */
export const SONNET_GUIDE_THREAD_TAIL = 0.35;
/** 丝线的进度窗口（上游 `localProg = (progress − delay) / 0.55`）。 */
export const SONNET_GUIDE_THREAD_SPAN = 0.55;
/** 丝线的**起始触发判据**（上游 `localProg > −0.15` 才开始算"在窗口里" ✓）。 */
export const SONNET_GUIDE_THREAD_PRE_ROLL = 0.15;
/** 丝线在 `localProg` 到达这个值之后就**不再画了**（上游 `< 1.3` ✓）。 */
export const SONNET_GUIDE_THREAD_LINGER = 1.3;

/** 矩形 spline 的**生长倍数**与**收缩倍数**（上游 head `× 1.5`、tail `(localProg − 0.3) × 1.5` ✓）。 */
export const SONNET_GUIDE_SPLINE_GROW_SCALE = 1.5;
export const SONNET_GUIDE_SPLINE_TAIL_LAG = 0.3;
/** 矩形 spline 的 linger 上限（上游 `< 1.3` ✓）。 */
export const SONNET_GUIDE_SPLINE_LINGER = 1.3;
/** 矩形 spline 亮芯的粗细倍率与透明度（上游 `thickness × 0.3`、`strokeAlpha × fade × 0.9` ✓）。 */
export const SONNET_GUIDE_SPLINE_CORE_SCALE = 0.3;
export const SONNET_GUIDE_SPLINE_CORE_ALPHA = 0.9;
/** 丝线亮芯的粗细倍率与透明度（上游 `intensity × strokeAlpha × fadeOut × 0.9` ✓）。 */
export const SONNET_GUIDE_THREAD_ALPHA_SCALE = 0.9;
/** follow circle（外圈"跟手环"）的粗细倍率（上游 `isHero ? 2 : 1` ✓）。 */
export const SONNET_GUIDE_THREAD_RING_WIDTH_ACCENT = 2;
export const SONNET_GUIDE_THREAD_RING_WIDTH_SUPPORT = 1;
/** follow circle 的半径（上游 `isHero ? 20 : 12`）与透明度（上游 `0.4 × fadeOut`）✓。 */
export const SONNET_GUIDE_THREAD_RING_RADIUS_ACCENT = 20;
export const SONNET_GUIDE_THREAD_RING_RADIUS_SUPPORT = 12;
export const SONNET_GUIDE_THREAD_RING_ALPHA = 0.4;
/** 丝线头部的主题色圆/白芯半径（上游 `isHero ? 7 : 4` 与 `isHero ? 2.5 : 1.5` ✓）。 */
export const SONNET_GUIDE_THREAD_HEAD_RADIUS_ACCENT = 7;
export const SONNET_GUIDE_THREAD_HEAD_RADIUS_SUPPORT = 4;
export const SONNET_GUIDE_THREAD_CORE_RADIUS_ACCENT = 2.5;
export const SONNET_GUIDE_THREAD_CORE_RADIUS_SUPPORT = 1.5;
/** 丝线头部圆与白芯的透明度（上游 `0.9 × fadeOut` 与 `1 × fadeOut` ✓）。 */
export const SONNET_GUIDE_THREAD_HEAD_ALPHA = 0.9;

/** 引导线画多快画完（上游 `progress / 0.35`）。 */
export const SONNET_GUIDE_DRAW_PORTION = 0.35;
/** 淡出从 `progress = 0.4` 开始、到 `0.7` 结束（上游 `(progress − 0.4) / 0.3`）。 */
export const SONNET_GUIDE_FADE_START = 0.4;
export const SONNET_GUIDE_FADE_SPAN = 0.3;
/** 碎屑爆开从 `progress = 0.3` 起、到 `1` 结束。 */
export const SONNET_GUIDE_BURST_START = 0.3;

export const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 主笔的描边参数（照抄上游 `strokeProps`）。 */
export const resolveSonnetGuideStroke = (accent: boolean): { width: number; alpha: number } => ({
  width: accent ? 1.8 : 1,
  alpha: accent ? 0.82 : 0.55,
});

/** 引导线整体上限 alpha（照抄上游返回值 `maxAlpha`）。 */
export const resolveSonnetGuideMaxAlpha = (accent: boolean): number => (accent ? 0.95 : 0.7);

/** 画出多少（`progress / 0.35`，夹 0~1）。 */
export const resolveSonnetGuideDrawProgress = (progress: number): number =>
  clamp01(progress / SONNET_GUIDE_DRAW_PORTION);

/** 淡出系数（`1 − clamp((progress − 0.4) / 0.3)`，夹 0~1）。 */
export const resolveSonnetGuideFade = (progress: number): number =>
  1 - clamp01((progress - SONNET_GUIDE_FADE_START) / SONNET_GUIDE_FADE_SPAN);

/** 碎屑爆开进度（`clamp((progress − 0.3) / 0.7)`）。 */
export const resolveSonnetGuideBurst = (progress: number): number =>
  clamp01((progress - SONNET_GUIDE_BURST_START) / (1 - SONNET_GUIDE_BURST_START));

/** 分段强度（`(i / steps)²`）——星轨与丝线共用这条"越靠近头部越亮"的曲线。 */
export const resolveSonnetGuideIntensity = (index: number, steps: number): number => {
  const ratio = steps <= 0 ? 0 : index / steps;
  return ratio * ratio;
};

/* ------------------------------------------------------------------ *
 * 图元清单
 * ------------------------------------------------------------------ */

export interface SonnetGuidePoint {
  readonly x: number;
  readonly y: number;
}

/** 爆开的小几何：`kind` 顺序与上游的 0~3 分支一致（圆 / 方 / 十字 / 菱形）。 */
export type SonnetGuideShapeKind = 'circle' | 'rect' | 'cross' | 'diamond';

export interface SonnetGuideShape {
  readonly kind: SonnetGuideShapeKind;
  readonly size: number;
  readonly alpha: number;
  readonly angle: number;
  readonly speed: number;
  readonly rotationSpeed: number;
}

export interface SonnetGuideThread {
  readonly delay: number;
  /** 上游两条丝线是"一条 S 曲线、一条交叉环"，这里用布尔区分。 */
  readonly loop: boolean;
  /**
   * 丝线的三次贝塞尔控制点（上游 `trackingTrails` 里的 `p0/p1/p2/p3` ✓）。
   *
   * 上游两件装饰（S 曲线 / 交叉 ribbon）靠这四个控制点成形；只留 `delay + loop` 一个布尔
   * 是画不出丝线的（见文件头）。
   */
  readonly curve: readonly [SonnetGuidePoint, SonnetGuidePoint, SonnetGuidePoint, SonnetGuidePoint];
}

export interface SonnetGuideSpline {
  readonly length: number;
  readonly thickness: number;
  readonly angle: number;
  readonly originX: number;
  readonly originY: number;
  readonly duration: number;
  readonly delay: number;
}

export interface SonnetGuidePlan {
  readonly accent: boolean;
  readonly strokeWidth: number;
  readonly strokeAlpha: number;
  readonly startX: number;
  readonly startY: number;
  /** 贝塞尔三点：起点、两个控制点（终点恒为原点）——与本仓库"以中心为原点"的坐标一致。 */
  readonly curve: readonly [SonnetGuidePoint, SonnetGuidePoint, SonnetGuidePoint];
  readonly shapes: readonly SonnetGuideShape[];
  readonly threads: readonly SonnetGuideThread[];
  readonly spline: SonnetGuideSpline | null;
  readonly maxAlpha: number;
}

export interface SonnetGuidePlacement {
  readonly enterX: number;
  readonly enterY: number;
  /** 段在行内的时序相位（0~1）——上游用它决定"从哪一侧入场"。 */
  readonly timingPhase: number;
  readonly emphasis: boolean;
}

/** 上游那几处随机用的盐，各自独立，保证"同一段永远得到同一套装饰"。 */
const SALT_SHAPE_KIND = 401;
const SALT_SHAPE_SIZE = 409;
const SALT_SHAPE_ANGLE = 421;
const SALT_SHAPE_SPEED = 431;
const SALT_SHAPE_ROT = 433;
const SALT_THREAD_ONE = 439;
const SALT_THREAD_TWO = 443;
const SALT_SPLINE = 449;
/*
 * 两条丝线**曲线参数**的 salt。
 * ⚠ 与上面的 `SALT_SPLINE`（449）**必须不同**：那个是旧的"按元素下标"取法，新的 spline 走
 * `createSonnetRandomStream(seed, SALT_SPLINE)`（按调用次序）；同一 seed 下两套散列落在同一个
 * salt 上会互相牵连，改动其中一处会悄悄挪动另一处 ✗。
 */
const SALT_THREAD_CURVE_ONE = 457;
const SALT_THREAD_CURVE_TWO = 461;

/**
 * 把上游那段"建图元"的代码折叠成**数据**：给定种子与放置，算出这一段的装饰清单。
 *
 * 与上游逐项对应的数值：
 * - 起点：`startX = enterX || (±1) × 字号 × 1.8`（符号由 `timingPhase < 0.5` 决定）、`startY = enterY || −字号 × 0.9`；
 * - 贝塞尔控制点：`p1 = (sx×0.6, sy×0.4)`、`p2 = (sx×0.2, sy×0.1)`、终点 `(0,0)`；
 * - 碎屑：个数 主角 6 / 其他 3；尺寸 `(主角 3 / 其他 1.5) + rand×3.5`；`alpha = 主角 0.8 / 其他 0.6`；
 *   `speed = (15 + rand×45) × (主角 1 / 其他 0.7)`、`rotationSpeed = (rand − 0.5) × 8`、
 *   `angle = rand × 2π`；种类 `floor(rand × 4)`；
 * - 丝线：主角必有两条，否则 `rand > 0.4` 出第一条、`rand > 0.6` 出第二条；`delay = rand × 0.15 / 0.1`；
 * - 矩形 spline：`rand > 0.4` 才出现（主角不特殊），参数见 `SonnetGuideSpline` 字段注释。
 */
export function resolveSonnetGuidePlan(
  seed: number,
  placement: SonnetGuidePlacement,
  fontSize: number,
): SonnetGuidePlan {
  const accent = placement.emphasis;
  const stroke = resolveSonnetGuideStroke(accent);
  const direction = placement.timingPhase < 0.5 ? -1 : 1;
  const startX = placement.enterX !== 0 ? placement.enterX : direction * fontSize * 1.8;
  const startY = placement.enterY !== 0 ? placement.enterY : -fontSize * 0.9;

  const shapeCount = accent ? 6 : 3;
  const shapes: SonnetGuideShape[] = [];
  for (let index = 0; index < shapeCount; index += 1) {
    const rand = (salt: number): number => sonnetHash01(seed, index, salt);
    const size = (accent ? 3 : 1.5) + rand(SALT_SHAPE_SIZE) * 3.5;
    const kindIndex = Math.floor(rand(SALT_SHAPE_KIND) * 4);
    const kind: SonnetGuideShapeKind =
      kindIndex === 0 ? 'circle' : kindIndex === 1 ? 'rect' : kindIndex === 2 ? 'cross' : 'diamond';
    shapes.push({
      kind,
      size,
      alpha: accent ? 0.8 : 0.6,
      angle: rand(SALT_SHAPE_ANGLE) * Math.PI * 2,
      speed: (15 + rand(SALT_SHAPE_SPEED) * 45) * (accent ? 1 : 0.7),
      rotationSpeed: (rand(SALT_SHAPE_ROT) - 0.5) * 8,
    });
  }

  /*
   * **丝线与矩形 spline 的随机流**：上游这两件是"按调用次序"各取一个 `Math.random()`，
   * 这里用 `createSonnetRandomStream(seed, salt)` 把同一串数确定性化（见文件头差异说明）。
   *
   * 三条流的 salt 各不相同 ⇒ 互不相关；每条流内部次序固定 ⇒ 同种子逐值一致。
   * 逐项对照上游 `sonnetGuides.ts:106~146`。
   */
  const threads: SonnetGuideThread[] = [];
  /** 第一条：**贴着词左右的 S 曲线**（上游 `Thread 1` ✓）。 */
  if (accent || sonnetHash01(seed, 0, SALT_THREAD_ONE) > 0.4) {
    const stream = createSonnetRandomStream(seed, SALT_THREAD_CURVE_ONE);
    /* 上游次序：`d` → `yOffset` → `delay`（`p1/p2` 由 `d` 与 `yOffset` 推出 ✓）。 */
    const direction = stream.chance(0.5) ? 1 : -1;
    const yOffset = stream.range(-0.5, 0.5) * fontSize * 0.8;
    const delay = stream.range(0, 0.15);
    threads.push({
      loop: false,
      delay,
      curve: [
        { x: -direction * fontSize * 2.5, y: yOffset + fontSize * 1.5 },
        { x: -direction * fontSize * 0.8, y: yOffset - fontSize * 2.0 },
        { x: direction * fontSize * 0.8, y: yOffset + fontSize * 2.0 },
        { x: direction * fontSize * 2.5, y: yOffset - fontSize * 1.5 },
      ],
    });
  }
  /** 第二条：**交叉 ribbon（来回穿插的环）**（上游 `Thread 2` ✓）。 */
  if (accent || sonnetHash01(seed, 1, SALT_THREAD_TWO) > 0.6) {
    const stream = createSonnetRandomStream(seed, SALT_THREAD_CURVE_TWO);
    /* 上游次序：`d` → `delay`（四个控制点里只有 `y` 的符号随 `d` 变 ✓）。 */
    const direction = stream.chance(0.5) ? 1 : -1;
    const delay = stream.range(0, 0.1);
    threads.push({
      loop: true,
      delay,
      curve: [
        { x: -fontSize * 2.0, y: -direction * fontSize * 1.8 },
        { x: fontSize * 2.0, y: direction * fontSize * 1.8 },
        { x: -fontSize * 2.0, y: direction * fontSize * 1.8 },
        { x: fontSize * 2.0, y: -direction * fontSize * 1.8 },
      ],
    });
  }

  /** 矩形 spline：**从文字附近某个随机点、沿随机角一路长出去的粗亮条**（上游 `rectSpline` ✓）。 */
  const splineStream = createSonnetRandomStream(seed, SALT_SPLINE);
  /* 上游次序：先 `> 0.4` 那一次判定 → 再 `length` → `thickness` → `angle` → `rx` → `ry` → `delay` → `duration`。 */
  const hasSpline = splineStream.next() > 0.4;
  let spline: SonnetGuideSpline | null = null;
  if (hasSpline) {
    const length = fontSize * (1.2 + splineStream.range(0, 1) * 1.5);
    const thickness = (accent ? 6 : 3) + splineStream.range(0, 1) * 8;
    const angle = splineStream.range(-0.5, 0.5) * Math.PI;
    const originX = splineStream.range(-0.5, 0.5) * fontSize * 1.2;
    const originY = splineStream.range(-0.5, 0.5) * fontSize * 1.2;
    const delay = splineStream.range(0, 0.15);
    const duration = 0.25 + splineStream.range(0, 1) * 0.2;
    spline = { length, thickness, angle, originX, originY, delay, duration };
  }

  return {
    accent,
    strokeWidth: stroke.width,
    strokeAlpha: stroke.alpha,
    startX,
    startY,
    curve: [
      { x: startX, y: startY },
      { x: startX * 0.6, y: startY * 0.4 },
      { x: startX * 0.2, y: startY * 0.1 },
    ],
    shapes,
    threads,
    spline,
    maxAlpha: resolveSonnetGuideMaxAlpha(accent),
  };
}

/* ------------------------------------------------------------------ *
 * 帧层桥接：把"当前有哪些引导线该画、画到几分"算出来
 * ------------------------------------------------------------------ */

/** 帧层能提供的、算引导线所需的全部信息（都在 `SonnetFrame` 里已有或可推出）。 */
export interface SonnetGuideSegmentTiming {
  readonly segmentStartTime: number;
  readonly segmentEndTime: number;
  /** 文字真正开始入场的时间（上游允许与段起点不同）。 */
  readonly textStartTime: number;
  readonly lineStartTime: number;
  readonly lineEndTime: number;
  readonly enterX: number;
  readonly enterY: number;
  readonly emphasis: boolean;
  /** 这一段的字号（逐段不同 ⇒ 桥接里优先用它，缺省才落回调用方给的统一字号）。 */
  readonly fontSize?: number;
  /** 这一段的屏幕锚点（渲染层把引导线画在这个点上；缺省 0 = 画面中心）。 */
  readonly anchorX?: number;
  readonly anchorY?: number;
}

export interface SonnetGuideFrame {
  /** 段在行内的下标（渲染层用它做池化键）。 */
  readonly index: number;
  /** 在**引导线窗口**内的进度（0~1）。 */
  readonly progress: number;
  readonly cue: SonnetGuideCue;
  readonly plan: SonnetGuidePlan;
  /** 屏幕锚点（这段文字的落点）；渲染层把它当作图元坐标系的原点 ✓。 */
  readonly anchorX: number;
  readonly anchorY: number;
}

/** 每段的种子偏移：同一段永远同一套装饰，不同段互不相关（乘 131 是素数风格，避免相邻段撞拍）。 */
const SONNET_GUIDE_SEED_STRIDE = 131;

/**
 * 当前时刻该画哪些引导线。
 *
 * - **窗口判定**：`timeSec ∈ [段起点 − lead, 文字起点 + 0.65]`（`resolveSonnetGuideCue`）；
 * - **进度**：按**整个窗口**归一（不是按段时长），所以 `progress = 0` 就是"刚开始画" ✓；
 * - **时序相位**：段起点在**行内**的相对位置（决定入场方向 `direction = timingPhase < 0.5 ? −1 : 1`）✓；
 * - **确定性**：种子按段下标错开（`seed + index × 131`）⇒ 拖动进度条回同一时刻得到同一套装饰 ✓。
 */
export function resolveSonnetGuideFrames(
  seed: number,
  segments: readonly SonnetGuideSegmentTiming[],
  fontSize: number,
  timeSec: number,
): readonly SonnetGuideFrame[] {
  const frames: SonnetGuideFrame[] = [];
  segments.forEach((segment, index) => {
    const cue = resolveSonnetGuideCue(
      segment.segmentStartTime,
      segment.segmentEndTime,
      segment.textStartTime,
    );
    if (timeSec < cue.startTime || timeSec > cue.endTime) return;

    const lineSpan = Math.max(0.001, segment.lineEndTime - segment.lineStartTime);
    const timingPhase = clamp01((segment.segmentStartTime - segment.lineStartTime) / lineSpan);
    const windowSpan = Math.max(0.001, cue.endTime - cue.startTime);
    frames.push({
      index,
      progress: clamp01((timeSec - cue.startTime) / windowSpan),
      cue,
      anchorX: segment.anchorX ?? 0,
      anchorY: segment.anchorY ?? 0,
      plan: resolveSonnetGuidePlan(
        seed + index * SONNET_GUIDE_SEED_STRIDE,
        { enterX: segment.enterX, enterY: segment.enterY, timingPhase, emphasis: segment.emphasis },
        segment.fontSize ?? fontSize,
      ),
    });
  });
  return frames;
}
