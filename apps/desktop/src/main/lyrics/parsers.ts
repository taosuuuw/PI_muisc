/**
 * 各平台的歌词文本 / TTML / KRC 解析。
 *
 * 纯函数、不联网、不读盘：所有解析都在这里落地，四个源只负责「把上游的字符串搬回来」，
 * 于是每个格式都能单测（`parsers.test.ts`）。
 *
 * 共用的输出形状是 `@pi/shared` 的 `LyricLine[]`（`timeMs` / `text` / `durationMs` /
 * `words`）——**与官方源同一个形状**，渲染层不必认识「这份歌词来自哪个平台」。
 */
import { parseLrc } from '@pi/ncm-client';
import type { LyricLine, LyricWord } from '@pi/shared';

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/**
 * `[offset:+500]` / `[offset:-500]` 的毫秒平移。
 *
 * 跨平台搬歌词时**必须先用它把行时间移到同一个基准**：QQ 与酷狗的歌词都自带 offset，
 * 而它们的 offset 与网易云对同一首歌的 offset 未必相同；跟着译文一起搬的时候
 * 两边的 offset 还会各自生效一次，差出来的那几百毫秒正好是「歌词整体早一拍」的观感。
 */
export function readLrcOffset(text: string): number {
  const match = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(text);
  return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
}

/** 去掉元数据标签行（`[ti:]` `[ar:]` …），只留真正的歌词行。 */
export function stripLrcMeta(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const meta = /^\s*\[(ti|ar|al|by|offset|re|ve|length|kana|language)\s*:[^\]]*\]\s*$/i.exec(line);
      return meta === null;
    })
    .join('\n');
}

/** 把一份 LRC 文本解析成行（复用官方源那个解析器，保证两边脏数据规则完全一致）。 */
export function parseLrcText(text: string): LyricLine[] {
  return parseLrc(text);
}

/**
 * 把「同一时间戳的第二行」拆成译文。
 *
 * 这是**内嵌翻译**的 LRC 写法，酷狗/QQ/网易云都会给这种文件：
 *
 * ```
 * [00:10.00]Hello world
 * [00:10.00]你好世界
 * ```
 *
 * `parseLrc` 会两行都收下（它只按「时间去重」，同一时间去重的是**相同文本**），
 * 于是渲染层拿到的是「一行原文 + 一行看起来像歌词的译文」，两边都当正文画：
 * 表现就是「标着有翻译却看不到译文，反而混进了动效歌词里」——用户现场报的就是这个。
 *
 * 规矩定得很死，避免把正常的重复句（副歌复用同一句、和声行）误判成译文：
 * 1. 同一时间戳**恰好两行**才考虑拆分；
 * 2. 两行文字必须**不同**；
 * 3. 第二行必须含 CJK，且第一行不含 CJK（英文歌 → 中文译文的典型形态）。
 *
 * 不满足就不动，宁可让那两行照旧并排显示，也不要把副歌拆坏。
 */
export function splitInlineTranslation(lines: readonly LyricLine[]): {
  lines: LyricLine[];
  translated: LyricLine[];
} {
  const byTime = new Map<number, LyricLine[]>();
  for (const line of lines) {
    const bucket = byTime.get(line.timeMs);
    if (bucket === undefined) byTime.set(line.timeMs, [line]);
    else bucket.push(line);
  }

  const kept: LyricLine[] = [];
  const translated: LyricLine[] = [];
  for (const line of lines) {
    const bucket = byTime.get(line.timeMs) ?? [];
    const [first, second] = bucket;
    const isPair =
      bucket.length === 2 &&
      first !== undefined &&
      second !== undefined &&
      first.text.trim() !== second.text.trim();
    const looksTranslated =
      isPair &&
      !CJK.test(first?.text ?? '') &&
      CJK.test(second?.text ?? '') &&
      line !== first;

    if (looksTranslated && second !== undefined) {
      // 第二行是译文：进译文轨，不进正文。
      if (!translated.some((entry) => entry.timeMs === second.timeMs)) {
        translated.push({ timeMs: second.timeMs, text: second.text });
      }
      continue;
    }
    kept.push(line);
  }
  translated.sort((a, b) => a.timeMs - b.timeMs);
  return { lines: kept, translated };
}

