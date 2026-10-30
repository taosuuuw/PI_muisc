/**
 * Lrclib（社区公共词库）的取词与规整。
 *
 * ── 定位：**兜底**，不是主力 ──
 * 网易云官方 / AMLLDB / QQ / 酷狗 四个源覆盖的是「平台自己的词」；Lrclib 是一份全球社区
 * 共建的同步歌词库（[lrclib.net](https://lrclib.net)），它的价值在于**前四个都没有时别让歌空着**
 * （冷门歌、外文歌、独立音乐的覆盖比平台全）。所以：
 *   · `supportsWord: false` —— 它给的是逐行同步歌词。响应里有个 `hasWordSync` 字段，
 *     但本机实测 60 条样本里一条都没有，所以**不声明支持逐字**（界面上「逐字」标签仍然按
 *     真实候选有没有 `words` 点亮，说真话不吃亏）；
 *   · 在 `createNetworkProviders()` 里**排在最后**：解析器按匹配率排序、同分时保持源顺序，
 *     所以它只在「前四个都没词」或者「它明显更准」时才被选中，不会抢走平台的词。
 *
 * ── 接口（无需鉴权，但要带一个能识别调用方的 User-Agent）──
 *   · `GET /api/get?artist_name=&track_name=[&duration=]` —— 精确命中，**一次只回一个记录**（省流量）；
 *   · `GET /api/search?track_name=&artist_name=` —— 精确命中没有时才用，回一批（最多 20 条），
 *     由我们自己的匹配器打分挑。
 *
 * ── 三个实测出来的坑 ──
 * ① `duration` 给得越准命中越高（它按 ±2 秒量级匹配）；我们没有时长时就不带这个参数。
 * ② 「精确命中不到」和「服务器忙」是两种状态，不能一样对待：查不到是 **404**（那就去搜索接口），
 *    过载是 **503**（`{"name":"ServerOverloaded"}`，本机连打几次就撞上了）—— 那种情况
 *    **直接放弃这一轮**，不要追着打，人家的接口是免费社区服务。
 * ③ 搜索接口**每条结果都带整份歌词**（20 条 ≈ 110KB）。所以「能用 get 就别用 search」，
 *    而且搜索只取前几条，别把 20 条全变成候选。
 */
import type { LyricLine } from '@pi/shared';
import { LYRIC_SOURCE_TIMEOUT_MS, type LyricCandidate, type LyricProvider, type LyricQuery } from './types.js';
import { fetchBuffer } from './http.js';
import { parseLrcText, readLrcOffset, splitPlainText, stripLrcMeta } from './parsers.js';

const LRCLIB_BASE = 'https://lrclib.net/api';

/**
 * 带一个能认出我们是谁的 UA：Lrclib 的文档要求「请标明你的应用」，
 * 公共接口对匿名爬虫不友好（撞到限流就是 503）。
 */
const LRCLIB_UA = 'PI-Music/0.9.8 (+https://github.com/taosuuuw/PI_muisc)';

/** 搜索接口一次返回一批，我们只拿前几条来打分（响应很大，见文件头 ③）。 */
const LRCLIB_SEARCH_TAKE = 4;

/** Lrclib 的记录形状（只列我们用得到的字段）。 */
export interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  /** 秒（注意：它这里是**秒**，别的平台多是毫秒）。 */
  duration?: number;
  instrumental?: boolean;
  hasWordSync?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

/**
 * 去掉行内的逐字时间标记（`<00:12.34>` 这种 enhanced-LRC 写法）。
 *
 * 为什么要有这一步：响应里的 `hasWordSync` 说明**存在**带逐字标记的记录，
 * 而我们的逐行解析器会把那些尖括号当普通文字留在歌词里（显示成 `[00:12.34]<00:12.34>你`）。
 * 本机没能抓到一条 `hasWordSync: true` 的真实样本，所以**不猜它的格式去做逐字解析**，
 * 只做保守处理：把这种标记剥掉，宁可退化成逐行，也不把标记显示给用户。
 * 等哪天拿到真样本，再来把这一段升级成真正的逐字解析。
 */
export function stripInlineTimeTags(text: string): string {
  return text.replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '');
}

/**
 * 把一条 Lrclib 记录读成行数组：优先 `syncedLyrics`（逐行带时间），
 * 没有就退到 `plainLyrics`（纯文本，按每行 3 秒铺开）。
 *
 * 返回 `undefined` 表示「这条记录没有可用歌词」——纯音乐记录、或者两条都空。
 */
