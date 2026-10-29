import { create } from 'zustand';
import {
  EMPTY_QUEUE,
  advance,
  changeMode,
  createQueue,
  currentId,
  cycleMode as nextMode,
  jumpTo,
  moveInQueue,
  removeFromQueue,
  retreat,
  type AdvanceOrigin,
  type QueueState,
} from '@pi/player-core';
import type {
  PlayMode,
  ResolvedAudio,
  ResolveAttempt,
  Settings,
  Song,
} from '@pi/shared';

/** 设置里那一档歌词源（`Settings['lyricSource']`），避免为一处类型再引一个名字。 */
type LyricSourceMode = Settings['lyricSource'];
import { CH, errorMessage, invoke } from '../bridge';
import {
  applyVolume,
  ensureDecks,
  getActiveDeck,
  getAudio,
  getDeckElement,
  switchActiveDeck,
} from '../lib/audio-engine';
import {
  CUT_FADE_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  PAUSE_FADE_MS,
  crossfade,
  ensureGraph,
  fadeIn,
  fadeOut,
  isGraphReady,
  resetFade,
  resumeGraph,
  setDeckGain,
  shouldStartTailFade,
  type DeckId,
} from '../lib/transition/fade-graph';
import {
  CROSSFADE_SEC,
  shouldArmNext,
  shouldStartCrossfade,
  type TransitionPhase,
} from '../lib/transition/schedule';
import { LYRIC_GATE_MS, isLyricPending, prefetchLyric } from '../lib/lyric-prefetch';
import { ensureTrackProfile } from '../lib/transition/profile-service';
import { useNowPlaying } from './nowPlaying';

/**
 * 播放状态机。
 *
 * 分工（docs/PLAN.md §2.3）：
 * - 队列/上下首/模式 → `@pi/player-core` 的纯函数，这里只负责把它们串成状态；
 * - 「哪首歌能播」→ 主进程（音源解析链 + 字节嗅探），渲染进程只拿到一个本地代理地址；
 * - `<audio>` 元素 → 由 `lib/audio-engine.ts` 单例持有，事件经 `report*` 回写到这里。
 */
export type PlaybackStatus =
  | 'idle'
  /** 正在向主进程要地址（含探测实测格式）。 */
  | 'resolving'
  | 'playing'
  | 'paused'
  /** 地址拿到了，但元素播放失败（解码/网络）。 */
  | 'error'
  /** 所有音源都没给地址：标记后自动跳下一首。 */
  | 'unplayable';

