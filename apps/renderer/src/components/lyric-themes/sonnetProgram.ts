/**
 * 商籁（sonnet）的**编译层**：把逐字素时间轴的歌词行编译成一份确定性的「分镜程序」。
 *
 * 结构与凝彩同构：**程序 → 段落 → 镜头 → 提示（cue）**，帧层与渲染层只消费这份程序，
 * 所以"哪一行、什么时候、用哪种镜头"这些判断全在这里，且**纯函数、可单测、确定性**。
 *
 * === AGPL 说明 ===
 * folia-major 是 AGPL-3.0。这里的**类型契约**（有哪些字段、段落为什么断开、转场挂在段落上）
 * 依照它的 `sonnet/types.ts`；编译逻辑在本仓库重写。
 *
 * === 照实说清哪些是推断（下一轮取源码对齐）===
 * 下面这几组阈值**没有取到 folia 的源码**，是按"能自洽、可测、观感合理"自拟的，已在各常量旁注明：
 * ① 段落断开的三个上限、② 段落种类的判定规则、③ 段落种类 → 可用镜头的对应表、④ 段落边界 → 转场种类的对应表。
 * 取到 `sonnetShotMg.ts` 之后要逐条比对替换。**在这一步之前不要把商籁的段落节奏说成"已对齐原版"。**
 */

import type { SonnetParagraphBoundary, SonnetParagraphKind, SonnetShotKind } from './sonnetKinds';
import { SONNET_TRANSITION_KINDS } from './sonnetTransitions';
import { SONNET_SHOT_KINDS } from './sonnetKinds';
import type { SonnetTransitionKind } from './sonnetKinds';
import type { StageLine, StageWord } from './types';

export interface SonnetSemanticSegment {
  readonly text: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly wordIndices: readonly number[];
  readonly isWordLike: boolean;
}

export interface SonnetCompiledLine {
  readonly sourceIndex: number;
  readonly text: string;
  readonly startTime: number;
  readonly endTime: number;
  /** 唱完还会停一小会儿，镜头要活到这个时刻（不是"最后一个字结束"）。 */
  readonly renderEndTime: number;
  readonly segments: readonly SonnetSemanticSegment[];
}

export interface SonnetAnimationCue {
  readonly at: number;
  readonly duration: number;
  readonly kind: 'enter' | 'hold' | 'exit' | 'accent';
  readonly segmentStart: number;
  readonly segmentEnd: number;
}

export interface SonnetShot {
  readonly id: string;
  readonly kind: SonnetShotKind;
  readonly startTime: number;
  readonly endTime: number;
  readonly lineIndices: readonly number[];
  readonly cues: readonly SonnetAnimationCue[];
  readonly camera: {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
    readonly rotation: number;
  };
}

export interface SonnetTransition {
  readonly kind: SonnetTransitionKind;
  readonly startTime: number;
  readonly endTime: number;
}

export interface SonnetParagraph {
  readonly id: string;
  readonly kind: SonnetParagraphKind;
  readonly boundary: SonnetParagraphBoundary;
  readonly startTime: number;
  readonly endTime: number;
  readonly lines: readonly SonnetCompiledLine[];
  readonly shots: readonly SonnetShot[];
  readonly transitionOut: SonnetTransition | null;
}

export interface SonnetProgram {
  readonly version: 1;
  readonly seed: string;
  readonly paragraphGapThreshold: number;
  readonly paragraphs: readonly SonnetParagraph[];
}

export interface SonnetCompileOptions {
  readonly seed: string;
  /** 行与行之间静默超过这个秒数就断段。folia 叫 `paragraphGapThreshold`。 */
  readonly paragraphGapThreshold?: number;
  /** 段内行数上限（推断值）。 */
  readonly maxLinesPerParagraph?: number;
  /** 段时长上限，秒（推断值）。 */
  readonly maxParagraphDuration?: number;
  /** 行唱完之后镜头还要多活多久，秒。 */
  readonly renderTail?: number;
}

/** folia 的默认段落间隔阈值（取到源码前先按 1.2s）。 */
/**
 * 段落间隙阈值的**兜底**值。
 *
 * 真正生效的是 `resolveSonnetParagraphGapThreshold`：原版按**全曲行间隙的中位数 × 2.5**
 * 动态定阈值（夹在 1.25 ~ 3.5 秒之间）。我们早先写死 1.2 —— 那是推断，已纠正。
 */
export const SONNET_DEFAULT_GAP_THRESHOLD = 1.25;
/** 推断值：一段最多几行。 */
export const SONNET_MAX_LINES_PER_PARAGRAPH = 6;
/** 推断值：一段最多几秒。 */
export const SONNET_MAX_PARAGRAPH_DURATION = 18;
/** 行唱完后镜头多活这么久（秒）。 */
export const SONNET_RENDER_TAIL = 0.35;

