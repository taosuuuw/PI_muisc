/**
 * 播放队列与播放模式：**纯函数，零副作用，零 DOM**。
 *
 * 为什么单独放一个包：这部分逻辑是「切歌到底切到哪一首」的唯一真相，
 * 一旦写进 React 组件里就再也测不了。这里只依赖 id 数组与随机函数，
 * 可以脱离 Electron/浏览器直接跑单元测试（A5 CI 落地时第一批用例就是它）。
 *
 * 四种模式的语义对齐网易云（第四种是用户 m03805 第 4 条补上的）：
 * - `order`（列表循环）：自动/手动都按顺序走，到尾回到第一首。
 * - `repeat-one`（单曲循环）：**自动**播放结束时停在原曲；但用户手动点「下一首」仍然换歌，
 *   否则用户会以为按钮坏了。
 * - `shuffle`（随机播放）：维护一条完整排列 + 游标，保证一轮之内不重复，
 *   「上一首」回到随机序列里的前一首（而不是重新随机）。
 * - `sequence`（顺序播放）：按列表顺序往下走，**走到最后一首就停**，不回头也不重播；
 *   「停」由 `state/player.ts` 的 `next()` 落实（`advance()` 只能表达「没有下一首了」，
 *   纯函数不碰 `<audio>`）。
 */
import type { PlayMode } from '@pi/shared';

export type AdvanceOrigin = 'auto' | 'manual';

export interface QueueState {
  /** 原始顺序（用户看到、点击的顺序），shuffle 下也不改动它。 */
  readonly ids: readonly number[];
  /** 当前曲目在 `ids` 中的下标；空队列为 -1。 */
  readonly index: number;
  readonly mode: PlayMode;
  /** shuffle 的播放序列（`ids` 下标的一个排列）。非 shuffle 时为空。 */
  readonly shuffleOrder: readonly number[];
  /** 播放序列游标，仅 shuffle 有意义。 */
  readonly shuffleCursor: number;
}

export type RandomFn = () => number;

/** 模式轮转顺序：点一下按钮换下一种。与网易云一致：列表循环 → 单曲循环 → 随机播放 → 顺序播放。 */
export const PLAYLIST_MODES: readonly PlayMode[] = ['order', 'repeat-one', 'shuffle', 'sequence'];

export const EMPTY_QUEUE: QueueState = {
  ids: [],
  index: -1,
  mode: 'order',
  shuffleOrder: [],
  shuffleCursor: 0,
};

export const MODE_LABEL: Readonly<Record<PlayMode, string>> = {
  order: '列表循环',
  'repeat-one': '单曲循环',
  shuffle: '随机播放',
  sequence: '顺序播放',
};

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return index >= length ? length - 1 : Math.floor(index);
}

/** 生成一个「首元素固定为 first」的随机排列（Fisher–Yates）。 */
function permutation(count: number, first: number, random: RandomFn): number[] {
  const rest: number[] = [];
  for (let i = 0; i < count; i += 1) if (i !== first) rest.push(i);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = rest[i];
    const b = rest[j];
    if (a === undefined || b === undefined) continue;
    rest[i] = b;
    rest[j] = a;
  }
  return first >= 0 && first < count ? [first, ...rest] : rest;
}

function withShuffle(state: QueueState, cursor: number, random: RandomFn): QueueState {
  const count = state.ids.length;
  if (count === 0) return { ...state, shuffleOrder: [], shuffleCursor: 0 };
  const head = clampIndex(state.index, count);
  const order = permutation(count, head, random);
  const at = clampIndex(cursor, count);
  return {
    ...state,
    shuffleOrder: order,
    shuffleCursor: at,
    index: order[at] ?? head,
  };
}

export function createQueue(
  ids: readonly number[],
  startIndex = 0,
  mode: PlayMode = 'order',
  random: RandomFn = Math.random,
): QueueState {
  if (ids.length === 0) return { ...EMPTY_QUEUE, mode };
  const index = clampIndex(startIndex, ids.length);
  const base: QueueState = { ids: [...ids], index, mode, shuffleOrder: [], shuffleCursor: 0 };
  return mode === 'shuffle' ? withShuffle(base, 0, random) : base;
}

/** 推进到下一首。`origin='auto'` 表示「上一首自然播完」，它会尊重单曲循环。 */
export function advance(
  state: QueueState,
  origin: AdvanceOrigin = 'manual',
  random: RandomFn = Math.random,
): QueueState {
  const count = state.ids.length;
  if (count === 0) return state;
  if (state.mode === 'repeat-one' && origin === 'auto') return state;

  if (state.mode === 'shuffle') {
    if (state.shuffleOrder.length !== count) return withShuffle(state, 1, random);
    const cursor = (state.shuffleCursor + 1) % count;
    return { ...state, shuffleCursor: cursor, index: state.shuffleOrder[cursor] ?? state.index };
  }

  // 顺序播放（用户 m03805 第 4 条）：走到最后一首就没有下一首了——既不回头（那是列表循环），
  // 也不重播当前这首。**原样返回同一个对象**是给调用方的信号：`state/player.ts` 的 `next()`
  // 认「引用没变 + sequence」就停下来暂停，而不是拿这个状态去重新解析播放。
  // 自动播完与手动「下一首」走同一条规则（手动也不许绕回第一首）。
  if (state.mode === 'sequence' && state.index >= count - 1) return state;

  return { ...state, index: (state.index + 1) % count };
}

