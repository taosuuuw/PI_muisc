import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { useEditPlaylistTracks } from '../lib/queries';

export interface PlaylistDetailProps {
  playlist: Playlist;
  onClose: () => void;
}

/** 歌单封面（有没有图都长这样）：两处用同一份，免得「可编辑 / 只读」两种形态画得不一样。 */
function PlaylistCover({ cover }: { cover: string | undefined }): ReactNode {
  return cover ? (
    <img className="pi-detail__cover" src={cover} alt="" />
  ) : (
    <span className="pi-detail__cover pi-plcard__cover--empty">
      <Icon name="music" size={34} />
    </span>
  );
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
  /**
   * 能不能改这个歌单的曲目（主人第 9 轮第 4 条：「**只有我的歌单和播放列表**可以编辑歌单歌曲，
   * 其他的都不允许」）。
   *
   * 判据收在 `subscribed === false` 这一条上：`/user/playlist` 里**自己建的**歌单明确带
   * `subscribed: false`，收藏来的带 `true`；而推荐歌单 / 收藏页那些对象来自别的接口，
   * 这个字段**根本没有**（`undefined`）。原来写的是 `subscribed !== true`，于是那些
   * 「没有这个字段」的歌单全被判成可编辑 —— 正是主人看到的那类越权。
   * 现在要求**明确说自己不是订阅的**才给编辑入口：拿不准就当不能改。
   */
  const canEdit = playlist.subscribed === false;
  /**
   * 编辑态（主人本轮第 3 条）：「点击图3红圈的图标，……每首歌左边浮现删除键，再次点击红圈图标删除键消失」。
   *
   * 图3 红圈圈的是**歌单封面**（这一页唯一像「图标」的东西），所以点封面 = 进/出编辑态。
   * 进编辑态后：每行左边浮出删除键（`SongList` 的 `editing` + `onRemove`），
   * 「添加歌曲」也只在这一姿态里出现 —— 它原来常驻右上角，主人要求去掉（绿色的那一圈）。
   * 想加歌时点封面进编辑态就能找到它，这条能力不至于因为藏起来而丢掉。
   */
  const [editing, setEditing] = useState(false);
  const editTracks = useEditPlaylistTracks();
  const select = useNowPlaying((s) => s.select);
  /** 第十七轮第 ②③ 条：「歌曲列表」长什么样由全局风格开关决定。 */
  const uiStyle = useUi((s) => s.uiStyle);
  /** 主人第 10 轮第 5 条：退出键要回「上一级歌单选择页」，来源在 store 里记着。 */
  const navigate = useUi((s) => s.navigate);
  const playlistOrigin = useUi((s) => s.playlistOrigin);
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

  /**
   * 从歌单里删一首（主人本轮第 3 条）。
   *
   * 两步：① 本地先去掉（点下去就有反应，不等网络）；② `libraryPlaylistEditTracks` 的 `op: 'del'`。
   *
   * **删完必须从第 0 页重拉**（和 `onAdded` 同一个理由）：歌单是按 offset 分页累加出来的，
   * 少了一首，后面每一页的 offset 都往前错一格 —— 不重拉就会出现「翻下一页时跳过一首」。
   */
  const removeTrack = useCallback(
    (song: Song) => {
      setTracks((prev) => prev.filter((item) => item.id !== song.id));
      editTracks.mutate(
        { playlistId: playlist.id, trackIds: [song.id], op: 'del' },
        {
          onSettled: () => {
            setTracks([]);
            setOffset(0);
          },
        },
      );
    },
    [editTracks, playlist.id],
  );

  return (
    <section
      className="pi-detail"
      aria-label={`歌单 ${playlist.name}`}
      data-playlist-editing={editing ? 'true' : 'false'}
    >
      {/* 第九轮第 3 条：歌单浮层里的「返回」键删掉了——点玻璃空白处（或按 Esc）就收回播放页。
          主人第 9 轮第 3 条：「右上角红色框选的按键应该删去」——原来常驻的「添加歌曲」与
          上一轮我加的「完成」都撤了，右上角回到只有「歌单」两个字。
          进/出编辑态只剩一条路：点左边那张歌单封面（主人第 8 轮就是这么圈的）。
          加歌这条路没有断：空歌单那张「点这里搜一首歌加进来」还在（见下面的空态按钮）。 */}
      {/* 主人第 10 轮第 5 条：左上角那枚**退出键**（图3 红圈位置）。
          平时藏起来（`opacity: 0` + 缩到 0.9），鼠标靠近这一块才浮现；材质是液态玻璃
          （透底 + 背景模糊 + 上缘高光 + 发丝边）。点它回**上一级歌单选择页** ——
          也就是打开这个浮层时人站着的那一页（`playlistOrigin`），不是一律回播放页。
          Esc 与点玻璃空白处照旧是本浮层的另外两条退出路（第九轮第 3 条留的）。 */}
      <div className="pi-detail__exit-zone">
        <button
          type="button"
          className="pi-detail__exit"
          data-playlist-exit="true"
          aria-label="回到歌单选择页"
          title="回到歌单选择页"
          onClick={() => {
            onClose();
            navigate(playlistOrigin ?? 'home');
          }}
        >
          <Icon name="chevronLeft" size={16} />
        </button>
      </div>

      <header className="pi-detail__bar">
        <strong>歌单</strong>
        <span className="pi-detail__spacer" />
      </header>

      <div className="pi-detail__body">
        <div className="pi-detail__hero">
          {/*
           * 主人第 8 轮第 3 条：点封面 = 进/出编辑态（图3 红圈圈的就是它）。
           *
           * 主人第 9 轮第 4 条把范围收紧了：「**只有我的歌单和播放列表**可以编辑歌单歌曲，
           * 其他的都不允许」。所以**不能编辑的歌单连这个键都不给**：这里渲染成一张普通的
           * 封面（`<span>`），没有 `data-playlist-edit`、没有「编辑」小牌子、点了也没反应 ——
           * 否则点下去只会把 `data-playlist-editing` 翻成 `true` 而一个删除键都不出现，
           * 用户会以为「点了没坏但也没用」。
           */}
          {canEdit ? (
            <button
              type="button"
              className="pi-detail__cover-btn"
              data-playlist-edit="true"
              aria-pressed={editing}
              aria-label={editing ? '退出编辑' : '编辑歌单'}
              title={editing ? '退出编辑' : '编辑歌单：点一下，每首歌左边会出现删除键'}
              onClick={() => setEditing((value) => !value)}
            >
              <PlaylistCover cover={cover} />
              <span className="pi-detail__cover-hint" aria-hidden="true">
                {editing ? '编辑中' : '编辑'}
              </span>
            </button>
          ) : (
            <span className="pi-detail__cover-btn" data-playlist-cover="readonly">
              <PlaylistCover cover={cover} />
            </span>
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
                {...(canEdit ? { onRemove: removeTrack } : {})}
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
          <SongList
            songs={tracks}
            onSelect={select}
            emptyText="这个歌单还没有歌。"
            editing={editing}
            {...(canEdit ? { onRemove: removeTrack } : {})}
          />
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
