import { describe, expect, it } from 'vitest';
import {
  BLOCK_COLS,
  BLOCK_ORIENTATION_COUNT,
  BLOCK_ROWS,
  COLLAGE_FILL_MS,
  COLLAGE_FOLLOW_MS,
  COLLAGE_PERSPECTIVE_PX,
  COLLAGE_PITCH,
  COLLAGE_PITCH_DEG,
  COLLAGE_YAW_DEG,
  ENTRANCE_MAX_DELAY,
  EXPANSION_COLS,
  EXPANSION_ROWS,
  EXPANSION_SIZE,
  MAX_RENDERED_SLOTS,
  NEAR_EDGE_MARGIN_RATIO,
  PAN_MARGIN_X,
  PAN_MARGIN_Y,
  SLOTS_PER_BLOCK,
  blockLayoutOf,
  builtCellCountOf,
  cameraScaleFor,
  cameraToCenterOn,
  centeredCamera,
  centerSlotOf,
  clampCamera,
  collageCellExitTransform,
  contentBoundsOf,
  expandedCenterOf,
  expandedRectOf,
  expansionAnchorOf,
  geometryFor,
  getBlockOrientation,
  getBlockSlots,
  isNearContentEdge,
  listVisibleSlots,
  prerollFor,
  prerollScreenOf,
  prerollWorldOf,
  queueIndexOf,
  slotHeightOf,
  slotRectOf,
  slotRefOfQueueIndex,
  slotWidthOf,
  viewportFillTransform,
  worldBoundsOf,
  type CollageGeometry,
} from './song-collage-geometry';

/**
 * 第十四周第 2 条 + 第十五轮第 1 条（用户 m00001）：folia Lattice 式拼贴墙的纯几何。
 * 这些断言锁住几件容易在重构里悄悄坏掉的事：
 *   ① 16 种朝向下每套槽位都**正好铺满** 12×8（无重叠、无空洞）；
 *   ② 放大块（6×6 = 808）对**任何**普通槽位都 ≥ 1.8 倍
 *      —— `apps/desktop` 的冒烟探针就是这么断言的，它不看量到的是哪一块；
 *   ③ 世界永远铺满一屏、相机永远夹在世界里（拖不出空白）；
 *   ④ 队列按槽位顺序取模回卷，且入场延迟封顶 0.34s；
 *   ⑤ 块内重排（第十五轮第 1 条）：任意一格放大后同一块 12 格**仍然精确铺满** 12×8
 *      ——邻居是「让位」不是「被盖住」；重排后每张的最小边 ≥ 2 格（264px），
 *      所以「放大块 ÷ 邻居」= 808 / 264 ≈ 3.06，仍然 ≥ 探针要求的 1.8；
 *   ⑥ 重排只改尺寸与位置，**不改入场延迟**（延迟用的是模板原位；一改就会重播入场动画）；
 *   ⑦ 镜头跟随：`cameraToCenterOn` 真的把目标点放到视口中点，且结果仍是合法相机。
 */
