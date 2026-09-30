/**
 * 生成 PI 的应用图标（零依赖）：
 *   build/pi.ico           —— 多尺寸 ICO（256/128/64/48/32/16），每帧都是**内嵌 PNG**
 *                             （Vista 起 ICO 支持内嵌 PNG）。快捷方式 .lnk、窗口图标、
 *                             文档引用都用它 —— 已经是验收过的文件，别乱动。
 *   build/pi-embed.ico     —— 同一套图形，但每帧是**未压缩的 32bpp BMP + AND 掩码**。
 *                             专供「写进 exe 的 PE 资源」和 electron-builder 用。
 *   build/pi-icon-256.png  —— 单张 PNG，供 README / 文档引用
 *
 * 为什么内嵌图标要单独出一份 BMP 版：
 *   实测结论（别凭直觉改）：把 PNG 帧与 BMP 帧分别写进 exe 后，`PrivateExtractIcons`
 *   —— 即资源管理器/任务栏真正走的那个 API —— 对**两种格式在 16/32/48/64/128/256 全部命中**，
 *   提取出来的画面也一致。所以 BMP 版不是「修 bug」，而是**保守**：BMP 帧是 ICO 最早的形态，
 *   任何直接读 .ico 文件的老工具（第三方安装器、图标编辑器、shell 扩展）都认；PNG 帧是
 *   Vista 才加的，少数工具至今读不出。代价只有体积（256 帧约 270 KB，相对 246 MB 的 exe 可忽略），
 *   而两份由同一段渲染代码生成，不会画歪。
 *   附注：`New-Object System.Drawing.Icon($exe, 256, 256)` 对**两种格式都会失败**，
 *   那是 .NET 内部走 ExtractIconEx 的老限制，不能当作格式好坏的证据（曾据此误判过）。
 *
 * 为什么不直接画个 SVG 转：这台机器上没有任何可用的 SVG 光栅化器（无 sharp/canvas，
 * 也不想为一个图标引入原生依赖）。PNG 本身就是「zlib 压缩的扫描线 + CRC 分块」，
 * Node 的 zlib 足够，于是这里手工编码 PNG；BMP 更简单，直接排 BITMAPINFOHEADER。
 *
 * 重新生成：pnpm icon
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../build');

const BG = [0x2e, 0x6b, 0xff]; // --pi-primary
const FG = [0xff, 0xff, 0xff];

/** 圆角矩形（用于底板）。 */
function roundedRect(x0, y0, x1, y1, r) {
  return (x, y) => {
    const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
    const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
    return Math.hypot(dx, dy) <= r;
  };
}

