/**
 * 「莱茵风」CD 盒阵列的**几何 / 相机 / 光照**常量。
 *
 * 这一档皮肤复刻的是开源的 RhineLabUI（MIT，`LBEILC/RhineLabUI`，研究提交见
 * `docs/RHINE-SKIN.md`）里那面「波浪流动式档案阵列」，音乐侧映射参考
 * `RonaldDeng/Rhine-Music-Demo`（同为 MIT，基于前者扩展）。
 *
 * **纪律**：本文件每一个数都标了来源（`SOURCE:` 路径:行）或明确标 `GUESS`。
 * 标 `SOURCE` 的是从参考仓库真源码逐行读出来的；标 `GUESS` 的是我们自己调出来、
 * 还没有对照证据的拟合值。改这些数之前先回去看那一行源码。
 *
 * 我们**没有**照抄它的代码：几何形状、材质组织、数据映射、界面层全部自己写，
 * 借的是「数值与做法」（这与本仓库对 folia-major 的处理方式是同一条边界）。
 */

/* ------------------------------------------------------------------ 案例几何 */

/**
 * CD 盒的世界尺寸（宽 × 高 × 厚）。
 * SOURCE: Rhine-Music-Demo `src/music-model.ts:7-9`（音乐版把原档案盒 5×3.7×0.31 收窄成
 * 「专辑盒」，`DESIGN.md` 记 `3.996 × 3.35 × 0.14`）。
 */
export const CASE_WIDTH = 3.996;
export const CASE_HEIGHT = 3.35;
export const CASE_DEPTH = 0.14;

/** 封面纸面的边长与它在盒面上的横向位置（左侧留出书脊）。
 *  SOURCE: `demo/src/music-model.ts:29-31`（`width/height 2.98`、`x 0.14`）。 */
export const COVER_SIZE = 2.98;
export const COVER_X = 0.14;

/** 书脊（侧条）绝对宽度。SOURCE: `demo/DESIGN.md` 模型一节（`4.45 × .26 / 4.3 ≈ .26907`）。 */
export const SPINE_WIDTH = 0.26907;

/** 列中心距：音乐版为「盒宽 + .75 净空」。
 *  SOURCE: `demo/DESIGN.md`（`4.746`；原档案入口仍是 `5.2`）。 */
export const COLUMN_SPACING = 4.746;

/** 行间距（相邻盒子的纵深步距，盒厚 0.14 + 间隙）。
 *  SOURCE: `RhineLabUI src/archive-loop.ts:15`（`ROW_SPACING = 0.74`）。 */
export const ROW_SPACING = 0.74;

/** 阵列基准高度与地面高度。
 *  SOURCE: `RhineLabUI src/scene.ts:305-313`（地面 `y = -4.63`）、`:666-672`（盒子基线 `-4.6`）。 */
export const ARRAY_BASE_Y = -4.6;
export const GROUND_Y = -4.63;

/** 列的「原点」是第 2 列（`x = (lane - 2) * spacing`）。
 *  SOURCE: `RhineLabUI src/scene.ts:666-672`。 */
export const LANE_ORIGIN = 2;

/** 行的「原点」：内容的第一个位置落在第 12 行，`z = (row - 15.5) * ROW_SPACING`。
 *  SOURCE: `RhineLabUI src/data.ts:27-31`（`row = 12 + indexInColumn`）与
 *  `src/scene.ts:666-672`（`z` 表达式的 15.5）。 */
export const ROW_ORIGIN = 12;
export const ROW_Z_CENTER = 15.5;

/** 阵列在屏幕上留下的可见行窗口（以焦点行为中心的行数上限）。
 *  参考实现用「视锥 ∩ 高度板」动态算候选，靠近雾端的行其实已经看不见；
 *  我们**额外**加这一道上限，是为了让实例数有个硬上界（性能可控），
 *  视觉上不引入差别：`SETTLING_WAVE` 的包络在约 12 行外就衰减到 0，
 *  更远的行只贡献雾色。这是本实现的**主动简化**，不是参考的做法。 */
