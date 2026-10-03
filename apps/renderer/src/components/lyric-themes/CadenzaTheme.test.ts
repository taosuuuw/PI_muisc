/**
 * 心象（cadenza）**用户第 9 轮第 3 条**的纯函数回归。
 *
 * 用户原话：「图 4 是对于心象，没有逐个字高光逐渐消失的效果，图 5 是应该达到的效果」。
 *
 * 病根是**相位的形状**：旧写法让字色的高光比例从前一个词的结束线性爬到这一个词的结束，
 * 一颗字全亮的那一瞬间恰好是它唱完的那一瞬间 —— 屏上最常见的中间态因此是「白字 + 一圈粉光晕」
 * （主人图 4 就是这个组合），看起来像高光「啪」一下掉了，而不是「逐渐消失」。
 *
 * 这一组钉住新的三段曲线（`cadenzaHighlightMix`）与它跟歌速挂钩的时长（`cadenzaFadeMs`）：
 * 快进 → **保持整个词的时值** → 按歌速缓缓淡出。任何一段退化（比如「保持」被删掉、
 * 或者淡出被夹成一个瞬时值）都会让下面某条断言变红。
 */

import { describe, expect, it } from 'vitest';

import { buildDomTextShadow, cadenzaFadeMs, cadenzaHighlightMix, inkFromVar } from './CadenzaTheme';

/**
 * **用户第 11 轮第 1 条**（原话：「心象浅色模式下，唱过的歌词应该是黑色」）。
 *
 * 心象的常态色原来自己算（白 → 「够 3:1 就停」⇒ 浅色底上停在中灰）；现在直接吃舞台那一支
 * `--pi-lyric-ink`（亮档 = `var(--pi-text)` 近黑），与 classic / partita / tilt / pendolo 同源。
 */
describe('cadenza 常态墨色（用户第 11 轮第 1 条：亮档 = 流光那支黑）', () => {
  it('拿到实色 ⇒ 原样使用（不再做对比度兜底，否则又和流光不一致）', () => {
    expect(inkFromVar('rgb(26, 29, 36)')).toBe('rgb(26, 29, 36)');
    expect(inkFromVar('rgb(255, 255, 255)')).toBe('rgb(255, 255, 255)');
  });

  it('拿不到 / 解析不出 ⇒ null，由调用方退回老口径', () => {
    expect(inkFromVar(undefined)).toBeNull();
    expect(inkFromVar('')).toBeNull();
    expect(inkFromVar('   ')).toBeNull();
    expect(inkFromVar('var(--pi-lyric-ink, #fff)')).toBeNull();
    expect(inkFromVar('#0f0f0f')).toBeNull();
  });
});

/**
 * **用户第 10 轮第 1 条**（原话：「心象的辉光强度太大了，降低一点」）。
 *
 * 真病根是**同一圈光被画了两遍**：这支 `text-shadow` 写在 `.pi-lyriccadenza__word` 上，而那个 div
 * 里有 `.pi-lyriccadenza__body`（正文）与 `.pi-lyriccadenza__glow`（透明辉光层）两层文字，
 * `text-shadow` 是继承属性 ⇒ 两层各描一遍、屏幕上是两支阴影叠加（≈设计值的 2 倍）。
 * 修法：正文层 `text-shadow: none`（CSS）+ 三层透明度上限收三成（下面这组断言）。
 */
