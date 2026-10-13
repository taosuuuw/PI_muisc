/**
 * ⚠ **本文件已废弃（第 215 轮清理）**。
 *
 * 我曾经在这里"移植"了莫奈的一整套行为层（发光包络、填充宽度、三态色调、行窗口、token、
 * 大屏缩放、装饰粒子、音频条、频谱锚点……），但**仓库里 `monetLayout.ts` 早已有对应实现**
 * （而且更完整：还含掩码生成与行距；`MonetTheme.tsx:77` 导入的正是它）。
 * 那是本会话最严重的一次返工 —— **动手前没有先清点本仓库已有的同类实现**。
 *
 * 按"单一真相"原则，重复实现已全部移除，**请使用 `monetLayout.ts`**：
 * `resolveMonetGlow` / `resolveMonetFillWidth` / `resolveMonetLineTone` / `resolveMonetSweepEdgeSoftness` /
 * `resolveMonetGlowRadii` / `buildMonetDecorParticles` / `monetBarHeight` /
 * `buildMonetSpectrumAnchors` / `sampleMonetSpectrumProfile` / `resolveMonetLargeScreenScale` …
 *
 * **本文件只保留一处上游做法、而 `monetLayout.ts` 里没有的东西**：音频条的一阶低通平滑。
 */

/**
 * 一阶低通：`previous` 向 `target` 靠 `α`（上游 `monet/AudioOverlay.tsx` 用 `α ≈ 0.12` 平滑频谱）。
 *
 * `α` 会被夹到 0~1：`0` ⇒ 原地不动，`1` ⇒ 直接取目标值。
 * 这是**纯函数**（状态由调用方持有），所以可以直接单测。
 */
export const MONET_AUDIO_LOWPASS_ALPHA = 0.12;

export const applyMonetLowPass = (
  previous: number,
  target: number,
  alpha: number = MONET_AUDIO_LOWPASS_ALPHA,
): number => previous + (target - previous) * Math.min(1, Math.max(0, alpha));
