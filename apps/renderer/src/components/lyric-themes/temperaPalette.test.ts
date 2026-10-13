/**
 * `temperaPalette` 的用例：墨色对比度保证（上游 `temperaPalette.ts:53~67` 的做法）。
 *
 * 期望值都是**手算出来的字面量**，不是把实现的表达式抄一遍 —— 否则测的是"实现和它自己一致"。
 */

import { describe, expect, it } from 'vitest';
import {
  TEMPERA_INK_DARK,
  TEMPERA_INK_LIGHT,
  TEMPERA_MIN_INK_CONTRAST,
  TEMPERA_READABLE_FLOOR,
  resolveTemperaCoverThemeBlend,
  resolveTemperaInkContrast,
  resolveTemperaReadable,
  resolveTemperaToneLadder,
  TEMPERA_TONE_STOPS,
  temperaInkLuminance,
  temperaMatchLuminance,
} from './temperaPalette';
import { resolveTemperaTones } from './temperaFrame';
import { ensureContrast, parseRgb, type RgbColor } from './types';

describe('凝彩墨色对比度保证', () => {
  it('亮度口径是 Rec.709：白 255、黑 0、绿 > 红 > 蓝', () => {
    expect(temperaInkLuminance('rgb(255, 255, 255)')).toBeCloseTo(255, 6);
    expect(temperaInkLuminance('rgb(0, 0, 0)')).toBeCloseTo(0, 6);
    expect(temperaInkLuminance('rgb(0, 255, 0)')).toBeGreaterThan(
      temperaInkLuminance('rgb(255, 0, 0)'),
    );
    expect(temperaInkLuminance('rgb(255, 0, 0)')).toBeGreaterThan(
      temperaInkLuminance('rgb(0, 0, 255)'),
    );
  });

  it('解析不了的颜色按中性 128 处理，且墨色原样返回（不猜）', () => {
    expect(temperaInkLuminance('var(--pi-nope)')).toBeCloseTo(128, 6);
    expect(resolveTemperaInkContrast('rgb(240, 240, 240)', 'var(--pi-nope)')).toBe('var(--pi-nope)');
  });

  it('对比度已达标 ⇒ 原样返回（阈值就是 96）', () => {
    // L(240,240,240) = 240，L(10,10,10) = 10，差 230 ≥ 96。
    expect(resolveTemperaInkContrast('rgb(240, 240, 240)', 'rgb(10, 10, 10)')).toBe('rgb(10, 10, 10)');
    expect(TEMPERA_MIN_INK_CONTRAST).toBe(96);
  });

  it('浅纸浅墨 ⇒ 推到近黑端，并保留 14% 色相（rgb(45,45,45)）', () => {
    // 纸 L=240（亮）⇒ 目标 rgb(20,20,20)；20 + (200-20)*0.14 = 45.2 ⇒ 45；
    // |45 - 240| = 195 ≥ 96 ⇒ 用保留色相的那个。
    expect(resolveTemperaInkContrast('rgb(240, 240, 240)', 'rgb(200, 200, 200)')).toBe('rgb(45, 45, 45)');
  });

  it('暗纸墨色偏亮 ⇒ 推到近白端（并保证达标）', () => {
    // 纸 L=30（<128 ⇒ 按"暗纸"处理 ⇒ 目标近白）；墨 rgb(40,40,40) 与纸几乎同色 ⇒ 必须被拉开。
    const resolved = resolveTemperaInkContrast('rgb(30, 30, 30)', 'rgb(40, 40, 40)');
    expect(temperaInkLuminance(resolved)).toBeGreaterThan(200);
    expect(Math.abs(temperaInkLuminance(resolved) - 30)).toBeGreaterThanOrEqual(TEMPERA_MIN_INK_CONTRAST);
  });

  it('混色仍不达标 ⇒ 退到纯目标色（不保留色相）', () => {
    // 纸 L≈120（<128 ⇒ 按"暗纸"处理 ⇒ 用近白端）；
    // 目标 rgb(244,244,242) 与墨 rgb(40,40,40) 混 14% ⇒ L≈214.93，|214.93-120| = 94.93 < 96 ⇒ 退纯目标色。
    expect(resolveTemperaInkContrast('rgb(120, 120, 120)', 'rgb(40, 40, 40)')).toBe(TEMPERA_INK_LIGHT);
  });

  it('两个端点的常量就是上游写的那两个值（用 rgb() 形式表达）', () => {
    expect(TEMPERA_INK_LIGHT).toBe('rgb(244, 244, 242)');
    expect(TEMPERA_INK_DARK).toBe('rgb(20, 20, 20)');
  });
});

