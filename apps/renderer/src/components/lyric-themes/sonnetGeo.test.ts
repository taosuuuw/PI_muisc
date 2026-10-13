/**
 * 商籁重镜头**几何语汇**的自查：档位解析、整体旋转规则，以及已搬的 0~3 档画法。
 *
 * 数值来自 folia 的 `sonnetShotMg.ts`；这里钉的是"照抄下来的数"：圆框与射线的条数、
 * 嵌套菱形的层数、六边形的闭合与辐条方向、苯环簇的环数与位移、以及未搬档位**必须返回 null**
 * （这样它就会退回自拟图形，而不是悄悄给一个假的原版图形）。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_CELESTIAL_GEO_VARIANT_COUNT,
  SONNET_CELESTIAL_GEO_VARIANTS,
  SONNET_CRAFT_GEO_VARIANT_COUNT,
  SONNET_CRAFT_GEO_VARIANTS,
  SONNET_GEO_RANGES,
  SONNET_KINETIC_GEO_VARIANT_COUNT,
  SONNET_KINETIC_GEO_VARIANTS,
  SONNET_MARINE_GEO_VARIANT_COUNT,
  SONNET_MARINE_GEO_VARIANTS,
  SONNET_MUSIC_GEO_VARIANT_COUNT,
  SONNET_MUSIC_GEO_VARIANTS,
  SONNET_THEMED_GEO_VARIANT_COUNT,
  SONNET_THEMED_GEO_VARIANTS,
  SONNET_GEO_UPRIGHT_VARIANTS,
  SONNET_THEMED_GEO_VARIANT_START,
  buildSonnetGeoShapes,
  describeSonnetGeoCoverage,
  resolveSonnetGeoBleed,
  resolveSonnetGeoRotation,
  resolveSonnetGeoVariant,
  resolveSonnetHudRotationQuarterTurns,
  resolveSonnetMoleculeVariant,
} from './sonnetGeo';

const VIEWPORT = { width: 1180, height: 760 };

describe('商籁 重镜头几何语汇（照抄 folia 的数值）', () => {
  it('档位解析：落在 0~99，负数也回绕，且确定', () => {
    expect(resolveSonnetGeoVariant(0)).toBe(0);
    expect(resolveSonnetGeoVariant(99)).toBe(99);
    expect(resolveSonnetGeoVariant(100)).toBe(0);
    expect(resolveSonnetGeoVariant(-1)).toBe(99);
    expect(resolveSonnetGeoVariant(12345)).toBe(12345 % 100);
  });

  it('子档位：`floor(seed / 100) % 3` 与 `% 4`（与主档位互不干扰）', () => {
    expect(resolveSonnetMoleculeVariant(5)).toBe(0);
    expect(resolveSonnetMoleculeVariant(105)).toBe(1);
    expect(resolveSonnetMoleculeVariant(205)).toBe(2);
    expect(resolveSonnetMoleculeVariant(305)).toBe(0);
    expect(resolveSonnetHudRotationQuarterTurns(0)).toBe(0);
    expect(resolveSonnetHudRotationQuarterTurns(100)).toBe(1);
    expect(resolveSonnetHudRotationQuarterTurns(300)).toBe(3);
  });

  it('整体旋转：白名单与主题档正立，第 8 档按 90° 整数倍，其余按 (seed × 13) % 360', () => {
    for (const variant of SONNET_GEO_UPRIGHT_VARIANTS) {
      if (variant === 8) continue;
      expect(resolveSonnetGeoRotation(variant, 37), `第 ${variant} 档应正立`).toBe(0);
    }
    expect(resolveSonnetGeoRotation(8, 100)).toBeCloseTo(Math.PI / 2, 9);
    expect(resolveSonnetGeoRotation(8, 300)).toBeCloseTo((3 * Math.PI) / 2, 9);
    expect(resolveSonnetGeoRotation(SONNET_THEMED_GEO_VARIANT_START, 37)).toBe(0);
    expect(resolveSonnetGeoRotation(SONNET_THEMED_GEO_VARIANT_START + 5, 37)).toBe(0);
    expect(resolveSonnetGeoRotation(0, 10)).toBeCloseTo(((10 * 13) % 360) * (Math.PI / 180), 9);
  });

  it('第 0 档：两圈同心圆 + 32 根射线，射线隔一根亮一档', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 0, 5);
    expect(shapes).not.toBeNull();
    const rings = (shapes ?? []).filter((item) => item.id.startsWith('geo-ring'));
    const rays = (shapes ?? []).filter((item) => item.id.startsWith('geo-ray'));
    expect(rings).toHaveLength(2);
    expect(rings[0]?.strokeWidth).toBe(6);
    expect(rings[0]?.strokeAlpha).toBe(0.8);
    expect(rays).toHaveLength(32);
    expect(rays[0]?.strokeAlpha).toBeCloseTo(0.2, 9);
    expect(rays[1]?.strokeAlpha).toBeCloseTo(0.3, 9);
    // 闭合：圆的第一个点与最后一个点重合（不闭合描边会留豁口）。
    const ring = rings[0]?.polygon ?? [];
    expect(ring[ring.length - 2]).toBeCloseTo(ring[0] ?? 0, 6);
    expect(ring[ring.length - 1]).toBeCloseTo(ring[1] ?? 0, 6);
  });

  it('第 1 档：三层嵌套菱形 + 十字准线', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 1, 5) ?? [];
    expect(shapes.filter((item) => item.id.startsWith('geo-diamond'))).toHaveLength(3);
    expect(shapes.filter((item) => item.id.startsWith('geo-cross'))).toHaveLength(2);
    // 菱形是闭合的（五对点）。
    const diamond = shapes.find((item) => item.id === 'geo-diamond')?.polygon ?? [];
    expect(diamond).toHaveLength(10);
    expect(diamond[8]).toBeCloseTo(diamond[0] ?? 0, 6);
  });

  it('第 2 档：三层同心六边形 + 六根指向顶点的辐条，六边形首尾闭合', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 2, 5) ?? [];
    const hexes = shapes.filter((item) => item.id.startsWith('geo-hex') && !item.id.includes('spoke'));
    const spokes = shapes.filter((item) => item.id.startsWith('geo-spoke'));
    expect(hexes).toHaveLength(3);
    expect(spokes).toHaveLength(6);
    const hex = hexes[0]?.polygon ?? [];
    expect(hex).toHaveLength(14);
    expect(hex[12]).toBeCloseTo(hex[0] ?? 0, 6);
    expect(hex[13]).toBeCloseTo(hex[1] ?? 0, 6);
  });

  it('第 3 档子档 0：三个稠合苯环（每个一外圈 + 三条双键）加一条结构线', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 3, 5) ?? [];
    expect(shapes).toHaveLength(13);
    expect(shapes.filter((item) => /^geo-benzene-\d$/.test(item.id))).toHaveLength(3);
    expect(shapes.filter((item) => item.id.includes('-bond-'))).toHaveLength(9);
    expect(shapes.some((item) => item.id === 'geo-benzene-stem')).toBe(true);
  });

  /*
   * 下面三档都用 `seed = 360`：因为 `(360 × 13) % 360 === 0`，整体旋转正好为 0
   * （第 4/5/7 档不在"正立白名单"里，随便取种子的话整批图形会被转掉，量出来的长宽就没意义了）。
   */
  it('第 4 档：三条交叠电子轨道 + 一个核点', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 4, 360) ?? [];
    expect(shapes.filter((item) => item.id.startsWith('geo-orbital'))).toHaveLength(3);
    expect(shapes.filter((item) => item.id === 'geo-nucleus')).toHaveLength(1);
    // 轨道是压扁的椭圆（长轴 0.7r、短轴 0.126r），且闭合。
    const orbital = shapes[0]?.polygon ?? [];
    const xs = orbital.filter((_value, index) => index % 2 === 0);
    const ys = orbital.filter((_value, index) => index % 2 === 1);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    expect(spanX / spanY).toBeGreaterThan(4);
    expect(orbital[orbital.length - 2]).toBeCloseTo(orbital[0] ?? 0, 6);
  });

  it('第 5 档：星球 + 两道纹路 + 三个倾斜环 + 远处轨道与卫星', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 5, 360) ?? [];
    expect(shapes.filter((item) => item.id.startsWith('geo-ring-'))).toHaveLength(3);
    expect(shapes.some((item) => item.id === 'geo-planet')).toBe(true);
    expect(shapes.some((item) => item.id === 'geo-orbit')).toBe(true);
    expect(shapes.some((item) => item.id === 'geo-moon')).toBe(true);
    expect(shapes.filter((item) => item.id.startsWith('geo-planet-band'))).toHaveLength(2);
    // 环是**倾斜 30°** 的椭圆：最外那圈的长轴比短轴长得多。
    const ring = shapes.find((item) => item.id === 'geo-ring-2')?.polygon ?? [];
    const xs = ring.filter((_value, index) => index % 2 === 0);
    const ys = ring.filter((_value, index) => index % 2 === 1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(Math.max(...ys) - Math.min(...ys));
  });

  it('第 7 档：六圈靶环 + 十字准线 + 扫掠扇 + 72 根刻度 + 锁定框', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 7, 360) ?? [];
    expect(shapes.filter((item) => item.id.startsWith('geo-radar-ring-'))).toHaveLength(6);
    expect(shapes.filter((item) => item.id.startsWith('geo-radar-tick-'))).toHaveLength(72);
    expect(shapes.some((item) => item.id === 'geo-radar-sweep')).toBe(true);
    expect(shapes.some((item) => item.id === 'geo-radar-lock')).toBe(true);
    // 刻度长度照抄写死的 20 / 10 / 5 像素。
    const tick = (id: string): readonly number[] => shapes.find((item) => item.id === id)?.polygon ?? [];
    const length = (id: string): number => {
      const polygon = tick(id);
      return Math.hypot((polygon[2] ?? 0) - (polygon[0] ?? 0), (polygon[3] ?? 0) - (polygon[1] ?? 0));
    };
    expect(length('geo-radar-tick-0')).toBeCloseTo(20, 6);
    expect(length('geo-radar-tick-6')).toBeCloseTo(10, 6);
    expect(length('geo-radar-tick-1')).toBeCloseTo(5, 6);
    // 锁定框跟着种子转：`(seed % 360)` 度（seed = 360 ⇒ 0 度）、半径 0.45r。
    const lock = shapes.find((item) => item.id === 'geo-radar-lock')?.polygon ?? [];
    const expectedX = VIEWPORT.width / 2 + Math.min(VIEWPORT.width, VIEWPORT.height) * 0.45;
    expect((lock[0] ?? 0) + 15).toBeCloseTo(expectedX, 3);
  });

  it('第 6 档：线框山脉（三层山脊 + 基线 + 地面网格 + 透视汇聚线，且画到画布之外）', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 6, 360) ?? [];
    expect(shapes.filter((item) => item.id.startsWith('geo-mountain-ridge-'))).toHaveLength(3);
    expect(shapes.filter((item) => item.id.startsWith('geo-mountain-floor-'))).toHaveLength(5);
    expect(shapes.filter((item) => item.id.startsWith('geo-mountain-perspective-'))).toHaveLength(9);
    expect(shapes.some((item) => item.id === 'geo-mountain-base')).toBe(true);
    // 山脊线宽 3/2/1、透明度 0.6/0.45/0.3（照抄 `3 - layer` 与 `0.6 - layer × 0.15`）。
    const ridge = (layer: number): (typeof shapes)[number] | undefined =>
      shapes.find((item) => item.id === `geo-mountain-ridge-${layer}`);
    expect(ridge(0)?.strokeWidth).toBe(3);
    expect(ridge(1)?.strokeWidth).toBe(2);
    expect(ridge(2)?.strokeWidth).toBe(1);
    expect(ridge(0)?.strokeAlpha).toBeCloseTo(0.6, 9);
    expect(ridge(2)?.strokeAlpha).toBeCloseTo(0.3, 9);
    // 出血范围：`max(r × 0.92, 宽 × 0.64)` —— 本视口下 r=760 ⇒ 699.2；基线要伸出画布。
    expect(resolveSonnetGeoBleed(VIEWPORT.width, VIEWPORT.height, 760)).toEqual({
      x: Math.max(760 * 0.92, VIEWPORT.width * 0.64),
      y: Math.max(760 * 0.92, VIEWPORT.height * 0.64),
    });
    const base = shapes.find((item) => item.id === 'geo-mountain-base')?.polygon ?? [];
    expect(base[0] ?? 0).toBeLessThan(0);
    expect(base[2] ?? 0).toBeGreaterThan(VIEWPORT.width);
  });

  it('第 8 档：HUD 框（四角括线 ×2 层 + 上下刻度尺 + 中心准星 + 三块数据块）', () => {
    // 第 8 档在"正立白名单"里，随便取种子都不会被整体旋转。
    const shapes = buildSonnetGeoShapes(VIEWPORT, 8, 5) ?? [];
    expect(shapes.filter((item) => /^geo-hud-bracket-\d$/.test(item.id))).toHaveLength(4);
    expect(shapes.filter((item) => /^geo-hud-bracket-inner-\d$/.test(item.id))).toHaveLength(4);
    const ticks = shapes.filter((item) => item.id.startsWith('geo-hud-tick-'));
    expect(ticks.length).toBeGreaterThan(100);
    // 刻度尺每 20px 一根、上下各一份。
    expect(ticks.length % 2).toBe(0);
    /*
     * 长度照抄 `offset % 60 === 0 ? 12 : 6` —— 注意**这个视口下一根 12 都不会出现**：
     * `fw = 0.85 × 760 = 646`，刻度落在 `-626 + 20k` 上，永远不整除 60。所以这里逐根反推：
     * 从 x 还原出 offset，再核对它该是 6 还是 12。
     */
    const length = (item: (typeof ticks)[number]): number =>
      Math.abs((item.polygon[3] ?? 0) - (item.polygon[1] ?? 0));
    for (const item of ticks) {
      const offset = (item.polygon[0] ?? 0) - VIEWPORT.width / 2;
      const expected = (((offset % 60) + 60) % 60) === 0 ? 12 : 6;
      expect(length(item)).toBeCloseTo(expected, 9);
    }
    // 换一个 `fw ≡ 20 (mod 60)` 的视口（半径 800），长刻度就该出现了。
    const wide = buildSonnetGeoShapes({ width: 1200, height: 800 }, 8, 5) ?? [];
    const wideTicks = wide.filter((item) => item.id.startsWith('geo-hud-tick-'));
    expect(wideTicks.some((item) => Math.abs(length(item) - 12) < 1e-9)).toBe(true);
    expect(wideTicks.some((item) => Math.abs(length(item) - 6) < 1e-9)).toBe(true);
    expect(shapes.filter((item) => item.id.startsWith('geo-hud-block-'))).toHaveLength(3);
    expect(shapes.some((item) => item.id === 'geo-hud-reticle')).toBe(true);
  });

  it('第 9 档：四个等距立方体（各三面，填充深浅 0.15/0.3/0.05 倍）+ 两条连线', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 9, 5) ?? [];
    for (const cube of [0, 1, 2, 3]) {
      expect(shapes.filter((item) => item.id.startsWith(`geo-cube-${cube}-`)), `第 ${cube} 个立方体`).toHaveLength(3);
    }
    expect(shapes.filter((item) => item.id.startsWith('geo-cube-link'))).toHaveLength(2);
    // 最大的那个方块 alpha=0.8 ⇒ 顶面填充 0.12、右面 0.24、左面 0.04。
    const face = (name: string): number =>
      shapes.find((item) => item.id === name)?.fillAlpha ?? -1;
    expect(face('geo-cube-0-0')).toBeCloseTo(0.8 * 0.15, 6);
    expect(face('geo-cube-0-1')).toBeCloseTo(0.8 * 0.3, 6);
    expect(face('geo-cube-0-2')).toBeCloseTo(0.8 * 0.05, 6);
  });

  it('第 10 档：星座网络（18 个节点 + 近邻连线，越近越亮）', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 10, 360) ?? [];
    expect(shapes.filter((item) => /^geo-constellation-node-\d+$/.test(item.id))).toHaveLength(18);
    expect(shapes.filter((item) => item.id.startsWith('geo-constellation-halo-'))).toHaveLength(18);
    const links = shapes.filter((item) => item.id.startsWith('geo-constellation-link-'));
    expect(links.length).toBeGreaterThan(0);
    // 连线透明度落在 (0, 0.4]：`0.4 × (1 − 距离 / 0.45r)`。
    for (const link of links) {
      expect(link.strokeAlpha).toBeGreaterThan(0);
      expect(link.strokeAlpha).toBeLessThanOrEqual(0.4);
    }
    // 节点半径落在 0.1r~0.75r 之间（照抄 `0.1 + (…%65)/100`）。
    const r = Math.min(VIEWPORT.width, VIEWPORT.height);
    for (const node of shapes.filter((item) => /^geo-constellation-node-\d+$/.test(item.id))) {
      const distance = Math.hypot(
        (node.polygon[0] ?? 0) - VIEWPORT.width / 2,
        (node.polygon[1] ?? 0) - VIEWPORT.height / 2,
      );
      expect(distance).toBeGreaterThan(r * 0.05);
      expect(distance).toBeLessThan(r * 0.8);
    }
  });

  it('第 11 档：月牙 + 满月线框 + 月相轨道 + 八个月相 + 三颗几何星', () => {
    // 第 11 档不在"正立白名单"里，用 seed = 360 把整体旋转归零。
    const shapes = buildSonnetGeoShapes(VIEWPORT, 11, 360) ?? [];
    expect(shapes.some((item) => item.id === 'geo-moon-crescent')).toBe(true);
    expect(shapes.some((item) => item.id === 'geo-moon-full')).toBe(true);
    expect(shapes.some((item) => item.id === 'geo-moon-orbit')).toBe(true);
    // 八个月相：每个一圈，0 号（新月）只有圈、4 号（满月）多一个实心、其余多半个月牙。
    expect(shapes.filter((item) => /^geo-moon-phase-\d+-ring$/.test(item.id))).toHaveLength(8);
    expect(shapes.filter((item) => /^geo-moon-phase-\d+-full$/.test(item.id))).toHaveLength(1);
    expect(shapes.filter((item) => /^geo-moon-phase-\d+-half$/.test(item.id))).toHaveLength(6);
    expect(shapes.filter((item) => item.id.startsWith('geo-moon-star-'))).toHaveLength(3);
    // 月牙是**填入**的（原版 `.fill(alpha 0.8)`）。
    expect(shapes.find((item) => item.id === 'geo-moon-crescent')?.fillAlpha).toBeCloseTo(0.8, 9);
  });

  it('第 12 档：几何莲（四层 8/12/16/20 共 56 片花瓣 + 花心 + 三条藤蔓与叶点）', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 12, 360) ?? [];
    expect(shapes.filter((item) => /^geo-lotus-p0-\d+$/.test(item.id))).toHaveLength(8);
    expect(shapes.filter((item) => /^geo-lotus-p1-\d+$/.test(item.id))).toHaveLength(12);
    expect(shapes.filter((item) => /^geo-lotus-p2-\d+$/.test(item.id))).toHaveLength(16);
    expect(shapes.filter((item) => /^geo-lotus-p3-\d+$/.test(item.id))).toHaveLength(20);
    expect(shapes.some((item) => item.id === 'geo-lotus-stamen')).toBe(true);
    expect(shapes.some((item) => item.id === 'geo-lotus-core')).toBe(true);
    expect(shapes.filter((item) => item.id.startsWith('geo-lotus-vine-'))).toHaveLength(3);
    expect(shapes.filter((item) => item.id.startsWith('geo-lotus-leaf-'))).toHaveLength(3);
    // 只有前两层（alpha > 0.5）才填：0.8 与 0.65 ⇒ 第三层起只描边（照抄 `if (alpha > 0.5)`）。
    const petals = shapes.filter((item) => item.id.startsWith('geo-lotus-p'));
    expect(petals.filter((item) => item.fillAlpha > 0)).toHaveLength(20);
  });

  it('第 13 档：生命之种（中心 + 六环 + 十二外层用强调档 + 外框 + 极淡辐射线）', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 13, 360) ?? [];
    expect(shapes.filter((item) => item.id.startsWith('geo-seed-ring-'))).toHaveLength(6);
    expect(shapes.filter((item) => item.id.startsWith('geo-seed-outer-'))).toHaveLength(12);
    expect(shapes.filter((item) => item.id.startsWith('geo-seed-ray-'))).toHaveLength(12);
    expect(shapes.some((item) => item.id === 'geo-seed-bound')).toBe(true);
    // 外层与辐射线用的是**强调档**（原版写的是 `secondary`），其余用主色档。
    for (const item of shapes.filter((item) => item.id.startsWith('geo-seed-outer-') || item.id.startsWith('geo-seed-ray-'))) {
      expect(item.strokeTone).toBe(2);
    }
    expect(shapes.find((item) => item.id === 'geo-seed-center')?.strokeTone).toBe(1);
    // 辐射线是"几乎看不见"的 0.05。
    expect(shapes.find((item) => item.id === 'geo-seed-ray-0')?.strokeAlpha).toBeCloseTo(0.05, 9);
  });

  it('第 14 档：三块半透明碑体（顶面 0.42 / 侧面 0.68 / 前面 0.24 倍）', () => {
    // 第 14 档不在正立白名单里 ⇒ 用 seed = 360 归零整体旋转。
    const shapes = buildSonnetGeoShapes(VIEWPORT, 14, 360) ?? [];
    for (const index of [0, 1, 2]) {
      expect(shapes.filter((item) => item.id.startsWith(`geo-monolith-${index}-`))).toHaveLength(3);
    }
    // 尺寸最大的那块 alpha = 0.34 ⇒ 0.1428 / 0.2312 / 0.0816。
    const alphaOf = (id: string): number => shapes.find((item) => item.id === id)?.fillAlpha ?? -1;
    expect(alphaOf('geo-monolith-0-top')).toBeCloseTo(0.34 * 0.42, 6);
    expect(alphaOf('geo-monolith-0-side')).toBeCloseTo(0.34 * 0.68, 6);
    expect(alphaOf('geo-monolith-0-front')).toBeCloseTo(0.34 * 0.24, 6);
    // 三块都是**面**，没有描边（原版只 `fill`）。
    expect(shapes.every((item) => item.strokeTone === -1)).toBe(true);
  });

  it('第 15 档：三个漂浮三角柱（每块 3 个侧面 + 1 个前面，侧面深浅 0.34/0.46/0.58 倍）', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 15, 360) ?? [];
    expect(shapes.filter((item) => item.id.startsWith('geo-triangle-0-'))).toHaveLength(4);
    expect(shapes.filter((item) => item.id.startsWith('geo-triangle-1-'))).toHaveLength(4);
    expect(shapes.filter((item) => item.id.startsWith('geo-triangle-2-'))).toHaveLength(4);
    const alphaOf = (id: string): number => shapes.find((item) => item.id === id)?.fillAlpha ?? -1;
    expect(alphaOf('geo-triangle-0-side-0')).toBeCloseTo(0.34 * 0.34, 6);
    expect(alphaOf('geo-triangle-0-side-1')).toBeCloseTo(0.34 * 0.46, 6);
    expect(alphaOf('geo-triangle-0-side-2')).toBeCloseTo(0.34 * 0.58, 6);
    expect(alphaOf('geo-triangle-0-front')).toBeCloseTo(0.34 * 0.22, 6);
  });

  it('第 16 档：三个多面六棱柱（六边形前面 ⇒ 每块 6 个侧面 + 1 个前面）', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 16, 360) ?? [];
    expect(shapes.filter((item) => item.id.startsWith('geo-hexprism-0-'))).toHaveLength(7);
    expect(shapes.filter((item) => item.id.startsWith('geo-hexprism-1-'))).toHaveLength(7);
    expect(shapes.filter((item) => item.id.startsWith('geo-hexprism-2-'))).toHaveLength(7);
    // 前面的多边形是 6 个顶点（12 个数）。
    expect(shapes.find((item) => item.id === 'geo-hexprism-0-front')?.polygon).toHaveLength(12);
  });

  it('第 17 档：三个梯形棱柱（前面 4 个顶点 ⇒ 每块 4 个侧面 + 1 个前面，且上窄下宽）', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 17, 360) ?? [];
    expect(shapes.filter((item) => item.id.startsWith('geo-trapezoid-0-'))).toHaveLength(5);
    expect(shapes.filter((item) => item.id.startsWith('geo-trapezoid-1-'))).toHaveLength(5);
    expect(shapes.filter((item) => item.id.startsWith('geo-trapezoid-2-'))).toHaveLength(5);
    const front = shapes.find((item) => item.id === 'geo-trapezoid-0-front')?.polygon ?? [];
    expect(front).toHaveLength(8);
    // 上边（第 0~1 点）比下边（第 2~3 点）窄：照抄 `topWidth 0.3r` / `bottomWidth 0.68r`。
    const topWidth = Math.abs((front[2] ?? 0) - (front[0] ?? 0));
    const bottomWidth = Math.abs((front[4] ?? 0) - (front[6] ?? 0));
    expect(bottomWidth).toBeGreaterThan(topWidth);
    expect(bottomWidth / topWidth).toBeCloseTo(0.68 / 0.3, 6);
  });

  /*
   * 子档位由 `floor(seed / 100) % 3` 决定，而第 3 档**不在正立白名单**里、整体还会按
   * `(seed × 13) % 360` 转 —— 所以这里挑 `1080`（子档 1、旋转 0）与 `1440`（子档 2、旋转 0），
   * 量出来的坐标才是没被转过的那一份。
   */
  it('第 3 档子档 1：稠合分子（六元环 + 两条双键 + 稠合五元环 + 五条支链含三个节点）', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 3, 1080) ?? [];
    expect(shapes.some((item) => item.id === 'geo-fused-hex')).toBe(true);
    expect(shapes.filter((item) => item.id.startsWith('geo-fused-bond-'))).toHaveLength(2);
    expect(shapes.some((item) => item.id === 'geo-fused-pentagon')).toBe(true);
    expect(shapes.filter((item) => item.id.startsWith('geo-fused-branch-'))).toHaveLength(5);
    expect(shapes.filter((item) => item.id.startsWith('geo-fused-node-'))).toHaveLength(3);
    // 支链与环上的线宽：环 3、支链 2（照抄）。
    expect(shapes.find((item) => item.id === 'geo-fused-hex')?.strokeWidth).toBe(3);
    expect(shapes.find((item) => item.id === 'geo-fused-branch-0')?.strokeWidth).toBe(2);
  });

  it('第 3 档子档 2：线性聚合物链（锯齿主链 + 一条双键 + 六个官能团，奇偶不同）', () => {
    const shapes = buildSonnetGeoShapes(VIEWPORT, 3, 1440) ?? [];
    const backbone = shapes.find((item) => item.id === 'geo-polymer-backbone')?.polygon ?? [];
    // 主链 8 个点（起点 + 7 步），所以是 16 个数。
    expect(backbone).toHaveLength(16);
    /*
     * y 只有三条水平线：**起点在正中（y = 0）**，之后 7 个点只在上、下两档之间交替
     * （照抄里 y 是"每步赋值"而不是累加，所以不是真的锯齿起伏）。
     */
    const ys = backbone.filter((_value, index) => index % 2 === 1).map((value) => Math.round(value) - VIEWPORT.height / 2);
    expect(ys[0]).toBe(0);
    expect(new Set(ys.slice(1)).size).toBe(2);
    const levels = [...new Set(ys.slice(1))].sort((a, b) => a - b);
    expect(levels[1]).toBeCloseTo(-(levels[0] ?? 0), 6);
    expect(shapes.some((item) => item.id === 'geo-polymer-double-bond')).toBe(true);
    expect(shapes.filter((item) => item.id.startsWith('geo-polymer-group-'))).toHaveLength(6);
    // 奇数位是节点圈、偶数位是末端短键。
    expect(shapes.filter((item) => item.id.startsWith('geo-polymer-node-'))).toHaveLength(3);
    expect(shapes.filter((item) => item.id.startsWith('geo-polymer-tail-'))).toHaveLength(3);
  });

  it('附加档 18~23：六种海报图形各自的件数与关键数值（照抄 sonnetAdditionalShotMg）', () => {
    const r = Math.min(VIEWPORT.width, VIEWPORT.height);
    // 第 18 档 等高线图册：八圈 + 一段图例线；每三圈换强调色、透明度随圈数递增。
    const contour = buildSonnetGeoShapes(VIEWPORT, 18, 360) ?? [];
    expect(contour.filter((item) => item.id.startsWith('geo-contour-') && item.id !== 'geo-contour-legend')).toHaveLength(8);
    expect(contour.some((item) => item.id === 'geo-contour-legend')).toBe(true);
    expect(contour.find((item) => item.id === 'geo-contour-0')?.strokeTone).toBe(2);
    expect(contour.find((item) => item.id === 'geo-contour-0')?.strokeWidth).toBe(2);
    expect(contour.find((item) => item.id === 'geo-contour-1')?.strokeAlpha).toBeCloseTo(0.245, 6);

    // 第 19 档 放射波形：64 根 + 三圈；每八根一根强调粗条。
    const wave = buildSonnetGeoShapes(VIEWPORT, 19, 360) ?? [];
    const bars = wave.filter((item) => item.id.startsWith('geo-wave-bar-'));
    expect(bars).toHaveLength(64);
    expect(wave.filter((item) => item.id.startsWith('geo-wave-') && !item.id.startsWith('geo-wave-bar'))).toHaveLength(3);
    expect(bars[0]?.strokeTone).toBe(2);
    expect(bars[0]?.strokeWidth).toBe(3);
    expect(bars[1]?.strokeAlpha).toBeCloseTo(0.32, 6);

    // 第 20 档 交通蓝图：三条路线（端点伸出画面外）+ 每路线的节点圈（填充 + 外圈各一）。
    const transit = buildSonnetGeoShapes(VIEWPORT, 20, 360) ?? [];
    expect(transit.filter((item) => item.id.startsWith('geo-transit-route-'))).toHaveLength(3);
    // 路线 0 / 2 各 4 个节点、路线 1 有 5 个（"端点 + 隔一个"的规则照抄）。
    expect(transit.filter((item) => item.id.startsWith('geo-transit-node-0-'))).toHaveLength(4);
    expect(transit.filter((item) => item.id.startsWith('geo-transit-node-1-'))).toHaveLength(5);
    expect(transit.filter((item) => item.id.startsWith('geo-transit-node-2-'))).toHaveLength(4);
    expect(transit.filter((item) => item.id.startsWith('geo-transit-halo-'))).toHaveLength(13);
    // 路线两端确实伸到画布之外。
    const route = transit.find((item) => item.id === 'geo-transit-route-0')?.polygon ?? [];
    expect(route[0] ?? 0).toBeLessThan(0);
    expect(route[route.length - 2] ?? 0).toBeGreaterThan(VIEWPORT.width);

    // 第 21 档 计时码表：三圈 + 48 根刻度（每四根一根长的）+ 两根指针 + 轴心点。
    const chrono = buildSonnetGeoShapes(VIEWPORT, 21, 1234) ?? [];
    expect(chrono.filter((item) => item.id.startsWith('geo-chrono-ring-'))).toHaveLength(3);
    const ticks = chrono.filter((item) => item.id.startsWith('geo-chrono-tick-'));
    expect(ticks).toHaveLength(48);
    const tickLength = (item: (typeof ticks)[number]): number =>
      Math.hypot((item.polygon[2] ?? 0) - (item.polygon[0] ?? 0), (item.polygon[3] ?? 0) - (item.polygon[1] ?? 0));
    expect(tickLength(ticks[0]!)).toBeCloseTo(r * 0.11, 4);
    expect(tickLength(ticks[1]!)).toBeCloseTo(r * 0.045, 4);
    expect(chrono.some((item) => item.id === 'geo-chrono-hand')).toBe(true);
    expect(chrono.some((item) => item.id === 'geo-chrono-pin')).toBe(true);

    // 第 22 档 折带：五条带（带下各一条细线）+ 两条竖线；中间那条最粗。
    const ribbons = buildSonnetGeoShapes(VIEWPORT, 22, 360) ?? [];
    expect(ribbons.filter((item) => /^geo-ribbon-\d$/.test(item.id))).toHaveLength(5);
    expect(ribbons.filter((item) => item.id.startsWith('geo-ribbon-edge-'))).toHaveLength(5);
    expect(ribbons.filter((item) => item.id.startsWith('geo-ribbon-drop-'))).toHaveLength(2);
    expect(ribbons.find((item) => item.id === 'geo-ribbon-2')?.strokeWidth).toBe(12);
    expect(ribbons.find((item) => item.id === 'geo-ribbon-0')?.strokeWidth).toBe(5);

    // 第 23 档 半色调海报：点阵数量 = 列的公式值 × 行的公式值，越靠中心越大。
    const halftone = buildSonnetGeoShapes(VIEWPORT, 23, 360) ?? [];
    const dots = halftone.filter((item) => item.id.startsWith('geo-halftone-') && !item.id.startsWith('geo-halftone-rule'));
    const bleedX = Math.max(r * 0.92, VIEWPORT.width * 0.64);
    const bleedY = Math.max(r * 0.92, VIEWPORT.height * 0.64);
    const spacing = r * 0.17;
    const columns = Math.ceil((bleedX * 2) / spacing) + 2;
    const rows = Math.ceil((bleedY * 2) / spacing) + 2;
    expect(dots).toHaveLength(columns * rows);
    expect(halftone.filter((item) => item.id.startsWith('geo-halftone-rule'))).toHaveLength(2);
    const radiusOf = (item: (typeof dots)[number]): number =>
      Math.hypot((item.polygon[0] ?? 0) - VIEWPORT.width / 2, (item.polygon[1] ?? 0) - VIEWPORT.height / 2);
    const centreDot = dots.reduce((best, item) => (radiusOf(item) < radiusOf(best) ? item : best), dots[0]!);
    const cornerDot = dots.reduce((best, item) => (radiusOf(item) > radiusOf(best) ? item : best), dots[0]!);
    const sizeOf = (item: (typeof dots)[number]): number =>
      Math.hypot((item.polygon[2] ?? 0) - (item.polygon[0] ?? 0), (item.polygon[3] ?? 0) - (item.polygon[1] ?? 0));
    expect(sizeOf(centreDot)).toBeGreaterThan(sizeOf(cornerDot));
  });

  it('开框档 36~47：十二种"开框"背景各自的件数（照抄 sonnetOpenFrameShotMg）', () => {
    // 36~47 都不在正立白名单里 ⇒ 用 seed = 360 把整体旋转归零再数。
    const count = (variant: number): number => (buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? []).length;
    const ids = (variant: number): readonly string[] =>
      (buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? []).map((item) => item.id);
    expect(count(36)).toBe(17); // 四角 × (外弧 + 内弧 + 两个十字短划) + 一个点
    expect(count(37)).toBe(51); // 12 + 16 + 20 段虚线弧 + 两个标记点 + 一个中心圈
    expect(count(38)).toBe(6); // 五个三边碎框 + 其中一个中心的点
    expect(count(39)).toBe(15); // 两组 × (三根线各断成两段 + 一个记号) + 一个色块
    expect(count(40)).toBe(23); // 两段弧 + 18 根刻度 + 每六根一个节点
    expect(count(41)).toBe(28); // 两侧 × (竖线 + 12 根刻度 + 一个强调块)
    expect(count(42)).toBe(10); // 七条斜线 + 两个缺边菱形 + 一个点
    expect(count(43)).toBe(11); // 两角 × 五片花瓣 + 起点一个点
    expect(count(44)).toBe(31); // 7×5 点阵里去掉 7 个 + 三个直角记号
    expect(count(45)).toBe(8); // 三段弧 + 扫掠线 + 两段锁定刻度 + 两个点
    expect(count(46)).toBe(10); // 四道笔触 × (粗 + 细) + 角标 + 方块
    expect(count(47)).toBe(36); // 四角 × 三段 × 两向 + 中心十字五段 × 两向 + 两个点

    /*
     * "开框"的硬性质：**那些由折线/弧线构成的图形都不闭合**（首尾点不重合）。
     * 注意这个族里**也有**真正的圆（标记点、轴心、核心圈 —— 原版那里调的就是 `circle()`），
     * 所以只挑那几件"该开口"的来查。
     */
    const openById = (variant: number, id: string): readonly number[] =>
      (buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? []).find((item) => item.id === id)?.polygon ?? [];
    const isOpen = (polygon: readonly number[]): boolean =>
      Math.abs((polygon[0] ?? 0) - (polygon[polygon.length - 2] ?? 0)) > 1e-6 ||
      Math.abs((polygon[1] ?? 0) - (polygon[polygon.length - 1] ?? 0)) > 1e-6;
    expect(isOpen(openById(37, 'geo-orbit-dash-0-0')), '虚线轨道的一段弧应是开口的').toBe(true);
    expect(isOpen(openById(38, 'geo-fragment-0')), '三边碎框应是开口的').toBe(true);
    expect(isOpen(openById(40, 'geo-wreath-outer')), '半花环应是开口的').toBe(true);
    expect(isOpen(openById(42, 'geo-stream-diamond-0')), '缺边菱形应是开口的').toBe(true);
    expect(isOpen(openById(43, 'geo-petal-0-0')), '花瓣应是开口的').toBe(true);
    expect(isOpen(openById(45, 'geo-open-radar-lock-a')), '锁定刻度应是开口的').toBe(true);
    expect(isOpen(openById(46, 'geo-brush-corner')), '三边角标应是开口的').toBe(true);
    // 三边碎框只连了三条边：四个顶点 8 个数，但首尾不重合。
    expect(openById(38, 'geo-fragment-0')).toHaveLength(8);
    // 二十四个档位都已搬：只有 24~35 与 48 往后的 extended 族仍是 `null`。
    expect(buildSonnetGeoShapes(VIEWPORT, 36, 360)).not.toBeNull();
    expect(buildSonnetGeoShapes(VIEWPORT, 47, 360)).not.toBeNull();
    expect(ids(44).filter((id) => id.startsWith('geo-window-bracket-'))).toHaveLength(3);
  });

  it('档位地图：四个家族首尾相接铺满 0~99，覆盖率按档位算（不会被"没搬"悄悄算成"不画"）', () => {
    expect(SONNET_GEO_RANGES[0]?.start).toBe(0);
    let cursor = 0;
    for (const range of SONNET_GEO_RANGES) {
      expect(range.start, `${range.key} 应该接在上一段后面`).toBe(cursor);
      cursor += range.count;
    }
    // 四个家族正好铺满 0~99：原版**每一档都会画东西**。
    expect(cursor).toBe(100);
    expect(SONNET_GEO_RANGES.map((range) => range.key)).toEqual([
      '基础几何',
      '附加海报',
      '主题图形',
      '开框背景',
      '扩展·天体篇',
      '扩展·海洋篇',
      '扩展·音乐篇',
      '扩展·工艺篇',
      '扩展·动态篇',
    ]);
    const coverage = describeSonnetGeoCoverage();
    expect(coverage.total).toBe(100);
    // **全部搬完**：基础 18 + 海报 6 + 主题 12 + 开框 12 + 五篇扩展 52 = 100。
    expect(coverage.ported).toBe(100);
    expect(coverage.summary).toContain('已搬 100/100 档');
    expect(coverage.summary).toContain('主题图形 24~35');
    expect(coverage.summary).toContain('全部搬完');
    expect(coverage.summary).not.toContain('未搬');
    // 已搬的档位与 `hasSonnetGeoVariant` 必须一致（覆盖率和实际行为不能各说一套）。
    for (let variant = 0; variant < 100; variant += 1) {
      const expected = SONNET_GEO_RANGES.some(
        (range) => variant >= range.start && variant < range.start + range.portedCount,
      );
      expect(buildSonnetGeoShapes(VIEWPORT, variant, 360) !== null, `第 ${variant} 档的可得性`).toBe(expected);
    }
  });

  it('扩展主题 · 天体篇 48~57：十种构图各自的件数（照抄 sonnetShotMgCelestial）', () => {
    // 48~57 都不在正立白名单里 ⇒ 用 seed = 360 把整体旋转归零再数。
    const build = (variant: number): ReturnType<typeof buildSonnetGeoShapes> =>
      buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? [];
    const count = (variant: number): number => build(variant)?.length ?? 0;
    expect(count(48)).toBe(2 + 1 + 1 + 14); // 两条旋臂 + 核 + 环 + 14 星尘
    expect(count(49)).toBe(3 + 1 + 1 + 5 * 2); // 三条彗尾 + 核 + 光晕 + 5 组十字闪光
    expect(count(50)).toBe(3 + 28); // 圆盘填充 + 边框 + 外圈 + 28 根冕射
    expect(count(51)).toBe(8 * 3); // 八颗流星 × (主线 + 淡影 + 头部)
    expect(count(52)).toBe(12 + 3 + 1); // 三段 + 四段 + 五段弧 + 三颗卫星 + 中心点
    expect(count(53)).toBe(4 * 2 + 8); // 四条飘带 × (主 + 伴线) + 八粒雪
    expect(count(54)).toBe(3 + 3 * 2); // 月牙 + 两圈光晕 + 三条挂星线 × (线 + 星)
    expect(count(55)).toBe(4 + 10); // 四团星云 + 十粒尘埃
    expect(count(56)).toBe(5 * 4 * 2 + 6 * 2 + 5); // 十字网 + 六颗星 × (点 + 光晕) + 五条连线
    expect(count(57)).toBe(2 + (6 + 5 + 4 + 3)); // 月亮 + 弧光 + 四排潮弧

    // 几处关键数值：日蚀日冕 28 根、流星 8 颗、星图 5×4 十字网。
    expect(build(50)?.filter((item) => item.id.startsWith('geo-corona-ray-'))).toHaveLength(28);
    expect(build(51)?.filter((item) => /^geo-meteor-\d+$/.test(item.id))).toHaveLength(8);
    expect(build(56)?.filter((item) => item.id.startsWith('geo-starmap-h-'))).toHaveLength(20);
    expect(build(56)?.filter((item) => item.id.startsWith('geo-starmap-node-'))).toHaveLength(6);
    // 星图那条连线的透明度是 0.55（照抄），潮水第一排最粗最亮。
    expect(build(56)?.find((item) => item.id === 'geo-starmap-link-1')?.strokeAlpha).toBeCloseTo(0.55, 9);
    const tide = build(57)?.find((item) => item.id === 'geo-tide-arc-0-0');
    expect(tide?.strokeWidth).toBe(2);
    expect(tide?.strokeAlpha).toBeCloseTo(0.45, 9);
    // 天体篇的档数常量必须与名单一致（地图的覆盖率靠它）。
    expect(SONNET_CELESTIAL_GEO_VARIANTS).toHaveLength(SONNET_CELESTIAL_GEO_VARIANT_COUNT);
  });

  it('扩展主题 · 海洋篇 58~67：十种构图各自的件数（照抄 sonnetShotMgMarine）', () => {
    const build = (variant: number): ReturnType<typeof buildSonnetGeoShapes> =>
      buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? [];
    const r = Math.min(VIEWPORT.width, VIEWPORT.height);
    const bleedX = Math.max(r * 0.92, VIEWPORT.width * 0.64);
    // 58 浪卷：四排弧（每排按出血宽度铺满）+ 六粒气泡。
    const crestR = r * 0.1;
    const perRow = Math.ceil((bleedX * 2) / (crestR * 2.1));
    expect(build(58)?.length).toBe(perRow * 4 + 6);
    expect(build(59)?.length).toBe(1 + 8 + 1); // 螺线 + 八条隔室 + 螺心
    expect(build(60)?.length).toBe(7 * 2 + 5); // 三层分叉共 7 段（每段配一个芽）+ 五粒息肉
    expect(build(61)?.length).toBe(1 + 1 + 1 + 4 + 5); // 塔身 + 灯室 + 灯点 + 两束 × 两线 + 五道海弧
    expect(build(62)?.length).toBe(8 + 2 + 25); // 八根指针 + 环与心 + 25 根刻度
    expect(build(63)?.length).toBe(3 * 4 + 7); // 三条船 × 四件 + 七道水纹
    // 三列气泡 5/6/7；只有 `r > 0.05r` 的那些（t > 0.5455）才带高光弧 ⇒ 2 + 2 + 3 = 7 道。
    expect(build(64)?.length).toBe(5 + 6 + 7 + 7);
    expect(build(65)?.length).toBe(4 * 4); // 四个水洼 × (轮廓 + 三粒卵石)
    expect(build(66)?.length).toBe(6 * 2 + 6); // 六片海草 × (叶 + 顶球) + 六粒气泡
    expect(build(67)?.length).toBe(5 + 6); // 五条水流 + 六条鱼字纹
    // 关键数值：浪冠是上半弧、罗盘只在一段弧上打刻度、气泡列数 5/6/7。
    expect(build(58)?.find((item) => item.id === 'geo-wave-arc-0-0')?.strokeAlpha).toBeCloseTo(0.42, 9);
    expect(build(61)?.filter((item) => item.id.startsWith('geo-lighthouse-beam-'))).toHaveLength(4);
    expect(build(62)?.filter((item) => item.id.startsWith('geo-compass-tick-'))).toHaveLength(25);
    expect(build(64)?.filter((item) => item.id.startsWith('geo-bubble-glint-'))).toHaveLength(7);
    expect(SONNET_MARINE_GEO_VARIANTS).toHaveLength(SONNET_MARINE_GEO_VARIANT_COUNT);
  });

  it('扩展主题 · 工艺篇 76~85：十种构图各自的件数（照抄 sonnetShotMgCraft）', () => {
    const build = (variant: number): ReturnType<typeof buildSonnetGeoShapes> =>
      buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? [];
    const r = Math.min(VIEWPORT.width, VIEWPORT.height);
    expect(r).toBe(760);
    expect(build(76)?.length).toBe(7); // 身体 + 翅（线 + 填）+ 颈 + 尾 + 两条折痕
    expect(build(77)?.length).toBe(2 + 3); // 两片折三角 + 三条弧航迹
    // 织带：横带 10 + 11 段（按 `(i + row) % 2` 一半露一半断）+ 竖带 7 × 2。
    expect(build(78)?.length).toBe(10 + 11 + 7 * 2);
    expect(build(79)?.length).toBe(4 + 2); // 四段结 + 两条散头
    // 十字绣：每排条数按 `7 − |row − 1.5|` 取整 ⇒ 6 / 7 / 7 / 6 针（第 1、2 排最长），每针两笔。
    expect(build(80)?.length).toBe((6 + 7 + 7 + 6) * 2);
    expect(build(81)?.length).toBe(11 + 2 + 1); // 11 根扇骨 + 两道护边弧 + 轴心
    expect(build(82)?.length).toBe(2 + 1); // 主螺线 + 回声螺线 + 散头
    expect(build(83)?.length).toBe(3 * 4); // 三片三角 × (轮廓 + 三条斜纹)
    expect(build(84)?.length).toBe(1 + 8 + 1 + 3 * 8); // 环 + 八条网线 + 小圈 + 三条羽毛 × (线 + 羽 + 三对羽枝)
    expect(build(85)?.length).toBe(1 + 7 * 2); // 横杆 + 七条流苏 × (线 + 珠)
    // 关键数值：织带是 7 条竖带、扇骨 11 根且第 6 根最粗、羽毛每侧三条羽枝。
    expect(build(78)?.filter((item) => /^geo-weave-v-\d+$/.test(item.id))).toHaveLength(7);
    expect(build(78)?.filter((item) => item.id.startsWith('geo-weave-h-'))).toHaveLength(21);
    expect(build(81)?.find((item) => item.id === 'geo-fan-rib-5')?.strokeWidth).toBe(2.5);
    expect(build(84)?.filter((item) => item.id.startsWith('geo-dream-barb-'))).toHaveLength(18);
    expect(build(76)?.find((item) => item.id === 'geo-crane-wing-fold')?.fillAlpha).toBeCloseTo(0.07, 9);
    expect(SONNET_CRAFT_GEO_VARIANTS).toHaveLength(SONNET_CRAFT_GEO_VARIANT_COUNT);
  });

  it('扩展主题 · 动态篇 86~99：十四种构图各自的件数（照抄 sonnetShotMgKinetic）', () => {
    const build = (variant: number): ReturnType<typeof buildSonnetGeoShapes> =>
      buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? [];
    expect(build(86)?.length).toBe(9 * 2 + 1); // 九根摆 × (线 + 球) + 横梁
    expect(build(87)?.length).toBe(10); // 十张骨牌（每张闭合四边形）
    expect(build(88)?.length).toBe(3 * 2 + 25); // 三齿轮 × (圈 + 轴) + 齿 10/8/7
    expect(build(89)?.length).toBe(4 * 3); // 四条走线 × (走线 + 折角焊点 + 过孔)
    expect(build(90)?.length).toBe(1 + 3 + 1 + 6); // 塔身 + 三横撑 + 顶灯 + 两侧各三弧
    expect(build(91)?.length).toBe(12 * 2 + 1); // 十二级 × (踏面 + 竖板) + 中心柱
    expect(build(92)?.length).toBe(9 + 5); // 九条水线 + 五道水弧
    expect(build(93)?.length).toBe(4 * 2 + 2); // 四片叶 × (帆 + 斜撑) + 轴心 + 外框
    expect(build(94)?.length).toBe(1 + 4 + 2); // 水滴 + 四圈涟漪 + 两笔水冠
    expect(build(95)?.length).toBe(1 + 6 + 3 + 6); // 桥面 + 两塔 × 三件 + 三段主缆 + 六根吊索
    expect(build(96)?.length).toBe(4 * 2 + 4); // 四环 × 两镜像 + 两极（点 + 横杆）
    expect(build(97)?.length).toBe(2 + 1 + 4); // 三角（线 + 填）+ 入射束 + 四束出射
    expect(build(98)?.length).toBe(5 * 2); // 五段回声弧 × (弧 + 点)
    expect(build(99)?.length).toBe(4 + 1 + 3); // 风筝（轮廓 + 十字骨两笔 + 填充）+ 一条线 + 三个结
    // 关键数值：摆 9 根、骨牌 10 张、齿数 10/8/7、涟漪缺口 72%、三个蝴蝶结。
    expect(build(86)?.filter((item) => item.id.startsWith('geo-pendulum-bob-'))).toHaveLength(9);
    expect(build(88)?.filter((item) => item.id.startsWith('geo-gear-tooth-1-'))).toHaveLength(8);
    expect(build(92)?.filter((item) => item.id.startsWith('geo-waterfall-splash-'))).toHaveLength(5);
    expect(build(95)?.filter((item) => item.id.startsWith('geo-bridge-hanger-'))).toHaveLength(6);
    expect(build(99)?.filter((item) => item.id.startsWith('geo-kite-bow-'))).toHaveLength(3);
    // 风筝线的采样点数 = 起点 + 24 步 ⇒ 50 个数（整条线一起长出来）。
    expect(build(99)?.find((item) => item.id === 'geo-kite-string')?.polygon).toHaveLength(50);
    expect(build(94)?.find((item) => item.id === 'geo-ripple-ring-0')?.strokeWidth).toBe(2);
    expect(SONNET_KINETIC_GEO_VARIANTS).toHaveLength(SONNET_KINETIC_GEO_VARIANT_COUNT);
  });

  it('主题图形 · 花木篇 24~26：三档件数（照抄 sonnetShotMgFlora + 图元文件）', () => {
    const build = (variant: number): ReturnType<typeof buildSonnetGeoShapes> =>
      buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? [];
    // 24 山茶花：三层 7 + 11 + 15 = 33 片花瓣（每片三笔：填 / 描 / 中脉）+ 花心填充 + 外圈。
    expect(build(24)?.length).toBe(33 * 3 + 2);
    expect(build(24)?.filter((item) => item.id.endsWith('-fill')).length).toBe(33);
    expect(build(24)?.filter((item) => item.id.endsWith('-rib')).length).toBe(33);
    // 25 郁金香田：七株 × (茎 + 叶三笔 + 花苞填 + 花苞描) = 七株 × 六件。
    expect(build(25)?.length).toBe(7 * 6);
    // 26 野花：九株 × (茎 + 五瓣 × 三笔 + 花心) = 九株 × 十七件。
    expect(build(26)?.length).toBe(9 * 17);
    // 关键数值：花瓣填充透明度 `0.07 + ring × 0.045`、描边 `min(0.8, 填 × 3.2)`、中脉 0.32。
    expect(build(24)?.find((item) => item.id === 'geo-camellia-0-0-fill')?.fillAlpha).toBeCloseTo(0.07, 9);
    expect(build(24)?.find((item) => item.id === 'geo-camellia-2-0-fill')?.fillAlpha).toBeCloseTo(0.16, 9);
    // 描边透明度是 `min(0.8, 填 × 3.2)`：最外层的填是 0.16 ⇒ 0.512（还没到 0.8 的上限）。
    expect(build(24)?.find((item) => item.id === 'geo-camellia-2-0-stroke')?.strokeAlpha).toBeCloseTo(0.512, 9);
    expect(build(24)?.find((item) => item.id === 'geo-camellia-0-0-rib')?.strokeAlpha).toBeCloseTo(0.32, 9);
    // 第二层用强调色（照抄 `ring === 1 ? secondary : primary`）。
    expect(build(24)?.find((item) => item.id === 'geo-camellia-1-0-fill')?.fillTone).toBe(2);
    expect(build(24)?.find((item) => item.id === 'geo-camellia-0-0-fill')?.fillTone).toBe(1);
    expect(build(25)?.filter((item) => item.id.startsWith('geo-tulip-leaf-'))).toHaveLength(7 * 3);
    expect(build(26)?.filter((item) => item.id.startsWith('geo-wildflower-core-'))).toHaveLength(9);
    expect(SONNET_THEMED_GEO_VARIANTS).toHaveLength(SONNET_THEMED_GEO_VARIANT_COUNT);
  });

  it('主题图形 · 植物篇 27~29：三档件数（照抄 sonnetShotMgBotanical）', () => {
    const build = (variant: number): ReturnType<typeof buildSonnetGeoShapes> =>
      buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? [];
    // 27 蕨：一条主茎 + 十三对羽叶（每片三笔）。
    expect(build(27)?.length).toBe(1 + 13 * 2 * 3);
    // 28 银杏：一条粗枝 + 八片叶（每片 = 短柄 + 扇形填 + 扇形描）。
    expect(build(28)?.length).toBe(1 + 8 * 3);
    // 29 爬藤：三条藤 × (藤 + 五片叶 × 三笔)。
    expect(build(29)?.length).toBe(3 * (1 + 5 * 3));
    // 关键数值：蕨中段最长（ratio = 0.5 附近）、银杏扇形是从柄端出发的闭合扇面、爬藤中间那条最粗。
    const fernMid = build(27)?.find((item) => item.id === 'geo-fern-left-6-rib');
    const fernEnd = build(27)?.find((item) => item.id === 'geo-fern-left-0-rib');
    const ribLength = (item: (typeof fernMid)): number =>
      Math.hypot((item?.polygon[2] ?? 0) - (item?.polygon[0] ?? 0), (item?.polygon[3] ?? 0) - (item?.polygon[1] ?? 0));
    expect(ribLength(fernMid)).toBeGreaterThan(ribLength(fernEnd));
    expect(build(27)?.find((item) => item.id === 'geo-fern-left-0-fill')?.fillAlpha).toBeCloseTo(0.09, 9);
    expect(build(27)?.find((item) => item.id === 'geo-fern-right-0-fill')?.fillAlpha).toBeCloseTo(0.07, 9);
    // 银杏扇形：首尾都落在柄端（闭合），所以第一个点与最后一个点重合。
    const fan = build(28)?.find((item) => item.id === 'geo-ginkgo-fan-fill-0')?.polygon ?? [];
    expect(fan[0]).toBeCloseTo(fan[fan.length - 2] ?? Number.NaN, 6);
    expect(fan[1]).toBeCloseTo(fan[fan.length - 1] ?? Number.NaN, 6);
    expect(build(28)?.find((item) => item.id === 'geo-ginkgo-branch')?.strokeWidth).toBe(5);
    expect(build(29)?.find((item) => item.id === 'geo-vine-1')?.strokeWidth).toBe(3);
    expect(build(29)?.find((item) => item.id === 'geo-vine-1')?.strokeTone).toBe(2);
    expect(build(29)?.filter((item) => item.id.startsWith('geo-vine-0-leaf-'))).toHaveLength(15);
  });

  it('主题图形 · 建筑篇 30~32：三档件数（照抄 sonnetShotMgArchitecture）', () => {
    const build = (variant: number): ReturnType<typeof buildSonnetGeoShapes> =>
      buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? [];
    // 30 温室：外壳（填 + 描）+ 中脊 + 七条格 + 门（填 + 描）+ 两条地平线。
    expect(build(30)?.length).toBe(2 + 1 + 7 + 2 + 2);
    // 31 塔：四层 × (檐口填描 + 层身填描) + 塔尖 + 两条地平线。
    expect(build(31)?.length).toBe(4 * 4 + 1 + 2);
    // 32 城市立面：七栋 × (填 + 描) + 亮着的窗（按 `(row + col + i + seed) % 3` 算 ⇒ 19 盏）+ 地平线。
    const windows: readonly number[] = [2, 3, 2, 4, 2, 4, 2];
    expect(build(32)?.length).toBe(7 * 2 + windows.reduce((sum, count) => sum + count, 0) + 1);
    // 关键数值：温室门用强调色、塔最高一层檐口最亮、第 4 栋楼（index = 3）最粗且窗户数照公式来。
    expect(build(30)?.find((item) => item.id === 'geo-greenhouse-door-stroke')?.strokeTone).toBe(2);
    expect(build(31)?.find((item) => item.id === 'geo-pagoda-roof-fill-0')?.fillAlpha).toBeCloseTo(0.07, 9);
    expect(build(31)?.find((item) => item.id === 'geo-pagoda-roof-fill-3')?.fillAlpha).toBeCloseTo(0.145, 9);
    expect(build(32)?.find((item) => item.id === 'geo-city-body-stroke-3')?.strokeWidth).toBe(3);
    for (const [index, count] of windows.entries()) {
      expect(build(32)?.filter((item) => item.id.startsWith(`geo-city-window-${index}-`))).toHaveLength(count);
    }
    // 温室外壳是**闭合**的（原版 fillPolygon / strokePolygon 都会回到起点）。
    const shell = build(30)?.find((item) => item.id === 'geo-greenhouse-shell-stroke')?.polygon ?? [];
    expect(shell[0]).toBeCloseTo(shell[shell.length - 2] ?? Number.NaN, 6);
    expect(shell[1]).toBeCloseTo(shell[shell.length - 1] ?? Number.NaN, 6);
  });

  it('主题图形 · 风景篇 33~35：三档件数（照抄 sonnetShotMgLandscape）', () => {
    const build = (variant: number): ReturnType<typeof buildSonnetGeoShapes> =>
      buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? [];
    // 33 梯田：七层 × (填充 + 上缘描线)。
    expect(build(33)?.length).toBe(7 * 2);
    // 34 山湖：两层山脊 × (填 + 描) + 七道湖纹 + 月（填 + 环）。
    expect(build(34)?.length).toBe(2 * 2 + 7 + 2);
    // 35 海岸：崖体（填 + 描）+ 塔身（填 + 描）+ 塔顶（填 + 描）+ 六道浪。
    expect(build(35)?.length).toBe(2 + 2 + 2 + 6);
    // 关键数值：梯田每三层一条 2.5px 的粗上缘、湖纹左右内缩 `0.08 + (line % 3) × 0.08`、浪每三道一条 2px。
    expect(build(33)?.find((item) => item.id === 'geo-terrace-crest-0')?.strokeWidth).toBe(2.5);
    expect(build(33)?.find((item) => item.id === 'geo-terrace-crest-1')?.strokeWidth).toBe(1);
    expect(build(33)?.find((item) => item.id === 'geo-terrace-fill-0')?.fillAlpha).toBeCloseTo(0.025, 9);
    expect(build(33)?.find((item) => item.id === 'geo-terrace-fill-6')?.fillAlpha).toBeCloseTo(0.133, 9);
    const lakeLine = build(34)?.find((item) => item.id === 'geo-lake-line-3')?.polygon ?? [];
    const r = Math.min(VIEWPORT.width, VIEWPORT.height);
    const bleedX = Math.max(r * 0.92, VIEWPORT.width * 0.64);
    // 第 3 道湖纹取 `line % 3 === 0` ⇒ 内缩量是 0.08r（不是 0.16r，我一开始就写错了这一处）。
    expect(lakeLine[0]).toBeCloseTo(VIEWPORT.width / 2 - bleedX + r * 0.08, 4);
    expect(build(34)?.find((item) => item.id === 'geo-lake-front-stroke')?.strokeWidth).toBe(2.5);
    expect(build(35)?.find((item) => item.id === 'geo-cliff-wave-0')?.strokeWidth).toBe(2);
    expect(build(35)?.find((item) => item.id === 'geo-cliff-wave-1')?.strokeWidth).toBe(1);
    // 两层山脊与崖体都是**闭合**多边形。
    for (const id of ['geo-lake-back-stroke', 'geo-lake-front-stroke', 'geo-cliff-stroke']) {
      const polygon = build(id.startsWith('geo-lake') ? 34 : 35)?.find((item) => item.id === id)?.polygon ?? [];
      expect(polygon[0], `${id} 应闭合`).toBeCloseTo(polygon[polygon.length - 2] ?? Number.NaN, 6);
      expect(polygon[1], `${id} 应闭合`).toBeCloseTo(polygon[polygon.length - 1] ?? Number.NaN, 6);
    }
  });

  it('扩展主题 · 音乐篇 68~75：八种构图各自的件数（照抄 sonnetShotMgMusic）', () => {
    const build = (variant: number): ReturnType<typeof buildSonnetGeoShapes> =>
      buildSonnetGeoShapes(VIEWPORT, variant, 360) ?? [];
    expect(build(68)?.length).toBe(2 + 1); // 上下两条镜像波形 + 中间轴线
    expect(build(69)?.length).toBe(7 + 5); // 七圈纹路 + 中心环/孔 + 支点/唱臂/针
    expect(build(70)?.length).toBe(17 * 2); // 十七根条 × (条 + 顶端点)
    expect(build(71)?.length).toBe(5 * 2 + 2); // 五个音符 × (符头 + 符干) + 符杠 + 散尾
    expect(build(72)?.length).toBe(5 + 6); // 两叉股 + 半圆 + 手柄 + 基座 + 两侧各三弧
    expect(build(73)?.length).toBe(1 + 12); // 缎带弧 + 十二个琴键
    expect(build(74)?.length).toBe(3 + 3 + 3); // 三条本体线 + 支点/摆杆/平衡块 + 三道回声弧
    expect(build(75)?.length).toBe(5 + 4 * 2); // 五条谱线 + 四个音符 × (符头 + 符干)
    // 每根声波是 72 段 ⇒ 72 + 1 个点（144 + 2 个数）。
    expect(build(68)?.find((item) => item.id === 'geo-soundwave-up')?.polygon).toHaveLength(146);
    expect(build(68)?.find((item) => item.id === 'geo-soundwave-axis')?.strokeAlpha).toBeCloseTo(0.18, 9);
    // 黑胶纹路**永不闭合**：一段 86% 的弧。
    const groove = build(69)?.find((item) => item.id === 'geo-vinyl-groove-0')?.polygon ?? [];
    expect(groove[0]).not.toBeCloseTo(groove[groove.length - 2] ?? Number.NaN, 3);
    // 黑键（1 / 3 / 6 / 8 / 10）更短更粗更亮。
    expect(build(73)?.find((item) => item.id === 'geo-piano-key-1')?.strokeWidth).toBe(4);
    expect(build(73)?.find((item) => item.id === 'geo-piano-key-1')?.strokeTone).toBe(2);
    expect(build(73)?.find((item) => item.id === 'geo-piano-key-0')?.strokeWidth).toBe(3);
    // 五线谱中间那条更亮（0.3 + 0.15）。
    expect(build(75)?.find((item) => item.id === 'geo-staff-line-2')?.strokeAlpha).toBeCloseTo(0.45, 9);
    expect(build(75)?.find((item) => item.id === 'geo-staff-line-3')?.strokeAlpha).toBeCloseTo(0.3, 9);
    expect(SONNET_MUSIC_GEO_VARIANTS).toHaveLength(SONNET_MUSIC_GEO_VARIANT_COUNT);
  });

  it('没搬的档位已经**一个都不剩**（100 档全部能画原版图形）', () => {
    for (let variant = 0; variant < 100; variant += 1) {
      expect(buildSonnetGeoShapes(VIEWPORT, variant, 360) !== null, `第 ${variant} 档`).toBe(true);
    }
    // 带种子的子档位也都在。
    for (const seed of [5, 1080, 1440]) {
      expect(buildSonnetGeoShapes(VIEWPORT, 3, seed)?.length ?? 0, `第 3 档 seed=${seed}`).toBeGreaterThan(5);
    }
  });
});
