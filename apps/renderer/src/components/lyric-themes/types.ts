/**
 * 五套歌词动效主题共享的类型、数学与 DOM 小工具。
 *
 * === AGPL 说明 ===
 * 云阶 `partita` / 倾诉 `tilt` / 时计 `pendolo`（以及后续的浮名 `fume` / 心象 `cadenza`）
 * 在观感上复刻 folia-major（**AGPL-3.0**，`chthollyphile/folia-major@c249bde`）的同名歌词主题。
 * 这里**只借鉴它的数值与做法**：每套主题用到的数值都抄录在各自组件文件的头注释里，
 * 下面每一个表达式都是在本仓库里重新写的，没有拷贝任何 folia 源码文本。
 *
 * 这里放的是三套主题都要用的东西：
 * - 舞台行 / 字素的数据结构（结构与 `LyricStage.tsx` 里的私有类型一一对应，靠结构化类型对上）；
 * - 逐字素三态判定、行进度、副歌判定、字宽估算；
 * - 确定性 PRNG（同一行歌词每次渲染拿到同一组随机数，重渲染不会抖）；
 * - 元素尺寸 / 播放时钟 / 减少动效三个 hook；
 * - CSS 颜色解析（Canvas 里画不了 `var()`，得先落成 `rgb()`）。
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { DEFAULT_LYRIC_TUNING, type LyricFpsCap, type LyricTuning } from '@pi/shared';

export type Hint = 'normal' | 'short' | 'micro';
export type WordState = 'waiting' | 'active' | 'passed';
/** `folia` 的 `animationIntensity`；我们只用到「是不是 chaotic」。 */
export type AnimationIntensity = 'calm' | 'moderate' | 'chaotic';

export interface StageWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /*
   * 第十四轮第 6 条（用户 m05281）：这个字素是不是它所属**词**的第一个字素。
   *
   * 逐字时间戳（yrc）那条路上，服务端把每个词摊成字素交下来，词与词之间**没有空格字素**，
   * 而「空格字素」本来是 `buildAtoms`（云阶）唯一的分组依据 —— 于是一整行英文会被收进一个
   * 原子，渲染成 `havetokeephinding` 这种连成一坨的样子。
   * 舞台在 `timedWords` 里按原词把字素切开，给每个词的首字素打上这个标记；若真实存在空格
   * 字素，这个标记是多余的（`buildAtoms` 已经在空格处 flush），不存在时它就是唯一的词边界。
   */
  readonly wordStart?: boolean;
}

