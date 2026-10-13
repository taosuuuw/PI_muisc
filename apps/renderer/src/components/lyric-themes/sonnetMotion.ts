/**
 * 商籁（sonnet）的**运动/缓动**底座（照抄上游数值的那一层）。
 *
 * 来源：`chthollyphile/folia-major@main` 的
 * `src/components/visualizer/sonnet/sonnetMotion.ts`（AGPL-3.0，只读网页抓取）。
 *
 * === 覆盖范围（第 350~351 轮更正）===
 * ~~旧注释写着"上游那个文件我**只读到头与尾**，中段（`resolveShotPathProgress` 与
 * `resolveShotMotionFrame`）**没有拿到**，所以这里**没有**它们"~~ —— **那是错的**。
 * 本地快照 `.folia-ref/sonnet__sonnetMotion.ts` 里中段就在 `:180~190` 与 `:193~244`，
 * 我们**后来已经照抄实现**（本文件 `:127` / `:151`，都注明了出处）✓。
 * ~~"目前还没有接进渲染"~~ 同样作废：`sonnetFrame.ts` **已经**引入并在每帧调用运镜
 * （`import { … resolveShotMotionFrame } from './sonnetMotion'`，用在逐帧算运镜处）✓。
 *
 * 现在这一层覆盖：贝塞尔缓动、段级入场、装饰深度、陪衬法向偏移、**镜头路径与运镜**、
 * 聚焦权重、手持呼吸、时间轴震颤 ✓。差异登记在 `docs/PLAN.md` 第 91~92 轮与第 350 轮。
 */

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 镜头种类（与 `sonnetKinds.ts` 的联合类型一致；这里只用它的字面量，避免互相 import）。 */
export type SonnetShotKindName =
  | 'editorial-column'
  | 'type-impact'
  | 'fragment-collage'
  | 'tracking-ribbon'
  | 'mask-reveal'
  | 'poster-blocks'
  | 'quiet-tableau';

/** 三次贝塞尔在参数 `t` 处的坐标（照抄上游 `cubicCoordinate`）。 */
const cubicCoordinate = (point1: number, point2: number, time: number): number => {
  const inverse = 1 - time;
  return 3 * inverse * inverse * time * point1 + 3 * inverse * time * time * point2 + time * time * time;
};

/**
 * CSS 风格的 `cubic-bezier` 求值：**先解 x 曲线、再采样 y**（照抄上游 `resolveCubicBezier`）。
 * 二分固定 **12 次**，与上游一致 —— 所以同样的输入给出同样的输出，seek 到同一时刻不会抖。
 */
export const resolveCubicBezier = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  value: number,
): number => {
  const target = clamp01(value);
  if (target === 0 || target === 1) return target;
  let low = 0;
  let high = 1;
  let parameter = target;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const x = cubicCoordinate(x1, x2, parameter);
    if (x < target) low = parameter;
    else high = parameter;
    parameter = (low + high) / 2;
  }
  return cubicCoordinate(y1, y2, parameter);
};

/** 场面缓动：`cubic-bezier(0.65, 0, 0.35, 1)`（照抄上游 `easeSonnetInOut`）。 */
export const easeSonnetInOut = (value: number): number => resolveCubicBezier(0.65, 0, 0.35, 1, value);

/** 入场缓动：`cubic-bezier(0.22, 1, 0.36, 1)`（照抄上游 `easeSonnetEnter`）。 */
export const easeSonnetEnter = (value: number): number => resolveCubicBezier(0.22, 1, 0.36, 1, value);

/** 高张力 PV 风格：`1 − 2^(−10t)`（照抄上游 `easeSonnetExpoOut`）。 */
export const easeSonnetExpoOut = (value: number): number => (value === 1 ? 1 : 1 - Math.pow(2, -10 * value));

/** 弹性收尾，周期 `p = 0.3`（照抄上游 `easeSonnetElasticOut`）。 */
export const easeSonnetElasticOut = (value: number): number => {
  const period = 0.3;
  return Math.pow(2, -10 * value) * Math.sin(((value - period / 4) * (2 * Math.PI)) / period) + 1;
};

/** 动画强度档 → 缩放（照抄上游 `resolveSonnetAnimationScale`）。 */
export const resolveSonnetAnimationScale = (intensity: 'calm' | 'normal' | 'chaotic' | string): number => {
  if (intensity === 'calm') return 0.65;
  if (intensity === 'chaotic') return 1.35;
  return 1;
};