describe('凝彩亮度对齐（加色相不许打乱色阶顺序）', () => {
  it('同色相缩放：L=120 拉到 L=60 ⇒ 通道各减半', () => {
    // gain = 60 / 120 = 0.5 ⇒ rgb(60,60,60)，误差 0 ≤ 1.5 ⇒ 采纳。
    expect(temperaMatchLuminance('rgb(120, 120, 120)', 'rgb(60, 60, 60)')).toBe('rgb(60, 60, 60)');
  });

  it('原色亮度为 0 ⇒ 拉不回来，直接回退目标色', () => {
    expect(temperaMatchLuminance('rgb(0, 0, 0)', 'rgb(60, 60, 60)')).toBe('rgb(60, 60, 60)');
  });

  it('通道被 255 夹住导致对不上 ⇒ 放弃着色，回退目标色', () => {
    // rgb(255,40,40) 的 L≈85.71，目标 L=200 ⇒ gain≈2.333；r 被夹到 255 ⇒
    // 结果 rgb(255,93,93) 的 L≈127.44，与 200 差 72.6 > 1.5 ⇒ 回退。
    expect(temperaMatchLuminance('rgb(255, 40, 40)', 'rgb(200, 200, 200)')).toBe('rgb(200, 200, 200)');
  });

  it('解析不了 ⇒ 回退目标色（不猜）', () => {
    expect(temperaMatchLuminance('var(--pi-nope)', 'rgb(60, 60, 60)')).toBe('rgb(60, 60, 60)');
    expect(temperaMatchLuminance('rgb(120, 120, 120)', 'var(--pi-nope)')).toBe('var(--pi-nope)');
  });
});

describe('凝彩可读性底线（封面来的颜色只推离纸色，不拉上色阶）', () => {
  it('底线是 88（与墨色的 96 是两级阈值）', () => {
    expect(TEMPERA_READABLE_FLOOR).toBe(88);
  });

  it('已经够远 ⇒ 原样返回', () => {
    // 纸 L=240，色 L=40 ⇒ 差 200 ≥ 88。
    expect(resolveTemperaReadable('rgb(240, 240, 240)', 'rgb(40, 40, 40)')).toBe('rgb(40, 40, 40)');
  });

  it('太接近纸色 ⇒ 朝远离方向推，推到第一个达标值就停', () => {
    // 纸 L=240（**亮**）⇒ `paperLuminance < 128` 不成立 ⇒ 远离方向是**近黑** `rgb(16,16,16)`
    //（"远离纸色"= 往纸的反方向走，亮纸就该往暗里推；我第一遍把方向写反了，靠手算抓回来）。
    // 色 rgb(200,200,200) L=200，与纸差 40 < 88；
    // 第 1 步（0.16）：200 + (16−200)×0.16 = 170.56 ⇒ 171；差 |171−240| = 69 < 88 ⇒ 继续；
    // 第 2 步（0.32）：200 − 58.88 = 141.12 ⇒ 141；差 99 ≥ 88 ⇒ **返回这一步**。
    expect(resolveTemperaReadable('rgb(240, 240, 240)', 'rgb(200, 200, 200)')).toBe('rgb(141, 141, 141)');
  });

  it('暗纸同理：朝近白端推（方向由纸的亮度决定）', () => {
    // 纸 L=30（暗）⇒ 远离方向是近白 rgb(255,255,255)；
    // 色 rgb(20,20,20) L=20，差 10 < 88；第 1 步：20 + 235×0.16 = 57.6 ⇒ 58；差 28 < 88；
    // 第 2 步：20 + 235×0.32 = 95.2 ⇒ 95；差 65 < 88；第 3 步：20 + 235×0.48 = 132.8 ⇒ 133；差 103 ≥ 88 ⇒ 返回。
    expect(resolveTemperaReadable('rgb(30, 30, 30)', 'rgb(20, 20, 20)')).toBe('rgb(133, 133, 133)');
  });

  it('解析不了 ⇒ 原样返回（不猜）', () => {
    expect(resolveTemperaReadable('rgb(240, 240, 240)', 'var(--pi-nope)')).toBe('var(--pi-nope)');
  });
});

