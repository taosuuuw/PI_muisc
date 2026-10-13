/**
 * 商籁**歌词换句交叉淡变**（`sonnetLyricCrossfade.ts`）的用例。
 *
 * 守的是渲染层"新旧歌词短暂共存"必须成立的几条：
 * ① **共存**：换句后的一段时间里，出场 α 与入场 α **同时大于 0**（不是硬切）；
 * ② **两层互补**：两者之和恒 ≈ 1（这只是**系数**互补，不保证屏幕上一定有字 ——
 *   新句的字可能还没轮到入场，可见性由逐字入场那套负责）；
 * ③ **旧出场画面一旦失效就直接切**：拖动 / 倒退（**包括同签名下的**）、resize、
 *   换 program、reduced motion，都要立刻丢掉出场画面，不留残影；
 * ④ **暂停也能走完**：进度只吃墙钟 ⇒ 暂停时淡变不会卡在半透明；
 * ⑤ **确定性**：同一输入反复求值结果相同，且输入状态不被改写。
 */

import { describe, expect, it } from 'vitest';

it('播放器几毫秒的时钟校正不会取消正在进行的淡变', () => {
  const initial = advanceSonnetLyricCrossfade(createSonnetLyricCrossfadeState(), {
    signature: 'old', timeSec: 1, nowMs: 1000,
  });
  const fading = advanceSonnetLyricCrossfade(initial.state, {
    signature: 'new', timeSec: 1.04, nowMs: 1040,
  });
  const corrected = advanceSonnetLyricCrossfade(fading.state, {
    signature: 'new', timeSec: 1.037, nowMs: 1100,
  });
  expect(corrected.state.outgoingSignature).toBe('old');
  expect(corrected.outgoingAlpha).toBeGreaterThan(0);
  expect(corrected.incomingAlpha).toBeGreaterThan(0);
});
import {
  SONNET_LYRIC_CROSSFADE_MS,
  advanceSonnetLyricCrossfade,
  createSonnetLyricCrossfadeState,
  describeSonnetLyricCrossfade,
  resolveSonnetLyricSignature,
  type SonnetLyricCrossfadeFrame,
  type SonnetLyricCrossfadeInput,
  type SonnetLyricCrossfadeState,
} from './sonnetLyricCrossfade';

const VIEWPORT = '1180x760';
const PROGRAM = 'progA';

/** 走一帧（返回新状态与新读数）。 */
function step(
  state: SonnetLyricCrossfadeState,
  signature: string,
  timeSec: number,
  nowMs: number,
  viewportKey = VIEWPORT,
  extra: Partial<SonnetLyricCrossfadeInput> = {},
): SonnetLyricCrossfadeFrame {
  return advanceSonnetLyricCrossfade(state, {
    signature,
    timeSec,
    nowMs,
    viewportKey,
    programKey: PROGRAM,
    ...extra,
  });
}

/** 起一段正在淡出的状态：`shot1|甲 → shot2|乙`，出场画面是 `shot1|甲`。 */
function midFade(nowMs = 1016): SonnetLyricCrossfadeFrame {
  const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲', 1, 1000);
  const swapped = step(first.state, 'shot2|乙', 1.04, nowMs);
  expect(swapped.phase).toBe('fade');
  expect(swapped.state.outgoingSignature).toBe('shot1|甲');
  return swapped;
}

