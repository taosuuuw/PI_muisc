/**
 * 商籁（sonnet）**海报方块**那一族的排版：PV 风格的"分区流"。
 *
 * 来源：`chthollyphile/folia-major@main` 的
 * `src/components/visualizer/sonnet/sonnetPosterBlocksLayout.ts`（AGPL-3.0）。
 * 主人把这份正文提供给我们，本轮按它**逐条移植**（数值、判断顺序、退化路径全部照抄，
 * 代码按本仓库风格重写；参见 `docs/CREDITS.md`）。
 *
 * 一句话概括原版的做法：**主角/次主角各自独占一块"地盘"（zone），其余陪衬按严格阅读顺序
 * 填在地盘之间的空隙里** —— 所以构图看着大小悬殊、很乱，但视线**永远不会被折回去**。
 *
 * 我们这版与上游的结构一一对应：
 *   · `partitionSonnetPosterItems` = 上游 `partitionFlowItems`（切 zone 与 group）；
 *   · `toScreen` = 上游 `flowToScreen`（流空间 → 屏幕，竖排时列**从右往左**）；
 *   · `attemptFlowLayout` = 上游同名函数（按给定全局缩放摆一遍，**溢出也照返**，
 *     好让调用方换挡或紧急等比缩 —— 绝不能让盒子留在原点）；
 *   · `layoutSonnetPosterBlocks` = 上游同名导出（画布、间距、取向、适配阶梯、居中、回填盒子）。
 */

/** 待摆放的块：尺寸与角色由帧层量好填进来。 */
export interface SonnetPosterBlockBox {
  isHero: boolean;
  isSemiHero: boolean;
  /** 显示文本（竖排时可能被换成 `verticalDisplayText`）。**可选**：帧层的盒子没有它。 */
  displayText?: string;
  /** 竖排专用显示文本（上游字段）。 */
  verticalDisplayText?: string;
  /** 竖排时"竖着量"的宽高与字号（上游字段；三个都给全了才会换成竖排尺寸）。 */
  verticalMeasuredWidth?: number;
  verticalMeasuredHeight?: number;
  verticalFontScale?: number;
  fontScale: number;
  measuredWidth: number;
  measuredHeight: number;
  x: number;
  y: number;
  rotation: number;
  vertical: boolean;
  layoutDirection: 'horizontal' | 'vertical';
  enterX: number;
  enterY: number;
}

export interface SonnetPosterBlocksPlan<T extends SonnetPosterBlockBox> {
  placements: T[];
  width: number;
  height: number;
  gap: number;
}

type FlowOrientation = 'horizontal' | 'vertical';

/** 分区项：主角/次主角是 `zone`，中间的连续陪衬合成一个 `group`。 */
type FlowItem<T extends SonnetPosterBlockBox> = { kind: 'zone'; zone: T } | { kind: 'group'; group: T[] };

/** 流空间里的一个矩形：`u` 是阅读方向、`v` 是折行方向。 */
interface FlowRect {
  u: number;
  v: number;
  uSize: number;
  vSize: number;
}

interface FlowPlacement<T extends SonnetPosterBlockBox> {
  box: T;
  rect: FlowRect;
  scale: number;
  vertical: boolean;
}

/**
 * **紧跟陪衬组的 zone 会占住它跨过那几行的"行首侧"**：
 * 后面的陪衬要绕到它旁边（`extent` 是它占的横向宽度，`vBottom` 是它管到哪一行）。
 */
