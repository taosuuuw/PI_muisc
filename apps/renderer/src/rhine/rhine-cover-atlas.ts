import * as THREE from 'three';

/**
 * 封面图集：**一张**纹理装下当前在墙上的所有封面，卡片用实例属性去查自己那一格。
 *
 * 为什么非要做图集：阵列是一个 `InstancedMesh`（每层材质一次 draw call），
 * 如果每张卡片各持一张纹理就没有实例化可言 —— 300 张卡会变成 300 次 draw call 与
 * 300 张 GPU 纹理。参考的音乐版也是这么做的（SOURCE: `Rhine-Music-Demo
 * src/cover-atlas.ts:100-196`：图集 + `coverTile`(vec4) / `coverReady`(float) 两个实例属性 +
 * 顶点着色器里 `vMapUv = coverTile.xy + uv * coverTile.zw`，片元里 `vCoverReady < 0.5` 就
 * discard，采样时用半像素内缩防止采到隔壁瓦片）。我们照同一套**做法**自己写。
 *
 * 与参考的三处不同（照实说）：
 * 1. 参考按**池槽位**固定分配瓦片（它的池是固定 9×32 个位置）；我们的列是有限列表、
 *    可见窗口每帧都在动，所以按**内容键**分配 + 最近最少使用淘汰。
 * 2. 参考的封面来自 Blender 导出的素材，我们用网易云的封面地址；那个 CDN **不保证**回 CORS 头，
 *    而带污染的 canvas 不能进 WebGL 纹理。所以先画一张本地排印兜底封面（参考的「B 方案」），
 *    拿到真图再覆盖 —— 就算一张真图都取不到，墙上也不会是一片空白。
 * 3. 参考另有 GPU 直拷与图集内快照的优化；我们只做「逐格 `copyTextureToTexture`」，
 *    拷不动就退回整张重传。
 */

/**
 * 瓦片边长（px）。
 *
 * 128 → **192**（2026-10-22 主人：「cd 盒里的歌曲封面清晰度太低」）。
 * 近景档一张封面会占到屏幕 300~400px，128 的瓦片放大了就是糊的。
 * 192 让同一张图多出 2.25 倍像素，看细节（封面文字、人物）明显更清楚。
 * 之后为了换容量一路降到 160 → 144 → 112，再降到 **96**（2026-10-24：
 * 主人指出「每一列的 cd 盒数太少」，需要更多格子，只能拿瓦片尺寸换容量）。
 */
const TILE = 96;
/**
 * 瓦片数量：**必须 ≥ 一次预热计划的总格数**，否则会进"活锁"。
 *
 * 2026-10-22 加载进度卡在 37% 的真因就在这里：计划有 470+ 张，容量只有 288，
 * 每次 `slotFor` 都淘汰一格给新格，被淘汰的下一轮又回来抢 —— 永远填不满，
 * 进度就钉死在某个百分比。
 *
 * 2026-10-24 调到 1280（30 列 × 40 行）。
 * 2026-10-25 再调到 **1900**：行窗口放到 61 之后，30 列 × 61 行 = 1830 格，
 * 1280 装不下会被淘汰 —— 而主人要的「歌单内首尾相接」要求这 61 行**各不相同**、
 * 每张都得有自己的封面。96px × 1900 格 ⇒ 画布 1536×11424（约 70MB）。
 */
const CAPACITY = 1900;
const ATLAS_COLUMNS = 16;
/**
 * 两次「整张图集重传」之间的最短间隔（毫秒）。
 *
 * 整传一次是 16MB；详情档里 `slotFor()` 会每帧重新入队，不做闸门就是每帧 16MB，
 * 实测会把渲染循环拖死（lift 卡住不动）。250ms ⇒ 一秒最多 4 次，封面仍然一张张出现。
 */