describe('歌词交叉淡变：新旧画面短暂共存', () => {
  it('第一帧直接落位（不补间、不闪）', () => {
    const frame = step(createSonnetLyricCrossfadeState(), 'shot1|甲乙丙', 1, 1000);
    expect(frame.phase).toBe('hold');
    expect(frame.outgoingAlpha).toBe(0);
    expect(frame.incomingAlpha).toBe(1);
    expect(frame.state.live).toBe(true);
  });

  it('换句那一刻旧画面满、新画面零；半个窗口后两者都在画面上（共存）', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲乙丙', 1, 1000);
    const swapped = step(first.state, 'shot2|丁戊己', 1.04, 1016);
    expect(swapped.phase).toBe('fade');
    expect(swapped.outgoingAlpha).toBeCloseTo(1, 6);
    expect(swapped.incomingAlpha).toBeCloseTo(0, 6);
    expect(swapped.state.outgoingSignature).toBe('shot1|甲乙丙');

    const middle = step(swapped.state, 'shot2|丁戊己', 1.2, 1016 + SONNET_LYRIC_CROSSFADE_MS / 2);
    expect(middle.outgoingAlpha).toBeGreaterThan(0.2);
    expect(middle.incomingAlpha).toBeGreaterThan(0.2);
    expect(middle.outgoingAlpha + middle.incomingAlpha).toBeCloseTo(1, 6);

    const done = step(middle.state, 'shot2|丁戊己', 1.4, 1016 + SONNET_LYRIC_CROSSFADE_MS + 40);
    expect(done.outgoingAlpha).toBe(0);
    expect(done.incomingAlpha).toBe(1);
    expect(done.state.outgoingSignature).toBe('');
  });

  it('整个淡变窗口里两个 α 之和恒为 1（两层系数互补）', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲乙丙', 1, 1000);
    const swapped = step(first.state, 'shot2|丁戊己', 1.04, 2000);
    let state = swapped.state;
    for (let elapsed = 0; elapsed <= SONNET_LYRIC_CROSSFADE_MS; elapsed += 16) {
      const frame = step(state, 'shot2|丁戊己', 1.04 + elapsed / 1000, 2000 + elapsed);
      expect(frame.outgoingAlpha + frame.incomingAlpha).toBeCloseTo(1, 6);
      expect(frame.outgoingAlpha).toBeGreaterThanOrEqual(0);
      expect(frame.incomingAlpha).toBeGreaterThanOrEqual(0);
      state = frame.state;
    }
  });

  it('同一签名不重开淡变：淡变走完后继续播不透明，读数稳定在 hold', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲', 1, 0);
    const swapped = step(first.state, 'shot2|乙', 1.04, 100);
    const done = step(swapped.state, 'shot2|乙', 1.4, 100 + SONNET_LYRIC_CROSSFADE_MS + 1);
    for (let index = 0; index < 5; index += 1) {
      const frame = step(done.state, 'shot2|乙', 1.5 + index * 0.02, 2000 + index * 16);
      expect(frame.phase).toBe('hold');
      expect(frame.outgoingAlpha).toBe(0);
      expect(frame.incomingAlpha).toBe(1);
    }
  });

  it('暂停（唱词时刻不动、墙钟照走）时淡变仍能走完', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲', 3, 500);
    const swapped = step(first.state, 'shot2|乙', 3.001, 520);
    const half = step(swapped.state, 'shot2|乙', 3.001, 520 + SONNET_LYRIC_CROSSFADE_MS / 2);
    expect(half.outgoingAlpha).toBeGreaterThan(0.2);
    const done = step(half.state, 'shot2|乙', 3.001, 520 + SONNET_LYRIC_CROSSFADE_MS + 20);
    expect(done.outgoingAlpha).toBe(0);
    expect(done.incomingAlpha).toBe(1);
  });
});

