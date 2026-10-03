import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { LyricLine, LyricTheme, LyricWord } from '@pi/shared';
import {
  DEFAULT_PALETTE,
  LYRIC_THEME_COMPONENTS,
  tuningOf,
  type AnimationIntensity,
  type LyricPalette,
} from './lyric-themes';

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
  /**
   * 播放器**此刻是不是在出声**（`store.status === 'playing'`）。不传按「在放」处理。
   *
   * **用户第 5 轮第 2 条**（原话：「我按暂停，歌词依旧会先走几步再猛地回到暂停的进度位置」）：
   * 两条平滑时钟（本组件的 classic 时钟 / 主题层的 `usePositionClock`）都要靠它。
   * 没有它时只能靠「多久没收到新 positionMs」事后推断，暂停后那段窗口里时钟照样往前跑，
   * 判定完再落回锚点值 —— 那几步就是这么来的。
   */
  playing?: boolean;
}

type Hint = 'normal' | 'short' | 'micro';
/** 字素三态：`waiting` 未唱 / `active` 正在唱 / `passed` 唱过。导出是给平滑时钟的单测断言用。 */
export type WordState = 'waiting' | 'active' | 'passed';

/** 行时长 < 0.10s → micro；< 0.18s → short；其余 normal（folia 的 `renderHints`）。 */
const MICRO_MS = 100;
const SHORT_MS = 180;
/** 最后一行没有「下一行」可以减，给个兜底行时长，否则逐字轴会除到 0。 */
const LAST_LINE_FALLBACK_MS = 4000;
/**
 * 用户 m06084 第 3 条「间奏前的歌词进度总是会滞后」的封顶系数。
 *
 * 「下一个**严格更晚**的时间戳 − 本行起点」在**间奏前那一句**上等于整段间奏（常见 10~40s），
 * 于是 `durationMs` 被拉到间奏那么长：只有 LRC 时逐字均分会把这一行的字一个一个亮到间奏结束
 * （肉眼就是「高亮追不上唱」），有 yrc 时 `durationMs` 又会被浮名拿去做块终点
 * （`FumeTheme.tsx` 的 `block.endMs = line.timeMs + line.durationMs`）⇒ 整段间奏里那一句
 * 一直算「正在唱」、不褪色。
 *
 * 封顶值不写死毫秒数（那会把慢歌的正常句子也压短），而是拿**整首歌相邻行间隔的中位数**
 * 当「一句大概唱多久」，再给 `SPREAD_GAP_FACTOR` 倍余量：间奏这种离群值会被削掉，
 * 慢歌的中位数本身就大、不受影响。真时长 `line.durationMs`（yrc）仍是硬下限。
 */
const SPREAD_GAP_FACTOR = 2.5;
/** 封顶值下限：只有两三行的短歌里中位数不可信，给个兜底。 */
const SPREAD_MIN_MS = 1200;
/**
 * 用户 m06084 第 3 条：拿整首歌的「相邻行间隔」**中位数**估一个普通句子有多长，再给
 * `SPREAD_GAP_FACTOR` 倍余量当封顶值。间奏那种离群的大间隔会被削掉，慢歌的中位数本身
 * 就大、不受影响；最后一行（没有下一行）不进统计，它走 `LAST_LINE_FALLBACK_MS`。
 */
function gapCapMs(
  lines: readonly LyricLine[],
  nextGreater: readonly (number | undefined)[],
): number {
  const gaps: number[] = [];
  lines.forEach((line, index) => {
    const next = nextGreater[index];
    if (next === undefined || Number.isNaN(next)) return;
    const gap = next - line.timeMs;
    if (gap > 0) gaps.push(gap);
  });
  if (gaps.length === 0) return LAST_LINE_FALLBACK_MS;
  gaps.sort((left, right) => left - right);
  // 取**下中位数**（元素少时更保守）：两行歌词时不会让「唯一的那个大间隔」自己当基准。
  const median = gaps[Math.floor((gaps.length - 1) / 2)] ?? LAST_LINE_FALLBACK_MS;
  return Math.max(SPREAD_MIN_MS, median * SPREAD_GAP_FACTOR);
}
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
  /** 逐字辉光的两层半径（text-shadow 外层双层，颜色用高亮色的 60% / 32%，见 lyric-stage.css）。 */
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
  /** 舞台**原子**（冒出 / 亮起 / 错落的最小单位），见 `StageAtom`。 */
  readonly atoms: readonly StageAtom[];
  /** 原子的升序起点 / 终点（与 `atoms` 同序，含词间空白占位原子）：逐原子二分开状态用。 */
  readonly atomStarts: readonly number[];
  readonly atomEnds: readonly number[];
}

/**
 * 舞台的**原子**：冒出、亮起、错落的最小单位（第十六轮第 1 / 3 / 4 条）。
 *
 * - 中文（CJK / 假名 / 谚文）一个字素一个原子 —— 仍然是「逐字」冒出；
 * - 西文一个**词**才是一个原子（`hello` / `don't` / `well-known` / `hello,world` 各算一个）——
 *   用户原话「对英语单词不是一个字母一个字母往外冒，而是整个单词往外冒」。
 * - `spacer` 是词间空白自己那个原子：它不挂 `data-word-state`（不参与逐字状态、不算「字」），
 *   只负责把真实的词间空隙撑出来。
 *
 * === 用户本轮第 2 条：整套入场动效照 folia classic 的三态模型重做 ===
 *
 * 下面这些量一一对应 folia `classic/Visualizer.tsx` 里的 `WordLayoutConfig`（值由
 * `classicMotionFor` 在本仓重算，**没有拷贝源码文本**）：
 *   · `x` / `y`：落点相对**排版位置**的偏移（px）；
 *   · `rot`：落点的停留角（度）；
 *   · `passedRot`：唱完之后的**漂移角**（度；folia 用 5s 线性把它转过去）；
 *   · `scale`：落点的**常态**缩放（folia 常速档 `1.1 + rand × 0.2`）；
 *   · `waitX` / `waitY` / `waitRot`：未唱那一格的位置与角度 —— folia 用 sin/cos 把字甩到
 *     离落点最多 ±100px / ±50px、再歪 20° 的地方，唱到它时由**弹簧**弹回落点。
 *
 * 全部**只由行时间戳 + 原子下标决定**，与播放位置无关：同一行每次渲染逐位相同，
 * 不会每帧重排，也不会因为换行回来而重掷。
 */
