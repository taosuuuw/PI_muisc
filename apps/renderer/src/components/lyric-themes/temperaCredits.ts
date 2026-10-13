/**
 * 凝彩（tempera）**片尾（credits）时间线**（纯函数，不碰 pixi）。
 *
 * 来源：`chthollyphile/folia-major@main` 的
 * `src/components/visualizer/tempera/createTemperaPixiRuntime.ts` 第 125~135 行的 `resolveCreditsFrame`
 * （AGPL-3.0，**只取算法与数值，代码按本仓库风格重写**；本地快照
 * `.folia-ref/tempera__createTemperaPixiRuntime.ts`；登记见 `docs/CREDITS.md`）。
 *
 * 上游注释原文：*"Simple credits fade: the poster rises once the final paragraph's lyric tail ends."*
 * —— 末段歌词尾巴结束之后，歌词淡出、海报**上浮并轻微推近**。
 *
 * ⚠ **本模块只覆盖"时间线"**。上游的海报**版式**在另一个模块
 * （`buildTemperaCreditsPoster` / `hasTemperaCreditsMetadata` / `TemperaCreditsView`，
 * 快照里没有、需另行取回）—— 所以"海报长什么样"尚未移植，本文件不假装有。
 *
 * 层序约束（上游 `:252`）：`addChild(sceneContainer, creditsContainer, overlayContainer)`
 * ⇒ **片尾在"场景"与"overlay"之间**：wipe 覆盖块压在片尾之上，片尾压在场景之上。
 */

import { easeTemperaInOut } from './temperaEasing';

export interface TemperaCreditsFrame {
  /** 是否已进入片尾阶段（`time > finalEndTime + 0.35`）。 */
  active: boolean;
  /** 歌词的不透明度：末段尾巴结束后 0.1s 开始淡、0.9s 内淡完。 */
  lyricAlpha: number;
  /** 海报的不透明度：0.9s 后开始升、1.1s 内完成。 */
  posterAlpha: number;
  /** 海报的竖直偏移（比例，**上浮**：1 ⇒ 0）。 */
  posterOffsetY: number;
  /** 海报的缩放（0.96 → 1，轻微推近）。 */
  posterScale: number;
}

/**
 * 数值逐条照搬上游（**不做 clamp**，与上游一致；缓动自身的端点行为决定边界值）：
 * ```
 * lyricAlpha    = 1 - easeTemperaInOut((time - finalEndTime - 0.1) / 0.9)
 * posterProgress= easeTemperaInOut((time - finalEndTime - 0.9) / 1.1)
 * active        = time > finalEndTime + 0.35
 * posterOffsetY = (1 - posterProgress) * 0.06
 * posterScale   = 0.96 + posterProgress * 0.04
 * ```
 */
export function resolveTemperaCreditsFrame(
  time: number,
  finalEndTime: number,
): TemperaCreditsFrame {
  const lyricAlpha = 1 - easeTemperaInOut((time - finalEndTime - 0.1) / 0.9);
  const posterProgress = easeTemperaInOut((time - finalEndTime - 0.9) / 1.1);
  return {
    active: time > finalEndTime + 0.35,
    lyricAlpha,
    posterAlpha: posterProgress,
    posterOffsetY: (1 - posterProgress) * 0.06,
    posterScale: 0.96 + posterProgress * 0.04,
  };
}
