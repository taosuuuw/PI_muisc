import type { TrackProfile } from './profile';

/**
 * AutoMix 的过渡规划（P4 的决策层）。
 *
 * 输入是两首歌的 `TrackProfile`（P3 分析出来的拍网格与首尾形态）和出场曲的剩余时间，
 * 输出是「用哪种接法、多长、要不要变速、为什么」。真正动手的调度在
 * `state/player.ts` 与 `lib/transition/automix-graph.ts`；这一层是纯函数，规则能逐条钉住。
 *
 * 为什么要规划而不是固定 5 秒：两首歌的拍长、尾部有没有内容、进场曲是不是一上来就满电平，
 * 决定了「叠多久」「谁先让低频」「要不要弯速度」。把这些写死，结果就是有的歌接得很顺、
 * 有的歌糊成一片——而且出了问题无从解释。`reason` 就是给人看的交代。
 */
export interface TransitionPlanInput {
  outgoing?: TrackProfile;
  incoming?: TrackProfile;
  /** 出场曲还剩多少秒。 */
  remainingSec: number;
  /** 没有可靠拍网格时的兜底时长（沿用 P2 的 5 秒）。 */
  fallbackDurationSec?: number;
}

export type TransitionStyle = 'beatCut' | 'bassSwap' | 'tailRide' | 'plainBlend';

export interface TransitionPlan {
  style: TransitionStyle;
  /** 墙钟时间上的过渡长度（秒）。 */
  durationSec: number;
  /** 出场曲的 `playbackRate`（1 = 不变）。 */
  tempoRatio: number;
  /** 可读的解释，直接进日志。 */
  reason: string;
}

/** 只弯出场曲，且最多 ±12%（超过这个量人耳会明显觉得「跑调/赶」）。 */
export const STRETCH_LIMIT = 0.12;
/** 拍网格置信度低于这个数就当没有（0.25 是随机信号的水平）。 */
const MIN_GRID_CONFIDENCE = 0.3;
/** 一小节几拍（4/4）。 */
const BEATS_PER_BAR = 4;
/** 最长按一个乐句（16 拍 = 4 小节）收尾；短于此的整小节数依次退让。 */
const PHRASE_BEATS = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface Grid {
  periodSec: number;
  confidence: number;
}

function usableGrid(profile: TrackProfile | undefined): Grid | undefined {
  if (!profile) return undefined;
  if (profile.beatPeriodSec === null || profile.beatPeriodSec <= 0) return undefined;
  if (profile.confidence < MIN_GRID_CONFIDENCE) return undefined;
  return { periodSec: profile.beatPeriodSec, confidence: profile.confidence };
}

/**
 * 规划一次过渡。
 *
 * 规则（按优先级）：
 * 1. **两端都有可用拍网格** → 把过渡长度量化到整小节（4/8/16 拍，且不超过剩余时间），
 *    并让出场曲变速去贴进场曲的拍长（±12%）；进场曲「一上来就满电平」时用 `bassSwap`
 *    （低频交错让位，避免叠在一起发浑），否则 `beatCut`。
 * 2. **出场曲有尾部静音** → `tailRide`：长度随静音拉长（4~8 秒），不用变速——
 *    那种歌通常本来就不需要卡拍。
 * 3. **什么都没有** → `plainBlend`：固定兜底时长，行为与 P2 的交叉一致。
 */
export function planTransition(input: TransitionPlanInput): TransitionPlan {
  const fallback = input.fallbackDurationSec ?? 5;
  const outGrid = usableGrid(input.outgoing);
  const inGrid = usableGrid(input.incoming);

  if (outGrid && inGrid) {
    const rawRatio = outGrid.periodSec / inGrid.periodSec;
    const tempoRatio = clamp(rawRatio, 1 - STRETCH_LIMIT, 1 + STRETCH_LIMIT);
    const stretched = Math.abs(rawRatio - tempoRatio) > 1e-6;
    const period = outGrid.periodSec;
    // 剩余时间里放得下几拍；量化到整小节，再依次退让到 8 拍、4 拍。
    const maxBeats = Math.floor(input.remainingSec / period);
    let beats = 0;
    for (const candidate of [PHRASE_BEATS, BEATS_PER_BAR * 2, BEATS_PER_BAR]) {
      if (maxBeats >= candidate) {
        beats = candidate;
        break;
      }
    }
    if (beats >= BEATS_PER_BAR) {
      // 变速后拍长变成 period/tempoRatio，所以墙钟时长按这个算。
      const durationSec = (beats * period) / tempoRatio;
      const startsHot = input.incoming?.head.startsHot ?? false;
      return {
        style: startsHot ? 'bassSwap' : 'beatCut',
        durationSec,
        tempoRatio,
        reason:
          `两端有拍网格（${(60 / period).toFixed(1)} → ${(60 / inGrid.periodSec).toFixed(1)} BPM），` +
          `过渡量化到 ${beats} 拍` +
          (stretched ? `、变速 ${((tempoRatio - 1) * 100).toFixed(1)}%` : '、BPM 足够接近不变速') +
          (startsHot ? '，进场曲一上来就满电平 → bassSwap 低频让位' : ''),
      };
    }
  }

  const silence = input.outgoing?.tail.silenceSec ?? 0;
  if (silence > 0.5) {
    const durationSec = clamp(fallback + silence * 0.5, 4, 8);
    return {
      style: 'tailRide',
      durationSec,
      tempoRatio: 1,
      reason: `尾部有 ${silence.toFixed(2)}s 静音 → tailRide，过渡拉到 ${durationSec.toFixed(1)}s`,
    };
  }

  return {
    style: 'plainBlend',
    durationSec: fallback,
    tempoRatio: 1,
    reason: '缺少可靠拍网格 → plainBlend，用固定时长交叉',
  };
}
