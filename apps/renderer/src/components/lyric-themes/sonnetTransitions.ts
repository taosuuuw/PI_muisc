/**
 * 商籁（sonnet）的**转场**：段落之间、以及**同一段落内相邻镜头之间**的短过渡。
 *
 * === 借鉴的数值（照抄，不是推断）===
 * 来源是 folia 的 `sonnet/sonnetTransitions.ts`（AGPL-3.0，只取数值与做法，代码在本仓库重写）：
 *
 * - 三种转场 `fast-blur` / `mono-glitch` / `camera-pull`，按**边界序号做黄金比例哈希**选定，
 *   不是顺序轮转：`mixed = (seed ^ ((boundaryIndex + 1) * 0x9e3779b1)) >>> 0`，取 `mixed % 3`。
 * - `fast-blur`：模糊 `amount * 14`；出场 α `1 - amount`、入场 α `1 - amount * 0.82`。
 * - `mono-glitch`：`step = floor(progress * 14)`；出场**且** `progress > 0.86` 时 α 才开始掉；
 *   故障强度 `amount`，抖动种子 `seed * 0.0001 + step * 0.173`。
 * - `camera-pull`：**刻意不缩放**（`scale` 恒为 1）—— 场景滤镜用的是视口大小的渲染面，一缩放就露边界；
 *   出场 α `1 - amount`、入场 α `1 - amount * 0.72`。
 * - `amount`：出场取 `eased`，入场取 `1 - eased`（`eased` 是 progress 的 in-out 缓动）。
 * - **相邻镜头之间也有转场**，时长 `clamp(相邻镜起始间隔 * 0.18, 0.14, 0.24)` 秒，
 *   出场从「下一镜起始 − 时长」开始 —— 这段节奏是原版最有辨识度的部分，之前我们完全没有。
 *
 * === 与 folia 的差异（照实记）===
 * 缓动已换成原函数（`easeSonnetInOut` = 三次贝塞尔 `(0.65, 0, 0.35, 1)`），不再是替身。
 * 求参数用二分而非牛顿迭代，短窗口下看不出差别。
 */

import type { SonnetParagraph, SonnetShot } from './sonnetProgram';
import { easeSonnetInOut } from './sonnetMotion';

/** 三种转场。名字与 folia 的 `SONNET_TRANSITION_KINDS` 一致。 */
export const SONNET_TRANSITION_KINDS = ['fast-blur', 'mono-glitch', 'camera-pull'] as const;

export type SonnetTransitionKind = (typeof SONNET_TRANSITION_KINDS)[number];

/** 转场算出来的**画布级**变换：渲染层把它套在整棵场景上。 */
export interface SonnetTransitionFrame {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly rotation: number;
  readonly alpha: number;
  readonly blurPx: number;
  readonly glitch: number;
  readonly glitchSeed: number;
}

export const SONNET_IDLE_TRANSITION: SonnetTransitionFrame = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  alpha: 1,
  blurPx: 0,
  glitch: 0,
  glitchSeed: 0,
};

/** 黄金比例哈希：与 folia 同一个常数（`0x9e3779b1` 是 2^32 / φ 的取整）。 */
const SONNET_GOLDEN_RATIO = 0x9e3779b1;


/**
 * 镜头之间的转场时长上下限（秒），以及它相对「相邻镜起始间隔」的系数。
 *
 * ⚠ **这是我们对上游的主动偏差**（主人点名的动效方向之三：「句间快速硬切、句内流畅衔接」）。
 * 上游原值 **MIN 0.14 / MAX 0.24**，读起来是柔和的溶接；现在压到 **0.06 / 0.10**（短约 2.4 倍）——
 * 保留一层薄转场（不砍成瞬切，免得生硬），但观感从"融"变成"切"。
 * 系数 0.18 不动：它决定"长间隔的镜头能拿到多长的转场"，改了会连带影响整首的节奏分布。
 */
export const SONNET_SHOT_TRANSITION_MIN = 0.06;
export const SONNET_SHOT_TRANSITION_MAX = 0.1;
export const SONNET_SHOT_TRANSITION_RATIO = 0.18;

/** 故障转场把 progress 切成多少档（档位而非连续，才有"卡帧"的观感）。 */
export const SONNET_GLITCH_STEPS = 14;
/** 出场时 α 开始掉的门槛（只对 mono-glitch 有效）。 */
export const SONNET_GLITCH_ALPHA_TAIL = 0.86;

