import { describe, expect, it } from 'vitest';

import { easeTemperaInOut } from './temperaEasing';
import {
  IDLE_TEMPERA_TRANSITION_FRAME,
  resolveTemperaEnterTransitionFrame,
  resolveTemperaExitTransitionFrame,
  resolveTemperaTransitionEffectFrame,
} from './temperaTransitionEffects';

const FLOW = 0;

describe('block-wipe：连续 0..2 行程，场景不动不透明', () => {
  it('出场 wipe 从 0 走到 1（= 满覆盖）', () => {
    expect(resolveTemperaExitTransitionFrame('block-wipe', 0, FLOW).wipe).toBeCloseTo(0, 6);
    expect(resolveTemperaExitTransitionFrame('block-wipe', 1, FLOW).wipe).toBeCloseTo(1, 6);
  });

  it('进场 wipe 从 1 走到 2 —— 接在出场的 1 之后，所以色块不会中途反向', () => {
    expect(resolveTemperaTransitionEffectFrame('block-wipe', 'enter', 0, FLOW).wipe).toBeCloseTo(1, 6);
    expect(resolveTemperaTransitionEffectFrame('block-wipe', 'enter', 1, FLOW).wipe).toBeCloseTo(2, 6);
  });

  it('行程单调不减（0..2 全程）', () => {
    const exits = [0, 0.25, 0.5, 0.75, 1].map((p) => resolveTemperaExitTransitionFrame('block-wipe', p, FLOW).wipe);
    for (let i = 1; i < exits.length; i += 1) expect(exits[i] ?? 0).toBeGreaterThanOrEqual(exits[i - 1] ?? 0);
    const enters = [0, 0.25, 0.5, 0.75, 1].map(
      (p) => resolveTemperaTransitionEffectFrame('block-wipe', 'enter', p, FLOW).wipe,
    );
    for (let i = 1; i < enters.length; i += 1) expect(enters[i] ?? 0).toBeGreaterThanOrEqual(enters[i - 1] ?? 0);
    expect(enters[0] ?? 0).toBeGreaterThanOrEqual(exits[exits.length - 1] ?? 0);
  });

  it('不动、不透明、不模糊', () => {
    const frame = resolveTemperaExitTransitionFrame('block-wipe', 0.4, FLOW);
    expect(frame.x).toBe(0);
    expect(frame.y).toBe(0);
    expect(frame.scale).toBe(1);
    expect(frame.alpha).toBe(1);
    expect(frame.blur).toBe(0);
    expect(frame.wipeAngle).toBe(FLOW);
  });
});

describe('camera-pan：位移 + 轻微放大，alpha 保持到几乎出画', () => {
  it('出场沿 flow 正向移出、进场从负向移入', () => {
    const out = resolveTemperaExitTransitionFrame('camera-pan', 1, FLOW);
    expect(out.x).toBeCloseTo(0.5, 6);
    const enter = resolveTemperaTransitionEffectFrame('camera-pan', 'enter', 1, FLOW);
    expect(enter.x).toBeCloseTo(0, 6);
    const enterStart = resolveTemperaTransitionEffectFrame('camera-pan', 'enter', 0, FLOW);
    expect(enterStart.x).toBeCloseTo(-0.5, 6);
  });

  it('alpha：出场到 0.72 才开始掉、进场 0.3 就到位', () => {
    expect(resolveTemperaExitTransitionFrame('camera-pan', 0.72, FLOW).alpha).toBeCloseTo(1, 6);
    expect(resolveTemperaExitTransitionFrame('camera-pan', 1, FLOW).alpha).toBeCloseTo(0, 6);
    expect(resolveTemperaTransitionEffectFrame('camera-pan', 'enter', 0, FLOW).alpha).toBeCloseTo(0, 6);
    expect(resolveTemperaTransitionEffectFrame('camera-pan', 'enter', 0.3, FLOW).alpha).toBeCloseTo(1, 6);
  });

  it('放大系数按 0.03 计', () => {
    const end = resolveTemperaExitTransitionFrame('camera-pan', 1, FLOW);
    expect(end.scale).toBeCloseTo(1 + easeTemperaInOut(1) * 0.03, 6);
  });

  it('本支没有 blur', () => {
    for (const p of [0, 0.5, 1]) {
      expect(resolveTemperaExitTransitionFrame('camera-pan', p, FLOW).blur).toBe(0);
      expect(resolveTemperaTransitionEffectFrame('camera-pan', 'enter', p, FLOW).blur).toBe(0);
    }
  });
});