describe('歌词交叉淡变：seek / 倒退 / resize 直接切', () => {
  it('时间向前跳一大步（拖动进度）判为 seek：不补间、出场画面立刻丢弃', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲', 1, 1000);
    const jumped = step(first.state, 'shot9|癸', 40, 1016);
    expect(jumped.phase).toBe('seek');
    expect(jumped.outgoingAlpha).toBe(0);
    expect(jumped.incomingAlpha).toBe(1);
    expect(jumped.state.outgoingSignature).toBe('');
  });

  it('倒退（往回拖）同样判为 seek', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot3|丙', 10, 1000);
    const back = step(first.state, 'shot2|乙', 9.5, 1016);
    expect(back.phase).toBe('seek');
    expect(back.outgoingAlpha).toBe(0);
  });

  it('seek 之后回到连续播放，正常换句仍然会交叉淡变（没有被永久关掉）', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲', 1, 1000);
    const jumped = step(first.state, 'shot9|癸', 40, 1016);
    const next = step(jumped.state, 'shot10|壬', 40.04, 1100);
    expect(next.phase).toBe('fade');
    expect(next.outgoingAlpha).toBeCloseTo(1, 6);
    expect(next.state.outgoingSignature).toBe('shot9|癸');
  });

  it('视口变化（resize）时出场画面坐标已过期 ⇒ 直接切', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲', 1, 1000);
    const resized = step(first.state, 'shot2|乙', 1.04, 1016, '900x600');
    expect(resized.phase).toBe('seek');
    expect(resized.outgoingAlpha).toBe(0);
    expect(resized.state.viewportKey).toBe('900x600');
  });

  it('淡变还没走完又换句（拖进度条的特征）⇒ 直接切，不叠第二层淡变', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲', 1, 1000);
    const swapped = step(first.state, 'shot2|乙', 1.04, 1016);
    const again = step(swapped.state, 'shot3|丙', 1.08, 1032);
    expect(again.phase).toBe('seek');
    expect(again.outgoingAlpha).toBe(0);
    expect(again.incomingAlpha).toBe(1);
    expect(again.state.outgoingSignature).toBe('');
  });

  /*
   * ⚠ 下面这几条守的是"**签名没变也要丢旧层**"：
   * 出场快照的坐标与内容属于换句前那一帧，同镜里的倒退 / 跳转（拖进度条）同样让它过期；
   * 只在"换签名"那一支上判，残影会留在画面上继续淡。
   */
  it('同签名 + 倒退（同镜往回拖）⇒ 丢掉出场画面，不留残影', () => {
    const swapped = midFade();
    const back = step(swapped.state, 'shot2|乙', 1.02, 1032);
    expect(back.phase).toBe('seek');
    expect(back.outgoingAlpha).toBe(0);
    expect(back.incomingAlpha).toBe(1);
    expect(back.state.outgoingSignature).toBe('');
  });

  it('同签名 + 向前跳一大步（同镜拖进度）⇒ 同样丢掉出场画面', () => {
    const swapped = midFade();
    const jumped = step(swapped.state, 'shot2|乙', 1.04 + 3, 1032);
    expect(jumped.phase).toBe('seek');
    expect(jumped.outgoingAlpha).toBe(0);
    expect(jumped.state.outgoingSignature).toBe('');
  });

  it('同签名 + 连续播（|Δt| 很小）⇒ 不误伤，淡变照常推进', () => {
    const swapped = midFade();
    const next = step(swapped.state, 'shot2|乙', 1.04 + 0.1, 1016 + 0.1 * 1000);
    expect(next.phase).toBe('hold');
    expect(next.outgoingAlpha).toBeGreaterThan(0.2);
    expect(next.state.outgoingSignature).toBe('shot1|甲');
  });

  it('换 program（切歌）⇒ 即使文字签名相同也丢掉上一首的出场画面', () => {
    const swapped = midFade();
    const changed = step(swapped.state, 'shot2|乙', 1.04 + 0.1, 1116, VIEWPORT, {
      programKey: 'progB',
    });
    expect(changed.phase).toBe('seek');
    expect(changed.outgoingAlpha).toBe(0);
    expect(changed.incomingAlpha).toBe(1);
    expect(changed.state.outgoingSignature).toBe('');
    expect(changed.state.programKey).toBe('progB');
  });

  it('换 program 之后的新句照常重新起淡变（没有被永久关掉）', () => {
    const swapped = midFade();
    const changed = step(swapped.state, 'shot2|乙', 1.14, 1116, VIEWPORT, { programKey: 'progB' });
    const next = step(changed.state, 'shot3|丙', 1.2, 1200, VIEWPORT, { programKey: 'progB' });
    expect(next.phase).toBe('fade');
    expect(next.state.outgoingSignature).toBe('shot2|乙');
  });

  it('reduced motion ⇒ 取消旧层，也不在换句时开淡变', () => {
    const swapped = midFade();
    const reduced = step(swapped.state, 'shot2|乙', 1.04 + 0.1, 1116, VIEWPORT, {
      reducedMotion: true,
    });
    expect(reduced.phase).toBe('seek');
    expect(reduced.outgoingAlpha).toBe(0);
    expect(reduced.incomingAlpha).toBe(1);
    expect(reduced.state.outgoingSignature).toBe('');

    /* 换句也不补间：直接落到新句（新句自己走逐字入场）。 */
    const swappedReduced = step(reduced.state, 'shot3|丙', 1.2, 1200, VIEWPORT, {
      reducedMotion: true,
    });
    expect(swappedReduced.phase).toBe('seek');
    expect(swappedReduced.outgoingAlpha).toBe(0);
  });
});

describe('歌词交叉淡变：签名与确定性', () => {
  it('签名只吃"镜 id + 非装饰文本"：同镜稳定、换镜或换字就变', () => {
    const glyphs = [
      { text: '甲', ghost: false },
      { text: '乙', ghost: false },
      { text: '丙', ghost: true },
    ];
    expect(resolveSonnetLyricSignature('shot1', glyphs)).toBe('shot1|甲乙');
    expect(resolveSonnetLyricSignature('shot1', glyphs)).toBe(
      resolveSonnetLyricSignature('shot1', glyphs),
    );
    expect(resolveSonnetLyricSignature('shot2', glyphs)).not.toBe(
      resolveSonnetLyricSignature('shot1', glyphs),
    );
    expect(resolveSonnetLyricSignature('shot1', [{ text: '甲丁', ghost: false }])).not.toBe(
      resolveSonnetLyricSignature('shot1', glyphs),
    );
  });

  it('同一输入反复求值结果相同，且不改写传入的状态', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲', 1, 1000);
    const swapped = step(first.state, 'shot2|乙', 1.04, 1016);
    const before = { ...swapped.state };
    const again = advanceSonnetLyricCrossfade(swapped.state, {
      signature: 'shot2|乙',
      timeSec: 1.2,
      nowMs: 1200,
      viewportKey: VIEWPORT,
    });
    const repeat = advanceSonnetLyricCrossfade(swapped.state, {
      signature: 'shot2|乙',
      timeSec: 1.2,
      nowMs: 1200,
      viewportKey: VIEWPORT,
    });
    expect(repeat).toEqual(again);
    expect(swapped.state).toEqual(before);
  });

  it('读数可读：phase 与两个 α 都在一行里', () => {
    const first = step(createSonnetLyricCrossfadeState(), 'shot1|甲', 1, 1000);
    expect(describeSonnetLyricCrossfade(first)).toBe('hold out=0.00 in=1.00 p=1.00');
  });
});
