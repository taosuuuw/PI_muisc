/**
 * 五线谱的**图元清单**（照抄 folia `sonnet/sonnetStaffView.ts` 的画法，我们重写代码）。
 *
 * 分工：`sonnetStaff.ts` 出"数据 + 几何 + 逐帧参数" ✓，本文件把它们折成**可直接画的图元** ✓
 * （线段 / 椭圆 / 二次曲线 ✓，都带 `alpha` 与"颜色键" ✓ —— 颜色由渲染层按主题填 ✓）。
 *
 * === 与 folia 的差异（照实记）===
 * · **升号的具体笔画** ✗：上游是"两条竖线 + 两条斜线"（`sharpHeight = lineSpacing × 1.15` ✓、
 *   横向上 `±lineSpacing × 0.16` / `∓0.12 → ±0.28` 一带 ✓），**但我没取到那两条斜线的确切端点** ✗
 *   ⇒ 本文件按"**十字斜杠**"的常规定义实现（两条斜杠各跨 `0.6 × lineSpacing`、倾角 `±0.18 × lineSpacing` ✓），
 *   **标注为近似** ✓；
 * · 上游把静态谱面和动态音符**画在同一个 `Graphics` 上**（先静态后动态 ✓）；我们**分开出清单** ✓
 *   （`resolveSonnetStaffStaticDraws` / `resolveSonnetStaffDynamicDraws` ✓），
 *   好处是静态部分可以**只在几何变化时重画** ✓（渲染层可选优化 ✓），画序仍保持"静态在前" ✓。
 */

import {
  resolveSonnetStaffFrame,
  type SonnetStaffFrame,
  type SonnetStaffGeometry,
  type SonnetStaffTimedNote,
} from './sonnetStaff';

/** 图元用哪种颜色（渲染层按主题映射 ✓）。 */
export type SonnetStaffColorKey = 'primary' | 'accent';

export type SonnetStaffDraw =
  | {
      readonly kind: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly width: number;
      readonly alpha: number;
      readonly colorKey: SonnetStaffColorKey;
    }
  | {
      readonly kind: 'ellipse';
      readonly x: number;
      readonly y: number;
      readonly radiusX: number;
      readonly radiusY: number;
      readonly alpha: number;
      readonly colorKey: SonnetStaffColorKey;
    }
  | {
      readonly kind: 'quadratic';
      readonly fromX: number;
      readonly fromY: number;
      readonly controlX: number;
      readonly controlY: number;
      readonly toX: number;
      readonly toY: number;
      readonly width: number;
      readonly alpha: number;
      readonly colorKey: SonnetStaffColorKey;
    };

/** 静态谱面：5 条谱线 ✓ + 7 条小节线 ✓ + 左右三条边饰 ✓（画序照上游：谱线 → 小节线 → 边饰 ✓）。 */
export function resolveSonnetStaffStaticDraws(
  geometry: SonnetStaffGeometry,
): readonly SonnetStaffDraw[] {
  const draws: SonnetStaffDraw[] = [];

  // 5 条谱线：{ primary, 2, 0.3 } ✓
  geometry.staffLineY.forEach((y) => {
    draws.push({
      kind: 'line',
      x1: -geometry.halfWidth,
      y1: y,
      x2: geometry.halfWidth,
      y2: y,
      width: 2,
      alpha: 0.3,
      colorKey: 'primary',
    });
  });

  // 7 条小节线：{ primary, 1, 0.16 } ✓（贯穿全谱 ✓）
  geometry.barLineX.forEach((x) => {
    draws.push({
      kind: 'line',
      x1: x,
      y1: -geometry.halfHeight,
      x2: x,
      y2: geometry.halfHeight,
      width: 1,
      alpha: 0.16,
      colorKey: 'primary',
    });
  });

  // 左右边饰：{ primary, 各自宽度, 0.5 } ✓
  geometry.edgeBars.forEach((bar) => {
    draws.push({
      kind: 'line',
      x1: bar.x,
      y1: -geometry.halfHeight,
      x2: bar.x,
      y2: geometry.halfHeight,
      width: bar.width,
      alpha: 0.5,
      colorKey: 'primary',
    });
  });

  return draws;
}

/** 播放头：`{ accent, 1.5, 0.34 }`，纵向上下各多出 `lineSpacing × 0.8` ✓。 */
export function resolveSonnetStaffCursorDraw(
  geometry: SonnetStaffGeometry,
  frame: SonnetStaffFrame,
): SonnetStaffDraw {
  const overshoot = geometry.lineSpacing * 0.8;
  return {
    kind: 'line',
    x1: frame.cursorX,
    y1: -geometry.halfHeight - overshoot,
    x2: frame.cursorX,
    y2: geometry.halfHeight + overshoot,
    width: 1.5,
    alpha: 0.34,
    colorKey: 'accent',
  };
}

