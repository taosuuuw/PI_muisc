import { describe, expect, it } from 'vitest';
import { STRETCH_LIMIT, planTransition } from './automix';
import { PROFILE_VERSION, type TrackProfile } from './profile';

/**
 * 规划器的每条规则都对应一个「听感问题」：量化错 → 接在半拍上；变速过量 → 像加速播放；
 * 明明是长静音结尾却硬叠 → 空一大段。所以这里逐条钉。
 */
function profileOf(overrides: Partial<TrackProfile> = {}): TrackProfile {
  return {
    songId: 1,
    version: PROFILE_VERSION,
    durationMs: 200_000,
    bpm: 120,
    beatOffsetSec: 0.1,
    beatPeriodSec: 0.5,
    confidence: 0.9,
    tail: { silenceSec: 0, activityRatio: 1 },
    head: { silenceSec: 0, startsHot: false },
    analyzedAt: Date.now(),
    analysisMs: 10,
    ...overrides,
  };
}

describe('两端都有拍网格', () => {
  it('量化到 16 拍，时长按拍长算', () => {
    const plan = planTransition({
      outgoing: profileOf(),
      incoming: profileOf({ songId: 2 }),
      remainingSec: 30,
    });
    expect(plan.style).toBe('beatCut');
    expect(plan.durationSec).toBeCloseTo(16 * 0.5, 5);
    expect(plan.tempoRatio).toBe(1);
    expect(plan.reason).toContain('16 拍');
  });

  it('BPM 差 4%：允许微调，时长按变速后的拍长算', () => {
    const plan = planTransition({
      outgoing: profileOf({ beatPeriodSec: 0.5 }),
      incoming: profileOf({ beatPeriodSec: 0.48, bpm: 125 }),
      remainingSec: 30,
    });
    expect(plan.tempoRatio).toBeCloseTo(0.5 / 0.48, 6);
    // 16 拍 × (0.5 / 1.0417) ≈ 7.68s
    expect(plan.durationSec).toBeCloseTo((16 * 0.5) / (0.5 / 0.48), 5);
    expect(plan.reason).toContain('变速');
  });

  it('BPM 差 20%：变速被夹在 ±12%', () => {
    const plan = planTransition({
      outgoing: profileOf({ beatPeriodSec: 0.5 }),
      incoming: profileOf({ beatPeriodSec: 0.6, bpm: 100 }),
      remainingSec: 30,
    });
    expect(plan.tempoRatio).toBeCloseTo(1 - STRETCH_LIMIT, 6);
  });

  it('剩余时间只够 8 拍：退让到 8 拍', () => {
    const plan = planTransition({
      outgoing: profileOf(),
      incoming: profileOf({ songId: 2 }),
      remainingSec: 5, // 0.5s × 10 拍 → 最多 8 拍
    });
    expect(plan.durationSec).toBeCloseTo(8 * 0.5, 5);
    expect(plan.reason).toContain('8 拍');
  });

  it('剩余时间只够 4 拍：退让到 4 拍', () => {
    const plan = planTransition({
      outgoing: profileOf(),
      incoming: profileOf({ songId: 2 }),
      remainingSec: 2.4, // 只放得下 4 拍
    });
    expect(plan.durationSec).toBeCloseTo(4 * 0.5, 5);
  });

  it('进场曲一上来就满电平：改用 bassSwap（低频让位）', () => {
    const plan = planTransition({
      outgoing: profileOf(),
      incoming: profileOf({ songId: 2, head: { silenceSec: 0, startsHot: true } }),
      remainingSec: 30,
    });
    expect(plan.style).toBe('bassSwap');
    expect(plan.reason).toContain('bassSwap');
  });
});

describe('只有一端有网格', () => {
  it('出场曲尾部有静音：tailRide，长度随静音拉长但不超过 8 秒', () => {
    const plan = planTransition({
      outgoing: profileOf({ beatPeriodSec: null, bpm: null, confidence: 0, tail: { silenceSec: 4, activityRatio: 0.2 } }),
      remainingSec: 20,
    });
    expect(plan.style).toBe('tailRide');
    expect(plan.durationSec).toBeGreaterThanOrEqual(4);
    expect(plan.durationSec).toBeLessThanOrEqual(8);
    expect(plan.tempoRatio).toBe(1);
  });

  it('置信度低于阈值：当作没有网格', () => {
    const plan = planTransition({
      outgoing: profileOf({ confidence: 0.1 }),
      incoming: profileOf({ songId: 2 }),
      remainingSec: 30,
    });
    expect(plan.style).toBe('plainBlend');
  });
});

describe('兜底', () => {
  it('两端都没有档案：plainBlend 固定时长', () => {
    const plan = planTransition({ remainingSec: 20 });
    expect(plan.style).toBe('plainBlend');
    expect(plan.durationSec).toBe(5);
    expect(plan.tempoRatio).toBe(1);
  });

  it('兜底时长可配置（调用方传 P2 的交叉时长）', () => {
    const plan = planTransition({ remainingSec: 20, fallbackDurationSec: 6 });
    expect(plan.durationSec).toBe(6);
  });
});
