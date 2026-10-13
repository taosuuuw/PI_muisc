/**
 * 商籁**分层相机补偿**的用例。
 *
 * 上游事实（`sonnetShotFrame.ts:145~181`）：正文、guide、frameDecor、主体 MG 共用
 * `view.container` 的相机变换（层内不做补偿）；只有粒子层 `mgParticleLayer` 独立，
 * `position = 相机平移 × 0.4`（正号）、`rotation = (time − shotStart) × 0.05`。
 *
 * 所以这里要守住三件事：
 * ① 除粒子层外**没有**任何额外相机补偿（本地恒 identity ⇒ 与正文逐点共享 `world`）；
 * ② 粒子层只有**正向** 0.4 视差与镜内自转，没有反向平移、也没有拿整场 zoom 去逆向缩放；
 * ③ **出场歌词**（换镜后还在淡出的旧句）拿到 `当前 world⁻¹ · 快照时的 world` 这份补偿后，
 *    屏幕落点逐点等于换镜前的落点（不随新相机跳），退化输入退回 identity、绝不产生 NaN。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_AFFINE_IDENTITY,
  SONNET_PARTICLE_PARALLAX_RATIO,
  SONNET_PARTICLE_SWIM_RAD_PER_SEC,
  resolveSonnetExitCameraCompensation,
  resolveSonnetLayerCameraTransform,
  resolveSonnetParticleSwimRotation,
  type SonnetAffineMatrix,
  type SonnetCameraLayer,
  type SonnetLayerViewport,
} from './sonnetLayerCamera';

const VIEWPORT: SonnetLayerViewport = { width: 1000, height: 600 };
const CAMERA = { x: 0.12, y: -0.04, zoom: 1.19, rotation: 0.2 };

describe('商籁分层相机：只有粒子层有补偿', () => {
  it('正文 / 背景 MG / 构图 / 五线谱 / 外层元数据逐层恒 identity ⇒ 共享同一 world 变换', () => {
    const shared: SonnetCameraLayer[] = ['outerMetadata', 'bgMg', 'shape', 'staff'];
    for (const layer of shared) {
      expect(resolveSonnetLayerCameraTransform(layer, CAMERA, VIEWPORT)).toEqual({
        x: 0,
        y: 0,
        scale: 1,
      });
    }
  });

  it('共享层的参考点与正文参考点经 world 后落点相同（不存在相对滑动）', () => {
    const pivot = { x: 320, y: 260 };
    const reference = { x: 420, y: 300 };
    /* 正文（= 只走 world 变换）的落点。 */
    const worldPoint = (point: { x: number; y: number }): { x: number; y: number } => {
      const localX = (point.x - pivot.x) * CAMERA.zoom;
      const localY = (point.y - pivot.y) * CAMERA.zoom;
      const cosine = Math.cos(CAMERA.rotation);
      const sine = Math.sin(CAMERA.rotation);
      return {
        x: 500 + CAMERA.x * VIEWPORT.width + localX * cosine - localY * sine,
        y: 288 + CAMERA.y * VIEWPORT.height + localX * sine + localY * cosine,
      };
    };
    /** 某一层上的同一点：world 变换 + 该层自己的补偿。 */
    const layerPoint = (layer: SonnetCameraLayer): { x: number; y: number } => {
      const base = worldPoint(reference);
      const offset = resolveSonnetLayerCameraTransform(layer, CAMERA, VIEWPORT);
      return { x: base.x + offset.x, y: base.y + offset.y };
    };
    for (const layer of ['outerMetadata', 'bgMg', 'shape', 'staff'] as const) {
      expect(layerPoint(layer)).toEqual(worldPoint(reference));
    }
    /* 粒子层则恰好差那 0.4 的视差 —— 这是唯一被允许的额外位移 ✓。 */
    expect(layerPoint('decor').x - worldPoint(reference).x).toBeCloseTo(
      CAMERA.x * VIEWPORT.width * SONNET_PARTICLE_PARALLAX_RATIO,
      12,
    );
  });

  it('粒子层：+0.4 相机平移（正号）、不反向补偿、也不拿 zoom 逆向缩放', () => {
    const transform = resolveSonnetLayerCameraTransform('decor', CAMERA, VIEWPORT);
    expect(transform.x).toBeCloseTo(CAMERA.x * VIEWPORT.width * SONNET_PARTICLE_PARALLAX_RATIO, 12);
    expect(transform.y).toBeCloseTo(CAMERA.y * VIEWPORT.height * SONNET_PARTICLE_PARALLAX_RATIO, 12);
    expect(transform.x).toBeCloseTo(48, 12);
    expect(transform.y).toBeCloseTo(-9.6, 12);
    /* 缩放恒 1：帧层没有单独给出 cameraMotion.scale，拿整场 zoom 去缩 0.3 是伪造相机运动 ✓。 */
    expect(transform.scale).toBe(1);
    /* 旧实现的"远景层反向补偿"是 −(1 − depth)×camera×视口（此处约 −72 / +24）—— 不得复现 ✗。 */
    expect(transform.x).not.toBeCloseTo(-(1 - 0.4) * CAMERA.x * VIEWPORT.width, 6);
    expect(transform.y).not.toBeCloseTo(-(1 - 0.4) * CAMERA.y * VIEWPORT.height, 6);
  });

  it('非法相机值当 0：不会把 NaN 带进层变换', () => {
    const transform = resolveSonnetLayerCameraTransform(
      'decor',
      { x: Number.NaN, y: Number.POSITIVE_INFINITY },
      { width: Number.NaN, height: 600 },
    );
    expect(transform).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe('商籁分层相机：粒子层镜内自转', () => {
  it('按绝对时间求值（seek 确定性），不是逐帧累加', () => {
    expect(SONNET_PARTICLE_SWIM_RAD_PER_SEC).toBe(0.05);
    expect(resolveSonnetParticleSwimRotation(10, 4)).toBeCloseTo(6 * 0.05, 12);
    /* 同一时刻无论从哪一帧算过来都同值：t=25.5、镜起 4 ⇒ (25.5 − 4) × 0.05。 */
    expect(resolveSonnetParticleSwimRotation(25.5, 4)).toBeCloseTo(21.5 * 0.05, 12);
    expect(resolveSonnetParticleSwimRotation(25.5, 4) - resolveSonnetParticleSwimRotation(10, 4)).toBeCloseTo(
      15.5 * 0.05,
      12,
    );
  });

  it('非有限的时刻当 0', () => {
    expect(resolveSonnetParticleSwimRotation(Number.NaN, 4)).toBeCloseTo(-4 * 0.05, 12);
    expect(resolveSonnetParticleSwimRotation(10, Number.NaN)).toBeCloseTo(10 * 0.05, 12);
  });
});

/*
 * === 出场歌词的相机补偿 ===
 *
 * 换镜时 `world` 已经在同一帧更早的位置换成新镜头，出场层若直接挂在 `world` 下就会
 * 用**新相机**投影旧句的局部坐标 ⇒ 屏幕上"啪"地跳一下再淡出。
 * `L = 当前 world⁻¹ · 快照时的 world` 让 `当前 world · L · p ≡ 快照时的 world · p`。
 */
/** 一份 `world` 的 pose（pivot / position / 均匀 scale / rotation）→ 二维仿射。 */
function poseMatrix(pose: {
  pivotX: number;
  pivotY: number;
  positionX: number;
  positionY: number;
  scale: number;
  rotation: number;
}): SonnetAffineMatrix {
  const a = Math.cos(pose.rotation) * pose.scale;
  const b = Math.sin(pose.rotation) * pose.scale;
  const c = -b;
  const d = a;
  return {
    a,
    b,
    c,
    d,
    tx: pose.positionX - (pose.pivotX * a + pose.pivotY * c),
    ty: pose.positionY - (pose.pivotX * b + pose.pivotY * d),
  };
}

function applyMatrix(matrix: SonnetAffineMatrix, point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.tx,
    y: matrix.b * point.x + matrix.d * point.y + matrix.ty,
  };
}

function compose(outer: SonnetAffineMatrix, inner: SonnetAffineMatrix): SonnetAffineMatrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

describe('商籁出场歌词：换镜后停在旧屏幕位置', () => {
  const previous = poseMatrix({
    pivotX: 480,
    pivotY: 350,
    positionX: 500,
    positionY: 380,
    scale: 1.05,
    rotation: 0.05,
  });
  const current = poseMatrix({
    pivotX: 900,
    pivotY: 300,
    positionX: 610,
    positionY: 300,
    scale: 0.82,
    rotation: -0.03,
  });
  const points = [
    { x: 0, y: 0 },
    { x: 480, y: 350 },
    { x: 1080, y: 260 },
    { x: 140, y: 620 },
  ];

  it('`当前 world · L · p` 逐点等于快照时的屏幕落点（旧句不跟着新相机跳）', () => {
    const compensation = resolveSonnetExitCameraCompensation(current, previous);
    for (const point of points) {
      const before = applyMatrix(previous, point);
      const after = applyMatrix(compose(current, compensation), point);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it('每帧按新相机重算：新相机怎么变，等效变换都还是快照时那一份', () => {
    const compensationA = resolveSonnetExitCameraCompensation(current, previous);
    const otherCurrent = poseMatrix({
      pivotX: 200,
      pivotY: 560,
      positionX: 300,
      positionY: 700,
      scale: 1.24,
      rotation: 0.11,
    });
    const compensationB = resolveSonnetExitCameraCompensation(otherCurrent, previous);
    /* 两份补偿确实不同（不是把新相机拷给出场层）。 */
    expect(compensationA.tx).not.toBeCloseTo(compensationB.tx, 3);
    for (const point of points) {
      const before = applyMatrix(previous, point);
      expect(applyMatrix(compose(otherCurrent, compensationB), point).x).toBeCloseTo(before.x, 6);
      expect(applyMatrix(compose(otherCurrent, compensationB), point).y).toBeCloseTo(before.y, 6);
    }
  });

  it('相机没变时补偿是单位阵（活动内容不会被平白挪一下）', () => {
    const compensation = resolveSonnetExitCameraCompensation(previous, previous);
    expect(compensation.a).toBeCloseTo(1, 9);
    expect(compensation.b).toBeCloseTo(0, 9);
    expect(compensation.c).toBeCloseTo(0, 9);
    expect(compensation.d).toBeCloseTo(1, 9);
    expect(compensation.tx).toBeCloseTo(0, 9);
    expect(compensation.ty).toBeCloseTo(0, 9);
  });

  it('退化输入（奇异矩阵 / 非有限）退回 identity，绝不产生 NaN', () => {
    const singular: SonnetAffineMatrix = { a: 0, b: 0, c: 0, d: 0, tx: 10, ty: 20 };
    expect(resolveSonnetExitCameraCompensation(singular, previous)).toEqual(SONNET_AFFINE_IDENTITY);
    expect(
      resolveSonnetExitCameraCompensation(previous, { ...previous, tx: Number.NaN }),
    ).toEqual(SONNET_AFFINE_IDENTITY);
    expect(
      resolveSonnetExitCameraCompensation({ ...previous, a: Number.POSITIVE_INFINITY }, previous),
    ).toEqual(SONNET_AFFINE_IDENTITY);
  });
});
