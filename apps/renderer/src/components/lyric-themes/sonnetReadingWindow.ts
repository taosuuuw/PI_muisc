/**
 * 商籁**阅读窗口**（纯函数）——「此刻镜头该看哪一块」的取景语义底座。
 *
 * === 为什么需要它（本轮纠正的目标）===
 * 上一轮的生产取景是"把**整镜所有正文**塞进安全区"：镜里歌词一长（多行、长句），
 * 唯一的办法就是把镜头拉远 ⇒ 一屏塞几句、字被缩成小字；而跟拍焦点只看当前字，
 * 于是"当前该读的那几个字"又被裁得只剩一两粒。
 *
 * 正确口径是**阅读窗口**：以 Frame 已有的 `runs`（词 / 短句，带真实逐字 cue 与落位点）为单位，
 * 取"**当前正在唱的块** + 前后各一个语义近邻块"作为有限上下文；旧行与远未来不进窗口，
 * 窗口**连续地**随时间滑动（不是硬切），所以镜头不会在换块那一帧跳。
 *
 * === 连续性怎么做到 ===
 * · 每个块按"它自己的唱词时段离 t 多远"给一个**连续**权重：指数衰减 × 平滑门
 *   （`distance ≥ timeRadius` 只留 `gateFloor` 的极小权重，所以远处块的影响连续趋零、不硬切）；
 * · 再按**空间距离**（相对时间质心，质心本身也是连续量）连续压低空间上远的块；
 * · 窗口四至取**加权平均**（连续），最后绕窗口中心做一次**软跨度上限**（连续收缩）；
 * · **尺寸另走一支更宽的软前 K**（`SONNET_READING_SIZE_GATE_*`）：成员读数仍是严格的 K 块，
 *   但决定**取景拉远**的窗口尺寸让远邻缓慢参与 / 退出 —— 否则邻块会在零点几秒内从"不参与"跳到
 *   "撑开窗口"，镜头被猛拉远（实测固定世界点速度尖峰 3915px/s，2.2×视口上限只有 3352）。
 * 整个过程只是 `t` 的函数：没有累加状态 ⇒ seek 到任意时刻、任意帧率都得到同一结果。
 *
 * === 它不负责什么 ===
 * 它不决定镜头的 `zoom / x / y`（那是 `sonnetCameraFraming.ts` 的活），也不做硬包含
 * —— 窗口外的块**允许越过画面边缘**（要求：当前词读得清，邻块出血没关系）。
 *
 * ⚠ **平移更不归它管**：早先这里还有一个"当前唱词几何锚点"（`exp(−时间距离/0.03)` 加权），
 * 配一条没有上限的硬纠偏把当前词盒塞进安全区 —— 那个衰变常数小到"只有正在唱的 30ms 说话"，
 * 于是窗口一换块镜头就急追（换块那一帧就是一步拉过去）。已删除：镜头该看哪里由
 * **连续预测焦点**（`sonnetCameraFocus.ts`）—— 对语义词组中心的真实 cue 区间做高斯加权融合，
 * 自带少量 lookahead 持续提前构图。这里只剩
 * "此刻该读的局部上下文有多大"这一个职责（缩放依据 + 读数）。
 *
 * ⚠ 口径声明：这里的"时间"是**唱词时间轴**（逐字 cue 的 start/end），**不是音频 BPM**。
 */