describe('凝彩封面取色与主题色相混合（0.32）', () => {
  it('只取前 4 个封面色，主题色相循环取用（手算）', () => {
    // i=0：rgb(200,0,0) 混 rgb(0,0,200)@0.32 ⇒ r 200-64=136、g 0、b 0+64=64 ⇒ rgb(136, 0, 64)
    // i=1：rgb(0,200,0) 混 themeHues[1 % 1 = 0] 同一个 ⇒ g 200-64=136、b 64 ⇒ rgb(0, 136, 64)
    expect(
      resolveTemperaCoverThemeBlend(['rgb(200, 0, 0)', 'rgb(0, 200, 0)'], ['rgb(0, 0, 200)']),
    ).toEqual(['rgb(136, 0, 64)', 'rgb(0, 136, 64)']);
  });

  it('封面色多于 4 个 ⇒ 多余的被丢掉（上游 slice(0, 4)）', () => {
    const five = ['rgb(10, 10, 10)', 'rgb(20, 20, 20)', 'rgb(30, 30, 30)', 'rgb(40, 40, 40)', 'rgb(50, 50, 50)'];
    expect(resolveTemperaCoverThemeBlend(five, ['rgb(0, 0, 0)'])).toHaveLength(4);
  });

  it('主题色相为空 ⇒ 原样返回封面色（我们的显式早退，已在上游差异注释里备查）', () => {
    const cover = ['rgb(200, 0, 0)', 'rgb(0, 200, 0)'];
    expect(resolveTemperaCoverThemeBlend(cover, [])).toEqual(cover);
  });

  it('解析不了的项原样保留（不猜）', () => {
    expect(
      resolveTemperaCoverThemeBlend(['var(--pi-nope)'], ['rgb(0, 0, 200)']),
    ).toEqual(['var(--pi-nope)']);
  });
});

