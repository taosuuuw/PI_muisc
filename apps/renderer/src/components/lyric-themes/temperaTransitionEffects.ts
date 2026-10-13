/**
 * 凝彩（tempera）**段落转场的效果帧**解算（纯函数，不碰 pixi）。
 *
 * 来源：`chthollyphile/folia-major@main` 的
 * `src/components/visualizer/tempera/temperaTransitions.ts`（AGPL-3.0，
 * **只取算法与数值，代码按本仓库风格重写**；本地快照 `.folia-ref/tempera__temperaTransitions.ts`；
 * 登记见 `docs/CREDITS.md` 第 585/587 轮）。
 *
 * ⚠ **为什么需要这个模块**：我方 `temperaProgram.ts` **已经编译出**段落转场描述符
 * （`:189 transitionOut`、`:875~881` 生成 `{ kind, startTime, endTime }`），
 * 但 **runtime 从未读取它** —— 三种转场**编译了却没人播放**（两轮独立查证，见 `CREDITS.md` 第 585 轮）。
 * 本模块就是"播放"所需的纯计算部分。
 *
 * 公共前置：`linear = clamp01(progress)`、`eased = easeTemperaInOut(linear)`（**0.62 / 0 / 0.32 / 1**，
 * 与商籁那条 0.65/0.35 **不同**）、`flowX = cos(flowAngle)`、`flowY = sin(flowAngle)`。
 *
 * 三种转场的取值（全部照搬上游）：
 *   · `block-wipe`：场景保持不透明且不动；`wipe = exit ? eased : 1 + eased`。行程是**连续 0..2** ——
 *     0..1 把块带进来、1..2 把它带出另一侧，**所以色块不会在边界中途反向**。
 *   · `camera-pan`：`travel = 0.5`、`offset = exit ? eased*0.5 : -(1-eased)*0.5`、
 *     `scale = 1 + (exit ? eased : 1-eased)*0.03`、
 *     `alpha = exit ? 1 - clamp01((linear-0.72)/0.28) : clamp01(linear/0.3)`
 *     —— 出场时 **alpha 一直保持到构图几乎出画**，避免中途出现空屏。**本支没有 blur。**
 *   · `shape-carry`：`drift = (exit ? eased : eased-1)*0.09`、`away = exit ? eased : 1-eased`、
 *     `scale = 1 + away*0.07`、
 *     `alpha = exit ? 1 - clamp01((linear-0.55)/0.45) : clamp01(linear/0.45)`、
 *     **`blur = away * 6`**（上游注释：保持漂移、放大并柔化，仿佛被下一个图形拉出焦外；不硬切、不做故障）。
 *
 * ⬜ **尚未接线**：目前只被单测覆盖，runtime 还没调它。
 */

import { clamp01, easeTemperaInOut } from './temperaEasing';
import type { TemperaTransitionKind } from './temperaKinds';

export interface TemperaTransitionFrame {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  alpha: number;
  blur: number;
  /** 扫过块的行程（0..2），**1 = 满覆盖**。 */
  wipe: number;
  /** 扫过方向（弧度），与 shot 的 flow 一致。 */
  wipeAngle: number;
}

export const IDLE_TEMPERA_TRANSITION_FRAME: TemperaTransitionFrame = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  alpha: 1,
  blur: 0,
  wipe: 0,
  wipeAngle: 0,
};

export type TemperaTransitionPhase = 'enter' | 'exit';

export function resolveTemperaTransitionEffectFrame(
  kind: TemperaTransitionKind,
  phase: TemperaTransitionPhase,
  progress: number,
  flowAngle: number,
): TemperaTransitionFrame {
  const linear = clamp01(progress);
  const eased = easeTemperaInOut(linear);
  const flowX = Math.cos(flowAngle);
  const flowY = Math.sin(flowAngle);

  if (kind === 'block-wipe') {
    return {
      ...IDLE_TEMPERA_TRANSITION_FRAME,
      wipe: phase === 'exit' ? eased : 1 + eased,
      wipeAngle: flowAngle,
    };
  }

  if (kind === 'camera-pan') {
    const travel = 0.5;
    const offset = phase === 'exit' ? eased * travel : -(1 - eased) * travel;
    const alpha =
      phase === 'exit' ? 1 - clamp01((linear - 0.72) / 0.28) : clamp01(linear / 0.3);
    return {
      ...IDLE_TEMPERA_TRANSITION_FRAME,
      x: flowX * offset,
      y: flowY * offset,
      scale: 1 + (phase === 'exit' ? eased : 1 - eased) * 0.03,
      alpha,
      wipeAngle: flowAngle,
    };
  }

  // shape-carry
  const drift = (phase === 'exit' ? eased : eased - 1) * 0.09;
  const away = phase === 'exit' ? eased : 1 - eased;
  return {
    ...IDLE_TEMPERA_TRANSITION_FRAME,
    x: flowX * drift,
    y: flowY * drift,
    scale: 1 + away * 0.07,
    alpha: phase === 'exit' ? 1 - clamp01((linear - 0.55) / 0.45) : clamp01(linear / 0.45),
    blur: away * 6,
    wipeAngle: flowAngle,
  };
}

/**
 * 出场帧。上游签名收的是 `paragraph`，这里**按本仓风格改成收 `progress`**
 * （调用方本来就知道进度，这样更好测、也不把类型耦合进来）。
 */
export function resolveTemperaExitTransitionFrame(
  kind: TemperaTransitionKind,
  progress: number,
  flowAngle: number,
): TemperaTransitionFrame {
  return resolveTemperaTransitionEffectFrame(kind, 'exit', progress, flowAngle);
}

export interface TemperaEnterTransitionOptions {
  enabled: boolean;
  /** 从转场起点算起已经过了多久（秒）。 */
  timeSinceStart: number;
  /** 转场总时长（秒）。 */
  duration: number;
}

/**
 * 进场帧：**不在窗口内一律返回空闲帧**（上游同样如此：`!enabled || !kind
 * || timeSinceStart < 0 || timeSinceStart > duration`）。
 * 窗口内以 `timeSinceStart / max(duration, 0.001)` 为进度。
 */
export function resolveTemperaEnterTransitionFrame(
  kind: TemperaTransitionKind | null,
  options: TemperaEnterTransitionOptions,
  flowAngle: number,
): TemperaTransitionFrame {
  const { enabled, timeSinceStart, duration } = options;
  if (!enabled || kind === null || timeSinceStart < 0 || timeSinceStart > duration) {
    return IDLE_TEMPERA_TRANSITION_FRAME;
  }
  return resolveTemperaTransitionEffectFrame(
    kind,
    'enter',
    timeSinceStart / Math.max(duration, 0.001),
    flowAngle,
  );
}
