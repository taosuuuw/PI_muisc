/**
 * 凝彩（tempera）**shot 交接（hand-off）**的纯计算。
 *
 * 来源：`chthollyphile/folia-major@main` 的
 * `src/components/visualizer/tempera/createTemperaPixiRuntime.ts`（AGPL-3.0，
 * **只取算法与数值，代码按本仓库风格重写**；本地快照 `.folia-ref/tempera__createTemperaPixiRuntime.ts`
 * 第 549~590 行；登记见 `docs/CREDITS.md` 第 589/590 轮）。
 *
 * ⚠ **为什么需要它**：我方运行时**一帧只画一个 shot**（`TemperaTheme.tsx` 的 `tick()` 里
 * `buildTemperaFrame(...)` 只调一次），**没有"出画与入画同屏重叠"**；而三种段落转场的语义
 * 都要求两个构图同时在场。上游靠这段 hand-off 做到：**上一个 shot 过了自己的 endTime 还继续沿
 * flowAngle 推出画面、下一个前置加载从上游推进来**，窗口内两者同屏。
 *
 * 照搬的取值：
 *   · **handoff 时长** = `clamp(shot 时长 × 0.3, 0.4, 1.1)`（上游写法是
 *     `resolveShotPacedDuration(endTime - startTime, 0.3, 0.4, 1.1)`；我方没有那个助手，语义取自
 *     调用点参数与 `README.md` 的"handoff 时长为 shot 时长的 0.3（钳在 0.4~1.1s）"）；
 *   · **出画进度** `exit = clamp01((time - endTime) / handoff)` —— 注意 `time > endTime` 时**仍在画**；
 *   · **入画进度** `enter = easeTemperaEnter(clamp01((time - startTime) / (handoff * 0.8)))`
 *     —— 分母是 `handoff × 0.8`，**前置加载**（上游注释：慢入场会露出还在画外的字）；
 *   · `span = max(width, height)`；
 *   · **位移** `travel = exit * span * 0.55 - (1 - enter) * span * 0.32`，
 *     沿 `(cos(flowAngle), sin(flowAngle))` 施加；
 *   · 容器位置 = `base + frame.xy * width/height * camera + flow * travel`，
 *     其中 `camera = cameraIntensity × animationScale`。
 *
 * ⬜ **尚未接线**：目前只被单测覆盖，运行时还没用它。
 */

import { clamp01, easeTemperaEnter, easeTemperaInOut } from './temperaEasing';

/**
 * 出画侧的**提前量**（占 hand-off 时长的比例，第 626 轮）。
 *
 * ⚠ **这是本仓库有意偏离上游的一处值**，理由有实测证据：
 * 上游 `exit` 从 `endTime` 起算（见上面第 18 行的照搬取值），于是两个 shot 交接的那一瞬间
 * **出画侧位移才从 0 起步、而入画侧已经收回到 0** ⇒ 两句话**重合在同一处**。
 * 连拍图 `apps/desktop/.tmp-tempera-burst/06.png` 抓到了这个画面
 * （白字「それでちょっとつまんない」压在黄字「ちょっとつまんない」上，只错开约 80px）。
 * 提前 `0.5 × handoff` 之后，交接瞬间出画侧已有 `exit ≈ 0.5`（位移 ≈ `0.28 × 长边` ≈ 330px），
 * 两侧分离 ≈ 700px ⇒ 不再有重合的两句话。
 * 代价是上一个构图早约 `0.5 × handoff` 退场；而 `.tmp-folia-dense/` 那 24 帧密帧里
 * **从没出现过两行重合** ⇒ 这个代价换来的观感更接近上游。
 */
export const TEMPERA_HANDOFF_LEAD_RATIO = 0.25;

/**
 * 交接时长：shot 时长的 0.3 倍，钳在 0.4~1.1s（上游取值）。
 *
 * ⚠ 第 689 轮把系数减半（0.15、钳 0.2~1.1）试过"缩短窗口"：6fps 每点从 6.36 涨到 **7.31**、
 * 30fps 从 1535 涨到 1620 ⇒ **两个口径都变差**，而且弄红了 2 个依赖时长的测试 ⇒ **已回滚**。
 *
 * ⇒ 连同第 673（拖尾）、687（压暗出画侧）、688（前慢入场），这已是**第四次**关于过渡的失败尝试，
 * 而结论彼此矛盾（拖慢更差、加快也更差）。⇒ 说明 `jumpSum` **基本不由过渡参数决定**，
 * 它反映的是"两个构图自身的明暗差"这个内容属性 —— 也正因如此，唯一真正有效的手段
 * 到目前为止只有**基础明度块**（第 672 轮，关闭时 30fps `jumpSum` +45%）。
 * 下一步应该做的是**让那层底色按每镜自己的明度自适应**，而不是继续动过渡。见 `docs/CREDITS.md` 第 689 轮。
 */
