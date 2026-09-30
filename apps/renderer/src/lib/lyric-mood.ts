/**
 * 歌词情绪与关键词（用户 m08768 第 5 条：播放页沉浸式背景）。
 *
 * folia-major 走的是 **LLM 路径**：把歌词发给模型，要求返回 4 个 hex + 10~20 条
 * 「情绪词 → 颜色」映射 + 3~5 个图标 + 明暗两套主题。PI **没有 LLM**（也不允许为了背景
 * 去加一个网络依赖），所以这里是它的**诚实替代**：一张自建的中文情绪词典 +
 * 「按行距加权」的计分，得出情绪族与 0~1 的能量，再和 cover-palette 的四个颜色合成
 * **同一份主题契约**（`{ backgroundColor, primaryColor, accentColor, secondaryColor,
 * wordColors, mood }`）。与 LLM 的差距是明摆着的：不认语序、不认反讽、只认词面。
 *
 * 副歌检测（`detectChorus`）数值与做法同样借鉴 folia 的 `chorusDetector.ts`：
 * 去掉 `[mm:ss.xx]` 时间戳后按**完全相同的文本**统计出现次数，取绝对最大频次，
 * `maxCount <= 1` 视为没有副歌。folia-major 是 **AGPL-3.0**：这里只取数值与思路，
 * **没有拷贝任何 folia 源码文本**。
 *
 * 一个刻意的取舍：folia 的 wordColors 是 LLM 逐词给的自定义色，我们只有主题三色，
 * 所以按「情绪族 → 主题色槽（primary / accent / secondary）」映射。**没有**给每个情绪族
 * 配自己的色相偏移——主题色相是封面算出来的（cover-palette.ts），如果这里再按词改色相，
 * 两边会互相打架，同一首歌的颜色也会随歌词滚动而漂移。
 */

import type { LyricLine } from '@pi/shared';

import type { ThemeColors } from './cover-palette';

/** 情绪族。名字就是报告里用的那套：温柔 / 热烈 / 孤独 / 明亮 / 悲伤 / 能量。 */
export type MoodFamily = 'tender' | 'passionate' | 'lonely' | 'positive' | 'negative' | 'energetic';

/** 情绪族的固定顺序：既是遍历顺序，也是**平分时的优先级**。 */
const MOOD_FAMILIES = ['tender', 'passionate', 'lonely', 'positive', 'negative', 'energetic'] as const;

type ColorSlot = 'primary' | 'accent' | 'secondary';

interface FamilyStyle {
  /** 这个族的基准能量（0~1）；句子快慢由 audio-bands 的伪能量再叠一层。 */
  readonly energy: number;
  /** 情感极性：+1 明亮、-1 阴郁、0 中性。给调用方留的字段（本轮背景只用 mood/energy）。 */
  readonly valence: -1 | 0 | 1;
  /** 这个词族的颜色落在主题的哪个色槽上。 */
  readonly colorSlot: ColorSlot;
}

/**
 * 词典（6 族、87 条：63 条中文 + 24 条英文）。
 *
 * 选词的三条规矩（为了「可读、可控」，不是为了覆盖全部歌词）：
 * 1. 尽量用 2 字以上的词——中文没有词边界，`includes` 是子串匹配，单字词（如「痛」）
 *    会命中「痛快」这种反义搭配；
 * 2. 一个词只出现在一族里，避免计分左右互搏；
 * 3. 英文词一律按单词边界匹配（见 `textContainsWord`）：`run` 只命中独立出现的 run，
 *    不会命中 `brunch`。
 */
