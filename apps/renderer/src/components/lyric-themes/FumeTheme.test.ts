import { describe, expect, it } from 'vitest';

import { fumeOutroOffset, fumeOutroPlan, fumeOutroSoon } from './FumeTheme';

/**
 * 第十五轮第 6 条（浮名结尾「缩小画面展示整个歌词」）的两个纯函数。
 * 它们只吃数字 / 尺寸，不碰 DOM —— 也就是「判据」与「缩放值」这两件最容易被写错的事。
 */
describe('fumeOutroPlan', () => {
  it('最后一行还没唱完时不开镜头（判据 = 最后一行 endMs 已过）', () => {
    expect(fumeOutroPlan(999, 1000, 2400, 3000, 1440, 900)).toEqual({ active: false, scale: 1 });
    expect(fumeOutroPlan(0, 1000, 2400, 3000, 1440, 900).active).toBe(false);
  });

  it('正好唱完那一刻开始缩小（边界含等号）', () => {
    const plan = fumeOutroPlan(1000, 1000, 2400, 3000, 1440, 900);
    expect(plan.active).toBe(true);
    expect(plan.scale).toBeLessThan(1);
  });

  it('没有歌词（末行为 0）时不进结尾镜头', () => {
    expect(fumeOutroPlan(999999, 0, 2400, 3000, 1440, 900)).toEqual({ active: false, scale: 1 });
  });

  it('缩放 = min(视口宽/纸宽, 视口高/纸高) × 0.94', () => {
    // 1440/2400 = 0.6、900/3000 = 0.3 ⇒ 取小的 0.3，再乘 0.94。
    expect(fumeOutroPlan(5000, 1000, 2400, 3000, 1440, 900).scale).toBeCloseTo(0.282, 6);
    // 反过来：宽度先贴满。1600/2400 = 0.667、900/1200 = 0.75 ⇒ 取 0.667 × 0.94。
    expect(fumeOutroPlan(5000, 1000, 2400, 1200, 1600, 900).scale).toBeCloseTo(0.626667, 6);
  });

  it('缩放夹在 [0.16, 1]：极小纸不放大、极长纸不缩到看不见', () => {
    expect(fumeOutroPlan(5000, 1000, 100, 100, 1440, 900).scale).toBe(1);
    expect(fumeOutroPlan(5000, 1000, 100000, 100000, 1440, 900).scale).toBe(0.16);
  });

  it('知道整首时长时：歌词没唱完但只剩 ≤5s 也进镜头（用户 m01402 第 3 条）', () => {
    // 末句 60s 才唱完、整首 61s：58s 处旧判据是 false，新判据（剩 3s）要开镜头。
    const soon = fumeOutroPlan(58000, 60000, 2400, 3000, 1440, 900, 61000);
    expect(soon.active).toBe(true);
    expect(soon.scale).toBeCloseTo(0.282, 6);
    // 同样位置但整首还有 12s ⇒ 不开。
    expect(fumeOutroPlan(58000, 60000, 2400, 3000, 1440, 900, 70000)).toEqual({
      active: false,
      scale: 1,
    });
    // 不传第 7 个参数（老调用点）＝ 不知道时长 ⇒ 行为与改造前逐字一致。
    expect(fumeOutroPlan(58000, 60000, 2400, 3000, 1440, 900)).toEqual({ active: false, scale: 1 });
  });
});

/**
 * 用户 m01402 第 3 条（M4 剩余项之一）：`data-fume-state='outro-soon'` 的判据。
 * 它与 `fumeOutroPlan` 的分工：`soon` 只认「还没唱完、但快到曲尾」，所以「唱完」与「快到点」
 * 在 DOM 上是两个可分辨的态。
 */
describe('fumeOutroSoon', () => {
  it('只剩 ≤5s（含等号）且歌词还没唱完 → true', () => {
    expect(fumeOutroSoon(58000, 60000, 61000)).toBe(true);
    expect(fumeOutroSoon(56000, 60000, 61000)).toBe(true); // 正好差 5000
  });

  it('还差得多、或不知道时长（0 / 负数）→ false', () => {
    expect(fumeOutroSoon(54000, 60000, 61000)).toBe(false);
    expect(fumeOutroSoon(58000, 60000, 0)).toBe(false);
    expect(fumeOutroSoon(58000, 60000, -1)).toBe(false);
  });

  it('歌词已经唱完 / 位置越过曲长 → false（那种情况归 finished）', () => {
    expect(fumeOutroSoon(60000, 60000, 61000)).toBe(false);
    expect(fumeOutroSoon(61001, 60000, 61000)).toBe(false);
  });
});

describe('fumeOutroOffset', () => {
  it('纸比视口小时：整张纸可完全可见，焦点居中就是居中', () => {
    // 视口 1000、纸 500（scale 1）⇒ 允许的位移区间 [0, 500]，焦点在纸中心 250 ⇒ 500 - 250 = 250。
    expect(fumeOutroOffset(250, 500, 1000, 1)).toBe(250);
  });

  it('纸比视口小时：跟随被夹住，纸永远不会出画', () => {
    // 焦点在最左（0）⇒ 想让它在屏幕中心要 500，但夹到 500 ⇒ 纸的右缘正好贴住视口右缘。
    expect(fumeOutroOffset(0, 500, 1000, 1)).toBe(500);
    // 焦点在最右（500）⇒ 想让它在中心要 0 ⇒ 夹到 0 ⇒ 纸贴住视口左缘。
    expect(fumeOutroOffset(500, 500, 1000, 1)).toBe(0);
  });

  it('纸刚好等于视口：唯一解 0（两个方向都贴满）', () => {
    expect(fumeOutroOffset(0, 1000, 1000, 1)).toBe(0);
    expect(fumeOutroOffset(1000, 1000, 1000, 1)).toBe(0);
  });

  it('纸比视口大（正常播放期）时反过来要求盖住视口', () => {
    // 视口 1000、纸 2000 ⇒ 允许区间 [-1000, 0]。
    expect(fumeOutroOffset(1000, 2000, 1000, 1)).toBe(-500);
    expect(fumeOutroOffset(0, 2000, 1000, 1)).toBe(0);
    expect(fumeOutroOffset(2000, 2000, 1000, 1)).toBe(-1000);
  });

  it('缩放参与计算：纸 500 × scale 0.5 = 250 宽', () => {
    // free = 1000 - 250 = 750 ⇒ 区间 [0, 750]；焦点 250 × 0.5 = 125 ⇒ 500 - 125 = 375。
    expect(fumeOutroOffset(250, 500, 1000, 0.5)).toBe(375);
  });
});
