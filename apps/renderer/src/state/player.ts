import { create } from 'zustand';
import {
  EMPTY_QUEUE,
  advance,
  changeMode,
  createQueue,
  currentId,
  cycleMode as nextMode,
  jumpTo,
  retreat,
  type AdvanceOrigin,
  type QueueState,
} from '@pi/player-core';
import type { PlayMode, ResolvedAudio, ResolveAttempt, Settings, Song } from '@pi/shared';
import { CH, errorMessage, invoke } from '../bridge';
import { applyVolume, getAudio } from '../lib/audio-engine';
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

async function playElement(): Promise<void> {
  try {
    await getAudio().play();
  } catch (error) {
    // 切歌/暂停会打断上一次 play()，抛 AbortError 属于正常现象。
    if ((error as { name?: string }).name === 'AbortError') return;
    throw error;
  }
}

export const usePlayer = create<PlayerState>((set, get) => {
  /** 解析当前指针指向的歌，并真正开始播放。 */
  async function loadCurrent(): Promise<void> {
    // 解析期间元素里还是上一首（下面有 await）：先关时钟，别让它的 timeupdate 写进新歌状态。
    clockArmed = false;
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

      const element = getAudio();
      element.src = result.src;
      // 元素从这一刻起指的是这一首，之后的 timeupdate 才属于它。
      clockArmed = true;
      applyVolume(get().volume, get().muted);
      set({ src: result.src, audio: result.audio, status: 'playing', notice: null });
      skipGuard = 0;
      await playElement();
    } catch (error) {
      set({ status: 'error', error: errorMessage(error) });
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
    unplayable: [],
    positionMs: 0,
    durationMs: 0,
    volume: 0.8,
    muted: false,
    mode: 'order',

    hydrate: (settings) => {
      applyVolume(settings.volume, get().muted);
      set({ volume: settings.volume, mode: settings.playMode });
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

    async toggle() {
      const state = get();
      if (state.status === 'playing') {
        getAudio().pause();
        set({ status: 'paused' });
        return;
      }
      if (state.src) {
        // 顺序播放停在列表末尾时，元素的播放位置正卡在结尾：原样 `play()` 会立刻再触发一次
        // `ended`，又回到 `next('auto')` 的「停住」那一支——按下去像坏了。这种情况把这一首
        // 从头放。只在顺序播放 + 位置确实到头时生效，不动其它三种模式「播完自动切歌」的语义。
        const atSequenceEnd =
          state.queue.mode === 'sequence' &&
          state.durationMs > 0 &&
          state.positionMs >= state.durationMs - END_EPSILON_MS;
        if (atSequenceEnd) getAudio().currentTime = 0;
        set(atSequenceEnd ? { status: 'playing', positionMs: 0, notice: null } : { status: 'playing' });
        try {
          await playElement();
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
      getAudio().currentTime = target / 1000;
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
