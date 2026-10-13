/**
 * 纹理档位吸附（`pixiTextureBudget.ts`）的自查。
 *
 * **判据直接来自上游 `tempera/README.md`「渲染分辨率与纹理池」那一节**，
 * 不是我们自己编的期望值 —— 这是"照抄数值"能不能算数的地方：
 * - 同一个 781×850 视口上它返回 **1.2047** 而不是 1.5；
 * - 2000×1200 在 1.5x 下若要降到 1.024 就是砍 32%（> 25% 上限）⇒ **保持原样**。
 *
 * 两条都能对上，才说明我对"取长边档位的一半"这个算法的重建是**对的**，
 * 而不是"看起来合理"。
 */

import { describe, expect, it } from 'vitest';
import {
  TEXTURE_POOL_MAX_RESOLUTION_DROP,
  nextPowerOfTwo,
  snapResolutionToTexturePool,
} from './pixiTextureBudget';

/** Pixi 内部那条：逐轴向上取整到 2 的幂（用来核对吸附后落在哪一档）。 */
function tierOf(viewport: number, resolution: number): number {
  return nextPowerOfTwo(Math.ceil(viewport * resolution - 1e-6));
}

describe('纹理档位吸附', () => {
  it('nextPowerOfTwo 就是"向上取到 2 的幂"', () => {
    expect(nextPowerOfTwo(1)).toBe(1);
    expect(nextPowerOfTwo(2)).toBe(2);
    expect(nextPowerOfTwo(3)).toBe(4);
    expect(nextPowerOfTwo(1024)).toBe(1024);
    expect(nextPowerOfTwo(1025)).toBe(2048);
    expect(nextPowerOfTwo(0)).toBe(1);
    expect(nextPowerOfTwo(-5)).toBe(1);
  });

  it('上游例子①：781×850 @1.5 吸附到 1.2047（= 1024 / 850）', () => {
    const snapped = snapResolutionToTexturePool({ width: 781, height: 850, resolution: 1.5 });
    // 1.2047… 是"长边正好铺满 1024 档"的那个值。
    expect(snapped).toBeCloseTo(1024 / 850, 10);
    expect(snapped).toBeCloseTo(1.2047, 4);
    // 两轴都从 2048 档落到 1024 档 —— 这正是省显存的那一步。
    expect(tierOf(850, snapped)).toBe(1024);
    expect(tierOf(781, snapped)).toBe(1024);
    // 而原值下两轴都在 2048 档。
    expect(tierOf(850, 1.5)).toBe(2048);
    expect(tierOf(781, 1.5)).toBe(2048);
  });

  it('上游例子①的"填充率"结论：每字节换到的清晰度是升的', () => {
    const fill = (viewportW: number, viewportH: number, resolution: number): number => {
      const w = Math.ceil(viewportW * resolution - 1e-6);
      const h = Math.ceil(viewportH * resolution - 1e-6);
      const tier = tierOf(Math.max(viewportW, viewportH), resolution);
      return (w * h) / (tier * tier);
    };
    const before = fill(781, 850, 1.5);
    const after = fill(781, 850, 1024 / 850);
    // 上游给的量级是"29% → 92%"；这里只守住**方向与量级**（92% 可由算式直接得到）。
    expect(before).toBeLessThan(0.4);
    expect(after).toBeGreaterThan(0.9);
    expect(after).toBeGreaterThan(before);
  });

  it('上游例子②：2000×1200 @1.5 降幅 32% 超过 25% ⇒ 保持 1.5 不动', () => {
    // 长边 2000 在 1.5x 下是 3000 → 4096 档；降一档得 2048 ⇒ 候选分辨率 = 2048 / 2000 = 1.024。
    const candidate = 2048 / 2000;
    expect(candidate).toBeCloseTo(1.024, 10);
    expect((1.5 - candidate) / 1.5).toBeGreaterThan(TEXTURE_POOL_MAX_RESOLUTION_DROP);
    expect(snapResolutionToTexturePool({ width: 2000, height: 1200, resolution: 1.5 })).toBe(1.5);
  });

  it('吸附是幂等的：再吸附一次不会继续掉档', () => {
    const once = snapResolutionToTexturePool({ width: 781, height: 850, resolution: 1.5 });
    const twice = snapResolutionToTexturePool({ width: 781, height: 850, resolution: once });
    expect(twice).toBeCloseTo(once, 10);
  });

  it('降档只降一档：吸附后长边恰好落在"原来的下一档"', () => {
    const width = 900;
    const height = 700;
    const original = 1.5;
    const snapped = snapResolutionToTexturePool({ width, height, resolution: original });
    const before = tierOf(Math.max(width, height), original);
    const afterTier = tierOf(Math.max(width, height), snapped);
    expect(afterTier).toBe(before / 2);
  });

  it('视口太小或参数非法时原样返回（不抛、不产生 0 或负数）', () => {
    expect(snapResolutionToTexturePool({ width: 0, height: 0, resolution: 1.5 })).toBe(1.5);
    expect(snapResolutionToTexturePool({ width: -10, height: 20, resolution: 1.5 })).toBe(1.5);
    expect(snapResolutionToTexturePool({ width: 100, height: 100, resolution: 0 })).toBe(0);
    expect(snapResolutionToTexturePool({ width: Number.NaN, height: 100, resolution: 1.5 })).toBe(1.5);
    // 极小视口：下一档 < 1 ⇒ 不动。
    expect(snapResolutionToTexturePool({ width: 1, height: 1, resolution: 1 })).toBe(1);
  });

  it('上限常量照抄上游：25%', () => {
    expect(TEXTURE_POOL_MAX_RESOLUTION_DROP).toBe(0.25);
  });
});
