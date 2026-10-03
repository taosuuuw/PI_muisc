import { describe, expect, it } from 'vitest';

import {
  buildFumePaint,
  capFumeHeroes,
  fumeFontPx,
  fumeFrontGlyphIndex,
  fumeOutroOffset,
  fumeOutroFocusFade,
  fumeOutroPlan,
  fumeOutroSoon,
  fumeTrailColor,
  packFumeSlots,
  type FumePackItem,
} from './FumeTheme';
import { contrastRatio, mixColor, parseRgb } from './types';

/**
 * **用户本轮第 1 条**（「歌词大小分为普通和大字幕歌词，大小比例如图 2 所示」）。
 *
 * 图 2 是同一帧上两颗完整可见的字：普通 62.5px/字、大字幕 104.5px/字 ⇒ **0.60**
 * （图 1 交叉验算：普通 54.5px/字、大字幕 ~105px/字 ⇒ 0.52）。这条把「普通 ÷ 大字幕 = 0.6」
 * 钉成回归：与窗口宽、栏数、句子长短、fontScale 都无关。
 */
describe('fumeFontPx（用户本轮第 1 条：普通 = 大字幕 × 0.6）', () => {
  /** 典型 4 栏窗口：`heroWidth` = 2 栏 + gap（纸宽 2400、4 栏时 ≈ 1193）。 */
  const HERO_WIDTH = 1193;
  const TYPICAL: readonly [number, number][] = [
    // [密度, heroWidth]：极短句 / 普通句 / 长句 / 窄窗 / 单列
    [4, HERO_WIDTH],
    [12, HERO_WIDTH],
    [40, HERO_WIDTH],
    [12, 420],
    [64, 420],
    [4, 1600],
  ];

  it('同密度同宽下：普通 = 大字幕 × 0.6（上下限都没夹住时是精确值）', () => {
    for (const [density, heroWidth] of TYPICAL) {
      const hero = fumeFontPx(true, heroWidth, density, 1);
      const body = fumeFontPx(false, heroWidth, density, 1);
      console.log(
        `[fume] 密度=${density} heroWidth=${heroWidth} → 大字幕=${hero.toFixed(2)} 普通=${body.toFixed(2)} 比=${(body / hero).toFixed(3)}`,
      );
      expect(body / hero).toBeCloseTo(0.6, 6);
    }
  });

  it('普通的基准不再被旧的上限（28px）压回去：典型窗口下普通 = 54 × 0.6 = 32.4px', () => {
    // 旧公式在这个密度下给 28（夹在上限）—— 与大字幕的 54 相差近一半，且与句子长短无关。
    expect(fumeFontPx(true, HERO_WIDTH, 12, 1)).toBe(54);
    expect(fumeFontPx(false, HERO_WIDTH, 12, 1)).toBeCloseTo(32.4, 6);
  });

  it('fontScale 两端都同比例：0.8 与 1.3 时比值仍是 0.6', () => {
    for (const scale of [0.8, 1.3]) {
      const hero = fumeFontPx(true, HERO_WIDTH, 12, scale);
      const body = fumeFontPx(false, HERO_WIDTH, 12, scale);
      expect(body / hero).toBeCloseTo(0.6, 6);
    }
  });

  it('hero 那一支逐位等于改造前：`宽 / max(√密度 × 1.5, 4.5)` 夹 [24, 54]', () => {
    expect(fumeFontPx(true, 1193, 12, 1)).toBe(54);
    // 长句：1193 / (√40 × 1.5) = 125.7 ⇒ 仍在上限；窄窗长句才落到中间档。
    expect(fumeFontPx(true, 420, 64, 1)).toBeCloseTo(420 / (8 * 1.5), 6);
    // 极窄：落到 24px 下限。
    expect(fumeFontPx(true, 40, 100, 1)).toBe(24);
  });

  it('单调：同一行密度越大字号越小、窗口越宽字号越大（不出现反号）', () => {
    const narrow = fumeFontPx(false, 420, 12, 1);
    const wide = fumeFontPx(false, HERO_WIDTH, 12, 1);
    expect(wide).toBeGreaterThanOrEqual(narrow);
    const short = fumeFontPx(false, HERO_WIDTH, 4, 1);
    const long = fumeFontPx(false, HERO_WIDTH, 40, 1);
    expect(long).toBeLessThanOrEqual(short);
  });
});

/**
 * **用户本轮第 3 条**（「大字幕歌词占比要比普通的少一些」）：大字幕块最多占候选块的 1/3
 * ⇒ 普通 : 大字幕 ≳ 2 : 1。这里钉三件事：不超上限时**一个都不动**、超了只摘「非副歌 + 靠后」的、
 * 以及**至少留一个**（一首歌不该被裁成一个大字都没有）。
 */
