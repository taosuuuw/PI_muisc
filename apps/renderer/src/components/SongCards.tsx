import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { Song } from '@pi/shared';
import { coverAt } from '../lib/cover';
import { useViewport } from '../lib/drag-snap';
import { artistNames } from '../lib/format';
import { usePlayer } from '../state/player';

/**
 * 歌曲卡片 · 一行中心聚焦（用户 m08768 第 2 条）。
 *
 * 从「封面网格」换成「一行封面流」：中心一张大而亮，两侧灰暗缩小、左右让开，
 * 拖动 / 滚轮 / ←→ 换中心，点中心那张即播。
 *
 * 数值与做法借鉴 folia（chthollyphile/folia-major 的 Carousel3D，AGPL）：
 * 绝对定位叠放 + 每项一个 transform；父级 `perspective: 1000px`；`d = i - focused`；
 * `x = d * sideOffset`；`scale = d===0 ? 1.1 : 1 - |d|*0.15`；
 * `opacity = d===0 ? 1 : 0.6 - |d|*0.15`；`zIndex = 10 - |d|`；`rotateY = d>0 ? -15 : 15`；
 * 非中心 `blur(2px)`；只画 `|d| <= 4`。**只借数值与思路，代码是自己写的。**
 * 它只有「松手跳一格」而且不跟手，这里按需求做成跟手拖动 + 到头橡皮筋 + 回弹，
 * 并且**拖动期间高亮就实时跟手**（用户 m08768 第 6 条后半句）：每张卡片按它到
 * 实时中心的连续（小数）距离取缩放/明暗/旋转/层级，越过中线时高亮平滑交给下一张，
 * 而不是等松手才跳变（见 `paintCards` 与 `lookOf` 的连续化）。
 *
 * 几个刻意的取舍：
 * - 不引第三方动画库（renderer 只有 react / react-dom / zustand / @tanstack/react-query）：
 *   回弹交给 CSS transition；拖动期间**绕过 React 直接写 style**，否则一秒上百次
 *   pointermove 会让几百张卡片跟着重渲染（跟手量一变，十来张可见卡的外观全都要重算）。
 *   代价是那两个观测钩子（每张卡的 `data-focused`、根上的 `data-focus-index`）也得手写，
 *   并在松手后的 useLayoutEffect 里原样交还给 React。
 * - 卡片一律留在 DOM 里（只把远处的用 `[data-far]` 藏起来）：桌面冒烟按 `.pi-songcard`
 *   的下标去点歌，只画中心附近 9 张会让下标跟歌曲对不上。
 * - 焦点只认 `activeId` 这个 prop，不跟「播放器正在放的那首」走：列表自己最清楚该把谁
 *   摆在正中；跟当前曲走会在打开歌单详情时突然跳到中间某一首，第 0 张被推到很远。
 */
/**
 * 一张卡片的显示数据（第十八轮第 3 条）。
 *
 * 歌单列表（`PlaylistCoverflowOverlay`）要的也是「一行中心聚焦的封面卡片」，和搜索页 /
 * 歌单详情里的歌曲卡片**是同一套展示**——用户原话「歌单先锋风格下的封面卡片展示全部复刻
 * 搜索功能下的歌曲卡片展示（直接套用它的代码）」。两边的差别只有数据与「中心卡被确认之后
 * 干什么」：一个是 `Playlist`（打开歌单），一个是 `Song`（播放）。
 * 所以把「显示什么」抽成这张数据模型，手势 / 几何 / 键盘 / 观测钩子全部共用。
 */
export interface SongCardModel {
  /** 稳定身份：歌曲模式 = `song.id`，歌单模式 = `playlist.id`（同时下发成 `data-song-card`）。 */
  key: number;
  title: string;
  /** 副标题一整行（歌曲模式 = 歌手 + 专辑 + `metaOf` 的补充信息）。 */
  meta: string;
  /** 封面**原始**地址（`coverAt` 会再按当前档位补 `?param=`；它认得完整 URL）。 */
  coverUrl: string | null;
  /** 名字后面那枚小角标的文案（歌曲模式是「无版权」）。 */
  badge?: string;
  /** 追加到卡片上的 `data-*` 钩子（值 `undefined` 的不下发）。 */
  data?: Record<string, string | number | undefined>;
}