/*
 * 可见行窗口：40 → 64（2026-10-22 主人指出画面左上有一块空的黑区，需要补满 cd 盒）。
 * 机位抬高之后远端能看到更远的行，窗口给到 64 才铺满整幅画面。
 *
 * 2026-10-25 再放到 **61**（`60` 是上限，实际窗口 `2×30+1`）。主人第二次指出
 * 「cd 盒队列纵向数目过少产生空缺」——上一次只放到 40 行、靠"取模复用已烘封面"补位，
 * 结果循环出来的是**前 40 首的重复**，第 41 行就跳回第 1 首，
 * 看起来像"多出一批没有内容的歌占着位置"。
 * 现在窗口和图集覆盖行数严格相等（61 行 = 这一列的头 61 首，各不重复），
 * 第 62 行才回到第 1 首 —— 那才是主人要的"歌单内首尾相接"。
 */
export const VISIBLE_ROW_WINDOW = 60;

/* ------------------------------------------------------------------ 波浪与升降 */

/** 预览档抬起高度（选中但没进详情）。
 *  SOURCE: `RhineLabUI src/scene.ts:1404`（`0.4 * targetReveal`）。
 *
 * 2026-10-17 主人拿图 1 提要求：「应该让被选中的歌曲明显比前后的 cd 盒上升到高处」——
 * 0.4 相对盒高 3.35 只有 12%，一眼看不出高低差。这里对**主人这条要求**让步，抬到 1.25
 * （约 37% 盒高），同时把焦点列选中行附近的波浪压到 `FOCUS_WAVE_KEEP`（见 `field()`）。
 * 这是与参考数值的**有意偏离**，记在 `docs/RHINE-SKIN.md` 的照实记里。 */
export const PREVIEW_LIFT = 1.25;

/**
 * 抽出来那张升起来之后，**焦点列还剩多少波浪**（0 = 全压平、1 = 原样）。
 *
 * 主人第三轮的原话是「四周的 cd 盒会波浪式的浮动，并且当前队列的 cd 盒波浪浮动不合理」，
 * 我第一版把焦点列的波浪整个关掉了 —— 第四轮主人立刻反馈「cd 盒没有正常表现波浪流动式的动画」。
 * 所以波浪必须在，只是压到 1/3 左右：抬升 1.25 与波浪同相叠加时，选中那张仍然比紧邻高
 * 约 1 个世界单位（≈ 30% 盒高），既保住「流动」的观感，也保住「选中明显高出来」。
 */
export const FOCUS_WAVE_KEEP = 0.34;

/**
 * 选中那张两侧的**台阶裙摆**：前后第 n 张抬起 `PEAK_SKIRT * 0.5^n`。
 * 有了它，选中那张是「峰」而不是「一根柱子」——挨着的两张略高、再远就落回队列，
 * 视觉上就是参考图 1 那种「中间一张明显高出来、两侧依次落下去」。
 */
export const PEAK_SKIRT = 0.26;

/**
 * 肩部波形的**固定采样时刻**。SOURCE: `Rhine-Music-Demo src/scene.ts:1500`
 * （`settlingWave(distance, 26.56)`）。
 *
 * 注意第二个参数在参考里是**常数**：肩部山丘是静止形状，不随时间变形。
 * 传流逝时间会让整面墙持续扭转（两头翘、中间凹），这正是 2026-10-22 主人指出的"很糟糕的波浪"。
 */
export const SHOULDER_WAVE_TIME = 26.56;

/** 详情档（抽取）高度。
 *  SOURCE: `RhineLabUI src/motion.ts:100`（`INSPECTION_LIFT = 4.05`）。 */
export const INSPECTION_LIFT = 4.05;

/** 悬停额外抬起。SOURCE: `RhineLabUI src/scene.ts:1249`（`0.28`）。 */
export const HOVER_LIFT = 0.28;

