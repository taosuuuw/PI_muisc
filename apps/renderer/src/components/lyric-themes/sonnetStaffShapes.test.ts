/**
 * 五线谱图元（`sonnetStaffShapes.ts`）的用例（第 458 轮补）。
 * 几何基准同 `sonnetStaff.test.ts`：`lineSpacing 25 / halfWidth 300 / halfHeight 50 / beatWidth 23` ✓。
 */

import { describe, expect, it } from 'vitest';
import {
  resolveSonnetStaffFrame,
  resolveSonnetStaffGeometry,
  resolveSonnetStaffTimedNotes,
} from './sonnetStaff';
import {
  resolveSonnetStaffCursorDraw,
  resolveSonnetStaffDraws,
  resolveSonnetStaffDynamicDraws,
  resolveSonnetStaffStaticDraws,
  type SonnetStaffDraw,
} from './sonnetStaffShapes';



const geometry = resolveSonnetStaffGeometry({ baseFontSize: 100, width: 1000 });
const notes = resolveSonnetStaffTimedNotes();
const TIME = 102;
const SHOT_START = 100;

const lines = (draws: readonly SonnetStaffDraw[]) => draws.filter((draw) => draw.kind === 'line');
const ellipses = (draws: readonly SonnetStaffDraw[]) => draws.filter((draw) => draw.kind === 'ellipse');
const curves = (draws: readonly SonnetStaffDraw[]) => draws.filter((draw) => draw.kind === 'quadratic');

describe('五线谱图元：静态谱面', () => {
  it('15 条静态线 = 谱线 5 + 小节线 7 + 边饰 3，且全是 primary', () => {
    const draws = resolveSonnetStaffStaticDraws(geometry);
    expect(draws).toHaveLength(15);
    expect(lines(draws)).toHaveLength(15);
    expect(draws.every((draw) => draw.colorKey === 'primary')).toBe(true);
  });

  it('谱线 5 条的 y 与描边（width 2 / alpha 0.3），横向贯穿 ±halfWidth', () => {
    const staffLines = lines(resolveSonnetStaffStaticDraws(geometry)).slice(0, 5);
    expect(staffLines.map((line) => line.y1)).toEqual([-50, -25, 0, 25, 50]);
    staffLines.forEach((line) => {
      expect(line.x1).toBe(-300);
      expect(line.x2).toBe(300);
      expect(line.width).toBe(2);
      expect(line.alpha).toBeCloseTo(0.3, 6);
    });
  });

  it('小节线 7 条（width 1 / alpha 0.16）；边饰 3 条（alpha 0.5、宽度 4/2/6）', () => {
    const all = lines(resolveSonnetStaffStaticDraws(geometry));
    const bars = all.slice(5, 12);
    expect(bars.map((line) => line.x1)).toEqual([-207, -138, -69, 0, 69, 138, 207]);
    bars.forEach((line) => {
      expect(line.y1).toBe(-50);
      expect(line.y2).toBe(50);
      expect(line.width).toBe(1);
      expect(line.alpha).toBeCloseTo(0.16, 6);
    });
    const edges = all.slice(12);
    expect(edges.map((line) => ({ x: line.x1, width: line.width }))).toEqual([
      { x: -290, width: 4 },
      { x: 290, width: 2 },
      { x: 296, width: 6 },
    ]);
    edges.forEach((line) => expect(line.alpha).toBeCloseTo(0.5, 6));
  });
});

describe('五线谱图元：播放头', () => {
  it('竖线在 cursorX，上下各多出 lineSpacing×0.8（±70），accent / 1.5 / 0.34', () => {
    const frame = resolveSonnetStaffFrame({
      time: TIME,
      shotStartTime: SHOT_START,
      geometry,
      notes,
    });
    const cursor = resolveSonnetStaffCursorDraw(geometry, frame);
    expect(cursor).toMatchObject({ kind: 'line', colorKey: 'accent', width: 1.5 });
    expect(cursor.kind === 'line' && cursor.x1).toBeCloseTo(-138, 6);
    expect(cursor.kind === 'line' && cursor.x2).toBeCloseTo(-138, 6);
    expect(cursor.kind === 'line' && cursor.y1).toBeCloseTo(-70, 6); // −50 − 20
    expect(cursor.kind === 'line' && cursor.y2).toBeCloseTo(70, 6); // 50 + 20
    expect(cursor.alpha).toBeCloseTo(0.34, 6);
  });
});

