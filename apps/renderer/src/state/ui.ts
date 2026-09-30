import { create } from 'zustand';
import type { Playlist } from '@pi/shared';
import type { Point } from '../lib/drag-snap';
import type { NavId } from '../components/NavDrawer';

/**
 * 全局 UI 状态（与业务数据无关的那部分）。
 *
 * 为什么这些字段在这里、而不是页面自己的 useState：
 * - 登录弹窗：标题栏、我的面、歌单面都可能触发，本体挂在 App 根部；
 * - `nav`：侧边栏不再常驻，导航入口（环形菜单、抽屉、播放器主页的空态按钮）
 *   分散在三个组件里，各自拿 useState 就没法互相跳页；
 * - 悬浮球的开合与位置：**唯一**的播放/导航入口，切页面不能把它收起或重置位置。
 */
/** 播放器主页右侧滑出的面板：评论 / 歌曲信息。 */
export type HomePanel = 'none' | 'comments' | 'info';

/**
 * 「按一个 id 取歌」的浮层目标（用户第九轮第 2 条）。
 *
 * 播放页名片里的**歌手名 / 专辑名**都可以点，点了就出这一串歌曲卡片；
 * 第九轮第 8 条又把环形菜单的「播放列表」也并进来（那一档直接读活着的队列，不需要 id）。
 * 和 `openedPlaylist` 分开是因为两者的身体不一样：歌单走 `PlaylistDetail`
 * （有「添加歌曲」、分页累加、空态提示），歌手/专辑/队列只要「标题 + 卡片列表」。
 * 它们盖的是同一个玻璃浮层（`components/SongListOverlay.tsx`）。
 */
export interface SongListTarget {
  /* `'daily'` = 推荐歌单页网格最前面那张「每日推荐」卡（数据源 `lib/queries.ts` 的
     `useRecommend()`，走 `library:recommend`）。它和 `queue` 一样**留在浮层里**：
     身体还是同一套「标题 + 歌曲列表」，点一首歌 = 把这份列表当播放队列。 */
  kind: 'artist' | 'album' | 'queue' | 'daily';
  id: number;
  /** 浮层标题：歌手名 / 专辑名 / 「当前播放」/「每日推荐」。 */
  title: string;
  /** 副标题（歌手写「热门 50 首」，专辑写「歌手 · 年份」这一类）。 */
  subtitle?: string;
  /** 封面：专辑用专辑封面，歌手用当前这首歌的封面兜底。 */
  coverUrl?: string;
}

/**
 * **独立页**的目标（M4 剩余项：「专辑/歌手独立页」）。
 *
 * 与 `SongListTarget` 的关系：字段几乎一样，但少一个 `queue`（「当前播放」不是一个能独立
 * 存在的页面），而且**去掉了 `kind: 'artist' | 'album'` 与浮层的耦合** —— 同一批字段以前
 * 只对应「一张盖在播放页上的纸」，现在对应「一整页」。两档分开写而不是复用同一个类型，
 * 是因为渲染身体不同（`SongListOverlay` 的分支 vs `SongPageOverlay`），
 * 用同一个类型就得在每个渲染处按 kind 猜，改一处必漏另一处。
 */
export interface SongPageTarget {
  kind: 'artist' | 'album';
  id: number;
  /** 页面标题：歌手名 / 专辑名。 */
  title: string;
  /**
   * 副标题的**来源线索**（不是最终文案）：
   * 歌手那一档是「歌手」（页面自己把首数与专辑数补上），
   * 专辑那一档是歌手名（页面自己把曲目数补上，见 `lib/artist-albums.ts` 的 `albumSubtitle`）。
   */
  subtitle?: string;
  /** 封面：专辑用专辑封面；歌手没有头像通道，用当前这首歌的专辑封面兜底。 */
  coverUrl?: string;
}

/**
 * 第十六轮第 6 条（用户 m07538）：「删去悬浮球」——原来那套环形菜单
 * （`ringPage` / `playlistSource` / `orbPos` / `orbOpen`）整块拿掉，
 * 导航改由播放页空白处点出来的 **PI 圆键 + 划动手势**承担。
 * 划出来的拍立得卡片只有两张：`collections`（六块歌单按键）与 `settings`（快捷设置）。
 */
