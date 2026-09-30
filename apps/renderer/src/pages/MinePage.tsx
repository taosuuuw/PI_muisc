import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Playlist, Song } from '@pi/shared';
import { AsyncSection } from '../components/AsyncSection';
// M5「下载与本地库」的渲染层入口：主进程侧的下载队列与本地库清单都已冻结
//（六个 download channel 的出参都是整份 `DownloadTask[]`，`library:list` 出参是
// `{ dir, tracks }`）。这一页只负责画列表与派发动作。
import { DownloadList, LocalLibrarySection } from '../components/DownloadList';
// `LikedWall`（环形/墙面展示）本轮在「我的喜欢」页签被 `SongCollage` 取代，
// 这里不再引用它——但组件文件保留，别的页面/下一轮可能还要用。
import { NeedsLogin } from '../components/NeedsLogin';
import { NewPlaylistCard } from '../components/NewPlaylistCard';
import { PlaylistGrid } from '../components/PlaylistGrid';
// 第十七轮第 ② 条：平凡风格的歌曲列表换成竖排列表（`SongCards` 那套封面卡片在新方案里
// 既不属于平凡也不属于先锋，本轮起歌单/队列这些列表都不再用它；它只留给搜索浮层与加歌面板）。
import { SongList } from '../components/SongList';
// 第十三轮第 7 条（用户 m04663）：队列拼贴展示，第一阶段只用在「我的喜欢」页签。
// 第十六轮第 4 条又给它加了四件事：点「在播 + 已放大」的格子进播放页（放大填屏动画）、
// 翻页加载（一直拖到没有歌可加载）、常驻底栏 + 点底栏定位到在播那一格、
// 滚轮向下开搜索并按关键字定位（第 6 条后半段）。
import { SongCollage, type SongCollageHandle } from '../components/SongCollage';
// 第十八轮第 7 条：搜索条抽成公共组件（我在喜欢页 / 歌单详情拼贴共用），
// 位置、进/退场动画、自动隐藏都归它和宿主的 `openSearch` / `closeSearch` 管。
import { CollageSearchBar, COLLAGE_SEARCH_EXIT_MS } from '../components/CollageSearchBar';
import { COLLAGE_FILL_MS } from '../components/song-collage-geometry';
// 第十七轮第 ④ 条：`specialType=5` 的「我喜欢的音乐」以前是从歌单列表里被**过滤掉**的，
// 现在改成置首（判断口径收在 `lib/playlists.ts` 里，先锋风格的轮播也用同一份）。
import { isLikedPlaylist, withLikedFirst } from '../lib/playlists';
import { useLikedTracksPaged, useMyPlaylists, useRecentTracks, useAccount } from '../lib/queries';
// 用户 m03805 第 1 条：平凡列表的「加载更多」按钮换成下滑自动加载。
import { useAutoLoadMore } from '../lib/useAutoLoadMore';
import { useNowPlaying } from '../state/nowPlaying';
import { useUi, type UiStyle } from '../state/ui';
// 第十八轮第 5/8/10 条（用户 m01482）：底栏从这一页的 `HomeBar persistent` 换成公共的
// `BottomBar` —— 不带常驻档（常态只留进度条）、点它回歌曲播放页、平凡风格下也照挂。
import { BottomBar } from '../components/BottomBar';

export interface MinePageProps {
  tab: 'recent' | 'like' | 'download' | 'playlists';
}

const TITLES: Record<MinePageProps['tab'], { title: string; sub: string }> = {
  recent: { title: '最近听过', sub: '来自网易云的最近一周播放记录（/user/record）' },
  like: { title: '我的喜欢', sub: '我喜欢的音乐（/likelist + /song/detail）· 拖拽看拼贴，滚轮向下搜歌' },
  download: { title: '我的下载', sub: '下载队列与本地库 · 下完的能离线听' },
  playlists: { title: '我的歌单', sub: '我创建与收藏的歌单（/user/playlist）' },
};

