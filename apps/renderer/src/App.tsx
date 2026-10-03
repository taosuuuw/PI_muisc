import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CH, invoke } from './bridge';
import { NavDrawer, type NavId } from './components/NavDrawer';
import { WindowControls } from './components/WindowControls';
import { AudioEngine } from './components/AudioEngine';
import { LoginDialog } from './components/LoginDialog';
import { SearchOverlay } from './components/SearchOverlay';
import { SettingsOverlay } from './components/SettingsOverlay';
import { SongListOverlay } from './components/SongListOverlay';
import { SongPageOverlay } from './components/SongPageOverlay';
import { PlaylistCoverflowOverlay, type PlaylistNav } from './components/PlaylistCoverflowOverlay';
import { ShortcutLayer } from './components/ShortcutLayer';
import { StyleToast } from './components/StyleToast';
import { customAccentTokens } from './lib/accent';
import { useIdle } from './lib/idle';
import { useLastPlayed } from './lib/last-played';
import { installMediaSession } from './lib/media-session';
import { HomePage } from './pages/HomePage';
import { MinePage } from './pages/MinePage';
import { PlaylistPage } from './pages/PlaylistPage';
import { SearchPage } from './pages/SearchPage';
import { useUi, type UiStyle } from './state/ui';

/**
 * M0 阶段刻意不引路由库：页面就是一个联合类型 + 一张表。
 * 等页面多起来（M1 之后有歌单详情、歌手详情、专辑详情）再换成真正的路由，
 * 那时也需要路由了（要支持返回、深链）。
 *
 * M3 改版后默认页是**播放器主页**：用户打开应用第一眼就该看到正在听的歌。
 */
const PAGES: Record<NavId, ReactNode> = {
  home: <HomePage />,
  search: <SearchPage />,
  'mine:recent': <MinePage tab="recent" />,
  'mine:like': <MinePage tab="like" />,
  'mine:download': <MinePage tab="download" />,
  'mine:playlists': <MinePage tab="playlists" />,
  // m08768 第 3 条：推荐页去掉了；第十六轮第 6 条又把它**请回来**——悬浮球删掉之后，
  // 「推荐歌单」需要一个能被六块按键点到的落点（数据走 `/personalized`，见 PlaylistPage）。
  'playlist:star': <PlaylistPage tab="star" />,
  'playlist:recommend': <PlaylistPage tab="recommend" />,
  // 第八轮第 7 条：`settings` 这一页删掉了——设置改成盖在播放页上的框式浮层
  //（`components/SettingsOverlay.tsx`），不再占满整个 app。
};

/**
 * 把主题明暗写到 `<html data-theme>` 上，并**返回解析后的那一档**。
 *
 * 为什么要把解析结果返回出去（第二十一轮第 5 条）：应用主题色里「自定义」那档要按明暗
 * 决定悬停/深色往哪边走（亮档压深、暗档提亮），而「跟随系统」时明暗可能在**不重渲染**的情况下
 * 被媒体查询改掉（下面 `apply` 直接改 DOM）。所以这里把结果落到 state 上，
 * 让 `useAccent` 能把它当依赖。
 */
function useThemeMode(): 'light' | 'dark' {
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => invoke(CH.settingsGet) });
  const theme = settings.data?.theme ?? 'light';
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const next: 'light' | 'dark' =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      root.dataset.theme = next;
      setResolved(next);
    };
    apply();
    if (theme !== 'system') return undefined;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  return resolved;
}

/**
 * 应用主题色（用户第二十一轮第 5 条：「在设置里加入应用主题色设置，影响按键的颜色等，
 * 将黑白/天蓝设为默认色，并且有自定义选项」）。
 *
 * 落法：把档位写到 `<html data-accent>`（`sky` / `mono` 两支的色值在 `styles/tokens.css` 里），
 * 自定义那档用 `lib/accent.ts` 算好五枚变量写成内联自定义属性 —— 内联样式特异度最高，
 * 所以它天然压过 tokens.css 里那两套。
 */
