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
