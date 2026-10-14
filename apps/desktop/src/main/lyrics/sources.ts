/**
 * 四个联网歌词源的实现（图 1 那一排：网易云音乐 / AMLLDB / QQ 音乐 / 酷狗音乐）。
 *
 * 每个源的共同契约见 `types.ts` 的 `LyricProvider`：**命中与否都不抛**，
 * 没搜到 / 接口挂了 / 超时统一返回空数组。歌词是增强功能，任何源出问题都不该让听歌失败。
 *
 * 它们的差别只在「怎么找、怎么解」：
 * - `ncm`  already 有歌曲 id，直接要歌词（唯一能拿到官方逐字 yrc 的一条路）；
 * - `amll` 用网易云 id 去社区的 TTML 词库取（打轴最准，带翻译/音译）；
 * - `qq` / `kugou` 没有网易云 id，先按「歌名 + 歌手」搜索、拿回平台自己的 id，再取歌词。
 */
import { NcmClient } from '@pi/ncm-client';
import type { Lyric, LyricLine } from '@pi/shared';
import { LYRIC_SOURCE_TIMEOUT_MS, type LyricCandidate, type LyricProvider, type LyricQuery } from './types.js';
import { decodeBase64Text, fetchBuffer, fetchJson, fetchText } from './http.js';
import { parseKrc, parseLrcText, parseQrc, parseTtml, readLrcOffset, splitInlineTranslation, stripLrcMeta } from './parsers.js';
import { decodeKrcLanguage, decryptKrc } from './kugou-krc.js';
import { decodeQqLyricField, unwrapQrcXml } from './qq-qrc.js';
import { lrclibProvider } from './lrclib.js';

/* ------------------------------------------------------------------ *
 * 网易云音乐（L0，官方）
 * ------------------------------------------------------------------ */

/**
 * AMLLDB 的取词地址。
 *
 * 官方 raw 直链在国内不稳定，所以按「实测最快」的顺序排了几条镜像（探针实测五条全通，
 * `bikonoo` 稳定在 160ms 上下）：一条不通就试下一条，全不通就当这个源没命中。
 *
 * `[ID]` 处填网易云歌曲 id —— 这个库**按平台 id 建索引**，不需要搜索，
 * 所以只要歌在库里有词，拿到的就是「一模一样的那首歌」的歌词，不会匹配错。
 */
const AMLL_URLS: readonly string[] = [
  'https://amlldb.bikonoo.com/ncm-lyrics/[ID].ttml',
  'https://amll-ttml-db.gbclstudio.cn/ncm-lyrics/[ID].ttml',
  'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/ncm-lyrics/[ID].ttml',
  'https://amll.mirror.dimeta.top/api/db/ncm-lyrics/[ID].ttml',
  'https://amll-ttml-db.stevexmh.net/ncm/[ID]',
];

function ncmProvider(client: NcmClient): LyricProvider {
  return {
    id: 'ncm',
    label: '网易云音乐',
    supportsWord: true,
    needsNetwork: true,
    async candidates(query: LyricQuery): Promise<LyricCandidate[]> {
      const lyric: Lyric = await client.lyric(query.songId);
      // 没词就**一条都不给**：以前这里会照旧回一条「用查询里的歌名、匹配率算成 1」的空候选，
      // 于是「一个源都没出词」这种情形在界面上会显示成「网易云音乐 符合率 100%」——
      // 现场验收就是这么发现的（这首在库里确实没有 TTML，官方那条却报满分）。
      if (!lyric.hasLyric || lyric.lines.length === 0) return [];
      return [
        {
          source: 'ncm',
          // 官方源按 id 取词：歌名用查询里的那一个，符合率自然算成 1。
          title: query.title,
          artists: query.artists,
          ...(query.durationMs !== undefined ? { durationMs: query.durationMs } : {}),
          remoteId: String(query.songId),
          lines: lyric.lines,
          translated: lyric.translated,
          roman: [],
          raw: lyric.lines.map((line) => line.text).join('\n'),
        },
      ];
    },
  };
}