/** 临界阻尼速率（值越大越「跟手」）。
 *  SOURCE: `RhineLabUI src/scene.ts:1258-1263`（肩部 5 / 列焦点 4 / 轨道 3.7）、
 *  `:1393-1413`（升降 4.2）、`:1250`（悬停 14）。 */
export const DAMP_SHOULDER = 5;
export const DAMP_LANE_FOCUS = 4;
export const DAMP_TRACK = 3.7;
export const DAMP_LIFT = 4.2;

/**
 * **归位副本下沉**的阻尼速率。
 * SOURCE: `RhineLabUI src/scene.ts:1437-1468` 里 `outgoing` 用的是 4.5（抬起来那支是 4.2），
 * 减少动态效果时换成 35。别混用：抬得高（`PREVIEW_LIFT` 1.15）、沉得慢会让「旧的归队」拖尾巴。
 */
export const DAMP_RETURN = 4.5;
export const DAMP_HOVER = 14;

/** 卡片沿波浪的俯仰系数（`slope * .024`）。SOURCE: `RhineLabUI src/scene.ts:1458-1462`。 */
export const SLOPE_TILT = 0.024;

/* ------------------------------------------------------------------ 相机 */

/** 预览取景：方位角 59°、仰角 19°、垂直取景 7.33、镜头距离 140（详情推到 72）。
 *  SOURCE: `RhineLabUI src/scene.ts:1510-1526`（`yaw = 89 - 22 * orbit - 8 * settle`、
 *  `elevation = 3 + 40 * … - 8 * orbit - 16 * settle`、`span 7.33`、
 *  `distance = lerp(…, 140, settle)` 再 `lerp(…, 72, detail)`）；README/DESIGN 也记了
 *  「方位角 59°、仰角 19°、垂直取景范围 7.33 世界单位」。 */
export const CAMERA_YAW_DEG = 59;
/*
 * 预览取景（总览档 / 近景档共用）。2026-10-22 试过两轮"更俯视、看得见更多列"：
 *   · 仰角 27° + 取景 8.9 → 贴着地面看一排盒子侧边，反而更差；
 *   · 只把距离拉到 182 → 列是多了，但同样变成"只看见盒子边缘、看不见封面"。
 *
 * 原因是这套阵列的**列沿深度方向排列**（yaw 59° 是顺着列看的），拉远/抬高的收益会被
 * "越看越侧"抵消掉。所以先回滚到参考项目原来的这组值；真要"更多列 + 看得见封面"，
 * 得改 yaw 让视线更正面，那是另一个方向的调整，等主人定。
 */
export const CAMERA_ELEVATION_DEG = 19;
export const CAMERA_SPAN = 7.33;

/** 详情档的取景：垂直取景收到 5.9、镜头推到 72，视线方向换成朝盒面的一组固定值。
 *  SOURCE: `RhineLabUI src/scene.ts:1522-1553`（`lerp(span, 5.9, detail)`、
 *  `lerp(…, 72, detail)`、`viewDirection.lerp((-0.277, 0.238, 0.931), detail)`）。 */
export const CAMERA_SPAN_DETAIL = 5.9;
export const CAMERA_DISTANCE_PREVIEW = 140;
/*
 * **总览档（歌单选择页）专用取景**：机位更高、退得更远、视野更宽，一屏能看到更多列
 * （2026-10-22 主人：「视角太高主要是看到更多的歌单 cd 盒列，并且在这个页面实现拖拽移动；
 * 在原来的更低的视角是在歌单里选择不同的歌曲」）。
 *
 * 近景档（歌单内选歌）仍用上面那组参考值，所以两档各有各的机位，互不影响。
 */
export const CAMERA_ELEVATION_OVERVIEW_DEG = 43;
/*
 * 角度采用参考值（yaw 28 / elevation 43），但**机位比参考更靠近视觉中心**
 * （2026-10-22 主人：「角度对了，但太高了，向视觉中心拉近」）：
 * span 16.8 → 14.2、distance 172 → 150，视野收窄、墙面在画面里更大。
 */
