/**
 * 商籁（sonnet）**帧层的数值部分**：音频驱动、入场进度、几何变体的旋转规则。
 *
 * === AGPL 说明 ===
 * folia-major 是 AGPL-3.0。这里只借鉴**数值与做法**，全部在本仓库重写：
 * 音频三路加权、门限与幂次、攻击/释放两组平滑系数、图标姿态公式、入场进度的"最后一拍"处理、旋转白名单。
 * 数值出处：folia 的 `sonnet/sonnetShotMg.ts` 里 `updateTime` 那一段（第 18 轮取回）。
 *
 * === 为什么先落这一层 ===
 * 它是整套渲染里**唯一不依赖 Pixi** 的部分：给定时间、音频电平与种子就能算出"这一刻该长什么样"，
 * 所以可以像凝彩的帧层那样单测；渲染层只负责把这些数字画出来。
 */

type AudioLevel = number;

/** 音频电平归一化：大于 1 的按 0..255 当作原始字节，否则当成已经归一化过的比例。 */
export function normalizeSonnetAudioLevel(value: AudioLevel): number {
  return Math.min(1, Math.max(0, value > 1 ? value / 255 : value));
}

/** 三路音频的权重：人声最重、低音次之、整体功率最轻。 */
export const SONNET_AUDIO_WEIGHTS = { bass: 0.34, vocal: 0.52, power: 0.14 } as const;
/** 低于这个能量就当作空闲底噪，直接抹掉。 */
export const SONNET_AUDIO_GATE = 0.08;
/** 抹掉底噪之后把剩下的区间重新拉满。 */
export const SONNET_AUDIO_EXPAND = 0.92;
/** 幂次 < 1：中等峰值也要看得出来，不然只有爆点才有反应。 */
export const SONNET_AUDIO_CURVE = 0.68;
/** 整体增益。 */
export const SONNET_AUDIO_GAIN = 1.35;
/** 上升快、回落慢：跟着鼓点跳起来，但不会一闪一闪。 */
export const SONNET_AUDIO_ATTACK = 0.34;
export const SONNET_AUDIO_RELEASE = 0.16;

/** 三路合成一个能量值（0..1）。 */
export function resolveSonnetAudioEnergy(
  bass: AudioLevel,
  vocal: AudioLevel,
  power: AudioLevel,
): number {
  return (
    normalizeSonnetAudioLevel(bass) * SONNET_AUDIO_WEIGHTS.bass +
    normalizeSonnetAudioLevel(vocal) * SONNET_AUDIO_WEIGHTS.vocal +
    normalizeSonnetAudioLevel(power) * SONNET_AUDIO_WEIGHTS.power
  );
}

/** 能量 → 图标的目标强度（去底噪、重拉伸、压曲线、加增益，最后夹到 1）。 */
export function resolveSonnetIconAudioTarget(energy: number): number {
  const gated = Math.max(0, (energy - SONNET_AUDIO_GATE) / SONNET_AUDIO_EXPAND);
  return Math.min(1, Math.pow(gated, SONNET_AUDIO_CURVE) * SONNET_AUDIO_GAIN);
}

/** 一步平滑：朝目标靠过去，上升用攻击系数、回落用释放系数。 */
export function smoothSonnetIconAudio(previous: number, target: number): number {
  const rate = target > previous ? SONNET_AUDIO_ATTACK : SONNET_AUDIO_RELEASE;
  return previous + (target - previous) * rate;
}

/**
 * 图标入场时长（**第 550 轮对齐上游**）。
 *
 * ⚠ 我原先写的是 `max(preferred, scene × 0.28)` ✗ —— 直到第 549 轮"去重"把两套实现并到一起，
 * 才发现它**与上游公式不同**（`0.28` vs `0.18`、`max` vs `min` ✓）。
 * 上游（`sonnet/sonnetIcons.ts`，全文已取回 ✓）是：
 * `min(max(0.01, preferred), max(0.08, scene × 0.18), scene)`
 * ⇒ 语义是"**时长取三者中最小**"：不超偏好 ✓、不超场景的 18% ✓、也不超整个场景 ✓
 * （场景时长先兜到 `0.01` ✓）。⇒ 现在**照抄上游** ✓。
 */
export function resolveSonnetIconEntryDuration(
  sceneDuration: number,
  preferredDuration: number,
): number {
  const safeSceneDuration = Math.max(0.01, sceneDuration);
  return Math.min(
    Math.max(0.01, preferredDuration),
    Math.max(0.08, safeSceneDuration * 0.18),
    safeSceneDuration,
  );
}

