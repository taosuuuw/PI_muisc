/**
 * 系统媒体卡片接线（Media Session / Windows SMTC）。
 *
 * 第十三轮第 6 条（用户 m04663）：用户「切换歌曲时出现如图 3 所示的小名片展示，点击没有任何反应」。
 * 排查结论：`apps/desktop/src/main/index.ts` 里只有**一个** `BrowserWindow`（:151），全仓没有
 * `new Notification`，渲染层也没有画「正在播放」卡片的组件——所以那张名片**不是我们画的**，
 * 它是 Chromium 把页面里的音频会话交给操作系统（Windows 的 SMTC / 音量浮层媒体控件）后，
 * 由**系统**画出来的那张「正在播放」卡片。系统卡片上的歌名/封面/按键全部来自 Media Session，
 * 而我们此前一个字节都没接，于是它拿不到元数据、按键点了也没人响应（用户说的「点击没有任何反应」）。
 *
 * 这里做三件事：
 * 1. 换歌时把歌名/歌手/专辑/封面推给系统（`MediaMetadata`）；
 * 2. 给系统卡片上的播放/暂停/上一首/下一首/拖动/快进快退注册回调，真正作用到播放器 store；
 * 3. 把播放状态与进度（`playbackState` / `setPositionState`）报上去，卡片上的按钮与进度才是活的。
 *
 * 注意：这是**只读**接线——它只订阅 `usePlayer`、只调用现成的 action，不改播放器的任何状态机
 * 逻辑（`state/player.ts` 同时有别的改动在飞）。
 */
import type { Song } from '@pi/shared';
import { coverAt } from './cover';
import { usePlayer } from '../state/player';

declare global {
  interface Window {
    /** 主进程 UI 冒烟读它来断言动作真的接上了（`setActionHandler` 没有 getter 可读）。 */
    __piMediaSession?: { actions: MediaSessionAction[] };
  }
}

let installed = false;

function artistLine(song: Song): string {
  return song.artists.map((entry) => entry.name).join(' / ');
}

/**
 * 封面走 `coverAt`（https + `?param=` 裁剪）。这里必须给**大图**：系统卡片与锁屏用的是同一张，
 * 64px 的缩略图糊在卡片上很难看。
 */
function metadataOf(song: Song): MediaMetadata {
  const cover = coverAt(song.album?.coverUrl, 640);
  return new MediaMetadata({
    title: song.name,
    artist: artistLine(song),
    album: song.album?.name ?? '',
    artwork: cover === undefined ? [] : [{ src: cover, sizes: '640x640', type: 'image/jpeg' }],
  });
}

export function installMediaSession(): void {
  if (installed) return;
  installed = true;
  if (typeof navigator === 'undefined' || navigator.mediaSession === undefined) return;
  const session = navigator.mediaSession;

  /** 系统卡片上的每个动作都只转发给现成的 store action，不在这里自己算播放状态。 */
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => void usePlayer.getState().toggle()],
    ['pause', () => void usePlayer.getState().toggle()],
    ['previoustrack', () => void usePlayer.getState().prev()],
    ['nexttrack', () => void usePlayer.getState().next('manual')],
    [
      'seekto',
      (details) => {
        if (typeof details.seekTime !== 'number') return;
        usePlayer.getState().seek(Math.round(details.seekTime * 1000));
      },
    ],
    [
      'seekbackward',
      (details) => {
        const state = usePlayer.getState();
        const step = (details.seekOffset ?? 10) * 1000;
        state.seek(Math.max(0, state.positionMs - step));
      },
    ],
    [
      'seekforward',
      (details) => {
        const state = usePlayer.getState();
        const step = (details.seekOffset ?? 10) * 1000;
        state.seek(state.positionMs + step);
      },
    ],
  ];
  const registered: MediaSessionAction[] = [];
  for (const [action, handler] of handlers) {
    // 平台不支持某个动作时 `setActionHandler` 会抛 NotSupportedError，跳过就行。
    try {
      session.setActionHandler(action, handler);
      registered.push(action);
    } catch {
      /* 这个动作在这台机器上不存在，忽略。 */
    }
  }

  /**
   * 探针用的接缝（和 `window.__piAudio` 同一路数）：`setActionHandler` 没有 getter，主进程冒烟
   * 没法从外面看出「到底接上了哪几个动作」。只读地挂一份清单，冒烟读它来断言接线成功。
   */
  window.__piMediaSession = { actions: registered };

  let lastSongId: number | null = null;

  const sync = (state: ReturnType<typeof usePlayer.getState>): void => {
    const songId = state.currentSong?.id ?? null;
    if (songId !== lastSongId) {
      lastSongId = songId;
      session.metadata = state.currentSong === null ? null : metadataOf(state.currentSong);
    }
    session.playbackState =
      state.status === 'playing' ? 'playing' : state.status === 'paused' ? 'paused' : 'none';

    const duration = state.durationMs / 1000;
    // `setPositionState` 对参数很挑：duration 必须是有限的 >0，position 不能超出 duration，
    // 否则抛 TypeError（解析出时长之前这里就该什么都不报）。
    if (Number.isFinite(duration) && duration > 0) {
      try {
        session.setPositionState({
          duration,
          position: Math.min(Math.max(0, state.positionMs / 1000), duration),
          playbackRate: 1,
        });
      } catch {
        /* 参数不合法（比如刚好在切歌的中间态），下一帧会再报一次。 */
      }
    }
  };

  sync(usePlayer.getState());
  usePlayer.subscribe(sync);
}
