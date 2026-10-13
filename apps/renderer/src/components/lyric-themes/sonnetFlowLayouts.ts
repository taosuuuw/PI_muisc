import { layoutSonnetPosterBlocks } from './sonnetPosterBlocksLayout';

/**
 * 商籁（sonnet）的**排版打包**：把一组"字块"摆到画面上。
 *
 * === 这是什么、为什么需要 ===
 * 之前我们每行只算**一个**位置（`placementFor`），所以画面上永远只有一行字挤在一处 ——
 * 成品图一眼就能看出来"不像原版"。原版是**先把每一段字量成一个盒子，再整组打包**：
 * 十字、丝带、竖列、杂志栏、极坐标环…… 每两个盒子之间保证有 `flowGap` 的空隙，
 * 超出安全区就**整组等比缩小重排**（而不是把某一行挤扁）。
 *
 * === 借鉴的数值（照抄，不是推断）===
 * 来源 folia 的 `sonnet/sonnetShotFlowLayouts.ts`（AGPL-3.0，只取数值与做法，代码在本仓库重写）：
 * - 间隙：`flowGap = clamp(基准字号 × 0.35, 16, 40)`；`stackGap = max(24, flowGap × 1.35)`。
 * - 安全区：半宽 `width × 0.48`、半高 `height × 0.46`。
 * - 全局缩放阶梯：`[1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52]` —— 每次**所有盒子一起缩**，
 *   所以「主角 > 次主角 > 陪衬」的层级与「陪衬永不放大」的规则在每一档都成立。
 * - `quiet-tableau` 4 档（竖列 / 竖列错位 / 横卡 / 横卡错位）、`tracking-ribbon` 3 档
 *   （基线 / 顶线 / 上下错落）、`editorial-column` **5 档**（竖栏 / 右栏 / 眉题 + 双栏 / 双主行 / Logo 徽章）、
 *   `fragment-collage` 3 档（环 / 螺旋 / 双环，`squash = 0.65`）。
 *
 * === 与 folia 的差异（照实记）===
 * 1. 原版用的是 `@chenglou/pretext` **真实测量**出来的盒子尺寸；我们按"可见字数 × 字号"与
 *    "字号 × 1.2"估算，够用于换行判断，但**不是同一套测量**。
 * 2. `poster-blocks` 那一族（在 `sonnetPosterBlocksLayout.ts`）没取到，仍走旧的单点摆放。
 * 3. `cross` 里的 `fillColumn`（把偏短的列拉伸填满）只搬了数值上限，没有逐项对齐。
 */

import type { SonnetShotKind } from './sonnetKinds';

/** 一个待摆放的字块。角色、字号与量出来的宽高由调用方填好。 */
export interface SonnetFlowBox {
  index: number;
  isHero: boolean;
  isSemiHero: boolean;
  fontScale: number;
  measuredWidth: number;
  measuredHeight: number;
  /*
   * **竖排专用尺寸**（照抄 folia：盒子上同时带着横排与竖排两套量法）：
   * 海报方块那族排版会**换取向**（同一块可能在竖排里改成横排），换过去之后要立刻有尺寸可用，
   * 不能拿横排的宽高硬套。`verticalFontScale` 是竖排时用的字号倍率。
   *
   * ⚠ **三字段可选**（对应上游的三个 `undefined`）：只有**海报镜头 + CJK 段**才会给全，
   * 英文段一律 `undefined` ⇒ 海报排版只能走正常词块，不会把字母按列改写。
   */
  verticalMeasuredWidth?: number;
  verticalMeasuredHeight?: number;
  verticalFontScale?: number;
  vertical: boolean;
  layoutDirection: 'horizontal' | 'vertical';
  rotation: number;
  x: number;
  y: number;
  enterX: number;
  enterY: number;
}

export interface SonnetFlowContext {
  boxes: SonnetFlowBox[];
  heroIndex: number;
  width: number;
  height: number;
  flowGap: number;
  stackGap: number;
}

/**
 * 每种镜头**自己那一档变体**（照抄 folia 的取法：`layoutVariantSeed = 该镜所有片段字数之和 + 片段数`，
 * 再按种类取不同的模：社论栏 %5、丝带 %3、静场 %4、碎片环 %3）。
 */
export interface SonnetFlowVariants {
  editorial: number;
  ribbon: number;
  tableau: number;
  collage: number;
}

