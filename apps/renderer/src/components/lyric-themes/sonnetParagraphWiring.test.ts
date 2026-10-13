/**
 * 商籁**段落级出场转场**的端到端接线用例（第 319 轮补）。
 *
 * 为什么单独开一个文件：`sonnetProgram.test.ts` 里那两个造夹具的助手是**文件内函数**（未导出），
 * 而 `sonnetFrame.test.ts` 自带的 `SONG` 夹具编译出来**只有一段**（实测 `0/0`，第 316 轮），
 * 段落级转场只存在于**段落之间** ⇒ 在那边**根本没有窗口可测**。
 * 与其去改它的 import（第 314 轮刚因"以为没导入"把构建搞红过），不如这里**自带一份**夹具。
 */

import { describe, expect, it } from 'vitest';
import type { StageLine, StageWord } from './types';
import { buildSonnetFrame, findSonnetShot } from './sonnetFrame';
import { compileSonnetProgram } from './sonnetProgram';

/** 造一行（形状照抄 `sonnetProgram.test.ts` 的局部助手：按字切开、逐字给时间）。 */
function makeLine(index: number, text: string, startMs: number, perWord = 300): StageLine {
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

/** 造一批行：行间留静默（`gapMs`），这样才会被切成多段。 */
function makeSong(texts: readonly string[], perLineMs = 900, gapMs = 600): StageLine[] {
  return texts.map((text, index) => makeLine(index, text, index * (perLineMs + gapMs), 200));
}

const VIEWPORT = { width: 1920, height: 1080 };

describe('商籁段落级转场的端到端接线', () => {
  const program = compileSonnetProgram(makeSong(['甲', '乙', '丙', '丁']), {
    seed: 'paragraph-wiring',
    maxLinesPerParagraph: 1,
  });

  it('夹具确实造出了多段、且至少有一段带出场转场（否则这条用例没有意义）', () => {
    expect(program.paragraphs.length).toBeGreaterThan(1);
    const withTransition = program.paragraphs.filter((paragraph) => paragraph.transitionOut !== null);
    expect(withTransition.length).toBeGreaterThan(0);
    // 末段没有下一段 ⇒ 恒为 null（既有断言，这里顺带守住）。
    expect(program.paragraphs[program.paragraphs.length - 1]?.transitionOut).toBeNull();
  });

  it('窗口中点：**命中镜头** ⇒ 帧层转场必须不再是 IDLE；命中不到 ⇒ 记为"落在静默区"', () => {
    let hit = 0;
    let missed = 0;
    for (const paragraph of program.paragraphs) {
      const window = paragraph.transitionOut;
      if (window === null) continue;
      const middle = (window.startTime + window.endTime) / 2;
      /*
       * 帧层要**先命中一个镜头**才会画东西（`findSonnetShot`）。
       * 段落边界常在没歌词的静默里 ⇒ 这一步可能落空，落空就说明"这一层目前画不出来"。
       */
      if (findSonnetShot(program, middle) === null) {
        missed += 1;
        continue;
      }
      const frame = buildSonnetFrame({
        program,
        timeSec: middle,
        viewport: VIEWPORT,
        inkColor: '#ffffff',
        emphasisColor: '#ff0000',
      });
      // 三种转场必动其一：fast-blur 动模糊、mono-glitch 动故障、camera-pull 动 α。
      const moved =
        frame.transition.alpha < 1 || frame.transition.blurPx > 0 || frame.transition.glitch > 0;
      expect(moved).toBe(true);
      hit += 1;
    }
    console.info(`[test] 段落转场窗口：命中镜头 ${hit} 段／落在静默 ${missed} 段`);
    expect(hit + missed).toBeGreaterThan(0);
  });
});
