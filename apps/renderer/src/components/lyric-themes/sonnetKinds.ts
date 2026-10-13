/**
 * 商籁（sonnet）的**契约层**：分镜种类、段落种类、段落边界、转场种类。
 *
 * === AGPL 说明 ===
 * folia-major 是 AGPL-3.0。这里只借鉴它的**枚举划分与命名**（哪些是段落、哪些是镜头、哪些是转场），
 * 代码与注释在本仓库重写。
 *
 * === 一个容易看错的点（照实记）===
 * 商籁仓库里有一堆 `sonnetShotMgArchitecture / Botanical / Celestial / Craft / Flora / Kinetic /
 * Landscape / Marine / Music / Themed / OpenFrame / Additional / Extended …` 文件，看着像十几个镜头族；
 * 其实**镜头种类总共只有 7 种**（下面这份清单），那些文件是往这 7 种里**补充内容**的变体源。
 * 所以商籁的构图层比凝彩（121 种）小得多，难点在排版、运镜、转场与后期那一层。
 */

/** 商籁的七种镜头。 */
export const SONNET_SHOT_KINDS = [
  'editorial-column',
  'type-impact',
  'fragment-collage',
  'tracking-ribbon',
  'mask-reveal',
  'poster-blocks',
  'quiet-tableau',
] as const;

export type SonnetShotKind = (typeof SONNET_SHOT_KINDS)[number];

/** 段落种类：决定这一段用哪几种镜头、以及排版的语气。 */
export const SONNET_PARAGRAPH_KINDS = [
  'breath',
  'verse',
  'lift',
  'chorus',
  'break',
  'outro',
] as const;

export type SonnetParagraphKind = (typeof SONNET_PARAGRAPH_KINDS)[number];

/** 段落**为什么**在这里断开 —— 是排版与转场的判断依据，不只是调试信息。 */
export const SONNET_PARAGRAPH_BOUNDARIES = [
  'song-start',
  'time-gap',
  'metadata',
  'duration-cap',
  'line-cap',
] as const;

export type SonnetParagraphBoundary = (typeof SONNET_PARAGRAPH_BOUNDARIES)[number];

/** 段落之间可以插的转场。 */
export const SONNET_TRANSITION_KINDS = ['fast-blur', 'mono-glitch', 'camera-pull'] as const;

export type SonnetTransitionKind = (typeof SONNET_TRANSITION_KINDS)[number];

/** 每种镜头的中文说法（设置页与诊断用，也方便对着 folia 核对）。 */
export const SONNET_SHOT_LABELS: Readonly<Record<SonnetShotKind, string>> = {
  'editorial-column': '社论栏',
  'type-impact': '重字冲击',
  'fragment-collage': '碎片拼贴',
  'tracking-ribbon': '跟拍丝带',
  'mask-reveal': '遮罩揭示',
  'poster-blocks': '海报方块',
  'quiet-tableau': '静场',
};