/*
 * **全局缩放阶梯（照抄上游）** —— 我第 17 轮曾把它撤成只有 1 档，**那是错的，已还原**。
 *
 * 当时的判断是"上游没有全局缩放、只对单个盒子做 82% 上限"，所以整幅字变小一定是它干的。
 * 但对照本地的上游排版模块（`.tmp/folia-src/sonnetShotFlowLayouts.ts`）就能看到相反的事实：
 *   · 该文件里 `placeWithGlobalFit` 的说明就是"**按逐级缩小的全局比例反复试探**，直到每个盒子
 *     都落在舞台安全区内 —— 所有角色一起缩，所以主角 > 次主角 > 配角的层级不变"；
 *   · 文件里还直接引用了最低档：`fitsSingleRail` 那个判据写的是 `... × 0.52 + ...`。
 * 也就是说**上游确实有这条阶梯、最低档也确实是 0.52** —— 与这里原值一致。
 *
 * 顺带把 `flowGap/stackGap` 也对了一遍，同样一致：`clamp(基准字号 × 0.35, 16, 40)` 与
 * `max(24, flowGap × 1.35)`（上游 `resolveSonnetFlowGaps`）。
 *
 * ⇒ "字小"的真凶是**帧层视口被多除了一次 DPR**（946 vs 1182，第 31 轮已修），不是这条阶梯。
 *   撤掉阶梯反而是**自创的近似**（正是主人 ③ 禁止的那种），所以还原成上游的值。
 */
export const SONNET_FLOW_SCALE_LADDER = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52] as const;
export const SONNET_SAFE_HALF_W_RATIO = 0.48;
export const SONNET_SAFE_HALF_H_RATIO = 0.46;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 字与字的间隙（`flowGap`）与行/列之间的间隙（`stackGap`）—— 所有分支共用。 */
export function resolveSonnetFlowGaps(baseFontSize: number): { flowGap: number; stackGap: number } {
  const flowGap = clamp(baseFontSize * 0.35, 16, 40);
  return { flowGap, stackGap: Math.max(24, flowGap * 1.35) };
}

/**
 * 反复在**缩小的全局尺度**上重排，直到每个盒子都落在安全区里。
 *
 * 关键在"全局"：所有角色一起缩，层级关系不会走样；而且一旦某一档合适就立刻停手。
 * 原版是七档走完仍不合适就用最后一档，我们照做。
 */
export function placeWithGlobalFit(
  ctx: SonnetFlowContext,
  place: (globalScale: number) => void,
): void {
  const snapshot = ctx.boxes.map((box) => ({
    fontScale: box.fontScale,
    measuredWidth: box.measuredWidth,
    measuredHeight: box.measuredHeight,
  }));
  const safeHalfW = ctx.width * SONNET_SAFE_HALF_W_RATIO;
  const safeHalfH = ctx.height * SONNET_SAFE_HALF_H_RATIO;
  for (const globalScale of SONNET_FLOW_SCALE_LADDER) {
    ctx.boxes.forEach((box, index) => {
      const base = snapshot[index];
      if (base === undefined) return;
      box.fontScale = base.fontScale * globalScale;
      box.measuredWidth = base.measuredWidth * globalScale;
      box.measuredHeight = base.measuredHeight * globalScale;
    });
    place(globalScale);
    const fits = ctx.boxes.every(
      (box) =>
        Math.abs(box.x) + box.measuredWidth / 2 <= safeHalfW + 0.5 &&
        Math.abs(box.y) + box.measuredHeight / 2 <= safeHalfH + 0.5,
    );
    if (fits) return;
  }
}

/**
 * **十字**（重字冲击 / 遮罩揭示）：顶列 → 左行 → 主角 → 右行 → 底列。
 *
 * 这个切法保证"扫描顺序 = 时间轴顺序"：主角之前的字一半去顶列、一半去左行，
 * 之后的一半去右行、一半去底列。
 */
