import { describe, expect, it } from 'vitest';
import {
  archiveFraming,
  archiveWave,
  bell,
  columnStrength,
  damp,
  idleWave,
  RhineMomentum,
  RhinePlaneMomentum,
  returnStep,
  rippleEnvelope,
  selectionRippleWave,
  settlingWave,
  smooth,
} from './rhine-motion';

/**
 * 莱茵阵列的**运动学**回归用例。
 *
 * 这些断言锁的是从参考实现（RhineLabUI，MIT）逐行读出来的数值与**形态**：
 * 波形在哪起、跑多快、包络多宽、弹簧收不收敛、惯性滑多远。它们不依赖 DOM，
 * 所以改渲染层不会让它们变红 —— 只有改这些「数值骨架」时才该红。
 */
describe('莱茵运动学：缓动', () => {
  it('smooth 首尾一阶导为零，且中点严格对称', () => {
    expect(smooth(-1)).toBe(0);
    expect(smooth(0)).toBe(0);
    expect(smooth(1)).toBe(1);
    expect(smooth(2)).toBe(1);
    expect(smooth(0.5)).toBeCloseTo(0.5, 10);
    expect(smooth(0.25) + smooth(0.75)).toBeCloseTo(1, 10);
  });

  it('bell 在 0 处为 1、在 1 倍宽度处约 0.6065', () => {
    expect(bell(0, 2)).toBe(1);
    expect(bell(2, 2)).toBeCloseTo(Math.exp(-0.5), 10);
  });
});

describe('莱茵运动学：肩部轮廓（settlingWave）', () => {
  it('选中行（距离 0）起的是正峰，包络 2.15', () => {
    expect(settlingWave(0, 0)).toBe(0);
    // 起势 0.62s：跑到 0.62s 时应当很接近包络值（叠了振铃，所以给一点余量）。
    expect(settlingWave(0, 0.62)).toBeGreaterThan(1.9);
    expect(settlingWave(0, 5)).toBeCloseTo(2.15, 1);
  });

  it('每行延迟 0.065s：远处那几行还没动', () => {
    expect(settlingWave(10, 0.1)).toBe(0);
    // 10 行 × 0.065 = 0.65s 之后才开始起。
    expect(settlingWave(10, 0.66 + 0.62)).toBeGreaterThan(0);
  });

  it('远处包络是负的（下压），但被夹在 -0.42', () => {
    const far = settlingWave(40, 8);
    expect(far).toBeLessThan(0);
    expect(far).toBeGreaterThanOrEqual(-0.42 * 1.2);
  });
});

describe('莱茵运动学：选中涟漪（selectionRippleWave）', () => {
  it('只在 0~3.2s 内有值', () => {
    expect(selectionRippleWave(4, -0.01)).toBe(0);
    expect(selectionRippleWave(4, 3.3)).toBe(0);
  });

  it('波前以 8 行/秒向外跑（同一时刻峰值落在 age × 8 附近）', () => {
    const age = 0.5;
    const front = age * 8;
    const atFront = selectionRippleWave(front, age);
    const farBehind = selectionRippleWave(front - 12, age);
    expect(Math.abs(atFront)).toBeGreaterThan(Math.abs(farBehind));
  });

  it('幅度上界 0.8（带负谷的基线版本）', () => {
    let worst = 0;
    for (let age = 0; age <= 3.2; age += 0.01) {
      for (let distance = -20; distance <= 60; distance += 0.5) {
        worst = Math.max(worst, Math.abs(selectionRippleWave(distance, age)));
      }
    }
    expect(worst).toBeLessThanOrEqual(0.8 + 1e-6);
  });

  it('源点静止的包络对距离 0 恒为零（参考里那条实验方案的判据）', () => {
    expect(rippleEnvelope(0, 0.4)).toBe(0);
  });
});

describe('莱茵运动学：列强度与呼吸', () => {
  it('焦点列的强度是 1，远处衰减到 0.25', () => {
    expect(columnStrength(3, 3)).toBe(1);
    expect(columnStrength(3 + 6, 3)).toBeCloseTo(0.25, 2);
  });

  it('呼吸位移不超过 0.102（参考写明「约卡片高度 2.8%」）', () => {
    let worst = 0;
    for (let time = 0; time < 30; time += 0.05) {
      for (let row = 0; row < 12; row += 1) {
        worst = Math.max(worst, Math.abs(idleWave(row, 1, time)));
      }
    }
    expect(worst).toBeLessThanOrEqual(0.102 + 1e-9);
  });
});

