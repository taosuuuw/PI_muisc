/**
 * 凝彩（tempera）**片尾视图**：把绘制计划变成真的 Pixi 节点，并提供 `update(elapsed)`。
 *
 * 来源与依据：
 * - 计划与版式：本仓 `temperaCreditsPoster.ts` / `temperaCreditsLayout.ts`（数值照抄 folia，AGPL-3.0）；
 * - 节点形状：照上游 `TemperaCreditsView { container, filters, updateTime(elapsed) }`
 *   （`.folia-ref/tempera__temperaSceneBuilder.ts:139`）——`elapsed` 是**卡片开始以来**的秒数，出现前为负；
 * - 画法一律照**本仓既有写法**（`TemperaTheme.tsx`）：
 *   `.poly(points).fill({ color, alpha })`、`moveTo/lineTo` + `.stroke({ color, alpha, width })`、
 *   `hatchLinesOf(points, surface, coverage)`（`surface = { spec, tone, alpha, grow }`）。
 *
 * ⚠ **铁律**（`TemperaTheme.tsx:546` 注释）：**不在同一块 `Graphics` 上连续 `poly().fill()`**（路径会累积串形）。
 * 本模块因此**一条计划条目建一块 `Graphics`**；计划里填充/网点/描边本来就是三条独立条目，天然满足。
 *
 * ⬜ 本模块**尚未接进 `TemperaTheme`**（挂载、层序、逐帧驱动见 `docs/NEXT.md` 的接线配方）。
 */

import { Container, Graphics, Text, TextStyle, type Filter } from 'pixi.js';

import { hatchLinesOf, type TemperaHatchSurface } from './temperaCompositions';
import { resolveTemperaCreditsItemFrame } from './temperaCreditsLayout';
import {
  buildTemperaCreditsPoster,
  type TemperaCreditsItemAnim,
  type TemperaCreditsTone,
} from './temperaCreditsPoster';

/** 语义色 → 实际颜色。调用方从**逐帧的 tones** 里取（tone1~4 是那条色阶，ink=deep、paper=paper）。 */
export interface TemperaCreditsToneMap {
  readonly tone: readonly string[];
  readonly paper: string;
  readonly deep: string;
}

export interface TemperaCreditsViewOptions {
  width: number;
  height: number;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  lyricsFontScale: number;
  showDecor: boolean;
  fontFamily: string;
  tones: TemperaCreditsToneMap;
  /** 标题层的反色滤镜；由调用方给（`createTemperaDifferenceFilter` 的输出）。 */
  titleFilter?: Filter | null;
}

export interface TemperaCreditsView {
  container: Container;
  /** 层内节点数（"建层即打"探针用）。 */
  nodeCount: number;
  /** 计划条目数（探针用）。 */
  itemCount: number;
  /** `elapsed` 是**卡片开始以来**的秒数。 */
  update: (elapsed: number) => void;
  /** 摘链并销毁（先解绑再销毁的纪律）。 */
  destroy: () => void;
}

function resolveTone(tone: TemperaCreditsTone, tones: TemperaCreditsToneMap): string {
  switch (tone) {
    case 'tone1':
      return tones.tone[0] ?? tones.paper;
    case 'tone2':
      return tones.tone[1] ?? tones.tone[0] ?? tones.deep;
    case 'tone3':
      return tones.tone[2] ?? tones.tone[1] ?? tones.deep;
    case 'tone4':
      return tones.tone[3] ?? tones.tone[2] ?? tones.deep;
    case 'ink':
      return tones.deep;
    case 'paper':
    default:
      return tones.paper;
  }
}

