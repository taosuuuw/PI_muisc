/**
 * 商籁的**外层元数据**（照抄 folia `sonnet/sonnetSceneBuilder.ts:128~169`，AGPL-3.0）。
 *
 * 上游原文（`SOURCE`，逐字）：
 * · `nameText`：文本 **`` `[ THEME ] ${theme.name.toUpperCase()}` ``**、`fontSize 14`、
 *   `fill: theme.primaryColor`、`letterSpacing 4`、**`alpha 0.2`**、**`rotation = −π/2`**、
 *   `position.set(20, height − 20)`、`anchor.set(0, 1)` ⇒ **左下角一条竖排的"主题标签"** ✓；
 * · `descText`：文本 `theme.description`、`fontSize 12`、`fill: theme.secondaryColor`、
 *   `wordWrap: true` + `wordWrapWidth: width × 0.3`、**`alpha 0.3`**、
 *   `position.set(width − 20, 20)`、`anchor.set(1, 0)` ⇒ **右上角一个右对齐、最多占 30% 宽的说明块** ✓；
 * · 两者都**挂在 `sceneBackgroundLayer`**（歌词文字之下 ✓），
 *   且都要过两道门槛：**`showOnlyText` 为假** 且 **`outerFrameMode === 'full'`** ✓。
 *
 * 本文件只出**纯数据**（文字与全部版面参数）＋"该不该显示"，不碰 DOM/Pixi ✓。
 *
 * === 与 folia 的差异（照实记）===
 * · 上游把这两块**画进 Pixi 场景**；我方商籁的歌词是 **DOM** 渲染的
 *   ⇒ 我们**用 DOM 落**（竖排用 `writing-mode: vertical-rl` 或 `rotate(-90deg)` ✓，
 *   右上块用 `max-width: 30%` ✓）—— 视觉参数照抄、载体不同 ✓（登记在 `CREDITS.md` ✓）；
 * · 上游文本来自 `theme.name` / `theme.description`（**主题名与主题说明**，不是歌名/歌手 ✓），
 *   我方对应取我们自己的主题名与主题说明 ✓（**文字内容是我们的，排版是照抄的** ✓）。
 */

/** 左下角与右上角的边距（上游两处都是 20）✓。 */
export const SONNET_OUTER_MARGIN = 20;

export const SONNET_OUTER_LABEL_FONT_SIZE = 14;
export const SONNET_OUTER_LABEL_LETTER_SPACING = 4;
export const SONNET_OUTER_LABEL_ALPHA = 0.2;
/** 上游 `rotation = −Math.PI / 2` ⇒ 竖排（从下往上读）✓。 */
export const SONNET_OUTER_LABEL_ROTATION = -Math.PI / 2;
export const SONNET_OUTER_LABEL_PREFIX = '[ THEME ] ';

export const SONNET_OUTER_NOTE_FONT_SIZE = 12;
export const SONNET_OUTER_NOTE_ALPHA = 0.3;
/** 说明块最大占宽比例（上游 `wordWrapWidth: width * 0.3`）✓。 */
export const SONNET_OUTER_NOTE_MAX_WIDTH_RATIO = 0.3;

export type SonnetOuterFrameMode = 'none' | 'frame' | 'full';

export interface SonnetOuterMetadataInput {
  readonly themeName: string | null;
  readonly themeDescription: string | null;
  readonly width: number;
  readonly height: number;
  /** 上游 `manualFontWeight`：`null` 时标签用 `bold`、说明块**不指定** ✓。 */
  readonly manualFontWeight: number | null;
  readonly outerFrameMode: SonnetOuterFrameMode;
  readonly showOnlyText: boolean;
}

/** 左下角的竖排"主题标签"✓。 */
export interface SonnetOuterMetadataLabel {
  readonly text: string;
  readonly fontSize: number;
  /** 颜色取主题的 `primary` ✓。 */
  readonly colorKey: 'primary';
  readonly letterSpacing: number;
  readonly alpha: number;
  /** 弧度（`−π/2`）✓。 */
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
  /** 锚点语义（`0, 1` = 左下 ✓）——DOM 落地时对应 `transform-origin` 的选择 ✓。 */
  readonly anchorX: number;
  readonly anchorY: number;
  readonly fontWeight: string;
}

/** 右上角的说明块 ✓。 */
export interface SonnetOuterMetadataNote {
  readonly text: string;
  readonly fontSize: number;
  /** 颜色取主题的 `secondary` ✓。 */
  readonly colorKey: 'secondary';
  readonly maxWidth: number;
  readonly alpha: number;
  readonly x: number;
  readonly y: number;
  /** 锚点语义（`1, 0` = 右上 ✓）。 */
  readonly anchorX: number;
  readonly anchorY: number;
  readonly fontWeight: string | null;
}

export interface SonnetOuterMetadata {
  readonly label: SonnetOuterMetadataLabel | null;
  readonly note: SonnetOuterMetadataNote | null;
}

const hasText = (value: string | null): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** 该不该显示外层元数据（上游：`!showOnlyText && outerFrameMode === 'full'`）✓。 */
export function shouldShowSonnetOuterMetadata(input: {
  readonly outerFrameMode: SonnetOuterFrameMode;
  readonly showOnlyText: boolean;
}): boolean {
  return !input.showOnlyText && input.outerFrameMode === 'full';
}

/** 上游的字重规则：`manualFontWeight === null ? fallback : String(manualFontWeight)` ✓。 */
function resolveFontWeight(manualFontWeight: number | null, fallback: string | null): string | null {
  if (manualFontWeight === null) return fallback;
  return String(manualFontWeight);
}

/**
 * 出两条元数据的全部参数 ✓。
 * 任一门槛不过（`showOnlyText` / 非 `full`）⇒ 两条都是 `null` ✓；
 * 各自的**文本为空**也各自为 `null` ✓（上游是两段独立的 `if` ✓）。
 */
export function resolveSonnetOuterMetadata(input: SonnetOuterMetadataInput): SonnetOuterMetadata {
  if (!shouldShowSonnetOuterMetadata(input)) return { label: null, note: null };

  const label = hasText(input.themeName)
    ? {
        text: `${SONNET_OUTER_LABEL_PREFIX}${input.themeName.toUpperCase()}`,
        fontSize: SONNET_OUTER_LABEL_FONT_SIZE,
        colorKey: 'primary' as const,
        letterSpacing: SONNET_OUTER_LABEL_LETTER_SPACING,
        alpha: SONNET_OUTER_LABEL_ALPHA,
        rotation: SONNET_OUTER_LABEL_ROTATION,
        x: SONNET_OUTER_MARGIN,
        y: input.height - SONNET_OUTER_MARGIN,
        anchorX: 0,
        anchorY: 1,
        fontWeight: resolveFontWeight(input.manualFontWeight, 'bold') ?? 'bold',
      }
    : null;

  const note = hasText(input.themeDescription)
    ? {
        text: input.themeDescription,
        fontSize: SONNET_OUTER_NOTE_FONT_SIZE,
        colorKey: 'secondary' as const,
        maxWidth: input.width * SONNET_OUTER_NOTE_MAX_WIDTH_RATIO,
        alpha: SONNET_OUTER_NOTE_ALPHA,
        x: input.width - SONNET_OUTER_MARGIN,
        y: SONNET_OUTER_MARGIN,
        anchorX: 1,
        anchorY: 0,
        fontWeight: resolveFontWeight(input.manualFontWeight, null),
      }
    : null;

  return { label, note };
}
