/**
 * 凝彩（tempera）**片尾海报的绘制计划**（纯数据，不碰 pixi）。
 *
 * 来源：`chthollyphile/folia-major@main` 的
 * `src/components/visualizer/tempera/temperaSceneBuilder.ts` 的 `buildTemperaCreditsPoster`
 * （AGPL-3.0，**只取算法与数值，代码按本仓库风格重写**；快照
 * `.folia-ref/tempera__temperaSceneBuilder.ts` 第 113~350 行）。
 *
 * 与商籁片尾海报同一套做法：这里只产出 **`draws` / `texts` 清单**（每条自带自己的
 * `base/enter/drift/delay/grow`，交由 `resolveTemperaCreditsItemFrame` 逐项推进），
 * 由 `TemperaTheme` **内联渲染**——因为我方没有上游那套 `draw*` 工厂。
 *
 * 版式数值全部来自 `temperaCreditsLayout.ts`（已单测），本模块只做"版式 → 图元清单"的翻译。
 *
 * ⬜ 待办：上游角饰里的 **`buildCrossRow` 交叉行**尚未纳入（我方该助手的返回形状我还没确认，
 * 不猜；角饰的**小方框（网点 + 描边）**已按上游数值纳入）。
 */

import { buildHatchSpec, buildCrossingLines, buildCrossRow, circlePolygon, type TemperaDecorMark, type TemperaHatchSpec } from './temperaHatch';
import { rectPolygon } from './temperaCompositions';
import { buildTemperaCreditsLayout } from './temperaCreditsLayout';

export type TemperaCreditsTone = 'tone1' | 'tone2' | 'tone3' | 'tone4' | 'ink' | 'paper';

/** 每个图元的动画参数（上游 `CreditsItem`）。 */
export interface TemperaCreditsItemAnim {
  baseX: number;
  baseY: number;
  baseAlpha: number;
  enterDX: number;
  enterDY: number;
  delay: number;
  driftX: number;
  driftY: number;
  grow: number;
}

export interface TemperaCreditsPolygonDraw {
  kind: 'polygon';
  points: number[];
  tone: TemperaCreditsTone;
  alpha: number;
  hatch: TemperaHatchSpec | null;
  hatchAlpha: number;
  outlineWidth: number | null;
  outlineAlpha: number;
  item: TemperaCreditsItemAnim;
}

export interface TemperaCreditsLineDraw {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tone: TemperaCreditsTone;
  width: number;
  alpha: number;
  item: TemperaCreditsItemAnim;
}

export interface TemperaCreditsTextDraw {
  kind: 'text';
  text: string;
  fontPx: number;
  offsetY: number;
  alpha: number;
  wrapWidth: number;
  item: TemperaCreditsItemAnim;
}

export interface TemperaCreditsMarksDraw {
  kind: 'marks';
  /**
   * 角饰的十字行（我方 `buildCrossRow` 的输出）。**原样交给渲染层逐点画** ——
   * 这样计划层不必知道 `TemperaDecorMark` 的内部字段，也就不用去猜。
   */
  marks: TemperaDecorMark[];
  /** 上游 `drawCrossMarks(..., 2, 0.8)` 的第二个参数：点本身的放大倍数。 */
  markScale: number;
  tone: TemperaCreditsTone;
  alpha: number;
  item: TemperaCreditsItemAnim;
}

export interface TemperaCreditsPoster {
  draws: Array<TemperaCreditsPolygonDraw | TemperaCreditsLineDraw | TemperaCreditsMarksDraw>;
  texts: TemperaCreditsTextDraw[];
}

export interface TemperaCreditsPosterInput {
  width: number;
  height: number;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  lyricsFontScale: number;
  /** 是否画角饰（上游 `tuning.showDecor`）。 */
  showDecor: boolean;
  /**
   * 标题行的实测高度（px）。上游是**先建 Text 再量 `title.height`** 来放副标题；
   * 纯计划阶段量不到，所以由调用方传入（缺省 0 ⇒ 副标题紧贴标题下沿）。
   */
  titleHeight?: number;
}

const still = (): TemperaCreditsItemAnim => ({
  baseX: 0,
  baseY: 0,
  baseAlpha: 1,
  enterDX: 0,
  enterDY: 0,
  delay: 0,
  driftX: 0,
  driftY: 0,
  grow: 0,
});

