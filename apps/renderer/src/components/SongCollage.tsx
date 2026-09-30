/**
 * 歌曲拼贴墙（用户第十四轮第 2 条：复刻 folia-major 的 Lattice 拼贴「形似」；
 * 第十五轮第 1 条：3D 俯仰、块内重排、点击放大成正方形 + 镜头跟随、整屏去白边）。
 *
 * 观感与结构对齐 `chthollyphile/folia-major` 的 `src/components/app/lattice/`（Lattice 海报墙）：
 * 一屏无间隙的封面方片拼贴，**同一块里卡片宽高不同**（2×2 / 3×3 / 6×3 混排，不是等大方格），
 * 每块左上角一个序号徽章，靠视口中心的那一块**放大量到 6×6 格（808px 正方形）**并浮出歌名 + 歌手；
 * 拖空白处平移观察不同的歌，点某一格就把它放大、同时把镜头缓动过去。
 *
 * 与 folia 的关系只说清边界（**不移植它的框架/依赖**，仓库里也没有 framer-motion）：
 *   - 布局算法、节距、相机档位、入场波数值、材质写法都借它的**结论**，
 *     实现是自己写的（几何在 `./song-collage-geometry.ts`，那部分能脱开 DOM 单测）；
 *   - 卡片一律直角（`border-radius: 0`）、序号徽章**不用 `backdrop-filter`**
 *     （folia 注释：每张卡的模糊会把海报提升成独立合成层，是那面墙最大的 GPU 开销）；
 *   - **不给卡片加 `will-change`**（folia 注释：分数缩放下会出现 1px 未遮罩接缝）；
 *   - 封面只 `object-fit: cover`，不固定宽高比；封面按「卡片屏幕尺寸 × DPR」取图（folia 同思路）；
 *   - **块内重排**（第十五轮第 1 条）：放大块固定 6×6 并锚在离它最近的块角，同块其余 11 张被
 *     挤进「6×8 + 6×2」两条带里精确铺满（算法在 `song-collage-geometry.ts` 的 `blockLayoutOf`，
 *     不是 folia 的 `blockReflows.ts` 预计算表）；
 *   - **3D 俯仰**（第十五轮第 1 条）：`perspective: 1400px` + `rotateX(3.4°) rotateY(−2.6°)`，
 *     绕**视口中心**转（数值理由见 `song-collage-geometry.ts` 顶部说明④与 `COLLAGE_*` 常量）。
 *
 * 「拖拽」与「点击」的分工（第十五轮第 1 条，用户原话：拼贴大小在拖拽过程中不变，
 * 只有点击后拼贴才会变大成正方形）：
 *   - 拖动只改相机的 `translate3d`：**所有格子的尺寸、以及「哪一格是放大块」都不变**；
 *   - 点击某一格（位移 < 8px 才算点）才把放大块换成它：旧的缩回原形、同块邻居让位，
 *     新格长成 808px 正方形，镜头再用 `COLLAGE_FOLLOW_MS` 缓动过去（不是瞬移）。
 *   注意「静置时也必须有一个放大块」是**冒烟探针的硬要求**（见下），所以首帧仍然按
 *   「离视口中心最近的槽位」自动选一格放大；它只是在拖动期间不再改选。
 *
 * 数据契约（供 `apps/desktop` 的冒烟探针用，别改）：
 *   - 根节点            `data-song-collage` + `data-song-collage-count` + `data-collage-camera="x:y"`
 *   - 每块              `data-song-collage-item={song.id}` / `data-collage-cell` / `data-queue-index` / `data-playing`
 *                       / `data-collage-exiting` / `data-collage-hit`（后两个见下面的 (b) 与 (e)）
 *   - 放大中的那一格     `data-center="true"`（= 第十五轮第 1 条的「被点开放大的格」），
 *                      同时发 `data-collage-expanded="true"|"false"`
 *   - 被挤小的邻居       `data-collage-reflow="true"|"false"`（同块内、且自己不是放大块）
 *   - 空态              `.pi-placeholder`
 * 拖动一律 pointerdown/move/up + 松手惯性；`handlePointerDown` 只查 `button`/`isPrimary`，
 * `handlePointerMove` 不查 `buttons`（合成指针事件照样能拖）。
 *
 * 第十六轮第 4 条（用户 m00001）的对外 API 与新增契约：
 *
 * 【(a) 悬停互动】纯 CSS（`styles/song-collage.css` 的 `.pi-collage__item:hover` 一组）：
 *   封面 `scale(1.055)`、一条斜向扫光、一圈主色描边 + 序号/文字上浮。
 *   为什么缩放挂在**内层**（`.pi-collage__cover` / `.pi-collage__copy` / `.pi-collage__badge`）
 *   而不是格子上：格子的定位本身就靠入场动画 `both` 之后残留的 `translate(-50%,-50%)`，
 *   动画填充态的优先级高于内联/悬停样式，改格子自己的 transform 会被动画吃掉。
 *   只动 transform/filter/opacity，且同一时刻只有一张卡吃到，成本与 folia 的 hover 同级。
 *
 * 【(b) 点「正在播放 + 已放大」的那一格 → 进播放页】
 *   - 新 prop `onEnterPlaying?: (song: Song) => void`：**只有**当
 *     `playingId === song.id && item.expanded`（既在播、又是当前放大聚焦的那一格）时才回调；
 *     这种情况下**不再**重复 `focusSlot` / `play()`（它已经在中心、也已经在播）。
 *     其它格子照旧：先 `focusSlot(item.ref)` 换放大块 + 镜头缓动，再 `onSelect` + `play`。
 *   - 用户 m00736 第 6 条：宿主**没给** `onEnterPlaying`（歌单详情浮层就是这种）时，这一态
 *     不退回「再播一遍」的旧语义，而是由组件自己走完「进播放页」：照样先打退场钩子演完放大，
 *     `COLLAGE_FILL_MS` 之后再 `closePlaylist()` + `closeSongs()` + `navigate('home')`
 *     —— 与 `BottomBar`（点药丸回播放页）/ `MinePage.enterPlaying` 同一个口径。
 *   - 触发时同时打上两个钩子，并且**「放大填满屏幕」的视觉由组件自己演完**：
 *       · 那一格  `data-collage-exiting="true"` + class `.pi-collage__item--exiting`
 *         （该 class 会 `animation: none` + `transition: transform COLLAGE_FILL_MS` + `z-index: 60`）；
 *       · 根节点  `data-collage-exiting="true"`（整面墙都能选中「正在退场」这一态）。
 *     `exitingKey` 落下的下一帧，组件读那一格的 `getBoundingClientRect()`，用
 *     `collageCellExitTransform(rect, {width: innerWidth, height: innerHeight}, parentScale)`
 *     算出目标 transform（`parentScale` 取根节点 `data-collage-scale`），写进那一格自己的
 *     内联 `style.transform` / `style.transformOrigin`，于是那条 `transition: transform`
 *     真的从原位播到「铺满整个视口」。**宿主只需要在 `COLLAGE_FILL_MS`（480ms）之后切播放页，
 *     不需要自己写任何 DOM**；没给回调的宿主（歌单详情浮层）连那 480ms 的定时都不用写，
 *     组件自己收尾。
 *   - 同样的两个纯函数也导出给宿主备用（`song-collage-geometry.ts`）：
 *       · 克隆/覆盖层：`viewportFillTransform(rect, viewport)`；
 *       · 直接写回某一格：`collageCellExitTransform(rect, viewport, geometry.scale)`。
 *   - 再次 `pointerdown`（用户开始新的拖拽/点击）会清掉这一态，并把那一格的内联 transform 一并
 *     撤掉（**瞬间回位、不补收缩动画** —— 用户的手已经按在墙上了）；组件卸载（宿主切去播放页）
 *     同样会撤掉，所以哪怕宿主把拼贴留在下面也不会留一格「永远铺满」的残影。
 *
 * 【(c) 一直拖到把歌单看完】新 props `hasMore?: boolean` + `onNeedMore?: () => void`：
 *   镜头贴到**已建内容的边**（`isNearContentEdge`，提前 0.75 个块）且 `hasMore` 为真时回调
 *   `onNeedMore()`；同一批歌曲只发一次（`total` 变了才会再发），所以调用方即使忽略也不会刷屏。
 *   调用方把新歌 append 进 `songs` 之后，新格子由 `geometryFor` 直接给出位置，无需额外 API。
 *   新增探针属性（都在根节点上）：
 *       · `data-collage-cells`    = 世界里建出来的槽位总数（`builtCellCountOf`）
 *       · `data-collage-songs`    = 已经在墙上的歌曲数（`songs.length`）
 *       · `data-collage-rendered` = 当前真正在 DOM 里的格子数（视口剔除之后）
 *       · `data-collage-has-more` = `hasMore ? 'true' : 'false'`
 *       · `data-collage-scale`    = 世界层定档缩放（宿主算退场 transform 时要除掉它）
 *       · `data-collage-fill-ms`  = `COLLAGE_FILL_MS`（退场放大时长，宿主据此定时切播放页）
 *
 * 【(d) 底栏常驻 + 点底栏把正在播放的那一格居中】`forwardRef` + `useImperativeHandle`：
 *       `export interface SongCollageHandle {
 *          focusPlaying(): boolean
 *          playingSlot(): CollageSlotRef | null
 *          focusSong(keyword: string): { id: number; index: number } | null
 *        }`
 *   - `focusPlaying()`：找到正在播放那首歌的槽位（`slotRefOfQueueIndex`，取第一遍座位），
 *     把它设为放大块并让镜头缓动过去；**即使它已经在放大状态也会重新居中**
 *     （用户拖远了以后再点底栏，走的必须是这一条，`focusSlot` 的「同一格就不动」在这里不够用）。
 *     没有正在播放的歌 / 那首歌不在墙上时返回 false。
 *   - `playingSlot()`：只查询不改动，返回当前目标槽位或 null。
 *   宿主用法：`const collageRef = useRef<SongCollageHandle>(null); <SongCollage ref={collageRef} … />`，
 *   底栏点击时 `collageRef.current?.focusPlaying()`。组件自身**不卸载**任何外部节点，
 *   底栏（z 8）始终在拼贴（z 0，`isolation: isolate` 自成层叠上下文）之上，常驻由宿主决定。
 *
 * 【(e) 父任务补充：按关键字定位到某一格（拼贴页滚轮向下 → 打开搜索 → 输入关键字）】
 *   `focusSong(keyword)`：`trim()` + 忽略大小写 + **子串包含**，按 歌名 → 专辑名 → 任意歌手名
 *   的顺序、在**已加载**的 `songs` 里取队列顺序的第一个命中；命中就把它设为放大块
 *   （`data-collage-expanded`）并用与 `focusPlaying()` **同一条**相机缓动居中（同样不做早退），
 *   返回 `{ id, index }`（`index` = 队列下标，宿主拿它在列表里定位/高亮「那一首」）。
 *   同时在命中那一格打：
 *       · `data-collage-hit="true"` + class `.pi-collage__item--hit`（描边脉冲，视觉上指出「就是它」）；
 *       其余格子一律渲染 `data-collage-hit="false"` —— 所以「换一个新的命中」天然先清掉上一次。
 *   没命中（含空关键字）返回 `null` 且**不改动任何状态**。
 *   ⚠️ 本组件**不绑定 `wheel`**，也不对滚轮 `preventDefault()`：拼贴页「滚轮向下开搜索」是宿主的
 *      手势，组件只提供 `focusSong` 帮宿主定位。（键盘方向键 / Enter 那两个 `preventDefault` 不算。）
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { Song } from '@pi/shared';
import { coverAt } from '../lib/cover';
import { artistNames } from '../lib/format';
import { usePlayer } from '../state/player';
import { useUi } from '../state/ui';
import {
  builtCellCountOf,
  cameraScaleFor,
  cameraToCenterOn,
  centeredCamera,
  centerSlotOf,
  clampCamera,
  collageCellExitTransform,
  COLLAGE_FILL_MS,
  COLLAGE_FOLLOW_MS,
  COLLAGE_PERSPECTIVE_PX,
  COLLAGE_PITCH,
  COLLAGE_PITCH_DEG,
  COLLAGE_YAW_DEG,
  ENTRANCE_LIFT,
  expandedCenterOf,
  geometryFor,
  isNearContentEdge,
  listVisibleSlots,
  NEAR_EDGE_MARGIN_RATIO,
  prerollFor,
  prerollScreenOf,
  prerollWorldOf,
  sameSlot,
  slotKey,
  slotRefOfQueueIndex,
  type CollageCamera,
  type CollageGeometry,
  type CollageInstance,
  type CollageSlotRef,
  type CollageViewport,
} from './song-collage-geometry';
import '../styles/song-collage.css';

export interface SongCollageProps {
  songs: readonly Song[];
  onSelect: (song: Song) => void;
  /** 点了不发播放（只选中）。默认发播放，对齐 SongCards。 */
  disablePlay?: boolean;
  /**
   * 第十六轮第 4 条(b)：点击「**正在播放**且**已放大聚焦**」的那一格时回调（宿主据此进播放页）。
   * 只有这两个条件同时成立才会走它；别的格子照旧「换放大块 + 播放」。
   * 给了这个回调，就意味着宿主负责「那一格长大填满屏幕」的退场动画（钩子见组件头注释）。
   */
  onEnterPlaying?: (song: Song) => void;
  /** 第十六轮第 4 条(c)：队列里还有没上墙的歌（配合 `onNeedMore` 用）。 */
  hasMore?: boolean;
  /**
   * 第十六轮第 4 条(c)：镜头贴到已建内容的边、而 `hasMore` 仍为真时回调一次
   * （同一批歌曲只发一次，append 之后 `total` 变了才会再发）。
   */
  onNeedMore?: () => void;
  /**
   * 第十八轮第 6 条（用户 m01482：「歌单页的队列拼贴可以**实时继续加载**新的歌曲进入，
   * 而不是像现在只有有限的几首组成的大小」）。
   *
   * `true` = 不等镜头贴到内容边，只要 `hasMore` 还成立、且上一批已经上墙，就继续要下一页
   * （仍然受 `NEED_MORE_COOLDOWN_MS` 节流、同一批歌仍然只发一次），于是这面墙会自己在
   * 后台一批批长大，直到宿主说没有下一页。默认 `false` 保持第十六轮第 4 条(c) 的老手感。
   */
  autoMore?: boolean;
}

