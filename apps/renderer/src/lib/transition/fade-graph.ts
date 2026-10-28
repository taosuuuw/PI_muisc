/**
 * 播放增益图与淡变原语（P1 单 deck → P2 双 deck）。
 *
 * 为什么需要它：`<audio>` 原生的 `volume` 只能瞬间改，没有包络；而「切歌不爆音、暂停不硬停」
 * 要的是几十到几百毫秒的**斜坡**。Web Audio 的 `AudioParam` 自动化在音频线程上做这件事，
 * 比在 JS 里 16ms 一 tick 改音量更准，也不怕主线程忙。
 *
 * 图（P2 起是两路）：
 *
 * ```
 * deckA <audio> → sourceA → gainA ┐
 *                                  ├→ masterGain → destination
 * deckB <audio> → sourceB → gainB ┘
 * ```
 *
 * - 每个 deck 有自己的 `gain`，交叉淡化就是两条互补的等功率曲线；
 * - `masterGain` 承载用户音量与静音，过渡碰不到它。
 *
 * **风险**：`createMediaElementSource` 一旦建立，元素的输出就只走这张图；如果 `AudioContext`
 * 停在 `suspended`，播放器会**静音**。所以每次真正播放前都先 `resume()`。
 *
 * **没有 AudioContext 的环境**（纯 Node 单测）：`ensureGraph` 返回 `undefined`，所有原语 no-op。
 */
export type DeckId = 'a' | 'b';

export interface DeckNodes {
  readonly element: HTMLAudioElement;
  readonly source: MediaElementAudioSourceNode;
  readonly gain: GainNode;
}