/**
 * **段落级出场转场**（照抄上游 `resolveSonnetExitTransitionFrame`）。
 *
 * 我们的编译层**早就把 `paragraph.transitionOut` 填好了**（`sonnetProgram.ts:630`），
 * 但帧层一直只消费"镜头之间"那一层（`resolveSonnetShotTransition`），
 * 段落之间那一层**没有接上来**（`sonnetFrame.ts:1377` 的自述）。
 *
 * 判定与上游一致：`enabled` 为假、没有 `transitionOut`、或**还没走到转场窗口**（`time < startTime`）
 * 一律返回 `SONNET_IDLE_TRANSITION`；否则按窗口进度走 `exit` 分支。
 * 窗口由编译层给（`startTime = max(段落首行, 下一段首行 − 时长)`、`endTime = 下一段首行`）。
 */
export function resolveSonnetParagraphExitTransition(
  paragraph: SonnetParagraph,
  time: number,
  enabled: boolean,
  seed: number,
): SonnetTransitionFrame {
  const transition = paragraph.transitionOut;
  if (!enabled || transition === null || time < transition.startTime) {
    return SONNET_IDLE_TRANSITION;
  }
  const progress = (time - transition.startTime) / Math.max(transition.endTime - transition.startTime, 0.001);
  return resolveSonnetTransitionEffect(transition.kind, 'exit', progress, seed);
}

/**
 * 把编译层的**字符串种子**压成一个 32 位整数。
 *
 * ⚠ **已知偏差（第 330/331 轮取证）**：上游 `sonnetRandom.ts` 的 `hashSonnetSeed` 用的是
 * **FNV-1a**（初值 `2166136261`、每字节 `hash ^= charCode; hash = imul(hash, 16777619)`），
 * 而这里用的是 **djb2 风**（`hash = imul(hash, 31) + charCode`）。
 *
 * ~~原先的理由"folia 的 seed 本来就是数字"~~ **不成立**：上游那份的**入参也是 `string`**，
 * 它同样是"把字符串折成数"。⇒ 这是**可对齐的窄偏差**：只影响**边界上播哪一种转场**
 * （`sonnetFrame.ts` 用它算转场种子），**不影响**几何档位/背景色相/装饰/粒子抖动 ——
 * 那些走的是 `sonnetGeo.ts` 里**逐字照抄**的 `hashSonnetSeed` / `mixSonnetSeed` / `sonnetHash01` ✓。
 *
 * 对齐（换成 FNV-1a）会让**某些边界换一种转场**，属可见变化 ⇒ 要连同用例期望值一起改，并跑构建+冒烟+看图。
 * 当前**保留原实现**，把偏差写在这里，不装作一致。
 */
