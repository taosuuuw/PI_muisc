/**
 * 云阶（partita）行级微调的**位置稳定性**（用户第 5 轮第 3 条，长期保留）。
 *
 * 用户原话：「同一面的不同引导线的歌词应该**提前划好位置**，而不是后出现的歌词干扰到已经出现的歌词」。
 * 对应的机器判据只有一条，但很硬：**每块的位置（`x` / `y`）与楼梯盒高，与「现在高亮哪一块」无关**。
 *
 * 旧写法把 `currentScale`（1.25~1.6）乘进 `multipliers` 再算墨迹半高，而行距是「相邻两块墨迹半高
 * 之和 × 0.88」逐块累加的 —— 于是高亮每往前挪一块，整段楼梯的纵向间距跟着变一次，已经出现的那几块
 * 被推着挪位（`.pi-lyricpartita__col` 上有 0.42s 的 transform 过渡，肉眼就是「被后来居上的那块挤走」）。
 * 现在布局只用含抖动的基准倍率，当前位置只决定**渲染字号**。
 *
 * 用 `estimateTextWidth` 当桩字体（组件里 `measureTextWidth` 在无 canvas 的环境下同样回退到它），
 * 所以不需要 DOM / canvas，纯函数可复现。
 */

import { describe, expect, it } from 'vitest';
import {
  buildTunePlan,
  hotWordIndexesOf,
  partitaActiveScaleOf,
  partitaHotMsOf,
  partitaHotOutMsOf,
  partitaWordStatesOf,
  type PartitaTunePlan,
} from './PartitaTheme';
import { PARTITA_ACTIVE_SCALE, layoutPartitaLine, type PartitaLayoutPlan } from './partitaLayout';
import { estimateTextWidth, type StageLine, type StageWord, type WordState } from './types';

const words = (line: string): StageWord[] =>
  Array.from(line).map((text) => ({ text, startMs: 0, endMs: 0 }));

/** 舞台取应用窗口的常见尺寸；错位上下界取设置默认值（`DEFAULT_LYRIC_TUNING`：20 / 100）。 */
const STAGE = { width: 1280, height: 720 } as const;
const SEED = 12_345;

function planOf(line: string, chaotic = false): PartitaLayoutPlan {
  return layoutPartitaLine({
    words: words(line),
    stageWidth: STAGE.width,
    stageHeight: STAGE.height,
    fontFamily: 'x',
    chaotic,
    fontScale: 1,
    motionAmount: 1,
    seed: SEED,
    measure: (text: string, fontPx: number) => estimateTextWidth(text, fontPx, 0),
  });
}

function tuneOf(plan: PartitaLayoutPlan): PartitaTunePlan {
  return buildTunePlan(plan, {
    seed: SEED,
    stageWidth: STAGE.width,
    stageHeight: STAGE.height,
    fontFamily: 'x',
    guides: true,
    staggerMin: 20,
    staggerMax: 100,
    motionAmount: 1,
  });
}

/** 参考句：10 个字素 → 3~4 块，正好够「楼梯中间/两端被高亮」三种情形。 */
const LINE = '誰かの陰謀みたいに';

/**
 * 造一行「按词分组」的歌词：`groups` 每一项是一个词。
 * 每个词的首字素带 `wordStart`（与 `LyricStage` 的 `timedWords` 同一口径）。
 */