/** 一行歌词（由 `LyricStage.tsx` 的 `buildStageLines` 算好逐字素时间轴后交下来）。 */
export interface StageLine {
  readonly index: number;
  readonly timeMs: number;
  readonly text: string;
  readonly durationMs: number;
  readonly hint: Hint;
  readonly words: readonly StageWord[];
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

/**
 * 主题配色。默认值是**CSS 变量引用**（跟着亮/暗色走）——
 * 只有 Canvas（时计）才需要把 `var()` 落成具体颜色，见 `resolveCssColor`。
 */
export interface LyricPalette {
  readonly primaryColor: string;
  readonly accentColor: string;
  readonly backgroundColor: string;
  /** 情绪词 → 颜色（folia 的 `wordColors`）；没有就退到 accentColor / primary。 */
  readonly wordColors?: Readonly<Record<string, string>>;
  readonly animationIntensity: AnimationIntensity;
  /**
   * 动效细调参数（设置页「歌词动效参数」那张卡）。
   *
   * 跟着 `palette` 一起传而不是另开一个 prop：`palette` 本来就是「主题怎么画」的
   * 全部输入，而且 `HomePage` 已经把它的引用稳定性当成硬约束在维护了——
   * 再开一个 prop 就等于把同一条约束写两遍，早晚有一处忘掉。
   */
  readonly tuning?: LyricTuning;
}

export const DEFAULT_PALETTE: LyricPalette = {
  primaryColor: 'var(--pi-primary)',
  accentColor: 'var(--pi-np-accent, var(--pi-primary))',
  backgroundColor: 'var(--pi-surface)',
  animationIntensity: 'chaotic',
};

/** 主题组件收到的全部输入。`viewIndex` 是「正在看哪一行」，与播放位置无关。 */
export interface LyricThemeProps {
  readonly lines: readonly StageLine[];
  readonly translated: ReadonlyMap<number, string>;
  /** 播放到的那一行（未到第一句时是 -1）。 */
  readonly activeIndex: number;
  /** 舞台锚点：跟随播放时等于 `activeIndex`（没到第一句时是 0），手动查看时是用户滚到的那行。 */
  readonly viewIndex: number;
  /** 上一行（正在演「出场」）；没有就是 null。 */
  readonly leavingIndex?: number | null;
  readonly positionMs: number;
  /**
   * 播放器**此刻是不是在出声**（`store.status === 'playing'`）。不传按「在放」处理。
   *
   * **用户第 5 轮第 2 条**（原话：「我按暂停，歌词依旧会先走几步再猛地回到暂停的进度位置」）：
   * `positionMs` 只有 ~4Hz，主题层要拿 `usePositionClock` 外推才能连续；可外推**必须**知道
   * 播放器停没停 —— 只靠「多久没收到新值」推断时，暂停后那 600ms 里时钟会继续往前跑，
   * 等超时判定回落到锚点值时，画面就是「先走几步、再猛地回到原位」。有这个 prop 就直接停。
   */
  readonly playing?: boolean;
  /**
   * 整首歌曲时长（毫秒）；拿不到就不传（`0` / `undefined` 都当「不知道」）。
   *
   * **用户 m01402 第 3 条（M4 剩余项）**：浮名曲尾「剩余 N 秒」的判据靠它；不传时 `FumeTheme`
   * 退回「整首歌词已经唱完」的旧判据，所以老调用点行为一字不改。
   */
  readonly durationMs?: number;
  readonly theme: LyricPalette;
  /** 时计主题可选：封面 URL（拿不到就只画线框表盘）。 */
  readonly coverUrl?: string;
}

/* ------------------------------------------------------------------ *
 * 动效参数（设置页「歌词动效参数」）
 * ------------------------------------------------------------------ */

/**
 * 主题拿到的动效参数；没传时就是「改造前的观感」（各项 1 / off / false）。
 *
 * 每套主题在 render 顶部取一次、然后**闭包捕获**进 rAF：不要在 tick 里每帧取，
 * 那会在热路径上判空取属性；参数变化走的是「effect 依赖变化 → 重启循环」这条路。
 */
export function tuningOf(palette: LyricPalette): LyricTuning {
  return palette.tuning ?? DEFAULT_LYRIC_TUNING;
}

/** 帧率上限档位 → 每秒帧数；`0` 表示不设限（见 `createFrameGate`）。 */
const FPS_CAP_VALUE: Record<LyricFpsCap, number> = { off: 0, '120': 120, '90': 90, '60': 60 };

/**
 * 帧率上限的容差（ms）。
 *
 * 闸门是「按最小帧间隔抽帧」，如果严格比较，显示器 60Hz + 上限 60 这种**刚好相等**
 * 的情况会因为 rAF 时间戳的浮点抖动（16.6 vs 16.667）被误判成「太早」，
 * 于是每一帧都被挡、帧率直接腰斩成 30。留 1.5ms 余量只让「明显早于阈值」的帧被丢。
 */
const FRAME_GATE_SLACK_MS = 1.5;

/**
 * 帧率上限闸门。
 *
 * 返回 `(now) => boolean`：这一帧该不该画，`tick` 开头不通过就直接 `return undefined`。
 * `off` 返回一个恒真的常量函数——不设限必须**严格等于**改造前的行为。
 *
 * 注意这是**抽帧**而不是「目标帧率」：90 在 120Hz 屏上只能落到 60（8.33ms 的帧
 * 要么全放 120、要么隔一放一得 60，没有中间档）。它保证的是「不会比这个更快」。
 */
export function createFrameGate(fpsCap: LyricFpsCap): (now: number) => boolean {
  // `noUncheckedIndexedAccess`：查表结果按 `number | undefined` 算，`?? 0` 落到不设限。
  const fps = FPS_CAP_VALUE[fpsCap] ?? 0;
  if (fps <= 0) return () => true;
  const minInterval = 1000 / fps - FRAME_GATE_SLACK_MS;
  let lastDrawn = Number.NEGATIVE_INFINITY;
  return (now: number) => {
    if (now - lastDrawn < minInterval) return false;
    lastDrawn = now;
    return true;
  };
}

/* ------------------------------------------------------------------ *
 * 数学 / 判定
 * ------------------------------------------------------------------ */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 小数部分（folia 的 `frac`）。 */
export function frac(value: number): number {
  return value - Math.floor(value);
}

/** `frac(sin(seed) * 10000)`——folia 那种「播种后直接算」的确定性随机。 */
export function seededFraction(seed: number): number {
  return frac(Math.sin(seed) * 10000);
}

/**
 * 递增式确定性 PRNG：`frac(sin(seed++) * 10000)`。
 * 用**行的 `timeMs`** 播种，所以同一行每次渲染得到同一串数（重渲染不抖、换行才换串）。
 */
export function makeRandom(seed: number): () => number {
  let step = Math.floor(seed);
  return () => {
    step += 1;
    return seededFraction(step);
  };
}

/**
 * 逐字预读窗口（毫秒）——`partita` 规格：normal / short / micro = 0.03 / 0.08 / 0.15s。
 * 注意这与 `LyricStage.tsx` 里 classic 的 `WORD_TIMING`（micro 30 / short 80 / normal 150）
 * **正好相反**：任务书给 partita 的就是这组，按任务书写。
 */
export const HINT_LOOKAHEAD: Record<Hint, number> = { normal: 30, short: 80, micro: 150 };

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

/** 逐字素三态：`ends` / `starts` 都升序，两次二分就够。 */
export function wordStatesFor(
  line: StageLine,
  positionMs: number,
  lookaheadMs: number,
): WordState[] {
  const passedCount = upperBound(line.ends, positionMs);
  const activeCount = Math.max(passedCount, upperBound(line.starts, positionMs + lookaheadMs));
  return line.words.map((_word, index) =>
    index < passedCount ? 'passed' : index < activeCount ? 'active' : 'waiting',
  );
}

/** 这一行唱到哪儿了（0~1）。 */
export function lineProgressOf(line: StageLine, positionMs: number): number {
  if (line.durationMs <= 0) return 0;
  return clamp((positionMs - line.timeMs) / line.durationMs, 0, 1);
}

/**
 * 这一行是不是副歌。
 *
 * folia 有整首歌的结构信息（有没有副歌、副歌在哪），我们的上游只有行级时间戳与文本，
 * 所以这里用一个能自证的代理：**同一句原文在整首歌里出现两次以上**（副歌本来就是重复的），
 * 且不短于 4 个字。这是本仓库自己的判据，不是 folia 的。
 */
export function isChorusLine(lines: readonly StageLine[], index: number): boolean {
  const line = lines[index];
  if (line === undefined) return false;
  const text = line.text.trim();
  if (text.length < 4) return false;
  let seen = 0;
  for (const other of lines) {
    if (other.text.trim() !== text) continue;
    seen += 1;
    if (seen > 1) return true;
  }
  return false;
}

/** 情绪词配色：先整词命中，再退到包含命中，最后给 fallback。 */
export function wordColorOf(palette: LyricPalette, text: string, fallback: string): string {
  const map = palette.wordColors;
  if (map === undefined) return fallback;
  const direct = map[text];
  if (direct !== undefined) return direct;
  for (const key of Object.keys(map)) {
    if (key !== '' && text.includes(key)) {
      const color = map[key];
      if (color !== undefined) return color;
    }
  }
  return fallback;
}

/**
 * 粗略估一行文字占多宽（px）：CJK / 全角按 1em、其余按 0.55em，外加字距。
 * 倾诉主题要靠它做「太宽就重排 / 整体缩小」，而我们没有 pretext 那种真正的排版测量。
 */
export function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

export function estimateTextWidth(text: string, fontPx: number, letterSpacingEm: number): number {
  let em = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    em += isWideCodePoint(code) ? 1 : 0.55;
  }
  return em * fontPx + text.length * letterSpacingEm * fontPx;
}

