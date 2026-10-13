/**
 * 商籁**阅读窗口取景**（`frameSonnetCameraToReadingWindow`）的用例 —— 本轮取景语义纠正的核心。
 *
 * 三件事与旧的"整镜取景"（`frameSonnetCameraToBody`，本文件不重复它的用例）不同：
 * ① 尺寸依据是**阅读窗口**（当前词组 + 近邻），不是整镜全部落位边界；
 * ② **缩放下限**：窗口再大也只缩到 `minZoomRatio`，剩下的越过画面边缘出血（不再缩成小字）；
 * ③ **平移兜底**：传了计划页盒（`planBounds`）就只做**温和**修正（上限 0.10 视口、边距宽容），
 *    不传才退回"盯窗口 + 0.16 上限"的旧口径；**没有**任何"把当前词硬拉进画面"的路径。
 *
 * 坐标口径与渲染层一致：`屏幕 = (锚点) + R(旋转)·(zoom·(局部 − pivot))`。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_READING_FRAMING_MAX_PAN_RATIO,
  SONNET_READING_FRAMING_MIN_ZOOM_RATIO,
  SONNET_READING_FRAMING_PLAN_PAN_RATIO,
  frameSonnetCameraToBody,
  frameSonnetCameraToReadingWindow,
  type SonnetCameraLike,
  type SonnetFramingBox,
} from './sonnetCameraFraming';

const VIEWPORT = { viewportWidth: 1000, viewportHeight: 600 } as const;
const CAMERA: SonnetCameraLike = { x: 0, y: 0, zoom: 1, rotation: 0 };

/** 轴心与锚点都放在画面中心（`pivot + anchorDelta` 的常见形态），便于手算。 */
const base = (windowBounds: SonnetFramingBox) => ({
  ...VIEWPORT,
  pivotX: 500,
  pivotY: 300,
  basePositionX: 500,
  basePositionY: 300,
  windowBounds,
});

/** 以 (cx, cy) 为中心、宽高给定的窗口。 */
const box = (cx: number, cy: number, width: number, height: number): SonnetFramingBox => ({
  minX: cx - width / 2,
  maxX: cx + width / 2,
  minY: cy - height / 2,
  maxY: cy + height / 2,
});

describe('商籁阅读窗口取景：放得下就逐值不动', () => {
  it('窗口落在安全区中心 ⇒ 原样返回传入的相机（同一引用）', () => {
    const result = frameSonnetCameraToReadingWindow(CAMERA, base(box(500, 300, 300, 120)));
    expect(result.camera).toBe(CAMERA);
    expect(result.adjusted).toBe(false);
    expect(result.zoomRatio).toBe(1);
    expect(result.panX).toBe(0);
    expect(result.panY).toBe(0);
  });

  it('窗口偏出安全区 ⇒ 只平移（不拉远），且平移不超过上限', () => {
    /* 窗口中心在 x = 900（安全区右界 950，正文半宽 100 ⇒ 中心可行区 ≤ 850） */
    const result = frameSonnetCameraToReadingWindow(CAMERA, base(box(900, 300, 200, 100)));
    expect(result.adjusted).toBe(true);
    expect(result.zoomRatio).toBe(1);
    expect(Math.abs(result.panX)).toBeLessThanOrEqual(SONNET_READING_FRAMING_MAX_PAN_RATIO + 1e-9);
    /* 窗口被拉回安全区（读数由求解后的相机真投得到） */
    expect(result.windowScreen.maxX).toBeLessThanOrEqual(950 + 1e-6);
  });
});

describe('商籁阅读窗口取景：缩放下限（长歌词不再整镜 fit 成小字）', () => {
  it('窗口比视口大得多时：缩放停在下限，其余出血', () => {
    const huge = box(500, 300, 4000, 3000);
    const reading = frameSonnetCameraToReadingWindow(CAMERA, base(huge));
    expect(reading.zoomRatio).toBeCloseTo(SONNET_READING_FRAMING_MIN_ZOOM_RATIO, 9);
    expect(reading.camera.zoom).toBeCloseTo(SONNET_READING_FRAMING_MIN_ZOOM_RATIO, 9);
    /* 出血是**允许**的：窗口屏幕范围会超出安全区（这正是"不做硬包含"） */
    expect(reading.windowScreen.maxX - reading.windowScreen.minX).toBeGreaterThan(900);
    /* 旧口径会把同一块缩得更狠 ⇒ 这条对比就是"语义换了"的证据 */
    const legacy = frameSonnetCameraToBody(CAMERA, {
      viewportWidth: VIEWPORT.viewportWidth,
      viewportHeight: VIEWPORT.viewportHeight,
      pivotX: 500,
      pivotY: 300,
      basePositionX: 500,
      basePositionY: 300,
      bodyBounds: huge,
    });
    expect(legacy.zoomRatio).toBeLessThan(reading.zoomRatio);
  });

  it('缩放下限可调：传 0.5 就允许缩到一半（不再有别的硬下限）', () => {
    const huge = box(500, 300, 4000, 3000);
    const half = frameSonnetCameraToReadingWindow(CAMERA, {
      ...base(huge),
      minZoomRatio: 0.5,
    });
    expect(half.zoomRatio).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(half.zoomRatio).toBeGreaterThan(0.3);
  });

  it('窗口小 ⇒ 绝不放大（zoomRatio 只 ≤ 1）', () => {
    const tiny = box(500, 300, 40, 20);
    const result = frameSonnetCameraToReadingWindow(CAMERA, base(tiny));
    expect(result.zoomRatio).toBe(1);
    expect(result.camera.zoom).toBe(1);
  });
});

