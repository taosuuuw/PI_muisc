/**
 * 「歌曲拼贴」的纯几何（`components/SongCollage.tsx` 的算法部分，用户第十四轮第 2 条；
 * 第十五轮第 1 条补上 3D 俯仰、块内重排、点击放大与镜头跟随）。
 *
 * 这一版按 folia-major `src/components/app/lattice/`（Lattice 海报墙）的**结论**重写：
 *   - 布局既不是等分 grid 也不是 masonry，而是「12 列 × 8 行 = 一个块（block），块内 12 个手工槽位」；
 *     4 套模板 × 4 种镜像 = 16 种朝向，朝向由块坐标做整数混洗选出，整面墙没有可见周期；
 *   - 同一块里槽位宽高不同（2×3、3×3、6×3、2×2 都有），这正是「形似」与「等大方格」的关键差别；
 *   - 节距 136 = 128（`CELL_SIZE`）+ 8（`GAP`），卡片尺寸 = 槽位跨格 × 节距 − 缝（folia 原文口径）；
 *   - 世界是**有界**的：folia 的 cell 无界重复，我们按歌数算出一块阵、再补足一屏，
 *     相机夹在世界边界内，拖到头就停（拖不出一片空白）。
 *
 * 有意与 folia 不同的四处（都不是笔误）：
 *   ① 槽位表是我们自己排的（同样 12 槽、同样正好铺满 12×8、同样混入 2×2/3×3/6×3），
 *      但**行跨格上限取 3**（folia 有 4）。原因：`apps/desktop` 的冒烟探针断言
 *      「中心块 min(宽,高) × 1.8 ≤ 普通块」，而放大块固定 6×6 = 808px；
 *      普通块最高 3 格 = 400px，于是倍数恒为 2.02，**与探针量到哪一块无关**。
 *      若行跨格放到 4（536px），倍数会掉到 1.51，探针必挂。
 *   ② 相机只有平移 + 定档缩放（folia 的相机还带缓存/预留视口，见其 `useWallCameraPan`），
 *      因为我们的世界有界，不需要为「远端空白」预留。
 *   ③ **块内重排**（第十五轮第 1 条）：folia 的展开会把同一块里其余 11 张重新「换挡」以仍然
 *      铺满 12×8，靠的是 `blockReflows.ts` 那份 29 KB / 16×12 张的**预计算表**——参考笔记
 *      明确写了「未读」，我们也不重算它。这里改成自己推的一条算法（`blockLayoutOf`）：
 *      放大块固定 6×6（folia `EXPANSION_SPAN`，它注释里说这是「唯一一个每个 slot 都有精确
 *      re-cover 的尺寸」），**锚在离它自己最近的块角**（x ∈ {0,6}、y ∈ {0,2}）；块内剩下的
 *      96 − 36 = 60 格正好拆成两条矩形带：6×8（48 格）+ 6×2（12 格），其余 11 张按 9 + 2 分进去，
 *      每条带再用「横向搁板」把宽度均分掉（`planShelfBand`）。因为每条带的宽度之和恒等于带宽、
 *      高度之和恒等于带高，所以**重排后整块 12×8 仍然精确满铺**（单测穷举 16 朝向 × 12 槽位验证：
 *      无重叠、无空洞），邻居是真的被挤小、而不是被盖住。
 *   ④ **3D 俯仰**（`COLLAGE_PERSPECTIVE_PX` / `COLLAGE_PITCH_DEG` / `COLLAGE_YAW_DEG`）：
 *      参考笔记 §3.4 / §6 把 folia 的 Lattice 相机记得很清楚——只有
 *      `translate3d(x,y,0) scale(s)`，**没有任何 perspective / rotateX / rotateY 数值**；
 *      笔记里唯一带 3D 的是另一个页面 `Grid3D.tsx`，而它被标注为「未读」。
 *      所以这三个数是**我们自己定的**，不是从 folia 抄的：
 *        · `perspective: 1400px` + `rotateX(3.4°) rotateY(−2.6°)`，绕**视口中心**旋转，
 *          不是绕世界原点（绕世界原点会让上千米外的边甩出屏幕，且剔除边界要重算）；
 *        · 为什么是这三个数：1920×1080 的窗口上，离视口中心最远的那个屏幕角最多后退
 *          `960·sin 2.6° + 540·sin 3.4° ≈ 75.6px`，透视缩放 `1400 / (1400 + 75.6) ≈ 0.949` ——
 *          也就是**最多约 5% 的透视压缩**，足够读出一面「斜着立起来的墙」，又不至于把字压变形；
 *          俯仰比偏航大一档（3.4° > 2.6°）是为了读成「往后仰 + 略微侧转」，
 *          而不是一个对称的机关。世界居中后左右各多出 ≥ `PAN_MARGIN_X/2` = 240px、
 *          上下各多出 ≥ `PAN_MARGIN_Y/2` = 180px，这点透视收边绝不会露出世界之外。
 *
 * 这些常量全部来自 folia 原文（`PosterWall.tsx` / `layout.ts` / `LatticePoster.tsx`），
 * 算法实现是自己的；没有任何一行是从 AGPL 仓库抄过来的代码。
 *
 * 第十六轮第 4 条新增的纯几何（都在本文件末尾/`queueIndexOf` 附近，用户 m00001 第 4 条）：
 *   - `slotRefOfQueueIndex`：`queueIndexOf` 的反向（队列第 i 首 → 它的第一遍槽位），
 *     给「点底栏定位到正在播放的那一格」用，唯一解、与镜头先后无关；
 *   - `builtCellCountOf` / `contentBoundsOf` / `isNearContentEdge`：世界里的格子总数、
 *     `total` 首歌真正占到的内容边界、以及「镜头是否已经贴到内容边」（增量加载的判据，
 *     判的是**内容边**而不是世界边界，因为世界边界外多半是取模回卷出来的重复格）；
 *   - `viewportFillTransform` / `collageCellExitTransform`：把「现在占着某块屏幕矩形」的盒子
 *     放大到铺满整屏的 transform（前者给独立的克隆/覆盖层，后者直接给拼贴格——要除掉世界层的
 *     定档缩放）。`COLLAGE_FILL_MS` 是配套时长，与 CSS 里 `.pi-collage__item--exiting` 一致。
 */

export type CollageCamera = { x: number; y: number };
export type CollageViewport = { width: number; height: number };
export type CollageSlotRect = { x: number; y: number; width: number; height: number };

/** 块内槽位：`x/y/cols/rows` 的单位都是 128px 的格子（folia 的 `BlockSlot` 同口径）。 */
export type CollageSlot = { x: number; y: number; cols: number; rows: number };

/** 一块卡的坐标：第几块 + 块内第几个槽位。 */
export type CollageSlotRef = { blockCol: number; blockRow: number; slotIndex: number };

