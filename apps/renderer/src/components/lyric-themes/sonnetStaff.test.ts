/**
 * 五线谱（`sonnetStaff.ts`）的用例（第 456 轮补）。
 * 手算基准：`baseFontSize = 100`、`width = 1000`
 * ⇒ `staffWidth 600 / lineSpacing 25 / totalHeight 100 / halfWidth 300 / halfHeight 50 /
 * playableWidth 552 / beatWidth 23`（**正好整数** ✓）。
 */

import { describe, expect, it } from 'vitest';
import {
  LA_FOLIA_CYCLE_SECONDS,
  LA_FOLIA_STAFF_NOTES,
  LA_FOLIA_TOTAL_BEATS,
  resolveSonnetStaffFrame,
  resolveSonnetStaffGeometry,
  resolveSonnetStaffTimedNotes,
} from './sonnetStaff';

const geometry = resolveSonnetStaffGeometry({ baseFontSize: 100, width: 1000 });
const timed = resolveSonnetStaffTimedNotes();

describe('五线谱：数据（La Folía）', () => {
  it('22 个音符、合计 24 拍、循环 8 秒', () => {
    expect(LA_FOLIA_STAFF_NOTES).toHaveLength(22);
    expect(LA_FOLIA_TOTAL_BEATS).toBe(24);
    expect(LA_FOLIA_CYCLE_SECONDS).toBe(8);
    // 每拍 = 8 / 24 = 1/3 秒 ⇒ 整曲 8 秒走完 ✓
    expect(LA_FOLIA_CYCLE_SECONDS / LA_FOLIA_TOTAL_BEATS).toBeCloseTo(1 / 3, 6);
  });

  it('升号只出现在 C#5 上：共 4 个（第 4/5/6 与第 21 个）', () => {
    const sharpIndices = LA_FOLIA_STAFF_NOTES.map((note, index) =>
      note.accidental === 'sharp' ? index : -1,
    ).filter((index) => index >= 0);
    expect(sharpIndices).toEqual([3, 4, 5, 20]);
    for (const note of LA_FOLIA_STAFF_NOTES) {
      if (note.accidental === 'sharp') expect(note.pitch).toBe('C#5');
      if (note.pitch === 'C#5') expect(note.accidental).toBe('sharp');
    }
  });

  it('音高与 staffStep 一一对应（C#5→5 / D5→6 / E5→7 / F5→8）', () => {
    const map: Record<string, number> = { 'C#5': 5, D5: 6, E5: 7, F5: 8 };
    for (const note of LA_FOLIA_STAFF_NOTES) expect(note.staffStep).toBe(map[note.pitch]);
  });

  it('startBeat 累加：首音 0、末音 21，且最后加上 3 拍正好等于总拍数', () => {
    expect(timed).toHaveLength(22);
    expect(timed[0]?.startBeat).toBe(0);
    expect(timed[21]?.startBeat).toBe(21);
    const last = timed[21]!;
    expect(last.startBeat + last.beats).toBe(LA_FOLIA_TOTAL_BEATS);
    // 逐条累加关系 ✓
    timed.forEach((note, index) => {
      if (index === 0) return;
      const previous = timed[index - 1]!;
      expect(note.startBeat).toBeCloseTo(previous.startBeat + previous.beats, 6);
      expect(note.index).toBe(index);
    });
  });
});

describe('五线谱：几何（clamp 与手算）', () => {
  it('width 1000 ⇒ 600/25/100/300/50/552/23', () => {
    expect(geometry.staffWidth).toBe(600);
    expect(geometry.lineSpacing).toBe(25);
    expect(geometry.totalHeight).toBe(100);
    expect(geometry.halfWidth).toBe(300);
    expect(geometry.halfHeight).toBe(50);
    expect(geometry.playableWidth).toBeCloseTo(552, 6);
    expect(geometry.beatWidth).toBeCloseTo(23, 6);
  });

  it('width 400 ⇒ staffWidth 取 300 下限', () => {
    expect(resolveSonnetStaffGeometry({ baseFontSize: 100, width: 400 }).staffWidth).toBe(300);
  });

  it('5 条谱线 y = [−50, −25, 0, 25, 50]', () => {
    expect([...geometry.staffLineY]).toEqual([-50, -25, 0, 25, 50]);
  });

  it('7 条小节线 x = −276 + 69·bar（即每 3 拍一条）', () => {
    expect([...geometry.barLineX]).toEqual([-207, -138, -69, 0, 69, 138, 207]);
  });

  it('三条边饰：−290/宽 4、290/宽 2、296/宽 6', () => {
    expect(geometry.edgeBars).toEqual([
      { x: -290, width: 4 },
      { x: 290, width: 2 },
      { x: 296, width: 6 },
    ]);
  });
});

