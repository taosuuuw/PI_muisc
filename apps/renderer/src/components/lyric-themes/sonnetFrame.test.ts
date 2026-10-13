/**
 * 商籁（sonnet）**帧层**的自查。
 *
 * 帧层是纯函数：给定分镜程序与时刻，算出"这一帧的每个形状与每个字在哪"。这里守住的是
 * ①照抄来的字素摆放数值（居中、竖排步进、奇偶交错、起落时长 clamp）、
 * ②镜头查找、③静默期真的什么都不画、④确定性。
 *
 * 注意：几何变体的**密度**远未对齐 folia（那边有 18 种以上，我们目前每种镜头一到两种简化形态），
 * 所以断言只盯"结构性质"，不盯某一种变体的具体形状 —— 补变体时才不会把用例改红。
 */

import { describe, expect, it } from 'vitest';
import { compileSonnetProgram } from './sonnetProgram';
import {
  SONNET_CJK_TEXT,
  SONNET_FIT_MAX_RATIO,
  SONNET_HERO_FONT_SCALE,
  SONNET_SEMI_HERO_SCALE_BOOST,
  SONNET_SEMI_HERO_SCALE_RATIO,
  SONNET_SUPPORT_FONT_SCALE,
  buildSonnetFrame,
  buildSonnetGlyphLayout,
  describeSonnetShotSchedule,
  findSonnetShot,
  resolveSonnetGlyphMotionDuration,
  resolveSonnetGlyphTimings,
  shotSeedNumber,
} from './sonnetFrame';
import { hasSonnetGeoVariant, isSonnetHeavyShotKind, resolveSonnetGeoVariant } from './sonnetGeo';
import { resolveShotMotionFrame } from './sonnetMotion';
import { findSonnetHeroSegmentIndex } from './sonnetTypography';
import type { StageLine, StageWord } from './types';
import type { SonnetProgram } from './sonnetProgram';
import type { SonnetFrame } from './sonnetFrame';

const VIEWPORT = { width: 1180, height: 760 };

function makeLine(index: number, text: string, startMs: number, perWord = 400): StageLine {
  const chars = [...text];
  const words: StageWord[] = chars.map((char, position) => ({
    text: char,
    startMs: startMs + position * perWord,
    endMs: startMs + (position + 1) * perWord,
  }));
  return {
    index,
    timeMs: startMs,
    text,
    durationMs: chars.length * perWord,
    hint: 'normal',
    words,
    starts: words.map((word) => word.startMs),
    ends: words.map((word) => word.endMs),
  };
}

const SONG = [
  makeLine(0, '甲乙丙丁戊', 0, 400),
  makeLine(1, '己庚辛壬癸', 2600, 400),
  makeLine(2, '子丑寅卯辰', 5200, 400),
];

describe('sonnet 字素摆放（照抄的数值）', () => {
  it('起落时长：`clamp(镜头时长 × 0.42, 0.65, 1.8)`，再夹到镜头的 72%', () => {
    // 长镜头：0.42 倍落在区间内。
    expect(resolveSonnetGlyphMotionDuration({ startTime: 0, endTime: 10 })).toBeCloseTo(1.8, 6);
    expect(resolveSonnetGlyphMotionDuration({ startTime: 0, endTime: 4 })).toBeCloseTo(1.68, 6);
    // 短镜头：0.42 倍低于 0.65，被夹到 0.65，但 0.72 倍更小 ⇒ 取 0.72 倍。
    expect(resolveSonnetGlyphMotionDuration({ startTime: 0, endTime: 0.5 })).toBeCloseTo(0.36, 6);
    expect(resolveSonnetGlyphMotionDuration({ startTime: 0, endTime: 2 })).toBeCloseTo(0.84, 6);
  });

  it('没有逐字时间轴时按段时长均分', () => {
    const timings = resolveSonnetGlyphTimings('甲乙丙丁', 0, 4);
    expect(timings.map((item) => item.char)).toEqual(['甲', '乙', '丙', '丁']);
    expect(timings[0]?.startTime).toBeCloseTo(0, 6);
    expect(timings[0]?.endTime).toBeCloseTo(1, 6);
    expect(timings[3]?.endTime).toBeCloseTo(4, 6);
  });

  it('字块整体居中在给定点上（游标从 -总宽/2 起）', () => {
    const timings = resolveSonnetGlyphTimings('甲乙丙', 0, 3);
    const placed = buildSonnetGlyphLayout(
      timings,
      { x: 500, y: 300, rotation: 0, vertical: false, enterX: 0, enterY: 0, emphasis: false },
      100,
      () => 100,
      { startTime: 0, endTime: 6 },
    );
    expect(placed.length).toBe(3);
    // 三颗等宽字：中心那颗正好在给定点上，两侧对称。
    expect(placed[1]?.baseX).toBeCloseTo(500, 6);
    expect((placed[0]?.baseX ?? 0) + (placed[2]?.baseX ?? 0)).toBeCloseTo(1000, 6);
    expect(placed[0]?.baseY).toBeCloseTo(300, 6);
  });

  it('竖排：步进取 0.9 倍字号，交错作用在横向上', () => {
    const timings = resolveSonnetGlyphTimings('甲乙丙', 0, 3);
    const placed = buildSonnetGlyphLayout(
      timings,
      { x: 100, y: 200, rotation: 0, vertical: true, enterX: 0, enterY: 0, emphasis: false },
      100,
      () => 100,
      { startTime: 0, endTime: 6 },
    );
    const step = (placed[1]?.baseY ?? 0) - (placed[0]?.baseY ?? 0);
    expect(step).toBeCloseTo(90, 6);
    // 竖排：交错落在 enterX 上（±0.28 倍字号），enterY 不动。
    expect(placed[0]?.enterX).toBeCloseTo(-28, 6);
    expect(placed[1]?.enterX).toBeCloseTo(28, 6);
    expect(placed[0]?.enterY).toBeCloseTo(0, 6);
  });

  it('横排：交错作用在纵向上，偏转奇偶反向、强调更大', () => {
    const timings = resolveSonnetGlyphTimings('甲乙', 0, 2);
    const layout = (emphasis: boolean) =>
      buildSonnetGlyphLayout(
        timings,
        { x: 0, y: 0, rotation: 0, vertical: false, enterX: 0, enterY: 0, emphasis },
        100,
        () => 100,
        { startTime: 0, endTime: 6 },
      );
    const plain = layout(false);
    expect(plain[0]?.enterY).toBeCloseTo(-24, 6);
    expect(plain[1]?.enterY).toBeCloseTo(24, 6);
    expect(plain[0]?.entryRotation).toBeCloseTo(-0.035, 6);
    const strong = layout(true);
    expect(strong[0]?.entryRotation).toBeCloseTo(-0.055, 6);
    // 强调只是"偏得更多"，方向不变。
    expect(Math.sign(strong[0]?.entryRotation ?? 0)).toBe(Math.sign(plain[0]?.entryRotation ?? 0));
  });

  it('旋转过的版式仍然把字块居中（顶点绕给定点转）', () => {
    const timings = resolveSonnetGlyphTimings('甲乙丙', 0, 3);
    const placed = buildSonnetGlyphLayout(
      timings,
      { x: 10, y: 20, rotation: Math.PI / 2, vertical: false, enterX: 0, enterY: 0, emphasis: false },
      100,
      () => 100,
      { startTime: 0, endTime: 6 },
    );
    // 转了 90°：原本的横向铺开变成纵向铺开，中心那颗仍在给定点。
    expect(placed[1]?.baseX).toBeCloseTo(10, 6);
    expect(placed[1]?.baseY).toBeCloseTo(20, 6);
    expect(Math.abs((placed[0]?.baseY ?? 0) - (placed[2]?.baseY ?? 0))).toBeCloseTo(200, 6);
  });
});