/** folia `PosterWall.tsx`：`CELL_SIZE = 128` / `GAP = 8`。 */
export const COLLAGE_CELL_SIZE = 128;
export const COLLAGE_GAP = 8;
export const COLLAGE_PITCH = COLLAGE_CELL_SIZE + COLLAGE_GAP;

/** folia `blockTemplates.ts`：一个块 12 列 × 8 行，正好 12 个槽位。 */
export const BLOCK_COLS = 12;
export const BLOCK_ROWS = 8;
export const SLOTS_PER_BLOCK = 12;

/** folia `EXPANSION_SPAN`（展开跨度）与推导出的展开边长 808 = 6×136 − 8。 */
export const EXPANSION_COLS = 6;
export const EXPANSION_ROWS = 6;
export const EXPANSION_SIZE = EXPANSION_COLS * COLLAGE_PITCH - COLLAGE_GAP;

/** folia `layout.ts`：`FIELD_ASPECT = 2.2` / `MAX_RENDERED_INSTANCES = 400` / 剔除 `OVERSCAN = 500`。 */
export const FIELD_ASPECT = 2.2;
export const MAX_RENDERED_SLOTS = 400;
export const OVERSCAN = 500;

/**
 * 世界至少要比视口大出这么多**屏幕**像素（居中后两侧各一半）。
 * 不留余量的话，「世界刚好一屏」会让相机一像素都拖不动——拖拽就成了摆设
 * （`clampCamera` 会把位移全吃掉）；`apps/desktop` 的冒烟探针也会合成一次
 * −120/−90 的拖动并断言中心块真的挪了 ≥40px。480×360 意味着水平各 240px、垂直各 180px。
 */
export const PAN_MARGIN_X = 480;
export const PAN_MARGIN_Y = 360;

/** folia `PosterWall.tsx` 的初始相机种子（我们只借它的量级，实际首帧会居中再夹进世界）。 */
export const CAMERA_SEED = { x: 34, y: 80 } as const;

/** folia 的入场波：`ENTRANCE_STAGGER 0.03` / `ENTRANCE_MAX_DELAY 0.34` / `ENTRANCE_LIFT 90`。 */
export const ENTRANCE_STAGGER = 0.03;
export const ENTRANCE_MAX_DELAY = 0.34;
export const ENTRANCE_WINDOW_MS = 1100;
export const ENTRANCE_LIFT = 90;

/**
 * 第十五轮第 1 条的「3D 俯仰」。三个数都是我们定的（理由见本文件顶部说明④）：
 * folia 的 Lattice 相机在参考笔记里只有 `translate3d + scale`，没有任何透视/旋转数值。
 *   透视距离 `1400px`：1920×1080 上最远的屏幕角最多后退 `(960·sin 2.6° + 540·sin 3.4°) ≈ 76px`，
 *   于是透视缩放落在 `1400/(1400±76)`，也就是 `0.949 ~ 1.057`——最坏约 5% 的收/放。
 *   俯仰 `3.4°`（rotateX，正角 = 墙顶向观察者倾）+ 偏航 `−2.6°`（rotateY，负角 = 墙左侧略微转远）。
 */
export const COLLAGE_PERSPECTIVE_PX = 1400;
export const COLLAGE_PITCH_DEG = 3.4;
export const COLLAGE_YAW_DEG = -2.6;

/**
 * 点击某一格放大后，相机平滑移到那一格所用的时长（毫秒）。
 * 460ms 配 `easeOutCubic`：起步明显、收尾很软，落在「能看出是移动」而不是「瞬移」的区间里。
 */
export const COLLAGE_FOLLOW_MS = 460;

/**
 * 第十六轮第 4 条(b)：点击「正在播放 + 已放大」的那一格进入播放页时，
 * 那一格「长大到铺满整屏」的动画时长（毫秒）。
 * 与 `song-collage.css` 里 `.pi-collage__item--exiting` 的 `transition` 时长**必须一致**
 * （CSS 读不到 TS 常量，所以两边各写一遍并在这里互相点名）。
 * 480ms 配 `cubic-bezier(0.22, 0.9, 0.24, 1)`：起步吃得住眼睛、收尾完全停稳，
 * 刚好比镜头跟随（460ms）长一点点，读起来像「镜头先到、卡片随后把屏幕填满」。
 */
export const COLLAGE_FILL_MS = 480;

/**
 * 第十六轮第 4 条(c)：镜头离「已建内容的边」还剩不到 `0.75` 个块时就认为该加载下一批。
 * 一个块在屏幕上 ≈ 1632×1088×0.76 ≈ 1240×827px，0.75 块 ≈ 620px 的提前量：
 * 用户还在看最后一批歌的时候下一批就已经在墙上了，不会拖到头才「咯噔」长出来。
 */
export const NEAR_EDGE_MARGIN_RATIO = 0.75;

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** folia `PosterWall.tsx`：`getScale = width < 640 ? 0.52 : width < 1100 ? 0.64 : 0.76`。 */
export const cameraScaleFor = (width: number): number => (width < 640 ? 0.52 : width < 1100 ? 0.64 : 0.76);

/**
 * 四套手工模板，每套 12 个槽位、正好铺满 12×8、无重叠无空洞（见本文件顶部的说明①）。
 * 槽位顺序 = 队列顺序：同一块里第 i 个槽位唱队列里的第 i 首（取模回卷）。
 */
