/**
 * 商籁（sonnet）**帧层数值**的自查：音频驱动、入场进度、旋转规则。
 *
 * 这些是渲染层"该画成什么样"的算术部分 —— 纯函数、无 Pixi，所以数值一旦写反，这里就该先红。
 * 断言盯的是**性质**（单调、夹紧、快升慢落、收笔不早于 95%）与**照抄来的具体系数**。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_AUDIO_ATTACK,
  SONNET_AUDIO_GATE,
  SONNET_AUDIO_RELEASE,
  SONNET_AUDIO_WEIGHTS,
  SONNET_HUD_GEO_VARIANT,
  SONNET_UPRIGHT_GEO_VARIANTS,
  normalizeSonnetAudioLevel,
  resolveSonnetAudioEnergy,
  resolveSonnetGeoRotation,
  resolveSonnetIconAudioTarget,
  resolveSonnetIconEntryDelay,
  resolveSonnetIconPose,
  resolveSonnetSceneProgress,
  smoothSonnetIconAudio,
} from './sonnetScene';

describe('sonnet 音频驱动', () => {
  it('电平归一化：比例原样、字节除以 255，都夹在 0..1', () => {
    expect(normalizeSonnetAudioLevel(0.5)).toBeCloseTo(0.5, 9);
    expect(normalizeSonnetAudioLevel(128)).toBeCloseTo(128 / 255, 9);
    expect(normalizeSonnetAudioLevel(255)).toBeCloseTo(1, 9);
    expect(normalizeSonnetAudioLevel(999)).toBeCloseTo(1, 9);
    expect(normalizeSonnetAudioLevel(-5)).toBe(0);
  });

  it('三路权重之和正好是 1（所以全开就是 1、全关就是 0）', () => {
    const sum = SONNET_AUDIO_WEIGHTS.bass + SONNET_AUDIO_WEIGHTS.vocal + SONNET_AUDIO_WEIGHTS.power;
    expect(sum).toBeCloseTo(1, 9);
    expect(resolveSonnetAudioEnergy(0, 0, 0)).toBe(0);
    expect(resolveSonnetAudioEnergy(1, 1, 1)).toBeCloseTo(1, 9);
  });

  it('人声比低音更重、低音比整体功率更重', () => {
    const bassOnly = resolveSonnetAudioEnergy(1, 0, 0);
    const vocalOnly = resolveSonnetAudioEnergy(0, 1, 0);
    const powerOnly = resolveSonnetAudioEnergy(0, 0, 1);
    expect(vocalOnly).toBeGreaterThan(bassOnly);
    expect(bassOnly).toBeGreaterThan(powerOnly);
  });

  it('目标强度：门限以下归零、拉满后封顶 1', () => {
    expect(resolveSonnetIconAudioTarget(0)).toBe(0);
    expect(resolveSonnetIconAudioTarget(SONNET_AUDIO_GATE)).toBe(0);
    expect(resolveSonnetIconAudioTarget(1)).toBe(1);
    expect(resolveSonnetIconAudioTarget(0.5)).toBeGreaterThan(0);
    expect(resolveSonnetIconAudioTarget(0.5)).toBeLessThan(1);
  });

  it('平滑：上升用攻击系数、回落用释放系数（上升更快）', () => {
    expect(SONNET_AUDIO_ATTACK).toBeGreaterThan(SONNET_AUDIO_RELEASE);
    expect(smoothSonnetIconAudio(0, 1)).toBeCloseTo(SONNET_AUDIO_ATTACK, 9);
    expect(smoothSonnetIconAudio(1, 0)).toBeCloseTo(1 - SONNET_AUDIO_RELEASE, 9);
  });

  it('图标姿态：入场未开始时几乎不可见、入场完成后回到基础值附近，音频放大不超过一成半', () => {
    const atRest = resolveSonnetIconPose({
      baseAlpha: 0.8,
      baseScale: 1,
      entryProgress: 0,
      audio: 0,
      phase: 0,
      timeInScene: 0,
    });
    expect(atRest.alpha).toBeCloseTo(0, 6);
    const quiet = resolveSonnetIconPose({
      baseAlpha: 0.8,
      baseScale: 1,
      entryProgress: 1,
      audio: 0,
      phase: 0,
      timeInScene: 0,
    });
    const loud = resolveSonnetIconPose({
      baseAlpha: 0.8,
      baseScale: 1,
      entryProgress: 1,
      audio: 1,
      phase: 0,
      timeInScene: 0,
    });
    /*
     * `timeInScene = 0, phase = 0` 时脉动正好在中位（sin 0 = 0 ⇒ loopPulse = 0.5），
     * 于是有一层 **+1.25%** 的常驻放大 —— 这是公式本身的行为，不是误差。
     */
    expect(quiet.scale).toBeCloseTo(1.0125, 6);
    expect(loud.scale).toBeGreaterThan(quiet.scale);
    expect(loud.scale / quiet.scale).toBeLessThan(1.5);
    // 透明度永远不越界。
    expect(loud.alpha).toBeLessThanOrEqual(1);
    expect(quiet.alpha).toBeGreaterThan(0);
  });

  it('图标入场延迟摊在场景前段，且不会把入场推到场景之外', () => {
    const duration = 2;
    const scene = 10;
    expect(resolveSonnetIconEntryDelay(0, scene, duration)).toBe(0);
    const late = resolveSonnetIconEntryDelay(1, scene, duration);
    expect(late).toBeCloseTo(scene - duration, 6);
    expect(resolveSonnetIconEntryDelay(1.4, scene, duration)).toBeLessThanOrEqual(scene - duration);
  });
});

