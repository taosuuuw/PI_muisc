/**
 * 背景装饰层（`sonnetBackgroundDecor.ts`）的用例（第 385 轮补）。
 *
 * 期望值分两类：**能手算的直接钉**（粒子数、尺寸/配色/透明度规则）；
 * **含种子哈希的只钉不变量**（散点落在画布内、轨道点落在椭圆上、边带的横向偏移不超过抖动幅度）
 * —— 后者钉死具体数值会在换种子/换盐时假红，那种红没有信息量 ✓。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_BACKGROUND_DECOR_VARIANT_COUNT,
  SONNET_BACKGROUND_DECOR_VARIANTS,
  SONNET_DECOR_SHAPE_PALETTES,
  resolveSonnetBackgroundDecorVariant,
  resolveSonnetDecorParticleCount,
  resolveSonnetDecorParticles,
  resolveSonnetDecorPlacement,
} from './sonnetBackgroundDecor';

const WIDTH = 1600;
const HEIGHT = 900;

describe('背景装饰：档位与数量', () => {
  it('六个档位名固定（与上游一字不差）', () => {
    expect([...SONNET_BACKGROUND_DECOR_VARIANTS]).toEqual([
      'scatter',
      'orbit',
      'edge-band',
      'corner-clusters',
      'constellation',
      'twin-columns',
    ]);
    expect(SONNET_DECOR_SHAPE_PALETTES).toHaveLength(SONNET_BACKGROUND_DECOR_VARIANT_COUNT);
    for (const palette of SONNET_DECOR_SHAPE_PALETTES) expect(palette).toHaveLength(3);
  });

  it('档位落在 0..5，且换种子真的会换档（不是常数）', () => {
    const variants = new Set<number>();
    for (let seed = 0; seed < 12; seed += 1) {
      const variant = resolveSonnetBackgroundDecorVariant(seed);
      expect(variant).toBeGreaterThanOrEqual(0);
      expect(variant).toBeLessThan(SONNET_BACKGROUND_DECOR_VARIANT_COUNT);
      variants.add(variant);
    }
    // 12 个种子分成 6 档 ⇒ 至少出现 2 档（否则哈希坏了）。
    expect(variants.size).toBeGreaterThanOrEqual(2);
    // 同种子必然同档。
    expect(resolveSonnetBackgroundDecorVariant(7)).toBe(resolveSonnetBackgroundDecorVariant(7));
  });

  it('粒子数：重字镜 24、其余 12（照抄上游）', () => {
    expect(resolveSonnetDecorParticleCount('type-impact')).toBe(24);
    expect(resolveSonnetDecorParticleCount('poster-blocks')).toBe(12);
    expect(resolveSonnetDecorParticles(3, 'type-impact', WIDTH, HEIGHT)).toHaveLength(24);
    expect(resolveSonnetDecorParticles(3, 'quiet-tableau', WIDTH, HEIGHT)).toHaveLength(12);
  });
});

describe('背景装饰：每条粒子的规则', () => {
  it('尺寸 4~15、颜色按 i%2 交替、透明度 0.55~0.85、形状取自本档调色板', () => {
    const seed = 21;
    const variant = resolveSonnetBackgroundDecorVariant(seed);
    const palette = SONNET_DECOR_SHAPE_PALETTES[variant]!;
    for (const particle of resolveSonnetDecorParticles(seed, 'quiet-tableau', WIDTH, HEIGHT)) {
      expect(particle.size).toBeGreaterThanOrEqual(4);
      expect(particle.size).toBeLessThanOrEqual(15);
      expect(particle.primary).toBe(particle.index % 2 === 0);
      expect(particle.alpha).toBeGreaterThanOrEqual(0.55);
      expect(particle.alpha).toBeLessThanOrEqual(0.85);
      expect(palette).toContain(particle.shape);
    }
  });

  it('确定性：同输入两次结果逐字相同', () => {
    const first = resolveSonnetDecorParticles(99, 'type-impact', WIDTH, HEIGHT);
    const second = resolveSonnetDecorParticles(99, 'type-impact', WIDTH, HEIGHT);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('背景装饰：六种摆法的几何不变量', () => {
  it('scatter：粒子落在画布内', () => {
    for (let index = 0; index < 12; index += 1) {
      const spot = resolveSonnetDecorPlacement(0, index, 12, 5, WIDTH, HEIGHT);
      expect(spot.x).toBeGreaterThanOrEqual(-WIDTH / 2);
      expect(spot.x).toBeLessThanOrEqual(WIDTH / 2);
      expect(spot.y).toBeGreaterThanOrEqual(-HEIGHT / 2);
      expect(spot.y).toBeLessThanOrEqual(HEIGHT / 2);
    }
  });

  it('orbit：两种半径（0.36 / 0.62 × min(w,h)），纵向压 0.86 ⇒ 落在对应椭圆上', () => {
    const radius = Math.min(WIDTH, HEIGHT);
    for (let index = 0; index < 12; index += 1) {
      const ring = index % 2;
      const expected = radius * (0.36 + ring * 0.26);
      const spot = resolveSonnetDecorPlacement(1, index, 12, 8, WIDTH, HEIGHT);
      // 椭圆判定：x²/R² + y²/(0.86R)² = 1（抖动只动角度，不动半径）✓
      const value = (spot.x / expected) ** 2 + (spot.y / (expected * 0.86)) ** 2;
      expect(value).toBeCloseTo(1, 6);
    }
  });

  it('edge-band / twin-columns：横向偏移不超过抖动幅度（0.03w / 0.04w）', () => {
    const halfHeight = HEIGHT / 2;
    for (let index = 0; index < 12; index += 1) {
      const edge = resolveSonnetDecorPlacement(2, index, 12, 11, WIDTH, HEIGHT);
      const side = index % 2 === 0 ? -1 : 1;
      expect(Math.abs(edge.y - side * halfHeight * 0.78)).toBeLessThanOrEqual(HEIGHT * 0.025 + 1e-9);
      expect(edge.rotation).toBe(side < 0 ? 0 : Math.PI);

      const twin = resolveSonnetDecorPlacement(5, index, 12, 11, WIDTH, HEIGHT);
      expect(Math.abs(twin.x - side * (WIDTH / 2) * 0.74)).toBeLessThanOrEqual(WIDTH * 0.02 + 1e-9);
      expect(twin.rotation).toBe(side < 0 ? Math.PI : 0);
    }
  });

  it('constellation：落在 6 列 × 4 行的网格包围盒内（含 ±0.06 抖动）', () => {
    for (let index = 0; index < 24; index += 1) {
      const spot = resolveSonnetDecorPlacement(4, index, 24, 13, WIDTH, HEIGHT);
      expect(spot.x).toBeGreaterThanOrEqual(-WIDTH / 2 * 0.8 - WIDTH * 0.03 - 1e-9);
      expect(spot.x).toBeLessThanOrEqual(WIDTH / 2 * 0.8 + WIDTH * 0.03 + 1e-9);
      expect(spot.y).toBeGreaterThanOrEqual(-HEIGHT / 2 * 0.72 - HEIGHT * 0.03 - 1e-9);
      expect(spot.y).toBeLessThanOrEqual(HEIGHT / 2 * 0.72 + HEIGHT * 0.03 + 1e-9);
    }
  });
});
