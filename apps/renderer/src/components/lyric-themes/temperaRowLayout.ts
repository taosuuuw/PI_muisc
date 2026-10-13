/**
 * 凝彩**排版层**的第一块：贪心断行 + 行高（照抄上游 `tempera/temperaLayout.ts:129~152` 与 `:277~283`）。
 *
 * 上游注释里那句话是这一块的全部意义："**贪心打包 + 每行带随机填充预算 —— 这才是让每行参差不齐的原因**"，
 * 以及"**换歌词行必然换排版行**，以保证阅读顺序"。行高那句是"**紧行距：这一块要读成一个整体，
 * 不要读成排开的几行**"。
 *
 * 与上游逐行对应：
 * - `budgetFor(rowIndex) = maxWidth × (0.72 + 盐 109 × 0.28)`
 *   ⇒ 每行的可用宽度在 72%~100% 之间摆动，于是行末的断点位置也跟着摆动；
 * - 换行判定：**先按"换歌词行"判**（`word.lineIndex !== 当前行首词的 lineIndex`），
 *   再看是否超出该行预算；注意"第一个词的 `leadingGap` 不计"（行首不留前置间距）；
 * - 行高：`fontSize × 本行最大 word.scale × (1.02 + 盐 113 × 0.1)`。
 *
 * 这里做成**纯函数**：只吃"词宽 / 前置间距 / 行号 / 缩放"，不碰测量与画布，
 * 这样断行是否正确可以直接被单测钉住（这也是我们凝彩接线前的可验证一步）。
 */

import { temperaHash01 } from './temperaProgram';
import { resolveTemperaEntrance, resolveTemperaWordSalt } from './temperaEntrance';

/** 一行的水平填充预算下限 / 摆动幅度（照抄上游 `:135`）。 */
export const TEMPERA_ROW_BUDGET_BASE = 0.72;
export const TEMPERA_ROW_BUDGET_SPAN = 0.28;

/** 行高的基准与摆动（照抄上游 `:282`）。 */
export const TEMPERA_ROW_HEIGHT_BASE = 1.02;
export const TEMPERA_ROW_HEIGHT_SPAN = 0.1;

/** 行的横向错开幅度（照抄上游 `:305`：`(盐 − 0.5) × region.width × 0.06`）。 */
export const TEMPERA_ROW_DRIFT_SPAN = 0.06;
/** 行的倾斜幅度（照抄上游 `:306`：`(盐 − 0.5) × 0.06` ⇒ 实际区间 ±0.03）。 */
export const TEMPERA_ROW_ROTATION_SPAN = 0.06;
/** 左/右对齐时，`|drift|` 参与多少（照抄上游 `:310/:311` 的 `× 0.6`）。 */
export const TEMPERA_ROW_ALIGN_DRIFT_FACTOR = 0.6;

/** 行摆放需要的区域信息（上游 `LayoutRegion` 的子集）。 */
export interface TemperaRowRegion {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly align: 'center' | 'left' | 'right';
  /** 区域自身的基准旋转（可选；缺省 0）。 */
  readonly rotation?: number;
}

export interface TemperaRowPlacement {
  /** 行中心（行内的词按它左右排开）。 */
  centerX: number;
  centerY: number;
  rotation: number;
  /** 这一行的横向错开量（带符号；左/右对齐时用它的绝对值）。 */
  drift: number;
}

/**
 * 解一行的横向错开、倾斜与**行中心**（照抄上游 `temperaLayout.ts:304~312`）。
 *
 * 三种对齐的差别（上游原样）：
 * - `center`：行中心 = 区域中心 + **带符号**的 `drift`；
 * - `left`：从区域**左缘**起排，且只加 `|drift| × 0.6`（左对齐不往左溢出）；
 * - `right`：从区域**右缘**往左排，同样只加 `|drift| × 0.6`。
 *
 * `cursorY` 由调用方按"上一行行高累加"给出（上游是 `cursorY += row.height`），
 * 这里只把它加回行中心，避免把纵向游标也塞进这个纯函数。
 */