function useAccent(scheme: 'light' | 'dark'): void {
  const mode = useUi((s) => s.accentMode);
  const color = useUi((s) => s.accentColor);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = mode;
    const keys = [
      '--pi-primary',
      '--pi-primary-hover',
      '--pi-primary-weak',
      '--pi-primary-deep',
      '--pi-on-primary',
    ] as const;
    // 非自定义档：把上一轮留下的内联值全部撤掉，让 tokens.css 的分档接手。
    if (mode !== 'custom') {
      for (const key of keys) root.style.removeProperty(key);
      return;
    }
    const tokens = customAccentTokens(color, scheme === 'dark');
    root.style.setProperty('--pi-primary', tokens.primary);
    root.style.setProperty('--pi-primary-hover', tokens.hover);
    root.style.setProperty('--pi-primary-weak', tokens.weak);
    root.style.setProperty('--pi-primary-deep', tokens.deep);
    root.style.setProperty('--pi-on-primary', tokens.onPrimary);
  }, [mode, color, scheme]);
}

/**
 * 第十三轮第 6 条（用户 m04663）：把播放会话接到系统的媒体卡片上（Windows 的 SMTC / 音量浮层的
 * 「正在播放」小名片）。那张名片是**系统**画的——我们不接 Media Session，它既拿不到歌名封面，
 * 上面按钮点了也没有人响应。`installMediaSession()` 自己是幂等的（内部有 `installed` 旗标）。
 */
function useMediaSession(): void {
  useEffect(() => {
    installMediaSession();
  }, []);
}

/** 先锋风格下会换成「全屏封面卡片轮播」的三档歌单页（用户第十七轮第 ③ 条）。 */
function isPlaylistNav(id: NavId): id is PlaylistNav {
  return id === 'mine:playlists' || id === 'playlist:star' || id === 'playlist:recommend';
}

/**
 * 「从别的页回到播放页」的过渡窗口（用户第二十一轮第 3 条：
 * 「从歌单页点击进度条部件回到歌曲播放页的加个过渡动画」）。
 *
 * `state/ui.ts` 的 `navigate('home')` 会记一个时间戳，这里把它展开成一个 0.56s 的布尔量：
 * 期内 `.pi-main` 带 `data-arrive='true'`，并多渲染一层薄幕 `.pi-page-arrive-veil` 淡出，
 * 把「歌单页被换掉、播放页接管」这一下藏起来（薄幕只作兜底 —— 正常情况下这一路是
 * 「旧画面自己淡出」：平凡的整页走 `.pi-page-leaving`，浮层走 `data-closing`，
 * 换页那一拍走 `::view-transition-old(root)`）。
 *
 * 第二十七轮（用户：「我感觉是沉浸式背景『绽开』这个设置导致的闪一下，把它去掉」）：
 * 原来 `data-arrive` 还顺带驱动沉浸式背景那条 `pi-immersive-arrive` 绽开动画，
 * 现在**那条整条删了** —— 沉浸式背景一上来就是常态，不再缩放/提透明度。
 *
 * 为什么不用 `nav` 变化本身当判据：`nav` 从 `home` 变回 `home`（点播放页自己的底栏）不该放动画；
 * 而先锋档的歌单页底子**就是**播放页（`.pi-main` 从头到尾画的都是 `HomePage`），
 * `nav` 一直在 `home` 上、只有浮层收掉——所以判据必须是「navigate 的那一下」而不是「nav 变了」。
 */
function useHomeArrival(): boolean {
  const arriveAt = useUi((s) => s.homeArriveAt);
  const [arriving, setArriving] = useState(false);

  useEffect(() => {
    if (arriveAt === 0) return undefined;
    setArriving(true);
    const timer = window.setTimeout(() => setArriving(false), HOME_ARRIVE_MS);
    return () => window.clearTimeout(timer);
  }, [arriveAt]);

  return arriving;
}

/**
 * 这一下要不要铺那层薄幕（用户第二十三轮第 2 条）。
 *
 * 「浮层退场」那一路上浮层自己会淡出（`SongListOverlay` 的 `data-closing`）、播放页就在它
 * 底下 ⇒ 那已经是一次交叉淡出；再盖一层薄幕只会把正在交接的两边一起糊住，读起来反而更花。
 *
 * 第二十八轮补一条**同源的**例外（用户：「先锋模式下，从歌单选择页回到歌曲播放页的过渡动画中
 * 背景会闪一下…我希望只有淡出」）：先锋档的歌单选择页（封面卡片层 `.pi-pllist`）也是
 * **自己先淡干净**才换页的 —— 点空白 / Esc 那条路会先播 300ms 的 `pi-listoverlay-crossfade-out`，
 * 320ms 之后才 `navigate('home')`。等它收干净时屏幕上已经只剩播放页，这时候再铺一层薄幕，
 * 观感就是「刚淡完，背景又糊了一下、再慢慢化开」。
 *
 * 实测（`PI_SMOKE_UI_PLLIST=1`，`.tmp-r28/pllist-linger.log`）：浮层卸载后 +430ms 那一刻，
 * 页面上还剩一层 `pi-page-arrive-veil`（`backdrop-filter: blur(16px)`、不透明度 **0.41**、
 * 铺满 1182×772）；同一跑的逐合成帧「中心锐度」是 `1.91 → 1.07 → 1.91` —— 中间那 14 帧
 * 的下降再爬回来就是它。判据不是「薄幕该不该存在」而是用户要的那句话：**这一路只该有淡出**。
 */
