import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Playlist, Song } from '@pi/shared';
import { CH, errorMessage, invoke } from '../bridge';
import { coverAt } from '../lib/cover';
import { useNowPlaying } from '../state/nowPlaying';
import { useUi } from '../state/ui';
import { AddTracksPanel } from './AddTracksPanel';
import { Icon } from './Icons';
// 第十七轮第 ②③ 条：歌曲列表分两套 —— 平凡 = 竖排列表（`SongList`），
// 先锋 = 队列拼贴（`SongCollage`，塞进这层浮层的正文格里）。
import { SongCollage, type SongCollageHandle } from './SongCollage';
import { SongList } from './SongList';
// 第十八轮第 7 条：拼贴顶上那条滚轮搜索，和「我的喜欢」共用同一个组件。
import { CollageSearchBar, COLLAGE_SEARCH_EXIT_MS } from './CollageSearchBar';
// 用户 m03805 第 1 条：平凡列表的「加载更多」按钮换成下滑自动加载。
import { useAutoLoadMore } from '../lib/useAutoLoadMore';

export interface PlaylistDetailProps {
  playlist: Playlist;
  onClose: () => void;
}

const PAGE_SIZE = 100;

/**
 * 用户 m00001 第 3 条(A)：进先锋歌单页时，拼贴墙挂载前最多先替它拉这么多页（20 页 = 2000 首）。
 * 拉满还没拉完就先上墙（`hasMore` 仍为 true），由用户拖到边再续 —— 不然超大歌单会一直卡在骨架上。
 */
const PRELOAD_MAX_PAGES = 20;

/**
 * 歌单详情覆盖层。
 *
 * 分页策略：`/playlist/track/all` 不返回总数，只能按「这一页是否装满」推断还有没有
 * 下一页。因此这里用「累加 + 按 id 去重」的方式拼接，而不是直接替换列表——万一
 * 后端在两页之间插入了新歌导致顺序偏移，也不会出现重复行。
 *
 * 调用方务必给它 `key={playlist.id}`：换歌单时直接重挂载，省掉一堆重置状态的分支。
 */
