/**
 * 播放增益图与淡变原语（P1）。
 *
 * 为什么需要它：`<audio>` 原生的 `volume` 只能瞬间改，没有包络；而「切歌不爆音、暂停不硬停」
 * 要的是几十到几百毫秒的**斜坡**。Web Audio 的 `AudioParam.linearRampToValueAtTime` 在音频
 * 线程上做这件事，比在 JS 里 16ms 一 tick 改音量更准，也不怕主线程忙（folia 与 qplayer 都
 * 在同一条思路上，前者用 Web Audio、后者用独立调度器）。
 *
 * 图很简单：
 *
 * ```
 * <audio> → MediaElementSource → fadeGain → masterGain → destination
 * ```
 *
 * - `fadeGain` 只由过渡逻辑控制（P2 起会变成双 deck 各自的一份）；
 * - `masterGain` 承载用户音量与静音。
 *
 * **风险**：`createMediaElementSource` 一旦建立，元素的输出就只走这张图；如果 `AudioContext`
 * 停在 `suspended`，播放器会**静音**。所以每次真正播放前都先 `resume()`，并且这里绝不悄悄
 * 吞掉失败——调用方拿得到 `false`，可以退回「不接图」的路径。
 */
export interface FadeGraph {
  readonly context: AudioContext;
  readonly fadeGain: GainNode;
  readonly masterGain: GainNode;
}

/** 自然结束前的提前淡出时长（对齐 qplayer 的 900ms）。 */
export const FADE_OUT_MS = 900;
/** 新歌从静音升到满幅的时长。 */
export const FADE_IN_MS = 700;
/** 手动切歌时上一首的收尾淡出：短，因为用户在等下一首。 */
export const CUT_FADE_MS = 90;
/** 暂停 / 恢复的斜坡：短到听不出「慢慢变小声」，长到不爆音。 */
export const PAUSE_FADE_MS = 90;
/** 用户音量变化的斜坡：够短，拖滑块时跟手。 */
const MASTER_RAMP_SEC = 0.03;

let graph: FadeGraph | undefined;
/** 每次 fade 调用递增；用来让「被后一次 fade 顶掉」的等待立即返回。 */
let generation = 0;
let cancelPendingFade: (() => void) | undefined;
/** 图还没建时用户就调过音量：记下来，建图那一刻补上。 */
let pendingMaster = { volume: 1, muted: false };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 建图（幂等）。**必须在用户手势之后**调用，否则 AudioContext 会停在 suspended。
 *
 * 元素只允许被 `createMediaElementSource` 接管一次，所以这里缓存单例；重复调用直接返回。
 * 返回 `undefined` 表示当前环境没有 `AudioContext`（纯 Node 单测），调用方应退回原生音量——
 * 所有 fade 原语对 `undefined` 图都直接 no-op。
 */
export function ensureGraph(element: HTMLAudioElement): FadeGraph | undefined {
  if (graph) return graph;
  if (typeof AudioContext === 'undefined') return undefined;
  const context = new AudioContext();
  const source = context.createMediaElementSource(element);
  const fadeGain = context.createGain();
  const masterGain = context.createGain();
  source.connect(fadeGain);
  fadeGain.connect(masterGain);
  masterGain.connect(context.destination);
  fadeGain.gain.value = 1;
  masterGain.gain.value = pendingMaster.muted ? 0 : clamp01(pendingMaster.volume);
  graph = { context, fadeGain, masterGain };
  // 建图这一刻就试着跑起来：能起来的话，后续播放不必等一次 resume。
  void context.resume().catch(() => {});
  return graph;
}

/**
 * 确保音频图在跑。返回 `false` 表示它仍是 suspended —— 这时候如果已经在放，
 * 声音是出不来的，调用方要据此决定是不是把 `<audio>` 退回原生输出。
 */