export const resolveTemperaRowPlacement = (
  seed: number,
  rowIndex: number,
  region: TemperaRowRegion,
  rowWidth: number,
  rowHeight: number,
  cursorY: number,
): TemperaRowPlacement => {
  const drift = (temperaHash01(seed, rowIndex, 127) - 0.5) * region.width * TEMPERA_ROW_DRIFT_SPAN;
  const rotation = (temperaHash01(seed, rowIndex, 131) - 0.5) * TEMPERA_ROW_ROTATION_SPAN;
  const rowLeft =
    region.align === 'center'
      ? region.centerX - rowWidth / 2 + drift
      : region.align === 'left'
        ? region.centerX - region.width / 2 + Math.abs(drift) * TEMPERA_ROW_ALIGN_DRIFT_FACTOR
        : region.centerX + region.width / 2 - rowWidth - Math.abs(drift) * TEMPERA_ROW_ALIGN_DRIFT_FACTOR;
  return {
    centerX: rowLeft + rowWidth / 2,
    centerY: cursorY + rowHeight / 2,
    rotation,
    drift,
  };
};


export interface TemperaRowWord {
  readonly width: number;
  /** 这个词**前面**的间距（上游 `leadingGap`；行首不计）。 */
  readonly leadingGap: number;
  /** 它来自哪一条歌词行 —— 换歌词行必然换排版行。 */
  readonly lineIndex: number;
  /** 字号倍率（主角词 1.34~1.6、其余 0.7~0.86），用来定行高。 */
  readonly scale: number;
}

export interface TemperaRow<T extends TemperaRowWord> {
  words: T[];
  width: number;
  height: number;
}

/** 该行的填充预算（照抄上游 `budgetFor`）。 */
export const resolveTemperaRowBudget = (seed: number, rowIndex: number, maxWidth: number): number =>
  maxWidth * (TEMPERA_ROW_BUDGET_BASE + temperaHash01(seed, rowIndex, 109) * TEMPERA_ROW_BUDGET_SPAN);

/** 该行的行高（照抄上游 `:282`）。 */
export const resolveTemperaRowHeight = (
  seed: number,
  rowIndex: number,
  fontSize: number,
  tallestScale: number,
): number =>
  fontSize * tallestScale * (TEMPERA_ROW_HEIGHT_BASE + temperaHash01(seed, rowIndex, 113) * TEMPERA_ROW_HEIGHT_SPAN);

/** 词级旋转幅度（照抄上游 `:323`：`(盐 − 0.5) × 0.07` ⇒ 实际区间 ±0.035）。 */
export const TEMPERA_WORD_ROTATION_SPAN = 0.07;
/** 词级纵向微移幅度（照抄上游 `:324`：`(盐 − 0.5) × fontSize × 0.09`）。 */
export const TEMPERA_WORD_SHIFT_SPAN = 0.09;

/** 主角词放大区间（照抄上游 `:124`：`1.34 + 盐 103 × 0.26`）。 */
export const TEMPERA_HERO_SCALE_BASE = 1.34;
export const TEMPERA_HERO_SCALE_SPAN = 0.26;
/** 其余词压缩区间（照抄上游 `:125`：`0.7 + 盐 107 × 0.16`）。 */
export const TEMPERA_REST_SCALE_BASE = 0.7;
export const TEMPERA_REST_SCALE_SPAN = 0.16;

/**
 * 逐词字号（照抄上游 `resolveWordScales`，`temperaLayout.ts:112~127`）。
 *
 * 规则：**每个歌词行挑一个"主角词"** —— 候选是"字素数 ≥ 本行最长 − 1"的**实词**，
 * 用盐 **101** 从候选里挑一个；主角 `1.34 + 盐 103 × 0.26`、其余 `0.7 + 盐 107 × 0.16`。
 * 上游注释原话：主角与其余之间**拉大差距**，这一行才会读成一个**有重心的组**。
 *
 * 盐里的 `lineIndex × 31 + index` 保证**每个词各有自己的抖动**（不是整行一个值）。
 * 没有任何实词时 `heroIndex = -1`，于是整行都按"其余"处理。
 */
