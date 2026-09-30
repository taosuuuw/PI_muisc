/**
 * 倾诉 = `tilt`（用户 m08768 第 4 条）。
 *
 * === AGPL 说明 ===
 * 数值借鉴自 folia-major 的 **tilt** 歌词主题（AGPL-3.0，`chthollyphile/folia-major@c249bde`），
 * **只取数值与思路**：下面每个表达式都是在本仓库里自己写的，没有拷贝 folia 源码文本。
 *
 * 观感：长句自动断成短行堆在一起，最多抽出一行变成斜体大字压在上面（像凑近低声重复了一句），
 * 唱到的字轻轻鼓一下、末尾留一点余光。
 *
 * 数值表（来自任务书 / folia 源码研究报告）：
 * - 断行：`normalized = log(字符数 + 4) / log(24)`、`jitter = frac(sin(seed × 1000 + 1) × 10000) × 0.6 + 0.7`、
 *   `score = normalized × jitter × 0.75`（`splitProbability` 0.75）；档位 `< 0.45` 一行、`< 1.05` 两行、
 *   `< 1.7` 三行、否则四行；只有省略号的行不拆。
 * - 排版：普通行字号 `clamp(3.125rem, 6.9vw, 9rem)`、字重 400、行高 1.35、字距 0.08em、不换行；
 *   斜体行字号 `clamp(57px, 7.9vw, 165px)`、字重 300、斜体、行高 1.25、字距 0.15em；
 *   `yOffset = 斜体字号 / 6`。（第十轮第 4 条按参考图重新标定：旧值是两条线**共用**
 *   `FONT_VW = 0.06875` 再各自被 90px 夹住，铺满后宽窗口下斜体行反而比普通行小；明细见下面常量那一组注释。）
 * - 进场：普通行 `{opacity 0, y 20px} → {1, 0}`、出场 `{opacity 0, y -12px}`，0.55s
 *   `cubic-bezier(0.25, 0.46, 0.45, 0.94)`；斜体行 `{opacity 0, y 24px, scale 0.92}`、出场
 *   `{y -16px, scale 0.95}`，0.6s 同曲线；换行时整块 0.45s easeInOut 淡入/淡出。
 * - 逐字素：`inline-block`、`opacity 0 → 1` 0.5s、`delay = 视觉序号 × 0.04`（普通行）/ `× 0.05`（斜体行）；
 *   斜体行的字素从 `±yOffset × 2` 落到 `±yOffset`（`index % 2 ? +1 : -1`）；
 *   空格用 `\u00A0`（`min-width` 0.25em / 0.35em）且不加延时。
 * - 逐字脉冲：`progress` 由 `positionMs` 与该字素所在词的起止时间算，`duration = clamp(词时长, 0.2, 0.9)`，
 *   `intensity = sin(progress × π)`，辉光在 `1.2 × duration` 内线性衰减到 **0.25 下限**；
 *   `scale = 1 + intensity × (斜体行 0.18 : 0.15)`，字素 `transition: transform 0.06s ease-out`。
 * - 最多一个斜体行：候选 = `frac(sin(seed × 1000 + 100 + i) × 10000) < 0.35` 的行，
 *   选中 `candidates[floor(frac(sin(seed × 1000 + 200) × 10000) × 候选数)]`；
 *   短尾行（≥2 段、≤2 字符且 `len × 2 ≤ 前一段`）字号 ×1.18。
 * - 自动缩放：`availableWidth = max(320, 容器宽) × 0.85`；最宽行 / 可用宽 > 1 时，
 *   ≥1.6 就重新拆成更多行（上限 4），否则整体缩放（下限斜体 0.5 / 普通 0.55）。
 * - 配色 4 种（默认「双色1」）：普通行 `primaryColor`、斜体行 `accentColor || primaryColor`。
 *   **无辉光、无渐变、无背景层**（唱到字的余光就是那 0.25 下限的极淡阴影）。
 *
 * 本仓库的取舍（都写进交付报告）：
 * - 不新增依赖：进场/段间/整块动画全是 CSS；逐字脉冲用**一个 rAF + ref 直接写 CSS 变量**，
 *   每帧不 setState；播放位置用 `usePositionClock` 在 store 的 ~4Hz 之间外推。
 * - 字号里的「窗口宽」换成**容器宽**（播放页把歌词区铺满整页，两者接近，但容器宽才是真的舞台宽）。
 *   第十轮第 4 条起 `lyric-themes.css` 里多了一条 `.pi-lyricstage[data-theme='tilt']` 的
 *   `position: absolute; inset: 0` 舞台规则，容器宽现在真的等于**整页宽 − `.pi-lyrictilt` 自己的
 *   `padding: 2rem`（左右各 32px）**，不再被 `.pi-lyricstage` 的 `max-width: 560px` 卡住，这条取舍没有折扣了。
 * - 断行点：任务书没给「怎么切」，这里是自己写的——先按档位等分，再在 ±1 个字符内往标点/空格后靠。
 * - 4 种配色方案里只启用默认的「双色1」（设置页没有配色开关；另外三种写在 `TILT_COLOR_SCHEMES` 里备查）。
 */

