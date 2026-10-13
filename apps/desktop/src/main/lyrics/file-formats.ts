/**
 * 用户导入的歌词文件怎么认、怎么解。
 *
 * 从 `Services.importLyric` 里拆出来单独成文件，理由是它有一堆格式判定规则
 * 需要被单测钉住（扩展名会骗人：把 TTML 存成 `.txt`、把 KRC 改名成 `.lrc` 都很常见），
 * 而 `Services` 那个类依赖 electron，单测跑不动。
 *
 * 判定顺序：**先看内容再看扩展名**。
 * - `krc1` 魔数（二进制）→ 酷狗 KRC；
 * - 文本里有 `<tt ...>` / `<p begin=` → TTML；
 * - 文本里有 `[mm:ss.xx]` 或 yrc 的 `[毫秒,毫秒]` → LRC / YRC / KRC 文本；
 * - 都没有 → 纯文本。
 */
import type { LyricLine } from '@pi/shared';
import {
  parseKrc,
  parseLrcText,
  parseTtml,
  readLrcOffset,
  splitInlineTranslation,
  stripLrcMeta,
} from './parsers.js';
import { decodeKrcLanguage } from './kugou-krc.js';

export type LyricFileFormat = 'lrc' | 'ttml' | 'krc' | 'txt';

const LRC_TIME_HINT = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/;
const KRC_LINE_HINT = /^\[\d+,\d+\]/m;

/** 认格式。`base64Buffer` 只有在内容被识别为二进制（KRC）时才有值。 */
export function detectLyricFormat(
  fileName: string,
  text: string,
  base64Buffer: Buffer | undefined,
): LyricFileFormat {
  if (base64Buffer !== undefined && base64Buffer.subarray(0, 4).toString('utf8') === 'krc1') {
    return 'krc';
  }
  const head = text.slice(0, 2000);
  if (/<tt[\s>]/.test(head) || /<p\b[^>]*begin=/.test(head)) return 'ttml';
  if (KRC_LINE_HINT.test(head)) return 'krc';
  if (LRC_TIME_HINT.test(head)) return 'lrc';
  if (/\.ttml$/i.test(fileName)) return 'ttml';
  if (/\.(lrc|yrc|qrc)$/i.test(fileName)) return 'lrc';
  return 'txt';
}

/** TTML 文本 → 三条时间轴。 */
export function parseTtmlFile(text: string): {
  lines: LyricLine[];
  translated: LyricLine[];
  roman: LyricLine[];
} {
  return parseTtml(text);
}

/**
 * LRC / YRC / KRC 文本 → 三条时间轴。
 *
 * KRC 与 LRC 在这一层的区别只有两处：KRC 的行时间是裸毫秒、并且带 `[language:...]` 段。
 * 所以这里先试 KRC 的行格式，再退回 LRC；`[offset:...]` 两边都读。
 */
export function parseLrcOrKrcLike(text: string): {
  lines: LyricLine[];
  translated: LyricLine[];
  roman: LyricLine[];
} {
  const offset = readLrcOffset(text);
  if (KRC_LINE_HINT.test(text)) {
    const languageTag = /\[language:([^\]]+)\]/.exec(text)?.[1];
    const parsed = parseKrc(text.replace(/\r/g, ''), decodeKrcLanguage(languageTag));
    const shift = <T extends LyricLine>(rows: T[]): T[] =>
      offset === 0 ? rows : rows.map((row) => ({ ...row, timeMs: row.timeMs + offset }));
    return {
      lines: shift(parsed.lines),
      translated: shift(parsed.translated),
      roman: shift(parsed.roman),
    };
  }
  const parsed = splitInlineTranslation(parseLrcText(stripLrcMeta(text)));
  const shift = (rows: LyricLine[]): LyricLine[] =>
    offset === 0 ? rows : rows.map((row) => ({ ...row, timeMs: row.timeMs + offset }));
  return { lines: shift(parsed.lines), translated: shift(parsed.translated), roman: [] };
}
