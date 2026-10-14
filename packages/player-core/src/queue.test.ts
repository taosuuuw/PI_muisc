/**
 * `@pi/player-core` 的队列 / 播放模式回归测试。
 *
 * 背景：写这份测试之前，这个包里**一条测试都没有**（`src/` 只有 `queue.ts` 与 `index.ts`），
 * 而「切歌到底切到哪一首」恰恰是它存在的唯一理由——`queue.ts` 文件头自己写着
 * 「一旦写进 React 组件里就再也测不了」。用户 m03805 第 4 条要求把播放模式补齐成网易云的四档，
 * 所以这里一次性把四档的推进语义钉住，重点是新加的 `sequence`（顺序播放）：**到尾就停，绝不回头**。
 *
 * 全程不碰 DOM / React / `<audio>`，随机源一律注入确定值。
 */
import { describe, expect, it } from 'vitest';
import type { PlayMode } from '@pi/shared';
import {
  EMPTY_QUEUE,
  MODE_LABEL,
  PLAYLIST_MODES,
  advance,
  changeMode,
  createQueue,
  currentId,
  cycleMode,
  jumpTo,
  moveInQueue,
  removeFromQueue,
  retreat,
} from './queue.js';

const IDS = [11, 22, 33] as const;

/**
 * 全 0 的随机源。`permutation` 里每次取 `j = floor(0 * (i + 1)) = 0`，
 * 于是 3 首歌的 shuffle 排列确定为 `[0, 2, 1]`（首元素固定为当前曲目）。
 */
const zeroRandom = (): number => 0;

describe('播放模式表（用户 m03805 第 4 条）', () => {
  it('四档模式的中文名与网易云一致', () => {
    expect(MODE_LABEL).toEqual({
      order: '列表循环',
      'repeat-one': '单曲循环',
      shuffle: '随机播放',
      sequence: '顺序播放',
    });
  });

  it('轮转顺序是 列表循环 → 单曲循环 → 随机播放 → 顺序播放 → 列表循环', () => {
    expect([...PLAYLIST_MODES]).toEqual(['order', 'repeat-one', 'shuffle', 'sequence']);

    let mode: PlayMode = 'order';
    const walk: PlayMode[] = [mode];
    for (let i = 0; i < PLAYLIST_MODES.length; i += 1) {
      mode = cycleMode(mode);
      walk.push(mode);
    }
    expect(walk).toEqual(['order', 'repeat-one', 'shuffle', 'sequence', 'order']);
  });

  it('模式表里的每一项都有名字，没有漏配', () => {
    for (const mode of PLAYLIST_MODES) {
      expect(MODE_LABEL[mode]).toBeTruthy();
    }
  });
});

describe('advance —— 列表循环 / 单曲循环 / 随机播放：原有契约不变', () => {
  it('列表循环：自动播完走到下一首，到尾回到第一首', () => {
    const middle = createQueue(IDS, 0, 'order');
    expect(currentId(advance(middle, 'auto'))).toBe(22);

    const last = createQueue(IDS, 2, 'order');
    expect(advance(last, 'auto').index).toBe(0);
    expect(currentId(advance(last, 'auto'))).toBe(11);
  });

  it('列表循环：手动「下一首」同样到尾回头', () => {
    const last = createQueue(IDS, 2, 'order');
    expect(advance(last, 'manual').index).toBe(0);
  });

  it('单曲循环：自动播完停在原曲（返回同一个状态对象）', () => {
    const state = createQueue(IDS, 1, 'repeat-one');
    expect(advance(state, 'auto')).toBe(state);
    expect(advance(state, 'auto').index).toBe(1);
  });

  it('单曲循环：手动「下一首」仍然换歌，否则用户会以为按钮坏了', () => {
    const state = createQueue(IDS, 1, 'repeat-one');
    expect(currentId(advance(state, 'manual'))).toBe(33);
  });

  it('随机播放：一轮之内不重复，游标到尾绕回起点', () => {
    const state = createQueue(IDS, 0, 'shuffle', zeroRandom);
    expect([...state.shuffleOrder]).toEqual([0, 2, 1]);

    const first = advance(state, 'manual', zeroRandom);
    const second = advance(first, 'manual', zeroRandom);
    const third = advance(second, 'manual', zeroRandom);
    expect([currentId(first), currentId(second), currentId(third)]).toEqual([33, 22, 11]);
    // 绕回起点：又是一轮的开头，不是重新随机。
    expect(third.index).toBe(0);
  });

  it('随机播放：「上一首」回到随机序列里的前一首（而不是重新随机）', () => {
    const state = createQueue(IDS, 0, 'shuffle', zeroRandom);
    expect(currentId(retreat(state, zeroRandom))).toBe(22);
  });
});