interface StageAtom {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly passedRot: number;
  readonly scale: number;
  readonly waitX: number;
  readonly waitY: number;
  readonly waitRot: number;
  /** 词间空白的宽度（em），只有 `spacer` 有值：图 2 里字距本来就不匀。 */
  readonly gap: number;
  /** 词间空白占位原子。 */
  readonly spacer: boolean;
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
 * `playing === false`（**用户第 5 轮第 2 条**）时**立即**返回锚点值，不做任何外推。
 *
 * 纯函数（`nowMs` 由调用方给），所以「两次 timeupdate 之间位置是否连续推进」「暂停后是否冻住」
 * 都能直接单测，不用碰 rAF 与 `<audio>`。
 */
export function smoothPositionAt(anchor: ClockAnchor, nowMs: number, playing = true): number {
  // **用户第 5 轮第 2 条**：播放器一说停就立刻冻住，不等 `CLOCK_STALL_MS` 那套事后推断 ——
  // 暂停后还能外推的那几步，就是用户看到的「先走几步再猛地回到原位」。
  if (!playing) return anchor.ms;
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

/*
 * ===========================================================================
 * 第十六轮第 1 / 3 / 4 条（用户本轮原话）：「流光歌词动效，对英语单词不是一个字母一个字母往外冒，
 * 而是整个单词往外冒。歌词高光以及辉光要如图 1 所示的效果，并且一行歌词不是整齐的一行而是如图 2
 * 所示。歌词冒出来是带旋转的。」
 *
 * 这一段只干两件纯函数的事：把字素**收成原子**（整词 / 单字），给每个原子发一组**确定性错落**
 * （图 2 的一行不整齐）。视觉全部落在 lyric-stage.css 的 `--pi-word-x / --pi-word-y /
 * --pi-word-rot / --pi-word-scale` 这几个变量上（**用户本轮第 2 条**改成 folia 的三态模型）。
 * ===========================================================================
 */

/** CJK / 假名 / 谚文 / 全角标点：这些文字没有词间空格，一个字素就是一个原子。 */
const CJK_ATOM =
  /[\u2e80-\u303f\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/;

/** 空白字素（半角 / 全角空格、制表）：词与词之间的那一格。 */
function isBlankGrapheme(text: string): boolean {
  return text.trim() === '';
}

/**
 * **音节连接符**（用户第二十三轮第 3 条，图 2 / 图 4）。
 *
 * 原话：「对于图 2 这样有连接符号的，可以智能拆开来符合演唱发音情况，比如图 4」。
 * 图 2 是一句 `Oh-ah-oh`，图 4 是同一句**拆成三段**（`Oh-` / `ah-` / `oh`，中间留出空隙）的样子。
 *
 * 为什么该拆：歌词里的连字符**不是词内连写**（`well-known` 那种），而是「一个音拖了几个音节」
 * 的记法 —— 唱的时候 `Oh` / `ah` / `oh` 各占一拍，逐字高光也该一段一段走，而不是整串一起亮。
 * 拆的时候连字符**跟着前一段**走（`Oh-` / `ah-` / `oh`，与图 4 逐字一致）。
 *
 * 只认这几种：ASCII 连字符、波浪号、短破折号、长破折号、U+2010 连字符、U+2212 减号。
 * 故意**不**碰日文长音符 `ー`（那是假名本身，不是分隔符）。
 */
const SYLLABLE_JOIN = /^[-~–—‐−]$/;

/**
 * 确定性伪随机 ∈ [0, 1)：与 folia 的 `random(offset)` 同一套写法
 *（`frac(sin(seed + offset) × 10000)`），**没有拷贝源码文本**，只是同一个数学式子。
 *
 * 用它而不是 `Math.random()`：同一行每次渲染的错落必须逐位一致 —— 随机数会让整行每帧重排
 *（React 每帧都在算这一帧的状态，抖动会肉眼可见），也会让「同一句唱第二遍」长得不一样。
 */
function classicNoise(seed: number, offset: number): number {
  const value = Math.sin(seed + offset) * 10000;
  return value - Math.floor(value);
}

/**
 * 词间空白宽度（em）：下界不是随便挑的。
 *
 * 冒烟探针（第十六轮新增的「流光整词与高光辉光」）按「同一个父容器里，前一个以拉丁字母结尾、
 * 后一个以拉丁字母开头的两个字素，横向间隙落在 (−3px, 4px)」判一次「英文被拆开」，判据要求 0 次。
 * classic 的最小字号是 2.25rem = 36px（lyric-stage.css 的字号标定），0.38em = 13.7px；
 * 扣掉两侧旋转把包围盒撑开的量（最坏约 5px/侧，长词更大），仍有 8px 以上余量。
 */
const SPACE_MIN_EM = 0.38;
const SPACE_SPAN_EM = 0.16;
/**
 * **中文（CJK）相邻两字之间的最小间隙（em）** —— **用户（本轮）第 1 条**。
 *
 * 原话：「图 1 是一句歌词字与字间的正常间隙……明显太挤了」＋「这种比较短的歌词，
 * 可以把字拉开来留出空隙」。中文歌词里字与字之间**没有任何空白字素**，`buildStageAtoms`
 * 又恰好一个字素一个原子，于是两个字紧贴在一起，只剩字形自身的 side bearing（≈0.1em）。
 *
 * folia 的 `marginRight` 是 `(两词放大溢出 + 落点位移差 + gap) × spacingMultiplier`，
 * `spacingMultiplier` 就是设置里的 `wordSpacing`（默认 0.7）。上一版只按它的**下限**
 * `minMargin = 0.12 × 字号 × 0.7 ≈ 0.084em` 取，取小了 —— 用户在短句对照图里要的是
 * 「字被拉开」那种感觉（相邻两字的净空隙接近半个字宽）。这一版取 **0.3em**，加上字形自身的
 * side bearing，视觉空隙 ≈ 0.4em，与那张图同量级。
 */
const CJK_GAP_EM = 0.3;
/**
 * === **用户第 9 轮第 2 条**：短句的字距按余量摊开 ===
 *
 * 原话：「图 2 是对于流光，比较短的歌词，字与字应该有足够大的空隙，像图 3 一样。具体空隙多大智能决定」。
 *
 * 量测（主人给的对照图，1567×1016，五个字的短句）：逐像素扫墨迹列得到五段墨迹宽 102~113px、
 * 相邻段的**心距 271~300px**；同图这条线的字高 ≈156px（与本仓 classic 的 6cqi 同档）⇒
 * **字距 ≈ 1.9em**、整行铺满窗宽的 **88%**。我们那一张（图 2，1479×965）量到心距 112~126px、
 * 墨迹宽 101~109px ⇒ 字距只有 **~0.3em**（就是 `CJK_GAP_EM`）、整行只占窗宽的 43%。
 *
 * 口径：**按这一行实际剩多少余量来分**，而不是给短句写死一个大数 ——
 *   `字距 = clamp((框宽 × 0.8 − 这行的墨迹总宽) / 间隙数, 0.3em, 1.8em)`
 * 长句（墨迹已经接近框宽）⇒ 余量为负 ⇒ 夹回 0.3em，与改造前**逐位相同**（不会因为这一改而换行）；
 * 短句（3~6 个字）⇒ 余量摊到每个间隙上，字被拉开、整行落在框宽的 80% 附近（对照图是 88%）。
 * 上限 1.8em 是防止「两三个字的句子被拉成一根面条」。
 */
const CLASSIC_JUSTIFY_TARGET = 0.8;
const CLASSIC_JUSTIFY_MAX_GAP_EM = 1.8;

/**
 * **放大溢出占位要在显示前一次算好**（用户第二十四轮第 2 条：「流光现在的歌词会颤动……
 * 我觉得每首歌的歌词在显示前都应该智能安排好每个字的位置，实际播放时就是直接加载」）。
 *
 * 上一版（第二十三轮）是**只给正在唱的那个字**写占位、唱到下一个字再交接 —— 于是每一句里
 * 每换一个字，整行的排版就要重排一次，读起来就是「字在颤动」。这一版改成：
 * **每个字都按「它自己最放大时」的样子，在换行那一刻一次性留好**（写在 `--pi-word-pad` 上），
 * 播放期间**一个像素都不再动**（剩下的只有 transform：入场、错落、放大，那些不参与排版）。
 *
 * 于是每一行的版式 = 纯函数结果（原子 + 落点缩放 + 量到的字宽）× 一次测量，
 * 「显示前安排好、播放时直接加载」这件事就成立了。
 *
 * 只给**非 CJK** 原子留：中文相邻两字本来就有 `--pi-line-gap`（0.3~1.8em 由余量摊开，
 * 用户第 9 轮第 2 条那套口径与判据），再叠一份 0.4em 的占位会把长句的净空隙顶过 0.45em
 * ——那是用户明确要过的「长句不许被撑开」。西文词之间没有那套间隙，占位正好补上。
 */
export function classicActiveOverflowPadPx(
  widthPx: number,
  scale: number,
  activeScale: number,
): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 0;
  const k = scale * activeScale;
  if (!Number.isFinite(k) || k <= 1) return 0;
  return ((k - 1) * widthPx) / 2;
}

/**
 * 短句字距（px）。纯函数，`lyric-stage.test.ts` 直接钉。
 *
 * 入参都是**当帧量出来的事实**：`visualWidth` = 行内每个原子的 `offsetWidth × 落点缩放` 之和
 * （即带上三态缩放之后的**墨迹**总宽，词间空格原子也算在内 —— 它是真实排版宽度，不是可摊开的余量）、
 * `frameWidth` = 歌词框宽、`gapCount` = 这一行有几个可摊开的中文间隙、`fontPx` = 这一行的字号。
 *
 * 单调性与上下限（测试逐条钉）：字距随余量单调不减；永远不会小于 `0.3em`（长句行为不变）、
 * 也不会大于 `1.8em`；非有限输入一律退回下界（绝不返回 NaN —— 它会被拼进 `--pi-line-gap`，
 * NaN 会让整条 `margin-right` 失效）。
 */
export function classicJustifyGapPx(
  visualWidth: number,
  frameWidth: number,
  gapCount: number,
  fontPx: number,
): number {
  const floorPx = Number.isFinite(fontPx) && fontPx > 0 ? CJK_GAP_EM * fontPx : 0;
  const ceilingPx = Number.isFinite(fontPx) && fontPx > 0 ? CLASSIC_JUSTIFY_MAX_GAP_EM * fontPx : 0;
  if (
    !Number.isFinite(visualWidth) ||
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(gapCount) ||
    gapCount < 1 ||
    !(frameWidth > 0) ||
    !(ceilingPx > 0)
  ) {
    return floorPx;
  }
  const slack = (frameWidth * CLASSIC_JUSTIFY_TARGET - visualWidth) / gapCount;
  return clamp(slack, floorPx, ceilingPx);
}
/* ---------------------------------------------------------------------------
 * **用户本轮第 2 条**：流光的入场动效照 folia classic 的三态模型**重做**
 *（原话：「流光的歌词出现的动画重新做，首先分析视频里的动画，再结合学习 folia 库
 * https://github.com/chthollyphile/folia-major 的动画实现，要达到一样的视效」）。
 *
 * 参考视频（`1790852014797.mp4`，1432×542、21.5fps、27.3s）逐帧量测得到的观感，与 folia
 * `src/components/visualizer/classic/Visualizer.tsx` 的 `layoutVariants` / `bodyVariants`
 * **逐条对得上**（数值全部在本仓自己写；AGPL 只借数值与结构，不抄源码文本）：
 *
 *   1. **未唱**（`waiting`）：字在离落点很远的偏处（横向最多 ±100px、纵向最多 ±50px）、
 *      缩到 0.5 倍、模糊 10px、再额外歪 20°，完全透明；
 *   2. **正在唱**（`active`）：**弹簧**弹回落点、放大到「落点缩放 × 1.4」、去模糊、换高亮色 ——
 *      并且**在这一整个窗口里保持那么大**（视频里正在唱的那个词一眼就比唱过的大一档）；
 *   3. **唱过**（`passed`）：大小回落到**落点缩放**（≈1.1~1.3，不再挂着 1.4），透出 0.82 的余温，
 *      并在一段**很长**的时间里（5s、线性）慢慢歪向自己的漂移角 —— 视频里唱过几秒的词越歪越多。
 *
 * **用户本轮第 2 条（第二遍）**：档位从 `chaotic` 收到 `moderate`（见 `classicIntensityOf`）。
 * 逐字对称量过用户给的「正确表现」图：那张图里**整行墨迹高 ÷ 单字高 = 1.83**（十个字基本贴在
 * 一条基线上，只有小错落小倾角）；我们之前那版 chaotic 实测 **3.4**，字被 ±60px 的落点错落
 * 与 ±30° 的落点角撒成一片 —— 这就是「歌词稀碎没排成一个句子 + 倾斜得离谱」的来源。
 * folia 的 moderate 档正是 `baseSpread = 20` / `baseRotate = 5`（chaotic 的一半以下），
 * 换算到我们的字号（94.6px）就是 ±20px ≈ 0.21 字高、±5°，与那张图逐项对上。
 * ------------------------------------------------------------------------- */

/**
 * 流光实际使用的动效档位。
 *
 * `palette.animationIntensity` 由 `HomePage` 固定成 `chaotic`（那是第十八轮为**六套主题共用的
 * 配色契约**定的，改动它会波及其它五套已验收的主题），而 folia 的各档幅度差别是**数量级**的：
 * chaotic 的 `baseSpread = 60` / `baseRotate = 30` 会把一行撒成一片。用户本轮给的目标图对应的是
 * moderate，所以**只给 classic 降一档**，其余主题仍然吃 palette 的原值。
 *
 * 降档只影响 `CLASSIC_SPREAD_PX` / `CLASSIC_ROT_DEG` / 缩放基准 / 漂移角这四处幅度；
 * 三态的结构、时长、弹簧、`sin/cos` 甩出方向全部不变（那些与档位无关）。
 */
export function classicIntensityOf(intensity: AnimationIntensity): AnimationIntensity {
  return intensity === 'chaotic' ? 'moderate' : intensity;
}

/** 未唱那一格的最大横向 / 纵向甩出量（px）—— folia 的 `sin(cfg.y) × 100` / `cos(cfg.x) × 50`。 */
const CLASSIC_WAIT_SPREAD_X = 100;
const CLASSIC_WAIT_SPREAD_Y = 50;
/** 未唱那一格额外歪的角度（度）—— folia 的 `config.rotate + 20`。 */
const CLASSIC_WAIT_ROT_DEG = 20;
/** 落点错落的摆幅（px）与倾角（度）：folia 的 `baseSpread` / `baseRotate`（calm 档是 0）。 */
const CLASSIC_SPREAD_PX = { calm: 0, moderate: 20, chaotic: 60 } as const;
const CLASSIC_ROT_DEG = { calm: 0, moderate: 5, chaotic: 30 } as const;
/**
 * 唱完之后的漂移角总幅度（度）—— folia 原式是 `(rand − 0.5) × 45` ⇒ ±22.5°（**不分档**）。
 *
 * **用户本轮第 2 条（第二遍）**：那一档在 moderate 下太大 —— 唱过的字会歪到 22°，而目标图里
 * 唱过的字只有几度。漂移角与落点角是同一件事的两半（都往「这个字自己的角度」上走），所以
 * 这里跟着 `CLASSIC_ROT_DEG` 一起分档：chaotic 仍是 folia 原值 45，moderate 取 15（±7.5°），
 * calm 不歪。
 */
const CLASSIC_PASSED_ROT_SPAN_DEG = { calm: 0, moderate: 15, chaotic: 45 } as const;
/** 落点缩放（folia：常速 `1.1 + rand × 0.2`，狂暴 `0.8 + rand × 0.6`）。 */
const CLASSIC_SCALE_BASE = 1.1;
const CLASSIC_SCALE_SPAN = 0.2;
const CLASSIC_SCALE_BASE_CHAOTIC = 0.8;
const CLASSIC_SCALE_SPAN_CHAOTIC = 0.6;
/**
 * **正在唱**时在落点缩放之上再乘的倍数 —— folia 的 `config.scale × 1.4`。
 *
 * 这一档是「正在唱」与「唱过」在**大小**上的唯一差别（用户本轮第 1 条给云阶要的也是同一件事：
 * 单个字唱完就恢复大小）。导出只为单测。
 */
export const CLASSIC_ACTIVE_SCALE = 1.4;

/** 错落值取到 4 位小数：写进 style 的字符串必须逐位稳定，否则每次渲染都是新的内联样式。 */
function round4(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  // `-0` 归一成 `0`：角度 / 偏移为 0 时可能是 `-0`（`Object.is(-0, 0) === false`），
  // 单测与内联样式字符串都没必要陪着它别扭。
  return rounded === 0 ? 0 : rounded;
}

/**
 * 一个原子的三态动效参数 —— folia `WordLayoutConfig` 的对应物（本仓自己命名）。
 * `x` / `y` = 落点偏移（px），`rot` = 落点角，`passedRot` = 唱完的漂移角，`scale` = 落点缩放，
 * `waitX` / `waitY` / `waitRot` = 未唱那一格的位置与角度。导出只为单测。
 */
export interface ClassicMotion {
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly passedRot: number;
  readonly scale: number;
  readonly waitX: number;
  readonly waitY: number;
  readonly waitRot: number;
}

/**
 * 第 `atomIndex` 个原子的三态动效参数。纯函数、确定性（只吃行起点与下标，与播放位置无关）。
 *
 * `spin` = 设置页那枚「流光 · 逐字旋转」开关，对应 folia 的 `enableWordRotation`：
 * 关着时 `rot` / `passedRot` / `waitRot` 全是 0（一个字都不歪），位移与缩放照旧。
 */
export function classicMotionFor(
  lineTimeMs: number,
  atomIndex: number,
  intensity: AnimationIntensity,
  spin: boolean,
): ClassicMotion {
  // 种子 = 「行起点（秒）+ 原子下标」，与 folia 的 `activeLine.startTime + i` 同一个量级。
  const seed = lineTimeMs / 1000 + atomIndex;
  const random = (offset: number): number => classicNoise(seed, offset);
  const spread = CLASSIC_SPREAD_PX[intensity];
  const rotateSpan = CLASSIC_ROT_DEG[intensity];
  const scale =
    intensity === 'chaotic'
      ? CLASSIC_SCALE_BASE_CHAOTIC + random(4) * CLASSIC_SCALE_SPAN_CHAOTIC
      : CLASSIC_SCALE_BASE + random(4) * CLASSIC_SCALE_SPAN;
  const x = (random(1) - 0.5) * spread * 2;
  const y = (random(2) - 0.5) * spread * 2;
  const rot = spin ? (random(3) - 0.5) * rotateSpan * 2 : 0;
  const passedRot = spin ? (random(8) - 0.5) * CLASSIC_PASSED_ROT_SPAN_DEG[intensity] : 0;
  return {
    x: round4(x),
    y: round4(y),
    rot: round4(rot),
    passedRot: round4(passedRot),
    scale: round4(scale),
    // folia 的 `waiting` 目标值：`x + sin(y) × 100` / `y + cos(x) × 50`。落点偏移只有几十像素，
    // `sin/cos` 在这个区间近似线性 ⇒「甩出去的方向主要由落点偏移的符号决定」这一条相关性是
    // 参考实现自带的，照搬即可（不需要额外造方向）。
    waitX: round4(x + Math.sin(y) * CLASSIC_WAIT_SPREAD_X),
    waitY: round4(y + Math.cos(x) * CLASSIC_WAIT_SPREAD_Y),
    waitRot: round4(spin ? rot + CLASSIC_WAIT_ROT_DEG : 0),
  };
}

/* ---------------------------------------------------------------------------
 * 「远处」到底在哪 —— 用户 m00001 第 5 条本轮收口
 *
 * 原话：「从远处从小变大加自旋，并且这个远处就是歌词字体的边框位置，现在的飞行距离太远了」。
 *
 * `classicMotionFor` 给的 `waitX/waitY` 是**意图**（相对落点的位移，px）
 * 它按「整个窗口」算得挺好，可是歌词字块在整窗舞台上只占中间一条：字按意图起手时已经跑到
 * 框外好几百像素，那一段根本看不见，用户只看到「原地从小变大 + 自转」。
 *
 * 现在的口径：**每个字的起点被夹在歌词框（frame）内缘上**。
 * 方向一个字不改（还是 `classicMotionFor` 的确定性方向：该往上飞还往上飞、该往左偏还往左偏），
 * 只把**距离**取「意图距离」与「沿这个方向到框内缘的余量」的较小值。
 *
 * 分成三层，各管一件事，都不含 DOM：
 *   1. `clampFlyToFrame` —— 一维的「夹」（纯函数，单测直接钉）；
 *   2. `frameRunwayPx` —— 二维的「沿这个方向到框边还有多远」（纯函数，单测直接钉）；
 *   3. `clampWaitingFlyToFrame` —— 唯一碰 DOM 的一层：量框、量字、把结果写回 `--pi-word-wait-x/y`。
 * ------------------------------------------------------------------------- */

/**
 * 一个矩形，**像素**、**同一个坐标系**（`layoutBoxIn` 保证；测试里手写也按这个约定）。
 * 用 `readonly` 是因为它只该被读：量出来的框是当帧的事实，改它等于骗自己。
 */
export interface FlyFrameBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * 把「原计划飞多远」（`intendedPx`，带符号）夹到「沿这个方向还有多少余量」（`availablePx`，不带符号）。
 *
 * 三条约定（`lyric-stage.test.ts` 逐条钉）：
 * 1. `availablePx` 比意图**还大** ⇒ 原样返回意图。夹取的存在意义是「别飞出框」，**不是**「凑到框边」；
 *    把字从 1.9em 反向拉到 6em 去贴框边，等于把用户嫌远的毛病对折着再犯一遍。
 * 2. `availablePx` **更小** ⇒ 夹到 ±`availablePx`，**符号不变** ⇒ 方向（上/下、左/右）一个不改，
 *    只是飞得短。方向是 `classicMotionFor` 的确定性约定，不能被夹取改写。
 * 3. 非有限值 / `availablePx <= 0`（字已经贴在框上、框塌成 0 高、算出来的字号是 NaN…）⇒ 返回 **0**，
 *    也就是「原地起手」。**必须返回 0 而不是 NaN**：这个值会被拼进 `--pi-word-wait-x/y`，
 *    一个 NaN 会让整支自定义属性失效、`transform` 整条作废 —— 字会瞬间跳到落点，
 *    那正是这一轮要避免的硬跳（比飞得近难看得多）。
 */
export function clampFlyToFrame(intendedPx: number, availablePx: number): number {
  if (!Number.isFinite(intendedPx)) return 0;
  if (!Number.isFinite(availablePx) || availablePx <= 0) return 0;
  const magnitude = Math.min(Math.abs(intendedPx), availablePx);
  return intendedPx < 0 ? -magnitude : magnitude;
}

/**
 * 从 `(centerX, centerY)` 沿 `(dirX, dirY)`（不必是单位向量）走到 `frame` **内缘**的距离（px）。
 *
 * 就是一支射线与矩形四边的最近交点：x / y 两个方向各求「打到哪条边」，取较小者。
 * 那一点正好落在框边上，于是「起点贴在框内缘、整段飞行都在框里可见」。
 * `dirX === 0` 那一侧打不到边界（`Infinity`，不影响取 min）；方向全零 ⇒ 没有航程，返回 0。
 * 任何非有限输入一律 0：宁可原地起手，也不给 CSS 留一个 NaN。
 */
export function frameRunwayPx(
  centerX: number,
  centerY: number,
  dirX: number,
  dirY: number,
  frame: FlyFrameBox,
): number {
  const finite = [centerX, centerY, dirX, dirY, frame.left, frame.top, frame.right, frame.bottom];
  if (!finite.every((value) => Number.isFinite(value))) return 0;
  const length = Math.hypot(dirX, dirY);
  if (!(length > 0)) return 0;
  const unitX = dirX / length;
  const unitY = dirY / length;
  const toX =
    unitX > 0
      ? (frame.right - centerX) / unitX
      : unitX < 0
        ? (frame.left - centerX) / unitX
        : Number.POSITIVE_INFINITY;
  const toY =
    unitY > 0
      ? (frame.bottom - centerY) / unitY
      : unitY < 0
        ? (frame.top - centerY) / unitY
        : Number.POSITIVE_INFINITY;
  const runway = Math.min(toX, toY);
  return Number.isFinite(runway) ? Math.max(0, runway) : 0;
}

/**
 * `el` 在 `ancestor` 坐标系里的**布局**矩形；沿 `offsetParent` 链走不到 `ancestor` 就返回 `null`。
 *
 * 为什么手写 `offsetLeft/offsetTop` 链而**不用** `getBoundingClientRect()`：
 * 要量的正是「飞在天上」的那些字，它们的 rect 里**含着自己的 transform**
 * （`translate3d(x + from-x, y + from-y, 0) rotate(...) scale(...)`）。拿 rect 去量余量，
 * 量到的就是「已经夹过之后的起点」，每重排一次就再缩一截 —— 自我反馈，几轮下来字会贴死在框边
 * 并且每帧抖动。`offsetLeft/offsetTop` 读的是**同一份布局几何、不受 transform 影响**，
 * 所以「写 `--pi-word-wait-x/y`」不会改变「下一次量出来的框」⇒ 幂等，重排多少次结果都一样。
 *
 * 代价：只在 `offsetParent` 链上有效。字 → … → `.pi-lyricstage__viewport` 这条链中间，
 * 只要有一个祖先不是「最近的定位祖先」就走不到（那时返回 `null`，这一轮不夹 ——
 * 宁可不夹也别夹错），所以调用方用 `sharedOffsetParent` 先求出**公共**坐标原点，见下。
 */
function layoutBoxIn(el: HTMLElement, ancestor: HTMLElement): FlyFrameBox | null {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = el;
  while (node !== null && node !== ancestor) {
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== ancestor) return null;
  return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
}

/**
 * `a` 与 `b` 在 `offsetParent` 链上的**最近公共祖先** —— 也就是两者唯一共用的那个坐标系原点。
 *
 * 为什么需要它：`.pi-lyricstage__viewport` 自己是 `position: static`（lyric-stage.css:200-206），
 * **不是** offsetParent，所以「以框为原点量字」写不出来。退一步用两者共享的那个定位祖先：
 * 两条链各自累加到它、相减即是「字相对框」的布局矩形，与「框是不是 offsetParent」无关。
 * 两条链在同一个文档里必然在 `body` 相交，所以实践中不会返回 `null`（固定定位 / `display:none`
 * 的退化情形才可能），返回 `null` 时调用方不夹。
 */
function sharedOffsetParent(a: HTMLElement, b: HTMLElement): HTMLElement | null {
  const seen = new Set<HTMLElement>();
  for (
    let node: HTMLElement | null = a;
    node !== null;
    node = node.offsetParent as HTMLElement | null
  ) {
    seen.add(node);
  }
  for (
    let node: HTMLElement | null = b;
    node !== null;
    node = node.offsetParent as HTMLElement | null
  ) {
    if (seen.has(node)) return node;
  }
  return null;
}

/**
 * 只处理**一行的整行缩放适配**这件事 —— **用户（本轮）第 1 条之后已废弃**。
 *
 * 上一轮为了「一句一行」把行容器改成 `nowrap`，并在这里把整行缩到刚好放下。用户给的对照图
 * （folia）恰恰是**换行**排两行的，且指出长句挤成一行时字距被压没了 ⇒ 口径退回 folia 的
 * `flex-wrap: wrap`，这一层不再参与渲染。这里只留这段说明，避免下一个人再走一遍。
 */

/**
 * 布局阶段的一趟：给每一行摊**中文间隙**、给放大中的字留**溢出占位**。
 *
 * 两件事都放在这里、走同一个 `querySelectorAll` 遍历（用户第二十三轮第 3 条把第二件加进来）：
 *
 * ① **中文间隙**（**用户第 9 轮第 2 条**，见 `CLASSIC_JUSTIFY_TARGET`）：短句按余量把字拉开，
 *    写在 `--pi-line-gap`（只影响 margin-right）。只有「有 2 条以上 cjk 间隙」的行才需要。
 *
 * ② **放大溢出占位**（**用户第二十三轮第 3 条**，见 `classicActiveOverflowPadPx`）：
 *    正在唱的那个字放大 1.4 倍是**视觉**的，邻居不会自己让位 ⇒ 写 `--pi-word-pad` 给它在
 *    排版上左右各留出溢出的那一半，字与字之间的空隙就均匀了（图 3 的「挤在一起」消失）。
 *    这一件**每一行都要做**（图 3 是一行英文），所以它不能跟 ① 的 `continue` 绑在一起。
 *
 * 为什么放在布局阶段（与 `clampWaitingFlyToFrame` 同一个 `useLayoutEffect`）：这两件都是
 * **排版量**，必须在本帧画出来之前定好 —— 放到 `useEffect` 里会先画出「挤在一起」的那一帧再跳开。
 *
 * 为什么逐行（不是只处理当前行）：换行那一刻视图里同时挂着**新行**与**化掉中的旧行**
 * （同一个 grid 格里两层），两行都要按同一个口径摊开，接缝处才不会一行紧一行松。
 *
 * 幂等性：量的是 `offsetWidth`（**不含 margin**、不含 transform），写入的是 `--pi-line-gap` /
 * `--pi-word-pad`（都只改 margin）⇒ 写多少次量出来的数都一样，不会被自己影响。
 * 只在数值真的变了才写 DOM（与 `clampWaitingFlyToFrame` 同一个纪律）。
 */
function layOutClassicLines(frame: HTMLElement): void {
  for (const line of frame.querySelectorAll<HTMLElement>('.pi-lyricstage__line')) {
    const words = line.querySelectorAll<HTMLElement>('.pi-lyricstage__word');
    const activeScale =
      Number.parseFloat(getComputedStyle(line).getPropertyValue('--pi-word-active-scale')) ||
      CLASSIC_ACTIVE_SCALE;
    let visualWidth = 0;
    for (const word of words) {
      // 三态缩放是**视觉**的：字放大 1.1~1.4 倍之后墨迹比布局盒宽，摊余量时必须算进去。
      const scale = Number.parseFloat(word.style.getPropertyValue('--pi-word-scale'));
      const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
      /*
       * ② 放大溢出占位（用户第二十三轮第 3 条 → 第二十四轮第 2 条改成静态）：
       * **每个字一次算好、播放期间不再变**（见 `classicActiveOverflowPadPx` 的注释）。
       * 中文原子跳过（它们有自己的 `--pi-line-gap` 口径，叠上会顶破长句上限）。
       */
      const pad =
        word.dataset.gap === 'cjk'
          ? 0
          : classicActiveOverflowPadPx(word.offsetWidth, factor, activeScale);
      const padText = `${round4(pad)}px`;
      if (word.style.getPropertyValue('--pi-word-pad') !== padText) {
        word.style.setProperty('--pi-word-pad', padText);
      }
      // 占位是 margin，`offsetWidth` 量不到它；这里补进「墨迹总宽」，中文间隙才不会被算多。
      visualWidth += word.offsetWidth * factor + pad * 2;
    }
    // ① 中文间隙：只有 2 条以上 cjk 间隙的短行才摊（长句夹回下界，行为逐位不变）。
    const gaps = line.querySelectorAll<HTMLElement>('.pi-lyricstage__word[data-gap="cjk"]');
    if (gaps.length < 2) continue;
    const fontPx = Number.parseFloat(getComputedStyle(line).fontSize);
    if (!(fontPx > 0)) continue;
    for (const space of line.querySelectorAll<HTMLElement>('.pi-lyricstage__space')) {
      visualWidth += space.offsetWidth;
    }
    const gapPx = classicJustifyGapPx(visualWidth, frame.clientWidth, gaps.length, fontPx);
    const text = `${round4(gapPx)}px`;
    for (const gap of gaps) {
      if (gap.style.getPropertyValue('--pi-line-gap') !== text) {
        gap.style.setProperty('--pi-line-gap', text);
      }
    }
  }
}

/**
 * 量一次框：把**还没开始飞**（`data-word-state='waiting'`）的字夹进 `frame` 内缘。
 *
 * - **只处理 waiting**：正在唱（`active`）的字动画已经起跑，这时改写 `--pi-word-wait-x/y`
 *   会让关键帧的 0% 那一帧突变 —— 字会「跳」一下（用户 m00001 第 3 条要的正是「流畅」）。
 *   waiting 的那批才是**接下来要飞**的，它们还没有任何动画在跑，写变量是安全的。
 * - **框选了谁**：见 `LyricStage` 里那段 `useLayoutEffect` 的注释（`.pi-lyricstage__viewport`）。
 * - **坐标系**：`sharedOffsetParent(word, frame)` 求公共原点，两边都用布局值，相减得「字相对框」。
 * - **缩放**：用「夹取后的距离 ÷ 原意图距离」这个**无量纲比例**去缩放整支位移向量 ⇒ 方向逐位不变。
 * - **只在真的需要缩的时候写 DOM**（`scale < 1`）：不需要缩的字一个字节都不动，
 *   也就不会因为写同值而触发多余的重算；写进去的值过 `round4`，与 TS 逐位一致。
 */
function clampWaitingFlyToFrame(frame: HTMLElement, atoms: readonly StageAtom[]): void {
  const words = frame.querySelectorAll<HTMLElement>(
    '.pi-lyricstage__word[data-word-state="waiting"]',
  );
  for (const word of words) {
    const atom = atoms[Number.parseInt(word.dataset.atomIndex ?? '', 10)];
    if (atom === undefined || atom.spacer === true) continue;
    /*
     * **用户本轮第 2 条**：起点不再是「固定从左上角 0.9~1.4em」，而是 folia 的 waiting 目标值
     *（`waitX/waitY`，最多离落点 ±100px / ±50px）。要夹的是**相对落点的那支位移**：
     * `waitX − x` / `waitY − y`；夹完写回 `--pi-word-wait-x/y`（绝对量，直接进 transform）。
     */
    const intentX = atom.waitX - atom.x;
    const intentY = atom.waitY - atom.y;
    if (intentX === 0 && intentY === 0) continue;
    const common = sharedOffsetParent(word, frame);
    if (common === null) continue;
    const wordBox = layoutBoxIn(word, common);
    const frameBox = layoutBoxIn(frame, common);
    if (wordBox === null || frameBox === null) continue;
    const intent = Math.hypot(intentX, intentY);
    if (!(intent > 0)) continue;
    // 框的内缘（`right/bottom` 取的是它自己的 padding 盒尺寸；这个框没有 border/padding）。
    const runway = frameRunwayPx(
      (wordBox.left + wordBox.right) / 2 - frameBox.left,
      (wordBox.top + wordBox.bottom) / 2 - frameBox.top,
      intentX / intent,
      intentY / intent,
      {
        left: 0,
        top: 0,
        right: frameBox.right - frameBox.left,
        bottom: frameBox.bottom - frameBox.top,
      },
    );
    const scale = clampFlyToFrame(intent, runway) / intent;
    if (!(scale < 1)) continue;
    word.style.setProperty('--pi-word-wait-x', `${round4(atom.x + intentX * scale)}px`);
    word.style.setProperty('--pi-word-wait-y', `${round4(atom.y + intentY * scale)}px`);
  }
}

/**
 * 字素序列 → 原子序列。三条规则（顺序即优先级）：
 * 1. 空白字素 → 单独一个 `spacer` 原子（撑出 ≥0.38em 的真实空格，同时保住断词信息）；
 * 2. CJK 字素 → 一个字素一个原子（中文照旧逐字冒出）；
 * 3. 其余字素**连续成串**才算一个原子（字母、数字、标点、撇号、连字符、符号都算）。
 *    标点跟着词走（`hello,world` / `don't` / `well-known` 各是一个原子）是有意的：
 *    这样「两个西文原子紧贴在一起」只可能被 spacer 隔开，探针那条判据不会被误触。
 *
 * 另外：yrc 的 `line.words` 是**词**一级的时间戳，词与词之间的空格不在数据里，
 * 所以 `wordStart === true` 时补一个 spacer（否则 `havetokeephinding` 会连成一坨，
 * 而且是两个紧贴的西文原子 = 探针判失败）。
 *
 * 空行由调用方兜成 `['…']`，它落进规则 3，仍是一个可见的原子。
 */
function buildStageAtoms(
  words: readonly StageWord[],
  lineTimeMs: number,
  intensity: AnimationIntensity,
  spin: boolean,
): StageAtom[] {
  const atoms: StageAtom[] = [];
  let from = -1;
  let text = '';

  /** 空白 / 窄间隙共用的构造（间距原子：不挂 `data-word-state`、不参与逐字状态）。 */
  const makeSpacer = (content: string, word: StageWord | undefined, gap: number): StageAtom => ({
    text: content,
    startMs: word?.startMs ?? 0,
    endMs: word?.endMs ?? 0,
    x: 0,
    y: 0,
    rot: 0,
    passedRot: 0,
    scale: 1,
    waitX: 0,
    waitY: 0,
    waitRot: 0,
    gap,
    spacer: true,
  });

  const emitSpace = (text: string, word: StageWord | undefined): void => {
    atoms.push(
      makeSpacer(
        text,
        word,
        round4(
          SPACE_MIN_EM + classicNoise(lineTimeMs / 1000, atoms.length * 7 + 5) * SPACE_SPAN_EM,
        ),
      ),
    );
  };

  /**
   * 一个**窄间隙**：不给独立原子，直接写在**原子的 `gap`** 上（CSS 用它做 `margin-right`）——
   * 少一个原子就少一次「下标错位」的机会（逐字状态、`data-atom-index`、单测夹具全都按原子下标对齐）。
   */
  const emitGap = (): number => CJK_GAP_EM;

  const flush = (to: number, gapAfter = 0): void => {
    const start = from;
    const content = text;
    from = -1;
    text = '';
    if (start < 0) return;
    const first = words[start];
    const last = words[to];
    if (first === undefined || last === undefined) return;
    const motion = classicMotionFor(lineTimeMs, atoms.length, intensity, spin);
    atoms.push({
      text: content,
      startMs: first.startMs,
      endMs: last.endMs,
      x: motion.x,
      y: motion.y,
      rot: motion.rot,
      passedRot: motion.passedRot,
      scale: motion.scale,
      waitX: motion.waitX,
      waitY: motion.waitY,
      waitRot: motion.waitRot,
      gap: gapAfter,
      spacer: false,
    });
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined) continue;
    const grapheme = word.text;
    if (isBlankGrapheme(grapheme)) {
      flush(index - 1);
      // 空白的起止时间其实用不到，但保留字素本身（制表 / 全角空格比半角宽）。
      emitSpace(grapheme, word);
      continue;
    }
    if (word.wordStart === true && from >= 0) {
      flush(index - 1);
      emitSpace(' ', word);
    }
    if (CJK_ATOM.test(grapheme)) {
      flush(index - 1);
      from = index;
      text = grapheme;
      /*
       * **用户（本轮）第 1 条**：中文相邻两字之间补一条窄间隙。
       * 只在「下一个字素还是实字」时补（后面是空格 / 行尾 / 收尾标点时不补）——
       * 间隙写在**这个原子自己的 `gap`** 上，不额外插原子（见 `emitGap` 的注释）。
       */
      const next = words[index + 1];
      const needsGap = next !== undefined && !isBlankGrapheme(next.text);
      flush(index, needsGap ? emitGap() : 0);
      continue;
    }
    if (from < 0) from = index;
    /*
     * **音节连接符**（用户第二十三轮第 3 条，图 2 / 图 4）：`Oh-ah-oh` 要在连字符处断开，
     * 连字符本身跟着**前一段**走，断口上补一个与词间同档的空隙（图 4 的样子）。
     * 放在「攒原子」这一支的最后：CJK 与空白那两支都先走，连字符本身不是 CJK 也不是空白，
     * 所以它一定落到这里；`from < 0` 时（行首就是连字符）不拆，免得切出一个空的原子。
     */
    text += grapheme;
    /*
     * `text.length > grapheme.length`：**行首（或刚断完）就是一个连接符时不拆** ——
     * 否则 `-oh-` 会被切成 `-` + 空隙 + `oh-`，在一句话的开头顶出一个莫名其妙的空档。
     * 只有「连接符前面已经有实字」时它才算音节分隔。
     */
    if (SYLLABLE_JOIN.test(grapheme) && text.length > grapheme.length) {
      flush(index, 0);
      const next = words[index + 1];
      if (next !== undefined && !isBlankGrapheme(next.text)) emitSpace(' ', word);
    }
  }
  flush(words.length - 1);
  return atoms;
}

/**
 * 每行的字素时间轴（一次算完，缓存在 `useMemo` 里）。
 *
 * **数据现实**（第十一轮第 1 条更新）：yrc 其实**带**行时长与逐字时间戳，`parseLrc` 以前把
 * 它们丢了，所以这里只能拿「行时长平均分给每个字素」来推；现在两者都从上游带上来：
 * - 行时长：`line.durationMs`（yrc 行首）优先，其次是「**第一个严格更晚**的时间戳 − 本行起点」，
 *   最后才是 `LAST_LINE_FALLBACK_MS`。取**较大**值 ⇒ 有真时长时它是下限（和声 / 时间重叠时救场），
 *   只有 LRC 时 `durationMs` 缺省、行为与改造前逐字节一致。「下一句」相隔很远（间奏）时，
 *   估算值按字素数封顶（用户 m06084 第 3 条：不封顶就会把这一行的进度拖到间奏结束）。
 * - 逐字：`line.words` 存在就直接摊平（词内仍按字素均分），否则退回均分的近似。
 * 每个字素的可见时长取 `max(步长, 最短显示时长)`（仅均分路径），短行里相邻字会有短暂重叠
 * （都在「当前」），这比让每个字只亮 20ms 更接近「流光」该有的观感。
 *
 * 第十六轮之后这里还多算一份**原子**时间轴（`atoms` / `atomStarts` / `atomEnds`）：
 * 逐字素的状态判定改成逐原子（西文整词一起亮、一起过），`starts` / `ends` 保留给测试与
 * 「字素」这一层语义（云阶那边也仍然在用字素序列）。
 */
export function buildStageLines(
  lines: readonly LyricLine[],
  /**
   * 动效密度与「逐字旋转」开关：两者都只喂 `classicMotionFor`（folia 的 `animationIntensity`
   * 与 `enableWordRotation`）。默认值 = 常速 + 开旋转，够单测用；组件那边传 `palette` 里的
   * `animationIntensity` 与设置页那枚开关的真实取值。
   */
  motion: { readonly intensity: AnimationIntensity; readonly spin: boolean } = {
    intensity: 'moderate',
    spin: true,
  },
): StageLine[] {
  const nextGreater = nextGreaterTimes(lines);
  const gapCap = gapCapMs(lines, nextGreater);
  return lines.map((line, index) => {
    const nextTime = nextGreater[index];
    const gap =
      nextTime === undefined || Number.isNaN(nextTime)
        ? LAST_LINE_FALLBACK_MS
        : nextTime - line.timeMs;
    // 用户 m06084 第 3 条「间奏前的歌词进度总是会滞后」：`gap` 是「到下一个**严格更晚**的时间戳」，
    // 在间奏前那一句上它等于**整段间奏**，于是 durationMs 被拉长几十秒 —— 只有 LRC 时逐字均分
    // 会把这一行亮到间奏结束，有 yrc 时浮名的块终点（= timeMs + durationMs）也跟着拖到间奏之后、
    // 整段间奏都不褪色。所以「有下一行」时把 gap 削到 `gapCap`（整首歌行间隔中位数的 2.5 倍）；
    // 「没有下一行」的兜底不封顶，那是刻意给最后一行留的 4s。真时长仍是硬下限。
    const hasNext = nextTime !== undefined && !Number.isNaN(nextTime);
    const capped = hasNext ? Math.min(gap, gapCap) : gap;
    const durationMs = Math.max(line.durationMs ?? 0, capped, 1);
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
    // 第十六轮第 1 / 3 条：原子（西文整词 / 中文单字）+ 三态动效参数，一次算完随行缓存。
    // 本轮第 2 条起参数的形状由 folia classic 的三态模型定（见 `classicMotionFor`）。
    const atoms = buildStageAtoms(words, line.timeMs, motion.intensity, motion.spin);
    return {
      index,
      timeMs: line.timeMs,
      text: line.text,
      durationMs,
      hint,
      words,
      starts: words.map((word) => word.startMs),
      ends: words.map((word) => word.endMs),
      atoms,
      atomStarts: atoms.map((atom) => atom.startMs),
      atomEnds: atoms.map((atom) => atom.endMs),
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
 * 逐**原子**状态（第十六轮第 1 条起：西文一个词就是一个原子 —— 一起亮、一起放大、一起过）。
 * `atomEnds` / `atomStarts` 都升序，所以两次二分就够：
 * - `passedCount`：终点已经过去的原子（唱过了）。
 * - `activeCount`：起点落在「当前位置 + 预读窗口」之前的原子（正在唱）。
 *
 * 计数与下标同序（`upperBound` 返回的是**前缀长度**），所以数组里夹着词间空白原子也不会错位。
 */
function atomStatesFor(line: StageLine, positionMs: number): readonly WordState[] {
  const { lookaheadMs } = WORD_TIMING[line.hint];
  const passedCount = upperBound(line.atomEnds, positionMs);
  /**
   * **用户本轮第 2 条**（原话：「一次只有一个字可以有高光」）。
   *
   * 旧写法是 `upperBound(atomStarts, positionMs + lookaheadMs)`：只要**下一个**原子的起点落进
   * 预读窗口（normal 档 150ms）就一起点亮 —— 相邻两字的高亮窗口一重叠，屏上就是**两个字同时**是
   * 高亮色（实测 1850ms 处「甲」还没唱完、「乙」已经亮了）。现在夹在 `passedCount + 1`：
   * 只有「第一个还没唱完的那个字」是 active，其余一律 waiting；它唱完（`passedCount` 前进）
   * 才轮到下一个。空白间隔里也保持它 active（打印前沿停在刚写完的那颗上，不回退、不闪）。
   */
  const activeCount = Math.max(
    passedCount,
    Math.min(passedCount + 1, upperBound(line.atomStarts, positionMs + lookaheadMs)),
  );
  return line.atoms.map((_atom, index) =>
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
  /** 显示行的逐原子状态（与 `line.atoms` 同序）；没有行时 `null`。 */
  readonly states: readonly WordState[] | null;
}

/**
 * 「某个播放位置该显示什么」——纯函数，单测直接喂位置断言。
 *
 * 换行的判据**只有** `timeMs` 一条：不许为了「切得柔和一点」给换行加 `lookahead`，
 * 那会让下一句在真正开口之前就提前高亮（单测「下一句开始前的 40ms 内当前句不能提前高亮」钉的就是它）。
 * 预读窗口只作用在**逐原子**上（`atomStatesFor` 的 `active`），与换行无关。
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
    states: displayLine === undefined ? null : atomStatesFor(displayLine, positionMs),
  };
}

/**
 * 可视状态签名：当前句 + 显示句 + 每个原子的状态。
 *
 * 平滑时钟每帧都算一帧出来，但**只有签名变了才值得重渲染** —— 这样既拿到了连续时钟，
 * 又守住文件头第 3 条「不是每帧都重渲染」的性能契约（一次换行 / 一个原子换态 = 一次渲染）。
 * 第十六轮起西文整词是一个原子，重渲染次数只会更少（不会更多）。
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
  /** 逐原子状态（与 `line.atoms` 同序）；出场行传 `undefined` —— 整行按「唱过了」渲染。 */
  states: readonly WordState[] | undefined;
  onSelect: (() => void) | undefined;
  /** 第十四轮第 4 条（用户 m05281）：流光的「逐字旋转」开关（设置页 lyricTuning.classicWordSpin）。 */
  spin: boolean;
}

/**
 * 旋转的最高合成角（度）—— **用户本轮第 2 条（第二遍）**之后 classic 实际跑在 **moderate**
 * 档（见 `classicIntensityOf`），所以上界是：落点角 ±5°（`CLASSIC_ROT_DEG.moderate`）
 * + 未唱那一格额外的 20° + 唱完的漂移角 ±7.5°（`CLASSIC_PASSED_ROT_SPAN_DEG.moderate / 2`）
 * = 32.5°。未唱那一格的 20° 只在入场过渡里一闪，落定后的字最大 12.5°。
 *
 * 冒烟探针 `spinOk` / `classicSpinOk` 读的就是这几个数（判据写在
 * apps/desktop/src/main/index.ts 的那两段里）。导出只为单测与探针共用同一个上界。
 */
export const CLASSIC_MAX_ROT_DEG =
  CLASSIC_ROT_DEG.moderate + CLASSIC_WAIT_ROT_DEG + CLASSIC_PASSED_ROT_SPAN_DEG.moderate / 2;

/**
 * 一行。外面是 button（保留 `type="button"` + `aria-label`，键盘可达），
 * 里面套两层 span：`.pi-lyricstage__float` 负责呼吸浮动，`.pi-lyricstage__words` 是
 * `flex-wrap` 的字素行容器。分成两层是因为**进场动画与浮动动画都要写 transform**，
 * 放同一个元素上会互相覆盖。
 */
function StageLineView({
  line,
  phase,
  active,
  states,
  onSelect,
  spin,
}: StageLineViewProps): ReactNode {
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
          {line.atoms.map((atom, index) =>
            atom.spacer ? (
              /* 词间空白自己也是一个原子：真实占位（≥0.38em，见 SPACE_MIN_EM），
               * 但它不挂 `data-word-state` —— 它不是「字」，不参与逐字状态、不进配色采样。 */
              <span
                key={`space-${index}`}
                className="pi-lyricstage__space"
                aria-hidden="true"
                style={{ '--pi-space-extra': `${atom.gap}em` } as CSSProperties}
              >
                {atom.text}
              </span>
            ) : (
              <span
                key={`${index}-${atom.text}`}
                className="pi-lyricstage__word"
                /* 出场行（states === undefined）整行按「唱过了」渲染，但仍然是逐原子渲染：
                 * 上一行化掉时保留自己的错落，不会突然变成一条整齐的直线。 */
                data-word-state={states === undefined ? 'passed' : (states[index] ?? 'waiting')}
                data-word-spin={spin ? 'true' : undefined}
                /* 用户 m00001 第 5 条（本轮）：「远处」要夹到歌词框内缘，而夹取发生在**布局阶段**
                 * （DOM 已经在，但还没画出来），那一层拿不到 `atom` 对象，只能反查 ——
                 * 这个下标就是给 `clampWaitingFlyToFrame` 用的（它按此取回意图位移）。
                 * 只加一个 data 属性、不碰任何 style：探针读的是 `data-word-state` /
                 * `--pi-word-rot` / `rotate`，多一个属性不影响它们。 */
                data-atom-index={index}
                /* **用户第 9 轮第 2 条**：这支原子后面挂着一条「中文间隙」——`justifyShortLine()`
                 * 就按这个选择器找可摊开的间隙（空格原子与西文原子都不带它，不会被摊）。
                 * 选 `data-gap` 而不是复用一个 class：class 会被别处的选择器顺着改样式，
                 * 而这里只想要一个「标记」，不带任何样式语义。 */
                data-gap={atom.gap > 0 ? 'cjk' : undefined}
                /* **用户本轮第 2 条**：三态动效的全部参数都写在元素上（folia 的
                 * `WordLayoutConfig` 对应物，见 `StageAtom` / `classicMotionFor`）：
                 *   `--pi-word-x/y`    落点相对排版位置的偏移（px）
                 *   `--pi-word-rot`    落点停留角（度）
                 *   `--pi-word-passed-rot` 唱完之后在 5s 里慢慢转过去的漂移角（度）
                 *   `--pi-word-scale`  落点常态缩放（≈1.1~1.3）
                 *   `--pi-word-wait-x/y/rot` 未唱那一格的位置与角度（远处、缩小、歪 20°）
                 * CSS 侧三态的目标值见 lyric-stage.css 的「classic：三态」那一段；未唱那一格还会被
                 * `clampWaitingFlyToFrame` 按歌词框内缘夹一次（folia 的 ±100px 是相对整窗给的）。
                 *
                 * 这里全是**常数字符串拼接**：`atom` 由 `buildStageLines` 的 `useMemo` 逐行缓存，
                 * 每个值的字符串形态在一次渲染里逐位稳定 ⇒ React 对同一支变量不做 DOM 写入、
                 * 也就不会重启过渡或触发多余的样式重算。 */
                style={
                  {
                    '--pi-word-x': `${atom.x}px`,
                    '--pi-word-y': `${atom.y}px`,
                    '--pi-word-rot': `${atom.rot}deg`,
                    '--pi-word-passed-rot': `${atom.passedRot}deg`,
                    '--pi-word-scale': `${atom.scale}`,
                    // 「正在唱」在落点缩放之上再乘的倍数（folia 的 `config.scale × 1.4`）。
                    // 写在行内是为了让那个常数只有一处定义（`CLASSIC_ACTIVE_SCALE`）。
                    '--pi-word-active-scale': `${CLASSIC_ACTIVE_SCALE}`,
                    // **用户（本轮）第 1 条**：中文两字之间的窄间隙（`buildStageAtoms` 写在
                    // 原子自己的 `gap` 上；西文原子恒为 0）。CSS 用它做 `margin-right`。
                    '--pi-word-gap': `${atom.gap}em`,
                    '--pi-word-wait-x': `${atom.waitX}px`,
                    '--pi-word-wait-y': `${atom.waitY}px`,
                    '--pi-word-wait-rot': `${atom.waitRot}deg`,
                  } as CSSProperties
                }
              >
                {atom.text}
              </span>
            ),
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
  playing = true,
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
  /**
   * 用户 m00001 第 5 条（本轮）：「远处」的基准 —— 歌词框。classic 分支里那层
   * `.pi-lyricstage__viewport`（选它的三条依据写在下面那段 `useLayoutEffect` 的注释里）。
   */
  const frameRef = useRef<HTMLDivElement>(null);
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
  /** **用户第 5 轮第 2 条**：rAF 回调里读的必须是这一帧的播放状态（与 `positionRef` 同一手法）。 */
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const viewRef = useRef(viewIndex);
  viewRef.current = viewIndex;

  /**
   * **用户本轮第 2 条**：三态动效的两个输入。
   *
   * `intensity` 走 folia 的 `animationIntensity`（`palette` 自带，`HomePage` 固定 `chaotic`）：
   * 它只缩**落点错落**与**倾角**（`CLASSIC_SPREAD_PX` / `CLASSIC_ROT_DEG`），与改造前那些
   * 「按档位给固定错落」的写法不同 —— 现在两者是同一个量。
   *
   * `classicSpin` = 第十四轮第 4 条那枚「流光 · 逐字旋转」开关（folia 的 `enableWordRotation`）。
   * 只挂在 classic 分支上（主题分支自己的 DOM 里也有 `.pi-lyricstage__word`，但那是别的主题的
   * 排版，不该被流光的开关牵连）。
   */
  const classicIntensity = classicIntensityOf((palette ?? DEFAULT_PALETTE).animationIntensity);
  const classicSpin =
    Themed === undefined && tuningOf(palette ?? DEFAULT_PALETTE).classicWordSpin === true;

  // 字符切分 + 每字素时间轴：只在 `lines` 变化时算一次（一行几十个字素，但不该每帧重算）。
  // 三态动效的参数也随行缓存（`classicMotionFor` 是纯函数，只吃行起点 / 下标 / 上面那两个设置）。
  const stageLines = useMemo(
    () => buildStageLines(lines, { intensity: classicIntensity, spin: classicSpin }),
    [lines, classicIntensity, classicSpin],
  );
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
      const smoothPosition = smoothPositionAt(anchor, now, playingRef.current);
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

  /**
   * 用户 m00001 第 5 条（本轮）：「远处」= **歌词框的内缘**，不是固定若干 em 的远处
   *（写这条时纵向意图是 1.9~3.4em；用户本轮第 2 条已把纵向归零）。
   *
   * 框选了谁、为什么：classic 分支里那层 `.pi-lyricstage__viewport`（下面渲染处的 `ref={frameRef}`）。
   * 依据有三条，都不是拍脑袋：
   *   1. classic 没有「纸面 / 卡片」那种单独画出来的歌词框 —— 全仓 CSS 里带 paper/frame 字样的
   *      歌词框只有 `--pi-fume-paper-*`（雾霭主题，lyric-moods.css:191-192），流光一个都没有；
   *   2. 流光今天的视觉结构是「整窗舞台」（`.pi-lyricstage[data-theme='classic']` 是
   *      `position: absolute; inset: 0`，见 lyric-stage.css:108）—— 根节点与 `.pi-lyricstage__stage`
   *      都铺满整个播放页，拿它们当框等于「把框取成窗口」，用户要的不是这个；
   *   3. `.pi-lyricstage__viewport`（lyric-stage.css:200-206）是**紧密包住当前这一行歌词**的那一层
   *      （`display: grid; place-items: center`，高度 = 行盒高度）—— 它就是「歌词字体那一块」的边框，
   *      正是用户说的「远处就是歌词字体的边框位置」。
   *
   * 时机与幂等：`useLayoutEffect`（不是 `useEffect`）—— DOM 已经建好、浏览器还没画第一帧，
   * 所以变量在字第一次可见之前就写好了，绝不会「动画已经开始再改变量」。
   * 量的是 layout 值（`layoutBoxIn`，不受 transform 影响）⇒ 写变量不会改变下一次的测量结果。
   * 依赖 `stageLines` 是必需的：**换行**（锚点变）会重建一批字，那批新字要重新夹。
   */
  useLayoutEffect(() => {
    // 主题分支（fume / tilt / …）没有这层框，也没有这套飞入变量，整段跳过。
    if (!smooth) return;
    const frame = frameRef.current;
    const line = stageLines[anchorIndex];
    if (frame === null || line === undefined) return;
    const run = (): void => {
      // 先摊字距（改的是 margin，会让整行重新排版），再按**摊开之后**的位置夹飞行起点 ——
      // 顺序反过来的话，夹取量到的是旧布局，字会被摊到框外那点余量算漏。
      layOutClassicLines(frame);
      clampWaitingFlyToFrame(frame, line.atoms);
    };
    run();
    // 窗口尺寸 / 主题宽度变化会同时改变框与字号（`8cqi`），量出来的余量随之变化 —— 跟着重量一次。
    // 单列一条 resize 兜底是给没有 ResizeObserver 的环境（老版本 / 测试桩）留的，正常不会用到。
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', run);
      return () => window.removeEventListener('resize', run);
    }
    const observer = new ResizeObserver(run);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [smooth, anchorIndex, stageLines]);

  /**
   * **版式在换行那一刻就定死**（用户第二十四轮第 2 条）。
   *
   * 上面那条 `useLayoutEffect` 已经在「换行 / 尺寸变化」时把字距与放大占位都写好了；
   * 这里**不再**跟着「谁在唱」去改任何排版量 —— 曾经这么干过（第二十三轮：占位只给正在唱的
   * 那个字、唱到下一个字再交接），结果每换一个字整行就要重排一次，用户看到的就是「歌词在颤动」。
   * 现在播放期间只跑 transform（入场、错落、放大），排版一个像素都不动。
   */

  if (lines.length === 0) return null;

  const displayLine = stageLines[anchorIndex];
  const wordStates = displayLine === undefined ? undefined : atomStatesFor(displayLine, clockMs);
  const leavingLine =
    leavingIndex === null || leavingIndex === anchorIndex ? undefined : stageLines[leavingIndex];

  /*
   * **用户第 8 轮第 2 条**（原话：「所有的歌词动效的翻译歌词都设置在进度条部件的上面，
   * 并且一次只显示一句」）：
   *   ① 字幕层从「只有 classic 挂在舞台根上」变成**所有主题共用同一层** —— 位置只有一处定义
   *      （`lyric-stage.css` 的 `.pi-lyricstage__sub`：绝对贴底 + 让开进度条），六套主题的译文
   *      因此永远在同一条线上；各主题自己那份（浮名 / 云阶 / 心象 / 倾诉 / 时计）已经删掉。
   *   ② **只显示一句**：原先译文下面还跟着「下两句原文预览」（`previewLines`），现在整段删掉 ——
   *      字幕层里只留当前这一句的译文（没有译文时整层不渲染）。
   * 字幕跟着「正在看的那一行」走，不是跟着播放走——手动查看时译文也要跟着换。
   */
  const translatedText = displayLine === undefined ? undefined : translated.get(displayLine.timeMs);
  const hasSubtitle = translatedText !== undefined && translatedText.trim() !== '';

  /**
   * 当前显示这一行的进度（0~1）。classic 靠逐字状态而不是整行扫光高亮，所以它**不参与绘制**，
   * 只写进根节点的 `--pi-sweep`：注册成 `<number>` 后是个可插值的标量，UI 冒烟日志会读它，
   * 以后要加一条整行扫光也不用再动结构。
   */
  const lineProgress =
    displayLine === undefined
      ? 0
      : clamp((clockMs - displayLine.timeMs) / displayLine.durationMs, 0, 1);
  const rootStyle = {
    '--pi-sweep': lineProgress.toFixed(4), // 主题舞台的整体不透明度（设置页「主题不透明度」）。
    // 只挂在主题分支上：classic 的舞台结构是另一回事，多一个变量就多一处
    // 将来会被误读成「classic 也吃这个设置」的地方。变量落在根节点上、由舞台继承。
    ...(Themed === undefined
      ? {}
      : { '--pi-th-theme-opacity': tuningOf(palette ?? DEFAULT_PALETTE).themeOpacity.toFixed(3) }),
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
          <div className="pi-lyricstage__viewport" ref={frameRef}>
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
            playing={playing}
            theme={palette ?? DEFAULT_PALETTE}
            coverUrl={coverUrl}
          />
        )}
      </div>

      {hasSubtitle ? (
        <div className="pi-lyricstage__sub">
          {/* 字幕背后的径向光晕：垫一层页面底色，把下面的封面背景压下去一点，字幕才读得清。 */}
          <div className="pi-lyricstage__sub-glow" aria-hidden="true" />
          {/* key=锚点：换一句就把这层重新挂载，0.24s 的进场（opacity 0→1 / y 20px→0）才会重放。 */}
          <div className="pi-lyricstage__sub-inner" key={anchorIndex}>
            {/* **用户第 8 轮第 2 条**：一次只显示一句（原来是译文 + 下两句原文预览）。 */}
            <p className="pi-lyricstage__translated">{translatedText}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