describe('capFumeHeroes（用户本轮第 3 条：大字幕是少数）', () => {
  const flagsOf = (total: number, on: readonly number[]): boolean[] =>
    Array.from({ length: total }, (_value, index) => on.includes(index));

  it('不超上限（6 选 2，上限 2）⇒ 原样返回', () => {
    const natural = flagsOf(6, [1, 4]);
    expect(capFumeHeroes(natural, flagsOf(6, [1]), 1 / 3)).toEqual(natural);
  });

  it('超上限：12 行 6 个 hero（上限 floor(12/3) = 4）⇒ 从后往前摘非副歌的，留下 0~3', () => {
    // 副歌是 0/1；自然 hero 是 0~5 ⇒ 先摘 5、4（非副歌、靠后），摘到 4 个正好等于上限就停。
    const capped = capFumeHeroes(flagsOf(12, [0, 1, 2, 3, 4, 5]), flagsOf(12, [0, 1]), 1 / 3);
    expect(capped).toEqual(flagsOf(12, [0, 1, 2, 3]));
    expect(capped.filter((flag) => flag).length).toBeLessThanOrEqual(Math.floor(12 / 3));
  });

  it('全是副歌时也照裁：3 行上限 1 ⇒ 只留最靠前那一行', () => {
    expect(capFumeHeroes(flagsOf(3, [0, 1, 2]), flagsOf(3, [0, 1, 2]), 1 / 3)).toEqual(
      flagsOf(3, [0]),
    );
  });

  it('确定性 / 边界：同一输入两次结果相同；空输入不炸；上限至少为 1', () => {
    const natural = flagsOf(20, [0, 3, 6, 9, 12, 15, 18]);
    const chorus = flagsOf(20, [3, 12]);
    const first = capFumeHeroes(natural, chorus, 1 / 3);
    expect(capFumeHeroes(natural, chorus, 1 / 3)).toEqual(first);
    expect(first.filter((flag) => flag).length).toBe(Math.floor(20 / 3));
    expect(capFumeHeroes([], [], 1 / 3)).toEqual([]);
    // 上限为 0 也至少留一个（`Math.max(1, …)`）——否则「一句都不大字」会在下游被全局回退接管，
    // 那不是「裁」而是「全丢」。
    expect(capFumeHeroes(flagsOf(4, [1, 2]), flagsOf(4, []), 0)).toEqual(flagsOf(4, [1]));
  });
});

/**
 * **用户 m00002 第 1 条**：镜头对准的是「正在唱的那颗字素」，所以「哪一颗正在唱」这件事必须可回归。
 * 纯函数、只吃时间表，不碰 DOM。
 */