/** 直角矩形（用于字形笔画）。 */
function rect(x0, y0, x1, y1) {
  return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

// 字形画在 256×256 的坐标系里，整体水平居中（P 63..145、I 153..193 → 视觉中心 128）。
const GLYPH = [
  rect(63, 72, 87, 184), // P 竖笔
  rect(87, 72, 145, 98), // P 上横
  rect(119, 98, 145, 118), // P 右竖
  rect(87, 118, 145, 144), // P 中横
  rect(153, 72, 193, 88), // I 上衬线
  rect(163, 88, 183, 168), // I 竖笔
  rect(153, 168, 193, 184), // I 下衬线
];

/** 渲染一张 size×size 的 RGBA 位图；4×4 超采样做抗锯齿（预乘后平均，边缘才干净）。 */
function render(size) {
  const scale = size / 256;
  // 注意：下面采样得到的 px/py 是「256 空间」坐标，因此底板也必须建在 256 空间，
  // scale 只用于把像素中心映射回 256 空间。之前这里用 *scale / size 建在像素空间，
  // 于是 256 以外的帧只承认左上角 size×size 的一小块 —— 任务栏图标只剩一个角。
  const bg = roundedRect(3, 3, 253, 253, 52);
  const glyphs = GLYPH.map((shape) => shape);
  const samples = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) / scale;
          const py = (y + (sy + 0.5) / samples) / scale;
          if (!bg(px, py)) continue;
          const onGlyph = glyphs.some((shape) => shape(px, py));
          const [cr, cg, cb] = onGlyph ? FG : BG;
          // 预乘 alpha（此处 alpha 恒为 1）后累加
          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }
      const total = samples * samples;
      const offset = rowStart + 1 + x * 4;
      const alpha = a / total;
      // 反预乘回直通 alpha，PNG 用非预乘存储
      raw[offset] = alpha === 0 ? 0 : Math.round((r / total / (alpha / 255)) || 0);
      raw[offset + 1] = alpha === 0 ? 0 : Math.round((g / total / (alpha / 255)) || 0);
      raw[offset + 2] = alpha === 0 ? 0 : Math.round((b / total / (alpha / 255)) || 0);
      raw[offset + 3] = Math.round(alpha);
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function toPng(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(render(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 把 `render(size)` 的扫描线编成 ICO 里可以放的「32bpp DIB」：
 *   BITMAPINFOHEADER(40B) + XOR 位图(BGRA, 自下而上) + AND 掩码(1bpp, 自下而上, 每行 4 字节对齐)
 * 高度字段要写 `size * 2`（XOR 与 AND 叠在一起的高度），这是 ICO 里 DIB 的老规矩。
 */
function toBmp(size) {
  const raw = render(size); // 每行 1 字节 filter + size*4 字节 RGBA
  const rowBytes = size * 4;
  const maskStride = Math.ceil(size / 32) * 4; // 1bpp，行按 4 字节对齐

  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0); // biSize
  info.writeInt32LE(size, 4); // biWidth
  info.writeInt32LE(size * 2, 8); // biHeight（XOR + AND）
  info.writeUInt16LE(1, 12); // biPlanes
  info.writeUInt16LE(32, 14); // biBitCount
  info.writeUInt32LE(0, 16); // biCompression = BI_RGB
  info.writeUInt32LE(rowBytes * size, 20); // biSizeImage（仅 XOR 部分）

  const xor = Buffer.alloc(rowBytes * size);
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y += 1) {
    const src = y * (rowBytes + 1) + 1; // 跳过 filter 字节
    const dst = (size - 1 - y) * rowBytes; // DIB 自下而上
    const maskRow = (size - 1 - y) * maskStride;
    for (let x = 0; x < size; x += 1) {
      const r = raw[src + x * 4];
      const g = raw[src + x * 4 + 1];
      const b = raw[src + x * 4 + 2];
      const a = raw[src + x * 4 + 3];
      xor[dst + x * 4] = b; // BGRA
      xor[dst + x * 4 + 1] = g;
      xor[dst + x * 4 + 2] = r;
      xor[dst + x * 4 + 3] = a;
      // AND 掩码：1 = 透明；每字节最高位是最左边那个像素
      if (a === 0) mask[maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([info, xor, mask]);
}

/** 把若干帧（已是 ICO 帧格式的 Buffer）打包成一个 .ico 文件。 */
function packIco(frames) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(frames.length, 4);

  let offset = 6 + frames.length * 16;
  const entries = frames.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size; // ICO 目录里 0 表示 256
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0; // 调色板数
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([dir, ...entries, ...frames.map((f) => f.data)]);
}

const SIZES = [256, 128, 64, 48, 32, 16];
const pngFrames = SIZES.map((size) => ({ size, data: toPng(size) }));
const bmpFrames = SIZES.map((size) => ({ size, data: toBmp(size) }));

mkdirSync(outDir, { recursive: true });
const ico = path.join(outDir, 'pi.ico');
writeFileSync(ico, packIco(pngFrames));
const embedIco = path.join(outDir, 'pi-embed.ico');
writeFileSync(embedIco, packIco(bmpFrames));
writeFileSync(path.join(outDir, 'pi-icon-256.png'), pngFrames[0].data);

const kb = (buffer) => `${(buffer.length / 1024).toFixed(1)} KB`;
console.info(`[pi] 图标已生成：${ico}（内嵌 PNG 帧，${kb(packIco(pngFrames))}）`);
console.info(`[pi] 内嵌 exe 专用：${embedIco}（32bpp BMP 帧，${kb(packIco(bmpFrames))}）`);
console.info(`[pi] 尺寸：${SIZES.join(' / ')}；单张 PNG：build/pi-icon-256.png`);
