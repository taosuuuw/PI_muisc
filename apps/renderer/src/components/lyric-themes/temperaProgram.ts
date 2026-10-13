/**
 * 凝彩 = `tempera` 的 **program 编译器**：把整首歌的歌词编成一条「段落 → shot → slice」的确定时间轴。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**（`chthollyphile/folia-major@main`）。这里**只借鉴数值与做法**：
 * 段落划分阈值、shot 切分规则、装饰选法、flow 角收敛、转场时长公式都在下面逐条注明出处，
 * **每一个表达式都是在本仓库里重新写的**，没有拷贝任何 folia 源码文本。
 *
 * === 与 folia 的结构差异（照实记） ===
 * 1. **输入是我们的 `StageLine`**（`LyricStage` 交下来的逐字素时间轴，毫秒），不是 folia 的 `Line`（秒）。
 *    所以内部统一先换算成**秒**（folia 那些阈值 2.2 / 18 / 3.5 / 1.25~3.5 都是秒）。
 * 2. **没有 `songPart` / `blockIndex` 这两个元信息**（我们的歌词数据层不提供），因此
 *    `boundary: 'metadata'` 与 `kind: 'break'` 两条分支**不会出现**；副歌改用本仓库既有的
 *    `isChorusLine(lines, index)` 判据（同一句 trim 后 ≥4 字在整曲重复 >1 次）。
 * 3. **渲染尾**直接用本行的 `durationMs`（我们的舞台已经按 `hint` 算过尾长），
 *    不再叠 folia 的 `getLineRenderEndTime` 那一层。
 * 4. 词切分按我们的字素序列连 `wordStart` 标记分组（folia 走 `utils/lyrics/wordSegmentation.ts`）。

 * === 为什么整条时间轴要"可 seek" ===
 * 播放头随时可能跳到任意位置，而 shot 的挑选**有状态**（不能和上一个 shot 同一种构图、
 * flow 角要收敛到竖直轴）。folia 的做法是「从曲首按确定性哈希重算到当前时间」，而不是
 * 记录运行时状态 —— 这样 seek 前后画面完全一致。这里照此办理：**所有随机都出自种子哈希，
 * 与调用时刻无关**（`chooseWithoutRepeat` / `temperaHash01` 都是纯函数）。
 */

import type { StageLine, StageWord } from './types';
import { isChorusLine } from './types';
import {
  TEMPERA_DECOR_MOTIFS,
  TEMPERA_TRANSITION_KINDS,
  type TemperaDecorMotif,
  type TemperaMood,
  type TemperaParagraphBoundary,
  type TemperaParagraphKind,
  type TemperaShotKind,
  type TemperaTransitionKind,
} from './temperaKinds';
import { resolveTemperaShotCandidates, resolveTemperaShotProfile } from './temperaProfiles';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/* ------------------------------------------------------------------ *
 * 确定性哈希（folia: tempera/temperaRandom.ts）
 *
 * 三个都是**标准算法**：字符串那一支是 FNV-1a（偏移 2166136261、质数 16777619），
 * 数值那一支是 Knuth 乘法哈希（常数 2654435761），元素抖动用它再乘一个 97。
 * 这些常量属于算法定义本身（不是 folia 的创造性表达），而**必须逐位等价**：
 * 哈希换了，构图/装饰/镜头抖动的挑选序列就跟着变，"按观感逼近"立刻落空。
 * ------------------------------------------------------------------ */

/** 字符串种子 → 32 位整数（FNV-1a）。 */
export function hashTemperaSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 数值种子 + 盐 → 另一个 32 位整数（让各子系统互不相关）。 */
export function mixTemperaSeed(seed: number, salt: number): number {
  return Math.imul((Math.trunc(seed) ^ salt) >>> 0, 2654435761) >>> 0;
}

/** 确定性 0~1 抖动：同一 `(seed, index, salt)` 永远同一个值，与调用时刻无关。 */
export function temperaHash01(seed: number, index: number, salt: number): number {
  return mixTemperaSeed(seed + Math.imul(index + 1, 97), salt) / 4294967296;
}

/** 在候选里挑一个**尽量与上一个不同**的（folia: `chooseWithoutRepeat`）。 */
export function chooseWithoutRepeat<T extends string>(
  choices: readonly T[],
  seedKey: string,
  previous: T | null,
): T {
  if (choices.length === 0) throw new Error('chooseWithoutRepeat: 候选为空');
  const start = hashTemperaSeed(seedKey) % choices.length;
  for (let offset = 0; offset < choices.length; offset += 1) {
    const candidate = choices[(start + offset) % choices.length] as T;
    if (candidate !== previous) return candidate;
  }
  return choices[start] as T;
}

/* ------------------------------------------------------------------ *
 * 类型（与 folia 的 tempera/types.ts 对应）
 * ------------------------------------------------------------------ */

/** 一个**词**（folia 的 `TemperaSegment`）：排版与入场的最小单位。 */
export interface TemperaSegment {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly graphemes: readonly StageWord[];
  /** 秒。 */
  readonly startTime: number;
  readonly endTime: number;
  /** 是不是"词"（标点与空白不是；黏着标点会并进前一个词）。 */
  readonly isWordLike: boolean;
}

/** 编译后的行（folia 的 `TemperaCompiledLine`）。 */
export interface TemperaCompiledLine {
  readonly sourceIndex: number;
  readonly line: StageLine;
  /** 秒。 */
  readonly startTime: number;
  /** 本行的渲染尾（秒）：`min(本行结束, 下一行开始)`，绝不越到下一行里。 */
  readonly renderEndTime: number;
  readonly segments: readonly TemperaSegment[];
}

export interface TemperaShotSlice {
  readonly lineIndex: number;
  readonly segmentStart: number;
  readonly segmentEnd: number;
}