/**
 * 段入场进度（照抄上游 `resolveSegmentProgress`）：
 * `expoOut(clamp01((t − start) / max(end − start, 0.08)))` —— **0.08 秒下限**，
 * 所以极短的段也不会"啪"地一下到位，仍有一记打击感。
 */
export const resolveSegmentProgress = (startTime: number, endTime: number, time: number): number =>
  easeSonnetExpoOut(clamp01((time - startTime) / Math.max(endTime - startTime, 0.08)));

/*
 * 这里原来有一个 `resolveSonnetExitProgress`（把入场曲线镜像成一套退场），已删除：
 * 原版的逐字循环里**只有入场** —— 字落位后留在画面上，消失交给场景/镜头转场那一层。
 * "入场结束后画面会静止"那段观感现在由**镜头**（路径曲线 + 空档漂移 + 呼吸）负责。
 */

/**
 * 装饰段的随机深度（照抄上游 `resolveSonnetSegmentDepth`）：
 * **只有 `decoration` 段有**，取 `+(0.5 ~ 1.3)` 或 `−(0.5 ~ 1.3)`（按随机数正负分两侧）。
 */
export const resolveSonnetSegmentDepth = (
  role: 'hero' | 'semi-hero' | 'support' | 'decoration',
  random: () => number = Math.random,
): number => {
  if (role !== 'decoration') return 0;
  return random() > 0.5 ? 0.5 + random() * 0.8 : -0.5 - random() * 0.8;
};

/**
 * 陪衬段的法向偏移（照抄上游 `resolveSonnetSegmentNormalOffset`）：
 * **只有 `support` 段有**；幅度 `(±1) × 字号 × 0.3`，
 * 方向是"盒子的法线"（横排时旋转再加 90°）。
 */
export const resolveSonnetSegmentNormalOffset = (
  role: 'hero' | 'semi-hero' | 'support' | 'decoration',
  layoutDirection: 'horizontal' | 'vertical',
  rotation: number,
  fontSize: number,
  randomValue: number,
): { x: number; y: number } => {
  if (role !== 'support') return { x: 0, y: 0 };
  const distance = (Math.min(1, Math.max(0, randomValue)) * 2 - 1) * fontSize * 0.3;
  const normalAngle = rotation + (layoutDirection === 'vertical' ? 0 : Math.PI / 2);
  return { x: Math.cos(normalAngle) * distance, y: Math.sin(normalAngle) * distance };
};

