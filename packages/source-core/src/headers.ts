/**
 * 回源请求头。
 *
 * 这里只放**与来源无关**的东西。网易官方的 Referer 属于官方源自己
 * （`@pi/source-official` 的 `OFFICIAL_UPSTREAM_HEADERS`），第三方直链带上它
 * 反而会被对方当成盗链。
 */

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 中性兜底头：只带 UA，不带任何 Referer。 */
export const NEUTRAL_UPSTREAM_HEADERS: Record<string, string> = {
  'user-agent': BROWSER_USER_AGENT,
};