describe('浅底场景的集成保证（替代拿不到的"亮档截图"）', () => {
  it('浅纸 + 浅主色：接线后墨色被推到近黑端，且亮度差达到 96 的下限', () => {
    /*
     * 为什么写这条：`PI_SMOKE_*` 里**没有切亮/暗档的开关**（只有 `PI_SMOKE_UI_STYLE` 排版风格、
     * `PI_SMOKE_SET_THEME` 钉主题），所以"浅底是否真被救回"没法靠截图取证。
     * 而这条规则本质是**数值保证** ⇒ 用测试断言反而更直接：给出与纸色几乎同亮的浅主色，
     * 要求接线后的墨色满足 `|L(墨) − L(纸)| ≥ 96`。
     */
    const palePaper = 'rgb(244, 244, 242)'; // L ≈ 243.86
    const palePrimary = 'rgb(230, 230, 228)'; // L ≈ 229.86，与纸差 14 ⇒ 远低于 96

    const ink = resolveTemperaInkContrast(palePaper, palePrimary);

    /*
     * 期望值为什么是 `rgb(49,49,49)` 而不是纯近黑 `rgb(20,20,20)`：
     * 纸亮 ⇒ 目标 `rgb(20,20,20)`，先按 14% 把浅主色混进去：
     * r = 20 + (230−20)×0.14 = 49.4 ⇒ 49（g/b 同理，b: 20 + (228−20)×0.14 = 49.12 ⇒ 49）。
     * 这个"保色相"的候选**本身已达标**（|49 − 243.86| = 194.86 ≥ 96）⇒ 就走这条，纯兜底用不上。
     * —— 我第一遍直接把期望写成纯近黑，**是被这条红测试纠正的**：期望值仍得手算到底。
     */
    expect(ink).toBe('rgb(49, 49, 49)');
    expect(Math.abs(temperaInkLuminance(ink) - temperaInkLuminance(palePaper))).toBeGreaterThanOrEqual(
      TEMPERA_MIN_INK_CONTRAST,
    );
  });

  it('浅底场景下色阶仍是四档（结构不被破坏）', () => {
    const palePaper = 'rgb(244, 244, 242)';
    const ink = resolveTemperaInkContrast(palePaper, 'rgb(230, 230, 228)');
    const tones = resolveTemperaTones(palePaper, ink, 'rgb(120, 160, 200)');
    expect(tones.tone).toHaveLength(4);
    expect(tones.paper).toBe(palePaper);
    expect(tones.deep).toBe(ink);
  });
});

describe('两道对比度守卫的关系（第 262 轮的手算 → 断言）', () => {
  it('主题侧的"对比度比 ≥ 3"那道已经比"亮度差 96"更严 ⇒ 帧层那道在浅底场景下空转', () => {
    /*
     * 我方链路：`TemperaTheme` 先用 `ensureContrast(primary, paper, 3)`（WCAG 比值）算 `deep`，
     * 再进帧层；帧层第 250 轮起又加了上游的 `ensureInkContrast`（亮度差 ≥ 96）。
     * 这条断言把"谁更严"钉住：主题侧出的 `deep` 已经满足 |ΔL| ≥ 96，
     * 因此帧层那道**再跑一次结果不变**（即空转）。
     */
    const paper = 'rgb(244, 244, 242)';
    const paperRgb = parseRgb(paper) as RgbColor;
    const primaryRgb = parseRgb('rgb(230, 230, 228)') as RgbColor;

    const deepFromTheme = ensureContrast(primaryRgb, paperRgb, 3);
    const paperLuminance = temperaInkLuminance(paper);
    const deepLuminance = temperaInkLuminance(deepFromTheme);

    // ① 主题侧那道已经把墨色拉开到 ≥ 96（否则这条断言本身就说明假设错了）。
    expect(Math.abs(deepLuminance - paperLuminance)).toBeGreaterThanOrEqual(TEMPERA_MIN_INK_CONTRAST);
    // ② 于是帧层那道不动它 —— 这就是"空转"的可复跑证据。
    expect(resolveTemperaInkContrast(paper, deepFromTheme)).toBe(deepFromTheme);
  });

  it('只有主题侧那道不生效时（直接给浅墨），帧层那道才真的会动手', () => {
    const paper = 'rgb(244, 244, 242)';
    // 跳过主题侧守卫，直接把"浅墨"喂给帧层 ⇒ 这次它必须动手。
    expect(resolveTemperaInkContrast(paper, 'rgb(230, 230, 228)')).not.toBe('rgb(230, 230, 228)');
  });
});

