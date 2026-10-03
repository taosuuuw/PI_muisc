/**
 * 应用主题色（用户第二十一轮第 5 条：「在设置里加入应用主题色设置，影响按键的颜色等，
 * 将黑白/天蓝设为默认色，并且有自定义选项」）。
 *
 * 三档：
 * - `sky`（默认天蓝）：什么也不覆盖，直接用 `styles/tokens.css` 里那四枚 `--pi-primary*`；
 * - `mono`（黑白）：亮档拿近黑、暗档拿近白当主色，写死在 tokens.css 的两块
 *   `[data-accent='mono']` 里（两档各自配一枚 `--pi-on-primary`）；
 * - `custom`（自定义）：用户挑一个颜色，本文件把它算成整套五枚变量，
 *   `App.tsx` 的 `useAccent` 写成 `<html>` 上的内联自定义属性。
 *
 * 为什么自定义这一档在 JS 里算、不写 `color-mix()`：淡底/悬停/深色这几档 `color-mix()` 都能算，
 * 但「这枚主色上该压黑字还是白字」要看**相对亮度**，CSS 没有这个函数。
 * 所以换算全放这个纯函数里，`accent.test.ts` 直接盯住亮度分界与各档取色方向。
 */

/** 主题色档位（存 localStorage 的 `pi.accent`，不进 `Settings`——理由同 `uiStyle`）。 */
export type AccentMode = 'sky' | 'mono' | 'custom';

/** 自定义档的初值：就是默认那枚天蓝，用户点「自定义」时从它开始调。 */
export const DEFAULT_ACCENT_COLOR = '#1f9bff';

/** 主色底上的前景色默认值（tokens.css 的 `--pi-on-primary` 同值）。 */
export const DEFAULT_ON_PRIMARY = '#ffffff';

/**
 * 选色面板用的 HSV（`h` 0–360、`s`/`v` 0–1）。
 *
 * 用户第二十二轮第 2 条要的是图 2 那种「渐变方块 + 色相条」的取色器 ——
 * 那种面板的坐标天然是 HSV（方块一行是饱和度、一列是明度），所以换算放这里做纯函数，
 * `AccentPicker` 只负责画与接指针，`accent.test.ts` 盯住往返精度。
 */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

/** `#rrggbb` → HSV。认不出的色值当纯黑（面板不崩、只是手柄落在左下角）。 */
export function hexToHsv(hex: string): Hsv {
  const rgb = parseHexColor(hex) ?? [0, 0, 0];
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

/** HSV → `#rrggbb`（各分量先夹回合法区间）。 */
export function hsvToHex(hsv: Hsv): string {
  const h = ((hsv.h % 360) + 360) % 360;
  const s = Math.min(1, Math.max(0, hsv.s));
  const v = Math.min(1, Math.max(0, hsv.v));
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/**
 * 选色面板下方的「推荐色」（用户第二十二轮第 2 条图 3 那 12 枚：红粉橙一档、
 * 蓝紫一档、白黑灰一档）。顺序照图排：四列 × 三行。
 */
export const RECOMMENDED_ACCENTS: readonly string[] = [
  '#e5484d',
  '#e93f7a',
  '#c62828',
  '#f4511e',
  '#e53935',
  '#29a3e0',
  '#c2185b',
  '#b71c1c',
  '#f2f2f2',
  '#1b1b1b',
  '#7b2d5e',
  '#6b5a5a',
];

/** 一枚主色派生出来的五枚 CSS 变量值。 */
export interface AccentTokens {
  primary: string;
  hover: string;
  weak: string;
  deep: string;
  onPrimary: string;
}

type Rgb = readonly [number, number, number];

/** `#rgb` / `#rrggbb` → `[r, g, b]`；认不出来返回 `null`（调用方照实退回默认色）。 */
export function parseHexColor(value: string): Rgb | null {
  const text = value.trim().replace(/^#/, '');
  const full =
    text.length === 3
      ? text
          .split('')
          .map((char) => char + char)
          .join('')
      : text;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** 线性混合：`weight` = 0 全取 `a`、1 全取 `b`。 */
function mix(a: Rgb, b: Rgb, weight: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * weight,
    a[1] + (b[1] - a[1]) * weight,
    a[2] + (b[2] - a[2]) * weight,
  ];
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
/** 主色底上改用近黑字（不用纯黑：纯黑压在有色彩的主色上会脏）。 */
const NEAR_BLACK = '#14171c';

/**
 * WCAG 的相对亮度（0 = 黑、1 = 白）。sRGB 先做 gamma 反变换再加权，
 * 不能用简单的 `(r+g+b)/3`——那样对绿色通道严重高估。
 */
export function relativeLuminance(rgb: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** 主色底上该用白字还是近黑字：亮度 ≥ 0.55 用近黑，否则白（对比度优先）。 */
export function onPrimaryFor(rgb: Rgb): string {
  return relativeLuminance(rgb) >= 0.55 ? NEAR_BLACK : DEFAULT_ON_PRIMARY;
}

/**
 * 自定义色 → 五枚变量。
 *
 * - 亮档：`hover` 压深 12%、`deep` 压深 30%（小字号正文色，越深越清楚）；
 * - 暗档：方向反过来（暗底上「更清楚」= 更亮），`hover` 提亮 16%、`deep` 提亮 28%——
 *   这与仓库里那套暗档 token 的取法一致（`--pi-primary-deep: #8ccbff` 比
 *   `--pi-primary: #5ab6ff` 更亮）；
 * - `weak`：同色淡底，亮档 12% / 暗档 20% 不透明度，给选中态当底；
 * - `onPrimary`：由亮度决定（见 `onPrimaryFor`）。
 *
 * 颜色认不出来（用户手输了一半）时整组退回默认天蓝那套，绝不写进一堆 `NaN`。
 */
export function customAccentTokens(color: string, dark: boolean): AccentTokens {
  const rgb = parseHexColor(color) ?? (parseHexColor(DEFAULT_ACCENT_COLOR) as Rgb);
  const [r, g, b] = rgb;
  return {
    primary: toHex(rgb),
    hover: toHex(dark ? mix(rgb, WHITE, 0.16) : mix(rgb, BLACK, 0.12)),
    weak: `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${dark ? 0.2 : 0.12})`,
    deep: toHex(dark ? mix(rgb, WHITE, 0.28) : mix(rgb, BLACK, 0.3)),
    onPrimary: onPrimaryFor(rgb),
  };
}
