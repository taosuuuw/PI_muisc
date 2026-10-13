/**
 * 商籁**预排构图**（纯函数）—— "此刻镜头该看哪里"的唯一来源。
 *
 * === 它是什么 ===
 * 镜头不追字，只按**歌词时间轴 + 最终排版**预先安排一条**低频路径**：
 * · 每个语义词组有一枚**最终落点中心** `(centerX, centerY)`，以及一段**真实 cue 区间**
 *   （区间取段内**首 / 末字的 START**，与参考 `resolveShotTracking` 的 focus range 同口径；
 *   不拿"整词唱完"当区间末端，那会把构图强留在旧词上）；
 * · 采样时刻 `sampleTime = time + lead`（`lead = 0.06 + 0.06 × speed`，约 0.06~0.12 秒）：
 *   **提前**一点点看，所以下一词组开口之前构图已经在向它靠；
 * · 词组间权重 `w = exp(−½ × (distance(sampleTime, 该组 cue 区间) / sigma)²)`（`sigma = 0.30 + 0.20 × speed`）：
 *   区间内恒 1、区间外衰减 —— 密唱时相邻词组自然**融合**成共同区域，慢唱 / 空档时构图停在最近那一组的中心。
 * · 长竖排长段（一组里有很多粒字**依次**唱）另有一层**段内低频推进**：按"此刻唱到哪一粒"
 *   在一段**宽时间窗**（`窗口 = 1.2 × 段内中位字间步进`）里做定点高斯加权平均
 *   （`resolveSonnetCameraFocusBlockCenter`）。窗口比字距宽 ⇒ 一次推进跨好几粒字，
 *   不会"第一粒字刚冒头就把构图甩到整段远端"，也不会"一帧一个字地抖"。
 * · **横向长句**（落位确实是一条横排阅读路径时）换一层口径：把"显现前沿"沿 cue 时间轴
 *   铺成一条**因果平滑**的轨迹，再按**屏幕比例**求解轴心（见下面的水平长句一节）。
 *
 * === 与字形入场完全解耦 ===
 * 整条路径的输入只有三样：① 每个字 / 每个词组的**最终落点**；② 每个字的**开始唱时刻**；
 * ③ 当前**绝对时刻**（外加"这一段铺在哪儿、世界缩放多少"这类本帧恒定的取景事实）。
 * `glyph.motionX/motionY/weight/entryProgress` 这些入场字段**保留仅为接口兼容**，
 * 这里**明确忽略**；段间权重也**不**按逐字 α 归一化。
 * ⇒ 任意改动 glyph 的入场位移 / α / 入场进度，`resolveSonnetCameraFocus` 与
 *   `resolveSonnetCameraFocusBlockCenter` 的输出**逐值相同**（见 `sonnetCameraFocus.test.ts` 的契约用例）。
 *
 * === 连续性：说清楚是哪一种 ===
 * · 段内中心是**定点核加权平均**（归一化凸组合）⇒ 对 `t` 连续、且焦点落在参与点的凸包内。
 * · 横向长句的前沿是**阶梯的因果平滑**（解析式，见 `resolveSonnetCameraFocusHorizon`）⇒
 *   对 `t` **C¹ 连续**、单调不减、且**永不领先**真实阶梯（只可能滞后）。
 *   核是**单边 Rayleigh**：累积 `K(u) = 1 − exp(−u²/2)`，`K′(0⁺) = 0`
 *   ⇒ 每粒字 cue 处**速度没有台阶**（旧版正态 CDF 的 `K′(0⁺) ≈ 0.798` 会逐字叠一个台阶）。
 *   ⚠ 位移与速度都连续，但**加速度**在 cue 处仍会有折角（`K″(0⁺) = 1`）；别写成"平滑到任意阶"。
 *   ⚠ **本轮（SONNET_RESET_CONTINUOUS_20261014）修的是"C¹ 也会逐字顿挫"**：核宽不是整段一个，
 *   而是**每跳按局部 cue 间隔**放大（`resolveSonnetCameraFocusLocalSigmas`）。真实 YRC 的 cue
 *   间隔不均匀（《リセット》第 12 行 0.10~0.71s），整段中位 σ 下长音前那一跳会**在下一粒字开口前
 *   衰减完** ⇒ 固定世界点速度掉到 ~0（实测 74.68~74.85s），整行出现 12 个逐字速度脉冲。
 *   自适应后均匀 cue 逐值不变（既有 fixture 读数不变），不均匀 cue 的速度谷不再落近 0。
 *   ⚠ 它**不是**零相位 / 前视：因果核只会滞后，不会"提前看到下一粒字"。要提前看，
 *   靠的是 `sampleTime = time + lead` 这一项（词组之间），不是核本身。
 * ⚠ 口径：这里的"时间"是**唱词时间轴**（逐字 cue），不是音频 BPM；只吃绝对时刻与固定输入
 * ⇒ 直接 seek 到任意时刻、任意帧率都得到同一结果（**不依赖帧历史滤波**）。
 * ⚠ 空间量纲：输入中心与输出焦点是**画布像素**；`screenScale`（世界缩放）只用来把
 * "舒适区 / 屏幕目标比例"折算回画布像素。
 */

/**
 * 段内**某一粒字**：**最终落点** + 开始唱时刻（画布像素 / 秒）。
 *
 * ⚠ 只认落点 / 落位右缘 / cue 时刻。`motionX/motionY/weight/entryProgress` 是上一版
 * "让镜头跟着正在入场的字走"留下的输入，**本轮起被明确忽略**；字段保留只是为了让老调用者
 * 的构造代码继续编译。
 */
export interface SonnetCameraFocusGlyph {
  /** **最终落点**（入场走完后的画布坐标）—— 唯一被采用的空间量。 */
  readonly x: number;
  readonly y: number;
  readonly startTime: number;
  /**
   * 这一粒字**最终落位的右缘**（画布像素 x；缺省 = `x`，即把字当零宽点）。
   *
   * 用户量红线量的是"**已经唱到的那一粒字的右缘**"，不是中心。中心与右缘差半个字身，
   * 在长横排里就是一个不容忽视的系统偏差（几百像素的行宽上约 2%~4% 视口宽）。
   * 帧层用**排版解出来的真实步进**填它（见 `sonnetFrame` 的 `edgeX`）。
   */
  readonly edgeX?: number;
  /** @deprecated 本帧字形画在哪（含入场位移）。**不参与任何计算**。 */
  readonly motionX?: number;
  readonly motionY?: number;
  /** @deprecated 入场进度 0~1。**不参与任何计算**。 */
  readonly entryProgress?: number;
  /** @deprecated 入场透明度 / 可读权重。**不参与任何计算**。 */
  readonly weight?: number;
}

/** 构图用的语义词组：**最终落点中心** + **首 / 末字开始唱**的绝对时刻（画布像素 / 秒）。 */
export interface SonnetCameraFocusBlock {
  /** 段内首字的开始时刻（秒）。 */
  readonly startTime: number;
  /** 段内末字的**开始**时刻（秒）——不是唱完时刻。 */
  readonly endTime: number;
  readonly centerX: number;
  readonly centerY: number;
  /**
   * 这一段的**落位范围**（画布像素四至，可选）。
   *
   * 只给**水平长句判据**用（"这一段横着铺开了多宽 / 是不是一条横向阅读路径"）——它取自排版落位，
   * 不随逐字入场变。缺省时该段退化为"只有中心"，判据按单点处理（不会误开水平长句模式）。
   */
  readonly minX?: number;
  readonly minY?: number;
  readonly maxX?: number;
  readonly maxY?: number;
  /**
   * 逐字**最终落点**（可选；帧层给的是该段每个字的落点 / 右缘与开始唱时刻）。
   *
   * 给了它，横向长句就按"此刻唱到哪一粒"沿时间轴铺出前沿轨迹（见
   * `resolveSonnetCameraFocusHorizon`）；没给（或全不合法）时逐值退回 `centerX/centerY`
   * ⇒ 旧调用者与旧数学用例不变。**入场运动 / α / 入场进度一律不参与**。
   */
  readonly glyphs?: readonly SonnetCameraFocusGlyph[];
}

