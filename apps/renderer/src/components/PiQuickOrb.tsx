import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import {
  QUICK_SWIPE_LATCH_THRESHOLD,
  QUICK_SWIPE_THRESHOLD,
  QUICK_SWIPE_UNLOCKED,
  QUICK_TREND_THRESHOLD,
  quickDragTrend,
  quickSwipeDirection,
  quickSwipeLatch,
  type QuickSwipeDirection,
  type QuickSwipeLatch,
} from './quick-swipe';
import { Icon, type IconName } from './Icons';
import type { UiStyle } from '../state/ui';
import '../styles/quick-orb.css';

export {
  QUICK_SWIPE_LATCH_THRESHOLD,
  QUICK_SWIPE_THRESHOLD,
  QUICK_TREND_THRESHOLD,
  quickDragTrend,
  quickSwipeDirection,
  quickSwipeLatch,
};
export type { QuickSwipeDirection, QuickSwipeLatch };

/**
 * 快捷球：播放页空白处按下去，就在**那一点**冒出来的圆形 PI 键。
 *
 * 第十六轮第 6 条（中文用户反馈）：「删去悬浮球，歌曲播放页点击任意空白位置在对应位置
 * 浮现一个 pi 图标圆形按键。向上划则打开……六块按键，向下划则打开搜索，向右划打开……
 * 小设置页」。
 *
 * 第十七轮第 1 条又改了三处，都在这个文件里：
 * ① **半径减到 60%**（30 → 18，直径 60 → 36）：上一版球太大，压在封面上像一块膏药；
 * ② **跟手**：宿主在空白处的 `pointerdown` 里把指针 id 递进来，挂载时直接当成拖动起点
 *    （见下面的 useEffect），所以「按下去一路拖」不用先松手再按球；
 * ③ **暗槽**：一有拖动趋势（9px，比正式阈值 28px 早得多）就在趋势方向摊开一条凹槽，
 *    槽头上是图标 + 文案（图 1 那条槽的样子）。左槽是两个排版图标——左划切平凡/先锋。
 *
 * 用户 m00001 第 1 条又改了两处（把第十八轮第 2 条的两个决定翻了回来）：
 * ① **回到「点哪儿在哪儿冒」**：宿主重新把 `event.clientX/clientY` 递给 `summonQuick`；
 *    `quickOrbHomePoint()` 现在只留给键盘快捷键那条路兜底（按 tab / ctrl+a 时屏幕上
 *    通常没有球，用那个家位把它叫出来）。
 * ② **拖动不搬基准点**：球的**基准点**（根节点坐标）从按下那一刻起就钉死不动，被拖的是
 *    球在**暗槽里的位置**——趋势那一轴上最多滑 `ORB_GROOVE_SLIDE_MAX`，松手回槽底。
 *    所以长按拖动再也不会把整颗球（连槽）搬到别处去。
 *
 * 用户 m00736 第 2 条又改了三处，都在这个文件里：
 * ① **只活到松手**：「圆球在鼠标松开后就消失，然后下次按下鼠标再出现」。所以球在
 *    播放页 `pointerdown` 那一刻浮现，`pointerup` 就收掉；松手同时也是「选中暗槽方向」
 *    的那一下——`onRelease` 在 `onSwipe` / `onTap` **之后**回调，卡片照开，走人的只是球。
 *    （用户 m04407 第 4 条把「松手就选中方向」又收紧成了「松手时球得抵在暗槽末端」，见下。）
 * ② **暗槽明显缩短**：`--pi-orb-slot-len` 118 → 78px（参考图 2 那种「小胶囊」），
 *    球在槽里的行程跟着这个新几何收放（上限见下面 `ORB_GROOVE_SLIDE_MAX` 那一段，
 *    用户 m02213 第 1 条又把它放开到槽末端）。
 * ③ **槽里的方向图案不再是「钮」**：参考图 2 左端那种直接嵌在暗槽材质上的**扁平图案**
 *    （无圆环、无边框、无底色 ⇒ `.pi-quick-orb__groove-icon`）；「抬起来的白钮」只留
 *    参考图 2 右端那一颗 `.pi-quick-orb__slot-knob`，里面装方向箭头。
 *
 * 用户 m00002 第 2/3 条又改了两处，都在这个文件里：
 * ① **槽上不留文字、也不留白钮**：整块 `.pi-quick-orb__slot`（竖排「歌单」/「搜索」文案 +
 *    白描边圆钮 + 方向箭头）删掉了，槽上只剩末端一枚扁平图标（`data-quick-orb-flat`）。
 *    文案没有丢——它挪进了球体的 `aria-label`（屏幕阅读器读得到，屏幕上不显示）。
 * ② **方向锁**：`const [latch, setLatch] = useState<QuickSwipeLatch>(QUICK_SWIPE_UNLOCKED)`。
 *    每次 `pointermove` 调 `quickSwipeLatch(latchRef.current, dx, dy)`；离开基准点 24px 之后
 *    `direction` 被钉死，槽不再跟着指针改朝换代，只有回到基准点 24px 以内才解锁重选。
 *    判定与阈值全在 `quick-swipe.ts`，这个文件只搬运结果。
 *
 * 用户 m04407 第 4 条又改了**触发条件**这一处，在这个文件里：
 * 「圆球的拖拽动画划到暗槽的末端才触发对应功能（歌曲选择页之类）」。
 * 旧规则只问 `quickSwipeDirection` 的 28px 方向阈值过没过：球划出去一小段（哪怕只走完
 * 暗槽行程的一半）松手就开卡。现在松手那一刻球必须**已经抵在暗槽末端**——`grooveSlide`
 * 把行程夹在 `[0, ORB_GROOVE_SLIDE_MAX]` 里，所以「抵到末端」就是 `slide === 58`（球身正好
 * 填满槽末端那半个圆头，见下面 `ORB_GROOVE_SLIDE_MAX` 那一段几何推导）。
 * 半程松手＝这一次拖拽没选中任何方向，**什么卡片都不开**。
 * 判定取的是**松手那一刻**球在槽里的位置（`slideRef`，跟着指针走的最后一次采样），所以
 * 「拖到末端又往回拖一点再松手」＝没到末端、不开卡；而 `onRelease`（松手即收，用户
 * m00736 第 2 条）**任何一条路都照旧调用**，否则球会永远挂在屏幕上。
 *
 * 这个组件只负责「出现在哪」和「被往哪边划了」，**不**负责打开哪张卡片——
 * 卡片由使用方（HomePage）根据 `onSwipe` 收到的方向自己挂。
 *
 * ## data-* 契约（冒烟/选择器靠它找节点，不要改名）
 * - 根节点 `.pi-quick-orb`：`data-quick-orb="true"`、
 *   `data-quick-orb-x={x}` / `data-quick-orb-y={y}`（**原始**视口坐标，即使为了
 *   不超出屏幕做过边缘收敛，这里报的仍是调用方给的点）、
 *   `data-quick-orb-hint`（**当前槽指的方向**：`up|down|right|left|none`）、
 *   `data-quick-orb-latch`（**已锁死**的方向，用户 m00002 第 3 条新增：`up|down|right|left|none`，
 *   `none` = 还没锁、暗槽还能改朝换代；锁上之后 `hint` 不再随指针变化，两者会一直相等）、
 *   `data-quick-orb-drag`（指针是否正按着）、`data-quick-orb-style={uiStyle}`、
 *   `data-quick-orb-slide`（球在暗槽里滑出去多少 px，用户 m00001 第 1 条）。
 * - 球体 `.pi-quick-orb__ball`：`data-quick-orb-ball="true"`（用户 m00001 第 1 条起它外面
 *   多包了一层 `.pi-quick-orb__sled`，滑出去的位移加在壳上；找球一律用 `[data-quick-orb-ball]`）。
 * - 暗槽 `.pi-quick-orb__groove`：`data-quick-orb-groove={槽指的方向}`；
 *   槽**末端**那枚图标：`data-quick-orb-flat={槽指的方向}`（用户 m00002 第 2 条后它是槽上唯一的图形）。
 * - **已删除的抓手**（用户 m00002 第 2 条，`.pi-quick-orb__slot` 整块连同竖排文案一起删了）：
 *   `data-quick-orb-slot`、`data-quick-orb-hint-badge`。旧的冒烟脚本如果读这两个，会拿到 `null`。
 *
 * ## 为什么根节点不接指针事件
 * 播放页的「按空白处」判定是 `closest('button, a, input, …')`（见
 * `pages/HomePage.tsx` 的 `.pi-home__stage` 指针处理）。所以根节点设成
 * `pointer-events: none`、只有球体是 `auto`：点在球的留白上会穿透到播放页，
 * 等于「在别处按了空白」，不会平白多冒一个球出来。
 */

