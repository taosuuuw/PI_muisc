/**
 * 商籁（sonnet）的 **Pixi 渲染层**：只负责把帧层算好的形状与字形画出来。
 *
 * 分工与凝彩一致：编译层 → 帧层 → 这里。所以本文件里**不该有任何"什么时候、放哪里"的判断** ——
 * 一旦发现需要判断，就说明它该进帧层（能被单测）。
 *
 * === 颜色的口径 ===
 * 帧层给的 `fillTone` / `strokeTone` 是四档编号，含义在下面 `SONNET_TONE_ORDER`：
 * **0 = 墨（最醒目）、1 = 主色、2 = 强调、3 = 纸**。所以帧层里"不指定"的描边会落到墨色上 ——
 * 那是刻意的：商籁的装饰线是**印在纸上**的细线，暗色主题下必须比纸亮才看得见。
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
// 这一行**必须**在 `import ... from 'pixi.js'` 之前：Pixi 用 `new Function` 编译着色器，CSP 会拦下来。
import 'pixi.js/unsafe-eval';
import {
  Application,
  BitmapText,
  BlurFilter,
  Container,  Graphics,
  ImageSource,
  Matrix,
  Rectangle,
  Sprite,
  TextStyle,
  Texture,
  type ColorSource,
} from 'pixi.js';
import {
  type LyricThemeProps,
  createFrameGate,
  resolveCssColor,
  tuningOf,
  useElementFontFamily,
  useLiveThemeColors,
  usePositionClock,
  usePrefersReducedMotion,
} from './types';
import { compileSonnetProgram } from './sonnetProgram';
import { buildSonnetFrame, describeSonnetShotSchedule, type SonnetFrame } from './sonnetFrame';
import { describeSonnetRhythmProfile, resolveSonnetAnimationScale } from './sonnetMotion';
import { isSonnetHeavyShotKind, describeSonnetGeoCoverage } from './sonnetGeo';
import { createSonnetGlitchEffect } from './sonnetGlitchFilter';
import { createSonnetVignetteFilter } from './sonnetPrintFilters';
import { createSonnetLensFilter } from './sonnetLensFilter';
import { resolveSonnetGuideGeometry } from './sonnetGuideGeometry';
import { resolveSonnetGlyphMotion } from './sonnetGlyphMotion';
import {
  frameSonnetCameraToReadingWindow,
  type SonnetReadingFramingResult,
} from './sonnetCameraFraming';
import { describeSonnetReadingWindow } from './sonnetReadingWindow';
import {
  resolveSonnetExitCameraCompensation,
  resolveSonnetLayerCameraTransform,
  resolveSonnetParticleSwimRotation,
  type SonnetCameraLayer,
} from './sonnetLayerCamera';
import { resolveSonnetDecorDrawItems } from './sonnetDecorGeometry';
import { resolveSonnetFrameDecorDraws } from './sonnetFrameDecorShapes';
/*
 * **图标精灵层**（差别②接线）：上游 `sonnetBackgroundDecor.ts` 会把一部分装饰粒子
 * 换成 icon sprite。我们这套规则早就写好了（`sonnetIcons.ts`，八个手写 SVG 形状 + 分配 +
 * 入场相位，全都有单测），但**渲染层从来没 import 过它** ⇒ 上游画面里那些大图标一个都没画出来。
 * `resolveSonnetIconEntryDuration` 与 `resolveSonnetIconEntryDelay` 的真值在 `sonnetScene.ts`
 * （`sonnetIcons.ts` 只是再导出），这里**直接从真值处取**，避免两份实现漂移 ✓。
 */
import {
  buildSonnetIconParticleIndices,
  buildSonnetIconSvg,
  buildSonnetIconTextureKey,
  resolveSonnetIconEntryPhase,
  resolveSonnetIconNames,
} from './sonnetIcons';
import {
  resolveSonnetIconEntryDelay,
  resolveSonnetIconEntryDuration,
  resolveSonnetIconPose,
} from './sonnetScene';
import { resolveSonnetStaffGeometry, resolveSonnetStaffTimedNotes } from './sonnetStaff';
import { resolveSonnetStaffDraws } from './sonnetStaffShapes';
import {
  resolveSonnetTextFixedGeoDraws,
  resolveSonnetTextFixedGeoGeometry,
  resolveSonnetTextFixedGeoPlan,
  resolveSonnetTextFixedGeoRotation,
} from './sonnetTextFixedGeo';
import {
  resolveSonnetBackgroundMgDraws,
  resolveSonnetBackgroundMgVariant,
  SONNET_BACKGROUND_MG_VARIANTS,
  type SonnetBackgroundMgDraw,
} from './sonnetBackgroundMg';
import { resolveSonnetStaggeredDraws } from './sonnetStaggerDraws';
import { resolveSonnetOuterMetadata } from './sonnetOuterMetadata';
import { buildSonnetOuterMetadataNodes } from './sonnetOuterMetadataPixi';
/*
 * 构件用**结构化类型**收 Pixi（见 `sonnetOuterMetadataPixi.ts` 的注释 ✓），
 * 所以这里给它一个聚合对象即可 —— 与文件里既有的具名导入并存、不影响 `:14` 那条 CSP 顺序约束 ✓。
 */
import * as pixiModule from 'pixi.js';
import { resolveSonnetCreditsFrame } from './sonnetCredits';
import {
  advanceSonnetLyricCrossfade,
  createSonnetLyricCrossfadeState,
  describeSonnetLyricCrossfade,
  resolveSonnetLyricSignature,
  type SonnetLyricCrossfadeState,
} from './sonnetLyricCrossfade';
import { buildSonnetCreditsPoster } from './sonnetCreditsPoster';
import {
  buildSonnetVirtualStaffLines,
  shouldUseSonnetVirtualStaffLines,
} from './sonnetVirtualStaff';
import { toSonnetVirtualStaffStageLines } from './sonnetVirtualStaffStage';

/** Pixi 认 `#rgb` / `rgb()` / 颜色名；`var(...)` 链必须先由 `useLiveThemeColors` 落成具体值。 */
/**
 * 把 CSS 颜色串转成 Pixi 认的**数值**。
 *
 * Pixi v8 的颜色解析认 `#hex`、颜色名与数值，**不认 `rgb(117, 210, 206)` 这种函数式写法** ——
 * 原来这里只是把字符串 `as ColorSource` 硬转过去，等于给 `fill` 塞了个它解析不了的值。
 * 这是**真 bug**（已修），但它**不是**"文字不上屏"的原因：改完字照样不出，
 * 真正的原因是 `Text` 走 DOM 上屏那条路（见下面 `glyphNode` 的说明），外加排版少了画面中心平移。
 * 另外 `BitmapText` 的 `fill` 就是 tint（整数），这里返回整数正合用。
 */