export type QuickPanel = 'none' | 'collections' | 'settings';

/**
 * 界面风格（用户第十七轮第 2/3 条）：**平凡**与**先锋**两套排版。
 *
 * - `plain`（平凡）：歌单列表 = 平铺封面格（`.pi-grid`），歌曲列表 = 竖排列表（图 3）。
 *   这是「信息优先」的一套，扫歌名最快。
 * - `avant`（先锋）：歌单列表 = 全屏封面卡片轮播（图 4 那种中心大卡），
 *   歌曲列表 = 队列拼贴（`SongCollage` 那面墙）。这是「画面优先」的一套。
 *
 * 为什么存在 renderer 的 zustand 而不是 `Settings`（packages/shared）里：
 * 那条路要动 `packages/ipc` 的通道名与主进程的 patch 校验（白名单式），
 * 为一个纯前端的排版开关扩协议不划算。这里用 localStorage 持久化，
 * 键是 `pi.ui-style`，`App.tsx` 再把它写到 `.pi-app[data-ui-style]` 上，
 * 让 CSS 与冒烟探针都能读到。
 */
export type UiStyle = 'plain' | 'avant';

/** localStorage 键名；换名字等于丢掉用户的选择，所以是常量。 */
const UI_STYLE_KEY = 'pi.ui-style';

/** 读上次选的风格；没有 / 存储不可用（隐私模式、被禁）都退回 `plain`。 */
function readStoredUiStyle(): UiStyle {
  if (typeof window === 'undefined') return 'plain';
  try {
    return window.localStorage.getItem(UI_STYLE_KEY) === 'avant' ? 'avant' : 'plain';
  } catch {
    return 'plain';
  }
}

/** 写回风格。存储不可用时静默放过——排版开关写不进去不该让整个应用崩掉。 */
function persistUiStyle(style: UiStyle): void {
  try {
    window.localStorage.setItem(UI_STYLE_KEY, style);
  } catch {
    /* 隐私模式 / 配额满：本次会话仍然生效，只是下次打开回到默认 */
  }
}

interface UiState {
  loginOpen: boolean;
  openLogin: () => void;
  closeLogin: () => void;

  /* 第九轮第 8 条：原来那个「播放队列抽屉」（`.pi-queue` 行列表 + `queueOpen`）删掉了。
     环形菜单右侧的「播放列表」现在与歌手/专辑一样，开同一个歌曲卡片浮层
     （`openSongs({ kind: 'queue' })`），所以这里不再有独立的 queueOpen 状态。 */

  /** 当前页面。跳页一律走 `navigate`，它会顺手收起抽屉与环形菜单。 */
  nav: NavId;
  navigate: (id: NavId) => void;
  /** 播放器主页右侧面板。 */
  homePanel: HomePanel;
  setHomePanel: (panel: HomePanel) => void;

  /**
   * 播放页空白处点出来的 PI 圆键（第十六轮第 6 条）。
   * 坐标是**视口坐标**（`screenX/screenY`），`null` = 现在没有浮着的键。
   */
  quickPos: Point | null;
  setQuickPos: (pos: Point | null) => void;
  /**
   * 这一次浮现是「哪根指针按出来的」（用户第十七轮第 1 条的长按跟手）。
   *
   * 为什么是对象、不是裸的数字 id：鼠标的 `pointerId` 永远是同一个（Chrome 恒为 1），
   * 光靠数字，第二次按下时字段值没变、`PiQuickOrb` 那个「接管起点」的 effect 不会重跑，
   * 球就接不上这根新按下的指针了。每次都新建一个对象，身份一变 effect 必重跑。
   */
  quickFollow: { pointerId: number } | null;
  /**
   * 空白处按下：就地在这一点浮现 PI 键，并把按下的指针交给它跟随。
   *
   * `hideOrb`（用户 m00736 第 5 条）：只把**卡片**叫出来、不要连带显示圆球。卡片挂在
   * 这个 `quickPos` 上（它是卡片的锚点），而球显不显示是另一回事——所以这里是「连球一起
   * 召唤、但把球藏起来」，不是「不召唤」。
   */
  summonQuick: (pos: Point, pointerId: number | null, hideOrb?: boolean) => void;
  /** PI 键上划 / 右划打开的那张拍立得卡片（`none` = 只浮着一颗键）。 */
  quickPanel: QuickPanel;
  setQuickPanel: (panel: QuickPanel) => void;
  /**
   * 圆球是否**整颗藏起来**（用户 m00736 第 2、5 条）。
   *
   * 两处会置真：① 松手即收——宿主在塌陷动画播完后置真，于是球没了、卡片照旧；
   * ② 快捷键召唤「歌单选择卡」时直接置真（用户第 5 条），卡片开、球不出现。
   * 它只管球的显隐：`quickPos` 仍是卡片的锚点，**不要**拿它的真假去判断有没有卡片。
   */
  quickOrbHidden: boolean;
  setQuickOrbHidden: (hidden: boolean) => void;

