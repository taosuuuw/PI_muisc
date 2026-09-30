/**
 * 「快捷球」的手势方向判定（纯函数，零依赖，可直接单测）。
 *
 * 第十六轮第 6 条（中文用户反馈）：删掉常驻悬浮球，改成「点播放页空白处**就地**冒出一个
 * 圆形的 PI 键」，然后靠**划过**这个球来打开三张拍立得卡片——
 * 上划 = 歌单六宫格、下划 = 搜索、右划 = 迷你设置。
 *
 * 判定分两步，这是刻意的：
 *   ① **阈值**：位移没过阈值就是「点了一下」，不是滑动。少这一步，用户手指在触摸板上
 *      抖两像素就会被判成滑动，点球想收回却打开了设置。
 *   ② **主轴**：主轴必须比副轴长出 `QUICK_SWIPE_DOMINANCE` 倍才算数，否则返回 `null`。
 *      四十五度斜着划属于「意图不明」，宁可这次不响应，也不要猜错方向——
 *      猜错的代价是「想搜索却打开设置」，比不响应糟得多。
 *
 * 这里不碰任何 DOM / React，坐标由调用方（`PiQuickOrb`）自己减出来。
 */

/**
 * 一次滑动要打开卡片，位移至少要有这么多像素。
 *
 * 用户 m04407 第 4 条起它**不再是充分条件**：真正的开卡闸门在 `PiQuickOrb` 那边——
 * 松手那一刻球必须已经抵在暗槽末端（`slide === ORB_GROOVE_SLIDE_MAX`），过了这条阈值
 * 却只划到半程照样什么都不开。这里这条线仍然管「是不是一次滑动 / 判不判得出方向」。
 */
export const QUICK_SWIPE_THRESHOLD = 28;

/** 主轴要比副轴长出的倍数；低于它算对角线，不判方向。 */
export const QUICK_SWIPE_DOMINANCE = 1.2;

/** 快捷球支持的四个滑动方向（`left` 目前没有对应卡片，但类型上留全）。 */
export type QuickSwipeDirection = 'up' | 'down' | 'right' | 'left';

/**
 * 由一次拖动的位移量（dx = 右为正，dy = 下为正，屏幕坐标系）判定滑动方向。
 *
 * @returns 方向；没到阈值、或落在对角线的模糊区时返回 `null`。调用方（`PiQuickOrb`）只在
 *   「球已经滑到暗槽末端」时才会拿这个方向开卡（用户 m04407 第 4 条），返回 `null` 时也不再
 *   一律当「点击」——球被拖动过就什么都不开，只有一次都没离开槽底才算点击。
 */
export function quickSwipeDirection(
  dx: number,
  dy: number,
  threshold: number = QUICK_SWIPE_THRESHOLD,
): QuickSwipeDirection | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  // ① 阈值：两轴都没过线 —— 这是点击，不是滑动。
  if (ax < threshold && ay < threshold) {
    return null;
  }

  // ② 主轴：谁明显更长听谁的；咬得太近就是对角的模糊区。
  if (ax > ay * QUICK_SWIPE_DOMINANCE) {
    return dx > 0 ? 'right' : 'left';
  }
  if (ay > ax * QUICK_SWIPE_DOMINANCE) {
    return dy > 0 ? 'down' : 'up';
  }
  return null;
}

/**
 * 「已经有朝某个方向拖的趋势」的阈值（用户第十七轮第 1 条）。
 *
 * 为什么另起一条比 `QUICK_SWIPE_THRESHOLD` 小得多的线：
 * 正式阈值决定「松手之后打开哪张卡片」，判早了代价很大（想收回球却打开了设置），所以是 28px。
 * 但**暗槽**（图 1 那条槽 + 图标）只是视觉预告，判早了没有任何代价，反而能提前告诉用户
 * 「你这一拖是有方向的」。所以它 9px 就亮，而且不要求主轴优势——对角线也先把槽亮起来。
 */
export const QUICK_TREND_THRESHOLD = 9;

/**
 * 拖动**过程中**的实时倾向（只喂给暗槽，不决定松手后的结果）。
 *
 * 和 `quickSwipeDirection` 的差别有两个，都是刻意的：
 * ① 阈值小（见上）；② 不设主轴优势，`|dx| >= |dy|` 就算横向——磨槽阶段两轴咬得近很正常，
 * 这时候返回 `null` 会让槽一闪一闪的，比猜一个方向难看得多。
 */
