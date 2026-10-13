import { describe, expect, it } from 'vitest';

import { easeTemperaEnter } from './temperaEasing';
import {
  resolveTemperaAliveShotIndices,
  resolveTemperaShotExitProgress,
  resolveTemperaShotHandoffDuration,
  resolveTemperaShotHandoffFrame,
} from './temperaShotHandoff';

const base = {
  startTime: 10,
  endTime: 14, // 时长 4s
  time: 14,
  flowAngle: 0,
  width: 1000,
  height: 800,
  camera: 1,
  frameX: 0,
  frameY: 0,
};

describe('交接时长：shot 时长 × 0.3，钳 0.4~1.1s', () => {
  it('中段按 0.3 倍', () => {
    expect(resolveTemperaShotHandoffDuration(0, 3)).toBeCloseTo(0.9, 6);
  });

  it('短 shot 被下限钳到 0.4', () => {
    expect(resolveTemperaShotHandoffDuration(0, 1)).toBeCloseTo(0.4, 6);
    expect(resolveTemperaShotHandoffDuration(0, 0)).toBeCloseTo(0.4, 6);
  });

  it('长 shot 被上限钳到 1.1', () => {
    expect(resolveTemperaShotHandoffDuration(0, 10)).toBeCloseTo(1.1, 6);
    expect(resolveTemperaShotHandoffDuration(0, 100)).toBeCloseTo(1.1, 6);
  });
});

describe('出画进度：过了 endTime 仍在画', () => {
  const handoff = 1.2;

  it('endTime 之前恒为 0（交接窗口还没开始）', () => {
    expect(resolveTemperaShotExitProgress(13.9, 14, handoff)).toBe(0);
    expect(resolveTemperaShotExitProgress(0, 14, handoff)).toBe(0);
  });

  it('endTime + handoff 时到 1', () => {
    expect(resolveTemperaShotExitProgress(14 + handoff, 14, handoff)).toBeCloseTo(1, 6);
  });

  it('中途线性推进', () => {
    expect(resolveTemperaShotExitProgress(14 + handoff / 2, 14, handoff)).toBeCloseTo(0.5, 6);
  });

  it('超过窗口后夹在 1（不越界）', () => {
    expect(resolveTemperaShotExitProgress(14 + handoff * 5, 14, handoff)).toBe(1);
  });
});

describe('交接帧', () => {
  it('time = startTime 时 enter = 0，且此时 travel 为负（还在画外上游）', () => {
    const frame = resolveTemperaShotHandoffFrame({ ...base, time: 10 });
    expect(frame.enter).toBeCloseTo(easeTemperaEnter(0), 6);
    expect(frame.travel).toBeCloseTo(0 - (1 - 0) * 1000 * 0.32, 3); // span = max(1000, 800)
  });

  it('入画按 handoff × 0.8 前置加载：到 startTime + 0.8×handoff 时 enter 已到 1', () => {
    const handoff = resolveTemperaShotHandoffDuration(base.startTime, base.endTime);
    const frame = resolveTemperaShotHandoffFrame({ ...base, time: 10 + handoff * 0.8 });
    expect(frame.enter).toBeCloseTo(1, 6);
  });

  it('shot 中段（既没进也没出）travel = 0', () => {
    const frame = resolveTemperaShotHandoffFrame({ ...base, time: 12 });
    expect(frame.enter).toBeCloseTo(1, 6);
    expect(frame.exit).toBeCloseTo(0, 6);
    expect(frame.travel).toBeCloseTo(0, 6);
  });

  it('出画末态 travel = span × 0.55（已被推出去）', () => {
    const handoff = resolveTemperaShotHandoffDuration(base.startTime, base.endTime);
    const frame = resolveTemperaShotHandoffFrame({ ...base, time: 14 + handoff });
    expect(frame.exit).toBeCloseTo(1, 6);
    expect(frame.travel).toBeCloseTo(1000 * 0.55, 3); // span = max(1000, 800)
  });

  it('位移只沿 flowAngle 方向投影', () => {
    const angle = Math.PI / 2;
    const handoff = resolveTemperaShotHandoffDuration(base.startTime, base.endTime);
    const frame = resolveTemperaShotHandoffFrame({ ...base, flowAngle: angle, time: 14 + handoff });
    expect(frame.x).toBeCloseTo(0, 6);
    expect(frame.y).toBeCloseTo(1000 * 0.55, 3); // span = max(1000, 800)
  });

  it('相机分量按 width/height 与 camera 系数计入基准位置', () => {
    const frame = resolveTemperaShotHandoffFrame({
      ...base,
      time: 12,
      camera: 2,
      frameX: 0.1,
      frameY: -0.05,
      baseX: 5,
      baseY: 7,
    });
    expect(frame.x).toBeCloseTo(5 + 0.1 * 1000 * 2, 6);
    expect(frame.y).toBeCloseTo(7 + -0.05 * 800 * 2, 6);
  });

  it('span 取宽高较大者', () => {
    const tall = resolveTemperaShotHandoffFrame({ ...base, width: 400, height: 900, time: 10 });
    expect(tall.travel).toBeCloseTo(-900 * 0.32, 3);
  });
});

describe('在屏 shot：相邻两个在交接窗口内同屏', () => {
  // 每个 3s：handoff = clamp(3×0.3, 0.4, 1.1) = 0.9 ⇒ 前一个活到 3.9
  const shots = [
    { startTime: 0, endTime: 3 },
    { startTime: 3, endTime: 6 },
    { startTime: 6, endTime: 9 },
  ];

  it('交接窗口之前只有前一个', () => {
    expect(resolveTemperaAliveShotIndices(shots, 2)).toEqual([0]);
  });

  it('刚跨过边界：两个同时在场（这是交接感的来源）', () => {
    expect(resolveTemperaAliveShotIndices(shots, 3)).toEqual([0, 1]);
    expect(resolveTemperaAliveShotIndices(shots, 3.5)).toEqual([0, 1]);
  });

  it('前一个的出画窗口结束后只剩后一个', () => {
    expect(resolveTemperaAliveShotIndices(shots, 4)).toEqual([1]);
  });

  it('10s 长的 shot：handoff 被上限钳到 1.1 ⇒ 活到 11.1', () => {
    const long = [{ startTime: 0, endTime: 10 }, { startTime: 10, endTime: 20 }];
    expect(resolveTemperaAliveShotIndices(long, 11.0)).toEqual([0, 1]);
    expect(resolveTemperaAliveShotIndices(long, 11.2)).toEqual([1]);
  });

  it('极短 shot：handoff 被下限钳到 0.4 ⇒ 活到 endTime + 0.4', () => {
    const brief = [{ startTime: 0, endTime: 0.2 }, { startTime: 0.2, endTime: 0.4 }];
    expect(resolveTemperaAliveShotIndices(brief, 0.5)).toEqual([0, 1]);
    expect(resolveTemperaAliveShotIndices(brief, 0.61)).toEqual([1]);
  });

  it('时间在整段之前 / 之后：空数组，不硬画', () => {
    expect(resolveTemperaAliveShotIndices(shots, -1)).toEqual([]);
    expect(resolveTemperaAliveShotIndices(shots, 100)).toEqual([]);
  });
});