export const CAMERA_SPAN_OVERVIEW = 14.6;
export const CAMERA_DISTANCE_OVERVIEW = 150;
/*
 * **方位角**：决定阵列的"列"在屏幕上往哪个方向铺开（2026-10-22 主人：
 * 「截图里歌单列的走向是横着的，实际需要的是从左上到右下」）。
 *
 * 59° 时视线几乎顺着列走，整面墙在屏幕上是一条条横带；把方位角**调小**（更正对封面），
 * 列的走向就会从左上斜到右下，跟参考图一致。近景档仍用 59°（低机位、贴着列看）。
 */
export const CAMERA_YAW_OVERVIEW_DEG = 28;
export const CAMERA_DISTANCE_DETAIL = 72;
export const CAMERA_DETAIL_DIR: readonly [number, number, number] = [-0.277, 0.238, 0.931];

/** 取景的瞄准基准点（阵列原点的世界坐标）。
 *  SOURCE: `RhineLabUI src/scene.ts:1527-1531`（`arrayAim = (-1.091, -0.045, 0.481)` 在 settle 后）。 */
export const CAMERA_AIM: readonly [number, number, number] = [-1.091, -0.045, 0.481];
/**
 * **总览档（歌单页）的瞄准点**。SOURCE: `Rhine-Music-Demo src/scene.ts:1857`
 * （`cameraAim.lerp(new THREE.Vector3(wide.aimColumns * columnSpacing, -1.8, -1.5), overview)`）。
 *
 * 这一档的墙是"静态肩部山丘"（中心比基线高 2.15），瞄准点必须抬到 -1.8 才框得住；
 * 沿用近景那组 -0.045 会让镜头对着地板（实测整屏过曝白）。
 */
export const CAMERA_AIM_OVERVIEW: readonly [number, number, number] = [-1.091, -1.8, -1.5];

/**
 * **开场编排的时长**。SOURCE: `Rhine-Music-Demo src/music-intro-motion.ts:45-59` ——
 * 关键帧跑到第 112 帧才完全落定（`settle = smoother((frame-76)/36)`），
 * 25 帧/秒 ⇒ 约 4.44 秒。这里取 4.6 秒，留一点余量保证 `settle` 真的到 1，
 * 否则开场结束后镜头会停在**中间机位**，不是我们设计的歌单页视角。
 */
export const INTRO_MS = 4600;
/**
 * 开场编排结束后，入场波再淡出多久（毫秒）。
 *
 * 列与列之间有 0.16 秒的延迟，最左边那几列到 4.6 秒时还没走完 —— 原来会在切换高度场
 * 那一帧被硬切断（主人 2026-10-25 录屏：「结束时是凹的，突然变成凸的」）。
 * 现在改为在 `INTRO_MS` 之后平滑淡出，波浪自然收成静态山丘，结束时就是凸的。
 */
export const INTRO_WAVE_FADE_MS = 1400;
export const INTRO_YAW_DEG = 86;
export const INTRO_ELEVATION_DEG = 3;

/** 拉近之后盒子在屏幕上的落点（`detailX / detailY`，比例值）。
 *  SOURCE: `RhineLabUI src/viewport-layout.ts:35-36`（横屏 `550/1920`、`560/1080`）。 */
export const DETAIL_SCREEN_X = 550 / 1920;
export const DETAIL_SCREEN_Y = 560 / 1080;

/** 近/远裁剪面与取景比例基准。
 *  SOURCE: `RhineLabUI src/scene.ts:165`（`near 5, far 300`，近平面必须 > 盒子厚度以免深度量化闪烁）、
 *  `src/viewport-layout.ts:22-37`（16:9 基准与竖屏补偿）。 */
export const CAMERA_NEAR = 5;
export const CAMERA_FAR = 300;
export const FRAMING_ASPECT = 16 / 9;

/* ------------------------------------------------------------------ 光照 */

/** 曝光与色调映射。SOURCE: `RhineLabUI src/archive-lighting.ts:14`（baseline `1.05`）、
 *  `src/scene.ts:275-276`（ACESFilmic）。
 *  2026-10-22 主人：「浅色模式太亮（要图 1 那种）、暗色也更亮（要图像 2）」。整体压到 0.88。 */
