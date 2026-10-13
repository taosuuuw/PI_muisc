/**
 * 商籁**镜头取景约束**的用例。
 *
 * 全部手算：**硬安全区** = 视口去掉左右 5% / 上下 6% ⇒ 1000×600 的视口上就是
 * `x ∈ [50, 950]`、`y ∈ [36, 564]`（正好 900 × 528 ✓）；
 * **运动保留区** = 安全区再各收 6% ⇒ `x ∈ [110, 890]`、`y ∈ [72, 528]`（780 × 456 = 78% × 76% 画面 ✓）。
 * 相机口径与渲染层一致：屏幕 = `(宽×(0.5+x), 高×(0.48+y)) + R(旋转)·(zoom·(局部 − pivot))`。
 *
 * ⚠ 最常错的一处：**锚点转完不是正文中心**。正文中心相对轴心的偏移会被旋转带到别处，
 * 所以"这一块该停哪儿"必须按正文中心算（`frameSonnetCameraToBody` 已如此）。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_FRAMING_MARGIN_X,
  SONNET_FRAMING_MARGIN_Y,
  SONNET_FRAMING_MOTION_MARGIN_X,
  SONNET_FRAMING_MOTION_MARGIN_Y,
  SONNET_FRAMING_SOFT_BAND_RATIO,
  createSonnetCameraFramer,
  frameSonnetCameraToBody,
  resolveSonnetBodyBounds,
  softClamp,
  type SonnetFramingBox,
  type SonnetFramingGlyph,
} from './sonnetCameraFraming';

const VIEWPORT = { viewportWidth: 1000, viewportHeight: 600 } as const;
/** 硬安全区（1000×600）：左右 50、上下 36 ⇒ x ∈ [50,950]、y ∈ [36,564] ✓。 */
const SAFE = { minX: 50, minY: 36, maxX: 950, maxY: 564 } as const;
/** 运动保留区：安全区再各收 6% ⇒ x ∈ [110,890]、y ∈ [72,528] ✓。 */
const RESERVE = { minX: 110, minY: 72, maxX: 890, maxY: 528 } as const;

/** 量宽 = 每字 100px（固定，便于手算）。 */
const measure100 = (): number => 100;
/** 一个落在 (x,y) 的孤字：半宽 50、半高 `100 × 1.05 / 2 = 52.5`（无旋转、scale 1）✓。 */
const glyphAt = (x: number, y: number, overrides: Partial<SonnetFramingGlyph> = {}): SonnetFramingGlyph => ({
  x,
  y,
  fontPx: 100,
  rotation: 0,
  scale: 1,
  text: '字',
  weight: 700,
  ...overrides,
});

const inside = (box: SonnetFramingBox): boolean =>
  box.minX >= SAFE.minX - 1e-3 &&
  box.maxX <= SAFE.maxX + 1e-3 &&
  box.minY >= SAFE.minY - 1e-3 &&
  box.maxY <= SAFE.maxY + 1e-3;

/** 正文四周离**硬安全区**边界的最近距离（> 0 = 四边都没贴边，还有摇移余地）。 */
const minMargin = (box: SonnetFramingBox): number =>
  Math.min(
    box.minX - SAFE.minX,
    SAFE.maxX - box.maxX,
    box.minY - SAFE.minY,
    SAFE.maxY - box.maxY,
  );

const insideReserve = (box: SonnetFramingBox): boolean =>
  box.minX >= RESERVE.minX - 1e-6 &&
  box.maxX <= RESERVE.maxX + 1e-6 &&
  box.minY >= RESERVE.minY - 1e-6 &&
  box.maxY <= RESERVE.maxY + 1e-6;

/** 半宽 400 / 半高 300 的正文（800×600，比安全区的 900×528 高）。 */
const spanning = (): SonnetFramingBox => ({ minX: -400, minY: -300, maxX: 400, maxY: 300 });

describe('商籁取景：正文落位范围', () => {
  it('单字：中心 ± (量宽/2, 字号×1.05/2)', () => {
    expect(resolveSonnetBodyBounds([glyphAt(300, 200)], measure100)).toEqual({
      minX: 250,
      minY: 147.5,
      maxX: 350,
      maxY: 252.5,
    });
  });

  it('量不到宽（NaN）⇒ 退回 0.62 × 字号，不会把字算成零宽', () => {
    const bounds = resolveSonnetBodyBounds([glyphAt(0, 0)], () => Number.NaN);
    expect(bounds?.maxX).toBeCloseTo(31, 6);
    expect(bounds?.maxY).toBeCloseTo(52.5, 6);
  });

  it('字身旋转会撑大范围（90° ⇒ 宽高互换）', () => {
    const bounds = resolveSonnetBodyBounds([glyphAt(0, 0, { rotation: Math.PI / 2 })], measure100);
    expect(bounds?.maxX).toBeCloseTo(52.5, 6);
    expect(bounds?.maxY).toBeCloseTo(50, 6);
  });

  it('入场期间的缩小（scale < 1）不缩范围：量的是落位尺寸 ✓', () => {
    const entered = resolveSonnetBodyBounds([glyphAt(0, 0, { scale: 0.86 })], measure100);
    expect(entered).toEqual(resolveSonnetBodyBounds([glyphAt(0, 0, { scale: 1 })], measure100));
  });

  it('空数组 / 字号非法 ⇒ null（渲染层据此不施加约束）', () => {
    expect(resolveSonnetBodyBounds([], measure100)).toBeNull();
    expect(resolveSonnetBodyBounds([glyphAt(0, 0, { fontPx: 0 })], measure100)).toBeNull();
  });
});

