/**
 * 商籁**片尾海报的时间线**（照抄 folia `sonnet/sonnetCredits.ts` 的数值，文字与代码我们重写；AGPL-3.0）。
 *
 * 上游文件头：*"Builds and times the deterministic **end-credits poster** shown after the final lyric."*
 * ⇒ 歌词唱完之后的收尾：**歌词淡出并糊掉，海报从下方升起、放大到 1** ✓。
 *
 * ⚠ 一切都由 `elapsed = time − finalLyricEndTime` 推出 ✓ ⇒ **与帧率无关、可 seek** ✓
 * （上游注释：*"remains deterministic under seeks"* ✓）。
 */

import { clamp01, easeSonnetInOut } from './sonnetMotion';

export interface SonnetCreditsFrame {
  readonly active: boolean;
  readonly lyricAlpha: number;
  readonly lyricBlur: number;
  readonly posterAlpha: number;
  readonly posterOffsetY: number;
  readonly posterScale: number;
}

export interface SonnetCreditsMetadata {
  readonly title?: string | null;
  readonly artist?: string | null;
  readonly album?: string | null;
}

/** 歌词退场历时（秒 ✓）。 */
export const SONNET_CREDITS_LYRIC_EXIT_SECONDS = 1.25;
/** 海报入场延迟（秒 ✓）—— 比歌词退场**晚 0.38s** 起 ✓。 */
export const SONNET_CREDITS_POSTER_DELAY_SECONDS = 0.38;
/** 海报入场历时（秒 ✓）。 */
export const SONNET_CREDITS_POSTER_ENTER_SECONDS = 1.55;
/** 退场终点的模糊半径（px ✓）。 */
export const SONNET_CREDITS_LYRIC_BLUR_MAX = 18;
/** 海报起始下移量（占画面高的比例 ✓）—— 从下方升上来 ✓。 */
export const SONNET_CREDITS_POSTER_OFFSET_Y = 0.04;
/** 海报起始缩放 ✓ —— 0.965 抬到 1.0 ✓。 */
export const SONNET_CREDITS_POSTER_SCALE_FROM = 0.965;

/** 归一（去空格 ✓，空串与 `null`/`undefined` 一律变 `''` ✓）。 */
export function normalizeSonnetCreditsValue(value?: string | null): string {
  return value?.trim() ?? '';
}

/** 三个字段**任一**非空 ⇒ 值得放海报 ✓。 */
export function hasSonnetCreditsMetadata(metadata: SonnetCreditsMetadata): boolean {
  return Boolean(
    normalizeSonnetCreditsValue(metadata.title) ||
      normalizeSonnetCreditsValue(metadata.artist) ||
      normalizeSonnetCreditsValue(metadata.album),
  );
}

/**
 * 此刻片尾的状态 ✓。`time` 与 `finalLyricEndTime` 都是**同一条时间轴上的秒** ✓。
 *
 * · 未到末句结束（`elapsed <= 0`）⇒ **不激活** ✓，且各项取"起始位" ✓
 *   （歌词全亮、无模糊 ✓；海报全透明、位于起始下移量、起始缩放 ✓）；
 * · `lyricExit`：0 → 1 历时 `1.25s` ✓ ⇒ `lyricAlpha = 1 − lyricExit` ✓、`lyricBlur = lyricExit × 18` ✓；
 * · `posterEnter`：晚 `0.38s` 起、历时 `1.55s` ✓ ⇒ `posterAlpha` ✓、
 *   `posterOffsetY = (1 − posterEnter) × 0.04` ✓、`posterScale = 0.965 + posterEnter × 0.035` ✓。
 */
export function resolveSonnetCreditsFrame(time: number, finalLyricEndTime: number): SonnetCreditsFrame {
  const elapsed = time - finalLyricEndTime;
  if (elapsed <= 0) {
    return {
      active: false,
      lyricAlpha: 1,
      lyricBlur: 0,
      posterAlpha: 0,
      posterOffsetY: SONNET_CREDITS_POSTER_OFFSET_Y,
      posterScale: SONNET_CREDITS_POSTER_SCALE_FROM,
    };
  }
  const lyricExit = easeSonnetInOut(clamp01(elapsed / SONNET_CREDITS_LYRIC_EXIT_SECONDS));
  const posterEnter = easeSonnetInOut(
    clamp01((elapsed - SONNET_CREDITS_POSTER_DELAY_SECONDS) / SONNET_CREDITS_POSTER_ENTER_SECONDS),
  );
  return {
    active: true,
    lyricAlpha: 1 - lyricExit,
    lyricBlur: lyricExit * SONNET_CREDITS_LYRIC_BLUR_MAX,
    posterAlpha: posterEnter,
    posterOffsetY: (1 - posterEnter) * SONNET_CREDITS_POSTER_OFFSET_Y,
    posterScale: SONNET_CREDITS_POSTER_SCALE_FROM + posterEnter * (1 - SONNET_CREDITS_POSTER_SCALE_FROM),
  };
}
