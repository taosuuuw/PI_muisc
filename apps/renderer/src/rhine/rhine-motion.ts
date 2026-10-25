/**
 * 「莱茵风」的**纯运动学**：波浪、肩部轮廓、涟漪、呼吸、临界阻尼与惯性。
 *
 * 全是纯函数 / 纯数据类，不碰 DOM、不碰 Three.js —— 所以能直接单测
 * （`rhine-motion.test.ts`），也能脱离浏览器验证数值。
 *
 * 数值来源逐条标注：`SOURCE: RhineLabUI src/motion.ts:<行>`（MIT）与
 * `src/archive-drag.ts:<行>`。**公式照抄、实现自己写**；本文件里所有函数名
 * 都是我们自己起的，参数顺序与参考无关。
 */

/* ------------------------------------------------------------------ 缓动 */

/** 五次平滑（首尾一阶、二阶导都为 0）。SOURCE: `motion.ts:2-5`。 */
export function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (10 + x * (-15 + 6 * x));
}

/** 高斯钟形。SOURCE: `motion.ts:6`（`exp(-0.5 * (x / width)^2)`）。 */
export function bell(x: number, width: number): number {
  return Math.exp(-0.5 * (x / width) ** 2);
}

/* ------------------------------------------------------------------ 波浪 */

/**
 * **音乐版**的选中涟漪。SOURCE: `Rhine-Music-Demo src/motion.ts:57-63`
 * （`musicSelectionWave`）。
 *
 * 参考源码里的注释写得很清楚：音乐版近景的抬升是 0.9（比档案版高），
 * 所以不能叠档案那条"快而高"的波峰 —— 幅度降到 0.32、起势放慢到 0.46 秒、
 * 传播速度 5.5 行/秒。档案版（`selectionRippleWave`，幅度 0.8、8 行/秒）保留备用。
 *
 * @param distance 与选中行的行距
 * @param age      距这次选中过去多少秒
 */
export function musicSelectionWave(distance: number, age: number): number {
  if (age < 0 || age > 3.2) return 0;
  const front = distance - age * 5.5;
  return 0.32 * smooth(age / 0.46) * Math.exp(-age * 1.35) * Math.cos(front * 0.58) * bell(front, 3.4);
}

const introSmooth = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (10 + t * (-15 + 6 * t));
};

const introProgress = (frame: number, start: number, end: number): number =>
  introSmooth((frame - start) / (end - start));

/**
 * 开场那阵**沿行方向推进、再回传**的波浪。SOURCE: `Rhine-Music-Demo
 * src/music-intro-motion.ts:68-89`（`packets` + `musicIntroWave`）。
 *
 * 参考的注释说得很清楚：不是一堆各自补间的盒子，而是一张连续曲面 ——
 * 一个宽的波峰带一条较浅的尾谷，先向前推，再反向回传。
 *
 * @param relativeRow  与选中行的行距
 * @param relativeLane 与选中列的列距（列与列之间延迟 4 个采样 = 0.16 秒）
 * @param shot         开场经过的秒数（与相机的编排共用一个时钟）
 */
export function musicIntroWave(relativeRow: number, relativeLane: number, shot: number): number {
  const frame = 1 + shot * 25 + relativeLane * 4;
  const forwardRow = (frame - 24) * 1.2;
  const forwardGain = introProgress(frame, 10, 19) * (1 - introProgress(frame, 29, 43));
  const returnRow = 31 + (0 - 31) * introProgress(frame, 44, 84);
  const returnGain = 0.76 * introProgress(frame, 43, 53) * (1 - introProgress(frame, 69, 89));
  const forward = 2.2 * bell(relativeRow - forwardRow, 5) - 0.3 * bell(relativeRow - forwardRow + 7, 4.4);
  const returning = 2.2 * bell(relativeRow - returnRow, 5) - 0.3 * bell(relativeRow - returnRow - 7, 4.4);
  return forward * forwardGain + returning * returnGain;
}

/**
 * 选中时从选中行向外扩散的**行波**（带正负波谷）。
 *
 * SOURCE: `motion.ts:45-54`（`baselineSelectionWave`）—— 用户对比后选定的「原始基线」：
 * 幅度 0.8、0.2s 起势、衰减 1.15/s、空间频率 0.58、传播 8 行/秒、包络宽 3.4。
 * 参考里选项还有「只保留正向波峰」的版本（`selectionWave`），但生产用的是这个带负谷的。
 *
 * @param distance 与选中行的行距（可以是负的：选中行的前后都起波）
 * @param age      距离这一下选中过去了多少秒
 */
export function selectionRippleWave(distance: number, age: number): number {
  if (age < 0 || age > 3.2) return 0;
  const front = distance - age * 8;
  return 0.8 * smooth(age / 0.2) * Math.exp(-age * 1.15) * Math.cos(front * 0.58) * bell(front, 3.4);
}

/**
 * 源点不动、涟漪向外展开的包络（参考里的「先抬起再波动」实验用的那一支）。
 * SOURCE: `motion.ts:63-67`。保留它是因为它能查出「涟漪把选中行自己又抬起来」的毛病
 * （单测里钉住了 `rippleEnvelope(0, age) === 0`）。
 */