describe('凝彩带 tint 色阶（上游 duo 档的做法）', () => {
  const paper = 'rgb(240, 240, 240)';
  const ink = 'rgb(16, 16, 16)';

  it('停靠点就是上游那四个数', () => {
    expect([...TEMPERA_TONE_STOPS]).toEqual([0.12, 0.3, 0.52, 0.72]);
  });

  it('不传 tint ⇒ 纯中性阶梯（与我们此前行为一致）', () => {
    const ladder = resolveTemperaToneLadder(paper, ink);
    expect(ladder).toHaveLength(4);
    ladder.forEach((tone) => {
      // 中性色 ⇒ 三通道相等。
      const channels = parseRgb(tone) as RgbColor;
      expect(channels.r).toBe(channels.g);
      expect(channels.g).toBe(channels.b);
    });
  });

  it('掺色后**亮度不变**（这就是 matchLuminance 的职责：色相只改彩度）', () => {
    /*
     * ⚠ 这里必须用**淡一点的色相**：若用饱和红（`rgb(220,40,40)`），掺进去后拉回亮度时
     * 红通道会被 255 夹住、误差 > 1.5 ⇒ `matchLuminance` 按上游规则**回退成中性档**，
     * 于是"掺色"看起来没发生。我第一遍就是这么写的，**被这条红测试纠正**：
     * 期望值必须连"什么时候会回退"一起算进去。
     */
    const plain = resolveTemperaToneLadder(paper, ink);
    const tinted = resolveTemperaToneLadder(paper, ink, 'rgb(180, 170, 150)', 'rgb(150, 170, 190)');
    for (const [index, tone] of tinted.entries()) {
      // 严格索引访问：`plain[index]` 的类型是 `string | undefined`，先取出再判空。
      const plainTone = plain[index];
      if (plainTone === undefined) continue;
      expect(temperaInkLuminance(tone)).toBeCloseTo(temperaInkLuminance(plainTone), 0);
    }
    // 但确实掺进去了（不然这条测试等于没测）。
    expect(tinted[0]).not.toBe(plain[0]);
    expect(tinted[1]).not.toBe(plain[1]);
  });

  it('饱和色相会被裁剪守卫丢掉（回退中性档）—— 这是上游 matchLuminance 的既定行为', () => {
    const plain = resolveTemperaToneLadder(paper, ink);
    const saturated = resolveTemperaToneLadder(paper, ink, 'rgb(220, 40, 40)', 'rgb(40, 90, 220)');
    // 第 0 档在饱和红下会被夹住 ⇒ 回退成中性档（与不掺色时一致）。
    expect(saturated[0]).toBe(plain[0]);
  });

  it('tone4 一律不掺色（上游 `step(3)` 就没传 tint）', () => {
    const plain = resolveTemperaToneLadder(paper, ink);
    const tinted = resolveTemperaToneLadder(paper, ink, 'rgb(220, 40, 40)', 'rgb(40, 90, 220)');
    expect(tinted[3]).toBe(plain[3]);
  });

  it('tone1/tone3 取 tintA、tone2 取 tintB（两个色相的来源必须分得开）', () => {
    /*
     * 这是接线前的语义基线：上游 `duo` 档传
     * `(paper, ink, theme.accentColor, theme.secondaryColor)` ⇒
     * **tone1/tone3 偏 accent 的色相、tone2 偏 secondary 的色相**。
     * 这里用"暖/冷"两个淡色相来断言这个分工；等第 267 轮那份接线清单落地后，这条就是回归网。
     */
    const tintA = 'rgb(180, 170, 150)'; // 暖（蓝 < 红）
    const tintB = 'rgb(150, 170, 190)'; // 冷（蓝 > 红）
    const ladder = resolveTemperaToneLadder(paper, ink, tintA, tintB);
    const tone1 = parseRgb(ladder[0]) as RgbColor;
    const tone2 = parseRgb(ladder[1]) as RgbColor;
    const tone3 = parseRgb(ladder[2]) as RgbColor;

    expect(tone1.b).toBeLessThan(tone1.r); // tone1 暖 ⇒ 跟 tintA
    expect(tone3.b).toBeLessThan(tone3.r); // tone3 暖 ⇒ 跟 tintA
    expect(tone2.b).toBeGreaterThan(tone2.r); // tone2 冷 ⇒ 跟 tintB
  });
});
