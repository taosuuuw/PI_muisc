/**
 * 商籁片尾海报版式的用例（第 526 轮）。
 * 全部针对 **`1920×1080`、`lyricsFontScale = 1`** 手算 ✓（外加一组小画面验上下限被夹住 ✓）。
 * 坐标约定：输出的是**已减掉半个画面**的中心坐标 ✓（上游容器 `pivot/position = (w/2, h/2)` ✓）。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_CREDITS_LAYOUT,
  buildSonnetCreditsPoster,
  type SonnetCreditsLineDraw,
  type SonnetCreditsRectDraw,
} from './sonnetCreditsPoster';

const W = 1920;
const H = 1080;
const HALF_W = W / 2;
const HALF_H = H / 2;

const build = (metadata: { title?: string; artist?: string; album?: string }) =>
  buildSonnetCreditsPoster({
    width: W,
    height: H,
    lyricsFontScale: 1,
    metadata,
    fontFamily: 'Test Font',
    titleWeight: 700,
    detailWeight: 500,
  });

describe('商籁片尾海报：几何四笔', () => {
  const poster = build({ title: 'T', artist: 'A', album: 'B' });
  const rects = poster.draws.filter((draw): draw is SonnetCreditsRectDraw => draw.kind === 'rect');
  const lines = poster.draws.filter((draw): draw is SonnetCreditsLineDraw => draw.kind === 'line');

  it('共四笔（三条 rect + 一条 line）', () => {
    expect(rects).toHaveLength(3);
    expect(lines).toHaveLength(1);
  });

  it('左内边距 / 右内边距 / 内容宽（1920 下：201.6 / 172.8 / 1545.6）', () => {
    // left = max(38, 1920 × 0.105) = 201.6 ✓
    expect(rects[0]?.x).toBeCloseTo(201.6 - HALF_W, 9);
    // 右块：x = 1920 − 172.8 − 8 − 960 = −180.8 ✓
    expect(rects[2]?.x).toBeCloseTo(W - 172.8 - 8 - HALF_W, 9);
    // 底线右端 = 1920 − 172.8 − 960 = 787.2 ✓
    expect(lines[0]?.x2).toBeCloseTo(W - 172.8 - HALF_W, 9);
  });

  it('accent 横条：宽 max(42, 1920×0.075) = 144、厚 5、y = 167.4−540 = −372.6', () => {
    const rule = rects[0];
    expect(rule?.width).toBeCloseTo(144, 9);
    expect(rule?.height).toBe(5);
    expect(rule?.y).toBeCloseTo(167.4 - HALF_H, 9);
    expect(rule?.tone).toBe('accent');
    expect(rule?.alpha).toBeCloseTo(0.95, 12);
  });

  it('primary 竖脊：2 × (1080×0.57 = 615.6)、0.22', () => {
    const spine = rects[1];
    expect(spine?.width).toBe(2);
    expect(spine?.height).toBeCloseTo(615.6, 9);
    expect(spine?.tone).toBe('primary');
    expect(spine?.alpha).toBeCloseTo(0.22, 12);
  });

  it('secondary 竖块：8 × (1080×0.34 = 367.2)、y = 243−540 = −297、0.32', () => {
    const block = rects[2];
    expect(block?.width).toBe(8);
    expect(block?.height).toBeCloseTo(367.2, 9);
    expect(block?.y).toBeCloseTo(243 - HALF_H, 9);
    expect(block?.tone).toBe('secondary');
    expect(block?.alpha).toBeCloseTo(0.32, 12);
  });

  it('底线：y = 853.2−540 = 313.2、1px、0.36', () => {
    const base = lines[0];
    expect(base?.y1).toBeCloseTo(853.2 - HALF_H, 9);
    expect(base?.y2).toBeCloseTo(base?.y1 ?? 0, 12);
    expect(base?.width).toBe(1);
    expect(base?.alpha).toBeCloseTo(0.36, 12);
    expect(base?.tone).toBe('primary');
  });
});

describe('商籁片尾海报：三条文字', () => {
  const poster = build({ title: ' Hello World ', artist: ' aimer ', album: ' dawn ' });
  const byKind = (kind: 'artist' | 'title' | 'album') =>
    poster.texts.find((text) => text.kind === kind);

  it('三条都在，且去空格（artist 转大写）', () => {
    expect(poster.texts).toHaveLength(3);
    expect(byKind('artist')?.text).toBe('AIMER');
    expect(byKind('title')?.text).toBe('Hello World');
    expect(byKind('album')?.text).toBe('— dawn');
  });

  it('字号：title 被 118 夹住（1920×0.088 = 168.96 ⇒ 118）、detail 被 25 夹住（34.56 ⇒ 25）', () => {
    expect(byKind('title')?.fontSize).toBeCloseTo(118, 9);
    expect(byKind('artist')?.fontSize).toBeCloseTo(25, 9);
    expect(byKind('album')?.fontSize).toBeCloseTo(25 * 0.92, 9); // 23 ✓
  });

  it('artist：x = 201.6+20−960 = −738.4、y = 221.4−540 = −318.6、字距 max(2, 25×0.18) = 4.5、accent', () => {
    const artist = byKind('artist');
    expect(artist?.x).toBeCloseTo(221.6 - HALF_W, 9);
    expect(artist?.y).toBeCloseTo(221.4 - HALF_H, 9);
    expect(artist?.letterSpacing).toBeCloseTo(4.5, 9);
    expect(artist?.tone).toBe('accent');
    expect(artist?.fontWeight).toBe(500);
    expect(artist?.wordWrapWidth).toBeCloseTo(1545.6 * 0.72, 6);
    expect(artist?.breakWords).toBe(false);
  });

  it('title：负行距 −9.44、负字距 −2.124、允许断词、x = 201.6+16−960、y = 307.8−540', () => {
    const title = byKind('title');
    expect(title?.x).toBeCloseTo(217.6 - HALF_W, 9);
    expect(title?.y).toBeCloseTo(307.8 - HALF_H, 9);
    expect(title?.leading).toBeCloseTo(-9.44, 9);
    expect(title?.letterSpacing).toBeCloseTo(-2.124, 9);
    expect(title?.breakWords).toBe(true);
    expect(title?.tone).toBe('primary');
    expect(title?.fontWeight).toBe(700);
    expect(title?.wordWrapWidth).toBeCloseTo(1545.6 * 0.88, 6);
  });

  it('album：x = 201.6+18−960、y = 891−540 = 351、字距 max(1, 25×0.1) = 2.5、secondary', () => {
    const album = byKind('album');
    expect(album?.x).toBeCloseTo(219.6 - HALF_W, 9);
    expect(album?.y).toBeCloseTo(891 - HALF_H, 9);
    expect(album?.letterSpacing).toBeCloseTo(2.5, 9);
    expect(album?.tone).toBe('secondary');
    expect(album?.fontWeight).toBe(500);
  });

  it('缺字段就不出对应的那条（全空 ⇒ 一条都没有）', () => {
    expect(build({}).texts).toHaveLength(0);
    expect(build({ artist: '   ' }).texts).toHaveLength(0);
    expect(build({ title: 'T' }).texts.map((text) => text.kind)).toEqual(['title']);
    expect(build({ album: 'B' }).texts.map((text) => text.kind)).toEqual(['album']);
    // 几何四笔与元数据无关，始终都在 ✓
    expect(build({}).draws).toHaveLength(4);
  });
});

describe('商籁片尾海报：小画面时上下限被夹住', () => {
  it('320×240：left/right 走 38、内容宽是"自然宽"244（还没触发 220 下限）、字号走 42 / 13', () => {
    const poster = buildSonnetCreditsPoster({
      width: 320,
      height: 240,
      lyricsFontScale: 1,
      metadata: { title: 'T', artist: 'A', album: 'B' },
      fontFamily: 'F',
      titleWeight: 700,
      detailWeight: 500,
    });
    const rects = poster.draws.filter((draw): draw is SonnetCreditsRectDraw => draw.kind === 'rect');
    expect(rects[0]?.x).toBeCloseTo(38 - 160, 9); // left = max(38, 33.6) = 38 ✓
    expect(rects[2]?.x).toBeCloseTo(320 - 38 - 8 - 160, 9); // right = 38 ✓
    expect(poster.texts.find((text) => text.kind === 'title')?.fontSize).toBeCloseTo(42, 9);
    expect(poster.texts.find((text) => text.kind === 'artist')?.fontSize).toBeCloseTo(13, 9);
    // ⚠ 这里**不**会触发下限：320 − 38 − 38 = 244 > 220 ⇒ wrap = 244 × 0.88 = 214.72 ✓
    // （我第一版用例算成 220 是错的 ✗ —— 这条例用正是在钉住这件事 ✓）
    expect(poster.texts.find((text) => text.kind === 'title')?.wordWrapWidth).toBeCloseTo(244 * 0.88, 6);
  });

  it('280×200：内容宽才真的被 220 下限抬起来（280 − 38 − 38 = 204 < 220）', () => {
    const poster = buildSonnetCreditsPoster({
      width: 280,
      height: 200,
      lyricsFontScale: 1,
      metadata: { title: 'T' },
      fontFamily: 'F',
      titleWeight: 700,
      detailWeight: 500,
    });
    expect(poster.texts.find((text) => text.kind === 'title')?.wordWrapWidth).toBeCloseTo(220 * 0.88, 6);
  });

  it('字体缩放影响字号而非间距基准（`fontScale = 0.5` ⇒ title 84.48、detail 17.28）', () => {
    const poster = buildSonnetCreditsPoster({
      width: 1920,
      height: 1080,
      lyricsFontScale: 0.5,
      metadata: { title: 'T', artist: 'A' },
      fontFamily: 'F',
      titleWeight: 700,
      detailWeight: 500,
    });
    expect(poster.texts.find((text) => text.kind === 'title')?.fontSize).toBeCloseTo(84.48, 9);
    expect(poster.texts.find((text) => text.kind === 'artist')?.fontSize).toBeCloseTo(17.28, 9);
  });
});

describe('商籁片尾海报：常量自查（防"改了数忘了理由"）', () => {
  it('关键常量与上游一致', () => {
    expect(SONNET_CREDITS_LAYOUT.leftInsetRatio).toBeCloseTo(0.105, 12);
    expect(SONNET_CREDITS_LAYOUT.rightInsetRatio).toBeCloseTo(0.09, 12);
    expect(SONNET_CREDITS_LAYOUT.minInset).toBe(38);
    expect(SONNET_CREDITS_LAYOUT.minContentWidth).toBe(220);
    expect(SONNET_CREDITS_LAYOUT.titleSizeRatio).toBeCloseTo(0.088, 12);
    expect(SONNET_CREDITS_LAYOUT.detailSizeRatio).toBeCloseTo(0.018, 12);
    expect(SONNET_CREDITS_LAYOUT.baseLineYRatio).toBeCloseTo(0.79, 12);
    expect(SONNET_CREDITS_LAYOUT.albumSizeRatio).toBeCloseTo(0.92, 12);
  });
});