export interface SonnetCameraFocusOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /**
   * **局部唱速**（0 = 最慢 / 长音空档，1 = 最快；帧层的 `rhythm.speed`）。
   * 它同时决定提前量与词组间的融合宽度：快唱更早预看、融合更多邻组；慢唱更集中在近处词组。
   */
  readonly speed?: number;
  /**
   * **世界缩放**（`world.scale`，即"1 画布像素 = 多少屏幕像素"）。
   * 舒适区按**屏幕比例**给，靠它折算回画布像素；取本镜最大缩放 ⇒ 用最小的画布预算（保守）。
   * 水平长句的屏幕锚定另用 `worldScale`（本帧**实际**缩放，缺省退到它）。
   */
  readonly screenScale?: number;
  /** 焦点周围舒适区的半宽 / 半高（屏幕比例，见下面两个常量）。 */
  readonly comfortHalfXRatio?: number;
  readonly comfortHalfYRatio?: number;
  readonly leadBaseSeconds?: number;
  readonly leadSpeedGain?: number;
  readonly sigmaBaseSeconds?: number;
  readonly sigmaSpeedGain?: number;
  /**
   * **本帧屏幕原点 x**（画布像素）= 本镜取景锚点 + 本帧运镜平移（`W × (0.5 + camera.x)` 那一族；
   * 海报族是画面中心）。
   *
   * ⚠ **它同时是"要不要启用水平长句预排"的总开关**：不给 ⇒ 纯数学调用者，横向长句也逐值退回
   * **段内低频推进**（旧口径）；给了 ⇒ 才按屏幕比例求解轴心（见 `SONNET_CAMERA_FOCUS_HORIZONTAL_*`）。
   *
   * 为什么必须由调用者给：屏幕位置 ≈ `basePositionX + 世界缩放 × (落点 − 轴心)`，
   * 只挪焦点并不能确定屏幕坐标 —— 取景锚点、本帧运镜平移与世界缩放只有帧层知道。
   * 漏掉运镜平移那一项就会差 `camera.x × 视口宽`（实测某镜 0.12 × 1524 ≈ 183px）。
   */
  readonly basePositionX?: number;
  /** **本帧实际世界缩放**（`world.scale`，含运镜帧；缺省 = `screenScale`）。屏幕锚定解算用。 */
  readonly worldScale?: number;
  /**
   * **水平长句**的几个量（见 `SONNET_CAMERA_FOCUS_HORIZONTAL_*`）：
   * · `horizontalFrontSigmaSeconds`：显现前沿的因果平滑宽度 σ（秒；缺省按 cue 步进推）；
   * · `horizontalFrontRatio`：展开过程中"显现前沿"要落在屏幕的哪个比例（缺省 0.45W）；
   * · `horizontalTailRatio`：句末"尾端"要落在屏幕的哪个比例（缺省 = `horizontalFrontRatio`，
   *   即**不做句末构图**；生产帧层传 0.67）；
   * · `horizontalTailRampStart`：句末构图从**显现前沿世界进度**的哪个位置开始渐变（缺省 0.55）；
   * · `horizontalMinSpanRatio` / `horizontalFullSpanRatio`：横向宽度（视口宽比例）的**融合区间**；
   * · `horizontalMaxCrossRatio` / `horizontalMaxVariationRatio`：判"确实是一条横向阅读路径"的
   *   **交叉轴散布上限**与**总变差上限**（挡掉二维散布 / 走回头路的排版）。
   */
  readonly horizontalFrontSigmaSeconds?: number;
  readonly horizontalFrontRatio?: number;
  readonly horizontalTailRatio?: number;
  readonly horizontalTailRampStart?: number;
  readonly horizontalMinSpanRatio?: number;
  readonly horizontalFullSpanRatio?: number;
  readonly horizontalMaxCrossRatio?: number;
  readonly horizontalMaxVariationRatio?: number;
  /**
   * **本镜镜种**（`SonnetShotKind`，可选）。
   *
   * 水平长句预排**只对横排歌词镜种**启用；竖排为主的镜种（`mask-reveal`）即使某一帧的落位
   * 在横向上铺开，也不该被强加"横向推镜"的规则。缺省 = 允许（纯数学调用者不受影响）。
   */
  readonly shotKind?: string;
}

export interface SonnetCameraFocus {
  /** 预排焦点（画布像素）——`frame.pivot` 就按它走。 */
  readonly aimX: number;
  readonly aimY: number;
  /** 焦点周围的**固定舒适区**（画布像素）：取景层的温和兜底只盯它，不会把镜头拽回某个词。 */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** 参与融合的词组数。 */
  readonly blockCount: number;
  /** 采样时刻最近的词组下标（没有可用词组时 -1）。 */
  readonly activeIndex: number;
  /** 实际用的提前量 / 词组间高斯宽度 / 唱速（读数与用例共用）。 */
  readonly leadSeconds: number;
  readonly sigmaSeconds: number;
  readonly speed: number;
  /**
   * **显现前沿的预排位置**（画布像素 x）—— 只喂诊断与验收，**不**直接当瞄准点。
   *
   * ⚠ 口径别搞混：它是**落位前沿**（"已经开始唱的那几粒字"的**最终右缘**沿 cue 时间轴铺出来的
   * 因果平滑轨迹，见 `resolveSonnetCameraFocusHorizon`），**不是**"整个当前语义块的中心"、
   * 也不是"还没出现的未来词组的边界"。
   *
   * 水平长句模式下，屏幕上的显现前沿 = `horizontalFrontRatio × 视口宽 + 平滑滞后`（滞后 ≥ 0，
   * 见 `resolveSonnetCameraFocusHorizon` 的"永不领先"性质）⇒ **≥ 目标比例**是构造保证的。
   *
   * 没有可用的逐字落点时等于第一个词组的中心（退化时与旧读数同值）。
   */
  readonly frontRatio: number;
  /**
   * 这一帧的 `aimX` 是不是**已经解算好的屏幕锚定轴心**（横向长句 + 调用者给了取景事实）。
   *
   * 是 ⇒ 帧层应当**直接把 `aimX` 当 `pivot.x`**，不要再按动画强度档在 `basePivot` 与它之间混合：
   * 那一记混合会把预排好的屏幕比例整体放大 / 缩小（实测 `chaotic` 档 1.35 下尾端冲到 0.86 视口宽，
   * 越过用户"尾端 ≤ 0.8"的红线）。强度档仍然照原样管世界缩放、旋转、纵向构图与逐字入场动画。
   */
  readonly screenAnchored: boolean;
  /** 一行读数（dataset / 日志 / 探针）。 */
  readonly summary: string;
}

/**
 * **舒适区半宽 / 半高**（屏幕比例）：0.30 / 0.28 ⇒ 横向"不推镜头"的舒适区约 60% 画面宽。
 * 它是**固定**区域（不随焦点块大小变），所以取景兜底只会处理"世界缩放 / 运镜漂移把焦点推到边上"
 * 的残余，**不会**为每个当前词重新对焦。
 */
export const SONNET_CAMERA_FOCUS_COMFORT_HALF_X = 0.3;
export const SONNET_CAMERA_FOCUS_COMFORT_HALF_Y = 0.28;
/** 提前量：`lead = 基准 + 增益 × speed`（秒）—— 克制的一点点预看（0.06–0.12s）。 */
export const SONNET_CAMERA_FOCUS_LEAD_BASE = 0.06;
export const SONNET_CAMERA_FOCUS_LEAD_SPEED_GAIN = 0.06;
/** 词组**之间**的高斯宽度：`sigma = 基准 + 增益 × speed`（秒）。 */
export const SONNET_CAMERA_FOCUS_SIGMA_BASE = 0.3;
export const SONNET_CAMERA_FOCUS_SIGMA_SPEED_GAIN = 0.2;
export const SONNET_CAMERA_FOCUS_SCREEN_SCALE = 1;

/**
 * **段内低频推进的时间窗**：`窗口 = 倍率 × 段内中位字间步进`，再夹到 `[下限, 上限]` 秒。
 *
 * 这是"长竖排 / 无逐字落点时长段"的唯一尺度：窗口**比一个字距宽**（1.2 倍）⇒ 一次推进平均跨
 * 好几粒字（低频），既不会在首字冒头时抢跑到整段中心，也不会一帧一个字地硬跟；
 * 窗口又跟着**这一段自己的字距**缩放 ⇒ 密唱时窗口收窄、长音慢字时窗口放大。
 */
export const SONNET_CAMERA_FOCUS_REVEAL_WINDOW_PER_GLYPH = 1.2;
export const SONNET_CAMERA_FOCUS_REVEAL_WINDOW_MIN = 0.2;
export const SONNET_CAMERA_FOCUS_REVEAL_WINDOW_MAX = 1.6;
/**
 * 字距下限（秒）：比它更近的相邻字算"同一刻出现"（合唱 / 时间轴粒度），窗口不再跟着缩。
 * 没有它，一串同刻字会让窗口趋 0，段内中心退化成"逐字跳"。
 */
export const SONNET_CAMERA_FOCUS_MIN_GLYPH_STEP = 0.05;

