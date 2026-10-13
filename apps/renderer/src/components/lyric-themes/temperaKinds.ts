/**
 * 凝彩 = `tempera`（folia-major 的 `src/components/visualizer/tempera/`）的**构图目录**。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**。这里登记的是它的**枚举契约**（构图 id 与族划分）——
 * 与 `LyricTheme` 登记 folia 的主题目录名同一性质：不复刻这些 id，就没有办法与它的
 * `temperaShotProfiles.ts` / `compositions/*` 逐条对照，也就谈不上「按观感逼近」。
 * 枚举名与族划分取自 folia 的 `tempera/types.ts`（`TEMPERA_SHOT_KINDS` 与各族的注释），
 * **实现代码一个字都没有拷贝**，绘制逻辑将来由我们自己写。
 *
 * === 这份清单为什么值得单独一个文件 ===
 * folia 的凝彩一共 **121 种构图、13 族**；程序编译层（哪一段用哪种构图）与绘制层
 * （每种构图长什么样）都按这个顺序索引。它同时是**分批交付的进度表**：
 * 每批补几族，清单上少哪几族一目了然。族名与 folia 的文件一一对应（见每族注释里的文件名）。
 */

/** 十三个构图族（顺序即 folia 注释里的叙述顺序）。 */
export const TEMPERA_SHOT_FAMILIES = [
  'split',
  'band',
  'frame',
  'poster',
  'sparse',
  'cinema',
  'charm',
  'aperture',
  'signal',
  'corridor',
  'monolith',
  'terrain',
  'monogatari',
] as const;

export type TemperaShotFamily = (typeof TEMPERA_SHOT_FAMILIES)[number];

/**
 * 每族的构图 id（folia: `tempera/types.ts` 的 `TEMPERA_SHOT_KINDS`，按族分段抄录）。
 *
 * - `split` 分割与栅格：直边把画面切开（`temperaSplitCompositions.ts`）
 * - `band` 色带：横向色带与渐变墙（`temperaBandCompositions.ts`）
 * - `frame` 框窗：画面里再开一个框（`temperaFrameCompositions.ts`）
 * - `poster` 海报与形状：斜切、菱形、箭头这类大形状（`temperaPosterCompositions.ts`）
 * - `sparse` 稀疏场：点阵、细线、留白（`temperaSparseCompositions.ts`）
 * - `cinema` 遮幅：把某个**真实像素比例**的窗口从整块画面上挖出来（`temperaCinemaCompositions.ts`）
 * - `charm` 圆滑族：底面整块平涂，曲线压在它上面（`temperaCharmCompositions.ts`）
 * - `aperture` 镂空铁板：一张平涂板 + 一个洞，洞的形状就是构图（`temperaApertureCompositions.ts`）
 * - `signal` 几何仪表盘：规整装饰围着一个重心块（`temperaSignalCompositions.ts`）
 * - `corridor` 沿 flow 的通道：为交接而生，开口两端伸出画外（`temperaCorridorCompositions.ts`）
 * - `monolith` 巨构：大到画框装不下的哑光体量（`temperaMonolithCompositions.ts`）
 * - `terrain` 结构与地形：山脊、裂隙、阶梯井（`temperaTerrainCompositions.ts`）
 * - `monogatari` 物语系过场卡：整屏单色平涂 + 大字（`temperaMonogatariCompositions.ts`）
 */
export const TEMPERA_SHOT_KINDS_BY_FAMILY = {
  // Splits and grids（13）
  split: [
    'duo-split',
    'quad-split',
    'tri-column',
    'thirds-stack',
    'checker-quad',
    'corner-wedge',
    'diagonal-halves',
    'cross-axis',
    'offset-halves',
    'stair-blocks',
    'pillar-gap',
    'corner-quad',
    'sliver-stack',
  ],
  // Bands（9）
  band: [
    'band-strip',
    'horizon-band',
    'deep-dive',
    'tone-ramp',
    'double-band',
    'tilt-band',
    'edge-rails',
    'gradient-wall',
    'terrace',
  ],
  // Frames and windows（10）
  frame: [
    'frame-window',
    'double-frame',
    'circle-window',
    'ladder-frame',
    'corner-brackets',
    'inset-box',
    'bracket-pair',
    'arch-window',
    'grid-cells',
    'keyhole',
  ],
  // Posters and shapes（10）
  poster: [
    'poster-panel',
    'diamond-stack',
    'slash-poster',
    'arrow-wedge',
    'edge-bleed',
    'triangle-mass',
    'ribbon-cross',
    'half-disc',
    'stacked-slabs',
    'wedge-pair',
  ],
  // Sparse fields（8）
  sparse: [
    'quiet-line',
    'starfield-dots',
    'ripple-lines',
    'hair-grid',
    'margin-rule',
    'dot-drift',
    'arc-sweep',
    'blank-page',
  ],
  // Cinema mattes（7）
  cinema: [
    'cinema-scope',
    'cinema-wide',
    'cinema-academy',
    'cinema-square',
    'cinema-portrait',
    'cinema-tall',
    'cinema-twin',
  ],
  // Rounded shapes laid on a flat field（9）
  charm: [
    'bubble-drift',
    'cloud-window',
    'heart-burst',
    'sparkle-field',
    'petal-arc',
    'scallop-band',
    'ribbon-loop',
    'round-plate',
    'halo-burst',
  ],
  // Punched plates（10）
  aperture: [
    'iris-hole',
    'slot-rail',
    'punch-row',
    'film-gate',
    'cross-vent',
    'louvre-slats',
    'ring-eye',
    'notch-stack',
    'wedge-gap',
    'dot-sieve',
  ],
  // Instrument panels（10）
  signal: [
    'sight-mark',
    'dial-scale',
    'chevron-run',
    'tally-column',
    'grid-focus',
    'axis-caps',
    'strobe-slats',
    'offset-plate',
    'radial-comb',
    'bracket-target',
  ],
  // Corridors（10）
  corridor: [
    'flow-channel',
    'twin-channel',
    'reed-run',
    'taper-channel',
    'chain-ports',
    'dash-channel',
    'window-run',
    'bridge-span',
    'braid-channel',
    'port-ladder',
  ],
  // Brutalist monoliths（10）
  monolith: [
    'apex-mass',
    'ziggurat',
    'slab-wall',
    'cantilever',
    'pylon-pair',
    'bunker-slit',
    'plinth-stack',
    'buttress-run',
    'void-core',
    'shear-block',
  ],
  // Terrain（10）
  terrain: [
    'ridge-line',
    'chasm',
    'overhang',
    'step-well',
    'pier-row',
    'revetment',
    'tower-crop',
    'lintel',
    'rubble-fan',
    'gnomon',
  ],
  // Monogatari interstitials（5）
  monogatari: [
    'monogatari-card',
    'monogatari-rule',
    'monogatari-edge',
    'monogatari-stack',
    'monogatari-flash',
  ],
} as const satisfies Record<TemperaShotFamily, readonly string[]>;