describe('sonnet 入场进度', () => {
  it('最后一个字很早时，收笔取"起点 + 95% 跨度"（背景不会早早画完僵住）', () => {
    const result = resolveSonnetSceneProgress(0, 10, 30, [11, 12]);
    // 跨度 20 ⇒ 地平线 10 + 19 = 29，比最后一个提示（12）晚得多。
    expect(result.targetFinishTime).toBeCloseTo(29, 6);
    expect(result.drawDuration).toBeCloseTo(19, 6);
  });

  it('最后一个字很晚时，收笔退回那个时刻（但不越过结束时间）', () => {
    // 95% 地平线是 29；提示在 29.5 —— 只有**超过**地平线，它才会真的把收笔提前。
    const result = resolveSonnetSceneProgress(0, 10, 30, [29.5]);
    expect(result.targetFinishTime).toBeCloseTo(29.5, 6);
    const beyond = resolveSonnetSceneProgress(0, 10, 30, [45]);
    expect(beyond.targetFinishTime).toBe(30);
  });

  it('进度单调、夹在 0..1，且绘制时长有 1 秒下限', () => {
    const start = 4;
    const end = 4.5;
    const first = resolveSonnetSceneProgress(start, start, end, []);
    const mid = resolveSonnetSceneProgress(start + 0.25, start, end, []);
    const last = resolveSonnetSceneProgress(start + 5, start, end, []);
    expect(first.progress).toBe(0);
    expect(mid.progress).toBeGreaterThan(0);
    expect(mid.progress).toBeLessThan(1);
    expect(last.progress).toBe(1);
    expect(first.drawDuration).toBeGreaterThanOrEqual(1);
  });

  it('**长音镜**：进度一直到收笔时刻才到 1（背景/形状不会提前收笔僵住）', () => {
    /*
     * 行为证据（`resolveSonnetSceneProgress` 本来就是这条上游口径，`SonnetFrame.rawProgress`
     * 只是把它统一命名后给背景/形状/固定几何/背景 MG 共用）：最后一个词在第 12 秒就唱完了，
     * 但镜到 30 秒才结束 ⇒ 收笔取 95% 地平线（29 秒），于是 20 秒时进度还明显小于 1、
     * 29 秒时才到 1。若有人把口径改回"取最后一个词的起点"，这条会立刻红。
     */
    const cues = [11, 12];
    const at20 = resolveSonnetSceneProgress(20, 10, 30, cues);
    const atFinish = resolveSonnetSceneProgress(29, 10, 30, cues);
    const atEnd = resolveSonnetSceneProgress(30, 10, 30, cues);
    expect(at20.progress).toBeLessThan(0.6);
    expect(at20.progress).toBeGreaterThan(0.4);
    expect(atFinish.progress).toBeCloseTo(1, 6);
    expect(atEnd.progress).toBe(1);
    /* 逐帧单调（生长不会回退 ✓）。 */
    let previous = -1;
    for (let time = 10; time <= 30; time += 0.5) {
      const progress = resolveSonnetSceneProgress(time, 10, 30, cues).progress;
      expect(progress).toBeGreaterThanOrEqual(previous);
      previous = progress;
    }
  });
});

describe('sonnet 几何变体的旋转规则', () => {
  it('正立白名单里的变体不转；HUD 框按 90° 的整数倍转', () => {
    for (const variant of SONNET_UPRIGHT_GEO_VARIANTS) {
      if (variant === SONNET_HUD_GEO_VARIANT) continue;
      expect(resolveSonnetGeoRotation(7, variant, 100)).toBe(0);
    }
    for (let seed = 0; seed < 8; seed += 1) {
      const rotation = resolveSonnetGeoRotation(seed, SONNET_HUD_GEO_VARIANT, 100);
      const quarterTurns = rotation / (Math.PI / 2);
      expect(Math.abs(quarterTurns - Math.round(quarterTurns))).toBeLessThan(1e-9);
    }
  });

  it('其余变体吃种子的任意角，且同一个种子是确定的', () => {
    const rotation = resolveSonnetGeoRotation(13, 0, 100);
    expect(rotation).toBeCloseTo(((13 * 13) % 360) * (Math.PI / 180), 9);
    expect(resolveSonnetGeoRotation(13, 0, 100)).toBe(resolveSonnetGeoRotation(13, 0, 100));
    expect(rotation).toBeGreaterThan(0);
    expect(rotation).toBeLessThan(Math.PI * 2);
  });

  it('主题化变体（编号在起始线以上）一律正立', () => {
    expect(resolveSonnetGeoRotation(9, 100, 100)).toBe(0);
    expect(resolveSonnetGeoRotation(9, 99, 100)).not.toBe(0);
  });
});