export function rippleEnvelope(distance: number, age: number): number {
  return smooth(distance / 2.5) * Math.max(0, Math.cos((distance - age * 8) * 0.58));
}

/** 肩部轮廓：选中行周围按「延迟随距离增长」的同一个波形起落。
 *  SOURCE: `motion.ts:35-44`。
 *  - 包络 `max(-0.42, 2.15 - 0.17 * (sqrt(d²+1) - 1))`
 *  - 每行延迟 0.065s、起势 0.62s、叠加 5.1 rad/s 的衰减振铃（0.18 权重、0.16s 起势）
 *
 *  @param distance 与选中行的行距
 *  @param elapsed  整个轮廓从触发到现在过了多少秒
 */
export function settlingWave(distance: number, elapsed: number): number {
  const age = elapsed - Math.abs(distance) * 0.065;
  const envelope = Math.max(-0.42, 2.15 - 0.17 * (Math.sqrt(distance * distance + 1) - 1));
  const rise = smooth(age / 0.62);
  const ring = age > 0 ? Math.sin(age * 5.1) * Math.exp(-age * 1.3) : 0;
  return envelope * (rise + 0.18 * ring * smooth(age / 0.16));
}

/**
 * 开场那一串「传播 / 回传」的行波（参考片子的时间轴波形）。
 *
 * SOURCE: `motion.ts:7-26`。参考里的时间 `t` 是从片子 22 秒起算的，我们把它改成
 * **从莱茵层打开起算**：`elapsed` ∈ [0, 4.35) 秒，超出整段为 0（作者写明了两个包络在区间外严格为零）。
 */
export function archiveWave(row: number, lane: number, elapsed: number): number {
  const t = elapsed;
  if (t <= 0 || t >= 4.35) return 0;
  const phase = row + (lane - LANE_PHASE) * 0.65;
  const enter = smooth(t / 0.32);
  const first = 3 + t * 19;
  const returning = 32 - (t - 2.3) * 24;
  // 一个波峰带肩部与尾谷：相邻盒子描述的是一张连续曲面，而不是各自错峰的补间。
  const packet = (distance: number): number => 2.5 * bell(distance, 3.8) - 0.58 * bell(distance - 6, 3.5);
  return (
    enter *
    (packet(phase - first) * (1 - smooth((t - 2.15) / 0.65)) +
      packet(phase - returning) * smooth((t - 2.17) / 0.32) * (1 - smooth((t - 3.5) / 0.85)))
  );
}

/** 行波相位里的列权重。SOURCE: `motion.ts:11`（`(lane - 2) * 0.65`）。 */
const LANE_PHASE = 0.65;

/** 选中列周围的「列强度」：选中的列 1.0、邻列按钟形衰减到 0.25。
 *  SOURCE: `motion.ts:69-72`。 */
export function columnStrength(lane: number, focus: number, progress = 1): number {
  const selected = 0.25 + 0.75 * bell(lane - focus, 0.55);
  return 1 + (selected - 1) * smooth(progress);
}

/** 静置呼吸：两个不同周期的正弦叠加，相邻盒子轻微错相。最大单向位移 0.102。
 *  SOURCE: `motion.ts:76-81`。 */
export function idleWave(row: number, lane: number, time: number): number {
  return (
    0.075 * Math.sin((time * Math.PI * 2) / 8 + row * 0.3 - lane * 0.45) +
    0.027 * Math.sin((time * Math.PI * 2) / 13 - row * 0.17 + lane * 0.3)
  );
}

/* ------------------------------------------------------------------ 弹簧 */

/** 转正判定：小于这个角度就算对齐了（SOURCE: `motion.ts:102`）。 */
export const ALIGNMENT_EPSILON = 0.001;

/**
 * **归位副本的转正**：先把朝向转回槽位方向，转正之前不下沉。
 *
 * SOURCE: `RhineLabUI src/motion.ts:101-109` —— 参考那边的原注释是
 * 「Hold altitude while facing back into the slot. Descent begins only once alignment is
 * complete; this also applies to independently returning copies.」
 * 也就是说：被换下来的那张先在原高度转正，转正之后才开始往下沉，换回来时也从当前状态接续。
 */
export function returnStep(angle: number, dt: number, reduced = false): number {
  const next = angle * Math.exp(-dt * (reduced ? 35 : 7));
  return Math.abs(next) <= ALIGNMENT_EPSILON ? 0 : next;
}

export interface Spring {
  value: number;
  velocity: number;
}

/**
 * 临界阻尼弹簧（隐式积分，步长再大也不会发散）。SOURCE: `motion.ts:112-118`。
 *
 * @param rate 速率：越大越跟手（4.2 = 升降、3.7 = 轨道、35 = 「瞬间到位」）
 */
export function damp(spring: Spring, target: number, rate: number, dt: number): void {
  const delta = spring.value - target;
  const impulse = spring.velocity + rate * delta;
  const decay = Math.exp(-rate * dt);
  spring.value = target + (delta + impulse * dt) * decay;
  spring.velocity = (spring.velocity - rate * impulse * dt) * decay;
}