import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import {
  HINT_LOOKAHEAD,
  clamp,
  createFrameGate,
  estimateTextWidth,
  seededFraction,
  tuningOf,
  useElementSize,
  usePositionClock,
  usePrefersReducedMotion,
  wordStatesFor,
  type LyricThemeProps,
  type StageLine,
  type StageWord,
  type WordState,
} from './types';

/** 只按 16px 根字号换算 rem（浏览器的默认值，仓库没有改 html 字号）。 */
const REM_PX = 16;
/**
 * 字号标定（第十轮第 4 条「以整个 app 界面作为展示舞台」+ 参考图实测
 * `6275ac15…png`，1518×1018：上行深色正常体 `Oh it's`、下行红色斜体 `going down`）。
 *
 * 前提变了：舞台铺满之后 `size.width` 就是**整页宽**（见 lyric-themes.css 里
 * `.pi-lyricstage[data-theme='tilt']` 那条规则），所以下面这两条 vw 系数直接照参考图的像素量。
 *
 * 参考图实测（1518px 宽的窗口里逐像素量的）：
 * - 正常行 `Oh it's`：`O` 大写高 84px（y 393→476）、`h` 上伸 86px、`s` x-height 60px（417→476），
 *   x-height / 大写 = 0.714，与系统 sans（x 0.50em / cap 0.70em）吻合 ⇒ 参考图那一行约 120px；
 *   父代理给的观感口径是「正常行字高约 72px」，而 6.9vw 在 1518px 下渲染出 105px 字号 /
 *   约 73px 大写高，正对那一档 ⇒ 正常行取 6.9vw。
 * - 斜体行 `going down`：`d` 上伸→`g` 降部墨迹 119px（y 529→647）、`o` x-height 61px
 *   ⇒ 参考图那一行约 120–127px ≈ 7.9vw；铺满之后按 7.9vw 走（1518px 下 120px），
 *   比正常行大 15%，连同 0.15em 字距与更轻的字重，就是参考图里「斜体行明显更大」的观感。
 *
 * 上下限为什么要重定：旧值（下限 3.125rem = 50px、普通行上限 5.625rem = 90px、斜体上限 90px）
 * 是给「560px 小盒子」定的——在那个盒子里普通行被下限夹到 50px，斜体行 `min(宽 × 0.06875, 90)`
 * 只剩 38px，于是斜体**比普通行还小**。铺满整页后按 1518px 的约 1.4 倍留余量：
 * 普通行 9rem = 144px、斜体行 165px（= 144 × 7.9 / 6.9，上限同比例，斜体永远比普通行大一档）；
 * 上限只在大窗口（宽 > 2000px）才吃得到，作用是「超宽屏别无限放大」。
 */
