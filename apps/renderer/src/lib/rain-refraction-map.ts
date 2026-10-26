import { rainSizeScale, type RainLayout } from './rain-layout';
import {
  lensDisplacementSprite,
  lensOptionsForOffset,
  type LensDisplacementOptions,
} from './rain-lens-map';

/**
 * 静态整屏折射图：把**所有附着大透镜**的位移精灵盖在一张 128 灰底上。
 *
 * 这是一张**低频**资源：只在换歌 / 窗口尺寸变化时生成一次，交给 SVG `feImage` 当底图。
 * 会动的水珠不在这里——它们由组件在同一个滤镜里用 `feImage` 叠上去，每帧只改位置，
 * 不重新编码整屏 PNG。
 *
 * 分辨率取半分辨率（超宽屏 1/3）：位移边缘会稍软，肉眼正好；PNG 也小得多。
 * 128 灰 = 不位移；每颗透镜的精灵外圈是透明的，所以小透镜叠在大透镜上不会互相擦掉。
 */

export interface RefractionMapSize {
  readonly width: number;
  readonly height: number;
}

/** 半分辨率；4K 那种宽度再降一档，避免一次烤出过大的 PNG。 */
function mapDivisor(width: number): number {
  return width > 2400 ? 3 : 2;
}

/**
 * 生成静态整屏折射图（`data:image/png`）。
 *
 * @param layout 这一首歌的雨纹布局（只用 `lenses`）。
 * @param size   播放页舞台的 CSS 像素尺寸（与 `feImage` 的 `100%` 对应）。
 */
export function buildRefractionMap(layout: RainLayout, size: RefractionMapSize): string {
  if (typeof document === 'undefined') return '';
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const divisor = mapDivisor(width);
  const mapWidth = Math.max(1, Math.round(width / divisor));
  const mapHeight = Math.max(1, Math.round(height / divisor));

  const canvas = document.createElement('canvas');
  canvas.width = mapWidth;
  canvas.height = mapHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // 128 灰 = SVG 位移的中性值：不偏。
  ctx.fillStyle = 'rgb(128, 128, 128)';
  ctx.fillRect(0, 0, mapWidth, mapHeight);

  const pxScale = mapWidth / width;
  const sizeScale = rainSizeScale(width);
  let maxSize = 1;
  for (const lens of layout.lenses) maxSize = Math.max(maxSize, lens.sizePx);

  for (const lens of layout.lenses) {
    const scaledSize = Math.max(1, lens.sizePx * sizeScale);
    // 偏移量按水珠大小和窗口缩放一起走：大珠折得多、小珠折得少，和单颗滤镜的分档一致。
    const target = Math.min(13, Math.max(2, lens.targetOffsetPx * sizeScale));
    // 这里用正圆精灵，让画布上的 body 和折射都用同一个 squash 变换对齐；
    // 泪滴感交给 body 的轮廓，不让两层各拉一次。
    const options: LensDisplacementOptions = lensOptionsForOffset(target, 1);
    const sprite = lensDisplacementSprite(options);
    if (!sprite) continue;

    const x = (lens.leftPercent / 100) * mapWidth;
    const y = (lens.topPercent / 100) * mapHeight;
    const diameter = Math.max(1, scaledSize * pxScale);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((lens.shape.tiltDeg * Math.PI) / 180);
    ctx.scale(1, lens.shape.squash);
    // 折射强度跟大小有关；透明度只做很轻的调制，不能把大透镜折得太弱。
    ctx.globalAlpha =
      Math.min(1, 0.72 + (lens.sizePx / maxSize) * 0.28) * (0.78 + lens.opacity * 0.22);
    ctx.drawImage(sprite, -diameter / 2, -diameter / 2, diameter, diameter);
    ctx.restore();
  }

  return canvas.toDataURL('image/png');
}