export function layoutCrossStack(ctx: SonnetFlowContext): void {
  const { boxes, heroIndex, height, flowGap, stackGap } = ctx;
  const heroBox = boxes[heroIndex];
  if (heroBox === undefined) return;
  const beforeCount = heroIndex;
  const topCount = Math.floor(beforeCount / 2);
  const afterCount = boxes.length - 1 - heroIndex;
  const rightCount = Math.ceil(afterCount / 2);

  /** 把偏短的列撑开填满可用高度（放大有上限，不许盖过主角层级）。 */
  const fillColumn = (column: SonnetFlowBox[]): number => {
    if (column.length === 0) return 0;
    const available = Math.max(0, height * SONNET_SAFE_HALF_H_RATIO - heroBox.measuredHeight / 2 - stackGap);
    if (available <= 0) return 0;
    const gaps = stackGap * (column.length - 1);
    const contentHeight = column.reduce((sum, box) => sum + box.measuredHeight, 0);
    const target = available * 0.72;
    if (contentHeight + gaps < target) {
      const boost = Math.min(2.2, (target - gaps) / Math.max(1, contentHeight));
      for (const box of column) {
        const capped = Math.min(boost, (heroBox.fontScale * 0.6) / Math.max(0.001, box.fontScale));
        if (capped > 1.05) {
          box.fontScale *= capped;
          box.measuredWidth *= capped;
          box.measuredHeight *= capped;
        }
      }
    }
    if (column.length < 2) return 0;
    const grown = column.reduce((sum, box) => sum + box.measuredHeight, 0);
    const pitch = (available * 0.95 - grown) / (column.length - 1);
    return Math.max(0, Math.min(stackGap * 2, pitch - stackGap));
  };

  placeWithGlobalFit(ctx, () => {
    heroBox.x = 0;
    heroBox.y = 0;
    const topStretch = fillColumn(boxes.slice(0, topCount));
    const bottomStretch = fillColumn(boxes.slice(heroIndex + rightCount + 1));

    // 左行：主角之前那半段，越早越靠左。
    let currentX = heroBox.x - heroBox.measuredWidth / 2 - stackGap;
    for (let i = heroIndex - 1; i >= topCount; i -= 1) {
      const box = boxes[i];
      if (box === undefined) continue;
      box.layoutDirection = 'horizontal';
      box.x = currentX - box.measuredWidth / 2;
      box.y = heroBox.y + (i % 2 === 0 ? 10 : -10);
      currentX -= box.measuredWidth + flowGap;
      box.enterX = -30;
      box.enterY = 0;
    }

    // 顶列：越早越靠上。
    let currentY = heroBox.y - heroBox.measuredHeight / 2 - stackGap;
    for (let i = topCount - 1; i >= 0; i -= 1) {
      const box = boxes[i];
      if (box === undefined) continue;
      box.layoutDirection = 'vertical';
      box.x = heroBox.x + (i % 2 === 0 ? 15 : -15);
      box.y = currentY - box.measuredHeight / 2;
      currentY -= box.measuredHeight + stackGap + topStretch;
      box.enterX = 0;
      box.enterY = -30;
    }

    // 右行：紧接主角的那些，从左往右。
    currentX = heroBox.x + heroBox.measuredWidth / 2 + stackGap;
    for (let i = heroIndex + 1; i <= heroIndex + rightCount; i += 1) {
      const box = boxes[i];
      if (box === undefined) continue;
      box.layoutDirection = 'horizontal';
      box.x = currentX + box.measuredWidth / 2;
      box.y = heroBox.y + (i % 2 === 0 ? 10 : -10);
      currentX += box.measuredWidth + flowGap;
      box.enterX = 30;
      box.enterY = 0;
    }

    // 底列：剩下的，从上往下。
    currentY = heroBox.y + heroBox.measuredHeight / 2 + stackGap;
    for (let i = heroIndex + rightCount + 1; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box === undefined) continue;
      box.layoutDirection = 'vertical';
      box.x = heroBox.x + (i % 2 === 0 ? 15 : -15);
      box.y = currentY + box.measuredHeight / 2;
      currentY += box.measuredHeight + stackGap + bottomStretch;
      box.enterX = 0;
      box.enterY = 30;
    }
  });
}

