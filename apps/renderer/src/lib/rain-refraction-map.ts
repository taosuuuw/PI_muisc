import type { RainLayout } from './rain-layout';
import { buildStaticRainField, type RainFieldSize } from './rain-field-map';

/**
 * 兼容旧调用名的静态共享场入口。
 *
 * 现在它覆盖**全部静态珠**，且只烤一次；消费由动态场中性洞在最终合成里盖掉，
 * 不再因每颗大珠消费重烤整张静态图。真正的场图/通道约定见 `rain-field-map.ts`。
 */
export interface RefractionMapSize {
  readonly width: number;
  readonly height: number;
}

export function buildRefractionMap(
  layout: RainLayout,
  size: RefractionMapSize | RainFieldSize,
): string {
  return buildStaticRainField(layout, size).url;
}