export interface TemperaCameraKey {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly rotation: number;
}

export interface TemperaDecorFragment {
  readonly char: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scale: number;
}

export interface TemperaDecorWatermark {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scale: number;
}

/** 编译期定下来的装饰描述（绘制层照它画，不做任何随机）。 */
export interface TemperaDecorSpec {
  readonly motif: TemperaDecorMotif;
  readonly hatchAngle: number;
  readonly crossCount: number;
  readonly scribbleSeed: number;
  readonly fragments: readonly TemperaDecorFragment[];
  readonly watermark: TemperaDecorWatermark | null;
}

/** 一个 shot：镜头、构图、装饰、它负责的歌词切片都在这里定死。 */
export interface TemperaShot {
  readonly id: string;
  readonly kind: TemperaShotKind;
  /** 秒。 */
  readonly startTime: number;
  readonly endTime: number;
  /**
   * 本 shot 最后一个字素停下的时刻（秒）。
   * 与 `endTime` 不同：`endTime` 会被「铺满时间轴」改写成下一个 shot 的起点，
   * 而入场的错落节奏必须按真正的唱词结束时刻来排。
   */
  readonly lyricEndTime: number;
  readonly slices: readonly TemperaShotSlice[];
  /** 器乐间隙里的空构图（没有歌词）。 */
  readonly isBridge: boolean;
  readonly camera: TemperaCameraKey;
  readonly cameraEnd: TemperaCameraKey;
  readonly flowAngle: number;
  readonly decor: TemperaDecorSpec;
}

export interface TemperaTransition {
  readonly kind: TemperaTransitionKind;
  readonly startTime: number;
  readonly endTime: number;
}

export interface TemperaParagraph {
  readonly id: string;
  readonly kind: TemperaParagraphKind;
  readonly boundary: TemperaParagraphBoundary;
  readonly startTime: number;
  readonly endTime: number;
  readonly lines: readonly TemperaCompiledLine[];
  readonly shots: readonly TemperaShot[];
  readonly transitionOut: TemperaTransition | null;
}

export interface TemperaProgram {
  readonly version: 1;
  readonly seed: string;
  readonly paragraphGapThreshold: number;
  readonly paragraphs: readonly TemperaParagraph[];
}

export interface TemperaProgramOptions {
  /** 一行一个 shot（不做半句切分）。默认 false。 */
  readonly wholeLineLyrics?: boolean;
}

/* ------------------------------------------------------------------ *
 * 1) 分词与行编译
 * ------------------------------------------------------------------ */

const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]+$/u;
const WHITESPACE_ONLY = /^\s+$/u;

/**
 * 把一行切成**词级** segment（folia: `buildTemperaSegments`）。
 *
 * 我们的字素序列自带 `wordStart` 标记（舞台按原词切开时打的），这就是词边界；
 * 没有标记时退化成「整行一个词」（行内只有空白时会被下面的黏着规则并回去）。
 */
export function buildTemperaSegments(line: StageLine): TemperaSegment[] {
  if (line.text.length === 0) return [];
  const ranges: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const word of line.words) {
    ranges.push({ start: cursor, end: cursor + word.text.length });
    cursor += word.text.length;
  }

  // 按 wordStart 标记把字素分组；没有被标记时整行一组。
  const groups: StageWord[][] = [];
  line.words.forEach((word) => {
    if (word.wordStart === true || groups.length === 0) groups.push([word]);
    else groups[groups.length - 1]?.push(word);
  });

  const raw: TemperaSegment[] = [];
  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    if (first === undefined || last === undefined) continue;
    const graphemeIndex = line.words.indexOf(first);
    const lastGraphemeIndex = line.words.indexOf(last);
    const startOffset = ranges[graphemeIndex]?.start ?? 0;
    const endOffset = ranges[lastGraphemeIndex]?.end ?? line.text.length;
    const text = line.text.slice(startOffset, endOffset);
    raw.push({
      text,
      startOffset,
      endOffset,
      graphemes: group,
      startTime: first.startMs / 1000,
      endTime: last.endMs / 1000,
      isWordLike: !PUNCTUATION_ONLY.test(text),
    });
  }

  /*
   * 黏着标点前并（folia 的 sticky 那一遍）：标点自己没有被解析器覆盖的时长，
   * 只有并进前一个词才不会「跟着下一个词一起出现」。并的时候把无时长的字素钉到前一个词的尾部，
   * 否则这一段的结束时间会被拖到下一个词的起点。
   */
  const sticky: TemperaSegment[] = [];
  for (const segment of raw) {
    const previous = sticky[sticky.length - 1];
    if (previous !== undefined && !segment.isWordLike && !WHITESPACE_ONLY.test(segment.text)) {
      const tail = previous.endTime;
      const merged = segment.graphemes.map((grapheme) => {
        const start = grapheme.startMs / 1000;
        const end = grapheme.endMs / 1000;
        return end > start ? grapheme : { ...grapheme, startMs: tail * 1000, endMs: tail * 1000 };
      });
      sticky[sticky.length - 1] = {
        ...previous,
        text: previous.text + segment.text,
        endOffset: segment.endOffset,
        graphemes: [...previous.graphemes, ...merged],
        endTime: Math.max(previous.endTime, ...merged.map((grapheme) => grapheme.endMs / 1000)),
      };
    } else {
      sticky.push(segment);
    }
  }
  return sticky;
}

/** 编译整首歌的行（folia: `compileTemperaProgram` 开头那一段）。 */
export function compileTemperaLines(lines: readonly StageLine[]): TemperaCompiledLine[] {
  return lines.map((line, sourceIndex) => {
    const startTime = line.timeMs / 1000;
    const nextStart = lines[sourceIndex + 1]?.timeMs;
    const ownEnd = startTime + Math.max(line.durationMs, 0) / 1000;
    return {
      sourceIndex,
      line,
      startTime,
      renderEndTime: Math.max(
        startTime,
        Math.min(ownEnd, nextStart === undefined ? Number.POSITIVE_INFINITY : nextStart / 1000),
      ),
      segments: buildTemperaSegments(line),
    };
  });
}

