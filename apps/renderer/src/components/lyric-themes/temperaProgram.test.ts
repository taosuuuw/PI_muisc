/**
 * 凝彩（tempera）**program 编译器**的自查（长期保留，`pnpm test` 的默认 include 会自动收进来）。
 *
 * 这一层是纯数据：把歌词编成「段落 → shot → slice」。它决定 runtime 什么时候切镜、
 * 用哪种构图、镜头往哪走、装饰从哪来 —— 编错了渲染层再对也是错的，所以这里逐条钉：
 * 段落断点、段落类型、shot 词数、时间轴铺满、bridge 填隙、转场时长、确定性与 flow 收敛。
 */

import { describe, expect, it } from 'vitest';
import type { Hint, StageLine, StageWord } from './types';
import {
  TEMPERA_BRIDGE_MAX_LENGTH,
  TEMPERA_BRIDGE_MIN_GAP,
  buildTemperaSegments,
  classifyParagraph,
  compileTemperaLines,
  compileTemperaProgram,
  findTemperaParagraphIndexAtTime,
  findTemperaShotAtTime,
  hashTemperaSeed,
  resolveTemperaParagraphGapThreshold,
  resolveTemperaTransitionDuration,
  temperaHash01,
} from './temperaProgram';

/** 造一行：`words` 是逐字素（`wordStart` 标记词边界），时间单位毫秒。 */
function makeLine(
  index: number,
  timeMs: number,
  text: string,
  durationMs: number,
  words: readonly (Omit<StageWord, 'text'> & { text: string })[],
  hint: Hint = 'normal',
): StageLine {
  return {
    index,
    timeMs,
    text,
    durationMs,
    hint,
    words,
    starts: words.map((word) => word.startMs),
    ends: words.map((word) => word.endMs),
  };
}

/** 把一句话按「每字 0.2s」摊成字素，`perWord` 是每个词几个字。 */
function lineFromText(
  index: number,
  timeMs: number,
  text: string,
  perWord: number,
  stepMs = 200,
  hint: Hint = 'normal',
): StageLine {
  const chars = Array.from(text);
  const words = chars.map((char, charIndex) => ({
    text: char,
    startMs: timeMs + charIndex * stepMs,
    endMs: timeMs + (charIndex + 1) * stepMs,
    wordStart: charIndex % perWord === 0,
  }));
  return makeLine(index, timeMs, text, chars.length * stepMs, words, hint);
}

describe('tempera 分词与行编译', () => {
  it('按 wordStart 切词；标点黏着到前一个词上，不另起一个段', () => {
    // 「さようなら、」：词边界在 0 / 4，逗号属于第二个词之后。
    const line = makeLine(0, 0, 'さようなら、また', 3000, [
      { text: 'さ', startMs: 0, endMs: 200, wordStart: true },
      { text: 'よ', startMs: 200, endMs: 400 },
      { text: 'う', startMs: 400, endMs: 600 },
      { text: 'な', startMs: 600, endMs: 800 },
      { text: 'ら', startMs: 800, endMs: 1000 },
      { text: '、', startMs: 1000, endMs: 1000 },
      { text: 'ま', startMs: 1200, endMs: 1400, wordStart: true },
      { text: 'た', startMs: 1400, endMs: 1600 },
    ]);
    const segments = buildTemperaSegments(line);
    expect(segments.map((segment) => segment.text)).toEqual(['さようなら、', 'また']);
    expect(segments.map((segment) => segment.isWordLike)).toEqual([true, true]);
    // 逗号没有自己的时长，黏着时被钉到前一个词的尾部（1000ms），不能拖到后一个词的起点。
    expect(segments[0]?.endTime).toBeCloseTo(1, 6);
    expect(segments[1]?.startTime).toBeCloseTo(1.2, 6);
  });

  it('渲染尾不越到下一行里', () => {
    const a = lineFromText(0, 0, 'あい', 2, 200);
    const b = lineFromText(1, 1000, 'うえ', 2, 200);
    const compiled = compileTemperaLines([a, b]);
    // 第一行只唱 0.4s（两个字 × 0.2s），而下一行 1s 才开始 ⇒ 渲染尾就是 0.4s。
    expect(compiled[0]?.renderEndTime).toBeCloseTo(0.4, 6);
    // 第二行没有下一行，渲染尾是自己的 1.4s。
    expect(compiled[1]?.renderEndTime).toBeCloseTo(1.4, 6);
    // 紧凑排布时渲染尾被下一行的起点截住（绝不越过去）。
    const tight = compileTemperaLines([
      makeLine(0, 0, 'あい', 4000, [
        { text: 'あ', startMs: 0, endMs: 200, wordStart: true },
        { text: 'い', startMs: 200, endMs: 400 },
      ]),
      lineFromText(1, 600, 'うえ', 2, 200),
    ]);
    expect(tight[0]?.renderEndTime).toBeCloseTo(0.6, 6);
  });
});

