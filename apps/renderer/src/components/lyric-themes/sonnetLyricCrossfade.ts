/**
 * 商籁**歌词换句时的交叉淡变**（纯状态机，可单测）。
 *
 * === 它解决什么 ===
 * 渲染层是**单 world + 按 index 复用的字形池**：新镜头一上来，池里的节点就被覆盖写，
 * 旧句子在**同一帧**消失 ⇒ 观感是"新旧歌词硬切"。这里给出换句时"两幅画面短暂共存"的
 * 两个透明度：旧画面淡出、新画面淡入。
 *
 * ⚠ **两个 α 的和恒为 1 只是"两层互补"这个数学事实**，它**不保证屏幕上一定有字** ——
 * 新句的字可能还没轮到入场（逐字 α 仍为 0），旧句可能已经快淡完。这里保证的是"过渡连续、
 * 不出现硬切"，可见性由逐字入场那套自己负责，不要拿"和为 1"当"始终有字"的证明。
 *
 * === 为什么进度用**墙钟**而不是唱词时间 ===
 * 唱词时间轴是**被拖动**的：拖动进度条会让它一步跳很远。淡变是"换镜这一下"的观感补丁，
 * 它的进度与拖动无关 —— 拖动时本来就不该补间（要直接切到目标时刻），所以：
 * · 签名变化 + 时间**连续**（|Δt| ≤ 阈值、且不倒着走）⇒ 开始一段交叉淡变，用 `nowMs` 推进；
 *   **暂停**时 `nowMs` 照走 ⇒ 淡变不会卡在半透明。
 * · 时间**跳变 / 倒退 / 视口变化 / 换 program / reduced motion / 淡变未走完又换句** ⇒
 *   都判为"旧的出场画面已经失效"：直接切（`phase = 'seek'`），旧的出场画面立刻丢弃，
 *   不做补间。
 *
 * 状态是**不可变**的：`advanceSonnetLyricCrossfade` 返回新状态，同一个输入反复求值结果相同
 * （seek 可重放、帧率无关）。
 */

/** 默认重叠窗口（毫秒）：新旧两幅歌词同时可见的时长。 */
export const SONNET_LYRIC_CROSSFADE_MS = 320;
/**
 * 判为"拖动 / 换歌跳变"的时刻阈值（秒）：相邻两帧的唱词时刻差超过它、或时刻倒退，
 * 就不是正常换句，直接切。
 */
export const SONNET_LYRIC_CROSSFADE_SEEK_SECONDS = 0.5;

/** 歌词身份：同一段歌词（同一镜、同一串字）算同一个签名。 */
export interface SonnetLyricSignatureSource {
  readonly text: string;
  /** 巨大幽灵字（装饰）不进签名：它与正文同生同灭，进不进都不改变换句时刻。 */
  readonly ghost: boolean;
}

export interface SonnetLyricCrossfadeState {
  /** 当前（淡入中 / 已就位）的歌词签名。 */
  readonly signature: string;
  /** 正在淡出的歌词签名；空串 = 没有出场画面。 */
  readonly outgoingSignature: string;
  /** 这一段淡变的起始墙钟（毫秒）。 */
  readonly startedAtMs: number;
  /** 上一帧的唱词时刻（秒）—— 用来判"是否连续"。 */
  readonly lastTimeSec: number;
  /** 上一帧的视口标识 —— 变了就说明 resize，出场画面的坐标已过期。 */
  readonly viewportKey: string;
  /** 上一帧的 program 身份 —— 换了（切歌）就说明出场画面属于另一首歌，必须丢弃。 */
  readonly programKey: string;
  /** 有没有过第一帧（没有 ⇒ 不补间，直接落位）。 */
  readonly live: boolean;
}

export interface SonnetLyricCrossfadeInput {
  readonly signature: string;
  readonly timeSec: number;
  /** 墙钟（毫秒）。淡变进度只吃它。 */
  readonly nowMs: number;
  /** 视口标识（如 `1180x760`）；缺省空串。 */
  readonly viewportKey?: string;
  /** program 身份（如编译种子的字符串）；缺省空串。 */
  readonly programKey?: string;
  /** 系统"减少动态效果"：开 ⇒ 不出场画面（旧层立刻丢弃，换句直接切）。 */
  readonly reducedMotion?: boolean;
}