export interface SongCardsProps {
  /** 歌曲模式的数据源；第十八轮第 3 条起可省略——卡片模式改用 `cards`。 */
  songs?: readonly Song[];
  /** 歌曲模式：中心卡被确认（`disablePlay` 为假时同时播放）。 */
  onSelect?: (song: Song) => void;
  /** 追加到副标题行末尾的补充信息（例如「播放 12 次」）。 */
  metaOf?: (song: Song) => string | undefined;
  /** 关掉「点一下就播放」。 */
  disablePlay?: boolean;
  /** 打开时该居中显示哪一张（歌曲模式是 `Song['id']`，卡片模式是 `SongCardModel['key']`）；
   *  不传、或不在列表里就回到第 0 张。 */
  activeId?: number;
  /** 追加到每张卡片上的 `data-*` 钩子（值 `undefined` 的不下发）。加歌面板用它把原来的
   *  `data-addtracks-row` / `data-addtracks-add` 两个抓手挂到卡片上，自动化按歌曲定位时不用改判据。 */
  cardDataOf?: (song: Song) => Record<string, string | number | undefined>;
  /** 底部提示行文案。默认是「滚轮 / ←→ / 拖动切换，点中心卡片播放」；加歌面板要说「加入」。 */
  hint?: string;
  /**
   * 拖动手感（用户 m00736 第 7 条 a）：`'precise'`（默认）就是搜索页 / 搜索浮层 /
   * 加歌面板一直用的那套 —— 任何位移都 1:1 跟手；`'free'` 给歌单封面卡片流用：
   * 位移超过一整张卡片的间距之后跟手增益随幅度线性增大（等价于阻尼衰减），
   * 小幅度拖动仍是 1:1。**默认值与四个宿主的现有行为逐字相同。**
   */
  dragFeel?: 'precise' | 'free';
  /**
   * 卡片模式（第十八轮第 3 条）：宿主直接给显示数据，组件不再碰 `Song`。
   * 给了它就整条按它渲染（`songs` / `metaOf` / `cardDataOf` 都不再看）。
   */
  cards?: readonly SongCardModel[];
  /** 卡片模式：中心卡被「确认」时回调（歌曲模式走 `onSelect` + `play`）。 */
  onCard?: (index: number) => void;
  /** 列表为空时展示什么（默认一句占位文案）。 */
  empty?: ReactNode;
}

/** 尺寸档位：需求给的 1440 / 768 两个断点，封面与相邻卡片的间距一起换。 */
const GEOMETRY = {
  lg: { cover: 312, offset: 288 },
  md: { cover: 256, offset: 240 },
  sm: { cover: 224, offset: 210 },
} as const;

type SizeTier = keyof typeof GEOMETRY;

function tierOf(width: number): SizeTier {
  if (width >= 1440) return 'lg';
  if (width >= 768) return 'md';
  return 'sm';
}

/** 只画中心附近这几张（folia 的 4）：更远的本来就全透明，画出来白吃合成开销。 */
const SHOWN_RADIUS = 4;

/** 拖动位移小于它（曼哈顿距离）算点击，同 lib/drag-snap.ts 的 tolerance。 */
const DRAG_TOLERANCE = 8;

/** 到头之后继续拖的阻尼：超出的部分只跟手 35%，手感像拉一根橡皮筋。 */
const RUBBER_BAND = 0.35;

/**
 * 「大幅度拖动」的跟手增益（用户 m00736 第 7 条 a，只有 `dragFeel==='free'` 才启用）。
 *
 * 手感上就是「阻尼随幅度衰减」：小位移（不到一整张卡片的间距 `offset`）一点都不动，
 * 位移再大就线性加增益，最多 `max` 倍 —— 手指划 1px 卡片流走 1.6px，视口里一下能翻
 * 好几张歌单。默认（不传 `dragFeel`）连乘都不敢乘，搜索页 / 搜索浮层 / 加歌面板的
 * 数值与改动前逐字相同。
 */
const FREE_DRAG = {
  /** 增益斜率：每多划「一张卡片的间距」，增益 +0.6。 */
  slope: 0.6,
  /** 增益上限（也就是阻尼下限）：划满两张卡片的距离之后不再涨，免得一甩飞出十几张。 */
  max: 1.6,
} as const;

/**
 * 位移 → 跟手增益（1 = 现在那种 1:1 跟手）。
 *
 * 分段：`|dx| <= offset`（还没划到一整张卡片的距离）恒为 1，精细定位的手感一点没变；
 * 再往外按 `slope` 线性涨到 `max` 封顶。只看位移大小、不看方向，左右对称。
 */
function freeDragGain(dx: number, offset: number): number {
  const past = Math.abs(dx) - offset;
  if (past <= 0) return 1;
  return Math.min(1 + (FREE_DRAG.slope * past) / offset, FREE_DRAG.max);
}

/** 滚轮：小于这个量级的多半是触控板的细碎抖动，不切歌。 */
const WHEEL_MIN_DELTA = 20;
const WHEEL_COOLDOWN_MS = 150;
const KEY_COOLDOWN_MS = 100;

interface Gesture {
  pointerId: number;
  pointerType: string;
  fromX: number;
  fromY: number;
  /** 位移过没过阈值——没过就还是一次点击。 */
  moved: boolean;
}

/**
 * 同一个手势的判定，和 `lib/drag-snap.ts` 里那份是同一套理由：
 * 自动化输入（`sendInputEvent`）里同一次拖动的 pointerId 不保证稳定，会出现
 * 「第一次 move 生效、后面全对不上」；鼠标在一个窗口里不可能有两个指针，
 * 所以两边都是 mouse 时按同一手势处理，触摸/笔仍严格按 id 区分。
 */