function wordLine(groups: readonly string[]): StageLine {
  const words: StageWord[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  groups.forEach((group, groupIndex) => {
    Array.from(group).forEach((text, charIndex) => {
      const startMs = groupIndex * 1000;
      const endMs = startMs + 800;
      words.push({ text, startMs, endMs, wordStart: charIndex === 0 });
      starts.push(startMs);
      ends.push(endMs);
    });
  });
  return {
    index: 0,
    timeMs: 0,
    text: groups.join(' '),
    durationMs: groups.length * 1000,
    hint: 'normal',
    words,
    starts,
    ends,
  };
}

describe('partita 高光交接时长跟着字素时值走（用户第 8 轮第 2 条）', () => {
  it('渐入 + 停留 + 渐出（三倍交接时长）永远不超过这颗字自己的时值', () => {
    for (const windowMs of [120, 180, 240, 300, 400, 600, 900, 1200, 2000]) {
      const hot = partitaHotMsOf(windowMs);
      // 下限附近（时值很短）允许超出：那是「再短就不是渐变」的地板，宁可让它稍长。
      if (windowMs >= 400) expect(hot * 3).toBeLessThanOrEqual(windowMs + 1);
      expect(hot).toBeGreaterThanOrEqual(110);
      expect(hot).toBeLessThanOrEqual(340);
    }
  });

  it('慢歌取上限、快歌取下限，中间线性', () => {
    expect(partitaHotMsOf(3000)).toBe(340);
    expect(partitaHotMsOf(0)).toBe(110);
    expect(partitaHotMsOf(1000)).toBeCloseTo(300, 0);
  });

  it('渐出不低于 480ms（第十五轮第 4 条「颜色逐渐淡去」那条 ≥400ms 判据的地板）', () => {
    for (const windowMs of [0, 120, 400, 1000, 3000]) {
      expect(partitaHotOutMsOf(windowMs)).toBeGreaterThanOrEqual(400);
      expect(partitaHotOutMsOf(windowMs)).toBeGreaterThanOrEqual(partitaHotMsOf(windowMs));
    }
  });
});

describe('partita 高光按词（用户第 8 轮第 1 条）', () => {
  it('拉丁单词整词一起亮（不是字母一个一个亮）', () => {
    const line = wordLine(['havetokeephiding', 'me']);
    // 第 4 个字母是 active（词内第 4 个）。
    const states: WordState[] = line.words.map((_, index) =>
      index < 3 ? 'passed' : index === 3 ? 'active' : 'waiting',
    );
    const hot = hotWordIndexesOf(line, states, true);
    expect(hot).not.toBeNull();
    // 第一个词的全部字母都在高光里，第二个词一个都不在。
    expect([...(hot ?? [])].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 'havetokeephiding'.length }, (_, index) => index),
    );
  });

  it('中文一词一字：高光仍然只有一个字', () => {
    const line = wordLine(['誰', 'か', 'の']);
    const states: WordState[] = ['passed', 'active', 'waiting'];
    const hot = hotWordIndexesOf(line, states, true);
    expect([...(hot ?? [])]).toEqual([1]);
  });

  it('整行一个词标记都没有（普通 LRC）时，一个词就是一个字素', () => {
    // 冒烟探针抓到的真 bug：老写法在这种情况下会一路走到行尾、把整行当一个词，同帧三块挂高光。
    const line = wordLine(['誰', 'か', 'の']);
    const bare: StageLine = {
      ...line,
      words: line.words.map((word) => ({
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
      })),
    };
    const hot = hotWordIndexesOf(bare, ['passed', 'active', 'waiting'], true);
    expect([...(hot ?? [])]).toEqual([1]);
  });

  it('没有 active / 不是当前行时没有高光', () => {
    const line = wordLine(['ab', 'cd']);
    expect(hotWordIndexesOf(line, ['passed', 'passed', 'passed', 'passed'], true)).toBeNull();
    expect(hotWordIndexesOf(line, ['active', 'waiting', 'waiting', 'waiting'], false)).toBeNull();
  });
});