/* ------------------------------------------------------------------ *
 * 2) 段落划分
 * ------------------------------------------------------------------ */

/** 段落间隔阈值（folia: `resolveTemperaParagraphGapThreshold` = `clamp(中位数×2.5, 1.25, 3.5)`）。 */
export function resolveTemperaParagraphGapThreshold(lines: readonly StageLine[]): number {
  const gaps: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const previous = lines[index - 1];
    if (line === undefined || previous === undefined) continue;
    const previousEnd = previous.timeMs / 1000 + Math.max(previous.durationMs, 0) / 1000;
    const gap = line.timeMs / 1000 - Math.min(previousEnd, line.timeMs / 1000);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 1.25;
  const sorted = [...gaps].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? sorted[middle] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return clamp(median * 2.5, 1.25, 3.5);
}

interface ParagraphDraft {
  lines: TemperaCompiledLine[];
  boundary: TemperaParagraphBoundary;
}

/** 一口气超过 6 行、或跨度超过 18s 的段落要再切（folia: `splitOversizedDraft`）。 */
function splitOversizedDraft(draft: ParagraphDraft): ParagraphDraft[] {
  const output: ParagraphDraft[] = [];
  let remaining = draft.lines;
  let boundary = draft.boundary;
  let guard = 0;
  while (
    remaining.length > 6 ||
    (remaining.length > 1 &&
      (remaining[remaining.length - 1]?.renderEndTime ?? 0) - (remaining[0]?.startTime ?? 0) > 18)
  ) {
    if (guard++ > 1000) break;
    // 只在第 2 行之后、最后一行之前找切点：切在句首或句尾都没有意义。
    const candidates = remaining.slice(2, -1).map((line, offset) => ({
      splitIndex: offset + 2,
      gap: line.startTime - (remaining[offset + 1]?.renderEndTime ?? 0),
    }));
    const valid = candidates.filter((candidate) => !Number.isNaN(candidate.gap));
    const rawSplit = valid.sort((left, right) => right.gap - left.gap)[0]?.splitIndex ?? Math.min(4, remaining.length - 1);
    const splitIndex = Math.max(1, rawSplit);
    output.push({ lines: remaining.slice(0, splitIndex), boundary });
    remaining = remaining.slice(splitIndex);
    boundary = (output[output.length - 1]?.lines.length ?? 0) >= 6 ? 'line-cap' : 'duration-cap';
  }
  output.push({ lines: remaining, boundary });
  return output;
}

/**
 * 段落类型（folia: `classifyParagraph`）。
 *
 * 顺序有讲究：副歌 > 收尾 > 换气（≤3.5s 或 ≤3 个词）> 抬升（标点 ≥2 或词密度 >2.5）> 主歌。
 * 我们的数据层没有 `songPart`，所以 folia 的 `break`（桥段）那一支不出现。
 *
 * `chorusFlags` 必须来自**整曲**：folia 直接读数据层的 `line.isChorus`，而我们的副歌是
 * 自造判据（同一句在整曲重复 >1 次）—— 只看本段那几行永远判不出「重复」。缺省时按「没有副歌」处理。
 */
export function classifyParagraph(
  lines: readonly TemperaCompiledLine[],
  index: number,
  total: number,
  chorusFlags?: readonly boolean[],
): TemperaParagraphKind {
  if (chorusFlags !== undefined && lines.some((item) => chorusFlags[item.sourceIndex] === true)) {
    return 'chorus';
  }
  if (index === total - 1) return 'outro';
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined) return 'breath';
  const duration = last.renderEndTime - first.startTime;
  const segmentCount = lines.reduce(
    (sum, line) => sum + line.segments.filter((segment) => segment.isWordLike).length,
    0,
  );
  const punctuationCount = lines.reduce(
    (sum, line) => sum + (line.line.text.match(/[!?！？…]/g)?.length ?? 0),
    0,
  );
  if (duration <= 3.5 || segmentCount <= 3) return 'breath';
  if (punctuationCount >= 2 || segmentCount / Math.max(duration, 1) > 2.5) return 'lift';
  return 'verse';
}

/* ------------------------------------------------------------------ *
 * 3) shot 切分
 * ------------------------------------------------------------------ */

interface ShotChunk {
  lineIndex: number;
  segmentStart: number;
  segmentEnd: number;
  startTime: number;
  endTime: number;
  lyricEndTime: number;
}

const isRenderableSegment = (segment: TemperaSegment): boolean =>
  segment.text.trim().length > 0 && segment.graphemes.length > 0;

/**
 * 把歌词切成 shot 的料（folia: `buildShotChunks`）。
 *
 * 默认规则：一个 chunk 攒够**随机的 2~4 个词**、或已经花掉 ~2.2s 就收；`wholeLineLyrics` 时一行一个。
 * 收尾还要**铺满时间轴**（每个 shot 跑到下一个 shot 开拍），否则运行时那套
 * 「最后一个已经开拍的 shot」查表会落在空洞里。`lyricEndTime` 故意**不**参与铺满。
 */