export function createTemperaCreditsView(options: TemperaCreditsViewOptions): TemperaCreditsView {
  const { width, height, fontFamily, tones } = options;
  const poster = buildTemperaCreditsPoster({
    width,
    height,
    title: options.title,
    artist: options.artist,
    album: options.album,
    lyricsFontScale: options.lyricsFontScale,
    showDecor: options.showDecor,
  });

  const container = new Container();
  const items: Array<{ node: Container | Text; anim: TemperaCreditsItemAnim }> = [];

  const push = (node: Container | Text, anim: TemperaCreditsItemAnim): void => {
    node.position.set(anim.baseX, anim.baseY);
    container.addChild(node);
    items.push({ node, anim });
  };

  for (const draw of poster.draws) {
    if (draw.kind === 'line') {
      const graphics = new Graphics();
      graphics.moveTo(draw.x1, draw.y1).lineTo(draw.x2, draw.y2);
      graphics.stroke({ color: resolveTone(draw.tone, tones), alpha: draw.alpha, width: draw.width });
      push(graphics, draw.item);
      continue;
    }
    if (draw.kind === 'marks') {
      // 角饰的十字行：逐点按 `{ x, y, size, rotation }` 画一个小方块（尺寸乘计划里的 `markScale`）。
      const graphics = new Graphics();
      for (const mark of draw.marks) {
        const half = (mark.size * draw.markScale) / 2;
        const cos = Math.cos(mark.rotation);
        const sin = Math.sin(mark.rotation);
        const corner = (dx: number, dy: number): [number, number] => [
          mark.x + dx * cos - dy * sin,
          mark.y + dx * sin + dy * cos,
        ];
        const a = corner(-half, -half);
        const b = corner(half, -half);
        const c = corner(half, half);
        const d = corner(-half, half);
        graphics.poly([...a, ...b, ...c, ...d]).fill({ color: resolveTone(draw.tone, tones), alpha: draw.alpha });
      }
      push(graphics, draw.item);
      continue;
    }

    // polygon：填充 / 网点 / 描边在计划里是**三条独立条目**，所以每条只画自己那一件事。
    if (draw.alpha > 0) {
      const graphics = new Graphics();
      graphics.poly([...draw.points]).fill({ color: resolveTone(draw.tone, tones), alpha: draw.alpha });
      push(graphics, draw.item);
    }
    if (draw.hatch !== null) {
      const surface: TemperaHatchSurface = {
        spec: draw.hatch,
        tone: 0,
        alpha: draw.hatchAlpha,
        grow: false,
      };
      const lines = hatchLinesOf(draw.points, surface, 1);
      if (lines.length > 0) {
        const graphics = new Graphics();
        for (const line of lines) graphics.moveTo(line.x1, line.y1).lineTo(line.x2, line.y2);
        graphics.stroke({
          color: resolveTone(draw.tone, tones),
          alpha: draw.hatchAlpha,
          width: draw.hatch.width,
        });
        push(graphics, draw.item);
      }
    }
    if (draw.outlineWidth !== null) {
      const graphics = new Graphics();
      graphics
        .poly([...draw.points])
        .stroke({
          color: resolveTone(draw.tone, tones),
          alpha: draw.outlineAlpha,
          width: draw.outlineWidth,
        });
      push(graphics, draw.item);
    }
  }

  /*
   * 文案**两遍布局**：先建好标题与副标题的 `Text`，**量出标题的真实高度后**再决定副标题的 y。
   * 上游就是这么做的（先建 `Text`、再读 `title.height`）；计划里的 `titleHeight` 因此只是兜底。
   * 不量高的后果实测过：标题一折行，副标题就压在标题第二行上
   * （取证图 `docs/m3-lyric-tempera-credits-probe2.png`）。
   */
  const textNodes = poster.texts.map(
    (text) =>
      new Text({
        text: text.text,
        style: new TextStyle({
          fontFamily,
          fontSize: text.fontPx,
          fontWeight: '600',
          fill: resolveTone('ink', tones),
          align: 'center',
          wordWrap: true,
          wordWrapWidth: text.wrapWidth,
        }),
      }),
  );
  const measuredTitleHeight = textNodes[0]?.height ?? 0;
  const titleFontPx = poster.texts[0]?.fontPx ?? 0;
  textNodes.forEach((node, index) => {
    const text = poster.texts[index];
    if (text === undefined) return;
    node.anchor.set(0.5);
    // 标题用计划给的偏移（有副标题时上移）；副标题改用**实测**的标题高度。
    const offsetY = index === 0 ? text.offsetY : measuredTitleHeight / 2 + titleFontPx * 0.22;
    node.y = offsetY;
    if (options.titleFilter && index === 0) node.filters = [options.titleFilter];
    /*
     * ⚠ 文案自己的透明度（副标题 0.75）**必须折进 `baseAlpha`**：
     * 逐帧 `update` 会用 `frame.alpha` 直接覆盖 `node.alpha`，否则副标题会被写成全不透明。
     * 基准位也要带上自己的 y 偏（`push` 会写 baseX/baseY）。
     */
    push(node, {
      ...text.item,
      baseY: text.item.baseY + offsetY,
      baseAlpha: text.item.baseAlpha * text.alpha,
    });
  });

  return {
    container,
    nodeCount: container.children.length,
    itemCount: items.length,
    update: (elapsed: number): void => {
      for (const item of items) {
        const frame = resolveTemperaCreditsItemFrame(item.anim, elapsed);
        item.node.alpha = frame.alpha;
        item.node.visible = frame.visible;
        item.node.position.set(frame.x, frame.y);
        if (item.anim.grow !== 0) item.node.scale.set(frame.scale);
      }
    },
    destroy: (): void => {
      container.removeFromParent();
      container.destroy({ children: true });
    },
  };
}