describe('商籁取景：落位旋转与落位尺寸（不跟入场抽动）', () => {
  it('layoutRotation 优先：入场 rotation 怎么转都不改范围', () => {
    const settled = resolveSonnetBodyBounds(
      [glyphAt(0, 0, { rotation: 0, layoutRotation: 0 })],
      measure100,
    );
    const entering = resolveSonnetBodyBounds(
      [glyphAt(0, 0, { rotation: Math.PI / 2, layoutRotation: 0 })],
      measure100,
    );
    expect(entering).toEqual(settled);
    expect(settled?.maxX).toBeCloseTo(50, 6);
    expect(settled?.maxY).toBeCloseTo(52.5, 6);
  });

  it('没有 layoutRotation 时才退回 rotation（兼容旧调用）', () => {
    const bounds = resolveSonnetBodyBounds([glyphAt(0, 0, { rotation: Math.PI / 2 })], measure100);
    expect(bounds?.maxX).toBeCloseTo(52.5, 6);
    expect(bounds?.maxY).toBeCloseTo(50, 6);
  });

  it('scale（含 > 1 的过冲）不参与落位：一律按 1 量', () => {
    const settled = resolveSonnetBodyBounds([glyphAt(0, 0, { scale: 1 })], measure100);
    expect(resolveSonnetBodyBounds([glyphAt(0, 0, { scale: 1.4 })], measure100)).toEqual(settled);
    expect(resolveSonnetBodyBounds([glyphAt(0, 0, { scale: 0.86 })], measure100)).toEqual(settled);
  });
});

describe('商籁取景：非中心 pivot + 旋转 + 平移', () => {
  it('pivot（100,500）在画面左下、旋转 0.2 rad：四个角仍落进安全区', () => {
    /* 轴心离正文很远 ⇒ 旋转 + 缩放先把它甩出画外；取景必须量"转完之后的四角"才拦得住 ✓ */
    const result = frameSonnetCameraToBody(
      { x: 0.35, y: 0, zoom: 1, rotation: 0.2 },
      { ...VIEWPORT, pivotX: 100, pivotY: 500, bodyBounds: spanning() },
    );
    expect(inside(result.bodyScreen)).toBe(true);
    /* 旋转后真正需要的半宽 ≈ 451.7 / 半高 ≈ 373.6（超过保留区 390×228）⇒ 只会温和拉远，不会放大 ✓ */
    expect(result.zoomRatio).toBeLessThanOrEqual(1);
    expect(result.camera.zoom).toBeLessThanOrEqual(1);
    expect(result.camera.rotation).toBe(0.2);
    expect(result.bodyScreen.minX).toBeCloseTo(398.597356420747, 6);
    expect(result.bodyScreen.minY).toBeCloseTo(36, 4);
    expect(result.bodyScreen.maxX).toBeCloseTo(950, 4);
    expect(result.bodyScreen.maxY).toBeCloseTo(492, 4);
  });

  it('pivot 远离正文中心、正文被推到右边：平移只做**软饱和**的那一点点，纵向仍夹到边线', () => {
    /* 正文 (-150,-100)~(150,100)，pivot（500,300）：正文中心相对轴心偏 (−500,−300) ⇒
       相机 x=0.26 把它推到屏幕 500+260−500 = 260 ✓ */
    const body: SonnetFramingBox = { minX: -150, minY: -100, maxX: 150, maxY: 100 };
    const result = frameSonnetCameraToBody(
      { x: 0.26, y: 0, zoom: 1, rotation: 0 },
      { ...VIEWPORT, pivotX: 500, pivotY: 300, bodyBounds: body },
    );
    expect(result.adjusted).toBe(true);
    expect(result.camera.zoom).toBe(1);
    expect(result.camera.rotation).toBe(0);
    /*
     * 半宽 150、可用区 [50,950] ⇒ 中心可落在 [200,800]；理想中心 260 距下界正好 60px，
     * 而收速距离 = 视口宽 1000 × 6% = 60px ⇒ **刚好在缓出带外**，逐值不变（同一个对象的行为）✓
     */
    expect(result.camera.x).toBeCloseTo(0.26, 9);
    /*
     * 纵向：中心屏幕 −12 **本来就在可行区外** ⇒ 软饱和与硬夹取逐值相同：
     * 夹到 36 + 100 = 136 ⇒ Δy = +148px ⇒ y 0 → 0.2467 ✓（这一条守住"超出即等于边线"）
     */
    expect(result.camera.y).toBeCloseTo(0.2466666666666667, 9);
    expect(result.bodyScreen.minX).toBeCloseTo(110, 6);
    expect(result.bodyScreen.maxX).toBeCloseTo(410, 6);
    expect(result.bodyScreen.minY).toBeCloseTo(36, 6);
    expect(result.bodyScreen.maxY).toBeCloseTo(236, 6);
    expect(inside(result.bodyScreen)).toBe(true);
  });

  it('旋转 0.1 rad 的构图越界：平移后四边在区内，旋转原样', () => {
    const body: SonnetFramingBox = { minX: -150, minY: -100, maxX: 150, maxY: 100 };
    const result = frameSonnetCameraToBody(
      { x: 0.3, y: 0, zoom: 1, rotation: 0.1 },
      { ...VIEWPORT, pivotX: 500, pivotY: 300, bodyBounds: body },
    );
    expect(result.adjusted).toBe(true);
    expect(result.camera.rotation).toBe(0.1);
    expect(result.camera.zoom).toBe(1);
    expect(inside(result.bodyScreen)).toBe(true);
    expect(result.camera.x).toBeCloseTo(0.3, 9);
    expect(result.camera.y).toBeCloseTo(0.35148897821941427, 9);
    expect(result.bodyScreen.minY).toBeCloseTo(36, 6);
    expect(result.bodyScreen.maxY).toBeCloseTo(264.95085804965356, 6);
    /* 横向本来就在安全区里（旋转后外接 ≈ 349 宽）⇒ 只动纵向 ✓ */
    expect(result.bodyScreen.minX).toBeCloseTo(173.21397589864895, 6);
    expect(result.bodyScreen.maxX).toBeCloseTo(491.68190881142226, 6);
  });

  it('旋转 0.1 rad、本来就在安全区内的构图：逐值不变（同一个对象）', () => {
    /*
     * y 取 0.6（不是 0.3）：旋转 + 非中心 pivot 后正文中心 ≈ (332, 300)，落在**软带之外的中心区**
     * （软带 = 视口边长的 6%：横 60px / 纵 36px）⇒ 逐值不变。y = 0.3 时中心在 120 附近、
     * 已经落进纵向软带 ⇒ 现在会先软限位（这正是本轮修的行为，见"小正文落进软带"那条用例）✓
     */
    const camera = { x: 0.3, y: 0.6, zoom: 1, rotation: 0.1 };
    const body: SonnetFramingBox = { minX: -100, minY: -60, maxX: 100, maxY: 60 };
    const result = frameSonnetCameraToBody(camera, {
      ...VIEWPORT,
      pivotX: 500,
      pivotY: 300,
      bodyBounds: body,
    });
    expect(result.camera).toBe(camera);
    expect(result.adjusted).toBe(false);
    expect(result.zoomRatio).toBe(1);
    expect(inside(result.bodyScreen)).toBe(true);
  });
});