/*
 * === 水平长句预排（展开前沿 ≥ 目标比例、句末尾端落在目标比例附近）===
 *
 * 用户给的两张截图量出来的是**屏幕空间**的两个比例：展开中红线约在 44%~45% 屏宽处、
 * 完成时约 67%。两者对应同一套可解的要求：
 *
 *   ① 展开中，"**已经唱到的那一粒字的最终右缘**"在屏幕上的横坐标要 ≥ `frontRatio × W`；
 *   ② 全部显现后，这一行的**右端**落在 `tailRatio × W` 附近。
 *
 * 为什么原来做不到：镜头的瞄准点是**语义词组中心的时间高斯混合**，长句里它会被"还没唱到的
 * 远端落点"往前拉，于是它跑在**显现前沿的前面**，前沿反被推到 0.34~0.41 视口宽（实测基线）。
 *
 * 修法（仍然是"预排"，不是"追字"）分三步，全部只吃**落点 / 右缘 + cue 时刻 + 绝对时刻**：
 *
 *   ① **前沿轨迹**：把同镜所有字的**最终右缘**按**开始唱时刻**排成时间轴，定义阶梯
 *      `step(t) = 最近一个 startTime ≤ t 的右缘`（t 早于首字时取首字右缘）。
 *      这是"此刻已经唱出来的内容的右边界"，**逐字有一个跳变**，不是连续的。
 *   ② **因果平滑**：`frontier(t) = (k ∗ step)(t)`，`k` 是**单边** Rayleigh 核（只取过去，
 *      `k(u) = u · exp(−u²/2)`，起点权重与起点斜率都为 0）。于是
 *      `frontier(t) ≤ step(t)` 恒成立（核权重非负、且每个 `step(t−τ)` 都 ≤ `step(t)`）
 *      —— 这就是"**永不领先**"：平滑只会让前沿滞后，绝不会提前跑到还没唱到的字那里。
 *      解析式见 `resolveSonnetCameraFocusHorizon`（闭式累积 `K`，所以是 **C¹** 函数而不是采样阶梯）。
 *   ③ **屏幕锚定**：屏幕位置对轴心是**仿射**的：
 *      `屏幕(x) = basePosition + 相机平移×视口 + 世界缩放 × (x − 轴心)`
 *      ⇒ 想让"前沿"落在 `target × W` 上，轴心就该取
 *      `轴心 = 前沿 − (target × W − basePosition) / 世界缩放`。
 *      `target` 在展开期取 `frontRatio`，随这一句的**显现前沿世界进度**连续渐变到 `tailRatio`
 *      （句末构图），渐变进度只由落位边缘与 cue 时刻算 ⇒ 与逐字入场 / 逐帧可见字无关，
 *      也**不会在前沿停住的空档里继续往右爬**（那会把镜头往左带，见 `resolveSonnetCameraFocusTailBlend`）。
 *
 * ⚠ `basePosition` 是本镜取景锚点（`W × (0.5 + 本镜 camera.x)`；海报族是画面中心），
 * 只有帧层知道。**不传它就不做屏幕锚定**（纯数学调用者拿到的前沿就是轴心）。
 */

/**
 * **显现前沿的因果平滑宽度**（秒）：`σ = 倍率 × 段内中位字间步进`，再夹到 `[下限, 上限]`。
 *
 * 为什么跟着字距走：单边 Rayleigh 核的**平均滞后 = √(π/2) × σ ≈ 1.253σ**，乘以前沿斜率
 * （≈ 字身 / 字距）就是屏幕上的滞后（≈ `倍率 × 1.253` 个字身）。
 *
 * 倍率取 **0.45**（旧版 `erf` 核是 0.6）：换成 Rayleigh 后同 σ 下滞后放大约 1.57 倍，
 * 若仍取 0.6，实测长横排在 1024×768 × 字号 1.4 档的**最高前沿**会到 0.812 视口宽，
 * 越过"前沿 ≤ 0.8"的红线。取 0.45 ⇒ 滞后 ≈ 0.56 个字身（比旧 0.6 档的 erf 核略大），
 * 实测四组视口/字号：展开期最低前沿 0.456~0.458、全程最高前沿 0.755~0.797、句末尾端 0.672
 * —— "展开前沿 ≥ 0.445、最高前沿 ≤ 0.8、句末尾端 0.62~0.72"同时守住（见生产 fixture 用例）。
 * 前沿速度峰值 = `e^{−1/2} × 跳变 / σ ≈ 0.607 × 跳变 / σ`（旧 erf 是 `0.798 × 跳变 / σ`）
 * ⇒ 峰值速度比旧版更低，观感更不容易"每粒字顶一下"。
 *
 * ⚠ 本轮起它只是**基准**核宽：每粒字 cue 的实际核宽按**局部字距**放大
 * （见 `SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_LOCAL_MAX` 与
 * `resolveSonnetCameraFocusLocalSigmas`）——均匀 cue 逐值不变，不均匀 cue 不再逐字起停。
 */
export const SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_PER_STEP = 0.45;
export const SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_MIN = 0.08;
export const SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_MAX = 0.8;
/**
 * **每粒字 cue 的平滑宽度自适应倍率上限**（SONNET_RESET_CONTINUOUS_20261014）。
 *
 * 上一版对**整段**用同一个 σ = 0.45 × 中位字距。真实 YRC 的 cue 间隔并不均匀
 * （《リセット》第 12 行 0.10~0.71s，中位 0.32s）：中位 σ ≈ 0.14s 意味着**字距 0.5~0.7s
 * 的那几跳**在下一粒字开唱前早已衰减完 —— 实测固定世界点速度在 74.68~74.85s 掉到
 * ~0px/s（0.2 秒的"停"），整行 4.5 秒里有 12 个逐字速度脉冲（≈ 每粒字一顿）。
 *
 * 修法（纯函数、无历史状态）：把 σ 从"整段一个"变成"**每跳一个**"，
 * `σᵢ = σ × clamp(localStepᵢ / typicalStep, 1, 本倍率)`，其中
 * `localStepᵢ = max(前一字距, 后一字距)`、`typicalStep = 本行字距中位`。
 * 于是：
 * ① **均匀字距 ⇒ 倍率恒为 1 ⇒ 逐值等于旧口径**（既有横排 fixture / 单元用例一字不改）；
 * ② 长音前的字跳被摊到更宽的窗里，下一粒字开口时它还没衰减完 ⇒ 速度不落近 0；
 * ③ 仍然是**单边核**：`K′(0⁺) = 0`、核权重非负、`K ≤ 1` ⇒ 永不领先阶梯、单调、C¹ 全都保住。
 *
 * 上限取 2（本歌最坏 local/typical ≈ 2.2，只有"日 / へ"两粒轻微触顶）：
 * · 再放大对速度谷的改善已经饱和（实测 1→2 把 <60px/s 的帧数从 42 降到 3，2→3 只再动 1 帧）；
 * · 而**真停顿**（1.5 秒级空档，见 `sonnetCameraFocus.test.ts` 的"句末空档"用例）里，
 *   σ 越大前沿在空档内越停不下来，会把句末比例再推 1px 量级 —— 取 2 时那条老护栏原样通过，
 *   不必放宽容差。
 */
export const SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_LOCAL_MAX = 2;
/**
 * 自适应后的 σ **绝对上限**（秒）：局部字距再大也不让前沿滞后超过这个量级
 * （句末构图要靠前沿在末字后不长的时间里饱和到尾端）。
 */
export const SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_CEIL = 1.6;
/**
 * **展开过程中要求显现前沿落到的屏幕比例**（视口宽）。
 *
 * 取 **0.45**（主人截图里那条红线）而不是更高：因果核只让前沿**滞后**，所以实测的
 * "最近已唱字右缘"永远 ≥ 这个比例 + 滞后量（换 Rayleigh 核后实测展开期最低 0.456，
 * 见生产 fixture 用例）。标称就贴着用户的下限给，"是否满足红线"由**实测**说话。
 */
export const SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_RATIO = 0.45;
/**
 * **句末构图**：这一句唱到最后一粒字时，尾端要落在屏幕的哪个比例上（主人量到约 0.67）。
 * 与 `frontRatio` 之间按**显现前沿世界进度**连续渐变（见 `SONNET_CAMERA_FOCUS_HORIZONTAL_TAIL_RAMP_START`）。
 */
