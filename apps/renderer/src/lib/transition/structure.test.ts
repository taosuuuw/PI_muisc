import { describe, expect, it } from 'vitest';
import { detectSections } from './structure';

/**
 * 结构检测用「A-B-A-B」的合成信号验：两段音色明显不同（440Hz 与 1760Hz）交替，
 * 边界就是每 4 秒一处。真正难的是音乐，但这里要钉的是「边界检测与重复段聚类」这套算法
 * 本身没写反。
 */
const RATE = 22_050;

function tone(freq: number, seconds: number): Float32Array {
  const length = Math.floor(seconds * RATE);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    // 加一点谐波让 mel 特征更像真实音色（纯正弦只有一根谱线，区分度偏低）。
    out[i] =
      (Math.sin((2 * Math.PI * freq * i) / RATE) * 0.5 +
        Math.sin((2 * Math.PI * freq * 2 * i) / RATE) * 0.25) *
      0.8;
  }
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('结构段落检测', () => {
  it('A-B-A-B 交替：能切出段落，并把两个 A 归为同一类', () => {
    const a = tone(440, 4);
    const b = tone(1760, 4);
    const samples = concat([a, b, a, b]);
    const result = detectSections(samples, 16);

    expect(result.sections.length).toBeGreaterThanOrEqual(3);
    // A 出现两次 → 应该识别出「重复类」（副歌候选）。
    expect(result.chorusClassId).not.toBeNull();
    // classId 相同的就是重复段。
    const ids = result.sections.map((section) => section.classId);
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it('整首同一种声音：切不出多个不同类的段（最多一段，或全同类）', () => {
    const samples = tone(440, 16);
    const result = detectSections(samples, 16);
    const ids = new Set(result.sections.map((section) => section.classId));
    expect(ids.size).toBeLessThanOrEqual(1);
  });

  it('全静音：直接返回空，不炸', () => {
    const result = detectSections(new Float32Array(RATE * 8), 8);
    expect(result.sections).toEqual([]);
  });
});