export interface SonnetLyricCrossfadeOptions {
  readonly durationMs?: number;
  readonly seekThresholdSeconds?: number;
}

/** `hold` = 没有换句；`fade` = 正在交叉淡变；`seek` = 判为拖动 / 跳变，直接切。 */
export type SonnetLyricCrossfadePhase = 'hold' | 'fade' | 'seek';

export interface SonnetLyricCrossfadeFrame {
  readonly state: SonnetLyricCrossfadeState;
  /** 出场（旧）画面的透明度 0~1。 */
  readonly outgoingAlpha: number;
  /** 入场（新）画面的透明度 0~1。 */
  readonly incomingAlpha: number;
  readonly phase: SonnetLyricCrossfadePhase;
  /** 淡变进度 0~1（`hold` 且没有出场画面时为 1）。 */
  readonly progress: number;
}

export function createSonnetLyricCrossfadeState(): SonnetLyricCrossfadeState {
  return {
    signature: '',
    outgoingSignature: '',
    startedAtMs: 0,
    lastTimeSec: Number.NaN,
    viewportKey: '',
    programKey: '',
    live: false,
  };
}

/**
 * **歌词身份**：镜 id + 非装饰字形的文本串。
 * 同一镜内每一帧都相同（字是逐帧都在的，只是入场透明度不同）⇒ 只有真的换镜 / 换句才变。
 */
