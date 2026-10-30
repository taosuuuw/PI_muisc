/**
 * V5 的单张世界画面素材。
 *
 * 这里只生成“母版”本身：一张低频蓝→青蓝→粉白的色彩场、量化色阶、
 * 半色调和细颗粒；以及一张唯一的 100×100 π 路径。所有窗口都只是这块
 * 画面的裁切，不在窗口内单独绘制或缩放任何东西。
 */

export const PI_PATHS = [
  'M 36 24 C 35 42 32 60 28 76 C 26 82 22 85 17 85',
  'M 64 24 C 65 42 68 60 72 76 C 74 82 78 85 83 85',
  'M 8 24 C 28 18 72 18 92 24',
] as const;

export type IntroScheme = 'light' | 'dark';

const TEXTURE_WIDTH = 1000;
const TEXTURE_HEIGHT = 563;

const PALETTE_LIGHT = [
  '#0636b6',
  '#074bd1',
  '#0a61e9',
  '#1185f2',
  '#27aceb',
  '#58ccec',
  '#a8e3ee',
  '#dff0ee',
  '#f6f1ea',
] as const;

// 与 light 相同的 9 级量化台阶，只换成中性黑白灰。
const PALETTE_DARK = [
  '#080808',
  '#101010',
  '#191919',
  '#262626',
  '#393939',
  '#555555',
  '#7c7c7c',
  '#b5b5b5',
  '#efefef',
] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type NoiseGrid = {
  width: number;
  height: number;
  values: Float32Array;
};

function noiseGrid(width: number, height: number, seed: number): NoiseGrid {
  const random = seeded(seed);
  const values = new Float32Array(width * height);
  for (let index = 0; index < values.length; index += 1) values[index] = random();
  return { width, height, values };
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function wrapUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}

function sampleNoise(grid: NoiseGrid, u: number, v: number): number {
  // 频率 >1 的坐标必须 wrap，而不是 clamp；否则右侧会全部塌成边缘常数。
  const x = wrapUnit(u) * grid.width;
  const y = wrapUnit(v) * grid.height;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = (x0 + 1) % grid.width;
  const y1 = (y0 + 1) % grid.height;
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);
  const at = (gx: number, gy: number): number => grid.values[gy * grid.width + gx] ?? 0;
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

const LOW_NOISE = noiseGrid(13, 8, 0x51f0a3);
const MID_NOISE = noiseGrid(21, 12, 0x8d37e1);
const FINE_NOISE = noiseGrid(37, 21, 0xc0ffee);

/**
 * 同一条低频场同时决定颜色、量化边界和网点浓度。数值越大越浅。
 */
function fieldAt(u: number, v: number): number {
  // 低频 1–2 倍全图、中频 2–4 倍、细层约 4 倍；不要把画面退化成细碎噪声。
  const low = sampleNoise(LOW_NOISE, u * 1.0 + 0.11, v * 1.1 + 0.07) - 0.5;
  const mid = sampleNoise(MID_NOISE, u * 2.0 + 0.29, v * 1.9 + 0.17) - 0.5;
  const fine = sampleNoise(FINE_NOISE, u * 4.0 + 0.43, v * 3.6 + 0.31) - 0.5;
  const blueMass = Math.exp(-(((u - 0.17) / 0.38) ** 2 + ((v - 0.18) / 0.43) ** 2));
  const paleMass = Math.exp(-(((u - 0.86) / 0.34) ** 2 + ((v - 0.82) / 0.41) ** 2));
  // 低频 warp 让蓝/白边界形成宽阔的湾口和局部色块，而不是平行直阶。
  const warpX = low * 0.09 + mid * 0.035;
  const warpY = low * 0.07 + mid * 0.028;
  const value =
    0.035 +
    (u + warpX) * 0.46 +
    (v + warpY) * 0.54 +
    low * 0.16 +
    mid * 0.07 +
    fine * 0.03 -
    blueMass * 0.11 +
    paleMass * 0.105;
  return clamp(value, 0, 1);
}

function paletteColor(value: number, scheme: IntroScheme): string {
  const palette = scheme === 'dark' ? PALETTE_DARK : PALETTE_LIGHT;
  const index = clamp(Math.floor(value * palette.length), 0, palette.length - 1);
  return palette[index] ?? palette[0];
}