describe('商籁取景：取景锚点 basePosition（投影与施加同源）', () => {
  /** 把正文四角**独立**投影一遍（手算参照，与实现无关）。 */
  const projectCorners = (
    bounds: SonnetFramingBox,
    pivot: { readonly x: number; readonly y: number },
    base: { readonly x: number; readonly y: number },
    camera: { readonly x: number; readonly y: number; readonly zoom: number; readonly rotation: number },
  ): SonnetFramingBox => {
    const cosine = Math.cos(camera.rotation);
    const sine = Math.sin(camera.rotation);
    const originX = base.x + camera.x * VIEWPORT.viewportWidth;
    const originY = base.y + camera.y * VIEWPORT.viewportHeight;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [cornerX, cornerY] of [
      [bounds.minX, bounds.minY],
      [bounds.maxX, bounds.minY],
      [bounds.maxX, bounds.maxY],
      [bounds.minX, bounds.maxY],
    ] as const) {
      const localX = (cornerX - pivot.x) * camera.zoom;
      const localY = (cornerY - pivot.y) * camera.zoom;
      xs.push(originX + localX * cosine - localY * sine);
      ys.push(originY + localX * sine + localY * cosine);
    }
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  };

  it('默认 basePosition = (W×0.5, H×0.48)：与显式传入逐值相同', () => {
    const camera = { x: 0.12, y: -0.06, zoom: 1, rotation: 0 };
    const body: SonnetFramingBox = { minX: 200, minY: 200, maxX: 400, maxY: 320 };
    const implicit = frameSonnetCameraToBody(camera, {
      ...VIEWPORT,
      pivotX: 300,
      pivotY: 260,
      bodyBounds: body,
    });
    const explicit = frameSonnetCameraToBody(camera, {
      ...VIEWPORT,
      pivotX: 300,
      pivotY: 260,
      bodyBounds: body,
      basePositionX: VIEWPORT.viewportWidth * 0.5,
      basePositionY: VIEWPORT.viewportHeight * 0.48,
    });
    expect(implicit.bodyScreen).toEqual(explicit.bodyScreen);
    expect(implicit.bodyScreen).toEqual(
      projectCorners(body, { x: 300, y: 260 }, { x: 500, y: 288 }, camera),
    );
  });

  it('显式 basePosition 不同：bodyScreen 是四角真投影，不是 (0.5W, 0.48H)', () => {
    const camera = { x: 0.1, y: 0.05, zoom: 1, rotation: 0 };
    const body: SonnetFramingBox = { minX: 10, minY: 20, maxX: 110, maxY: 60 };
    const base = { x: 260, y: 140 };
    const result = frameSonnetCameraToBody(camera, {
      ...VIEWPORT,
      pivotX: 0,
      pivotY: 0,
      bodyBounds: body,
      basePositionX: base.x,
      basePositionY: base.y,
    });
    /* 手算：屏幕 = base + camera×视口 + 局部（无旋转、zoom 1）⇒ x 360 + [10,110]、y 170 + [20,60] */
    expect(result.bodyScreen).toEqual({ minX: 370, minY: 190, maxX: 470, maxY: 230 });
    expect(result.bodyScreen).toEqual(projectCorners(body, { x: 0, y: 0 }, base, camera));
    expect(result.camera).toBe(camera);
    /* 同一个相机换回默认锚点 ⇒ 正好平移 (500−260, 288−140) ✓ */
    const defaultBase = frameSonnetCameraToBody(camera, {
      ...VIEWPORT,
      pivotX: 0,
      pivotY: 0,
      bodyBounds: body,
    });
    expect(defaultBase.bodyScreen.minX).toBeCloseTo(370 + (500 - 260), 9);
    expect(defaultBase.bodyScreen.minY).toBeCloseTo(190 + (288 - 140), 9);
  });

  it('不同 basePosition + 旋转 / 拉远：bodyScreen 是"求解后相机"的真四角投影', () => {
    const camera = { x: 0.35, y: 0.2, zoom: 1.1, rotation: 0.27 };
    const body: SonnetFramingBox = { minX: -600, minY: -420, maxX: 600, maxY: 420 };
    const base = { x: 320, y: 180 };
    const pivot = { x: 120, y: 460 };
    const result = frameSonnetCameraToBody(camera, {
      ...VIEWPORT,
      pivotX: pivot.x,
      pivotY: pivot.y,
      bodyBounds: body,
      basePositionX: base.x,
      basePositionY: base.y,
    });
    expect(result.adjusted).toBe(true);
    /* 读数必须等于"把四角过一遍**返回的相机**"，而不是理想 target 中心 */
    expect(result.bodyScreen).toEqual(projectCorners(body, pivot, base, result.camera));
    expect(inside(result.bodyScreen)).toBe(true);
  });
});

