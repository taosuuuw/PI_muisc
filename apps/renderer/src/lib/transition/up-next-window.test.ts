import { describe, expect, it } from 'vitest';
import { CROSSFADE_SEC } from './schedule';
import { UP_NEXT_WINDOW_MS, upNextWindowMs } from './up-next-window';

/**
 * 这张卡片的窗口边界是「用户可见性」的直接原因：
 * 交叉档如果还按 5 秒算，交叉恰好在那 5 秒的起点切歌，卡片一帧都来不及画。
 */
describe('「接下来播放」卡片的显示窗口', () => {
  it('关门档：窗口就是最后 5 秒', () => {
    expect(upNextWindowMs('off')).toBe(UP_NEXT_WINDOW_MS);
  });

  it('交叉档：窗口往前挪一个交叉时长', () => {
    expect(upNextWindowMs('crossfade')).toBe(UP_NEXT_WINDOW_MS + CROSSFADE_SEC * 1000);
  });

  it('交叉档扣掉交叉时长后，仍给用户留满 5 秒的预告', () => {
    expect(upNextWindowMs('crossfade') - CROSSFADE_SEC * 1000).toBe(UP_NEXT_WINDOW_MS);
  });

  it('智能档要覆盖「提前 20 秒起手 + 8 秒过渡」，再加 5 秒预告', () => {
    expect(upNextWindowMs('automix')).toBe(UP_NEXT_WINDOW_MS + 20_000 + 8_000);
  });
});
