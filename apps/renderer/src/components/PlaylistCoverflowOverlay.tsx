/**
 * 先锋风格下「歌单列表」那一整套（用户第十七轮第 ③⑤ 条 + 第十八轮第 ③ 条）。
 *
 * 第十八轮第 ③ 条（用户 m01482）：「歌单先锋风格下的封面卡片展示全部复刻搜索功能下的
 * 歌曲卡片展示（直接套用它的代码），把现在歌单用的卡片展示删了」。
 * 所以这里不再自己画卡片流 —— 原来那份（`PlaylistCoverflow.tsx` + `playlist-coverflow.css`）
 * 已经删掉，现在真正渲染的是**搜索页 / 搜索浮层同一个** `SongCards`，只是喂给它
 * `SongCardModel[]`（卡片模式）：手势、几何、键盘、拖动跟手与 `data-*` 观测钩子在两处完全同源。
 * 卡片 class 因此也是 `.pi-songcard`，中心卡是 `.pi-songcard[data-focused="true"]`。
 *
 * 为什么仍由 App 挂一层全屏浮层、而不是在 `MinePage` / `PlaylistPage` 里改：
 * 用户要的就是 image 4 那个「浮在播放页上的封面卡片轮播」—— 点模糊空白处要**回到播放页**。
 * 做成页面内容的话，模糊的底就是歌单网格自己；做成浮层（和 `openPlaylist` 的浮层同一个套路），
 * 底下才是正在播放的那一页，退出动作也天然是 `navigate('home')`。
 *
 * 数据按 `nav` 分三档取，和 `PlaylistPage` / `MinePage` 各档的口径一致；
 * 「我喜欢的音乐」置首（第十七轮第 ④ 条）与「点它去我的喜欢页」也在这里收口。
 *
 * 用户 m00736 第 7 条（这一层自己的两条）：
 * ① 左右大幅度滑动时阻尼衰减、一下能翻好几张 —— 交给 `SongCards` 的 `dragFeel="free"`
 *    （不传就是搜索那套 1:1 手感，四个宿主里只有这里打开它）；
 * ② 退出这一层要有收场动画 —— 这一层是 `App` 按 `nav` 挂/卸的，没有「先播完再卸载」的余地，
 *    于是由下面的 `leave()` 把**真正的跳转**推迟 `EXIT_MS`；CSS 那边看 `data-leaving`
 *    播「整层淡出 + 卡片流朝中心回缩」，收场期间指针不穿透、键盘被吞掉。
 *
 * 用户 m01402 第 1 条：「歌单卡片页底部多出了一条白边，回播放页时还要等白边消失」。
 * 根因**不在这一层**，而是底下那页没铺满整窗（`.pi-main` 的 `padding` 让 `.pi-home`
 * 只占 `100vh − 152px`，底部 132px 露的是 `.pi-app::before` 的 `#f5faff`）——
 * 证据、修法与「退场为什么不再有白帧」都写在 `playlist-cards.css` 第 3 节开头的注释里。
 * 这里只把收场的两处重入兜底补齐（`alive` 的挂载复位 + 定时器里先解掉吞键盘）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Playlist } from '@pi/shared';
import { errorMessage } from '../bridge';
import { isLikedPlaylist, withLikedFirst } from '../lib/playlists';
import { useAccount, useMyPlaylists, usePersonalizedPlaylists, useRecommend } from '../lib/queries';
import { useUi } from '../state/ui';
import { Icon, type IconName } from './Icons';
import { SongCards, type SongCardModel } from './SongCards';

/** 收场动画时长（用户 m00736 第 7 条 b）。要 ≥ `playlist-cards.css` 里 `pi-pllist-out` /
 *  `pi-pllist-fold` 那 240ms，多留 20ms 等最后一帧落定，然后才真正跳转（React 才卸载这一层）。 */
const EXIT_MS = 260;

/** 收场动画进行中（模块级）。放模块作用域，是为了让下面那个「收场期间吞掉键盘」的监听能在
 *  **模块求值时**就挂上 window —— 必须早于 `ShortcutLayer.tsx` 里 `useEffect` 挂的那个
 *  **捕获阶段**的 Esc（`ShortcutLayer.tsx:267`），否则收场这 260ms 里按空格仍会把播放暂停。 */
let exiting = false;

/*
 * 收场这 260ms 把键盘整个吃掉（用户 m00736 第 7 条 b 的「关闭过程中键盘事件不要穿透」）：
 * 既不让 ←→ 再去翻后面的卡片（`SongCards` 的键盘监听在冒泡阶段），也不让空格 / 跳页落到
 * `ShortcutLayer`（捕获阶段、注册得更早，所以这里只能提前到模块求值注册）。`exiting` 为假时
 * 这个监听什么都不做，其他页面的键盘行为一点没变。
 */