const NORMAL_MIN_PX = 3.125 * REM_PX;
const NORMAL_MAX_PX = 9 * REM_PX;
/** 普通行的字号系数：`clamp(3.125rem, 6.9vw, 9rem)` 里的 6.9vw（旧值 6.875vw + 上限 5.625rem）。 */
const FONT_VW = 0.069;
/** 斜体行的字号系数：参考图实测约 7.9vw（比普通行的 6.9vw 大 15%）。 */
const ITALIC_VW = 0.079;
/** 斜体行字号的下限 / 上限（旧值只有上限 90px、没有下限）：与普通行同一比例 7.9 : 6.9 ≈ 1.145，
 *  即 50 × 1.145 ≈ 57px、144 × 1.145 ≈ 165px，保证任何窗口宽度下斜体行都明显大于普通行。 */
const ITALIC_MIN_PX = 57;
const ITALIC_MAX_PX = 165;
/** 斜体行字号上限/下限与普通行的缩放下限。 */
const SCALE_FLOOR_ITALIC = 0.5;
const SCALE_FLOOR_NORMAL = 0.55;

/**
 * 4 种配色方案（folia 的 `colorSchemes`）：前两组是双色，后两组是单色。
 * 现在只用第一组——设置页没给配色开关，写在这儿是为了以后接。
 */
export const TILT_COLOR_SCHEMES = ['dual-1', 'dual-2', 'mono-accent', 'mono-primary'] as const;

interface TiltGlyphPlan {
  /** 行内字素序号（全局，跨段累计）——逐字素延时与脉冲都按它排。 */
  readonly index: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly delayMs: number;
  readonly isSpace: boolean;
  readonly dropFrom: number;
  readonly dropTo: number;
}

interface TiltPartPlan {
  readonly text: string;
  readonly italic: boolean;
  readonly fontPx: number;
  readonly glyphs: readonly TiltGlyphPlan[];
}

/** 断点：按词数等分（不吃标点/空格，与 folia 的分块抖动不同）；`_seed` 保留签名但本轮未用。 */
function splitParts(words: readonly StageWord[], _seed: number, count: number): number[][] {
  const total = words.length;
  if (total === 0) return [];
  const parts: number[][] = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    if (i === count - 1) {
      parts.push(words.slice(cursor).map((_word, offset) => cursor + offset));
      break;
    }
    const remaining = total - cursor;
    const left = count - i;
    let size = clamp(Math.round(remaining / left), 1, remaining - (left - 1));
    const limit = remaining - (left - 1);
    for (const candidate of [size, size + 1, size - 1]) {
      if (candidate < 1 || candidate > limit) continue;
      const previous = words[cursor + candidate - 1];
      if (previous !== undefined && /[\s,，.。!！?？;；:：、…—]/.test(previous.text)) {
        size = candidate;
        break;
      }
    }
    parts.push(words.slice(cursor, cursor + size).map((_word, offset) => cursor + offset));
    cursor += size;
  }
  return parts;
}

/** 档位：任务书的三段阈值。 */
function targetPartCount(textLength: number, seed: number): number {
  const normalized = Math.log(textLength + 4) / Math.log(24);
  const jitter = seededFraction(seed * 1000 + 1) * 0.6 + 0.7;
  const score = normalized * jitter * 0.75;
  if (score < 0.45) return 1;
  if (score < 1.05) return 2;
  if (score < 1.7) return 3;
  return 4;
}

/** 最多抽一个斜体段：候选过滤 + 确定性选一个。 */
function pickItalicIndex(partCount: number, seed: number): number {
  const candidates: number[] = [];
  for (let i = 0; i < partCount; i += 1) {
    if (seededFraction(seed * 1000 + 100 + i) < 0.35) candidates.push(i);
  }
  if (candidates.length === 0) return -1;
  const pick = clamp(Math.floor(seededFraction(seed * 1000 + 200) * candidates.length), 0, candidates.length - 1);
  return candidates[pick] ?? -1;
}