describe('商籁阅读窗口取景：平移上限（远块拗不动镜头）', () => {
  it('窗口中心远在天边 ⇒ 平移被夹在上限内，画面不会被拽飞', () => {
    const far = box(6000, 300, 200, 100);
    const result = frameSonnetCameraToReadingWindow(CAMERA, base(far));
    expect(Math.abs(result.panX)).toBeLessThanOrEqual(SONNET_READING_FRAMING_MAX_PAN_RATIO + 1e-9);
    expect(Math.abs(result.panY)).toBeLessThanOrEqual(SONNET_READING_FRAMING_MAX_PAN_RATIO + 1e-9);
    /* 相机仍是有限值（没有 NaN / Infinity 传下去） */
    expect(Number.isFinite(result.camera.x)).toBe(true);
    expect(Number.isFinite(result.camera.y)).toBe(true);
    expect(Number.isFinite(result.camera.zoom)).toBe(true);
  });

  it('平移上限可调：传 0.02 时修正量不超过 2% 视口', () => {
    const far = box(6000, 300, 200, 100);
    const result = frameSonnetCameraToReadingWindow(CAMERA, { ...base(far), maxPanRatio: 0.02 });
    expect(Math.abs(result.panX)).toBeLessThanOrEqual(0.02 + 1e-9);
  });
});

describe('商籁阅读窗口取景：平移兜底（计划页盒，温和且有上限）', () => {
  it('计划页盒已在画面里 ⇒ 原样返回（兜底不参与构图）', () => {
    const result = frameSonnetCameraToReadingWindow(CAMERA, {
      ...base(box(500, 300, 300, 120)),
      planBounds: box(500, 300, 500, 300),
    });
    expect(result.camera).toBe(CAMERA);
    expect(result.adjusted).toBe(false);
    expect(result.panX).toBe(0);
    expect(result.panY).toBe(0);
    expect(result.planScreen).not.toBeNull();
  });

  it('计划页盒偏出画面 ⇒ 只做有上限的温和平移（不会被拽飞、也不会拉回"当前词"）', () => {
    /* 页盒整块在右外侧：按要求"读得清优先"不再成立，这里只允许 0.10 视口的修正。 */
    const far = { minX: 2400, minY: 260, maxX: 2800, maxY: 340 };
    const result = frameSonnetCameraToReadingWindow(CAMERA, {
      ...base(box(500, 300, 300, 120)),
      planBounds: far,
    });
    expect(Math.abs(result.panX)).toBeLessThanOrEqual(SONNET_READING_FRAMING_PLAN_PAN_RATIO + 1e-9);
    expect(Math.abs(result.panY)).toBeLessThanOrEqual(SONNET_READING_FRAMING_PLAN_PAN_RATIO + 1e-9);
    /*
     * 2025 版那条"无上限锚点纠偏"会把整块拉进安全区（pan 远超 0.10）—— 那正是"一换语义块就急追"。
     * 这里反过来守：修正量被上限夹住，远处内容宁可留在画外（宽容边缘）。
     */
    expect(result.planScreen).not.toBeNull();
    const screen = result.planScreen as SonnetFramingBox;
    expect(screen.minX).toBeGreaterThan(VIEWPORT.viewportWidth);
  });

  it('计划页盒连续滑动时相机也连续（没有位置 / 缩放跳变）', () => {
    let previous: { readonly x: number; readonly y: number } | null = null;
    let worstPosition = 0;
    const dt = 1 / 240;
    for (let step = 0; step * dt <= 2; step += 1) {
      const progress = (step * dt) / 2;
      const plan: SonnetFramingBox = {
        minX: 300 + progress * 900,
        minY: 280,
        maxX: 460 + progress * 900,
        maxY: 320,
      };
      const result = frameSonnetCameraToReadingWindow(CAMERA, {
        ...base(box(500, 300, 300, 120)),
        planBounds: plan,
      });
      if (previous !== null) {
        worstPosition = Math.max(
          worstPosition,
          Math.abs(result.camera.x - previous.x),
          Math.abs(result.camera.y - previous.y),
        );
      }
      previous = { x: result.camera.x, y: result.camera.y };
    }
    /* 1/240s 一步：位置变化 < 1% 视口 ⇒ 眼睛看不到台阶 */
    expect(worstPosition).toBeLessThan(0.01);
  });

  it('不传计划页盒：仍走旧口径（窗口平移受限），planScreen 为 null', () => {
    const far = box(6000, 300, 200, 100);
    const result = frameSonnetCameraToReadingWindow(CAMERA, base(far));
    expect(Math.abs(result.panX)).toBeLessThanOrEqual(SONNET_READING_FRAMING_MAX_PAN_RATIO + 1e-9);
    expect(result.planScreen).toBeNull();
  });
});