export function PlaylistDetail({ playlist, onClose }: PlaylistDetailProps) {
  const [tracks, setTracks] = useState<Song[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  // 加歌面板：只有自己的歌单能加（收藏来的歌单是别人的，加不进去）。
  const [adding, setAdding] = useState(false);
  const canEdit = playlist.subscribed !== true;
  const select = useNowPlaying((s) => s.select);
  /** 第十七轮第 ②③ 条：「歌曲列表」长什么样由全局风格开关决定。 */
  const uiStyle = useUi((s) => s.uiStyle);
  /** 第十八轮第 7 条：拼贴顶上那条搜索（往墙上定位）要拿到拼贴句柄。 */
  const collageRef = useRef<SongCollageHandle>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  /** 正在播退场动画（升回顶部）的那一帧，还不能卸载搜索条。 */
  const [searchClosing, setSearchClosing] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchNote, setSearchNote] = useState('');
  const searchTimer = useRef<number | null>(null);
  const searchOpenRef = useRef(false);

  useEffect(
    () => () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    },
    [],
  );

  /** 第十八轮第 7 条：开 = 从顶部往下冒出，关 = 升回顶部（动画放完再卸载）。 */
  const openSearch = useCallback(() => {
    if (searchTimer.current !== null) {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    searchOpenRef.current = true;
    setSearchClosing(false);
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    if (!searchOpenRef.current || searchTimer.current !== null) return;
    searchOpenRef.current = false;
    setSearchClosing(true);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      setSearchClosing(false);
      setSearchOpen(false);
    }, COLLAGE_SEARCH_EXIT_MS);
  }, []);

  /** 和「我的喜欢」同口径：按歌名 / 歌手 / 专辑在**已上墙**的歌里找第一首并居中。 */
  const locate = useCallback((keyword: string) => {
    setSearchInput(keyword);
    const trimmed = keyword.trim();
    if (trimmed === '') {
      setSearchNote('');
      return;
    }
    const hit = collageRef.current?.focusSong(trimmed) ?? null;
    setSearchNote(hit === null ? `墙上的歌里没有匹配的「${trimmed}」` : `已定位到第 ${hit.index + 1} 首拼贴`);
  }, []);

  const query = useQuery({
    queryKey: ['library', 'playlist', playlist.id, offset],
    queryFn: () =>
      invoke(CH.libraryPlaylistTracks, { playlistId: playlist.id, offset, limit: PAGE_SIZE }),
  });

  useEffect(() => {
    if (!query.data) return;
    setTracks((prev) => {
      const base = offset === 0 ? [] : prev;
      const seen = new Set(base.map((song) => song.id));
      return [...base, ...query.data.tracks.filter((song) => !seen.has(song.id))];
    });
    setHasMore(query.data.hasMore);
  }, [query.data, offset]);

  /**
   * 用户 m03805 第 1 条（原来的「加载更多」按钮改成下滑自动加载）：
   * 平凡列表末尾那颗哨兵滚进预载区就要下一页 —— 分页管道一个字没动，还是 `setOffset` 累加
   * `PAGE_SIZE`。先锋模式不挂这颗哨兵（拼贴靠拖到边 `onNeedMore` 续页），所以 `canLoad` 里带上风格。
   */
  const loadMoreRef = useAutoLoadMore({
    canLoad: uiStyle !== 'avant' && hasMore,
    loading: query.isFetching,
    onLoad: () => setOffset((n) => n + PAGE_SIZE),
  });

  /** 用户 m00001 第 3 条(A)：进页预拉只做一次 —— 墙挂上之后就不再自动续拉，续拉只由用户拖到边触发。 */
  const [preloadDone, setPreloadDone] = useState(false);

  /**
   * 用户 m00001 第 3 条(A)：先锋下「歌曲集合已经稳定」才允许挂拼贴。
   *
   * 稳定 = 「这一页说后面没有了」或者「已经拉满 `PRELOAD_MAX_PAGES` 页」，二者都要求当前没有
   * 在飞的请求（新 key 的 `query.data` 是 undefined）—— 否则会在半路上把墙挂出来，又变成
   * 「拼贴已经在、歌曲还在变」。出错就放行，不然骨架会一直挂着。
   */
  const preloadExhausted = query.data !== undefined && query.data.hasMore !== true;
  const collageReady =
    uiStyle !== 'avant' ||
    preloadExhausted ||
    query.isError ||
    offset >= PRELOAD_MAX_PAGES * PAGE_SIZE;

  /**
   * 用户 m00001 第 3 条(A)：「先把歌曲加载好，再加载拼贴」。
   *
   * 为什么必须等：拼贴的座位是 `queueIndexOf` 用 `seat % total` 回卷出来的，而 `geometryFor`
   * 的每行块数也跟着 `total` 走 —— 进页时只要还有下一页在路上，`total` 一变、几何一重算，
   * 墙上每一格的歌就会换人。之前靠 `autoMore` 一边上墙一边续拉，用户看到的正是
   * 「拼贴已经在、歌曲不停变化」。这里改成：先**顺序**把剩下的页拉完（不并发，免得接口回
   * 「操作频繁」），拉完才挂 `<SongCollage>`，于是 `total` 只算一次、几何只算一次，一格都不会换。
   * 超过 `PRELOAD_MAX_PAGES` 页的超大歌单不再干等：先把墙挂出来，剩下的交给「拖到边再续」。
   *
   * 判据用 `query.data.hasMore`（刚回来的那一页自己的说法）而不是 `hasMore` 这个 state：
   * state 要下一帧才更新，用它会在最后一页之后再白发一次请求。
   */
  useEffect(() => {
    if (uiStyle !== 'avant' || preloadDone) return;
    if (!query.isSuccess || query.isError || query.isFetching) return;
    if (query.data?.hasMore !== true) return;
    if (offset >= PRELOAD_MAX_PAGES * PAGE_SIZE) return;
    setOffset((n) => n + PAGE_SIZE);
  }, [offset, preloadDone, query.data, query.isError, query.isFetching, query.isSuccess, uiStyle]);

  useEffect(() => {
    if (collageReady) setPreloadDone(true);
  }, [collageReady]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cover = coverAt(playlist.coverUrl, 400);
  // 曲目数是活的：全拉完了就以本地列表为准（刚加完歌 prop 里的 trackCount 还是旧的）。
  const liveCount = query.isSuccess && !hasMore ? tracks.length : playlist.trackCount;

  return (
    <section className="pi-detail" aria-label={`歌单 ${playlist.name}`}>
      {/* 第九轮第 3 条：歌单浮层里的「返回」键删掉了——点玻璃空白处（或按 Esc）就收回播放页。 */}
      <header className="pi-detail__bar">
        <strong>歌单</strong>
        <span className="pi-detail__spacer" />
        {canEdit ? (
          <button
            type="button"
            className="pi-btn pi-btn--small"
            data-addtracks-open
            onClick={() => setAdding((open) => !open)}
          >
            {adding ? '收起' : '添加歌曲'}
          </button>
        ) : null}
      </header>

      <div className="pi-detail__body">
        <div className="pi-detail__hero">
          {cover ? (
            <img className="pi-detail__cover" src={cover} alt="" />
          ) : (
            <div className="pi-detail__cover pi-plcard__cover--empty">
              <Icon name="music" size={34} />
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <h2 className="pi-detail__title">{playlist.name}</h2>
            <p className="pi-page-sub">
              {playlist.creator ? `${playlist.creator} · ` : ''}
              {liveCount} 首
            </p>
          </div>
        </div>

        {adding ? (
          <AddTracksPanel
            playlistId={playlist.id}
            onClose={() => setAdding(false)}
            onAdded={() => {
              // 加完一首就把累加出来的列表清掉、从第 0 页重拉：新歌的位置由云端决定，
              // 本地「往尾部追加」会在歌单被插入到中间时与线上顺序对不上。
              setTracks([]);
              setOffset(0);
            }}
          />
        ) : null}

        {query.isError ? (
          <div className="pi-card pi-placeholder">
            <strong>歌单加载失败</strong>
            <span>{errorMessage(query.error)}</span>
          </div>
        ) : null}

        {!query.isPending && !query.isError && tracks.length === 0 && canEdit ? (
          <button
            type="button"
            className="pi-detail__empty"
            data-playlist-empty
            onClick={() => setAdding(true)}
          >
            <strong>这个歌单还是空的</strong>
            <span>点这里搜一首歌加进来</span>
          </button>
        ) : uiStyle === 'avant' ? (
          /* 先锋：队列拼贴。这一格自己的定位交给 `overlays.css` 的
             `.pi-listoverlay--collage .pi-collage`（默认是 fixed inset:0，会盖住浮层顶栏）。
             用户 m00001 第 3 条(A)：歌曲没拉完之前**不挂**墙，只挂一层同款背景的骨架 ——
             这就是「先把歌曲加载好再加载拼贴」。顺带把第十八轮第 6 条那个 `autoMore` 摘掉了：
             它一边上墙一边续拉，正是「拼贴已经在、歌曲不停变化」的来源；现在进页一次拉完，
             之后只有用户自己拖到边（`onNeedMore`）才会再长。 */
          <div
            className="pi-detail__collage"
            data-collage-search-host="true"
            /* 第十八轮第 7 条：滚轮向下 → 搜索条从顶部冒出来。 */
            onWheel={(event) => {
              if (event.deltaY <= 0) return;
              openSearch();
            }}
            /* 拖动拼贴 / 点格子播放时把搜索条升回顶部；点在搜索条自己身上不算。 */
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest('.pi-collage-search')) return;
              closeSearch();
            }}
          >
            {collageReady ? (
              <SongCollage
                ref={collageRef}
                songs={tracks}
                onSelect={select}
                hasMore={hasMore && tracks.length > 0 && !query.isError}
                onNeedMore={() => {
                  if (query.isFetching) return;
                  setOffset((n) => n + PAGE_SIZE);
                }}
              />
            ) : (
              // 骨架：和 `.pi-collage` 同一层背景，切到真墙时不会闪；里面一个 `data-collage-cell` 都没有。
              <div className="pi-collage-skeleton" data-collage-loading="true">
                <span className="pi-collage-skeleton__text">
                  {tracks.length > 0 ? `正在铺开拼贴…已加载 ${tracks.length} 首` : '正在加载歌曲…'}
                </span>
              </div>
            )}
            {searchOpen || searchClosing ? (
              <CollageSearchBar
                value={searchInput}
                note={searchNote}
                closing={searchClosing}
                onChange={locate}
                onClose={closeSearch}
              />
            ) : null}
          </div>
        ) : (
          <SongList songs={tracks} onSelect={select} emptyText="这个歌单还没有歌。" />
        )}

        {query.isPending ? <div className="pi-placeholder">正在加载…</div> : null}

        {uiStyle !== 'avant' && !query.isPending && hasMore && tracks.length > 0 ? (
          /* 用户 m03805 第 1 条（原来的「加载更多」按钮改成下滑自动加载）：
             按钮整个删掉，只留这颗被动哨兵 —— 它进预载区就要下一页（`loadMoreRef`），
             加载中显示一行淡字，其余时候什么都不渲染（外壳留着，布局高度不变）。 */
          <div className="pi-loadmore" data-auto-loadmore="true" ref={loadMoreRef}>
            {query.isFetching ? <span className="pi-page-sub">加载中…</span> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