export function buildTemperaCreditsPoster(
  input: TemperaCreditsPosterInput,
): TemperaCreditsPoster {
  const { width, height, title, artist, album, lyricsFontScale, showDecor } = input;
  const titleHeight = input.titleHeight ?? 0;
  const layout = buildTemperaCreditsLayout({ width, height, title, artist, album, lyricsFontScale });
  const { seed, diagonal, bleed, flip } = layout;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const draws: Array<TemperaCreditsPolygonDraw | TemperaCreditsLineDraw | TemperaCreditsMarksDraw> = [];

  // 色调底：满幅、**自身不动**（上游注释：与构图铺底完全一致）。
  draws.push({
    kind: 'polygon',
    points: rectPolygon(-halfWidth - bleed, -halfHeight - bleed, width + bleed * 2, height + bleed * 2),
    tone: 'tone1',
    alpha: 1,
    hatch: null,
    hatchAlpha: 0,
    outlineWidth: null,
    outlineAlpha: 0,
    item: still(),
  });

  const discTones: TemperaCreditsTone[] = ['tone2', 'tone3', 'tone4'];
  for (const disc of layout.discs) {
    const polygon = circlePolygon(0, 0, disc.radius, 72);
    const anim = {
      baseX: disc.cx,
      baseY: disc.cy,
      baseAlpha: 1,
      enterDX: disc.enterDX,
      enterDY: disc.enterDY,
      delay: disc.delay,
      driftX: disc.driftX,
      driftY: disc.driftY,
      grow: 0,
    };
    draws.push({
      kind: 'polygon',
      points: polygon,
      tone: discTones[disc.toneIndex] ?? 'tone2',
      alpha: 1,
      hatch: null,
      hatchAlpha: 0,
      // 填充这笔**不带**描边字段；硬墨线缝由下面单独那笔画（粗细对齐 split 构图的 addSeam）。
      outlineWidth: null,
      outlineAlpha: 0,
      item: anim,
    });
    if (disc.hasHatch) {
      draws.push({
        kind: 'polygon',
        points: polygon,
        tone: 'paper',
        alpha: 0,
        hatch: buildHatchSpec(seed, 271),
        hatchAlpha: 0.28,
        outlineWidth: null,
        outlineAlpha: 0,
        item: { ...anim, delay: disc.hatchDelay },
      });
    }
    draws.push({
      kind: 'polygon',
      points: polygon,
      tone: 'ink',
      alpha: 0,
      hatch: null,
      hatchAlpha: 0,
      outlineWidth: 2.4,
      outlineAlpha: 0.8,
      item: { ...anim, delay: disc.outlineDelay },
    });
  }

  // 每个 shot 都带的两层：满幅引导线（**要减去 half 尺寸**，因为一切都绕容器原点画）。
  const lines = buildCrossingLines(seed, 31, width, height, 2).map((line) => ({
    x1: line.x1 - halfWidth,
    y1: line.y1 - halfHeight,
    x2: line.x2 - halfWidth,
    y2: line.y2 - halfHeight,
  }));
  for (const line of lines) {
    draws.push({
      kind: 'line',
      ...line,
      tone: 'tone4',
      width: 1.3,
      alpha: 0.6,
      item: { ...still(), delay: layout.linesDelay, enterDX: layout.linesEnterDX },
    });
  }

  if (showDecor) {
    const cornerX = halfWidth * 0.66 * flip;
    const cornerY = halfHeight * 0.62;
    // 角饰的十字行：沿 -x 进场（上游 `delay 0.62, enterDX -width*0.06`）。
    draws.push({
      kind: 'marks',
      marks: buildCrossRow(seed, 71, cornerX - width * 0.1, cornerY, 5, width * 0.05, 8),
      markScale: 2,
      tone: 'tone4',
      alpha: 0.8,
      item: { ...still(), delay: 0.62, enterDX: -width * 0.06 },
    });
    const box = rectPolygon(-cornerX - 19, -cornerY - 19, 38, 38);
    draws.push({
      kind: 'polygon',
      points: box,
      tone: 'tone4',
      alpha: 0,
      hatch: buildHatchSpec(seed, 67),
      hatchAlpha: 0.7,
      outlineWidth: null,
      outlineAlpha: 0,
      item: { ...still(), delay: 0.68, grow: 0.06 },
    });
    draws.push({
      kind: 'polygon',
      points: box,
      tone: 'tone4',
      alpha: 0,
      hatch: null,
      hatchAlpha: 0,
      outlineWidth: 1.2,
      outlineAlpha: 0.6,
      item: { ...still(), delay: 0.72 },
    });
  }

  // 文案：标题缺省用音符兜底；标题**不动**，形状在它下面走，反色不断重裁它。
  const subtitle = layout.subtitle;
  const texts: TemperaCreditsTextDraw[] = [
    {
      kind: 'text',
      text: (title ?? '').trim() || '\u266a',
      fontPx: layout.titleSize,
      offsetY: subtitle ? -layout.titleSize * 0.35 : 0,
      alpha: 1,
      wrapWidth: layout.wrapWidth,
      item: { ...still(), delay: 0.78, enterDY: diagonal * 0.03 },
    },
  ];
  if (subtitle) {
    texts.push({
      kind: 'text',
      text: subtitle,
      fontPx: Math.max(14, layout.titleSize * 0.34),
      offsetY: titleHeight / 2 + layout.titleSize * 0.22,
      alpha: 0.75,
      wrapWidth: layout.wrapWidth,
      item: { ...still(), delay: 0.78, enterDY: diagonal * 0.03 },
    });
  }

  return { draws, texts };
}