describe('advance —— 顺序播放（用户 m03805 第 4 条新增）', () => {
  it('没到末尾就按列表顺序往下走，自动与手动都一样', () => {
    const state = createQueue(IDS, 0, 'sequence');
    expect(advance(state, 'auto').index).toBe(1);
    expect(currentId(advance(state, 'auto'))).toBe(22);
    expect(advance(state, 'manual').index).toBe(1);
  });

  it('自动播完最后一首：停在原地，返回同一个状态对象（引用没变＝没有下一首）', () => {
    const state = createQueue(IDS, 2, 'sequence');
    const next = advance(state, 'auto');
    expect(next).toBe(state);
    expect(next.index).toBe(2);
    expect(currentId(next)).toBe(33);
  });

  it('手动「下一首」在末尾也不许绕回第一首', () => {
    const state = createQueue(IDS, 2, 'sequence');
    const next = advance(state, 'manual');
    expect(next).toBe(state);
    expect(next.index).toBe(2);
    expect(currentId(next)).toBe(33);
  });

  it('只有一首歌的顺序播放：播完就停', () => {
    const state = createQueue([11], 0, 'sequence');
    expect(advance(state, 'auto')).toBe(state);
    expect(advance(state, 'manual')).toBe(state);
  });

  it('空队列原样返回', () => {
    expect(advance(EMPTY_QUEUE)).toBe(EMPTY_QUEUE);
    expect(currentId(EMPTY_QUEUE)).toBeUndefined();
  });

  it('直接点最后一首之后，推进同样停在最后一首', () => {
    const state = jumpTo(createQueue(IDS, 0, 'sequence'), 2);
    expect(state.index).toBe(2);
    expect(advance(state, 'auto')).toBe(state);
  });

  it('「上一首」仍然往回走，到第一首绕到最后一首（顺序播放只约束往下走）', () => {
    const middle = createQueue(IDS, 1, 'sequence');
    expect(retreat(middle).index).toBe(0);

    const first = createQueue(IDS, 0, 'sequence');
    expect(currentId(retreat(first))).toBe(33);
  });
});

describe('changeMode / createQueue', () => {
  it('进入顺序播放时清掉随机序列（顺序播放不认识 shuffle 的游标）', () => {
    const shuffled = createQueue(IDS, 0, 'shuffle', zeroRandom);
    expect(shuffled.shuffleOrder.length).toBe(3);

    const sequence = changeMode(shuffled, 'sequence');
    expect(sequence.mode).toBe('sequence');
    expect([...sequence.shuffleOrder]).toEqual([]);
    expect(sequence.shuffleCursor).toBe(0);
    // 指针不动：换模式不换歌。
    expect(sequence.index).toBe(shuffled.index);
  });

  it('切回随机播放会重建排列，当前这首仍在排列首位', () => {
    const state = changeMode(createQueue(IDS, 2, 'sequence'), 'shuffle', zeroRandom);
    expect(state.mode).toBe('shuffle');
    expect(state.shuffleOrder[0]).toBe(2);
    expect(state.index).toBe(2);
  });
});

/**
 * 拖动改顺序与删歌（主人本轮第 3 条）。
 *
 * 这两件事看着像 UI，其实全是「下标怎么跟着挪」的算术 —— 最容易出的错是
 * 「拖动别的歌，正在播的那首跟着换人」。所以口径全部收在纯函数里、在这里钉死：
 *   · `moveInQueue` 只重排 `ids`，`index` 始终指向**同一首歌**；
 *   · `removeFromQueue` 删当前曲目之前的那首时下标注跟着减一，删到当前曲目时要如实回报
 *     `wasCurrent`（是接着播下一首还是停下，由 `state/player.ts` 决定，纯函数不碰 `<audio>`）。
 */
