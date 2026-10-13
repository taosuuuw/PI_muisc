/**
 * 凝彩（tempera）scene 级滤镜的 **pass 分辨率解析**。
 *
 * 来源：folia-major 的 `src/components/visualizer/tempera/temperaSceneFilters.ts`（AGPL-3.0）。
 * **只搬取值与做法，不抄源码。** 本地快照：`.folia-ref/tempera__temperaSceneFilters.ts`
 * （第 562 轮取件）；登记见 `docs/CREDITS.md` 的「scene 级滤镜的 pass 分辨率」一节。
 *
 * 上游写死的两条约束（接线时必须守）：
 *
 * 1. `renderResolution` 指的是**画布真实跑的分辨率** —— `textureResolution` 过完
 *    `snapResolutionToTexturePool`（见同目录 `pixiTextureBudget.ts`）**之后**的值，
 *    **不是设置项本身**；两者在吸附发生过的时候并不相等。
 *
 * 2. **绝不给文字层自己那个 filter 固定分辨率，也绝不在同一条 filter 数组里混用固定分辨率** ——
 *    Pixi 取同一数组内各 filter 分辨率的**最小值**，而反色 filter（`temperaDifferenceFilter.ts`，
 *    声明了 `blendRequired`）必须与它渲染到的那个 surface 同分辨率，`uBackTexture` 才是同源副本、
 *    输入与背景才严格对齐。所以本模块在"不压缩"这一支返回的是 `'inherit'` 哨兵，而不是某个数。
 *
 * ⬜ **尚未接线**：本模块与 `pixiTextureBudget.ts` 是同一件事的两半 —— 先决定吸附后的
 * `renderResolution`，再由它派生各 pass 分辨率。前半截（要不要采用上游那套吸附）是画质取舍，
 * 需用户拍板；后半截（本模块）取值唯一、无歧义。
 */

/** `'inherit'`＝不指定分辨率，让该 pass 跟随画布／它渲染到的 surface。 */
export const TEMPERA_PASS_RESOLUTION_INHERIT = 'inherit' as const;

export type TemperaPassResolution = number | typeof TEMPERA_PASS_RESOLUTION_INHERIT;

/** 参与决策的调参项（上游只读这一个开关）。 */
export interface TemperaPassResolutionTuning {
  /** 「后处理纹理压缩」：开启时把 pass 分辨率压到 ≤1 以省带宽。 */
  postProcessTextureCompression: boolean;
}

/** 上游原式：`Math.min(1, renderResolution)`。 */
export function compressedPassResolution(renderResolution: number): number {
  return Math.min(1, renderResolution);
}

/**
 * 上游原式：
 * `tuning.postProcessTextureCompression ? compressedPassResolution(renderResolution) : 'inherit'`。
 *
 * 注意**不是** `min(1, renderResolution)` 无条件生效：关掉压缩就是 `'inherit'`，
 * 由约束 2 可知这个"不指定"正是保反色正确的那一支。
 */
export function resolveTemperaPassResolution(
  tuning: TemperaPassResolutionTuning,
  renderResolution: number,
): TemperaPassResolution {
  return tuning.postProcessTextureCompression
    ? compressedPassResolution(renderResolution)
    : TEMPERA_PASS_RESOLUTION_INHERIT;
}