/** 球的半径（px）。第十七轮第 1 条「半径减小到 60%」：30 → 18。视口边缘收敛按它留安全距离。 */
const ORB_RADIUS = 18;

/**
 * 球能在暗槽里滑多远（px，用户 m00001 第 1 条；行程按用户 m00736 第 2 条缩短后的槽重算）。
 *
 * 上限 = **一直滑到槽末端那半个圆头里**（用户 m02213 第 1 条：「圆球不能拖拽到暗槽一端，
 * 我希望可以拖拽到一端」）：
 *   槽长 `--pi-orb-slot-len` = 78px；槽的横截面 `--pi-orb-groove-w` = 36 × 1.08 = 38.88px；
 *   槽末端圆头的**圆心**离球心 78 − 38.88/2 = 58.56px —— 球心滑到这里，球身正好把那个圆头
 *   填满，也就是「拖到了暗槽的一端」；拖动中的球半径是 18 × 1.08 = 19.44px。
 * 末端那枚图标（`--pi-orb-flat-inset` = 58.56px）正好压在行程最后 22px 上，所以不再像旧版
 * 那样把球挡在图标外面（旧上限 28 = 图标近边 47.56 − 球半径 19.44），改成球靠近时让图标
 * 渐隐（`--pi-orb-icon-fade`，见下面 `iconFade` 与 `quick-orb.css`），球照旧滑到底。
 */
