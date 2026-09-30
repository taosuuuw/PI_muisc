/**
 * 「歌曲队列拼贴」的纯几何（`components/SongCollage.tsx` 的算法部分，用户 m04663 第十三轮第 7 条）。
 *
 * 单独放一个文件是为了能脱开 DOM 单测（`src/lib/collage-layout.test.ts`）：
 * 组件里只留事件、Ref 和渲染。
 *
 * 世界观与 folia 的 Lattice（`src/components/app/lattice/layout.ts`）说清区别：
 *   - folia 是**无界**周期格子 + 相机 + 视口裁剪，同一首歌会在屏幕上重复出现很多次，
 *     所以它的 `queueIndex` 是 `cellSlot % totalEntries`（取模回卷，避免每个格子都空同一个洞）；
 *   - 我们这一版是**有界**方格阵（列数固定为铺满一屏所需的列数），相机被夹在世界边界里，
 *     拖到头就停住，不会拖出一片空白；`queueIndex` 同样是取模回卷。
 */

export type CollageMetrics = {
  /** 一格的水平/垂直节距（含缝）。 */
  pitch: number;
  /** 方片贴着格子内缩多少像素（左右各一）。 */
  inset: number;
  /** 中心放大块的内缩（放大块同样要留缝，否则会盖住邻居）。 */
  activeInset: number;
  /** 中心块放大到几倍节距。 */
  activeScale: number;
};

export type CollageCamera = { x: number; y: number };
export type CollageViewport = { width: number; height: number };
export type CollageCell = { col: number; row: number };

/**
 * 渲染层要用的一块（组件里由 `items` useMemo 生成）。
 * 泛型 T 默认 `unknown`：组件里写 `CollageItem<Song>` 拿到真类型，
 * 而这一层不必反向依赖 `@pi/shared`。
 */
export type CollageItem<T = unknown> = {
  key: string;
  cell: CollageCell;
  /** 这一格唱的是队列里第几首（超出歌数就取模回卷）。 */
  queueIndex: number;
  song: T;
  x: number;
  y: number;
  size: number;
};

/** 一块的基准节距：136 = 128 封面 + 8 缝（与 folia 的 `CELL_SIZE = 128 / GAP = 8` 同口径）。 */
export const BASE_PITCH = 136;
export const BASE_INSET = 6;
/** 中心块横向占约 2.4 格，对齐参考图里「比邻居宽一圈、但没到 3 格」的比例。 */
export const ACTIVE_SCALE = 2.4;
/** 一屏最多画多少块（folia：`MAX_RENDERED_INSTANCES = 400`，这里的世界有界，取相近值）。 */
export const MAX_ITEMS = 420;
/** 视口外多铺这么多像素的块，避免快速拖动时露白边（folia 用 500，我们世界有界可以小些）。 */
export const OVERSCAN = 220;

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** 负数也能正确回卷（`-1 % 7 === -1`，所以要先加一次模）。 */
export const wrap = (value: number, mod: number): number => ((value % mod) + mod) % mod;

/**
 * 朝向哈希：决定每一格是「竖」还是「横」。
 * 抄 folia 的整数混洗（`Math.imul` + xorshift 收尾），一行就够、无状态、同坐标必得同结果。
 */
export const hashCoords = (col: number, row: number): number => {
  let value = Math.imul(col, 0x9e3779b1) ^ Math.imul(row, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  value ^= value >>> 12;
  return value >>> 0;
};

/** 0 = 竖（码位左序），1 = 横（码位在上）。 */
export const orientationOf = (col: number, row: number): number => hashCoords(col, row) % 2;

/** 一个方片的边长（未乘以任何缩放）。 */
export const sizeOf = (
  col: number,
  row: number,
  metrics: CollageMetrics,
  active: boolean,
): number => {
  if (active) return metrics.pitch * metrics.activeScale - metrics.activeInset * 2;
  // 横块稍微收窄一点，让长宽有区别；数值取缝的一半。
  return metrics.pitch - metrics.inset * 2 - (orientationOf(col, row) === 1 ? 6 : 0);
};

export const metricsFor = (pitch: number): CollageMetrics => ({
  pitch,
  inset: pitch * (BASE_INSET / BASE_PITCH),
  // 放大块也按同样的缝内缩，保证它和邻居之间仍然看得见缝。
  activeInset: pitch * (BASE_INSET / BASE_PITCH),
  activeScale: ACTIVE_SCALE,
});

/** 响应式档位：窄窗用小格子，免得一屏只剩两三块。 */
export const metricsOf = (width: number): CollageMetrics =>
  metricsFor(width < 700 ? 104 : width < 1100 ? 120 : BASE_PITCH);

/**
 * 视口 + 歌数 → 世界的列/行数（世界尺寸 = 列数 × 节距）。
 * 列数固定为「铺满一屏还多一格」，行数取「铺满一屏」与「装下所有歌」的较大者——
 * 于是无论 1 首还是 1000 首，任何相机位置都看不到空白。
 */
export const geometryFor = (
  viewport: CollageViewport,
  count: number,
  metrics: CollageMetrics,
): { columns: number; rows: number; worldWidth: number; worldHeight: number } => {
  const { pitch } = metrics;
  const fitColumns = Math.max(1, Math.ceil((viewport.width + pitch) / pitch));
  const fitRows = Math.max(1, Math.ceil((viewport.height + pitch) / pitch));
  const rows = Math.max(fitRows, Math.max(1, Math.ceil(count / fitColumns)));
  return {
    columns: fitColumns,
    rows,
    worldWidth: fitColumns * pitch,
    worldHeight: rows * pitch,
  };
};

/**
 * 把相机夹进 `[worldSize - viewport, 0]`：世界比视口小就居中，比视口大就两头都到头即止。
 * 这是「拖不出空白」的全部实现。
 *
 * 注意两种情形要分开返回，不能先算居中再统一 clamp：世界比视口小时
 * `minX = viewport.width - world.worldWidth` 是**正数**，`clamp(居中值, 正数, 0)` 的
 * 上下界是反的，会把值压成 0（左下角），结果四周露白。
 */
export const clampCamera = (
  camera: CollageCamera,
  viewport: CollageViewport,
  world: { worldWidth: number; worldHeight: number },
): CollageCamera => ({
  x:
    world.worldWidth <= viewport.width
      ? (viewport.width - world.worldWidth) / 2
      : clamp(camera.x, viewport.width - world.worldWidth, 0),
  y:
    world.worldHeight <= viewport.height
      ? (viewport.height - world.worldHeight) / 2
      : clamp(camera.y, viewport.height - world.worldHeight, 0),
});

/** 视口中心落在哪一格。这就是被放大高亮的那一块，也是右侧信息的主人。 */
export const centerCellOf = (
  camera: CollageCamera,
  viewport: CollageViewport,
  world: { columns: number; rows: number },
  metrics: CollageMetrics,
): CollageCell => ({
  col: clamp(Math.floor((viewport.width / 2 - camera.x) / metrics.pitch), 0, Math.max(0, world.columns - 1)),
  row: clamp(Math.floor((viewport.height / 2 - camera.y) / metrics.pitch), 0, Math.max(0, world.rows - 1)),
});

/** 格子坐标 → 当前队列里的第几首（取模回卷：歌比格子少时循环铺满，不留洞）。 */
export const queueIndexAt = (col: number, row: number, columns: number, total: number): number =>
  total <= 0 ? 0 : wrap(row * columns + col, total);