describe('tempera 段落划分', () => {
  it('间隔阈值是 clamp(中位数 × 2.5, 1.25, 3.5)', () => {
    // 三行各留 1s 的间隔 ⇒ 中位数 1 ⇒ 2.5。
    const lines = [
      lineFromText(0, 0, 'あい', 2, 200),
      lineFromText(1, 1400, 'うえ', 2, 200),
      lineFromText(2, 2800, 'おか', 2, 200),
    ];
    const threshold = resolveTemperaParagraphGapThreshold(lines);
    expect(threshold).toBeCloseTo(2.5, 6);
    expect(resolveTemperaParagraphGapThreshold([])).toBeCloseTo(1.25, 6);
  });

  it('大间隔处断段，小间隔不断段', () => {
    const tight = [
      lineFromText(0, 0, 'あい', 2, 200),
      lineFromText(1, 600, 'うえ', 2, 200),
      lineFromText(2, 1200, 'おか', 2, 200),
    ];
    expect(compileTemperaProgram(tight, 'seed').paragraphs).toHaveLength(1);

    const loose = [
      lineFromText(0, 0, 'あい', 2, 200),
      lineFromText(1, 9000, 'うえ', 2, 200),
      lineFromText(2, 10000, 'おか', 2, 200),
    ];
    const program = compileTemperaProgram(loose, 'seed');
    expect(program.paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(program.paragraphs[1]?.boundary).toBe('time-gap');
    expect(program.paragraphs[0]?.boundary).toBe('song-start');
  });

  it('段落类型：重复句判副歌、最后一段判收尾、短段判换气', () => {
    const chorusLine = lineFromText(0, 0, 'きみのこえ', 2, 200);
    const other = lineFromText(1, 400, 'あめのひ', 2, 200);
    const repeat = lineFromText(2, 800, 'きみのこえ', 2, 200);
    const compiled = compileTemperaLines([chorusLine, other, repeat]);
    // 副歌标记必须来自**整曲**：只看本段那几行判不出「同一句重复 >1 次」。
    const flags = [true, false, true];
    expect(classifyParagraph([compiled[0] as never], 0, 3, flags)).toBe('chorus');
    expect(classifyParagraph([compiled[1] as never], 1, 3, flags)).not.toBe('chorus');
    // 不传标记时按「没有副歌」处理（老调用点不会因为多一个参数就改变行为）。
    expect(classifyParagraph([compiled[0] as never], 0, 3)).not.toBe('chorus');

    const short = compileTemperaLines([lineFromText(0, 0, 'あ', 1, 200)]);
    expect(classifyParagraph([short[0] as never], 0, 1)).toBe('outro');

    const breath = compileTemperaLines([
      lineFromText(0, 0, 'あい', 2, 200),
      lineFromText(1, 1000, 'うえ', 2, 200),
    ]);
    // ≤3.5s 且词数 ≤3 ⇒ 换气。
    expect(classifyParagraph([breath[0] as never], 0, 3)).toBe('breath');
  });
});

describe('tempera shot 切分与时间轴', () => {
  it('每个 shot 攒 2~4 个词，超过 2.2s 也收', () => {
    const line = lineFromText(0, 0, 'あいうえおかきくけこさしすせそ', 1, 200);
    const line2 = lineFromText(1, 5000, 'たちつてとなにぬねの', 1, 200);
    const program = compileTemperaProgram([line, line2], 'seed');
    const shots = program.paragraphs.flatMap((paragraph) => paragraph.shots);
    const lyricShots = shots.filter((shot) => !shot.isBridge);
    expect(lyricShots.length).toBeGreaterThan(1);
    for (const shot of lyricShots) {
      const words = shot.slices.flatMap((slice) => {
        const compiled = compileTemperaLines([line, line2]);
        const target = compiled.find((item) => item.sourceIndex === slice.lineIndex);
        return (target?.segments ?? []).slice(slice.segmentStart, slice.segmentEnd);
      });
      expect(words.length).toBeLessThanOrEqual(4);
    }
  });

  it('同段内每个 shot 都铺到下一个 shot 开拍（没有空洞）', () => {
    const lines = [
      lineFromText(0, 0, 'あいうえお', 1, 200),
      lineFromText(1, 1200, 'かきくけこ', 1, 200),
      lineFromText(2, 2400, 'さしすせそ', 1, 200),
    ];
    const program = compileTemperaProgram(lines, 'seed');
    for (const paragraph of program.paragraphs) {
      for (let index = 0; index < paragraph.shots.length - 1; index += 1) {
        expect(paragraph.shots[index]?.endTime).toBeCloseTo(
          paragraph.shots[index + 1]?.startTime ?? 0,
          6,
        );
      }
    }
  });

  it('器乐间隙被 bridge shot 填满：按 5 秒一档切（第 776 轮起不再有"最多 3 个"的上限）', () => {
    const lines = [
      lineFromText(0, 0, 'あい', 2, 200),
      lineFromText(1, 40000, 'うえ', 2, 200),
    ];
    const program = compileTemperaProgram(lines, 'seed');
    const bridges = program.paragraphs.flatMap((paragraph) =>
      paragraph.shots.filter((shot) => shot.isBridge),
    );
    expect(bridges.length).toBeGreaterThan(0);
    /*
     * ⚠ **这是一处有意偏离上游，且由主人明确要求**（第 776 / 777 轮）。
     *
     * 上游 `buildBridgeShots` 是 `count = min(3, ceil(gap / 5))` —— **再长的器乐段也只切 3 个镜头**，
     * 60 秒 ⇒ 每镜 20 秒 ⇒ 主人先看到的是"**纯音乐时背景几乎不变**"。
     * 第 776 轮我去掉了那个 3 的上限；但主人第 777 轮又补了一句
     * 「**纯音乐可以一定时间背景不变**」⇒ 说明"每 5 秒一换"也过头了。
     * 于是把**单镜上限**从 5 秒放宽到 **12 秒**（`TEMPERA_BRIDGE_MAX_LENGTH`）：
     * 器乐段既不是一动不动，也不会切得很勤 —— **一镜十来秒，正是"一定时间不变"**。
     *
     * 本用例的间隙是 `0.4s → 40s`（39.6 秒）⇒ `ceil(39.6 / 12) = 4` 个 bridge（每个约 9.9 秒）。
     */
    expect(bridges.length).toBe(4);
    for (const shot of bridges) {
      expect(shot.slices).toHaveLength(0);
      expect(shot.endTime - shot.startTime).toBeLessThanOrEqual(12.0001);
    }
    const first = bridges[0];
    const last = bridges[bridges.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first !== undefined && last !== undefined) {
      expect(first.startTime).toBeCloseTo(0.4, 6);
      expect(last.endTime).toBeCloseTo(40, 6);
    }
    // ≤15s 的间隙才满足「每个 ≤5s」。
    const mid = compileTemperaProgram(
      [lineFromText(0, 0, 'あい', 2, 200), lineFromText(1, 14000, 'うえ', 2, 200)],
      'seed',
    );
    for (const shot of mid.paragraphs.flatMap((paragraph) =>
      paragraph.shots.filter((entry) => entry.isBridge),
    )) {
      expect(shot.endTime - shot.startTime).toBeLessThanOrEqual(
        TEMPERA_BRIDGE_MAX_LENGTH + 1e-6,
      );
    }
    // 间隙太短就不切 bridge（转场自己盖得住）。
    const tight = compileTemperaProgram(
      [lineFromText(0, 0, 'あい', 2, 200), lineFromText(1, 2400, 'うえ', 2, 200)],
      'seed',
    );
    expect(
      tight.paragraphs.flatMap((paragraph) => paragraph.shots.filter((shot) => shot.isBridge)),
    ).toHaveLength(0);
    expect(TEMPERA_BRIDGE_MIN_GAP).toBeCloseTo(1.2, 6);
  });

  it('转场时长钳在 0.35~1s，最后一段没有出场转场', () => {
    expect(resolveTemperaTransitionDuration(0)).toBeCloseTo(0.35, 6);
    expect(resolveTemperaTransitionDuration(0.4)).toBeCloseTo(0.7, 6);
    expect(resolveTemperaTransitionDuration(5)).toBeCloseTo(1, 6);

    const program = compileTemperaProgram(
      [lineFromText(0, 0, 'あい', 2, 200), lineFromText(1, 9000, 'うえ', 2, 200)],
      'seed',
    );
    const last = program.paragraphs[program.paragraphs.length - 1];
    expect(last?.transitionOut).toBeNull();
    for (let index = 0; index < program.paragraphs.length - 1; index += 1) {
      const transition = program.paragraphs[index]?.transitionOut;
      expect(transition).not.toBeNull();
      const duration = (transition?.endTime ?? 0) - (transition?.startTime ?? 0);
      expect(duration).toBeGreaterThanOrEqual(0.35 - 1e-6);
      expect(duration).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

describe('tempera 确定性与 flow', () => {
  it('同一份歌词、同一个种子，编译两次逐字段一致（seek 前后画面不变的前提）', () => {
    const lines = [
      lineFromText(0, 0, 'あいうえおか', 1, 200),
      lineFromText(1, 4000, 'きくけこさし', 1, 200),
      lineFromText(2, 8200, 'すせそたちつ', 1, 200),
    ];
    const first = compileTemperaProgram(lines, 'song-42');
    const second = compileTemperaProgram(lines, 'song-42');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // 换种子必须换出不同的构图序列（否则「每首歌不一样」这件事就不成立）。
    const other = compileTemperaProgram(lines, 'song-43');
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
  });

  it('flow 角以竖直为主轴，且相邻 shot 之间只转一点点', () => {
    const lines = Array.from({ length: 6 }, (_value, index) =>
      lineFromText(index, index * 1200, 'あいうえお', 1, 200),
    );
    const program = compileTemperaProgram(lines, 'flow');
    const angles = program.paragraphs.flatMap((paragraph) =>
      paragraph.shots.map((shot) => shot.flowAngle),
    );
    expect(angles.length).toBeGreaterThan(1);
    for (const angle of angles) {
      // 与竖直轴（±π/2）的偏离不超过 0.75 rad（本来就允许 ±0.2 的初值抖动 + 每步 0.25 的扰动）。
      const axisDistance = Math.min(
        Math.abs(angle - Math.PI / 2),
        Math.abs(angle + Math.PI / 2),
      );
      expect(axisDistance).toBeLessThan(0.75);
    }
  });

  it('哈希是纯函数：同输入同输出，且分布落在 [0,1)', () => {
    expect(hashTemperaSeed('tempera:0:1:decor')).toBe(hashTemperaSeed('tempera:0:1:decor'));
    expect(hashTemperaSeed('a')).not.toBe(hashTemperaSeed('b'));
    for (let index = 0; index < 64; index += 1) {
      const value = temperaHash01(123456789, index, 179);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('装饰词长度受限、散字只出现在稀疏构图里', () => {
    const lines = [
      lineFromText(0, 0, 'あいうえおかき', 1, 200),
      lineFromText(1, 1400, 'くけこさしすせ', 1, 200),
      lineFromText(2, 2800, 'そたちつてとな', 1, 200),
    ];
    const program = compileTemperaProgram(lines, 'decor');
    for (const paragraph of program.paragraphs) {
      for (const shot of paragraph.shots) {
        if (shot.decor.watermark !== null) {
          expect(shot.decor.watermark.text.length).toBeLessThanOrEqual(12);
          expect(shot.decor.watermark.scale).toBeGreaterThanOrEqual(2.6);
          expect(shot.decor.watermark.scale).toBeLessThanOrEqual(4.5);
        }
        for (const fragment of shot.decor.fragments) {
          // 散字只在页边：x 落在左右 16% 里，y 不贴边。
          const nearEdge = fragment.x <= 0.17 || fragment.x >= 0.83;
          expect(nearEdge).toBe(true);
          expect(fragment.y).toBeGreaterThanOrEqual(0.07);
          expect(fragment.y).toBeLessThanOrEqual(0.93);
        }
        // 交叉线 1~3 条、网线角在 ±45° 内。
        expect(shot.decor.crossCount).toBeGreaterThanOrEqual(1);
        expect(shot.decor.crossCount).toBeLessThanOrEqual(3);
        expect(Math.abs(shot.decor.hatchAngle)).toBeLessThanOrEqual(Math.PI / 4 + 1e-6);
      }
    }
  });

  it('查找函数：时间落在哪一段、哪一拍', () => {
    const program = compileTemperaProgram(
      [lineFromText(0, 0, 'あい', 2, 200), lineFromText(1, 9000, 'うえ', 2, 200)],
      'lookup',
    );
    expect(findTemperaParagraphIndexAtTime(program, -1)).toBe(0);
    expect(findTemperaParagraphIndexAtTime(program, 0)).toBe(0);
    expect(findTemperaParagraphIndexAtTime(program, 9000)).toBe(
      program.paragraphs.length - 1,
    );
    const paragraph = program.paragraphs[0];
    expect(paragraph).toBeDefined();
    if (paragraph !== undefined) {
      const first = findTemperaShotAtTime(paragraph, -5);
      expect(first).toBe(paragraph.shots[0]);
      const last = findTemperaShotAtTime(paragraph, 1e6);
      expect(last).toBe(paragraph.shots[paragraph.shots.length - 1]);
    }
  });
});
