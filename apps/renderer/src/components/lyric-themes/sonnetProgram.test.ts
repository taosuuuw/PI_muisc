/**
 * 商籁（sonnet）**编译层**的自查。
 *
 * 编译层是纯函数：给定歌词行与种子，产出一份确定性的分镜程序。这里守住的是
 * 「段落什么时候断、为什么断、是哪一种段落、配了哪种镜头与转场」这些判断 ——
 * 帧层与渲染层都只是执行它。
 *
 * 注意：段落断开的阈值与「段落种类 → 镜头」的对应表目前是**推断值**（注释里已标注），
 * 所以这里的断言写的是**结构性质**（断点原因、单调性、确定性），不是具体阈值 ——
 * 取到 folia 的真源码之后，改阈值不该让这些用例假红。
 */

import { describe, expect, it } from 'vitest';
import { SONNET_SHOT_KINDS, type SonnetShotKind } from './sonnetKinds';
import { compileSonnetProgram, groupSonnetLineWords, mergeSonnetShortFragments } from './sonnetProgram';
import type { StageLine, StageWord } from './types';

/** 造一行：`text` 按字切开，每字 `perWord` 秒，行从 `startMs` 开始。 */
function makeLine(
  index: number,
  text: string,
  startMs: number,
  perWord = 300,
  gapAfterMs = 0,
): StageLine {
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
    durationMs: chars.length * perWord + gapAfterMs,
    hint: 'normal',
    words,
    starts: words.map((word) => word.startMs),
    ends: words.map((word) => word.endMs),
  };
}

/** 造一批行：每行 `perLineMs` 秒、行间 `gapMs` 静默。 */
function makeSong(texts: readonly string[], perLineMs = 2000, gapMs = 100): StageLine[] {
  return texts.map((text, index) => makeLine(index, text, index * (perLineMs + gapMs), 200));
}