/* ------------------------------------------------------------------ *
 * CSS 颜色 → Canvas 能用的 rgb
 * ------------------------------------------------------------------ */

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** 把 `var(--x)` / `color-mix(...)` / `#hex` 落到计算后的颜色字符串。 */
export function resolveCssColor(el: HTMLElement | null, value: string): string {
  if (el === null || value === '' || typeof getComputedStyle !== 'function') return value;
  const probe = el.ownerDocument.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.color = value;
  el.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  el.removeChild(probe);
  return resolved === '' ? value : resolved;
}

/** 解析 `rgb()` / `rgba()`（含 `rgb(r g b / a)` 写法）；解析不了返回 null。 */
export function parseRgb(color: string): RgbColor | null {
  const body = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  const raw = body?.[1];
  if (raw === undefined) return null;
  const parts = raw.split(/[\s,/]+/).filter((part) => part !== '');
  const r = Number.parseFloat(parts[0] ?? '');
  const g = Number.parseFloat(parts[1] ?? '');
  const b = Number.parseFloat(parts[2] ?? '');
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  const alphaRaw = parts[3];
  let a = 1;
  if (alphaRaw !== undefined) {
    a = alphaRaw.endsWith('%') ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
    if (!Number.isFinite(a)) a = 1;
  }
  return { r, g, b, a };
}

