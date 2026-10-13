/**
 * 底部进度条的「指针位置 → 目标毫秒」换算（用户上一轮第 1 条 + 本轮第 1 条）。
 *
 * 为什么自己算、不用原生 `input[type=range]` 的点击跳转：
 * 原生滑块的命中判定里，**滑块（thumb）占的那一小块永远是「拖我」而不是「跳到这儿」**，
 * 而我们的滑块是透明的——`.pi-home__progress` 的 `--pi-home-thumb-fill: transparent`
 * （用户 m01402 第 6 条「进度条本体的小篮球也去掉，只要一个细线」），只当 12px 的抓取盒。
 * 于是「已播胶囊那一小节」长得像能点，指针落上去却什么都不发生（用户上一轮贴的图 1 红框就是
 * 那一段；已播越短，看不出来的死区就越靠前）。
 *
 * 现在改由轨道自己按指针的 x 算比例：整条轨道（含已播那一段、含滑块所在处）都能点、都能拖。
 *
 * 比例基准刻意取**轨道盒子的左右两边**：`.pi-home__progressfill` 的宽度就是
 * `--pi-progress × 100%`，所以「填充右端停在指针下」与视觉逐像素一致；原生滑块是按
 * 「滑块中心」映射的（两端各缩进半个滑块宽），拿它跟填充对齐本来就会差一点点。
 *
 * === 什么时候才真的改播放位置（用户本轮第 1 条） ===
 * 按下与拖动**只挪填充**，松手（`pointerup`）才按落点 `seek()` 一次。用户原话：
 * 「拖到确定位置后，也就是放开了鼠标，歌曲播放进度才变化」。所以这里只有**换算**，
 * 「什么时候用」在 `pages/HomePage.tsx` 的 HomeBar（`showScrubAt` / `commitScrubAt`）。
 */
export interface ProgressRect {
  readonly left: number;
  readonly width: number;
}

/** `clientX` → 目标位置（毫秒）。轨道量不到、时长未知时返回 0（调用方自己决定要不要 seek）。 */
export function progressTargetMs(clientX: number, rect: ProgressRect, totalMs: number): number {
  if (!(totalMs > 0) || !(rect.width > 0)) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return Math.round(ratio * totalMs);
}