export function resolveTemperaShotHandoffDuration(startTime: number, endTime: number): number {
  const duration = Math.max(endTime - startTime, 0);
  /*
   * ⚠ 【**已试过、暂缓**】第 773 轮想把交接窗口从上游的 `0.3 / 1.1` 拉长到 `0.45 / 1.5`，
   * 用来解决主人说的「旧背景**消失速度太快了**」（推导见 `docs/CREDITS.md` 第 773 轮：
   * 淡出只拿得到 `0.5 × handoff ≈ 0.3s`，所以必须让窗口整体变长）。
   *
   * **但 `temperaShotHandoff.test.ts` 有 5 条断言正好钉着这几个数值**（含"10s 长的 shot：
   * handoff 被上限钳到 1.1 ⇒ 活到 11.1"）⇒ 改了会红 5 个测试。
   * 也就是说：**这一处不是"改个参数"，而是"改与上游的约定"**，需要主人拍板后再连同断言一起改。
   * ⇒ 本轮**先回滚保住绿树**，把决定权交给主人。
   */
  return Math.min(1.1, Math.max(0.4, duration * 0.3));
}

export interface TemperaShotHandoffInput {
  startTime: number;
  endTime: number;
  /** 当前绝对时间（秒）。 */
  time: number;
  /** 本 shot 的流向角（弧度）；`temperaProgram.ts` 已算出并收敛到竖直轴。 */
  flowAngle: number;
  width: number;
  height: number;
  /** 相机强度 × 动画尺度。 */
  camera: number;
  /** 相机帧的位移分量（比例）。 */
  frameX: number;
  frameY: number;
  /** shot 自己的基准位置（默认 0）。 */
  baseX?: number;
  baseY?: number;
}

export interface TemperaShotHandoffFrame {
  /** 交接窗口长度（秒）。 */
  handoff: number;
  /** 前缀加载的出画进度（0..1，已缓动）。 */
  exit: number;
  /** 前缀加载的入画进度（0..1，已缓动）。 */
  enter: number;
  /** 沿 flow 的位移（像素）。 */
  travel: number;
  x: number;
  y: number;
}

/**
 * 出画进度：`clamp01((time - endTime) / handoff)`。
 * `time <= endTime` 时为 0；等于 `endTime + handoff` 时为 1。
 */
export function resolveTemperaShotExitProgress(
  time: number,
  endTime: number,
  handoff: number,
): number {
  return clamp01((time - endTime) / Math.max(handoff, 0.001));
}

export function resolveTemperaShotHandoffFrame(
  input: TemperaShotHandoffInput,
): TemperaShotHandoffFrame {
  const { startTime, endTime, time, flowAngle, width, height, camera, frameX, frameY } = input;
  const baseX = input.baseX ?? 0;
  const baseY = input.baseY ?? 0;

  const handoff = resolveTemperaShotHandoffDuration(startTime, endTime);
  const span = Math.max(width, height);

  const enter = easeTemperaEnter(clamp01((time - startTime) / (handoff * 0.8)));
  const exit = easeTemperaInOut(resolveTemperaShotExitProgress(time, endTime, handoff));
  const travel = exit * span * 0.55 - (1 - enter) * span * 0.32;

  return {
    handoff,
    exit,
    enter,
    travel,
    x: baseX + frameX * width * camera + Math.cos(flowAngle) * travel,
    y: baseY + frameY * height * camera + Math.sin(flowAngle) * travel,
  };
}

/** 只用到时间字段的最小结构（**不**绑 `temperaProgram` 的类型，便于纯测）。 */
export interface TemperaTimedShot {
  startTime: number;
  endTime: number;
}

/**
 * 某一时刻**在屏上**的 shot 下标（按下标升序，最多两个）。
 *
 * 判据直接取自上游 `updateShot` / `resolveShotExit` 的语义：一个 shot 从自己的 `startTime` 起参与，
 * 一直到 **`endTime + 它自己的 handoff 时长`** 仍在画（就是"出画"那一段）。
 * 因为相邻 shot 首尾相接，于是 `[后一个.startTime, 前一个.endTime + 前一个.handoff]`
 * 这段里**两个 shot 同时在场** —— 这正是"交接感"要的双 shot 重叠。
 *
 * 这是渲染层拆分前的第一步：渲染层要按它决定去构建几个帧。
 */
export function resolveTemperaAliveShotIndices(
  shots: readonly TemperaTimedShot[],
  time: number,
): number[] {
  const alive: number[] = [];
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index];
    if (shot === undefined) continue;
    if (time < shot.startTime) continue;
    const aliveUntil =
      shot.endTime + resolveTemperaShotHandoffDuration(shot.startTime, shot.endTime);
    if (time > aliveUntil) continue;
    alive.push(index);
  }
  return alive;
}