export const resolveTemperaWordScales = (
  wordLengths: readonly number[],
  seed: number,
  lineIndex: number,
): number[] => {
  const maxLength = Math.max(0, ...wordLengths);
  const heroCandidates = wordLengths.flatMap((length, index) =>
    length > 0 && length >= maxLength - 1 ? [index] : [],
  );
  const heroIndex =
    heroCandidates.length > 0
      ? (heroCandidates[
          Math.floor(temperaHash01(seed, lineIndex, 101) * heroCandidates.length) % heroCandidates.length
        ] as number)
      : -1;
  return wordLengths.map((_length, index) =>
    index === heroIndex
      ? TEMPERA_HERO_SCALE_BASE + temperaHash01(seed, lineIndex * 31 + index, 103) * TEMPERA_HERO_SCALE_SPAN
      : TEMPERA_REST_SCALE_BASE + temperaHash01(seed, lineIndex * 31 + index, 107) * TEMPERA_REST_SCALE_SPAN,
  );
};

/** 字号下限（照抄上游 `:274` 的 `Math.max(14, …)`）。 */
export const TEMPERA_MIN_FONT_SIZE = 14;
/** 收缩拟合的轮数上限（照抄上游 `:277` 的 `attempt < 4`）。 */
export const TEMPERA_FIT_ATTEMPTS = 4;
/** 认为"已经装得下"的阈值（照抄上游 `:291` 的 `fit >= 0.999`）。 */
export const TEMPERA_FIT_TOLERANCE = 0.999;

export interface TemperaFitResult<T extends TemperaRowWord> {
  fontSize: number;
  rows: TemperaRow<T>[];
  blockHeight: number;
  /** 实际跑了几轮（便于断言"已经装得下就别再缩"）。 */
  attempts: number;
}

/**
 * **四轮收缩拟合**（照抄上游 `resolveTemperaLayout` 的拟合循环，`temperaLayout.ts:273~293`）。
 *
 * 逻辑逐条对应：
 * - 字号初值 `max(14, baseFontSize × region.fontScale)`；
 * - 每轮：按当前字号打包 → `blockHeight` = 各行高之和 → `maxRowWidth` = 最宽行的宽度；
 *   `fit = min(1, region.height / blockHeight, region.width / maxRowWidth)`；
 * - `fit ≥ 0.999` ⇒ **直接停**（已经装得下，不再动字号）；
 * - 否则 `fontSize ×= fit` 再来一轮，**最多 4 轮**。
 *
 * 打包本身由调用方以 `buildRows(fontSize)` 注入（因为要测量文字宽度），
 * 这样"拟合策略"这一层可以脱离测量被单独钉死。
 */
export const fitTemperaLayout = <T extends TemperaRowWord>(options: {
  baseFontSize: number;
  fontScale: number;
  regionWidth: number;
  regionHeight: number;
  buildRows: (fontSize: number) => TemperaRow<T>[];
  maxAttempts?: number;
}): TemperaFitResult<T> => {
  const maxAttempts = options.maxAttempts ?? TEMPERA_FIT_ATTEMPTS;
  let fontSize = Math.max(TEMPERA_MIN_FONT_SIZE, options.baseFontSize * options.fontScale);
  let rows: TemperaRow<T>[] = [];
  let blockHeight = 0;
  let attempts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attempts = attempt + 1;
    rows = options.buildRows(fontSize);
    blockHeight = rows.reduce((sum, row) => sum + row.height, 0);
    const maxRowWidth = Math.max(1, ...rows.map((row) => row.width));
    const fit = Math.min(
      1,
      blockHeight > options.regionHeight ? options.regionHeight / blockHeight : 1,
      maxRowWidth > options.regionWidth ? options.regionWidth / maxRowWidth : 1,
    );
    if (fit >= TEMPERA_FIT_TOLERANCE) break;
    fontSize *= fit;
  }
  return { fontSize, rows, blockHeight, attempts };
};

