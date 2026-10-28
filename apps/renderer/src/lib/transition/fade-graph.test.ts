import { describe, expect, it } from 'vitest';
import {
  FADE_OUT_MS,
  ensureGraph,
  fadeIn,
  fadeOut,
  resetFade,
  resumeGraph,
  setMasterVolume,
  shouldStartTailFade,
} from './fade-graph';

/**
 * 淡变图的两类可测部分：
 * ① 没有 `AudioContext` 的环境（纯 Node 单测）里，所有原语必须安全 no-op —— 播放状态机的
 *    单测就活在这种环境里，任何一个原语抛错都会把那些用例带崩；
 * ② 歌尾淡出的**判定**。真正的调度（读 `currentTime`、开定时器）在 `state/player.ts` 里，
 *    依赖真音频元素；判定则是容易写错的地方（边界 / NaN / 重复触发），所以单独钉在这里。
 */
const fakeElement = {} as HTMLAudioElement;

describe('没有 AudioContext 的环境', () => {
  it('ensureGraph 返回 undefined，而不是抛错', () => {
    expect(ensureGraph(fakeElement)).toBeUndefined();
  });

  it('所有淡变原语都是安全的 no-op', async () => {
    expect(() => fadeIn(10)).not.toThrow();
    expect(() => resetFade()).not.toThrow();
    expect(() => setMasterVolume(0.5, false)).not.toThrow();
    await expect(fadeOut(10)).resolves.toBeUndefined();
    await expect(resumeGraph()).resolves.toBe(true);
  });
});

describe('歌尾淡出的触发判定', () => {
  const fadeOutSec = FADE_OUT_MS / 1000;

  it('还剩 3 秒：不触发', () => {
    expect(shouldStartTailFade(3, false)).toBe(false);
  });

  it('刚好进入淡出窗口：触发', () => {
    expect(shouldStartTailFade(fadeOutSec, false)).toBe(true);
  });

  it('窗口外一点点：不触发', () => {
    expect(shouldStartTailFade(fadeOutSec + 0.2, false)).toBe(false);
  });

  it('已经淡过一次：不重复触发', () => {
    expect(shouldStartTailFade(0.5, true)).toBe(false);
  });

  it('剩余 0 / 负数 / NaN：都不触发', () => {
    expect(shouldStartTailFade(0, false)).toBe(false);
    expect(shouldStartTailFade(-1, false)).toBe(false);
    expect(shouldStartTailFade(Number.NaN, false)).toBe(false);
    expect(shouldStartTailFade(Number.POSITIVE_INFINITY, false)).toBe(false);
  });

  it('剩下的比淡出还短（后台定时器被节流那种）：仍然触发', () => {
    expect(shouldStartTailFade(0.25, false)).toBe(true);
  });
});
