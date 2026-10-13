/**
 * 商籁（sonnet）的**帧层**：把编译出来的分镜程序解成"这一帧画什么"。
 *
 * 与凝彩同一个分工：编译层决定"哪一段、哪一镜、什么时候"（纯函数），帧层决定"这一帧的每个形状与每个字在哪"
 * （纯函数），渲染层只负责把它们画出来。所以这一层可以像凝彩那样单测，也不依赖 Pixi。
 *
 * === AGPL 说明 ===
 * folia-major 是 AGPL-3.0。字素摆放那一段（`resolveSonnetGlyphMotionDuration` / `buildSonnetGlyphLayout`）
 * 的**数值与做法**照它的 `sonnet/sonnetGlyphLayout.ts` 抄：居中游标、竖排步进取 0.9 倍字号、
 * 奇偶交错决定入场方向与初始偏转、入场时长 `clamp(镜头时长 × 0.42, 0.65, 1.8)` 再夹到镜头的 72%。
 * 代码在本仓库重写。
 *
 * === 照实说清渲染层的规模 ===
 * folia 的重镜头（`type-impact` / `fragment-collage`）底下有 **18 种以上**几何变体（日芒圆、嵌套菱形、
 * 六边形网格、有机分子、电子轨道、行星环、线框山脉、雷达、HUD 框、等距方块、星座、月相、几何莲花、
 * 生命之种、四种棱柱体块…）。本文件目前每种镜头只给**一到两种简化形态**，用来把整条链路跑通；
 * 完整变体表在后续轮次补，这里不假装已经齐了。
 */

import type { SonnetParagraphKind, SonnetShotKind } from './sonnetKinds';
import type { SonnetParagraph, SonnetProgram, SonnetShot } from './sonnetProgram';
import { resolveSonnetSceneProgress } from './sonnetScene';
import {
  resolveShotMotionFrame,
  resolveSonnetBreath,
  resolveSonnetBreathWeight,
  resolveSonnetRhythmProfile,
  /* 上游的时间轴震颤（强度缺省 0 ⇒ 与原版运行时同值）。 */
  resolveTimelineShake,
  SONNET_IDLE_RHYTHM_PROFILE,
  type SonnetRhythmCue,
  type SonnetRhythmProfile,
} from './sonnetMotion';
/* 逐字入场 / 色差 / 回声：纯函数，单独可测（见 `sonnetGlyphMotion.ts`）。 */
import {
  resolveSonnetGlyphMotion,
  resolveSonnetLayoutNormal,
} from './sonnetGlyphMotion';
import {
  SONNET_EMPTY_READING_WINDOW,
  resolveSonnetReadingWindow,
  type SonnetReadingBlock,
  type SonnetReadingWindow,
} from './sonnetReadingWindow';
import {
  SONNET_IDLE_TRANSITION,
  resolveSonnetParagraphExitTransition,
  resolveSonnetShotTransition,
  sonnetSeedNumber,
  type SonnetTransitionFrame,
} from './sonnetTransitions';
import { resolveSonnetGuideFrames, type SonnetGuideFrame } from './sonnetGuides';
import {
  SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_RATIO,
  SONNET_CAMERA_FOCUS_HORIZONTAL_TAIL_RAMP_START,
  SONNET_CAMERA_FOCUS_HORIZONTAL_TAIL_RATIO,
  emptySonnetCameraFocus,
  resolveSonnetCameraFocus,
  type SonnetCameraFocus,
  type SonnetCameraFocusBlock,
  type SonnetCameraFocusGlyph,
} from './sonnetCameraFocus';
import { resolveSonnetDecorParticles, type SonnetDecorParticle } from './sonnetBackgroundDecor';
import {
  resolveSonnetTextGeoFrames,
  type SonnetTextGeoFrame,
} from './sonnetTextGeoFrames';
import { resolveSonnetFrameDecorFrames, type SonnetFrameDecorFrame } from './sonnetFrameDecorFrames';
import {
  findSonnetHeroSegmentIndex,
  isSonnetEmphasisRole,
  resolveSonnetSegmentRoles,
  resolveSonnetRoleWeight,
  scoreSonnetHeroLine,
  type SonnetSegmentRole,
} from './sonnetTypography';
import {
  applySonnetFlowLayout,
  resolveSonnetFlowGaps,
  type SonnetFlowBox,
  type SonnetFlowVariants,
} from './sonnetFlowLayouts';
import {
  buildSonnetBackgroundShapes,
  buildSonnetFixedGeoShapes,
  mixSonnetDecorSeed,
  resolveSonnetFixedGeoVariant,
  type SonnetShapeSpec,
} from './sonnetDecoration';
import {
  buildSonnetGeoShapes,
  hashSonnetSeed,
  hasSonnetGeoVariant,
  isSonnetHeavyShotKind,
  resolveSonnetGeoRotation,
  resolveSonnetGeoVariant,
} from './sonnetGeo';

/** 帧层用到的"一行"就是分镜程序里那一行（`SonnetParagraph['lines']` 的元素）。 */
export type SonnetFrameLine = SonnetParagraph['lines'][number];

/**
 * 帧层用到的"一段"：**原版摆放的粒度就是段（词），不是行**。
 * 这里把它摊平成一条扁平序列，同时记住它来自哪一行（逐字时间的兜底要靠 `line.startTime/endTime`）。
 */
export interface SonnetFrameSegment {
  readonly line: SonnetFrameLine;
  readonly lineIndex: number;
  readonly text: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly isWordLike: boolean;
  /**
   * 这一段覆盖的**字素区间**（在所属行的 `words` 里的起点与长度）。
   *
   * 为什么需要：逐字时间轴是**按行**存进 `glyphsByLine` 的，而帧层摆放的粒度是**段** ——
   * `resolveSonnetGlyphTimings` 拿到 `provided` 会**原样返回**（不按 `text` 裁），
   * 所以必须先把行级时间轴切成本段那一段再喂进去，否则一个词会把整行的字都画出来。
   */
  readonly graphemeStart: number;
  readonly graphemeCount: number;
}
/**
 * CJK 判定（照抄 folia 的 `CJK_TEXT`，**外加半角片假名**）。
 *
 * 上游写的是 `[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]`，**不含半角片假名
 * `\uff66-\uff9f`**；而本仓库另外两处 CJK 判据（`sonnetProgram.ts` 的 `CJK_GRAPHEME`、
 * `LyricStage.tsx` 的 `CJK_ATOM`）都**含**半角片假名 ⇒ 同一个字在"分词"与"排版"两层判得不一样。
 * 后果很具体：竖排里"非 CJK 的多字素片段"会被当成拉丁词**整块转 90°**
 * （`rotates = vertical && 多字素 && !CJK`）⇒ 半角片假名的词会**躺着**出现，
 * 这正是主人报的"朝向零散"的一种。这里补上这一段，与另外两处同口径 ✓。
 */
export const SONNET_CJK_TEXT = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uff66-\uff9f]/u;

export interface SonnetViewport {
  readonly width: number;
  readonly height: number;
}

/* ------------------------------------------------------------------ *
 * 字素摆放（照抄数值的那一段）
 * ------------------------------------------------------------------ */

export interface SonnetGlyphPlacementBox {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  /** 竖排：字往上往下走，入场往左右错开。 */
  readonly vertical: boolean;
  readonly enterX: number;
  readonly enterY: number;
  readonly emphasis: boolean;
}

export interface SonnetPlacedGlyph {
  readonly char: string;
  readonly baseX: number;
  readonly baseY: number;
  /**
   * 这一粒字的**落位右缘**（画布像素 x，含落位旋转的包围盒右边界）。
   *
   * 只给"显现前沿"用：用户量红线量的是**已经唱到的那一粒字的右缘**，不是中心
   * （见 `sonnetCameraFocus.SonnetCameraFocusGlyph.edgeX`）。它由排版解出来的真实步进 / 字宽算，
   * 与逐字入场运动无关。
   */
  readonly edgeX: number;
  readonly enterX: number;
  readonly enterY: number;
  readonly entryRotation: number;
  readonly startTime: number;
  readonly settleTime: number;
}

export interface SonnetMotionWindow {
  readonly startTime: number;
  readonly endTime: number;
}

/** 一个字从入场到落位的时长。 */
export function resolveSonnetGlyphMotionDuration(window: SonnetMotionWindow): number {
  const shotDuration = Math.max(0.001, window.endTime - window.startTime);
  const preferred = Math.min(1.8, Math.max(0.65, shotDuration * 0.42));
  return Math.min(preferred, shotDuration * 0.72);
}

/** 一个字一个字的时长（没有逐字时间轴时按段时长均分）。 */
export interface SonnetGlyphTiming {
  readonly char: string;
  readonly startTime: number;
  readonly endTime: number;
}

/** 段落文本 → 逐字时长（有就给，没有就均分）。 */
export function resolveSonnetGlyphTimings(
  text: string,
  startTime: number,
  endTime: number,
  provided?: readonly SonnetGlyphTiming[],
): SonnetGlyphTiming[] {
  if (provided !== undefined && provided.length > 0) return [...provided];
  const chars = [...text];
  const total = Math.max(0.001, endTime - startTime);
  return chars.map((char, index) => ({
    char,
    startTime: startTime + (total * index) / Math.max(1, chars.length),
    endTime: startTime + (total * (index + 1)) / Math.max(1, chars.length),
  }));
}

/**
 * 把一段字摆成一行（横排）或一列（竖排）。
 *
 * 三个照抄的细节：游标从 `-总宽/2` 起（**字块整体居中**在给定点上）、竖排的步进取 `0.9 × 字号`
 * （而不是量出来的宽度）、奇偶交错 —— 偶数位往一侧偏、奇数位往另一侧偏，入场才有"一粒一粒落下来"的感觉。
 */
export function buildSonnetGlyphLayout(
  timings: readonly SonnetGlyphTiming[],
  placement: SonnetGlyphPlacementBox,
  fontSize: number,
  measureGlyph: (char: string) => number,
  motionWindow: SonnetMotionWindow,
): SonnetPlacedGlyph[] {
  if (timings.length === 0) return [];
  const advances = timings.map((timing) =>
    placement.vertical ? fontSize * 0.9 : Math.max(fontSize * 0.2, measureGlyph(timing.char)),
  );
  const totalAdvance = advances.reduce((sum, advance) => sum + advance, 0);
  const motionDuration = resolveSonnetGlyphMotionDuration(motionWindow);
  const cosine = Math.cos(placement.rotation);
  const sine = Math.sin(placement.rotation);
  let cursor = -totalAdvance / 2;
  return timings.map((timing, index) => {
    const advance = advances[index] ?? 0;
    const localX = placement.vertical ? 0 : cursor + advance / 2;
    const localY = placement.vertical ? cursor + advance / 2 : 0;
    cursor += advance;
    /*
     * 交错：偶数位 -1、奇数位 +1。
     * 横排时它作用在**纵向**（上一下一下地掉），竖排时作用在**横向**（左一下右一下地挤进来）。
     */
    const stagger = index % 2 === 0 ? -1 : 1;
    const startTime = timing.startTime;
    const baseX = placement.x + localX * cosine - localY * sine;
    const baseY = placement.y + localX * sine + localY * cosine;
    /*
     * **落位右缘**：横排取"沿流向的半个步进"，竖排取"字身自身的半个宽"（竖排时流向是 y，
     * 横向占位是字宽）。再按落位旋转取包围盒的 x 上界 —— 与 `resolveSonnetBodyBounds`
     * 的逐字口径同一支（半高按字号 × 1.05 估）。
     */
    const halfInline =
      (placement.vertical ? Math.max(fontSize * 0.2, measureGlyph(timing.char)) : advance) / 2;
    const halfHeight = (fontSize * 1.05) / 2;
    const edgeX = baseX + Math.abs(halfInline * cosine) + Math.abs(halfHeight * sine);
    return {
      char: timing.char,
      baseX,
      baseY,
      edgeX,
      enterX: placement.enterX + (placement.vertical ? stagger * fontSize * 0.28 : 0),
      enterY: placement.enterY + (placement.vertical ? 0 : stagger * fontSize * 0.24),
      // 强调角色偏转更大（0.055 对 0.035 弧度）。
      entryRotation: stagger * (placement.emphasis ? 0.055 : 0.035),
      startTime,
      settleTime: Math.max(startTime, startTime + motionDuration),
    };
  });
}

/*
 * 这里原来有一个 `fitSonnetPlacedLine`（把摆好的一整行挪回画布内）与两个"不许出画布"的常量，
 * 已删除：原版允许字出血，排版层只留一道尺寸约束（单词/片段超过画面 82% 时整体缩，见下面的
 * `fitScale`），没有位置夹取、碰撞推挤或逐字缩小。
 */

/* ------------------------------------------------------------------ *
 * 图形指令：帧层把装饰与版式都压成"一组画多边形的指令"，渲染层只认这一种
 * ------------------------------------------------------------------ */

export type { SonnetShapeSpec } from './sonnetDecoration';

export interface SonnetGlyphSpec {
  readonly char: string;
  readonly text: string;
  /*
   * 这三个是 `readonly`：落点与字号只由排版决定（帧层不再做推挤 / 缩字 / 夹回画布），
   * 下游无法再把字推走或压小。
   */
  readonly x: number;
  readonly y: number;
  readonly fontPx: number;
  /**
   * 这一粒字**开始唱**的绝对时刻（秒）—— 与 `run.tracking` 里同一个 `startTime`（排版解出来的）。
   *
   * 加它只为**验收与探针**：衡量"显现前沿"要看"最近已经开始唱的那一粒字的**最终落位**右缘"，
   * 没有逐字 cue 时刻就只能靠文本猜排版顺序。它是**纯 cue 事实**，不随入场位移 / α 变。
   */
  readonly startTime: number;
  /**
   * 这一粒字的**落位右缘**（画布像素 x；= `run.tracking` 里同一个 `edgeX`，由排版真实步进算）。
   *
   * 它是"显现前沿"的度量口径：相机把 `sonnetCameraFocus` 算出的前沿锚到屏幕目标比例上，
   * 验收量的是**这一列数**投到屏幕上的位置。同样与入场运动无关（不含 `deltaX/scale`）。
   */
  readonly edgeX: number;
  /*
   * 位移 / 旋转由纯函数 `resolveSonnetGlyphMotion` 一次算好：落位后 `deltaX/deltaY` 恒为 0、
   * `rotation` 恒为这一串字自己的角度（没有退场）。
   */
  readonly deltaX: number;
  readonly deltaY: number;
  readonly rotation: number;
  /**
   * **落位旋转**（弧度，= `run.rotation`，不含入场偏转）。
   *
   * `rotation` 含入场偏转、逐帧在变；取景量"这一镜的落位范围"时要用这个恒定的角，
   * 否则入场期间包围盒会跟着抖。
   */
  readonly layoutRotation: number;
  readonly alpha: number;
  /**
   * 逐字入场的**字身缩放**（上游 `scale`）：普通字 `0.86 → 1`，
   * `type-impact` 里的强调字 `0.52 → 1`。渲染层直接设在 wrapper 上（不要再自造 punch）。
   */
  readonly scale: number;
  /** 光晕缩放：`scale × (1.08 − 0.08 × progress)`（上游同一个式子）。 */
  readonly haloScale: number;
  /** 光晕透明度：入场起手 1、落位前衰减到 0.72；没轮到的字（`waiting`）与装饰字（`ghost`）为 0。 */
  readonly haloAlpha: number;
  /**
   * **色差（青/红双副本）**：`caOffset` 是副本当前的分离量（入场时最大、落位后只留 20%），
   * `caCopyAlpha` 是每份副本自己的透明度（强调 0.8 / 其余 0.5）。整层透明度用 `alpha`。
   * 装饰字（`ghost`）不画副本：`caOffset` 与 `caCopyAlpha` 恒为 0。
   */
  readonly caOffset: number;
  readonly caCopyAlpha: number;
  /**
   * **半主角空心回声**：一次性，`echoActive` 只在这一字入场后的 `echoDuration` 秒内为真。
   * 两层沿版面法向分开（`echoOffset1*` / `echoOffset2*`），透明度见 `echoAlpha1/2`；
   * `echoProgress` 是线性进度（可测）。
   */
  readonly echoActive: boolean;
  readonly echoProgress: number;
  readonly echoDuration: number;
  readonly echoAlpha1: number;
  readonly echoAlpha2: number;
  readonly echoOffset1X: number;
  readonly echoOffset1Y: number;
  readonly echoOffset2X: number;
  readonly echoOffset2Y: number;
  readonly emphasis: boolean;
  /** 字重：主角/次主角 900、装饰 300、其余 700（照抄 folia 的排版角色表）。 */
  readonly weight: number;
  readonly color: string;
  /**
   * 这一粒是不是**巨大幽灵字**（主角的影子）。
   *
   * 幽灵字是**故意出血**的（照抄 folia：它落在主角左上 10%/5% 处、字号又是主角的 3.5 倍）。
   * 正文现在也允许出血，但**诊断读数与用例仍然把幽灵字和正文分开量** —— 它字号 3.5 倍，
   * 混进来会把"正文有没有跑飞"的读数带偏。
   */
  readonly ghost: boolean;
}

