/**
 * 商籁**镜头追踪**（照抄 folia `sonnet/sonnetCameraTracking.ts` 的逻辑与常量，文字与代码我们重写；AGPL-3.0）。
 * 唯一偏离见下面「我们与上游的一处刻意偏离」那一节 —— `trackingFactor = 0.5`、段中心语义、
 * 装饰字过滤都**逐值照旧**，只把段内连接曲线从折线换成 C¹ 曲线。
 *
 * === 上游语义（文件头原文的意思 ✓）===
 * *"Selects render glyphs that may drive the camera and resolves their **absolute-time focus**."*
 * ⇒ 这个模块只回答一件事：**此刻镜头该对准哪里** ✓。
 *
 * === 关键数值：`trackingFactor`（这就是手感的来源 ✓）===
 * 焦点**不是**当前唱到的那个字 ✗，而是
 * **「这一段的首尾中点」与「当前字的精确位置」的**中点** ✓
 * ⇒ 镜头**永远只走一半** ✓ —— 跟得快一点会晃、完全不动又呆 ✓，一半是上游的取舍 ✓。
 *
 * ⚠ **本轮（取景语义纠正）**：帧层传给这里的系数不再是固定 0.5，而是由**唱词时间轴节奏**
 * 给的 `0.42 ~ 0.62`（密唱贴当前字、长音 / 空档更靠段中心，见 `sonnetMotion.resolveSonnetRhythmProfile`）；
 * 函数**默认值仍是 0.5**（上游语义与既有逐值用例不变）✓。
 *
 * === 另一条规则 ===
 * **装饰性节点必须先滤掉** ✓（上游注释：*"decorative render nodes must be filtered first"* ✓）
 * ⇒ 只有"语义字"（真正在唱的字 ✓）能驱动镜头 ✓，背景形状不算 ✓。
 *
 * === 我们与上游的**一处刻意偏离**：段内插值改成 C¹（三次 Hermite，照 Catmull-Rom 取切线）===
 * 上游在相邻两字的 `startTime` 之间取**线性**插值 ⇒ 焦点轨迹是**分段折线**：
 * 每一段斜率恒定、在字与字的交点处**斜率突变**。这一层上面还压着 5 抽头时间平滑
 * （`resolveSonnetSmoothedCameraFocus`，±0.12s 窗口），折线的斜率跳变被平均后仍然是**台阶**：
 * `.tmp/sonnet-probe/pivot.txt` 实测真实帧层读数为 **每约 0.13 秒一次 2.04× / 0.51× 的速度跳变**
 * （373→763→366→1577 px/s），肉眼就是"镜头一顿一顿"。
 *
 * 折中办法：保持"每个字的落点就是焦点"（值不变 ✓）、`trackingFactor` 语义不变 ✓，
 * 只把**段内的连接曲线**换成三次 Hermite：端点切线取相邻两字的**中心差分**
 * （`(下一字 − 上一字) / (下一字时刻 − 上一字时刻)`），于是
 * · 交点处**斜率连续**（C¹）⇒ 速度不再有台阶 ✓；
 * · 只有两个字时中心差分退化为该段的割线 ⇒ **逐值与线性插值完全相同**（既有用例不受影响 ✓）；
 * · 切线只由**绝对时刻与落点**算出，没有累加状态 ⇒ seek / 换帧率得到同一画面 ✓。
 */

export interface SonnetCameraTrackingGlyph {
  readonly baseX: number;
  readonly baseY: number;
  /** 这个字**开始唱**的绝对时间（秒 ✓）。 */
  readonly startTime: number;
  /** 背景形状（装饰 ✓）—— 会被滤掉 ✓。 */
  readonly isBackgroundShape?: boolean;
}

/** 只留能驱动镜头的"语义字" ✓（`isBackgroundShape === true` 的一律滤掉 ✓）。 */
export function resolveSonnetCameraTrackingGlyphs<T extends SonnetCameraTrackingGlyph>(
  glyphs: readonly T[],
): readonly T[] {
  return glyphs.filter((glyph) => glyph.isBackgroundShape !== true);
}

export interface SonnetCameraFocus {
  readonly x: number;
  readonly y: number;
}

/** 两字时刻靠得比这还近就按"同一时刻"处理（防除零，与上游的 `max(0.001, Δ)` 同口径）。 */
const MIN_SEGMENT_SPAN = 0.001;

