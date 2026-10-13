/**
 * 凝彩「墨色对比度保证」（照抄上游 `temperaPalette.ts:53~67` 的做法，第 244 轮）。
 *
 * 上游注释写明了**为什么必须有这一步**：
 * `theme.primaryColor` **不保证**和底色形成对比 —— 大量主题是"浅主色 + 浅底色"，
 * 结果是**歌词读不清**，而且**差异滤镜会拿到两个几乎同色的输入**（我们凝彩正好用了
 * `temperaDifferenceFilter`，所以这条不只是好看问题，是**滤镜正确性**问题）。
 *
 * 规则（数值与上游一致）：
 * 1. 两色相对亮度差 ≥ `96` ⇒ 原样返回；
 * 2. 否则把墨色推到**纸色的反端**：纸暗（L < 128）用近白 `#f4f4f2`，纸亮用近黑 `#141414`；
 * 3. 先按 **14%** 把主题墨色混进目标色（**保留一丝色相**，不至于变成纯灰）；
 * 4. 若混完仍不达标，**直接用纯目标色**（宁可牺牲色相，也要保证能读）。
 *
 * 我们此前**没有这一步**（`resolveTemperaTones` 只做混合）—— 本文件是补齐，不是重复实现。
 * **注意**：本函数尚未接进 `resolveTemperaTones` 的取值链路（接线属可见变化，需构建 + 冒烟 + 看图）。
 */

import { parseRgb } from './types';

/** 上游 `MIN_INK_CONTRAST`：纸墨相对亮度差的下限。 */
export const TEMPERA_MIN_INK_CONTRAST = 96;

/** 纸暗时把墨色推到的近白端（上游写 `#f4f4f2`；这里用 `rgb()` 形式，便于本项目自身解析）。 */
export const TEMPERA_INK_LIGHT = 'rgb(244, 244, 242)';

/** 纸亮时把墨色推到的近黑端（上游写 `#141414`）。 */
export const TEMPERA_INK_DARK = 'rgb(20, 20, 20)';

/** 保留色相时把主题墨色混进目标色的比例（上游 `mixColors(target, ink, 0.14)`）。 */
export const TEMPERA_INK_HUE_KEEP = 0.14;

interface Channels {
  r: number;
  g: number;
  b: number;
}

const channelsOf = (color: string): Channels | null => {
  const parsed = parseRgb(color);
  if (parsed === null) return null;
  const c = parsed as { r?: number; g?: number; b?: number };
  if (typeof c.r !== 'number' || typeof c.g !== 'number' || typeof c.b !== 'number') return null;
  return { r: c.r, g: c.g, b: c.b };
};

/** 相对亮度（Rec.709 权重，与上游 `luminanceOf` 同口径）。无法解析时按上游取 128（中性）。 */
export const temperaInkLuminance = (color: string): number => {
  const channels = channelsOf(color);
  if (channels === null) return 128;
  return channels.r * 0.2126 + channels.g * 0.7152 + channels.b * 0.0722;
};

const mixInto = (from: Channels, to: Channels, amount: number): string =>
  `rgb(${Math.round(from.r + (to.r - from.r) * amount)}, ` +
  `${Math.round(from.g + (to.g - from.g) * amount)}, ` +
  `${Math.round(from.b + (to.b - from.b) * amount)})`;

/**
 * 保证墨色与纸色的对比度；返回**可直接当墨色用**的颜色字符串。
 * 输入解析不了时**原样返回** `ink`（宁可不动，也不猜）。
 */
export const resolveTemperaInkContrast = (paper: string, ink: string): string => {
  const inkChannels = channelsOf(ink);
  if (inkChannels === null) return ink;

  const paperLuminance = temperaInkLuminance(paper);
  if (Math.abs(temperaInkLuminance(ink) - paperLuminance) >= TEMPERA_MIN_INK_CONTRAST) return ink;

  const targetColor = paperLuminance < 128 ? TEMPERA_INK_LIGHT : TEMPERA_INK_DARK;
  const target = channelsOf(targetColor);
  if (target === null) return targetColor;

  const tinted = mixInto(target, inkChannels, TEMPERA_INK_HUE_KEEP);
  return Math.abs(temperaInkLuminance(tinted) - paperLuminance) >= TEMPERA_MIN_INK_CONTRAST
    ? tinted
    : targetColor;
};