  /**
   * 从歌单封面环点开的歌单（用户第八轮第 6 条改法）。
   *
   * 以前它会被当成「打开一个歌单详情页」：`mine:playlists` / `playlist:star` 那两个页面
   * 会直接在整页里渲染 `PlaylistDetail`。现在不跳页了，改成在播放页上盖一层
   * 玻璃模糊 + 歌曲卡片列表浮层（`components/SongListOverlay.tsx`），所以
   * `openPlaylist` 顺手把 `nav` 拨回 `home`——浮层永远出现在歌曲播放页上。
   */
  openedPlaylist: Playlist | null;
  openPlaylist: (playlist: Playlist) => void;
  closePlaylist: () => void;

  /**
   * 播放页名片点出来的歌手 / 专辑歌曲卡片（用户第九轮第 2 条）。
   * 和 `openedPlaylist` 共用同一层浮层，同一时刻只会有一个。
   *
   * **M4 剩余项改过语义**：`kind` 是 `'queue'` / `'daily'` 时才落进这个字段（两者仍是浮层）；
   * `'artist'` / `'album'` 改由 `openSongPage` 走独立页（`openedSongPage`），见下面的注释。
   */
  openedSongs: SongListTarget | null;
  /** 打开浮层。歌手 / 专辑这两档会被**转交**给 `openedSongPage`（不改调用方）。 */
  openSongs: (target: SongListTarget) => void;
  closeSongs: () => void;

  /**
   * 专辑页 / 歌手页（M4 剩余项：「专辑/歌手独立页」）。
   *
   * 以前点播放页名片里的歌手名 / 专辑名只是开一张卡片浮层（拿不到 id 时还会跳搜索页），
   * 现在是一整页（`components/SongPageOverlay.tsx`，挂在外壳里与设置页同一套相位进出场）。
   *
   * 为什么 `openSongs` 要把歌手/专辑那两档转到这里、而不是让调用方改调 `openSongPage`：
   * 入口在 `pages/HomePage.tsx:286-317`（那一处本轮不许动），转交之后
   * 「点名片上的歌手/专辑 → 独立页」**不需要改任何调用方**；
   * 别的入口想直说也可以直接调 `openSongPage`。
   */
  openedSongPage: SongPageTarget | null;
  openSongPage: (target: SongPageTarget) => void;
  closeSongPage: () => void;

  /**
   * 设置浮层（用户第八轮第 7 条）：点「设置」**不换整页**（`NavId` 里的 `settings` 已经删掉）。
   * 第十六轮删掉悬浮球之后，这里的入口有三个：抽屉的「设置与音源」（`components/NavDrawer.tsx`）、
   * 悬浮 PI 键右划出来的快捷设置卡（`components/PiQuickPanels.tsx`）的「更多」键，以及它自己。
   * 翻成 true 之后设置框从屏幕中心「流」出来（见 `components/SettingsOverlay.tsx`）。
   */
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;

  /** 完整导航抽屉（设置子菜单里的「账号」进这里，那里是全应用唯一的登录入口）。 */
  navOpen: boolean;
  toggleNav: () => void;
  closeNav: () => void;

  /** 抽屉顶部搜索框与搜索页共用的关键词（提交后才写入）。 */
  searchKeywords: string;
  setSearchKeywords: (keywords: string) => void;

