/**
 * `apps/desktop/src/main/thumbar.ts` 行为锁（主人本轮第 3 条）。
 *
 * 这一串测试钉两类**静默失败**：
 *   ① 字形画成了全透明 —— `setThumbarButtons()` 照样返回 true，但任务栏上那排键
 *      会是三个空气按钮（和托盘空图同一个坑：系统不报错，肉眼才发现）；
 *   ② 播放/暂停画反了 —— 正在播的时候画「播放」键，看起来像卡住了。
 *
 * 全程纯函数，不 import electron、不开窗口、不写盘。
 */
import { describe, expect, it } from 'vitest';
import { buildThumbarGlyph, describeThumbar, thumbarSpecs, type ThumbarGlyph } from './thumbar.js';

const GLYPHS: ThumbarGlyph[] = ['prev', 'play', 'pause', 'next'];

/** 数一张位图里不透明的像素个数（alpha 通道非 0）。 */
function opaquePixels(buffer: Buffer): number {
  let count = 0;
  for (let offset = 3; offset < buffer.length; offset += 4) {
    if (buffer[offset] !== 0) count++;
  }
  return count;
}

/** 取第一个不透明像素的 BGRA。 */
function firstInk(buffer: Buffer): { b: number; g: number; r: number; a: number } | null {
  for (let offset = 0; offset < buffer.length; offset += 4) {
    if (buffer[offset + 3] !== 0) {
      return {
        b: buffer[offset] ?? 0,
        g: buffer[offset + 1] ?? 0,
        r: buffer[offset + 2] ?? 0,
        a: buffer[offset + 3] ?? 0,
      };
    }
  }
  return null;
}

describe('buildThumbarGlyph', () => {
  it('默认 16×16、BGRA 四通道，长度对得上', () => {
    const { width, height, buffer } = buildThumbarGlyph('play');
    expect(width).toBe(16);
    expect(height).toBe(16);
    expect(buffer.length).toBe(16 * 16 * 4);
  });

  it('四种字形都画得出实心像素（全透明就是三个空气按钮）', () => {
    for (const glyph of GLYPHS) {
      const pixels = opaquePixels(buildThumbarGlyph(glyph).buffer);
      expect(pixels, `${glyph} 的实心像素数`).toBeGreaterThan(20);
      // 也不该糊满整格：留出边距才像图标而不是一块色块。
      expect(pixels, `${glyph} 的实心像素数`).toBeLessThan(16 * 16);
    }
  });

  it('播放与暂停、上一首与下一首互不相同', () => {
    const play = buildThumbarGlyph('play').buffer;
    const pause = buildThumbarGlyph('pause').buffer;
    const prev = buildThumbarGlyph('prev').buffer;
    const next = buildThumbarGlyph('next').buffer;
    expect(play.equals(pause)).toBe(false);
    expect(prev.equals(next)).toBe(false);
  });

  it('暂停比播放占的像素多（两根竖条 vs 一个三角形）', () => {
    expect(opaquePixels(buildThumbarGlyph('pause').buffer)).toBeGreaterThan(
      opaquePixels(buildThumbarGlyph('play').buffer),
    );
  });

  it('竖条贴边、三角形指向那一侧：上一首最左有墨、下一首最右有墨', () => {
    const inkColumns = (glyph: ThumbarGlyph): { min: number; max: number } => {
      const { buffer } = buildThumbarGlyph(glyph);
      let min = 99;
      let max = -1;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (buffer[(y * 16 + x) * 4 + 3] !== 0) {
            min = Math.min(min, x);
            max = Math.max(max, x);
          }
        }
      }
      return { min, max };
    };
    const prev = inkColumns('prev');
    const play = inkColumns('play');
    const next = inkColumns('next');
    // 上一首：竖条在最左边（设计网格 x=2）；下一首：竖条在最右边（x=14）。
    expect(prev.min).toBeLessThan(play.min);
    expect(next.max).toBeGreaterThan(play.max);
    expect(prev.min).toBeLessThanOrEqual(3);
    expect(next.max).toBeGreaterThanOrEqual(12);
  });

  it('size 可调，且不小于设计网格 16', () => {
    expect(buildThumbarGlyph('play', { size: 32 }).width).toBe(32);
    expect(buildThumbarGlyph('play', { size: 8 }).width).toBe(16);
  });

  it('深色底给近白字形、浅色底给近黑字形（系统不会替我们反色）', () => {
    const onDark = firstInk(buildThumbarGlyph('play', { dark: true }).buffer);
    const onLight = firstInk(buildThumbarGlyph('play', { dark: false }).buffer);
    expect(onDark?.r).toBeGreaterThan(0xc0);
    expect(onLight?.r).toBeLessThan(0x40);
    expect(onDark?.a).toBe(0xff);
    expect(onLight?.a).toBe(0xff);
  });
});

describe('thumbarSpecs', () => {
  it('永远是「上一首 / 播放暂停 / 下一首」三枚，动作对得上', () => {
    const specs = thumbarSpecs('paused');
    expect(specs.map((spec) => spec.action)).toEqual(['prev', 'toggle', 'next']);
    expect(specs.map((spec) => spec.tooltip)).toEqual(['上一首', '播放', '下一首']);
  });

  it('在播时中间画「暂停」，暂停/空闲时画「播放」', () => {
    expect(thumbarSpecs('playing')[1]?.glyph).toBe('pause');
    expect(thumbarSpecs('playing')[1]?.tooltip).toBe('暂停');
    expect(thumbarSpecs('paused')[1]?.glyph).toBe('play');
    expect(thumbarSpecs('idle')[1]?.glyph).toBe('play');
  });

  it('有空闲（没有在听的歌）才把三枚键一起置灰', () => {
    expect(thumbarSpecs('idle').every((spec) => spec.disabled)).toBe(true);
    expect(thumbarSpecs('playing').some((spec) => spec.disabled)).toBe(false);
    expect(thumbarSpecs('paused').some((spec) => spec.disabled)).toBe(false);
  });
});

describe('describeThumbar', () => {
  it('一行里带上三枚键、中间键字形、置灰与挂载结果', () => {
    const line = describeThumbar(thumbarSpecs('playing'), true);
    expect(line).toContain('上一首 / 暂停 / 下一首');
    expect(line).toContain('中间键=暂停');
    expect(line).toContain('置灰=否');
    expect(line).toContain('挂载=成功');
    expect(describeThumbar(thumbarSpecs('idle'), false)).toContain('置灰=是');
    expect(describeThumbar(thumbarSpecs('idle'), false)).toContain('挂载=失败');
  });
});
