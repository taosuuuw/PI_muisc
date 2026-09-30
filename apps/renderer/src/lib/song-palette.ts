import { useEffect, useState } from 'react';
import type { Song } from '@pi/shared';
import { coverAt } from './cover';
import {
  deriveThemeColors,
  extractCoverPalette,
  hashSeed,
  neutralThemeColors,
  type ThemeColors,
} from './cover-palette';

/**
 * 当前歌曲的配色（用户第八轮第 4 条：「歌词动效的颜色要契合歌曲变化，不是一味跟随主题色」）。
 *
 * 沉浸式背景（`components/ImmersiveBackground.tsx`）本来就在做同一件事：把封面丢进
 * `extractCoverPalette` 取色，再用 `deriveThemeColors` 推出一组保证对比度的颜色。
 * 但那份颜色只落在它自己的 `--pi-immersive-*` 变量上，**不往外传**，所以歌词舞台
 * 拿到的还是全局主题色（`lyric-themes.css` 的 `--pi-th-primary` 回退到 `--pi-primary`）。
 * 这里把同一套计算做成一个可复用的 hook，播放页拿它同时喂给：
 * - 歌词主题的 `palette` prop（`LyricStage` → 各主题组件）；
 * - 播放页根节点的 `--pi-th-primary / --pi-th-accent / --pi-th-surface`
 *   （CSS 侧引用这三个变量的样式会跟着一起变）。
 *
 * 成本可以忽略：`extractCoverPalette` 内部按 URL 缓存同一个 Promise
 * （`lib/cover-palette.ts:150` 的 `paletteCache`），这里的重复调用不会多取一次字节。
 * 换歌时先沿用上一首的颜色（不闪回中性灰），等新封面取完再换——和背景层的行为一致。
 */
export function useSongPalette(song: Song | null | undefined): ThemeColors | null {
  const [dark, setDark] = useState(() => document.documentElement.dataset['theme'] === 'dark');
  const [colors, setColors] = useState<ThemeColors | null>(null);

  const songId = song?.id ?? 0;
  const cover = coverAt(song?.album?.coverUrl, 640);

  // 亮/暗档跟着文档主题走：推色时的目标对比度是按底色算的，切主题必须重推一遍。
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.dataset['theme'] === 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    if (songId <= 0 || cover === undefined) {
      setColors(neutralThemeColors(dark));
      return () => {
        alive = false;
      };
    }
    void extractCoverPalette(cover).then((swatches) => {
      if (!alive) return;
      setColors(
        swatches.length === 0
          ? neutralThemeColors(dark)
          : deriveThemeColors(swatches, hashSeed(songId, 0x1eaf), dark),
      );
    });
    return () => {
      alive = false;
    };
  }, [cover, dark, songId]);

  return colors;
}