const TEMPLATES: readonly (readonly CollageSlot[])[] = [
  // 变体 0：上排三块（3×3 / 6×3 / 3×3），中排四块，下排六块 2×2。
  [
    { x: 0, y: 0, cols: 3, rows: 3 },
    { x: 3, y: 0, cols: 6, rows: 3 },
    { x: 9, y: 0, cols: 3, rows: 3 },
    { x: 0, y: 3, cols: 3, rows: 3 },
    { x: 3, y: 3, cols: 4, rows: 3 },
    { x: 7, y: 3, cols: 2, rows: 3 },
    { x: 9, y: 3, cols: 3, rows: 3 },
    { x: 0, y: 6, cols: 3, rows: 2 },
    { x: 3, y: 6, cols: 2, rows: 2 },
    { x: 5, y: 6, cols: 2, rows: 2 },
    { x: 7, y: 6, cols: 2, rows: 2 },
    { x: 9, y: 6, cols: 3, rows: 2 },
  ],
  // 变体 1：竖条起手，中段一块 6×3 大横片，底部三条 3×2 + 三个 2×2。
  [
    { x: 0, y: 0, cols: 2, rows: 3 },
    { x: 2, y: 0, cols: 2, rows: 3 },
    { x: 4, y: 0, cols: 6, rows: 3 },
    { x: 10, y: 0, cols: 2, rows: 3 },
    { x: 0, y: 3, cols: 4, rows: 3 },
    { x: 4, y: 3, cols: 6, rows: 3 },
    { x: 10, y: 3, cols: 2, rows: 3 },
    { x: 0, y: 6, cols: 3, rows: 2 },
    { x: 3, y: 6, cols: 3, rows: 2 },
    { x: 6, y: 6, cols: 2, rows: 2 },
    { x: 8, y: 6, cols: 2, rows: 2 },
    { x: 10, y: 6, cols: 2, rows: 2 },
  ],
  // 变体 2：4×3 大横片压在左下，右下一条 6×3，底排 4×2 + 四个 2×2。
  [
    { x: 0, y: 0, cols: 3, rows: 3 },
    { x: 3, y: 0, cols: 3, rows: 3 },
    { x: 6, y: 0, cols: 4, rows: 3 },
    { x: 10, y: 0, cols: 2, rows: 3 },
    { x: 0, y: 3, cols: 4, rows: 3 },
    { x: 4, y: 3, cols: 2, rows: 3 },
    { x: 6, y: 3, cols: 6, rows: 3 },
    { x: 0, y: 6, cols: 4, rows: 2 },
    { x: 4, y: 6, cols: 2, rows: 2 },
    { x: 6, y: 6, cols: 2, rows: 2 },
    { x: 8, y: 6, cols: 2, rows: 2 },
    { x: 10, y: 6, cols: 2, rows: 2 },
  ],
  // 变体 3：两种竖条混排，中排一块 6×3 居中。
  [
    { x: 0, y: 0, cols: 2, rows: 3 },
    { x: 2, y: 0, cols: 3, rows: 3 },
    { x: 5, y: 0, cols: 4, rows: 3 },
    { x: 9, y: 0, cols: 3, rows: 3 },
    { x: 0, y: 3, cols: 3, rows: 3 },
    { x: 3, y: 3, cols: 6, rows: 3 },
    { x: 9, y: 3, cols: 3, rows: 3 },
    { x: 0, y: 6, cols: 2, rows: 2 },
    { x: 2, y: 6, cols: 2, rows: 2 },
    { x: 4, y: 6, cols: 3, rows: 2 },
    { x: 7, y: 6, cols: 3, rows: 2 },
    { x: 10, y: 6, cols: 2, rows: 2 },
  ],
];

/** 镜像：左右翻 / 上下翻 / 双翻；镜像**保持槽位顺序**，所以一首歌在任何朝向下都是同一个位次。 */
const flipX = (slots: readonly CollageSlot[]): CollageSlot[] =>
  slots.map((slot) => ({ ...slot, x: BLOCK_COLS - slot.x - slot.cols }));

const flipY = (slots: readonly CollageSlot[]): CollageSlot[] =>
  slots.map((slot) => ({ ...slot, y: BLOCK_ROWS - slot.y - slot.rows }));

const REFLECTIONS: readonly ((slots: readonly CollageSlot[]) => CollageSlot[])[] = [
  (slots) => slots.slice(),
  flipX,
  flipY,
  (slots) => flipX(flipY(slots)),
];

/** 16 种朝向 = 4 套模板 × 4 种镜像。 */
const ORIENTED_TEMPLATES: readonly (readonly CollageSlot[])[] = TEMPLATES.flatMap((template) =>
  REFLECTIONS.map((reflect) => reflect(template)),
);

export const BLOCK_ORIENTATION_COUNT = ORIENTED_TEMPLATES.length;

/**
 * 整数混洗（`Math.imul` + xorshift 收尾）：同坐标必得同结果、无状态、相邻块几乎不会撞朝向。
 * 手法与 folia `mixBlockCoords` 同类，常数与位移是自己取的。
 */
const mixBlockCoords = (blockCol: number, blockRow: number): number => {
  let value =
    Math.imul(blockCol + 0x2545f491, 0x9e3779b1) ^ Math.imul(blockRow + 0x1b873593, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0x2c1b3c6d);
  value ^= value >>> 16;
  return value >>> 0;
};

/**
 * 朝向 = 模板（线性步进，相邻块必不重复）+ 镜像（哈希，避免整面墙读成周期网格）。
 * 与 folia `getBlockOrientation` 同构。
 */
export const getBlockOrientation = (blockCol: number, blockRow: number): number => {
  const count = TEMPLATES.length;
  const template = (((blockCol + blockRow * 2) % count) + count) % count;
  return template * REFLECTIONS.length + (mixBlockCoords(blockCol, blockRow) % REFLECTIONS.length);
};

export const getBlockSlots = (blockCol: number, blockRow: number): readonly CollageSlot[] =>
  ORIENTED_TEMPLATES[getBlockOrientation(blockCol, blockRow)] ?? ORIENTED_TEMPLATES[0] ?? [];

export const sameSlot = (a: CollageSlotRef | null, b: CollageSlotRef | null): boolean =>
  a !== null && b !== null && a.blockCol === b.blockCol && a.blockRow === b.blockRow && a.slotIndex === b.slotIndex;

export const slotKey = (ref: CollageSlotRef): string => `${ref.blockCol}:${ref.blockRow}:${ref.slotIndex}`;

export const slotWidthOf = (slot: CollageSlot): number => slot.cols * COLLAGE_PITCH - COLLAGE_GAP;
export const slotHeightOf = (slot: CollageSlot): number => slot.rows * COLLAGE_PITCH - COLLAGE_GAP;

// ---------------------------------------------------------------------------
// 第十五轮第 1 条：块内重排（某一格放大时，同块其余格要**让位**，而不是被盖住）
// ---------------------------------------------------------------------------

/**
 * 放大块的锚点：贴住**离它自己最近的那个块角**。
 * 一个块是 12×8、放大块固定 6×6，所以横向只有两个落点（第 0 列或第 6 列），
 * 纵向也只有两个（第 0 行或第 2 行）。取「最近」的理由：放大块自己要挪的距离最小，
 * 读起来更像「那一格自己长开了」，而不是「一张卡凭空跳到角落」。
 */
export const expansionAnchorOf = (slot: CollageSlot): CollageSlot => ({
  x: slot.x + slot.cols / 2 <= BLOCK_COLS / 2 ? 0 : BLOCK_COLS - EXPANSION_COLS,
  y: slot.y + slot.rows / 2 <= BLOCK_ROWS / 2 ? 0 : BLOCK_ROWS - EXPANSION_ROWS,
  cols: EXPANSION_COLS,
  rows: EXPANSION_ROWS,
});

/**
 * 把一条 `width × height`（格）的带*精确*铺满：搁板高度先试 2 格（模板里最小的槽位就是 2 格，
 * 重排后读起来仍是「同一档小片」），2 不整除再退到 1；每条搁板里把宽度均分给若干张卡
 * （`base = floor(width / take)`，余数从左往右各 +1）。
 * 每条搁板的宽度之和恒等于 `width`、高度之和恒等于 `height`，所以只要 `count` 落在
 * `[搁板数, 搁板数 × width]` 之间，结果一定是**精确覆盖**（无洞、无重叠）。
 * 返回 false 表示这组参数铺不下，调用方退回模板原样。
 */