describe('商籁取景：过大布局才温和拉远', () => {
  it('800×600 的正文在 780×456 的运动保留区里装不下 ⇒ 按高度拉远到 0.76', () => {
    const result = frameSonnetCameraToBody(
      { x: 0, y: 0, zoom: 1, rotation: 0 },
      { ...VIEWPORT, pivotX: 500, pivotY: 300, bodyBounds: spanning() },
    );
    expect(result.adjusted).toBe(true);
    expect(result.zoomRatio).toBeCloseTo(456 / 600, 9);
    expect(result.camera.zoom).toBeCloseTo(0.76, 9);
    expect(inside(result.bodyScreen)).toBe(true);
    expect(result.camera.rotation).toBe(0);
    /* 缩放后整块 608×456 ⇒ 横向被最小位移推到左边界、纵向正好贴住保留区（36 / 492）✓ */
    expect(result.bodyScreen.minX).toBeCloseTo(50, 6);
    expect(result.bodyScreen.maxX).toBeCloseTo(658, 6);
    expect(result.bodyScreen.minY).toBeCloseTo(36, 6);
    expect(result.bodyScreen.maxY).toBeCloseTo(492, 6);
    /* 尺寸被压到保留区以内 ⇒ 相机在硬安全区里还有 6% 的行程（clamp 区间不是一点）✓ */
    expect(result.bodyScreen.maxX - result.bodyScreen.minX).toBeLessThanOrEqual(780 + 1e-6);
    expect(result.bodyScreen.maxY - result.bodyScreen.minY).toBeCloseTo(456, 6);
    expect(inside(result.bodyScreen)).toBe(true);
  });

  it('只是薄薄超宽 ⇒ 按宽度拉远到保留区宽，且 zoom 只减不增', () => {
    const wide: SonnetFramingBox = { minX: -500, minY: -10, maxX: 500, maxY: 10 };
    const result = frameSonnetCameraToBody(
      { x: 0, y: 0.02, zoom: 1.5, rotation: 0 },
      { ...VIEWPORT, pivotX: 0, pivotY: 0, bodyBounds: wide },
    );
    /* 屏幕尺寸 1000 × 1.5 = 1500 > 保留区宽 780 ⇒ 比例 780 / 1500 = 0.52 ⇒ zoom 1.5 → 0.78 ✓ */
    expect(result.zoomRatio).toBeCloseTo(0.52, 9);
    expect(result.camera.zoom).toBeCloseTo(0.78, 9);
    expect(result.camera.zoom).toBeLessThan(1.5);
    expect(inside(result.bodyScreen)).toBe(true);
    /* 缩到 0.78 后整块正好 780 宽（= 保留区宽）⇒ 左右落在 110 / 890，离硬安全区各留 6% ✓ */
    expect(result.bodyScreen.minX).toBeCloseTo(RESERVE.minX, 6);
    expect(result.bodyScreen.maxX).toBeCloseTo(RESERVE.maxX, 6);
    expect(minMargin(result.bodyScreen)).toBeGreaterThan(50);
  });

  it('正文比保留区还大时不翻转：居中即可（允许压住边距）', () => {
    const huge: SonnetFramingBox = { minX: -4000, minY: -3000, maxX: 4000, maxY: 3000 };
    const result = frameSonnetCameraToBody(
      { x: 0, y: 0.02, zoom: 1, rotation: 0 },
      { ...VIEWPORT, pivotX: 0, pivotY: 0, bodyBounds: huge },
    );
    /* 8000 宽 / 6000 高：宽度比 0.0975、高度比 0.076 ⇒ 取小的那个（只减不增）✓ */
    expect(result.zoomRatio).toBeCloseTo(456 / 6000, 9);
    const centerX = (result.bodyScreen.minX + result.bodyScreen.maxX) / 2;
    const centerY = (result.bodyScreen.minY + result.bodyScreen.maxY) / 2;
    expect(centerX).toBeCloseTo((SAFE.minX + SAFE.maxX) / 2, 6);
    expect(centerY).toBeCloseTo((SAFE.minY + SAFE.maxY) / 2, 6);
  });

  it('极长正文：比例远小于 0.01 也照用（不再被 0.01 下限卡住）', () => {
    const huge: SonnetFramingBox = { minX: -200000, minY: -100, maxX: 200000, maxY: 100 };
    const result = frameSonnetCameraToBody(
      { x: 0, y: 0, zoom: 1, rotation: 0 },
      { ...VIEWPORT, pivotX: 0, pivotY: 0, bodyBounds: huge },
    );
    /* 需要宽 400000、保留区宽 780 ⇒ 比例 0.00195（旧下限 0.01 会让它永远装不下）✓ */
    expect(result.zoomRatio).toBeCloseTo(780 / 400000, 12);
    expect(result.zoomRatio).toBeLessThan(0.01);
    expect(result.camera.zoom).toBeGreaterThan(0);
    expect(inside(result.bodyScreen)).toBe(true);
  });
});