function useArriveVeil(): boolean {
  const arriving = useHomeArrival();
  const kind = useUi((s) => s.homeArriveKind);
  /* 刚离开的那一页记在 state 里（见 `state/ui.ts` 的 `homeArriveFrom`）：`navigate('home')`
     把 nav 与到达时间戳一起落地，`App` 这边已经读不到旧 nav 了。 */
  const from = useUi((s) => s.homeArriveFrom);
  const uiStyle = useUi((s) => s.uiStyle);
  if (!arriving || kind !== 'page') return false;
  /* 先锋歌单封面层自己会淡干净 ⇒ 这一路不铺薄幕，屏幕上就只剩那一次淡出。 */
  return !(uiStyle === 'avant' && isPlaylistNav(from));
}

/** 过渡时长（ms），与 `global.css` 的 `pi-page-arrive-veil` 对齐。 */
const HOME_ARRIVE_MS = 560;

/**
 * **换页也走交叉淡出**（用户第二十四轮第 1 条：「歌单选择页回去也会闪一下，看能不能用之前的
 * 方式解决一下」）。
 *
 * 「之前的方式」= 第二十三轮给歌曲浮层做的那一套：别让旧内容一帧消失，让它自己淡出去，
 * 新内容（播放页）就在它底下一直渲染着。这里把它搬到**换页**上：
 *
 * - 平凡档的歌单页 / 我的是**整页**（`PAGES[nav]`），换页是瞬时的 ⇒ 把刚离开的那一页
 *   再挂 `PAGE_LEAVE_MS`，包一层 `.pi-page-leaving`（CSS 里淡出）—— 播放页在它下面，
 *   于是这是一次真正的交叉淡出。
 * - 先锋档的歌单页本来就是浮在播放页上的封面卡片层（`PlaylistCoverflowOverlay`）——
 *   它自己带 `data-leaving` 的收场动画，但**点底栏**那条路是 `navigate('home')` 直接把它
 *   卸掉的、动画没机会播 ⇒ 这里按它的旧 nav 再挂同样长的时间，把 `exiting` 点亮。
 *
 * 这两种情况都不需要那层薄幕（薄幕是「旧内容已经没了、只能盖一层」时的兜底）。
 *
 * **第二十五轮第 2 条的修正：这一层要在换页之前就挂上。**
 * 之前是盯着 `nav` 的变化挂的，也就是「换页和挂副本同一帧」—— 而副本是**重新挂载**的，
 * 图片要两帧才上屏，于是换页后那两帧整屏只剩底色（逐帧亮度实测 `95 → 35 35 → 86`，
 * 就是用户说的「还是有闪」）。现在改盯 `arriveHome` 那一下（底栏按下就声明，
 * 而真正的 `navigate('home')` 被 `BottomBar` 推迟两帧）：副本先挂上并画好，
 * 真页面还在它下面顶着 ⇒ 换页那一刻屏幕上什么都没变，随后才淡出。
 */