const planShelfBand = (
  originX: number,
  originY: number,
  width: number,
  height: number,
  slotIndexes: readonly number[],
  out: CollageSlot[],
): boolean => {
  const count = slotIndexes.length;
  if (count <= 0) return width > 0 && height > 0;
  for (let shelf = Math.min(2, height); shelf >= 1; shelf -= 1) {
    if (height % shelf !== 0) continue;
    const shelves = height / shelf;
    if (count < shelves || count > shelves * width) continue;
    let cursor = 0;
    for (let index = 0; index < shelves; index += 1) {
      const take = Math.min(width, Math.max(1, Math.ceil((count - cursor) / (shelves - index))));
      const base = Math.floor(width / take);
      const extra = width % take;
      let x = originX;
      for (let column = 0; column < take && cursor < count; column += 1) {
        const cols = base + (column < extra ? 1 : 0);
        const slotIndex = slotIndexes[cursor];
        if (slotIndex !== undefined) {
          out[slotIndex] = { x, y: originY + index * shelf, cols, rows: shelf };
        }
        x += cols;
        cursor += 1;
      }
    }
    return true;
  }
  return false;
};

/**
 * 一块 12×8 在「块内第 `expandedSlotIndex` 格被放大」之后的 12 个矩形（单位都是格）。
 *
 * 算法是自己推的，**不是** folia 的 `blockReflows.ts` 那份 16×12 张预计算表（参考笔记明确
 * 标注了「未读」，我们也不重算它）：
 *   ① 放大块固定 6×6（`EXPANSION_SPAN`——folia 注释里说这是「唯一一个每个 slot 都有精确
 *      re-cover 的尺寸」），锚在离它最近的块角（`expansionAnchorOf`）；
 *   ② 一块 96 格里剩下的 96 − 36 = 60 格正好是两条矩形带：靠角那条 `6×8`（48 格）
 *      + 同一侧另外 2 行的 `6×2`（12 格）；
 *   ③ 其余 11 张按面积 9 : 2 分进两条带（`round(11 × 48/60) = 9`），分块顺序 = 槽位下标升序
 *      （稳定，不随相机/时间变）；
 *   ④ 每条带交给 `planShelfBand` 精确铺满。
 * 结果：**整块 12×8 仍然满铺**（单测穷举 16 种朝向 × 12 个槽位验证无重叠无空洞），
 * 但每一张都变小了（重排后最小边是 2 格 = 264px）。
 * 万一铺不下（理论上不会发生）就退回模板原样：宁可重叠，也不要露出空洞。
 */
export const blockLayoutOf = (
  blockCol: number,
  blockRow: number,
  expandedSlotIndex: number | null,
): readonly CollageSlot[] => {
  const slots = getBlockSlots(blockCol, blockRow);
  if (expandedSlotIndex === null || expandedSlotIndex < 0 || expandedSlotIndex >= slots.length) {
    return slots;
  }
  const expanded = slots[expandedSlotIndex];
  if (expanded === undefined) return slots;

  const anchor = expansionAnchorOf(expanded);
  const rects: CollageSlot[] = slots.map((slot) => ({ ...slot }));
  rects[expandedSlotIndex] = anchor;

  const others: number[] = [];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    if (slotIndex !== expandedSlotIndex) others.push(slotIndex);
  }

  const stripHeight = BLOCK_ROWS - EXPANSION_ROWS; // 2
  const tallArea = EXPANSION_COLS * BLOCK_ROWS; // 48
  const totalArea = tallArea + EXPANSION_COLS * stripHeight; // 60
  const wantedTall = Math.round((others.length * tallArea) / totalArea); // 11 → 9
  const tallCount = clamp(wantedTall, 1, Math.max(1, others.length - 1));
  const tallIndexes = others.slice(0, tallCount);
  const shortIndexes = others.slice(tallCount);

  // 高带（6×8）在放大块的另一侧；矮带（6×2）占同一侧被放大块挤剩下的那 2 行。
  const tallX = anchor.x === 0 ? BLOCK_COLS - EXPANSION_COLS : 0;
  const shortX = BLOCK_COLS - EXPANSION_COLS - tallX;
  const shortY = anchor.y === 0 ? EXPANSION_ROWS : 0;

  const tallOk = planShelfBand(tallX, 0, EXPANSION_COLS, BLOCK_ROWS, tallIndexes, rects);
  const shortOk = planShelfBand(shortX, shortY, EXPANSION_COLS, stripHeight, shortIndexes, rects);
  if (!tallOk || !shortOk) return slots;
  return rects;
};

export type CollageGeometry = {
  blocksPerRow: number;
  blockRows: number;
  blockWidth: number;
  blockHeight: number;
  worldWidth: number;
  worldHeight: number;
  /** 定档缩放（folia `getScale`），世界坐标 × scale = 屏幕像素。 */
  scale: number;
};

/**
 * 歌数 + 视口 → 块阵。
 * 块数照 folia `getLatticeGeometry`（`FIELD_ASPECT` 让整片世界略偏横向），
 * 再补一条 folia 不需要、我们必须有的规则：块阵在屏幕上**必须铺满视口**
 * （folia 的 cell 无界重复，世界永远比视口大；我们有界，少一首歌就会被看见空白）。
 */
export const geometryFor = (
  viewport: CollageViewport,
  total: number,
  scale: number,
): CollageGeometry => {
  const blockWidth = BLOCK_COLS * COLLAGE_PITCH;
  const blockHeight = BLOCK_ROWS * COLLAGE_PITCH;
  const safeScale = scale > 0 ? scale : 1;
  const blocks = Math.max(1, Math.ceil(Math.max(0, total) / SLOTS_PER_BLOCK));
  const aspectColumns =
    blocks <= 1
      ? 1
      : Math.max(1, Math.round(Math.sqrt((FIELD_ASPECT * blocks * BLOCK_ROWS) / BLOCK_COLS)));
  const fillColumns = Math.max(
    1,
    Math.ceil((viewport.width + PAN_MARGIN_X) / (blockWidth * safeScale)),
  );
  const fillRows = Math.max(
    1,
    Math.ceil((viewport.height + PAN_MARGIN_Y) / (blockHeight * safeScale)),
  );
  const blocksPerRow = Math.max(aspectColumns, fillColumns);
  const blockRows = Math.max(Math.ceil(blocks / blocksPerRow), fillRows);

  return {
    blocksPerRow,
    blockRows,
    blockWidth,
    blockHeight,
    worldWidth: blocksPerRow * blockWidth,
    worldHeight: blockRows * blockHeight,
    scale: safeScale,
  };
};