/** 确定性哈希：同一份歌词 + 同一个 seed 必须得到同一份程序。 */
/**
 * 段落间隙阈值（**照抄**）：取全曲"行与行之间静默"的**中位数 × 2.5**，夹在 1.25 ~ 3.5 秒。
 *
 * 为什么要动态：慢歌句间的停顿本来就长、快歌几乎不停 —— 一个写死的阈值不是把慢歌切碎，
 * 就是把快歌全并成一段。我们早先写死 1.2 秒，吃的就是这个亏。
 *
 * **与 folia 的差异**：原版用的是 `getLineRenderEndTime`（带渲染尾巴的行末），
 * 我们这里用「行起点 + 行时长」近似，量出来的间隙会略大一点点。
 */
export function resolveSonnetParagraphGapThreshold(lines: readonly StageLine[]): number {
  const gaps = lines
    .slice(1)
    .map((line, index) => {
      const previous = lines[index];
      if (previous === undefined) return 0;
      const previousEnd = (previous.timeMs + (previous.durationMs ?? 0)) / 1000;
      return line.timeMs / 1000 - previousEnd;
    })
    .filter((gap) => gap > 0);
  if (gaps.length === 0) return SONNET_DEFAULT_GAP_THRESHOLD;
  const sorted = [...gaps].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? sorted[middle] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return Math.min(3.5, Math.max(1.25, median * 2.5));
}

/** 把字符串压成 32 位整数：相机的随机位要靠它做位运算（照抄 hashSonnetSeed 的用途）。 */
function hashSonnetSeed(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

function hash01(seed: string, salt: number): number {
  let value = 2166136261 ^ salt;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  value ^= value >>> 15;
  value = Math.imul(value, 2246822507);
  value ^= value >>> 13;
  return (value >>> 0) / 4294967296;
}

/**
 * 段落种类 → 可用镜头（**推断表**，待对齐）。
 *
 * 一个段落给多种候选、再按种子挑一个，是为了"同一首歌里段落语气不同、但同类段落要有家族感"。
 */
export const SHOTS_BY_PARAGRAPH: Readonly<Record<SonnetParagraphKind, readonly SonnetShotKind[]>> = {
  breath: ['quiet-tableau', 'mask-reveal'],
  verse: ['editorial-column', 'poster-blocks', 'fragment-collage'],
  lift: ['tracking-ribbon', 'mask-reveal', 'type-impact'],
  chorus: ['type-impact', 'poster-blocks', 'fragment-collage'],
  break: ['quiet-tableau'],
  outro: ['quiet-tableau', 'mask-reveal'],
};

/** 段落**为什么**断开 → 用什么转场（**推断表**，待对齐）。 */
/*
 * **注意：这不是段落转场的选型依据。**
 *
 * 第 118 轮核实：全 `apps/renderer/src` 里**只有这一处引用**（即无人使用）；
 * 真正选转场的是下面段落装配里的 `chooseWithoutRepeat(SONNET_TRANSITION_KINDS, …)`
 * （与段落边界类型无关，只保证"相邻两段不重样"）。
 *
 * 它的存在曾经误导过我自己（第 116 轮据此误判"我们与上游口径不同"），所以这里明写一句：
 * 边界只决定**"为什么断段"**（要透出给调试与诊断用），**不决定**用哪种转场。
 * 待办：要么删掉、要么明确标注为"仅诊断对照表"，避免下一个人再被它带偏。
 */
export const TRANSITION_BY_BOUNDARY: Readonly<Record<SonnetParagraphBoundary, SonnetTransitionKind | null>> = {
  'song-start': null,
  'time-gap': 'camera-pull',
  'metadata': 'mono-glitch',
  'duration-cap': 'fast-blur',
  'line-cap': 'fast-blur',
};

const CJK_GRAPHEME = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/u;
const WORD_GRAPHEME = /[\p{L}\p{N}]/u;
/**
 * **只有这一族才做"碎片合并"**：CJK / 假名 / 谚文 / 叠字符号。拉丁词的分组来自源标记
 * （或 `Intl.Segmenter`），本来就是词，一旦按"最少两粒字素"去并会把 `go / od` 这种短词并坏 ✓。
 */
const CJK_FRAGMENT_ONLY =
  /^[\u2e80-\u303f\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\u3005\u3006\u30fc\uff66-\uff9f]+$/u;
/**
 * **不能起头的字素**（小假名 / 促音 / 长音符 / 叠字符号 / 浊半浊点）：
 * 日文里它们永远跟着前一个字出现 ⇒ 必须黏到左边，绝不允许自己开一个词块 ✓。
 * 含义就是主人说的"特别 CJK 小假名"：`きょ` / `ちょっ` / `ラーメン` / `時々` 都不能被切成
 * `き | ょ`、`ち | ょ | っ` 这种一粒一粒的盒子 ✓。
 */
const CJK_GLUE_HEAD =
  /^[\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308e\u3095\u3096\u309b\u309c\u30a1\u30a3\u30a5\u30a7\u30a9\u30c3\u30e3\u30e5\u30e7\u30ee\u30f5\u30f6\u30fc\u309d\u309e\u30fd\u30fe\u3005\u3006]/u;
/**
 * **助词**：单字助词**不自己起头**，要黏到左边那一段（`弱さ | を | 抱い | て` ⇒ `弱さを | 抱いて`）。
 *
 * 这是一条**可读性启发式**，不是语法结论：日文助词几乎总跟着前一个词出现，
 * 而"每粒字素都有词首标记"的卡拉OK 源会把它们切成独立碎片。清单只收**单字助词**，
 * 且只用来"决定黏左"，从不主动拆开任何一段 ✓。清单外的字一律不动（宁可少并，不可乱并）✓。
 *
 * ⚠ 匹配的是**候选组全部可见内容是不是恰好这一个字**（`isSingleParticleGroup`），
 * 不是"首字命中"：`もの` / `はるかな` 这类完整多字词首字也在表里，只看首字会把它们误吞 ✗。
 */
const CJK_PARTICLE_HEAD = /^[をがはにでとへものやかねよなぞぜ]$/u;
/**
 * **一个词块至少要有几粒字素**（默认 2）。
 *
 * 为什么是 2：日文卡拉OK 源常把每个字素都标成"词首"（`wordStart` 逐字为真），
 * 于是排版层拿到的是 `ご | 覧 | 召 | し | ま | せ | こ | の | 手` ——
 * 每个字各自一个盒子、各自吃"主角 4.0 倍 / 陪衬 1.2 倍"的字号 ⇒ 同一句话里相邻两个碎片
 * 的字号能差 2.3 倍、朝向也各按"第几个碎片"决定，读起来就是散的
 * （`.tmp/sonnet-probe/probe.test.ts` 的实测读数：`ご覧` 83.2px 紧挨着 `召` 35.7px）。
 * 合并到"至少两粒"之后，同样的歌词排成 `ご覧 | 召し | ませ | この | 手`，
 * 层级还在（主角仍是其中一块），但每一块都读得成一个词 ✓。
 */
export const SONNET_MIN_WORD_GRAPHEMES = 2;
/**
 * **空白 / 标点 / 符号**（照抄上游 `wordSegmentation.ts` 的 `PUNCTUATION_ONLY`）：
 * 命中它的段**不算实词**。我们早先用的是 `/\S/.test(text)`，那会把「、」这类标点算成实词，
 * 进而抬高"实词段数"、影响段落分类（一口气 / 扬起那两条阈值）与主角评选 —— 第 87 轮改正。
 */
const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]+$/u;
const WHITESPACE_ONLY = /^\s+$/u;

