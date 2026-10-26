import { describe, expect, it } from 'vitest';
import {
  buildLensDisplacementPixels,
  dynamicLensBucketForSize,
  DYNAMIC_LENS_BUCKETS,
  lensOptionsForOffset,
  LENS_FILTER_SCALE,
  LENS_MAP_SIZE,
} from './rain-lens-map';

/**
 * 水珠位移贴图的单测。
 *
 * 这张图决定「折射往哪偏」，所以锁住五件事：
 *   ① 中心不偏、水珠外透明（透明边才能把多颗透镜叠进同一个滤镜）；
 *   ② 越靠边偏得越多（球面透镜的核心）；
 *   ③ 最外圈回落到中性（否则会采样出水珠框，边缘出现生硬切口）；
 *   ④ 纵向比横向略胖（泪滴形），以及确定性；
 *   ⑤ 目标像素位移/尺寸分档换算正确。
 */
describe('rain-lens-map 位移贴图', () => {
  const size = 64;
  const pixels = buildLensDisplacementPixels(size);
  const at = (x: number, y: number): { r: number; g: number; b: number; a: number } => {
    const index = (Math.round(y) * size + Math.round(x)) * 4;
    return {
      r: pixels[index] ?? 0,
      g: pixels[index + 1] ?? 0,
      b: pixels[index + 2] ?? 0,
      a: pixels[index + 3] ?? 0,
    };
  };

  it('中心是中性值（不位移）', () => {
    const center = at(size / 2, size / 2);
    expect(Math.abs(center.r - 128)).toBeLessThanOrEqual(3);
    expect(Math.abs(center.g - 128)).toBeLessThanOrEqual(3);
  });

  it('水珠之外是中性值且完全透明（可安全叠图）', () => {
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ] as const) {
      const point = at(x, y);
      expect(point.r).toBe(128);
      expect(point.g).toBe(128);
      expect(point.a).toBe(0);
    }
  });

  it('越靠边偏移越大（球面透镜）', () => {
    const mid = at(size / 2 + size * 0.3, size / 2);
    const outer = at(size / 2 + size * 0.42, size / 2);
    expect(Math.abs(mid.r - 128)).toBeGreaterThan(4);
    expect(Math.abs(outer.r - 128)).toBeGreaterThan(Math.abs(mid.r - 128));
  });

  it('最外圈回落到中性（避免采样出水珠框）', () => {
    const last = at(size - 1, size / 2);
    expect(Math.abs(last.r - 128)).toBeLessThan(10);
  });

  it('纵向比横向略胖（泪滴形）', () => {
    const horizontal = at(size / 2 + Math.round(size * 0.33), size / 2);
    const vertical = at(size / 2, size / 2 + Math.round(size * 0.33));
    expect(Math.abs(vertical.g - 128)).toBeGreaterThan(Math.abs(horizontal.r - 128));
  });

  it('B 通道是常量，alpha 从中心到边缘降到 0', () => {
    const center = at(size / 2, size / 2);
    expect(center.a).toBe(255);
    expect(center.b).toBe(128);
    const edge = at(size - 1, 0);
    expect(edge.a).toBe(0);
  });

  it('options 可以缩小偏移、改变纵向拉长', () => {
    const soft = buildLensDisplacementPixels(size, { maxOffset: 20, aspectY: 1 });
    const atSoft = (x: number, y: number): number =>
      soft[(Math.round(y) * size + Math.round(x)) * 4] ?? 128;
    const hard = atSoft(size / 2 + size * 0.4, size / 2);
    const original = at(size / 2 + Math.round(size * 0.4), size / 2).r;
    expect(Math.abs(hard - 128)).toBeLessThan(Math.abs(original - 128));
  });

  it('尺寸不合法时直接报错，免得烤出一张坏图', () => {
    expect(() => buildLensDisplacementPixels(4)).toThrow(/位移贴图尺寸/);
    expect(() => buildLensDisplacementPixels(12.5)).toThrow(/位移贴图尺寸/);
  });

  it('同一尺寸永远得到同一张图', () => {
    expect(buildLensDisplacementPixels(size)).toEqual(pixels);
  });

  it('实际尺寸是 256，且滤镜 scale 与测试口径一致', () => {
    expect(LENS_MAP_SIZE).toBe(256);
    expect(LENS_FILTER_SCALE).toBeGreaterThan(0);
    expect(buildLensDisplacementPixels(LENS_MAP_SIZE)).toHaveLength(
      LENS_MAP_SIZE * LENS_MAP_SIZE * 4,
    );
  });

  it('动态透镜按尺寸落到四档之一', () => {
    expect(DYNAMIC_LENS_BUCKETS).toHaveLength(4);
    expect(dynamicLensBucketForSize(8).offsetPx).toBe(DYNAMIC_LENS_BUCKETS[0]?.offsetPx);
    expect(dynamicLensBucketForSize(40).offsetPx).toBe(DYNAMIC_LENS_BUCKETS[3]?.offsetPx);
    expect(dynamicLensBucketForSize(999).offsetPx).toBe(DYNAMIC_LENS_BUCKETS[3]?.offsetPx);
  });

  it('目标像素位移换算成 scale 下的归一化值', () => {
    const options = lensOptionsForOffset(6, 1.06);
    expect(options.maxOffset).toBeGreaterThan(0);
    expect(options.maxOffset).toBeLessThanOrEqual(127);
    expect(options.aspectY).toBe(1.06);
  });
});