const ORB_GROOVE_SLIDE_MAX = 58;

/** 图标开始渐隐 / 完全隐没的行程（px）：球心越过 30 就压到图标近边，50 左右整枚盖住。 */
const ORB_ICON_FADE_FROM = 30;
const ORB_ICON_FADE_TO = 50;

/** 球逼近槽末端时末端图标的透明度：1 = 全亮，0 = 全隐。 */
function grooveIconFade(slide: number): number {
  if (slide <= ORB_ICON_FADE_FROM) return 1;
  if (slide >= ORB_ICON_FADE_TO) return 0;
  return (ORB_ICON_FADE_TO - slide) / (ORB_ICON_FADE_TO - ORB_ICON_FADE_FROM);
}

/** 把一次拖动的位移投影到趋势方向那一轴上，再夹进 `[0, ORB_GROOVE_SLIDE_MAX]`。 */
function grooveSlide(dir: QuickSwipeDirection, dx: number, dy: number): number {
  const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
  return Math.min(Math.max(along, 0), ORB_GROOVE_SLIDE_MAX);
}

/**
 * 各方向划开之后会打开什么。
 *
 * 用户 m00002 第 2 条（「不要有文字提示，直接在暗槽末端加个图标就行」）之后它**不再画在槽上**，
 * 只剩喂给球体 `aria-label` 这一条用途——屏幕阅读器仍然需要文字，屏幕上则一个提示字都没有。
 */
const DEFAULT_HINT_LABELS: Record<QuickSwipeDirection, string> = {
  up: '歌单',
  down: '搜索',
  right: '设置',
  left: '平凡 / 先锋',
};

/** 上/下/右三槽**末端**各配一颗图标（用户 m00002 第 2 条：歌单 → list、搜索 → search、设置 → settings）。 */
const SIDE_ICON: Record<'up' | 'down' | 'right', IconName> = {
  up: 'list',
  down: 'search',
  right: 'settings',
};

/** 两套排版的图标：平凡 = 三条整行（列表），先锋 = 四宫格（拼贴 / 卡片）。 */
const STYLE_ICON: Record<UiStyle, IconName> = { plain: 'bars', avant: 'grid' };

const STYLE_LABEL: Record<UiStyle, string> = { plain: '平凡', avant: '先锋' };