function matchesPointer(active: Gesture, pointerId: number, pointerType: string): boolean {
  if (active.pointerId === pointerId) return true;
  return active.pointerType === 'mouse' && pointerType === 'mouse';
}

function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0));
}

/**
 * 这一拖想落到哪一张（带小数，也可能越界）。
 *
 * 方向只在这一处定义：`dragX` 是「整条流被往左拉了多少」，往左拉得越多，
 * 右边那张就越靠近中心，所以虚拟焦点是 `focus - dragX / offset`。
 * 橡皮筋（判断拖出没拖出两端）与「松手该落到哪张」都走它 ——
 * 两边各写一遍符号的话，写反了手感就是「往左拖、焦点往右跳」。
 */
function virtualFocus(dragX: number, focusIndex: number, offset: number): number {
  return focusIndex - dragX / offset;
}

/** 一张卡片在这个位置上的样子（位置由调用方按 `d * offset` 再叠加拖动量算）。 */
interface CardLook {
  scale: number;
  opacity: number;
  rotateY: number;
  zIndex: number;
}

/**
 * `d` 可以是整数（静止态，React 渲染用），也可以是小数（拖动中跟手用）。
 *
 * 原来是「d === 0 一档、其余按 |d| 线性降」——在 0 那里断开：中心 1.1 倍 / 全亮，
 * 一离开整数格就掉到 1 / 0.6。拖动要跟手就不能有这个断点，否则越过中线时高亮
 * 是「啪」地跳过去的。这里分段线性地把中心那一档接到邻位上：
 * `|d| ∈ [0,1]` 段从 (1.1, 1) 落到 (0.85, 0.45)，`|d| > 1` 继续按原斜率 0.15 降。
 * 它在 `|d| = 0,1,2,3,4` 上的取值与改动前逐项相同（1.1/1、0.85/0.45、0.70/0.30、
 * 0.55/0.15、0.40/0），所以静止时的外观一点没变；中间的小数则是连续插值。
 * rotateY 同理：由「非 0 就 ±15」改成 `±15 * clamp(d, -1, 1)`，中心 0° 平滑转出去。
 *
 * 两个必须守住的约束：`zIndex` 只能是整数（CSS 的 z-index 不接受小数，写了会被丢掉），
 * 而且中心那张永远最高——`round(10 - |d|)` 对 |d| 单调不增，天然满足。
 * scale / opacity 夹到非负：|d| 大到 4 以外时原式会算出负数（无效声明会被浏览器丢弃，
 * 于是残留上一次的值）。
 */
function lookOf(d: number): CardLook {
  const abs = Math.abs(d);
  // 中心→邻位这一段，和邻位往外那一截，两段的斜率不同（0.25 / 0.15）。
  const near = Math.min(abs, 1);
  const far = Math.max(abs - 1, 0);
  return {
    scale: Math.max(0, 1.1 - 0.25 * near - 0.15 * far),
    opacity: Math.max(0, 1 - 0.55 * near - 0.15 * far),
    rotateY: -15 * Math.min(Math.max(d, -1), 1),
    // 越远越低；取整保证是合法整数，且中心那张永远压在所有卡片上面
    zIndex: Math.max(1, Math.round(10 - abs)),
  };
}

/**
 * 一张卡片的 transform。
 *
 * `-50%` 是「以舞台中心为锚点」。`position` 是相对**渲染时焦点**的整数偏移
 * （就是 `data-offset`），`dragX` 是拖动期间整条流的跟手位移：横向位置 =
 * `position * offset + dragX`，跟手量只加这一次（连续性全在 dragX 上）。
 * 缩放/旋转由调用方算好的 `look` 给——拖动中它按**连续距离**取值（见 `lookOf`），
 * 所以这里不再自己拿 `position` 去查表（那样就跟手不动了）。
 * 缩放/旋转都绕 `transform-origin: center top`（CSS 里声明）：顶边对齐，
 * 中心卡放大时向左右和下方长，封面顶边不会顶出舞台。
 */
function cardTransform(position: number, offset: number, dragX: number, look: CardLook): string {
  const x = position * offset + dragX;
  return `translate3d(calc(-50% + ${x.toFixed(1)}px), 0, 0) scale(${look.scale.toFixed(4)}) rotateY(${look.rotateY}deg)`;
}

/**
 * 拖动位移 → 真正生效的位移。
 *
 * 还没到头时原样返回；到头（第 0 张再往右、最后一张再往左）之后不给死，
 * 而是把超出的部分乘 0.35 —— 手感上像拉橡皮筋，也让「这里已经到头了」看得见。
 * 把「虚拟焦点」夹回 [0, count-1] 再算位移，比在位移上做减法更好推：
 * `focus - dragX/offset` 就是这一拖想走到哪一张。
 */
function rubberBand(dragX: number, focusIndex: number, count: number, offset: number): number {
  const virtual = virtualFocus(dragX, focusIndex, offset);
  const clamped = Math.min(Math.max(virtual, 0), Math.max(count - 1, 0));
  const resisted = clamped + (virtual - clamped) * RUBBER_BAND;
  return -(resisted - focusIndex) * offset;
}

