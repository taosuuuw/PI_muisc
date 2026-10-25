import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Playlist, Song } from '@pi/shared';
import { CH, invoke } from '../bridge';
import { coverAt } from '../lib/cover';
import { artistNames, formatDuration } from '../lib/format';
import { ROW_ORIGIN } from '../rhine/rhine-constants';
import { useAccount, useMyPlaylists, usePersonalizedPlaylists } from '../lib/queries';
import { HomeBar } from '../pages/HomePage';
import { usePlayer } from '../state/player';
import { useUi } from '../state/ui';
import {
  RhineScene,
  type RhineCardView,
  type RhineCatalog,
  type RhineColumnView,
  type RhineFocusInfo,
  type RhineFrameInfo,
  type RhineLevel,
} from '../rhine/rhine-scene';
import {
  RHINE_QUALITY_LABELS,
  persistRhineQuality,
  readStoredRhineQuality,
  type RhineQualityPreset,
} from '../rhine/rhine-quality';

/**
 * 「莱茵风」皮肤的三层界面（图 1 / 图 2 / 图 3）。
 *
 * 三层对应主人在这一轮点名的三处替代（原文见 `docs/RHINE-SKIN.md` 的「需求映射」）：
 *
 * | 层 | 参考里的样子 | 替代的是 |
 * |---|---|---|
 * | `overview`（图 1） | 每一列浮一块**列名牌**（编号 / 曲目数），列＝一张歌单 | 歌单封面卡片导航 |
 * | `near`（图 2） | 焦点那一列拉近，**右侧一条详情栏**（封面 / 标题 / 歌手 / 元信息） | 歌单页的歌曲选择导航 |
 * | `detail`（图 3） | 选中的那张盒子抽出来放大，右侧换成**完整曲目单** | 队列拼贴放大歌曲封面的界面 |
 *
 * 为什么这一层自己算 `level` 而不全靠宿主：抽出 / 退回是**同一台相机**的一次连续运动，
 * 拆成两个挂载点（近景一个组件、详情另一个组件）就会变成一次硬切 —— 参考里那套
 * 「浅抬起 0.4 → 抽取 4.05 → 镜头推近」的连招也就没有了。宿主只负责说「现在在浏览哪一路歌单 /
 * 有没有在看队列」，三层怎么走由这一层自己决定（Esc 逐级退）。
 */

export type RhineSource = 'mine' | 'star' | 'recommend';

export interface RhineLayerProps {
  /** 现在有没有在用它（false = 只是被挂在树上待命，不显示、不渲染）。 */
  active: boolean;
  /** 列来源：我的歌单 / 收藏歌单 / 推荐歌单。 */
  source: RhineSource;
  /** 宿主正在浏览某张歌单时给它的 id（进图 2）。 */
  focusPlaylistId?: number | undefined;
  /** 队列档（图 3 的另一条入口：环形菜单的「播放列表」）。 */
  queue: { songs: Song[]; index: number } | null;
  onClose: () => void;
  /** 歌单曲目页 → 歌单总览（Esc 的第一级；宿主负责同时把导航拨回列表档）。 */
  onBack: () => void;
  onOpenPlaylist: (playlist: Playlist) => void;
}

/**
 * **墙面**一次拉多少首（2026-10-24 裁剪）。
 *
 * 原来墙和「点进去的歌曲列表」共用 200：24 列 × 200 首 ≈ 4800 条曲目详情
 * （每首还带专辑封面 URL）一次性并发请求，推荐歌单实测 9.6 秒还没入库 ——
 * 而墙上每列真正要显示的只有 `VISIBLE_ROW_WINDOW`(40) 个格子。
 * 现在墙只取 40，点进去的那张列表仍然走 `FOCUS_PAGE`(200)，不受影响。
 */
const WALL_PAGE = 40;
/** 焦点歌单（点进去的歌曲列表）要更多：一屏能滚很多首。 */
const FOCUS_PAGE = 200;
/** 台面上最多摆几列（歌单太多时超出部分不进阵列，避免实例与名牌都失控）。 */
const MAX_COLUMNS = 24;

/** 系统「减少动态效果」偏好的媒体查询（过渡动画必须尊重它）。 */
const PREFERS_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** 落到播放页后补一次"确保在播"的延迟：给音源解析留一点时间，但不至于干等。 */
const PLAYBACK_KICK_MS = 900;
/**
 * 载入动画的**兜底撤离时间**（2026-10-22）。
 *
 * 正常情况下由"三维层出帧"来撤（`applyFrame` 里 `fps > 20 && drawn > 0`）。
 * 但页面刷新后场景可能不再出帧（Chromium 对页面级 rAF 的节流），那时 `booted` 永远为假，
 * 载入层就**永久盖住界面** —— 这是真实的坏状态，不能只靠"别刷新"来回避。
 * 所以再加一道超时：最多盖这么久，之后无论如何都撤。
 */
const BOOT_FALLBACK_MS = 15000;
/** 开场编排的时长（与场景里的 `INTRO_MS` 一致；这里只用于文档说明，不参与渲染）。 */

function toCards(songs: readonly Song[] | undefined): RhineCardView[] {
  if (songs === undefined) return [];
  return songs.map((song) => ({
    key: `song:${song.id}`,
    title: song.name,
    subtitle: artistNames(song),
    /*
     * 墙面瓦片只有 112px（见 `rhine-cover-atlas.ts` 的 `TILE`），原来按 320 取图是浪费：
     * 24 列 × 33 行 ≈ 900 张封面，320 比 160 多出 4 倍像素 —— 解码和显存都白花，
     * 直接反映成"加载界面停留很久"（2026-10-24 实测）。
     * 近景抽出来的那张另外按 640 取（`focusedSong` 那条路径），不受这里影响。
     */
    coverUrl: coverAt(song.album?.coverUrl, 160),
    // 卡片自带曲目对象：点它播它，不依赖任何列表/分页（见 `RhineCardView.song` 的说明）。
    song,
  }));
}

/** 播放器里一首歌都没有时给 `HomeBar` 的占位：它只拿它兜底时长，不读别的字段。 */
const EMPTY_BAR_SONG = { id: 0, name: '', durationMs: 0 } as unknown as Song;

/**
 * 档位切换器的固定顺序（也是滑动指示器的索引依据）。
 * 单独定一份而不是每次 `Object.keys()`：指示器要算 `index * 100%`，
 * 顺序必须稳定，不能依赖对象键的枚举次序。
 */
const QUALITY_ORDER: RhineQualityPreset[] = ['performance', 'original', 'high', 'ultra'];