/** 每段字号（含短尾 ×1.18）。 */
function fontSizesFor(
  parts: readonly number[][],
  italicIndex: number,
  normalPx: number,
  italicPx: number,
  words: readonly StageWord[],
): number[] {
  const sizes = parts.map((_part, index) => (index === italicIndex ? italicPx : normalPx));
  if (parts.length >= 2) {
    const lastIndex = parts.length - 1;
    const last = parts[lastIndex];
    const previous = parts[lastIndex - 1];
    if (last !== undefined && previous !== undefined && last.length <= 2 && last.length * 2 <= previous.length) {
      sizes[lastIndex] = (sizes[lastIndex] ?? normalPx) * 1.18;
    }
  }
  // words 只用于给闭包一个稳定的形状，避免 lint 抱怨未使用；真实文本从 parts 索引取。
  void words;
  return sizes;
}

function partText(part: readonly number[], words: readonly StageWord[]): string {
  let text = '';
  for (const index of part) text += words[index]?.text ?? '';
  return text;
}

function buildPlan(
  line: StageLine,
  containerWidth: number,
  fontScale: number,
): TiltPartPlan[] {
  const words = line.words;
  if (words.length === 0) return [];
  const seed = line.timeMs;
  const viewport = containerWidth > 0 ? containerWidth : window.innerWidth;
  // 字号乘设置的 `fontScale`，两条 clamp 的上下限（含 `ITALIC_MIN_PX` / `ITALIC_MAX_PX`）跟着一起乘：
  // 只乘不放上限的话，宽视口下本来就被夹住的那一档会完全无视这个旋钮。放大之后下面
  // 那个 `ratio` / `globalScale` 会按**真实测量宽度**把整段压回 `available` 内，
  // 所以字号调大不会让句子捅出播放页，只会让它更满。
  const normalPx = clamp(NORMAL_MIN_PX, viewport * FONT_VW, NORMAL_MAX_PX) * fontScale;
  const italicPx = clamp(ITALIC_MIN_PX, viewport * ITALIC_VW, ITALIC_MAX_PX) * fontScale;
  const available = Math.max(320, containerWidth > 0 ? containerWidth : window.innerWidth) * 0.85;

  let parts = splitParts(words, seed, targetPartCount(words.length, seed));
  let italicIndex = pickItalicIndex(parts.length, seed);
  let sizes = fontSizesFor(parts, italicIndex, normalPx, italicPx, words);

  const ratioOf = (candidate: readonly number[][], candidateSizes: readonly number[]): number => {
    let widest = 0;
    candidate.forEach((part, index) => {
      const size = candidateSizes[index] ?? normalPx;
      const spacing = index === italicIndex ? 0.15 : 0.08;
      widest = Math.max(widest, estimateTextWidth(partText(part, words), size, spacing));
    });
    return widest / available;
  };

  let ratio = ratioOf(parts, sizes);
  // 太宽（≥1.6）优先重排成更多段（上限 4 段），重排后再看。
  if (ratio >= 1.6 && parts.length < 4) {
    for (let count = parts.length + 1; count <= 4; count += 1) {
      const wider = splitParts(words, seed, count);
      const widerItalic = pickItalicIndex(wider.length, seed);
      const widerSizes = fontSizesFor(wider, widerItalic, normalPx, italicPx, words);
      parts = wider;
      italicIndex = widerItalic;
      sizes = widerSizes;
      ratio = ratioOf(parts, sizes);
      if (ratio < 1.6) break;
    }
  }

  const globalScale = ratio > 1 ? 1 / ratio : 1;
  const plans: TiltPartPlan[] = [];
  let visualIndex = 0;
  parts.forEach((part, partIndex) => {
    const italic = partIndex === italicIndex;
    const rawSize = sizes[partIndex] ?? normalPx;
    const fontPx = rawSize * Math.max(italic ? SCALE_FLOOR_ITALIC : SCALE_FLOOR_NORMAL, globalScale);
    const yOffset = italic ? fontPx / 6 : 0;
    const glyphs: TiltGlyphPlan[] = part.map((wordIndex) => {
      const word = words[wordIndex];
      const isSpace = word !== undefined && /^\s+$/.test(word.text);
      const drop = italic && !isSpace ? (wordIndex % 2 === 0 ? -1 : 1) : 0;
      const glyph: TiltGlyphPlan = {
        index: wordIndex,
        text: word?.text ?? '',
        startMs: word?.startMs ?? 0,
        endMs: word?.endMs ?? 0,
        delayMs: isSpace ? 0 : visualIndex * (italic ? 50 : 40),
        isSpace,
        dropFrom: drop * yOffset * 2,
        dropTo: drop * yOffset,
      };
      visualIndex += 1;
      return glyph;
    });
    plans.push({ text: partText(part, words), italic, fontPx, glyphs });
  });
  return plans;
}