/** `Intl.Segmenter` 只建一次（编译层每首歌会调很多次，建实例不便宜）。 */
let wordSegmenter: Intl.Segmenter | null | undefined;
function getWordSegmenter(): Intl.Segmenter | null {
  if (wordSegmenter === undefined) {
    try {
      wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    } catch {
      wordSegmenter = null;
    }
  }
  return wordSegmenter;
}

/**
 * 把一行的**字素**拼成**词**（段）。
 *
 * 三条路，优先级从高到低：
 * ① 有 `wordStart` 标记（逐字时间戳 yrc 那条路会给）⇒ 直接按标记切；
 * ② **一个标记都没有**（普通 LRC 就是这样）⇒ 走 **`Intl.Segmenter` 的词粒度**：
 *    这正是原版的口径 —— 它分词的 `@chenglou/pretext` 在 README 里写明 `prepare()` 会
 *    "segment the text, apply glue rules"，运行期**依赖 `Intl.Segmenter`**。
 *    非"词"的那些段（空格、标点）按 glue 规则**黏到前一段**。
 * ③ `Intl.Segmenter` 不可用（老运行期）⇒ 退化成规则法：CJK 每字成词、拉丁/数字连段、空格标点黏前。
 *
 * 最后**三条路都要过一道 `mergeSonnetShortFragments`**（本轮新增）：把"一粒字素一个盒子"的
 * CJK 碎片并成至少两粒的可读词块，小假名 / 促音 / 长音一律黏左。见那个函数的注释 ✓。
 *
 * 第 64 轮之前这里只认 `wordStart`，于是普通 LRC 会"整行一段" —— 段粒度退化成行粒度。
 */
export function groupSonnetLineWords(line: StageLine): StageWord[][] {
  const groups: StageWord[][] = [];
  const marked = line.words.some((word) => word.wordStart === true);
  if (marked) {
    for (const word of line.words) {
      /*
       * **纯空白的字素自己成段**（照抄上游口径：`Intl.Segmenter` 总是把一段空白单独吐出来，
       * "every consumer is written against that"）—— 标点仍然黏到前一段。
       */
      if (word.wordStart === true || groups.length === 0 || WHITESPACE_ONLY.test(word.text)) {
        groups.push([word]);
      } else {
        groups[groups.length - 1]?.push(word);
      }
    }
    return mergeSonnetShortFragments(groups);
  }
  const bySegmenter = groupByIntlWordSegments(line);
  if (bySegmenter !== null) return mergeSonnetShortFragments(bySegmenter);
  for (const word of line.words) {
    const last = groups[groups.length - 1];
    if (last === undefined) {
      groups.push([word]);
      continue;
    }
    const isSpace = WHITESPACE_ONLY.test(word.text);
    const isCjk = CJK_GRAPHEME.test(word.text);
    const isWordChar = WORD_GRAPHEME.test(word.text);
    // 纯空白自己成段（不黏前）；标点/符号黏到前一段。
    if (isSpace) {
      groups.push([word]);
      continue;
    }
    if (!isWordChar && !isCjk) {
      last.push(word);
      continue;
    }
    if (isCjk) {
      groups.push([word]);
      continue;
    }
    const lastText = last[last.length - 1]?.text ?? '';
    if (WORD_GRAPHEME.test(lastText) && !CJK_GRAPHEME.test(lastText)) {
      last.push(word);
      continue;
    }
    groups.push([word]);
  }
  return mergeSonnetShortFragments(groups);
}