/**
 * **连续预测焦点读数**（`sonnetFrame.cameraFocus`，见 `sonnetCameraFocus.ts`）。
 *
 * 渲染层的**平移兜底**只盯 `minX..maxY`（焦点周围的**固定舒适区**），不盯"此刻正在唱的那几个字"
 * —— 后者会在换语义块时一步把镜头拉过去。焦点本身已经逐帧连续（高斯融合），
 * 所以这里没有"站 / 保持期 / 过渡进度"这些分页概念。
 */
export type SonnetCameraFocusFrame = SonnetCameraFocus;

export interface SonnetFrame {
  readonly shotId: string;
  /** 每镜取景锚点的增量（画面像素；由主题施加在整棵场景容器上，见 `anchorDelta` 的计算注释）。 */
  readonly anchorDelta: { readonly x: number; readonly y: number };
  /**
   * **本镜的轴心**（画面像素坐标，绝对）= `basePivot + (预测焦点 − basePivot) × 动画强度`。
   *
   * 上游 `sonnetShotFrame.ts:151` 就是这个混合式：旋转与缩放绕着它走。`basePivot` 由镜头种类定
   * （海报 = 画面中心；其余 = 第一个主角字中心 / 正文包围盒中心，见 `anchorDelta` 的注释）。
   * 这里把混合后的轴心交给渲染层，位移由 `anchorDelta` 负责（`pivot + anchorDelta` 恒等于取景锚点）。
   *
   * ⚠ **混合的另一端是"连续预测焦点"**（见 `sonnetCameraFocus.ts`）：它按语义词组的真实 cue 区间
   * 做高斯融合、只带一点点 lookahead，不再逐字跟拍、也不再按"页"固定停留。
   */
  readonly pivot: { readonly x: number; readonly y: number };
  readonly shotKind: SonnetShotKind;
  readonly paragraphKind: SonnetParagraphKind;
  readonly paragraphIndex: number;
  readonly shotIndex: number;
  readonly progress: number;
  /**
   * **统一的绝对时间生长进度**（0~1）。
   *
   * 数值与 `progress` 同源（`resolveSonnetSceneProgress`，原实现已是上游那条
   * `targetFinishTime = min(镜末, max(最后一个词起点, 镜起 + 镜长 × 0.95))` /
   * `drawDuration = max(1, targetFinishTime − 镜起)` 口径）；单列一位只是统一命名，
   * 让背景 / 形状 / 固定几何 / 背景 MG 都读同一个字段。
   *
   * ⚠ 词级装饰（`guides` / `textGeo` / `frameDecor`）不吃这一位：它们各自按**自己那个词**的
   * 绝对时间求值（见 `sonnetGuides.ts` 的窗口与 `sonnetTextGeoFrames.ts` 的时序）。
   */
  readonly rawProgress: number;
  /**
   * 本镜的**总时长（秒）**。
   *
   * 图标入场要按上游的**秒**口径算（`resolveSonnetIconEntryDuration(sceneDuration, preferred)`），
   * 而渲染层此前只拿得到 `progress`（0~1）、拿不到镜长 ⇒ 加这一个字段，
   * 让渲染层能直接照抄上游公式，而不是把秒口径近似成进度比例。
   */
  readonly sceneDuration: number;
  /**
   * 本镜的**绝对开始时刻（秒）**。
   *
   * 镜内动画（如背景粒子的自转）以 `time − shotStartTime` 为相位锚点；
   * 直接给绝对时刻，渲染层不必从 `progress` 逆推。
   */
  readonly shotStartTime: number;
  readonly camera: {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
    readonly rotation: number;
    /**
     * **呼吸的渐入权重**（0~1，`resolveSonnetBreathWeight`）：把"镜头什么时候开始浮、浮了多少"
     * 变成可断言的数据，渲染层不用。
     */
    readonly breathWeight: number;
    /** 呼吸开始渐入的时刻 = **本镜最后一个"追踪字"的开始时间**（上游 `revealDoneTime`）。 */
    readonly revealDoneTime: number;
  };
  readonly glyphs: readonly SonnetGlyphSpec[];
  readonly shapes: readonly SonnetShapeSpec[];
  readonly geometryVariant: number;
  /** 重镜头用的**原版几何档位**（0~99，照抄 folia 的 `resolveSonnetGeoVariant`）。 */
  readonly geoVariant: number;
  /** 这一档原版几何**搬过来了没有**（false = 画面上是我们自拟的兜底图形）。 */
  readonly geoPorted: boolean;
  readonly transition: SonnetTransitionFrame;
  readonly fallback: boolean;
  /**
   * **引导线 / 定位标记**（照抄 folia `sonnet/sonnetGuides.ts` 的时机与数值，
   * 随机源改成确定性的 `sonnetHash01`）：文字抵达**之前**先画一道引导线 + 抛一把几何碎屑，
   * 一直持续到文字入场后 0.65 秒。渲染层按清单画即可（见 `sonnetGuides.ts` 文件头）。
   */
  readonly guides: readonly SonnetGuideFrame[];
  /**
   * **背景装饰粒子**（照抄 folia `sonnet/sonnetBackgroundDecor.ts`）：一小把按种子档位摆开的
   * 小装饰（`type-impact` 24 个、其余 12 个），颜色在 `primary` / `secondary` 之间交替 ✓。
   * 渲染层按清单画即可（形状→图元由 `sonnetDecorGeometry.ts` 折算 ✓）。
   */
  readonly decor: readonly SonnetDecorParticle[];
  /**
   * **装饰性开放边框**（照抄 folia `sonnet/sonnetFrameDecor.ts`）：围绕部分 placement 逐边生长、
   * **四角永不闭合**、每角收一个小花纹（四档）；`role === 'decoration'` 的幽灵字不参与 ✓。
   *
   * 两处差异（详见 `sonnetFrameDecorFrames.ts` 文件头）：① 上游按**段文本**哈希选档，我们用**数字哈希**；
   * ② 上游用 placement 的**真实宽高**，我们的 `SonnetGlyphRun` 没有尺寸字段 ⇒ **尺寸是估算** ✓。
   *
   * 字段**可选**：帧层没给（或将来这条路关掉）时为 `undefined`，渲染层按 `?? []` 处理 ✓。
   */
  readonly frameDecor?: readonly SonnetFrameDecorFrame[];
  /**
   * **每个词背后的局部固定几何**（出处与数值见 `sonnetTextGeoFrames.ts` 文件头）：
   * 与 `decor`（全场粒子）、`shapes`（背景构图）分开，是跟着**那个词自己**的入场时序落位的词级装饰。
   * 逐 run 一条（命中的带 `motion`、没命中的不带）⇒ 渲染层按下标复用池节点。
   */
  readonly textGeo: readonly SonnetTextGeoFrame[];
  /**
   * **阅读窗口**（见 `sonnetReadingWindow.ts`）：以 `runs`（词 / 短句，带真实
   * 逐字 cue 与落位点）为单位，"**当前正在唱的块 + 前后近邻块**"的**连续**窗口。
   *
   * 渲染层的**缩放**只认它 —— 不再对整镜 `glyphs` 的落位边界做硬约束，
   * 所以长多行歌词不会为了"整镜 fit"被缩成小字；窗外块允许越过画面边缘。
   * **平移**不认它（那是 `cameraFocus` 的活）：窗口中心会被空间上分散的邻块拉偏。
   */
  readonly readingWindow: SonnetReadingWindow;
  /**
   * **连续预测焦点读数**（见 `sonnetCameraFocus.ts`）：这一帧镜头看哪里、焦点周围的舒适区多大。
   * 渲染层的平移兜底只盯它 —— 焦点是语义词组中心的连续高斯融合，没有"页 / 站"。
   */
  readonly cameraFocus: SonnetCameraFocusFrame;
  /**
   * ⚠ **兼容别名**：与 `cameraFocus` **同一个对象**。
   *
   * 根目录 `.tmp/sonnet-anticipation-20261011/` 下已保存的回放探针（`probe.cjs` 等）直接读
   * `frame.cameraPlan` 当取景的 `planBounds`、并读 `.summary`。本轮换的是机制（分页计划 →
   * 连续预测焦点），探针文件按约定**不改**，所以保留这个字段名指同一份焦点读数；
   * 它**不是**旧的"分页计划"，`stopIndex / stopRevealTime / phase` 这些分页字段已经不存在。
   */
  readonly cameraPlan: SonnetCameraFocusFrame;
  /**
   * **唱词时间轴节奏**（不是音频 BPM，见 `sonnetMotion.ts` 的口径声明）：由真实逐字 cue 的
   * 局部间隔 / 持续时长推出的跟拍强度、保边平滑窗与呼吸倍率。
   */
  readonly rhythm: SonnetRhythmProfile;
}

/**
 * **主角字号倍率表**（照抄 folia 的 `sonnetTypographyLayout.ts`）。
 *
 * 注意单位：这些是**基准字号的倍率**，不是"占视口的比例"。我们早先用的是后者（0.052~0.115），
 * 量级完全对不上 —— 原版主角字是基准字号的 **3.0 ~ 5.5 倍**。
 *
 * `editorial-column` 在原版里有四档排版变体，主角倍率各不同（0/1 → 4.0、2 → 3.2、3 → 3.8、4 → 4.2），
 * 这里给的是默认档 4.0；变体分流还没实现。
 */
export const SONNET_HERO_FONT_SCALE: Readonly<Record<SonnetShotKind, number>> = {
  'editorial-column': 4,
  'type-impact': 5.5,
  'fragment-collage': 3.2,
  'tracking-ribbon': 3.5,
  'mask-reveal': 4.5,
  'poster-blocks': 4.4,
  'quiet-tableau': 3,
};

/** 陪衬字（support）的倍率，同样照抄。 */
export const SONNET_SUPPORT_FONT_SCALE: Readonly<Record<SonnetShotKind, number>> = {
  'editorial-column': 1.2,
  'type-impact': 1.5,
  'fragment-collage': 1.35,
  'tracking-ribbon': 1.5,
  'mask-reveal': 1.6,
  'poster-blocks': 1.15,
  'quiet-tableau': 1.15,
};

/** 次主角的字号：`max(陪衬 × 1.35, 主角 × 0.72)`（照抄）。 */
export const SONNET_SEMI_HERO_SCALE_BOOST = 1.35;
export const SONNET_SEMI_HERO_SCALE_RATIO = 0.72;
/**
 * 文字最多占到视口的多少（安全边界）。
 *
 * folia 原值是 **0.82**，但那是**它自己的施加顺序**下的值；我们这边 0.82 是**不够的**：
 * 这一处夹取发生在**运镜缩放之前**，随后 `SonnetTheme.tsx` 会把整个 `world` 乘上
 * `camera.zoom`（`sonnetMotion.ts` 的运镜帧最大 = `mask-reveal` 的 **1.08**、
 * 最猛的一档是 `type-impact` 开场推近 **1.22**）⇒ 82% × 1.22 ≈ **100%**，四边正好贴边/出画
 * （主人录屏里「大字被窗口切掉」）。
 *
 * ④「主歌词放大」（主人点名的方向之四）：**回填到 0.8**，让主体字接近占满画面
 * （folia 的大字本来也各自贴过边）。原来折进最大推近（`0.82 / 1.22 ≈ 0.67`）是为了保
 * 「绝不出画」，但主人要的是"主体够大" ⇒ 0.8 下最坏情况 ≈ `0.8 × 1.22 ≈ 98%`：贴边，不越界。
 *   · 任何运镜档位下字都不再出画 ✓；
 *   · 普通档位（zoom ≈ 1）下字也会比原来小约两成 —— 录屏里两侧的大字其实都各自贴过边，
 *     所以这一档**判不出谁更对**，是「宁可不出画」的主动选择（子代理审计的结论）。
 *
 * ⚠ 更好的做法是「按这一镜的实际 zoom 逐镜缩放安全边界」（那要把运镜帧传进排版层），
 * 这里先用一个常量兜住最坏情况，别在没验过的情况下动结构。
 *
 * 注：**取值改回原版的 0.82**。上面"折进相机推近"的理由已不成立 —— 相机现在把
 * `shot.camera.zoom` 也乘进来、且画面**允许出血**，用 0.8 并不会换来"绝不出画"。
 */
export const SONNET_FIT_MAX_RATIO = 0.82;
/** 主角从画面下方这个比例处滑上来（照抄：`heroBox.enterY = height × 0.15`）。 */
export const SONNET_HERO_ENTER_DROP = 0.15;
/** 单行行高按字号乘 1.2 估（照抄，原版即 `measuredHeight = fontSize × 1.2`）。 */
export const SONNET_HEIGHT_PER_FONT = 1.2;
/**
 * **阅读块**四至的估算半边长（× 字号）：CJK 字身约 1em、竖排步进 0.9em ⇒ 0.55 覆盖得住。
 * 取景只把它当**软依据**（不做硬包含、允许出血），所以估算足够，不必逐字量宽。
 */
export const SONNET_READING_BLOCK_PAD_RATIO = 0.55;
/** 竖排时每个字的步进（字号倍数）—— 照抄 folia 的 `0.9`。 */
export const SONNET_CJK_COLUMN_STEP = 0.9;
/**
 * 基准字号相对视口的比例。
 *
 * **这一条是推断，不是照抄**：原版的 `baseFontSize` 由 `createSonnetPixiRuntime.ts`（48KB）传进来，
 * 那个文件还没取到。这里按"主角字约占屏高两成"反推成 `min(宽, 高) × 0.030`。
 */
export const SONNET_BASE_FONT_SCALE = 0.03;

/**
 * 行宽**估算**的字宽系数（CJK / 其余）。
 *
 * 早先一律按 `可见字数 × 字号 × 0.62`：对拉丁文差不多，**对 CJK 明显偏小** ——
 * 中文一个字基本就是 1 个字宽，于是 `fitScale` 以为装得下、真摆下来整行溢出画布
 * （实测社论栏那行在左边缘被切掉半个字）。这里按字种分开估：CJK 1.0 个字宽、其余 0.55。
 *
 * **仍然是估算**：原版用 `@chenglou/pretext` 真实测量（见 `docs/PLAN.md` 的差异登记）。
 */
export const SONNET_CJK_WIDTH_RATIO = 1;
export const SONNET_OTHER_WIDTH_RATIO = 0.55;
/** 空格按这个比例算（比正文字窄）。 */
export const SONNET_SPACE_WIDTH_RATIO = 0.3;
const SONNET_WIDE_CHAR =
  /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/;

/** 一行文本的估算宽度（见上面两个系数的说明）。 */
export function estimateSonnetLineWidth(text: string, fontPx: number): number {
  let width = 0;
  for (const char of text) {
    if (char.trim() === '') {
      width += fontPx * SONNET_SPACE_WIDTH_RATIO;
    } else {
      width += fontPx * (SONNET_WIDE_CHAR.test(char) ? SONNET_CJK_WIDTH_RATIO : SONNET_OTHER_WIDTH_RATIO);
    }
  }
  return Math.max(fontPx * 0.2, width);
}

export const SONNET_GLYPH_ENTER_PROGRESS: Readonly<Record<SonnetShotKind, readonly [number, number]>> = {
  'editorial-column': [-0.06, 0],
  'type-impact': [0, -0.12],
  'fragment-collage': [-0.1, -0.06],
  'tracking-ribbon': [0.14, 0],
  'mask-reveal': [-0.2, 0],
  'poster-blocks': [0, 0.06],
  'quiet-tableau': [0, 0.04],
};

/**
 * 字形的**不透明度上限**（入场进度乘它）。
 *
 * 用户本轮对照 folia 录屏（同一首歌）量出来的事实：亮像素（≥200）占比 **folia 3.47% vs 我们 0.93%**、
 * P99 亮度 **241 vs 198** —— 我们的字整体只到半亮。0.5 这个值在 `.folia-ref` 快照里**查无对应常量**
 * （是当初为了"文字别太抢"自己拍的），现在按录屏证据回到 1.0：入场进度仍然从 0 长到满，
 * 只是落点不再砍一半。
 */