export interface PiQuickOrbProps {
  /** 出现的位置（视口坐标，一般直接给 `event.clientX / clientY`）。 */
  x: number;
  y: number;
  /**
   * 划过球体时回调，方向已由 `quickSwipeDirection` 判好（对角线不会回调）。
   *
   * 用户 m04407 第 4 条：**只有球已经滑到暗槽末端**（松手那一刻 `slide === 58`）才会回调；
   * 半程松手、或抵到末端但位移在对角模糊区（`quickSwipeDirection` 返回 `null`）时都不回调。
   */
  onSwipe: (direction: QuickSwipeDirection) => void;
  /** 收回这个球（Esc）。不给就收不回去，由使用方在按空白时自己关。 */
  onDismiss?: () => void;
  /**
   * 点了一下但没划时的回调；不给就什么都不做。
   *
   * 用户 m04407 第 4 条把「点了一下」收紧成**球一次都没离开槽底**（松手时 `slide === 0`，
   * 也就是「按下去、没动、抬手」）。滑出去过就一律不当点击——包括半程松手那条新路。
   */
  onTap?: () => void;
  /**
   * 松手（用户 m00736 第 2 条：「圆球在鼠标松开后就消失，然后下次按下鼠标再出现」）。
   *
   * 在 `onSwipe` / `onTap` **之后**回调，所以「松手同时划开卡片」照旧成立；宿主拿它去播
   * 收起动画（`leaving`）并摘掉整颗球。`pointercancel` 也走它——否则指针被系统掐掉
   * （触摸被抢、窗口失焦）时球会一直挂在屏幕上，没有第二次 pointerup 来收它。
   * 用户 m04407 第 4 条：半程松手（没到暗槽末端、什么卡都不开）那条路**也**要回调它，
   * 收球与开卡是两条线，这里是**无条件**的。
   */
  onRelease?: () => void;
  /** 覆盖暗槽文案，键缺省时用默认（上=歌单 / 下=搜索 / 右=设置 / 左=平凡·先锋）。 */
  hintLabels?: Partial<Record<QuickSwipeDirection, string>>;
  /** 当前界面风格：只用来画左槽那两颗图标（切换本身由宿主的 `onSwipe('left')` 干）。 */
  uiStyle?: UiStyle;
  /**
   * 宿主（HomePage 在空白处的按下）**先一步**按住的那根指针。
   * 球挂载时直接把它当成拖动起点，于是「从空白按住一路拖」与
   * 「按住球再拖」走的是同一套 move/up 逻辑，不需要两套手势代码。
   * 传对象不传裸 id：鼠标的 pointerId 恒为 1，靠身份变化才能每次按下都重新接管。
   * 注意（用户 m00001 第 1 条）：这份起点**不再**被拿来挪球——球的基准点就是宿主给的
   * `x/y`（也就是按下的那一点），拖动只改「球在槽里的位置」。
   */
  follow?: { pointerId: number } | null;
  /**
   * 第十八轮第 2 条的 `onMoveEnd`（松手把落点交回宿主）已随用户 m00001 第 1 条删掉：
   * 基准点不动，就没有「落点」要交回去了。
   */
  /**
   * 第十八轮第 2 条：宿主已判定「指针离开了互动范围」，球正在向内塌陷。
   * 置真时根节点挂 `data-quick-orb-leaving="true"`，由 CSS 播 `pi-quick-orb-out`
   * （缩到 0.32 并淡出），宿主在 `QUICK_ORB_LEAVE_MS` 之后才真正把它卸载。
   */
  leaving?: boolean;
}

/** 拖动起点：记着是哪个指针，多指时不会互相串。 */
interface DragOrigin {
  pointerId: number;
  x: number;
  y: number;
}

/** 视口边缘收敛：球心离边至少一个半径，免得半个球出屏。 */
function clampToViewport(x: number, y: number): { left: number; top: number } {
  const width = typeof window === 'undefined' ? x : window.innerWidth;
  const height = typeof window === 'undefined' ? y : window.innerHeight;
  return {
    left: Math.min(Math.max(x, ORB_RADIUS), Math.max(ORB_RADIUS, width - ORB_RADIUS)),
    top: Math.min(Math.max(y, ORB_RADIUS), Math.max(ORB_RADIUS, height - ORB_RADIUS)),
  };
}

