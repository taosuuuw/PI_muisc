/**
 * 倾诉（tilt）**用户第 8 轮第 3 条**的纯函数版：
 * 「其中斜体的歌词有一定概率有颜色」——抽签必须是**确定性**的（同一行 + 同一段序号永远同一个
 * 答案，重渲染 / 每一帧都不抖），而且概率真的落在「一半左右」，不能恒真或恒假。
 *
 * 「不要一次性显示两行」那一半是 DOM 结构（`TiltTheme` 只渲染当前这一行），
 * 由冒烟探针逐帧量 `.pi-lyrictilt__block` 的个数钉住（`tiltSingleLineOk`）。
 */

import { describe, expect, it } from 'vitest';
import { tiltPartTinted } from './TiltTheme';

describe('倾听斜体段抽签上色（用户第 8 轮第 3 条）', () => {
  it('非斜体段一律不上色', () => {
    for (let index = 0; index < 40; index += 1) {
      expect(tiltPartTinted(12_345, index, false)).toBe(false);
    }
  });

  it('斜体段约一半中签（既不恒真也不恒假）', () => {
    let tinted = 0;
    for (let index = 0; index < 400; index += 1) {
      if (tiltPartTinted(12_345, index, true)) tinted += 1;
    }
    expect(tinted).toBeGreaterThan(400 * 0.3);
    expect(tinted).toBeLessThan(400 * 0.7);
  });

  it('同一个输入永远同一个答案（确定性，不随渲染次数变）', () => {
    const first = tiltPartTinted(98_765, 3, true);
    for (let repeat = 0; repeat < 5; repeat += 1) {
      expect(tiltPartTinted(98_765, 3, true)).toBe(first);
    }
  });

  it('换一行（时间戳不同）会换一批中签的段', () => {
    const lineA = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => tiltPartTinted(1000, index, true));
    const lineB = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => tiltPartTinted(2000, index, true));
    expect(lineA).not.toEqual(lineB);
  });
});
