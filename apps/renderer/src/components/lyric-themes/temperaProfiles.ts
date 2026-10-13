/**
 * 凝彩 = `tempera`（folia-major 的 `src/components/visualizer/tempera/temperaShotProfiles.ts`）的
 * **每条构图的数值表**。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**。这份文件里**只有数值**（排版区域、入场向量、镜头行程与变焦、情绪档），
 * 是从它的同名数据表逐条提取并重新排版成元组的；**没有拷贝它的任何表达式、函数或注释文本**。
 * 数值正是「按观感逼近」要借鉴的东西（与我们复刻 fume / partita 等主题时抄数值是同一口径），
 * 逐条出处见 docs/CREDITS.md §1「借鉴十一」。
 *
 * 字段含义（与 folia 一一对应）：
 * - `region`: `[cx, cy, w, h]`，都是**视口比例**；歌词块的中心与宽高。
 * - `align` / `rotation` / `fontScale`: 排版对齐、整块旋转（弧度）、字号倍率；缺省 `center / 0 / 1`。
 * - `enter`: `[x, y]`，字素入场向量，单位是**字号倍数**（排版算好的位移距离，不按各样式单独缩放）。
 * - `camera`: `[travel, zoomStart, zoomEnd]`，镜头沿本 shot 的 flow 角走多远、以及起止变焦。
 * - `mood`: `quiet / neutral / loud`，换气段只取 quiet、副歌不取 quiet。
 * - `sharedDecor`: 是否叠加共用的贯穿线与装饰母题（物语系过场卡是 `false`，它要的就是一张干净的白纸）。
 *
 * 这份表由 `.folia-ref/gen-tempera-profiles.mjs` 提取（该脚本与上游源码都不入库），
 * 生成后再由 `temperaProfiles.test.ts` 钉住：121 条、与 `TEMPERA_SHOT_KINDS` 一一对应、取值在合理区间。
 */

import type { TemperaMood, TemperaShotKind } from './temperaKinds';

/** 单条构图的数值。 */
export interface TemperaShotProfile {
  /** `[cx, cy, w, h]`，视口比例。 */
  readonly region: readonly [number, number, number, number];
  readonly align?: 'center' | 'left' | 'right';
  /** 整块旋转（弧度）。 */
  readonly rotation?: number;
  /** 字号倍率。 */
  readonly fontScale?: number;
  /** 字素入场向量（字号倍数）。 */
  readonly enter: readonly [number, number];
  /** `[travel, zoomStart, zoomEnd]`。 */
  readonly camera: readonly [number, number, number];
  readonly mood: TemperaMood;
  /** 是否叠加共用装饰（物语系过场卡为 `false`）。 */
  readonly sharedDecor?: boolean;
}

