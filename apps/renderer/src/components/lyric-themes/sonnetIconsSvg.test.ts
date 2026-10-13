/**
 * 自绘图标 SVG 的用例（第 546 轮）。
 * 可判定的都核：**前缀格式** ✓、**解码回来的属性** ✓、**Flower 一定存在** ✓、
 * **未知名 ⇒ null** ✓、**零负兜底** ✓、**URL 编码生效** ✓、**形状表自查** ✓。
 */

import { describe, expect, it } from 'vitest';
import { SONNET_ICON_SVG_SHAPES, buildSonnetIconSvg } from './sonnetIcons';

const DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';

const decodeSvg = (dataUrl: string): string =>
  decodeURIComponent(dataUrl.slice(DATA_URL_PREFIX.length));

describe('图标 SVG：前缀与解码', () => {
  it('是 SVG data URL 前缀；去掉前缀再解码 ⇒ 直接就是 <svg …>', () => {
    const url = buildSonnetIconSvg('Flower', '#abcdef', 2, 64);
    expect(url).not.toBeNull();
    expect(url?.startsWith(DATA_URL_PREFIX)).toBe(true);
    const markup = decodeSvg(url as string);
    expect(markup.startsWith('<svg ')).toBe(true);
    expect(markup.endsWith('</svg>')).toBe(true);
  });

  it('**URL 编码确实生效**：data URL 里不含裸 `<` 或 `"`', () => {
    const url = buildSonnetIconSvg('Star', '#fff', 2, 64) as string;
    expect(url).not.toContain('<');
    expect(url).not.toContain('"');
    expect(url).toContain('%3C'); // 编码后的 '<' ✓
  });

  it('属性逐条对上：viewBox / width / height / fill / stroke / stroke-width / 圆头圆角', () => {
    const markup = decodeSvg(buildSonnetIconSvg('Diamond', 'rgb(1, 2, 3)', 3, 48) as string);
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('width="48"');
    expect(markup).toContain('height="48"');
    expect(markup).toContain('fill="none"'); // 上游也是 fill: 'none' ✓
    expect(markup).toContain('stroke="rgb(1, 2, 3)"');
    expect(markup).toContain('stroke-width="3"');
    expect(markup).toContain('stroke-linecap="round"');
    expect(markup).toContain('stroke-linejoin="round"');
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('不同名字 ⇒ 不同的形状体（同色同宽同尺寸下）', () => {
    const a = decodeSvg(buildSonnetIconSvg('Star', '#fff', 2, 64) as string);
    const b = decodeSvg(buildSonnetIconSvg('Ring', '#fff', 2, 64) as string);
    expect(a).not.toBe(b);
    expect(a).toContain('<polygon');
    expect(b).toContain('<circle');
  });
});

describe('图标 SVG：名字与兜底', () => {
  it('**`Flower` 一定存在**（它是上游的兜底名 ✓）', () => {
    expect(Object.prototype.hasOwnProperty.call(SONNET_ICON_SVG_SHAPES, 'Flower')).toBe(true);
    expect(buildSonnetIconSvg('Flower', '#fff', 2, 64)).not.toBeNull();
  });

  it('未知名（含空串）⇒ `null`（与上游 `if (!Icon) return null` 同构 ✓）', () => {
    expect(buildSonnetIconSvg('NoSuchIcon', '#fff', 2, 64)).toBeNull();
    expect(buildSonnetIconSvg('', '#fff', 2, 64)).toBeNull();
    expect(buildSonnetIconSvg('flower', '#fff', 2, 64)).toBeNull(); // **大小写敏感** ✓（与上游对象取键一致 ✓）
  });

  it('零负兜底：`size` 至少 1、`strokeWidth` 至少 0', () => {
    const zero = decodeSvg(buildSonnetIconSvg('Cross', '#fff', 0, 0) as string);
    expect(zero).toContain('width="1"');
    expect(zero).toContain('height="1"');
    expect(zero).toContain('stroke-width="0"');
    const negative = decodeSvg(buildSonnetIconSvg('Cross', '#fff', -5, -9) as string);
    expect(negative).toContain('width="1"');
    expect(negative).toContain('stroke-width="0"');
  });
});

describe('图标 SVG：形状表自查', () => {
  it('每个形状都非空、且形状体里没有 `<svg` 或未闭合的 `<script`', () => {
    const names = Object.keys(SONNET_ICON_SVG_SHAPES);
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      const shape = SONNET_ICON_SVG_SHAPES[name];
      expect(typeof shape).toBe('string');
      expect((shape as string).length).toBeGreaterThan(10);
      expect(shape).not.toContain('<svg');
      expect(shape).not.toContain('script');
      expect(shape).not.toContain('url(');
    }
  });

  it('形状体都是可用的 SVG 图元（只允许 circle / polygon / line / ellipse）', () => {
    for (const shape of Object.values(SONNET_ICON_SVG_SHAPES)) {
      const tags = shape.match(/<([a-z]+)/g) ?? [];
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(['<circle', '<polygon', '<line', '<ellipse']).toContain(tag);
      }
    }
  });
});