interface ZoneFloat {
  extent: number;
  vBottom: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 把阅读序列切成"强调块（zone）"与"陪衬串（group）"（= 上游 `partitionFlowItems`）。 */
const partitionSonnetPosterItems = <T extends SonnetPosterBlockBox>(boxes: T[]): FlowItem<T>[] => {
  const items: FlowItem<T>[] = [];
  let group: T[] = [];
  boxes.forEach((box) => {
    if (box.isHero || box.isSemiHero) {
      if (group.length > 0) items.push({ kind: 'group', group });
      group = [];
      items.push({ kind: 'zone', zone: box });
      return;
    }
    group.push(box);
  });
  if (group.length > 0) items.push({ kind: 'group', group });
  return items;
};

interface FlowSpace {
  orientation: FlowOrientation;
  u: number;
  v: number;
}

/**
 * 流空间矩形 → 屏幕矩形（= 上游 `flowToScreen`）。
 * 竖排变体里**列从右往左推进**，与传统日文排版一致。
 */
const flowToScreen = (
  space: FlowSpace,
  rect: FlowRect,
  canvas: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } => {
  if (space.orientation === 'horizontal') {
    return { x: canvas.x + rect.u, y: canvas.y + rect.v, width: rect.uSize, height: rect.vSize };
  }
  return {
    x: canvas.x + canvas.width - rect.v - rect.vSize,
    y: canvas.y + rect.u,
    width: rect.vSize,
    height: rect.uSize,
  };
};

interface FlowAttempt<T extends SonnetPosterBlockBox> {
  placements: FlowPlacement<T>[];
  vTotal: number;
}

/**
 * 按给定的全局缩放摆**一整遍**（= 上游 `attemptFlowLayout`）。
 *
 * 注意：**溢出也照样把 attempt 返回**（不抛错、不留空位）—— 调用方拿 `vTotal` 决定换下一档，
 * 全档都装不下时再对这次的矩形做紧急等比缩。这样"盒子留在原点"这件事在校验上是不可达的。
 */
const attemptFlowLayout = <T extends SonnetPosterBlockBox>(
  boxes: T[],
  space: FlowSpace,
  globalScale: number,
  chipGap: number,
  lineGap: number,
  seed: number,
): FlowAttempt<T> => {
  const items = partitionSonnetPosterItems(boxes);
  const placements: FlowPlacement<T>[] = [];
  const floats: ZoneFloat[] = [];
  let vCursor = 0;
  /** 没有紧跟陪衬的 zone 会轮流贴"行首侧 / 行尾侧"（由种子的第 2 位决定起点）。 */
  let ownBandOnEndSide = ((seed >> 1) & 1) === 1;

  /**
   * 量一块：**只有"竖排 + 三个竖排字段都给全了"才改用竖排尺寸**（= 上游 `measure`），
   * 否则一律用横排尺寸与 `fontScale`。
   */
  const measure = (box: T): { useVertical: boolean; baseScale: number; width: number; height: number } => {
    const useVertical =
      space.orientation === 'vertical' &&
      typeof box.verticalMeasuredWidth === 'number' &&
      typeof box.verticalMeasuredHeight === 'number' &&
      typeof box.verticalFontScale === 'number';
    const baseScale = useVertical ? (box.verticalFontScale as number) : box.fontScale;
    const width = (useVertical ? (box.verticalMeasuredWidth as number) : box.measuredWidth) * globalScale;
    const height = (useVertical ? (box.verticalMeasuredHeight as number) : box.measuredHeight) * globalScale;
    return { useVertical, baseScale, width, height };
  };
  /** 屏幕宽高 → 流空间尺寸：竖排时两轴互换。 */
  const toFlowSize = (width: number, height: number): { uSize: number; vSize: number } =>
    space.orientation === 'horizontal' ? { uSize: width, vSize: height } : { uSize: height, vSize: width };

  /** 已经过期（管不到当前行）的占位丢掉。 */
  const pruneFloats = (): void => {
    for (let index = floats.length - 1; index >= 0; index -= 1) {
      const entry = floats[index];
      if (entry !== undefined && entry.vBottom <= vCursor) floats.splice(index, 1);
    }
  };

  items.forEach((item, itemIndex) => {
    pruneFloats();

    if (item.kind === 'group') {
      const group = item.group;
      /*
       * **陪衬组**：可用宽度要扣掉还活着的占位（zone 占住的行首侧），
       * 然后贪心折行，再对每行做**两端对齐**（`spread` 上限 `chipGap × 2.5`）——
       * 这样陪衬是"铺满一带"而不是挤在一侧。
       */
      const reservedU = floats.reduce((sum, entry) => sum + entry.extent, 0);
      const capacity = Math.max(chipGap * 2, space.u - reservedU);
      const uStart = reservedU;
      const chips = group.map((box) => {
        const dims = measure(box);
        const flow = toFlowSize(dims.width, dims.height);
        return { box, dims, uSize: flow.uSize, vSize: flow.vSize, shrink: 1 };
      });

      let line: typeof chips = [];
      let lineUsedU = 0;
      const flushLine = (): void => {
        if (line.length === 0) return;
        const lineV = Math.max(...line.map((chip) => chip.vSize * chip.shrink));
        const leftover = capacity - lineUsedU;
        const spread =
          line.length > 1 && leftover > 0 ? Math.min(leftover / (line.length - 1), chipGap * 2.5) : 0;
        let uCursor = uStart;
        line.forEach((chip) => {
          const finalScale = chip.dims.baseScale * globalScale * chip.shrink;
          placements.push({
            box: chip.box,
            rect: {
              u: uCursor,
              v: vCursor,
              uSize: chip.uSize * chip.shrink,
              vSize: chip.vSize * chip.shrink,
            },
            scale: finalScale,
            vertical: chip.dims.useVertical,
          });
          uCursor += chip.uSize * chip.shrink + chipGap + spread;
        });
        vCursor += lineV + lineGap;
        pruneFloats();
        line = [];
        lineUsedU = 0;
      };

      chips.forEach((chip) => {
        const needed = lineUsedU + (line.length > 0 ? chipGap : 0) + chip.uSize;
        if (needed > capacity && line.length > 0) flushLine();
        if (chip.uSize > capacity) {
          // 单块就超宽：**不折行**，缩到 `max(0.5, 容量/宽)` 硬塞进这一带（照抄上游）。
          chip.shrink = Math.max(0.5, capacity / chip.uSize);
          lineUsedU = 0;
          line.push(chip);
          flushLine();
          return;
        }
        lineUsedU += (line.length > 0 ? chipGap : 0) + chip.uSize;
        line.push(chip);
      });
      flushLine();
      return;
    }

    // —— zone（主角 / 次主角）——
    const zone = item.zone;
    // 不许压到之前 zone 的占位跨度上。
    vCursor = Math.max(vCursor, ...floats.map((entry) => entry.vBottom), 0);
    floats.length = 0;

    const dims = measure(zone);
    const flow = toFlowSize(dims.width, dims.height);
    const followedByGroup = items[itemIndex + 1]?.kind === 'group';
    /**
     * zone 自己的缩放：跟着陪衬组时只敢用 62% 宽、否则 90% 宽；高度上限一律 66%。
     * （照抄上游 `zoneShrink`。）
     */
    const zoneShrink = Math.min(
      1,
      (space.u * (followedByGroup ? 0.62 : 0.9)) / flow.uSize,
      (space.v * 0.66) / flow.vSize,
    );
    const uSize = flow.uSize * zoneShrink;
    const vSize = flow.vSize * zoneShrink;
    const onlyZone = items.length === 1;
    const u = onlyZone
      ? (space.u - uSize) / 2
      : followedByGroup
        ? 0
        : ownBandOnEndSide
          ? space.u - uSize
          : 0;
    placements.push({
      box: zone,
      rect: { u, v: vCursor, uSize, vSize },
      scale: dims.baseScale * globalScale * zoneShrink,
      vertical: dims.useVertical,
    });
    if (followedByGroup) {
      // 占住行首侧（`vBottom` 多留一个 `lineGap`），**自己不动 `vCursor`** —— 让陪衬绕上来。
      floats.push({ extent: uSize + chipGap, vBottom: vCursor + vSize + lineGap });
    } else {
      vCursor += vSize + lineGap;
      ownBandOnEndSide = !ownBandOnEndSide;
    }
  });

  const vTotal = placements.reduce(
    (max, placement) => Math.max(max, placement.rect.v + placement.rect.vSize),
    0,
  );
  return { placements, vTotal };
};

/**
 * 海报方块排版（对外入口，= 上游 `layoutSonnetPosterBlocks`）。
 *
 * 画布 `x = −宽×0.42`、`y = −高×0.40`、`宽 = 宽×0.84`、`高 = 高×0.80`：
 * 海报镜头最大变焦约 1.18 倍，这个框仍然留在舞台内；同时它又够大，
 * 让兜底构图的字号不至于小到看不清（上游注释原意）。
 */
export function layoutSonnetPosterBlocks<T extends SonnetPosterBlockBox>(
  boxes: T[],
  width: number,
  height: number,
  baseFontSize: number,
  seed = 0,
): SonnetPosterBlocksPlan<T> {
  if (boxes.length === 0) return { placements: [], width: 0, height: 0, gap: 0 };

  const gap = clamp(baseFontSize * 0.35, 16, 40);
  const chipGap = gap;
  const lineGap = gap * 1.15;
  const canvas = { x: -width * 0.42, y: -height * 0.4, width: width * 0.84, height: height * 0.8 };
  const orientation: FlowOrientation = seed % 2 === 0 ? 'horizontal' : 'vertical';
  /*
   * 流空间的 u 是**阅读方向**（横排 = 屏幕 x、竖排 = 屏幕 y），v 是**堆叠方向**；
   * 竖排时容量两轴互换。
   */
  const space: FlowSpace =
    orientation === 'horizontal'
      ? { orientation, u: canvas.width, v: canvas.height }
      : { orientation, u: canvas.height, v: canvas.width };

  // 陪衬**永不放大**（只在整组重试时缩小）：先按 1 试，装不下再逐档缩。
  let attempt = attemptFlowLayout(boxes, space, 1, chipGap, lineGap, seed);
  for (const globalScale of [0.92, 0.84, 0.76, 0.68, 0.6, 0.52]) {
    if (attempt.vTotal <= space.v + 0.5) break;
    attempt = attemptFlowLayout(boxes, space, globalScale, chipGap, lineGap, seed);
  }
  // 紧急等比缩：阶梯全用尽还溢出，就把整个构图缩进画布 —— 而不是把盒子留在原点。
  if (attempt.vTotal > space.v) {
    const fitScale = space.v / attempt.vTotal;
    attempt.placements.forEach((placement) => {
      placement.rect.u *= fitScale;
      placement.rect.v *= fitScale;
      placement.rect.uSize *= fitScale;
      placement.rect.vSize *= fitScale;
      placement.scale *= fitScale;
    });
    attempt.vTotal = space.v;
  }

  // 整组在 v 方向居中（装得下就居中，装不下则为 0）。
  const vShift = Math.max(0, (space.v - attempt.vTotal) / 2);
  attempt.placements.forEach((placement) => {
    const box = placement.box;
    const rect: FlowRect = { ...placement.rect, v: placement.rect.v + vShift };
    const screen = flowToScreen(space, rect, canvas);
    box.fontScale = placement.scale;
    box.measuredWidth = screen.width;
    box.measuredHeight = screen.height;
    box.x = screen.x + screen.width / 2;
    box.y = screen.y + screen.height / 2;
    box.rotation = 0;
    box.vertical = placement.vertical;
    // 竖排且有专用文本时换成它（照抄上游）。
    if (placement.vertical && box.verticalDisplayText) box.displayText = box.verticalDisplayText;
    box.layoutDirection = orientation === 'vertical' ? 'vertical' : 'horizontal';
    if (orientation === 'horizontal') {
      box.enterX = (screen.x + screen.width / 2 < 0 ? -1 : 1) * Math.min(28, baseFontSize * 0.45);
      box.enterY = Math.min(18, baseFontSize * 0.25);
    } else {
      box.enterX = Math.min(18, baseFontSize * 0.25);
      box.enterY = (screen.y + screen.height / 2 < 0 ? -1 : 1) * Math.min(28, baseFontSize * 0.45);
    }
  });

  return { placements: boxes, width: canvas.width, height: canvas.height, gap };
}
