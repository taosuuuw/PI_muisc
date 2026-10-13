/**
 * 莫奈背景的**缓慢漂移**（照抄 folia 的语义，映射形状是我们的 ✓）。
 *
 * === 上游语义（`SOURCE`，本地快照）===
 * · `monet/monetBackgroundPipeline.ts:264` 注释：
 *   **"Drift is a DOM-side transform and never reaches the bitmap, so it stays out of the key"**
 *   ⇒ 漂移**做在 DOM 元素上**、**不进 canvas 位图**、**不参与缓存键** ✓；
 * · `zh-CN.ts:2308~2310` 的界面文案（等于行为说明书）：
 *   「缓慢漂移」／**「让背景图缓慢缩放漂移。图片会预先放大一点，保证移动时不会露出边缘。」**／「漂移幅度」✓
 * · `DEFAULT_MONET_BACKGROUND_TUNING`：`driftEnabled: true`、`driftStrength: 0.5` ✓。
 *
 * === 我们的部分（照实记）===
 * 上游**没有**给出"幅度/周期分别是多少、预放大多少"这些数（文案只说了"缓慢"、"预先放大一点"）✗，
 * 所以本文件的**映射形状与上限是我们定的** ✓：
 * 幅度随 `driftStrength` 线性增长，**预放大严格大于"缩放幅度 + 位移幅度"**
 * （这是"不露边"的**充分条件** ✓，也作为用例里的不变量钉住 ✓）。
 */

/** 一个漂移周期的秒数——"缓慢"，我们定 18s ✓。 */
export const MONET_DRIFT_CYCLE_SECONDS = 18;

/**
 * **默认值（上游 `DEFAULT_MONET_BACKGROUND_TUNING`，第 404 轮取到，照抄）** ✓
 * `driftEnabled: true` / `driftStrength: 0.5`。
 *
 * ⚠ **这两个值刻意不放进 `monetBackground.ts`**：那个模块的注释里已经写死了边界 ——
 * "`driftEnabled/driftStrength` 属 DOM 侧 transform，按上游注释**不进缓存键**，故本模块不涉及" ✓。
 * 所以漂移的默认值归这里、渲染方式归 DOM（见本文件头）✓。
 */
export const MONET_DRIFT_DEFAULT = {
  enabled: true,
  strength: 0.5,
} as const;

/** 缩放幅度上限（相对 1 的比例）——`strength = 1` 时 6% ✓（我们的上限）。 */
export const MONET_DRIFT_MAX_SCALE_RANGE = 0.06;

/** 位移幅度上限（相对元素尺寸的百分比）——`strength = 1` 时 1.2% ✓（我们的上限）。 */
export const MONET_DRIFT_MAX_TRANSLATE_PERCENT = 1.2;

export interface MonetBackgroundDrift {
  /** `scale` 在 `1` 与 `1 + scaleRange` 之间来回 ✓。 */
  readonly scaleRange: number;
  /** `translate` 的百分比幅度（CSS 里 `translate(±x%, ±y%)`）✓。 */
  readonly translatePercent: number;
  /** **预先放大的倍数**（`>= 1`）：必须大于"缩放幅度 + 位移幅度"，否则漂移时会露边 ✓。 */
  readonly preScale: number;
  readonly durationSeconds: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * 把 `driftStrength`（0~1）折成 CSS 可用的四个数 ✓。
 *
 * 预放大取 `1 + scaleRange + translatePercent / 100` 再加一点点余量（`×1.02`）——
 * 这样即使位移和缩放同时取到最大，边缘也还在画面外 ✓。
 */
export function resolveMonetBackgroundDrift(strength: number): MonetBackgroundDrift {
  const clamped = clamp01(strength);
  const scaleRange = clamped * MONET_DRIFT_MAX_SCALE_RANGE;
  const translatePercent = clamped * MONET_DRIFT_MAX_TRANSLATE_PERCENT;
  const preScale = (1 + scaleRange + translatePercent / 100) * 1.02;
  return { scaleRange, translatePercent, preScale, durationSeconds: MONET_DRIFT_CYCLE_SECONDS };
}

/** 生成 CSS 变量用的字符串（渲染层直接写进 style）✓。 */
export function resolveMonetBackgroundDriftStyle(strength: number): {
  readonly preScale: string;
  /** `preScale − scaleRange` 就是 `to` 帧的 scale ⇒ **两个都要给**，否则动画的第二个端点算不出来 ✓。 */
  readonly scaleRange: string;
  readonly duration: string;
  readonly translate: string;
} {
  const drift = resolveMonetBackgroundDrift(strength);
  return {
    preScale: drift.preScale.toFixed(4),
    scaleRange: drift.scaleRange.toFixed(4),
    duration: `${drift.durationSeconds}s`,
    translate: drift.translatePercent.toFixed(3),
  };
}