window.addEventListener(
  'keydown',
  (event) => {
    if (!exiting) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);

export type PlaylistNav = 'mine:playlists' | 'playlist:star' | 'playlist:recommend';

const HEADS: Record<PlaylistNav, { label: string; icon: IconName }> = {
  'mine:playlists': { label: '我的歌单', icon: 'list' },
  'playlist:star': { label: '收藏', icon: 'star' },
  'playlist:recommend': { label: '推荐歌单', icon: 'compass' },
};

export function PlaylistCoverflowOverlay({ nav }: { nav: PlaylistNav }): ReactNode {
  const account = useAccount();
  const loggedIn = account.data?.loggedIn === true;
  const navigate = useUi((s) => s.navigate);
  const openPlaylist = useUi((s) => s.openPlaylist);

  const mine = useMyPlaylists(loggedIn && nav === 'mine:playlists');
  const starred = useMyPlaylists(loggedIn && nav === 'playlist:star');
  const personalized = usePersonalizedPlaylists(nav === 'playlist:recommend', 30);
  const source = nav === 'playlist:recommend' ? personalized : nav === 'playlist:star' ? starred : mine;

  const playlists = useMemo((): Playlist[] => {
    if (nav === 'playlist:recommend') return personalized.data?.playlists ?? [];
    if (nav === 'playlist:star') {
      return (starred.data?.playlists ?? []).filter((item) => item.subscribed === true);
    }
    return withLikedFirst(mine.data?.playlists ?? []);
  }, [mine.data, nav, personalized.data, starred.data]);

  /*
   * 用户 m02898 第 3 条「推荐歌单把每日推荐放在首位」：先锋风格下这一页**不是**
   * `PlaylistPage`（`App.tsx:111-128` 把 `playlist:recommend` 换成了本浮层 + 播放页底子），
   * 所以那张卡也得在这里补上，位置同为整个卡片流的**第一张**。
   * 点它走 `PlaylistPage.tsx:69` 同一条路：`openSongs({kind:'daily'})` 把歌曲浮层切到
   * 每日推荐那一档（不换页、不吃登录），收场动画照走 —— 和「我喜欢的音乐」那张卡
   * 一样先 `leave()`，退出后仍是回到播放页。
   * `key` 用小负号当哨兵（`SongCardModel.key` 是 `number`，歌单 id 都是正数）。
   */
  const RECOMMEND_DAILY_KEY = -1;
  const isRecommend = nav === 'playlist:recommend';
  const openSongs = useUi((s) => s.openSongs);
  const daily = useRecommend(isRecommend);
  const dailyCount = daily.data?.tracks.length;

  /*
   * 每张卡片的显示数据（`SongCards` 的卡片模式）。`data-pl-cover-card` 是给自动化认卡的抓手，
   * 沿用原 `PlaylistCoverflow` 的那一个名字；`key` 同时会下发成 `data-song-card`。
   */
  const cards = useMemo((): SongCardModel[] => {
    const list = playlists.map((playlist) => ({
      key: playlist.id,
      title: playlist.name,
      meta: `${playlist.trackCount} 首${playlist.creator ? ` · ${playlist.creator}` : ''}`,
      coverUrl: playlist.coverUrl ?? null,
      data: { 'data-pl-cover-card': playlist.id },
    }));
    if (!isRecommend) return list;
    return [
      {
        key: RECOMMEND_DAILY_KEY,
        title: '每日推荐',
        meta: dailyCount === undefined ? '每天零点换一批' : `每天零点换一批 · ${dailyCount} 首`,
        coverUrl: null,
        data: { 'data-daily-card': 'true', 'data-daily-count': dailyCount },
      },
      ...list,
    ];
  }, [dailyCount, isRecommend, playlists]);

  /** 卡片流里的下标 → 真实歌单（推荐面第 0 张是每日推荐那张哨兵卡）。 */
  const playlistAt = useCallback(
    (index: number): Playlist | undefined =>
      playlists[isRecommend ? index - 1 : index],
    [isRecommend, playlists],
  );

  /*
   * 收场动画的状态机（用户 m00736 第 7 条 b）。`leaving` 只驱动 CSS 与「按键通吃」；
   * 真正的跳转在 `EXIT_MS` 之后由 `leave()` 收的 `after` 执行 —— 那一刻 nav 才变，
   * React 才卸载这一层，动画已经放完了。
   */
  const [leaving, setLeaving] = useState(false);
  /** 卸载时翻假：Esc 那条路上要靠它判断「React 到底把卸载提交出去没有」（见下面的 Esc 处理）。 */
  const alive = useRef(true);
  /** 收场只认一次：动画期间再点 / 再按 Esc 不会叠出第二条计时器。 */
  const exitTimer = useRef<number | null>(null);

  const leave = useCallback((after: () => void): void => {
    if (exiting) return;
    exiting = true;
    setLeaving(true);
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null;
      /*
       * 先解掉「吞键盘」再跳转（用户 m01402 第 1 条顺手确认的那条）：`exiting` 是模块级的，
       * 上面那个捕获监听拿它当唯一开关。定时器到点就把这次收场的意图结清，于是即使
       * `after()` 因为极端时序没能让 React 卸载这一层，全局键盘最多也只被吞 EXIT_MS 这么久，
       * 绝不会永久卡死。（正常情况下紧接着的卸载 cleanup 也会把它置假，这里是幂等的兜底。）
       */
      exiting = false;
      after();
    }, EXIT_MS);
  }, []);

  useLayoutEffect(() => {
    /*
     * 挂载时把 `alive` 拨回真：`main.tsx:68` 用 StrictMode 包着 App，开发档会把 effect
     * 跑成「setup → cleanup → setup」，只写 cleanup 那一半的话，开发档里第一次 cleanup
     * 就把 `alive` 永久置假，Esc 那条路再也走不到收场动画（退化成「立即退出」）。
     * 拨回来之后「卸载过没有」这件事才只由真正的卸载决定。
     */
    alive.current = true;
    return () => {
      alive.current = false;
      /*
       * 收场没放完就被外部卸载（换排版、从环形菜单直接跳别的页）：意图与计时器一起清掉，
       * 否则 260ms 后会把用户从新去的地方硬拽回播放页。
       */
      exiting = false;
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
    };
  }, []);

  /*
   * 「我喜欢的音乐」不走 `openPlaylist`：它的曲目只有 `/likelist` 这条路
   * （`/playlist/track/all` 对系统歌单不可靠），而那条路已经被「我的喜欢」页包好了。
   * 第十七轮第 ④ 条要的是「能在我的歌单里看到并点开」，跳到那一页同样满足，还少一次接口风险。
   * 用户 m00736 第 7 条 b：点中心卡同样是退出这一层（两条路都会把 nav 拨走），先播收场动画。
   */
  const open = (playlist: Playlist): void => {
    if (isLikedPlaylist(playlist)) {
      leave(() => navigate('mine:like'));
      return;
    }
    leave(() => openPlaylist(playlist));
  };

  /*
   * Esc 退出（第十七轮第 ⑤ 条）。以前这条挂在 `PlaylistCoverflow` 里，现在由浮层自己管
   * —— `SongCards` 的键盘监听只管 ←→，不碰 Escape。
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      /*
       * `ShortcutLayer.tsx:267` 的 Esc 挂在 window 的**捕获阶段**，比这里（冒泡）早一步，
       * 它多半已经 `ui.navigate('home')` 了 —— 但那一刻 React 还没提交，这一层仍在树上。
       * 于是把 nav 收回来（`nav` 就是这一页），让收场动画留在树上放完，计时器到点再真正回
       * 播放页。`alive` 是保险：万一 React 真把中间那一帧提交掉了（极端时序），这里就什么都
       * 不做 —— 退化成改动前的「立即退出」，绝不会把这一层留在屏幕上。
       */
      if (!alive.current) return;
      if (useUi.getState().nav !== nav) useUi.getState().navigate(nav);
      leave(() => navigate('home'));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [leave, nav, navigate]);

  const head = HEADS[nav];

  return (
    <div
      className="pi-pllist"
      data-pl-list="true"
      data-pl-list-nav={nav}
      data-pl-list-count={playlists.length}
      /* 用户 m00736 第 7 条 b：收场这一小段挂着它，CSS 播淡出 + 收拢，同时把卡片流关掉。 */
      data-leaving={leaving ? 'true' : 'false'}
      onClick={(event) => {
        // 只有点到这层模糊底本身（卡片流盒子之外）才退回播放页；卡片冒泡上来的不算。
        // 与 `SearchOverlay` 的空白退出同口径（`event.target === event.currentTarget`）。
        if (event.target !== event.currentTarget) return;
        leave(() => navigate('home'));
      }}
    >
      {/* 第十七轮第 ⑤ 条：左上角只有非交互标签，没有退出键 —— `pointer-events: none` 在 CSS 里
          关掉，于是点它也算「点空白」，一样退回播放页。 */}
      <header className="pi-pllist__head">
        <span className="pi-pllist__label">
          <Icon name={head.icon} size={15} />
          {head.label}
        </span>
      </header>

      {/* 卡片流就是搜索那一套（含它自己的拖动 / 滚轮 / ←→ 与拖动跟手高亮）。
          用户 m00736 第 7 条 a：只有这里打开 `dragFeel="free"`（大幅度拖动阻尼衰减）。 */}
      <SongCards
        cards={cards}
        dragFeel="free"
        onCard={(index) => {
          /* 推荐面第 0 张是每日推荐哨兵卡：点它开每日推荐那一档歌曲浮层（与平凡面同一行为）。 */
          if (isRecommend && index === 0) {
            leave(() => openSongs({ kind: 'daily', id: 0, title: '每日推荐' }));
            return;
          }
          const playlist = playlistAt(index);
          if (playlist === undefined) return;
          open(playlist);
        }}
        hint="滚轮 / ←→ / 拖动切换，点中心卡片进入 · 点空白处回到播放页"
        empty={
          source.error ? (
            errorMessage(source.error)
          ) : source.isPending ? (
            <>
              <Icon name="refresh" size={16} />
              正在读取歌单…
            </>
          ) : (
            '这里还没有歌单。'
          )
        }
      />
    </div>
  );
}