  /**
   * 搜索浮层（用户 m06304 第 6 条）：点环形菜单的「搜索」**不再跳搜索页**，
   * 而是在当前页上盖一层整体模糊，中间一个搜索框 + 下面一行结果卡片。
   * 原来的搜索页还留着（抽屉里的搜索框仍然跳它）。
   */
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;

  /**
   * 界面风格（用户第十七轮第 1 条）：PI 圆键**向左划**在两套排版之间切换。
   * 左划不是「打开某张卡片」，而是把整套列表排版换掉——所以它住的不是
   * `quickPanel`，而是这个全局字段。
   */
  uiStyle: UiStyle;
  setUiStyle: (style: UiStyle) => void;
  /** 在平凡 / 先锋之间翻转（PI 圆键左划走这里）。 */
  toggleUiStyle: () => void;

  /**
   * 推荐页各区块的展开状态（网易云歌单风格的折叠块）。
   * 键是区块 id，缺省时用组件给的默认值；切页面回来保持用户上次的折叠选择。
   */
  folds: Record<string, boolean>;
  setFold: (id: string, open: boolean) => void;
}

/**
 * `SongListTarget` → `SongPageTarget`：`queue` / `daily` 两档返回 `null`（它们还留在浮层里），
 * 歌手 / 专辑返回独立页的目标。放在 store 外面是因为它是纯函数、与状态无关。
 */
function pageTargetOf(target: SongListTarget): SongPageTarget | null {
  if (target.kind === 'queue' || target.kind === 'daily') return null;
  return {
    kind: target.kind,
    id: target.id,
    title: target.title,
    subtitle: target.subtitle,
    coverUrl: target.coverUrl,
  };
}

/**
 * 窗口顶沿那条「按住就拖窗口」的带宽（px），与 `global.css` 的
 * `.pi-windowcontrols__dragstrip` 是同一个数（用户 m02213 第 6 条把 7 → 32）。
 *
 * 随窗口高度收缩：矮窗口里 32px 已经吃掉一大截（冒烟的最小窗口也会矮到 400px 上下），
 * 按 6% 收一收。`PiQuickOrb` 那边的探针从窗口高度 14% 起找空白点，两边不会打架。
 */
const QUICK_ORB_TOP_BAND = 32;

function quickTopBand(): number {
  const height = typeof window === 'undefined' ? 0 : window.innerHeight;
  return Math.min(QUICK_ORB_TOP_BAND, height * 0.06);
}

