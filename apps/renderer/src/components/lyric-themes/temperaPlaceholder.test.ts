/**
 * **无歌词段的占位行**（第 782 轮）。
 *
 * 为什么要有这个文件：`buildTemperaPlaceholderLines` 的两个分支里，**「。。。。」那条有冒烟实证**
 * （探针 `mode=dots spanMs=20250`），而 **🎵 那条碰不到** —— 冒烟能触达的歌都带歌词。
 * 不给它一条判据，它就只能是"看代码相信"。这里按纯函数把两条都钉住。
 *
 * ⚠ 边界说明：本文件测的是**算法**（同样输入 ⇒ 同样占位行）。它不能替代"画面上真的出现 🎵" ——
 * 那还需要一次真实观测；但"分支会不会走对"从此可复现。
 */
import { describe, expect, it } from 'vitest';

import { buildTemperaPlaceholderLines, compileTemperaProgram } from './temperaProgram';
import type { StageLine } from './types';

/** 造一条最小可用的歌词行，只关心 `timeMs`（首句开始时刻）。 */
function lineAt(timeMs: number): StageLine {
  return {
    index: 0,
    timeMs,
    text: 'あい',
    durationMs: 200,
    hint: 'normal',
    words: [{ text: 'あ', startMs: timeMs, endMs: timeMs + 100, wordStart: true }],
    starts: [timeMs],
    ends: [timeMs + 100],
  };
}

describe('凝彩无歌词段的占位行', () => {
  it('整首没歌词（纯音乐）⇒ 平铺 🎵，覆盖 15 分钟且每条 10 秒', () => {
    const built = buildTemperaPlaceholderLines([]);
    expect(built).toHaveLength(90);
    expect(built[0]?.text).toBe('🎵');
    expect(built[0]?.timeMs).toBe(0);
    expect(built[89]?.timeMs).toBe(89 * 10000);
    for (const line of built) {
      expect(line.text).toBe('🎵');
      expect(line.durationMs).toBe(10000);
      // 每条只有一个字素，且它自己就是词首（否则排版层认不出词边界）。
      expect(line.words).toHaveLength(1);
      expect(line.words[0]?.wordStart).toBe(true);
      expect(line.starts).toHaveLength(1);
      expect(line.ends).toHaveLength(1);
    }
  });

  it('开头有空隙（≥1.2s）⇒ 前面插一条「。。。。」，真实行原样保留', () => {
    const real = lineAt(20250);
    const built = buildTemperaPlaceholderLines([real]);
    expect(built).toHaveLength(2);
    const intro = built[0];
    expect(intro?.text).toBe('。。。。');
    expect(intro?.timeMs).toBe(0);
    expect(intro?.durationMs).toBe(20250);
    // 四个字素、时序从 0 均匀铺到 20250。
    expect(intro?.words).toHaveLength(4);
    expect(intro?.starts[0]).toBe(0);
    expect(intro?.ends[3]).toBeCloseTo(20250, 6);
    expect(intro?.words[0]?.wordStart).toBe(true);
    expect(intro?.words[1]?.wordStart).toBe(false);
    // 真实那一条**原样**在第二位（不能被占位挤掉或改写）。
    expect(built[1]).toBe(real);
  });

  it('开头太短（<1.2s）⇒ 不插，原数组原样返回', () => {
    const real = lineAt(1080);
    const built = buildTemperaPlaceholderLines([real]);
    expect(built).toHaveLength(1);
    expect(built[0]).toBe(real);
  });

  /*
   * **目标第一条的判据**：「解决**纯音乐背景无变化**」。
   *
   * 上面那条只证明"🎵 占位行被造出来了"；这一条再往前走一步 ——
   * 把它们**真的编译**成画面时间轴，检查两件事：
   *   ① 时间轴**覆盖足够长**（不是几秒就没了）；
   *   ② **构图会换**（`kind` 不止一种）⇒ 纯音乐时背景确实在变，而不是一片静止的纸。
   * 这是"背景无变化"这个诉求在**程序层**的实证（画面层仍待主人用一首纯音乐确认）。
   */
  it('🎵 占位行编译出的时间轴覆盖够长、且构图会变化（纯音乐背景不再静止）', () => {
    const program = compileTemperaProgram(buildTemperaPlaceholderLines([]), 'seed');
    const shots = program.paragraphs.flatMap((paragraph) => paragraph.shots);
    expect(shots.length).toBeGreaterThan(5);
    // ① 覆盖足够长：最后一镜结束时间应远超一分钟（90 条 × 10 秒 = 15 分钟）。
    const last = shots[shots.length - 1];
    expect(last).toBeDefined();
    expect(last?.endTime ?? 0).toBeGreaterThan(60);
    // ② 构图真的换了 —— 取镜本来就是"不与上一个重复"，所以种类必然多于一种。
    const kinds = new Set(shots.map((shot) => shot.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });
});
