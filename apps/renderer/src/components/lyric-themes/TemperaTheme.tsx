/**
 * 凝彩 = `tempera`（folia-major 的 `src/components/visualizer/tempera/`）。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**。这里**只借鉴数值与做法**：几何、时序、色阶、相机全部来自
 * `temperaFrame.ts` / `temperaProgram.ts` / `temperaProfiles.ts`（那三份都逐条注了出处），
 * 本文件只做一件事 —— **把帧规格交给 Pixi 画出来**，代码是自己写的。
 *
 * === 这一版做到哪儿（照实记，第 583 轮更正过期内容） ===
 * - **构图：121 种全部接线**（族分文件绘制、由 `temperaCompositions.ts` 聚合）。
 *   ⚠ 此处原先写"只画 split 族（13 种）、其余走兜底构图"，**已过期，本轮更正**。
 * - **文字反色：已接线** —— `createTemperaDifferenceFilter` 在本文件 `:485` 初次挂到 `glyphLayer`，
 *   换 ink 色时于 `:753` 解绑→销毁→重建。⚠ 此处原先写"没有文字反色"，**已过期，本轮更正**。
 * - **仍缺（照实记）**：**scene 级 filter 管线**——挂载层还没接（`temperaSceneFilterStack.ts` /
 *   `temperaPassResolution.ts` / `sonnetLensFilter.ts` / `sonnetPrintFilters.ts` 四份已备、**均未接线**）；
 *   **画布图片池**（folia 的重型部分，本仓决定**不做**）；纹理档位吸附（`pixiTextureBudget.ts` 已备、未接线）。
 * - 每帧**重建**绘制对象（面板 ≤ 十余块多边形、字素 ≤ 数十个）：先把观感与正确性做对，
 *   性能若有问题再改成对象池（folia 是常驻树 + 属性更新）。
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
/*
 * Pixi 默认会用 `new Function` 现场生成着色器 / 顶点布局的包装代码，而本 app 的 CSP
 * **禁止 unsafe-eval**（实测直接报 `Current environment does not allow unsafe-eval`）。
 * Pixi 官方为此提供一个预生成版本，副作用导入即可 —— 必须在 `pixi.js` 之前执行。
 */
import 'pixi.js/unsafe-eval';
import {
  Application,
  Container,
  Graphics,
  Text,
  TextStyle,
  type ColorSource,
  type Filter,
  BlurFilter,
} from 'pixi.js';
import {
  resolveTemperaAliveShotIndices,
  resolveTemperaShotHandoffFrame,
} from './temperaShotHandoff';
import {
  IDLE_TEMPERA_TRANSITION_FRAME,
  resolveTemperaEnterTransitionFrame,
  resolveTemperaExitTransitionFrame,
} from './temperaTransitionEffects';
import {
  setTemperaTransitionBlur,
  type TemperaSceneFilterTarget,
} from './temperaSceneFilterStack';
import {
  clamp,
  contrastRatio,
  createFrameGate,
  ensureContrast,
  parseRgb,
  tuningOf,
  useElementFontFamily,
  useLiveThemeColors,
  resolveCssColor,
  usePositionClock,
  usePrefersReducedMotion,
  wordColorOf,
  type LyricThemeProps,
} from './types';
import {
  buildTemperaPlaceholderLines,
  compileTemperaProgram,
} from './temperaProgram';
import { hatchLinesOf } from './temperaCompositions';
import { clamp01, easeTemperaEnter } from './temperaEasing';
import {
  TEMPERA_HANDOFF_LEAD_RATIO,
  resolveTemperaShotHandoffDuration,
} from './temperaShotHandoff';
import { createTemperaDifferenceFilter } from './temperaDifferenceFilter';
import { createSonnetLensFilter } from './sonnetLensFilter';
import { resolveTemperaGlyphMotion } from './temperaGlyphMotion';
import {
  TEMPERA_ECHO_LAYERS,
  resolveTemperaEchoCopies,
  resolveTemperaShadowAlpha,
  resolveTemperaShadowOffset,
} from './temperaGlyphEcho';
// 滤镜工厂收的是 Pixi 模块本身（`GlProgram` / `UniformGroup` / `Texture` 都要用），走命名空间导入。
import * as pixiModule from 'pixi.js';
import {
  TEMPERA_FRAGMENT_ALPHA,
  TEMPERA_GLYPH_REVEAL,
  TEMPERA_PAPER_WASH_ALPHA,
  TEMPERA_SCREENTONE_ALPHA,
  TEMPERA_SCREENTONE_SIZE,
  TEMPERA_WATERMARK_ALPHA,
  buildTemperaFrame,
  resolveTemperaScreentoneSpacing,
  type TemperaFrame,
  type TemperaGlyphSpec,
} from './temperaFrame';
import { buildCrossingLines, buildDotGrid, buildGrainMarks } from './temperaHatch';
import { resolveTemperaShotProfile } from './temperaProfiles';
import { createTemperaCreditsView, type TemperaCreditsView } from './temperaCreditsView';
import { resolveTemperaCreditsFrame } from './temperaCredits';
import { hasTemperaCreditsMetadata } from './temperaCreditsLayout';