/**
 * 用户 m00001 第 3 条(B)：四个方向对称的「起手补片」。
 *
 * 原来整片世界只朝 +x / +y 长：座位从 (0,0) 起手行主序排，歌一多 `geometryFor` 也只把块阵
 * 往右、往下加；而 `clampCamera` 又把相机夹在 `[viewport - world, 0]`（上界恒为 0 = 世界左上角）。
 * 于是：往右 / 往下拖，每加载一页就多出一段可以拖过去的地皮；往上 / 往左拖到头就是那一个死点
 * —— 用户报的「向上拖到边界就停住、不生成新片」就是它。
 *
 * 做法：在世界的上 / 左各补 `cols` / `rows` 块**回卷出来的重复格**（`queueIndexOf` 本来就是
 * `seat % total`，负座位号照样取模回卷，见它的注释；`getBlockOrientation`/`mixBlockCoords`
 * 对负块坐标也是自洽的），再把相机的上界按同一段像素放开 —— 四个方向因此都有等量的可拖空间，
 * 而且这段空间跟着 `world × scale - viewport` 一起长：每加载一页，上 / 左也同步多出一样的量。
 */
export type CollagePreroll = {
  /** 世界左上角之外再补几块（列 / 行），永远 ≥ 0。 */
  cols: number;
  rows: number;
};

/**
 * 用户 m00001 第 3 条(B)：相机允许越过世界上 / 左边缘的**屏幕像素**数。
 * 直接取 `geometryFor` 已经保证的那段余量（`worldWidth × scale - viewport.width`，恒 ≥ `PAN_MARGIN_X`）
 * —— 也就是「向右 / 向下能拖多远，向上 / 向左也能拖多远」。
 */
export const prerollScreenOf = (
  viewport: CollageViewport,
  geometry: CollageGeometry,
): { x: number; y: number } => ({
  x: Math.max(0, geometry.worldWidth * geometry.scale - viewport.width),
  y: Math.max(0, geometry.worldHeight * geometry.scale - viewport.height),
});

/** 用户 m00001 第 3 条(B)：盖住 `prerollScreenOf` 那段路需要几块重复格（向上取整，别留缝）。 */
export const prerollFor = (
  viewport: CollageViewport,
  geometry: CollageGeometry,
): CollagePreroll => {
  const screen = prerollScreenOf(viewport, geometry);
  const blockScreenWidth = geometry.blockWidth * geometry.scale;
  const blockScreenHeight = geometry.blockHeight * geometry.scale;
  return {
    cols: blockScreenWidth > 0 ? Math.ceil(screen.x / blockScreenWidth) : 0,
    rows: blockScreenHeight > 0 ? Math.ceil(screen.y / blockScreenHeight) : 0,
  };
};

/**
 * 用户 m00001 第 3 条(B)：同一段补片，换成**世界坐标**的宽 / 高。
 *
 * `isNearContentEdge` 的 `padX/padY` 必须传这个口径，不能传
 * `preroll.cols × blockWidth`：那个值按整块向上取过整，比相机真能走到的距离更大，
 * 判据会变成 `bounds.top <= -padY + margin` 而这种「取整放大后的 pad」在**纵向**上
 * 常常超出相机可达范围（块高 / 块宽与视口余量的比例不同），于是「向上拖到头」永远判不出贴边。
 * 这里直接由屏幕口径除以 scale 得来，和相机真能走到的那一段逐像素对齐。
 */
export const prerollWorldOf = (
  viewport: CollageViewport,
  geometry: CollageGeometry,
): { x: number; y: number } => {
  const screen = prerollScreenOf(viewport, geometry);
  const scale = geometry.scale > 0 ? geometry.scale : 1;
  return { x: screen.x / scale, y: screen.y / scale };
};

/** 世界坐标里的可视矩形（folia `getWorldBounds`，我们多了个 scale）。 */
export const worldBoundsOf = (
  camera: CollageCamera,
  viewport: CollageViewport,
  scale: number,
): { left: number; top: number; right: number; bottom: number } => ({
  left: -camera.x / scale,
  top: -camera.y / scale,
  right: (viewport.width - camera.x) / scale,
  bottom: (viewport.height - camera.y) / scale,
});

/**
 * 相机夹进世界：世界比视口大就 `[viewport - world, 0]`，比视口小就居中。
 * 两种情形必须分开返回（世界小时的上下界是反的，统一 clamp 会把它压到角落）。
 */
export const clampCamera = (
  camera: CollageCamera,
  viewport: CollageViewport,
  geometry: CollageGeometry,
  /**
   * 用户 m00001 第 3 条(B)：允许相机越过世界上 / 左边缘的屏幕像素数（见 `prerollScreenOf`）。
   * 默认 0 = 老行为：上界就是世界左上角（第十六轮的回归锁就锁在这一支上）。
   * 只放开上界，下界不动 —— 右下那一侧本来就有世界本体可以拖，放开了反而会拖出空白。
   */
  padX: number = 0,
  padY: number = 0,
): CollageCamera => {
  const screenWidth = geometry.worldWidth * geometry.scale;
  const screenHeight = geometry.worldHeight * geometry.scale;
  const maxX = Math.max(0, padX);
  const maxY = Math.max(0, padY);
  return {
    x:
      screenWidth <= viewport.width
        ? (viewport.width - screenWidth) / 2
        : clamp(camera.x, viewport.width - screenWidth, maxX),
    y:
      screenHeight <= viewport.height
        ? (viewport.height - screenHeight) / 2
        : clamp(camera.y, viewport.height - screenHeight, maxY),
  };
};

/** 世界的正中（首帧就用它，比 folia 的种子坐标更稳：一定有左右可拖）。 */
export const centeredCamera = (
  viewport: CollageViewport,
  geometry: CollageGeometry,
): CollageCamera => clampCamera(
  {
    x: (viewport.width - geometry.worldWidth * geometry.scale) / 2,
    y: (viewport.height - geometry.worldHeight * geometry.scale) / 2,
  },
  viewport,
  geometry,
);

/** 一个槽位（格单位，可能已经是重排后的）→ 世界矩形。 */
const rectOfSlot = (
  geometry: CollageGeometry,
  blockCol: number,
  blockRow: number,
  slot: CollageSlot,
): CollageSlotRect => ({
  x: blockCol * geometry.blockWidth + slot.x * COLLAGE_PITCH,
  y: blockRow * geometry.blockHeight + slot.y * COLLAGE_PITCH,
  width: slotWidthOf(slot),
  height: slotHeightOf(slot),
});

