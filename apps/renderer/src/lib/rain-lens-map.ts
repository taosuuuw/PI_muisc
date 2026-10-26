/**
 * 水珠的**位移贴图**（SVG `feDisplacementMap` 用的那张 RGB 图）。
 *
 * 水珠是一枚球面透镜：越靠边法线越斜，光穿过后落点偏得越多；中心几乎不偏。这里不逐像素
 * 算 Snell，而是把「每个像素该往哪偏」预烘焙成一张图：
 * - **R 通道 = 横向偏移**（128 = 不偏）；
 * - **G 通道 = 纵向偏移**；
 * - **A 通道 = 透镜覆盖率**：水珠外面完全透明。这样同一张精灵既能盖进静态整屏位移图，
 *   也能作为动态 `feImage` 叠在别的透镜上，不会用一圈中性灰把旁边的透镜擦掉。
 *
 * 两个细节决定「像不像水」：
 * 1. **泪滴形**：纵向略拉长（aspectY），底部再稍微鼓一点；
 * 2. **边缘回落**：最后 18% 半径把偏移收回中性、再把 alpha 收到 0，避免水珠外圈采样
 *    到框外，出现生硬切边或白圈。
 *
 * 纯函数部分（`buildLensDisplacementPixels`）只依赖尺寸和参数，可以直接单测；canvas/dataURL
 * 部分只在浏览器里调用。
 */

/** 位移精灵的边长。256 够细；缩到十几像素的水珠上也看不出锯齿。 */
export const LENS_MAP_SIZE = 256;

/**
 * 滤镜的 `feDisplacementMap scale`。
 *
 * 精灵里的偏移量是 0~127 的归一化值；实际像素位移 = (值/255) * scale。
 * 静态折射图和动态透镜共用这个 scale，改一处就整体一起变。
 */
export const LENS_FILTER_SCALE = 44;

export interface LensDisplacementOptions {
  /** 归一化最大偏移（0~127）。调用方按「目标像素 / LENS_FILTER_SCALE * 255」换算。 */
  maxOffset?: number;
  /** 纵向拉长系数，1.0 = 正圆，1.1 = 略高的泪滴。 */
  aspectY?: number;
  /** 边缘回落起点（0~1）。默认 0.82。 */
  edgeFadeStart?: number;
}

/** 动态水珠按尺寸分四档，每档预生成一张带透明边的透镜精灵。 */
export const DYNAMIC_LENS_BUCKETS = [
  { maxSizePx: 14, offsetPx: 4.2, aspectY: 1 },
  { maxSizePx: 20, offsetPx: 6.6, aspectY: 1 },
  { maxSizePx: 28, offsetPx: 9.8, aspectY: 1 },
  { maxSizePx: 48, offsetPx: 14, aspectY: 1 },
] as const;

export type DynamicLensBucket = (typeof DYNAMIC_LENS_BUCKETS)[number];

/** 不用的动态透镜槽位用这张全透明图；比把 href 清空更稳。 */
export const TRANSPARENT_LENS_URL =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="none"/></svg>',
  );

const DEFAULT_MAX_OFFSET = 60;
const DEFAULT_ASPECT_Y = 1.08;
const DEFAULT_EDGE_FADE_START = 0.82;
const ALPHA_FADE_START = 0.9;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 生成位移精灵的 RGBA 像素。
 *
 * @param size 边长（像素）；测试里用 64，实际用 `LENS_MAP_SIZE`。
 */
