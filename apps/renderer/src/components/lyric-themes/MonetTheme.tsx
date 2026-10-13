/**
 * 莫奈 = `monet`（folia-major 的 `src/components/visualizer/monet/`）。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**（`chthollyphile/folia-major@main`）。这里**只借鉴数值与做法**：
 * 版式比例、字号公式、行三态、间距、扫光几何、辉光包络、装饰粒子分布、音频条形状都在
 * `monetLayout.ts` 里逐条注明出处，**每一个表达式都是在本仓库里重新写的**，没有拷贝 folia 源码文本。
 *
 * === 版式（folia: VisualizerMonet.tsx:174-537） ===
 * 一横行：**左列**（艺人 → 竖线 → 歌名 → 专辑 → 歌词轨道）+ **右列肖像**（方形 / 竖构图两种），
 * 左下角一条音频波形，整屏还有十个飘着的花瓣。左列的宽高比例、字号 clamp、肖像尺寸上限、
 * 一行的入场时序（艺人 0.15s / 竖线 0.5s / 歌名 0.3s / 轨道 0.65s，都走 `[0.25,1,0.5,1]`）
 * 都照它的数值。
 *
 * === 与 folia 的结构差异（写清楚，免得以后拿它当 1:1） ===
 * 1. **不做滚轮浏览**：folia 的轨道自己吃滚轮（`MONET_SCROLL_STEP_PX 72`、空闲 1.8s 回当前句），
 *    但本仓库用户明确要求「只允许时计（pendolo）的歌词动效可以滚轮滑动查看不同歌词」
 *    （`LyricStage.tsx` 的 `WHEEL_BROWSE_THEMES`）。莫奈因此**只有跟随播放这一种走法**。
 * 2. **不在行内画译文**：folia 的莫奈把翻译排在行内（`subtitleTracks`），但本仓库用户要求
 *    「所有的歌词动效的翻译歌词都设置在进度条部件的上面，并且一次只显示一句」，
 *    译文已收归 `LyricStage` 的统一字幕层。莫奈只画原文。
 * 3. folia 用 framer-motion 的 spring 驱动位移；这里用 CSS 过渡（参数见 `monetLayout.ts` 的注释）。
 * 4. 音频条读的是**伪频谱**（本仓库没有 WebAudio，见 `lib/audio-bands.ts`），形状算法照它的。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  HINT_LOOKAHEAD,
  clamp,
  createFrameGate,
  isChorusLine,
  measureTextWidth,
  rgba,
  seededFraction,
  tuningOf,
  useElementFontFamily,
  useElementSize,
  useLiveThemeColors,
  usePositionClock,
  usePrefersReducedMotion,
  wordColorOf,
  wordStatesFor,
  type LyricThemeProps,
  type StageLine,
} from './types';
import { resolveMonetWashCssVars } from './monetWash';
import { MONET_DRIFT_DEFAULT, resolveMonetBackgroundDriftStyle } from './monetDrift';
import { monetBackgroundTuningFor, resolveMonetBackgroundDataUrl } from './monetBackground';
import { useSettings } from '../../lib/queries';
import type { LyricFpsCap } from '@pi/shared';
import {
  MONET_AUDIO_BAR_COUNT,
  MONET_PORTRAIT_FADE_MS,
  MONET_PORTRAIT_MAX_LAYERS,
  buildMonetDecorParticles,
  estimateMonetWrappedLines,
  monetBarHeight,
  monetSweepMaskImage,
  pseudoMonetBands,
  resolveMonetFillWidth,
  resolveMonetFontPx,
  resolveMonetGlow,
  resolveMonetGlowRadii,
  resolveMonetInactiveScale,
  resolveMonetLargeScreenScale,
  resolveMonetLineTone,
  resolveMonetRailHeightPx,
  resolveMonetRailWidthPx,
  resolveMonetSweepEdgeSoftness,
  resolveMonetSweepGeometry,
  sampleMonetSpectrumProfile,
  type MonetLineStatus,
} from './monetLayout';

/** 一行的字重（folia: `resolveThemeFontWeight(theme, 600)`；本仓库主题字重固定 600）。 */
const MONET_LYRIC_FONT_WEIGHT = 600;
/** 行高相对字号的比例（folia: 轨道高度上限用的就是 `lyricFontPx * 1.18 * 行数`）。 */
const MONET_LINE_HEIGHT_RATIO = 1.18;
/** 辉光缓冲：行盒上下各留这么多，扫光层与辉光才不会被 `overflow: hidden` 切掉。 */
const MONET_GLOW_BUFFER_RATIO = 1.2;
/** 扫光层往外撑的比例（folia: `sweepOverflowPx = round(fontPx * 0.5)`）。 */
const MONET_SWEEP_OVERFLOW_RATIO = 0.5;
/**
 * 真·列表滚动（主人本轮第 1 条）里行与行之间的留白，按行高的比例算。
 *
 * 行距本身是「整首歌最高那行 + 这段留白」（见 `slotPx` 的推导）：0.28 大约是行高的四分之一，
 * 相邻两句既能看出是两行、又不会显得散。想更紧凑/更透气就调这一个数。
 */