interface PlayerState {
  queue: QueueState;
  /** id → 元数据。队列只存 id，切歌时不必再回后端查歌曲信息。 */
  songs: Record<number, Song>;
  currentSong: Song | null;
  status: PlaybackStatus;
  /** 当前歌曲的解析结果（含**实测**容器与码率），UI 用它显示音质徽标。 */
  audio: ResolvedAudio | null;
  attempts: ResolveAttempt[];
  src: string | null;
  error: string | null;
  /** 一次性提示（例如「已跳过无法播放的《X》」），播放成功后自动清空。 */
  notice: string | null;
  /**
   * 正在等歌词（用户第五轮第 10 条）。
   *
   * 音源已经拿到了，但为了让歌词和第一句同时出现，这里先不出声；
   * 界面按它显示顶部灵动岛「少女祈祷中⭐」。`true` 的时间不会超过 `LYRIC_GATE_MS`。
   */
  loadingGate: boolean;
  /** 当前生效的歌词源档位（`hydrate` 时从设置里抄一份）：预取歌词要用它拼缓存键。 */
  lyricMode: LyricSourceMode;
  /** 当前生效的歌曲过渡档位（`hydrate` 时从设置里抄一份）：`off` 时一切行为退回硬切。 */
  songTransition: 'off' | 'fade' | 'crossfade';
  /** 本轮被判过「不可播」的歌曲 id，避免反复重试同一首。 */
  unplayable: number[];
  positionMs: number;
  durationMs: number;
  volume: number;
  muted: boolean;
  mode: PlayMode;
  /** 从设置里恢复音量与播放模式（由 `<AudioEngine>` 调用一次）。 */
  hydrate: (settings: Settings) => void;
  /**
   * 恢复「上一次听的那首歌」：只装填歌曲与队列，**不**解析音源、不自动播放。
   * 用户 m05361 第 2 条要求重启后仍进详情页，所以这一步必须能做，且必须安静
   * （不能在启动时就去请求音源，否则等于每次开应用都偷偷联网 + 抢音频设备）。
   */
  restoreLast: (song: Song, songs: readonly Song[]) => void;
  play: (songs: readonly Song[], startIndex?: number) => Promise<void>;
  playAt: (index: number) => Promise<void>;
  /**
   * 从播放队列里去掉第 `at` 首（主人本轮第 3 条：播放列表的歌曲选择页要能删歌）。
   *
   * 删的不是正在播的那首时，队列变了、声音一点不动；删的正是它时，按新队列装填下一首
   * （删空了就回到 `idle`）。「删掉当前这首要不要接着播」这件事只有这里能决定 ——
   * 纯函数 `removeFromQueue` 只负责把 `wasCurrent` 如实报上来。
   */
  removeAt: (at: number) => Promise<void>;
  /** 把队列里的第 `from` 首挪到第 `to` 位（主人本轮第 3 条：长按一行拖动改顺序）。 */
  moveQueue: (from: number, to: number) => void;
  toggle: () => Promise<void>;
  next: (origin?: AdvanceOrigin) => Promise<void>;
  prev: () => Promise<void>;
  seek: (positionMs: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  cycleMode: () => void;
  reportTime: (positionMs: number, durationMs: number) => void;
  reportEnded: () => void;
  reportError: (message: string) => void;
  reportPlaying: (playing: boolean) => void;
}

/**
 * 一轮里允许连续跳过多少首「不可播」的歌。
 * 没有这个闸门，一整张全是无版权的歌单会让解析-跳过无限循环。
 */
let skipGuard = 0;
let volumeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * `<audio>` 现在指的是不是「当前这首歌」。
 *
 * 切歌时 `loadCurrent()` 要等主进程解析音源（几百毫秒到几秒），这段时间元素**还挂着上一首**、
 * 还在出声、还在按 ~250ms 一跳发 `timeupdate`（见 components/AudioEngine.tsx:44 的监听）。
 * 那些事件会把**上一首**的进度与时长写进 store，于是新歌的歌词按旧歌的位置高亮、进度条也走错，
 * 一直错到 `element.src` 换过去才跳回开头 —— 用户说的「歌词有时会进度不匹配」「第一句错位」。
 * 所以换歌先把时钟关掉，等 `element.src` 真的换成这一首了再打开。
 */
let clockArmed = false;

/**
 * 歌尾淡出是不是已经为当前这一遍播放点过火了。
 *
 * 每首歌只该淡出一次：切歌、恢复播放、seek 之后都要把它放回 false，下一次才会重新计时。
 */
let tailFadeArmed = false;

/**
 * 过渡状态机（P2）：
 *
 * ```
 * idle ──(距歌尾 12s)──▶ arming ──(地址到手)──▶ ready ──(距歌尾 5s)──▶ fading ──▶ idle
 *   ▲                      │                     │                      │
 *   └──────── 任何失败 / 用户干预 / 队列变化 ─────┴──────────────────────┘
 * ```
 *
 * 判定在 `lib/transition/schedule.ts`（纯函数、可单测），这里只负责执行与回退：
 * 任何一步不成立都退回 `idle`，P1 的尾部淡出会兜底，绝不卡在半过渡里。
 */
let phase: TransitionPhase = 'idle';

/** 每次 arm 递增；异步解析回来时用它判断「这一轮还算数吗」。 */
let armToken = 0;

/** 已经备好的下一首（`ready` 状态下有效）。 */
interface ArmedTrack {
  deck: DeckId;
  song: Song;
  src: string;
  audio: ResolvedAudio;
  /** 交叉完成后要写进 store 的新队列。 */
  queue: QueueState;
  /** 预取开始时的队列；对不上就说明用户改过队列，这一轮作废。 */
  baseQueue: QueueState;
}
let armed: ArmedTrack | undefined;

function otherDeck(id: DeckId): DeckId {
  return id === 'a' ? 'b' : 'a';
}

/**
 * 判定「播放位置已经在结尾」的容差（毫秒）。
 *
 * `<audio>` 的 `timeupdate` 与 `ended` 之间、以及 duration 的取整都会有几毫秒的出入，
 * 所以顺序播放停在末尾后按播放键时，位置差这么一点也当成「到头了」→ 从头放（见 `toggle()`）。
 */
const END_EPSILON_MS = 350;

/** 音量拖动会触发几十次，落盘去抖一下，避免把设置文件写爆。 */
function persistVolume(volume: number): void {
  if (volumeTimer) clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => {
    void invoke(CH.settingsPatch, { volume }).catch(() => {});
  }, 400);
}