/** 121 条构图数值，键与 folia 的 `TEMPERA_SHOT_PROFILES` 一一对应。 */
export const TEMPERA_SHOT_PROFILES: Readonly<Record<TemperaShotKind, TemperaShotProfile>> = {
  'duo-split': { region: [0.5, 0.52, 0.86, 0.46], enter: [0, 1.3], camera: [0.11, 1.06, 1.13], mood: 'neutral' },
  'quad-split': { region: [0.5, 0.5, 0.82, 0.4], enter: [0.9, 0.9], camera: [0.09, 1.08, 1.16], mood: 'loud' },
  'tri-column': { region: [0.5, 0.5, 0.7, 0.5], fontScale: 0.95, enter: [-1.2, 0], camera: [0.12, 1.04, 1.12], mood: 'neutral' },
  'thirds-stack': { region: [0.5, 0.5, 0.8, 0.28], enter: [0, 1.1], camera: [0.13, 1.03, 1.11], mood: 'neutral' },
  'checker-quad': { region: [0.5, 0.5, 0.76, 0.36], enter: [0.8, -0.8], camera: [0.1, 1.1, 1.02], mood: 'loud' },
  'corner-wedge': { region: [0.44, 0.56, 0.68, 0.4], align: 'left', rotation: -0.03, enter: [-1.4, 0.5], camera: [0.1, 1.05, 1.14], mood: 'loud' },
  'diagonal-halves': { region: [0.5, 0.5, 0.78, 0.4], rotation: -0.075, enter: [1.1, 1.1], camera: [0.12, 1.06, 1.14], mood: 'neutral' },
  'cross-axis': { region: [0.5, 0.5, 0.66, 0.3], enter: [0, 1.2], camera: [0.08, 1.12, 1.03], mood: 'loud' },
  'offset-halves': { region: [0.5, 0.5, 0.8, 0.4], enter: [0.9, 0.6], camera: [0.11, 1.05, 1.13], mood: 'neutral' },
  'stair-blocks': { region: [0.5, 0.5, 0.72, 0.38], rotation: -0.03, enter: [-1, 0.8], camera: [0.12, 1.06, 1.14], mood: 'loud' },
  'pillar-gap': { region: [0.5, 0.5, 0.34, 0.62], fontScale: 0.8, enter: [0, 1.2], camera: [0.07, 1.1, 1.02], mood: 'loud' },
  'corner-quad': { region: [0.46, 0.46, 0.68, 0.36], enter: [-0.9, -0.9], camera: [0.1, 1.07, 1.15], mood: 'neutral' },
  'sliver-stack': { region: [0.5, 0.5, 0.76, 0.3], enter: [1.2, 0], camera: [0.13, 1.04, 1.12], mood: 'neutral' },
  'band-strip': { region: [0.5, 0.52, 0.78, 0.26], fontScale: 0.92, enter: [0.5, 1.05], camera: [0.12, 1.03, 1.1], mood: 'neutral' },
  'horizon-band': { region: [0.5, 0.36, 0.8, 0.3], enter: [0, -1.1], camera: [0.14, 1.02, 1.1], mood: 'neutral' },
  'deep-dive': { region: [0.5, 0.58, 0.76, 0.34], enter: [0, 1.6], camera: [0.16, 1.04, 1.14], mood: 'neutral' },
  'tone-ramp': { region: [0.5, 0.5, 0.82, 0.38], enter: [1.2, 0.4], camera: [0.11, 1.05, 1.12], mood: 'neutral' },
  'double-band': { region: [0.5, 0.5, 0.78, 0.22], fontScale: 0.88, enter: [0.8, 0], camera: [0.12, 1.03, 1.11], mood: 'neutral' },
  'tilt-band': { region: [0.5, 0.5, 0.8, 0.26], rotation: -0.1, enter: [-1.1, 0.5], camera: [0.13, 1.05, 1.13], mood: 'neutral' },
  'edge-rails': { region: [0.5, 0.5, 0.74, 0.4], enter: [0, 1], camera: [0.09, 1.02, 1.09], mood: 'quiet' },
  'gradient-wall': { region: [0.5, 0.44, 0.82, 0.36], enter: [0.5, -0.9], camera: [0.15, 1.04, 1.13], mood: 'neutral' },
  'terrace': { region: [0.46, 0.52, 0.72, 0.34], align: 'left', enter: [-1.2, 0.4], camera: [0.14, 1.05, 1.12], mood: 'neutral' },
  'frame-window': { region: [0.5, 0.5, 0.64, 0.5], fontScale: 0.95, enter: [0, 0.95], camera: [0.05, 1.14, 1.03], mood: 'neutral' },
  'double-frame': { region: [0.5, 0.5, 0.58, 0.4], fontScale: 0.9, enter: [0.6, 0.6], camera: [0.06, 1.12, 1.02], mood: 'neutral' },
  'circle-window': { region: [0.5, 0.5, 0.5, 0.34], fontScale: 0.88, enter: [0, 0.8], camera: [0.05, 1.16, 1.04], mood: 'quiet' },
  'ladder-frame': { region: [0.52, 0.5, 0.6, 0.4], align: 'left', fontScale: 0.9, enter: [-0.9, 0.6], camera: [0.07, 1.1, 1.02], mood: 'quiet' },
  'corner-brackets': { region: [0.5, 0.5, 0.56, 0.3], fontScale: 0.85, enter: [0, 0.6], camera: [0.04, 1.06, 1.01], mood: 'quiet' },
  'inset-box': { region: [0.5, 0.5, 0.6, 0.42], fontScale: 0.92, enter: [0, 0.8], camera: [0.06, 1.1, 1.02], mood: 'quiet' },
  'bracket-pair': { region: [0.5, 0.5, 0.54, 0.34], fontScale: 0.88, enter: [1, 0], camera: [0.05, 1.08, 1.01], mood: 'quiet' },
  'arch-window': { region: [0.5, 0.54, 0.5, 0.34], fontScale: 0.86, enter: [0, 0.9], camera: [0.06, 1.14, 1.03], mood: 'quiet' },
  'grid-cells': { region: [0.5, 0.5, 0.72, 0.22], fontScale: 0.8, enter: [0.7, 0.7], camera: [0.07, 1.06, 1.13], mood: 'neutral' },
  'keyhole': { region: [0.5, 0.6, 0.42, 0.3], fontScale: 0.78, enter: [0, 1], camera: [0.05, 1.12, 1.02], mood: 'quiet' },
  'poster-panel': { region: [0.4, 0.5, 0.58, 0.62], align: 'left', rotation: -0.045, enter: [-1.5, 0.35], camera: [0.08, 1.05, 1.12], mood: 'loud' },
  'diamond-stack': { region: [0.54, 0.5, 0.6, 0.42], align: 'right', rotation: 0.035, enter: [1.3, -0.5], camera: [0.09, 1.07, 1.15], mood: 'loud' },
  'slash-poster': { region: [0.46, 0.5, 0.66, 0.44], align: 'left', rotation: -0.09, enter: [-1.2, 1], camera: [0.11, 1.06, 1.14], mood: 'loud' },
  'arrow-wedge': { region: [0.5, 0.34, 0.72, 0.26], enter: [0, -1.2], camera: [0.13, 1.04, 1.13], mood: 'loud' },
  'edge-bleed': { region: [0.56, 0.5, 0.6, 0.44], align: 'left', enter: [1.4, 0.3], camera: [0.1, 1.05, 1.13], mood: 'neutral' },
  'triangle-mass': { region: [0.5, 0.42, 0.68, 0.3], enter: [0.8, -1], camera: [0.12, 1.05, 1.14], mood: 'loud' },
  'ribbon-cross': { region: [0.5, 0.5, 0.62, 0.3], rotation: 0.05, enter: [-1, -0.8], camera: [0.11, 1.08, 1.16], mood: 'loud' },
  'half-disc': { region: [0.44, 0.44, 0.6, 0.34], align: 'left', enter: [-1.3, 0.4], camera: [0.1, 1.06, 1.14], mood: 'loud' },
  'stacked-slabs': { region: [0.52, 0.5, 0.62, 0.4], rotation: -0.05, enter: [1.1, 0.6], camera: [0.1, 1.07, 1.15], mood: 'loud' },
  'wedge-pair': { region: [0.5, 0.5, 0.44, 0.44], fontScale: 0.82, enter: [0, 1.1], camera: [0.09, 1.1, 1.02], mood: 'loud' },
  'quiet-line': { region: [0.5, 0.5, 0.6, 0.28], fontScale: 0.58, enter: [0, 0.7], camera: [0.03, 1, 1.04], mood: 'quiet' },
  'starfield-dots': { region: [0.5, 0.5, 0.62, 0.26], fontScale: 0.66, enter: [0.4, 0.5], camera: [0.04, 1.02, 1.08], mood: 'quiet' },
  'ripple-lines': { region: [0.5, 0.46, 0.66, 0.28], fontScale: 0.72, enter: [0, 0.9], camera: [0.06, 1.03, 1.1], mood: 'quiet' },
  'hair-grid': { region: [0.5, 0.5, 0.64, 0.26], fontScale: 0.62, enter: [0.4, 0.6], camera: [0.04, 1.01, 1.06], mood: 'quiet' },
  'margin-rule': { region: [0.54, 0.5, 0.62, 0.26], align: 'left', fontScale: 0.66, enter: [-0.8, 0.3], camera: [0.05, 1.02, 1.07], mood: 'quiet' },
  'dot-drift': { region: [0.5, 0.48, 0.6, 0.26], fontScale: 0.68, enter: [0.6, 0.6], camera: [0.05, 1.03, 1.09], mood: 'quiet' },
  'arc-sweep': { region: [0.5, 0.5, 0.6, 0.26], fontScale: 0.7, enter: [0, 0.8], camera: [0.06, 1.04, 1.1], mood: 'quiet' },
  'blank-page': { region: [0.5, 0.5, 0.56, 0.24], fontScale: 0.6, enter: [0, 0.5], camera: [0.03, 1, 1.03], mood: 'quiet' },
  'cinema-scope': { region: [0.5, 0.5, 0.74, 0.22], fontScale: 0.86, enter: [0.9, 0], camera: [0.09, 1.04, 1.11], mood: 'neutral' },
  'cinema-wide': { region: [0.5, 0.5, 0.7, 0.3], fontScale: 0.9, enter: [0, 0.9], camera: [0.08, 1.06, 1.13], mood: 'neutral' },
  'cinema-academy': { region: [0.5, 0.5, 0.5, 0.4], fontScale: 0.88, enter: [0, 0.8], camera: [0.06, 1.1, 1.02], mood: 'quiet' },
  'cinema-square': { region: [0.5, 0.5, 0.42, 0.4], fontScale: 0.84, enter: [0.7, 0.7], camera: [0.05, 1.12, 1.03], mood: 'quiet' },
  'cinema-portrait': { region: [0.5, 0.5, 0.32, 0.46], fontScale: 0.8, enter: [0, 1], camera: [0.06, 1.08, 1.16], mood: 'neutral' },
  'cinema-tall': { region: [0.5, 0.5, 0.24, 0.5], fontScale: 0.72, enter: [0.8, 0.4], camera: [0.07, 1.05, 1.14], mood: 'neutral' },
  'cinema-twin': { region: [0.33, 0.5, 0.3, 0.32], fontScale: 0.76, enter: [-0.9, 0.3], camera: [0.08, 1.06, 1.13], mood: 'neutral' },
  'bubble-drift': { region: [0.5, 0.5, 0.72, 0.36], fontScale: 0.92, enter: [0.5, 1], camera: [0.09, 1.05, 1.12], mood: 'neutral' },
  'cloud-window': { region: [0.5, 0.52, 0.46, 0.3], fontScale: 0.84, enter: [0, 0.8], camera: [0.05, 1.14, 1.03], mood: 'quiet' },
  'heart-burst': { region: [0.5, 0.52, 0.5, 0.3], fontScale: 0.95, enter: [0.8, 0.8], camera: [0.1, 1.08, 1.16], mood: 'loud' },
  'sparkle-field': { region: [0.5, 0.48, 0.64, 0.26], fontScale: 0.7, enter: [0.4, 0.6], camera: [0.04, 1.02, 1.08], mood: 'quiet' },
  'petal-arc': { region: [0.5, 0.6, 0.7, 0.3], fontScale: 0.9, enter: [0, 1.1], camera: [0.1, 1.04, 1.12], mood: 'neutral' },
  'scallop-band': { region: [0.5, 0.5, 0.76, 0.24], fontScale: 0.88, enter: [0.7, 0], camera: [0.12, 1.03, 1.1], mood: 'neutral' },
  'ribbon-loop': { region: [0.5, 0.5, 0.68, 0.22], rotation: 0.04, fontScale: 0.86, enter: [-1.1, 0.6], camera: [0.11, 1.07, 1.15], mood: 'loud' },
  'round-plate': { region: [0.5, 0.5, 0.56, 0.36], fontScale: 0.86, enter: [0, 0.7], camera: [0.05, 1.1, 1.02], mood: 'quiet' },
  'halo-burst': { region: [0.5, 0.5, 0.46, 0.3], fontScale: 0.95, enter: [0, 0.9], camera: [0.08, 1.12, 1.02], mood: 'loud' },
  'iris-hole': { region: [0.28, 0.68, 0.44, 0.28], fontScale: 0.78, enter: [-1, 0.6], camera: [0.09, 1.06, 1.14], mood: 'loud' },
  'slot-rail': { region: [0.5, 0.66, 0.72, 0.3], fontScale: 0.9, enter: [0.6, 0.9], camera: [0.12, 1.04, 1.11], mood: 'neutral' },
  'punch-row': { region: [0.5, 0.5, 0.76, 0.34], fontScale: 0.92, enter: [1.1, 0], camera: [0.13, 1.03, 1.1], mood: 'neutral' },
  'film-gate': { region: [0.5, 0.82, 0.66, 0.2], fontScale: 0.8, enter: [0, 1.1], camera: [0.08, 1.08, 1.02], mood: 'loud' },
  'cross-vent': { region: [0.5, 0.82, 0.66, 0.2], fontScale: 0.8, enter: [0, 1], camera: [0.07, 1.1, 1.02], mood: 'loud' },
  'louvre-slats': { region: [0.5, 0.8, 0.7, 0.22], fontScale: 0.82, enter: [0.8, 0.7], camera: [0.11, 1.05, 1.13], mood: 'neutral' },
  'ring-eye': { region: [0.5, 0.5, 0.26, 0.18], fontScale: 0.62, enter: [0, 0.7], camera: [0.05, 1.14, 1.03], mood: 'quiet' },
  'notch-stack': { region: [0.32, 0.5, 0.5, 0.34], fontScale: 0.84, enter: [-1.1, 0.5], camera: [0.1, 1.05, 1.13], mood: 'neutral' },
  'wedge-gap': { region: [0.5, 0.78, 0.7, 0.24], fontScale: 0.82, enter: [0, 1.2], camera: [0.12, 1.06, 1.14], mood: 'loud' },
  'dot-sieve': { region: [0.75, 0.5, 0.38, 0.3], fontScale: 0.78, enter: [0.9, 0.4], camera: [0.06, 1.03, 1.09], mood: 'quiet' },
  'sight-mark': { region: [0.5, 0.5, 0.46, 0.2], fontScale: 0.85, enter: [0, 0.8], camera: [0.06, 1.12, 1.02], mood: 'loud' },
  'dial-scale': { region: [0.5, 0.5, 0.36, 0.2], fontScale: 0.8, enter: [0.7, 0.5], camera: [0.05, 1.1, 1.02], mood: 'neutral' },
  'chevron-run': { region: [0.5, 0.52, 0.72, 0.3], fontScale: 0.9, enter: [0, -1.1], camera: [0.14, 1.04, 1.12], mood: 'neutral' },
  'tally-column': { region: [0.38, 0.5, 0.6, 0.32], align: 'left', fontScale: 0.76, enter: [-0.9, 0.3], camera: [0.05, 1.02, 1.08], mood: 'quiet' },
  'grid-focus': { region: [0.5, 0.5, 0.62, 0.22], fontScale: 0.85, enter: [0.8, 0.6], camera: [0.09, 1.05, 1.13], mood: 'neutral' },
  'axis-caps': { region: [0.5, 0.72, 0.66, 0.24], fontScale: 0.82, enter: [0, 1.2], camera: [0.13, 1.06, 1.15], mood: 'loud' },
  'strobe-slats': { region: [0.5, 0.5, 0.3, 0.36], fontScale: 0.8, enter: [1, 0], camera: [0.1, 1.08, 1.16], mood: 'loud' },
  'offset-plate': { region: [0.48, 0.62, 0.4, 0.2], fontScale: 0.85, enter: [-0.9, -0.6], camera: [0.09, 1.07, 1.15], mood: 'loud' },
  'radial-comb': { region: [0.42, 0.4, 0.62, 0.3], fontScale: 0.88, enter: [-1.2, -0.4], camera: [0.11, 1.05, 1.13], mood: 'neutral' },
  'bracket-target': { region: [0.5, 0.28, 0.66, 0.24], fontScale: 0.85, enter: [0, -0.9], camera: [0.06, 1.04, 1.1], mood: 'quiet' },
  'flow-channel': { region: [0.32, 0.5, 0.5, 0.3], fontScale: 0.85, enter: [-1, 0.5], camera: [0.13, 1.04, 1.12], mood: 'neutral' },
  'twin-channel': { region: [0.5, 0.5, 0.4, 0.3], fontScale: 0.85, enter: [0, 1.2], camera: [0.14, 1.03, 1.11], mood: 'neutral' },
  'reed-run': { region: [0.5, 0.5, 0.3, 0.3], fontScale: 0.72, enter: [0, 0.9], camera: [0.1, 1.02, 1.09], mood: 'quiet' },
  'taper-channel': { region: [0.28, 0.5, 0.42, 0.3], fontScale: 0.82, enter: [-1.1, 0.6], camera: [0.12, 1.05, 1.14], mood: 'neutral' },
  'chain-ports': { region: [0.32, 0.5, 0.5, 0.32], fontScale: 0.8, enter: [-0.8, 0.7], camera: [0.11, 1.03, 1.1], mood: 'quiet' },
  'dash-channel': { region: [0.3, 0.5, 0.46, 0.3], fontScale: 0.84, enter: [0, 1.3], camera: [0.15, 1.04, 1.13], mood: 'neutral' },
  'window-run': { region: [0.28, 0.5, 0.42, 0.3], fontScale: 0.82, enter: [0, 1.2], camera: [0.14, 1.04, 1.12], mood: 'neutral' },
  'bridge-span': { region: [0.5, 0.5, 0.72, 0.16], fontScale: 0.85, enter: [1.2, 0], camera: [0.12, 1.08, 1.16], mood: 'loud' },
  'braid-channel': { region: [0.5, 0.5, 0.34, 0.3], fontScale: 0.8, enter: [0, 1.1], camera: [0.13, 1.06, 1.15], mood: 'loud' },
  'port-ladder': { region: [0.3, 0.5, 0.46, 0.3], fontScale: 0.78, enter: [-0.9, 0.4], camera: [0.09, 1.02, 1.09], mood: 'quiet' },
  'apex-mass': { region: [0.5, 0.3, 0.62, 0.2], fontScale: 0.9, enter: [0, -1], camera: [0.12, 1.04, 1.13], mood: 'loud' },
  'ziggurat': { region: [0.5, 0.32, 0.5, 0.18], fontScale: 0.85, enter: [0, -0.9], camera: [0.1, 1.06, 1.15], mood: 'loud' },
  'slab-wall': { region: [0.36, 0.5, 0.5, 0.24], fontScale: 0.88, enter: [1.2, 0], camera: [0.11, 1.05, 1.12], mood: 'neutral' },
  'cantilever': { region: [0.42, 0.42, 0.6, 0.14], fontScale: 0.8, enter: [-1.3, 0], camera: [0.13, 1.04, 1.12], mood: 'loud' },
  'pylon-pair': { region: [0.5, 0.22, 0.7, 0.12], fontScale: 0.75, enter: [0, -0.8], camera: [0.09, 1.08, 1.02], mood: 'loud' },
  'bunker-slit': { region: [0.5, 0.48, 0.72, 0.2], fontScale: 0.86, enter: [0.9, 0.4], camera: [0.08, 1.06, 1.13], mood: 'neutral' },
  'plinth-stack': { region: [0.5, 0.32, 0.44, 0.16], fontScale: 0.82, enter: [0, -0.8], camera: [0.1, 1.05, 1.13], mood: 'neutral' },
  'buttress-run': { region: [0.5, 0.26, 0.7, 0.2], fontScale: 0.86, enter: [0.8, -0.8], camera: [0.12, 1.03, 1.11], mood: 'loud' },
  'void-core': { region: [0.5, 0.2, 0.66, 0.18], fontScale: 0.84, enter: [0, -1.1], camera: [0.11, 1.07, 1.15], mood: 'loud' },
  'shear-block': { region: [0.5, 0.5, 0.56, 0.2], fontScale: 0.88, enter: [1, 0.5], camera: [0.12, 1.06, 1.14], mood: 'neutral' },
  'ridge-line': { region: [0.5, 0.42, 0.72, 0.2], fontScale: 0.9, enter: [0, -1], camera: [0.14, 1.03, 1.12], mood: 'neutral' },
  'chasm': { region: [0.25, 0.5, 0.38, 0.24], fontScale: 0.82, enter: [-1.2, 0.4], camera: [0.1, 1.06, 1.14], mood: 'loud' },
  'overhang': { region: [0.44, 0.58, 0.6, 0.22], fontScale: 0.88, enter: [0, 1.1], camera: [0.11, 1.08, 1.02], mood: 'loud' },
  'step-well': { region: [0.5, 0.26, 0.66, 0.2], fontScale: 0.85, enter: [0, -0.9], camera: [0.09, 1.04, 1.12], mood: 'neutral' },
  'pier-row': { region: [0.5, 0.4, 0.76, 0.14], fontScale: 0.82, enter: [1.1, 0], camera: [0.13, 1.03, 1.1], mood: 'neutral' },
  'revetment': { region: [0.46, 0.3, 0.6, 0.2], fontScale: 0.86, enter: [-1, -0.6], camera: [0.12, 1.05, 1.13], mood: 'neutral' },
  'tower-crop': { region: [0.28, 0.5, 0.44, 0.24], align: 'left', fontScale: 0.74, enter: [-0.8, 0.3], camera: [0.06, 1.02, 1.09], mood: 'quiet' },
  'lintel': { region: [0.5, 0.5, 0.76, 0.16], fontScale: 0.9, enter: [-1.1, 0], camera: [0.1, 1.02, 1.08], mood: 'quiet' },
  'rubble-fan': { region: [0.56, 0.4, 0.5, 0.22], fontScale: 0.84, enter: [1.2, -0.5], camera: [0.13, 1.07, 1.16], mood: 'loud' },
  'gnomon': { region: [0.66, 0.34, 0.46, 0.2], fontScale: 0.78, enter: [0.9, -0.4], camera: [0.07, 1.03, 1.1], mood: 'quiet' },
  'monogatari-card': { region: [0.5, 0.5, 0.78, 0.5], fontScale: 1.15, enter: [0, 0.7], camera: [0.03, 1.02, 1.07], mood: 'quiet', sharedDecor: false },
  'monogatari-rule': { region: [0.5, 0.46, 0.76, 0.4], fontScale: 1.05, enter: [0.6, 0], camera: [0.04, 1.03, 1.09], mood: 'quiet', sharedDecor: false },
  'monogatari-edge': { region: [0.52, 0.5, 0.72, 0.46], align: 'left', fontScale: 1.05, enter: [-0.8, 0], camera: [0.05, 1.02, 1.08], mood: 'neutral', sharedDecor: false },
  'monogatari-stack': { region: [0.5, 0.5, 0.44, 0.62], enter: [0, 0.9], camera: [0.04, 1.05, 1.12], mood: 'quiet', sharedDecor: false },
  'monogatari-flash': { region: [0.5, 0.5, 0.82, 0.44], fontScale: 1.3, enter: [0, 0.5], camera: [0.02, 1.08, 1.01], mood: 'loud', sharedDecor: false },
};

/** 某个情绪档下可选的构图（folia: `resolveTemperaShotCandidates`）。 */
export function resolveTemperaShotCandidates(
  moods: readonly TemperaMood[],
): TemperaShotKind[] {
  const kinds = Object.keys(TEMPERA_SHOT_PROFILES) as TemperaShotKind[];
  return kinds.filter((kind) => moods.includes(TEMPERA_SHOT_PROFILES[kind].mood));
}

/** 取一条构图数值（缺键时不抛错，调用方按「没有这条构图」处理）。 */
export function resolveTemperaShotProfile(kind: TemperaShotKind): TemperaShotProfile {
  return TEMPERA_SHOT_PROFILES[kind];
}