export function RhineLayer(props: RhineLayerProps): ReactNode {
  const { active, source, focusPlaylistId, queue, onClose, onBack, onOpenPlaylist } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<RhineScene | null>(null);
  const plateRefs = useRef(new Map<string, HTMLElement>());
  const statsRef = useRef<HTMLDivElement | null>(null);
  /** 加载层元素：调试探针往里写 `data-rhine-warm`（不参与渲染，避免每帧 setState）。 */
  const loadingRef = useRef<HTMLDivElement | null>(null);
  const [quality, setQuality] = useState<RhineQualityPreset>(() => readStoredRhineQuality());
  /*
   * **底部直接用播放页那条进度条部件**（2026-10-25 主人：「进度条部件是要和歌曲播放页的
   * 一致，不是单独重做一个」）。
   *
   * 上一轮我在这里另写了一条 —— 那是错的：同一个软件里出现两条长得不一样、行为也不一样
   * （一个是松手才 seek、一个是按下就 seek）的进度条。现在改成复用 `HomePage` 导出的
   * `HomeBar`：同一份 DOM、同一套 `.pi-home__bar` 样式、同一套 scrub 逻辑，
   * 它自己是 `position: absolute; left: 50%` 的胶囊，挂在莱茵层上位置天然就对。
   */
  const playingSong = usePlayer((s) => s.songs[s.queue.index] ?? null);
  const [focus, setFocus] = useState<RhineFocusInfo | null>(null);
  const [drilled, setDrilled] = useState(false);
  /** 歌曲播放页是否展开（详情档点大盒子进入）。 */
  const [playerOpen, setPlayerOpen] = useState(false);
  /** 播放页展开时，封面从 CD 盒的位置飞出来（共享元素过渡的起点）。 */
  const [playerOrigin, setPlayerOrigin] = useState<{ x: number; y: number } | null>(null);
  /** 莱茵风首次成画之前显示加载动画。 */
  const [booted, setBooted] = useState(false);
  const bootedRef = useRef(false);
  /** 真实封面加载进度（0~1），由场景按"已就绪/计划总数"报上来。 */
  const [loadProgress, setLoadProgress] = useState(0);
  /** 场景创建时机早于 active 的 effect，用 ref 读当前值（见场景创建 effect 末尾）。 */
  const activeRef = useRef(false);
  activeRef.current = active;
  /** 预热是否已经发令（每帧回调里兜底，保证一定会启动）。 */
  const warmIssuedRef = useRef(false);
  /** 封面铺满屏幕的过渡时长（走完就切到播放页）。 */
  const PLAYER_FILL_MS = 520;
  const playerTimer = useRef<number | null>(null);

  /**
   * **落到播放页后确保真的在播**（2026-10-22 主人：“没有自动播放选择的音乐”）。
   *
   * `play()` 内部是“先解析音源、再等歌词”，这一步比过渡动画慢；过渡结束时
   * 状态可能还停在 `resolving`/`paused`。这里补一次：只要已经选好歌、但不处于播放中，
   * 就调用一次 `toggle()` 把它推起来。
   */
  const startPlaybackIfIdle = useCallback((expectedId: number, lists: readonly (readonly Song[])[]) => {
    window.setTimeout(() => {
      const state = usePlayer.getState();
      /*
       * **自愈**（2026-10-22 主人录屏证实"点 A 播 B"）：落到播放页后再核对一次
       * 当前播放是不是点击的那一首。不是就再按卡片 id 从两个列表里重播一次
       * （只在标识明确时动手，避免误触）。
       */
      if (!Number.isNaN(expectedId) && state.currentSong?.id !== expectedId) {
        for (const list of lists) {
          const at = list.findIndex((song) => song.id === expectedId);
          if (at >= 0) {
            void usePlayer.getState().play(list, at);
            return;
          }
        }
      }
      if (state.currentSong === null) return;
      if (state.status === 'playing' || state.status === 'resolving') return;
      void state.toggle();
    }, PLAYBACK_KICK_MS);
  }, []);

  const account = useAccount();
  const loggedIn = account.data?.loggedIn === true;
  const mine = useMyPlaylists(loggedIn && (source === 'mine' || source === 'star'));
  const personalized = usePersonalizedPlaylists(source === 'recommend', 30);

  /** 这一路来源的歌单列表（与 `PlaylistPage` 同口径：收藏只看 `subscribed`，我把 `specialType=5` 剔掉）。 */
  const playlists = useMemo<Playlist[]>(() => {
    if (source === 'recommend') return personalized.data?.playlists ?? [];
    const all = mine.data?.playlists ?? [];
    const list = source === 'star' ? all.filter((item) => item.subscribed === true) : all.filter((item) => item.specialType !== 5);
    return list.slice(0, MAX_COLUMNS);
  }, [mine.data, personalized.data, source]);

  const focusIndex = useMemo(() => {
    if (focusPlaylistId === undefined) return -1;
    return playlists.findIndex((item) => item.id === focusPlaylistId);
  }, [focusPlaylistId, playlists]);

  /*
   * 场景的 `onEvent` 建在只跑一次的 effect 里（deps 为空），闭包拿不到后来的 `playlists`
   * 和 `onOpenPlaylist`。用 ref 转一手，点列打开歌单才不会永远点空。
   */
  const playlistsRef = useRef<Playlist[]>([]);
  playlistsRef.current = playlists;
  const openPlaylistRef = useRef(props.onOpenPlaylist);
  openPlaylistRef.current = props.onOpenPlaylist;

  const focusedPlaylist = focusIndex >= 0 ? (playlists[focusIndex] ?? null) : null;

  /**
   * **每一列都要有自己的曲目**（2026-10-22 主人：「cd 盒不是显示歌单封面而是歌曲封面」）。
   *
   * 之前只给焦点那一列拉曲目，其余列的 `cards` 是空的 —— 于是 `cardAt()` 落到占位卡，
   * 用的是**歌单封面**，整面墙所有盒子长得一样。
   *
   * 现在歌单页一进来就把每列的曲目都拉一遍。开场动画本来就是给这些封面加载留的时间，
   * 所以这不是额外负担，而是把那段等待花在该花的地方。
   */
  const wallTrackQueries = useQueries({
    queries: playlists.map((playlist) => ({
      queryKey: ['rhine', 'tracks', playlist.id] as const,
      queryFn: () => invoke(CH.libraryPlaylistTracks, { playlistId: playlist.id, offset: 0, limit: WALL_PAGE }),
      enabled: active && queue === null,
    })),
  });
  const wallCardsByPlaylist = useMemo(() => {
    const map = new Map<number, RhineCardView[]>();
    playlists.forEach((playlist, index) => {
      const data = wallTrackQueries[index]?.data;
      if (data !== undefined) map.set(playlist.id, toCards(data.tracks));
    });
    return map;
  }, [playlists, wallTrackQueries]);

  /** 焦点那一列的曲目（比墙面要得多，单独一份缓存 —— 混用会让点进去只有 40 首）。 */
  const wantTracks = active && focusedPlaylist !== null;
  const tracks = useQuery({
    queryKey: ['rhine', 'tracks', focusedPlaylist?.id ?? 0, 'focus'] as const,
    queryFn: () =>
      invoke(CH.libraryPlaylistTracks, { playlistId: focusedPlaylist?.id ?? 0, offset: 0, limit: FOCUS_PAGE }),
    enabled: wantTracks,
  });

  const queueCards = useMemo(() => toCards(queue?.songs), [queue]);

  const catalog = useMemo<RhineCatalog>(() => {
    if (queue !== null) {
      return {
        columns: [
          {
            key: 'queue',
            title: '当前播放',
            subtitle: queue.songs.length > 0 ? `${queue.songs.length} 首` : '队列是空的',
            coverUrl: coverAt(queue.songs[queue.index]?.album?.coverUrl, 200),
            count: Math.max(1, queue.songs.length),
            cards: queueCards,
          },
        ],
      };
    }
    const columns: RhineColumnView[] = playlists.map((playlist) => ({
      key: `pl:${playlist.id}`,
      title: playlist.name,
      subtitle: playlist.creator ?? '',
      coverUrl: coverAt(playlist.coverUrl, 200),
      count: Math.max(0, playlist.trackCount),
      cards: playlist.id === focusedPlaylist?.id
        ? (toCards(tracks.data?.tracks).length > 0 ? toCards(tracks.data?.tracks) : (wallCardsByPlaylist.get(playlist.id) ?? []))
        : (wallCardsByPlaylist.get(playlist.id) ?? []),
    }));
    return { columns };
  }, [focusedPlaylist?.id, playlists, queue, queueCards, tracks.data, wallCardsByPlaylist]);

  /**
   * **Esc 从曲目页退回总览时，画面停在原处**（2026-10-22 主人：「不应该回到歌单选择页原点，
   * 而是当前位置」）。
   *
   * 之前是宿主 `navigate()` 回列表档：那会让路由重建、莱茵层重新挂载，相机与选中列全部重置
   * → 画面跳回第 1 列。现在改成在这一层内部翻一个标记：`openedPlaylist` 不关、组件不卸载，
   * 场景实例原封不动，于是镜头、滚动位置、选中列都留在退出前那一刻。
   */
  const [backToWall, setBackToWall] = useState(false);

  /** 台面上到底摆哪一层：队列档直接进图 3；浏览某张歌单是图 2（点进去才是图 3）。 */
  const level: RhineLevel = !active
    ? 'overview'
    : queue !== null
      ? 'detail'
      : focusPlaylistId === undefined || backToWall
        ? 'overview'
        : drilled
          ? 'detail'
          : 'near';

  // 换歌单 / 换来源时把「已钻进详情」「退回总览」这两档复位。
  useEffect(() => {
    setDrilled(false);
    setBackToWall(false);
  }, [focusPlaylistId, source, queue]);

  /*
   * **离开莱茵风时把"封面铺满"的过渡层彻底复位**（2026-10-22 主人截图：
   * 从播放页回到莱茵风后，屏幕上还挂着一张被放大到铺满的封面）。
   *
   * 原因是过渡层只由 `playerOpen` 控制，而 `onClose()` 之后这个组件并没有卸载
   * （它一直在根上待命），状态就留着，下次显示时那层 `opacity: 1` 的放大封面直接可见。
   * 这里在 `active` 变假时清状态、清定时器，下次进来就是干净的。
   */
  useEffect(() => {
    if (active) return;
    setPlayerOpen(false);
    setPlayerOrigin(null);
    if (playerTimer.current !== null) {
      window.clearTimeout(playerTimer.current);
      playerTimer.current = null;
    }
  }, [active]);

  /* 载入层的兜底撤离（见 `BOOT_FALLBACK_MS` 的说明）。 */
  useEffect(() => {
    if (!active) return undefined;
    /*
     * **计时必须从「这一层真的被打开」开始**（2026-10-25 修「画面卡在开场第一帧」）。
     *
     * 这个 effect 原来依赖 `[]`，也就是从组件挂载算起 —— 而莱茵层在播放页那会儿就已经
     * 挂在树上了。只要用户在播放页停了 15 秒以上再点歌单，兜底早就烧完了：
     * `booted` 被置真 ⇒ 下面那个 16ms 的预热定时器永远不会启动 ⇒ 预热停在 `pre=2`、
     * `introReady` 永远假，画面就冻在开场第一帧（实测 `warm=645/645/645` 全 ready
     * 却进不去，就是这个）。现在跟着 `active` 一起重来。
     */
    bootedRef.current = false;
    const timer = window.setTimeout(() => {
      bootedRef.current = true;
      setBooted(true);
    }, BOOT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  /*
   * **每次进入都重新走一遍加载界面**（2026-10-22 主人：加载界面要在开场动画之前）。
   *
   * 之前 `booted` 只在这一层挂载时初始化，而莱茵层往往在点进歌单页之前就已经挂着，
   * 于是"加载层"的判定早就通过了 —— 用户看到的是一闪而过、直接进动画。
   * 现在每次 `active` 由 false 变 true 都把它复位成 waiting。
   */
  useEffect(() => {
    if (!active) return;
    bootedRef.current = false;
    setBooted(false);
    setLoadProgress(0);
    warmIssuedRef.current = false;
    // 由加载层发令：从这一刻开始预热封面图集，进度才对得上界面。
    sceneRef.current?.beginWarmup();
  }, [active]);

  /*
  /* 开场镜头完全由场景里的关键帧轨道负责，这里不再做任何画面处理。 */


  /* ---------------------------------------------------------------- 场景生命周期 */

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const scene = new RhineScene({
      container: host,
      dark: document.documentElement.dataset.theme === 'dark',
      onEvent: (event) => {
        if (event.type === 'close') {
          onClose();
          return;
        }
        if (event.type === 'enter-detail') {
          setDrilled(true);
          return;
        }
        /*
         * **总览点某一列 = 打开那张歌单（进图 2）**（2026-10-24 补齐）。
         *
         * 场景在 `overview` 档点击时会发 `select-column`，但这里一直没有对应的 handler
         * —— 于是点上去毫无反应，只能靠外部列表才能进到歌曲选择页；图 2 也因此常常
         * 拿不到 `focusPlaylistId`，近景档的列填充与波浪都起不来。
         */
        if (event.type === 'select-column') {
          const target = playlistsRef.current[event.lane];
          if (target !== undefined) openPlaylistRef.current(target);
          return;
        }
        if (event.type === 'leave-detail') {
          setDrilled(false);
          return;
        }
        // 详情档点大盒子 = 打开播放页（2026-10-22 第 2 条）；用事件里带的**这张卡**，不用 React 状态。
        if (event.type === 'open-player') {
          openPlayer(event.card);
          return;
        }
      },
      onFrame: (info) => applyFrame(info),
      /*
       * `setFocus` 要**去重**：场景每次 `notifyFocus` 都可能给一个内容相同的新对象，
       * 直接 setState 会引发一次无意义的重渲染；如果上游正好有「重渲染 → 换 catalog 身份 →
       * setCatalog → notifyFocus」这种环，它就是那个被无限放大的环节（第五轮卡死）。
       * 内容没变就返回同一个引用，React 会直接跳过这次更新。
       *
       * 但**只比档位与行列是不够的**：曲目元数据（`card.title` / 封面）常常比焦点晚一拍到，
       * 那一拍的行列没变、内容变了 —— 只比行列就会把它丢掉，右栏标题停在「01」、歌手停在「?」
       * （2026-10-18 截图里就是这个）。所以把卡片与列的可见字段一起比。
       */
      onFocus: (info) =>
        setFocus((previous) =>
          previous !== null &&
          previous.level === info.level &&
          previous.lane === info.lane &&
          previous.row === info.row &&
          previous.index === info.index &&
          previous.card?.key === info.card?.key &&
          previous.card?.title === info.card?.title &&
          previous.card?.coverUrl === info.card?.coverUrl &&
          previous.card?.subtitle === info.card?.subtitle &&
          previous.column?.title === info.column?.title
            ? previous
            : info,
        ),
    });
    sceneRef.current = scene;
    // 调试接缝（与 `window.__piAudio` 同一类）：冒烟可以逐层隐藏，判断「封面没画进去」还是
    // 「被玻璃盖住了」。产品逻辑不读它。
    (window as unknown as { __piRhine?: (hidden: readonly string[]) => void }).__piRhine = (hidden) =>
      sceneRef.current?.debugLayers(hidden);
    (window as unknown as { __piRhineAtlas?: () => string }).__piRhineAtlas = () =>
      sceneRef.current?.debugAtlas() ?? '';
    (window as unknown as { __piRhineTiles?: () => unknown }).__piRhineTiles = () =>
      sceneRef.current?.debugTiles() ?? null;
    (window as unknown as { __piRhineState?: () => unknown }).__piRhineState = () =>
      sceneRef.current?.debugState() ?? null;
    (window as unknown as { __piRhinePeak?: () => unknown }).__piRhinePeak = () =>
      sceneRef.current?.debugPeak() ?? null;
    (window as unknown as { __piRhineCard?: () => unknown }).__piRhineCard = () =>
      sceneRef.current?.debugCard() ?? null;
    /*
     * 调试入口：直接调用画布的点击逻辑（2026-10-22）。
     * 用来区分"点击事件根本没到画布"和"到了但逻辑走错"——外部用
     * `__piRhineClick(x, y)` 后读 `__piRhineState().level` 就能分辨。
     */
    (window as unknown as { __piRhineClick?: (x: number, y: number) => void }).__piRhineClick = (
      x: number,
      y: number,
    ) => sceneRef.current?.debugClick(x, y);
    (window as unknown as { __piRhinePick?: (x: number, y: number) => unknown }).__piRhinePick = (x, y) =>
      sceneRef.current?.debugPick(x, y) ?? null;
    /** 调试：停用后处理 pass（二分切档掉帧用），例：`__piRhinePasses(['bokeh'])`。 */
    (window as unknown as { __piRhinePasses?: (disable: string[]) => void }).__piRhinePasses = (disable) =>
      sceneRef.current?.debugPasses(disable);
    (window as unknown as { __piRhineResetCost?: () => void }).__piRhineResetCost = () =>
      sceneRef.current?.debugResetCost();
    (window as unknown as { __piRhineLevel?: (level: string) => void }).__piRhineLevel = (level) =>
      sceneRef.current?.debugLevel(level as 'overview' | 'near' | 'detail');
    /** 调试：一片墙的高度采样（看开场结束有没有跳变）。 */
    (window as unknown as { __piRhineHeights?: () => unknown }).__piRhineHeights = () =>
      sceneRef.current?.debugHeights() ?? null;
    /*
     * 调试入口：不依赖三维点击，直接按"当前焦点那张卡"打开播放页。
     * 用来单独验证「点卡片播的是不是这张卡对应的歌」——刷新后场景不出帧时也能测。
     */
    (window as unknown as { __piRhineShader?: () => unknown }).__piRhineShader = () =>
      sceneRef.current?.debugShader() ?? null;
    (window as unknown as { __piRhineCover?: () => unknown }).__piRhineCover = () =>
      sceneRef.current?.debugCover() ?? null;
    (window as unknown as { __piRhineForceTile?: (u: number, v: number, du: number, dv: number) => void }).__piRhineForceTile = (
      u,
      v,
      du,
      dv,
    ) => sceneRef.current?.debugForceTile(u, v, du, dv);
    (window as unknown as { __piRhineCoverColor?: (hex: string | null) => void }).__piRhineCoverColor = (hex) =>
      sceneRef.current?.debugCoverColor(hex);
    /*
     * **场景就绪后立刻发令预热**（2026-10-22 修复「加载页一直 0%」）。
     *
     * `beginWarmup()` 原来只在 `[active]` 那个 effect 里调用，而那个 effect 排在场景创建
     * **之前**：首次挂载时 `sceneRef.current` 还是 null，调用被 `?.` 静默吞掉，
     * 之后 `active` 不再变化 → `warmRequested` 永远是 false → 计划不建、进度恒为 0。
     * 这里补一处「创建完成即发令」，与 active 那条路径互为兜底。
     */
    if (activeRef.current) scene.beginWarmup();
    return () => {
      scene.dispose();
      sceneRef.current = null;
      delete (window as unknown as { __piRhine?: unknown }).__piRhine;
      delete (window as unknown as { __piRhineAtlas?: unknown }).__piRhineAtlas;
      delete (window as unknown as { __piRhineTiles?: unknown }).__piRhineTiles;
      delete (window as unknown as { __piRhineState?: unknown }).__piRhineState;
      delete (window as unknown as { __piRhinePeak?: unknown }).__piRhinePeak;
      delete (window as unknown as { __piRhineCard?: unknown }).__piRhineCard;
      delete (window as unknown as { __piRhineShader?: unknown }).__piRhineShader;
      delete (window as unknown as { __piRhineCover?: unknown }).__piRhineCover;
      delete (window as unknown as { __piRhineForceTile?: unknown }).__piRhineForceTile;
    };
    // 只建一次：后续的变化都走 setCatalog / setLevel / setTheme（重建等于把相机与封面全丢掉）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 明暗档跟着 `<html data-theme>` 走（与应用其余部分同一套判据）。
   *
   * 用 React state 中转，而不是「构造时读一次 + MutationObserver 里直接调 setTheme」：
   * `data-theme` 是 `App` 的 effect 里写的，而子组件的 effect 比父组件**先**跑 —— 场景构造时
   * 这个属性可能还没写上去。走 state 的话，无论先后，属性一变就会补一次 `setTheme`。
   */
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    const root = document.documentElement;
    const apply = (): void => setDark(root.dataset.theme === 'dark');
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    sceneRef.current?.setTheme(dark);
  }, [dark]);

  /**
   * 把 `catalog` 交给场景，但**只在真变了的时候**。
   *
   * 为什么要有这层签名判断（主人第五轮「进去拖动几下或者点开曲目单就卡死」的根因）：
   * 上面那个 `useMemo` 依赖 `queue` / `queueCards` 两个**每次渲染都可能换身份**的对象，
   * 于是每渲染一次就产出一个新的 `catalog` 对象；而这个 effect 又调 `setCatalog()`，
   * 它内部 `notifyFocus(true)` → `onFocus` → `setFocus(新对象)` → 再渲染 → 又是新 `catalog`……
   * 一旦队列真的非空（点开曲目单 / 点一首歌那一刻）就成了不停的重渲染环，主线程被占满 = 卡死。
   * 签名只取场景真正用到的字段（列键、曲目数、卡片数、标题、首尾卡片键），
   * 一样就不往下传，环自然断掉。
   */
  const catalogSigRef = useRef('');
  useEffect(() => {
    const signature = catalog.columns
      .map((column) => {
        const first = column.cards[0]?.key ?? '';
        const last = column.cards[column.cards.length - 1]?.key ?? '';
        return `${column.key}:${column.count}:${column.cards.length}:${first}|${last}:${column.title}`;
      })
      .join('~');
    if (signature === catalogSigRef.current) return;
    catalogSigRef.current = signature;
    sceneRef.current?.setCatalog(catalog);
  }, [catalog]);

  /**
   * 队列那一路只按「第几首 + 多少首」变化重挂（`queue` 是每渲染一次就可能换身份的对象，
   * 直接进依赖数组会让这一层每帧被 `setLevel` 打一次，把动量与旋转都清掉）。
   */
  const queueKey = queue === null ? 'none' : `${queue.songs.length}:${queue.index}`;
  useEffect(() => {
    sceneRef.current?.setLevel(level, {
      lane: queue === null ? Math.max(0, focusIndex) : 0,
      row: queue === null ? undefined : queue.index + ROW_ORIGIN,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIndex, level, queueKey]);

  useEffect(() => {
    sceneRef.current?.setQuality(quality);
  }, [quality]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (scene === null) return;
    scene.setActive(active);
    if (active) scene.resize();
  }, [active, catalog]);

  /* ---------------------------------------------------------------- 投影 / 统计写回 */

  const applyFrame = useCallback((info: RhineFrameInfo) => {
    /*
     * **预热发令的最终兜底**（2026-10-22 修复「加载页一直 0%」）。
     *
     * `beginWarmup()` 之前只在 effect 里调用，而那些 effect 的执行时机取决于 React 的
     * 依赖变化（`active` 可能不变化、`catalog` 可能因为曲目慢而迟迟不更新），
     * 实测出现过场景在渲染、预热却从未启动的情况（`req=0`，进度恒为 0）。
     * 这里挂在每帧回调上：只要这一层在出帧，就一定发一次令。
     */
    if (!warmIssuedRef.current) {
      warmIssuedRef.current = true;
      sceneRef.current?.beginWarmup();
    }
    for (const plate of info.plates) {
      const element = plateRefs.current.get(plate.key);
      if (element === undefined) continue;
      const x = Math.round(plate.x);
      const y = Math.round(plate.y);
      // DOM 只在真的变了才写：逐帧写 transform 会让样式系统每帧重算这二十几块名牌。
      const stamp = `${x},${y},${plate.visible ? 1 : 0}`;
      if (element.dataset.rhinePlateStamp === stamp) continue;
      element.dataset.rhinePlateStamp = stamp;
      element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      element.style.opacity = plate.visible ? '1' : '0';
      element.style.pointerEvents = plate.visible ? 'auto' : 'none';
    }
    const stats = statsRef.current;
    if (stats !== null && info.fps > 0) {
      stats.dataset.rhineLevel = info.level;
      stats.dataset.rhineDrawn = String(info.drawn);
      stats.dataset.rhineFps = String(Math.round(info.fps));
      // 加载进度探针（只给验证用：能分辨「计划没建」和「计划建了但没准备好」）。
      stats.dataset.rhineWarm = sceneRef.current?.warmDebug() ?? '';
    }
    /*
     * **加载完成判定**：等场景说「开场真的开始了」才撤加载层。
     *
     * 2026-10-22 主人要求：**先有一个加载界面，加载好了再进开场动画**。
     * 所以判据从 `atlasPending() === 0` 换成 `introStarted()` —— 后者包含
     * 「预热队列跑完」这一步，撤层的那一刻正好是动画第一帧。
     */
    if (!bootedRef.current && info.fps > 20 && info.drawn > 0 && sceneRef.current?.introStarted() === true) {
      bootedRef.current = true;
      setBooted(true);
      setLoadProgress(1);
      return;
    }
    // 还没就绪：把真实进度报给加载层（每帧读一次很便宜，只是遍历计划表）。
    if (!bootedRef.current) {
      const next = sceneRef.current?.atlasProgress() ?? 0;
      setLoadProgress((prev) => (Math.abs(next - prev) > 0.01 ? next : prev));
    }
  }, []);

  /**
   * **预热由定时器驱动，不挂在渲染循环上**（2026-10-24）。
   *
   * `requestAnimationFrame` 在窗口被遮挡 / 最小化 / 后台时会被 Chromium 冻结
   * （实测 `frames=0`、`visibilityState='hidden'`，句柄仍然非零），
   * 那时预热一帧都不跑、进度恒为 0，只能等 15 秒兜底 —— 这就是"加载界面停留特别久"的来源。
   * 预热本身不需要出帧，用 16ms 的定时器推进即可（后台定时器节流到 1Hz 也够用）。
   */
  useEffect(() => {
    /*
     * **只看 `active`，不看 `booted`**（2026-10-25）。
     *
     * 载入层的 15 秒兜底只要一触发就会把 `booted` 置真 —— 如果这里跟着它一起停，
     * 预热就永远跑不完（`introReady` 一直是假，画面冻在开场第一帧）。
     * 预热自己会在 `introReady` 之后从 `pumpLoader()` 里返回，不需要这里提前关闸。
     */
    if (!active) return undefined;
    const timer = window.setInterval(() => {
      const scene = sceneRef.current;
      if (scene === null) return;
      scene.pumpLoader();
      /*
       * **撤层判定也放在定时器里**：它原来挂在每帧回调 `applyFrame` 上，
       * 而那个回调由 rAF 驱动 —— 窗口被冻结时永远轮不到，加载层就永久挂着。
       */
      if (scene.introStarted()) {
        bootedRef.current = true;
        setBooted(true);
        setLoadProgress(1);
        return;
      }
      const next = scene.atlasProgress();
      setLoadProgress((prev) => (Math.abs(next - prev) > 0.01 ? next : prev));
    }, 16);
    return () => window.clearInterval(timer);
  }, [active, booted]);

  /**
   * `data-rhine-stats` 交给冒烟读：4Hz 刷新一次就够（探针不靠它做逐帧断言）。
   *
   * 另外把**每列曲目请求的完成数**写进 `data-rhine-warm`：加载停在 0% 时，
   * 需要区分「封面还没开始烘」和「曲目元数据都还没回来」——后者是接口层面的事，
   * 跟图集无关（2026-10-24 推荐歌单卡 0% 的排查就是靠这个数定位的）。
   */
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => {
      const node = statsRef.current;
      const scene = sceneRef.current;
      if (node === null || scene === null) return;
      node.dataset.rhineStats = JSON.stringify(scene.stats());
      /*
       * **状态溯源探针**（2026-10-25 查「进近景会重新预热」）：把三个会各自影响预热签名的值
       * 一起写出来 —— 来源、歌单数、场景里实际的列数、是否激活。哪个先变一眼就能看出来。
       */
      node.dataset.rhineTrace = `${source}|${playlists.length}|${scene.warmDebug().match(/cols=(\d+)/)?.[1] ?? '?'}|${active ? 1 : 0}|${focusedPlaylist?.id ?? '-'}`;
      const loading = loadingRef.current;
      if (loading !== null) {
        const done = wallTrackQueries.filter((query) => query.data !== undefined).length;
        loading.dataset.rhineWarm = `${scene.warmDebug()} q=${done}/${playlists.length}`;
      }
    }, 250);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, playlists.length, wallTrackQueries]);

  /* ---------------------------------------------------------------- 键盘 */

  /**
   * Esc 交给「最上层浮层」那个钩子（`state/ui.ts` 的 `escapeTop`）。
   *
   * 为什么**不**自己挂 `window` 的 keydown：`ShortcutLayer` 的 Esc 挂在 window 捕获阶段、
   * 且它在树的最前面渲染 ⇒ 它的监听永远先跑，后来者怎么 `stopImmediatePropagation` 都追不上。
   * 所以改成「让 `exitCurrentLayer()` 先问我们」（`ShortcutLayer` 里那一行），
   * 我们返回 true 就表示这一下归莱茵层。
   */
  const escapeRef = useRef({ level, onClose, onBack });
  escapeRef.current = { level, onClose, onBack };
  useEffect(() => {
    if (!active) {
      useUi.getState().setEscapeTop(null);
      return undefined;
    }
    useUi.getState().setEscapeTop(() => {
      const ui = useUi.getState();
      // 上面还盖着别的浮层时让给它们（抽屉 / 设置 / 搜索 / 指引）。
      if (ui.settingsOpen || ui.navOpen || ui.searchOpen || ui.guideOpen) return false;
      const current = escapeRef.current;
      /*
       * **Esc 逐级往上退**（2026-10-22 主人：「这个页面点 Esc 不是回到上一级，
       * 而是直接回到歌曲播放页，这是不对的」）。
       *
       *   详情（图 3）→ 歌单选择页（图 2）→ 歌单总览（图 1）→ 退出莱茵风
       *
       * 之前只有"详情→近景"这一级，近景再按就直接 `onClose()` 退出整个皮肤了。
       */
      if (current.level === 'detail') {
        setDrilled(false);
        return true;
      }
      if (current.level === 'near') {
        // 只翻转本层的标记，不动路由 —— 这样相机与选中列都不会重置。
        setBackToWall(true);
        return true;
      }
      current.onClose();
      return true;
    });
    return () => {
      useUi.getState().setEscapeTop(null);
    };
  }, [active]);

  /* ---------------------------------------------------------------- 面板内容 */

  const play = usePlayer((state) => state.play);
  const playlistSongs = tracks.data?.tracks ?? [];
  const queueSongs = queue?.songs ?? [];
  const panelSongs = queue !== null ? queueSongs : playlistSongs;
  const focusedSong = queue !== null ? (queueSongs[queue.index] ?? null) : (playlistSongs[focus?.index ?? 0] ?? null);
  const focusedCard = focus?.card ?? null;
  /** 当前焦点那一列（从台面上找回来，保证与场景里的那一列是同一份数据）。 */
  const focusColumnKey = queue !== null ? 'queue' : focusedPlaylist !== null ? `pl:${focusedPlaylist.id}` : null;
  const column: RhineColumnView | null =
    focusColumnKey === null ? null : (catalog.columns.find((entry) => entry.key === focusColumnKey) ?? null);
  const total = queue !== null ? queueSongs.length : (focusedPlaylist?.trackCount ?? 0);

  /* openPlayer 定义在 playAt 之后（它要调用 playAt）。 */

  const playAt = useCallback(
    (index: number): void => {
      const songs = panelSongs;
      if (songs.length === 0) return;
      void play(songs, index).then(() => onClose());
    },
    [onClose, panelSongs, play],
  );

  /**
   * 打开播放页（2026-10-22）：**点中的那张 CD 盒先"长"满屏幕，然后收起莱茵风、
   * 由应用真正的播放页接管** —— 中间不出现任何自制界面。
   *
   * 同时把**这一首设为当前播放**（主人："点击 cd 盒进入歌曲播放页应该是 cd 盒对应的音乐"），
   * 不然切过去看到的还是上一首。
   */
  const openPlayer = useCallback((cardOverride?: RhineCardView | null) => {
    const card = sceneRef.current?.debugCard() ?? null;
    /*
     * 曲目优先用**事件里带的那张卡**（点 3D 卡片时由场景直接给出），
     * 只有在没有传入时才退回 React 里的 `focus` —— 后者在"点击当帧"可能还是上一张。
     */
    const targetCard = cardOverride ?? focus?.card ?? null;
    setPlayerOrigin(card !== null ? { x: card.x, y: card.y } : null);
    setPlayerOpen(true);
    const cardSong = targetCard?.song ?? null;
    const lists = [panelSongs, playlistSongs];
    /*
     * **优先用卡片自带的曲目对象直接播**（2026-10-22）。
     * 列表里找得到就按列表播（保留队列上下文）；找不到（大歌单分页、列表还没加载到那首）
     * 就用卡片自己的 `song` 播一首 —— 宁可队列只有这一首，也不能播错/不播。
     */
    if (cardSong !== null) {
      let played = false;
      for (const list of lists) {
        const at = list.findIndex((song) => song.id === cardSong.id);
        if (at >= 0) {
          void play(list, at);
          played = true;
          break;
        }
      }
      if (!played) void play([cardSong], 0);
    }
    if (playerTimer.current !== null) window.clearTimeout(playerTimer.current);
    playerTimer.current = window.setTimeout(() => {
      playerTimer.current = null;
      /*
       * **用 View Transitions API 收场**（2026-10-22 主人：“过渡太突兀”）。
       * 之前是直接把莱茵风从 DOM 上摘掉、播放页立刻顶上 —— 一帧之内换了个世界。
       * 现在交给浏览器做前后快照的交叉过渡（缩放 + 淡出），并遵守系统的“减少动态效果”。
       */
      const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
      const reduce = window.matchMedia(PREFERS_REDUCED_MOTION).matches;
      if (reduce || typeof doc.startViewTransition !== 'function') {
        onClose();
        startPlaybackIfIdle(targetCard?.song?.id ?? Number.NaN, lists);
        return;
      }
      doc.startViewTransition(() => {
        onClose();
        startPlaybackIfIdle(targetCard?.song?.id ?? Number.NaN, lists);
      });
    }, PLAYER_FILL_MS);
  }, [focus, onClose, panelSongs, play, playAt, playlistSongs, startPlaybackIfIdle]);

  return (
    <div
      className="pi-rhine"
      data-rhine-layer={level}
      data-rhine-active={active ? 'true' : 'false'}
      data-rhine-source={queue !== null ? 'queue' : source}
      data-rhine-quality={quality}
      data-rhine-focus={focus === null ? '' : `${focus.lane}:${focus.index}`}
    >
      <div className="pi-rhine__stage" ref={hostRef} data-rhine-stage="true" />

      <div className="pi-rhine__plates" data-rhine-plates="true">
        {catalog.columns.map((entry, index) => (
          <button
            key={entry.key}
            type="button"
            className="pi-rhine__plate"
            data-rhine-plate={entry.key}
            data-rhine-plate-index={index + 1}
            data-rhine-plate-count={entry.count}
            ref={(node) => {
              if (node === null) plateRefs.current.delete(entry.key);
              else plateRefs.current.set(entry.key, node);
            }}
            onClick={() => {
              const playlist = playlists[index];
              if (playlist !== undefined) onOpenPlaylist(playlist);
            }}
          >
            <span className="pi-rhine__plate-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="pi-rhine__plate-name">{entry.title}</span>
            <span className="pi-rhine__plate-count">{entry.count} 首</span>
          </button>
        ))}
      </div>

      <aside className="pi-rhine__panel" data-rhine-panel={level}>
        {/*
         * **封面去掉了**（2026-10-25 主人：「图中框选的封面展示不需要，文字排版应该像
         * 第二个图一样居中」）。参考那一屏（图 2）右栏就是纯排版：面包屑 → 编号/格式 →
         * 大标题 → 歌手 → 元信息 → 入口，没有任何图片。封面在左侧阵列里已经有一整面了，
         * 这里再放一张只是把视觉重心从文字上拽走。
         */}
        {level === 'near' ? null : (
          <p className="pi-rhine__kicker" data-rhine-kicker>
            {level === 'overview' ? '全部歌单' : '完整曲目单'}
          </p>
        )}
        {level === 'near' ? (
          /*
           * 参考图的两行抬头（2026-10-22）：
           *   MUSIC ARCHIVE / <歌手>        ← 面包屑
           *   ALBUM 001              FLAC   ← 编号 + 格式，下接一条细横线
           */
          <>
            <p className="pi-rhine__crumb">
              <span>MUSIC ARCHIVE</span>
              <span className="pi-rhine__crumb-sep">/</span>
              <span>{focusedSong !== null ? artistNames(focusedSong) : ''}</span>
            </p>
            <p className="pi-rhine__index">
              <span>{column?.title ?? 'ALBUM'}</span>
              <span>LOCAL</span>
            </p>
          </>
        ) : null}
        <h2 className="pi-rhine__title" data-rhine-focus-title>
          {level === 'overview' ? (column?.title ?? '还没有歌单') : (focusedCard?.title ?? '—')}
        </h2>
        <p className="pi-rhine__artist" data-rhine-focus-subtitle>
          {level === 'overview'
            ? `${catalog.columns.length} 张歌单 · 横向拖动换列，点一列进去`
            : (focusedCard?.subtitle ?? focusedSong?.album?.name ?? '')}
        </p>
        <p className="pi-rhine__meta" data-rhine-focus-meta>
          {level === 'overview'
            ? ''
            : `${column?.title ?? ''} · 第 ${(focus?.index ?? 0) + 1} / ${total} 首${
                focusedSong?.durationMs !== undefined ? ` · ${formatDuration(focusedSong.durationMs)}` : ''
              }`}
        </p>

        {level === 'detail' ? (
          <>
            {/*
             * **详情页排版照参考图**（2026-10-22 主人给的参考：ALBUM 编号 → 大标题 → 歌手
             * → 分隔线 → 两列键值网格 → 底部列表）。之前只有"封面 + 曲目单"，留白和层级都不够。
             * 这里补的就是那条**两列信息网格**；只放能算出来的字段，编不出来的不硬凑。
             */}
            <dl className="pi-rhine__facts" data-rhine-facts>
              <div>
                <dt>ARTIST / 歌手</dt>
                <dd>{panelSongs[0] !== undefined ? artistNames(panelSongs[0]) : '—'}</dd>
              </div>
              <div>
                <dt>ALBUM / 专辑</dt>
                <dd>{focusedSong?.album?.name ?? focusedCard?.subtitle ?? '—'}</dd>
              </div>
              <div>
                <dt>TRACKS / 曲目</dt>
                <dd>{panelSongs.length} 首</dd>
              </div>
              <div>
                <dt>DURATION / 总时长</dt>
                <dd>{formatDuration(panelSongs.reduce((sum, song) => sum + (song.durationMs ?? 0), 0))}</dd>
              </div>
            </dl>
            <div className="pi-rhine__tabs" data-rhine-tabs>
              <span className="pi-rhine__tab is-active">① 歌单</span>
              <span className="pi-rhine__tab">② 专辑介绍</span>
            </div>
            <ol className="pi-rhine__tracks" data-rhine-tracks={panelSongs.length}>
              {panelSongs.map((song, index) => (
                <RhineTrackRow
                  key={`${song.id}-${index}`}
                  index={index}
                  name={song.name}
                  artist={artistNames(song)}
                  duration={formatDuration(song.durationMs)}
                  active={index === (focus?.index ?? -1)}
                  onPlay={playAt}
                  onLocate={(index) => sceneRef.current?.locateRow(index)}
                />
              ))}
              {panelSongs.length === 0 ? <li className="pi-rhine__track-empty">这一列还没有曲目</li> : null}
            </ol>
          </>
        ) : (
          /*
           * 单个通栏「打开歌单」（2026-10-22 主人：两个胶囊合成一个，风格照参考那张
           * —— 整栏描边、左文字、右箭头，不用胶囊）。
           */
          <div className="pi-rhine__actions">
            <button type="button" className="pi-rhine__action" data-rhine-action="detail" onClick={() => setDrilled(true)}>
              <span>打开歌单</span>
              <span className="pi-rhine__action-arrow" aria-hidden="true">↗</span>
            </button>
          </div>
        )}
      </aside>

      {/* 底部提示行整行删掉（2026-10-22 主人：图 3 那串文字提示不需要）。*/}

      {/*
       * **歌曲播放页**（2026-10-22 主人第 2 条）：详情档点那张抽出的大盒子进来，
       * 背景保留三维墙（这层只做半透明遮罩 + 布局），进出都走 CSS 过渡。
       */}
      <div className="pi-rhine__player" data-rhine-player={playerOpen ? 'open' : 'closed'} aria-hidden={playerOpen ? 'false' : 'true'}>
        <div
          className="pi-rhine__player-inner"
          style={
            playerOrigin !== null
              ? ({ '--ox': `${playerOrigin.x}px`, '--oy': `${playerOrigin.y}px` } as CSSProperties)
              : undefined
          }
        >
          <div className="pi-rhine__player-cover">
            {focusedCard?.coverUrl !== undefined ? <img src={focusedCard.coverUrl} alt="" /> : null}
          </div>
          <p className="pi-rhine__player-kicker">{column?.title ?? ''}</p>
          <h2 className="pi-rhine__player-title">{focusedCard?.title ?? '—'}</h2>
          <p className="pi-rhine__player-artist">{focusedSong !== null ? artistNames(focusedSong) : ''}</p>
          <div className="pi-rhine__player-actions">
            <button type="button" className="pi-rhine__player-play" onClick={() => playAt(focus?.index ?? 0)}>
              播放
            </button>
            <button type="button" className="pi-rhine__player-close" onClick={() => setPlayerOpen(false)}>
              返回
            </button>
          </div>
        </div>
      </div>

      {/*
        首次成画之前的加载提示（2026-10-22）。
        进度是**真实检测出来的**（`atlasProgress()` = 已烘焙封面数 / 需要烘焙的封面数），
        不是定时器；只有 15 秒兜底那份是时间。
      */}
      <div
        className="pi-rhine__loading"
        data-rhine-loading={booted ? 'done' : 'waiting'}
        data-rhine-warm=""
        ref={loadingRef}
        aria-hidden={booted ? 'true' : 'false'}
      >
        <span className="pi-rhine__loading-mark" aria-hidden="true" />
        <span className="pi-rhine__loading-text">正在载入档案 {Math.round(loadProgress * 100)}%</span>
        <span className="pi-rhine__loading-bar" aria-hidden="true">
          <span className="pi-rhine__loading-fill" style={{ transform: `scaleX(${loadProgress.toFixed(3)})` }} />
        </span>
      </div>

      {/*
        档位切换器（2026-10-25）：
        · 位置从 `top: 18px` 下移到窗口三键下面 —— 三键面板高 38px（`global.css:189` 的
          `padding: 2px 8px` + 按钮 `height: 34px`），原来那一版正好压在上面。
        · 外观换成「液态玻璃」：一层渐变高光 + 饱和模糊 + 内描边，让它像贴在画面上的
          一块玻璃，而不是一块实色药丸。
        · 选中态不再靠换底色，而是一块**会滑动的指示器**（`.pi-rhine__quality-pill`）
          在四个选项之间平移 —— 四个选项等宽，所以平移量就是 `index * 100%`。
      */}
      <div className="pi-rhine__quality" data-rhine-quality-group="true" data-quality={quality}>
        <span
          className="pi-rhine__quality-pill"
          aria-hidden="true"
          style={{
            transform: `translateX(${Math.max(0, QUALITY_ORDER.indexOf(quality)) * 100}%)`,
          }}
        />
        {QUALITY_ORDER.map((preset) => (
          <button
            key={preset}
            type="button"
            className="pi-rhine__quality-option"
            data-rhine-quality-option={preset}
            data-active={preset === quality ? 'true' : 'false'}
            onClick={() => {
              setQuality(preset);
              persistRhineQuality(preset);
            }}
          >
            {RHINE_QUALITY_LABELS[preset]}
          </button>
        ))}
      </div>

      {/*
        **播放页那条进度条，原样复用**（2026-10-25）。不是克隆一份：`HomeBar` 就是
        `HomePage` 自己用的那个组件 —— 同一个 DOM、同一套 `.pi-home__bar` 样式、
        同一套「拖的时候只挪填充、松手才 seek」的交互。它自带
        `position: absolute; left: 50%; bottom: 18px`，所以挂在这里位置天然就对。
        三种档位都显示（主人：「在莱茵风的界面保持存在」）。

        外面这层 `display: contents` 不参与布局（药丸的绝对定位仍相对 `.pi-rhine`），
        只借它接一个点击：**点药丸的空白/时间区回播放页**（2026-10-25 主人：
        「莱茵风里点击进度条部件可以回到歌曲播放页」）。
        轨道和按钮要排除 —— 前者是 seek、后者是播放/上下首/音量，点它们不该跳页。
      */}
      <div
        className="pi-rhine__barwrap"
        onClick={(event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (target.closest('.pi-home__track') !== null) return;
          if (target.closest('button') !== null) return;
          onClose();
        }}
      >
        <HomeBar song={focusedSong ?? playingSong ?? EMPTY_BAR_SONG} />
      </div>

      <div className="pi-rhine__probe" ref={statsRef} data-rhine-stats="" aria-hidden="true" />
    </div>
  );
}