function usePageLeave(
  nav: NavId,
  uiStyle: UiStyle,
  kind: 'page' | 'overlay',
  arriveAt: number,
): { page: NavId | null; cover: PlaylistNav | null } {
  const [leave, setLeave] = useState<{ page: NavId | null; cover: PlaylistNav | null }>({
    page: null,
    cover: null,
  });
  /** 当前 nav：`arriveHome` 那一下触发时，nav 还停在**旧页**上（换页被推迟了两帧）。 */
  const current = useRef<NavId>(nav);
  current.current = nav;
  /** 收场令牌：只让**最后一次**过渡的定时器把状态清掉（连点两下不会把新过渡切断）。 */
  const token = useRef(0);
  /*
   * 用 `useLayoutEffect`（而不是 `useEffect`）：副本必须在**同一帧、绘制之前**挂上，
   * 否则它比真页面晚一帧出现，那一帧又是「闪」。
   */
  useLayoutEffect(() => {
    if (arriveAt === 0) return;
    const from = current.current;
    // 浮层那一档自己交叉淡出（`SongListOverlay` 的 `data-closing`），不需要这一层。
    if (kind !== 'page' || from === 'home') return;
    const cover = uiStyle === 'avant' && isPlaylistNav(from) ? from : null;
    token.current += 1;
    const mine = token.current;
    setLeave({ page: cover === null ? from : null, cover });
    window.setTimeout(() => {
      if (token.current === mine) setLeave({ page: null, cover: null });
    }, PAGE_LEAVE_MS);
  }, [arriveAt, kind, uiStyle]);
  return leave;
}

/**
 * 旧内容陪跑时长（ms）：比 CSS 那条「停 0.2s + 淡 0.36s = 0.56s」再宽一点，收干净为止。
 * 注意 `clickPoint` 这类自动化点击自带 ~310ms 的收尾延时，所以探针在「点完」那一刻采样时，
 * 淡出其实已经跑了一段 —— 时长留宽一点，那一拍仍然量得到状态。
 */
const PAGE_LEAVE_MS = 640;

/**
 * 骨架：主区 + 窗口控制浮层 + 四个浮层组件。
 *
 * 第十一轮第 5 条（用户 m03279）：原来顶部的 `.pi-titlebar` 整条删掉，骨架只剩主区一行；
 * 窗口三键与导航入口改由 `<WindowControls />` 在鼠标贴到窗口右上/左上角时向下浮出。
 *
 * - 导航与播放合成**一个**悬浮球（m05361 第 1 条）：点球展开环形菜单，
 *   左半边导航、右半边播放；设置子菜单里的「账号」进完整导航抽屉；
 *   m06304 起球贴到窗口边缘会收成细条、菜单自动收起；
 * - 播放器主页是默认页（第 2 条）：没歌是空白页 + 天蓝 PI，有歌是详情页 + 歌词 + 操作悬浮框；
 * - 搜索是盖在当前页上的模糊浮层（m06304 第 6 条），不再是单独一页；
 * - 当前页面由 `state/ui.ts` 里的 `nav` 决定，因为球、抽屉、主页空态都能跳页。
 */