/** **跟拍丝带**：一条水平线，主角之前的往左接、之后的往右接（严格的阅读顺序）。 */
export function layoutTrackingRibbon(ctx: SonnetFlowContext, variant: number): void {
  const { boxes, heroIndex, flowGap } = ctx;
  const heroBox = boxes[heroIndex];
  if (heroBox === undefined) return;
  for (const box of boxes) box.layoutDirection = 'horizontal';
  placeWithGlobalFit(ctx, () => {
    heroBox.x = 0;
    heroBox.y = 0;
    const alignY = (box: SonnetFlowBox, index: number): number =>
      variant === 1
        ? heroBox.y + heroBox.measuredHeight / 2 - box.measuredHeight / 2
        : variant === 2
          ? heroBox.y - heroBox.measuredHeight / 2 + box.measuredHeight / 2
          : heroBox.y + (index % 2 === 0 ? 10 : -10);
    const enter = variant === 2 ? 20 : 30;
    let currentX = heroBox.x - heroBox.measuredWidth / 2 - flowGap;
    for (let i = heroIndex - 1; i >= 0; i -= 1) {
      const box = boxes[i];
      if (box === undefined) continue;
      box.x = currentX - box.measuredWidth / 2;
      box.y = alignY(box, i);
      currentX -= box.measuredWidth + flowGap;
      box.enterX = enter;
      box.enterY = 0;
    }
    currentX = heroBox.x + heroBox.measuredWidth / 2 + flowGap;
    for (let i = heroIndex + 1; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box === undefined) continue;
      box.x = currentX + box.measuredWidth / 2;
      box.y = alignY(box, i);
      currentX += box.measuredWidth + flowGap;
      box.enterX = -enter;
      box.enterY = 0;
    }
  });
}

/**
 * **静场**：一列安静的竖排，主角之前的在上、之后的在下，按时间轴从上往下读。
 * 超出安全高度就**换列**（越早的往右列接，越晚的往左列接），而不是缩字。
 */
export function layoutQuietTableau(ctx: SonnetFlowContext, variant: number): void {
  const { boxes, heroIndex, height, stackGap } = ctx;
  const heroBox = boxes[heroIndex];
  if (heroBox === undefined) return;
  const horizontalCard = variant === 2 || variant === 3;
  for (const box of boxes) box.layoutDirection = horizontalCard ? 'horizontal' : 'vertical';
  const safeHalfH = height * SONNET_SAFE_HALF_H_RATIO;
  placeWithGlobalFit(ctx, () => {
    heroBox.x = 0;
    heroBox.y = horizontalCard ? 0 : -height * 0.1;
    const stagger = variant === 3 ? 70 : 0;
    const columnStep = Math.max(...boxes.map((box) => box.measuredWidth)) + stackGap + stagger;
    const xFor = (box: SonnetFlowBox, index: number): number => {
      if (variant === 1) return heroBox.x - heroBox.measuredWidth / 2 + box.measuredWidth / 2;
      if (variant === 3) return heroBox.x + (index % 2 === 0 ? 1 : -1) * 35;
      return heroBox.x;
    };
    // 主角之前：往上排；放不下就换列，列往右走。
    let column = 0;
    let currentY = heroBox.y - heroBox.measuredHeight / 2 - stackGap;
    for (let i = heroIndex - 1; i >= 0; i -= 1) {
      const box = boxes[i];
      if (box === undefined) continue;
      if (currentY - box.measuredHeight < -safeHalfH) {
        column += 1;
        currentY = safeHalfH;
      }
      box.x = xFor(box, i) + column * columnStep;
      box.y = currentY - box.measuredHeight / 2;
      currentY -= box.measuredHeight + stackGap;
      if (variant === 1) {
        box.enterX = 20;
        box.enterY = 0;
      } else if (variant === 3) {
        box.enterX = box.x > heroBox.x ? 30 : -30;
        box.enterY = 0;
      } else {
        box.enterX = 0;
        box.enterY = 20;
      }
    }
    // 主角之后：往下排；放不下就换列，列往左走。
    column = 0;
    currentY = heroBox.y + heroBox.measuredHeight / 2 + stackGap;
    for (let i = heroIndex + 1; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box === undefined) continue;
      if (currentY + box.measuredHeight > safeHalfH) {
        column += 1;
        currentY = -safeHalfH;
      }
      box.x = xFor(box, i) - column * columnStep;
      box.y = currentY + box.measuredHeight / 2;
      currentY += box.measuredHeight + stackGap;
      if (variant === 1) {
        box.enterX = -20;
        box.enterY = 0;
      } else if (variant === 3) {
        box.enterX = box.x > heroBox.x ? 30 : -30;
        box.enterY = 0;
      } else {
        box.enterX = 0;
        box.enterY = -20;
      }
    }
  });
}