const COMMIT_INTERVAL_MS = 250;
/**
 * 每帧最多烘焙几张。
 *
 * 一张烘焙 = 一次 2D 画布绘制 + 一次纹理上传，实测 1~3ms；一帧塞 4 张就是 4~12ms 的主线程开销，
 * 正好压在 7ms 的帧预算上（主人第四轮「拖动时画面卡顿」）。降到 1 张之后，最多的一帧也只多
 * 一张烘焙的时间；封面是「渐进出现」的，慢一两帧看不出来，掉帧却看得见。
 * 拖动期间整轮烘焙还会被 `tick()` 跳过（见那里的注释），所以积压最多只在松手后以 1 张/帧消化。
 */
const BAKES_PER_FRAME = 3;
/** 抽出来的那张用高清封面（参考也给选中项单独一张纹理 + 各向异性）。 */
const SELECTED_SIZE = 512;

/** 一张卡片要显示的内容（排印兜底 + 真封面请求都用它）。 */
export interface RhineCoverMeta {
  /** 真封面地址（已经过 `coverAt()` 加过尺寸参数）；没有就只画兜底排印。 */
  url?: string | undefined;
  title: string;
  subtitle?: string | undefined;
}

interface SlotState {
  key: string | undefined;
  /** 已经画进图集（哪怕只是兜底排印）＝ 可以采样。 */
  painted: boolean;
  /** 已经换成真封面。 */
  photo: boolean;
}