/** 这一组里**非空白**字素的粒数（全角/半角、组合字素都按 `[...text]` 数）✓。 */
function countVisibleGraphemes(group: readonly StageWord[]): number {
  let total = 0;
  for (const word of group) {
    for (const char of word.text) {
      if (char.trim() !== '') total += 1;
    }
  }
  return total;
}

/** 这一组是不是"纯 CJK / 假名碎片"（拉丁词、空白、标点、混合串都不算）✓。 */
function isCjkFragmentGroup(group: readonly StageWord[]): boolean {
  const text = group.map((word) => word.text).join('');
  return text.trim() !== '' && CJK_FRAGMENT_ONLY.test(text);
}

/** 这一组的**第一个可见字素**是不是"不能起头"的小假名 / 长音 / 促音 / 叠字符号 ✓。 */
function startsWithGlueGrapheme(group: readonly StageWord[]): boolean {
  const first = firstVisibleGrapheme(group);
  return first !== null && CJK_GLUE_HEAD.test(first);
}

/**
 * 这一组**全部可见内容**是不是**单独一个助词字素**（`を` / `の` …）。
 *
 * ⚠ 旧版看的是**首字**（`startsWithParticle`）：`もの` / `はるかな` / `がっこう` 这种完整多字词
 * 只要首字命中助词表，就会被当成"单字助词"吞到左块（`凌ぐ | もの` ⇒ `凌ぐもの`）✗。
 * 助词黏左的前提是"这一块本身就只是一个助词"，所以必须**整组**校验 ✓。
 */
function isSingleParticleGroup(group: readonly StageWord[]): boolean {
  let visible = '';
  for (const word of group) {
    for (const char of word.text) {
      if (char.trim() !== '') visible += char;
    }
  }
  return [...visible].length === 1 && CJK_PARTICLE_HEAD.test(visible);
}

/** 这一组的第一个可见字素（没有可见字素时 `null`）✓。 */
function firstVisibleGrapheme(group: readonly StageWord[]): string | null {
  for (const word of group) {
    for (const char of word.text) {
      if (char.trim() !== '') return char;
    }
  }
  return null;
}

/**
 * **把过碎的 CJK 碎片并成能读的词块**（本轮新增，主人的第 2 条）。
 *
 * 两条路，按"源给的边界有多细"自动选：
 * ① **这一整段里每一组都只有一粒字素**（`ご|覧|召|し|ま|せ|こ|の|手` 这种逐字/逐拍的卡拉OK 标记）
 *    ⇒ 把这一段 CJK 的**字素摊平重排**：从左往右累积到至少 `SONNET_MIN_WORD_GRAPHEMES` 粒，
 *    下一粒是"不能起头"的小假名 / 促音 / 长音 / 叠字符号 / 单字助词就继续吞；
 * ② **只要其中有一组已经成形**（两粒以上：`言葉` / `ありがとう` / ICU 分好的词）⇒ 只做
 *    "过短的并进左邻"这一条，绝不去拆已经成形的词。
 *
 * ⚠ 判据必须是"**全部**都是单字碎片"，不能写成"**最长**的一段 ≤ 两粒"：后者会把
 * `Intl.Segmenter` 给出的 `あり|ふれ|た|言葉|に`（最长一段正是有意义的二字词 `言葉`）也摊平，
 * 排成 `あり|ふれ|た言|葉に` —— 已成形二字词被从中间切开 ✗。这正是本轮的修正点 ✓。
 *
 * 三段硬规矩：
 * · 拉丁词、空白、标点组**不参与**合并（两块之间夹着它们就绝不越过）✓；
 * · 末尾只剩一粒字素时并进上一块（`抱い | て` ⇒ `抱いて`）✓；
 * · 只改"哪几粒字素算一个盒子"：字号层级（主角 / 次主角 / 陪衬）、逐字入场时间、拖尾与
 *   词级几何都照旧按段各自求值 ⇒ **强调层级不受影响** ✓。
 *
 * 例（全部来自录屏里出现的那几个词）：
 * · `ご|覧|召|し|ま|せ|こ|の|手` ⇒ `ご覧 | 召し | ませ | この手`
 * · `凌ぐ|弱さ|を|抱い|て` ⇒ `凌ぐ | 弱さを | 抱いて`
 * · `ち|ょ|っ|と` ⇒ `ちょっと`
 * · `ありがとう`（本来就是词）⇒ `ありがとう`（一个字不动）
 */
