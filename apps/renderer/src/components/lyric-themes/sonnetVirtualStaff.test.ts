/**
 * 器乐虚拟五线谱行的用例（第 556 轮）。全部**手算** ✓；
 * 另有一条**性质检验**："相邻两条的间隔恒为 2 秒" ✓（比只测几个端点更能抓错 ✓）。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_VIRTUAL_STAFF_LINE_COUNT,
  SONNET_VIRTUAL_STAFF_LINE_DURATION_SECONDS,
  SONNET_VIRTUAL_STAFF_LINE_SECONDS,
  SONNET_VIRTUAL_STAFF_LINE_TEXT,
  buildSonnetVirtualStaffLines,
  shouldUseSonnetVirtualStaffLines,
} from './sonnetVirtualStaff';

describe('器乐虚拟行：常量', () => {
  it('8 / 6 / 60 / ♪（照抄上游）', () => {
    expect(SONNET_VIRTUAL_STAFF_LINE_SECONDS).toBe(8);
    expect(SONNET_VIRTUAL_STAFF_LINE_DURATION_SECONDS).toBe(6);
    expect(SONNET_VIRTUAL_STAFF_LINE_COUNT).toBe(60);
    expect(SONNET_VIRTUAL_STAFF_LINE_TEXT).toBe('♪');
  });
});

describe('器乐虚拟行：造行', () => {
  it('默认 60 条；第 0 条 [0, 6000ms)、第 1 条 8000ms、最后一条 472000ms', () => {
    const lines = buildSonnetVirtualStaffLines();
    expect(lines).toHaveLength(60);
    expect(lines[0]).toEqual({ index: 0, startMs: 0, durationMs: 6000, text: '♪' });
    expect(lines[1]?.startMs).toBe(8000);
    expect(lines[1]?.durationMs).toBe(6000);
    // 第 59 条：59 × 8 = 472 秒 ✓
    expect(lines[59]?.startMs).toBe(472000);
    expect(lines[59]?.index).toBe(59);
  });

  it('每条的 text 都是 ♪、durationMs 都是 6000', () => {
    for (const line of buildSonnetVirtualStaffLines(0, 12)) {
      expect(line.text).toBe('♪');
      expect(line.durationMs).toBe(6000);
    }
  });

  it('**性质：相邻两条的间隔恒为 2 秒**（8 − 6 = 2 ✓）', () => {
    const lines = buildSonnetVirtualStaffLines();
    for (let index = 0; index + 1 < lines.length; index += 1) {
      const current = lines[index];
      const next = lines[index + 1];
      if (current === undefined || next === undefined) continue;
      expect(next.startMs - (current.startMs + current.durationMs)).toBe(2000);
    }
  });

  it('`fromIndex` 可以从中间接着排（序号与时刻一起平移）', () => {
    const lines = buildSonnetVirtualStaffLines(10, 3);
    expect(lines.map((line) => line.index)).toEqual([10, 11, 12]);
    expect(lines[0]?.startMs).toBe(80000); // 10 × 8 秒 ✓
    expect(lines[2]?.startMs).toBe(96000); // 12 × 8 秒 ✓
  });

  it('条数 0 / 负数 ⇒ 空数组；`fromIndex` 负数会被夹到 0', () => {
    expect(buildSonnetVirtualStaffLines(0, 0)).toEqual([]);
    expect(buildSonnetVirtualStaffLines(0, -3)).toEqual([]);
    expect(buildSonnetVirtualStaffLines(-5, 1)[0]?.index).toBe(0);
  });

  it('小数入参按向下取整处理', () => {
    expect(buildSonnetVirtualStaffLines(2.9, 1.9)).toHaveLength(1);
    expect(buildSonnetVirtualStaffLines(2.9, 1.9)[0]?.index).toBe(2);
  });
});

describe('器乐虚拟行：该不该启用', () => {
  it('完全没有行 ⇒ 启用', () => {
    expect(shouldUseSonnetVirtualStaffLines([])).toBe(true);
  });

  it('有行但一行词都没有 ⇒ 启用', () => {
    expect(shouldUseSonnetVirtualStaffLines([{ words: [] }, { words: [] }])).toBe(true);
    expect(shouldUseSonnetVirtualStaffLines([{}, {}])).toBe(true); // 没带 words 字段也算无词 ✓
  });

  it('只要有一行有词 ⇒ 不启用', () => {
    expect(shouldUseSonnetVirtualStaffLines([{ words: [] }, { words: [{}] }])).toBe(false);
    expect(shouldUseSonnetVirtualStaffLines([{ words: [{}] }])).toBe(false);
  });
});
