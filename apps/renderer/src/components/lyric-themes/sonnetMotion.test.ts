/**
 * 商籁运动/缓动底座的**数值自查**。
 *
 * 这里守的是上游 `sonnetMotion.ts` 的数值（见 `docs/PLAN.md` 第 91 轮与第 350~352 轮）：
 * 贝塞尔控制点、`expoOut` / `elasticOut` 的形状、强度档映射、
 * 段入场的 0.08 秒下限、装饰深度区间、陪衬法向幅度、呼吸上限与震颤幅度，
 * **以及镜头路径与运镜**（`resolveShotPathProgress` / `resolveShotMotionFrame`）。
 *
 * ⚠ **第 352 轮更正**：这里原先写着"**不守**上游中段那两个函数——那部分我们**没有**"——**那是错的** ✗。
 * 本地快照 `.folia-ref/sonnet__sonnetMotion.ts:180~244` 里就有它们，我们**后来照抄实现**
 * （`sonnetMotion.ts:127/151`）并**已经加了用例**（本文件：`editorial-column` 的 `0 → 0.22 → 0.78 → 1`、
 * `tracking-ribbon` 的 `x: −0.16 → 0.12`、`poster-blocks(1).x ≈ 0.012`、`mask-reveal` 的 `0.1 → −0.035` 等）✓。
 * 保留这条更正，是为了不再有人按旧注释去"补一个其实已经有的东西"。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_CAMERA_BREATH_MAX_OFFSET,
  SONNET_CAMERA_BREATH_MAX_ROTATION,
  SONNET_CAMERA_BREATH_MAX_SCALE,
  SONNET_FOCUS_BLEND_SOFT_RATIO,
  SONNET_IDLE_RHYTHM_PROFILE,
  SONNET_RHYTHM_TRACKING_FAST,
  SONNET_RHYTHM_TRACKING_SLOW,
  clamp01,
  describeSonnetRhythmProfile,
  easeSonnetElasticOut,
  easeSonnetEnter,
  easeSonnetExpoOut,
  easeSonnetInOut,
  resolveCubicBezier,
  resolveSegmentProgress,
  resolveShotMotionFrame,
  resolveShotPathProgress,
  resolveSonnetAnimationScale,
  resolveSonnetBreath,
  resolveSonnetBreathWeight,
  resolveSonnetCueDensity,
  resolveSonnetCueDurationScale,
  resolveSonnetCueGapDistance,
  resolveSonnetFocusBlendWeight,
  resolveSonnetFocusWeights,
  resolveSonnetRhythmProfile,
  resolveSonnetSegmentDepth,
  resolveSonnetSegmentNormalOffset,
  resolveSonnetSmoothedCameraFocus,
  resolveTimelineShake,
} from './sonnetMotion';

describe('商籁运动/缓动（照抄的数值）', () => {
  it('贝塞尔：两端点精确、单调不减（12 次二分解 x 再采样 y）', () => {
    expect(resolveCubicBezier(0.65, 0, 0.35, 1, 0)).toBe(0);
    expect(resolveCubicBezier(0.65, 0, 0.35, 1, 1)).toBe(1);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(7)).toBe(1);
    let previous = -1;
    for (let step = 0; step <= 20; step += 1) {
      const value = easeSonnetInOut(step / 20);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    // 对称控制点 ⇒ 中点在 0.5 附近（不是"过冲"的曲线）。
    expect(easeSonnetInOut(0.5)).toBeCloseTo(0.5, 1);
    // 入场曲线在起点就很快（`0.22, 1` 是"猛起"），所以中途值明显大于线性。
    expect(easeSonnetEnter(0.25)).toBeGreaterThan(0.5);
  });

  it('expoOut / elasticOut 的形状与端点', () => {
    expect(easeSonnetExpoOut(0)).toBe(0);
    expect(easeSonnetExpoOut(1)).toBe(1);
    expect(easeSonnetExpoOut(0.1)).toBeGreaterThan(0.4);
    /*
     * 弹性收尾**不是**精确落在 1：公式是 `2^(−10t)·sin(…)+1`，t=1 时正弦项不为 0，
     * 所以尾巴会在 1 附近**微过冲**（实测 ≈ 1.00049）。这是上游公式本来的行为，照它写。
     */
    expect(Math.abs(easeSonnetElasticOut(1) - 1)).toBeLessThan(0.01);
  });

  it('动画强度档：calm 0.65 / chaotic 1.35 / 其余 1', () => {
    expect(resolveSonnetAnimationScale('calm')).toBeCloseTo(0.65, 6);
    expect(resolveSonnetAnimationScale('chaotic')).toBeCloseTo(1.35, 6);
    expect(resolveSonnetAnimationScale('normal')).toBe(1);
    expect(resolveSonnetAnimationScale('')).toBe(1);
  });

  it('段入场：0.08 秒下限（极短的段在段尾也走不满）', () => {
    // 段长 0.02 秒、时间只走了 0.008 秒 ⇒ 按 0.08 秒算 = 十分之一。
    const value = resolveSegmentProgress(10, 10.02, 10.008);
    expect(value).toBeCloseTo(easeSonnetExpoOut(0.1), 6);
    /*
     * **注意这条的含义**：短段（< 0.08 秒）走**到自己的段尾时也到不了 1**
     * （0.02/0.08 = 0.25 ⇒ `expoOut(0.25)` ≈ 0.823），入场会延续到段结束之后。
     * 这是上游 `max(…, 0.08)` 的**直接后果**，不是我们的偏差 —— 照它写死。
     */
    expect(resolveSegmentProgress(10, 10.02, 10.02)).toBeCloseTo(easeSonnetExpoOut(0.25), 6);
    expect(resolveSegmentProgress(10, 10.02, 10.02)).toBeLessThan(1);
    // 段长足够（≥ 0.08 秒）时，段尾就是 1。
    expect(resolveSegmentProgress(10, 11, 11)).toBeCloseTo(1, 6);
  });

  it('装饰段深度只在 decoration 上有，区间 ±(0.5 ~ 1.3)', () => {
    expect(resolveSonnetSegmentDepth('hero', () => 0.9)).toBe(0);
    expect(resolveSonnetSegmentDepth('support', () => 0.9)).toBe(0);
    // 先给 0.9（> 0.5 ⇒ 走正侧），再给 0.5 ⇒ 0.5 + 0.5×0.8 = 0.9。
    const queue = [0.9, 0.5];
    const random = (): number => queue.shift() ?? 0.5;
    expect(resolveSonnetSegmentDepth('decoration', random)).toBeCloseTo(0.9, 6);
    const negative = [0.1, 1];
    const randomNegative = (): number => negative.shift() ?? 0;
    expect(resolveSonnetSegmentDepth('decoration', randomNegative)).toBeCloseTo(-1.3, 6);
  });

  it('陪衬法向偏移：只有 support 有，幅度 = 字号 × 0.3，方向取法线', () => {
    expect(resolveSonnetSegmentNormalOffset('hero', 'horizontal', 0, 60, 1)).toEqual({ x: 0, y: 0 });
    // 横排：法线角 = 0 + π/2 ⇒ 偏移落在 y 轴上，距离 = (1×2−1)×60×0.3 = 18。
    const horizontal = resolveSonnetSegmentNormalOffset('support', 'horizontal', 0, 60, 1);
    expect(horizontal.x).toBeCloseTo(0, 6);
    expect(horizontal.y).toBeCloseTo(18, 6);
    // 竖排：法线角 = 旋转角本身。
    const vertical = resolveSonnetSegmentNormalOffset('support', 'vertical', 0, 60, 1);
    expect(vertical.x).toBeCloseTo(18, 6);
    expect(vertical.y).toBeCloseTo(0, 6);
    // randomValue = 0 ⇒ 距离为负的一半。
    expect(resolveSonnetSegmentNormalOffset('support', 'vertical', 0, 60, 0).x).toBeCloseTo(-18, 6);
  });

  it('手持呼吸：四项都在各自上限之内；权重在入场完成后 1.2 秒渐入', () => {
    let maxOffset = 0;
    let maxScale = 0;
    let maxRotation = 0;
    for (let step = 0; step <= 200; step += 1) {
      const breath = resolveSonnetBreath(step * 0.37, step * 0.11);
      maxOffset = Math.max(maxOffset, Math.abs(breath.x), Math.abs(breath.y));
      maxScale = Math.max(maxScale, Math.abs(breath.scale));
      maxRotation = Math.max(maxRotation, Math.abs(breath.rotation));
    }
    expect(maxOffset).toBeLessThanOrEqual(SONNET_CAMERA_BREATH_MAX_OFFSET + 1e-9);
    expect(maxScale).toBeLessThanOrEqual(SONNET_CAMERA_BREATH_MAX_SCALE + 1e-9);
    expect(maxRotation).toBeLessThanOrEqual(SONNET_CAMERA_BREATH_MAX_ROTATION + 1e-9);
    // 起点若已经过了入场完成时刻，还要等 1.2 秒才满。
    expect(resolveSonnetBreathWeight(5, 5)).toBe(0);
    expect(resolveSonnetBreathWeight(5.6, 5)).toBeGreaterThan(0);
    expect(resolveSonnetBreathWeight(5.6, 5)).toBeLessThan(1);
    expect(resolveSonnetBreathWeight(6.2, 5)).toBeCloseTo(1, 6);
    expect(resolveSonnetBreathWeight(4.9, 5)).toBe(0);
  });

  it('运镜：路径进度分段正确；七种镜头的起止值照抄上游', () => {
    // 三段式：0.18 处到 0.22、0.78 处到 0.78，两端为 0 / 1。
    expect(resolveShotPathProgress('editorial-column', 0)).toBeCloseTo(0, 6);
    expect(resolveShotPathProgress('editorial-column', 0.18)).toBeCloseTo(0.22, 4);
    expect(resolveShotPathProgress('editorial-column', 0.78)).toBeCloseTo(0.78, 6);
    expect(resolveShotPathProgress('editorial-column', 1)).toBeCloseTo(1, 6);
    // "匀速混缓动"那四种在中点仍约等于 0.5（这就是"中段不停住"的意思）。
    expect(resolveShotPathProgress('tracking-ribbon', 0.5)).toBeCloseTo(0.5, 2);
    // 丝带横移幅度最大、海报方块几乎不动（两端值照抄）。
    expect(resolveShotMotionFrame('tracking-ribbon', 0).x).toBeCloseTo(-0.16, 6);
    expect(resolveShotMotionFrame('tracking-ribbon', 1).x).toBeCloseTo(0.12, 6);
    expect(resolveShotMotionFrame('poster-blocks', 1).x).toBeCloseTo(0.012, 6);
    // 片段环的 y 用 sin(eπ) 起伏 ⇒ 中段往下沉。
    expect(resolveShotMotionFrame('fragment-collage', 0.5).y).toBeLessThan(0.028);
    // 遮片镜头的 y 从 0.1 落到 −0.035（这是它"从上盖下来"的来源）。
    expect(resolveShotMotionFrame('mask-reveal', 0).y).toBeCloseTo(0.1, 6);
    expect(resolveShotMotionFrame('mask-reveal', 1).y).toBeCloseTo(-0.035, 6);
  });

  it('保边平滑：近处的样本被平均，远处的样本被**丢弃**（保住构图跳变）', () => {
    // 五个采样点都在同一处 ⇒ 平滑结果就是那一点。
    const flat = resolveSonnetSmoothedCameraFocus(10, 0, 20, () => ({ x: 5, y: 7 }), 0.12, 96);
    expect(flat.x).toBeCloseTo(5, 6);
    expect(flat.y).toBeCloseTo(7, 6);
    /*
     * 远处样本（距离 > 96）必须被丢弃：这里让"当前时刻"落在一个远点上，
     * 而 ±0.5/±1 倍的邻居落在 1000 之外 ⇒ 结果应当**只由中心点决定**。
     */
    const edge = resolveSonnetSmoothedCameraFocus(
      10,
      0,
      20,
      (sampleTime) => (sampleTime === 10 ? { x: 3, y: 4 } : { x: 5000, y: 5000 }),
      0.12,
      96,
    );
    expect(edge.x).toBeCloseTo(3, 6);
    expect(edge.y).toBeCloseTo(4, 6);
    // 窗口为 0 或区间退化时直接取当前时刻的样本。
    expect(resolveSonnetSmoothedCameraFocus(10, 0, 20, () => ({ x: 1, y: 2 }), 0).x).toBeCloseTo(1, 6);
    expect(resolveSonnetSmoothedCameraFocus(10, 5, 5, () => ({ x: 9, y: 9 }), 0.12).x).toBeCloseTo(9, 6);
  });

  it('保边改为**连续衰减**：焦点快速移动跨过 96px 门槛不再"整块权重消失"', () => {
    /*
     * 线性匀速的 focus（x = 3000 t，3000px/s）：这一镜从 t = 0 开始，窗口 0.12s 里
     * ±0.5 / ±1 的邻居样本在 t < 0.12 时会被**夹到镜首**（同一时刻 ⇒ 同一点），
     * 于是"中心 ↔ 邻居"的距离从 0 匀速长到 0.12×3000 = 360px，在 t ≈ 0.032s **跨过 96px 门槛**。
     * 旧版在跨门槛那一刻把这两个邻居整块丢掉（权重 4 与 1）⇒ 位置读数直接跳 ~44px；
     * 连续衰减后单步位移随采样步长线性收缩 ✓
     */
    const focus = (sampleTime: number): { x: number; y: number } => ({
      x: 3000 * sampleTime,
      y: 0,
    });
    /** 一趟扫描里"相邻两帧位移 / 帧长"能取到的最大单步位移 ✓ */
    const maxStep = (dt: number): number => {
      let previous = resolveSonnetSmoothedCameraFocus(0, 0, 2, focus, 0.12, 96).x;
      let worst = 0;
      for (let step = 1; step * dt <= 2 + 1e-9; step += 1) {
        const value = resolveSonnetSmoothedCameraFocus(step * dt, 0, 2, focus, 0.12, 96).x;
        worst = Math.max(worst, Math.abs(value - previous));
        previous = value;
      }
      return worst;
    };
    const coarse = maxStep(1 / 60);
    const fine = maxStep(1 / 600);
    /*
     * 连续 ⇒ 最大单步 ∝ dt：加密 10 倍后应明显变小。
     * 硬剔除会停在"权重跳变"的常数台阶上（单步不随 dt 收缩）⇒ 这条会红 ✓
     */
    expect(fine).toBeLessThan(coarse * 0.5);
    /* 中心样本**永远满权重**；远样本（> 96px）完全不混入 ⇒ 结果只由中心点决定 ✓ */
    const isolated = resolveSonnetSmoothedCameraFocus(
      1,
      0,
      2,
      (sampleTime) => (sampleTime === 1 ? { x: 7, y: 9 } : { x: 700, y: 900 }),
      0.12,
      96,
    );
    expect(isolated.x).toBeCloseTo(7, 6);
    expect(isolated.y).toBeCloseTo(9, 6);
    /* 权重函数本身：软带内连续、两端分别接上 1 与 0 ✓ */
    expect(resolveSonnetFocusBlendWeight(0, 96)).toBe(1);
    expect(resolveSonnetFocusBlendWeight(96 * (1 - SONNET_FOCUS_BLEND_SOFT_RATIO), 96)).toBeCloseTo(1, 9);
    expect(resolveSonnetFocusBlendWeight(96, 96)).toBe(0);
    expect(resolveSonnetFocusBlendWeight(1000, 96)).toBe(0);
    const insideSoftBand = resolveSonnetFocusBlendWeight(96 * 0.75, 96);
    expect(insideSoftBand).toBeGreaterThan(0);
    expect(insideSoftBand).toBeLessThan(1);
  });

  it('聚焦权重：时段内为最大、彼此之间归一，离得越远越小', () => {
    const ranges = [
      { startTime: 0, endTime: 1 },
      { startTime: 3, endTime: 4 },
    ];
    expect(resolveSonnetFocusWeights([], 1)).toEqual([]);
    // t=0.5 落在第一段内 ⇒ 第一段权重明显更大，且两者之和为 1。
    const near = resolveSonnetFocusWeights(ranges, 0.5);
    expect(near[0]).toBeGreaterThan(near[1] as number);
    expect((near[0] as number) + (near[1] as number)).toBeCloseTo(1, 6);
    // t=3.5 落在第二段内 ⇒ 反过来。
    const far = resolveSonnetFocusWeights(ranges, 3.5);
    expect(far[1]).toBeGreaterThan(far[0] as number);
    // 两个时段正中间（等价于距离差为 0 的情形）应当接近各半。
    const middle = resolveSonnetFocusWeights(ranges, 2);
    expect(middle[0]).toBeCloseTo(0.5, 3);
  });

  it('时间轴震颤：强度为 0 时纹丝不动；有强度时幅度在上限内', () => {
    expect(resolveTimelineShake(1.23, 0)).toEqual({ x: 0, y: 0, rotation: 0 });
    let maxOffset = 0;
    for (let step = 0; step <= 200; step += 1) {
      const shake = resolveTimelineShake(step * 0.013, 1);
      maxOffset = Math.max(maxOffset, Math.abs(shake.x), Math.abs(shake.y));
      expect(Math.abs(shake.rotation)).toBeLessThanOrEqual(0.005 + 1e-9);
    }
    expect(maxOffset).toBeLessThanOrEqual(0.02 + 1e-9);
  });
});

