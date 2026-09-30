import { useEffect, type ReactNode } from 'react';
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
import { useIdle } from './lib/idle';
import { useLastPlayed } from './lib/last-played';
import { installMediaSession } from './lib/media-session';
import { HomePage } from './pages/HomePage';
import { MinePage } from './pages/MinePage';
import { PlaylistPage } from './pages/PlaylistPage';
import { SearchPage } from './pages/SearchPage';
import { useUi } from './state/ui';

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

function useThemeMode(): void {
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => invoke(CH.settingsGet) });
  const theme = settings.data?.theme ?? 'light';

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      root.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
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
  useThemeMode();
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
      <main className="pi-main" data-page={nav} data-avant-list={avantList ? 'true' : 'false'}>
        {avantList ? PAGES.home : PAGES[nav]}
      </main>
      {avantList ? <PlaylistCoverflowOverlay nav={nav} /> : null}
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