describe('shape-carry：漂移 + 放大 + 柔化（唯一带 blur 的一支）', () => {
  it('blur = away * 6：出场从 0 升到 6、进场从 6 降到 0', () => {
    expect(resolveTemperaExitTransitionFrame('shape-carry', 0, FLOW).blur).toBeCloseTo(0, 6);
    expect(resolveTemperaExitTransitionFrame('shape-carry', 1, FLOW).blur).toBeCloseTo(6, 6);
    expect(resolveTemperaTransitionEffectFrame('shape-carry', 'enter', 0, FLOW).blur).toBeCloseTo(6, 6);
    expect(resolveTemperaTransitionEffectFrame('shape-carry', 'enter', 1, FLOW).blur).toBeCloseTo(0, 6);
  });

  it('blur 全程 ≤ 6 且非负', () => {
    for (const p of [0, 0.2, 0.5, 0.8, 1]) {
      for (const phase of ['enter', 'exit'] as const) {
        const blur = resolveTemperaTransitionEffectFrame('shape-carry', phase, p, FLOW).blur;
        expect(blur).toBeGreaterThanOrEqual(0);
        expect(blur).toBeLessThanOrEqual(6);
      }
    }
  });

  it('alpha 门槛是 0.55 / 0.45', () => {
    expect(resolveTemperaExitTransitionFrame('shape-carry', 0.55, FLOW).alpha).toBeCloseTo(1, 6);
    expect(resolveTemperaExitTransitionFrame('shape-carry', 1, FLOW).alpha).toBeCloseTo(0, 6);
    expect(resolveTemperaTransitionEffectFrame('shape-carry', 'enter', 0.45, FLOW).alpha).toBeCloseTo(1, 6);
  });
});

describe('resolver 的公共行为', () => {
  it('只改传入 flow 方向上的分量，且 wipeAngle 一律等于 flowAngle', () => {
    const angle = Math.PI / 2;
    const frame = resolveTemperaExitTransitionFrame('camera-pan', 1, angle);
    expect(frame.x).toBeCloseTo(0, 6);
    expect(frame.y).toBeCloseTo(0.5, 6);
    expect(frame.wipeAngle).toBe(angle);
  });

  it('progress 超出 0..1 会被 clamp（不放大行程/不越界）', () => {
    expect(resolveTemperaExitTransitionFrame('block-wipe', 5, FLOW).wipe).toBeCloseTo(1, 6);
    expect(resolveTemperaExitTransitionFrame('block-wipe', -3, FLOW).wipe).toBeCloseTo(0, 6);
  });

  it('**不修改** IDLE 常量（返回值是拷贝）', () => {
    resolveTemperaExitTransitionFrame('shape-carry', 1, FLOW);
    resolveTemperaTransitionEffectFrame('camera-pan', 'enter', 0, FLOW);
    expect(IDLE_TEMPERA_TRANSITION_FRAME).toEqual({
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      alpha: 1,
      blur: 0,
      wipe: 0,
      wipeAngle: 0,
    });
  });
});

describe('进场包装：窗口外一律空闲帧', () => {
  const base = { enabled: true, timeSinceStart: 0.1, duration: 0.5 };

  it('未启用 / kind 为 null / 起点之前 / 超出时长 ⇒ 空闲帧', () => {
    expect(resolveTemperaEnterTransitionFrame(null, base, FLOW)).toEqual(IDLE_TEMPERA_TRANSITION_FRAME);
    expect(resolveTemperaEnterTransitionFrame('camera-pan', { ...base, enabled: false }, FLOW)).toEqual(
      IDLE_TEMPERA_TRANSITION_FRAME,
    );
    expect(resolveTemperaEnterTransitionFrame('camera-pan', { ...base, timeSinceStart: -0.01 }, FLOW)).toEqual(
      IDLE_TEMPERA_TRANSITION_FRAME,
    );
    expect(resolveTemperaEnterTransitionFrame('camera-pan', { ...base, timeSinceStart: 0.51 }, FLOW)).toEqual(
      IDLE_TEMPERA_TRANSITION_FRAME,
    );
  });

  it('窗口内 = 以 timeSinceStart / duration 为进度的那一帧', () => {
    const viaWrapper = resolveTemperaEnterTransitionFrame('camera-pan', base, FLOW);
    const direct = resolveTemperaTransitionEffectFrame('camera-pan', 'enter', 0.1 / 0.5, FLOW);
    expect(viaWrapper).toEqual(direct);
  });

  it('duration 为 0 时不除零（用 max(duration, 0.001)）', () => {
    const frame = resolveTemperaEnterTransitionFrame('block-wipe', { enabled: true, timeSinceStart: 0, duration: 0 }, FLOW);
    expect(Number.isFinite(frame.wipe)).toBe(true);
  });
});
