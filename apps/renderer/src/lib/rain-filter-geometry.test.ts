import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyRainFilterImageGeometry,
  buildRainFilterGeometry,
} from './rain-filter-geometry';

function fakeImage(): {
  attrs: Map<string, string>;
  setAttribute: (name: string, value: string) => void;
} {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
  };
}

describe('rain-filter-geometry', () => {
  it('真实 backdrop 链使用 userSpaceOnUse + viewport CSS px，不用百分比', () => {
    const geometry = buildRainFilterGeometry(1184, 772);
    expect(geometry).toEqual({
      filterUnits: 'userSpaceOnUse',
      primitiveUnits: 'userSpaceOnUse',
      x: 0,
      y: 0,
      width: 1184,
      height: 772,
    });
  });

  it('动态 feImage 的 ref/rAF 几何可直接写回，并在 resize 时完整同步', () => {
    const image = fakeImage();
    applyRainFilterImageGeometry(image, buildRainFilterGeometry(1184, 772));
    expect(Object.fromEntries(image.attrs)).toEqual({
      x: '0',
      y: '0',
      width: '1184',
      height: '772',
    });

    applyRainFilterImageGeometry(image, buildRainFilterGeometry(800, 600));
    expect(Object.fromEntries(image.attrs)).toEqual({
      x: '0',
      y: '0',
      width: '800',
      height: '600',
    });
  });

  it('RainWindow JSX 不再把 filter/feImage 写成 100%', () => {
    const source = readFileSync(
      new URL('../components/RainWindow.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('filterUnits={filterGeometry.filterUnits}');
    expect(source).toContain('primitiveUnits={filterGeometry.primitiveUnits}');
    expect(source).not.toContain('width="100%"');
    expect(source).not.toContain("setAttribute('width', '100%')");
    expect(source.match(/<feImage/g)).toHaveLength(1);
    expect(source).toContain('rainCombinedField');
    expect(source).not.toContain('<feFlood');
    expect(source).not.toContain('<feColorMatrix');
    expect(source).not.toContain('<feGaussianBlur');
    expect(source).not.toContain('<feComposite');
    expect(source).not.toContain('<feMerge');
    // 编码必须走 module Dedicated Worker，而不是主线程 toBlob/OffscreenCanvas/toDataURL。
    expect(source).toContain('rain-field-worker.ts');
    expect(source).toContain("type: 'module'");
    expect(source).toContain('RainFieldWorkerClient');
    expect(source).not.toContain('toDataURL');
    expect(source).not.toContain('OffscreenCanvas');
  });
});