/** 含中日韩文字的判定（用来区分「原文」与「译文」那一行）。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 归一到「空白规则一致」的字符串：全角空格压成半角、去掉所有空白、小写。
 *
 * 只用于**比对**（匹配率、译文对齐），不用于展示：所以丢掉大小写与空格是安全的，
 * 而中文/日文里「空格有没有」纯粹是搬运时的排版差异。
 */
export function normalizeForCompare(text: string): string {
  return text.replace(/[\s\u3000]/g, '').toLowerCase();
}

/** 只保留中英文数字与汉字，用于歌名/歌手的相似度比较。 */
export function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/[!-/:-@\[-`{-~！-／：-＠［-｀｛-～、-〜]/g, '');
}

/* ------------------------------------------------------------------ *
 * TTML（AMLL TTML DB）
 * ------------------------------------------------------------------ */

/**
 * AMLL TTML DB 的歌词解析。
 *
 * 用正则而不是引一个 XML 解析器：TTML 的这一小块结构非常规整（`<p>` 里嵌若干 `<span>`，
 * 角色靠 `ttm:role` 区分），引依赖反而多一份「解析器遇到脏 XML 抛什么」的未知。
 * 需要的能力只有三样：
 * - `<p begin="mm:ss.mmm" end="…">` → 一行；
 * - 行内的裸 `<span begin= end=>字</span>` → 逐字时间轴；
 * - `ttm:role="x-translation"` / `x-roman` 的 span → 翻译 / 音译那一行。
 *
 * 时间写成 `mm:ss.mmm` 或 `hh:mm:ss.mmm`（`dur` 属性是 `mm:ss.mmm`），
 * 一律换算成毫秒；解析不出来（例如只有 `dur`）就退回行首时间 + 行时长。
 */
export interface TtmlParseResult {
  lines: LyricLine[];
  translated: LyricLine[];
  roman: LyricLine[];
  /**
   * TTML 自己写在 `<amll:meta>` 里的歌曲信息。
   *
   * **用它来算符合率**，而不是「因为按 id 取词就报 100%」：AMLL 是按平台 id 建索引的，
   * 库里那首歌的信息是**作者填的**，与我们手上的歌单条目可能对不上（改过名的版本、
   * 同名不同曲、歌单里存的是翻唱）。拿它和自己这边的歌名/歌手比一次，
   * 界面上那个「符合率」才是真的在说「这份歌词对不对得上」。
   */
  meta: { musicName?: string; artists?: string[] };
}

const TTML_TIME = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/;

/** `00:29.231` / `01:02:03.500` → 毫秒；不合法返回 `undefined`。 */
export function parseTtmlTime(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = TTML_TIME.exec(raw.trim());
  if (!match) return undefined;
  const hours = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2] ?? '0', 10);
  const seconds = Number.parseInt(match[3] ?? '0', 10);
  const fraction = Number.parseInt((match[4] ?? '0').padEnd(3, '0').slice(0, 3), 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + fraction;
}

function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function attrOf(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return match?.[1];
}

/** 一个 `<p>` 块解析出来的东西。 */
interface TtmlParagraph {
  timeMs: number;
  durationMs?: number;
  text: string;
  words?: LyricWord[];
  translation?: string;
  roman?: string;
}

function parseTtmlParagraph(block: string): TtmlParagraph | undefined {
  const open = /<p\b[^>]*>/i.exec(block);
  if (open === null) return undefined;
  const begin = parseTtmlTime(attrOf(open[0], 'begin'));
  const end = parseTtmlTime(attrOf(open[0], 'end'));
  if (begin === undefined) return undefined;

  const words: LyricWord[] = [];
  const translationParts: string[] = [];
  const romanParts: string[] = [];
  /** 标签之外的字面文本（AMLL 会把词与词之间的空格留在 `<p>` 里，不包进 span）。 */
  const literalParts: string[] = [];

  /*
   * 逐段扫：每遇到一个标签，先把**它之前**的字面文本收下来，再看这个标签是什么。
   *
   * 为什么要连字面文本一起收：AMLL TTML DB 里英文歌词长这样
   * `<span ...>Hello</span> <span ...>world</span>` —— 那个空格不在任何 span 里。
   * 只扫 span 会把它吃掉，整行就变成 `Helloworld`。
   *
   * 标签的两种形态都要认：`<span ...>文字</span>` 与自闭合的 `<span ... />`（没有文字）。
   */
  const tagPattern = /<([a-zA-Z:]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let cursor = 0;
  /** 标签之间的字面文本：剥掉标签与实体，只留真文字。 */
  const pushLiteral = (raw: string): void => {
    const text = raw.replace(/<[^>]*>/g, '');
    if (text !== '') literalParts.push(xmlUnescape(text));
  };
  for (const match of block.matchAll(tagPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) pushLiteral(block.slice(cursor, index));
    cursor = index + match[0].length;

    const name = (match[1] ?? '').toLowerCase();
    if (name !== 'span') continue;
    const tag = match[2] ?? '';
    const selfClosing = (match[3] ?? '') === '/';
    // 自闭合的 span 没有正文，但**带 role 时它的内容在别处**（AMLL 不用这种写法），
    // 所以这里只需要跳过它，免得把后面的外层闭合标签当成它的正文。
    if (selfClosing) continue;

    const closeIndex = block.toLowerCase().indexOf('</span>', cursor);
    const inner = xmlUnescape(
      (closeIndex === -1 ? '' : block.slice(cursor, closeIndex)).replace(/<[^>]*>/g, ''),
    );
    if (closeIndex !== -1) cursor = closeIndex + '</span>'.length;

    const role = attrOf(tag, 'ttm:role') ?? attrOf(tag, 'role');
    if (role === 'x-translation') {
      if (inner.trim() !== '') translationParts.push(inner.trim());
      continue;
    }
    if (role === 'x-roman') {
      if (inner.trim() !== '') romanParts.push(inner.trim());
      continue;
    }
    if (inner === '') continue;
    const wordBegin = parseTtmlTime(attrOf(tag, 'begin'));
    const wordEnd = parseTtmlTime(attrOf(tag, 'end'));
    if (wordBegin === undefined) {
      // 没有时间戳的裸 span（例如专用来放空格的 `<span> </span>`）：
      // 它的文字仍然属于这一行，收进字面部分，让行文本按原样拼回来。
      literalParts.push(inner);
      continue;
    }
    words.push({
      timeMs: wordBegin,
      ...(wordEnd !== undefined && wordEnd > wordBegin ? { durationMs: wordEnd - wordBegin } : {}),
      text: inner,
    });
  }
  if (cursor < block.length) pushLiteral(block.slice(cursor));

  /*
   * 行文本 = 逐字文本按原顺序拼起来 + 那些散落在标签之间的字面文本。
   *
   * 这里的做法是「以逐字序列为骨架、把字面文本插回它在原文里的位置」的简化版：
   * 字面文本全部是空白时（AMLL 的常态）直接丢掉——逐字块自己已经覆盖了整行；
   * 一旦字面里出现真字（说明这一行有没被逐字标注的部分），就把两部分都拼上，
   * 宁可多出几个字，也不能像改造前那样**整段消失**。
   */
  const literalText = literalParts.join('');
  const wordsText = words.map((word) => word.text).join('');
  const text = (literalText.trim() === '' ? wordsText : `${wordsText}${literalText}`).trim();
  if (text === '') return undefined;

  return {
    timeMs: begin,
    ...(end !== undefined && end > begin ? { durationMs: end - begin } : {}),
    text,
    ...(words.length > 0 ? { words } : {}),
    ...(translationParts.length > 0 ? { translation: translationParts.join(' ') } : {}),
    ...(romanParts.length > 0 ? { roman: romanParts.join(' ') } : {}),
  };
}

/** 取出 `<amll:meta key="x" value="y"/>` 里的几个键（TTML 自带的歌曲信息）。 */
function readTtmlMeta(text: string): { musicName?: string; artists?: string[] } {
  const meta: { musicName?: string; artists?: string[] } = {};
  for (const match of text.matchAll(/<amll:meta\b[^>]*\/?>/gi)) {
    const tag = match[0];
    const key = attrOf(tag, 'key');
    const value = attrOf(tag, 'value');
    if (key === undefined || value === undefined) continue;
    const decoded = xmlUnescape(value).trim();
    if (decoded === '') continue;
    if (key === 'musicName') meta.musicName = decoded;
    if (key === 'artists') {
      // 多歌手在 TTML 里用 `/` 或 `;` 分隔。
      meta.artists = decoded
        .split(/[/;]/)
        .map((name) => name.trim())
        .filter((name) => name !== '');
    }
  }
  return meta;
}

/** 把 TTML 文本解析成「原文 / 译文 / 音译」三条互相独立的时间轴。 */
export function parseTtml(text: string): TtmlParseResult {
  if (text.trim() === '') return { lines: [], translated: [], roman: [], meta: {} };

  const paragraphs: TtmlParagraph[] = [];
  // 非贪婪取到第一个 </p>：AMLL 的 TTML 不嵌套 <p>，这样切足够且不会跨行吞并。
  for (const match of text.matchAll(/<p\b[\s\S]*?<\/p>/gi)) {
    const parsed = parseTtmlParagraph(match[0]);
    if (parsed) paragraphs.push(parsed);
  }
  paragraphs.sort((a, b) => a.timeMs - b.timeMs);

  const lines: LyricLine[] = [];
  const translated: LyricLine[] = [];
  const roman: LyricLine[] = [];
  for (const paragraph of paragraphs) {
    lines.push({
      timeMs: paragraph.timeMs,
      text: paragraph.text,
      ...(paragraph.durationMs !== undefined ? { durationMs: paragraph.durationMs } : {}),
      ...(paragraph.words !== undefined ? { words: paragraph.words } : {}),
    });
    if (paragraph.translation !== undefined) {
      translated.push({ timeMs: paragraph.timeMs, text: paragraph.translation });
    }
    if (paragraph.roman !== undefined) {
      roman.push({ timeMs: paragraph.timeMs, text: paragraph.roman });
    }
  }
  return { lines, translated, roman, meta: readTtmlMeta(text) };
}

/* ------------------------------------------------------------------ *
 * QQ 音乐 QRC（逐字）
 * ------------------------------------------------------------------ */

/**
 * QRC 是 QQ 音乐的行内逐字格式：每行开头 `[行开始毫秒,行时长毫秒]`，
 * 之后每个字/词写成 `文本(开始毫秒,时长毫秒)`。
 *
 * 例：`[0,3000]你(0,500)好(500,400)`
 *
 * 注意它**不是** LRC：时间是裸毫秒而不是 `mm:ss`，所以不能走 `parseLrc`。
 */
const QRC_LINE = /^\[(\d+),(\d+)\]([\s\S]*)$/;
const QRC_WORD = /([^()]*?)\((\d+),(\d+)\)/g;

export function parseQrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = QRC_LINE.exec(rawLine.trim());
    if (line === null) continue;
    const lineStart = Number.parseInt(line[1] ?? '0', 10);
    const lineDuration = Number.parseInt(line[2] ?? '0', 10);
    const body = line[3] ?? '';
    const words: LyricWord[] = [];
    let matched = '';
    for (const word of body.matchAll(QRC_WORD)) {
      const wordText = word[1] ?? '';
      if (wordText === '') continue;
      matched += wordText;
      words.push({
        timeMs: lineStart + Number.parseInt(word[2] ?? '0', 10),
        durationMs: Number.parseInt(word[3] ?? '0', 10),
        text: wordText,
      });
    }
    // 有些版本把整行文本放在括号之外（`[0,3000]歌词`）：那样没有逐字信息，
    // 仍然要把这一行收下来，否则整份歌词会变成空的。
    const fallbackText = body.replace(QRC_WORD, '').trim();
    const text0 = matched.trim() !== '' ? matched.trim() : fallbackText;
    if (text0 === '') continue;
    lines.push({
      timeMs: lineStart,
      text: text0,
      ...(lineDuration > 0 ? { durationMs: lineDuration } : {}),
      ...(words.length > 0 ? { words } : {}),
    });
  }
  lines.sort((a, b) => a.timeMs - b.timeMs);
  return lines;
}

/* ------------------------------------------------------------------ *
 * 酷狗 KRC（逐字）
 * ------------------------------------------------------------------ */

/**
 * KRC 解密后的文本形如：
 *
 * ```
 * [ti:晴天]
 * [ar:周杰伦]
 * [0,2250]<0,160,0>晴<160,160,0>天
 * [language:eyJjb250ZW50Ijo...]
 * ```
 *
 * 与 QRC 的关键差别是**每个词的时间戳写在词前面**（`<开始,时长,0>`），
 * 而不是写在词后面。行级时间是行首的 `[开始,时长]`。
 *
 * `[language:...]` 段是 base64 的 JSON，`lyricContent` **按行索引**给出译文
 * （见 `kugou-krc.ts` 的 `decodeKrcLanguage`），所以译文能严格对齐到行上，
 * 不必按时间戳猜。
 */
const KRC_LINE = /^\[(\d+),(\d+)\]([\s\S]*)$/;
const KRC_WORD = /<(\d+),(\d+),\d+>/g;

export interface KrcParseResult {
  lines: LyricLine[];
  translated: LyricLine[];
  roman: LyricLine[];
}

export function parseKrc(
  text: string,
  language?: { translated?: Map<number, string>; roman?: Map<number, string> },
): KrcParseResult {
  const lines: LyricLine[] = [];
  const translated: LyricLine[] = [];
  const roman: LyricLine[] = [];
  // 行序号：只数真正的歌词行，与 `[language:...]` 里 `lyricContent` 的下标一一对应。
  let rowIndex = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = KRC_LINE.exec(rawLine.trim());
    if (line === null) continue;
    const lineStart = Number.parseInt(line[1] ?? '0', 10);
    const lineDuration = Number.parseInt(line[2] ?? '0', 10);
    const body = line[3] ?? '';

    // 先按 `<开始,时长,0>` 把正文切成一段段（每段后面跟着自己的文本）。
    const words: LyricWord[] = [];
    const marks = [...body.matchAll(KRC_WORD)];
    if (marks.length > 0) {
      for (let i = 0; i < marks.length; i += 1) {
        const mark = marks[i];
        if (mark === undefined) continue;
        const start = Number.parseInt(mark[1] ?? '0', 10);
        const duration = Number.parseInt(mark[2] ?? '0', 10);
        const from = (mark.index ?? 0) + mark[0].length;
        const to = i + 1 < marks.length ? (marks[i + 1]?.index ?? body.length) : body.length;
        const wordText = body.slice(from, to);
        if (wordText === '') continue;
        words.push({ timeMs: lineStart + start, durationMs: duration, text: wordText });
      }
    }
    const rowText =
      words.length > 0 ? words.map((word) => word.text).join('') : body.replace(KRC_WORD, '');
    const text0 = rowText.trim();
    if (text0 === '') {
      // 空行**也占一个行号**：KRC 的 lyricContent 里前面几行常常是空占位，
      // 跳过它们会把整份译文往上错位。
      rowIndex += 1;
      continue;
    }
    lines.push({
      timeMs: lineStart,
      text: text0,
      ...(lineDuration > 0 ? { durationMs: lineDuration } : {}),
      ...(words.length > 0 ? { words } : {}),
    });
    const translation = language?.translated?.get(rowIndex);
    if (translation !== undefined) translated.push({ timeMs: lineStart, text: translation });
    const romanText = language?.roman?.get(rowIndex);
    if (romanText !== undefined) roman.push({ timeMs: lineStart, text: romanText });
    rowIndex += 1;
  }

  lines.sort((a, b) => a.timeMs - b.timeMs);
  translated.sort((a, b) => a.timeMs - b.timeMs);
  roman.sort((a, b) => a.timeMs - b.timeMs);
  return { lines, translated, roman };
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

/** 这份歌词里有没有可用的逐字时间轴（界面上的「逐字」标签与自动挑选都用它）。 */
export function linesHaveWords(lines: readonly LyricLine[]): boolean {
  return lines.some((line) => (line.words?.length ?? 0) > 0);
}

/**
 * 纯文本兜底解析：连一个时间标签都没有时，按行铺开、每行 3 秒。
 *
 * 宁可给一份「时间轴是猜的」的歌词（至少字是这首歌的字），也不要显示空白 —
 * 但界面上会标出来这是纯文本，用户能看出进度条不一定跟得上。
 */
export function splitPlainText(text: string, lineMs = 3000): LyricLine[] {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== '' && !/^\[[a-z]+:/i.test(row));
  return rows.map((row, index) => ({ timeMs: index * lineMs, text: row }));
}