/**
 * 球的固定家位（第十八轮第 2 条定的坐标，用户 m00001 第 1 条之后**换了用途**）。
 *
 * 第十八轮时它是「空白处按下时的落点」；用户 m00001 第 1 条把那个决定推翻了
 * （「圆球只在鼠标点击对应的位置出现」），空白处按下重新用 `event.clientX/clientY`。
 * 这个「视口右侧、垂直居中」的点现在只给**键盘快捷键**兜底——按 tab（歌单选择页）/
 * ctrl+a（快捷设置页）时屏幕上通常没有球，就近挑一个离底部药丸与左下名片都最远、
 * 又不压住舞台中央歌词的地方把它叫出来。
 */
export function quickOrbHomePoint(): { x: number; y: number } {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth;
  const height = typeof window === 'undefined' ? 0 : window.innerHeight;
  // 圆心离右缘两个半径 ⇒ 整个球都在屏内，且离边一个球的呼吸位。
  return { x: width - ORB_RADIUS * 2, y: Math.round(height / 2) };
}

/**
 * 向内塌陷动画的时长（ms）；`quick-orb.css` 里 `pi-quick-orb-out` 是 0.2s。
 *
 * 用户 m00736 第 2 条起它服务的对象变了：不再是「指针离开互动范围」那一下，而是**松手**
 * 那一下（宿主 `HomePage.tsx` 的 `QuickDock.onOrbRelease` 按这个时长收球）。第十八轮那个
 * `QUICK_ORB_INTERACT_RANGE = 52` 已随那套逻辑一并删掉（全仓除此处注释外无引用）。
 */
export const QUICK_ORB_LEAVE_MS = 200;