export const SONNET_GLYPH_ALPHA = 1;

function circlePolygon(cx: number, cy: number, radius: number, segments = 32): number[] {
  const points: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    points.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  }
  return points;
}

function rectPolygon(x: number, y: number, width: number, height: number): number[] {
  return [x, y, x + width, y, x + width, y + height, x, y + height];
}

function rotatePolygon(polygon: readonly number[], cx: number, cy: number, angle: number): number[] {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const points: number[] = [];
  for (let index = 0; index + 1 < polygon.length; index += 2) {
    const dx = (polygon[index] ?? 0) - cx;
    const dy = (polygon[index + 1] ?? 0) - cy;
    points.push(cx + dx * cosine - dy * sine, cy + dx * sine + dy * cosine);
  }
  return points;
}

/** 确定性哈希（同一份程序 + 同一个种子必须帧帧一致）。 */
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

function shape(
  id: string,
  polygon: readonly number[],
  options: Partial<Omit<SonnetShapeSpec, 'id' | 'polygon'>> = {},
): SonnetShapeSpec {
  return {
    id,
    polygon,
    fillTone: options.fillTone ?? -1,
    fillAlpha: options.fillAlpha ?? 0,
    strokeTone: options.strokeTone ?? 0,
    strokeWidth: options.strokeWidth ?? 2,
    strokeAlpha: options.strokeAlpha ?? 0.6,
    alpha: options.alpha ?? 1,
    delay: options.delay ?? 0,
    span: options.span ?? 0.6,
  };
}

/** 该镜用哪一种几何变体（完整表待补，这里先在几档里挑）。 */
export function resolveSonnetGeometryVariant(seed: string, index: number): number {
  return Math.floor(hash01(seed, 700 + index) * 4);
}

/**
 * 这一镜的**数字种子**（folia 的 `shotSeed` 是 32 位整数，固定几何取档、背景取位都由它决定）。
 * 我们只有字符串种子，所以先混合成 32 位再交给装饰层 —— 同一个镜头每次算出来必须一样。
 */
export function shotSeedNumber(seed: string, shotIndex: number): number {
  return mixSonnetDecorSeed(Math.floor(hash01(seed, 300 + shotIndex) * 0xffffffff), 0x27d4eb2f);
}

/**
 * 装饰图形。
 *
 * 重镜头（`type-impact` / `fragment-collage`）底下是我们那几档大几何（原版同类图形在
 * `sonnetShotMg.ts` 里有 100 种变体，我们暂时只搬了几档）；**其余族的背景与固定几何
 * 一律走 `sonnetDecoration`**，数值照抄 folia。
 */
