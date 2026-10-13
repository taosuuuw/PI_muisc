/**
 * 凝彩逐字**入场四项**的产出（照抄上游 `tempera/temperaLayout.ts:314~365` 的盐值与公式）。
 *
 * 上游是在排版的三层循环里现算的；这里把它抽成**纯函数**，好处是：
 * ① 可以不依赖排版/测量就能把"盐用对了没有"钉死在单测里；
 * ② 将来接线到 `temperaFrame.ts` 时，只要喂同样四个索引，值必然一致。
 *
 * 逐项对应（全部有上游行号）：
 * - `salt = rowIndex × 37 + wordIndex`（词盐，`:316`）；
 * - `glyphSalt = salt × 53 + glyphIndex`（字形盐，`:346`）；
 * - **入场样式按"词"挑**（盐 **193**，`:319~322`）—— 注释原话："一个词一种入场：
 *   相邻词各不同，但一个词绝不会拆成几种手势"；
 * - **角度**：`angle = baseAngle + spread`，`spread` 由盐 **149** 生成（`:347/:349`）；
 * - **距离**：`magnitude = baseMagnitude × (0.55 + 盐 151 × 1.05)`（`:348`）；
 * - `enterRotation` 盐 **157**（`(v − 0.5) × 0.7`，`:364`）；
 * - `enterScale = 0.6 + 盐 163 × 0.3`（`:365`，即 **0.6 ~ 0.9**，幅度克制）。
 */

import { temperaHash01 } from './temperaProgram';
import { TEMPERA_ENTER_STYLES, type TemperaEnterStyle } from './temperaGlyphMotion';

export interface TemperaEntranceInput {
  seed: number;
  rowIndex: number;
  wordIndex: number;
  glyphIndex: number;
  /** 这一镜的基准来向（`atan2(enter.y, enter.x)`，入场向量以字号为单位）。 */
  baseAngle: number;
  /** 这一镜的基准距离（`hypot(enter.x, enter.y) × 字号`）。 */
  baseMagnitude: number;
}

export interface TemperaEntranceFields {
  enterStyle: TemperaEnterStyle;
  enterX: number;
  enterY: number;
  enterRotation: number;
  enterScale: number;
}

/** 抖动的常量（照抄）：角度 ±0.85 弧度、距离倍率 0.55~1.60、旋转 ±0.35、缩放 0.6~0.9。 */
export const TEMPERA_ENTRANCE_SPREAD_RADIANS = 1.7;
export const TEMPERA_ENTRANCE_MAGNITUDE_BASE = 0.55;
export const TEMPERA_ENTRANCE_MAGNITUDE_SPAN = 1.05;
export const TEMPERA_ENTRANCE_ROTATION_SPAN = 0.7;
export const TEMPERA_ENTRANCE_SCALE_BASE = 0.6;
export const TEMPERA_ENTRANCE_SCALE_SPAN = 0.3;

/** 词盐（上游 `:316`）。 */
export const resolveTemperaWordSalt = (rowIndex: number, wordIndex: number): number => rowIndex * 37 + wordIndex;

/** 字形盐（上游 `:346`）。 */
export const resolveTemperaGlyphSalt = (wordSalt: number, glyphIndex: number): number =>
  wordSalt * 53 + glyphIndex;

/** 按"词"挑入场样式（上游 `:319~322`，盐 **193**）。 */
export const resolveTemperaEnterStyle = (seed: number, wordSalt: number): TemperaEnterStyle => {
  const index =
    Math.floor(temperaHash01(seed, wordSalt, 193) * TEMPERA_ENTER_STYLES.length) %
    TEMPERA_ENTER_STYLES.length;
  return TEMPERA_ENTER_STYLES[index] as TemperaEnterStyle;
};

/** 解一个字形的入场四项（上游逐字循环里的那几行，逐一对应）。 */
export const resolveTemperaEntrance = (input: TemperaEntranceInput): TemperaEntranceFields => {
  const wordSalt = resolveTemperaWordSalt(input.rowIndex, input.wordIndex);
  const glyphSalt = resolveTemperaGlyphSalt(wordSalt, input.glyphIndex);
  const spread = (temperaHash01(input.seed, glyphSalt, 149) - 0.5) * TEMPERA_ENTRANCE_SPREAD_RADIANS;
  const angle = input.baseAngle + spread;
  const magnitude =
    input.baseMagnitude *
    (TEMPERA_ENTRANCE_MAGNITUDE_BASE +
      temperaHash01(input.seed, glyphSalt, 151) * TEMPERA_ENTRANCE_MAGNITUDE_SPAN);
  return {
    enterStyle: resolveTemperaEnterStyle(input.seed, wordSalt),
    enterX: Math.cos(angle) * magnitude,
    enterY: Math.sin(angle) * magnitude,
    enterRotation: (temperaHash01(input.seed, glyphSalt, 157) - 0.5) * TEMPERA_ENTRANCE_ROTATION_SPAN,
    enterScale:
      TEMPERA_ENTRANCE_SCALE_BASE +
      temperaHash01(input.seed, glyphSalt, 163) * TEMPERA_ENTRANCE_SCALE_SPAN,
  };
};