describe('partita 行级微调：位置提前划定（用户第 5 轮第 3 条）', () => {
  it('高亮换到任何一块，每块的 x / y / 字号 / 楼梯盒高都一个像素都不动', () => {
    const plan = planOf(LINE);
    const base = tuneOf(plan);
    expect(base.rows.length).toBeGreaterThanOrEqual(3);
    // **用户本轮第 1 条**之后，`buildTunePlan` 连 `currentBlock` 这个入参都不再需要 ——
    // 位置与字号全部提前划定（「当前」只影响正在唱的那一个字自己的 `--pw-active-scale`）。
    for (let index = 0; index < base.rows.length; index += 1) {
      expect(base.rows[index]?.fontPx).toBeGreaterThan(0);
    }
    expect(base.currentScale).toBeGreaterThanOrEqual(1.25);
    expect(base.currentScale).toBeLessThanOrEqual(1.6);
  });

  it('字号只吃逐块抖动：不同块确实不一样大，但没有任何一块被「当前」放大', () => {
    const plan = planOf(LINE);
    const tune = tuneOf(plan);
    const ratios = tune.rows.map((row) => row.fontPx / row.mult);
    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0] ?? 0, 6);
    // 逐块倍率（== 渲染倍率，不再含 currentScale）落在 ±20% 的抖动区间里。
    for (const row of tune.rows) {
      expect(row.mult).toBeGreaterThanOrEqual(0.8);
      expect(row.mult).toBeLessThanOrEqual(1.2);
    }
    const distinct = new Set(tune.rows.map((row) => Math.round(row.fontPx)));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });

  it('放大跟着「正在唱的那一个字」：唱完立刻回落（用户本轮第 1 条）', () => {
    const plan = planOf(LINE);
    const tune = tuneOf(plan);
    // 正在唱 ⇒ 峰值 = 布局放大 × currentScale（与改造前那一颗字的总放大逐位相同）。
    expect(partitaActiveScaleOf('active', tune.currentScale)).toBeCloseTo(
      PARTITA_ACTIVE_SCALE * tune.currentScale,
      6,
    );
    expect(partitaActiveScaleOf('active', tune.currentScale)).toBeGreaterThanOrEqual(1.5);
    // 唱过 / 还没唱 ⇒ 只剩布局那一档，绝不带 currentScale —— 「单个字唱完就恢复大小」。
    expect(partitaActiveScaleOf('passed', tune.currentScale)).toBe(PARTITA_ACTIVE_SCALE);
    expect(partitaActiveScaleOf('waiting', tune.currentScale)).toBe(PARTITA_ACTIVE_SCALE);
  });

  it('刻度线的宽与高都只跟布局字号走：唱到哪一块、放大落在哪一个字上，线都一动不动', () => {
    const plan = planOf(LINE);
    const tune = tuneOf(plan);
    tune.rows.forEach((row) => {
      // 刻度线的高度 = 布局字号 × 1.22（1.22 = CSS 的 `line-height`）。
      // 这条同时证明 `row.fontPx` **就是布局字号**：`guideHeight` 在 `measureAt` 里是按
      // 「布局字号 × 1.22」算的，两者相等 ⇒ 渲染字号里没有掺 `currentScale`。
      expect(row.guideHeight).toBeCloseTo(row.fontPx * 1.22, 4);
      expect(row.guideWidth).toBeGreaterThan(0);
    });
  });

  it('任何一块被高亮，整段楼梯（含刻度线外沿）都不会出舞台', () => {
    const plan = planOf(LINE);
    const guides = { x: 18, y: 16 };
    const tune = tuneOf(plan);
    for (const row of tune.rows) {
      // 预留算进夹逼 ⇒ 放大后的块也在「舞台宽 − 64」的预算里。
      expect(Math.abs(row.x)).toBeLessThanOrEqual(STAGE.width / 2 - 32);
      expect(Math.abs(row.y)).toBeLessThan(STAGE.height / 2);
    }
    expect(tune.boxHeight).toBeGreaterThan(0);
    expect(guides.x).toBeGreaterThan(0);
  });
});

