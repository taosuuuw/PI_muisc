/**
 * 商籁**镜头取景约束**（纯函数）。
 *
 * === 两个口径，别混淆 ===
 * · **生产口径** = `frameSonnetCameraToReadingWindow`：**缩放**依据是**阅读窗口**
 *   （当前词组 + 前后近邻，由 `sonnetReadingWindow.ts` **连续**算出），缩放下限 0.78
 *   （长歌词不再为"整镜 fit"缩成小字，装不下的部分越过画面边缘出血）；
 *   **平移**依据是**预测焦点的舒适区**（`planBounds` = `sonnetFrame.cameraFocus` 的四至，
 *   由 `sonnetCameraFocus.ts` 按"语义词组中心的高斯融合 + 少量 lookahead"连续算出，舒适区
 *   固定取 0.30W / 0.28H 按世界缩放折算），而且**只做温和兜底**：
 *   有修正上限（默认 0.10 视口）、边距宽容（左右 3% / 上下 4%），
 *   所以它**不会**在换块那一帧把镜头拉回"当前正在唱的那几个字"。
 *   不传 `planBounds` 时退回"平移盯窗口 + 0.16 视口上限"的旧行为（既有数学用例照旧）✓。
 * · **旧口径** = `frameSonnetCameraToBody`：把传入的**整块正文**放进硬安全区、按运动保留区拉远，
 *   无缩放下限、平移不限。它现在的用途是**对照与既有数学用例**（`createSonnetCameraFramer` 也一样），
 *   生产层已经不用 —— 因为"整镜全部落位都塞进画面"正是要避免的错目标。
 *
 * 两者共用同一个取景内核 `frameSonnetCameraToStage`，只差三个旋钮：
 * `minZoomRatio` / `maxPanRatio` / `fitMode`（保留区 or 安全区）。
 *
 * === 它解决什么问题（旧口径下的毛病）===
 * 帧层的取景锚点会把整镜内容摆到 `(0.5 + camera.x, 0.48 + camera.y ± 0.025)` 上，
 * 逐字跟拍焦点又只按"这一段的首尾中点与当前字的中点"走（`sonnetCameraTracking.ts` 的
 * `trackingFactor`）⇒ **整镜文本比焦点附近那几个字宽得多时，运镜之后画面上只剩一小截** ✗；
 * 而"把整镜塞进去"又会把字缩成小字、一屏塞几句 ✗。阅读窗口（缩放）+ 预测焦点（平移）是这两条之间的正解。
 *
 * ⚠ **平移那一步是"软"的**：旧版用硬 `clamp`，把正文中心钉到安全区边线的那一帧，
 * 画面速度会**一步掉到 0**（实测 60Hz：理想 20px/s ⇒ 1062px/s ⇒ 回落，加速度尖峰 62542 px/s²，
 * 同一段理想轨迹只有 1130 px/s²）—— 观感正是"生硬 / 整体突移"。
 * 现在靠边有一段 C¹ 的**连续收速**（`softClamp`，默认视口边长的 6%），其余位置逐值不变：
 * ① 正文仍**完整落在硬安全区**内；② 没有速度台阶；③ 纯函数、只看输入 ⇒ seek / 帧率无关 ✓。
 *
 * === 四条纪律 ===
 * ① **不改排版**：不推字、不改字号 / 字距，只动整棵 `world` 的相机参数 ⇒ 字、拖尾、词级几何
 *    仍在同一套局部坐标里配合（所以是"外层统一调整"，不是逐个字夹取）✓。
 * ② **稳定优先**：范围取的是**落位几何**（`SonnetGlyphSpec` 里恒定的 `x/y/fontPx/layoutRotation`），
 *    **不随**逐字 `alpha`、入场位移（`deltaX/deltaY`）、入场旋转（`rotation`）或入场缩放变化
 *    （`scale` 一律按落位 1 量）⇒ 入场滑入时取景不会抽动 ✓。
 *    范围按"镜 / 视口 / 字体族 / 逐字落位几何"记忆化（`createSonnetCameraFramer`），不是每 tick 重量 ✓。
 * ③ **原构图逐值不变**：正文已经落在运动保留区里、且没出硬安全区的镜头
 *    **原样返回传入的 camera 对象**（同一个引用）✓。
 * ④ **只乘一次**：拉远比例直接乘在原 `zoom` 上（`zoomRatio ≤ 1`），没有反复 multiply 的累积 ✓。
 *
 * === 坐标口径（⚠ 最容易错的一条）===
 * `world` 的局部坐标就是画布坐标，屏幕位置 =
 * `basePosition + camera.x/y × 视口 + R(rotation) · (zoom · (局部 − pivot))`。
 * 所以正文的屏幕包围盒**不是**它自己的局部包围盒 —— 必须先把四个角过一遍相机（含平移与旋转）再取范围。
 * 取景只改 `camera.x/y`（画面比例）：它按视口平移整镜，`basePosition`（帧层的取景锚点）不动 ✓。
 */

/** 正文里的一粒字：只要落位、字号与它自己的**落位**旋转（都来自 `SonnetGlyphSpec`）。 */
export interface SonnetFramingGlyph {
  readonly x: number;
  readonly y: number;
  readonly fontPx: number;
  /** 这一粒字**当前**的旋转（弧度，含入场偏转）。只有缺 `layoutRotation` 时才拿它当落位角。 */
  readonly rotation: number;
  /** **落位旋转**（`SonnetGlyphSpec.layoutRotation`，不含入场偏转）：有就优先用它 ✓。 */
  readonly layoutRotation?: number;
  /**
   * 字身缩放（入场 `0.86 → 1`）。取景**一律按落位 1 量**、忽略此值 ⇒ 入场期间画面不变
   * （见 `resolveSonnetBodyBounds` 的注释）✓。
   */
  readonly scale?: number;
  /** 文字内容（量真实字形宽度要用它）。 */
  readonly text: string;
  /** 字重（只影响测量缓存的键）。 */
  readonly weight: number;
}

/** 量一行字的真实像素宽（拿不到 2D 上下文时可以返回 `NaN` ⇒ 退回 0.62 估算）。 */
export type SonnetFramingMeasureWidth = (text: string, fontPx: number, weight: number) => number;

/** 相机（与 `SonnetFrame.camera` 的四个数值字段同口径：`x/y` 是**画面比例**，`zoom/rotation` 是画面级变换）。 */
export interface SonnetCameraLike {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly rotation: number;
}