export function buildShotChunks(
  lines: readonly TemperaCompiledLine[],
  seed: string,
  paragraphIndex: number,
  wholeLineLyrics: boolean,
): ShotChunk[] {
  const chunks: ShotChunk[] = [];
  for (const line of lines) {
    const usable = line.segments
      .map((segment, index) => ({ segment, index }))
      .filter((entry) => isRenderableSegment(entry.segment));
    if (usable.length === 0) continue;

    if (wholeLineLyrics) {
      const first = usable[0];
      const last = usable[usable.length - 1];
      if (first === undefined || last === undefined) continue;
      const endTime = Math.max(last.segment.endTime, first.segment.startTime + 0.2);
      chunks.push({
        lineIndex: line.sourceIndex,
        segmentStart: first.index,
        segmentEnd: last.index + 1,
        startTime: first.segment.startTime,
        endTime,
        lyricEndTime: endTime,
      });
      continue;
    }

    let segmentStart = usable[0]?.index ?? 0;
    let startTime = usable[0]?.segment.startTime ?? 0;
    /*
     * 【**已撤回**】第 769 轮曾试把分块规则从"词数"改成"字符预算"（12~16 字符，
     * 想让短行不拆、长行才拆）。**第 770 轮回滚**，因为 `pnpm test` 红了 **3 个**，
     * 其中一个**不是陈旧的断言、而是布局不变量**：
     *
     *     FAIL  temperaFrame.test.ts > 字素落在排版框内，且延迟按序号递增、hero 词更大
     *     FAIL  temperaFrame.test.ts > shot 切分产出的 slice 与编译行对得上（帧层能查到字）
     *     FAIL  temperaProgram.test.ts > 每个 shot 攒 2~4 个词，超过 2.2s 也收   ← 上游对账断言
     *
     * ⇒ **"块更大"与"字更大"是被排版框锁在一起的一对**：块变大 ⇒ 同样宽度的框里塞不下
     * ⇒ fit loop 只能把字号压小（这正是"一行一镜 ⇒ 字小"的成因）。
     * 所以**光调分块解决不了主人这两个诉求**，必须动**排版框（profile 的 `region`）本身**。
     *
     * 以下是当时保留的思路，供以后参考：
     *
     * 上游默认是"攒够随机的 **2~4 个词**、或花掉 ~2.2s 就收" ⇒ 一句中等长度的歌词会被切成
     * 好几个 shot、背景跟着切好几次 ⇒ 主人一开始就说"拆很散、不停切背景"。
     * 而第 130 轮我打开的"一行一个 shot"（`wholeLineLyrics`）又走到另一个极端：
     * **整行塞进同一块区域** ⇒ fit loop 自动缩小字号 ⇒ 主人马上问"歌词是不是小了点"。
     *
     * ⇒ 两者之间那条线是**字符预算**：攒到约 **14 个字符**（或约 **3.5 秒**，上游也用过 3.5 这个量级）
     * 才收。于是 **短行整行就是一个 shot（不拆），只有长行才拆** ——
     * 既不像"2~4 个词"那么散，也不会因为整行塞不下而被压小字号。
     */
    let words = 0;
    usable.forEach((entry, order) => {
      words += 1;
      const chunkSeed = hashTemperaSeed(
        `${seed}:${paragraphIndex}:${line.sourceIndex}:${chunks.length}`,
      );
      const target = 2 + Math.floor(temperaHash01(chunkSeed, 1, 179) * 3);
      const spent = entry.segment.endTime - startTime;
      const isLast = order === usable.length - 1;
      if (!isLast && words < target && spent < 2.2) return;

      const endTime = Math.max(entry.segment.endTime, startTime + 0.2);
      chunks.push({
        lineIndex: line.sourceIndex,
        segmentStart,
        segmentEnd: entry.index + 1,
        startTime,
        endTime,
        lyricEndTime: endTime,
      });
      const next = usable[order + 1];
      if (next !== undefined) {
        segmentStart = next.index;
        startTime = next.segment.startTime;
        words = 0;
      }
    });
  }
  return chunks.map((chunk, index) => ({
    ...chunk,
    endTime: Math.max(chunk.startTime + 0.2, chunks[index + 1]?.startTime ?? chunk.endTime),
  }));
}

/* ------------------------------------------------------------------ *
 * 4) 镜头与装饰
 * ------------------------------------------------------------------ */

/** 镜头关键帧（folia: `buildCameraKeys`）：方向永远来自 flow 角，profile 只定行程与变焦。 */
export function buildCameraKeys(
  kind: TemperaShotKind,
  seed: number,
  flowAngle: number,
): { start: TemperaCameraKey; end: TemperaCameraKey } {
  const jitterX = (temperaHash01(seed, 1, 11) - 0.5) * 0.02;
  const jitterY = (temperaHash01(seed, 2, 23) - 0.5) * 0.02;
  const jitterZoom = temperaHash01(seed, 3, 37) * 0.025;
  const jitterRotation = (temperaHash01(seed, 4, 51) - 0.5) * 0.012;
  const { camera } = resolveTemperaShotProfile(kind);
  const travelX = Math.cos(flowAngle) * camera[0];
  const travelY = Math.sin(flowAngle) * camera[0];
  return {
    start: {
      x: -travelX / 2 + jitterX,
      y: -travelY / 2 + jitterY,
      zoom: camera[1] + jitterZoom,
      rotation: jitterRotation,
    },
    end: {
      x: travelX / 2 + jitterX,
      y: travelY / 2 + jitterY,
      zoom: camera[2] + jitterZoom,
      rotation: -jitterRotation,
    },
  };
}

/** 页边散字（folia: `buildDecorFragments`）：从**本 shot 没在排的**歌词里取。 */
export function buildDecorFragments(
  pool: string,
  count: number,
  seed: number,
): TemperaDecorFragment[] {
  const chars = Array.from(pool).filter(
    (char) => char.trim().length > 0 && !PUNCTUATION_ONLY.test(char),
  );
  if (chars.length === 0 || count <= 0) return [];
  return Array.from({ length: count }, (_value, index) => {
    const char = chars[Math.floor(temperaHash01(seed, index, 13) * chars.length) % chars.length] as string;
    const onLeft = temperaHash01(seed, index, 29) > 0.5;
    const edge = 0.03 + temperaHash01(seed, index, 41) * 0.13;
    return {
      char,
      x: onLeft ? edge : 1 - edge,
      y: 0.08 + temperaHash01(seed, index, 53) * 0.84,
      rotation: (temperaHash01(seed, index, 67) - 0.5) * 0.5,
      scale: 0.26 + temperaHash01(seed, index, 71) * 0.2,
    };
  });
}