describe('cadenza 辉光（用户第 10 轮第 1 条：强度降下来）', () => {
  const alphasOf = (shadow: string): number[] => {
    const out: number[] = [];
    for (const match of shadow.matchAll(/rgba?\([^)]*?,\s*([0-9.]+)\)/g)) {
      const value = Number.parseFloat(match[1] ?? '');
      if (Number.isFinite(value)) out.push(value);
    }
    return out;
  };

  it('三层辉光的透明度上限 = 0.70 / 0.55 / 0.22（旧值 0.98 / 0.92 / 0.35）', () => {
    const shadow = buildDomTextShadow('rgb(96, 217, 230)', 1.6);
    const alphas = alphasOf(shadow);
    expect(alphas).toHaveLength(3);
    expect(alphas[0]).toBeCloseTo(0.7, 6);
    expect(alphas[1]).toBeCloseTo(0.55, 6);
    expect(alphas[2]).toBeCloseTo(0.22, 6);
    // 「降低一点」的硬指标：任何一层都不许超过 0.7（旧写法第一层就是 0.98）。
    expect(Math.max(...alphas)).toBeLessThanOrEqual(0.7);
  });

  it('半径 40px → 36px；三层同色', () => {
    const shadow = buildDomTextShadow('rgb(96, 217, 230)', 1);
    expect(shadow.match(/0 0 36px/g)).toHaveLength(3);
    expect(shadow).not.toContain('40px');
    expect(shadow.match(/rgb\(96, 217, 230\)|rgba\(96, 217, 230/g)).toHaveLength(3);
  });

  it('强度为 0（没在唱 / 已淡干净）时是 none，不是一圈 0 透明度的空阴影', () => {
    expect(buildDomTextShadow('rgb(96, 217, 230)', 0)).toBe('none');
    expect(buildDomTextShadow('rgb(96, 217, 230)', 0.01)).toBe('none');
  });

  it('低强度时三层一起变小（包络只缩放幅度，不改上限）', () => {
    const alphas = alphasOf(buildDomTextShadow('rgb(96, 217, 230)', 0.3));
    expect(alphas[0]).toBeCloseTo(0.3, 6);
    expect(alphas[1]).toBeCloseTo(0.234, 6);
    expect(alphas[2]).toBeCloseTo(0.09, 6);
    // 单调：核心 ≥ 中层 ≥ 外层（旧写法也是这个次序，眼里的「三层」才成立）。
    expect(alphas[0]).toBeGreaterThanOrEqual(alphas[1] ?? 0);
    expect(alphas[1]).toBeGreaterThanOrEqual(alphas[2] ?? 0);
  });
});

describe('cadenzaFadeMs（用户第 9 轮第 3 条：渐出时长跟歌速，两端都夹）', () => {
  it('常速（倍率 1）：normal = 1100ms；short 的 240ms 被地板托到 420ms', () => {
    expect(cadenzaFadeMs('normal', 1)).toBe(1100);
    expect(cadenzaFadeMs('short', 1)).toBe(420);
  });

  it('快歌淡得快（×0.35 ⇒ 地板 420ms）、慢歌淡得慢（×2.2 ⇒ 天花板 2200ms）', () => {
    expect(cadenzaFadeMs('normal', 0.35)).toBe(420);
    expect(cadenzaFadeMs('normal', 0.5)).toBe(550);
    expect(cadenzaFadeMs('normal', 1.5)).toBe(1650);
    expect(cadenzaFadeMs('normal', 2.2)).toBe(2200);
    // 单调不减
    const values = [0.35, 0.6, 1, 1.4, 2, 2.2].map((ratio) => cadenzaFadeMs('normal', ratio));
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index] ?? 0).toBeGreaterThanOrEqual(values[index - 1] ?? 0);
    }
  });

  it('倍率缺失 / 非有限 ⇒ 退回常速；micro 与 normal 同档（micro 走 0/1 开关，用不到它）', () => {
    expect(cadenzaFadeMs('normal', Number.NaN)).toBe(1100);
    expect(cadenzaFadeMs('normal', Number.POSITIVE_INFINITY)).toBe(1100);
    expect(cadenzaFadeMs('micro', 1)).toBe(1100);
    expect(cadenzaFadeMs('short', Number.NaN)).toBe(420);
  });
});

