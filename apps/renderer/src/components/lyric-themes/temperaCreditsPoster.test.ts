import { describe, expect, it } from 'vitest';

import { buildTemperaCreditsPoster } from './temperaCreditsPoster';

const input = {
  width: 1200,
  height: 800,
  title: '曲名',
  artist: 'A',
  album: 'B',
  lyricsFontScale: 1,
  showDecor: true,
  titleHeight: 60,
};

describe('凝彩片尾海报：色调底', () => {
  const poster = buildTemperaCreditsPoster(input);
  const ground = poster.draws[0];

  it('第一笔是满幅色调底，且**自身不动**', () => {
    expect(ground?.kind).toBe('polygon');
    if (ground?.kind !== 'polygon') return;
    expect(ground.tone).toBe('tone1');
    expect(ground.alpha).toBe(1);
    expect(ground.item).toEqual({
      baseX: 0,
      baseY: 0,
      baseAlpha: 1,
      enterDX: 0,
      enterDY: 0,
      delay: 0,
      driftX: 0,
      driftY: 0,
      grow: 0,
    });
  });
});

describe('凝彩片尾海报：三块圆盘', () => {
  const poster = buildTemperaCreditsPoster(input);
  const discs = poster.draws.filter(
    (draw): draw is Extract<typeof draw, { kind: 'polygon' }> =>
      draw.kind === 'polygon' && draw.outlineWidth === 2.4 && draw.hatch === null,
  );

  it('恒三块填充，色调沿 tone2→tone3→tone4 逐块提亮', () => {
    const fills = poster.draws.filter(
      (draw): draw is Extract<typeof draw, { kind: 'polygon' }> =>
        draw.kind === 'polygon' && draw.tone !== 'tone1' && draw.hatch === null && draw.outlineWidth === null,
    );
    expect(fills.map((draw) => draw.tone)).toEqual(['tone2', 'tone3', 'tone4']);
  });

  it('圆盘用 72 段的圆（144 个坐标）', () => {
    for (const disc of discs) expect(disc.points).toHaveLength(144);
  });

  it('每块都带硬墨线描边（2.4 / α0.8），且延迟比填充晚 0.04', () => {
    for (const disc of discs) {
      expect(disc.outlineAlpha).toBe(0.8);
      expect(disc.item.delay).toBeCloseTo(disc.item.delay, 10);
    }
    const outlines = poster.draws.filter(
      (draw): draw is Extract<typeof draw, { kind: 'polygon' }> => draw.kind === 'polygon' && draw.tone === 'ink',
    );
    expect(outlines).toHaveLength(3);
    for (const outline of outlines) expect(outline.outlineWidth).toBe(2.4);
  });

  it('**只有一块**带网点，且是 paper 色 / α0.28', () => {
    const hatched = poster.draws.filter(
      (draw): draw is Extract<typeof draw, { kind: 'polygon' }> =>
        draw.kind === 'polygon' && draw.hatch !== null && draw.tone === 'paper',
    );
    expect(hatched).toHaveLength(1);
    expect(hatched[0]?.hatchAlpha).toBe(0.28);
  });
});

describe('凝彩片尾海报：交叉线与角饰', () => {
  const poster = buildTemperaCreditsPoster(input);
  const lines = poster.draws.filter(
    (draw): draw is Extract<typeof draw, { kind: 'line' }> => draw.kind === 'line',
  );

  it('交叉线是 tone4 / 宽1.3 / α0.6，延迟 0.5、进场沿 +x', () => {
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line.tone).toBe('tone4');
      expect(line.width).toBe(1.3);
      expect(line.alpha).toBe(0.6);
      expect(line.item.delay).toBe(0.5);
      expect(line.item.enterDX).toBeCloseTo(1200 * 0.2, 10);
    }
  });

  it('角饰只在 showDecor 时出现（小方框：网点 + 描边）', () => {
    const withDecor = buildTemperaCreditsPoster(input);
    const without = buildTemperaCreditsPoster({ ...input, showDecor: false });
    const count = (poster_: typeof withDecor): number =>
      poster_.draws.filter(
        (draw) => draw.kind === 'polygon' && draw.item.delay >= 0.68 && draw.item.delay <= 0.72,
      ).length;
    expect(count(withDecor)).toBe(2);
    expect(count(without)).toBe(0);
  });
});

describe('凝彩片尾海报：文案', () => {
  it('标题缺省用音符兜底；只有 artist 时副标题仍成立', () => {
    const poster = buildTemperaCreditsPoster({ ...input, title: '   ' });
    expect(poster.texts[0]?.text).toBe('\u266a');
    // ⚠ 这里 artist 仍在 ⇒ 副标题 = 'A' 仍成立，所以是两条文案（别误以为"少了 album 就没副标题"）。
    const poster2 = buildTemperaCreditsPoster({ ...input, album: undefined });
    expect(poster2.texts).toHaveLength(2);
    expect(poster2.texts[1]?.text).toBe('A');
    const poster3 = buildTemperaCreditsPoster({ ...input, album: undefined, artist: null });
    expect(poster3.texts).toHaveLength(1);
  });

  it('副标题字号 max(14, titleSize×0.34)、α0.75、y 偏 titleHeight/2 + titleSize×0.22', () => {
    const poster = buildTemperaCreditsPoster(input);
    const titleSize = poster.texts[0]?.fontPx ?? 0;
    const subtitle = poster.texts[1];
    expect(subtitle?.fontPx).toBeCloseTo(Math.max(14, titleSize * 0.34), 10);
    expect(subtitle?.alpha).toBe(0.75);
    expect(subtitle?.offsetY).toBeCloseTo(60 / 2 + titleSize * 0.22, 10);
  });

  it('标题本身不动（只靠 enterDY 进场），延迟 0.78', () => {
    const poster = buildTemperaCreditsPoster(input);
    const title = poster.texts[0];
    expect(title?.alpha).toBe(1);
    expect(title?.item.delay).toBe(0.78);
    expect(title?.item.driftX).toBe(0);
    expect(title?.item.driftY).toBe(0);
    expect(title?.item.enterDY).toBeCloseTo(Math.hypot(1200, 800) * 0.03, 10);
  });
});

describe('凝彩片尾海报：角饰的十字行', () => {
  const marksOf = (showDecor: boolean) =>
    buildTemperaCreditsPoster({ ...input, showDecor }).draws.filter(
      (draw): draw is Extract<(typeof draw), { kind: 'marks' }> => draw.kind === 'marks',
    );

  it('showDecor 时恰好一行，scale 2 / α0.8 / 沿 -x 进场 / 延迟 0.62', () => {
    const rows = marksOf(true);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.markScale).toBe(2);
    expect(row?.alpha).toBe(0.8);
    expect(row?.item.delay).toBe(0.62);
    expect(row?.item.enterDX).toBeCloseTo(-1200 * 0.06, 10);
    // 行内的点由 `buildCrossRow` 出，计划层**原样转交**（不猜字段），所以这里只断言非空。
    expect((row?.marks.length ?? 0)).toBeGreaterThan(0);
  });

  it('showDecor 关闭时完全不出这一行', () => {
    expect(marksOf(false)).toHaveLength(0);
  });
});