/** 阅读块：一个词 / 一个短句（帧层的 `run`），带**真实**唱词时段与落位四至（画布像素）。 */
export interface SonnetReadingBlock {
  readonly text: string;
  /** 这一块**第一个字开始唱**的绝对时刻（秒）。 */
  readonly startTime: number;
  /** 这一块**最后一个字唱完**的绝对时刻（秒）。 */
  readonly endTime: number;
  /** 来自哪一行（用来排除旧行：时间权重已经会压掉它，这里留着便于读数与用例）。 */
  readonly lineIndex: number;
  /** 是不是词形（标点 / 空白段不算词）。 */
  readonly isWordLike: boolean;
  /** 可见字素数（读数与"会不会只剩 1~2 字"的判据）。 */
  readonly charCount: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface SonnetReadingWindowOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** 时间半径（秒）：块的唱词时段离 `t` 超过它就只留 `gateFloorRatio` 的权重。 */
  readonly timeRadiusSeconds?: number;
  /** 时间权重衰减常数（秒）：间隔越远权重越小（指数）。 */
  readonly timeDecaySeconds?: number;
  /** 平滑门带宽（秒）：在 `[timeRadius − band, timeRadius]` 内从满权重连续降到地板值。 */
  readonly gateBandSeconds?: number;
  /** 门的地板比例（0~1）：保证权重总和恒大于 0（长空档里也不会没有参考）。 */
  readonly gateFloorRatio?: number;
  /** 成员判据：权重 ≥ 最大权重 × 这个比例才算"窗口成员"（只影响读数）。 */
  readonly memberWeightThreshold?: number;
  /** 上下文预算（软前 K，默认 3 = 当前块 + 左右各一块）。 */
  readonly contextBlockCount?: number;
  /** 软前 K 的压低参数（见常量）。 */
  readonly contextGateFloorRatio?: number;
  readonly contextGateSoftRatio?: number;
  /** **窗口尺寸**用的更宽软前 K 参数（见 `SONNET_READING_SIZE_GATE_*`；不影响成员读数）。 */
  readonly sizeGateFloorRatio?: number;
  readonly sizeGateSoftRatio?: number;
  /** 窗口外接尺寸上限（视口比例）——防止几个空间上分散的块把窗口撑爆。 */
  readonly maxSpanXRatio?: number;
  readonly maxSpanYRatio?: number;
  /** 空间权重半径（× min(视口宽, 高)）：离时间质心这么远的块被连续压低。 */
  readonly spatialRadiusRatio?: number;
  /** 空间压低后的权重地板比例（0~1）：远块不归零，只把影响压小。 */
  readonly spaceFloorRatio?: number;
}

export interface SonnetReadingWindow {
  /** 当前正在唱（或时间上最近）的块下标；没有可用块时 `-1`。 */
  readonly activeIndex: number;
  /** 窗口成员（按原时间顺序；权重 ≥ 阈值）。 */
  readonly memberIndices: readonly number[];
  /** 与 `memberIndices` 同序的权重。 */
  readonly weights: readonly number[];
  /** 成员数（块数）。 */
  readonly blockCount: number;
  /** 成员里的词形块数。 */
  readonly wordCount: number;
  /** 成员可见字数之和（"窗口里有多少字"）。 */
  readonly charCount: number;
  /** 成员覆盖的真实唱词时段（秒）。 */
  readonly startTime: number;
  readonly endTime: number;
  /** 加权窗口中心（画布像素）——取景平移按它算。 */
  readonly centerX: number;
  readonly centerY: number;
  /** 加权 + 软跨度限制后的窗口四至（画布像素）。 */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /**
   * **当前块（正在唱的词组）自己的落位四至**（画布像素）。
   * 渲染层可以把它当"焦点块"做读数 / 可读性验收（当前词有没有被裁到只剩一两字）。
   */
  readonly activeMinX: number;
  readonly activeMinY: number;
  readonly activeMaxX: number;
  readonly activeMaxY: number;
}

/** 时间半径（秒）：默认前后各 3 秒——比"当前词 + 左右邻块"略宽，再远的块被门压掉。 */
export const SONNET_READING_TIME_RADIUS = 3;
/** 平滑门带宽（秒）。 */
export const SONNET_READING_GATE_BAND = 0.8;
/** 时间权重衰减常数（秒）：相邻词间隔通常 0.4~1.5 秒 ⇒ 邻块拿到约 0.3~0.8 的权重，
 * 于是"当前词 + 邻块"真的会一起决定窗口尺寸，而不是只有当前词自己。 */
