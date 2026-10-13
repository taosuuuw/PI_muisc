/**
 * 商籁**背景 MG（`bg` 层）的 HUD 外框**（照抄 folia `sonnet/sonnetBackgroundMgVariants.ts`，AGPL-3.0）。
 *
 * 上游文件头原文："Seed-driven HUD frame compositions for the Sonnet background MG (`bg`) layer.
 * Every variant draws at the **same margins** so shots stay interchangeable; only the furniture
 * (crosses, brackets, rulers, arcs, dots) changes." ✓
 *
 * ⇒ 八种"家具"共用同一副框内坐标 ✓：`hw = width / 2`、`hh = height / 2`、
 * **`marginX = width × 0.05`**、**`marginY = height × 0.05`** ✓。
 *
 * === 与 folia 的差异（照实记）===
 * · 上游画在 `AnimatedGraphics`（自带动画能力 ✓）；我方只出**静态图元清单** ✓ 给渲染层画 ✓
 *   （第一版不做逐帧动画 ✓；上游哪些笔是有动画的，我方文件里也标出"未复刻动画"✓）。
 * · **几处小量我取的是"合理值"**（标 `近似` ✓）：`classic-cross` 左列十字的 `x` 偏移、
 *   `marquee-strips` 的箭头/垂穗 `x` 递推、`dotted-columns` 的列 `x` 余量、
 *   `double-frame` 四角方块的交替色起点 ⇒ 这些不影响"家具是什么" ✓，只影响细节毫米级位置 ✓。
 */

import { mixSonnetSeed } from './sonnetGeo';

export const SONNET_BACKGROUND_MG_VARIANT_COUNT = 8;

export const SONNET_BACKGROUND_MG_VARIANTS = [
  'classic-cross',
  'corner-brackets',
  'marquee-strips',
  'diagonal-corners',
  'dotted-columns',
  'double-frame',
  'ruler-frame',
  'arc-gauge',
] as const;

export type SonnetBackgroundMgVariant = (typeof SONNET_BACKGROUND_MG_VARIANTS)[number];

/** `mixSonnetSeed(seed, 0x9e3779b9) % 8` ✓。 */
export function resolveSonnetBackgroundMgVariant(seed: number): number {
  return mixSonnetSeed(seed, 0x9e3779b9) % SONNET_BACKGROUND_MG_VARIANT_COUNT;
}

export interface SonnetBackgroundMgFrameContext {
  readonly hw: number;
  readonly hh: number;
  readonly marginX: number;
  readonly marginY: number;
}

/*
 * **边框边距：改成接近满幅**（主人 2026-10-09 明确要求："把边距扩到接近满幅"）。
 *
 * 原作是左右各留 5% 宽、上下各留 5% 高（照抄上游）。主人看过成品后判定那圈内缩的矩形
 * **读起来像"动效只占中间一块、没填满窗口"**，所以按要求把边距收到约 1.2%：
 * 框仍是一圈框（保留这套背景 MG 的设计件，也保住了上游的构图语言），但几乎贴住窗口边缘。
 * ⚠ 这是**主动偏离上游**的一处，理由记在这里与 `CREDITS.md`；要回退只需把这个比例改回 0.05。
 */
const SONNET_BACKGROUND_MG_FRAME_MARGIN_RATIO = 0.012;

export function resolveSonnetBackgroundMgFrameContext(width: number, height: number): SonnetBackgroundMgFrameContext {
  return {
    hw: width / 2,
    hh: height / 2,
    marginX: width * SONNET_BACKGROUND_MG_FRAME_MARGIN_RATIO,
    marginY: height * SONNET_BACKGROUND_MG_FRAME_MARGIN_RATIO,
  };
}

export type SonnetBackgroundMgColorKey = 'primary' | 'secondary';