export const useUi = create<UiState>((set) => ({
  loginOpen: false,
  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false }),

  nav: 'home',
  // 跳页不再顺手收环形菜单（那东西本轮已删）；但要收掉搜索浮层，否则跳完页它还盖在上面。
  // 第十六轮第 6 条：跳页同时把空白处点出来的 PI 键与它的卡片收掉（键只属于刚才那一页）。
  navigate: (id) =>
    set({ nav: id, navOpen: false, searchOpen: false, quickPos: null, quickPanel: 'none' }),
  homePanel: 'none',
  setHomePanel: (homePanel) => set({ homePanel }),

  quickPos: null,
  // 收回键的时候顺手把卡片也关掉（键都没了，卡片不该还挂在半空），跟随指针与「只开卡不显球」
  // 那一档一并清掉（用户 m00736 第 2、5 条）。
  setQuickPos: (quickPos) =>
    set(
      quickPos === null
        ? { quickPos, quickPanel: 'none', quickFollow: null, quickOrbHidden: false }
        : { quickPos },
    ),
  quickFollow: null,
  // 第十七轮第 1 条：按下即浮现（换一个点按就是把它挪过去），跟随的指针每次都是新对象。
  // 用户 m00736 第 5 条：`hideOrb` 只给键盘那条路用（tab 开歌单选择卡时不要连带显球）；
  // 鼠标按出来的这一下永远是显球的（缺省 false，也正是「下次按下鼠标再出现」）。
  summonQuick: (quickPos, pointerId, hideOrb = false) => {
    // 用户 m02213 第 6 条：「顶框周围鼠标长按不是显示圆球而是可以拖拽 app 窗口。」
    // 顶框那一条（`quickTopBand()`）是窗口自己的拖拽区，系统级拖拽会把页面指针事件整条
    // 吃掉；万一某个平台或合成输入还是把这一按送进来了，也在这里拦掉——球要是浮在拖拽区
    // 上，那一带就拖不动窗口了。键盘那条路（`pointerId === null`，家位在窗口右侧居中）
    // 不受影响，`hideOrb` 的语义也照旧。
    if (pointerId !== null && quickPos.y <= quickTopBand()) return;
    set({
      quickPos,
      quickPanel: 'none',
      quickFollow: pointerId === null ? null : { pointerId },
      quickOrbHidden: hideOrb,
    });
  },
  // 用户 m00736 第 2 条：松手即收——宿主（HomePage 的 QuickDock）在塌陷动画播完后置真。
  quickOrbHidden: false,
  setQuickOrbHidden: (quickOrbHidden) => set({ quickOrbHidden }),
  quickPanel: 'none',
  setQuickPanel: (quickPanel) => set({ quickPanel }),

  openedPlaylist: null,
  // 顺手回播放页：歌曲卡片列表浮层是「盖在正在听的歌上面」的一层，不是另一个页面。
  // 同时清掉歌手/专辑那一份：同一时刻只允许一层（它们盖的是同一个浮层）。
  openPlaylist: (openedPlaylist) =>
    set({
      openedPlaylist,
      openedSongs: null,
      // M4 剩余项：歌单浮层与专辑/歌手独立页互斥（同一时刻只允许一层盖在播放页上）。
      openedSongPage: null,
      nav: 'home',
      navOpen: false,
      searchOpen: false,
    }),
  closePlaylist: () => set({ openedPlaylist: null }),

  openedSongs: null,
  /**
   * M4 剩余项：`artist` / `album` 两档**转交**给独立页（`openedSongPage`），
   * `queue` / `daily` 仍然开浮层。转交之后 `pages/HomePage.tsx:286-317` 那两个入口一个字都不用改。
   */
  openSongs: (target) => {
    const page = pageTargetOf(target);
    if (page !== null) {
      set({
        openedSongPage: page,
        openedSongs: null,
        openedPlaylist: null,
        nav: 'home',
        navOpen: false,
        searchOpen: false,
      });
      return;
    }
    set({
      openedSongs: target,
      openedPlaylist: null,
      openedSongPage: null,
      nav: 'home',
      navOpen: false,
      searchOpen: false,
    });
  },
  closeSongs: () => set({ openedSongs: null }),

  openedSongPage: null,
  openSongPage: (openedSongPage) =>
    set({
      openedSongPage,
      openedSongs: null,
      openedPlaylist: null,
      nav: 'home',
      navOpen: false,
      searchOpen: false,
    }),
  closeSongPage: () => set({ openedSongPage: null }),

  navOpen: false,
  // 第十六轮第 6 条：抽屉与那颗 PI 键的卡片互斥（抽屉盖住整页时，飘在前面的卡片要收掉）。
  toggleNav: () => set((state) => ({ navOpen: !state.navOpen, quickPanel: 'none' })),
  closeNav: () => set({ navOpen: false }),

  searchKeywords: '',
  setSearchKeywords: (searchKeywords) => set({ searchKeywords }),

  searchOpen: false,
  openSearch: () => set({ searchOpen: true, navOpen: false }),
  closeSearch: () => set({ searchOpen: false }),

  settingsOpen: false,
  // 注意：`openSettings` 只负责「框流出来」这一段；调用方（抽屉项 / 悬浮 PI 键的快捷设置卡）自己决定要不要先收起自己。
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  folds: {},
  setFold: (id, open) => set((state) => ({ folds: { ...state.folds, [id]: open } })),

  // 第十七轮第 1 条：左划 PI 圆键在平凡 / 先锋之间切。初值从 localStorage 里捞，
  // 所以「上次选了先锋，这次打开还是先锋」。
  uiStyle: readStoredUiStyle(),
  setUiStyle: (uiStyle) => {
    persistUiStyle(uiStyle);
    set({ uiStyle });
  },
  toggleUiStyle: () =>
    set((state) => {
      const uiStyle: UiStyle = state.uiStyle === 'avant' ? 'plain' : 'avant';
      persistUiStyle(uiStyle);
      return { uiStyle };
    }),
}));
