/**
 * 「歌词还在路上吗」的用例（用户本轮第 2 条：点播放键也要等歌词）。
 *
 * 这一条决定「按播放键要不要先等歌词」，所以三种落定状态都得钉住：
 * 没查过 / 正在跑 / **已经失败**。「失败也算落定」是这条函数存在的理由——
 * 纯音乐、上游没收录那类歌拿不到词，要是把它们算成「还在加载」，
 * 用户每次按播放键都要白等一个闸门（最坏 9 秒）才出声。
 */
import { describe, expect, it } from 'vitest';
import type { Lyric, Song } from '@pi/shared';

import { hasCachedLyric, isLyricPending } from './lyric-prefetch';
import { lyricQueryKey } from './queries';
import { queryClient } from './query-client';

/** 拼缓存键只需要 `id`，其余字段按 `Song` 收窄掉（这个用例不碰网络也不碰 UI）。 */
function songOf(id: number): Song {
  return {
    id,
    name: `测试-${id}`,
    artists: [{ id: 1, name: 'A' }],
    durationMs: 200_000,
  } as unknown as Song;
}

const MODE = 'auto' as const;

describe('isLyricPending（歌词还在路上吗）', () => {
  it('从来没查过 ⇒ 算在路上（该等）', () => {
    const song = songOf(9001);
    expect(hasCachedLyric(song, MODE)).toBe(false);
    expect(isLyricPending(song, MODE)).toBe(true);
  });

  it('缓存里已经有词 ⇒ 不在路上（按播放键一秒都不多等）', () => {
    const song = songOf(9002);
    queryClient.setQueryData(lyricQueryKey(song, MODE), { lines: [] } as unknown as Lyric);
    expect(hasCachedLyric(song, MODE)).toBe(true);
    expect(isLyricPending(song, MODE)).toBe(false);
  });

  it('查询失败过 ⇒ 也算落定，不在路上（纯音乐不该每次按播放都白等）', () => {
    const song = songOf(9003);
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: lyricQueryKey(song, MODE),
    });
    query.setState({
      status: 'error',
      error: new Error('上游没有这首歌的歌词'),
      fetchStatus: 'idle',
    });
    expect(hasCachedLyric(song, MODE)).toBe(false);
    expect(isLyricPending(song, MODE)).toBe(false);
  });

  it('查询已经建起来但还没落定 ⇒ 在路上', () => {
    const song = songOf(9004);
    // 只造壳、不 fetch：`build()` 造出来的是 pending/idle 的查询，正好模拟「请求已发出、还没回来」。
    queryClient.getQueryCache().build(queryClient, { queryKey: lyricQueryKey(song, MODE) });
    expect(isLyricPending(song, MODE)).toBe(true);
  });

  it('没有合法 id 的歌（0 / NaN）不算在路上：那种歌连歌词请求都不会发出去', () => {
    expect(isLyricPending(songOf(0), MODE)).toBe(false);
    expect(isLyricPending({ id: Number.NaN } as unknown as Song, MODE)).toBe(false);
  });
});