/**
 * 第十六轮第 4 条(d)：`forwardRef` 暴露的命令式接口。
 * 宿主拿它给常驻底栏用：`collageRef.current?.focusPlaying()`。
 */
export interface SongCollageHandle {
  /**
   * 把镜头缓动到「正在播放」那一格并把它放大聚焦（**已经在放大状态也会重新居中**）。
   * 返回 false = 没有正在播放的歌，或者那首歌不在当前墙上的队列里。
   */
  focusPlaying: () => boolean;
  /** 只查询不改动：正在播放那首歌的目标槽位（没有就是 null）。 */
  playingSlot: () => CollageSlotRef | null;
  /**
   * 按关键字定位到**已加载**歌曲里第一个命中的那一格（歌名 / 专辑名 / 任意歌手名，
   * `trim()` + 忽略大小写 + **子串包含**，按队列顺序取首个命中）。
   * 命中：设为放大块（`data-collage-expanded`）+ 走与 `focusPlaying()` **同一条**相机缓动居中
   * （同样不做「同一格就早退」，已经在放大也会重新居中），并在那一格打
   * `data-collage-hit="true"`（其余格子渲染成 `"false"`，等于先清掉上一次），返回 `{ id, index }`。
   * 没命中（含空关键字）：返回 `null`，**不改动任何状态**。
   */
  focusSong: (keyword: string) => { id: number; index: number } | null;
}

