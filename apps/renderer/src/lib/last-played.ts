import { useEffect } from 'react';
import type { Song } from '@pi/shared';
import { usePlayer } from '../state/player';

/**
 * 「上一次听的那首歌」的本地快照（用户 m05361 第 2 条：重启后仍进详情页）。
 *
 * 为什么放 localStorage 而不是设置文件：
 * - 它只是界面状态，丢了顶多回到空白页，不该污染 `settings.json`（那份文件有版本迁移）；
 * - 一次要存整条队列（几十首），走 IPC 落盘太重。
 *
 * 只存最小字段：当前歌 + 队列里的歌。解析结果（音源地址、实测音质）**不存**——
 * 地址会过期、音质得重新探测，恢复之后按播放键会重新解析（`restoreLast` 特意不联网）。
 */
const KEY = 'pi:last-played';
const VERSION = 1;
/** 队列可能上百首，只留最近这批就够恢复现场。 */
const MAX_SONGS = 60;

interface Snapshot {
  version: number;
  song: Song;
  songs: Song[];
}

function readLastPlayed(): Snapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Snapshot;
    if (!parsed || parsed.version !== VERSION) return null;
    if (!parsed.song || typeof parsed.song.id !== 'number' || !parsed.song.name) return null;
    /* 队列那一半也要验：以前这里只看 `song`，`songs` 被原样交给 `restoreLast()` 建队列，
       于是「不是数组」「条目没有 id」这类脏 payload 会让 `queue.ids` 里出现**取不到歌曲资料**
       的 id（`SongListOverlay` 是按 id 查 `songs` 的，查不到就被整条过滤掉），或者在建队时直接抛。 */
    const songs = Array.isArray(parsed.songs)
      ? parsed.songs.filter((song): song is Song => Boolean(song) && typeof song.id === 'number')
      : [];
    return { version: VERSION, song: parsed.song, songs };
  } catch {
    return null;
  }
}

function writeLastPlayed(song: Song, songs: readonly Song[]): void {
  try {
    const payload: Snapshot = { version: VERSION, song, songs: songs.slice(0, MAX_SONGS) };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // 隐私模式/配额满都可能抛，恢复现场失败不影响播放。
  }
}

/** 挂在 App 根部：启动恢复一次，之后在换歌/换队列时写回。 */
export function useLastPlayed(): void {
  useEffect(() => {
    const snapshot = readLastPlayed();
    if (snapshot) usePlayer.getState().restoreLast(snapshot.song, snapshot.songs);
  }, []);

  useEffect(() => {
    // 播放进度每秒改好几次 state，用「歌 + 队列形状」当指纹，只有真的换歌才落盘。
    let fingerprint = '';
    const persist = (): void => {
      const { currentSong, queue, songs } = usePlayer.getState();
      if (!currentSong) return;
      const next = `${currentSong.id}|${queue.ids.length}|${queue.ids[0] ?? ''}|${queue.ids[queue.ids.length - 1] ?? ''}`;
      if (next === fingerprint) return;
      fingerprint = next;
      writeLastPlayed(
        currentSong,
        queue.ids.map((id) => songs[id]).filter((song): song is Song => Boolean(song)),
      );
    };
    persist();
    return usePlayer.subscribe(persist);
  }, []);
}
