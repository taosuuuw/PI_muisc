import { describe, expect, it } from 'vitest';

import {
  PENDOLO_GEAR_MOVE_EPSILON_RAD,
  PENDOLO_GEAR_TRAVEL_RATIO,
  pendoloGearDrive,
} from './PendoloTheme';

/**
 * 第十五轮第 7 条（时计：歌词转动时小齿轮才转动）的驱动纯函数。
 * `moving` 这个字段就是直接写进 DOM 的 `data-gears="moving" | "idle"`，所以它必须严格可判定。
 */
describe('pendoloGearDrive', () => {
  it('歌词环没动 ⇒ 行程不变、标记 idle（转时转、停时停）', () => {
    expect(pendoloGearDrive(3.5, 0)).toEqual({ travelRad: 3.5, moving: false });
  });

  it('歌词环动了 ⇒ 行程按 |Δ| 累积、标记 moving', () => {
    expect(pendoloGearDrive(0, 0.22)).toEqual({ travelRad: 0.22, moving: true });
    const back = pendoloGearDrive(1, -0.22);
    expect(back.travelRad).toBeCloseTo(1.22, 12);
    expect(back.moving).toBe(true);
  });

  it('只朝一个方向推进：回摆不会把行程减回去（当曲柄用）', () => {
    let travel = 0;
    for (const delta of [0.22, -0.22, 0.22, -0.22]) {
      travel = pendoloGearDrive(travel, delta).travelRad;
    }
    expect(travel).toBeCloseTo(0.88, 12);
  });

  it('阈值以内算停住（浮点噪声不会让齿轮一直抖）', () => {
    expect(pendoloGearDrive(0, PENDOLO_GEAR_MOVE_EPSILON_RAD).moving).toBe(false);
    expect(pendoloGearDrive(0, PENDOLO_GEAR_MOVE_EPSILON_RAD * 0.5).moving).toBe(false);
    expect(pendoloGearDrive(0, PENDOLO_GEAR_MOVE_EPSILON_RAD * 2).moving).toBe(true);
  });

  it('自定义阈值可用（默认值就是导出的那个常量）', () => {
    expect(pendoloGearDrive(0, 0.01, 0.1).moving).toBe(false);
    expect(pendoloGearDrive(0, 0.2, 0.1).moving).toBe(true);
  });

  it('行程倍率：换一句（约 0.22 rad）推进约 1.3 rad ≈ 75°', () => {
    expect(0.22 * PENDOLO_GEAR_TRAVEL_RATIO).toBeCloseTo(1.32, 6);
  });
});