/**
 * **唱词时间轴节奏**（本轮新增的那一层）。
 *
 * 口径：全部由真实逐字 cue 的 start/end 推出（**不是音频 BPM**）；三个输入量
 * （密度 / 局部平均时长 / 空档距离）都必须是 `t` 的**连续**函数 ——
 * 否则跟拍强度会每个字抖一次（早先"当前字播放进度"就是这种锯齿）。
 */
describe('商籁唱词时间轴节奏', () => {
  /** 等距 cue：每 `spacing` 秒一粒、每粒唱 `duration` 秒。 */
  const cues = (count: number, spacing: number, duration: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      startTime: index * spacing,
      endTime: index * spacing + duration,
    }));

  it('局部密度 ≈ 1 / 间隔（三角核的离散化误差在几个百分点内）；窗外 cue 不计入', () => {
    const dense = resolveSonnetCueDensity(cues(20, 0.25, 0.2), 2.5, 3);
    expect(dense).toBeGreaterThan(3.7);
    expect(dense).toBeLessThan(4.1);
    const sparse = resolveSonnetCueDensity(cues(20, 2, 1.5), 20, 3);
    expect(sparse).toBeGreaterThan(0.45);
    expect(sparse).toBeLessThan(0.6);
    /* 远在窗外（> span 秒）的 cue 权重为 0 ⇒ 密度只看局部 */
    expect(resolveSonnetCueDensity([{ startTime: 100, endTime: 100.5 }], 0, 1)).toBe(0);
    expect(resolveSonnetCueDensity([], 1)).toBe(0);
  });

  it('局部平均时长：长音 → 接近 1 秒以上；密唱 → 接近字间隔', () => {
    expect(resolveSonnetCueDurationScale(cues(10, 1.4, 1.2), 6, 3)).toBeCloseTo(1.2, 2);
    expect(resolveSonnetCueDurationScale(cues(20, 0.25, 0.2), 2.5, 3)).toBeCloseTo(0.2, 2);
  });

  it('空档距离：唱的时候是 0，留白里连续长大', () => {
    const two = [
      { startTime: 0, endTime: 1 },
      { startTime: 4, endTime: 5 },
    ];
    expect(resolveSonnetCueGapDistance(two, 0.5)).toBe(0);
    expect(resolveSonnetCueGapDistance(two, 2.5)).toBeCloseTo(1.5, 6);
    expect(resolveSonnetCueGapDistance(two, 4.5)).toBe(0);
    expect(resolveSonnetCueGapDistance([], 1)).toBe(0);
  });

  it('三个输入量都随时间连续（密采样没有台阶，换字那一刻也不跳）', () => {
    const line = cues(24, 0.35, 0.3);
    const dt = 1 / 240;
    let previous: { readonly density: number; readonly duration: number; readonly gap: number } | null = null;
    let worst = 0;
    for (let step = 0; step * dt <= 8; step += 1) {
      const time = step * dt;
      const current = {
        density: resolveSonnetCueDensity(line, time),
        duration: resolveSonnetCueDurationScale(line, time),
        gap: resolveSonnetCueGapDistance(line, time),
      };
      if (previous !== null) {
        worst = Math.max(
          worst,
          Math.abs(current.density - previous.density),
          Math.abs(current.duration - previous.duration) / 4,
          Math.abs(current.gap - previous.gap),
        );
      }
      previous = current;
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('密度端点按真实字素密度校准：常见输入（约 5~10 粒/秒）不再恒为 1.00', () => {
    /* 6.7 粒/秒 = 中日文普通唱 / 英文常见长句（旧上限 3.2 会让它直接顶格） */
    const common = resolveSonnetRhythmProfile(cues(40, 0.15, 0.14), 3);
    expect(common.speed).toBeGreaterThan(0.2);
    expect(common.speed).toBeLessThan(0.9);
    /* 16.7 粒/秒 = 快唱：仍然能到"快"那一档 */
    const fast = resolveSonnetRhythmProfile(cues(60, 0.06, 0.055), 1.8);
    expect(fast.speed).toBeGreaterThan(0.95);
    /* 2.5 粒/秒、每粒 0.42 秒 = 长音：speed 低、sustain 明确起来 */
    const longNote = resolveSonnetRhythmProfile(cues(20, 0.4, 0.42), 4);
    expect(longNote.speed).toBeLessThan(0.2);
    expect(longNote.sustain).toBeGreaterThan(0.2);
    /* 长音下限也校准过：普通唱（每粒约 0.2 秒）不该被当成 0，但也不该顶满 */
    const normalDuration = resolveSonnetRhythmProfile(cues(30, 0.34, 0.2), 5);
    expect(normalDuration.sustain).toBeGreaterThan(0);
    expect(normalDuration.sustain).toBeLessThan(0.4);
  });

  it('密唱 → 跟得紧、平滑窗小、呼吸小；长音 / 空档 → 反过来', () => {
    const dense = resolveSonnetRhythmProfile(cues(30, 0.2, 0.18), 3);
    const slow = resolveSonnetRhythmProfile(cues(6, 1.6, 1.4), 4.8);
    expect(dense.cueDensity).toBeGreaterThan(slow.cueDensity);
    expect(dense.speed).toBeGreaterThan(slow.speed);
    expect(dense.trackingFactor).toBeGreaterThan(slow.trackingFactor);
    expect(dense.smoothingWindow).toBeLessThan(slow.smoothingWindow);
    expect(dense.breathScale).toBeLessThan(slow.breathScale);
    /* 长音（sustain）与空档（hold）分别落在它们的量纲里 */
    expect(slow.sustain).toBeGreaterThan(0.5);
    expect(dense.sustain).toBeLessThan(0.1);
    const inGap = resolveSonnetRhythmProfile(
      [
        { startTime: 0, endTime: 1 },
        { startTime: 3, endTime: 4 },
      ],
      2,
    );
    expect(inGap.hold).toBeGreaterThan(0.5);
    /* 跟拍强度始终夹在两端之间，且没有任何 cue 时退到"最慢"档 */
    for (const time of [-1, 0, 0.5, 2, 4, 9, 30]) {
      const profile = resolveSonnetRhythmProfile(cues(10, 0.5, 0.45), time);
      expect(profile.trackingFactor).toBeGreaterThanOrEqual(SONNET_RHYTHM_TRACKING_SLOW - 1e-9);
      expect(profile.trackingFactor).toBeLessThanOrEqual(SONNET_RHYTHM_TRACKING_FAST + 1e-9);
    }
    expect(resolveSonnetRhythmProfile([], 5)).toEqual(SONNET_IDLE_RHYTHM_PROFILE);
  });

  it('跟拍强度在整段歌词里连续（密采样每步变化很小）', () => {
    const line = cues(20, 0.35, 0.3);
    const dt = 1 / 120;
    let previous: number | null = null;
    let worst = 0;
    for (let step = 0; step * dt <= 7; step += 1) {
      const factor = resolveSonnetRhythmProfile(line, step * dt).trackingFactor;
      if (previous !== null) worst = Math.max(worst, Math.abs(factor - previous));
      previous = factor;
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('dataset 读数包含密度 / 快慢 / 长音 / 空档 / 跟拍 / 平滑窗 / 呼吸', () => {
    const text = describeSonnetRhythmProfile(resolveSonnetRhythmProfile(cues(8, 0.4, 0.35), 1.4));
    for (const key of ['density=', 'speed=', 'sustain=', 'hold=', 'track=', 'sigma=', 'breath=']) {
      expect(text).toContain(key);
    }
  });
});