/**
 * 用户 m02213 第 4 条（「先锋风格下我的喜欢的队列拼贴也要像其他歌单的一样先加载好」）
 * 的闸门用到的三个数：
 *
 * - `LIKED_PRELOAD_PAGE_SIZE`：`/likelist` 一页多少首 —— 必须和 `useLikedTracksPaged`
 *   收到的 `limit` 是同一个数（`lib/queries.ts:62` 的默认值就是 100），否则「到顶」那条
 *   判据会算错。所以下面调 hook 时显式传它，而不是靠默认值。
 * - `LIKED_PRELOAD_MAX_PAGES`：最多先拉几页（20 页 = 2000 首）。和歌单详情那一份
 *   （`components/PlaylistDetail.tsx:22` 的 `PAGE_SIZE = 100` × `:28` 的
 *   `PRELOAD_MAX_PAGES = 20`）同一个口子 —— 歌单拉得完，我的喜欢不封顶就可能拉到天荒地老。
 * - `LIKED_PRELOAD_BUDGET_MS`：闸门最多等这么久，到点就带着**已经拿到的**几页上墙。
 *   我的喜欢动辄几千首，纯按页数封顶会让人对着骨架等太久；而且桌面冒烟的
 *   `r16EnterLiked`（`apps/desktop/src/main/index.ts:8476-8484`）只等 8s 就要看到
 *   `[data-song-collage]`，慢网/限流下不设时限会把那几条探针判成「墙不在」。
 */
const LIKED_PRELOAD_PAGE_SIZE = 100;
const LIKED_PRELOAD_MAX_PAGES = 20;
const LIKED_PRELOAD_BUDGET_MS = 3000;

/**
 * `focusSong` 是第十六轮第 4 条(d)/第 6 条新加的命令式方法（按关键字把某一格居中）。
 * 拼贴组件那边正在同一轮里加它，这里按「可能还没到」的可选方法调用，
 * 免得两边合入顺序不同就把渲染层编译卡红。
 */
type CollageSearchHandle = SongCollageHandle & {
  focusSong?: (keyword: string) => { id: number; index: number } | null;
};