export function sonnetSeedNumber(seed: string): number {
  /*
   * FNV-1a（**照抄上游数值**：初值 `2166136261`、每字节乘 `16777619`）。
   * 第 332 轮先把"上游 seed 是数字"那条**不成立的理由**删掉并登记了偏差，本轮把实现也对齐。
   * 影响面：**边界上播哪一种转场**（`mixed % 3`）；几何/装饰/粒子抖动不经过这里。
   */
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 三次贝塞尔求解：给定控制点 `(x1, y1)`、`(x2, y2)` 与进度，求曲线上的 y。
 *
 * folia 的商籁缓动全是这一族（`sonnetMotion.ts`）：
 * - `easeSonnetInOut = cubicBezier(0.65, 0, 0.35, 1)` ← 转场用的就是它
 * - `easeSonnetEnter = cubicBezier(0.22, 1, 0.36, 1)`
 *
 * 我们早先用通用二次 in-out **顶替**过一阵，现在换成原函数（参数照抄）。
 * 求参数用二分 20 次：比牛顿迭代精度略低，但绝不会发散，转场这种短窗口够用。
 */
/**
 * 缓动**统一从 `sonnetMotion.ts` 取**（第 99 轮合并）。
 *
 * 早先这个文件自带一份 `cubicBezier`，与 `sonnetMotion` 的那份是同一套数学的两份实现 ——
 * 一旦哪天有人只改一边、两边就会漂移。第 95 轮把两者的二分次数对齐到上游的 **12 次**之后，
 * 这里直接改成 import，只保留一个出口。
 */
export { easeSonnetEnter } from './sonnetMotion';

/** 按边界序号（段落边界或镜头序号）选一种转场。 */
export function resolveSonnetBoundaryKind(seed: number, boundaryIndex: number): SonnetTransitionKind {
  const mixed = (seed ^ Math.imul(boundaryIndex + 1, SONNET_GOLDEN_RATIO)) >>> 0;
  return SONNET_TRANSITION_KINDS[mixed % SONNET_TRANSITION_KINDS.length] ?? 'fast-blur';
}

/**
 * 某一种转场在给定相位与进度下的画布变换。
 *
 * `phase` 为 `'exit'` 时 `amount` 随进度**增长**（画面越来越退场）；
 * 为 `'enter'` 时取补（画面从退场状态回到常态）。
 */
export function resolveSonnetTransitionEffect(
  kind: SonnetTransitionKind,
  phase: 'enter' | 'exit',
  progress: number,
  seed: number,
): SonnetTransitionFrame {
  const linear = clamp01(progress);
  const eased = easeSonnetInOut(linear);
  const amount = phase === 'exit' ? eased : 1 - eased;

  if (kind === 'fast-blur') {
    return {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      alpha: phase === 'exit' ? 1 - amount : 1 - amount * 0.82,
      blurPx: amount * 14,
      glitch: 0,
      glitchSeed: 0,
    };
  }

  if (kind === 'mono-glitch') {
    const step = Math.floor(linear * SONNET_GLITCH_STEPS);
    return {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      // 出场只有走到最后 14% 才真正暗下去：中途是"跳帧"，不是淡出。
      alpha:
        phase === 'exit' && linear > SONNET_GLITCH_ALPHA_TAIL
          ? 1 - (linear - SONNET_GLITCH_ALPHA_TAIL) / (1 - SONNET_GLITCH_ALPHA_TAIL)
          : 1,
      blurPx: 0,
      glitch: amount,
      glitchSeed: seed * 0.0001 + step * 0.173,
    };
  }

  return {
    x: 0,
    y: 0,
    // 原版注释说得明白：场景滤镜的渲染面就是视口大小，一缩放就会把边界露出来，所以恒为 1。
    scale: 1,
    rotation: 0,
    alpha: phase === 'exit' ? 1 - amount : 1 - amount * 0.72,
    blurPx: 0,
    glitch: 0,
    glitchSeed: 0,
  };
}

/** 相邻两镜之间的转场时长。 */
export function resolveSonnetShotTransitionDuration(
  currentStart: number,
  nextStart: number,
): number {
  const gap = (nextStart - currentStart) * SONNET_SHOT_TRANSITION_RATIO;
  return Math.min(
    SONNET_SHOT_TRANSITION_MAX,
    Math.max(SONNET_SHOT_TRANSITION_MIN, gap),
  );
}

/**
 * 当前时刻落在哪一段镜头转场里（没有就返回静止帧）。
 *
 * 两件事都在这里：**进入**这一段时的入场转场，和**离开**它时的出场转场 ——
 * 两者用的是同一对（当前镜、下一镜）的间隔算时长，所以节奏是连续的。
 */
export function resolveSonnetShotTransition(
  shots: readonly SonnetShot[],
  activeShotIndex: number,
  time: number,
  seed: number,
): SonnetTransitionFrame {
  if (shots.length < 2) return SONNET_IDLE_TRANSITION;
  const current = shots[activeShotIndex];
  if (current === undefined) return SONNET_IDLE_TRANSITION;

  if (activeShotIndex > 0) {
    const previous = shots[activeShotIndex - 1];
    if (previous !== undefined) {
      const duration = resolveSonnetShotTransitionDuration(previous.startTime, current.startTime);
      if (time <= current.startTime + duration) {
        return resolveSonnetTransitionEffect(
          resolveSonnetBoundaryKind(seed, activeShotIndex - 1),
          'enter',
          (time - current.startTime) / Math.max(duration, 0.001),
          seed + activeShotIndex * 97,
        );
      }
    }
  }

  const next = shots[activeShotIndex + 1];
  if (next === undefined) return SONNET_IDLE_TRANSITION;
  const duration = resolveSonnetShotTransitionDuration(current.startTime, next.startTime);
  const start = next.startTime - duration;
  if (time < start) return SONNET_IDLE_TRANSITION;
  return resolveSonnetTransitionEffect(
    resolveSonnetBoundaryKind(seed, activeShotIndex),
    'exit',
    (time - start) / duration,
    seed + (activeShotIndex + 1) * 97,
  );
}
