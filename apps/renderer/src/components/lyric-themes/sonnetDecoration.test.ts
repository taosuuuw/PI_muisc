/**
 * 商籁（sonnet）**装饰语汇**的自查：固定几何 8 档 + 每族背景。
 *
 * 数值全部来自 folia（`sonnetFixedGeoVariants.ts` / `sonnetShotMg.ts` 的 bg 层），这里钉的是
 * "照抄下来的数"：档位个数、三件套的比例、斜线网被裁进矩形、社论栏的网格条数与透明度、
 * 兜底族的五个小方块个数与尺寸公式。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_FIXED_GEO_VARIANT_COUNT,
  SONNET_FIXED_GEO_VARIANTS,
  buildHatchShapes,
  buildSonnetBackgroundShapes,
  buildSonnetFixedGeoShapes,
  clipSegmentToRect,
  resolveSonnetFixedGeoVariant,
} from './sonnetDecoration';

const VIEWPORT = { width: 1180, height: 760 };

describe('商籁 装饰语汇（照抄 folia 的数值）', () => {
  it('固定几何的档位表：8 档且名字与原版一致', () => {
    expect(SONNET_FIXED_GEO_VARIANT_COUNT).toBe(8);
    expect(SONNET_FIXED_GEO_VARIANTS).toHaveLength(8);
    expect(SONNET_FIXED_GEO_VARIANTS[0]).toBe('classic-blocks');
    expect(SONNET_FIXED_GEO_VARIANTS[7]).toBe('cross-ring');
  });

  it('取档是确定的、落在 0~7，而且换种子会换档', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 200; seed += 1) {
      const variant = resolveSonnetFixedGeoVariant(seed);
      expect(variant).toBe(resolveSonnetFixedGeoVariant(seed));
      expect(variant).toBeGreaterThanOrEqual(0);
      expect(variant).toBeLessThan(SONNET_FIXED_GEO_VARIANT_COUNT);
      seen.add(variant);
    }
    expect(seen.size).toBe(SONNET_FIXED_GEO_VARIANT_COUNT);
  });

  it('八档都画得出东西，且都在"半径的 0.75 倍"圈内（照抄公式里最远的一件到 0.72r）', () => {
    const r = Math.min(VIEWPORT.width, VIEWPORT.height);
    for (let variant = 0; variant < SONNET_FIXED_GEO_VARIANT_COUNT; variant += 1) {
      const shapes = buildSonnetFixedGeoShapes(VIEWPORT, variant, 7);
      expect(shapes.length, `第 ${variant} 档的形状数`).toBeGreaterThanOrEqual(2);
      for (const item of shapes) {
        for (let index = 0; index < item.polygon.length; index += 2) {
          const dx = Math.abs((item.polygon[index] ?? 0) - VIEWPORT.width / 2);
          const dy = Math.abs((item.polygon[index + 1] ?? 0) - VIEWPORT.height / 2);
          // 第 4 档的横条：`-0.36r × direction - 0.2r` 起、宽 0.56r ⇒ 方向翻过来时右端到 0.72r。
          expect(Math.max(dx, dy), `第 ${variant} 档的 ${item.id} 超出范围`).toBeLessThanOrEqual(r * 0.75);
        }
      }
    }
  });

  it('第 0 档是"三件套"：一个实心块 + 一个空心框 + 一组斜线网（网线 0.15 透明度）', () => {
    const shapes = buildSonnetFixedGeoShapes(VIEWPORT, 0, 6);
    const filled = shapes.filter((item) => item.fillTone >= 0 && item.fillAlpha > 0);
    const hollow = shapes.filter((item) => item.fillTone < 0 && item.strokeWidth >= 2);
    const hatch = shapes.filter((item) => item.strokeAlpha === 0.15);
    expect(filled).toHaveLength(1);
    expect(hollow).toHaveLength(1);
    expect(hatch.length).toBeGreaterThan(4);
    // 偶数种子才用强调档（原版：`seed % 2 === 0 ? secondary : primary`）。
    expect(filled[0]?.fillTone).toBe(1);
    expect(buildSonnetFixedGeoShapes(VIEWPORT, 1, 6).some((item) => item.fillTone === 2)).toBe(true);
  });

  it('斜线网被裁进矩形：每条线段的两个端点都在矩形里', () => {
    const shapes = buildHatchShapes('h', 100, 200, 300, 150, 6);
    expect(shapes.length).toBeGreaterThan(10);
    for (const item of shapes) {
      for (let index = 0; index < item.polygon.length; index += 2) {
        const x = item.polygon[index] ?? 0;
        const y = item.polygon[index + 1] ?? 0;
        expect(x).toBeGreaterThanOrEqual(100 - 0.001);
        expect(x).toBeLessThanOrEqual(400 + 0.001);
        expect(y).toBeGreaterThanOrEqual(200 - 0.001);
        expect(y).toBeLessThanOrEqual(350 + 0.001);
      }
    }
  });

  it('线段裁剪：完全在外的返回 null，穿过矩形的被截到边界上', () => {
    expect(clipSegmentToRect(-10, -10, -5, -5, 0, 0, 100, 100)).toBeNull();
    const clipped = clipSegmentToRect(50, -50, 50, 150, 0, 0, 100, 100);
    expect(clipped?.y1).toBeCloseTo(0, 6);
    expect(clipped?.y2).toBeCloseTo(100, 6);
  });

  it('每族背景：社论栏是 6 竖 + 4 横 + 一个大方框，兜底族是 5 个小方块', () => {
    const editorial = buildSonnetBackgroundShapes(VIEWPORT, 'editorial-column', 11);
    expect(editorial).toHaveLength(11);
    expect(editorial.filter((item) => item.strokeWidth === 1 && item.strokeAlpha === 0.15)).toHaveLength(10);
    const frame = editorial[10];
    expect(frame?.strokeWidth).toBe(4);
    expect(frame?.strokeAlpha).toBe(0.5);

    for (const kind of ['mask-reveal', 'quiet-tableau', 'tracking-ribbon', 'poster-blocks']) {
      const shapes = buildSonnetBackgroundShapes(VIEWPORT, kind, 11);
      expect(shapes, `${kind} 的背景块数`).toHaveLength(5);
      for (const item of shapes) {
        expect(item.fillAlpha).toBe(0.4);
        // 尺寸公式照抄：`10 + (seed % (i + 1)) * 5`。
        const width = (item.polygon[2] ?? 0) - (item.polygon[0] ?? 0);
        expect([10, 15, 20, 25, 30]).toContain(width);
      }
    }
    // 重镜头这一族的大图形在别处（几何层），背景层空着。
    expect(buildSonnetBackgroundShapes(VIEWPORT, 'type-impact', 11)).toHaveLength(0);
    expect(buildSonnetBackgroundShapes(VIEWPORT, 'fragment-collage', 11)).toHaveLength(0);
  });
});