/** 图标入场延迟：按入场相位把图标摊在整个场景的前段里（后段留给循环脉动）。 */
export function resolveSonnetIconEntryDelay(
  entryPhase: number,
  sceneDuration: number,
  entryDuration: number,
): number {
  const window = Math.max(0, sceneDuration - entryDuration);
  return Math.min(window, Math.max(0, entryPhase) * window);
}

export interface SonnetIconPose {
  readonly alpha: number;
  readonly scale: number;
}

/**
 * 一个图标这一刻的透明度与缩放。
 *
 * 三股力量叠在一起：入场进度（三次缓出）、音频强度、以及一圈慢速脉动 ——
 * 音频只放大 **0.42 倍**，因为它该是"呼吸"而不是"打拍子"。
 */
export function resolveSonnetIconPose(options: {
  readonly baseAlpha: number;
  readonly baseScale: number;
  readonly entryProgress: number;
  readonly audio: number;
  readonly phase: number;
  readonly timeInScene: number;
}): SonnetIconPose {
  const entry = Math.min(1, Math.max(0, options.entryProgress));
  const entryEased = 1 - Math.pow(1 - entry, 3);
  const loopPulse = (Math.sin(options.timeInScene * Math.PI * 0.7 + options.phase) + 1) * 0.5;
  const audioScale = 1 + options.audio * 0.42;
  const loopScale = 1 + loopPulse * 0.025;
  return {
    alpha: Math.min(
      1,
      options.baseAlpha * entryEased * (0.72 + options.audio * 0.38 + loopPulse * 0.03),
    ),
    scale: options.baseScale * (0.72 + entryEased * 0.28) * audioScale * loopScale,
  };
}

export interface SonnetSceneProgress {
  readonly progress: number;
  readonly drawDuration: number;
  readonly targetFinishTime: number;
}

/**
 * 这一段镜头画到哪儿了。
 *
 * 照抄的关键一条：**收笔时间不是"最后一个字的开始"**。
 * 若最后一个字是长音，光用它开始的时间会让背景早早画完然后僵在那里；
 * 所以收笔取 `max(最后一个提示的时刻, 起点 + 总时长 × 0.95)`，再夹回结束时间。
 */
export function resolveSonnetSceneProgress(
  time: number,
  startTime: number,
  endTime: number,
  cueTimes: readonly number[],
): SonnetSceneProgress {
  const span = Math.max(0, endTime - startTime);
  const horizon = startTime + span * 0.95;
  const lastCue = cueTimes.length > 0 ? (cueTimes[cueTimes.length - 1] ?? horizon) : horizon;
  const targetFinishTime = Math.min(endTime, Math.max(lastCue, horizon));
  const drawDuration = Math.max(1, targetFinishTime - startTime);
  return {
    progress: Math.min(1, Math.max(0, (time - startTime) / drawDuration)),
    drawDuration,
    targetFinishTime,
  };
}

/**
 * 保持**正立**的几何变体：这些变体自己带方向（线框山脉要水平、HUD 框要正、等距方块要正等测…），
 * 跟着随机角度转一下就不成立了。其余变体才吃 `seed` 的任意角度。
 */
export const SONNET_UPRIGHT_GEO_VARIANTS: readonly number[] = [6, 8, 9, 14, 15, 16, 17, 20, 22, 23];

/** HUD 框（变体 8）按 90° 的整数倍转，不按任意角。 */
export const SONNET_HUD_GEO_VARIANT = 8;

/** 某一镜的几何变体该转多少弧度。 */
export function resolveSonnetGeoRotation(
  seed: number,
  variant: number,
  /** "主题化变体"的起始编号；取到 `sonnetThemedShotMg.ts` 之前由调用方传入。 */
  themedVariantStart: number,
): number {
  const keepsUpright =
    SONNET_UPRIGHT_GEO_VARIANTS.includes(variant) || variant >= themedVariantStart;
  if (!keepsUpright) return ((seed * 13) % 360) * (Math.PI / 180);
  if (variant === SONNET_HUD_GEO_VARIANT) {
    // 90° 的整数倍：`seed` 先折到 0..3，再乘四分之一圈。
    return ((seed % 4) + 4) % 4 * (Math.PI / 2);
  }
  return 0;
}