export function resolveSonnetLyricSignature(
  shotId: string,
  glyphs: readonly SonnetLyricSignatureSource[],
): string {
  let text = '';
  for (const glyph of glyphs) {
    if (glyph.ghost) continue;
    text += glyph.text;
  }
  return `${shotId}|${text}`;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 两端导数为 0 的平滑（smoothstep）。两个 α 由它互补：`in = 1 − out`。 */
function smoothstep01(value: number): number {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
}

function seekedFrom(
  state: SonnetLyricCrossfadeState,
  input: SonnetLyricCrossfadeInput,
  threshold: number,
): boolean {
  if (!Number.isFinite(input.timeSec)) return true;
  if (!Number.isFinite(state.lastTimeSec)) return false;
  // Player position updates can correct extrapolation backwards by a few milliseconds.
  // Treat substantial backwards movement as seek, rather than cancelling every normal fade.
  if (input.timeSec < state.lastTimeSec - 0.01) return true;
  return input.timeSec - state.lastTimeSec > threshold;
}

/**
 * 推进一步。返回值里同时给出**新状态**与这一帧该用的两个透明度。
 *
 * 判据（顺序即优先级）：
 * ① 还没出过第一帧 ⇒ 直接落位（不补间）；
 * ② **旧的出场画面是否失效**（时刻跳变 / 倒退、视口变化、program 换人、reduced motion）⇒
 *    `seek`：立刻丢弃出场画面。⚠ 这一条**必须在"同签名"之前判** —— 同签名下的倒退 / 跳转
 *    （同一镜里拖进度条）同样会让旧快照的坐标 / 内容过期，只在"换签名"那一支上判会留下残影；
 * ③ 签名没变 ⇒ 只推进（可能的）淡变；
 * ④ 签名变了：上一段淡变还没走完 ⇒ `seek`（拖进度条每帧换一次句的特征），直接切；
 * ⑤ 否则 ⇒ `fade`：旧签名进 `outgoingSignature`，`nowMs` 起算。
 */
export function advanceSonnetLyricCrossfade(
  state: SonnetLyricCrossfadeState,
  input: SonnetLyricCrossfadeInput,
  options: SonnetLyricCrossfadeOptions = {},
): SonnetLyricCrossfadeFrame {
  const duration = Math.max(1, options.durationMs ?? SONNET_LYRIC_CROSSFADE_MS);
  const threshold = Math.max(
    0,
    options.seekThresholdSeconds ?? SONNET_LYRIC_CROSSFADE_SEEK_SECONDS,
  );
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const viewportKey = input.viewportKey ?? '';
  const programKey = input.programKey ?? '';
  const reducedMotion = input.reducedMotion === true;

  if (!state.live) {
    const next: SonnetLyricCrossfadeState = {
      signature: input.signature,
      outgoingSignature: '',
      startedAtMs: nowMs - duration,
      lastTimeSec: input.timeSec,
      viewportKey,
      programKey,
      live: true,
    };
    return { state: next, outgoingAlpha: 0, incomingAlpha: 1, phase: 'hold', progress: 1 };
  }

  const viewportChanged =
    state.viewportKey !== '' && viewportKey !== '' && viewportKey !== state.viewportKey;
  /*
   * program 换人（切歌）：出场画面是**上一首**的字形，即使文字签名碰巧相同也必须丢 ——
   * 否则新歌开头会淡出上一首的残影。
   * 与 `viewportChanged` 同规矩：**两边都知道身份**时才比较（老调用者不传 `programKey`
   * 不会因此被误判成"换了"）。
   */
  const programChanged =
    state.programKey !== '' && programKey !== '' && programKey !== state.programKey;
  /*
   * ⚠ 这一条**放在同签名分支之前**：同签名 + 倒退 / 跳转（同镜拖进度条）时，出场快照的
   * 内容与坐标都已经过期，只 reset resize 会把它留在画面上继续淡出（残影）。
   */
  if (viewportChanged || programChanged || reducedMotion || seekedFrom(state, input, threshold)) {
    const next: SonnetLyricCrossfadeState = {
      signature: input.signature,
      outgoingSignature: '',
      startedAtMs: nowMs - duration,
      lastTimeSec: input.timeSec,
      viewportKey,
      programKey,
      live: true,
    };
    return { state: next, outgoingAlpha: 0, incomingAlpha: 1, phase: 'seek', progress: 1 };
  }

  if (input.signature === state.signature) {
    const progress = clamp01((nowMs - state.startedAtMs) / duration);
    const easing = smoothstep01(progress);
    const outgoing = progress >= 1 ? 0 : 1 - easing;
    const next: SonnetLyricCrossfadeState = {
      signature: state.signature,
      /* 淡变走完就把出场画面清掉（渲染层据此隐藏出场层）。 */
      outgoingSignature: progress >= 1 ? '' : state.outgoingSignature,
      startedAtMs: state.startedAtMs,
      lastTimeSec: input.timeSec,
      viewportKey,
      programKey,
      live: true,
    };
    return {
      state: next,
      outgoingAlpha: outgoing,
      incomingAlpha: state.outgoingSignature === '' ? 1 : easing,
      phase: 'hold',
      progress: state.outgoingSignature === '' ? 1 : progress,
    };
  }

  /*
   * **拖动进度**的第三个特征："换句换得太密"：上一段淡变还没走完就又来一个新签名 ——
   * 正常歌词不会这样（句间至少几百毫秒），拖进度条时却会每帧一次。此时**不再叠一层淡变**
   * （否则旧字形会一层盖一层、像拖影），直接切。
   */
  const chainedSwap = state.outgoingSignature !== '' && nowMs - state.startedAtMs < duration;
  if (chainedSwap) {
    const next: SonnetLyricCrossfadeState = {
      signature: input.signature,
      outgoingSignature: '',
      startedAtMs: nowMs - duration,
      lastTimeSec: input.timeSec,
      viewportKey,
      programKey,
      live: true,
    };
    return { state: next, outgoingAlpha: 0, incomingAlpha: 1, phase: 'seek', progress: 1 };
  }

  const next: SonnetLyricCrossfadeState = {
    signature: input.signature,
    outgoingSignature: state.signature,
    startedAtMs: nowMs,
    lastTimeSec: input.timeSec,
    viewportKey,
    programKey,
    live: true,
  };
  const starting = next.outgoingSignature !== '';
  return {
    state: next,
    outgoingAlpha: starting ? 1 : 0,
    incomingAlpha: starting ? 0 : 1,
    /* 没有旧画面可淡出（如从静默进第一句）就不算淡变：新句直接落位，走它自己的逐字入场。 */
    phase: starting ? 'fade' : 'hold',
    progress: starting ? 0 : 1,
  };
}

/** 一行读数（dataset / 日志 / 用例共用一份口径）。 */
export function describeSonnetLyricCrossfade(frame: SonnetLyricCrossfadeFrame): string {
  return (
    `${frame.phase} out=${frame.outgoingAlpha.toFixed(2)} in=${frame.incomingAlpha.toFixed(2)} ` +
    `p=${frame.progress.toFixed(2)}`
  );
}