export function quickDragTrend(
  dx: number,
  dy: number,
  threshold: number = QUICK_TREND_THRESHOLD,
): QuickSwipeDirection | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < threshold && ay < threshold) return null;
  if (ax >= ay) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/**
 * 方向**锁定**线（用户 m00002 第 3 条）。
 *
 * 用户原话：「如果我拖拽圆球向右划，它就不能改变方向换成向上或向下的暗槽，
 * 除非把圆球划回原基准点。」
 *
 * 所以这次拖拽里方向只能被**选一次**，之后想换方向必须先把球拖回起点附近。
 * 那条「选一次」的线取 24px，理由是它卡在既有两条线中间：
 *   - 比 `QUICK_TREND_THRESHOLD = 9` 晚 ⇒ 槽亮起来之前那段仍然可以反悔（手感不变）；
 *   - 比 `QUICK_SWIPE_THRESHOLD = 28` 早 ⇒ 锁一定发生在「松手判方向」之前，
 *     不会出现「槽指着右、松手却打开上」的错位。
 * 两边各留一档余量，动的只是「锁定」这一层，正式阈值与主轴优势一个都没改。
 */
export const QUICK_SWIPE_LATCH_THRESHOLD = 24;

/**
 * 一次拖拽的「方向锁」状态（纯数据，可直接单测）。
 *
 * - `direction`：**已锁死**的方向。非 `null` 之后，本次拖拽里只有「回到基准点附近」
 *   能把它变回 `null`，别的位移一律改不动它。
 * - `trend`：喂给暗槽的实时方向。没锁定时它是**候选**（还能反悔、还会随位移换），
 *   锁定之后恒等于 `direction` —— 于是暗槽一旦摊开就定在那个方向，不会半路改朝换代。
 */
export interface QuickSwipeLatch {
  direction: QuickSwipeDirection | null;
  trend: QuickSwipeDirection | null;
}

/** 一次拖拽的起始态：既没锁、也没倾向，暗槽不摊开。 */
export const QUICK_SWIPE_UNLOCKED: QuickSwipeLatch = { direction: null, trend: null };

/**
 * 把一次拖动的位移并进「方向锁」，返回新的锁状态。
 *
 * 三档行为：
 * ① **已锁**（`prev.direction !== null`）：只认「离基准点的距离」。
 *    回到 `latchThreshold` 以内 ⇒ 解锁，方向重新可选；否则原样返回，`trend` 也保持锁定方向。
 *    注意这里量的是**欧氏距离**而不是某一轴：用户说的是「划回原基准点」，画着圈绕回来也算。
 * ② **未锁 + 位移没过趋势线**：还没趋势，返回 `QUICK_SWIPE_UNLOCKED`。
 * ③ **未锁 + 过了趋势线**：先给出**候选**方向（槽照旧 9px 就亮）；
 *    位移再长到 `latchThreshold` 才把候选钉成 `direction` —— 中间这段是唯一的反悔窗口。
 *
 * @param prev 上一次的锁状态（首次拖动传 `QUICK_SWIPE_UNLOCKED`）。
 * @param dx 相对基准点的横向位移（右为正）。
 * @param dy 相对基准点的纵向位移（下为正）。
 */
export function quickSwipeLatch(
  prev: QuickSwipeLatch,
  dx: number,
  dy: number,
  latchThreshold: number = QUICK_SWIPE_LATCH_THRESHOLD,
  trendThreshold: number = QUICK_TREND_THRESHOLD,
): QuickSwipeLatch {
  // ① 已锁：只有「回到基准点附近」这一件事能改它。
  if (prev.direction !== null) {
    if (Math.hypot(dx, dy) <= latchThreshold) return QUICK_SWIPE_UNLOCKED;
    return prev;
  }

  // ② 未锁：趋势还没有就不摊槽。
  const candidate = quickDragTrend(dx, dy, trendThreshold);
  if (candidate === null) return QUICK_SWIPE_UNLOCKED;

  // ③ 过了锁定线就把候选钉死；没过就只是候选，还能改。
  if (Math.hypot(dx, dy) >= latchThreshold) {
    return { direction: candidate, trend: candidate };
  }
  return { direction: null, trend: candidate };
}
