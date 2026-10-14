/**
 * 任务栏缩略图工具栏的**纯逻辑**（主人本轮第 3 条）。
 *
 * 主人原话：「悬停任务栏出现的预览框底部缺少音乐播放器应该拥有的部件，
 * 如图 3 所示的上下切歌和暂停」。
 *
 * 那张图里的三个键不是应用自己画的 —— 卡片是 Windows 画的，卡片下面那排键也是 Windows
 * 画的，只不过**内容由应用提供**：`ITaskbarList3::ThumbBarAddButtons`。Electron 把它包成
 * `BrowserWindow.setThumbarButtons()`（仅 Windows）。
 *
 * 这个文件只做两件**不碰 Electron** 的事，好让它们能被单测直接钉住：
 *   1. 三个字形的位图（上一首 / 播放 / 暂停 / 下一首）—— 用代码画，不读文件。
 *      为什么和托盘兜底图同一路数（`tray.ts` 的 `buildFallbackTrayBitmap`）：字形是这套
 *      界面里**最不该因为「某个 png 没打进包」而消失**的东西；代码画的图在任何布局下都画得出来。
 *   2. 「当前是什么播放状态 ⇒ 三枚键长什么样」的映射（`thumbarSpecs`）。
 *
 * 颜色为什么跟着主题走：Windows 11 那张悬停卡片的底色跟随系统明暗，而缩略图工具栏的图标
 * **不会被系统自动反色**——浅色底上画白字、深色底上画黑字都会看不见，所以这里按
 * `nativeTheme.shouldUseDarkColors` 出两种前景色。
 */
import type { MediaCommand, MediaStateReport } from '@pi/ipc';

/** 字形种类。`play` / `pause` 是同一个位置上的两种状态，不是两枚键。 */
export type ThumbarGlyph = 'prev' | 'play' | 'pause' | 'next';

export interface ThumbarSpec {
  action: MediaCommand;
  glyph: ThumbarGlyph;
  tooltip: string;
  /** 没在听歌时三枚键一起置灰（点了也没用，就别让人以为点了会有反应）。 */
  disabled: boolean;
}

/* ------------------------------------------------------------------ *
 * 字形 → 位图
 * ------------------------------------------------------------------ */

/** 设计网格：所有坐标都按 16×16 写，再按实际尺寸缩放。 */
const DESIGN = 16;

/** 浅色底上的字形（近黑）与深色底上的字形（近白）。 */
const INK_ON_LIGHT = { r: 0x1f, g: 0x1f, b: 0x1f };
const INK_ON_DARK = { r: 0xf2, g: 0xf2, b: 0xf2 };

interface Point {
  x: number;
  y: number;
}

/** 半平面同号判定：一个点是否落在三角形内（含边界）。 */
function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function inRect(p: Point, x0: number, y0: number, x1: number, y1: number): boolean {
  return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
}

/**
 * 字形在 16×16 网格上的定义。
 *
 * 数值是照着「播放器上的上一首/下一首」那个惯例摆的：竖条贴边 + 一个三角形指向那一侧；
 * 播放是一个朝右的三角形，暂停是两根等高的竖条。三角形故意比竖条高一点（3~13 对 4~12），
 * 这样 16px 下看起来是「一样高」，而不是三角形缩在中间。
 */
function isGlyphPixel(glyph: ThumbarGlyph, p: Point): boolean {
  switch (glyph) {
    case 'prev':
      return (
        inRect(p, 2, 4, 4.5, 12) ||
        inTriangle(p, { x: 5, y: 8 }, { x: 12.5, y: 3 }, { x: 12.5, y: 13 })
      );
    case 'next':
      return (
        inRect(p, 11.5, 4, 14, 12) ||
        inTriangle(p, { x: 11, y: 8 }, { x: 3.5, y: 3 }, { x: 3.5, y: 13 })
      );
    case 'play':
      return inTriangle(p, { x: 4.5, y: 3 }, { x: 4.5, y: 13 }, { x: 13, y: 8 });
    case 'pause':
      return inRect(p, 4, 3, 6.5, 13) || inRect(p, 9.5, 3, 12, 13);
  }
}

/**
 * 画一枚字形，返回 **BGRA** 位图（`nativeImage.createFromBitmap` 要的顺序，和托盘兜底图一致）。
 *
 * 取像素中心（`x + 0.5`）去判定，避免整数边界的半像素偏移让竖条一边胖一边瘦。
 */
export function buildThumbarGlyph(
  glyph: ThumbarGlyph,
  options: { size?: number; dark?: boolean } = {},
): { width: number; height: number; buffer: Buffer } {
  const width = Math.max(DESIGN, Math.round(options.size ?? DESIGN));
  const height = width;
  const ink = options.dark === true ? INK_ON_DARK : INK_ON_LIGHT;
  const buffer = Buffer.alloc(width * height * 4);
  const scale = DESIGN / width;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const design: Point = { x: (x + 0.5) * scale, y: (y + 0.5) * scale };
      if (!isGlyphPixel(glyph, design)) continue; // alpha=0，透明
      const offset = (y * width + x) * 4;
      buffer[offset] = ink.b;
      buffer[offset + 1] = ink.g;
      buffer[offset + 2] = ink.r;
      buffer[offset + 3] = 0xff;
    }
  }
  return { width, height, buffer };
}

/* ------------------------------------------------------------------ *
 * 播放状态 → 三枚键
 * ------------------------------------------------------------------ */

/**
 * 当前状态该摆哪三枚键。
 *
 * 顺序固定「上一首 / 播放暂停 / 下一首」（Windows 上就是左中右，用户不用找）；
 * 中间那枚的字形由状态决定：**在播就画暂停、其余一律画播放**。
 * `idle` 表示「没有在听的歌」，此时三枚键一起 disable —— 点了不会有反应的东西不该看起来能点。
 */
export function thumbarSpecs(status: MediaStateReport['status']): ThumbarSpec[] {
  const playing = status === 'playing';
  const idle = status === 'idle';
  return [
    { action: 'prev', glyph: 'prev', tooltip: '上一首', disabled: idle },
    {
      action: 'toggle',
      glyph: playing ? 'pause' : 'play',
      tooltip: playing ? '暂停' : '播放',
      disabled: idle,
    },
    { action: 'next', glyph: 'next', tooltip: '下一首', disabled: idle },
  ];
}

/** 把一次设置压成一行日志（缩略图工具栏没有 getter，排障只能靠这行）。 */
export function describeThumbar(specs: ThumbarSpec[], applied: boolean): string {
  const names = specs.map((spec) => spec.tooltip).join(' / ');
  return `${names}｜中间键=${specs[1]?.glyph === 'pause' ? '暂停' : '播放'}｜置灰=${
    specs[0]?.disabled === true ? '是' : '否'
  }｜挂载=${applied ? '成功' : '失败'}`;
}
