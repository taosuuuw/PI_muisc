import { CROSSFADE_SEC } from './schedule';

/**
 * 「接下来播放」卡片的显示窗口（P2 补）。
 *
 * 非交叉档（`off` / `fade`）：就是最后 5 秒——新歌真的开始播时 `currentSong` 才换，
 * 卡片正好在那一刻消失，由左下角歌曲名片接棒。
 *
 * **交叉档要往前提一个交叉时长**：交叉会在**剩余 5 秒**就切歌（新歌提前进场），而卡片
 * 原先也是「最后 5 秒」才出现——两边卡在同一个时刻，`setState` 一换 `currentSong` 与
 * `positionMs`，卡片连一帧都来不及画，用户看到的就是「Crossfade 下这张提示从来不出现」。
 * 所以窗口从 `5s` 变成 `5s + 交叉时长`：交叉开始前先露 5 秒，交叉开始时它照旧消失、
 * 换歌曲名片接棒，与非交叉档的交接节奏完全一致。
 *
 * 放在这个文件而不是组件里：组件带 CSS 导入，单测加载不了；而窗口边界是容易写错、
 * 也值得钉住的东西。
 */

/** 剩余多少毫秒之内算「马上要播下一首」（第十八轮第 11 条：结束前 5s）。 */
export const UP_NEXT_WINDOW_MS = 5_000;

export function upNextWindowMs(songTransition: 'off' | 'fade' | 'crossfade' | 'automix'): number {
  if (songTransition === 'crossfade') return UP_NEXT_WINDOW_MS + CROSSFADE_SEC * 1000;
  // AutoMix 的过渡长度是 4~8 秒（按拍/静音量化的），取最长那一档给窗口，保证预告能露满 5 秒。
  if (songTransition === 'automix') return UP_NEXT_WINDOW_MS + 8_000;
  return UP_NEXT_WINDOW_MS;
}
