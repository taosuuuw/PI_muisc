/**
 * 凝彩的缓动原语（**照抄上游 `tempera/temperaMotionEasing.ts` 的结构与数值**）。
 *
 * 上游把这份原语单独拆出来，是为了让"入场样式"和"字形求解器"能共用它、又不必互相 import
 * （原文注释就是这么写的）。注意：**上游在凝彩这边自带一份 `resolveCubicBezier`**，
 * 并没有去 import 商籁那份 —— 所以这里也照它的结构自带一份，不去跨主题耦合。
 *
 * 三条曲线：
 * - `easeTemperaEnter = cubic-bezier(0.22, 1, 0.36, 1)`：长而软地减速，起手决断、尾巴拖得长；
 *   上游注释特别强调**别改这条**（"试过更缓的曲线，读起来发懒；起手那一下的冲劲才是整套动效的动力"）。
 * - `easeTemperaInOut = cubic-bezier(0.62, 0, 0.32, 1)`：注意是 **0.62 / 0.32**，与商籁那条 0.65/0.35 不同。
 * - `easeTemperaSoftBack`：缩放收尾的**轻微回弹**（`c = 1.42`），不是贝塞尔，是一条三次式。
 *
 * **现状说明**：本文件先只入库并提供用例；接线（替换 `temperaFrame.ts` 里那份自写三次 in-out）
 * 要等拿到上游的调用点之后再动，避免重演本会话反复吃过的"猜着接"。见 `docs/PLAN.md` 第 122 轮。
 */

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const cubicCoordinate = (point1: number, point2: number, time: number): number => {
  const inverse = 1 - time;
  return 3 * inverse * inverse * time * point1 + 3 * inverse * time * time * point2 + time * time * time;
};

/**
 * CSS 风格的 cubic-bezier：**先解 x 曲线、再采 y**，二分 **12 次**（与上游一致）。
 *
 * 二分次数会留在输出里（12 次后区间宽约 `2.4e-4`），所以"算得更准"不等于"与上游一致"——
 * 这一点在商籁那条线上已经踩过一次，这里照上游原样写 12 次。
 * `target` 为 0 或 1 时上游直接返回，不走插值。
 */
export const resolveCubicBezier = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  value: number,
): number => {
  const target = clamp01(value);
  if (target === 0 || target === 1) return target;
  let low = 0;
  let high = 1;
  let parameter = target;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const x = cubicCoordinate(x1, x2, parameter);
    if (x < target) low = parameter;
    else high = parameter;
    parameter = (low + high) / 2;
  }
  return cubicCoordinate(y1, y2, parameter);
};

/** 入场：`cubic-bezier(0.22, 1, 0.36, 1)` —— 起手决断、尾巴长而软。 */
export const easeTemperaEnter = (value: number): number => resolveCubicBezier(0.22, 1, 0.36, 1, value);

/** 进出：`cubic-bezier(0.62, 0, 0.32, 1)` —— **不对称**，与商籁那条 0.65/0.35 不同。 */
export const easeTemperaInOut = (value: number): number => resolveCubicBezier(0.62, 0, 0.32, 1, value);

/**
 * 缩放的"轻微回弹"（照抄上游 `easeTemperaSoftBack`，`c = 1.42`）：
 * `1 + (c + 1)(t − 1)³ + c(t − 1)²`。
 * 它在 `t = 1` 处精确落在 1，中途会**略微过冲**（正因为在 1 附近回勾，才有"落定"的手感）。
 */
export const easeTemperaSoftBack = (value: number): number => {
  const t = clamp01(value);
  const c = 1.42;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