/** 轴对齐矩形（局部：画布像素；屏幕：实际像素）。 */
export interface SonnetFramingBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface SonnetCameraFramingOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** 本镜轴心（画布像素，= `SonnetFrame.pivot`）：旋转与缩放绕它走。 */
  readonly pivotX: number;
  readonly pivotY: number;
  /**
   * **取景锚点**（画布像素；不传 = `viewportWidth × 0.5` / `viewportHeight × 0.48`，保留旧口径）。
   * 帧层的 `world.position` 就等于它 + `camera.x/y × 视口`，投影必须用同一条式子（见文件头）。
   */
  readonly basePositionX?: number;
  readonly basePositionY?: number;
  /** 正文的**局部**落位范围（由 `resolveSonnetBodyBounds` 给出）。 */
  readonly bodyBounds: SonnetFramingBox;
  /**
   * **平移锚点范围**（可选；缺省 = `bodyBounds`）。
   *
   * `bodyBounds` 决定**缩放**（把该范围装进判据框），`panBounds` 决定**平移**（把它的中心
   * 移进安全区）。两者分开是为了"缩放看阅读窗口（当前词 + 邻块）、平移盯当前唱词几何"：
   * 窗口的加权中心会被空间上分散的邻块拉偏，用它做平移就会把当前词推出画面 ✗。
   */
  readonly panBounds?: SonnetFramingBox;
  /**
   * 硬安全区边距（**视口比例**）：左右各 5%、上下各 6% ⇒ 屏上留出约 90% × 88% 的可读区 ✓。
   * 极小视口下会被夹到"每边不超过一半"⇒ 安全区永远合法（不会左右翻转）✓。
   */
  readonly marginXRatio?: number;
  readonly marginYRatio?: number;
  /**
   * **运动留白**（视口比例，默认左右 / 上下各 6%）：安全区再往各边收这么多 ⇒ 正文最大只放到
   * `90% − 12% = 78%` 宽、`88% − 12% = 76%` 高，于是 `camera.x/y`（摇移）、pivot 与呼吸
   * 在硬安全区里还剩 6% 的行程，不会被边缘 clamp 一帧帧抹平 ✓。
   * 只在正文**外接尺寸**超过保留区时才触发拉远；原小构图逐值不动 ✓。
   */
  readonly motionMarginXRatio?: number;
  readonly motionMarginYRatio?: number;
  /**
   * **软饱和带宽**（**视口边长的比例**，默认 `SONNET_FRAMING_SOFT_BAND_RATIO = 0.06`）：
   * 见 `softClamp` —— 它把硬 `clamp` 的"速度一步归零"换成"连续收速"。
   * 传 `0` 就退回旧的硬夹取（只给需要逐值对齐旧读数的用例用，生产层不传 ✓）。
   */
  readonly softBandRatio?: number;
}

export interface SonnetCameraFramingResult {
  /** 满足取景约束的相机四值（无需改动时**就是传入的那个对象** ✓）。 */
  readonly camera: SonnetCameraLike;
  /** 约束后正文在**屏幕**上的包围盒（探针 / 用例用；由返回的相机真投四角得来 ✓）。 */
  readonly bodyScreen: SonnetFramingBox;
  /** 这一镜有没有被约束过（`false` 时 `camera` 与传入对象逐值相同）。 */
  readonly adjusted: boolean;
  /** 为留出运动余量实际施加的缩放比（≤ 1；未触发拉远时为 1）。 */
  readonly zoomRatio: number;
}

/** 硬安全区边距的默认值：左右 5%、上下 6%（见 `marginXRatio` 的注释）。 */
export const SONNET_FRAMING_MARGIN_X = 0.05;
export const SONNET_FRAMING_MARGIN_Y = 0.06;
/**
 * 运动留白的默认值：左右 / 上下**各 6%**（见 `motionMarginXRatio` 的注释）。
 * 与硬安全区相加就是保留区：左右 11%、上下 12% ⇒ 正文最大约 78% × 76% 画面 ✓。
 */
export const SONNET_FRAMING_MOTION_MARGIN_X = 0.06;
export const SONNET_FRAMING_MOTION_MARGIN_Y = 0.06;
/**
 * **软饱和带宽**（**视口边长的比例**，默认 6%）：见 `softClamp`。
 *
 * 为什么需要它（这不是自选动作，是实测出来的）：硬 `clamp` 把"正文中心"钉在安全区边线上时，
 * 画面速度会**一步掉到 0** —— 60Hz 采样下实测理想相机本来只有 20px/s，夹住那一刻
 * 画面位移率从 20px/s 瞬间变成 1062px/s 再回落（加速度尖峰 **62542 px/s²**，
 * 同一段理想轨迹只有 1130 px/s²）。观感就是主人说的"生硬 / 突然一顿 / 整体突移"。
 * 软饱和把这**一个速度台阶**换成一段**平滑收速**：靠边这么宽的一段内速度连续收敛到 0，
 * 其余位置逐值不变 ⇒ 没顶边的镜头读数一字不改 ✓。
 *
 * ⚠ **口径是"视口比例"而不是"可用行程的比例"**：可用行程在"正文几乎占满画面"时只剩几十像素，
 * 按行程取比例会得到一个"等于没有缓出"的带宽，收速又会变回台阶。收速距离该由**眼睛看到的
 * 画面尺度**决定（1180px 宽的视口 ⇒ 约 71px），这才在任何构图下都够用 ✓。
 */
export const SONNET_FRAMING_SOFT_BAND_RATIO = 0.06;
/**
 * **阅读窗口取景**的默认值（本轮新增，见 `frameSonnetCameraToReadingWindow`）。
 *
 * · `MIN_ZOOM_RATIO = 0.78`：**无论如何不把字缩到原字号 78% 以下** —— 这是"长歌词不再整镜 fit
 *   成小字"的硬保证；装不下的部分允许越过画面边缘（出血），而不是继续拉远；
 * · `MAX_PAN_RATIO = 0.16`：**旧口径**（不传 `planBounds` 时）镜头为"把窗口挪进安全区"
 *   最多平移 16% 视口 —— 于是窗外几个空间上分散的块**拗不动**镜头；
 * · `PLAN_PAN_RATIO = 0.10` + `PLAN_MARGIN_X/Y = 0.03 / 0.04`：**生产口径**（传 `planBounds` 时）
 *   的平移兜底 —— 修正量有上限、边距宽容，只把"预测焦点周围的固定舒适区"温和地留在画面里；
 * · 不传 `planBounds` 时边距沿用硬安全区的 5% / 6%（窗口放得下时逐值不动）。
 */