function amllProvider(): LyricProvider {
  return {
    id: 'amll',
    label: 'AMLLDB',
    supportsWord: true,
    needsNetwork: true,
    async candidates(query: LyricQuery): Promise<LyricCandidate[]> {
      for (const template of AMLL_URLS) {
        const url = template.replace('[ID]', String(query.songId));
        const response = await fetchBuffer(url, { timeoutMs: LYRIC_SOURCE_TIMEOUT_MS });
        if (response === undefined || response.status !== 200) continue;
        const parsed = parseTtml(response.text);
        if (parsed.lines.length === 0) continue;
        return [
          {
            source: 'amll',
            // 用 TTML 自己声明的歌名/歌手参与匹配（见 `TtmlParseResult.meta` 的注释）：
            // 库里的条目是作者填的，与我们手上的歌单条目未必是同一首歌。
            title: parsed.meta.musicName ?? query.title,
            artists: parsed.meta.artists ?? query.artists,
            ...(query.durationMs !== undefined ? { durationMs: query.durationMs } : {}),
            remoteId: String(query.songId),
            lines: parsed.lines,
            translated: parsed.translated,
            roman: parsed.roman,
            raw: response.text,
          },
        ];
      }
      return [];
    },
  };
}

/* ------------------------------------------------------------------ *
 * QQ 音乐
 * ------------------------------------------------------------------ */

interface QqSearchHit {
  mid: string;
  /** 数字 id：逐字那条接口（`PlayLyricInfo`）两个都要，实测缺了它拿不到 QRC。 */
  songId?: number;
  title: string;
  artists: string[];
  durationMs?: number;
}

interface QqSearchResponse {
  code?: number;
  req?: {
    code?: number;
    data?: {
      body?: {
        song?: {
          list?: {
            mid?: string;
            id?: number;
            title?: string;
            interval?: number;
            singer?: { name?: string }[];
          }[];
        };
      };
    };
  };
}

/**
 * 按歌名 + 歌手在 QQ 音乐里搜同一首歌。
 *
 * 用 `musicu.fcg` 这条桌面端搜索接口（实测 200 / 340ms）；`client_search_cp` 那条
 * 会返回 500 或「禁止跨域访问」，不可用。
 */
async function searchQq(query: LyricQuery, limit = 6): Promise<QqSearchHit[]> {
  const keyword = [query.title, query.artists[0]].filter(Boolean).join(' ');
  const payload = {
    comm: { ct: 19, cv: 1859 },
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { query: keyword, num_per_page: limit, page_num: 1, search_type: 0 },
    },
  };
  const json = await fetchJson<QqSearchResponse>(
    `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(payload))}`,
    { timeoutMs: LYRIC_SOURCE_TIMEOUT_MS, headers: { referer: 'https://y.qq.com/' } },
  );
  const list = json?.req?.data?.body?.song?.list ?? [];
  const hits: QqSearchHit[] = [];
  for (const row of list) {
    const mid = row.mid;
    const title = row.title?.trim() ?? '';
    if (mid === undefined || title === '') continue;
    const artists = (row.singer ?? [])
      .map((singer) => singer.name?.trim() ?? '')
      .filter((name) => name !== '');
    hits.push({
      mid,
      ...(typeof row.id === 'number' && row.id > 0 ? { songId: row.id } : {}),
      title,
      artists,
      ...(typeof row.interval === 'number' && row.interval > 0
        ? { durationMs: row.interval * 1000 }
        : {}),
    });
  }
  return hits;
}

interface QqLyricResponse {
  retcode?: number;
  code?: number;
  lyric?: string;
  trans?: string;
}

/**
 * 取一首 QQ 歌的歌词。
 *
 * 两个坑：
 * ① 接口返回的是 base64（`nobase64=0`），要让它在 `format=json` 下仍然返回 base64 字段，
 *    必须用 GET —— POST 那条会在 CDATA 里回空内容（实测三种头部组合都是空）；
 * ② **必须带 `referer: https://y.qq.com/`**，否则 QQ 会回「禁止跨域访问」而不是歌词。
 */