const MOOD_LEXICON: Readonly<Record<MoodFamily, readonly string[]>> = {
  tender: [
    '温柔', '微风', '晚安', '星光', '拥抱', '轻轻', '月光', '温暖', '陪伴', '微笑', '静静', '眼眸',
    'home', 'dream', 'moon', 'gentle',
  ],
  passionate: [
    '燃烧', '疯狂', '狂热', '心跳', '滚烫', '呐喊', '不顾一切', '星辰大海', '永远', '誓言',
    'love', 'fire', 'burning', 'desire',
  ],
  lonely: [
    '孤独', '寂寞', '一个人', '无人', '荒芜', '空荡', '沉默', '独自', '影子', '冷清',
    'alone', 'lonely', 'night', 'empty',
  ],
  positive: [
    '希望', '明天', '阳光', '自由', '未来', '勇敢', '盛开', '春天', '晴朗', '远方',
    'light', 'free', 'shine', 'hope', 'tomorrow',
  ],
  negative: [
    '眼泪', '悲伤', '心碎', '离开', '再见', '错过', '遗憾', '哭泣', '失去', '忘记', '伤口',
    'cry', 'tears', 'goodbye', 'broken',
  ],
  energetic: [
    '奔跑', '出发', '加速', '跳跃', '大声', '世界', '一起', '现在', '冲动', '躁动',
    'dance', 'run', 'jump', 'louder', 'awake',
  ],
};

const FAMILY_STYLE: Readonly<Record<MoodFamily, FamilyStyle>> = {
  tender: { energy: 0.28, valence: 1, colorSlot: 'primary' },
  passionate: { energy: 0.9, valence: 1, colorSlot: 'accent' },
  lonely: { energy: 0.25, valence: -1, colorSlot: 'secondary' },
  positive: { energy: 0.6, valence: 1, colorSlot: 'primary' },
  negative: { energy: 0.35, valence: -1, colorSlot: 'secondary' },
  energetic: { energy: 0.85, valence: 1, colorSlot: 'accent' },
};

/** 情绪族 → `ThemeColors` 上的字段名（用显式映射而不是拼字符串，免得丢掉类型检查）。 */
const SLOT_PROPERTY: Readonly<Record<ColorSlot, keyof ThemeColors>> = {
  primary: 'primaryColor',
  accent: 'accentColor',
  secondary: 'secondaryColor',
};

/** 当前行、最近窗口、其它行的计分权重：越靠近「正在唱的那一句」越算数。 */
const WEIGHT_ACTIVE = 4;
const WEIGHT_RECENT = 2.5;
const WEIGHT_GLOBAL = 1;
/** 「最近窗口」看当前行往前这么多行。 */
const RECENT_WINDOW = 8;
/** 关键词条数的截断上限（进 wordColors 的规模，别让一张 Map 无限长）。 */
const MAX_KEYWORDS = 24;
/** 6 个词就算「词很密」——密度只是能量公式里的一小项。 */
const DENSITY_FULL_WORDS = 6;
/** 一个词都没命中时的能量：背景还是要有一点呼吸，不要死平。 */
const NEUTRAL_ENERGY = 0.32;