export function MinePage({ tab }: MinePageProps): ReactNode {
  const account = useAccount();
  const loggedIn = account.data?.loggedIn === true;
  const select = useNowPlaying((s) => s.select);
  /**
   * 第八轮第 6 条：点歌单**不再在这一页里展开详情**（那会变成「单独的歌单页」），
   * 而是让播放页上的磨砂卡片列表浮层接管——`openPlaylist` 会顺手把 `nav` 拨回 `home`
   * （理由见 `state/ui.ts` 里 `openedPlaylist` 的注释）。
   */
  const openPlaylist = useUi((s) => s.openPlaylist);
  const navigate = useUi((s) => s.navigate);
  /** 第十七轮第 ②③ 条：这一页的歌曲列表按风格二选一（平凡竖排列表 / 先锋队列拼贴）。 */
  const uiStyle = useUi((s) => s.uiStyle);

  // enabled 而不是条件调用：Hook 的调用顺序必须稳定，所以用开关控制是否真的发请求。
  const recent = useRecentTracks(loggedIn && tab === 'recent');
  /**
   * 第十六轮第 4 条(c)：拼贴墙要能「一直拖到没有歌可以加载」，所以走**翻页**接口
   * （`useLikedTracksPaged`，offset 推进），而不是一次要 100 首。
   */
  const liked = useLikedTracksPaged(loggedIn && tab === 'like', LIKED_PRELOAD_PAGE_SIZE);
  const playlists = useMyPlaylists(loggedIn && tab === 'playlists');

  const collageRef = useRef<CollageSearchHandle | null>(null);
  const [entering, setEntering] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** 第十八轮第 7 条：正在播退场动画（升回顶部），这个窗口里还不能卸载搜索条。 */
  const [searchClosing, setSearchClosing] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchNote, setSearchNote] = useState('');
  /** 第十六轮第 4 条(c)：记下组件一共问过几次「再要一页」，探针靠它区分「没问」和「问了没数据」。 */
  const [needMoreCount, setNeedMoreCount] = useState(0);
  /**
   * 用户 m02213 第 4 条：闸门三件套 —— `preloadDone`（放行过就不再收回）、
   * `likedPreloadBudgetOut`（时限兜底到点）与下面那个 `likedPump`（一次只问一页的锁）。
   */
  const [preloadDone, setPreloadDone] = useState(false);
  const [likedPreloadBudgetOut, setLikedPreloadBudgetOut] = useState(false);
  const likedPump = useRef(false);
  const enterTimer = useRef<number | null>(null);
  /** 第十八轮第 7 条：搜索条退场动画的定时器 + 「现在到底开没开」的同步镜像。 */
  const searchTimer = useRef<number | null>(null);
  const searchOpenRef = useRef(false);

  const meta = TITLES[tab];

  /** 翻页拿到的所有喜歌（按页面顺序拼接；offset 由 hook 内部推进，这里不重排）。 */
  const likedSongs = useMemo(
    () => (liked.data?.pages ?? []).flatMap((page) => page.tracks),
    [liked.data],
  );
  const likedTotal = liked.data?.pages[0]?.total;
  const likedHasMore = liked.hasNextPage === true;

  /**
   * 用户 m03805 第 1 条（原来的「加载更多」按钮改成下滑自动加载）：
   * 平凡列表末尾那颗哨兵滚进预载区就要下一页 —— 分页管道不变，还是 `liked.fetchNextPage()`。
   * 先锋模式不挂这颗哨兵（拼贴有自己的 `autoMore` / `needMore` 续页），所以 `canLoad` 里带上风格；
   * 翻页在飞就看 `liked.isFetchingNextPage`（`isFetching` 在 `useInfiniteQuery` 上首次加载也为真）。
   */
  const likedAutoMoreRef = useAutoLoadMore({
    canLoad: uiStyle !== 'avant' && likedHasMore,
    loading: liked.isFetchingNextPage,
    onLoad: () => void liked.fetchNextPage(),
  });

  /*
   * 用户 m02213 第 4 条：「先锋风格下我的喜欢的歌曲队列拼贴也像其他歌单的一样先加载好
   * 再进行队列拼贴」—— 歌单详情那份闸门在 `components/PlaylistDetail.tsx:117-156`
   *（`preloadDone` / `collageReady` = 非先锋档 || 拉完了 || 出错；ready 之前只渲染
   * `data-collage-loading="true"` 的骨架；拉的时候一次只问下一页）。这里把同一套口径
   * 安在「我的喜欢」上，只有两处不同：
   *   ① 数据源是 `useLikedTracksPaged`（`useInfiniteQuery`，offset 由 hook 按**已拿到的
   *      曲目数**推进，见 `lib/queries.ts:62-84`），所以「拉完了」只能读 `hasNextPage !== true`，
   *      没有歌单那套 `hasMore` 单值；
   *   ② 多一条时限兜底（见 `LIKED_PRELOAD_BUDGET_MS` 的注释）。
   * 目的就是用户说的那件事：`total` 只算一次、几何只算一次，一格都不会一边加载一边换。
   */
  const likedPreloadExhausted = liked.data !== undefined && liked.hasNextPage !== true;
  const likedPreloadCapped = likedSongs.length >= LIKED_PRELOAD_MAX_PAGES * LIKED_PRELOAD_PAGE_SIZE;
  /** 与歌单那份 `collageReady` 一个口径：非先锋档 / 拉完 / 出错 / 到顶 / 超时，都直接上墙。 */
  const likedCollageReady =
    uiStyle !== 'avant' ||
    likedPreloadExhausted ||
    liked.isError ||
    likedPreloadCapped ||
    likedPreloadBudgetOut;

  /**
   * ready 一经成立就**只能一直成立**：`liked.isError` 会在随后某一页拉成功之后翻回 false，
   * 要是渲染直接读 `likedCollageReady`，那一瞬间墙就会被换回骨架 —— 镜头、缩放、在播格
   * 全丢，而且预拉已经停手，可能再也回不来。
   *
   * 所以这里把它锁进 `preloadDone`（只置真），并且用 React 的「渲染期直接改本组件 state」
   * 写法（带条件、不会死循环）：它在同一次提交里立刻重渲染，不会先画一帧骨架；
   * 换成 `useEffect` + `setState` 会晚一帧，命中「已经缓存好时进这一页」就会闪一下。
   */
  if (uiStyle === 'avant' && !preloadDone && likedCollageReady) setPreloadDone(true);

  /** 时限兜底：只在「先锋档 + 这一页 + 还没放行」时计时，放行（或离开这一页）就把表清掉。 */
  useEffect(() => {
    if (tab !== 'like' || uiStyle !== 'avant' || preloadDone) return;
    const timer = window.setTimeout(() => setLikedPreloadBudgetOut(true), LIKED_PRELOAD_BUDGET_MS);
    return () => window.clearTimeout(timer);
  }, [tab, uiStyle, preloadDone]);

  /**
   * 顺序预拉：一次只问一页（同 `PlaylistDetail.tsx:146-152` 的 `setOffset(n => n + PAGE_SIZE)`）。
   * `likedPump` 这把锁是为了防「同一拍里重入」——`fetchNextPage` 的 `isFetchingNextPage`
   * 要等下一次渲染才看得到，光靠它挡不住。
   * 闸门一放行（`preloadDone`）就停手：之后要不要再来一页由墙自己的 `autoMore` / `onNeedMore`
   * 决定，免得这里和墙抢着翻页（那也是「一边加载一边换格子」的来源）。
   */
  useEffect(() => {
    if (tab !== 'like' || uiStyle !== 'avant') return;
    if (preloadDone || likedCollageReady) return;
    if (!liked.isSuccess || liked.isError) return;
    if (likedPump.current) return;
    likedPump.current = true;
    void liked.fetchNextPage().then(
      () => {
        likedPump.current = false;
      },
      () => {
        likedPump.current = false;
      },
    );
  }, [tab, uiStyle, preloadDone, likedCollageReady, liked]);

  // 换页签/离开这一页时把「放大填屏」的定时器收掉，免得在已卸载的组件上 setState。
  useEffect(
    () => () => {
      if (enterTimer.current !== null) window.clearTimeout(enterTimer.current);
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    },
    [],
  );

  /**
   * 第十六轮第 4 条(b)：点「正在播放且已放大」的那一格 → 进歌曲播放页。
   *
   * 「逐渐放大填充屏幕」的视觉由拼贴组件自己做（点中的那一格自己写退场 transform，
   * 见 `SongCollage` 头部契约与 `collageCellExitTransform`）；这里只负责在动画
   * `COLLAGE_FILL_MS` 之后切页——切早了动画会被卸载打断。
   *
   * 刻意**不**再 `select()`：那一格本来就是「正在播放」的那首，重选会把它从头再播一遍。
   */
  const enterPlaying = useCallback(() => {
    setEntering(true);
    if (enterTimer.current !== null) window.clearTimeout(enterTimer.current);
    enterTimer.current = window.setTimeout(() => {
      enterTimer.current = null;
      setEntering(false);
      navigate('home');
    }, COLLAGE_FILL_MS);
  }, [navigate]);

  /** 第十六轮第 4 条(c)：镜头贴到边上时再来一页。 */
  const needMore = useCallback(() => {
    setNeedMoreCount((count) => count + 1);
    if (liked.hasNextPage === true && !liked.isFetchingNextPage) void liked.fetchNextPage();
  }, [liked]);

  /**
   * 第十六轮第 4 条(d) 的点底栏定位（`focusPlaying`）在第十八轮第 8 条里让位了：
   * 用户要求「在歌单页点击进度条部件可以回到歌曲播放页」，那条逻辑收进 `BottomBar`。
   */

  /**
   * 第十八轮第 7 条：搜索条的开关都带动画——开 = 从顶部往下冒出，关 = 升回顶部。
   * 所以「关」不是直接卸载：先置 `closing` 播退场，`COLLAGE_SEARCH_EXIT_MS` 之后再卸载。
   */
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
    // 没开、或已经在退场，就不重复发车（否则定时器会被后面的调用顶掉）。
    if (!searchOpenRef.current || searchTimer.current !== null) return;
    searchOpenRef.current = false;
    setSearchClosing(true);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      setSearchClosing(false);
      setSearchOpen(false);
    }, COLLAGE_SEARCH_EXIT_MS);
  }, []);

  /** 第十六轮第 6 条后半段：拼贴页滚轮向下 → 开搜索。 */
  const onCollageWheel = useCallback(
    (event: { deltaY: number }) => {
      if (event.deltaY <= 0) return;
      openSearch();
    },
    [openSearch],
  );

  /**
   * 输入关键字 → 让拼贴把命中的那一格居中放大。
   * 只搜**已经加载到墙上**的歌；没命中时照实说明是「还没加载」还是「确实没有」。
   */
  const locate = useCallback(
    (keyword: string) => {
      setSearchInput(keyword);
      const trimmed = keyword.trim();
      if (trimmed === '') {
        setSearchNote('');
        return;
      }
      const hit = collageRef.current?.focusSong?.(trimmed) ?? null;
      if (hit !== null) {
        setSearchNote(`已定位到第 ${hit.index + 1} 首拼贴`);
        return;
      }
      setSearchNote(
        liked.hasNextPage === true
          ? '墙上的歌里没有匹配的：往边上拖，加载更多再搜'
          : '墙上的歌里没有匹配的',
      );
    },
    [liked.hasNextPage],
  );

  /**
   * 用户第十七轮第 ④ 条：「我喜欢的音乐」以前被这段过滤掉了（specialType=5 不算「我的歌单」），
   * 现在要**进列表并且置首** —— 挑出与置首的口径收在 `lib/playlists.ts`（先锋风格的轮播用同一份）。
   */
  const minePlaylists = useMemo(
    () => withLikedFirst(playlists.data?.playlists ?? []),
    [playlists.data],
  );

  /**
   * 第 ④ 条的后半截：点「我喜欢的音乐」这一项时不能走 `openPlaylist`。
   * 歌单详情拉曲目走 `/playlist/track/all`，而喜欢歌单的曲目只有 `/likelist` 这条路
   *（见 `packages/ncm-client`），硬拉会拿到空列表或一次报错；
   * 所以这一项改成跳「我的喜欢」页——那里本来就是 `/likelist` + 拼贴/列表。
   */
  const openMinePlaylist = useCallback(
    (playlist: Playlist) => {
      if (isLikedPlaylist(playlist)) {
        navigate('mine:like');
        return;
      }
      openPlaylist(playlist);
    },
    [navigate, openPlaylist],
  );

  return (
    <>
      <h1 className="pi-page-title">{meta.title}</h1>
      <p className="pi-page-sub">{meta.sub}</p>

      {account.isPending ? (
        <div className="pi-placeholder">正在读取账号信息…</div>
      ) : loggedIn ? (
        <>
          {tab === 'recent' ? (
            <AsyncSection isPending={recent.isPending} error={recent.error}>
              <RecentList rows={recent.data?.tracks ?? []} onSelect={select} uiStyle={uiStyle} />
            </AsyncSection>
          ) : null}

          {tab === 'like' ? (
            /*
             * 已经上墙的歌不该因为「再要一页」被上游限流（`/likelist` 405）就整页清空：
             * `useInfiniteQuery` 在翻页失败时**仍然保留** `data.pages`，而 `AsyncSection`
             * 只要有 `error` 就整段换成「加载失败」——于是满屏的歌连同拼贴墙一起消失。
             * 所以只有在「一首都没拿到」（首次加载就失败）时才把错误交给它，其余情况
             * 把话写在下面那行小字里，歌照旧留着。
             */
            <AsyncSection isPending={liked.isPending} error={likedSongs.length > 0 ? null : liked.error}>
              {uiStyle === 'avant' ? (
                /* 第十三轮第 7 条（用户 m04663）：歌单/列表改成队列拼贴。
                   `display: contents` 的外壳只用来挂滚轮监听，不产生盒子、不改布局。 */
                <div
                  className="pi-collage-shell"
                  data-collage-shell="true"
                  data-collage-entering={entering ? 'true' : 'false'}
                  data-collage-loaded={likedSongs.length}
                  data-collage-need-more={needMoreCount}
                  data-collage-page-has-more={likedHasMore ? 'true' : 'false'}
                  style={{ display: 'contents' }}
                  onWheel={onCollageWheel}
                  /* 第十八轮第 7 条：拖动拼贴 / 点格子播放时，搜索条自动升回顶部收起来。
                     `display: contents` 只影响盒子，事件照样从格子上冒到这层。 */
                  onPointerDown={closeSearch}
                >
                  {/* 用户 m02213 第 4 条：闸门放行前只挂骨架（与歌单详情同款，
                      连标记都叫 `data-collage-loading`），放行后才是那面会自己长大的墙。
                      判据用只置真的 `preloadDone`（`likedCollageReady` 会来回翻，见上面的注释）。 */}
                  {preloadDone ? (
                    <SongCollage
                      ref={collageRef}
                      songs={likedSongs}
                      onSelect={select}
                      onEnterPlaying={enterPlaying}
                      hasMore={likedHasMore}
                      onNeedMore={needMore}
                      /* 第十八轮第 6 条：这面墙自己在后台一批批长大，不用等用户拖到边上。 */
                      autoMore
                    />
                  ) : (
                    <div className="pi-collage-skeleton" data-collage-loading="true">
                      <span className="pi-collage-skeleton__text">
                        {likedSongs.length > 0
                          ? `正在铺开拼贴…已加载 ${likedSongs.length} 首`
                          : '正在加载歌曲…'}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                /* 第十七轮第 ② 条：平凡风格下「我的喜欢」是一张竖排列表（image 3）。
                   底栏这一页照旧常驻（见下面那段 `pi-collage-bar`），所以给列表垫出它的
                   高度，免得最后几行被药丸压住。 */
                <div style={{ paddingBottom: 104 }}>
                  <SongList
                    songs={likedSongs}
                    onSelect={select}
                    emptyText="我喜欢的音乐还是空的。"
                  />
                </div>
              )}

              {/* 拼贴专属的搜索条：平凡列表不需要它（列表本来就能直接滚）。
                  第十八轮第 7 条：退场动画期间（`searchClosing`）还要挂着，动画放完才卸载。 */}
              {uiStyle === 'avant' && (searchOpen || searchClosing) ? (
                <CollageSearchBar
                  value={searchInput}
                  note={searchNote}
                  closing={searchClosing}
                  onChange={locate}
                  onClose={closeSearch}
                />
              ) : null}

              {likedTotal !== undefined ? (
                <p className="pi-page-sub" style={{ marginTop: 12 }}>
                  {uiStyle === 'avant'
                    ? `共 ${likedTotal} 首，已上墙 ${likedSongs.length} 首${
                        likedHasMore ? '（还有更多，正在陆续上墙）' : ''
                      }`
                    : `共 ${likedTotal} 首，已加载 ${likedSongs.length} 首`}
                  {liked.error ? '（有一页没拉到：接口繁忙，稍后会自动再试）' : ''}
                </p>
              ) : null}

              {/* 用户 m03805 第 1 条（原来的「加载更多」按钮改成下滑自动加载）：按钮删掉，
                  只留这颗被动哨兵 —— 滚进预载区就自动要下一页（`likedAutoMoreRef`）。
                  `data-liked-loadmore` 从按钮挪到哨兵上：冒烟探针还按这个标记找这一块。 */}
              {uiStyle !== 'avant' && likedHasMore ? (
                <div
                  className="pi-loadmore"
                  data-liked-loadmore="true"
                  data-auto-loadmore="true"
                  ref={likedAutoMoreRef}
                >
                  {liked.isFetchingNextPage ? <span className="pi-page-sub">加载中…</span> : null}
                </div>
              ) : null}
            </AsyncSection>
          ) : null}

          {/* 第十八轮第 5/8/10 条：歌单页底栏 —— 与播放页同一条药丸（常态只留进度条，
              悬停才展开），点它回歌曲播放页；平凡风格下也照挂，不再有「常驻档」。
              用户 m03805 第 5 条：「我的下载」（本地歌曲，`tab === 'download'`）这一页
              也要有同一条底栏，点它一样回歌曲播放页（下载队列里点一首就能立刻试）。
              `BottomBar` 自己在没有在播歌曲时返回 null。 */}
          {tab === 'like' || tab === 'download' ? <BottomBar /> : null}

          {tab === 'playlists' ? (
            <AsyncSection isPending={playlists.isPending} error={playlists.error}>
              {minePlaylists.length === 0 ? (
                /* 一个歌单都没有：正中一张空白卡片，点一下就能命名并建出来
                   （用户 m06982 第 1 条）。这里不做「本地先塞一张假卡片」的乐观
                   更新 —— 歌单 id 只有云端知道，拿到真 id 再打开它才点得进去。 */
                <NewPlaylistCard
                  onCreated={(playlistId, name) => {
                    openPlaylist({ id: playlistId, name, trackCount: 0 });
                  }}
                />
              ) : (
                <PlaylistGrid playlists={minePlaylists} onOpen={openMinePlaylist} />
              )}
            </AsyncSection>
          ) : null}

          {tab === 'download' ? (
            /* 同一页两块：上面是下载队列（可暂停/重试/播放），下面是本地库只读清单。
               两块各有自己的根节点与 `data-*` 抓手，互不依赖。 */
            <>
              <DownloadList />
              <LocalLibrarySection />
            </>
          ) : null}
        </>
      ) : (
        <NeedsLogin what={meta.title} />
      )}
    </>
  );
}

/**
 * 最近听过带播放次数与时间，所以不能直接复用列表组件的数据形状。
 *
 * 第十七轮第 ②③ 条：这里也要跟风格走 —— 平凡是竖排列表（带「播放 N 次 · 时间」的副信息），
 * 先锋是队列拼贴（拼贴格子上没有位置印这行副信息，所以只在平凡里显示；点格子仍是选中+播放）。
 */
function RecentList({
  rows,
  onSelect,
  uiStyle,
}: {
  rows: readonly { song: Song; playCount: number; lastPlayedAt: number }[];
  onSelect: (song: Song) => void;
  uiStyle: UiStyle;
}): ReactNode {
  const byId = new Map(rows.map((row) => [row.song.id, row]));
  const songs = rows.map((row) => row.song);
  if (uiStyle === 'avant') {
    return <SongCollage songs={songs} onSelect={onSelect} />;
  }
  return (
    <SongList
      songs={songs}
      onSelect={onSelect}
      emptyText="最近一周还没有播放记录。"
      metaOf={(song) => {
        const row = byId.get(song.id);
        if (!row) return undefined;
        const when = formatWhen(row.lastPlayedAt);
        return `播放 ${row.playCount} 次${when ? ` · ${when}` : ''}`;
      }}
    />
  );
}

function formatWhen(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const diff = Date.now() - ms;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} 分钟前`;
  if (diff < day) return `${Math.round(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.round(diff / day)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}