function drawQuantizedLayer(
  context: CanvasRenderingContext2D,
  columns: number,
  rows: number,
  alpha: number,
  scheme: IntroScheme,
): void {
  const cellWidth = TEXTURE_WIDTH / columns;
  const cellHeight = TEXTURE_HEIGHT / rows;
  context.globalAlpha = alpha;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const u = (column + 0.5) / columns;
      const v = (row + 0.5) / rows;
      const value = fieldAt(u, v);
      context.fillStyle = paletteColor(value, scheme);
      context.fillRect(
        Math.floor(column * cellWidth),
        Math.floor(row * cellHeight),
        Math.ceil(cellWidth + 1),
        Math.ceil(cellHeight + 1),
      );
    }
  }
  context.globalAlpha = 1;
}

/**
 * 在 resize/首次挂载时只生成一次；SVG 里作为一张 image 使用。
 */
export function createWorldTexture(scheme: IntroScheme = 'light'): string {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const dark = scheme === 'dark';

  const base = context.createLinearGradient(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  if (dark) {
    base.addColorStop(0, '#080808');
    base.addColorStop(0.24, '#0f0f0f');
    base.addColorStop(0.47, '#202020');
    base.addColorStop(0.66, '#3b3b3b');
    base.addColorStop(0.82, '#777777');
    base.addColorStop(1, '#e9e9e9');
  } else {
    base.addColorStop(0, '#0634b2');
    base.addColorStop(0.24, '#0757df');
    base.addColorStop(0.47, '#1589ee');
    base.addColorStop(0.66, '#58c9ea');
    base.addColorStop(0.82, '#c6eaee');
    base.addColorStop(1, '#f5f0e9');
  }
  context.fillStyle = base;
  context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  // 三层不同尺度的量化色块：约 32/16/8px 的屏幕台阶，边缘被低频噪声打散。
  drawQuantizedLayer(context, 48, 27, 0.42, scheme);
  drawQuantizedLayer(context, 100, 56, 0.56, scheme);
  drawQuantizedLayer(context, 200, 112, 0.2, scheme);

  // 网点尺寸/浓度随明度变化；light 保留蓝墨/白点，dark 只换中性墨。
  const spacing = 7;
  for (let row = 0, y = spacing / 2; y < TEXTURE_HEIGHT; row += 1, y += spacing) {
    const offset = row % 2 === 0 ? 0 : spacing / 2;
    for (let x = spacing / 2 + offset; x < TEXTURE_WIDTH; x += spacing) {
      const u = x / TEXTURE_WIDTH;
      const v = y / TEXTURE_HEIGHT;
      const value = fieldAt(u, v);
      if (value < 0.58) {
        const strength = (0.58 - value) / 0.58;
        context.beginPath();
        context.arc(x, y, 0.6 + strength * 1.9, 0, Math.PI * 2);
        context.fillStyle = dark
          ? `rgba(235, 235, 235, ${0.06 + strength * 0.1})`
          : `rgba(6, 42, 122, ${0.1 + strength * 0.18})`;
        context.fill();
      } else if (value > 0.7) {
        context.beginPath();
        context.arc(x, y, 0.55, 0, Math.PI * 2);
        context.fillStyle = dark ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.08)';
        context.fill();
      }
    }
  }

  // 细颗粒：确定性的、一次性的轻噪声，不让画面变成纯渐变。
  const pixels = context.getImageData(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  const random = seeded(0x1f5eed);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const grain = (random() - 0.5) * 9;
    pixels.data[index] = clamp((pixels.data[index] ?? 0) + grain, 0, 255);
    pixels.data[index + 1] = clamp((pixels.data[index + 1] ?? 0) + grain, 0, 255);
    pixels.data[index + 2] = clamp((pixels.data[index + 2] ?? 0) + grain, 0, 255);
  }
  context.putImageData(pixels, 0, 0);

  return canvas.toDataURL('image/png');
}

/**
 * 三条路径只做一次等比变换；stroke 也在同一个 group 内统一。
 * 世界中心略偏左上；窗口据此裁切，而不是反过来迁就窗口。
 */
export function worldGlyphTransform(width: number, height: number): string {
  const scale = (Math.min(width, height) / 900) * 8;
  const centerX = width * 0.4875;
  const centerY = height * 0.478;
  return `translate(${(centerX - 50 * scale).toFixed(3)} ${(centerY - 51.5 * scale).toFixed(3)}) scale(${scale.toFixed(4)})`;
}