describe('商籁取景：运动留白（摇移不被边缘 clamp 锁死）', () => {
  /** 正好占满原硬安全区（900×528）的正文；轴心取它自己的中心 ⇒ 偏移为 0，便于读位移 ✓。 */
  const fullSafeBody: SonnetFramingBox = { minX: 50, minY: 36, maxX: 950, maxY: 564 };
  const anchored = { basePositionX: 500, basePositionY: 288 } as const;

  it('占满硬安全区的正文先被拉远到保留区（≤ 78% × 76%），四周不再贴边', () => {
    const result = frameSonnetCameraToBody(
      { x: 0, y: 0, zoom: 1, rotation: 0 },
      { ...VIEWPORT, pivotX: 500, pivotY: 300, ...anchored, bodyBounds: fullSafeBody },
    );
    expect(result.adjusted).toBe(true);
    /* 900×528 两个方向都超保留区 ⇒ 按高度受限的那一支拉远（456 / 528）✓ */
    expect(result.zoomRatio).toBeCloseTo(456 / 528, 9);
    expect(result.camera.zoom).toBeCloseTo(456 / 528, 9);
    expect(inside(result.bodyScreen)).toBe(true);
    expect(result.bodyScreen.maxX - result.bodyScreen.minX).toBeLessThanOrEqual(
      VIEWPORT.viewportWidth * 0.78 + 1e-6,
    );
    expect(result.bodyScreen.maxY - result.bodyScreen.minY).toBeLessThanOrEqual(
      VIEWPORT.viewportHeight * 0.76 + 1e-6,
    );
    expect(minMargin(result.bodyScreen)).toBeGreaterThan(0);
  });

  it('同一镜横移几个小步：正文中心有非零屏幕位移，且始终在硬安全区内', () => {
    const centers: number[] = [];
    for (const x of [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06]) {
      const result = frameSonnetCameraToBody(
        { x, y: 0, zoom: 1, rotation: 0 },
        { ...VIEWPORT, pivotX: 500, pivotY: 300, ...anchored, bodyBounds: fullSafeBody },
      );
      expect(inside(result.bodyScreen)).toBe(true);
      expect(result.camera.zoom).toBeCloseTo(456 / 528, 9);
      /*
       * 每步的平移**都还在**（被夹死的话中心会停在同一格）✓。
       * 最后两步进入软饱和带（收速距离 = 视口宽 1000 × 6% = 60px）⇒ 位置被连续收掉几像素
       * （远小于一个步长 10px；旧版硬夹取是在顶边那一刻把速度直接归零）✓
       */
      expect(Math.abs(result.camera.x - x)).toBeLessThan(0.012);
      centers.push((result.bodyScreen.minX + result.bodyScreen.maxX) / 2);
    }
    /*
     * 6 个小步 × 每步 10px ⇒ 中心真的往右走了 60px（旧实现会把它锁死在 500 不动）✓。
     * 步长 2~13.5px：越靠近边线，缓出把这一小步收得越多（收速距离 = 视口宽 1000 × 6% = 60px），
     * 但**每一步都还在动**（>0），而且始终在硬安全区内 —— 这正是"软着陆"该有的样子 ✓
     */
    for (let index = 1; index < centers.length; index += 1) {
      const step = centers[index]! - centers[index - 1]!;
      expect(step).toBeGreaterThan(2);
      expect(step).toBeLessThan(13.5);
    }
    expect(centers.at(-1)! - centers[0]!).toBeGreaterThan(58);
    expect(centers.at(-1)! - centers[0]!).toBeLessThanOrEqual(65);
  });

  it('巨大布局拉远后仍在硬安全区里，四周都有余量', () => {
    const result = frameSonnetCameraToBody(
      { x: 0.04, y: 0, zoom: 1, rotation: 0 },
      {
        ...VIEWPORT,
        pivotX: 500,
        pivotY: 300,
        ...anchored,
        bodyBounds: { minX: -200, minY: -200, maxX: 1200, maxY: 800 },
      },
    );
    /* 1400×1000：宽高都比保留区大 ⇒ 按高度拉远（456 / 1000）✓ */
    expect(result.adjusted).toBe(true);
    expect(result.zoomRatio).toBeCloseTo(456 / 1000, 9);
    expect(inside(result.bodyScreen)).toBe(true);
    expect(result.bodyScreen.maxX - result.bodyScreen.minX).toBeLessThanOrEqual(780 + 1e-6);
    expect(result.bodyScreen.maxY - result.bodyScreen.minY).toBeLessThanOrEqual(456 + 1e-6);
    /* 完整入镜（没有一边被切）且四边都离硬安全区边界有余量 ✓ */
    expect(minMargin(result.bodyScreen)).toBeGreaterThan(0);
  });

  it('小构图落在**中心区**（软带之外）逐值不变：仍是同一个 camera 对象', () => {
    const camera = { x: 0, y: 0, zoom: 1, rotation: 0 };
    const result = frameSonnetCameraToBody(camera, {
      ...VIEWPORT,
      pivotX: 500,
      pivotY: 300,
      ...anchored,
      bodyBounds: { minX: 150, minY: 90, maxX: 850, maxY: 510 },
    });
    expect(result.camera).toBe(camera);
    expect(result.adjusted).toBe(false);
    expect(result.zoomRatio).toBe(1);
    /*
     * 700×420 的正文中心正好落在锚点 (500, 288)：可行中心区 x ∈ [400,600]、y ∈ [246,354]，
     * 再各收软带 60 / 36px ⇒ 恒等区 x ∈ [460,540]、y ∈ [282,318] ⇒ 中心在区内 ✓
     */
    expect(result.bodyScreen.minX).toBeCloseTo(150, 6);
    expect(result.bodyScreen.maxX).toBeCloseTo(850, 6);
  });

  it('小正文落进**软带**就先软限位：不必等它越界才起效（softBandRatio = 0 才是旧行为）', () => {
    const body: SonnetFramingBox = { minX: 150, minY: 90, maxX: 850, maxY: 510 };
    const options = { ...VIEWPORT, pivotX: 500, pivotY: 300, ...anchored, bodyBounds: body } as const;
    /*
     * 正文中心屏幕 = 500 + x × 1000。x = 0.05 ⇒ 中心 550：**仍在硬安全区内**
     * （上限 600 = 950 − 350），但距上限只有 50px < 软带 60px ⇒ 本轮修的就是这一格：
     * 旧版在这里提前 return 原相机、绕过软限位；现在必须先软收速（中心 551.39）✓
     */
    const soft = frameSonnetCameraToBody({ x: 0.05, y: 0, zoom: 1, rotation: 0 }, options);
    expect(soft.adjusted).toBe(true);
    expect(soft.zoomRatio).toBe(1);
    expect(soft.camera.x).toBeCloseTo(0.0513888888888889, 12);
    expect(inside(soft.bodyScreen)).toBe(true);
    /* 只做软收速、**不推回保留区**：正文仍在保留区之外（旧用例守的就是这条）✓ */
    expect(insideReserve(soft.bodyScreen)).toBe(false);
    /* 传 0 ⇒ 软带关掉，回到"在硬安全区内即逐值不变"的旧读数 ✓ */
    const hard = frameSonnetCameraToBody(
      { x: 0.05, y: 0, zoom: 1, rotation: 0 },
      { ...options, softBandRatio: 0 },
    );
    expect(hard.adjusted).toBe(false);
    expect(hard.camera.x).toBeCloseTo(0.05, 12);
  });

  it('小正文从安全区内跨出边缘也走软限位：加密采样后速度台阶不增长', () => {
    /* 700×420 的小正文（尺寸远小于保留区）⇒ 只会平移、不会拉远 ✓ */
    const body: SonnetFramingBox = { minX: 150, minY: 90, maxX: 850, maxY: 510 };
    const options = { ...VIEWPORT, pivotX: 500, pivotY: 300, ...anchored, bodyBounds: body } as const;
    /** 一趟扫描里"相邻两帧速度之差 / 帧长"的最大值（= 采样出来的最大加速度）✓ */
    const maxAccel = (softBandRatio: number | undefined, dt: number): number => {
      const centers: number[] = [];
      for (let step = 0; step * dt <= 1 + 1e-9; step += 1) {
        const t = step * dt;
        const result = frameSonnetCameraToBody(
          { x: t * 0.16, y: 0, zoom: 1, rotation: 0 },
          { ...options, softBandRatio },
        );
        centers.push((result.bodyScreen.minX + result.bodyScreen.maxX) / 2);
      }
      let worst = 0;
      for (let index = 2; index < centers.length; index += 1) {
        const first = (centers[index - 1]! - centers[index - 2]!) / dt;
        const second = (centers[index]! - centers[index - 1]!) / dt;
        worst = Math.max(worst, Math.abs(second - first) / dt);
      }
      return worst;
    };
    /* 中心从 500 扫到 660 ⇒ 跨过安全区上限 600（= 950 − 350）✓ */
    const soft = { coarse: maxAccel(undefined, 1 / 60), fine: maxAccel(undefined, 1 / 600) };
    const hard = { coarse: maxAccel(0, 1 / 60), fine: maxAccel(0, 1 / 600) };
    /* C¹：加密一个数量级读数基本不变；硬夹取在边线上速度一步归零 ⇒ 加速度 ∝ 1/dt ✓ */
    expect(soft.fine).toBeLessThan(soft.coarse * 4 + 1e-6);
    expect(hard.fine).toBeGreaterThan(hard.coarse * 4);
  });
});

