import { describe, expect, it } from 'vitest';
import type { Song } from '@pi/shared';
import {
  ALBUM_PAGE_LIMIT,
  ARTIST_PAGE_LIMIT,
  albumSubtitle,
  albumsOf,
  artistSubtitle,
} from './artist-albums';

/**
 * M4 剩余项「专辑/歌手独立页」的两条派生。
 *
 * 这几条断言锁的是「不编造」：专辑张数必须只由已载入的歌曲派生、曲目数拿不到时
 * 不许瞎填、`total` 与已载入数不一致时必须两个都写出来。这几件事在界面上看起来
 * 都只是「一行小字」，手动点几下很难发现写错了。
 */
function song(
  id: number,
  album: { id: number; name: string; coverUrl?: string } | undefined,
): Song {
  return {
    id,
    name: `歌 ${id}`,
    artists: [{ id: 1, name: '某人' }],
    ...(album === undefined ? {} : { album }),
  };
}

describe('albumsOf', () => {
  it('同一张专辑合并成一格，曲目数按出现次数累加', () => {
    const albums = albumsOf([
      song(1, { id: 10, name: '甲' }),
      song(2, { id: 10, name: '甲' }),
      song(3, { id: 20, name: '乙' }),
    ]);
    expect(albums).toHaveLength(2);
    expect(albums[0]).toEqual({ id: 10, name: '甲', count: 2 });
    expect(albums[1]).toEqual({ id: 20, name: '乙', count: 1 });
  });

  it('跳过没有专辑信息、以及专辑 id 非正的歌（负 id 会被协议拒掉）', () => {
    const albums = albumsOf([
      song(1, undefined),
      song(2, { id: 0, name: '无 id' }),
      song(3, { id: -5, name: '负 id' }),
      song(4, { id: 30, name: '丙' }),
    ]);
    expect(albums).toEqual([{ id: 30, name: '丙', count: 1 }]);
  });

  it('封面取第一个非空的；先空后有也能补上', () => {
    const albums = albumsOf([
      song(1, { id: 10, name: '甲' }),
      song(2, { id: 10, name: '甲', coverUrl: 'https://x/1.jpg' }),
      song(3, { id: 10, name: '甲', coverUrl: 'https://x/2.jpg' }),
    ]);
    expect(albums).toHaveLength(1);
    expect(albums[0]?.coverUrl).toBe('https://x/1.jpg');
  });

  it('排序：曲目数多的在前，同数按名字，且不吃调用顺序', () => {
    const forward = albumsOf([
      song(1, { id: 1, name: 'b' }),
      song(2, { id: 2, name: 'a' }),
      song(3, { id: 3, name: 'c' }),
      song(4, { id: 3, name: 'c' }),
    ]);
    expect(forward.map((album) => album.id)).toEqual([3, 2, 1]);
    const backward = albumsOf([
      song(4, { id: 3, name: 'c' }),
      song(3, { id: 3, name: 'c' }),
      song(2, { id: 2, name: 'a' }),
      song(1, { id: 1, name: 'b' }),
    ]);
    expect(backward.map((album) => album.id)).toEqual([3, 2, 1]);
  });

  it('空输入给空清单（不做任何占位）', () => {
    expect(albumsOf([])).toEqual([]);
  });
});

describe('artistSubtitle', () => {
  it('有专辑时把张数接在后面，没有就只写歌曲数', () => {
    expect(artistSubtitle(50, 4, false)).toBe('热门 50 首 · 4 张专辑');
    expect(artistSubtitle(50, 0, false)).toBe('热门 50 首');
  });

  it('hasMore 为真时写「还有更多」，不编造总数', () => {
    expect(artistSubtitle(200, 3, true)).toBe('热门 200 首（还有更多） · 3 张专辑');
  });
});

describe('albumSubtitle', () => {
  it('后端给了曲目数就用它，歌手名接在最前面', () => {
    expect(albumSubtitle('林忆莲', 12, 12)).toBe('林忆莲 · 12 首');
    expect(albumSubtitle('林忆莲', 12, 5)).toBe('林忆莲 · 已载入 5 / 共 12 首');
  });

  it('没有总数 / 总数为 0 时退回已载入数', () => {
    expect(albumSubtitle(undefined, undefined, 30)).toBe('30 首');
    expect(albumSubtitle('', 0, 30)).toBe('30 首');
  });
});

describe('每页拉取条数', () => {
  it('两页都不超过协议的 limit 上限 200', () => {
    expect(ARTIST_PAGE_LIMIT).toBeLessThanOrEqual(200);
    expect(ALBUM_PAGE_LIMIT).toBeLessThanOrEqual(200);
    expect(ARTIST_PAGE_LIMIT).toBeGreaterThan(0);
    expect(ALBUM_PAGE_LIMIT).toBeGreaterThan(0);
  });
});
