/**
 * 主题注册表（用户 m08768 第 4 条：歌词动效主题多选）。
 *
 * `LyricStage.tsx` 只认这张表：拿到 `theme` 就来这里取组件，取不到（`classic`，或
 * `fume` / `cadenza` 这种还没实现的 id）就退回 classic 分支——设置页里刚选了一个
 * 还没做出来的主题时，舞台会显示 classic，而不是一片空白。
 *
 * 加新主题的姿势：写 `XxxTheme.tsx`（默认导出 `XxxTheme`，props 用 `LyricThemeProps`），
 * 在这里登记一行，再在 `styles/lyric-themes.css` 里加一段 `.pi-lyricstage[data-theme='xxx']` 规则。
 */

import type { ComponentType } from 'react';
import type { LyricTheme } from '@pi/shared';
import { CadenzaTheme } from './CadenzaTheme';
import { FumeTheme } from './FumeTheme';
import { MonetTheme } from './MonetTheme';
import { PendoloTheme } from './PendoloTheme';
import { PartitaTheme } from './PartitaTheme';
import { TemperaTheme } from './TemperaTheme';
import { SonnetTheme } from './SonnetTheme';
import { TiltTheme } from './TiltTheme';
import type { LyricThemeProps } from './types';

/** 已经实现的主题（`classic` 由 `LyricStage.tsx` 自己渲染，不在这张表里）。 */
export const IMPLEMENTED_LYRIC_THEMES: readonly LyricTheme[] = [
  'partita',
  'tilt',
  'pendolo',
  'fume',
  'cadenza',
  'monet',
  'tempera',
  'sonnet',
];

export const LYRIC_THEME_COMPONENTS: Readonly<
  Partial<Record<LyricTheme, ComponentType<LyricThemeProps>>>
> = {
  partita: PartitaTheme,
  tilt: TiltTheme,
  pendolo: PendoloTheme,
  // 用户 m08768 第 4 条：浮名 / 心象 与上面三套一起补齐（两套各有自己的 CSS 文件：
  // `styles/lyric-themes.css` 管前三套，`styles/lyric-moods.css` 管这两套）。
  fume: FumeTheme,
  cadenza: CadenzaTheme,
  // 复刻 folia 的 `monet`（海报式：左列标题 + 歌词轨道，右列肖像，左下音频条）：
  // 样式另开一份 `styles/lyric-monet.css`。
  monet: MonetTheme,
  // 复刻 folia 的 `tempera`（凝彩：Pixi 色块构图 PV）。本批只画 split 族 13 种构图，
  // 其余十二族走兜底构图（`temperaFrame.ts` 的 `fallback` 标记），样式见 `styles/lyric-tempera.css`。
  tempera: TemperaTheme,
  // 复刻 folia 的 `sonnet`（商籁：Pixi 日式 MG 分镜 PV）。
  sonnet: SonnetTheme,
};

export function getLyricThemeComponent(
  theme: LyricTheme,
): ComponentType<LyricThemeProps> | undefined {
  return LYRIC_THEME_COMPONENTS[theme];
}

export { CadenzaTheme, FumeTheme, MonetTheme, PartitaTheme, PendoloTheme, SonnetTheme, TemperaTheme, TiltTheme };
export * from './types';