interface TiltBlockProps {
  readonly plan: readonly TiltPartPlan[];
  readonly line: StageLine;
  readonly states: readonly WordState[] | undefined;
  readonly active: boolean;
  readonly phase: 'enter' | 'exit';
  readonly translatedText: string | undefined;
  readonly registerWord: (index: number, element: HTMLElement | null) => void;
}

function TiltBlock({
  plan,
  line,
  states,
  active,
  phase,
  translatedText,
  registerWord,
}: TiltBlockProps): ReactNode {
  return (
    <div
      className="pi-lyrictilt__block"
      data-lyric-line
      data-index={line.index}
      data-active={active}
      data-hint={line.hint}
      data-phase={phase}
    >
      <div className="pi-lyrictilt__parts">
        {plan.map((part, partIndex) => (
          <div
            key={`${partIndex}-${part.text}`}
            className="pi-lyrictilt__part"
            data-italic={part.italic}
            style={{ fontSize: `${part.fontPx.toFixed(2)}px` }}
          >
            {part.glyphs.map((glyph) => (
              <span
                key={glyph.index}
                ref={(element) => {
                  registerWord(glyph.index, element);
                }}
                className="pi-lyricstage__word pi-lyrictilt__word"
                data-space={glyph.isSpace}
                data-word-state={states?.[glyph.index] ?? 'passed'}
                style={
                  {
                    '--pi-tilt-delay': `${glyph.delayMs}ms`,
                    '--pi-tilt-drop-from': `${glyph.dropFrom.toFixed(2)}px`,
                    '--pi-tilt-drop-to': `${glyph.dropTo.toFixed(2)}px`,
                  } as CSSProperties
                }
              >
                <span className="pi-lyrictilt__glyph">{glyph.isSpace ? '\u00A0' : glyph.text}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
      {translatedText === undefined || translatedText === '' ? null : (
        <p className="pi-lyrictilt__translated">{translatedText}</p>
      )}
    </div>
  );
}

/**
 * 倾诉主题。
 *
 * 逐字脉冲：一个 rAF 循环按 `usePositionClock` 外推出的当前位置，把每个字素的
 * `--pi-tilt-glow` / `--pi-tilt-scale` 直接写到 DOM 上（不 setState）。
 */
export function TiltTheme(props: LyricThemeProps): ReactNode {
  const { lines, translated, activeIndex, viewIndex, leavingIndex, positionMs, theme } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLElement | null)[]>([]);
  const size = useElementSize(rootRef);
  const clock = usePositionClock(positionMs);
  const reduced = usePrefersReducedMotion();
  const anchor = lines[viewIndex];
  // 设置的动效参数：字号进 buildPlan 的上限换算，帧率上限进下面的 rAF。
  const { fontScale, fpsCap } = tuningOf(theme);
  const plan = useMemo(
    () => (anchor === undefined ? [] : buildPlan(anchor, size.width, fontScale)),
    [anchor, size.width, fontScale],
  );
  const wordTimes = useMemo(
    () =>
      plan.flatMap((part) =>
        part.glyphs.map((glyph) => ({
          index: glyph.index,
          startMs: glyph.startMs,
          endMs: glyph.endMs,
          italic: part.italic,
        })),
      ),
    [plan],
  );
  const leaving =
    leavingIndex === null || leavingIndex === undefined || leavingIndex === viewIndex
      ? undefined
      : lines[leavingIndex];
  const leavingPlan = useMemo(
    () => (leaving === undefined ? [] : buildPlan(leaving, size.width, fontScale)),
    [leaving, size.width, fontScale],
  );

  useEffect(() => {
    if (reduced || wordTimes.length === 0) return undefined;
    // 帧率上限的门用 `performance.now()`，**不能**用 `clock.current()`：后者是歌词播放
    // 位置的外推值，暂停 / 拖进度条时会停住甚至倒退，拿它算帧间隔会漏帧或永远不通过。
    const frameGate = createFrameGate(fpsCap);
    let frame = 0;
    const tick = (): void => {
      // 没通过就整帧跳过（不写任何 CSS 变量），只把 rAF 链接下去。
      // `fpsCap === 'off'` 时 frameGate 恒为 true，与加这个旋钮之前完全一致。
      if (!frameGate(performance.now())) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      const now = clock.current();
      for (const word of wordTimes) {
        const element = wordRefs.current[word.index];
        if (element === null || element === undefined) continue;
        const durationMs = clamp(word.endMs - word.startMs, 200, 900);
        const elapsed = now - word.startMs;
        let glow: number;
        if (elapsed <= 0) glow = 0.25;
        else if (elapsed <= durationMs) glow = 0.25 + 0.75 * Math.sin((elapsed / durationMs) * (Math.PI / 2));
        else glow = Math.max(0.25, 1 - (elapsed - durationMs) / (1.2 * durationMs));
        const progress = clamp(elapsed / durationMs, 0, 1);
        const intensity = Math.sin(progress * Math.PI);
        const bump = word.italic ? 0.18 : 0.15;
        element.style.setProperty('--pi-tilt-glow', glow.toFixed(3));
        element.style.setProperty('--pi-tilt-scale', (1 + intensity * bump).toFixed(3));
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [clock, fpsCap, reduced, wordTimes]);

  if (anchor === undefined) return null;

  const lookahead = HINT_LOOKAHEAD[anchor.hint];
  const states = wordStatesFor(anchor, positionMs, lookahead);
  const registerWord = (index: number, element: HTMLElement | null): void => {
    wordRefs.current[index] = element;
  };

  return (
    <div
      className="pi-lyrictilt"
      ref={rootRef}
      style={
        {
          // 默认「双色1」：普通行 primaryColor、斜体行 accentColor（没有就退回 primary）。
          '--pi-tilt-normal': theme.primaryColor,
          '--pi-tilt-italic': theme.accentColor === '' ? theme.primaryColor : theme.accentColor,
        } as CSSProperties
      }
    >
      {leavingPlan.length === 0 ? null : (
        <TiltBlock
          key={`out-${leaving?.index ?? -1}-${leaving?.timeMs ?? 0}`}
          plan={leavingPlan}
          line={leaving ?? anchor}
          states={undefined}
          active={false}
          phase="exit"
          translatedText={undefined}
          registerWord={registerWord}
        />
      )}
      <TiltBlock
        key={`in-${anchor.index}-${anchor.timeMs}`}
        plan={plan}
        line={anchor}
        states={states}
        active={activeIndex === viewIndex}
        phase="enter"
        translatedText={translated.get(anchor.timeMs)}
        registerWord={registerWord}
      />
    </div>
  );
}
