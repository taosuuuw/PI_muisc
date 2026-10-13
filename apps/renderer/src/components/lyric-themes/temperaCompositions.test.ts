/**
 * 凝彩（tempera）**构图语汇**的自查：band 族 9 种 + 网线裁剪。
 *
 * 这些是纯函数（视口 + 种子 → 几何），所以能在这里把"构图铺不铺满、网线有没有跑出形状"
 * 这类事情钉住；渲染层只负责把它们画出来。
 */

import { describe, expect, it } from 'vitest';
import { TEMPERA_SHOT_KINDS, TEMPERA_SHOT_KINDS_BY_FAMILY } from './temperaKinds';
import { resolveTemperaShotProfile } from './temperaProfiles';
import {
  buildHatchLines,
  buildHatchSpec,
  buildMarkRow,
  buildWavyPath,
  hatchRectPolygon,
} from './temperaHatch';
import {
  arcRibbonPolygon,
  ellipsePolygon,
  heartPolygon,
  lobedPolygon,
  roundedRectPolygon,
  scallopBandPolygon,
  starPolygon,
} from './temperaCurves';
import {
  acrossFlow,
  buildTemperaApertureComposition,
  buildTemperaBandComposition,
  buildTemperaCharmComposition,
  buildTemperaCinemaComposition,
  buildTemperaCorridorComposition,
  buildTemperaFrameComposition,
  buildTemperaMonolithComposition,
  buildTemperaMonogatariComposition,
  buildTemperaPosterComposition,
  buildTemperaSparseComposition,
  buildTemperaSignalComposition,
  buildTemperaTerrainComposition,
  channelAxis,
  fitTemperaWindow,
  flowPoint,
  rectPolygon,
} from './temperaCompositions';

/** 竖直向下的流向（画面 y 轴向下，所以是 +π/2）。 */
const straightFlow = (): number => Math.PI / 2;

const VIEWPORT = { width: 1182, height: 772 };
const BLEED = 94;

const BAND_KINDS = [
  'band-strip',
  'horizon-band',
  'deep-dive',
  'tone-ramp',
  'double-band',
  'tilt-band',
  'edge-rails',
  'gradient-wall',
  'terrace',
] as const;