/** 给一个颜色套上透明度；解析不了就退回原色（Canvas 里颜色解析失败也不会崩）。 */
export function rgba(color: string, alpha: number): string {
  const parsed = parseRgb(color);
  if (parsed === null) return color;
  return `rgba(${Math.round(parsed.r)}, ${Math.round(parsed.g)}, ${Math.round(parsed.b)}, ${alpha})`;
}

/** 两个颜色按比例混（Canvas 里画不了 `color-mix()`）；解析不了就退 `base`。 */
export function mixColor(base: string, other: string, amount: number): string {
  const a = parseRgb(base);
  const b = parseRgb(other);
  if (a === null || b === null) return base;
  const t = clamp(amount, 0, 1);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

/* ------------------------------------------------------------------ *
 * hooks
 * ------------------------------------------------------------------ */

/** 元素尺寸（ResizeObserver 驱动）；没测到就是 0。 */
export function useElementSize<T extends HTMLElement>(
  ref: RefObject<T | null>,
): { readonly width: number; readonly height: number } {
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      setSize((previous) =>
        Math.abs(previous.width - rect.width) < 0.5 && Math.abs(previous.height - rect.height) < 0.5
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref]);
  return size;
}

export interface PositionClock {
  /** 估算的当前播放位置（毫秒）：跟随播放时用 `performance.now()` 外推，暂停时冻住。 */
  current: () => number;
}

/**
 * 平滑播放时钟。
 *
 * store 的 `positionMs` 只有 ~4Hz，逐字脉冲直接用它会有 250ms 一格的台阶。
 * 这里记下「上一次 prop 变化的时间」，用 `performance.now()` 外推；
 * 位置 600ms 没动过就当暂停/拖拽，冻在外推前的值上（否则暂停时脉冲会一直往前跑）。
 * 外层每 ~250ms 的 prop 更新会把它重新对齐一次。
 *
 * **用户第 5 轮第 2 条**（「按暂停，歌词依旧会先走几步再猛地回到暂停的进度位置」）：上面那条
 * 「600ms 没动就当暂停」是**事后推断**，暂停后那 600ms 里时钟照样在往前跑，等它判定完再落回
 * 锚点值 —— 屏幕上就是「先走几步、猛地弹回」。所以新增 `playing`：播放器一说停就**立刻**不再外推
 *（`current()` 直接返回锚点值），那 600ms 的猜测只留给「拿不到播放状态」的老调用点。
 */
export function usePositionClock(positionMs: number, playing = true): PositionClock {
  const state = useRef({ ms: positionMs, at: performance.now(), movedAt: performance.now() });
  useEffect(() => {
    const now = performance.now();
    state.current.ms = positionMs;
    state.current.at = now;
    state.current.movedAt = now;
  }, [positionMs]);
  // `current` 是稳定引用（下面 useMemo 的 deps 是空），所以播放状态要走 ref 读最新值。
  const playingRef = useRef(playing);
  playingRef.current = playing;
  return useMemo(
    () => ({
      current: (): number => {
        const snapshot = state.current;
        if (!playingRef.current) return snapshot.ms;
        const now = performance.now();
        if (now - snapshot.movedAt > 600) return snapshot.ms;
        return snapshot.ms + (now - snapshot.at);
      },
    }),
    [],
  );
}

