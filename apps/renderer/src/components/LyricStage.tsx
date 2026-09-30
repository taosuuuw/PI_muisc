import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { LyricLine, LyricTheme, LyricWord } from '@pi/shared';
import { DEFAULT_PALETTE, LYRIC_THEME_COMPONENTS, tuningOf, type LyricPalette } from './lyric-themes';

/**
 * 歌词舞台（用户 m08066 第 5 条）。
 *
 * 视觉与动效**数值**复刻 folia-major 的默认歌词主题 classic（显示名 Luminous／中文预览名「流光」）：
 * 单行居中舞台（`min-height: 300px`、行容器 `flex-wrap`、舞台 `perspective: 1000px`）、
 * 逐字素（grapheme）三态表（未唱透明缩小模糊 / 当前放大点亮 / 已唱回落到 0.82）、
 * 行进出场时长、当前行的呼吸浮动、底部字幕层（译文 + 下两句预览）。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**：这里只借鉴它的**数值、结构与做法**（数值表见任务书），
 * **没有拷贝任何 folia 源码文本**，下面每一个表达式都是在本仓库里自己写的。
 *
 * 与 folia 原版的结构差异：
 * - **classic 现在也是整窗舞台**（用户要求「以整个 app 界面作为展示舞台」）：舞台
 *   `position: absolute; inset: 0` 贴住整个播放页，字号按参考图重标为
 *   `clamp(2.25rem, 8cqi, 12rem)`、译文 / 预览同步放大（见 lyric-stage.css 的
 *   「classic：整窗舞台」那段，量测依据与「旧 → 新」数值都写在那边）。
 *   根节点仍是 `container-type: inline-size`：铺满之后 1cqi = 窗宽的 1%，与 `vw` 同量。
 * - 逐字三态、进出场时长、辉光半径这些**数值一个都没动**：它们本来就取自 folia 的**全屏**主题
 *   （folia 的舞台是整个窗口），铺满之后才是它们原本的比例。
 * - folia 用 rAF 驱动播放进度；我们 store 里的 `positionMs` 只有 ~4Hz（`<audio>` 的 timeupdate），
 *   所以 classic 分支在本组件里自带一个平滑时钟（`ClockAnchor` / `smoothPositionAt`：拿 store 值
 *   当锚点、用 `performance.now()` 外推），主题分支则各用 lyric-themes/types.ts 的 `usePositionClock`。
 *   两边都只在**推导结果变化**时提交，所以「一次换行一次渲染」这条性能契约没变（见第 3 条）。
 *
 * 三件**必须守住**的事：
 * 1. **绝不 seek**（用户 m08066 第 4 条）：组件不接 `onSeek`、不读 `usePlayer`，
 *    滚轮只改 `viewIndex`（看哪一句），点某一句则 seek 到它（第八轮第 3 条）。
 * 2. **DOM 属性契约**：根节点 `data-lyric-rail` / `data-active-index` / `data-view-index` /
 *    `data-following`，行元素 `data-lyric-line` / `data-active` / `data-hint` / `data-index`；
 *    主题分支的行元素还要带 `data-line-time`（毫秒），点行 seek 用事件委托读它。
 *    （第八轮第 3 条删掉了 `[data-lyric-follow]`「回到当前」按钮，滚回当前句仍自动跟随。）UI 冒烟直接查这些。
 * 3. **性能**：字符切分与每字素时间轴只在 `lines` 变化时算一次（`useMemo`），
 *    每帧只对「当前显示的那一行」做两次二分，且只有这一行渲染逐字素 span。
 */

export interface LyricStageProps {
  /** 原文行，按 `timeMs` 升序（主进程已排好）。 */
  lines: readonly LyricLine[];
  /** 译文：`timeMs → 文本`（时间轴与原文相互独立，所以按时间戳取）。 */
  translated: ReadonlyMap<number, string>;
  /** 当前播放位置（毫秒）。**只读**，绝不回写播放器。 */
  positionMs: number;
  /**
   * 整首歌曲时长（毫秒）；拿不到就省略（0 或 undefined 都当「不知道」）。
   *
   * **用户 m01402 第 3 条（M4 剩余项）**：浮名曲尾那条「剩余 N 秒」判据需要它——没有它就只能退回
   * 「整首歌词已经唱完」这个等价条件（见 `lyric-themes/FumeTheme.tsx` 的 `fumeOutroPlan`）。
   */
  durationMs?: number;
  /**
   * 歌词动效主题（用户 m08768 第 4 条：浮名 / 心象 / 云阶 / 倾诉 / 时计）。
   *
   * 不传、传 `'classic'`、或传一个还没实现的主题（`fume` / `cadenza`）时，都走 classic 分支，
   * 所以老调用点（详情页、UI 冒烟）不传这个 prop 时行为与改造前**完全一致**。
   */
  theme?: LyricTheme;
  /** 主题配色；不传就用 `DEFAULT_PALETTE`（CSS 变量，跟着亮/暗色走）。 */
  palette?: LyricPalette;
  /** 时计主题可选：封面 URL。**只认这个 prop**，不去 DOM 里抓播放页左上角那张缩略图。 */
  coverUrl?: string;
  /**
   * 点某一句 = 跳到这一句播放（用户第八轮第 3 条）。
   *
   * 滚轮换行**仍然不 seek**（m08066 第 4 条：滚动只换「看哪一句」），只有点才算跳转；
   * 不传这个 prop 时点行退回老行为（只把锚点交还给播放），老调用点不受影响。
   */
  onSeek?: (timeMs: number) => void;
}

type Hint = 'normal' | 'short' | 'micro';
/** 字素三态：`waiting` 未唱 / `active` 正在唱 / `passed` 唱过。导出是给平滑时钟的单测断言用。 */
export type WordState = 'waiting' | 'active' | 'passed';

