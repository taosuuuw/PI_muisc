import type { ReactNode } from 'react';
import { Icon } from '../components/Icons';
import { SongCollage } from '../components/SongCollage';
import { SongList } from '../components/SongList';
import { errorMessage } from '../bridge';
import { ALBUM_PAGE_LIMIT, albumSubtitle } from '../lib/artist-albums';
import { coverAt } from '../lib/cover';
import { artistNames } from '../lib/format';
import { useAlbumSongs } from '../lib/queries';
import { useUi, type SongPageTarget } from '../state/ui';

/**
 * 专辑独立页（M4 剩余项：以前点专辑名只是开一张浮层 / 跳搜索页，现在是一整页）。
 *
 * 身体分三段（`.pi-songpage` 的网格）：大封面 + 名称 · 副标题 + 曲目列表。
 * 外壳（玻璃、相位进出场、顶栏、Esc / 点空白关）在 `components/SongPageOverlay.tsx` 里，
 * 这里只管内容 —— 所以这一页既能当独立页，也不会把「怎么进出场」重复实现一遍。
 *
 * 数据：`library:album-songs`（`useAlbumSongs`，见 `lib/queries.ts:180-186`），
 * 一次 `GET /album` 由主进程拿全再本地切片，`TrackPage.total` 因此**有值**
 * （`packages/ncm-client/src/index.ts` 的 `albumSongs`：`total = album.size` 兜底），
 * 副标题的曲目数就来自它。协议上限 200 会截断超大专辑，截断时两个数都写出来（见 `albumSubtitle`）。
 */
export interface AlbumPageProps {
  target: SongPageTarget;
}

/**
 * `SongList` / `SongCollage` 点下去**自己**就 `play(songs, index)`（`components/SongList.tsx:54-57`），
 * 所以这里不重复发播放（浮层那份 `SongListOverlay` 里 `onSelect` 又 `play` 一次是历史写法，
 * 这里不照抄）。独立页与浮层的另一处差别：浮层点完要关，页面点完**留在原地**，
 * 正在播的那一行由 `SongList` 自己的 `data-playing` 反映。
 */
const noop = (): void => {};

export function AlbumPage({ target }: AlbumPageProps): ReactNode {
  const query = useAlbumSongs(target.id, true, ALBUM_PAGE_LIMIT);
  /** 第十七轮第 ②③ 条那套分流：平凡 = 竖排列表，先锋 = 队列拼贴。 */
  const collage = useUi((s) => s.uiStyle) === 'avant';

  const songs = query.data?.tracks ?? [];
  const total = query.data?.total;
  const cover = coverAt(target.coverUrl, 400);
  const failure = query.error;
  const subtitle = albumSubtitle(target.subtitle, total, songs.length);

  return (
    <section
      className={collage ? 'pi-songpage pi-songpage--collage' : 'pi-songpage'}
      data-album-page="true"
      data-album-id={target.id}
      data-album-tracks={songs.length}
      data-album-total={total === undefined ? '' : total}
    >
      <header className="pi-songpage__hero">
        {cover === undefined ? (
          <div className="pi-songpage__cover pi-plcard__cover--empty">
            <Icon name="album" size={44} />
          </div>
        ) : (
          <img className="pi-songpage__cover" src={cover} alt="" />
        )}
        <div className="pi-songpage__heading">
          <span className="pi-songpage__kind">专辑</span>
          <h2 className="pi-songpage__title">{target.title}</h2>
          <p className="pi-songpage__meta" data-album-subtitle>
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
          <p className="pi-placeholder">这张专辑里还没有能播放的歌。</p>
        ) : (
          <section className="pi-songpage__section pi-songpage__tracks" data-album-section="tracks">
            <div className="pi-songpage__section-head">
              <h3 className="pi-songpage__section-title">曲目</h3>
              <span className="pi-songpage__section-count">{subtitle}</span>
            </div>
            {collage ? (
              <SongCollage songs={songs} onSelect={noop} />
            ) : (
              /* 专辑页里「专辑名」是废话（整页都是它），行右侧改成这首歌自己的演唱者。 */
              <SongList songs={songs} onSelect={noop} metaOf={artistNames} />
            )}
          </section>
        )}
      </div>
    </section>
  );
}
