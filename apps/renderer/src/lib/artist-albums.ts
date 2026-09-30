/**
 * 歌手页 / 专辑页要用到的两次派生 + 一次文案拼装（M4 剩余项：专辑/歌手独立页）。
 *
 * 为什么派生放在这里、不放进组件：这两页的数据源只有两条既有通道
 * （`library:artist-songs` / `library:album-songs`，见 `packages/ipc/src/index.ts:584-585`），
 * 它们**只给歌**，不给「歌手的专辑列表」「专辑发行日期」这些字段
 * （`packages/shared/src/index.ts` 里 `ArtistRef` / `AlbumRef` 只有 id / name / coverUrl，
 * `ncm-client` 的 `artistSongs` 连总数都不给，注释原话是「歌手歌曲的总数接口不给」）。
 * 所以歌手页的「专辑」区只能从**已拉回来的热门歌曲**里按 `song.album.id` 去重派生 ——
 * 这一段是纯函数，能单测，且「派生出来的张数」会写进 `data-artist-albums` 供冒烟读。
 */
import type { Song } from '@pi/shared';

/**
 * 两页一次拉多少首。
 *
 * 上限来自协议而不是拍脑袋：`packages/ipc/src/index.ts:246-249` 的
 * `PagedRequestSchema.limit` 是 `z.number().int().min(1).max(200)`，超过 200 直接被拒。
 * 所以这里取满 200（专辑页本来就是一次拿全再本地切片，歌手页 order=hot 前 200 足够）。
 */
export const ARTIST_PAGE_LIMIT = 200;
export const ALBUM_PAGE_LIMIT = 200;

/** 歌手页「专辑」区的一格。 */
export interface AlbumEntry {
  id: number;
  name: string;
  coverUrl?: string;
  /** **这一页歌曲里**属于这张专辑的曲目数，不是专辑总曲目数（接口不给后者）。 */
  count: number;
}

/**
 * 从一批歌曲里派生专辑清单。
 *
 * 规则（每一条都是「不编造」的取舍）：
 * - `album` 缺失或 `id <= 0` 的跳过：id 非正说明这条歌的专辑信息不完整，
 *   拿去开专辑页会被 `IdPageRequestSchema`（id 必须为正）拒掉，宁可不显示这一格；
 * - 同 id 合并，`count` 累加，封面取第一个非空的（同专辑不同歌的封面 URL 允许为空）；
 * - 排序：曲目数多的在前，同数按名字排（不给 localeCompare 传环境相关的选项，
 *   保证同一份输入在任何机器上给出同一份顺序，冒烟读到的张数/首张名字才稳定）。
 */
export function albumsOf(songs: readonly Song[]): AlbumEntry[] {
  const byId = new Map<number, AlbumEntry>();
  for (const song of songs) {
    const album = song.album;
    if (album === undefined || album.id <= 0) continue;
    const found = byId.get(album.id);
    if (found !== undefined) {
      found.count += 1;
      if (found.coverUrl === undefined && album.coverUrl !== undefined) {
        found.coverUrl = album.coverUrl;
      }
      continue;
    }
    byId.set(album.id, {
      id: album.id,
      name: album.name,
      count: 1,
      ...(album.coverUrl === undefined ? {} : { coverUrl: album.coverUrl }),
    });
  }
  return [...byId.values()].sort(
    (a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/**
 * 歌手页副标题。
 *
 * 只写**真拿得到**的两个数：已拉回来的热门歌曲数、派生出来的专辑数。
 * 不写「歌手简介」（`packages/shared` 没有这个字段，也没有对应通道）、
 * 不写「共 N 首」（同上，`artistSongs` 的注释明说不给总数）——
 * `hasMore` 为真时把「还有更多」写出来，比编一个更大的数字诚实。
 */
export function artistSubtitle(songCount: number, albumCount: number, hasMore: boolean): string {
  const songs = hasMore ? `热门 ${songCount} 首（还有更多）` : `热门 ${songCount} 首`;
  return albumCount > 0 ? `${songs} · ${albumCount} 张专辑` : songs;
}

/**
 * 专辑页副标题：`歌手 · 曲目数`。
 *
 * `artist` 是调用方（播放页名片的专辑键）顺着传下来的歌手名 —— 专辑通道
 * （`library:album-songs` → `GET /album`）返回的曲目里虽然每首都有 `artists`，
 * 但那是**单曲的**演唱者，合辑里会一行一个名字，直接拿去当整张专辑的歌手是错的。
 *
 * `total` 只在后端真给得出时才有值（`ncm-client` 的 `albumSongs` 用 `album.size` 兜底），
 * 拿不到就退回已载入数；两者不一致时（>200 首的专辑被协议上限截断）两个数都写出来。
 */
export function albumSubtitle(
  artist: string | undefined,
  total: number | undefined,
  loaded: number,
): string {
  const known = total !== undefined && total > 0 ? total : loaded;
  const tracks =
    total !== undefined && total > loaded ? `已载入 ${loaded} / 共 ${total} 首` : `${known} 首`;
  return artist === undefined || artist === '' ? tracks : `${artist} · ${tracks}`;
}
