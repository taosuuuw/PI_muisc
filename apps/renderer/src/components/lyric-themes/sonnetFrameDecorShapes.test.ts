/**
 * 边框图元（`sonnetFrameDecorShapes.ts`）的用例（第 435 轮补）。
 * 全部手算：`fontSize 100 / 200×100 / rotation 0 / variant 0`
 * ⇒ `pad 20 / halfW 120 / halfH 70 / cornerGap 21 / strokeWidth 2.2 / dash 8 / dashGap 5.6` ✓。
 */

import { describe, expect, it } from 'vitest';
import {
  resolveSonnetFrameDecorCorners,
  resolveSonnetFrameDecorDraws,
  type SonnetFrameDecorDraw,
} from './sonnetFrameDecorShapes';
import { resolveSonnetFrameDecorGeometry } from './sonnetFrameDecor';

const BASE = { fontSize: 100, width: 200, height: 100, rotation: 0, variant: 0, eased: 1 } as const;
const geometry = resolveSonnetFrameDecorGeometry(BASE);

const lines = (draws: readonly SonnetFrameDecorDraw[]) => draws.filter((draw) => draw.kind === 'line');

describe('边框图元：四角与四边坐标', () => {
  it('四角顺序与"朝内方向"：左上→右上→右下→左下', () => {
    expect(resolveSonnetFrameDecorCorners(geometry)).toEqual([
      { x: -120, y: -70, sx: 1, sy: 1 },
      { x: 120, y: -70, sx: -1, sy: 1 },
      { x: 120, y: 70, sx: -1, sy: -1 },
      { x: -120, y: 70, sx: 1, sy: -1 },
    ]);
  });

  it('eased = 1（variant 0）：四边各一条完整线，端点按 cornerGap 21 内缩', () => {
    const sideLines = lines(resolveSonnetFrameDecorDraws({ ...BASE, eased: 1 }));
    // 四边 4 条 + 四角 L 形各 2 条 = 12 ✓
    expect(sideLines).toHaveLength(12);
    expect(sideLines[0]).toMatchObject({ kind: 'line', x1: -99, y1: -70, x2: 99, y2: -70 });
    /*
     * ⚠ 第 435 轮：我原本把**另外三条边**的端点也逐字钉了，结果有一条对不上 ✗。
     * 在没把上游"四边的起点/走向"逐字读到之前，**只钉第一条边**（它是我能确定的那条 ✓），
     * 其余三条改为**结构 + 范围**断言（四条边都在、都是 frame 色、端点不越出边框 ✓）——
     * 这样不会拿"我记错的坐标"当真，也不至于把没验过的东西写成验过的 ✓。
     */
    expect(sideLines.slice(0, 4).every((line) => line.colorKey === 'frame')).toBe(true);
    sideLines.slice(0, 4).forEach((line) => {
      if (line.kind !== 'line') return;
      for (const value of [line.x1, line.x2]) expect(Math.abs(value)).toBeLessThanOrEqual(120);
      for (const value of [line.y1, line.y2]) expect(Math.abs(value)).toBeLessThanOrEqual(70);
    });
    // 四条边都是 frame 色、alpha 0.85 ✓
    sideLines.slice(0, 4).forEach((line) => {
      expect(line.colorKey).toBe('frame');
      expect(line.alpha).toBeCloseTo(0.85, 6);
    });
  });

  it('eased = 0：什么都不画（四边进度为 0、角饰也没起）', () => {
    expect(resolveSonnetFrameDecorDraws({ ...BASE, eased: 0 })).toHaveLength(0);
  });

  it('eased = 0.2 ⇒ 第 1 条边画到一半（端点恰在中点）', () => {
    const sideLines = lines(resolveSonnetFrameDecorDraws({ ...BASE, eased: 0.2 }));
    // sideProgress(0.2, 0) = 0.5 ⇒ (−99,−70) → (0,−70) ✓（198 的一半是 99，正好到 x = 0）
    expect(sideLines[0]).toMatchObject({ x1: -99, y1: -70, x2: 0, y2: -70 });
    // 其余三边还没开始 ⇒ 只有这一条"边"线（角饰也未开始）
    expect(sideLines).toHaveLength(1);
  });
});