/** 行时长 < 0.10s → micro；< 0.18s → short；其余 normal（folia 的 `renderHints`）。 */
const MICRO_MS = 100;
const SHORT_MS = 180;
/** 最后一行没有「下一行」可以减，给个兜底行时长，否则逐字轴会除到 0。 */
const LAST_LINE_FALLBACK_MS = 4000;
/** 滚轮累计这么多像素换一行（手感：一次滚轮咔哒 ≈ 一行）。 */
const WHEEL_STEP_PX = 72;
/** `deltaMode === 1`（按行滚）时一行折算多少像素，否则永远凑不满一格。 */
const WHEEL_LINE_PX = 16;
/**
 * 第十八轮第 4 条（用户 m01482：「**只允许时计**（主题）的歌词动效可以滚轮滑动查看不同歌词，
 * 并且一段时间无操作自动回到当前歌词」）。
 *
 * **用户 m01402 第 7 条**把 classic 也收了：「流光不要有滚轮可以切换歌词的功能。时计可以滚轮
 * 切换歌词，并且点击歌词可以跳进度」——这推翻了 m08066 第 4 条给 classic 开的滚轮浏览
 * （那条本来配的是「滚动只许查看、不 seek」，用户现在整条不要了）。所以今天只剩时计一套吃
 * 滚轮，其余五套主题（流光 / 浮名 / 心象 / 云阶 / 倾诉）舞台上滚轮回到页面本身。
 */
const WHEEL_BROWSE_THEMES: readonly LyricTheme[] = ['pendolo'];
/**
 * 允许「点击歌词行跳进度」的主题白名单（用户 m00001 第 4 条 + m00736 第 1 条）。
 *
 * 用户原话（m00001 第 4 条）：「除了时计可以点击歌词改变进度到对应位置，其他歌词动效点击都不允许有反应」。
 * 追评（m00736 第 1 条）：「classic（流光）主题点歌词不允许跳进度。时计可以用滚轮查看不同歌词，
 * 并且点歌词跳进度」——所以今天全库只有时计/pendolo 能点行 seek：
 * - 其余四套动效（浮名 / 心象 / 云阶 / 倾诉）本来就没有点击入口，白名单外整个不挂委托；
 * - classic 走的是自己那条分支（行按钮的 `onSelect`，用户第八轮第 3 条），m00736 之后那条 seek
 *   也摘掉了（`onSelect={undefined}`，见下面 classic 分支的注释）；m01402 第 7 条又把它的滚轮
 *   浏览一起收掉（见上面 `WHEEL_BROWSE_THEMES`）——所以流光今天点行、滚轮都不再动进度。
 */
export const CLICK_SEEK_THEMES: readonly LyricTheme[] = ['pendolo'];
/** 滚轮停手多久自动交还给播放（`viewIndex` 复位成「跟着播放走」）。 */
const WHEEL_IDLE_RETURN_MS = 4000;
/**
 * 平滑时钟的「停摆」阈值（毫秒）：超过这么久没收到新的 `positionMs` 就当播放器停了。
 *
 * `<audio>` 的 `timeupdate` 在 Chromium 上约 250ms 一跳（规范上限也是 250ms），所以：
 * - 取得太小 → 主线程忙一下就被误判成暂停，时钟冻一小下再跳（视觉上是一次小顿）；
 * - 取得太大 → 暂停后歌词还会自己往前多走一会儿（主题层 types.ts 的 `usePositionClock` 用 600ms，
 *   暂停后逐字会多推 0.6s）。
 * 400ms = 4Hz 的节拍 + 六成余量，暂停后最多多推 0.4s（残留风险见交付报告）。
 */
export const CLOCK_STALL_MS = 400;

interface WordTiming {
  /** 预读窗口：`positionMs >= 字.startTime - lookahead` 就算「正在唱」。 */
  lookaheadMs: number;
  /** 最短显示时长：一个字至少亮这么久，否则短行会一闪而过看不清。 */
  minDisplayMs: number;
  /** 逐字辉光的两层半径（text-shadow 双层，颜色用主色的 38% / 20%）。 */
  glowSmallPx: number;
  glowLargePx: number;
}

/**
 * folia classic 的逐字素三档参数（instant / fast / normal）。
 * 档位来自**行时长**而不是每个字的时长——行太短就整体降级成瞬时，来不及做补间。
 */
const WORD_TIMING: Record<Hint, WordTiming> = {
  micro: { lookaheadMs: 30, minDisplayMs: 80, glowSmallPx: 14, glowLargePx: 24 },
  short: { lookaheadMs: 80, minDisplayMs: 120, glowSmallPx: 18, glowLargePx: 32 },
  normal: { lookaheadMs: 150, minDisplayMs: 100, glowSmallPx: 20, glowLargePx: 40 },
};

interface StageWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /**
   * 「这是一个**词**的第一个字素」——只有逐字时间戳（yrc）那条路径会写它。
   *
   * 为什么需要：yrc 的 `line.words` 是**词**一级的时间戳，词与词之间的空格**不在里面**，
   * 所以拿它摊平出来的字素序列里根本没有空格字素（`segmentGraphemes(line.text)` 那条
   * 均分回退路径才有）。云阶的 `buildAtoms` 原来只靠「空格字素 → 断组」，于是整行英文会
   * 被收进**一个原子**里、DOM 又只在原子之间补空格，渲染出来就是
   * `havetokeephinding` 这种连成一坨的样子（第十四轮第 6 条复查时发现）。
   * 有了这个标记，云阶就能在词边界上断组，还原出词间空格。
   */
  readonly wordStart?: boolean;
}

interface StageLine {
  readonly index: number;
  readonly timeMs: number;
  readonly text: string;
  readonly durationMs: number;
  readonly hint: Hint;
  readonly words: readonly StageWord[];
  /** 升序的字素起点 / 终点数组：位置推进时二分用，比逐字比较稳也快。 */
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 升序数组里「≤ value 的元素个数」（upper bound）。 */
function upperBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] ?? Number.POSITIVE_INFINITY) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * 平滑时钟的锚点：`positionMs` 是「某个时刻的位置」，光有它推不出「现在」的位置。
 * 所以每次 store 值到货都记下**值与到货时刻**，中间用 rAF 自己外推（见 `smoothPositionAt`）。
 */
export interface ClockAnchor {
  /** 最近一次 store 报上来的位置（毫秒）。 */
  readonly ms: number;
  /** 它到货的时刻（`performance.now()` 口径）。 */
  readonly at: number;
  /** 位置最近一次**变化**的时刻；拿它判断时钟是不是停摆了。 */
  readonly movedAt: number;
}