const MONET_SLOT_GAP_RATIO = 0.28;
/** 伪能量（`lib/audio-bands.ts` 的公式，输入换成 `StageLine`）。 */
const MONET_ENERGY_BASE = 0.3;
const MONET_ENERGY_SHORT_BONUS = 0.25;
const MONET_ENERGY_CHORUS_BONUS = 0.35;
const MONET_ENERGY_JITTER = 0.12;
const MONET_MIN_LINE_MS = 400;
const MONET_MAX_LINE_MS = 12000;
const MONET_FALLBACK_LINE_MS = 4000;

interface MonetRailEntry {
  readonly index: number;
  readonly line: StageLine;
  readonly offset: number;
  readonly status: MonetLineStatus;
  readonly chorus: boolean;
}

/** 这一行的伪能量（0~1）：行越短、命中副歌越高，另加一点种子抖动。 */
function monetEnergy(
  entry: MonetRailEntry,
  lines: readonly StageLine[],
  seed: number,
): number {
  const next = lines[entry.index + 1];
  const raw = next === undefined ? MONET_FALLBACK_LINE_MS : next.timeMs - entry.line.timeMs;
  const duration = clamp(raw > 0 ? raw : MONET_FALLBACK_LINE_MS, MONET_MIN_LINE_MS, MONET_MAX_LINE_MS);
  const shortness = 1 - duration / MONET_MAX_LINE_MS;
  const jitter = (seededFraction(seed + entry.index * 97) - 0.5) * 2 * MONET_ENERGY_JITTER;
  return clamp(
    MONET_ENERGY_BASE +
      shortness * MONET_ENERGY_SHORT_BONUS +
      (entry.chorus ? MONET_ENERGY_CHORUS_BONUS : 0) +
      jitter,
    0,
    1,
  );
}

/** 把字素按「词」分组（`StageWord.wordStart` 是舞台给的词边界；没有空格字素时它是唯一依据）。 */
function groupMonetWords(line: StageLine): number[][] {
  const groups: number[][] = [];
  line.words.forEach((word, index) => {
    if (word.wordStart === true || groups.length === 0) groups.push([index]);
    else groups[groups.length - 1]?.push(index);
  });
  return groups;
}

/* ------------------------------------------------------------------ *
 * 音频条（folia: AudioOverlay）
 * ------------------------------------------------------------------ */