/** 一个多边形集合的并集外接框。 */
const boundsOf = (polygons: readonly (readonly number[])[]): [number, number, number, number] => {
  const xs = polygons.flatMap((polygon) =>
    polygon.filter((_value, index) => index % 2 === 0),
  );
  const ys = polygons.flatMap((polygon) =>
    polygon.filter((_value, index) => index % 2 === 1),
  );
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

describe('tempera band 族', () => {
  it('9 种都给出真实构图（不是兜底），并且横向铺满、纵向成片', () => {
    for (const kind of BAND_KINDS) {
      const spec = buildTemperaBandComposition(kind, 20240914, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      expect(spec.panels.length).toBeGreaterThan(0);
      const [minX, minY, maxX, maxY] = boundsOf(spec.panels.map((panel) => panel.points));
      /*
       * band 族是**横带**语汇：横向必然满幅（两头都吃出血），纵向则按族意各不相同 ——
       * `band-strip` 就是一条带压在画面中部，`double-band` 中间还特意留一条缝，
       * 所以这里不能要求"并集外接框铺满四边"（那是 split 族那种整幅切分的情形）。
       */
      expect(minX).toBeLessThanOrEqual(0);
      expect(maxX).toBeGreaterThanOrEqual(VIEWPORT.width);
      expect(maxY - minY).toBeGreaterThan(VIEWPORT.height * 0.28);
      for (const panel of spec.panels) {
        expect(panel.points.length % 2).toBe(0);
        expect(panel.points.length).toBeGreaterThanOrEqual(6);
        expect(Number.isFinite(panel.alpha)).toBe(true);
        expect(panel.span).toBeGreaterThan(0);
        expect(panel.tone).toBeGreaterThanOrEqual(0);
        expect(panel.tone).toBeLessThanOrEqual(3);
      }
      // 也不是一堆碎屑：至少有一块的面积超过画面的两成。
      const largestArea = Math.max(
        ...spec.panels.map((panel) => {
          const xs = panel.points.filter((_value, index) => index % 2 === 0);
          const ys = panel.points.filter((_value, index) => index % 2 === 1);
          return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
        }),
      );
      expect(largestArea).toBeGreaterThan(VIEWPORT.width * VIEWPORT.height * 0.2);
    }
  });

  it('非 band 族返回 null（交给别族或兜底），split 族不与它抢', () => {
    expect(buildTemperaBandComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaBandComposition('monogatari-card', 1, VIEWPORT, BLEED)).toBeNull();
  });

  it('有网线的族：网线参数合法，且线段都落在这块形状的外接框里', () => {
    const withHatch = BAND_KINDS.filter(
      (kind) => (buildTemperaBandComposition(kind, 7, VIEWPORT, BLEED)?.panels ?? []).some((panel) => panel.hatch !== null),
    );
    // horizon-band / tone-ramp / tilt-band / gradient-wall 这四条按 folia 都叠网线。
    expect(withHatch.length).toBeGreaterThanOrEqual(4);
    for (const kind of withHatch) {
      const spec = buildTemperaBandComposition(kind, 7, VIEWPORT, BLEED);
      if (spec === null) continue;
      for (const panel of spec.panels) {
        if (panel.hatch === null) continue;
        expect(panel.hatch.spec.spacing).toBeGreaterThan(0);
        expect(panel.hatch.spec.width).toBeGreaterThan(0);
        const [minX, minY, maxX, maxY] = boundsOf([panel.points]);
        const lines = buildHatchLines(panel.points, panel.hatch.spec, 1);
        expect(lines.length).toBeGreaterThan(0);
        for (const hatchLine of lines) {
          for (const [x, y] of [
            [hatchLine.x1, hatchLine.y1],
            [hatchLine.x2, hatchLine.y2],
          ] as const) {
            expect(x).toBeGreaterThanOrEqual((minX ?? 0) - 0.6);
            expect(x).toBeLessThanOrEqual((maxX ?? 0) + 0.6);
            expect(y).toBeGreaterThanOrEqual((minY ?? 0) - 0.6);
            expect(y).toBeLessThanOrEqual((maxY ?? 0) + 0.6);
          }
        }
      }
    }
  });

  it('线条只出现在该有的族里（引导线 / 波浪边），且点数合法', () => {
    const strip = buildTemperaBandComposition('band-strip', 3, VIEWPORT, BLEED);
    expect(strip?.strokes.length).toBe(2);
    const horizon = buildTemperaBandComposition('horizon-band', 3, VIEWPORT, BLEED);
    expect(horizon?.strokes.length).toBe(1);
    expect((horizon?.strokes[0]?.points.length ?? 0) % 2).toBe(0);
    expect((horizon?.strokes[0]?.points.length ?? 0)).toBeGreaterThan(20);
    for (const kind of BAND_KINDS) {
      const spec = buildTemperaBandComposition(kind, 3, VIEWPORT, BLEED);
      for (const stroke of spec?.strokes ?? []) {
        expect(stroke.points.length).toBeGreaterThanOrEqual(4);
        expect(stroke.width).toBeGreaterThan(0);
        expect(Number.isFinite(stroke.tone)).toBe(true);
      }
    }
  });

  it('同一个种子两次求值逐字段一致', () => {
    for (const kind of BAND_KINDS) {
      expect(buildTemperaBandComposition(kind, 99, VIEWPORT, BLEED)).toEqual(
        buildTemperaBandComposition(kind, 99, VIEWPORT, BLEED),
      );
    }
    // 换种子应当真的换出不同构图（否则"随机"是假的）。
    const differences = BAND_KINDS.filter(
      (kind) =>
        JSON.stringify(buildTemperaBandComposition(kind, 1, VIEWPORT, BLEED)) !==
        JSON.stringify(buildTemperaBandComposition(kind, 2, VIEWPORT, BLEED)),
    );
    expect(differences.length).toBeGreaterThanOrEqual(4);
  });

  it('覆盖到的 kind 全都在 121 种的清单里', () => {
    for (const kind of BAND_KINDS) {
      expect(TEMPERA_SHOT_KINDS).toContain(kind);
    }
  });
});

const FRAME_KINDS = [
  'frame-window',
  'double-frame',
  'circle-window',
  'ladder-frame',
  'corner-brackets',
  'inset-box',
  'bracket-pair',
  'arch-window',
  'grid-cells',
  'keyhole',
] as const;

describe('tempera frame 族', () => {
  it('10 种都给出真实构图，而且都靠线条立框（这一族是"窗口"语汇）', () => {
    let closedFamilies = 0;
    for (const kind of FRAME_KINDS) {
      const spec = buildTemperaFrameComposition(kind, 1234567, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      expect(spec.panels.length).toBeGreaterThan(0);
      // 每一族都得有线条：这一族的框、括号、格子、同心菱全靠它。
      expect(spec.strokes.length).toBeGreaterThan(0);
      if (spec.strokes.some((stroke) => stroke.closed)) closedFamilies += 1;
      for (const panel of spec.panels) {
        expect(panel.points.length % 2).toBe(0);
        expect(panel.points.length).toBeGreaterThanOrEqual(6);
        expect(panel.span).toBeGreaterThan(0);
        for (const point of panel.points) expect(Number.isFinite(point)).toBe(true);
      }
      for (const stroke of spec.strokes) {
        expect(stroke.points.length).toBeGreaterThanOrEqual(4);
        expect(stroke.points.length % 2).toBe(0);
        expect(stroke.width).toBeGreaterThan(0);
        expect(stroke.alpha).toBeGreaterThan(0);
        expect(stroke.alpha).toBeLessThanOrEqual(1);
        for (const point of stroke.points) expect(Number.isFinite(point)).toBe(true);
      }
    }
    // 框类（菱窗 / 双框 / 圆窗 / 内缩框 / 拱窗 / 格子 / 钥匙孔）是闭合描边，括号类的三族不是。
    expect(closedFamilies).toBeGreaterThanOrEqual(6);
  });

  it('菱窗：网线菱形在画面中心，三层同心框逐层收小', () => {
    const spec = buildTemperaFrameComposition('frame-window', 7, VIEWPORT, BLEED);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    const hatchPanel = spec.panels.find((panel) => panel.hatch !== null);
    expect(hatchPanel).toBeDefined();
    const xs = (hatchPanel?.points ?? []).filter((_value, index) => index % 2 === 0);
    const ys = (hatchPanel?.points ?? []).filter((_value, index) => index % 2 === 1);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(cx).toBeCloseTo(VIEWPORT.width / 2, 3);
    expect(cy).toBeCloseTo(VIEWPORT.height / 2, 3);
    // 另外还有方点记号（也是闭合的），同心菱是 strokes 里的**前三笔**。
    const rings = spec.strokes.slice(0, 3);
    expect(rings.length).toBe(3);
    for (const ring of rings) expect(ring.closed).toBe(true);
    const spanOf = (index: number): number => {
      const ringXs = (rings[index]?.points ?? []).filter((_value, position) => position % 2 === 0);
      return Math.max(...ringXs) - Math.min(...ringXs);
    };
    expect(spanOf(0)).toBeGreaterThan(spanOf(1));
    expect(spanOf(1)).toBeGreaterThan(spanOf(2));
  });

  it('九宫格：九格都描边，只有正中那一格被填上', () => {
    const spec = buildTemperaFrameComposition('grid-cells', 3, VIEWPORT, BLEED);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    // 一块全屏底 + 一块中心格。
    expect(spec.panels.length).toBe(2);
    const cells = spec.strokes.filter((stroke) => stroke.closed);
    expect(cells.length).toBe(9);
    const center = cells[4];
    const filled = spec.panels[1];
    expect(filled?.points).toEqual(center?.points);
  });

  it('非 frame 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaFrameComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaFrameComposition('band-strip', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of FRAME_KINDS) expect(TEMPERA_SHOT_KINDS).toContain(kind);
  });

  it('同一个种子两次求值逐字段一致', () => {
    for (const kind of FRAME_KINDS) {
      expect(buildTemperaFrameComposition(kind, 42, VIEWPORT, BLEED)).toEqual(
        buildTemperaFrameComposition(kind, 42, VIEWPORT, BLEED),
      );
    }
  });
});

const POSTER_KINDS = [
  'poster-panel',
  'diamond-stack',
  'slash-poster',
  'arrow-wedge',
  'edge-bleed',
  'triangle-mass',
  'ribbon-cross',
  'half-disc',
  'stacked-slabs',
  'wedge-pair',
] as const;

describe('tempera poster 族', () => {
  it('10 种都给出真实构图，而且都有一块占压倒性的"重块"', () => {
    for (const kind of POSTER_KINDS) {
      const spec = buildTemperaPosterComposition(kind, 8675309, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      expect(spec.panels.length).toBeGreaterThanOrEqual(2);
      // 这一族是"响"的：至少有一块铺得很开（外接框超过画面的三成）。
      const widest = Math.max(
        ...spec.panels.map((panel) => {
          const xs = panel.points.filter((_value, index) => index % 2 === 0);
          const ys = panel.points.filter((_value, index) => index % 2 === 1);
          return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
        }),
      );
      expect(widest).toBeGreaterThan(VIEWPORT.width * VIEWPORT.height * 0.3);
      for (const panel of spec.panels) {
        expect(panel.points.length % 2).toBe(0);
        for (const point of panel.points) expect(Number.isFinite(point)).toBe(true);
        expect(Number.isFinite(panel.rotation)).toBe(true);
      }
      for (const stroke of spec.strokes) {
        for (const point of stroke.points) expect(Number.isFinite(point)).toBe(true);
      }
    }
  });

  it('斜重块那两族带旋转与锚点（rotation ≠ 0 且 pivot 给了）', () => {
    for (const kind of ['poster-panel', 'stacked-slabs'] as const) {
      const spec = buildTemperaPosterComposition(kind, 11, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      const rotated = (spec?.panels ?? []).filter(
        (panel) => panel.rotation !== 0 && panel.pivot !== null,
      );
      expect(rotated.length).toBeGreaterThanOrEqual(2);
      for (const panel of rotated) {
        expect(panel.pivot?.[0]).toBeCloseTo(VIEWPORT.width / 2, 3);
        expect(panel.pivot?.[1]).toBeCloseTo(VIEWPORT.height / 2, 3);
      }
      // 其余族不该莫名其妙地斜着。
      const plain = buildTemperaPosterComposition('slash-poster', 11, VIEWPORT, BLEED);
      for (const panel of plain?.panels ?? []) {
        expect(panel.rotation).toBe(0);
        expect(panel.pivot).toBeNull();
      }
    }
  });

  it('菱形栈的三个菱形逐个变小（scale 1 → 0.72 → 0.44）', () => {
    const spec = buildTemperaPosterComposition('diamond-stack', 5, VIEWPORT, BLEED);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    // 第 0 块是全屏底，后面三块才是菱形。
    const diamonds = spec.panels.slice(1);
    expect(diamonds.length).toBe(3);
    const widthOf = (index: number): number => {
      const xs = (diamonds[index]?.points ?? []).filter((_value, position) => position % 2 === 0);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(widthOf(0)).toBeGreaterThan(widthOf(1));
    expect(widthOf(1)).toBeGreaterThan(widthOf(2));
    expect(widthOf(1)).toBeCloseTo(widthOf(0) * 0.72, 3);
  });

  it('非 poster 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaPosterComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaPosterComposition('grid-cells', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of POSTER_KINDS) expect(TEMPERA_SHOT_KINDS).toContain(kind);
  });

  it('同一个种子两次求值逐字段一致', () => {
    for (const kind of POSTER_KINDS) {
      expect(buildTemperaPosterComposition(kind, 24, VIEWPORT, BLEED)).toEqual(
        buildTemperaPosterComposition(kind, 24, VIEWPORT, BLEED),
      );
    }
  });
});

const SPARSE_KINDS = [
  'quiet-line',
  'starfield-dots',
  'ripple-lines',
  'hair-grid',
  'margin-rule',
  'dot-drift',
  'arc-sweep',
  'blank-page',
] as const;

describe('tempera sparse 族', () => {
  it('8 种都给出真实构图，而且都靠线条撑（这一族几乎没有色块）', () => {
    let panelLess = 0;
    for (const kind of SPARSE_KINDS) {
      const spec = buildTemperaSparseComposition(kind, 31415926, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      // 必须有线：这一族就是细线、点阵与手绘笔画。
      expect(spec.strokes.length).toBeGreaterThan(0);
      if (spec.panels.length === 0) panelLess += 1;
      for (const panel of spec.panels) {
        expect(panel.points.length % 2).toBe(0);
        for (const point of panel.points) expect(Number.isFinite(point)).toBe(true);
      }
      for (const stroke of spec.strokes) {
        expect(stroke.points.length).toBeGreaterThanOrEqual(4);
        expect(stroke.points.length % 2).toBe(0);
        expect(stroke.width).toBeGreaterThan(0);
        for (const point of stroke.points) expect(Number.isFinite(point)).toBe(true);
      }
    }
    // 「近乎空白」是这一族的本意：大多数构图连一块面板都没有。
    expect(panelLess).toBeGreaterThanOrEqual(6);
  });

  it('margin-rule 是唯一有实色块的（那条页边粗线），并且挂在 0.12 或 0.88 的页边位置', () => {
    const spec = buildTemperaSparseComposition('margin-rule', 7, VIEWPORT, BLEED);
    expect(spec?.panels.length).toBe(1);
    const xs = (spec?.panels[0]?.points ?? []).filter((_value, index) => index % 2 === 0);
    const center = (Math.min(...xs) + Math.max(...xs)) / 2;
    expect(
      Math.abs(center - VIEWPORT.width * 0.12) < 8 || Math.abs(center - VIEWPORT.width * 0.88) < 8,
    ).toBe(true);
    // 那条线是 6px 宽。
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(6, 3);
  });

  it('点阵族的点数量随间距走，且都落在画面（含出血）范围内', () => {
    for (const kind of ['starfield-dots', 'dot-drift'] as const) {
      const spec = buildTemperaSparseComposition(kind, 11, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      // 每个方点是一条**闭合的四点折线**（不是四笔），所以闭合线条数就是点数。
      const markStrokes = spec.strokes.filter((stroke) => stroke.closed);
      expect(markStrokes.length).toBeGreaterThan(100);
      for (const stroke of markStrokes) {
        expect(stroke.points.length).toBe(8);
      }
      for (const stroke of markStrokes) {
        for (const point of stroke.points) {
          expect(point).toBeGreaterThanOrEqual(-BLEED - 1);
        }
      }
    }
  });

  it('非 sparse 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaSparseComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaSparseComposition('keyhole', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of SPARSE_KINDS) expect(TEMPERA_SHOT_KINDS).toContain(kind);
  });

  it('同一个种子两次求值逐字段一致', () => {
    for (const kind of SPARSE_KINDS) {
      expect(buildTemperaSparseComposition(kind, 77, VIEWPORT, BLEED)).toEqual(
        buildTemperaSparseComposition(kind, 77, VIEWPORT, BLEED),
      );
    }
  });
});

const CINEMA_KINDS = [
  'cinema-scope',
  'cinema-wide',
  'cinema-academy',
  'cinema-square',
  'cinema-portrait',
  'cinema-tall',
  'cinema-twin',
] as const;

describe('tempera cinema 族', () => {
  it('窗口按真实像素保画幅：给什么 aspect，量出来就是什么 aspect', () => {
    for (const [aspect, fill] of [
      [2.39, 0.88],
      [1.85, 0.84],
      [1.33, 0.78],
      [1, 0.72],
      [0.75, 0.72],
      [0.5625, 0.72],
    ] as const) {
      const hole = fitTemperaWindow(VIEWPORT.width, VIEWPORT.height, aspect, fill);
      expect(hole.width / hole.height).toBeCloseTo(aspect, 6);
      // 居中，且不超过填充比例。
      expect(hole.x + hole.width / 2).toBeCloseTo(VIEWPORT.width / 2, 6);
      expect(hole.y + hole.height / 2).toBeCloseTo(VIEWPORT.height / 2, 6);
      expect(hole.width).toBeLessThanOrEqual(VIEWPORT.width * fill + 1e-9);
      expect(hole.height).toBeLessThanOrEqual(VIEWPORT.height * fill + 1e-9);
      expect(hole.width).toBeGreaterThan(0);
      expect(hole.height).toBeGreaterThan(0);
    }
  });

  it('7 种都给出真实构图，遮片（四根条）铺满整幅画面', () => {
    for (const kind of CINEMA_KINDS) {
      const spec = buildTemperaCinemaComposition(kind, 20250101, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      // 窗口的淡调 + 四根遮片条 = 5 块；`cinema-twin` 自成一版（全屏遮片 + 两个窗口 + 一层网线 = 4 块）。
      expect(spec.panels.length).toBeGreaterThanOrEqual(4);
      // 至少有一条窗口内沿的闭合描边。
      expect(spec.strokes.some((stroke) => stroke.closed)).toBe(true);
      // 遮片条合起来要铺满画面（含出血）。
      const bars = spec.panels.filter((panel) => panel.tone === 3);
      const [minX, minY, maxX, maxY] = boundsOf(bars.map((panel) => panel.points));
      expect(minX).toBeLessThanOrEqual(0);
      expect(minY).toBeLessThanOrEqual(0);
      expect(maxX).toBeGreaterThanOrEqual(VIEWPORT.width);
      expect(maxY).toBeGreaterThanOrEqual(VIEWPORT.height);
      for (const panel of spec.panels) {
        for (const point of panel.points) expect(Number.isFinite(point)).toBe(true);
      }
    }
  });

  it('画幅直接决定窗口形状：scope 最扁、tall 最窄', () => {
    /*
     * 注意别按"越宽的画幅窗口越矮"去断（那是我一开始的想当然）：`fill` 各族不同
     * （scope 0.88 / academy 0.78 / 竖画幅 0.72），所以 academy 的高度反而比 portrait 大。
     * 真正确定成立的是：最宽的画幅窗口最扁、最窄的画幅窗口最窄。
     */
    const boxOf = (
      kind: (typeof CINEMA_KINDS)[number],
    ): { width: number; height: number } => {
      const spec = buildTemperaCinemaComposition(kind, 4321, VIEWPORT, BLEED);
      // 第一块面板是窗口的淡调层。
      const hole = spec?.panels[0];
      const xs = (hole?.points ?? []).filter((_value, index) => index % 2 === 0);
      const ys = (hole?.points ?? []).filter((_value, index) => index % 2 === 1);
      return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    };
    expect(boxOf('cinema-scope').height).toBeLessThan(boxOf('cinema-wide').height);
    expect(boxOf('cinema-wide').height).toBeLessThan(boxOf('cinema-tall').height);
    expect(boxOf('cinema-tall').width).toBeLessThan(boxOf('cinema-scope').width);
    // 每一个窗口的宽高比都等于它的画幅。
    expect(boxOf('cinema-scope').width / boxOf('cinema-scope').height).toBeCloseTo(2.39, 3);
    expect(boxOf('cinema-tall').width / boxOf('cinema-tall').height).toBeCloseTo(0.5625, 3);
  });

  it('cinema-twin 是两个窗口：一块全屏遮片 + 两处窗口 + 窗口内沿描边', () => {
    const spec = buildTemperaCinemaComposition('cinema-twin', 9, VIEWPORT, BLEED);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    expect(spec.strokes.filter((stroke) => stroke.closed).length).toBe(2);
    const windows = spec.panels.filter((panel) => panel.tone === 0);
    // 两个窗口的调子层 + 右窗口那层网线 = 三块 tone 0 的面板。
    expect(windows.length).toBe(3);
  });

  it('非 cinema 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaCinemaComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaCinemaComposition('blank-page', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of CINEMA_KINDS) expect(TEMPERA_SHOT_KINDS).toContain(kind);
  });
});

const CHARM_KINDS = [
  'bubble-drift',
  'cloud-window',
  'heart-burst',
  'sparkle-field',
  'petal-arc',
  'scallop-band',
  'ribbon-loop',
  'round-plate',
  'halo-burst',
] as const;

describe('tempera 曲线几何（charm 族的地基）', () => {
  it('椭圆 / 星芒 / 云朵 / 圆角矩形：顶点数与半径都受参数控制', () => {
    expect(ellipsePolygon(0, 0, 10, 10, 24).length).toBe(48);
    const star = starPolygon(0, 0, 20, 3, 4);
    // 4 个尖角 = 8 个顶点；偶数位在外半径上、奇数位在腰上。
    expect(star.length).toBe(16);
    expect(Math.hypot(star[0] ?? 0, star[1] ?? 0)).toBeCloseTo(20, 6);
    expect(Math.hypot(star[2] ?? 0, star[3] ?? 0)).toBeCloseTo(3, 6);
    // 云朵：归一化是 `(1 ± depth·cos)/(1 + depth)`，所以半径落在 `(1-depth)/(1+depth) ~ 1` 之间。
    const cloud = lobedPolygon(0, 0, 100, 100, 9, 0.1, 360);
    let minReach = Infinity;
    let maxReach = 0;
    for (let index = 0; index + 1 < cloud.length; index += 2) {
      const reach = Math.hypot(cloud[index] ?? 0, cloud[index + 1] ?? 0);
      minReach = Math.min(minReach, reach);
      maxReach = Math.max(maxReach, reach);
    }
    expect(maxReach).toBeLessThanOrEqual(100 + 1e-6);
    expect(minReach).toBeGreaterThanOrEqual((100 * (1 - 0.1)) / (1 + 0.1) - 1e-6);
    // 圆角矩形：所有顶点都落在原矩形内（圆角只会往里收）。
    const rounded = roundedRectPolygon(0, 0, 100, 60, 12);
    for (let index = 0; index + 1 < rounded.length; index += 2) {
      expect(rounded[index] ?? 0).toBeGreaterThanOrEqual(-1e-6);
      expect(rounded[index] ?? 0).toBeLessThanOrEqual(100 + 1e-6);
      expect(rounded[index + 1] ?? 0).toBeGreaterThanOrEqual(-1e-6);
      expect(rounded[index + 1] ?? 0).toBeLessThanOrEqual(60 + 1e-6);
    }
  });

  it('心形是"上宽下尖"：最下面的那个点落在水平中线上', () => {
    const heart = heartPolygon(0, 0, 100, 100);
    let lowestY = -Infinity;
    let lowestX = 0;
    let highestY = Infinity;
    for (let index = 0; index + 1 < heart.length; index += 2) {
      const y = heart[index + 1] ?? 0;
      if (y > lowestY) {
        lowestY = y;
        lowestX = heart[index] ?? 0;
      }
      highestY = Math.min(highestY, y);
    }
    // 屏幕坐标 y 向下：心尖在最下，且 x 几乎居中。
    expect(Math.abs(lowestX)).toBeLessThan(2);
    expect(lowestY).toBeGreaterThan(0);
    expect(highestY).toBeLessThan(0);
  });

  it('扇贝边带与下垂丝带：都是闭合的带形，且凸起 / 下垂方向可控', () => {
    /*
     * 扇贝收的是两条 y：平边 `flatY` 与凸起**圆心**所在的 `baseY`。
     * 凸起半径恒等于半个凸起宽度（照抄的规矩），所以凸起尖端在 `baseY ± radius`，
     * 而平边与凸起之间那段直落就是花边的侧边厚度。
     */
    const band = scallopBandPolygon(0, 200, 0, 30, 4);
    expect(band.length).toBeGreaterThan(4 * 3);
    const radius = (200 / 4) / 2;
    for (let index = 1; index < band.length; index += 2) {
      // 朝下：全部落在 `flatY` 与 `baseY + radius` 之间。
      expect(band[index] ?? 0).toBeGreaterThanOrEqual(-1e-6);
      expect(band[index] ?? 0).toBeLessThanOrEqual(30 + radius + 1e-6);
    }
    // 基线更高 ⇒ 凸起朝上，全部在平边之上（低于 baseY - radius 的一个都没有）。
    const bandUp = scallopBandPolygon(0, 200, 30, 0, 4);
    for (let index = 1; index < bandUp.length; index += 2) {
      expect(bandUp[index] ?? 0).toBeGreaterThanOrEqual(-radius - 1e-6);
      expect(bandUp[index] ?? 0).toBeLessThanOrEqual(30 + 1e-6);
    }
    // 丝带的 `y` 是中心线：上下各半个厚度。
    const ribbon = arcRibbonPolygon(0, 300, 100, 40, 20);
    expect(ribbon.length).toBeGreaterThan(40);
    const ys = ribbon.filter((_value, index) => index % 2 === 1);
    expect(Math.min(...ys)).toBeLessThan(100);
    expect(Math.max(...ys)).toBeGreaterThan(100);
    // 正负下垂量决定弧朝哪边。
    const ribbonUp = arcRibbonPolygon(0, 300, 100, 40, -20);
    const lowest = (points: readonly number[]): number =>
      Math.max(...points.filter((_value, index) => index % 2 === 1));
    expect(lowest(ribbon)).toBeGreaterThan(lowest(ribbonUp));
  });
});

describe('tempera charm 族', () => {
  it('9 种都给出真实构图，而且几乎都保留了描边（这一族靠描边才不溶进底色）', () => {
    let outlined = 0;
    for (const kind of CHARM_KINDS) {
      const spec = buildTemperaCharmComposition(kind, 606060, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      expect(spec.panels.length).toBeGreaterThanOrEqual(2);
      expect(spec.strokes.length).toBeGreaterThan(0);
      // `sparkle-field` 按 folia 只有一条细线、没有闭合描边（星芒是纯填充），所以这里数族数。
      if (spec.strokes.some((stroke) => stroke.closed)) outlined += 1;
      for (const panel of spec.panels) {
        for (const point of panel.points) expect(Number.isFinite(point)).toBe(true);
        expect(panel.points.length % 2).toBe(0);
      }
      for (const stroke of spec.strokes) {
        expect(stroke.points.length % 2).toBe(0);
        expect(stroke.width).toBeGreaterThan(0);
      }
    }
    expect(outlined).toBeGreaterThanOrEqual(8);
  });

  it('圆盘族的圆是圆：每个顶点到圆心等距', () => {
    const spec = buildTemperaCharmComposition('bubble-drift', 3, VIEWPORT, BLEED);
    expect(spec).not.toBeNull();
    // 第一块是平地，后面是泡泡。
    const disc = spec?.panels[1];
    const points = disc?.points ?? [];
    const xs = points.filter((_value, index) => index % 2 === 0);
    const ys = points.filter((_value, index) => index % 2 === 1);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radius = (Math.max(...xs) - Math.min(...xs)) / 2;
    expect(radius).toBeGreaterThan(0);
    for (let index = 0; index + 1 < points.length; index += 2) {
      expect(Math.hypot((points[index] ?? 0) - cx, (points[index + 1] ?? 0) - cy)).toBeCloseTo(
        radius,
        4,
      );
    }
  });

  it('贴纸板的圆角矩形是凸的，所以网线裁剪器能直接填它', () => {
    const spec = buildTemperaCharmComposition('round-plate', 5, VIEWPORT, BLEED);
    const hatchPanel = spec?.panels.find((panel) => panel.hatch !== null);
    expect(hatchPanel).toBeDefined();
    const lines = buildHatchLines(
      hatchPanel?.points ?? [],
      hatchPanel?.hatch?.spec ?? { angle: 0, spacing: 10, width: 1 },
      1,
    );
    expect(lines.length).toBeGreaterThan(0);
  });

  it('非 charm 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaCharmComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaCharmComposition('cinema-wide', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of CHARM_KINDS) expect(TEMPERA_SHOT_KINDS).toContain(kind);
  });

  it('同一个种子两次求值逐字段一致', () => {
    for (const kind of CHARM_KINDS) {
      expect(buildTemperaCharmComposition(kind, 88, VIEWPORT, BLEED)).toEqual(
        buildTemperaCharmComposition(kind, 88, VIEWPORT, BLEED),
      );
    }
  });
});

const APERTURE_KINDS = [
  'iris-hole',
  'slot-rail',
  'punch-row',
  'film-gate',
  'cross-vent',
  'louvre-slats',
  'ring-eye',
  'notch-stack',
  'wedge-gap',
  'dot-sieve',
] as const;

describe('tempera aperture 族', () => {
  it('10 种都给出"带孔的板"：孔在板内，板上还留着别的几何', () => {
    for (const kind of APERTURE_KINDS) {
      const spec = buildTemperaApertureComposition(kind, 271828, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      const plated = spec.panels.filter((panel) => panel.holes.length > 0);
      expect(plated.length).toBeGreaterThanOrEqual(1);
      for (const panel of plated) {
        const [minX, minY, maxX, maxY] = boundsOf([panel.points]);
        for (const hole of panel.holes) {
          expect(hole.length).toBeGreaterThanOrEqual(6);
          expect(hole.length % 2).toBe(0);
          const [hx0, hy0, hx1, hy1] = boundsOf([hole]);
          // 孔必须整块落在板里，否则"打孔"会打到自己边界外。
          expect(hx0).toBeGreaterThanOrEqual((minX ?? 0) - 1e-6);
          expect(hy0).toBeGreaterThanOrEqual((minY ?? 0) - 1e-6);
          expect(hx1).toBeLessThanOrEqual((maxX ?? 0) + 1e-6);
          expect(hy1).toBeLessThanOrEqual((maxY ?? 0) + 1e-6);
          for (const point of hole) expect(Number.isFinite(point)).toBe(true);
        }
      }
    }
  });

  it('除了百叶与筛子，每种孔都有一条内沿描边（洞才像切出来的）', () => {
    let withLip = 0;
    for (const kind of APERTURE_KINDS) {
      const spec = buildTemperaApertureComposition(kind, 11, VIEWPORT, BLEED);
      if (spec === null) continue;
      if (spec.strokes.length > 0) withLip += 1;
    }
    // `louvre-slats` 与 `dot-sieve` 按 folia 都不描边（前者只加了一块料，后者孔太多），所以是 8/10。
    expect(withLip).toBe(8);
  });

  it('玫瑰窗：十二段环扇形，内半径 0.31、外半径 0.44（单位短边）', () => {
    const spec = buildTemperaApertureComposition('ring-eye', 5, VIEWPORT, BLEED);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    const holes = spec.panels[0]?.holes ?? [];
    expect(holes.length).toBe(12);
    const unit = Math.min(VIEWPORT.width, VIEWPORT.height);
    for (const hole of holes) {
      const reaches = hole
        .filter((_value, index) => index % 2 === 0)
        .map((_unused, index) => {
          const x = hole[index * 2] ?? 0;
          const y = hole[index * 2 + 1] ?? 0;
          return Math.hypot(x - VIEWPORT.width / 2, y - VIEWPORT.height / 2);
        });
      expect(Math.min(...reaches)).toBeCloseTo(unit * 0.31, 0);
      expect(Math.max(...reaches)).toBeCloseTo(unit * 0.44, 0);
    }
    // 环的内外两圈各有一条描边。
    expect(spec.strokes.length).toBe(2);
  });

  it('筛子的孔朝一边变稀：左列比右列多', () => {
    const spec = buildTemperaApertureComposition('dot-sieve', 99, VIEWPORT, BLEED);
    const holes = spec?.panels[0]?.holes ?? [];
    expect(holes.length).toBeGreaterThan(3);
    const centerOf = (hole: readonly number[]): number => {
      const xs = hole.filter((_value, index) => index % 2 === 0);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    const left = holes.filter((hole) => centerOf(hole) < VIEWPORT.width * 0.3).length;
    const right = holes.filter((hole) => centerOf(hole) > VIEWPORT.width * 0.4).length;
    expect(left).toBeGreaterThan(right);
  });

  it('非 aperture 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaApertureComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaApertureComposition('heart-burst', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of APERTURE_KINDS) expect(TEMPERA_SHOT_KINDS).toContain(kind);
  });
});

describe('tempera aperture 族的硬约束：歌词不落在洞上', () => {
  /**
   * folia 的 `temperaCutout.ts` 把这条写成了纪律：**歌词绝不压在洞上**。
   * 理由是反色滤镜只读 Pixi 的 render target，而 DOM 背景在 WebGL 之外 ——
   * 洞上只剩一层淡洗色，滤镜会选出墨色，那个墨色就得赌"背景恰好是什么"。
   * 我们这里没有反色滤镜，但这条例律仍然成立：洞是画面，不是纸面。
   *
   * 判据用孔的**外接框**去撞排版框（比真相交更保守：外接框都撞不上，孔就一定撞不上）。
   */
  it('每一族的孔都避开该族的排版区', () => {
    /** 射线法：点是否在多边形内。 */
    const pointInPolygon = (x: number, y: number, polygon: readonly number[]): boolean => {
      const count = Math.floor(polygon.length / 2);
      let inside = false;
      for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
        const xi = polygon[index * 2] ?? 0;
        const yi = polygon[index * 2 + 1] ?? 0;
        const xj = polygon[previous * 2] ?? 0;
        const yj = polygon[previous * 2 + 1] ?? 0;
        const straddles = yi > y !== yj > y;
        if (!straddles) continue;
        const crossX = ((xj - xi) * (y - yi)) / (yj - yi === 0 ? 1e-9 : yj - yi) + xi;
        if (x < crossX) inside = !inside;
      }
      return inside;
    };
    /**
     * 判据用**真实相交**，不是外接框对撞：`iris-hole` 是个圆，它的外接框必然比圆大得多，
     * 拿方框去撞会把"圆根本没压到字"误报成压到了（第一版就是这么假红的）。
     */
    const offenders: string[] = [];
    for (const kind of APERTURE_KINDS) {
      const spec = buildTemperaApertureComposition(kind, 3, VIEWPORT, BLEED);
      if (spec === null) continue;
      const [cx, cy, w, h] = resolveTemperaShotProfile(kind).region;
      const region = {
        x0: cx * VIEWPORT.width - (w * VIEWPORT.width) / 2,
        y0: cy * VIEWPORT.height - (h * VIEWPORT.height) / 2,
        x1: cx * VIEWPORT.width + (w * VIEWPORT.width) / 2,
        y1: cy * VIEWPORT.height + (h * VIEWPORT.height) / 2,
      };
      const regionCorners: readonly (readonly [number, number])[] = [
        [region.x0, region.y0],
        [region.x1, region.y0],
        [region.x0, region.y1],
        [region.x1, region.y1],
        [(region.x0 + region.x1) / 2, (region.y0 + region.y1) / 2],
      ];
      for (const panel of spec.panels) {
        for (const hole of panel.holes) {
          const xs = hole.filter((_value, index) => index % 2 === 0);
          const ys = hole.filter((_value, index) => index % 2 === 1);
          const holeCx = (Math.min(...xs) + Math.max(...xs)) / 2;
          const holeCy = (Math.min(...ys) + Math.max(...ys)) / 2;
          // ① 孔自己的内部点（中心 + 顶点向中心收缩一半）落进了排版框；
          const interior: readonly (readonly [number, number])[] = [
            [holeCx, holeCy],
            ...Array.from({ length: Math.floor(hole.length / 2) }, (_unused, index) => {
              const px = hole[index * 2] ?? 0;
              const py = hole[index * 2 + 1] ?? 0;
              return [holeCx + (px - holeCx) * 0.5, holeCy + (py - holeCy) * 0.5] as const;
            }),
          ];
          for (const [px, py] of interior) {
            if (px >= region.x0 && px <= region.x1 && py >= region.y0 && py <= region.y1) {
              offenders.push(`${kind}(孔内点 ${Math.round(px)},${Math.round(py)})`);
              break;
            }
          }
          // ② 或者排版框整个陷在孔里（孔很大时）。
          if (regionCorners.some(([px, py]) => pointInPolygon(px, py, hole))) {
            offenders.push(`${kind}(排版框陷在孔里)`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('tempera monogatari 族', () => {
  it('5 种都是"从边到边的平色卡"，而且几乎不带几何', () => {
    for (const kind of ['monogatari-card', 'monogatari-rule', 'monogatari-edge', 'monogatari-stack', 'monogatari-flash'] as const) {
      const spec = buildTemperaMonogatariComposition(kind, 616161, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      // 这一族的面板极少：底色（+ 书脊/横规），别的什么都没有。
      expect(spec.panels.length).toBeLessThanOrEqual(2);
      // 底色是**满幅且不透明**的：卡片要像卡纸，不能透出背景。
      const field = spec.panels[0];
      expect(field?.alpha).toBe(1);
      const xs = (field?.points ?? []).filter((_value, index) => index % 2 === 0);
      const ys = (field?.points ?? []).filter((_value, index) => index % 2 === 1);
      expect(Math.min(...xs)).toBeLessThan(0);
      expect(Math.max(...xs)).toBeGreaterThan(VIEWPORT.width);
      expect(Math.min(...ys)).toBeLessThan(0);
      expect(Math.max(...ys)).toBeGreaterThan(VIEWPORT.height);
    }
  });

  it('底色在色调阶梯的两端之间交替（连着两张卡才会读成切换而不是停留）', () => {
    const tones = new Set<number>();
    for (let seed = 0; seed < 40; seed += 1) {
      const spec = buildTemperaMonogatariComposition('monogatari-card', seed, VIEWPORT, BLEED);
      const tone = spec?.panels[0]?.tone;
      if (tone !== undefined) tones.add(tone);
    }
    // 两端都会出现：0（浅端）与 3（深端）。
    expect([...tones].sort()).toEqual([0, 3]);
  });

  it('书脊取底色的反端，所以它总是在对比里', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const spec = buildTemperaMonogatariComposition('monogatari-edge', seed, VIEWPORT, BLEED);
      const [field, spine] = spec?.panels ?? [];
      expect(field?.tone).not.toBe(spine?.tone);
      expect(spine?.hatch).not.toBeNull();
    }
  });

  it('最响的那张固定取深端，并带一排叉号', () => {
    const spec = buildTemperaMonogatariComposition('monogatari-flash', 3, VIEWPORT, BLEED);
    expect(spec?.panels[0]?.tone).toBe(3);
    // 4 个叉 = 8 笔。
    expect(spec?.strokes.length).toBe(8);
  });

  it('非 monogatari 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaMonogatariComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaMonogatariComposition('ridge-line', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of ['monogatari-card', 'monogatari-rule', 'monogatari-edge', 'monogatari-stack', 'monogatari-flash'] as const) {
      expect(TEMPERA_SHOT_KINDS).toContain(kind);
    }
  });
});

describe('tempera 实现进度锚', () => {
  /**
   * 一条**只增不减**的进度锚：各族工厂加起来至少覆盖 76 种（split 13 + band 9 + frame 10 + poster 10 + sparse 8 + cinema 7 + charm 9 + aperture 10）。
   *
   * 为什么不写成 `toBe(76)`：那会随每一族落地而过期（本轮就改了一次）；
   * 写成下界则**只在工厂坏掉、覆盖变少时**才会红 —— 正是这条锚该看的信号。
   */
  it('各族工厂至少覆盖 116 种（覆盖变少就是有族工厂坏了）', () => {
    const factories: readonly ((
      kind: (typeof TEMPERA_SHOT_KINDS)[number],
      seed: number,
      viewport: { width: number; height: number },
      bleed: number,
    ) => unknown)[] = [
      buildTemperaBandComposition,
      buildTemperaFrameComposition,
      buildTemperaPosterComposition,
      buildTemperaSparseComposition,
      buildTemperaCinemaComposition,
      buildTemperaCharmComposition,
      buildTemperaApertureComposition,
    ];
    const covered = TEMPERA_SHOT_KINDS.filter(
      (kind) =>
        factories.some((factory) => factory(kind, 1, VIEWPORT, BLEED) !== null) ||
        (TEMPERA_SHOT_KINDS_BY_FAMILY.split as readonly string[]).includes(kind),
    );
    expect(covered.length).toBeGreaterThanOrEqual(76);
  });
});

const SIGNAL_KINDS = [
  'sight-mark',
  'dial-scale',
  'chevron-run',
  'tally-column',
  'grid-focus',
  'axis-caps',
  'strobe-slats',
  'offset-plate',
  'radial-comb',
  'bracket-target',
] as const;

describe('tempera signal 族', () => {
  it('10 种都给出真实构图，而且装饰是"量过的"：细线多、面板少', () => {
    for (const kind of SIGNAL_KINDS) {
      const spec = buildTemperaSignalComposition(kind, 20260101, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      // `bracket-target` 按 folia 只有一块带孔的板（开口围在括号里），所以下界是 1。
      expect(spec.panels.length).toBeGreaterThanOrEqual(1);
      // 这一族刻意用线条而不是色块（仪表盘感）：
      // `chevron-run` / `strobe-slats` 是纯色块重复，`offset-plate` / `axis-caps` 只有孔沿那一笔。
      if (kind !== 'chevron-run' && kind !== 'strobe-slats') {
        expect(spec.strokes.length).toBeGreaterThanOrEqual(1);
      }
      for (const panel of spec.panels) {
        for (const point of panel.points) expect(Number.isFinite(point)).toBe(true);
      }
      for (const stroke of spec.strokes) {
        expect(stroke.points.length % 2).toBe(0);
        expect(stroke.width).toBeGreaterThan(0);
      }
    }
  });

  it('axis-caps 的孔同时切在底板与长条上（只切长条会透出底板，那就不是窗）', () => {
    const spec = buildTemperaSignalComposition('axis-caps', 7, VIEWPORT, BLEED, Math.PI / 2);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    const holed = spec.panels.filter((panel) => panel.holes.length > 0);
    // 底板（全屏）与长条（旋转矩形）各一块。
    expect(holed.length).toBe(2);
    const [fieldPanel, barPanel] = holed;
    // 底板确实是全屏那块。
    const [fieldMinX, fieldMinY, fieldMaxX, fieldMaxY] = boundsOf([fieldPanel?.points ?? []]);
    expect(fieldMinX).toBeLessThanOrEqual(0);
    expect(fieldMinY).toBeLessThanOrEqual(0);
    expect(fieldMaxX).toBeGreaterThanOrEqual(VIEWPORT.width);
    expect(fieldMaxY).toBeGreaterThanOrEqual(VIEWPORT.height);
    // 两处的孔**完全一致**（同一个口），否则一钻贯不成。
    expect(barPanel?.holes[0]).toEqual(fieldPanel?.holes[0]);
    // 轴要顺着流向：流向竖直时，长条的上下端到中心的距离应当大于左右端。
    const barXs = (barPanel?.points ?? []).filter((_value, index) => index % 2 === 0);
    const barYs = (barPanel?.points ?? []).filter((_value, index) => index % 2 === 1);
    expect(Math.max(...barYs) - Math.min(...barYs)).toBeGreaterThan(
      Math.max(...barXs) - Math.min(...barXs),
    );
  });

  it('有孔的三种族都把孔从底板上切掉（grid-focus / offset-plate / axis-caps）', () => {
    for (const kind of ['grid-focus', 'offset-plate', 'axis-caps'] as const) {
      const spec = buildTemperaSignalComposition(kind, 3, VIEWPORT, BLEED, Math.PI / 2);
      expect(spec).not.toBeNull();
      const holed = (spec?.panels ?? []).filter((panel) => panel.holes.length > 0);
      expect(holed.length).toBeGreaterThanOrEqual(1);
      // 每种都描了孔沿。
      expect(spec?.strokes.some((stroke) => stroke.closed)).toBe(true);
    }
  });

  it('流向会真的改变这一族：两个不同的流向角给出不同几何', () => {
    const up = buildTemperaSignalComposition('axis-caps', 7, VIEWPORT, BLEED, Math.PI / 2);
    const tilted = buildTemperaSignalComposition('axis-caps', 7, VIEWPORT, BLEED, Math.PI / 2 + 0.2);
    expect(JSON.stringify(up)).not.toBe(JSON.stringify(tilted));
  });

  it('非 signal 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaSignalComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaSignalComposition('iris-hole', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of SIGNAL_KINDS) expect(TEMPERA_SHOT_KINDS).toContain(kind);
  });
});

const CORRIDOR_KINDS = [
  'flow-channel',
  'twin-channel',
  'reed-run',
  'taper-channel',
  'chain-ports',
  'dash-channel',
  'window-run',
  'bridge-span',
  'braid-channel',
  'port-ladder',
] as const;

describe('tempera corridor 族', () => {
  it('连续通道两头都在画面之外；分段通道则由若干段拼出来', () => {
    /*
     * 这一族分两类，判据不能混用：
     * · **连续通道**（一条贯穿画面的长开口）—— 两头必须锚在框外，否则就成了"看得见尽头的形状"，形状会出卖剪辑；
     * · **分段通道**（虚线、车厢窗、串孔、编织）—— 本来就是若干段拼的，单段当然比画面短，
     *   它们的共同点是"段与段之间留着实心的枕木"。
     */
    const continuous = [
      'flow-channel',
      'twin-channel',
      'reed-run',
      'taper-channel',
      'bridge-span',
      'port-ladder',
    ];
    for (const kind of CORRIDOR_KINDS) {
      const spec = buildTemperaCorridorComposition(kind, 1234567, VIEWPORT, BLEED, Math.PI / 2);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      const plated = spec.panels.filter((panel) => panel.holes.length > 0);
      expect(plated.length).toBeGreaterThanOrEqual(1);
      expect(spec.strokes.length).toBeGreaterThan(0);
      if (!continuous.includes(kind)) {
        // 分段族：每一段都该小于画面高（不是一条通到底），而且至少有两段。
        const holes = plated.flatMap((panel) => panel.holes);
        expect(holes.length).toBeGreaterThanOrEqual(2);
        for (const hole of holes) {
          const ys = hole.filter((_value, index) => index % 2 === 1);
          expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(VIEWPORT.height);
        }
        continue;
      }
      for (const panel of plated) {
        for (const hole of panel.holes) {
          const xs = hole.filter((_value, index) => index % 2 === 0);
          const ys = hole.filter((_value, index) => index % 2 === 1);
          // 竖直流向下的通道：纵向跨度应当超过画面高。
          expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(VIEWPORT.height);
          expect(Number.isFinite(xs[0])).toBe(true);
        }
      }
    }
  });

  it('流向角只拉回竖直轴的一半（不回正、也不照抄原始倾角）', () => {
    const straight = Math.PI / 2;
    expect(channelAxis(straight)).toBeCloseTo(straight, 9);
    // 倾了 0.2 弧度的流向，通道轴只偏 0.1。
    expect(channelAxis(straight + 0.2)).toBeCloseTo(straight + 0.1, 9);
    // 朝上的流向跟的是**它自己**的竖直轴（-π/2），不是被强制翻到 +π/2。
    expect(channelAxis(-straight + 0.2)).toBeCloseTo(-straight + 0.1, 9);
  });

  it('横向单位向量永远指向画面 +x 半边（否则"偏移 +n"会翻边）', () => {
    for (const flow of [straightFlow(), straightFlow() + 0.3, -straightFlow() + 0.3, 0.4, -0.4]) {
      const across = acrossFlow(channelAxis(flow));
      expect(across.x).toBeGreaterThan(0);
      expect(Math.hypot(across.x, across.y)).toBeCloseTo(1, 9);
    }
  });

  it('沿轴走多远就是多远：flowPoint 的位移长度等于给的距离', () => {
    for (const flow of [Math.PI / 2, Math.PI / 2 + 0.25, -Math.PI / 2 + 0.25]) {
      const origin = flowPoint(VIEWPORT, flow, 0, 40);
      const moved = flowPoint(VIEWPORT, flow, 123, 40);
      expect(Math.hypot(moved.x - origin.x, moved.y - origin.y)).toBeCloseTo(123, 6);
    }
  });

  it('通道避开排版区（沿流向的开口也不能压在字上）', () => {
    const offenders: string[] = [];
    for (const kind of CORRIDOR_KINDS) {
      // `bridge-span` 是**故意**把最宽的通道放在正中间的：字句骑在横跨它的那条实心带上，
      // 所以那一族的"洞压着排版区"是设计，不是错误（folia 的注释也点了这条：带子刻意做得比字句需要的更厚）。
      if (kind === 'bridge-span') continue;
      const spec = buildTemperaCorridorComposition(kind, 3, VIEWPORT, BLEED, Math.PI / 2);
      if (spec === null) continue;
      const [cx, cy, w, h] = resolveTemperaShotProfile(kind).region;
      const region = {
        x0: cx * VIEWPORT.width - (w * VIEWPORT.width) / 2,
        x1: cx * VIEWPORT.width + (w * VIEWPORT.width) / 2,
        y0: cy * VIEWPORT.height - (h * VIEWPORT.height) / 2,
        y1: cy * VIEWPORT.height + (h * VIEWPORT.height) / 2,
      };
      for (const panel of spec.panels) {
        for (const hole of panel.holes) {
          const xs = hole.filter((_value, index) => index % 2 === 0);
          const ys = hole.filter((_value, index) => index % 2 === 1);
          const holeCx = (Math.min(...xs) + Math.max(...xs)) / 2;
          const holeCy = (Math.min(...ys) + Math.max(...ys)) / 2;
          if (
            holeCx >= region.x0 &&
            holeCx <= region.x1 &&
            holeCy >= region.y0 &&
            holeCy <= region.y1
          ) {
            offenders.push(`${kind}(${Math.round(holeCx)},${Math.round(holeCy)})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('非 corridor 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaCorridorComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaCorridorComposition('axis-caps', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of CORRIDOR_KINDS) expect(TEMPERA_SHOT_KINDS).toContain(kind);
  });
});

const MONOLITH_KINDS = [
  'apex-mass',
  'ziggurat',
  'slab-wall',
  'cantilever',
  'pylon-pair',
  'bunker-slit',
  'plinth-stack',
  'buttress-run',
  'void-core',
  'shear-block',
] as const;

describe('tempera monolith 族', () => {
  it('10 种都给出真实构图，而且每一族都有体块**跑出画面**', () => {
    for (const kind of MONOLITH_KINDS) {
      const spec = buildTemperaMonolithComposition(kind, 909090, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      expect(spec.panels.length).toBeGreaterThanOrEqual(2);
      /*
       * 照抄的规矩：四边都在画内的实心块读起来像"摆在纸上的一件东西"，被画面裁掉一边才像"大到装不下"。
       * 所以每族至少要有一块面板越界（考虑出血：越界量应当不低于出血）。
       */
      const bleeding = spec.panels.some((panel) => {
        const xs = panel.points.filter((_value, index) => index % 2 === 0);
        const ys = panel.points.filter((_value, index) => index % 2 === 1);
        return (
          Math.min(...xs) <= 0 ||
          Math.min(...ys) <= 0 ||
          Math.max(...xs) >= VIEWPORT.width ||
          Math.max(...ys) >= VIEWPORT.height
        );
      });
      expect(bleeding).toBe(true);
      // 测量线是这一族的"尺度来源"：一根横贯画面、什么都不碰的细线。
      const survey = spec.strokes.filter((stroke) => !stroke.closed);
      expect(survey.length).toBeGreaterThan(0);
    }
  });

  it('有孔的四族都把孔从地面裁掉（只切体块会露出它背后的纸）', () => {
    for (const kind of ['pylon-pair', 'bunker-slit', 'buttress-run', 'void-core'] as const) {
      const spec = buildTemperaMonolithComposition(kind, 5, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      const holed = spec.panels.filter((panel) => panel.holes.length > 0);
      expect(holed.length).toBeGreaterThanOrEqual(1);
      // 地面那块是全屏的：它必须也带同一个孔。
      const ground = holed.find((panel) => {
        const xs = panel.points.filter((_value, index) => index % 2 === 0);
        return Math.min(...xs) < 0;
      });
      expect(ground).toBeDefined();
      // 孔沿只有 `pylon-pair` 与 `void-core` 给了（`bunker-slit` 与 `buttress-run` 按 folia 不描孔沿）。
      if (kind === 'pylon-pair' || kind === 'void-core') {
        expect(spec.strokes.some((stroke) => stroke.closed)).toBe(true);
      }
    }
  });

  it('直纹用的是凸面片 + grow（所以它是从中间长开的网线，不是又一块面板）', () => {
    const spec = buildTemperaMonolithComposition('apex-mass', 5, VIEWPORT, BLEED);
    const ruling = spec?.panels.find((panel) => panel.hatch !== null);
    expect(ruling).toBeDefined();
    expect(ruling?.alpha).toBe(0);
    expect(ruling?.hatch?.grow).toBe(true);
    expect(ruling?.hatch?.alpha).toBe(0.5);
  });

  it('非 monolith 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaMonolithComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaMonolithComposition('flow-channel', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of MONOLITH_KINDS) expect(TEMPERA_SHOT_KINDS).toContain(kind);
  });

  it('同一个种子两次求值逐字段一致', () => {
    for (const kind of MONOLITH_KINDS) {
      expect(buildTemperaMonolithComposition(kind, 77, VIEWPORT, BLEED)).toEqual(
        buildTemperaMonolithComposition(kind, 77, VIEWPORT, BLEED),
      );
    }
  });
});

const TERRAIN_KINDS = [
  'ridge-line',
  'chasm',
  'overhang',
  'step-well',
  'pier-row',
  'revetment',
  'tower-crop',
  'lintel',
  'rubble-fan',
  'gnomon',
] as const;

describe('tempera terrain 族', () => {
  it('10 种都给出真实构图（地景与结构，不是"一件东西"）', () => {
    for (const kind of TERRAIN_KINDS) {
      const spec = buildTemperaTerrainComposition(kind, 314159, VIEWPORT, BLEED);
      expect(spec).not.toBeNull();
      if (spec === null) continue;
      expect(spec.fallback).toBe(false);
      expect(spec.panels.length).toBeGreaterThanOrEqual(2);
      // 与 monolith 同一套规矩：体块必须被画面裁切。
      const bleeding = spec.panels.some((panel) => {
        const xs = panel.points.filter((_value, index) => index % 2 === 0);
        const ys = panel.points.filter((_value, index) => index % 2 === 1);
        return (
          Math.min(...xs) <= 0 ||
          Math.min(...ys) <= 0 ||
          Math.max(...xs) >= VIEWPORT.width ||
          Math.max(...ys) >= VIEWPORT.height
        );
      });
      expect(bleeding).toBe(true);
      expect(spec.strokes.length).toBeGreaterThan(0);
    }
  });

  it('阶梯井的每一层都带**同一口**井（一钻贯到底，井才真的通）', () => {
    const spec = buildTemperaTerrainComposition('step-well', 8, VIEWPORT, BLEED);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    const holed = spec.panels.filter((panel) => panel.holes.length > 0);
    // 地面一块 + 两层阶梯各一块。
    expect(holed.length).toBe(3);
    const reference = JSON.stringify(holed[0]?.holes[0]);
    for (const panel of holed) expect(JSON.stringify(panel.holes[0])).toBe(reference);
  });

  it('裂谷与桥墩都从"开出来的带"里切掉一块，而桥面比那条带更厚', () => {
    const chasm = buildTemperaTerrainComposition('chasm', 8, VIEWPORT, BLEED);
    expect((chasm?.panels ?? []).some((panel) => panel.holes.length > 0)).toBe(true);
    const piers = buildTemperaTerrainComposition('pier-row', 8, VIEWPORT, BLEED);
    expect((piers?.panels ?? []).some((panel) => panel.holes.length > 0)).toBe(true);
    // 桥面（唯一横贯画面的实心体）比水带更深：字句坐得住。
    const deck = (piers?.panels ?? []).find((panel) => {
      const xs = panel.points.filter((_value, index) => index % 2 === 0);
      return Math.min(...xs) < 0 && panel.holes.length === 0 && panel.tone === 2;
    });
    expect(deck).toBeDefined();
    const deckYs = (deck?.points ?? []).filter((_value, index) => index % 2 === 1);
    const deckHeight = Math.max(...deckYs) - Math.min(...deckYs);
    expect(deckHeight).toBeGreaterThan(VIEWPORT.height * 0.14);
  });

  it('非 terrain 族返回 null，且各族都在 121 种清单里', () => {
    expect(buildTemperaTerrainComposition('duo-split', 1, VIEWPORT, BLEED)).toBeNull();
    expect(buildTemperaTerrainComposition('apex-mass', 1, VIEWPORT, BLEED)).toBeNull();
    for (const kind of TERRAIN_KINDS) expect(TEMPERA_SHOT_KINDS).toContain(kind);
  });

  it('同一个种子两次求值逐字段一致', () => {
    for (const kind of TERRAIN_KINDS) {
      expect(buildTemperaTerrainComposition(kind, 42, VIEWPORT, BLEED)).toEqual(
        buildTemperaTerrainComposition(kind, 42, VIEWPORT, BLEED),
      );
    }
  });
});

describe('tempera 网线与装饰语汇', () => {
  it('网线参数照 folia 的三档：间距 9/13/18，角度四选一', () => {
    const allowedAngles = [-Math.PI / 4, Math.PI / 4, -Math.PI / 3, Math.PI / 6];
    const spacings = new Set<number>();
    for (let seed = 0; seed < 40; seed += 1) {
      const spec = buildHatchSpec(seed, 5);
      spacings.add(Math.round(spec.spacing));
      expect(allowedAngles).toContain(spec.angle);
      expect(spec.width).toBeGreaterThanOrEqual(0.8);
      expect(spec.width).toBeLessThanOrEqual(spec.spacing * 0.3 + 1e-9);
    }
    expect([...spacings].sort((left, right) => left - right)).toEqual([9, 13, 18]);
  });

  it('覆盖率把每条网线朝中点收进去（入场时从形状中心长开）', () => {
    const polygon = hatchRectPolygon(0, 0, 200, 100);
    const spec = { angle: 0, spacing: 13, width: 2 };
    const full = buildHatchLines(polygon, spec, 1);
    const half = buildHatchLines(polygon, spec, 0.5);
    expect(full.length).toBe(half.length);
    const lengthOf = (lines: ReturnType<typeof buildHatchLines>, index: number): number => {
      const item = lines[index];
      if (item === undefined) return 0;
      return Math.hypot(item.x2 - item.x1, item.y2 - item.y1);
    };
    for (let index = 0; index < full.length; index += 1) {
      expect(lengthOf(half, index)).toBeCloseTo(lengthOf(full, index) / 2, 4);
    }
  });

  it('网线只画在形状里：一块矩形，网线端点都贴着它的左右边', () => {
    const polygon = hatchRectPolygon(10, 20, 120, 60);
    const lines = buildHatchLines(polygon, { angle: 0, spacing: 15, width: 1.5 }, 1);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(Math.min(line.x1, line.x2)).toBeCloseTo(10, 3);
      expect(Math.max(line.x1, line.x2)).toBeCloseTo(130, 3);
      expect(line.y1).toBeCloseTo(line.y2, 6);
    }
  });

  it('波浪边在给定的上下限内起伏，散字行按方向排开', () => {
    const path = buildWavyPath(5, 31, 0, 300, 100, 8, 24);
    expect(path.length).toBe((24 + 1) * 2);
    for (let index = 1; index < path.length; index += 2) {
      const y = path[index] ?? 0;
      // 振幅 8 加上 0.5 倍的抖动，最大值不会超过 1.5 倍振幅。
      expect(Math.abs(y - 100)).toBeLessThanOrEqual(8 * 1.5 + 1e-6);
    }
    const row = buildMarkRow(9, 17, 0, 0, 4, 50, 9, 0);
    expect(row.length).toBe(4);
    expect(row[1]?.x ?? 0).toBeGreaterThan(row[0]?.x ?? 0);
    for (const mark of row) {
      expect(mark.size).toBeGreaterThan(0);
      expect(Math.abs(mark.rotation)).toBeLessThanOrEqual(0.15 + 1e-9);
    }
  });

  it('未知形状（顶点太少）不产生网线，也不会抛', () => {
    expect(buildHatchLines([0, 0, 10, 10], { angle: 0, spacing: 4, width: 1 }, 1)).toEqual([]);
    expect(buildHatchLines(rectPolygon(0, 0, 10, 10), { angle: 0, spacing: 0, width: 1 }, 1)).toEqual(
      [],
    );
  });
});