/**
 * **碎片拼贴**：极坐标环，严格按时间轴顺时针推进。
 *
 * 每个陪衬不断推进角度，直到它的矩形**和已放下的每个矩形都不重叠**（含主角）——
 * 所以看起来乱、却没有一处真的叠在一起。`squash = 0.65` 把正圆压成横向椭圆。
 */
export function layoutFragmentCollage(ctx: SonnetFlowContext, variant: number): void {
  const { boxes, heroIndex, flowGap, stackGap } = ctx;
  const heroBox = boxes[heroIndex];
  if (heroBox === undefined) return;
  interface PlacedRect {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }
  /** 重叠时为负，否则是两矩形的距离。 */
  const rectSeparation = (a: PlacedRect, b: PlacedRect): number =>
    Math.max(Math.max(a.left - b.right, b.left - a.right), Math.max(a.top - b.bottom, b.top - a.bottom));
  // 被旋转过的非 CJK 块是按"竖着的尺寸"量的，拼贴里要摊平回横的。
  boxes.forEach((box, index) => {
    if (index === heroIndex) return;
    if (Math.abs(Math.round(box.rotation / (Math.PI / 2)) % 2) === 1) {
      const rotatedWidth = box.measuredHeight;
      box.measuredHeight = box.measuredWidth;
      box.measuredWidth = rotatedWidth;
    }
    box.rotation = 0;
  });
  placeWithGlobalFit(ctx, (globalScale) => {
    heroBox.x = 0;
    heroBox.y = 0;
    const baseRadius = Math.hypot(heroBox.measuredWidth, heroBox.measuredHeight) / 2 + stackGap;
    const count = Math.max(1, boxes.length - 1);
    const squash = 0.65;
    const placed: PlacedRect[] = [
      {
        left: heroBox.x - heroBox.measuredWidth / 2,
        right: heroBox.x + heroBox.measuredWidth / 2,
        top: heroBox.y - heroBox.measuredHeight / 2,
        bottom: heroBox.y + heroBox.measuredHeight / 2,
      },
    ];
    let angle = Math.PI / 4;
    let supportIndex = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      if (i === heroIndex) continue;
      const box = boxes[i];
      if (box === undefined) continue;
      let radius = baseRadius;
      if (variant === 1) {
        radius += (35 + (supportIndex / count) * 150) * globalScale;
      } else if (variant === 2) {
        radius += (supportIndex % 2 === 1 ? 140 : 50) * globalScale;
      } else {
        radius += (45 + ((supportIndex * 23) % 90)) * globalScale;
      }
      supportIndex += 1;
      let candidate = angle;
      let rect: PlacedRect = { left: 0, right: 0, top: 0, bottom: 0 };
      let resolvedRadius = radius;
      let placedClear = false;
      for (let ring = 0; ring < 14 && !placedClear; ring += 1) {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          rect = {
            left: Math.cos(candidate) * resolvedRadius - box.measuredWidth / 2,
            right: Math.cos(candidate) * resolvedRadius + box.measuredWidth / 2,
            top: (Math.sin(candidate) * resolvedRadius * squash) - box.measuredHeight / 2,
            bottom: (Math.sin(candidate) * resolvedRadius * squash) + box.measuredHeight / 2,
          };
          if (placed.every((entry) => rectSeparation(entry, rect) >= flowGap)) {
            placedClear = true;
            break;
          }
          candidate += 0.07;
        }
        if (!placedClear) resolvedRadius += (36 + ring * 12) * globalScale;
      }
      angle = candidate + 0.02;
      placed.push(rect);
      box.x = heroBox.x + Math.cos(candidate) * resolvedRadius;
      box.y = heroBox.y + Math.sin(candidate) * resolvedRadius * squash;
      box.layoutDirection =
        Math.abs(Math.cos(candidate)) >= Math.abs(Math.sin(candidate)) ? 'vertical' : 'horizontal';
      box.enterX = Math.cos(candidate) * -60;
      box.enterY = Math.sin(candidate) * -60;
    }
  });
}

