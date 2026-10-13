/**
 * 凝彩接线批第 1 步：**从歌词片段到排版计划**的适配层。
 *
 * 它把上一批做好的六块串成一条可测的链：
 * 逐字测量 → 造词单元（宽度 / 前置间距 / 缩放）→ `fitTemperaLayout` 收缩拟合
 * → `composeTemperaPlacements` 出"几何 + 入场四项"。
 *
 * **仍然不碰帧层**（`temperaFrame.ts` 还是那份单行简化版）：先把这条链用假测量跑通、钉死，
 * 再接真实测量与渲染。
 *
 * ⚠ **已知近似（必须写明，不能糊）**：
 * 1. 本层把"词宽"按**字形宽度累加**得到，**不含字距/连字/kerning** ——
 *    上游用真实测量上下文（`createTemperaMeasureContext`）；我们先用 `measure(char, fontPx)` 近似，
 *    接真实测量时应只替换 `measure` 的实现，其余不动。
 * 2. 词的前置间距按上游口径取 `fontSize × (源文真有空白 ? 0.26 : 0.035)`；
 *    "源文有没有空白"由调用方给出（我们的数据里就是"这个片段前是否有空白字素"）。
 * 3. 主角词的选取用 `resolveTemperaWordScales`（盐 101/103/107），逐字盐用 `resolveTemperaEntrance`（149/151/157/163）。
 */

import {
  composeTemperaPlacements,
  fitTemperaLayout,
  packTemperaRows,
  resolveTemperaWordScales,
} from './temperaRowLayout';
import type {
  TemperaComposedPlacement,
  TemperaMeasuredGlyph,
  TemperaMeasuredWord,
  TemperaRow,
  TemperaRowRegion,
} from './temperaRowLayout';

/** 一个词（上游 `TemperaWordUnit` 的最小子集）。 */
export interface TemperaPlanWord {
  /** 这个词属于哪一条歌词行（换行判定要用）。 */
  readonly lineIndex: number;
  /** 词内每个字素（已滤掉纯空白）。 */
  readonly glyphs: readonly string[];
  /** 词是否实词（`isWordLike`）—— 只有实词能当主角。 */
  readonly isWordLike: boolean;
  /** 源文里这个词**前面**是否真有空白（决定间距是 0.26 还是 0.035 个字号）。 */
  readonly spacedBefore: boolean;
  readonly segmentIndex?: number;
}

export interface TemperaLayoutPlanOptions {
  readonly seed: number;
  /** 排版区域：行摆放用 `TemperaRowRegion`，拟合还要知道**区域高**（上游 `LayoutRegion` 同样带 height）。 */
  readonly region: TemperaRowRegion & { readonly height: number };
  readonly baseFontSize: number;
  readonly fontScale: number;
  /** 每个歌词行的词（顺序即阅读顺序）。 */
  readonly lines: readonly (readonly TemperaPlanWord[])[];
  /** 量一个字形在当前字号下的宽度（真实实现走 canvas / 字体度量）。 */
  readonly measure: (char: string, fontPx: number) => number;
  /**
   * 入场向量，**以字号为单位**（上游 `resolveEnterVector` 就是这么乘的）。
   *
   * 给这个（推荐）而不是直接给角度/距离，是因为上游的顺序是
   * **`resolveRegion` → 四轮拟合 → `resolveEnterVector(shotKind, 拟合后的字号)`** ——
   * 入场基准**依赖拟合结果**，由本函数在拟合之后自己算，才不会用"拟合之前的字号"算距离。
   */
  readonly enter: readonly [number, number];
  /* 旧入参 `baseAngle / baseMagnitude` 已于第 231 轮清理 —— 入场基准只有 `enter` 一条路径。 */
  readonly settleStretch?: number;
}

/** 词前置间距的两种口径（照抄上游 `:171`）。 */
export const TEMPERA_WORD_GAP_SPACED = 0.26;
export const TEMPERA_WORD_GAP_TIGHT = 0.035;

/** 构图 profile 里本层要用的两个字段（我们的 `temperaProfiles.ts` 已有）。 */
export interface TemperaPlanProfile {
  readonly region: {
    readonly cx: number;
    readonly cy: number;
    readonly w: number;
    readonly h: number;
    readonly align: 'center' | 'left' | 'right';
    readonly rotation: number;
    readonly fontScale: number;
  };
  /** 入场向量，**以字号为单位**（照抄上游 `resolveEnterVector`）。 */
  readonly enter: readonly [number, number];
}

export interface TemperaLayoutRegion {
  readonly region: TemperaRowRegion & { readonly height: number; readonly fontScale: number };
  readonly baseAngle: number;
  readonly baseMagnitude: number;
}