export const SONNET_CAMERA_FOCUS_HORIZONTAL_TAIL_RATIO = 0.67;
/**
 * **句末渐变的起点**（本轮修：口径是**显现前沿的世界进度** `q`，不再是 cue 时间进度）。
 *
 * `q = (前沿 − 首字边缘) / (引导边界 − 首字边缘)`（见 `resolveSonnetCameraFocusFrontierProgress`）：
 * `q ≤ 0.55` 完全是展开构图；`q → 1` 完全走到句末构图（smoothstep，两端斜率为 0）。
 * 前沿在空档里**不涨** ⇒ `q` 不涨 ⇒ 目标比例不会在空档里偷偷挪动、把镜头往回带
 * （旧 cue 进度口径的实测反向 66.9px 正是这么来的）。两者都是落位边缘 + cue 时刻的纯函数
 * ⇒ 不做"看到末字才开始推"的逐帧判断。
 */
export const SONNET_CAMERA_FOCUS_HORIZONTAL_TAIL_RAMP_START = 0.55;
/**
 * **横向宽度（视口宽的比例）的连续融合区间**：低于 `MIN` 完全不启用（短句 / 竖排 / 海报照旧），
 * 到达 `FULL` 完全启用，中间用 smoothstep 过渡 ⇒ 不会有"哪一帧突然换规则"的台阶。
 */
export const SONNET_CAMERA_FOCUS_HORIZONTAL_MIN_SPAN_RATIO = 0.55;
export const SONNET_CAMERA_FOCUS_HORIZONTAL_FULL_SPAN_RATIO = 0.85;
/**
 * **判"确实是一条横向阅读路径"的两条几何闸门**（都只看落位与 cue 时刻）：
 *
 * · `MAX_CROSS_RATIO`：**交叉轴散布**（y 的极差）不得超过 `max(视口高 × 0.2, 横向跨度 × 0.3)`。
 *   二维散布的拼贴 / 海报 / 多行堆叠会在这里被挡掉（实测 English `type-impact` 那一镜
 *   y 极差 1743px、横向跨度 2263px ⇒ 1743 > max(165, 679) ⇒ 不启用）。
 * · `MAX_VARIATION_RATIO`：把字按 cue 排序后，x 的**总变差**不得超过净位移的 1.45 倍。
 *   一条真正的阅读路径就该是"一路往一个方向走"；走回头路的排版（x 忽左忽右）会被挡掉。
 *   只有总变差这一条就能挡掉"二维散布但恰好首尾 x 差很大"的镜（上一版正是被这种镜骗开的，
 *   结果前沿在时间轴上左右横跳、60Hz 实测轴心跳 300+px）。
 * · `MIN_SPAN_PX`：比它窄就直接当短段处理。
 */
export const SONNET_CAMERA_FOCUS_HORIZONTAL_MAX_CROSS_RATIO = 0.3;
export const SONNET_CAMERA_FOCUS_HORIZONTAL_MAX_CROSS_HEIGHT_RATIO = 0.2;
export const SONNET_CAMERA_FOCUS_HORIZONTAL_MAX_VARIATION_RATIO = 1.45;
export const SONNET_CAMERA_FOCUS_HORIZONTAL_MIN_SPAN_PX = 24;
/**
 * **竖排 / 拼贴镜种白名单的补集**：这些镜种的字以竖排为主，不启用水平长句预排。
 * 其余镜种只要落位**确实是一条横向阅读路径**（上面两条几何闸门），就允许启用 ——
 * 海报 / 社论栏也不例外：判据看的是"这一帧的字真的排成一条横线"，不是镜种名字。
 */
export const SONNET_CAMERA_FOCUS_HORIZONTAL_BLOCKED_SHOT_KINDS: readonly string[] = ['mask-reveal'];

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** 这一粒字的**最终右缘**（没给 `edgeX` 时退回中心）。 */
function glyphEdgeX(glyph: SonnetCameraFocusGlyph): number {
  return glyph.edgeX !== undefined && Number.isFinite(glyph.edgeX) ? glyph.edgeX : glyph.x;
}

/**
 * 这一段的**段内推进窗口**（秒）：按段内中位字间步进 × `PER_GLYPH` 缩放，再夹到上下限。
 *
 * 用**中位**而不是平均：时间轴里偶尔有一粒字离得特别远（长音 / 换气），平均会被它拉大、
 * 让整段的推进都变钝；中位只反映"这一段大多数时候多久唱一个字"。
 */
export function resolveSonnetCameraFocusRevealWindow(
  glyphs: readonly SonnetCameraFocusGlyph[],
): number {
  if (glyphs.length < 2) return SONNET_CAMERA_FOCUS_REVEAL_WINDOW_MIN;
  const steps: number[] = [];
  for (let index = 1; index < glyphs.length; index += 1) {
    const current = glyphs[index];
    const previous = glyphs[index - 1];
    if (current === undefined || previous === undefined) continue;
    const step = current.startTime - previous.startTime;
    if (Number.isFinite(step) && step >= SONNET_CAMERA_FOCUS_MIN_GLYPH_STEP) steps.push(step);
  }
  const preferred =
    median(steps) * SONNET_CAMERA_FOCUS_REVEAL_WINDOW_PER_GLYPH;
  return Math.min(
    SONNET_CAMERA_FOCUS_REVEAL_WINDOW_MAX,
    Math.max(SONNET_CAMERA_FOCUS_REVEAL_WINDOW_MIN, preferred),
  );
}

/**
 * 前沿因果核的宽度 σ（秒）：`倍率 × 段内中位字间步进`，夹到 `[下限, 上限]`。
 * 没有相邻字距（单字 / 同刻字）时取上限的保守值。
 */
export function resolveSonnetCameraFocusFrontSigma(
  glyphs: readonly SonnetCameraFocusGlyph[],
): number {
  if (glyphs.length < 2) return SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_MIN;
  const steps: number[] = [];
  for (let index = 1; index < glyphs.length; index += 1) {
    const current = glyphs[index];
    const previous = glyphs[index - 1];
    if (current === undefined || previous === undefined) continue;
    const step = current.startTime - previous.startTime;
    if (Number.isFinite(step) && step >= SONNET_CAMERA_FOCUS_MIN_GLYPH_STEP) steps.push(step);
  }
  const preferred =
    median(steps) * SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_PER_STEP;
  return Math.min(
    SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_MAX,
    Math.max(SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_MIN, preferred),
  );
}

/**
 * **段内此刻的构图中心**（纯函数）：在**宽时间窗**里对"此刻附近那几粒字"的**最终落点**做定点加权平均。
 *
 * · 时间窗 `window = 1.2 × 该段中位字间步进`（夹 [0.2, 1.6] 秒）：窗口**比字距宽** ⇒ 一次推进跨
 *   好几粒字，路径是低频的；窗口又跟着本段字距缩放 ⇒ 唱得快就收窄、长音就放宽，速度随**唱速**变，
 *   但不随任何一粒字的入场运动变；
 * · 位置只取 `x/y`（**最终落点**）；`motionX/motionY/weight/entryProgress` **一律不读**；
 * · 同一刻出现的字（字距 < `MIN_GLYPH_STEP`）会一起参与平均 ⇒ 不会逐字跳；
 * · 全段都还没开唱时窗口自然只罩住首字 ⇒ 焦点停在首字附近（不抢跑到整段中心）；
 * · 唱完之后窗口罩住末字附近 ⇒ 焦点停在末字附近。
 *
 * 没有逐字落点数据（或全不合法）时退回块的静态中心 `centerX/centerY`（旧口径，逐值不变）。
 */
export function resolveSonnetCameraFocusBlockCenter(
  block: SonnetCameraFocusBlock,
  time: number,
): { readonly x: number; readonly y: number } {
  const glyphs = block.glyphs;
  if (glyphs === undefined || glyphs.length === 0) return { x: block.centerX, y: block.centerY };
  const usable: SonnetCameraFocusGlyph[] = [];
  for (const glyph of glyphs) {
    if (Number.isFinite(glyph.x) && Number.isFinite(glyph.y) && Number.isFinite(glyph.startTime)) {
      usable.push(glyph);
    }
  }
  if (usable.length === 0) return { x: block.centerX, y: block.centerY };
  usable.sort((first, second) => first.startTime - second.startTime);
  const safeTime = Number.isFinite(time) ? time : 0;
  const window = resolveSonnetCameraFocusRevealWindow(usable);
  let weightSum = 0;
  let centerX = 0;
  let centerY = 0;
  for (const glyph of usable) {
    /* 定点高斯：只用最终落点与开始唱时刻，和入场运动完全无关。 */
    const offset = (safeTime - glyph.startTime) / window;
    const weight = Math.exp(-0.5 * offset * offset);
    weightSum += weight;
    centerX += glyph.x * weight;
    centerY += glyph.y * weight;
  }
  if (!(weightSum > 0)) {
    /* 极长时间轴上所有权重都下溢：退回**时间上最近的那一粒字**（不是整段中心，免得抢跑到远端）。 */
    let nearest = usable[0];
    if (nearest === undefined) return { x: block.centerX, y: block.centerY };
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const glyph of usable) {
      const distance = Math.abs(glyph.startTime - safeTime);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = glyph;
      }
    }
    return { x: nearest.x, y: nearest.y };
  }
  return { x: centerX / weightSum, y: centerY / weightSum };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** `s²(3 − 2s)`：两端斜率为 0 的单调过渡（用于横向宽度的融合系数与句末渐变权重）。 */