type LoadState = 'pending' | 'ready' | 'failed';

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let current = '';
  for (const char of text) {
    const next = current + char;
    if (context.measureText(next).width > maxWidth && current !== '') {
      lines.push(current);
      current = char;
      if (lines.length >= maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < maxLines && current !== '') lines.push(current);
  return lines;
}

export class RhineCoverAtlas {
  /** 墙上那张图集（不生成 mipmap：相邻瓦片的留边互不干扰）。 */
  readonly texture: THREE.CanvasTexture;
  /** 抽出来的那一张的高清封面。 */
  readonly selectedTexture: THREE.CanvasTexture;

  private readonly canvas = document.createElement('canvas');
  private readonly tileCanvas = document.createElement('canvas');
  private readonly uploadCanvas = document.createElement('canvas');
  private readonly uploadTexture: THREE.Texture;
  private readonly selectedCanvas = document.createElement('canvas');
  private readonly slots: SlotState[] = [];
  private readonly byKey = new Map<string, number>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly metas = new Map<string, RhineCoverMeta>();
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly loads = new Map<string, LoadState>();
  private readonly tiles: Float32Array;
  private readonly pendingUploads: { x: number; y: number }[] = [];
  private initialized = false;
  private serial = 0;
  /** 上次整张重传的时刻（见 `commit()` 里的时间闸门）。 */
  private lastCommitAt = -Infinity;
  /** 进度条的高水位（见 `progress()`）。 */
  private progressPeak = 0;

  /** 重新开始计进度（加载层每次进入时调一次）。 */
  resetProgress(): void {
    this.progressPeak = 0;
  }

  constructor(dark = false) {
    this.dark = dark;
    const rows = Math.ceil(CAPACITY / ATLAS_COLUMNS);
    this.canvas.width = ATLAS_COLUMNS * TILE;
    this.canvas.height = rows * TILE;
    this.tileCanvas.width = TILE;
    this.tileCanvas.height = TILE;
    this.uploadCanvas.width = TILE;
    this.uploadCanvas.height = TILE;
    this.selectedCanvas.width = SELECTED_SIZE;
    this.selectedCanvas.height = SELECTED_SIZE;
    this.tiles = new Float32Array(CAPACITY * 4);
    for (let i = 0; i < CAPACITY; i += 1) {
      this.slots.push({ key: undefined, painted: false, photo: false });
      this.tiles.set(
        [
          (i % ATLAS_COLUMNS) / ATLAS_COLUMNS,
          1 - (Math.floor(i / ATLAS_COLUMNS) + 1) / rows,
          1 / ATLAS_COLUMNS,
          1 / rows,
        ],
        i * 4,
      );
    }
    this.uploadTexture = new THREE.Texture(this.uploadCanvas);
    this.uploadTexture.colorSpace = THREE.SRGBColorSpace;
    this.uploadTexture.generateMipmaps = false;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.anisotropy = 1;
    this.selectedTexture = new THREE.CanvasTexture(this.selectedCanvas);
    this.selectedTexture.colorSpace = THREE.SRGBColorSpace;
    this.selectedTexture.anisotropy = 4;
  }

  /** 内容键 → 槽位；没有就分配（满了就淘汰最近最少用的那个）。 */
  slotFor(key: string, meta: RhineCoverMeta): number {
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      if (!this.queued.has(key) && this.shouldBake(key)) this.enqueue(key, meta);
      return existing;
    }
    let slot = this.slots.findIndex((state) => state.key === undefined);
    if (slot < 0) {
      let oldest = 0;
      let oldestUse = Infinity;
      for (const state of this.recentUse) {
        const [index, use] = state;
        if (use < oldestUse) {
          oldestUse = use;
          oldest = index;
        }
      }
      slot = oldest;
      const victim = this.slots[slot];
      if (victim?.key !== undefined) this.byKey.delete(victim.key);
    }
    this.slots[slot] = { key, painted: false, photo: false };
    this.byKey.set(key, slot);
    /*
     * **分配即画一张兜底排印**，不等 `flush()`。
     *
     * 为什么不能等：卡片是否可采样是靠实例属性 `coverReady` 传进着色器的，而实例属性在
     * `writeInstances()` 里就写死了；`flush()` 跑在它**后面**，于是「刚分配的那个槽位」这一帧
     * 只能写 `ready = 0`（片元被 `discard`，看上去就是一张空壳托盘）。正常一帧后就补上，
     * 但一旦键被 LRU 淘汰又立刻重新分配，就会反复踩到这一帧 —— 冒烟的实例属性读数
     * `ready:[0,0,0]` 就是它。当场画一张，空窗直接消失。
     */
    this.paintPrinted(this.tileContext(), TILE, TILE, meta);
    const state = this.slots[slot];
    if (state !== undefined) state.painted = true;
    this.upload(slot);
    this.enqueue(key, meta);
    return slot;
  }

  /** 本帧用过这个槽（LRU 依据）。 */
  touch(slot: number): void {
    this.recentUse.set(slot, this.serial);
  }

  /** 把某一格瓦片的 (u, v, du, dv) 写进实例属性缓冲。 */
  writeTile(target: Float32Array, offset: number, slot: number): void {
    target[offset] = this.tiles[slot * 4] ?? 0;
    target[offset + 1] = this.tiles[slot * 4 + 1] ?? 0;
    target[offset + 2] = this.tiles[slot * 4 + 2] ?? 0;
    target[offset + 3] = this.tiles[slot * 4 + 3] ?? 0;
  }

  ready(slot: number): boolean {
    return this.slots[slot]?.painted === true;
  }

  /**
   * **按内容键**查是否已经画上真封面（2026-10-24 修正）。
   *
   * 为什么不能继续用槽位号：图集是 LRU 淘汰的，同一个 key 的槽位会被别的封面挤走再分配回来
   * —— 用 `ready(slot)` 统计进度时，数字会莫名其妙掉下去（表现为"卡在 80%"）。
   * 进度必须按 key 统计，槽位漂移不影响结果。
   *
   * 为什么还要求 `photo`：`flush()` 在图片仍在下下载时会先画一张**排印兜底卡**并把
   * `painted` 置真。上一版只判 `painted`，于是进度瞬间 100%、开场时满墙都是"01/02/03"排印纸，
   * 真封面后来才一张张换上去（2026-10-24 实测截图正是这个现象）。
   * 确定拿不到的（无地址 / 加载失败）由 `keySettled()` 单独判定，不算在这里。
   */
  readyByKey(key: string): boolean {
    const slot = this.byKey.get(key);
    if (slot === undefined) return false;
    const state = this.slots[slot];
    if (state === undefined || state.key !== key) return false;
    return state.painted === true && state.photo === true;
  }

  /** 某个 key 的图片是否**确定拿不到了**（无地址 / 加载失败）——它的终态就是排印卡。 */
  keySettled(key: string): boolean {
    const slot = this.byKey.get(key);
    if (slot === undefined) return false;
    const state = this.slots[slot];
    if (state === undefined || state.key !== key) return false;
    if (state.painted && !state.photo && this.loadStateOf(key) !== 'ready') {
      // 画过排印卡、没有真图、真图也不会再来（failed 或无 url）
      const load = this.loads.get(key);
      return load === 'failed' || (load === undefined && this.metas.get(key)?.url === undefined);
    }
    return false;
  }

  /**
   * 放弃某个 key 的真图，直接以排印卡作为终态。
   *
   * 用途：预热长时间没等到的格子（网络挂死、CDN 不回包）必须能收敛，否则加载页永远停在 99%。
   * 这不是伪造进度 —— 它是把「确定拿不到」的资源标记为失败，然后让正常的一次烘焙事件把它画出来。
   */
  abandon(key: string): void {
    if (this.loadStateOf(key) === 'failed') return;
    this.loads.set(key, 'failed');
    const meta = this.metas.get(key);
    if (meta !== undefined) this.enqueue(key, meta);
  }

  /**
   * 已烘焙比例（0~1）：`已烘焙 / 已分配`，分母用**历史最高分配数**（高水位）。
   *
   * 为什么要高水位：一开始只画到几格、几格又瞬间烘完，算出来就是 100%；
   * 紧接着预热又分配几百格，比例会掉回去 —— 进度条倒着走。
   * 用高水位保证它单调不减，只在真正有新格子时才把分母抬高。
   */
  progress(): number {
    /*
     * 只统计**有真封面**的格子（`photo === true`）。
     *
     * 没有封面地址的曲子会立刻画一张"排印卡"、`painted` 马上为真 —— 把它们算进分母，
     * 比例就会瞬间跳到 100%（这就是之前一直显示 100% 的原因）。
     */
    let assigned = 0;
    let painted = 0;
    for (const state of this.slots) {
      if (state.key === undefined || !state.photo) continue;
      assigned += 1;
      if (state.painted) painted += 1;
    }
    if (assigned > this.progressPeak) this.progressPeak = assigned;
    if (this.progressPeak === 0) return 1;
    return Math.min(1, painted / this.progressPeak);
  }

  /** 读某个槽位的瓦片矩形（x, y, 宽, 高，纹理坐标）。归位副本用 uniform 采样时要用它。 */
  tileRect(slot: number): { x: number; y: number; z: number; w: number } {
    return {
      x: this.tiles[slot * 4] ?? 0,
      y: this.tiles[slot * 4 + 1] ?? 0,
      z: this.tiles[slot * 4 + 2] ?? 0,
      w: this.tiles[slot * 4 + 3] ?? 0,
    };
  }

  get capacity(): number {
    return CAPACITY;
  }

  private readonly recentUse = new Map<number, number>();

  private shouldBake(key: string): boolean {
    const slot = this.byKey.get(key);
    const state = slot === undefined ? undefined : this.slots[slot];
    if (state === undefined) return false;
    if (!state.painted) return true;
    // 已经画过兜底、真图也到位了 ⇒ 还差一次真图烘焙。
    return !state.photo && this.loadStateOf(key) === 'ready';
  }

  private enqueue(key: string, meta: RhineCoverMeta): void {
    this.metas.set(key, meta);
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push(key);
  }

  /** 每帧处理少量烘焙（真图片到位后自己会重新入队）。 */
  flush(limit = BAKES_PER_FRAME): number {
    this.serial += 1;
    let baked = 0;
    while (this.queue.length > 0 && baked < limit) {
      const key = this.queue.shift();
      if (key === undefined) break;
      this.queued.delete(key);
      const slot = this.byKey.get(key);
      const state = slot === undefined ? undefined : this.slots[slot];
      const meta = this.metas.get(key);
      if (slot === undefined || state === undefined || meta === undefined || state.key !== key) continue;
      const image = this.imageOf(key, meta);
      if (image === null) {
        if (state.painted) continue;
        this.paintPrinted(this.tileContext(), TILE, TILE, meta);
        state.painted = true;
      } else {
        this.paintCover(this.tileContext(), TILE, TILE, image);
        state.painted = true;
        state.photo = true;
      }
      this.upload(slot);
      baked += 1;
    }
    /*
     * 抽出来那张的封面**不在**图集里（它有自己的 512 纹理），所以上面那圈循环永远轮不到它：
     * 第一次画的一定是兜底排印，等真图到了必须在这里补一次 —— 否则「点进详情看到的是排印纸」。
     */
    this.refreshSelected();
    return baked;
  }

  /** 抽出来的那张的高清封面（`null` = 清空）。 */
  paintSelected(meta: RhineCoverMeta | null): void {
    const context = this.selectedCanvas.getContext('2d');
    if (context === null) return;
    if (meta === null) {
      this.selectedMeta = null;
      context.clearRect(0, 0, SELECTED_SIZE, SELECTED_SIZE);
      this.selectedTexture.needsUpdate = true;
      return;
    }
    this.selectedMeta = meta;
    const key = `selected::${meta.url ?? meta.title}`;
    const image = this.imageOf(key, meta);
    if (image === null) this.paintPrinted(context, SELECTED_SIZE, SELECTED_SIZE, meta);
    else this.paintCover(context, SELECTED_SIZE, SELECTED_SIZE, image);
    this.selectedTexture.needsUpdate = true;
  }

  /** 抽出来那张的高清封面图到了没有（给场景判断是否需要重画）。 */
  selectedHasImage(): boolean {
    const meta = this.selectedMeta;
    if (meta === null) return false;
    return this.loadStateOf(`selected::${meta.url ?? meta.title}`) === 'ready';
  }

  private selectedMeta: RhineCoverMeta | null = null;

  /** 抽出来那张的封面图到了没有（到了就重画一次高清封面）。 */
  private refreshSelected(): void {
    const meta = this.selectedMeta;
    if (meta === null) return;
    const key = `selected::${meta.url ?? meta.title}`;
    if (this.loadStateOf(key) !== 'ready') return;
    const context = this.selectedCanvas.getContext('2d');
    const image = this.images.get(key);
    if (context === null || image === undefined) return;
    this.paintCover(context, SELECTED_SIZE, SELECTED_SIZE, image);
    this.selectedTexture.needsUpdate = true;
  }

  /**
   * 图集上传：渲染之前调用；有变动的格子**限量**拷贝。
   *
   * 2026-10-21 看门狗实抓到的卡死就在这里（`rhine-watchdog.log`）：
   * ```
   * at t  :7282:12021
   * at Dge.copyTextureToTexture :7333:51356
   * at commit :8141:16635
   * at tick :8148:16106
   * ```
   * 热点函数 `getParameter` 被采样 6737 次（2ms 一次 ≈ 13.5 秒的 GPU 同步查询），
   * `drawImage` 1784、`paintPrinted` 226 —— 全是这条路。
   *
   * 原因两条：① 每个待传格子各调一次 `copyTextureToTexture`，而**每格都会让 `uploadTexture`
   * 整张重传**（`needsUpdate`），所以累计一次积压就是「N 次全量上传 + N 次 GPU 同步查询」；
   * ② 卡过一次之后积压不会自己收敛，反而越滚越多（一帧上百格就是几十秒，主线程彻底不出来）。
   *
   * 现在：**整张重传一次，但有时间闸门**（`COMMIT_INTERVAL_MS`）。
   *
   * 第一版改成"有格子待传就整张重传"之后，进详情档几秒就卡住（2026-10-21 实测：lift 卡在
   * 1.32 不动、drawn 停住）。原因是详情档里 `slotFor()` 会**每帧**把封面重新入队，于是每帧
   * 都传一次 2048²（16MB）—— 带宽和 GPU 队列一起被打满，主线程就出不来。
   * 现在两次整传之间至少隔 250ms：封面仍是一张张冒出来，但一秒最多传 4 次。
   */
  commit(renderer: THREE.WebGLRenderer, force = false): boolean {
    if (!this.initialized) {
      renderer.initTexture(this.texture);
      renderer.initTexture(this.selectedTexture);
      this.initialized = true;
    }
    if (this.pendingUploads.length === 0) return false;
    const now = performance.now();
    if (!force && now - this.lastCommitAt < COMMIT_INTERVAL_MS) return false;
    this.lastCommitAt = now;
    this.pendingUploads.length = 0;
    this.texture.needsUpdate = true;
    return true;
  }

  /** 还有没有没传到 GPU 的改动（开场就绪判定要用：CPU 画完 ≠ 屏幕上看得见）。 */
  uploadPending(): boolean {
    return this.pendingUploads.length > 0;
  }

  stats(): {
    capacity: number;
    used: number;
    painted: number;
    photo: number;
    failed: number;
    pending: number;
    atlas: string;
  } {
    let used = 0;
    let painted = 0;
    let photo = 0;
    for (const state of this.slots) {
      if (state.key !== undefined) used += 1;
      if (state.painted) painted += 1;
      if (state.photo) photo += 1;
    }
    let failed = 0;
    for (const value of this.loads.values()) if (value === 'failed') failed += 1;
    return {
      capacity: CAPACITY,
      used,
      painted,
      photo,
      failed,
      pending: this.queue.length,
      atlas: `${this.canvas.width}x${this.canvas.height}`,
    };
  }

  /** 还有多少张封面等着烘焙（0 = 全部就绪）。给"载入动画该不该收"用。 */
  pending(): number {
    return this.queue.length;
  }

  /** 只给调试用：把图集本身导成 data URL（分辨「图集里装的是什么」）。 */
  debugDataUrl(): string {
    return this.canvas.toDataURL('image/png');
  }

  dispose(): void {
    this.texture.dispose();
    this.selectedTexture.dispose();
    this.uploadTexture.dispose();
    this.byKey.clear();
    this.recentUse.clear();
    this.queue.length = 0;
    this.queued.clear();
    this.metas.clear();
    this.images.clear();
    this.loads.clear();
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.selectedCanvas.width = 1;
    this.selectedCanvas.height = 1;
  }

  private loadStateOf(key: string): LoadState {
    return this.loads.get(key) ?? 'pending';
  }

  private imageOf(key: string, meta: RhineCoverMeta): HTMLImageElement | null {
    const state = this.loadStateOf(key);
    if (state === 'ready') return this.images.get(key) ?? null;
    if (state === 'failed') return null;
    if (this.loads.get(key) === 'pending') return null;
    if (meta.url === undefined) {
      this.loads.set(key, 'failed');
      return null;
    }
    this.loads.set(key, 'pending');
    const image = new Image();
    // CDN 支持 CORS 时才能进 canvas；不支持就退回排印兜底（不污染、也不刷错误）。
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      this.images.set(key, image);
      this.loads.set(key, 'ready');
      if (!this.queued.has(key)) this.enqueue(key, meta);
    };
    image.onerror = () => {
      this.loads.set(key, 'failed');
    };
    image.src = meta.url;
    return null;
  }

  private tileContext(): CanvasRenderingContext2D {
    const context = this.tileCanvas.getContext('2d');
    if (context === null) throw new Error('莱茵封面：拿不到 2D 上下文');
    return context;
  }

  private paintCover(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    image: HTMLImageElement,
  ): void {
    // 参考的做法：真封面**完整放进纸面**，不裁切、不拉伸，四周补底色。
    context.fillStyle = '#1b1a16';
    context.fillRect(0, 0, width, height);
    const scale = Math.min(
      width / Math.max(1, image.naturalWidth),
      height / Math.max(1, image.naturalHeight),
    );
    const drawWidth = Math.max(1, image.naturalWidth * scale);
    const drawHeight = Math.max(1, image.naturalHeight * scale);
    context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }

  /**
   * 本地排印兜底封面：左上大字换行（保留完整词）+ 左下署名 + 一道强调色细线。
   * 做法来自参考音乐版对「没有封面」的处理（SOURCE: `Rhine-Music-Demo DESIGN.md:220`：
   * 「缺图或载入失败使用纯本地 800×800 的 B 方案排印封面：左上大字换行、保留完整词、
   * 仅保留歌手署名」）；排印本身是我们自己的，配色跟着应用明暗走。
   */
  private paintPrinted(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    meta: RhineCoverMeta,
  ): void {
    const rule = Math.max(1, Math.round(width / 64));
    const dark = this.dark;
    // 兜底封面**不跟着参考的深色方案走**：参考的阵列底色是暖白的，深色块在它上面是一块醒目的
    // 「缺图」；我们的阵列与页面同色，浅色纸面才读得出「这是一张还没加载出来的封面」。
    context.fillStyle = dark ? '#22201c' : '#f4efe6';
    context.fillRect(0, 0, width, height);
    context.textBaseline = 'top';
    context.fillStyle = dark ? 'rgba(240, 236, 226, 0.92)' : '#2a2620';
    context.font = `600 ${Math.round(width * 0.155)}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    const lines = wrapText(context, meta.title, width * 0.78, 3);
    lines.forEach((text, index) => {
      context.fillText(text, width * 0.1, height * 0.12 + index * width * 0.19);
    });
    if (meta.subtitle !== undefined && meta.subtitle !== '') {
      context.fillStyle = dark ? 'rgba(226, 198, 150, 0.92)' : '#8a7b64';
      context.font = `400 ${Math.round(width * 0.095)}px "Microsoft YaHei", "PingFang SC", sans-serif`;
      const subtitle = wrapText(context, meta.subtitle, width * 0.78, 1)[0];
      if (subtitle !== undefined) context.fillText(subtitle, width * 0.1, height * 0.74);
    }
    context.fillStyle = 'rgba(197, 161, 107, 0.9)';
    context.fillRect(width * 0.1, height * 0.9, width * 0.3, rule);
  }

  /** 明暗档：只影响兜底排印的配色（真封面是图片本身，不参与）。 */
  setTheme(dark: boolean): void {
    if (this.dark === dark) return;
    this.dark = dark;
    // 已经画过兜底的那些格子要重画一次（真图仍然优先）。
    for (const [key, slot] of this.byKey) {
      const state = this.slots[slot];
      const meta = this.metas.get(key);
      if (state === undefined || meta === undefined || state.photo) continue;
      state.painted = false;
      if (!this.queued.has(key)) {
        this.queued.add(key);
        this.queue.push(key);
      }
    }
  }

  private dark = false;

  /** 把当前瓦片画进图集（只传这一格）。 */
  private upload(slot: number): void {
    const context = this.canvas.getContext('2d');
    if (context === null) return;
    const x = (slot % ATLAS_COLUMNS) * TILE;
    const y = Math.floor(slot / ATLAS_COLUMNS) * TILE;
    context.drawImage(this.tileCanvas, 0, 0, TILE, TILE, x, y, TILE, TILE);
    this.pendingUploads.push({ x, y });
  }
}