describe('商籁取景：边界输入', () => {
  it('极小视口（安全区被夹成合法值）不产生 NaN / 翻转', () => {
    const result = frameSonnetCameraToBody(
      { x: 0, y: 0, zoom: 1, rotation: 0.1 },
      { viewportWidth: 8, viewportHeight: 6, pivotX: 4, pivotY: 3, bodyBounds: spanning() },
    );
    expect(Number.isFinite(result.camera.x)).toBe(true);
    expect(Number.isFinite(result.camera.y)).toBe(true);
    expect(Number.isFinite(result.camera.zoom)).toBe(true);
    expect(result.camera.zoom).toBeGreaterThan(0);
  });

  it('视口为 0 / 无正文 ⇒ 原样返回', () => {
    const camera = { x: 0.1, y: -0.1, zoom: 1.2, rotation: 0.05 };
    const zero = frameSonnetCameraToBody(camera, {
      viewportWidth: 0,
      viewportHeight: 0,
      pivotX: 0,
      pivotY: 0,
      bodyBounds: spanning(),
    });
    expect(zero.camera).toBe(camera);
    const empty = frameSonnetCameraToBody(camera, {
      ...VIEWPORT,
      pivotX: 0,
      pivotY: 0,
      bodyBounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    });
    expect(empty.camera).toBe(camera);
  });

  it('默认边距就是 5% / 6%，运动留白默认左右 / 上下各 6%', () => {
    expect(SONNET_FRAMING_MARGIN_X).toBe(0.05);
    expect(SONNET_FRAMING_MARGIN_Y).toBe(0.06);
    expect(SONNET_FRAMING_MOTION_MARGIN_X).toBe(0.06);
    expect(SONNET_FRAMING_MOTION_MARGIN_Y).toBe(0.06);
  });
});