function smoothstep01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/**
 * **因果平滑核的累积函数** `K(u)`（Rayleigh 累积）—— 这一层真正的核：
 *
 * ```
 *   K(u) = u ≤ 0 ? 0 : 1 − exp(−u²/2)          （u = (t − tᵢ) / σ）
 *   k(u) = K′(u) = u ≤ 0 ? 0 : u · exp(−u²/2)  （核权重，恒 ≥ 0）
 * ```
 *
 * 为什么是它（而不是旧版的正态 CDF `erf`）：`erf` 在起点 `u = 0⁺` 的斜率是
 * `√(2/π) ≈ 0.798`，每粒字 cue 都会给速度叠一个台阶（实测 369px/s，见
 * `sonnetCameraFocus.test.ts` 的 cue 速度用例）；`K′(0⁺) = 0` 则把台阶**归零**，
 * 于是整条前沿对 `t` **C¹ 连续**。
 *
 * 同时三条老性质一条不少：
 * ① `K` 单调不减、`K(u ≤ 0) = 0`、`K(+∞) = 1` ⇒ 前沿仍是"过去值的凸组合"，**永不领先**；
 * ② 核权重 `k(u) ≥ 0`（只取过去）⇒ 阶梯单调则前沿单调，位移没有台阶；
 * ③ 解析闭式、只吃 `t` 与 cue 时刻 ⇒ 无历史状态、seek 确定性不变。
 *
 * 代价：位置滞后变大（Rayleigh 均值 `√(π/2) · σ ≈ 1.253σ`，旧 `erf` 是 `√(2/π) · σ ≈ 0.798σ`），
 * 所以 σ 的倍率另行标定（见 `SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_PER_STEP`）。
 * 数值上用 `expm1` 而不是 `1 − exp`：`u → 0⁺` 时 `K ≈ u²/2`，`expm1` 在小量级不失精度。
 */
function rayleighCumulative(value: number): number {
  if (!(value > 0)) return 0;
  return -Math.expm1(-0.5 * value * value);
}

/** 时间轴上一粒字（水平长句判据与显现前沿用）。 */
interface HorizonGlyph {
  readonly x: number;
  readonly y: number;
  readonly startTime: number;
}

/**
 * **每粒字 cue 的平滑宽度**（秒，`resolveSonnetCameraFocusHorizon` 的核宽度序列）。
 *
 * `σᵢ = sigmaSeconds × clamp(max(前一字距, 后一字距) / 本行字距中位, 1, LOCAL_MAX)`，再夹到
 * `CEIL`。均匀字距 ⇒ 倍率恒 1 ⇒ 与旧版"整段一个 σ"**逐值相同**；不均匀 cue 里长音前的跳变
 * 会被摊到更宽的窗口，下一粒字开口时它仍在贡献速度 ⇒ 不再逐字"起—停—起"。
 *
 * ⚠ 只吃 cue 时刻（列表本身），不吃任何未来**落点**：把还没开始唱的字挪远，当前值逐值不变。
 */
export function resolveSonnetCameraFocusLocalSigmas(
  knots: readonly { readonly startTime: number }[],
  sigmaSeconds: number,
): number[] {
  const count = knots.length;
  const sigmas: number[] = new Array(count);
  if (count === 0) return sigmas;
  const steps: number[] = [];
  for (let index = 1; index < count; index += 1) {
    const current = knots[index];
    const previous = knots[index - 1];
    if (current === undefined || previous === undefined) continue;
    const step = current.startTime - previous.startTime;
    if (Number.isFinite(step) && step >= SONNET_CAMERA_FOCUS_MIN_GLYPH_STEP) steps.push(step);
  }
  const typical = steps.length > 0 ? median(steps) : 0;
  for (let index = 0; index < count; index += 1) {
    const current = knots[index];
    if (current === undefined || !(typical > 1e-6)) {
      sigmas[index] = sigmaSeconds;
      continue;
    }
    const previous = knots[index - 1];
    const next = knots[index + 1];
    const before =
      previous === undefined ? 0 : Math.max(0, current.startTime - previous.startTime);
    const after = next === undefined ? 0 : Math.max(0, next.startTime - current.startTime);
    const local = Math.max(before, after);
    const gain = Math.min(
      SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_LOCAL_MAX,
      Math.max(1, local / typical),
    );
    const widened = sigmaSeconds * gain;
    sigmas[index] = Math.min(
      SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_CEIL,
      Number.isFinite(widened) ? widened : sigmaSeconds,
    );
  }
  return sigmas;
}

/**
 * **水平长句的融合系数**（0 = 完全用旧口径的块中心，1 = 完全用显现前沿锚定）。
 *
 * 判据**全部来自落位几何与开始唱时刻**（不看入场位移 / α / 入场进度）：
 * ① 这一镜的落位确实**横向铺开**（横向跨度 ≥ 0.55 视口宽，到 0.85 视口宽为满档，中间 smoothstep）；
 * ② **交叉轴收得住**：y 极差 ≤ `max(0.2 × 视口高, 0.3 × 横向跨度)` ⇒ 挡二维散布；
 * ③ **时间上是一条路**：按 cue 排序后 x 的总变差 ≤ 1.45 × 净位移 ⇒ 挡走回头路的排版；
 * ④ 镜种不是竖排为主的那些（`mask-reveal` 除外）。
 *
 * 任何一条不满足都返回 0 ⇒ 短句、竖排、海报、拼贴的旧行为逐值不变。
 */
function resolveHorizontalBlend(
  glyphs: readonly HorizonGlyph[],
  options: SonnetCameraFocusOptions,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const blocked =
    options.shotKind !== undefined &&
    SONNET_CAMERA_FOCUS_HORIZONTAL_BLOCKED_SHOT_KINDS.includes(options.shotKind);
  if (blocked) return 0;
  if (glyphs.length < 3 || viewportWidth <= 0) return 0;
  const sorted = [...glyphs].sort((first, second) => first.startTime - second.startTime);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const glyph of sorted) {
    if (glyph.x < minX) minX = glyph.x;
    if (glyph.x > maxX) maxX = glyph.x;
    if (glyph.y < minY) minY = glyph.y;
    if (glyph.y > maxY) maxY = glyph.y;
  }
  const spanX = maxX - minX;
  if (!(spanX >= SONNET_CAMERA_FOCUS_HORIZONTAL_MIN_SPAN_PX)) return 0;
  const spanRatio = spanX / viewportWidth;
  const minRatio = positiveOr(
    options.horizontalMinSpanRatio,
    SONNET_CAMERA_FOCUS_HORIZONTAL_MIN_SPAN_RATIO,
  );
  const fullRatio = Math.max(
    minRatio + 1e-6,
    positiveOr(options.horizontalFullSpanRatio, SONNET_CAMERA_FOCUS_HORIZONTAL_FULL_SPAN_RATIO),
  );
  if (!(spanRatio > minRatio)) return 0;
  /* ② 交叉轴散布：二维散布 / 斜线 / 多行堆叠都在这里出局。 */
  const crossSpread = maxY - minY;
  const crossLimit = Math.max(
    Math.max(0, viewportHeight) * SONNET_CAMERA_FOCUS_HORIZONTAL_MAX_CROSS_HEIGHT_RATIO,
    spanX * positiveOr(options.horizontalMaxCrossRatio, SONNET_CAMERA_FOCUS_HORIZONTAL_MAX_CROSS_RATIO),
  );
  if (crossSpread > crossLimit) return 0;
  /* ③ 总变差：一条阅读路径应当"一路只往一个方向走"。 */
  let netX = 0;
  let variation = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];
    if (current === undefined || previous === undefined) continue;
    variation += Math.abs(current.x - previous.x);
  }
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first !== undefined && last !== undefined) netX = Math.abs(last.x - first.x);
  if (!(netX > 1)) return 0;
  const variationLimit =
    netX *
    positiveOr(options.horizontalMaxVariationRatio, SONNET_CAMERA_FOCUS_HORIZONTAL_MAX_VARIATION_RATIO);
  if (variation > variationLimit) return 0;
  const blend = smoothstep01((spanRatio - minRatio) / (fullRatio - minRatio));
  return Number.isFinite(blend) && blend > 0 ? blend : 0;
}