function buildShapes(
  shot: SonnetShot,
  shotIndex: number,
  viewport: SonnetViewport,
  seed: string,
): SonnetShapeSpec[] {
  const { width, height } = viewport;
  const unit = Math.min(width, height);
  const variant = resolveSonnetGeometryVariant(`${seed}|${shot.id}`, shotIndex);
  const shotSeed = shotSeedNumber(`${seed}|${shot.id}`, shotIndex);
  /*
   * 重镜头的几何：**先试搬过来的原版档位**（`sonnetGeo`，每轮补几档），
   * 没搬到的档位返回 `null`，就退回我们自拟的那几档（不假装已经齐了）。
   */
  const portedGeo = buildSonnetGeoShapes(viewport, resolveSonnetGeoVariant(shotSeed), shotSeed);
  const shapes: SonnetShapeSpec[] = [];
  const geoStart = shapes.length;
  const cx = width / 2;
  const cy = height / 2;
  switch (shot.kind) {
    case 'type-impact': {
      if (portedGeo !== null) {
        shapes.push(...portedGeo);
        break;
      }
      /*
       * 变体 2 / 3：**嵌套菱形**与**六边形网格**。
       *
       * 这两样的形状是自拟的（folia 那边对应变体的源码没抓稳），但**语义**照它的变体清单：
       * 重字冲击底下常见的就是"同心几何"与"蜂窝网格"两类。变体 0/1 仍是日芒圆与射线。
       */
      if (variant >= 2) {
        if (variant === 2) {
          for (let layer = 0; layer < 4; layer += 1) {
            const reach = unit * (0.44 - layer * 0.09);
            shapes.push(
              shape(
                `diamond-${layer}`,
                [cx, cy - reach, cx + reach, cy, cx, cy + reach, cx - reach, cy],
                {
                  strokeWidth: layer === 0 ? 5 : 1.6,
                  strokeAlpha: layer === 0 ? 0.75 : 0.4,
                  delay: 0.05 * layer,
                },
              ),
            );
          }
        } else {
          const hexRadius = unit * 0.12;
          for (let row = -1; row <= 1; row += 1) {
            for (let column = -1; column <= 1; column += 1) {
              const hx = cx + column * hexRadius * 1.7;
              const hy = cy + row * hexRadius * 1.5;
              const hexagram: number[] = [];
              for (let step = 0; step < 6; step += 1) {
                const angle = (step / 6) * Math.PI * 2;
                hexagram.push(hx + Math.cos(angle) * hexRadius, hy + Math.sin(angle) * hexRadius);
              }
              shapes.push(
                shape(`hex-${row + 1}-${column + 1}`, hexagram, {
                  strokeWidth: 2,
                  strokeAlpha: 0.5,
                  delay: 0.02 * (row * 3 + column + 4),
                }),
              );
            }
          }
        }
        break;
      }
      // 日芒圆：两圈同心圆 + 一圈长短相间的射线。
      shapes.push(
        shape('sun-outer', circlePolygon(cx, cy, unit * 0.42, 64), {
          strokeWidth: 5,
          strokeAlpha: 0.75,
          fillTone: 0,
          fillAlpha: 0.06,
        }),
        shape('sun-inner', circlePolygon(cx, cy, unit * 0.3, 48), { strokeWidth: 2, strokeAlpha: 0.4 }),
      );
      if (variant >= 1) {
        const rays: number[] = [];
        for (let index = 0; index < 32; index += 1) {
          const angle = (index / 32) * Math.PI * 2;
          const inner = unit * (0.12 + (index % 3) * 0.02);
          const outer = unit * (0.2 + (index % 2) * 0.06);
          rays.push(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
          rays.push(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
        }
        shapes.push(shape('sun-rays', rays, { strokeWidth: 1, strokeAlpha: 0.35, delay: 0.08 }));
      }
      break;
    }
    case 'fragment-collage': {
      if (portedGeo !== null) {
        shapes.push(...portedGeo);
        break;
      }
      /*
       * 变体 2 / 3：**碎片三角扇**与**星座**（散点 + 相邻连线）。
       * 同样是"形状自拟、语义照清单"：碎片拼贴底下要么是从一处扇开的碎片，要么是点点连成的图。
       */
      if (variant >= 2) {
        if (variant === 2) {
          for (let index = 0; index < 9; index += 1) {
            const angle = (index / 9) * Math.PI * 2;
            const inner = unit * 0.2;
            const outer = unit * 0.5;
            const half = 0.12;
            shapes.push(
              shape(
                `fan-${index}`,
                [
                  cx + Math.cos(angle - half) * inner, cy + Math.sin(angle - half) * inner,
                  cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer,
                  cx + Math.cos(angle + half) * inner, cy + Math.sin(angle + half) * inner,
                ],
                {
                  fillTone: index % 2 === 0 ? 0 : 1,
                  fillAlpha: 0.45,
                  strokeWidth: 1,
                  strokeAlpha: 0.4,
                  delay: 0.03 * index,
                },
              ),
            );
          }
        } else {
          const stars: { readonly x: number; readonly y: number }[] = [];
          for (let index = 0; index < 8; index += 1) {
            stars.push({
              x: width * (0.12 + hash01(`${seed}|${shot.id}`, 980 + index) * 0.76),
              y: height * (0.12 + hash01(`${seed}|${shot.id}`, 990 + index) * 0.76),
            });
          }
          const links: number[] = [];
          for (let index = 0; index + 1 < stars.length; index += 1) {
            links.push(
              stars[index]?.x ?? 0, stars[index]?.y ?? 0,
              stars[index + 1]?.x ?? 0, stars[index + 1]?.y ?? 0,
            );
          }
          shapes.push(shape('constellation-links', links, { strokeWidth: 1.2, strokeAlpha: 0.35 }));
          stars.forEach((star, index) => {
            shapes.push(
              shape(`constellation-${index}`, circlePolygon(star.x, star.y, unit * 0.008, 12), {
                fillTone: 0,
                fillAlpha: 0.85,
                strokeWidth: 0,
                delay: 0.03 * index,
              }),
            );
          });
        }
        break;
      }
      // 散落方块：位置与边长都由种子决定，但**刻意偏向四角**，中间留给字。
      const count = 7 + variant;
      for (let index = 0; index < count; index += 1) {
        const side = hash01(`${seed}|${shot.id}`, 900 + index) > 0.5 ? 1 : -1;
        const x = cx + side * width * (0.1 + hash01(`${seed}|${shot.id}`, 910 + index) * 0.34);
        const y = height * (0.08 + hash01(`${seed}|${shot.id}`, 920 + index) * 0.84);
        const size = unit * (0.05 + hash01(`${seed}|${shot.id}`, 930 + index) * 0.1);
        const angle = (hash01(`${seed}|${shot.id}`, 940 + index) - 0.5) * 0.6;
        shapes.push(
          shape(`chip-${index}`, rotatePolygon(rectPolygon(x, y, size, size), x + size / 2, y + size / 2, angle), {
            fillTone: index % 2 === 0 ? 0 : 1,
            fillAlpha: 0.75,
            strokeWidth: 2,
            delay: 0.04 * index,
          }),
        );
      }
      break;
    }
    default:
      /*
       * 其余五族（社论栏 / 跟拍丝带 / 遮罩揭示 / 海报方块 / 静场）在 folia 里**没有**各自的背景图形：
       * bg 层只撒五个小方块，画面靠排版 + 固定几何（只挂重镜头）+ 幽灵字撑起来。
       * 原先我们自拟的那些色带、丝带、大色块都是"形状自拟"，这一轮按原版删掉。
       */
      break;
  }
  /** 几何那一批到此为止（后面追加的背景与固定几何不参与整体旋转）。 */
  const geoEnd = shapes.length;
  // 每族背景（照抄 folia 的 bg 层：社论栏是**严格网格**，其余族是**五个撒开的小方块**）。
  shapes.push(...buildSonnetBackgroundShapes(viewport, shot.kind, shotSeed));
  /*
   * 固定几何（8 档"印在纸上的版块"：实心块 + 空心框 + 斜线网）**只挂在重镜头**上 ——
   * 照抄 folia 的调用点：它出现在 `type-impact` / `fragment-collage` 那一支里，社论栏与兜底分支都没有。
   */
  if (shot.kind === 'type-impact' || shot.kind === 'fragment-collage') {
    shapes.push(...buildSonnetFixedGeoShapes(viewport, resolveSonnetFixedGeoVariant(shotSeed), shotSeed));
  }
  /*
   * **几何层的整体旋转**（照抄 folia 的 `geo.rotation` 三行）：
   * 白名单档位（6,8,9,14,15,16,17,20,22,23 与主题档）保持正立，第 8 档按 90° 整数倍转，
   * 其余档转 `(seed × 13) % 360` 度。**只转几何那一批**（`[geoStart, geoEnd)`）——
   * 背景层与固定几何层在原版里是另外两个容器，不跟着转。
   * 搬过来的原版档位在 `sonnetGeo` 里已经转过自己那一份，这里只管兜底的自拟图形。
   */
  if (portedGeo === null && (shot.kind === 'type-impact' || shot.kind === 'fragment-collage')) {
    const rotation = resolveSonnetGeoRotation(resolveSonnetGeoVariant(shotSeed), shotSeed);
    if (rotation !== 0) {
      for (let index = geoStart; index < geoEnd; index += 1) {
        const item = shapes[index];
        if (item === undefined) continue;
        shapes[index] = { ...item, polygon: rotatePolygon(item.polygon, cx, cy, rotation) };
      }
    }
  }
  return shapes;
}

/** 版式：这一镜的每一行摆在哪、字号多大、往哪边入场。 */
function placementFor(
  shot: SonnetShot,
  lineIndex: number,
  lineCount: number,
  paragraphKind: SonnetParagraphKind,
  viewport: SonnetViewport,
): SonnetGlyphPlacementBox {
  const { width, height } = viewport;
  const [enterX, enterY] = SONNET_GLYPH_ENTER_PROGRESS[shot.kind];
  const stack = lineCount <= 1 ? 0 : (lineIndex - (lineCount - 1) / 2) * (height * 0.16);
  switch (shot.kind) {
    case 'editorial-column':
      return {
        x: width * 0.3,
        y: height * 0.5 + stack,
        rotation: 0,
        vertical: false,
        enterX: width * enterX,
        enterY: height * enterY,
        emphasis: false,
      };
    case 'mask-reveal':
      return {
        x: width * 0.5,
        y: height * 0.5 + stack,
        rotation: 0,
        vertical: true,
        enterX: width * enterX,
        enterY: 0,
        emphasis: false,
      };
    case 'tracking-ribbon':
      return {
        x: width * 0.5,
        y: height * 0.5 + stack,
        rotation: -0.06,
        vertical: false,
        enterX: width * enterX,
        enterY: 0,
        emphasis: true,
      };
    case 'poster-blocks':
      return {
        x: lineIndex % 2 === 0 ? width * 0.38 : width * 0.62,
        y: height * 0.44 + stack,
        rotation: 0,
        vertical: false,
        enterX: width * enterX * (lineIndex % 2 === 0 ? 1 : -1),
        enterY: height * enterY,
        emphasis: false,
      };
    case 'fragment-collage':
      return {
        x: width * 0.5,
        y: height * 0.5 + stack,
        rotation: 0,
        vertical: false,
        enterX: width * enterX,
        enterY: height * enterY,
        emphasis: false,
      };
    case 'type-impact':
      return {
        x: width * 0.5,
        y: height * 0.5 + stack,
        rotation: 0,
        vertical: false,
        enterX: width * enterX,
        enterY: height * enterY,
        emphasis: true,
      };
    default:
      return {
        x: width * 0.5,
        y: height * 0.5 + stack,
        rotation: 0,
        vertical: false,
        enterX: width * enterX,
        enterY: height * enterY,
        emphasis: paragraphKind === 'chorus',
      };
  }
}

export interface SonnetFrameInput {
  readonly program: SonnetProgram;
  readonly timeSec: number;
  readonly viewport: SonnetViewport;
  /** 字素宽度；缺省按 `0.62 × 字号` 估算（渲染层可以传真实测量）。 */
  readonly measureGlyph?: (char: string, fontPx: number) => number;
  /**
   * **真实文本测量**（照抄原版：folia 用 `@chenglou/pretext` 真测，不再靠估算系数）。
   * 渲染层用一块离屏 canvas 的 `measureText` 实现它；没给就退回 `estimateSonnetLineWidth`。
   */
  readonly measureTextWidth?: (text: string, fontPx: number, weight: number) => number;
  /** 每个字形在舞台上的颜色（强调字与非强调字各一）。 */
  readonly inkColor: string;
  readonly emphasisColor: string;
  readonly glyphsByLine?: ReadonlyMap<number, readonly SonnetGlyphTiming[]>;
  /**
   * **淡空心巨型背景字**（`ghost`）：参考视频里主角词背后那一层巨大的空心轮廓。
   *
   * 缺省 **false** ⇒ 纯帧的既有调用者（测试、别的入口）保持"不画幽灵字"的行为不变；
   * 主题显式传 true 才把 `ghosts` 折成字形（见下面 `ghosts.length = 0` 那行）。
   */
  readonly showGiantDecorativeText?: boolean;
  /**
   * **时间轴震颤强度**（上游 `updateSonnetShot` 的第 5 个参数）。
   *
   * 缺省 **0**：上游真运行时就是传 0（`createSonnetPixiRuntime.ts:389`），所以我们默认与上游同值 ——
   * 也就是"没有震颤"。留着它是为了将来接真的节拍/能量信号时不用改调用形状。
   */
  readonly shakeIntensity?: number;
  /**
   * **动画强度档**（主题的 `calm` / `normal` / `chaotic` 经 `resolveSonnetAnimationScale` 折算）。
   * 缺省 1（原版 `cameraIntensity` 与 `typographyMotion` 的默认档）。
   * 它同时缩放运镜幅度、轴心混合与逐字入场位移。
   */
  readonly animationScale?: number;
  /**
   * **用户字号缩放**（上游 `options.lyricsFontScale`，即主题的 `tuning.fontScale`）。
   *
   * 它**先**进基准字号的公式、再被 clamp 到 `[24, 112]`（与上游 `sonnetSceneBuilder` 同式）——
   * 所以下游（渲染层设样式、量字号）**不能再乘一次**，否则就是 double scale。
   * 缺省 1（帧层单测与不传该值的调用方保持原样）。
   */
  readonly lyricsFontScale?: number;
}

/** 找到这一刻正在播的镜头（不在任何镜头里就返回 null）。 */
export function findSonnetShot(
  program: SonnetProgram,
  timeSec: number,
): { paragraph: SonnetParagraph; shot: SonnetShot; paragraphIndex: number; shotIndex: number } | null {
  for (let paragraphIndex = 0; paragraphIndex < program.paragraphs.length; paragraphIndex += 1) {
    const paragraph = program.paragraphs[paragraphIndex];
    if (paragraph === undefined) continue;
    /*
     * **段落的有效末端**：上游是「同一时刻只有当前段落那棵场景可见」，并且**一直可见到下一段接管**
     * （`createSonnetPixiRuntime`：`scene.container.visible = index === paragraphIndex`）——
     * 所以段落末尾那段"没有歌词"的尾巴**并非空场**，画的是**本段最后一镜**。
     * 而 `transitionOut.endTime` 正好等于下一段的起点 ⇒ 用它当有效末端即可与上游同构。
     *
     * 不这样做的后果（第 319 轮实测）：段落出口转场落在尾部静默里 ⇒ 我们这边"没有帧可施加"
     * ⇒ **接了线也画不出来**（`命中 0 段／落在静默 2 段`）。
     */
    const transitionEnd = paragraph.transitionOut?.endTime ?? null;
    const paragraphEnd = transitionEnd ?? paragraph.endTime;
    if (timeSec < paragraph.startTime || timeSec > paragraphEnd) continue;
    for (let shotIndex = 0; shotIndex < paragraph.shots.length; shotIndex += 1) {
      const shot = paragraph.shots[shotIndex];
      if (shot === undefined) continue;
      /*
       * **最后一镜留住**到段落有效末端（＝下一段起点）。只在这一段有出场转场时延长，
       * 避免改动"段落内部的静默"这种不属于本条范围的行为。
       */
      const isLastShot = shotIndex === paragraph.shots.length - 1;
      const shotEnd = transitionEnd !== null && isLastShot ? transitionEnd : shot.endTime;
      if (timeSec >= shot.startTime && timeSec <= shotEnd) {
        return { paragraph, shot, paragraphIndex, shotIndex };
      }
    }
  }
  return null;
}

/** 节目表的一行：这一镜是什么构图、什么时候、用哪一档原版几何、那一档搬过来了没有。 */
export interface SonnetShotScheduleEntry {
  readonly kind: SonnetShotKind;
  readonly startTime: number;
  readonly endTime: number;
  readonly geoVariant: number;
  /** **这一镜到底会不会画几何**（只有重镜头的两族会）；不画的那些，档位再"已搬"也没意义。 */
  readonly geoApplies: boolean;
  /** 会画几何、而且那一档搬过来了 —— 取景按这个挑才有东西可看。 */
  readonly geoPorted: boolean;
}

/**
 * 把整首歌的**分镜节目表**连几何档位一起报出来。
 *
 * 用途是**取景**：截图闸门默认只等"最先亮起来的那一镜"，重镜头的原版几何就永远拍不到。
 * 有了这张表，冒烟可以先找"目标构图里几何已搬的那一镜"、seek 过去再拍。
 * 档位算法与 `buildSonnetFrame` 里逐镜算的**完全同一套**（同一个 `shotSeedNumber` 与取档函数），
 * 否则表里写的与画面上画的就会是两回事。
 */
export function describeSonnetShotSchedule(program: SonnetProgram): SonnetShotScheduleEntry[] {
  const entries: SonnetShotScheduleEntry[] = [];
  for (const paragraph of program.paragraphs) {
    for (let shotIndex = 0; shotIndex < paragraph.shots.length; shotIndex += 1) {
      const shot = paragraph.shots[shotIndex];
      if (shot === undefined) continue;
      const shotSeed = shotSeedNumber(`${program.seed}|${shot.id}`, shotIndex);
      const geoApplies = isSonnetHeavyShotKind(shot.kind);
      entries.push({
        kind: shot.kind,
        startTime: shot.startTime,
        endTime: shot.endTime,
        geoVariant: resolveSonnetGeoVariant(shotSeed),
        geoApplies,
        geoPorted: geoApplies && hasSonnetGeoVariant(shotSeed, shotSeed),
      });
    }
  }
  return entries;
}

/**
 * 逐段字号探针的上一份签名（模块级，纯诊断）。
 *
 * 为什么需要：主人反馈"字小"，而字号链上**每一环都已确认与上游一致**（基准公式、倍率表、82% 上限），
 * 出图量到的字高却**连 24px 的下限都不到** —— 说明有一环在下游把字号压小了。
 * 把"基准 → 角色 → 实测 → fitScale → 最终 fontPx"整条打出来，哪一环把 112 变成 20 会直接显形。
 */
let sonnetFontProbeKey = '';

/**
 * 逐字占位的**宽/高比**（相对字号）——按字符类别给，不再一律用拉丁系数。
 *
 * 依据：汉字的步进宽度约等于**字号本身**（全角标点同档），拉丁字母约 0.77，
 * 窄标点更小。帧层自己不再消费它（推挤/缩字那两层已移除），现在只有渲染层的
 * `[pi/sonnet] overlap` 诊断探针用它统计相交对数 —— 那个读数只统计、不改画面，所以留着。
 */
export function sonnetGlyphExtent(char: string): { w: number; h: number } {
  /* 汉字（含扩展 A 区）、全角标点/字母数字、日文假名、韩文音节：宽度按整字算。 */
  const wide = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u30a0-\u30ff\u3040-\u309f\uac00-\ud7af]/.test(
    char,
  );
  if (wide) return { w: 1, h: 1 };
  /* 窄标点与细字母：半宽再打折。 */
  const narrow = /[ .,:;'`|!\[\](){}<>/\\-]/.test(char);
  if (narrow) return { w: 0.34, h: 0.9 };
  /*
   * ⚠ **0.55 → 0.77：这是实测值，不是拍的**。
   * 渲染层的测量探针在冒烟里报 `asciiH100=76.6` —— 即 100px 字号下大写 H 宽 **76.6px**，
   * 也就是 **0.766 倍字号**，而这里原先写的是 0.55（拉丁的"经验系数"）⇒ 盒子比真实窄 28%，
   * 于是"消重叠"的尺子**看不见**西里尔/拉丁字形的相交（主人这首歌正是俄语歌词）。
   * 汉字那一档 1.0 已由 `cjk100=100.0` 实测确认。
   */
  return { w: 0.77, h: 0.92 };
}

/** 展开这一帧。 */
export function buildSonnetFrame(input: SonnetFrameInput): SonnetFrame {
  const { program, timeSec, viewport } = input;
  const found = findSonnetShot(program, timeSec);
  if (found === null) {
    /* 静默期没有语义词组 ⇒ 空焦点读数（`cameraFocus` 与兼容别名 `cameraPlan` 指同一个对象）。 */
    const idleCameraFocus: SonnetCameraFocusFrame = emptySonnetCameraFocus(
      viewport.width / 2,
      viewport.height / 2,
    );
    // 段落之间（静默）什么都不画：外壳背景透出来，这是商籁的"留白"。
    return {
      shotId: '',
      // 静默期没有镜头 ⇒ 给一个正的兜底值，免得下游拿它当除数（图标入场时长那条会除以它）。
      sceneDuration: 1,
      /* 静默期没有镜头 ⇒ 相位锚点退回 0（与 `progress = 0` 一致）。 */
      shotStartTime: 0,
      anchorDelta: { x: 0, y: 0 },
      /* 静默期没有镜头 ⇒ 轴心退回画面中心（与"没有焦点"一致）。 */
      pivot: { x: viewport.width / 2, y: viewport.height / 2 },
      shotKind: 'quiet-tableau',
      paragraphKind: 'break',
      paragraphIndex: -1,
      shotIndex: 0,
      progress: 0,
      rawProgress: 0,
      camera: { x: 0, y: 0, zoom: 1, rotation: 0, breathWeight: 0, revealDoneTime: 0 },
      glyphs: [],
      shapes: [],
      geometryVariant: 0,
      geoVariant: 0,
      geoPorted: false,
      transition: SONNET_IDLE_TRANSITION,
      fallback: false,
      guides: [],
      decor: [],
      textGeo: [],
      /* 静默期没有正文 / 没有 cue ⇒ 空窗口 + 最慢那一档节奏（渲染层取景恒等）。 */
      readingWindow: SONNET_EMPTY_READING_WINDOW,
      rhythm: SONNET_IDLE_RHYTHM_PROFILE,
      /* 静默期没有语义词组 ⇒ 没有焦点（渲染层据此不做平移兜底）。 */
      cameraFocus: idleCameraFocus,
      cameraPlan: idleCameraFocus,
    };
  }
  const { paragraph, shot, paragraphIndex, shotIndex } = found;
  /**
   * 动画强度档（主题的 calm/normal/chaotic）。原版这一层是
   * `tuning.cameraIntensity × 动画强度档 × mod`；帧层只拿得到档位，两个乘数都按 1 处理。
   * 它同时缩放**运镜幅度**、**轴心混合**与**逐字入场位移**。
   */
  const cameraScale = Math.max(0, input.animationScale ?? 1);
  const cueTimes = shot.cues.map((cue) => cue.at);
  const scene = resolveSonnetSceneProgress(timeSec, shot.startTime, shot.endTime, cueTimes);
  const shapes = buildShapes(shot, shotIndex, viewport, program.seed);
  const measure =
    input.measureGlyph ?? ((char: string, size: number) => (/[\u3000-\u9fff\uff00-\uffef]/.test(char) ? size : size * 0.62));

  const glyphs: SonnetGlyphSpec[] = [];
  const lines = paragraph.lines.filter((line) => shot.lineIndices.includes(line.sourceIndex));
  /*
   * 排版角色（数值照抄 folia 的 `sonnetTypographyRoles.ts`）：主角/次主角给 900 字重、装饰 300、其余 700；
   * 角色同时决定"用不用强调色"。我们这边角色是**行级**的（一行字就是一段）。
   */
  /*
   * **按段摊平**（照抄 folia `resolveSonnetTypographyLayout` 开头的 `lines.flat()`）：
   * 原版摆放的粒度是**段（词）**、不是行 —— 每段各自一个盒子、各自量宽高、各自参与流式排版。
   * 行里一个段都没有的极端情况就拿整行当一个段，保证不丢字。
   */
  const segments: SonnetFrameSegment[] = lines.flatMap((line, lineIndex) =>
    (line.segments.length > 0
      ? line.segments
      : [{ text: line.text, startTime: line.startTime, endTime: line.endTime, isWordLike: true, wordIndices: [] }]
    ).map((segment) => ({
      line,
      lineIndex,
      text: segment.text,
      startTime: segment.startTime,
      endTime: segment.endTime,
      isWordLike: segment.isWordLike,
      /*
       * 段的字素区间：段自带 `wordIndices`（指向所属行的字素），直接取首尾即得。
       * 没有索引（整行兜底那一路）时按"覆盖整行"算 —— 这时行级时间轴整条都归它。
       */
      graphemeStart: segment.wordIndices[0] ?? 0,
      graphemeCount:
        segment.wordIndices.length > 0
          ? (segment.wordIndices[segment.wordIndices.length - 1] ?? 0) - (segment.wordIndices[0] ?? 0) + 1
          : [...line.text].length,
    })),
  );
  /** 实词（有字的）段数 —— 原版用它算基准字号。 */
  const shotWordCount = Math.max(
    1,
    segments.filter((segment) => segment.isWordLike && segment.text.trim().length > 0).length,
  );
  /*
   * 基准字号（**照抄 folia `sonnetSceneBuilder` 的公式**）：
   * `clamp(宽 / max(7, 实词数 × 2.15) × 画面系数 × 用户字号缩放, 24, 112)`。
   * 画面系数：重字冲击 ×1.55、静场 ×0.82、其余 ×1；用户字号缩放（上游 `options.lyricsFontScale`，
   * 我们这里由主题把 `tuning.fontScale` 传进来）**必须在这一步就乘进去、并被同一个 clamp 夹住** ——
   * 渲染层不能再乘第二次（那是 double scale，见 `SonnetFrameInput.lyricsFontScale`）。
   *
   * 我们早先写的是"短边 × 0.03"—— 纯推断，算出来约 17px，**比原版下限 24 还低**。
   * 这是成品图上字小到几乎看不见的原因之一。
   */
  const shotFontScale = shot.kind === 'type-impact' ? 1.55 : shot.kind === 'quiet-tableau' ? 0.82 : 1;
  const lyricsFontScale = input.lyricsFontScale ?? 1;
  const baseFontSize = Math.min(
    112,
    Math.max(24, (viewport.width / Math.max(7, shotWordCount * 2.15)) * shotFontScale * lyricsFontScale),
  );
  const heroScale = SONNET_HERO_FONT_SCALE[shot.kind];
  const supportScale = SONNET_SUPPORT_FONT_SCALE[shot.kind];
  /*
   * 排版角色（数值照抄 folia 的 `sonnetTypographyRoles.ts`）：主角/次主角给 900 字重、装饰 300、其余 700；
   * 角色同时决定"用不用强调色"。**粒度是段**：原版是"每一行各选一个主角"（见 `resolveSonnetSegmentRoles`）。
   */
  const roles = resolveSonnetSegmentRoles(
    lines.map((line) =>
      (line.segments.length > 0
        ? line.segments
        : [{ text: line.text, startTime: line.startTime, endTime: line.endTime, isWordLike: true }]
      ).map((segment) => ({
        text: segment.text,
        durationMs: Math.max(0, segment.endTime - segment.startTime) * 1000,
        /* 本轮补：上游主角评选要按 `isWordLike` 排除标点/空白段（字段本就有，原先没传）。 */
        isWordLike: segment.isWordLike,
      })),
    ),
  );
  const segmentRoles = roles.roles;
  /*
   * **变体档位**（照抄 folia 的 `resolveSonnetTypographyLayout` 开头）：
   * `layoutVariantSeed = 这一镜所有片段字数之和 + 片段数`，再按镜头种类各取一档 ——
   * 社论栏 %5、丝带 %3、静场 %4、碎片环 %3。
   * 原版数的是**分词片段**，所以这里用**段**（第 63 轮之前用的还是"行"，已改正）。
   */
  const layoutVariantSeed =
    segments.reduce((sum, segment) => sum + Math.max(1, segment.text.trim().length), 0) + segments.length;
  const variants: SonnetFlowVariants = {
    editorial: layoutVariantSeed % 5,
    ribbon: layoutVariantSeed % 3,
    tableau: layoutVariantSeed % 4,
    collage: layoutVariantSeed % 3,
  };
  /*
   * **主构图锚点 = 整个 shot 拉平之后评分最高的实词片段**（原版 `sonnetTypographyLayout.ts:140`
   * 的 `findSonnetHeroSegmentIndex(segments)`）；逐行选出来的 `heroIndices` 只决定**角色**
   * （谁吃强调字号与颜色）。两者是两个不同的数，都必须保留。
   *
   * ⚠ 变量名沿用 `heroLineIndex`（历史名）：它其实是**片段下标**，`flowBoxes` / `segments` 都用它。
   */
  const heroLineIndex = findSonnetHeroSegmentIndex(
    segments.map((segment) => ({
      text: segment.text,
      durationMs: Math.max(0, segment.endTime - segment.startTime) * 1000,
      isWordLike: segment.isWordLike,
    })),
  );
  /*
   * **双主段（社论栏第 3 档）需要第二个主角**：在非主角里按"主角分 + 距离加成（隔开一段以上 +50）"
   * 挑一个最高分；挑不到就退回第 0 档；第 4 档（Logo 徽章）在只有一段时退回第 2 档 —— 三处都照抄 folia。
   */
  let secondaryHeroIndex = -1;
  if (variants.editorial === 3 && segments.length > 2) {
    let bestScore = Number.NEGATIVE_INFINITY;
    segments.forEach((segment, index) => {
      /*
       * 与上游同判据（`sonnetTypographyLayout.ts:164`）：**与主角同一段、非实词、没有可见字**
       * 的一律不参选 —— 否则标点/空白段也会被选成次主角、再按 3.8 倍放大。
       */
      if (index === heroLineIndex) return;
      if (segment.isWordLike === false) return;
      if (segment.text.trim().length === 0) return;
      const score =
        scoreSonnetHeroLine({ text: segment.text, durationMs: (segment.endTime - segment.startTime) * 1000 }) +
        (Math.abs(index - heroLineIndex) > 1 ? 50 : 0);
      if (score > bestScore) {
        bestScore = score;
        secondaryHeroIndex = index;
      }
    });
    if (secondaryHeroIndex === -1) variants.editorial = 0;
  } else if (variants.editorial === 3) {
    variants.editorial = 0;
  } else if (variants.editorial === 4 && segments.length < 2) {
    variants.editorial = 2;
  }
  /*
   * **整组打包**（照抄 folia 的排版流程）：先把**每一段**量成一个盒子，再一次性摆开。
   *
   * 第 63 轮之前这里是"每行一个盒子"，原版是"每段一个盒子" —— 粒度不对，
   * 所以同一行里的词没法各自换字号/位置。现在粒度对齐了：角色、字号、竖排判定全都按**段下标**走。
   */
  const lineMetrics = segments.map((segment, segmentIndex) => {
    const role = segmentRoles[segmentIndex] ?? 'support';
    const isHero =
      role === 'hero' ||
      (segmentIndex === secondaryHeroIndex &&
        shot.kind === 'editorial-column' &&
        variants.editorial === 3);
    const isSemiHero = role === 'semi-hero' && !isHero;
    const isEmphasized = isHero || isSemiHero;
    /*
     * 每种镜头、每一档的字号倍率（照抄 folia 的 switch）：
     * 社论栏第 3 档 3.8 / 第 4 档 4.2 / 第 2 档 3.2 / 其余 4.0，陪衬 1.3 / 1.25 / 1.2；
     * 其余镜头用我们已有的那张倍率表（重字 5.5、遮罩 4.5、海报 4.4、丝带 3.5、碎片 3.2、静场 3.0）。
     */
    let kindHero = heroScale;
    let kindSupport = supportScale;
    let vertical = false;
    let rotation = 0;
    if (shot.kind === 'editorial-column') {
      if (variants.editorial === 3) {
        kindHero = 3.8;
        kindSupport = 1.3;
      } else if (variants.editorial === 4) {
        kindHero = 4.2;
        kindSupport = 1.25;
        vertical = isEmphasized;
      } else {
        kindHero = variants.editorial === 2 ? 3.2 : 4;
        kindSupport = 1.2;
        vertical = isEmphasized && variants.editorial !== 2;
      }
    } else if (shot.kind === 'fragment-collage') {
      // 碎片环：次主角与每四个里的第一个走竖排。
      vertical = isSemiHero || segmentIndex % 4 === 0;
    } else if (shot.kind === 'mask-reveal') {
      vertical = isEmphasized;
    } else if (shot.kind === 'quiet-tableau') {
      vertical = isEmphasized && (variants.tableau === 0 || variants.tableau === 1);
    }
    const fontScale = isHero
      ? kindHero
      : isSemiHero
        ? Math.max(kindSupport * SONNET_SEMI_HERO_SCALE_BOOST, kindHero * SONNET_SEMI_HERO_SCALE_RATIO)
        : kindSupport;
    /*
     * **非 CJK 的词在竖排里是整块旋转 90°**（照抄 `shouldRotateNonCjkSegment`）：
     * 字母/词组的水平步进在竖排里不成立，所以先把它转平再量尺寸。
     */
    const visibleGraphemes = [...segment.text].filter((char) => char.trim() !== '');
    const rotates = vertical && visibleGraphemes.length > 1 && !SONNET_CJK_TEXT.test(segment.text);
    if (rotates) {
      vertical = false;
      rotation += Math.PI / 2;
    }
    const specRole: SonnetSegmentRole = isHero ? 'hero' : isSemiHero ? 'semi-hero' : 'support';
    const targetFontPx = baseFontSize * fontScale;
    /*
     * 盒子宽度**优先用真实测量**（渲染层给的 canvas `measureText`），拿不到才退回估算。
     * 字重会明显影响拉丁文的宽度，所以测量时要把它带上（原版 pretext 也是按 `fontSpec` 量的）。
     */
    const metricWeight = resolveSonnetRoleWeight(specRole);
    /*
     * ⚠ **必须查有限性**：渲染层的测量实现在拿不到 canvas 上下文时**返回 `Number.NaN`**
     * （`SonnetTheme.tsx` 的 `measureTextWidth`），而 `??` 只认 `null`/`undefined` ——
     * 于是 NaN 会一路传下去：盒宽 NaN ⇒ `measuredWidth > maxW` 为假 ⇒ **字号夹取失效（字大得离谱）**、
     * 落点 NaN ⇒ **字全堆在一起**。这两条正好就是主人报的"字交叉"与"有些字太大"。
     * 这里统一按"量不到就不用它"处理：非有限值一律退回估算。
     */
    const measureWidth = (text: string, fontPx: number): number => {
      const measured = input.measureTextWidth?.(text, fontPx, metricWeight);
      return measured !== undefined && Number.isFinite(measured) && measured > 0
        ? measured
        : estimateSonnetLineWidth(text, fontPx);
    };
    const advance = measureWidth(segment.text, targetFontPx);
    /*
     * 量盒子（照抄 folia）：旋转块按"竖着的尺寸"量、竖排按"每字步进 0.9 倍字号"算列高、
     * 横排用真实行高 1.2 倍字号。原版用 `@chenglou/pretext` 真测；我们的 `advance` 按字种估（有真测就用真测）。
     *
     * 第 74 轮起**两种取向都量**（原版就是这样：盒子上同时带着横排尺寸与竖排尺寸，
     * 由排版器决定最终用哪一套 —— 海报方块那族排版要靠这个换取向）：
     *   · CJK 竖排：宽 = 最宽的一个字，高 = 字数 × 0.9 倍字号（逐字往下摞）；
     *   · 非 CJK 竖排：整块**转 90°**，所以宽 = 1.2 倍字号、高 = 横向步进。
     */
    const cjkText = SONNET_CJK_TEXT.test(segment.text);
    const widestGlyph = [...segment.text].reduce(
      (max, char) => Math.max(max, measureWidth(char, targetFontPx)),
      targetFontPx,
    );
    const verticalModeWidth = cjkText ? widestGlyph : targetFontPx * 1.2;
    const verticalModeHeight = cjkText
      ? Math.max(1, [...segment.text].length) * targetFontPx * SONNET_CJK_COLUMN_STEP
      : advance;
    let measuredWidth: number;
    let measuredHeight: number;
    if (vertical || rotates) {
      measuredWidth = verticalModeWidth;
      measuredHeight = verticalModeHeight;
    } else {
      measuredWidth = advance;
      measuredHeight = targetFontPx * SONNET_HEIGHT_PER_FONT;
    }
    // 82% 安全边界：超了就整体缩（照抄 folia 的 fitScale 算法）。
    const maxW = viewport.width * SONNET_FIT_MAX_RATIO;
    const maxH = viewport.height * SONNET_FIT_MAX_RATIO;
    const fitScale = Math.min(
      1,
      measuredWidth > maxW ? maxW / measuredWidth : 1,
      measuredHeight > maxH ? maxH / measuredHeight : 1,
    );
    /*
     * **海报竖排备选尺寸**（照抄 `sonnetTypographyLayout.ts:302~326`）：只有**海报镜头 + CJK 段**
     * 才给。用**已 fit 的字号**逐字测宽、行步进 0.9 倍字号，再整体过一次 82% 上限（`verticalFit`）；
     * `verticalFontScale = (fit 后字号 / 基准字号) × verticalFit`。英文段三项保持 `undefined`
     * ⇒ 海报排版里的 `measure` 拿不到竖排尺寸，只能走正常词块（不会把字母按列直立改写）。
     */
    let posterVerticalWidth: number | undefined;
    let posterVerticalHeight: number | undefined;
    let posterVerticalFontScale: number | undefined;
    if (shot.kind === 'poster-blocks' && cjkText) {
      const fitFontPx = targetFontPx * fitScale;
      const columnChars = [...segment.text];
      const glyphAdvances = columnChars
        .filter((char) => char.trim() !== '')
        .map((char) => Math.max(fitFontPx * 0.2, measureWidth(char, fitFontPx)));
      let columnWidth = glyphAdvances.length > 0 ? Math.max(...glyphAdvances) : fitFontPx;
      let columnHeight = Math.max(1, columnChars.length) * fitFontPx * SONNET_CJK_COLUMN_STEP;
      const verticalFit = Math.min(1, maxW / columnWidth, maxH / columnHeight);
      columnWidth *= verticalFit;
      columnHeight *= verticalFit;
      posterVerticalWidth = columnWidth;
      posterVerticalHeight = columnHeight;
      posterVerticalFontScale = (fitFontPx / Math.max(0.001, baseFontSize)) * verticalFit;
    }
    return {
      role: specRole,
      isHero,
      isSemiHero,
      isEmphasized,
      vertical,
      rotation,
      fontPx: targetFontPx * fitScale,
      measuredWidth: measuredWidth * fitScale,
      measuredHeight: measuredHeight * fitScale,
      verticalFontScale: posterVerticalFontScale,
      verticalMeasuredWidth: posterVerticalWidth,
      verticalMeasuredHeight: posterVerticalHeight,
    };
  });
  const flowBoxes: SonnetFlowBox[] = segments.map((_segment, index) => {
    const metric = lineMetrics[index];
    return {
      index,
      isHero: metric?.isHero ?? false,
      isSemiHero: metric?.isSemiHero ?? false,
      fontScale: (metric?.fontPx ?? baseFontSize) / Math.max(0.001, baseFontSize),
      measuredWidth: metric?.measuredWidth ?? baseFontSize,
      measuredHeight: metric?.measuredHeight ?? baseFontSize,
      /* 三项可选：只有「海报 + CJK」会给全；缺省 ⇒ 海报排版 `measure` 走正常词块（见 b 条）。 */
      verticalFontScale: metric?.verticalFontScale,
      verticalMeasuredWidth: metric?.verticalMeasuredWidth,
      verticalMeasuredHeight: metric?.verticalMeasuredHeight,
      vertical: metric?.vertical ?? false,
      layoutDirection: 'horizontal',
      rotation: metric?.rotation ?? 0,
      x: 0,
      y: 0,
      enterX: 0,
      enterY: 0,
    };
  });
  const flowGaps = resolveSonnetFlowGaps(baseFontSize);
  const flowApplied = applySonnetFlowLayout(
    shot.kind,
    {
      boxes: flowBoxes,
      heroIndex: heroLineIndex,
      width: viewport.width,
      height: viewport.height,
      flowGap: flowGaps.flowGap,
      stackGap: flowGaps.stackGap,
    },
    variants,
    secondaryHeroIndex,
  );
  // 主角从画面下方 15% 处升起（照抄 folia：`heroBox.enterX = 0; enterY = height × 0.15`）。
  const heroBox = flowBoxes[heroLineIndex];
  if (flowApplied && heroBox !== undefined) {
    heroBox.enterX = 0;
    heroBox.enterY = viewport.height * SONNET_HERO_ENTER_DROP;
  }

  /*
   * **每段的最终字号 = 基准字号 × 流程盒的 `fontScale`**（后者已含 `fitScale` 与
   * `applySonnetFlowLayout` 的全局缩放阶梯 / 各分支的字号改写）。
   *
   * ⚠ 这条修的正是 A：以前流程分支仍用 `metric.fontPx`（**没吃** `box.fontScale`），
   * 于是字块被缩了、字形却按原字号画 —— 排版与渲染脱节。上游
   * `sonnetTextViewBuilder.ts:114` 是 `fontSize = options.baseFontSize * placement.fontScale`。
   * 没有盒子的兜底路径才回落到排版度量值。
   */
  const finalFontPxBySegment = segments.map((_segment, index) => {
    const box = flowBoxes[index];
    return box === undefined
      ? (lineMetrics[index]?.fontPx ?? baseFontSize)
      : baseFontSize * box.fontScale;
  });

  /**
   * **巨大幽灵字**（照抄 folia：**打包完**之后才把"主角的影子"塞到盒子列表最前面）。
   *
   * 这是实录里最抢眼的那一层：同一个词以 2.8~5.5 倍主角字号、带 -0.15 弧度压在背景上，
   * 每多一个主角就多一层（往左下错开、弧度交替 ±0.05）；另外再补一个"远处的"幽灵
   * （1.8~3.5 倍、弧度 +0.08、落在主角右下 25%/15% 处）。
   *
   * 第 63 轮起**幽灵复制的也是一段词**（原版如此）：之前粒度是行，注释里一直标着这条差异。
   */
  interface SonnetGhostSpec {
    text: string;
    line: SonnetFrameLine;
    startTime: number;
    endTime: number;
    graphemeStart: number;
    graphemeCount: number;
    fontScale: number;
    x: number;
    y: number;
    rotation: number;
    enterX: number;
    enterY: number;
  }
  const ghosts: SonnetGhostSpec[] = [];
  if (flowApplied && shot.kind !== 'quiet-tableau' && shot.kind !== 'poster-blocks') {
    const heroBoxes = flowBoxes.filter((box) => box.isHero);
    heroBoxes.forEach((box, index) => {
      const source = segments[box.index];
      if (source === undefined) return;
      ghosts.push({
        text: source.text,
        line: source.line,
        startTime: source.startTime,
        endTime: source.endTime,
        graphemeStart: source.graphemeStart,
        graphemeCount: source.graphemeCount,
        fontScale: Math.max(2.8, Math.min(box.fontScale * 3.5, 5.5)),
        x: box.x - viewport.width * (0.1 - index * 0.03),
        y: box.y - viewport.height * (0.05 - index * 0.02),
        rotation: -0.15 + (index % 2 === 0 ? 0 : 0.05),
        enterX: -viewport.width * 0.05,
        enterY: -viewport.height * 0.05,
      });
    });
    const firstHero = heroBoxes[0];
    if (flowBoxes.length > 1 && firstHero !== undefined) {
      const lastBox = flowBoxes[flowBoxes.length - 1];
      const decoy = lastBox !== undefined && lastBox.isHero ? flowBoxes[0] : lastBox;
      const source = decoy === undefined ? undefined : segments[decoy.index];
      if (source !== undefined) {
        ghosts.push({
          text: source.text,
          line: source.line,
          startTime: source.startTime,
          endTime: source.endTime,
          graphemeStart: source.graphemeStart,
          graphemeCount: source.graphemeCount,
          fontScale: Math.max(1.8, Math.min(firstHero.fontScale * 2.2, 3.5)),
          x: firstHero.x + viewport.width * 0.25,
          y: firstHero.y + viewport.height * 0.15,
          rotation: 0.08,
          enterX: viewport.width * 0.05,
          enterY: viewport.height * 0.05,
        });
      }
    }
  }
  /**
   * 这一帧要画的**所有"字串"**：幽灵字在前（folia 也是把它们 `unshift` 到最前，所以压在主角字之下），
   * 然后是每一行的盒子。每个字串自带字号、书写模式与摆放点。
   */
  interface SonnetGlyphRun {
    line: SonnetFrameLine;
    text: string;
    startTime: number;
    endTime: number;
    graphemeStart: number;
    graphemeCount: number;
    fontPx: number;
    vertical: boolean;
    /** 这一段是不是**词形**（上游 `segment.isWordLike`）：词级几何的资格条件之一。 */
    isWordLike: boolean;
    /**
     * **盒子在流程里的摞向**（`SonnetFlowBox.layoutDirection`）。
     *
     * ⚠ 与 `vertical`（"字怎么排"）**是两个概念**：半主角回声沿"版面法向"分离，上游
     * `sonnetTextViewBuilder.ts:183` 的 `ghostNormal` 取的是 **`layoutDirection`**，
     * 不是书写模式 —— 中文字竖排与词块纵向排列不能混用（见 f 条）。
     */
    flowDirection: 'horizontal' | 'vertical';
    rotation: number;
    x: number;
    y: number;
    enterX: number;
    enterY: number;
    emphasis: boolean;
    role: SonnetSegmentRole;
    /**
     * 该段的**逐字追踪点**（对齐上游 `trackingGlyphs`：每个字带落点、开始与落位时刻）。
     * 镜头焦点要的是"段内也沿时间轴推进"，所以给到字级、不能只给段中心。
     * 在 `buildSonnetGlyphLayout` 之后填充；取不到时焦点退回段自身的落点。
     *
     * `settleTime` 逐字保留：词级几何（`sonnetTextGeoFrames.ts`）按**第一个字形**的
     * `startTime / settleTime` 驱动，不能拿段的 `endTime` 顶替落位时刻。
     *
     * ⚠ **这里只放排版解出来的最终落点与 cue 时刻**（`baseX/baseY/startTime/settleTime`）。
     * 上一版还把 `motionX/motionY/readable/entryProgress` 抄进来喂给焦点，结果每一粒字入场
     * 都会顶一下镜头（用户录屏"每个字冒出来镜头抖一次"）。本轮起**入场运动不再进焦点**，
     * 这几个字段随之删除；渲染用的逐字位移仍在下面的 `glyphs.push` 里，照常出画。
     */
    tracking?: {
      baseX: number;
      baseY: number;
      /** 落位右缘（画布像素 x）—— 见 `SonnetCameraFocusGlyph.edgeX`。 */
      edgeX: number;
      startTime: number;
      settleTime: number;
    }[];
    /**
     * 这一段的**真实唱词时段**（首字开始 → 末字唱完）。来自逐字 cue（`glyphsByLine` 按段切片），
     * 没有逐字轴时是段内均分。阅读窗口与唱词节奏只认这两个数。
     */
    cueStartTime?: number;
    cueEndTime?: number;
  }
  const runs: SonnetGlyphRun[] = [];
  /*
   * **巨型幽灵字**（`ghosts`）：参考视频里主角词背后那层"淡的空心大轮廓"。
   *
   * 开关是 `showGiantDecorativeText`（缺省 false ⇒ 不画，纯帧既有调用者行为不变；主题传 true）。
   * 它们**单独放一条 `ghostRuns`**，不混进 `runs`：`runs` 的下标同时被引导线、跟拍焦点、
   * 歌词火花与装饰边框的取档哈希消费，混进去会把正文那一层全部挪位。
   * 幽灵字串仍标 `role: 'decoration'` ⇒ 不参与跟拍/正文包围盒/色差/回声/光晕（见下面字形循环）。
   */
  const ghostRuns: SonnetGlyphRun[] = [];
  if (input.showGiantDecorativeText !== true) ghosts.length = 0;
  for (const ghost of ghosts) {
    ghostRuns.push({
      line: ghost.line,
      text: ghost.text,
      startTime: ghost.startTime,
      endTime: ghost.endTime,
      graphemeStart: ghost.graphemeStart,
      graphemeCount: ghost.graphemeCount,
      fontPx: baseFontSize * ghost.fontScale,
      vertical: false,
      /* 幽灵字**不是**词形（词级几何的命中条件之一 ⇒ 它天然被排除 ✓）。 */
      isWordLike: false,
      flowDirection: 'horizontal',
      rotation: ghost.rotation,
      x: viewport.width / 2 + ghost.x,
      y: viewport.height / 2 + ghost.y,
      enterX: ghost.enterX,
      enterY: ghost.enterY,
      emphasis: false,
      role: 'decoration',
    });
  }
  segments.forEach((segment, segmentIndex) => {
    const metric = lineMetrics[segmentIndex];
    const box = flowBoxes[segmentIndex];
    const role = metric?.role ?? 'support';
    const lineFontPx = metric?.fontPx ?? baseFontSize;
    if (flowApplied && box !== undefined) {
      /*
       * **流程图版是在"以原点为中心"的坐标系里摆的**：`sonnetFlowLayouts` 的所有分支都先 `heroBox.x = 0`，
       * 由 `placeWithGlobalFit` 用 `|box.x| ≤ 宽 × 0.48` 判断有没有出界。所以这里必须把整组搬到画面中心 ——
       * 少了这一步，字会整齐地堆在画布左上角**外面**（实测首帧首字位置 `-267,0`）。
       * 兜底分支（`placementFor`）本来就是画面坐标，不参与这次平移。
       *
       * 书写模式取 `box.vertical`（**不是** `layoutDirection`）：前者是"字怎么排"，后者是"盒子往哪个方向摞"，
       * 原版把它俩分开，我们早先混用过一次。
       */
      runs.push({
        line: segment.line,
        text: segment.text,
        startTime: segment.startTime,
        endTime: segment.endTime,
        graphemeStart: segment.graphemeStart,
        graphemeCount: segment.graphemeCount,
        /* 最终字号取**流程盒**的值（已含 fitScale 与全局缩放阶梯），不是排版度量那一份。 */
        fontPx: finalFontPxBySegment[segmentIndex] ?? baseFontSize,
        vertical: box.vertical,
        isWordLike: segment.isWordLike,
        flowDirection: box.layoutDirection,
        rotation: box.rotation,
        x: viewport.width / 2 + box.x,
        y: viewport.height / 2 + box.y,
        enterX: box.enterX,
        enterY: box.enterY,
        emphasis: metric?.isEmphasized ?? false,
        role,
      });
      return;
    }
    const fallback = placementFor(shot, segmentIndex, segments.length, paragraph.kind, viewport);
    runs.push({
      line: segment.line,
      text: segment.text,
      startTime: segment.startTime,
      endTime: segment.endTime,
      graphemeStart: segment.graphemeStart,
      graphemeCount: segment.graphemeCount,
      fontPx: lineFontPx,
      vertical: fallback.vertical,
      isWordLike: segment.isWordLike,
      /* 兜底摆放没有流程盒 ⇒ 摞向按横排算。 */
      flowDirection: 'horizontal',
      rotation: fallback.rotation,
      x: fallback.x,
      y: fallback.y,
      enterX: fallback.enterX,
      // 主角从画面下方 15% 处升起（照抄 folia：`heroBox.enterX = 0; enterY = height × 0.15`）。
      enterY: role === 'hero' ? viewport.height * SONNET_HERO_ENTER_DROP : fallback.enterY,
      emphasis: isSonnetEmphasisRole(role),
      role,
    });
  });

  /*
   * 这里原来有"**同一段词只画一次**"的去重循环（按 `${run.text}|${run.line}` 去重）—— 已删除。
   *
   * 两条理由：① 那个 key 把 `line`（对象）拼进字符串 ⇒ 恒为 `[object Object]`，同一个 shot 里
   * **两处真正相同的歌词会被误删**（例如 "you said you would be there" 的两个 you）；
   * ② 它本来是为"拼贴陪衬会再抄一遍同一段词"服务的，而幽灵字（唯一的 `decoration` 字串来源）
   * 走单独的 `ghostRuns`（见上）⇒ `runs` 里每个元素就是一个真实 segments，不需要按文本去重。
   */

  /*
   * 这里原来是"消重叠"那一整套（段级与逐字推挤、缩字号兜底、整组收边缩放、逐字夹回画布、
   * 整组重新居中），已删除：它把同一个词里的字推到不同位置、把字号压平，而原版每帧不做去重叠、
   * 也允许字出血。现在这一层只剩**单词/片段尺寸约束**（`fitScale`，见下面 `maxW/maxH`）
   * 与 `sonnetFlowLayouts` 的整组适配。
   */

  /* 幽灵字串在前（压在主角字之下），其余诊断/焦点仍只吃 `runs`（正文）。 */
  const drawRuns: readonly SonnetGlyphRun[] = ghostRuns.length > 0 ? [...ghostRuns, ...runs] : runs;
  /*
   * **唱词时间轴**（真实逐字 cue）：节奏（局部密度 / 长音 / 空档）与阅读窗口的"当前块"都从这里来。
   * 只收正文 —— `role === 'decoration'` 的幽灵字是**故意出血的背景装饰**，不进节奏、也不进取景 guard ✓。
   */
  const cueTimeline: SonnetRhythmCue[] = [];
  for (const run of drawRuns) {
    const placement: SonnetGlyphPlacementBox = {
      x: run.x,
      y: run.y,
      rotation: run.rotation,
      vertical: run.vertical,
      enterX: run.enterX,
      enterY: run.enterY,
      emphasis: run.emphasis,
    };
    /*
     * **按段裁剪行级时间轴**：`glyphsByLine` 里存的是**整行每个字素**的时间，
     * 而这里摆的是一段词 —— `resolveSonnetGlyphTimings` 拿到 `provided` 会原样返回、不按 `text` 裁，
     * 所以必须自己切到本段的字素区间（`graphemeStart` / `graphemeCount`）。
     */
    const providedAll = input.glyphsByLine?.get(run.line.sourceIndex);
    const provided =
      providedAll === undefined
        ? undefined
        : providedAll.slice(run.graphemeStart, run.graphemeStart + run.graphemeCount);
    // 逐字时间轴按**段**的起止算（有逐字轴就用它，没有就段内均分）——比"整行均分"更贴近原版。
    const timings = resolveSonnetGlyphTimings(run.text, run.startTime, run.endTime, provided);
    /*
     * **这一段自己的真实唱词时段**（首字开始 → 末字唱完），以及逐字 cue 汇总。
     * ⚠ 节奏与阅读窗口都**不再**按整个 paragraph / 整镜的归一进度等比例推进，只吃这两个真值 ✓。
     */
    run.cueStartTime = timings[0]?.startTime ?? run.startTime;
    run.cueEndTime = timings.at(-1)?.endTime ?? run.endTime;
    if (run.role !== 'decoration') {
      for (const timing of timings) cueTimeline.push({ startTime: timing.startTime, endTime: timing.endTime });
    }
    const placed = buildSonnetGlyphLayout(
      timings,
      placement,
      run.fontPx,
      // 逐字步进同样优先走真实测量（字重会影响拉丁字的宽度）。
      (char) => {
        /* 同上：非有限的测量值一律退回估算（NaN 会让逐字步进全变成 NaN）。 */
        const measured = input.measureTextWidth?.(char, run.fontPx, resolveSonnetRoleWeight(run.role));
        return measured !== undefined && Number.isFinite(measured) && measured > 0
          ? measured
          : measure(char, run.fontPx);
      },
      { startTime: shot.startTime, endTime: shot.endTime },
    );
    /*
     * 记下该段的**逐字追踪点**（原版 `trackingGlyphs`：每个字带落点、开始与落位时刻）——
     * 就是排版解出来的真实落点与真实 `settleTime`，与字形自己用的完全同一份。
     */
    run.tracking = placed
      .filter((item) => item.char.trim() !== '')
      .map((item) => ({
        baseX: item.baseX,
        baseY: item.baseY,
        edgeX: item.edgeX,
        startTime: item.startTime,
        settleTime: item.settleTime,
      }));
    /* 版面法向与回声的确定性左右侧：半主角回声沿法向分离，方向按这一段的文本定死。 */
    const layoutNormal = resolveSonnetLayoutNormal(run.flowDirection === 'vertical', run.rotation);
    const echoSide = hash01(`${run.text}|${run.line.sourceIndex}`, 77) > 0.5 ? 1 : -1;
    /** 这一串是不是巨型幽灵字（`decoration`）—— 决定下面要不要把色差/回声/光晕归零。 */
    const isGhostRun = run.role === 'decoration';
    for (const glyph of placed) {
      if (glyph.char.trim() === '') continue;
      /*
       * 逐字运动（入场 / 色差 / 回声）全部由纯函数一次算好：
       * 没轮到的字 α = 0，入场 `0.16 → 1`、缩放 `0.86 → 1`（`type-impact` 强调字 `0.52 → 1`），
       * 位移 `enter × (1 − p)`，旋转 = 版式角度 + 入场偏转；**只有入场、没有退场**。
       */
      const motion = resolveSonnetGlyphMotion({
        startTime: glyph.startTime,
        settleTime: glyph.settleTime,
        time: timeSec,
        finalRotation: run.rotation,
        entryRotation: glyph.entryRotation,
        enterX: glyph.enterX,
        enterY: glyph.enterY,
        emphasis: run.emphasis,
        shotKind: shot.kind,
        role: run.role,
        fontPx: run.fontPx,
        normal: layoutNormal,
        shotDuration: shot.endTime - shot.startTime,
        echoSide,
        motion: cameraScale,
      });
      /*
       * ⚠ 这支 `motion` 的结果**只进画面**（`deltaX/deltaY/alpha/scale/…`，见下面的 `glyphs.push`），
       * **不再写回 `run.tracking`**：焦点只吃最终落点与 cue 时刻，入场运动与镜头无关
       * （本轮纠正"每粒字入场就顶一下镜头"，见 `sonnetCameraFocus.ts`）。
       */
      glyphs.push({
        char: glyph.char,
        text: glyph.char,
        /* 落点就是排版解出来的位置（不再有推挤、缩字、夹回画布、整组收边）。 */
        x: glyph.baseX,
        y: glyph.baseY,
        fontPx: run.fontPx,
        /* 逐字 cue 开始时刻（探针 / 验收用，见字段注释）。 */
        startTime: glyph.startTime,
        /* 落位右缘（"显现前沿"的度量口径，见字段注释）。 */
        edgeX: glyph.edgeX,
        deltaX: motion.offsetX,
        deltaY: motion.offsetY,
        rotation: motion.rotation,
        /* 取景用的恒定落位角（见字段注释）：`rotation` 含入场偏转，会逐帧变。 */
        layoutRotation: run.rotation,
        /* `SONNET_GLYPH_ALPHA` 是主题层的全局系数（当前 1），上游同一层的 `motion` 倍率同义。 */
        alpha: motion.alpha * SONNET_GLYPH_ALPHA,
        scale: motion.scale,
        /*
         * **幽灵字不发光、不色差、不回声**：它是背景上的一层淡空心轮廓（渲染层另有 α 0.2），
         * 把这三组量直接归零 —— 面板数值本身就是"画不画"的判据，渲染层不用再判类型。
         * （回声包络对 `decoration` 本来就恒 0，这里显式写死只是让这条契约在数据上可见。）
         */
        haloScale: motion.haloScale,
        haloAlpha: isGhostRun ? 0 : motion.haloAlpha,
        caOffset: isGhostRun ? 0 : motion.caOffset,
        caCopyAlpha: isGhostRun ? 0 : motion.caCopyAlpha,
        echoActive: isGhostRun ? false : motion.echoActive,
        echoProgress: isGhostRun ? 0 : motion.echoProgress,
        echoDuration: motion.echoDuration,
        echoAlpha1: isGhostRun ? 0 : motion.echoAlpha1,
        echoAlpha2: isGhostRun ? 0 : motion.echoAlpha2,
        echoOffset1X: motion.echoOffset1X,
        echoOffset1Y: motion.echoOffset1Y,
        echoOffset2X: motion.echoOffset2X,
        echoOffset2Y: motion.echoOffset2Y,
        emphasis: run.emphasis,
        weight: resolveSonnetRoleWeight(run.role),
        /*
         * **用户本轮（对照 folia 录屏）**：字身一律用常态墨色（白），**强调色只走发光层**。
         *
         * 改造前这里是 `run.emphasis ? emphasisColor : inkColor` —— 主角/次主角整串填 accent。
         * 同一首歌两段录屏里，folia 的大字是**白的**、只有外面那圈光是彩的；我们的大字整块蓝。
         * 上游文案 `.folia-ref/zh-CN.ts:3032` 写得很清楚：
         * 「accentColor = 高亮、按钮与**歌词发光颜色**」—— accent 是**发光**用的，不是字身。
         * 所以字身统一给 ink（`--pi-lyric-ink` = 白），发光层的颜色在 `SonnetTheme.tsx` 里单独给。
         */
        color: input.inkColor,
        ghost: run.role === 'decoration',
      });
    }
  }

  /*
   * **阅读块**（本轮取景语义纠正）：正文的每个 run（词 / 短句）→ 一块，
   * 带**真实唱词时段**（`cueStartTime/EndTime`）与**落位四至**（逐字落点 ± 半个字身）。
   *
   * 取景与节奏只吃这些块：
   * · 窗口 = "当前正在唱的块 + 前后近邻块"（`sonnetReadingWindow.ts` 连续加权）；
   * · 幽灵字（`role === 'decoration'`）**不进** —— 它是故意出血的背景装饰 ✓。
   * 半边长按 `0.55 × 字号` 估（CJK 字身约 1em、竖排步进 0.9em 都覆盖得住），
   * 这只是取景的软依据，不做硬包含，所以估算足够。
   *
   * **焦点块**（`sonnetCameraFocus.ts`）与阅读块同源但**区间口径不同**：焦点区间取段内
   * **首 / 末字的开始唱时刻**（与参考源码 `resolveShotTracking` 的 focus range 一致），
   * 阅读窗口仍用"首字开始 → 末字唱完"（它算的是"此刻该读的上下文有多大"）。
   * 另外焦点块**逐字带最终落点 + 开始唱时刻**：段内中心由"此刻唱到哪一粒"在一段宽时间窗里
   * 连续算出，所以长句 / 竖排长列不会在首字刚出现时就把构图甩到远端。
   * ⚠ 焦点块**只收排版落点与 cue 时刻**，不收逐字入场运动（那是上一版镜头抖动的根因）。
   */
  const readingBlocks: SonnetReadingBlock[] = [];
  const focusBlocks: SonnetCameraFocusBlock[] = [];
  for (const run of runs) {
    if (run.role === 'decoration') continue;
    const points = run.tracking ?? [];
    if (points.length === 0) continue;
    const pad = run.fontPx * SONNET_READING_BLOCK_PAD_RATIO;
    let blockMinX = Number.POSITIVE_INFINITY;
    let blockMinY = Number.POSITIVE_INFINITY;
    let blockMaxX = Number.NEGATIVE_INFINITY;
    let blockMaxY = Number.NEGATIVE_INFINITY;
    /*
     * **逐字构图点**（焦点块用）：每粒字的**最终落点**与**开始唱时刻** —— 就这两样。
     * 焦点靠它们沿时间轴平滑推进（窗口比字距宽 ⇒ 低频），入场位移 / α / 入场进度一概不进。
     */
    const focusGlyphs: SonnetCameraFocusGlyph[] = [];
    for (const point of points) {
      if (!Number.isFinite(point.baseX) || !Number.isFinite(point.baseY)) continue;
      blockMinX = Math.min(blockMinX, point.baseX - pad);
      blockMaxX = Math.max(blockMaxX, point.baseX + pad);
      blockMinY = Math.min(blockMinY, point.baseY - pad);
      blockMaxY = Math.max(blockMaxY, point.baseY + pad);
      if (Number.isFinite(point.startTime)) {
        focusGlyphs.push({
          x: point.baseX,
          y: point.baseY,
          startTime: point.startTime,
          /* 落位右缘：屏幕上的"显现前沿"按它算（中心 + 半字身口径见 `sonnetCameraFocus.ts`）。 */
          edgeX: point.edgeX,
        });
      }
    }
    if (!Number.isFinite(blockMinX) || !Number.isFinite(blockMaxX)) continue;
    const blockStart = run.cueStartTime ?? run.startTime;
    const blockEnd = Math.max(blockStart + 0.05, run.cueEndTime ?? run.endTime);
    const blockCenterX = (blockMinX + blockMaxX) / 2;
    const blockCenterY = (blockMinY + blockMaxY) / 2;
    readingBlocks.push({
      text: run.text,
      startTime: blockStart,
      endTime: blockEnd,
      lineIndex: run.line.sourceIndex,
      isWordLike: run.isWordLike,
      charCount: points.length,
      centerX: blockCenterX,
      centerY: blockCenterY,
      minX: blockMinX,
      minY: blockMinY,
      maxX: blockMaxX,
      maxY: blockMaxY,
    });
    /* 空白段（英文空格那类）不吸引焦点；标点段跟着自己的中心参与，不做特殊剔除。 */
    if (run.text.trim().length === 0) continue;
    const firstStart = points[0]?.startTime ?? blockStart;
    const lastStart = points[points.length - 1]?.startTime ?? blockEnd;
    focusBlocks.push({
      startTime: Math.min(firstStart, lastStart),
      endTime: Math.max(firstStart, lastStart),
      centerX: blockCenterX,
      centerY: blockCenterY,
      /* 落位四至：只给焦点层的**水平长句判据**用（"这一段横着铺开了多宽"）——是排版事实，不随入场变。 */
      minX: blockMinX,
      minY: blockMinY,
      maxX: blockMaxX,
      maxY: blockMaxY,
      /* 逐字构图点：**最终落点 + 开始唱时刻**，段内沿时间轴低频推进（见 sonnetCameraFocus.ts）。 */
      glyphs: focusGlyphs,
    });
  }
  /*
   * **唱词时间轴节奏**（不是音频 BPM，见 `sonnetMotion.ts` 的口径声明）：
   * 密唱增大预测提前量与词组融合范围、收住呼吸；长音 / 空档让焦点更集中、呼吸放开。
   * 节奏与预测焦点都由真实 cue 和绝对时刻决定，seek / 帧率无关。
   */
  const rhythm = resolveSonnetRhythmProfile(cueTimeline, timeSec);
  /** 此刻的阅读窗口（渲染层的**缩放**依据，不再拿整镜 glyphs 做硬约束）。 */
  const readingWindow = resolveSonnetReadingWindow(readingBlocks, timeSec, {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  });
  /*
   * **镜头该看哪几段**（原版 `resolveShotTracking`）：先只留非装饰、且有追踪字的段，
   * 一段都没有时放宽到"有追踪字的段"；`revealDoneTime` 取这些段**各自最后一个追踪字的 startTime**
   * 的最大值（没有追踪字时退回 `shot.endTime`），焦点时段取"段内首/末追踪字的开始时间"。
   * ⚠ 不能拿段的说话窗口起点或落位时间（`settleTime`）当锚点：前者太早（呼吸会早于最后一个字）、
   * 后者太晚。
   *
   * ⚠ **它在焦点之前**：`revealDoneTime` 是运镜（呼吸渐入）的输入，而本帧的**实际世界缩放**要做
   * 预排构图的屏幕锚定输入 ⇒ 运镜必须先算出来（见下面 `frameCamera`）。
   */
  const primaryTrackRuns = runs.filter(
    (run) => run.role !== 'decoration' && (run.tracking?.length ?? 0) > 0,
  );
  const trackRuns =
    primaryTrackRuns.length > 0
      ? primaryTrackRuns
      : runs.filter((run) => (run.tracking?.length ?? 0) > 0);
  const revealDoneTime =
    trackRuns.length > 0
      ? Math.max(...trackRuns.map((run) => run.tracking?.at(-1)?.startTime ?? shot.endTime))
      : shot.endTime;

  /**
   * **本帧运镜**（原版 `updateSonnetShot` 那一套，四层叠加）：
   * 路径曲线（`resolveShotMotionFrame`）→ 空档漂移 → 时间轴震颤 → 手势呼吸，
   * 最后整体乘动画强度档 `scale`：
   *   `x/y = (frame + shake) × scale`、`zoom = shot.camera.zoom × (1 + (frame.scale − 1) × scale)`、
   *   `rotation = (shot.camera.rotation + frame.rotation + shake.rotation) × scale`。
   * 没有额外的撞击反移、也没有段落衔接的镜位退让 —— 镜头的位移只由时间决定。
   *
   * ⚠ 提前到焦点之前算：水平长句的屏幕锚定要用**本帧实际世界缩放**（`zoom`）与**取景锚点**
   * （`W × (0.5 + shot.camera.x)`）。用近似值（例如"本镜最大缩放"）会让屏幕比例差出好几个
   * 百分点，实测就是"加了锚定但红线还是偏左"。这一步是纯函数、只吃绝对时间与运镜参数，
   * 拿到前面算不改变任何数值。
   */
  const frameCamera = (() => {
    const motion = resolveShotMotionFrame(shot.kind, scene.progress);
    /*
     * **空档漂移**：过了本镜 `endTime` 镜头不停下，而是沿"尾巴方向"（本镜 0.8→1.0 那段的位移）
     * 按 `(1 − e^(−gapTime × 0.4)) × 2.0` 的渐近速度继续漂（永远在动、又不会跑飞）。
     */
    const gapTime = Math.max(0, timeSec - shot.endTime);
    if (gapTime > 0) {
      const tailStart = resolveShotMotionFrame(shot.kind, 0.8);
      const driftSpeed = (1 - Math.exp(-gapTime * 0.4)) * 2;
      motion.x += (motion.x - tailStart.x) * driftSpeed;
      motion.y += (motion.y - tailStart.y) * driftSpeed;
      motion.scale += (motion.scale - tailStart.scale) * driftSpeed;
      motion.rotation += (motion.rotation - tailStart.rotation) * driftSpeed;
    }
    /* 时间轴震颤：位移 `0.02 × 强度`、旋转 `0.005 × 强度`；强度缺省 0（原版运行时同值）。 */
    const shake = resolveTimelineShake(timeSec, Math.max(0, input.shakeIntensity ?? 0));
    /*
     * **手势呼吸**：歌词揭示完成后渐入（1.2 秒升满），只要本镜最后一个追踪字开始唱就一直在。
     * 相位由**这一镜 id 的哈希**决定（原版 `hashSonnetSeed(shot.id)`），不是"镜序 + 段序"。
     */
    const breathWeight = resolveSonnetBreathWeight(timeSec, revealDoneTime);
    if (breathWeight > 0) {
      const breathPhase = ((hashSonnetSeed(shot.id) % 1024) / 1024) * Math.PI * 2;
      const breath = resolveSonnetBreath(timeSec, breathPhase);
      /*
       * **呼吸规模由唱词节奏给**：长音 / 空档浮得明显些、密唱收住（`rhythm.breathScale`）。
       * 仍是绝对时间的确定性函数（相位来自镜 id 哈希）⇒ seek / 帧率无关 ✓。
       */
      motion.x += breath.x * breathWeight * rhythm.breathScale;
      motion.y += breath.y * breathWeight * rhythm.breathScale;
      motion.scale += breath.scale * breathWeight * rhythm.breathScale;
      motion.rotation += breath.rotation * breathWeight * rhythm.breathScale;
    }
    return {
      x: (motion.x + shake.x) * cameraScale,
      y: (motion.y + shake.y) * cameraScale,
      zoom: shot.camera.zoom * (1 + (motion.scale - 1) * cameraScale),
      rotation: (shot.camera.rotation + motion.rotation + shake.rotation) * cameraScale,
      breathWeight,
      revealDoneTime,
    };
  })();

  /**
   * **本帧取景锚点**（画布像素）：渲染层把它当 `world.position`（再叠取景相机的平移）。
   * 海报族取画面中心、其余取 `(0.5 + 本镜 camera.x, 0.48 + camera.y ± 0.025)` —— 与下面
   * `anchorDelta` 里的 `basePositionX/Y` **同一个式子**，所以预排构图的屏幕解算与像素落到同一处。
   */
  const frameBasePositionX =
    shot.kind === 'poster-blocks' ? viewport.width / 2 : viewport.width * (0.5 + shot.camera.x);
  const frameBasePositionY =
    shot.kind === 'poster-blocks'
      ? viewport.height / 2
      : viewport.height * (0.48 + shot.camera.y + (shotIndex % 2 ? 0.025 : -0.025));

  /*
   * **预排构图**（见 `sonnetCameraFocus.ts`）—— 本帧轴心与取景兜底的唯一依据：
   * 对语义词组的真实 cue 区间做高斯加权、取加权中心（提前量 `0.06 + 0.06 × speed`、
   * 高斯宽度 `0.30 + 0.20 × speed`），长段再按"此刻唱到哪一粒"在一段宽时间窗里沿**最终落点**
   * 低频推进。没有"页 / 站 / 保持期"，也就不会一页页固定停留；输入只有**落点 + cue 时刻 + 当前时刻**
   * ⇒ 与逐字入场运动完全解耦（纠正"每粒字冒出镜头抖一次"）。
   *
   * 横向长句另给三样**本帧取景事实**（都只吃排版与运镜，不含逐字入场）：
   * · `basePositionX` = **本帧屏幕原点 x** = 取景锚点 + 本帧运镜平移（`frameCamera.x × 视口宽`，
   *   与主题里 `world.position.x = 取景锚点 + framedCamera.x × 视口宽` 同一项）⇒ 屏幕位置
   *   `≈ basePositionX + 世界缩放 × (落点 − 轴心)` 里唯一由调用者掌握的那一项。
   *   ⚠ 漏掉运镜平移这一项就会差 `camera.x × 视口宽`（实测那一镜 0.12 × 1524 ≈ 183px ≈ 0.12 视口宽
   *   —— 正是"锚定算对了但屏幕上还是偏"的来源）；不传它，焦点层就**不做屏幕锚定**（只把前沿当轴心）；
   * · `worldScale` = **本帧实际世界缩放**（`frameCamera.zoom`，含运镜帧）⇒ 屏幕比例折算回画布像素；
   * · `horizontalTailRatio` = 句末构图比例（0.67）⇒ 展开构图按 cue 进度连续渐变到句末构图。
   *
   * `screenScale` 仍取**本镜最大世界缩放**（含开场那记推近）：它只用于**舒适区**的折算
   * （"屏幕比例 → 画布半宽"），用最大缩放 = 用最小画布预算 = 保守（取景层随后只可能再拉远）。
   */
  const shotMotionMaxScale = Math.max(
    resolveShotMotionFrame(shot.kind, 0).scale,
    resolveShotMotionFrame(shot.kind, 1).scale,
  );
  const cameraFocus: SonnetCameraFocus | null = resolveSonnetCameraFocus(focusBlocks, timeSec, {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    speed: rhythm.speed,
    screenScale: shot.camera.zoom * (1 + (shotMotionMaxScale - 1) * cameraScale),
    basePositionX: frameBasePositionX + frameCamera.x * viewport.width,
    worldScale: frameCamera.zoom,
    /*
     * **句末构图**（主人量到展开中约 0.45、完成时约 0.67）：`frontRatio` 与 `tailRatio` 之间
     * 按 cue 进度连续渐变（渐变起点也是纯 cue 时刻的函数）。只对横向长句生效。
     */
    horizontalFrontRatio: SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_RATIO,
    horizontalTailRatio: SONNET_CAMERA_FOCUS_HORIZONTAL_TAIL_RATIO,
    horizontalTailRampStart: SONNET_CAMERA_FOCUS_HORIZONTAL_TAIL_RAMP_START,
    /* 镜种只用于"要不要启用水平长句预排"（竖排为主的镜种不启用，见 `sonnetCameraFocus.ts`）。 */
    shotKind: shot.kind,
  });

  /*
   * 转场（照抄 folia 的 `sonnetTransitions.ts`）：**相邻镜头之间也有**短转场，
   * 时长 `clamp(相邻镜起始间隔 × 0.18, 0.14, 0.24)` 秒，种类由边界序号的黄金比例哈希选定。
   * 段落之间那一层用编译层给的 `paragraph.transitionOut`（窗口收在下一段首行处）——
   * 两层**并存**：段落出转场在窗口内优先，其余时刻用镜头间那层。
   * ⚠ 上游的**帧合成顺序**我们没读到（`createSonnetPixiRuntime` 未取）⇒ "优先"是**我们的决定**，不是照抄。
   */
  const shotTransition: SonnetTransitionFrame = resolveSonnetShotTransition(
    paragraph.shots,
    shotIndex,
    timeSec,
    sonnetSeedNumber(program.seed),
  );
  const paragraphExit: SonnetTransitionFrame = resolveSonnetParagraphExitTransition(
    paragraph,
    timeSec,
    true,
    sonnetSeedNumber(program.seed),
  );
  /*
   * 优先级**照抄上游**（`createSonnetPixiRuntime.ts`，第 320 轮取到真源码）：
   *   `transitionFrame = shotTransitionFrame !== IDLE ? shotTransitionFrame : paragraphTransitionFrame`
   * ⇒ **镜头间优先，段落级只做兜底**。
   * ⚠ 我第 314 轮曾按"段落出优先"实现，并把它标注为"我们的决定"——
   * 现在证据到位：**上游是反的**，故按证据改回，不再是我的决定。
   */
  const transition: SonnetTransitionFrame =
    shotTransition === SONNET_IDLE_TRANSITION ? paragraphExit : shotTransition;

  /** 这一镜的数字种子（固定几何、背景取位、原版几何档位都靠它）。 */
  const frameShotSeed = shotSeedNumber(`${program.seed}|${shot.id}`, shotIndex);
  /**
   * 这一刻该画哪些引导线。
   *
   * **数据源是 `runs`**（逐段的放置结果），因为它同时带着我们需要的全部信息：
   * `startTime/endTime`（段的说话时间）、**`x/y`（屏幕锚点）**、`enterX/enterY`（真实入场矢量）、
   * `emphasis`（角色判定）、`fontPx`（该段字号）、`line`（所属行的起止，用来算"段在行内的相位"）✓。
   * 时机与数值照抄上游 `sonnet/sonnetGuides.ts`，随机源确定性化（见 `sonnetGuides.ts` 文件头）。
   */
  const guides = resolveSonnetGuideFrames(
    frameShotSeed,
    runs.map((run) => ({
      segmentStartTime: run.startTime,
      segmentEndTime: run.endTime,
      /*
       * 文字真正入场的时刻 = **首个字形的开始时间**（上游 `createSonnetGuide` 传的就是
       * `firstGlyph.startTime`）；没有逐字时间轴时才退回段的起点。
       */
      textStartTime: run.tracking?.[0]?.startTime ?? run.startTime,
      lineStartTime: run.line.startTime,
      lineEndTime: run.line.endTime,
      enterX: run.enterX,
      enterY: run.enterY,
      emphasis: run.emphasis,
      fontSize: run.fontPx,
      anchorX: run.x,
      anchorY: run.y,
    })),
    baseFontSize,
    timeSec,
  );
  /** 背景装饰粒子（同一颗镜头种子 ⇒ 同一套档位与摆法，可复现 ✓）。 */
  const decor = resolveSonnetDecorParticles(frameShotSeed, shot.kind, viewport.width, viewport.height);
  /*
   * 自拟的"跟着歌词冒火花"那一层已删：上游 `sonnetBackgroundDecor` 只按镜头种子撒粒子，
   * 而那一层会与真正的引导线拖尾在同一位置叠着遮字。
   */

  /*
   * 这里原来有五段"防重叠 / 防出血"的后处理（段级与逐字推挤、缩字号兜底、整组收边缩放、
   * 逐字夹回画布、整组重新居中，以及为它们服务的几个探针），已全部删除：
   * 原版每帧不做去重叠、排版层只保证整组估计落在画面内，同时**允许字出血**。
   * 现在字形数组就是"排版落点 + 逐字入场"的结果，没有任何后处理。
   */

  /*
   * **逐段字号探针**（第 24 轮补，主人反馈"字小"）。
   *
   * 打三组数，用来定位字号是在哪一环被压小的：
   * `seg=[…]` 每段一个 `角色字母 + 最终字号 @ 盒子实测宽`（H 主角 / S 次主角 / s 配角）；
   * `glyphMax` 是**真正落到字形上**的最大字号（幽灵字排除，它是 3.5 倍的影子、会误导判断）。
   * 只要 `glyphMax` 远小于 `seg` 里的值，缩小就发生在渲染层；两者都小，则发生在帧层。
   */
  const fontProbe = lineMetrics
    .map(
      (metric, index) =>
        /* 字号报**最终字号**（`基准 × 流程盒 fontScale`）——与真正画到字形上的那一份同一个数。 */
        `${segments[index]?.isWordLike === false ? '!' : ''}${metric?.isHero ? 'H' : metric?.isSemiHero ? 'S' : 's'}${Math.round(finalFontPxBySegment[index] ?? 0)}` +
        `@${Math.round(flowBoxes[index]?.measuredWidth ?? 0)}` +
        /*
         * 补**本段字数与文本**：主人说"有些字太大、十分别扭"——最可能是 5.5 倍的主角倍率
         * 被套在**单个字**上。有了这组数就能直接判：`H273(1某)` = 一个字被放大 5.5 倍，
         * 而 `H273(3词语)` = 正常的多字主角。
         */
        `(${[...(segments[index]?.text ?? '')].length}${(segments[index]?.text ?? '').slice(0, 3)})` +
        /* 每段的**落点**（本轮补）：判"成句"要看"段序 → x 是否递增、y 是否在一条线上"，
           以前的读数只有字号与盒宽，读不出"摆在哪"。 */
        `⌖${Math.round(flowBoxes[index]?.x ?? 0)},${Math.round(flowBoxes[index]?.y ?? 0)}`,
    )
    .join(' ');
  const glyphFonts = glyphs.filter((glyph) => !glyph.ghost).map((glyph) => Math.round(glyph.fontPx));
  /*
   * **正文外接范围**（第 1 轮补）：主人指出"巨字被上边缘裁掉、构图偏上"。
   * 这里把正文（排除幽灵字）的包围盒与画布尺寸一起打出来 ——
   * `y` 的下界为负就是上缘出血、`canvas 高 − y 上界` 就是下方留白，两个数一起看"偏上"有多偏。
   */
  const bodyGlyphs = glyphs.filter((glyph) => !glyph.ghost);
  let extentMinX = 0;
  let extentMaxX = 0;
  let extentMinY = 0;
  let extentMaxY = 0;
  if (bodyGlyphs.length > 0) {
    extentMinX = Number.POSITIVE_INFINITY;
    extentMaxX = Number.NEGATIVE_INFINITY;
    extentMinY = Number.POSITIVE_INFINITY;
    extentMaxY = Number.NEGATIVE_INFINITY;
    for (const glyph of bodyGlyphs) {
      const halfW = glyph.fontPx * 0.275;
      const halfH = glyph.fontPx * 0.45;
      extentMinX = Math.min(extentMinX, glyph.x - halfW);
      extentMaxX = Math.max(extentMaxX, glyph.x + halfW);
      extentMinY = Math.min(extentMinY, glyph.y - halfH);
      extentMaxY = Math.max(extentMaxY, glyph.y + halfH);
    }
  }
  const fontProbeKey =
    `${shot.kind}|${baseFontSize.toFixed(1)}|${fontProbe}|${glyphFonts.join(',')}` +
    `|${Math.round(extentMinX)},${Math.round(extentMaxX)},${Math.round(extentMinY)},${Math.round(extentMaxY)}`;
  if (sonnetFontProbeKey !== fontProbeKey) {
    sonnetFontProbeKey = fontProbeKey;
    console.info(
      `[pi/sonnet] fonts kind=${shot.kind} base=${baseFontSize.toFixed(1)} words=${shotWordCount} ` +
        /* 一次构图到底摊了几行歌词（`shot.lineIndices` 命中的行数）。>1 就说明两句话被塞进
           同一份流式排版 —— 那正是"不同句的字交叉在一起"的机制。 */
        `lines=${lines.length} idx=[${shot.lineIndices.join(',')}] ` +
        `segs=${lineMetrics.length} seg=[${fontProbe}] ` +
        `glyphMax=${glyphFonts.length === 0 ? 0 : Math.max(...glyphFonts)} ` +
        `extent x=[${Math.round(extentMinX)},${Math.round(extentMaxX)}] ` +
        /*
         * **词内字距**（本轮）：同一个词里相邻字的实际间距（`pitch`）与该字在该字号下的**自然步进**
         * （`natural`）之比 —— 这是判断"词被别人为拉开"的直接读数。
         * 主人说"布置与 folia 有别、字看着散"，若 `pitch ≫ natural` 就是被拉开；
         * 若两者接近（比值 ≈1），就是我们排得没问题、散的是别的层（构图/装饰）。
         */
        (() => {
          const probeRun = runs.find(
            (run) => run.tracking !== undefined && run.tracking.length > 1,
          );
          if (probeRun?.tracking === undefined) return '';
          const xs = probeRun.tracking.map((point) => point.baseX);
          const span = Math.max(...xs) - Math.min(...xs);
          const count = probeRun.tracking.length;
          const pitch = span / Math.max(1, count - 1);
          const natural =
            probeRun.fontPx * (/[\u2e80-\u9fff\uff00-\uffef]/.test(probeRun.text) ? 1 : 0.77);
          return ` pitch=${pitch.toFixed(1)} natural=${natural.toFixed(1)} ratio=${(pitch / Math.max(1e-3, natural)).toFixed(2)} n=${count}`;
        })() +
        `y=[${Math.round(extentMinY)},${Math.round(extentMaxY)}] canvas=${viewport.width}x${viewport.height}`,
    );
  }

  /* 镜头轴心（`anchorDelta` 的 IIFE 会写它）——见 `SonnetFrame.pivot` 字段的注释。 */
  let cameraPivotX = viewport.width / 2;
  let cameraPivotY = viewport.height / 2;

  /**
   * 这一帧输出的焦点读数；没有可用语义词组时给一份**空焦点**（`blockCount = 0`）
   * —— 主题据此不传 `planBounds`（取景层不做平移兜底），轴心退回静态轴心。
   */
  const frameCameraFocus: SonnetCameraFocusFrame =
    cameraFocus ?? emptySonnetCameraFocus(viewport.width / 2, viewport.height / 2);

  return {
    shotId: shot.id,
    sceneDuration: Math.max(0.01, shot.endTime - shot.startTime),
    shotStartTime: shot.startTime,
    guides,
    decor,
    /**
     * **装饰性开放边框**：与 `guides` / `decor` 同一套做法 —— 帧层只出"这一帧画哪些边框、各什么档位多大" ✓，
     * 形状展开交给 `sonnetFrameDecorShapes.ts` ✓、渲染交给主题 ✓。
     * 注意：`runs` 里 `role === 'decoration'` 的幽灵字在适配器里已被跳过 ✓。
     */
    frameDecor: resolveSonnetFrameDecorFrames(frameShotSeed, runs),
    /*
     * **每个词背后的局部固定几何**：逐 run 一条 —— 命中"阈值 26/15 + 四条资格"的非装饰词形 run
     * 才带 `motion`；互斥判据用的是**与 `frameDecor` 完全同一支哈希**。
     * ⚠ 传的是 `runs`（不含幽灵字）—— `role === 'decoration'` 的巨字不参与。
     */
    textGeo: resolveSonnetTextGeoFrames(runs, { frameShotSeed, paragraphKind: paragraph.kind }),
    /*
     * **每镜取景锚点**（照抄上游 `sonnetSceneBuilder.ts:286~311` 与 `sonnetShotFrame.ts:121~164`）。
     *
     * 上游把整镜容器的**轴心（pivot）**设成静态基准 `basePivot`，运行时再按动画强度在
     * `basePivot ↔ 跟拍焦点` 之间混合；容器的位置 `baseX/baseY` 是**取景锚点**：
     *   · `poster-blocks`：pivot 与 position 都取**正中心**（上游 `0 / 0.5 / 0.5`）；
     *   · 其余：pivot 取**第一个主角字的位置**（没有主角字就取正文包围盒中心），
     *     position 取 `(0.5 + camera.x, 0.48 + camera.y ± 0.025)`（± 按镜序奇偶）。
     * 运行时容器 x/y = `basePosition + 运镜帧 × 画布 × 动画强度`（漂移/呼吸另加），
     * 所以我们这边只要**逐帧**给出 `anchorDelta = basePosition − currentPivot`，主题把
     * `world.position` 设成 `pivot + anchorDelta` 就**恒等于** `basePosition`。
     *
     * ⚠ 两条曾经的错法（已修）：① `poster-blocks` 提前 `return {0,0}`，**绕过了整套跟踪**
     * ——上游那两个 0 只是 **basePivot**；② 增量里减的是**未混合的焦点** ⇒ 低强度档下画面会漂
     * （`pivot + delta ≠ basePosition`）。
     */
    anchorDelta: (() => {
      const isPoster = shot.kind === 'poster-blocks';
      /*
       * **静态轴心 `basePivot`**（上游 `focusX/focusY`）：poster 取画面正中心（上游局部坐标的 0）；
       * 其余取**第一个主角盒子的中心**（`flowBoxes` 是绝对坐标 = 画面中心 + `box.x/y`）。
       */
      let basePivotX = viewport.width / 2;
      let basePivotY = viewport.height / 2;
      if (!isPoster) {
        const heroBox = flowBoxes.find((box) => box.isHero);
        if (heroBox !== undefined) {
          basePivotX = viewport.width / 2 + heroBox.x;
          basePivotY = viewport.height / 2 + heroBox.y;
        } else if (bodyGlyphs.length > 0) {
          // 没有主角字：取**真实正文包围盒中心**（连正文都没有就留在画面中心）。
          basePivotX = (extentMinX + extentMaxX) / 2;
          basePivotY = (extentMinY + extentMaxY) / 2;
        }
      }
      /*
       * **预测焦点**（`sonnetCameraFocus.ts`）：这一刻镜头该看哪里 —— 落点 / cue 时刻的高斯融合，
       * 横向长句还会按屏幕比例解算轴心，**没有**逐字跟拍、也**没有**"一页之内不动 / 页间再搬"的
       * 分页死区。没有可用词组（空镜）时退回静态轴心 `basePivot`。
       *
       * ⚠ 横向长句的轴心**直接采信**（`screenAnchored`），但**只在动画强度 > 0 时**：
       * 那个数是按 `basePosition + 世界缩放 × (落点 − 轴心)` 反解出来的**屏幕构图结果**，
       * 再按动画强度档在 `basePivot` 与它之间混合就会把比例整体放大 / 缩小
       * （实测 `chaotic` 1.35 档尾端冲到 0.86 视口宽，越过"尾端 ≤ 0.8"的红线）。
       * 强度档仍然照原样管世界缩放、旋转、纵向构图与逐字入场动画。
       *
       * ⚠ **0 档（关动画）必须回静态 `basePivot`**：无条件直接采信会把 `pivot.x` 钉到 `aimX`，
       * 绕过 `cameraScale = 0` 本应带来的"完全不运镜"（实测 0 档 pivot.x 仍逐帧从 −141 走到 1600）。
       * 所以采信条件是 `screenAnchored && cameraScale > 0`；0 档落进
       * `basePivot + (焦点 − basePivot) × 0 = basePivot`，与旧静态轴心契约逐值一致。
       */
      const aimX = cameraFocus?.aimX ?? basePivotX;
      const aimY = cameraFocus?.aimY ?? basePivotY;
      /* 轴心按**同一个动画强度**在静态轴心与预测焦点之间混合（原版 `pivot = base + (焦点 − base) × camera`）。 */
      const directScreenAnchor = cameraFocus?.screenAnchored === true && cameraScale > 0;
      cameraPivotX = directScreenAnchor ? aimX : basePivotX + (aimX - basePivotX) * cameraScale;
      cameraPivotY = basePivotY + (aimY - basePivotY) * cameraScale;
      /*
       * 取景锚点直接用上面的 `frameBasePositionX/Y`（**同一个数**）：预排构图的屏幕解算用的就是
       * 它们，这里再算一遍就会有两份口径 —— 一旦分家，锚定的比例与真正落到的像素就不是一回事。
       */
      return {
        x: frameBasePositionX - cameraPivotX,
        y: frameBasePositionY - cameraPivotY,
      };
    })(),
    /* 轴心由 `anchorDelta` 那个 IIFE 顺带算出（它才拿得到预测焦点），对象字面量按顺序求值 ⇒ 这里已是最终值。 */
    pivot: { x: cameraPivotX, y: cameraPivotY },
    /*
     * **焦点读数**：渲染层的平移兜底只盯 `minX..maxY`（焦点周围的**固定舒适区**），
     * 而不是"此刻正在唱的那几个字" —— 后者是上一版"换块就把镜头拉过去"的根源。
     * `cameraPlan` 是给 `.tmp` 回放探针留的**同对象别名**（见字段注释）。
     */
    cameraFocus: frameCameraFocus,
    cameraPlan: frameCameraFocus,
    /*
     * **阅读窗口 + 唱词节奏**（本轮取景纠正）：渲染层的取景与验收都直接读这两个字段，
     * 不再从"整镜 glyphs 的落位边界"推取景语义 ✓。
     */
    readingWindow,
    rhythm,
    shotKind: shot.kind,
    paragraphKind: paragraph.kind,
    paragraphIndex,
    shotIndex,
    progress: scene.progress,
    /* 同一个数，单独列出以固定"背景/形状的生长用哪一条口径"这条契约（见字段注释 ✓）。 */
    rawProgress: scene.progress,
    /*
     * **运镜**：上面 `frameCamera` 已经算好（位置提前是因为预排构图的屏幕锚定要先知道本帧实际
     * 世界缩放）。这里的注释保留它的四层来源：路径曲线（`resolveShotMotionFrame`）→ 空档漂移
     * → 时间轴震颤 → 手势呼吸，最后整体乘动画强度档 `scale`：
     *   `x/y = (frame + shake) × scale`、`zoom = shot.camera.zoom × (1 + (frame.scale − 1) × scale)`、
     *   `rotation = (shot.camera.rotation + frame.rotation + shake.rotation) × scale`。
     * 没有额外的撞击反移、也没有段落衔接的镜位退让 —— 镜头的位移只由时间决定。
     */
    camera: frameCamera,
    glyphs,
    shapes,
    geometryVariant: resolveSonnetGeometryVariant(`${program.seed}|${shot.id}`, shotIndex),
    /*
     * 重镜头用的**原版几何档位**（0~99）以及"这一档搬过来了没有"。
     * 只是个诊断读数：冒烟靠它判断画面上那一批大图形到底是原版的还是我们自拟的兜底。
     */
    geoVariant: resolveSonnetGeoVariant(frameShotSeed),
    geoPorted:
      isSonnetHeavyShotKind(shot.kind) && hasSonnetGeoVariant(frameShotSeed, frameShotSeed),
    transition,
    fallback: false,
  };
}