export const TONE_EXPOSURE = 0.88;

/** 环境贴图强度。SOURCE: `RhineLabUI src/archive-lighting.ts:20`（baseline `0.48`）。
 *  同样因为"两档都太亮"压到 0.34：白玻璃在 0.48 下整面墙会泛白、丢层次。 */
export const ENV_INTENSITY = 0.34;

/** 半球光（天光 / 地面反光）。SOURCE: `RhineLabUI src/archive-lighting.ts:22-25`。 */
export const HEMI_SKY = '#fffaf5';
export const HEMI_GROUND = '#b4a18c';
export const HEMI_INTENSITY = 0.44;

/** 主光（暖白，投射阴影）与补光。SOURCE: `RhineLabUI src/archive-lighting.ts:28-37`。
 *  2026-10-22：主光 1.7→1.25、补光 0.6→0.38，配合上面的曝光一起降，避免整面墙过曝。 */
export const KEY_COLOR = '#fff7ed';
export const KEY_INTENSITY = 1.25;
export const KEY_POSITION: readonly [number, number, number] = [-6, 14, -5];
export const FILL_COLOR = '#ffffff';
export const FILL_INTENSITY = 0.38;
export const FILL_POSITION: readonly [number, number, number] = [7, 8, -10];

/**
 * **正面印刷光**（我们自己补的一盏，参考档案阵列没有）。
 *
 * 为什么必须补：参考的档案阵列在墙上**没有封面** —— 阵列只留外壳 / 边条 / 托盘那几层
 * （SOURCE: `RhineLabUI src/scene.ts:411-424`），而它的主光 `(-6,14,-5)` 与补光 `(7,8,-10)`
 * 都在阵列**背后**；相机却在正面（`camera.position = 瞄准点 + 视线 × 距离`，`scene.ts:1641-1643`）。
 * 也就是说：我们看到的那一面，本来就只吃环境光与半球光。参考这么写没问题（它那一面是浅色玻璃
 * 与香槟色托盘），但**音乐版把专辑封面贴到了阵列正面**，于是它专门加了一组正面灯：
 * `SDTspot = new SpotLight("#ffe3b2", 70 * 64, 0, 0.32, 0.95, 2)` 与
 * `area = new RectAreaLight("#ffe3b2", 0, 39, 0.18)`（SOURCE: `Rhine-Music-Demo
 * src/music-lighting.ts:11-12`，`DESIGN.md` 里叫「暖昼移动灯带」，默认增益 11 倍）。
 *
 * 我们不做它的移动灯带（那套与主题时钟、`dayGain` 旋钮耦合），只留**一盏不投影的正面定向光**：
 * 作用与它一致（把封面照到可读的漫反射曝光），代价只有一次没有阴影通道的常量加法。
 */
export const PRINT_LIGHT_COLOR = '#fff3e4';
export const PRINT_LIGHT_INTENSITY = 1.05;
export const PRINT_LIGHT_POSITION: readonly [number, number, number] = [3, 9, 16];

/** 封面纸面自身的漫反射曝光（参考用 shader 只抬印刷面，SOURCE: `music-lighting.ts:153-181`）。 */
export const PRINT_EXPOSURE = 1.12;

/**
 * 同时在场的**归位副本**上限（我们自己的约束，参考没有）。
 *
 * 参考的 `outgoing` 是不设上限的数组（那套是循环池 + 每次换档一枚克隆）。我们是有限列，
 * 快速滚轮连切能一口气换十几次档；每个副本是「四层共用几何 + 一张自己的封面材质」，
 * 不封顶就会堆出几十组 Mesh。超过上限时**最旧的那一枚立刻归位**（那一格由阵列自己接手，
 * 看上去就是「先前沉下去的那张已经回到队列里」），开销被压成常数。
 */
export const GHOST_LIMIT = 4;

