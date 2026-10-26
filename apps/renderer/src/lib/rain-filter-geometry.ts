/**
 * Chromium 的 backdrop-filter + SVG filter 在真实窗口里不能可靠地把
 * filter/feImage 的百分比长度按目标元素解释。统一用 viewport CSS px +
 * userSpaceOnUse，几何只从这一处来。
 */
export interface RainFilterGeometry {
  readonly filterUnits: 'userSpaceOnUse';
  readonly primitiveUnits: 'userSpaceOnUse';
  readonly x: 0;
  readonly y: 0;
  readonly width: number;
  readonly height: number;
}

function cssPixels(value: number): number {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : 1));
}

export function buildRainFilterGeometry(width: number, height: number): RainFilterGeometry {
  return {
    filterUnits: 'userSpaceOnUse',
    primitiveUnits: 'userSpaceOnUse',
    x: 0,
    y: 0,
    width: cssPixels(width),
    height: cssPixels(height),
  };
}

/** 动态 feImage 由 rAF/ref 直接写属性，resize 时必须同步成同一套 px。 */
export function applyRainFilterImageGeometry(
  element: Pick<Element, 'setAttribute'> | null,
  geometry: RainFilterGeometry,
): void {
  if (!element) return;
  element.setAttribute('x', String(geometry.x));
  element.setAttribute('y', String(geometry.y));
  element.setAttribute('width', String(geometry.width));
  element.setAttribute('height', String(geometry.height));
}