describe('五线谱：逐帧参数', () => {
  it('time = shotStart + 2 ⇒ cycleElapsed 2、beatPosition 6、cursorX −138', () => {
    const frame = resolveSonnetStaffFrame({ time: 102, shotStartTime: 100, geometry, notes: timed });
    expect(frame.cycleElapsed).toBeCloseTo(2, 6);
    expect(frame.beatPosition).toBeCloseTo(6, 6);
    expect(frame.cursorX).toBeCloseTo(-138, 6); // −276 + 23 × 6
  });

  it('循环与负时间都用 positiveModulo：+10 秒与 +2 秒同相；−2 秒等价于 6 秒', () => {
    const a = resolveSonnetStaffFrame({ time: 102, shotStartTime: 100, geometry, notes: timed });
    const b = resolveSonnetStaffFrame({ time: 110, shotStartTime: 100, geometry, notes: timed });
    const c = resolveSonnetStaffFrame({ time: 98, shotStartTime: 100, geometry, notes: timed });
    expect(b.beatPosition).toBeCloseTo(a.beatPosition, 6);
    expect(c.cycleElapsed).toBeCloseTo(6, 6);
    expect(c.beatPosition).toBeCloseTo(18, 6);
  });

  it('beatPosition 6 时恰好第 7 个音符（index 6）在响，其余不响', () => {
    const frame = resolveSonnetStaffFrame({ time: 102, shotStartTime: 100, geometry, notes: timed });
    const active = frame.notes.filter((note) => note.isActive);
    expect(active).toHaveLength(1);
    expect(active[0]?.index).toBe(6);
    // 不响的：alpha = 0.28 + (index % 3) × 0.03 ✓
    frame.notes
      .filter((note) => !note.isActive)
      .forEach((note) => expect(note.alpha).toBeCloseTo(0.28 + (note.index % 3) * 0.03, 6));
  });

  it('y = halfHeight − staffStep × lineSpacing × 0.5：四个级进的落点', () => {
    const frame = resolveSonnetStaffFrame({ time: 102, shotStartTime: 100, geometry, notes: timed });
    const byIndex = new Map(frame.notes.map((note) => [note.index, note]));
    // index 0 是 D5（step 6）⇒ y = 50 − 75 = −25
    expect(byIndex.get(0)?.y).toBeCloseTo(-25, 6);
    // index 2 是 E5（step 7）⇒ y = 50 − 87.5 = −37.5
    expect(byIndex.get(2)?.y).toBeCloseTo(-37.5, 6);
    // index 3 是 C#5（step 5）⇒ y = 50 − 62.5 = −12.5
    expect(byIndex.get(3)?.y).toBeCloseTo(-12.5, 6);
    // index 12 是 F5（step 8）⇒ y = 50 − 100 = −50（正好在第 5 线上）
    expect(byIndex.get(12)?.y).toBeCloseTo(-50, 6);
  });

  it('符干方向与符尾：staffStep ≥ 6 朝下；beats ≤ 0.5 才有符尾', () => {
    const frame = resolveSonnetStaffFrame({ time: 102, shotStartTime: 100, geometry, notes: timed });
    const byIndex = new Map(frame.notes.map((note) => [note.index, note]));
    expect(byIndex.get(0)?.stemDown).toBe(true); // D5 step 6 ✓
    expect(byIndex.get(3)?.stemDown).toBe(false); // C#5 step 5 ✓
    expect(byIndex.get(2)?.hasFlag).toBe(true); // 0.5 拍 ✓
    expect(byIndex.get(0)?.hasFlag).toBe(false); // 1 拍 ✓
    expect(byIndex.get(21)?.hasFlag).toBe(false); // 3 拍 ✓
  });

  it('升号只在 C#5 上出现（sharpX 非空），且位置在音符左侧', () => {
    const frame = resolveSonnetStaffFrame({ time: 102, shotStartTime: 100, geometry, notes: timed });
    frame.notes.forEach((note) => {
      const source = timed[note.index]!;
      if (source.pitch === 'C#5') {
        expect(note.sharpX).not.toBeNull();
        expect(note.sharpX!).toBeLessThan(note.x); // 在音符左边 ✓
        expect(note.sharpX!).toBeCloseTo(note.x - note.radiusX * 2.3, 6);
      } else {
        expect(note.sharpX).toBeNull();
      }
    });
  });

  it('在响的音符 alpha 由 pulse 决定，且 pulse 符合相位公式', () => {
    const frame = resolveSonnetStaffFrame({ time: 102, shotStartTime: 100, geometry, notes: timed });
    const active = frame.notes.find((note) => note.isActive)!;
    const expectedPulse = (Math.sin(2 * Math.PI * 5 + active.index * 0.4) + 1) / 2;
    expect(active.pulse).toBeCloseTo(expectedPulse, 6);
    expect(active.alpha).toBeCloseTo(0.78 + expectedPulse * 0.16, 6);
    // 缩放也随 pulse：1 + pulse × 0.12 ✓（半径正比于它 ✓）
    expect(active.radiusX).toBeCloseTo(25 * 0.42 * (1 + expectedPulse * 0.12), 6);
    expect(active.radiusY).toBeCloseTo(25 * 0.29 * (1 + expectedPulse * 0.12), 6);
  });
});