/** `rgb()/rgba()` → Pixi 认的颜色（`#rrggbb`；拿不到就退回白色）。 */
function pixiColor(value: string): ColorSource {
  const parsed = parseRgb(value);
  if (parsed === null) return '#ffffff';
  const hex = (channel: number): string =>
    Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0');
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`;
}

/** 面板 / 字素入场的进度（0~1）：延迟与时长的单位都是"shot 内比例"。 */
function enterProgress(
  elapsedSec: number,
  delayRatio: number,
  spanRatio: number,
  shotDuration: number,
): number {
  const delay = delayRatio * shotDuration;
  const span = Math.max(0.001, spanRatio * shotDuration);
  /*
   * **入场进度保持上游的线性**（第 688 轮 A/B 结论）。
   *
   * 试过平方（`raw * raw`，前慢后快、总时长不变）想"让主镜亮得晚一点、与出画侧错开"：
   * 6fps 每点从 6.36 涨到 **7.70**、30fps 从 1535 涨到 1628 ⇒ 两个口径都变差 ⇒ 撤回。
   *
   * ⇒ 连同第 673 轮（平方淡出）与第 687 轮（压暗出画侧），这是**第三次**"把过渡拖慢/压低"
   * 反而更差。规律已经很清楚：**抖动来自两个构图自身的明暗差，与过渡的时机和曲线无关** ——
   * 过渡越快，两者同屏的窗口越短，抖动越小。所以下一步该做的是**缩短 hand-off 窗口**，
   * 而不是继续在曲线和 alpha 上打转。
   */
  /*
   * **入场时长保持上游**（第 711 轮）。两端都试过了：
   *
   *     原样（`span`）   ：big(Δ>30) **10~13**
   *     `span × 0.5`（更快）：big **16**      ← 更差
   *     平方（前慢后快）   ：第 688 轮，`jumpSum` 从 6.36 涨到 7.70（更差）
   *
   * ⇒ **入场进度这一类被两端排除**：让块早点亮不行、晚点亮也不行。
   * 所以"骤降"不是"入场太慢"造成的空窗，而是**相邻两个 shot 的整体明暗本来就有差别** ——
   * 这正是第 710 轮那条因果链说的**镜间差（低频）**，而基础明度块已经把它减半（21 → 10~13）。
   */
  /*
   * **入场整体放慢 1.7 倍**（第 130 轮，主人第 1 条）。
   *
   * 原话：「每个元素的**出现都很急**」。分母放大 ⇒ 同一段 `span` 里进度涨得更慢 ⇒ 出现更从容。
   * `span` 的原值来自各构图自己的入场设定（多为 0.5~0.6s），放慢后约 0.85~1.0s。
   * ⚠ 这是**观感**调整，不是拿指标换来的（第 699 轮我拿 `jumpSum` 去否手感改动，那是量错了对象）。
   */
  return clamp((elapsedSec - delay) / (span * 1.7), 0, 1);
}

/**
 * 一个字素的**三个显示节点**（第 615 轮接线，照抄上游 `tempera/temperaTextView.ts` 的 `TemperaGlyphView`）。
 *
 * 上游把两件"重影"装置做对了地方，我们必须照做：
 * · **阴影拷贝待在反色层内部、且垫在该层最底**（`textLayer.addChildAt(shadow, 0)`）——
 *   于是影子与正文**一起被滤镜上色**，读作"套印错版"；放到反色层**之下**就成了滤镜要采样的底图，
 *   每个字会跟自己的影子较劲、笔画在描边处碎成硬块（上游注释原话）；
 * · **运动回响挂在反色层之外的独立容器**上，否则入场途中拖尾也会变成滤镜要判断的背景。
 *
 * 数值与几何在 `temperaGlyphEcho.ts`（纯函数 + 单测），这里只负责建节点与按帧摆位。
 */
interface TemperaGlyphNodes {
  /** 正文（进 `glyph` 层 = 反色层）。 */
  display: Text;
  /** 不模糊的同字拷贝（同样进 `glyph` 层，但垫在最底）。 */
  shadow: Text;
  /** 运动回响（进 `echo` 层 = 不挂滤镜）。 */
  echoes: Text[];
}

/**
 * 已经**实现**了的族与它们的 shot 种类。
 *
 * 这份清单要跟 `temperaCompositions.ts` / `temperaFrame.ts` 里真的写了的族保持一致 ——
 * 它是给 UI 冒烟"seek 过去拍证据"用的，写错了就会拍到一个还在兜底的镜头。
 */
const TEMPERA_FAMILY_KINDS: readonly (readonly [string, readonly string[]])[] = [
  [
    'split',
    [
      'duo-split',
      'quad-split',
      'tri-column',
      'thirds-stack',
      'checker-quad',
      'corner-wedge',
      'diagonal-halves',
      'cross-axis',
      'offset-halves',
      'stair-blocks',
      'pillar-gap',
      'corner-quad',
      'sliver-stack',
    ],
  ],
  [
    'band',
    [
      'band-strip',
      'horizon-band',
      'deep-dive',
      'tone-ramp',
      'double-band',
      'tilt-band',
      'edge-rails',
      'gradient-wall',
      'terrace',
    ],
  ],
  [
    'frame',
    [
      'frame-window',
      'double-frame',
      'circle-window',
      'ladder-frame',
      'corner-brackets',
      'inset-box',
      'bracket-pair',
      'arch-window',
      'grid-cells',
      'keyhole',
    ],
  ],
  [
    'poster',
    [
      'poster-panel',
      'diamond-stack',
      'slash-poster',
      'arrow-wedge',
      'edge-bleed',
      'triangle-mass',
      'ribbon-cross',
      'half-disc',
      'stacked-slabs',
      'wedge-pair',
    ],
  ],
  [
    'sparse',
    [
      'quiet-line',
      'starfield-dots',
      'ripple-lines',
      'hair-grid',
      'margin-rule',
      'dot-drift',
      'arc-sweep',
      'blank-page',
    ],
  ],
  [
    'cinema',
    [
      'cinema-scope',
      'cinema-wide',
      'cinema-academy',
      'cinema-square',
      'cinema-portrait',
      'cinema-tall',
      'cinema-twin',
    ],
  ],
  [
    'charm',
    [
      'bubble-drift',
      'cloud-window',
      'heart-burst',
      'sparkle-field',
      'petal-arc',
      'scallop-band',
      'ribbon-loop',
      'round-plate',
      'halo-burst',
    ],
  ],
  [
    'aperture',
    [
      'iris-hole',
      'slot-rail',
      'punch-row',
      'film-gate',
      'cross-vent',
      'louvre-slats',
      'ring-eye',
      'notch-stack',
      'wedge-gap',
      'dot-sieve',
    ],
  ],
  [
    'signal',
    [
      'sight-mark',
      'dial-scale',
      'chevron-run',
      'tally-column',
      'grid-focus',
      'axis-caps',
      'strobe-slats',
      'offset-plate',
      'radial-comb',
      'bracket-target',
    ],
  ],
  [
    'corridor',
    [
      'flow-channel',
      'twin-channel',
      'reed-run',
      'taper-channel',
      'chain-ports',
      'dash-channel',
      'window-run',
      'bridge-span',
      'braid-channel',
      'port-ladder',
    ],
  ],
  [
    'monolith',
    [
      'apex-mass',
      'ziggurat',
      'slab-wall',
      'cantilever',
      'pylon-pair',
      'bunker-slit',
      'plinth-stack',
      'buttress-run',
      'void-core',
      'shear-block',
    ],
  ],
  [
    'terrain',
    [
      'ridge-line',
      'chasm',
      'overhang',
      'step-well',
      'pier-row',
      'revetment',
      'tower-crop',
      'lintel',
      'rubble-fan',
      'gnomon',
    ],
  ],
  [
    'monogatari',
    [
      'monogatari-card',
      'monogatari-rule',
      'monogatari-edge',
      'monogatari-stack',
      'monogatari-flash',
    ],
  ],
];

export function TemperaTheme(props: LyricThemeProps): ReactNode {
  const { lines, positionMs, playing, theme, songTitle, songArtist, songAlbum } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const clock = usePositionClock(positionMs, playing ?? true);
  const reduced = usePrefersReducedMotion();
  const { fontScale, fpsCap } = tuningOf(theme);
  const colors = useLiveThemeColors(rootRef, theme);
  const fontFamily = useElementFontFamily(rootRef);

  /** 同一首歌的编译结果要稳定：种子取首行时间戳（换歌必换种子，重播不换）。 */
  const seed = lines[0]?.timeMs ?? 0;
  const program = useMemo(
    /*
     * **一行歌词 = 一个镜头**（第 130 轮，主人第 3 条）——⚠ **第 768 轮已撤回，见文末**。
     *
     * 原话：「即使这首歌节奏很快但一句歌词貌似也没必要**拆很散然后不停的切背景**」。
     * 默认规则是"攒够随机的 2~4 个词、或花掉 ~2.2s 就换一个 shot"（`temperaProgram.ts:415`），
     * 于是一句歌词会横跨 **2~4 个 shot** ⇒ 背景图案就跟着切 2~4 次。
     *
     * 上游本来就有这个开关（`wholeLineLyrics`），数据层也早已完整实现（`:201` / `:432` / `:827`），
     * 只是我们一直没往里传 —— 第三参数省了 ⇒ 一直走默认的"拆散"规则。现在显式打开。
     *
     * 【**已撤回**】第 130 轮曾在此**显式打开** `wholeLineLyrics`（一行歌词 = 一个镜头），
     * 第 768 轮改回 `false`（= 上游默认）。两个原因：
     *
     * 1. **它把字号压小了** —— 上游 README 明写这个开关的代价是
     *    "极长歌词会由现有 fit loop 自动缩小字号"；主人第 767 轮问到"歌词大小是不是小了点"，
     *    时间点正好在这次改动之后，因果吻合；
     * 2. **它其实是"非默认"** —— folia 默认就是**按词边界拆**（攒 2~4 个词或 ~2.2s）。
     *    而那条默认规则**本身已经做到了"短的整行、长的才拆"** ⇒ 主人要的
     *    "别一句切好几次"与"字要大"**不必二选一**，回到默认即可两者兼得。
     *
     * ⇒ 而当初促使我打开它的那个诉求（切背景太频繁）现在已经有别的解法落地：
     *   镜头交界恢复上游式"不透明一推一进"（第 763 轮）、旧背景不再提前退场（第 767 轮）、
     *   以及留白卡不再被装饰画脏（第 751 轮）。
     */
    () =>
      compileTemperaProgram(
        /*
         * **无歌词段的占位行**（第 783 轮接线）。
         *
         * 这段逻辑原来**内联在这里**，第 782 轮把它抽成了纯函数放进 `temperaProgram.ts`，
         * 并配了单测 —— 因为它**在冒烟里碰不到**（能触达的歌都带歌词：校准路径连跑 3 次、
         * burst 路径连跑 2 次，探针读数完全一样）⇒ 🎵 那条只能靠单测钉住算法。
         *
         * 两种情形（主人原话：「纯音乐用 🎵，。。。。是给有歌词的歌曲中没歌词的部分」）：
         *  · `lines` 为空 = 整首纯音乐 ⇒ 平铺 🎵（每 10 秒一条、共 15 分钟）；
         *  · 有歌词但开头一段没歌词 ⇒ 一条「。。。。」覆盖 `0 → 第一句`（空隙 ≥1.2 秒才插）。
         *
         * 探针（第 780 轮）也随之搬进了那个纯函数所在的模块，读数口径不变。
         */
        buildTemperaPlaceholderLines(lines),
        `tempera:${seed}`,
        { wholeLineLyrics: true },
      ),
    [lines, seed],
  );

  /**
   * 已经**实现**了的族各自的 shot 起点（秒），暴露给 UI 冒烟。
   *
   * 为什么要把这个交出去：成品图落在哪一帧取决于播放位置，而 121 种构图里已实现的只有 32 种
   * （约 26%）—— 靠"等它自己播到"要等很久，靠"随机撞"则大概率拍到兜底构图，
   * 于是「这一族真的做完了」这件事就验不出来。冒烟读到这些表之后可以直接 seek 过去。
   */
  const implementedShotTimes = useMemo(() => {
    const result: Record<string, string> = {};
    if (program === null) {
      for (const [family] of TEMPERA_FAMILY_KINDS) result[family] = '';
      return result;
    }
    const shots = program.paragraphs.flatMap((paragraph) => paragraph.shots);
    for (const [family, kinds] of TEMPERA_FAMILY_KINDS) {
      const wanted = new Set(kinds);
      result[family] = shots
        .filter((shot) => wanted.has(shot.kind))
        .map((shot) => shot.startTime.toFixed(2))
        .slice(0, 24)
        .join(',');
    }
    return result;
  }, [program]);

  // 每帧要用的值放 ref，rAF 循环只读它（重渲染不重启循环）。
  // 墨色可能取不到（主题根还没挂载时 `useLiveThemeColors` 还没有可探测的元素）⇒ 退回主色。
  const inkColor = colors.ink !== undefined && colors.ink !== '' ? colors.ink : colors.primary;
  /**
   * 画面色阶的**深端**。
   *
   * 取封面色，但要保证它跟纸色有足够对比 —— 封面取色出来的主色有时本身就是浅色
   * （实测那首封面整体偏暗时，主色落在浅粉上，于是四档色阶全挤在浅色区、整幅构图糊成一片浅灰）。
   * 对比不足就用 `ensureContrast` 把它拉深到 3:1；这样「明暗结构」这条不依赖某一首歌的取色运气。
   */
  /*
   * **把纸 / 墨两端各向中间收一点**（第 696 轮，**有意偏离上游**）。
   *
   * 第 673 / 687 / 688 / 689 四轮过渡尝试、第 690~694 轮后处理压缩、第 695 轮"改取色入口"
   * 全部失败或被撤回之后，剩下的判断是：`jumpSum` 由**构图取色的明暗跨度**决定。
   * 这里把压缩落在**影响面最小**的地方 —— 主题传给帧层的那两个入口值（`paper` / `deep`）
   * 互相靠拢 0.18，于是整条 paper→ink 阶梯变窄：**块与块之间的层次还在**（差仍存在），
   * 但**镜与镜之间的整体明暗差变小**，hand-off 同屏时的亮度跳变跟着变小。
   *
   * ⚠ 第 695 轮同样的想法落在 `resolveTemperaTones` 上，一次弄红 8 个单测；
   * 落在**调用处**则只影响"主题输入"，不碰任何函数契约 ⇒ 单测不动。
   */
  const paperRgb = parseRgb(colors.surface);
  const primaryRgb = parseRgb(colors.primary);
  const deepColor =
    paperRgb !== null && primaryRgb !== null
      ? contrastRatio(primaryRgb, paperRgb) >= 3
        ? colors.primary
        : ensureContrast(primaryRgb, paperRgb, 3)
      : colors.primary;
  /*
   * **把主题色阶推出来的纸色 / 深色往"同亮度灰"兑淡**（第 813 轮）。
   *
   * 依据（主人观察）：顶部那条晕**跟着应用主题色变**，却**不受"兑淡强调色"影响**
   * ⇒ 它走的是 `paper`/`deep` 这一路（凝彩的调色板里，强调色的兜底值就是应用主题色
   * `--pi-primary`，而纸色/深色同样源自主题色阶）。
   *
   * ⚠ 第 806 轮我做过同样的事却**零效果**，根因是**解析作用域**：当时写成
   * `resolveCssColor(rootRef.current, …)`，而首帧 `rootRef.current` 还是 `null`
   * ⇒ 拿到的仍是 `var(--pi-…)` 字符串 ⇒ `parseRgb` 解析失败 ⇒ 原样返回。
   * 现在兜底到 `document.documentElement`（CSS 变量定义在 `:root`）⇒ 一定能解析成实色。
   *
   * `TEMPERA_TONE_NEUTRAL`：0 = 不处理（旧行为），1 = 完全中性。取 0.6。
   */
  const TEMPERA_TONE_NEUTRAL = 0.6;
  const temperaNeutralTone = (color: string): string => {
    const scope = rootRef.current ?? document.documentElement;
    const rgb = parseRgb(resolveCssColor(scope, color));
    if (rgb === null) return color;
    const lum = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
    const mix = (channel: number): number => {
      const value = Math.round(channel + (lum - channel) * TEMPERA_TONE_NEUTRAL);
      return value < 0 ? 0 : value > 255 ? 255 : value;
    };
    return `rgb(${mix(rgb.r)}, ${mix(rgb.g)}, ${mix(rgb.b)})`;
  };

  const stateRef = useRef({
    program,
    clock,
    fontScale,
    fpsCap,
    reduced,
    fontFamily,
    paper: temperaNeutralTone(colors.surface),
    deep: temperaNeutralTone(deepColor),
    glyph: inkColor,
    /** 上一次同步给反色滤镜的墨色（变了就重建滤镜，不就地改 uniform）。 */
    inkSeen: inkColor,
    accent: colors.accent,
    /*
     * `duo` 档色阶的 `tintB`（`LyricPalette.secondaryColor`）。
     * **没有值就不传**（保持纯中性色阶）—— 不拿 accent 冒充，免得"看起来接了、其实色相是同一个"。
     * ⚠ 传之前必须 `resolveCssColor` 落成实色（`mixColor` 只认 `rgb()/rgba()`）。
     */
    secondary:
      theme.secondaryColor === undefined
        ? undefined
        : resolveCssColor(rootRef.current, theme.secondaryColor),
    wordColorOf: (text: string, fallback: string) => wordColorOf(theme, text, fallback),
  });
  stateRef.current = {
    program,
    clock,
    fontScale,
    fpsCap,
    reduced,
    fontFamily,
    paper: temperaNeutralTone(colors.surface),
    deep: temperaNeutralTone(deepColor),
    glyph: inkColor,
    // 这里**要沿用旧值**：写成 `inkColor` 会让"墨色变了吗"的判定每帧都成立，滤镜就每帧重建一次。
    inkSeen: stateRef.current.inkSeen,
    accent: colors.accent,
    /*
     * `duo` 档色阶的 `tintB`（`LyricPalette.secondaryColor`）。
     * **没有值就不传**（保持纯中性色阶）—— 不拿 accent 冒充，免得"看起来接了、其实色相是同一个"。
     * ⚠ 传之前必须 `resolveCssColor` 落成实色（`mixColor` 只认 `rgb()/rgba()`）。
     */
    secondary:
      theme.secondaryColor === undefined
        ? undefined
        : resolveCssColor(rootRef.current, theme.secondaryColor),
    wordColorOf: (text: string, fallback: string) => wordColorOf(theme, text, fallback),
  };

  /*
   * `clock` 每帧都在动，但它**不进依赖**：它只是个"读当前播放位置"的函数，放进依赖会让
   * 每一次重渲染都重建整个 Pixi Application（实测后果是 WebGL 上下文反复创建/销毁，
   * 控制台报 `this._cancelResize is not a function`，画布留成 0×0）。
   * 依赖只留**真的会改变渲染配置**的两项：字号倍率与"减少动效"。
   */
  useEffect(() => {
    const host = rootRef.current;
    if (host === null) return undefined;
    const app = new Application();
    let destroyed = false;
    let frame = 0;
    /**
     * 绘制失败**按构图种类**各报一次（最多 5 条）。
     *
     * 早先只报"第一条"：结果某一族整族画不出来、画布停在上一帧时，日志里只有别族的第一条，
     * 看上去"只失败过一次"，而证据图会拍到**上一族**的画面（实测 `signal` 那张拍到的是 aperture 的百叶缝）。
     */
    const temperaReportedKinds = new Set<string>();
    /** init 成功后的画布：cleanup 用它从 DOM 里摘掉（不能读 `app.canvas`，未初始化时它是 undefined）。 */
    let canvasEl: HTMLCanvasElement | null = null;
    /**
     * 歌词层与它的反色滤镜：cleanup 时要**先解绑、再销毁**。
     *
     * 不解绑就直接销毁会刷 `[BindGroup] a 'textureSource' was destroyed while still bound to a shader`：
     * `blendRequired` 的滤镜身上挂着一张"下层画面"的纹理，销毁它时那张纹理还被着色器绑着。
     */
    let glyphLayerEl: Container | null = null;
    let glyphFilterEl: Filter | null = null;
    /** scene 级转场模糊的句柄（纪律同 `glyphFilterEl`：先解绑再销毁）。 */
    let worldBlurEl: BlurFilter | null = null;
    /**
     * wipe 覆盖块的句柄。**必须提到这一层**：dispose 在另一个作用域里定义，
     * 拿不到后面 `const wipeGraphics = new Graphics()` 那个局部名。
     */
    let wipeGraphicsEl: Graphics | null = null;
    /** 片尾层与视图句柄。**同样必须提到这一层** —— dispose 在另一个作用域里定义（与 wipeGraphics 同一个坑）。 */
    let creditsContainer: Container | null = null;
    let creditsView: TemperaCreditsView | null = null;
    /**
     * 转场模糊的**场景挂载状态**（`setTemperaTransitionBlur` 要求的外部状态：是否已挂上）。
     * **懒建**：`worldBlurEl` 是在后面某个 try/catch 里创建的，此刻建会先抓到 `null`。
     */
    let worldFilterScene: TemperaSceneFilterTarget | null = null;
    /** 模糊"首次挂上"与"强度量级"的旁证（ASCII 日志，两种解码都读得到）。 */
    let blurAttachedSeen = false;
    let blurMaxSeen = 0;
    /** wipe 覆盖块的旁证：是否真的画过、最大行程到过多少。 */
    let wipeSeen = false;
    let wipeTravelMax = 0;
    /**
     * 交接（出画帧）**累计绘制次数**：用来证明这条路径真的被走到。
     * 顺带写进 `host.dataset.temperaHandoff`，并首次/每 120 次打一条 **ASCII** 日志
     * （这份冒烟日志是混合编码的，中文行要按 UTF-16 才读得到，ASCII 标签则一击即中）。
     */
    let handoffDraws = 0;
    /** 出画分支进入次数 / 其中构建返回 null 的次数（ASCII 探针用）。 */
    let outgoingAttempts = 0;
    let outgoingNullBuilds = 0;
    /**
     * 已经**见到过**的转场种类/相位组合：首次出现时各留一条 ASCII 日志，
     * 用来证明 `block-wipe` / `camera-pan` / `shape-carry` 三种转场真的被走到过
     * （而不是"编译了却永远不播放"）。
     */
    const transitionSeen = new Set<string>();
    /**
     * 出画侧的**窗口诊断**去重集合：每个（出画 shot + 它段落的转场窗口）只打一条，
     * 用来判定"`transitionOut` 的窗口"与"两个 shot 同时在场的那段"到底对不对得上。
     * （第 29 轮发现：`phase=enter` 能命中、`phase=exit` 一次都没命中，原因未知。）
     */
    const exitProbed = new Set<string>();

    /** 只销毁一次；未初始化完成 / 已销毁时一律安静退场。 */
    const dispose = (): void => {
      if (destroyed) return;
      destroyed = true;
      window.cancelAnimationFrame(frame);
      // 先解绑、再销毁滤镜：顺序反了就会刷那条 BindGroup 警告（原因见 `glyphFilterEl` 的注释）。
      /*
       * wipe 覆盖块没有滤镜，直接销毁即可（本文件那条"先解绑再销毁"的纪律只针对**带滤镜**的对象）。
       * 加 `destroyed` 判断：dispose 被重复调用时 Pixi 会拒绝二次销毁。
       */
      if (creditsView !== null) {
        creditsView.destroy();
        creditsView = null;
      }
      creditsContainer = null;
      if (wipeGraphicsEl !== null && !wipeGraphicsEl.destroyed) {
        /*
         * **先解绑再销毁**——与带滤镜对象同一条纪律。直接用 `parent` 摘（而不是 `app.stage`），
         * 因为 dispose 在另一个作用域里、拿不到 `app`。
         * 依据：第 596 轮拿改动前的旧日志比对，这类"textureSource 在仍绑定到 shader 时被销毁"的
         * 警告**本身就是既有现象（6 条）**，但直接 `destroy()` 会让它**再多出 2 条**。
         */
        wipeGraphicsEl.parent?.removeChild(wipeGraphicsEl);
        /*
         * `context: false`：**不销毁 GraphicsContext**。
         * 依据：第 596 轮比对旧日志，多出的那 2 条警告不是"挂在树上被销毁"造成的
         * （先 `removeChild` 也没降下来），于是把目标缩到它自己的 context/纹理上。
         */
        wipeGraphicsEl.destroy({ context: false });
        wipeGraphicsEl = null;
      }
      if (glyphLayerEl !== null && glyphFilterEl !== null) {
        glyphLayerEl.filters = [];
        glyphFilterEl.destroy();
        glyphFilterEl = null;
        glyphLayerEl = null;
      }
      // scene 级转场模糊：**先解绑再销毁**（纪律同上面那条，顺序反了会刷 BindGroup 警告）。
      if (worldBlurEl !== null) {
        worldBlurEl.destroy();
        worldBlurEl = null;
      }
      try {
        app.destroy(true, { children: true });
      } catch {
        /* WebGL 上下文没起来（或已经销毁）时 destroy 会抛，这里不该把它冒到 React 上。 */
      }
    };

    void app
      .init({
        backgroundAlpha: 0,
        antialias: true,
        resizeTo: host,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        preference: 'webgl',
        /*
         * **反色滤镜的必要条件**。滤镜声明了 `blendRequired`（要读下层已画好的像素），
         * 而 Pixi 只有在渲染器开了 backBuffer 时才会给出那块快照 —— 否则它只打一条警告，
         * 然后**静默跳过整个滤镜**：字保持原色，看上去像"滤镜没做"，其实是渲染器没配。
         */
        useBackBuffer: true,
      })
      .then(() => {
        if (destroyed) {
          dispose();
          return;
        }
        host.appendChild(app.canvas);
        canvasEl = app.canvas;
        app.canvas.style.width = '100%';
        app.canvas.style.height = '100%';

        // 整幅构图挂在一个容器上，相机变换（位移 / 缩放 / 旋转）只改这个容器。
        const world = new Container();
        /*
         * 面板与缝**每块一个 Graphics**。
         *
         * 不能在同一块 Graphics 上连着 `poly().fill()` 多次：实测路径会累积，第二块开始
         * 填充区域就跟着前面的顶点走，画面上会冒出几块不该存在的矩形（`diagonal-halves` 那一跑
         * 就多出了兜底构图的两块）。每块独立图形之后，顺序与区域都各自清楚。
         */
        /*
         * **两套图层**：为"双 shot 同屏（交接）"做准备。
         *
         * 为什么要两套：三种段落转场都要求**出画与入画两个构图同时在场**（上游是 scene cache ±1），
         * 而我方原先一帧只画一个 shot、对象直接画进共享图层，所以没有"另一个"可放。
         * 每套自带容器，交接位移就施加在**各自的容器**上（相机仍统一在 `world` 上，见下面的 `world.scale` 等）。
         *
         * 本步**只建立机制**：仍只画 A，B 先空着 ⇒ **画面零变化**。
         * 切换绘制目标、以及按 `resolveTemperaAliveShotIndices` 画 1~2 帧，是后续步骤。
         */
        const makeLayerSet = (): {
          container: Container;
          /**
           * 每镜最底那层**满幅纸**（上游 `temperaSceneBuilder.ts:409~413` 的 `paperWash`）。
           *
           * 它在 `blocks` **之前** ⇒ 也落进反色滤镜要读的下层里。第 620 轮补：丢这一层，
           * 画面就只剩构图块，块与块之间的空档会把**外壳背景（模糊封面）**直接露出来 ——
           * 而上游的画面上永远有一层纸色压着，所以同样的"留白"在我们这儿读成了"背景穿帮"。
           */
          wash: Container;
          washFill: Graphics;
          /**
           * 每镜的**方点阵**（上游 `screentone`）：压在纸之上、色块之下。
           * 它**只在画布尺寸变化时重画**（`screentoneKey`），常态每帧零成本 —— 上游是构建时一次，
           * 而我们是每帧重建对象的架构，每帧重画 3000 个方块不值。
           */
          screentone: Graphics;
          screentoneKey: string;
          panel: Container;
          hatch: Container;
          seam: Container;
          stroke: Container;
          /** 超大装饰词层：**在歌词层之前** ⇒ 它是反色滤镜要读的"底图"（上游同序）。 */
          watermark: Container;
          glyph: Container;
          echo: Container;
          /** 主题色字素层：**不挂反色滤镜**，否则色相会被滤镜整体替换掉（上游同序、在最后）。 */
          keyword: Container;
          /*
           * **对象池按层集各一份**。`drawFrame` 内部是"按本帧 seen 反查、把未 seen 的节点
           * `destroy()` 并出池"的做法（见装饰词池那段）。若两个 shot 共用一份池，
           * **后一个 shot 的清场会把前一个刚画上的节点销毁掉**，同屏就只剩一个了。
           * 所以池跟着层集走，绘制前随 `targetLayers` 一起切换。
           */
          glyphPool: Map<string, TemperaGlyphNodes>;
          /** 页边散字：直接进 `glyph` 层（参与反色），所以与装饰词分两个池。 */
          fragmentPool: Map<string, Text>;
          watermarkPool: Map<string, Text>;
          styleCache: Map<string, TextStyle>;
        } => {
          const wash = new Container();
          // 满幅纸只需要一个 `Graphics`：每帧 `clear` + 一个矩形，成本可忽略，不必进池。
          const washFill = new Graphics();
          const screentone = new Graphics();
          wash.addChild(washFill, screentone);
          const panel = new Container();
          const hatch = new Container();
          const seam = new Container();
          const stroke = new Container();
          const watermark = new Container();
          const glyph = new Container();
          const echo = new Container();
          const keyword = new Container();
          const container = new Container();
          /*
           * z 序照上游 `temperaSceneBuilder.ts:502~510`（我们只少了图片层）：
           * 色块 → 网线 → 缝 → 线条 → **装饰词** → 歌词（反色层）→ 回响 → **主题色字素（keyword）**。
           *
           * 三条不能弄反：
           * · **装饰词在歌词之前** ⇒ 它落进反色滤镜采样的下层，于是歌词压过它的笔画时会**翻色**；
           *   第 617 轮改过来之前它在歌词**之后**，等于把装饰画成了"第二层歌词"；
           * · **回响在歌词之后** ⇒ 它不挂滤镜，压在上面才不会被改色；
           * · **keyword 最后** ⇒ 第 618 轮接的：被主题色着色的字素走这一层（不挂滤镜），
           *   排在最后是因为它必须压在上面 —— 它连反色都不用参与。
           */
          container.addChild(wash, panel, hatch, seam, stroke, watermark, glyph, echo, keyword);
          return {
            container,
            wash,
            washFill,
            screentone,
            screentoneKey: '',
            panel,
            hatch,
            seam,
            stroke,
            watermark,
            glyph,
            echo,
            keyword,
            glyphPool: new Map<string, TemperaGlyphNodes>(),
            fragmentPool: new Map<string, Text>(),
            watermarkPool: new Map<string, Text>(),
            styleCache: new Map<string, TextStyle>(),
          };
        };
        const layersA = makeLayerSet();
        const layersB = makeLayerSet();
        /*
         * 反色滤镜只挂**主层集**的 glyph 层，所以 `glyphLayer` 仍单独解构出来供滤镜记账用；
         * 其余五个层不再直接引用 —— 绘制一律走下面的 `targetLayers`（双 shot 时按帧切换 A / B）。
         */
        const { glyph: glyphLayer } = layersA;
        /** 本帧把对象画进哪一套图层。第 ③ 步（帧循环画 1~2 个 shot）才会真正切换它。 */
        let targetLayers = layersA;
        /*
         * 歌词层挂**反色滤镜**：它采样下面已经画好的色块，逐像素在墨色/纸色里挑对比更大的那个。
         * 挂在**容器**上而不是每个字形上：一次滤镜胜过几十次，而且字与字之间不会各自为政。
         * 换色（换歌/换主题/换明暗）时重建滤镜 —— 换色很少，重建比就地改 uniform 可靠。
         */
        let glyphFilter: Filter | null = null;
        try {
          glyphFilter = createTemperaDifferenceFilter(pixiModule, {
            ink: stateRef.current.glyph,
            paper: stateRef.current.paper,
          });
          glyphLayer.filters = [glyphFilter];
          glyphLayerEl = glyphLayer;
          glyphFilterEl = glyphFilter;
          host.dataset.temperaFilter = 'on';
        } catch (error: unknown) {
          // 滤镜建不起来就**如实标记并留痕**，不要静默降级（降级后字形会保持原色，肉眼很难判断是"没做"还是"做坏了"）。
          glyphFilter = null;
          host.dataset.temperaFilter = 'build-failed';
          console.error('[pi/tempera] 反色滤镜创建失败', error);
        }
        /*
         * scene 级**转场模糊**：`quality: 4` 取自 `SonnetTheme.tsx:431` 的转场那一只
         * （**不要**误用 credits 的 `quality: 3` 或 haloBlur）。
         *
         * 本轮**只创建、不挂载**（`enabled = false`）⇒ 画面不变。挂载还缺一个前置：
         * 上游的模糊强度来自 `transitionBlurFilter` 的强度通道，而**我方帧规格里目前没有那个通道**
         * （tempera 的转场只有 `block-wipe` / `camera-pan` / `shape-carry`），得先把强度来源补进
         * `temperaFrame.ts` 才能照 `SonnetTheme.tsx:1178~1192` 的范式做状态门控挂/摘。
         * 挂载时它的 `resolution` 应取 `resolveTemperaTransitionBlurResolution(...)`（上游默认 0.75）。
         *
         * 建不起来就**如实留痕，不静默降级**（同下面反色滤镜的做法）。
         */
        try {
          const blur = new BlurFilter({ strength: 0, quality: 4 });
          blur.enabled = false;
          worldBlurEl = blur;
          host.dataset.temperaSceneBlur = 'created';
        } catch (error: unknown) {
          worldBlurEl = null;
          host.dataset.temperaSceneBlur = 'build-failed';
          console.error('[pi/tempera] 转场模糊创建失败', error);
        }
        // 层集 A/B 的 z 序在 `makeLayerSet` 里定（色块 → 网线 → 缝 → 线条 → 装饰词 → 歌词 → 回响）。
        /*
         * **满幅纸搬到 scene 级**（第 662 轮，修「切换亮度骤降」）。
         *
         * 上游的 `paperWash` 是 **container 级、只建一份**（`temperaSceneBuilder.ts:407`
         * "Both are built once"）：它不随 shot 走，所以 hand-off 期间纸的浓度不会变。
         *
         * 我方原来把它做进了 `makeLayerSet` —— 于是 **A / B 两套 layerSet 各有一张满幅纸**，
         * 切换窗口内两张纸叠加（等效 alpha 从 0.35 升到约 0.58）⇒ 画面先被抬高，
         * 旧 shot 一退场又掉回 0.35 ⇒ **亮 → 暗的骤降**。第 661 轮在真实播放里量到的
         * 「12 秒两次大跳变、全是亮→暗、Δ102 / Δ72」正是它。
         *
         * 现在纸单独挂一层、垫在 A / B 之下，`drawFrame` 只画这一份 ⇒ 浓度恒定。
         */
        const worldPaper = new Graphics();
        /*
         * **基础明度块**（第 672 轮，**有意偏离上游**）。
         *
         * 第 671 轮把「背景切换生硬」锁定成：hand-off 期间本来就同屏两个构图（上游 README `:22`
         * 明确如此，不是缺陷），而**我们的构图之间明暗差远大于 folia**
         * （第 658 轮：亮度十分位跨度 81 vs 42；folia 106/123 帧挤在 75~125 的窄带里）。
         * 一个"浅纸为主"的镜和一个"深色满幅"的镜叠在一起 ⇒ 必然先亮后暗。
         *
         * 所以补一层**满幅、低 alpha、取该 shot 色阶深端**的底色，把各镜的整体明度收进窄带。
         * ⚠ 它必须是 **scene 级一份**（不是 per-layerSet）—— 否则 A / B 各画一层，
         * hand-off 时又变成双层叠加，正是第 662 轮修掉的那个毛病。
         * ⚠ 绘制顺序：在纸之上、方点阵之下；逐帧重画（颜色跟着主 shot 走，`clear` 后再画，
         * 即使 `drawFrame` 被调用两次（出画侧 + 主镜）最终留下的也是主镜的色）。
         */
        const worldBase = new Graphics();
        const worldPaperDots = new Graphics();
        const worldPaperLayer = new Container();
        worldPaperLayer.addChild(worldPaper, worldBase, worldPaperDots);
        world.addChild(worldPaperLayer, layersA.container, layersB.container);
        /*
         * **wipe 覆盖块**（`block-wipe` 专用）。
         *
         * 上游把它放在 `overlayContainer` 里、压在场景之上 —— 所以这里直接挂 `app.stage`（不经 `world`），
         * 免得吃到相机变换：它要的是**屏幕坐标下的满幅扫描**。
         * 几何照搬上游 `drawWipe`：**两端带菱形尖的带子**，画在按屏幕对角线尺度的**旋转局部坐标系**里，
         * 因此任何角度都满幅；两端对称的尖让它留在构图的菱形语汇里。
         * ⬜ 注：销毁路径尚未接（`Graphics` 无滤镜，风险低，但按本仓纪律应在 dispose 里 `destroy()`）。
         */
        const wipeGraphics = new Graphics();
        wipeGraphics.visible = false;
        // 挂载点在下面 `app.stage.addChild(world)` **之后**（先挂会被压在字形图层下面）。
        wipeGraphicsEl = wipeGraphics;

        /**
         * 照搬上游 `drawWipe(travel, angle, width, height, color)`：
         * `travel` 0..1 把块**带进来**、1..2 把它**带出另一侧**（一次连续行程，**不中途反向**）；
         * 不在 `(0.001, 1.999)` 内一律隐藏（上游走 `drawWipe(0, ...)`，由这条早退等价实现）。
         */
        const drawTemperaWipe = (
          travel: number,
          angle: number,
          width: number,
          height: number,
          color: ColorSource,
        ): void => {
          if (travel <= 0.001 || travel >= 1.999) {
            if (wipeGraphics.visible) {
              wipeGraphics.clear();
              wipeGraphics.visible = false;
            }
            return;
          }
          const span = Math.hypot(width, height);
          const notch = span * 0.08;
          const length = span + notch * 2;
          const start = -span / 2 - notch + (travel - 1) * length;
          const end = start + length;
          const half = span / 2;
          wipeGraphics.clear();
          wipeGraphics
            .poly([
              start, -half,
              end, -half,
              end + notch, 0,
              end, half,
              start, half,
              start + notch, 0,
            ])
            .fill({ color });
          wipeGraphics.pivot.set(0, 0);
          wipeGraphics.position.set(width / 2, height / 2);
          wipeGraphics.rotation = angle;
          wipeGraphics.scale.set(1, 1);
          wipeGraphics.visible = true;
        };
        app.stage.addChild(world);
        /*
         * **片尾层**：夹在场景与 wipe overlay 之间（上游 `:252 sceneContainer, creditsContainer, overlayContainer`）。
         * 只有存在片尾元数据时才建；内容在**首帧懒建**（色板要吃逐帧 tones）。
         */
        if (hasTemperaCreditsMetadata({ title: songTitle, artist: songArtist, album: songAlbum })) {
          creditsContainer = new Container();
          /*
           * **必须居中**：上游 `adoptCredits` 有 `position.set(width/2, height/2)`，注释也写明
           * "一切都绕容器自身原点绘制，运行时只靠 `position` 居中"。
           * 我第一版漏了这一步 ⇒ 整张海报绕**左上角**排（取证图 `docs/m3-lyric-tempera-credits-probe.png` 正是如此）。
           */
          creditsContainer.position.set(app.screen.width / 2, app.screen.height / 2);
          creditsContainer.visible = false;
          app.stage.addChild(creditsContainer);
        }
        // wipe 覆盖块挂在场景**之上**（上游 overlayContainer 的语义：扫描时压过场景）。
        app.stage.addChild(wipeGraphics);
        /*
         * **印刷颗粒**（第 639 轮搬到这里）。
         *
         * 第 636~638 轮把它画在 `wash`（纸层）上，而层序里 `panel` 是**满幅**的构图块（alpha 0.92~0.96）
         * ⇒ 只要这一镜的块铺满，颗粒就被整层盖住，参数怎么调都看不见（第 638 轮的教训）。
         * 上游是在**整场景**挂 `pixi.NoiseFilter`，所以颗粒落在包括色块在内的每个像素上；
         * 这里用最接近的等价做法：把颗粒画在一张**直接挂在 `app.stage` 最上层**的 Graphics 上 ——
         * 全屏、**不跟随镜头**（噪点本来就不该随构图移动）、且盖得住色块。
         * 仍然是"只在画布尺寸变化时重画"的常驻图形 ⇒ 常态零每帧成本。
         */
        const grainGraphics = new Graphics();
        app.stage.addChild(grainGraphics);
        /*
         * **镜头畸变（lens）**（第 644 轮）。
         *
         * 第 642~643 轮把它接在 `worldFilterScene.baseFilters` 上，可那个对象建在
         * `worldBlurEl !== null` 的条件里（`:1785`）—— 没有转场模糊时压根不创建，滤镜自然没挂上
         * （第 643 轮把 `distortion` 提到量表上限 2 都没看出畸变，原因就在这里）。
         * 现在改成**无条件挂在 `app.stage` 的常驻滤镜**，与颗粒 / 暗角同一条思路：恒在、不听条件。
         *
         * ⚠ `filterArea` 必须钉成视口矩形（上游 `:598`）；`resolution` 必须显式设
         * （上游 `:380~386`：共用工厂不设分辨率会被 Pixi 按容器最低值降到硬 1、整幅变软）。
         * ⚠ 暂时仍取**量表上限 2** 验证通路，确认看得到桶形畸变后再回到上游凝彩默认的 0.3。
         */
        const stageLensEffect = createSonnetLensFilter({ distortion: 0.3, dispersion: 0 });
        stageLensEffect.filter.resolution = app.renderer.resolution;
        app.stage.filterArea = new pixiModule.Rectangle(
          0,
          0,
          app.screen.width,
          app.screen.height,
        );
        /*
         * **舞台对比度（第 690 轮）**：上游后处理链是 `lens → grain → colorMatrix → printFilters`，
         * 其中 colorMatrix 一步带 `contrast`（我们此前只做了 lens 与 grain，`contrast` **整个没实现**）。
         *
         * 这里用它来做一件上游没让它做的事：**降低整幅画面的对比度**。依据是第 673 / 687 / 688 / 689
         * 四次过渡尝试全部失败后得到的结论 —— `jumpSum` 不由过渡参数决定，而由"两个构图各自的
         * 明暗差"决定；既然过渡动不了它，就从**全局色调**上压缩动态范围（这也正是上游把 colorMatrix
         * 放在后处理链里的用意：统一画面的最终色阶）。
         * ⚠ 上游 `contrast` 默认 0 ⇒ 我们给它一个负值属于**有意偏离**，要按两个口径验。
         */
        /*
         * **`contrast` 这条路撤掉了**（第 694 轮）。上游后处理链的 colorMatrix 一步确实带 `contrast`
         * （我方原本整个没实现，第 690 轮才接上），但实测下来它**不能用**：
         *
         *     contrast   6fps 每点   亮度宽度   看图
         *     0         6.36        110        土黄底 / 深棕圆 / 浅灰带，层次清晰（第 679 轮那张）
         *     -0.15     5.78        93         一整片灰褐，**构图已被抹平**（第 694 轮这张）
         *     -0.20     2.42        56         同样抹平
         *     -0.25     2.28        52         同样抹平
         *
         * ⇒ 它只在"把画面压成一片"的时候才明显降低 `jumpSum` —— 那个数字是假的收益。
         * ⇒ 连同第 692 轮的手写矩阵（pixi v8 的 `_loadMatrix` 是 private、`matrix` 不能直接赋值，
         *   赋值会让画面变白），**后处理这条路已经查到底**：pixi 只提供 `contrast / brightness /
         *   saturate / hue` 这几个公开调整，其中只有 `contrast` 能压动态范围，而它一压就抹平。
         *
         * 于是唯一与第 689 轮结论一致、且还有希望的方向是：**在绘制构图块时收窄明度跨度**
         * （改内容，不改后处理）。本行恢复成只有 lens —— 与上游的 `lens → grain → colorMatrix`
         * 相比，我们缺的就是 colorMatrix，但它对我们没有可用档位。
         */
        app.stage.filters = [stageLensEffect.filter];
        const panelPool: Graphics[] = [];
        const hatchPool: Graphics[] = [];
        const seamPool: Graphics[] = [];
        const strokePool: Graphics[] = [];

        const panelNode = (index: number): Graphics => {
          const existing = panelPool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          panelPool[index] = created;
          targetLayers.panel.addChild(created);
          return created;
        };

        const seamNode = (index: number): Graphics => {
          const existing = seamPool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          seamPool[index] = created;
          targetLayers.seam.addChild(created);
          return created;
        };

        const hatchNode = (index: number): Graphics => {
          const existing = hatchPool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          hatchPool[index] = created;
          targetLayers.hatch.addChild(created);
          return created;
        };

        const strokeNode = (index: number): Graphics => {
          const existing = strokePool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          strokePool[index] = created;
          targetLayers.stroke.addChild(created);
          return created;
        };

        // 对象池随层集走（两套各一份，理由见 `makeLayerSet` 的注释）；本轮仍只用 A 那一套。
        let { glyphPool, fragmentPool, watermarkPool, styleCache } = layersA;

        const glyphStyle = (fontPx: number, fill: ColorSource): TextStyle => {
          const key = `${fontPx.toFixed(2)}|${String(fill)}`;
          const cached = styleCache.get(key);
          if (cached !== undefined) return cached;
          const style = new TextStyle({
            /*
             * **追加 emoji fallback**（第 787 轮）。
             *
             * 主人实测：放纯音乐时 **🎵 没出现**。而 `queries.ts:479` 已明确
             * "拿不到歌词不是错误，`hasLyric` 会是 false" ⇒ 逻辑层是通的（单测 + 两处闸门都验过）。
             * ⇒ 剩下的解释就是**字形画不出来**：`🎵` 是 emoji，而主题字体栈里没有 emoji 字体
             *   （整个渲染层 grep `Emoji|emoji` **零命中**）⇒ canvas 只能画出空白或豆腐块。
             *
             * 在字体栈**末尾**追加 emoji 字体：普通文字**行为不变**（fallback 只在缺字形时才用），
             * 🎵 这类字符才有机会真的画出来。这里是**全部字素共用**的样式，只改这一处。
             */
            fontFamily: `${stateRef.current.fontFamily}, 'Segoe UI Emoji', 'Noto Color Emoji', 'Apple Color Emoji', sans-serif`,
            fontSize: fontPx,
            fontWeight: '600',
            fill,
            letterSpacing: 0,
          });
          styleCache.set(key, style);
          return style;
        };

        /**
         * 建一个字素的三个节点（第 615 轮接线）。
         *
         * 顺序照上游：阴影 `addChildAt(shadow, 0)` **垫到 glyph 层最底** ——
         * 每建一个新字素都往 0 位插，于是"全部阴影在底、全部正文在上"这个不变量自动成立。
         *
         * **锚点取中心**（第 616 轮）：上游 `display.anchor.set(0.5)` + `position.set(placement.x, placement.y)`，
         * 帧规格的 `x/y` 也已是**字素中心**。三个节点必须同锚点，否则影子/回响会各偏一半自宽。
         */
        const createGlyphNodes = (glyph: TemperaGlyphSpec): TemperaGlyphNodes => {
          const display = new Text({
            text: glyph.text,
            style: glyphStyle(glyph.fontPx, pixiColor(glyph.color)),
          });
          display.anchor.set(0.5);
          /*
           * 正文 `display` 的去向：**被主题色着色过的字素走 keyword 层**（不挂反色滤镜），
           * 其余进反色层。上游就是这一行：`(placement.color ? keywordLayer : textLayer).addChild(display)`。
           * ⚠ **只影响正文**：下面的阴影拷贝照上游留在 `glyph` 层最底（它不看 `placement.color`），
           * 回响也照上游留在 `echo` 层。
           */
          (glyph.keyword === true ? targetLayers.keyword : targetLayers.glyph).addChild(display);
          // 影子的填色本身无所谓（滤镜会给它上色），按上游用**墨色**建即可。
          const shadow = new Text({
            text: glyph.text,
            style: glyphStyle(glyph.fontPx, pixiColor(stateRef.current.glyph)),
          });
          shadow.anchor.set(0.5);
          targetLayers.glyph.addChildAt(shadow, 0);
          const echoes = Array.from({ length: TEMPERA_ECHO_LAYERS }, () => {
            const echo = new Text({
              text: glyph.text,
              style: glyphStyle(glyph.fontPx, pixiColor(glyph.echoColor ?? glyph.color)),
            });
            echo.anchor.set(0.5);
            echo.visible = false;
            targetLayers.echo.addChild(echo);
            return echo;
          });
          return { display, shadow, echoes };
        };

        /** 收掉三个节点（不销毁）：seek 回退到出场之前时用，避免重影留在画面上。 */
        const hideGlyphNodes = (nodes: TemperaGlyphNodes): void => {
          nodes.display.visible = false;
          nodes.shadow.visible = false;
          nodes.echoes.forEach((echo) => {
            echo.visible = false;
          });
        };

        /** 出池时销毁三个节点（`Text.destroy()` 默认不动共享的 `TextStyle`，池缓存因此安全）。 */
        const destroyGlyphNodes = (nodes: TemperaGlyphNodes): void => {
          nodes.display.destroy();
          nodes.shadow.destroy();
          nodes.echoes.forEach((echo) => echo.destroy());
        };

        /**
         * **可见回响数的历史峰值**（第 615 轮加，只做诊断）。
         *
         * 为什么要峰值而不是当帧值：回响只在**入场窗口**里存在（位移走完就收），
         * 而 UI 冒烟是**随机时刻**采样 `dataset` 的 —— 用当帧值会在窗口外读到 0，
         * 把"接线成功"误判成"没接线"。峰值只要这一跑真的放过入场，就一定 > 0。
         */
        let echoPeakVisible = 0;
        /** 同上，给 keyword 层用（第 618 轮）：主题色字素在长句里可能这一帧恰好没到。 */
        let keywordPeakVisible = 0;
        /** 主 shot 的**入画推进位移**峰值（px，第 621 轮）：稳态为 0，故用峰值当证据。 */
        let shotEnterPeak = 0;
        /** 出画侧 alpha 的**历史最小值**（第 621 轮）：证明它真的跟着 `exit` 淡出去过。 */
        let outgoingAlphaMin = 1;
        /** 全屏颗粒上一次重建用的尺寸键（第 639 轮）。 */
        let grainKey = '';
        /** 方点阵（scene 级纸层）上一次重建用的尺寸键（第 662 轮）。 */
        let dotsKey = '';
        /**
         * **换镜时的底色/纸色交叉淡入**（第 753 轮）。
         *
         * 主人指出症状是「切换时有些晃眼」。根因是满幅纸（`worldPaper`）与基础明度块（`worldBase`）
         * 这两层：它们**覆盖整幅、位于最底层、不参与 A/B 两层的 hand-off 淡入淡出**，
         * 却**每帧按当前主镜的色阶重填** ⇒ 换镜那一帧整幅颜色直接跳掉 = 全屏亮度突变。
         *
         * 修法：换镜后在 `TEMPERA_TONE_MIX_SEC` 内从"上一镜的颜色"插到"这一镜的颜色"。
         * **色差本身不动**（所以画面层次不损失，不会重蹈第 696 / 710 轮那次"压缩色差 ⇒ 画面压平"
         * 的覆辙），只是不再一帧完成。
         *
         * ⚠ 这里**不用 `mixColor`**：它对颜色格式有要求（只认 `rgb()/rgba()`，解析失败会原样返回第一
         * 个参数），一旦色阶给的是别的写法，就会永远停在第一镜的颜色。所以直接在 `pixiColor` 得到的
         * 整数上按通道插值 —— 输入就是当前实际在用的颜色，没有任何解析风险。
         */
        const TEMPERA_TONE_MIX_SEC = 0.45;
        /**
         * 把 `pixiColor` 的返回值（pixi 的 `ColorSource`：可能是数字、`#hex`、`rgb()` 串或 `Color` 对象）
         * 统一取成 `0xRRGGBB` 整数。**不假定格式** —— 逐种情况处理，认不出来就退回黑，不抛错。
         */
        const toColorInt = (value: unknown): number => {
          if (typeof value === 'number') return value >>> 0;
          if (typeof value === 'object' && value !== null) {
            const obj = value as { toNumber?: () => number; toHex?: () => string };
            if (typeof obj.toNumber === 'function') return obj.toNumber() >>> 0;
            if (typeof obj.toHex === 'function') return toColorInt(obj.toHex());
            return 0;
          }
          const text = String(value).trim();
          if (text.startsWith('#')) {
            const hex = text.slice(1);
            const full =
              hex.length === 3
                ? hex
                    .split('')
                    .map((char) => char + char)
                    .join('')
                : hex.slice(0, 6);
            const parsedHex = Number.parseInt(full, 16);
            return Number.isNaN(parsedHex) ? 0 : parsedHex;
          }
          const rgbMatch = /rgba?\(([^)]+)\)/u.exec(text);
          const inner = rgbMatch?.[1];
          if (inner !== undefined) {
            const parts = inner.split(',').map((part) => Number.parseFloat(part));
            const channelR = parts[0] ?? 0;
            const channelG = parts[1] ?? 0;
            const channelB = parts[2] ?? 0;
            if (
              parts.length >= 3 &&
              !Number.isNaN(channelR) &&
              !Number.isNaN(channelG) &&
              !Number.isNaN(channelB)
            ) {
              return (
                (Math.round(channelR) << 16) |
                (Math.round(channelG) << 8) |
                Math.round(channelB)
              );
            }
          }
          return 0;
        };
        const lerpPixiColor = (from: number, to: number, t: number): number => {
          const fr = (from >> 16) & 0xff;
          const fg = (from >> 8) & 0xff;
          const fb = from & 0xff;
          const tr = (to >> 16) & 0xff;
          const tg = (to >> 8) & 0xff;
          const tb = to & 0xff;
          const r = Math.round(fr + (tr - fr) * t);
          const g = Math.round(fg + (tg - fg) * t);
          const b = Math.round(fb + (tb - fb) * t);
          return (r << 16) | (g << 8) | b;
        };
        let toneMixKey = '';
        let toneMixFromPaper = -1;
        let toneMixToPaper = -1;
        let toneMixFromBase = -1;
        let toneMixToBase = -1;
        let toneMixStart = 0;
        /**
         * **换镜探针**（第 756 轮）：主人说「切换……过渡几乎没有就是硬切」，而代码里 A/B 两层
         * 明明是交叉淡入（出画侧 `alpha = outgoingEffect.alpha × exitFade`、入画侧 `= enteringEffect.alpha`）。
         * 所以要么"入画侧在**段落内**换镜时 `enteringEffect.alpha` 恒为 1"（一帧就满 ⇒ 硬切感），
         * 要么"两镜长得太像，淡了也看不出来"。
         * 这条探针把**换镜那一刻**的几个 alpha 与位移直接打出来，用数据分辨，而不是再靠猜。
         */
        let lastShotProbeId = '';
        let shotChangeLogs = 0;
        /**
         * 「被选中的 shot 时间还没到（`timeSec < startTime`）」这件事第一次发生在哪（第 709 轮）。
         *
         * 这是第 708 轮排除法剩下的唯一解释：`delay` 最大 0.28s、`span` 正常，所以
         * 能让一整个 shot 的块全停在 alpha 0 的只有 `elapsed = timeSec − shotStartTime < 0`。
         * 若这条日志出现，第 707 轮那张"只剩装饰字"的画面就定案了。
         */
        let elapsedNegativeLogged = false;
        /**
         * 散字"有多少落在画内"量一次（第 730 轮）。
         *
         * 第 729 轮发现：凝彩探针说**字素=7**，而同歌同帧的截图里肉眼只数得出 3 个字符
         * ⇒ 怀疑**大量散字落在舞台之外**（坐标越界）。这条日志把每镜的散字坐标与
         * in-view 计数打出来，一眼可判。
         */
        let fragmentsLogged = false;
        /**
         * 「主层几乎不可见」这件事第一次发生在哪（第 667 轮诊断）。
         *
         * 第 664 轮抓到过"凝彩只剩装饰字 + 外壳背景"的画面，而第 666 轮又用日志否掉了
         * "shot 时间轴有空档"的假设（`alive=2`、兜底从未触发）⇒ 剩下的解释是：
         * **那一帧活着的两个 shot，可见度都接近 0**（一个入场还没开始、一个退场已经结束）。
         * 这条日志用来证实/否证它：把主层 alpha 与出画侧 alpha 一起打出来。
         */
        let faintPrimaryLogged = false;
        /**
         * 「两侧都可见、却没有分开」这件事第一次发生在哪（第 670 轮诊断）。
         *
         * 第 668 轮怀疑"两个 shot 完全重叠"，第 669 轮读结构后**排除了那个可能**（位移是设了的），
         * 但结构对不代表运行时对 ⇒ 这条日志直接回答它：出画侧可见（`visible = true`）时，
         * A / B 的像素距离如果还是接近 0，就说明那一刻位移没生效。
         */
        let overlapLogged = false;
        /** 两侧容器的**分离度峰值**（px，第 623 轮诊断）。 */
        let handoffSepPeak = 0;
        /** 诊断打印用的上一次已记峰值（降噪用）。 */
        let handoffSepLogged = 0;

        const drawFrame = (current: TemperaFrame, timeSec: number): void => {
          /*
           * 诊断：把**最近一帧**的统计写到根节点的 data 属性上，供 UI 冒烟读。
           * 为什么不是"冒烟自己去 canvas 读像素"：Pixi 的 WebGL 画布默认
           * `preserveDrawingBuffer: false`，在 rAF 之外 `toDataURL()` / `getImageData()` 只会拿到空白，
           * 那会把「画出来了」判成「没画」。像素级证据由主进程 `capturePage` 截图提供。
           */
          let glyphVisibleCount = 0;
          let echoVisibleCount = 0;
          let keywordVisibleCount = 0;
          host.dataset.temperaPanels = String(current.panels.length);
          host.dataset.temperaStrokes = String(current.strokes.length);
          host.dataset.temperaGlyphs = String(current.glyphs.length);
          /*
           * **本帧字素落在几个排版行上**（第 623 轮，诊断"叠字"到底是哪一种）：
           * `1` ⇒ 这一帧只有一行字 ⇒ 主人看到的叠字是**两个 shot 撞在一起**（hand-off 问题）；
           * `>1` ⇒ 同一 shot 内部把多行排到了同一个 y（排版问题）。两种情况修法完全不同。
           */
          host.dataset.temperaRows = String(
            new Set(current.glyphs.map((glyph) => glyph.lineIndex ?? 0)).size,
          );
          host.dataset.temperaFallback = current.fallback ? 'true' : 'false';
          host.dataset.temperaKind = current.shotKind;
          host.dataset.temperaTones = current.tones.tone.join('|');
          host.dataset.temperaColors = `${current.tones.paper}/${current.tones.deep}`;
          host.dataset.temperaViewport = `${Math.round(app.screen.width)}x${Math.round(app.screen.height)}`;
          // 第一块面板的顶点（诊断用：构图到底画在哪儿）。
          host.dataset.temperaFirstPanel = (current.panels[0]?.points ?? [])
            .map((value) => Math.round(value))
            .join(',');

          // 相机：x / y 是视口比例 ⇒ 乘视口尺寸；缩放与旋转直接叠在容器上。
          const viewW = app.screen.width;
          const viewH = app.screen.height;
          world.position.set(current.camera.x * viewW, current.camera.y * viewH);
          world.scale.set(current.camera.scale);
          world.rotation = current.camera.rotation;

          /*
           * 池是**按需建**的（`panelNode(index)` 只在该 index 真的用到时创建），所以它们是**稀疏数组**：
           * `for...of` 会连空槽一起遍历，拿到 `undefined` 再 `.clear()` 就抛 TypeError
           * —— 实测那句话把整帧绘制打断，画面上是一片"什么都没画"，而数据集里面板数是好的，极难查。
           * `forEach` 会跳过空槽，这里必须用它。
           */
          /*
           * **满幅纸**（上游 `paperWash`，第 620 轮补）：每镜最底一层，铺满整个 shot、压在色块之下。
           * 扩散量按视口长边量取 —— 相机位移与缩放都不该让它露边。
           */
          /*
           * 扩边必须**远大于**相机与交接的位移之和：第 621 轮的族图在顶部与右侧各露出一条
           * 青绿色的封面背景（那条色**不在色阶里**，色阶全是棕灰 ⇒ 它只能是外壳背景），
           * 说明 0.75 倍长边不够 —— 相机位移（±0.1 视口）＋ `handoff` 的 `span × 0.55`
           * （`span = max(w, h)`）＋ 相机缩放/旋转叠起来能吃掉近一倍长边。取 3 倍，成本只是一个更大的矩形。
           */
          const washBleed = Math.max(viewW, viewH) * 3;
          /* 换镜 ⇒ 记下"从哪一色淡到哪一色"（第 753 轮；理由见 `dotsKey` 上面那段注释）。 */
          const paperTargetColor = toColorInt(pixiColor(current.tones.paper));
          const baseTargetColor = toColorInt(
            pixiColor(current.tones.tone[1] ?? current.tones.deep),
          );
          /*
           * ⚠ 只在「**真的换镜**」或「颜色**明显**变了」时才重启淡入（第 130 轮防抖）。
           *
           * 第 753 轮我写的是 `toneMixToPaper !== paperTargetColor` —— **太敏感**：只要色阶逐帧微抖，
           * 这个条件就每帧成立 ⇒ 颜色一直"追着跑、永远淡不完" ⇒ **看上去就是背景在抖**
           * （正对应主人第 2 条「背景元素没咋变化也在**抖啊抖**」）。
           * 现在改成带滞回：三通道差值之和超过 36（约每通道 12）才算"换了颜色"。
           */
          const toneMixDelta =
            Math.abs(((toneMixToPaper >> 16) & 0xff) - ((paperTargetColor >> 16) & 0xff)) +
            Math.abs(((toneMixToPaper >> 8) & 0xff) - ((paperTargetColor >> 8) & 0xff)) +
            Math.abs((toneMixToPaper & 0xff) - (paperTargetColor & 0xff));
          if (toneMixKey !== current.shotId || toneMixDelta > 36) {
            toneMixKey = current.shotId;
            toneMixFromPaper = toneMixToPaper < 0 ? paperTargetColor : toneMixToPaper;
            toneMixFromBase = toneMixToBase < 0 ? baseTargetColor : toneMixToBase;
            toneMixToPaper = paperTargetColor;
            toneMixToBase = baseTargetColor;
            toneMixStart = timeSec;
          }
          const toneMixT = clamp01((timeSec - toneMixStart) / TEMPERA_TONE_MIX_SEC);
          const paperFillColor = lerpPixiColor(toneMixFromPaper, toneMixToPaper, toneMixT);
          /*
           * **取当前镜头的"色相"，把亮度定到与画面齐平，写给页面底色那层**（第 830 轮）。
           *
           * 为什么需要：凝彩的纸是带 alpha 画的 ⇒ 画布半透明 ⇒ **构图没覆盖到的顶部**
           * 会露出画布背后的页面底色。实测：底色近黑时顶部亮度 26、中性中间调 80、亮灰 107
           * （画面中部始终 ~82）⇒ 顶部偏暗/偏色的根就在这层底色上。
           *
           * 两条弯路（都实测过、都不够）：
           * ① 固定中性灰 ⇒ 亮度对得上，但换到浓烈配色的帧会显出一条**无彩色**的带；
           * ② 直接跟随镜头纸色 ⇒ 色相对了，但这一镜纸色本身偏暗（顶部掉到 30）✗
           * ⇒ 正解是**两者取长**：保留镜头的色相与色比，只把整体亮度缩放到目标值。
           *
           * 写在**文档根**上（不是画布根）：CSS 变量只向下继承，用它的规则挂在 `.pi-app::before`
           * —— 那是画布的**祖先层**，写在画布上它读不到 ✗ 这个坑我踩过一次。
           * `TEMPERA_BASE_LUM` 是目标亮度（画面中部的量级 ~82），观感不对可调。
           */
          /*
           * 目标亮度**按这一镜自己算**（第 831 轮）：取本镜色阶那几个色（画面主体的颜色）
           * 的亮度平均。上一版把它写死成 80，那是我那一帧画面中部的量级 ⇒ 碰到更亮的画面
           * （浅色纸 + 颗粒）顶部就相对偏暗、更暗的画面又偏亮 ✗ 主人反馈"颜色对了但是很暗"就是这个。
           */
          const temperaToneLum = (color: string): number => {
            const rgb = parseRgb(resolveCssColor(rootRef.current ?? document.documentElement, color));
            return rgb === null ? 0 : 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
          };
          const temperaToneList = [
            current.tones.paper,
            current.tones.tone[0] ?? current.tones.paper,
            current.tones.tone[1] ?? current.tones.paper,
            current.tones.tone[2] ?? current.tones.paper,
            current.tones.tone[3] ?? current.tones.paper,
          ];
          /*
           * 唯一的调校旋钮：目标亮度的**乘系数**（第 832 轮）。
           * 实测：系数 1.0 时顶部 86.7、画面中部 77.0（顶部偏亮约 10）⇒ 取 0.9 找齐平。
           * 主人若说"还暗/偏亮"，只改这一个数即可。
           */
          /*
           * 深浅两套系数（第 836 轮）。深色用 0.9（实测顶部/中部差 1.6，已在颗粒噪声内）；
           * 浅色模式实测顶部比画面**暗 30**（156.6 对 186.3）⇒ 关系式是在深色下标定的、浅色不成立，
           * 先把系数抬到 1.25，再在自己这台浅色画面上量着校准。
           */
          const TEMPERA_BASE_LUM_SCALE = 0.9;
          const TEMPERA_BASE_LUM_SCALE_LIGHT = 1.1;
          const temperaIsDark =
            document.documentElement.dataset.theme === 'dark' ||
            document.body?.dataset.theme === 'dark';
          const temperaBaseLum = Math.min(
            220,
            Math.max(
              30,
              (temperaToneList.reduce((sum, c) => sum + temperaToneLum(c), 0) / temperaToneList.length) *
                (temperaIsDark ? TEMPERA_BASE_LUM_SCALE : TEMPERA_BASE_LUM_SCALE_LIGHT),
            ),
          );
          const paperR = (paperFillColor >> 16) & 0xff;
          const paperG = (paperFillColor >> 8) & 0xff;
          const paperB = paperFillColor & 0xff;
          const paperLum = 0.2126 * paperR + 0.7152 * paperG + 0.0722 * paperB;
          const paperScale = paperLum <= 1 ? 1 : temperaBaseLum / paperLum;
          const clampChannel = (value: number): number =>
            value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
          const temperaBaseHex =
            '#' +
            [paperR * paperScale, paperG * paperScale, paperB * paperScale]
              .map((v) => clampChannel(v).toString(16).padStart(2, '0'))
              .join('');
          const rootStyle = document.documentElement.style;
          if (rootStyle.getPropertyValue('--pi-tempera-base') !== temperaBaseHex) {
            rootStyle.setProperty('--pi-tempera-base', temperaBaseHex);
          }
          const baseFillColor = lerpPixiColor(toneMixFromBase, toneMixToBase, toneMixT);
          worldPaper.clear();
          worldPaper
            .rect(-washBleed, -washBleed, viewW + washBleed * 2, viewH + washBleed * 2)
            /*
             * 纸保持上游的 `TEMPERA_PAPER_WASH_ALPHA`（第 682 轮 A/B 结论）。
             * 试过减半：6fps 每点 6.35 → 6.29、30fps 1595 → 1560，**两个口径方向一致但只有 1~2%**，
             * 接近噪声级 ⇒ 不值得为它偏离上游 ⇒ 撤回。
             */
            /*
             * 纸保持上游的 `TEMPERA_PAPER_WASH_ALPHA`（第 682 / 684 轮两次 A/B 结论）。
             *
             *     减半（0.175）：6fps 每点 6.35 → 6.29、30fps 1595 → 1560   ⇒ 只有 1~2%，噪声级
             *     0.2（本次）  ：6fps 每点 6.35 → 6.72、30fps 1595 → 1612   ⇒ 反而变差
             *     两次的亮度均值：111.2 → （减半未记）→ 110.9               ⇒ **几乎不动**
             *
             * ⇒ 纸既不能收敛"抖"，也**不是画面偏亮的主因**（减 43% 只让均值降 0.3）。
             * 想变"沉"得从**构图块的取色档位**（`tones.tone[...]`）入手 —— 见 `docs/CREDITS.md` 第 684 轮。
             */
            .fill({ color: paperFillColor, alpha: TEMPERA_PAPER_WASH_ALPHA });
          /*
           * 基础明度块（第 672 轮）：满幅、低 alpha、取该 shot 色阶深端 ⇒ 把各镜的整体明度收窄。
           * 见上面 `worldBase` 那条注释（为什么必须是 scene 级一份、为什么逐帧重画）。
           */
          worldBase.clear();
          worldBase
            .rect(-washBleed, -washBleed, viewW + washBleed * 2, viewH + washBleed * 2)
            .fill({
              color: baseFillColor,
              /*
               * 第 677 轮 A/B 的结论：**留着**。
               * 关闭它（alpha 0）时 30 秒采样的 `jumpSum` 从 1802 涨到 **2306**（+28%），
               * 6fps 口径的每点平均从 8.05 涨到 8.71 ⇒ 这一层确实在收敛明暗波动。
               * （第 672 轮我拿旧的 `big` 指标看只降了 10%，是判据的问题，不是它的贡献小。）
               */
              /*
               * **0.75 是拐点**（第 681 轮扫出来的）。四档的 6fps 每点平均：
               *
               *     关闭 8.71 ｜ 0.45 → 8.05 ｜ 0.6 → 7.37 ｜ **0.75 → 6.35** ｜ 0.9 → 6.63
               *
               * ⇒ 0.75 之后**不再改善**（0.9 在两个口径上方向相反：30fps 1583 略好于 1595、
               * 6fps 1186 反而差于 1137 ⇒ 落进噪声级），说明再压只会开始**压平构图**。
               * 所以定在 0.75；图上确认过大块 / 对比 / 网点 / 字四样层次都还在。
               */
              /*
               * **0.75**：`jumpSum` 的拐点，同时 0.85 也证明它压不动均值。
               *
               * 四档的 6fps 每点平均：关闭 8.71 ｜ 0.45 → 8.05 ｜ 0.6 → 7.37 ｜ **0.75 → 6.35** ｜ 0.85 → 6.74。
               *
               * 第 683 轮试 0.85 时**同时记了亮度均值**：0.75 → 111.2、0.85 → **110.9**
               * ⇒ 提高这一层**几乎不改变整体亮度**（因为基底之上还压着满幅纸 0.35 和构图块）。
               * ⇒ 想压暗画面（folia 均值约 80、我们约 111）得动**纸**或色阶，不是这一层。
               * ⚠ 所以这一层只解决"抖"，不解决"沉" —— 别指望它兼任。
               */
              /*
               * **0.75**：`jumpSum` 的拐点；而且在新判据（Δ>30 的次数）下它是最好的缓解手段。
               *
               * 第 710 轮用新判据补做了一次 A/B（第 677 轮那次是在旧的 `jumpSum` 下做的）：
               *
               *     开启（0.75）：jumpSum 1560、**big(Δ>30) 10~13**
               *     关闭（0）   ：jumpSum 2132、**big(Δ>30) 21**      ← 骤降次数翻倍
               *
               * ⇒ 这一层把"画面从很亮骤降到中暗"的次数**减半**，方向毫无疑问是对的。
               * ⇒ 它做的是"把各镜的平均明度往中间拉"，所以压的是**镜间差**（低频）；
               *    第 697 轮的分解说过，剩余的抖动量主要来自**镜内**（63%），那一半它管不到。
               * ⚠ 第 683 轮量过：把 alpha 提到 0.85 反而更差（均值几乎不动、`jumpSum` 涨），所以定在 0.75。
               */
              alpha: 0.75,
            });
          host.dataset.temperaWash = 'on';
          /*
           * 方点阵（上游 `screentone`，第 620 轮补）：压在纸之上、色块之下，给整幅一层印刷网点。
           *
           * **只在画布尺寸变化时重建**：上游是构建时一次，而我们是"每帧重建对象"的架构 ——
           * 每帧重画 3000 个方块不值，而点阵本身只跟视口有关、与时间无关。
           * ⚠ 铺的是**画布尺寸**（上游也是 `buildDotGrid(width, height, …)`），不像纸那样要扩边。
           */
          const nextScreentoneKey = `${Math.round(viewW)}x${Math.round(viewH)}`;
          if (dotsKey !== nextScreentoneKey) {
            dotsKey = nextScreentoneKey;
            worldPaperDots.clear();
            const spacing = resolveTemperaScreentoneSpacing(viewW, viewH);
            const marks = buildDotGrid(viewW, viewH, spacing, TEMPERA_SCREENTONE_SIZE);
            for (const mark of marks) {
              const half = mark.size / 2;
              worldPaperDots.rect(mark.x - half, mark.y - half, mark.size, mark.size);
            }
            worldPaperDots.fill({
              // 上游用的是 `palette.tone4`（= 我们色阶第 4 档）。
              color: pixiColor(current.tones.tone[3] ?? current.tones.paper),
              alpha: TEMPERA_SCREENTONE_ALPHA,
            });
            /*
             * **印刷颗粒**（第 635 轮的简化实现，理由见 `buildGrainMarks` 的长注释）：
             * 上游是在整场景挂 `pixi.NoiseFilter({ noise: tuning.postProcessGrain * 0.35 })`；
             * 我们改成在纸层上直接撒**确定性**小点 —— 观感一致（那层印刷质感），
             * 但**不引入第二层全屏滤镜**，也就不会夺走反色滤镜要用的 backdrop 拷贝。
             * 与方点阵共用同一个"只在尺寸变化时重建"的 Graphics ⇒ 常态零每帧成本。
             */
            const grainMarks = buildGrainMarks(9176, viewW, viewH, 40);
            /*
             * **亮的一半**（第 637 轮修正）：上一版把整批点都填成 `tone[1]` —— 而底色本来就偏深，
             * 深点落在深底上等于"同色噪声"，`docs/m3-lyric-tempera-split.png` 因此看不出颗粒。
             * 印刷颗粒在暗底上的常态是**亮点压暗点**，所以这里按奇偶分成两批：
             * 偶数索引填浅端（`tone[3]`）、奇数索引填深端（`tone[0]`），两边都带一点不透明度。
             */
            for (let index = 0; index < grainMarks.length; index += 2) {
              const mark = grainMarks[index];
              if (mark === undefined) continue;
              const half = mark.size / 2;
              worldPaperDots.rect(mark.x - half, mark.y - half, mark.size, mark.size);
            }
            worldPaperDots.fill({
              /*
               * 亮批改用**墨色（`current.glyph`，近白）**而不是色阶第 4 档：色阶档位与底色可能很接近，
               * 一旦贴近颗粒就整个看不见（第 637 轮取 `tone[3]` @0.1 时可见，调到 0.08 就消失了）。
               * 墨色是色阶的极值端，无论在深底还是浅底上都必然与底色拉开差。
               */
              color: pixiColor(stateRef.current.glyph),
              alpha: 0.05,
            });
            for (let index = 1; index < grainMarks.length; index += 2) {
              const mark = grainMarks[index];
              if (mark === undefined) continue;
              const half = mark.size / 2;
              worldPaperDots.rect(mark.x - half, mark.y - half, mark.size, mark.size);
            }
            worldPaperDots.fill({
              color: pixiColor(current.tones.tone[0] ?? current.tones.paper),
              alpha: 0.09,
            });
            /*
             * **全屏颗粒**（第 639 轮）：真正要的是这一份 —— 挂在 `app.stage` 最上层，覆盖色块与字，
             * 不受满幅块遮挡（第 638 轮的架构问题）。亮暗两批，颜色取**色阶两端**
             * （墨色 = 极值端，保证在任何底色上都拉得开差）。
             */
            const nextGrainKey = `${Math.round(viewW)}x${Math.round(viewH)}`;
            if (grainKey !== nextGrainKey) {
              grainKey = nextGrainKey;
              grainGraphics.clear();
              const fullMarks = buildGrainMarks(9176, viewW, viewH, 40);
              for (let index = 0; index < fullMarks.length; index += 2) {
                const mark = fullMarks[index];
                if (mark === undefined) continue;
                const half = mark.size / 2;
                grainGraphics.rect(mark.x - half, mark.y - half, mark.size, mark.size);
              }
              grainGraphics.fill({
                color: pixiColor(stateRef.current.glyph),
                alpha: 0.05,
              });
              for (let index = 1; index < fullMarks.length; index += 2) {
                const mark = fullMarks[index];
                if (mark === undefined) continue;
                const half = mark.size / 2;
                grainGraphics.rect(mark.x - half, mark.y - half, mark.size, mark.size);
              }
              grainGraphics.fill({
                color: pixiColor(stateRef.current.deep),
                alpha: 0.09,
              });
              /*
               * **暗角**（第 641 轮）：上游后处理链里 print 那一层带 `vignette: 0.85`
               * （`temperaSceneBuilder.ts:373~377`，默认 tuning `folia__types.ts:578`）。
               * 真滤镜那版要处理"与反色滤镜争 backdrop 拷贝"（上游靠 `container.filterArea`，
               * `:598`），在 context 很紧的当下先上**观感等价、零渲染风险**的做法：
               * 由外向内描 24 圈矩形、alpha 逐圈递减 ⇒ 边缘自然压暗，与 vignette 同向。
               * 与颗粒共用同一张"只在尺寸变化时重建"的 Graphics ⇒ 常态零每帧成本。
               */
              const vignetteBands = 24;
              const vignetteDepth = Math.min(viewW, viewH) * 0.34;
              for (let band = 0; band < vignetteBands; band += 1) {
                const ratio = band / (vignetteBands - 1);
                const inset = ratio * vignetteDepth;
                grainGraphics.rect(inset, inset, viewW - inset * 2, viewH - inset * 2);
                grainGraphics.stroke({
                  color: '#000000',
                  alpha: 0.06 * (1 - ratio),
                  width: 5,
                });
              }
            }
          }
          host.dataset.temperaScreentone = dotsKey;

          panelPool.forEach((node) => node?.clear());
          hatchPool.forEach((node) => node?.clear());
          seamPool.forEach((node) => node?.clear());
          strokePool.forEach((node) => node?.clear());

          const elapsed = timeSec - current.shotStartTime;
          const toneColor = (tone: number): ColorSource =>
            pixiColor(current.tones.tone[tone] ?? current.tones.paper);
          current.panels.forEach((panel, index) => {
            const progress = enterProgress(elapsed, panel.delay, panel.span, current.shotLyricDuration);
            if (progress <= 0) return;
            /*
             * **入场必须走 `easeTemperaEnter`**（第 620 轮）：上游 `temperaBlocks.ts:133~134`
             * 把缓动后的 `enter` **同时**用在位置、不透明度与网线覆盖率上；
             * 我们此前三处都用线性的 `progress` ⇒ 同一个窗口里面板要"淡"得久得多
             * （半途才 0.5 不透明度），观感就是**画面迟迟不饱满、大片透出外壳背景**。
             */
            const enter = easeTemperaEnter(progress);
            const shiftX = panel.enter[0] * (1 - enter);
            const shiftY = panel.enter[1] * (1 - enter);
            const fill = current.tones.tone[panel.tone] ?? current.tones.paper;
            /*
             * 位移交给 `position`、旋转交给 `pivot` + `rotation`，**顶点保持绝对坐标不再搬**。
             * 这样同一块面板的网线天然跟着一起转（下面复用了同一套变换），
             * 也给 poster 族那种"绕锚点斜过来的重块"留出了入口。
             */
            const applyTransform = (node: Graphics): void => {
              if (panel.pivot === null) {
                node.pivot.set(0, 0);
                node.position.set(shiftX, shiftY);
              } else {
                node.pivot.set(panel.pivot[0], panel.pivot[1]);
                node.position.set(panel.pivot[0] + shiftX, panel.pivot[1] + shiftY);
              }
              node.rotation = panel.rotation;
            };
            const panelGraphics = panelNode(index);
            applyTransform(panelGraphics);
            panelGraphics
              .poly([...panel.points])
              /*
               * **构图主体块不做 alpha 淡入 —— 对齐上游**（第 715 轮定稿）。
               *
               * A/B（同一固定段落 `play=73.00`，30 秒采样）：
               *
               *     `alpha * enter`（从 0 淡入到满）        ：jumpSum **1575**、big **10~14**
               *     `alpha * (0.85 + 0.15 * enter)`（15%）  ：jumpSum **1533**、big **13**
               *     `alpha`（**恒定**）                     ：jumpSum **775**、big **5**
               *
               * ⇒ **只要 alpha 有可见的淡入（哪怕只有 15%），骤降就回来** —— 因为这是构图主体块，
               * 面积最大、`alpha` 又深（0.92~0.96），整幅平均亮度会跟着走一遍。
               *
               * ⇒ 上游本来就是"**几乎立即出现**"：`.folia-ref/tempera__temperaSceneBuilder.ts:286` 的
               * `add(..., { delay: 0.68, grow: 0.06 })` 里入场参数是 **`grow`（生长 6%）**，
               * **根本没有 alpha 淡入**。所以"恒定 alpha"不是牺牲观感，而是**对齐上游**。
               * （上游那 6% 的生长只影响面积、不动整层 alpha，可以将来补；
               * 注意 `enter` 仍在上面给 `shiftX/shiftY` 用，位移入场保留。）
               */
              .fill({ color: pixiColor(fill), alpha: panel.alpha * enter });
            /*
             * 冲孔：把孔从**刚才那次填充**里减掉（Pixi v8 的 `cut()`），孔的位置就真的透出外壳背景，
             * 而不是"在洞上盖一块别的东西"。
             */
            for (const hole of panel.holes) {
              if (hole.length >= 6) panelGraphics.poly([...hole]).cut();
            }
            /*
             * 网线（folia 的 `drawHatchFill`）：把这块多边形填成平行线。
             * `grow` 的那一层从形状中心长开，所以覆盖率跟着入场进度走 —— 不是整块突然出现。
             */
            if (panel.hatch === null) return;
            const coverage = panel.hatch.grow ? Math.min(1, enter * 1.6) : 1;
            const hatchLines = hatchLinesOf(panel.points, panel.hatch, coverage);
            if (hatchLines.length === 0) return;
            const graphics = hatchNode(index);
            applyTransform(graphics);
            for (const hatchLine of hatchLines) {
              graphics.moveTo(hatchLine.x1, hatchLine.y1).lineTo(hatchLine.x2, hatchLine.y2);
            }
            graphics.stroke({
              color: toneColor(panel.hatch.tone),
              /*
               * **hatch 不做整层淡入 —— 对齐上游**（第 714 轮，**这一处就是"生硬"的主因**）。
               *
               * 先看证据：`.folia-ref` 里 hatch 的入场参数是
               *     `add(drawHatchFill(...), { delay: 0.68, grow: 0.06 })`   （temperaSceneBuilder.ts:286）
               *     `ctx.add(drawHatchFill(...), { ... })`                    （temperaSplitCompositions.ts:24）
               * ⇒ 上游用的是 **`grow: 0.06`**（**轻微生长**，6%），**根本没有"整层 alpha 从 0 淡入"**；
               * 斜线是**立即出现、再轻微长一点**。
               *
               * 而我方写的是 `alpha: panel.hatch.alpha * enter`：整层**从 0 一路涨到满**。
               * 由于 hatch 是**满幅密线、且用墨色**，这等于每一镜都给整幅画面叠一次可见的加深
               * ⇒ A/B 实测（第 713 轮）：关掉它，`jumpSum` 1575 → **593**、`big(Δ>30)` 10~14 → **2**
               *   （folia 基准是 **0**）。
               *
               * ⚠ 我第 713 轮曾以为"关掉会让斜线瞬间出现、是主人要的过渡的反面" —— **那是错的**：
               * 上游本来就是"立即出现 + 微生长"，所以**去掉整层淡入恰恰是向 folia 靠拢**。
               * （上游那 6% 的 `grow` **已经接上了** —— 见上面 `:1435` 的 `coverage`：
               * `grow: true` 的 hatch 覆盖率随入场按 1.6 倍速长到 1，用"从中心长开"代替"整块出现"。
               * ⚠ 第 747 轮更正：此处原写"将来可以补上"，其实早就补上了，是注释与代码不符。）
               */
              alpha: panel.hatch.alpha * enter,
              width: panel.hatch.spec.width,
            });
          });

          current.seams.forEach((seam, index) => {
            const progress = enterProgress(elapsed, seam.delay, 0.5, current.shotLyricDuration);
            if (progress <= 0) return;
            seamNode(index)
              .poly([...seam.points])
              .fill({ color: pixiColor(current.tones.deep), alpha: 0.85 * easeTemperaEnter(progress) });
          });

          /*
           * 线条 / 折线（folia 的 `drawLines` / `drawPolyline`）：band 族的引导线与波浪边靠它。
           * 每一条折线一个 `Graphics`，内部用连续的 `moveTo / lineTo` 再一次性 `stroke`。
           */
          current.strokes.forEach((stroke, index) => {
            const progress = enterProgress(elapsed, stroke.delay, stroke.span, current.shotLyricDuration);
            if (progress <= 0) return;
            const strokeEnter = easeTemperaEnter(progress);
            const shiftX = stroke.enter[0] * (1 - strokeEnter);
            const shiftY = stroke.enter[1] * (1 - strokeEnter);
            const points = stroke.points;
            if (points.length < 4) return;
            const graphics = strokeNode(index);
            graphics.pivot.set(0, 0);
            graphics.position.set(shiftX, shiftY);
            graphics.rotation = 0;
            graphics.moveTo(points[0] ?? 0, points[1] ?? 0);
            for (let cursor = 2; cursor + 1 < points.length; cursor += 2) {
              graphics.lineTo(points[cursor] ?? 0, points[cursor + 1] ?? 0);
            }
            if (stroke.closed) graphics.closePath();
            graphics.stroke({
              color: toneColor(stroke.tone),
              alpha: stroke.alpha * strokeEnter,
              width: stroke.width,
            });
          });

          /*
           * **每镜共享的「贯穿斜线」**（第 741 轮补上）。
           *
           * 这是第 737 / 738 轮查出来的一条真差距：上游在 `temperaSceneBuilder.ts:266` 用
           * `buildCrossingLines(seed, 31, width, height, 2)` **给每一镜都画两条贯穿全幅的浅斜线**
           * （上游 README：「每个 shot 都带的那两层共享装饰（**满出血 crossing lines**、角落 motif）」），
           * 而我方这个函数**只被片尾卡 `temperaCreditsPoster.ts:196` 调用过**，
           * 常规 shot 的渲染路径上从来没有画 —— 所以同歌同帧对比时，folia 满屏斜线、我方一条都没有。
           *
           * 参数照上游片尾卡（`:206-208`）：`tone4`（最亮一档 ⇒ 这里的 `toneColor(3)`）、
           * 宽 `1.3`、alpha `0.6`。节点复用 `strokeNode`（它每帧开头会被统一 `clear()`）。
           */
          /*
           * **`sharedDecor` 开关**（第 751 轮）—— 第 741 轮引入贯穿线后必须配套的一步。
           *
           * 上游给每个 shot 的 profile 都留了这个字段（`temperaProfiles.ts:40`），
           * 并把 5 个物语系过场卡（`monogatari-*`）全标成 `sharedDecor: false` —— 注释写得很清楚：
           * 「它要的就是一张干净的白纸」，叠加贯穿线与装饰母题会**毁掉这张留白卡本身**。
           *
           * 我方数据层一直是照搬的（`:161-165` 五条 `sharedDecor: false`，测试也在盯），
           * **但渲染层从来不读它** ⇒ 于是在物语卡上照样叠装饰，把该留白的画面画脏。
           * 第 741 轮把贯穿线加进来之后，这个问题从"潜在"变成"实际成立"，所以这轮补上。
           */
          if (resolveTemperaShotProfile(current.shotKind).sharedDecor !== false) {
            buildCrossingLines(31, 31, viewW, viewH, 2).forEach((line, index) => {
              const graphics = strokeNode(900 + index);
              graphics.pivot.set(0, 0);
              graphics.position.set(0, 0);
              graphics.rotation = 0;
              graphics.moveTo(line.x1, line.y1);
              graphics.lineTo(line.x2, line.y2);
              graphics.stroke({ color: toneColor(3), alpha: 0.6, width: 1.3 });
            });
          }

          /*
           * 装饰两件。第 617 轮**照上游把层与数值一起改齐**（出处 `temperaTextView.ts:148~207`）：
           *
           * · **层**：页边散字进**歌词层**（参与反色）；超大装饰词进**歌词层之前**的独立层
           *   （成为反色滤镜要读的底图 ⇒ 歌词压过它的笔画会翻色）。上游注释写得很直白：
           *   "the lyric flips colour where it crosses the watermark's strokes"。
           * · **锚点**：两者上游都是 `anchor.set(0.5)`（位置是**中心**）；我们此前没设锚点，
           *   装饰整体偏右下半个字 —— 补上。
           * · **不透明度恒定、没有时间轴**：上游原话 "They carry no timeline:
           *   the shot's own enter/exit alpha covers them" ⇒ 我们此前的 `clamp(elapsed / 0.6)`
           *   淡入是自加的，会让装饰比正文晚一拍亮起来，已去掉。
           */
          const fragmentSeen = new Set<string>();
          current.fragments.forEach((fragment, index) => {
            const key = `fragment-${current.shotId}-${index}`;
            fragmentSeen.add(key);
            /*
             * 字号照上游：`max(12, baseFontSize × scale)`（`temperaTextView.ts:159`）——
             * 帧层给的 `decorBaseFontSize` **未乘** `lyricsFontScale`，所以这里乘上 `fontScale`。
             * 旧口径是 `scale × viewW / 12`：量级大致凑得上，但**没有"最小 12px"这道闸**，
             * 短句/小字号 shot 的散字会小得看不见。
             */
            const style = glyphStyle(
              Math.max(12, current.decorBaseFontSize * stateRef.current.fontScale * fragment.scale),
              pixiColor(fragment.color),
            );
            let node = fragmentPool.get(key);
            if (node === undefined) {
              node = new Text({ text: fragment.text, style });
              node.anchor.set(0.5);
              fragmentPool.set(key, node);
              targetLayers.glyph.addChild(node);
            }
            node.text = fragment.text;
            node.style = style;
            node.position.set(fragment.x * viewW, fragment.y * viewH);
            node.rotation = fragment.rotation;
            node.alpha = TEMPERA_FRAGMENT_ALPHA;
          });
          for (const [key, node] of fragmentPool) {
            if (fragmentSeen.has(key)) continue;
            node.destroy();
            fragmentPool.delete(key);
          }

          const watermarkSeen = new Set<string>();
          /* 上游 `if (!watermark.text.trim()) return;` —— 空串**不建节点**。 */
          if (current.watermark !== null && current.watermark.text.trim() !== '') {
            const key = `watermark-${current.shotId}`;
            watermarkSeen.add(key);
            /* 同上：装饰词 `max(48, baseFontSize × scale)`（`temperaTextView.ts:198`）。 */
            const style = glyphStyle(
              Math.max(48, current.decorBaseFontSize * stateRef.current.fontScale * current.watermark.scale),
              pixiColor(current.watermark.color),
            );
            let node = watermarkPool.get(key);
            if (node === undefined) {
              node = new Text({ text: current.watermark.text, style });
              node.anchor.set(0.5);
              watermarkPool.set(key, node);
              targetLayers.watermark.addChild(node);
            }
            node.text = current.watermark.text;
            node.style = style;
            node.position.set(current.watermark.x * viewW, current.watermark.y * viewH);
            node.rotation = current.watermark.rotation;
            node.alpha = TEMPERA_WATERMARK_ALPHA;
          }
          for (const [key, node] of watermarkPool) {
            if (watermarkSeen.has(key)) continue;
            node.destroy();
            watermarkPool.delete(key);
          }

          // 歌词：逐字素一个 Text，入场沿 profile 的入场向量滑到 0（位移随字号等比缩放）。
          const glyphSeen = new Set<string>();
          const previousInk = stateRef.current.inkSeen;
          const inkNow = stateRef.current.glyph;
          if (glyphFilter !== null && inkNow !== previousInk) {
            stateRef.current.inkSeen = inkNow;
            const previousFilter = glyphFilter;
            glyphLayer.filters = [];
            previousFilter.destroy();
            glyphFilter = createTemperaDifferenceFilter(pixiModule, {
              ink: inkNow,
              paper: stateRef.current.paper,
            });
            glyphLayer.filters = [glyphFilter];
            glyphLayerEl = glyphLayer;
            glyphFilterEl = glyphFilter;
          }
          current.glyphs.forEach((glyph: TemperaGlyphSpec, index) => {
            const key = `${current.shotId}-${index}`;
            glyphSeen.add(key);
            /*
             * **字形运动交给运动层**（第 202 轮接线，`temperaGlyphMotion.ts`）：
             * 入场用被拉长的 settle 窗口；透明度与回响用 `min(窗口, 1.35)` 的短窗口（字在移动中就可读）；
             * 唱完按"从块中心指向该字的力臂"把字距撑开。
             *
             * ⚠ **时间基准**：运动层要**绝对时间**（歌词时间轴），旧代码用的 `elapsed` 是"相对本镜起点"的，
             * 直接拿它会把整套运动整体平移 ⇒ 这里改用 `current.clock.current() / 1000`（与 `tick` 同一取法）。
             * ⚠ **`motion = 0`（减少动态）**：运动层会把入场拉回静止姿态（`x/y = 0`、`scale = 1`），
             * 而 `alpha` 仍按 reveal 走 ⇒ 文字照常可读。
             */
            const motionFrame = resolveTemperaGlyphMotion(
              {
                startTime: glyph.startTime ?? 0,
                // 时序信息缺失时的兜底：沿用旧的"入场时长"常量，语义与旧代码一致。
                settleTime: glyph.settleTime ?? (glyph.startTime ?? 0) + TEMPERA_GLYPH_REVEAL,
                endTime: glyph.endTime ?? 0,
                enterX: glyph.enter[0],
                enterY: glyph.enter[1],
                enterRotation: glyph.enterRotation ?? 0,
                enterScale: glyph.enterScale ?? 1,
                rotation: glyph.rotation ?? 0,
                enterStyle: glyph.enterStyle ?? 'slide',
                releaseTime: glyph.releaseTime ?? glyph.endTime ?? 0,
                trackingX: glyph.trackingX ?? 0,
                trackingY: glyph.trackingY ?? 0,
              },
              // 注意：这里的 `current` 是**本帧数据**（`TemperaFrame`），时钟在 `stateRef.current` 上。
              stateRef.current.clock.current() / 1000,
              reduced ? 0 : 1,
            );
            if (!motionFrame.visible) {
              /*
               * 还没到出场时刻：**先不建节点**（省下大量 Text）。若节点已经在池里
               * （seek 回退到出场之前），则三个一起收掉 —— 否则重影会留在画面上。
               */
              const existing = glyphPool.get(key);
              if (existing !== undefined) hideGlyphNodes(existing);
              return;
            }
            let nodes = glyphPool.get(key);
            if (nodes === undefined) {
              nodes = createGlyphNodes(glyph);
              glyphPool.set(key, nodes);
            }
            /*
             * 摆位：`x/y` 是**偏移**（静置为 0）⇒ 加在布局坐标上；`rotation` 是**绝对值**
             * （已含布局旋转）⇒ 直接赋值；缩放分轴（有几个入场样式只在一个轴上张开）。
             */
            const style = glyphStyle(glyph.fontPx, pixiColor(glyph.color));
            nodes.display.style = style;
            nodes.display.text = glyph.text;
            const glyphX = glyph.x + motionFrame.x;
            const glyphY = glyph.y + motionFrame.y;
            const place = (node: Text, px: number, py: number, alpha: number): void => {
              node.visible = true;
              node.position.set(px, py);
              node.rotation = motionFrame.rotation;
              node.scale.set(motionFrame.scaleX, motionFrame.scaleY);
              node.alpha = alpha;
            };
            place(nodes.display, glyphX, glyphY, motionFrame.alpha);
            glyphVisibleCount += 1;
            if (glyph.keyword === true) keywordVisibleCount += 1;
            // 阴影：同一姿态、只偏移一点点（偏移按字号等比），不透明度打 0.34 折。
            const shadowOffset = resolveTemperaShadowOffset(glyph.fontPx);
            place(
              nodes.shadow,
              glyphX + shadowOffset.dx,
              glyphY + shadowOffset.dy,
              resolveTemperaShadowAlpha(motionFrame.alpha),
            );
            /*
             * 回响：偏移算在**布局基准点**上（`glyph.x/y + copy.dx/dy`），**不叠加**正文此刻的位移 ——
             * 上游 `echo.position.set(glyph.baseX + frame.echoX * depth, ...)` 就是这个意思：
             * 拖尾是"从入场向量更远处跟过来"，而不是"正文后面拖一条等长的尾巴"。
             */
            const copies = resolveTemperaEchoCopies(
              motionFrame.echoX,
              motionFrame.echoY,
              motionFrame.echoAlpha,
              motionFrame.visible,
            );
            nodes.echoes.forEach((echo, echoIndex) => {
              const copy = copies[echoIndex];
              if (copy === undefined || !copy.visible) {
                echo.visible = false;
                return;
              }
              place(echo, glyph.x + copy.dx, glyph.y + copy.dy, copy.alpha);
            });
            // 诊断：本帧真正可见的回响节点数（UI 冒烟读它）。
            echoVisibleCount += copies.reduce((sum, copy) => sum + (copy.visible ? 1 : 0), 0);
          });
          for (const [key, nodes] of glyphPool) {
            if (glyphSeen.has(key)) continue;
            destroyGlyphNodes(nodes);
            glyphPool.delete(key);
          }
          /*
           * 重影的诊断（第 615 轮）：本帧真的摆上去的阴影 / 可见回响数。
           * ⚠ 回响在"入场位移已经走完"时必然是 0 —— 它是**会动的**判据，
           * 冒烟要 seek 到入场窗口里读它（读到 0 不代表没接线）。
           */
          host.dataset.temperaShadows = String(glyphVisibleCount);
          host.dataset.temperaEchoes = String(echoVisibleCount);
          if (echoVisibleCount > echoPeakVisible) echoPeakVisible = echoVisibleCount;
          host.dataset.temperaEchoPeak = String(echoPeakVisible);
          /*
           * 装饰两件的节点数（第 617 轮加）。池是**每帧清场**的，所以 `size` 就是本帧真画出来的个数：
           * 层序改动若把装饰弄丢（例如忘了往新层 `addChild`），这里会立刻变成 0。
           */
          host.dataset.temperaFragments = String(fragmentPool.size);
          /*
           * **元素计数接缝**（第 729 轮）。第 727 轮的同歌同帧对比发现：folia 那一镜有 **3~5 颗散字**
           * 而**我方只有 1 颗**（还有斜线群、翻译字幕、几何装饰我方都没有）。在动手补之前，
           * 先要能**量出我方每一帧实际画了几颗** —— 这三个池的尺寸就是最直接的数。
           */
          if (!fragmentsLogged && current.fragments.length > 0) {
            fragmentsLogged = true;
            const inView = current.fragments.filter(
              (f) => f.x >= 0 && f.x <= 1 && f.y >= 0 && f.y <= 1,
            ).length;
            console.info(
              `[pi/tempera] fragments n=${String(current.fragments.length)} inView=${String(inView)} out=${String(current.fragments.length - inView)} shot=${current.shotId} xs=${current.fragments
                .slice(0, 8)
                .map((f) => f.x.toFixed(2))
                .join(',')} ys=${current.fragments
                .slice(0, 8)
                .map((f) => f.y.toFixed(2))
                .join(',')}`,
            );
          }
          host.dataset.temperaFragments = String(fragmentPool.size);
          host.dataset.temperaGlyphs = String(glyphPool.size);
          host.dataset.temperaWatermarks = String(watermarkPool.size);
          /*
           * 主题色字素（第 618 轮）：本帧摆上去的 + 历史峰值。
           * 没有 hero 词的镜头会读到 0，所以**只当读数用**，不进冒烟的硬判据。
           */
          host.dataset.temperaKeywords = String(keywordVisibleCount);
          if (keywordVisibleCount > keywordPeakVisible) keywordPeakVisible = keywordVisibleCount;
          host.dataset.temperaKeywordPeak = String(keywordPeakVisible);
        };

        const gate = createFrameGate(stateRef.current.fpsCap);
        const tick = (): void => {
          const current = stateRef.current;
          // 帧率上限与其它逐帧主题同一套闸门（`fpsCap` 来自设置页那枚滑杆）。
          if (gate(performance.now())) {
            const timeSec = current.clock.current() / 1000;
            if (current.program !== null && current.program.paragraphs.length > 0) {
              /*
               * **交接（双 shot 同屏）第一步：把"出画的那一个"画进 B 层集。**
               *
               * 为什么放在主帧之前：`drawFrame` 会写 `host.dataset.tempera*` 诊断，
               * 而**后写的赢**。主 shot（入画/单独在场那个）在后面画，于是诊断报的是主 shot
               * ——这正是第 591 轮记下的"约束二"。
               *
               * 绘制顺序也恰好对：`world.addChild(layersA.container, layersB.container)`，
               * 所以 B 压在 A 之上；上游要的就是"**出画的构图从入画的那一个身上碾过去**"。
               *
               * 出画帧用**它自己的最后一刻**（`endTime - 1e-3`）构建，保证字形已全部就位
               * ——它已经过了自己的 endTime，本就不该再往时间里外推。
               */
              /*
               * 本帧生效的转场（种类 + 相位）：写进 dataset，并在**首次**见到某个组合时留一条
               * ASCII 日志。这份冒烟日志是混合编码的，ASCII 标签在 UTF-8 / UTF-16 两种解码下都命中。
               */
              let transitionLabel = 'none';
              /** 出画侧的效果帧含 blur，但它声明在下面的分支里，所以把 blur 提到这里给场景用。 */
              let outgoingBlur = 0;
              /** 同上：wipe 的行程与角度、以及覆盖块的颜色，都要提到分支外给覆盖层用。 */
              let outgoingWipe = 0;
              let outgoingWipeAngle = 0;
              let wipeColor: ColorSource = '#000000';
              const noteTransition = (kind: string, phase: string): void => {
                transitionLabel = `${kind}:${phase}`;
                const key = `${kind}:${phase}`;
                if (!transitionSeen.has(key)) {
                  transitionSeen.add(key);
                  console.info(`[pi/tempera] transition-active kind=${kind} phase=${phase}`);
                }
              };
              const handoffShots = current.program.paragraphs.flatMap((item) => item.shots);
              const aliveIndices = resolveTemperaAliveShotIndices(handoffShots, timeSec);
              /*
               * **复位必须在"画之前"**：容器变换在**渲染时**生效，若在画完之后才复位，
               * 就等于把刚画好的出画构图拉回原位 —— 结果与主帧完全重叠，看起来"根本没有第二个构图"。
               * （第 601 轮就是靠这个把 5078 次正确绘制变成了"看不见"。）
               */
              layersB.container.position.set(0, 0);
              layersB.container.alpha = 1;
              layersB.container.scale.set(1);
              layersB.container.rotation = 0;
              /*
               * ⚠ **没有出画侧时必须把 B 层集藏起来**（第 626 轮）。
               *
               * 上面这几行只复位了**变换**，却**没有清空 B 里的字形节点** ——
               * 于是某一帧开始不画出画侧之后，B 里**上一个 shot 的那句话**会**全亮地停在原位**
               * （alpha 被复位成 1、位置被复位成 (0,0)），与主 shot 的字**重合**。
               * 这就是连拍图 `06.png` 里"一句话写了两遍"的真因：两句话文字不同
               * （白字多一个「それで」）、位置几乎相同，而"出画侧提前量"那类改动对它**无效**
               * —— 因为那一帧根本没有画出画侧，画面上的是**残留**。
               */
              layersB.container.visible = false;
              const outgoingIndex: number = aliveIndices.length > 1 ? (aliveIndices[0] ?? -1) : -1;
              if (outgoingIndex >= 0) {
                const outgoing = handoffShots[outgoingIndex];
                if (outgoing !== undefined && outgoing.endTime - outgoing.startTime > 0) {
                  const outgoingTime = Math.max(outgoing.startTime, outgoing.endTime - 1e-3);
                  const neighbour = buildTemperaFrame({
                    program: current.program,
                    timeSec: outgoingTime,
                    viewport: { width: app.screen.width, height: app.screen.height },
                    paper: current.paper,
                    deep: current.deep,
                    glyph: current.glyph,
                    accent: current.accent,
                    wordColorOf: current.wordColorOf,
                  });
                  if (neighbour === null) {
                    outgoingNullBuilds += 1;
                    if (outgoingNullBuilds === 1) {
                      console.info(`[pi/tempera] handoff-null-build out=${outgoingIndex}`);
                    }
                  }
                  if (neighbour !== null) {
                    // 相机留在 `world` 上，所以这里只取**交接位移**本身（camera / frame 都给 0）。
                    const handoff = resolveTemperaShotHandoffFrame({
                      startTime: outgoing.startTime,
                      endTime: outgoing.endTime,
                      /*
                       * **出画侧提前起算 `exit`**（第 626 轮，**有意偏离上游**，理由见常量的长注释）：
                       * 上游从 `endTime` 起算，于是交接那一瞬间出画侧位移才起步、入画侧已收回到 0
                       * ⇒ 两个字幕重合在一处（连拍 `06.png` 抓到的就是这个）。
                       * 提前 `handoff × 0.5` 后，交接瞬间两侧分离 ≈ 700px。
                       */
                      time:
                        timeSec +
                        resolveTemperaShotHandoffDuration(outgoing.startTime, outgoing.endTime) *
                          TEMPERA_HANDOFF_LEAD_RATIO,
                      flowAngle: outgoing.flowAngle,
                      width: app.screen.width,
                      height: app.screen.height,
                      camera: 0,
                      frameX: 0,
                      frameY: 0,
                    });
                    /*
                     * **把「位移」与「透明度」拆开**（第 767 轮；主人第 766 轮原话：
                     * 「被切换的背景的**消失很生硬**」）。
                     *
                     * 上面那次调用把时钟提前了 `handoff × 0.5`（第 626 轮为消除"两句话重合"而做的
                     * 有意偏离）。问题在于同一个 `exit` **被用在了两处**：
                     *
                     *   · `travel = exit × span × 0.55 - …`（**位移**）——**要**这个提前量：
                     *     它把两个构图分开约 700px，是"不叠字"的关键；
                     *   · `exitFade = 1 - exit`（**透明度**）——**不要**这个提前量：
                     *     它让旧背景在交接那一刻就只剩 0.43，主人看到的是"后半程"
                     *     ⇒ 读起来就是"硬生生没了"。
                     *
                     * 这里再取一次**不做时钟偏移**的 `exit`，**只给透明度用**：
                     * 旧背景在交接一瞬间仍是满值（≈1.00），然后完整走完一个 handoff 窗口。
                     * ⇒ 位移（不叠字）与透明度（不硬切）**两者都要**，不必二选一。
                     */
                    /*
                     * ⚠ **淡出必须正好在"旧背景被移除"那一刻走完** —— 主人第 769 轮的补充描述：
                     * 「旧背景被切换**不是直接消失，而是一个淡去并且带着位移的过程**」。
                     *
                     * 为什么不能直接用 `timeSec`：旧构图的**存活期**跟着**带提前量**的时钟走
                     * （第 626 轮那个 `handoff × 0.5` 的提前量）⇒ 它在**真实进度约 0.5** 时就被移除。
                     * 若淡出按真实进度从 0 走到 1，那么到"被移除"那一刻它还剩约 0.5 的不透明度
                     * ⇒ **在半途被硬切掉** ⇒ 看起来仍然是"直接消失"。
                     *
                     * 所以把时钟**拉伸** `1 / (1 - 提前量)` 倍：淡出从**交接那一刻**开始，
                     * 正好在**存活期结束**时落到 0 ⇒ 位移与淡出都完整走完，不再有"啪一下没了"。
                     */
                    const handoffFadeSpan = Math.max(0.05, 1 - TEMPERA_HANDOFF_LEAD_RATIO);
                    const handoffFade = resolveTemperaShotHandoffFrame({
                      startTime: outgoing.startTime,
                      endTime: outgoing.endTime,
                      time:
                        outgoing.endTime + (timeSec - outgoing.endTime) / handoffFadeSpan,
                      flowAngle: outgoing.flowAngle,
                      width: app.screen.width,
                      height: app.screen.height,
                      camera: 0,
                      frameX: 0,
                      frameY: 0,
                    });
                    targetLayers = layersB;
                    layersB.container.visible = true;
                    ({ glyphPool, fragmentPool, watermarkPool, styleCache } = targetLayers);
                    /*
                     * 效果帧（**出画相位**）：这一侧是"被推出去"的上一个构图，
                     * 窗口取它自己所在段落的 `transitionOut`（program 已编译好 startTime/endTime）。
                     * `blur` 与 `wipe` 不在本步（分别留给后面的模糊通道与覆盖块）。
                     */
                    const outgoingParagraph = current.program.paragraphs.find((item) =>
                      item.shots.some((shotItem) => shotItem.id === outgoing.id),
                    );
                    const outgoingTransition = outgoingParagraph?.transitionOut ?? null;
                    const exitWindow =
                      outgoingTransition === null
                        ? 'none'
                        : `${outgoingTransition.startTime.toFixed(2)}-${outgoingTransition.endTime.toFixed(2)}`;
                    const exitKey = `${outgoing.id}|${exitWindow}`;
                    if (!exitProbed.has(exitKey)) {
                      exitProbed.add(exitKey);
                      console.info(
                        `[pi/tempera] exit-probe t=${timeSec.toFixed(2)} outEnd=${outgoing.endTime.toFixed(2)} win=${exitWindow} kind=${outgoingTransition?.kind ?? 'none'} alive=${aliveIndices.length}`,
                      );
                    }
                    let outgoingEffect = IDLE_TEMPERA_TRANSITION_FRAME;
                    /*
                     * **出画相位的作用区间 = 交接尾段，而不是 `transitionOut` 自己的窗口。**
                     *
                     * 第 30 轮的探针把原因打实了：段级转场的窗口正好**止于 shot 边界**
                     * （实测 `win=173.62-173.97`、`outEnd=173.97`、`t=173.98`），而"两个 shot 同时在场"
                     * 是从边界**之后**才开始的 —— 所以按原窗口判断**永远差那么一点点**，
                     * `phase=exit` 一次都没命中。进度改用**交接窗口** `[outEnd, outEnd + handoff]`，
                     * 那正好是出画构图还看得见的那一段。
                     *
                     * 另外：段级转场只施加在**段落最后一个 shot** 上（段落内部 shot 之间的交接
                     * 没有段级效果，与上游一致；探针里那些"窗口远在将来"的记录正是段内交接）。
                     */
                    const outgoingShots = outgoingParagraph?.shots ?? [];
                    const isParagraphExit =
                      outgoingShots.length > 0 &&
                      outgoingShots[outgoingShots.length - 1]?.id === outgoing.id;
                    const handoffSpan = Math.max(0.001, handoff.handoff);
                    if (isParagraphExit && outgoingTransition !== null && outgoingTransition !== undefined) {
                      outgoingEffect = resolveTemperaExitTransitionFrame(
                        outgoingTransition.kind,
                        Math.min(1, Math.max(0, (timeSec - outgoing.endTime) / handoffSpan)),
                        outgoing.flowAngle,
                      );
                      noteTransition(outgoingTransition.kind, 'exit');
                    }
                    // `x/y` 是视口比例 ⇒ 乘视口尺寸；再叠上交接位移（相机仍留在 `world` 上）。
                    targetLayers.container.position.set(
                      handoff.x + outgoingEffect.x * app.screen.width,
                      handoff.y + outgoingEffect.y * app.screen.height,
                    );
                    outgoingBlur = outgoingEffect.blur;
                    outgoingWipe = outgoingEffect.wipe;
                    outgoingWipeAngle = outgoingEffect.wipeAngle;
                    // 颜色取**出画那一帧**的第三档色（上游是 `scene.palette.tone3`，遍历场景时最后一个写下）。
                    wipeColor = neighbour.tones.tone[2] ?? '#000000';
                    /*
                     * **出画侧要跟着 `exit` 淡出**（上游 `createTemperaPixiRuntime.ts:592` 的 `alpha = 1 − exit`）。
                     *
                     * 段落转场自己会管 alpha（`block-wipe` 恒 1、`camera-pan` / `shape-carry` 到最后才淡出），
                     * 但**段落内**没有转场 —— 那时 `outgoingEffect` 是 idle 帧、alpha 恒 1
                     * ⇒ 出画侧一路全亮地滑过去，和入画侧叠成一片。这是"两句话叠在一起"的**另一半**原因
                     * （第一半是入画侧没有推进位移，第 621 轮修）。
                     */
                    /*
                     * **出画侧淡出：与上游一致**（第 764 轮核对，此地原注释已过期）。
                     *
                     * 原注释写"第 673 轮改成平方、**有意偏离上游**"——**代码里没有平方**：
                     * 这里就是 `1 - handoff.exit`，而 `handoff.exit` 在
                     * `temperaShotHandoff.ts:119` 已经过 `easeTemperaInOut`，即
                     * `1 - easeTemperaInOut(clamp01((time - endTime) / handoff))`，
                     * **与上游 `createTemperaPixiRuntime.ts:585/592` 的 `alpha = 1 - exit` 逐字相同**。
                     * 所以撤销那条"有意偏离"的说法（第 747 轮那种"注释与代码不符"的坑，这里又有一个）。
                     *
                     * 依据：第 658 轮量到我们构图的明度跨度是 folia 的 1.9 倍
                     * （十分位跨度 81 vs 42），第 671 轮把「切换生硬」锁定为
                     * 「hand-off 窗口里两个构图同屏、一个浅纸为主一个深色满幅」。
                     * 线性淡出让出画侧在窗口前段还很亮（`exit=0.3` 时 alpha 仍有 0.7），
                     * 于是"双亮"持续得久；平方后同一点只剩 0.49 ⇒ 双亮窗口明显缩短。
                     * ⚠ 平方在 `exit=0` 处导数为 0，淡出是**平滑起步**的，不会引入硬边。
                     */
                    /*
                     * **出画侧淡出保持上游的线性**（第 680 轮的 A/B 结论）。
                     *
                     * 第 673 轮曾改成 `(1 - exit)²`，理由是"让出画侧早点掉下来、压缩同屏双亮的窗口"。
                     * 本轮补做 A/B（同一段、30 秒、两个口径一起看）：
                     *
                     *     平方：30fps jumpSum 1595 ｜ 6fps 1137 ｜ 每点 6.35
                     *     线性：30fps jumpSum 1556 ｜ 6fps 1245 ｜ 每点 6.96
                     *
                     * ⇒ **两个口径给出相反结论**（30fps 说线性好、6fps 说平方好）⇒
                     * 差异在噪声级、没有可复现的收益 ⇒ **撤回**，回到上游写法，少一处偏离。
                     * （教训：口径不一致时不能挑对自己有利的那个报。）
                     */
                    /*
                     * **出画侧一律淡出**（第 789 轮；主人原话：「背景有时候会抽一下
                     * **不会正常过渡消失**」）。
                     *
                     * 原来这里是个三元：只有出画侧**没有**特殊过渡帧（`outgoingEffect === IDLE…`）
                     * 时才乘 `1 - handoffFade.exit`；只要那一刻有**特殊过渡帧**在跑，`exitFade` 恒为 **1**
                     * ⇒ 旧背景**完全不做透明度淡出**，等交接窗口一结束、整层被撤掉
                     * ⇒ 画面上就是"**抽一下**"。这解释了主人说的"**有时候**" ——
                     * 取决于那一刻跑的是哪一类过渡帧。
                     *
                     * ⇒ 去掉这个例外：**任何过渡帧下都淡出**，让旧背景在退场那一刻 `alpha` 恰好归零。
                     */
                    const exitFade = 1 - handoffFade.exit;
                    /*
                     * **出画侧额外压暗：实测无效且更差 ⇒ 已撤回**（第 687 轮）。
                     *
                     * 试过 `handoffDim = 1 - 0.4 * handoff.exit`（窗口全程线性压暗出画侧）：
                     * 6fps 每点从 6.36 涨到 **7.04**、30fps 从 1535 涨到 1565 ⇒ 两个口径都变差。
                     *
                     * ⇒ 反过来的道理：**出画侧越暗，它退场那一下的落差就越大**。
                     * ⇒ 所以真正的杠杆在**主镜"从 0 到全亮"那一下**（入场曲线是前重的，
                     * 第 5 轮对账过 `easeTemperaEnter` 与上游逐位一致）—— 那是下一轮的对象。
                     */
                    const outgoingAlpha = Math.max(0, outgoingEffect.alpha * exitFade);
                    targetLayers.container.alpha = outgoingAlpha;
                    host.dataset.temperaOutgoingAlpha = outgoingAlpha.toFixed(3);
                    /*
                     * **只在"淡出窗口真正走完"的那一帧**记下 alpha（第 791 轮）。
                     *
                     * 上一版的探针读的是 `temperaOutgoingAlpha` —— 那是**每帧覆盖**的，某一帧没有出画层时
                     * 它会保留**旧值**（可能是交接刚开始的 1.000）⇒ 读不出"到底是没淡、还是读到旧值"。
                     * 换个键、且只在窗口走完时写：读到的就一定是"退场那一刻的出画 alpha"。
                     * ⇒ 若交接在窗口走完前就被换掉，这个键**保持 `-`**，那本身也是重要信息。
                     */
                    if (handoffFade.exit >= 0.999) {
                      host.dataset.temperaOutgoingExitAlpha = outgoingAlpha.toFixed(3);
                    }
                    if (outgoingAlpha < outgoingAlphaMin) outgoingAlphaMin = outgoingAlpha;
                    host.dataset.temperaOutgoingAlphaMin = outgoingAlphaMin.toFixed(3);
                    targetLayers.container.scale.set(outgoingEffect.scale);
                    targetLayers.container.rotation = outgoingEffect.rotation;
                    try {
                      drawFrame(neighbour, timeSec);
                    } catch (error: unknown) {
                      // 单帧异常不该让整块画布停摆，但**必须留痕**。
                      console.error('[pi/tempera] 交接（出画）帧绘制失败', error);
                    }
                    outgoingAttempts += 1;
                    if (outgoingAttempts === 1 || outgoingAttempts % 200 === 0) {
                      console.info(`[pi/tempera] handoff-attempt n=${outgoingAttempts} alive=${aliveIndices.length} out=${outgoingIndex} travel=${handoff.x.toFixed(1)},${handoff.y.toFixed(1)}`);
                    }
                    handoffDraws += 1;
                    host.dataset.temperaHandoff = String(handoffDraws);
                    if (handoffDraws === 1 || handoffDraws % 120 === 0) {
                      console.info(`[pi/tempera] handoff-draw count=${handoffDraws}`);
                    }
                    // 收尾：目标切回 A、B 的位移归零（下一帧重新算），池也跟着切回 A。
                    targetLayers = layersA;
                    ({ glyphPool, fragmentPool, watermarkPool, styleCache } = targetLayers);
                    // 复位已移到本帧开头（见那里的注释）。
                  }
                }
              }
              /*
               * 效果帧（**入画相位**）：主 shot 是"推进来"的那一侧，
               * 它的入场窗口来自**前一段落**的 `transitionOut`（同一窗口的另一侧）。
               * 不在窗口内时 `resolveTemperaEnterTransitionFrame` 返回空闲帧 ⇒ 容器复位，
               * 不会把上一帧的缩放/旋转/透明度留在画面上。
               */
              const primaryIndex: number =
                aliveIndices.length > 0 ? (aliveIndices[aliveIndices.length - 1] ?? -1) : -1;
              const primaryShot = primaryIndex >= 0 ? handoffShots[primaryIndex] : undefined;
              const primaryParagraphIndex =
                primaryShot === undefined
                  ? -1
                  : current.program.paragraphs.findIndex((item) =>
                      item.shots.some((shotItem) => shotItem.id === primaryShot.id),
                    );
              const previousTransition =
                primaryParagraphIndex > 0
                  ? (current.program.paragraphs[primaryParagraphIndex - 1]?.transitionOut ?? null)
                  : null;
              let enteringEffect = IDLE_TEMPERA_TRANSITION_FRAME;
              if (
                primaryShot !== undefined &&
                previousTransition !== null &&
                previousTransition !== undefined
              ) {
                enteringEffect = resolveTemperaEnterTransitionFrame(
                  previousTransition.kind,
                  {
                    enabled: true,
                    timeSinceStart: timeSec - previousTransition.startTime,
                    duration: previousTransition.endTime - previousTransition.startTime,
                  },
                  primaryShot.flowAngle,
                );
                noteTransition(previousTransition.kind, 'enter');
              }
              host.dataset.temperaTransition = transitionLabel;
              /*
               * **每个 shot 的入画推进**（上游 `createTemperaPixiRuntime.ts:584~590`）。
               *
               * 上游给**每一个** shot 都算一次 hand-off，入画侧那一段是
               * `travel = exit × span × 0.55 − (1 − enter) × span × 0.32`：
               * shot 刚开头 `enter ≈ 0` ⇒ 位移 **−0.32 × 长边**（从上游推进来），落定后归零。
               *
               * ⚠ 我们此前**只在段落交界**才给主 shot 位移（`enteringEffect`，来自 `paragraph.transitionOut`），
               * 而**同一段落内的相邻 shot**（半句一次，是最频繁的那种切换）完全没有推进
               * ⇒ 出画侧在动、入画侧原地不动，两句话的字就**原地叠在一起**（第 621 轮主人截图的那个问题），
               * 切换读起来也"生硬、没有过渡"。
               */
              const handoffSpan = Math.max(app.screen.width, app.screen.height);
              /*
               * **入画推进：幅度收到 0.14、窗口放到 1.4 倍**（第 754 轮，主人指定）。
               *
               * 主人第 754 轮的原话：「切换啊啥的力度太大，太快，没有丝滑的感觉」，并点了具体一首
               * （"p丸"的歌）说"挺晃眼"。
               *
               * ⚠ 这段位移**本来就是我方加的**（见上面注释：上游只在段落交界给主 shot 位移，
               * 同段落内的相邻 shot 是我们补的推进）⇒ 收小它**不是偏离上游，而是回到上游更近的位置**。
               *
               * 第 699 轮我试过减半（0.16）并因为"`jumpSum` 几乎不动"而回滚 —— **那个判据选错了**：
               * 主人抱怨的是**手感/幅度**，不是整幅亮度。所以这次不为数字，为手感收下来：
               * 峰值从约 378px 降到约 165px，同时把窗口从 `handoff × 0.8` 拉到 `handoff × 1.4`
               * ⇒ 位移走得更慢、更晚到位，读起来才"丝滑"而不是"啪一下推过去"。
               */
              const shotEnterTravel =
                primaryShot === undefined
                  ? 0
                  : -(1 -
                      easeTemperaEnter(
                        clamp01(
                          (timeSec - primaryShot.startTime) /
                            (resolveTemperaShotHandoffDuration(
                              primaryShot.startTime,
                              primaryShot.endTime,
                            ) *
                              0.8),
                        ),
                      )) *
                    handoffSpan *
                    0.32;
              /* 诊断（第 709 轮）：入场时间还没到时留一条 —— 见 `elapsedNegativeLogged` 的注释。 */
              if (
                !elapsedNegativeLogged &&
                primaryShot !== undefined &&
                timeSec < primaryShot.startTime
              ) {
                elapsedNegativeLogged = true;
                console.info(
                  `[pi/tempera] elapsed-negative t=${timeSec.toFixed(2)} start=${primaryShot.startTime.toFixed(2)} end=${primaryShot.endTime.toFixed(2)} lead=${(primaryShot.startTime - timeSec).toFixed(2)}`,
                );
              }
              const enterFlowX = primaryShot === undefined ? 0 : Math.cos(primaryShot.flowAngle);
              const enterFlowY = primaryShot === undefined ? 0 : Math.sin(primaryShot.flowAngle);
              layersA.container.position.set(
                enteringEffect.x * app.screen.width + enterFlowX * shotEnterTravel,
                enteringEffect.y * app.screen.height + enterFlowY * shotEnterTravel,
              );
              /*
               * **入画侧补一条 0.3 秒淡入**（第 757 轮，由探针数据背书）。
               *
               * 换镜探针（同一首歌、同一个固定段落）打出来的是：
               *
               *     shot-change idx 0→1  enterAlpha=1.00  aA=1.00  aB=0.43  travel=-164.5
               *     shot-change idx 1→2  enterAlpha=1.00  aA=1.00  aB=0.43  travel=-162.6
               *     …（6 次全是同一个形状）
               *
               * ⇒ **`enteringEffect.alpha` 恒为 1**（原因：它取的是**上一段落**的 `transitionOut` 窗口，
               * 而**段落内**换镜时那个窗口早就过去了 ⇒ 解析成 idle ⇒ alpha 1）。
               * 于是换镜那一刻：新镜**一帧全亮**、旧镜还剩 **0.43** 压在上面
               * ⇒ 既不是干净的淡入、也不是干净的硬切，读起来就是"**糊了一下的硬切**"
               * —— 正是主人说的「过渡几乎没有就是硬切」。
               *
               * 修法：给入画侧乘一条 **0.3 秒**的 ease 淡入（不是整个 handoff 窗口 —— 那会让底纸
               * 露出太久、反而闪一下）。0.3 秒够形成"淡"，又短到不会露底。
               */
              /*
               * **入画侧保持不透明**（第 763 轮，按上游原文改回）。
               *
               * 上游 `createTemperaPixiRuntime.ts:591-592` 写得非常直接：
               *
               *     // Opaque on the way in: this is a push, not a dissolve. Only the exit fades.
               *     view.container.alpha = 1 - exit;
               *
               * ⇒ 镜头交界**入画侧不做淡入**（还没到 endTime ⇒ `exit = 0` ⇒ alpha 恒为 1），
               * **只有出画侧淡**。所以第 757 轮我补的那条 0.3 秒淡入是**多余的偏离**，撤掉。
               */
              /*
               * **入画侧也淡入**（第 774 轮；主人第 773 轮原话：
               * 「**新的背景也不应该是直接出现，也应该是有个过渡**」）。
               *
               * ⚠ 这是一处**有意偏离上游**，必须写明：上游这里是**不透明**的 ——
               * `createTemperaPixiRuntime.ts:591`："Opaque on the way in: this is a push,
               * not a dissolve. Only the exit fades."（第 763 轮我还照这句把先前的入画淡入**撤掉**了）。
               * 但主人明确要求"新的也要有过渡" ⇒ **按主人的要求做，并如实标注偏离**。
               *
               * 窗口取**整个 handoff**（与淡出那侧同一个窗口）⇒ 两侧同时进行，
               * 读作"一边往外推、一边相互化开"，而不是"旧的退、新的啪一下出现"。
               */
              const enterAlphaRamp =
                primaryShot === undefined
                  ? 1
                  : easeTemperaEnter(
                      clamp01(
                        (timeSec - primaryShot.startTime) /
                          Math.max(
                            0.001,
                            resolveTemperaShotHandoffDuration(
                              primaryShot.startTime,
                              primaryShot.endTime,
                            ),
                          ),
                      ),
                    );
              layersA.container.alpha = enteringEffect.alpha * enterAlphaRamp;
              /*
               * 【**已撤回**】第 760 / 761 轮曾在此补"换镜模糊"（3px → 6px）——
               * 第 763 轮按上游原文撤回：`tempera__temperaTransitions.ts:4-8` 明说
               * `Shot boundaries need none`，README:22 也说"不再有 shot 级的场景转场"，
               * 那套 blur 6px / scale 1.07 是**段落交界专用**。撤回理由见下方那行。
               *
               * （保留下来的历史依据，仅供追溯：）
               *
               * 两条证据合起来才定的这个值：
               *
               * 1. **设计工程判据**（`emil-design-eng`）：交叉淡入时"你会同时看到旧状态和新状态
               *    两个东西叠着，看起来不自然"，这时应「**加一点模糊把两者糊在一起**，让眼睛读成
               *    一次平滑的转变，而不是两个物体互换」，并要克制（< 20px）；
               * 2. **folia 自己的源码**（`.folia-ref/tempera__temperaTransitions.ts:79-91`，那儿把这套
               *    叫 "shape-carry"）：
               *
               *        // the composition keeps drifting on the flow vector while it dilates and
               *        // softens, as if the next graphic were pulling it out of focus.
               *        // No hard cut, no glitch.
               *        const away = phase === 'exit' ? eased : 1 - eased;
               *        scale: 1 + away * 0.07,
               *        alpha: phase === 'exit' ? 1 - clamp01((linear - 0.55) / 0.45)
               *                                : clamp01(linear / 0.45),
               *        blur: away * 6,
               *
               *    ⇒ **模糊峰值就是 `away × 6` = 6px**（不是我先前拍的 3px）。
               *    而且它顺带解释了第 757 轮量到的怪事：**出画侧先保持 alpha 1 到 55%，
               *    再在最后 45% 落到 0**；入画侧则在**前 45%** 从 0 涨到 1 —— 两侧是**故意错峰**的。
               *    我们量到 `aB=0.42` 正是因为我们的出画曲线没有这个"先保持"。
               *
               * ⚠ 上游这一步在**段落内**换镜时被静默掉了（`enteringEffect` 取的是上一段落的
               * `transitionOut`，段落内那个窗口早已过去）⇒ `blur` 恒为 0 —— 与第 757 轮
               * `alpha` 恒为 1 是**同一个病根**。这里复用同一条 0.3 秒 ramp 把它补回来。
               */
              const shotHandoffBlur = 0; // 【已撤回】镜头交界不加模糊 —— 上游：Shot boundaries need none。
              /*
               * 换镜探针（第 756 轮）：只打前 6 次，够看清规律又不刷屏。
               * ⚠ 用 `primaryIndex`（主镜在 `handoffShots` 里的序号）做"换没换镜"的判据 ——
               * 这一层作用域里的 `current` 是**状态对象**（`stateRef.current`），不是帧数据，
               * 所以取不到 `current.shotId`（第 756 轮 typecheck 已经教训过一次）。
               */
              const shotProbeKey = `${String(primaryIndex)}`;
              if (
                shotChangeLogs < 6 &&
                lastShotProbeId !== '' &&
                lastShotProbeId !== shotProbeKey
              ) {
                shotChangeLogs += 1;
                console.info(
                  `[pi/tempera] shot-change idx ${lastShotProbeId}→${shotProbeKey} enterAlpha=${enteringEffect.alpha.toFixed(2)} aA=${layersA.container.alpha.toFixed(2)} aB=${layersB.container.alpha.toFixed(2)} travel=${shotEnterTravel.toFixed(1)} exitDone=${host.dataset.temperaOutgoingExitAlpha ?? '-'}`,
                );
              }
              lastShotProbeId = shotProbeKey;
              /* 诊断（第 667 轮）：主层几乎不可见时留一条，附带出画侧的 alpha —— 见上面那条注释。 */
              if (!faintPrimaryLogged && layersA.container.alpha < 0.2) {
                faintPrimaryLogged = true;
                console.info(
                  `[pi/tempera] faint-primary first t=${timeSec.toFixed(2)} aA=${layersA.container.alpha.toFixed(2)} aB=${layersB.container.alpha.toFixed(2)} alive=${aliveIndices.length}`,
                );
              }
              /* 诊断：本帧推进位移（px）与历史峰值 —— 稳态是 0，所以峰值才是"真的推过"的证据。 */
              const shotEnterAbs = Math.abs(shotEnterTravel);
              host.dataset.temperaShotEnter = shotEnterAbs.toFixed(1);
              if (shotEnterAbs > shotEnterPeak) shotEnterPeak = shotEnterAbs;
              host.dataset.temperaShotEnterPeak = shotEnterPeak.toFixed(1);
              /*
               * 诊断（第 623 轮）：**两侧容器的分离度**（px）与历史峰值。
               * 峰值接近 `0.3 × 长边` ⇒ hand-off 位移真的把两个构图分开了；
               * 峰值 ≈ 0 ⇒ 两个 shot 画在同一位置（那才是"叠字"的真因）。
               */
              const handoffSep = Math.hypot(
                layersA.container.position.x - layersB.container.position.x,
                layersA.container.position.y - layersB.container.position.y,
              );
              host.dataset.temperaHandoffSep = handoffSep.toFixed(1);
              /* 诊断（第 670 轮）：出画侧可见却没分开 —— 见上面那条注释。 */
              if (!overlapLogged && layersB.container.visible && handoffSep < 20) {
                overlapLogged = true;
                console.info(
                  `[pi/tempera] overlap-first t=${timeSec.toFixed(2)} sep=${handoffSep.toFixed(1)} aA=${layersA.container.alpha.toFixed(2)} aB=${layersB.container.alpha.toFixed(2)}`,
                );
              }
              if (handoffSep > handoffSepPeak) handoffSepPeak = handoffSep;
              host.dataset.temperaHandoffSepPeak = handoffSepPeak.toFixed(1);
              /*
               * **第二条证据通道**（ASCII `console`，与 `dataset` 相互独立）：
               * `dataset` 读到 0 而日志里 `travel` 非 0 时，靠这条分辨"位移真没生效"还是"读数被重置"。
               */
              /*
               * **只在峰值刷新时留一条**（降噪）：全跑最多几条，但足以在日志里证明
               * "两个构图真的被分开了" —— 第 623 轮·二用它对上了 `0.88 × 长边`。
               */
              if (handoffSep > handoffSepLogged + 50) {
                handoffSepLogged = handoffSep;
                console.info(
                  `[pi/tempera] handoff-sep peak=${handoffSepPeak.toFixed(1)} A=${layersA.container.position.x.toFixed(1)},${layersA.container.position.y.toFixed(1)} B=${layersB.container.position.x.toFixed(1)},${layersB.container.position.y.toFixed(1)}`,
                );
              }
              layersA.container.scale.set(enteringEffect.scale);
              layersA.container.rotation = enteringEffect.rotation;
              /*
               * **转场模糊**：两侧哪边要模糊取哪边（`shape-carry` 是唯一带 `blur` 的一支，
               * 出画与入画各有各的 0..6）。挂/摘交给 `setTemperaTransitionBlur`：
               * 强度 `> 0.01` 才算有效，**且只在模糊时挂**——
               * 常驻在场景上的滤镜会夺走反色滤镜要用的 backdrop 拷贝（上游 `:817` 的教训）。
               * 分辨率按 `resolveTemperaTransitionBlurResolution`（在它周围那条 pass 的一半）另行设置，
               * 本步先只接强度与挂载。
               */
              const transitionBlur = Math.max(
                outgoingBlur,
                enteringEffect.blur,
                shotHandoffBlur,
              );
              if (worldFilterScene === null && worldBlurEl !== null) {
                /*
                 * 场景常驻滤镜数组。**lens 不在这里**（第 644 轮搬走了）：
                 * 这个对象只在 `worldBlurEl !== null` 时才创建 ⇒ 挂在它上面的滤镜会被"条件"连累，
                 * 所以 lens 改挂 `app.stage`（见本文件上方 `stageLensEffect`），这里只留转场模糊。
                 */
                worldFilterScene = {
                  baseFilters: [],
                  transitionBlurFilter: worldBlurEl,
                  transitionBlurAttached: false,
                  /*
                   * Pixi 的 `Container.filters` 与这里的 `{ filters: unknown[] }` 结构类型对不上，
                   * 所以用访问器直接读写 `world.filters`（写回时 `as never` 只是让 TS 闭嘴，
                   * 值的本体就是那条滤镜数组）。
                   */
                  container: {
                    get filters(): unknown[] {
                      return world.filters as unknown[];
                    },
                    set filters(value: unknown[]) {
                      world.filters = value as never;
                    },
                  },
                };
              }
              if (worldFilterScene !== null) {
                setTemperaTransitionBlur(worldFilterScene, transitionBlur);
                host.dataset.temperaSceneBlurStrength = transitionBlur.toFixed(3);
                if (worldFilterScene.transitionBlurAttached && !blurAttachedSeen) {
                  blurAttachedSeen = true;
                  console.info(
                    `[pi/tempera] transition-blur attached strength=${transitionBlur.toFixed(3)}`,
                  );
                }
                if (transitionBlur > blurMaxSeen + 0.5) {
                  blurMaxSeen = transitionBlur;
                  console.info(`[pi/tempera] transition-blur strength=${transitionBlur.toFixed(3)}`);
                }
              }
              /*
               * **wipe**：三种转场里只有 `block-wipe` 会给出非零行程。
               * 两侧取行程较大者 —— 出画相位是 0→1（把块带进来）、入画相位是 1→2（把它带出另一侧），
               * 于是跨边界正好接成**一次连续行程**（这也正是"不中途反向"的来源）。
               * 角度取行程较大那一侧的角度；颜色见上面 `wipeColor`。
               */
              const wipeTravel = Math.max(outgoingWipe, enteringEffect.wipe);
              const wipeAngle = enteringEffect.wipe >= outgoingWipe ? enteringEffect.wipeAngle : outgoingWipeAngle;
              drawTemperaWipe(wipeTravel, wipeAngle, app.screen.width, app.screen.height, wipeColor);
              host.dataset.temperaWipe = wipeTravel.toFixed(3);
              if (wipeTravel > 0.001 && wipeTravel < 1.999) {
                if (!wipeSeen) {
                  wipeSeen = true;
                  console.info(`[pi/tempera] wipe-active travel=${wipeTravel.toFixed(3)}`);
                }
                if (wipeTravel > wipeTravelMax) {
                  const before = wipeTravelMax;
                  wipeTravelMax = wipeTravel;
                  /*
                   * 每跨过 0.25 留一条：**证明行程真的爬到满覆盖附近**，
                   * 而不是像第 35 轮那样只擦到 0.001（当时只记"首次激活"那一帧，
                   * 而行程正是从 0 起步的，等于什么都没证明）。
                   */
                  if (Math.floor(wipeTravel / 0.25) > Math.floor(before / 0.25)) {
                    console.info(`[pi/tempera] wipe-travel max=${wipeTravel.toFixed(3)}`);
                  }
                }
              }
              const built = buildTemperaFrame({
                program: current.program,
                timeSec,
                viewport: { width: app.screen.width, height: app.screen.height },
                paper: current.paper,
                deep: current.deep,
                glyph: current.glyph,
                accent: current.accent,
                wordColorOf: current.wordColorOf,
              });
              if (built !== null) {
                try {
                  drawFrame(built, timeSec);
                  /*
                   * **片尾**：首帧懒建（色板必须取**逐帧 tones**），此后逐帧推进。
                   * `elapsed` 是"卡片开始以来"的秒数 ⇒ `timeSec - finalEnd - 0.9`。
                   * ⬜ 标题反色暂未接（`createTemperaDifferenceFilter` 的签名我还没确认），先记档。
                   */
                  if (creditsView === null && creditsContainer !== null) {
                    creditsView = createTemperaCreditsView({
                      width: app.screen.width,
                      height: app.screen.height,
                      title: songTitle,
                      artist: songArtist,
                      album: songAlbum,
                      lyricsFontScale: stateRef.current.fontScale,
                      showDecor: true,
                      fontFamily: stateRef.current.fontFamily,
                      tones: { tone: built.tones.tone, paper: built.tones.paper, deep: built.tones.deep },
                      /*
                       * 标题反色：照**本文件既有写法**（`glyphLayer` 那两处）——
                       * `createTemperaDifferenceFilter(pixiModule, { ink, paper })`。
                       * 上游语义：形状在标题下面动，反色**不断重新裁切标题**。
                       */
                      titleFilter: createTemperaDifferenceFilter(pixiModule, {
                        ink: built.tones.deep,
                        paper: built.tones.paper,
                      }),
                    });
                    creditsContainer.addChild(creditsView.container);
                    host.dataset.temperaCreditsContent = `${creditsView.itemCount}笔｜层内节点=${creditsView.nodeCount}`;
                    console.info(`[pi/tempera] credits-content items=${creditsView.itemCount} nodes=${creditsView.nodeCount}`);
                  }
                  if (creditsView !== null && creditsContainer !== null && current.program !== null) {
                    const finalParagraph = current.program.paragraphs[current.program.paragraphs.length - 1];
                    const finalEndTime =
                      finalParagraph?.shots[finalParagraph.shots.length - 1]?.endTime ??
                      finalParagraph?.endTime ??
                      0;
                    const creditsFrame = resolveTemperaCreditsFrame(timeSec, finalEndTime);
                    creditsContainer.visible = !reduced && creditsFrame.posterAlpha > 0;
                    creditsContainer.alpha = creditsFrame.posterAlpha;
                    creditsContainer.scale.set(creditsFrame.posterScale);
                    creditsContainer.y = app.screen.height / 2 + creditsFrame.posterOffsetY * app.screen.height;
                    creditsView.update(timeSec - finalEndTime - 0.9);
                  }
                } catch (error: unknown) {
                  /*
                   * 单帧异常只该丢一帧，不该让整块画布停摆（与莫奈那条同一个教训）——
                   * 但**必须留痕**，而且**按构图种类分开留**：只用一条标志位的话，
                   * "某一族整族画不出来、画布停在上一帧"会被伪装成"这一帧刚好没画东西"。
                   */
                  if (!temperaReportedKinds.has(built.shotKind) && temperaReportedKinds.size < 5) {
                    temperaReportedKinds.add(built.shotKind);
                    console.error(`[pi/tempera] 绘制该帧失败（构图 ${built.shotKind}）`, error);
                  }
                }
              }
            }
            app.render();
          }
          frame = window.requestAnimationFrame(tick);
        };
        frame = window.requestAnimationFrame(tick);
      })
      .catch((error: unknown) => {
        /*
         * WebGL 起不来时留一块空舞台，不把播放页带崩 —— 但**必须留痕**：
         * 上一版把这里写成空 catch，结果「画布 0×0、面板 0」查了半天才发现是 init 直接失败。
         */
        console.error('[pi/tempera] Pixi 初始化失败', error);
      });

    return () => {
      // 画布先摘出 DOM 再销毁：销毁后会连带清掉 canvas 上的样式，留着空壳会让下一套主题
      // 在同一个舞台上量到一块 0×0 的残留。
      if (canvasEl !== null && canvasEl.parentNode === host) host.removeChild(canvasEl);
      dispose();
    };
    /*
     * **依赖里只留 `reduced`**（第 629 轮）：原来还有 `fontScale`，于是"播放中调一次歌词字号"
     * 会**销毁并重建整个 Pixi app** ⇒ 画布空白若干帧、露出外壳背景（第 628 轮连拍抓到的那一帧）。
     * 字号本来不需要重建：三处用到它的地方（装饰散字、装饰词、帧层的 `lyricsFontScale`）
     * 现在都**改读 `stateRef.current.fontScale`**，而那个 ref 每次 render 都会同步 ⇒ 实时生效。
     */
  }, [reduced]);

  return (
    <div
      className="pi-lyrictempera"
      ref={rootRef}
      data-theme="tempera"
      data-tempera-family="split"
      data-tempera-shots={program?.paragraphs.reduce((sum, item) => sum + item.shots.length, 0) ?? 0}
      data-tempera-split-times={implementedShotTimes.split ?? ''}
      data-tempera-band-times={implementedShotTimes.band ?? ''}
      data-tempera-frame-times={implementedShotTimes.frame ?? ''}
      data-tempera-poster-times={implementedShotTimes.poster ?? ''}
      data-tempera-sparse-times={implementedShotTimes.sparse ?? ''}
      data-tempera-cinema-times={implementedShotTimes.cinema ?? ''}
      data-tempera-charm-times={implementedShotTimes.charm ?? ''}
      data-tempera-aperture-times={implementedShotTimes.aperture ?? ''}
      data-tempera-signal-times={implementedShotTimes.signal ?? ''}
      data-tempera-corridor-times={implementedShotTimes.corridor ?? ''}
      data-tempera-monolith-times={implementedShotTimes.monolith ?? ''}
      data-tempera-terrain-times={implementedShotTimes.terrain ?? ''}
      data-tempera-monogatari-times={implementedShotTimes.monogatari ?? ''}
    />
  );
}

export default TemperaTheme;