/**
 * **显现前沿的预排位置**（画布像素 x）—— "已唱出来的内容**引导边界**"的因果平滑轨迹。
 *
 * === 它是什么 ===
 * 时间轴上先定义**阶梯**：`step(τ) = 已开始唱的那些字里、沿读法方向最远的那条落位边缘`
 * （读法向右 ⇒ 运行最大右缘；向左 ⇒ 运行最小左缘；τ 早于首字时取首字）。
 *
 * ⚠ **为什么不是"最近开始唱的那一粒的右缘"**（本轮修）：排版允许**小幅反向落点** ——
 * 强调块换行、字重变化、词间距都会让某一粒字落在前一粒的左边，而"总变差 ≤ 1.45 × 净位移"
 * 这条闸门恰恰放行它们（见 `SONNET_CAMERA_FOCUS_HORIZONTAL_MAX_VARIATION_RATIO`）。
 * 拿"最新那粒"的右缘做阶梯时，前沿会跟着这粒字**回头**，于是镜头在词间左右拉扯
 * （实测合成 fixture：4 个 run、每次退 10~30px ⇒ aim 出现 4 次反向、累计 88px）。
 * 取**运行极值**以后，反向落点只让边界**原地不动**（那粒字本来就在已显现区域内部），
 * 前沿对时间的单调性由构造保证 ⇒ 屏幕锚定出来的轴心不会反向。
 * 对严格单调的排版，运行极值与"最新一粒"**逐值相同**（既有横排 fixture 读数不变）。
 * 再对它做**单边（因果）平滑卷积**：
 *
 * ```
 *   frontier(t) = (k ∗ step)(t) = ∫₀^∞ k(τ) · step(t − τ) dτ ,  k 是单边 Rayleigh 核
 * ```
 *
 * 解析式：把阶梯写成 `step(τ) = x₀ + Σᵢ dᵢ · 1[τ ≥ tᵢ]`（`dᵢ` 是第 i 粒字带来的跳变），
 * 于是 `frontier(t) = x₀ + Σᵢ dᵢ · K((t − tᵢ) / σ)`，其中
 * `K(u) = u ≤ 0 ? 0 : 1 − exp(−u²/2)` 是单边 Rayleigh 核的累积
 * （`K(u ≤ 0) = 0`、`K(+∞) = 1`、**单调不减**、**`K′(0⁺) = 0`**）。
 *
 * === 四条性质（这是这一层的全部卖点）===
 * ① **永不领先**：核权重非负、每个 `step(t − τ) ≤ step(t)`（运行极值本身单调）⇒ `frontier(t) ≤ step(t)`。
 *    屏幕锚定把 `frontier` 放到目标比例上 ⇒ 屏幕上"已显现内容的引导边界"**只会 ≥ 目标比例**
 *    （差值 = 平滑滞后，构图上表现为前沿略偏右，不会偏左）。上一版把"已经出现的字的加权中心"
 *    当前沿，那个量既不是前沿也会**抢在**真实前沿前面 ⇒ 实测被压到 0.34~0.41 视口宽。
 * ② **C¹ 连续、单调不减**：`K` 连续、核权重 `k(u) = u · exp(−u²/2) ≥ 0`、`step` 单调不减
 *    （运行极值保证）⇒ `frontier` 对 `t` 连续、单调（不会来回甩）；又因 `K′(0⁺) = 0`，每粒字 cue 处
 *    **左右导数相等（都是 0 的直接贡献）⇒ 速度没有台阶**（旧版正态 CDF 的 `K′(0⁺) ≈ 0.798`
 *    会逐字叠一个 `0.798 / σ × 跳变` 的速度台阶，实测 369px/s；`erf` 与旧注释已删净）。
 *    位移同样没有台阶（单元用例量过：1/240 秒一步 < 2px）。
 * ③ **不是前视**：因果核只会滞后。要提前看下一词组，靠的是上层 `sampleTime = time + lead`；
 *    这一层不做、也不能做"未来字前瞻"（那会让前沿跑到还没唱的字上）。
 * ④ **解析闭式、无状态**：只吃 `t` 与 cue 时刻 ⇒ 直接 seek、任意帧率得到同一结果。
 *
 * 滞后量：单边 Rayleigh 核的**平均滞后** = `√(π/2) × σ ≈ 1.253σ`，乘以前沿斜率
 * （≈ 一个字身 / 一个字距）就是屏幕上的滞后（所以 σ 的倍率按"滞后 ≈ 多少个字身"标定）。
 * 滞后在**字身尺度**上恒定，不会"密唱滞后半个屏幕、慢唱完全不滞后"。
 *
 * ⚠ **本轮（SONNET_RESET_CONTINUOUS_20261014）：σ 逐跳自适应**。`sigmaSeconds` 从"整段一个核宽"
 * 改口径为**基准核宽**：第 i 跳实际用 `σᵢ = sigmaSeconds × clamp(localStepᵢ / typicalStep, 1, MAX)`
 * （见 `resolveSonnetCameraFocusLocalSigmas`）。均匀 cue ⇒ 倍率恒 1 ⇒ **与旧口径逐值相同**；
 * 不均匀 cue 里长音前的跳变被摊宽，消除"每粒字起—停—起"的脉冲速度（实测见文件头与本文件的
 * `resolveSonnetCameraFocusLocalSigmas` 注释）。
 *
 * `sigmaSeconds` 或逐字数据不可用时退回 `fallbackX`（= 最近的词组中心）。
 */
export function resolveSonnetCameraFocusHorizon(
  glyphs: readonly SonnetCameraFocusGlyph[],
  time: number,
  sigmaSeconds: number,
  fallbackX: number,
): number {
  const knots: HorizonGlyph[] = [];
  for (const glyph of glyphs) {
    const edge = glyphEdgeX(glyph);
    if (Number.isFinite(edge) && Number.isFinite(glyph.startTime)) {
      knots.push({ x: edge, y: Number.isFinite(glyph.y) ? glyph.y : 0, startTime: glyph.startTime });
    }
  }
  if (knots.length === 0) return fallbackX;
  knots.sort((first, second) => first.startTime - second.startTime);
  const safeTime = Number.isFinite(time) ? time : 0;
  const sigma =
    Number.isFinite(sigmaSeconds) && sigmaSeconds > 1e-4
      ? Math.min(sigmaSeconds, 8)
      : SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_SIGMA_MIN;
  const sigmas = resolveSonnetCameraFocusLocalSigmas(knots, sigma);
  const first = knots[0];
  if (first === undefined) return fallbackX;
  /*
   * **方向连贯化**（本轮修）：先把阶梯换成**运行极值**，再算解析跳变。
   *
   * 读法向由"按 cue 排序后的首 / 末字 x"决定（`last − first` 的符号）；向右取运行最大、
   * 向左取运行最小。于是：
   * · 单调排版 ⇒ `committed === 逐字右缘`，**逐值等于旧口径**（既有横排 fixture 一字不改）；
   * · 小幅反向落点 ⇒ `committed` 原地不动（跳变为 0），前沿不会带着镜头回头；
   * · 跳变仍恒为**读法方向**（≥ 0 / ≤ 0），Rayleigh 核权重非负 ⇒ 前沿对时间单调、C¹ 连续。
   */
  const last = knots[knots.length - 1];
  const direction = last !== undefined && last.x < first.x ? -1 : 1;
  const committed: number[] = new Array(knots.length);
  let extreme = first.x;
  committed[0] = extreme;
  for (let index = 1; index < knots.length; index += 1) {
    const knot = knots[index];
    if (knot === undefined) continue;
    extreme = direction > 0 ? Math.max(extreme, knot.x) : Math.min(extreme, knot.x);
    committed[index] = extreme;
  }
  /*
   * 解析式直接累加：`frontier(t) = x₀ + Σᵢ dᵢ · K((t − tᵢ) / σᵢ)`，只算 `tᵢ ≤ t` 的跳变
   * （未来的字 `offset ≤ 0` ⇒ `K = 0`，**真的为 0**，不是"很小"）。`dᵢ` 是**运行极值的跳变**
   * （`committed[i] − committed[i−1]`，恒为读法方向），第 0 粒为 0；
   * `σᵢ` 是**这一跳自己的**核宽（见 `resolveSonnetCameraFocusLocalSigmas`）。
   *
   * ⚠ **不设 6σ 截断窗**：`K(u)` 在 `u ≳ 8.6` 时在 double 下**精确等于 1**
   * （`exp(−u²/2) < 2⁻⁵³`），更早的跳变自动按满权重计入。截断窗会引入一个
   * `跳变 × 1.5e−8` 的微小断层，虽然不可观测，但"精确因果卷积"更简单也真的处处 C¹。
   */
  let frontier = first.x;
  for (let index = 0; index < knots.length; index += 1) {
    const knot = knots[index];
    if (knot === undefined) continue;
    const offset = safeTime - knot.startTime;
    if (offset <= 0) continue;
    const previous = index === 0 ? first.x : (committed[index - 1] ?? first.x);
    const jump = (committed[index] ?? first.x) - previous;
    if (jump === 0) continue;
    frontier += jump * rayleighCumulative(offset / (sigmas[index] ?? sigma));
  }
  return Number.isFinite(frontier) ? frontier : fallbackX;
}

