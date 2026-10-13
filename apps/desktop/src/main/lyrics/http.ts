/**
 * 歌词源共用的联网小工具。
 *
 * 只做三件事：带上「像浏览器」的请求头（几个平台的接口对空 UA 直接 403）、
 * 统一超时（歌词是等得起的增强，任何一个源卡住都只该耗掉自己那 8 秒）、
 * 以及**把失败翻译成 undefined**——源里的实现只关心「拿到了没有」，
 * 把 try/catch 散在每个源里会漏掉一半分支，最后表现成「整个歌词页转圈」。
 */

/** 默认请求头：QQ 与酷狗的公开接口在没有 UA/Referer 时会返回空内容而不是报错。 */
export const LYRIC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface FetchTextOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  /** HTTP 方法，默认 GET。 */
  method?: 'GET' | 'POST';
  /** POST 的请求体（表单串）。 */
  body?: string;
  /** 允许的状态码集合；默认只看 `ok`。 */
  acceptStatus?: readonly number[];
}

/** 取文本；任何失败（超时、网络、状态码不对）都返回 `undefined`。 */
export async function fetchText(
  url: string,
  options: FetchTextOptions,
): Promise<string | undefined> {
  const response = await fetchBuffer(url, options);
  return response === undefined ? undefined : response.text;
}

export interface FetchBufferResult {
  status: number;
  text: string;
  buffer: Buffer;
}

/** 取原始字节（TTML / KRC 需要按字节处理），失败返回 `undefined`。 */
export async function fetchBuffer(
  url: string,
  options: FetchTextOptions,
): Promise<FetchBufferResult | undefined> {
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'user-agent': LYRIC_UA,
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const accepted = options.acceptStatus ?? [];
    if (!response.ok && !accepted.includes(response.status)) {
      console.warn(`[pi/lyrics] ${response.status} ${url.slice(0, 90)}`);
      return undefined;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, buffer, text: buffer.toString('utf8') };
  } catch (error) {
    console.warn(
      `[pi/lyrics] 请求失败 ${url.slice(0, 90)}：${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** 取 JSON；解析失败也算失败。 */
export async function fetchJson<T>(
  url: string,
  options: FetchTextOptions,
): Promise<T | undefined> {
  const text = await fetchText(url, options);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    // 有些接口用 `jsonp(...)` 或带 BOM 返回；剥一层再试一次。
    const stripped = text.replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, '').trim();
    try {
      return JSON.parse(stripped) as T;
    } catch {
      console.warn(`[pi/lyrics] JSON 解析失败：${text.slice(0, 80)}`);
      return undefined;
    }
  }
}

/** base64 → utf8（QQ / 酷狗的歌词字段都是这么给的）。解析不出来返回 `undefined`。 */
export function decodeBase64Text(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    return text.trim() === '' ? undefined : text;
  } catch {
    return undefined;
  }
}