describe('商籁取景：记忆化取景器（不随入场位移抽动）', () => {
  const framer = (measureWidth: (text: string, fontPx: number, weight: number) => number) =>
    createSonnetCameraFramer({ fontFamily: () => 'sans-serif', measureWidth });

  it('同一份落位：结果只由相机与落位决定，逐帧读数相同', () => {
    const run = framer(measure100);
    const glyphs = [glyphAt(100, 100), glyphAt(300, 100)];
    const camera = { x: 0, y: 0.02, zoom: 1, rotation: 0 };
    const first = run(camera, { shotId: 'shot-a', ...VIEWPORT, pivotX: 200, pivotY: 100, glyphs });
    /* 帧层逐帧新建"同一份落位"的数组 ⇒ 读数必须逐值相同 ✓ */
    const again = run(camera, {
      shotId: 'shot-a',
      ...VIEWPORT,
      pivotX: 200,
      pivotY: 100,
      glyphs: [glyphAt(100, 100), glyphAt(300, 100)],
    });
    expect(again.bodyScreen).toEqual(first.bodyScreen);
    expect(again.camera.x).toBe(first.camera.x);
    /* 新数组但同一份几何：字符键命中 ⇒ 仍逐值相同 ✓（且不重量文本） */
    let measurements = 0;
    const counting = createSonnetCameraFramer({
      fontFamily: () => 'sans-serif',
      measureWidth: () => {
        measurements += 1;
        return 100;
      },
    });
    counting(camera, { shotId: 'shot-a', ...VIEWPORT, pivotX: 200, pivotY: 100, glyphs });
    const afterFirst = measurements;
    const cached = counting(camera, {
      shotId: 'shot-a',
      ...VIEWPORT,
      pivotX: 200,
      pivotY: 100,
      glyphs: [glyphAt(100, 100), glyphAt(300, 100)],
    });
    expect(measurements).toBe(afterFirst);
    expect(cached.bodyScreen).toEqual(first.bodyScreen);
  });

  it('缓存键只看落位几何：pivot / 入场 rotation / alpha / scale 变化都不重量', () => {
    let measurements = 0;
    const run = createSonnetCameraFramer({
      fontFamily: () => 'sans-serif',
      measureWidth: (_text, fontPx) => {
        measurements += 1;
        return fontPx;
      },
    });
    const camera = { x: 0, y: 0.02, zoom: 1, rotation: 0 };
    const entrance = (
      rotation: number,
      alpha: number,
      scale: number,
    ): SonnetFramingGlyph & { readonly alpha: number } => ({
      ...glyphAt(500, 300, { layoutRotation: 0.4, rotation }),
      alpha,
      scale,
    });
    const base = { shotId: 'shot-b', ...VIEWPORT, pivotX: 500, pivotY: 300 };
    const entering = run(camera, { ...base, glyphs: [entrance(0.9, 0.05, 0.86)] });
    const measured = measurements;
    /* 同几何、不同数组，pivot 也变了 ⇒ 键里没有 pivot / 入场量 ⇒ 不得重测 ✓ */
    const moved = run(camera, {
      ...base,
      pivotX: 320,
      pivotY: 180,
      glyphs: [entrance(0, 1, 1)],
    });
    expect(measurements).toBe(measured);
    const samePivot = run(camera, { ...base, glyphs: [entrance(-0.6, 1, 1)] });
    expect(measurements).toBe(measured);
    /* 落位 bounds 与入场状态无关：读数只差 pivot 带来的那点位移 */
    expect(samePivot.bodyScreen).toEqual(entering.bodyScreen);
    expect(moved.bodyScreen).not.toEqual(entering.bodyScreen);
  });

  it('shotId / 字号变化必须重测：新几何不得复用旧 bounds', () => {
    let measurements = 0;
    const run = createSonnetCameraFramer({
      fontFamily: () => 'sans-serif',
      measureWidth: (_text, fontPx) => {
        measurements += 1;
        return fontPx;
      },
    });
    const camera = { x: 0, y: 0.02, zoom: 1, rotation: 0 };
    const input = (shotId: string, fontPx: number) => ({
      shotId,
      ...VIEWPORT,
      pivotX: 500,
      pivotY: 300,
      glyphs: [glyphAt(500, 300, { fontPx })],
    });
    const wide = run(camera, input('shot-c', 100));
    expect(measurements).toBe(1);
    run(camera, input('shot-c', 100));
    expect(measurements).toBe(1);
    /* 换镜 ⇒ 重量（哪怕几何一样）*/
    const nextShot = run(camera, input('shot-d', 100));
    expect(measurements).toBe(2);
    expect(nextShot.bodyScreen).toEqual(wide.bodyScreen);
    /* 字号变 ⇒ 重量且读数跟着变 ✓ */
    const small = run(camera, input('shot-d', 60));
    expect(measurements).toBe(3);
    expect(wide.bodyScreen.maxX - wide.bodyScreen.minX).toBeCloseTo(100, 6);
    expect(small.bodyScreen.maxX - small.bodyScreen.minX).toBeCloseTo(60, 6);
  });

  it('换字体族 ⇒ 缓存失效并重新量：窄字体放得下 ⇒ 原样不动', () => {
    let measured = 100;
    const run = createSonnetCameraFramer({
      fontFamily: () => (measured === 100 ? 'wide' : 'narrow'),
      measureWidth: () => measured,
    });
    const glyphs = [glyphAt(500, 300)];
    const camera = { x: 0, y: 0.02, zoom: 1, rotation: 0 };
    const wide = run(camera, { shotId: 'shot-e', ...VIEWPORT, pivotX: 500, pivotY: 300, glyphs });
    expect(wide.adjusted).toBe(false);
    expect(wide.bodyScreen.maxX - wide.bodyScreen.minX).toBeCloseTo(100, 6);
    measured = 20;
    const narrow = run(camera, { shotId: 'shot-e', ...VIEWPORT, pivotX: 500, pivotY: 300, glyphs });
    expect(narrow.bodyScreen.maxX - narrow.bodyScreen.minX).toBeCloseTo(20, 6);
  });

  it('seek 到别处（落位变了）⇒ 重新量并约束', () => {
    const run = framer(measure100);
    const camera = { x: 0, y: 0.02, zoom: 1, rotation: 0 };
    const near = run(camera, {
      shotId: 'shot-seek',
      ...VIEWPORT,
      pivotX: 500,
      pivotY: 300,
      glyphs: [glyphAt(500, 300)],
    });
    const far = run(camera, {
      shotId: 'shot-seek',
      ...VIEWPORT,
      pivotX: 500,
      pivotY: 300,
      glyphs: [glyphAt(950, 300)],
    });
    expect(near.adjusted).toBe(false);
    expect(far.bodyScreen).not.toEqual(near.bodyScreen);
    expect(far.adjusted).toBe(true);
    expect(inside(far.bodyScreen)).toBe(true);
    /* 小单字尺寸远小于保留区 ⇒ 只平移、不拉远 ✓ */
    expect(far.zoomRatio).toBe(1);
    /* 贴右的字半宽 50 ⇒ 中心最多 900（屏幕）⇒ 平移 −50px ⇒ x −0.05 ✓ */
    expect(far.camera.x).toBeCloseTo(-0.05, 9);
  });
});

/**
 * **软饱和**（本轮修"镜头生硬 / 整体突移"的那一层）。
 *
 * 旧版把正文中心钉到安全区边线用的是硬 `clamp`：位置连续，但**速度在顶边那一刻一步归零**
 * —— `.tmp/sonnet-probe/probe2/3` 实测 60Hz 采样下加速度尖峰 **62542 px/s²**，
 * 而同一段理想相机轨迹只有 1130 px/s²。这两个用例守的就是"换成 C¹ 之后台阶真的没了"。
 */
