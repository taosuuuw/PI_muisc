import { describe, expect, it } from 'vitest';
import {
  analyzeSamples,
  detectBeat,
  downmixAndDownsample,
  frameEnergy,
  onsetEnvelope,
} from './analyze';

/**
 * 分析核心的测试全部用**合成信号**：真实的音频文件没法进单测，而这里每个判定
 * （尾部静音多长、有没有前奏、拍点是多少）都能用构造出来的波形精确预期。
 */
const RATE = 22_050;

/** 造一段「每拍一个短 burst」的节拍轨。 */
function makeBeatTrack(options: {
  seconds?: number;
  bpm?: number;
  burstSec?: number;
  amplitude?: number;
}): Float32Array {
  const { seconds = 10, bpm = 120, burstSec = 0.06, amplitude = 0.8 } = options;
  const length = Math.floor(seconds * RATE);
  const out = new Float32Array(length);
  const interval = 60 / bpm;
  for (let time = 0; time < seconds; time += interval) {
    const start = Math.floor(time * RATE);
    const burstFrames = Math.floor(burstSec * RATE);
    for (let i = 0; i < burstFrames && start + i < length; i += 1) {
      const decay = 1 - i / burstFrames;
      out[start + i] = Math.sin((2 * Math.PI * 1000 * i) / RATE) * amplitude * decay;
    }
  }
  return out;
}

function silence(samples: Float32Array, fromSec: number, toSec: number): void {
  const from = Math.floor(fromSec * RATE);
  const to = Math.min(samples.length, Math.floor(toSec * RATE));
  for (let i = from; i < to; i += 1) samples[i] = 0;
}

describe('降采样', () => {
  it('单声道 44100 → 22050：长度减半、幅度不变', () => {
    const source = {
      numberOfChannels: 1,
      length: 1000,
      sampleRate: 44_100,
      getChannelData: () => {
        const data = new Float32Array(1000);
        data.fill(0.5);
        return data;
      },
    };
    const out = downmixAndDownsample(source, 22_050);
    expect(out.length).toBe(500);
    // 区间平均：两个 0.5 取平均还是 0.5。
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[499]).toBeCloseTo(0.5, 5);
  });

  it('立体声取两声道平均', () => {
    const left = new Float32Array(1000).fill(0.2);
    const right = new Float32Array(1000).fill(0.4);
    const source = {
      numberOfChannels: 2,
      length: 1000,
      sampleRate: 44_100,
      getChannelData: (channel: number) => (channel === 0 ? left : right),
    };
    const out = downmixAndDownsample(source, 22_050);
    expect(out[0]).toBeCloseTo(0.3, 5);
  });
});

describe('帧能量与 onset', () => {
  it('全零信号：能量全为 0', () => {
    const energy = frameEnergy(new Float32Array(RATE));
    expect(energy.length).toBeGreaterThan(0);
    for (const value of energy) expect(value).toBe(0);
  });

  it('恒定正弦：能量恒定，onset 在起跳处有一个正峰', () => {
    const samples = new Float32Array(RATE);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin((2 * Math.PI * 440 * i) / RATE);
    const onset = onsetEnvelope(frameEnergy(samples));
    expect(Math.max(...onset)).toBeGreaterThan(0);
  });
});

describe('拍点检测', () => {
  it('120 BPM 的脉冲串：能测出 120', () => {
    const samples = makeBeatTrack({ seconds: 12, bpm: 120 });
    const energy = frameEnergy(samples);
    const beat = detectBeat(onsetEnvelope(energy), RATE);
    expect(beat).not.toBeNull();
    expect(beat?.bpm).toBeGreaterThan(115);
    expect(beat?.bpm).toBeLessThan(125);
    expect(beat?.confidence).toBeGreaterThan(0.25);
  });

  it('140 BPM 的脉冲串：能测出 140', () => {
    const samples = makeBeatTrack({ seconds: 12, bpm: 140 });
    const beat = detectBeat(onsetEnvelope(frameEnergy(samples)), RATE);
    expect(beat?.bpm).toBeGreaterThan(133);
    expect(beat?.bpm).toBeLessThan(147);
  });

  it('静音：测不出拍点', () => {
    const beat = detectBeat(onsetEnvelope(frameEnergy(new Float32Array(RATE * 10))), RATE);
    expect(beat).toBeNull();
  });
});

describe('整体分析', () => {
  it('尾部两秒静音：tail.silenceSec 落在 2 秒附近', () => {
    const samples = makeBeatTrack({ seconds: 12, bpm: 120 });
    silence(samples, 10, 12);
    const profile = analyzeSamples(samples, RATE, 12_000);
    expect(profile.tail.silenceSec).toBeGreaterThan(1.8);
    expect(profile.tail.silenceSec).toBeLessThan(2.6);
  });

  it('开头一秒静音：head.silenceSec 落在 1 秒附近', () => {
    const samples = makeBeatTrack({ seconds: 12, bpm: 120 });
    silence(samples, 0, 1);
    const profile = analyzeSamples(samples, RATE, 12_000);
    expect(profile.head.silenceSec).toBeGreaterThan(0.8);
    expect(profile.head.silenceSec).toBeLessThan(1.4);
  });

  it('一上来就是满电平：startsHot=true', () => {
    const samples = new Float32Array(RATE * 12);
    // 前 2 秒持续满电平，后面静音：全曲平均远低于头部平均。
    for (let i = 0; i < RATE * 2; i += 1) samples[i] = Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.9;
    const profile = analyzeSamples(samples, RATE, 12_000);
    expect(profile.head.silenceSec).toBeLessThan(0.1);
    expect(profile.head.startsHot).toBe(true);
  });

  it('整首都有内容：startsHot=false（没有前奏不等于一上来就满电平）', () => {
    const samples = makeBeatTrack({ seconds: 12, bpm: 120, amplitude: 0.5 });
    const profile = analyzeSamples(samples, RATE, 12_000);
    expect(profile.head.startsHot).toBe(false);
  });

  it('静音：拍点信息全部为 null，且没有 NaN', () => {
    const profile = analyzeSamples(new Float32Array(RATE * 5), RATE, 5_000);
    expect(profile.bpm).toBeNull();
    expect(profile.beatOffsetSec).toBeNull();
    expect(profile.confidence).toBe(0);
    expect(profile.tail.silenceSec).toBeGreaterThan(4.5);
    expect(profile.head.silenceSec).toBeGreaterThan(4.5);
    expect(Number.isFinite(profile.tail.activityRatio)).toBe(true);
  });
});
