import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { RhineBokehPass } from './rhine-bokeh-pass';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import {
  AO_KERNEL,
  AO_MAX_DISTANCE,
  AO_MIN_DISTANCE,
  AO_RADIUS,
  ARRAY_BASE_Y,
  BACKGROUND_LIGHT,
  BOKEH_APERTURE_DETAIL,
  BOKEH_APERTURE_PREVIEW,
  BOKEH_MAX_BLUR,
  VIGNETTE_STRENGTH,
  CAMERA_AIM,
  CAMERA_AIM_OVERVIEW,
  INTRO_MS,
  INTRO_WAVE_FADE_MS,
  CAMERA_DETAIL_DIR,
  CAMERA_DISTANCE_DETAIL,
  CAMERA_DISTANCE_PREVIEW,
  CAMERA_ELEVATION_OVERVIEW_DEG,
  CAMERA_SPAN_OVERVIEW,
  CAMERA_DISTANCE_OVERVIEW,
  CAMERA_YAW_OVERVIEW_DEG,
  CAMERA_ELEVATION_DEG,
  CAMERA_FAR,
  CAMERA_NEAR,
  CAMERA_SPAN,
  CAMERA_SPAN_DETAIL,
  CAMERA_YAW_DEG,
  CASE_HEIGHT,
  COLUMN_SPACING,
  DAMP_HOVER,
  DAMP_LANE_FOCUS,
  DAMP_LIFT,
  DAMP_RETURN,
  DAMP_TRACK,
  DARK_BACKGROUND,
  DARK_ENV_INTENSITY,
  DARK_FOG,
  DARK_HEMI_GROUND,
  DARK_HEMI_SKY,
  ENV_INTENSITY,
  FILL_COLOR,
  FILL_INTENSITY,
  FILL_POSITION,
  FOG_FAR_OFFSET,
  FOG_FAR_OFFSET_DETAIL,
  FOG_LIGHT,
  FOG_NEAR_OFFSET,
  FOG_NEAR_OFFSET_DETAIL,
  GROUND_COLOR,
  GROUND_SIZE,
  GROUND_Y,
  GHOST_LIMIT,
  HEMI_GROUND,
  HEMI_INTENSITY,
  HEMI_SKY,
  HOVER_LIFT,
  INSPECTION_LIFT,
  KEY_COLOR,
  KEY_INTENSITY,
  KEY_POSITION,
  LANE_ORIGIN,
  PREVIEW_LIFT,
  FOCUS_WAVE_KEEP,
  PEAK_SKIRT,
  SHOULDER_WAVE_TIME,
  PRINT_LIGHT_COLOR,
  PRINT_LIGHT_INTENSITY,
  PRINT_LIGHT_POSITION,
  ROW_ORIGIN,
  ROW_SPACING,
  SHADOW_BIAS,
  SHADOW_EXTENT_X,
  SHADOW_EXTENT_Y,
  SHADOW_FAR,
  SHADOW_MAP_SIZE,
  SHADOW_NORMAL_BIAS,
  SHADOW_NEAR,
  SHADOW_RADIUS,
  SLOPE_TILT,
  TONE_EXPOSURE,
  VISIBLE_ROW_WINDOW,
} from './rhine-constants';
import {
  archiveFraming,
  columnStrength,
  damp,
  idleWave,
  musicIntroWave,
  RhinePlaneMomentum,
  returnStep,
  musicSelectionWave,
  settlingWave,
  smooth,
  type Spring,
} from './rhine-motion';
import { RhineDrag, RhineWheelAccumulator, type RhineDragProjection } from './rhine-input';
import { RhineCoverAtlas, type RhineCoverMeta } from './rhine-cover-atlas';
import {
  applySingleTileSampling,
  createRhineCaseMaterials,
  createRhineCaseSurfaces,
  createSelectedCoverGeometry,
  type RhineCaseMaterials,
  type RhineCaseSurfaces,
} from './rhine-case';
import { RHINE_QUALITY_PRESETS, rhineRenderSize, type RhineQualityPreset } from './rhine-quality';

/** 位置缓存用的整数键（列号 × 100003 + 行号）。`field()` 与悬停抬升共用同一套编码：
 *  每帧每格都要算一次，拼字符串会白白产生一堆短命对象（拖拽时最明显）。 */
function cellKey(lane: number, row: number): number {
  return lane * 100003 + row;
}

/**
 * 莱茵阵列的**渲染与动画主体**。
 *
 * 结构照参考实现的分层来（SOURCE: `RhineLabUI src/scene.ts` 的 `ArchiveScene`）：
 *
 * | 职责 | 参考里在哪 | 我们怎么落 |
 * |---|---|---|
 * | 内容与位置映射 | `data.ts` + `archive-loop.ts` | 列=歌单（**有限**）、行=曲目（第 `ROW_ORIGIN` 行起） |
 * | 每帧候选与裁剪 | `archive-visibility.ts` | 视锥板 ∩ 每列有限行域 ∩ 行窗口 |
 * | 波浪场 | `motion.ts` | 逐字转写（见 `rhine-motion.ts`） |
 * | 抽出来那一张 | `this.model` + `appearance.ts` | 单独一组网格（自己的材质 + 高清封面 + 清晰度） |
 * | 相机编排 | `scene.ts:1508-1671` | 同一套公式（距离 / 视线 / 取景 / 雾） |
 * | 光照 | `archive-lighting.ts` | 逐字转写（见 `rhine-constants.ts`） |
 *
 * **主动简化**（都写进 `docs/RHINE-SKIN.md` 的「照实记」）：
 * 1. 参考的「解密」是沿对角线合拢的黑色线段 + 盖板自上而下变清晰；我们只做**盖板清晰度**那一段。
 * 2. 参考另做一张「只投影子」的覆盖网格保证屏外物体也投影；我们让阵列本体投影，
 *    代价是行窗口之外（已进雾）的盒子不投影。
 * 3. 参考的 AO 与景深共享一张打包深度图（省一遍深度渲染）；我们用 three 自带两支 pass 各算一遍。
 * 4. 参考的实例缓冲是「逐区间比较 + 增量上传」；我们整段比较、整段上传（几百个实例，代价可忽略）。
 * 5. 参考按视锥动态算候选；我们**额外**加一道行窗口硬上界（`VISIBLE_ROW_WINDOW`），
 *    让实例数有确定上界 —— 行窗口之外本来就埋在雾里。
 * 6. 参考的列是「无限循环池」；我们的列是**有限歌单**（音乐的衍生版也是这么做的，
 *    SOURCE: `Rhine-Music-Demo DESIGN.md:116`「真实列的上下边界有限，末尾不会回到第一张」）。
 */

export type RhineLevel = 'overview' | 'near' | 'detail';

export interface RhineCardView {
  key: string;
  title: string;
  subtitle?: string | undefined;
  /** **必须**是已经可用的地址（调用方用 `coverAt()` 加过尺寸参数）。 */
  coverUrl?: string | undefined;
  /**
   * 这张卡对应的完整曲目对象（2026-10-22）。
   *
   * 为什么要挂在这里：详情档点 CD 盒要"播这一张"，之前靠 id 去 `panelSongs`/`playlistSongs`
   * 里反查位置 —— 大歌单（实测 305 首）是分页加载的，那两个列表里常常没有这首歌，
   * 于是播不出来、播放器停在上一首。卡片自己带着 `Song`，就不再依赖任何列表和下标。
   */
  song?: import('@pi/shared').Song | undefined;
}

export interface RhineColumnView {
  key: string;
  title: string;
  subtitle?: string | undefined;
  coverUrl?: string | undefined;
  /** 这一列有多少个位置（真实曲目数）。 */
  count: number;
  /** 已加载的曲目；空数组 = 还没加载，按占位卡渲染。 */
  cards: RhineCardView[];
}

export interface RhineCatalog {
  columns: RhineColumnView[];
}

export interface RhinePlateProjection {
  key: string;
  x: number;
  y: number;
  visible: boolean;
}

export interface RhineFrameInfo {
  level: RhineLevel;
  plates: RhinePlateProjection[];
  /** 抽出来那一张的中心在屏幕上的落点（`null` = 没抽出来）。 */
  card: { x: number; y: number; visible: boolean } | null;
  fps: number;
  drawn: number;
}

export interface RhineFocusInfo {
  level: RhineLevel;
  lane: number;
  row: number;
  /** 曲目在一列里的下标（0 起）。 */
  index: number;
  column: RhineColumnView | null;
  card: RhineCardView | null;
}

export type RhineEvent =
  | { type: 'select-column'; lane: number }
  | { type: 'select-card'; lane: number; row: number }
  | { type: 'enter-detail'; lane: number; row: number }
  | { type: 'leave-detail' }
  /** 详情档点那张抽出来的盒子 = 进入歌曲播放页（2026-10-22），携带这张卡本身。 */
  | { type: 'open-player'; lane: number; row: number; card: RhineCardView | null }
  | { type: 'close' };

export interface RhineSceneOptions {
  container: HTMLElement;
  dark: boolean;
  onEvent: (event: RhineEvent) => void;
  onFrame: (info: RhineFrameInfo) => void;
  onFocus: (info: RhineFocusInfo) => void;
  /** 场景就绪（几何与光照都已建好）——冒烟用它决定什么时候开始量。 */
  onReady?: (() => void) | undefined;
}

/** 阵列实例的容量上界（列数 × 行窗口的上限；多余槽位不画）。 */
const INSTANCE_CAPACITY = 4096;

interface Pulse {
  lane: number;
  row: number;
  time: number;
}

/** 每列自己的显示状态：一根行轨道 + 一个活跃度（列强度与列名牌用）。 */
interface ColumnTrack {
  row: Spring;
  activity: Spring;
  midpoint: number;
}

/**
 * **归位副本**：换选时被换下来的那一张。
 *
 * 参考在换选的瞬间把当前这张 `model.clone(true)` 推入 `outgoing`、并把它自己的 lift 归零
 * （SOURCE: `RhineLabUI src/scene.ts:720-763`），于是新的一张从队列里升起、旧的那张先在原高度
 * 转正、再自己沉回槽位（`returnStep` + `damp(o.lift, 0, …)`，SOURCE: `scene.ts:1437-1468`）。
 * 我们的阵列是实例化的、抽出来那张是单独一组，所以副本是**一组普通 Mesh**，
 * 封面用单张瓦片 uniform 采样图集（避免与阵列的实例属性抢通道）。
 */
interface RhineGhost {
  group: THREE.Group;
  cover: THREE.MeshStandardMaterial;
  cell: { lane: number; row: number };
  lift: Spring;
  rotation: number;
}