/** 阴影相机与偏移。SOURCE: `RhineLabUI src/scene.ts:293-304`（±16/±15、near .1、far 45、
 *  mapSize 2048、normalBias 0.035、bias -0.0003、radius 4）。 */
export const SHADOW_EXTENT_X = 16;
export const SHADOW_EXTENT_Y = 15;
export const SHADOW_NEAR = 0.1;
export const SHADOW_FAR = 45;
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_NORMAL_BIAS = 0.035;
export const SHADOW_BIAS = -0.0003;
export const SHADOW_RADIUS = 4;

/** 地面。SOURCE: `RhineLabUI src/scene.ts:305-313`。 */
export const GROUND_COLOR = '#d8c9b9';
export const GROUND_SIZE = 200;

/** 背景与雾。SOURCE: `RhineLabUI src/scene.ts:286-290`。 */
export const BACKGROUND_LIGHT = '#eae5e1';
export const FOG_LIGHT = '#eae5e1';

/** 雾的起止（相对**实际**相机到瞄准点的距离）。SOURCE: `RhineLabUI src/scene.ts:1662-1669`
 *  （浅色 `+5 / +25`，详情档收成 `-1 / +12`）。 */export const FOG_NEAR_OFFSET = 5;
export const FOG_FAR_OFFSET = 25;
export const FOG_NEAR_OFFSET_DETAIL = -1;
export const FOG_FAR_OFFSET_DETAIL = 12;

/** 环境遮蔽（SSAO）。SOURCE: `RhineLabUI src/scene.ts:320-329`（kernel 32、radius 0.38、
 *  minDistance 0.001、maxDistance 0.09）。 */
export const AO_KERNEL = 32;
export const AO_RADIUS = 0.38;
export const AO_MIN_DISTANCE = 0.001;
export const AO_MAX_DISTANCE = 0.09;

/** 景深（Bokeh）：光圈随详情进度张开。
 *  SOURCE: `RhineLabUI src/scene.ts:330-335`（`focus 25 / aperture .0018 / maxblur .011`）与
 *  `:1757-1760`（`aperture = lerp(.0003, .0008, detail) * dof / 100`）。 */
export const BOKEH_MAX_BLUR = 0.0045;
/*
 * 暗角强度（0 = 不暗角，1 = 四角全黑）。
 *
 * 参考画面"视觉中心才发光"的观感主要来自后期暗角，不是灯。0.62 让四角沉下去、
 * 中间保持正常亮度；觉得四周太黑就往下调，觉得不够聚焦就往上调。
 */
export const VIGNETTE_STRENGTH = 0.62;
/*
 * 光圈值（决定景深强度）。2026-10-22 主人：「高、极高下 cd 盒都变模糊而不透明」——
 * 高/极高档 `depthOfField` 是满值 100，原来 0.0003/0.0008 的光圈会把前后排糊成一片，
 * 玻璃盒看起来就是"磨砂塑料"。两档各减一半：仍然是景深，但盒子本身保持清晰。
 */
export const BOKEH_APERTURE_PREVIEW = 0.00007;
export const BOKEH_APERTURE_DETAIL = 0.00012;

/* ------------------------------------------------------------------ 材质（浅色基线） */

/**
 * 盒体各面的基线材质参数。
 * SOURCE: `RhineLabUI src/scene.ts:357-467` 的材质改色与
 * `demo/DESIGN.md` 的「玻璃 / 封面」一节。阵列里的盒子只保留**外壳 / 边条 /
 * 封面纸面 / 托盘**四层：参考实现把亚毫米级的光学与印刷几何留在抽取出来的那一张上，
 * 阵列里不画（`:411-424`）。
 */
/*
 * **透明亚克力**（2026-10-22 主人对着参考图纠正：「需要的是玻璃质感，不是白色边框」）。
 *
 * 之前是一块暖白、粗糙度 0.28 的板 —— 在暗场里读起来就是"白色塑料"。参考那种盒子是
 * 通体透明的亚克力：能看见盒背、能看见后面的邻居、边缘只有一圈很细的高光。
 * 所以这里把颜色压成近白、粗糙度降到 0.08（接近镜面）、透射提到 0.92、厚度减薄。
 */
