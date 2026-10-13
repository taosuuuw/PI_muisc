import { describe, expect, it } from 'vitest';

import {
  PENDOLO_ESCAPE_TEETH,
  PENDOLO_GEAR_MOVE_EPSILON_RAD,
  PENDOLO_GEAR_TRAVEL_RATIO,
  pendoloEscapeRatio,
  pendoloGearDrive,
} from './PendoloTheme';

/**
 * 第十五轮第 7 条（时计：歌词转动时小齿轮才转动）+ **用户第 11 轮第 3 条**
 *（「一句歌词转过一个槽而不是一下子转非常多」）的驱动纯函数。
 * `moving` 这个字段就是直接写进 DOM 的 `data-gears="moving" | "idle"`，所以它必须严格可判定。
 */
describe('pendoloGearDrive', () => {
  it('歌词环没动 ⇒ 行程不变、标记 idle（转时转、停时停）', () => {
    expect(pendoloGearDrive(3.5, 0)).toEqual({ travelRad: 3.5, moving: false });
  });

  it('歌词环动了 ⇒ 行程按**净**转角走（用户第 11 轮第 3 条：不再取绝对值累加）', () => {
    expect(pendoloGearDrive(0, 0.218)).toEqual({ travelRad: 0.218, moving: true });
    // 回摆（弹簧过冲回弹）会把行程退回一点 —— 真表的咬合回弹，而不是把摆动量再记一档。
    const back = pendoloGearDrive(0.218, -0.05);
    expect(back.travelRad).toBeCloseTo(0.168, 12);
    expect(back.moving).toBe(true);
  });

  it('一句歌词 **一档**：一来一回的摆动净和仍然是 0，不会把一次换句记成好几档', () => {
    let travel = 0;
    // 一次换句的弹簧轨迹：前进一档 + 过冲 -0.06 + 回来 +0.05 + 收敛
    for (const delta of [0.218, -0.06, 0.05, -0.008]) {
      travel = pendoloGearDrive(travel, delta).travelRad;
    }
    expect(travel).toBeCloseTo(0.218 - 0.06 + 0.05 - 0.008, 12);
    expect(travel).toBeLessThan(0.22);
    // 旧写法（|Δ| 累加）在这一串上会得到 0.336 —— 一次换句被记成 1.5 档以上。
    expect(travel).toBeLessThan(0.336);
  });

  it('阈值以内算停住（浮点噪声不会让齿轮一直抖）', () => {
    expect(pendoloGearDrive(0, PENDOLO_GEAR_MOVE_EPSILON_RAD).moving).toBe(false);
    expect(pendoloGearDrive(0, PENDOLO_GEAR_MOVE_EPSILON_RAD * 0.5).moving).toBe(false);
    expect(pendoloGearDrive(0, PENDOLO_GEAR_MOVE_EPSILON_RAD * 2).moving).toBe(true);
    // 负方向同样按绝对值判「在转」。
    expect(pendoloGearDrive(0, -PENDOLO_GEAR_MOVE_EPSILON_RAD * 2).moving).toBe(true);
  });

  it('自定义阈值可用（默认值就是导出的那个常量）', () => {
    expect(pendoloGearDrive(0, 0.01, 0.1).moving).toBe(false);
    expect(pendoloGearDrive(0, 0.2, 0.1).moving).toBe(true);
  });

  it('行程倍率 = 1：换一句（一档 ≈ 0.218 rad = 12.5°）齿轮正好走一档', () => {
    expect(PENDOLO_GEAR_TRAVEL_RATIO).toBe(1);
    expect(0.218 * PENDOLO_GEAR_TRAVEL_RATIO * (180 / Math.PI)).toBeCloseTo(12.49, 1);
    // 旧值 6 是「一句 75°」的来历，也就是主人说的「一下子转非常多」。
    expect(0.218 * 6 * (180 / Math.PI)).toBeCloseTo(75, 0);
  });
});

/**
 * **用户本轮第 1 条**（原话：「时计的齿轮在转动时转的有点太快了，一句歌词一格齿槽差不多」）：
 * 主擒纵轮（36 齿，齿周期 10°）原来是「一句 1.25 齿」，现在压成「**一句正好一齿**」。
 */
describe('pendoloEscapeRatio（主擒纵轮：一句一齿）', () => {
  it('默认档（100° 弧 ⇒ 12.5°/句）下，一句正好走一齿（10°）', () => {
    const ratio = pendoloEscapeRatio(12.5);
    expect(ratio).toBeCloseTo(0.8, 12);
    // 一档 12.5° × 0.8 = 10° = 360/36，正好一个齿距。
    expect(12.5 * ratio).toBeCloseTo(360 / PENDOLO_ESCAPE_TEETH, 10);
    // 改造前是 1（12.5° = 1.25 齿）—— 主人看到的「有点太快」就是这多出来的 0.25 齿。
    expect(12.5 / (360 / PENDOLO_ESCAPE_TEETH)).toBeCloseTo(1.25, 10);
  });

  it('弧宽调成别的档位也保持「一句一齿」（不是写死 0.8）', () => {
    for (const slotDeg of [7.5, 12.5, 20]) {
      expect(slotDeg * pendoloEscapeRatio(slotDeg)).toBeCloseTo(360 / PENDOLO_ESCAPE_TEETH, 10);
    }
  });

  it('角度是 0 / 负数时不炸（返回 0，齿轮不转）', () => {
    expect(pendoloEscapeRatio(0)).toBe(0);
    expect(pendoloEscapeRatio(-5)).toBe(0);
  });
});
