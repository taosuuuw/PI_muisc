/**
 * 第十一轮第 1 条（用户 m03279：「有和声的地方歌词进度不对，要修正」）的回归测试。
 *
 * 只测纯函数 `buildStageLines`——它不碰 DOM、不碰 React，所以在 node 环境下能直接跑
 * （渲染层原来是零单测；这份是跟着第十一轮的云阶几何自查一起进来的）。
 *
 * 三条被钉住的现实：
 * 1) **和声行与主唱共享时间戳**（或被主唱的时间包住）。旧写法拿「数组里紧邻的下一行」算间隔，
 *    于是 `1000 → 1000` 得到 0 ⇒ 这一行一开头就被判成唱完，进度条与逐字点亮全错。现在按
 *    「第一个**严格更晚**的时间戳 − 本行起点」算。
 * 2) 上游 yrc 其实**带**行时长与逐字时间戳（解析层第十一轮把它们带上来，见
 *    `packages/ncm-client/src/index.ts` 的 `parseYrcWords`）：有真值时用真的，`durationMs`
 *    作为**下限**参与 `max`，逐字时间戳直接摊平成字素时间轴。
 * 3) 纯 LRC 没有这两个字段 ⇒ 必须退回「行时长均分给字素」的老近似，行为与改造前一致。
 *
 * 第十三轮第 1 条（用户 m04663：「歌词有时会进度不匹配，不同句歌词切换或则追踪过去不流畅」）
 * 补上时钟侧的三组回归：`findActiveIndex` 的换行边界（下一句开始前不许提前高亮）、
 * `smoothPositionAt` / `resyncClock` 的仿射外推与停摆冻结、`classicFrameAt` 的一帧可视状态。
 * 这三组全是纯函数，仍然不碰 DOM / React。
 */

import { describe, expect, it } from 'vitest';
import type { LyricLine } from '@pi/shared';
import {
  CLOCK_STALL_MS,
  buildStageLines,
  classicFrameAt,
  findActiveIndex,
  resyncClock,
  smoothPositionAt,
} from './LyricStage';

const lrc = (timeMs: number, text: string): LyricLine => ({ timeMs, text });

describe('buildStageLines（和声 / 逐字时间轴）', () => {
  it('和声行与主唱共享时间戳时，行时长 =（第一个严格更晚的时间戳 − 本行起点），不是 0', () => {
    const built = buildStageLines([lrc(1000, '主唱'), lrc(1000, '和声'), lrc(3000, '下一句')]);
    expect(built.map((line) => line.durationMs)).toEqual([2000, 2000, 4000]);
  });

  it('本行被上一行的时间包住时，也仍然找「严格更晚」的那一句', () => {
    const built = buildStageLines([lrc(0, 'a'), lrc(500, 'b'), lrc(900, 'c')]);
    expect(built.map((line) => line.durationMs)).toEqual([500, 400, 4000]);
  });

  it('yrc 的真行时长当下限（比「下一句 − 本行」大时用它），逐字时间戳直接摊平', () => {
    const built = buildStageLines([
      {
        timeMs: 0,
        text: '还没',
        durationMs: 3460,
        words: [
          { timeMs: 0, durationMs: 670, text: '还' },
          { timeMs: 670, durationMs: 410, text: '没' },
        ],
      },
      lrc(2000, '下一句'),
    ]);
    // 2000 − 0 = 2000 < 3460 ⇒ 取真的 3460（否则和声/拖长音会被下一句提前截断）
    expect(built[0]?.durationMs).toBe(3460);
    expect(built[0]?.words.map((word) => word.text)).toEqual(['还', '没']);
    expect(built[0]?.starts).toEqual([0, 670]);
    expect(built[0]?.ends).toEqual([670, 1080]);
  });

  it('纯 LRC（没有 durationMs / words）走均分近似，行为与改造前一致', () => {
    const built = buildStageLines([lrc(0, 'abcd'), lrc(4000, 'next')]);
    expect(built[0]?.durationMs).toBe(4000);
    expect(built[0]?.words.map((word) => word.text)).toEqual(['a', 'b', 'c', 'd']);
    expect(built[0]?.starts).toEqual([0, 1000, 2000, 3000]);
  });
});