/** 拖拽判定阈值：低于它算「点」，高于它才算「拖」（folia 用 7px，这里留宽一点给手抖）。 */
const DRAG_TOLERANCE = 8;
/** 惯性：速度上限、低于这个速度直接停、每帧衰减系数（~60fps 下 0.9 → 约 0.35s 滑完）。 */
const MAX_FLING = 2600;
const MIN_FLING = 60;
const FLING_DECAY = 0.9;
/** 松手前超过这么久没有新的 move 采样，就不算「甩」（避免松手停住后又飞出去）。 */
const FLING_STALE_MS = 90;
/** 首帧落定后再开尺寸过渡：否则中心块会从普通尺寸「长」出来，被冒烟探针量成没放大。 */
const SETTLE_MS = 140;
/**
 * 第十六轮第 4 条(c)：`onNeedMore` 的最小间隔。拖动/惯性每一帧都会判一次「贴到边了吗」，
 * 同一批歌本来只会发一次，这道闸门是防「刚 append 完还没渲染完又发一次」的抖动。
 */
const NEED_MORE_COOLDOWN_MS = 400;
/**
 * 第十八轮第 6 条：宿主那一页请求**失败**时（网易云 405「操作频繁」这类），`songs.length` 不会变，
 * 「同一批歌只发一次」的记账就再也不解禁 —— 墙永远卡在这一批上，看起来就是「加载不动了」。
 * 所以这条记账是**有期限**的：过了这么久还没长出新歌，就允许为同一批再问一次（宿主侧有自己的
 * 重试/退避，组件只负责别把话咽回去）。
 */
const NEED_MORE_RETRY_MS = 4000;
/** 退避的上限：同一批歌连着失败时最多拉到这么长再问一次（别把「操作频繁」越敲越频繁）。 */
const NEED_MORE_RETRY_MAX_MS = 32_000;

/**
 * 第十六轮第 4 条(d)：`forwardRef` 包一层只是为了把 `SongCollageHandle` 交出去
 * （`ref` 只在 `useImperativeHandle` 里读一次）。组件自己的状态/手势/render 全部照旧。
 */
