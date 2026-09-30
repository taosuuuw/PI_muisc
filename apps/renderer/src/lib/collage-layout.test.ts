import { describe, expect, it } from 'vitest';
import {
  ACTIVE_SCALE,
  BASE_PITCH,
  clampCamera,
  centerCellOf,
  geometryFor,
  hashCoords,
  MAX_ITEMS,
  metricsFor,
  metricsOf,
  orientationOf,
  queueIndexAt,
  sizeOf,
  wrap,
} from './collage-layout';

/**
 * 第十三轮第 7 条（用户 m04663）：队列拼贴的纯几何。
 * 这些断言锁住四件容易在重构里悄悄坏掉的事：
 *   ① 相机永远夹在世界里（拖不出空白）；
 *   ② 世界永远铺满一屏（歌少也是）；
 *   ③ 取模回卷（歌比格子少时不留洞）；
 *   ④ 中心块比邻居大、且仍留缝。
 */
describe('collage-layout 几何', () => {
  const metrics = metricsFor(BASE_PITCH);
  const viewport = { width: 1400, height: 800 };

  it('clampCamera：世界比视口大时夹在 [world-viewport, 0]', () => {
    const world = { worldWidth: 2000, worldHeight: 1600 };
    expect(clampCamera({ x: 10, y: 10 }, viewport, world)).toEqual({ x: 0, y: 0 });
    expect(clampCamera({ x: -200, y: -300 }, viewport, world)).toEqual({ x: -200, y: -300 });
    // 越界就被夹到最右/最下（世界右边界对齐视口右边界）。
    expect(clampCamera({ x: -9000, y: -9000 }, viewport, world)).toEqual({ x: -600, y: -800 });
  });

  it('clampCamera：世界比视口小时居中（歌极少也不偏到一边）', () => {
    const world = { worldWidth: 600, worldHeight: 400 };
    expect(clampCamera({ x: -500, y: -500 }, viewport, world)).toEqual({ x: 400, y: 200 });
  });

  it('geometryFor：列数固定铺满一屏，行数取「铺满」与「装下所有歌」的较大者', () => {
    // ceil((1400 + 136) / 136) = 12 列；ceil((800 + 136) / 136) = 7 行。
    const few = geometryFor(viewport, 3, metrics);
    expect(few.columns).toBe(12);
    expect(few.rows).toBe(7);
    expect(few.worldWidth).toBe(12 * BASE_PITCH);
    expect(few.worldHeight).toBe(7 * BASE_PITCH);
    // 12 列 × 6 行 = 72 格；1000 首需要 ceil(1000 / 12) = 84 行。
    const many = geometryFor(viewport, 1000, metrics);
    expect(many.rows).toBe(84);
    expect(many.columns).toBe(12);
  });

  it('geometryFor：0 首 / 空视口也不产生 0 尺寸世界（避免除零与塌陷）', () => {
    const empty = geometryFor({ width: 0, height: 0 }, 0, metrics);
    expect(empty.columns).toBeGreaterThanOrEqual(1);
    expect(empty.rows).toBeGreaterThanOrEqual(1);
    expect(empty.worldWidth).toBeGreaterThan(0);
    expect(empty.worldHeight).toBeGreaterThan(0);
  });

  it('centerCellOf：相机左上角时中心块是当前屏正中的那一格', () => {
    const world = geometryFor(viewport, 100, metrics);
    // (1400/2) / 136 = 5.14 → 第 5 列；(800/2) / 136 = 2.94 → 第 2 行。
    expect(centerCellOf({ x: 0, y: 0 }, viewport, world, metrics)).toEqual({ col: 5, row: 2 });
  });

  it('centerCellOf：相机被夹到最右下时也不会溢出格子范围', () => {
    const world = geometryFor(viewport, 30, metrics);
    const camera = clampCamera({ x: -99999, y: -99999 }, viewport, world);
    const cell = centerCellOf(camera, viewport, world, metrics);
    expect(cell.col).toBeGreaterThanOrEqual(0);
    expect(cell.col).toBeLessThan(world.columns);
    expect(cell.row).toBeGreaterThanOrEqual(0);
    expect(cell.row).toBeLessThan(world.rows);
  });

  it('queueIndexAt：歌比格子少时取模回卷，负数坐标也正确', () => {
    expect(queueIndexAt(0, 0, 12, 100)).toBe(0);
    expect(queueIndexAt(3, 2, 12, 100)).toBe(27);
    // 12 列 × 1 行 = 12，第 12 格回卷到第 0 首。
    expect(queueIndexAt(0, 1, 12, 7)).toBe(5);
    expect(queueIndexAt(0, 0, 12, 0)).toBe(0);
    expect(wrap(-1, 7)).toBe(6);
  });

  it('sizeOf：中心块明显更大，且放大后仍然留缝（不会盖住邻居）', () => {
    const normal = sizeOf(2, 3, metrics, false);
    const active = sizeOf(2, 3, metrics, true);
    expect(active / normal).toBeGreaterThan(2);
    expect(active).toBeCloseTo(BASE_PITCH * ACTIVE_SCALE - metrics.activeInset * 2, 6);
    // 放大块仍比 ACTIVE_SCALE 格小一点点 → 邻居边缘不会被完全盖掉。
    expect(active).toBeLessThan(BASE_PITCH * ACTIVE_SCALE);
    expect(normal).toBeLessThan(BASE_PITCH);
    expect(normal).toBeGreaterThan(BASE_PITCH * 0.85);
  });

  it('orientationOf/hashCoords：纯函数、同坐标必得同结果，且两种朝向都出现', () => {
    expect(hashCoords(3, 4)).toBe(hashCoords(3, 4));
    expect(orientationOf(3, 4)).toBe(orientationOf(3, 4));
    const seen = new Set<number>();
    for (let col = 0; col < 12; col += 1) {
      for (let row = 0; row < 8; row += 1) seen.add(orientationOf(col, row));
    }
    expect([...seen].sort()).toEqual([0, 1]);
  });

  it('metricsOf：窄窗用小格子，档位单调不增', () => {
    expect(metricsOf(600).pitch).toBeLessThan(metricsOf(900).pitch);
    expect(metricsOf(900).pitch).toBeLessThan(metricsOf(1600).pitch);
    expect(metricsOf(1600).pitch).toBe(BASE_PITCH);
    expect(metricsOf(600).activeScale).toBe(ACTIVE_SCALE);
  });

  it('MAX_ITEMS 是个「一屏够用、但别无限」的数', () => {
    expect(MAX_ITEMS).toBeGreaterThanOrEqual(100);
    expect(MAX_ITEMS).toBeLessThanOrEqual(800);
  });
});