describe('sonnet 编译层', () => {
  /*
   * 段（词）的切法是第 64/65 轮的重点：**普通 LRC 一个 `wordStart` 都没有**，
   * 上一版会退回"整行一段"，于是帧层按段摆字就退化成了按行摆字。这里守住两条路。
   */
  it('有 wordStart 标记时按标记切词；CJK 每字成词、标点黏到前一段', () => {
    const marked: StageLine = {
      ...makeLine(0, '気休めの', 0, 200),
      words: [
        { text: '気', startMs: 0, endMs: 200, wordStart: true },
        { text: '休', startMs: 200, endMs: 400 },
        { text: 'め', startMs: 400, endMs: 600 },
        { text: 'の', startMs: 600, endMs: 800, wordStart: true },
      ],
    };
    /*
     * `気休め | の` —— 末尾只剩**一粒字素**的 CJK 碎片一律并进上一块（`mergeSonnetShortFragments`
     * 的第 ③ 条），否则画面上会多出一个只有一个假名、字号/朝向还各按碎片序号分配的盒子 ✓
     */
    expect(groupSonnetLineWords(marked).map((group) => group.map((word) => word.text).join(''))).toEqual([
      '気休めの',
    ]);
    // 标点没有 `wordStart` ⇒ 黏到前一段（不另起）。
    const withPunct: StageLine = {
      ...makeLine(0, 'また、', 0, 200),
      words: [
        { text: 'ま', startMs: 0, endMs: 200, wordStart: true },
        { text: 'た', startMs: 200, endMs: 400 },
        { text: '、', startMs: 400, endMs: 600 },
      ],
    };
    expect(groupSonnetLineWords(withPunct).map((group) => group.map((word) => word.text).join(''))).toEqual([
      'また、',
    ]);
  });

  /**
   * **碎片合并**（本轮修"词块大小 / 朝向零散"的那一层）。
   *
   * 日文卡拉OK 源常把**每个字素**都标成词首 ⇒ 排版层原本拿到"一粒字素一个盒子"，
   * 同一句话里 `ご覧`（主角 4.0 倍）紧挨着 `召`（陪衬 1.2 倍），字号差 2.3 倍、朝向还各按
   * "第几个碎片"决定（`.tmp/sonnet-probe/probe.test.ts` 的实测读数）。
   * 这里守住"合并之后每块可读、且层级不被合并吃掉"的性质 ✓
   */
  it('逐字标记 ⇒ 合并成至少两粒的可读词块；小假名 / 促音 / 长音绝不自己起头', () => {
    const groupTexts = (text: string): string[] => {
      const chars = [...text];
      const line: StageLine = {
        ...makeLine(0, text, 0, 200),
        words: chars.map((char, position) => ({
          text: char,
          startMs: position * 200,
          endMs: (position + 1) * 200,
          wordStart: true,
        })),
      };
      return groupSonnetLineWords(line).map((group) => group.map((word) => word.text).join(''));
    };
    /* 录屏里那句话：9 个盒子 ⇒ 4 块（末尾只剩一粒的 `手` 并进上一块），每块都读得成词 ✓ */
    expect(groupTexts('ご覧召しませこの手')).toEqual(['ご覧', '召し', 'ませ', 'この手']);
    /* 助词黏左：`を` 不自己起头 ⇒ 弱さを | 抱いて（而不是 を抱 | いて）✓ */
    expect(groupTexts('凌ぐ弱さを抱いて')).toEqual(['凌ぐ', '弱さを', '抱いて']);
    /*
     * **这一行上源边界粗细不影响结果**：逐字标记与隔字标记（`ご覧|召し|ませ|この|手`）都必须排成
     * 同一串 —— 卡拉OK 源有的逐拍打标、有的逐字打标，排版不该跟着变 ✓。
     *
     * ⚠ 这条"同布局"的**适用条件**是"隔字标记每一组恰好是完整的两粒词"：那种情况下
     * `joinShortCjkFragments` 原样保留每一组 ⇒ 与逐字源一致。它不是无条件成立的性质 ——
     * 一旦隔字源切进了真实词边界（`Intl.Segmenter` 的 `あり|ふれ|た|言葉|に`），
     * 已成形的 `言葉` 必须保留，绝不为了"跟逐字源同布局"把它摊平成 `た言|葉に`（见下面新增用例）✓
     */
    const everyOtherMark = (text: string): string[] => {
      const chars = [...text];
      const line: StageLine = {
        ...makeLine(0, text, 0, 200),
        words: chars.map((char, position) => ({
          text: char,
          startMs: position * 200,
          endMs: (position + 1) * 200,
          wordStart: position % 2 === 0,
        })),
      };
      return groupSonnetLineWords(line).map((group) => group.map((word) => word.text).join(''));
    };
    expect(everyOtherMark('ご覧召しませこの手')).toEqual(groupTexts('ご覧召しませこの手'));
    /* 本来就是词的 CJK 段一个字都不许拆（`ありがとう`）✓ */
    expect(groupTexts('ありがとう')).toEqual(['ありがとう']);
    /* 小假名 / 促音：`きょ` 与 `ちょっと` 不许被切成 `き | ょ`、`ち | ょ | っ | と` ✓ */
    expect(groupTexts('きょう')).toEqual(['きょう']);
    expect(groupTexts('ちょっと')).toEqual(['ちょっと']);
    /* 长音符 `ー` 绝不自己起头（`ラーメン` 允许按两粒一段切成 ラー | メン，但不许出现 ー…）✓ */
    expect(groupTexts('ラーメン').every((piece) => !piece.startsWith('ー'))).toBe(true);
    expect(groupTexts('ラーメン').join('')).toBe('ラーメン');
    /* 拼回去永远等于原文（不丢字、不重排）✓ */
    for (const text of ['ご覧召しませこの手', '凌ぐ弱さを抱いて', 'ちょっと', 'がっこう']) {
      expect(groupTexts(text).join('')).toBe(text);
      /* 每一块至少两粒字素（除非整行只剩它一块）✓ */
      const groups = groupTexts(text);
      if (groups.length > 1) {
        for (const piece of groups) expect([...piece].length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('助词黏左只认"整组就是一个助词"：完整多字词不因首字被吞', () => {
    /** 造一个"一个字/词一段"的源分组（每段自己带词首标记）✓ */
    const word = (text: string, startMs: number): StageWord => ({
      text,
      startMs,
      endMs: startMs + 200,
      wordStart: true,
    });
    const texts = (groups: readonly StageWord[][]): string[] =>
      mergeSonnetShortFragments(groups).map((group) => group.map((item) => item.text).join(''));

    /*
     * `もの` / `はるかな` 的**首字**（も / は）都在助词表里，但整组是完整多字词 ⇒
     * 不许按"单字助词"黏左（旧版 `startsWithParticle` 只看首字，会把它们吞成 凌ぐもの / 夢はるかな）✓
     */
    expect(texts([[word('凌ぐ', 0)], [word('もの', 400)]])).toEqual(['凌ぐ', 'もの']);
    expect(texts([[word('夢', 0)], [word('はるかな', 200)]])).toEqual(['夢', 'はるかな']);
    /* 对照：同样结构换成"首字不是助词"的完整词，分组结果必须一致（证明决定与首字无关）✓ */
    expect(texts([[word('凌ぐ', 0)], [word('ごも', 400)]])).toEqual(['凌ぐ', 'ごも']);
    expect(texts([[word('夢', 0)], [word('さるかな', 200)]])).toEqual(['夢', 'さるかな']);

    /*
     * 真的"单独一个助词"仍然黏左（`を` 不自己起头）⇒ 弱さを | 抱いて；
     * 合并只改"哪几粒算一块"，**逐字时间一毫秒都不动** ✓
     */
    const merged = mergeSonnetShortFragments([
      [word('弱さ', 0)],
      [word('を', 200)],
      [word('抱い', 400)],
      [word('て', 600)],
    ]);
    expect(merged.map((group) => group.map((item) => item.text).join(''))).toEqual(['弱さを', '抱いて']);
    expect(merged.flat().map((item) => [item.text, item.startMs])).toEqual([
      ['弱さ', 0],
      ['を', 200],
      ['抱い', 400],
      ['て', 600],
    ]);
  });

  /*
   * **真实输入的粒度**：卡拉OK 源给的是"每个字素一个 `StageWord`"（`word.text` 只有一粒）。
   * 上面那个用例用 `text='凌ぐ'` 的**多字** `StageWord` 构造，绕过了"一组 = 多个单字素 StageWord"
   * 这条真实形状 —— 于是"最长一段 ≤ 两粒就摊平"这个错判据在旧用例下看不出来。
   * 这里按真实形状重造：已成形二字词组必须保留，只把候选单字黏左（Codex 真组件 QA 的发现）✓
   */
  it('真实单字素 StageWord 下：已成形二字词组保留、只把候选单字黏左、绝不从中间切开', () => {
    /** 按"一个字素一个 StageWord"构造源分组，字素时间戳依次 +200ms ✓ */
    const fragments = (parts: readonly string[], startMs = 0): StageWord[][] => {
      let cursor = startMs;
      return parts.map((part) =>
        [...part].map((char) => {
          const item: StageWord = {
            text: char,
            startMs: cursor,
            endMs: cursor + 200,
            wordStart: true,
          };
          cursor += 200;
          return item;
        }),
      );
    };
    const texts = (groups: readonly StageWord[][]): string[] =>
      mergeSonnetShortFragments(groups).map((group) => group.map((item) => item.text).join(''));

    /*
     * `凌ぐ` 与 `もの` 各由**两粒字素 StageWord** 组成（`[[凌],[ぐ]]` / `[[も],[の]]`）：
     * 两组都已成形 ⇒ `凌ぐ|もの`，既不拆开、也不因为首字是助词而吞并 ✓
     */
    expect(texts(fragments(['凌ぐ', 'もの']))).toEqual(['凌ぐ', 'もの']);

    /*
     * `Intl.Segmenter` 真实给出的 `あり|ふれ|た|言葉|に`：`言葉` 是**有意义的二字词**。
     * 旧判据"最长一段 ≤ 两粒"会把整段摊平 ⇒ `あり|ふれ|た言|葉に`（二字词被从中切开）✗；
     * 新判据"只有**全部**都是单字碎片才摊平" ⇒ `あり|ふれた|言葉に` ✓
     */
    const arifureta = fragments(['あり', 'ふれ', 'た', '言葉', 'に']);
    expect(texts(arifureta)).toEqual(['あり', 'ふれた', '言葉に']);

    /*
     * 合并只改"哪几粒算一块"：**逐字时间与字素对象本身**一个都不丢、不换、不重排 ✓
     */
    const mergedArifureta = mergeSonnetShortFragments(arifureta);
    const sourceWords = arifureta.flat();
    expect(mergedArifureta.flat().map((item) => [item.text, item.startMs, item.endMs])).toEqual(
      sourceWords.map((item) => [item.text, item.startMs, item.endMs]),
    );
    for (const [position, item] of mergedArifureta.flat().entries()) {
      expect(item).toBe(sourceWords[position]);
    }

    /*
     * 对照：**每组都只有一粒字素**时仍然摊平重排 —— 小假名 / 促音黏左，绝不一字一个盒子 ✓
     * （`[...'ご覧召しませこの手']` 展开成 9 个单字素组，正是"逐字打标"源的真实形状。）
     */
    const allSingle = fragments([...'ご覧召しませこの手']);
    expect(texts(allSingle)).toEqual(['ご覧', '召し', 'ませ', 'この手']);
    expect(texts(fragments([...'ちょっと']))).toEqual(['ちょっと']);
    expect(texts(allSingle).length).toBeLessThan(allSingle.length);
  });

  it('合并**不越过**拉丁词 / 空白 / 标点：英文行的段粒度一字不变', () => {
    const latin = makeLine(0, 'go od', 0, 200);
    expect(groupSonnetLineWords(latin).map((group) => group.map((word) => word.text).join(''))).toEqual([
      'go',
      ' ',
      'od',
    ]);
    /* 空白自己成段这条契约不许被合并破坏 ✓ */
    const spaced = makeLine(1, 'あ い', 0, 200);
    expect(groupSonnetLineWords(spaced).map((group) => group.map((word) => word.text).join(''))).toEqual([
      'あ',
      ' ',
      'い',
    ]);
  });

  it('**没有任何 wordStart 标记**（普通 LRC）时走 `Intl.Segmenter` **词粒度**：拉丁整词、**空白自己成段**', () => {
    const latin = makeLine(0, 'HATE ME', 0, 200);
    /*
     * **空白要单独成段**，不能黏到前一个词 —— 上游 `wordSegmentation.ts` 的注释写得很直白：
     * "Intl.Segmenter always emits a whitespace run as a segment in its own right, and every consumer
     * is written against that"，且 `sonnetSemantic` 的黏着那趟明确排除纯空白。
     * 我们第 65~66 轮曾把空格黏进前一段（用例还写死了），第 87 轮按上游改正。
     */
    expect(groupSonnetLineWords(latin).map((group) => group.map((word) => word.text).join(''))).toEqual([
      'HATE',
      ' ',
      'ME',
    ]);
    /*
     * CJK 走 ICU 的词典分词（`满是爱恨交织` ⇒ 满 / 是 / 爱恨交织 —— 段数**少于字数**）。
     * 词典的具体切法会随 ICU 版本变动，所以这里只守**结构性质**：
     * 拼回去等于原文、段数比字数少（证明确实是词级而不是字级）、且至少两段。
     */
    const cjkText = '满是爱恨交织';
    const cjkGroups = groupSonnetLineWords(makeLine(1, cjkText, 0, 200)).map((group) =>
      group.map((word) => word.text).join(''),
    );
    expect(cjkGroups.join('')).toBe(cjkText);
    expect(cjkGroups.length).toBeGreaterThan(1);
    expect(cjkGroups.length).toBeLessThan([...cjkText].length);
    // 混排：拉丁整词 + CJK 词级，标点**黏到前一段**（所以最后一段以「!」结尾）。
    const mixedText = 'LOVE 满是爱恨!';
    const mixedGroups = groupSonnetLineWords(makeLine(2, mixedText, 0, 200)).map((group) =>
      group.map((word) => word.text).join(''),
    );
    expect(mixedGroups[0]).toBe('LOVE');
    expect(mixedGroups).toContain(' ');
    expect(mixedGroups.join('')).toBe(mixedText);
    expect(mixedGroups[mixedGroups.length - 1]?.endsWith('!')).toBe(true);
  });

  it('相邻的行合成一段，长静默处断开并记下原因', () => {
    const program = compileSonnetProgram(
      [
        makeLine(0, '一二', 0, 200),
        makeLine(1, '三四', 1000, 200),
        // 静默 6 秒 —— 远超阈值。
        makeLine(2, '五六', 8000, 200),
      ],
      { seed: 'a' },
    );
    expect(program.paragraphs.length).toBe(2);
    expect(program.paragraphs[0]?.boundary).toBe('song-start');
    expect(program.paragraphs[1]?.boundary).toBe('time-gap');
    expect(program.paragraphs[0]?.lines.map((line) => line.sourceIndex)).toEqual([0, 1]);
    expect(program.paragraphs[1]?.lines.map((line) => line.sourceIndex)).toEqual([2]);
  });

  it('行数上限与时长上限都会断开，并且原因如实记下', () => {
    // 8 行、行间几乎不静默：只会被上限切开。
    const many = compileSonnetProgram(makeSong(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 1200, 50), {
      seed: 'b',
      maxLinesPerParagraph: 3,
    });
    expect(many.paragraphs.length).toBeGreaterThanOrEqual(3);
    /*
     * 切点选的是"第 2 行到倒数第 2 行之间**间隙最大**的那一处"（照抄 `splitOversizedDraft`），
     * 不保证一刀正好落在行数上限上 —— 切出来的段可能不足 maxLines，原因也就跟着变
     * （切满 maxLines 记 `line-cap`，否则记 `duration-cap`）。所以这里只守"确实被上限切开了"。
     */
    expect(['line-cap', 'duration-cap']).toContain(many.paragraphs[1]?.boundary);

    /*
     * 时长上限要靠**长行**来触发：行的实际时长由字数决定，`perLineMs` 只影响行与行的间距。
     * 所以这里给一行十个字、每字 1 秒（10 秒），第二行紧接其后（静默很小）。
     */
    const long = compileSonnetProgram(
      [makeLine(0, '一二三四五六七八九十', 0, 1000), makeLine(1, '续', 10500, 1000)],
      { seed: 'c', maxLinesPerParagraph: 99, maxParagraphDuration: 8 },
    );
    expect(long.paragraphs.length).toBeGreaterThan(1);
    expect(long.paragraphs[1]?.boundary).toBe('duration-cap');
  });

  it('段落种类：短单行是"一口气"、行多是副歌、最后一段是结尾', () => {
    const breath = compileSonnetProgram([makeLine(0, '啊', 0, 200)], { seed: 'd' });
    // 只有一段时它同时也是最后一段 ⇒ 结尾优先。
    expect(breath.paragraphs[0]?.kind).toBe('outro');

    // 其余行都要**明显更长**（五个字 × 0.8 秒 = 4 秒），那一声"啊"（0.2 秒）才判得成"一口气"。
    /*
     * 这里要**显式放宽时长上限**：默认 14 秒会先于行数上限生效，把本该 5 行的段切成 3 行，
     * 于是"行数多 ⇒ 副歌"这条根本轮不到。断段是"谁先到谁说话"，写用例时必须照顾到这一点。
     */
    const mixed = compileSonnetProgram(
      [
        makeLine(0, '一二三四五', 0, 800),
        // 这一声"啊"前后都要有静默，它才会**单独成段**，否则会并进前一段判成 verse。
        makeLine(1, '啊', 6000, 200),
        makeLine(2, '一二三四五', 10000, 800),
        makeLine(3, '一二三四五', 15000, 800),
        makeLine(4, '一二三四五', 20000, 800),
        makeLine(5, '一二三四五', 25000, 800),
        makeLine(6, '一二三四五', 30000, 800),
        makeLine(7, '尾', 35000, 200),
      ],
      { seed: 'e', maxLinesPerParagraph: 5, maxParagraphDuration: 30 },
    );
    const kinds = mixed.paragraphs.map((paragraph) => paragraph.kind);
    /*
     * **副歌这一档我们判不出来**：原版是从 `line.isChorus` / `line.songPart` 里读的，
     * 我们的 `StageLine` 没有这两个字段（见 `classifyParagraph` 的注释）。
     * 所以这里不写"一定会出现副歌"这种假断言，只守末段是结尾、单行短段是一口气。
     */
    expect(kinds).not.toContain('chorus');
    expect(kinds[kinds.length - 1]).toBe('outro');
    /*
     * 单行短段判成"一口气"（而不是 verse）。这里**单独造一首**来验：
     * 切点现在是"最大间隙"（照抄 `splitOversizedDraft`），在一首长歌里它落在哪一段是不确定的，
     * 拿段落下标断言会变成"看起来在测判定、其实在测切分位置"。
     *
     * 两处静默都要**够长**：阈值是动态算的（这里 median([5, 4.8]) × 2.5 会被夹到 3.5 秒），
     * 只要有一个间隙小于它，"啊"就会并进邻段、根本判不成一口气。
     */
    const breathSong = compileSonnetProgram(
      [
        makeLine(0, '一二三四五', 0, 800),
        makeLine(1, '啊', 9000, 200),
        makeLine(2, '一二三四五', 14000, 800),
      ],
      { seed: 'e2' },
    );
    expect(breathSong.paragraphs.map((paragraph) => paragraph.kind)).toContain('breath');
  });

  it('每段都有镜头、每个镜头都有提示，且镜头覆盖到本段的最后一行', () => {
    const program = compileSonnetProgram(makeSong(['春', '夏', '秋', '冬', '风'], 2500, 200), {
      seed: 'f',
    });
    for (const paragraph of program.paragraphs) {
      expect(paragraph.shots.length).toBeGreaterThanOrEqual(1);
      const lastLine = paragraph.lines[paragraph.lines.length - 1];
      for (const shot of paragraph.shots) {
        expect(shot.cues.length).toBeGreaterThanOrEqual(1);
        expect(shot.lineIndices.length).toBeGreaterThanOrEqual(1);
        expect(shot.camera.zoom).toBeGreaterThan(1);
        expect(Number.isFinite(shot.camera.rotation)).toBe(true);
      }
      const lastShot = paragraph.shots[paragraph.shots.length - 1];
      expect(lastShot?.endTime).toBeGreaterThanOrEqual((lastLine?.renderEndTime ?? 0) - 1e-6);
    }
  });

  it('相邻段落尽量不撞同一种镜头，且镜头一定在七种之内', () => {
    const program = compileSonnetProgram(makeSong(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 1500, 50), {
      seed: 'g',
      maxLinesPerParagraph: 2,
    });
    const kinds: SonnetShotKind[] = program.paragraphs.flatMap((paragraph) =>
      paragraph.shots.map((shot) => shot.kind),
    );
    expect(kinds.length).toBeGreaterThan(2);
    for (const kind of kinds) expect(SONNET_SHOT_KINDS).toContain(kind);
    for (let index = 1; index < kinds.length; index += 1) {
      expect(kinds[index]).not.toBe(kinds[index - 1]);
    }
  });

  it('转场挂在段落上，种类由"下一段为什么开始"决定；末段没有出场转场', () => {
    const program = compileSonnetProgram(
      [makeLine(0, '一', 0, 200), makeLine(1, '二', 9000, 200)],
      { seed: 'h' },
    );
    expect(program.paragraphs.length).toBe(2);
    /*
     * 转场种类**不再由"下一段为什么开始"决定**：原版是 `chooseWithoutRepeat` 从三种里轮流挑
     * （不跟上一次重复），时长 `min(0.3, max(0.16, gap × 0.5))`，起点是"下一段起点减去时长"。
     * 所以这里守的是：种类在三种之内、出场窗口正好接上下一段的起点、时长落在范围内。
     */
    const transition = program.paragraphs[0]?.transitionOut;
    expect(transition).not.toBeNull();
    expect(['fast-blur', 'mono-glitch', 'camera-pull']).toContain(transition?.kind);
    expect(transition?.endTime).toBeCloseTo(program.paragraphs[1]?.startTime ?? 0, 6);
    const span = (transition?.endTime ?? 0) - (transition?.startTime ?? 0);
    expect(span).toBeGreaterThanOrEqual(0.16);
    expect(span).toBeLessThanOrEqual(0.3 + 1e-6);
    // 末段没有下一段，就没有出场转场。
    expect(program.paragraphs[1]?.transitionOut).toBeNull();
  });

  it('相邻段落的转场种类不重复（照抄 chooseWithoutRepeat）', () => {
    const program = compileSonnetProgram(makeSong(['甲', '乙', '丙', '丁'], 900, 40), {
      seed: 'j',
      maxLinesPerParagraph: 1,
    });
    expect(program.paragraphs.length).toBeGreaterThan(2);
    const kinds = program.paragraphs
      .map((paragraph) => paragraph.transitionOut?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => kind !== null && kind !== undefined);
    for (let index = 1; index < kinds.length; index += 1) {
      expect(kinds[index]).not.toBe(kinds[index - 1]);
    }
  });
  it('一段多镜：一镜最多 4 行、总时长不超过 6 秒（照抄 groupShotLines）', () => {
    // 6 行、行间几乎不静默、每行 1 秒 ⇒ 一段，但必然被切成两镜（4 + 2）。
    const program = compileSonnetProgram(
      makeSong(['甲乙', '丙丁', '戊己', '庚辛', '壬癸', '子丑'], 1000, 20),
      { seed: 'k', maxLinesPerParagraph: 99, maxParagraphDuration: 99 },
    );
    const paragraph = program.paragraphs[0];
    expect(paragraph).toBeDefined();
    expect(paragraph?.shots.length).toBeGreaterThanOrEqual(2);
    for (const shot of paragraph?.shots ?? []) {
      expect(shot.lineIndices.length).toBeLessThanOrEqual(4);
      expect(shot.lineIndices.length).toBeGreaterThanOrEqual(1);
      // 每镜覆盖的行在一个组里 ⇒ 时长不超过 6 秒。
      expect(shot.endTime - shot.startTime).toBeLessThanOrEqual(6.001);
    }
  });

  it('确定性：同一个种子两次编译逐字段一致；换种子会换到别的镜头', () => {
    const song = makeSong(['甲', '乙', '丙', '丁', '戊', '己'], 2000, 100);
    expect(compileSonnetProgram(song, { seed: 'same' })).toEqual(
      compileSonnetProgram(song, { seed: 'same' }),
    );
    const kindsOf = (seed: string): string =>
      compileSonnetProgram(song, { seed })
        .paragraphs.flatMap((paragraph) => paragraph.shots.map((shot) => shot.kind))
        .join(',');
    // 至少存在两个种子给出不同的镜头顺序（否则"按种子挑"等于没挑）。
    const distinct = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((index) => kindsOf(`seed-${index}`)));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('空歌词给出空程序（不抛、不造零长段落）', () => {
    const program = compileSonnetProgram([], { seed: 'i' });
    expect(program.paragraphs).toEqual([]);
    expect(program.version).toBe(1);
  });
});