describe('五线谱图元：动态（音符）', () => {
  const frame = resolveSonnetStaffFrame({ time: TIME, shotStartTime: SHOT_START, geometry, notes });
  const dynamic = resolveSonnetStaffDynamicDraws(geometry, frame);

  it('总量 = 符干 22 + 符尾 4 + 升号 16 + 符头 22 = 64', () => {
    expect(dynamic).toHaveLength(64);
    expect(ellipses(dynamic)).toHaveLength(22);
    expect(curves(dynamic)).toHaveLength(4); // 0.5 拍的四个音符 ✓
    // 升号 4 个 × 4 笔 = 16 条线；符干 22 条 ⇒ 线共 38 ✓
    expect(lines(dynamic)).toHaveLength(38);
  });

  it('只有播放头与符头用 accent，其余全是 primary', () => {
    const all = resolveSonnetStaffDraws({
      geometry,
      time: TIME,
      shotStartTime: SHOT_START,
      notes,
    });
    expect(all.cursor.colorKey).toBe('accent');
    const accentCount =
      (all.cursor.colorKey === 'accent' ? 1 : 0) +
      all.dynamic.filter((draw) => draw.colorKey === 'accent').length;
    expect(accentCount).toBe(23); // 播放头 1 + 符头 22 ✓
    expect(
      all.static.every((draw) => draw.colorKey === 'primary') &&
        all.dynamic.filter((draw) => draw.colorKey === 'accent').every((draw) => draw.kind === 'ellipse'),
    ).toBe(true);
  });

  it('在响的音符（index 6，D5）：y −25、x −126.5、符干朝下、末端 +77.5', () => {
    const active = frame.notes.find((note) => note.index === 6)!;
    expect(active.y).toBeCloseTo(-25, 6);
    expect(active.x).toBeCloseTo(-126.5, 6); // −276 + 23 × 6.5
    expect(active.stemDown).toBe(true);
    expect(active.stemEndY).toBeCloseTo(active.y + 25 * 3.1, 6);
    expect(active.stemX).toBeCloseTo(active.x - active.radiusX, 6);
    // 对应的符干图元在清单里 ✓
    const stem = lines(dynamic).find(
      (line) => Math.abs(line.x1 - active.stemX) < 1e-6 && Math.abs(line.y1 - active.y) < 1e-6,
    );
    expect(stem?.y2).toBeCloseTo(active.stemEndY, 6);
    expect(stem?.alpha).toBeCloseTo(Math.min(0.9, active.alpha + 0.08), 6);
  });

  it('符尾曲线：控制点与终点按下倾方向算（E5 的 0.5 拍音符，stemDown ⇒ dir −1）', () => {
    const flagged = frame.notes.find((note) => note.index === 2)!; // E5 / 0.5 拍 / step 7 ✓
    expect(flagged.hasFlag).toBe(true);
    expect(flagged.stemDown).toBe(true);
    const curve = curves(dynamic)[0]!;
    expect(curve.kind === 'quadratic' && curve.fromX).toBeCloseTo(flagged.stemX, 6);
    expect(curve.kind === 'quadratic' && curve.fromY).toBeCloseTo(flagged.stemEndY, 6);
    expect(curve.kind === 'quadratic' && curve.controlX).toBeCloseTo(flagged.stemX + 25 * 1.1, 6);
    expect(curve.kind === 'quadratic' && curve.controlY).toBeCloseTo(flagged.stemEndY - 25 * 0.55, 6);
    expect(curve.kind === 'quadratic' && curve.toX).toBeCloseTo(flagged.stemX + 25 * 0.1, 6);
    expect(curve.kind === 'quadratic' && curve.toY).toBeCloseTo(flagged.stemEndY - 25, 6);
  });

  it('升号 4 笔：两条竖线 ±0.16×lineSpacing，两条斜杠各跨 0.6×lineSpacing（近似 ✓）', () => {
    const sharpNote = frame.notes.find((note) => note.index === 3)!; // C#5 ✓
    expect(sharpNote.sharpX).not.toBeNull();
    const sharpX = sharpNote.sharpX!;
    /*
     * ⚠ 第 458 轮这里先用"容差 0.17 × lineSpacing"筛竖线，结果**撞到了第三条** ✗ ——
     * 容差筛选在"谱上线条本来就密"的地方不可靠 ✓ ⇒ 改成**精确匹配**两条竖线的 x ✓。
     */
    const verticals = lines(dynamic).filter(
      (line) =>
        Math.abs(line.x1 - (sharpX - 25 * 0.16)) < 1e-6 ||
        Math.abs(line.x1 - (sharpX + 25 * 0.16)) < 1e-6,
    );
    expect(verticals).toHaveLength(2);
    expect(verticals.map((line) => line.x1).sort((a, b) => a - b)).toEqual([
      sharpX - 25 * 0.16,
      sharpX + 25 * 0.16,
    ]);
    const slants = lines(dynamic).filter(
      (line) => Math.abs(line.x1 - (sharpX - 25 * 0.3)) < 1e-6 && Math.abs(line.x2 - (sharpX + 25 * 0.3)) < 1e-6,
    );
    expect(slants).toHaveLength(2);
    expect(slants[0]!.width).toBe(1.2);
    expect(slants[0]!.alpha).toBeCloseTo(Math.min(0.86, sharpNote.alpha + 0.08), 6);
  });

  it('符头椭圆用动态半径（含 pulse 缩放），不是几何常数', () => {
    const active = frame.notes.find((note) => note.isActive)!;
    const ellipse = ellipses(dynamic).find(
      (draw) => draw.kind === 'ellipse' && Math.abs(draw.x - active.x) < 1e-6,
    );
    expect(ellipse?.kind === 'ellipse' && ellipse.radiusX).toBeCloseTo(active.radiusX, 6);
    expect(ellipse?.kind === 'ellipse' && ellipse.radiusY).toBeCloseTo(active.radiusY, 6);
    expect(ellipse?.alpha).toBeCloseTo(active.alpha, 6);
  });
});