async function fetchQqLyric(mid: string): Promise<{ lines: LyricLine[]; translated: LyricLine[] }> {
  const json = await fetchJson<QqLyricResponse>(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(mid)}&format=json&nobase64=0&g_tk=5381`,
    { timeoutMs: LYRIC_SOURCE_TIMEOUT_MS, headers: { referer: 'https://y.qq.com/portal/player.html' } },
  );
  const lyricText = decodeBase64Text(json?.lyric);
  if (lyricText === undefined) return { lines: [], translated: [] };

  // QQ 的歌词里也有 `[offset:]`：先读出来，剥掉元数据行之后再按 LRC 解析，
  // 避免 offset 在两份文本上各生效一次（译文与原文会整体错开）。
  const offset = readLrcOffset(lyricText);
  const parsed = splitInlineTranslation(parseLrcText(stripLrcMeta(lyricText)));
  const transText = decodeBase64Text(json?.trans);
  const inlineTranslated = parsed.translated;
  const externalTranslated = transText === undefined ? [] : parseLrcText(stripLrcMeta(transText));
  const shift = (rows: LyricLine[]): LyricLine[] =>
    rows.map((row) => ({ ...row, timeMs: row.timeMs + offset }));
  return {
    lines: shift(parsed.lines),
    // 接口单独给的 `trans` 比内嵌译文更权威，有就用它。
    translated: shift(externalTranslated.length > 0 ? externalTranslated : inlineTranslated),
  };
}

interface QqLyricInfoResponse {
  req?: {
    code?: number;
    data?: { lyric?: string; trans?: string; roma?: string; qrc?: number };
  };
}

/**
 * 把一条 QQ 歌词字段读成行数组：**先按逐字（QRC）认，认不出再按逐行 LRC 认**。
 *
 * 为什么要两套：同一条接口在不同参数下给的字段形态不一样 —— 实测 `crypt: 0` 时
 * `trans` 是 base64 的明文 LRC，而 `lyric` / `roma` 仍是 hex 密文解出来的 QRC。
 * 两套判据都不需要额外标志位，认哪种就是哪种。
 */
function parseQqField(text: string | undefined): LyricLine[] {
  if (text === undefined || text === '') return [];
  const body = unwrapQrcXml(text);
  const wordLines = parseQrc(body);
  if (wordLines.length > 0) return wordLines;
  /* 退到逐行：`[offset:]` 要先读出来再剥元数据行，免得译文与原文各偏一次。 */
  const offset = readLrcOffset(body);
  return parseLrcText(stripLrcMeta(body)).map((row) => ({ ...row, timeMs: row.timeMs + offset }));
}

/**
 * 取一首 QQ 歌的**逐字**歌词（QRC）。拿不到就返回 `undefined`，由上层退回逐行通道。
 *
 * 三个坑（都是实测的）：
 * ① `songMID` 与数字 `songID` 都要带，缺了数字 id 拿不到 QRC；
 * ② 响应里的 `lyric` 是**密文 hex**（不是 base64 明文），要 `qq-qrc.ts` 那套解密；
 * ③ 纯音乐会被 QQ 用「此歌曲为没有填词的纯音乐…」这种**正文提示**顶替歌词 ——
 *    那种解出来一行 QRC 行都没有，这里按「没拿到逐字」处理，让上层去试逐行。
 */
async function fetchQqQrc(
  mid: string,
  songId: number | undefined,
): Promise<{ lines: LyricLine[]; translated: LyricLine[]; roman: LyricLine[] } | undefined> {
  const payload = {
    comm: { ct: 11, cv: '1003006', v: '1003006', format: 'json', uin: '0' },
    req: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param: {
        format: 'json',
        songMID: mid,
        songID: songId ?? 0,
        qrc: 1,
        trans: 1,
        roma: 1,
        crypt: 1,
      },
    },
  };
  const json = await fetchJson<QqLyricInfoResponse>(
    `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(payload))}`,
    { timeoutMs: LYRIC_SOURCE_TIMEOUT_MS, headers: { referer: 'https://y.qq.com/' } },
  );
  const data = json?.req?.data;
  if (data === undefined) return undefined;
  const lines = parseQqField(decodeQqLyricField(data.lyric));
  if (lines.length === 0) return undefined;
  return {
    lines,
    translated: parseQqField(decodeQqLyricField(data.trans)),
    roman: parseQqField(decodeQqLyricField(data.roma)),
  };
}

function qqProvider(): LyricProvider {
  return {
    id: 'qq',
    label: 'QQ 音乐',
    /*
     * 逐字（QRC）走 `music.musichallSong.PlayLyricInfo`：`qrc: 1` 时 `lyric` 是 hex 密文，
     * 解开（3DES-EDE + zlib，见 `qq-qrc.ts`）就是逐字文本；逐行则走
     * `fcg_query_lyric_new.fcg` 兜底（有的歌只有逐行，有的歌接口抽风）。
     *
     * 为什么以前这里是 `false`：当时只接了公开的逐行通道（`fcg_query_lyric_new.fcg`，
     * 那条只给 LRC），逐字得换一条接口再解开密文 —— 主人本轮第 2 条问的就是这件事。
     * 现在那条路通了，声明就跟着真话翻成 `true`（界面上的「逐字」标签仍然按**真实候选**
     * 有没有 `words` 来点亮，所以这里说真话不会骗人）。
     */
    supportsWord: true,
    needsNetwork: true,
    async candidates(query: LyricQuery): Promise<LyricCandidate[]> {
      const hits = await searchQq(query);
      const candidates: LyricCandidate[] = [];
      for (const hit of hits.slice(0, 3)) {
        /* 先试逐字：拿不到（没有 QRC / 解密失败 / 只有纯音乐提示）再退回逐行。 */
        const word = await fetchQqQrc(hit.mid, hit.songId);
        const lyric = word ?? { ...(await fetchQqLyric(hit.mid)), roman: [] as LyricLine[] };
        if (lyric.lines.length === 0) continue;
        candidates.push({
          source: 'qq',
          title: hit.title,
          artists: hit.artists,
          ...(hit.durationMs !== undefined ? { durationMs: hit.durationMs } : {}),
          remoteId: hit.mid,
          lines: lyric.lines,
          translated: lyric.translated,
          roman: lyric.roman,
          raw: lyric.lines.map((line) => line.text).join('\n'),
        });
      }
      return candidates;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 酷狗音乐
 * ------------------------------------------------------------------ */

interface KugouSearchRow {
  FileHash?: string;
  SongName?: string;
  SingerName?: string;
  Duration?: number;
}

interface KugouSearchResponse {
  data?: { lists?: KugouSearchRow[] };
}

interface KugouCandidate {
  id?: string;
  accesskey?: string;
  duration?: number;
}

interface KugouKrcsResponse {
  candidates?: KugouCandidate[];
}

interface KugouDownloadResponse {
  content?: string;
  fmt?: string;
}

function splitKugouArtists(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(/[、,&/]/)
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/**
 * 酷狗搜索（`song_search_v2`）。
 *
 * 换成 `complexsearch.kugou.com` 那条会回 `error_code: 20006 err signature`——
 * 它要签名，而这条公开搜索接口不要（实测 200 / 190ms），给的回包里已经有 `FileHash`。
 */
async function searchKugou(query: LyricQuery, limit = 6): Promise<
  { hash: string; title: string; artists: string[]; durationMs?: number }[]
> {
  const keyword = [query.title, query.artists[0]].filter(Boolean).join(' ');
  const json = await fetchJson<KugouSearchResponse>(
    `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}&page=1&pagesize=${limit}` +
      '&platform=WebFilter&userid=-1&clientver=2000&iscorrection=1',
    { timeoutMs: LYRIC_SOURCE_TIMEOUT_MS },
  );
  const rows = json?.data?.lists ?? [];
  const hits: { hash: string; title: string; artists: string[]; durationMs?: number }[] = [];
  for (const row of rows) {
    const hash = row.FileHash;
    const title = row.SongName?.trim() ?? '';
    if (hash === undefined || hash === '' || title === '') continue;
    hits.push({
      hash,
      title,
      artists: splitKugouArtists(row.SingerName),
      ...(typeof row.Duration === 'number' && row.Duration > 0
        ? { durationMs: row.Duration * 1000 }
        : {}),
    });
  }
  return hits;
}

interface KugouLyric {
  lines: LyricLine[];
  translated: LyricLine[];
  roman: LyricLine[];
}

/**
 * 取一首酷狗歌的歌词：`krcs.kugou.com/search` 拿下载凭据 → `lyrics2.kugou.com/download`。
 *
 * KRC 是**加密封包**（头部 `krc1` + 整段 XOR + zlib），解密在 `kugou-krc.ts` 里；
 * 解不出来就退回同一接口的 lrc 档。两条路都读不出来就是真的没有。
 */
async function fetchKugouLyric(hash: string, durationMs?: number): Promise<KugouLyric> {
  const query = `ver=1&man=yes&client=mobi&keyword=&duration=${durationMs === undefined ? '' : Math.round(durationMs / 1000)}&hash=${hash}`;
  const krcs = await fetchJson<KugouKrcsResponse>(`https://krcs.kugou.com/search?${query}`, {
    timeoutMs: LYRIC_SOURCE_TIMEOUT_MS,
  });
  const candidate = krcs?.candidates?.[0];
  if (candidate?.id === undefined || candidate.accesskey === undefined) {
    return { lines: [], translated: [], roman: [] };
  }

  const base =
    `https://lyrics2.kugou.com/download?accesskey=${encodeURIComponent(candidate.accesskey)}` +
    `&charset=utf8&client=pc&id=${candidate.id}&ver=1`;

  // ① 先试 KRC（逐字 + 逐行译文/音译）。
  const krcRaw = await fetchText(`${base}&fmt=krc`, { timeoutMs: LYRIC_SOURCE_TIMEOUT_MS });
  const krcContent = decodeKugouPayload(krcRaw);
  if (krcContent !== undefined) {
    const xml = decryptKrc(Buffer.from(krcContent, 'base64'));
    if (xml !== undefined) {
      const language = decodeKrcLanguage(extractKrcLanguageTag(xml));
      const parsed = parseKrc(xml, language);
      if (parsed.lines.length > 0) return parsed;
    }
  }

  // ② 退回 lrc（逐行，没有逐字；内嵌译文会被拆出来）。
  const lrcRaw = await fetchText(`${base}&fmt=lrc`, { timeoutMs: LYRIC_SOURCE_TIMEOUT_MS });
  const lrcContent = decodeKugouPayload(lrcRaw);
  if (lrcContent === undefined) return { lines: [], translated: [], roman: [] };
  const lrcText = decodeBase64Text(lrcContent) ?? lrcContent;
  const offset = readLrcOffset(lrcText);
  const parsed = splitInlineTranslation(parseLrcText(stripLrcMeta(lrcText)));
  const shift = (rows: LyricLine[]): LyricLine[] =>
    rows.map((line) => ({ ...line, timeMs: line.timeMs + offset }));
  return { lines: shift(parsed.lines), translated: shift(parsed.translated), roman: [] };
}

