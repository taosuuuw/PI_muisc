/**
 * **把「画进来」引擎接到我们的图元清单上**（照抄 folia `sonnetAnimatedGraphics.ts` 的行为，我们重写）。
 *
 * 上游模型：把多条 `moveTo/lineTo/…` 记成**一条命令**，再 `stroke/fill` ⇒ 一条命令**一次生长** ✓
 * （多段路径共享一个 `length` ✓）。我方图元清单是"一条图元一个对象" ✓ ⇒
 * **第一版把每条图元当作一条命令** ✓（与上游的"路径分组"不同 ✗ ⇒ 已登记差异 ✓，
 * 效果差异：上游同一条路径里的多段会**一起长**，我方会**各长各的** ✓ 观感更碎一点 ✓）。
 *
 * 本文件是**纯函数**：给"图元清单 + 进度"⇒ 出"这一帧该画什么" ✓。
 * · 错峰：`resolveSonnetStaggerSpan(index, isStroke = true)` ✓（上游 stroke / fill 各自计数 ✓；
 *   我们这一版所有图元都按 **stroke** 计数 ✓ —— 因为清单里绝大多数是描边 ✓，纯填充的（`strokeWidth === 0`）
 *   也按同一个序号走 ✓，**登记为差异** ✓）；
 * · 长度：直线 `hypot` ✓、弧 `|Δ| × r` ✓、二次曲线两段之和 ✓、多边形周长 ✓、矩形周长 ✓（`rect` 另有**擦除**规则 ✓）；
 * · 截断：`resolveSonnetPartialDraws` ✓（曲线用 de Casteljau ✓ 不变形 ✓）；
 * · **矩形擦除**（照上游 `rect_hint` 的规则 ✓）：不按周长长，而是**宽度**从 0 长到 `w` ✓；
 * · **圆**（照上游 `circle` ✓）：`arc(0 → 2π × ratio)` ✓（上游起角随机 ✓，我方这一版固定从 0 起 ✓ 差异 ✓）。
 */

import {
  resolveSonnetPartialDraws,
  resolveSonnetStaggerProgress,
  resolveSonnetStaggerSpan,
  sonnetPathArc,
  sonnetPathLine,
  sonnetPathQuadratic,
  type SonnetPathSegment,
} from './sonnetStagger';

export type SonnetStaggerColorKey = 'primary' | 'secondary';

export type SonnetStaggerableDraw =
  | {
      readonly kind: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetStaggerColorKey;
    }
  | {
      readonly kind: 'quadratic';
      readonly fromX: number;
      readonly fromY: number;
      readonly controlX: number;
      readonly controlY: number;
      readonly toX: number;
      readonly toY: number;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetStaggerColorKey;
    }
  | {
      readonly kind: 'arc';
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly startAngle: number;
      readonly endAngle: number;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetStaggerColorKey;
    }
  | {
      readonly kind: 'circle';
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      /** `0` ⇒ 填充 ✓（填充不"生长"⇒ 只做 alpha 渐显 ✓）。 */
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetStaggerColorKey;
    }
  | {
      readonly kind: 'polygon';
      readonly points: readonly number[];
      readonly closed: boolean;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetStaggerColorKey;
    }
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetStaggerColorKey;
    };

/** 一条图元"要长多长" ✓。 */
export function resolveSonnetStaggerableLength(draw: SonnetStaggerableDraw): number {
  switch (draw.kind) {
    case 'line':
      return Math.hypot(draw.x2 - draw.x1, draw.y2 - draw.y1);
    case 'quadratic':
      return (
        Math.hypot(draw.controlX - draw.fromX, draw.controlY - draw.fromY) +
        Math.hypot(draw.toX - draw.controlX, draw.toY - draw.controlY)
      );
    case 'arc':
      return Math.abs(draw.endAngle - draw.startAngle) * draw.radius;
    case 'circle':
      return draw.strokeWidth === 0 ? 0 : Math.PI * 2 * draw.radius;
    case 'polygon': {
      let total = 0;
      const count = Math.floor(draw.points.length / 2);
      for (let index = 1; index < count; index += 1) {
        total += Math.hypot(
          (draw.points[index * 2] ?? 0) - (draw.points[(index - 1) * 2] ?? 0),
          (draw.points[index * 2 + 1] ?? 0) - (draw.points[(index - 1) * 2 + 1] ?? 0),
        );
      }
      if (draw.closed && count > 2) {
        total += Math.hypot(
          (draw.points[0] ?? 0) - (draw.points[(count - 1) * 2] ?? 0),
          (draw.points[1] ?? 0) - (draw.points[(count - 1) * 2 + 1] ?? 0),
        );
      }
      return total;
    }
    case 'rect':
      // 矩形走"擦除"（按宽度 ✓），所以它的"长度"按宽度算 ✓
      return draw.width;
    default:
      return 0;
  }
}

