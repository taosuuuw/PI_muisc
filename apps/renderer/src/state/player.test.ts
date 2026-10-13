/**
 * 播放状态机的时序用例（用户本轮第 1、2 条）。
 *
 * 这两条是「**什么时候出声**」的行为，界面冒烟按约定不动播放行为，覆盖不到，所以在这里钉：
 * ① 换歌时上一首要**立刻**哑（`loadCurrent()` 里的 `pause()` 在任何 `await` 之前）；
 * ② 歌词没落定时点播放键**不出声**（`toggle()` 在 `resolving` 时直接返回；歌词还在路上时
 *    先等闸门再 `play()`）。
 *
 * 三样东西全换成假的，绝不碰真音频设备、真 IPC、真网络：
 * - `lib/audio-engine`：假 `<audio>`，只把 `play()` / `pause()` 按顺序记下来；
 * - `bridge`：`playerResolve` 挂成一个**可控的**承诺，用来停在「解析中」那一刻观察行为；
 * - `lib/lyric-prefetch`：闸门与 `isLyricPending` 都由用例摆布。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '@pi/shared';

/** 假音频元素：`calls` 就是「谁来过了、按什么顺序」。 */
const audio = {
  calls: [] as string[],
  paused: true,
  currentTime: 0,
  src: '',
  play(): Promise<void> {
    this.calls.push('play');
    this.paused = false;
    return Promise.resolve();
  },
  pause(): void {
    this.calls.push('pause');
    this.paused = true;
  },
};

/** 用例摆布的开关（`vi.hoisted` 才能在 `vi.mock` 的工厂里引用）。 */
const h = vi.hoisted(() => ({
  /** `isLyricPending()` 的返回值：true = 歌词还在路上。 */
  lyricPending: false,
  /** 歌词闸门的放行把手（`prefetchLyric` 返回的那个承诺）。 */
  releaseLyric: null as null | (() => void),
  /** 音源解析的放行把手。 */
  releaseResolve: null as null | (() => void),
}));

vi.mock('../lib/audio-engine', () => ({
  getAudio: () => audio,
  applyVolume: () => {},
  currentTimeMs: () => 0,
}));

vi.mock('../bridge', () => ({
  CH: { playerResolve: 'player:resolve', settingsPatch: 'settings:patch' },
  errorMessage: (error: unknown) => String(error),
  invoke: (channel: string): Promise<unknown> => {
    if (channel !== 'player:resolve') return Promise.resolve({});
    return new Promise((resolve) => {
      h.releaseResolve = () =>
        resolve({ src: 'http://127.0.0.1:1/audio/x?t=y', audio: { container: 'mp3' }, attempts: [] });
    });
  },
}));

vi.mock('../lib/lyric-prefetch', () => ({
  LYRIC_GATE_MS: 9_000,
  prefetchLyric: () =>
    new Promise<void>((resolve) => {
      h.releaseLyric = () => resolve();
    }),
  isLyricPending: () => h.lyricPending,
}));

// 必须放在 `vi.mock` 之后（工厂提升、这里取真实模块）。
const { usePlayer } = await import('./player');

function songOf(id: number): Song {
  return { id, name: `测试-${id}`, artists: [], durationMs: 200_000 } as unknown as Song;
}

/** 把两把放行把手都放掉：解析完成 + 歌词落定。 */
function releaseAll(): void {
  h.releaseResolve?.();
  h.releaseLyric?.();
  h.releaseResolve = null;
  h.releaseLyric = null;
}

beforeEach(() => {
  audio.calls.length = 0;
  audio.paused = true;
  audio.currentTime = 0;
  audio.src = '';
  h.lyricPending = false;
  h.releaseLyric = null;
  h.releaseResolve = null;
  usePlayer.setState({ currentSong: null, src: null, status: 'idle', loadingGate: false });
});

describe('换歌与出声的时序（用户本轮第 1、2 条）', () => {
  it('① 换歌时上一首立刻哑：pause 在任何 await 之前，且新歌那时还没出声', async () => {
    const first = usePlayer.getState().play([songOf(101)], 0);
    // 还在等音源解析：这一刻必须已经静音，而且**没有**放新歌。
    expect(audio.calls).toEqual(['pause']);
    expect(usePlayer.getState().status).toBe('resolving');
    releaseAll();
    await first;
    expect(audio.calls).toEqual(['pause', 'play']);

    // 换第二首：同一个道理——一进 loadCurrent 就先哑掉正在唱的那一首。
    audio.calls.length = 0;
    const second = usePlayer.getState().play([songOf(102)], 0);
    expect(audio.calls).toEqual(['pause']);
    expect(audio.paused).toBe(true);
    releaseAll();
    await second;
    expect(audio.calls).toEqual(['pause', 'play']);
  });

  it('① 解析期间按播放键不出声（第 2 条的前半）', async () => {
    const playing = usePlayer.getState().play([songOf(103)], 0);
    releaseAll();
    await playing;
    audio.calls.length = 0;

    // 切到下一首，解析挂住 ⇒ 状态是 `resolving`：这一下按播放键什么都不该发生。
    const next = usePlayer.getState().play([songOf(104)], 0);
    expect(usePlayer.getState().status).toBe('resolving');
    await usePlayer.getState().toggle();
    expect(audio.calls).toEqual(['pause']);
    releaseAll();
    await next;
    expect(audio.calls).toEqual(['pause', 'play']);
  });

  it('② 歌词还在路上时按播放键：先等闸门，期间一秒都不出声', async () => {
    const playing = usePlayer.getState().play([songOf(105)], 0);
    releaseAll();
    await playing;
    // 播起来了：暂停（这一下是用户按的，不算「等待」）。
    await usePlayer.getState().toggle();
    expect(usePlayer.getState().status).toBe('paused');
    audio.calls.length = 0;

    // 这一首的歌词还没落定 ⇒ 再按播放键必须**先等歌词**。
    h.lyricPending = true;
    const resume = usePlayer.getState().toggle();
    expect(audio.calls).toEqual([]);
    expect(usePlayer.getState().loadingGate).toBe(true);

    h.releaseLyric?.();
    await resume;
    expect(usePlayer.getState().loadingGate).toBe(false);
    expect(audio.calls).toEqual(['play']);
  });

  it('② 歌词已经落定（含「查过但没词」）：按播放键立刻出声，不多等', async () => {
    const playing = usePlayer.getState().play([songOf(106)], 0);
    releaseAll();
    await playing;
    await usePlayer.getState().toggle();
    audio.calls.length = 0;

    h.lyricPending = false;
    await usePlayer.getState().toggle();
    // 没有闸门 ⇒ 没有 `loadingGate` 这一段，直接出声。
    expect(usePlayer.getState().loadingGate).toBe(false);
    expect(audio.calls).toEqual(['play']);
  });
});
