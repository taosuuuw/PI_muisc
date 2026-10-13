/**
 * 商籁**装饰性开放边框**（照抄 folia `sonnet/sonnetFrameDecor.ts`，AGPL-3.0）。
 *
 * 上游文件头原文（`SOURCE`）："Decorative **open frames** around a deterministic **30% subset** of segments.
 * Each frame traces its sides in with a growth animation, **never fully closes at the corners**, and finishes with a
 * small **floral/geometric ornament per corner**." ✓
 * ⇒ 围绕**部分短语**画一圈"逐边生长、**四角永不闭合**、每角收一个小花纹"的装饰边框 ✓。
 * （文件头写 30%，常量是 **`0.4`** ⇒ **以常量为准** ✓，这处矛盾登记在本文件与 `CREDITS.md` ✓。）
 *
 * 本文件是**纯函数层**：只出"选择 + 几何 + 进度"，不碰 Pixi ✓。
 *
 * === 与 folia 的差异（照实记）===
 * · 上游 `resolveSonnetFrameDecorSpec(segment)` 自己**把段文本拼串哈希**（`hashSonnetSeed('[text]:[start]:[end]:frame-decor')` ✓）；
 *   我方**没有那个字符串哈希**（我们的是 `sonnetHash01(seed, index, salt)` / `mixSonnetSeed(number, salt)` 那套 ✗）
 *   ⇒ 本文件改成**收一个数字哈希**（`resolveSonnetFrameDecorSpec(hash)` ✓），
 *   **位运算判据与取档方式照抄**（`(hash & 1023) / 1024 < 0.4`、`(hash >>> 10) % 4` ✓）
 *   —— 调用方用我们的哈希族喂它即可 ✓；
 * · **缓动不在这里算** ✗：上游用 `easeSonnetElasticOut` / `easeSonnetExpoOut` ✓，
 *   我方 `sonnetMotion.ts` 已有自己的缓动族 ✓ ⇒ 本文件只出**0~1 的原始进度**，
 *   由渲染层用**自己那套**缓动去修饰 ✓（避免我在这里瞎抄一条曲线 ✗）。
 */

export const SONNET_FRAME_DECOR_PROBABILITY = 0.4;
export const SONNET_FRAME_DECOR_VARIANTS = 4;

/** 主色**调暗**的倍数（上游 `dimmmedColor(theme.primaryColor, 0.55)` ✓）。 */
export const SONNET_FRAME_DECOR_DIM_MULTIPLIER = 0.55;

/** 四档的角饰（顺序与上游 `variant` 一致 ✓）。 */
export const SONNET_FRAME_DECOR_ORNAMENT_KINDS = [
  'corner-ticks',
  'corner-flowers',
  'brackets',
  'corner-triangles',
] as const;

export type SonnetFrameDecorOrnamentKind = (typeof SONNET_FRAME_DECOR_ORNAMENT_KINDS)[number];

export interface SonnetFrameDecorSpec {
  readonly applied: boolean;
  readonly variant: number;
}

/**
 * 选择（照抄上游判据，只是入口从"段"换成"哈希值" ✓）：
 * `applied = (hash & 1023) / 1024 < 0.4` ✓、`variant = (hash >>> 10) % 4` ✓。
 */