/**
 * **社论栏（`editorial-column`）五档** —— 数值与分支照抄 folia 的 `layoutEditorialColumn`，
 * 代码在本仓库重写。五档的含义（folia 的注释原文照译）：
 *
 * - **0 竖排双栏**：主角柱在画面左 15%；**它右**那一栏放"时间上更早"的词、**它左**那一栏放更晚的
 *   —— 竖排是从右往左读的，栏内自上而下。
 * - **1 右对齐杂志栏**：一条右对齐的竖栏，按时间顺序自上而下；一栏装不下就往**左**续栏，
 *   而不是把字缩小。
 * - **2 杂志眉题**：主角上移 25% 高度，比它早的词在它上方排成一行（眉题），比它晚的词在它下方
 *   左右两列一行行配对。
 * - **3 双主行**：两行错位摆开，用**真实行高**分隔（不是固定微调），再给两行一个 12% 宽度的台阶错位。
 * - **4 Logo 徽章**：主角竖柱浮在流的一侧；比它早的词先占满宽行，比它晚的词绕柱排，柱底之下再回到满宽。
 *   （这一档的"绕柱"规则借的是海报版式的"区域浮动"做法。）
 */
export function layoutEditorialColumn(
  ctx: SonnetFlowContext,
  variant: number,
  secondaryHeroIndex: number,
): void {
  const { boxes, heroIndex, width, height, flowGap, stackGap } = ctx;
  const heroBox = boxes[heroIndex];
  if (heroBox === undefined) return;

  if (variant === 0) {
    for (const box of boxes) box.layoutDirection = 'vertical';
    placeWithGlobalFit(ctx, () => {
      heroBox.x = -width * 0.15;
      heroBox.y = 0;
      // 主角之前：排到右边那一栏（竖排先读右边的栏）。
      let currentY = heroBox.y - heroBox.measuredHeight / 2 + stackGap * 0.5;
      for (let i = 0; i < heroIndex; i += 1) {
        const box = boxes[i];
        if (box === undefined) continue;
        box.x = heroBox.x + heroBox.measuredWidth / 2 + flowGap + box.measuredWidth / 2;
        box.y = currentY + box.measuredHeight / 2;
        currentY += box.measuredHeight + stackGap;
        box.enterX = -20;
        box.enterY = 0;
      }
      // 主角之后：排到左边那一栏。
      currentY = heroBox.y - heroBox.measuredHeight / 2 + stackGap * 0.5;
      for (let i = heroIndex + 1; i < boxes.length; i += 1) {
        const box = boxes[i];
        if (box === undefined) continue;
        box.x = heroBox.x - heroBox.measuredWidth / 2 - flowGap - box.measuredWidth / 2;
        box.y = currentY + box.measuredHeight / 2;
        currentY += box.measuredHeight + stackGap;
        box.enterX = 20;
        box.enterY = 0;
      }
    });
    return;
  }

  if (variant === 1) {
    for (const box of boxes) box.layoutDirection = 'vertical';
    placeWithGlobalFit(ctx, () => {
      const rightEdge = width * 0.28;
      const safeHalfH = height * 0.46;
      const railStep = Math.max(...boxes.map((box) => box.measuredWidth)) + stackGap;
      const totalHeight =
        boxes.reduce((sum, box) => sum + box.measuredHeight, 0) + stackGap * (boxes.length - 1);
      /*
       * 单栏优先：只要**最小档尺度下**这条栏还塞得进，就不换栏 ——
       * 0.52 是缩放阶梯的最低档，拿它当"最坏情况"的判据。
       */
      const fitsSingleRail =
        boxes.reduce((sum, box) => sum + box.measuredHeight, 0) * 0.52 + stackGap * (boxes.length - 1) <=
        safeHalfH * 2;
      if (fitsSingleRail) {
        let currentY = -totalHeight / 2;
        for (const box of boxes) {
          box.x = rightEdge - box.measuredWidth / 2;
          box.y = currentY + box.measuredHeight / 2;
          currentY += box.measuredHeight + stackGap;
          box.enterX = 20;
          box.enterY = 0;
        }
        return;
      }
      let rail = 0;
      let currentY = -safeHalfH;
      for (const box of boxes) {
        if (currentY + box.measuredHeight > safeHalfH) {
          rail += 1;
          currentY = -safeHalfH;
        }
        box.x = rightEdge - rail * railStep - box.measuredWidth / 2;
        box.y = currentY + box.measuredHeight / 2;
        currentY += box.measuredHeight + stackGap;
        box.enterX = 20;
        box.enterY = 0;
      }
    });
    return;
  }

  if (variant === 2) {
    for (const box of boxes) box.layoutDirection = 'horizontal';
    placeWithGlobalFit(ctx, () => {
      heroBox.x = 0;
      heroBox.y = -height * 0.25;
      const before = boxes.slice(0, heroIndex);
      const after = boxes.slice(heroIndex + 1);
      if (before.length > 0) {
        const kickerHeight = Math.max(...before.map((box) => box.measuredHeight));
        const kickerWidth =
          before.reduce((sum, box) => sum + box.measuredWidth, 0) + flowGap * (before.length - 1);
        const kickerY = heroBox.y - heroBox.measuredHeight / 2 - stackGap - kickerHeight / 2;
        let currentX = heroBox.x - kickerWidth / 2;
        for (const box of before) {
          box.x = currentX + box.measuredWidth / 2;
          box.y = kickerY;
          currentX += box.measuredWidth + flowGap;
          box.enterX = 0;
          box.enterY = -20;
        }
      }
      const leftAnchor = heroBox.x - heroBox.measuredWidth * 0.25 - flowGap;
      const rightAnchor = heroBox.x + heroBox.measuredWidth * 0.25 + flowGap;
      let currentY = heroBox.y + heroBox.measuredHeight / 2 + stackGap;
      for (let pair = 0; pair < after.length; pair += 2) {
        const left = after[pair];
        const right = after[pair + 1];
        if (left === undefined) break;
        const rowHeight = Math.max(left.measuredHeight, right?.measuredHeight ?? 0);
        left.x = leftAnchor - left.measuredWidth / 2;
        left.y = currentY + left.measuredHeight / 2;
        left.enterX = -20;
        left.enterY = 0;
        if (right !== undefined) {
          right.x = rightAnchor + right.measuredWidth / 2;
          right.y = currentY + right.measuredHeight / 2;
          right.enterX = 20;
          right.enterY = 0;
        }
        currentY += rowHeight + stackGap;
      }
    });
    return;
  }

  if (variant === 3) {
    for (const box of boxes) box.layoutDirection = 'horizontal';
    placeWithGlobalFit(ctx, () => {
      heroBox.x = 0;
      heroBox.y = 0;
      const firstHero = Math.min(heroIndex, secondaryHeroIndex);
      const line1 = boxes.slice(0, firstHero + 1);
      const line2 = boxes.slice(firstHero + 1);
      const line1Height = Math.max(...line1.map((box) => box.measuredHeight));
      const line2Height = Math.max(...line2.map((box) => box.measuredHeight));
      const totalHeight = line1Height + stackGap + line2Height;
      const line1Y = heroBox.y - totalHeight / 2 + line1Height / 2;
      const line2Y = line1Y + line1Height / 2 + stackGap + line2Height / 2;
      const layLine = (line: SonnetFlowBox[], lineY: number, enterX: number): number => {
        const lineWidth =
          line.reduce((sum, box) => sum + box.measuredWidth, 0) + flowGap * (line.length - 1);
        let currentX = -lineWidth / 2;
        for (const box of line) {
          box.x = currentX + box.measuredWidth / 2;
          box.y = lineY;
          currentX += box.measuredWidth + flowGap;
          box.enterX = enterX;
          box.enterY = 0;
        }
        return lineWidth;
      };
      const line1Width = layLine(line1, line1Y, 30);
      const line2Width = layLine(line2, line2Y, -30);
      // 台阶错位：两行各往相反方向挪 12% 行宽。
      const offsetAmount = Math.max(line1Width, line2Width) * 0.12;
      for (const box of line1) box.x -= offsetAmount;
      for (const box of line2) box.x += offsetAmount;
    });
    return;
  }

  // variant 4（其它取值也走这一档）：Logo 徽章。
  boxes.forEach((box, index) => {
    box.layoutDirection = index === heroIndex ? 'vertical' : 'horizontal';
  });
  placeWithGlobalFit(ctx, () => {
    const heroOnRight = heroIndex === boxes.length - 1;
    const blockLeft = -width * 0.4;
    const blockRight = width * 0.4;
    let currentY = -height * 0.34;

    /** 把给定的一串盒子按行排满；每行的可用区间由 `regionFor` 按当前行顶算出（绕柱就靠它）。 */
    const flowWords = (indices: readonly number[], regionFor: (rowTop: number) => [number, number]): void => {
      let [left, right] = regionFor(currentY);
      let currentX = left;
      let rowHeight = 0;
      for (const index of indices) {
        const box = boxes[index];
        if (box === undefined) continue;
        if (currentX > left && currentX + box.measuredWidth > right) {
          currentY += rowHeight + stackGap;
          [left, right] = regionFor(currentY);
          currentX = left;
          rowHeight = 0;
        }
        box.x = currentX + box.measuredWidth / 2;
        box.y = currentY + box.measuredHeight / 2;
        box.enterX = heroOnRight ? -25 : 25;
        box.enterY = 0;
        currentX += box.measuredWidth + flowGap;
        rowHeight = Math.max(rowHeight, box.measuredHeight);
      }
      if (indices.length > 0) currentY += rowHeight;
    };

    flowWords(
      boxes.slice(0, heroIndex).map((box) => box.index),
      () => [blockLeft, blockRight],
    );
    currentY += stackGap;

    const pillarLeft = heroOnRight ? blockRight - heroBox.measuredWidth : blockLeft;
    heroBox.x = pillarLeft + heroBox.measuredWidth / 2;
    heroBox.y = currentY + heroBox.measuredHeight / 2;
    const pillarBottom = currentY + heroBox.measuredHeight + stackGap;
    const besideLeft = heroOnRight ? blockLeft : pillarLeft + heroBox.measuredWidth + flowGap;
    const besideRight = heroOnRight ? pillarLeft - flowGap : blockRight;
    flowWords(boxes.slice(heroIndex + 1).map((box) => box.index), (rowTop) =>
      rowTop < pillarBottom - 0.5 ? [besideLeft, besideRight] : [blockLeft, blockRight],
    );
  });
}