/** 行首的时间戳（`[01:23.45]` / `[1:23]` / `[01:23:456]`，可以连写多个）。 */
const TIME_TAG = /^\s*(?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+/;

export interface MoodWord {
  readonly word: string;
  readonly family: MoodFamily;
}

export interface LyricMood {
  /** 命中最多的情绪族；一个词都没命中就是 `'neutral'`。 */
  readonly mood: MoodFamily | 'neutral';
  /** 去重后的命中词（按行序，最多 `MAX_KEYWORDS` 条）。 */
  readonly keywords: readonly MoodWord[];
  /** 0~1 的情绪能量（词的密度 + 族的基准能量），供背景调形状缩放用。 */
  readonly energy: number;
  /** 情感极性，来自主导族；中性为 0。 */
  readonly valence: -1 | 0 | 1;
  /** 各族得分（调试与将来的可视化用；也是「为什么是这个 mood」的证据）。 */
  readonly scores: Readonly<Record<MoodFamily, number>>;
}

/** 组件最终拿到的主题契约：颜色来自封面，情绪与逐词颜色来自歌词。 */
export interface ThemeContract extends ThemeColors {
  /** 情绪词 → 颜色（我们按族映射到主题色槽，见文件头注释）。 */
  readonly wordColors: ReadonlyMap<string, string>;
  /** 主导情绪族（写进根节点的 `data-mood`）。 */
  readonly mood: string;
}

const ASCII_PATTERN_CACHE = new Map<string, RegExp>();

/** 去掉时间戳、压平空白。检测副歌与找词都用这个口径。 */
export function normalizeLyricText(text: string): string {
  return text.replace(TIME_TAG, '').replace(/\s+/g, ' ').trim();
}

/**
 * 副歌检测（folia 的 `chorusDetector.ts` 口径）：
 * 按**完全相同的文本**统计出现次数（不做大小写归并、不做模糊匹配），取绝对最大频次；
 * `maxCount <= 1` 就是没有副歌，返回空集合。
 */
export function detectChorus(texts: readonly string[]): ReadonlySet<number> {
  const normalized = texts.map(normalizeLyricText);
  const counts = new Map<string, number>();
  for (const text of normalized) {
    if (!text) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  let maxCount = 0;
  for (const count of counts.values()) {
    if (count > maxCount) maxCount = count;
  }
  const chorus = new Set<number>();
  if (maxCount <= 1) return chorus;
  normalized.forEach((text, index) => {
    if (text && counts.get(text) === maxCount) chorus.add(index);
  });
  return chorus;
}

/** 中文/日文按子串匹配；含拉丁字母的词按单词边界匹配（`run` 不该命中 `brunch`）。 */
function textContainsWord(text: string, word: string): boolean {
  if (!/[a-z]/i.test(word)) return text.includes(word);
  let pattern = ASCII_PATTERN_CACHE.get(word);
  if (!pattern) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    ASCII_PATTERN_CACHE.set(word, pattern);
  }
  return pattern.test(text);
}

function emptyScores(): Record<MoodFamily, number> {
  return { tender: 0, passionate: 0, lonely: 0, positive: 0, negative: 0, energetic: 0 };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 整首歌 + 当前行的情绪分析。
 *
 * 权重：正在唱的那一行 ×4、它前面 8 行 ×2.5、其余行 ×1 —— 一句歌词的情绪最相关的是
 * 「现在唱到哪」，但整首歌的基调也要算，否则副歌一过背景就跳。`activeIndex < 0`
 * （还没开始唱）时全部按 ×1 算。
 *
 * 成本：一次遍历 行数 × 词条数（≈ 100 × 87）次短字符串匹配；只在 `lines` / `activeIndex`
 * 变化时重算（组件里是 `useMemo`），换行时才跑一次，不在每帧上。
 */
export function analyzeLyricMood(lines: readonly LyricLine[], activeIndex: number): LyricMood {
  const scores = emptyScores();
  const keywords: MoodWord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const text = normalizeLyricText(line.text);
    if (!text) continue;
    const inRecentWindow = activeIndex >= 0 && index <= activeIndex && index > activeIndex - RECENT_WINDOW;
    const weight = index === activeIndex ? WEIGHT_ACTIVE : inRecentWindow ? WEIGHT_RECENT : WEIGHT_GLOBAL;
    for (const family of MOOD_FAMILIES) {
      for (const word of MOOD_LEXICON[family]) {
        if (!textContainsWord(text, word)) continue;
        scores[family] += weight;
        if (!seen.has(word) && keywords.length < MAX_KEYWORDS) {
          seen.add(word);
          keywords.push({ word, family });
        }
      }
    }
  }

  let mood: MoodFamily | 'neutral' = 'neutral';
  let best = 0;
  for (const family of MOOD_FAMILIES) {
    if (scores[family] > best) {
      best = scores[family];
      mood = family;
    }
  }

  const density = Math.min(1, keywords.length / DENSITY_FULL_WORDS);
  const style = mood === 'neutral' ? undefined : FAMILY_STYLE[mood];
  const energy = clamp01((style?.energy ?? NEUTRAL_ENERGY) * 0.65 + density * 0.25 + 0.1);

  return {
    mood,
    keywords,
    energy,
    valence: style?.valence ?? 0,
    scores,
  };
}

/** 还没算出主题（或没有歌词）时用的中性情绪。 */
export function neutralMood(): LyricMood {
  return { mood: 'neutral', keywords: [], energy: NEUTRAL_ENERGY, valence: 0, scores: emptyScores() };
}

/** 颜色（封面）+ 情绪（歌词）→ 组件真正消费的主题契约。 */
export function composeTheme(colors: ThemeColors, mood: LyricMood): ThemeContract {
  const wordColors = new Map<string, string>();
  for (const keyword of mood.keywords) {
    wordColors.set(keyword.word, colors[SLOT_PROPERTY[FAMILY_STYLE[keyword.family].colorSlot]]);
  }
  return { ...colors, wordColors, mood: mood.mood };
}