export const SONNET_READING_FRAMING_MIN_ZOOM_RATIO = 0.78;
export const SONNET_READING_FRAMING_MAX_PAN_RATIO = 0.16;
export const SONNET_READING_FRAMING_MARGIN_X = SONNET_FRAMING_MARGIN_X;
export const SONNET_READING_FRAMING_MARGIN_Y = SONNET_FRAMING_MARGIN_Y;
/**
 * **焦点兜底**的平移上限（视口比例）：预测焦点已经自己把画面带到该看的地方，
 * 这里只处理"世界缩放混合 / 运镜漂移把焦点推到边上"的残余 —— 有上限才不会把镜头拉回当前词。
 */
export const SONNET_READING_FRAMING_PLAN_PAN_RATIO = 0.1;
/** 焦点兜底的边距（视口比例）：比硬安全区宽容得多 ⇒ 边缘旧词允许贴着边、甚至少量出血。 */
export const SONNET_READING_FRAMING_PLAN_MARGIN_X = 0.03;
export const SONNET_READING_FRAMING_PLAN_MARGIN_Y = 0.04;
/** 拿不到真实测量时的字宽兜底系数（与帧层 `SONNET_OTHER_WIDTH_RATIO` 同量级）。 */
const FALLBACK_GLYPH_WIDTH_RATIO = 0.62;
/** 字高按字号乘 1.05 估（Pixi 文本节点 `anchor 0.5` ⇒ 记的是中心到边缘的半个高）。 */
const GLYPH_HEIGHT_RATIO = 1.05;
/** 极小视口下留出的兜底尺寸：安全区至少要有这么多像素，否则按"贴着画布"处理。 */
const MIN_SAFE_SPAN = 24;

function safeSpan(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 取景锚点缺省值（与旧口径 `W × 0.5` / `H × 0.48` 一致，兼容既有测试）。 */
function resolveBasePositionX(value: number | undefined, viewportWidth: number): number {
  return value !== undefined && Number.isFinite(value) ? value : viewportWidth * 0.5;
}

function resolveBasePositionY(value: number | undefined, viewportHeight: number): number {
  return value !== undefined && Number.isFinite(value) ? value : viewportHeight * 0.48;
}

/** 比例入参的缺省值（非有限值一律当缺省，免得 NaN 一路传进 `resolveMargins`）。 */
function resolveRatio(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return value < min ? min : value > max ? max : value;
}

/** 软饱和用的三次多项式 `p(s) = s²(2 − s)`：`p(0)=0`、`p(1)=1`、`p'(0)=0`、`p'(1)=1`、单调 ✓。 */
function softPolynomial(s: number): number {
  return s * s * (2 - s);
}

/** 往**下界**收的一侧：`band` 之外逐值不变，之内把距离平滑压向 0（端点斜率 0）✓。 */
function softApproachLow(value: number, bound: number, band: number): number {
  const distance = value - bound;
  if (distance <= 0) return bound;
  if (distance >= band) return value;
  return bound + band * softPolynomial(distance / band);
}

/** 往**上界**收的一侧（与 `softApproachLow` 对称）：`band` 之外逐值不变 ✓。 */
function softApproachHigh(value: number, bound: number, band: number): number {
  const distance = bound - value;
  if (distance <= 0) return bound;
  if (distance >= band) return value;
  return bound - band * softPolynomial(distance / band);
}

/**
 * **C¹ 软限位**（这一层唯一与"硬 `clamp`"不同的地方）。
 *
 * 性质（每一条都有用例守着）：
 * ① `value` 落在 `[min + band, max − band]` 时**逐值等于输入** ⇒ 没靠边的镜头一致不变 ✓；
 * ② 落在靠边 `band` 之内时输出仍留在 `[min, max]`（正文不会跑出安全区 ✓），
 *    但速度按 `p'(s) = 4s − 3s²` 从 1 连续降到 0 ⇒ **没有速度台阶** ✓；
 * ③ `value` 超出 `[min, max]` 时输出**就是边界值**（与硬 `clamp` 逐值相同 ✓）；
 * ④ 单调不增不减 ⇒ 不会把两个不同的相机位置映到同一个点再跳回来 ✓；
 * ⑤ 纯函数、无状态、只看输入 ⇒ seek / 帧率无关 ✓。
 */
export function softClamp(value: number, min: number, max: number, band: number): number {
  if (!(max > min)) return (min + max) / 2;
  const span = max - min;
  const safeBand = Number.isFinite(band) ? Math.min(span / 2, Math.max(0, band)) : 0;
  if (safeBand <= 0) return clamp(value, min, max);
  return softApproachHigh(softApproachLow(value, min, safeBand), max, safeBand);
}

/** 把 `ratio` 夹进 `[0, 0.5)` 的合法比例（`0.5` 会让安全区宽度归零）。 */
function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return ratio > 0.45 ? 0.45 : ratio;
}

function resolveMargins(
  viewportWidth: number,
  viewportHeight: number,
  marginXRatio: number,
  marginYRatio: number,
): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } {
  const ratioX = clampRatio(marginXRatio);
  const ratioY = clampRatio(marginYRatio);
  let left = viewportWidth * ratioX;
  let right = viewportWidth * ratioX;
  let top = viewportHeight * ratioY;
  let bottom = viewportHeight * ratioY;
  /*
   * 极小视口：按比例算出来的边距可能把安全区挤成负数（甚至左右翻转）。
   * 这里**只收不放**：先按"安全区至少一排像素"夹到一半，再退到 `MIN_SAFE_SPAN`。
   */
  const maxX = Math.max(0, (viewportWidth - MIN_SAFE_SPAN) / 2);
  const maxY = Math.max(0, (viewportHeight - MIN_SAFE_SPAN) / 2);
  left = Math.min(left, maxX);
  right = Math.min(right, maxX);
  top = Math.min(top, maxY);
  bottom = Math.min(bottom, maxY);
  return { left, right, top, bottom };
}

function resolveGlyphHalfWidth(glyph: SonnetFramingGlyph, measureWidth: SonnetFramingMeasureWidth): number {
  const measured = measureWidth(glyph.text, glyph.fontPx, glyph.weight);
  const width =
    Number.isFinite(measured) && measured > 0 ? measured : glyph.fontPx * FALLBACK_GLYPH_WIDTH_RATIO;
  return Math.max(width, glyph.fontPx * 0.2) / 2;
}

/**
 * 正文的**局部落位范围**（画布像素）。
 *
 * 逐字算它自己的 4 个角（含**落位**旋转）再取范围 ⇒ 整镜所有字的外接矩形。
 * 入场偏转（`rotation` 缺 `layoutRotation` 时才退回它）与入场缩放（`scale` 一律按 1）
 * **不参与**：这两个量逐帧变，参与进来取景就会抽动 ✓。
 * `measureWidth` 拿不到时按 `0.62 × 字号` 估宽（CJK 会在 `0.2 × 字号` 下限处偏保守）。
 */