export type SonnetBackgroundMgDraw =
  | {
      readonly kind: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly width: number;
      readonly alpha: number;
      readonly colorKey: SonnetBackgroundMgColorKey;
    }
  | {
      readonly kind: 'circle';
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      /** `0` ⇒ **填充** ✓（上游实心点/方块那种 ✓）。 */
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetBackgroundMgColorKey;
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
      readonly colorKey: SonnetBackgroundMgColorKey;
    }
  | {
      readonly kind: 'polygon';
      /** 成对 `x, y` ✓（三角、菱形、L 括号都折成多边形 ✓）。 */
      readonly points: readonly number[];
      readonly closed: boolean;
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetBackgroundMgColorKey;
    }
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      /** `0` ⇒ **填充** ✓。 */
      readonly strokeWidth: number;
      readonly alpha: number;
      readonly colorKey: SonnetBackgroundMgColorKey;
    };

const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  alpha: number,
  colorKey: SonnetBackgroundMgColorKey,
): SonnetBackgroundMgDraw => ({ kind: 'line', x1, y1, x2, y2, width, alpha, colorKey });

const strokeCircle = (
  x: number,
  y: number,
  radius: number,
  strokeWidth: number,
  alpha: number,
  colorKey: SonnetBackgroundMgColorKey,
): SonnetBackgroundMgDraw => ({ kind: 'circle', x, y, radius, strokeWidth, alpha, colorKey });

const fillCircle = (
  x: number,
  y: number,
  radius: number,
  alpha: number,
  colorKey: SonnetBackgroundMgColorKey,
): SonnetBackgroundMgDraw => ({ kind: 'circle', x, y, radius, strokeWidth: 0, alpha, colorKey });

const fillRect = (
  x: number,
  y: number,
  width: number,
  height: number,
  alpha: number,
  colorKey: SonnetBackgroundMgColorKey,
): SonnetBackgroundMgDraw => ({ kind: 'rect', x, y, width, height, strokeWidth: 0, alpha, colorKey });

const openPoly = (
  points: readonly number[],
  strokeWidth: number,
  alpha: number,
  colorKey: SonnetBackgroundMgColorKey,
): SonnetBackgroundMgDraw => ({
  kind: 'polygon',
  points,
  closed: false,
  strokeWidth,
  alpha,
  colorKey,
});

/** 上游的小 X 标记：两条对角线 ✓（`width 1` ✓）。 */
function cross(
  x: number,
  y: number,
  size: number,
  alpha: number,
  colorKey: SonnetBackgroundMgColorKey,
): readonly SonnetBackgroundMgDraw[] {
  return [
    line(x - size, y - size, x + size, y + size, 1, alpha, colorKey),
    line(x + size, y - size, x - size, y + size, 1, alpha, colorKey),
  ];
}

/** 口袋工具：L 形括号（两段线 ✓）。 */
function bracket(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  armX: number,
  armY: number,
  width: number,
  alpha: number,
  colorKey: SonnetBackgroundMgColorKey,
): readonly SonnetBackgroundMgDraw[] {
  return [
    line(x, y, x + dirX * armX, y, width, alpha, colorKey),
    line(x, y, x, y + dirY * armY, width, alpha, colorKey),
  ];
}

/** 菱形（4 点闭合 ✓，`diagonal-corners` 用 ✓）。 */
function diamond(
  x: number,
  y: number,
  size: number,
  strokeWidth: number,
  alpha: number,
  colorKey: SonnetBackgroundMgColorKey,
): SonnetBackgroundMgDraw {
  return {
    kind: 'polygon',
    points: [x, y - size, x + size, y, x, y + size, x - size, y],
    closed: true,
    strokeWidth,
    alpha,
    colorKey,
  };
}

export interface SonnetBackgroundMgInput {
  readonly variant: number;
  readonly width: number;
  readonly height: number;
  readonly seed: number;
}