/** 系统「减少动效」。CSS 那边由 `@media (prefers-reduced-motion: reduce)` 兜；rAF 主题读这个。 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/* ------------------------------------------------------------------ *
 * 文本度量：语言自适应
 * ------------------------------------------------------------------ */

/**
 * 真实字体度量（任务书第 4 条：动效要对不同语言的歌曲都成立）。
 *
 * 不要再用「CJK 每字 1em」这种字数估算去排版：英文单词、西里尔字母、日文假名混排
 * 全都量不准，会导致动效错位 / 挤成一团 / 溢出。这里用 canvas 的 `measureText`，
 * 走的是和 DOM 同一套字体栈，拿到的就是真实行宽。
 * 量不到（无 canvas / 度量抛错 / 空串）时回退 `estimateTextWidth`，保证永远返回有限值。
 * 结果按 `字号|字重|字体|字距|文本` 缓存，热路径（每帧、每次重排）不会反复开 canvas。
 */
const textWidthCache = new Map<string, number>();
let textWidthContext: CanvasRenderingContext2D | null | undefined;

function textMetricsContext(): CanvasRenderingContext2D | null {
  if (textWidthContext !== undefined) return textWidthContext;
  try {
    textWidthContext =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  } catch {
    textWidthContext = null;
  }
  return textWidthContext;
}

export function measureTextWidth(
  text: string,
  fontPx: number,
  fontWeight: number,
  fontFamily: string,
  letterSpacingEm: number,
): number {
  const fallback = estimateTextWidth(text, fontPx, letterSpacingEm);
  if (text === '') return 0;
  const context = textMetricsContext();
  if (context === null) return fallback;
  const key = `${fontPx.toFixed(2)}|${fontWeight}|${fontFamily}|${letterSpacingEm}|${text}`;
  const cached = textWidthCache.get(key);
  if (cached !== undefined) return cached;
  let width = fallback;
  try {
    context.font = `${fontWeight} ${fontPx}px ${fontFamily}`;
    width = context.measureText(text).width + text.length * letterSpacingEm * fontPx;
  } catch {
    width = fallback;
  }
  if (!Number.isFinite(width) || width <= 0) width = fallback;
  if (textWidthCache.size > 4096) textWidthCache.clear();
  textWidthCache.set(key, width);
  return width;
}

/** 一段文本的主要书写系统。只用于「走哪条分词 / 断行路径」，不用于精确排版。 */
export type ScriptKind = 'wide' | 'latin' | 'cyrillic' | 'thai' | 'other';

export function scriptKindOf(text: string): ScriptKind {
  let wide = 0;
  let latin = 0;
  let cyrillic = 0;
  let thai = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20) continue;
    if (isWideCodePoint(code)) {
      wide += 1;
    } else if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0xc0 && code <= 0x24f) ||
      (code >= 0x1e00 && code <= 0x1eff)
    ) {
      latin += 1;
    } else if (code >= 0x400 && code <= 0x4ff) {
      cyrillic += 1;
    } else if (code >= 0xe00 && code <= 0xe7f) {
      thai += 1;
    }
  }
  const max = Math.max(wide, latin, cyrillic, thai);
  if (max === 0) return 'other';
  if (max === wide) return 'wide';
  if (max === latin) return 'latin';
  if (max === cyrillic) return 'cyrillic';
  return 'thai';
}

/**
 * 这段歌词是不是「用空格分词」的语言（拉丁 / 西里尔）。
 *
 * 舞台把歌词切成字素（`Intl.Segmenter` granularity='grapheme'），空格本身也是一个 StageWord，
 * 所以按空格分组就能还原出词边界；CJK / 泰文没有空格，只能按字素或整行处理。
 */
export function usesWordSpaces(text: string): boolean {
  const kind = scriptKindOf(text);
  return kind === 'latin' || kind === 'cyrillic';
}

/* ------------------------------------------------------------------ *
 * 尺寸：视口 / 舞台
 * ------------------------------------------------------------------ */

export interface ViewSize {
  readonly width: number;
  readonly height: number;
}

