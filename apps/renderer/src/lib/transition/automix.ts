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
  /** 出场曲总时长（秒）。有段落表时用它把「副歌结束点」换算成提前量。 */
  outgoingDurationSec?: number;
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
  /**
   * 进场曲从第几秒开始播（跳过纯静音前奏）。
   *
   * 这是「DJ 式」与「歌尾接歌头」的第一处差别：真正的混音不会让下一首从 0 秒开始
   * 空转几秒前奏。这里只跳**测出来是静音**的那一段（最多 8 秒）；有内容的前奏不动，
   * 因为那可能就是歌的一部分。
   */
  incomingStartSec: number;
  /**
   * 提前多少秒起手（在歌还没放完时就开始过渡）。
   *
   * DJ 是在旧歌的 outro 段动手，不是在最后一个音结束的瞬间。这里用 4 小节作为提前量，
   * 让「旧歌的收尾」和「新歌的进入」真正叠在一起；没有拍网格时退回 0（照旧在歌尾）。
   */
  leadInSec: number;
  /**
   * 播放器应该在「还剩多少秒」时开始这次过渡。
   *
   * 有段落表时这是「最后一个副歌结束点」换算出来的剩余（真正的结构对齐）；
   * 没有段落表时就是 `durationSec + leadInSec`（提前 4 小节）。
   */
  startAtRemainingSec: number;
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
/** 提前多少拍起手（4 小节）——这让过渡落在旧歌的 outro 段里。 */
const LEAD_IN_BEATS = 16;
/** 提前量的上限（秒），防止慢歌把起手点拉到很不合理的位置。 */
const MAX_LEAD_IN_SEC = 20;
/**
 * 起手点的上限（秒）。
 *
 * 分析一首歌要 10~14 秒（Beat This! + 结构），而预取窗口是 60 秒——起手点如果比
 * 「预取时刻 − 分析耗时」还早，交叉就会在档案落盘之前开始，等于白等。45 秒是留足余量的上限。
 */
const MAX_START_AT_REMAINING_SEC = 45;
/** 进场曲最多跳过多少秒静音前奏。 */
const MAX_INCOMING_SKIP_SEC = 8;

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

/** 旧歌最后一个「副歌类」段在哪里结束（秒）。没有段落表/没有重复类时返回 `null`。 */
function lastChorusEndSec(outgoing: TrackProfile | undefined): number | null {
  const sections = outgoing?.sections;
  const chorusClassId = outgoing?.chorusClassId;
  if (!sections || sections.length === 0) return null;
  if (chorusClassId === null || chorusClassId === undefined) return null;
  const chorus = sections.filter((section) => section.classId === chorusClassId);
  if (chorus.length === 0) return null;
  return chorus[chorus.length - 1]?.endSec ?? null;
}

/**
 * 起手点（还剩多少秒）。
 *
 * 结构对齐时，从「最后一个副歌结束」处开始混——那通常正是 outro 的入口。
 * 但也要给过渡本身留够长度，否则会出现「还没叠够就被迫切」的情况。
 */
function resolveStartAtRemaining(
  input: TransitionPlanInput,
  durationSec: number,
  leadInSec: number,
): { startAtRemainingSec: number; fromSection: boolean } {
  const chorusEndSec = lastChorusEndSec(input.outgoing);
  const total = input.outgoingDurationSec;
  if (chorusEndSec !== null && total !== undefined && total > chorusEndSec) {
    const untilTail = total - chorusEndSec;
    return {
      startAtRemainingSec: Math.min(
        MAX_START_AT_REMAINING_SEC,
        Math.max(durationSec + 2, untilTail),
      ),
      fromSection: true,
    };
  }
  return {
    startAtRemainingSec: Math.min(
      MAX_START_AT_REMAINING_SEC,
      durationSec + leadInSec,
    ),
    fromSection: false,
  };
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
      /*
       * 提前量：4 小节（16 拍）。这让过渡发生在旧歌的 outro 段里，而不是最后一个音之后——
       * 也就是「歌还没放完就开始混」。上限 20 秒，避免 60 BPM 的歌把提前量拉得离谱。
       */
      const leadInSec = Math.min(MAX_LEAD_IN_SEC, (LEAD_IN_BEATS * period) / tempoRatio);
      // 只跳过**测出来是静音**的前奏；有内容的前奏不动（那可能是歌的一部分）。
      const incomingStartSec = Math.min(
        MAX_INCOMING_SKIP_SEC,
        input.incoming?.head.silenceSec ?? 0,
      );
      // 结构对齐：有段落表就从最后一个副歌的结束处混入，否则按 4 小节提前。
      const { startAtRemainingSec, fromSection } = resolveStartAtRemaining(
        input,
        durationSec,
        leadInSec,
      );
      return {
        style: startsHot ? 'bassSwap' : 'beatCut',
        durationSec,
        tempoRatio,
        incomingStartSec,
        leadInSec,
        startAtRemainingSec,
        reason:
          `两端有拍网格（${(60 / period).toFixed(1)} → ${(60 / inGrid.periodSec).toFixed(1)} BPM），` +
          `过渡量化到 ${beats} 拍` +
          (fromSection
            ? `、从最后一个副歌结束处混入（提前 ${startAtRemainingSec.toFixed(1)}s）`
            : `、提前 ${leadInSec.toFixed(1)}s 在 outro 段起手`) +
          (stretched ? `、变速 ${((tempoRatio - 1) * 100).toFixed(1)}%` : '、BPM 足够接近不变速') +
          (incomingStartSec > 0.2 ? `、进场跳过 ${incomingStartSec.toFixed(1)}s 静音前奏` : '') +
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
      incomingStartSec: Math.min(MAX_INCOMING_SKIP_SEC, input.incoming?.head.silenceSec ?? 0),
      leadInSec: 0,
      startAtRemainingSec: durationSec,
      reason: `尾部有 ${silence.toFixed(2)}s 静音 → tailRide，过渡拉到 ${durationSec.toFixed(1)}s`,
    };
  }

  return {
    style: 'plainBlend',
    durationSec: fallback,
    tempoRatio: 1,
    incomingStartSec: 0,
    leadInSec: 0,
    startAtRemainingSec: fallback,
    reason: '缺少可靠拍网格 → plainBlend，用固定时长交叉',
  };
}