export function resolveSonnetBackgroundMgDraws(
  input: SonnetBackgroundMgInput,
): readonly SonnetBackgroundMgDraw[] {
  const { hw, hh, marginX, marginY } = resolveSonnetBackgroundMgFrameContext(input.width, input.height);
  const left = -hw + marginX;
  const right = hw - marginX;
  const top = -hh + marginY;
  const bottom = hh - marginY;
  const variant =
    ((input.variant % SONNET_BACKGROUND_MG_VARIANT_COUNT) + SONNET_BACKGROUND_MG_VARIANT_COUNT) %
    SONNET_BACKGROUND_MG_VARIANT_COUNT;
  const draws: SonnetBackgroundMgDraw[] = [];

  switch (variant) {
    case 0: {
      // classic-cross：四角十字（size 4 / 0.4）+ 左列 8 个十字（size 3 / 0.3）+ 底横杆 + 杆上 3 个十字 + 实心圆
      draws.push(...cross(left, top, 4, 0.4, 'primary'));
      draws.push(...cross(right, top, 4, 0.4, 'primary'));
      draws.push(...cross(left, bottom, 4, 0.4, 'primary'));
      draws.push(...cross(right, bottom, 4, 0.4, 'primary'));
      for (let index = 0; index < 8; index += 1) {
        draws.push(...cross(left + 6, top + index * 20 + 30, 3, 0.3, 'primary'));
      }
      const barY = bottom - 10;
      draws.push(line(left + 20, barY, right - 20, barY, 1, 0.3, 'primary'));
      draws.push(...cross(left + 30, barY, 3, 0.5, 'primary'));
      draws.push(...cross(left + 50, barY, 3, 0.5, 'primary'));
      draws.push(...cross(right - 30, barY, 3, 0.5, 'primary'));
      draws.push(fillCircle(right - 10, barY, 2, 0.8, 'secondary'));
      return draws;
    }
    case 1: {
      // corner-brackets：四角 L（arm = min(hw,hh) × 0.08、inset 6）+ 内层小 L + 偶数角实心方块
      const arm = Math.min(hw, hh) * 0.08;
      const inset = 6;
      const corners = [
        { x: left + inset, y: top + inset, dx: 1, dy: 1 },
        { x: right - inset, y: top + inset, dx: -1, dy: 1 },
        { x: right - inset, y: bottom - inset, dx: -1, dy: -1 },
        { x: left + inset, y: bottom - inset, dx: 1, dy: -1 },
      ];
      corners.forEach((corner, index) => {
        draws.push(...bracket(corner.x, corner.y, corner.dx, corner.dy, arm, arm, 2, 0.55, 'primary'));
        draws.push(
          ...bracket(
            corner.x,
            corner.y,
            corner.dx,
            corner.dy,
            arm * 0.45,
            arm * 0.45,
            1,
            0.25,
            'primary',
          ),
        );
        if (index % 2 === 0) {
          const size = 4;
          draws.push(
            fillRect(
              corner.x + (corner.dx > 0 ? 0 : -size),
              corner.y + (corner.dy > 0 ? 0 : -size),
              size,
              size,
              0.6,
              'secondary',
            ),
          );
        }
      });
      // 底刻度尺：ticks 24、每 6 个长（长 8 / 短 4）
      const rulerY = bottom + inset;
      for (let index = 0; index <= 24; index += 1) {
        const major = index % 6 === 0;
        const x = left + ((right - left) * index) / 24;
        draws.push(
          line(x, rulerY, x, rulerY - (major ? 8 : 4), 1, major ? 0.55 : 0.3, major ? 'secondary' : 'primary'),
        );
      }
      // 侧边 5 个定位点（右侧再偏 seed % 7）
      const sideOffset = input.seed % 7;
      for (let index = 0; index < 5; index += 1) {
        const y = top + ((bottom - top) * (index + 0.5)) / 5;
        draws.push(strokeCircle(left - 4, y, 1.5, 1, 0.35, 'primary'));
        draws.push(strokeCircle(right + 4 + sideOffset, y, 1.5, 1, 0.35, 'primary'));
      }
      return draws;
    }
    case 2: {
      // marquee-strips：上下轨道（2 / 0.45）+ 内侧细线（+dir × 6、1 / 0.2）
      //   + 两端 14×6 实心块 + 18 格垂穗（每 3 格）+ 顶部中央十字 + 底部小箭头
      for (const [y, dir] of [
        [top, 1],
        [bottom, -1],
      ] as const) {
        draws.push(line(left, y, right, y, 2, 0.45, 'primary'));
        draws.push(line(left, y + dir * 6, right, y + dir * 6, 1, 0.2, 'primary'));
        draws.push(fillRect(left, y - 3, 14, 6, 0.55, 'secondary'));
        draws.push(fillRect(right - 14, y - 3, 14, 6, 0.55, 'secondary'));
        for (let index = 0; index <= 18; index += 1) {
          if (index % 3 !== 0) continue;
          const x = left + 14 + ((right - left - 28) * index) / 18;
          draws.push(line(x, y, x, y + dir * 5, 1, 0.35, 'primary'));
        }
      }
      draws.push(...cross((left + right) / 2, top, 3, 0.5, 'primary'));
      // 底部小箭头（近似：一个小三角的两条斜边 ✓）
      const arrowY = bottom + 9;
      draws.push(line((left + right) / 2 - 4, arrowY - 3, (left + right) / 2, arrowY, 1, 0.45, 'secondary'));
      draws.push(line((left + right) / 2 + 4, arrowY - 3, (left + right) / 2, arrowY, 1, 0.45, 'secondary'));
      return draws;
    }
    case 3: {
      // diagonal-corners：四角空心三角（1.5 / 0.5）+ 两段平行斜线（×0.55 / ×0.3）
      //   + 底线（barY = bottom − 12）+ 5 个菱形（i === 2 ? 5 : 3）
      const corner = Math.min(hw, hh) * 0.12;
      const corners = [
        { x: left, y: top, dx: 1, dy: 1, index: 0 },
        { x: right, y: top, dx: -1, dy: 1, index: 1 },
        { x: right, y: bottom, dx: -1, dy: -1, index: 2 },
        { x: left, y: bottom, dx: 1, dy: -1, index: 3 },
      ];
      corners.forEach((entry) => {
        const key: SonnetBackgroundMgColorKey = entry.index % 2 === 0 ? 'secondary' : 'primary';
        draws.push(
          {
            kind: 'polygon',
            points: [entry.x, entry.y, entry.x + entry.dx * corner, entry.y, entry.x, entry.y + entry.dy * corner],
            closed: true,
            strokeWidth: 1.5,
            alpha: 0.5,
            colorKey: 'primary',
          },
          openPoly(
            [
              entry.x + entry.dx * corner * 0.55,
              entry.y,
              entry.x,
              entry.y + entry.dy * corner * 0.55,
            ],
            1,
            0.4,
            key,
          ),
          openPoly(
            [
              entry.x + entry.dx * corner * 0.3,
              entry.y,
              entry.x,
              entry.y + entry.dy * corner * 0.3,
            ],
            1,
            0.25,
            'primary',
          ),
        );
      });
      const barY = bottom - 12;
      for (let index = 0; index < 5; index += 1) {
        const x = left + ((right - left) * (index + 0.5)) / 5;
        draws.push(diamond(x, barY, index === 2 ? 5 : 3, 1, 0.55, index === 2 ? 'secondary' : 'primary'));
      }
      return draws;
    }
    case 4: {
      // dotted-columns：左右各 14 行圆点（每 4 行"强"）+ 中央准星 + 中圆 + 底杆 + 两端十字
      const columnTop = top + 10;
      const columnSpan = (bottom - 10 - columnTop) * 2;
      for (let index = 0; index < 14; index += 1) {
        const strong = index % 4 === 0;
        const y = columnTop + (columnSpan * index) / 13;
        draws.push(
          strong
            ? fillCircle(left, y, 2.4, 0.6, 'secondary')
            : strokeCircle(left, y, 1.4, 1, 0.3, 'primary'),
        );
        draws.push(
          strong
            ? fillCircle(right, y, 2.4, 0.6, 'secondary')
            : strokeCircle(right, y, 1.4, 1, 0.3, 'primary'),
        );
      }
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      draws.push(line(cx - 18, cy, cx + 18, cy, 1, 0.22, 'primary'));
      draws.push(line(cx, cy - 18, cx, cy + 18, 1, 0.22, 'primary'));
      draws.push(strokeCircle(cx, cy, 6, 1, 0.3, 'primary'));
      const barY = bottom - 8;
      draws.push(line(left + 16, barY, right - 16, barY, 1, 0.3, 'primary'));
      draws.push(...cross(left + 16, barY, 3, 0.5, 'primary'));
      draws.push(...cross(right - 16, barY, 3, 0.5, 'primary'));
      return draws;
    }
    case 5: {
      // double-frame：外框四边各断两段（8 段 2 / 0.45、gapX ×0.18 / gapY ×0.22）
      //   + 内层回声框（inset 7、1 / 0.18）+ 四角 6×6 实心方块 + 上下中央缺口短线（3 / 0.5）
      const gapX = (right - left) * 0.18;
      const gapY = (bottom - top) * 0.22;
      const midX = (left + right) / 2;
      const midY = (top + bottom) / 2;
      draws.push(line(left, top, midX - gapX, top, 2, 0.45, 'primary'));
      draws.push(line(midX + gapX, top, right, top, 2, 0.45, 'primary'));
      draws.push(line(left, bottom, midX - gapX, bottom, 2, 0.45, 'primary'));
      draws.push(line(midX + gapX, bottom, right, bottom, 2, 0.45, 'primary'));
      draws.push(line(left, top, left, midY - gapY, 2, 0.45, 'primary'));
      draws.push(line(left, midY + gapY, left, bottom, 2, 0.45, 'primary'));
      draws.push(line(right, top, right, midY - gapY, 2, 0.45, 'primary'));
      draws.push(line(right, midY + gapY, right, bottom, 2, 0.45, 'primary'));
      draws.push(
        {
          kind: 'rect',
          x: left + 7,
          y: top + 7,
          width: right - left - 14,
          height: bottom - top - 14,
          strokeWidth: 1,
          alpha: 0.18,
          colorKey: 'primary',
        },
      );
      const corners = [
        { x: left, y: top },
        { x: right - 6, y: top },
        { x: right - 6, y: bottom - 6 },
        { x: left, y: bottom - 6 },
      ];
      corners.forEach((corner, index) => {
        draws.push(fillRect(corner.x, corner.y, 6, 6, 0.6, index % 2 === 0 ? 'secondary' : 'primary'));
      });
      draws.push(line(midX - 5, top, midX + 5, top, 3, 0.5, 'secondary'));
      draws.push(line(midX - 5, bottom, midX + 5, bottom, 3, 0.5, 'secondary'));
      return draws;
    }
    case 6: {
      // ruler-frame：四边刻度（x 32 / y 18；长 12、中 7、短 4）+ 中央环（r 10）+ 中央实心点（r 3）
      for (let index = 0; index <= 32; index += 1) {
        const major = index % 8 === 0;
        const mid = !major && index % 4 === 0;
        const length = major ? 12 : mid ? 7 : 4;
        const alpha = major ? 0.55 : 0.32;
        const key: SonnetBackgroundMgColorKey = major ? 'secondary' : 'primary';
        const x = left + ((right - left) * index) / 32;
        draws.push(line(x, top, x, top + length, 1, alpha, key));
        draws.push(line(x, bottom, x, bottom - length, 1, alpha, key));
      }
      for (let index = 0; index <= 18; index += 1) {
        const major = index % 6 === 0;
        const mid = !major && index % 3 === 0;
        const length = major ? 12 : mid ? 7 : 4;
        const alpha = major ? 0.55 : 0.32;
        const key: SonnetBackgroundMgColorKey = major ? 'secondary' : 'primary';
        const y = top + ((bottom - top) * index) / 18;
        draws.push(line(left, y, left + length, y, 1, alpha, key));
        draws.push(line(right, y, right - length, y, 1, alpha, key));
      }
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      draws.push(strokeCircle(cx, cy, 10, 1, 0.25, 'primary'));
      draws.push(fillCircle(cx, cy, 3, 0.4, 'secondary'));
      return draws;
    }
    case 7: {
      // arc-gauge：四角四分之一弧（2 / 0.5）+ 内弧 ×0.72 + 弧中点 + 三条边中点
      //   + 底部半圆仪表（gaugeY = bottom + arcR × 0.4、gaugeR = min(hw,hh) × 0.16）+ 9 条刻度 + 指针 + 轴心
      const arcR = Math.min(hw, hh) * 0.11;
      const corners = [
        { x: left, y: top, start: 0, end: Math.PI / 2, mid: Math.PI / 4 },
        { x: right, y: top, start: Math.PI / 2, end: Math.PI, mid: (Math.PI * 3) / 4 },
        { x: right, y: bottom, start: Math.PI, end: (Math.PI * 3) / 2, mid: (Math.PI * 5) / 4 },
        { x: left, y: bottom, start: (Math.PI * 3) / 2, end: Math.PI * 2, mid: (Math.PI * 7) / 4 },
      ];
      corners.forEach((corner, index) => {
        draws.push({
          kind: 'arc',
          x: corner.x,
          y: corner.y,
          radius: arcR,
          startAngle: corner.start,
          endAngle: corner.end,
          strokeWidth: 2,
          alpha: 0.5,
          colorKey: 'primary',
        });
        draws.push({
          kind: 'arc',
          x: corner.x,
          y: corner.y,
          radius: arcR * 0.72,
          startAngle: corner.start,
          endAngle: corner.end,
          strokeWidth: 1,
          alpha: 0.25,
          colorKey: 'primary',
        });
        const inward = { x: -Math.sign(corner.x) || 1, y: -Math.sign(corner.y) || 1 };
        draws.push(
          fillCircle(
            corner.x + inward.x * Math.cos(corner.mid) * arcR * 0.72,
            corner.y + inward.y * Math.sin(corner.mid) * arcR * 0.72,
            2,
            0.6,
            index % 2 === 0 ? 'secondary' : 'primary',
          ),
        );
      });
      draws.push(fillCircle((left + right) / 2, top, 2, 0.45, 'primary'));
      draws.push(fillCircle((left + right) / 2, bottom, 2, 0.45, 'primary'));
      draws.push(fillCircle(left, (top + bottom) / 2, 2, 0.45, 'primary'));
      draws.push(fillCircle(right, (top + bottom) / 2, 2, 0.45, 'primary'));
      const gaugeY = bottom + arcR * 0.4;
      const gaugeR = Math.min(hw, hh) * 0.16;
      const gaugeX = (left + right) / 2;
      draws.push({
        kind: 'arc',
        x: gaugeX,
        y: gaugeY,
        radius: gaugeR,
        startAngle: Math.PI,
        endAngle: Math.PI * 2,
        strokeWidth: 1.5,
        alpha: 0.4,
        colorKey: 'primary',
      });
      for (let index = 0; index < 9; index += 1) {
        const angle = Math.PI + (Math.PI * index) / 8;
        const inner = gaugeR * 0.82;
        const strong = index % 4 === 0;
        draws.push(
          line(
            gaugeX + Math.cos(angle) * inner,
            gaugeY + Math.sin(angle) * inner,
            gaugeX + Math.cos(angle) * gaugeR,
            gaugeY + Math.sin(angle) * gaugeR,
            1,
            strong ? 0.55 : 0.32,
            strong ? 'secondary' : 'primary',
          ),
        );
      }
      const needle = Math.PI + ((input.seed % 100) / 100) * Math.PI;
      draws.push(
        line(
          gaugeX,
          gaugeY,
          gaugeX + Math.cos(needle) * gaugeR * 0.8,
          gaugeY + Math.sin(needle) * gaugeR * 0.8,
          2,
          0.6,
          'secondary',
        ),
      );
      draws.push(fillCircle(gaugeX, gaugeY, 2.5, 0.7, 'primary'));
      return draws;
    }
    default: {
      return draws;
    }
  }
}