/** 全部构图 id（folia 的 `TEMPERA_SHOT_KINDS`，共 121 条）。 */
export type TemperaShotKind = (typeof TEMPERA_SHOT_KINDS_BY_FAMILY)[TemperaShotFamily][number];

/** 扁平清单，顺序与 folia 一致（族内保持原顺序，族间按 `TEMPERA_SHOT_FAMILIES`）。 */
export const TEMPERA_SHOT_KINDS: readonly TemperaShotKind[] = TEMPERA_SHOT_FAMILIES.flatMap(
  (family) => TEMPERA_SHOT_KINDS_BY_FAMILY[family],
);

/** 构图 id → 它属于哪一族（绘制层按下发到对应的族实现）。 */
export const TEMPERA_SHOT_FAMILY_OF: Readonly<Record<TemperaShotKind, TemperaShotFamily>> =
  Object.fromEntries(
    TEMPERA_SHOT_FAMILIES.flatMap((family) =>
      TEMPERA_SHOT_KINDS_BY_FAMILY[family].map((kind) => [kind, family] as const),
    ),
  ) as Readonly<Record<TemperaShotKind, TemperaShotFamily>>;

/**
 * 段落转场（folia: `TEMPERA_TRANSITION_KINDS`）。
 *
 * 三种都由大图形或镜头带领，**没有一种是溶解或硬切**：溶解读作剪辑，而凝彩的构图之间
 * 应该是「交接」。`block-wipe` 的色块按 0..2 连续行程扫过，1 为满覆盖，场景在满覆盖瞬间切换。
 */
export const TEMPERA_TRANSITION_KINDS = ['block-wipe', 'camera-pan', 'shape-carry'] as const;
export type TemperaTransitionKind = (typeof TEMPERA_TRANSITION_KINDS)[number];

/**
 * 段落的情绪档（folia: `temperaShotProfiles.ts` 的 mood）。
 *
 * 决定换气段只取安静构图、副歌不取安静构图 —— 也就是构图的选择不是纯随机，
 * 它跟着段落类型（`breath` / `verse` / `lift` / `chorus` / `break` / `outro`）走。
 */
export const TEMPERA_MOODS = ['quiet', 'neutral', 'loud'] as const;
export type TemperaMood = (typeof TEMPERA_MOODS)[number];

/** 段落类型（folia: `TemperaParagraphKind`）。 */
export const TEMPERA_PARAGRAPH_KINDS = [
  'breath',
  'verse',
  'lift',
  'chorus',
  'break',
  'outro',
] as const;
export type TemperaParagraphKind = (typeof TEMPERA_PARAGRAPH_KINDS)[number];

/** 段落边界（folia: `TemperaParagraphBoundary`）——决定一段为什么在这里断。 */
export const TEMPERA_PARAGRAPH_BOUNDARIES = [
  'song-start',
  'time-gap',
  'metadata',
  'duration-cap',
  'line-cap',
] as const;
export type TemperaParagraphBoundary = (typeof TEMPERA_PARAGRAPH_BOUNDARIES)[number];

/** 贯穿装饰的母题（folia: `TEMPERA_DECOR_MOTIFS`）。 */
export const TEMPERA_DECOR_MOTIFS = [
  'diamonds',
  'hatch-twin',
  'band-cross',
  'poster-diamond',
  'doodle',
] as const;
export type TemperaDecorMotif = (typeof TEMPERA_DECOR_MOTIFS)[number];
