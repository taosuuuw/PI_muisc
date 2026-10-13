/**
 * 凝彩 = `tempera` 的**帧层**：由一个时刻算出这一帧要画什么（几何、颜色、字的位置与入场、装饰）。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**（`chthollyphile/folia-major@main`）。这里**只借鉴数值与做法**：
 * 构图的几何（各族的顶点、比例、入场位移与延迟）、相机插值与呼吸浮动、排版层级都在下面逐条注明出处，
 * **每个表达式都是在本仓库里重新写的**，没有拷贝任何 folia 源码文本。
 *
 * === 为什么先有"帧层"再有渲染层 ===
 * 帧层是纯函数（输入时间与视口，输出一串绘制规格），所以它能被单测钉住；渲染层只是把这些规格
 * 交给 Pixi 画出来。folia 把这两件事揉在 Pixi 的 `Graphics` 调用里，我们分开是为了可验证 ——
 * 毕竟 121 种构图不可能靠肉眼看一遍。
 *
 * === 覆盖范围（第 546 轮核对后更正；旧注释已过期约 100 轮，别再照它判断） ===
 * 早期这里写的是"只实现了 split 族 13 种、其余十二族走兜底、文字反色不做" —— **这三句都已不成立** ✗：
 * · **凝彩 121 种构图全部落地**（split 13 + band 9 + frame 10 + poster 10 + sparse 8 + cinema 7 +
 *   charm 9 + aperture 10 + signal 10 + corridor 10 + monolith 10 + terrain 10 + monogatari 5 = 121/121，
 *   见 `temperaCompositions.ts`）；`fallbackComposition` 已不被任何 kind 用到 ✓。
 * · **文字反色也已落地并接线** ✓（`temperaDifferenceFilter.ts`；调用点 `TemperaTheme.tsx:481` 与 `:753`）。
 * ⇒ 判断"缺不缺"时请现场 grep 自家树，**不要**引用本文件头的旧描述 ✓。
 */

import { clamp, estimateTextWidth } from './types';
import type { TemperaCompiledLine, TemperaProgram, TemperaShot } from './temperaProgram';
import { findTemperaShotAtTime, hashTemperaSeed, temperaHash01 } from './temperaProgram';
import { resolveTemperaShotProfile } from './temperaProfiles';
import { resolveTemperaInkContrast, resolveTemperaToneLadder } from './temperaPalette';
import type { TemperaShotKind } from './temperaKinds';
import {
  buildTemperaApertureComposition,
  buildTemperaBandComposition,
  buildTemperaCharmComposition,
  buildTemperaCinemaComposition,
  buildTemperaCorridorComposition,
  buildTemperaFrameComposition,
  buildTemperaMonolithComposition,
  buildTemperaMonogatariComposition,
  buildTemperaPosterComposition,
  buildTemperaSparseComposition,
  buildTemperaSignalComposition,
  buildTemperaTerrainComposition,
  fallbackComposition,
  packPanels,
  rectPolygon,
} from './temperaCompositions';
import { buildHatchSpec } from './temperaHatch';
import { planTemperaLayout, type TemperaPlanWord } from './temperaLayoutPlan';
import { applyTemperaGlyphTiming } from './temperaGlyphTiming';
import type { TemperaEnterStyle } from './temperaGlyphMotion';
import type { TemperaComposedPlacement } from './temperaRowLayout';
import type {
  RawPanel,
  TemperaCompositionSpec,
  TemperaPanelSpec,
  TemperaSeamSpec,
  TemperaStrokeSpec,
  TemperaViewport,
} from './temperaCompositions';
export { rectPolygon } from './temperaCompositions';

/** 视口外扩（出血）：相机移动与缩放时不该露出画面边缘。 */
export const resolveTemperaBleed = (viewport: TemperaViewport): number =>
  Math.max(viewport.width, viewport.height) * 0.08;

/** 四档明度（folia: `temperaPalette` 的 `tone1..tone4`，按 paper→deep 阶梯排）。 */
export interface TemperaTones {
  readonly paper: string;
  /** 阶梯的深（或"与纸色对比最强"）那一端。 */
  readonly deep: string;
  readonly accent: string;
  readonly tone: readonly [string, string, string, string];
}

/** 两档明度由纸色与深端插值而来（folia 是按亮度排序后拉到 `paper→ink` 的对应档位）。 */
export function resolveTemperaTones(
  paper: string,
  deep: string,
  accent: string,
  /** 上游 `duo` 档的 `tintB`（`theme.secondaryColor`）；不给就退化成纯中性阶梯。 */
  secondary?: string,
): TemperaTones {
  /*
   * ⚠ **第 240 轮修正**：四档停靠点照抄上游 `temperaPalette.ts:35` 的
   * `TEMPERA_TONE_STOPS = [0.12, 0.30, 0.52, 0.72]`（"fixed paper → ink mix positions"）。
   * 我们原先写的是 `0.16 / 0.46 / 0.72 / 0.94` —— **不是上游的数**（第 217 轮那条"数值待对账"
   * 的注记就是为这种情况留的；这次对上了，说明"留 ⬜"是值得的）。
   */
  /*
   * 墨色先过一道对比校正（第 686 轮接线）。校正后的墨既用作 `deep`，也喂给色阶阶梯 ⇒
   * 四档的深端一起变深，构图与文字的分量才和上游一致。
   */
  const contrastedDeep = resolveTemperaInkContrast(paper, deep);
  /*
   * ⚠ **"压缩取色阶梯"试过又撤了**（第 695 轮）。想法本身对（第 673/687/688/689 四轮过渡尝试、
   * 第 690~694 轮后处理压缩全败之后，"`jumpSum` 由构图取色的明暗跨度决定"是唯一站得住的判断），
   * 但**落点选错了**：`resolveTemperaTones` 是所有 shot 的取色入口，改它一次性弄红了
   * **8 个测试**（`temperaFrame.test.ts` + `temperaPalette.test.ts`），而且还得额外引 `mixColor`。
   * ⇒ 撤回，改到影响面小的落点（调用处对 `paper` / `deep` 做混合）再试。
   */
  return {
    paper,
    deep: contrastedDeep,
    accent,
    tone: resolveTemperaToneLadder(paper, contrastedDeep, accent, secondary),
  };
}

/* ------------------------------------------------------------------ *
 * 相机（folia: temperaCamera.ts）
 * ------------------------------------------------------------------ */

export interface TemperaCameraFrame {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly rotation: number;
}

const clamp01 = (value: number): number => clamp(value, 0, 1);
const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;
/*
 * **这条缓动必须留在相机层**（第 152 轮更正了第 129 轮的错误改动）。
 *
 * 上游 `tempera/temperaCamera.ts:12~15` 里，相机与呼吸用的就是这条**自写三次 in-out**
 * （`t < 0.5 ? 4t³ : 1 − (−2t+2)³/2`），**不是** `easeTemperaInOut`。
 * `easeTemperaInOut = cubic-bezier(0.62, 0, 0.32, 1)` 属于**字形运动层**（`temperaMotion.ts`），
 * 两者用途不同、数值也不同 —— 第 129 轮我把相机这里也换成了贝塞尔，是**误把"同名概念"当成同一个数**。
 * 现在改回上游原样；字形层那边仍用 `temperaGlyphMotion` 里的贝塞尔（那里是对的）。
 */