/** 三次 Hermite 基函数：`p0/p1` 是端点值、`m0/m1` 是端点**切线 × 区间长**、`s ∈ [0, 1]`。 */
function hermiteAt(p0: number, p1: number, m0: number, m1: number, s: number): number {
  const square = s * s;
  const cube = square * s;
  return (
    (2 * cube - 3 * square + 1) * p0 +
    (cube - 2 * square + s) * m0 +
    (-2 * cube + 3 * square) * p1 +
    (cube - square) * m1
  );
}

/**
 * 此刻镜头的焦点 ✓。
 *
 * 规则：
 * · 空 ⇒ `(0, 0)` ✓；
 * · 早于首字（`time <= first.startTime`）⇒ 首字位 ✓；晚于末字（`time >= last.startTime`）⇒ 末字位 ✓；
 * · 否则在**相邻两字的 `startTime` 之间**按三次 Hermite 插值得到"精确位置" ✓（端点切线取中心差分；
 *   两个字时退化为线性 ✓）；两字同一时刻（Δ < 0.001）时直接取下一字位，避免除零 ✓；
 * · 最后统一按 `trackingFactor` 往**段中心**拉一半 ✓。
 */
export function resolveSonnetSegmentCameraFocus(
  glyphs: readonly SonnetCameraTrackingGlyph[],
  time: number,
  trackingFactor = 0.5,
): SonnetCameraFocus {
  const first = glyphs[0];
  const last = glyphs[glyphs.length - 1];
  if (first === undefined || last === undefined) {
    return { x: 0, y: 0 };
  }
  const segCenterX = (first.baseX + last.baseX) / 2;
  const segCenterY = (first.baseY + last.baseY) / 2;
  const applyFactor = (exactX: number, exactY: number): SonnetCameraFocus => ({
    x: segCenterX + (exactX - segCenterX) * trackingFactor,
    y: segCenterY + (exactY - segCenterY) * trackingFactor,
  });

  if (time <= first.startTime) {
    return applyFactor(first.baseX, first.baseY);
  }
  if (time >= last.startTime) {
    return applyFactor(last.baseX, last.baseY);
  }
  for (let index = 0; index + 1 < glyphs.length; index += 1) {
    const current = glyphs[index];
    const next = glyphs[index + 1];
    if (current === undefined || next === undefined) continue;
    if (time < current.startTime || time > next.startTime) continue;
    const span = next.startTime - current.startTime;
    if (span < MIN_SEGMENT_SPAN) {
      /* 两个字同一时刻：没有可插的区间，直接落到下一字（与上游的防除零同结果）。 */
      return applyFactor(next.baseX, next.baseY);
    }
    /*
     * 端点切线（px/秒）：**首尾两字取中心差分**（`(下一字 − 上一字) / (下一字时刻 − 上一字时刻)`），
     * 首/末区间缺另一侧邻居时退化成该段割线斜率 ⇒
     * ① 只有两个字的数据仍然是**逐值线性** ✓；
     * ② 同一个交点从左右两段算出来的切线**是同一个数** ⇒ 速度连续（C¹）✓。
     */
    const previous = glyphs[index - 1];
    const after = glyphs[index + 2];
    const spanBefore =
      previous === undefined ? span : Math.max(MIN_SEGMENT_SPAN, next.startTime - previous.startTime);
    const spanAfter =
      after === undefined ? span : Math.max(MIN_SEGMENT_SPAN, after.startTime - current.startTime);
    const slopeAtCurrentX =
      previous === undefined ? (next.baseX - current.baseX) / span : (next.baseX - previous.baseX) / spanBefore;
    const slopeAtNextX =
      after === undefined ? (next.baseX - current.baseX) / span : (after.baseX - current.baseX) / spanAfter;
    const slopeAtCurrentY =
      previous === undefined ? (next.baseY - current.baseY) / span : (next.baseY - previous.baseY) / spanBefore;
    const slopeAtNextY =
      after === undefined ? (next.baseY - current.baseY) / span : (after.baseY - current.baseY) / spanAfter;
    const s = (time - current.startTime) / span;
    return applyFactor(
      hermiteAt(current.baseX, next.baseX, slopeAtCurrentX * span, slopeAtNextX * span, s),
      hermiteAt(current.baseY, next.baseY, slopeAtCurrentY * span, slopeAtNextY * span, s),
    );
  }
  return applyFactor(first.baseX, first.baseY);
}