/** 一块槽位在世界坐标里的矩形（模板原位：既没放大、也没重排）。 */
export const slotRectOf = (
  geometry: CollageGeometry,
  blockCol: number,
  blockRow: number,
  slotIndex: number,
): CollageSlotRect =>
  rectOfSlot(
    geometry,
    blockCol,
    blockRow,
    getBlockSlots(blockCol, blockRow)[slotIndex] ?? { x: 0, y: 0, cols: 2, rows: 2 },
  );

/**
 * 一块槽位在「它自己就是那个被点开放大的格」时的世界矩形：
 * 位置 = `blockLayoutOf` 给的锚角（离它最近的块角），尺寸恒为 6×6 的正方形
 * （`slotWidthOf({cols:6,rows:6})` = 6×136 − 8 = 808 = `EXPANSION_SIZE`）。
 */
export const expandedRectOf = (geometry: CollageGeometry, ref: CollageSlotRef): CollageSlotRect => {
  const slots = blockLayoutOf(ref.blockCol, ref.blockRow, ref.slotIndex);
  return rectOfSlot(
    geometry,
    ref.blockCol,
    ref.blockRow,
    slots[ref.slotIndex] ?? { x: 0, y: 0, cols: EXPANSION_COLS, rows: EXPANSION_ROWS },
  );
};

export const slotCenterOf = (rect: CollageSlotRect): { x: number; y: number } => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

/**
 * 「点击放大某一格之后，镜头要移到哪里」——那个放大块（808 正方形，锚在最近的块角）的世界中心。
 * 组件拿它 + `cameraToCenterOn` 求出目标相机，再自己插值过去（不瞬移）。
 */
export const expandedCenterOf = (
  geometry: CollageGeometry,
  ref: CollageSlotRef,
): { x: number; y: number } => slotCenterOf(expandedRectOf(geometry, ref));

/**
 * 让世界坐标 `point` 落在视口中点所需的相机位移。
 * 屏幕坐标 = 世界坐标 × scale + camera（folia 那种纯 `translate3d` 相机），
 * 所以令 `point.x × scale + camera.x = viewport.width / 2` 反解即可。
 * 结果仍要过一遍 `clampCamera`：世界比视口小的那个方向会退化成居中，
 * 于是贴着世界边缘的槽位可能对不齐正中——这是**有意**的，露出世界之外比「对得齐」更糟。
 */
export const cameraToCenterOn = (
  point: { x: number; y: number },
  viewport: CollageViewport,
  geometry: CollageGeometry,
): CollageCamera =>
  clampCamera(
    {
      x: viewport.width / 2 - point.x * geometry.scale,
      y: viewport.height / 2 - point.y * geometry.scale,
    },
    viewport,
    geometry,
  );

/** 格子坐标 → 队列第几首（取模回卷：歌比槽位少时循环铺满，不留同一个洞）。 */
export const queueIndexOf = (
  geometry: CollageGeometry,
  ref: CollageSlotRef,
  total: number,
): number => {
  if (total <= 0) return 0;
  const ordinal = ref.blockRow * geometry.blocksPerRow + ref.blockCol;
  const seat = ordinal * SLOTS_PER_BLOCK + ref.slotIndex;
  return ((seat % total) + total) % total;
};

/**
 * 第十六轮第 4 条(d)：`queueIndexOf` 的**反向**——队列第 `queueIndex` 首歌「第一遍」落在哪个槽位。
 *
 * 槽位顺序 = 队列顺序（同一块第 i 个槽位唱队列第 i 首），座位号 = `ordinal × 12 + slotIndex`，
 * 所以 `seat = queueIndex` 就是它的第一次出现。歌比槽位少时同一首会取模回卷到后面的座位上，
 * 这里只取**第一遍**那个座位（也就是 `data-queue-index === queueIndex` 里块坐标最小的一块），
 * 这样「点击底栏定位到正在播放的那一格」有唯一答案，不随镜头的先后而变。
 * 座位落在块阵之外（理论上 `geometryFor` 已保证放得下）就返回 `null`。
 */
export const slotRefOfQueueIndex = (
  geometry: CollageGeometry,
  total: number,
  queueIndex: number,
): CollageSlotRef | null => {
  if (total <= 0 || geometry.blocksPerRow <= 0 || geometry.blockRows <= 0) return null;
  const seat = ((queueIndex % total) + total) % total;
  const ordinal = Math.floor(seat / SLOTS_PER_BLOCK);
  const blockRow = Math.floor(ordinal / geometry.blocksPerRow);
  if (blockRow >= geometry.blockRows) return null;
  return {
    blockCol: ordinal % geometry.blocksPerRow,
    blockRow,
    slotIndex: seat % SLOTS_PER_BLOCK,
  };
};

/** 世界里的**槽位总数**（= 几何建出来的格子数，含取模回卷出来的重复格）。 */
export const builtCellCountOf = (geometry: CollageGeometry): number =>
  geometry.blocksPerRow * geometry.blockRows * SLOTS_PER_BLOCK;

/**
 * 第十六轮第 4 条(c)：`total` 首歌真正占到的世界矩形边界。
 *
 * 座位是**行主序**铺的（`ordinal = blockRow × blocksPerRow + blockCol`）：
 * 前 `blocksPerRow` 个块把第一行填满，最后一行可能只填了一部分。
 * 所以边界要按「用到的块的行/列跨度」算，**不能**只看最后一个块的列号 ——
 * 300 首在视口里是 6 块一行（第 5 行只有 1 块），只看最后一块会把内容右边报窄 5 个块，
 * 于是镜头一进来就被判成「贴到内容边」，`onNeedMore` 立刻连发到底（等于没有增量加载）。
 *
 * 另外，块阵之外的世界是 `geometryFor` 为了铺满视口才补的重复格，不能拿世界边界当判据：
 * 那样要等用户拖进一片重复格才想起来加载，太晚。
 */
export const contentBoundsOf = (
  geometry: CollageGeometry,
  total: number,
): { right: number; bottom: number } => {
  if (total <= 0) return { right: 0, bottom: 0 };
  const blocksNeeded = Math.ceil(total / SLOTS_PER_BLOCK);
  const used = Math.min(blocksNeeded, geometry.blocksPerRow * geometry.blockRows);
  const columns = Math.min(used, geometry.blocksPerRow);
  const rows = Math.ceil(used / geometry.blocksPerRow);
  return {
    right: columns * geometry.blockWidth,
    bottom: rows * geometry.blockHeight,
  };
};

/**
 * 第十六轮第 4 条(c)：「镜头已经贴到已建内容的边」——
 * 可视区的右/下边界进到 `contentBoundsOf` 的 `NEAR_EDGE_MARGIN_RATIO` 个块以内就为真。
 * 两个方向都要看：世界是横向铺的，用户可能往下拖也可能往右拖。
 * 注意 `clampCamera` 会把相机夹在**世界**边界里，所以这里用「内容的边」而不是世界边界：
 * 拖过内容边之后全是重复格，那时再加载就晚了。
 */