/**
 * 「等歌词」这道闸（用户第五轮第 10 条）。
 *
 * 返回 `{ done, settled }`：`done` 可以反复 `await`（同一份 promise），
 * `settled` 让调用方在音源已经解析完之后知道「歌词是不是早就到了」——
 * 早就到了就不必亮灵动岛，也就不会有一下「闪一下又不闪」的白光。
 */
function waitForLyric(
  song: Song,
  mode: LyricSourceMode,
): { done: Promise<void>; get settled(): boolean } {
  let settled = false;
  const lyric = prefetchLyric(song, mode).then(() => {
    settled = true;
  });
  const done = Promise.race([
    lyric,
    new Promise<void>((resolve) => {
      setTimeout(resolve, LYRIC_GATE_MS);
    }),
  ]);
  void done.then(() => {
    settled = true;
  });
  return {
    done,
    get settled() {
      return settled;
    },
  };
}

async function playElement(target?: HTMLAudioElement): Promise<boolean> {
  /*
   * 两个 deck 都要在图上：交叉淡化时两路会同时出声。
   * 元素一旦被 `createMediaElementSource` 接管，输出就只走这张图，所以必须同时确认
   * context 在跑（否则播放器会静音）。`ensureGraph` 在纯 Node 单测里返回 undefined，
   * `resumeGraph` 也随之变成 no-op，不会碰真实音频设备。
   */
  ensureGraph(ensureDecks());
  const running = await resumeGraph();
  if (!running) console.warn('[pi/transition] 音频图停在 suspended，这次播放可能没有声音');
  const element = target ?? getAudio();
  try {
    await element.play();
    return true;
  } catch (error) {
    // 切歌/暂停会打断上一次 play()，抛 AbortError 属于正常现象。
    if ((error as { name?: string }).name === 'AbortError') return false;
    throw error;
  }
}

/**
 * 预取下一首：解析出地址后装到**备用 deck** 上，静音待命（增益为 0）。
 *
 * 为什么提前 12 秒：解析链要联网，慢的时候好几秒；等歌快结束了才开始就全变成空档。
 * 解析失败 / 队列被改 / 用户切歌，都把状态退回 `idle`——P1 的尾部淡出会兜底。
 */
async function armNextTrack(): Promise<void> {
  const state = usePlayer.getState();
  if (phase !== 'idle') return;
  const nextQueue = advance(state.queue, 'auto');
  if (nextQueue === state.queue) return; // 没有下一首（顺序播放到头 / 单曲循环）
  const nextId = currentId(nextQueue);
  if (nextId === undefined) return;
  const song = state.songs[nextId];
  if (!song || state.unplayable.includes(song.id)) return;

  phase = 'arming';
  const token = ++armToken;
  try {
    const result = await invoke(CH.playerResolve, { song });
    if (token !== armToken || phase !== 'arming') return;
    // 解析这几秒里队列/用户状态可能变了：对不上就作废。
    if (usePlayer.getState().queue !== state.queue) {
      phase = 'idle';
      return;
    }
    if (!result.src || !result.audio) {
      phase = 'idle';
      return;
    }
    const deck = otherDeck(getActiveDeck());
    const element = getDeckElement(deck);
    element.src = result.src;
    element.load();
    armed = {
      deck,
      song,
      src: result.src,
      audio: result.audio,
      queue: nextQueue,
      baseQueue: state.queue,
    };
    phase = 'ready';
    /*
     * P3：顺手把下一首的离线档案算出来（缓存里没有才真算）。
     * fire-and-forget：它只影响「将来的过渡怎么接」，失败不影响这一次播放。
     */
    void ensureTrackProfile(song, result.src).catch(() => {});
  } catch {
    if (token === armToken) phase = 'idle';
  }
}

