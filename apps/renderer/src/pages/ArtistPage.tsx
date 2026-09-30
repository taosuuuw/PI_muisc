import type { ReactNode } from 'react';
import { Icon } from '../components/Icons';
import { SongCollage } from '../components/SongCollage';
import { SongList } from '../components/SongList';
import { errorMessage } from '../bridge';
import { ARTIST_PAGE_LIMIT, albumsOf, artistSubtitle } from '../lib/artist-albums';
import { coverAt } from '../lib/cover';
import { useArtistSongs } from '../lib/queries';
import { useUi, type SongPageTarget } from '../state/ui';

/**
 * 歌手独立页（M4 剩余项：以前点歌手名只是开浮层，拿不到 id 时还会跳搜索页）。
 *
 * 上半部：头像 + 歌手名 + 副标题；下半部两区 ——「热门歌曲」与「专辑」。
 *
 * 为什么「专辑」区是从歌曲里派生的：`library:artist-songs` 只返回歌，
 * `packages/shared/src/index.ts` 的 `ArtistRef` 只有 `{ id, name }`，没有任何
 * 「歌手的专辑列表」通道；`packages/ncm-client/src/index.ts` 的 `artistSongs`
 * 甚至注释明说总数接口不给。所以只能拿已载回的歌曲按 `song.album` 去重
 * （`lib/artist-albums.ts` 的 `albumsOf`，纯函数 + 单测），点专辑卡进专辑页。
 *
 * 「歌手简介」这一格**故意不写**：没有数据源，编一段介绍比留白更糟。
 */
export interface ArtistPageProps {
  target: SongPageTarget;
}

/** 见 `AlbumPage.tsx` 的注释：列表组件自己发播放，这里不重复调 `play`。 */
const noop = (): void => {};

export function ArtistPage({ target }: ArtistPageProps): ReactNode {
  const query = useArtistSongs(target.id, true, ARTIST_PAGE_LIMIT);
  const collage = useUi((s) => s.uiStyle) === 'avant';
  const openSongPage = useUi((s) => s.openSongPage);

  const songs = query.data?.tracks ?? [];
  const hasMore = query.data?.hasMore === true;
  const albums = albumsOf(songs);
  const cover = coverAt(target.coverUrl, 400);
  const failure = query.error;
  const subtitle = artistSubtitle(songs.length, albums.length, hasMore);

  /** 点专辑卡：换的是**同一层页面**里的目标（外壳不重播进出场，见 `SongPageOverlay` 的注释）。 */
  const openAlbum = (id: number, name: string, coverUrl: string | undefined): void => {
    openSongPage({
      kind: 'album',
      id,
      title: name,
      subtitle: target.title,
      ...(coverUrl === undefined ? {} : { coverUrl }),
    });
  };

  return (
    <section
      className={collage ? 'pi-songpage pi-songpage--collage' : 'pi-songpage'}
      data-artist-page="true"
      data-artist-id={target.id}
      data-artist-songs={songs.length}
      data-artist-albums={albums.length}
      data-artist-more={hasMore ? 'true' : 'false'}
    >
      <header className="pi-songpage__hero">
        {cover === undefined ? (
          <div className="pi-songpage__cover pi-songpage__cover--artist pi-plcard__cover--empty">
            <Icon name="artist" size={44} />
          </div>
        ) : (
          <img className="pi-songpage__cover pi-songpage__cover--artist" src={cover} alt="" />
        )}
        <div className="pi-songpage__heading">
          <span className="pi-songpage__kind">歌手</span>
          <h2 className="pi-songpage__title">{target.title}</h2>
          <p className="pi-songpage__meta" data-artist-subtitle>
            {subtitle}
          </p>
        </div>
      </header>

      <div className="pi-songpage__body">
        {failure !== null && failure !== undefined ? (
          <p className="pi-placeholder">{errorMessage(failure)}</p>
        ) : query.isPending ? (
          <p className="pi-placeholder">正在加载…</p>
        ) : songs.length === 0 ? (
          <p className="pi-placeholder">这位歌手还没有能播放的歌。</p>
        ) : (
          <>
            <section
              className="pi-songpage__section pi-songpage__tracks"
              data-artist-section="hot"
            >
              <div className="pi-songpage__section-head">
                <h3 className="pi-songpage__section-title">热门歌曲</h3>
                <span className="pi-songpage__section-count">
                  {songs.length} 首{hasMore ? '（还有更多）' : ''}
                </span>
              </div>
              {collage ? (
                <SongCollage songs={songs} onSelect={noop} />
              ) : (
                <SongList songs={songs} onSelect={noop} />
              )}
            </section>

            {albums.length > 0 ? (
              <section className="pi-songpage__section" data-artist-section="albums">
                <div className="pi-songpage__section-head">
                  <h3 className="pi-songpage__section-title">专辑</h3>
                  <span className="pi-songpage__section-count">{albums.length} 张</span>
                </div>
                {/* 复用歌单那套卡片外观（`.pi-grid` + `.pi-plcard`，见 styles/playlist-cards.css），
                    只换数据来源与 `data-*` 钩子：`data-album-card` 给冒烟数卡 / 认专辑名。 */}
                <div className="pi-grid" data-artist-album-grid="true">
                  {albums.map((album) => {
                    const albumCover = coverAt(album.coverUrl, 400);
                    return (
                      <button
                        key={album.id}
                        type="button"
                        className="pi-plcard"
                        data-album-card={album.id}
                        data-album-name={album.name}
                        data-album-count={album.count}
                        title={album.name}
                        onClick={() => openAlbum(album.id, album.name, album.coverUrl)}
                      >
                        {albumCover === undefined ? (
                          <div className="pi-plcard__cover pi-plcard__cover--empty">
                            <Icon name="album" size={26} />
                          </div>
                        ) : (
                          <img className="pi-plcard__cover" src={albumCover} alt="" loading="lazy" />
                        )}
                        <span className="pi-plcard__name">{album.name}</span>
                        <span className="pi-plcard__meta">{album.count} 首在这里</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