/** 拉回亮度后允许的误差（上游 `> 1.5` 即判为"对不上"）。 */
export const TEMPERA_LUMINANCE_MATCH_TOLERANCE = 1.5;

/**
 * 把**加了色相**的颜色按增益**拉回**某个"未着色档位"的亮度（照抄上游 `temperaPalette.ts:70~87`）。
 *
 * **为什么需要**：四档色阶是"按亮度排的阶梯"，若某一档因为掺了色相而亮度偏了，
 * **阶梯顺序就会被搅乱**（后面的档可能比前面亮）。所以上游的做法是：
 * 着色只改色相，**亮度用增益拉回来**；并且做**裁剪检测** —— 若拉回时某个通道被 255 夹住、
 * 导致对不上目标亮度（误差 > 1.5），那就**放弃着色、直接回退中性档**（宁可不鲜艳，也不许乱序）。
 *
 * 解析不了、或原色亮度 ≤ 0.5（拉不回来）时，同样**回退 `target`**。
 */
export const temperaMatchLuminance = (color: string, target: string): string => {
  const channels = channelsOf(color);
  const targetChannels = channelsOf(target);
  if (channels === null || targetChannels === null) return target;

  const current = temperaInkLuminance(color);
  const wanted = temperaInkLuminance(target);
  if (current <= 0.5) return target;

  const gain = wanted / current;
  const scaled = `rgb(${Math.round(Math.min(255, channels.r * gain))}, ` +
    `${Math.round(Math.min(255, channels.g * gain))}, ` +
    `${Math.round(Math.min(255, channels.b * gain))})`;

  return Math.abs(temperaInkLuminance(scaled) - wanted) > TEMPERA_LUMINANCE_MATCH_TOLERANCE
    ? target
    : scaled;
};

/** 可读性底线（上游 `enforceReadable` 里的 `88`）——**与墨色的 96 不是同一个数**，是两级阈值。 */
export const TEMPERA_READABLE_FLOOR = 88;

/** 每次推离的步长与最大步数（上游 `mixColors(color, away, step * 0.16)`，`step = 1..5`）。 */
export const TEMPERA_READABLE_PUSH_STEP = 0.16;
export const TEMPERA_READABLE_PUSH_MAX_STEPS = 5;

const TEMPERA_READABLE_WHITE = 'rgb(255, 255, 255)';
const TEMPERA_READABLE_BLACK = 'rgb(16, 16, 16)';

/**
 * 保证一个**封面来的颜色**在纸上读得清（照抄上游 `temperaPalette.ts:126~135`）。
 *
 * 与墨色那条规则的关键区别（上游注释原话）：**不把它拉到色阶上** ——
 * *"pulling it onto the ink ladder is what greys the background ramp out"*，
 * 那会把颜色**拉灰**；这里只**朝远离纸色的方向推**（纸暗推向 `#ffffff`、纸亮推向 `#101010`），
 * 步长 0.16、最多 5 步，返回第一个达标值；**5 步都不达标就用 0.8 那一步**
 * （上游 `:134` 的 `return mixColors(color, away, 0.8)` —— 注意**不是**原样返回）。
 *
 * 输入解析不了时**原样返回**（不猜）。
 */
export const resolveTemperaReadable = (paper: string, color: string): string => {
  const channels = channelsOf(color);
  if (channels === null) return color;

  const paperLuminance = temperaInkLuminance(paper);
  if (Math.abs(temperaInkLuminance(color) - paperLuminance) >= TEMPERA_READABLE_FLOOR) return color;

  const awayColor = paperLuminance < 128 ? TEMPERA_READABLE_WHITE : TEMPERA_READABLE_BLACK;
  const away = channelsOf(awayColor);
  if (away === null) return color;

  for (let step = 1; step <= TEMPERA_READABLE_PUSH_MAX_STEPS; step += 1) {
    const pushed = mixInto(channels, away, step * TEMPERA_READABLE_PUSH_STEP);
    if (Math.abs(temperaInkLuminance(pushed) - paperLuminance) >= TEMPERA_READABLE_FLOOR) return pushed;
  }
  return mixInto(channels, away, 0.8);
};

