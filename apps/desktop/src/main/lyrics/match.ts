/**
 * 「这一份歌词是不是正在播的那首歌」的匹配率打分。
 *
 * 为什么需要它：官方源拿的是**这首歌的 id**，天然不会错；而 QQ 与酷狗没有网易云的 id，
 * 只能按「歌名 + 歌手 + 时长」去它们的搜索接口里找，找回来的第一名经常是翻唱、现场版、
 * 甚至完全另一首歌。把「像不像」算成一个 0~1 的数，才能做到两件事：
 * ① 低于门槛的候选宁可不显示（错歌词比没歌词更糟）；
 * ② 界面能如实告诉用户「匹配到 87%」而不是含糊地说「已匹配」。
 *
 * 三路加权（歌名 0.5 / 歌手 0.3 / 时长 0.2）刻意让歌名说了算：
 * 用户点的是「晴天」，那么叫「晴天」的那一首永远该排在「唱晴天的那个人另一首歌」前面。
 */
import { normalizeTitle } from './parsers.js';

export interface MatchInput {
  title: string;
  artists: readonly string[];
  durationMs?: number;
}

export interface MatchTarget {
  title: string;
  artists: readonly string[];
  durationMs?: number;
}

/** 时长差到这个量时「时长」这一路直接归零（现场版 / 翻录经常差十几秒）。 */
const DURATION_TOLERANCE_MS = 15_000;

/**
 * 两个字符串的相似度 0~1。
 *
 * - 完全相等（大小写、空格、括号内容归一之后）→ 1；
 * - 一方包含另一方 → 0.88（`晴天` vs `晴天 (Live)` 这类，归一后多半直接相等）；
 * - 否则用二元组 Dice 系数，交并比越接近越像。
 */
export function textSimilarity(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (left === '' || right === '') return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.88;
  if (left.length < 2 || right.length < 2) return 0;

  const bigrams = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i + 1 < text.length; i += 1) {
      const gram = text.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  let shared = 0;
  for (const [gram, count] of leftGrams) {
    const other = rightGrams.get(gram);
    if (other !== undefined) shared += Math.min(count, other);
  }
  const total = left.length - 1 + (right.length - 1);
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * 歌手这一路的相似度：把候选的每一位歌手与要查的每一位歌手两两比，取最高的那几对。
 *
 * 只取「最好的那几对」而不是平均：跨平台客串署名差异很大
 * （`周杰伦` vs `周杰伦/Jay Chou` vs `周杰伦、袁咏琳`），平均会被多出来的名字拖死。
 */
export function artistSimilarity(
  wanted: readonly string[],
  found: readonly string[],
): number {
  if (wanted.length === 0 || found.length === 0) return 0;
  let best = 0;
  for (const target of found) {
    for (const source of wanted) {
      best = Math.max(best, textSimilarity(source, target));
    }
  }
  return best;
}

/** 时长相似度：差 0 秒 = 1，差到容差 = 0，中间线性。拿不到时长时给一个中性值。 */
export function durationSimilarity(wanted?: number, found?: number): number {
  if (wanted === undefined || found === undefined || wanted <= 0 || found <= 0) return 0.5;
  const diff = Math.abs(wanted - found);
  if (diff >= DURATION_TOLERANCE_MS) return 0;
  return 1 - diff / DURATION_TOLERANCE_MS;
}

export interface MatchBreakdown {
  total: number;
  title: number;
  artist: number;
  duration: number;
}

/** 三路加权的匹配率。`total` 落在 0~1。 */
export function matchRate(query: MatchInput, target: MatchTarget): MatchBreakdown {
  const title = textSimilarity(query.title, target.title);
  const artist = artistSimilarity(query.artists, target.artists);
  const duration = durationSimilarity(query.durationMs, target.durationMs);
  return {
    title,
    artist,
    duration,
    total: title * 0.5 + artist * 0.3 + duration * 0.2,
  };
}

/**
 * 界面上的匹配率文案（`87%`）。
 *
 * 单独抽出来是因为「按源钉死」与「本地导入」这两条路根本没有跨平台匹配，
 * 它们的匹配率是**定义上**的 1，界面上要能区分「真的对上了 100%」和「不需要匹配」。
 */
export function formatMatch(match: number): string {
  return `${Math.round(match * 100)}%`;
}