/** 运镜帧：`x/y` 是画面宽高的比例偏移、`scale` 是缩放、`rotation` 是弧度。 */
export interface SonnetShotMotionFrame {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/**
 * 镜头路径进度（**照抄上游 `resolveShotPathProgress`**，本地 `.folia-ref/sonnet__sonnetMotion.ts:180~190`）。
 *
 * 四种镜头（丝带 / 片段环 / 静场 / 海报方块）走"**匀速漂移混缓动**"：
 * `linear × 0.55 + inOut(linear) × 0.45` —— 中段近似匀速，镜头不会在中间"停住"；
 * 其余三种走三段式：前 18% 用 `expoOut` 快速起手推到 0.22、中段 60% 线性推到 0.78、
 * 最后 22% 用 `1 − (1−settle)²` 柔和收尾（把速度让给转场）。
 */
export const resolveShotPathProgress = (kind: SonnetShotKindName, progress: number): number => {
  const linear = clamp01(progress);
  if (
    kind === 'tracking-ribbon' ||
    kind === 'fragment-collage' ||
    kind === 'quiet-tableau' ||
    kind === 'poster-blocks'
  ) {
    return linear * 0.55 + easeSonnetInOut(linear) * 0.45;
  }
  if (linear < 0.18) return easeSonnetExpoOut(linear / 0.18) * 0.22;
  if (linear < 0.78) return 0.22 + ((linear - 0.18) / 0.6) * 0.56;
  const settle = (linear - 0.78) / 0.22;
  return 0.78 + (1 - (1 - settle) * (1 - settle)) * 0.22;
};

/**
 * 七种镜头各自的运镜帧（**照抄上游 `resolveShotMotionFrame`**，本地快照 `:193~244`）。
 *
 * 注意两点：
 *  · `type-impact` 的缩放多一项 `(1 − expoOut(min(t/0.18, 1))) × 0.22` —— 开场那记"推近"；
 *  · `fragment-collage` 的 y 用 `sin(eπ)` 起伏，是这一族独有的"绕环感"。
 */
export const resolveShotMotionFrame = (
  kind: SonnetShotKindName,
  progress: number,
): SonnetShotMotionFrame => {
  const linear = clamp01(progress);
  const eased = resolveShotPathProgress(kind, linear);
  const frames: Record<SonnetShotKindName, SonnetShotMotionFrame> = {
    'editorial-column': {
      x: -0.055 + eased * 0.095,
      y: 0.025 - eased * 0.04,
      scale: 0.98 + eased * 0.07,
      rotation: -0.006 + eased * 0.01,
    },
    'type-impact': {
      x: -0.035 + eased * 0.07,
      y: 0.018 - eased * 0.028,
      scale: 1 + (1 - easeSonnetExpoOut(Math.min(linear / 0.18, 1))) * 0.22 + eased * 0.08,
      rotation: -0.01 + eased * 0.016,
    },
    'fragment-collage': {
      x: -0.045 + eased * 0.085,
      y: 0.028 - Math.sin(eased * Math.PI) * 0.055,
      scale: 0.97 + eased * 0.09,
      rotation: -0.014 + eased * 0.028,
    },
    'tracking-ribbon': {
      x: -0.16 + eased * 0.28,
      y: 0.05 - eased * 0.085,
      scale: 0.98 + eased * 0.07,
      rotation: 0.008 - eased * 0.014,
    },
    'mask-reveal': {
      x: 0.035 - eased * 0.065,
      y: 0.1 - eased * 0.135,
      scale: 0.96 + eased * 0.12,
      rotation: -0.006 + eased * 0.009,
    },
    'poster-blocks': {
      x: -0.012 + eased * 0.024,
      y: 0.008 - eased * 0.016,
      scale: 0.99 + eased * 0.025,
      rotation: -0.0015 + eased * 0.003,
    },
    'quiet-tableau': {
      x: -0.022 + eased * 0.04,
      y: 0.014 - eased * 0.025,
      scale: 1 + eased * 0.028,
      rotation: -0.002 + eased * 0.003,
    },
  };
  return frames[kind];
};

/** 相机聚焦点（画面比例坐标）。 */
export interface SonnetCameraFocusPoint {
  x: number;
  y: number;
}

/** 聚焦时间区间（用于算"这一刻各段该有多大权重"）。 */
export interface SonnetFocusTimeRange {
  startTime: number;
  endTime: number;
}

/**
 * 保边的时间平滑采样点（**照抄上游 `SONNET_CAMERA_SMOOTHING_SAMPLES`**，本地快照 `:111~117`）：
 * 以当前时刻为中心取 5 个样本，偏移 `±1 / ±0.5 / 0` 倍窗口、权重 `1 / 4 / 6 / 4 / 1`。
 */
const SONNET_CAMERA_SMOOTHING_SAMPLES = [
  { offset: -1, weight: 1 },
  { offset: -0.5, weight: 4 },
  { offset: 0, weight: 6 },
  { offset: 0.5, weight: 4 },
  { offset: 1, weight: 1 },
] as const;

/**
 * **保边软带**占 `maxBlendDistance` 的比例：距离在 `[1 − 比例, 1] × maxBlendDistance` 之间时
 * 权重从满连续降到 0。取一半 ⇒ 96px 的门槛从 48px 起就开始温和衰减，衰减段足够宽，
 * 快速移动跨过门槛时不会出现"某个抽样权重整块消失"的台阶 ✓。
 */
export const SONNET_FOCUS_BLEND_SOFT_RATIO = 0.5;

/**
 * 单个样本的**保边权重**（`0 ~ 1`，连续）：
 *
 * · `distance ≤ inner` ⇒ `1`（衰减从 `inner` 才开始；中心样本距离 0 ⇒ 永远为满权重）✓；
 * · `inner < distance < maxDistance` ⇒ smoothstep `s²(3 − 2s)` 从 1 连续降到 0（两端斜率为 0 ⇒ C¹）✓；
 * · `distance ≥ maxDistance` ⇒ `0`（远样本不混入，保住刻意的构图跳变）✓。
 *
 * 纯函数、只看距离 ⇒ 与采样时刻无关，seek 到任意时刻都确定性一致 ✓。
 */
export function resolveSonnetFocusBlendWeight(distance: number, maxDistance: number): number {
  if (!(maxDistance > 0)) return distance <= 0 ? 1 : 0;
  if (!(distance > 0)) return 1;
  if (distance >= maxDistance) return 0;
  const inner = maxDistance * (1 - SONNET_FOCUS_BLEND_SOFT_RATIO);
  if (distance <= inner) return 1;
  const progress = (maxDistance - distance) / (maxDistance - inner);
  return progress * progress * (3 - 2 * progress);
}

/**
 * **保边**的时间平滑（**照抄上游 `resolveSonnetSmoothedCameraFocus`**，本地快照 `:120~153`）。
 *
 * 与普通低通不同：离中心点越远的样本权重**连续衰减**，超过 `maxBlendDistance` 的样本完全不参与
 * —— 这样"故意设计的构图跳变"（相邻镜头机位差很远）不会被平均掉，只有小幅抖动被抹平；
 * 而且它按**绝对时间**取样本，所以 seek 到任意时刻都和连续播放一致。
 *
 * ⚠ **远处样本的"整块剔除"在本轮改成连续衰减**（软带见 `resolveSonnetFocusBlendWeight`）：
 * 旧版用 `distance² > maxBlendDistance²` 硬剔除 —— focus 快速移动、距离跨过 96px 门槛时，
 * 某个抽样权重会**整块消失 / 出现**，读数因此出现一个**与相机运动无关的位置跳变** ✗。
 * 现在权重在 `[inner, maxBlendDistance]` 的软带里用 smoothstep 从 1 连续减到 0，
 * 超过门槛仍是 0（远样本不混入），中心样本距离 0 ⇒ 权重恒为满（永远参与平均）✓。
 */
export const resolveSonnetSmoothedCameraFocus = (
  time: number,
  startTime: number,
  endTime: number,
  sampleFocus: (sampleTime: number) => SonnetCameraFocusPoint,
  smoothingWindow = 0.12,
  maxBlendDistance = 96,
): SonnetCameraFocusPoint => {
  const safeStart = Math.min(startTime, endTime);
  const safeEnd = Math.max(startTime, endTime);
  const radius = Math.max(0, smoothingWindow);
  if (radius === 0 || safeStart === safeEnd) {
    return sampleFocus(Math.min(safeEnd, Math.max(safeStart, time)));
  }
  const samples = SONNET_CAMERA_SMOOTHING_SAMPLES.map(({ offset, weight }) => {
    const sampleTime = Math.min(safeEnd, Math.max(safeStart, time + offset * radius));
    return { point: sampleFocus(sampleTime), weight };
  });
  const center = samples[2]?.point ?? { x: 0, y: 0 };
  const maxDistance = Math.max(0, maxBlendDistance);
  let x = 0;
  let y = 0;
  let totalWeight = 0;
  samples.forEach(({ point, weight }) => {
    const distance = Math.sqrt((point.x - center.x) ** 2 + (point.y - center.y) ** 2);
    const blend = resolveSonnetFocusBlendWeight(distance, maxDistance);
    // 软带外（含超过门槛）的样本**不参与平均**：保住有意为之的构图跳变。
    if (blend <= 0) return;
    const effectiveWeight = weight * blend;
    x += point.x * effectiveWeight;
    y += point.y * effectiveWeight;
    totalWeight += effectiveWeight;
  });
  if (totalWeight === 0) return center;
  return { x: x / totalWeight, y: y / totalWeight };
};

/**
 * 聚焦权重（**照抄上游 `resolveSonnetFocusWeights`**，本地快照 `:156~177`）：
 * 对每个时间区间算"到当前时刻的距离"、取高斯 `exp(−d²/2σ²)`（`σ = 0.35`），
 * 再用"减去最大对数权重"的写法做 softmax 归一（数值稳定，静默空隙与片尾也有定义）。
 */
export const resolveSonnetFocusWeights = (
  ranges: readonly SonnetFocusTimeRange[],
  time: number,
  sigma = 0.35,
): number[] => {
  if (ranges.length === 0) return [];
  const safeSigma = Math.max(0.001, sigma);
  const logWeights = ranges.map((range) => {
    const startTime = Math.min(range.startTime, range.endTime);
    const endTime = Math.max(range.startTime, range.endTime);
    const distance = time < startTime ? startTime - time : time > endTime ? time - endTime : 0;
    return -(distance * distance) / (2 * safeSigma * safeSigma);
  });
  const maxLogWeight = Math.max(...logWeights);
  const weights = logWeights.map((weight) => Math.exp(weight - maxLogWeight));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  if (totalWeight === 0) return weights.map(() => 0);
  return weights.map((weight) => weight / totalWeight);
};

/* ------------------------------------------------------------------ *
 * 唱词时间轴节奏（本轮新增的那一层）
 * ------------------------------------------------------------------ */

/**
 * 一粒字 / 一个词的**真实**唱词时段（帧层从逐字 cue 拿到的 start/end，秒）。
 *
 * ⚠ 口径声明：这里的节奏来自**唱词时间轴**（LRC / 逐字 cue 的起止与间隔），
 * **不是音频 BPM** —— 我们没有解析音频速度，也不假装有。
 */
export interface SonnetRhythmCue {
  readonly startTime: number;
  readonly endTime: number;
}

/** 局部密度的三角窗半径（秒）：看"当前前后约 0.9 秒里唱了几粒字"。 */
export const SONNET_RHYTHM_DENSITY_SPAN = 0.9;
/**
 * 密度映射到"唱得快"的慢 / 快两端（**字素 / 秒**）。
 *
 * ⚠ 本轮校准（旧值 0.55 / 3.2）：3.2 对**日文与英文的常见输入过低** —— 中日文一拍一个字
 * 就是 4~8 粒/秒，英文长句 30~40 字 / 3.6 秒约 8~11 粒/秒 ⇒ 旧上限让绝大多数帧顶到
 * `speed = 1.00`，同一行里 1:5 的 cue 间隔变化完全消失（主人实测 4.89~15.67 全是 1.00）。
 *
 * 新端点按**真实回放**的稳健统计定：实测密度 min 1.27 / p25 5.03 / 中位 8.35 / p75 10.49 /
 * p90 23.69。慢端 0.8（约 1.25 秒一粒）到快端 16（约 62 毫秒一粒）覆盖"长音 → 普通唱 → 快唱"，
 * 中位落在 0.42、p75 落在 0.70 ⇒ 普通唱不再顶格；而**端点仍是绝对值**，所以整首偏快 / 偏慢
 * 的歌拿到的镜头速度**真的不同**（不是按每首自己归一化掉的相对量）。
 */
export const SONNET_RHYTHM_SLOW_DENSITY = 0.8;
export const SONNET_RHYTHM_FAST_DENSITY = 16;
/** 跟拍强度 `trackingFactor`（越大越贴着当前字；越小越停在段中心）。 */
export const SONNET_RHYTHM_TRACKING_SLOW = 0.42;
export const SONNET_RHYTHM_TRACKING_FAST = 0.62;
/** 保边时间平滑窗（秒）：密唱要更跟得上（小窗），长音 / 空档更稳更缓（大窗）。 */
export const SONNET_RHYTHM_SMOOTHING_SLOW = 0.2;
export const SONNET_RHYTHM_SMOOTHING_FAST = 0.085;
/** 呼吸幅度倍率：长音 / 空档可以浮得明显些，密唱时收住（免得晃）。 */
export const SONNET_RHYTHM_BREATH_SLOW = 1.45;
export const SONNET_RHYTHM_BREATH_FAST = 0.55;
/** "唱完这一句之后过了多久算留白"的参考时长（秒）。 */
export const SONNET_RHYTHM_HOLD_REFERENCE = 1.1;
/**
 * 长音判据：局部平均唱词时长（秒）从"短"到"长"的映射端点。
 *
 * ⚠ 本轮校准（旧值 0.35 / 1.2）：逐字 cue 的常见时长是**每粒 0.1~0.6 秒**（英文长句约 0.1 秒、
 * 中日文普通唱约 0.2~0.4 秒），旧下限 0.35 把"普通唱 + 拉长的那几粒"全判成非长音 ⇒ 实测
 * `sustain` 整首恒为 0。新端点 0.18 / 0.9 让"普通唱"≈0、"明显拉长的音"≈0.2~0.6、"慢句 / 真长音"→1。
 * 映射本身仍是上一轮那套连续插值，只换端点，不引入任何台阶。
 */
export const SONNET_RHYTHM_LONG_NOTE_SHORT = 0.18;
export const SONNET_RHYTHM_LONG_NOTE_LONG = 0.9;
/** 长音对"慢"的贡献上限（长音也要算慢，但不至于让跟拍完全停住）。 */
export const SONNET_RHYTHM_SUSTAIN_CALM_WEIGHT = 0.6;

function rhythmSmoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function rhythmLerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/** 以 `time` 为中心的三角核权重（在 `±span` 处连续归零）。 */
function rhythmKernelWeight(startTime: number, time: number, span: number): number {
  return Math.max(0, 1 - Math.abs(startTime - time) / span);
}

/**
 * **局部唱词密度**（粒 / 秒，连续）：以 `time` 为中心的三角窗，数窗内有多少粒字的**起点**。
 *
 * · 相邻字间隔 `d`、三角窗半径 `span` ⇒ 密度 ≈ `1 / d`（等距时严格成立）✓；
 * · 三角核在 `|time − start| = span` 处连续归零 ⇒ 密度随时间连续变化 ✓（没有"数一下突然加一"的台阶）；
 * · 只看绝对时刻与 cue，无状态 ⇒ seek / 帧率无关 ✓。
 */
export function resolveSonnetCueDensity(
  cues: readonly SonnetRhythmCue[],
  time: number,
  span = SONNET_RHYTHM_DENSITY_SPAN,
): number {
  const radius = Number.isFinite(span) && span > 0 ? span : SONNET_RHYTHM_DENSITY_SPAN;
  if (cues.length === 0 || !Number.isFinite(time)) return 0;
  let weighted = 0;
  for (const cue of cues) {
    const start = cue.startTime;
    if (!Number.isFinite(start)) continue;
    const weight = rhythmKernelWeight(start, time, radius);
    if (weight > 0) weighted += weight;
  }
  return weighted / radius;
}

/**
 * **局部平均唱词时长**（秒，连续）：同一个三角核，加权平均每粒字"唱多久"。
 *
 * 为什么不用"当前这一粒的播放进度"：那个量在换字那一刻会**从 1 掉回 0**（锯齿），
 * 喂给跟拍强度就是每个字一次台阶。局部平均时长是**连续**的：
 * 密唱 → 接近字间隔（小），长音 / 慢歌 → 接近 1 秒以上（大）。
 */
export function resolveSonnetCueDurationScale(
  cues: readonly SonnetRhythmCue[],
  time: number,
  span = SONNET_RHYTHM_DENSITY_SPAN,
): number {
  const radius = Number.isFinite(span) && span > 0 ? span : SONNET_RHYTHM_DENSITY_SPAN;
  if (cues.length === 0 || !Number.isFinite(time)) return 0;
  let weighted = 0;
  let total = 0;
  for (const cue of cues) {
    const start = Math.min(cue.startTime, cue.endTime);
    const end = Math.max(cue.startTime, cue.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const weight = rhythmKernelWeight(start, time, radius);
    if (weight <= 0) continue;
    weighted += Math.max(0, end - start) * weight;
    total += weight;
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * **空档距离**（秒，连续）：`t` 离"最近的唱词时段"有多远 —— 正在唱时是 0，空档里慢慢长大。
 *
 * 用**最近 cue 的时段距离**而不是"最后一个唱完的 cue 的结束时刻"：后者在每一粒唱完的瞬间
 * 会突然换参考点（锯齿），前者是连续函数（`min` 保持连续）✓。
 */
export function resolveSonnetCueGapDistance(cues: readonly SonnetRhythmCue[], time: number): number {
  if (cues.length === 0 || !Number.isFinite(time)) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (const cue of cues) {
    const start = Math.min(cue.startTime, cue.endTime);
    const end = Math.max(cue.startTime, cue.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const distance = time < start ? start - time : time > end ? time - end : 0;
    if (distance < best) best = distance;
  }
  return Number.isFinite(best) ? best : 0;
}

/** 节奏读数（全部由唱词时间轴推出；帧层把它挂到 `SonnetFrame.rhythm` 上给渲染层 / 验收读）。 */
export interface SonnetRhythmProfile {
  /** 局部唱词密度（粒 / 秒）。 */
  readonly cueDensity: number;
  /** 0~1 的"唱得快"程度（密度平滑映射）。 */
  readonly speed: number;
  /** **长音程度**（0~1）：由"局部平均唱词时长"推出（长音 / 慢歌 → 接近 1）。 */
  readonly sustain: number;
  /** **空档程度**（0~1）：`t` 离最近的唱词时段有多远（唱的时候 0，留白里长大）。 */
  readonly hold: number;
  /** 跟拍强度（喂给 `resolveSonnetSegmentCameraFocus`）。 */
  readonly trackingFactor: number;
  /** 保边平滑窗（秒，喂给 `resolveSonnetSmoothedCameraFocus`）。 */
  readonly smoothingWindow: number;
  /** 呼吸幅度倍率（乘在 `resolveSonnetBreath` 的结果上）。 */
  readonly breathScale: number;
}

/**
 * 此刻的**唱词时间轴节奏**。
 *
 * 输入只有"真实逐字 cue + 当前绝对时刻"，输出七个连续量：
 * · `speed`：局部密度映射（密唱 → 1，长音 / 空档 → 0）；
 * · `sustain`：**长音程度**（局部平均唱词时长，密唱小、长音大）；
 *   `hold`：**空档程度**（离最近唱词时段的距离）；
 * · `trackingFactor`：`calm` 越大越往段中心停（长音 / 空档稳，密唱贴当前字）；
 * · `smoothingWindow`：`calm` 越大窗越宽（长音更缓、密唱更跟得上）；
 * · `breathScale`：长音 / 空档浮得多、密唱收住。
 *
 * `calm = max(1 − speed, hold × 0.9, sustain × 0.6)`：三个输入都是 `t` 的**连续**函数
 * （密度与平均时长走三角核、空档取"最近 cue 的时段距离"），所以节奏本身不给镜头制造台阶
 * —— 早先"当前字的播放进度"会在换字那一瞬从 1 掉回 0（锯齿），已换成局部平均时长。
 */
export function resolveSonnetRhythmProfile(
  cues: readonly SonnetRhythmCue[],
  time: number,
  options: {
    readonly densitySpan?: number;
    readonly slowDensity?: number;
    readonly fastDensity?: number;
  } = {},
): SonnetRhythmProfile {
  const safeTime = Number.isFinite(time) ? time : 0;
  const slowDensity = Math.max(0.001, options.slowDensity ?? SONNET_RHYTHM_SLOW_DENSITY);
  const fastDensity = Math.max(slowDensity + 0.001, options.fastDensity ?? SONNET_RHYTHM_FAST_DENSITY);
  const cueDensity = resolveSonnetCueDensity(cues, safeTime, options.densitySpan);
  const speed = rhythmSmoothstep((cueDensity - slowDensity) / (fastDensity - slowDensity));
  const durationScale = resolveSonnetCueDurationScale(cues, safeTime, options.densitySpan);
  /* 长音程度：局部平均唱词时长从"短"线性映到"长"（两端夹住 ⇒ 连续）。 */
  const sustain = clamp01(
    (durationScale - SONNET_RHYTHM_LONG_NOTE_SHORT) /
      (SONNET_RHYTHM_LONG_NOTE_LONG - SONNET_RHYTHM_LONG_NOTE_SHORT),
  );
  const hold = clamp01(resolveSonnetCueGapDistance(cues, safeTime) / SONNET_RHYTHM_HOLD_REFERENCE);
  const calm = clamp01(Math.max(1 - speed, hold * 0.9, sustain * SONNET_RHYTHM_SUSTAIN_CALM_WEIGHT));
  return {
    cueDensity,
    speed,
    sustain,
    hold,
    trackingFactor: rhythmLerp(SONNET_RHYTHM_TRACKING_FAST, SONNET_RHYTHM_TRACKING_SLOW, calm),
    smoothingWindow: rhythmLerp(SONNET_RHYTHM_SMOOTHING_FAST, SONNET_RHYTHM_SMOOTHING_SLOW, calm),
    breathScale: rhythmLerp(
      SONNET_RHYTHM_BREATH_FAST,
      SONNET_RHYTHM_BREATH_SLOW,
      clamp01(Math.max(1 - speed, sustain, hold)),
    ),
  };
}

/** 没有 cue 时的节奏读数（静默期 / 片头；取"最慢"那一档 ⇒ 镜头稳、呼吸满）。 */
export const SONNET_IDLE_RHYTHM_PROFILE: SonnetRhythmProfile = Object.freeze({
  cueDensity: 0,
  speed: 0,
  sustain: 0,
  hold: 0,
  trackingFactor: SONNET_RHYTHM_TRACKING_SLOW,
  smoothingWindow: SONNET_RHYTHM_SMOOTHING_SLOW,
  breathScale: SONNET_RHYTHM_BREATH_SLOW,
});

/** 节奏读数（dataset / 用例共用一份口径）。 */
export function describeSonnetRhythmProfile(profile: SonnetRhythmProfile): string {
  return (
    `density=${profile.cueDensity.toFixed(2)} speed=${profile.speed.toFixed(2)} ` +
    `sustain=${profile.sustain.toFixed(2)} hold=${profile.hold.toFixed(2)} ` +
    `track=${profile.trackingFactor.toFixed(3)} sigma=${profile.smoothingWindow.toFixed(3)} ` +
    `breath=${profile.breathScale.toFixed(2)}`
  );
}

/** 手持呼吸的幅度上限（照抄上游常量）。 */
export const SONNET_CAMERA_BREATH_MAX_OFFSET = 0.006;
export const SONNET_CAMERA_BREATH_MAX_SCALE = 0.002;
export const SONNET_CAMERA_BREATH_MAX_ROTATION = 0.0015;

/**
 * 手持呼吸（照抄上游 `resolveSonnetCameraBreath`：两个不可通约的正弦叠加 + 绝对时间求值）。
 *
 * ⚠ **参数是"秒"，不是角度** —— 上游 `:252-253` 是 `(time, phase = 0)` 内部再算
 * `tau = time × 2π`。我们原来把参数直接当 `tau` 用（注释还写着"这一镜里已经过了多久"），
 * 于是谁按秒来调都会**慢 6.28 倍**。现在与上游同口径：收秒、内部乘 2π。
 * （目前两侧生产代码都还没消费它，所以这次对齐不改变任何画面；改的是"以后接线时不会接错"。）
 */
export const resolveSonnetBreath = (time: number, phase: number): {
  x: number;
  y: number;
  scale: number;
  rotation: number;
} => {
  const tau = time * Math.PI * 2;
  return {
    x:
      (Math.sin(tau * 0.13 + phase) * 0.65 + Math.sin(tau * 0.31 + phase * 1.7) * 0.35) *
      SONNET_CAMERA_BREATH_MAX_OFFSET,
    y:
      (Math.cos(tau * 0.11 + phase * 2.3) * 0.65 + Math.sin(tau * 0.29 + phase * 0.9) * 0.35) *
      SONNET_CAMERA_BREATH_MAX_OFFSET,
    scale: Math.sin(tau * 0.09 + phase * 1.3) * SONNET_CAMERA_BREATH_MAX_SCALE,
    rotation: Math.sin(tau * 0.07 + phase * 2.9) * SONNET_CAMERA_BREATH_MAX_ROTATION,
  };
};

/**
 * 呼吸的**渐入权重**（照抄上游 `resolveSonnetBreathWeight`）：
 * 歌词入场完成后 `rampDuration = 1.2` 秒内用 `inOut` 从 0 涨到 1 ——
 * 免得"字还在进场、镜头就先抖起来"。
 */
export const resolveSonnetBreathWeight = (
  time: number,
  revealDoneTime: number,
  rampDuration = 1.2,
): number => {
  if (rampDuration <= 0) return time >= revealDoneTime ? 1 : 0;
  return easeSonnetInOut(clamp01((time - revealDoneTime) / rampDuration));
};

/**
 * 纯时间轴伪随机震颤（照抄上游 `resolveTimelineShake`）：
 * 三个高频正弦，幅度 `0.02 × 强度`、旋转 `0.005 × 强度`。
 */
export const resolveTimelineShake = (
  time: number,
  intensity: number,
): { x: number; y: number; rotation: number } => {
  if (intensity <= 0) return { x: 0, y: 0, rotation: 0 };
  const shakeX = Math.sin(time * 123.456) * Math.cos(time * 789.123);
  const shakeY = Math.cos(time * 345.678) * Math.sin(time * 901.234);
  const shakeRot = Math.sin(time * 567.89);
  return { x: shakeX * 0.02 * intensity, y: shakeY * 0.02 * intensity, rotation: shakeRot * 0.005 * intensity };
};