/** 视口尺寸；窗口缩放 / 转向会重算（动效层的目标尺寸就是它）。 */
export function useViewportSize(): ViewSize {
  const [size, setSize] = useState<ViewSize>(() => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  }));
  useEffect(() => {
    const measure = (): void =>
      setSize((previous) =>
        previous.width === window.innerWidth && previous.height === window.innerHeight
          ? previous
          : { width: window.innerWidth, height: window.innerHeight },
      );
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);
  return size;
}

/**
 * 主题根节点的尺寸；首帧 / 量为 0 时回退视口尺寸。
 *
 * 配合 `styles/lyric-themes.css` 里把主题根节点撑到整个播放页的那组规则（负外边距抵消
 * `.pi-home__stage-lyrics` 的 padding），这里拿到的就恒等于播放页可视区域，
 * 粒子 / 光斑 / 云阶才真正铺满全屏（原来只有 `.pi-lyricstage` 那一条舞台盒子）。
 */
export function useFullStageSize<T extends HTMLElement>(ref: RefObject<T | null>): ViewSize {
  const measured = useElementSize(ref);
  const viewport = useViewportSize();
  return useMemo(
    () => ({
      width: measured.width > 0 ? measured.width : viewport.width,
      height: measured.height > 0 ? measured.height : viewport.height,
    }),
    [measured.width, measured.height, viewport.width, viewport.height],
  );
}

/** 舞台真实字体栈：canvas 度量必须和 DOM 用同一套字体，否则量出来的宽和渲染对不上。 */
export function useElementFontFamily<T extends HTMLElement>(ref: RefObject<T | null>): string {
  const [family, setFamily] = useState('system-ui, sans-serif');
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof getComputedStyle !== 'function') return;
    const read = (): void => {
      const value = getComputedStyle(element).fontFamily;
      if (value !== '') setFamily(value);
    };
    read();
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (fonts !== undefined) void fonts.ready.then(read);
  }, [ref]);
  return family;
}

/* ------------------------------------------------------------------ *
 * 颜色：跟随歌曲
 * ------------------------------------------------------------------ */

export interface ResolvedThemeColors {
  readonly primary: string;
  readonly accent: string;
  readonly surface: string;
  /**
   * **用户第 11 轮第 1 / 2 条**（原话：「心象浅色模式下，唱过的歌词应该是黑色」＋
   * 「浮名浅色模式下，唱过的歌词的黑色……应该和浅色模式下的流光的黑色一样」）：
   * 常态（未唱 / 唱过）歌词色 = **classic / partita / tilt / pendolo 在 CSS 里吃的那一支**
   * `--pi-lyric-ink`（`lyric-stage.css`：暗档 `#fff`、亮档 `var(--pi-text)` 近黑）。
   *
   * 为什么要把它解析出来：`fume` / `cadenza` 每帧都要用 `mixColor()` 混色，而它只认实色
   * （不认 `var()`），所以这两套主题原来各自造了一支 —— 亮档「白往黑推到够 3:1 就停」⇒ 中灰，
   * 于是同一屏上「流光的唱过字是近黑、浮名/心象的却是中灰」。现在两套直接吃这一支，
   * 六套主题的常态色**必然一致**（这正是主人第 2 条要的「和流光的黑色一样」）。
   */
  readonly ink?: string;
}

/**
 * 把「CSS 变量 → 主题 palette」串成一条链，用于写内联变量 / 取计算值。
 *
 * 坑：主题组件如果自己声明 `--pi-th-primary`，会**挡掉**祖先注入的同名值
 * （自定义属性照样遵循「局部声明优先于继承」）。所以主题侧一律写成
 * `var(--pi-th-primary, <palette 兜底值>)`，由最外层播放页决定最终颜色。
 */
export function cssVarChain(name: string, fallback: string): string {
  return `var(${name}, ${fallback})`;
}