/** 收到新的 `positionMs`（或组件第一帧）：把锚点挪过去。纯函数，`nowMs` 由调用方给。 */
export function resyncClock(positionMs: number, nowMs: number): ClockAnchor {
  return { ms: positionMs, at: nowMs, movedAt: nowMs };
}

/**
 * 平滑位置 = 锚点 + 从锚点到货到「现在」过去的时间；超过 `CLOCK_STALL_MS` 没有新值就冻在锚点上。
 *
 * 纯函数（`nowMs` 由调用方给），所以「两次 timeupdate 之间位置是否连续推进」「暂停后是否冻住」
 * 都能直接单测，不用碰 rAF 与 `<audio>`。
 */
export function smoothPositionAt(anchor: ClockAnchor, nowMs: number): number {
  if (nowMs - anchor.movedAt > CLOCK_STALL_MS) return anchor.ms;
  return anchor.ms + (nowMs - anchor.at);
}

/** 行时长 → 档位。 */
function hintFor(durationMs: number): Hint {
  if (durationMs < MICRO_MS) return 'micro';
  if (durationMs < SHORT_MS) return 'short';
  return 'normal';
}

/**
 * 行进场时长（毫秒）：
 * - normal：`min(0.42s, max(0.22s, max(行时长, 0.12s) × 0.34))`，
 *   行时长越短进得越急，但有 0.22s 的地板、0.42s 的天花板。
 * - fast：`clamp(行时长 × 0.45, 0.045s, 0.06s)`。
 * - micro：不进场（返回 0，CSS 里对应 `animation-name: none`）。
 */
function enterMsFor(hint: Hint, durationMs: number): number {
  if (hint === 'micro') return 0;
  if (hint === 'short') return clamp(durationMs * 0.45, 45, 60);
  return Math.min(420, Math.max(220, Math.max(durationMs, 120) * 0.34));
}

/** 行出场时长（毫秒）：normal 0.3s / fast 0.16s / micro 0.12s。 */
function exitMsFor(hint: Hint): number {
  if (hint === 'micro') return 120;
  if (hint === 'short') return 160;
  return 300;
}

/**
 * 把一行文本切成 grapheme：CJK 一个字一个，英文按字素簇（`e` + 附加符不会拆开）。
 * 环境没有 `Intl.Segmenter`（极老的 Chromium / ICU 裁剪构建）就退回按码元切，
 * 至少不崩，只是组合字素会被拆成两半。
 */