export const SongCollage = forwardRef<SongCollageHandle, SongCollageProps>(function SongCollage(
  { songs, onSelect, disablePlay, onEnterPlaying, hasMore, onNeedMore, autoMore }: SongCollageProps,
  ref,
): ReactNode {
  const play = usePlayer((s) => s.play);
  const playingId = usePlayer((s) => s.currentSong?.id);
  /**
   * 用户 m00736 第 6 条：宿主没给 `onEnterPlaying`（歌单详情浮层就是这种）时，
   * 组件自己把「进播放页」走完 —— 和 `BottomBar`（点药丸回播放页）同一口径：
   * 收掉歌单/歌手/专辑浮层，再把导航拨回 `home`（歌曲播放页）。
   */
  const navigate = useUi((s) => s.navigate);
  const closePlaylist = useUi((s) => s.closePlaylist);
  const closeSongs = useUi((s) => s.closeSongs);
  /** 上面那条「动画放完再切页」的定时器；同一时间只允许挂一个，卸载时清掉。 */
  const enterTimerRef = useRef(0);

  /**
   * 用户 m00736 第 6 条：退场放大（放大块长到铺满屏幕）演完之后，把界面交回歌曲播放页。
   * 延时用几何层的 `COLLAGE_FILL_MS`，与 `.pi-collage__item--exiting` 那条 transform 过渡同长，
   * 也与「我的喜欢」宿主自己的 `MinePage.enterPlaying` 一致（都是动画放完才切页，不做额外淡出）。
   * 退场期间用户又点一下 → 这里直接忽略，别排两个定时器。
   */
  const enterPlayer = useCallback((): void => {
    if (enterTimerRef.current !== 0) return;
    enterTimerRef.current = window.setTimeout(() => {
      enterTimerRef.current = 0;
      closePlaylist();
      closeSongs();
      navigate('home');
    }, COLLAGE_FILL_MS);
  }, [closePlaylist, closeSongs, navigate]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);

  const [viewport, setViewport] = useState<CollageViewport>({ width: 0, height: 0 });
  const [camera, setCamera] = useState<CollageCamera>({ x: 0, y: 0 });
  /**
   * 当前被放大的那一格（6×6 = 808px 的正方形）。`null` = 还没算过（首帧/换尺寸后重新算）。
   * 第十五轮第 1 条之后它的语义是「被点开放大的那一格」：拖动期间只有它不变，
   * 点击另一格才换人（同时镜头缓动过去）。
   */
  const [activeSlot, setActiveSlot] = useState<CollageSlotRef | null>(null);
  /** 入场波纹的起点（视口左上角的世界坐标）。首帧冻结，之后平移不再改它。 */
  const [waveOrigin, setWaveOrigin] = useState<{ x: number; y: number } | null>(null);
  const [settled, setSettled] = useState(false);
  /**
   * 第十六轮第 4 条(b)：刚被点「进播放页」的那一格（`item.key`），宿主据此做放大退场动画。
   * 只在这一态存在的期间为真；用户下一次 pointerdown 就清掉（详见头部契约）。
   */
  const [exitingKey, setExitingKey] = useState<string | null>(null);
  /**
   * 父任务补充（第 6 条后半段：滚轮向下 → 搜索 → 按关键字定位）：`focusSong` 命中的那一格
   * （`item.key`）。用 state 而不是命令式写 DOM —— 命中的那格此刻可能正被视口剔除，
   * 等镜头缓动过去它才被渲染出来，那时渲染期就能带上 `data-collage-hit="true"`。
   * 所有格子都渲染 `data-collage-hit`，所以「换一个新的命中」天然先把上一次的置回 false。
   */
  const [hitKey, setHitKey] = useState<string | null>(null);

  /**
   * 第十六轮第 4 条(c)(d)：几份「最新值」在渲染期直接写进 ref（和下面 `viewportRef/geometryRef`
   * 同一套写法）。命令式接口与增量加载判据因此不必跟着 `songs` / 播放状态重建，
   * `useImperativeHandle` 的依赖也就稳定了。
   */
  const songsRef = useRef(songs);
  const playingIdRef = useRef(playingId);
  const hasMoreRef = useRef(hasMore);
  const onNeedMoreRef = useRef(onNeedMore);
  /** 第十八轮第 6 条：是否「不贴边也继续要下一页」。 */
  const autoMoreRef = useRef(autoMore);
  onNeedMoreRef.current = onNeedMore;
  autoMoreRef.current = autoMore;
  songsRef.current = songs;
  playingIdRef.current = playingId;
  hasMoreRef.current = hasMore;
  onNeedMoreRef.current = onNeedMore;
  /** 增量加载：上一次为哪一批歌发过 `onNeedMore` + 发车时间 + 这一批已试过几次（退避用）。 */
  const needMoreRef = useRef<{ total: number; at: number; tries: number }>({ total: -1, at: 0, tries: 0 });
  /** 上面那条记账到点后的自检定时器（延迟触发，所以要一份「最新实现」的 ref）。 */
  const needMoreTimerRef = useRef<number | null>(null);
  const maybeRequestMoreRef = useRef<(cam: CollageCamera) => void>(() => {});

  // 相机与手势都不进 React state：拖动期间直接写 DOM，松手才把结果交回 state。
  const cameraRef = useRef<CollageCamera>(camera);
  const activeSlotRef = useRef<CollageSlotRef | null>(null);
  const paintedSlotRef = useRef<CollageSlotRef | null>(null);
  const viewportRef = useRef<CollageViewport>(viewport);
  const geometryRef = useRef<CollageGeometry>(geometryFor(viewport, songs.length, 0.76));
  /**
   * 用户 m00001 第 3 条(B)：四个方向对称要用的两份「最新值」——
   * `prerollScreenRef` = 相机可以越过世界左上角多少屏幕像素（`clampCamera` 用），
   * `prerollWorldRef` = 同一段路的**世界坐标**口径（`isNearContentEdge` 的 padX/padY 用这个，
   * 不能拿「块数 × 块尺寸」凑，那个值向上取过整、比相机真能走到的更远，纵向会判不出贴边）。
   * 和 `viewportRef`/`geometryRef` 同一套写法：渲染期直接写，命令式回调用的时候不必进依赖。
   */
  const prerollScreenRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const prerollWorldRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const seededRef = useRef(false);
  const gestureRef = useRef<{
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    fromX: number;
    fromY: number;
    lastX: number;
    lastY: number;
    lastTime: number;
    vx: number;
    vy: number;
    moved: boolean;
  } | null>(null);
  /** 刚拖完的那次 click 要吞掉，别顺手播了手指底下那首歌（也别顺手把它放大）。 */
  const suppressClickRef = useRef(false);
  const flingRef = useRef(0);
  /** 点开某一格后的镜头缓动 rAF id；0 = 没在跑。 */
  const followRef = useRef(0);

  const total = songs.length;
  // 首帧还没量到宽度时按桌面档位猜一个，免得世界先按 0.52 铺一遍再跳。
  const scale = useMemo(() => cameraScaleFor(viewport.width > 0 ? viewport.width : 1280), [viewport.width]);
  const geometry = useMemo(() => geometryFor(viewport, total, scale), [viewport, total, scale]);
  /**
   * 用户 m00001 第 3 条(B)：派生出「上 / 左的起手补片」。
   * 两份都只跟视口与几何走（见几何层 `prerollFor` / `prerollScreenOf` 的注释），
   * 所以每加载一页、世界一长，它们就自动跟着长：向上 / 向左能拖的距离永远不会比向右 / 向下短。
   */
  const preroll = useMemo(() => prerollFor(viewport, geometry), [geometry, viewport]);
  const prerollScreen = useMemo(() => prerollScreenOf(viewport, geometry), [geometry, viewport]);
  const prerollWorld = useMemo(() => prerollWorldOf(viewport, geometry), [geometry, viewport]);

  viewportRef.current = viewport;
  geometryRef.current = geometry;
  prerollScreenRef.current = prerollScreen;
  prerollWorldRef.current = prerollWorld;

  /** 相机（平移 + 定档缩放）就是这一个 transform，直接写 style，不进 React。 */
  const paintCamera = useCallback((cam: CollageCamera): void => {
    const world = worldRef.current;
    if (world !== null) {
      world.style.transform = `translate3d(${cam.x}px, ${cam.y}px, 0) scale(${geometryRef.current.scale})`;
    }
    // 这个属性是给冒烟探针/调试看的：拖动与镜头缓动期间也要跟着走（所以在这里写，不是在 JSX 里）。
    const root = rootRef.current;
    if (root !== null) root.dataset.collageCamera = `${Math.round(cam.x)}:${Math.round(cam.y)}`;
  }, []);

  /**
   * 把「哪一格是放大块」直接写到 DOM 上（改 `data-center` / class）。
   * 拖动期间不再换人（第十五轮第 1 条），所以这里现在只负责「补齐」——真正的换人由点击触发、
   * 走 React 的 `setActiveSlot`。
   */
  const paintActive = useCallback((next: CollageSlotRef | null): void => {
    const world = worldRef.current;
    if (world === null) return;
    const previous = paintedSlotRef.current;
    if (previous && !sameSlot(previous, next)) {
      const old = world.querySelector<HTMLElement>(`[data-collage-cell="${slotKey(previous)}"]`);
      if (old) {
        old.dataset.center = 'false';
        old.dataset.collageExpanded = 'false';
        old.classList.remove('pi-collage__item--center');
      }
    }
    if (next) {
      const el = world.querySelector<HTMLElement>(`[data-collage-cell="${slotKey(next)}"]`);
      if (el) {
        el.dataset.center = 'true';
        el.dataset.collageExpanded = 'true';
        el.classList.add('pi-collage__item--center');
      }
    }
    paintedSlotRef.current = next;
    activeSlotRef.current = next;
  }, []);

  /**
   * 第十六轮第 4 条(c)：镜头贴到已建内容的边、而 `hasMore` 仍为真 → 请宿主加载下一批。
   * 三道闸门：没有回调 / 没有更多就什么都不做；**同一批歌在 `NEED_MORE_RETRY_MS` 内只发一次**
   * （第十八轮第 6 条：那一批要是没回来，到点就再问一次，否则一页失败就永远卡住）；
   * 两次之间至少隔 `NEED_MORE_COOLDOWN_MS`。发出去的只是一次纯通知，组件不缓存结果，
   * 新歌 append 进 `songs` 之后由 `geometryFor` 直接给新格子算位置。
   */
  const maybeRequestMore = useCallback((cam: CollageCamera): void => {
    const request = onNeedMoreRef.current;
    if (!hasMoreRef.current || request === undefined) return;
    const totalNow = songsRef.current.length;
    if (totalNow <= 0) return;
    const now = performance.now();
    if (needMoreRef.current.total === totalNow && now - needMoreRef.current.at < NEED_MORE_RETRY_MS) return;
    // 第十八轮第 6 条：`autoMore` 的宿主不等贴边（一批上墙就接着要下一批）；
    // 其余宿主照旧只有「镜头贴到已建内容的边」才要。
    // 用户 m00001 第 3 条(B)：把上 / 左的补片宽度一起传进去，于是向上 / 向左拖到补片尽头
    // 和向右 / 向下拖到内容尽头一样会去要下一页（四个方向对称）。
    // 注意口径：这里必须是**世界坐标**的补片宽/高（见 `prerollWorldOf` 的注释），
    // 用「块数 × 块尺寸」会偏大，纵向就永远判不出贴边。
    const padX = prerollWorldRef.current.x;
    const padY = prerollWorldRef.current.y;
    if (
      autoMoreRef.current !== true &&
      !isNearContentEdge(
        cam,
        viewportRef.current,
        geometryRef.current,
        totalNow,
        NEAR_EDGE_MARGIN_RATIO,
        padX,
        padY,
      )
    ) {
      return;
    }
    if (now - needMoreRef.current.at < NEED_MORE_COOLDOWN_MS) return;
    const sameBatch = needMoreRef.current.total === totalNow;
    /*
     * 同一批歌按**退避**重试：第一次 4s，之后 8s / 16s / 32s 封顶（见文件头两条常量的注释）。
     * 换了一批（`total` 变了）就重新从 4s 起算。
     */
    const wait = sameBatch
      ? Math.min(NEED_MORE_RETRY_MS * 2 ** Math.min(needMoreRef.current.tries, 3), NEED_MORE_RETRY_MAX_MS)
      : 0;
    if (sameBatch && now - needMoreRef.current.at < wait) return;
    const tries = sameBatch ? needMoreRef.current.tries + 1 : 0;
    needMoreRef.current = { total: totalNow, at: now, tries };
    request();
    /*
     * 到点自检一遍：这一批还没长出来（那一页失败/还在路上）就再问一次。定时器只留一个，
     * 而且它回头走的还是这道闸门（`needMoreRef` 记账挡着），不会变成热循环。
     * 退避同时是对接口的礼貌：网易云对「操作频繁」就是这么回的。
     */
    const nextWait = Math.min(NEED_MORE_RETRY_MS * 2 ** Math.min(tries, 3), NEED_MORE_RETRY_MAX_MS);
    if (needMoreTimerRef.current !== null) window.clearTimeout(needMoreTimerRef.current);
    needMoreTimerRef.current = window.setTimeout(() => {
      needMoreTimerRef.current = null;
      maybeRequestMoreRef.current(cameraRef.current);
    }, nextWait + 120);
  }, []);
  maybeRequestMoreRef.current = maybeRequestMore;
  /** 卸载时把「再问一次」的定时器收掉，别在组件没了之后还去敲宿主。 */
  useEffect(
    () => () => {
      if (needMoreTimerRef.current !== null) window.clearTimeout(needMoreTimerRef.current);
    },
    [],
  );

  /**
   * 拖动只动相机。**不再**在这里重算「哪一格该被放大」——
   * 用户第十五轮第 1 条要求：拖拽（平移/惯性）过程中拼贴尺寸不变，放大块只有点击才换人。
   * 第十六轮第 4 条(c) 在这里顺手判一次「贴到内容边了吗」（拖到边要能继续加载）。
   */
  const updateCamera = useCallback(
    (cam: CollageCamera, release: boolean): void => {
      // 用户 m00001 第 3 条(B)：夹相机时把「上 / 左的补片」一起算进去，
      // 否则拖到世界左上角仍会被夹死在那里（上界恒等于 0）。
      const next = clampCamera(
        cam,
        viewportRef.current,
        geometryRef.current,
        prerollScreenRef.current.x,
        prerollScreenRef.current.y,
      );
      cameraRef.current = next;
      paintCamera(next);
      maybeRequestMore(next);
      if (release) setCamera(next);
    },
    [maybeRequestMore, paintCamera],
  );

  const stopFling = useCallback((): void => {
    if (flingRef.current !== 0) {
      window.cancelAnimationFrame(flingRef.current);
      flingRef.current = 0;
    }
  }, []);

  const stopFollow = useCallback((): void => {
    if (followRef.current !== 0) {
      window.cancelAnimationFrame(followRef.current);
      followRef.current = 0;
    }
  }, []);

  /** 松手后按释放速度继续滑。没有任何缓动库，就是每帧衰减一次的积分。 */
  const startFling = useCallback(
    (vx: number, vy: number): void => {
      stopFling();
      let speedX = Math.max(-MAX_FLING, Math.min(MAX_FLING, vx));
      let speedY = Math.max(-MAX_FLING, Math.min(MAX_FLING, vy));
      if (Math.hypot(speedX, speedY) < MIN_FLING) return;
      const step = (): void => {
        speedX *= FLING_DECAY;
        speedY *= FLING_DECAY;
        const before = cameraRef.current;
        updateCamera({ x: before.x + speedX / 60, y: before.y + speedY / 60 }, true);
        const after = cameraRef.current;
        // 撞到边界就别再滑了，不然会「贴着墙抖」。
        if (after.x === before.x && after.y === before.y) {
          flingRef.current = 0;
          return;
        }
        if (Math.hypot(speedX, speedY) < MIN_FLING) {
          flingRef.current = 0;
          return;
        }
        flingRef.current = window.requestAnimationFrame(step);
      };
      flingRef.current = window.requestAnimationFrame(step);
    },
    [stopFling, updateCamera],
  );

  /**
   * 镜头缓动到某个相机位（第十五轮第 1 条）：`cameraToCenterOn(expandedCenterOf(...))` 是目标，
   * 缓动是 `easeOutCubic`（`1 - (1-t)³`）走 `COLLAGE_FOLLOW_MS`，每帧只写 DOM，
   * 结束那一帧才 `setCamera` 把结果交回 React。起手拖拽/平移会 `stopFollow()` 打断它。
   * 从 `focusSlot` 里抽出来的原因：第十六轮第 4 条(d) 的 `focusPlaying()` 也要跑同一条缓动，
   * 但它**不能**吃 `focusSlot` 的「同一格就不动」早退（用户拖远后点底栏必须重新居中）。
   */
  const glideCameraTo = useCallback(
    (target: CollageCamera): void => {
      stopFollow();
      const start = cameraRef.current;
      if (start.x === target.x && start.y === target.y) return;
      const startedAt = performance.now();
      const step = (now: number): void => {
        const progress = Math.min(1, (now - startedAt) / COLLAGE_FOLLOW_MS);
        const eased = 1 - Math.pow(1 - progress, 3);
        const next = {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
        };
        cameraRef.current = next;
        paintCamera(next);
        if (progress < 1) {
          followRef.current = window.requestAnimationFrame(step);
          return;
        }
        followRef.current = 0;
        setCamera(target);
      };
      followRef.current = window.requestAnimationFrame(step);
    },
    [paintCamera, stopFollow],
  );

  /** 「让这一格放大后的新中心落在视口中点」所需的相机位（纯算，不动画）。 */
  const cameraCenteringSlot = useCallback(
    (ref: CollageSlotRef): CollageCamera =>
      cameraToCenterOn(expandedCenterOf(geometryRef.current, ref), viewportRef.current, geometryRef.current),
    [],
  );

  /**
   * 点开某一格（第十五轮第 1 条）：把放大块换成它，并让镜头**缓动**过去（不是瞬移）。
   * 用户 m00736 第 6 条之后「同一格」不再整体早退：拖动只改镜头、不改放大块，所以把墙拖远
   * 之后再点那块**已经放大**的格子，也必须把它重新缓动到视口中点（只是不再改状态，
   * 免得白跑一次 `setActiveSlot`、重放一次放大）。`glideCameraTo` 自带「起点即终点就返回」，
   * 镜头本来就在中心时不会白跑一帧。
   */
  const focusSlot = useCallback(
    (ref: CollageSlotRef): void => {
      if (!sameSlot(activeSlotRef.current, ref)) {
        activeSlotRef.current = ref;
        setActiveSlot(ref);
        // 用户自己换了一格 → `focusSong` 打下的搜索命中标记不再指向「当前这一格」，擦掉。
        setHitKey(null);
      }
      glideCameraTo(cameraCenteringSlot(ref));
    },
    [cameraCenteringSlot, glideCameraTo],
  );

  /**
   * 第十六轮第 4 条(d)：正在播放那首歌「第一遍」落在哪个槽位。
   * 用 `slotRefOfQueueIndex`（`queueIndexOf` 的反向）而不是在 DOM 里找 `data-playing`：
   * 目标格此刻可能正被视口剔除（根本没建 DOM），而「点底栏定位到它」必须先把镜头挪过去。
   */
  const playingSlot = useCallback((): CollageSlotRef | null => {
    const list = songsRef.current;
    const id = playingIdRef.current;
    if (list.length <= 0 || id === undefined) return null;
    const index = list.findIndex((song) => song.id === id);
    if (index < 0) return null;
    return slotRefOfQueueIndex(geometryRef.current, list.length, index);
  }, []);

  /**
   * 第十六轮第 4 条(d)：`focusPlaying()` = 把「正在播放」那一格设为放大块并**重新居中**。
   * 它和 `focusSlot`（用户 m00736 第 6 条之后也会给同一格补一次居中）现在只差一处：
   * 换人时它**不**擦 `hitKey`（底栏定位不是搜索定位）。两者共用同一条理由 ——
   * 拖动不改放大块，所以把墙拖远之后必须重新缓动回来，否则底栏那颗按钮看起来没反应。
   */
  const focusPlaying = useCallback((): boolean => {
    const slot = playingSlot();
    if (slot === null) return false;
    if (!sameSlot(activeSlotRef.current, slot)) {
      activeSlotRef.current = slot;
      setActiveSlot(slot);
    }
    glideCameraTo(cameraCenteringSlot(slot));
    return true;
  }, [cameraCenteringSlot, glideCameraTo, playingSlot]);

  /**
   * 父任务补充（第 6 条后半段）：按关键字定位到**已加载**歌曲里第一个命中的那一格。
   * 匹配：`trim()` + 忽略大小写 + **子串包含**，字段按 歌名 → 专辑名 → 任意歌手名，
   * 队列顺序取首个命中（和墙上摆的顺序一致，也就是用户看到的「从上到下」）。
   * 只搜**已加载**的 `songs`（宿主靠 `onNeedMore` 先把歌单拉全，见头部契约 (c)）。
   * 命中后走的是和 `focusPlaying()` 完全同一条路：设为放大块（`data-collage-expanded`）+
   * 相机缓动居中（同样**不做**「同一格就早退」，主人已经在看那格也重新居中一次），
   * 并用 `hitKey` 给那一格打 `data-collage-hit="true"`（其余格子渲染 false，天然清掉上一次）。
   * 返回值只给「是哪一首、在队列里第几个」——DOM 位置由宿主按 `data-collage-cell` 自己找。
   */
  const focusSong = useCallback(
    (keyword: string): { id: number; index: number } | null => {
      const needle = keyword.trim().toLowerCase();
      if (needle.length === 0) return null;
      const list = songsRef.current;
      const index = list.findIndex((song) => {
        if (song.name.toLowerCase().includes(needle)) return true;
        const album = song.album;
        if (album !== undefined && album.name.toLowerCase().includes(needle)) return true;
        return song.artists.some((artist) => artist.name.toLowerCase().includes(needle));
      });
      if (index < 0) return null;
      const song = list[index];
      if (song === undefined) return null;
      const slot = slotRefOfQueueIndex(geometryRef.current, list.length, index);
      if (slot === null) return null;
      setHitKey(slotKey(slot));
      if (!sameSlot(activeSlotRef.current, slot)) {
        activeSlotRef.current = slot;
        setActiveSlot(slot);
      }
      glideCameraTo(cameraCenteringSlot(slot));
      return { id: song.id, index };
    },
    [cameraCenteringSlot, glideCameraTo],
  );

  useImperativeHandle(
    ref,
    () => ({ focusPlaying, playingSlot, focusSong }),
    [focusPlaying, playingSlot, focusSong],
  );

  /**
   * 第十六轮第 4 条(b)「逐渐放大填充屏幕」的**视觉**由组件自己完成（宿主只负责
   * `COLLAGE_FILL_MS` 之后切播放页，不再自己写 DOM）。
   *
   * `exitingKey` 一落 → React 先把 `.pi-collage__item--exiting`（`animation: none` +
   * `transition: transform 480ms`）提交到 DOM，下一帧我们再写那一格自己的
   * `style.transform` / `style.transformOrigin`：浏览器因此拿到两个不同的「样式快照」
   * （先 `translate(-50%, -50%)`，再铺满视口），那条 transition 才会真的从原位播到全屏，
   * 而不是一步跳到位。写之前读一次 `offsetWidth` 逼一次样式/布局刷新，否则同帧两次写入
   * 会被合并成一次、动画不播。
   *
   * `parentScale` 取根节点 `data-collage-scale`（世界层定档缩放，探针与宿主读的是同一个属性），
   * 读不到就退回当前几何的 `scale`：退场格是 `translate(-50%, -50%)` 的世界层子元素，
   * 位移必须除掉这层缩放才能恰好落在视口中心，缩放倍数则由 `collageCellExitTransform` 算。
   */
  useEffect(() => {
    if (exitingKey === null) return;
    const world = worldRef.current;
    const root = rootRef.current;
    if (world === null || root === null) return;
    const node = world.querySelector<HTMLElement>(`[data-collage-cell="${exitingKey}"]`);
    if (node === null) return;
    const parentScale = Number(root.dataset.collageScale ?? '') || geometryRef.current.scale;
    const frame = window.requestAnimationFrame(() => {
      void node.offsetWidth;
      const fill = collageCellExitTransform(
        node.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        parentScale,
      );
      node.style.transformOrigin = fill.transformOrigin;
      node.style.transform = fill.transform;
    });
    /**
     * 收尾：这一态结束（用户又按下了 = 取消退场；或组件卸载 = 宿主已经切走）时**把内联 transform
     * 撤掉**，否则那一格会永远停在「铺满整屏」的样子上（class 一走，`transition` 也没了）。
     * 取消退场是瞬间回位、不补收缩动画 —— 用户的手已经按在墙上了，这一帧不该再演。
     */
    return () => {
      window.cancelAnimationFrame(frame);
      node.style.transform = '';
      node.style.transformOrigin = '';
    };
  }, [exitingKey]);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0 || !event.isPrimary) return;
      if (gestureRef.current !== null) return;
      stopFling();
      // 手一按住就打断镜头缓动：用户的手比动画优先。
      stopFollow();
      suppressClickRef.current = false;
      // 第十六轮第 4 条(b)：用户又按下了 → 上一次「进播放页」的放大退场态作废。
      setExitingKey(null);
      gestureRef.current = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
        fromX: cameraRef.current.x,
        fromY: cameraRef.current.y,
        lastX: event.clientX,
        lastY: event.clientY,
        lastTime: event.timeStamp,
        vx: 0,
        vy: 0,
        moved: false,
      };
      paintActive(activeSlotRef.current);
    },
    [paintActive, stopFling, stopFollow],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const gesture = gestureRef.current;
      if (gesture === null) return;
      if (gesture.pointerId !== event.pointerId && gesture.pointerType !== 'mouse') return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) > DRAG_TOLERANCE) {
        gesture.moved = true;
        suppressClickRef.current = true;
        const stage = event.currentTarget;
        try {
          stage.setPointerCapture(event.pointerId);
        } catch {
          /* 合成事件/已丢失指针：拿不到捕获也能靠 window 上的 up 收尾。 */
        }
      }
      const elapsed = event.timeStamp - gesture.lastTime;
      if (elapsed > 0) {
        gesture.vx = ((event.clientX - gesture.lastX) / elapsed) * 1000;
        gesture.vy = ((event.clientY - gesture.lastY) / elapsed) * 1000;
      }
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      gesture.lastTime = event.timeStamp;
      if (!gesture.moved) return;
      updateCamera({ x: gesture.fromX + dx, y: gesture.fromY + dy }, false);
    },
    [updateCamera],
  );

  const endGesture = useCallback(
    (event: PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
      const gesture = gestureRef.current;
      if (gesture === null || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      const stage = event.currentTarget;
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      const stale = event.timeStamp - gesture.lastTime > FLING_STALE_MS;
      paintActive(activeSlotRef.current);
      if (cancelled || !gesture.moved || stale) {
        setCamera(cameraRef.current);
        return;
      }
      setCamera(cameraRef.current);
      startFling(gesture.vx, gesture.vy);
    },
    [paintActive, startFling],
  );

  const handleClickCapture = useCallback((event: { detail: number; stopPropagation: () => void }): void => {
    if (!suppressClickRef.current || event.detail === 0) return;
    suppressClickRef.current = false;
    event.stopPropagation();
  }, []);

  /**
   * 点一块 = 播那首歌 + 选中。刻意和 `SongCards` 的 `activate()` 完全一致
   * （`onSelect` + `play`，**不**在这里 `navigate('home')`），这样「我的喜欢」与
   * 「最近听过」两个页签的点击语义一样，也不会把冒烟探针要看的那棵树卸载掉。
   */
  const playCell = useCallback(
    (song: Song, index: number): void => {
      onSelect(song);
      if (!disablePlay) void play(songs, index);
    },
    [disablePlay, onSelect, play, songs],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // Tab 进去后回车由那一块自己的 onClick 负责（按钮的默认行为），这里别再播一次。
      if (event.target instanceof HTMLButtonElement) return;
      // 一次一格（屏幕上的一格）：节距 × 定档缩放。
      const step = COLLAGE_PITCH * geometryRef.current.scale;
      const current = cameraRef.current;
      const pan = (dx: number, dy: number): void => {
        event.preventDefault();
        stopFling();
        stopFollow();
        updateCamera({ x: current.x + dx, y: current.y + dy }, true);
      };
      if (event.key === 'ArrowLeft') pan(step, 0);
      else if (event.key === 'ArrowRight') pan(-step, 0);
      else if (event.key === 'ArrowUp') pan(0, step);
      else if (event.key === 'ArrowDown') pan(0, -step);
      else if (event.key === 'Enter' || event.key === ' ') {
        // 容器自己拿着焦点（点过空白处）时，回车播「正中心」那一首。
        const slot = activeSlotRef.current;
        if (slot === null) return;
        const node = worldRef.current?.querySelector<HTMLElement>(
          `[data-collage-cell="${slotKey(slot)}"]`,
        );
        if (node === null || node === undefined) return;
        event.preventDefault();
        node.click();
      }
    },
    [stopFling, stopFollow, updateCamera],
  );

  // 尺寸：容器变了就重新量一次（首帧 width=0 → 量到真尺寸才会算世界与中心块）。
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const read = (): void => {
      const rect = root.getBoundingClientRect();
      const next = {
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
      viewportRef.current = next;
      setViewport((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // 首帧落定后再开尺寸过渡（见 SETTLE_MS 的注释）。
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * 量到尺寸（或换了尺寸/歌数）之后：首帧把相机摆到世界正中（一定有左右可拖），
   * 之后只把现有相机夹回新的世界边界；顺手冻住入场波纹的起点、重算放大块。
   * 换尺寸会让「点击放大的目标相机」失效，所以顺手打断正在跑的镜头缓动。
   */
  useEffect(() => {
    if (viewport.width <= 0 || viewport.height <= 0 || total <= 0) return;
    stopFollow();
    /**
     * 用户 m00001 第 3 条(B)：入场机位照旧是「世界正中」（`centeredCamera`，一个字都不改），
     * 只把夹相机时的那对 pad 补上——否则首帧会被旧上界（恒为 0）按住，
     * 上 / 左方向一进来就没得拖。
     */
    const center = seededRef.current ? cameraRef.current : centeredCamera(viewport, geometry);
    seededRef.current = true;
    const next = clampCamera(
      center,
      viewport,
      geometry,
      prerollScreenRef.current.x,
      prerollScreenRef.current.y,
    );
    cameraRef.current = next;
    paintCamera(next);
    setCamera((previous) =>
      previous.x === next.x && previous.y === next.y ? previous : next,
    );
    setWaveOrigin((previous) => previous ?? { x: -next.x / geometry.scale, y: -next.y / geometry.scale });
    const slot = centerSlotOf(next, viewport, geometry);
    activeSlotRef.current = slot;
    setActiveSlot((previous) => (sameSlot(previous, slot) ? previous : slot));
  }, [geometry, paintCamera, stopFollow, total, viewport]);

  /**
   * 第十六轮第 4 条(c)：换歌数/换尺寸之后也要判一次「贴到内容边了吗」——
   * 短歌单（一屏就装得下）一进来就已经贴着边，不能等用户先拖一下才想起来加载下一页。
   * 这个 effect 必须排在上面那个「摆相机」的 effect 之后（effect 按声明顺序跑），
   * 判据用的才是最终相机位。
   */
  useEffect(() => {
    if (viewport.width <= 0 || total <= 0) return;
    maybeRequestMore(cameraRef.current);
  }, [geometry, maybeRequestMore, total, viewport]);

  // 相机或放大块变了：把 DOM 里的 transform 与高亮补齐。
  useEffect(() => {
    // 用户 m00001 第 3 条(B)：这里的夹相机也要带上上 / 左的补片，
    // 不然这条 effect 会把拖进补片里的相机又拉回世界左上角（拖一下弹回来）。
    const next = clampCamera(
      camera,
      viewportRef.current,
      geometryRef.current,
      prerollScreenRef.current.x,
      prerollScreenRef.current.y,
    );
    if (next.x !== camera.x || next.y !== camera.y) {
      cameraRef.current = next;
      setCamera(next);
      return;
    }
    cameraRef.current = next;
    paintedSlotRef.current = null;
    // 镜头缓动正在跑的时候，相机 transform 的所有权归它，这个 effect 别去抢帧。
    if (followRef.current === 0) paintCamera(next);
    paintActive(activeSlot);
  }, [activeSlot, camera, paintActive, paintCamera]);

  useEffect(
    () => () => {
      stopFling();
      stopFollow();
      // 用户 m00736 第 6 条：宿主自己切页/卸载时，别让那条「稍后回播放页」的定时器继续跑。
      if (enterTimerRef.current !== 0) window.clearTimeout(enterTimerRef.current);
    },
    [stopFling, stopFollow],
  );

  /**
   * 只画与视口相交的槽位：成本只跟屏幕内容相关，与队列长度无关
   * （folia 的 `layoutLattice` 是同一套思路；它的世界无界所以必须裁剪，我们的世界有界，
   * 但同样没必要为看不见的块建 DOM）。`waveOrigin` 没冻住前先不画，
   * 免得入场延迟先按 0 播一遍、下一秒冻住起点又重播。
   */
  const centerSlot =
    activeSlot ?? (viewport.width > 0 && total > 0 ? centerSlotOf(camera, viewport, geometry) : null);

  const items = useMemo<CollageInstance[]>(() => {
    if (total <= 0 || viewport.width <= 0 || waveOrigin === null) return [];
    // 用户 m00001 第 3 条(B)：把上 / 左的补片交给可见槽位计算，
    // 相机拖过世界左上角之后才真的看得到那些回卷格（而不是一片空白）。
    return listVisibleSlots(geometry, total, camera, viewport, centerSlot, waveOrigin, preroll);
  }, [camera, centerSlot, geometry, preroll, total, viewport, waveOrigin]);

  if (total === 0) {
    return <div className="pi-placeholder">这里还没有内容。</div>;
  }

  const pixelScale =
    geometry.scale * (typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1));

  /**
   * 第十六轮第 4 条(c)：世界里的槽位总数（含为了让世界铺满视口而取模回卷出来的重复格）。
   * 探针与宿主用 `data-collage-cells` 读它，和「墙上真有几首歌」（`data-collage-songs`）、
   * 「此刻真在 DOM 里几格」（`data-collage-rendered`，视口剔除后的数量）区分开。
   */
  const builtCells = builtCellCountOf(geometry);

  return (
    <div
      ref={rootRef}
      className={`pi-collage${settled ? ' pi-collage--settled' : ''}`}
      data-song-collage
      data-song-collage-count={total}
      data-collage-camera={`${Math.round(camera.x)}:${Math.round(camera.y)}`}
      data-collage-cells={builtCells}
      data-collage-songs={total}
      data-collage-rendered={items.length}
      data-collage-has-more={hasMore === true ? 'true' : 'false'}
      data-collage-scale={geometry.scale}
      /** 用户 m00001 第 3 条(B)：世界左上角外补了几块回卷格（列x行），给探针/调试看。 */
      data-collage-preroll={`${preroll.cols}x${preroll.rows}`}
      data-collage-fill-ms={COLLAGE_FILL_MS}
      data-collage-exiting={exitingKey === null ? 'false' : 'true'}
      style={
        {
          '--pi-collage-lift': `${ENTRANCE_LIFT}px`,
          // 第十五轮第 1 条的 3D 俯仰：透视挂在根上（透视原点 = 视口中心），
          // 旋转挂在新加的一层 `.pi-collage__tilt` 上（旋转原点 = 视口中心）。
          perspective: `${COLLAGE_PERSPECTIVE_PX}px`,
          perspectiveOrigin: '50% 50%',
        } as CSSProperties
      }
      role="application"
      aria-label="歌曲拼贴墙，拖拽移动，点击某一格放大并居中，方向键平移，回车播放中心歌曲"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => endGesture(event, false)}
      onPointerCancel={(event) => endGesture(event, true)}
      onClickCapture={handleClickCapture}
      onKeyDown={handleKeyDown}
    >
      {/**
       * 3D 姿态层：它自己不滚动、不裁剪，只把整面墙绕**视口中心**转过一个小角度。
       * 世界层仍然是原来的 `translate3d(...) scale(...)`（探针读的就是它），
       * 所以「相机」的语义没有被 3D 改动。
       */}
      <div
        className="pi-collage__tilt"
        style={{ transform: `rotateX(${COLLAGE_PITCH_DEG}deg) rotateY(${COLLAGE_YAW_DEG}deg)` }}
      >
        <div
          ref={worldRef}
          className="pi-collage__world"
          style={{ width: geometry.worldWidth, height: geometry.worldHeight }}
        >
          {items.map((item) => {
            const song = songs[item.queueIndex];
            if (song === undefined) return null;
            const isCenter = item.expanded;
            const isPlaying = playingId === song.id;
            const isExiting = exitingKey === item.key;
            /** 父任务补充：`focusSong` 命中的那一格（搜索定位高亮）。 */
            const isHit = hitKey === item.key;
            // folia 的封面按 `max(rect) × 相机缩放 × DPR` 取图：小片别拉原图，大片别糊。
            // 取 64 的整数倍，避免同一张卡因为四舍五入反复换 URL 重新下载。
            const wanted = Math.max(item.width, item.height) * pixelScale;
            const cover = coverAt(song.album?.coverUrl, Math.min(768, Math.max(192, Math.round(wanted / 64) * 64)));
            // 标题字号跟着卡片走（folia 的 `LatticeTitle` 是按卡片宽度缩字号的）；歌手沿用 folia 的固定小号字。
            const copySize = isCenter
              ? Math.round(Math.min(56, Math.max(26, item.width * 0.062)))
              : Math.round(Math.min(30, Math.max(13, Math.min(item.width, item.height) * 0.062)));
            const inset = Math.round(Math.min(32, Math.max(8, Math.min(item.width, item.height) * 0.045)));
            const style = {
              left: item.x,
              top: item.y,
              width: item.width,
              height: item.height,
              // 入场延迟是纯几何算出来的（相对冻结的波纹起点、用**模板原位**而不是重排后的位置），
              // 同坐标永远同一个值，所以平移/换放大块都不会改 `animation-delay`、也就不会重播入场。
              '--pi-collage-delay': `${item.delay.toFixed(2)}s`,
              '--pi-collage-copy': `${copySize}px`,
              '--pi-collage-inset': `${inset}px`,
            } as CSSProperties;
            return (
              <button
                key={item.key}
                type="button"
                className={`pi-collage__item${isCenter ? ' pi-collage__item--center' : ''}${
                  item.reflowed ? ' pi-collage__item--reflowed' : ''
                }${isExiting ? ' pi-collage__item--exiting' : ''}${
                  isHit ? ' pi-collage__item--hit' : ''
                }`}
                data-song-collage-item={song.id}
                data-collage-cell={item.key}
                data-queue-index={item.queueIndex}
                data-center={isCenter ? 'true' : 'false'}
                data-collage-expanded={isCenter ? 'true' : 'false'}
                data-collage-reflow={item.reflowed ? 'true' : 'false'}
                data-playing={isPlaying ? 'true' : 'false'}
                data-collage-exiting={isExiting ? 'true' : 'false'}
                data-collage-hit={isHit ? 'true' : 'false'}
                style={style}
                title={`${song.name} - ${artistNames(song)}`}
                aria-label={`${item.queueIndex + 1}. ${song.name} - ${artistNames(song)}`}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  /**
                   * 第十六轮第 4 条(b) + 用户 m00736 第 6 条：既在播、又是当前放大聚焦的那一格
                   * —— 点它的语义是「进播放页」，不是再播一遍。只打退场钩子（放大块长到铺满
                   * 屏幕）+ 回调宿主，**不**重复 `focusSlot` / `play()`（它已经在中心、也已经在播）。
                   * 宿主没给 `onEnterPlaying`（歌单详情浮层）时不再退回「再播一遍」的旧语义，
                   * 而是由组件自己等动画放完再收浮层、切回播放页（见 `enterPlayer`）。
                   */
                  if (isPlaying && isCenter) {
                    setExitingKey(item.key);
                    if (onEnterPlaying !== undefined) onEnterPlaying(song);
                    else enterPlayer();
                    return;
                  }
                  // 先换放大块 + 镜头缓动过去，再照旧播/选中（拖出来的位移不会走到这里，
                  // 上面那个 `suppressClickRef` 已经把「拖」筛掉了）。
                  focusSlot(item.ref);
                  playCell(song, item.queueIndex);
                }}
              >
                <span className="pi-collage__cover">
                  {cover ? (
                    <img src={cover} alt="" loading="lazy" decoding="async" draggable={false} />
                  ) : (
                    <span className="pi-collage__nocover" aria-hidden="true" />
                  )}
                </span>
                <span className="pi-collage__shade" aria-hidden="true" />
                <span className="pi-collage__badge" aria-hidden="true">
                  {item.queueIndex + 1}
                </span>
                <span className="pi-collage__copy">
                  <strong className="pi-collage__name">{song.name}</strong>
                  <small className="pi-collage__meta">{artistNames(song)}</small>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});
