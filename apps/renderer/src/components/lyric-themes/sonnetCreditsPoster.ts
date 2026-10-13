/**
 * 商籁**片尾海报的版式**（照抄 folia `sonnet/sonnetCredits.ts` 的 `buildSonnetCreditsPoster` 数值；
 * 文字与代码我们重写；AGPL-3.0）。
 *
 * ⚠ 差异（照实记）：上游**直接建 Pixi 容器**（`Text` / `Graphics` 一把画完）；
 * 我方沿用本项目习惯 —— **先出"绘制清单"纯数据** ✓，再由渲染层照单画 ✓
 * ⇒ 好处：版式**可被用例逐条核对** ✓（位置、字号、字距、行距、朝向全是数字 ✓），
 * 也便于将来做"看图 + 数字"双验收 ✓。
 *
 * 坐标系与上游一致：容器**以画面中心为原点** ✓（上游 `pivot/position = (w/2, h/2)` ✓，
 * 我们的 `world` 也是同样的约定 ✓）⇒ 这里输出的坐标**已经减掉半个画面** ✓。
 */

export interface SonnetCreditsRectDraw {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 颜色取自主题的哪一支 ✓。 */
  readonly tone: 'primary' | 'secondary' | 'accent';
  readonly alpha: number;
}

export interface SonnetCreditsLineDraw {
  readonly kind: 'line';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly tone: 'primary' | 'secondary' | 'accent';
  readonly width: number;
  readonly alpha: number;
}

export type SonnetCreditsDraw = SonnetCreditsRectDraw | SonnetCreditsLineDraw;

export interface SonnetCreditsTextDraw {
  readonly kind: 'artist' | 'title' | 'album';
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly tone: 'primary' | 'secondary' | 'accent';
  /** 字距（px，可为负 = 收紧 ✓）。 */
  readonly letterSpacing: number;
  /** 行距（px，可为负 ✓）。 */
  readonly leading: number;
  readonly wordWrapWidth: number;
  /** 是否允许断词（上游 title 打开 ✓）。 */
  readonly breakWords: boolean;
  /** 文字锚点：`left-top` 全部沿用上游的"左上角定位" ✓。 */
  readonly anchor: 'left-top';
}

export interface SonnetCreditsPosterInput {
  readonly width: number;
  readonly height: number;
  readonly lyricsFontScale: number;
  readonly metadata: {
    readonly title?: string | null;
    readonly artist?: string | null;
    readonly album?: string | null;
  };
  /** 字体栈（由渲染层提供 ✓）。 */
  readonly fontFamily: string;
  /** 字体权重（由渲染层按主题解析 ✓）—— 上游用的是 700 / 500 ✓。 */
  readonly titleWeight: number;
  readonly detailWeight: number;
}

export interface SonnetCreditsPoster {
  /** 几何四笔 ✓（全部**相对画面中心** ✓）。 */
  readonly draws: readonly SonnetCreditsDraw[];
  /** 文字（artist / title / album ✓，缺哪个不出哪个 ✓）。 */
  readonly texts: readonly SonnetCreditsTextDraw[];
  readonly fontFamily: string;
}

const normalize = (value?: string | null): string => value?.trim() ?? '';

/** 版式数值（照抄上游 ✓，具名便于用例引用 ✓）。 */
export const SONNET_CREDITS_LAYOUT = {
  leftInsetRatio: 0.105,
  rightInsetRatio: 0.09,
  minInset: 38,
  minContentWidth: 220,
  titleSizeRatio: 0.088,
  titleSizeMin: 42,
  titleSizeMax: 118,
  detailSizeRatio: 0.018,
  detailSizeMin: 13,
  detailSizeMax: 25,
  ruleWidthRatio: 0.075,
  ruleWidthMin: 42,
  ruleThickness: 5,
  ruleYRatio: 0.155,
  spineThickness: 2,
  spineHeightRatio: 0.57,
  spineXRatio: 0.155,
  blockWidth: 8,
  blockHeightRatio: 0.34,
  blockYRatio: 0.225,
  blockRightGap: 8,
  baseLineYRatio: 0.79,
  baseLineThickness: 1,
  artistYRatio: 0.205,
  artistXRatio: 20,
  artistWrapRatio: 0.72,
  artistSpacingRatio: 0.18,
  artistSpacingMin: 2,
  titleYRatio: 0.285,
  titleXRatio: 16,
  titleWrapRatio: 0.88,
  titleLeadingRatio: 0.08,
  titleLeadingMin: 2,
  titleSpacingRatio: 0.018,
  titleSpacingMin: 0.5,
  albumYRatio: 0.825,
  albumXRatio: 18,
  albumWrapRatio: 0.72,
  albumSpacingRatio: 0.1,
  albumSpacingMin: 1,
  albumSizeRatio: 0.92,
} as const;