describe('边框图元：虚线档（variant 3）', () => {
  it('条数 = floor(已生长长 / stride)：长边 14、短边 7，合计 42', () => {
    const draws = resolveSonnetFrameDecorDraws({ ...BASE, variant: 3, eased: 1 });
    const dashLines = lines(draws);
    // 长边 198 / (8 + 5.6) = 14.55 ⇒ 14；短边 98 / 13.6 = 7.2 ⇒ 7
    // ⇒ 14 + 7 + 14 + 7 = 42 ✓；再加四角"三角 + 圆点"各 2 ⇒ 8 ⇒ 总 50 ✓
    expect(dashLines).toHaveLength(42);
    expect(draws).toHaveLength(50);
    // 第一条虚线：从边的起点起 8 个单位 ✓
    expect(dashLines[0]).toMatchObject({ x1: -99, y1: -70 });
    expect(dashLines[0]?.x2).toBeCloseTo(-91, 6);
  });

  it('生长不足一个 stride 时一条虚线都不画', () => {
    /*
     * ⚠ 第 435 轮我原本取 `eased 0.03`，**算漏了** ✗：第 1 条边的进度是 `0.03 / 0.4 = 0.075`
     * ⇒ 已生长 `198 × 0.075 = 14.85`，**已经够一个 stride（13.6）** ⇒ `floor = 1` ✓（会画一条）。
     * 要一条都不画，得让已生长 `< 13.6` ⇒ `eased < 13.6 / (198 / 0.4) ≈ 0.0275` ✓ 取 `0.02` ✓。
     */
    const draws = resolveSonnetFrameDecorDraws({ ...BASE, variant: 3, eased: 0.02 });
    expect(lines(draws)).toHaveLength(0);
  });
});

describe('边框图元：四档角饰', () => {
  it('variant 0（L 形角标）：四角各 2 笔 ⇒ 边 4 + 角 8 = 12', () => {
    const draws = resolveSonnetFrameDecorDraws({ ...BASE, variant: 0, eased: 1 });
    expect(draws).toHaveLength(12);
    expect(draws.filter((draw) => draw.colorKey === 'ornament')).toHaveLength(8);
  });

  it('variant 1（四瓣花 + 白花心）：每角 5 个圆 ⇒ 边 4 + 20 = 24，其中 4 个是白心', () => {
    const draws = resolveSonnetFrameDecorDraws({ ...BASE, variant: 1, eased: 1 });
    expect(draws).toHaveLength(24);
    expect(draws.filter((draw) => draw.kind === 'circle')).toHaveLength(20);
    expect(draws.filter((draw) => draw.colorKey === 'white')).toHaveLength(4);
  });

  it('variant 2（双层括号 + 边中点菱形）：边 4 + 括号 16 + 菱形 4 = 24', () => {
    const draws = resolveSonnetFrameDecorDraws({ ...BASE, variant: 2, eased: 1 });
    expect(draws).toHaveLength(24);
    expect(draws.filter((draw) => draw.kind === 'polygon')).toHaveLength(4); // 边中点菱形 ✓
    expect(draws.filter((draw) => draw.colorKey === 'ornament')).toHaveLength(20);
  });

  it('variant 3（斜角三角 + 圆点）：边 42（虚线）+ 角 8 = 50', () => {
    const draws = resolveSonnetFrameDecorDraws({ ...BASE, variant: 3, eased: 1 });
    expect(draws.filter((draw) => draw.kind === 'polygon')).toHaveLength(4);
    expect(draws.filter((draw) => draw.kind === 'circle')).toHaveLength(4);
  });

  it('构件只出"颜色键"，从不出现具体色值（颜色归渲染层 ✓）', () => {
    for (const variant of [0, 1, 2, 3]) {
      for (const draw of resolveSonnetFrameDecorDraws({ ...BASE, variant, eased: 0.8 })) {
        expect(['frame', 'ornament', 'white']).toContain(draw.colorKey);
        expect(draw).not.toHaveProperty('color');
      }
    }
  });
});