export const isNearContentEdge = (
  camera: CollageCamera,
  viewport: CollageViewport,
  geometry: CollageGeometry,
  total: number,
  marginRatio: number = NEAR_EDGE_MARGIN_RATIO,
  /**
   * 用户 m00001 第 3 条(B)：上 / 左补出来的重复格有多宽 / 多高（世界单位）。
   * 传 0（默认）就是老行为 —— 只看右 / 下两个方向（第十六轮的回归锁锁的正是这一支）；
   * 传了值就把「世界左上角再往外的这 `padX/padY`」也算成一条边，于是向上 / 向左拖到头时
   * 和向右 / 向下一样会去要下一页，四个方向彻底对称。
   */
  padX: number = 0,
  padY: number = 0,
): boolean => {
  if (total <= 0) return false;
  const bounds = worldBoundsOf(camera, viewport, geometry.scale);
  const content = contentBoundsOf(geometry, total);
  return (
    bounds.right >= content.right - geometry.blockWidth * marginRatio ||
    bounds.bottom >= content.bottom - geometry.blockHeight * marginRatio ||
    (padX > 0 && bounds.left <= -padX + geometry.blockWidth * marginRatio) ||
    (padY > 0 && bounds.top <= -padY + geometry.blockHeight * marginRatio)
  );
};

/**
 * 视口正中最近的槽位——它就是被放大聚焦的那一块。
 * 先按块定位，再在 3×3 块范围内找「到矩形距离」最小的槽位（点在矩形内距离为 0），
 * 于是放大块永远落在视口中心附近，且一定是已渲染的那一批里的一块。
 */
export const centerSlotOf = (
  camera: CollageCamera,
  viewport: CollageViewport,
  geometry: CollageGeometry,
): CollageSlotRef | null => {
  if (geometry.worldWidth <= 0 || geometry.worldHeight <= 0) return null;
  const { scale } = geometry;
  const worldX = (viewport.width / 2 - camera.x) / scale;
  const worldY = (viewport.height / 2 - camera.y) / scale;
  const baseCol = Math.floor(worldX / geometry.blockWidth);
  const baseRow = Math.floor(worldY / geometry.blockHeight);
  let best: CollageSlotRef | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    const blockRow = baseRow + rowOffset;
    if (blockRow < 0 || blockRow >= geometry.blockRows) continue;
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      const blockCol = baseCol + colOffset;
      if (blockCol < 0 || blockCol >= geometry.blocksPerRow) continue;
      const slots = getBlockSlots(blockCol, blockRow);
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const rect = slotRectOf(geometry, blockCol, blockRow, slotIndex);
        const dx = Math.max(rect.x - worldX, 0, worldX - (rect.x + rect.width));
        const dy = Math.max(rect.y - worldY, 0, worldY - (rect.y + rect.height));
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { blockCol, blockRow, slotIndex };
        }
      }
    }
  }

  return best;
};

/** 渲染层要用的一块（组件里补 `song` 与 `coverUrl`）。 */
export type CollageInstance = {
  key: string;
  ref: CollageSlotRef;
  queueIndex: number;
  /** 卡片中心的世界坐标（渲染层用 `left/top` + `translate(-50%,-50%)`）。 */
  x: number;
  y: number;
  width: number;
  height: number;
  expanded: boolean;
  /** 这一格属于「块内有人被放大」的那一块，且它自己不是放大块 → 它是被挤小的邻居。 */
  reflowed: boolean;
  /** 入场波的延迟（秒）：`min(0.34, steps / 136 * 0.03)`，steps = 到波纹起点的曼哈顿格数。 */
  delay: number;
};

const overlaps = (
  first: { left: number; right: number; top: number; bottom: number },
  second: { left: number; right: number; top: number; bottom: number },
): boolean =>
  first.left < second.right &&
  first.right > second.left &&
  first.top < second.bottom &&
  first.bottom > second.top;

/**
 * 只产出与视口相交的槽位（folia `layoutLattice` 是同一套思路，它的 `OVERSCAN` 取 500 世界像素、
 * 上限 400 块；我们的世界有界，但同样没必要为看不见的块建 DOM）。
 *
 * `expanded` 是当前放大聚焦的那一块；`waveOrigin` 是入场波纹的起点（视口左上角的世界坐标，
 * 首帧冻结后不再随相机变，否则每次平移都会改 `animation-delay` 而重播整面墙的入场）。
 */
export const listVisibleSlots = (
  geometry: CollageGeometry,
  total: number,
  camera: CollageCamera,
  viewport: CollageViewport,
  expanded: CollageSlotRef | null,
  waveOrigin: { x: number; y: number },
  /**
   * 用户 m00001 第 3 条(B)：世界左上角之外再补几块（负列 / 负行）的重复格。
   * 默认 `{cols: 0, rows: 0}` = 老行为（只画 [0, blocksPerRow) × [0, blockRows)）；
   * 传了值就把可见块范围往左上放开同样多 —— 相机越过世界左上角之后看到的就是这些回卷格，
   * 于是「向上拖」和「向右拖」一样有东西可看（不会拖出空白）。
   */
  preroll: CollagePreroll = { cols: 0, rows: 0 },
): CollageInstance[] => {
  if (total <= 0 || geometry.worldWidth <= 0 || geometry.blockWidth <= 0) return [];
  const bounds = worldBoundsOf(camera, viewport, geometry.scale);
  const view = {
    left: bounds.left - OVERSCAN,
    right: bounds.right + OVERSCAN,
    top: bounds.top - OVERSCAN,
    bottom: bounds.bottom + OVERSCAN,
  };
  const minCol = -Math.max(0, preroll.cols);
  const minRow = -Math.max(0, preroll.rows);
  const fromCol = clamp(
    Math.floor(view.left / geometry.blockWidth),
    minCol,
    geometry.blocksPerRow - 1,
  );
  const toCol = clamp(
    Math.ceil(view.right / geometry.blockWidth),
    minCol,
    geometry.blocksPerRow - 1,
  );
  const fromRow = clamp(
    Math.floor(view.top / geometry.blockHeight),
    minRow,
    geometry.blockRows - 1,
  );
  const toRow = clamp(
    Math.ceil(view.bottom / geometry.blockHeight),
    minRow,
    geometry.blockRows - 1,
  );
  const list: CollageInstance[] = [];

  for (let blockRow = fromRow; blockRow <= toRow; blockRow += 1) {
    for (let blockCol = fromCol; blockCol <= toCol; blockCol += 1) {
      // 这一块里有没有人正在放大 —— 有就把整块交给 `blockLayoutOf` 重排（其余 11 张让位）。
      const blockExpandedIndex =
        expanded !== null && expanded.blockCol === blockCol && expanded.blockRow === blockRow
          ? expanded.slotIndex
          : null;
      const slots = getBlockSlots(blockCol, blockRow);
      const layout = blockLayoutOf(blockCol, blockRow, blockExpandedIndex);
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const ref: CollageSlotRef = { blockCol, blockRow, slotIndex };
        // 入场波用**模板原位**算延迟：重排会改 left/top，但绝不能让 animation-delay 跟着变
        // （延迟一改，那一格就会重播入场动画）。
        const base = slotRectOf(geometry, blockCol, blockRow, slotIndex);
        const slot = layout[slotIndex] ?? slots[slotIndex];
        const rect = slot === undefined ? base : rectOfSlot(geometry, blockCol, blockRow, slot);
        const isExpanded = slotIndex === blockExpandedIndex;
        const reflowed = blockExpandedIndex !== null && !isExpanded;
        const width = isExpanded ? EXPANSION_SIZE : rect.width;
        const height = isExpanded ? EXPANSION_SIZE : rect.height;
        const center = slotCenterOf(rect);
        if (
          !overlaps(
            {
              left: center.x - width / 2,
              right: center.x + width / 2,
              top: center.y - height / 2,
              bottom: center.y + height / 2,
            },
            view,
          )
        ) {
          continue;
        }
        const steps =
          Math.max(0, base.x - waveOrigin.x) + Math.max(0, base.y - waveOrigin.y);
        list.push({
          key: slotKey(ref),
          ref,
          queueIndex: queueIndexOf(geometry, ref, total),
          x: center.x,
          y: center.y,
          width,
          height,
          expanded: isExpanded,
          reflowed,
          delay: Math.min(ENTRANCE_MAX_DELAY, (steps / COLLAGE_PITCH) * ENTRANCE_STAGGER),
        });
        if (list.length >= MAX_RENDERED_SLOTS) return list;
      }
    }
  }

  return list;
};