const easeInOut = (value: number): number => {
  const t = clamp01(value);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

/**
 * shot 级相机（folia: `resolveTemperaCameraFrame`）：在两个关键帧之间插值，
 * 缓动与匀速各占一半（中段不会"停住"），`progress` 略微超过 1 时继续漂出去（间隙里不冻帧）。
 * `x / y` 是**视口比例**，渲染层乘上视口尺寸再用。
 */
export function resolveTemperaCameraFrame(shot: TemperaShot, progress: number): TemperaCameraFrame {
  const eased = clamp01(progress) * 0.5 + easeInOut(clamp01(progress)) * 0.5;
  const overshoot = Math.max(0, progress - 1) * 0.35;
  const amount = eased + overshoot;
  return {
    x: lerp(shot.camera.x, shot.cameraEnd.x, amount),
    y: lerp(shot.camera.y, shot.cameraEnd.y, amount),
    scale: lerp(shot.camera.zoom, shot.cameraEnd.zoom, amount),
    rotation: lerp(shot.camera.rotation, shot.cameraEnd.rotation, amount),
  };
}

/** 手持呼吸浮动的上限（folia: `TEMPERA_CAMERA_BREATH_*`）。 */
export const TEMPERA_CAMERA_BREATH_MAX_OFFSET = 0.006;
export const TEMPERA_CAMERA_BREATH_MAX_SCALE = 0.002;
export const TEMPERA_CAMERA_BREATH_MAX_ROTATION = 0.0015;

/**
 * 呼吸浮动（folia: `resolveTemperaCameraBreath`）：三组**不可通约**的正弦叠起来，
 * 读起来像手持而不是机器摆动；用绝对时间求值，所以拖动进度条与正常播放逐帧一致。
 */
export function resolveTemperaCameraBreath(time: number, phase = 0): TemperaCameraFrame {
  const tau = time * Math.PI * 2;
  return {
    x:
      (Math.sin(tau * 0.13 + phase) * 0.65 + Math.sin(tau * 0.31 + phase * 1.7) * 0.35) *
      TEMPERA_CAMERA_BREATH_MAX_OFFSET,
    y:
      (Math.cos(tau * 0.11 + phase * 2.3) * 0.65 + Math.sin(tau * 0.29 + phase * 0.9) * 0.35) *
      TEMPERA_CAMERA_BREATH_MAX_OFFSET,
    scale: Math.sin(tau * 0.09 + phase * 1.3) * TEMPERA_CAMERA_BREATH_MAX_SCALE,
    rotation: Math.sin(tau * 0.07 + phase * 2.9) * TEMPERA_CAMERA_BREATH_MAX_ROTATION,
  };
}

/** 呼吸浮动的权重：歌词入场走完之后 1.2s 内逐渐加进来（folia: `resolveTemperaBreathWeight`）。 */
export function resolveTemperaBreathWeight(
  time: number,
  revealDoneTime: number,
  rampDuration = 1.2,
): number {
  if (rampDuration <= 0) return time >= revealDoneTime ? 1 : 0;
  return easeInOut(clamp01((time - revealDoneTime) / rampDuration));
}

/* ------------------------------------------------------------------ *
 * 构图：split 族（folia: compositions/temperaSplitCompositions.ts）
 *
 * 公共类型、装配工具与 band 族都在 `temperaCompositions.ts` 里；这里只放 split 族，
 * 并在 default 分支把还没实现的族交给「band 族工厂 → 兜底构图」。
 * ------------------------------------------------------------------ */

/** 构图的公共类型与工具从 `temperaCompositions.ts` 转出（保持这里的导入路径可用）。 */
export type {
  TemperaCompositionSpec,
  TemperaHatchSurface,
  TemperaPanelSpec,
  TemperaSeamSpec,
  TemperaStrokeSpec,
  TemperaViewport,
} from './temperaCompositions';

/**
 * split 族的 13 种构图（folia: `compositions/temperaSplitCompositions.ts`）。
 * 顶点、比例、切点随机、入场位移都照它的数值；`bleed` 是我们的出血量。
 */
export function buildTemperaComposition(
  kind: TemperaShotKind,
  seed: number,
  viewport: TemperaViewport,
  bleed: number,
  /** 这一镜的流向（弧度）：`signal` 族的轴要顺着它，别的族用不上。 */
  flowAngle = Math.PI / 2,
): TemperaCompositionSpec {
  const { width, height } = viewport;
  /*
   * split 族的"其中一块叠网线"（folia 的 `addPanels` + `buildHatchSpec(seed, 5)`）：
   * 静默的同一块面板上加一层网线，画面就不会读成矢量色块。
   */
  const hatchSurface = { spec: buildHatchSpec(seed, 5), tone: 3, alpha: 0.5, grow: true };
  const panels = (list: readonly RawPanel[], hatchIndex: number): TemperaCompositionSpec => ({
    panels: packPanels(list, hatchIndex, hatchSurface),
    seams: [],
    strokes: [],
    fallback: false,
  });
  const withSeams = (
    list: readonly RawPanel[],
    hatchIndex: number,
    seams: readonly TemperaSeamSpec[],
  ): TemperaCompositionSpec => ({
    panels: packPanels(list, hatchIndex, hatchSurface),
    seams,
    strokes: [],
    fallback: false,
  });

  switch (kind) {
    case 'duo-split': {
      const horizontal = temperaHash01(seed, 1, 3) > 0.5;
      return withSeams(
        horizontal
          ? [
              {
                polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height * 0.52 + bleed),
                tone: 0,
                enterDX: 0,
                enterDY: -height * 0.55,
              },
              {
                polygon: rectPolygon(-bleed, height * 0.52, width + bleed * 2, height * 0.48 + bleed),
                tone: 2,
                enterDX: 0,
                enterDY: height * 0.55,
              },
            ]
          : [
              {
                polygon: rectPolygon(-bleed, -bleed, width * 0.5 + bleed, height + bleed * 2),
                tone: 0,
                enterDX: -width * 0.5,
                enterDY: 0,
              },
              {
                polygon: rectPolygon(width * 0.5, -bleed, width * 0.5 + bleed, height + bleed * 2),
                tone: 2,
                enterDX: width * 0.5,
                enterDY: 0,
              },
            ],
        0,
        [
          {
            points: horizontal
              ? rectPolygon(-bleed, height * 0.52 - 1.5, width + bleed * 2, 3)
              : rectPolygon(width * 0.5 - 1.5, -bleed, 3, height + bleed * 2),
            delay: 0.16,
          },
        ],
      );
    }
    case 'quad-split': {
      const splitX = width * (0.42 + temperaHash01(seed, 2, 7) * 0.16);
      const splitY = height * (0.42 + temperaHash01(seed, 3, 11) * 0.16);
      return withSeams(
        [
          {
            polygon: rectPolygon(-bleed, -bleed, splitX + bleed, splitY + bleed),
            tone: 0,
            enterDX: -width * 0.3,
            enterDY: -height * 0.3,
          },
          {
            polygon: rectPolygon(splitX, -bleed, width - splitX + bleed, splitY + bleed),
            tone: 3,
            enterDX: width * 0.3,
            enterDY: -height * 0.3,
          },
          {
            polygon: rectPolygon(-bleed, splitY, splitX + bleed, height - splitY + bleed),
            tone: 2,
            enterDX: -width * 0.3,
            enterDY: height * 0.3,
          },
          {
            polygon: rectPolygon(splitX, splitY, width - splitX + bleed, height - splitY + bleed),
            tone: 1,
            enterDX: width * 0.3,
            enterDY: height * 0.3,
          },
        ],
        3,
        [
          { points: rectPolygon(splitX - 1.5, -bleed, 3, height + bleed * 2), delay: 0.2 },
          { points: rectPolygon(-bleed, splitY - 1.5, width + bleed * 2, 3), delay: 0.24 },
        ],
      );
    }
    case 'tri-column': {
      const edge = width * (0.26 + temperaHash01(seed, 4, 13) * 0.06);
      return panels(
        [
          {
            polygon: rectPolygon(-bleed, -bleed, edge + bleed, height + bleed * 2),
            tone: 0,
            enterDX: -width * 0.25,
            enterDY: 0,
          },
          {
            polygon: rectPolygon(edge, -bleed, width - edge * 2, height + bleed * 2),
            tone: 3,
            enterDX: 0,
            enterDY: -height * 0.3,
          },
          {
            polygon: rectPolygon(width - edge, -bleed, edge + bleed, height + bleed * 2),
            tone: 0,
            enterDX: width * 0.25,
            enterDY: 0,
          },
        ],
        0,
      );
    }
    case 'thirds-stack': {
      const band = height * 0.34;
      return panels(
        [
          {
            polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, band + bleed),
            tone: 1,
            enterDX: -width * 0.2,
            enterDY: 0,
          },
          {
            polygon: rectPolygon(-bleed, band, width + bleed * 2, band),
            tone: 3,
            enterDX: width * 0.2,
            enterDY: 0,
          },
          {
            polygon: rectPolygon(-bleed, band * 2, width + bleed * 2, height - band * 2 + bleed),
            tone: 0,
            enterDX: -width * 0.2,
            enterDY: 0,
          },
        ],
        0,
      );
    }
    case 'checker-quad': {
      const splitX = width * 0.5;
      const splitY = height * 0.5;
      return panels(
        [
          {
            polygon: rectPolygon(-bleed, -bleed, splitX + bleed, splitY + bleed),
            tone: 3,
            enterDX: 0,
            enterDY: -height * 0.35,
          },
          {
            polygon: rectPolygon(splitX, -bleed, width - splitX + bleed, splitY + bleed),
            tone: 0,
            enterDX: 0,
            enterDY: -height * 0.35,
          },
          {
            polygon: rectPolygon(-bleed, splitY, splitX + bleed, height - splitY + bleed),
            tone: 0,
            enterDX: 0,
            enterDY: height * 0.35,
          },
          {
            polygon: rectPolygon(splitX, splitY, width - splitX + bleed, height - splitY + bleed),
            tone: 3,
            enterDX: 0,
            enterDY: height * 0.35,
          },
        ],
        1,
      );
    }
    case 'corner-wedge': {
      const fromLeft = temperaHash01(seed, 5, 17) > 0.5;
      const apexX = fromLeft ? width * 0.78 : width * 0.22;
      return panels(
        [
          {
            polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
            tone: 0,
            enterDX: 0,
            enterDY: 0,
          },
          {
            polygon: fromLeft
              ? [-bleed, -bleed, apexX, -bleed, -bleed, height + bleed]
              : [width + bleed, -bleed, apexX, -bleed, width + bleed, height + bleed],
            tone: 3,
            enterDX: fromLeft ? -width * 0.4 : width * 0.4,
            enterDY: 0,
          },
        ],
        1,
      );
    }
    case 'diagonal-halves': {
      const lean = height * (0.2 + temperaHash01(seed, 6, 19) * 0.3);
      return panels(
        [
          {
            polygon: [-bleed, -bleed, width + bleed, -bleed, width + bleed, lean, -bleed, height - lean],
            tone: 1,
            enterDX: 0,
            enterDY: -height * 0.4,
          },
          {
            polygon: [
              -bleed,
              height - lean,
              width + bleed,
              lean,
              width + bleed,
              height + bleed,
              -bleed,
              height + bleed,
            ],
            tone: 3,
            enterDX: 0,
            enterDY: height * 0.4,
          },
        ],
        1,
      );
    }
    case 'cross-axis': {
      const barX = width * 0.11;
      const barY = height * 0.13;
      return {
        panels: [
          {
            points: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
            tone: 0,
            alpha: 0.9,
            delay: 0,
            span: 0.5,
            enter: [0, 0],
            hatch: null,
            rotation: 0,
            pivot: null,
            holes: [],
          },
          {
            points: rectPolygon((width - barX) / 2, -bleed, barX, height + bleed * 2),
            tone: 3,
            alpha: 0.95,
            delay: 0.06,
            span: 0.5,
            enter: [0, -height * 0.5],
            hatch: null,
            rotation: 0,
            pivot: null,
            holes: [],
          },
          {
            points: rectPolygon(-bleed, (height - barY) / 2, width + bleed * 2, barY),
            tone: 2,
            alpha: 0.95,
            delay: 0.12,
            span: 0.5,
            enter: [width * 0.5, 0],
            hatch: null,
            rotation: 0,
            pivot: null,
            holes: [],
          },
        ],
        seams: [],
        strokes: [],
        fallback: false,
      };
    }
    case 'offset-halves': {
      const step = height * (0.06 + temperaHash01(seed, 7, 23) * 0.06);
      const seam = width * 0.48;
      return panels(
        [
          {
            polygon: rectPolygon(-bleed, -bleed, seam + bleed, height * 0.5 + step + bleed),
            tone: 0,
            enterDX: -width * 0.3,
            enterDY: 0,
          },
          {
            polygon: rectPolygon(seam, -bleed, width - seam + bleed, height * 0.5 - step + bleed),
            tone: 2,
            enterDX: width * 0.3,
            enterDY: 0,
          },
          {
            polygon: rectPolygon(-bleed, height * 0.5 + step, seam + bleed, height * 0.5 - step + bleed),
            tone: 3,
            enterDX: -width * 0.2,
            enterDY: 0,
          },
          {
            polygon: rectPolygon(seam, height * 0.5 - step, width - seam + bleed, height * 0.5 + step + bleed),
            tone: 1,
            enterDX: width * 0.2,
            enterDY: 0,
          },
        ],
        2,
      );
    }
    case 'stair-blocks': {
      const tones = [0, 1, 2, 3];
      const steps: RawPanel[] = [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
        },
      ];
      tones.forEach((tone, index) => {
        steps.push({
          polygon: rectPolygon(
            width * (0.06 + index * 0.2),
            height * (0.1 + index * 0.16),
            width * 0.3,
            height * 0.34,
          ),
          tone,
          enterDX: -width * 0.2,
          enterDY: height * 0.12,
        });
      });
      return panels(steps, 0);
    }
    case 'pillar-gap': {
      const gap = width * (0.26 + temperaHash01(seed, 8, 29) * 0.08);
      const side = (width - gap) / 2;
      return panels(
        [
          {
            polygon: rectPolygon(-bleed, -bleed, side + bleed, height + bleed * 2),
            tone: 3,
            enterDX: -width * 0.3,
            enterDY: 0,
          },
          {
            polygon: rectPolygon(width - side, -bleed, side + bleed, height + bleed * 2),
            tone: 3,
            enterDX: width * 0.3,
            enterDY: 0,
          },
        ],
        1,
      );
    }
    case 'corner-quad': {
      const splitX = width * (0.6 + temperaHash01(seed, 9, 31) * 0.12);
      const splitY = height * (0.62 + temperaHash01(seed, 10, 37) * 0.1);
      return panels(
        [
          {
            polygon: rectPolygon(-bleed, -bleed, splitX + bleed, splitY + bleed),
            tone: 1,
            enterDX: 0,
            enterDY: -height * 0.25,
          },
          {
            polygon: rectPolygon(splitX, -bleed, width - splitX + bleed, splitY + bleed),
            tone: 3,
            enterDX: width * 0.25,
            enterDY: 0,
          },
          {
            polygon: rectPolygon(-bleed, splitY, splitX + bleed, height - splitY + bleed),
            tone: 0,
            enterDX: -width * 0.25,
            enterDY: 0,
          },
          {
            polygon: rectPolygon(splitX, splitY, width - splitX + bleed, height - splitY + bleed),
            tone: 2,
            enterDX: 0,
            enterDY: height * 0.25,
          },
        ],
        0,
      );
    }
    case 'sliver-stack': {
      const fromLeft = temperaHash01(seed, 11, 41) > 0.5;
      const slabWidth = width * 0.46;
      const left = fromLeft ? -bleed : width - slabWidth;
      const list: RawPanel[] = [
        {
          polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2),
          tone: 0,
          enterDX: 0,
          enterDY: 0,
        },
      ];
      const count = 9;
      const sliver = (height + bleed * 2) / count;
      for (let index = 0; index < count; index += 1) {
        if (index % 2 === 1) continue;
        list.push({
          polygon: rectPolygon(left, -bleed + sliver * index, slabWidth + bleed, sliver),
          tone: 3,
          enterDX: (fromLeft ? -1 : 1) * width * 0.2,
          enterDY: 0,
        });
      }
      return panels(list, 0);
    }
    default: {
      // 依次问已经落地的族（band → frame → poster → sparse → cinema → charm），都不是才落到兜底构图。
      const band = buildTemperaBandComposition(kind, seed, viewport, bleed);
      if (band !== null) return band;
      const frameFamily = buildTemperaFrameComposition(kind, seed, viewport, bleed);
      if (frameFamily !== null) return frameFamily;
      const poster = buildTemperaPosterComposition(kind, seed, viewport, bleed);
      if (poster !== null) return poster;
      const sparse = buildTemperaSparseComposition(kind, seed, viewport, bleed);
      if (sparse !== null) return sparse;
      const cinema = buildTemperaCinemaComposition(kind, seed, viewport, bleed);
      if (cinema !== null) return cinema;
      const charm = buildTemperaCharmComposition(kind, seed, viewport, bleed);
      if (charm !== null) return charm;
      const aperture = buildTemperaApertureComposition(kind, seed, viewport, bleed);
      if (aperture !== null) return aperture;
      const signal = buildTemperaSignalComposition(kind, seed, viewport, bleed, flowAngle);
      if (signal !== null) return signal;
      const corridor = buildTemperaCorridorComposition(kind, seed, viewport, bleed, flowAngle);
      if (corridor !== null) return corridor;
      const monolith = buildTemperaMonolithComposition(kind, seed, viewport, bleed);
      if (monolith !== null) return monolith;
      const terrain = buildTemperaTerrainComposition(kind, seed, viewport, bleed);
      if (terrain !== null) return terrain;
      const monogatari = buildTemperaMonogatariComposition(kind, seed, viewport, bleed);
      return monogatari ?? fallbackComposition(viewport, bleed);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 排版与入场（folia: temperaLayout.ts / temperaEnterStyles.ts 的数值骨架）
 * ------------------------------------------------------------------ */

export interface TemperaGlyphSpec {
  readonly text: string;
  /**
   * **字素中心**（px），与上游 `TemperaGlyphPlacement` 同一口径 ——
   * 那边 `display.anchor.set(0.5)` 之后直接 `position.set(placement.x, placement.y)`。
   */
  readonly x: number;
  readonly y: number;
  readonly fontPx: number;
  readonly color: string;
  /** 入场延迟（相对 shot 起点的**秒**）。 */
  readonly delay: number;
  /** 入场时长（秒）。 */
  readonly span: number;
  /** 入场位移（px，从该处滑到 0）。 */
  readonly enter: readonly [number, number];
  /*
   * 以下六个字段来自**时序层**（上游 `applyGlyphTiming`），第 175 轮先把**接口**开好，
   * 接线分两步、不必一次改完；**全部可选** ⇒ 现有构造点与主题端不受影响（不读就是忽略）。
   *
   * 语义（照抄上游）：`startTime/endTime` 是该字素的**真实**歌词时间（秒）；
   * `settleTime` 是"落定"时刻（入场结束）、`releaseTime` 是"离场"时刻；
   * `trackingX/Y` 是从**所在行/块的中心**指向该字素的力臂（px），离场时按它甩出去。
   */
  readonly startTime?: number;
  readonly endTime?: number;
  readonly settleTime?: number;
  readonly releaseTime?: number;
  readonly trackingX?: number;
  readonly trackingY?: number;
  /**
   * 该字素所属**排版行号**（时序层用它分组算 `releaseTime`，第 191 轮起已在 push 处填上）。
   */
  readonly lineIndex?: number;
  /*
   * 入场样式三项（第 195 轮补开）：运动层 `resolveTemperaGlyphMotion` 的入参是**全必填**的，
   * 其中 `enterStyle` 决定"从哪个方向/什么形态进来"，`enterRotation/enterScale` 是它的幅度。
   * 计划层（`TemperaComposedPlacement`）本来就产出这三项，帧层先前只是没往 spec 上带。
   */
  readonly enterStyle?: TemperaEnterStyle;
  readonly enterRotation?: number;
  readonly enterScale?: number;
  /**
   * 逐字旋转（计划层 `placement.rotation`：区域 + 行 + 词三层旋转之和）。
   * 第 199 轮补开 —— 运动层的入参里 `rotation` 是**必填**，而它正是"凝彩看起来像拼贴"的一部分。
   */
  readonly rotation?: number;
  /**
   * **运动回响的拖尾色**（第 615 轮新增，接 `temperaGlyphEcho.ts`）。
   *
   * 照抄上游 `temperaTextView.ts` 的 `fill: placement.color ?? palette.tone4`：
   * **命中了词色的字素**（我们这边 = hero 词，`color` 已被换成主题色）用自己那一色，
   * 其余一律用 **色阶第 4 档**（`tones.tone[3]`，即 `paper → ink` 混 72% 那一档）。
   *
   * 为什么不能直接拿 `color` 当拖尾色：非 hero 字的 `color` 是**歌词墨色**
   * （`--pi-lyric-ink`，暗档近白）—— 回响层**不挂反色滤镜**，那抹白会原样糊在浅纸色块上，
   * 拖尾就不是"运动"而是一块脏白。上游正是靠 `tone4` 把拖尾钉在中间调上。
   */
  readonly echoColor?: string;
  /**
   * **这个字素是否走 keyword 层**（第 618 轮新增，对应上游
   * `(placement.color ? keywordLayer : textLayer).addChild(display)`）。
   *
   * 为真 ⇒ 渲染层把它放进**不挂反色滤镜**的 `keywordLayer`，主题色才能活下来；
   * 否则进反色层（`textLayer`）。`undefined` 与 `false` 等价（未着色的普通字素）。
   *
   * ⚠ **我们只对"真命中词色"的 hero 词置位**，不用 `color !== inkColor`：
   * hero 词拿 `accentColor` 兜底时也是"彩色"，但那会让整个切片退出反色层（见构造处的注释）。
   *
   * ⚠ 注意**只影响正文 `display`**：阴影拷贝仍然照上游留在反色层最底
   * （上游 `textLayer.addChildAt(shadow, 0)` 不看 `placement.color`）。
   */
  readonly keyword?: boolean;
}

/** hero 词放大倍率区间（folia: 每行一个 hero 词放大到 1.34~1.6×）。 */
export const TEMPERA_HERO_SCALE = [1.34, 1.6] as const;
/** 其余词的压缩区间（folia: 0.7~0.86×）。 */
export const TEMPERA_REST_SCALE = [0.7, 0.86] as const;
/** 字素入场的错落步长（秒）。 */
export const TEMPERA_GLYPH_STAGGER = 0.045;
/** 字素入场时长（秒）。 */
export const TEMPERA_GLYPH_REVEAL = 0.5;
/**
 * 每镜最底那层**满幅纸**的不透明度（上游 `temperaSceneBuilder.ts:411` 的
 * `.fill({ color: palette.paper, alpha: 0.35 })`）。
 *
 * ⚠ 这一层是"凝彩"读起来像**印刷品**的地基：它铺满整个 shot、压在色块之下，
 * 于是块与块之间的空档永远是**纸**、而不是外壳的模糊封面。
 * 没有它，留白就等于背景穿帮（第 620 轮补上，见 `TemperaTheme` 的 `wash` 层）。
 */
export const TEMPERA_PAPER_WASH_ALPHA = 0.35;
/**
 * 每镜那层**方点阵**（上游 `temperaSceneBuilder.ts:416~418`）：
 * `drawSquareMarks(pixi, buildDotGrid(w, h, max(26, √(w·h / 6000)), 1.6), palette.tone4, 0.05)`。
 *
 * 它压在满幅纸**之上**、色块**之下**，给整幅画面一层印刷网点。视觉贡献很小（1.6px 方块、5% 不透明度），
 * 但少了它，纸面就是"数字纯色"而不是"印上去的"。
 */
export const TEMPERA_SCREENTONE_ALPHA = 0.05;
/** 方点阵间距的下限（上游 `Math.max(26, …)`）。 */
export const TEMPERA_SCREENTONE_SPACING_MIN = 26;
/** 方点阵间距算式里的面积分母（上游 `√(width × height / 6000)`）。 */
export const TEMPERA_SCREENTONE_AREA_DIVISOR = 6000;
/** 方块的边长（上游 `buildDotGrid(..., 1.6)`）。 */
export const TEMPERA_SCREENTONE_SIZE = 1.6;

/**
 * 方点阵的间距：`max(26, √(width × height / 6000))`（上游 `:416` 原式）。
 * 视觉密度与视口大小挂钩 —— 大约是"任何屏幕上都铺 3k 个点"那个量级。
 */
export const resolveTemperaScreentoneSpacing = (width: number, height: number): number =>
  Math.max(
    TEMPERA_SCREENTONE_SPACING_MIN,
    Math.sqrt((width * height) / TEMPERA_SCREENTONE_AREA_DIVISOR),
  );
/**
 * 页边散字的不透明度（上游 `temperaTextView.ts:166` 的 `node.alpha = 0.42`）。
 *
 * ⚠ 它是**恒定值、没有时间轴** —— 上游注释原话："They carry no timeline:
 * the shot's own enter/exit alpha covers them, so playback never touches these nodes."
 * 即淡入淡出由 **shot 容器**承担。我们此前自加了 `clamp(elapsed / 0.6)` 的淡入，
 * 第 617 轮照上游去掉。
 */
export const TEMPERA_FRAGMENT_ALPHA = 0.42;
/** 超大装饰词的不透明度（上游 `temperaTextView.ts:205` 的 `node.alpha = 0.16`），同样无时间轴。 */
/**
 * 装饰大字（`watermark` 层）的不透明度。
 *
 * ⚠ 第 723 轮曾把它从 0.16 提到 0.42，**已回滚**，原因是两条硬约束：
 *
 * 1. `temperaFrame.test.ts:162` 直接断言 `toBe(0.16)` —— 那是一条**对账上游**的测试，
 *    改值就等于单方面偏离上游口径；
 * 2. **更关键**：我**还没有验证**「folia 录屏 `frame-063.jpg` 里那个清晰的大字」
 *    到底是不是 `watermark` 这一层。它可能是另一种元素（比如"歌词大字"/装饰字，
 *    走别的 alpha）。**在没确认之前改这个值，很可能是在改一个本来正确的地方。**
 *
 * ⇒ 待办：先确认 folia 那层大字的身份（对照它是否随 `decorBaseFontSize` 缩放、
 * 是否与翻译字幕同层），再决定 0.16 该不该动。依据不足就不改。
 */
export const TEMPERA_WATERMARK_ALPHA = 0.16;

/**
 * 一个 shot 的歌词排版（folia 的拼贴排版的**单行简化版**）。
 *
 * folia 会把一行排成多行、按词的层级错落；我们这一版把本 shot 的词排在一条水平线上，
 * 其中一个词当 hero 放大（第一个 `isWordLike` 词），其余压小 —— 视觉重心与「拼上去」的读法在，
 * 多行重排留到排版批再补（照实记在文件头）。
 */
export function layoutTemperaGlyphs(input: {
  readonly shot: TemperaShot;
  readonly lines: readonly TemperaCompiledLine[];
  readonly viewport: TemperaViewport;
  readonly inkColor: string;
  readonly accentColor: string;
  readonly wordColorOf: (text: string, fallback: string) => string;
  readonly timeSec: number;
  /**
   * 本镜的**数值种子**（第 159 轮新增）。
   *
   * 计划层处处依赖它（逐词字号盐 101/103/107、行预算盐 109/113、入场盐 149/151/157/163/193），
   * 所以这里必须显式传：调用方按 `hashTemperaSeed(\`${program.seed}:${shot.id}:layout\`)` 生成，
   * 与既有 `cameraSeed` 的取法同源（确定性、可 seek）。
   */
  readonly seed: number;
  /**
   * **运动回响的拖尾色**（第 615 轮新增，可选项）。
   *
   * 对应上游的 `palette.tone4` —— 色阶第 4 档（`paper → ink` 的 0.72 停靠点）。
   * 由帧层传 `tones.tone[3]`；**不传就不写 `echoColor`**（渲染层退回用字色），
   * 这样既有的构造点与用例不受影响。
   */
  readonly echoTone?: string;
}): TemperaGlyphSpec[] {
  const { shot, lines, viewport, inkColor, accentColor, wordColorOf, timeSec, seed, echoTone } =
    input;
  const profile = resolveTemperaShotProfile(shot.kind);
  const sliceResults = shot.slices
    .map((slice) => ({
      line: lines.find((item) => item.sourceIndex === slice.lineIndex),
      slice,
    }))
    .filter((item) => item.line !== undefined);
  if (sliceResults.length === 0) return [];

  const [regionCx, regionCy, regionWRaw, regionHRaw] = profile.region;
  /*
   * **排版框放大器**（第 772 轮；主人第 769 轮选 A："一行一镜 + 把字放大"）。
   *
   * 第 770 轮已用测试证明「**块更大（切得少）**」与「**字更大**」被**排版框**锁在一起：
   * 块变大 ⇒ 同宽的框里塞不下 ⇒ fit loop 只能压小字号（这就是"一行一镜 ⇒ 字小"的成因）。
   * ⇒ 两个诉求要同时成立，**必须把框放大**。
   *
   * ⚠ 这里**不动 `temperaProfiles.ts` 的原始数据** —— 那份 `region` 被
   * `temperaProfilesValues.test.ts` 逐条与上游对账；只在**渲染时**按系数放框，
   * 于是"与上游对账"不受影响。钳在 1 以内，保证框不出舞台。
   */
  const TEMPERA_REGION_SCALE = 1.35;
  const regionW = Math.min(1, regionWRaw * TEMPERA_REGION_SCALE);
  const regionH = Math.min(1, regionHRaw * TEMPERA_REGION_SCALE);
  /*
   * 排版框：`cx / cy` 是框中心（视口比例），`w / h` 是框的宽高；`align` 是**框内**文字的对齐
   * （folia 的 `TemperaShotRegion` 就是这么定义的），所以框本身永远居中在 `(cx, cy)`。
   */
  /*
   * ⚠ **框必须钳在舞台之内**（第 775 轮）—— 这是第 772 轮"放大 1.35 倍"引入的**回归**：
   * 构图中心 `cx / cy` 并不总是 0.5（有 0.44 / 0.46 / 0.52 等），框一放宽就会越出画面，
   * 于是主人看到「**比较大的歌词会显示到框外**」。
   * 做法：先把宽高钳到舞台尺寸，再把左上角钳进 `[0, 舞台 − 框]` ⇒ 框永远完整留在画面里。
   */
  const boxWidth = Math.min(regionW * viewport.width, viewport.width);
  const boxHeight = Math.min(regionH * viewport.height, viewport.height);
  const boxLeft = Math.min(
    Math.max(regionCx * viewport.width - boxWidth / 2, 0),
    viewport.width - boxWidth,
  );
  const boxTop = Math.min(
    Math.max(regionCy * viewport.height - boxHeight / 2, 0),
    viewport.height - boxHeight,
  );
  const box = {
    left: boxLeft,
    top: boxTop,
    width: boxWidth,
    height: boxHeight,
  };

  const segments = sliceResults.flatMap((item) =>
    (item.line?.segments ?? []).slice(item.slice.segmentStart, item.slice.segmentEnd),
  );
  if (segments.length === 0) return [];

  const heroIndex = segments.findIndex((segment) => segment.isWordLike);
  /*
   * **排版交给计划层**（第 161 轮接线）：三块哈希（逐词字号 101/103/107、行预算 109/113、
   * 入场 149/151/157/163/193）与"多行 + 逐词旋转 + 三层旋转落点"都在那边实现并有用例。
   *
   * 两点说明：
   * · `baseFontSize` 传区域高即可 —— 拟合对它的**绝对值不敏感**（宽度、间距都随字号线性缩放，
   *   断点与比例是尺度无关的），拟合会把它收下来；
   * · `profile.region` 在我们这边是数组 `[cx, cy, w, h]`，计划层要对象 ⇒ 这里换算一次，
   *   **不动 profile 数据**（免得连带动既有用例）。
   */
  const segmentLines = sliceResults.flatMap((item) =>
    (item.line?.segments ?? [])
      .slice(item.slice.segmentStart, item.slice.segmentEnd)
      .map(() => item.slice.lineIndex),
  );
  const planWords: TemperaPlanWord[] = segments.map((segment, index) => ({
    lineIndex: segmentLines[index] ?? 0,
    glyphs: segment.graphemes.map((grapheme) => grapheme.text).filter((text) => text.trim().length > 0),
    isWordLike: segment.isWordLike === true,
    // 与旧口径等价：**上一个词**含空白 ⇒ 这个词的前置间距给"一个空格"那档。
    spacedBefore: index > 0 && /\s/u.test(segments[index - 1]?.text ?? ''),
    segmentIndex: index,
  }));
  const plan = planTemperaLayout({
    seed,
    region: {
      centerX: boxLeft + boxWidth / 2,
      centerY: boxTop + boxHeight / 2,
      width: boxWidth,
      height: boxHeight,
      align: profile.align ?? 'center',
      rotation: 0,
    },
    baseFontSize: Math.max(8, box.height),
    fontScale: profile.fontScale ?? 1,
    lines: [planWords],
    measure: (char, fontPx) => estimateTextWidth(char, fontPx, 0),
    enter: profile.enter,
  });
  /** 按 `段序号:字素序号` 查计划里的落点（中心坐标 + 字号 + 入场向量）。 */
  const placementOf = new Map<string, TemperaComposedPlacement>();
  plan.placements.forEach((placement) => {
    placementOf.set(`${placement.segmentIndex}:${placement.glyphIndex}`, placement);
  });
  const glyphs: TemperaGlyphSpec[] = [];
  let glyphOrder = 0;

  segments.forEach((segment, wordIndex) => {
    const wordColor = wordColorOf(segment.text, inkColor);
    /*
     * 只有 **hero 词**吃词色 / 强调色，其余字一律用歌词墨色。
     * folia 是把「命中的关键词」放到 `keywordLayer` 上色（不挂 difference filter），
     * 而我们的 `wordColors` 是按封面情绪生成的、命中面比它宽 —— 整句都上色会把色块构图糊掉
     * （第一版实测就是整句亮绿）。这条取舍写在文件头。
     */
    const isHeroWord = wordIndex === heroIndex && segment.isWordLike;
    const color = isHeroWord
      ? wordColor !== inkColor
        ? wordColor
        : accentColor
      : inkColor;
    for (const [glyphIndex, grapheme] of segment.graphemes.entries()) {
      const placement = placementOf.get(`${wordIndex}:${glyphIndex}`);
      // 计划里没有（例如纯空白字素）⇒ 跳过，但**仍然推进序号**，保持入场错落的节奏。
      if (placement === undefined) {
        glyphOrder += 1;
        continue;
      }
      glyphs.push({
        text: grapheme.text,
        /*
         * **中心点，不再换算成左上角**（第 616 轮）。
         *
         * 此前这里写 `x - 半宽` / `y − 字号 × 0.62`，为的是配合渲染层 `anchor` 默认的 `(0, 0)`。
         * 代价是**逐字旋转绕的是字形左上角**，而上游是 `display.anchor.set(0.5)` ⇒ 绕字形中心转
         * （`tempera/temperaTextView.ts:55`）。凝彩每个字素的旋转都是三层之和（区域 + 行 + 词），
         * 绕错点会让字在旋转时**整块甩出去**，这正是"拼贴"读起来不像上游的原因。
         * 现在两边口径统一成"中心"：渲染层设 `anchor(0.5)`，这里直接给计划层的中心点。
         */
        x: placement.x,
        y: placement.y,
        fontPx: placement.fontSize,
        color,
        // 入场错落：按字素序号推进（folia 的逐字素入场节奏）。
        delay: glyphOrder * TEMPERA_GLYPH_STAGGER,
        span: TEMPERA_GLYPH_REVEAL,
        // 位移向量直接取计划算好的（已是像素：`enter × 拟合后的字号`）。
        enter: [placement.enterX, placement.enterY],
        // 真实歌词时间（毫秒 → 秒）与所属排版行：时序层要用。
        lineIndex: segmentLines[wordIndex] ?? 0,
        startTime: grapheme.startMs / 1000,
        endTime: grapheme.endMs / 1000,
        // 入场样式三项：运动层要它（入参全必填），计划层本来就产出，只是先前没往 spec 上带。
        enterStyle: placement.enterStyle,
        enterRotation: placement.enterRotation,
        enterScale: placement.enterScale,
        // 逐字旋转（区域 + 行 + 词三层之和）：运动层入场要求它。
        rotation: placement.rotation,
        /*
         * 运动回响的拖尾色（上游 `placement.color ?? palette.tone4`）。
         * `echoTone` 没传时**不产生这个键**——保持老调用点（含用例）的产物形状不变。
         */
        ...(echoTone === undefined ? {} : { echoColor: isHeroWord ? color : echoTone }),
        /*
         * **是否走 keyword 层**（第 618 轮）：上游的判据是 `placement.color` **有没有值**
         * —— 也就是"这个字素被主题色着色过吗"。着色过的字素必须**离开反色层**，
         * 否则差异滤镜末行 `finalColor = vec4(tone * glyph.a, glyph.a)` 会把色相整体替换成 ink/paper。
         *
         * ⚠ **判据必须是"真命中了词色"（`wordColor !== inkColor`），不能是 `color !== inkColor`**：
         * hero 词在没命中时会拿 `accentColor` 兜底 ⇒ 用 `color !== inkColor` 会让**整个切片**的字素
         * （切片常常只有一个词）统统退出反色层 —— 实测那一跑 `主题色字素=15/16`，
         * 字不再随背景翻色，**把凝彩最核心的可读性机制废掉了**（terrain 族里白字压在浅色块上）。
         * 上游之所以敢这么分流，是因为它的 `keywordLayer` 只装"命中 `wordColors` 的少数词"。
         */
        ...(isHeroWord && wordColor !== inkColor ? { keyword: true } : {}),
      });
      glyphOrder += 1;
    }
  });

  /*
   * **时序层在整镜排版收尾处跑**（上游 `applyGlyphTiming` 也在排版收尾）：它需要整镜边界
   * ——"本镜歌词结束"= 所有字形最晚的 `endTime`、每行的跨度、以及"块中心 = 位置均值" ——
   * 这些逐字 push 时算不出来，所以必须先排完整镜再统一补。
   *
   * ✅ **第 616 轮起这句不再是"近似"**：帧规格的 `x/y` 已改成**字素中心**（与上游同口径），
   * 而该模块正是用"位置的算术平均"当块中心、取 `tracking = 位置 − 中心`
   * （`temperaGlyphTiming.ts:73~90`）—— 两边口径一致，力臂里不再带那半个字宽的偏差。
   */
  const timed = applyTemperaGlyphTiming(
    glyphs.map((spec) => ({
      ...spec,
      lineIndex: spec.lineIndex ?? 0,
      startTime: spec.startTime ?? 0,
      endTime: spec.endTime ?? 0,
      x: spec.x,
      y: spec.y,
    })),
  );
  void timeSec;
  return glyphs.map((spec, index) => ({
    ...spec,
    settleTime: timed[index]?.settleTime,
    releaseTime: timed[index]?.releaseTime,
    trackingX: timed[index]?.trackingX,
    trackingY: timed[index]?.trackingY,
  }));
}

/* ------------------------------------------------------------------ *
 * 帧
 * ------------------------------------------------------------------ */

export interface TemperaDecorSpec {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scale: number;
  readonly color: string;
}

/**
 * shot 级的**基准字号**（照抄上游 `temperaSceneBuilder.ts:459~464`，第 619 轮搬过来）。
 *
 * ⚠ 它**不是正文用的字号**（正文走排版的拟合循环），而是上游给**装饰**定的标尺：
 * 页边散字 `max(12, base × scale)`、超大装饰词 `max(48, base × scale)`，`scale` 来自 program
 * （`temperaProgram.ts:294` 的 `0.26~0.46`、`:316` 的 `2.6~4.5`）。
 *
 * 上游算式：`max(34, min(150, (viewportWidth / max(5, maxGraphemes × 1.05)) × 1.5))`，
 * 最后再乘 `lyricsFontScale` —— 那是 UI 设置、帧层拿不到，所以**由绘制层乘**（见 `TemperaTheme`）。
 */
export const resolveTemperaBaseFontSize = (
  viewportWidth: number,
  maxGraphemes: number,
): number => {
  const count = Math.max(5, maxGraphemes * 1.05);
  return Math.max(34, Math.min(150, (viewportWidth / count) * 1.5));
};

/**
 * 本 shot 的 `maxGraphemes`：**每个 slice 单独求和、再取最大**（上游同口径，不是"所有 slice 加起来"），
 * 下界 3（上游 `Math.max(3, ...)`）。
 */
export const resolveTemperaShotMaxGraphemes = (
  shot: TemperaShot,
  lines: readonly TemperaCompiledLine[],
): number => {
  const perSlice = shot.slices.map((slice) => {
    const line = lines.find((item) => item.sourceIndex === slice.lineIndex);
    if (line === undefined) return 0;
    return line.segments
      .slice(slice.segmentStart, slice.segmentEnd)
      .reduce((sum, segment) => sum + segment.graphemes.length, 0);
  });
  return Math.max(3, ...perSlice);
};

export interface TemperaFrame {
  readonly shotId: string;
  readonly shotKind: TemperaShotKind;
  readonly paragraphKind: string;
  /** 这一族还没实现（走兜底构图）。 */
  readonly fallback: boolean;
  /** 本 shot 的起点与时长（秒）：面板 / 字素的入场延迟都是**shot 内比例**，渲染层要用它换算。 */
  readonly shotStartTime: number;
  readonly shotDuration: number;
  /**
   * **只到歌词结束**的 shot 时长（`lyricEndTime − startTime`）。
   *
   * 上游 README「色块进场节奏」那条写明：色块 / 缝隙 / 描边的 delay·span 必须用**这个**，
   * 不能用 `shotDuration` —— 因为 `endTime` 是"平铺出来的下一个 shot 起点"，
   * 间奏前那个 shot 会因此拖成好几秒，色块慢吞吞地进场而文字早就落位了。
   * 反过来，**沿 flow 的持续 creep 仍然要用 `shotDuration`**（用这个的话长 shot 会在后半段整个冻住），
   * 所以两者必须并存、不能互相替换。
   */
  readonly shotLyricDuration: number;
  /** 相机：`x / y` 是**视口比例**，`scale` 是倍率。 */
  readonly camera: TemperaCameraFrame;
  readonly panels: readonly TemperaPanelSpec[];
  readonly seams: readonly TemperaSeamSpec[];
  /** 线条 / 折线（band 族的引导线、波浪边）。 */
  readonly strokes: readonly TemperaStrokeSpec[];
  readonly glyphs: readonly TemperaGlyphSpec[];
  readonly fragments: readonly TemperaDecorSpec[];
  readonly watermark: TemperaDecorSpec | null;
  /**
   * 装饰（散字 / 装饰词）的**基准字号**（第 619 轮加，上游 `baseFontSize`）。
   *
   * ⚠ **未乘 `lyricsFontScale`**（UI 设置帧层看不到）—— 绘制层算装饰字号时要自己乘上。
   */
  readonly decorBaseFontSize: number;
  readonly hatchAngle: number;
  readonly crossCount: number;
  readonly tones: TemperaTones;
}

export interface TemperaFrameInput {
  readonly program: TemperaProgram;
  readonly timeSec: number;
  readonly viewport: TemperaViewport;
  /** 纸色：四档明度的**浅端**（folia 的 `paper`，取主题的 surface）。 */
  readonly paper: string;
  /**
   * 深端（folia 的 `ink` 那一档，取**封面色** `primary`）。
   *
   * 注意这里不能用 `--pi-lyric-ink`：那是**歌词字色**，暗档下是白色 ——
   * 拿它当画面深端会让四档全挤在浅色区，整幅构图糊成一片灰白（第一版就是这么错的）。
   */
  readonly deep: string;
  /** 歌词字色（`--pi-lyric-ink`：暗档白、亮档近黑）。 */
  readonly glyph: string;
  readonly accent: string;
  /**
   * 主题的第二强调色（`theme.secondaryColor`），用作 `duo` 档色阶的 `tintB`。
   *
   * **可选**：不传就退化成纯中性色阶（＝接线前的行为）。
   * ⚠ 传进来前必须先用 `resolveCssColor(...)` 落成实色 —— `mixColor` 只认 `rgb()/rgba()`。
   */
  readonly secondary?: string;
  readonly wordColorOf: (text: string, fallback: string) => string;
}

/** 由一个时刻算出整帧的绘制规格（纯函数；渲染层只是执行它）。 */
export function buildTemperaFrame(input: TemperaFrameInput): TemperaFrame | null {
  const { program, timeSec, viewport, paper, deep, glyph, accent, secondary, wordColorOf } = input;
  const paragraph = program.paragraphs.find(
    (item) => timeSec >= item.startTime - 0.5 && timeSec <= (item.shots[item.shots.length - 1]?.endTime ?? item.endTime) + 0.5,
  ) ?? program.paragraphs[0];
  if (paragraph === undefined) return null;
  const shot = findTemperaShotAtTime(paragraph, timeSec);
  if (shot === null) return null;

  const bleed = resolveTemperaBleed(viewport);
  /*
   * 上游 `ensureInkContrast`：`primary` **不保证**与底色形成对比（浅主色 + 浅底色很常见），
   * 结果是歌词读不清、**差异滤镜拿到两个几乎同色的输入**。
   * 所以**先保证纸墨对比**，再用它建四档阶梯。
   */
  const ink = resolveTemperaInkContrast(paper, deep);
  const tones = resolveTemperaTones(paper, ink, accent, secondary);
  const composition = buildTemperaComposition(
    shot.kind,
    hashTemperaSeed(shot.id),
    viewport,
    bleed,
    shot.flowAngle,
  );
  const progress =
    (timeSec - shot.startTime) / Math.max(0.001, shot.endTime - shot.startTime);
  const cameraKey = resolveTemperaCameraFrame(shot, progress);

  const allLines = program.paragraphs.flatMap((item) => item.lines);
  // 装饰的标尺（上游 `baseFontSize`）：与正文排版各自独立，别混用。
  const decorBaseFontSize = resolveTemperaBaseFontSize(
    viewport.width,
    resolveTemperaShotMaxGraphemes(shot, allLines),
  );
  const glyphs = layoutTemperaGlyphs({
    shot,
    lines: allLines,
    viewport,
    inkColor: glyph,
    accentColor: accent,
    wordColorOf,
    timeSec,
    // 本镜的排版种子：与 `cameraSeed` 同一种取法（`program.seed : shot.id : 用途`）。
    seed: hashTemperaSeed(`${program.seed}:${shot.id}:layout`),
    // 运动回响的拖尾色（上游 `palette.tone4` = 色阶第 4 档）。
    echoTone: tones.tone[3],
  });
  /*
   * 呼吸浮动**等歌词全部入场走完**才加进来（folia: `resolveTemperaBreathWeight`）：
   * 入场还没结束就让镜头飘，字会显得"落不准"。入场收尾时刻由实际排出的字素算，
   * 不是拍脑袋定的常数。
   */
  const lastReveal = glyphs.reduce(
    (latest, glyph) => Math.max(latest, glyph.delay + glyph.span),
    0,
  );
  const revealDone = shot.startTime + lastReveal;
  const breathing = resolveTemperaCameraBreath(timeSec, hashTemperaSeed(shot.id) % 1000);
  const weight = resolveTemperaBreathWeight(timeSec, revealDone);
  const camera: TemperaCameraFrame = {
    x: cameraKey.x + breathing.x * weight,
    y: cameraKey.y + breathing.y * weight,
    scale: cameraKey.scale + breathing.scale * weight,
    rotation: cameraKey.rotation + breathing.rotation * weight,
  };

  const decor = shot.decor;
  return {
    shotId: shot.id,
    shotKind: shot.kind,
    paragraphKind: paragraph.kind,
    fallback: composition.fallback,
    shotStartTime: shot.startTime,
    shotDuration: Math.max(0.001, shot.endTime - shot.startTime),
    /* 色块节奏只到歌词结束（上游 README「色块进场节奏」）—— 见 `shotLyricDuration` 的注释。 */
    shotLyricDuration: Math.max(0.001, shot.lyricEndTime - shot.startTime),
    camera,
    panels: composition.panels,
    seams: composition.seams,
    strokes: composition.strokes,
    glyphs,
    fragments: decor.fragments.map((fragment) => ({
      text: fragment.char,
      x: fragment.x,
      y: fragment.y,
      rotation: fragment.rotation,
      scale: fragment.scale,
      color: tones.tone[2],
    })),
    watermark: decor.watermark === null
      ? null
      : {
          text: decor.watermark.text,
          x: decor.watermark.x,
          y: decor.watermark.y,
          rotation: decor.watermark.rotation,
          scale: decor.watermark.scale,
          color: tones.tone[3],
        },
    hatchAngle: decor.hatchAngle,
    crossCount: decor.crossCount,
    decorBaseFontSize,
    tones,
  };
}