/** 已测量的字形（`offset` 是它在**词内**的左偏移、`width` 是自身宽度）。 */
export interface TemperaMeasuredGlyph {
  readonly char: string;
  readonly offset: number;
  readonly width: number;
}

/** 已测量的词（宽度与前置间距来自测量；`scale` 来自 `resolveTemperaWordScales`）。 */
export interface TemperaMeasuredWord extends TemperaRowWord {
  readonly glyphs: readonly TemperaMeasuredGlyph[];
  readonly segmentIndex?: number;
}

export interface TemperaComposedPlacement {
  char: string;
  lineIndex: number;
  segmentIndex: number;
  rowIndex: number;
  wordIndex: number;
  glyphIndex: number;
  x: number;
  y: number;
  rotation: number;
  fontSize: number;
  enterStyle: ReturnType<typeof resolveTemperaEntrance>['enterStyle'];
  enterX: number;
  enterY: number;
  enterRotation: number;
  enterScale: number;
}

/**
 * 把排版的五块**串成一次完整排版**（对应上游 `resolveTemperaLayout` 的主循环 `temperaLayout.ts:299~372`）。
 *
 * 顺序（照抄，不能换）：纵向游标从"区域中心 − 块高一半"开始 → 逐行取行摆放（含顺带累加 `cursorY`）
 * → 逐词取词摆放 → 逐字形算**三层旋转落点**并顺手取**入场四项**；
 * 基准旋转是 `region.rotation + rowRotation + wordRotation`（上游 `:356`）。
 *
 * **不含时间**：`startTime / endTime` 来自歌词时间轴，属于调用方的事；
 * 几何排完之后由 `applyTemperaGlyphTiming` 补 `settleTime / releaseTime / trackingX/Y`。
 * 这样"几何"与"时间"两层的对错可以分开钉。
 */
export const composeTemperaPlacements = (options: {
  seed: number;
  region: TemperaRowRegion;
  fontSize: number;
  /** 入场基准（上游 `baseAngle / baseMagnitude`，由构图 profile 与字号推出）。 */
  baseAngle: number;
  baseMagnitude: number;
  rows: readonly TemperaRow<TemperaMeasuredWord>[];
}): TemperaComposedPlacement[] => {
  const { seed, region, fontSize, baseAngle, baseMagnitude, rows } = options;
  const blockHeight = rows.reduce((sum, row) => sum + row.height, 0);
  let cursorY = region.centerY - blockHeight / 2;
  const placements: TemperaComposedPlacement[] = [];

  rows.forEach((row, rowIndex) => {
    const rowPlacement = resolveTemperaRowPlacement(seed, rowIndex, region, row.width, row.height, cursorY);
    cursorY += row.height;
    let cursorX = rowPlacement.centerX - row.width / 2;

    row.words.forEach((word, wordIndex) => {
      const wordSalt = resolveTemperaWordSalt(rowIndex, wordIndex);
      const wordLeft = cursorX + (wordIndex === 0 ? 0 : word.leadingGap);
      cursorX = wordLeft + word.width;
      const wordCenterX = wordLeft + word.width / 2;
      const wordPlacement = resolveTemperaWordPlacement(seed, wordSalt, fontSize, rowPlacement.centerY);
      const glyphSize = fontSize * word.scale;

      word.glyphs.forEach((glyph, glyphIndex) => {
        if (glyph.char.trim().length === 0) return;
        const localX = wordLeft + glyph.offset + glyph.width / 2;
        const landing = resolveTemperaGlyphLanding({
          localX,
          wordCenterX,
          wordCenterY: wordPlacement.centerY,
          wordRotation: wordPlacement.rotation,
          rowCenterX: rowPlacement.centerX,
          rowCenterY: rowPlacement.centerY,
          rowRotation: rowPlacement.rotation,
          regionCenterX: region.centerX,
          regionCenterY: region.centerY,
          regionRotation: region.rotation ?? 0,
        });
        const entrance = resolveTemperaEntrance({
          seed,
          rowIndex,
          wordIndex,
          glyphIndex,
          baseAngle,
          baseMagnitude,
        });
        placements.push({
          char: glyph.char,
          lineIndex: word.lineIndex,
          segmentIndex: word.segmentIndex ?? wordIndex,
          rowIndex,
          wordIndex,
          glyphIndex,
          x: landing.x,
          y: landing.y,
          rotation: (region.rotation ?? 0) + rowPlacement.rotation + wordPlacement.rotation,
          fontSize: glyphSize,
          ...entrance,
        });
      });
    });
  });

  return placements;
};