/** 相对亮度（WCAG 2.x），用于对比度检查。 */
export function relativeLuminance(color: RgbColor): number {
  const channel = (value: number): number => {
    const v = clamp(value, 0, 255) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** 两色对比度（1~21）。 */
export function contrastRatio(a: RgbColor, b: RgbColor): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 保证前景在底色上仍然清晰：对比度不够就朝黑 / 白混，混到够为止。
 * 返回 Canvas 能直接用、也能塞进内联 `color` 的颜色串。
 */
export function ensureContrast(fg: RgbColor, bg: RgbColor, minRatio = 3): string {
  const fgText = `rgb(${Math.round(fg.r)}, ${Math.round(fg.g)}, ${Math.round(fg.b)})`;
  if (contrastRatio(fg, bg) >= minRatio) return fgText;
  const target: RgbColor =
    relativeLuminance(bg) > 0.42 ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  const targetText = `rgb(${target.r}, ${target.g}, ${target.b})`;
  let best = fgText;
  for (let amount = 0.25; amount <= 1.0001; amount += 0.25) {
    const candidate = mixColor(fgText, targetText, amount);
    const parsed = parseRgb(candidate);
    if (parsed === null) continue;
    best = candidate;
    if (contrastRatio(parsed, bg) >= minRatio) return candidate;
  }
  return best;
}

/** 解析一组「跟随歌曲」的主题色：`--pi-th-*` 优先，palette 兜底。 */
function resolveThemeColors(scope: HTMLElement | null, palette: LyricPalette): ResolvedThemeColors {
  return {
    primary: resolveCssColor(scope, cssVarChain('--pi-th-primary', palette.primaryColor)),
    accent: resolveCssColor(scope, cssVarChain('--pi-th-accent', palette.accentColor)),
    surface: resolveCssColor(scope, cssVarChain('--pi-th-surface', palette.backgroundColor)),
    /*
     * **用户第 11 轮第 1 / 2 条**：常态墨色直接读舞台那一支 `--pi-lyric-ink`（亮档 = `var(--pi-text)`），
     * 与 classic / partita / tilt / pendolo 用的是同一个事实来源 —— 不再各自造一支。
     * 解析不到（没有 DOM / 还没挂载）时留空串，由消费方退回自己的兜底。
     */
    ink: resolveCssColor(scope, 'var(--pi-lyric-ink, #fff)'),
  };
}

function sameThemeColors(a: ResolvedThemeColors, b: ResolvedThemeColors): boolean {
  return (
    a.primary === b.primary && a.accent === b.accent && a.surface === b.surface && a.ink === b.ink
  );
}

/**
 * 主题侧的颜色来源（任务书第 4 条）：优先读祖先注入的 `--pi-th-*`（播放页按当前歌曲注入），
 * 读不到再回退 palette prop。palette 变（换歌）或者祖先重写变量（取色完成 / 切亮暗）都会重算。
 *
 * 重算时机：palette 依赖变化 + MutationObserver 盯祖先的 `style` / `class` + 400ms 低频轮询兜底
 * + 字体就绪。解析结果**等值比较**后才 setState，所以 `--pi-sweep` 那种 ~4Hz 的祖先 style 写入
 * 不会造成无谓重渲染。
 */
export function useLiveThemeColors<T extends HTMLElement>(
  ref: RefObject<T | null>,
  palette: LyricPalette,
): ResolvedThemeColors {
  const [colors, setColors] = useState<ResolvedThemeColors>(() =>
    resolveThemeColors(null, palette),
  );
  useEffect(() => {
    const element = ref.current;
    const scope = element ?? (typeof document === 'undefined' ? null : document.documentElement);
    const read = (): void => {
      const next = resolveThemeColors(scope, palette);
      setColors((previous) => (sameThemeColors(previous, next) ? previous : next));
    };
    read();
    if (typeof MutationObserver === 'undefined' || element === null) return;
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme'],
    });
    let node: HTMLElement | null = element.parentElement;
    while (node !== null) {
      observer.observe(node, { attributes: true, attributeFilter: ['style', 'class'] });
      node = node.parentElement;
    }
    const timer = window.setInterval(read, 400);
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (fonts !== undefined) void fonts.ready.then(read);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [ref, palette.primaryColor, palette.accentColor, palette.backgroundColor]);
  return colors;
}

/**
 * 同上，但返回 ref：rAF 主题**每帧读 `current`**，换歌后立刻用上新色（不要闭包捕获成常量）。
 */
export function useResolvedThemeColors<T extends HTMLElement>(
  ref: RefObject<T | null>,
  palette: LyricPalette,
): { current: ResolvedThemeColors } {
  const colors = useLiveThemeColors(ref, palette);
  const colorsRef = useRef<ResolvedThemeColors>(colors);
  colorsRef.current = colors;
  return colorsRef;
}