/**
 * 开始交叉：新 deck 起播 → 切活动 deck 与 store → 两条等功率曲线 → 收尾。
 *
 * 进场曲先 `play()` 再画曲线：元素起播有几十毫秒的延迟，先播能保证曲线开始那一刻它已经出声；
 * 它的增益此时是 0，所以听不见。
 */
async function startCrossfade(): Promise<void> {
  const current = armed;
  if (!current || phase !== 'ready') return;
  if (usePlayer.getState().queue !== current.baseQueue) {
    abortTransition();
    return;
  }

  phase = 'fading';
  const fromDeck = getActiveDeck();
  const toDeck = current.deck;
  const element = getDeckElement(toDeck);

  let started = false;
  try {
    element.currentTime = 0;
    started = await playElement(element);
  } catch {
    started = false;
  }
  if (!started) {
    // 新歌放不出来：退回 P1 的路径，让 `ended → next` 自己走。
    setDeckGain(toDeck, 1);
    phase = 'idle';
    armed = undefined;
    return;
  }

  switchActiveDeck(toDeck);
  clockArmed = true;
  tailFadeArmed = false;
  useNowPlaying.getState().select(current.song);
  usePlayer.setState({
    queue: current.queue,
    currentSong: current.song,
    src: current.src,
    audio: current.audio,
    status: 'playing',
    positionMs: 0,
    durationMs: current.song.durationMs ?? 0,
    loadingGate: false,
    error: null,
    notice: null,
  });
  // 交叉和「等歌词」不共存：先让歌词开始拉，界面上不会空着。
  void prefetchLyric(current.song, usePlayer.getState().lyricMode);

  await crossfade(fromDeck, toDeck, CROSSFADE_SEC);

  const outElement = getDeckElement(fromDeck);
  outElement.pause();
  setDeckGain(fromDeck, 1);
  phase = 'idle';
  armed = undefined;
}

/**
 * 中止过渡并回到干净状态。**任何用户干预都要先调它**：
 * 切歌、暂停、seek、队列变化、设置里换档位。
 */
function abortTransition(): void {
  if (phase === 'idle' && armed === undefined) return;
  armToken += 1;
  const fading = phase === 'fading';
  phase = 'idle';
  armed = undefined;
  if (fading) {
    // 活动 deck 已经切到新歌，出场的那一路还在响：停掉并复位，免得下次预取时它带着旧增益。
    const idleDeck = otherDeck(getActiveDeck());
    getDeckElement(idleDeck).pause();
    setDeckGain(idleDeck, 1);
  }
}