export const SONNET_READING_TIME_DECAY = 1.8;
/** 门的地板比例（保证权重和恒 > 0）。 */
export const SONNET_READING_GATE_FLOOR = 0.02;
/** 上下文预算（软前 K，默认 3 = 当前块 + 左右各一块）。 */
export const SONNET_READING_CONTEXT_BLOCKS = 3;
/** 软前 K 的压低参数：权重低于"第 K 大 × 地板比例"的块被 smoothstep 连续压到 0。
 * 取 0.9 / 0.1 = 只有和第 K 名同量级的块才留下（近似"只留 K 块"）：再陡一点窗口运动会变快，
 * 再缓一点密唱时会漏进四五块。**成员读数**用这一对（保持"窗口最多 K 块"）。 */
export const SONNET_READING_CONTEXT_GATE_FLOOR_RATIO = 0.9;
export const SONNET_READING_CONTEXT_GATE_SOFT_RATIO = 0.1;
/**
 * **窗口尺寸**单独用一对更宽的融合门（成员读数不变）。
 *
 * 原来尺寸与成员共用上面那对窄门：邻块要等到权重爬到 `0.9 × 第K名` 才突然开始撑窗口，
 * 于是窗口尺寸在 0.3~0.5 秒里从"只有当前块"冲到"当前块 + 两个远邻"——
 * 每秒上千像素的**拉远**速度（实测最终世界点速度尖峰 3915px/s，2.2×视口上限只有 3352）。
 * 这一对把同一个"软前 K"的过渡带放宽 7 倍：邻块从 `0.3 × 第K名` 就开始缓慢参与，
 * 尺寸变化被摊到整段融合时间里，**没有台阶、也没有突然的拉远冲量**。
 * 成员仍然是严格的 K 块（`charCount` / `blockCount` 读数逐值不变）。
 */
export const SONNET_READING_SIZE_GATE_FLOOR_RATIO = 0.3;
export const SONNET_READING_SIZE_GATE_SOFT_RATIO = 0.7;
/** 成员判据（相对最大权重）：0.1 左右表示"邻块要真的参与窗口"才列进读数。 */
export const SONNET_READING_MEMBER_WEIGHT = 0.1;
/** 窗口外接尺寸上限（视口比例）：一屏最多这么大，长句也只取局部。 */
export const SONNET_READING_MAX_SPAN_X = 0.92;
export const SONNET_READING_MAX_SPAN_Y = 0.8;
/** 空间权重半径（× 短边，默认 1.5）：参考点是"时间加权质心"（连续）。半径外权重归 0 ⇒
 * 空间上远的块（旧行 / 别的版块）完全拗不动镜头。 */
export const SONNET_READING_SPATIAL_RADIUS = 1.5;
/** 空间权重地板（0 = 半径外完全不参与；见 `spatialRadiusRatio`）。 */
export const SONNET_READING_SPACE_FLOOR = 0;

/** 没有可用块时的空窗口（帧层静默期与渲染层兜底都用它）。 */
export const SONNET_EMPTY_READING_WINDOW: SonnetReadingWindow = Object.freeze({
  activeIndex: -1,
  memberIndices: Object.freeze([]) as readonly number[],
  weights: Object.freeze([]) as readonly number[],
  blockCount: 0,
  wordCount: 0,
  charCount: 0,
  startTime: 0,
  endTime: 0,
  centerX: 0,
  centerY: 0,
  minX: 0,
  minY: 0,
  maxX: 0,
  maxY: 0,
  activeMinX: 0,
  activeMinY: 0,
  activeMaxX: 0,
  activeMaxY: 0,
});

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** `s²(3 − 2s)`：两端斜率为 0 的单调过渡（连续压权重用）。 */
function smoothstep01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number | undefined, fallback: number): number {
  const resolved = finiteOr(value, fallback);
  return resolved > 0 ? resolved : fallback;
}