/** 一个词组能不能参与融合：时段与中心都是有限值。 */
function isUsableFocusBlock(block: SonnetCameraFocusBlock): boolean {
  return (
    Number.isFinite(block.startTime) &&
    Number.isFinite(block.endTime) &&
    Number.isFinite(block.centerX) &&
    Number.isFinite(block.centerY)
  );
}

/** `time` 到"这段 cue 区间"的距离：区间内为 0（与参考源码同一口径）。 */
function cueDistance(block: SonnetCameraFocusBlock, time: number): number {
  const start = Math.min(block.startTime, block.endTime);
  const end = Math.max(block.startTime, block.endTime);
  if (time < start) return start - time;
  if (time > end) return time - end;
  return 0;
}

/**
 * **句末构图的渐变权重**（0 = 展开构图，1 = 句末构图）。
 *
 * ⚠ **本轮修：进度口径从"cue 时间进度"换成"显现前沿的世界进度"**。
 *
 * 旧口径 `p = (t − 首字开始) / (末字开始 − 首字开始)`：目标比例的时间变化率与内容推进**无关**。
 * 于是当两粒字之间有一个长音空档（前沿在世界里**停住**）时，目标比例仍在往 0.67 爬 ——
 * 屏幕上的尾端要往右挪，只能靠**镜头往左退**，那就是主人看到的"总体往右却左右回摆"。
 * 真歌《One More Light》167.05~172.25s 那一镜实测：排版严格单调（总变差 / 净位移 = 1.000），
 * 反向 66.9px 全部落在 "we"（170.09s）与 "are"（170.59s）之间的空档里，目标比例
 * `0.541W → 0.601W`，而前沿停在 `1659.4` 不动 —— 反方向正是这记斜坡。
 *
 * 新口径：进度取**前沿在整行里的归一化位置**
 * `q = (frontier − 首字边缘) / (引导边界 − 首字边缘)`（对向左读法同样成立，见
 * `resolveSonnetCameraFocusFrontierProgress`）。前沿本身是"内容推进"的因果函数 ⇒
 * `q` 在空档里**不涨**、在内容推进时才涨；目标比例于是只会在内容真的往前走时移动，
 * 镜头不会为了构图倒退。两条老性质都保住：
 * ① `q` 单调 ⇒ `tailBlend` 单调，`targetRatio` 单调；
 * ② 目标比例的最大变化率 ≤ `Δ × smoothstep′ / 整行跨度`，远小于"前沿推进率"（长横排跨度
 *    ≥ 0.55 视口宽 ⇒ 比值 ≈ 0.2~0.5 < 1）⇒ 解出来的轴心沿读法方向单调（不会反向）。
 *
 * 展开期（`q ≤ 起点`）仍是纯展开构图 `frontRatio`；前沿走到整行末端（`q = 1`）时
 * `targetRatio = tailRatio`（前沿就是尾端）⇒ 用户量到的 45% / 67% 两端逐值不变。
 * 与"此刻唱到哪一粒 / 它飞在哪"仍然无关（只吃落位边缘与 cue 时刻），没有逐帧状态。
 */
function resolveSonnetCameraFocusTailBlend(progress: number, rampStartRatio: number): number {
  const start = Math.min(0.95, Math.max(0, rampStartRatio));
  return smoothstep01((clamp01(progress) - start) / Math.max(1e-6, 1 - start));
}

/**
 * **显现前沿的世界进度** `q ∈ [0, 1]`：前沿已经从整行首 edge 走到引导边界的哪个位置。
 *
 * 读法向由按 cue 排序后的首 / 末字 x 决定（与 `resolveSonnetCameraFocusHorizon` 同一口径）；
 * `frontierX` 是因果平滑后的前沿（介于首字 edge 与引导边界之间）⇒ 比值天然落在 `[0, 1]`。
 * 退化（整行跨度 < 1e-6，例如全部同 x）时退回 **cue 时间进度**，保持连续且不给 NaN。
 */
function resolveSonnetCameraFocusFrontierProgress(
  glyphs: readonly HorizonGlyph[],
  frontierX: number,
  sampleTime: number,
): number {
  if (glyphs.length < 2) return 0;
  const sorted = [...glyphs].sort((first, second) => first.startTime - second.startTime);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return 0;
  const direction = last.x < first.x ? -1 : 1;
  let end = first.x;
  for (const glyph of sorted) {
    end = direction > 0 ? Math.max(end, glyph.x) : Math.min(end, glyph.x);
  }
  const span = end - first.x;
  if (Math.abs(span) > 1e-6) {
    return clamp01((frontierX - first.x) / span);
  }
  /* 退化：cue 时间进度（只用于"整行同 x"这种没有空间意义的排版，保证仍连续）。 */
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const glyph of sorted) {
    if (glyph.startTime < earliest) earliest = glyph.startTime;
    if (glyph.startTime > latest) latest = glyph.startTime;
  }
  const cueSpan = latest - earliest;
  return cueSpan > 1e-6 ? clamp01((sampleTime - earliest) / cueSpan) : 0;
}

/**
 * **此刻的预排焦点**（纯函数）。
 *
 * `sampleTime = time + lead` 上给每个词组算高斯权重、归一化后取**加权中心**；一个可用词组都没有时
 * 返回 `null`（帧层据此退回静态轴心、取景层不做平移兜底）。
 *
 * ⚠ 权重只吃**真实 cue 区间距离**与局部唱速：不再乘"逐字 α 的最大值"那一项
 * （那正是"每粒字冒出就顶一下镜头"的来源）。
 */