export function App(): ReactNode {
  const nav = useUi((s) => s.nav);
  /**
   * 无操作自动隐藏（第八轮第 1 条）：整棵树的 `data-idle` 由这里统一开关，
   * 具体藏谁、怎么唤醒写在 `global.css` 的 `[data-idle='true']` 规则里
   * （名片/进度条/悬浮球各自靠 `:hover` 单独叫回自己，不会一起弹出来）。
   */
  const idle = useIdle();
  /**
   * 界面风格（用户第十七轮第 2/3 条）：平凡 / 先锋两套排版。
   * 挂到根节点上是为了两件事：① CSS 里按 `[data-ui-style='avant']` 选整套皮肤；
   * ② 排版不是「某个组件的内部状态」，页面里任何一层都能用选择器读到它。
   */
  const uiStyle = useUi((s) => s.uiStyle);
  /**
   * 先锋风格的三档歌单页（用户第十七轮第 ③⑤ 条）：底子照样是播放页，歌单改用
   * 全屏封面卡片轮播浮在上面 —— 于是「点模糊空白处回到播放页」就是 `navigate('home')`，
   * 和 image 4 里那层磨砂后面的东西也对得上（不是歌单网格自己）。
   */
  const avantList = uiStyle === 'avant' && isPlaylistNav(nav);
  const arriving = useHomeArrival();
  /* `arriveHome` 那一下（底栏按下就声明）与它是哪一路 —— 换页副本要在**换页之前**挂上。 */
  const homeArriveAt = useUi((s) => s.homeArriveAt);
  const homeArriveKind = useUi((s) => s.homeArriveKind);
  const leave = usePageLeave(nav, uiStyle, homeArriveKind, homeArriveAt);
  /*
   * 薄幕只做**兜底**：真正需要它的是「旧内容已经没了、只能盖一层」的场合。
   * 现在「回播放页」这一路上旧内容都会自己淡出（平凡档的旧页 / 先锋档的封面卡片层 /
   * 歌曲浮层的 `data-closing`），所以这一路不再铺薄幕 —— 铺了就是把正在交接的两边一起糊住，
   * 那正是用户第二十三、二十四轮连着说的「闪一下」。
   */
  const veil = useArriveVeil() && leave.page === null && leave.cover === null;
  const scheme = useThemeMode();
  useAccent(scheme);
  useLastPlayed();
  useMediaSession();

  return (
    <div className="pi-app" data-idle={idle} data-ui-style={uiStyle}>
      {/* 用户 m00001 第 5 条：全局快捷键（Esc / Tab / Ctrl+A / Ctrl+S / 空格 / 方向键）。
          只监听、不渲染；九条绑定都能在设置页「界面」tab 里改（state/shortcuts.ts）。 */}
      <ShortcutLayer />
      <WindowControls />
      {/* 用户 m02213 第 5 条：圆球左划换排版之后，从顶框下滑一条「已切换 ⨯⨯ 风格」，
          显示 2s 再升回顶框里（组件只盯 `uiStyle` 的变化，设置页换排版也认）。 */}
      <StyleToast />
      <main
        className="pi-main"
        data-page={nav}
        data-avant-list={avantList ? 'true' : 'false'}
        data-arrive={arriving ? 'true' : 'false'}
      >
        {avantList ? PAGES.home : PAGES[nav]}
      </main>
      {/* 回到播放页时那一层淡出的薄幕（用户第二十一轮第 3 条；第二十三轮第 2 条改成只在
          「换页」那一路上铺 —— 浮层退场那条路自己就是交叉淡出，再盖一层反而是糊上加糊）。 */}
      {veil ? <div className="pi-page-arrive-veil" data-page-arrive="true" /> : null}
      {/*
        换页的交叉淡出（用户第二十四轮第 1 条）：刚离开的那一页再陪跑 `PAGE_LEAVE_MS`，
        自己在 CSS 里淡出去。它是一层 `.pi-main` 拷贝（同样的 `data-page`，页面样式照吃），
        `pointer-events: none` 由 CSS 给 —— 新页早就接管了交互。
      */}
      {leave.page !== null ? (
        <div
          className="pi-main pi-page-leaving"
          data-page={leave.page}
          data-page-leaving="true"
          aria-hidden="true"
        >
          {PAGES[leave.page]}
        </div>
      ) : null}
      {/*
        先锋档的歌单页（封面卡片层）。用户第二十六轮：「直接套用歌单歌曲页退回播放页的动画
        就可以了吧，都是淡出」—— 于是这里**保持同一个树位置、同一个实例**：
        nav 已经离开歌单页之后，仍用旧 nav 继续渲染这一层，只把 `closing` 打开，
        由 `data-closing` 那条与歌曲页浮层**完全同一条**的 `pi-listoverlay-crossfade-out`
        淡出。同一个实例 ⇒ 不重新挂载、不重播卡片入场 ⇒ 真的只是淡出。
      */}
      {avantList || leave.cover !== null ? (
        <PlaylistCoverflowOverlay
          nav={avantList ? (nav as PlaylistNav) : (leave.cover as PlaylistNav)}
          closing={!avantList}
        />
      ) : null}
      <NavDrawer />
      <LoginDialog />
      <SearchOverlay />
      {/* 第八轮第 6 条：歌单曲目不再跳页，改成盖在播放页上的磨砂卡片列表浮层。 */}
      <SongListOverlay />
      {/* M4 剩余项（用户 m01402 第 3 条「把 M4 做了」）：歌手 / 专辑不再是卡片浮层或跳搜索页，
          而是一整页（玻璃页 + 大封面 + 曲目/专辑区）。挂在这里是为了让它的 backdrop-filter
          糊到整页（沉浸式背景与左下角名片）；自带 z-index 18，与 `.pi-listoverlay` 同层。 */}
      <SongPageOverlay />
      {/* 第八轮第 7 条：设置不再是整页，而是一个从屏幕中心流出来的框。 */}
      <SettingsOverlay />
      {/* 第十四轮第 8 条（用户 m05281）那张「切歌小名片」在第十六轮第 3 条里删掉了：
          用户 m07538 要求「去掉切换歌曲的小名片，替代为显示播放页左下角的歌曲名片」
          —— 所以现在是播放页左下角那张名片自己在切歌时浮出来（见 HomePage 的 `revealCard`）。 */}
      <AudioEngine />
    </div>
  );
}