/** 打开时该聚焦第几张：优先 `activeId` 那一张，找不到就回到第 0 张。 */
function focusOf(models: readonly SongCardModel[], activeId: number | undefined): number {
  if (activeId === undefined) return 0;
  const index = models.findIndex((model) => model.key === activeId);
  return index < 0 ? 0 : index;
}

/**
 * 键盘的主人。
 *
 * 一页里可能同时挂着好几条卡片流（「我的」页上再叠一层歌单详情就是两条），
 * 而 keydown 是挂在 window 上的：没有归属判定的话，一次 ←→ 会把每条流都翻一格。
 * 规则：鼠标最近待过哪条就归它（`pointerenter` 认领、`pointerleave` 交还），
 * 谁都没待过时归页面里挂载最早的那条。
 *
 * 放在模块作用域而不是 Context：要共享的只有「谁是主人」这一个变量，
 * 为它把所有调用点包一层 Provider 不划算。
 */
const stages = new Set<HTMLElement>();
let hoveredStage: HTMLElement | null = null;

function ownsKeyboard(stage: HTMLElement): boolean {
  if (hoveredStage !== null) return hoveredStage === stage;
  const [first] = stages;
  return first === stage;
}

export function SongCards({
  songs: songsProp,
  onSelect,
  metaOf,
  disablePlay,
  activeId,
  cardDataOf,
  hint,
  dragFeel = 'precise',
  cards,
  onCard,
  empty,
}: SongCardsProps): ReactNode {
  /*
   * 第十八轮第 3 条：`songs` 变成可选（卡片模式不用它）。这里就地兜底成空数组，
   * 下面每一处都读这个非空的局部量 —— 可选性不会漏到下面那些 `songs[...]` 上去。
   */
  const songs: readonly Song[] = songsProp ?? [];
  const cardMode = cards !== undefined;
  /** 只有歌单封面卡片流传 `'free'`；默认那条路上 `applyMove` 连乘 1 都不做。 */
  const free = dragFeel === 'free';
  const play = usePlayer((s) => s.play);
  const playingId = usePlayer((s) => s.currentSong?.id);
  // 传了 activeId 就以它为准；没传时沿用老语义（播放器当前曲打高亮）。
  const currentId = activeId ?? playingId;
  const viewport = useViewport();
  const tier = tierOf(viewport.width);
  const { cover, offset } = GEOMETRY[tier];
  // 封面源像素给到中心卡的 1.1 倍再往十位取整：312px 的封面还按 200px 取源，
  // 在高分屏上会糊成一片。CDN 按 param 现裁，多要这一档几乎没有代价。
  const coverPixels = Math.round((cover * 1.1) / 10) * 10;

  /**
   * 渲染用的统一数据：卡片模式直接用它给的 `cards`，歌曲模式由 `songs` 现算。
   * 歌曲模式那几个字段与改动前逐字对应（歌手 + 专辑 + `metaOf` 的补充、无版权角标）。
   */
  const models: readonly SongCardModel[] = useMemo(
    () =>
      cards ??
      songs.map((song) => {
        const extra = metaOf?.(song);
        return {
          key: song.id,
          title: song.name,
          meta: `${artistNames(song)}${song.album ? ` · ${song.album.name}` : ''}${
            extra ? ` · ${extra}` : ''
          }`,
          coverUrl: song.album?.coverUrl ?? null,
          badge: song.playable === false ? '无版权' : undefined,
          data: cardDataOf?.(song),
        };
      }),
    [cards, songs, metaOf, cardDataOf],
  );

  const [focusedIndex, setFocusedIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 根节点：拖动中要把 `data-focus-index` 改成一个 React 还没渲染到的值。 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 当前跟手位移（已经过橡皮筋），松手那一刻用它换算落到哪一张。 */
  const dragX = useRef(0);
  const gesture = useRef<Gesture | null>(null);
  /**
   * 这次「按下—抬起」已经由 pointerup 判完的时刻（真拖了一下，或者当成一次点击处理掉了）。
   * 读取即消费，用来吞掉紧跟其后那一次 click（同 lib/drag-snap.ts 的 wasDragged）。
   */
  const handledAt = useRef(0);
  const wheelAt = useRef(0);
  const keyAt = useRef(0);

  const count = models.length;
  // 列表常常是先空（查询还在加载）再变满：舞台是那时才挂上来的，
  // 所以下面「挂监听」的两个 effect 必须把这件事算进依赖，否则永远挂不上。
  const hasStage = count > 0;
  // 渲染/换算用的焦点：列表变短的那一帧状态还可能越界，先钳一下。
  const focus = count === 0 ? 0 : Math.min(Math.max(focusedIndex, 0), count - 1);

  // window 上的监听（拖动、滚轮、键盘）要能读到最后一次渲染的值。
  const live = useRef({ count, focus, offset });
  live.current = { count, focus, offset };

  // 换列表 / 换指定聚焦曲目时把焦点收回来。
  // 用「签名」而不是列表的引用去判断：调用方常常每次渲染都 map 出一个新数组
  // （见 pages/MinePage.tsx 的 RecentList，卡片模式的歌单列表也是每次渲染现 map），
  // 只比引用会在父组件无关重渲染时把焦点冲回第 0 张。
  const listSignature = `${activeId ?? ''}|${count}|${models[0]?.key ?? ''}|${models[count - 1]?.key ?? ''}`;
  const lastSignature = useRef<string | null>(null);
  useEffect(() => {
    if (lastSignature.current === listSignature) return;
    lastSignature.current = listSignature;
    setFocusedIndex(focusOf(models, activeId));
  }, [listSignature, models, activeId]);

  /**
   * 把「整条流被拖到 `next` 这个位移」这件事画到 DOM 上（`next === 0` 就是静止态）。
   *
   * 为什么绕过 React 直接写 DOM：pointermove 一秒能来 60~120 次，走 state 的话
   * 每次都要重新 diff 几百张卡片；而拖动期间除了这一个平移量以外，卡片的位置
   * 全由它推出来——直接改 style 只碰屏幕上这十来张。
   *
   * 跟手高亮（用户 m08768 第 6 条后半句）：每张卡片的**连续距离**是
   *   `cd = data-offset + next / offset`
   * 与 `virtualFocus` 同一套几何——`virtualFocus = focus - dragX / offset`，
   * 而 `data-offset` 正是相对「拖拽开始时的焦点」的整数偏移，两者相差一个 focus。
   * `cd` 是小数，喂给 `lookOf` 就得到连续变化的 scale / opacity / rotateY / zIndex：
   * 中心那张随手指平滑地放大变亮，越过中线时高亮平滑地交给下一张，而不是等松手。
   * 平移量仍然只按 `position * offset + next` 算一次，`cd` 里那份位移只喂给观感。
   *
   * 顺带把「实时焦点」写进两个观测钩子：
   * - 每张可见卡片的 `data-focused`：离中心最近（`|cd|` 最小，等价于四舍五入）那张 true；
   * - 根节点 `data-focus-index`：同一张卡片的真实下标，拖动中跟着手指变（起点是原焦点）。
   * 两者始终指向同一张卡：实时中心被夹在可见窗口 `|offset| ≤ SHOWN_RADIUS` 内，
   * 因为窗口外的卡片是 `display: none`，一次拖过 4 张时也只能把高亮交给窗口里最近的那张。
   */
  const paintCards = useCallback((next: number): void => {
    const stage = stageRef.current;
    if (stage === null) return;
    const { focus: at, count: total, offset: sideOffset } = live.current;
    // 实时中心（四舍五入到最近整数那张），与松手落点、橡皮筋共用 virtualFocus。
    const center = clampIndex(Math.round(virtualFocus(next, at, sideOffset)), total);
    const centerOffset = Math.min(Math.max(center - at, -SHOWN_RADIUS), SHOWN_RADIUS);
    const root = rootRef.current;
    const focusIndex = String(at + centerOffset);
    if (root !== null && root.dataset.focusIndex !== focusIndex) {
      root.dataset.focusIndex = focusIndex;
    }
    for (const el of stage.querySelectorAll<HTMLElement>('.pi-songcard')) {
      // 藏起来的（|d| > 4）连画都不画，也不参与「谁在中心」的判定。
      if (el.dataset.far === 'true') continue;
      const d = Number(el.dataset.offset ?? '0');
      const cd = d + next / sideOffset;
      const look = lookOf(cd);
      el.style.transform = cardTransform(d, sideOffset, next, look);
      el.style.zIndex = String(look.zIndex);
      el.style.opacity = String(look.opacity);
      // 只在真的换人时写属性：每帧都赋值虽然视觉上等价，但会白白多出一次
      // 属性变更与样式失效判定（一秒上百帧）。
      const focused = d === centerOffset ? 'true' : 'false';
      if (el.dataset.focused !== focused) el.dataset.focused = focused;
    }
  }, []);

  /**
   * 松手之后（以及焦点/档位变化之后）把一切写回「React 的静止态」。
   *
   * 为什么必须自己再写一遍：React 只在 style prop 的值变了才动 DOM，而「拖了 50px
   * 又回到原来那一张」时所有 prop 都原样不变，卡片会永远停在手指松开的位置。
   * 而且 `setFocusedIndex` 落在同一个下标上时 React 连重渲染都可能整个跳过，
   * 拖动期间手写过的 `data-focused` / 根 `data-focus-index` 更不会有人收回来。
   * `next = 0` 时 `paintCards` 算出的每一格都与 JSX 那套完全一致（连续 look 在
   * 整数点上取值不变），所以这一次调用既复位了样式，也复位了那两个观测钩子。
   * 放在 useLayoutEffect 里是为了和 React 这次「去掉 data-dragging」落在同一帧、
   * 同一批样式变更里：CSS 过渡才会从手指位置开始，而不是先闪回静止态再动。
   * （`data-offset` 在这会儿已经是新值，读它就等于读新焦点。）
   */
  useLayoutEffect(() => {
    if (dragging) return;
    dragX.current = 0;
    paintCards(0);
  }, [dragging, focus, tier, paintCards]);

  /** 步进一格（滚轮与键盘共用）：到头就停住，不循环。 */
  const step = useCallback((delta: number): void => {
    const { count: total } = live.current;
    if (total === 0) return;
    setFocusedIndex((index) => clampIndex(index + delta, total));
  }, []);

  // 滚轮必须用 passive: false 的原生监听：React 的 onWheel 是挂成 passive 的，
  // 里面 preventDefault 拦不住页面跟着一起滚（控制台还会警告）。
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const onWheel = (event: WheelEvent): void => {
      // 横滚优先（触控板两指横扫），没有横滚再吃纵向。
      const delta = event.deltaX || event.deltaY;
      if (Math.abs(delta) < WHEEL_MIN_DELTA) return;
      event.preventDefault();
      const now = Date.now();
      // 一次滑动会连发几十个 wheel：150ms 内只认第一个，否则一滑就飞出去好几张。
      if (now - wheelAt.current < WHEEL_COOLDOWN_MS) return;
      wheelAt.current = now;
      step(delta > 0 ? 1 : -1);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [step, hasStage]);

  // ←/→ 各步进一格。挂在 window 上（页面里没有别的横向手势），但两处要让路：
  // - 输入框里放行：搜索框、音量条（input[type=range]）里的左右键是光标/刻度，不是切歌；
  // - 一页里可能同时挂着好几条卡片流（「我的」页上再叠一层歌单详情就是两条），
  //   键盘只归鼠标最近待过的那一条，谁都没待过就归页面里第一条 ——
  //   否则一次 ←→ 会把底下那条看不见的也一起翻了。
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    stages.add(stage);
    const claim = (): void => {
      hoveredStage = stage;
    };
    const release = (): void => {
      if (hoveredStage === stage) hoveredStage = null;
    };
    stage.addEventListener('pointerenter', claim);
    stage.addEventListener('pointerleave', release);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        if (target.closest('input, textarea, select') !== null) return;
      }
      if (!ownsKeyboard(stage)) return;
      const now = Date.now();
      // 按住不放会连发 keydown：100ms 一格，比系统的重复速率慢一点，看着才像在翻卡片。
      if (now - keyAt.current < KEY_COOLDOWN_MS) return;
      keyAt.current = now;
      event.preventDefault();
      step(event.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      stage.removeEventListener('pointerenter', claim);
      stage.removeEventListener('pointerleave', release);
      stages.delete(stage);
      if (hoveredStage === stage) hoveredStage = null;
    };
  }, [step, hasStage]);

  /**
   * 读一次就作废：这次 click 是不是已经由 pointerup 处理过了
   * （同 lib/drag-snap.ts 的「读取即消费」写法）。
   *
   * 为什么连「没拖动的那一下点击」也要吞：pointerdown 已经把指针捕获在舞台上，
   * Chromium 会把随后的 mouse / click 一并重定向到捕获元素，卡片自己的 onClick
   * 本来就收不到 —— 与其指望它，不如在 pointerup 里一次判完，再由捕获阶段统一掐掉。
   */
  const consumeHandled = useCallback((): boolean => {
    if (handledAt.current === 0) return false;
    // 只认「刚松手」那一下：拖完把指针挪到页面别处再点，不该被吃掉。
    const fresh = Date.now() - handledAt.current < 500;
    handledAt.current = 0;
    return fresh;
  }, []);

  /**
   * 卡片被「点」了的共同语义（真人点击走 pointerup，合成点击走 click）。
   * 点旁边那张：只把它滑到正中，不播；点正中那张：歌曲模式选中并播放，
   * 卡片模式（第十八轮第 3 条：歌单列表）交给宿主的 `onCard`。
   */
  const activate = (index: number): void => {
    if (index !== live.current.focus) {
      setFocusedIndex(index);
      return;
    }
    // 卡片模式：中心卡被确认 = 宿主去开那个歌单（打开浮层 / 换页），组件不碰播放器。
    if (onCard !== undefined) {
      onCard(index);
      return;
    }
    const song = songs[index];
    if (song === undefined) return;
    onSelect?.(song);
    // 点卡片即播（对齐网易云）：队列就是当前这一面，从这张卡开始。
    if (!disablePlay) void play(songs, index);
  };

  /**
   * 松手位置落在哪张卡片上，就按哪张卡片的语义处理。
   *
   * 用 `elementFromPoint` 而不是事件 target：指针被捕获在舞台上时，
   * pointerup 的 target 是舞台本身，落点得自己命中测试一次。
   */
  const activateAt = (clientX: number, clientY: number): void => {
    const stage = stageRef.current;
    if (stage === null) return;
    const node = document.elementFromPoint(clientX, clientY);
    const card = node instanceof Element ? node.closest('.pi-songcard') : null;
    if (card === null) return;
    // 按 DOM 顺序取下标（而不是读 data-offset）：卡片一直按数据顺序排列着，
    // 这样不依赖「DOM 已经跟着最后一次渲染改过」。
    const index = Array.from(stage.querySelectorAll('.pi-songcard')).indexOf(card);
    if (index < 0) return;
    activate(index);
  };

  const applyMove = (
    pointerId: number,
    pointerType: string,
    clientX: number,
    clientY: number,
  ): void => {
    const active = gesture.current;
    if (active === null || !matchesPointer(active, pointerId, pointerType)) return;
    const dx = clientX - active.fromX;
    const dy = clientY - active.fromY;
    if (!active.moved && Math.abs(dx) + Math.abs(dy) < DRAG_TOLERANCE) return;
    active.moved = true;
    const { focus: at, count: total, offset: sideOffset } = live.current;
    /*
     * 用户 m00736 第 7 条 a：大幅度拖动时阻尼衰减。先把位移按「跟手增益」放大再交给
     * 橡皮筋 —— 小位移增益是 1，`dx * 1` 与改动前逐字相同；位移越大增益越接近上限，
     * 划一下就能多翻几张。松手落点仍由 `applyFinish` 从 `virtualFocus` 反算，
     * 所以「翻几张」是自然的：`dragX` 是多少，落点就跟着走多少。
     */
    const next = free ? dx * freeDragGain(dx, sideOffset) : dx;
    dragX.current = rubberBand(next, at, total, sideOffset);
    paintCards(dragX.current);
  };

  const detach = useCallback((): void => {
    const { move, up, cancel } = bus.current;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  }, []);

  const applyFinish = (
    pointerId: number,
    pointerType: string,
    commit: boolean,
    clientX: number,
    clientY: number,
  ): void => {
    const active = gesture.current;
    if (active === null || !matchesPointer(active, pointerId, pointerType)) return;
    gesture.current = null;
    detach();
    setDragging(false);
    if (!commit) {
      // 手势被系统取消（多指抢占等）：只落回原位，不做任何判定。
      handledAt.current = 0;
      return;
    }
    if (!active.moved) {
      // 位移没过 8px：这次就是一次「点击」。在这里判而不是等 click：
      // 指针早被捕获在舞台上，那次 click 多半根本到不了卡片（见 consumeHandled）。
      handledAt.current = Date.now();
      activateAt(clientX, clientY);
      return;
    }
    const { focus: at, count: total, offset: sideOffset } = live.current;
    // 「虚拟焦点」四舍五入就是松手后该居中哪一张；到头那一侧已经在橡皮筋里被压过。
    // 必须和 rubberBand 走同一个 virtualFocus：符号只在那一处定义。
    const target = clampIndex(Math.round(virtualFocus(dragX.current, at, sideOffset)), total);
    handledAt.current = Date.now();
    setFocusedIndex(target);
  };

  // window 上的监听要能一直调到最后一次渲染的闭包（几何量、回调都可能变）。
  const api = useRef({ applyMove, applyFinish });
  api.current = { applyMove, applyFinish };
  const bus = useRef({
    move: (event: PointerEvent): void =>
      api.current.applyMove(event.pointerId, event.pointerType, event.clientX, event.clientY),
    up: (event: PointerEvent): void =>
      api.current.applyFinish(event.pointerId, event.pointerType, true, event.clientX, event.clientY),
    cancel: (event: PointerEvent): void =>
      api.current.applyFinish(
        event.pointerId,
        event.pointerType,
        false,
        event.clientX,
        event.clientY,
      ),
  });

  useEffect(() => detach, [detach]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || gesture.current !== null) return;
    const stage = stageRef.current;
    if (stage !== null) {
      // 上一次回弹还没跑完就被按住：先把过渡按到终点。否则下面第一帧就要按 dragX=0
      // 重写 transform，卡片会从「动画中间」瞬移到手指按下的位置。
      for (const el of stage.querySelectorAll('.pi-songcard')) {
        for (const animation of el.getAnimations()) {
          try {
            animation.finish();
          } catch {
            /* 无限动画/已被取消：忽略 */
          }
        }
      }
    }
    // 指针捕获失败不该让拖动整体失效（合成事件、多指抢占、元素被卸载都会抛）。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 有 window 兜底，没有捕获也能拖 */
    }
    gesture.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      fromX: event.clientX,
      fromY: event.clientY,
      moved: false,
    };
    handledAt.current = 0;
    setDragging(true);
    const { move, up, cancel } = bus.current;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  /**
   * 捕获阶段就把「已经由 pointerup 处理过」的那次 click 掐掉：
   * 否则「点旁边那张→滑过去」会顺手播了它，拖动收尾那一下也会误播。
   * 必需在捕获阶段：用冒泡阶段的话卡片自己的 onClick 已经先跑完了。
   */
  const onStageClickCapture = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!consumeHandled()) return;
    event.stopPropagation();
    event.preventDefault();
  };

  /**
   * 卡片自己的 click 只接「合成点击」（`el.click()`、键盘回车、读屏软件）：
   * 真人鼠标/触摸那一下已经在 pointerup 里判完并吞掉了（见 consumeHandled）。
   * 合成点击拿不到 pointerdown，也就没有「点旁边只聚焦」的上下文，
   * 所以歌曲模式沿用老语义直接播这一首 —— 桌面冒烟正是靠 `cards[i].click()` 逐首验证换源出声；
   * 卡片模式按原来 `PlaylistCoverflow.onCardClick` 的语义：只有点中心卡才算「进入」。
   */
  const onCardClick = (event: ReactMouseEvent<HTMLButtonElement>, index: number): void => {
    if (event.detail !== 0) return;
    setFocusedIndex(index);
    if (onCard !== undefined) {
      if (index === live.current.focus) onCard(index);
      return;
    }
    const song = songs[index];
    if (song === undefined) return;
    onSelect?.(song);
    if (!disablePlay) void play(songs, index);
  };

  if (count === 0) {
    // 卡片模式（歌单列表）把三种空态文案（读取失败 / 正在读 / 真的没有）交给宿主传进来。
    return <div className="pi-placeholder">{empty ?? '这里还没有内容。'}</div>;
  }

  return (
    <div
      className="pi-songcards"
      ref={rootRef}
      data-song-cards
      data-song-card-flow
      data-song-cards-size={tier}
      // 静止时=当前焦点；拖动中由 paintCards 实时写成「离中心最近那张」的下标。
      data-focus-index={focus}
      data-dragging={dragging ? 'true' : 'false'}
      // 几何量的单一来源在 TS（GEOMETRY）：只把封面边长交给 CSS，
      // 横向位移由每张卡片自己的 inline transform 算，CSS 不需要知道 sideOffset。
      style={{ '--pi-sc-cover': `${cover}px` } as CSSProperties}
    >
      <div
        className="pi-songcards__stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={(event) =>
          applyMove(event.pointerId, event.pointerType, event.clientX, event.clientY)
        }
        onPointerUp={(event) =>
          applyFinish(event.pointerId, event.pointerType, true, event.clientX, event.clientY)
        }
        onPointerCancel={(event) =>
          applyFinish(event.pointerId, event.pointerType, false, event.clientX, event.clientY)
        }
        onClickCapture={onStageClickCapture}
      >
        {models.map((model, index) => {
          const d = index - focus;
          const look = lookOf(d);
          const coverUrl = coverAt(model.coverUrl ?? undefined, coverPixels);
          const active = model.key === currentId;
          return (
            <button
              key={model.key}
              type="button"
              className="pi-songcard"
              data-song-card={model.key}
              data-offset={d}
              // 静止时的「谁是中心」；拖动中由 paintCards 按连续距离实时改写
              // （松手后 useLayoutEffect 会把它连同 style 一起交还给这里的渲染值）。
              data-focused={d === 0 ? 'true' : 'false'}
              // 只画中心附近那几张；远处的留在 DOM 里但不参与绘制，也不参与中心判定。
              data-far={Math.abs(d) > SHOWN_RADIUS ? 'true' : 'false'}
              // 与 LikedWall 一样直接传布尔量：CSS 端只用 [data-active='true'] 选择器。
              data-active={active}
              // 调用方自己的抓手（歌曲模式：加歌面板的 data-addtracks-row / data-addtracks-add；
              // 卡片模式：歌单列表的 data-pl-cover-card）。
              {...model.data}
              style={{
                transform: cardTransform(d, offset, 0, look),
                zIndex: look.zIndex,
                opacity: look.opacity,
              }}
              onClick={(event) => onCardClick(event, index)}
              title={`${model.title} - ${model.meta}`}
              // 歌单卡片（卡片模式）保留原来那句无障碍标签；歌曲卡片以前没有，就不加。
              aria-label={
                cardMode ? (model.meta === '' ? model.title : `${model.title}，${model.meta}`) : undefined
              }
            >
              {/* 没有封面时这一层本身就是占位块（背景/描边由 CSS 给），不再引入图标依赖。 */}
              <span className="pi-songcard__cover">
                {coverUrl ? <img src={coverUrl} alt="" loading="lazy" draggable={false} /> : null}
              </span>
              <span className="pi-songcard__name">
                {model.title}
                {model.badge !== undefined ? (
                  <span
                    className="pi-badge"
                    style={{
                      marginLeft: 8,
                      borderColor: 'var(--pi-text-tertiary)',
                      color: 'var(--pi-text-tertiary)',
                    }}
                  >
                    {model.badge}
                  </span>
                ) : null}
              </span>
              <span className="pi-songcard__meta">{model.meta}</span>
            </button>
          );
        })}
      </div>

      <div className="pi-songcards__bar">
        <span className="pi-songcards__count">
          {focus + 1} / {count}
        </span>
        <span className="pi-songcards__hint">
          {hint ?? '滚轮 / ←→ / 拖动切换，点中心卡片播放'}
        </span>
      </div>
    </div>
  );
}
