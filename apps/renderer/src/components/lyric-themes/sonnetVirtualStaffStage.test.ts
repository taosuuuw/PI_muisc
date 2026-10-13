/**
 * 器乐虚拟行 → 我们的行类型（`StageLine`）映射的用例（第 561 轮）。
 *
 * ⚠ 更正一处我自己的笔误 ✓：第 222 轮我在 `PLAN.md` 里写"字段集合恰为**七个**" ✗ ——
 * `StageLine`（`types.ts:43~52`）其实是**八个**字段：`index / timeMs / text / durationMs /
 * hint / words / starts / ends` ✓。下面就用"**八个，一个不多一个不少**"来钉住它 ✓。
 */

import { describe, expect, it } from 'vitest';
import { toSonnetVirtualStaffStageLines } from './sonnetVirtualStaffStage';
import type { SonnetVirtualStaffLine } from './sonnetVirtualStaff';

const line = (index: number): SonnetVirtualStaffLine => ({
  index,
  startMs: index * 8000,
  durationMs: 6000,
  text: '♪',
});

describe('虚拟行映射：单条', () => {
  const mapped = toSonnetVirtualStaffStageLines([line(0)]);
  const first = mapped[0];

  it('七个来源字段落到正确的目标字段', () => {
    expect(first?.index).toBe(0);
    expect(first?.timeMs).toBe(0);
    expect(first?.text).toBe('♪');
    expect(first?.durationMs).toBe(6000);
    expect(first?.hint).toBe('normal');
    expect(first?.words).toEqual([]);
    expect(first?.starts).toEqual([]);
    expect(first?.ends).toEqual([]);
  });

  it('**字段集合恰为八个**，一个不多一个不少（防漏填/多填）', () => {
    expect(Object.keys(first ?? {}).sort()).toEqual(
      ['durationMs', 'ends', 'hint', 'index', 'starts', 'text', 'timeMs', 'words'].sort(),
    );
  });

  it('`hint` 是合法取值（`types.ts:21` 的三种之一）', () => {
    expect(['normal', 'short', 'micro']).toContain(first?.hint);
  });
});

describe('虚拟行映射：批量与边界', () => {
  it('条数与顺序保持一致，序号从 10 起也照搬', () => {
    const mapped = toSonnetVirtualStaffStageLines([line(10), line(11), line(12)]);
    expect(mapped).toHaveLength(3);
    expect(mapped.map((item) => item.index)).toEqual([10, 11, 12]);
    expect(mapped.map((item) => item.timeMs)).toEqual([80000, 88000, 96000]);
    expect(mapped.every((item) => item.durationMs === 6000)).toBe(true);
  });

  it('空数组 ⇒ 空数组', () => {
    expect(toSonnetVirtualStaffStageLines([])).toEqual([]);
  });

  it('不改动入参（纯函数）', () => {
    const input = [line(0), line(1)];
    const snapshot = JSON.stringify(input);
    toSonnetVirtualStaffStageLines(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
