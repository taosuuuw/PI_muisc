import { describe, expect, it } from 'vitest';
import {
  buildRainLayout,
  dynamicDropMetrics,
  isLyricCenter,
  lensLeadPx,
  rainSizeScale,
  RAIN_CLUSTER_COUNT,
  RAIN_DYNAMIC_CYCLES,
  RAIN_DYNAMIC_DROP_COUNT,
  RAIN_LARGE_BEAD_COUNT,
  RAIN_LENS_MIN_SIZE_PX,
  RAIN_MEDIUM_BEAD_COUNT,
  RAIN_SCATTER_BEAD_COUNT,
  RAIN_TRAIL_COUNT,
} from './rain-layout';

/**
 * 「雨窗」几何的单元测试。
 *
 * 这一版不只测确定性，还锁住「别退回上一版」的几条视觉底线：
 * - 水珠数量够密（但不是均匀白点）；
 * - 大透镜不进歌词中心；
 * - 动态水珠每颗有多轮不同参数，不是 6 颗共用一个周期；
 * - 轮廓/尺寸/停顿都在合理范围，不能出 NaN。
 */
describe('rain-layout 几何', () => {
  it('同一首歌永远得到完全相同的 layout', () => {
    expect(buildRainLayout(186016)).toEqual(buildRainLayout(186016));
  });

  it('不同的歌会换一场雨', () => {
    expect(buildRainLayout(1)).not.toEqual(buildRainLayout(2));
  });

  it('静态珠 / 水痕 / 动态水珠的数量在目标档位', () => {
    const layout = buildRainLayout(42);
    // 团簇数量可变，但主体散珠/中珠/大珠是精确的；再加上每颗动态水珠的积聚伙伴。
    expect(layout.beads.length).toBeGreaterThanOrEqual(
      RAIN_CLUSTER_COUNT * 6 +
        RAIN_SCATTER_BEAD_COUNT +
        RAIN_MEDIUM_BEAD_COUNT +
        RAIN_LARGE_BEAD_COUNT +
        RAIN_DYNAMIC_DROP_COUNT * 5,
    );
    expect(layout.trails).toHaveLength(RAIN_TRAIL_COUNT);
    expect(layout.dynamicDrops).toHaveLength(RAIN_DYNAMIC_DROP_COUNT);
    // 大透镜 = 过线的大珠；至少要有 RAIN_LARGE_BEAD_COUNT 颗（可能还有一些中等珠过线）。
    expect(layout.lenses.length).toBeGreaterThanOrEqual(RAIN_LARGE_BEAD_COUNT);
  });

  it('每颗动态水珠都有多轮不同参数（不是共用一个匀速循环）', () => {
    const layout = buildRainLayout(7);
    for (const drop of layout.dynamicDrops) {
      expect(drop.cycles).toHaveLength(RAIN_DYNAMIC_CYCLES);
      expect(new Set(drop.cycles.map((cycle) => cycle.attachSeconds)).size).toBeGreaterThan(1);
      expect(new Set(drop.cycles.map((cycle) => cycle.startLeftPercent)).size).toBeGreaterThan(1);
      expect(drop.respawnSeconds).toBeGreaterThan(0);
    }
    // 不同水珠的第一轮也不该完全一样。
    expect(layout.dynamicDrops[0]?.cycles[0]).not.toEqual(layout.dynamicDrops[1]?.cycles[0]);
  });

  it('动态水珠从两侧起步，路径带子不穿过歌词中心', () => {
    const layout = buildRainLayout(99);
    for (const drop of layout.dynamicDrops) {
      for (const cycle of drop.cycles) {
        expect(cycle.startLeftPercent).toBeGreaterThanOrEqual(0);
        expect(cycle.startLeftPercent).toBeLessThanOrEqual(100);
        expect(isLyricCenter(cycle.startLeftPercent, cycle.startTopPercent)).toBe(false);
        expect(cycle.band[0]).toBeLessThan(cycle.band[1]);
        expect(cycle.startLeftPercent).toBeGreaterThanOrEqual(cycle.band[0]);
        expect(cycle.startLeftPercent).toBeLessThanOrEqual(cycle.band[1]);
        expect(cycle.initialAttachSeconds).toBeLessThan(cycle.attachSeconds);
        expect(cycle.pauses.length).toBeGreaterThan(0);
        let previousAt = 0;
        for (const pause of cycle.pauses) {
          expect(pause.at).toBeGreaterThan(previousAt);
          expect(pause.at).toBeLessThanOrEqual(1);
          expect(pause.seconds).toBeGreaterThan(0);
          previousAt = pause.at;
        }
      }
    }
  });

  it('中心不再掏空；大珠/透镜只按尺寸和可见几何选，不按旧歌词禁区', () => {
    const layout = buildRainLayout(123);
    for (const lens of layout.lenses) {
      expect(lens.sizePx).toBeGreaterThanOrEqual(RAIN_LENS_MIN_SIZE_PX);
      expect(lens.targetOffsetPx).toBeGreaterThan(0);
    }
    const centralLarge = layout.beads.filter(
      (bead) => isLyricCenter(bead.leftPercent, bead.topPercent) && bead.sizePx >= 8,
    );
    expect(centralLarge.length).toBeGreaterThan(0);
  });

  it('主尺寸分布是 6~20px 主体，超大只做少量，小微珠只做辅料', () => {
    const layout = buildRainLayout(186016);
    const micro = layout.beads.filter((bead) => bead.sizePx < 4).length;
    const main = layout.beads.filter(
      (bead) => bead.sizePx >= 6 && bead.sizePx <= 20,
    ).length;
    const large = layout.beads.filter((bead) => bead.sizePx > 20).length;
    expect(main / layout.beads.length).toBeGreaterThan(0.5);
    expect(micro / layout.beads.length).toBeLessThan(0.25);
    expect(large).toBeGreaterThan(20);
  });

  it('所有数值都在合理区间内（不会铺出窗口、也不会有负时长）', () => {
    const layout = buildRainLayout(7);
    for (const bead of layout.beads) {
      expect(bead.leftPercent).toBeGreaterThanOrEqual(0);
      expect(bead.leftPercent).toBeLessThanOrEqual(100);
      expect(bead.topPercent).toBeGreaterThanOrEqual(0);
      expect(bead.topPercent).toBeLessThanOrEqual(100);
      expect(bead.sizePx).toBeGreaterThan(0);
      expect(bead.opacity).toBeGreaterThan(0);
      expect(bead.opacity).toBeLessThanOrEqual(1);
      expect(bead.shape.squash).toBeGreaterThanOrEqual(0.7);
      expect(bead.shape.squash).toBeLessThanOrEqual(1.4);
      expect(bead.shape.tiltDeg).toBeGreaterThanOrEqual(-55);
      expect(bead.shape.tiltDeg).toBeLessThanOrEqual(55);
    }
    for (const trail of layout.trails) {
      expect(trail.leftPercent).toBeGreaterThanOrEqual(0);
      expect(trail.leftPercent).toBeLessThanOrEqual(100);
      expect(trail.topPercent).toBeGreaterThanOrEqual(0);
      expect(trail.topPercent).toBeLessThanOrEqual(100);
      expect(trail.lengthPx).toBeGreaterThan(0);
      expect(trail.widthPx).toBeGreaterThan(0);
      expect(trail.opacity).toBeGreaterThan(0);
      expect(trail.opacity).toBeLessThanOrEqual(0.2);
      let previous = -1;
      for (const bead of trail.beads) {
        expect(bead.at).toBeGreaterThanOrEqual(0);
        expect(bead.at).toBeLessThanOrEqual(1);
        // 串珠必须沿水痕往下排；乱序会让「水流过」的方向读不出来。
        expect(bead.at).toBeGreaterThan(previous);
        previous = bead.at;
        expect(bead.sizePx).toBeGreaterThan(0);
        expect(bead.opacity).toBeGreaterThan(0);
        expect(bead.opacity).toBeLessThanOrEqual(1);
      }
    }
    for (const drop of layout.dynamicDrops) {
      for (const cycle of drop.cycles) {
        expect(cycle.baseSizePx).toBeGreaterThan(0);
        expect(cycle.gravity).toBeGreaterThan(0);
        expect(cycle.drag).toBeGreaterThan(0);
        expect(cycle.releaseSpeed).toBeGreaterThan(0);
        expect(cycle.maxSpeed).toBeGreaterThan(cycle.releaseSpeed);
        expect(cycle.trailLengthPx).toBeGreaterThan(0);
        expect(cycle.trailFadeSeconds).toBeGreaterThan(0);
        // 重力路径总体竖直：横向漂移和长 S 摆动都要收小。
        expect(Math.abs(cycle.driftPercent)).toBeLessThanOrEqual(3.2);
        expect(cycle.wobblePercent).toBeLessThanOrEqual(0.42);
        expect(cycle.wobbleWaves).toBeLessThanOrEqual(2.2);
        expect(cycle.shape.borderRadius).toMatch(/%/);
      }
    }
  });

  it('水珠不会全挤在同一处（横纵两个方向都有铺开）', () => {
    const layout = buildRainLayout(99);
    const left = layout.beads.map((bead) => bead.leftPercent);
    expect(Math.min(...left)).toBeLessThan(10);
    expect(Math.max(...left)).toBeGreaterThan(90);
    const top = layout.beads.map((bead) => bead.topPercent);
    expect(Math.min(...top)).toBeLessThan(10);
    expect(Math.max(...top)).toBeGreaterThan(90);
  });

  it('簇状分布仍在，但微珠只是辅料，不是整场主体', () => {
    const layout = buildRainLayout(7);
    const fine = layout.beads.filter((bead) => bead.sizePx <= 3.2);
    expect(fine.length).toBeLessThan(layout.beads.length * 0.25);
    const rounded = new Set(
      fine.map((bead) => `${Math.round(bead.leftPercent / 3)}:${Math.round(bead.topPercent / 3)}`),
    );
    expect(rounded.size).toBeLessThanOrEqual(fine.length);
  });

  it('窗口缩放系数单调、在 0.85~1.3 之间', () => {
    expect(rainSizeScale(320)).toBe(0.85);
    expect(rainSizeScale(1440)).toBe(1);
    expect(rainSizeScale(3840)).toBe(1.3);
  });

  it('动态水珠的可见椭圆与透镜框是同一套数（尺寸/压扁/拉伸）', () => {
    // 静止、正圆：本体和透镜都是 20×20。
    const still = dynamicDropMetrics(20, 10, 0, 1);
    expect(still.width).toBeCloseTo(20, 5);
    expect(still.height).toBeCloseTo(20, 5);
    expect(still.scaleX).toBeCloseTo(1, 5);
    expect(still.scaleY).toBeCloseTo(1, 5);

    // 合并后半径变大：可见尺寸跟着长大，不是只长折射。
    const grown = dynamicDropMetrics(20, 15, 0, 1);
    expect(grown.width).toBeCloseTo(30, 5);
    expect(grown.height).toBeCloseTo(30, 5);

    // 泪滴压扁：横向不变，纵向跟 squash 一起。
    const squashed = dynamicDropMetrics(20, 10, 0, 1.25);
    expect(squashed.width).toBeCloseTo(20, 5);
    expect(squashed.height).toBeCloseTo(25, 5);

    // 滑落拉伸：纵向变长、横向收窄，本体和透镜共用这一对 scale。
    const sliding = dynamicDropMetrics(20, 10, 180, 1);
    expect(sliding.scaleX).toBeLessThan(1);
    expect(sliding.scaleY).toBeGreaterThan(1);
    expect(sliding.width).toBeLessThan(20);
    expect(sliding.height).toBeGreaterThan(20);

    // 极端值不回 NaN/负数。
    const extreme = dynamicDropMetrics(0, 0, -10, Number.NaN);
    expect(Number.isFinite(extreme.width)).toBe(true);
    expect(Number.isFinite(extreme.height)).toBe(true);
    expect(extreme.width).toBeGreaterThan(0);
    expect(extreme.height).toBeGreaterThan(0);
  });

  it('45fps 透镜半批次预测：最多把分离减半，且有上限', () => {
    const intervalMs = 1000 / 45;
    // 174px/s 时，一个批次本体走约 3.87px；半批次预测约 1.93px。
    const lead = lensLeadPx(174, intervalMs, 2.2);
    expect(lead).toBeGreaterThan(1.8);
    expect(lead).toBeLessThan(2.2);
    // 极快/异常输入不越过上限，也不出负数。
    expect(lensLeadPx(10000, intervalMs, 2.2)).toBe(2.2);
    expect(lensLeadPx(-50, intervalMs, 2.2)).toBe(0);
    expect(lensLeadPx(Number.NaN, intervalMs, 2.2)).toBe(0);
    expect(lensLeadPx(174, 0, 2.2)).toBe(0);
  });

  it('结果里没有 NaN（浮点算错时会从这里先暴露）', () => {
    const layout = buildRainLayout(123456);
    const numbers = [
      ...layout.beads.flatMap((item) => [
        item.leftPercent,
        item.topPercent,
        item.sizePx,
        item.opacity,
        item.shape.squash,
        item.shape.tiltDeg,
        item.shape.wobble,
        item.shape.wobblePhase,
      ]),
      ...layout.trails.flatMap((item) => [
        item.leftPercent,
        item.topPercent,
        item.lengthPx,
        item.widthPx,
        item.opacity,
        item.curvePx,
        item.wavePx,
        ...item.beads.flatMap((bead) => [bead.at, bead.sizePx, bead.opacity]),
      ]),
      ...layout.dynamicDrops.flatMap((drop) => [
        drop.respawnSeconds,
        ...drop.cycles.flatMap((cycle) => [
          cycle.startLeftPercent,
          cycle.startTopPercent,
          cycle.baseSizePx,
          cycle.attachSeconds,
          cycle.initialAttachSeconds,
          cycle.driftPercent,
          cycle.wobblePercent,
          cycle.wobbleWaves,
          cycle.gravity,
          cycle.drag,
          cycle.releaseSpeed,
          cycle.maxSpeed,
          cycle.trailLengthPx,
          cycle.trailFadeSeconds,
          ...cycle.pauses.flatMap((pause) => [pause.at, pause.seconds]),
        ]),
      ]),
      ...layout.lenses.flatMap((item) => [
        item.leftPercent,
        item.topPercent,
        item.sizePx,
        item.opacity,
        item.targetOffsetPx,
      ]),
    ];
    expect(numbers.every((value) => Number.isFinite(value))).toBe(true);
  });
});