export async function resumeGraph(): Promise<boolean> {
  if (!graph) return true;
  if (graph.context.state === 'running') return true;
  try {
    await graph.context.resume();
  } catch (error) {
    console.warn('[pi/transition] AudioContext 恢复失败，可能静音：', error);
  }
  // 读一次存到局部变量：`state` 是 getter，TS 7 把它收窄成「刚创建 = 不可能 running」，
  // 直接写比较表达式会报错，而 await 之后本来也该重新读。
  const state = graph.context.state as AudioContextState;
  return state === 'running';
}

export function isGraphReady(): boolean {
  return graph !== undefined;
}

export function getFadeGain(): number {
  return graph ? graph.fadeGain.gain.value : 1;
}

/** 用户音量 / 静音：走 masterGain，30ms 斜坡，避免拖滑块时的 zipper noise。 */
export function setMasterVolume(volume: number, muted: boolean): void {
  const target = muted ? 0 : clamp01(volume);
  if (!graph) {
    pendingMaster = { volume, muted };
    return;
  }
  const now = graph.context.currentTime;
  const param = graph.masterGain.gain;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + MASTER_RAMP_SEC);
}

function anchor(param: AudioParam, context: AudioContext): number {
  const now = context.currentTime;
  const current = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(current, now);
  return now;
}

/** 取消上一次 fade 的「等待」并让它立即返回（新的 fade 接管时用）。 */
function takeOver(): void {
  generation += 1;
  cancelPendingFade?.();
  cancelPendingFade = undefined;
}

/** 从当前增益升到满幅。 */
export function fadeIn(durationMs = FADE_IN_MS): void {
  if (!graph) return;
  takeOver();
  const { context, fadeGain } = graph;
  const param = fadeGain.gain;
  const now = anchor(param, context);
  param.linearRampToValueAtTime(1, now + Math.max(0, durationMs) / 1000);
}

/**
 * 从当前增益降到静音。返回的 Promise 在淡出完成**或**被后一次 fade 顶掉时立即 resolve，
 * 所以调用方不会因为用户中途点了恢复键而被卡在半路。
 */
export function fadeOut(durationMs = FADE_OUT_MS): Promise<void> {
  if (!graph) return Promise.resolve();
  takeOver();
  const { context, fadeGain } = graph;
  const param = fadeGain.gain;
  const seconds = Math.max(0, durationMs) / 1000;
  const now = anchor(param, context);
  param.linearRampToValueAtTime(0, now + seconds);
  const token = generation;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (token === generation) cancelPendingFade = undefined;
      resolve();
    }, seconds * 1000 + 40);
    cancelPendingFade = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/**
 * 立刻回到满幅（不带斜坡）。用在 seek 上：用户把进度拖回中间，就不该继续停在
 * 「歌尾已经淡出」的静音状态里——qplayer 踩过这个坑（拖回尾部再播会整首无声）。
 */
export function resetFade(): void {
  if (!graph) return;
  takeOver();
  const { context, fadeGain } = graph;
  const now = context.currentTime;
  fadeGain.gain.cancelScheduledValues(now);
  fadeGain.gain.setValueAtTime(1, now);
}

/** 触发歌尾淡出时允许的观察误差（秒）：看门狗 200ms 一跳，留一点余量。 */
const TAIL_FADE_SLACK_SEC = 0.05;

/**
 * 歌尾是不是该开始淡出了。
 *
 * 抽成纯函数的原因：真正的调度在 `state/player.ts` 的看门狗里（读 `currentTime`、开定时器），
 * 那部分依赖真音频元素、不好测；而**判定**才是容易写错的地方（边界、NaN、重复触发），
 * 单独放在这里就能被单测钉住。
 *
 * @param remainingSec 距离歌曲结束还有多少秒（`duration - currentTime`）
 * @param armed 这一遍播放是不是已经淡过出了（每首歌只淡一次）
 * @param fadeOutSec 淡出时长，默认 `FADE_OUT_MS`
 */
export function shouldStartTailFade(
  remainingSec: number,
  armed: boolean,
  fadeOutSec = FADE_OUT_MS / 1000,
): boolean {
  if (armed) return false;
  if (!Number.isFinite(remainingSec) || remainingSec <= 0) return false;
  return remainingSec <= fadeOutSec + TAIL_FADE_SLACK_SEC;
}