export const GLASS_COLOR = '#fbfbff';
export const GLASS_ROUGHNESS = 0.08;
export const GLASS_TRANSMISSION = 0.92;
export const GLASS_THICKNESS = 0.06;
export const GLASS_IOR = 1.49;
export const GLASS_CLEARCOAT = 0.6;
export const GLASS_CLEARCOAT_ROUGHNESS = 0.06;
export const GLASS_ATTENUATION = '#e8eef5';
export const GLASS_ATTENUATION_DISTANCE = 3.5;

/** 边条：**也是玻璃**（参考的盒子没有白塑料边框，四边是同一块亚克力的折边）。 */
export const EDGE_COLOR = '#f4f7fb';
export const EDGE_ROUGHNESS = 0.16;

/** 托盘 / 封面承托（阵列档偏向琥珀，让玻璃后面有内容可透）。
 *  SOURCE: `RhineLabUI src/scene.ts:455`（`Optical_Diffuser` 阵列色 `#806447`）。 */
export const TRAY_COLOR = '#806447';
export const TRAY_ROUGHNESS = 0.7;

/** 封面的印刷曝光（参考用 shader 抬印刷面曝光；我们用材质自发光等价实现）。
 *  SOURCE: `demo/src/music-lighting.ts:153-181`（「exposure by multiplication only」）。 */

/* ------------------------------------------------------------------ 暗档 */

/**
 * 暗档（月影）的 3D 侧配色。
 * SOURCE: `RhineLabUI DESIGN.md` 的「明暗配色」一节（背景 `#11181b`、正文 `#e0e3dc`、
 * 辅助 `#a6b0b1`、分隔 `#536166`、琥珀 `#c5a16b`）与该节对三维阵列的描述
 * 「烟灰材质端点及冷灰边缘」；雾色取自「暗色雾颜色调整为 `#263136`」。
 */
export const DARK_BACKGROUND = '#070b0f';
export const DARK_FOG = '#121a21';
/*
 * **暗档整体冷化**（2026-10-25 主人：「让暗色模式下的界面色调接近我给的参考图」）。
 *
 * 参考那张（RhineLabUI 的档案页）是**冷蓝灰**的：玻璃壳偏冰白、盒内托盘是深蓝灰、
 * 背景近黑带一点青。我们之前那套是暖的（暖白玻璃 `#f3ece4` + 牛皮纸内页 `#8e8474`），
 * 整屏读起来偏米黄，跟参考不是一个温度。
 *
 * 下面这组只影响暗档；亮档仍然走上面那套暖白（亮底上冷白会发灰）。
 */
export const DARK_GLASS_COLOR = '#f2f7fd';
export const DARK_EDGE_COLOR = '#d6e3ef';
export const DARK_TRAY_COLOR = '#4a5764';
/** 暗档的半球光：天空冷白、地面深蓝灰（亮档仍然用上面那对暖色）。 */
export const DARK_HEMI_SKY = '#cfe0f0';
export const DARK_HEMI_GROUND = '#1d2731';
/** 暗档的环境贴图强度；让玻璃壳还能反出一点冷光轮廓。 */
export const DARK_ENV_INTENSITY = 0.05;

/* ------------------------------------------------------------------ 交互 */

/** 拖拽起手阈值与「算作拖动」的位移（px）。
 *  SOURCE: `RhineLabUI src/archive-drag.ts:44-45`（>7px 记 moved、<10px 不激活）。 */
export const DRAG_MOVE_PX = 7;
export const DRAG_ACTIVE_PX = 10;

/** 滚轮切档：累计 100 触发、单次最多 3 档、180ms 内同向才累计。
 *  SOURCE: `RhineLabUI src/scene.ts:1165-1181`。 */
export const WHEEL_STEP = 100;
export const WHEEL_MAX_STEPS = 3;
export const WHEEL_WINDOW_MS = 180;