export class RhineScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly composer: EffectComposer;
  private readonly ao: SSAOPass;
  private readonly bokeh: RhineBokehPass;
  private readonly smaa: SMAAPass;
  private readonly key: THREE.DirectionalLight;
  /** 半球光 / 补光 / 正面印刷光：切主题时要一起调亮度，所以留引用（2026-10-22）。 */
  private hemi: THREE.HemisphereLight | null = null;
  private fill: THREE.DirectionalLight | null = null;
  private print: THREE.DirectionalLight | null = null;
  /** 跟随选中盒的点光源（近景/详情：只照它附近，靠距离平方衰减）。 */
  private lamp: THREE.PointLight | null = null;
  /** 歌单页的斜向光带（宽而薄的一块发光面，带外自然衰减到黑）。 */
  private band: THREE.RectAreaLight | null = null;
  /** 光柱平面已废弃（参考用的是着色器高斯带，不是可见光柱）；字段保留为空以免大改。 */
  private beam: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  /**
   * 歌单页那条高斯光带的参数：`(中心 world z, 半宽, 横向半径)`。
   * 逐帧根据"斜线此刻压在哪些行上"更新（见 `updateLamp`），着色器据此把盒子渐亮渐暗。
   */
  private readonly bandUniforms = {
    // (中心 world z, 跨带半宽, 沿带半长, 横向半径)
    band: { value: new THREE.Vector4(0, 0.85, 7.5, 9) },
    gain: { value: 0 },
  };
  /** 歌单页光带的世界 x（进入该档时定一次，之后冻结；离开时清空）。 */
  private bandAnchorX: number | null = null;
  /** 后期暗角：让视觉重心落在画面中央（参考那一屏的观感）。 */
  private vignette: ShaderPass | null = null;
  private readonly surfaces: RhineCaseSurfaces;
  private readonly materials: RhineCaseMaterials;
  private readonly selectedMaterials: RhineCaseMaterials;
  private readonly ghostMaterials: RhineCaseMaterials;
  private readonly atlas: RhineCoverAtlas;
  private readonly batches: THREE.InstancedMesh[] = [];
  private readonly tileAttribute: THREE.InstancedBufferAttribute;
  private readonly readyAttribute: THREE.InstancedBufferAttribute;
  private readonly selected = new THREE.Group();
  private readonly selectedCover: THREE.Mesh;
  private readonly dummy = new THREE.Object3D();
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();
  private readonly probeBox = new THREE.Box3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly cursor = new THREE.Vector2();
  private readonly drag = new RhineDrag();
  private readonly wheel = new RhineWheelAccumulator();
  private readonly observer: ResizeObserver;
  private readonly reduced: boolean;
  private readonly options: RhineSceneOptions;
  private readonly cameraAim = new THREE.Vector3(...CAMERA_AIM);
  private readonly pointer = new THREE.Vector2();
  /** 封面图集的像素尺寸（归位副本的瓦片采样 uniform 需要它）。 */
  private atlasSize: { width: number; height: number } = { width: 2048, height: 2048 };

  private catalog: RhineCatalog = { columns: [] };
  private tracks: ColumnTrack[] = [];
  private drawnLanes: number[] = [];
  private drawnRows: number[] = [];
  private drawnSlots: number[] = [];
  private pulses: Pulse[] = [];
  private hoverKey: number | null = null;
  private hoverLifts = new Map<number, number>();
  private level: RhineLevel = 'overview';
  private selectedLane = 0;
  private selectedRow = ROW_ORIGIN;
  private laneFocus: Spring = { value: 0, velocity: 0 };
  private lift: Spring = { value: 0, velocity: 0 };
  private columnCamera: Spring = { value: 0, velocity: 0 };
  private detail = 0;
  private reveal = 0;
  private targetReveal = 0;
  private presence = 0;
  private momentum: RhinePlaneMomentum | null = null;
  private dragTrack: { lane: number; row: number } | null = null;
  private dragStart: { lane: number; row: number } | null = null;
  /** 场上正在往队列里沉的副本 + 一个可复用的池子。 */
  private ghosts: RhineGhost[] = [];
  private readonly ghostPool: RhineGhost[] = [];
  /** 场景实例编号（自增，只给调试面看：分辨「读数冻结」是场景停了还是接缝指着旧实例）。 */
  private static instanceCounter = 0;
  private readonly instanceId = (RhineScene.instanceCounter += 1);
  /** 上一次 `update()` 的时刻（毫秒），配合 `debugState().updateAgeMs` 用。 */
  private lastUpdateMs = 0;
  /** 上一次 `tick()` 真正被调用的时刻（毫秒）。 */
  private lastTickMs = 0;
  /** 上一次排下一帧的时刻（毫秒）。`tick` 老、`schedule` 新 ⇒ 排了但没跑（被节流）。 */
  private lastScheduleMs = 0;
  /** 正被副本占着的格子：阵列要跳过这些格子，否则同一格会同时画两个盒子。 */
  private readonly ghostCells = new Set<string>();
  /** 等新那张升起来再扩散的选中波（SOURCE: `scene.ts:1469-1488`）。 */
  private pendingPulse: { lane: number; row: number } | null = null;
  /** 最近一次滚轮的判定（只给调试面看）。 */
  private lastWheel: { steps: number; held: boolean; horizontal: boolean; delta: number; level: string } | null = null;
  /** 指针的 down/up 记账（只给调试面看：查「松手没收干净」这种问题）。 */
  private pointerLog: { down: number; up: number; cancel: number } | null = null;
  private rotation = 0;
  private targetRotation = 0;
  private clock = 0;
  /** 进入莱茵风后经过的毫秒（开场镜头编排用，只在激活时累积）。 */
  private introElapsedMs = 0;
  /**
   * 开场波自己的时钟（毫秒）。**不受 `INTRO_MS` 夹取** —— 列与列之间有 0.16 秒的延迟，
   * 最左边那几列要到开场编排结束后才走完；它得继续跑，波形才能自然散掉而不是被一刀切。
   */
  private introWaveMs = 0;
  /** 开场闸门：图集是否已全部烘完（连续 4 帧无待烘焙才置真）。 */
  private introReady = false;
  /** 开场前还要跑几轮图集预热（每轮把整面墙的格子入队一次）。 */
  private prewarmFrames = 0;
  /** 加载层是否已经要求开始预热（见 `beginWarmup()`）。 */
  private warmRequested = false;
  /** 预热已经跑了多久（毫秒），用于 8 秒超时收敛。 */
  private warmElapsedMs = 0;
  /** 上一次 `pumpLoader()` 的时刻（定时器驱动，不依赖 rAF）。 */
  private warmPumpAt = 0;
  /** 预热需要多少格封面（分母）。 */
  private warmTotal = 0;
  /** 其中已经就绪的格数（分子）。 */
  private warmReady = 0;
  /** 预热计划的条目（key + 元信息），一次固化、之后只读。 */
  private warmPlanItems: Array<{ key: string; meta: RhineCoverMeta }> = [];
  /** 计划构建进度：还想把哪些列加进来（曲目没到的列留在队尾重试）。 */
  private warmPendingLanes: number[] = [];
  /** 每列预热多少行（按图集容量与列数均分，保证每列都被覆盖）。 */
  private warmPerColumn = 0;
  /** 计划签名：catalog 结构变了才重建。 */
  private warmPlanSig = '';
  private last = 0;
  private raf = 0;
  private active = false;
  private frameCount = 0;
  private fpsWindow = 0;
  private fps = 0;
  private drawnCount = 0;
  private lastFocusKey = '';
  private dragging = false;
  private holdPlane = false;
  private rotateDrag: { active: boolean; startX: number; startY: number } = {
    active: false,
    startX: 0,
    startY: 0,
  };

  /** 最近一帧的分段耗时（毫秒）：update / bake（烘焙+上传）/ render。 */
  private frameCost = { update: 0, bake: 0, render: 0, total: 0 };
  /** 本次打开以来最慢那一帧的分段耗时（切换瞬间的元凶就在里面）。 */
  private frameCostPeak = { update: 0, bake: 0, render: 0, total: 0 };
  private pointerId: number | null = null;
  private idleGain = 0;
  /** 详情档的锚点：盒子的世界基座位置（换歌不重算，见 `setLevel`）。 */
  private detailAnchor: THREE.Vector3 | null = null;
  /** 连续让路（因为帧时间吃紧而不烘焙封面）的帧数，见 `tick()` 里那段注释。 */
  private bakeStarve = 0;
  private shoulderElapsed = 0;
  private selectedKey = '';
  private isDark = false;
  private quality = RHINE_QUALITY_PRESETS.original;
  private disposed = false;

  constructor(options: RhineSceneOptions) {
    this.options = options;
    const { container, dark } = options;
    this.isDark = dark;
    this.reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = TONE_EXPOSURE;
    this.renderer.shadowMap.enabled = true;
    /*
     * three r183 起 `PCFSoftShadowMap` 已被弃用（会打一行 warning 并自动退回 `PCFShadowMap`），
     * 参考写的是前者（老版本的 API）。这里**显式**用 r183 实际生效的那一档，日志干净；
     * 代价是 `shadow.radius` 不再起作用（它只服务 PCFSoft 那套模糊），其余阴影参数照旧。
     */
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.domElement.setAttribute('data-rhine-canvas', 'true');
    this.renderer.domElement.setAttribute(
      'aria-label',
      '三维 CD 盒阵列：横向拖动换歌单、纵向拖动换曲目、点击进入详情',
    );
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(dark ? DARK_BACKGROUND : BACKGROUND_LIGHT);
    this.scene.fog = new THREE.Fog(dark ? DARK_FOG : FOG_LIGHT, 22, 47);

    // ---- 光照（SOURCE: archive-lighting.ts:8-38，baseline 档）----
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.environmentIntensity = ENV_INTENSITY;
    this.hemi = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
    this.hemi.color.set(this.isDark ? DARK_HEMI_SKY : HEMI_SKY);
    this.hemi.groundColor.set(this.isDark ? DARK_HEMI_GROUND : HEMI_GROUND);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(KEY_COLOR, KEY_INTENSITY);
    this.key.position.set(...KEY_POSITION);
    this.key.castShadow = true;
    Object.assign(this.key.shadow.camera, {
      left: -SHADOW_EXTENT_X,
      right: SHADOW_EXTENT_X,
      top: SHADOW_EXTENT_Y,
      bottom: -SHADOW_EXTENT_Y,
      near: SHADOW_NEAR,
      far: SHADOW_FAR,
    });
    this.key.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.key.shadow.normalBias = SHADOW_NORMAL_BIAS;
    this.key.shadow.bias = SHADOW_BIAS;
    this.key.shadow.radius = SHADOW_RADIUS;
    const fill = new THREE.DirectionalLight(FILL_COLOR, FILL_INTENSITY);
    fill.position.set(...FILL_POSITION);
    this.fill = fill;
    this.scene.add(this.key, fill);
    /*
     * 正面印刷光：参考的档案阵列在墙上没有封面，所以它的主光/补光全在**背面**就够用了；
     * 音乐版把封面贴到阵列正面之后专门补了正面灯（见 `rhine-constants.ts` 那段注释）。
     * 这一盏**不投影**：既省一遍阴影，也避免外壳把封面自己遮暗。
     */
    const printLight = new THREE.DirectionalLight(PRINT_LIGHT_COLOR, PRINT_LIGHT_INTENSITY);
    printLight.position.set(...PRINT_LIGHT_POSITION);
    printLight.castShadow = false;
    this.print = printLight;
    this.scene.add(printLight);
    /*
     * **选中盒的补光**（2026-10-22 主人两轮反馈合成一条）：
     *   ① 「暗色只照亮选中盒附近，其他地方都是黑暗」；
     *   ② 「切换歌单时，光照不是一个光圈」—— 第一版用的是 `SpotLight`，锥体打在墙上就是一个
     *      发亮的圆，一眼就看出是"手电筒"。参考图里那束光是一整片**方形／带状**的柔和亮面。
     *
     * 所以换成 `RectAreaLight`（矩形面积光）：它没有锥角、没有圆形光斑，只是一块发光的面，
     * 靠近它的盒子被均匀照亮，远处的自然暗下去。代价是它不支持阴影（这里也不需要）。
     * 亮/暗两档只切 `intensity`。
     */
    /*
     * **选中盒补光**：两种形态，跟着档位切（2026-10-22 主人第三轮反馈）——
     *   · 歌单页（总览）：一束**斜向光带**，沿阵列的对角线打在视觉中心，带外全黑；
     *   · 近景/详情：一盏跟随当前盒子的点光，强度按 1/d² 衰减。
     * `RectAreaLight` 没有锥角也没有圆形光斑；`PointLight` 有距离衰减但没有形状。
     * 所以两盏都留着，只切 intensity。
     */
    RectAreaLightUniformsLib.init();
    /*
     * **狭长光带要真的窄**（2026-10-22 主人截图：框选处"从边框延伸的大部分都该是黑的"）。
     * 之前是 19 × 2.1 —— 宽 2.1 在这套比例里已经铺开到好几列，看起来像整片被照亮。
     * 现在收成 15 × 0.95：只压住视觉中心那条斜线，两侧迅速落暗。
     */
    const band = new THREE.RectAreaLight('#fff2df', 0, 15, 0.95);
    this.band = band;
    /*
     * **不加"看得见的光柱"**（2026-10-22 主人对照参考截图纠正）。
     *
     * 参考里的效果不是一束光打在墙上，而是**盒子表面按距离渐亮渐暗**：
     * `Rhine-Music-Demo src/music-row-lighting.ts:92-98` 的 `sampleRowLighting` 是
     *   exp(−ln2·row²) · exp(−lane⁶)
     * 一种着色器里的高斯带 —— 靠近那条带的盒子亮、远处的盒子直接黑掉，**没有可见光束**。
     * 我之前那块加色平面看起来就是一条灰带，方向根本错了，已删除。
     */
    band.position.set(0, 7, 9);
    this.scene.add(band);
    this.lamp = new THREE.PointLight('#fff2df', 0, 15, 2);
    this.lamp.position.set(0, 6, 8);
    this.scene.add(this.lamp);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
      new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = GROUND_Y;
    floor.receiveShadow = true;
    floor.name = 'rhine-floor';
    this.scene.add(floor);

    // ---- 阵列：五层材质共用同一份实例矩阵（参考也这么省，scene.ts:471-473）----
    this.surfaces = createRhineCaseSurfaces(INSTANCE_CAPACITY);
    this.atlas = new RhineCoverAtlas(dark);
    const atlasImage = this.atlas.texture.image;
    const atlasSize =
      atlasImage instanceof HTMLCanvasElement
        ? { width: atlasImage.width, height: atlasImage.height }
        : { width: 2048, height: 2048 };
    this.atlasSize = atlasSize;
    this.materials = createRhineCaseMaterials(
      dark,
      { texture: this.atlas.texture, ...atlasSize },
      true,
      this.bandUniforms,
    );
    this.selectedMaterials = createRhineCaseMaterials(
      dark,
      { texture: this.atlas.selectedTexture, width: 512, height: 512 },
      false, // 抽出来那张不套图集采样（普通 Mesh 没有 coverTile/coverReady 实例属性）
    );
    this.ghostMaterials = createRhineCaseMaterials(dark, { texture: this.atlas.texture, ...atlasSize });
    this.tileAttribute = this.surfaces.cover.getAttribute('coverTile') as THREE.InstancedBufferAttribute;
    this.readyAttribute = this.surfaces.cover.getAttribute('coverReady') as THREE.InstancedBufferAttribute;
    this.tileAttribute.setUsage(THREE.DynamicDrawUsage);
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(INSTANCE_CAPACITY * 16), 16);
    matrix.setUsage(THREE.DynamicDrawUsage);
    const layers: { geometry: THREE.BufferGeometry; material: THREE.Material; name: string; shadows: boolean }[] = [
      { geometry: this.surfaces.glass, material: this.materials.glass, name: 'glass', shadows: false },
      { geometry: this.surfaces.edge, material: this.materials.edge, name: 'edge', shadows: false },
      { geometry: this.surfaces.inlay, material: this.materials.inlay, name: 'inlay', shadows: false },
      { geometry: this.surfaces.tray, material: this.materials.tray, name: 'tray', shadows: true },
      { geometry: this.surfaces.cover, material: this.materials.cover, name: 'cover', shadows: false },
    ];
    for (const layer of layers) {
      const batch = new THREE.InstancedMesh(layer.geometry, layer.material, INSTANCE_CAPACITY);
      batch.instanceMatrix = matrix;
      batch.count = 0;
      batch.frustumCulled = false;
      batch.castShadow = layer.shadows;
      batch.receiveShadow = true;
      batch.name = `rhine-${layer.name}`;
      this.batches.push(batch);
      this.scene.add(batch);
    }

    // ---- 抽出来那一张（自己的材质：清晰度与高清封面只作用在它身上）----
    for (const [geometry, material] of [
      [this.surfaces.glass, this.selectedMaterials.glass],
      [this.surfaces.edge, this.selectedMaterials.edge],
      [this.surfaces.inlay, this.selectedMaterials.inlay],
      [this.surfaces.tray, this.selectedMaterials.tray],
    ] as const) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.selected.add(mesh);
    }
    this.selectedCover = new THREE.Mesh(createSelectedCoverGeometry(), this.selectedMaterials.cover);
    this.selected.add(this.selectedCover);
    this.selected.visible = false;
    this.selected.name = 'rhine-selected';
    this.scene.add(this.selected);

    // ---- 相机与后期 ----
    this.camera = new THREE.PerspectiveCamera(6.15, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(-62.26, 35.98, 43.28);
    this.camera.lookAt(this.cameraAim);
    this.composer = new EffectComposer(this.renderer);
    /*
     * **给两个 composer RT 挂上深度纹理**（2026-10-24 修切档掉帧）。
     *
     * `RhineBokehPass` 不再自己重绘场景取深度，而是直接读主 RenderPass 写下的深度。
     * composer 是两个 RT 交替的，所以两个都得有 `depthTexture`；
     * 景深 pass 也必须排在 RenderPass 之后（紧挨着），那时它的 `readBuffer`
     * 正是 RenderPass 刚写完的那一张。
     */
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      const depth = new THREE.DepthTexture(1, 1);
      depth.type = THREE.UnsignedIntType;
      depth.minFilter = THREE.NearestFilter;
      depth.magFilter = THREE.NearestFilter;
      target.depthTexture = depth;
    }
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    /*
     * 景深紧跟在主渲染之后：它要读的就是 RenderPass 刚写下的那张深度。
     * 原来它排在 AO 后面，那时 RT 已经交替过一次，深度就不是本帧的了。
     */
    this.bokeh = new RhineBokehPass({
      focus: 25,
      aperture: 0.0018,
      maxblur: BOKEH_MAX_BLUR,
      near: this.camera.near,
      far: this.camera.far,
      aspect: this.camera.aspect,
    });
    this.composer.addPass(this.bokeh);
    this.ao = new SSAOPass(this.scene, this.camera, 1, 1, AO_KERNEL);
    this.ao.kernelRadius = AO_RADIUS;
    this.ao.minDistance = AO_MIN_DISTANCE;
    this.ao.maxDistance = AO_MAX_DISTANCE;
    this.composer.addPass(this.ao);
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);
    /*
     * **中心发光 / 四周收暗**（2026-10-22 主人：「图 3 这种视觉中心才发光的光照效果做不出来吗」）。
     *
     * 参考那一屏的观感不是"打了一盏灯"，而是**整个视窗只有中间是亮的**：焦点附近一圈亮，
     * 越往四角越暗，最后沉进黑里。这不是灯的属性，是后期——所以这里加一个暗角 pass：
     * 以画面中心为原点做径向衰减，`strength` 控制角落压到多暗。
     * 放在 SMAA 之后、输出之前，所有质量档都生效（性能档也能有同样的视觉重心）。
     */
    const vignette = {
      uniforms: {
        tDiffuse: { value: null as THREE.Texture | null },
        strength: { value: VIGNETTE_STRENGTH },
        aspect: { value: 1 },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float strength;
        uniform float aspect;
        varying vec2 vUv;
        void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          vec2 offset = (vUv - 0.5) * vec2(aspect, 1.0);
          float distanceFromCentre = length(offset);
          float falloff = smoothstep(0.22, 0.92, distanceFromCentre);
          color.rgb *= mix(1.0, 1.0 - strength, falloff);
          gl_FragColor = color;
        }
      `,
    };
    this.vignette = new ShaderPass(vignette);
    this.composer.addPass(this.vignette);
    this.composer.addPass(new OutputPass());

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.attachInput();
    this.setQuality('original');
    this.resize();
    this.options.onReady?.();
  }

  /* ------------------------------------------------------------ 对外接口 */

  setCatalog(catalog: RhineCatalog): void {
    const first = this.catalog.columns.length === 0;
    this.catalog = catalog;
    /*
     * **有内容就必须开始渲染**（2026-10-24 修复「推荐歌单永远停在 0%」）。
     *
     * 之前渲染循环的启动完全依赖 `setActive(true)`，而那条链路挂在 React 的
     * `[active, catalog]` effect 上：命中不了（effect 早于场景创建、或依赖没变化）时
     * 场景一次都不出帧 —— 于是预热不发令、进度恒为 0，用户看到的就是"卡在加载页"。
     * 实测推荐歌单：`q=30/30` 曲目全到、`c0=35/35` 有卡，`pre=2` 却一动不动。
     *
     * catalog 有数据 = 这一层确实在用、墙上确实要画东西，这时候不需要任何人批准。
     */
    if (catalog.columns.length > 0 && !this.active) this.setActive(true);
    if (catalog.columns.length > 0) this.start();
    const tracks: ColumnTrack[] = [];
    for (let lane = 0; lane < catalog.columns.length; lane += 1) {
      const column = catalog.columns[lane];
      const count = column?.count ?? 0;
      const midpoint = ROW_ORIGIN + Math.max(0, count - 1) / 2;
      const previous = this.tracks[lane];
      const track: ColumnTrack = previous ?? {
        row: { value: midpoint, velocity: 0 },
        activity: { value: lane === this.selectedLane ? 1 : 0, velocity: 0 },
        midpoint,
      };
      track.midpoint = midpoint;
      const top = ROW_ORIGIN + Math.max(0, count - 1);
      if (track.row.value < ROW_ORIGIN - 1 || track.row.value > top + 1) track.row.value = midpoint;
      tracks.push(track);
    }
    this.tracks = tracks;
    this.selectedLane = Math.max(0, Math.min(Math.max(0, catalog.columns.length - 1), this.selectedLane));
    this.selectedRow = this.clampRow(this.selectedLane, this.selectedRow);
    if (first && catalog.columns.length > 0) {
      // 第一次拿到内容：从头播开场（阵列从后方滑入）并落一次选中波。
      this.reveal = 0;
      this.clock = 0;
      /*
       * **内容到手才真正重开开场闸门**（2026-10-22）。
       *
       * 之前只在 `setActive(true)` 里复位，但场景往往在用户点进歌单页**之前**就已经激活了
       * —— 预热跑完、`introReady` 早已为真，于是加载层一闪而过。现在改成
       * 「catalog 第一次有内容」这一刻复位：加载界面从这时开始，等预热完再撤。
       */
      this.introElapsedMs = 0;
      this.introWaveMs = 0;
      this.introReady = false;
      this.prewarmFrames = 2;
      this.emitPulse(this.selectedLane, this.selectedRow);
    }
    this.notifyFocus(true);
  }

  setActive(active: boolean): void {
    if (active === this.active) {
      // 已经在这个档上但循环停了（淡出到底之后又留在这一层）：必须重新点火，否则画面冻住。
      /*
       * **早期返回也要打开预热闸门**（2026-10-22 修复「加载页一直 0%」）。
       *
       * 场景构造时的 `active` 可能已经是 true，加载层再调 `setActive(true)` 就走到这里；
       * 之前这个分支只 `wake()` 不设 `warmRequested`，于是预热永远不启动、进度恒为 0。
       */
      if (active && !this.warmRequested) {
        this.warmRequested = true;
        this.warmElapsedMs = 0;
        this.warmPlanSig = '';
        this.warmPlanItems = [];
        this.warmPendingLanes = [];
        this.warmTotal = 0;
        this.warmReady = 0;
        this.introReady = false;
        this.introElapsedMs = 0;
        this.introWaveMs = 0;
        this.prewarmFrames = 2;
      }
      this.wake();
      return;
    }
    this.active = active;
    this.targetReveal = active ? 1 : 0;
    if (active) {
      // 每次进入都重播开场镜头（从横向波浪摆到正式机位），并重新过一遍封面闸门。
      this.introElapsedMs = 0;
      this.introWaveMs = 0;
      this.introReady = false;
      this.prewarmFrames = 2;
      /*
       * **激活即准备好预热**（2026-10-22）。
       *
       * `beginWarmup()` 由加载层调用，但加载层的 effect 可能早于场景创建、也可能因为
       * 组件重挂而拿不到 `sceneRef`。这里在场景自己的激活路径上也把闸门打开，
       * 保证「激活 ⇒ 预热会被执行」，不再依赖调用时序。
       */
      this.warmRequested = true;
      this.warmElapsedMs = 0;
      this.start();
      return;
    }
    // 不立刻杀 rAF：让它自己把 presence 淡到 0 再停（否则是硬切）。
    this.start();
  }

  /**
   * **把渲染循环叫醒**（2026-10-22 找到的"假卡死"根因）。
   *
   * `tick()` 末尾有一条省电规则：`presence <= 0.001 && targetReveal === 0` 就 `return` 不再排下一帧。
   * 问题是这条规则**只在淡出时成立**，而淡出之后如果这一层又被要求动（换档、换选、切主题），
   * 没有任何地方重新 `requestAnimationFrame` —— 于是画面停在最后一帧，进程活着、状态可读、
   * 输入还在改数据，看起来就是"卡死"。用户第三到第七轮报的那些卡死里，有一部分就是它。
   *
   * 现在凡是"要求这一层动起来"的入口都调一次：已经在跑就什么都不做，停了就重新点火。
   */
  private wake(): void {
    /*
     * 先保证「这一层是要显示的」：`tick()` 的省电分支判据是
     * `presence <= 0.001 && targetReveal === 0` —— 只要 `targetReveal` 还是 0，哪怕这一帧被叫醒，
     * 下一秒又会停回原地（2026-10-22 实测：进详情档后 lift/detail 一直停在 0）。
     * 所以唤醒时顺手把目标设回 1（仅当这一层确实在工作）。
     */
    if (this.active) this.targetReveal = 1;
    /*
     * **不能只看 `raf !== 0`**（2026-10-22 真正的原因）。
     *
     * `requestAnimationFrame` 的返回值只是个句柄：浏览器在窗口不可见/被节流时会把这一帧
     * 无限期压住，句柄仍然非零，但回调永远不来。`start()`/`wake()` 原来都用
     * `raf !== 0` 判断"已经在跑了"，于是**永远拒绝重新排帧** —— 实测：
     * `tickAgeMs` 33 秒、`scheduleAgeMs` 32 秒、`raf: true`，画面停在最后一帧。
     *
     * 现在按时间戳判断句柄是否新鲜：超过 500ms 没跑过就认为它已经死了，直接换一个新的。
     */
    const stale = performance.now() - this.lastTickMs > 500;
    if (this.raf !== 0 && !stale) return;
    this.last = 0;
    this.scheduleTick();
  }

  setLevel(level: RhineLevel, target?: { lane?: number; row?: number }): void {
    this.wake();
    if (target?.lane !== undefined) {
      this.selectedLane = Math.max(0, Math.min(Math.max(0, this.catalog.columns.length - 1), target.lane));
    }
    if (target?.row !== undefined) this.selectedRow = this.clampRow(this.selectedLane, target.row);
    /*
     * **进近景档时列内位置直接归位，不要先滚动一段**（2026-10-25 主人：
     * 「选中一个歌单进入歌曲选择页，cd 盒队列要先滚动一会才停在选择的歌曲」）。
     *
     * 每一列的行位置平时停在 `midpoint`（歌单中段），进来时 `update()` 会用弹簧把它
     * 滑到选中行 —— 从中间滑到第 329 首就是一段几百行的长滚，观感上像"队列自己跑了一阵"。
     * 这里是**进入这一档的那一下**，直接赋值即可：弹簧的初速一并清零，不会残留惯性。
     * 档内切歌（滚轮 / 拖拽 / 点卡片）不经过这个分支，滑动动画照旧。
     */
    if (level === 'near' && this.level !== 'near' && target?.row !== undefined) {
      const track = this.tracks[this.selectedLane];
      if (track !== undefined) {
        track.row.value = this.selectedRow;
        track.row.velocity = 0;
      }
    }
    /*
     * 进出详情档时记下**锚点**：盒子的世界位置与所在行。
     * 详情档里换歌不再重新取景 —— 盒子钉锚点、镜头钉锚点，只在进/出这一档时才重算
     * （主人第五轮：「挑选歌曲时镜头不要切换，保持聚焦 cd 盒」）。
     *
     * **只在「刚进详情」时算**：换歌时 React 那边也会再调一次 `setLevel('detail', {lane,row})`
     * （依赖里有 `focusIndex`），每次都重算锚点就等于每次都重新取景 —— 实测换两首漂移 304px。
     */
    if (level === 'detail') {
      if (this.level !== 'detail' || this.detailAnchor === null) {
        const anchor = this.cellPosition(this.selectedLane, this.selectedRow);
        /*
         * **锚点按「这一列已经滑到位」算，不按当前帧的位置算**（2026-10-21 冒烟⑥抓到的）。
         *
         * `cellPosition()` 的 z 含 `displayRow`：进详情那一刻整列可能还在滑动中间，
         * 用它记下来的锚点就是「半路」的位置；而盒子自己会继续滑到"选中行居中"的终点，
         * 于是镜头对着一个空位置、卡片落在视口边缘（实测落点 (961,664) / 1182×772）。
         * 终点的 z 就是 `entryZ()`（`displayRow == selectedRow` 时的值），这里直接用它。
         */
        anchor.z = this.entryZ();
        /*
         * 锚点记的是**落定高度**（槽位 + `INSPECTION_LIFT`），不是「槽位 + 实时 lift」。
         * 2026-10-21 主人：「镜头没有盯住」—— 之前 `updateCamera` 在锚点上又加了实时 `lift`，
         * 而换歌的升降动画会让 lift 在 0 ↔ 4.05 之间摆动，于是镜头跟着盒子一起上下飘。
         * 锚点一旦定死，镜头就真的一动不动（盒子自己升上去找它）。
         */
        anchor.y += INSPECTION_LIFT;
        this.detailAnchor = new THREE.Vector3(anchor.x, anchor.y, anchor.z);
      }
    } else {
      this.detailAnchor = null;
    }
    this.level = level;
    // 换档时把光带的冻结位置清掉：重新进歌单页要按当时的位置重算一次。
    if (level !== 'overview') this.bandAnchorX = null;
    if (level !== 'detail') {
      this.targetRotation = 0;
      this.momentum = null;
    }
    if (level !== 'overview') this.clock = Math.max(this.clock, 4.4);
    this.notifyFocus(true);
  }

  get currentLevel(): RhineLevel {
    return this.level;
  }

  setQuality(preset: RhineQualityPreset): void {
    const quality = RHINE_QUALITY_PRESETS[preset];
    this.quality = quality;
    this.ao.enabled = quality.aoSamples > 0;
    this.bokeh.enabled = quality.depthOfField > 0;
    this.smaa.enabled = quality.antialias === 'smaa';
    this.renderer.shadowMap.enabled = quality.shadows > 0;
    const size = Math.min(quality.shadows > 0 ? quality.shadows : 1024, this.renderer.capabilities.maxTextureSize);
    if (this.key.shadow.mapSize.x !== size) {
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
      this.key.shadow.mapSize.set(size, size);
    }
    this.key.shadow.needsUpdate = true;
    this.materials.setTransmissionScale(quality.transmission);
    this.selectedMaterials.setTransmissionScale(quality.transmission);
    this.ghostMaterials.setTransmissionScale(quality.transmission);
    // 透射通道的分辨率（three 从 r167 起给的开关）：能直接省一遍全屏透射的像素。
    const host = this.renderer as THREE.WebGLRenderer & { transmissionResolutionScale?: number };
    if (typeof host.transmissionResolutionScale === 'number') host.transmissionResolutionScale = quality.transmission;
    this.resize();
  }

  setTheme(dark: boolean): void {
    this.isDark = dark;
    this.atlas.setTheme(dark);
    this.scene.background = new THREE.Color(dark ? DARK_BACKGROUND : BACKGROUND_LIGHT);
    (this.scene.fog as THREE.Fog).color.set(dark ? DARK_FOG : FOG_LIGHT);
    this.materials.setTheme(dark);
    this.selectedMaterials.setTheme(dark);
    this.ghostMaterials.setTheme(dark);
    /*
     * **暗档把环境光压到很低、只留选中盒那束聚光**（2026-10-22 主人：「照亮范围太大，
     * 应该只照亮选中 cd 盒附近，其他地方都是黑暗」）。
     *
     * 参考的暗档画面里，整面墙几乎只有轮廓，唯一亮的东西是当前那张盒子。要做到这一点，
     * 不能只调曝光（那是全局等比例压暗，远处照样有光），得把**全局灯**压到几乎为零，
     * 让亮度只来自那盏跟着选中盒走的 `SpotLight`。亮档维持原来的均匀布光。
     */
    /*
     * **暗档：光带以外一律不发光**（2026-10-22 主人最后一轮要求：
     * 「除了光带所处的位置，其他部分不需要发光或者被光照到」）。
     *
     * 之前还留着 6~12% 的全局灯 —— 那是为了能看清远处轮廓，但代价是整面墙都浮着灰光，
     * 光带就不"突"了。现在暗档把这些**全部归零**：亮度只来自
     *   ① 着色器里那条高斯光带（`bandUniforms`）
     *   ② 近景/详情档那盏跟着盒子的点光（`lamp`）
     * 环境贴图强度也一起压到 0，否则玻璃壳还会反射出房间光。
     */
    const dim = dark;
    /*
     * 暗档保留**极低的环境光**（2026-10-22 主人：「环境光可以有，但黄色那块要亮一点，
     * 红色那块近乎全黑」）：
     *   · 环境光 3% —— 让空地和盒子的剪影还有一点点可读性，不至于纯黑；
     *   · 其余灯仍然全关，亮度几乎全部来自那条高斯带。
     */
    if (this.hemi !== null) {
      this.hemi.intensity = dim ? HEMI_INTENSITY * 0.70 : HEMI_INTENSITY;
      // 暗档冷化：半球光的天空/地面一起换，否则暖色天光会把玻璃壳又染回米黄。
      this.hemi.color.set(dim ? DARK_HEMI_SKY : HEMI_SKY);
      this.hemi.groundColor.set(dim ? DARK_HEMI_GROUND : HEMI_GROUND);
    }
    if (this.key !== undefined) this.key.intensity = dim ? 0 : KEY_INTENSITY;
    if (this.fill !== null) this.fill.intensity = dim ? 0 : FILL_INTENSITY;
    if (this.print !== null) this.print.intensity = dim ? 0 : PRINT_LIGHT_INTENSITY;
    if (this.lamp !== null) this.lamp.intensity = dim && this.level !== 'overview' ? 42 : 0;
    // 面积光也归零：暗档的"光"只能来自那条高斯带，否则又会照出一片。
    if (this.band !== null) this.band.intensity = 0;
    this.scene.environmentIntensity = dim ? DARK_ENV_INTENSITY : ENV_INTENSITY;
  }

  resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.options.container.clientWidth);
    const height = Math.max(1, this.options.container.clientHeight);
    const size = rhineRenderSize(
      this.quality,
      width,
      height,
      window.devicePixelRatio,
      this.renderer.capabilities.maxTextureSize,
    );
    this.renderer.setSize(width, height);
    this.composer.setSize(size.width, size.height);
    this.ao.setSize(
      Math.max(1, Math.floor(size.width * this.quality.aoResolution)),
      Math.max(1, Math.floor(size.height * this.quality.aoResolution)),
    );
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // 暗角按画幅比例算（不然宽屏会被拉成椭圆暗角）。
    if (this.vignette !== null) {
      const uniforms = this.vignette.uniforms as Record<string, { value: number }>;
      const aspect = uniforms.aspect;
      if (aspect !== undefined) aspect.value = this.camera.aspect;
    }
  }

  stats(): Record<string, unknown> {
    const fog = this.scene.fog as THREE.Fog;
    return {
      level: this.level,
      drawn: this.drawnCount,
      columns: this.catalog.columns.length,
      capacity: INSTANCE_CAPACITY,
      atlas: this.atlas.stats(),
      fps: Math.round(this.fps * 10) / 10,
      lift: Math.round(this.lift.value * 1000) / 1000,
      detail: Math.round(this.detail * 1000) / 1000,
      reveal: Math.round(this.reveal * 1000) / 1000,
      presence: Math.round(this.presence * 1000) / 1000,
      selected: `${this.selectedLane}:${this.selectedRow}`,
      cameraDistance: Math.round(this.camera.position.distanceTo(this.cameraAim) * 100) / 100,
      fov: Math.round(this.camera.fov * 100) / 100,
      fogNear: Math.round(fog.near * 100) / 100,
      fogFar: Math.round(fog.far * 100) / 100,
      momentum: this.momentum?.phase ?? null,
      rotation: Math.round(this.rotation * 1000) / 1000,
      reducedMotion: this.reduced,
      dark: this.isDark,
      theme: typeof document === 'undefined' ? '' : document.documentElement.dataset.theme ?? '',
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  /** 世界坐标 → 容器内的 CSS 像素。 */
  project(x: number, y: number, z: number): { x: number; y: number; behind: boolean } {
    const point = new THREE.Vector3(x, y, z).project(this.camera);
    return {
      x: ((point.x + 1) / 2) * Math.max(1, this.options.container.clientWidth),
      y: ((1 - point.y) / 2) * Math.max(1, this.options.container.clientHeight),
      behind: point.z > 1,
    };
  }

  /**
   * 只给调试用：**抽出来那张**（含抬起量）在屏幕上的落点 + 相机进到哪一档。
   * 主人第四轮的「镜头没有聚焦在 cd 盒」就是拿这条量的：详情档 `detail` 要到 0.9 以上，
   * 卡片的落点要落在视口内、并靠近构图的 `detailX`。
   */
  debugCard(): {
    x: number;
    y: number;
    visible: boolean;
    detail: number;
    lift: number;
    width: number;
    height: number;
    level: RhineLevel;
    anchored: boolean;
  } {
    const position = this.selectedCardPosition();
    position.y += CASE_HEIGHT / 2;
    const point = this.project(position.x, position.y, position.z);
    return {
      x: point.x,
      y: point.y,
      visible: !point.behind,
      detail: this.detail,
      lift: this.lift.value,
      width: Math.max(1, this.options.container.clientWidth),
      height: Math.max(1, this.options.container.clientHeight),
      level: this.level,
      anchored: this.detailAnchor !== null,
    };
  }

  /** 某个位置的中心在屏幕上的落点（探针用）。 */
  projectCell(lane: number, row: number): { x: number; y: number; visible: boolean } {    const position = this.cellPosition(lane, row);
    position.y += CASE_HEIGHT / 2;
    const point = this.project(position.x, position.y, position.z);
    return { x: point.x, y: point.y, visible: !point.behind };
  }

  /** Esc 逐级退回（宿主调用）。 */
  stepBack(): void {
    if (this.level === 'detail') this.options.onEvent({ type: 'leave-detail' });
    else this.options.onEvent({ type: 'close' });
  }

  /**
   * **只给冒烟用的调试接缝**：单独藏掉某几层，用来分辨「封面根本没画进去」还是
   * 「画了但被玻璃盖住了」。`window.__piAudio` / `window.__piMediaSession` 是本仓既有的同类做法。
   */
  debugLayers(hidden: readonly string[]): void {
    for (const batch of this.batches) {
      const name = batch.name.replace('rhine-', '');
      batch.visible = !hidden.includes(name);
    }
    this.selected.visible = !hidden.includes('selected');
    for (const ghost of this.ghosts) ghost.group.visible = !hidden.includes('selected');
  }

  /** 还有多少张封面没画进图集（0 = 都好了）。载入动画据此决定什么时候撤。 */
  atlasPending(): number {
    return this.atlas.pending();
  }

  /**
   * 调试：按名字停用后处理 pass（`ao` / `bokeh` / `smaa` / `vignette`）。
   *
   * 2026-10-24 用来二分「切档那一帧 `composer.render()` 200~300ms」到底花在哪个 pass 上：
   * 每次只关一个，切一次档看 `debugState().costPeak.render` 降不降。
   * 只影响画面，不改任何业务状态。
   */
  debugPasses(disable: readonly string[]): void {
    const passes: Array<[string, { enabled: boolean }]> = [
      ['ao', this.ao],
      ['bokeh', this.bokeh],
      ['smaa', this.smaa],
    ];
    if (this.vignette !== null) passes.push(['vignette', this.vignette]);
    for (const [name, pass] of passes) pass.enabled = !disable.includes(name);
  }

  /** 调试：清零最慢帧记录（比较不同 pass 组合前先调一次）。 */
  debugResetCost(): void {
    this.frameCostPeak = { update: 0, bake: 0, render: 0, total: 0 };
  }

  /** 调试：直接切档（绕过点击/路由，专门用来量切档那一帧的开销）。 */
  debugLevel(level: 'overview' | 'near' | 'detail'): void {
    this.setLevel(level);
  }

  /**
   * 调试：采样一小片墙的实际高度（基准 + 高度场），用来看开场结束那一瞬有没有跳变。
   *
   * 2026-10-25 主人录屏指出：动画结束时墙是凹的，下一帧突然变凸。取同一组格子
   * 在相邻两帧的高度差，就能把这个"跳"定量出来（正常呼吸波动 < 0.05）。
   */
  debugHeights(): { t: number; intro: number; wave: number; level: string; h: number[] } {
    const h: number[] = [];
    const lane = this.selectedLane;
    for (let row = ROW_ORIGIN; row < ROW_ORIGIN + 12; row += 1) {
      h.push(Math.round(this.field(lane, row) * 1000) / 1000);
    }
    return {
      t: Math.round(this.clock * 1000),
      intro: Math.round(this.introElapsedMs),
      wave: Math.round(this.introWaveMs),
      level: this.level,
      h,
    };
  }

  /**
   * 封面加载进度（0~1）。**分母由预热自己算**（列数 × 行窗口），不依赖图集的队列状态。
   *
   * 2026-10-22 主人：「加载页直接一个 100%，然后动画里还在补封面」。
   * 根因是进度依赖 `pending()` / 已分配槽位 —— 预热还没跑、或者图片重新入队时，
   * 这个数字会瞬间变成 1。现在改成「需要多少格 / 已经就绪多少格」，只增不减。
   */
  atlasProgress(): number {
    // 分母取「预期」与「已建成条目」的较大者：两者都只增不减，进度因此单调。
    const total = Math.max(this.warmTotal, this.warmPlanItems.length);
    if (total <= 0) return 0;
    return Math.min(1, this.warmReady / total);
  }

  /**
   * **由加载层用定时器驱动预热**（2026-10-24）。
   *
   * 为什么不能只挂在渲染循环里：`requestAnimationFrame` 在窗口被遮挡 / 最小化 / 后台时
   * 会被 Chromium 冻结 —— 实测 `frames=0`、`visibilityState='hidden'`，而 `raf` 句柄
   * 仍然非零，`start()` 的「句柄新鲜度」判断也救不回来。结果是预热一帧都不跑、
   * 进度恒为 0，加载层只能等 15 秒兜底，用户看到的就是「加载界面停留特别久甚至卡死」。
   *
   * 预热（建计划、CPU 烘焙、计数、GPU 上传）本来就不需要出帧，拆出来用定时器推进即可；
   * 渲染循环恢复后第一帧就会自然接上开场动画。
   */
  pumpLoader(): void {
    if (this.disposed || this.introReady) return;
    const now = performance.now();
    const dtMs = this.warmPumpAt === 0 ? 16 : Math.min(Math.max(now - this.warmPumpAt, 0), 250);
    this.warmPumpAt = now;
    if (!this.warmRequested) return;
    /*
     * 计划：分母只建一次（key 集合固化），条目分帧增量补齐。
     * 曲目还没到的列留在待补队列里，不阻塞其它列。
     */
    this.buildWarmPlan();
    let ready = 0;
    for (const item of this.warmPlanItems) {
      if (this.atlas.readyByKey(item.key) || this.atlas.keySettled(item.key)) {
        ready += 1;
      } else {
        // 兜底：格子可能被别的封面淘汰，重新占一个槽位并重新入队。
        this.atlas.slotFor(item.key, item.meta);
      }
    }
    this.warmReady = ready;
    if (this.prewarmFrames > 0 && this.catalog.columns.length > 0) this.prewarmFrames -= 1;
    // 烘焙 + 上传：CPU 画进画布、再整张传给 GPU，都不需要出帧。
    /*
     * 按**时间预算**烘焙，而不是固定张数：前台时 pump 每 16ms 跑一次，
     * 每次给 8ms 不会拖慢帧；后台被节流到 1Hz 时，这 8ms 依然能烘十几张，
     * 不至于"一秒只烘 6 张"（那样 600 张要 100 秒）。
     */
    const bakeStart = performance.now();
    while (performance.now() - bakeStart < 8) {
      if (this.atlas.flush(8) === 0) break;
    }
    this.atlas.commit(this.renderer, true);
    const warmed = this.catalog.columns.length > 0 && this.prewarmFrames === 0;
    this.warmElapsedMs += dtMs;
    /*
     * 超时收敛：迟迟不返回的列不再等，分母缩到已建成的计划；计划内拿不到的图标记为失败，
     * 走正常的排印卡烘焙事件。之后仍然由 `allReady`（真实状态）决定进场，不硬放行。
     */
    if (this.warmElapsedMs > 8000 && this.warmTotal > 0 && this.warmReady < this.warmTotal) {
      if (this.warmPendingLanes.length > 0) this.warmPendingLanes = [];
      this.warmTotal = this.warmPlanItems.length;
      for (const item of this.warmPlanItems) {
        if (!this.atlas.readyByKey(item.key) && !this.atlas.keySettled(item.key)) this.atlas.abandon(item.key);
      }
    }
    /*
     * 进场条件：所有列的计划都建完，且计划里每一张封面都到了终态，
     * 并且最后一次强制上传之后 GPU 侧也没有待传内容（CPU 画完 ≠ 屏幕上看得见）。
     */
    const allLanesPlanned =
      this.warmPendingLanes.length === 0 || this.warmPlanItems.length >= Math.max(0, this.atlas.capacity - 16);
    const allReady =
      this.warmTotal > 0 && allLanesPlanned && this.warmReady >= Math.max(this.warmTotal, this.warmPlanItems.length);
    if (warmed && allReady && !this.atlas.uploadPending()) this.introReady = true;
  }

  /** 调试用：`ready/total/planned` 三个数，用来分辨进度卡住的具体原因。 */
  warmDebug(): string {
    const c = this.catalog.columns[0];
    return [
      `${this.warmReady}/${this.warmTotal}/${this.warmPlanItems.length}`,
      `req=${this.warmRequested ? 1 : 0}`,
      `cols=${this.catalog.columns.length}`,
      `c0=${c?.count ?? -1}/${c?.cards.length ?? -1}`,
      `pre=${this.prewarmFrames}`,
      `pend=${this.warmPendingLanes.length}`,
      `raf=${this.raf === 0 ? 0 : 1}`,
      `age=${Math.round(performance.now() - this.lastTickMs)}`,
      `act=${this.active ? 1 : 0}/rev=${this.targetReveal}`,
      `ready=${this.introReady ? 1 : 0}/intro=${Math.round(this.introElapsedMs)}`,
    ].join(' ');
  }

  /**
   * **由加载界面调用：从这一刻开始预热图集、重新计时开场。**
   *
   * 2026-10-22 主人要求：加载界面要能看见真实进度。之前预热是在场景自己被激活时跑的，
   * 往往早于加载层挂载 —— 等界面出来时已经烘完了，进度条直接 100%。
   * 现在把"开始预热"的主动权交给加载层：它挂载 → 调这里 → 预热跑 → 进度可见 → 就绪 → 撤层。
   */
  beginWarmup(): void {
    this.introElapsedMs = 0;
    this.introWaveMs = 0;
    this.introReady = false;
    this.prewarmFrames = 2;
    this.warmElapsedMs = 0;
    this.warmPumpAt = 0;
    this.warmRequested = true;
    // 计划作废，下一次 tick 按当前 catalog 重建（进度从 0 开始）。
    this.warmPlanSig = '';
    this.warmPlanItems = [];
    this.warmPendingLanes = [];
    this.warmTotal = 0;
    this.warmReady = 0;
    this.atlas.resetProgress();
    this.start();
  }

  /**
   * 开场是否**已经真正开始**（图集预热完成、镜头开始走）。
   *
   * 载入层要等到这个为真才撤 —— 否则会出现「加载提示一消失，动画里封面还在补」
   * 的情况（2026-10-22 主人要的是：先加载界面，加载好了再进开场动画）。
   */
  introStarted(): boolean {
    return this.introReady;
  }

  /** 只给调试用：把封面图集导成 data URL（看「图集里到底装了什么」）。 */
  debugAtlas(): string {
    return this.atlas.debugDataUrl();
  }

  /** 只给调试用：核对「图集注入」到底生没生效 + 可选的强制 UV。 */
  debugShader(): { injected: boolean; hasCoverTile: boolean; hasReadyDiscard: boolean } {
    const shader = this.materials.cover.userData.rhineShader as
      | { vertexShader?: string; fragmentShader?: string }
      | undefined;
    const vertex = shader?.vertexShader ?? '';
    const fragment = shader?.fragmentShader ?? '';
    return {
      injected: shader !== undefined,
      hasCoverTile: vertex.includes('vMapUv = coverTile.xy'),
      hasReadyDiscard: fragment.includes('vCoverReady < 0.5'),
    };
  }

  /** 只给调试用：封面这一层的真实状态（有没有被画、材质有没有纹理）。 */
  debugCover(): Record<string, unknown> {
    const batch = this.batches.find((entry) => entry.name === 'rhine-cover');
    const material = this.materials.cover;
    const image = material.map?.image as { width?: number; height?: number } | undefined;
    return {
      batches: this.batches.map((entry) => ({ name: entry.name, visible: entry.visible, count: entry.count })),
      coverVisible: batch?.visible ?? null,
      coverCount: batch?.count ?? null,
      hasMap: material.map !== null,
      mapWidth: image?.width ?? -1,
      mapHeight: image?.height ?? -1,
      mapNeedsUpdate: material.map?.version ?? -1,
      color: `#${material.color.getHexString()}`,
      readyAttr: this.readyAttribute.array instanceof Float32Array ? Array.from(this.readyAttribute.array.slice(0, 6)) : null,
      tileAttr: this.tileAttribute.array instanceof Float32Array ? Array.from(this.tileAttribute.array.slice(0, 8)) : null,
    };
  }

  /** 只给调试用：把所有实例的瓦片坐标强写成给定值（`(0,0,1,1)` = 整张图集）。 */
  debugForceTile(u: number, v: number, du: number, dv: number): void {
    const tile = this.tileAttribute.array as Float32Array;
    for (let i = 0; i < this.drawnCount; i += 1) {
      tile[i * 4] = u;
      tile[i * 4 + 1] = v;
      tile[i * 4 + 2] = du;
      tile[i * 4 + 3] = dv;
    }
    this.tileAttribute.needsUpdate = true;
  }

  /** 只给调试用：把封面材质换成纯色（分辨「采样不对」还是「光照/材质把它照黑了」）。
   *
   *  **必须用一张小纯色贴图，不能把 `map` 置成 `null`**：置空会让 three 重编译程序时不再定义
   *  `USE_MAP`，而我们的注入里还写着 `vMapUv = coverTile.xy + …` ⇒ 顶点着色器编译失败
   *  （`'vMapUv' : undeclared identifier` + `useProgram: program not valid`）。
   *  这条错误第一次冒烟就出现在日志里，别让它有机会再出现。 */
  debugCoverColor(hex: string | null): void {
    if (hex === null) {
      this.materials.cover.map = this.atlas.texture;
      this.materials.cover.needsUpdate = true;
      return;
    }
    const color = new THREE.Color(hex);
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 4 * 4; i += 1) {
      data[i * 4] = Math.round(color.r * 255);
      data[i * 4 + 1] = Math.round(color.g * 255);
      data[i * 4 + 2] = Math.round(color.b * 255);
      data[i * 4 + 3] = 255;
    }
    const solid = new THREE.DataTexture(data, 4, 4, THREE.RGBAFormat);
    solid.colorSpace = THREE.SRGBColorSpace;
    solid.needsUpdate = true;
    this.debugSolid?.dispose();
    this.debugSolid = solid;
    this.materials.cover.map = solid;
    this.materials.cover.color.set('#ffffff');
    this.materials.cover.needsUpdate = true;
  }

  private debugSolid?: THREE.Texture;

  /** 只给调试用：一次报齐「选中那张的高度 / 副本数 / 焦点列画了几行 / 各列曲目数」。 */
  debugState(): {
    level: string;
    lane: number;
    row: number;
    lift: number;
    detail: number;
    ghosts: number;
    ghostLift: number;
    focusRows: number;
    drawn: number;
    counts: number[];
    pointerDown: boolean;
    lastWheel: { steps: number; held: boolean; horizontal: boolean; delta: number; level: string } | null;
    pointerLog: { down: number; up: number; cancel: number } | null;
    /** 相机列位置（连续值，格）。拖动是否平滑看它逐帧的差。 */
    cameraLane: number;
    /** 相机世界坐标（「挑歌时镜头不动」这一条的直测量）。 */
    camera: { x: number; y: number; z: number };
    /** 这台机器有没有开「减少动态效果」。 */
    reducedMotion: boolean;
    /** 场景实例编号（自增）。用来分辨「读数冻结」是场景停了、还是接缝指着旧实例。 */
    instanceId: number;
    /** 距离上一次 `update()` 过去了多少毫秒。 */
    updateAgeMs: number;
    /** `tick()` 距今多久（帧真的在跑就看它）。 */
    tickAgeMs: number;
    /** 排下一帧距今多久（`schedule` 新、`tick` 老 ⇒ 排了但被节流）。 */
    scheduleAgeMs: number;
    /** 当前是否排着下一帧、是否被判为激活、淡入目标值。 */
    rafActive: boolean;
    active: boolean;
    targetReveal: number;
    presence: number;
    /**
     * 拖拽标定的直读数（2026-10-24 查「近景档往下拖不动」）。
     *
     * `lane`/`row` 是两条世界轨道在屏幕上的像素位移：`row` 的模长接近 0 就说明
     * 行方向在屏幕上退化了 —— 无论手指怎么竖着拖，换算出的行变化都趋近 0。
     * `value` 是这一次手势当前分解出的格数。
     */
    drag: {
      lanePx: number;
      rowPx: number;
      lane: number;
      row: number;
      active: boolean;
      held: boolean;
    };
    cost: { update: number; bake: number; render: number; total: number };
    costPeak: { update: number; bake: number; render: number; total: number };
  } {
    let focusRows = 0;
    for (const lane of this.drawnLanes) if (lane === this.selectedLane) focusRows += 1;
    return {
      level: this.level,
      lane: this.selectedLane,
      row: this.selectedRow,
      lift: this.lift.value,
      detail: this.detail,
      ghosts: this.ghosts.length,
      ghostLift: this.ghosts[0]?.lift.value ?? -1,
      focusRows,
      drawn: this.drawnCount,
      counts: this.catalog.columns.map((column) => column.count).slice(0, 40),
      pointerDown: this.pointerId !== null,
      lastWheel: this.lastWheel,
      pointerLog: this.pointerLog,
      cameraLane: this.columnCamera.value / COLUMN_SPACING + LANE_ORIGIN,
      reducedMotion: this.reduced,
      instanceId: this.instanceId,
      updateAgeMs: Math.round(performance.now() - this.lastUpdateMs),
      tickAgeMs: Math.round(performance.now() - this.lastTickMs),
      scheduleAgeMs: Math.round(performance.now() - this.lastScheduleMs),
      rafActive: this.raf !== 0,
      active: this.active,
      targetReveal: this.targetReveal,
      presence: this.presence,
      drag: (() => {
        const projection = this.dragProjection();
        return {
          lanePx: Math.round(Math.hypot(projection.lane.x, projection.lane.y) * 10) / 10,
          rowPx: Math.round(Math.hypot(projection.row.x, projection.row.y) * 10) / 10,
          lane: Math.round(this.drag.value.lane * 100) / 100,
          row: Math.round(this.drag.value.row * 100) / 100,
          active: this.drag.active,
          held: this.pointerId !== null,
        };
      })(),
      /** 最近一帧 / 最慢一帧的分段耗时（毫秒）。 */
      cost: this.frameCost,
      costPeak: this.frameCostPeak,
      /** 相机世界坐标（「挑歌时镜头不动」这一条的直测量）。 */
      camera: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
    };
  }

  /** 只给调试用：读前几个实例的「瓦片坐标 / 是否可采样」，确认实例属性真的写进去了。 */
  debugTiles(): { tile: number[][]; ready: number[]; slot: number[]; drawn: number } {
    const tile = this.tileAttribute.array as Float32Array;
    const ready = this.readyAttribute.array as Float32Array;
    const count = Math.min(3, this.drawnCount);
    return {
      tile: Array.from({ length: count }, (_, i) => Array.from(tile.slice(i * 4, i * 4 + 4))),
      ready: Array.from({ length: count }, (_, i) => ready[i] ?? -1),
      slot: this.drawnSlots.slice(0, count),
      drawn: this.drawnCount,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.observer.disconnect();
    this.detachInput();
    this.atlas.dispose();
    this.materials.dispose();
    this.selectedMaterials.dispose();
    this.ghostMaterials.dispose();
    for (const ghost of [...this.ghosts, ...this.ghostPool]) {
      this.scene.remove(ghost.group);
      for (const child of ghost.group.children) {
        // 只有封面那张纸是副本自己的几何，其余四层与阵列共用，交给 surfaces.dispose()。
        if (child instanceof THREE.Mesh && child.material === ghost.cover) child.geometry.dispose();
      }
      ghost.cover.dispose();
    }
    this.ghosts = [];
    this.ghostPool.length = 0;
    this.ghostCells.clear();
    for (const batch of this.batches) {
      this.scene.remove(batch);
      batch.dispose();
    }
    this.surfaces.dispose();
    this.selectedCover.geometry.dispose();
    const floor = this.scene.getObjectByName('rhine-floor');
    if (floor instanceof THREE.Mesh) floor.geometry.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  /* ------------------------------------------------------------ 内容映射 */

  private column(lane: number): RhineColumnView | null {
    return this.catalog.columns[lane] ?? null;
  }

  private cardAt(lane: number, row: number): RhineCardView | null {
    const column = this.column(lane);
    if (column === null) return null;
    const index = row - ROW_ORIGIN;
    if (index < 0 || index >= column.count) return null;
    const loaded = column.cards[index];
    if (loaded !== undefined) return loaded;
    // 曲目还没加载：先用歌单封面铺一张占位卡（标题就是曲目序号）。
    return {
      key: `${column.key}#${index}`,
      title: `${index + 1}`.padStart(2, '0'),
      subtitle: column.title,
      coverUrl: column.coverUrl,
    };
  }

  private metaAt(lane: number, row: number): RhineCoverMeta | null {
    const card = this.cardAt(lane, row);
    if (card === null) return null;
    return { url: card.coverUrl, title: card.title, subtitle: card.subtitle };
  }

  private clampRow(lane: number, row: number): number {
    const count = this.column(lane)?.count ?? 0;
    if (count <= 0) return ROW_ORIGIN;
    return Math.max(ROW_ORIGIN, Math.min(ROW_ORIGIN + count - 1, Math.round(row)));
  }

  /**
   * 行位置**按曲目数取模**（2026-10-24 修「近景档拖不下去」）。
   *
   * 原来近景档用的是 `clampRow()`：拖到歌单第一首就夹死，再往下拖毫无反应 ——
   * 但阵列的绘制本来就是按 `column.count` 取模循环的，视觉上还有货架，
   * 于是就成了「画面还有盒子、手指却拖不动」。
   *
   * 改成取模后，往下拖会从最后一首绕回第一首，内容重复但轨迹连续，
   * 和总览档那条无限货架的行为一致。
   */
  private wrapRow(lane: number, row: number): number {
    const count = this.column(lane)?.count ?? 0;
    if (count <= 0) return ROW_ORIGIN;
    return ROW_ORIGIN + ((((Math.round(row) - ROW_ORIGIN) % count) + count) % count);
  }

  private displayRow(lane: number): number {
    return this.tracks[lane]?.row.value ?? ROW_ORIGIN;
  }

  /**
   * 构建（或复用）预热计划。
   *
   * 返回 true 表示计划可用（catalog 已到位）。签名包含「列数 + 每列曲目数 + 每列首卡 key」，
   * 只有歌单或曲目真的换了才重建，并顺带把进度清零 —— 这是进度单调的前提。
   */
  private buildWarmPlan(): boolean {
    if (!this.warmRequested) return false;
    const columns = this.catalog.columns;
    if (columns.length === 0) return false;
    /*
     * 签名只含**结构**（列数 + 每列曲目数），不含卡片内容：`count` 来自歌单元数据，
     * catalog 第一次到达时就定了。真正换歌单时列数/曲目数会变，签名变化，
     * 计划重建、进度归零，这是正确的一次性重置。
     */
    let sig = `${columns.length}`;
    for (const column of columns) sig += `|${column.count}`;
    if (sig !== this.warmPlanSig) {
      this.warmPlanSig = sig;
      this.warmPlanItems = [];
      this.warmPendingLanes = [];
      this.warmReady = 0;
      /*
       * **分母在这一刻就算出来，不等曲目返回**（2026-10-22）。
       *
       * 原来等所有列 `cards` 非空才建计划，于是曲目请求（24 个）还没回来的那几秒里
       * `warmTotal` 是 0 → 界面一直显示 0%，等曲目齐了又瞬间跳 100%。
       * 分母只依赖「列数 + 每列曲目数 + 行窗口 + 图集余量」，这些都是结构信息，
       * 拿到 catalog 立刻可算；分子仍然是真实的"已就绪封面数"，只增不减。
       */
      /*
       * **每列行数按容量均分**（2026-10-22 修复"动画里还在补封面"）。
       *
       * 之前每列取满行窗口（53 行），24 列就要 1272 格，而图集只有 512 ——
       * 计划被 budget 截断，实际只覆盖了前 10 列，剩下 14 列的封面根本没进计划，
       * 于是它们在动画里才逐张加载。现在按 `budget / 列数` 均分，
       * 保证**每一列都被覆盖**，只是纵向覆盖的行数少一些。
       */
      const halfRows = Math.round(VISIBLE_ROW_WINDOW / 2);
      const budget = Math.max(0, this.atlas.capacity - 16);
      const perColumn = Math.max(1, Math.min(halfRows * 2 + 1, Math.floor(budget / columns.length)));
      this.warmPerColumn = perColumn;
      let expected = 0;
      for (const column of columns) expected += Math.min(Math.max(0, column.count), perColumn);
      this.warmTotal = Math.min(expected, budget);
      for (let lane = 0; lane < columns.length; lane += 1) this.warmPendingLanes.push(lane);
    }
    /*
     * **条目一次建完**（2026-10-24）。
     *
     * 原来是「每帧一列」。前台时没问题，但后台定时器会被 Chromium 节流到 1Hz ——
     * 30 列就要 30 秒才建满计划，实测就是那样卡在 0% 附近的（`pend` 每 700ms 才减 1）。
     * 30 列 × 26 行 ≈ 780 次 `slotFor`，实测主线程开销 10ms 量级，一次做完更稳。
     * 曲目还没到的列放回队尾，本轮不再重试（否则会原地打转）。
     */
    const halfRows = Math.round(VISIBLE_ROW_WINDOW / 2);
    const perColumnRows = Math.min(this.warmPerColumn, halfRows * 2 + 1);
    const span = Math.floor(perColumnRows / 2);
    const budget = Math.max(0, this.atlas.capacity - 16);
    let guard = this.warmPendingLanes.length;
    while (this.warmPendingLanes.length > 0 && this.warmPlanItems.length < budget && guard > 0) {
      guard -= 1;
      const lane = this.warmPendingLanes.shift() as number;
      const column = this.column(lane);
      const cards = column?.cards ?? [];
      if (column === null || column.count <= 0) {
        // 空列：不需要封面，直接丢弃。
      } else if (cards.length === 0) {
        // 曲目还没到：放回队尾，下一轮再试。
        this.warmPendingLanes.push(lane);
      } else {
        /*
         * **每列只建它真正拥有的行数**（2026-10-25 修复「卡在开场首帧不动」）。
         *
         * 原来这里一律建 `perColumnRows` 行（41），行号按 `column.count` 取模 ——
         * 短歌单（4 首的列）会把同样 4 个 key 重复塞进计划 10 遍。
         * 于是 `warmPlanItems.length`(984) 比 `warmTotal`(901) 大，
         * 重复的 key 反复 `slotFor` 互相挤兑，永远有一批"刚分配、还没烘"的格子，
         * `allReady` 判不过，`introReady` 也就永远不置真 —— 画面停在开场第一帧。
         * 取模后的行本来就是循环的，同一个 key 只需要一张封面，去重完全不影响画面。
         */
        const rows = Math.max(1, Math.min(perColumnRows, column.count));
        for (let offset = 0; offset < rows; offset += 1) {
          if (this.warmPlanItems.length >= budget) break;
          const slotRow = ROW_ORIGIN - span + offset;
          const row = ROW_ORIGIN + ((((slotRow - ROW_ORIGIN) % column.count) + column.count) % column.count);
          const card = this.cardAt(lane, row);
          // 没有封面地址的格子不进计划：它们的终态就是排印卡，不需要等图。
          if (card === null || (card.coverUrl ?? '') === '') continue;
          const meta = this.metaAt(lane, row);
          if (meta === null || meta.url === undefined) continue;
          this.warmPlanItems.push({ key: card.key, meta });
        }
      }
    }
    return true;
  }

  /* ------------------------------------------------------------ 主循环 */

  private start(): void {
    if (this.disposed) return;
    // 同 `wake()`：句柄非零不代表这一帧还会来（窗口被节流时它会永远挂着）。
    const stale = performance.now() - this.lastTickMs > 500;
    if (this.raf !== 0 && !stale) return;
    this.last = 0;
    this.scheduleTick();
  }

  /** 排下一帧，并记下时刻（只给调试面看：分辨「没排」还是「排了没跑」）。 */
  private scheduleTick(): void {
    this.lastScheduleMs = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (time: number): void => {
    this.lastTickMs = performance.now();
    const seconds = time / 1000;
    const dt = this.last === 0 ? 0.016 : Math.min(Math.max(seconds - this.last, 0), 0.05);
    this.last = seconds;
    this.clock += dt;
    /*
     * **预热闸门的最终保险**（2026-10-22 修复「加载页一直 0%」）。
     *
     * 之前闸门靠 `setActive()` / `beginWarmup()` 打开，而这两条路径都依赖 React effect 的
     * 触发时机：加载层的 effect 可能早于场景创建（sceneRef 还是 null），
     * `setActive` 那条又挂在 `[active, catalog]` 上、catalog 不变化就不重跑。
     * 结果 `warmRequested` 一直是 false，计划不建、进度恒为 0。
     * 现在直接在渲染循环里兜底：只要这一层是激活态且闸门没开，就当场打开。
     */
    if (this.active && !this.warmRequested) {
      this.warmRequested = true;
      this.warmElapsedMs = 0;
      this.warmPlanSig = '';
      this.warmPlanItems = [];
      this.warmPendingLanes = [];
      this.warmTotal = 0;
      this.warmReady = 0;
      this.introReady = false;
      this.introElapsedMs = 0;
      this.introWaveMs = 0;
      this.prewarmFrames = 2;
    }
    /*
     * 开场镜头计时（只在展开态累积，收起后停在末尾，下次进入由激活逻辑归零）。
     *
     * **封面没烘完绝不推进**（2026-10-22 主人第二次指出：动画里还在加载封面）。
     *
     * 上一版的条件写错了：只有 `introElapsedMs === 0` 时才等，一旦第一帧把时钟推过 0，
     * 后面再忙也不等了 —— 于是动画照走，封面边飞边补。
     * 现在改成一个**单向的 `introReady` 闸门**：连续 4 帧 `pending() === 0` 才放行，
     * 中途只要又冒出待烘焙的格子就重新计数。放行前时钟一直是 0，画面停在白雾初帧，
     * 由加载提示层显示进度。
     */
    if (this.introReady) {
      this.introElapsedMs = Math.min(INTRO_MS + 1, this.introElapsedMs + dt * 1000);
      // 开场波自己的时钟：不夹在 INTRO_MS 上，让它把最后那几列也走完再散掉。
      this.introWaveMs = Math.min(this.introWaveMs + dt * 1000, 30000);
    }
    /*
     * 分段计时（2026-10-24 查「歌单页 → 歌曲选择页切换掉帧」）。
     * 只记最近一帧，开销是三次 `performance.now()`，可以常开；探针 `debugState().cost` 读它。
     */
    const tUpdate = performance.now();
    this.update(dt);
    /*
     * 拖动/惯性期间**不做封面烘焙与图集上传**（主人第四轮：「拖动时画面卡顿」）。
     * `flush()` 会在主线程上把封面画进 2048² 的画布，`commit()` 再往 GPU 传一块区域；
     * 拖着换列时新歌单的封面会成批到达，一帧里塞进几次烘焙 + 上传就是肉眼可见的一顿。
     *
     * 第五轮再加一条：**帧时间紧的时候也让路**。主人点一行播放时测到 p95 104ms ——
     * 那一刻播放器状态、封面解码、纹理上传挤在一起，烘焙这时再插一脚就是最后一根稻草。
     * 规则：上一帧已经超过 14ms（60fps 预算的 85%）就先不烘；但最多连着让 20 帧，
     * 免得在持续吃紧的机器上封面永远不出来（`bakeStarve` 计让路次数）。
     */
    const tightFrame = dt > 0.014;
    /*
     * 开场预热期间**不让路、并且一次多烘几张**：这段时间用户看的是加载界面，
     * 花 40ms 一帧把封面烘完，比一边动画一边补要好得多（2026-10-22）。
     * 开场开始之后回到"让路"策略，保证 60fps 附近不掉帧。
     */
    const warming = !this.introReady;
    const tBake = performance.now();
    if (warming) {
      this.atlas.flush(4);
      this.atlas.commit(this.renderer);
    } else if (!this.dragging && this.momentum === null && (!tightFrame || this.bakeStarve >= 20)) {
      this.atlas.flush();
      this.atlas.commit(this.renderer);
      this.bakeStarve = 0;
    } else if (!this.dragging && this.momentum === null) {
      this.bakeStarve += 1;
    }
    this.renderer.info.reset();
    const tRender = performance.now();
    this.composer.render();
    const tEnd = performance.now();
    this.frameCost = {
      update: Math.round(tUpdate - this.lastTickMs),
      bake: Math.round(tBake - tUpdate),
      render: Math.round(tEnd - tRender),
      total: Math.round(tEnd - this.lastTickMs),
    };
    // 记下最慢的一帧：切换瞬间那一帧很容易被下一次采样错过。
    if (this.frameCost.total > this.frameCostPeak.total) this.frameCostPeak = { ...this.frameCost };
    this.frameCount += 1;
    this.fpsWindow += dt;
    if (this.fpsWindow >= 0.5) {
      this.fps = this.frameCount / this.fpsWindow;
      this.frameCount = 0;
      this.fpsWindow = 0;
    }
    /*
     * **不再自己停车**（2026-10-22 最终决定）。
     *
     * 这块地方先后改成「presence 到底就停」「再加上 !active」都被实测抓到把激活中的画面
     * 停在过渡中间：详情档镜头停在低角度侧视、`lift/detail` 都是 0、进程活着、读数可读 ——
     * 看起来就是"卡死"。`presence` / `targetReveal` / `active` 三条线由 React 与阻尼分别驱动，
     * 它们之间任何一个瞬时不同步都会误触发停车，而这条省的只是"一帧 8 个 draw call"。
     *
     * 所以直接去掉停车：莱茵层挂上就一直跑到卸载（`dispose()` 里 cancelAnimationFrame）。
     * 代价是一点空转，换来的是永远不会停在半途 —— 之前三到七轮报的"卡死"里，
     * 这类"假死"占了很大一部分。
     */
    this.scheduleTick();
  };

  private update(dt: number): void {
    this.lastUpdateMs = performance.now();
    const columns = this.catalog.columns;
    this.selectedLane = Math.max(0, Math.min(Math.max(0, columns.length - 1), this.selectedLane));
    const focusLane = this.selectedLane;
    /*
     * 减少动态效果（`prefers-reduced-motion: reduce`）在这里是**加速**，不是**取消**。
     *
     * 之前的写法是 `this.reduced ? 1 : ...` / `? targetReveal` / `? cameraTarget` —— 一帧到位，
     * 于是「拖动时没有队列移动的动画，镜头直接切到下一组」（主人第五轮第 1 条）。
     * 参考实现那边也是加速（`reduced ? 35 : 7` 这种），不是瞬移；这里统一改成「约 0.15 秒到位」，
     * 既保留可读的方向感，也不会让人晕。
     */
    const presenceStep = this.reduced ? dt / 0.16 : dt / 1.1;
    this.presence += Math.sign(this.targetReveal - this.presence) * Math.min(presenceStep, Math.abs(this.targetReveal - this.presence));
    this.renderer.domElement.style.opacity = String(Math.max(0, Math.min(1, this.presence / 0.16)));
    this.reveal = this.reveal + (this.targetReveal - this.reveal) * (1 - Math.exp(-dt * (this.reduced ? 18 : 2.8)));

    this.shoulderElapsed += dt;
    // 波浪缓存一帧一清：位置、浪高、涟漪每一帧都在变，跨帧复用会看到「迟一帧的浪」。
    this.fieldCache.clear();
    const idle = this.clock > 2.5 && this.level !== 'detail' && this.momentum === null && !this.dragging;
    this.idleGain += ((idle ? 1 : 0) - this.idleGain) * (1 - Math.exp(-dt * 0.8));

    // 每列自己的行：总览压到中点；近景/详情把焦点列压到选中行；其余列回中点。
    const overview = this.level === 'overview';
    for (let lane = 0; lane < this.tracks.length; lane += 1) {
      const track = this.tracks[lane];
      if (track === undefined) continue;
      const isFocus = lane === focusLane;
      const target = overview ? track.midpoint : isFocus ? this.clampRow(lane, this.selectedRow) : track.midpoint;
      /*
       * 拖动里焦点列要跟着手走（近景/放大档的纵向拖拽）。这里必须**夹到这一列自己的行范围**：
       * `dragTrack.row` 是上一列的连续行号，横向拖到更短的歌单时它会落在那一列之外，
       * 于是 `writeInstances()` 的行窗口 `rowMin > rowMax`、整列一个盒子都不画 ——
       * 这就是「拖拽中 CD 盒队列忽然消失、松手才回来」（2026-10-17 修的）。
       * 总览档纵向是惰性的（列都停在自己中点），所以那里干脆不接管。
       */
      /*
       * **详情档里焦点列照常滑动**（主人 2026-10-21：「滚轮滚动切换歌曲时，没有波浪涌动式的过渡动画」）。
       *
       * 上一轮为了「挑歌时镜头不要切换」把这一列的行也冻住了，结果换歌时整面阵列一动不动，
       * 只剩右栏文字在变 —— 那种「涌动」感其实是两层叠出来的：整列**滑动**（行弹簧）+ 选中涟漪。
       * 镜头和盒子已经钉在锚点上了（`updateCamera` / `updateSelected` 都读 `detailAnchor`），
       * 所以这里放开滑动也不会再把镜头带跑；冻住的只有「相机取景」，不是「一整片阵列」。
       */
      if (isFocus && this.dragTrack !== null && !overview) {
        track.row.value = this.clampRow(lane, this.dragTrack.row);
        track.row.velocity = 0;
      } else if (isFocus && this.momentum !== null && !overview) {
        track.row.value = this.clampRow(lane, this.momentum.row.value);
        track.row.velocity = this.momentum.row.velocity * -ROW_SPACING;
      } else {
        damp(track.row, target, this.reduced ? 35 : DAMP_TRACK, dt);
      }
      damp(track.activity, isFocus ? 1 : 0, this.reduced ? 35 : DAMP_TRACK, dt);
    }
    damp(this.laneFocus, focusLane, this.reduced ? 35 : DAMP_LANE_FOCUS, dt);

    if (this.momentum !== null) {
      this.momentum.step(dt);
      this.navigatePlane(this.momentum.value.lane, this.momentum.value.row);
      if (this.momentum.phase === 'idle') this.momentum = null;
    }
    if (this.dragTrack !== null) {
      this.columnCamera.value = this.dragTrack.lane;
      this.columnCamera.velocity = 0;
    } else if (this.momentum !== null) {
      this.columnCamera.value = (this.momentum.lane.value - LANE_ORIGIN) * COLUMN_SPACING;
      this.columnCamera.velocity = this.momentum.lane.velocity * COLUMN_SPACING;
    } else {
      damp(this.columnCamera, (focusLane - LANE_ORIGIN) * COLUMN_SPACING, this.reduced ? 35 : DAMP_TRACK, dt);
    }

    const targetLift = this.level === 'detail' ? INSPECTION_LIFT : this.level === 'near' ? PREVIEW_LIFT : 0;
    damp(this.lift, targetLift, this.reduced ? 35 : DAMP_LIFT, dt);
    /*
     * 「详情档有多近」这个值，**详情档恒为 1**。
     *
     * 原来是 `smooth((lift - 0.8) / 2.4)` —— 也就是跟着抬起量算。换歌的升降动画会让 lift 从
     * 4.05 掉到 0 附近，于是 detail 掉下去、镜头往后拉（2026-10-21 主人：「镜头会向外移」）。
     * 详情档要的是「钉在 cd 盒详细展示的位置」，与盒子当前升到多高无关：盒子自己升降，
     * 机位不动。近景 → 详情的过渡仍然由 `this.detail` 的阻尼（5）自然完成。
     */
    /*
     * **详情档：机位恒定为「详细展示」那一档，不跟抬起量走**（主人 2026-10-21：
     * 「镜头不要向外移，要固定在 cd 盒详细展示的位置；cd 盒切换有对应的动画」）。
     *
     * 原来这里是 `ease((lift - 0.8) / 2.4)`——换歌时 lift 从 4.05 掉到 0 再升回来，
     * 机位于是跟着往后退、再推近，观感就是 "镜头会向外移"。现在这一档恒为 1：
     * 近景 → 详情的过渡仍由 `this.detail` 的阻尼完成，进了详情之后机位一动不动，
     * 动的只有盒子自己（从浪头升起）。②脚标：这条是**有意偏离参考**的，参考那边是跟 lift 的。
     */
    const cameraTarget =
      this.level === 'detail' ? 1 : smooth((this.lift.value - PREVIEW_LIFT) / (INSPECTION_LIFT - PREVIEW_LIFT));
    this.detail = this.detail + (cameraTarget - this.detail) * (1 - Math.exp(-dt * (this.reduced ? 18 : 5)));
    this.rotation =
      this.level === 'detail'
        ? this.rotation + (this.targetRotation - this.rotation) * (1 - Math.exp(-dt * 5))
        : this.rotation * Math.exp(-dt * 7);
    if (Math.abs(this.rotation) < 0.001) this.rotation = 0;

    this.pulses = this.pulses.filter((pulse) => this.clock - pulse.time < 3.2);
    if (this.hoverKey !== null && !this.hoverLifts.has(this.hoverKey)) this.hoverLifts.set(this.hoverKey, 0);
    for (const [key, value] of this.hoverLifts) {
      const target = key === this.hoverKey ? HOVER_LIFT : 0;
      const next = value + (target - value) * (1 - Math.exp(-dt * (this.reduced ? 40 : DAMP_HOVER)));
      if (target === 0 && next < 0.0001) this.hoverLifts.delete(key);
      else this.hoverLifts.set(key, next);
    }

    this.updateCamera(dt);
    this.writeInstances();
    this.updateGhosts(dt);
    this.updateSelected();
    this.updateLamp();
    this.emitFrame();
    this.notifyFocus(false);
  }

  /** 某个位置的波浪高度：选中肩部 + 开场传播波 + 静置呼吸 + 选中涟漪 + 悬停抬起。
   *  逐帧带缓存（一帧里同一个位置会被问 3 次：本体一次、算俯仰两次）。
   *
   *  焦点列在**选中行附近要把波浪压掉**（2026-10-17 主人的第 1 条）：参考把那道「肩部山丘」
   *  放进了交互场景（`scene.ts:1378` 把 `settlingWave(distance, 26.56) * columnStrength(...)`
   *  整项加了进去），而它的包络在 d=0 处有 2.15、d=±1 有 2.08 —— 比盒高 3.35 的六成还多。
   *  叠上涟漪（±0.6）之后，选中那张 「抬起 0.4」完全被前后两张的浪淹掉，
   *  这就是主人看到的「四周波浪乱浮、选中那张没高出来」。这里改成：
   *   · 焦点列整列不叠肩部与涟漪（`waveMask`），只留呼吸与台阶裙摆；
   *   · 另加一条**台阶裙摆** `PEAK_SKIRT * 0.5^|d|`，让两侧依次落下去（图 1 那种峰形）；
   *   · 别的列不动 —— 波浪是这套皮肤的底色，主人只点了「当前队列」。
   */
  /**
   * **歌单页专用的高度函数**（2026-10-22，按参考源码 `scene.ts:1500-1501` 对齐）。
   *
   *   settlingWave(距离, 常数 26.56) × columnStrength(列, 焦点列)   ← 静态肩部
   * + idleWave(距离, 列, 时间) × idleGain                          ← 极小呼吸
   *
   * 距离用**画面中心那一行**（`ROW_ORIGIN`）：歌单页的行是循环铺满的，按"真实选中行"
   * 算距离会让山丘落到视野外，视野里只剩 −0.42 的谷底。
   * 配套改动：总览档的相机瞄准点必须换成参考那组（`CAMERA_AIM_OVERVIEW`），
   * 否则整面墙被抬高 2.15 之后镜头会对着地板（上一轮实测一片过曝白就是这么来的）。
   */
  private overviewField(slotRow: number, lane: number): number {
    const distance = slotRow - ROW_ORIGIN;
    return (
      settlingWave(distance, SHOULDER_WAVE_TIME) * columnStrength(lane, this.laneFocus.value) +
      idleWave(distance, lane, this.clock) * this.idleGain
    );
  }

  /**
   * 开场波彻底收干净的时刻（毫秒）：编排结束 + 淡出时长 + 一点余量。
   *
   * 过了这一刻才切到 `overviewField()`（纯静态山丘）。淡出期间仍然走 `field()`，
   * 这样两套函数在切换点上给的值是同一个 —— 没有跳变。
   */
  private introWaveTailMs(): number {
    return INTRO_MS + INTRO_WAVE_FADE_MS + 200;
  }

  private field(lane: number, row: number): number {
    const key = cellKey(lane, row);
    const cached = this.fieldCache.get(key);
    if (cached !== undefined) return cached;
    /*
     * **总览档的「行距」必须和 `overviewField()` 同一个基准**（2026-10-25 修「开场结束波形跳变」）。
     *
     * 这里原来一律用 `row - displayRow(lane)`，而总览档每列的 `displayRow` 会滑到
     * 各自的 `midpoint`（= `ROW_ORIGIN + (曲目数-1)/2`，35 首的列是 18，453 首的列是 227）。
     * 也就是说**每列的波峰本来就落在不同行**。
     * 开场结束切到 `overviewField()` 时，基准突然变成统一的 `ROW_ORIGIN` ——
     * 整条波形平移十几行，看上去就是主人说的「凹的忽然变凸的」。
     * 现在总览档统一用取模后的行号对齐 `ROW_ORIGIN`，两套函数在几何上完全一致。
     */
    const distance =
      this.level === 'overview' ? this.wrapRow(lane, row) - ROW_ORIGIN : row - this.displayRow(lane);
    const focusLane = lane === this.selectedLane;
    const gap = Math.abs(row - this.selectedRow);
    /*
     * **抽出来那一列的波浪压到 1/3，但不关掉**。主人第三轮说「当前队列的 cd 盒波浪浮动不合理、
     * 选中那张要高出来」，第四轮又说「cd 盒没有正常表现波浪流动式的动画」——两次要求叠起来就是：
     * 波浪要留着，只是别把选中那张的抬升盖掉。
     *
     * 为什么不能只压选中行附近：肩部包络是 `2.15 - 0.17*(sqrt(d²+1)-1)`，衰减极慢（d=±4 还有 2.0）。
     * 只压 ±1 行的话，远处照旧抬着 ~1.0，选中那张就变成坐在「火山口」里 —— 第三轮第一版正是这么
     * 量的：台面 `[0.8, 0.4, 0.14, 0.16, 1.19, 0.19, 0.2, 0.48, 0.89]`，选中最高但两侧往上翘。
     * 所以整列按 `FOCUS_WAVE_KEEP` 等比压低（同相叠加，不改变「峰」的形状），
     * 再叠一条**台阶裙摆**（下面 `skirt`）把两侧顺势带下去。
     *
     * `peak` 随抬起量淡入：**总览档没有「抽出来那张」**（`lift` 恒为 0），那一档照旧整列满幅波浪 ——
     * 削平它会把总览的画面对比度一起带走（第三轮第一版就是这么把光照项量红的：84.7 → 59.3）。
     */
    const peak = Math.min(1, this.lift.value / PREVIEW_LIFT);
    const waveMask = focusLane ? 1 - peak * (1 - FOCUS_WAVE_KEEP) : 1;
    /*
     * **肩部用固定时刻采样，波形是静止的**（SOURCE: `Rhine-Music-Demo scene.ts:1500`
     * `settlingWave(distance, 26.56)` —— 第二个参数是**常数**，不是流逝时间）。
     *
     * 这是我这轮之前搞错的关键：我传的是 `this.shoulderElapsed`（一直增长的时钟），
     * 于是整条波形在持续变形 —— 一会儿两头翘、一会儿中间凹，看起来"很糟糕"。
     * 参考里这一项是静态的肩部山丘：形状不动，只有幅度很小的 `idleWave` 呼吸在动。
     */
    const shoulder = settlingWave(distance, SHOULDER_WAVE_TIME) * columnStrength(lane, this.laneFocus.value) * waveMask;
    /*
     * **入场波就是肩部那一条 `settlingWave`，不再额外叠一项。**
     *
     * 这里原来还有一条自己写的 `archiveWave()`，是照着"从中心向外扫过整面墙"手搓的；
     * 参考项目（RonaldDeng/Rhine-Music-Demo）的入场其实是同一个函数：
     * `settlingWave(row - center, shoulderTime) * activity`（`motion.ts:33` / `scene.ts:104`），
     * `shoulderTime` 从 0 长起来 ⇒ 浪从中心慢慢铺开再落定，然后进入静置呼吸。
     * 上面那行 `shoulder` 已经原样就是它，所以把自造的那一项删掉 —— 这是主人说的
     * 「入场的 cd 盒波浪动画参考这个项目」。
     */
    const breathing = idleWave(row - ROW_ORIGIN, lane, this.clock) * this.idleGain;
    /*
     * **开场波浪**（2026-10-22 主人：「补上波浪动画」）。SOURCE: 参考
     * `music-intro-motion.ts:77-89`：沿行方向推进、再回传的一张连续曲面。
     * 只在开场那几秒有值，`musicIntroWave` 自带包络，时间过了自然归零。
     */
    /*
     * **开场波用一条不会停在半路的时钟**（2026-10-25）。
     *
     * 原来这里用的是 `this.introElapsedMs`，而它在开场结束的那一刻就被 clamp 在
     * `INTRO_MS + 1` —— 于是 `musicIntroWave` 的相位一起冻住，
     * 左边那些还没走完的列会**永久挂着一个波峰**，没法自然散掉。
     * 换成 `introWaveMs`（不 clamp），它才能真的衰减到 0。
     */
    /*
     * **开场编排一结束就主动把入场波收掉**（2026-10-25 主人：「结束时应该就是凸的」）。
     *
     * 只让它自然衰减的话，最左边那几列要拖到 8 秒才干净（列与列之间有 0.16 秒延迟），
     * 观感上就是"动画早结束了、墙还在自己晃"。这里在 `INTRO_MS` 之后接一段 1.4 秒的淡出：
     * 波浪从"入场行波"平滑收成"静态肩部山丘"，结束时墙面已经是那个凸形，而且全程连续。
     */
    const introFade =
      this.introElapsedMs >= INTRO_MS
        ? Math.max(0, Math.min(1, 1 - (this.introWaveMs - INTRO_MS - 200) / INTRO_WAVE_FADE_MS))
        : 1;
    const introWaveValue =
      musicIntroWave(row - this.selectedRow, lane - this.selectedLane, this.introWaveMs / 1000) * introFade;
    /*
     * **不再自造横波/鼓包**（2026-10-22 第四轮，按参考真源码对齐后删掉）。
     *
     * 我先后加过"沿列方向的行波"和"径向鼓包"，都是照我自己的理解写的 ——
     * 对照 `Rhine-Music-Demo scene.ts:1448-1503` 的实际实现，那里根本没有这两项：
     *
     *   height = archiveWave(...)·scanBlend + idleWave(...)·idleGain          ← 只有入场扫光 + 呼吸
     *          + clamp(ripple, ±0.24)                                          ← 选中涟漪（有上限）
     *          + settlingWave(row − shoulder, 26.56)·columnStrength(lane)      ← **静态**肩部山丘
     *
     * 也就是说：墙的"形"是静态的肩部山丘（高度差来自它），"动"的只有极小的呼吸和涟漪。
     * 我额外叠的行波/鼓包让波形持续变形，才会出现"两头翘中间凹"这种怪相。
     * 现在把这两项删掉，与参考一致。
     */
    let ripple = 0;
    for (const pulse of this.pulses) {
      const spread = Math.hypot(row - pulse.row, (lane - pulse.lane) * 2.2);
      ripple += musicSelectionWave(spread, this.clock - pulse.time);
    }
    const hover = this.hoverLifts.get(cellKey(lane, row)) ?? 0;
    // 台阶裙摆：只在焦点列、且不落在选中那一格本身（那一格由 selected 那张自己承担抬起）。
    const skirt = focusLane && gap >= 1 ? PEAK_SKIRT * Math.pow(0.5, gap) * peak : 0;
    /*
     * 涟漪**按列分级**（2026-10-21 主人：「切换 cd 盒的过渡动画…不要太剧烈的波浪涌动，
     * 两边的 cd 盒队列更是要控制幅度」）：
     *  · 焦点列（被挑的那一列）：保留 60%，换歌时有清楚的起伏，但不再整列翻涌；
     *  · 两边的队列：只留 18%，基本是"轻轻带一下"，不再跟着一起翻。
     * 单项额外夹到 ±0.4（原来 ±0.6），保证任何一帧都不会大起大落。
     *
     * 为什么之前是满幅：第五轮主人说「没有波浪涌动」时，我把乘在涟漪上的 `waveMask`（0.34）拿掉了 ——
     * 那个遮罩本来是给静息肩部山丘用的，拿掉是对的；但拿掉之后又给了满幅，就过了。
     * 现在是「拿掉遮罩、但分开定幅」：焦点列 0.6、其余列 0.18。
     */
    const rippleScale = focusLane ? 1.25 : 0.28;
    const value =
      shoulder +
      breathing +
      introWaveValue +
      Math.max(-0.5, Math.min(0.5, ripple)) * rippleScale +
      hover +
      skirt;
    this.fieldCache.set(key, value);
    return value;
  }

  private readonly fieldCache = new Map<number, number>();

  /** 归位副本是否占着这一格（副本最多 4 个，数值比较，别拼字符串）。 */
  private isGhostCell(lane: number, row: number): boolean {
    for (const ghost of this.ghosts) {
      if (ghost.cell.lane === lane && ghost.cell.row === row) return true;
    }
    return false;
  }

  /** 只给调试用：焦点列上选中行前后各 4 行的台面高度明细（核对「选中那张是不是明显最高」）。 */
  debugPeak(): {
    lane: number;
    row: number;
    lift: number;
    rows: { row: number; field: number; lifted: number; total: number }[];
  } {
    const rows: { row: number; field: number; lifted: number; total: number }[] = [];
    /*
     * 量的是**实际画出来的那条高度**（2026-10-22）：总览档走 `overviewField()`（静态肩部），
     * 其他档走 `field()`。之前一律读 `field()`，于是总览档量到的是"没被画出来的那条路径"，
     * 剖面永远是 −0.4 的谷底，和截图完全对不上。
     */
    const sample = (row: number): number =>
      this.level === 'overview' ? this.overviewField(row, this.selectedLane) : this.field(this.selectedLane, row);
    for (let offset = -4; offset <= 4; offset += 1) {
      const row = ROW_ORIGIN + offset;
      const field = sample(row);
      const lifted = offset === 0 ? this.lift.value : (this.hoverLifts.get(cellKey(this.selectedLane, row)) ?? 0);
      rows.push({ row, field, lifted, total: field + lifted });
    }
    return { lane: this.selectedLane, row: this.selectedRow, lift: this.lift.value, rows };
  }

  private emitPulse(lane: number, row: number): void {
    this.pulses.push({ lane, row, time: this.clock });
    this.pulses = this.pulses.slice(-6);
  }

  /** 拖拽 / 惯性经过的位置：连续选档（不触发任何事件，也不重置平面）。 */
  private navigatePlane(laneValue: number, rowValue: number): void {
    const lane = this.clampLane(laneValue);
    const row = this.clampRow(lane, rowValue);
    if (lane === this.selectedLane && row === this.selectedRow) return;
    const changedLane = lane !== this.selectedLane;
    // 连续拖拽不产生副本（否则每次跨格都要留一张），但拖回正在归位的那一格要接住它。
    this.takeOverGhost(lane, row);
    this.selectedLane = lane;
    this.selectedRow = row;
    // 换到另一列时，那一列的显示位置要接住这次拖动（否则它会从自己中点弹过来）。
    const track = this.tracks[lane];
    if (changedLane && track !== undefined) track.row.value = row;
    this.notifyFocus(changedLane);
  }

  private selectCell(lane: number, row: number, pulse: boolean): void {
    this.wake();
    const changed = lane !== this.selectedLane;
    const targetLane = this.clampLane(lane);
    // 近景档允许绕回（同 `wrapRow` 的注释），其余档照旧夹取。
    const targetRow = this.level === 'near' ? this.wrapRow(targetLane, row) : this.clampRow(targetLane, row);
    const moved = targetLane !== this.selectedLane || targetRow !== this.selectedRow;
    /*
     * 换到另一格之前：把当前这张交给副本队列（它自己转正、沉回槽位），新那张从零高度升起。
     *
     * **详情档也照跑**（主人 2026-10-21 更正：「盒子不需要钉在锚点上，但是镜头需要；
     * 切换歌曲时应该是新的 cd 盒在浪头升起」）。上一轮我为了「挑歌时镜头别切换」把这一档的
     * 升降也停了，结果换歌时盒子纹丝不动、看不出「新的从浪里升起来」。
     * 镜头已经钉在锚点上（`updateCamera`），所以这里恢复升降不会再把取景带跑。
     */
    if (moved && !this.takeOverGhost(targetLane, targetRow)) this.spawnGhost();
    this.selectedLane = targetLane;
    this.selectedRow = targetRow;
    const track = this.tracks[this.selectedLane];
    if (changed && track !== undefined) track.row.value = this.selectedRow;
    if (pulse) {
      /*
       * 参考把选中波压到「新那张已经升到 0.35 以上」再扩散（SOURCE: `scene.ts:1469-1488`）：
       * 先让新档案升起来、附近的旧档案落到它下面，再放波。这边同一个判据 ——
       * 0.35 是参考 0.4 目标的 87.5%，我们的目标值放大了（`PREVIEW_LIFT`），按同一比例取。
       */
      if (this.reduced || this.level === 'detail' || this.lift.value < PREVIEW_LIFT * 0.875) {
        this.emitPulse(this.selectedLane, this.selectedRow);
      } else this.pendingPulse = { lane: this.selectedLane, row: this.selectedRow };
    }
    this.notifyFocus(changed);
  }

  private clampLane(lane: number): number {
    return Math.max(0, Math.min(Math.max(0, this.catalog.columns.length - 1), Math.round(lane)));
  }

  /**
   * **只夹不断**的列位置（保留小数）。
   *
   * 拖拽时相机是 1:1 跟手的（`columnCamera.value = dragTrack.lane`），所以这条连续值绝对不能被
   * 取整 —— 一旦取整，手在连续拉、镜头却整列整列地跳（主人第五轮第 1 条：「没有队列移动的动画，
   * 直接镜头切到下一个 cd 盒系列」正是这么来的，是上一轮我为了防越界把 `clampLane()` 用错了地方）。
   */
  private clampLaneRaw(lane: number): number {
    return Math.max(0, Math.min(Math.max(0, this.catalog.columns.length - 1), lane));
  }

  /* ------------------------------------------------------------ 归位副本（换选过渡） */

  /** 造一张副本：四层几何与阵列共用，封面是它自己的一张纸 + 单张瓦片采样的材质。 */
  private createGhost(): RhineGhost {
    const group = new THREE.Group();
    group.name = 'rhine-ghost';
    for (const [geometry, material] of [
      [this.surfaces.glass, this.ghostMaterials.glass],
      [this.surfaces.edge, this.ghostMaterials.edge],
      [this.surfaces.inlay, this.ghostMaterials.inlay],
      [this.surfaces.tray, this.ghostMaterials.tray],
    ] as const) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    const cover = this.ghostMaterials.cover.clone();
    // clone 会把 onBeforeCompile 一起带过来，先清掉再挂「单张瓦片」那版，避免双重注入。
    cover.onBeforeCompile = () => {};
    cover.customProgramCacheKey = () => 'rhine-ghost-cover';
    applySingleTileSampling(cover, this.atlasSize);
    const coverMesh = new THREE.Mesh(createSelectedCoverGeometry(), cover);
    coverMesh.castShadow = false;
    coverMesh.receiveShadow = true;
    group.add(coverMesh);
    group.visible = false;
    this.scene.add(group);
    return { group, cover, cell: { lane: 0, row: 0 }, lift: { value: 0, velocity: 0 }, rotation: 0 };
  }

  /**
   * 换选时把**当前这张**留在原地当副本。
   *
   * 参考：`const group = this.model.clone(true) … this.outgoing.push({…}); this.lift.value = 0;`
   * （SOURCE: `RhineLabUI src/scene.ts:720-763`）。它之后按 `returnStep` 先转正、再
   * `damp(o.lift, 0, …)` 沉回槽位（SOURCE: `scene.ts:1437-1468`）。
   */
  private spawnGhost(): void {
    if (this.reduced || this.presence <= 0.01) return;
    // 只有在「已经被抽起来」的时候才有得可归位；总览档本来就没抽起来，不产生副本。
    if (this.lift.value <= 0.02 || this.level === 'overview') return;
    const ghost = this.ghostPool.pop() ?? this.createGhost();
    // 上限：连切太快时把最旧的那一枚直接归位，代价封顶（见 GHOST_LIMIT 的注释）。
    while (this.ghosts.length >= GHOST_LIMIT) this.releaseGhost(0);
    ghost.cell = { lane: this.selectedLane, row: this.selectedRow };
    ghost.lift.value = this.lift.value;
    ghost.lift.velocity = this.lift.velocity;
    ghost.rotation = this.selected.rotation.y;
    // 封面：沿用这一格当前在用的图集槽位（副本与阵列里那一格长得一模一样）。
    const meta = this.metaAt(ghost.cell.lane, ghost.cell.row);
    const card = this.cardAt(ghost.cell.lane, ghost.cell.row);
    const key = card?.key ?? `${ghost.cell.lane}:${ghost.cell.row}`;
    const slot = this.atlas.slotFor(key, meta ?? { title: '' });
    this.atlas.touch(slot);
    this.writeGhostTile(ghost, slot);
    ghost.group.visible = true;
    this.ghosts.push(ghost);
    this.ghostCells.add(`${ghost.cell.lane}:${ghost.cell.row}`);
    // 新的一张从队列里升起。
    this.lift.value = 0;
    this.lift.velocity = 0;
    this.rotation = 0;
    this.targetRotation = 0;
  }

  /** 把某一格的副本交还给选中的那张（快速切回来时保留当前升降状态）。 */
  private takeOverGhost(lane: number, row: number): boolean {
    const index = this.ghosts.findIndex((ghost) => ghost.cell.lane === lane && ghost.cell.row === row);
    if (index < 0) return false;
    const ghost = this.ghosts[index];
    if (ghost === undefined) return false;
    this.lift.value = ghost.lift.value;
    this.lift.velocity = ghost.lift.velocity;
    this.rotation = ghost.rotation;
    this.releaseGhost(index);
    return true;
  }

  private releaseGhost(index: number): void {
    const ghost = this.ghosts[index];
    if (ghost === undefined) return;
    this.ghosts.splice(index, 1);
    this.ghostCells.delete(`${ghost.cell.lane}:${ghost.cell.row}`);
    ghost.group.visible = false;
    this.ghostPool.push(ghost);
  }

  private writeGhostTile(ghost: RhineGhost, slot: number): void {
    const tile = ghost.cover.userData.rhineTile as { value: THREE.Vector4 } | undefined;
    const ready = ghost.cover.userData.rhineReady as { value: number } | undefined;
    const rect = this.atlas.tileRect(slot);
    if (tile !== undefined) tile.value.set(rect.x, rect.y, rect.z, rect.w);
    if (ready !== undefined) ready.value = this.atlas.ready(slot) ? 1 : 0;
  }

  private updateGhosts(dt: number): void {
    for (let i = this.ghosts.length - 1; i >= 0; i -= 1) {
      const ghost = this.ghosts[i];
      if (ghost === undefined) continue;
      if (this.reduced) {
        this.releaseGhost(i);
        continue;
      }
      // 先转正、后下沉：转正没完成之前保持高度（参考那条注释与 `returnStep` 的次序）。
      ghost.rotation = returnStep(ghost.rotation, dt, this.reduced);
      if (ghost.rotation === 0) damp(ghost.lift, 0, DAMP_RETURN, dt);
      if (ghost.lift.value < 0.001 && ghost.rotation === 0) {
        this.releaseGhost(i);
        continue;
      }
      const position = this.cellPosition(ghost.cell.lane, ghost.cell.row);
      position.y += ghost.lift.value;
      ghost.group.position.copy(position);
      const slope =
        this.field(ghost.cell.lane, ghost.cell.row + 0.5) - this.field(ghost.cell.lane, ghost.cell.row - 0.5);
      ghost.group.rotation.set(
        slope * SLOPE_TILT * (1 - this.detail) * (1 - smooth(ghost.lift.value / PREVIEW_LIFT)),
        ghost.rotation,
        0,
      );
    }
    // 新那张升到目标高度的 87.5% 之后再扩散选中波（同时要求附近的副本已经落到它下面）。
    if (this.pendingPulse !== null) {
      const selectedY = this.cellPosition(this.selectedLane, this.selectedRow).y + this.lift.value;
      const lower = this.ghosts.every(
        (ghost) =>
          ghost.cell.lane !== this.selectedLane ||
          Math.abs(ghost.cell.row - this.selectedRow) > 5 ||
          ghost.group.position.y + 0.015 < selectedY,
      );
      if (this.lift.value >= PREVIEW_LIFT * 0.875 && lower) {
        this.emitPulse(this.pendingPulse.lane, this.pendingPulse.row);
        this.pendingPulse = null;
      }
    }
  }

  /* ------------------------------------------------------------ 相机 */

  private updateCamera(dt: number): void {
    const container = this.options.container;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const detail = this.detail;
    /*
     * **两个档位各有一套取景**（2026-10-22 主人说清楚了两件事）：
     *   · 歌单选择页（`overview`）＝ **高机位、看得见更多列**，拖拽推动整面阵列来浏览；
     *   · 歌单内选歌（`near`）＝ 原来的低机位，贴着列看封面。
     * 之前两档共用一组常量，所以要么总览不够高、要么近景太高，无论怎么调都只能满足一边。
     */
    const overview = this.level === 'overview';
    const elevationDeg = overview ? CAMERA_ELEVATION_OVERVIEW_DEG : CAMERA_ELEVATION_DEG;
    const baseSpan = overview ? CAMERA_SPAN_OVERVIEW : CAMERA_SPAN;
    const baseDistance = overview ? CAMERA_DISTANCE_OVERVIEW : CAMERA_DISTANCE_PREVIEW;
    const span = baseSpan + (CAMERA_SPAN_DETAIL - baseSpan) * detail;
    const framing = archiveFraming(width, height, span, detail, width < 900);
    /*
     * **开场编排照抄参考**（2026-10-22 主人：「参考项目的这段很好看，而且要有波浪」）。
     *
     * SOURCE: `Rhine-Music-Demo src/music-intro-motion.ts:45-59`（`musicIntroPose`）。
     * 参考里不是"简单换个角度"，而是一条四通道的关键帧轨道：
     *
     *   yaw       89 → 85 → 59          （先侧看，再转到俯视正式角度）
     *   elevation 36 → 40 → 25
     *   distance  38 → 42 → 140         （相机沿轴向后拉，形成"轴向推轨"）
     *   aimZ      22 → 2 → 4 → 2 → 0.481（瞄准点从很远的前方退回到正式位置）
     *   settle    76 → 112              （摆动收尾的进度）
     *
     * 采样率 25 帧/秒，参考的出场段约 4.76 秒。这里按同一组关键帧插值，
     * 收尾后完全等于正式机位，不影响后续任何档位。
     */
    const introFrame = 1 + (this.introElapsedMs / 1000) * 25;
    const smoother = (value: number): number => {
      const t = Math.max(0, Math.min(1, value));
      return t * t * t * (10 + t * (-15 + 6 * t));
    };
    const trackKey = (frame: number, keys: readonly (readonly [number, number])[]): number => {
      const first = keys[0];
      if (first === undefined) return 0;
      if (frame <= first[0]) return first[1];
      for (let index = 1; index < keys.length; index += 1) {
        const entry = keys[index];
        const previousEntry = keys[index - 1];
        if (entry === undefined || previousEntry === undefined) continue;
        const [end, value] = entry;
        const [start, previous] = previousEntry;
        if (frame <= end) return previous + (value - previous) * smoother((frame - start) / (end - start));
      }
      const last = keys[keys.length - 1];
      return last === undefined ? 0 : last[1];
    };
    const settle = Math.min(1, Math.max(0, smoother((introFrame - 76) / 36)));
    const yawDeg = trackKey(introFrame, [[1, 89], [44, 85], [80, 59]]);
    const elevationDegIntro = trackKey(introFrame, [[1, 36], [45, 40], [80, 25]]);
    const distanceIntro = trackKey(introFrame, [[1, 38], [44, 42], [88, 140]]);
    const aimZIntro = trackKey(introFrame, [[1, 22], [15, 2], [32, 4], [76, 2], [112, 0.481]]);
    const aimYIntro = trackKey(introFrame, [[1, -2.55], [44, -1.7], [112, -0.045]]);
    const introMix = 1 - settle;
    const yaw = THREE.MathUtils.degToRad(
      THREE.MathUtils.lerp(yawDeg, overview ? CAMERA_YAW_OVERVIEW_DEG : CAMERA_YAW_DEG, settle),
    );
    const elevation = THREE.MathUtils.degToRad(
      THREE.MathUtils.lerp(elevationDegIntro, elevationDeg, settle),
    );
    const viewDirection = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(yaw) * Math.cos(elevation),
    )
      .lerp(new THREE.Vector3(...CAMERA_DETAIL_DIR), detail)
      .normalize();
    const distance = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(baseDistance, CAMERA_DISTANCE_DETAIL, detail),
      Math.max(distanceIntro, baseDistance),
      introMix,
    );
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), viewDirection).normalize();
    const up = new THREE.Vector3().crossVectors(viewDirection, right).normalize();
    /*
     * 总览档的瞄准点换成参考那一组（高 −1.8、z −1.5）：这一档的墙是"静态肩部山丘"，
     * 中心比基线高 2.15，沿用近景的 −0.045 会把镜头对着地板。
     * SOURCE: `Rhine-Music-Demo src/scene.ts:1857`。
     */
    const aim = new THREE.Vector3(
      ...(overview ? CAMERA_AIM_OVERVIEW : CAMERA_AIM),
    )
      .add(new THREE.Vector3(0, (aimYIntro ?? 0) * introMix, (aimZIntro - (overview ? CAMERA_AIM_OVERVIEW[2] : CAMERA_AIM[2])) * introMix));
    if (detail > 0.0001) {
      // 抽出来的那一张要落在屏幕的 (detailX, detailY)：参考靠**移动镜头**完成构图，
      // 不移动卡片本身（SOURCE: `scene.ts:1634-1639`）。
      const pixelScale = height / framing.span;
      const anchor = this.level === 'detail' ? this.detailAnchor : null;
      const anchored = anchor !== null;
      const cardWorld = anchor !== null ? anchor.clone() : this.cellPosition(this.selectedLane, this.selectedRow);
      /*
       * 瞄准点必须是**卡片真正所在的位置**：槽位 + 抬起量 + 半盒高。
       * 少了 `lift` 这一项，详情档（抬起 4.05）的镜头还盯着空槽位，卡片整个跑到画面上方 ——
       * 主人第四轮看到的就是「镜头没有聚焦在 cd 盒、只看到一大片阵列和盒子背面/底面」
       * （2026-10-17 修）。参考那边是瞄准抽出来那张的中心（SOURCE: `scene.ts:1634-1639`）。
       *
       * **详情档例外**：锚点里已经含了落定的 `INSPECTION_LIFT`，这里**不能再加实时 lift** ——
       * 加了就会跟着换歌的升降动画上下飘（2026-10-21「镜头没有盯住」）。
       */
      if (!anchored) cardWorld.y += this.lift.value;
      cardWorld.y += CASE_HEIGHT / 2;
      const detailAim = cardWorld
        .addScaledVector(right, (0.5 - framing.detailX) * (width / pixelScale))
        .addScaledVector(up, (framing.detailY - 0.5) * (height / pixelScale));
      aim.lerp(detailAim, detail);
    }
    const position = aim.clone().addScaledVector(viewDirection, distance);
    /*
     * 指针视差已去掉（主人 2026-10-21：「切换 cd 盒时锁定这个视角」）。
     * 原来鼠标在画面里移动会让机位横向/纵向漂 ±0.12，换列时配合整列滑动很容易被看成
     * 「镜头也跟着动」。锁定视角之后：机位只由档位（`detail`）决定，切换盒子时一动不动，
     * 动的是底下的阵列。
     */
    // 相机跟随同样是「加速不取消」：减少动态效果时 ~0.15 秒到位，而不是一帧瞬移（第五轮第 1 条）。
    const blend = this.reduced ? Math.min(1, 1 - Math.exp(-dt * 18)) : Math.min(1, Math.max(0.05, 1 - Math.exp(-dt * 5)));
    this.camera.position.lerp(position, blend);
    this.cameraAim.lerp(aim, blend);
    this.camera.lookAt(this.cameraAim);
    const targetFov = THREE.MathUtils.radToDeg(2 * Math.atan(framing.span / (2 * distance)));
    this.camera.fov = this.camera.fov + (targetFov - this.camera.fov) * blend;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    // 雾锚在**实际**相机距离上：目标距离刚变、相机还没跟上时，锚早了阵列会被远雾吞掉
    // （SOURCE: `scene.ts:1662-1669`；暗档的偏移也照它那套 `5-4*theme` / `25-9*theme`）。
    const fog = this.scene.fog as THREE.Fog;
    const renderedDistance = this.camera.position.distanceTo(this.cameraAim);
    const dark = Number(this.isDark);
    fog.near = renderedDistance + THREE.MathUtils.lerp(FOG_NEAR_OFFSET - 4 * dark, FOG_NEAR_OFFSET_DETAIL, detail);
    fog.far = renderedDistance + THREE.MathUtils.lerp(FOG_FAR_OFFSET - 9 * dark, FOG_FAR_OFFSET_DETAIL, detail);
  }

  private cellPosition(lane: number, row: number): THREE.Vector3 {
    return new THREE.Vector3(
      (lane - LANE_ORIGIN) * COLUMN_SPACING - this.columnCamera.value,
      ARRAY_BASE_Y + this.field(lane, row),
      (row - this.displayRow(lane)) * ROW_SPACING + this.entryZ(),
    );
  }

  private entryZ(): number {
    return -28 * (1 - this.reveal);
  }

  /* ------------------------------------------------------------ 实例写入 */

  private writeInstances(): void {
    this.frustumMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    const trackX = this.columnCamera.value;
    const entryZ = this.entryZ();
    const matrixArray = (this.batches[0]?.instanceMatrix.array ?? new Float32Array(0)) as Float32Array;
    const tileArray = this.tileAttribute.array as Float32Array;
    const readyArray = this.readyAttribute.array as Float32Array;
    const ghostOccupied = this.ghosts.length > 0;
    let index = 0;
    this.drawnLanes.length = 0;
    this.drawnRows.length = 0;
    this.drawnSlots.length = 0;
    /*
     * 行窗口：三档统一用「绘制窗口」与「预热计划覆盖行数」的较小者 ——
     * **画出来但没烘过封面 = 空盒子**（2026-10-24 截图里左上角那块空白就是这样来的）。
     *
     * 2026-10-24 又加一条：近景/详情原来取 `covered × 1.5`（约 63 行），
     * 而预热只覆盖 41 行 —— 切档瞬间要多烘 20 行 × 30 列 ≈ 600 张新封面，
     * 那一次 `composer.render()` 实测要 290ms。现在三档都对齐到 `covered`，
     * 切档不再引入新的图集内容。
     */
    const covered = this.warmPerColumn > 0 ? Math.min(VISIBLE_ROW_WINDOW, this.warmPerColumn) : VISIBLE_ROW_WINDOW;
    /*
     * **`half` 必须取整**（2026-10-24 实测的满墙排印卡）。
     *
     * `covered` 是 33 这种奇数时，`Math.round(33 * 1.5) / 2` 或 `33 / 2` 会得到 16.5 ——
     * 循环从 `ROW_ORIGIN - 16.5` 开始，`slotRow` 变成小数，取模后的 `row` 也是小数，
     * `cardAt()` 全部落空、key 与预热计划完全对不上，于是整面墙都退化成"01/02/03"排印卡。
     */
    /*
     * 行窗口 = 图集能覆盖的行数（两者严格相等）。总览档也用它，不再额外放大 ——
     * 放大出来的行没有自己的封面，只能靠取模复用，而主人 2026-10-25 指出那正是
     * 「循环里多出一批没有内容的歌占位置」的来源。现在窗口内每一行都是这一列里
     * 各不相同的曲目，第 `covered + 1` 行才回到第 1 首，才是真正的首尾相接。
     */
    const half = Math.floor(covered / 2);
    /*
     * **循环绘制**（2026-10-22 主人：「歌单页会存在没有 cd 盒列的部分，两头连上消除空虚」）。
     *
     * 列本身在世界里是有限的一段（`列数 × 间距`）。除了照常画一遍，再按这一段的长度往左右
     * 各复制一份 —— 于是拖到一端时，另一端的列会从画外接着出现，看不到"墙的尽头"。
     * 只是**视觉**上的循环：焦点列、拖拽边界、选中项都没有绕回（那是另一套状态机），
     * 所以拖到尽头时"选中"仍会停在最后一列，但画面里不会有空白带。
     *
     * 成本可控：三份复制都走同一套视锥剔除与行窗口，画外的不会进实例缓冲。
     */
    const worldLength = this.catalog.columns.length * COLUMN_SPACING;
    const laneShifts = worldLength > 0 ? [-worldLength, 0, worldLength] : [0];
    for (const shift of laneShifts) {
      for (let lane = 0; lane < this.catalog.columns.length; lane += 1) {
        const column = this.column(lane);
        if (column === null || column.count <= 0) continue;
        /*
         * **总览档（歌单页）的列是静态货架**（2026-10-22 主人对着录屏指出：
         * 「歌单页拖拽时 cd 盒列的 cd 盒会滚动，这是不正确的，歌单页不应该有歌曲 cd 盒的移动」）。
         *
         * 行偏移固定在第一行：这一档只允许**整列横向移动**（换歌单），列内的盒子一动不动。
         * 近景/详情档照旧跟 `displayRow` 走，那里的纵向滑动是"换歌"的动画。
         */
        const center =
          this.level === 'overview'
            ? ROW_ORIGIN
            : Math.min(
                Math.max(this.displayRow(lane), ROW_ORIGIN),
                ROW_ORIGIN + column.count - 1,
              );
        /*
         * **总览档的行也循环**（2026-10-22 主人：「cd 盒队列纵向又有空缺，实际上也是无限延伸」）。
         *
         * 行窗口只按"这一列有几首"来算的话，歌单短的那几列上下就是空的。这里把窗口固定成
         * 一整条可见带（`ROW_ORIGIN ± half`），内容按 `column.count` 取模重复 —— 于是每一列
         * 都是一条**无限长的货架**：短歌单也会被自己的曲子铺满，看不到空缺。
         * 近景/详情档不做循环（那里行号就是曲子序号，循环会让同一个盒子出现两次）。
         */
        /*
         * **每一档都循环**（2026-10-22 主人：某列歌少时近景会空出一块，要循环填满）。
         * 之前只有总览档循环，近景/详情按真实行号取，短歌单上下就是空的。
         */
        const looping = true;
        /*
         * **行范围要以「这一列当前中心」为基准，而不是从第 0 行往后铺**（2026-10-24）。
         *
         * 原来固定写 `ROW_ORIGIN - half … ROW_ORIGIN + half`：总览档 `center` 正好是
         * `ROW_ORIGIN`，看起来没问题；但近景/详情档 `center` 是当前选中的那一首，
         * 于是整条窗口全落在中心的一侧 —— 焦点卡被推到画面最下沿，它上方一大片直接
         * 没有盒子（用户截图的框选区域）。改成 `center ± half` 后，焦点卡居中、上下都有货架。
         * 行号仍然按 `column.count` 取模循环，短歌单也不会露白。
         */
        const rowMin = Math.round(center - half);
        const rowMax = Math.round(center + half);
        const x = (lane - LANE_ORIGIN) * COLUMN_SPACING - trackX + shift;
        /*
         * 循环的模数 = **这一列的曲目总数**（2026-10-25 主人：「无限循环是歌单里
         * 歌曲首尾相接，而不是多出无内容的歌曲占位置」）。
         *
         * 上一版这里取的是 `min(曲目数, 已烘行数)`，本意是"复用已烘封面、避免白盒"，
         * 但视觉效果就是第 41 行跳回第 1 首 —— 一列 335 首的歌单，画面上只在前 40 首里打转，
         * 看起来像凭空多了一批空壳。现在回到曲目总数，配合行窗口与图集覆盖行严格相等，
         * 窗口内每行都是不同的曲子，第 61 行之后才绕回第 1 首。
         */
        const rowMod = column.count;
        for (let slotRow = rowMin; slotRow <= rowMax; slotRow += 1) {
          // 循环档：屏幕上的槽位 `slotRow` 映射回这一列真实的行号 `row`（取模）。
          const row = looping ? ROW_ORIGIN + ((((slotRow - ROW_ORIGIN) % rowMod) + rowMod) % rowMod) : slotRow;
          // 选中那一格由 `selected` 那张自己画；被归位副本占着的格子也跳过（否则同格画两个盒子）。
          // 都用**数值比较**：这里是每帧每格都要走的路径，拼字符串会白白产生一堆短命对象。
          if (shift === 0 && lane === this.selectedLane && row === this.selectedRow) continue;
          if (ghostOccupied && this.isGhostCell(lane, row)) continue;
          // 位置按**槽位**算（不按内容行号），所以循环时盒子不会沿着列滑动，只是内容在重复。
          const z = (slotRow - center) * ROW_SPACING + entryZ;
          /*
           * 先用「波浪最多能抬到多高」的整段高度做一次**便宜的**外层筛选，过了再算真实浪高。
           * 为什么非这样不可：候选位置是「列数 × 行窗口」（歌单多的时候四千多个），
           * 而 `field()` 里有 exp/sin —— 四千多次逐帧算下来就是几毫秒白烧。
           * 波浪的幅值有界（肩部 ±2.15、涟漪 ±0.6、呼吸 0.1、开场波 ±2.5），
           * 所以这块板覆盖得住任何一帧的真实高度，不会漏掉该画的盒子。
           */
          this.probeBox.min.set(x - 2.4, ARRAY_BASE_Y - 2.3, z - 0.6);
          this.probeBox.max.set(x + 2.4, ARRAY_BASE_Y + CASE_HEIGHT + 2.3, z + 0.6);
          if (!this.frustum.intersectsBox(this.probeBox)) continue;
          /*
           * **开场那几秒用 `field()`，让波浪动起来**（2026-10-22 主人对照录屏：
           * 「开场动画缺少波浪浮动的动画」）。
           *
           * `overviewField()` 是歌单页那条静态的山丘（为了"拖拽时不晃"特意去掉了一切时间项），
           * 但开场需要的是 `field()` 里那套东西：`introWaveValue`（按列错相位的行波）
           * + 呼吸 + 涟漪。所以开场期间走 `field()`，`introElapsedMs` 走完再切回静态场。
           */
          /*
           * **只有总览档（歌单页）用静态山丘**（2026-10-24 修复「歌曲选择页没有波浪」）。
           *
           * `overviewField()` 是特意去掉一切时间项的静态场，动机是「歌单页横向拖拽时不要晃」。
           * 但上一版的条件写成了 `looping && intro 已结束`，而 `looping` 三档都是 true ——
           * 于是**近景/详情档也用了这个静态场**，切换歌曲时整列盒子纹丝不动，
           * 波浪浮动就整个没了。现在按档位判断：只有 overview 用静态场，
           * 近景与详情继续走 `field()`（`introWaveValue` 行波 + 呼吸 + 涟漪）。
           */
          const y =
            ARRAY_BASE_Y +
            (this.level === 'overview' && this.introElapsedMs >= INTRO_MS && this.introWaveMs >= this.introWaveTailMs()
              ? this.overviewField(slotRow, lane)
              : this.field(lane, row));
          const slope = this.field(lane, row + 0.5) - this.field(lane, row - 0.5);
          this.dummy.position.set(x, y, z);
          this.dummy.rotation.set(slope * SLOPE_TILT * (1 - this.detail), 0, 0);
          this.dummy.scale.setScalar(1);
          this.dummy.updateMatrix();
          matrixArray.set(this.dummy.matrix.elements, index * 16);
          const card = this.cardAt(lane, row);
          const key = card?.key ?? `${lane}:${row}`;
          const slot = this.atlas.slotFor(key, this.metaAt(lane, row) ?? { title: `${row - ROW_ORIGIN + 1}` });
          this.atlas.touch(slot);
          this.atlas.writeTile(tileArray, index * 4, slot);
          readyArray[index] = this.atlas.ready(slot) ? 1 : 0;
          if (shift === 0) {
            this.drawnLanes.push(lane);
            this.drawnRows.push(row);
            this.drawnSlots.push(slot);
          }
          index += 1;
          if (index >= INSTANCE_CAPACITY) break;
        }
        if (index >= INSTANCE_CAPACITY) break;
      }
      if (index >= INSTANCE_CAPACITY) break;
    }
    this.drawnCount = index;
    for (const batch of this.batches) {
      batch.count = index;
      batch.instanceMatrix.needsUpdate = true;
      batch.visible = index > 0 && this.presence > 0.01;
    }
    this.tileAttribute.needsUpdate = true;
    this.readyAttribute.needsUpdate = true;
  }

  /**
   * 抽出来那张的**世界位置（含抬起量）**。
   *
   * 2026-10-21 主人更正：「盒子不需要钉在锚点上，但是**镜头**需要；切换歌曲时应该是新的 cd 盒
   * 在浪头升起」。所以盒子**跟着槽位走**（整列滑动时它随之移动，配合换歌的升降 = 从浪头升起），
   * 钉住的只有镜头（`updateCamera` 里仍然读 `detailAnchor`）——阵列滑过一行之后，新那张正好
   * 落到原来那个屏幕位置上，观感就是「镜头没动、新盒子从浪里升起来」。
   *
   * 卡片本体、`debugCard()`、`emitFrame()` 的屏幕投影**必须**都走这一条，
   * 否则量出来的落点和眼睛看到的不是同一个东西（⑯ 曾经因此误判成「卡片出画」）。
   */
  private selectedCardPosition(): THREE.Vector3 {
    const position = this.cellPosition(this.selectedLane, this.selectedRow);
    position.y += this.lift.value;
    return position;
  }

  private updateSelected(): void {
    const visible = this.lift.value > 0.0005 && this.presence > 0.01;
    this.selected.visible = visible;
    // 只在这一档里让盖板变清透（0 = 磨砂、1 = 完全清晰）。
    const clarity = smooth(Math.max(0, (this.detail - 0.25) / 0.55));
    this.selectedMaterials.setClarity(clarity);
    this.materials.setClarity(clarity * 0.6);
    const uniforms = this.bokeh.uniforms as Record<string, { value: number } | undefined>;
    const aperture = uniforms.aperture;
    if (aperture !== undefined) {
      aperture.value =
        (THREE.MathUtils.lerp(BOKEH_APERTURE_PREVIEW, BOKEH_APERTURE_DETAIL, this.detail) *
          this.quality.depthOfField) /
        100;
    }
    if (!visible) return;
    const position = this.selectedCardPosition();
    this.selected.position.copy(position);
    const slope =
      this.field(this.selectedLane, this.selectedRow + 0.5) - this.field(this.selectedLane, this.selectedRow - 0.5);
    this.selected.rotation.set(
      slope * SLOPE_TILT * (1 - this.detail) * (1 - smooth(this.lift.value / PREVIEW_LIFT)),
      this.rotation,
      0,
    );
    // 抽出来那一张的高清封面（换曲目时重画一次；图晚到就一直重画到真图为止）。
    const meta = this.metaAt(this.selectedLane, this.selectedRow);
    const key = `${meta?.url ?? ''}|${meta?.title ?? ''}|${meta?.subtitle ?? ''}`;
    if (key !== this.selectedKey) {
      this.selectedKey = key;
      this.atlas.paintSelected(meta);
    } else if (!this.atlas.selectedHasImage()) {
      /*
       * 封面图是异步加载的：第一次画的一定是兜底排印。`flush()` 里虽然有一处补画，
       * 但详情档帧时间吃紧时 `flush()` 会被让路，于是「点进详情看到一张白纸」。
       * 这里每帧检查一次（真图到了 `selectedHasImage()` 立刻为真，就不再重画）。
       */
      this.atlas.paintSelected(meta);
    }
    const focal = new THREE.Vector3(0, CASE_HEIGHT / 2, 0).add(position).applyMatrix4(this.camera.matrixWorldInverse);
    const focusUniform = uniforms.focus;
    if (focusUniform !== undefined) focusUniform.value = -focal.z;
  }

  /**
   * 面积光跟着**当前聚焦的那张盒子**走（2026-10-22）。
   *
   * 光面放在盒子正前上方、朝盒子方向照：盒子升到哪、光就跟到哪，换歌时随盒子滑动。
   * 只在暗档开（`setTheme` 里切 intensity），亮档完全不参与。
   */
  private updateLamp(): void {
    const lamp = this.lamp;
    if (lamp === null) return;
    /*
     * 灯光强度按「主题 × 档位」在这里逐帧收敛（只在暗档开）：
     * 歌单页用那条斜向光带，近景/详情用跟随盒子的点光，另一盏归零。
     * 放在逐帧里而不是 `setTheme` 里，是因为档位切换也要立刻换灯。
     */
    const dark = this.isDark;
    if (this.band !== null) {
      this.band.intensity = 0; // 暗档不靠面积光：亮度只来自着色器里的高斯带（见 setTheme）
    }
    if (this.beam !== null) {
      this.beam.visible = false;
    }
    lamp.intensity = dark && this.level !== 'overview' ? 42 : 0;
    /*
     * **歌单页（总览档）的光是固定的**（2026-10-22 主人对着截图指出：
     * 「光照在歌单页是会移动的，这是不对的；应该斜着一条线打在视觉中心，角度位置不变化」）。
     *
     * 之前这盏灯挂在"当前聚焦的那张盒子"上，于是在歌单页拖拽时光跟着列一起平移 —— 一眼就是错的。
     * 现在这一档把光钉死在**视线的瞄准点上方偏后**：无论拖到哪，光柱的角度和位置都不变，
     * 视觉中心那块始终是亮的。近景/详情档仍然跟着盒子走（那是"照亮当前这张"的语义）。
     */
    if (this.level === 'overview') {
      /*
       * 歌单页：**一条斜向光带**，钉在"画面中心此刻覆盖的那一列"上。
       *
       * 之前钉的是固定的世界坐标点 `cameraAim` —— 拖拽时墙在动、那个点在墙上早就空了，
       * 光带于是一会儿在画面里、一会儿不知道照到哪里（实测两帧都是暗的）。
       * 现在先求出中心对准的是哪一列，再把光带放到那一列上：屏幕上位置永远不变，
       * 但总有一列盒子被照亮。
       */
      const band = this.band;
      if (band !== null) {
        /*
         * **光带的世界位置只在进入歌单页那一刻定一次，之后不再动**（2026-10-22 主人第三次强调：
         * 「光照会随着拖拽歌单列而变化，是不合理的，我需要一条照光方向固定的斜向狭长光带」）。
         *
         * 上一版每帧跟着"中心那一列"走 —— 虽然屏幕位置不变，但它会随着墙的滑动一列列跳，
         * 看起来就是"光在动"。现在冻结：进入这一档时记下当时的列，之后无论怎么拖都照那里。
         */
        if (this.bandAnchorX === null) {
          const centreLane = Math.round(this.columnCamera.value / COLUMN_SPACING + LANE_ORIGIN);
          const lane = Math.max(0, Math.min(this.catalog.columns.length - 1, centreLane));
          this.bandAnchorX = (lane - LANE_ORIGIN) * COLUMN_SPACING - this.columnCamera.value;
        }
        const x = this.bandAnchorX;
        const aim = this.cameraAim;
        band.position.set(x - 0.8, aim.y + 8.4, aim.z + 6.4);
        band.lookAt(x, aim.y, aim.z);
        band.rotateZ(THREE.MathUtils.degToRad(31));
        /*
         * 光柱跟着这盏灯走：同一位置、同一朝向，稍微贴近墙面一点，
         * 让它在盒子上方"扫过去"，看起来才是打下来的一道白光。
         */
        if (this.beam !== null) {
          this.beam.visible = false;
        }
        /*
         * **高斯光带**（2026-10-22）：参考的做法是着色器里按距离渐亮，不是可见光柱。
         * 这里把带放在"视线中心那一行"附近，横向半径 9 列，暗色总览时 gain 给 1.15。
         */
        /*
         * **横向收得更狠**（2026-10-22 主人：右侧红框里那些盒子应该近乎全黑）。
         * 之前横向半径给到 9 列，等于光带两侧还能照到好几列；收到 3.5 列之后，
         * 只有视觉中心那两三列会被点亮，其余直接落黑。
         */
        /*
         * 回退到上一版（主人：光影不如上一版），**只针对右下角解决问题**：
         * 右下那一片的 `x` 比带中心大，所以给沿带方向一个**不对称**的半长 ——
         * +x 侧收短（3.0，右下立刻沉黑），−x 侧保持 7.5（左上/左下完全不变）。
         */
        /*
         * **直接照参考的原始数值换算**（2026-10-22）：
         *   参考 `width = 1.35` 行，行距 0.62 → 跨带半宽 = 0.5 × 1.35 × 0.62 = 0.42 世界单位
         *   参考 `laneRadius = 27` 世界单位 → 沿带半长就是 27
         *   参考 `dayGain = 11` → gain = 11
         * 之前我给 2.6/26/9 是凭感觉，跨带宽度比参考宽了 2.6 倍。
         */
        /*
         * 对照参考实拍重调（2026-10-22）：
         *   参考的光带**很宽很柔**、亮度不刺眼，且带外盒子仍然看得见（不是纯黑）。
         *   → 跨带半宽 1.8 → 3.6、沿带 22 → 34、gain 8.5 → 3.2，带外底色见材质里 0.14。
         */
        /*
         * **光带落在名牌那一行上**（2026-10-22 主人标出穿过 01–06 名牌的斜线，
         * 说那里应该有白色光带）。
         *
         * 名牌挂在每列的第一行，那一行在世界坐标里是 z = `entryZ()`（进场完成后为 0）
         * —— 所有列同一 z，所以它是世界上的一条横带；投影到屏幕上正好是那条斜线。
         * 因此带心 z 直接取 `entryZ()`，不要再拿 `aim.z` 凑。
         *
         * 跨带半宽 0.9 ≈ 一行多，横向半径 34（参考是 27 世界单位量级），gain 提亮到白。
         */
        this.bandUniforms.band.value.set(this.entryZ(), 1.1, 60, x);
        /*
         * 光带提亮（2026-10-25 冷化之后）：参考那张里光带上的盒子是**亮到发白**的，
         * 之前 6.0 配上新压暗的环境光就只剩一层灰。7.6 让中心那一列重新"立"起来。
         */
        this.bandUniforms.gain.value = dark ? 7.6 : 0;
      }
      return;
    }
    /*
     * **近景/详情档也要照亮周围**（2026-10-22 主人：「点进曲目页后附近的 cd 盒队列就消失」）。
     *
     * 原因不是盒子没画 —— 是光带参数只在总览档设置，切到近景后仍留着"贴名牌那一行"的旧值，
     * 于是除了选中的那一列，周围全被乘法门控压成黑的。这里给近景档一条**很宽很淡**的带，
     * 相当于把整片墙托住，同时选中盒仍由 `lamp` 点光照亮。
     */
    {
      const aimNear = this.cameraAim;
      this.bandUniforms.band.value.set(aimNear.z, 14, 80, aimNear.x);
      this.bandUniforms.gain.value = this.isDark ? 1.35 : 0;
    }
    const card = this.selectedCardPosition();
    lamp.position.set(card.x + 0.6, card.y + CASE_HEIGHT * 1.05, card.z + 3.6);  }

  /* ------------------------------------------------------------ 投影输出 */

  private emitFrame(): void {
    // 逐帧算投影（只是几次矩阵乘），但 DOM 只在四舍五入后的位置真的变了才写 ——
    // 名牌要跟着镜头走，12Hz 会看出台阶。
    const plates: RhinePlateProjection[] = [];
    const width = Math.max(1, this.options.container.clientWidth);
    const height = Math.max(1, this.options.container.clientHeight);
    for (let lane = 0; lane < this.catalog.columns.length; lane += 1) {
      const column = this.column(lane);
      if (column === null || column.count <= 0) continue;
      const x = (lane - LANE_ORIGIN) * COLUMN_SPACING - this.columnCamera.value;
      const point = this.project(x, ARRAY_BASE_Y + CASE_HEIGHT + 0.85, this.entryZ());
      const margin = 240;
      plates.push({
        key: column.key,
        x: point.x,
        y: point.y,
        visible:
          !point.behind &&
          point.x > -margin &&
          point.x < width + margin &&
          point.y > -margin &&
          point.y < height + margin,
      });
    }
    let card: RhineFrameInfo['card'] = null;
    if (this.lift.value > 0.0005) {
      const position = this.selectedCardPosition();
      position.y += CASE_HEIGHT / 2;
      const point = this.project(position.x, position.y, position.z);
      card = { x: point.x, y: point.y, visible: !point.behind };
    }
    this.options.onFrame({ level: this.level, plates, card, fps: this.fps, drawn: this.drawnCount });
  }

  private notifyFocus(force: boolean): void {
    const key = `${this.level}:${this.selectedLane}:${this.selectedRow}`;
    if (!force && key === this.lastFocusKey) return;
    this.lastFocusKey = key;
    this.options.onFocus({
      level: this.level,
      lane: this.selectedLane,
      row: this.selectedRow,
      index: this.selectedRow - ROW_ORIGIN,
      column: this.column(this.selectedLane),
      card: this.cardAt(this.selectedLane, this.selectedRow),
    });
  }

  /* ------------------------------------------------------------ 输入 */

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.pointerLog = { down: event.pointerId, up: -1, cancel: -1 };
    this.dragging = false;
    this.drag.start(event.clientX, event.clientY, this.dragProjection(), event.timeStamp);
    this.rotateDrag = {
      active: this.level === 'detail' && this.detail > 0.9,
      startX: event.clientX,
      startY: event.clientY,
    };
    this.holdPlane = this.level !== 'detail';
    this.dragStart = {
      lane: this.trackLane(),
      row: this.tracks[this.selectedLane]?.row.value ?? this.selectedRow,
    };
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.renderer.domElement.style.cursor = 'grabbing';
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5,
      (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5,
    );
    if (this.pointerId === null) {
      this.updateHover(event.clientX, event.clientY);
      return;
    }
    if (event.pointerId !== this.pointerId) return;
    this.drag.move(event.clientX, event.clientY, event.timeStamp);
    if (this.rotateDrag.active) {
      /*
       * **详情档的手势要分横竖**（2026-10-24 修「近景档拖不下去」）。
       *
       * 原来只要在详情档起手就进了「旋转」分支，而且这里直接 `return` ——
       * 纵向拖动被整段吞掉，`selectedRow` 一格都不会变，看起来就是"拖不动"。
       * 现在只有横向位移明显大于纵向时才当作旋转；一旦判断是竖向，
       * 就放弃旋转、落回下面的换歌逻辑（一次手势只认一个意图，不会边转边换）。
       */
      const dxTotal = Math.abs(event.clientX - this.rotateDrag.startX);
      const dyTotal = Math.abs(event.clientY - this.rotateDrag.startY);
      if (dxTotal < 6 && dyTotal < 6) return;
      if (dxTotal >= dyTotal) {
        this.targetRotation = Math.max(
          -0.8,
          Math.min(0.8, this.targetRotation + (event.clientX - this.rotateDrag.startX) * 0.004),
        );
        this.rotateDrag.startX = event.clientX;
        this.rotateDrag.startY = event.clientY;
        return;
      }
      // 竖向手势：不再是旋转，交给换歌。
      this.rotateDrag.active = false;
    }
    if (!this.drag.active || this.dragStart === null) return;
    this.dragging = true;
    this.hoverKey = null;
    /*
     * 平面拖拽在**有限列**上必须夹住两端：
     *  · lane 夹到 [0, 列数-1] —— 否则镜头会把整面阵列推出画外，看着就是「队列没了」；
     *  · row 夹到**目标列自己的行范围** —— 否则焦点列的行窗口会整段落空（同一类故障）。
     * 参考是循环池，怎么拖都拖不到尽头（`DESIGN.md` 的「循环档案阵列」）；音乐版改成有限列之后
     * 这两条夹取是必须的（`Rhine-Music-Demo DESIGN.md:116`）。
     */
    const lane = this.clampLaneRaw(this.dragStart.lane + this.drag.value.lane);
    const row = this.level === 'overview' ? this.dragStart.row : this.dragStart.row + this.drag.value.row;
    const goalLane = this.laneAt(lane);
    /*
     * 近景档用**取模**而不是夹取：夹取会让「拖到第一首」变成硬墙（用户实测拖不动）。
     * 总览档行固定在第一行，不需要处理。
     */
    const goalRow = this.level === 'overview' ? this.clampRow(goalLane, row) : this.wrapRow(goalLane, row);
    this.dragTrack = { lane: (lane - LANE_ORIGIN) * COLUMN_SPACING, row: goalRow };
    if (goalLane !== this.selectedLane || goalRow !== this.selectedRow) {
      const changed = goalLane !== this.selectedLane;
      // 拖回某一格时先看那格有没有正在归位的副本：有就接住它当前的高度（参考同款做法）。
      this.takeOverGhost(goalLane, goalRow);
      this.selectedLane = goalLane;
      this.selectedRow = goalRow;
      const track = this.tracks[goalLane];
      if (track !== undefined) track.row.value = goalRow;
      this.notifyFocus(changed);
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.pointerLog !== null) {
      if (event.type === 'pointercancel') this.pointerLog.cancel = event.pointerId;
      else this.pointerLog.up = event.pointerId;
    }
    const wasRotate = this.rotateDrag.active;
    this.rotateDrag.active = false;
    const moved = this.drag.moved;
    if (this.drag.active && this.holdPlane && this.dragStart !== null && !wasRotate) {
      const velocity = this.drag.releaseVelocity(event.timeStamp, this.reduced);
      if (!this.reduced && (Math.abs(velocity.lane) > 0.05 || Math.abs(velocity.row) > 0.05)) {
        // 惯性起点也要用**连续**列位置（取整会让松手瞬间跳一格，同 `clampLaneRaw` 的理由）。
        const lane = this.clampLaneRaw(this.dragStart.lane + this.drag.value.lane);
        const row = this.clampRow(this.laneAt(lane), this.dragStart.row + this.drag.value.row);
        this.momentum = new RhinePlaneMomentum(
          { lane, row },
          this.level === 'overview' ? { lane: velocity.lane, row: 0 } : velocity,
        );
      }
    } else if (!moved && !wasRotate) {
      this.clickAt(event.clientX, event.clientY);
    }
    this.dragTrack = null;
    this.dragStart = null;
    this.holdPlane = false;
    this.dragging = false;
    this.renderer.domElement.style.cursor = 'grab';
  };

  private readonly onPointerLeave = (): void => {
    this.pointer.set(0, 0);
    this.hoverKey = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const held = this.pointerId !== null;
    const steps = held
      ? 0
      : this.wheel.push(
          horizontal ? event.deltaX : event.deltaY,
          event.deltaMode,
          this.options.container.clientHeight,
          performance.now(),
        );
    // 记下这一次滚轮的判定，冒烟里「滚了但没换档」时能直接看出是被指针按住挡掉、还是没攒够一档。
    this.lastWheel = {
      steps,
      held,
      horizontal,
      delta: horizontal ? event.deltaX : event.deltaY,
      level: this.level,
    };
    if (held || steps === 0) return;
    event.preventDefault();
    /*
     * 详情档原来在这里 `return`（2026-10-21 的旧设计：放大一张时不许切歌）。
     * 2026-10-24 主人明确改口：「近景档无法往下拖动，这是 bug」——
     * 详情页同样是「挑歌」的界面，滚轮和拖拽都要能换歌，Esc / 点空白才是退出路径。
     * 所以这里不再按档位拦，三种档位走同一套步进逻辑。
     */
    if (horizontal) {
      this.selectCell(this.selectedLane + steps, this.selectedRow, true);
      return;
    }
    // 总览档只切列：纵滚在总览里没有可看的变化（同上的取舍）。
    if (this.level !== 'overview') this.selectCell(this.selectedLane, this.selectedRow + steps, true);
  };

  /** 原生 `click` 兜底（去重统一在 `clickAt()` 入口做）。 */
  private readonly onCanvasClick = (event: MouseEvent): void => {
    if (this.drag.moved) return;
    this.clickAt(event.clientX, event.clientY);
  };

  private lastClickHandledMs = 0;

  private attachInput(): void {
    const canvas = this.renderer.domElement;
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    /*
     * **`click` 兜底**（2026-10-22 实测：`pointerup` 路径在"没有成对 pointerdown"的输入下会被
     * `if (event.pointerId !== this.pointerId) return;` 直接挡掉，于是点了没反应）。
     * 这里再挂一个原生 `click`，任何输入方式都会走到 `clickAt`；用时间戳去重，
     * 避免和 `pointerup` 那条同时触发时退两级。
     */
    canvas.addEventListener('click', this.onCanvasClick);
    /*
     * 指针兜底：`pointerup` 只要没落到画布上（松手在别的元素、窗口失焦、被系统抢走指针），
     * `pointerId` 就会一直挂着 —— 之后滚轮全被 `onWheel` 的「按着指针就别滚」挡掉，
     * 表现为「拖过一次之后滚轮失灵，必须再点一下才恢复」（2026-10-17 冒烟量到的）。
     * 所以在窗口层再兜一道：up/cancel 走同一套收尾，blur 直接清干净。
     */
    window.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('pointercancel', this.onPointerUp, true);
    window.addEventListener('blur', this.onWindowBlur);
  }

  private detachInput(): void {
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('click', this.onCanvasClick);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('pointercancel', this.onPointerUp, true);
    window.removeEventListener('blur', this.onWindowBlur);
  }

  /** 窗口失焦：指针状态直接清干净（没有 up 事件可等）。 */
  private readonly onWindowBlur = (): void => {
    if (this.pointerId === null) return;
    this.pointerId = null;
    this.dragTrack = null;
    this.dragStart = null;
    this.holdPlane = false;
    this.dragging = false;
    this.rotateDrag.active = false;
    this.renderer.domElement.style.cursor = 'grab';
  };

  private trackLane(): number {
    return this.columnCamera.value / COLUMN_SPACING + LANE_ORIGIN;
  }

  private laneAt(value: number): number {
    return Math.max(0, Math.min(Math.max(0, this.catalog.columns.length - 1), Math.round(value)));
  }

  /** 两条轨道在屏幕上的方向（起手时采样一次）。SOURCE: `scene.ts:910-934`。 */
  private dragProjection(): RhineDragProjection {
    const center = new THREE.Vector3(
      (this.selectedLane - LANE_ORIGIN) * COLUMN_SPACING - this.columnCamera.value,
      ARRAY_BASE_Y + CASE_HEIGHT / 2,
      0,
    );
    const rect = this.renderer.domElement.getBoundingClientRect();
    const project = (motion: THREE.Vector3): { x: number; y: number } => {
      const from = center.clone().addScaledVector(motion, -0.5).project(this.camera);
      const to = center.clone().addScaledVector(motion, 0.5).project(this.camera);
      return { x: ((to.x - from.x) * rect.width) / 2, y: (-(to.y - from.y) * rect.height) / 2 };
    };
    /*
     * 总览档的列轴在新的方位角（30°）下更"正"了 —— 同样多的像素会换算出更多列，
     * 于是快速拖动一帧就能跳一整列（冒烟⑪实测单帧 0.975 格）。这里把总览档的标定放大 1.6 倍，
     * 也就是同样拖动距离只走更少列，回到原来那种"跟手但不瞬移"的手感。
     */
    const laneScale = this.level === 'overview' ? 1.6 : 1;
    return {
      lane: {
        x: project(new THREE.Vector3(-COLUMN_SPACING, 0, 0)).x * laneScale,
        y: project(new THREE.Vector3(-COLUMN_SPACING, 0, 0)).y * laneScale,
      },
      row: project(new THREE.Vector3(0, 0, -ROW_SPACING)),
    };
  }

  private updateHover(clientX: number, clientY: number): void {
    const cell = this.pick(clientX, clientY);
    const next = cell === null ? null : cellKey(cell.lane, cell.row);
    if (next === this.hoverKey) return;
    this.hoverKey = next;
    this.renderer.domElement.style.cursor = next === null ? 'grab' : 'pointer';
  }

  private pick(clientX: number, clientY: number): { lane: number; row: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.cursor.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      (-(clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.cursor, this.camera);
    const primary = this.batches[0];
    if (primary === undefined) return null;
    /*
     * **拾取前重算实例包围球**（2026-10-24 实测的"点了没反应"）。
     *
     * three 的 `InstancedMesh.raycast()` 只在 `boundingSphere === null` 时算一次，
     * 之后实例位置变了它也不会更新 —— 于是射线先被一个旧的球挡掉，`pick()` 永远返回 null。
     * 后果就是总览点列进不去歌单、近景点卡片没反应、点空白也退不出来。
     *
     * 放在这里而不是每帧算：一次点击才多一次线性扫描，不影响渲染路径。
     */
    if (primary.count > 0) primary.computeBoundingSphere();
    // 只拿第一层做拾取（参考也是「拾取只用第一个实例化面」，SOURCE: `scene.ts:1717-1719`）。
    const hits = this.raycaster.intersectObjects([primary, this.selected], true);
    const hit = hits[0];
    if (hit === undefined) return null;
    if (hit.instanceId !== undefined) {
      const lane = this.drawnLanes[hit.instanceId];
      const row = this.drawnRows[hit.instanceId];
      if (lane === undefined || row === undefined) return null;
      return { lane, row };
    }
    if (this.selected.visible) return { lane: this.selectedLane, row: this.selectedRow };
    return null;
  }

  /**
   * **从曲目单跳到对应的 CD 盒**（2026-10-22 主人：「点击歌曲名时应该有个动画滚动到对应的 cd 盒」）。
   *
   * 做法：如果还在详情档就先退回近景，再把焦点换到那一行 —— 换焦点本来就走
   * `selectCell` + 轨道滑动，所以镜头/阵列会带着缓动过去，不会瞬移。
   */
  locateRow(index: number): void {
    /*
     * **在详情页里直接换盒子，不把视角切出去**（2026-10-22 主人第 2 条）。
     * 之前这里先 `stepBack()` 退回近景，镜头会飞出去 —— 主人不要那个。
     * 现在保持 `detail` 档，只换选中的格子：抽出来的那张按换歌动画替换。
     */
    const row = ROW_ORIGIN + index;
    this.selectCell(this.selectedLane, row, true);
    this.options.onEvent({ type: 'select-card', lane: this.selectedLane, row });
  }

  /** 调试入口：直接走一遍点击逻辑（`RhineLayer` 注册成 `window.__piRhineClick`）。 */
  debugClick(clientX: number, clientY: number): void {
    this.clickAt(clientX, clientY);
  }

  /** 调试：这一屏坐标射线命中了哪一格（`null` = 空白）。 */
  debugPick(clientX: number, clientY: number): { lane: number; row: number } | null {
    return this.pick(clientX, clientY);
  }

  /** 点一下：总览点列 → 进这一列；近景点焦点卡 → 进详情、点别的卡 → 换焦点；详情点抽出来的那张 → 收起。 */
  private clickAt(clientX: number, clientY: number): void {
    /*
     * **统一去重**：同一次点击会从两条路进来（`pointerup` 与原生 `click`），
     * 不去重就会"退两级"（实测 detail → overview）。这里按 350ms 窗口只认第一次。
     */
    const now = performance.now();
    if (now - this.lastClickHandledMs < 350) return;
    this.lastClickHandledMs = now;
    const cell = this.pick(clientX, clientY);
    /*
     * **详情档：除了那张抽出来的盒子，点哪儿都回上一级**（2026-10-22 主人图 4：
     * 标红那些"看着是空的"区域点下去没反应）。
     *
     * 原因是射线会穿到墙面上更远的盒子里去 —— 视觉上空的，`pick()` 却命中了一张。
     * 所以详情档不再用"命中与否"判断，只认"是不是选中那张"。
     */
    if (this.level === 'detail') {
      const onCard = cell !== null && cell.lane === this.selectedLane && cell.row === this.selectedRow;
      /*
       * 详情档点那张抽出来的盒子 = **进歌曲播放页**（2026-10-22 主人第 2 条）。
       * 之前这里是 `leave-detail`（退回近景），现在改成通知外层打开播放页。
       */
      if (onCard) {
        /*
         * **把这张卡本身一起发出去**（2026-10-22）。之前外层用 React 里的 `focus` 状态取歌，
         * 而点击和 `focus` 更新是同一轮事件里的两件事 —— 外层拿到的常常还是**上一张卡**，
         * 于是"点怪兽却播了上一首"。曲目跟事件走，就没有时序问题了。
         */
        this.options.onEvent({
          type: 'open-player',
          lane: this.selectedLane,
          row: this.selectedRow,
          card: this.cardAt(this.selectedLane, this.selectedRow),
        });
      } else this.stepBack();
      return;
    }
    if (cell === null) {
      /*
       * 点空白 = 逐级退（主人 2026-10-21 第 2 条）。总览档是根，点空白不退出整个皮肤，
       * 所以只在这一档之外生效：近景 → 收起、详情 → 近景（`stepBack()` 自带逐级逻辑）。
       */
      if (this.level !== 'overview') this.stepBack();
      return;
    }
    if (this.level === 'overview') {
      this.selectCell(cell.lane, ROW_ORIGIN, true);
      this.options.onEvent({ type: 'select-column', lane: cell.lane });
      return;
    }
    if (this.level === 'near') {
      if (cell.lane === this.selectedLane && cell.row === this.selectedRow) {
        this.options.onEvent({ type: 'enter-detail', lane: cell.lane, row: cell.row });
      } else {
        this.selectCell(cell.lane, cell.row, true);
        this.options.onEvent({ type: 'select-card', lane: cell.lane, row: cell.row });
      }
      return;
    }
    this.options.onEvent({ type: 'leave-detail' });
  }
}