describe('findActiveIndex（当前句边界）', () => {
  it('下一句开始前的 40ms 内当前句不能提前高亮（换行判据只有 timeMs，不带预读）', () => {
    const lines = [lrc(0, 'a'), lrc(2000, 'b'), lrc(4000, 'c')];
    expect(findActiveIndex(lines, 0)).toBe(0);
    expect(findActiveIndex(lines, 1960)).toBe(0);
    expect(findActiveIndex(lines, 1999)).toBe(0);
    expect(findActiveIndex(lines, 2000)).toBe(1);
    expect(findActiveIndex(lines, 3999)).toBe(1);
    expect(findActiveIndex(lines, 4000)).toBe(2);
  });

  it('同一时间戳的重复行（和声）取最后一条，不是第一条', () => {
    const lines = [lrc(1000, '主唱'), lrc(1000, '和声'), lrc(3000, '下一句')];
    expect(findActiveIndex(lines, 999)).toBe(-1);
    expect(findActiveIndex(lines, 1000)).toBe(1);
    expect(findActiveIndex(lines, 2999)).toBe(1);
    expect(findActiveIndex(lines, 3000)).toBe(2);
  });

  it('还没唱到第一句时返回 -1（首句之前不许凭空高亮）', () => {
    const lines = [lrc(1000, '第一句'), lrc(5000, '第二句')];
    expect(findActiveIndex(lines, 0)).toBe(-1);
    expect(findActiveIndex(lines, 999)).toBe(-1);
    expect(findActiveIndex(lines, 1000)).toBe(0);
    expect(findActiveIndex([], 1000)).toBe(-1);
  });

  it('二分结果与旧线性扫在整条时间轴上逐位一致（含重复时间戳与首句前后）', () => {
    const lines = [0, 0, 500, 500, 500, 1200, 4000, 4000].map((timeMs, index) =>
      lrc(timeMs, `第 ${index} 行`),
    );
    const linear = (positionMs: number): number => {
      let found = -1;
      for (const [index, line] of lines.entries()) {
        if (line.timeMs > positionMs) break;
        found = index;
      }
      return found;
    };
    for (let positionMs = -10; positionMs <= 4100; positionMs += 10) {
      expect(findActiveIndex(lines, positionMs)).toBe(linear(positionMs));
    }
  });
});

describe('smoothPositionAt / resyncClock（平滑时钟）', () => {
  it('两次 timeupdate 之间位置连续推进，不再等到下一个 250ms 才跳一格', () => {
    const anchor = resyncClock(1000, 0);
    expect(smoothPositionAt(anchor, 0)).toBe(1000);
    expect(smoothPositionAt(anchor, 16)).toBe(1016);
    expect(smoothPositionAt(anchor, 100)).toBe(1100);
    expect(smoothPositionAt(anchor, 249)).toBe(1249);
  });

  it('CLOCK_STALL_MS 没收到新值就冻在锚点上（暂停后歌词不许自己往前跑）', () => {
    const anchor = resyncClock(1000, 0);
    // 必须大于 Chromium 的 timeupdate 节拍（250ms），否则主线程忙一下就被误判成暂停
    expect(CLOCK_STALL_MS).toBeGreaterThan(250);
    expect(smoothPositionAt(anchor, CLOCK_STALL_MS)).toBe(1000 + CLOCK_STALL_MS);
    expect(smoothPositionAt(anchor, CLOCK_STALL_MS + 1)).toBe(1000);
    expect(smoothPositionAt(anchor, 10_000)).toBe(1000);
  });

  it('新的 store 值一到就硬对齐（往回拖、换歌都要立刻跟上，不许被外推拖着走）', () => {
    const first = resyncClock(30_000, 0);
    expect(smoothPositionAt(first, 100)).toBe(30_100);
    // 用户拖回前面：store 立刻给新值，锚点重建，外推从新值起算
    const second = resyncClock(1000, 200);
    expect(smoothPositionAt(second, 250)).toBe(1050);
    // 换歌：旧歌 30s 的锚点不能把新歌第一帧带到 30s 去
    const third = resyncClock(0, 300);
    expect(smoothPositionAt(third, 316)).toBe(16);
  });
});

describe('classicFrameAt（一帧的可视状态）', () => {
  const twoLines = buildStageLines([lrc(0, 'ab'), lrc(4000, '下一句')]);

  it('换行只认 timeMs：下一句开始前的那一帧仍是上一句', () => {
    expect(classicFrameAt(twoLines, 3960, null).activeIndex).toBe(0);
    expect(classicFrameAt(twoLines, 3999, null).activeIndex).toBe(0);
    expect(classicFrameAt(twoLines, 4000, null).activeIndex).toBe(1);
  });

  it('预读窗口只让「下一个字」提前 active，唱过的字才判 passed', () => {
    // 'ab' 均分成 a[0,2000) b[2000,4000)，normal 的预读窗口是 150ms
    expect(classicFrameAt(twoLines, 800, null).states).toEqual(['active', 'waiting']);
    expect(classicFrameAt(twoLines, 1850, null).states).toEqual(['active', 'active']);
    expect(classicFrameAt(twoLines, 1999, null).states).toEqual(['active', 'active']);
    expect(classicFrameAt(twoLines, 2000, null).states).toEqual(['passed', 'active']);
    expect(classicFrameAt(twoLines, 2500, null).states).toEqual(['passed', 'active']);
  });

  it('用户滚过（viewIndex 非空）时显示行停在用户那一句，但高亮/逐字仍跟播放', () => {
    // 播放已到第二句（4000ms 起），用户滚回第一句看词
    const frame = classicFrameAt(twoLines, 4500, 0);
    expect(frame.anchorIndex).toBe(0);
    expect(frame.activeIndex).toBe(1);
    expect(frame.states).toEqual(['passed', 'passed']);
  });

  it('空歌词返回 { activeIndex: -1, anchorIndex: 0, states: null }（舞台不炸）', () => {
    expect(classicFrameAt([], 1000, null)).toEqual({ activeIndex: -1, anchorIndex: 0, states: null });
  });
});