/**
 * 曲目单的一行，`memo` 过。
 *
 * 为什么要拆出来（主人第四轮：「拖动时画面卡顿」）：这张歌单有 334 首，右栏把所有行都渲染成
 * DOM；而滚轮/拖动换曲时 `focus.index` 每变一格就整表重渲染一次 —— 一次几百行 × 每秒十几次，
 * 主线程直接被吃掉。拆成 `memo` 之后，换曲只重渲染「原来那一行 + 新那一行」两行，
 * 其余 332 行原样复用（`index/name/artist/duration/active/onPlay` 都是原始值或稳定引用）。
 */
const RhineTrackRow = memo(function RhineTrackRow({
  index,
  name,
  artist,
  duration,
  active,
  onPlay,
  onLocate,
}: {
  index: number;
  name: string;
  artist: string;
  duration: string;
  active: boolean;
  onPlay: (index: number) => void;
  onLocate: (index: number) => void;
}) {
  return (
    <li>
      <div
        className="pi-rhine__track"
        data-rhine-track={index}
        data-rhine-track-active={active ? 'true' : 'false'}
      >
        <span className="pi-rhine__track-index">{String(index + 1).padStart(2, '0')}</span>
        {/*
         * 曲目名单独一颗按钮：点它 = **跳到对应的 CD 盒**（2026-10-22 主人第 3 条）。
         * 行的其余部分仍然是播放，两种意图分开。
         */}
        <button
          type="button"
          className="pi-rhine__track-name"
          data-rhine-track-locate={index}
          onClick={() => onLocate(index)}
        >
          {name}
        </button>
        <span className="pi-rhine__track-artist">{artist}</span>
        <span className="pi-rhine__track-time">{duration}</span>
        <button
          type="button"
          className="pi-rhine__track-play"
          aria-label={`播放 ${name}`}
          onClick={() => onPlay(index)}
        >
          ▸
        </button>
      </div>
    </li>
  );
});