describe('商籁阅读窗口取景：焦点读数与连续性', () => {
  it('focusBounds 会按求解后的相机真投一遍（当前词的可读性读数）', () => {
    const window = box(500, 300, 300, 120);
    const focus: SonnetFramingBox = { minX: 440, minY: 280, maxX: 560, maxY: 320 };
    const result = frameSonnetCameraToReadingWindow(CAMERA, {
      ...base(window),
      focusBounds: focus,
    });
    expect(result.focusScreen).not.toBeNull();
    const screen = result.focusScreen as SonnetFramingBox;
    /* 轴心/锚点都在中心、相机不动 ⇒ 屏幕位置 = 中心 + (局部 − pivot) */
    expect(screen.minX).toBeCloseTo(440, 6);
    expect(screen.maxX).toBeCloseTo(560, 6);
    expect(screen.minY).toBeCloseTo(280, 6);
    expect(screen.maxY).toBeCloseTo(320, 6);
    /* 视口内的可见字宽比例 = 1（当前词完整可读） */
    const visible = Math.min(screen.maxX, VIEWPORT.viewportWidth) - Math.max(screen.minX, 0);
    expect(visible / (screen.maxX - screen.minX)).toBeCloseTo(1, 6);
  });

  it('窗口在时间上连续滑动时，相机也连续（没有位置 / 缩放跳变）', () => {
    let previous: { readonly x: number; readonly y: number; readonly zoom: number } | null = null;
    let worstPosition = 0;
    let worstZoom = 0;
    const dt = 1 / 240;
    for (let step = 0; step * dt <= 2; step += 1) {
      const progress = (step * dt) / 2;
      /* 窗口从左边一路滑到右边、同时慢慢变大 —— 模拟"窗口换块"的过程 */
      const window = box(300 + progress * 500, 300, 300 + progress * 600, 120 + progress * 200);
      const result = frameSonnetCameraToReadingWindow(CAMERA, base(window));
      if (previous !== null) {
        worstPosition = Math.max(
          worstPosition,
          Math.abs(result.camera.x - previous.x),
          Math.abs(result.camera.y - previous.y),
        );
        worstZoom = Math.max(worstZoom, Math.abs(result.camera.zoom - previous.zoom));
      }
      previous = { x: result.camera.x, y: result.camera.y, zoom: result.camera.zoom };
    }
    /* 1/240s 一步：位置变化 < 1% 视口、缩放变化 < 0.002 ⇒ 眼睛看不到台阶 */
    expect(worstPosition).toBeLessThan(0.01);
    expect(worstZoom).toBeLessThan(0.002);
  });

  it('退化输入（空窗口 / 非有限视口）不产生 NaN，也不改相机', () => {
    const emptyBox: SonnetFramingBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const empty = frameSonnetCameraToReadingWindow(CAMERA, base(emptyBox));
    expect(empty.camera).toBe(CAMERA);
    expect(empty.adjusted).toBe(false);
    const broken = frameSonnetCameraToReadingWindow(CAMERA, {
      viewportWidth: 0,
      viewportHeight: 0,
      pivotX: 0,
      pivotY: 0,
      windowBounds: box(0, 0, 100, 100),
    });
    expect(broken.camera).toBe(CAMERA);
    expect(Number.isFinite(broken.windowScreen.minX)).toBe(true);
  });

  it('默认下限 / 上限就是文件里那两个常量（验收读数的基准）', () => {
    expect(SONNET_READING_FRAMING_MIN_ZOOM_RATIO).toBeCloseTo(0.78, 12);
    expect(SONNET_READING_FRAMING_MAX_PAN_RATIO).toBeCloseTo(0.16, 12);
    /* 计划兜底的那一条：有上限（0.10）比旧口径更小、更温和。 */
    expect(SONNET_READING_FRAMING_PLAN_PAN_RATIO).toBeCloseTo(0.1, 12);
    expect(SONNET_READING_FRAMING_PLAN_PAN_RATIO).toBeLessThan(SONNET_READING_FRAMING_MAX_PAN_RATIO);
  });
});
