/**
 * 商籁「**每个词背后的局部固定几何**」的**帧级桥接**。
 *
 * 出处：folia-major `sonnet/sonnetTextViewBuilder.ts`（AGPL-3.0）。上游给每个**非装饰**、
 * **词形**、**有字形**的段按一个确定性 seed 掷一次骰子；命中就造一件几何，摆在**这个词自己的
 * placement** 上（`position = placement.x/y`、`rotation = placement.rotation`），
 * 并用**第一个字形**的入场时序驱动（`startTime / settleTime / enterX / enterY` 都取 `glyphs[0]`）。
 *
 * 本文件只算"哪些 run 命中、各自什么参数、时序怎么给"；几何本身在 `sonnetTextFixedGeo.ts`，
 * 运动仍复用 `sonnetGlyphMotion.ts` 的同一套纯函数（渲染层调用，本文件只把输入备齐）。
 *
 * === 与边框互斥（上游的硬约束）===
 * 上游注释："mutually exclusive with the frame decor so the two outline-style layers never stack
 * on the same segment." ⇒ 这里用与帧装饰**同一支**取档哈希判 `frameDecor` 是否命中，命中就不画。
 *
 * === 与上游的一处差异 ===
 * 上游 seed 的 `segmentIndex` 是段在行内的下标，这里取帧层的 **run 下标**（同一镜内同为递增）。
 */

import { resolveSonnetFrameDecorSpec } from './sonnetFrameDecor';
import {
  SONNET_FRAME_DECOR_SEED_SALT,
  SONNET_FRAME_DECOR_SEED_STRIDE,
} from './sonnetFrameDecorFrames';
import { mixSonnetSeed } from './sonnetGeo';

/** 非合唱镜的命中阈值（上游 `shapeThreshold = isChorusEffect ? 26 : 15`）。 */
export const SONNET_TEXT_GEO_THRESHOLD_SUPPORT = 15;
/** 合唱镜的命中阈值（上游 `26`）。 */
export const SONNET_TEXT_GEO_THRESHOLD_CHORUS = 26;
/** 上游"合唱效果"的额外判据：段落本身是 chorus，或 `(textSeed % 100) < 35`。 */
export const SONNET_TEXT_GEO_CHORUS_ROLL = 35;
/** 上游 seed 的段下标步长（`+ segmentIndex * 13`）。 */
export const SONNET_TEXT_GEO_SEED_STRIDE = 13;
/** 上游 `bgGlyph.zDepth = −0.5 − (seed % 5) * 0.1`（背景深度，供视差用）。 */
export const SONNET_TEXT_GEO_BASE_DEPTH = -0.5;
export const SONNET_TEXT_GEO_DEPTH_STRIDE = 0.1;

/** 帧层 `runs` 里本文件真正用到的字段（结构化类型 ⇒ 不绑死 `SonnetGlyphRun`）。 */
export interface SonnetTextGeoRunLike {
  readonly text: string;
  readonly fontPx: number;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly emphasis: boolean;
  readonly role: string;
  readonly isWordLike: boolean;
  readonly enterX: number;
  readonly enterY: number;
  /** 该 run 的**逐字追踪点**（`[0]` 就是"第一个字形"）；取不到就整条不出几何。 */
  readonly tracking?: readonly {
    readonly startTime: number;
    readonly settleTime: number;
  }[];
}

/**
 * 上游 `textSeed` 的算法：**逐 code unit 的字符码求和**，再加 `segmentIndex × 13`。
 * 用 `split('')`（code unit）而不是 `[...text]`（code point）—— 与上游同式。
 */
export function resolveSonnetTextGeoSeed(text: string, segmentIndex: number): number {
  return (
    text.split('').reduce((sum, character) => sum + character.charCodeAt(0), 0) +
    segmentIndex * SONNET_TEXT_GEO_SEED_STRIDE
  );
}

/** 第一个字形的入场时序（渲染层用它与字身**同一套**运动函数）。 */
export interface SonnetTextGeoMotion {
  readonly startTime: number;
  /** **首字的落位时刻**（来自 `placed.settleTime`），不是段的结束时间。 */
  readonly settleTime: number;
  readonly entryRotation: number;
  readonly enterX: number;
  readonly enterY: number;
  /** 这一串字自己的版式角度（与 `placement.rotation` 同一个数）。 */
  readonly finalRotation: number;
  readonly emphasis: boolean;
}