/**
 * 超大装饰词（folia: `buildDecorWatermark`）。
 *
 * 取自本 shot **没在排**的词 —— 所以它读起来是这一句周围的句子，而不是把屏幕上的字再写一遍。
 * `loud` 构图不带它（它已经有一个主形状了）；`hash01 > 0.62` 也不带。
 */
export function buildDecorWatermark(
  pool: readonly string[],
  seed: number,
  allowed: boolean,
): TemperaDecorWatermark | null {
  const words = pool.map((word) => word.trim()).filter((word) => word.length > 0 && word.length <= 12);
  if (!allowed || words.length === 0 || temperaHash01(seed, 4, 107) > 0.62) return null;
  return {
    text: words[Math.floor(temperaHash01(seed, 5, 109) * words.length) % words.length] as string,
    x: 0.28 + temperaHash01(seed, 6, 113) * 0.44,
    y: 0.26 + temperaHash01(seed, 7, 127) * 0.48,
    rotation: (temperaHash01(seed, 8, 131) - 0.5) * 0.5,
    scale: 2.6 + temperaHash01(seed, 9, 137) * 1.9,
  };
}

/** 一个 shot 的装饰（folia: `buildDecorSpec`）：母题、网线角、交叉线数、散字与装饰词。 */
export function buildDecorSpec(
  paragraphKind: TemperaParagraphKind,
  shotKind: TemperaShotKind,
  seedKey: string,
  fragmentPool: string,
  watermarkPool: readonly string[],
  previousMotif: TemperaDecorMotif | null,
): TemperaDecorSpec {
  const seed = hashTemperaSeed(seedKey);
  const motif = chooseWithoutRepeat(TEMPERA_DECOR_MOTIFS, seedKey, previousMotif);
  const profile = resolveTemperaShotProfile(shotKind);
  const sparse = profile.mood === 'quiet' || paragraphKind === 'break' || paragraphKind === 'outro';
  return {
    motif,
    // 只走浅斜角：太陡的网线在后处理颗粒上去之后会读成噪点。
    hatchAngle: (temperaHash01(seed, 1, 83) - 0.5) * (Math.PI / 2),
    crossCount: 1 + Math.floor(temperaHash01(seed, 2, 89) * 3),
    scribbleSeed: mixTemperaSeed(seed, 97),
    fragments: sparse
      ? buildDecorFragments(fragmentPool, 3 + Math.floor(temperaHash01(seed, 3, 101) * 3), seed)
      : [],
    watermark: buildDecorWatermark(watermarkPool, seed, profile.mood !== 'loud'),
  };
}

/**
 * flow 角（folia: `resolveFlowAngle`）。
 *
 * 竖直是凝彩的家轴：构图之间是「互相滑过」的交接，只有以竖直为主的流向才读得出
 * 「一头扎进场景」，而不是横向幻灯片。所以每个 shot 转一点、又被拉回轴上一次（0.3）。
 */
export function resolveFlowAngle(previous: number | null, seed: number): number {
  if (previous === null) {
    const sign = temperaHash01(seed, 6, 71) > 0.5 ? 1 : -1;
    return (sign * Math.PI) / 2 + (temperaHash01(seed, 8, 79) - 0.5) * 0.4;
  }
  const axis = (Math.sin(previous) >= 0 ? 1 : -1) * (Math.PI / 2);
  return previous + (axis - previous) * 0.3 + (temperaHash01(seed, 7, 73) - 0.5) * 0.5;
}

/* ------------------------------------------------------------------ *
 * 5) shot 组装
 * ------------------------------------------------------------------ */