/**
 * 封面取色里要掺多少主题色（上游 `temperaPalette.ts:142` 的 `THEME_HUE_MIX = 0.32`）。
 *
 * 上游注释给了理由：**封面要占主导**（毕竟模式就是在取封面的样），
 * 但**纯封面取色会把主题彻底丢掉** —— 那样"用户选的调色板"在最显眼的地方反而不起作用。
 */
export const TEMPERA_THEME_HUE_MIX = 0.32;

/**
 * 把封面取到的颜色与主题色相混（照抄上游 `blendCoverWithTheme`，`:144~146`）：
 * **只取前 4 个封面色**，逐个与 `themeHues[index % themeHues.length]` 按 0.32 混合。
 *
 * 与上游的唯一差别（**刻意的、写在这里备查**）：`themeHues` 为空时**原样返回封面色**
 * （上游会走到 `mixColors(color, undefined, …)`；我们宁可显式早退，也不依赖"解析失败原样返回"的副作用）。
 */
export const resolveTemperaCoverThemeBlend = (
  cover: readonly string[],
  themeHues: readonly string[],
): string[] => {
  const top = cover.slice(0, 4);
  if (themeHues.length === 0) return [...top];
  return top.map((color, index) => {
    const from = channelsOf(color);
    // 严格索引访问下 `themeHues[i]` 的类型是 `string | undefined`，必须先取出再判空。
    const hue = themeHues[index % themeHues.length];
    if (from === null || hue === undefined) return color;
    const to = channelsOf(hue);
    if (to === null) return color;
    return mixInto(from, to, TEMPERA_THEME_HUE_MIX);
  });
};

/** 色阶四档的停靠点（上游 `TEMPERA_TONE_STOPS`）。 */
export const TEMPERA_TONE_STOPS = [0.12, 0.3, 0.52, 0.72] as const;

/** 掺色比例（上游 `buildToneLadder` 里 `mixColors(base, tint, 0.3)`）。 */
export const TEMPERA_TONE_TINT_MIX = 0.3;

/**
 * 建四档色阶（照抄上游 `temperaPalette.ts:91~102` 的 `buildToneLadder`）。
 *
 * **`duo` 档的关键**：四档不是纯中性阶梯 —— `tone1/tone3` 掺 `tintA`、`tone2` 掺 `tintB`、
 * **`tone4` 不掺**；掺完一律用 `matchLuminance` **拉回该档基础亮度**，
 * 所以"**加了色相但色阶顺序不乱**"（上游注释：*Hue tints only shift chroma*）。
 *
 * 上游 `duo` 档传的是 `(paper, ink, theme.accentColor, theme.secondaryColor)`（`:220`）。
 * **不传 tint 时就是纯中性阶梯** —— 这也正是我们此前的行为，所以本函数**向后兼容**。
 */
export const resolveTemperaToneLadder = (
  paper: string,
  ink: string,
  tintA?: string,
  tintB?: string,
): [string, string, string, string] => {
  const base = TEMPERA_TONE_STOPS.map((stop) => {
    const from = channelsOf(paper);
    const to = channelsOf(ink);
    if (from === null || to === null) return paper;
    return mixInto(from, to, stop);
  }) as [string, string, string, string];

  const tinted = (index: 0 | 1 | 2): string => {
    const tint = index === 1 ? tintB : tintA;
    if (tint === undefined) return base[index];
    const step = channelsOf(base[index]);
    const tintChannels = channelsOf(tint);
    if (step === null || tintChannels === null) return base[index];
    // 掺完拉回本档亮度（`matchLuminance` 的职责）。
    return temperaMatchLuminance(mixInto(step, tintChannels, TEMPERA_TONE_TINT_MIX), base[index]);
  };

  return [tinted(0), tinted(1), tinted(2), base[3]];
};