/** 按镜头种类挑一个排版分支；返回 `false` 表示这一种还没实现（调用方走兜底）。 */
export function applySonnetFlowLayout(
  kind: SonnetShotKind,
  ctx: SonnetFlowContext,
  variants: SonnetFlowVariants,
  secondaryHeroIndex: number,
): boolean {
  switch (kind) {
    case 'type-impact':
    case 'mask-reveal':
      layoutCrossStack(ctx);
      return true;
    case 'tracking-ribbon':
      layoutTrackingRibbon(ctx, variants.ribbon);
      return true;
    case 'quiet-tableau':
      layoutQuietTableau(ctx, variants.tableau);
      return true;
    case 'fragment-collage':
      /*
       * ⚠ **按主人要求偏离上游**：上游这一档是"极坐标环、故意保持混乱观感"
       * （`sonnetShotFlowLayouts.ts:371` 的原文注释 "keeps its chaotic look"），
       * 主人明确要求"在 sonnet 中应该按一定顺序构成一句台词"⇒ 这里改用**按时间/段序横排**的
       * `layoutTrackingRibbon`：段落顺序 = 阅读顺序，从左到右依次落位，拥挤时纵向错行。
       * 保留原有的字号层次、装饰关系与逐字入场，只改"摆在哪"。
       * 这条偏离记进 `docs/CREDITS.md`，**不要当成 bug 改回环状**。
       */
      layoutTrackingRibbon(ctx, variants.ribbon);
      return true;
    case 'editorial-column':
      layoutEditorialColumn(ctx, variants.editorial, secondaryHeroIndex);
      return true;
    case 'poster-blocks': {
      /*
       * 海报方块那一族（`sonnetPosterBlocksLayout.ts`）。
       *
       * 三个入参的来处说明：
       *  · `ctx.width/height` 就是画面尺寸；
       *  · **基准字号**我们从主角盒子的高度反推（`measuredHeight / 1.2`，1.2 是行高倍率）——
       *    上下文里没有单独的基准字号字段，链条是"基准字号 × 主角倍率 → 量出的高"，反推足够稳；
       *  · **种子**用我们已有的四个变体数拼一个（确定性、且每镜不同）：取向与缩放档由它决定。
       */
      const hero = ctx.boxes[ctx.heroIndex];
      const baseFontSize = hero === undefined ? 48 : Math.max(24, hero.measuredHeight / 1.2);
      const seed = variants.editorial * 12 + variants.ribbon * 4 + variants.tableau * 3 + variants.collage;
      layoutSonnetPosterBlocks(ctx.boxes, ctx.width, ctx.height, baseFontSize, seed);
      return true;
    }
    default:
      return false;
  }
}