function buildShots(
  lines: readonly TemperaCompiledLine[],
  songLines: readonly TemperaCompiledLine[],
  kind: TemperaParagraphKind,
  paragraphIndex: number,
  seed: string,
  previousKind: TemperaShotKind | null,
  previousMotif: TemperaDecorMotif | null,
  previousFlow: number | null,
  wholeLineLyrics: boolean,
): { shots: TemperaShot[]; lastKind: TemperaShotKind | null; lastMotif: TemperaDecorMotif | null; lastFlow: number | null } {
  let lastKind = previousKind;
  let lastMotif = previousMotif;
  let lastFlow = previousFlow;
  const paragraphEnd = lines[lines.length - 1]?.renderEndTime ?? 0;
  const chunks = buildShotChunks(lines, seed, paragraphIndex, wholeLineLyrics);
  const byIndex = new Map(lines.map((line) => [line.sourceIndex, line]));

  const shots = chunks.map((chunk, shotIndex) => {
    const line = byIndex.get(chunk.lineIndex);
    const sliceSegments = line?.segments.slice(chunk.segmentStart, chunk.segmentEnd) ?? [];
    const sliceText = sliceSegments.map((segment) => segment.text).join('');
    const wordCount = sliceSegments.filter((segment) => segment.isWordLike).length;
    // 换气段读作稀疏构图；副歌绝不"小声"。
    const sparse = kind === 'breath' || (kind !== 'chorus' && wordCount <= 2);
    const moods: readonly TemperaMood[] = sparse
      ? ['quiet']
      : kind === 'chorus'
        ? ['neutral', 'loud']
        : ['quiet', 'neutral', 'loud'];
    const shotKind = chooseWithoutRepeat(
      resolveTemperaShotCandidates(moods),
      `${seed}:${paragraphIndex}:${shotIndex}:${sliceText}`,
      lastKind,
    );
    lastKind = shotKind;

    const cameraSeed = hashTemperaSeed(`${seed}:${paragraphIndex}:${shotIndex}:camera`);
    const flowAngle = resolveFlowAngle(lastFlow, cameraSeed);
    lastFlow = flowAngle;
    const { start, end } = buildCameraKeys(shotKind, cameraSeed, flowAngle);

    /*
     * 散字与装饰词的池子取自**这一段里本 shot 没排到**的字；
     * 一整段只有这一句、shot 又整句吃下（whole-line 模式的常态）时，改从**全曲其他行**借 ——
     * 总之不能把屏幕上已有的字再画一遍。池子空了就干脆不画。
     */
    const outsideSlice = lines.flatMap((item) =>
      item.sourceIndex === chunk.lineIndex
        ? item.segments.filter(
            (_segment, index) => index < chunk.segmentStart || index >= chunk.segmentEnd,
          )
        : item.segments,
    );
    const decorPool =
      outsideSlice.length > 0
        ? outsideSlice
        : songLines.flatMap((item) =>
            item.sourceIndex === chunk.lineIndex ? [] : item.segments,
          );
    const decor = buildDecorSpec(
      kind,
      shotKind,
      `${seed}:${paragraphIndex}:${shotIndex}:decor`,
      decorPool.map((segment) => segment.text).join(''),
      decorPool.filter((segment) => segment.isWordLike).map((segment) => segment.text),
      lastMotif,
    );
    lastMotif = decor.motif;

    return {
      id: `p${paragraphIndex}-s${shotIndex}`,
      kind: shotKind,
      startTime: chunk.startTime,
      // 收尾那个 shot 一直撑到这一段的渲染尾。
      endTime:
        shotIndex === chunks.length - 1 ? Math.max(chunk.endTime, paragraphEnd) : chunk.endTime,
      lyricEndTime: chunk.lyricEndTime,
      slices: [
        {
          lineIndex: chunk.lineIndex,
          segmentStart: chunk.segmentStart,
          segmentEnd: chunk.segmentEnd,
        },
      ],
      isBridge: false,
      camera: start,
      cameraEnd: end,
      flowAngle,
      decor,
    } satisfies TemperaShot;
  });

  return { shots, lastKind, lastMotif, lastFlow };
}

/** 比这个短的间隙已经被段落转场自己盖住了（folia: `BRIDGE_MIN_GAP`）。 */
export const TEMPERA_BRIDGE_MIN_GAP = 1.2;
/** 一个 bridge shot 最长 5s，再长就切成多个（folia: `BRIDGE_MAX_LENGTH`）。 */
export const TEMPERA_BRIDGE_MAX_LENGTH = 12;

/** 用没有歌词的 shot 填满器乐间隙（folia: `buildBridgeShots`）。 */
export function buildBridgeShots(
  paragraphKind: TemperaParagraphKind,
  paragraphIndex: number,
  seed: string,
  fragmentPool: string,
  gapStart: number,
  gapEnd: number,
  previousKind: TemperaShotKind | null,
  previousMotif: TemperaDecorMotif | null,
  previousFlow: number | null,
): TemperaShot[] {
  const gap = gapEnd - gapStart;
  if (gap < TEMPERA_BRIDGE_MIN_GAP) return [];
  // 按 5s 一档切，但**最多 3 个**：所以只有 ≤15s 的间隙才真的做到「每个 ≤5s」，
  // 更长的器乐段里单个 bridge 会超过 5s（folia 的实现就是这个上限关系，我们照做，不擅自改它的行为）。
  /*
   * **去掉 `min(3, …)` 这个上限**（第 776 轮；主人第 774 轮原话：
   * 「**纯音乐背景也是要有变化**」）。
   *
   * 原来 `count = min(3, max(1, ceil(gap / 5)))` ⇒ **再长的间隙也只造 3 个镜头**：
   * 60 秒的器乐段 ⇒ 3 个镜头 ⇒ **每镜 20 秒** ⇒ 背景一分钟只换 3 次 ⇒ 看起来"静止"。
   *
   * 而同一个函数里已经有 `TEMPERA_BRIDGE_MAX_LENGTH = 5`（"单个桥段镜头不超过 5 秒"）这个意图
   * —— `min(3, …)` 恰恰把它废掉了。去掉上限后：间隙 ÷ 5 就是镜头数，
   * 60 秒 ⇒ 12 个镜头（每镜 5 秒）⇒ 器乐段也有正常的画面变化。
   *
   * ⚠ 这是**有意偏离上游**（上游 `buildBridgeShots` 带那个 3 的上限），如实记档。
   */
  const count = Math.max(1, Math.ceil(gap / TEMPERA_BRIDGE_MAX_LENGTH));
  const step = gap / count;
  let lastKind = previousKind;
  let lastMotif = previousMotif;
  let lastFlow = previousFlow;

  return Array.from({ length: count }, (_value, index) => {
    // 器乐的一拍从来不是整首歌里最响的东西。
    const shotKind = chooseWithoutRepeat(
      resolveTemperaShotCandidates(['quiet', 'neutral']),
      `${seed}:${paragraphIndex}:bridge${index}`,
      lastKind,
    );
    lastKind = shotKind;
    const cameraSeed = hashTemperaSeed(`${seed}:${paragraphIndex}:bridge${index}:camera`);
    const flowAngle = resolveFlowAngle(lastFlow, cameraSeed);
    lastFlow = flowAngle;
    const { start, end } = buildCameraKeys(shotKind, cameraSeed, flowAngle);
    const decor = buildDecorSpec(
      paragraphKind,
      shotKind,
      `${seed}:${paragraphIndex}:bridge${index}:decor`,
      fragmentPool,
      [],
      lastMotif,
    );
    lastMotif = decor.motif;
    return {
      id: `p${paragraphIndex}-b${index}`,
      kind: shotKind,
      startTime: gapStart + step * index,
      endTime: gapStart + step * (index + 1),
      // bridge 不带歌词，图形按整个间隙铺节奏。
      lyricEndTime: gapStart + step * (index + 1),
      slices: [],
      isBridge: true,
      camera: start,
      cameraEnd: end,
      flowAngle,
      decor,
    } satisfies TemperaShot;
  });
}