/** 绕任意点旋转（**照抄上游 `rotateAbout`**，`:101~108`；`angle === 0` 直接短路）。 */
export const rotateAbout = (
  x: number,
  y: number,
  cx: number,
  cy: number,
  angle: number,
): { x: number; y: number } => {
  if (angle === 0) return { x, y };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
};

/** 词级摆放：旋转（盐 **137**）与纵向微移（盐 **139**）。 */
export const resolveTemperaWordPlacement = (
  seed: number,
  wordSalt: number,
  fontSize: number,
  rowCenterY: number,
): { rotation: number; shiftY: number; centerY: number } => {
  const rotation = (temperaHash01(seed, wordSalt, 137) - 0.5) * TEMPERA_WORD_ROTATION_SPAN;
  const shiftY = (temperaHash01(seed, wordSalt, 139) - 0.5) * fontSize * TEMPERA_WORD_SHIFT_SPAN;
  return { rotation, shiftY, centerY: rowCenterY + shiftY };
};

export interface TemperaGlyphLandingInput {
  /** 字形在**词内**的水平位置（`词左 + 字形偏移 + 半宽`）。 */
  localX: number;
  wordCenterX: number;
  wordCenterY: number;
  wordRotation: number;
  rowCenterX: number;
  rowCenterY: number;
  rowRotation: number;
  regionCenterX: number;
  regionCenterY: number;
  regionRotation: number;
}

/**
 * 字形落点 = **三层旋转嵌套**（照抄上游 `:334~342`）：
 * 词（绕词中心）→ 行（绕行中心）→ 区域（绕区域中心）。
 * **顺序不能换** —— 每一层吃的是上一层的输出。
 */
export const resolveTemperaGlyphLanding = (input: TemperaGlyphLandingInput): { x: number; y: number } => {
  const inWord = rotateAbout(
    input.localX,
    input.wordCenterY,
    input.wordCenterX,
    input.wordCenterY,
    input.wordRotation,
  );
  const inRow = rotateAbout(
    inWord.x,
    inWord.y,
    input.rowCenterX,
    input.rowCenterY,
    input.rowRotation,
  );
  return rotateAbout(
    inRow.x,
    inRow.y,
    input.regionCenterX,
    input.regionCenterY,
    input.regionRotation,
  );
};

/**
 * 贪心打包（照抄上游 `packRows`）：先按"换歌词行"强制断，再按该行预算断。
 * 行高在同一个循环里算（上游也是在同一轮里算的，只是位置在调用侧）。
 */
export const packTemperaRows = <T extends TemperaRowWord>(  words: readonly T[],
  maxWidth: number,
  seed: number,
  fontSize: number,
): TemperaRow<T>[] => {
  const rows: TemperaRow<T>[] = [];
  let current: T[] = [];
  let currentWidth = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const tallestScale = Math.max(...current.map((word) => word.scale));
    rows.push({
      words: current,
      width: currentWidth,
      height: resolveTemperaRowHeight(seed, rows.length, fontSize, tallestScale),
    });
    current = [];
    currentWidth = 0;
  };

  words.forEach((word) => {
    const newLine = current.length > 0 && word.lineIndex !== current[0]?.lineIndex;
    const advance = current.length === 0 ? word.width : word.width + word.leadingGap;
    if (newLine || (current.length > 0 && currentWidth + advance > resolveTemperaRowBudget(seed, rows.length, maxWidth))) {
      flush();
    }
    // 行首词的 `leadingGap` **不计**（上游 `current.length === 0` 分支）。
    currentWidth += current.length === 0 ? word.width : advance;
    current.push(word);
  });
  flush();
  return rows;
};