describe('fumeFrontGlyphIndex（镜头跟的那颗高亮字）', () => {
  /** 0~200 / 200~400，然后空档 200ms，再 600~800。 */
  const spans = [
    { startMs: 0, endMs: 200 },
    { startMs: 200, endMs: 400 },
    { startMs: 600, endMs: 800 },
  ];

  it('落在某颗的区间里 → 就是它', () => {
    expect(fumeFrontGlyphIndex(spans, 0)).toBe(0);
    expect(fumeFrontGlyphIndex(spans, 199)).toBe(0);
    expect(fumeFrontGlyphIndex(spans, 200)).toBe(1);
    expect(fumeFrontGlyphIndex(spans, 400)).toBe(1);
    expect(fumeFrontGlyphIndex(spans, 700)).toBe(2);
    expect(fumeFrontGlyphIndex(spans, 99999)).toBe(2);
  });

  it('词间空档继续认刚唱完的那颗（不退回句中心、不在空档里弹）', () => {
    expect(fumeFrontGlyphIndex(spans, 401)).toBe(1);
    expect(fumeFrontGlyphIndex(spans, 599)).toBe(1);
  });

  it('还没开唱 → 0（镜头先架在句首等它）；没有字素 → -1', () => {
    expect(fumeFrontGlyphIndex(spans, -50)).toBe(0);
    expect(fumeFrontGlyphIndex([], 100)).toBe(-1);
  });

  it('在一句内单调不回头', () => {
    let previous = -1;
    for (let ms = -10; ms <= 900; ms += 10) {
      const index = fumeFrontGlyphIndex(spans, ms);
      expect(index).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
    expect(previous).toBe(2);
  });
});

/**
 * 第十五轮第 6 条（浮名结尾「缩小画面展示整个歌词」）的两个纯函数。
 * 它们只吃数字 / 尺寸，不碰 DOM —— 也就是「判据」与「缩放值」这两件最容易被写错的事。
 */
describe('fumeOutroPlan', () => {
  it('最后一行还没唱完时不开镜头（判据 = 最后一行 endMs 已过）', () => {
    expect(fumeOutroPlan(999, 1000, 2400, 3000, 1440, 900)).toEqual({
      active: false,
      scale: 1,
      focusFade: 0,
    });
    expect(fumeOutroPlan(0, 1000, 2400, 3000, 1440, 900).active).toBe(false);
  });

  it('正好唱完那一刻开始缩小（边界含等号）', () => {
    const plan = fumeOutroPlan(1000, 1000, 2400, 3000, 1440, 900);
    expect(plan.active).toBe(true);
    expect(plan.scale).toBeLessThan(1);
    // **用户第 6 轮第 1 条**：进镜头这一帧高光还满着（渐散从这一刻起算）。
    expect(plan.focusFade).toBe(0);
  });

  it('没有歌词（末行为 0）时不进结尾镜头', () => {
    expect(fumeOutroPlan(999999, 0, 2400, 3000, 1440, 900)).toEqual({
      active: false,
      scale: 1,
      focusFade: 0,
    });
  });

  it('缩放 = min(视口宽/纸宽, 视口高/纸高) × 0.94', () => {
    // 1440/2400 = 0.6、900/3000 = 0.3 ⇒ 取小的 0.3，再乘 0.94。
    expect(fumeOutroPlan(5000, 1000, 2400, 3000, 1440, 900).scale).toBeCloseTo(0.282, 6);
    // 反过来：宽度先贴满。1600/2400 = 0.667、900/1200 = 0.75 ⇒ 取 0.667 × 0.94。
    expect(fumeOutroPlan(5000, 1000, 2400, 1200, 1600, 900).scale).toBeCloseTo(0.626667, 6);
  });

  it('缩放夹在 [0.16, 1]：极小纸不放大、极长纸不缩到看不见', () => {
    expect(fumeOutroPlan(5000, 1000, 100, 100, 1440, 900).scale).toBe(1);
    expect(fumeOutroPlan(5000, 1000, 100000, 100000, 1440, 900).scale).toBe(0.16);
  });

  it('知道整首时长时：歌词没唱完但只剩 ≤5s 也进镜头（用户 m01402 第 3 条）', () => {
    // 末句 60s 才唱完、整首 61s：58s 处旧判据是 false，新判据（剩 3s）要开镜头。
    const soon = fumeOutroPlan(58000, 60000, 2400, 3000, 1440, 900, 61000);
    expect(soon.active).toBe(true);
    expect(soon.scale).toBeCloseTo(0.282, 6);
    // 同样位置但整首还有 12s ⇒ 不开。
    expect(fumeOutroPlan(58000, 60000, 2400, 3000, 1440, 900, 70000)).toEqual({
      active: false,
      scale: 1,
      focusFade: 0,
    });
    // 不传第 7 个参数（老调用点）＝ 不知道时长 ⇒ 行为与改造前逐字一致。
    expect(fumeOutroPlan(58000, 60000, 2400, 3000, 1440, 900)).toEqual({
      active: false,
      scale: 1,
      focusFade: 0,
    });
  });
});

/**
 * **用户第 6 轮第 1 条**（浮名曲尾高光渐散）的纯函数。
 *
 * 判据三条：没进结尾镜头时恒 0；进镜头那一刻是 0（还满着）；此后单调涨到 1，且**同一首歌的
 * 两条进入路径**（唱完 / 只剩 5s）用的是各自的起点。
 */
describe('fumeOutroFocusFade', () => {
  it('没进结尾镜头（歌词还在唱）时恒为 0', () => {
    expect(fumeOutroFocusFade(1000, 60_000, 61_000)).toBe(0);
    expect(fumeOutroFocusFade(54_000, 60_000, 61_000)).toBe(0);
  });

  it('唱完那一刻是 0，之后按 2.6s 单调涨到 1', () => {
    expect(fumeOutroFocusFade(60_000, 60_000, 61_000)).toBe(0);
    const half = fumeOutroFocusFade(60_000 + 1300, 60_000, 61_000);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    expect(fumeOutroFocusFade(60_000 + 2600, 60_000, 61_000)).toBe(1);
    // 之后一直保持散尽（不会再亮回来）。
    expect(fumeOutroFocusFade(90_000, 60_000, 120_000)).toBe(1);
  });

  it('「只剩 5s」那条路径的起点是 durationMs − 5s（不是 0，也不是唱完那一刻）', () => {
    // 整首 61s、末句 60s 才唱完：56s 正好是 FUME_OUTRO_LEAD_MS 的起点 ⇒ 从 0 开始算。
    expect(fumeOutroFocusFade(56_000, 60_000, 61_000)).toBe(0);
    expect(fumeOutroFocusFade(57_300, 60_000, 61_000)).toBeCloseTo(0.5, 2);
    // 散尽时间早于「唱完」的时刻：到 58.6s 就已经是 1。
    expect(fumeOutroFocusFade(58_600, 60_000, 61_000)).toBe(1);
  });
});

/**
 * 用户 m01402 第 3 条（M4 剩余项之一）：`data-fume-state='outro-soon'` 的判据。
 * 它与 `fumeOutroPlan` 的分工：`soon` 只认「还没唱完、但快到曲尾」，所以「唱完」与「快到点」
 * 在 DOM 上是两个可分辨的态。
 */
describe('fumeOutroSoon', () => {
  it('只剩 ≤5s（含等号）且歌词还没唱完 → true', () => {
    expect(fumeOutroSoon(58000, 60000, 61000)).toBe(true);
    expect(fumeOutroSoon(56000, 60000, 61000)).toBe(true); // 正好差 5000
  });

  it('还差得多、或不知道时长（0 / 负数）→ false', () => {
    expect(fumeOutroSoon(54000, 60000, 61000)).toBe(false);
    expect(fumeOutroSoon(58000, 60000, 0)).toBe(false);
    expect(fumeOutroSoon(58000, 60000, -1)).toBe(false);
  });

  it('歌词已经唱完 / 位置越过曲长 → false（那种情况归 finished）', () => {
    expect(fumeOutroSoon(60000, 60000, 61000)).toBe(false);
    expect(fumeOutroSoon(61001, 60000, 61000)).toBe(false);
  });
});

describe('fumeOutroOffset', () => {
  it('纸比视口小时：整张纸可完全可见，焦点居中就是居中', () => {
    // 视口 1000、纸 500（scale 1）⇒ 允许的位移区间 [0, 500]，焦点在纸中心 250 ⇒ 500 - 250 = 250。
    expect(fumeOutroOffset(250, 500, 1000, 1)).toBe(250);
  });

  it('纸比视口小时：跟随被夹住，纸永远不会出画', () => {
    // 焦点在最左（0）⇒ 想让它在屏幕中心要 500，但夹到 500 ⇒ 纸的右缘正好贴住视口右缘。
    expect(fumeOutroOffset(0, 500, 1000, 1)).toBe(500);
    // 焦点在最右（500）⇒ 想让它在中心要 0 ⇒ 夹到 0 ⇒ 纸贴住视口左缘。
    expect(fumeOutroOffset(500, 500, 1000, 1)).toBe(0);
  });

  it('纸刚好等于视口：唯一解 0（两个方向都贴满）', () => {
    expect(fumeOutroOffset(0, 1000, 1000, 1)).toBe(0);
    expect(fumeOutroOffset(1000, 1000, 1000, 1)).toBe(0);
  });

  it('纸比视口大（正常播放期）时反过来要求盖住视口', () => {
    // 视口 1000、纸 2000 ⇒ 允许区间 [-1000, 0]。
    expect(fumeOutroOffset(1000, 2000, 1000, 1)).toBe(-500);
    expect(fumeOutroOffset(0, 2000, 1000, 1)).toBe(0);
    expect(fumeOutroOffset(2000, 2000, 1000, 1)).toBe(-1000);
  });

  it('缩放参与计算：纸 500 × scale 0.5 = 250 宽', () => {
    // free = 1000 - 250 = 750 ⇒ 区间 [0, 750]；焦点 250 × 0.5 = 125 ⇒ 500 - 125 = 375。
    expect(fumeOutroOffset(250, 500, 1000, 0.5)).toBe(375);
  });
});

/**
 * **用户本轮第 1 条**（浮名：右边等待段要是图 2 那种「浅色」、**唱到它才加深**、唱过再褪回原色）
 * + 用户 m00001（高亮 = 封面那支鲜艳色）+ m00002 第 1 条 / m00380（高亮离开后褪回**原色**）。
 *
 * `buildFumePaint` 是**纯函数**（吃 `--pi-th-*` 解析出来的三个色串，吐几个色串），没有 DOM 也能跑，
 * 于是「浅 / 深两档怎么分」可以变成可回归的断言：
 *  · `hot` 两种底色都取 `accent` —— 亮档不再拿被对比度兜底压成近黑的 `primary`
 *（那正是图 1 里「高亮右边有一段看起来就是原色」的根因）；
 *  · `lead`（等待段远端）= 主题色**往底色里混** ⇒ 比高亮那颗浅/暗一档，但仍是一支「有颜色」的字；
 *  · `pending`（等待段近端 = 起笔色）落在 `lead` 与 `hot` 之间 —— 三支一起构成「浅 → 深」的连续坡。
 * 粉得多粉、深浅好不好看属于视觉观感，不在单测能覆盖的范围里。
 */
describe('buildFumePaint（用户本轮第 1 条：等待段浅色 / 高亮加深 / 唱过褪回原色）', () => {
  const contrast = (a: string, b: string): number => {
    const fa = parseRgb(a);
    const fb = parseRgb(b);
    if (fa === null || fb === null) throw new Error(`解析不出颜色：${a} / ${b}`);
    return contrastRatio(fa, fb);
  };

  /** 中性兜底暗档（`lib/cover-palette.ts` 的 `neutralThemeColors(true)`）。 */
  const DARK = {
    surface: 'rgb(16, 20, 24)',
    primary: 'rgb(232, 238, 246)',
    accent: 'rgb(255, 111, 168)', // 封面推出来的那支粉
  };
  /** 中性兜底亮档（`neutralThemeColors(false)`）。 */
  const LIGHT = {
    surface: 'rgb(242, 245, 250)',
    primary: 'rgb(26, 29, 36)',
    accent: 'rgb(47, 107, 255)',
  };
  const ZERO = { r: 0, g: 0, b: 0 };
  /** 相对亮度（0.2126/0.7152/0.0722 的加权和，和 `types.ts` 同一条口径）。 */
  const luma = (rgb: { r: number; g: number; b: number }): number =>
    0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  /** HSV 的饱和度（远端那支浅色要比高亮那颗「灰」一点）。 */
  const sat = (rgb: { r: number; g: number; b: number }): number => {
    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    return max === 0 ? 0 : (max - min) / max;
  };

  it('暗底：hot = accent（那支粉）；lead 是「主题色混进暗底色」的浅色；pending 夹在两者之间', () => {
    const paint = buildFumePaint(DARK);
    expect(paint.hot).toBe(paint.accent);
    // 用户原话「不应该高亮成原色（白色）」：暗档 primary 就是那支接近白的颜色，高亮必须不是它。
    expect(paint.hot).not.toBe(paint.primary);
    // 等待段（播放头右边那一整段）= 主题色往**底色**里混 ⇒ 比高亮那颗更暗、更灰
    //（图 2 里那支暗橄榄的同一个道理）。
    expect(luma(parseRgb(paint.lead) ?? ZERO)).toBeLessThan(luma(parseRgb(paint.hot) ?? ZERO));
    expect(sat(parseRgb(paint.lead) ?? ZERO)).toBeLessThan(sat(parseRgb(paint.hot) ?? ZERO));
    /*
     * **用户第 5 轮第 1 条**：「右边的歌词部分保持一个**暗淡的颜色**」。
     *
     * `pending` 就是播放头右边那一整段用的那支色（同时是起笔色，所以交界处不跳）。可判定的口径：
     *  1) 比高亮那颗**暗**，但**仍然有色相**（不是洗成灰的中性色 —— 上一版的中性色会让封面透上来）；
     *  2) 与底色的对比度落在「≥2:1 地板、< 高亮那档（≥3:1）」之间 ⇒ 读得清、但绝不抢高亮。
     */
    expect(luma(parseRgb(paint.pending) ?? ZERO)).toBeLessThan(luma(parseRgb(paint.hot) ?? ZERO));
    expect(sat(parseRgb(paint.pending) ?? ZERO)).toBeGreaterThan(0.2);
    const pendingContrast = contrast(paint.pending, DARK.surface);
    expect(pendingContrast).toBeGreaterThanOrEqual(2);
    expect(pendingContrast).toBeLessThan(contrast(paint.hot, DARK.surface));
    expect(paint.pending).not.toBe(paint.hot);
    // **用户 m00002 第 1 条 + m00380**：高亮离开要褪回**原色**。暗档原色 = 常态白，且必须是 `rgb()`
    //（能被 `mixColor` 解析）—— 旧的 `#ffffff` 是 hex，`parseRgb` 认不了，`mixColor` 会原样退回 `hot`，
    // 淡出整段 no-op ⇒ 唱过的字永远停在粉上。
    expect(paint.fadeTo).toBe(paint.ink);
    expect(parseRgb(paint.fadeTo)).toEqual(parseRgb('rgb(255, 255, 255)'));
    // 与「还没唱到」的常态白是同一个色：唱过 / 未唱都回原色，只有当前句才有主题色。
    expect(parseRgb(paint.fadeTo)).not.toEqual(parseRgb(paint.hot));
    // **用户 m00002 第 1 条（第二遍）**：「暗色模式下太亮」压的是**亮度**（`passedDim`），不是色相 ——
    // 暗档 < 1、亮档 = 1（亮底的常态色本来就是墨色，逐位不变）。
    expect(paint.passedDim).toBeGreaterThan(0);
    expect(paint.passedDim).toBeLessThan(1);
    expect(buildFumePaint(LIGHT).passedDim).toBe(1);
  });

  it('亮底：hot 也取 accent（不是被压成近黑的 primary）—— 图 1 里那段「看起来是原色」的等待段就此消失', () => {
    const paint = buildFumePaint(LIGHT);
    expect(paint.hot).toBe(paint.accent);
    // 亮档 primary 会被对比度兜底压成近黑（实测 rgb(44,37,28)），与常态墨色几乎一样 ——
    // 这正是「高亮右边有一部分是原色」的来源，所以高亮色**不许**再取它。
    expect(paint.hot).not.toBe(paint.primary);
    expect(contrast(paint.hot, LIGHT.surface)).toBeGreaterThanOrEqual(3);
    // 亮底上「往底色里混」= 变淡 ⇒ 等待段比高亮那颗**亮**（暗底上反过来是更暗，见上一条）。
    expect(luma(parseRgb(paint.lead) ?? ZERO)).toBeGreaterThan(luma(parseRgb(paint.hot) ?? ZERO));
    expect(luma(parseRgb(paint.pending) ?? ZERO)).toBeGreaterThan(
      luma(parseRgb(paint.hot) ?? ZERO),
    );
    // 「暗淡」在亮底上的同一口径：与底色的对比度**低于**高亮那颗字（第 5 轮判据，两档不拉平）。
    expect(contrast(paint.pending, LIGHT.surface)).toBeLessThan(contrast(paint.hot, LIGHT.surface));
    // 亮档 `fadeTo` 同样是 `ink`：亮底上的原色是**墨色**（不是白），与参考图里高亮左边那半句一致。
    expect(paint.fadeTo).toBe(paint.ink);
    /*
     * **用户第 10 轮第 2 条**（「已唱过的歌词应该是图 1 所示的黑色，不是现在图 2 所示灰色」）：
     * 亮底的 `ink` = **近黑** `rgb(15,15,15)`，对比度 ≥7:1。
     * 旧口径（白往黑推、够 3:1 就停）落在中灰 —— 主人两张裁图逐像素量到的就是
     * 现状 `rgb(135,132,124)`（底 `rgb(203,202,202)`）vs 目标近黑。
     */
    expect(paint.ink).toBe('rgb(15, 15, 15)');
    expect(contrast(paint.ink, LIGHT.surface)).toBeGreaterThanOrEqual(7);
    // 比旧口径那支灰**深得多**：本文件的 `luma` 是 0~255 口径的加权和（旧口径的 3:1 灰 ≈ 135）。
    expect(luma(parseRgb(paint.ink) ?? ZERO)).toBeLessThan(40);
    expect(parseRgb(paint.ink)).not.toBeNull();
    expect(paint.ink).not.toBe('#ffffff');
  });

  it('原色分深浅：**唱过**用深档 `ink`、**还没唱到**用浅档 `waitInk`（同一支色的两个深度）', () => {
    /** 两支原色的 RGB 距离：用户要的是「看得出深浅」，所以不能贴着看不出来。 */
    const gap = (a: string, b: string): number => {
      const x = parseRgb(a);
      const y = parseRgb(b);
      if (x === null || y === null) throw new Error(`解析不出颜色：${a} / ${b}`);
      return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b);
    };
    const dark = buildFumePaint(DARK);
    // 暗底：ink 是纯白（最亮的那一档）⇒ 浅档往暗底色里混，于是 `waitInk` 更暗。
    expect(luma(parseRgb(dark.waitInk) ?? ZERO)).toBeLessThan(luma(parseRgb(dark.ink) ?? ZERO));
    expect(gap(dark.waitInk, dark.ink)).toBeGreaterThanOrEqual(24);
    const light = buildFumePaint(LIGHT);
    // 亮底：ink 是墨色 ⇒ 浅档往亮底色里混，于是 `waitInk` 更浅（= 图里那条更淡的「还没唱到」）。
    expect(luma(parseRgb(light.waitInk) ?? ZERO)).toBeGreaterThan(
      luma(parseRgb(light.ink) ?? ZERO),
    );
    expect(gap(light.waitInk, light.ink)).toBeGreaterThanOrEqual(24);
    // 唱过那一档的**落点**仍然是 `ink`（深档）：colour trail 的终点没有跟着变浅。
    expect(dark.fadeTo).toBe(dark.ink);
    expect(light.fadeTo).toBe(light.ink);
  });

  it('**用户第 11 轮第 2 条**：常态墨色直接吃 `--pi-lyric-ink`（= 流光的黑，不再自己调）', () => {
    // 亮底 + 流光那支近黑：原样使用，不再走「白往黑推到够 3:1」那套（那会得到中灰）。
    const light = buildFumePaint({ ...LIGHT, ink: 'rgb(26, 29, 36)' });
    expect(light.ink).toBe('rgb(26, 29, 36)');
    expect(light.fadeTo).toBe('rgb(26, 29, 36)');
    // 暗底 + 纯白：同样原样使用。
    const dark = buildFumePaint({ ...DARK, ink: 'rgb(255, 255, 255)' });
    expect(dark.ink).toBe('rgb(255, 255, 255)');
    // 拿不到（undefined / 空串 / 解析不出）时退回兜底：亮底近黑、暗底白。
    expect(buildFumePaint(LIGHT).ink).toBe('rgb(15, 15, 15)');
    expect(buildFumePaint(DARK).ink).toBe('rgb(255, 255, 255)');
    expect(buildFumePaint({ ...LIGHT, ink: 'var(--pi-lyric-ink, #fff)' }).ink).toBe(
      'rgb(15, 15, 15)',
    );
  });

  it('拿不到底色（surface 解析失败）时算亮档：ink 是那支近黑（不是白）', () => {
    const paint = buildFumePaint({ ...LIGHT, surface: 'var(--pi-th-surface)' });
    expect(paint.surface).toBeNull();
    // 底色拿不到时 `lead` 退回旧口径（混白），但**高亮色仍然是 accent**（与底色有没有解析无关）。
    expect(paint.hot).toBe(paint.accent);
    expect(luma(parseRgb(paint.lead) ?? ZERO)).toBeGreaterThan(luma(parseRgb(paint.hot) ?? ZERO));
    expect(paint.fadeTo).toBe(paint.ink);
    // **用户第 10 轮第 2 条**：兜底档按亮底算 ⇒ 与「亮底」那支一致（`rgb(15,15,15)`）。
    expect(paint.ink).toBe('rgb(15, 15, 15)');
  });

  it('对比度兜底还在：暗底上读不清的封面色会被推向白，两支都 ≥ 3:1', () => {
    // 深紫对 #101418 只有 ~1.4:1 —— 兜底必须把它推亮，而不是照用。
    const paint = buildFumePaint({ ...DARK, accent: 'rgb(58, 31, 110)' });
    expect(paint.hot).not.toBe('rgb(58, 31, 110)');
    expect(contrast(paint.hot, DARK.surface)).toBeGreaterThanOrEqual(3);
    // 等待段那支暗色**只**兜 2:1（`UNPRINTED_MIN_CONTRAST`）：兜到 3 就与高亮那档拉平了，
    // 用户要的「暗淡 / 高亮」两级就没了。
    expect(contrast(paint.pending, DARK.surface)).toBeGreaterThanOrEqual(2);
    // 亮档同理：`hot`（accent 兜底后的蓝）与 `fadeTo`（常态白经兜底后的墨色）都要满足 3:1。
    const light = buildFumePaint(LIGHT);
    expect(contrast(light.hot, LIGHT.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(light.fadeTo, LIGHT.surface)).toBeGreaterThanOrEqual(3);
  });

  it('句内「已经唱过」的字素落点色 = 常态色（暗档回到白、不是那支粉）—— 用户 m06476 第 2 条 / m00002', () => {
    const dark = buildFumePaint(DARK);
    // p = 1：这颗字唱完的一刻正好落在 `fadeTo`（暗档 = 常态白）。
    expect(parseRgb(fumeTrailColor(DARK.accent, dark, 1))).toEqual(parseRgb(dark.fadeTo));
    // 关键：终点不能是 `pending`（暗档那支粉）—— 那正是用户看到的「句内唱过的部分一直是粉、回不到原色」。
    expect(parseRgb(fumeTrailColor(DARK.accent, dark, 1))).not.toEqual(parseRgb(dark.pending));
    // p = 0：刚从主题高亮色出发，还不是常态色（`TRAIL_MIX_FLOOR = 0.28` 只掺一点点常态色）。
    expect(parseRgb(fumeTrailColor(DARK.accent, dark, 0))).not.toEqual(parseRgb(dark.fadeTo));
    // 两种底色的 `fadeTo` 都是可解析的 `rgb()`：同一个算式在两边都真的在混色（这就是 `fadeTo` 存在的理由）。
    const light = buildFumePaint(LIGHT);
    expect(mixColor('rgb(1, 2, 3)', light.fadeTo, 1)).not.toBe('rgb(1, 2, 3)');
    expect(mixColor('rgb(1, 2, 3)', dark.fadeTo, 1)).not.toBe('rgb(1, 2, 3)');
  });

  it('「还没唱到」那支浅色仍在调色板里（`lead` 由主题色往底色混出来、与高亮那支不同）', () => {
    // **用户本轮第 1 条**：播放头右边改成恒定中性色 `waitInk`，`lead` 已经**没有消费者**，
    // 原来的「浅 → 深」单调坡那条 it 随之删掉（那道渐变被用户点名撤掉了）。
    // 这里只保留「这支色是怎么调出来的」这条记录性断言，免得下一轮又把它当成没实现。
    const dark = buildFumePaint(DARK);
    expect(parseRgb(dark.lead)).not.toBeNull();
    expect(parseRgb(dark.lead)).not.toEqual(parseRgb(dark.hot));
    expect(sat(parseRgb(dark.lead) ?? ZERO)).toBeGreaterThan(0.3);
    const light = buildFumePaint(LIGHT);
    expect(parseRgb(light.lead)).not.toBeNull();
    expect(parseRgb(light.lead)).not.toEqual(parseRgb(light.hot));
  });
});

/**
 * **用户第 9 轮第 1 条**（浮名，原话：「歌词左右两片中间的空白完全可以去掉，让两片歌词挨在一起」）。
 *
 * 老口径 `x = column × (columnWidth + gap)`：块不管多短都占满整栏 ⇒ 短句右侧留一大片死空白
 *（主人截图量到 ≈295 世界 px 宽）。新口径把纸面切成细槽、每块只按自己的真实宽 + 一道净空占槽。
 * 这里的四个不变量与 `packFumeSlots` 的注释一一对应。
 */
describe('packFumeSlots（用户第 9 轮第 1 条：细槽贴紧，去掉栏内空白）', () => {
  /** 典型 4 栏窗口：纸宽 2400、栏宽 588、gap 14 ⇒ 槽宽 49、净空 22（与 `buildFumePlan` 同源）。 */
  const OPTIONS = {
    paperWidth: 2400,
    paperHeight: 2000,
    slotPx: 49,
    gutter: 22,
    pageGapPx: 56,
  };
  const COLUMN_PITCH = 588 + 14;
  const items = (count: number, width: number, height: number): FumePackItem[] =>
    Array.from({ length: count }, () => ({ width, height, gapBefore: 0 }));

  it('短块不再按栏宽占地：第二块贴着第一块落，而不是等下一根柱子', () => {
    const packed = packFumeSlots(items(4, 300, 100), OPTIONS);
    const first = packed[0];
    const second = packed[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    // 贴紧：第二块的左缘 ≤ 第一块右缘 + 净空 + 一个槽的取整浪费
    expect(second.x).toBeLessThanOrEqual(first.x + 300 + 22 + OPTIONS.slotPx);
    // 老口径下它会在 602px 那一根柱子上（588 + 14）——贴着落就不该跑到那里去
    expect(second.x).toBeLessThan(COLUMN_PITCH);
    // 两块的墨迹之间就是那道「净空」（比原来那道 ~295px 的空白小一个数量级）
    expect(second.x - (first.x + 300)).toBeGreaterThanOrEqual(22);
    expect(second.x - (first.x + 300)).toBeLessThan(22 + OPTIONS.slotPx);
  });

  it('不变量①：任意两块不重叠（同一行里紧挨着，不同行里上下相接）', () => {
    const packed = packFumeSlots(
      [...items(6, 420, 120), ...items(4, 180, 90), ...items(3, 900, 160)],
      OPTIONS,
    );
    const all = [...items(6, 420, 120), ...items(4, 180, 90), ...items(3, 900, 160)];
    for (let a = 0; a < packed.length; a += 1) {
      for (let b = a + 1; b < packed.length; b += 1) {
        const left = packed[a];
        const right = packed[b];
        const leftItem = all[a];
        const rightItem = all[b];
        if (left === undefined || right === undefined || leftItem === undefined) continue;
        if (rightItem === undefined) continue;
        if (left.page !== right.page) continue;
        const verticalOverlap =
          Math.min(left.y + leftItem.height, right.y + rightItem.height) -
          Math.max(left.y, right.y);
        const horizontalOverlap =
          Math.min(left.x + leftItem.width, right.x + rightItem.width) - Math.max(left.x, right.x);
        // 要么纵向不相交（相接不算相交：<= 0），要么横向不相交。
        expect(verticalOverlap <= 0 || horizontalOverlap <= 0).toBe(true);
      }
    }
  });

  it('不变量②③：同一行的相邻块至少隔一个净空；同样输入两次结果逐位相同', () => {
    const source = [...items(8, 260, 80), ...items(5, 520, 140)];
    const packed = packFumeSlots(source, OPTIONS);
    const again = packFumeSlots(source, OPTIONS);
    expect(again).toEqual(packed);
    for (let a = 0; a < packed.length; a += 1) {
      for (let b = 0; b < packed.length; b += 1) {
        if (a === b) continue;
        const left = packed[a];
        const right = packed[b];
        const leftItem = source[a];
        const rightItem = source[b];
        if (left === undefined || right === undefined) continue;
        if (leftItem === undefined || rightItem === undefined) continue;
        if (left.page !== right.page || left.x > right.x) continue;
        const verticalOverlap =
          Math.min(left.y + leftItem.height, right.y + rightItem.height) -
          Math.max(left.y, right.y);
        if (verticalOverlap <= 0) continue;
        // 同一行（纵向真的重叠）⇒ 横向必须留出净空
        expect(right.x - (left.x + leftItem.width)).toBeGreaterThanOrEqual(OPTIONS.gutter);
      }
    }
  });

  it('不变量④：每块的槽浪费 < 一个槽宽（盒子不再按栏宽占地）', () => {
    const source = [...items(10, 233, 70), { width: 61, height: 70, gapBefore: 0 }];
    const packed = packFumeSlots(source, OPTIONS);
    for (let index = 0; index < packed.length; index += 1) {
      const slot = packed[index];
      const item = source[index];
      if (slot === undefined || item === undefined) continue;
      const spanWidth = slot.span * OPTIONS.slotPx;
      expect(spanWidth).toBeGreaterThanOrEqual(item.width + OPTIONS.gutter);
      expect(spanWidth - (item.width + OPTIONS.gutter)).toBeLessThan(OPTIONS.slotPx);
    }
  });

  it('放不下就整体再铺一张纸：新页的 y 仍然单调，且页号递增', () => {
    const packed = packFumeSlots(items(40, 400, 300), OPTIONS);
    const pages = packed.map((slot) => slot.page);
    expect(Math.max(...pages)).toBeGreaterThan(0);
    for (let index = 1; index < pages.length; index += 1) {
      const previous = pages[index - 1] ?? 0;
      const current = pages[index] ?? 0;
      expect(current === previous || current === previous + 1).toBe(true);
      expect(packed[index]?.y ?? 0).toBeGreaterThanOrEqual(0);
    }
  });
});