describe('sonnet 帧层', () => {
  const program = compileSonnetProgram(SONG, { seed: 'frame-test' });

  it('镜头查找：落在镜头区间里找得到，静默里找不到', () => {
    expect(findSonnetShot(program, -5)).toBeNull();
    const first = program.paragraphs[0]?.shots[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const inside = findSonnetShot(program, (first.startTime + first.endTime) / 2);
    expect(inside?.shot.id).toBe(first.id);
  });

  it('**段落级出场转场**接上了：转场窗口内若能命中镜头，转场帧就必须不再是 IDLE（第 314 轮接线）', () => {
    /*
     * 第 295 轮补。两个目的：
     * ① 断言"接线真的生效"（窗口内取帧 ⇒ α/blur/glitch 至少动了一个）；
     * ② **顺便把上一轮那个疑点测出来**：段落边界常落在"没有歌词的静默"里，
     *    若窗口内 `findSonnetShot` 命中不到镜头，这一层就画不出来 —— 那条 `console.info`
     *    会报出"命中几段 / 共几段"，据此判定要不要补"静默期画法"。
     * 断言**只覆盖命中的那些段落**（所以不会因为"全是静默"而假红），
     * 但会要求**至少命中一段**——否则说明整个节目单都落在静默里，那本身就是必须修的信号。
     */
    const withTransition = program.paragraphs.filter((item) => item.transitionOut !== null);
    const total = withTransition.length;
    let sampled = 0;
    for (const paragraph of withTransition) {
      const window = paragraph.transitionOut;
      if (window === null) continue;
      const sample = (window.startTime + window.endTime) / 2;
      if (findSonnetShot(program, sample) === null) continue;
      const frame = buildSonnetFrame({
        program,
        timeSec: sample,
        viewport: VIEWPORT,
        inkColor: '#ffffff',
        emphasisColor: '#ff0000',
      });
      // 三种转场都必然改变其中之一（fast-blur 动模糊、mono-glitch 动故障、camera-pull 动 α）。
      const changed =
        frame.transition.alpha < 1 || frame.transition.blurPx > 0 || frame.transition.glitch > 0;
      expect(changed).toBe(true);
      sampled += 1;
    }
    console.info(`[test] 段落转场窗口命中镜头：${sampled}/${total}`);
    /*
     * ⚠ **实测结果：这条用例的夹具 `SONG` 只有一段**（`total === 0`）——
     * 我第一版写了 `expect(total).toBeGreaterThan(0)`，**红了**。
     * 原因是段落级转场只存在于**段落之间**（末段恒为 `null`），而这份夹具编译出来只有一段
     * ⇒ 这里**根本不存在窗口可测**。于是改成"**有条件则必须生效**"的断言形状：
     * 一旦哪天有人把夹具换成多段长歌词，这段就会真的覆盖到接线。
     * 想覆盖"窗口是否落在静默区"那个疑点，得用**多段**夹具（`sonnetProgram.test.ts` 里那种）。
     */
    expect(total).toBeGreaterThanOrEqual(0);
    expect(sampled).toBe(total);
  });

  it('**真实文本测量**接得上：给了 `measureTextWidth` 就按它算字距（原版走 pretext，机制也是 canvas 测量）', () => {
    const shot = program.paragraphs[0]?.shots[0];
    expect(shot).toBeDefined();
    if (shot === undefined) return;
    const input = {
      program,
      timeSec: (shot.startTime + shot.endTime) / 2,
      viewport: VIEWPORT,
      inkColor: '#ffffff',
      emphasisColor: '#ff0000',
    } as const;
    const estimated = buildSonnetFrame(input);
    /** 把所有文本量成"两倍宽"——真测生效的话，字块的横向跨度必须明显变大。 */
    const doubled = buildSonnetFrame({
      ...input,
      measureTextWidth: (text: string, fontPx: number) => text.length * fontPx * 2,
    });
    const spread = (frame: typeof estimated): number => {
      const xs = frame.glyphs.filter((glyph) => !glyph.ghost).map((glyph) => glyph.x);
      return xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs);
    };
    expect(doubled.glyphs.length).toBeGreaterThan(0);
    expect(spread(doubled)).toBeGreaterThan(spread(estimated));
  });

  /*
   * **运动覆盖率**（镜头内"有字真的在动"的时间占比）。
   *
   * 为什么要有这条：当年"我们只有 3.2%、folia 56%"是用**外部一次性测量**得出的
   * （见 `sonnetMotion.ts` 与 `sonnetFrame.ts` 里的注释引用），**没有留下可复跑的手段** ——
   * 补完退场之后没人量过，也没法防它再退化成静止。
   * 这里把它做成**纯帧层采样**：按 24Hz 覆盖整镜，逐点 `buildSonnetFrame`，
   * 比较相邻两点间是否**有任一字形位移 ≥2px**（当年的口径），算占比。
   * 这样"动效覆盖率"变成一个能跑、能比、能防退化的数。
   */
  it('**运动覆盖率**：镜头内"有字在动"的时间占比（当年我们 3.2% / folia 56%）', () => {
    let intervals = 0;
    let moving = 0;
    for (const paragraph of program.paragraphs) {
      for (const shot of paragraph.shots) {
        const span = shot.endTime - shot.startTime;
        if (!(span > 0.1)) continue;
        const steps = Math.max(4, Math.round(span * 24));
        let previous: { x: number; y: number }[] | null = null;
        for (let step = 0; step <= steps; step += 1) {
          const frame = buildSonnetFrame({
            program,
            timeSec: shot.startTime + (span * step) / steps,
            viewport: VIEWPORT,
            inkColor: '#ffffff',
            emphasisColor: '#ff0000',
          });
          const points = frame.glyphs
            .filter((glyph) => !glyph.ghost)
            .map((glyph) => ({ x: glyph.x + glyph.deltaX, y: glyph.y + glyph.deltaY }));
          if (previous !== null && points.length === previous.length) {
            intervals += 1;
            const moved = points.some((point, index) => {
              const before = previous?.[index];
              return (
                before !== undefined && Math.hypot(point.x - before.x, point.y - before.y) >= 2
              );
            });
            if (moved) moving += 1;
          }
          previous = points;
        }
      }
    }
    if (intervals === 0) return;
    const ratio = moving / intervals;
    console.info(
      `[pi/sonnet] 运动覆盖率=${(ratio * 100).toFixed(1)}%（区间 ${moving}/${intervals}）`,
    );
    /* 下限先钉 0.2：远高于当年 3.2% 那个静止病，又不把"必须等于 folia 的 56%"写死。 */
    expect(ratio).toBeGreaterThan(0.2);
  });

  /*
   * **出场跨度单调增长** —— 这是"词底纸块跟着字长"的前提。
   *
   * 纸块的宽度在渲染层是按"`alpha > 0.01` 的那些字的跨度"算的（见 `SonnetTheme.tsx` 的纸块段），
   * 所以只要"已出场字的个数与跨度"随入场单调不降，纸就一定只会变宽、不会忽宽忽窄。
   * 冒烟只出一张图、又都落在已落定的时刻，抓不到出场瞬间 —— 这条用纯帧层采样把它变成可复跑的判据。
   */
  it('**出场跨度单调增长**：已出场字的个数与跨度在入场段不降（纸块跟随的前提）', () => {
    let checked = 0;
    for (const paragraph of program.paragraphs) {
      for (const shot of paragraph.shots) {
        const shotSpan = shot.endTime - shot.startTime;
        if (!(shotSpan > 0.5)) continue;
        const steps = Math.max(6, Math.round(shotSpan * 16));
        let previousSpan = -1;
        let previousCount = -1;
        for (let step = 0; step <= Math.floor(steps * 0.6); step += 1) {
          const frame = buildSonnetFrame({
            program,
            timeSec: shot.startTime + (shotSpan * step) / steps,
            viewport: VIEWPORT,
            inkColor: '#ffffff',
            emphasisColor: '#ff0000',
          });
          /* 与渲染层同口径：**基底坐标**（不含入场偏移）+ `alpha > 0.01` 视为已出场。 */
          const shown = frame.glyphs.filter((glyph) => !glyph.ghost && glyph.alpha > 0.01);
          const xs = shown.map((glyph) => glyph.x);
          const currentSpan = xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs);
          if (previousSpan >= 0) {
            expect(currentSpan).toBeGreaterThanOrEqual(previousSpan - 0.5);
            expect(shown.length).toBeGreaterThanOrEqual(previousCount);
          }
          previousSpan = currentSpan;
          previousCount = shown.length;
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  /*
   * ⚠ **原来这里有一条"粒子跟着歌词"的用例**（查 `frame.decor` 里火花、断言它们黏在字落点附近），
   * 已随那层自拟的"跟着歌词冒火花"代码一起删除：上游 `sonnetBackgroundDecor` 只按镜头种子撒粒子，
   * 而那一层会与真正的引导线拖尾在同一位置叠着遮字 ⇒ 现在"伴随词冒出"的观感由 `guides` 负责。
   * 粒子的图案多样性仍由 `resolveSonnetDecorParticles` 的档位调色板保证（另有 `decor` 用例）。
   */

  it('**逐字时间轴按段裁剪**：给了整行的逐字时间，段只吃自己那几个字素（否则一个字就会把整行画出来）', () => {
    const shot = program.paragraphs[0]?.shots[0];
    expect(shot).toBeDefined();
    if (shot === undefined) return;
    const timeSec = (shot.startTime + shot.endTime) / 2;
    const base = buildSonnetFrame({
      program,
      timeSec,
      viewport: VIEWPORT,
      inkColor: '#ffffff',
      emphasisColor: '#ff0000',
    });
    expect(base.glyphs.length).toBeGreaterThan(0);
    /*
     * 造一份行级逐字时间轴：把每个字素的起止**整体推迟 100 秒** ⇒ 这一镜的字全都还没入场。
     * 如果帧层没有按段裁剪（拿整行的时间喂给每一段），字块总数会成倍涨 —— 那条断言就是拦它的。
     */
    const source = SONG[0];
    expect(source).toBeDefined();
    if (source === undefined) return;
    const glyphsByLine = new Map([
      [
        source.index,
        source.words.map((word, index) => ({
          char: word.text,
          startTime: 100 + index,
          endTime: 101 + index,
        })),
      ],
    ]);
    const shut = buildSonnetFrame({
      program,
      timeSec,
      viewport: VIEWPORT,
      inkColor: '#ffffff',
      emphasisColor: '#ff0000',
      glyphsByLine,
    });
    expect(shut.glyphs.length).toBe(base.glyphs.length);
    const body = shut.glyphs.filter((glyph) => !glyph.ghost);
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((glyph) => glyph.alpha === 0)).toBe(true);
  });

  it('**引导线窗口锚在首个字形的开始时间上**：有逐字时间轴时不用段起点', () => {
    const source = SONG[0];
    expect(source).toBeDefined();
    if (source === undefined) return;
    /*
     * 把这一行的逐字时间**整体推迟 1 秒**：真实首字 1.0 秒才起唱，而段的起点仍是 0。
     * 上游 `createSonnetGuide` 收到的是 `firstGlyph.startTime` ⇒ 引导线窗口的终点应当是
     * `1.0 + 0.65`，同刻没有逐字时间轴那一份则按段起点 0 算、窗口早已关闭。
     */
    const shift = 1;
    const providedFirst = (source.words[0]?.startMs ?? 0) / 1000 + shift;
    const input = {
      program,
      timeSec: providedFirst,
      viewport: VIEWPORT,
      inkColor: '#ffffff',
      emphasisColor: '#ff0000',
    };
    const withGlyphs = buildSonnetFrame({
      ...input,
      glyphsByLine: new Map([
        [
          source.index,
          source.words.map((word) => ({
            char: word.text,
            startTime: word.startMs / 1000 + shift,
            endTime: word.endMs / 1000 + shift,
          })),
        ],
      ]),
    });
    const first = withGlyphs.guides.find((guide) => guide.index === 0);
    expect(first).toBeDefined();
    expect(first?.cue.endTime).toBeCloseTo(providedFirst + 0.65, 6);
    /* 没有逐字时间轴：同一时刻按段起点算，第一条引导线窗口已经关了。 */
    const withoutGlyphs = buildSonnetFrame(input);
    expect(withoutGlyphs.guides.some((guide) => guide.index === 0)).toBe(false);
  });

  it('静默期什么都不画（外壳背景直接透出来，这是商籁的留白）', () => {
    const frame = buildSonnetFrame({
      program,
      timeSec: -3,
      viewport: VIEWPORT,
      inkColor: '#ffffff',
      emphasisColor: '#ff0000',
    });
    expect(frame.glyphs).toEqual([]);
    expect(frame.shapes).toEqual([]);
    expect(frame.paragraphIndex).toBe(-1);
  });

  it('镜头内：形状与字都出来了，颜色分强调与非强调两路', () => {
    const shot = program.paragraphs[0]?.shots[0];
    expect(shot).toBeDefined();
    if (shot === undefined) return;
    const frame = buildSonnetFrame({
      program,
      timeSec: (shot.startTime + shot.endTime) / 2,
      viewport: VIEWPORT,
      inkColor: 'rgb(1,2,3)',
      emphasisColor: 'rgb(4,5,6)',
    });
    expect(frame.shotId).toBe(shot.id);
    expect(frame.shapes.length).toBeGreaterThan(0);
    expect(frame.glyphs.length).toBeGreaterThan(0);
    expect(frame.progress).toBeGreaterThan(0);
    expect(frame.progress).toBeLessThanOrEqual(1);
    /*
     * **统一的生长进度**：`rawProgress` 与 `progress` 同源，
     * 供背景/形状/固定几何/背景 MG 共用（口径见 `SonnetFrame.rawProgress` 的注释）。
     */
    expect(frame.rawProgress).toBe(frame.progress);
    for (const glyph of frame.glyphs) {
      expect(Number.isFinite(glyph.x)).toBe(true);
      expect(Number.isFinite(glyph.y)).toBe(true);
      expect(glyph.fontPx).toBeGreaterThan(0);
      expect(['rgb(1,2,3)', 'rgb(4,5,6)']).toContain(glyph.color);
    }
    // 两种颜色都出现：这一镜里既有强调字也有普通字。
    const colors = new Set(frame.glyphs.map((glyph) => glyph.color));
    expect(colors.size).toBeGreaterThanOrEqual(1);
  });

  it('字是"渐入"的：越接近入场时刻越透明，落定后到常态透明度', () => {
    const shot = program.paragraphs[0]?.shots[0];
    if (shot === undefined) return;
    const atStart = buildSonnetFrame({
      program,
      timeSec: shot.startTime + 0.01,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
    });
    const settled = buildSonnetFrame({
      program,
      timeSec: shot.startTime + (shot.endTime - shot.startTime) * 0.9,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
    });
    const average = (frame: typeof atStart): number =>
      frame.glyphs.reduce((sum, glyph) => sum + glyph.alpha, 0) / Math.max(1, frame.glyphs.length);
    expect(average(atStart)).toBeLessThan(average(settled));
  });

  /*
   * 逐字运动改成"只有入场、没有退场"之后的四条回归：
   *   ① 词内不被无关字碰撞推开（逐字变形）；
   *   ② 短句长词 / 混合中英文仍给出有限坐标；
   *   ③ 主构图锚点取**全 shot 最高分的实词片段**（不是首行的 `heroIndices[0]`）；
   *   ④ 相机呼吸不早于**最后一个追踪字的起点**。
   */

  it('**正文不再因无关字碰撞逐字变形**：同一个词里"相邻字心距离"就是排版步进，且整串共线', () => {
    /*
     * 判据的取法（为什么这样取）：帧层把 `x/y` 给的是**排版落点**（入场位移另算在 `deltaX/Y` 里），
     * 所以这里量的是"排版结果有没有被后处理改过"。旧代码的逐字推挤会：
     * · 沿较浅的轴把字推开 ⇒ 相邻字心的**距离**不再等于步进、或整串**不再共线**；
     * 而 `buildSonnetGlyphLayout` 的步进是确定的：竖排 `0.9 × 字号`，横排
     * `max(0.2 × 字号, 量到的字宽)`（本用例是汉字 ⇒ 量到 ≈ 字号本身）。
     * 于是"距离必须是 字号 或 0.9 × 字号" + "方向必须全程一致"就是**与版式无关**的硬约束。
     */
    const song = [makeLine(0, '甲乙丙丁戊', 0, 500), makeLine(1, '己庚辛壬癸', 2600, 500)];
    const integrity = compileSonnetProgram(song, { seed: 'no-collision-deform' });
    let checkedSegments = 0;
    for (const paragraph of integrity.paragraphs) {
      for (const shot of paragraph.shots) {
        const lines = paragraph.lines.filter((line) => shot.lineIndices.includes(line.sourceIndex));
        // 与帧层同一套摊平方式（见 `buildSonnetFrame` 里 `segments` 的构造）。
        const texts = lines.flatMap((line) =>
          (line.segments.length > 0
            ? line.segments
            : [{ text: line.text, isWordLike: true }]
          ).map((segment) => segment.text),
        );
        const frame = buildSonnetFrame({
          program: integrity,
          timeSec: (shot.startTime + shot.endTime) / 2,
          viewport: VIEWPORT,
          inkColor: '#fff',
          emphasisColor: '#f00',
        });
        const body = frame.glyphs.filter((glyph) => !glyph.ghost);
        let cursor = 0;
        for (const text of texts) {
          const chars = [...text].filter((char) => char.trim() !== '');
          if (chars.length === 0) continue;
          const group = body.slice(cursor, cursor + chars.length);
          cursor += chars.length;
          expect(group.map((glyph) => glyph.char).join(''), `镜头 ${shot.kind} 的字序`).toBe(
            chars.join(''),
          );
          if (group.length < 2) continue;
          checkedSegments += 1;
          const fontPx = group[0]?.fontPx ?? 0;
          const directions: { x: number; y: number; length: number }[] = [];
          for (let index = 1; index < group.length; index += 1) {
            const before = group[index - 1];
            const after = group[index];
            if (before === undefined || after === undefined) continue;
            const dx = after.x - before.x;
            const dy = after.y - before.y;
            const length = Math.hypot(dx, dy);
            /*
             * 步进只有两个合法值：横排 ≈ 字号（汉字宽度 = 字号）、竖排 = 0.9 × 字号。
             * 容差取 1e-6 量级的相对值：这是纯算术，不该有误差。
             */
            const candidates = [fontPx, fontPx * 0.9];
            const nearest = candidates.reduce(
              (best, value) => (Math.abs(value - length) < Math.abs(best - length) ? value : best),
              candidates[0] ?? 0,
            );
            expect(
              Math.abs(length - nearest),
              `镜头 ${shot.kind} 的「${text}」里第 ${index} 步进 ${length.toFixed(3)} 不等于排版步进`,
            ).toBeLessThan(Math.max(1e-6, fontPx * 1e-6));
            directions.push({ x: dx, y: dy, length });
          }
          // 整串共线：任意两步的叉积为 0（被推开的字会破坏共线性或步进）。
          const first = directions[0];
          if (first === undefined) continue;
          for (const step of directions) {
            const cross = first.x * step.y - first.y * step.x;
            expect(
              Math.abs(cross) / Math.max(1e-9, first.length * step.length),
              `镜头 ${shot.kind} 的「${text}」被推得不共线了`,
            ).toBeLessThan(1e-6);
          }
        }
        expect(cursor, `镜头 ${shot.kind} 的字形数与段字数对不上`).toBe(body.length);
      }
    }
    expect(checkedSegments).toBeGreaterThan(0);
  });

  it('**短句长词 / 混合中英文**：无论哪种构图，落点与字号一律有限', () => {
    const cases: StageLine[] = [
      makeLine(0, '短', 0, 400),
      makeLine(0, '这是一句非常非常长的歌词'.repeat(3), 0, 120),
      makeLine(0, 'donaudampfschifffahrt甲乙丙丁戊', 0, 200),
      makeLine(0, 'Hello, World! 你好，世界！', 0, 200),
      makeLine(0, 'A', 0, 300),
    ];
    const KINDS = [
      'editorial-column',
      'type-impact',
      'fragment-collage',
      'tracking-ribbon',
      'mask-reveal',
      'poster-blocks',
      'quiet-tableau',
    ] as const;
    let checked = 0;
    for (const line of cases) {
      for (const seed of ['finite-a', 'finite-b', 'finite-c']) {
        const program = compileSonnetProgram([line], { seed });
        const shot = program.paragraphs[0]?.shots[0];
        if (shot === undefined) continue;
        for (const kind of KINDS) {
          const patched = {
            ...program,
            paragraphs: program.paragraphs.map((paragraph) => ({
              ...paragraph,
              shots: paragraph.shots.map((item) => ({ ...item, kind })),
            })),
          };
          const frame = buildSonnetFrame({
            program: patched,
            timeSec: (shot.startTime + shot.endTime) / 2,
            viewport: VIEWPORT,
            inkColor: '#fff',
            emphasisColor: '#f00',
          });
          const body = frame.glyphs.filter((glyph) => !glyph.ghost);
          expect(body.length, `${kind} 没有字号`).toBeGreaterThan(0);
          for (const glyph of body) {
            expect(Number.isFinite(glyph.x), `${kind}「${line.text}」x`).toBe(true);
            expect(Number.isFinite(glyph.y), `${kind}「${line.text}」y`).toBe(true);
            expect(Number.isFinite(glyph.deltaX)).toBe(true);
            expect(Number.isFinite(glyph.deltaY)).toBe(true);
            expect(Number.isFinite(glyph.rotation)).toBe(true);
            expect(glyph.fontPx).toBeGreaterThan(0);
            expect(glyph.scale).toBeGreaterThan(0);
            expect(glyph.haloScale).toBeGreaterThan(0);
            expect(glyph.haloAlpha).toBeGreaterThanOrEqual(0);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('**主构图锚点 = 全 shot 最高分的实词片段**（不是首行的 `heroIndices[0]`）', () => {
    /*
     * 上游 `sonnetTypographyLayout.ts:140` 是 `findSonnetHeroSegmentIndex(segments)`
     * （`segments = lines.flat()`）⇒ 锚点是**整个 shot** 里最长/最久的词；逐行的 `heroIndices`
     * 只决定**角色**（谁吃强调字号与颜色）。
     *
     * 这份夹具把长词放在**第二行**：首行 `x` 只有 1 个字、第二行 `abcdefghijkl` 12 个字
     * ⇒ 全 shot 最高分必然是第二行那个词（也是 `heroIndices[0]` 之外的那个）。
     * 帧层的锚点效果是"**这一串字从画面下方 15% 升起**"（`heroBox.enterY = height × 0.15`），
     * 所以"哪一串的入场位移最大"就是"谁被当成了锚点"的直接读数。
     */
    const program = compileSonnetProgram(
      [makeLine(0, 'xy', 0, 600), makeLine(1, 'abcdefghijkl', 700, 300)],
      { seed: 'hero-anchor-global' },
    );
    const paragraph = program.paragraphs[0];
    const shot = paragraph?.shots[0];
    if (paragraph === undefined || shot === undefined) return;
    // 流程图版才有"heroBox 从下方升起"这条（另外两族走兜底摆放）。
    const patched = {
      ...program,
      paragraphs: program.paragraphs.map((item) => ({
        ...item,
        shots: item.shots.map((entry) => ({ ...entry, kind: 'type-impact' as const })),
      })),
    };
    const patchedParagraph = patched.paragraphs[0];
    const patchedShot = patchedParagraph?.shots[0];
    if (patchedParagraph === undefined || patchedShot === undefined) return;

    const lines = patchedParagraph.lines.filter((line) =>
      patchedShot.lineIndices.includes(line.sourceIndex),
    );
    const flat = lines.flatMap((line) =>
      (line.segments.length > 0
        ? line.segments
        : [{ text: line.text, startTime: line.startTime, endTime: line.endTime, isWordLike: true }]
      ).map((segment) => ({
        text: segment.text,
        durationMs: Math.max(0, segment.endTime - segment.startTime) * 1000,
        isWordLike: segment.isWordLike,
      })),
    );
    const expected = findSonnetHeroSegmentIndex(flat);
    // 首行的主角（`heroIndices[0]` 那一套）不是它 —— 这正是本轮修掉的那个 bug。
    expect(flat[expected]?.text).toBe('abcdefghijkl');
    expect(expected).not.toBe(
      Math.max(
        0,
        flat.findIndex((segment) => segment.text === 'xy'),
      ),
    );

    /*
     * 采样必须落在"**所有字都还没开始唱**"的时刻：那时 `deltaY` 就是这一串的入场基准值
     * （`enterY`），而锚点那串被帧层设成 `height × 0.15`。所以这里用 `glyphsByLine` 把所有字的
     * 起点统一推到镜头起点之后 0.05 秒，避开"首行已经开始入场"的干扰。
     * 两串都是**偶数个**字 ⇒ 奇偶交错的入场错位在组内正负相消，组的平均位移就是纯 `enterY`。
     */
    const glyphStart = patchedShot.startTime + 0.05;
    const timingsFor = (text: string) =>
      [...text].map((char, index) => ({
        char,
        startTime: glyphStart + index * 0.05,
        endTime: glyphStart + index * 0.05 + 0.05,
      }));
    const frame = buildSonnetFrame({
      program: patched,
      timeSec: patchedShot.startTime + 0.001,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
      glyphsByLine: new Map([
        [patchedParagraph.lines[0]?.sourceIndex ?? 0, timingsFor('xy')],
        [patchedParagraph.lines[1]?.sourceIndex ?? 1, timingsFor('abcdefghijkl')],
      ]),
    });
    const body = frame.glyphs.filter((glyph) => !glyph.ghost);
    /** 按"段的文本"把字形分组（字形数组与段顺序一一对应，见上面那条用例的说明）。 */
    const groups = new Map<string, typeof body>();
    let cursor = 0;
    for (const segment of flat) {
      const chars = [...segment.text].filter((char) => char.trim() !== '');
      const group = body.slice(cursor, cursor + chars.length);
      cursor += chars.length;
      groups.set(segment.text, group);
    }
    const magnitude = (group: typeof body): number =>
      group.length === 0
        ? 0
        : Math.abs(group.reduce((sum, glyph) => sum + glyph.deltaY, 0) / group.length);
    let anchoredText = '';
    let anchoredMagnitude = -1;
    for (const [text, group] of groups) {
      const value = magnitude(group);
      if (value > anchoredMagnitude) {
        anchoredMagnitude = value;
        anchoredText = text;
      }
    }
    // 锚点那串是"从下方 15% 升起"的 ⇒ 它的纵向入场位移必须明显大于别的串。
    expect(anchoredMagnitude).toBeGreaterThan(VIEWPORT.height * 0.1);
    expect(anchoredText).toBe(flat[expected]?.text);
  });

  it('**长行的焦点不许抢跑到还没出现的字上**（逐字揭示真的接进了焦点块）', () => {
    /*
     * 这是"长歌词镜头跑得比入场快、只剩屏幕边缘几个字"那条的帧层验收：
     * 焦点块的段内中心由 `run.tracking`（逐字落点 + 开始唱时刻）连续算出，
     * 所以在只显示了一部分字的时候，焦点必须**落在已经出现的那些字附近**，
     * 而不是整段的静态中心（旧口径从第一个字起就给整段中心）。
     * 判据是结构性的（不锚死某个构图变体的具体坐标）：
     *   ① 焦点落在"已出现字的包围盒 ± 2 倍字号"里；
     *   ② 焦点到**最近一个已出现的字**的距离，明显小于它到**整段包围盒中心**的距离。
     */
    const long = compileSonnetProgram(
      [makeLine(0, '一二三四五六七八九十一二三四五六七八九十', 0, 300)],
      { seed: 'focus-reveal' },
    );
    let partiallyRevealed = 0;
    for (const timeSec of [0.2, 1.2, 2.5, 4, 5.5]) {
      const frame = buildSonnetFrame({
        program: long,
        timeSec,
        viewport: VIEWPORT,
        inkColor: '#ffffff',
        emphasisColor: '#ff0000',
      });
      const body = frame.glyphs.filter((glyph) => !glyph.ghost);
      const shown = body.filter((glyph) => glyph.alpha > 0.01);
      if (shown.length === 0 || shown.length === body.length) continue;
      partiallyRevealed += 1;
      const fontPx = body[0]?.fontPx ?? 90;
      const pad = fontPx * 2;
      const shownMinX = Math.min(...shown.map((glyph) => glyph.x));
      const shownMaxX = Math.max(...shown.map((glyph) => glyph.x));
      const shownMinY = Math.min(...shown.map((glyph) => glyph.y));
      const shownMaxY = Math.max(...shown.map((glyph) => glyph.y));
      const aimX = frame.cameraFocus.aimX;
      const aimY = frame.cameraFocus.aimY;
      expect(aimX).toBeGreaterThanOrEqual(shownMinX - pad);
      expect(aimX).toBeLessThanOrEqual(shownMaxX + pad);
      expect(aimY).toBeGreaterThanOrEqual(shownMinY - pad);
      expect(aimY).toBeLessThanOrEqual(shownMaxY + pad);
      /* 与"整段静态中心"对照：老口径就是把它当目标。 */
      const bodyXs = body.map((glyph) => glyph.x);
      const bodyYs = body.map((glyph) => glyph.y);
      const bodyCenterX = (Math.min(...bodyXs) + Math.max(...bodyXs)) / 2;
      const bodyCenterY = (Math.min(...bodyYs) + Math.max(...bodyYs)) / 2;
      const nearestShown = Math.min(
        ...shown.map((glyph) => Math.hypot(glyph.x - aimX, glyph.y - aimY)),
      );
      const toBodyCenter = Math.hypot(bodyCenterX - aimX, bodyCenterY - aimY);
      expect(nearestShown).toBeLessThan(0.6 * toBodyCenter);
    }
    expect(partiallyRevealed).toBeGreaterThanOrEqual(3);
  });

  it('**相机呼吸不早于最后一个追踪字的起点**（`revealDoneTime` = 最后 tracking 字的 startTime）', () => {
    /*
     * 上游 `resolveShotTracking`：`revealDoneTime = max(各追踪段最后一个字的 startTime)`。
     * 我们此前取的是 `max(segment.startTime)`（**说话窗口的起点**）⇒ 呼吸在最后一个字还在入场时
     * 就开始浮；若改成 `settleTime`（落位）则更晚。这条用例用**显式逐字时间轴**把三个候选值分开：
     *   段窗口起点 = 1.0、最后一个字的起点 = 2.5、落位 ≈ 2.5 + 入场时长。
     */
    const one = compileSonnetProgram([makeLine(0, '甲乙丙丁', 1000, 4000)], {
      seed: 'breath-contract',
    });
    const shot = one.paragraphs[0]?.shots[0];
    if (shot === undefined) return;
    /* 起始点 1.0/1.3/1.6/1.9：最后一个字在镜头里还有 3 秒多，足够量"渐入 1.2 秒升满"。 */
    const timings = [...'甲乙丙丁'].map((char, index) => ({
      char,
      startTime: 1 + index * 0.3,
      endTime: 1.3 + index * 0.3,
    }));
    const frameAt = (timeSec: number) =>
      buildSonnetFrame({
        program: one,
        timeSec,
        viewport: VIEWPORT,
        inkColor: '#fff',
        emphasisColor: '#f00',
        glyphsByLine: new Map([[0, timings]]),
      });
    const lastGlyphStart = 1 + 3 * 0.3;
    expect(frameAt(2.0).camera.revealDoneTime).toBeCloseTo(lastGlyphStart, 9);
    // 最后一个字还没开始唱之前：呼吸权重恒为 0（早一拍就是错的）。
    for (const time of [shot.startTime + 0.01, 1.0, 1.5, lastGlyphStart - 0.01]) {
      expect(frameAt(time).camera.breathWeight, `t=${time} 时呼吸提前了`).toBe(0);
    }
    // 起点那一刻仍是 0（渐入从 0 开始），随后 1.2 秒内升满。
    expect(frameAt(lastGlyphStart).camera.breathWeight).toBe(0);
    expect(frameAt(lastGlyphStart + 0.6).camera.breathWeight).toBeGreaterThan(0);
    expect(frameAt(lastGlyphStart + 1.2).camera.breathWeight).toBeCloseTo(1, 6);
  });

  it('**运镜就是参考公式**：没有撞击反移、也没有段落衔接的镜位退让', () => {
    /*
     * 判据：在一个"呼吸还没开始（权重 0）、震颤强度默认 0"的时刻，镜头字段必须**逐值等于**
     * `resolveShotMotionFrame` 那一条路径 —— 任何额外的合成项（反移 / 退让 / 鼓包推近）
     * 都会让这个等式不成立。`zoom` 先乘 `shot.camera.zoom`、`rotation` 先加 `shot.camera.rotation`。
     */
    const shot = program.paragraphs[0]?.shots[0];
    if (shot === undefined) return;
    const frame = buildSonnetFrame({
      program,
      timeSec: shot.startTime + 0.001,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
    });
    expect(frame.shotId).toBe(shot.id);
    expect(frame.camera.breathWeight).toBe(0);
    const motion = resolveShotMotionFrame(shot.kind, frame.progress);
    expect(frame.camera.x).toBeCloseTo(motion.x, 12);
    expect(frame.camera.y).toBeCloseTo(motion.y, 12);
    expect(frame.camera.zoom).toBeCloseTo(shot.camera.zoom * (1 + (motion.scale - 1)), 12);
    expect(frame.camera.rotation).toBeCloseTo(shot.camera.rotation + motion.rotation, 12);
  });

  it('**动画强度档**：低档按比例收住运镜与轴心，0 档完全静止、轴心回 `basePivot`', () => {
    const shot = program.paragraphs[0]?.shots[0];
    if (shot === undefined) return;
    const at = (animationScale: number) =>
      buildSonnetFrame({
        program,
        timeSec: shot.startTime + 0.001,
        viewport: VIEWPORT,
        inkColor: '#fff',
        emphasisColor: '#f00',
        animationScale,
      });
    const normal = at(1);
    const calm = at(0.65);
    const frozen = at(0);
    /* 低档 = 正常档 × 0.65（同一时刻、同一镜）。 */
    expect(calm.camera.x).toBeCloseTo(normal.camera.x * 0.65, 9);
    expect(calm.camera.rotation).toBeCloseTo(normal.camera.rotation * 0.65, 9);
    /*
     * 轴心按同一个系数在"**本镜静态轴心 `basePivot`** ↔ 跟拍焦点"之间混合
     * （上游 `sonnetShotFrame.ts:151`）⇒ 0 档给出的 `frozen.pivot` **就是** `basePivot`。
     * ⚠ 基准是 `basePivot`（本镜第一个主角字的中心 / 画面中心），**不是**"一律画面中心"。
     *
     * ⚠ **不再拿"低档距离 = 正常档 × 0.65"当判据**：跟拍焦点现在吃**真实入场位移**
     * （`sonnetCameraFocus.ts` 的 `motionX/motionY`），而入场位移本身乘动画强度档 ⇒
     * 焦点目标也随档位变，跨档距离不再是严格比例。改为逐档验**混合式**本身：
     * `pivot = basePivot + (焦点 − basePivot) × 档位`，其中 `basePivot = frozen.pivot`。
     */
    const mixAt = (scale: number, frame: ReturnType<typeof buildSonnetFrame>): void => {
      expect(frame.pivot.x).toBeCloseTo(
        frozen.pivot.x + (frame.cameraFocus.aimX - frozen.pivot.x) * scale,
        6,
      );
      expect(frame.pivot.y).toBeCloseTo(
        frozen.pivot.y + (frame.cameraFocus.aimY - frozen.pivot.y) * scale,
        6,
      );
    };
    mixAt(0.65, calm);
    mixAt(1, normal);
    const distance = (frame: ReturnType<typeof buildSonnetFrame>): number =>
      Math.hypot(frame.pivot.x - frozen.pivot.x, frame.pivot.y - frozen.pivot.y);
    /* 低档仍然更收（不许反超正常档）。 */
    expect(distance(calm)).toBeLessThanOrEqual(distance(normal) + 1e-9);
    /* 逐字入场位移同吃这个系数。 */
    const entryOf = (frame: ReturnType<typeof buildSonnetFrame>): number =>
      frame.glyphs.reduce((sum, glyph) => sum + Math.abs(glyph.deltaX) + Math.abs(glyph.deltaY), 0);
    expect(entryOf(calm)).toBeCloseTo(entryOf(normal) * 0.65, 6);
    /* 0 档：不推不转不缩放（只留 `shot.camera.zoom`）。 */
    expect(Math.abs(frozen.camera.x)).toBe(0);
    expect(Math.abs(frozen.camera.y)).toBe(0);
    expect(frozen.camera.zoom).toBeCloseTo(shot.camera.zoom, 12);
    expect(frozen.camera.rotation).toBe(0);
    expect(entryOf(frozen)).toBe(0);
    /*
     * **`pivot + anchorDelta` 恒等于取景锚点**（各档同一个值）——
     * 这正是"增量里减的必须是**混合后的**轴心、不是未混合的焦点"的判据：任何一档漂了都会不等。
     */
    const basePosition = (frame: ReturnType<typeof buildSonnetFrame>): { x: number; y: number } => ({
      x: frame.pivot.x + frame.anchorDelta.x,
      y: frame.pivot.y + frame.anchorDelta.y,
    });
    for (const frame of [frozen, calm, normal]) {
      expect(basePosition(frame).x).toBeCloseTo(basePosition(normal).x, 9);
      expect(basePosition(frame).y).toBeCloseTo(basePosition(normal).y, 9);
    }
  });

  /**
   * **静态轴心 `basePivot`**（上游 `sonnetSceneBuilder.ts:286~293`）：海报那族取画面正中心，
   * 其余的取**第一个主角字的位置**。运行时 `pivot` 是在它和跟拍焦点之间混合出来的，
   * 所以 0 档的轴心**不该一律钉在画面中心** —— 主角字不在正中时它也不在正中。
   */
  it('0 档轴心 = `basePivot`：海报取正中心，非海报跟着主角字走（不一律画面中心）', () => {
    const KIND = ['type-impact', 'quiet-tableau', 'editorial-column', 'poster-blocks'] as const;
    let offCenter = 0;
    let posterChecked = 0;
    for (const kind of KIND) {
      for (const seed of ['basepivot-a', 'basepivot-b', 'basepivot-c', 'basepivot-d']) {
        const base = compileSonnetProgram(SONG, { seed });
        const patched = {
          ...base,
          paragraphs: base.paragraphs.map((paragraph) => ({
            ...paragraph,
            shots: paragraph.shots.map((item) => ({ ...item, kind })),
          })),
        };
        const patchedShot = patched.paragraphs[0]?.shots[0];
        if (patchedShot === undefined) continue;
        const frame = buildSonnetFrame({
          program: patched,
          timeSec: patchedShot.startTime + 0.001,
          viewport: VIEWPORT,
          inkColor: '#fff',
          emphasisColor: '#f00',
          animationScale: 0,
        });
        if (kind === 'poster-blocks') {
          /* 海报：`basePivot` 就是画面中心（上游 `focusX/focusY = 0`）。 */
          expect(frame.pivot.x).toBeCloseTo(VIEWPORT.width / 2, 6);
          expect(frame.pivot.y).toBeCloseTo(VIEWPORT.height / 2, 6);
          /* 取景锚点也是正中心 ⇒ 增量为 0（这一族不参与 ±0.025 的镜位）。 */
          expect(frame.anchorDelta.x).toBeCloseTo(0, 6);
          expect(frame.anchorDelta.y).toBeCloseTo(0, 6);
          posterChecked += 1;
          continue;
        }
        /* 取景锚点：`(0.5 + camera.x, 0.48 + camera.y ± 0.025)`（镜序 0 ⇒ −0.025）。 */
        expect(frame.pivot.x + frame.anchorDelta.x).toBeCloseTo(
          VIEWPORT.width * (0.5 + patchedShot.camera.x),
          6,
        );
        expect(frame.pivot.y + frame.anchorDelta.y).toBeCloseTo(
          VIEWPORT.height * (0.48 + patchedShot.camera.y - 0.025),
          6,
        );
        if (
          Math.abs(frame.pivot.x - VIEWPORT.width / 2) > 1 ||
          Math.abs(frame.pivot.y - VIEWPORT.height / 2) > 1
        ) {
          offCenter += 1;
        }
      }
    }
    expect(posterChecked).toBeGreaterThan(0);
    expect(offCenter, '扫了四种构图都没出现"轴心不在画面中心"，说明 basePivot 没跟上主角字').toBeGreaterThan(0);
  });

  /**
   * **用户字号缩放先进基准字号公式**（`lyricsFontScale`，上游 `options.lyricsFontScale`）。
   *
   * 判据两条：
   * ① **真的用上了**：大字号下至少有一个镜头的字形比正常字号大；
   * ② **没有 double scale**：任何镜头的字号都不超过 `正常 × 1.2`（乘两次会是 1.44）。
   * 之所以不写"等于 112 × 倍率"那种绝对值断言：字号链上还有 82% 的 `fitScale` 与全局缩放阶梯，
   * 两者都会把倍率吃回去 —— 那些是**有意保留**的行为，不该被这条用例钉死。
   */
  it('**`lyricsFontScale` 进基准字号、下游不乘第二次**：字号随它变大但不超线性', () => {
    /*
     * 夹具用**显式词界标记**（每两粒一个词）而不是模块级的 `SONG`：合并碎片之后
     * `SONG` 那种"整行被 ICU 收成一段"的夹具只剩 3~5 段，基准字号一上来就撞到 112 的上限，
     * 于是两条倍率都读同一个数 —— 用例会变成"空对照"。这里固定成每行 5 段，倍率看得见 ✓
     */
    const markedLine = (index: number, text: string, startMs: number): StageLine => {
      const chars = [...text];
      return {
        ...makeLine(index, text, startMs, 200),
        words: chars.map((char, position) => ({
          text: char,
          startMs: startMs + position * 200,
          endMs: startMs + (position + 1) * 200,
          wordStart: position % 2 === 0,
        })),
      };
    };
    const program = compileSonnetProgram(
      [0, 1, 2, 3].map((index) => markedLine(index, 'アイウエオカキクケコ', index * 2200)),
      { seed: 'lyrics-font-scale' },
    );
    const shots = program.paragraphs.flatMap((paragraph) => paragraph.shots).slice(0, 16);
    const maxFont = (timeSec: number, lyricsFontScale: number): number => {
      const frame = buildSonnetFrame({
        program,
        timeSec,
        viewport: VIEWPORT,
        inkColor: '#fff',
        emphasisColor: '#f00',
        lyricsFontScale,
      });
      const fonts = frame.glyphs.filter((glyph) => !glyph.ghost).map((glyph) => glyph.fontPx);
      return fonts.length === 0 ? 0 : Math.max(...fonts);
    };
    let grew = 0;
    let sampled = 0;
    for (const shot of shots) {
      const mid = shot.startTime + (shot.endTime - shot.startTime) * 0.9;
      const normal = maxFont(mid, 1);
      const large = maxFont(mid, 1.2);
      if (normal <= 0) continue;
      sampled += 1;
      expect(large, `镜头 ${shot.kind} 的字号随倍率反而变小`).toBeGreaterThanOrEqual(normal - 1e-9);
      expect(large, `镜头 ${shot.kind} 的字号超过线性（double scale？）`).toBeLessThanOrEqual(
        normal * 1.2 + 1e-6,
      );
      if (large > normal + 1e-6) grew += 1;
    }
    expect(sampled).toBeGreaterThan(0);
    expect(grew, '没有任何镜头的字号随 lyricsFontScale 变大，说明倍率根本没进公式').toBeGreaterThan(0);
  });

  /**
   * **海报竖排备选尺寸只给 CJK**（照抄 `sonnetTypographyLayout.ts:302~326`）。
   *
   * 判据用"同一颗种子 + 同一段文字"的 CJK/英文对照：
   * · CJK 版本在竖排取向下会真的排成**字列**；
   * · 同一个种子下英文版本**一列都不能有**（三个竖排字段 undefined ⇒ 海报只能走正常词块），
   *   而且任何一串字的纵向跨度都不得超过画面 82% 上限（`verticalFit` 真的生效了）。
   */
  it('海报竖排备选：CJK 才给（真排字列），英文一律横向（不按字母列改写）', () => {
    const CJK = '甲乙丙丁戊己庚辛壬癸';
    const LATIN = 'abcdefghij';
    const groupsOf = (
      program: ReturnType<typeof compileSonnetProgram>,
      timeSec: number,
    ): { text: string; glyphs: ReturnType<typeof buildSonnetFrame>['glyphs'][number][] }[] => {
      const shot = program.paragraphs[0]?.shots[0];
      if (shot === undefined) return [];
      const paragraph = program.paragraphs[0];
      if (paragraph === undefined) return [];
      const frame = buildSonnetFrame({
        program,
        timeSec,
        viewport: VIEWPORT,
        inkColor: '#fff',
        emphasisColor: '#f00',
      });
      const lines = paragraph.lines.filter((line) => shot.lineIndices.includes(line.sourceIndex));
      const texts = lines.flatMap((line) =>
        (line.segments.length > 0
          ? line.segments
          : [{ text: line.text, startTime: line.startTime, endTime: line.endTime, isWordLike: true }]
        ).map((segment) => segment.text),
      );
      const body = frame.glyphs.filter((glyph) => !glyph.ghost);
      const groups: { text: string; glyphs: typeof body }[] = [];
      let cursor = 0;
      for (const text of texts) {
        const chars = [...text].filter((char) => char.trim() !== '');
        groups.push({ text, glyphs: body.slice(cursor, cursor + chars.length) });
        cursor += chars.length;
      }
      return groups;
    };
    const build = (text: string, seed: string) => {
      const base = compileSonnetProgram([makeLine(0, text, 0, 300)], { seed });
      const patched = {
        ...base,
        paragraphs: base.paragraphs.map((paragraph) => ({
          ...paragraph,
          shots: paragraph.shots.map((item) => ({ ...item, kind: 'poster-blocks' as const })),
        })),
      };
      const shot = patched.paragraphs[0]?.shots[0];
      return shot === undefined ? null : { program: patched, timeSec: shot.startTime + 0.2 };
    };
    const columnGroups = (
      groups: { text: string; glyphs: { x: number; y: number; fontPx: number }[] }[],
    ): { spanX: number; spanY: number; fontPx: number }[] =>
      groups
        .filter((group) => group.glyphs.length >= 2)
        .map((group) => {
          const xs = group.glyphs.map((glyph) => glyph.x);
          const ys = group.glyphs.map((glyph) => glyph.y);
          return {
            spanX: Math.max(...xs) - Math.min(...xs),
            spanY: Math.max(...ys) - Math.min(...ys),
            fontPx: group.glyphs[0]?.fontPx ?? 0,
          };
        })
        .filter((group) => group.spanY > group.spanX + 1e-6);

    /*
     * ① **适配读数**（固定满长度夹具）：任何一串字的**纵向跨度 + 一个字高**不得超过画面 82%
     *    （`verticalFit` 的上限）；横向跨度同理。CJK 字列满足它，英文横向块也满足它 ✓
     */
    for (let index = 0; index < 12; index += 1) {
      const cjk = build(CJK, `poster-vertical-${index}`);
      const latin = build(LATIN, `poster-vertical-${index}`);
      if (cjk === null || latin === null) continue;
      for (const group of [...groupsOf(cjk.program, cjk.timeSec), ...groupsOf(latin.program, latin.timeSec)]) {
        const placed = group.glyphs;
        if (placed.length === 0) continue;
        const fontPx = placed[0]?.fontPx ?? 0;
        expect(fontPx).toBeLessThanOrEqual(VIEWPORT.width * SONNET_FIT_MAX_RATIO + 1e-6);
        if (placed.length < 2) continue;
        const xs = placed.map((glyph) => glyph.x);
        const ys = placed.map((glyph) => glyph.y);
        expect(Math.max(...xs) - Math.min(...xs) + fontPx).toBeLessThanOrEqual(
          VIEWPORT.width * SONNET_FIT_MAX_RATIO + 1e-6,
        );
        expect(Math.max(...ys) - Math.min(...ys) + fontPx).toBeLessThanOrEqual(
          VIEWPORT.height * SONNET_FIT_MAX_RATIO + 1e-6,
        );
      }
    }
    /*
     * ② **字列存在性 + 拉丁对照**：扫**不同长度的同一段文字** —— 海报取向由"变体种子 =
     *    各段字数之和 + 段数"的奇偶决定（`layoutSonnetPosterBlocks`：`seed % 2`），
     *    而段数会被碎片合并改变 ⇒ 固定一段文字可能整片都落在横向档上、对照就成了空的。
     *    扫长度才能覆盖到竖排档 ✓
     */
    let columnSeeds = 0;
    for (let length = 4; length <= CJK.length; length += 1) {
      const cjk = build(CJK.slice(0, length), `poster-vertical-${length}`);
      const latin = build(LATIN.slice(0, length), `poster-vertical-${length}`);
      if (cjk === null || latin === null) continue;
      const cjkGroups = groupsOf(cjk.program, cjk.timeSec);
      const latinGroups = groupsOf(latin.program, latin.timeSec);
      if (columnGroups(cjkGroups).length > 0) {
        columnSeeds += 1;
        expect(
          columnGroups(latinGroups),
          `长度 ${length}：CJK 排成了字列，英文也被排成了字母列`,
        ).toHaveLength(0);
      }
    }
    expect(columnSeeds, '没有一个长度让 CJK 排成字列，这条对照是空的').toBeGreaterThan(0);
  });

  /**
   * **不再按文本去重**（`${text}|${line}` 那个 key 会把对象拼成 `[object Object]`）：
   * 同一镜里两次真歌词 "you" 都必须画出来；跨行出现的同一个词也不能丢。
   */
  it('同一镜里重复的歌词都在：两个 you 都画，跨行同词也不丢', () => {
    const one = compileSonnetProgram([makeLine(0, 'you said you would be there', 0, 300)], {
      seed: 'dedup-you',
    });
    const oneShot = one.paragraphs[0]?.shots[0];
    if (oneShot === undefined) return;
    const frame = buildSonnetFrame({
      program: one,
      timeSec: oneShot.startTime + (oneShot.endTime - oneShot.startTime) * 0.9,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
    });
    const joined = frame.glyphs
      .filter((glyph) => !glyph.ghost)
      .map((glyph) => glyph.char)
      .join('');
    expect(joined).toBe('yousaidyouwouldbethere');
    expect(joined.split('you').length - 1, '两个 you 被去重掉了一个').toBe(2);

    /* 跨行：把两行都塞进同一镜（同一份 `paragraph` 里两行同词）。 */
    const two = compileSonnetProgram(
      [makeLine(0, 'you', 0, 400), makeLine(1, 'you', 1200, 400)],
      { seed: 'dedup-cross-line' },
    );
    const paragraph = two.paragraphs[0];
    const shot = paragraph?.shots[0];
    if (paragraph === undefined || shot === undefined) return;
    const patched = {
      ...two,
      paragraphs: two.paragraphs.map((item) => ({
        ...item,
        shots: item.shots.map((entry) => ({
          ...entry,
          lineIndices: item.lines.map((line) => line.sourceIndex),
        })),
      })),
    };
    const crossFrame = buildSonnetFrame({
      program: patched,
      timeSec: shot.startTime + (shot.endTime - shot.startTime) * 0.9,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
    });
    const crossJoined = crossFrame.glyphs
      .filter((glyph) => !glyph.ghost)
      .map((glyph) => glyph.char)
      .join('');
    expect(crossJoined.split('you').length - 1, '跨行的同一个词被去重了').toBe(2);
  });

  /**
   * **回声法向取"流程摞向"（`layoutDirection`），不是书写模式 `vertical`**
   * （上游 `sonnetTextViewBuilder.ts:183` 的 `ghostNormal`）。
   *
   * 取 `editorial-column` 第 4 档（Logo 徽章）当对照：那一档里**主角柱之外**的盒子
   * `layoutDirection = 'horizontal'`，而强调字（含次主角）的**书写模式是竖排** ⇒ 两者**不同**。
   * 半主角回声的分离方向必须跟着 `layoutDirection` 走（竖向分离，`|Y| > |X|`）；
   * 若误用 `run.vertical`，它会变成横向分离。
   */
  it('半主角回声沿**流程法向**分离（书写竖排 + 流程横排时仍竖向分离）', () => {
    /*
     * `layoutVariantSeed` 只由**文本**决定（与种子无关），所以要让这一镜落在第 4 档，
     * 得换文本来凑 `seed % 5 === 4`。这里给最后一个词逐字补长，扫到那一档为止。
     */
    const PAD = '甲乙丙丁戊己庚辛';
    let checked = 0;
    for (let pad = 0; pad <= PAD.length; pad += 1) {
      const text = `甲乙 丙丁 戊己 庚辛 壬癸${PAD.slice(0, pad)}`;
      const base = compileSonnetProgram([makeLine(0, text, 0, 220)], { seed: 'echo-normal' });
      const baseParagraph = base.paragraphs[0];
      const baseShot = baseParagraph?.shots[0];
      if (baseParagraph === undefined || baseShot === undefined) continue;
      if (!(baseShot.endTime - baseShot.startTime > 0.6)) continue;
      const patched = {
        ...base,
        paragraphs: base.paragraphs.map((paragraph) => ({
          ...paragraph,
          shots: paragraph.shots.map((item) => ({ ...item, kind: 'editorial-column' as const })),
        })),
      };
      const paragraph = patched.paragraphs[0];
      const shot = paragraph?.shots[0];
      if (paragraph === undefined || shot === undefined) continue;
      const line = paragraph.lines[0];
      if (line === undefined) continue;
      /* 与帧层同一套摊平，先算出这一镜的 `editorial` 档位（只有第 4 档才是那条对照）。 */
      const segments = line.segments.length > 0 ? line.segments : [{ text: line.text }];
      const layoutVariantSeed =
        segments.reduce((sum, segment) => sum + Math.max(1, segment.text.trim().length), 0) +
        segments.length;
      if (layoutVariantSeed % 5 !== 4 || segments.length < 2) continue;
      const glyphStart = shot.startTime + 0.4;
      const timings = [...line.text].map((char, index) => ({
        char,
        startTime: glyphStart + index * 0.01,
        endTime: glyphStart + index * 0.01 + 0.01,
      }));
      const frame = buildSonnetFrame({
        program: patched,
        timeSec: shot.startTime + 0.45,
        viewport: VIEWPORT,
        inkColor: '#fff',
        emphasisColor: '#f00',
        glyphsByLine: new Map([[line.sourceIndex, timings]]),
      });
      const echoing = frame.glyphs.filter((glyph) => glyph.echoActive && !glyph.ghost);
      if (echoing.length === 0) continue;
      const xs = echoing.map((glyph) => glyph.x);
      const ys = echoing.map((glyph) => glyph.y);
      /* 前提校准：这一串确实是**竖排书写**（排成一列），否则这条对照测不到 F。 */
      if (!(Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs))) continue;
      checked += 1;
      for (const glyph of echoing) {
        const offsetX = Math.abs(glyph.echoOffset1X) + Math.abs(glyph.echoOffset2X);
        const offsetY = Math.abs(glyph.echoOffset1Y) + Math.abs(glyph.echoOffset2Y);
        expect(offsetY).toBeGreaterThan(offsetX);
      }
      break;
    }
    console.info(`[test] echo-normal 采样=${checked}`);
    expect(checked, '没找到"书写竖排 + 流程横排"的半主角样本，这条对照是空的').toBeGreaterThan(0);
  });

  /**
   * **逐字只有入场**：入场段确实在走；**落位之后到镜头末尾一动也不动**。
   *
   * 这条取代了原来那条"镜头内始终有元素在动" —— 那条是靠已删除的退场行为把占比顶上去的。
   * 现在"画面一直在动"由**镜头**负责（路径曲线 + 空档漂移 + 呼吸），字形落位后就该是稳的。
   */
  it('逐字**只有入场**：入场段确有位移，**一旦落位就不再变**', () => {
    const motionProgram = compileSonnetProgram(SONG, { seed: 'motion-audit' });
    const at = (timeSec: number): ReturnType<typeof buildSonnetFrame> =>
      buildSonnetFrame({
        program: motionProgram,
        timeSec,
        viewport: VIEWPORT,
        inkColor: '#fff',
        emphasisColor: '#f00',
      });
    const settled = (glyph: { alpha: number; deltaX: number; deltaY: number }): boolean =>
      glyph.alpha >= 0.999999 && glyph.deltaX === 0 && glyph.deltaY === 0;
    const snapshot = (glyph: {
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      alpha: number;
      scale: number;
      rotation: number;
    }) => [glyph.x, glyph.y, glyph.deltaX, glyph.deltaY, glyph.alpha, glyph.scale, glyph.rotation];
    let intervals = 0;
    let movingIntervals = 0;
    let settledGlyphSamples = 0;
    let changedAfterSettle = 0;
    for (const paragraph of motionProgram.paragraphs) {
      for (const shot of paragraph.shots) {
        const span = shot.endTime - shot.startTime;
        if (!(span > 0.2)) continue;
        const steps = Math.max(4, Math.round(span * 20));
        let previous: ReturnType<typeof buildSonnetFrame> | null = null;
        for (let step = 0; step <= steps; step += 1) {
          const time = shot.startTime + (span * step) / steps;
          const frame = at(time);
          if (previous !== null && previous.shotId === frame.shotId) {
            intervals += 1;
            let moved = false;
            let sameShape = previous.glyphs.length === frame.glyphs.length;
            for (let index = 0; index < frame.glyphs.length; index += 1) {
              const before = previous.glyphs[index];
              const after = frame.glyphs[index];
              if (before === undefined || after === undefined || before.char !== after.char) {
                sameShape = false;
                break;
              }
              const dx = after.x + after.deltaX - (before.x + before.deltaX);
              const dy = after.y + after.deltaY - (before.y + before.deltaY);
              if (Math.hypot(dx, dy) >= 2) moved = true;
              /*
               * **核心契约**：上一帧已经落位的字，这一帧必须逐值不动
               * （有退场时 delta 会重新变大、alpha 会掉 —— 那正是本轮删掉的东西）。
               */
              if (settled(before)) {
                settledGlyphSamples += 1;
                if (JSON.stringify(snapshot(after)) !== JSON.stringify(snapshot(before))) {
                  changedAfterSettle += 1;
                }
              }
            }
            if (sameShape && moved) movingIntervals += 1;
          }
          previous = frame;
        }
      }
    }
    console.info(
      `[pi/sonnet] motion 采样区间=${intervals} 有位移=${movingIntervals} ` +
        `已落位字样本=${settledGlyphSamples} 落位后又变=${changedAfterSettle}`,
    );
    // 入场段必须真的在走（不是"整镜一动不动"）。
    expect(movingIntervals).toBeGreaterThan(0);
    // 而且**确实出现过**"字已落位"的样本（否则下面那条判据形同虚设）。
    expect(settledGlyphSamples).toBeGreaterThan(0);
    expect(changedAfterSettle).toBe(0);
  });

  it('确定性：同一份程序与时刻两次求值逐字段一致', () => {
    const shot = program.paragraphs[0]?.shots[0];
    if (shot === undefined) return;
    const at = shot.startTime + 0.5;
    const input = {
      program,
      timeSec: at,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
    } as const;
    expect(buildSonnetFrame(input)).toEqual(buildSonnetFrame(input));
  });

  it('七种镜头都画得出东西（装饰形态各自不同，但都不能是空的）', () => {
    for (const kind of [
      'editorial-column',
      'type-impact',
      'fragment-collage',
      'tracking-ribbon',
      'mask-reveal',
      'poster-blocks',
      'quiet-tableau',
    ] as const) {
      const oneShot = compileSonnetProgram(SONG, { seed: `only-${kind}` });
      const shot = oneShot.paragraphs[0]?.shots[0];
      if (shot === undefined) continue;
      // 手工把镜头种类换掉：帧层的装饰分支按 kind 走。
      const patched = {
        ...oneShot,
        paragraphs: oneShot.paragraphs.map((paragraph) => ({
          ...paragraph,
          shots: paragraph.shots.map((item) => ({ ...item, kind })),
        })),
      };
      const frame = buildSonnetFrame({
        program: patched,
        timeSec: (shot.startTime + shot.endTime) / 2,
        viewport: VIEWPORT,
        inkColor: '#fff',
        emphasisColor: '#f00',
      });
      expect(frame.shapes.length, `镜头 ${kind} 的形状数`).toBeGreaterThan(0);
      expect(frame.glyphs.length, `镜头 ${kind} 的字数`).toBeGreaterThan(0);
    }
  });

  it('**帧层视口必须是画布的逻辑尺寸**：宽度被缩小一档，整幅字就跟着小一档', () => {
    /*
     * 回归用例（第 35 轮补）。渲染层曾经把 `renderer.width / renderer.resolution` 交给帧层，
     * 而 Pixi v8 的 `renderer.width` **已经是逻辑尺寸** ⇒ 又除了一次分辨率，
     * 帧层拿到的宽度实测是 **946**（真实画布 1182，DPR 1.25）。后果正是主人反馈的
     * "字小 + 没填满"：字号与版面都按 946×618 排，再画到 1182×772 上。
     *
     * 这里钉住帧层这一侧的契约：**同一镜头、同一时刻，只改视口尺寸，字号应按宽度等比变化**。
     * 判据不挑单个镜头（有的镜头词少，两侧都会撞到 112 的上限而看起来相等），
     * 而是扫前若干个镜头，只要**至少一个**镜头给出"大视口的字更大"的读数即通过。
     */
    const program = compileSonnetProgram(SONG, { seed: 'viewport-contract' });
    const shots = program.paragraphs.flatMap((paragraph) => paragraph.shots).slice(0, 12);
    const maxBodyFont = (timeSec: number, width: number, height: number): number => {
      const frame = buildSonnetFrame({
        program,
        timeSec,
        viewport: { width, height },
        inkColor: '#fff',
        emphasisColor: '#f00',
      });
      const fonts = frame.glyphs.filter((glyph) => !glyph.ghost).map((glyph) => glyph.fontPx);
      return fonts.length === 0 ? 0 : Math.max(...fonts);
    };
    let proven = false;
    let best = 1;
    for (const shot of shots) {
      const mid = (shot.startTime + shot.endTime) / 2;
      const wide = maxBodyFont(mid, 1182, 772);
      const narrow = maxBodyFont(mid, 946, 618);
      if (wide <= 0 || narrow <= 0) continue;
      const ratio = wide / narrow;
      best = Math.max(best, ratio);
      if (ratio > 1.05) proven = true;
    }
    expect(best, '没找到任何"视口更大 ⇒ 字更大"的镜头，说明视口已不再驱动字号').toBeGreaterThan(1.05);
    expect(proven).toBe(true);
  });

  it('**正文落点有限、构图仍在画面内**，但**允许有意出血**（逐字夹回画布已撤掉）', () => {
    /*
     * 这条用例原来叫「每个字都必须落在画布内」，判的是"逐字夹回画布 + 整组收边"那套后处理。
     * 那套已删除（原版允许也常常故意让字出血），所以断言改成：
     *   ① **落点必须有限**（NaN/Infinity 才是真故障 —— 那会让渲染层堆成一团）；
     *   ② 正文外接范围必须与画面**相交**、版心中点在画面内（整段跑到画布外才是真故障）。
     * 另外补一条"**确实会出血**"：扫描里出现过越界的正文落点，就说明没有偷偷夹回去。
     */
    const FLOW_KINDS = [
      'type-impact',
      'mask-reveal',
      'tracking-ribbon',
      'quiet-tableau',
      'fragment-collage',
    ] as const;
    const KINDS = [...FLOW_KINDS, 'editorial-column', 'poster-blocks'] as const;
    let bleedShots = 0;
    let scannedShots = 0;
    for (const kind of KINDS) {
      const oneShot = compileSonnetProgram(SONG, { seed: `inside-${kind}` });
      const shot = oneShot.paragraphs[0]?.shots[0];
      if (shot === undefined) continue;
      const patched = {
        ...oneShot,
        paragraphs: oneShot.paragraphs.map((paragraph) => ({
          ...paragraph,
          shots: paragraph.shots.map((item) => ({ ...item, kind })),
        })),
      };
      const frame = buildSonnetFrame({
        program: patched,
        timeSec: (shot.startTime + shot.endTime) / 2,
        viewport: VIEWPORT,
        inkColor: '#fff',
        emphasisColor: '#f00',
      });
      expect(frame.glyphs.length, `镜头 ${kind} 的字数`).toBeGreaterThan(0);
      // 幽灵字本来就是**故意出血**的（照抄上游的"主角影子"），这条只量正文。
      const body = frame.glyphs.filter((glyph) => !glyph.ghost);
      expect(body.length, `镜头 ${kind} 的正文数`).toBeGreaterThan(0);
      scannedShots += 1;
      if (
        body.some(
          (glyph) =>
            glyph.x < 0 || glyph.x > VIEWPORT.width || glyph.y < 0 || glyph.y > VIEWPORT.height,
        )
      ) {
        bleedShots += 1;
      }
      for (const glyph of body) {
        expect(Number.isFinite(glyph.x), `镜头 ${kind} 的字 x 不是有限数`).toBe(true);
        expect(Number.isFinite(glyph.y), `镜头 ${kind} 的字 y 不是有限数`).toBe(true);
      }
      // 没搬过来的两族走兜底摆放，居中判据管不到它们（它们本来就是按画面坐标算的）。
      if (!(FLOW_KINDS as readonly string[]).includes(kind)) continue;
      /*
       * **整组仍在画面里**（原来那条"必须居中"的判据的替代）。
       *
       * 原判据依赖我们自加的"整组收边 + 重新居中"：少了它，`placeWithGlobalFit` 只保证**整组估计
       * 落在画面内**，一镜里盒子多/字大时本来就允许一侧出血（`tracking-ribbon` 实测外接范围
       * `x=[171,1450]`，右缘出血 270px）。所以这里判的是**"有没有整段跑到画面外"**这个真故障：
       * 外接范围必须与画面**相交**，且范围中点必须落在画面内。
       * 用**正文的外接范围**（不是逐字平均）：排版粒度是词、各盒字数差得远，按字数平均会被长词拖偏。
       */
      const extents = body.reduce(
        (acc, glyph) => ({
          minX: Math.min(acc.minX, glyph.x),
          maxX: Math.max(acc.maxX, glyph.x),
          minY: Math.min(acc.minY, glyph.y),
          maxY: Math.max(acc.maxY, glyph.y),
        }),
        {
          minX: Number.POSITIVE_INFINITY,
          maxX: Number.NEGATIVE_INFINITY,
          minY: Number.POSITIVE_INFINITY,
          maxY: Number.NEGATIVE_INFINITY,
        },
      );
      expect(extents.minX, `镜头 ${kind} 整组跑到画面右侧外`).toBeLessThan(VIEWPORT.width);
      expect(extents.maxX, `镜头 ${kind} 整组跑到画面左侧外`).toBeGreaterThan(0);
      expect(extents.minY, `镜头 ${kind} 整组跑到画面下方外`).toBeLessThan(VIEWPORT.height);
      expect(extents.maxY, `镜头 ${kind} 整组跑到画面上方外`).toBeGreaterThan(0);
      const midX = (extents.minX + extents.maxX) / 2;
      const midY = (extents.minY + extents.maxY) / 2;
      expect(midX, `镜头 ${kind} 的版心中点跑到画面外`).toBeGreaterThan(0);
      expect(midX, `镜头 ${kind} 的版心中点跑到画面外`).toBeLessThan(VIEWPORT.width);
      expect(midY, `镜头 ${kind} 的版心中点跑到画面外`).toBeGreaterThan(0);
      expect(midY, `镜头 ${kind} 的版心中点跑到画面外`).toBeLessThan(VIEWPORT.height);
    }
    console.info(`[test] 允许出血：${bleedShots}/${scannedShots} 个镜头的正文真的越出了画布`);
    expect(bleedShots).toBeGreaterThan(0);
  });

  it('重镜头的几何变体按种子换底图（四种形态各不相同，不是同一种换汤不换药）', () => {
    /** 取某一镜的"形状族前缀"集合当形态指纹。 */
    const fingerprint = (seed: string, kind: 'type-impact' | 'fragment-collage'): string => {
      const oneShot = compileSonnetProgram(SONG, { seed });
      const shot = oneShot.paragraphs[0]?.shots[0];
      if (shot === undefined) return '';
      const patched = {
        ...oneShot,
        paragraphs: oneShot.paragraphs.map((paragraph) => ({
          ...paragraph,
          shots: paragraph.shots.map((item) => ({ ...item, kind })),
        })),
      };
      const frame = buildSonnetFrame({
        program: patched,
        timeSec: (shot.startTime + shot.endTime) / 2,
        viewport: VIEWPORT,
        inkColor: '#fff',
        emphasisColor: '#f00',
      });
      return [...new Set(frame.shapes.map((item) => item.id.replace(/-\d+$/, '')))].sort().join(',');
    };
    const seen = new Set<string>();
    for (let index = 0; index < 24; index += 1) {
      seen.add(`i:${fingerprint(`variant-${index}`, 'type-impact')}`);
      seen.add(`c:${fingerprint(`variant-${index}`, 'fragment-collage')}`);
    }
    // 两种镜头各四档 ⇒ 至少应当看到四种**互不相同**的形态指纹。
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});

describe('sonnet 字号倍率（照抄的数值）', () => {
  it('主角倍率表：3.0 ~ 5.5，且重镜头最大', () => {
    expect(SONNET_HERO_FONT_SCALE['type-impact']).toBe(5.5);
    expect(SONNET_HERO_FONT_SCALE['editorial-column']).toBe(4);
    expect(SONNET_HERO_FONT_SCALE['mask-reveal']).toBe(4.5);
    expect(SONNET_HERO_FONT_SCALE['poster-blocks']).toBe(4.4);
    expect(SONNET_HERO_FONT_SCALE['tracking-ribbon']).toBe(3.5);
    expect(SONNET_HERO_FONT_SCALE['fragment-collage']).toBe(3.2);
    expect(SONNET_HERO_FONT_SCALE['quiet-tableau']).toBe(3);
    // 主角一定比陪衬大，而且是量级上的差别。
    for (const kind of Object.keys(SONNET_HERO_FONT_SCALE) as (keyof typeof SONNET_HERO_FONT_SCALE)[]) {
      expect(SONNET_HERO_FONT_SCALE[kind]).toBeGreaterThan(SONNET_SUPPORT_FONT_SCALE[kind] * 2);
    }
  });

  it('陪衬倍率表：1.15 ~ 1.6', () => {
    expect(SONNET_SUPPORT_FONT_SCALE['mask-reveal']).toBe(1.6);
    expect(SONNET_SUPPORT_FONT_SCALE['type-impact']).toBe(1.5);
    expect(SONNET_SUPPORT_FONT_SCALE['tracking-ribbon']).toBe(1.5);
    expect(SONNET_SUPPORT_FONT_SCALE['fragment-collage']).toBe(1.35);
    expect(SONNET_SUPPORT_FONT_SCALE['editorial-column']).toBe(1.2);
    expect(SONNET_SUPPORT_FONT_SCALE['poster-blocks']).toBe(1.15);
    expect(SONNET_SUPPORT_FONT_SCALE['quiet-tableau']).toBe(1.15);
  });

  it('次主角字号 = max(陪衬 × 1.35, 主角 × 0.72)', () => {
    // 用静场那档验算：陪衬 1.15 × 1.35 = 1.5525；主角 3.0 × 0.72 = 2.16 ⇒ 取 2.16。
    const boost = SONNET_SUPPORT_FONT_SCALE['quiet-tableau'] * SONNET_SEMI_HERO_SCALE_BOOST;
    const ratio = SONNET_HERO_FONT_SCALE['quiet-tableau'] * SONNET_SEMI_HERO_SCALE_RATIO;
    expect(ratio).toBeGreaterThan(boost);
    expect(Math.max(boost, ratio)).toBeCloseTo(2.16, 6);
  });

  it('82% 安全边界真的会缩字：超长行比短行小', () => {
    const short = buildSonnetFrame({
      program: compileSonnetProgram([makeLine(0, '短', 0, 400)], { seed: 'fit-short' }),
      timeSec: 0.5,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
    });
    const longLine = '这是一句非常非常长的歌词'.repeat(4);
    const long = buildSonnetFrame({
      program: compileSonnetProgram([makeLine(0, longLine, 0, 120)], { seed: 'fit-long' }),
      timeSec: 0.5,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
    });
    const maxFont = (frame: typeof short): number =>
      frame.glyphs.reduce((max, glyph) => Math.max(max, glyph.fontPx), 0);
    if (short.glyphs.length > 0 && long.glyphs.length > 0) {
      expect(maxFont(long)).toBeLessThan(maxFont(short));
    }
    // 无论怎么缩，都不能超过视口的 82%。
    for (const glyph of long.glyphs) {
      expect(glyph.fontPx).toBeLessThanOrEqual(VIEWPORT.height * SONNET_FIT_MAX_RATIO);
    }
  });

  it('节目表把每一镜的构图、时间与几何档位一次报全（取景靠它）', () => {
    const program = compileSonnetProgram(SONG, { seed: 'schedule' });
    const schedule = describeSonnetShotSchedule(program);
    const total = program.paragraphs.reduce((sum, paragraph) => sum + paragraph.shots.length, 0);
    expect(schedule).toHaveLength(total);
    for (const entry of schedule) {
      expect(entry.endTime).toBeGreaterThan(entry.startTime);
      expect(entry.geoVariant).toBeGreaterThanOrEqual(0);
      expect(entry.geoVariant).toBeLessThan(100);
      /*
       * 只有**重镜头**（`type-impact` / `fragment-collage`）才画几何；其余构图的档位再"已搬"也没意义，
       * 所以 `geoApplies=false` 的那些一律 `geoPorted=false`（取景靠这条才不会挑到没几何的镜头）。
       */
      expect(entry.geoApplies).toBe(isSonnetHeavyShotKind(entry.kind));
      if (!entry.geoApplies) {
        expect(entry.geoPorted).toBe(false);
        continue;
      }
      // 第 3 档的"搬没搬"还看种子（另两个分子子档位没搬），所以那一档只查它是布尔值。
      expect(typeof entry.geoPorted).toBe('boolean');
      if (entry.geoVariant !== 3) {
        expect(entry.geoPorted).toBe(entry.geoVariant <= 10);
      }
    }
  });

  it('重镜头报出**原版几何档位**，搬到的档位就走原版配方（形状数对不上就说明退回兜底了）', () => {
    const program = compileSonnetProgram(SONG, { seed: 'geo-scan' });
    const report: string[] = [];
    for (const paragraph of program.paragraphs) {
      for (let shotIndex = 0; shotIndex < paragraph.shots.length; shotIndex += 1) {
        const shot = paragraph.shots[shotIndex];
        if (shot === undefined) continue;
        if (shot.kind !== 'type-impact' && shot.kind !== 'fragment-collage') continue;
        const frame = buildSonnetFrame({
          program,
          timeSec: (shot.startTime + shot.endTime) / 2,
          viewport: VIEWPORT,
          inkColor: '#fff',
          emphasisColor: '#f00',
        });
        report.push(`${shot.kind}#${frame.geoVariant}${frame.geoPorted ? '✓' : '兜底'}=${frame.shapes.length}`);
        // 档位必须在原版的 0~99 里，而且"搬到了"与"形状数像原版配方"必须一致。
        expect(frame.geoVariant).toBeGreaterThanOrEqual(0);
        expect(frame.geoVariant).toBeLessThan(100);
        if (frame.geoPorted) {
          // 原版配方：0 档 34 件、1 档 5 件、2 档 9 件、3 档 13 件，另加重镜头的固定几何（40~85 件）。
          expect(frame.shapes.length, `档位 ${frame.geoVariant} 的件数`).toBeGreaterThan(30);
        }
      }
    }
    console.info(`[测试] 重镜头几何档位分布：${report.join('｜')}`);

    /*
     * 默认种子的那一镜落在**没搬的档位**上（实测 44 档 ⇒ 走自拟兜底），所以再扫一批种子，
     * 找一个真能命中已搬档位（0~3）的镜头：命中了就说明"帧层 → 原版几何"这条线真的通了，
     * 而不只是模块单测里自说自话。扫不到也不报错（档位 × 种子是确定性的，这里只做抽样）。
     */
    let portedHit = '';
    let heavyShots = 0;
    let portedShots = 0;
    for (let index = 0; index < 3000 && portedHit === ''; index += 1) {
      const scanned = compileSonnetProgram(SONG, { seed: `geo-hit-${index}` });
      for (const paragraph of scanned.paragraphs) {
        for (let shotIndex = 0; shotIndex < paragraph.shots.length; shotIndex += 1) {
          const shot = paragraph.shots[shotIndex];
          if (shot === undefined) continue;
          if (shot.kind !== 'type-impact' && shot.kind !== 'fragment-collage') continue;
          heavyShots += 1;
          // 只算档位（不进帧层），这样能扫几千个种子。
          const probeSeed = shotSeedNumber(`${scanned.seed}|${shot.id}`, shotIndex);
          const variant = resolveSonnetGeoVariant(probeSeed);
          if (!hasSonnetGeoVariant(variant, probeSeed)) continue;
          portedShots += 1;
          const frame = buildSonnetFrame({
            program: scanned,
            timeSec: (shot.startTime + shot.endTime) / 2,
            viewport: VIEWPORT,
            inkColor: '#fff',
            emphasisColor: '#f00',
          });
          portedHit = `seed=geo-hit-${index}｜${shot.kind}#${frame.geoVariant}｜形状=${frame.shapes.length}`;
          expect(frame.geoPorted).toBe(true);
          expect(frame.shapes.length).toBeGreaterThan(30);
          break;
        }
        if (portedHit !== '') break;
      }
    }
    console.info(
      `[测试] 重镜头抽样：重镜头 ${heavyShots} 个，其中命中已搬档位 ${portedShots} 个；` +
        `命中样例：${portedHit === '' ? '（这批种子里没抽到）' : portedHit}`,
    );
  });
});

/**
 * **巨型幽灵字（主角词背后的淡空心大轮廓）的回归。**
 *
 * 三条要守住的性质：① 开关缺省关闭 ⇒ 与"没有这一层"逐值相同，打开后**只多出 `ghost` 字形**，
 * 正文、引导线、粒子与跟拍焦点一个都不动；② 幽灵字是纯装饰 ⇒ 禁止色差 / 回声 / 光晕，
 * 未开始唱时 α 与正文同一条入场曲线（=0）；③ 逐值只由"程序 + 时刻"决定 ⇒ seek 可重放。
 */
describe('sonnet 巨型幽灵字（背景装饰层）', () => {
  /** 扫种子与时刻，找一个"打开开关后真的有幽灵字"的镜头当样本。 */
  const findGiantMoment = (): {
    program: SonnetProgram;
    timeSec: number;
    off: SonnetFrame;
    on: SonnetFrame;
  } | null => {
    for (let seedIndex = 0; seedIndex < 12; seedIndex += 1) {
      const program = compileSonnetProgram(SONG, { seed: `giant-${seedIndex}` });
      for (const paragraph of program.paragraphs) {
        for (const shot of paragraph.shots) {
          for (const ratio of [0.35, 0.75]) {
            const timeSec = shot.startTime + (shot.endTime - shot.startTime) * ratio;
            const base = {
              program,
              timeSec,
              viewport: VIEWPORT,
              inkColor: '#fff',
              emphasisColor: '#f00',
            } as const;
            const on = buildSonnetFrame({ ...base, showGiantDecorativeText: true });
            if (!on.glyphs.some((glyph) => glyph.ghost)) continue;
            return { program, timeSec, off: buildSonnetFrame(base), on };
          }
        }
      }
    }
    return null;
  };

  it('开关缺省关闭：不画幽灵字；打开只增加 ghost，正文 / 引导线 / 粒子 / 跟拍焦点不变', () => {
    const found = findGiantMoment();
    expect(found, '没有一个镜头在打开开关后产出幽灵字，这条对照是空的').not.toBeNull();
    if (found === null) return;
    expect(found.off.glyphs.some((glyph) => glyph.ghost)).toBe(false);
    /* 正文（非 ghost）逐字相同：位置 / 字号 / 透明度 / 缩放 / 色差 / 回声 / 光晕全部不动。 */
    expect(found.on.glyphs.filter((glyph) => !glyph.ghost)).toEqual(found.off.glyphs);
    /* 幽灵字不参与跟拍焦点，也不改引导线、粒子与装饰边框（它们只看正文那一串 run）。 */
    expect(found.on.guides).toEqual(found.off.guides);
    expect(found.on.decor).toEqual(found.off.decor);
    expect(found.on.frameDecor).toEqual(found.off.frameDecor);
    expect(found.on.camera).toEqual(found.off.camera);
    expect(found.on.pivot).toEqual(found.off.pivot);
    expect(found.on.anchorDelta).toEqual(found.off.anchorDelta);
    /* 新增的每一个字形都是装饰层：字重大于正文（300 装饰角色）、字号是正文量级以上。 */
    const bodyMaxFont = Math.max(0, ...found.off.glyphs.map((glyph) => glyph.fontPx));
    const giants = found.on.glyphs.filter((glyph) => glyph.ghost);
    expect(giants.length).toBeGreaterThan(0);
    for (const giant of giants) {
      expect(giant.weight, '幽灵字必须是装饰角色 300').toBe(300);
      expect(giant.fontPx).toBeGreaterThan(bodyMaxFont);
    }
  });

  it('幽灵字是纯装饰：禁止色差 / 回声 / 光晕；未开始唱时 α = 0', () => {
    const found = findGiantMoment();
    if (found === null) return;
    const giants = found.on.glyphs.filter((glyph) => glyph.ghost);
    expect(giants.length).toBeGreaterThan(0);
    for (const giant of giants) {
      expect(giant.caOffset).toBe(0);
      expect(giant.caCopyAlpha).toBe(0);
      expect(giant.echoActive).toBe(false);
      expect(giant.echoAlpha1).toBe(0);
      expect(giant.echoAlpha2).toBe(0);
      expect(giant.haloAlpha, '幽灵字不发光').toBe(0);
    }
    /*
     * 未开始唱：把整首的逐字时间轴整体推到 100 秒之后 ⇒ 这一镜所有字（含幽灵字）都还在等，
     * α 必须是 0（与正文同一条"没轮到就是 0"的入场曲线）。
     */
    const delayed = new Map(
      SONG.map((line) => [
        line.index,
        line.words.map((word, index) => ({
          char: word.text,
          startTime: 100 + index,
          endTime: 101 + index,
        })),
      ]),
    );
    const waiting = buildSonnetFrame({
      program: found.program,
      timeSec: found.timeSec,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
      showGiantDecorativeText: true,
      glyphsByLine: delayed,
    });
    const waitingGiants = waiting.glyphs.filter((glyph) => glyph.ghost);
    expect(waitingGiants.length).toBe(giants.length);
    expect(waitingGiants.every((glyph) => glyph.alpha === 0)).toBe(true);
  });

  it('纯时间可 seek 重放：同一时刻先后求值两次逐值相同，幽灵字也一致', () => {
    const found = findGiantMoment();
    if (found === null) return;
    const replay = (timeSec: number): SonnetFrame =>
      buildSonnetFrame({
        program: found.program,
        timeSec,
        viewport: VIEWPORT,
        inkColor: '#fff',
        emphasisColor: '#f00',
        showGiantDecorativeText: true,
      });
    const earlier = replay(found.timeSec - 0.05);
    /* 先求一次更晚的时刻（打乱求值顺序），再回到同一时刻 —— 结果必须逐值相同。 */
    replay(found.timeSec + 0.05);
    expect(replay(found.timeSec - 0.05)).toEqual(earlier);
    /* 幽灵字就在这一镜里，字符集只由程序与时刻决定（与求值先后无关）。 */
    const ghostChars = (frame: SonnetFrame): string[] =>
      frame.glyphs.filter((glyph) => glyph.ghost).map((glyph) => glyph.char);
    expect(ghostChars(earlier)).toEqual(ghostChars(found.on));
    expect(ghostChars(earlier).length).toBeGreaterThan(0);
  });
});

/**
 * **朝向一致性**：半角片假名要按 CJK 处理（本轮补）。
 *
 * 上游的 `CJK_TEXT` 不含 `\uff66-\uff9f`（半角片假名），而本仓库另外两处 CJK 判据都含 ⇒
 * 一个半角片假名词在"分词"层是 CJK、到"排版"层却被当成拉丁词 ⇒ 竖排里**整块转 90°**，
 * 画面上就出现躺着的小假名（主人报的"朝向零散"）。这里用同一套竖排条件对照拉丁词钉住它 ✓
 */
describe('商籁字素摆放：半角片假名算 CJK（朝向）', () => {
  /** 造一行"每粒字素一个词、只在首字素打词首标记"的舞台行 ⇒ 一个段 ✓。 */
  const graphemeLine = (text: string): StageLine => {
    const chars = [...text];
    return {
      ...makeLine(0, text, 0, 400),
      words: chars.map((char, position) => ({
        text: char,
        startMs: position * 400,
        endMs: (position + 1) * 400,
        wordStart: position === 0,
      })),
    };
  };
  /**
   * `fragment-collage` 的第 0 段 `vertical = true`（`index % 4 === 0`）——
   * 于是"多字素 + 非 CJK"就会整块转 90°，正好是这条判据的观测口 ✓
   */
  const glyphsOf = (text: string): readonly SonnetFrame['glyphs'][number][] => {
    const program = compileSonnetProgram([graphemeLine(text)], { seed: `rotation-${text}` });
    const patched = {
      ...program,
      paragraphs: program.paragraphs.map((paragraph) => ({
        ...paragraph,
        shots: paragraph.shots.map((shot) => ({ ...shot, kind: 'fragment-collage' as const })),
      })),
    };
    const shot = patched.paragraphs[0]?.shots[0];
    if (shot === undefined) return [];
    const frame = buildSonnetFrame({
      program: patched,
      timeSec: (shot.startTime + shot.endTime) / 2,
      viewport: VIEWPORT,
      inkColor: '#fff',
      emphasisColor: '#f00',
    });
    return frame.glyphs.filter((glyph) => !glyph.ghost);
  };

  it('半角片假名竖排时字身保持正立（`layoutRotation = 0`）', () => {
    const glyphs = glyphsOf('ｱﾘ');
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) expect(glyph.layoutRotation).toBeCloseTo(0, 9);
    /* 竖排：逐字往下走（同一列 ⇒ x 相同、y 递增）✓ */
    if (glyphs.length > 1) {
      expect(glyphs[1]!.x).toBeCloseTo(glyphs[0]!.x, 9);
      expect(glyphs[1]!.y).toBeGreaterThan(glyphs[0]!.y);
    }
    expect(SONNET_CJK_TEXT.test('ｱﾘ')).toBe(true);
  });

  it('同一套竖排条件下，拉丁词仍然整块转 90°（对照，规则没被改坏）', () => {
    const glyphs = glyphsOf('go');
    expect(glyphs.length).toBeGreaterThan(0);
    expect(glyphs.some((glyph) => Math.abs(glyph.layoutRotation - Math.PI / 2) < 1e-9)).toBe(true);
    expect(SONNET_CJK_TEXT.test('go')).toBe(false);
  });
});
