/**
 * 段落级出场转场（第 313 轮补的用例）。
 *
 * 期望值**手算**；涉及缓动的只有 `glitch` 一项，而 **α 完全不经过缓动**
 * （`mono-glitch` 的 α 只看 `linear > 0.86`），所以下面几条可以写成精确值。
 */

import { describe, expect, it } from 'vitest';
import type { SonnetParagraph } from './sonnetProgram';
import {
  SONNET_IDLE_TRANSITION,
  resolveSonnetParagraphExitTransition,
} from './sonnetTransitions';

const paragraphWith = (transitionOut: SonnetParagraph['transitionOut']): SonnetParagraph =>
  ({ transitionOut }) as unknown as SonnetParagraph;

const FAST_BLUR = paragraphWith({ kind: 'fast-blur', startTime: 10, endTime: 10.2 });
const GLITCH = paragraphWith({ kind: 'mono-glitch', startTime: 10, endTime: 10.2 });

describe('商籁段落级出场转场（上游 resolveSonnetExitTransitionFrame）', () => {
  it('还没走到转场窗口 ⇒ 返回 IDLE（同一个对象，不是等值对象）', () => {
    expect(resolveSonnetParagraphExitTransition(FAST_BLUR, 9.5, true, 7)).toBe(
      SONNET_IDLE_TRANSITION,
    );
    // 边界：正好等于 startTime 时**已经**进窗口（上游是 `time < startTime` 才 IDLE）。
    expect(resolveSonnetParagraphExitTransition(FAST_BLUR, 10, true, 7)).not.toBe(
      SONNET_IDLE_TRANSITION,
    );
  });

  it('没有 transitionOut / 开关关掉 ⇒ 一律 IDLE', () => {
    expect(
      resolveSonnetParagraphExitTransition(paragraphWith(null), 10.1, true, 7),
    ).toBe(SONNET_IDLE_TRANSITION);
    expect(resolveSonnetParagraphExitTransition(FAST_BLUR, 10.1, false, 7)).toBe(
      SONNET_IDLE_TRANSITION,
    );
  });

  it('fast-blur：中点 α≈0.5（缓动是三次贝塞尔求解，只能到 1 位精度）、blurPx≈7；末尾 α=0、blurPx=14', () => {
    // ⚠ 我第一版这里写了 `toBeCloseTo(0.5, 6)` —— **红了**。
    // 原因不是实现错，而是 `easeSonnetInOut` 是**二分求解**的三次贝塞尔
    // （`sonnetMotion.ts` 自述"精度略低、但绝不发散"），所以在 0.5 处**不是精确 0.5**；
    // 仓库既有的 `sonnetMotion.test.ts` 对同一函数也只敢 `toBeCloseTo(0.5, 1)`。
    // ⇒ 教训：**用别人给过的精度**，别自己加码。
    const middle = resolveSonnetParagraphExitTransition(FAST_BLUR, 10.1, true, 7);
    expect(middle.alpha).toBeCloseTo(0.5, 1);
    expect(middle.blurPx).toBeCloseTo(7, 1);
    expect(middle.glitch).toBe(0);
    // 严格单调性比具体数值更稳：中点必须落在两端之间。
    expect(middle.alpha).toBeGreaterThan(0);
    expect(middle.alpha).toBeLessThan(1);

    // 末尾这两条是**精确**的（progress=1 ⇒ eased=1 ⇒ amount=1，与二分精度无关）。
    const end = resolveSonnetParagraphExitTransition(FAST_BLUR, 10.2, true, 7);
    expect(end.alpha).toBeCloseTo(0, 6);
    expect(end.blurPx).toBeCloseTo(14, 6);
  });

  it('mono-glitch：α 在 0.86 之前恒为 1，走到末尾才掉到 0（不经过缓动）', () => {
    // 窗口中点 ⇒ linear = 0.5 < 0.86 ⇒ α 仍为 1。
    expect(resolveSonnetParagraphExitTransition(GLITCH, 10.1, true, 7).alpha).toBeCloseTo(1, 6);
    // 窗口末尾 ⇒ linear = 1 ⇒ α = 1 − (1 − 0.86) / 0.14 = 0。
    expect(resolveSonnetParagraphExitTransition(GLITCH, 10.2, true, 7).alpha).toBeCloseTo(0, 6);
    // 这个转场靠 glitch 通道，不靠模糊。
    expect(resolveSonnetParagraphExitTransition(GLITCH, 10.2, true, 7).blurPx).toBe(0);
    expect(resolveSonnetParagraphExitTransition(GLITCH, 10.1, true, 7).glitch).toBeGreaterThan(0);
  });

  it('窗口时长为 0 也不会除出 NaN（分母有 0.001 兜底）', () => {
    const degenerate = paragraphWith({ kind: 'camera-pull', startTime: 3, endTime: 3 });
    const frame = resolveSonnetParagraphExitTransition(degenerate, 3, true, 1);
    expect(Number.isFinite(frame.alpha)).toBe(true);
    expect(Number.isFinite(frame.glitchSeed)).toBe(true);
    // camera-pull 刻意不缩放（上游注释：渲染面是视口大小，一缩放就露边界）。
    expect(frame.scale).toBe(1);
  });
});