/* ------------------------------------------------------------------ *
 * 6) 主入口
 * ------------------------------------------------------------------ */

/** 段落转场时长（folia: `min(1, max(0.35, 间隙 + 0.3))`）。 */
export function resolveTemperaTransitionDuration(gap: number): number {
  return Math.min(1, Math.max(0.35, Math.max(gap, 0) + 0.3));
}

/**
 * **无歌词段的占位行**（第 782 轮）。
 *
 * 主人把两种情形分得很清：「**纯音乐用 🎵，。。。。是给有歌词的歌曲中没歌词的部分**」。
 *
 *  · `lines` 为空 = **整首纯音乐** ⇒ 平铺 **🎵**（每 10 秒一条、共 90 条 = 15 分钟）。
 *    拿不到歌曲时长，所以铺得足够长 —— 这样纯音乐也有内容与**定期的背景变化**；
 *  · 有歌词、但**开头一段没歌词** ⇒ 一条「**。。。。**」覆盖 `0 → 第一句`
 *    （空隙 **≥1.2 秒**才插，与 `TEMPERA_BRIDGE_MIN_GAP` 同门槛；太短不插，免得开场闪一下）。
 *
 * ⚠ 为什么要抽成纯函数：这段逻辑原先内联在 `TemperaTheme.tsx` 的 `useMemo` 里，
 * 而冒烟**碰不到纯音乐**（能触达的歌都带歌词）⇒ 🎵 这条只能"看代码相信"，**没有证据**。
 * 抽出来 + 单测，才有可复现的判据。
 */
export function buildTemperaPlaceholderLines(
  lines: readonly StageLine[],
): readonly StageLine[] {
  const first = lines[0];
  /*
   * **占位探针**（第 780 轮加的，第 783 轮随本函数一起搬过来）：
   * 把"这一首歌用的是哪种占位"直接打出来。之前我拿校准点的 `字素=` 去猜，
   * 结果抽到的歌开头就有歌词 ⇒ 占位压根没触发、读数什么都证明不了。
   * 有了这条，**不管抽到哪首歌都能判定**占位有没有走到。
   */
  console.info(
    `[pi/tempera] intro-placeholder mode=${
      first === undefined ? 'note' : first.timeMs < 1200 ? 'none' : 'dots'
    } spanMs=${(first?.timeMs ?? 0).toFixed(0)} lines=${String(lines.length)}`,
  );
  if (first === undefined) {
    const note = '🎵';
    const noteSpanMs = 10000;
    const noteCount = 90;
    return Array.from({ length: noteCount }, (_, index) => {
      const startMs = index * noteSpanMs;
      const endMs = startMs + noteSpanMs;
      return {
        index: -1000 - index,
        timeMs: startMs,
        text: note,
        durationMs: noteSpanMs,
        hint: 'normal' as const,
        words: [{ text: note, startMs, endMs, wordStart: true }],
        starts: [startMs],
        ends: [endMs],
      };
    });
  }
  const spanMs = first.timeMs;
  if (spanMs < 1200) return lines;
  const dots = '。。。。';
  const chars = [...dots];
  const step = spanMs / chars.length;
  const words = chars.map((char, index) => ({
    text: char,
    startMs: step * index,
    endMs: step * (index + 1),
    wordStart: index === 0,
  }));
  return [
    {
      index: -1,
      timeMs: 0,
      text: dots,
      durationMs: spanMs,
      hint: 'normal' as const,
      words,
      starts: words.map((word) => word.startMs),
      ends: words.map((word) => word.endMs),
    },
    ...lines,
  ];
}