describe('song-collage-geometry 几何', () => {
  it('16 种朝向下每套槽位都正好铺满 12×8（无重叠、无空洞）', () => {
    expect(BLOCK_ORIENTATION_COUNT).toBe(16);
    const seen = new Set<number>();
    for (let blockCol = 0; blockCol < 8; blockCol += 1) {
      for (let blockRow = 0; blockRow < 8; blockRow += 1) {
        seen.add(getBlockOrientation(blockCol, blockRow));
        const slots = getBlockSlots(blockCol, blockRow);
        expect(slots).toHaveLength(SLOTS_PER_BLOCK);
        const grid = new Array<number>(BLOCK_COLS * BLOCK_ROWS).fill(0);
        for (const slot of slots) {
          expect(slot.x).toBeGreaterThanOrEqual(0);
          expect(slot.y).toBeGreaterThanOrEqual(0);
          expect(slot.x + slot.cols).toBeLessThanOrEqual(BLOCK_COLS);
          expect(slot.y + slot.rows).toBeLessThanOrEqual(BLOCK_ROWS);
          for (let y = slot.y; y < slot.y + slot.rows; y += 1) {
            for (let x = slot.x; x < slot.x + slot.cols; x += 1) {
              const index = y * BLOCK_COLS + x;
              expect(grid[index]).toBe(0);
              grid[index] = 1;
            }
          }
        }
        expect(grid.every((cell) => cell === 1)).toBe(true);
      }
    }
    // 一个 8×8 的块阵足以穷举出全部 16 种朝向。
    expect(seen.size).toBe(16);
  });

  it('放大块对任何普通槽位都 ≥ 1.8 倍（冒烟探针断言的前提）', () => {
    let worstRatio = Number.POSITIVE_INFINITY;
    let smallest = Number.POSITIVE_INFINITY;
    for (let blockCol = 0; blockCol < 8; blockCol += 1) {
      for (let blockRow = 0; blockRow < 8; blockRow += 1) {
        for (const slot of getBlockSlots(blockCol, blockRow)) {
          const shortest = Math.min(slotWidthOf(slot), slotHeightOf(slot));
          smallest = Math.min(smallest, shortest);
          worstRatio = Math.min(worstRatio, EXPANSION_SIZE / shortest);
        }
      }
    }
    expect(EXPANSION_SIZE).toBe(6 * COLLAGE_PITCH - 8);
    // 模板里最小/最大的一格都是 2×2 与 6×3：264..400，倍数 2.02，离 1.8 有余量。
    expect(smallest).toBe(2 * COLLAGE_PITCH - 8);
    expect(worstRatio).toBeGreaterThanOrEqual(1.8);
  });

  it('相机缩水分三档（0.52 / 0.64 / 0.76）', () => {
    expect(cameraScaleFor(639)).toBe(0.52);
    expect(cameraScaleFor(640)).toBe(0.64);
    expect(cameraScaleFor(1099)).toBe(0.64);
    expect(cameraScaleFor(1100)).toBe(0.76);
  });

  it('世界永远铺满一屏、且留出可拖拽的余量：任何歌数与视口下，夹过的相机都把世界盖住视口', () => {
    const viewports = [
      { width: 480, height: 720 },
      { width: 900, height: 640 },
      { width: 1400, height: 800 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1400 },
    ];
    for (const viewport of viewports) {
      const scale = cameraScaleFor(viewport.width);
      for (const total of [1, 5, 12, 13, 60, 300, 5000]) {
        const geometry = geometryFor(viewport, total, scale);
        expect(geometry.worldWidth * geometry.scale).toBeGreaterThanOrEqual(viewport.width - 1e-6);
        expect(geometry.worldHeight * geometry.scale).toBeGreaterThanOrEqual(viewport.height - 1e-6);
        // 世界比视口大的那一截就是可拖拽量（居中后两侧各一半），探针会拖 −120/−90。
        expect(geometry.worldWidth * geometry.scale - viewport.width).toBeGreaterThanOrEqual(
          PAN_MARGIN_X - 1e-6,
        );
        expect(geometry.worldHeight * geometry.scale - viewport.height).toBeGreaterThanOrEqual(
          PAN_MARGIN_Y - 1e-6,
        );
        const camera = centeredCamera(viewport, geometry);
        const bounds = worldBoundsOf(camera, viewport, geometry.scale);
        expect(bounds.left).toBeGreaterThanOrEqual(-1e-6);
        expect(bounds.top).toBeGreaterThanOrEqual(-1e-6);
        expect(bounds.right).toBeLessThanOrEqual(geometry.worldWidth + 1e-6);
        expect(bounds.bottom).toBeLessThanOrEqual(geometry.worldHeight + 1e-6);
      }
    }
  });

  it('clampCamera：世界比视口大时夹在 [viewport - world, 0]，比视口小时居中', () => {
    const viewport = { width: 1400, height: 800 };
    const geometry = geometryFor(viewport, 200, 0.76);
    const screenWidth = geometry.worldWidth * geometry.scale;
    const screenHeight = geometry.worldHeight * geometry.scale;
    expect(screenWidth).toBeGreaterThan(viewport.width);
    expect(clampCamera({ x: 500, y: 500 }, viewport, geometry)).toEqual({ x: 0, y: 0 });
    expect(clampCamera({ x: -1e9, y: -1e9 }, viewport, geometry)).toEqual({
      x: viewport.width - screenWidth,
      y: viewport.height - screenHeight,
    });

    // 世界比视口小（只有首帧 0×0 量到之前才会发生）：居中而不是压到左上角。
    const tiny: CollageGeometry = {
      blocksPerRow: 1,
      blockRows: 1,
      blockWidth: 1632,
      blockHeight: 1088,
      worldWidth: 1632,
      worldHeight: 1088,
      scale: 1,
    };
    expect(clampCamera({ x: 0, y: 0 }, { width: 2000, height: 1400 }, tiny)).toEqual({
      x: (2000 - 1632) / 2,
      y: (1400 - 1088) / 2,
    });
  });

  it('队列按槽位顺序取模回卷，同坐标的朝向永远一致', () => {
    const geometry = geometryFor({ width: 1400, height: 800 }, 5, 0.76);
    const queues = Array.from({ length: SLOTS_PER_BLOCK }, (_, slotIndex) =>
      queueIndexOf(geometry, { blockCol: 0, blockRow: 0, slotIndex }, 5),
    );
    expect(queues).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1]);
    expect(queueIndexOf(geometry, { blockCol: 1, blockRow: 0, slotIndex: 0 }, 5)).toBe(12 % 5);
    // 朝向：模板线性步进（相邻块不撞），镜像来自哈希（同坐标恒定）。
    expect(Math.floor(getBlockOrientation(3, 2) / 4)).toBe((3 + 2 * 2) % 4);
    expect(getBlockOrientation(3, 2)).toBe(getBlockOrientation(3, 2));
    expect(Math.floor(getBlockOrientation(0, 0) / 4)).not.toBe(Math.floor(getBlockOrientation(1, 0) / 4));
  });

  it('只产出与视口相交的槽位；放大块 808 落在锚角正中，同块邻居按重排让位', () => {
    const viewport = { width: 1400, height: 800 };
    const geometry = geometryFor(viewport, 40, cameraScaleFor(viewport.width));
    const camera = centeredCamera(viewport, geometry);
    const center = centerSlotOf(camera, viewport, geometry);
    expect(center).not.toBeNull();
    if (center === null) throw new Error('首帧应当能选中一个中心槽位');
    const origin = { x: -camera.x / geometry.scale, y: -camera.y / geometry.scale };
    const list = listVisibleSlots(geometry, 40, camera, viewport, center, origin);

    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThanOrEqual(MAX_RENDERED_SLOTS);
    const expanded = list.filter((item) => item.expanded);
    expect(expanded).toHaveLength(1);
    expect(expanded[0]?.key).toBe(`${center.blockCol}:${center.blockRow}:${center.slotIndex}`);
    expect(expanded[0]?.width).toBe(EXPANSION_SIZE);
    expect(expanded[0]?.height).toBe(EXPANSION_SIZE);

    // 放大块的位置不再是模板原位：`blockLayoutOf` 把它挪到离自己最近的块角。
    const anchor = expandedRectOf(geometry, center);
    expect(anchor.width).toBe(EXPANSION_SIZE);
    expect(anchor.height).toBe(EXPANSION_SIZE);
    expect(expanded[0]?.x).toBeCloseTo(anchor.x + anchor.width / 2, 6);
    expect(expanded[0]?.y).toBeCloseTo(anchor.y + anchor.height / 2, 6);

    // 每个实例的 left/top 都是「世界矩形中心 + translate(-50%,-50%)」：
    // 放大块与同块邻居用 `blockLayoutOf` 重排后的矩形，其它块用模板原位。
    for (const item of list) {
      const inExpandedBlock =
        item.ref.blockCol === center.blockCol && item.ref.blockRow === center.blockRow;
      const slot = inExpandedBlock
        ? blockLayoutOf(item.ref.blockCol, item.ref.blockRow, center.slotIndex)[item.ref.slotIndex]
        : getBlockSlots(item.ref.blockCol, item.ref.blockRow)[item.ref.slotIndex];
      expect(slot).toBeDefined();
      if (slot === undefined) continue;
      const expected = {
        x: item.ref.blockCol * geometry.blockWidth + slot.x * COLLAGE_PITCH,
        y: item.ref.blockRow * geometry.blockHeight + slot.y * COLLAGE_PITCH,
        width: slotWidthOf(slot),
        height: slotHeightOf(slot),
      };
      expect(item.x).toBeCloseTo(expected.x + expected.width / 2, 6);
      expect(item.y).toBeCloseTo(expected.y + expected.height / 2, 6);
      if (item.expanded) {
        expect(item.width).toBe(EXPANSION_SIZE);
        expect(item.height).toBe(EXPANSION_SIZE);
      } else {
        expect(item.width).toBe(expected.width);
        expect(item.height).toBe(expected.height);
      }
      expect(item.reflowed).toBe(inExpandedBlock && !item.expanded);
      // 入场波：起点那一格是 0，其余按曼哈顿格数 0.03s/格、封顶 0.34s。
      expect(item.delay).toBeGreaterThanOrEqual(0);
      expect(item.delay).toBeLessThanOrEqual(ENTRANCE_MAX_DELAY);
    }
    expect(Math.min(...list.map((item) => item.delay))).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 第十五轮第 1 条：块内重排（某格放大 → 同块其余格让位，而不是被盖住）
  // -------------------------------------------------------------------------

  it('块内重排：任意一格放大后，同一块 12 个矩形仍然精确铺满 12×8（无重叠、无空洞）', () => {
    const anchors = new Set<string>();
    for (let blockCol = 0; blockCol < 8; blockCol += 1) {
      for (let blockRow = 0; blockRow < 8; blockRow += 1) {
        for (let expandedIndex = 0; expandedIndex < SLOTS_PER_BLOCK; expandedIndex += 1) {
          const layout = blockLayoutOf(blockCol, blockRow, expandedIndex);
          expect(layout).toHaveLength(SLOTS_PER_BLOCK);
          const grid = new Array<number>(BLOCK_COLS * BLOCK_ROWS).fill(0);
          for (const slot of layout) {
            expect(slot.cols).toBeGreaterThanOrEqual(1);
            expect(slot.rows).toBeGreaterThanOrEqual(1);
            expect(slot.x).toBeGreaterThanOrEqual(0);
            expect(slot.y).toBeGreaterThanOrEqual(0);
            expect(slot.x + slot.cols).toBeLessThanOrEqual(BLOCK_COLS);
            expect(slot.y + slot.rows).toBeLessThanOrEqual(BLOCK_ROWS);
            for (let y = slot.y; y < slot.y + slot.rows; y += 1) {
              for (let x = slot.x; x < slot.x + slot.cols; x += 1) {
                const index = y * BLOCK_COLS + x;
                expect(grid[index]).toBe(0);
                grid[index] = 1;
              }
            }
          }
          expect(grid.every((cell) => cell === 1)).toBe(true);
          const grown = layout[expandedIndex];
          expect(grown?.cols).toBe(EXPANSION_COLS);
          expect(grown?.rows).toBe(EXPANSION_ROWS);
          if (grown !== undefined) anchors.add(`${grown.x},${grown.y}`);
        }
      }
    }
    // 8×8 的块阵覆盖全部 16 种朝向；放大块的落点只可能是四个角（横向 0/6、纵向 0/2）。
    expect([...anchors].sort()).toEqual(['0,0', '0,2', '6,0', '6,2']);
  });

  it('重排后邻居的最小边是 2 格（264px）：808 / 264 ≈ 3.06，不变量 ≥ 1.8 仍然成立', () => {
    let smallest = Number.POSITIVE_INFINITY;
    let largest = 0;
    for (let expandedIndex = 0; expandedIndex < SLOTS_PER_BLOCK; expandedIndex += 1) {
      const layout = blockLayoutOf(1, 3, expandedIndex);
      layout.forEach((slot, index) => {
        if (index === expandedIndex) return;
        smallest = Math.min(smallest, slotWidthOf(slot), slotHeightOf(slot));
        largest = Math.max(largest, slotWidthOf(slot), slotHeightOf(slot));
      });
    }
    expect(smallest).toBe(2 * COLLAGE_PITCH - 8);
    expect(smallest).toBe(264);
    // 重排后没有任何一张比原来的 3 格槽位（400）更宽。
    expect(largest).toBeLessThanOrEqual(3 * COLLAGE_PITCH - 8);
    expect(EXPANSION_SIZE).toBe(808);
    expect(EXPANSION_SIZE / smallest).toBeCloseTo(3.06, 2);
    // 冒烟探针的硬断言「最大格 ÷ 它挑到的那个普通格 ≥ 1.8」，两种可能都留有余量：
    // 挑到正在重排的邻居 → 808/264 ≈ 3.06；挑到没在重排的块的 3 格槽位 → 808/400 = 2.02。
    expect(EXPANSION_SIZE / smallest).toBeGreaterThanOrEqual(1.8);
    expect(EXPANSION_SIZE / (3 * COLLAGE_PITCH - 8)).toBeGreaterThanOrEqual(1.8);
  });

  it('放大块锚在离原格中心最近的块角（横向 0/6、纵向 0/2），且它自己总是 6×6', () => {
    const corners: { x: number; y: number }[] = [];
    for (const x of [0, BLOCK_COLS - EXPANSION_COLS]) {
      for (const y of [0, BLOCK_ROWS - EXPANSION_ROWS]) corners.push({ x, y });
    }
    expect(corners).toHaveLength(4);
    for (let blockCol = 0; blockCol < 8; blockCol += 1) {
      for (let blockRow = 0; blockRow < 8; blockRow += 1) {
        const slots = getBlockSlots(blockCol, blockRow);
        slots.forEach((slot, index) => {
          const anchor = expansionAnchorOf(slot);
          expect(anchor.cols).toBe(EXPANSION_COLS);
          expect(anchor.rows).toBe(EXPANSION_ROWS);
          expect(corners).toContainEqual({ x: anchor.x, y: anchor.y });
          expect(blockLayoutOf(blockCol, blockRow, index)[index]).toEqual(anchor);
          // 「最近」的度量：放大块**自己的中心**（锚角 + 半个放大块）到原格中心的曼哈顿距离，
          // 必须不大于另外三个角。原格中心正好压在中线上时两侧并列（所以用 ≤）。
          const center = { x: slot.x + slot.cols / 2, y: slot.y + slot.rows / 2 };
          const distanceTo = (corner: { x: number; y: number }): number =>
            Math.abs(corner.x + EXPANSION_COLS / 2 - center.x) +
            Math.abs(corner.y + EXPANSION_ROWS / 2 - center.y);
          for (const corner of corners) {
            expect(distanceTo(anchor)).toBeLessThanOrEqual(distanceTo(corner));
          }
        });
      }
    }
  });

  it('重排只改尺寸与位置：同块邻居 reflowed=true、入场延迟一个字都不变', () => {
    const viewport = { width: 1400, height: 800 };
    const total = 200;
    const geometry = geometryFor(viewport, total, cameraScaleFor(viewport.width));
    const camera = centeredCamera(viewport, geometry);
    const center = centerSlotOf(camera, viewport, geometry);
    expect(center).not.toBeNull();
    if (center === null) throw new Error('首帧应当能选中一个中心槽位');
    const origin = { x: -camera.x / geometry.scale, y: -camera.y / geometry.scale };
    const baseList = listVisibleSlots(geometry, total, camera, viewport, null, origin);
    const expandedList = listVisibleSlots(geometry, total, camera, viewport, center, origin);
    const baseDelays = new Map(baseList.map((item) => [item.key, item.delay]));

    const grown = expandedList.filter((item) => item.expanded);
    expect(grown).toHaveLength(1);
    const target = expandedCenterOf(geometry, center);
    expect(grown[0]?.x).toBeCloseTo(target.x, 6);
    expect(grown[0]?.y).toBeCloseTo(target.y, 6);

    let reflowedCount = 0;
    for (const item of expandedList) {
      const sameBlock =
        item.ref.blockCol === center.blockCol && item.ref.blockRow === center.blockRow;
      expect(item.reflowed).toBe(sameBlock && !item.expanded);
      if (item.expanded) continue;
      const layout = blockLayoutOf(item.ref.blockCol, item.ref.blockRow, sameBlock ? center.slotIndex : null);
      const slot = layout[item.ref.slotIndex];
      expect(slot).toBeDefined();
      if (slot === undefined) continue;
      const expected = {
        x: item.ref.blockCol * geometry.blockWidth + slot.x * COLLAGE_PITCH,
        y: item.ref.blockRow * geometry.blockHeight + slot.y * COLLAGE_PITCH,
        width: slotWidthOf(slot),
        height: slotHeightOf(slot),
      };
      expect(item.width).toBe(expected.width);
      expect(item.height).toBe(expected.height);
      expect(item.x).toBeCloseTo(expected.x + expected.width / 2, 6);
      expect(item.y).toBeCloseTo(expected.y + expected.height / 2, 6);
      if (sameBlock) {
        reflowedCount += 1;
        // 让位：邻居的最小边降到 2 格，且比放大块小得多。
        expect(Math.min(item.width, item.height)).toBe(2 * COLLAGE_PITCH - 8);
        expect(Math.min(item.width, item.height)).toBeLessThan(EXPANSION_SIZE);
      } else {
        // 别的块没被重排：上面的手算矩形必须和导出的 `slotRectOf` 完全一致
        // （等价于把测试里重复的那段换算钉在实现上）。
        const rect = slotRectOf(geometry, item.ref.blockCol, item.ref.blockRow, item.ref.slotIndex);
        expect(expected.x).toBe(rect.x);
        expect(expected.y).toBe(rect.y);
        expect(expected.width).toBe(rect.width);
        expect(expected.height).toBe(rect.height);
      }
      // 延迟只由模板原位决定：重排绝不能改它，否则那一格会重播入场动画。
      const before = baseDelays.get(item.key);
      if (before !== undefined) expect(item.delay).toBe(before);
    }
    expect(reflowedCount).toBeGreaterThan(0);
  });

  it('镜头跟随：cameraToCenterOn 把目标点放到视口中点，且结果仍是合法相机', () => {
    const viewport = { width: 1400, height: 800 };
    const geometry = geometryFor(viewport, 400, cameraScaleFor(viewport.width));
    const camera = centeredCamera(viewport, geometry);
    const center = centerSlotOf(camera, viewport, geometry);
    expect(center).not.toBeNull();
    if (center === null) throw new Error('首帧应当能选中一个中心槽位');
    const target = expandedCenterOf(geometry, center);
    const next = cameraToCenterOn(target, viewport, geometry);
    // 屏幕坐标 = 世界坐标 × scale + camera（folia 那种纯 translate3d 相机）。
    expect(target.x * geometry.scale + next.x).toBeCloseTo(viewport.width / 2, 6);
    expect(target.y * geometry.scale + next.y).toBeCloseTo(viewport.height / 2, 6);
    // 世界足够大（400 首）时不该被夹，而且真的动了（点击别的格镜头会平移）。
    expect(next.x).not.toBe(camera.x);
    const bounds = worldBoundsOf(next, viewport, geometry.scale);
    expect(bounds.left).toBeGreaterThanOrEqual(-1e-6);
    expect(bounds.top).toBeGreaterThanOrEqual(-1e-6);
    expect(bounds.right).toBeLessThanOrEqual(geometry.worldWidth + 1e-6);
    expect(bounds.bottom).toBeLessThanOrEqual(geometry.worldHeight + 1e-6);
  });

  it('3D 姿态：透视 1400px、俯仰 3.4°、偏航 −2.6°，对尺寸比的影响有界', () => {
    expect(COLLAGE_PERSPECTIVE_PX).toBe(1400);
    expect(COLLAGE_PITCH_DEG).toBe(3.4);
    expect(COLLAGE_YAW_DEG).toBe(-2.6);
    expect(COLLAGE_FOLLOW_MS).toBeGreaterThanOrEqual(240);
    expect(COLLAGE_FOLLOW_MS).toBeLessThanOrEqual(900);
    // 1920×1080 视口的屏幕角：|dx| ≤ 960、|dy| ≤ 540。姿态把「离中心最远的那一点」
    // 往屏幕里/外推的深度上界 ≈ |dx·sin(yaw)| + |dy·sin(pitch)| ≈ 43.6 + 32.0 ≈ 75.6px，
    // 于是最坏情况下透视缩放 ≥ 1400 / (1400 + 75.6) ≈ 0.949（最多压 5%）。
    const depth =
      960 * Math.abs(Math.sin((COLLAGE_YAW_DEG * Math.PI) / 180)) +
      540 * Math.abs(Math.sin((COLLAGE_PITCH_DEG * Math.PI) / 180));
    expect(depth).toBeGreaterThan(70);
    expect(depth).toBeLessThan(81);
    const worstScale = COLLAGE_PERSPECTIVE_PX / (COLLAGE_PERSPECTIVE_PX + depth);
    expect(worstScale).toBeGreaterThan(0.94);
    // 2×2 的邻居（264px）在最坏角度下仍 ≥ 250px，所以 808 / 250 ≈ 3.2 依然远高于 1.8。
    const worstNeighbour = (2 * COLLAGE_PITCH - 8) * worstScale;
    expect(worstNeighbour).toBeGreaterThan(250);
    expect(EXPANSION_SIZE / worstNeighbour).toBeGreaterThan(1.8);
  });

  /**
   * 第十六轮第 4 条(d)：`slotRefOfQueueIndex`（`queueIndexOf` 的反函数）。
   * 底栏那颗「定位到正在播放」的按钮就靠它 —— 所以必须锁住两件事：
   *   ① 正向回代一致：这个槽位唱的确实是队列第 `queueIndex` 首；
   *   ② 取的是**第一遍**座位（座位号 = queueIndex 本身，而不是取模回卷出来的后面那几次），
   *      否则同一首歌有好几个格子，按钮的答案会随镜头的先后飘。
   */
  it('slotRefOfQueueIndex 是 queueIndexOf 的反函数，且只取「第一遍」座位', () => {
    const viewport = { width: 1280, height: 720 };
    const scale = cameraScaleFor(viewport.width);
    for (const total of [1, 5, 12, 13, 60, 300]) {
      const geometry = geometryFor(viewport, total, scale);
      const built = builtCellCountOf(geometry);
      // 墙上的槽位总数 = 块数 × 每块 12，且一定铺得下整条队列（不然会有歌上不了墙）。
      expect(built).toBe(geometry.blocksPerRow * geometry.blockRows * SLOTS_PER_BLOCK);
      expect(built).toBeGreaterThanOrEqual(total);
      for (let queueIndex = 0; queueIndex < total; queueIndex += 1) {
        const ref = slotRefOfQueueIndex(geometry, total, queueIndex);
        expect(ref).not.toBeNull();
        if (ref === null) throw new Error(`第 ${queueIndex} 首应当有槽位`);
        // ① 正向回代
        expect(queueIndexOf(geometry, ref, total)).toBe(queueIndex);
        // ② 第一遍座位：座位号就是 queueIndex，且落在世界容量之内
        const seat =
          (ref.blockRow * geometry.blocksPerRow + ref.blockCol) * SLOTS_PER_BLOCK + ref.slotIndex;
        expect(seat).toBe(queueIndex);
        expect(seat).toBeLessThan(built);
        // 槽位坐标合法
        expect(ref.blockCol).toBeGreaterThanOrEqual(0);
        expect(ref.blockCol).toBeLessThan(geometry.blocksPerRow);
        expect(ref.blockRow).toBeGreaterThanOrEqual(0);
        expect(ref.blockRow).toBeLessThan(geometry.blockRows);
        expect(ref.slotIndex).toBeGreaterThanOrEqual(0);
        expect(ref.slotIndex).toBeLessThan(SLOTS_PER_BLOCK);
      }
      // 取模回卷：超出队列长度的下标绕回队首，负数也一样。
      expect(slotRefOfQueueIndex(geometry, total, total)).toEqual(
        slotRefOfQueueIndex(geometry, total, 0),
      );
      expect(slotRefOfQueueIndex(geometry, total, -1)).toEqual(
        slotRefOfQueueIndex(geometry, total, total - 1),
      );
    }
    // 空队列没有答案（底栏按钮此时返回 false）。
    const empty = geometryFor(viewport, 0, scale);
    expect(slotRefOfQueueIndex(empty, 0, 0)).toBeNull();
    expect(slotRefOfQueueIndex(empty, 0, 7)).toBeNull();
  });

  /**
   * 第十六轮第 4 条(c)：`contentBoundsOf` = 「队列真正占到的世界矩形」。
   * 它是「镜头贴到内容边了吗」的判据，必须**排除**为了铺满视口而取模回卷出来的重复格：
   * 若用世界边界当判据，用户得先拖进一片重复格才会触发加载，那就晚了。
   */
  it('contentBoundsOf 正好包住前 total 个座位，且不超出世界', () => {
    const viewport = { width: 1440, height: 900 };
    const scale = cameraScaleFor(viewport.width);
    const total = 40;
    const geometry = geometryFor(viewport, total, scale);
    const content = contentBoundsOf(geometry, total);
    // 40 首 = ceil(40/12) = 4 块，按 `geometryFor` 的行宽行主序铺（这个视口下是 2 块一行）
    // → 内容占 2 列 × 2 行。
    const blocksNeeded = total / SLOTS_PER_BLOCK;
    const usedColumns = Math.min(Math.ceil(blocksNeeded), geometry.blocksPerRow);
    const usedRows = Math.ceil(Math.min(Math.ceil(blocksNeeded), geometry.blocksPerRow * geometry.blockRows) / geometry.blocksPerRow);
    expect(content.right).toBeCloseTo(usedColumns * geometry.blockWidth, 6);
    expect(content.bottom).toBeCloseTo(usedRows * geometry.blockHeight, 6);
    // 每一个座位的矩形都落在内容边界内（右/下都不越界）。
    for (let seat = 0; seat < total; seat += 1) {
      const ref = slotRefOfQueueIndex(geometry, total, seat);
      if (ref === null) throw new Error(`第 ${seat} 首应当有槽位`);
      const rect = slotRectOf(geometry, ref.blockCol, ref.blockRow, ref.slotIndex);
      expect(rect.x + rect.width).toBeLessThanOrEqual(content.right + 1e-6);
      expect(rect.y + rect.height).toBeLessThanOrEqual(content.bottom + 1e-6);
    }
    // 内容边界绝不会超出世界（世界至少要铺满视口 + PAN_MARGIN，只会更大）。
    expect(content.right).toBeLessThanOrEqual(geometry.worldWidth + 1e-6);
    expect(content.bottom).toBeLessThanOrEqual(geometry.worldHeight + 1e-6);

    /**
     * 回归锁：**最后一行只填了一部分**时，右边必须是「最宽那一行」的右边，
     * 而不是最后一个块的列号。曾经用 `lastOrdinal % blocksPerRow` 算右边，
     * 300 首（6 块一行、第 5 行只有 1 块）会把内容右边报窄 5 个块，
     * 于是镜头一进来就被判成贴边，`onNeedMore` 直接连发到底 —— 增量加载等于不存在。
     */
    const many = geometryFor(viewport, 300, scale);
    expect(many.blocksPerRow).toBeGreaterThan(1);
    const manyContent = contentBoundsOf(many, 300);
    expect(manyContent.right).toBeCloseTo(many.blocksPerRow * many.blockWidth, 6);
    expect(manyContent.bottom).toBeCloseTo(Math.ceil(25 / many.blocksPerRow) * many.blockHeight, 6);
    const lastSeat = slotRefOfQueueIndex(many, 300, 299);
    if (lastSeat === null) throw new Error('第 299 首应当有槽位');
    // 最后一个座位的右边界严格小于内容右边界（证明「只看最后一块」是错的）。
    expect((lastSeat.blockCol + 1) * many.blockWidth).toBeLessThan(manyContent.right);
    for (let seat = 0; seat < 300; seat += 1) {
      const ref = slotRefOfQueueIndex(many, 300, seat);
      if (ref === null) throw new Error(`第 ${seat} 首应当有槽位`);
      const rect = slotRectOf(many, ref.blockCol, ref.blockRow, ref.slotIndex);
      expect(rect.x + rect.width).toBeLessThanOrEqual(manyContent.right + 1e-6);
      expect(rect.y + rect.height).toBeLessThanOrEqual(manyContent.bottom + 1e-6);
    }

    // 空队列 → 空矩形。
    expect(contentBoundsOf(geometry, 0)).toEqual({ right: 0, bottom: 0 });
  });

  /**
   * 第十六轮第 4 条(c)：`isNearContentEdge` 决定什么时候喊 `onNeedMore()`。
   * 两个方向都要判（世界横向铺，用户可能往右拖也可能往下拖），并且要能提前：
   * 「短歌单一进来就贴边」（首帧就该请求下一页）与「长歌单居中时不许喊」都要成立。
   */
  it('isNearContentEdge：短歌单首帧就贴边，长歌单居中时不喊', () => {
    const viewport = { width: 1440, height: 900 };
    const scale = cameraScaleFor(viewport.width);
    const ratioInRange = NEAR_EDGE_MARGIN_RATIO;
    expect(ratioInRange).toBeGreaterThan(0);
    expect(ratioInRange).toBeLessThan(1);

    // 5 首：世界为了铺满视口已经补到 2 个块，内容只占 1 个块 → 一进来就贴边。
    const tiny = geometryFor(viewport, 5, scale);
    const tinyCamera = centeredCamera(viewport, tiny);
    expect(isNearContentEdge(tinyCamera, viewport, tiny, 5)).toBe(true);
    expect(tinyCamera).toEqual(clampCamera(tinyCamera, viewport, tiny));

    // 300 首：内容 25 块 × 3 行，居中时离边还很远 → 不许喊。
    const big = geometryFor(viewport, 300, scale);
    const bigCamera = centeredCamera(viewport, big);
    expect(isNearContentEdge(bigCamera, viewport, big, 300)).toBe(false);
    // 同一个相机位，把提前量调大（14 个块）就会判成贴边：这证明 marginRatio 真的在起作用。
    expect(isNearContentEdge(bigCamera, viewport, big, 300, 14)).toBe(true);
    // 拖到内容右下角附近就必须喊（贴边判定与方向无关）。
    const corner = clampCamera(
      {
        x: viewport.width - contentBoundsOf(big, 300).right * scale,
        y: viewport.height - contentBoundsOf(big, 300).bottom * scale,
      },
      viewport,
      big,
    );
    expect(isNearContentEdge(corner, viewport, big, 300)).toBe(true);

    // 空队列永远不喊（没有下一页可言）。
    expect(isNearContentEdge(bigCamera, viewport, big, 0)).toBe(false);
  });

  /**
   * 第十六轮第 4 条(b)：`viewportFillTransform` = 「把这个矩形放大到铺满整屏」的纯 transform。
   * cover 语义（两个方向都不小于视口）+ 中心搬到视口中点 + **永不缩小**，
   * 宿主只要把它写进内联 `style.transform`，配 `COLLAGE_FILL_MS` 的缓动就是「逐渐放大填满屏幕」。
   */
  it('viewportFillTransform：任意矩形都能铺满视口（cover），且永不缩小', () => {
    const viewport = { width: 1920, height: 1080 };
    const cases = [
      { x: 100, y: 200, width: 808, height: 808 },
      { x: -40, y: 0, width: 264, height: 264 },
      { x: 1800, y: 1000, width: 120, height: 300 },
      { x: 0, y: 0, width: 4000, height: 100 },
      { x: 17, y: 31, width: 1, height: 1000 },
    ];
    for (const rect of cases) {
      const fill = viewportFillTransform(rect, viewport);
      expect(fill.transformOrigin).toBe('50% 50%');
      expect(fill.transform).toContain(`scale(${fill.scale})`);
      // 永不缩小，且两个方向都不小于视口（cover：宁可溢出也不留边）。
      expect(fill.scale).toBeGreaterThanOrEqual(1);
      expect(rect.width * fill.scale).toBeGreaterThanOrEqual(viewport.width - 0.5);
      expect(rect.height * fill.scale).toBeGreaterThanOrEqual(viewport.height - 0.5);
      // 位移把矩形自己的中心搬到视口中点（放大过程是「原地长大 + 平移到正中」）。
      expect(rect.x + rect.width / 2 + fill.translateX).toBeCloseTo(viewport.width / 2, 2);
      expect(rect.y + rect.height / 2 + fill.translateY).toBeCloseTo(viewport.height / 2, 2);
    }

    // 已经铺满的那一块：位移 0、缩放 1（幂等，宿主重复点也不会跳一下）。
    const already = viewportFillTransform({ x: 0, y: 0, width: 1920, height: 1080 }, viewport);
    expect(already.scale).toBe(1);
    expect(already.translateX).toBe(0);
    expect(already.translateY).toBe(0);
    expect(already.transform).toBe('translate(0px, 0px) scale(1)');

    // 退化矩形（还没量到尺寸）不许出 NaN / Infinity。
    const degenerate = viewportFillTransform({ x: 0, y: 0, width: 0, height: 0 }, viewport);
    expect(Number.isFinite(degenerate.scale)).toBe(true);
    expect(Number.isFinite(degenerate.translateX)).toBe(true);
    expect(degenerate.transform).not.toContain('NaN');
    expect(degenerate.transform).not.toContain('Infinity');
  });

  /**
   * 第十六轮第 4 条(b)：直接写在拼贴格自己身上的那条路。
   * 格子在世界层里（世界层带一次等比 `scale()`），所以位移要先换成**世界像素**；
   * 返回值还必须带上格子自己的定位 `translate(-50%, -50%)`（`left/top` = 格子中心）。
   */
  it('collageCellExitTransform：除回世界层缩放，并保留格子的 translate(-50%,-50%) 定位', () => {
    const viewport = { width: 1440, height: 900 };
    const rect = { x: 620, y: 260, width: 808, height: 808 };
    const fill = viewportFillTransform(rect, viewport);
    for (const parentScale of [0.52, 0.64, 0.76]) {
      const exit = collageCellExitTransform(rect, viewport, parentScale);
      // 前缀恒为格子的定位 transform（正好覆盖掉它，`left/top` 仍按中心算）。
      expect(exit.transform.startsWith('translate(-50%, -50%) translate(')).toBe(true);
      expect(exit.transform).toContain(`scale(${fill.scale})`);
      expect(exit.transformOrigin).toBe('50% 50%');
      // 缩放倍数是等比缩放的**不变量**：世界层缩放不改变放大倍数。
      expect(exit.scale).toBe(fill.scale);
      // 世界像素位移 × 世界层缩放 = 屏幕像素位移（这就是除回 parentScale 的意义）。
      expect(exit.translateX * parentScale).toBeCloseTo(fill.translateX, 2);
      expect(exit.translateY * parentScale).toBeCloseTo(fill.translateY, 2);
    }
    // 还没量到世界层缩放（0 / 负数）时按 1 处理，宁可略有偏差也不要 NaN。
    for (const bad of [0, -0.7]) {
      const fallback = collageCellExitTransform(rect, viewport, bad);
      expect(Number.isFinite(fallback.translateX)).toBe(true);
      expect(Number.isFinite(fallback.translateY)).toBe(true);
      expect(fallback.translateX).toBeCloseTo(fill.translateX, 2);
      expect(fallback.translateY).toBeCloseTo(fill.translateY, 2);
      expect(fallback.transform).not.toContain('NaN');
    }
    // 动画时长与 CSS 里 `.pi-collage__item--exiting` 的 `transition` 一致（两边各写一遍，靠这条钉住）。
    expect(COLLAGE_FILL_MS).toBe(480);
  });

  /**
   * 用户 m00001 第 3 条(B)：四个方向对称的「起手补片」。
   *
   * 老行为（`padX/padY` / `preroll` 不传或传 0）必须一字不变 —— 上面所有用例锁的就是那一支；
   * 这里只管新加的这一支：向上 / 向左也要有一段和向右 / 向下一样长的地皮可以拖过去。
   */
  it('prerollScreenOf/prerollFor：上/左补出来的地皮不短于 geometryFor 保证的余量', () => {
    const viewports = [
      { width: 480, height: 720 },
      { width: 900, height: 640 },
      { width: 1400, height: 800 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1400 },
    ];
    for (const viewport of viewports) {
      for (const total of [1, 5, 12, 13, 60, 300, 5000]) {
        const scale = cameraScaleFor(viewport.width);
        const geometry = geometryFor(viewport, total, scale);
        const pad = prerollScreenOf(viewport, geometry);
        const preroll = prerollFor(viewport, geometry);
        // 起手补片那段路 = `geometryFor` 已经保证的「世界比视口大出来的余量」（编号④那条不变量）。
        expect(pad.x).toBeCloseTo(geometry.worldWidth * scale - viewport.width, 6);
        expect(pad.y).toBeCloseTo(geometry.worldHeight * scale - viewport.height, 6);
        expect(pad.x).toBeGreaterThanOrEqual(PAN_MARGIN_X - 1e-6);
        expect(pad.y).toBeGreaterThanOrEqual(PAN_MARGIN_Y - 1e-6);
        // 块数必须盖满那段路（向上取整），而且至少一块。
        expect(preroll.cols).toBeGreaterThanOrEqual(1);
        expect(preroll.rows).toBeGreaterThanOrEqual(1);
        expect(preroll.cols * geometry.blockWidth * scale).toBeGreaterThanOrEqual(pad.x - 1e-6);
        expect(preroll.rows * geometry.blockHeight * scale).toBeGreaterThanOrEqual(pad.y - 1e-6);
      }
    }
    // 还没量到尺寸（0×0）也不能炸、不能给 NaN。
    const empty = geometryFor({ width: 0, height: 0 }, 0, 0.76);
    expect(Number.isFinite(prerollScreenOf({ width: 0, height: 0 }, empty).x)).toBe(true);
    expect(prerollFor({ width: 0, height: 0 }, empty).cols).toBeGreaterThanOrEqual(0);
  });

  it('clampCamera：传了起手补片才允许越过世界左上角，下界（右下）一步都不多放', () => {
    const viewport = { width: 1400, height: 800 };
    const geometry = geometryFor(viewport, 200, cameraScaleFor(viewport.width));
    const pad = prerollScreenOf(viewport, geometry);
    // 老行为（默认）：上界恒为世界左上角 —— 用户报的「向上拖到边界就停住」。
    expect(clampCamera({ x: 500, y: 500 }, viewport, geometry)).toEqual({ x: 0, y: 0 });
    // 新行为：正好能拖到补片尽头，一步都不多。
    expect(clampCamera({ x: 1e9, y: 1e9 }, viewport, geometry, pad.x, pad.y)).toEqual({
      x: pad.x,
      y: pad.y,
    });
    const far = clampCamera({ x: -1e9, y: -1e9 }, viewport, geometry, pad.x, pad.y);
    expect(far.x).toBeCloseTo(viewport.width - geometry.worldWidth * geometry.scale, 6);
    expect(far.y).toBeCloseTo(viewport.height - geometry.worldHeight * geometry.scale, 6);
  });

  it('listVisibleSlots：给了起手补片，越过世界左上角之后画的是队列尾部的回卷格', () => {
    const viewport = { width: 1400, height: 800 };
    const scale = cameraScaleFor(viewport.width);
    const total = 60;
    const geometry = geometryFor(viewport, total, scale);
    const preroll = prerollFor(viewport, geometry);
    const pad = prerollScreenOf(viewport, geometry);
    expect(preroll.cols).toBeGreaterThanOrEqual(1);
    // 相机推到上/左能到的最远处。
    const camera = clampCamera({ x: 1e9, y: 1e9 }, viewport, geometry, pad.x, pad.y);
    const wave0 = { x: 0, y: 0 };
    const plain = listVisibleSlots(geometry, total, camera, viewport, null, wave0);
    const padded = listVisibleSlots(geometry, total, camera, viewport, null, wave0, preroll);
    // 老行为：越过世界左上角之后一格都没有（用户看到的就是停住 / 空白）。
    expect(plain.length).toBe(0);
    // 新行为：那个方向铺的是回卷格，且每一格都算得出合法的队列下标。
    expect(padded.length).toBeGreaterThan(0);
    expect(padded.some((item) => item.ref.blockCol < 0 || item.ref.blockRow < 0)).toBe(true);
    for (const item of padded) {
      expect(item.ref.blockCol).toBeGreaterThanOrEqual(-preroll.cols);
      expect(item.ref.blockRow).toBeGreaterThanOrEqual(-preroll.rows);
      expect(item.queueIndex).toBeGreaterThanOrEqual(0);
      expect(item.queueIndex).toBeLessThan(total);
      expect(item.queueIndex).toBe(queueIndexOf(geometry, item.ref, total));
      expect(item.delay).toBeGreaterThanOrEqual(0);
      expect(item.delay).toBeLessThanOrEqual(ENTRANCE_MAX_DELAY);
    }
    // 负块坐标也必须是合法且唯一的 key（React 拿它当 key）。
    expect(new Set(padded.map((item) => item.key)).size).toBe(padded.length);
    // 老行为（不给 preroll）仍然是空 —— 默认参数没有悄悄改变语义。
    const zero: { cols: number; rows: number } = { cols: 0, rows: 0 };
    expect(listVisibleSlots(geometry, total, camera, viewport, null, wave0, zero)).toEqual(plain);
  });

  it('isNearContentEdge：传了起手补片，向上/向左拖到补片尽头也会去要下一页', () => {
    const viewport = { width: 1400, height: 800 };
    const total = 200;
    const geometry = geometryFor(viewport, total, cameraScaleFor(viewport.width));
    const pad = prerollScreenOf(viewport, geometry);
    // 组件真正传给 `isNearContentEdge` 的是这个「世界坐标」口径（见 prerollWorldOf 的注释）。
    const padWorld = prerollWorldOf(viewport, geometry);
    const nearPadded = (cam: { x: number; y: number }): boolean =>
      isNearContentEdge(
        cam,
        viewport,
        geometry,
        total,
        NEAR_EDGE_MARGIN_RATIO,
        padWorld.x,
        padWorld.y,
      );
    // 世界正中：离哪条边都远 —— 新旧两种口径都必须 false。
    const center = centeredCamera(viewport, geometry);
    expect(isNearContentEdge(center, viewport, geometry, total)).toBe(false);
    expect(nearPadded(center)).toBe(false);
    // 只往上拖（x 一动不动）到最上沿：老口径 false（向上永远不加载），新口径 true（与向下对称）。
    const topOnly = clampCamera({ x: center.x, y: 1e9 }, viewport, geometry, pad.x, pad.y);
    expect(topOnly.x).toBe(center.x);
    expect(isNearContentEdge(topOnly, viewport, geometry, total)).toBe(false);
    expect(nearPadded(topOnly)).toBe(true);
    // 拖到补片尽头（上/左的最远处）：老口径 false（永远不加载），新口径 true（和右下对称）。
    const corner = clampCamera({ x: 1e9, y: 1e9 }, viewport, geometry, pad.x, pad.y);
    expect(isNearContentEdge(corner, viewport, geometry, total)).toBe(false);
    expect(nearPadded(corner)).toBe(true);
    // padX/padY = 0 时与旧实现逐字一致。
    for (const cam of [center, topOnly, corner]) {
      expect(isNearContentEdge(cam, viewport, geometry, total, NEAR_EDGE_MARGIN_RATIO, 0, 0)).toBe(
        isNearContentEdge(cam, viewport, geometry, total),
      );
    }
  });
});