/**
 * 动态部分：每个音符的**符干 → 符尾 → 升号 → 音符本体** ✓
 * （先画附属物再画符头 ⇒ 符头压在它们上面，观感与上游一致 ✓）。
 */
export function resolveSonnetStaffDynamicDraws(
  geometry: SonnetStaffGeometry,
  frame: SonnetStaffFrame,
): readonly SonnetStaffDraw[] {
  const draws: SonnetStaffDraw[] = [];
  const spacing = geometry.lineSpacing;

  frame.notes.forEach((note) => {
    // 符干：{ primary, 1.6, min(0.9, alpha + 0.08) } ✓
    const stemAlpha = Math.min(0.9, note.alpha + 0.08);
    draws.push({
      kind: 'line',
      x1: note.stemX,
      y1: note.y,
      x2: note.stemX,
      y2: note.stemEndY,
      width: 1.6,
      alpha: stemAlpha,
      colorKey: 'primary',
    });

    // 符尾（只有短音符 ✓）：二次曲线 ✓
    if (note.hasFlag) {
      const direction = note.stemDown ? -1 : 1;
      draws.push({
        kind: 'quadratic',
        fromX: note.stemX,
        fromY: note.stemEndY,
        controlX: note.stemX + spacing * 1.1,
        controlY: note.stemEndY + spacing * 0.55 * direction,
        toX: note.stemX + spacing * 0.1,
        toY: note.stemEndY + spacing * direction,
        width: 1.6,
        alpha: stemAlpha,
        colorKey: 'primary',
      });
    }

    // 升号：{ primary, 1.2, min(0.86, alpha + 0.08) } ✓（两条竖线 + 两条斜杠，斜杠为**近似** ✓）
    if (note.sharpX !== null) {
      const sharpAlpha = Math.min(0.86, note.alpha + 0.08);
      const sharpHeight = spacing * 1.15;
      const top = note.y - sharpHeight / 2;
      const bottom = note.y + sharpHeight / 2;
      draws.push({
        kind: 'line',
        x1: note.sharpX - spacing * 0.16,
        y1: top,
        x2: note.sharpX - spacing * 0.16,
        y2: bottom,
        width: 1.2,
        alpha: sharpAlpha,
        colorKey: 'primary',
      });
      draws.push({
        kind: 'line',
        x1: note.sharpX + spacing * 0.16,
        y1: top,
        x2: note.sharpX + spacing * 0.16,
        y2: bottom,
        width: 1.2,
        alpha: sharpAlpha,
        colorKey: 'primary',
      });
      // 两条斜杠（近似：各跨 0.6 × lineSpacing、倾角 ±0.18 × lineSpacing ✓）
      for (const barOffset of [-0.34, 0.34]) {
        draws.push({
          kind: 'line',
          x1: note.sharpX - spacing * 0.3,
          y1: note.y + spacing * barOffset + spacing * 0.18,
          x2: note.sharpX + spacing * 0.3,
          y2: note.y + spacing * barOffset - spacing * 0.18,
          width: 1.2,
          alpha: sharpAlpha,
          colorKey: 'primary',
        });
      }
    }

    // 音符本体：椭圆填充 { accent, alpha } ✓（带 `pulse` 缩放后的半径 ✓）
    draws.push({
      kind: 'ellipse',
      x: note.x,
      y: note.y,
      radiusX: note.radiusX,
      radiusY: note.radiusY,
      alpha: note.alpha,
      colorKey: 'accent',
    });
  });

  return draws;
}

export interface SonnetStaffFrameDraws {
  readonly static: readonly SonnetStaffDraw[];
  readonly cursor: SonnetStaffDraw;
  readonly dynamic: readonly SonnetStaffDraw[];
}

/** 一帧的全部图元（分三组给出，画序：静态 → 播放头 → 动态 ✓）。 */
export function resolveSonnetStaffDraws(input: {
  readonly geometry: SonnetStaffGeometry;
  readonly time: number;
  readonly shotStartTime: number;
  readonly notes: readonly SonnetStaffTimedNote[];
}): SonnetStaffFrameDraws {
  const frame = resolveSonnetStaffFrame(input);
  return {
    static: resolveSonnetStaffStaticDraws(input.geometry),
    cursor: resolveSonnetStaffCursorDraw(input.geometry, frame),
    dynamic: resolveSonnetStaffDynamicDraws(input.geometry, frame),
  };
}