export function PiQuickOrb({
  x,
  y,
  onSwipe,
  onDismiss,
  onTap,
  onRelease,
  hintLabels,
  uiStyle = 'plain',
  follow = null,
  leaving = false,
}: PiQuickOrbProps): ReactNode {
  const origin = useRef<DragOrigin | null>(null);
  /**
   * 球在暗槽里滑出去多少（px，沿趋势方向；0 = 待在槽底的基准点上）。
   * 用户 m00001 第 1 条：拖动改的是**这个**，根节点（基准点）一动都不动。
   */
  const [slide, setSlide] = useState(0);
  /** 指针是不是正按着（原来由 `dragPos` 兼职，它没了之后单独记一个，`data-quick-orb-drag` 要它）。 */
  const [pressing, setPressing] = useState(false);
  /**
   * 本次拖拽的**方向锁**（用户 m00002 第 3 条）：离开基准点 24px 就把方向钉死，
   * 之后往上/往下拖都换不掉那条暗槽，只有把球划回基准点附近才能重新选。
   * 判定本体在 `quick-swipe.ts` 的纯函数 `quickSwipeLatch` 里，这里只放它的返回值。
   */
  const [latch, setLatch] = useState<QuickSwipeLatch>(QUICK_SWIPE_UNLOCKED);
  /**
   * 锁的**最新值**再留一份 ref。
   *
   * 手势监听挂在 window 上、且依赖数组是 `[]`（只挂一次），所以 `onMove` 里读 `latch`
   * 会读到首次渲染那一份旧 state——每次 move 都判成「没锁」，锁就白上了。
   * 写 state 是为了重渲染，写 ref 是为了下一次 move 能读到真值。
   */
  const latchRef = useRef<QuickSwipeLatch>(QUICK_SWIPE_UNLOCKED);

  /**
   * `slide` 的**最新值**再留一份 ref（用户 m04407 第 4 条），理由与 `latchRef` 一字不差：
   * `onUp` 也活在那个依赖数组为 `[]` 的手势 effect 里，闭包里读 `slide` 只会拿到首次渲染
   * 那份 state（永远是 `0`），于是每一次松手都会被判成「球还在槽底、没到末端」——
   * 卡片再也开不出来。写 state 是为了让球跟手动，写 ref 是为了「松手那一刻」读得到真值。
   */
  const slideRef = useRef(0);

  // Esc 收回：和悬浮球的老习惯一致。
  useEffect(() => {
    if (!onDismiss) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  // 回调放 ref：手势监听挂在 window 上，父组件每次渲染换函数身份不该导致反复解绑重挂。
  const swipeRef = useRef(onSwipe);
  const tapRef = useRef(onTap);
  const releaseRef = useRef(onRelease);
  swipeRef.current = onSwipe;
  tapRef.current = onTap;
  releaseRef.current = onRelease;

  // 调用方给的落点也放一份 ref：下面那个「接管别人按下的指针」的 effect 只该在
  // pointerId 变化时跑一次，把 x/y 写进依赖会让它在宿主每次挪球时重新接管。
  const baseRef = useRef({ x, y });
  baseRef.current = { x, y };

  /**
   * 接管「宿主先按下的那一次指针」（第十七轮第 1 条的长按浮现）。
   *
   * 时序：空白处 `pointerdown` → 宿主 `setQuickPos` + `setFollowPointerId` → 本组件挂载。
   * 这一下 pointerdown 我们没收到（那时球还不存在），所以起点从 props 里补。
   * 之后的 pointermove / pointerup 都由 window 上的监听收到，跟手与手势判定照旧。
   */
  useEffect(() => {
    if (!follow) return;
    const base = baseRef.current;
    origin.current = { pointerId: follow.pointerId, x: base.x, y: base.y };
    // 新的一次拖拽从「没锁、没倾向」开始（用户 m00002 第 3 条）。
    latchRef.current = QUICK_SWIPE_UNLOCKED;
    setLatch(QUICK_SWIPE_UNLOCKED);
    // 用户 m04407 第 4 条：新的一次拖拽也从「球还在槽底」开始——`slideRef` 与 state 一起归零，
    // 否则半个行程的旧读数会被下一次松手当成「已到末端」。
    slideRef.current = 0;
    setSlide(0);
    setPressing(true);
  }, [follow]);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    // 鼠标只认左键；触摸/触控笔没有 button 语义（button === 0）。
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    origin.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    // 按下 = 新的一次拖拽 ⇒ 方向锁清空（用户 m00002 第 3 条）。
    latchRef.current = QUICK_SWIPE_UNLOCKED;
    setLatch(QUICK_SWIPE_UNLOCKED);
    // 用户 m04407 第 4 条：行程也归零（ref 那份是松手时的判据，必须跟 state 同步清）。
    slideRef.current = 0;
    setSlide(0);
    setPressing(true);
    // 指针捕获只当加速器（手滑出球还能收到事件）；**拿不到也不影响手势**——真正的
    // 兜底是下面那个 window 上的监听。这里必须 try：合成输入 / 已经有其它元素捕获
    // 同一个 pointerId 时，setPointerCapture 会抛，抛出去会把 onPointerDown 后半截吃掉。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 捕获失败无所谓，move/up 由 window 兜底 */
    }
  };

  /**
   * 手势的 move / up 挂在 **window** 上，不挂球自己。
   *
   * 球直径只有 36px，而「上划 / 下划 / 右划」的终点天生在球外：只监听球自己的
   * `pointerup`，只要指针在抬起前离开球（真实鼠标快划、触摸拖走，以及冒烟的
   * `sendInputEvent` 合成拖拽都如此），这一划就静默丢掉。挂 window 之后，起点仍在球上
   * （或由 `followPointerId` 补上），终点在哪都算数。
   */
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const start = origin.current;
      if (!start || start.pointerId !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      // 用户 m00002 第 3 条：方向只选一次。`quickSwipeLatch` 在 9px 给出**候选**（槽照旧亮，
      // 这段还能反悔），到 24px 把候选钉成锁定方向；锁上之后只有「回到基准点 24px 以内」能解开。
      const next = quickSwipeLatch(latchRef.current, dx, dy);
      latchRef.current = next;
      setLatch(next);
      // 用户 m00001 第 1 条：基准点不动，只把位移投影到槽当前指的那一轴，算出球在槽里滑到哪。
      // 用 `next.trend`（锁定后 = 锁定方向）而不是原始趋势：锁成 right 之后再往左拖，
      // `grooveSlide` 会把负位移夹到 0，球只是退回槽底，不会被推向反方向的槽。
      const nextSlide = next.trend === null ? 0 : grooveSlide(next.trend, dx, dy);
      // 用户 m04407 第 4 条：state 管重渲染，ref 管「松手那一刻读得到」——`onUp` 同在这个
      // 依赖数组为 `[]` 的 effect 里，闭包里的 `slide` 永远是首帧那份，判不出到没到末端。
      slideRef.current = nextSlide;
      setSlide(nextSlide);
    };
    const onUp = (event: PointerEvent): void => {
      const start = origin.current;
      if (!start || start.pointerId !== event.pointerId) return;
      origin.current = null;
      latchRef.current = QUICK_SWIPE_UNLOCKED;
      setLatch(QUICK_SWIPE_UNLOCKED);
      // 用户 m04407 第 4 条：判据是**松手这一刻**球在暗槽里的位置，所以在把它清零之前先读下来。
      // 读到的就是最后一次 `pointermove` 采样出来的行程（`setSlide` 跟着指针走）：
      // 「拖到末端又往回拖一点再松手」在这里读到的是往回拖之后的较小值 —— 没到末端，不开卡。
      const slideAtRelease = slideRef.current;
      slideRef.current = 0;
      setSlide(0);
      setPressing(false);
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      // 用户 m04407 第 4 条：「圆球的拖拽动画划到暗槽的末端才触发对应功能（歌曲选择页之类）」。
      // 旧规则只问 `quickSwipeDirection` 那 28px 方向阈值过没过，划出去一小段松手就开卡；
      // 现在得球身已经填满槽末端那半个圆头（`grooveSlide` 是夹紧的，抵到就是等于上限）才认
      // 这次拖拽选中的方向，半程松手＝没选中方向＝什么卡片都不开。
      if (slideAtRelease >= ORB_GROOVE_SLIDE_MAX) {
        const direction = quickSwipeDirection(dx, dy);
        // 到是到了末端，但位移落在对角模糊区（`quickSwipeDirection` 返回 `null`）：
        // 这次也不猜方向（`quick-swipe.ts` 的老脾气：宁可这一下不响应，也不要开错卡）。
        if (direction) swipeRef.current(direction);
      } else if (slideAtRelease === 0) {
        // 球**一次都没离开过槽底** = 「原地一点」，照旧走 `onTap`。
        // 用户 m04407 第 4 条之后这里刻意**不**把「拖出去了但没到末端」也当点击：球确实被拖离了
        // 基准点、中途还摊开过一条暗槽（`data-quick-orb-slide` 一路在报非零），读成「点了一下」
        // 既不是用户干的事，也会让「半程松手不许开卡」这条新规矩漏出一条开卡的路。
        // 而 `slideAtRelease === 0` 已经把真正的点击圈干净了：按下去、没动、抬手。
        tapRef.current?.();
      }
      // 用户 m00736 第 2 条：松手即收——不管这一下是划到末端开了卡、半程松手什么都没开，
      // 还是原地一点，球都交回宿主收掉（卡片由 `onSwipe` 那边照开，收球与开卡是两条线）。
      // 用户 m04407 第 4 条：这条**任何一条路都要走**，漏掉它球就永远挂在屏幕上。
      releaseRef.current?.();
    };
    const onCancel = (event: PointerEvent): void => {
      const start = origin.current;
      if (!start || start.pointerId !== event.pointerId) return;
      origin.current = null;
      latchRef.current = QUICK_SWIPE_UNLOCKED;
      setLatch(QUICK_SWIPE_UNLOCKED);
      // 用户 m04407 第 4 条：取消这一路不判方向、也不开卡，行程照旧清干净（ref 与 state 一起）。
      slideRef.current = 0;
      setSlide(0);
      setPressing(false);
      // 指针被系统掐掉（触摸被抢、窗口失焦）也算松手：否则这颗球永远挂在那儿（用户 m00736 第 2 条）。
      releaseRef.current?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, []);

  // 基准点（用户 m00001 第 1 条）：只由宿主给的 `x/y` 决定，拖动不再改写它。
  const position = clampToViewport(x, y);
  // 暗槽要摊开、要显示哪一颗图标的方向：锁定后恒等于锁定方向，没锁时是候选
  // （用户 m00002 第 3 条之前这里直接是每次 move 重算的趋势，所以槽会半路改朝换代）。
  const active = latch.trend;
  const nextStyle: UiStyle = uiStyle === 'plain' ? 'avant' : 'plain';
  // 滑出去的方向就是趋势方向：右/下为正、左/上为负；没趋势时归 0（球还在槽底）。
  const sledX = active === 'right' ? slide : active === 'left' ? -slide : 0;
  const sledY = active === 'down' ? slide : active === 'up' ? -slide : 0;
  // 用户 m02213 第 1 条：球滑得到槽末端了，末端那枚图标得让路——球越近越淡（`grooveIconFade`）。
  const iconFade = grooveIconFade(slide);

  return (
    <div
      className="pi-quick-orb"
      data-quick-orb="true"
      data-quick-orb-x={x}
      data-quick-orb-y={y}
      data-quick-orb-hint={latch.trend ?? 'none'}
      data-quick-orb-latch={latch.direction ?? 'none'}
      data-quick-orb-drag={pressing ? 'true' : 'false'}
      data-quick-orb-style={uiStyle}
      data-quick-orb-leaving={leaving ? 'true' : 'false'}
      data-quick-orb-slide={Math.round(slide)}
      data-quick-orb-icon-fade={iconFade.toFixed(2)}
      style={
        {
          left: `${position.left}px`,
          top: `${position.top}px`,
          '--pi-orb-icon-fade': String(iconFade),
        } as CSSProperties
      }
    >
      {/* 暗槽（用户 m00736 第 2 条缩短成参考图 2 那种小胶囊）：有拖动趋势才摊开，
          方向就是当前槽指的方向（用户 m00002 第 3 条起 = 锁定方向）。
          用户 m00002 第 2 条：槽上**不再有**任何文字与白钮 —— 整块 `.pi-quick-orb__slot`
          （竖排文案 + 白描边圆钮 + 方向箭头）已经删掉，末端只剩下面这枚扁平图标。 */}
      <div
        className="pi-quick-orb__groove"
        data-quick-orb-groove={latch.trend ?? 'none'}
        aria-hidden="true"
      >
        <span className="pi-quick-orb__groove-track" />
        {/* 用户 m00736 第 2 条（参考图 2 左端）：方向图案**直接嵌在暗槽材质上**——
            扁平、无圆环、无边框、无底色，不再是一颗装着图标的描边钮。
            用户 m00002 第 2 条把它从槽身挪到了**槽末端**（`--pi-orb-flat-inset` 现在是算出来的），
            并且去掉白边后它就是「暗槽末端的一个图标」：歌单 → list、搜索 → search、设置 → settings、
            左槽 → 划过去会切到的那套排版图标。 */}
        {active ? (
          <span className="pi-quick-orb__groove-icon" data-quick-orb-flat={active}>
            <Icon name={active === 'left' ? STYLE_ICON[nextStyle] : SIDE_ICON[active]} size={15} />
          </span>
        ) : null}
      </div>
      {/* 球在暗槽里滑动的那段位移加在这层壳上（用户 m00001 第 1 条）：基准点（根节点）
          钉死不动，壳带着球沿趋势方向滑出去；球自己那份 scale（hover / 拖动）仍归 CSS 管。 */}
      <span
        className="pi-quick-orb__sled"
        style={
          {
            '--pi-orb-sled-x': `${sledX}px`,
            '--pi-orb-sled-y': `${sledY}px`,
          } as CSSProperties
        }
      >
        <button
          type="button"
          className="pi-quick-orb__ball"
          data-quick-orb-ball="true"
          aria-label={`快捷操作：向上划${hintLabels?.up ?? DEFAULT_HINT_LABELS.up}、向下划${hintLabels?.down ?? DEFAULT_HINT_LABELS.down}、向右划${hintLabels?.right ?? DEFAULT_HINT_LABELS.right}、向左划切换${STYLE_LABEL[nextStyle]}风格`}
          onPointerDown={onPointerDown}
          onContextMenu={(event) => event.preventDefault()}
        >
          <span className="pi-quick-orb__ball-glow" aria-hidden="true" />
          <span className="pi-quick-orb__logo">PI</span>
        </button>
      </span>
    </div>
  );
}