/** 一个块能不能进窗口：有可见字、时间与四至都是有限值。 */
function isUsableReadingBlock(block: SonnetReadingBlock): boolean {
  return (
    block.charCount > 0 &&
    Number.isFinite(block.startTime) &&
    Number.isFinite(block.endTime) &&
    Number.isFinite(block.centerX) &&
    Number.isFinite(block.centerY) &&
    Number.isFinite(block.minX) &&
    Number.isFinite(block.minY) &&
    Number.isFinite(block.maxX) &&
    Number.isFinite(block.maxY)
  );
}

/** `t` 到"这个块的唱词时段"的距离：唱的时候是 0，之后/之前是间隔。 */
function timeDistanceToBlock(block: SonnetReadingBlock, time: number): number {
  const start = Math.min(block.startTime, block.endTime);
  const end = Math.max(block.startTime, block.endTime);
  if (time < start) return start - time;
  if (time > end) return time - end;
  return 0;
}

/**
 * 门函数（连续）：`distance ≤ timeRadius − band` ⇒ 1；`distance ≥ timeRadius` ⇒ 地板值；
 * 中间用 smoothstep 从 1 平滑降到地板 ✓（所以"排除远未来 / 旧行"不会产生权重台阶）。
 */
function resolveGate(distance: number, timeRadius: number, band: number, floor: number): number {
  if (distance >= timeRadius) return floor;
  const inner = timeRadius - band;
  if (band <= 0 || distance <= inner) return 1;
  return floor + (1 - floor) * (1 - smoothstep01((distance - inner) / band));
}

interface ReadingEntry {
  readonly index: number;
  readonly block: SonnetReadingBlock;
  /** 只按时间算的权重（空间权重与质心都建立在它上面）。 */
  readonly timeWeight: number;
  /** 最终权重（时间 × 空间）：**成员读数 / 中心**用它。 */
  weight: number;
  /** 只给**窗口尺寸**用的软权重（比 `weight` 更宽地融合邻块，见 `SONNET_READING_SIZE_GATE_*`）。 */
  sizeWeight: number;
}

/**
 * 此刻的**阅读窗口**。
 *
 * 步骤（每一步都只是 `t` 的连续函数）：
 * ① 时间权重：`gate(距离) × exp(−距离 / 衰减)`；
 * ② 空间权重：以"时间加权质心"为参考点，半径外归 0（空间上远的块拗不动窗口）；
 * ③ **上下文预算**：只让权重最高的 K 块（默认 3 = 当前 + 左右各一）说话，其余连续压到 0；
 * ④ 加权**中心** + "各块到中心的加权外扩" ⇒ 窗口四至；
 * ⑤ 绕中心做软跨度上限（一屏最多 `maxSpanX × 宽` / `maxSpanY × 高`）；
 * ⑥ 成员读数（权重 ≥ 最大权重 × 阈值的块）。
 */