export interface SonnetTextGeoFrame {
  /** 该 run 在 `runs` 里的下标（渲染层用它做池化键）。 */
  readonly index: number;
  /** 上游那支 `textSeed`（`sonnetTextFixedGeo` 的 `seed`）。 */
  readonly seed: number;
  /** 上游的"合唱效果"判据（决定阈值 26/15 与几何的 `1.5 + …` 缩放）。 */
  readonly isChorusEffect: boolean;
  /** 本段最终字号（几何尺寸按它算）。 */
  readonly fontPx: number;
  /** `placement.x / y`（渲染层把节点放这里）。 */
  readonly x: number;
  readonly y: number;
  /** `placement.rotation`（渲染层设在节点上）；几何内部 `rotated-frame` 的 π/4 另算。 */
  readonly rotation: number;
  /** 背景深度（上游 `zDepth`）；渲染层按它算视差与 `depthScale`。 */
  readonly zDepth: number;
  /** 入场时序；**缺失 = 这条不入场**（渲染层直接跳过并隐藏该池节点）。 */
  readonly motion?: SonnetTextGeoMotion;
}

/** 本文件需要知道的最小上下文（都是帧层已有的量）。 */
export interface SonnetTextGeoFrameOptions {
  readonly frameShotSeed: number;
  readonly paragraphKind: string;
}

/**
 * 这一帧每个 run 的"背后几何"帧（**含未命中/被互斥掉的**：它们的 `motion` 缺省，渲染层据此隐藏）
 * —— 这样池节点与 run 下标一一对应，不会因为"命中数每帧变"而错位。
 */
export function resolveSonnetTextGeoFrames(
  runs: readonly SonnetTextGeoRunLike[],
  options: SonnetTextGeoFrameOptions,
): readonly SonnetTextGeoFrame[] {
  const frames: SonnetTextGeoFrame[] = [];
  runs.forEach((run, index) => {
    const seed = resolveSonnetTextGeoSeed(run.text, index);
    const isChorusParagraph = options.paragraphKind === 'chorus';
    /* 上游：`isChorusEffect = isChorusParagraph || ((textSeed % 100) < 35)`。 */
    const isChorusEffect = isChorusParagraph || seed % 100 < SONNET_TEXT_GEO_CHORUS_ROLL;
    const threshold = isChorusEffect
      ? SONNET_TEXT_GEO_THRESHOLD_CHORUS
      : SONNET_TEXT_GEO_THRESHOLD_SUPPORT;
    /* 上游：`resolveSonnetFrameDecorSpec(segment).applied` 为真就不画背后几何（互斥）。 */
    const frameDecorHash = mixSonnetSeed(
      options.frameShotSeed + index * SONNET_FRAME_DECOR_SEED_STRIDE,
      SONNET_FRAME_DECOR_SEED_SALT,
    );
    const hasFrameDecor = resolveSonnetFrameDecorSpec(frameDecorHash).applied;
    const firstGlyph = run.tracking?.[0];
    const eligible =
      run.role !== 'decoration' &&
      run.isWordLike &&
      firstGlyph !== undefined &&
      seed % 100 < threshold &&
      !hasFrameDecor;

    frames.push({
      index,
      seed,
      isChorusEffect,
      fontPx: run.fontPx,
      x: run.x,
      y: run.y,
      rotation: run.rotation,
      zDepth: SONNET_TEXT_GEO_BASE_DEPTH - (seed % 5) * SONNET_TEXT_GEO_DEPTH_STRIDE,
      motion: eligible
        ? {
            startTime: firstGlyph.startTime,
            /*
             * 落位时刻就是**首字自己**的 `settleTime`（由 `buildSonnetGlyphLayout` 按镜头时长算好）。
             * 不能拿段的 `endTime` 顶替：长词的首字会先落位，用段尾当落位时刻会让几何一直悬着。
             */
            settleTime: firstGlyph.settleTime,
            entryRotation: 0,
            /*
             * 入场矢量取 **placement 的 enterX/enterY**（上游 `bgGlyph` 用的就是
             * `placement.enterX / enterY`，不是逐字那对带交错的偏移）。
             */
            enterX: run.enterX,
            enterY: run.enterY,
            finalRotation: run.rotation,
            emphasis: run.emphasis,
          }
        : undefined,
    });
  });
  return frames;
}