function pixiColor(value: string): number {
  const text = value.trim();
  const shortHex = text.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (shortHex) {
    const [, r, g, b] = shortHex;
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  const hex = text.match(/^#([0-9a-f]{6})$/i);
  if (hex?.[1] !== undefined) return Number.parseInt(hex[1], 16);
  const rgb = text.match(/^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
  if (rgb) {
    const [, r, g, b] = rgb;
    return (Number(r) << 16) + (Number(g) << 8) + Number(b);
  }
  return 0xffffff;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/*
 * **发光层参数**（照抄 folia 的 `createSonnetHaloLayer` 与 `resolveSonnetPostProcessProfile`）：
 * `strength = 2.8 + motion × 1.8`、`alpha = min(0.62, 0.28 + motion × 0.12)`，
 * 滤镜用 `quality 2 / kernelSize 5 / resolution 0.75`，整层 `screen` 混合、画在字**之下**。
 *
 * `motion = typographyMotion × resolveSonnetAnimationScale(theme)`；我们没有那两个旋钮
 * （typographyMotion 滑杆与动画强度档），按 **motion = 1** 取默认档 ⇒ strength 4.6、alpha 0.40。
 * 这条差异与"噪声/对比度/镜头畸变/印刷效果一律关"一样，是因为原版那些都在 `postProcessEnabled`
 * 这个总开关后面、默认不开，而**发光不受它管**、默认就亮。
 */
/* 逐字占位的宽高比**从帧层借用**（同一个函数）——两边各写一套就会漂移，
   读数不收敛的坑此前已经踩过一次（帧层改了、探针没改，同一个 27 对读出两种含义）。 */
import { sonnetGlyphExtent } from './sonnetFrame';

const SONNET_GLOW_STRENGTH = 2.8 + 1.8;
const SONNET_GLOW_ALPHA = Math.min(0.62, 0.28 + 0.12);
/**
 * 巨型幽灵字（背景空心大轮廓）的**文字自身透明度**。
 *
 * 参考层里那层是"淡淡的轮廓"，不是实心重影；wrapper 的 α 仍由帧层给（入场渐入），
 * 这里只压字体节点这一层 ⇒ 实际可见度 = 帧层 α × 0.2。
 */
const SONNET_GHOST_TEXT_ALPHA = 0.2;
/**
 * **发光层整层 α**（`haloLayer` / 出场层 `haloOutLayer` 共用同一个基准值）。
 *
 * 提成常量是因为"歌词交叉淡变"要逐帧写这两层的 α（`基准 × 入场 α` / `基准 × 出场 α`），
 * 写死两份就会漂移。
 */
const SONNET_HALO_LAYER_ALPHA = SONNET_GLOW_ALPHA * 1.3;

/**
 * **整跑最大重叠对数**（模块级，纯诊断）。
 *
 * 为什么还要这个：原来的重叠探针按"键值变化"打印，而键里含 `pairs` ⇒ 两次运行的**读数条数**
 * 会随可见状态集合变化（实测一次 33 条、一次 36 条），**拿条数或拿某几条直接对比是不成立的**。
 * 这个"整跑最大值"同一把尺子量每次运行，跨运行才可比。
 */
let sonnetOverlapMaxPairs = 0;

export function SonnetTheme(props: LyricThemeProps): ReactNode {
  const { lines, positionMs, playing, theme } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const clock = usePositionClock(positionMs, playing ?? true);
  const reduced = usePrefersReducedMotion();
  const { fontScale, fpsCap } = tuningOf(theme);
  const colors = useLiveThemeColors(rootRef, theme);
  const fontFamily = useElementFontFamily(rootRef);
  /** 离屏 canvas 的 2D 上下文（真实文本测量用；拿不到就保持 null，帧层退回估算）。 */
  const measureContextRef = useRef<CanvasRenderingContext2D | null>(null);
  /** 测量缓存：键是 `字号|字重|文本`。 */
  const measureCacheRef = useRef<Map<string, number>>(new Map());

  /**
   * 编译一次，整首歌复用。
   *
   * 种子取"行数 + 首末行文本"当指纹：同一首歌的同一份歌词必须编译出**同一份**分镜，
   * 否则每次重渲染都会换一套镜头，观感就成了随机闪。
   */
  /*
   * **器乐（整首没有词）⇒ 用虚拟五线谱行**（照抄上游 `VisualizerSonnet.tsx` ✓，第 559 轮接线）：
   * 上游的做法是"**编译前替换 `programLines`**" ✓ ⇒ 我们也在这一步替换 ✓。
   * 数值：**60 条、每 8 秒一段、占前 6 秒、字只有 `♪`** ✓（见 `sonnetVirtualStaff.ts` ✓）。
   * ⚠ 入参与**种子**两处都要用替换后的行 ✓ —— 否则"同一首歌、有无词两种情况"会得到**不同分镜** ✗。
   */
  const sonnetSourceLines = useMemo(
    () =>
      shouldUseSonnetVirtualStaffLines(lines)
        ? toSonnetVirtualStaffStageLines(buildSonnetVirtualStaffLines())
        : lines,
    [lines],
  );
  /*
   * **给探针用**（第 563 轮）：`sonnetSourceLines` **就是** `lines` 本身 ⇒ 说明**没启用**虚拟行 ✓
   * ——"引用相等"正是"没走那一支"的判据 ✓（那一支直接返回入参 ✓，不是拷贝 ✓）。
   */
  const sonnetVirtualStaffCount = sonnetSourceLines === lines ? 0 : sonnetSourceLines.length;
  const program = useMemo(
    () =>
      compileSonnetProgram(sonnetSourceLines, {
        seed: `${sonnetSourceLines.length}|${sonnetSourceLines[0]?.text ?? ''}|${sonnetSourceLines[sonnetSourceLines.length - 1]?.text ?? ''}`,
      }),
    [sonnetSourceLines],
  );
  /**
   * **逐字时间轴**（`glyphsByLine`）：舞台把每行切成字素并给了每个字素的起止，
   * 直接搬过来即可 —— 帧层会按段裁出自己那一段。
   *
   * 之前这条路**从来没被填过**（帧层声明了入参、主题却没给），所以逐字节奏一直是"段内均分"。
   * 键是行的 `sourceIndex`，值是这一行每个字素的 `{char, startTime, endTime}`（单位秒，与帧层一致）。
   */
  const glyphsByLine = useMemo(() => {
    const map = new Map<number, { char: string; startTime: number; endTime: number }[]>();
    for (const line of lines) {
      if (line.words.length === 0) continue;
      map.set(
        line.index,
        line.words.map((word) => ({
          char: word.text,
          startTime: word.startMs / 1000,
          endTime: word.endMs / 1000,
        })),
      );
    }
    return map;
  }, [lines]);

  const inkColor = colors.ink !== undefined && colors.ink !== '' ? colors.ink : colors.primary;
  /** 主题已有的动画强度档（calm/normal/chaotic）折算成帧层的幅度系数，不加新设置项。 */
  const animationScale = resolveSonnetAnimationScale(theme.animationIntensity);
  const stateRef = useRef({
    program,
    /*
     * **逐字时间轴也必须进 `stateRef`**：`tick` 里若用 effect 创建时捕获的那一份，
     * 换歌后 `program` 已经换了、这一份还是上一首的，逐字时间会错位（沿用上一首的节奏）。
     */
    glyphsByLine,
    clock,
    fontScale,
    fpsCap,
    reduced,
    fontFamily,
    ink: inkColor,
    emphasis: colors.accent,
    primary: colors.primary,
    paper: colors.surface,
    animationScale,
  });
  stateRef.current = {
    program,
    glyphsByLine,
    clock,
    fontScale,
    fpsCap,
    reduced,
    fontFamily,
    ink: inkColor,
    emphasis: colors.accent,
    primary: colors.primary,
    paper: colors.surface,
    animationScale,
  };

  useEffect(() => {
    const host = rootRef.current;
    /*
     * **第二强调色**（上游的外层元数据、文本几何、片尾块都用它）。
     *
     * 主题契约里本来就有 `theme.secondaryColor`（凝彩的 `duo` 档色阶在用同一个 token），
     * 我们商籁却一直拿 `accent` 顶替 ⇒ 装饰全挤成同一个颜色、层次被压平（差异此前登记在案）。
     * `resolveCssColor` 是因为主题色可能是 `var(--pi-th-…)` 这种变量引用，而 Pixi 的 `fill`
     * 只吃数字或它认得的颜色（第 427 轮冒烟的 `Unable to convert color var(...)` 就是这个坑）；
     * 主题没给第二色时退回 accent —— 与改造前逐值一致，不会更差。
     */
    const secondaryTone =
      theme.secondaryColor === undefined
        ? pixiColor(colors.accent)
        : pixiColor(resolveCssColor(host, theme.secondaryColor));
    if (host === null) return;
    let destroyed = false;
    /** rAF 句柄：cleanup 里必须取消，否则主题切走之后这个循环还在跑。 */
    let frame = 0;
    const app = new Application();
    /** 同一构图种类只报一次，避免刷屏（但**每种都要报**，否则一族整族画不出来会被看成"只失败过一次"）。 */
    const reportedKinds = new Set<string>();

    /** 拆滤镜用（在 `app.init()` 之后才有值）。 */
    let detachFilters: (() => void) | null = null;

    const dispose = (): void => {
      window.cancelAnimationFrame(frame);
      try {
        detachFilters?.();
        app.destroy(true, { children: true });
      } catch {
        /* WebGL 上下文没起来（或已经销毁）时 destroy 会抛，不该冒到 React 上。 */
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
         * **反色/模糊滤镜的必要条件**（照抄凝彩的初始化）。
         * 转场用的 BlurFilter 声明了 lendRequired（要读下层已画好的像素），而 Pixi 只有在
         * 渲染器开了 backBuffer 时才给那块快照 —— 否则它只打一条警告，然后**静默跳过整个滤镜**。
         */
        useBackBuffer: true,
      })
      .then(() => {
        if (destroyed) {
          dispose();
          return;
        }
        app.canvas.style.width = '100%';
        app.canvas.style.height = '100%';
        host.appendChild(app.canvas);

        /*
         * 真实文本测量用的离屏 canvas 与缓存（整条主题生命周期共用一份）。
         * 原版把测量结果按 `fontSpec|字号|文本` 记忆化（`MEASURE_CACHE_LIMIT = 20000`）；
         * 我们这里同样按"字号|字重|文本"缓存，上限取小一点（4000）够用又不占内存。
         */
        if (measureContextRef.current === null) {
          try {
            measureContextRef.current = document.createElement('canvas').getContext('2d');
          } catch {
            measureContextRef.current = null;
          }
        }

        /** 镜头整体运镜用的世界容器：形状与字都挂在它下面，所以相机一次变换就够。 */
        const world = new Container();
        const shapeLayer = new Container();
        /*
         * **发光层**：同一份文字再画一遍（孪生节点，共用同一位图字体图集，不额外烘图），
         * 整层挂一个模糊滤镜 + `screen` 混合，就得到实录里大字外围那圈柔光。
         * 层级放在字**之下**（原版也是先把 halo 层挂进镜头容器）。
         */
        const haloLayer = new Container();
        const haloBlur = new BlurFilter({
          strength: SONNET_GLOW_STRENGTH * 1.7,
          quality: 2,
          kernelSize: 5,
          resolution: 0.75,
        });
        haloLayer.filters = [haloBlur];
        haloLayer.alpha = SONNET_HALO_LAYER_ALPHA;
        haloLayer.blendMode = 'screen';
        const glyphLayer = new Container();
        /*
         * **出场（旧歌词）层**：换句那一刻把上一句字形的**视觉状态快照**拷进这两个池，
         * 整层按交叉淡变淡出（见 `sonnetLyricCrossfade.ts`）—— 新旧两幅画面因此短暂共存，
         * 而不是新数据把旧字形就地覆盖写（那正是"硬切"）。
         *
         * 层序：出场层紧挨在入场层**之前** ⇒ 新词压旧词之上、旧词在下面淡出。
         * ⚠ 旧句不是"跟新相机一起走"的：`world` 在同一帧更早的位置就换成新镜头了，
         * 所以这两个层外面套了相机补偿容器（见下面 `lyricOutStage`）—— 旧句留在换镜前的屏幕位置。
         * 淡变走完就 `visible = false`（不白画）。
         */
        const haloOutLayer = new Container();
        haloOutLayer.filters = [
          new BlurFilter({
            strength: SONNET_GLOW_STRENGTH * 1.7,
            quality: 2,
            kernelSize: 5,
            resolution: 0.75,
          }),
        ];
        haloOutLayer.alpha = SONNET_HALO_LAYER_ALPHA;
        haloOutLayer.blendMode = 'screen';
        haloOutLayer.visible = false;
        const glyphOutLayer = new Container();
        glyphOutLayer.visible = false;
        /*
         * **出场层的相机补偿容器**（见 `sonnetLayerCamera.ts` 的
         * `resolveSonnetExitCameraCompensation`）：出场层仍留在 `world` 里（于是转场模糊 / 故障、
         * 暗角、片尾那套世界级滤镜**照旧只挂一份**、自动作用在旧句上，不需要为它复制滤镜链），
         * 但它外面多套一层容器，本地变换取 `L = 当前 world⁻¹ · 上一帧 world` ⇒
         *   `当前 world · L · p = 上一帧 world · p`
         * 旧句于是**停在换镜前的屏幕位置**淡出，不会跟着新相机跳。
         * 补偿每帧按新相机重算（不是把新相机拷给出场层），活动歌词一行不动。
         */
        const lyricOutStage = new Container();
        lyricOutStage.addChild(haloOutLayer, glyphOutLayer);
        /** 上一帧 `world` 的局部变换（换镜那一刻就是"旧句被画出来时用的相机"）。 */
        const previousWorldTransform = new Matrix();
        /**
         * **快照那一刻的相机**：出场层整段淡变都用它（不能在淡变中每帧改成新相机 ——
         * 那会把旧句重新贴回新镜头，等于没补偿）。
         */
        const outgoingWorldTransform = new Matrix();
        /** 复用的补偿矩阵（每帧只在有出场画面时写，避免分配）。 */
        const exitCompensation = new Matrix();
        /*
         * **取景语义（本轮纠正，见 `sonnetCameraFraming.ts` 的 `frameSonnetCameraToReadingWindow`）**：
         * 这里**不再**建"整镜正文取景器"—— 旧做法把 `current.glyphs` 的**全部落位边界**塞进安全区，
         * 歌词一长（多行 / 长句）就只能拉远 ⇒ 一屏塞几句、字被缩成小字，正是主人报的毛病。
         *
         * 现在取景只认帧层算好的**阅读窗口**（当前词组 + 前后近邻，见 `sonnetReadingWindow.ts`）：
         * 尺寸有下限（0.78，装不下就允许窗外块出血）、平移有上限（0.16 视口，远块拗不动镜头），
         * 窗口本身是绝对时间的**连续**函数 ⇒ 换块时 zoom / pivot 不跳、seek 一致。
         */
        /*
         * **引导线层**（照抄 folia `sonnet/sonnetGuides.ts`：文字抵达前先画一道引导线 + 抛一把几何碎屑）：
         * 放在 `glyphLayer` **之前** ⇒ 引导线在文字**下方** ✓；数据来自帧层的 `current.guides` ✓。
         */
        /*
         * **背景装饰层**（照抄 folia `sonnet/sonnetBackgroundDecor.ts`）：一小把按种子档位摆开的小装饰。
         * 它放在**最底**（`decorLayer` 是所有层里第一个）⇒ 任何字形、引导线都在它上面 ✓。
         */
        const decorLayer = new Container();
        const guideLayer = new Container();
        /*
         * **背景 MG 层**：整幅画面级的背景家具，不吃全场旋转与视差（它的框线按视口坐标画）。
         * 层序在所有层之前 ⇒ 仍是最底。
         */
        const bgMgLayer = new Container();
        /*
         * **词级几何层**：每个词自己的背后几何，不吃全场旋转与视差（那样会与词错位）；
         * 深度只逐节点按 `frame.zDepth` 给。层序在 `decorLayer` 之后、`shapeLayer` 之前。
         */
        const textGeoLayer = new Container();
        /*
         * **装饰性开放边框层**：边框围绕某个词长出来（位置/旋转取自那条 placement），
         * 所以同样不能吃全场旋转；与引导线保持同一坐标。层序与词级几何同批。
         */
        const frameDecorLayer = new Container();
        /*
         * **五线谱层**（第 462 轮新增）：放在 `haloLayer` 与 `guideLayer` 之间 ⇒
         * **在背景/装饰之上、字形与引导线之下** ✓ —— 上游的五线谱属于"镜头自己的容器" ✓；
         * 第 461 轮把它误挂在**最底层** `decorLayer` 上，细线（alpha 0.16~0.3）被亮拼贴淹掉 ✗ ⇒ 本轮修这个 ✓。
         */
        const staffLayer = new Container();
        /*
         * ②「五线谱弱化」（主人点名的方向之二）：不删（folia 源码里本来就有谱面），
         * 只把**整层透明度压到一半**，让它成为背景纹理而不是抢字。上一轮已经把基准字号
         * 从 `屏高 × 0.12` 收到 `× 0.07`；两道一起，谱面从"大而淡的网格"变成"细而淡的线"。
         * ⚠ 这个 0.5 是**基准**：逐帧写的是 `基准 × 转场 α`（见 `transitionAlphaLayers`）✓。
         */
        staffLayer.alpha = 0.5;
        /*
         * **外层元数据层**（照抄 folia `sonnet/sonnetSceneBuilder.ts:128~169`）：
         * 左下一条**竖排**的主题标签 + 右上一个小说明块 ✓（上游挂在 `sceneBackgroundLayer` ✓）。
         * 我们**先挂 ⇒ 画在最底** ✓（Pixi 按子节点顺序绘制 ✓）。
         * 版面常数**全部来自 `resolveSonnetOuterMetadata`** ✗ 不许在这里另写常数；
         * 色映射：上游 `theme.primaryColor → colors.primary` ✓、`theme.secondaryColor → 我们的 colors.accent` ✓（差异已登记）；
         * 尺寸用 `app.screen`（建层作用域里没有 `viewport` ✓）。
         */
        const outerMetadataLayer = new Container();
        const outerMetadata = resolveSonnetOuterMetadata({
          themeName: '商籁',
          themeDescription: '竖排的字、印刷的块，把一个段落排成一首商籁。',
          width: app.screen.width,
          height: app.screen.height,
          manualFontWeight: null,
          outerFrameMode: 'full',
          showOnlyText: false,
        });
        const outerMetadataNodes = buildSonnetOuterMetadataNodes(
          pixiModule,
          outerMetadata,
          fontFamily,
          /*
           * ⚠ **必须过 `pixiColor`**：我们的主题色是 **CSS 颜色字符串**（甚至可能是
           * `var(--pi-th-primary, #ecf1f3)` 这种**变量引用** ✗），而 Pixi 的 `fill` 只吃数字或它认得的颜色 ✗。
           * 第 427 轮冒烟就因此报了 `Unable to convert color var(--pi-th-primary, #ecf1f3)` ✓（真错误，不是噪声 ✓）。
           */
          { primary: pixiColor(colors.primary), secondary: secondaryTone },
        ).nodes;
        outerMetadataLayer.addChild(...outerMetadataNodes);
        world.addChild(outerMetadataLayer);
        /*
         * 层序：外层元数据（最底）→ 背景 MG → 背景粒子 → **边框与词级几何** → 背景构图 → 发光
         * → 五线谱 → 引导线 → 字形。
         * 背景 MG / 边框 / 词级几何各自独立成层（不吃背景粒子那一层的全场旋转与统一视差）。
         */
        world.addChild(
          bgMgLayer,
          decorLayer,
          frameDecorLayer,
          textGeoLayer,
          shapeLayer,
          lyricOutStage,
          haloLayer,
          staffLayer,
          guideLayer,
          glyphLayer,
        );
        /*
         * **末句结束时刻**（第 533 轮接线）：`max(所有行的 renderEndTime)` ✓
         * —— 与程序层 **同式**（`sonnetProgram.ts:407/:605` 就是 `reduce(max(renderEndTime))` ✓），
         * 而 `renderEndTime` 本身已把 `renderTail`（"唱完还要停一小会儿" ✓）含进去 ✓。
         * ⚠ 上游函数名是 `finalLyricEndTime`，但它**到底取"最后一行"还是"最后一段"未核** ✗
         *   （调用点不在本地快照里 ✗）⇒ 我们取**前者** ✓，并把它登记成**我们的选择** ✓。
         */
        const finalLyricEndTime = program.paragraphs.reduce(
          (latest, paragraph) =>
            paragraph.lines.reduce((lineLatest, line) => Math.max(lineLatest, line.renderEndTime), latest),
          0,
        );
        /*
         * **片尾海报层**（照抄 folia `sonnet/sonnetCredits.ts`）：盖在**所有层之上** ✓
         * —— 在上一行那批之后**单独挂** ⇒ 改动面最小 ✓，且天然最顶 ✓。
         * 版式是静态的 ✓ ⇒ **建层时画一次** ✓（逐帧只改 `alpha / scale / y` ✓）。
         * ⚠ 我们这边的差异：上游**直接建 Pixi 容器**，我们走"**绘制清单 → 照单画**" ✓
         *   （清单由 `buildSonnetCreditsPoster` 出 ✓ ⇒ 版式可被用例逐条核对 ✓）。
         * ⚠ 配色一律过 `pixiColor` ✓（`:299~304` 那条"CSS 变量 Pixi 不认"的坑 ✓）；
         *   `secondary` 在我们这里一直映射到 `colors.accent` ✓（既有约定 ✓）。
         */
        const creditsLayer = new Container();
        creditsLayer.visible = false;
        const creditsNode = new Graphics();
        creditsLayer.addChild(creditsNode);
        let creditsBlurFilter: BlurFilter | null = null;
        const creditsPoster = buildSonnetCreditsPoster({
          width: app.screen.width,
          height: app.screen.height,
          lyricsFontScale: fontScale,
          /* ⚠ 这三个名字**不在**组件的解构里（`:110` 只取了 4 个字段 ✗）⇒ 必须走 `props.` ✓
             （`LyricThemeProps` 里它们是可选的 `songTitle/songArtist/songAlbum` ✓，见 `types.ts:125~127` ✓）。
             第 533 轮的教训：**别把别的主题（莫奈）的字段名记成商籁的** ✗ ——
             我上一轮"产地勘察"里引的 `:525~527` 其实是 `MonetTheme.tsx` 的行号 ✗。 */
          metadata: { title: props.songTitle, artist: props.songArtist, album: props.songAlbum },
          fontFamily,
          titleWeight: 700,
          detailWeight: 500,
        });
        const creditsTone = (tone: 'primary' | 'secondary' | 'accent'): number =>
          tone === 'primary'
            ? pixiColor(colors.primary)
            : tone === 'accent'
              ? pixiColor(colors.accent)
              : secondaryTone;
        creditsPoster.draws.forEach((draw) => {
          if (draw.kind === 'rect') {
            creditsNode
              .rect(draw.x, draw.y, draw.width, draw.height)
              .fill({ color: creditsTone(draw.tone), alpha: draw.alpha });
            return;
          }
          creditsNode
            .moveTo(draw.x1, draw.y1)
            .lineTo(draw.x2, draw.y2)
            .stroke({ color: creditsTone(draw.tone), width: draw.width, alpha: draw.alpha });
        });
        creditsPoster.texts.forEach((entry) => {
          const node = new pixiModule.Text({
            text: entry.text,
            style: new TextStyle({
              fontFamily: creditsPoster.fontFamily,
              fontSize: entry.fontSize,
              fontWeight: String(entry.fontWeight) as TextStyle['fontWeight'],
              fill: creditsTone(entry.tone),
              letterSpacing: entry.letterSpacing,
              leading: entry.leading,
              wordWrap: true,
              wordWrapWidth: entry.wordWrapWidth,
              breakWords: entry.breakWords,
              align: 'left',
            }),
          });
          node.position.set(entry.x, entry.y);
          creditsLayer.addChild(node);
        });
        world.addChild(creditsLayer);
        /*
         * **片尾内容探针**（第 538 轮）：**建层时打一次** ✓ ——
         * "海报到底有没有被构造、并挂进层"是**结构事实** ✓，不随时序变化 ✓；
         * 这一条正好补上第 537 轮那个负结果的缺口：**即使冒烟拍不到片尾那一帧** ✓，
         * 也能证明"清单出了几笔几字、层里实际有几个节点" ✓（含元数据是有还是空 ✓）。
         */
        const creditsContent =
          `${creditsPoster.draws.length}笔+${creditsPoster.texts.length}字｜层内节点=${creditsLayer.children.length}`;
        host.dataset.sonnetCreditsContent = creditsContent;
        console.info(
          `[pi/sonnet] 片尾内容=${creditsContent}｜元数据=${creditsPoster.texts.length > 0 ? '有' : '空'}`,
        );
        app.stage.addChild(world);
        /*
         * **转场 α 作用的层**（`baseAlpha` 是这一层自己的基准透明度，逐帧被 `基准 × 转场 α` 覆盖写）。
         *
         * ⚠ **歌词两层不在表里** —— 这是本轮的关键改动：
         * 旧写法是 `world.alpha = current.transition.alpha`，而 `fast-blur` / `camera-pull` 的
         * **出场 α 会算到 0**
         * ⇒ 换镜那几帧是**整屏全黑**（背景、粒子、字一起没），观感就是"硬切 + 黑闪"。
         * 现在转场 α 只压这些**非歌词层**（它们的行为与改造前**逐值相同**：`worldAlpha × layerAlpha`
         * 乘法顺序无关），歌词改由局部交叉淡变接管（旧句淡出 / 新句淡入）。
         * ⚠ 别把它当成"始终有字"的保证：两个 α 之和为 1 只是两层互补，新句的字可能还没轮到入场
         * （逐字 α 仍为 0）。这里保证的是**过渡连续、不硬切**。
         */
        const transitionAlphaLayers: { node: Container; baseAlpha: number }[] = [
          { node: outerMetadataLayer, baseAlpha: 1 },
          { node: bgMgLayer, baseAlpha: 1 },
          { node: decorLayer, baseAlpha: 1 },
          { node: frameDecorLayer, baseAlpha: 1 },
          { node: textGeoLayer, baseAlpha: 1 },
          { node: shapeLayer, baseAlpha: 1 },
          /* 五线谱层自己的基准是 0.5（见它创建处的注释）。 */
          { node: staffLayer, baseAlpha: 0.5 },
          { node: guideLayer, baseAlpha: 1 },
        ];
        /** 拆滤镜用：销毁前先把滤镜摘掉，否则会刷「纹理已销毁却还绑在着色器上」。 */
        detachFilters = () => {
          haloLayer.filters = [];
          haloOutLayer.filters = [];
          world.filters = [];
          glyphLayer.filters = [];
        };

        /*
         * 转场的**模糊通道**：滤镜很贵，所以只在 `blurPx > 0` 时挂在世界上，平时摘掉。
         * `strength` 就是帧层算出来的 `amount × 14`（见 `sonnetTransitions.ts` 的 `fast-blur`）。
         */
        const transitionBlur = new BlurFilter({ strength: 0, quality: 4 });
        /** 当前有没有挂着模糊：避免每帧反复设 `filters`（那会触发滤镜链重建）。 */
        let blurAttached = false;
        /*
         * 转场的**故障通道（mono-glitch）**：帧层把 `glitch`（0~1 的缓动量）与 `glitchSeed`
         * （**按 14 档量化**过的跳帧种子）算好，这里用上游同款着色器画出来 ——
         * 粗 26 / 细 110 条横带、被选中的带横向撕裂、再叠一层**等量**亮度撕裂（不做 RGB 色散）。
         * 第 68~70 轮这里是"自己去饱和 + 跳帧错位"的替身，第 72 轮换成 `sonnetGlitchFilter.ts` 的正主。
         */
        const glitch = createSonnetGlitchEffect();
        let glitchAttached = false;
        /*
         * **场景级暗角**（用户本轮：对照 folia 录屏「背景更暗、四角压黑」）。
         *
         * 我们早就把上游那支后处理抄进来了（`sonnetPrintFilters.ts` 的
         * `createSonnetVignetteFilter`），但它**一直没接线** —— `filter.enabled` 默认 false，
         * 而且从来没人 import（同文件里的 RGB shift / 半调也一并留着没接）。
         * 现在只接暗角这一支：`uAmount = 1` ⇒ 边缘最多混向不透明黑 0.6（数值照抄上游）。
         *
         * `filterArea` 必须**钉成视口大小**并常驻同一个矩形对象：着色器要的是稳定的 0..1
         * 视口坐标（见该文件 `SONNET_VIGNETTE_FRAGMENT` 的注释），交给 Pixi 按容器包围盒算
         * 会随歌词大小每帧抖动、暗角跟着闪。
         * RGB shift / 半调**先不接**（上游由 `postProcessEnabled` 总开关管，我们没读到那一段）。
         */
        const vignette = createSonnetVignetteFilter(1);
        /*
         * ⚠ **暂时关掉**（主人实测：装上之后整屏大字全看不见，只剩背景与译文）。
         * 它是唯一作用在**整个 `world`**（含所有字形）上的后处理 —— 滤镜一旦在真实窗口里
         * 采样/坐标不对，世界就被画成透明，正好表现为"画布什么都没有、DOM 层照旧"。
         * 上游本来也把它放在 `postProcessEnabled` 总开关下面（那段我们没读到），所以关掉
         * 是回到上游的保守默认；等能在连续多帧上验收之后再重开。
         */
        vignette.filter.enabled = false;
        /*
         * ③「色差」（主人按顺序点名的方向之三）：用项目里早就抄好的 `sonnetLensFilter`
         * —— 上游那支镜头滤镜，径向色散就是字缘的**品红/青边**（模拟信号不稳定的数字质感）。
         *
         * 只开**色散**、不开**桶形畸变**：畸变会弯整幅画面，不是主人要的那个效果。
         * 挂法与**既有的转场模糊/故障同一处**（`world` 的滤镜链）——那两支持续可用很久，
         * 是已知靠得住的挂法；上一次把画布画成透明的是新写的**暗角着色器**（已单独关掉查因）。
         */
        const lens = createSonnetLensFilter({ distortion: 0, dispersion: 0.28 });
        /*
         * ⚠ **暂时关掉**（2026-10-09 主人实测：播放一段时间后整屏什么都不显示，只剩背景与播放条）。
         * 它与"暗角"是同一类东西：**作用在整个世界上的全屏后处理**——一旦在真实窗口里
         * 采样/渲染目标出问题，整个画布（字 + 装饰）一起消失，正好对得上截图。
         * 隐藏全部内容这种失败模式，比它带来的那点色差重要得多 ⇒ 先关，等能在"播放若干分钟"
         * 的长跑里连续多帧验收之后再谈重开。代码与参数都留着，重开就是这一行的 true。
         */
        lens.filter.enabled = false;
        const sceneFilterArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
        world.filterArea = sceneFilterArea;
        world.filters = [vignette.filter];
        const shapePool: Graphics[] = [];
        const shapeNode = (index: number): Graphics => {
          const existing = shapePool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          shapePool[index] = created;
          shapeLayer.addChild(created);
          return created;
        };
        /*
         * **引导线的池子**：一条引导线一个 `Graphics`，按段下标复用（照抄上面 `shapeNode` 的写法）✓。
         */
        const guidePool: Graphics[] = [];
        const guideNode = (index: number): Graphics => {
          const existing = guidePool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          guidePool[index] = created;
          guideLayer.addChild(created);
          return created;
        };
        /*
         * **背景装饰的池子**（一个粒子一个 `Graphics`，照抄上面两处的写法）✓。
         */
        const decorPool: Graphics[] = [];
        const decorNode = (index: number): Graphics => {
          const existing = decorPool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          decorPool[index] = created;
          decorLayer.addChild(created);
          return created;
        };
        /*
         * **图标精灵池**（差别②接线）。
         *
         * 上游 `sonnetBackgroundDecor.ts` 的做法：把**一部分装饰粒子换成 icon sprite**
         * （`buildSonnetIconParticleIndices` 决定是哪些、用哪一个），sprite **锚点居中**、
         * 宽高一律 `粒子名义半尺寸 × 7`，alpha 从 0 起、由 `resolveSonnetIconPose`
         * 按"入场进度 + 音频 + 慢脉动"逐帧驱动。
         *
         * 纹理按 `buildSonnetIconTextureKey` 缓存：同名/同色/同线宽/同尺寸**只生成一次 SVG**，
         * 并避开"每帧重建纹理"这条已知的性能坑（与 `glyphStyle` 的缓存是同一纪律）。
         */
        const iconPool: Sprite[] = [];
        const iconTextureCache = new Map<string, Texture>();
        /** 已经**发起**过异步加载的纹理键（避免每帧重复 `Assets.load` 同一张图）。 */
        const iconPending = new Set<string>();
        /** 加载**失败过**的纹理键：记下来就不再重试，免得每帧刷同样一条失败日志。 */
        const iconLoadFailed = new Set<string>();
        const iconNode = (index: number): Sprite => {
          const existing = iconPool[index];
          if (existing !== undefined) return existing;
          const created = new Sprite();
          created.anchor.set(0.5);
          created.visible = false;
          iconPool[index] = created;
          decorLayer.addChild(created);
          return created;
        };
        /*
         * **装饰性开放边框的池子**（一个边框一个 `Graphics`，与上面几处同写法）。
         *
         * 边框是**围绕某个词**的局部装饰（上游给它单独一个容器、位置/旋转取自那条 placement），
         * 所以挂 `frameDecorLayer`：不吃背景粒子那层的全场旋转与统一视差，否则会与词错位。
         * 缓动由本文件自己套（标准指数缓出），不照抄上游两条曲线。
         */
        const frameDecorPool: Graphics[] = [];
        const frameDecorNode = (index: number): Graphics => {
          const existing = frameDecorPool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          frameDecorPool[index] = created;
          frameDecorLayer.addChild(created);
          return created;
        };
        /*
         * **五线谱的池子**（整条谱是一个元件 ⇒ 一个 `Graphics` 就够 ✓；第一版**每帧重画** ✓，
         * 将来若要优化，可以只重画动态部分（静态谱面只在几何变化时重画 ✓）。
         * 数据与几何都是纯函数：`sonnetStaff.ts` 出数据/几何/逐帧参数 ✓，`sonnetStaffShapes.ts` 出图元 ✓。
         */
        const staffPool: Graphics[] = [];
        const staffNode = (index: number): Graphics => {
          const existing = staffPool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          staffPool[index] = created;
          staffLayer.addChild(created);
          return created;
        };
        /** La Folía 的音符（含累加出来的 `startBeat` ✓）。 */
        const staffNotes = resolveSonnetStaffTimedNotes();
        /*
         * **"每个词背后的固定几何"的池子**。
         *
         * 上游把每件几何挂在**该词自己的容器**里（`textLayer` 的最底、在字形之下），
         * 所以它跟着**那个词**的 placement 与入场走。我们这边字形是**绝对坐标**（帧层算好的 `x/y`），
         * 所以给词级几何一个**自己的层**（`textGeoLayer`）：位置由每个池节点自己
         * `position.set(frame.x, frame.y)` 决定，不吃背景粒子那层的全场旋转与统一视差。
         */
        const textGeoPool: Graphics[] = [];
        const textGeoNode = (index: number): Graphics => {
          const existing = textGeoPool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          textGeoPool[index] = created;
          textGeoLayer.addChild(created);
          return created;
        };
        /*
         * **背景 MG HUD 的"池子"**（上游叫它 `bg` 层 ⇒ 要真正在最底）。
         * 它挂自己的层 `bgMgLayer`：MG 是整幅画面级的背景家具（框内坐标按视口算），
         * 吃背景粒子那层的全场旋转会让整圈框线歪着扫过画面。层序仍在所有其它层之前。
         */
        const bgMgPool: Graphics[] = [];
        const bgMgNode = (index: number): Graphics => {
          const existing = bgMgPool[index];
          if (existing !== undefined) return existing;
          const created = new Graphics();
          bgMgPool[index] = created;
          bgMgLayer.addChild(created);
          return created;
        };
        interface SonnetGlyphNode {
          wrapper: Container;
          display: BitmapText;
          haloWrapper: Container;
          halo: BitmapText;
          caWrapper: Container;
          caCyan: BitmapText;
          caRed: BitmapText;
          echo1: BitmapText;
          echo2: BitmapText;
        }
        const glyphPool: SonnetGlyphNode[] = [];
        /** 出场（旧歌词）池：与 `glyphPool` 完全同构，只是挂在 `glyphOutLayer` / `haloOutLayer` 上。 */
        const glyphOutPool: SonnetGlyphNode[] = [];
        /*
         * **字形用 `BitmapText`，不是 `Text`** —— 这是查了十几轮之后换的路线。
         *
         * `Text` 在 Pixi v8 里是 `ViewContainer`：它**不持 GPU 纹理**，而是生成一张 canvas DOM 元素、
         * 由 `DOMPipe` 插进 `app.canvas.parentNode` 靠 DOM 显示（`node_modules/pixi.js/lib/dom/DOMPipe.mjs:16-21`
         * 给那个容器设 `position:absolute; z-index:1000`）。这条路上能调的参数全调过了
         * （字号 / 锚点 / 赋值时机 / wrapper 结构 / 舞台铺满 / 帧循环 / 颜色形态 / 场景滤镜 / backBuffer / 定位二分），
         * 诊断始终显示"文字对象完全健康（有文本、有实测宽高、visible、renderable、坐标在画布内）却不上屏"。
         *
         * `BitmapText` 走的是**位图字体图集 + 与 `Graphics` 同一条 GPU 管线**
         * （`AbstractBitmapTextPipe.addRenderable` 直接转交给 `renderPipes.graphics`），
         * 所以装饰形状能画出来的地方，字形就一定画得出来 —— 顺带转场模糊也终于作用在字上了。
         *
         * 图集不用自己管：`TextStyle` 给的是**真实 CSS 字体族**，Pixi 会按 `(字体族, 字重)` 自动建一张
         * `DynamicBitmapFont`（`BitmapFontManager.getFont`），以 100px 烘一次、按 `fontSize` 缩放，
         * 缺字时**逐字懒加载**（`ensureCharacters`）—— 所以同一部首的歌不会重复烘图。
         * 颜色走 tint（白字图集 × `fill`），换色不会重建图集。
         *
         * 每个字形仍然包一层 `Container`（照抄 folia 的 `sonnetTextViewBuilder` 结构）：
         * 位移 / 旋转 / 透明度全设在 wrapper 上，`BitmapText` 只负责字形本身。
         */
        const createGlyphNode = (
          parent: Container,
          haloParent: Container,
          style: TextStyle,
          haloStyle: TextStyle,
          hollowStyle: TextStyle,
        ): SonnetGlyphNode => {
          const wrapper = new Container();
          /*
           * **半主角空心回声**：两块 stroke-only 的位图字挂在 wrapper 下 ⇒ 自动跟随字的位置、
           * 旋转与入场缩放；这里只按帧数据改文本、位移、透明度与"基准字号归一"的缩放。
           * 样式固定为 `hollowStyle`（描边样式在 Pixi 里是**另一张图集**，见那边的注释）。
           */
          const echo1 = new BitmapText({ text: '', style: hollowStyle });
          const echo2 = new BitmapText({ text: '', style: hollowStyle });
          echo1.anchor.set(0.5);
          echo2.anchor.set(0.5);
          echo1.visible = false;
          echo2.visible = false;
          wrapper.addChild(echo1, echo2);
          // 建的时候就带上真正要用的样式，省得先按默认样式烘一张用不上的图集。
          const display = new BitmapText({ text: '', style });
          display.anchor.set(0.5);
          wrapper.addChild(display);
          /*
           * **色差双副本**（青 / 红，screen 混合）也挂在 wrapper 下、画在字身**之前**：
           * 位置/旋转/缩放/透明度全部继承字身（等价于原版把色差层的 α 设成字身 α）。
           * 只用 `tint` 改色 ⇒ 复用字身那份位图字体图集，不会多烘一张。
           */
          const caWrapper = new Container();
          const caCyan = new BitmapText({ text: '', style });
          const caRed = new BitmapText({ text: '', style });
          caCyan.anchor.set(0.5);
          caRed.anchor.set(0.5);
          caCyan.tint = 0x00ffff;
          caRed.tint = 0xff0044;
          caCyan.blendMode = 'screen';
          caRed.blendMode = 'screen';
          caWrapper.addChild(caCyan, caRed);
          caWrapper.visible = false;
          wrapper.addChildAt(caWrapper, 0);
          parent.addChild(wrapper);
          /*
           * **发光层的孪生节点**：同一份文本、**同一份字体族与字重**（位图字体图集按
           * `(字体族, 字重)` 缓存 ⇒ 不会烘第二张图），但**颜色另给**：字身是墨色（白）、
           * 发光吃 accent —— 与 folia 的「accentColor = 歌词发光颜色」一致（用户本轮录屏对照）。
           * 颜色在这里只是 tint，所以换色不会重建图集（见下面 `glyphStyle` 的缓存键）。
           */
          const haloWrapper = new Container();
          const halo = new BitmapText({ text: '', style: haloStyle });
          halo.anchor.set(0.5);
          haloWrapper.addChild(halo);
          haloParent.addChild(haloWrapper);
          const created: SonnetGlyphNode = {
            wrapper,
            display,
            haloWrapper,
            halo,
            caWrapper,
            caCyan,
            caRed,
            echo1,
            echo2,
          };
          return created;
        };
        /** 入场池：按 index 复用（每帧只改文本/位置/透明度，绝不每帧重建节点）。 */
        const glyphNode = (
          index: number,
          style: TextStyle,
          haloStyle: TextStyle,
          hollowStyle: TextStyle,
        ): SonnetGlyphNode => {
          const existing = glyphPool[index];
          if (existing !== undefined) return existing;
          const created = createGlyphNode(glyphLayer, haloLayer, style, haloStyle, hollowStyle);
          glyphPool[index] = created;
          return created;
        };
        /** 出场池：只在换句那一刻按 index 取用，之后整层淡出（不参与逐帧更新）。 */
        const glyphOutNode = (
          index: number,
          style: TextStyle,
          haloStyle: TextStyle,
          hollowStyle: TextStyle,
        ): SonnetGlyphNode => {
          const existing = glyphOutPool[index];
          if (existing !== undefined) return existing;
          const created = createGlyphNode(
            glyphOutLayer,
            haloOutLayer,
            style,
            haloStyle,
            hollowStyle,
          );
          glyphOutPool[index] = created;
          return created;
        };
        /**
         * **换句快照**：把入场池某一粒字当前"看得见的状态"整体拷到出场池的同位节点上。
         *
         * 这就是"单 world 每帧换 glyphs"能变成柔和重叠的那一步 —— 不复制节点、不重排布局，
         * 只把位置/旋转/缩放/透明度/文本/样式/色差副本/回声/光晕照抄一份，
         * 之后出场层整层按交叉淡变压暗。拷贝只发生在换句那一帧，池子热了以后没有分配。
         */
        const snapshotGlyphNode = (from: SonnetGlyphNode, to: SonnetGlyphNode): void => {
          to.wrapper.visible = from.wrapper.visible;
          to.wrapper.position.copyFrom(from.wrapper.position);
          to.wrapper.rotation = from.wrapper.rotation;
          to.wrapper.scale.copyFrom(from.wrapper.scale);
          to.wrapper.alpha = from.wrapper.alpha;
          to.display.style = from.display.style;
          to.display.text = from.display.text;
          to.display.alpha = from.display.alpha;
          to.display.scale.copyFrom(from.display.scale);
          to.haloWrapper.visible = from.haloWrapper.visible;
          to.haloWrapper.position.copyFrom(from.haloWrapper.position);
          to.haloWrapper.rotation = from.haloWrapper.rotation;
          to.haloWrapper.scale.copyFrom(from.haloWrapper.scale);
          to.haloWrapper.alpha = from.haloWrapper.alpha;
          to.halo.style = from.halo.style;
          to.halo.text = from.halo.text;
          to.caWrapper.visible = from.caWrapper.visible;
          if (from.caWrapper.visible) {
            to.caCyan.style = from.caCyan.style;
            to.caRed.style = from.caRed.style;
            to.caCyan.text = from.caCyan.text;
            to.caRed.text = from.caRed.text;
            to.caCyan.alpha = from.caCyan.alpha;
            to.caRed.alpha = from.caRed.alpha;
            to.caCyan.position.copyFrom(from.caCyan.position);
            to.caRed.position.copyFrom(from.caRed.position);
          }
          to.echo1.visible = from.echo1.visible;
          to.echo2.visible = from.echo2.visible;
          if (from.echo1.visible) {
            to.echo1.style = from.echo1.style;
            to.echo2.style = from.echo2.style;
            to.echo1.text = from.echo1.text;
            to.echo2.text = from.echo2.text;
            to.echo1.scale.copyFrom(from.echo1.scale);
            to.echo2.scale.copyFrom(from.echo2.scale);
            to.echo1.position.copyFrom(from.echo1.position);
            to.echo2.position.copyFrom(from.echo2.position);
            to.echo1.alpha = from.echo1.alpha;
            to.echo2.alpha = from.echo2.alpha;
          }
        };
        /*
         * **图集分辨率对齐渲染器**（主人第 ② 条「字形图案带锯齿」的第一刀）。
         *
         * 渲染器按 `min(dpr, 2)` 出图（见上面 `Application({ resolution })`），
         * 而 Pixi 字形图集的 `resolution` **默认是 1** ⇒ 屏幕上连**正常大小**的字都在被拉大两倍；
         * 再叠上"图集按固定基础字号烘一次、按 fontSize 缩放"，主角字到了 400~600px
         * 就是放大四到六倍 ⇒ 锯齿是这两件事加成出来的。
         *
         * 这里把图集分辨率抬到与渲染器一致（高分屏上就是 ×2）。代价是图集纹理变大（内存），
         * 所以先落这一刀、用冒烟图判效果与代价；若代价明显再改成"只给大字档单开一张"。
         * `defaultOptions` 是 `BitmapFontManager` 的静态默认值，对"按需动态烘"的字体同样生效。
         */
        pixiModule.BitmapFontManager.defaultOptions.resolution = Math.min(
          window.devicePixelRatio || 1,
          2,
        );
        const styleCache = new Map<string, TextStyle>();
        /**
         * `fontFamily` 在这里是**图集的键**（Pixi 拿它去 `Cache` 里找 `DynamicBitmapFont`），
         * 同时又是真正的 CSS 字体族 —— 找不到已安装的图集时它会退回"按这个族名动态烘一张"。
         * 所以这里必须给**真实字体族**（不能是自造名），字重参与图集键、字号不参与。
         */
        const glyphStyle = (fontPx: number, fill: ColorSource, weight: number): TextStyle => {
          /*
           * ⚠ 缓存键**必须含字体族**：字体是图集的键，而 `fontFamily` 走 `stateRef` 逐帧可变
           * （宿主换字体/主题切换）。键里不带它，换了字体就会继续复用旧族的样式 ⇒
           * 度量按新字体、显示按旧字体，两边脱节。
           */
          const family = stateRef.current.fontFamily || 'sans-serif';
          const key = `${family}|${fontPx.toFixed(2)}|${weight}|${String(fill)}`;
          const cached = styleCache.get(key);
          if (cached !== undefined) return cached;
          const created = new TextStyle({
            // 兜底：宿主量不到字体时会拿到空串，而 Pixi 拿着空字体名是画不出字的。
            fontFamily: family,
            fontSize: fontPx,
            fontWeight: String(weight) as TextStyle['fontWeight'],
            fill,
            letterSpacing: 0,
          });
          styleCache.set(key, created);
          return created;
        };
        /**
         * 回声用的**固定基准字号**：空心样式必须带描边，而 Pixi 的位图字体图集键在"有描边"时
         * 会把**整份样式（含字号、描边色）**算进去 ⇒ 逐字号建样式就会逐字号烘图集。
         * 这里把字号固定成基准值、由节点 `scale` 归一（`字号 / 基准`），于是一首歌只多一张空心图集；
         * 描边宽度按基准字号取 `clamp(1, 8, 基准 × 0.006)`，缩放后正好等于原版的 `字号 × 0.006`。
         */
        const ECHO_BASE_FONT_PX = 400;
        const hollowStyle = (color: ColorSource, weight: number): TextStyle => {
          /* 键同样含字体族（理由见 `glyphStyle`）：空心图集也按族烘，不带上就会复用旧族。 */
          const family = stateRef.current.fontFamily || 'sans-serif';
          const key = `hollow|${family}|${ECHO_BASE_FONT_PX}|${weight}|${String(color)}`;
          const cached = styleCache.get(key);
          if (cached !== undefined) return cached;
          const created = new TextStyle({
            fontFamily: family,
            fontSize: ECHO_BASE_FONT_PX,
            fontWeight: String(weight) as TextStyle['fontWeight'],
            fill: 'transparent',
            stroke: {
              color,
              width: Math.max(1, Math.min(8, ECHO_BASE_FONT_PX * 0.006)),
            },
            letterSpacing: 0,
          });
          styleCache.set(key, created);
          return created;
        };

        let firstFrameLogged = false;
        /** 节目表是否已经写过（只写一次：分镜表在这一跑里不会变）。 */
        let scheduleWritten = false;
        /** GPU 回读探针是否已经跑过（只跑一次）。 */
        let glyphPixelProbeDone = false;
        /** 攒够几帧"真的有字"的帧再回读，给图集上传留时间。 */
        let glyphPixelFrames = 0;
        /*
         * **歌词交叉淡变**（见 `sonnetLyricCrossfade.ts`）：纯状态机 + 墙钟推进。
         * `liveGlyphCount` 记住上一帧真正在画的字数 —— 换句快照按它拷（池子里多出来的空节点不参与）。
         */
        let lyricCrossfadeState: SonnetLyricCrossfadeState = createSonnetLyricCrossfadeState();
        let lyricCrossfadeProgram = stateRef.current.program;
        let liveGlyphCount = 0;
        /** 上一次打印过的交叉淡变阶段（只在阶段变化时打日志）。 */
        let crossfadePhaseLogged = '';
        /** 已经拷进出场层的那个签名 —— 同一段淡变里**只拷一次**。 */
        let capturedOutgoingSignature = '';
        /**
         * 换句那一帧调用**一次**：把入场池当前内容整体快照到出场层（之后整层淡出），
         * 并把**快照那一刻的相机**存下来给出场层补偿用。
         *
         * ⚠ 不能在整段淡变里每帧都拷：入场池在换句这一帧就会被**新句**覆盖，第二帧再拷
         * 就把新句贴到出场层上了（旧句只剩一帧），补偿也会跟着钉错内容。
         */
        const captureOutgoingLyrics = (): void => {
          outgoingWorldTransform.copyFrom(previousWorldTransform);
          for (let index = 0; index < liveGlyphCount; index += 1) {
            const from = glyphPool[index];
            if (from === undefined) continue;
            const to = glyphOutNode(index, from.display.style, from.halo.style, from.echo1.style);
            snapshotGlyphNode(from, to);
          }
          /* 上一次换句留下的多余出场节点：藏起来，别把更早的句子又画回来。 */
          for (let index = liveGlyphCount; index < glyphOutPool.length; index += 1) {
            const spare = glyphOutPool[index];
            if (spare === undefined) continue;
            spare.wrapper.visible = false;
            spare.haloWrapper.visible = false;
          }
        };
        const drawFrame = (current: SonnetFrame): void => {
          const state = stateRef.current;
          /*
           * 四档色调的**顺序就是语义**：0 墨、1 主色、2 强调、3 纸。
           * （帧层里"不指定"的描边落在 0，也就是墨色 —— 商籁的装饰线是印在纸上的细线。）
           */
          const tones = [state.ink, state.primary, state.emphasis, state.paper];

          // 诊断：把最近一帧的统计写到根节点上，供 UI 冒烟读（像素证据仍由主进程截图提供）。
          host.dataset.sonnetShot = current.shotId;
          host.dataset.sonnetKind = current.shotKind;
          host.dataset.sonnetParagraph = current.paragraphKind;
          host.dataset.sonnetShapes = String(current.shapes.length);
          host.dataset.sonnetGlyphs = String(current.glyphs.length);
          /*
           * **叠字探针**：把"有没有叠"变成可读数字，而不是靠看截图猜。
           * 对当前帧所有字形两两做**包围盒相交**统计，并按"是否幽灵字"分开计数 ——
           * 这样"叠在哪一层、叠了几对"是读出来的：全是幽灵对 ⇒ 关幽灵那条路没生效；
           * 全是普通对 ⇒ 是拼贴排版让不同词压住了。
           * 包围盒用字号粗估（宽 ≈ 0.55×字号、高 ≈ 0.9×字号），只用于**计数比较**，不做像素级判定。
           */
          let overlapPairs = 0;
          let ghostOverlapPairs = 0;
          for (let i = 0; i < current.glyphs.length; i += 1) {
            const a = current.glyphs[i];
            if (a === undefined) continue;
            const aExtent = sonnetGlyphExtent(a.char);
            const aw = a.fontPx * aExtent.w;
            const ah = a.fontPx * aExtent.h;
            for (let j = i + 1; j < current.glyphs.length; j += 1) {
              const b = current.glyphs[j];
              if (b === undefined) continue;
              const bExtent = sonnetGlyphExtent(b.char);
              const bw = b.fontPx * bExtent.w;
              const bh = b.fontPx * bExtent.h;
              if (Math.abs(a.x - b.x) < (aw + bw) / 2 && Math.abs(a.y - b.y) < (ah + bh) / 2) {
                overlapPairs += 1;
                if (a.ghost || b.ghost) ghostOverlapPairs += 1;
              }
            }
          }
          const overlapProbe = `${current.glyphs.length}:${overlapPairs}:${ghostOverlapPairs}`;
          if (host.dataset.sonnetOverlap !== overlapProbe) {
            host.dataset.sonnetOverlap = overlapProbe;
            console.info(
              `[pi/sonnet] overlap glyphs=${current.glyphs.length} pairs=${overlapPairs} ` +
                `ghostPairs=${ghostOverlapPairs} kind=${current.shotKind}` +
                /* `fs` = 全局字号倍率（画字形时乘的那个数）—— 本轮用它定位"字小"是谁压的。 */
                ` fs=${state.fontScale}`,
            );
          }
          /*
           * **整跑最大重叠对数**：只在刷新纪录时打印一行，所以整跑最后那条就是本次运行的峰值。
           * 它是"同一把尺子"，跨运行可比 —— 上一轮那个按键值打印的探针做不到这一点。
           */
          if (overlapPairs > sonnetOverlapMaxPairs) {
            sonnetOverlapMaxPairs = overlapPairs;
            console.info(
              `[pi/sonnet] overlapmax pairs=${overlapPairs} glyphs=${current.glyphs.length} ` +
                `kind=${current.shotKind}`,
            );
          }
          /*
           * **跟拍探针**（主人第 ③ 条：镜头要"跟着新出现的字平滑移动"）。
           *
           * 光看成品图是**证不出"跟着动"**的 —— 那需要一条随时间的**轨迹**。
           * 这里按**镜内进度的二十等分**各打一次（每个镜头约 20 行，不刷屏），
           * 打印的就是最终施加在整棵场景容器上的 `anchorDelta`：
           * 焦点真的在跟唱词走，这组 `x/y` 就必须随 `p` **单调地连续变化**；
           * 若仍是"固定视角"，它会几乎不动（那正是上一版的行为）。
           * 画布尺寸一并打出来，供第 ① 条（铺满窗口）取证 —— 两者是同一条调用链上的事。
           */
          /*
           * **几何探针**（主人第 ① 条：动效背景没填满窗口）。
           *
           * ⚠ 上一版那句 `canvas=${host.clientWidth}x${host.clientHeight}` **读的是宿主，不是画布** ——
           * 所以"铺满窗口"这件事从头到尾**没有量到 `<canvas>` 本身**，我据此宣布①达成是无效证据。
           * 这里把四个尺寸一次打全，一次就能判死活：
           *   `host`      宿主元素的内容盒（选择器给了 `100vw/100vh`，它应等于视口）
           *   `canvasCss` canvas 的 CSS 显示盒 —— **它小于 host 就是没铺满，窗口边缘会露出下层封面/纱**
           *   `canvasBuf` canvas 的位图缓冲（应为 CSS 盒 × resolution）
           *   `screen`    Pixi 的逻辑屏幕（画布内部坐标系，所有落点都按它算）
           * 只在组合变化时打印，所以窗口缩放 / 最大化也各会留一条。
           */
          const geomKey =
            `${host.clientWidth}x${host.clientHeight}|` +
            `${app.canvas.clientWidth}x${app.canvas.clientHeight}|` +
            `${app.canvas.width}x${app.canvas.height}|` +
            `${app.screen.width}x${app.screen.height}@${app.renderer.resolution}`;
          if (host.dataset.sonnetGeom !== geomKey) {
            host.dataset.sonnetGeom = geomKey;
            console.info(
              `[pi/sonnet] geom host=${host.clientWidth}x${host.clientHeight} ` +
                `canvasCss=${app.canvas.clientWidth}x${app.canvas.clientHeight} ` +
                `canvasBuf=${app.canvas.width}x${app.canvas.height} ` +
                `screen=${app.screen.width}x${app.screen.height} res=${app.renderer.resolution}`,
            );
            /*
             * **分层矩形**：`canvasCss` 既然已经等于宿主，"没填满"就**不在画布**——
             * 那下一条要查的是"哪一层页内元素没有铺到窗口边"。打印各层的
             * `getBoundingClientRect()`（左,上 宽x高），和视口一比就看得出来谁短了一截：
             * 封面层、歌词纱、播放页舞台、主题舞台、宿主。
             */
            const rectOf = (selector: string): string => {
              const el = document.querySelector(selector);
              if (el === null) return '无';
              const rect = el.getBoundingClientRect();
              return `${Math.round(rect.left)},${Math.round(rect.top)} ` +
                `${Math.round(rect.width)}x${Math.round(rect.height)}`;
            };
            /*
             * ⚠ 光有尺寸不够：`position: fixed` 的**位置**会随包含块改变
             * （祖先带 transform / filter 时它就不相对视口了）。所以宿主和画布要把
             * **left/top 一起打出来** —— 尺寸对而位置偏，同样会在窗口边上留缝。
             */
            /*
             * **包含块链**（上面两行的读数已经证明：画布**尺寸对、位置错** ——
             * 它被整体挪到 `(24,108)`，正是舞台那圈 `padding: 108px 24px 92px` 的位置）。
             * `position: fixed` 本该相对**视口**定位；只要祖先里有一层带
             * `transform` / `filter` / `backdrop-filter` / `perspective` / `will-change` /
             * `contain` / `container-type: size|inline-size`，包含块就会退化成那一层，
             * `top:0; left:0` 于是落在它的内边距原点而不是窗口原点。
             * 这一行从宿主往上走到 body，把**每一层的可疑属性**指名道姓列出来，
             * 免得再去猜是哪一层。
             */
            const blockers: string[] = [];
            let node: Element | null = host.parentElement;
            while (node !== null && node !== document.body) {
              const cs = getComputedStyle(node);
              const hits: string[] = [];
              if (cs.transform !== 'none') hits.push('transform');
              if (cs.filter !== 'none') hits.push('filter');
              if (cs.backdropFilter !== 'none') hits.push('backdrop-filter');
              if (cs.perspective !== 'none') hits.push('perspective');
              if (cs.willChange !== 'auto') hits.push(`will-change:${cs.willChange}`);
              if (cs.contain !== 'none') hits.push(`contain:${cs.contain}`);
              if (cs.containerType !== 'normal') hits.push(`container-type:${cs.containerType}`);
              if (hits.length > 0) {
                const name = `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}`;
                blockers.push(`${name}[${hits.join(',')}]`);
              }
              node = node.parentElement;
            }
            console.info(
              `[pi/sonnet] cbchain ${blockers.length === 0 ? '（无）' : blockers.join(' | ')}`,
            );
            const canvasRect = app.canvas.getBoundingClientRect();
            console.info(
              `[pi/sonnet] layers cover="${rectOf('.pi-immersive__cover')}" ` +
                `veil="${rectOf('.pi-immersive__lyric-veil')}" ` +
                `homeStage="${rectOf('.pi-home__stage')}" ` +
                `stage="${rectOf('.pi-lyricstage')}" ` +
                `sub="${rectOf('.pi-lyricstage__sub')}" ` +
                `bar="${rectOf('.pi-home__bar')}" ` +
                `host="${rectOf('.pi-lyricsonnet')}" ` +
                `canvas="${Math.round(canvasRect.left)},${Math.round(canvasRect.top)} ` +
                `${Math.round(canvasRect.width)}x${Math.round(canvasRect.height)}" ` +
                `viewport=${window.innerWidth}x${window.innerHeight}`,
            );
          }
          const anchorBucket = Math.floor(current.progress * 20);
          if (host.dataset.sonnetAnchorBucket !== String(anchorBucket)) {
            host.dataset.sonnetAnchorBucket = String(anchorBucket);
            console.info(
              `[pi/sonnet] anchor p=${current.progress.toFixed(2)} ` +
                `x=${current.anchorDelta.x.toFixed(1)} y=${current.anchorDelta.y.toFixed(1)} ` +
                `kind=${current.shotKind} canvas=${host.clientWidth}x${host.clientHeight}`,
            );
          }
          /*
           * **引导线探针**：当帧有几条引导线在画。用途是**不靠肉眼看图**也能验证时机——
           * 上游的窗口是"文字抵达前 lead（0.12~0.38s）出现、抵达后 0.65s 淡出" ✓，
           * 所以同一个时刻"引导线条数"应当是个**可解释的数**（窗口内 > 0、静默期为 0）✓。
           */
          /*
           * **引导线时机证据**：页面日志会被冒烟采集（`[pi/sonnet] …` 那类），
           * 所以"条数**变化**时"打一行就够 —— 用一个 `dataset` 属性存上一次的值，避免每帧刷屏 ✓。
           * 有了它，"文字抵达前 lead（0.12~0.38s）出现、抵达后 0.65s 淡出"就能当数验，不必靠眼睛 ✓。
           */
          const guideCountText = String(current.guides.length);
          if ((host.dataset.sonnetGuidesLast ?? '') !== guideCountText) {
            host.dataset.sonnetGuidesLast = guideCountText;
            console.info(
              `[pi/sonnet] 引导线=${guideCountText}` +
                `｜镜头进度=${current.progress.toFixed(3)}` +
                `｜线进度=${current.guides.map((guide) => guide.progress.toFixed(2)).join(',') || '无'}`,
            );
          }
          host.dataset.sonnetGuides = String(current.guides.length);
          /*
           * **引导线图元探针**：只报"有几条引导线"**分不清**
           * "拖尾到底画出来没有" —— 丝线、矩形 spline、follow circle 都要单独数出来，
           * 所以这里把每条的**笔画数 / 圆点数 / 圆环数 / 白芯数**也报出来（静帧也能当数验）。
           * 只在签名变化时打印（免得每帧刷屏）。
           */
          const guideGeometrySignature = current.guides
            .map((guide) => {
              const geometry = resolveSonnetGuideGeometry(guide);
              const cores = geometry.strokes.filter((stroke) => stroke.core).length;
              return `${guide.index}:${geometry.strokes.length}/${geometry.discs.length}/${geometry.rings.length}/${cores}`;
            })
            .join(',');
          if ((host.dataset.sonnetGuideGeometryLast ?? '') !== guideGeometrySignature) {
            host.dataset.sonnetGuideGeometryLast = guideGeometrySignature;
            console.info(
              `[pi/sonnet] 引导线图元=${guideGeometrySignature || '无'}` +
                `（笔画/圆点/圆环/白芯；进度=${current.guides.map((guide) => guide.progress.toFixed(2)).join(',') || '无'}）`,
            );
          }
          /**
           * 背景装饰粒子数探针（与引导线探针同一用途：当数验、不靠肉眼）✓。
           *
           * 另外打印**形状指纹**（把每颗粒子的形状名接起来）——
           * 上游的卖点是"相邻镜头读起来像**不同的装饰体系**"，所以换镜时这串**必须变** ✓；
           * 形状取自每档自己的三形状调色板 ⇒ 指纹变化就等于档位变化 ✓。
           */
          const decorSignature = current.decor.map((particle) => particle.shape).join(',');
          if ((host.dataset.sonnetDecorLast ?? '') !== decorSignature) {
            host.dataset.sonnetDecorLast = decorSignature;
            console.info(
              `[pi/sonnet] 装饰=${current.decor.length}` +
                `｜镜头=${current.shotKind}｜形状=${decorSignature}`,
            );
          }
          host.dataset.sonnetDecor = String(current.decor.length);
          /*
           * **边框探针**：帧层已经算出 `frameDecor`（`runs` → 边框清单 ✓），但**渲染层还没画** ✗ ——
           * 所以这一步**先只把它当数报出来**（条数 + 档位明细），用冒烟核对
           * 「概率 0.4 有没有生效、档位有没有 4 档都出现过」✓（照引导线/装饰那两套探针的做法 ✓）。
           */
          const frameDecorFrames = current.frameDecor ?? [];
          host.dataset.sonnetFrameDecor = String(frameDecorFrames.length);
          const frameDecorSignature = frameDecorFrames
            .map((frame) => `${frame.variant}@${frame.index}`)
            .join(',');
          if ((host.dataset.sonnetFrameDecorLast ?? '') !== frameDecorSignature) {
            host.dataset.sonnetFrameDecorLast = frameDecorSignature;
            console.info(
              `[pi/sonnet] 边框=${frameDecorFrames.length}｜明细=${frameDecorSignature || '无'}`,
            );
          }
          /*
           * **把边框画出来**（第 448 轮）：逐条按 `startTime → endTime` 算生长进度 ⇒
           * 用**我们自己的**标准指数缓出（`1 − 2^(−10t)` ✓）⇒ 出图元 ⇒ 画进池节点 ✓。
           *
           * 要点（都是照上游语义、实现是我们的）：
           * · **节点位置/旋转**：`resolveSonnetFrameDecorShapes` 出的是**以锚点为中心**的局部坐标 ✓
           *   ⇒ 节点必须 `position.set(anchorX, anchorY)` 且 `rotation = frame.rotation` ✓（上游的独立容器就是这么摆的 ✓）；
           * · **颜色**：`frame`/`ornament` 用**主色 ×0.55**（照抄上游 `dimmmedColor` 的语义 ✓）、`white` 用纯白 ✓，
           *   且**全部过 `pixiColor`** ✓（第 427 轮的教训：CSS 变量字符串 Pixi 不认 ✗）；
           * · **时间自己取**：`timeSec` 在本段**之后**才声明 ✗ ⇒ 这里用**外层那个** `clock`（`:95 usePositionClock` ✓）。
           *   （⚠ 第 448 轮我先写成 `current.clock` ✗ —— `SonnetFrame` 上**没有** `clock` 字段，
           *   `typecheck` 当场报 `TS2339` ✓；改成外层 `clock` 后通过 ✓。）
           */
          const frameDecorTime = clock.current() / 1000;
          const dimFrameDecorColor = (color: number, multiplier: number): number => {
            const r = Math.round(((color >> 16) & 255) * multiplier);
            const g = Math.round(((color >> 8) & 255) * multiplier);
            const b = Math.round((color & 255) * multiplier);
            return (r << 16) | (g << 8) | b;
          };
          const frameDecorColor = dimFrameDecorColor(pixiColor(colors.primary), 0.55);
          let frameDecorUsed = 0;
          frameDecorFrames.forEach((frame) => {
            const span = Math.max(1e-3, frame.endTime - frame.startTime);
            const raw = (frameDecorTime - frame.startTime) / span;
            const eased = raw <= 0 ? 0 : 1 - Math.pow(2, -10 * clamp01(raw));
            const node = frameDecorNode(frameDecorUsed);
            frameDecorUsed += 1;
            node.clear();
            node.visible = eased > 0;
            if (eased <= 0) return;
            node.position.set(frame.anchorX, frame.anchorY);
            node.rotation = frame.rotation;
            resolveSonnetFrameDecorDraws({
              fontSize: frame.fontSize,
              width: frame.width,
              height: frame.height,
              rotation: frame.rotation,
              variant: frame.variant,
              eased,
            }).forEach((draw) => {
              const color = draw.colorKey === 'white' ? 0xffffff : frameDecorColor;
              if (draw.kind === 'line') {
                node
                  .moveTo(draw.x1, draw.y1)
                  .lineTo(draw.x2, draw.y2)
                  .stroke({ color, width: draw.width, alpha: draw.alpha });
                return;
              }
              if (draw.kind === 'circle') {
                node.circle(draw.x, draw.y, draw.radius).fill({ color, alpha: draw.alpha });
                return;
              }
              node.poly([...draw.points]).fill({ color, alpha: draw.alpha });
            });
          });
          for (let index = frameDecorUsed; index < frameDecorPool.length; index += 1) {
            frameDecorPool[index]?.clear();
          }
          /*
           * **五线谱画出来**（第 460 轮）：数据 / 几何 / 图元全来自纯函数 ✓，
           * 画序照构件给出的顺序：**静态谱面 → 播放头 → 动态音符** ✓。
           *
           * 两个入参是**我们的取舍**（已登记为差异）：
           * · `baseFontSize`：上游由排版层给 ✗，本组件没有基准字号 ⇒ 用 `max(48, 画面高 × 0.07)` ✓
           *   —— ⚠ 第 463 轮的**数探针**证明：原来取 `高 × 0.04`（≈28）**太小** ✗，
           *   谱面只有 ~28 px 高、线宽 1~2 px，压在拼贴上根本认不出来 ✓
           *   （与第 320 轮那条教训同源：**基准字号是"排版基准"，不是"占视口的比例"** ✓）。
           *   **用户本轮（对照 folia 录屏）把它从 `高 × 0.12`（1080p ≈ 129）收到 `高 × 0.07`（≈75）**：
           *   两段录屏同一首歌，folia 的谱面是**小而锐的细线**，我们是一整片又大又淡的网格（60% 屏宽、
           *   线距 32px）。收窄后仍远高于第 463 轮证明的「太小」下限（28），所以那条约束没被推翻。
           * · `shotStartTime`：这里仍传 `0` —— 等价于"按全局时间每 8 秒一轮"
           *   （`positiveModulo(time, 8)`），只与上游按本镜开始锚定的**相位**不同；
           *   相位切换不在本轮范围内（帧层已提供 `current.shotStartTime`，将来要改只动这一个入参）。
           */
          const staffTime = clock.current() / 1000;
          const staffDraws = resolveSonnetStaffDraws({
            geometry: resolveSonnetStaffGeometry({
              baseFontSize: Math.max(48, app.screen.height * 0.07),
              width: app.screen.width,
            }),
            time: staffTime,
            shotStartTime: 0,
            notes: staffNotes,
          });
          /*
           * **五线谱数探针**（第 463 轮）：先证明"图元到底画没画" ✓ ——
           * 第 461/462 轮只靠肉眼判断"看不见"，**分不清"根本没画"与"画了被淹"** ✗ ⇒ 这里把条数与首音符坐标报出来 ✓。
           * 只在条数签名变化时打印 ✓（免得每帧刷屏 ✓）。
           */
          const staffSignature = `${staffDraws.static.length}+1+${staffDraws.dynamic.length}`;
          host.dataset.sonnetStaffDraws = staffSignature;
          if ((host.dataset.sonnetStaffDrawsLast ?? '') !== staffSignature) {
            host.dataset.sonnetStaffDrawsLast = staffSignature;
            const firstNote = staffDraws.dynamic.find((draw) => draw.kind === 'ellipse');
            console.info(
              `[pi/sonnet] 五线谱=${staffSignature}` +
                `｜播放头x=${staffDraws.cursor.kind === 'line' ? staffDraws.cursor.x1.toFixed(1) : '无'}` +
                `｜首音符=${
                  firstNote !== undefined && firstNote.kind === 'ellipse'
                    ? `${firstNote.x.toFixed(1)},${firstNote.y.toFixed(1)}`
                    : '无'
                }`,
            );
          }
          /*
           * **每个词背后的局部固定几何**（资格、seed 与时序见 `sonnetTextGeoFrames.ts`）。
           *
           * 数据全部来自帧层 `current.textGeo`（逐 run 一条）；运动**复用字身那一套**
           * `resolveSonnetGlyphMotion`（同一个纯函数、同一组输入 ⇒ 与首字同节奏）。
           * 节点挂在 `textGeoLayer`（不参与全场旋转）；深度视差**逐节点**按 `frame.zDepth` 给，
           * 不再对整层套一个统一深度。
           */
          const staffGraphics = staffNode(0);
          staffGraphics.clear();
          const textGeoFrames = current.textGeo ?? [];
          const textGeoPrimary = pixiColor(colors.primary);
          const textGeoSecondary = secondaryTone;
          /** 这一帧每条词级几何算出来的运动（给下面的探针复用，避免算两遍 ✓）。 */
          const textGeoMotions: (ReturnType<typeof resolveSonnetGlyphMotion> | null)[] = [];
          textGeoFrames.forEach((frame, index) => {
            const node = textGeoNode(index);
            node.clear();
            if (frame.motion === undefined) {
              textGeoMotions.push(null);
              return;
            }
            const motion = resolveSonnetGlyphMotion({
              startTime: frame.motion.startTime,
              settleTime: frame.motion.settleTime,
              time: clock.current() / 1000,
              finalRotation: frame.motion.finalRotation,
              entryRotation: frame.motion.entryRotation,
              enterX: frame.motion.enterX,
              enterY: frame.motion.enterY,
              emphasis: frame.motion.emphasis,
              shotKind: current.shotKind,
              role: 'support',
              fontPx: frame.fontPx,
              /* 背景几何不做回声（角色恒 support ⇒ `echoActive` 恒假），法向固定给一个即可。 */
              normal: { x: 0, y: 1 },
              shotDuration: current.sceneDuration,
              echoSide: 1,
              motion: state.animationScale,
            });
            textGeoMotions.push(motion);
            const plan = resolveSonnetTextFixedGeoPlan(frame.seed, frame.isChorusEffect);
            const geometry = resolveSonnetTextFixedGeoGeometry({
              seed: frame.seed,
              isChorusEffect: frame.isChorusEffect,
              fontSize: frame.fontPx,
              layoutWidth: app.screen.width,
            });
            /*
             * **逐节点的深度视差**（照抄上游 `sonnetShotFrame.ts` 背景 shape 那条）：
             * `depthScale = 1 + zDepth × 0.45`、
             * `parallaxX/Y = current.camera.x/y × 画面宽/高 × zDepth × 2.5`。
             * `zDepth` 是负的背景深度 ⇒ 几何比词略小、并朝相机运动的反方向让开一点；
             * 不再对 `textGeoLayer` 整层套统一深度（那样每个词都偏移同一个量）。
             */
            const depthScale = 1 + frame.zDepth * 0.45;
            const parallaxX = current.camera.x * app.screen.width * frame.zDepth * 2.5;
            const parallaxY = current.camera.y * app.screen.height * frame.zDepth * 2.5;
            /*
             * 位置/旋转/缩放落在节点上；**几何内部**那点旋转（`rotated-frame` 的 π/4）
             * 保持不改 —— 上游是"容器转 placement.rotation + 几何自己转 π/4"两层叠加。
             */
            node.position.set(
              frame.x + motion.offsetX + parallaxX,
              frame.y + motion.offsetY + parallaxY,
            );
            node.rotation = motion.rotation + resolveSonnetTextFixedGeoRotation(plan);
            node.scale.set(motion.scale * depthScale);
            /* 入场 α 与字身同一支包络（未轮到的字 α = 0 ⇒ 背后几何也不该先冒出来）。 */
            node.alpha = motion.alpha;
            resolveSonnetTextFixedGeoDraws(plan, geometry).forEach((draw) => {
              const color = draw.colorKey === 'secondary' ? textGeoSecondary : textGeoPrimary;
              if (draw.kind === 'rect') {
                node.rect(draw.x, draw.y, draw.width, draw.height).stroke({
                  color,
                  width: draw.strokeWidth,
                  alpha: draw.alpha,
                });
                return;
              }
              if (draw.kind === 'circle') {
                if (draw.strokeWidth === 0) {
                  node.circle(draw.x, draw.y, draw.radius).fill({ color, alpha: draw.alpha });
                  return;
                }
                node.circle(draw.x, draw.y, draw.radius).stroke({
                  color,
                  width: draw.strokeWidth,
                  alpha: draw.alpha,
                });
                return;
              }
              if (draw.kind === 'arc') {
                node
                  .arc(draw.x, draw.y, draw.radius, draw.startAngle, draw.endAngle, draw.anticlockwise)
                  .stroke({ color, width: draw.strokeWidth, alpha: draw.alpha });
                return;
              }
              if (draw.kind === 'polyline') {
                node.moveTo(draw.points[0] ?? 0, draw.points[1] ?? 0);
                for (let pointIndex = 2; pointIndex + 1 < draw.points.length; pointIndex += 2) {
                  node.lineTo(draw.points[pointIndex] ?? 0, draw.points[pointIndex + 1] ?? 0);
                }
                node.stroke({ color, width: draw.strokeWidth, alpha: draw.alpha });
                return;
              }
              node
                .moveTo(draw.fromX, draw.fromY)
                .quadraticCurveTo(draw.controlX, draw.controlY, draw.toX, draw.toY)
                .stroke({ color, width: draw.strokeWidth, alpha: draw.alpha });
            });
          });
          for (let index = textGeoFrames.length; index < textGeoPool.length; index += 1) {
            textGeoPool[index]?.clear();
          }
          /*
           * **词级几何探针**：条数 + 每条的档位 + 入场 α ——
           * "词级几何画没画、有没有随词入场"靠它当数验（`dataset` + 变化时打一行）。
           */
          const textGeoSignature =
            `${textGeoFrames.length}:` +
            textGeoFrames
              .map((frame, index) => {
                const motion = textGeoMotions[index];
                if (frame.motion === undefined || motion === null || motion === undefined) return '-';
                const plan = resolveSonnetTextFixedGeoPlan(frame.seed, frame.isChorusEffect);
                return `${frame.index}:${plan.category}/${plan.variant}@${motion.alpha.toFixed(2)}`;
              })
              .join(',');
          host.dataset.sonnetTextGeo = textGeoSignature;
          if ((host.dataset.sonnetTextGeoLast ?? '') !== textGeoSignature) {
            host.dataset.sonnetTextGeoLast = textGeoSignature;
            console.info(`[pi/sonnet] 词级背后几何=${textGeoSignature}`);
          }
          /*
           * **背景 MG HUD 画出来**：八种"家具"共用同一副框内坐标（`margin = 5%`）。
           * seed 取 **`shotId` 的字符串哈希**（自己的 `× 31` 累加）⇒ 同一镜内固定
           * （上游按镜随机 —— 差异照实记）。这里必须用**按镜**的独立 seed：
           * 词级几何那支是"逐词变"的，复用会让背景 MG 每换一个词就换一副家具（抖）。
           */
          let bgMgSeed = 0;
          for (const character of current.shotId) {
            bgMgSeed = (bgMgSeed * 31 + character.charCodeAt(0)) | 0;
          }
          const bgMgSeedValue = Math.abs(bgMgSeed);
          const bgMgVariant = resolveSonnetBackgroundMgVariant(bgMgSeedValue);
          const bgMgDraws = resolveSonnetBackgroundMgDraws({
            variant: bgMgVariant,
            width: app.screen.width,
            height: app.screen.height,
            seed: bgMgSeedValue,
          });
          const bgMgName = SONNET_BACKGROUND_MG_VARIANTS[bgMgVariant] ?? 'unknown';
          const bgMgSignature = `${bgMgVariant}:${bgMgName}:${bgMgDraws.length}`;
          host.dataset.sonnetBgMg = bgMgSignature;
          if ((host.dataset.sonnetBgMgLast ?? '') !== bgMgSignature) {
            host.dataset.sonnetBgMgLast = bgMgSignature;
            console.info(
              `[pi/sonnet] 背景MG=${bgMgSignature}｜画面=${app.screen.width}×${app.screen.height}`,
            );
          }
          const bgMgGraphics = bgMgNode(0);
          bgMgGraphics.clear();
          /*
           * **背景 MG 走"错峰生长"**：引擎 `sonnetStagger.ts`（黄金比调度 + 按长度截断）
           * ＋ 适配层 `sonnetStaggerDraws.ts`（图元 → 本帧画法）。
           * · **进度**：用统一的生长进度 `current.rawProgress` —— 数值与 `current.progress` 同源
           *   （见 `SonnetFrame.rawProgress` 的注释），单独读它只是让"背景 MG / 背景形状 / 固定几何"
           *   三处显式共用同一条口径。上游口径是 `drawDuration = max(1.0, targetFinishTime − startTime)`、
           *   `targetFinishTime = min(endTime, max(最后一个词的起点, startTime + 镜长 × 0.95))`
           *   ⇒ 覆盖整段唱词，只有很短的小镜才被 1 秒下限抬起。
           * · **静帧看不出生长** ⇒ 这条以探针 + 用例为准；
           * · 画法四型：`stroke` ⇒ 按 `parts` 逐段画、`rect-wipe` ⇒ 擦除矩形、
           *   `fill` ⇒ 填充、`hidden` ⇒ 跳过。
           */
          const bgMgProgress = Math.min(1, Math.max(0, current.rawProgress));
          /*
           * ⚠ 第 490 轮踩的类型坑：背景 MG 的**线**用的是 `width` ✗（上游字段名 ✓），
           * 而生长适配层统一用 `strokeWidth` ✓ ⇒ 不能直接传（`TS2345` ✓）⇒ 这里**显式映射**一遍 ✓
           * （不用对象展开 ✗ —— 展开会把多余的 `width` 留在字面量里 ✓ 更绕 ✓）。
           */
          const toStaggerable = (draw: SonnetBackgroundMgDraw) => {
            if (draw.kind === 'line') {
              return {
                kind: 'line' as const,
                x1: draw.x1,
                y1: draw.y1,
                x2: draw.x2,
                y2: draw.y2,
                strokeWidth: draw.width,
                alpha: draw.alpha,
                colorKey: draw.colorKey,
              };
            }
            if (draw.kind === 'circle') {
              return {
                kind: 'circle' as const,
                x: draw.x,
                y: draw.y,
                radius: draw.radius,
                strokeWidth: draw.strokeWidth,
                alpha: draw.alpha,
                colorKey: draw.colorKey,
              };
            }
            if (draw.kind === 'arc') {
              return {
                kind: 'arc' as const,
                x: draw.x,
                y: draw.y,
                radius: draw.radius,
                startAngle: draw.startAngle,
                endAngle: draw.endAngle,
                strokeWidth: draw.strokeWidth,
                alpha: draw.alpha,
                colorKey: draw.colorKey,
              };
            }
            if (draw.kind === 'polygon') {
              return {
                kind: 'polygon' as const,
                points: draw.points,
                closed: draw.closed,
                strokeWidth: draw.strokeWidth,
                alpha: draw.alpha,
                colorKey: draw.colorKey,
              };
            }
            return {
              kind: 'rect' as const,
              x: draw.x,
              y: draw.y,
              width: draw.width,
              height: draw.height,
              strokeWidth: draw.strokeWidth,
              alpha: draw.alpha,
              colorKey: draw.colorKey,
            };
          };
          const bgMgStaggered = resolveSonnetStaggeredDraws(bgMgDraws.map(toStaggerable), bgMgProgress);
          let bgMgVisible = 0;
          bgMgStaggered.forEach((item) => {
            if (item.kind === 'hidden') return;
            bgMgVisible += 1;
            const color = item.colorKey === 'secondary' ? textGeoSecondary : textGeoPrimary;
            if (item.kind === 'rect-wipe') {
              bgMgGraphics
                .rect(item.x, item.y, item.width, item.height)
                .stroke({ color, width: item.strokeWidth, alpha: item.alpha });
              return;
            }
            if (item.kind === 'fill') {
              if (item.draw.kind === 'circle') {
                bgMgGraphics
                  .circle(item.draw.x, item.draw.y, item.draw.radius)
                  .fill({ color, alpha: item.alpha });
                return;
              }
              if (item.draw.kind === 'rect') {
                bgMgGraphics
                  .rect(item.draw.x, item.draw.y, item.draw.width, item.draw.height)
                  .fill({ color, alpha: item.alpha });
              }
              return;
            }
            item.parts.forEach((part) => {
              if (part.kind === 'line') {
                bgMgGraphics
                  .moveTo(part.x1, part.y1)
                  .lineTo(part.x2, part.y2)
                  .stroke({ color, width: item.strokeWidth, alpha: item.alpha });
                return;
              }
              if (part.kind === 'quadratic') {
                bgMgGraphics
                  .moveTo(part.fromX, part.fromY)
                  .quadraticCurveTo(part.controlX, part.controlY, part.toX, part.toY)
                  .stroke({ color, width: item.strokeWidth, alpha: item.alpha });
                return;
              }
              if (part.kind === 'bezier') {
                bgMgGraphics
                  .moveTo(part.fromX, part.fromY)
                  .bezierCurveTo(
                    part.control1X,
                    part.control1Y,
                    part.control2X,
                    part.control2Y,
                    part.toX,
                    part.toY,
                  )
                  .stroke({ color, width: item.strokeWidth, alpha: item.alpha });
                return;
              }
              bgMgGraphics
                .arc(part.x, part.y, part.radius, part.startAngle, part.endAngle)
                .stroke({ color, width: item.strokeWidth, alpha: item.alpha });
            });
          });
          host.dataset.sonnetBgMgProg = `${bgMgProgress.toFixed(2)}:${bgMgVisible}/${bgMgStaggered.length}`;
          /*
           * **生长进度也打进控制台**（第 492 轮）：`dataset` 只在 DOM 上 ✗（冒烟日志里看不到 ✓ ⇒ 上一轮我拿不到数字 ✓）。
           * 只在"可见条数"变化时打印 ✓ ⇒ 同一镜里会得到一串**递增**的读数 ✓
           * ⇒ 这是"**动画确实在动**"的**直接证据** ✓（比只看静帧强 ✓）。
           */
          const bgMgGrowSignature = `${bgMgVisible}/${bgMgStaggered.length}`;
          if ((host.dataset.sonnetBgMgProgLast ?? '') !== bgMgGrowSignature) {
            host.dataset.sonnetBgMgProgLast = bgMgGrowSignature;
            console.info(
              `[pi/sonnet] 背景MG生长=${bgMgProgress.toFixed(2)}｜可见=${bgMgGrowSignature}`,
            );
          }
          /*
           * **把谱面锚到一段歌词上**（第 466 轮，消灭 `CREDITS.md` 里那条"位置锚定"差异 ③）：
           * 上游按 **placement** 摆放 ✓；我方帧层没有把 placement 直接给渲染层 ✗，
           * 但**边框**（`frameDecor`）与**引导线**（`guides`）都各自带着 `anchorX / anchorY` ✓
           * ⇒ 取这一帧**第一个边框**的锚点（顺带沿用它的 `rotation` ✓）；
           * 没有边框就退而取**第一条引导线**；两者都没有才回到层原点 ✓（这条兜底也写清 ✓）。
           */
          /*
           * **矩形尺寸探针**（主人 2026-10-09："动画内容自己的一个矩形边框/纸面"）。
           *
           * 渲染层有三处会画矩形：文本固定几何、背景 MG、帧装饰（开放边框）。
           * 这里把它们的**局部包围盒**和画布尺寸并排打出来 —— 谁是屏幕上那圈矩形，看数字即可判定；
           * 如果某个恰好是 **1134×572**（旧舞台盒子的尺寸），那就是"有东西还按旧尺寸在画"的铁证。
           */
          const rectSizeOf = (node: Container): string => {
            const box = node.getLocalBounds();
            return `${Math.round(box.width)}x${Math.round(box.height)}`;
          };
          const rectProbe =
            `textgeo=${textGeoPool[0] === undefined ? '无' : rectSizeOf(textGeoPool[0])} ` +
            `textgeo层=${rectSizeOf(textGeoLayer)} ` +
            `bgmg=${rectSizeOf(bgMgGraphics)} ` +
            `decor=${rectSizeOf(decorLayer)} ` +
            `frame=${frameDecorPool[0] === undefined ? '无' : rectSizeOf(frameDecorPool[0])}`;
          if (host.dataset.sonnetRects !== rectProbe) {
            host.dataset.sonnetRects = rectProbe;
            console.info(
              `[pi/sonnet] rects ${rectProbe} canvas=${host.clientWidth}x${host.clientHeight}` +
                ` kind=${current.shotKind}`,
            );
          }
          const staffAnchor = current.frameDecor?.[0];
          const staffGuide = current.guides[0];
          const staffX = staffAnchor?.anchorX ?? staffGuide?.anchorX ?? 0;
          const staffY = staffAnchor?.anchorY ?? staffGuide?.anchorY ?? 0;
          staffGraphics.position.set(staffX, staffY);
          staffGraphics.rotation = staffAnchor?.rotation ?? 0;
          [...staffDraws.static, staffDraws.cursor, ...staffDraws.dynamic].forEach((draw) => {
            const color =
              draw.colorKey === 'accent' ? pixiColor(colors.accent) : pixiColor(colors.primary);
            if (draw.kind === 'line') {
              staffGraphics
                .moveTo(draw.x1, draw.y1)
                .lineTo(draw.x2, draw.y2)
                .stroke({ color, width: draw.width, alpha: draw.alpha });
              return;
            }
            if (draw.kind === 'ellipse') {
              staffGraphics
                .ellipse(draw.x, draw.y, draw.radiusX, draw.radiusY)
                .fill({ color, alpha: draw.alpha });
              return;
            }
            staffGraphics
              .moveTo(draw.fromX, draw.fromY)
              .quadraticCurveTo(draw.controlX, draw.controlY, draw.toX, draw.toY)
              .stroke({ color, width: draw.width, alpha: draw.alpha });
          });
          /*
           * **"已经亮起来的字"有几个**（入场走完、常态不透明度 0.5 的算亮）。
           *
           * 光看 `data-sonnet-glyphs` 不够用：镜头刚开拍时字**在**、但还在入场（实测 α 只有 0.01~0.06），
           * 截图上等于什么都没有。冒烟要等到这一帧真有"看得见的字"再拍照，就得有这个读数。
           */
          host.dataset.sonnetLit = String(current.glyphs.filter((glyph) => glyph.alpha >= 0.4).length);
          host.dataset.sonnetVariant = String(current.geometryVariant);
          /*
           * 重镜头那一批大图形用的是**哪一档原版几何**、以及这一档搬过来了没有。
           * 非重镜头（社论栏 / 丝带 / 遮罩 / 海报 / 静场）**根本不画几何**，所以标"不适用" ——
           * 否则取景会挑到它们，拍出来只有背景的五个小方块（这一条实地踩过）。
           */
          host.dataset.sonnetGeo = isSonnetHeavyShotKind(current.shotKind)
            ? `${current.geoVariant}${current.geoPorted ? '✓' : '兜底'}`
            : '不适用';
          /*
           * **节目表**（只写一次）：`构图@起,止@几何档位(✓=已搬) | …`，单位秒。
           * 冒烟靠它"按构图 seek"到某一镜再截图 —— 否则截图闸门只会等在最先亮起来的那一镜上，
           * 重镜头的原版几何永远拿不到屏幕级证据（实测连着三轮都停在社论栏）。
           * 档位与"搬没搬"由帧层的 `describeSonnetShotSchedule` 算，与真正画出来的那一套同源。
           */
          if (!scheduleWritten) {
            scheduleWritten = true;
            /*
             * 覆盖率读数（只写一次）：**按档位**报"已搬多少 / 还差哪些家族"。
             * 原版 0~99 每一档都会画东西，所以这个数是"复刻进度"，不是"我们多画了"。
             */
            host.dataset.sonnetGeoCoverage = describeSonnetGeoCoverage().summary;
            host.dataset.sonnetShots = describeSonnetShotSchedule(state.program)
              .map(
                (entry) =>
                  `${entry.kind}@${entry.startTime.toFixed(2)},${entry.endTime.toFixed(2)}` +
                  // 不画几何的镜头第三条写 `-`，取景就不会挑到它们。
                  `@${entry.geoApplies ? `${entry.geoVariant}${entry.geoPorted ? '✓' : '兜底'}` : '-'}`,
              )
              .join('|');
          }
          host.dataset.sonnetProgress = current.progress.toFixed(3);
          host.dataset.sonnetTransition =
            current.transition.blurPx > 0
              ? `blur:${current.transition.blurPx.toFixed(1)}`
              : current.transition.glitch > 0
                ? `glitch:${current.transition.glitch.toFixed(2)}`
                : current.transition.alpha < 1
                  ? `alpha:${current.transition.alpha.toFixed(2)}`
                  : '';

          // 相机：**绕本镜轴心**缩放与旋转（轴心＝焦点，上游如此），平移按画面的比例走。
          const camera = current.camera;
          /*
           * **阅读窗口 + 连续预测焦点**（见 `sonnetReadingWindow.ts` / `sonnetCameraFocus.ts`）：
           * · **缩放**看 `current.readingWindow`（当前词组 + 前后近邻，**连续**、绝对时间决定），
           *   尺寸不再拿 `current.glyphs` 的全部落位边界做硬约束 —— 长镜头的字不再被缩成小字；
           *   窗口装不下时允许**窗外块越过画面边缘**（缩放下限 0.78 兜住字号）；
           * · **平移**只做温和兜底，依据是 `current.cameraFocus` 的**固定舒适区**（预测焦点周围的
           *   0.30W / 0.28H，按世界缩放折算）：修正上限 0.10 视口、边距宽容（3% / 4%）。
           *   **不再盯"此刻正在唱的那几个字"** —— 那正是"一换语义块镜头就急追"的机制；
           *   也不再按"页"固定停留 —— 焦点是语义词组中心的连续高斯融合（自带少量 lookahead）。
           * · **长横排**另有一层屏幕锚定：`sonnetFrame` 已经按
           *   `basePosition + 世界缩放 × (前沿 − 轴心)` 反解好 `pivot.x`（`cameraFocus.screenAnchored`），
           *   本层只按下面这条**同一条投影式子**施加它（`world.pivot` + `world.position` 成对改），
           *   所以"展开中前沿 ≥ 45% 视口宽、句末尾端 ≈ 67%"是由**像素**保证的，不是靠焦点估计。
           * ghost（`role === 'decoration'`）在帧层就没进窗口 / 焦点 ⇒ 不纳入 guard ✓。
           */
          const basePositionX = current.pivot.x + current.anchorDelta.x;
          const basePositionY = current.pivot.y + current.anchorDelta.y;
          const windowFrame = current.readingWindow;
          const focusFrame = current.cameraFocus;
          const framed: SonnetReadingFramingResult = frameSonnetCameraToReadingWindow(camera, {
            /*
             * 视口口径与**帧层排版**同源：帧层的字形落点是按 `app.screen` 布局的
             * （见本文件里 `viewport: { width: app.screen.width … }` 的注释），
             * 取景不能改用宿主 CSS 盒 —— DPR 或边框一变，两者就不是同一个坐标系了。
             */
            viewportWidth: app.screen.width,
            viewportHeight: app.screen.height,
            pivotX: current.pivot.x,
            pivotY: current.pivot.y,
            /* 取景锚点 = `world.position`（不含运镜帧）：投影与下面真正施加的平移必须同源 ✓。 */
            basePositionX,
            basePositionY,
            windowBounds: {
              minX: windowFrame.minX,
              minY: windowFrame.minY,
              maxX: windowFrame.maxX,
              maxY: windowFrame.maxY,
            },
            /* 当前词组（活动块）自己的落位范围：取景只拿它做**读数**（可读性验收）。 */
            focusBounds: {
              minX: windowFrame.activeMinX,
              minY: windowFrame.activeMinY,
              maxX: windowFrame.activeMaxX,
              maxY: windowFrame.activeMaxY,
            },
            /*
             * **平移兜底 = 预测焦点的舒适区**：焦点本身已经把镜头带到该看的地方，这里只处理
             * "世界缩放混合 / 运镜漂移把焦点推到边上"的残余。空焦点（静默 / 没有词组）不传 ⇒
             * 取景层不做平移（**不要**退回"盯阅读窗口"的旧口径去追当前词）。
             */
            planBounds:
              focusFrame.blockCount === 0
                ? undefined
                : {
                    minX: focusFrame.minX,
                    minY: focusFrame.minY,
                    maxX: focusFrame.maxX,
                    maxY: focusFrame.maxY,
                  },
          });
          const framedCamera = framed.camera;
          /*
           * **轴心取预测焦点**（见 `sonnetCameraFocus.ts`）：`world` 的局部坐标就是画布坐标
           * （字形落点写的是 `宽/2 + …`），所以直接把焦点当 `pivot` 即可；
           * `position` 设成"**轴心 + 取景增量**"，等于把焦点摆到取景锚点上，之后再叠运镜帧的平移。
           *
           * ⚠ 这两行必须**成对**改：只把 `pivot` 换掉而不动 `position`，画面会整体甩走。
           * 为什么值得改：此前轴心钉在画面中心、位移另加，于是当 `zoom ≠ 1` 时被强调的那个字
           * **并不会真的落在取景锚点上**，而是偏出 `(zoom − 1) × 该字到中心的距离`
           * （按 zoom 1.19、距中心 300px 估算最多差约 50px），每镜偏差方向还不一样。
           */
          /*
           * **先存下"上一帧的 world"**，再改写相机 —— 出场歌词的快照是**上一帧**画的，
           * 它当时用的就是这份变换。换镜后出场层靠它把屏幕位置钉住（见 `lyricOutStage`）。
           * `updateLocalTransform()` 显式刷新一下：属性是上一帧设的，但懒更新的矩阵取决于
           * 渲染时序，这里不赌顺序。
           */
          world.updateLocalTransform();
          previousWorldTransform.copyFrom(world.localTransform);
          world.pivot.set(current.pivot.x, current.pivot.y);
          world.position.set(basePositionX, basePositionY);
          world.scale.set(framedCamera.zoom);
          world.rotation = framedCamera.rotation;
          /*
           * 平移量按**取景用的同一个视口**施加（`app.screen`，不是宿主 CSS 盒）：
           * `camera.x/y` 是比例数，投影与落到实处必须是同一条式子，否则取景会差一截 ✓。
           */
          world.position.x += framedCamera.x * app.screen.width;
          world.position.y += framedCamera.y * app.screen.height;
          /*
           * 每镜的**取景锚点**（见 `sonnetFrame.buildSonnetFrame` 的 `anchorDelta` 注释）：
           * 上游把整镜内容摆到 `(0.5 + camera.x, 0.48 + camera.y ± 0.025)` 上、海报那族不参与。
           * 上面已经把它并进 `position`，所以字形与形状一定同步平移，这里不再另加。
           */
          /*
           * **取景读数**（`[pi/sonnet] frame`）：约束后**阅读窗口**在屏幕上的范围与四周余量。
           * 与旧 `bscreen` 探针同源但不同口径 —— 那个是**约束前**的出血量（只统计），
           * 这个是**约束后**的实际落位（`body=minx,miny,maxx,maxy` + `pad=左,上,右,下` 四边余量）。
           *
           * 另外写两条**验收用 dataset**（主人点名要的调试量，Codex 直接读 DOM 即可）：
           * · `data-sonnet-window`：窗口的**字数 / 词数 / 块数 / 真实时间范围 / 四至 / 当前块下标**；
           * · `data-sonnet-rhythm`：**唱词时间轴节奏**（密度 / 快慢 / 长音 / 空档 / 跟拍因子 / 平滑窗 / 呼吸倍率）。
           * 两者都来自帧层同一份纯函数读数，不是渲染层自造。
           */
          const windowProbe = describeSonnetReadingWindow(windowFrame);
          const rhythmProbe = describeSonnetRhythmProfile(current.rhythm);
          host.dataset.sonnetWindow = windowProbe;
          host.dataset.sonnetRhythm = rhythmProbe;
          /*
           * **当前词组的屏幕落位**（`data-sonnet-focus`）：取景后活动块在屏幕上的四至 ——
           * Codex 的视觉 QA 靠它判"当前词有没有被裁到只剩一两字"（与视口求交即可）。
           */
          const focusScreen = framed.focusScreen;
          host.dataset.sonnetFocus =
            focusScreen === null
              ? ''
              : `${Math.round(focusScreen.minX)},${Math.round(focusScreen.minY)},` +
                `${Math.round(focusScreen.maxX)},${Math.round(focusScreen.maxY)}`;
          /*
           * **预测焦点的读数**（`data-sonnet-plan`，字段名沿用外部探针口径）：这一帧看哪里、
           * 焦点周围舒适区多大、提前量 / 高斯宽度 / 局部唱速是多少 —— 视觉 QA 靠它判
           * "焦点在下一词组开口前是否已经靠过去"（DOM 读数即可）。
           */
          const focusProbe = current.cameraFocus.summary;
          host.dataset.sonnetPlan = focusProbe;
          const screenBox = framed.windowScreen;
          const planScreenBox = framed.planScreen;
          const frameProbe =
            `win[${windowProbe}] ${rhythmProbe} ` +
            `focus[${focusProbe}] ` +
            `n=${current.glyphs.length} ` +
            `body=${Math.round(screenBox.minX)},${Math.round(screenBox.minY)},` +
            `${Math.round(screenBox.maxX)},${Math.round(screenBox.maxY)} ` +
            (planScreenBox === null
              ? 'planbox=- '
              : `planbox=${Math.round(planScreenBox.minX)},${Math.round(planScreenBox.minY)},` +
                `${Math.round(planScreenBox.maxX)},${Math.round(planScreenBox.maxY)} `) +
            `pad=${Math.round(screenBox.minX)},${Math.round(screenBox.minY)},` +
            `${Math.round(app.screen.width - screenBox.maxX)},` +
            `${Math.round(app.screen.height - screenBox.maxY)} ` +
            `zoom=${framedCamera.zoom.toFixed(3)} ratio=${framed.zoomRatio.toFixed(3)} ` +
            `pan=${framed.panX.toFixed(3)},${framed.panY.toFixed(3)} ` +
            `rot=${((framedCamera.rotation * 180) / Math.PI).toFixed(1)}`;
          /*
           * ⚠ **读数每帧写、日志只在"焦点活动块 / 取景方式变了"时打**：
           * `frameProbe` 里含连续量（窗口四至、焦点坐标、pan），拿它当日志判据会每帧刷屏。
           */
          host.dataset.sonnetFrame = frameProbe;
          const frameLogKey =
            `${current.shotId}|${current.shotKind}|${current.cameraFocus.activeIndex}|` +
            `${current.cameraFocus.blockCount}|${windowFrame.activeIndex}|` +
            `${windowFrame.blockCount}|${framed.adjusted ? '调整' : '原样'}`;
          if (host.dataset.sonnetFrameKey !== frameLogKey) {
            host.dataset.sonnetFrameKey = frameLogKey;
            console.info(
              `[pi/sonnet] frame ${framed.adjusted ? '调整' : '原样'} shot=${current.shotId} ` +
                `kind=${current.shotKind} ${frameProbe}`,
            );
          }
          /*
           * **"收边补偿"那套（按正文包围盒缩 `world.scale`、再把出血的一侧推回来）已删除**：
           * 原版允许也常常故意让字出血，而这两步会在帧层"夹回画布"之外再盖一层、读数互相掩盖。
           * 现在 `world.scale` / `world.position` **只由相机决定** —— 上面那条取景约束也只改相机四值，
           * 不逐字推挤；下面这块只把**约束前**的出血量打进 `[pi/sonnet] bscreen` 读数（只统计、不改画面），
           * 和上面的 `[pi/sonnet] frame`（约束后）正好是"改前 / 改后"一对。
           * 量法是近似（忽略旋转，半宽 = `字号 × 0.275 × world 缩放`、半高 × 0.45），判出血够用。
           */
          const bodyForScreen = current.glyphs.filter((glyph) => !glyph.ghost);
          if (bodyForScreen.length > 0) {
            const scaleX = Math.abs(world.scale.x);
            const scaleY = Math.abs(world.scale.y);
            let minX = Number.POSITIVE_INFINITY;
            let maxX = Number.NEGATIVE_INFINITY;
            let minY = Number.POSITIVE_INFINITY;
            let maxY = Number.NEGATIVE_INFINITY;
            for (const glyph of bodyForScreen) {
              const spot = world.toGlobal({ x: glyph.x, y: glyph.y });
              const halfW = glyph.fontPx * 0.275 * scaleX;
              const halfH = glyph.fontPx * 0.45 * scaleY;
              minX = Math.min(minX, spot.x - halfW);
              maxX = Math.max(maxX, spot.x + halfW);
              minY = Math.min(minY, spot.y - halfH);
              maxY = Math.max(maxY, spot.y + halfH);
            }
            const bodyProbe =
              `${Math.round(minX)},${Math.round(minY)},` +
              `${Math.round(maxX)},${Math.round(maxY)}`;
            if (host.dataset.sonnetBodyScreen !== bodyProbe) {
              host.dataset.sonnetBodyScreen = bodyProbe;
              console.info(
                `[pi/sonnet] bscreen bleedTop=${Math.round(Math.max(0, -minY))} ` +
                  `bleedBottom=${Math.round(Math.max(0, maxY - host.clientHeight))} ` +
                  `bleedLeft=${Math.round(Math.max(0, -minX))} ` +
                  `bleedRight=${Math.round(Math.max(0, maxX - host.clientWidth))} ` +
                  `n=${bodyForScreen.length} zoom=${current.camera.zoom.toFixed(3)} ` +
                  `kind=${current.shotKind}`,
              );
            }
          }
          /*
           * **分层相机补偿**（见 `sonnetLayerCamera.ts` 文件头，照抄上游 `sonnetShotFrame.ts:145~181`）。
           *
           * 我们原先在这里给背景 MG / 构图 / 五线谱 / 外层元数据各按"深度"做**反向**平移与
           * **逆向**缩放 ⇒ 歌词（同一棵 `world`）不动、背景往后滑，相对位移与上游不同 ✗。
           * 上游事实是：正文、guide、frameDecor、主体 MG **全部**共享 `view.container` 的
           * `pivot / scale / rotation / position`，只有粒子层（`mgParticleLayer`）独立。
           * 所以这里**取消**那套泛用 2.5D：四层恒取 identity（逐点共享 `world`），
           * `textGeoLayer` / `frameDecorLayer` 本来就不参与；粒子层只留
           * `+0.4 × 相机平移`（**正号**、用 `app.screen` 与投影同源）与镜内自转。
           *
           * `zDepth` 那套**逐字 / 逐词**的模拟视差仍在各自节点上（那是上游 `glyph` 循环里的做法），
           * 与"整层反补偿"不是一回事。
           */
          const applyLayerCamera = (layer: SonnetCameraLayer, node: Container): void => {
            const transform = resolveSonnetLayerCameraTransform(layer, framedCamera, {
              width: app.screen.width,
              height: app.screen.height,
            });
            node.position.set(transform.x, transform.y);
            node.scale.set(transform.scale);
          };
          applyLayerCamera('outerMetadata', outerMetadataLayer);
          applyLayerCamera('bgMg', bgMgLayer);
          applyLayerCamera('shape', shapeLayer);
          applyLayerCamera('staff', staffLayer);
          applyLayerCamera('decor', decorLayer);
          /*
           * **背景粒子的缓慢自转**：相位以**本镜开始**为锚点，`(time − shotStartTime) × 0.05 rad`。
           * 用播放时钟的绝对量而不是逐帧累加 —— 掉帧、暂停、拖进度条都得到同一画面。
           * 只转粒子层：形状层牵着构图骨架、`bgMgLayer` 是画面级框线、
           * `textGeoLayer` / `frameDecorLayer` 是跟着词的局部装饰，转了都会错位。
           */
          decorLayer.rotation = resolveSonnetParticleSwimRotation(
            clock.current() / 1000,
            current.shotStartTime,
          );
          /*
           * **歌词换句的交叉淡变**（`sonnetLyricCrossfade.ts`）：签名 = 镜 id + 非装饰文本。
           * 签名一变就是"换句"：把当前（旧）字形整体快照到出场层，新句照常写进入场池，
           * 两层按 `outgoing/incoming` 两个 α 重叠淡变 —— 这就是"单 world 每帧换 glyphs"下
           * 新旧画面短暂共存的那一步。
           *
           * ⚠ 进度用**墙钟**（`performance.now()`）：暂停时唱词时钟不动，淡变照样能走完；
           *   而拖动进度 / 倒退 / resize / 换 program / reduced motion 由状态机判成 `seek`
           *   **直接切**（不补间、不产生拖影）。
           */
          // Two programs can share the compiler seed; object identity still invalidates old lyrics.
          if (lyricCrossfadeProgram !== state.program) {
            lyricCrossfadeProgram = state.program;
            lyricCrossfadeState = createSonnetLyricCrossfadeState();
            capturedOutgoingSignature = '';
          }
          const lyricCrossfadeFrame = advanceSonnetLyricCrossfade(lyricCrossfadeState, {
            signature: resolveSonnetLyricSignature(current.shotId, current.glyphs),
            timeSec: clock.current() / 1000,
            nowMs: performance.now(),
            viewportKey: `${Math.round(app.screen.width)}x${Math.round(app.screen.height)}`,
            /* program 身份（编译种子）与 reduced motion：两者都会让旧出场层立刻失效。 */
            programKey: state.program.seed,
            reducedMotion: state.reduced,
          });
          lyricCrossfadeState = lyricCrossfadeFrame.state;
          /*
           * **同一段淡变只快照一次**（判据是"出场签名第一次出现"）：
           * 入场池在换句这一帧就会被新句覆盖，若每帧按 α 重拷，第二帧起出场层就变成**新句的副本**
           * ——旧句只存在一帧，后面的"补偿"也钉在错的内容上。
           */
          const outgoingSignature = lyricCrossfadeFrame.state.outgoingSignature;
          if (outgoingSignature === '') {
            capturedOutgoingSignature = '';
          } else if (outgoingSignature !== capturedOutgoingSignature) {
            capturedOutgoingSignature = outgoingSignature;
            captureOutgoingLyrics();
          }
          /*
           * 读数写在 dataset 上（逐帧更新，视觉 QA 可直接读）；
           * `console.info` 只在**阶段变化**时打一行 —— 淡变里逐帧打会刷屏。
           */
          const crossfadeProbe = describeSonnetLyricCrossfade(lyricCrossfadeFrame);
          host.dataset.sonnetCrossfade = crossfadeProbe;
          if (crossfadePhaseLogged !== lyricCrossfadeFrame.phase) {
            crossfadePhaseLogged = lyricCrossfadeFrame.phase;
            console.info(`[pi/sonnet] 歌词交叉淡变 ${crossfadeProbe}`);
          }
          /*
           * 转场的 alpha 通道只压**非歌词层**（见 `transitionAlphaLayers` 的注释）：
           * 这几层的行为与改造前逐值相同，而歌词改由上面那条交叉淡变接管 ——
           * 换镜（`fast-blur` / `camera-pull` 的出场 α 会算到 0）时背景不会整屏被压黑，
           * 新旧两句按各自的 α 连续交接。
           * ⚠ 不要把它读成"始终有字"：两个 α 之和为 1 只是两层互补，新句的字可能还没轮到入场。
           */
          const sceneAlpha = current.transition.alpha;
          for (const entry of transitionAlphaLayers) {
            entry.node.alpha = entry.baseAlpha * sceneAlpha;
          }
          /*
           * **片尾**（照抄 folia `sonnet/sonnetCredits.ts`）：末句唱完 ⇒ **歌词淡出并糊掉**、
           * **海报从下方升起并放大到 1** ✓。
           * 输入：`clock.current() / 1000`（秒 ✓ —— 与 `:585/:643` 同类用法一致 ✓）＋ `finalLyricEndTime` ✓。
           * ⚠ 只动 **`glyphLayer`（歌词）** 与 **`creditsLayer`（海报）**；
           *   转场 α 已从整棵 `world` 移到非歌词层（`transitionAlphaLayers`），这里**不再有** `world.alpha` 可覆盖 ✓。
           * ⚠ 模糊**只在需要时挂** ✓（滤镜很贵 ⇒ 照 `:317~322` 那条纪律：复用实例、不每帧重建 ✓）。
           */
          const credits = resolveSonnetCreditsFrame(clock.current() / 1000, finalLyricEndTime);
          /*
           * ⚠ 诊断补丁已还原（第 537 轮 ✓）：上一轮临时钉成 `visible = true; alpha = 1` 拍过一张，
           * 但**肉眼认不出版式标记** ✗（画面花、且这一跑未必带 `songTitle` 等元数据 ⇒ 只剩四笔淡线 ✓）。
           * ⇒ 结论以**探针 + 用例**为准 ✓，并补"海报内容计数"探针（下一轮 ✓）。
           */
          creditsLayer.visible = !state.reduced && credits.posterAlpha > 0;
          /* 海报也归"非歌词层"：转场 α 照旧乘上去（与改造前 `worldAlpha × posterAlpha` 逐值相同）。 */
          creditsLayer.alpha = credits.posterAlpha * sceneAlpha;
          creditsLayer.scale.set(credits.posterScale);
          creditsLayer.y = credits.posterOffsetY * app.screen.height;
          /*
           * **歌词两层的 α 由交叉淡变接管**（不再乘场景转场 α）：入场层乘 `incomingAlpha`，
           * 出场层（旧句子）乘 `outgoingAlpha`；片尾的 `lyricAlpha` 仍只作用于**入场层**
           * （与改造前一致：它一直只管 `glyphLayer`）。
           */
          glyphLayer.alpha = credits.lyricAlpha * lyricCrossfadeFrame.incomingAlpha;
          haloLayer.alpha = SONNET_HALO_LAYER_ALPHA * lyricCrossfadeFrame.incomingAlpha;
          const outgoingVisible = lyricCrossfadeFrame.outgoingAlpha > 0.001;
          glyphOutLayer.visible = outgoingVisible;
          haloOutLayer.visible = outgoingVisible;
          if (outgoingVisible) {
            glyphOutLayer.alpha = lyricCrossfadeFrame.outgoingAlpha;
            haloOutLayer.alpha = SONNET_HALO_LAYER_ALPHA * lyricCrossfadeFrame.outgoingAlpha;
            /*
             * **出场层钉在换镜前的屏幕位置**：`world` 已经换成新相机，出场层本地取
             * `L = 当前 world⁻¹ · 快照时的 world`（见 `sonnetLayerCamera.ts` 的纯函数）
             * ⇒ `world · L · p` 逐字等于旧句当时的屏幕落点。这里每帧只重算这个补偿，
             * **不把新相机拷给出场层**；隐藏时（`outgoingVisible` 为假）一个像素都不画，
             * 也不需要为它另挂/另放滤镜（它留在 `world` 里 ⇒ 世界级滤镜链照旧只挂一份）。
             */
            world.updateLocalTransform();
            const compensation = resolveSonnetExitCameraCompensation(
              world.localTransform,
              outgoingWorldTransform,
            );
            exitCompensation.set(
              compensation.a,
              compensation.b,
              compensation.c,
              compensation.d,
              compensation.tx,
              compensation.ty,
            );
            lyricOutStage.setFromMatrix(exitCompensation);
          }
          const creditsBlurStrength = state.reduced ? 0 : credits.lyricBlur;
          if (creditsBlurStrength > 0) {
            if (creditsBlurFilter === null) creditsBlurFilter = new BlurFilter({ strength: 0, quality: 3 });
            creditsBlurFilter.strength = creditsBlurStrength;
            glyphLayer.filters = [creditsBlurFilter];
          } else if (glyphLayer.filters !== null) {
            glyphLayer.filters = [];
          }
          const creditsSignature = `${credits.active ? 1 : 0}:${credits.lyricAlpha.toFixed(2)}:${credits.posterAlpha.toFixed(2)}`;
          if (host.dataset.sonnetCredits !== creditsSignature) {
            host.dataset.sonnetCredits = creditsSignature;
            console.info(`[pi/sonnet] 片尾=${creditsSignature}`);
          }
          /*
           * **器乐虚拟行探针**（第 563 轮）：`0` = 这首歌有词、走原样行 ✓；
           * `> 0` = 启用了虚拟行，值就是条数（照上游是 60 ✓）。
           * ⚠ 放在这里而不是 render 作用域：**这里才有 `host`** ✓（第 225 轮记的坑 ✓）。
           */
          const virtualSignature = String(sonnetVirtualStaffCount);
          if (host.dataset.sonnetVirtualStaff !== virtualSignature) {
            host.dataset.sonnetVirtualStaff = virtualSignature;
            console.info(`[pi/sonnet] 器乐虚拟行=${virtualSignature}`);
          }
          // 视口尺寸跟着 `resizeTo: host` 走；矩形对象常驻，只改宽高（避免每帧新建）。
          if (
            sceneFilterArea.width !== app.screen.width ||
            sceneFilterArea.height !== app.screen.height
          ) {
            sceneFilterArea.width = app.screen.width;
            sceneFilterArea.height = app.screen.height;
          }
          const wantBlur = current.transition.blurPx > 0;
          const wantGlitch = current.transition.glitch > 0;
          if (wantBlur !== blurAttached || wantGlitch !== glitchAttached) {
            blurAttached = wantBlur;
            glitchAttached = wantGlitch;
            // 暗角**常驻**、排在最前：先按视口把四周压黑，再叠转场那两层。
            const chain = [vignette.filter, lens.filter];
            if (wantBlur) chain.push(transitionBlur);
            if (wantGlitch) chain.push(glitch.filter);
            world.filters = chain;
          }
          if (wantBlur) transitionBlur.strength = current.transition.blurPx;
          if (wantGlitch) {
            // 数值直接来自帧层：缓动量 + 按 14 档量化的种子（着色器自己按带切、按噪声决定动不动）。
            glitch.update(current.transition.glitch, current.transition.glitchSeed);
          }

          // 形状：一块形状一个 Graphics（`poly()` 调两次会**累积路径**，所以每块只 poly 一次，再 fill/stroke）。
          const shapeSeen = new Set<string>();
          current.shapes.forEach((item, index) => {
            shapeSeen.add(item.id);
            /*
             * **填充与描边分成两条节点**（第 495 轮）：同一条 `Graphics` 上 `stroke()` 描的是
             * **累积的全部路径** ✓ ⇒ 若把"生长段"接在多边形之后，那一次 `stroke()` 会把**完整轮廓**也描出来 ✗
             * （"生长"的观感就没了 ✓）；而每段各描一次又会**重复描多边形** ✗（越描越黑 ✓）。
             * ⇒ 拆开：`index * 2` 只做填充 ✓、`index * 2 + 1` 只做"逐笔生长"的描边 ✓。
             */
            const fillNode = shapeNode(index * 2);
            const strokeNode = shapeNode(index * 2 + 1);
            /*
             * **生长进度用统一的 `rawProgress`**：即 `targetFinishTime = min(镜末, max(最后一个词起点,
             * 镜起 + 镜长 × 0.95))` 那条口径（见 `SonnetFrame.rawProgress` 的注释）⇒ 背景构图的生长
             * 覆盖整段唱词，不会在长音上提前收笔僵住。逐块的 `delay/span` 仍保留（错峰生长）。
             */
            const reveal = state.reduced ? 1 : clamp01((current.rawProgress - item.delay) / item.span);
            fillNode.clear();
            strokeNode.clear();
            if (item.fillTone >= 0 && item.fillAlpha > 0) {
              fillNode.poly([...item.polygon]);
              fillNode.fill({
                color: pixiColor(tones[item.fillTone] ?? state.ink),
                alpha: item.fillAlpha * reveal,
              });
            }
            fillNode.alpha = item.alpha;
            /*
             * **逐笔生长**（照抄上游 `sonnetAnimatedGraphics` 的意图 ✓）：总长 = 多边形周长 ✓、
             * 目标长 = `总长 × grow` ✓（`grow` 用三次缓出 ✓），逐段 `lineTo`、**最后一次** `stroke` ✓
             * —— 只描"已经长出来的那一段" ✓，所以轮廓会**逐步出现**而不是一开场就完整 ✓。
             */
            if (item.strokeTone >= 0 && item.strokeWidth > 0 && item.strokeAlpha > 0) {
              const points = item.polygon;
              const count = Math.floor(points.length / 2);
              const pointAt = (position: number): { x: number; y: number } => ({
                x: points[position * 2] ?? 0,
                y: points[position * 2 + 1] ?? 0,
              });
              let total = 0;
              for (let step = 0; step < count; step += 1) {
                const from = pointAt(step);
                const to = pointAt((step + 1) % count);
                total += Math.hypot(to.x - from.x, to.y - from.y);
              }
              const grow = state.reduced ? 1 : 1 - Math.pow(1 - reveal, 3);
              let remaining = total * grow;
              const head = pointAt(0);
              strokeNode.moveTo(head.x, head.y);
              for (let step = 0; step < count && remaining > 0; step += 1) {
                const from = pointAt(step);
                const to = pointAt((step + 1) % count);
                const segment = Math.hypot(to.x - from.x, to.y - from.y);
                if (segment <= 0) continue;
                const ratio = remaining >= segment ? 1 : remaining / segment;
                strokeNode.lineTo(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio);
                remaining -= segment;
              }
              strokeNode.stroke({
                color: pixiColor(tones[item.strokeTone] ?? state.ink),
                width: item.strokeWidth,
                alpha: item.strokeAlpha * reveal,
              });
            }
            strokeNode.alpha = item.alpha;
          });
          for (let index = current.shapes.length * 2; index < shapePool.length; index += 1) {
            shapePool[index]?.clear();
          }

          /*
           * **引导线**（照抄 folia `sonnet/sonnetGuides.ts` 的时机与数值，见 `CREDITS.md`）：
           * 与形状同一条纪律 —— `poly()` 会**累积路径**，所以每个图元先 `poly` 再立刻 `stroke`/`fill` ✓。
           * 颜色：主角 `state.emphasis`、陪衬 `secondaryTone`（上游陪衬引导线用的就是
           * `theme.secondaryColor`，不再拿墨色顶替；`white` 位仍是纯白亮芯）；
           */
          guidePool.forEach((node) => {
            node.visible = false;
          });
          current.guides.forEach((guide, index) => {
            const node = guideNode(index);
            node.visible = true;
            node.position.set(guide.anchorX, guide.anchorY);
            node.clear();
            /* 整体包络：主角 .95 / 陪衬 .7（上游 `guide.container.alpha = guide.maxAlpha`）。 */
            node.alpha = guide.plan.maxAlpha;
            const geometry = resolveSonnetGuideGeometry(guide);
            for (const stroke of geometry.strokes) {
              /*
               * **白亮芯**：上游丝线与矩形 spline 各叠一条纯白细线
               * ⇒ `core` 位为真时直接用白、不查色板（与 `disc.white` 同一约定）。
               */
              node.poly([...stroke.points]).stroke({
                color: stroke.core ? 0xffffff : stroke.accent ? state.emphasis : secondaryTone,
                width: stroke.width,
                alpha: stroke.alpha,
              });
            }
            for (const disc of geometry.discs) {
              node.circle(disc.x, disc.y, disc.radius).fill({
                color: disc.white ? 0xffffff : disc.accent ? state.emphasis : secondaryTone,
                alpha: disc.alpha,
              });
            }
            for (const ring of geometry.rings) {
              /* follow circle：**描边**而不是实心（上游就是 `stroke`）。 */
              node.circle(ring.x, ring.y, ring.radius).stroke({
                color: ring.accent ? state.emphasis : secondaryTone,
                width: ring.width,
                alpha: ring.alpha,
              });
            }
            for (const shape of geometry.shapes) {
              node.poly([...shape.points]).fill({
                color: shape.accent ? state.emphasis : secondaryTone,
                alpha: shape.alpha,
              });
            }
          });
          for (let index = current.guides.length; index < guidePool.length; index += 1) {
            guidePool[index]?.clear();
          }

          /*
           * **背景装饰**（照抄 folia `sonnetBackgroundDecor` 的档位与摆法，见 `CREDITS.md`）：
           * 与形状/引导线同一条纪律 —— **每个图元先 `poly`/`circle` 再立刻 `stroke`/`fill`**（`poly` 会累积路径）✓。
           * 颜色：`primary` 用 `state.primary`、其余用 `state.ink`，都要过 `pixiColor` ✓。
           */
          decorPool.forEach((node) => {
            node.visible = false;
          });
          /*
           * **图标精灵**（差别②接线，照抄上游 `sonnetBackgroundDecor.ts`）：
           * `buildSonnetIconParticleIndices` 决定**哪些粒子出图标、各用哪一个**
           * （最多四分之一，且保证每个图标各出现一次），出图标的粒子**不再画形状** ——
           * 上游就是 `node = sprite` 二选一。
           *
           * 三处如实标注的替换（上游对应值我们没有快照）：
           * ① 种子用帧层已有的**每镜档位** `geometryVariant`（上游传的是本镜 seed）；
           * ② 图标名自拟四个手写形状（上游 `resolveSonnetIconNames` 的兜底名是 `Flower`，
           *    但那只是"主题没配 icons 时的兜底"，folia 的 sonnet 主题实际配了哪几个没有快照）；
           * ③ `audio` 恒传 0 —— 音频能量函数 `resolveSonnetIconAudioTarget` 在本项目里
           *    从未接线（与 `sonnetFrame.ts` 里"节拍震动"那条注释是同一个缺口）。
           * 颜色与形状走**同一个来源**（`pixiColor`）再转成 `#rrggbb`，保证图标与图形粒子同色。
           */
          const iconNames = resolveSonnetIconNames(['Flower', 'Orbit', 'Star', 'Diamond']);
          const iconSlotOf = buildSonnetIconParticleIndices(
            iconNames.length,
            current.decor.length,
            current.geometryVariant,
          );
          iconPool.forEach((node) => {
            node.visible = false;
          });
          const iconTime = clock.current() / 1000;
          let iconUsed = 0;
          resolveSonnetDecorDrawItems(current.decor).forEach((item, index) => {
            const particle = current.decor[index];
            const iconIndex = iconSlotOf[index] ?? null;
            if (iconIndex !== null && particle !== undefined) {
              const iconName = iconNames[iconIndex] ?? iconNames[0] ?? 'Flower';
              const iconColorValue = pixiColor(item.primary ? state.primary : state.ink);
              const iconColor = `#${iconColorValue.toString(16).padStart(6, '0')}`;
              const textureKey = buildSonnetIconTextureKey(iconName, iconColor, 1.8, 128, 1);
              const cached = iconTextureCache.get(textureKey);
              if (cached === undefined) {
                const url = buildSonnetIconSvg(iconName, iconColor, 1.8, 128);
                if (url === null) {
                  /* 这个名字我们没有形状 ⇒ 记成空纹理，以后一直跳过（不再重试）。 */
                  iconTextureCache.set(textureKey, Texture.EMPTY);
                } else if (!iconPending.has(textureKey) && !iconLoadFailed.has(textureKey)) {
                  /*
                   * **必须走 `Assets.load`（异步），不能直接 `Texture.from(url)`**：
                   * 实测 `Texture.from(<svg data URL>)` 在本项目的 Pixi 版本下**返回 `undefined`**
                   * ⇒ 紧接着的 `texture.width` 抛 `Cannot read properties of undefined (reading 'width')`，
                   * 而这个异常会被渲染循环的兜底捕获成「绘制该帧失败」⇒ **整帧什么都不画**。
                   * （冒烟日志实测：每个有装饰粒子的帧都报这条，画面整整缺一大块。）
                   * 异步加载完成后回填缓存，下一帧这条粒子就有纹理了。
                   */
                  iconPending.add(textureKey);
                  /*
                   * **用原生 `Image` 加载，不走 Pixi 的 loader**：
                   * 冒烟实测 `Assets.load(<svg data URL>)` 直接报
                   * `[Loader.load] Failed to load data:image/svg+xml;...`（48 次全失败）
                   * —— SVG 的 dataURL 在 Pixi 那套按资源类型分派的 loader 里走不通。
                   * 而 CSP 的 `img-src` 白名单里本来就有 `data:`（`apps/renderer/index.html:12`），
                   * 所以**原生 Image 加载这条路是通的**，加载完再自己包成 `Texture`（不需要 loader）。
                   */
                  const image = new Image();
                  image.onload = () => {
                    iconPending.delete(textureKey);
                    iconTextureCache.set(textureKey, new Texture({ source: new ImageSource({ resource: image }) }));
                  };
                  image.onerror = () => {
                    iconPending.delete(textureKey);
                    iconLoadFailed.add(textureKey);
                  };
                  image.src = url;
                }
                /* 纹理还没就绪：这一帧先不画这个粒子（**不入池、不占序号**）。 */
                return;
              }
              if (cached === Texture.EMPTY || cached.width <= 0) {
                return;
              }
              const texture = cached;
              const sprite = iconNode(iconUsed);
              iconUsed += 1;
              sprite.texture = texture;
              sprite.visible = true;
              sprite.position.set(item.x, item.y);
              sprite.rotation = item.rotation;
              // 上游口径：`sprite.width = sprite.height = 粒子名义半尺寸 × 7` ✓。
              sprite.width = particle.size * 7;
              sprite.height = particle.size * 7;
              const baseScale = sprite.scale.x;
              const entryPhase = resolveSonnetIconEntryPhase(iconIndex, iconNames.length);
              const entryDuration = resolveSonnetIconEntryDuration(current.sceneDuration, 0.62);
              const entryDelay = resolveSonnetIconEntryDelay(
                entryPhase,
                current.sceneDuration,
                entryDuration,
              );
              const pose = resolveSonnetIconPose({
                baseAlpha: particle.alpha,
                baseScale,
                entryProgress: (iconTime - entryDelay) / entryDuration,
                audio: 0,
                phase: entryPhase * 6.2,
                timeInScene: iconTime,
              });
              sprite.alpha = pose.alpha;
              sprite.scale.set(pose.scale);
              return;
            }
            const node = decorNode(index);
            node.visible = true;
            node.position.set(item.x, item.y);
            node.rotation = item.rotation;
            node.clear();
            for (const draw of item.draws) {
              const color = pixiColor(item.primary ? state.primary : state.ink);
              if (draw.kind === 'stroke') {
                node.poly([...draw.points]).stroke({ color, width: draw.width, alpha: draw.alpha });
              } else if (draw.circle !== undefined) {
                node.circle(draw.circle.x, draw.circle.y, draw.circle.radius).fill({ color, alpha: draw.alpha });
              } else {
                node.poly([...draw.points]).fill({ color, alpha: draw.alpha });
              }
            }
          });
          for (let index = current.decor.length; index < decorPool.length; index += 1) {
            decorPool[index]?.clear();
          }
          /*
           * **图标探针**（验收用，ASCII 形式 `分配:已画`）：
           * 冒号前是 `buildSonnetIconParticleIndices` 认为**该出图标**的粒子数，
           * 冒号后是**这一帧真画上去的 sprite 数**。两者不相等通常只有一个原因 ——
           * SVG 纹理还没解码完（异步，头一两帧）。这条探针让"图标到底画出来没有"
           * 变成可读的数字，而不是只能靠肉眼看图猜。
           */
          const iconAllocated = iconSlotOf.reduce<number>(
            (sum, slot) => (slot === null ? sum : sum + 1),
            0,
          );
          host.dataset.sonnetIcons = `${iconAllocated}:${iconUsed}`;
          /*
           * **只要这一帧真有装饰粒子就打印一次**（不做"变了才打"的节流）：
           * 静默帧的 `decor` 本来就是空的，节流会把它和"真的画不出图标"混成同一种沉默。
           */
          if (current.decor.length > 0) {
            console.info(
              `[pi/sonnet] icons particles=${current.decor.length} allocated=${iconAllocated} ` +
                `drawn=${iconUsed} textures=${iconTextureCache.size}`,
            );
          }

          // 字形：位置、入场位移、入场旋转、透明度都由帧层算好，**全部设在 wrapper 上**。
          current.glyphs.forEach((glyph, index) => {
            /*
             * ⚠ **字号只由帧层给、这里不再乘 `state.fontScale`**：
             * `buildSonnetFrame` 已把 `tuning.fontScale`（→ `lyricsFontScale`）乘进基准字号，
             * 渲染层再乘一次就是 double scale（字被放大到与词块尺寸对不上）。
             */
            const wantedStyle = glyphStyle(
              glyph.fontPx,
              pixiColor(glyph.color),
              glyph.weight,
            );
            /*
             * 发光专用样式：与正文同一份字体族/字重（图集复用），**只有 fill 不同**。
             *
             * **主人反馈（他人分析视频）**：folia 的字是**强烈的白色柔光**（像霓虹灯管），
             * 不是彩色光晕 ⇒ 这里从 accent 改成**与字身同色的白**（`state.ink`）。
             * 保留 accent 那条路是上游文案（「accentColor = 歌词发光颜色」）的读法，
             * 但两段录屏同歌对照时，我们的大字是"白字 + 蓝圈"、对方是"白字 + 白光" ——
             * 以**看得见的对照**为准，先按白色发光做，`accent` 仍留给强调字/装饰。
             */
            const wantedHaloStyle = glyphStyle(
              glyph.fontPx,
              pixiColor(state.ink),
              glyph.weight,
            );
            const wantedHollowStyle = hollowStyle(pixiColor(state.ink), glyph.weight);
            /*
             * **巨型幽灵字（背景空心大轮廓）用现成的空心样式**：`hollowStyle` 是 400 基准字号的
             * `fill: transparent` + 描边图集，这里按 `fontPx / 400` 归一 ⇒ 细轮廓巨字；
             * 字体节点自身 α 取 `SONNET_GHOST_TEXT_ALPHA`。wrapper 的位置/旋转/scale/α
             * 仍用帧层数值（入场节奏与正文同一来源）。
             * 正文则把字体节点的**样式 / 缩放 / 透明度全部归位** —— 池节点在两者之间复用，
             * 不归位就会把上一帧的空心巨字样式或 α 0.2 留到这一帧的正文上。
             */
            const isGhost = glyph.ghost;
            const wantedDisplayStyle = isGhost ? wantedHollowStyle : wantedStyle;
            const { wrapper, display, haloWrapper, halo, caWrapper, caCyan, caRed, echo1, echo2 } =
              glyphNode(index, wantedStyle, wantedHaloStyle, wantedHollowStyle);
            wrapper.visible = true;
            /* 幽灵字不发光：帧层 `haloAlpha` 已归零，这里把节点也关掉，免得复用节点留下上一帧的光晕。 */
            haloWrapper.visible = !isGhost;
            /*
             * **样式与文字只在真的变了时才赋值**。
             *
             * 这两个 setter 都会把这份文字的字形四边形整段重建（`onViewUpdate` → `_didTextUpdate`），
             * 每帧无条件赋值等于每帧重建一遍，白烧 CPU。位置/旋转/透明度走 wrapper，不受影响。
             * （发光孪生节点的样式与主节点是同一个实例，所以只需要同步文本。）
             */
            if (display.style !== wantedDisplayStyle) display.style = wantedDisplayStyle;
            if (halo.style !== wantedHaloStyle) halo.style = wantedHaloStyle;
            if (display.text !== glyph.text) display.text = glyph.text;
            if (halo.text !== glyph.text) halo.text = glyph.text;
            wrapper.position.set(glyph.x + glyph.deltaX, glyph.y + glyph.deltaY);
            wrapper.rotation = glyph.rotation;
            wrapper.alpha = glyph.alpha;
            /* 这两行每帧无条件写：节点复用后必须从"空心巨字"状态恢复成正文状态（反之亦然）。 */
            display.alpha = isGhost ? SONNET_GHOST_TEXT_ALPHA : 1;
            /* `ECHO_BASE_FONT_PX` 就是空心图集的基准字号（400）⇒ 缩放后正好等于帧层给的字号。 */
            display.scale.set(isGhost ? glyph.fontPx / ECHO_BASE_FONT_PX : 1);
            /*
             * 缩放与光晕**全部由帧层给**：`scale` 是逐字入场（普通 `0.86 → 1`、
             * `type-impact` 强调字 `0.52 → 1`），`haloScale/haloAlpha` 是光晕那一层。
             * 渲染层只负责把它们设上去，不自己造运动。
             */
            wrapper.scale.set(glyph.scale);
            haloWrapper.position.copyFrom(wrapper.position);
            haloWrapper.rotation = wrapper.rotation;
            haloWrapper.scale.set(glyph.haloScale);
            haloWrapper.alpha = glyph.haloAlpha;
            /*
             * **色差双副本**：偏移与副本透明度都来自帧层；副本自己不再乘一次字身 α
             * （它们是 wrapper 的子节点、已经继承了字身那层 α），所以整层 α 保持 1。
             * 样式复用字身那一份（只是 `tint` 不同）⇒ 只在真的换了字号/字重时赋值。
             */
            const caVisible = !glyph.ghost;
            caWrapper.visible = caVisible;
            if (caVisible) {
              if (caCyan.style !== wantedStyle) caCyan.style = wantedStyle;
              if (caRed.style !== wantedStyle) caRed.style = wantedStyle;
              if (caCyan.text !== glyph.text) caCyan.text = glyph.text;
              if (caRed.text !== glyph.text) caRed.text = glyph.text;
              caCyan.alpha = glyph.caCopyAlpha;
              caRed.alpha = glyph.caCopyAlpha;
              caCyan.position.set(-glyph.caOffset, glyph.caOffset * 0.5);
              caRed.position.set(glyph.caOffset, -glyph.caOffset * 0.5);
            }
            /*
             * **半主角空心回声**：两层，位置/透明度/可见性都来自帧层；
             * 节点的 `scale` 只做"固定基准字号 → 本字字号"的归一，空心描边因此与字号成比例。
             */
            const echoVisible = glyph.echoActive && !glyph.ghost;
            /* 归一化到空心样式的固定基准字号；`glyph.fontPx` 已含用户字号缩放，不再乘第二次。 */
            const echoScale = glyph.fontPx / ECHO_BASE_FONT_PX;
            echo1.visible = echoVisible;
            echo2.visible = echoVisible;
            if (echoVisible) {
              if (echo1.style !== wantedHollowStyle) echo1.style = wantedHollowStyle;
              if (echo2.style !== wantedHollowStyle) echo2.style = wantedHollowStyle;
              if (echo1.text !== glyph.text) echo1.text = glyph.text;
              if (echo2.text !== glyph.text) echo2.text = glyph.text;
              echo1.scale.set(echoScale);
              echo2.scale.set(echoScale);
              echo1.position.set(glyph.echoOffset1X, glyph.echoOffset1Y);
              echo2.position.set(glyph.echoOffset2X, glyph.echoOffset2Y);
              echo1.alpha = glyph.echoAlpha1;
              echo2.alpha = glyph.echoAlpha2;
            }
          });
          /*
           * 这里原来还有一层"**词底下的纸**"（按字形 x 相邻聚类、每簇画一块 `fill alpha 0.22` 的矩形，
           * 外加一段为它服务的层序诊断）——**已整段删除**：那是我们自己加的、原版没有的纸块
           * （参考层里字背后只有淡空心巨字与既有局部几何，没有实心/灰填色的底板）。
           * 真正的局部几何层（`textGeometry` / `backgroundMg` / `frameDecor` / `guides`）与其余装饰一律不动。
           */
          for (let index = current.glyphs.length; index < glyphPool.length; index += 1) {
            // 藏起来而不是销毁：字数在句子之间来回变，每帧销毁再重建会一直抖动纹理上传。
            const spare = glyphPool[index];
            if (spare !== undefined) {
              spare.wrapper.visible = false;
              spare.haloWrapper.visible = false;
              spare.caWrapper.visible = false;
              spare.echo1.visible = false;
              spare.echo2.visible = false;
            }
          }
          /*
           * 记下这一帧真正在画的字数：下一次换句的快照按它拷（见 `captureOutgoingLyrics`）。
           */
          liveGlyphCount = current.glyphs.length;
          /*
           * 首帧留一次痕，而且要量**文字对象自己**：文本内容、实测宽高、可见性、alpha。
           * 只报帧层数据不够用 —— 那样分不清"帧层没给字"与"给了字但文字对象画不出来"。
           * （必须写在字形循环之后：写在前面时池子还没内容，量到的全是 undefined。）
           */
          if (!firstFrameLogged) {
            firstFrameLogged = true;
            const probe = current.glyphs[0];
            const firstNode = glyphPool[0];
            console.info(
              `[pi/sonnet] 首帧诊断：字号=${probe?.fontPx.toFixed(1) ?? '无'}｜字体=${state.fontFamily || '(空)'}｜` +
                `字=${current.glyphs.length}｜形状=${current.shapes.length}｜构图=${current.shotKind}｜` +
                `几何=${current.geoVariant}${current.geoPorted ? '✓原版' : '兜底'}｜` +
                `画布=${host.clientWidth}×${host.clientHeight}｜首字位置=${probe ? `${probe.x.toFixed(0)},${probe.y.toFixed(0)}` : '-'}｜` +
                `颜色=${probe?.color ?? '-'}｜文本=「${firstNode?.display.text ?? ''}」｜` +
                `实测=${firstNode ? `${firstNode.display.width.toFixed(1)}×${firstNode.display.height.toFixed(1)}` : '-'}｜` +
                `发光=${SONNET_GLOW_STRENGTH}/${SONNET_GLOW_ALPHA.toFixed(2)}｜` +
                `可见=${firstNode?.wrapper.visible ?? '无'}｜α=${firstNode?.wrapper.alpha.toFixed(2) ?? '无'}｜` +
                `可渲染=${firstNode?.wrapper.renderable ?? '无'}`,
            );
          }
          /*
           * **GPU 回读探针**（一次性）：字形层里到底有没有像素。
           *
           * 为什么必须这样量：主题段的成品图是"切完主题就拍"，很容易拍在**没有歌词的那一帧**
           * （`data-sonnet-glyphs` 为 0）上 —— 那样"字没上屏"和"这一帧本来就没字"在截图里长得一模一样
           * （我们上一轮的成品图就是这样，白看成"什么都没画"）。而在 rAF 之外 `toDataURL()` 只会拿到空白：
           * Pixi 的 WebGL 画布 `preserveDrawingBuffer` 为 false。`renderer.extract.pixels(容器)` 走的是
           * **渲染到离屏纹理再读回来**，任何时刻都能量到真实结果。
           */
          if (!glyphPixelProbeDone && current.glyphs.length > 0) {
            glyphPixelFrames += 1;
            if (glyphPixelFrames >= 3) {
              glyphPixelProbeDone = true;
              try {
                const dump = app.renderer.extract.pixels(glyphLayer);
                let anyPixel = 0;
                let solidPixel = 0;
                for (let index = 3; index < dump.pixels.length; index += 4) {
                  const alpha = dump.pixels[index] ?? 0;
                  if (alpha > 0) anyPixel += 1;
                  if (alpha > 96) solidPixel += 1;
                }
                console.info(
                  `[pi/sonnet] 字形像素探针（GPU 回读字形层）：${dump.width}×${dump.height}｜` +
                    `有像素=${anyPixel}｜半透以上=${solidPixel}｜当帧字数=${current.glyphs.length}｜构图=${current.shotKind}`,
                );
              } catch (error: unknown) {
                console.error('[pi/sonnet] 字形像素探针失败（回读字形层）', error);
              }
            }
          }
        };

        /*
         * 帧循环交给 **Pixi 自己的 ticker**（照抄原版 `VisualizerSonnet` 的做法：它平时完全由
         * ticker 驱动，只在**暂停**时才手动 `renderOnce()`）。所以这里不再自己 rAF + `app.render()`
         * —— 那是我们此前自己引入的偏离。
         *
         * 注意**不要**再用 `addOnce` 自排（那正是之前卡死渲染主线程的原因：`addOnce` 内部只保存
         * 一个待调回调，在它自己执行的过程中再赋值属于未定义行为）。这里是常规的 `ticker.add`，
         * 由 Pixi 每帧调用，安全。
         */
        const gate = createFrameGate(stateRef.current.fpsCap);
        const tick = (): void => {
          if (destroyed) return;
          const current = stateRef.current;
          if (!gate(performance.now())) return;
          const timeSec = current.clock.current() / 1000;
          const built = buildSonnetFrame({
            program: current.program,
            timeSec,
            /*
             * ⚠ **不能用 `renderer.width / resolution`**（第 31 轮修，主人反馈"字小 / 没填满"）。
             *
             * Pixi v8 里 `renderer.width` 给的**已经是逻辑尺寸（CSS 像素，与 DPR 无关）**，
             * 再除一次分辨率就小了一整个 DPR 倍。实测这台机器 DPR = 1.25、画布逻辑宽 1182，
             * 而帧层拿到的是 **946 = 1182 ÷ 1.25** —— 这是**从四个镜头的基准字号反解出来的**
             * （945.6 / 946.0 / 946.6 / 946.2，四个独立读数落到同一个数上，不可能是巧合）。
             *
             * 后果正好是主人看到的两条：字号按 946 的宽度算、画到 1182 的画布上 ⇒ **字偏小**；
             * 版面也按 946×618 排 ⇒ **内容缩在中间、显得没铺满**。
             * `app.screen` 是 Pixi 给出的逻辑尺寸，本文件既有的几何探针一直在打它
             * （`screen=1182.4x772`，与 `canvasCss=1182x772` 一致）⇒ 用它才对。
             */
            viewport: {
              width: app.screen.width,
              height: app.screen.height,
            },
            inkColor: current.ink,
            emphasisColor: current.emphasis,
            /*
             * ⚠ 取 `current`（`stateRef`）里的那一份，**不是 effect 闭包捕获的**：
             * 换歌时 `program` 与逐字时间轴必须同时换，否则两首歌词共用上一首的逐字节奏。
             */
            glyphsByLine: current.glyphsByLine,
            /*
             * **巨型幽灵字**（参考视频里主角词背后的淡空心大轮廓）：帧层开关缺省 false，
             * 主题这里显式打开。它们是背景装饰层，不参与跟拍焦点与正文包围盒（帧层已保证）。
             */
            showGiantDecorativeText: true,
            /*
             * **真实文本测量**（原版走 `@chenglou/pretext`，机制也是 canvas 测量）：
             * 用一块离屏 canvas 的 `measureText`，字号 + 字重 + 字体族都进缓存键。
             * 拿不到 2D 上下文（比如无 canvas 的环境）就返回 undefined，帧层自动退回估算系数。
             */
            measureTextWidth: (text, fontPx, weight) => {
              const context = measureContextRef.current;
              if (context === null) return Number.NaN;
              const key = `${fontPx.toFixed(2)}|${weight}|${text}`;
              const cached = measureCacheRef.current.get(key);
              if (cached !== undefined) return cached;
              /*
               * **测量基准探针**（第 28 轮）：排版是按 `measureText` 出的宽高算位置的，
               * 所以测量一旦偏小，字的落位就全歪 —— 帧层探针里出现"82px 的汉字盒子只有 23px 宽"
               * 这种自相矛盾的读数（正常应约等于字号），必须先把测量本身证实/证伪。
               * 用 100px 量一个汉字与一个大写拉丁字母：正常应分别约 100 / 约 70。
               */
              if (host.dataset.sonnetMeasureProbe !== '1') {
                host.dataset.sonnetMeasureProbe = '1';
                context.font = `700 100px ${current.fontFamily || 'sans-serif'}`;
                console.info(
                  `[pi/sonnet] measureprobe cjk100=${context.measureText('微').width.toFixed(1)}` +
                    ` asciiH100=${context.measureText('H').width.toFixed(1)}` +
                    ` family=${current.fontFamily || 'sans-serif'}`,
                );
              }
              context.font = `${weight} ${fontPx.toFixed(2)}px ${current.fontFamily || 'sans-serif'}`;
              const width = context.measureText(text).width;
              if (measureCacheRef.current.size > 4000) measureCacheRef.current.clear();
              measureCacheRef.current.set(key, width);
              return width;
            },
            /* 主题的动画强度档（calm/normal/chaotic）—— 运镜、轴心混合与逐字入场位移同吃它。 */
            animationScale: current.animationScale,
            /*
             * **用户字号缩放**（`tuning.fontScale`，上游 `options.lyricsFontScale`）：
             * 它进**基准字号公式**并被 `[24, 112]` 夹住（与 `sonnetSceneBuilder` 同式），
             * 所以下面的 `glyph.fontPx` 已经是最终字号，渲染层不再乘第二次。
             */
            lyricsFontScale: current.fontScale,
          });
          try {
            drawFrame(built);
          } catch (error: unknown) {
            if (!reportedKinds.has(built.shotKind) && reportedKinds.size < 5) {
              reportedKinds.add(built.shotKind);
              console.error(`[pi/sonnet] 绘制该帧失败（构图 ${built.shotKind}）`, error);
            }
          }
        };
        app.ticker.add(tick);

        return true;
      });

    return () => {
      destroyed = true;
      dispose();
    };
    // 只有这两样会改变 Pixi 的装配方式；`clock` / 颜色 / 字体都走 stateRef，避免每帧重建 Application。
  }, [fontScale, reduced]);

  return (
    <div
      className="pi-lyricsonnet"
      ref={rootRef}
      data-sonnet-shot=""
      data-sonnet-kind=""
      data-sonnet-paragraph=""
      data-sonnet-shapes="0"
      data-sonnet-glyphs="0"
      data-sonnet-lit="0"
      data-sonnet-variant="0"
      data-sonnet-progress="0"
      data-sonnet-transition=""
      data-sonnet-crossfade=""
      data-sonnet-window=""
      data-sonnet-rhythm=""
      data-sonnet-focus=""
    />
  );
}