describe('商籁取景：软饱和（速度台阶）', () => {
  it('`softClamp` 的五条性质：中段逐值不变、超出即边线、永远在区内、单调、两端速度连续', () => {
    const min = 100;
    const max = 500;
    const band = 80;
    /* ① 中段（[min+band, max−band]）逐值不变 ✓ */
    expect(softClamp(180, min, max, band)).toBeCloseTo(180, 12);
    expect(softClamp(300, min, max, band)).toBeCloseTo(300, 12);
    expect(softClamp(420, min, max, band)).toBeCloseTo(420, 12);
    /* ② 超出 [min, max] ⇒ 输出就是边线本身（与硬 clamp 逐值相同）✓ */
    expect(softClamp(20, min, max, band)).toBeCloseTo(min, 12);
    expect(softClamp(999, min, max, band)).toBeCloseTo(max, 12);
    /* ③ 全域都在 [min, max] 内 ✓ */
    for (let value = -200; value <= 900; value += 0.5) {
      const out = softClamp(value, min, max, band);
      expect(out).toBeGreaterThanOrEqual(min - 1e-9);
      expect(out).toBeLessThanOrEqual(max + 1e-9);
    }
    /* ④ 单调不减 ✓ */
    let previous = Number.NEGATIVE_INFINITY;
    for (let value = -200; value <= 900; value += 0.25) {
      const out = softClamp(value, min, max, band);
      expect(out).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = out;
    }
    /*
     * ⑤ 两端速度连续：靠边带内斜率从 1 连续降到 0。
     * 用差分测：带内靠近中段处 ≈ 1（与恒等段接得上），贴边处 ≈ 0（不再有速度台阶）✓
     */
    const slope = (value: number): number => (softClamp(value + 1e-6, min, max, band) - softClamp(value - 1e-6, min, max, band)) / 2e-6;
    expect(slope(min + band)).toBeCloseTo(1, 4);
    expect(slope(min + band * 0.01)).toBeLessThan(0.1);
    expect(slope(max - band)).toBeCloseTo(1, 4);
    expect(slope(max - band * 0.01)).toBeLessThan(0.1);
  });

  it('带宽为 0 / 退化区间不产生 NaN', () => {
    expect(softClamp(120, 100, 500, 0)).toBe(120);
    expect(softClamp(20, 100, 500, 0)).toBe(100);
    expect(softClamp(999, 100, 500, 0)).toBe(500);
    /* min > max（正文比安全区还大）⇒ 取中点，与旧实现的兜底一致 ✓ */
    expect(softClamp(300, 500, 100, 40)).toBe(300);
    expect(Number.isFinite(softClamp(Number.NaN, 100, 500, 40))).toBe(false);
  });

  it('默认带宽 = 视口边长的 6%；靠边才变软、越界仍与硬夹取逐值相同', () => {
    expect(SONNET_FRAMING_SOFT_BAND_RATIO).toBeCloseTo(0.06, 12);
    /*
     * 半宽 150 ⇒ 正文中心可行区 [200, 800]；这套夹具里 base 与 pivot 的偏移抵消，
     * 中心恰好 = `1000 × x` ⇒ `x = 0.29` 是"距下界 90px"、`x = 0.9` 是"明确越界" ✓。
     * 收速距离 = 视口宽 1000 × 6% = 60px ⇒ 90px 已经在缓出带之外（逐值不变）✓
     */
    const body: SonnetFramingBox = { minX: -150, minY: -20, maxX: 150, maxY: 20 };
    const options = {
      ...VIEWPORT,
      pivotX: 500,
      pivotY: 300,
      basePositionX: 500,
      basePositionY: 300,
      bodyBounds: body,
    } as const;
    const framer = (x: number, softBandRatio?: number) =>
      frameSonnetCameraToBody(
        { x, y: 0, zoom: 1, rotation: 0 },
        softBandRatio === undefined ? options : { ...options, softBandRatio },
      );
    /* 距边 90px（> 60px 带宽）⇒ 与硬夹取逐值相同 ✓ */
    expect(framer(0.29).camera.x).toBeCloseTo(framer(0.29, 0).camera.x, 12);
    /* 距边 30px（< 60px 带宽）⇒ 软饱和继续往可行区里收一点点 ✓ */
    const softNear = framer(0.23);
    const hardNear = framer(0.23, 0);
    expect(hardNear.camera.x).toBeCloseTo(0.23, 12);
    expect(softNear.camera.x).toBeLessThan(0.23);
    expect(softNear.camera.x).toBeGreaterThan(0.2);
    expect(inside(softNear.bodyScreen)).toBe(true);
    /* 明确越界（中心 900 > 800）⇒ 软与硬都返回边线本身，**逐值相同** ✓ */
    const softFar = framer(0.9);
    const hardFar = framer(0.9, 0);
    expect(hardFar.camera.x).toBeCloseTo(0.8, 12);
    expect(softFar.camera.x).toBeCloseTo(hardFar.camera.x, 12);
  });

  it('取景平移是 C¹：采样加密后速度台阶**不**增长（硬夹取按 1/dt 增长）', () => {
    /* 半宽 150 ⇒ 中心可行区 [200, 800]；扫 x 0.2→0.4 会把中心从 700 推到 900，跨过 800 ✓ */
    const body: SonnetFramingBox = { minX: -150, minY: -20, maxX: 150, maxY: 20 };
    const options = {
      ...VIEWPORT,
      pivotX: 500,
      pivotY: 300,
      basePositionX: 500,
      basePositionY: 300,
      bodyBounds: body,
    } as const;
    /** 一趟扫描里"相邻两帧速度之差 / 帧长"的最大值（= 采样出来的最大加速度）✓ */
    const maxAccel = (softBandRatio: number | undefined, dt: number): number => {
      const centers: number[] = [];
      for (let step = 0; step * dt <= 1 + 1e-9; step += 1) {
        const t = step * dt;
        const result = frameSonnetCameraToBody(
          { x: 0.2 + t * 0.2, y: 0, zoom: 1, rotation: 0 },
          { ...options, softBandRatio },
        );
        centers.push((result.bodyScreen.minX + result.bodyScreen.maxX) / 2);
      }
      let worst = 0;
      for (let index = 2; index < centers.length; index += 1) {
        const first = (centers[index - 1]! - centers[index - 2]!) / dt;
        const second = (centers[index]! - centers[index - 1]!) / dt;
        worst = Math.max(worst, Math.abs(second - first) / dt);
      }
      return worst;
    };
    const soft = { coarse: maxAccel(undefined, 1 / 60), fine: maxAccel(undefined, 1 / 600) };
    const hard = { coarse: maxAccel(0, 1 / 60), fine: maxAccel(0, 1 / 600) };
    /* C¹：加密一个数量级，读数基本不变（同量级即可，留 4 倍容差）✓ */
    expect(soft.fine).toBeLessThan(soft.coarse * 4 + 1e-6);
    /* 硬夹取：顶边处速度从 ~200px/s 直接掉到 0 ⇒ 采样出来的加速度 = 台阶/dt，加密后长大 ≥ 4 倍 ✓ */
    expect(hard.fine).toBeGreaterThan(hard.coarse * 4);
  });
});