function segmentGraphemes(text: string): string[] {
  if (text.length === 0) return [];
  if (typeof Intl.Segmenter !== 'function') return Array.from(text);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

/**
 * `out[i]` = 第一个时间戳**严格大于** `lines[i].timeMs` 的行的 `timeMs`（没有就是 `NaN`）。
 *
 * 第十一轮第 1 条（用户 m03279「有和声的地方歌词进度不对」）要用它：和声行常与主唱共享
 * 同一时间戳，这时「紧挨着的下一行」根本不是下一句，拿它算间隔只会得到 0。
 * 单调栈一趟 O(n)，别在每个行里线性往后找（那是 O(n²)）。
 */
function nextGreaterTimes(lines: readonly LyricLine[]): number[] {
  const out: number[] = new Array<number>(lines.length).fill(Number.NaN);
  const stack: number[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const time = lines[index]?.timeMs ?? Number.NaN;
    while (stack.length > 0 && (stack[stack.length - 1] ?? Number.NaN) <= time) stack.pop();
    const top = stack[stack.length - 1];
    out[index] = top === undefined ? Number.NaN : top;
    stack.push(time);
  }
  return out;
}

/**
 * yrc 的**逐字**时间戳 → 字素级 `StageWord`（一个词内部按字素数均分该词的时长）。
 *
 * 这是第十一轮第 1 条的另一半：只要有真时间戳就用真的，别再拿「行时长 ÷ 字素数」去近似。
 */
function timedWords(words: readonly LyricWord[]): StageWord[] {
  const out: StageWord[] = [];
  for (const word of words) {
    const parts = segmentGraphemes(word.text);
    if (parts.length === 0) continue;
    const duration = Math.max(word.durationMs ?? 0, 1);
    const step = duration / parts.length;
    for (let index = 0; index < parts.length; index += 1) {
      const startMs = word.timeMs + step * index;
      // `wordStart` 只在每个**词的首字素**上为 true（见 `StageWord` 的注释）：
      // 云阶靠它把「词」重新断开，否则整行英文会因为缺少空格字素而被收成一个原子。
      out.push({
        text: parts[index] ?? '',
        startMs,
        endMs: startMs + step,
        wordStart: index === 0,
      });
    }
  }
  return out;
}

/**
 * 每行的字素时间轴（一次算完，缓存在 `useMemo` 里）。
 *
 * **数据现实**（第十一轮第 1 条更新）：yrc 其实**带**行时长与逐字时间戳，`parseLrc` 以前把
 * 它们丢了，所以这里只能拿「行时长平均分给每个字素」来推；现在两者都从上游带上来：
 * - 行时长：`line.durationMs`（yrc 行首）优先，其次是「**第一个严格更晚**的时间戳 − 本行起点」，
 *   最后才是 `LAST_LINE_FALLBACK_MS`。取**较大**值 ⇒ 有真时长时它是下限（和声 / 时间重叠时救场），
 *   只有 LRC 时 `durationMs` 缺省、行为与改造前逐字节一致。
 * - 逐字：`line.words` 存在就直接摊平（词内仍按字素均分），否则退回均分的近似。
 * 每个字素的可见时长取 `max(步长, 最短显示时长)`（仅均分路径），短行里相邻字会有短暂重叠
 * （都在「当前」），这比让每个字只亮 20ms 更接近「流光」该有的观感。
 */
export function buildStageLines(lines: readonly LyricLine[]): StageLine[] {
  const nextGreater = nextGreaterTimes(lines);
  return lines.map((line, index) => {
    const nextTime = nextGreater[index];
    const gap = nextTime === undefined || Number.isNaN(nextTime)
      ? LAST_LINE_FALLBACK_MS
      : nextTime - line.timeMs;
    const durationMs = Math.max(line.durationMs ?? 0, gap, 1);
    const hint = hintFor(durationMs);
    const timing = WORD_TIMING[hint];
    const graphemes = segmentGraphemes(line.text);
    // 空行也得有东西占位，否则这一行会「消失」，看起来像舞台坏了。
    const pieces = graphemes.length === 0 ? ['…'] : graphemes;
    const stepMs = durationMs / pieces.length;
    const spanMs = Math.max(stepMs, timing.minDisplayMs);
    const spread: StageWord[] = pieces.map((text, pieceIndex) => {
      const startMs = line.timeMs + pieceIndex * stepMs;
      return { text, startMs, endMs: startMs + spanMs };
    });
    const timed = line.words === undefined ? [] : timedWords(line.words);
    const words = timed.length > 0 ? timed : spread;
    return {
      index,
      timeMs: line.timeMs,
      text: line.text,
      durationMs,
      hint,
      words,
      starts: words.map((word) => word.startMs),
      ends: words.map((word) => word.endMs),
    };
  });
}

/** 升序 `timeMs` 上做 upper bound；不物化时间数组，所以收访问器而不是值数组（省一次分配）。 */
function upperBoundIndex(count: number, timeAt: (index: number) => number, value: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (timeAt(mid) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * 找到当前行：最后一行满足 `timeMs <= positionMs`；还没到第一句时返回 -1。
 *
 * 与旧版线性扫**逐字一致**（同一时间戳的重复行——和声——取最后一条），只是改成二分：
 * 平滑时钟每帧都要问一次「现在是哪一句」，在几百行的歌词上线性扫就是每帧 O(n)。
 * `lines` 由主进程按 `timeMs` 排好序（packages/ncm-client/src/index.ts 的 parseLrc 里
 * `parsed.sort((a, b) => a.timeMs - b.timeMs)`），所以二分成立。
 */
export function findActiveIndex(lines: readonly LyricLine[], positionMs: number): number {
  const timeAt = (index: number): number => lines[index]?.timeMs ?? Number.POSITIVE_INFINITY;
  return upperBoundIndex(lines.length, timeAt, positionMs) - 1;
}

/**
 * 逐字素状态。`ends` / `starts` 都升序，所以两次二分就够：
 * - `passedCount`：终点已经过去的字（唱过了）。
 * - `activeCount`：起点落在「当前位置 + 预读窗口」之前的字（正在唱）。
 */
function wordStatesFor(line: StageLine, positionMs: number): readonly WordState[] {
  const { lookaheadMs } = WORD_TIMING[line.hint];
  const passedCount = upperBound(line.ends, positionMs);
  const activeCount = Math.max(passedCount, upperBound(line.starts, positionMs + lookaheadMs));
  return line.words.map((_word, index) =>
    index < passedCount ? 'passed' : index < activeCount ? 'active' : 'waiting',
  );
}

/**
 * 舞台上该显示哪一行：`viewIndex === null`（跟着播放）时就是当前句（还没唱到第一句就用第 0 行，
 * 开场就有词可看），用户滚过（`viewIndex` 非空）时停在用户滚到的那一行。
 */
function anchorIndexFor(activeIndex: number, viewIndex: number | null, count: number): number {
  if (count === 0) return 0;
  return clamp(viewIndex === null ? (activeIndex >= 0 ? activeIndex : 0) : viewIndex, 0, count - 1);
}

/** 某一时刻的可视状态（平滑时钟每帧的推导结果）。 */
export interface ClassicFrame {
  /** 当前句下标；还没唱到第一句时 -1。 */
  readonly activeIndex: number;
  /** 舞台上正在显示的是哪一句。 */
  readonly anchorIndex: number;
  /** 显示行的逐字素状态；没有行时 `null`。 */
  readonly states: readonly WordState[] | null;
}

/**
 * 「某个播放位置该显示什么」——纯函数，单测直接喂位置断言。
 *
 * 换行的判据**只有** `timeMs` 一条：不许为了「切得柔和一点」给换行加 `lookahead`，
 * 那会让下一句在真正开口之前就提前高亮（单测「下一句开始前的 40ms 内当前句不能提前高亮」钉的就是它）。
 * 预读窗口只作用在**逐字素**上（`wordStatesFor` 的 `active`），与换行无关。
 */
export function classicFrameAt(
  stageLines: readonly StageLine[],
  positionMs: number,
  viewIndex: number | null,
): ClassicFrame {
  const timeAt = (index: number): number => stageLines[index]?.timeMs ?? Number.POSITIVE_INFINITY;
  const activeIndex = upperBoundIndex(stageLines.length, timeAt, positionMs) - 1;
  const anchorIndex = anchorIndexFor(activeIndex, viewIndex, stageLines.length);
  const displayLine = stageLines[anchorIndex];
  return {
    activeIndex,
    anchorIndex,
    states: displayLine === undefined ? null : wordStatesFor(displayLine, positionMs),
  };
}

/**
 * 可视状态签名：当前句 + 显示句 + 每个字素的状态。
 *
 * 平滑时钟每帧都算一帧出来，但**只有签名变了才值得重渲染** —— 这样既拿到了连续时钟，
 * 又守住文件头第 3 条「不是每帧都重渲染」的性能契约（一次换行 / 一个字素换态 = 一次渲染）。
 */
function frameKey(frame: ClassicFrame): string {
  let states = '';
  if (frame.states !== null) {
    for (const state of frame.states) {
      states += state === 'passed' ? 'p' : state === 'active' ? 'a' : 'w';
    }
  }
  return `${frame.activeIndex}|${frame.anchorIndex}|${states}`;
}

interface StageLineViewProps {
  line: StageLine;
  /** enter = 当前显示的那一行；exit = 上一行，正在化掉（一进一出）。 */
  phase: 'enter' | 'exit';
  /** 这一行就是播放到的那一行——只有它能做呼吸浮动。 */
  active: boolean;
  /** 逐字素状态；出场行不逐字渲染，传 `undefined`。 */
  states: readonly WordState[] | undefined;
  onSelect: (() => void) | undefined;
  /** 第十四轮第 4 条（用户 m05281）：流光的「逐字旋转」开关（设置页 lyricTuning.classicWordSpin）。 */
  spin: boolean;
}

/**
 * 逐字旋转的角度表（第十四轮第 4 条；第十五轮第 5 条改了它的**用处**）。
 * **确定性**：第 i 个字在任何时候都是同一个角度，切歌、切句、暂停回来都不会重掷——
 * 不然整行会「哗啦」一下重新排。幅度只有 ±6°，够看出「每个字自己歪着」，又不会把句子拆散。
 *
 * 第十五轮第 5 条（用户 m05281 那条的追评）：「逐字旋转的效果是冒出来的字要带上一定旋转」。
 * 旧写法把角度留在「等唱」上，而未唱字的 `opacity` 恒为 0 —— 角度一次都没被看见。
 * 现在这个值就是**入场角度**：CSS 用 `pi-lyricstage-word-spin-in` 关键帧让字从自己的角度
 * 转到 0°（转正与放大同时发生，`--pi-word-spin-ms`），落地见 lyric-stage.css。
 */
const SPIN_ANGLES = [-6, 4.5, -3.5, 6, -5, 2.5, -4.5, 3.5] as const;

/**
 * 一行。外面是 button（保留 `type="button"` + `aria-label`，键盘可达），
 * 里面套两层 span：`.pi-lyricstage__float` 负责呼吸浮动，`.pi-lyricstage__words` 是
 * `flex-wrap` 的字素行容器。分成两层是因为**进场动画与浮动动画都要写 transform**，
 * 放同一个元素上会互相覆盖。
 */
function StageLineView({ line, phase, active, states, onSelect, spin }: StageLineViewProps): ReactNode {
  const timing = WORD_TIMING[line.hint];
  const exiting = phase === 'exit';
  const style = {
    // 进场时长按这一行的档位与行时长算；出场时长三档写死在 CSS 里。
    '--pi-stage-enter-ms': `${enterMsFor(line.hint, line.durationMs)}ms`,
    '--pi-word-glow-sm': `${timing.glowSmallPx}px`,
    '--pi-word-glow-lg': `${timing.glowLargePx}px`,
  } as CSSProperties;
  return (
    <button
      type="button"
      className="pi-lyricstage__line"
      data-lyric-line
      data-index={line.index}
      data-active={active}
      data-hint={line.hint}
      data-phase={phase}
      style={style}
      // 出场行只是动画残影：别让它进 Tab 序、也别让读屏念两遍。
      tabIndex={exiting ? -1 : 0}
      aria-hidden={exiting ? true : undefined}
      aria-label={
        exiting
          ? undefined
          : // 用户 m00736 第 1 条之后 classic 也不再能点行 seek：没有 `onSelect` 时别念「点击跳到这一句播放」。
            `第 ${line.index + 1} 句歌词：${line.text || '（空行）'}${onSelect === undefined ? '' : '。点击跳到这一句播放'}`
      }
      onClick={onSelect}
    >
      <span className="pi-lyricstage__float">
        <span className="pi-lyricstage__words">
          {states === undefined ? (
            // 出场的上一行整行一起虚化：只有「当前显示行」逐字渲染（folia 也只逐字渲染当前行）。
            <span className="pi-lyricstage__word" data-word-state="passed">
              {line.text || '…'}
            </span>
          ) : (
            line.words.map((word, index) => (
              <span
                key={`${index}-${word.text}`}
                className="pi-lyricstage__word"
                data-word-state={states[index] ?? 'waiting'}
                data-word-spin={spin ? 'true' : undefined}
                // 角度写在元素上（`--pi-word-spin`），CSS 那边把它当作**入场角度**：
                // 字冒出来时从这个角度转到 0°（关键帧 pi-lyricstage-word-spin-in，
                // 落地与时长见 lyric-stage.css 第十五轮第 5 条那段）。
                style={
                  spin
                    ? ({ '--pi-word-spin': `${SPIN_ANGLES[index % SPIN_ANGLES.length]}deg` } as CSSProperties)
                    : undefined
                }
              >
                {word.text}
              </span>
            ))
          )}
        </span>
      </span>
    </button>
  );
}

export function LyricStage({
  lines,
  translated,
  positionMs,
  durationMs,
  theme,
  palette,
  coverUrl,
  onSeek,
}: LyricStageProps): ReactNode {
  /**
   * 主题分发（用户 m08768 第 4 条）。
   *
   * 壳（滚轮换行 / 逐行点击 seek / `data-*` 契约 / `--pi-sweep`）留在**这个组件**里，
   * 主题组件只负责「怎么把这一行画出来」，所以换主题不会动任何契约。
   * 取不到组件（`classic`，或 `fume` / `cadenza` 这类还没实现的 id）就渲染原 classic 分支。
   *
   * 提到最上面算是因为下面的平滑时钟只服务 classic：主题分支各自有 rAF 时钟
   *（lyric-themes/types.ts 的 `usePositionClock`），这里不能抢，否则一套歌词两个时钟。
   */
  const activeTheme: LyricTheme = theme ?? 'classic';
  const Themed = activeTheme === 'classic' ? undefined : LYRIC_THEME_COMPONENTS[activeTheme];
  /** classic 用本组件自己的平滑时钟；主题分支保持原样（`positionMs` 原值转发，行为一字不改）。 */
  const smooth = Themed === undefined;
  /** 第十八轮第 4 条：这套主题允不允许「滚轮滑动查看不同歌词」（见 `WHEEL_BROWSE_THEMES`）。 */
  const wheelBrowsable = WHEEL_BROWSE_THEMES.includes(activeTheme);

  const rootRef = useRef<HTMLDivElement>(null);
  /** 滚轮累计的像素；凑满一格才换一行。 */
  const wheelAcc = useRef(0);
  /** 第十八轮第 4 条：滚轮停手后「自动回到当前歌词」的定时器（`null` = 没在等）。 */
  const wheelIdleTimer = useRef<number | null>(null);
  /**
   * 用户自己滚到了哪一行（`null` = 跟着播放走）。
   *
   * 用户 m08066 第 4 条：滚动歌词**只允许查看，不改变播放状态**（旧版滚一行就 `seek`
   * 到那一句，等于把歌拖走了）。所以这里单独记一个「看哪一行」，与播放位置完全无关：
   * 播放照常推进、当前行照常高亮，只是舞台停在用户滚到的地方。
   */
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  /** 正在演出场动画的上一行（`null` = 没有）。 */
  const [leavingIndex, setLeavingIndex] = useState<number | null>(null);
  /** 上一次的锚点，用来判断「换行了」并让上一行演完出场。 */
  const previousAnchor = useRef<number | null>(null);

  /**
   * classic 的平滑时钟（本轮第 1 条：歌词进度不匹配 / 切句不流畅）。
   *
   * `positionMs` 只由 `<audio>` 的 `timeupdate` 驱动，Chromium 上约 4Hz（250ms 一跳，且不均匀）。
   * 改造前 classic 的当前句与逐字状态都直接拿它比时间戳，于是每个字素平均晚 125ms、最多晚 250ms
   * 才亮，换句也跟着迟半拍。这里按主题层 `usePositionClock` 同一口径补一个时钟：记住 store 值
   * 到货的时刻，用 `performance.now()` 外推，`CLOCK_STALL_MS` 收不到新值就冻住。
   *
   * 与主题层唯一的差别：**推导结果真的变了才 setState**（换句 / 某个字素换态），
   * 所以仍然守住文件头第 3 条「不是每帧都重渲染」的性能契约。
   */
  const [smoothMs, setSmoothMs] = useState(positionMs);
  /** 外推锚点；`null` = 还没同步过（挂载后第一帧会同步成 store 的当前值）。 */
  const anchorRef = useRef<ClockAnchor | null>(null);
  /** 上一帧推导出来的可视签名：只有它变了才值得重渲染。 */
  const frameKeyRef = useRef<string | null>(null);
  // 渲染期就把最新值刷进 ref：rAF 回调里读到的必须是这一帧的 props（与主题层的 positionRef 同一手法）。
  const positionRef = useRef(positionMs);
  positionRef.current = positionMs;
  const viewRef = useRef(viewIndex);
  viewRef.current = viewIndex;

  // 字符切分 + 每字素时间轴：只在 `lines` 变化时算一次（一行几十个字素，但不该每帧重算）。
  const stageLines = useMemo(() => buildStageLines(lines), [lines]);
  /** 主题分支照旧用 store 原值（它们自己有时钟）。 */
  const rawActiveIndex = useMemo(() => findActiveIndex(lines, positionMs), [lines, positionMs]);
  /**
   * 平滑时钟只在「同一份歌词」内有效：`lines` 一换（换歌）就当帧退回 store 原值。
   * 平滑值是个 state，换歌那一帧它还带着旧歌的位置（几十秒），用它推新歌就会错位一帧 ——
   * 正是这次要修的「第一句高亮错位」。随后的 effect 会把时钟复位成新歌的位置。
   */
  const clockLinesRef = useRef(lines);
  const clockFresh = clockLinesRef.current === lines;
  if (!clockFresh) clockLinesRef.current = lines;
  /** classic 用平滑后的位置推；主题分支就是 store 原值，行为一字不改。 */
  const clockMs = smooth && clockFresh ? smoothMs : positionMs;
  const frame = useMemo(
    () => classicFrameAt(stageLines, clockMs, viewIndex),
    [stageLines, clockMs, viewIndex],
  );
  const activeIndex = smooth ? frame.activeIndex : rawActiveIndex;

  // 还没唱到第一句时把第一行当锚，开场就有词可看，而不是一片空白。
  const followIndex = activeIndex >= 0 ? activeIndex : 0;
  const anchorIndex = anchorIndexFor(activeIndex, viewIndex, stageLines.length);

  // 换歌（歌词换了）就把手动查看复位：新歌当然要从当前句开始看。
  // 顺手把「上一行」也清掉：不然新歌下标相同的那一行会以旧歌残影的身份演一次出场。
  useEffect(() => {
    setViewIndex(null);
    setLeavingIndex(null);
    previousAnchor.current = null;
    wheelAcc.current = 0;
    // 第十八轮第 4 条：换歌时那次「自动回到当前歌词」也没意义了，直接收掉。
    if (wheelIdleTimer.current !== null) {
      window.clearTimeout(wheelIdleTimer.current);
      wheelIdleTimer.current = null;
    }
  }, [lines]);

  /**
   * 平滑时钟的驱动：每帧算一次「现在该显示什么」，只有推导结果变了才 `setState`。
   *
   * 依赖放 `stageLines`（而不是 `lines`）是为了「换歌 / 换主题」时重跑一遍，顺手把锚点与
   * 上一帧签名清空 —— 这两个东西跨歌复用会让新歌拿旧歌的进度高亮，那正是这次要修的第一句错位。
   */
  useEffect(() => {
    if (!smooth || stageLines.length === 0) return;
    anchorRef.current = null;
    frameKeyRef.current = null;
    setSmoothMs(positionRef.current);
    let frame = window.requestAnimationFrame(function tick(): void {
      frame = window.requestAnimationFrame(tick);
      const now = performance.now();
      const raw = positionRef.current;
      // store 的 `positionMs` 是锚点：新值一到就硬对齐（暂停、seek、换歌全靠它纠回来）。
      let anchor = anchorRef.current;
      if (anchor === null || anchor.ms !== raw) {
        anchor = resyncClock(raw, now);
        anchorRef.current = anchor;
      }
      const smoothPosition = smoothPositionAt(anchor, now);
      // 回调里取的是「这一帧的 props/render 值」，所以用 ref 而不是 effect 闭包里的旧值。
      const key = frameKey(classicFrameAt(stageLines, smoothPosition, viewRef.current));
      if (key === frameKeyRef.current) return;
      frameKeyRef.current = key;
      setSmoothMs(smoothPosition);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [smooth, stageLines]);

  // 一进一出：锚点变了就让「上一行」再留在 DOM 里演完出场，然后自己消失
  //（folia 的 AnimatePresence 就是这个语义；只渲染当前行的话，出场数值永远用不上）。
  useEffect(() => {
    const previous = previousAnchor.current;
    previousAnchor.current = anchorIndex;
    if (previous === null || previous === anchorIndex || previous >= lines.length) return;
    setLeavingIndex(previous);
    const hint = stageLines[previous]?.hint ?? 'normal';
    const timer = window.setTimeout(
      () => {
        setLeavingIndex((current) => (current === previous ? null : current));
      },
      exitMsFor(hint) + 40,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [anchorIndex, lines.length, stageLines]);

  /**
   * 滚轮换行——**只移舞台锚点，不 seek**（用户 m08066 第 4 条）。
   *
   * 用原生监听是因为 React 把 `wheel` 挂成 passive，`preventDefault` 会失效；
   * 挂载点是根节点（见 lyric-stage.css 里「根节点必须保留 pointer-events: auto」的说明）。
   *
   * 第十八轮第 4 条（用户 m01482）两处改动；m01402 第 7 条把白名单收到只剩时计：
   * ① 这条监听对所有主题都挂（职责是拦掉浏览器默认滚动），但只有 `pendolo`（时计）
   *    会真的换行：其余五套主题滚进来就 `preventDefault` 后原样返回，视图一动不动；
   * ② 每滚一次就重置一个「停手 4s 自动回到当前歌词」的定时器（`wheelIdleTimer`），
   *    因为是**定时器在等**、不是靠 `viewIndex` 变化重置，所以播放继续换行也不会把它冲掉。
   */
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || lines.length === 0) return;
    /** 第十八轮第 4 条：重新计时，停手 `WHEEL_IDLE_RETURN_MS` 之后把舞台交还给播放。 */
    const armIdleReturn = (): void => {
      if (wheelIdleTimer.current !== null) window.clearTimeout(wheelIdleTimer.current);
      wheelIdleTimer.current = window.setTimeout(() => {
        wheelIdleTimer.current = null;
        setViewIndex(null);
      }, WHEEL_IDLE_RETURN_MS);
    };
    const onWheel = (event: WheelEvent): void => {
      // 拦掉默认滚动：滚歌词只该换「看哪一句」，不该把页面/抽屉滚走。
      // 用户 m01402 第 7 条：不吃滚轮的主题（流光等）也必须拦——不拦的话浏览器原生
      // 滚动照样会把轨道挪走（视图行号跟着变），等于「流光还能用滚轮切歌词」。
      event.preventDefault();
      if (!wheelBrowsable) return;
      // deltaMode：0=像素、1=行、2=页。行模式下必须先折算成像素，否则永远凑不满一格。
      const unit =
        event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? root.clientHeight : 1;
      wheelAcc.current += event.deltaY * unit;
      const steps = Math.trunc(wheelAcc.current / WHEEL_STEP_PX);
      if (steps === 0) return;
      wheelAcc.current -= steps * WHEEL_STEP_PX;
      armIdleReturn();
      // 一次滚轮事件**最多 setState 一次**：累积够多格就一次跳到位，别在事件里连点。
      setViewIndex((current) => {
        const from = current ?? followIndex;
        const next = clamp(from + steps, 0, lines.length - 1);
        // 滚回当前行就交还给播放，不用再点一次「回到当前」。
        return next === followIndex ? null : next;
      });
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [followIndex, lines.length, wheelBrowsable]);

  /**
   * 第十八轮第 4 条：主题切到「不吃滚轮」的那四套时，把手动查看连同待回的定时器一起收掉，
   * 否则换主题后舞台会停在用户上次滚到的句子上，而滚轮已经带不回来了。
   */
  useEffect(() => {
    if (wheelBrowsable) return;
    if (wheelIdleTimer.current !== null) {
      window.clearTimeout(wheelIdleTimer.current);
      wheelIdleTimer.current = null;
    }
    setViewIndex(null);
  }, [wheelBrowsable]);

  // 卸载时别把定时器留在后台（它会 setState 到已卸载的组件上）。
  useEffect(
    () => () => {
      if (wheelIdleTimer.current !== null) window.clearTimeout(wheelIdleTimer.current);
    },
    [],
  );

  if (lines.length === 0) return null;

  const displayLine = stageLines[anchorIndex];
  const wordStates = displayLine === undefined ? undefined : wordStatesFor(displayLine, clockMs);
  const leavingLine =
    leavingIndex === null || leavingIndex === anchorIndex ? undefined : stageLines[leavingIndex];

  // 字幕层跟着「看的那一行」走，不是跟着播放走——手动查看时译文也要跟着换。
  const translatedText = displayLine === undefined ? undefined : translated.get(displayLine.timeMs);
  const previewLines: string[] = [];
  for (let step = 1; step <= 2; step += 1) {
    const next = stageLines[anchorIndex + step];
    if (next !== undefined) previewLines.push(next.text || '…');
  }
  const hasSubtitle = (translatedText !== undefined && translatedText !== '') || previewLines.length > 0;

  /**
   * 当前显示这一行的进度（0~1）。classic 靠逐字状态而不是整行扫光高亮，所以它**不参与绘制**，
   * 只写进根节点的 `--pi-sweep`：注册成 `<number>` 后是个可插值的标量，UI 冒烟日志会读它，
   * 以后要加一条整行扫光也不用再动结构。
   */
  const lineProgress =
    displayLine === undefined
      ? 0
      : clamp((clockMs - displayLine.timeMs) / displayLine.durationMs, 0, 1);
  /**
   * 第十四轮第 4 条（用户 m05281）：「流光的歌词动效，在设置页添加逐字旋转的开关」。
   * 只挂在 **classic** 分支上（主题分支自己的 DOM 里也有 `.pi-lyricstage__word`，
   * 但那是别的主题的排版，不该被流光的开关牵连）。开关关着时 `--pi-word-spin` 根本不下发，
   * 逐字 transform 与改造前逐位相同。
   */
  const classicSpin = Themed === undefined && tuningOf(palette ?? DEFAULT_PALETTE).classicWordSpin === true;
  const rootStyle = {
    '--pi-sweep': lineProgress.toFixed(4),    // 主题舞台的整体不透明度（设置页「主题不透明度」）。
    // 只挂在主题分支上：classic 的舞台结构是另一回事，多一个变量就多一处
    // 将来会被误读成「classic 也吃这个设置」的地方。变量落在根节点上、由舞台继承。
    ...(Themed === undefined ? {} : { '--pi-th-theme-opacity': tuningOf(palette ?? DEFAULT_PALETTE).themeOpacity.toFixed(3) }),
  } as CSSProperties;

  return (
    // 除了自己的 `pi-lyricstage`，还挂上 `pi-home__lyrics`：详情页那条「点空白处收起名片操作框」
    // 的判据曾经用它把整片歌词区排除掉（第十二轮起改成只排除**歌词行**本身，见 HomePage.tsx 的注释）。
    <div
      ref={rootRef}
      className={
        Themed === undefined
          ? 'pi-lyricstage pi-lyricrail pi-home__lyrics'
          : `pi-lyricstage pi-lyricrail pi-home__lyrics pi-lyricstage--${activeTheme}`
      }
      data-lyric-rail
      data-theme={activeTheme}
      data-word-spin={classicSpin ? 'true' : undefined}
      data-lines={lines.length}
      data-active-index={activeIndex}
      data-view-index={anchorIndex}
      data-following={viewIndex === null}
      style={rootStyle}
    >
      <div
        className={
          Themed === undefined
            ? 'pi-lyricstage__stage'
            : 'pi-lyricstage__stage pi-lyricstage__stage--themed'
        }
        /**
         * 主题分支的「点行 seek」（用户第八轮第 3 条）走事件委托：
         * 各主题把每一行画在自己的 DOM/canvas 里，但都按契约带上
         * `data-lyric-line` + `data-line-time`（缺 `data-line-time` 时用 `data-index` 回查）。
         * 委托放在这层壳上，主题组件就不用各自实现一遍 seek，也不会碰到 `LyricThemeProps`。
         * classic 分支不挂它：那边的行按钮自己处理（`onSelect`），挂了会让 seek 走两遍。
         *
         * 用户 m00001 第 4 条：「除了时计可以点击歌词改变进度到对应位置，其他歌词动效点击都不允许
         * 有反应」——委托因此收成白名单（`CLICK_SEEK_THEMES`，现在只有时计）。白名单外的主题
         * **整个不挂**，而各主题自己没有任何点击入口（`lyric-themes/*.tsx` 里没有 onClick、
         * 也没有指针监听），所以「不挂」就是「点了彻底没反应」，不需要再靠 preventDefault 兜。
         */
        onClick={
          Themed === undefined || !CLICK_SEEK_THEMES.includes(activeTheme)
            ? undefined
            : (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                const lineEl = target.closest('[data-lyric-line]');
                if (lineEl === null) return;
                const rawTime = lineEl.getAttribute('data-line-time');
                let timeMs = rawTime === null ? Number.NaN : Number(rawTime);
                if (!Number.isFinite(timeMs)) {
                  const index = Number(lineEl.getAttribute('data-index') ?? '-1');
                  const found = stageLines.find((item) => item.index === index);
                  if (found === undefined) return;
                  timeMs = found.timeMs;
                }
                onSeek?.(timeMs);
                setViewIndex(null);
              }
        }
      >
        {Themed === undefined ? (
          <div className="pi-lyricstage__viewport">
            {/* 出场行先渲染（下面），进场的当前行后渲染：grid 叠同一格时后画的在上。 */}
            {leavingLine === undefined ? null : (
              <StageLineView
                key={`out-${leavingLine.index}-${leavingLine.timeMs}`}
                line={leavingLine}
                phase="exit"
                active={false}
                states={undefined}
                onSelect={undefined}
                spin={false}
              />
            )}
            {displayLine === undefined ? null : (
              <StageLineView
                key={`in-${displayLine.index}-${displayLine.timeMs}`}
                line={displayLine}
                phase="enter"
                active={activeIndex === anchorIndex}
                states={wordStates}
                spin={classicSpin}
                /*
                 * 用户 m00736 第 1 条：「classic（流光）主题点歌词不允许跳进度。时计可以用滚轮
                 * 查看不同歌词，并且点歌词跳进度」。这里原本是第八轮第 3 条的「点某一句 = 定位到
                 * 这一句播放」（`onSeek?.(displayLine.timeMs); setViewIndex(null)`），本轮摘掉：
                 * 传 `undefined` 后行按钮的 `onClick`（`StageLineView` 里那行）就是空，点了彻底
                 * 没反应，也不会再把「手动查看」交还给播放。
                 * 用户 m01402 第 7 条又追了一句「流光不要有滚轮可以切换歌词的功能」——classic
                 * 因此也从 `WHEEL_BROWSE_THEMES` 里摘掉了（见上面那个常量），流光今天**点行与
                 * 滚轮都不动进度**，只剩跟着播放走。
                 */
                onSelect={undefined}
              />
            )}
          </div>
        ) : (
          // 主题组件只画「这一行」，滚轮换行 / 逐行点击 seek / data-* 契约都还在这层壳里。
          <Themed
            lines={stageLines}
            translated={translated}
            activeIndex={activeIndex}
            viewIndex={anchorIndex}
            leavingIndex={leavingIndex}
            positionMs={positionMs}
            {...(durationMs === undefined ? {} : { durationMs })}
            theme={palette ?? DEFAULT_PALETTE}
            coverUrl={coverUrl}
          />
        )}
      </div>

      {Themed === undefined && hasSubtitle ? (
        <div className="pi-lyricstage__sub">
          {/* 字幕背后的径向光晕：垫一层页面底色，把下面的封面背景压下去一点，字幕才读得清。 */}
          <div className="pi-lyricstage__sub-glow" aria-hidden="true" />
          {/* key=锚点：换一句就把这层重新挂载，0.24s 的进场（opacity 0→1 / y 20px→0）才会重放。 */}
          <div className="pi-lyricstage__sub-inner" key={anchorIndex}>
            {translatedText === undefined || translatedText === '' ? null : (
              <p className="pi-lyricstage__translated">{translatedText}</p>
            )}
            {previewLines.map((text, index) => (
              <p className="pi-lyricstage__preview" key={`${index}-${text}`}>
                {text}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