export const usePlayer = create<PlayerState>((set, get) => {
  /** 解析当前指针指向的歌，并真正开始播放。 */
  async function loadCurrent(): Promise<void> {
    // 解析期间元素里还是上一首（下面有 await）：先关时钟，别让它的 timeupdate 写进新歌状态。
    clockArmed = false;
    // 任何一次「重新装填」都意味着上一轮预取/交叉作废。
    abortTransition();
    /*
     * 用户本轮第 1 条：「切换歌曲时，下一首加载歌词前，上一首歌就应该停止播放了」。
     *
     * 这里以前只关时钟、**不动元素**，于是上一首会一直唱到新歌的地址与歌词都就位（音源解析几百
     * 毫秒到几秒 + 等歌词；最坏是那个防挂死的上界）——用户听到的就是「词还没加载好，上一首还在唱」。
     * `pause()` 是同步的，函数后面每一个 `await` 都在静音之后，所以这一下按下去立刻没声。
     * 它触发的 `pause` 事件不会把状态写成 `paused`：本函数紧接着就把状态置成 `resolving`，
     * 而 `reportPlaying()` 只认 `playing` ↔ `paused` 两态（见文件末尾）。
     */
    const element = getAudio();
    /*
     * 手动切歌先收个尾（90ms）：直接 `pause()` 是在波形中间硬停，听感上就是「啪」一下。
     * 自动切歌（`ended` 之后走到这里）元素已经 paused，不会多等这一下。
     *
     * 只有音频图真的存在时才 `await`：纯 Node 单测里没有 AudioContext，`fadeOut` 是个
     * 即时 resolve 的空操作，但 `await` 本身会让出微任务——那会破坏下面这条既有契约
     * 「`pause()` 发生在任何 `await` 之前」，也让人以为代码变慢了。
     */
    if (get().songTransition !== 'off' && isGraphReady() && !element.paused) {
      await fadeOut(CUT_FADE_MS, getActiveDeck());
    }
    element.pause();
    const state = get();
    const id = currentId(state.queue);
    const song = id === undefined ? undefined : state.songs[id];
    if (!song) {
      set({ status: 'idle', currentSong: null, src: null, audio: null, attempts: [] });
      return;
    }

    // 听歌条的「当前歌曲」与列表高亮共用 nowPlaying，避免两套「当前」互相打架。
    useNowPlaying.getState().select(song);
    set({
      currentSong: song,
      status: 'resolving',
      error: null,
      src: null,
      audio: null,
      attempts: [],
      positionMs: 0,
      durationMs: song.durationMs ?? 0,
    });

    try {
      /*
       * 用户第五轮第 10 条：**歌先别唱，等歌词**。
       *
       * 原来音源一解析完就 `play()`，于是「前奏已经过去两句、歌词才刚画出来」——
       * 用户听到的正是「一开始就唱、词没加载好」。改法是把两件事**并行**跑：
       *   ① 音源解析（`playerResolve`，原来就有）；
       *   ② 歌词预取（`prefetchLyric`，写进 `useLyric` 同一个缓存键）。
       * 音源拿到之后**先不播**，等 ② 有个结果（或超过 `LYRIC_GATE_MS` 的闸门）再出声；
       * 界面这一段时间显示顶部灵动岛「少女祈祷中⭐」（`loadingGate`）。
       *
       * 并行而不是串行很重要：歌词最慢的那条路（五个镜像全超时）本来就要好几秒，
       * 串起来等于把这笔时间叠加到「点了歌到听见声」上。
       */
      const lyricGate = waitForLyric(song, get().lyricMode);

      const result = await invoke(CH.playerResolve, { song });
      // 解析期间用户可能已经点了别的歌，此时这一轮结果必须丢弃。
      if (currentId(get().queue) !== song.id) return;
      set({ attempts: result.attempts });

      if (!result.src || !result.audio) {
        set({
          status: 'unplayable',
          error: `${song.name}：没有取到可播放的音源`,
          unplayable: Array.from(new Set([...get().unplayable, song.id])),
        });
        await skipUnplayable(song);
        return;
      }

      if (!lyricGate.settled) set({ loadingGate: true });
      await lyricGate.done;
      // 等歌词期间用户可能又点了别的歌 —— 同样丢弃这一轮。
      if (currentId(get().queue) !== song.id) {
        set({ loadingGate: false });
        return;
      }

      element.src = result.src;
      // 元素从这一刻起指的是这一首，之后的 timeupdate 才属于它。
      clockArmed = true;
      applyVolume(get().volume, get().muted);
      set({ src: result.src, audio: result.audio, status: 'playing', notice: null, loadingGate: false });
      skipGuard = 0;
      await playElement();
      // 新歌从静音升到满幅：这是 P1「不硬切」的另一半（收尾淡出 + 起头淡入）。
      if (get().songTransition !== 'off') fadeIn(FADE_IN_MS, getActiveDeck());
      tailFadeArmed = false;
    } catch (error) {
      set({ status: 'error', error: errorMessage(error), loadingGate: false });
    }
  }

  /** 不可播 → 标记 + 自动跳下一首（带闸门）。 */
  async function skipUnplayable(song: Song): Promise<void> {
    skipGuard += 1;
    const total = get().queue.ids.length;
    if (skipGuard > total) {
      skipGuard = 0;
      set({
        status: 'error',
        notice: `队列里的 ${total} 首歌都没有可播放的音源，已停止。`,
      });
      return;
    }
    set({ notice: `已跳过无法播放的《${song.name}》` });
    await get().next('auto');
  }

  return {
    queue: EMPTY_QUEUE,
    songs: {},
    currentSong: null,
    status: 'idle',
    audio: null,
    attempts: [],
    src: null,
    error: null,
    notice: null,
    loadingGate: false,
    lyricMode: 'auto',
    songTransition: 'fade',
    unplayable: [],
    positionMs: 0,
    durationMs: 0,
    volume: 0.8,
    muted: false,
    mode: 'order',

    hydrate: (settings) => {
      // 换档位（例如从「交叉」切回「淡变」）时，正在酝酿的那一轮过渡要作废。
      abortTransition();
      applyVolume(settings.volume, get().muted);
      // 顺带记下歌词源档位：等歌词时用它拼缓存键（必须和 `useLyric` 同一份，否则白等）。
      set({
        volume: settings.volume,
        mode: settings.playMode,
        lyricMode: settings.lyricSource,
        // 老设置里没有这个字段：缺省按「淡变」算，与 DEFAULT_SETTINGS 一致。
        songTransition: settings.songTransition ?? 'fade',
      });
    },

    restoreLast(song, songs) {
      // 用户已经在听别的歌了就不能覆盖（恢复是启动时的后台动作）。
      if (get().currentSong) return;
      // 快照可能来自老版本/被截断（`lib/last-played.ts` 的 `readLastPlayed` 已经先筛一道），
      // 这里再兜一次底：没有数字 id 的条目进不了 `record`，也就不该进 `queue.ids` —— 否则
      // `SongListOverlay` 按 id 查 `songs` 时查不到它们，会把队列整列过滤空。
      const list = (songs.length > 0 ? [...songs] : [song]).filter(
        (item): item is Song => Boolean(item) && typeof item.id === 'number',
      );
      if (!list.some((item) => item.id === song.id)) list.unshift(song);
      const record: Record<number, Song> = { ...get().songs };
      for (const item of list) record[item.id] = item;
      skipGuard = 0;
      // 启动恢复不解析音源，元素也不会有地址：时钟保持关闭，`positionMs` 谁都不许写。
      clockArmed = false;
      useNowPlaying.getState().select(song);
      set({
        songs: record,
        queue: createQueue(
          list.map((item) => item.id),
          Math.max(0, list.findIndex((item) => item.id === song.id)),
          get().mode,
        ),
        currentSong: song,
        // `paused` 而不是 `playing`：元素还没加载任何地址，说「正在播放」是撒谎。
        // 这个状态下按播放键，`toggle()` 会走 `queue.ids.length > 0` 那条路真正去解析。
        status: 'paused',
        src: null,
        audio: null,
        attempts: [],
        positionMs: 0,
        durationMs: song.durationMs ?? 0,
      });
    },

    async play(songs, startIndex = 0) {
      if (songs.length === 0) return;
      const record = { ...get().songs };
      for (const song of songs) record[song.id] = song;
      // 接口已经标明「无版权」的，直接进不可播集合，省一次必然失败的解析。
      const blocked = songs.filter((song) => song.playable === false).map((song) => song.id);
      skipGuard = 0;
      set({
        songs: record,
        queue: createQueue(
          songs.map((song) => song.id),
          startIndex,
          get().mode,
        ),
        unplayable: Array.from(new Set([...get().unplayable, ...blocked])),
        notice: null,
        error: null,
      });
      await loadCurrent();
    },

    async playAt(index) {
      set({ queue: jumpTo(get().queue, index) });
      await loadCurrent();
    },

    async removeAt(at) {
      const state = get();
      const removed = removeFromQueue(state.queue, at);
      if (removed.state === state.queue) return;
      set({ queue: removed.state });
      /*
       * 删掉的不是正在播的那首：队列变了、正在响的声音一个字节都不用动。
       * 删掉的正是它：`removeFromQueue` 已经把下标挪到「接棒的那一首」上，
       * 直接按新队列装填 —— 队列空了 `loadCurrent` 自己会回到 `idle`。
       */
      if (removed.wasCurrent) await loadCurrent();
    },

    moveQueue(from, to) {
      const state = get();
      const queue = moveInQueue(state.queue, from, to);
      if (queue !== state.queue) set({ queue });
    },

    async toggle() {
      const state = get();
      if (state.status === 'playing') {
        /*
         * 暂停也走 90ms 的斜坡：直接 `pause()` 是从某个波形值一刀切到 0。
         * 淡出的这 90ms 里用户可能已经点了别的歌（`loadCurrent` 把状态改成 resolving 甚至开播了），
         * 那一下不该再把新状态踩回 paused——所以回来要重新核对一遍。
         */
        abortTransition();
        if (state.songTransition !== 'off' && isGraphReady()) {
          await fadeOut(PAUSE_FADE_MS, getActiveDeck());
        }
        const after = get();
        if (after.status !== 'playing' || after.src !== state.src) return;
        getAudio().pause();
        set({ status: 'paused' });
        return;
      }
      /*
       * 用户本轮第 2 条：「点击播放音乐，当前播放歌曲还在加载歌词时，音乐不应该出声」。
       *
       * 加载中（解析音源 or 等歌词）按播放键**什么都不做**：正在跑的那一次加载会在歌词到位后
       * 自己出声。放它进来只会再起一次解析，还可能抢在歌词前面出声——正是用户否掉的那件事。
       */
      if (state.status === 'resolving') return;
      if (state.src) {
        // 顺序播放停在列表末尾时，元素的播放位置正卡在结尾：原样 `play()` 会立刻再触发一次
        // `ended`，又回到 `next('auto')` 的「停住」那一支——按下去像坏了。这种情况把这一首
        // 从头放。只在顺序播放 + 位置确实到头时生效，不动其它三种模式「播完自动切歌」的语义。
        const atSequenceEnd =
          state.queue.mode === 'sequence' &&
          state.durationMs > 0 &&
          state.positionMs >= state.durationMs - END_EPSILON_MS;
        /*
         * 用户本轮第 2 条：**这一首的歌词还没落定就先不出声**。
         *
         * 什么时候会走到这儿：闸门到点上界、先播过一次，而歌词其实还在路上
         * （`isLyricPending` 认「已经失败过」那一档——纯音乐 / 上游没收录的歌词不会让每次按
         * 播放键都白等一次闸门）。等的时候亮同一个「少女祈祷中⭐」（`loadingGate`），与
         * `loadCurrent` 那条路一致。
         */
        const song = state.currentSong;
        if (song && isLyricPending(song, state.lyricMode)) {
          set({ loadingGate: true });
          await waitForLyric(song, state.lyricMode).done;
          set({ loadingGate: false });
          // 等歌词期间用户可能又切了歌：那一下不该再放「上一首」的地址（`loadCurrent` 会把 src 换掉）。
          if (get().src !== state.src) return;
        }
        if (atSequenceEnd) getAudio().currentTime = 0;
        set(atSequenceEnd ? { status: 'playing', positionMs: 0, notice: null } : { status: 'playing' });
        try {
          await playElement();
          // 恢复播放：从暂停时的当前增益（可能已经淡到 0）升回满幅。
          if (state.songTransition !== 'off') fadeIn(PAUSE_FADE_MS, getActiveDeck());
          tailFadeArmed = false;
        } catch (error) {
          set({ status: 'error', error: errorMessage(error) });
        }
        return;
      }
      if (state.queue.ids.length > 0) await loadCurrent();
    },

    async next(origin: AdvanceOrigin = 'manual') {
      const state = get();
      const queue = advance(state.queue, origin);
      // 顺序播放（用户 m03805 第 4 条）走到列表末尾就**停住**：`advance()` 认「没有下一首」时
      // 原样返回同一个队列对象，所以这里不能再走 `loadCurrent()`——那会把最后一首从头重新
      // 解析、重新播放一遍，等于偷偷来了一次单曲循环。选择的行为（自动播完 / 手动「下一首」
      // 完全一样）：元素暂停、状态回到 `paused`，指针仍然停在最后一首上；手动那一下额外给一
      // 句提示，免得用户以为按键坏了。之后按播放键会发生什么见 `toggle()`。
      if (queue === state.queue && state.queue.mode === 'sequence') {
        getAudio().pause();
        set(origin === 'manual' ? { status: 'paused', notice: '已到列表末尾' } : { status: 'paused' });
        return;
      }
      set({ queue });
      await loadCurrent();
    },

    async prev() {
      set({ queue: retreat(get().queue) });
      await loadCurrent();
    },

    seek(positionMs) {
      const target = Math.max(0, positionMs);
      // 拖进度条一定会打断正在酝酿的交叉：那一轮的目标位置已经不对了。
      abortTransition();
      getAudio().currentTime = target / 1000;
      /*
       * 拖回播放中途时必须把增益恢复满幅：歌尾那一段已经淡出过，不重置的话用户会以为
       * 「拖回来以后整首都没声音」（qplayer 踩过这个坑）。进度变了，歌尾的淡出也要重新计时。
       */
      if (get().songTransition !== 'off') resetFade(getActiveDeck());
      tailFadeArmed = false;
      set({ positionMs: target });
    },

    setVolume(volume) {
      const clamped = Math.min(1, Math.max(0, volume));
      applyVolume(clamped, get().muted);
      set({ volume: clamped });
      persistVolume(clamped);
    },

    setMuted(muted) {
      applyVolume(get().volume, muted);
      set({ muted });
    },

    cycleMode() {
      const mode = nextMode(get().mode);
      set({ mode, queue: changeMode(get().queue, mode) });
      void invoke(CH.settingsPatch, { playMode: mode }).catch(() => {});
    },

    reportTime(positionMs, durationMs) {
      // 元素还没指到「这首歌」时（切歌解析中、启动恢复）报上来的时间都可能是上一首的：丢掉。
      if (!clockArmed) return;
      set((state) => ({
        positionMs,
        // 解析出来的时长比接口给的更准；但解析前的 0 不能覆盖 `song.durationMs`。
        durationMs: durationMs > 0 ? durationMs : state.durationMs,
      }));
    },

    reportEnded() {
      void get().next('auto');
    },

    reportError(message) {
      set({ status: 'error', error: message });
    },

    reportPlaying(playing) {
      const status = get().status;
      if (playing && status === 'paused') set({ status: 'playing' });
      if (!playing && status === 'playing') set({ status: 'paused' });
    },
  };
});