/** 编译整首歌（folia: `compileTemperaProgram`）。 */
export function compileTemperaProgram(
  lines: readonly StageLine[],
  seed: string | number = 'tempera',
  options: TemperaProgramOptions = {},
): TemperaProgram {
  const compiled = compileTemperaLines(lines);
  const resolvedSeed = String(seed);
  const paragraphGapThreshold = resolveTemperaParagraphGapThreshold(lines);
  const drafts: ParagraphDraft[] = [];
  let current: ParagraphDraft = { lines: [], boundary: 'song-start' };

  compiled.forEach((line, index) => {
    const previous = compiled[index - 1];
    const gap = previous === undefined ? 0 : line.startTime - previous.renderEndTime;
    // 我们的数据层没有 blockIndex / songPart ⇒ folia 的 'metadata' 边界不出现。
    const boundary: TemperaParagraphBoundary | null =
      previous !== undefined && gap >= paragraphGapThreshold ? 'time-gap' : null;
    if (boundary !== null && current.lines.length > 0) {
      drafts.push(...splitOversizedDraft(current));
      current = { lines: [], boundary };
    }
    current.lines.push(line);
  });
  if (current.lines.length > 0) drafts.push(...splitOversizedDraft(current));

  let previousShot: TemperaShotKind | null = null;
  let previousMotif: TemperaDecorMotif | null = null;
  let previousFlow: number | null = null;
  let previousTransition: TemperaTransitionKind | null = null;

  /*
   * 副歌标记按**整曲**算一次（我们的判据是「同一句在整曲重复 >1 次」，段落自己看不出来）。
   * 这里把整曲的 `StageLine` 交给 `isChorusLine`，与 `MonetTheme` 用的是同一条判据。
   */
  const songStageLines = lines;
  const chorusFlags = compiled.map((item) => isChorusLine(songStageLines, item.sourceIndex));

  const paragraphs: TemperaParagraph[] = drafts.map((draft, index) => {
    const kind = classifyParagraph(draft.lines, index, drafts.length, chorusFlags);
    const built = buildShots(
      draft.lines,
      compiled,
      kind,
      index,
      resolvedSeed,
      previousShot,
      previousMotif,
      previousFlow,
      options.wholeLineLyrics === true,
    );
    const lyricShots = built.shots;
    previousShot = built.lastKind;
    previousMotif = built.lastMotif;
    previousFlow = built.lastFlow;

    const next = drafts[index + 1];
    const first = draft.lines[0];
    const last = draft.lines[draft.lines.length - 1];
    if (first === undefined || last === undefined) {
      throw new Error('compileTemperaProgram: 空段落');
    }
    const endTime = last.renderEndTime;
    const gap = next ? (next.lines[0]?.startTime ?? 0) - endTime : 0;
    const bridgeShots = next
      ? buildBridgeShots(
          kind,
          index,
          resolvedSeed,
          draft.lines.map((item) => item.line.text).join(''),
          endTime,
          next.lines[0]?.startTime ?? endTime,
          previousShot,
          previousMotif,
          previousFlow,
        )
      : [];
    /*
     * **开头（第一句歌词之前）也要有画面**（第 777 轮；主人原话：
     * 「**普通歌曲开头没歌词但背景静止**」）。
     *
     * 桥段原来只在**两个段落之间**生成（下面那个 `next ? buildBridgeShots(...)`），
     * 所以**第 0 段之前那段完全没有任何镜头** ⇒ 只剩满幅纸 + 底色 ⇒ 看起来是静止的空画面。
     * 这里给第 0 段在前面补一段"开头桥"，并把段落起点提前到桥的第一镜。
     *
     * ⚠ 只改第 0 段；`gapStart` 取 0（歌曲开头），`gapEnd` 取第一句的 `startTime`。
     * 太短（< `TEMPERA_BRIDGE_MIN_GAP`）时 `buildBridgeShots` 自己返回空数组 ⇒ 无副作用。
     */
    const introShots =
      index === 0
        ? buildBridgeShots(
            kind,
            0,
            resolvedSeed,
            draft.lines.map((item) => item.line.text).join(''),
            0,
            first.startTime,
            previousShot,
            previousMotif,
            previousFlow,
          )
        : [];
    const shots = [...introShots, ...lyricShots, ...bridgeShots];
    const paragraphStart = introShots[0]?.startTime ?? first.startTime;
    previousShot = shots[shots.length - 1]?.kind ?? previousShot;
    previousMotif = shots[shots.length - 1]?.decor.motif ?? previousMotif;
    previousFlow = shots[shots.length - 1]?.flowAngle ?? previousFlow;

    const transitionKind: TemperaTransitionKind | null = next
      ? chooseWithoutRepeat(TEMPERA_TRANSITION_KINDS, `${resolvedSeed}:${index}:transition`, previousTransition)
      : null;
    if (transitionKind !== null) previousTransition = transitionKind;
    const transitionEndTime = next?.lines[0]?.startTime ?? endTime;
    const transitionDuration = next ? resolveTemperaTransitionDuration(gap) : 0;

    return {
      id: `tempera-p${index}`,
      kind,
      boundary: draft.boundary,
      startTime: paragraphStart,
      endTime,
      lines: draft.lines,
      shots,
      transitionOut:
        transitionKind === null
          ? null
          : {
              kind: transitionKind,
              startTime: Math.max(first.startTime, transitionEndTime - transitionDuration),
              endTime: transitionEndTime,
            },
    } satisfies TemperaParagraph;
  });

  /*
   * 下一段的第一帧要**提前开拍**（folia 那段 forEach）：段落边界常常落在没有歌词的间隙里，
   * 平移类转场如果等到边界之后才搭景，镜头就会滑进一块空白的壳。
   * `block-wipe` 例外 —— 它的 enter 阶段是「揭开遮罩」，必须发生在边界之后。
   * 逐字时序完全不动：这里改的只是 shot 自己的钟。
   */
  paragraphs.forEach((paragraph, index) => {
    const incoming = paragraph.shots[0];
    const previousParagraph = paragraphs[index - 1];
    const transition = previousParagraph?.transitionOut;
    if (incoming === undefined || transition === null || transition === undefined) return;
    if (transition.kind === 'block-wipe') return;
    if (previousParagraph === undefined) return;
    const shifted = Math.min(
      incoming.startTime,
      Math.max(transition.startTime, previousParagraph.endTime),
    );
    if (shifted !== incoming.startTime) {
      (paragraph.shots[0] as { startTime: number }).startTime = shifted;
    }
  });

  return { version: 1, seed: resolvedSeed, paragraphGapThreshold, paragraphs };
}

/** 某个时刻落在第几段（folia: `findTemperaParagraphIndexAtTime`）。 */
export function findTemperaParagraphIndexAtTime(program: TemperaProgram, time: number): number {
  for (let index = program.paragraphs.length - 1; index >= 0; index -= 1) {
    const paragraph = program.paragraphs[index];
    if (paragraph !== undefined && time >= paragraph.startTime) return index;
  }
  return 0;
}

/** 某个时刻落在哪个 shot（运行时每帧查的是这个；同段内按起点倒序找）。 */
export function findTemperaShotAtTime(
  paragraph: TemperaParagraph,
  time: number,
): TemperaShot | null {
  for (let index = paragraph.shots.length - 1; index >= 0; index -= 1) {
    const shot = paragraph.shots[index];
    if (shot !== undefined && time >= shot.startTime) return shot;
  }
  return paragraph.shots[0] ?? null;
}