function MonetAudioBar({
  entries,
  lines,
  seed,
  primaryColor,
  fpsCap,
  reduced,
}: {
  readonly entries: readonly MonetRailEntry[];
  readonly lines: readonly StageLine[];
  readonly seed: number;
  /** **实色**（Canvas 画不了 `var()`）；调用方给的是 `useLiveThemeColors` 解析出来的 rgb。 */
  readonly primaryColor: string;
  readonly fpsCap: LyricFpsCap;
  readonly reduced: boolean;
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bandRef = useRef(0);
  // 每帧只读一次「当前句」，重渲染不重启循环（依赖里放 entries/lines 的稳定值）。
  const stateRef = useRef({ entries, lines, seed, primaryColor });
  stateRef.current = { entries, lines, seed, primaryColor };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const context = canvas.getContext('2d');
    if (context === null) return undefined;

    let frame = 0;
    let width = 0;
    let height = 0;
    const gate = createFrameGate(fpsCap);

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const nextWidth = Math.max(1, Math.floor(rect.width * dpr));
      const nextHeight = Math.max(1, Math.floor(rect.height * dpr));
      width = rect.width;
      height = rect.height;
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (): void => {
      if (width <= 0 || height <= 0) return;
      const current = stateRef.current;
      context.clearRect(0, 0, width, height);
      const active = current.entries.find((entry) => entry.status === 'active');
      const energy = active === undefined ? 0.2 : monetEnergy(active, current.lines, current.seed);
      // 频带做一阶低通（folia 的 smoothingAlpha 约 0.1），免得换句时柱子整排跳一下。
      bandRef.current += (energy - bandRef.current) * 0.12;
      const bands = pseudoMonetBands(bandRef.current, current.seed + (active?.index ?? 0));
      /*
       * Canvas 只认实色：`useLiveThemeColors` 在**首帧**（主题根还没挂载，没有可探测的元素）
       * 会把 `var(--pi-th-primary, …)` 原样返回，而 `createLinearGradient().addColorStop()`
       * 拿到 `var()` 会**抛异常**。实测后果不只是「这一帧没画」——异常从 rAF 回调里冒出去，
       * 后面那行 `requestAnimationFrame(loop)` 根本执行不到，音频条**整条永久停摆**
       *（冒烟量到「有墨像素=0（三轮 0/0/0）」就是这个）。所以这里守一道：不是实色就用白色兜底，
       * 下一帧颜色解析好了自然换回主题色。
       */
      const rawPrimary = current.primaryColor.trim();
      const primary = /^rgba?\(/i.test(rawPrimary) ? rawPrimary : '#ffffff';
      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, rgba(primary, 0.72));
      gradient.addColorStop(0.5, rgba(primary, 0.94));
      gradient.addColorStop(1, rgba(primary, 0.72));
      context.fillStyle = gradient;
      context.strokeStyle = gradient;
      context.lineWidth = 1.5;
      context.lineCap = 'round';
      const bars = MONET_AUDIO_BAR_COUNT;
      const gap = width / bars;
      for (let index = 0; index < bars; index += 1) {
        const t = index / (bars - 1);
        const band = sampleMonetSpectrumProfile(bands, t);
        const pulse = Math.sin(index * 0.45 + performance.now() * 0.006) * 0.5 + 0.5;
        const barHeight = monetBarHeight(height, t, band, bandRef.current, pulse);
        context.fillRect(index * gap + gap * 0.14, height - barHeight, Math.max(1.35, gap * 0.34), barHeight);
      }
    };

    resize();
    window.addEventListener('resize', resize);
    if (reduced) {
      draw();
      return () => window.removeEventListener('resize', resize);
    }
    const loop = (): void => {
      if (gate(performance.now())) {
        /*
         * 单帧异常不能打断循环：颜色 / 尺寸上的任何一次意外只该丢一帧，
         * 不该让整条音频波形永久停摆（上面那道实色守卫是这个坑的第一道防线，这里是第二道）。
         */
        try {
          draw();
        } catch {
          /* 丢这一帧，下一帧继续。 */
        }
      }
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, [fpsCap, reduced]);

  return <canvas ref={canvasRef} className="pi-lyricmonet__audiocanvas" />;
}

/* ------------------------------------------------------------------ *
 * 肖像（folia: MonetPortraitImage + monetPortraitCrossfade）
 * ------------------------------------------------------------------ */

function MonetPortrait({ src }: { readonly src: string | undefined }): ReactNode {
  const [layers, setLayers] = useState<readonly { key: string; src: string }[]>([]);
  const keyRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (src === undefined || src === '') return undefined;
    let cancelled = false;
    const stack = (): void => {
      if (cancelled) return;
      setLayers((current) => {
        if ((current[current.length - 1]?.src ?? '') === src) return current;
        keyRef.current += 1;
        const next = [...current, { key: `monet-portrait-${keyRef.current}`, src }];
        return next.length > MONET_PORTRAIT_MAX_LAYERS
          ? next.slice(next.length - MONET_PORTRAIT_MAX_LAYERS)
          : next;
      });
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      // 顶层完全不透明之后再丢掉下面的旧封面（folia: settleMonetPortraitLayers）。
      timerRef.current = window.setTimeout(() => {
        setLayers((current) => {
          const index = current.findIndex((layer) => layer.src === src);
          return index <= 0 ? current : current.slice(index);
        });
      }, MONET_PORTRAIT_FADE_MS);
    };
    // 先在离屏元素上解码：解不出来（失效 blob / 404）就保留当前封面，不留空框。
    const loader = new Image();
    loader.decoding = 'async';
    loader.src = src;
    if (typeof loader.decode === 'function') loader.decode().then(stack, () => undefined);
    else loader.onload = stack;
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <div className="pi-lyricmonet__portraitinner">
      {layers.map((layer) => (
        <img
          key={layer.key}
          className="pi-lyricmonet__portraitimg"
          src={layer.src}
          alt=""
          draggable={false}
          decoding="async"
          data-monet-portrait-image
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 主题
 * ------------------------------------------------------------------ */

export function MonetTheme(props: LyricThemeProps): ReactNode {
  const {
    lines,
    activeIndex,
    viewIndex,
    viewAnchor,
    positionMs,
    playing,
    theme,
    coverUrl,
    songTitle,
    songArtist,
    songAlbum,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(rootRef);
  const railSize = useElementSize(railRef);
  const clock = usePositionClock(positionMs, playing ?? true);
  const reduced = usePrefersReducedMotion();
  const { fontScale, fpsCap, glowIntensity, backgroundGlow } = tuningOf(theme);
  const colors = useLiveThemeColors(rootRef, theme);
  const fontFamily = useElementFontFamily(rootRef);

  const layoutScale = resolveMonetLargeScreenScale(size.width, size.width);
  /*
   * ⚠ **上游默认倍率**：`DEFAULT_MONET_TUNING.fontScale = 1.2`，
   * 而上游的基准 clamp（`1.08/2/1.48`、`0.94/1.28/1.14`）与我们 `monetLayout.ts` 里的**完全相同**
   * （`monet__VisualizerMonet.tsx:144~146`）⇒ 这 1.2 **就是真实的字号差**，不是"已摊进基准"。
   * 之所以乘在这里而**不改共享的 `DEFAULT_LYRIC_TUNING.fontScale`**：那个参数多主题共用
   * （partita/tilt 也吃它），改它会顺带动别的主题 —— 属范围外改动。
   */
  const MONET_UPSTREAM_FONT_SCALE = 1.2;
  const fonts = resolveMonetFontPx(size.width, fontScale * MONET_UPSTREAM_FONT_SCALE, layoutScale);
  const railMaxWidthPx = resolveMonetRailWidthPx(layoutScale);
  const railMaxHeightPx = resolveMonetRailHeightPx(fonts.lyric, layoutScale);
  const glowBufferPx = Math.round(fonts.lyric * MONET_GLOW_BUFFER_RATIO);
  const sweepOverflowPx = Math.round(fonts.lyric * MONET_SWEEP_OVERFLOW_RATIO);
  const lineHeightPx = Math.ceil(fonts.lyric * MONET_LINE_HEIGHT_RATIO);
  const inactiveScale = resolveMonetInactiveScale(fonts.inactive, fonts.lyric);

  /**
   * 锚点：**连续**值（主人本轮第 1 条「真·列表滚动」）。
   *
   * `viewIndex` 是整数（滚一格跳一行），拿整数排位置只能「一格重排一次」；`viewAnchor` 是
   * 滚轮按像素累积出来的小数位置，用它排位置一行一行才是**滑**过去的。
   * 主进程与冒烟读的仍是整数 `viewIndex`（`data-view-index`）；没有 `viewAnchor`
   * （别的主题、老调用点）就退回整数锚点 —— 行为与改动前一致。
   */
  const anchorFloat = clamp(viewAnchor ?? viewIndex, 0, Math.max(lines.length - 1, 0));
  /** 状态判定（当前句 / 唱过 / 没唱）按**整行**来，所以这里取整。 */
  const anchorIndex = Math.round(anchorFloat);
  const statusActiveIndex = activeIndex >= 0 ? activeIndex : anchorIndex;

  /**
   * 窗口放宽到 ±3（原来 ±2）：连续滚动时上下各留一行「马上要进来」的，滑动才有来处与去处
   * —— 边缘那几行由轨道的上下渐隐遮罩（`lyric-monet.css` 的 `mask-image`）吃掉。
   * 边界用**整数**锚点算，所以连续滚动期间这个 memo 不会每帧重算（下面的量文本很贵）。
   */
  const entries = useMemo<MonetRailEntry[]>(() => {
    const result: MonetRailEntry[] = [];
    const start = Math.max(0, anchorIndex - 3);
    const end = Math.min(lines.length - 1, anchorIndex + 3);
    for (let index = start; index <= end; index += 1) {
      const line = lines[index];
      if (line === undefined) continue;
      const status: MonetLineStatus =
        index === statusActiveIndex
          ? 'active'
          : index < statusActiveIndex
            ? 'passed'
            : 'waiting';
      // `offset` 存**整数**距离（只用于兜底/调试）；真正决定观感的是下面的连续 `anchorFloat`。
      result.push({
        index,
        line,
        offset: index - anchorIndex,
        status,
        chorus: isChorusLine(lines, index),
      });
    }
    return result;
  }, [anchorIndex, lines, statusActiveIndex]);

  /**
   * 一行的**自然**视觉高度（折行行数 × 行高 + 上下扫光余量），与「哪一行在中间」无关。
   * 单独抽出来是因为下面要量两拨：窗口里那几行（定位用）与整首歌（算行距用）。
   */
  const measureNaturalHeight = useCallback(
    (line: StageLine, contentWidth: number): number => {
      const graphemeWidths = line.words.map((word) =>
        measureTextWidth(word.text, fonts.lyric, MONET_LYRIC_FONT_WEIGHT, fontFamily, 0),
      );
      const wordWidths = groupMonetWords(line).map((group) =>
        group.reduce((total, index) => total + (graphemeWidths[index] ?? 0), 0),
      );
      const lineCount = estimateMonetWrappedLines(wordWidths, contentWidth);
      return lineCount * lineHeightPx + sweepOverflowPx * 2;
    },
    [fonts.lyric, fontFamily, lineHeightPx, sweepOverflowPx],
  );
  const railContentWidth = Math.max(
    (railSize.width > 0 ? railSize.width : 680) - glowBufferPx * 2 - 8,
    180,
  );

  /** 窗口里每行的自然高度（窗口不变就不重算）。 */
  const naturalHeights = useMemo(
    () => entries.map((entry) => measureNaturalHeight(entry.line, railContentWidth)),
    [entries, measureNaturalHeight, railContentWidth],
  );

  /**
   * **行距**（真·列表滚动的心脏）：整首歌一个常量 = 最高那行的自然高度 + 一点留白。
   *
   * 为什么必须是常量：只要它跟着「当前哪一行在中间」变，滚一格时每行的位移就各不相同，
   * 读起来就是「整块重排」而不是「列表滚动」。取的是**整首歌**的最高行（不是当前窗口那几行
   * ——后者会随窗口滑动而变，又变回重排），所以长句折成两行也不会压到下一行。
   */
  const slotPx = useMemo(() => {
    let tallest = lineHeightPx + sweepOverflowPx * 2;
    for (const line of lines) {
      const height = measureNaturalHeight(line, railContentWidth);
      if (height > tallest) tallest = height;
    }
    return Math.ceil(tallest + lineHeightPx * MONET_SLOT_GAP_RATIO);
  }, [lines, measureNaturalHeight, railContentWidth, lineHeightPx, sweepOverflowPx]);

  /**
   * 每行的最终位置与色调 —— **唯一**依赖连续锚点的一步，而且只做算术（不量文本），
   * 所以滚轮每动一像素重算它也不心疼。
   */
  const positioned = useMemo(() => {
    const railHeightPx = railSize.height > 0 ? railSize.height : 340;
    const firstY = railHeightPx / 2 - slotPx / 2;
    return entries.map((entry, index) => {
      // 距离用**连续**值：越靠近中心越清晰越大，过渡是连续的，不是一格一跳。
      const tone = resolveMonetLineTone(entry.status, entry.index - anchorFloat, inactiveScale);
      /*
       * 列表定位：`距锚点多少行 × 行距`。锚点可以是小数 ⇒ 滚一格时**每一行的位移完全相同**
       * （这才叫列表滚动）；行与行之间不再因为「谁大谁小」互相挤，长句也不会压到下一行。
       */
      const y = firstY + (entry.index - anchorFloat) * slotPx;
      return { entry, tone, y, visualHeightPx: naturalHeights[index] ?? 0 };
    });
  }, [entries, naturalHeights, slotPx, anchorFloat, inactiveScale, railSize.height]);

  const wordRefs = useRef(new Map<string, HTMLElement>());

  /**
   * 逐字素的 `waiting / active / passed`。
   *
   * **只服务 DOM 契约**（`lyric-themes.css:11-12`：字素必须挂 `.pi-lyricstage__word` + `data-word-state`，
   * UI 冒烟按这两个选择器数逐字状态）。莫奈的视觉由**行级** status（三态淡出）与扫光遮罩决定，
   * 与这里的逐字素状态无关 —— 所以按商店里 ~4Hz 的 `positionMs` 算一次就够，不占 rAF。
   */
  const wordStatesByLine = useMemo(() => {
    const map = new Map<number, ReturnType<typeof wordStatesFor>>();
    for (const entry of entries) {
      map.set(entry.index, wordStatesFor(entry.line, positionMs, HINT_LOOKAHEAD[entry.line.hint]));
    }
    return map;
  }, [entries, positionMs]);

  /**
   * 逐字扫光 + 辉光：一个 rAF，只写**当前句**那些字素的 CSS 变量（不 setState）。
   * 非当前句没有扫光层（`isLineActive` 才渲染），所以这里也只需要管当前句。
   */
  useEffect(() => {
    if (reduced) return undefined;
    const activeEntry = positioned.find((item) => item.tone.active);
    if (activeEntry === undefined) return undefined;
    const gate = createFrameGate(fpsCap);
    let frame = 0;
    const tick = (): void => {
      if (!gate(performance.now())) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      const nowSec = clock.current() / 1000;
      const line = activeEntry.entry.line;
      const lineEndSec = (line.timeMs + line.durationMs) / 1000;
      const softness = resolveMonetSweepEdgeSoftness(fonts.lyric);
      const glowRadii = resolveMonetGlowRadii(fonts.lyric, activeEntry.entry.chorus);
      line.words.forEach((word, wordIndex) => {
        const element = wordRefs.current.get(`${activeEntry.entry.index}:${wordIndex}`);
        if (element === undefined) return;
        const startSec = word.startMs / 1000;
        const endSec = word.endMs / 1000;
        const fullWidth = measureTextWidth(word.text, fonts.lyric, MONET_LYRIC_FONT_WEIGHT, fontFamily, 0);
        const filled = resolveMonetFillWidth(nowSec, startSec, endSec, fullWidth);
        const geometry = resolveMonetSweepGeometry(filled, fullWidth, softness);
        element.style.setProperty('--pi-monet-mask', monetSweepMaskImage(geometry));
        const tone = resolveMonetGlow(nowSec, startSec, endSec, lineEndSec);
        element.style.setProperty('--pi-monet-glow', tone.toFixed(3));
        element.style.setProperty('--pi-monet-glow-1', `${glowRadii.radiusOne}px`);
        element.style.setProperty('--pi-monet-glow-2', `${glowRadii.radiusTwo}px`);
        // 用户本轮第 3 条：莫奈这层辉光以前不读设置的辉光强度（等于永远开着、关不掉），
        // 现在乘上 `glowIntensity` ⇒ 设置页关掉时 alpha 为 0，这一圈雾就没了。
        element.style.setProperty(
          '--pi-monet-glow-alpha',
          (tone * glowRadii.maxAlpha * glowIntensity).toFixed(3),
        );
      });
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [clock, colors.primary, fpsCap, fontFamily, fonts.lyric, glowIntensity, positioned, reduced]);

  const particles = useMemo(() => buildMonetDecorParticles(), []);
  const seed = lines[0]?.timeMs ?? 0;
  /**
   * 常态墨色（**用户第 11 轮第 1/2 条**：所有主题的常态字色与流光的 `--pi-lyric-ink` 同源）。
   *
   * folia 的莫奈给待唱 / 已唱的字各自写一个 `primaryColor` 的 alpha（0.46 / 0.34），
   * 本仓库用户明确否掉了那种「自己混一支灰」的做法 —— 常态一律吃 `--pi-lyric-ink`
   * （暗档 `#fff`、亮档近黑），衰减交给**行级 `opacity` / `blur`**（folia 那边是字色 + 行级两者并用）。
   * 唯一例外是**当前句**：它的本色压到 `ink @ 0.34`，扫光扫过的部分才由 `--pi-monet-word`
   * 盖上去 —— 不然「唱到哪个字哪个字亮」就没有对比了。
   */
  const inkColor = colors.ink !== undefined && colors.ink !== '' ? colors.ink : colors.primary;
  /**
   * **背景层**：按上游管线（取图 → cover 裁切 → 逐像素 wash → 四层 overlay → JPEG → 缓存）
   * 生成那张 `1920×1080` 的海报底图。
   *
   * - 参数用**上游默认值**（`MONET_BACKGROUND_DEFAULT_TUNING`，见 `CREDITS.md` 的出处），不是我们拍的数；
   * - **唯一按设置改的一项**是本轮补的「背景氛围光」（`tuningOf(theme).backgroundGlow`）：
   *   莫奈这张底图整幅盖住窗口（公共那几层 `__aura` / `__bloom` / `__sidelight` 都被它挡住），
   *   所以那枚开关要真的在莫奈里生效，只能落在**它自己这张烤图**上 —— 关掉时 `glowScale: 0`，
   *   烤出来就没有那团「封面暖光」（`leftBloom`）。开着时逐像素与改造前一致（`glowScale: 1`）；
   * - 缓存按"输入内容"寻址（换封面 / 换主题三色 / 开关氛围光 才会重算），失败一律得 `null`（不画背景层）；
   * - 没有封面（本地歌没图）时直接不请求；
   * - **用户在设置里导入了播放页背景时整层不出**（主人本轮第 1 条）：这张烤图整幅盖住窗口，
   *   留着它就把主人自己挑的那张图挡得一个像素都不剩 —— 「设为播放页背景」得对每一套主题都算数。
   */
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  /** 设置里那张自定义背景（有它就不烤封面底图，见上）。 */
  const customBackground = useSettings().data?.playerBackground ?? null;
  useEffect(() => {
    let alive = true;
    if (
      customBackground !== null ||
      coverUrl === undefined ||
      coverUrl === null ||
      coverUrl === ''
    ) {
      setBackgroundUrl(null);
      return () => {
        alive = false;
      };
    }
    void resolveMonetBackgroundDataUrl({
      coverUrl,
      theme: {
        backgroundColor: colors.surface,
        primaryColor: colors.primary,
        accentColor: colors.accent,
      },
      tuning: monetBackgroundTuningFor(backgroundGlow),
    }).then((url) => {
      if (alive) setBackgroundUrl(url);
    });
    return () => {
      alive = false;
    };
  }, [coverUrl, backgroundGlow, customBackground, colors.surface, colors.primary, colors.accent]);
  const artistLabel = (songArtist ?? '').trim() === '' ? 'Monet' : (songArtist as string).trim();
  const titleLabel = (songTitle ?? '').trim() === '' ? 'Monet' : (songTitle as string).trim();
  const albumLabel = (songAlbum ?? '').trim() === '' ? 'Monet' : (songAlbum as string).trim();
  /**
   * 换歌时把入场动画重放一遍（folia 用 `introKey` 重挂载那几个包裹层：
   * 曲目变化或播放头从曲尾回到开头都会 +1）。这里用「歌名 + 首行时间戳」当信号，
   * 同一首歌重播不会重放，换一首必定重放。
   */
  const introKey = `${titleLabel}:${lines[0]?.timeMs ?? 0}`;
  /*
   * **漂移接线（第 231 轮）**：以前这里**恒定挂** `--drift` 类 ✗（注释自己写着"还差一次接线" ✓），
   * 现在改由**具名默认**驱动 ✓：`MONET_DRIFT_DEFAULT.enabled` 决定挂不挂类 ✓、
   * `strength` 决定四个 CSS 变量 ✓（`monetDrift.ts` 里那套数学本来就是照抄上游的 ✓）。
   * ⚠ 变量值里的 `translate` **必须补 `%`** ✗ —— 它是"百分比"语义 ✓（CSS 兜底写的也是 `0.6%` ✓），
   * 漏了单位会变成 `translate(0.6, -0.6)` = 0.6 **像素** ⇒ 动画照跑、不报错、几乎看不出在动 ✗✗。
   */
  const monetDriftEnabled = MONET_DRIFT_DEFAULT.enabled;
  const monetDriftStyle = resolveMonetBackgroundDriftStyle(MONET_DRIFT_DEFAULT.strength);

  return (
    <div
      className="pi-lyricmonet"
      ref={rootRef}
      data-theme="monet"
      style={
        {
          '--pi-monet-primary': colors.primary,
          '--pi-monet-accent': colors.accent,
          '--pi-monet-surface': colors.surface,
          /*
           * 底色与主色按**相对亮度**定向（上游 wash 规则）：暗的当 shadow、亮的当 highlight ——
           * 否则深色封面配浅色主题时渐变会"倒过来"。
           * ⚠ `rootRef.current` **必须传**：`var(...)` 链要靠它落色，传 null 会静默退到兜底色。
           */
          '--pi-monet-wash-shadow': resolveMonetWashCssVars(colors.surface, colors.primary, rootRef.current)
            .shadow,
          '--pi-monet-wash-highlight': resolveMonetWashCssVars(colors.surface, colors.primary, rootRef.current)
            .highlight,
          '--pi-monet-secondary': colors.accent,
          '--pi-monet-font': fontFamily,
          '--pi-monet-layout-scale': layoutScale.toFixed(4),
          '--pi-monet-row-max-width': `${Math.round(1520 * layoutScale)}px`,
          '--pi-monet-portrait-max': `${Math.round(430 * layoutScale)}px`,
          '--pi-monet-portrait-inner-max': `${Math.round(380 * layoutScale)}px`,
          '--pi-monet-lyric-size': `${fonts.lyric.toFixed(2)}px`,
          '--pi-monet-inactive-size': `${fonts.inactive.toFixed(2)}px`,
          '--pi-monet-line-height': `${lineHeightPx}px`,
          '--pi-monet-glow-buffer': `${glowBufferPx}px`,
          '--pi-monet-glow-alpha': '0',
          '--pi-monet-glow-1': '0px',
          '--pi-monet-glow-2': '0px',
          '--pi-monet-rail-max-width': `${railMaxWidthPx}px`,
          '--pi-monet-rail-max-height': `${railMaxHeightPx}px`,
        } as CSSProperties
      }
    >
      {backgroundUrl === null ? null : (
        <div
          /*
           * **缓慢漂移**（照抄 folia 语义：**DOM 侧 transform、不进位图缓存** ✓）：
           * 关键帧与变量兜底都写在 `lyric-monet.css` 的 `pi-monet-bg-drift` 里（`prefers-reduced-motion` 下关掉 ✓）。
           *
           * ⚠ **现在恒定挂类**：上游默认就是 `driftEnabled: true` ✓，所以行为与默认档一致 ✓；
           * 但要真正支持"关掉"（把调参引进来读 `MONET_DRIFT_DEFAULT.enabled`），还差一次接线 ✗ ——
           * **这里不假装已经支持**，留给下一步（见 `docs/PLAN.md` 第 414 轮）✓。
           */
          className={`pi-lyricmonet__bg${monetDriftEnabled ? ' pi-lyricmonet__bg--drift' : ''}`}
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url(${backgroundUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            zIndex: 0,
            /* 四个漂移变量（第 231 轮接线 ✓；`translate` 带 `%` ✓ —— 单位漏了会静默变成像素 ✓）。 */
            '--pi-monet-bg-prescale': monetDriftStyle.preScale,
            '--pi-monet-bg-scale-range': monetDriftStyle.scaleRange,
            '--pi-monet-bg-translate': `${monetDriftStyle.translate}%`,
            '--pi-monet-bg-duration': monetDriftStyle.duration,
            /*
             * ⚠ `as CSSProperties` 不能省 ✗：`CSSProperties` 不认 `--*` 自定义属性
             * ⇒ 不加断言就是 `TS2353`（第 231 轮实地踩到 ✓）。根容器那处也是这么做的 ✓。
             */
          } as CSSProperties}
        />
      )}
      <div className="pi-lyricmonet__decor" aria-hidden="true">
        {particles.map((particle) => (
          <span
            key={particle.id}
            className="pi-lyricmonet__petal"
            data-reverse={particle.reverse}
            style={
              {
                left: `${particle.xPercent}%`,
                top: `${particle.yPercent}%`,
                width: `${particle.sizePx}px`,
                height: `${particle.sizePx}px`,
                '--pi-monet-petal-duration': `${particle.durationSec}s`,
                '--pi-monet-petal-delay': `${particle.delaySec}s`,
                '--pi-monet-petal-opacity': particle.opacity,
                '--pi-monet-petal-rotate': `${particle.rotation}deg`,
              } as CSSProperties
            }
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3C14.5 5.5 16.8 9 16 14C15.2 19 13.5 21 12 21C10.5 21 8.8 19 8 14C7.2 9 9.5 5.5 12 3Z"
                fill="currentColor"
              />
            </svg>
          </span>
        ))}
      </div>

      <div className="pi-lyricmonet__row">
        <div className="pi-lyricmonet__col" key={`col-${introKey}`}>
          <div className="pi-lyricmonet__head">
            <div className="pi-lyricmonet__artist">{artistLabel}</div>
            <div className="pi-lyricmonet__rule" />
          </div>
          <div className="pi-lyricmonet__title">{titleLabel}</div>
          <div className="pi-lyricmonet__album">{albumLabel}</div>

          <div
            className="pi-lyricmonet__rail"
            ref={railRef}
            style={
              {
                '--pi-monet-glow-buffer': `${glowBufferPx}px`,
                maxWidth: `${railMaxWidthPx}px`,
              } as CSSProperties
            }
          >
            {positioned.map(({ entry, tone, y, visualHeightPx }, order) => (
              <div
                key={`${entry.index}-${entry.line.timeMs}`}
                className="pi-lyricmonet__line"
                data-lyric-line
                data-index={entry.index}
                data-line-time={entry.line.timeMs}
                data-active={tone.active || undefined}
                data-status={entry.status}
                data-first={order === 0 || undefined}
                data-last={order === positioned.length - 1 || undefined}
                style={
                  {
                    transform: `translate3d(0, ${y.toFixed(2)}px, 0) scale(${tone.scale.toFixed(4)})`,
                    opacity: tone.opacity.toFixed(3),
                    filter: `blur(${tone.blurPx.toFixed(2)}px)`,
                    zIndex: Math.round(tone.zIndex),
                    height: `${visualHeightPx.toFixed(2)}px`,
                    '--pi-monet-base': tone.active ? rgba(inkColor, tone.baseAlpha) : inkColor,
                    '--pi-monet-word': wordColorOf(theme, entry.line.text, rgba(colors.primary, 0.98)),
                    '--pi-monet-sweep-overflow': `${sweepOverflowPx}px`,
                    '--pi-monet-passed': entry.status === 'passed' ? 'true' : 'false',
                  } as CSSProperties
                }
              >
                {entry.chorus ? <span className="pi-lyricmonet__chorus" aria-hidden="true" /> : null}
                <span className="pi-lyricmonet__text">
                  {entry.line.words.map((word, wordIndex) => (
                    <span
                      key={`${wordIndex}-${word.text}`}
                      /* 契约（lyric-themes.css:11-12）：字素必须挂 `.pi-lyricstage__word` + `data-word-state`，
                         冒烟按这两个选择器数逐字状态。莫奈自己的颜色 / 辉光全部写在里面的
                         `.pi-lyricmonet__ink` 上；本文件对应的 CSS 里再把共用的三态复位
                         （不复位的话，共用规则会把这些字素压成 `opacity: 0` + `scale(1.4)`）。 */
                      className="pi-lyricstage__word pi-lyricmonet__word"
                      data-word-state={wordStatesByLine.get(entry.index)?.[wordIndex] ?? 'waiting'}
                      ref={(element) => {
                        const key = `${entry.index}:${wordIndex}`;
                        if (element === null) wordRefs.current.delete(key);
                        else wordRefs.current.set(key, element);
                      }}
                    >
                      <span className="pi-lyricmonet__ink">
                        {/^\s+$/.test(word.text) ? '\u00A0' : word.text}
                      </span>
                      {tone.active ? (
                        <span className="pi-lyricmonet__sweep" aria-hidden="true">
                          <span className="pi-lyricmonet__fill">
                            {/^\s+$/.test(word.text) ? '\u00A0' : word.text}
                          </span>
                        </span>
                      ) : null}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="pi-lyricmonet__portrait" data-style="square" key={`portrait-${introKey}`}>
          <div className="pi-lyricmonet__portraitframe">
            <MonetPortrait src={coverUrl} />
          </div>
        </div>
      </div>

      <div className="pi-lyricmonet__audio" key={`audio-${introKey}`}>
        <MonetAudioBar
          entries={entries}
          lines={lines}
          seed={seed}
          primaryColor={colors.primary}
          fpsCap={fpsCap}
          reduced={reduced}
        />
      </div>
    </div>
  );
}

export default MonetTheme;