export function mergeSonnetShortFragments(groups: readonly StageWord[][]): StageWord[][] {
  const merged = mergeSonnetShortFragmentsCore(groups);
  /* 末尾只剩一粒字素（且上一块也是 CJK 碎片）⇒ 并进上一块，避免最后孤零零一个盒子 ✓ */
  const last = merged[merged.length - 1];
  const previous = merged[merged.length - 2];
  if (
    last !== undefined &&
    previous !== undefined &&
    isCjkFragmentGroup(last) &&
    isCjkFragmentGroup(previous) &&
    countVisibleGraphemes(last) < SONNET_MIN_WORD_GRAPHEMES
  ) {
    merged.splice(merged.length - 2, 2, [...previous, ...last]);
  }
  return merged;
}

function mergeSonnetShortFragmentsCore(groups: readonly StageWord[][]): StageWord[][] {
  const merged: StageWord[][] = [];
  let index = 0;
  while (index < groups.length) {
    const head = groups[index];
    if (head === undefined) {
      index += 1;
      continue;
    }
    if (!isCjkFragmentGroup(head)) {
      /* 非 CJK（拉丁词 / 空白 / 标点）：原样保留，且它天然成为合并的边界 ✓ */
      merged.push([...head]);
      index += 1;
      continue;
    }
    /* 取出一整段连续的纯 CJK 碎片，再按"源边界有多细"决定用哪条路 ✓ */
    let end = index + 1;
    while (end < groups.length && isCjkFragmentGroup(groups[end] ?? [])) end += 1;
    const run = groups.slice(index, end);
    index = end;
    /*
     * 只有"**每一组都只有一粒字素**"才是"源边界比词还细"，才允许摊平重排；
     * 只要有一组已经成形（≥ 两粒），就保留这些组、只把候选的单字黏左 ✓。
     */
    const allSingleGrapheme = run.every(
      (group) => countVisibleGraphemes(group) < SONNET_MIN_WORD_GRAPHEMES,
    );
    merged.push(
      ...(allSingleGrapheme ? repackCjkGraphemes(run.flat()) : joinShortCjkFragments(run)),
    );
  }
  return merged;
}

/**
 * ① **逐字素重排**（源边界过细时）：只看字素本身，不看源边界。
 * 小假名 / 促音 / 长音 / 叠字符号 / **单独一个助词**不能起头 ⇒ 一律黏左 ✓。
 * （助词看的是**整词**：`もの` / `はるかな` 这种多字词不算"单独一个助词"，见 `isSingleParticleGroup`。）
 */
