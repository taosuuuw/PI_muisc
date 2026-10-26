import type { RainShape } from './rain-layout';

/**
 * 所有水体共用的轮廓函数。
 *
 * canvas 本体、静态/动态法线图、碰撞都用同一个 seed 形状；场图不再画正圆精灵，
 * 否则高光/轮廓会和折射错位，读成“贴上去的泡泡”。
 */
export function rainBlobRadiusScale(shape: RainShape, angle: number): number {
  const ripple =
    Math.sin(angle * 3 + shape.wobblePhase) * 0.55 +
    Math.sin(angle * 5 - shape.wobblePhase * 0.7) * 0.25;
  return Math.max(0.45, 1 + shape.wobble * ripple);
}

export interface RainBlobPoint {
  x: number;
  y: number;
}

/** 与 canvas 画轮廓同一组点；场图用极坐标半径采样同一 shape。 */
export function rainBlobTracePoints(
  shape: RainShape,
  radius: number,
  count = radius > 5 ? 14 : 10,
): RainBlobPoint[] {
  const points: RainBlobPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const rr = radius * rainBlobRadiusScale(shape, angle);
    points.push({ x: Math.cos(angle) * rr, y: Math.sin(angle) * rr });
  }
  return points;
}