/**
 * 把构图 profile 换算成"排版区域 + 入场基准"（照抄上游 `resolveRegion` 与 `resolveEnterVector`，`temperaLayout.ts:83~99`）。
 *
 * - 区域：`centerX/Y = cx/cy × 画布`、`width/height = w/h × 画布`，另带 `align / rotation / fontScale`；
 * - 入场：`enterX/Y = enter.x/y × 字号` ⇒ `baseAngle = atan2(y, x)`、`baseMagnitude = hypot(x, y)`。
 *
 * **注意**：入场距离以**字号**为单位（不是画布比例）——上游如此，别按画布去配。
 */
export const resolveTemperaLayoutRegion = (options: {
  profile: TemperaPlanProfile;
  width: number;
  height: number;
  fontSize: number;
}): TemperaLayoutRegion => {
  const { profile, width, height, fontSize } = options;
  const enterX = (profile.enter[0] ?? 0) * fontSize;
  const enterY = (profile.enter[1] ?? 0) * fontSize;
  return {
    region: {
      centerX: profile.region.cx * width,
      centerY: profile.region.cy * height,
      width: profile.region.w * width,
      height: profile.region.h * height,
      align: profile.region.align,
      rotation: profile.region.rotation,
      fontScale: profile.region.fontScale,
    },
    baseAngle: Math.atan2(enterY, enterX),
    baseMagnitude: Math.hypot(enterX, enterY),
  };
};

export interface TemperaLayoutPlan {
  readonly fontSize: number;
  readonly attempts: number;
  /** 几何 + 入场四项（时间字段由 `applyTemperaGlyphTiming` 另补）。 */
  readonly placements: readonly TemperaComposedPlacement[];
  readonly rows: readonly TemperaRow<TemperaMeasuredWord>[];
}

/**
 * 跑一次完整排版（**纯函数**：不吃时间、不碰 DOM，`measure` 由调用方注入）。
 *
 * 逐词缩放的盐基是"行号"，所以这里先按 `lineIndex` 把词分组、逐行求 `resolveTemperaWordScales`，
 * 再把行号与词序（**在本行内的序号**）写进词单元 —— 上游的 `salt = rowIndex × 37 + wordIndex`
 * 用的是**排版行号与词序**，我们这里以"歌词行号 → 排版行"的映射保证二者一致（当前一行歌词一行排版）。
 */
export const planTemperaLayout = (options: TemperaLayoutPlanOptions): TemperaLayoutPlan => {
  const byLine = new Map<number, TemperaPlanWord[]>();
  options.lines.forEach((words) => {
    words.forEach((word) => {
      const bucket = byLine.get(word.lineIndex) ?? [];
      bucket.push(word);
      byLine.set(word.lineIndex, bucket);
    });
  });

  const buildRows = (fontSize: number): TemperaRow<TemperaMeasuredWord>[] => {
    const words: TemperaMeasuredWord[] = [];
    byLine.forEach((lineWords, lineIndex) => {
      const lengths = lineWords.map((word) => (word.isWordLike ? word.glyphs.length : 0));
      const scales = resolveTemperaWordScales(lengths, options.seed, lineIndex);
      lineWords.forEach((word, index) => {
        // 兜底用 1（中性缩放）：`?? 1` 不要写成间距常量 —— 那是两种完全不同含义的数。
        const scale = scales[index] ?? 1;
        const fontPx = fontSize * scale;
        const glyphs: TemperaMeasuredGlyph[] = [];
        let offset = 0;
        word.glyphs.forEach((char) => {
          const width = options.measure(char, fontPx);
          glyphs.push({ char, offset, width });
          offset += width;
        });
        words.push({
          width: offset,
          // 行首词的间距不计（`packTemperaRows` 里已有"首词只用宽度"的规则），这里按上游照算。
          leadingGap: index === 0 ? 0 : fontSize * (word.spacedBefore ? TEMPERA_WORD_GAP_SPACED : TEMPERA_WORD_GAP_TIGHT),
          lineIndex,
          scale,
          segmentIndex: word.segmentIndex ?? index,
          glyphs,
        });
      });
    });
    return packTemperaRows(words, options.region.width, options.seed, fontSize);
  };

  const fitted = fitTemperaLayout<TemperaMeasuredWord>({
    baseFontSize: options.baseFontSize,
    fontScale: options.fontScale,
    regionWidth: options.region.width,
    regionHeight: options.region.height,
    buildRows,
  });

  /*
   * **入场基准在拟合之后算**（上游顺序）：`enter` 以字号为单位 ⇒ 乘**拟合出来的**字号。
   * （旧入参 `baseAngle/baseMagnitude` 已于第 231 轮清理，这里只有一条路径。）
   */
  const enterX = options.enter[0] * fitted.fontSize;
  const enterY = options.enter[1] * fitted.fontSize;
  const baseAngle = Math.atan2(enterY, enterX);
  const baseMagnitude = Math.hypot(enterX, enterY);

  return {
    fontSize: fitted.fontSize,
    attempts: fitted.attempts,
    placements: composeTemperaPlacements({
      seed: options.seed,
      region: options.region,
      fontSize: fitted.fontSize,
      baseAngle,
      baseMagnitude,
      rows: fitted.rows,
    }),
    rows: fitted.rows,
  };
};