// ---------------------------------------------------------------------------
// 第十六轮第 4 条(b)：点击「正在播放 + 已放大」的那一格 → 进播放页，那一格「长大到铺满整屏」
// ---------------------------------------------------------------------------

/**
 * 屏幕（视口 CSS 像素）上的一块矩形，例如 `el.getBoundingClientRect()` 的 `x/y/width/height`。
 * 与 `CollageSlotRect` 形状相同但**语义不同**（那个是世界坐标，这个是屏幕坐标），分开命名免得混用。
 */
export type CollageScreenRect = { x: number; y: number; width: number; height: number };

export type CollageFillTransform = {
  /** 直接写进 `style.transform` 的字符串。 */
  transform: string;
  /** 必须同时写 `style.transformOrigin`：位移与缩放都围绕元素自己的中心。 */
  transformOrigin: '50% 50%';
  translateX: number;
  translateY: number;
  /** 匀速放大倍数（世界坐标与屏幕坐标同值：世界→屏幕是一次等比缩放）。 */
  scale: number;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * 把一个「现在就占着屏幕 `rect` 这块矩形」的盒子放大到**铺满整个视口**所需的 transform。
 *
 * 用法（宿主侧，见 `SongCollage.tsx` 顶部契约）：
 *   - 宿主把要长大的那层（克隆/覆盖层）摆在 `position: fixed; left: rect.x; top: rect.y;
 *     width: rect.width; height: rect.height`，`transform-origin: 50% 50%`，然后
 *     `el.style.transform = viewportFillTransform(rect, viewport).transform`；
 *   - 缩放取 `max(1, vw/w, vh/h)`（**cover** 语义：两个方向都不小于视口，所以一定「填满」，
 *     不会留边；代价是长宽比和卡片不同时某一方向会溢出，那正是「填满」要的效果），
 *     且**永不缩小**（`scale ≥ 1`：万一量到的 rect 比视口还大也不倒着缩）。
 *   - 位移把 rect 自己的中心搬到视口中点，所以放大过程是「原地长大 + 平移到正中」，
 *     配合 `COLLAGE_FILL_MS` 的缓动就是用户说的「逐渐放大填充屏幕」。
 *
 * 纯函数：只吃 rect + 视口，不碰 DOM，可在单测里反解验证。
 */
export const viewportFillTransform = (
  rect: CollageScreenRect,
  viewport: CollageViewport,
): CollageFillTransform => {
  const width = rect.width > 0 ? rect.width : 1;
  const height = rect.height > 0 ? rect.height : 1;
  const scale = Math.max(1, viewport.width / width, viewport.height / height);
  const translateX = viewport.width / 2 - (rect.x + rect.width / 2);
  const translateY = viewport.height / 2 - (rect.y + rect.height / 2);
  return {
    transform: `translate(${round3(translateX)}px, ${round3(translateY)}px) scale(${round3(scale)})`,
    transformOrigin: '50% 50%',
    translateX: round3(translateX),
    translateY: round3(translateY),
    scale: round3(scale),
  };
};

/**
 * 同样的「填满视口」，但**直接写在拼贴格自己身上**（`<button data-collage-song-item>`）。
 *
 * 为什么不能直接用 `viewportFillTransform`：格子世界层里带一次等比缩放
 * （`geometry.scale`，0.52/0.64/0.76，就是 `.pi-collage__world` 的 `scale()`），
 * 子元素的 `translate(dx, dy)` 是**世界像素**，落到屏幕上要再乘这个 scale；
 * 而格子自己的定位又靠 `translate(-50%, -50%)`（`left/top` = 格子中心）。
 * 所以这里：
 *   - `scale` 与 `viewportFillTransform` 相同（倍数在等比缩放下不变）；
 *   - 位移先按屏幕像素算、再**除以 `parentScale`** 换回世界像素；
 *   - 返回值前缀恒为 `translate(-50%, -50%)`，正好覆盖掉格子的定位 transform
 *     （`.pi-collage__item--exiting` 会 `animation: none`，所以内联 transform 能生效，
 *      详见 `song-collage.css` 与组件头部契约）。
 *
 * `parentScale <= 0`（还没量到尺寸）时按 1 处理，宁可动画略有偏差也不要 NaN。
 * 3D 姿态那一层（`rotateX/Y` + 透视）是一个 ≤5% 的局部仿射，这里没有反解它：
 * 量到的 `rect` 与最终落点因此会有几像素误差，对一个 480ms 的放大动画来说无害。
 */
export const collageCellExitTransform = (
  rect: CollageScreenRect,
  viewport: CollageViewport,
  parentScale: number,
): CollageFillTransform => {
  const fill = viewportFillTransform(rect, viewport);
  const safeScale = parentScale > 0 ? parentScale : 1;
  const translateX = round3(fill.translateX / safeScale);
  const translateY = round3(fill.translateY / safeScale);
  return {
    ...fill,
    transform: `translate(-50%, -50%) translate(${translateX}px, ${translateY}px) scale(${fill.scale})`,
    translateX,
    translateY,
  };
};