export function resolveSonnetBodyBounds(
  glyphs: readonly SonnetFramingGlyph[],
  measureWidth: SonnetFramingMeasureWidth,
): SonnetFramingBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const glyph of glyphs) {
    if (
      !Number.isFinite(glyph.x) ||
      !Number.isFinite(glyph.y) ||
      !Number.isFinite(glyph.fontPx) ||
      glyph.fontPx <= 0
    ) {
      continue;
    }
    const halfW = resolveGlyphHalfWidth(glyph, measureWidth);
    const halfH = (glyph.fontPx * GLYPH_HEIGHT_RATIO) / 2;
    /* 落位一律按 `scale = 1`；旋转优先用不含入场偏转的 `layoutRotation` ✓。 */
    const layoutRotation = glyph.layoutRotation;
    const rotation =
      layoutRotation !== undefined && Number.isFinite(layoutRotation)
        ? layoutRotation
        : Number.isFinite(glyph.rotation)
          ? glyph.rotation
          : 0;
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    for (const [signX, signY] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const localX = signX * halfW;
      const localY = signY * halfH;
      const x = glyph.x + localX * cosine - localY * sine;
      const y = glyph.y + localX * sine + localY * cosine;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 正文的局部**中心**到屏幕中心的偏移（`R(rotation) · (zoom · (中心 − pivot))`）。
 *
 * ⚠ 轴心不等于正文中心时，这个偏移会让"锚点落点"与"正文落点"分家 ——
 * 取景的平移必须按它来算（见 `frameSonnetCameraToBody`）。
 */
function resolveRotationOffset(
  bounds: SonnetFramingBox,
  pivotX: number,
  pivotY: number,
  zoom: number,
  rotation: number,
): { readonly x: number; readonly y: number } {
  const relativeX = (bounds.minX + bounds.maxX) / 2 - pivotX;
  const relativeY = (bounds.minY + bounds.maxY) / 2 - pivotY;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return {
    x: (relativeX * cosine - relativeY * sine) * zoom,
    y: (relativeX * sine + relativeY * cosine) * zoom,
  };
}

/**
 * 把正文**局部**四角真投一遍相机，取屏幕包围盒（读数与限位都用这个）。
 * 屏幕 = `basePosition + camera.x/y × 视口 + R(rotation) · (zoom · (局部 − pivot))`。
 */
function projectSonnetBodyBounds(input: {
  readonly bounds: SonnetFramingBox;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly basePositionX: number;
  readonly basePositionY: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly cameraX: number;
  readonly cameraY: number;
  readonly zoom: number;
  readonly rotation: number;
}): SonnetFramingBox {
  const cosine = Math.cos(input.rotation);
  const sine = Math.sin(input.rotation);
  const originX = input.basePositionX + input.cameraX * input.viewportWidth;
  const originY = input.basePositionY + input.cameraY * input.viewportHeight;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [cornerX, cornerY] of [
    [input.bounds.minX, input.bounds.minY],
    [input.bounds.maxX, input.bounds.minY],
    [input.bounds.maxX, input.bounds.maxY],
    [input.bounds.minX, input.bounds.maxY],
  ] as const) {
    const localX = (cornerX - input.pivotX) * input.zoom;
    const localY = (cornerY - input.pivotY) * input.zoom;
    const x = originX + localX * cosine - localY * sine;
    const y = originY + localX * sine + localY * cosine;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 把正文**完整放进硬安全区**，并让它最多只占"运动保留区"那么大。
 *
 * 顺序：
 * ① 正文**外接尺寸**不超保留区、且正文中心落在**软带之外的中心区**（软带见 `softClamp`）
 *    ⇒ **逐值不变**（原对象返回）✓；
 * ② 尺寸超保留区时，按 `limit = 保留区尺寸 / 需求尺寸` **温和拉远**（`zoom` 只减不增：
 *    不放大、不改构图气质；`rotation` 原样保留 ✓）—— 这一步就是"摇移 / 呼吸的留白"；
 * ③ 平移仍用**最小位移**把正文夹进硬安全区（左右 5% / 上下 6%，旋转后四个角都算）
 *    ⇒ 尺寸（≤ 78%×76%）与 clamp 框（90%×88%）之间恒留 6% 行程 ✓。
 *
 * ⚠ 两处必须按**正文中心**（不是锚点）来算：屏幕落点与限位。锚点是"画面中心 + 平移"，
 * 轴心不等于正文中心时两者差着 `R·(zoom·(中心 − pivot))` —— 早先按锚点夹，旋转过的构图会停偏。
 *
 * ⚠ 平移发生在屏幕空间：`camera.x/y` 是画面比例，`world.position` 里带的取景锚点会
 * 一起跟着走 ⇒ 字、拖尾、词级几何都在同一棵 `world` 里，仍严格配合 ✓。
 */
export function frameSonnetCameraToBody(
  camera: SonnetCameraLike,
  options: SonnetCameraFramingOptions,
): SonnetCameraFramingResult {
  /*
   * 旧口径 = 直接把**整块正文**（调用方给的所有正文）放进硬安全区、并按运动保留区拉远：
   * 无缩放下限、平移不限。`frameSonnetCameraToReadingWindow` 用同一套内核，只换三个旋钮。
   */
  return frameSonnetCameraToStage(camera, options, {
    minZoomRatio: 0,
    maxPanRatio: Number.POSITIVE_INFINITY,
    fitMode: 'reserve',
  });
}

/** 取景内核的三个旋钮（见 `frameSonnetCameraToReadingWindow` 的文件头）。 */
interface SonnetStageFramingKnobs {
  /** 允许的最小缩放比（`0` = 无下限，只挡非正值；旧口径）。 */
  readonly minZoomRatio: number;
  /** 平移修正上限（视口比例；`Infinity` = 不限；旧口径）。 */
  readonly maxPanRatio: number;
  /** 尺寸判据与缩放目标框：`reserve` = 运动保留区（旧口径）、`safe` = 硬安全区。 */
  readonly fitMode: 'reserve' | 'safe';
}

function frameSonnetCameraToStage(
  camera: SonnetCameraLike,
  options: SonnetCameraFramingOptions,
  knobs: SonnetStageFramingKnobs,
): SonnetCameraFramingResult {
  const viewportWidth = safeSpan(options.viewportWidth);
  const viewportHeight = safeSpan(options.viewportHeight);
  const basePositionX = resolveBasePositionX(options.basePositionX, viewportWidth);
  const basePositionY = resolveBasePositionY(options.basePositionY, viewportHeight);
  const zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
  const rotation = Number.isFinite(camera.rotation) ? camera.rotation : 0;
  const bounds = options.bodyBounds;
  const bodyWidth = bounds.maxX - bounds.minX;
  const bodyHeight = bounds.maxY - bounds.minY;
  const usableBounds = bodyWidth > 1e-6 && bodyHeight > 1e-6 ? bounds : null;
  /*
   * **平移锚点**（缺省 = 正文范围）：缩放按 `bounds`，平移按 `panBounds`。
   * 退化（零尺寸）时退回 `bounds`，免得把平移解出一个空盒的中心。
   */
  const panBoundsRaw = options.panBounds ?? bounds;
  const panBounds =
    panBoundsRaw.maxX - panBoundsRaw.minX > 1e-6 && panBoundsRaw.maxY - panBoundsRaw.minY > 1e-6
      ? panBoundsRaw
      : bounds;
  const panSpanX = panBounds.maxX - panBounds.minX;
  const panSpanY = panBounds.maxY - panBounds.minY;
  const marginXRatio = resolveRatio(options.marginXRatio, SONNET_FRAMING_MARGIN_X);
  const marginYRatio = resolveRatio(options.marginYRatio, SONNET_FRAMING_MARGIN_Y);
  const margins = resolveMargins(viewportWidth, viewportHeight, marginXRatio, marginYRatio);
  const safeMinX = margins.left;
  const safeMaxX = viewportWidth - margins.right;
  const safeMinY = margins.top;
  const safeMaxY = viewportHeight - margins.bottom;
  /*
   * **运动保留区**：安全区再往各边收 `motionMargin`（默认 6%）⇒ 1000×600 上是 x ∈ [110,890]、
   * y ∈ [72,528]（= 78% × 76% 画面 ✓）。两个边距**相加后**再过一次 `resolveMargins`：
   * 极小视口下"至少留一排像素"的夹取与安全区同一套，保留区恒在安全区之内 ⇒ 两道边界不会打架 ✓。
   */
  const reserve = resolveMargins(
    viewportWidth,
    viewportHeight,
    marginXRatio + resolveRatio(options.motionMarginXRatio, SONNET_FRAMING_MOTION_MARGIN_X),
    marginYRatio + resolveRatio(options.motionMarginYRatio, SONNET_FRAMING_MOTION_MARGIN_Y),
  );
  const reserveMinX = reserve.left;
  const reserveMaxX = viewportWidth - reserve.right;
  const reserveMinY = reserve.top;
  const reserveMaxY = viewportHeight - reserve.bottom;
  /* 把局部四角真投一遍（屏幕 = basePosition + camera×视口 + R(rotation)·(zoom·(局部 − pivot))）。 */
  const project = (
    cameraX: number,
    cameraY: number,
    zoomValue: number,
    rotationValue: number,
  ): SonnetFramingBox =>
    projectSonnetBodyBounds({
      bounds,
      pivotX: options.pivotX,
      pivotY: options.pivotY,
      basePositionX,
      basePositionY,
      viewportWidth,
      viewportHeight,
      cameraX,
      cameraY,
      zoom: zoomValue,
      rotation: rotationValue,
    });
  if (usableBounds === null || viewportWidth <= 0 || viewportHeight <= 0) {
    return {
      camera,
      bodyScreen: project(camera.x, camera.y, zoom, rotation),
      adjusted: false,
      zoomRatio: 1,
    };
  }
  /*
   * 绕 pivot 旋转会把**正文自身**转过去（不只是轴心偏移）⇒ 屏幕上的外接尺寸必须先按这一镜的
   * `zoom` 放大、再按 `rotation` 转。⚠ 顺序不能反：`R·(z·v)` 的两条边 = `z·|v|` 再转，
   * 但写成 `R·v` 再乘 `z` 也等价；**不能**只转未缩放的 `v` 就把结果当屏幕尺寸用。
   * 下面这两个解析式与 `project` 的四角投影同值，只是不必先知道平移量。
   */
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const screenWidth = (width: number, height: number, scale: number): number =>
    Math.abs(width * scale * cosine) + Math.abs(height * scale * sine);
  const screenHeight = (width: number, height: number, scale: number): number =>
    Math.abs(width * scale * sine) + Math.abs(height * scale * cosine);
  const currentWindow = project(camera.x, camera.y, zoom, rotation);
  /*
   * ⚠ 拉远只看**外接尺寸**、不看当前位置：尺寸只要不超保留区就不拉远 ——
   * 这样 `camera.x/y`（摇移）、pivot 与呼吸才有那 6% 的行程；若拿"有没有出保留区"当拉远条件，
   * 一摇到保留区边界就被推回来，又变回贴在框上的 HUD ✗。
   * （平移那一步仍是软的：靠边软带内由 `softClamp` 连续收速，见下面 ③。）
   */
  const neededWidth = screenWidth(bodyWidth, bodyHeight, zoom);
  const neededHeight = screenHeight(bodyWidth, bodyHeight, zoom);
  /*
   * **判据框**：旧口径用运动保留区（安全区再各收 6%），阅读窗口口径用硬安全区
   * —— 阅读窗口不再需要那 6% 的额外留白，窗外块本来就允许出血。
   */
  const fitMinX = knobs.fitMode === 'reserve' ? reserveMinX : safeMinX;
  const fitMaxX = knobs.fitMode === 'reserve' ? reserveMaxX : safeMaxX;
  const fitMinY = knobs.fitMode === 'reserve' ? reserveMinY : safeMinY;
  const fitMaxY = knobs.fitMode === 'reserve' ? reserveMaxY : safeMaxY;
  const fitWidth = Math.max(0, fitMaxX - fitMinX);
  const fitHeight = Math.max(0, fitMaxY - fitMinY);
  const sizeFitsFit = neededWidth <= fitWidth + 1e-9 && neededHeight <= fitHeight + 1e-9;

  /* ② 拉远到"外接尺寸 ≤ 判据框"为止（只减不增，最多拉到原 zoom）；阅读窗口另有缩放下限。 */
  const reserveWidth = fitWidth;
  const reserveHeight = fitHeight;
  /*
   * 需要的外接尺寸也在**屏幕空间**（含本镜 zoom）⇒ 拉远比例直接 `保留区尺寸 / 需要尺寸`，
   * 与"当前 zoom 是多少"无关（原式拿未缩放的尺寸去比可用区，`zoom > 1` 时会缩不够）。
   */
  let zoomRatio = 1;
  if (neededWidth > reserveWidth && neededWidth > 1e-6) {
    zoomRatio = Math.min(zoomRatio, reserveWidth / neededWidth);
  }
  if (neededHeight > reserveHeight && neededHeight > 1e-6) {
    zoomRatio = Math.min(zoomRatio, reserveHeight / neededHeight);
  }
  /* 只接受**正的有限**比例：极小视口下不再强制 `0.01` 下限（那会让极长正文永远装不下）✓。 */
  if (!Number.isFinite(zoomRatio) || zoomRatio <= 0) zoomRatio = 1;
  zoomRatio = Math.min(zoomRatio, 1);
  /*
   * **缩放下限**（阅读窗口口径）：`zoomRatio` 再低也不低于它（旧口径传 0 = 不设限）。
   * 于是"窗口装不下"只表现为**窗外块出血**，不会把正文一路缩成小字 ✓。
   */
  const minZoomRatio = Number.isFinite(knobs.minZoomRatio)
    ? Math.min(1, Math.max(0, knobs.minZoomRatio))
    : 0;
  if (zoomRatio < minZoomRatio) zoomRatio = minZoomRatio;
  const nextZoom = zoom * zoomRatio;
  /* 平移量算在**平移锚点中心**上（不是轴心）：绕 `pivot` 缩放/旋转后，锚点中心到轴心的向量也会转。 */
  const nextOffset = resolveRotationOffset(
    panBounds,
    options.pivotX,
    options.pivotY,
    nextZoom,
    rotation,
  );
  const panCenterScreenX = basePositionX + camera.x * viewportWidth + nextOffset.x;
  const panCenterScreenY = basePositionY + camera.y * viewportHeight + nextOffset.y;
  const halfWidth = screenWidth(panSpanX, panSpanY, nextZoom) / 2;
  const halfHeight = screenHeight(panSpanX, panSpanY, nextZoom) / 2;
  /* 硬安全区装不下时取安全区中点（居中即可，不追求"绝不压边"）✓ */
  const midX = (safeMinX + safeMaxX) / 2;
  const midY = (safeMinY + safeMaxY) / 2;
  /*
   * **软饱和带宽**（这一层与旧版唯一的差别，见 `softClamp` 与 `SONNET_FRAMING_SOFT_BAND_RATIO`）：
   * 硬 `clamp` 会让"顶到边线"那一帧的速度一步归零（实测加速度尖峰 62542 px/s² vs 理想 1130），
   * 软饱和把它换成"靠边一段内连续收速"，其余位置逐值不变 ⇒ 没进软带的镜头读数一字不改 ✓。
   * 收速距离按**视口边长**取（默认 6% ⇒ 1180px 宽的画面约 71px），并夹到可用行程的一半 ——
   * 两个边带的缓出段不会重叠，正文永远留在硬安全区里 ✓。
   */
  const softBandRatio = Math.max(0, resolveRatio(options.softBandRatio, SONNET_FRAMING_SOFT_BAND_RATIO));
  const bandFor = (span: number, viewportSpan: number): number =>
    softBandRatio <= 0
      ? /* 显式传 0 ⇒ 退回旧的硬夹取（带宽关掉）✓ */
        0
      : Math.max(0, Math.min(span / 2, Math.max(0, viewportSpan) * softBandRatio));
  const bandX = bandFor(safeMaxX - safeMinX - halfWidth * 2, viewportWidth);
  const bandY = bandFor(safeMaxY - safeMinY - halfHeight * 2, viewportHeight);
  const targetX =
    safeMinX + halfWidth > safeMaxX - halfWidth
      ? midX
      : softClamp(panCenterScreenX, safeMinX + halfWidth, safeMaxX - halfWidth, bandX);
  const targetY =
    safeMinY + halfHeight > safeMaxY - halfHeight
      ? midY
      : softClamp(panCenterScreenY, safeMinY + halfHeight, safeMaxY - halfHeight, bandY);
  /*
   * **平移上限**（阅读窗口口径）：修正量也夹进 ±`maxPanRatio × 视口`，仍用 `softClamp` 收速
   * ⇒ 窗外空间上分散的块拗不动镜头，也没有速度台阶。旧口径传 `Infinity` ⇒ 这里 `panLimit = 0`
   * ⇒ `limited = target`，逐值与旧版完全相同 ✓。
   */
  const panLimitX =
    Number.isFinite(knobs.maxPanRatio) && knobs.maxPanRatio > 0 ? knobs.maxPanRatio * viewportWidth : 0;
  const panLimitY =
    Number.isFinite(knobs.maxPanRatio) && knobs.maxPanRatio > 0 ? knobs.maxPanRatio * viewportHeight : 0;
  const panBand = (limit: number, viewportSpan: number): number =>
    softBandRatio <= 0 ? 0 : Math.max(0, Math.min(limit, Math.max(0, viewportSpan) * softBandRatio));
  const limitedX =
    panLimitX > 0
      ? softClamp(targetX, panCenterScreenX - panLimitX, panCenterScreenX + panLimitX, panBand(panLimitX, viewportWidth))
      : targetX;
  const limitedY =
    panLimitY > 0
      ? softClamp(targetY, panCenterScreenY - panLimitY, panCenterScreenY + panLimitY, panBand(panLimitY, viewportHeight))
      : targetY;
  /*
   * ③ **逐值不变**（原构图保留）：尺寸不超判据框，**且两个轴的正文中心都落在软带之外的中心区**
   *    ⇒ 软限位就是恒等映射，原样返回传入的 `camera`（同一个引用）✓。
   *
   * ⚠ 判据必须包含软带（本轮修）：旧版只判"正文有没有出硬安全区"，小正文在安全区内靠边时
   * 会走上面那条提前 `return`、**绕过软限位**，直到刚越界那一帧才被限位 —— 靠边没有收速段，
   * 速度仍是"一步断"。现在只要中心落进靠边的软带（默认 6% 视口边长）就先软限位，
   * **不必等它越界才起效**；`softBandRatio = 0` 时软带宽度为 0，判据退化成"在硬安全区内即恒等"
   * ⇒ 与旧行为逐值一致（只给逐值对齐旧读数的用例用）✓。
   */
  if (sizeFitsFit && limitedX === panCenterScreenX && limitedY === panCenterScreenY) {
    return { camera, bodyScreen: currentWindow, adjusted: false, zoomRatio: 1 };
  }
  const safeCamera: SonnetCameraLike = {
    x: (limitedX - nextOffset.x - basePositionX) / viewportWidth,
    y: (limitedY - nextOffset.y - basePositionY) / viewportHeight,
    zoom: nextZoom,
    rotation,
  };
  return {
    camera: safeCamera,
    /* 读数用**求解后的相机**把四角真投一遍，不是把理想 target 中心当验收事实 ✓。 */
    bodyScreen: project(safeCamera.x, safeCamera.y, nextZoom, rotation),
    adjusted: true,
    zoomRatio,
  };
}

/** `frameSonnetCameraToReadingWindow` 的取值上下文。 */
export interface SonnetReadingFramingOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** 本镜轴心（画布像素，= `SonnetFrame.pivot`，焦点跟拍出来的）。 */
  readonly pivotX: number;
  readonly pivotY: number;
  /** 取景锚点（画布像素；缺省与旧口径相同）。 */
  readonly basePositionX?: number;
  readonly basePositionY?: number;
  /**
   * **阅读窗口**的局部落位范围（帧层 `SonnetFrame.readingWindow` 的四至，画布像素）。
   * 这是取景的唯一尺寸依据 —— 不再是"整镜所有 glyphs"。
   */
  readonly windowBounds: SonnetFramingBox;
  /** 当前词组（活动块）的局部范围（可选；用于**读数 / 可读性验收**，不参与相机求解）。 */
  readonly focusBounds?: SonnetFramingBox;
  /**
   * **预测焦点的舒适区**（可选；= `sonnetFrame.cameraFocus` 的四至，画布像素）。
   *
   * 传了它，平移就盯这块（**预测焦点周围的固定区域**，由 `sonnetCameraFocus.ts` 按
   * "语义词组中心的高斯融合 + 少量 lookahead"连续算出），并且只做**温和兜底**：
   * 修正量上限 `planPanLimitRatio`（默认 0.10 视口）、边距宽容（`PLAN_MARGIN` 3% / 4%）。
   * 于是"换块"不会把镜头拉回当前词 —— 焦点自己连续地走，兜底只处理残余。
   *
   * 不传 ⇒ 退回旧口径：平移盯 `windowBounds`，上限 `maxPanRatio`（默认 0.16 视口）。
   */
  readonly planBounds?: SonnetFramingBox;
  readonly marginXRatio?: number;
  readonly marginYRatio?: number;
  /** 缩放下限（见 `SONNET_READING_FRAMING_MIN_ZOOM_RATIO`，默认 0.78）。 */
  readonly minZoomRatio?: number;
  /** 旧口径（不传 `planBounds` 时）的平移修正上限（见 `SONNET_READING_FRAMING_MAX_PAN_RATIO`）。 */
  readonly maxPanRatio?: number;
  /** 计划兜底的平移修正上限（见 `SONNET_READING_FRAMING_PLAN_PAN_RATIO`，默认 0.10 视口）。 */
  readonly planPanLimitRatio?: number;
  /** 软饱和带宽（默认视口边长 6%）。 */
  readonly softBandRatio?: number;
}

export interface SonnetReadingFramingResult {
  /** 取景后的相机（无需调整时**就是传入的那个对象** ✓）。 */
  readonly camera: SonnetCameraLike;
  /** 阅读窗口在屏幕上的包围盒（约束后）。 */
  readonly windowScreen: SonnetFramingBox;
  /** 当前词组在屏幕上的包围盒（没传 `focusBounds` 时为 `null`）。 */
  readonly focusScreen: SonnetFramingBox | null;
  /** 焦点舒适区在屏幕上的包围盒（没传 `planBounds` 时为 `null`）。 */
  readonly planScreen: SonnetFramingBox | null;
  readonly adjusted: boolean;
  /** 实际施加的缩放比（≤ 1；未触发拉远时为 1）。 */
  readonly zoomRatio: number;
  /** 平移修正量（画面比例，= 取景后 `camera.x/y` − 传入值）。 */
  readonly panX: number;
  readonly panY: number;
}

/**
 * **阅读窗口取景**：把"此刻该读的那一小块"放进画面，而不是把整镜正文塞进去。
 *
 * === 与 `frameSonnetCameraToBody` 的三点不同 ===
 * ① 尺寸依据是**阅读窗口**（当前词组 + 前后近邻，由 `sonnetReadingWindow.ts` 连续算出），
 *    不再是整镜所有字形的落位边界 ⇒ 长多行歌词不会因为"整镜 fit"被缩成小字；
 * ② **缩放下限** `minZoomRatio`（默认 0.78）：窗口再大也只缩到这里，剩下的**越过画面边缘出血**
 *    （当前词读得清，邻块出血没关系）；
 * ③ **平移**只做温和兜底：传了 `planBounds`（预测焦点的舒适区）就盯它，上限 0.10 视口、边距 3% / 4%；
 *    不传就退回旧口径（盯窗口、上限 0.16）。**两种口径都不会"把当前词硬塞进画面"** ——
 *    上一版那条没有上限的锚点纠偏正是"一换语义块镜头就急追"的机制，已删除。
 *
 * 窗口本身是**绝对时间的连续函数**，预测焦点也是（高斯加权中心对 t 任意阶连续）⇒ 这里的三步
 * （拉远 / 平移 / 软饱和）都是纯函数 ⇒ 不会突跳，seek 到任意时刻结果一致。
 */
export function frameSonnetCameraToReadingWindow(
  camera: SonnetCameraLike,
  options: SonnetReadingFramingOptions,
): SonnetReadingFramingResult {
  const viewportWidth = safeSpan(options.viewportWidth);
  const viewportHeight = safeSpan(options.viewportHeight);
  /*
   * **平移兜底**：传了焦点舒适区就盯它（有上限、边距宽容）；否则退回旧口径（盯窗口、0.16 上限）。
   * 缩放的依据始终是 `windowBounds`（当前词 + 邻块一起决定拉多远）✓。
   */
  const planBounds = options.planBounds;
  const framed = frameSonnetCameraToStage(
    camera,
    {
      viewportWidth,
      viewportHeight,
      pivotX: options.pivotX,
      pivotY: options.pivotY,
      basePositionX: options.basePositionX,
      basePositionY: options.basePositionY,
      bodyBounds: options.windowBounds,
      panBounds: planBounds ?? options.windowBounds,
      marginXRatio: resolveRatio(
        options.marginXRatio,
        planBounds === undefined ? SONNET_READING_FRAMING_MARGIN_X : SONNET_READING_FRAMING_PLAN_MARGIN_X,
      ),
      marginYRatio: resolveRatio(
        options.marginYRatio,
        planBounds === undefined ? SONNET_READING_FRAMING_MARGIN_Y : SONNET_READING_FRAMING_PLAN_MARGIN_Y,
      ),
      /* 阅读窗口不再另留运动余量：窗外块本来就允许出血。 */
      motionMarginXRatio: 0,
      motionMarginYRatio: 0,
      softBandRatio: options.softBandRatio,
    },
    {
      minZoomRatio: resolveRatio(options.minZoomRatio, SONNET_READING_FRAMING_MIN_ZOOM_RATIO),
      maxPanRatio:
        planBounds === undefined
          ? resolveRatio(options.maxPanRatio, SONNET_READING_FRAMING_MAX_PAN_RATIO)
          : resolveRatio(options.planPanLimitRatio, SONNET_READING_FRAMING_PLAN_PAN_RATIO),
      fitMode: 'safe',
    },
  );
  const framing = framed.camera;
  const basePositionX = resolveBasePositionX(options.basePositionX, viewportWidth);
  const basePositionY = resolveBasePositionY(options.basePositionY, viewportHeight);
  const project = (bounds: SonnetFramingBox): SonnetFramingBox =>
    projectSonnetBodyBounds({
      bounds,
      pivotX: options.pivotX,
      pivotY: options.pivotY,
      basePositionX,
      basePositionY,
      viewportWidth,
      viewportHeight,
      cameraX: framing.x,
      cameraY: framing.y,
      zoom: framing.zoom,
      rotation: framing.rotation,
    });
  const focusBounds = options.focusBounds;
  const focusScreen = focusBounds === undefined ? null : project(focusBounds);
  const planScreen = planBounds === undefined ? null : project(planBounds);
  /* 传入的相机如果本来就不是有限值，就当 0 处理，免得读数变 NaN（相机本身照旧原样返回）。 */
  const inputX = Number.isFinite(camera.x) ? camera.x : 0;
  const inputY = Number.isFinite(camera.y) ? camera.y : 0;
  return {
    camera: framing,
    windowScreen: project(options.windowBounds),
    focusScreen,
    planScreen,
    adjusted: framed.adjusted,
    zoomRatio: framed.zoomRatio,
    panX: framing.x - inputX,
    panY: framing.y - inputY,
  };
}

/** `createSonnetCameraFramer` 的取值上下文。 */
export interface SonnetCameraFramerInput {
  /** 这一镜的 id（缓存键的一部分：换镜必须重测）。 */
  readonly shotId: string;
  /** 这一镜的正文（**已经滤掉 ghost / 背景装饰** ⇒ ghost 不参与取景）。 */
  readonly glyphs: readonly SonnetFramingGlyph[];
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly pivotX: number;
  readonly pivotY: number;
  /** 取景锚点（画布像素；不传按 `W × 0.5` / `H × 0.48`，见 `SonnetCameraFramingOptions`）。 */
  readonly basePositionX?: number;
  readonly basePositionY?: number;
}

export interface SonnetCameraFramerOptions {
  /** 字体族（换字体 ⇒ 测量与落位都会变 ⇒ 缓存键/量法都要跟着变）。 */
  readonly fontFamily: () => string;
  /** 真实文本测量；拿不到就返回 `NaN` ⇒ 退回估算。 */
  readonly measureWidth: SonnetFramingMeasureWidth;
  readonly marginXRatio?: number;
  readonly marginYRatio?: number;
  /** 运动留白（见 `SonnetCameraFramingOptions.motionMarginXRatio`）：默认左右 / 上下各 6%。 */
  readonly motionMarginXRatio?: number;
  readonly motionMarginYRatio?: number;
  /** 软饱和带宽（见 `SonnetCameraFramingOptions.softBandRatio`）：默认视口边长的 6%。 */
  readonly softBandRatio?: number;
}

export interface SonnetCameraFramer {
  (camera: SonnetCameraLike, input: SonnetCameraFramerInput): SonnetCameraFramingResult;
}

/**
 * 缓存键：**只由 `镜 / 视口 / 字体族 / 逐字落位几何` 组成**。
 *
 * `pivot`（逐帧跟拍）、`alpha`、`scale`、入场 `rotation` **一律不进键** —— 它们每 tick 都在变，
 * 进来就会让缓存恒失效。逐字只取 `x/y/fontPx/text/weight/layoutRotation`（落位事实）。
 */
function buildSonnetFramerKey(
  input: SonnetCameraFramerInput,
  viewportWidth: number,
  viewportHeight: number,
  fontFamily: string,
): string {
  let glyphKey = '';
  for (const glyph of input.glyphs) {
    glyphKey +=
      `${glyph.x}\u0001${glyph.y}\u0001${glyph.fontPx}\u0001${glyph.text}` +
      `\u0001${glyph.weight}\u0001${glyph.layoutRotation ?? ''}\u0002`;
  }
  return `${input.shotId}\u0001${viewportWidth}x${viewportHeight}\u0001${fontFamily}\u0001${glyphKey}`;
}

/**
 * 带记忆化的取景器（渲染层每 tick 调一次）。
 *
 * **测什么被缓存**：正文的局部落位范围 —— 键就是 `buildSonnetFramerKey`（见其注释）✓。
 * 逐帧新建数组不再让缓存失效（比的是几何值，不是数组引用）；`pivot / alpha / scale / 入场 rotation`
 * 不在键里 ⇒ 入场滑入期间**不逐字量文本**、读数恒定 ✓。
 */
export function createSonnetCameraFramer(options: SonnetCameraFramerOptions): SonnetCameraFramer {
  let cacheKey = '';
  let cachedBounds: SonnetFramingBox | null = null;
  return (camera, input) => {
    const viewportWidth = safeSpan(input.viewportWidth);
    const viewportHeight = safeSpan(input.viewportHeight);
    const key = buildSonnetFramerKey(input, viewportWidth, viewportHeight, options.fontFamily());
    if (key !== cacheKey) {
      cacheKey = key;
      cachedBounds = resolveSonnetBodyBounds(input.glyphs, options.measureWidth);
    }
    const basePositionX = resolveBasePositionX(input.basePositionX, viewportWidth);
    const basePositionY = resolveBasePositionY(input.basePositionY, viewportHeight);
    if (cachedBounds === null) {
      /* 这一镜没有正文（空镜）：不施加任何约束，读数给一个"锚点处的空盒"即可。 */
      const anchorX = basePositionX + camera.x * viewportWidth;
      const anchorY = basePositionY + camera.y * viewportHeight;
      return {
        camera,
        bodyScreen: { minX: anchorX, maxX: anchorX, minY: anchorY, maxY: anchorY },
        adjusted: false,
        zoomRatio: 1,
      };
    }
    return frameSonnetCameraToBody(camera, {
      viewportWidth,
      viewportHeight,
      pivotX: input.pivotX,
      pivotY: input.pivotY,
      basePositionX: input.basePositionX,
      basePositionY: input.basePositionY,
      bodyBounds: cachedBounds,
      marginXRatio: options.marginXRatio,
      marginYRatio: options.marginYRatio,
      motionMarginXRatio: options.motionMarginXRatio,
      motionMarginYRatio: options.motionMarginYRatio,
      softBandRatio: options.softBandRatio,
    });
  };
}