describe('莱茵运动学：阻尼与惯性', () => {
  it('临界阻尼不越过目标', () => {
    const spring = { value: 0, velocity: 0 };
    let previous = 0;
    for (let i = 0; i < 240; i += 1) {
      damp(spring, 1, 4.2, 1 / 60);
      expect(spring.value).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(spring.value).toBeLessThanOrEqual(1 + 1e-9);
      previous = spring.value;
    }
    expect(spring.value).toBeCloseTo(1, 3);
  });

  it('惯性：快拖滑得比慢拖远，最后停在整数格上', () => {
    const travel = (velocity: number): { distance: number; landed: number } => {
      const motion = new RhineMomentum(0, velocity);
      for (let i = 0; i < 600 && motion.phase !== 'idle'; i += 1) motion.step(1 / 60);
      return { distance: Math.abs(motion.value), landed: motion.value };
    };
    const fast = travel(4);
    const slow = travel(1.2);
    expect(fast.distance).toBeGreaterThan(slow.distance);
    expect(Number.isInteger(fast.landed)).toBe(true);
    expect(Number.isInteger(slow.landed)).toBe(true);
  });

  it('平面惯性：两个分量一起收，都到整数格才 idle', () => {
    const plane = new RhinePlaneMomentum({ lane: 1.2, row: 3.4 }, { lane: -1.6, row: 0.9 });
    for (let i = 0; i < 900 && plane.phase !== 'idle'; i += 1) plane.step(1 / 60);
    expect(plane.phase).toBe('idle');
    expect(Number.isInteger(plane.value.lane)).toBe(true);
    expect(Number.isInteger(plane.value.row)).toBe(true);
  });
});

describe('莱茵运动学：开场传播波与取景', () => {
  it('开场波在两个包络之外严格为零', () => {
    expect(archiveWave(0, 0, -0.1)).toBe(0);
    expect(archiveWave(0, 0, 4.4)).toBe(0);
    // 前 0.32s 是起势：刚到 0.16s 时幅度还很小。
    const early = Math.abs(archiveWave(3, 0, 0.16));
    const later = Math.abs(archiveWave(3 + 19 * 0.5, 0, 0.5));
    expect(early).toBeLessThan(later);
  });

  it('取景：16:9 是基准；更宽的屏纵向不变、更窄的屏纵向放大；竖屏另有一档', () => {
    const base = archiveFraming(1920, 1080, 7.33, 0, false);
    expect(base.portrait).toBe(false);
    expect(base.span).toBeCloseTo(7.33, 6);
    expect(base.detailX).toBeCloseTo(550 / 1920, 6);

    // 超宽屏（2.37:1）只是横向多看到几列，纵向基准不变（这正是参考的意图：
    // `max(baseSpan, baseSpan * (16/9) / aspect)` 在宽屏上取前者）。
    const wide = archiveFraming(2560, 1080, 7.33, 0, false);
    expect(wide.span).toBeCloseTo(base.span, 6);

    // 比 16:9 更「方」的窗口纵向必须放大，否则左右会看到阵列尽头。
    const squarer = archiveFraming(1512, 1080, 7.33, 0, false);
    expect(squarer.span).toBeGreaterThan(base.span);

    const tall = archiveFraming(800, 1200, 7.33, 0, false);
    expect(tall.portrait).toBe(true);
    expect(tall.detailX).toBe(0.5);

    const compact = archiveFraming(1000, 700, 7.33, 0, true);
    expect(compact.detailX).toBe(0.27);
  });

  it('取景：详情档把范围收到 5.9', () => {
    const detail = archiveFraming(1920, 1080, 7.33, 1, false);
    expect(detail.span).toBeCloseTo(5.9, 6);
  });
});

describe('莱茵运动学：归位副本的转正（returnStep）', () => {
  it('按 exp(-dt*7) 收，进 0.001 就归零（不是无限接近）', () => {
    // SOURCE: motion.ts:101-109 —— ALIGNMENT_EPSILON = 0.001、速率 7。
    const dt = 1 / 60;
    let angle = 0.8;
    let frames = 0;
    while (Math.abs(angle) > 0.001 && frames < 600) {
      angle = returnStep(angle, dt);
      frames += 1;
    }
    expect(Math.abs(angle)).toBeLessThanOrEqual(0.001);
    // 0.8 → 0.001 需要 ln(800)/7 ≈ 0.955 秒，也就是 60fps 下 57 帧上下。
    expect(frames).toBeGreaterThan(50);
    expect(frames).toBeLessThan(70);
  });

  it('减少动态效果时换成 35 的速率：几帧内归零（不是瞬间跳变）', () => {
    const dt = 1 / 60;
    const oneFrameNormal = returnStep(0.8, dt, false);
    const oneFrameReduced = returnStep(0.8, dt, true);
    expect(oneFrameReduced).toBeLessThan(oneFrameNormal);
    let angle = 0.8;
    let frames = 0;
    while (Math.abs(angle) > 0.001 && frames < 60) {
      angle = returnStep(angle, dt, true);
      frames += 1;
    }
    expect(angle).toBe(0);
    // 实测：35 的速率下 0.8 → 0.001 要 12 帧（约 0.2 秒）。
    expect(frames).toBeLessThanOrEqual(16);
  });

  it('符号保持：反向转回去也走同一条曲线', () => {
    const negative = returnStep(-0.4, 1 / 60);
    expect(negative).toBeLessThan(0);
    expect(Math.abs(negative)).toBeLessThan(0.4);
  });
});

