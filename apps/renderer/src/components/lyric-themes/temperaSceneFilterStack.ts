import {
  compressedPassResolution,
  type TemperaPassResolutionTuning,
} from './temperaPassResolution';

/**
 * 凝彩 scene 级滤镜栈里**转场模糊**那部分。
 *
 * 来源同 `temperaPassResolution.ts`：folia-major
 * `src/components/visualizer/tempera/temperaSceneFilters.ts`（AGPL-3.0，只搬取值与做法）。
 * 本地快照：`.folia-ref/tempera__temperaSceneFilters.ts` 第 61~95 行。
 *
 * ⬜ **尚未接线**：与 `temperaPassResolution.ts` / `pixiTextureBudget.ts` 同属"待接"的那一套。
 */

/**
 * 低于这个强度，模糊就是一条空 pass，**整个 filter 要从容器上摘掉**（上游原值 `0.01`）。
 *
 * 摘掉的理由（上游注释）：**空数组会让 Pixi 彻底放弃这条 filter effect**，
 * 于是滤镜栈里**不再有这一项**——而反色 filter 是按"它渲染到的那个 surface"取 `uBackTexture` 的，
 * 栈里多一条无效果项就会改变它量到的东西。所以"没有效果"必须是"没有这一项"，不能靠强度 0 糊过去。
 */
export const TEMPERA_BLUR_ACTIVE_STRENGTH = 0.01;

/** 模糊滤镜的最小结构（不引 pixi 类型，避免 `Filter` 的类型陷阱）。 */
export interface TemperaBlurFilterLike {
  strength: number;
}

export interface TemperaSceneFilterTarget {
  /** 常驻整场的滤镜链（后处理链），可能为空。 */
  baseFilters: unknown[];
  transitionBlurFilter: TemperaBlurFilterLike | null;
  /** 当前模糊是否挂在栈上（**这是状态，不是强度**）。 */
  transitionBlurAttached: boolean;
  container: { filters: unknown[] };
}

/**
 * 转场模糊**一直在它周围那条 pass 的一半分辨率**上跑 —— 它反正要模糊，而且只在转场期间存在。
 * 从 pass 派生可以保住这个比例：当 pass 不再被钉死在 1 时，硬写 0.5 会在模糊刚挂上的瞬间
 * 把 1.5× 的场景掉掉四分之三，而那时它的强度还察觉不到。
 *
 * 上游原式：
 * `(tuning.postProcessTextureCompression ? compressedPassResolution(renderResolution) : renderResolution) * 0.5`
 * —— 注意不压缩那一支用的是 **`renderResolution` 本身**（不是 `'inherit'`），再乘 0.5。
 */
export function resolveTemperaTransitionBlurResolution(
  tuning: TemperaPassResolutionTuning,
  renderResolution: number,
): number {
  const pass = tuning.postProcessTextureCompression
    ? compressedPassResolution(renderResolution)
    : renderResolution;
  return pass * 0.5;
}

/**
 * 按强度挂/摘转场模糊。上游原式逐句照搬：
 * 强度 `> 0.01` 才算"有效"；有效时先写 `strength`；
 * **状态没变就直接返回**（不重建数组）；状态变了才改 `transitionBlurAttached` 并重设 `container.filters`——
 * 摘下时上游把 `baseFilters` **原数组引用**赋回去（不是拷贝），这里保持一致。
 */
export function setTemperaTransitionBlur(
  scene: TemperaSceneFilterTarget,
  strength: number,
): void {
  const filter = scene.transitionBlurFilter;
  if (!filter) return;
  const active = strength > TEMPERA_BLUR_ACTIVE_STRENGTH;
  if (active) filter.strength = strength;
  if (active === scene.transitionBlurAttached) return;
  scene.transitionBlurAttached = active;
  scene.container.filters = active ? [...scene.baseFilters, filter] : scene.baseFilters;
}