/** 把一条图元折成"路径段"（供 `resolveSonnetPartialDraws` 截断 ✓）。 */
function toSegments(draw: SonnetStaggerableDraw): readonly SonnetPathSegment[] {
  switch (draw.kind) {
    case 'line':
      return [sonnetPathLine(draw.x1, draw.y1, draw.x2, draw.y2)];
    case 'quadratic':
      return [
        sonnetPathQuadratic(draw.fromX, draw.fromY, draw.controlX, draw.controlY, draw.toX, draw.toY),
      ];
    case 'arc':
      return [
        sonnetPathArc(draw.x, draw.y, draw.radius, draw.startAngle, draw.endAngle),
      ];
    case 'circle':
      // 上游的圆就是"从 0 扫一圈" ✓（长度 2πr ✓）
      return [sonnetPathArc(draw.x, draw.y, draw.radius, 0, Math.PI * 2)];
    case 'polygon': {
      const count = Math.floor(draw.points.length / 2);
      const segments: SonnetPathSegment[] = [];
      for (let index = 1; index < count; index += 1) {
        segments.push(
          sonnetPathLine(
            draw.points[(index - 1) * 2] ?? 0,
            draw.points[(index - 1) * 2 + 1] ?? 0,
            draw.points[index * 2] ?? 0,
            draw.points[index * 2 + 1] ?? 0,
          ),
        );
      }
      if (draw.closed && count > 2) {
        segments.push(
          sonnetPathLine(
            draw.points[(count - 1) * 2] ?? 0,
            draw.points[(count - 1) * 2 + 1] ?? 0,
            draw.points[0] ?? 0,
            draw.points[1] ?? 0,
          ),
        );
      }
      return segments;
    }
    default:
      return [];
  }
}

/** 这一帧真正要画的东西：要么是**截断后的描边**，要么是**矩形擦除**，要么是**整条填充**（只渐显 ✓）。 */
export type SonnetStaggeredDraw =
  | {
      readonly kind: 'stroke';
      readonly colorKey: SonnetStaggerColorKey;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly parts: ReturnType<typeof resolveSonnetPartialDraws>;
    }
  | {
      readonly kind: 'rect-wipe';
      readonly colorKey: SonnetStaggerColorKey;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: 'fill';
      readonly colorKey: SonnetStaggerColorKey;
      readonly alpha: number;
      readonly draw: SonnetStaggerableDraw;
    }
  | {
      /** 还没轮到它（`localRaw = 0`）⇒ 本帧不画 ✓。 */
      readonly kind: 'hidden';
    };

export interface SonnetStaggerOptions {
  /** 命令序号（stroke 计数 ✓；调用方自己维护 ✓）。 */
  readonly index: number;
  /** 整体进度（0~1 ✓）。 */
  readonly progress: number;
}

/** 单条图元 → 本帧画法 ✓。 */
export function resolveSonnetStaggeredDraw(
  draw: SonnetStaggerableDraw,
  options: SonnetStaggerOptions,
): SonnetStaggeredDraw {
  const stagger = resolveSonnetStaggerSpan(options.index, true);
  const { localRaw, localProgress, alphaProgress } = resolveSonnetStaggerProgress(
    options.progress,
    stagger,
  );
  const alpha = draw.alpha * alphaProgress;
  if (localRaw <= 0) return { kind: 'hidden' };

  // 纯填充（`strokeWidth === 0`）⇒ 不生长，只渐显 ✓
  if (draw.kind === 'circle' && draw.strokeWidth === 0) {
    return { kind: 'fill', colorKey: draw.colorKey, alpha, draw };
  }
  if (draw.kind === 'rect' && draw.strokeWidth === 0) {
    return { kind: 'fill', colorKey: draw.colorKey, alpha, draw };
  }

  if (draw.kind === 'rect') {
    // **矩形擦除**：宽度从 0 长到 `w` ✓（照上游 `rect_hint` 的规则 ✓）
    return {
      kind: 'rect-wipe',
      colorKey: draw.colorKey,
      strokeWidth: draw.strokeWidth,
      alpha,
      x: draw.x,
      y: draw.y,
      width: draw.width * localProgress,
      height: draw.height,
    };
  }

  const length = resolveSonnetStaggerableLength(draw);
  const parts = resolveSonnetPartialDraws(toSegments(draw), length * localProgress);
  if (parts.length === 0) return { kind: 'hidden' };
  return { kind: 'stroke', colorKey: draw.colorKey, strokeWidth: draw.strokeWidth, alpha, parts };
}

/** 一整批图元 → 本帧画法（序号按清单顺序递增 ✓）。 */
export function resolveSonnetStaggeredDraws(
  draws: readonly SonnetStaggerableDraw[],
  progress: number,
): readonly SonnetStaggeredDraw[] {
  return draws.map((draw, index) => resolveSonnetStaggeredDraw(draw, { index, progress }));
}