export function resolveSonnetFrameDecorSpec(hash: number): SonnetFrameDecorSpec {
  const safe = Math.abs(Math.trunc(hash)) >>> 0;
  return {
    applied: ((safe & 1023) / 1024) < SONNET_FRAME_DECOR_PROBABILITY,
    variant: (safe >>> 10) % SONNET_FRAME_DECOR_VARIANTS,
  };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export interface SonnetFrameDecorGeometryInput {
  readonly fontSize: number;
  /** 该 placement 的**未旋转**尺寸（上游按"四分之一转"是否奇数次来互换宽高 ✓）。 */
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly variant: number;
}

export interface SonnetFrameDecorGeometry {
  /** 内边距（上游 `clamp(fontSize × 0.22, 8, 20)` ✓）。 */
  readonly pad: number;
  readonly halfW: number;
  readonly halfH: number;
  /** 角上留口的量（"四角永不闭合"就是它 ✓）。 */
  readonly cornerGap: number;
  /** 描边宽度（上游 `clamp(fontSize × 0.03, 1.2, 2.2)` ✓）。 */
  readonly strokeWidth: number;
  /** 虚线档（`variant === 3`）用的 `dash` / `gap` ✓（其它档也用得上，先都算出来 ✓）。 */
  readonly dash: number;
  readonly dashGap: number;
  /** 旋转后是否按四分之一转互换宽高（上游 `rotation` 吸附到 π/2、容差 `1e-6` ✓）。 */
  readonly swapped: boolean;
  readonly ornamentKind: SonnetFrameDecorOrnamentKind;
}

/**
 * 几何（全部照抄上游常数与 clamp 边界 ✓）。
 *
 * ⚠ 上游的"四分之一转互换"是这样判的：把 `rotation` 归一化后看它**是不是 π/2 的奇数倍**（容差 `1e-6` ✓）
 * ⇒ 是则**用 `height/2` 当 halfW、`width/2` 当 halfH** ✓（因为转过去之后视觉上的宽高换了 ✓）。
 */
export function resolveSonnetFrameDecorGeometry(
  input: SonnetFrameDecorGeometryInput,
): SonnetFrameDecorGeometry {
  const pad = clamp(input.fontSize * 0.22, 8, 20);
  const halfTurn = Math.PI / 2;
  const quarters = input.rotation / halfTurn;
  const nearest = Math.round(quarters);
  const isQuarterTurn = Math.abs(quarters - nearest) <= 1e-6;
  const swapped = isQuarterTurn && nearest % 2 !== 0;

  const halfW = (swapped ? input.height : input.width) / 2 + pad;
  const halfH = (swapped ? input.width : input.height) / 2 + pad;
  const gapRatio = input.variant === 1 ? 0.42 : 0.3;

  return {
    pad,
    halfW,
    halfH,
    cornerGap: clamp(Math.min(halfW, halfH) * gapRatio, 6, 30),
    strokeWidth: clamp(input.fontSize * 0.03, 1.2, 2.2),
    dash: clamp(input.fontSize * 0.14, 5, 8),
    dashGap: clamp(input.fontSize * 0.14, 5, 8) * 0.7,
    swapped,
    ornamentKind:
      SONNET_FRAME_DECOR_ORNAMENT_KINDS[
        ((input.variant % SONNET_FRAME_DECOR_VARIANTS) + SONNET_FRAME_DECOR_VARIANTS) %
          SONNET_FRAME_DECOR_VARIANTS
      ] ?? 'corner-ticks',
  };
}

/**
 * 四条边**依次**生长：上游 `sideProgress = clamp01((eased − side × 0.2) / 0.4)` ✓
 * （`side` 取 0..3 ✓；结果为 0 表示这条边还没开始 ✓）。
 */
export function resolveSonnetFrameDecorSideProgress(eased: number, side: number): number {
  const progress = (eased - side * 0.2) / 0.4;
  return progress < 0 ? 0 : progress > 1 ? 1 : progress;
}

/**
 * 四个角的角饰进度（**次序**）：上游 `clamp01((eased − 0.35 − corner × 0.14) / 0.3)` ✓
 * ⇒ 每角比前一角晚 `0.14` ✓，起点在 `0.35`（四边画得差不多才开始收角 ✓）。
 * ⚠ **未套缓动**：上游外面还套 `easeSonnetElasticOut` ✓（"弹出来" ✓）⇒ 由渲染层用我方缓动套 ✓。
 */
export function resolveSonnetFrameDecorOrnamentProgress(eased: number, corner: number): number {
  const progress = (eased - 0.35 - corner * 0.14) / 0.3;
  return progress < 0 ? 0 : progress > 1 ? 1 : progress;
}