/**
 * 出**海报的绘制清单** ✓。
 * 上游把容器 `pivot/position` 设成 `(w/2, h/2)` ✓ ⇒ 等价于"所有坐标先减半个画面" ✓。
 */
export function buildSonnetCreditsPoster(input: SonnetCreditsPosterInput): SonnetCreditsPoster {
  const { width, height, lyricsFontScale } = input;
  const L = SONNET_CREDITS_LAYOUT;
  const halfW = width / 2;
  const halfH = height / 2;
  const left = Math.max(L.minInset, width * L.leftInsetRatio);
  const right = Math.max(L.minInset, width * L.rightInsetRatio);
  const contentWidth = Math.max(L.minContentWidth, width - left - right);
  const titleSize = Math.max(
    L.titleSizeMin,
    Math.min(L.titleSizeMax, width * L.titleSizeRatio * lyricsFontScale),
  );
  const detailSize = Math.max(
    L.detailSizeMin,
    Math.min(L.detailSizeMax, width * L.detailSizeRatio * lyricsFontScale),
  );
  const title = normalize(input.metadata.title);
  const artist = normalize(input.metadata.artist);
  const album = normalize(input.metadata.album);

  const draws: SonnetCreditsDraw[] = [
    {
      kind: 'rect',
      x: left - halfW,
      y: height * L.ruleYRatio - halfH,
      width: Math.max(L.ruleWidthMin, width * L.ruleWidthRatio),
      height: L.ruleThickness,
      tone: 'accent',
      alpha: 0.95,
    },
    {
      kind: 'rect',
      x: left - halfW,
      y: height * L.ruleYRatio - halfH,
      width: L.spineThickness,
      height: height * L.spineHeightRatio,
      tone: 'primary',
      alpha: 0.22,
    },
    {
      kind: 'rect',
      x: width - right - L.blockRightGap - halfW,
      y: height * L.blockYRatio - halfH,
      width: L.blockWidth,
      height: height * L.blockHeightRatio,
      tone: 'secondary',
      alpha: 0.32,
    },
    {
      kind: 'line',
      x1: left - halfW,
      y1: height * L.baseLineYRatio - halfH,
      x2: width - right - halfW,
      y2: height * L.baseLineYRatio - halfH,
      tone: 'primary',
      width: L.baseLineThickness,
      alpha: 0.36,
    },
  ];

  const texts: SonnetCreditsTextDraw[] = [];
  if (artist !== '') {
    texts.push({
      kind: 'artist',
      text: artist.toLocaleUpperCase(),
      x: left + L.artistXRatio - halfW,
      y: height * L.artistYRatio - halfH,
      fontSize: detailSize,
      fontWeight: input.detailWeight,
      tone: 'accent',
      letterSpacing: Math.max(L.artistSpacingMin, detailSize * L.artistSpacingRatio),
      leading: 0,
      wordWrapWidth: contentWidth * L.artistWrapRatio,
      breakWords: false,
      anchor: 'left-top',
    });
  }
  if (title !== '') {
    texts.push({
      kind: 'title',
      text: title,
      x: left + L.titleXRatio - halfW,
      y: height * L.titleYRatio - halfH,
      fontSize: titleSize,
      fontWeight: input.titleWeight,
      tone: 'primary',
      // 上游 title 是**负行距 + 负字距**（大标题收紧 ✓）。
      leading: -Math.max(L.titleLeadingMin, titleSize * L.titleLeadingRatio),
      letterSpacing: -Math.max(L.titleSpacingMin, titleSize * L.titleSpacingRatio),
      wordWrapWidth: contentWidth * L.titleWrapRatio,
      breakWords: true,
      anchor: 'left-top',
    });
  }
  if (album !== '') {
    texts.push({
      kind: 'album',
      text: `— ${album}`,
      x: left + L.albumXRatio - halfW,
      y: height * L.albumYRatio - halfH,
      fontSize: detailSize * L.albumSizeRatio,
      fontWeight: input.detailWeight,
      tone: 'secondary',
      letterSpacing: Math.max(L.albumSpacingMin, detailSize * L.albumSpacingRatio),
      leading: 0,
      wordWrapWidth: contentWidth * L.albumWrapRatio,
      breakWords: false,
      anchor: 'left-top',
    });
  }

  return { draws, texts, fontFamily: input.fontFamily };
}