export function resolveSonnetReadingWindow(
  blocks: readonly SonnetReadingBlock[],
  time: number,
  options: SonnetReadingWindowOptions,
): SonnetReadingWindow {
  const viewportWidth = Math.max(0, finiteOr(options.viewportWidth, 0));
  const viewportHeight = Math.max(0, finiteOr(options.viewportHeight, 0));
  const timeRadius = positiveOr(options.timeRadiusSeconds, SONNET_READING_TIME_RADIUS);
  const gateBand = Math.min(timeRadius, Math.max(0, finiteOr(options.gateBandSeconds, SONNET_READING_GATE_BAND)));
  const decay = positiveOr(options.timeDecaySeconds, SONNET_READING_TIME_DECAY);
  const gateFloor = clamp01(finiteOr(options.gateFloorRatio, SONNET_READING_GATE_FLOOR));
  const memberThreshold = positiveOr(options.memberWeightThreshold, SONNET_READING_MEMBER_WEIGHT);
  const contextBlocks = Math.max(1, Math.floor(positiveOr(options.contextBlockCount, SONNET_READING_CONTEXT_BLOCKS)));
  const contextGateFloor = clamp01(
    finiteOr(options.contextGateFloorRatio, SONNET_READING_CONTEXT_GATE_FLOOR_RATIO),
  );
  const contextGateSoft = positiveOr(
    options.contextGateSoftRatio,
    SONNET_READING_CONTEXT_GATE_SOFT_RATIO,
  );
  const sizeGateFloor = clamp01(
    finiteOr(options.sizeGateFloorRatio, SONNET_READING_SIZE_GATE_FLOOR_RATIO),
  );
  const sizeGateSoft = positiveOr(
    options.sizeGateSoftRatio,
    SONNET_READING_SIZE_GATE_SOFT_RATIO,
  );
  const maxSpanX = positiveOr(options.maxSpanXRatio, SONNET_READING_MAX_SPAN_X);
  const maxSpanY = positiveOr(options.maxSpanYRatio, SONNET_READING_MAX_SPAN_Y);
  const spatialRadius =
    Math.max(1, positiveOr(options.spatialRadiusRatio, SONNET_READING_SPATIAL_RADIUS)) *
    Math.min(viewportWidth > 0 ? viewportWidth : 1, viewportHeight > 0 ? viewportHeight : 1);
  const spaceFloor = clamp01(finiteOr(options.spaceFloorRatio, SONNET_READING_SPACE_FLOOR));
  const safeTime = Number.isFinite(time) ? time : 0;

  const entries: ReadingEntry[] = [];
  blocks.forEach((block, index) => {
    if (!isUsableReadingBlock(block)) return;
    const distance = timeDistanceToBlock(block, safeTime);
    const gate = resolveGate(distance, timeRadius, gateBand, gateFloor);
    entries.push({ index, block, timeWeight: gate * Math.exp(-distance / decay), weight: 0, sizeWeight: 0 });
  });
  if (entries.length === 0) return SONNET_EMPTY_READING_WINDOW;

  /* ① 时间权重 `gate(距离) × exp(−距离 / 衰减)` 在构造 `entries` 时已经算好（全部连续）。 */
  /*
   * ② **空间权重**：参考点取"时间加权质心"（当前词附近的连续中心）；
   * 离它超过 `spatialRadius`（默认 1 × 视口短边）的块权重归 0 —— 空间上远的块
   * **完全拗不动窗口**（旧行、别的版块），也就不会出现"AABB 一撑就极度拉远 / 拉偏"。
   * 参考点与权重都只是 `t` 的连续函数 ⇒ 不制造台阶。
   */
  let referenceX = 0;
  let referenceY = 0;
  let referenceWeight = 0;
  for (const entry of entries) {
    referenceX += entry.block.centerX * entry.timeWeight;
    referenceY += entry.block.centerY * entry.timeWeight;
    referenceWeight += entry.timeWeight;
  }
  if (referenceWeight > 0) {
    referenceX /= referenceWeight;
    referenceY /= referenceWeight;
  }
  for (const entry of entries) {
    const radial = Math.hypot(entry.block.centerX - referenceX, entry.block.centerY - referenceY);
    const spatial = smoothstep01(1 - radial / spatialRadius);
    entry.weight = entry.timeWeight * (spaceFloor + (1 - spaceFloor) * spatial);
  }
  /*
   * 兜底：万一**所有**块都在空间半径之外（整镜正文非常分散）⇒ 退回"只按时间加权"，
   * 仍然是连续量（这个判据与时间无关 ⇒ 不会时而触发时而不触发）。
   */
  let totalWeight = 0;
  for (const entry of entries) totalWeight += entry.weight;
  if (!(totalWeight > 0)) {
    for (const entry of entries) entry.weight = entry.timeWeight;
  }
  /* 尺寸权重先与成员权重同值；下面的双向软前 K 会把尺寸那一支单独放宽。 */
  for (const entry of entries) entry.sizeWeight = entry.weight;

  /*
   * ③ **上下文预算（软前 K，默认 3）**：只让权重最高的那几块说话。
   * 门槛 = 第 K 大的权重 —— 它本身是 `t` 的连续函数（连续函数的有序统计量仍连续）；
   * 比门槛低 `floorRatio` 倍的块用 smoothstep 连续压到 0，所以被挤出去的块**不会**制造窗口台阶。
   * 这一条同时解决两件事：密唱时不会把十几块都拉进窗口、稀疏时长音也至少留一块上下文。
   *
   * ⚠ **两支**：成员读数用窄门（严格 K 块），**窗口尺寸**用宽门（见 `SONNET_READING_SIZE_GATE_*`）。
   * 尺寸那一支让远邻**缓慢**参与/退出，消除"邻块一到位就把镜头猛拉远"的冲量；
   * 成员读数不受影响 ⇒ `blockCount / charCount` 仍是严格的 K 块口径。
   */
  if (entries.length > contextBlocks) {
    const sorted = entries.map((entry) => entry.weight).sort((first, second) => second - first);
    const cap = sorted[contextBlocks - 1] ?? 0;
    if (cap > 0) {
      const floor = cap * contextGateFloor;
      const span = Math.max(1e-9, cap * contextGateSoft);
      const sizeFloor = cap * sizeGateFloor;
      const sizeSpan = Math.max(1e-9, cap * sizeGateSoft);
      for (const entry of entries) {
        const raw = entry.weight;
        entry.weight = raw * smoothstep01((raw - floor) / span);
        entry.sizeWeight = raw * smoothstep01((raw - sizeFloor) / sizeSpan);
      }
    }
  }

  /* ④ 加权**中心**，再用"各块到中心的加权外扩"定窗口尺寸（连续，且邻块真的把窗口撑开）。 */
  let total = 0;
  let weightedCenterX = 0;
  let weightedCenterY = 0;
  let activeEntry = entries[0];
  if (activeEntry === undefined) return SONNET_EMPTY_READING_WINDOW;
  let activeDistance = timeDistanceToBlock(activeEntry.block, safeTime);
  let maxWeight = 0;
  for (const entry of entries) {
    const weight = entry.weight;
    total += weight;
    weightedCenterX += entry.block.centerX * weight;
    weightedCenterY += entry.block.centerY * weight;
    if (weight > maxWeight) maxWeight = weight;
    const distance = timeDistanceToBlock(entry.block, safeTime);
    /* 同距离取先出现的（与输入顺序也就是唱词顺序一致）⇒ 确定性 ✓ */
    if (distance < activeDistance - 1e-9) {
      activeEntry = entry;
      activeDistance = distance;
    }
  }
  if (!(total > 0)) {
    const block = activeEntry.block;
    return {
      activeIndex: activeEntry.index,
      memberIndices: [activeEntry.index],
      weights: [1],
      blockCount: 1,
      wordCount: block.isWordLike ? 1 : 0,
      charCount: block.charCount,
      startTime: Math.min(block.startTime, block.endTime),
      endTime: Math.max(block.startTime, block.endTime),
      centerX: block.centerX,
      centerY: block.centerY,
      minX: block.minX,
      minY: block.minY,
      maxX: block.maxX,
      maxY: block.maxY,
      activeMinX: block.minX,
      activeMinY: block.minY,
      activeMaxX: block.maxX,
      activeMaxY: block.maxY,
    };
  }
  const centerX = weightedCenterX / total;
  const centerY = weightedCenterY / total;
  /*
   * ⚠ 这里**不能**用"加权平均 min/max"：邻块在中心两侧时它会互相抵消、窗口反而不涨
   * （AABB 平均的经典坑）。改成"各块到加权中心的加权外扩"：
   * 邻块越重、越远，窗口越大；中心块自己的半宽也始终在内 ⇒ 当前词有尺寸兜底 ✓。
   *
   * ⚠ 尺寸用**宽门**的那一支 `sizeWeight`（见 `SONNET_READING_SIZE_GATE_*`）：远邻缓慢参与 /
   * 退出 ⇒ 窗口尺寸的**变化速度**被摊平，取景拉远不再有冲量；中心与成员读数仍用窄门 √。
   */
  let sizeTotal = 0;
  let halfWidth = 0;
  let halfHeight = 0;
  for (const entry of entries) {
    sizeTotal += entry.sizeWeight;
    const block = entry.block;
    halfWidth += Math.max(Math.abs(block.minX - centerX), Math.abs(block.maxX - centerX)) * entry.sizeWeight;
    halfHeight += Math.max(Math.abs(block.minY - centerY), Math.abs(block.maxY - centerY)) * entry.sizeWeight;
  }
  /* 退化保护：尺寸权重全 0 时退回成员权重（仍是连续量）。 */
  const sizeDenominator = sizeTotal > 0 ? sizeTotal : total;
  halfWidth /= sizeDenominator;
  halfHeight /= sizeDenominator;

  /* ⑤ 软跨度上限：绕窗口中心收缩（连续）⇒ 几个分散的块不会把窗口撑成整屏。 */
  const limitHalfWidth = Math.max(0, (maxSpanX * viewportWidth) / 2);
  const limitHalfHeight = Math.max(0, (maxSpanY * viewportHeight) / 2);
  let spanScale = 1;
  if (limitHalfWidth > 0 && halfWidth > limitHalfWidth) spanScale = Math.min(spanScale, limitHalfWidth / halfWidth);
  if (limitHalfHeight > 0 && halfHeight > limitHalfHeight) spanScale = Math.min(spanScale, limitHalfHeight / halfHeight);
  spanScale = clamp01(spanScale);
  const windowMinX = centerX - halfWidth * spanScale;
  const windowMaxX = centerX + halfWidth * spanScale;
  const windowMinY = centerY - halfHeight * spanScale;
  const windowMaxY = centerY + halfHeight * spanScale;

  /* ⑥ 成员读数（按原时间顺序）。 */
  const memberIndices: number[] = [];
  const weights: number[] = [];
  let charCount = 0;
  let wordCount = 0;
  let windowStart = Number.POSITIVE_INFINITY;
  let windowEnd = Number.NEGATIVE_INFINITY;
  const threshold = maxWeight * memberThreshold;
  for (const entry of entries) {
    if (maxWeight > 0 && entry.weight < threshold) continue;
    memberIndices.push(entry.index);
    weights.push(entry.weight);
    charCount += Math.max(0, Math.round(entry.block.charCount));
    if (entry.block.isWordLike) wordCount += 1;
    windowStart = Math.min(windowStart, Math.min(entry.block.startTime, entry.block.endTime));
    windowEnd = Math.max(windowEnd, Math.max(entry.block.startTime, entry.block.endTime));
  }
  return {
    activeIndex: activeEntry.index,
    memberIndices,
    weights,
    blockCount: memberIndices.length,
    wordCount,
    charCount,
    startTime: Number.isFinite(windowStart) ? windowStart : 0,
    endTime: Number.isFinite(windowEnd) ? windowEnd : 0,
    centerX,
    centerY,
    minX: windowMinX,
    minY: windowMinY,
    maxX: windowMaxX,
    maxY: windowMaxY,
    activeMinX: activeEntry.block.minX,
    activeMinY: activeEntry.block.minY,
    activeMaxX: activeEntry.block.maxX,
    activeMaxY: activeEntry.block.maxY,
  };
}

/** 调试读数（渲染层 dataset 与用例共用一份口径）：字数 / 词数 / 时间范围 / 四至 / 当前块。 */
export function describeSonnetReadingWindow(window: SonnetReadingWindow): string {
  return (
    `w=${window.wordCount} c=${window.charCount} n=${window.blockCount} ` +
    `t=${window.startTime.toFixed(2)}-${window.endTime.toFixed(2)} ` +
    `box=${Math.round(window.minX)},${Math.round(window.minY)},` +
    `${Math.round(window.maxX)},${Math.round(window.maxY)} act=${window.activeIndex} ` +
    `actbox=${Math.round(window.activeMinX)},${Math.round(window.activeMinY)},` +
    `${Math.round(window.activeMaxX)},${Math.round(window.activeMaxY)}`
  );
}
