import { describe, expect, it } from 'vitest';

import {
  TEMPERA_BLUR_ACTIVE_STRENGTH,
  resolveTemperaTransitionBlurResolution,
  setTemperaTransitionBlur,
  type TemperaSceneFilterTarget,
} from './temperaSceneFilterStack';

const ON = { postProcessTextureCompression: true };
const OFF = { postProcessTextureCompression: false };

const makeScene = (): TemperaSceneFilterTarget & { base: unknown[]; blur: { strength: number } } => {
  const base: unknown[] = [];
  const blur = { strength: 0 };
  return {
    base,
    blur,
    baseFilters: base,
    transitionBlurFilter: blur,
    transitionBlurAttached: false,
    container: { filters: base },
  };
};

describe('resolveTemperaTransitionBlurResolution', () => {
  it('开启压缩：取压缩后 pass 的一半', () => {
    expect(resolveTemperaTransitionBlurResolution(ON, 1.5)).toBe(0.5);
    expect(resolveTemperaTransitionBlurResolution(ON, 0.75)).toBeCloseTo(0.375, 10);
    expect(resolveTemperaTransitionBlurResolution(ON, 2)).toBe(0.5);
  });

  it('关闭压缩：取 renderResolution 本身的一半（不是 inherit）', () => {
    expect(resolveTemperaTransitionBlurResolution(OFF, 1.5)).toBeCloseTo(0.75, 10);
    expect(resolveTemperaTransitionBlurResolution(OFF, 1)).toBeCloseTo(0.5, 10);
  });

  it('恒等于"它周围那条 pass 的一半"——这正是从 pass 派生而非硬写 0.5 的意义', () => {
    for (const r of [0.5, 0.75, 1, 1.2047, 1.5, 2]) {
      const pass = r > 1 ? 1 : r; // 压缩后
      expect(resolveTemperaTransitionBlurResolution(ON, r)).toBeCloseTo(pass / 2, 10);
    }
  });

  it('压缩后恒 <1；不压缩时恒等于 renderResolution 的一半（可能 ≥1，这是上游语义）', () => {
    for (const r of [0.1, 1, 1.5, 3]) {
      expect(resolveTemperaTransitionBlurResolution(ON, r)).toBeLessThan(1);
      expect(resolveTemperaTransitionBlurResolution(OFF, r)).toBeCloseTo(r / 2, 10);
    }
    // 明确记下这个边界：**不压缩那一支用的是 renderResolution 本身**，r ≥ 2 时结果会到 1 或更高。
    expect(resolveTemperaTransitionBlurResolution(OFF, 3)).toBeCloseTo(1.5, 10);
  });
});

describe('setTemperaTransitionBlur（挂/摘状态机）', () => {
  it('没有模糊滤镜时整个函数是空操作', () => {
    const scene = makeScene();
    scene.transitionBlurFilter = null;
    const before = scene.container.filters;
    setTemperaTransitionBlur(scene, 0.8);
    expect(scene.container.filters).toBe(before);
    expect(scene.transitionBlurAttached).toBe(false);
  });

  it('阈值是严格大于 0.01：等于 0.01 不算有效，0.011 才算', () => {
    const scene = makeScene();
    setTemperaTransitionBlur(scene, TEMPERA_BLUR_ACTIVE_STRENGTH);
    expect(scene.transitionBlurAttached).toBe(false);
    setTemperaTransitionBlur(scene, TEMPERA_BLUR_ACTIVE_STRENGTH + 0.001);
    expect(scene.transitionBlurAttached).toBe(true);
  });

  it('有效 ⇒ 挂到 baseFilters 之后，并把强度写进 filter', () => {
    const scene = makeScene();
    const marker = {};
    scene.baseFilters.push(marker);
    setTemperaTransitionBlur(scene, 0.6);
    expect(scene.transitionBlurAttached).toBe(true);
    expect(scene.blur.strength).toBe(0.6);
    expect(scene.container.filters).toHaveLength(2);
    expect(scene.container.filters[0]).toBe(marker);
    expect(scene.container.filters[1]).toBe(scene.blur);
  });

  it('状态没变时**不重建数组**（同一个引用），但强度照样更新', () => {
    const scene = makeScene();
    setTemperaTransitionBlur(scene, 0.6);
    const attachedArray = scene.container.filters;
    setTemperaTransitionBlur(scene, 0.9);
    expect(scene.container.filters).toBe(attachedArray);
    expect(scene.blur.strength).toBe(0.9);
  });

  it('强度掉到阈值以下 ⇒ 摘掉，并且赋回的是 baseFilters **原数组引用**（与上游一致）', () => {
    const scene = makeScene();
    scene.baseFilters.push({});
    setTemperaTransitionBlur(scene, 0.6);
    setTemperaTransitionBlur(scene, 0);
    expect(scene.transitionBlurAttached).toBe(false);
    expect(scene.container.filters).toBe(scene.baseFilters);
  });

  it('无效状态下重复调用是幂等的（不反复重设 filters）', () => {
    const scene = makeScene();
    const before = scene.container.filters;
    setTemperaTransitionBlur(scene, 0);
    setTemperaTransitionBlur(scene, 0);
    expect(scene.container.filters).toBe(before);
    expect(scene.transitionBlurAttached).toBe(false);
  });
});