function repackCjkGraphemes(words: readonly StageWord[]): StageWord[][] {
  const blocks: StageWord[][] = [];
  let current: StageWord[] = [];
  for (const word of words) {
    const first = firstVisibleGrapheme([word]);
    if (first === null) {
      /* 纯空白/标点字素：黏在当前位置（不新起一块）✓ */
      current.push(word);
      continue;
    }
    const glueLeft = CJK_GLUE_HEAD.test(first) || isSingleParticleGroup([word]);
    if (current.length > 0 && countVisibleGraphemes(current) >= SONNET_MIN_WORD_GRAPHEMES && !glueLeft) {
      blocks.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/**
 * ② **过短的并进左邻**（这一段里存在已成形词组时）：只吞**候选组自己**"不足两粒"，或整组就是
 * "不能起头"的一个字素（小假名 / 促音 / 长音 / 叠字符号 / 单字助词）✓。
 * 完整的多字词（`もの` / `言葉` / `はるかな`）不因首字是助词而被吞，也绝不被摊平切开 ✓。
 * 例：`あり|ふれ|た|言葉|に` ⇒ `あり | ふれた | 言葉に` ✓。
 */
function joinShortCjkFragments(run: readonly StageWord[][]): StageWord[][] {
  const joined: StageWord[][] = [];
  for (const group of run) {
    const previous = joined[joined.length - 1];
    if (previous === undefined) {
      joined.push([...group]);
      continue;
    }
    /*
     * ⚠ 判据是**候选组自己**不足两粒（"过短的并进左邻"，与函数注释同义），不是"前一块过短"：
     * 旧版按前一块判，会把 `夢 | はるかな` 里的完整多字词 `はるかな` 吞进只有一粒的 `夢` ✗。
     */
    const short = countVisibleGraphemes(group) < SONNET_MIN_WORD_GRAPHEMES;
    const glueLeft = startsWithGlueGrapheme(group) || isSingleParticleGroup(group);
    if (short || glueLeft) {
      joined[joined.length - 1] = [...previous, ...group];
      continue;
    }
    joined.push([...group]);
  }
  return joined;
}

/**
 * 用 `Intl.Segmenter` 的词粒度分词，再把结果映射回**字素**分组。
 * 不可用时返回 `null`（交给上面那条规则法）。
 */
function groupByIntlWordSegments(line: StageLine): StageWord[][] | null {
  const segmenter = getWordSegmenter();
  if (segmenter === null || line.words.length === 0) return null;
  // 字素在整行文本里的起始偏移（字素可能是多个码元，所以按长度累加）。
  const offsets: number[] = [];
  let cursor = 0;
  for (const word of line.words) {
    offsets.push(cursor);
    cursor += word.text.length;
  }
  const text = line.text.length > 0 ? line.text : line.words.map((word) => word.text).join('');
  const groups: StageWord[][] = [];
  for (const part of segmenter.segment(text)) {
    const start = part.index;
    const end = start + part.segment.length;
    const chunk: StageWord[] = [];
    for (let index = 0; index < line.words.length; index += 1) {
      const offset = offsets[index] ?? 0;
      if (offset >= start && offset < end) {
        const word = line.words[index];
        if (word !== undefined) chunk.push(word);
      }
    }
    if (chunk.length === 0) continue;
    /*
     * glue 规则（照抄上游 `sonnetSemantic` 的那趟黏着）：**非实词且非纯空白**才黏到前一段 ——
     * 纯空白要自己成段，因为下游（含我们自己的段落分类）都按"空白是独立段"来数。
     */
    const last = groups[groups.length - 1];
    if (part.isWordLike !== true && !WHITESPACE_ONLY.test(part.segment) && last !== undefined) last.push(...chunk);
    else groups.push(chunk);
  }
  return groups.length > 0 ? groups : null;
}

function toCompiledLine(line: StageLine, renderTail: number): SonnetCompiledLine {  const startTime = line.timeMs / 1000;
  const endTime = (line.timeMs + line.durationMs) / 1000;
  // 逐字素时间轴里最后一个字的结束时间才是"真唱完"，`durationMs` 有时不含尾音。
  let lastWordEnd = endTime;
  for (const word of line.words) {
    lastWordEnd = Math.max(lastWordEnd, word.endMs / 1000);
  }
  /*
   * **段的粒度是词**（照抄 folia 那边 `prepareWithSegments` 的分词结果）。
   *
   * 舞台给的是**字素**序列（空格也占一个），所以这里得按 `wordStart` 标记把字素拼成词 ——
   * 第 63 轮之前我们是"一个字素一个段"，帧层按段摆字之后就变成了"每个字各自一个盒子"，
   * 那是**过碎**的，屏幕上会散成一颗颗字。分组规则与 `buildTemperaSegments` 保持一致：
   * 没有被标记时整行进一个段（等价于旧的"一行一块"，至少不会更糟）。
   */
  const segments: SonnetSemanticSegment[] = [];
  for (const group of groupSonnetLineWords(line)) {
    const first = group[0];
    const last = group[group.length - 1];
    if (first === undefined || last === undefined) continue;
    const text = group.map((word) => word.text).join('');
    segments.push({
      text,
      startTime: first.startMs / 1000,
      endTime: last.endMs / 1000,
      wordIndices: group.map((word) => line.words.indexOf(word)).filter((value) => value >= 0),
      // 实词判据照抄上游：空白 / 标点 / 符号都不算词。
      isWordLike: !PUNCTUATION_ONLY.test(text),
    });
  }
  return {
    sourceIndex: line.index,
    text: line.text,
    startTime,
    endTime,
    renderEndTime: Math.max(endTime, lastWordEnd) + renderTail,
    segments,
  };
}

/**
 * 段落种类（**照抄 folia `classifyParagraph`** 的判定顺序与阈值）。
 *
 * 优先级：副歌 > 间奏 > 末段 > 一口气（时长 ≤ 3.5s 或实词片段 ≤ 3）> 扬起（感叹号 ≥ 2 个，
 * 或"实词片段 / 时长 > 2.5"）> 主歌。
 *
 * **与 folia 的差异**：它是从 `line.isChorus` 与 `line.songPart` 读副歌/间奏标记的，
 * 我们的 `StageLine` 没有这两个字段，所以这两档暂时取不到 —— 剩下的判定完全相同。
 */
function classifyParagraph(
  lines: readonly SonnetCompiledLine[],
  index: number,
  total: number,
): SonnetParagraphKind {
  if (lines.length === 0) return 'break';
  if (index === total - 1) return 'outro';
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined) return 'verse';
  const duration = last.renderEndTime - first.startTime;
  const segmentCount = lines.reduce(
    (sum, line) => sum + line.segments.filter((segment) => segment.isWordLike).length,
    0,
  );
  const punctuationCount = lines.reduce(
    (sum, line) => sum + (line.text.match(/[!?！？…]/g)?.length ?? 0),
    0,
  );
  if (duration <= 3.5 || segmentCount <= 3) return 'breath';
  if (punctuationCount >= 2 || segmentCount / Math.max(duration, 1) > 2.5) return 'lift';
  return 'verse';
}

function buildShot(
  paragraphId: string,
  kind: SonnetShotKind,
  lines: readonly SonnetCompiledLine[],
  seed: string,
  ordinal: number,
): SonnetShot {
  const startTime = lines[0]?.startTime ?? 0;
  const endTime = lines.reduce((latest, line) => Math.max(latest, line.renderEndTime), startTime);
  const cues: SonnetAnimationCue[] = [];
  lines.forEach((line, index) => {
    const span = Math.max(0.05, line.endTime - line.startTime);
    cues.push({
      at: line.startTime,
      duration: span,
      kind: 'enter',
      segmentStart: index,
      segmentEnd: index,
    });
    cues.push({
      at: line.endTime,
      duration: Math.max(0.05, line.renderEndTime - line.endTime),
      kind: 'exit',
      segmentStart: index,
      segmentEnd: index,
    });
  });
  if (cues.length === 0) {
    cues.push({ at: startTime, duration: 0.01, kind: 'hold', segmentStart: 0, segmentEnd: 0 });
  }
  /*
   * 运镜（**照抄 folia 的数值**）。
   *
   * 它把"中景偏近"当基准：海报方块那族构图优先，所以最宽（1.02）；静场次之（1.12）；
   * 其余镜头 1.22 起步，再加一点随机跨度（0.16 / 0.2 / 0.26）。
   * 位移与旋转的振幅分别是 ±0.09 / ±0.07（画面比例）与 ±0.04 弧度。
   *
   * 我们早先写的是 `±0.03 / ±0.02 / 0.02 弧度` —— 那是推断值，小了三四倍，已纠正。
   */
  const random = hashSonnetSeed(`${seed}:${paragraphId}:${ordinal}:camera`);
  const zoomRandom = ((random >>> 16) & 255) / 255;
  const zoomBase = kind === 'poster-blocks' ? 1.02 : kind === 'quiet-tableau' ? 1.12 : 1.22;
  const zoomSpan = kind === 'poster-blocks' ? 0.16 : kind === 'quiet-tableau' ? 0.2 : 0.26;
  return {
    id: `${paragraphId}-shot-${ordinal}`,
    kind,
    startTime,
    endTime,
    lineIndices: lines.map((line) => line.sourceIndex),
    cues,
    camera: {
      x: ((random & 255) / 255 - 0.5) * 0.18,
      y: (((random >>> 8) & 255) / 255 - 0.5) * 0.14,
      zoom: zoomBase + zoomRandom * zoomSpan,
      rotation: (((random >>> 24) & 255) / 255 - 0.5) * 0.08,
    },
  };
}

/** 从种子的位置开始，找一个**不跟上一个重复**的选项（照抄 `chooseWithoutRepeat`）。 */
function chooseWithoutRepeat<T extends string>(
  choices: readonly T[],
  seed: string,
  previous: T | null,
): T {
  const start = Math.floor(hash01(seed, 17) * choices.length);
  for (let offset = 0; offset < choices.length; offset += 1) {
    const candidate = choices[(start + offset) % choices.length];
    if (candidate !== undefined && candidate !== previous) return candidate;
  }
  const fallback = choices[start] ?? choices[0];
  if (fallback === undefined) throw new Error('chooseWithoutRepeat：候选表是空的');
  return fallback;
}
/**
 * 把一段里的行**分成几个镜头**（照抄 `groupShotLines`）：**最多 4 行、总时长不超过 6 秒**。
 *
 * 这是"一段多镜"的关键 —— 我们早先是"一段一镜"，所以排版写得再讲究，每镜也只有一行字可摆。
 * 原版注释说得很直白：这么分是为了**复用同一个背景 MG**。
 */
function groupShotLines(lines: readonly SonnetCompiledLine[]): SonnetCompiledLine[][] {
  const groups: SonnetCompiledLine[][] = [];
  let current: SonnetCompiledLine[] = [];
  let startTime = 0;
  for (const line of lines) {
    if (current.length === 0) {
      current.push(line);
      startTime = line.startTime;
      continue;
    }
    if (current.length < 4 && line.renderEndTime - startTime <= 6) {
      current.push(line);
    } else {
      groups.push(current);
      current = [line];
      startTime = line.startTime;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** 按"段落类型 + 行分组"造镜头（照抄 `buildShots` 的选型与两条例外）。 */
function buildShots(
  lines: readonly SonnetCompiledLine[],
  kind: SonnetParagraphKind,
  paragraphIndex: number,
  seed: string,
  previousKind: SonnetShotKind | null,
): SonnetShot[] {
  let lastKind = previousKind;
  return groupShotLines(lines).map((group, shotIndex) => {
    const signature = group.map((item) => item.text).join('|');
    let shotKind = chooseWithoutRepeat(
      SONNET_SHOT_KINDS,
      `${seed}:${paragraphIndex}:${shotIndex}:${signature}`,
      lastKind,
    );
    const wordCount = group.reduce(
      (sum, item) => sum + item.segments.filter((segment) => segment.isWordLike).length,
      0,
    );
    // 两条例外（照抄）：一口气那段若开头只有一两个词，就用安静的静场；
    // 副歌里不许出现静场，换成重字冲击。
    if (kind === 'breath' && shotIndex === 0 && wordCount <= 2) shotKind = 'quiet-tableau';
    if (kind === 'chorus' && shotKind === 'quiet-tableau') shotKind = 'type-impact';
    lastKind = shotKind;
    return buildShot(`p${paragraphIndex}`, shotKind, group, seed, shotIndex);
  });
}

/** 把歌词行编译成商籁的分镜程序。纯函数、确定性。 */
export function compileSonnetProgram(
  lines: readonly StageLine[],
  options: SonnetCompileOptions,
): SonnetProgram {
  const renderTail = options.renderTail ?? SONNET_RENDER_TAIL;
  // 阈值默认是**动态**的（全曲行间隙中位数 × 2.5，夹 1.25~3.5），照抄原版。
  const gapThreshold = options.paragraphGapThreshold ?? resolveSonnetParagraphGapThreshold(lines);
  const maxLines = options.maxLinesPerParagraph ?? SONNET_MAX_LINES_PER_PARAGRAPH;
  const maxDuration = options.maxParagraphDuration ?? SONNET_MAX_PARAGRAPH_DURATION;
  const compiled = lines.map((line) => toCompiledLine(line, renderTail));

  // ① 先按"静默够长"断开草稿，边界类型留着后面定转场用。
  interface Draft {
    boundary: SonnetParagraphBoundary;
    lines: SonnetCompiledLine[];
  }
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  compiled.forEach((line, index) => {
    const previous = compiled[index - 1];
    const silence = previous === undefined ? 0 : line.startTime - previous.renderEndTime;
    const boundary: SonnetParagraphBoundary | null =
      previous === undefined ? 'song-start' : silence >= gapThreshold ? 'time-gap' : null;
    if (boundary !== null) {
      current = { boundary, lines: [] };
      drafts.push(current);
    }
    current?.lines.push(line);
  });

  /*
   * ② 过大的草稿继续切：**超过 6 行 或 跨度超过 18 秒**，切点选"第 2 行到倒数第 2 行之间
   *    **间隙最大**的那一处"（不是简单地按行数一刀切 —— 照抄 `splitOversizedDraft`）。
   */
  const splitDraft = (draft: Draft): Draft[] => {
    const output: Draft[] = [];
    let remaining = draft.lines;
    let boundary = draft.boundary;
    let guard = 0;
    while (
      remaining.length > maxLines ||
      (remaining.length > 1 &&
        (remaining[remaining.length - 1]?.renderEndTime ?? 0) - (remaining[0]?.startTime ?? 0) > maxDuration)
    ) {
      if (guard > 1000) break;
      guard += 1;
      let bestIndex = Math.min(maxLines, remaining.length - 1);
      let bestGap = Number.NEGATIVE_INFINITY;
      for (let offset = 2; offset < remaining.length - 1; offset += 1) {
        const gap = (remaining[offset]?.startTime ?? 0) - (remaining[offset - 1]?.renderEndTime ?? 0);
        if (Number.isFinite(gap) && gap > bestGap) {
          bestGap = gap;
          bestIndex = offset;
        }
      }
      const splitIndex = Math.max(1, bestIndex);
      output.push({ lines: remaining.slice(0, splitIndex), boundary });
      remaining = remaining.slice(splitIndex);
      boundary = (output[output.length - 1]?.lines.length ?? 0) >= maxLines ? 'line-cap' : 'duration-cap';
    }
    output.push({ lines: remaining, boundary });
    return output;
  };
  const split: Draft[] = [];
  for (const draft of drafts) split.push(...splitDraft(draft));

  // ③ 判类型 → 切成多镜 → 定出场转场。
  let previousShot: SonnetShotKind | null = null;
  let previousTransition: SonnetTransitionKind | null = null;
  const paragraphs = split.map((draft, index) => {
    const kind = classifyParagraph(draft.lines, index, split.length);
    const shots = buildShots(draft.lines, kind, index, options.seed, previousShot);
    previousShot = shots[shots.length - 1]?.kind ?? previousShot;
    const startTime = draft.lines[0]?.startTime ?? 0;
    const endTime = draft.lines.reduce((latest, line) => Math.max(latest, line.renderEndTime), startTime);
    const next = split[index + 1];
    const nextStart = next?.lines[0]?.startTime ?? endTime;
    const gap = next === undefined ? 0 : nextStart - endTime;
    // 转场种类也是"不重复"地轮流挑；时长 `min(0.3, max(0.16, gap × 0.5))`（照抄）。
    const transitionKind =
      next === undefined
        ? null
        : chooseWithoutRepeat(
            SONNET_TRANSITION_KINDS,
            `${options.seed}:${index}:transition`,
            previousTransition,
          );
    if (transitionKind !== null) previousTransition = transitionKind;
    const transitionDuration =
      next === undefined ? 0 : Math.min(0.3, Math.max(0.16, gap > 0 ? gap * 0.5 : 0.2));
    return {
      // 前缀照抄上游（`sonnet-p${index}`）；它只用于诊断/调试标识，查找一律按 `startTime` 走。
      id: `sonnet-p${index}`,
      kind,
      boundary: draft.boundary,
      startTime,
      endTime,
      lines: draft.lines,
      shots,
      transitionOut:
        transitionKind === null
          ? null
          : {
              kind: transitionKind,
              startTime: Math.max(startTime, nextStart - transitionDuration),
              endTime: nextStart,
            },
    } satisfies SonnetParagraph;
  });

  return {
    version: 1,
    seed: options.seed,
    paragraphGapThreshold: gapThreshold,
    paragraphs,
  };
}