export function resolveSonnetCameraFocus(
  blocks: readonly SonnetCameraFocusBlock[],
  time: number,
  options: SonnetCameraFocusOptions,
): SonnetCameraFocus | null {
  const viewportWidth = Math.max(0, finiteOr(options.viewportWidth, 0));
  const viewportHeight = Math.max(0, finiteOr(options.viewportHeight, 0));
  const screenScale = positiveOr(options.screenScale, SONNET_CAMERA_FOCUS_SCREEN_SCALE);
  const speed = clamp01(finiteOr(options.speed, 0));
  const usable: SonnetCameraFocusBlock[] = [];
  for (const block of blocks) {
    if (isUsableFocusBlock(block)) usable.push(block);
  }
  if (usable.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return null;

  const lead =
    positiveOr(options.leadBaseSeconds, SONNET_CAMERA_FOCUS_LEAD_BASE) +
    positiveOr(options.leadSpeedGain, SONNET_CAMERA_FOCUS_LEAD_SPEED_GAIN) * speed;
  const sigma =
    positiveOr(options.sigmaBaseSeconds, SONNET_CAMERA_FOCUS_SIGMA_BASE) +
    positiveOr(options.sigmaSpeedGain, SONNET_CAMERA_FOCUS_SIGMA_SPEED_GAIN) * speed;
  const safeTime = Number.isFinite(time) ? time : 0;
  const sampleTime = safeTime + lead;

  /*
   * **水平长句预排**（见 `SONNET_CAMERA_FOCUS_HORIZONTAL_*` 与 `resolveSonnetCameraFocusHorizon`）：
   * 先把这一镜所有逐字**右缘**摊平成一条 cue 时间轴，再算因果平滑的显现前沿。
   *
   * ⚠ **总开关是"调用者有没有给本帧取景事实"**（`basePositionX` / `worldScale`，只有帧层知道）：
   * 不给 ⇒ 整层不启用，逐值退回**段内低频推进**（旧口径，纯数学调用者与旧迭代用例不变）；
   * 给了 ⇒ 才把前沿锚到屏幕比例上。"屏幕锚定"是这一层的**唯一目的**，离开屏幕事实它没有意义
   * （前沿即轴心那种半开状态既不是旧口径、也没有可验收的屏幕语义）。
   */
  const screenAnchorEnabled = Number.isFinite(options.basePositionX);
  const horizonGlyphs: HorizonGlyph[] = [];
  const horizonCues: SonnetCameraFocusGlyph[] = [];
  for (const block of usable) {
    for (const glyph of block.glyphs ?? []) {
      const edge = glyphEdgeX(glyph);
      if (!Number.isFinite(edge) || !Number.isFinite(glyph.startTime)) continue;
      horizonGlyphs.push({
        x: edge,
        y: Number.isFinite(glyph.y) ? glyph.y : 0,
        startTime: glyph.startTime,
      });
      horizonCues.push(glyph);
    }
  }
  const horizontalBlend = screenAnchorEnabled
    ? resolveHorizontalBlend(horizonGlyphs, options, viewportWidth, viewportHeight)
    : 0;
  const anchorBasePositionX = screenAnchorEnabled ? (options.basePositionX ?? 0) : 0;
  const anchorWorldScale = positiveOr(options.worldScale, screenScale);
  const frontTargetRatio = clamp01(
    finiteOr(options.horizontalFrontRatio, SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_RATIO),
  );
  const tailTargetRatio = clamp01(
    finiteOr(options.horizontalTailRatio, frontTargetRatio),
  );
  let horizonX = 0;
  let horizonAimX = 0;
  let screenAnchored = false;
  if (horizontalBlend > 0) {
    const nearestBlock = usable[0];
    const fallbackCenterX =
      nearestBlock === undefined ? 0 : resolveSonnetCameraFocusBlockCenter(nearestBlock, sampleTime).x;
    /*
     * ⚠ **前沿用"此刻"（`safeTime`）而不是 `sampleTime`**：`lead` 是给**词组之间**的融合用的
     * （下一词组开口前先靠过去）。对"显现前沿"这个屏幕比例要求来说，`sampleTime` 相当于把
     * 前沿往右多半拍 —— 实测会把实测前沿压掉约 `lead × 前沿斜率 × 缩放 ≈ 0.03 视口宽`，
     * 正好吃掉用户的容差。因果核本来就只有滞后，这里不再额外加一次前视。
     */
    horizonX = resolveSonnetCameraFocusHorizon(
      horizonCues,
      safeTime,
      positiveOr(
        options.horizontalFrontSigmaSeconds,
        resolveSonnetCameraFocusFrontSigma(horizonCues),
      ),
      fallbackCenterX,
    );
    if (!screenAnchorEnabled) {
      /* 兜底：上面已经把这种情况的 `horizontalBlend` 压成 0，这里只是防御性写法。 */
      horizonAimX = horizonX;
    } else {
      /*
       * **句末构图**：把 `τ` 从展开比例**连续**渐变到句末比例。渐变进度是**显现前沿的世界进度**
       * （`q`，见 `resolveSonnetCameraFocusTailBlend` 的说明）—— 空档里前沿不动、`q` 不涨，
       * 镜头就不会为了把尾端挪到 0.67 而往左退。
       *
       * ⚠ 变的是**目标比例**，不是"锚哪个点"：锚点始终是**显现前沿**。于是
       * ① 展开期前沿落在 `frontRatio` 上（因果核只让实测前沿 ≥ 它）；
       * ② 前沿走到末字（`q = 1`，此时前沿就是尾端）时 `τ = tailRatio`
       *    ⇒ 尾端自然落在 `tailRatio`。中途若改锚到"整行尾端"，实测前沿会掉到目标左边
       *    （尾端在世界里离前沿还有大半行），实测过：t=6/7 掉到 0.34 —— 所以不做那件事。
       */
      const frontierProgress = resolveSonnetCameraFocusFrontierProgress(
        horizonGlyphs,
        horizonX,
        sampleTime,
      );
      const tailBlend =
        tailTargetRatio > frontTargetRatio
          ? resolveSonnetCameraFocusTailBlend(
              frontierProgress,
              finiteOr(
                options.horizontalTailRampStart,
                SONNET_CAMERA_FOCUS_HORIZONTAL_TAIL_RAMP_START,
              ),
            )
          : 0;
      const targetRatio = frontTargetRatio + (tailTargetRatio - frontTargetRatio) * tailBlend;
      const targetScreenX = targetRatio * viewportWidth;
      horizonAimX = horizonX - (targetScreenX - anchorBasePositionX) / anchorWorldScale;
      screenAnchored = true;
    }
  }

  let weightSum = 0;
  let focusX = 0;
  let focusY = 0;
  let activeIndex = 0;
  let activeDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < usable.length; index += 1) {
    const block = usable[index];
    if (block === undefined) continue;
    const distance = cueDistance(block, sampleTime);
    /*
     * 词组间权重：只吃 cue 区间距离与唱速。段内中心在采样时刻上重算，
     * 用的全是**最终落点 + 开始唱时刻**（与入场运动解耦，见文件头）。
     */
    const weight = Math.exp(-0.5 * (distance / sigma) * (distance / sigma));
    const center = resolveSonnetCameraFocusBlockCenter(block, sampleTime);
    /* 水平长句：按 `horizontalBlend` 连续地把 x 从"块中心"融合到"显现前沿的屏幕锚定轴心"。 */
    const centerX =
      horizontalBlend > 0 ? center.x + (horizonAimX - center.x) * horizontalBlend : center.x;
    weightSum += weight;
    focusX += centerX * weight;
    focusY += center.y * weight;
    if (distance < activeDistance) {
      activeDistance = distance;
      activeIndex = index;
    }
  }
  if (!(weightSum > 0)) {
    /* 空档极长时所有高斯都下溢到 0：退回"最近的那一组"，绝不产生 NaN。 */
    const nearest = usable[activeIndex] ?? usable[0];
    if (nearest === undefined) return null;
    const center = resolveSonnetCameraFocusBlockCenter(nearest, sampleTime);
    focusX = horizontalBlend > 0 ? center.x + (horizonAimX - center.x) * horizontalBlend : center.x;
    focusY = center.y;
    weightSum = 1;
  }
  const x = focusX / weightSum;
  const y = focusY / weightSum;
  const halfX =
    (viewportWidth * positiveOr(options.comfortHalfXRatio, SONNET_CAMERA_FOCUS_COMFORT_HALF_X)) / screenScale;
  const halfY =
    (viewportHeight * positiveOr(options.comfortHalfYRatio, SONNET_CAMERA_FOCUS_COMFORT_HALF_Y)) / screenScale;
  const focus: Omit<SonnetCameraFocus, 'summary'> = {
    aimX: x,
    aimY: y,
    minX: x - halfX,
    minY: y - halfY,
    maxX: x + halfX,
    maxY: y + halfY,
    blockCount: usable.length,
    activeIndex,
    leadSeconds: lead,
    sigmaSeconds: sigma,
    speed,
    /* 没开水平长句模式时给第一个词组中心（退化读数，与旧口径同值）。 */
    frontRatio: horizontalBlend > 0 ? horizonX : (usable[0]?.centerX ?? 0),
    screenAnchored,
  };
  return { ...focus, summary: describeSonnetCameraFocus(focus) };
}

/** 比例入参的缺省值（非有限值一律当缺省）。 */
function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number | undefined, fallback: number): number {
  const resolved = finiteOr(value, fallback);
  return resolved > 0 ? resolved : fallback;
}

/**
 * **空焦点**（静默 / 这一帧一个可用词组都没有）：`blockCount = 0` ⇒ 帧层轴心退回静态轴心、
 * 取景层不做平移兜底。`aimX/aimY` 给画面中心，是为了让直接读这个对象的探针拿到一个中性盒。
 */
export function emptySonnetCameraFocus(centerX: number, centerY: number): SonnetCameraFocus {
  return {
    aimX: centerX,
    aimY: centerY,
    minX: centerX,
    minY: centerY,
    maxX: centerX,
    maxY: centerY,
    blockCount: 0,
    activeIndex: -1,
    leadSeconds: 0,
    sigmaSeconds: 0,
    speed: 0,
    /* 空焦点没有"显现前沿"：给中性中心，与 `aimX` 同值。 */
    frontRatio: centerX,
    screenAnchored: false,
    summary: 'focus=none',
  };
}

/** 焦点读数（dataset / 用例共用一份口径）。 */
export function describeSonnetCameraFocus(focus: Omit<SonnetCameraFocus, 'summary'>): string {
  return (
    `focus=${Math.round(focus.aimX)},${Math.round(focus.aimY)} blocks=${focus.blockCount} ` +
    `act=${focus.activeIndex} lead=${focus.leadSeconds.toFixed(2)} ` +
    `sigma=${focus.sigmaSeconds.toFixed(2)} speed=${focus.speed.toFixed(2)} ` +
    `box=${Math.round(focus.minX)},${Math.round(focus.minY)},` +
    `${Math.round(focus.maxX)},${Math.round(focus.maxY)}`
  );
}
