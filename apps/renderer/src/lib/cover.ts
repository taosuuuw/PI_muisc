/**
 * 封面 URL 尺寸处理。
 *
 * 网易云图片 CDN 支持 `?param=<w>y<h>` 按需裁剪，直接用原图在列表里会浪费带宽。
 * 注意：这个 CDN **不返回 CORS 头**，因此这里拿到的地址只适合放进 `<img>` /
 * `background-image`，**不能**直接喂给 canvas 取色（会 taint canvas 抛 SecurityError）。
 * 听歌详情页的主色提取必须由主进程取字节后再转 blob:（见 docs/PLAN.md §4.1）。
 *
 * 另外必须把 `http://` 升级成 `https://`：老接口返回的是明文图片地址，而页面 CSP
 * 只放行了 `https://*.music.126.net`——不升级的话图片会被 CSP 静默拦掉，
 * 表现就是「所有歌都没有封面」，控制台以外没有任何提示。
 */
export function coverAt(url: string | undefined, size: number): string | undefined {
  if (!url) return undefined;
  const base = (url.split('?')[0] ?? '').replace(/^http:\/\//i, 'https://');
  if (!base) return undefined;
  return `${base}?param=${size}y${size}`;
}

/**
 * 「每日推荐」那张卡片的封面（用户第二十一轮第 2 条：「每日推荐歌单没有封面，修一下」）。
 *
 * 每日推荐是个**伪歌单**：上游没有歌单 id、也就没有歌单封面（`PlaylistPage` 原来给它画的是
 * 一个音符占位图标）。但里面每首歌都有专辑封面，所以照网易云自己的做法——拿**前几首歌**的封面
 * 拼一张。四张是网易云那个 2×2 拼图的张数；不足四张就**循环补满**（两张时上下各重复一次），
 * 这样卡片永远是满满一张图，不会剩一格空着。
 *
 * `count` 传 1 时就是「只取第一张」，给先锋档那张单图卡片与歌曲浮层的抬头用。
 */
export function dailyCoverUrls(
  tracks: readonly { album?: { coverUrl?: string } | undefined }[] | undefined,
  count = 4,
  size = 400,
): string[] {
  const unique: string[] = [];
  for (const track of tracks ?? []) {
    const url = coverAt(track.album?.coverUrl, size);
    if (url === undefined || unique.includes(url)) continue;
    unique.push(url);
    if (unique.length >= count) break;
  }
  if (unique.length === 0 || count <= 1) return unique.slice(0, Math.max(count, 0));
  const filled: string[] = [];
  for (let index = 0; index < count; index += 1) {
    filled.push(unique[index % unique.length] as string);
  }
  return filled;
}