export function buildLensDisplacementPixels(
  size: number,
  options: LensDisplacementOptions = {},
): Uint8ClampedArray<ArrayBuffer> {
  if (!Number.isInteger(size) || size < 8) {
    throw new Error(`位移贴图尺寸必须是 >= 8 的整数，收到 ${size}`);
  }
  const maxOffset = clamp(options.maxOffset ?? DEFAULT_MAX_OFFSET, 0, 127);
  const aspectY = clamp(options.aspectY ?? DEFAULT_ASPECT_Y, 0.6, 1.6);
  const edgeFadeStart = clamp(options.edgeFadeStart ?? DEFAULT_EDGE_FADE_START, 0.4, 0.98);
  // 显式拿一个 ArrayBuffer：TS 7 的 `ImageData` 只收 `Uint8ClampedArray<ArrayBuffer>`。
  const data = new Uint8ClampedArray(new ArrayBuffer(size * size * 4));
  const cx = size / 2;
  const cy = size / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const index = (py * size + px) * 4;
      const dx = (px + 0.5 - cx) / cx;
      let dy = (py + 0.5 - cy) / cy;
      // 泪滴：纵向先按 aspectY 拉长，底部再鼓一点；不是正圆，也不会读到「气泡」。
      dy *= aspectY;
      dy *= 1 + dy * 0.12;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 1) {
        // 水珠之外：透明。盖到另一张图上时不会擦掉旁边的透镜。
        data[index] = 128;
        data[index + 1] = 128;
        data[index + 2] = 128;
        data[index + 3] = 0;
        continue;
      }

      const nx = dist > 0.001 ? dx / dist : 0;
      const ny = dist > 0.001 ? dy / dist : 0;
      // 越靠边偏得越多；最后一段收回到中性，避免采样出水珠框。
      const fade = dist <= edgeFadeStart ? 1 : 1 - (dist - edgeFadeStart) / (1 - edgeFadeStart);
      const magnitude = maxOffset * dist * Math.max(0, fade);

      // SVG 的 feDisplacementMap：R = X 轴、G = Y 轴。
      data[index] = Math.round(128 + nx * magnitude);
      data[index + 1] = Math.round(128 + ny * magnitude);
      data[index + 2] = 128;
      data[index + 3] = Math.round(
        255 *
          (dist <= ALPHA_FADE_START ? 1 : 1 - (dist - ALPHA_FADE_START) / (1 - ALPHA_FADE_START)),
      );
    }
  }

  return data;
}

interface SpriteCacheEntry {
  canvas: HTMLCanvasElement;
  url: string;
}

const spriteCache = new Map<string, SpriteCacheEntry>();

function spriteKey(options: LensDisplacementOptions): string {
  return `${options.maxOffset ?? DEFAULT_MAX_OFFSET}|${options.aspectY ?? DEFAULT_ASPECT_Y}|${
    options.edgeFadeStart ?? DEFAULT_EDGE_FADE_START
  }`;
}

/**
 * 烤一张带透明边的透镜精灵，并返回 canvas / dataURL。
 *
 * 动态 `feImage` 需要 dataURL；静态整屏图可以直接 `drawImage(canvas)`。两者共用缓存，
 * 只在尺寸档位变化时生成一次，**绝不逐帧编码**。
 */
function lensSprite(options: LensDisplacementOptions = {}): SpriteCacheEntry | null {
  if (typeof document === 'undefined') return null;
  const key = spriteKey(options);
  const cached = spriteCache.get(key);
  if (cached) return cached;
  const size = LENS_MAP_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const pixels = buildLensDisplacementPixels(size, options);
  ctx.putImageData(new ImageData(pixels, size, size), 0, 0);
  // 只缓存少量档位；静态图/动态图都复用。
  if (spriteCache.size > 24) spriteCache.clear();
  const entry = { canvas, url: canvas.toDataURL('image/png') };
  spriteCache.set(key, entry);
  return entry;
}

/** 静态位移图用的 canvas 精灵。 */
export function lensDisplacementSprite(
  options: LensDisplacementOptions = {},
): HTMLCanvasElement | null {
  return lensSprite(options)?.canvas ?? null;
}

/** 静态位移图用：按目标像素位移生成精灵参数。 */
export function lensOptionsForOffset(
  targetOffsetPx: number,
  aspectY = 1.06,
): LensDisplacementOptions {
  const maxOffset = clamp(Math.round((targetOffsetPx / LENS_FILTER_SCALE) * 255), 1, 127);
  return { maxOffset, aspectY };
}

/** 动态 `feImage` 的 href：按水珠直径选档，档内复用同一张 PNG dataURL。 */
export function dynamicLensSpriteUrl(sizePx: number): string {
  const bucketIndex = DYNAMIC_LENS_BUCKETS.findIndex((bucket) => sizePx <= bucket.maxSizePx);
  const safeIndex = bucketIndex < 0 ? DYNAMIC_LENS_BUCKETS.length - 1 : bucketIndex;
  const bucket = DYNAMIC_LENS_BUCKETS[safeIndex];
  if (!bucket) return TRANSPARENT_LENS_URL;
  const options = lensOptionsForOffset(bucket.offsetPx, bucket.aspectY);
  return lensSprite(options)?.url ?? TRANSPARENT_LENS_URL;
}

/** 给测试/探针用：确认某个尺寸会落到哪一档。 */
export function dynamicLensBucketForSize(sizePx: number): DynamicLensBucket {
  const index = DYNAMIC_LENS_BUCKETS.findIndex((bucket) => sizePx <= bucket.maxSizePx);
  return (
    DYNAMIC_LENS_BUCKETS[index < 0 ? DYNAMIC_LENS_BUCKETS.length - 1 : index] ??
    DYNAMIC_LENS_BUCKETS[0]
  );
}