/** 一个自由度的惯性滚动：先滑行、再吸附到最近一格。
 *  SOURCE: `RhineLabUI src/archive-drag.ts:96-136`（摩擦 2.4、吸附速率 10、
 *  速度 < 0.75 格/秒进吸附、速度 < 0.6 结算目标）。 */
export class RhineMomentum {
  value: number;
  velocity: number;
  phase: 'coasting' | 'snapping' | 'idle';
  target: number;
  private readonly friction = 2.4;

  constructor(value: number, velocity: number) {
    this.value = value;
    this.velocity = velocity;
    this.phase = Math.abs(velocity) >= 0.75 ? 'coasting' : 'snapping';
    this.target = Math.round(value);
  }

  step(dt: number, coasting = this.phase === 'coasting'): void {
    if (coasting) {
      const decay = Math.exp(-this.friction * dt);
      this.value += (this.velocity * (1 - decay)) / this.friction;
      this.velocity *= decay;
      if (Math.abs(this.velocity) < 0.6) {
        this.target = Math.round(this.value + this.velocity / this.friction);
        this.phase = 'snapping';
      }
      return;
    }
    if (this.phase !== 'snapping') return;
    const rate = 10;
    damp(this, this.target, rate, dt);
    if (Math.abs(this.value - this.target) < 0.0001 && Math.abs(this.velocity) < 0.005) {
      this.value = this.target;
      this.velocity = 0;
      this.phase = 'idle';
    }
  }
}

export interface RhinePlanePosition {
  lane: number;
  row: number;
}

/** 平面惯性：两个分量一起滑行、一起吸附（保住松手时的方向）。
 *  SOURCE: `archive-drag.ts:139-164`。 */
export class RhinePlaneMomentum {
  readonly lane: RhineMomentum;
  readonly row: RhineMomentum;

  constructor(value: RhinePlanePosition, velocity: RhinePlanePosition) {
    this.lane = new RhineMomentum(value.lane, velocity.lane);
    this.row = new RhineMomentum(value.row, velocity.row);
  }

  get phase(): 'coasting' | 'snapping' | 'idle' {
    if (this.lane.phase === 'coasting' || this.row.phase === 'coasting') return 'coasting';
    return this.lane.phase === 'idle' && this.row.phase === 'idle' ? 'idle' : 'snapping';
  }

  get value(): RhinePlanePosition {
    return { lane: this.lane.value, row: this.row.value };
  }

  get velocity(): RhinePlanePosition {
    return { lane: this.lane.velocity, row: this.row.velocity };
  }

  step(dt: number): void {
    const coasting = this.phase === 'coasting';
    this.lane.step(dt, coasting);
    this.row.step(dt, coasting);
  }
}

/* ------------------------------------------------------------------ 取景 */

export interface RhineFraming {
  /** 垂直取景范围（世界单位）。 */
  span: number;
  portrait: boolean;
  /** 竖屏时预览构图的纵向落点。 */
  previewY: number;
  /** 拉近之后盒子在屏幕上的落点（比例）。 */
  detailX: number;
  detailY: number;
}

/**
 * 取景范围随窗口比例与详情进度变化。
 * SOURCE: `RhineLabUI src/viewport-layout.ts:22-37`（`archiveFraming`）—— 16:9 为基准，
 * 更宽就按比例放大整段范围（保持纵向构图），竖屏另有一套补偿与落点。
 *
 * @param width   画布宽（CSS px）
 * @param height  画布高（CSS px）
 * @param span    基准垂直取景（预览 7.33 → 详情 5.9）
 * @param detail  详情进度 0~1
 * @param compact 紧凑窗口（我们的窗口最小 960×620，用不上，保留参数与参考同形）
 */
export function archiveFraming(
  width: number,
  height: number,
  span: number,
  detail: number,
  compact: boolean,
): RhineFraming {
  const aspect = width / Math.max(1, height);
  const portrait = aspect < 1.05;
  const baseSpan = span + (5.9 - span) * detail;
  const portraitDetailSpan = Math.max(6.3 / aspect, (3.7 * height) / Math.max(100, 0.54 * height - 156));
  const viewSpan = portrait
    ? Math.max(baseSpan, 8.4 / aspect + (portraitDetailSpan - 8.4 / aspect) * detail)
    : Math.max(baseSpan, (baseSpan * (16 / 9)) / aspect);
  return {
    span: viewSpan,
    portrait,
    previewY: portrait ? 0.36 : 0.5,
    detailX: portrait ? 0.5 : compact ? 0.27 : 550 / 1920,
    /*
     * 详情档的落点（2026-10-22 按截图校）：原来 `560/1080 ≈ 0.52`，实测在 1182×772 的视口里
     * 卡片落到 `y = 613`（0.79），压在画面下缘、左边空一大片。改成 `380/1080 ≈ 0.35`，
     * 让那张盒子回到画面中偏左的位置（与参考的构图一致）。
     */
    detailY: portrait ? 0.27 + 34 / height : compact ? 0.49 : 380 / 1080,
  };
}