describe('partita 放大按词（用户本轮第 1 条）', () => {
  it('拉丁单词整词同态：字母一起亮、一起放大、一起回落', () => {
    const first = 'havetokeephiding';
    const line = wordLine([first, 'me']);
    const firstLen = first.length;
    // 第 4 个字母正在唱：整词的 16 个字母都该是 active，第二个词 still waiting。
    const raw: WordState[] = line.words.map((_, index) =>
      index < 3 ? 'passed' : index === 3 ? 'active' : 'waiting',
    );
    const grouped = partitaWordStatesOf(line, raw);
    expect(grouped.slice(0, firstLen).every((state) => state === 'active')).toBe(true);
    expect(grouped.slice(firstLen).every((state) => state === 'waiting')).toBe(true);
    // 词尾字母唱完 ⇒ 整词一起落下（不是一颗一颗落）。
    const done: WordState[] = line.words.map((_, index) =>
      index < firstLen ? 'passed' : index === firstLen ? 'active' : 'waiting',
    );
    const groupedDone = partitaWordStatesOf(line, done);
    expect(groupedDone.slice(0, firstLen).every((state) => state === 'passed')).toBe(true);
    expect(groupedDone.slice(firstLen).every((state) => state === 'active')).toBe(true);
  });

  it('中文一词一字：逐位等于输入（一行上仍然只有一个字是 active）', () => {
    const line = wordLine(['誰', 'か', 'の']);
    const raw: WordState[] = ['passed', 'active', 'waiting'];
    expect(partitaWordStatesOf(line, raw)).toEqual(raw);
  });

  it('整行一个词标记都没有（普通 LRC）时原样返回，不会把整行并成一个词', () => {
    const line = wordLine(['誰', 'か', 'の']);
    const bare: StageLine = {
      ...line,
      words: line.words.map((word) => ({
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
      })),
    };
    const raw: WordState[] = ['passed', 'active', 'waiting'];
    expect(partitaWordStatesOf(bare, raw)).toEqual(raw);
  });

  /**
   * **用户本轮第 1 条（第二遍）**：普通 LRC 的**英文**行（一行一个 `wordStart` 都没有）
   * 也必须整词合并 —— 上一版分组只认 `wordStart`，这种行会原样返回，于是「一个原子整词一起冒」
   * 的渲染配上「逐字母算」的三态：词首还在 waiting、词中间的字母已经 active，
   * 一个单词一半透明一半亮，放大也各放各的（用户看到的「单词里的字母单独放大」）。
   */
  it('普通 LRC 的英文行也按「连续字母段」整词合并（不靠 wordStart）', () => {
    /*
     * 真实舞台这一行长这样：`leave me` —— 字母与**空格本身**都是字素（`segmentGraphemes`），
     * 而普通 LRC 一个 `wordStart` 标记都没有。所以这里手工造一行带空格的、无标记的字素序列
     *（`wordLine` 造的是「无空格 + 带标记」那一种，正好是另一条路径）。
     */
    const words: StageWord[] = [];
    const raw: WordState[] = [];
    const push = (text: string, state: WordState): void => {
      const start = words.length * 100;
      words.push({ text, startMs: start, endMs: start + 90 });
      raw.push(state);
    };
    const letters = (text: string, states: readonly WordState[]): void => {
      Array.from(text).forEach((char, index) => {
        push(char, states[index] ?? 'waiting');
      });
    };
    letters('leave', ['passed', 'active', 'waiting', 'waiting', 'waiting']);
    push(' ', 'waiting');
    letters('me', ['waiting', 'waiting']);
    const bare: StageLine = {
      index: 0,
      timeMs: 0,
      text: 'leave me',
      durationMs: 2000,
      hint: 'normal',
      words,
      starts: words.map((word) => word.startMs),
      ends: words.map((word) => word.endMs),
    };
    const grouped = partitaWordStatesOf(bare, raw);
    // `leave` 的五个字母整词变成 active（第 2 个字母在唱）。
    expect(grouped.slice(0, 5)).toEqual(['active', 'active', 'active', 'active', 'active']);
    // 空格不参与合并，`me` 仍未开口。
    expect(grouped.slice(5)).toEqual(['waiting', 'waiting', 'waiting']);
    // 高光同一套分组：整词的字素都在集合里。
    const hot = hotWordIndexesOf(bare, grouped, true);
    expect(hot).toEqual(new Set([0, 1, 2, 3, 4]));
  });
});