describe('moveInQueue —— 拖动改顺序', () => {
  it('往后拖：ids 重排，当前曲目仍然指向同一首歌', () => {
    const state = createQueue([1, 2, 3, 4], 0);
    const next = moveInQueue(state, 0, 2);
    expect(next.ids).toEqual([2, 3, 1, 4]);
    expect(currentId(next)).toBe(1);
    expect(next.index).toBe(2);
  });

  it('往前拖：当前曲目在前面的那首被挪到后面时，下标跟着减一', () => {
    const state = createQueue([1, 2, 3, 4], 3);
    const next = moveInQueue(state, 0, 2);
    expect(next.ids).toEqual([2, 3, 1, 4]);
    expect(currentId(next)).toBe(4);
    expect(next.index).toBe(3);
  });

  it('拖的正是正在播的那一首：跟着挪，歌不变', () => {
    const state = createQueue([1, 2, 3], 1);
    const next = moveInQueue(state, 1, 0);
    expect(next.ids).toEqual([2, 1, 3]);
    expect(currentId(next)).toBe(2);
    expect(next.index).toBe(0);
  });

  it('随机播放的排列会被重置（它的值是按旧下标存的，重排后必须作废）', () => {
    const state = createQueue([1, 2, 3, 4], 1, 'shuffle', zeroRandom);
    expect(state.shuffleOrder.length).toBe(4);
    const next = moveInQueue(state, 0, 3);
    expect(next.shuffleOrder).toEqual([]);
    expect(next.shuffleCursor).toBe(0);
    expect(currentId(next)).toBe(2);
  });

  it('越界与原地不动都原样返回', () => {
    const state = createQueue([1, 2, 3], 0);
    expect(moveInQueue(state, 0, 0)).toBe(state);
    expect(moveInQueue(state, -1, 1)).toBe(state);
    expect(moveInQueue(state, 0, 3)).toBe(state);
    expect(moveInQueue(EMPTY_QUEUE, 0, 1)).toBe(EMPTY_QUEUE);
  });
});

describe('removeFromQueue —— 从队列删一首', () => {
  it('删当前曲目后面的那首：当前曲目不受影响', () => {
    const state = createQueue([1, 2, 3], 0);
    const { state: next, removedId, wasCurrent } = removeFromQueue(state, 2);
    expect(next.ids).toEqual([1, 2]);
    expect(removedId).toBe(3);
    expect(wasCurrent).toBe(false);
    expect(currentId(next)).toBe(1);
  });

  it('删当前曲目前面那首：下标注减一，正在播的还是同一首', () => {
    const state = createQueue([1, 2, 3], 2);
    const { state: next, wasCurrent } = removeFromQueue(state, 0);
    expect(next.ids).toEqual([2, 3]);
    expect(wasCurrent).toBe(false);
    expect(currentId(next)).toBe(3);
    expect(next.index).toBe(1);
  });

  it('删掉正在播的那一首：如实回报 wasCurrent，下标按夹取处理', () => {
    const state = createQueue([1, 2, 3], 1);
    const { state: next, removedId, wasCurrent } = removeFromQueue(state, 1);
    expect(removedId).toBe(2);
    expect(wasCurrent).toBe(true);
    expect(next.ids).toEqual([1, 3]);
    /* 原来是中间那首，删掉后下标仍为 1 —— 指向接棒的下一首（3）。 */
    expect(currentId(next)).toBe(3);
  });

  it('删到空队列：index 夹回 -1 语义（空 ids 时 currentId 为 undefined）', () => {
    const { state: next, wasCurrent } = removeFromQueue(createQueue([9]), 0);
    expect(next.ids).toEqual([]);
    expect(wasCurrent).toBe(true);
    expect(currentId(next)).toBeUndefined();
  });

  it('越界原样返回', () => {
    const state = createQueue([1, 2], 0);
    expect(removeFromQueue(state, 5).state).toBe(state);
    expect(removeFromQueue(state, -1).state).toBe(state);
  });
});