export function parseLrclibRecord(record: LrclibRecord): { lines: LyricLine[]; raw: string } | undefined {
  const synced = stripInlineTimeTags(record.syncedLyrics ?? '').trim();
  if (synced !== '') {
    /* `[offset:]` 和别的平台一样要先读出来再剥元数据行，免得整体偏一次。 */
    const offset = readLrcOffset(synced);
    const lines = parseLrcText(stripLrcMeta(synced)).map((row) => ({
      ...row,
      timeMs: row.timeMs + offset,
    }));
    if (lines.length > 0) return { lines, raw: synced };
  }
  const plain = stripInlineTimeTags(record.plainLyrics ?? '').trim();
  if (plain !== '') {
    const lines = splitPlainText(plain);
    if (lines.length > 0) return { lines, raw: plain };
  }
  return undefined;
}

/** 一条记录 → 我们的候选（标题/歌手/时长都带上，交给上层的匹配器打分）。 */
export function lrclibCandidateOf(record: LrclibRecord): LyricCandidate | undefined {
  const parsed = parseLrclibRecord(record);
  if (parsed === undefined) return undefined;
  const title = record.trackName?.trim() ?? '';
  if (title === '') return undefined;
  const artists = (record.artistName ?? '')
    .split(/\s*(?:,|&|\/|;|\bfeat\.?\b|\bft\.?\b)\s*/i)
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return {
    source: 'lrclib',
    title,
    artists,
    ...(typeof record.duration === 'number' && record.duration > 0
      ? { durationMs: Math.round(record.duration * 1000) }
      : {}),
    ...(typeof record.id === 'number' ? { remoteId: String(record.id) } : {}),
    lines: parsed.lines,
    /* Lrclib 的记录里有原文与同步时间，没有独立的翻译/音译字段。 */
    translated: [],
    roman: [],
    raw: parsed.raw,
  };
}

/** 取 JSON，但把 **HTTP 状态码**一起带回来（要区分 404「没有」与 503「忙」）。 */
async function fetchLrclibJson(
  url: string,
): Promise<{ status: number; body: unknown } | undefined> {
  const response = await fetchBuffer(url, {
    timeoutMs: LYRIC_SOURCE_TIMEOUT_MS,
    headers: { 'user-agent': LRCLIB_UA, accept: 'application/json' },
    /* 404 不算「请求失败」，我们要拿到它的状态码去决定下一步。 */
    acceptStatus: [404],
  });
  if (response === undefined) return undefined;
  try {
    return { status: response.status, body: JSON.parse(response.text) as unknown };
  } catch {
    return { status: response.status, body: undefined };
  }
}

/**
 * 问一次 Lrclib，拿回候选（0~4 条）。**命中与否都不抛**（源的通用契约）。
 *
 * 顺序：先精确 `get`（一次一个记录，省流量），得到 404 才退到 `search`
 * （此时只取前 `LRCLIB_SEARCH_TAKE` 条，免得又慢又费流量）。503 直接放弃这一轮。
 */
export async function fetchLrclibCandidates(query: LyricQuery): Promise<LyricCandidate[]> {
  const title = query.title.trim();
  const artist = (query.artists[0] ?? '').trim();
  if (title === '') return [];

  const getParams = new URLSearchParams({ artist_name: artist, track_name: title });
  if (query.durationMs !== undefined && query.durationMs > 0) {
    getParams.set('duration', String(Math.round(query.durationMs / 1000)));
  }
  const exact = await fetchLrclibJson(`${LRCLIB_BASE}/get?${getParams.toString()}`);
  if (exact === undefined) return [];
  if (exact.status === 200 && exact.body !== null && typeof exact.body === 'object') {
    const candidate = lrclibCandidateOf(exact.body as LrclibRecord);
    if (candidate !== undefined) return [candidate];
  }
  if (exact.status !== 404) {
    /* 503（ServerOverloaded）与别的意外状态：这一轮就到这里，别追着打人家的免费接口。 */
    return [];
  }

  const searchParams = new URLSearchParams({ track_name: title });
  if (artist !== '') searchParams.set('artist_name', artist);
  const found = await fetchLrclibJson(`${LRCLIB_BASE}/search?${searchParams.toString()}`);
  if (found === undefined || found.status !== 200 || !Array.isArray(found.body)) return [];
  return (found.body as LrclibRecord[])
    .slice(0, LRCLIB_SEARCH_TAKE)
    .map((record) => lrclibCandidateOf(record))
    .filter((candidate): candidate is LyricCandidate => candidate !== undefined);
}

/** 源实现。注册时**排在最后**，并且打上 `fallback` 标记（理由见文件头「定位」那一段）。 */
export function lrclibProvider(): LyricProvider {
  return {
    id: 'lrclib',
    label: 'Lrclib',
    /* 逐行同步歌词（`hasWordSync` 实测没见过真的），如实声明不支持逐字。 */
    supportsWord: false,
    needsNetwork: true,
    fallback: true,
    async candidates(query: LyricQuery): Promise<LyricCandidate[]> {
      return fetchLrclibCandidates(query);
    },
  };
}