export interface FadeGraph {
  readonly context: AudioContext;
  readonly decks: Record<DeckId, DeckNodes>;
  readonly masterGain: GainNode;
  active: DeckId;
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
/** 触发歌尾淡出时允许的观察误差（秒）：看门狗 200ms 一跳，留一点余量。 */
const TAIL_FADE_SLACK_SEC = 0.05;

let graph: FadeGraph | undefined;
/** 图还没建时用户就调过音量：记下来，建图那一刻补上。 */
let pendingMaster = { volume: 1, muted: false };

/**
 * 每个 deck 各有一份「等待取消」把手：交叉淡化时出场曲的淡出与进场曲的淡入是两条独立曲线，
 * 谁都不该被对方的调用顶掉。
 */
const fadeState: Record<DeckId, { generation: number; cancel?: () => void }> = {
  a: { generation: 0 },
  b: { generation: 0 },
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function activeDeck(): DeckId {
  return graph?.active ?? 'a';
}

/**
 * 建图（幂等）。**必须在用户手势之后**调用，否则 AudioContext 会停在 suspended。
 *
 * 两个元素各自只允许被 `createMediaElementSource` 接管一次，所以这里缓存单例。
 * 返回 `undefined` 表示当前环境没有 `AudioContext`（纯 Node 单测）。
 */
export function ensureGraph(
  elements: Record<DeckId, HTMLAudioElement>,
): FadeGraph | undefined {
  if (graph) return graph;
  if (typeof AudioContext === 'undefined') return undefined;
  const context = new AudioContext();
  const masterGain = context.createGain();
  masterGain.gain.value = pendingMaster.muted ? 0 : clamp01(pendingMaster.volume);
  masterGain.connect(context.destination);
  const build = (id: DeckId): DeckNodes => {
    const element = elements[id];
    const source = context.createMediaElementSource(element);
    const gain = context.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(masterGain);
    return { element, source, gain };
  };
  graph = {
    context,
    decks: { a: build('a'), b: build('b') },
    masterGain,
    active: 'a',
  };
  // 建图这一刻就试着跑起来：能起来的话，后续播放不必等一次 resume。
  void context.resume().catch(() => {});
  return graph;
}

/**
 * 确保音频图在跑。返回 `false` 表示它仍是 suspended —— 这时候如果已经在放，声音是出不来的。
 */
export async function resumeGraph(): Promise<boolean> {
  if (!graph) return true;
  if (graph.context.state === 'running') return true;
  try {
    await graph.context.resume();
  } catch (error) {
    console.warn('[pi/transition] AudioContext 恢复失败，可能静音：', error);
  }
  // 读一次存到局部变量：`state` 是 getter，TS 7 把它收窄成「刚创建 = 不可能 running」。
  const state = graph.context.state as AudioContextState;
  return state === 'running';
}

export function isGraphReady(): boolean {
  return graph !== undefined;
}

/** 当前活动 deck（`window.__piAudio` 与所有事件都跟着它走）。 */
export function getActiveDeck(): DeckId {
  return activeDeck();
}

/** 切活动 deck。只改路由，不动增益——增益曲线由 `crossfade` / `fadeIn` 负责。 */
export function setActiveDeck(id: DeckId): void {
  if (graph) graph.active = id;
}

/** 当前活动 deck 的增益（0~1）。 */
export function getFadeGain(deck: DeckId = activeDeck()): number {
  return graph ? graph.decks[deck].gain.gain.value : 1;
}

/** 直接把某个 deck 设成满幅/静音（不带斜坡）。 */
export function setDeckGain(deck: DeckId, value: number): void {
  if (!graph) return;
  takeOver(deck);
  const param = graph.decks[deck].gain.gain;
  const now = graph.context.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(Math.min(1, Math.max(0, value)), now);
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

/** 取消某个 deck 上一次 fade 的「等待」并让它立即返回（新的 fade 接管时用）。 */
function takeOver(deck: DeckId): void {
  fadeState[deck].generation += 1;
  fadeState[deck].cancel?.();
  fadeState[deck].cancel = undefined;
}

function runFade(
  deck: DeckId,
  target: number,
  durationMs: number,
): Promise<void> {
  if (!graph) return Promise.resolve();
  takeOver(deck);
  const { context, decks } = graph;
  const param = decks[deck].gain.gain;
  const seconds = Math.max(0, durationMs) / 1000;
  const now = anchor(param, context);
  param.linearRampToValueAtTime(target, now + seconds);
  const token = fadeState[deck].generation;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (token === fadeState[deck].generation) fadeState[deck].cancel = undefined;
      resolve();
    }, seconds * 1000 + 40);
    fadeState[deck].cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/** 从当前增益升到满幅（默认作用活动 deck）。 */
export function fadeIn(durationMs = FADE_IN_MS, deck: DeckId = activeDeck()): void {
  void runFade(deck, 1, durationMs);
}

/**
 * 从当前增益降到静音（默认作用活动 deck）。返回的 Promise 在淡出完成**或**被后一次 fade
 * 顶掉时立即 resolve，调用方不会因为用户中途点了恢复键而被卡在半路。
 */
export function fadeOut(durationMs = FADE_OUT_MS, deck: DeckId = activeDeck()): Promise<void> {
  return runFade(deck, 0, durationMs);
}

/**
 * 立刻回到满幅（不带斜坡）。用在 seek 上：用户把进度拖回中间，就不该继续停在
 * 「歌尾已经淡出」的静音状态里——qplayer 踩过这个坑（拖回尾部再播会整首无声）。
 */
export function resetFade(deck: DeckId = activeDeck()): void {
  if (!graph) return;
  takeOver(deck);
  const now = graph.context.currentTime;
  const param = graph.decks[deck].gain.gain;
  param.cancelScheduledValues(now);
  param.setValueAtTime(1, now);
}

/**
 * 双 deck 交叉淡化：出场曲线的平方 + 进场曲线的平方 = 1（等功率），所以中间不会塌一个洞。
 *
 * 调用方负责在 `play()` 之后、调用本函数之前把活动 deck 切过去（`setActiveDeck`），
 * 这样 `window.__piAudio`、进度与歌词从交叉开始那一刻就跟新歌走。
 *
 * 返回的 Promise 在曲线画完时 resolve；调用方随后暂停出场 deck 并把它的增益复位。
 */
export function crossfade(from: DeckId, to: DeckId, seconds: number): Promise<void> {
  if (!graph) return Promise.resolve();
  const duration = Math.max(0.1, seconds);
  const { context, decks } = graph;
  const now = context.currentTime;
  const points = 128;
  const rise = new Float32Array(points);
  const fall = new Float32Array(points);
  for (let i = 0; i < points; i += 1) {
    const t = i / (points - 1);
    rise[i] = Math.sin((t * Math.PI) / 2);
    fall[i] = Math.cos((t * Math.PI) / 2);
  }
  const fromGain = decks[from].gain.gain;
  const toGain = decks[to].gain.gain;
  takeOver(from);
  takeOver(to);
  const fromNow = Math.min(1, Math.max(0, fromGain.value));
  toGain.cancelScheduledValues(now);
  toGain.setValueAtTime(0, now);
  fromGain.cancelScheduledValues(now);
  fromGain.setValueAtTime(fromNow, now);
  // 出场曲线从「当前值」出发，而不是从 1 出发：万一交叉被叫停前它已经在淡出，也不会跳变。
  if (fromNow < 0.999) {
    const scaled = new Float32Array(points);
    for (let i = 0; i < points; i += 1) scaled[i] = (fall[i] ?? 0) * fromNow;
    fromGain.setValueCurveAtTime(scaled, now, duration);
  } else {
    fromGain.setValueCurveAtTime(fall, now, duration);
  }
  toGain.setValueCurveAtTime(rise, now, duration);
  return new Promise((resolve) => setTimeout(resolve, duration * 1000 + 60));
}

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