/**
 * 回到上一首。
 *
 * `sequence`（顺序播放）在这里**照旧回头**：网易云的「顺序播放」只约束「往下走」，
 * 用户手动点「上一首」时仍然按列表往回走、到第一首再绕到最后一首——这是手动操作，
 * 不是自动推进，不会让已经该结束的队列自己续上。
 */
export function retreat(state: QueueState, random: RandomFn = Math.random): QueueState {
  const count = state.ids.length;
  if (count === 0) return state;

  if (state.mode === 'shuffle') {
    if (state.shuffleOrder.length !== count) return withShuffle(state, count - 1, random);
    const cursor = (state.shuffleCursor - 1 + count) % count;
    return { ...state, shuffleCursor: cursor, index: state.shuffleOrder[cursor] ?? state.index };
  }
  return { ...state, index: (state.index - 1 + count) % count };
}

/** 用户直接点了某一首（列表第 index 行）。shuffle 下把它接到随机序列的当前位置。 */
export function jumpTo(
  state: QueueState,
  index: number,
  random: RandomFn = Math.random,
): QueueState {
  const count = state.ids.length;
  if (count === 0) return state;
  const target = clampIndex(index, count);
  if (state.mode !== 'shuffle') return { ...state, index: target };

  const existing = state.shuffleOrder.indexOf(target);
  if (state.shuffleOrder.length === count && existing >= 0) {
    return { ...state, index: target, shuffleCursor: existing };
  }
  return withShuffle({ ...state, index: target }, 0, random);
}

export function changeMode(
  state: QueueState,
  mode: PlayMode,
  random: RandomFn = Math.random,
): QueueState {
  if (state.mode === mode) return state;
  if (mode !== 'shuffle') return { ...state, mode, shuffleOrder: [], shuffleCursor: 0 };
  return withShuffle({ ...state, mode }, 0, random);
}

export function cycleMode(mode: PlayMode): PlayMode {
  const position = PLAYLIST_MODES.indexOf(mode);
  return PLAYLIST_MODES[(position + 1) % PLAYLIST_MODES.length] ?? 'order';
}

/** 当前曲目的 id；空队列返回 undefined。 */
export function currentId(state: QueueState): number | undefined {
  return state.index >= 0 ? state.ids[state.index] : undefined;
}

/**
 * 把第 `from` 首挪到第 `to` 个位置（主人本轮第 3 条：长按歌曲一行拖动改顺序）。
 *
 * 纯函数：只重排 `ids`，并把 `index`（当前曲目在 `ids` 里的下标）跟着挪到同一首歌上 ——
 * 拖动别的歌绝不能让「正在播的那首」突然换人。`shuffle` 的那条播放序列（`shuffleOrder`）
 * 存的是**下标**，重排后下标全体错位，所以这里直接把它重置成空（下一次切歌会按新顺序重算），
 * 免得出现「随机序列指着一个已经换了歌的下标」。
 *
 * 下标越界一律原样返回（拖动过程中的中间态不值得抛错）。
 */
export function moveInQueue(state: QueueState, from: number, to: number): QueueState {
  const count = state.ids.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return state;
  if (from < 0 || from >= count || to < 0 || to >= count || from === to) return state;

  const ids = [...state.ids];
  const [moved] = ids.splice(from, 1);
  if (moved === undefined) return state;
  ids.splice(to, 0, moved);

  /* 当前曲目的新下标：按「被移动的是不是它、移动方向跨没跨过它」三种情况算。 */
  let index = state.index;
  if (state.index === from) index = to;
  else if (from < state.index && to >= state.index) index = state.index - 1;
  else if (from > state.index && to <= state.index) index = state.index + 1;

  return { ...state, ids, index: clampIndex(index, ids.length), shuffleOrder: [], shuffleCursor: 0 };
}

/**
 * 从队列里去掉第 `at` 首（主人本轮第 3 条：歌曲选择页要能删歌）。
 *
 * 返回 `{ state, removedId, wasCurrent }`：
 *   · `removedId` 给调用方用（比如「从歌单删掉」要拿 id）；
 *   · `wasCurrent` 为真表示**删掉的正是正在播的那首** —— 队列状态机在这里不替用户做决定
 *     （是接着播下一首还是停下，得看 `<audio>` 那一侧的情况），交给 `state/player.ts` 处理。
 *
 * 删掉当前曲目**之前**的一首时下标注跟着减一，保证「正在播的还是同一首」。
 */
export function removeFromQueue(
  state: QueueState,
  at: number,
): { state: QueueState; removedId: number | undefined; wasCurrent: boolean } {
  const count = state.ids.length;
  if (!Number.isInteger(at) || at < 0 || at >= count) {
    return { state, removedId: undefined, wasCurrent: false };
  }
  const ids = state.ids.filter((_, position) => position !== at);
  const wasCurrent = at === state.index;
  const index = wasCurrent
    ? clampIndex(state.index, ids.length)
    : at < state.index
      ? state.index - 1
      : state.index;
  return {
    state: { ...state, ids, index, shuffleOrder: [], shuffleCursor: 0 },
    removedId: state.ids[at],
    wasCurrent,
  };
}