/**
 * 过渡看门狗（P1 的尾部淡出 + P2 的预取 / 交叉）。
 *
 * 为什么不用 `timeupdate`：它只有 4Hz，250ms 的误差会让 900ms 的淡出起步晚一截；
 * 也不挂 rAF：窗口最小化 / 收进托盘时 rAF 会停，那时候就再也等不到。
 * 200ms 一次读 `currentTime` 是折中；后台被节流到 1s 时，`fadeOut(剩余时间)` 自己会缩短。
 */
function watchTransition(): void {
  const state = usePlayer.getState();
  const audio = getAudio();
  if (state.songTransition === 'off') return;
  if (audio.paused) return;
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const remaining = duration - audio.currentTime;
  if (!Number.isFinite(remaining) || remaining <= 0) return;

  if (state.songTransition === 'crossfade') {
    // ① 到预取窗口：先把下一首解析好、装到备用 deck 上（静音待命）。
    if (shouldArmNext(remaining, phase)) {
      void armNextTrack();
      return;
    }
    // ② 到交叉点：两条等功率曲线接上。
    if (shouldStartCrossfade(remaining, phase)) {
      void startCrossfade();
      return;
    }
  }

  // 交叉之外（以及交叉失败回退之后）才轮到 P1 的尾部淡出兜底。
  if (phase !== 'idle') return;
  if (!shouldStartTailFade(remaining, tailFadeArmed)) return;
  tailFadeArmed = true;
  void fadeOut(Math.min(FADE_OUT_MS, remaining * 1000), getActiveDeck());
}

// 单测跑在纯 Node 里：没有 `window` 就不启动，免得定时器拖住进程，也免得碰 `getAudio()`。
if (typeof window !== 'undefined') {
  const timer = setInterval(watchTransition, 200);
  // Node 环境（万一有 `window` 的 shim）里不要因为这个定时器拖住进程。
  (timer as unknown as { unref?: () => void }).unref?.();
}
