import { describe, expect, it } from 'vitest';

import {
  TEMPERA_CREDITS_CREEP_SECONDS,
  TEMPERA_CREDITS_DISC_COUNT,
  buildTemperaCreditsLayout,
  hasTemperaCreditsMetadata,
  resolveTemperaCreditsItemFrame,
  temperaCreditsCreep,
} from './temperaCreditsLayout';

const input = { width: 1200, height: 800, title: 'T', artist: 'A', album: 'B', lyricsFontScale: 1 };

describe('凝彩片尾：元数据判定', () => {
  it('任一字段 trim 非空即算有', () => {
    expect(hasTemperaCreditsMetadata({})).toBe(false);
    expect(hasTemperaCreditsMetadata({ title: '   ' })).toBe(false);
    expect(hasTemperaCreditsMetadata({ artist: 'Aimer' })).toBe(true);
    expect(hasTemperaCreditsMetadata({ album: ' x ' })).toBe(true);
  });
});

describe('凝彩片尾：渐近漂移', () => {
  it('出现前为 0、单调不减、恒 < 1', () => {
    expect(temperaCreditsCreep(-5)).toBe(0);
    let previous = 0;
    for (let elapsed = 0; elapsed <= 40; elapsed += 0.5) {
      const value = temperaCreditsCreep(elapsed);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThan(1);
      previous = value;
    }
  });

  it('时间常数 7 秒 ⇒ creep(7) = 1 - 1/e', () => {
    expect(TEMPERA_CREDITS_CREEP_SECONDS).toBe(7);
    expect(temperaCreditsCreep(7)).toBeCloseTo(1 - Math.exp(-1), 10);
  });
});

describe('凝彩片尾：版式', () => {
  const layout = buildTemperaCreditsLayout(input);
  const diagonal = Math.hypot(input.width, input.height);

  it('确定性：同一份元数据给出同一版式', () => {
    expect(buildTemperaCreditsLayout(input)).toEqual(layout);
  });

  it('flip 只取 ±1，bleed 是 0.25 倍对角线', () => {
    expect([1, -1]).toContain(layout.flip);
    expect(layout.bleed).toBeCloseTo(diagonal * 0.25, 10);
  });

  it('恒为三块色块，且**只有一块**带网点', () => {
    expect(layout.discs).toHaveLength(TEMPERA_CREDITS_DISC_COUNT);
    expect(layout.discs.filter((disc) => disc.hasHatch)).toHaveLength(1);
    expect(layout.hatchIndex).toBeGreaterThanOrEqual(0);
    expect(layout.hatchIndex).toBeLessThan(TEMPERA_CREDITS_DISC_COUNT);
  });

  it('圆心远在画面外、近边越过中线（这是"弧线穿过文字"的来源）', () => {
    for (const disc of layout.discs) {
      const distance = Math.hypot(disc.cx, disc.cy);
      expect(distance).toBeGreaterThanOrEqual(diagonal * 0.58 - 1e-9);
      expect(distance).toBeLessThanOrEqual(diagonal * 0.72 + 1e-9);
      // radius > distance ⇒ 圆盘盖住原点，即盖住画面中心。
      expect(disc.radius).toBeGreaterThan(distance);
    }
  });

  it('延迟按 0.08 + i×0.16；描边比填充晚 0.04、网点晚 0.06', () => {
    layout.discs.forEach((disc, index) => {
      expect(disc.delay).toBeCloseTo(0.08 + index * 0.16, 10);
      expect(disc.outlineDelay).toBeCloseTo(disc.delay + 0.04, 10);
      expect(disc.hatchDelay).toBeCloseTo(disc.delay + 0.06, 10);
    });
  });

  it('进场与漂移同轴反向，量值分别是 0.16 / 0.024 倍对角线', () => {
    for (const disc of layout.discs) {
      expect(Math.hypot(disc.enterDX, disc.enterDY)).toBeCloseTo(diagonal * 0.16, 6);
      expect(Math.hypot(disc.driftX, disc.driftY)).toBeCloseTo(diagonal * 0.024, 6);
      expect(disc.enterDX * disc.driftX).toBeLessThan(0);
    }
  });

  it('字号与折行宽按上游公式', () => {
    expect(layout.titleSize).toBeCloseTo(Math.max(26, Math.min(1200, 800) * 0.085), 10);
    expect(layout.wrapWidth).toBeCloseTo(Math.min(1200 * 0.72, diagonal * 0.52), 10);
  });

  it('小画面时字号有 26 的下限', () => {
    const small = buildTemperaCreditsLayout({ ...input, width: 200, height: 150, lyricsFontScale: 0.5 });
    expect(small.titleSize).toBe(26);
  });

  it('副标题是 artist - album（缺项不留多余分隔符）', () => {
    expect(layout.subtitle).toBe('A - B');
    expect(buildTemperaCreditsLayout({ ...input, album: undefined }).subtitle).toBe('A');
    expect(buildTemperaCreditsLayout({ ...input, artist: null, album: 'B' }).subtitle).toBe('B');
  });
});

describe('凝彩片尾：单个零件的推进', () => {
  const item = {
    baseX: 100,
    baseY: -50,
    baseAlpha: 0.8,
    enterDX: 40,
    enterDY: 60,
    delay: 0.5,
    driftX: -10,
    driftY: -20,
    grow: 0.06,
  };

  it('出场之前不可见、且停在"进场起点"上', () => {
    const frame = resolveTemperaCreditsItemFrame(item, 0);
    expect(frame.visible).toBe(false);
    expect(frame.alpha).toBeLessThanOrEqual(0);
    expect(frame.x).toBeCloseTo(item.baseX + item.enterDX, 6);
    expect(frame.y).toBeCloseTo(item.baseY + item.enterDY, 6);
  });

  it('进场走完（delay + 1.1s）时到达基准位，alpha 到 baseAlpha', () => {
    const frame = resolveTemperaCreditsItemFrame(item, item.delay + 1.1);
    expect(frame.alpha).toBeCloseTo(item.baseAlpha, 6);
    expect(frame.visible).toBe(true);
    // ⚠ 此刻 `enter` 已到 1，但 **creep 也已不为 0**（delay+1.1 时约 0.20），
    // 所以位置是"基准位 + drift×creep"，不是裸的基准位。
    const creep = temperaCreditsCreep(item.delay + 1.1);
    expect(frame.x).toBeCloseTo(item.baseX + item.driftX * creep, 6);
    expect(frame.y).toBeCloseTo(item.baseY + item.driftY * creep, 6);
  });

  it('之后只由 creep 带动漂移与长大（渐近、不跑飞）', () => {
    const frame = resolveTemperaCreditsItemFrame(item, item.delay + 30);
    const creep = temperaCreditsCreep(item.delay + 30);
    expect(frame.x).toBeCloseTo(item.baseX + item.driftX * creep, 6);
    expect(frame.y).toBeCloseTo(item.baseY + item.driftY * creep, 6);
    expect(frame.scale).toBeCloseTo(1 + item.grow * creep, 10);
  });

  it('grow 为 0 时完全不缩放', () => {
    const frame = resolveTemperaCreditsItemFrame({ ...item, grow: 0 }, item.delay + 10);
    expect(frame.scale).toBe(1);
  });
});