describe('cadenzaHighlightMix（用户第 9 轮第 3 条：快进 → 保持 → 逐渐消失）', () => {
  /** 一个 400ms 的词，渐出取常速档 1100ms。 */
  const START = 1000;
  const END = 1400;
  const FADE = 1100;
  const mix = (ms: number): number => cadenzaHighlightMix(ms, START, END, FADE);

  it('还没轮到它 ⇒ 0（只是纸上的常态字）', () => {
    expect(mix(0)).toBe(0);
    expect(mix(START)).toBe(0);
    expect(mix(START - 1)).toBe(0);
  });

  it('快进：开唱后 140ms 内爬到满（`clamp(400 × 0.3, 40, 140)` = 120ms）', () => {
    expect(mix(START + 30)).toBeGreaterThan(0.5);
    expect(mix(START + 120)).toBe(1);
  });

  it('**保持**：整个词时值里恒为 1 —— 这是旧写法缺的那一档（唱到它时它就是实的主题色）', () => {
    expect(mix(START + 130)).toBe(1);
    expect(mix(START + 300)).toBe(1);
    expect(mix(END)).toBe(1);
  });

  it('逐渐消失：唱完半程还剩一半亮、走完整段才归零（旧写法这时已经掉到 0.9×(1−q)² 了）', () => {
    expect(mix(END + FADE / 2)).toBeCloseTo(0.5, 6);
    expect(mix(END + FADE)).toBe(0);
    expect(mix(END + FADE * 2)).toBe(0);
    // 唱完才 100ms 时仍然接近全亮 —— 观感上就是「不会啪一下断掉」
    expect(mix(END + 100)).toBeGreaterThan(0.85);
    expect(mix(END + 300)).toBeGreaterThan(0.6);
  });

  it('单调非增（唱完之后只往常态色走，不会回头）且每 40ms 一帧的跳变 ≤ 0.15', () => {
    let previous = mix(END);
    for (let elapsed = 0; elapsed <= FADE + 200; elapsed += 40) {
      const value = mix(END + elapsed);
      expect(value).toBeLessThanOrEqual(previous + 1e-9);
      expect(previous - value).toBeLessThanOrEqual(0.15);
      previous = value;
    }
  });

  it('一帧里能同时看到好几颗字停在不同档上 —— 这正是「逐个字高光逐渐消失」', () => {
    // 6 个字、每个 200ms：最后一颗唱完 300ms 时取样。
    const words = Array.from({ length: 6 }, (_, index) => ({
      start: index * 200,
      end: index * 200 + 200,
    }));
    const ms = 5 * 200 + 200 + 300;
    const mixes = words.map((word) => cadenzaHighlightMix(ms, word.start, word.end, FADE));
    // 最后三颗字分别是「刚唱完」「唱完半程上下」「早就淡干净」三档 ⇒ 至少三种不同的高光比例。
    const distinct = new Set(mixes.map((value) => value.toFixed(2)));
    expect(distinct.size).toBeGreaterThanOrEqual(3);
    // 而且它们**不是**一刀切（既不是全 0 也不是全 1）
    expect(mixes.some((value) => value > 0.5)).toBe(true);
    expect(mixes.some((value) => value < 0.2)).toBe(true);
  });

  it('歌速参与：同一时刻，快歌（渐出短）比慢歌更接近常态色', () => {
    const elapsed = 400;
    const fast = cadenzaHighlightMix(END + elapsed, START, END, cadenzaFadeMs('normal', 0.35));
    const slow = cadenzaHighlightMix(END + elapsed, START, END, cadenzaFadeMs('normal', 2.2));
    expect(fast).toBeLessThan(slow);
    expect(fast).toBeGreaterThanOrEqual(0);
    expect(slow).toBeLessThanOrEqual(1);
  });

  it('instant（micro 行，整行 < 0.1s）保持旧的 0/1 开关：唱完才置 1，不做补间', () => {
    expect(cadenzaHighlightMix(END - 1, START, END, FADE, true)).toBe(0);
    expect(cadenzaHighlightMix(END, START, END, FADE, true)).toBe(0);
    expect(cadenzaHighlightMix(END + 1, START, END, FADE, true)).toBe(1);
    expect(cadenzaHighlightMix(END + 5000, START, END, FADE, true)).toBe(1);
  });

  it('退化输入不出 NaN（NaN 会让整条颜色插值失效、字直接停在常态色或主题色）', () => {
    for (const value of [
      cadenzaHighlightMix(Number.NaN, START, END, FADE),
      cadenzaHighlightMix(1200, Number.NaN, END, FADE),
      cadenzaHighlightMix(1200, START, START, FADE),
      cadenzaHighlightMix(1200, START, END, 0),
      cadenzaHighlightMix(1200, START, END, Number.NaN),
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
