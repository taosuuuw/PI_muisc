/**
 * 商籁**分层相机补偿**（纯函数）。
 *
 * === 上游事实（`sonnetShotFrame.ts:145~181`）===
 * 正文、引导线、词级边框、主体 MG（bg / geo / fixedGeo）**全部**挂在同一个
 * `view.container` 下，共享它的 pivot / scale / rotation / position ⇒ 这些层**不做任何**相机补偿；
 * 唯一独立的是粒子层 `mgParticleLayer`：`position = 相机平移 × 0.4`（**正号**）、
 * `rotation = (time − shotStart) × 0.05`、`scale = 1 + (cameraMotion.scale − 1) × 0.3`。
 *
 * === 我们之前错在哪 ===
 * `SonnetTheme.tsx` 曾给背景 MG / 构图 / 五线谱 / 外层元数据各按"深度"做**反向**平移
 * （`−(1 − depth) × camera`）与**逆向**缩放（`(1 + (zoom − 1) × depth) / zoom`）⇒
 * 歌词（同一 world）不动、背景往后滑，相对位移与上游不同。
 * 现在取消这套泛用 2.5D：这些层**逐值共享 `world`**（本地恒 identity）。
 *
 * === 为什么粒子层不缩 0.3 ===
 * 帧层只给得到**整场** `zoom`（已含取景拉远比），拿它冒充 `cameraMotion.scale` 去算
 * `1 + (x − 1) × 0.3` 是伪造相机运动 ⇒ 这一段只搬"正向 0.4 平移 + 镜内自转"两件，
 * 缩放保持 1。要接真 `cameraMotion.scale`，得先让帧层把它单列出来。
 */

/** 与正文共享同一 `world` 变换的层（渲染层仍调用本模块取值，但拿到的恒是 identity）。 */
export type SonnetSharedCameraLayer = 'outerMetadata' | 'bgMg' | 'shape' | 'staff';
/** 所有参与相机的层。 */
export type SonnetCameraLayer = SonnetSharedCameraLayer | 'decor';

/** 粒子层的相机视差比（上游 `sonnetShotFrame.ts:168`：`× 0.4`，正号）。 */
export const SONNET_PARTICLE_PARALLAX_RATIO = 0.4;
/** 粒子层的镜内自转角速度（弧度 / 秒；上游 `sonnetShotFrame.ts:173`：`× 0.05`）。 */
export const SONNET_PARTICLE_SWIM_RAD_PER_SEC = 0.05;

export interface SonnetLayerCameraLike {
  /** 相机横向平移（画面比例）。 */
  readonly x: number;
  /** 相机纵向平移（画面比例）。 */
  readonly y: number;
}

export interface SonnetLayerViewport {
  readonly width: number;
  readonly height: number;
}

/** 一层在 `world` **内部**额外施加的本地变换（identity = 与正文逐点共享 world）。 */
export interface SonnetLayerTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

const IDENTITY: SonnetLayerTransform = { x: 0, y: 0, scale: 1 };

/**
 * 这一层要额外施加的本地变换。
 *
 * 共享层恒为 identity ⇒ 它们与正文（以及拖尾、词级几何）逐点共享
 * `pivot / scale / rotation / position`，画面上不存在"歌词固定而背景滑动"的相对位移 ✓；
 * 只有粒子层拿到 `+ 0.4 × 相机平移`（单位与 `world.position` 的平移量一致 = 视口像素 × 比例）✓。
 */
export function resolveSonnetLayerCameraTransform(
  layer: SonnetCameraLayer,
  camera: SonnetLayerCameraLike,
  viewport: SonnetLayerViewport,
): SonnetLayerTransform {
  if (layer !== 'decor') return IDENTITY;
  const cameraX = Number.isFinite(camera.x) ? camera.x : 0;
  const cameraY = Number.isFinite(camera.y) ? camera.y : 0;
  const width = Number.isFinite(viewport.width) ? viewport.width : 0;
  const height = Number.isFinite(viewport.height) ? viewport.height : 0;
  return {
    x: cameraX * width * SONNET_PARTICLE_PARALLAX_RATIO,
    y: cameraY * height * SONNET_PARTICLE_PARALLAX_RATIO,
    scale: 1,
  };
}

