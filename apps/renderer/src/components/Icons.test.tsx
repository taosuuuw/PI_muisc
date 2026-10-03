/**
 * 播放键那四枚图标的形状回归（用户第二十轮第 1 条）。
 *
 * 原话：「图 1、图 3 是我们暂停键的图标，我希望中间两个竖线应该像图 2、三角标像图 4 那样」。
 * 两张参照图是逐像素量出来的（`ref-pause.png` / `ref-play.png`），比例都相对那颗 40px 圆键的直径 D：
 *   暂停：竖条 0.097 D 宽 × 0.347 D 高、缝 0.065 D、圆角约条宽的 1/3；
 *   播放：三角**圆角之后**的包围盒 0.328 D、圆角约 0.03 D、光心比图标框中心右偏约 0.048 D。
 *
 * 这里不截图也不数像素，而是把「渲染出来的 `<svg>` 属性」当契约钉住：
 * ① 四枚图形必须真的带圆角描边（`stroke` 不是 none、`stroke-linejoin=round`、描边宽 = 登记的那三档）；
 * ② 骨架（`d`）按「外形 = 骨架沿各边外扩 r」换算成外形之后，比例要落在参照图量出来的数上。
 * 换算关系（`components/Icons.tsx` 的 `ROUND_JOIN` 注释里写了同一套）：
 *   暂停条外形宽 = 骨架宽 + 描边宽，缝 = 骨架缝 − 描边宽；
 *   三角外形包围盒 = 骨架包围盒 + 描边宽，圆角半径就是描边宽的一半。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from './Icons';
import type { IconName } from './Icons';

/** `Icon size={18}` ⇒ 24 格里的 1 格 = 0.75px。 */
const UNIT_PX = 18 / 24;
/** 播放键那颗圆键的直径（`styles/global.css` 的 `.pi-home__play`）。 */
const PLAY_BUTTON_PX = 40;
/** 把 24 格里的长度换成「相对键直径」的比例。 */
const ratio = (units: number): number => (units * UNIT_PX) / PLAY_BUTTON_PX;

function markupOf(name: IconName): string {
  return renderToStaticMarkup(<Icon name={name} size={18} />);
}

function pathOf(name: IconName): string {
  const match = /d="([^"]+)"/.exec(markupOf(name));
  if (match === null) throw new Error(`没有 path：${name}`);
  return match[1] ?? '';
}

function strokeWidthOf(name: IconName): number {
  const match = /stroke-width="([\d.]+)"/.exec(markupOf(name));
  if (match === null) throw new Error(`没有 stroke-width：${name}`);
  return Number(match[1]);
}

describe('播放键图标圆角（用户第二十轮第 1 条）', () => {
  it('四枚图形都走「内缩骨架 + 圆角描边」，描边宽是登记的那三档', () => {
    for (const [name, width] of [
      ['pause', 3.8],
      ['play', 3.5],
      ['prev', 2.2],
      ['next', 2.2],
    ] as const) {
      const markup = markupOf(name);
      // 描边一关，圆弧就没了 —— 那正是「直角时代」的样子。
      expect(markup).toContain('stroke="currentColor"');
      expect(markup).toContain('fill="currentColor"');
      expect(markup).toContain('stroke-linejoin="round"');
      expect(strokeWidthOf(name)).toBeCloseTo(width, 5);
    }
  });

  it('线描图标不受影响：`search` 照旧 fill=none / stroke-width 1.7', () => {
    const markup = markupOf('search');
    expect(markup).toContain('fill="none"');
    expect(markup).toContain('stroke-width="1.7"');
  });

  it('暂停：两根竖条的外形 / 缝 / 圆角都落在参照图的比例上', () => {
    const stroke = strokeWidthOf('pause');
    const r = stroke / 2;
    const bars = [...pathOf('pause').matchAll(/M([\d.]+) ([\d.]+)h([\d.]+)v([\d.]+)/g)].map(
      (m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
        w: Number(m[3]),
        h: Number(m[4]),
      }),
    );
    expect(bars).toHaveLength(2);
    const [first, second] = bars as [(typeof bars)[number], (typeof bars)[number]];

    const outerW = first.w + stroke;
    const outerH = first.h + stroke;
    const gap = second.x - (first.x + first.w) - stroke;

    // 参照图：0.097 D 宽 / 0.347 D 高 / 缝 0.065 D（截图被缩放过，容差给宽一点）。
    expect(ratio(outerW)).toBeCloseTo(0.097, 3);
    expect(ratio(outerH)).toBeCloseTo(0.347, 3);
    expect(ratio(gap)).toBeCloseTo(0.065, 2);
    // 圆角 ≈ 条宽的 1/3（参照图量到 2~3px / 6px）。
    expect(r / outerW).toBeGreaterThan(0.28);
    expect(r / outerW).toBeLessThan(0.45);
    // 两根等长等高、并排（不是一根长一根短）。
    expect(second.h).toBeCloseTo(first.h, 5);
    expect(second.w).toBeCloseTo(first.w, 5);
    expect(second.y).toBeCloseTo(first.y, 5);
  });

  it('播放三角：圆角后的包围盒 0.31 D 左右、光心右偏 0.05 D', () => {
    const stroke = strokeWidthOf('play');
    const r = stroke / 2;
    const match = /M([\d.]+) ([\d.]+)v([\d.]+)L([\d.]+) ([\d.]+)z/.exec(pathOf('play'));
    expect(match).not.toBeNull();
    const [, leftX, topY, height, apexX, apexY] = match ?? [];
    const x0 = Number(leftX) - r;
    const x1 = Number(apexX) + r;
    const y0 = Number(topY) - r;
    const y1 = Number(topY) + Number(height) + r;

    // 圆角「收」掉的是尖角那一侧，所以等高宽（正三角的两个底角 + 一个尖角，收完之后仍近似正方）。
    expect(ratio(x1 - x0)).toBeCloseTo(0.328, 2);
    expect(ratio(y1 - y0)).toBeCloseTo(0.328, 2);
    // 光心（包围盒中心）比图标框中心（12 格）右偏约 0.048 D。
    expect(ratio((x0 + x1) / 2 - 12)).toBeCloseTo(0.048, 2);
    // 圆角约 0.03 D。
    expect(ratio(r)).toBeCloseTo(0.033, 2);
    // 尖角仍比底边中点高/低（没被描边磨成一条线）。
    expect(Number(apexY)).toBeCloseTo((y0 + y1) / 2, 1);
  });

  it('上/下一首：竖条是圆头（零宽骨架 + 圆头描边），三角也是内缩过的', () => {
    for (const [name, head] of [
      ['prev', 'M8.1'],
      ['next', 'M15.9'],
    ] as const) {
      const d = pathOf(name);
      expect(d.startsWith(head)).toBe(true);
      // 竖条画成一条**零宽的线段**：靠描边的圆头长成 2.2 格宽的胶囊（等价于原来的 2.2×14 矩形）。
      expect(/M8\.1 6\.1v11\.8|M15\.9 6\.1v11\.8/.test(d)).toBe(true);
      expect(d).toContain('z');
    }
  });

  it('第二十轮新加的五枚线描图标都有非空 path', () => {
    for (const name of ['sun', 'moon', 'contrast', 'signal', 'crown'] as const) {
      const d = pathOf(name);
      expect(d.length).toBeGreaterThan(8);
      expect(d).not.toContain('undefined');
      expect(markupOf(name)).toContain('stroke-width="1.7"');
    }
  });
});