/** KRC 文本里的 `[language:...]` 载荷（base64，由 `decodeKrcLanguage` 解开）。 */
function extractKrcLanguageTag(xml: string): string | undefined {
  return /\[language:([^\]]+)\]/.exec(xml)?.[1];
}

/** 下载接口回的是一个 JSON，歌词在 `content`（base64）。 */
function decodeKugouPayload(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const json = JSON.parse(raw) as KugouDownloadResponse;
    return json.content;
  } catch {
    return undefined;
  }
}

function kugouProvider(): LyricProvider {
  return {
    id: 'kugou',
    label: '酷狗音乐',
    supportsWord: true,
    needsNetwork: true,
    async candidates(query: LyricQuery): Promise<LyricCandidate[]> {
      const hits = await searchKugou(query);
      const candidates: LyricCandidate[] = [];
      for (const hit of hits.slice(0, 3)) {
        const lyric = await fetchKugouLyric(hit.hash, hit.durationMs);
        if (lyric.lines.length === 0) continue;
        candidates.push({
          source: 'kugou',
          title: hit.title,
          artists: hit.artists,
          ...(hit.durationMs !== undefined ? { durationMs: hit.durationMs } : {}),
          remoteId: hit.hash,
          lines: lyric.lines,
          translated: lyric.translated,
          roman: lyric.roman,
          raw: lyric.lines.map((line) => line.text).join('\n'),
        });
      }
      return candidates;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

/** 四个联网源。本地导入那一个由 `LyricStore` 提供（它不联网，形状也不同）。 */
/**
 * 联网歌词源的注册表。**顺序有意义**：解析器按匹配率排序，同分时保持这里的顺序
 * （`Array.prototype.sort` 是稳定的，`Promise.all` 也保序）—— 所以 Lrclib 这个兜底源
 * 必须排在最后，只在「前面几个都没词」或「它明显更准」时才被选中。
 */
export function createNetworkProviders(client: NcmClient): LyricProvider[] {
  return [ncmProvider(client), amllProvider(), qqProvider(), kugouProvider(), lrclibProvider()];
}