/**
 * 粒子层的镜内自转（弧度）。**按绝对时间求值**（不是逐帧累加）⇒ 掉帧、暂停、
 * 拖进度条 / seek 都得到同一画面 ✓。
 */
export function resolveSonnetParticleSwimRotation(timeSec: number, shotStartTime: number): number {
  const time = Number.isFinite(timeSec) ? timeSec : 0;
  const start = Number.isFinite(shotStartTime) ? shotStartTime : 0;
  return (time - start) * SONNET_PARTICLE_SWIM_RAD_PER_SEC;
}

/*
 * === 出场歌词的相机补偿（换镜时"旧句别跟着新相机跳"）===
 *
 * 渲染层是**单 world + 按 index 复用的字形池**：换句那一刻，旧句被快照到出场层，而 `world`
 * 已经在**同一帧更早的位置**换成了新镜头的 pivot / position / scale / rotation。出厂层若是
 * 直接挂在 `world` 下、用旧句的 **world 局部坐标**画，换镜后它就按**新相机**投影 ⇒
 * 旧句在屏幕上"啪"地跳到新位置，再淡出 ✗。
 *
 * 解法：给出场层一个**本地补偿变换** `L = 当前 world⁻¹ · 上一帧 world`。这样
 *   `当前 world · L · p = 上一帧 world · p`
 * 对任意旧句局部点 `p` 都成立 ⇒ 旧句**停在换镜前的屏幕位置**淡出 ✓。
 * 补偿每帧按**新相机**重算（不是把新相机拷给出场层），活动歌词一行不动 ✓。
 *
 * ⚠ 这里只做**二维仿射**（渲染层的 `world` 是 pivot/position/rotation/均匀 scale 组合，
 * 仍是相似变换），不认识 Pixi 类型 ⇒ 纯函数、可单测。
 */
export interface SonnetAffineMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

/** 补偿算不出来（奇异矩阵 / 非有限值）时的兜底：不做补偿（旧行为）。 */
export const SONNET_AFFINE_IDENTITY: SonnetAffineMatrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function finiteAffine(matrix: SonnetAffineMatrix): boolean {
  return (
    Number.isFinite(matrix.a) &&
    Number.isFinite(matrix.b) &&
    Number.isFinite(matrix.c) &&
    Number.isFinite(matrix.d) &&
    Number.isFinite(matrix.tx) &&
    Number.isFinite(matrix.ty)
  );
}

/**
 * 出场层的本地补偿：`L = current⁻¹ · previous`。
 *
 * `current` = 这一帧已经施加的新 `world` 变换；`previous` = **画旧句那一帧**的 `world` 变换。
 * 退化输入（非有限 / 行列式≈0，例如缩放到 0）返回 identity —— 宁可"旧句跟着相机走"，
 * 也不要写出 NaN 把整棵场景搞成空白。
 */
export function resolveSonnetExitCameraCompensation(
  current: SonnetAffineMatrix,
  previous: SonnetAffineMatrix,
): SonnetAffineMatrix {
  if (!finiteAffine(current) || !finiteAffine(previous)) return SONNET_AFFINE_IDENTITY;
  const determinant = current.a * current.d - current.b * current.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) {
    return SONNET_AFFINE_IDENTITY;
  }
  /* current 的逆（仿射）。 */
  const ia = current.d / determinant;
  const ib = -current.b / determinant;
  const ic = -current.c / determinant;
  const id = current.a / determinant;
  const itx = (current.c * current.ty - current.d * current.tx) / determinant;
  const ity = (current.b * current.tx - current.a * current.ty) / determinant;
  /* 逆 × previous（与 Pixi 的 `Matrix.append` 同序：this = this × matrix）。 */
  const a = previous.a * ia + previous.b * ic;
  const b = previous.a * ib + previous.b * id;
  const c = previous.c * ia + previous.d * ic;
  const d = previous.c * ib + previous.d * id;
  const tx = previous.tx * ia + previous.ty * ic + itx;
  const ty = previous.tx * ib + previous.ty * id + ity;
  const result = { a, b, c, d, tx, ty };
  return finiteAffine(result) ? result : SONNET_AFFINE_IDENTITY;
}
