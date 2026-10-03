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
 *
 * 第十六轮第 1 / 3 / 4 条（用户原话「对英语单词不是一个字母一个字母往外冒，而是整个单词往外冒」、
 * 「一行歌词不是整齐的一行而是如图 2 所示」、「歌词冒出来是带旋转的」）再加一组 `buildStageAtoms`
 * 的回归：西文整词成原子、词间留真实空格原子、错落确定且有界。
 *
 * **用户本轮第 2 条**（「流光的歌词出现的动画重新做……要达到一样的视效」）之后，入场动效换成
 * folia classic 的三态模型，判据跟着换成 `classicMotionFor` 的六个数（落点 / 未唱 / 漂移）
 * 与 `CLASSIC_ACTIVE_SCALE`，见文件末尾那一组。
 */

import { describe, expect, it } from 'vitest';
import type { LyricLine } from '@pi/shared';
import {
  CLASSIC_ACTIVE_SCALE,
  CLOCK_STALL_MS,
  buildStageLines,
  clampFlyToFrame,
  classicActiveOverflowPadPx,
  classicFrameAt,
  classicJustifyGapPx,
  classicMotionFor,
  findActiveIndex,
  frameRunwayPx,
  resyncClock,
  smoothPositionAt,
  type FlyFrameBox,
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

  it('间奏前那一句不会被拉到间奏结束（用户 m06084 第 3 条：歌词进度滞后）', () => {
    // 六句普通歌词（间隔 1200ms）之后隔了 24s（间奏）才到下一句。
    const built = buildStageLines([
      lrc(0, '一句'),
      lrc(1200, '二句'),
      lrc(2400, '三句'),
      lrc(3600, '四句'),
      lrc(4800, '五句'),
      lrc(6000, '六句'),
      lrc(7200, '七句'),
      lrc(31200, '八句'),
    ]);
    // 间隔中位数 1200 ⇒ 封顶 1200 × 2.5 = 3000：第七句不能占满 24000ms 的间奏。
    expect(built[6]?.durationMs).toBe(3000);
    // 普通句（间隔就是中位数）不受封顶影响，行为与改造前一致。
    expect(built[0]?.durationMs).toBe(1200);
    // 最后一行没有下一行，仍走 4s 兜底。
    expect(built[7]?.durationMs).toBe(4000);
    // 均分路径也按封顶后的跨度摊：第七句两个字分别在 7200 / 8700 亮起，而不是爬 12s 一个字。
    expect(built[6]?.starts).toEqual([7200, 8700]);
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

  it('播放器一说停就**立刻**冻住，不等 CLOCK_STALL_MS（用户第 5 轮第 2 条）', () => {
    const anchor = resyncClock(1000, 0);
    // 暂停瞬间那一帧：锚点值本身，一点不外推 —— 旧写法这里会返回 1000 + dt。
    expect(smoothPositionAt(anchor, 0, false)).toBe(1000);
    expect(smoothPositionAt(anchor, 120, false)).toBe(1000);
    // 关键：在 `CLOCK_STALL_MS` **之前**（旧写法还在外推的那段窗口）也不能多走 ——
    // 用户原话「按暂停，歌词依旧会先走几步再猛地回到暂停的进度位置」说的就是这段窗口。
    expect(smoothPositionAt(anchor, 260, false)).toBe(1000);
    expect(smoothPositionAt(anchor, CLOCK_STALL_MS - 1, false)).toBe(1000);
    // 与旧行为对照：同一锚点、同一时刻，`playing` 为真时确实会外推出去（差别就是这一步）。
    expect(smoothPositionAt(anchor, 260)).toBe(1260);
    // 恢复播放后照旧外推（暂停不影响之后的对齐）。
    expect(smoothPositionAt(anchor, 300, true)).toBe(1300);
  });
});

describe('classicFrameAt（一帧的可视状态）', () => {
  // 第十六轮第 1 条起「状态」是逐**原子**的：中文一个字素一个原子，西文整词才是一个原子。
  // 这里故意换成两个字（'甲乙'）——均分时长与旧夹具 'ab' 逐位相同（各 2000ms），
  // 所以下面那组边界断言原样成立；换句话说这条用例同时钉住「中文仍然逐字」。
  const twoLines = buildStageLines([lrc(0, '甲乙'), lrc(4000, '下一句')]);

  it('换行只认 timeMs：下一句开始前的那一帧仍是上一句', () => {
    expect(classicFrameAt(twoLines, 3960, null).activeIndex).toBe(0);
    expect(classicFrameAt(twoLines, 3999, null).activeIndex).toBe(0);
    expect(classicFrameAt(twoLines, 4000, null).activeIndex).toBe(1);
  });

  it('一次只有一个字有高光（用户本轮第 2 条）；唱过的字才判 passed', () => {
    // '甲乙' 均分成 甲[0,2000) 乙[2000,4000)，normal 的预读窗口是 150ms。
    // **用户本轮第 2 条**（「一次只有一个字可以有高光」）：1850 / 1999 处不再出现两个 active ——
    // 甲还没唱完，乙即便已经进了预读窗口也仍是 waiting（旧口径这里会一起点亮两个字）。
    expect(classicFrameAt(twoLines, 800, null).states).toEqual(['active', 'waiting']);
    expect(classicFrameAt(twoLines, 1850, null).states).toEqual(['active', 'waiting']);
    expect(classicFrameAt(twoLines, 1999, null).states).toEqual(['active', 'waiting']);
    expect(classicFrameAt(twoLines, 2000, null).states).toEqual(['passed', 'active']);
    expect(classicFrameAt(twoLines, 2500, null).states).toEqual(['passed', 'active']);
    // 全行任意时刻最多一个 active —— 这条是上面那几个点的推广，防止下一轮又把预读窗口放开。
    for (let ms = 0; ms <= 4200; ms += 25) {
      const states = classicFrameAt(twoLines, ms, null).states ?? [];
      expect(states.filter((state) => state === 'active').length).toBeLessThanOrEqual(1);
    }
  });

  it('用户滚过（viewIndex 非空）时显示行停在用户那一句，但高亮/逐字仍跟播放', () => {
    // 播放已到第二句（4000ms 起），用户滚回第一句看词
    const frame = classicFrameAt(twoLines, 4500, 0);
    expect(frame.anchorIndex).toBe(0);
    expect(frame.activeIndex).toBe(1);
    expect(frame.states).toEqual(['passed', 'passed']);
  });

  it('空歌词返回 { activeIndex: -1, anchorIndex: 0, states: null }（舞台不炸）', () => {
    expect(classicFrameAt([], 1000, null)).toEqual({
      activeIndex: -1,
      anchorIndex: 0,
      states: null,
    });
  });
});

describe('buildStageLines 的原子（第十六轮：整词冒出 + 图 2 错落）', () => {
  /** 常用夹具：11 个字素均分 1100ms ⇒ 每个字素 100ms，算起来是整数，断言不踩浮点。 */
  const phrase = buildStageLines([lrc(0, 'hello world'), lrc(1100, 'next')]);

  it('西文一个词 = 一个原子（不是一字母一个），词间是一个不带 data-word-state 的空格原子', () => {
    const atoms = phrase[0]?.atoms ?? [];
    expect(atoms.map((atom) => atom.text)).toEqual(['hello', ' ', 'world']);
    expect(atoms.map((atom) => atom.spacer)).toEqual([false, true, false]);
    // 整词的时间是一个区间：start 取词首字素、end 取词尾字素（中间那 4 个字母不再单独成原子）
    expect(atoms[0]?.startMs).toBe(0);
    expect(atoms[0]?.endMs).toBe(500);
  });

  it('空格原子的宽度有下界：至少 0.38em（36px 最小字号下 = 13.7px，远大于探针的 4px 判据）', () => {
    for (const atom of phrase[0]?.atoms ?? []) {
      if (!atom.spacer) continue;
      expect(atom.gap).toBeGreaterThanOrEqual(0.38);
      expect(atom.gap).toBeLessThanOrEqual(0.54);
    }
  });

  it('整词一起亮：第一个字母刚亮时词尾的字母也已经是 active（不再一颗一颗往外冒）', () => {
    // states 与 atoms 同序（空格原子也占一格），但空格不渲染、不参与状态，所以这里只看非空格原子。
    const litStates = (positionMs: number): readonly string[] => {
      const states = classicFrameAt(phrase, positionMs, null).states ?? [];
      return (phrase[0]?.atoms ?? []).flatMap((atom, index) =>
        atom.spacer ? [] : [states[index] ?? '?'],
      );
    };
    // hello[0,500) 空格[500,600) world[600,1100)
    expect(litStates(300)).toEqual(['active', 'waiting']);
    // 唱到词尾之前（400ms，词内最后一个字母 400~500ms）整个词仍然是 active，不是一半亮一半暗
    expect(litStates(400)).toEqual(['active', 'waiting']);
    expect(litStates(700)).toEqual(['passed', 'active']);
    // 词的终点是包含的（upperBound 用 ≤）：1099ms 时 world 仍是 active，到 1100ms 才整词判过；
    // 但 1100ms 恰好是下一句的起点、显示行已经换成第二句，所以这里只量到 1099。
    expect(litStates(1099)).toEqual(['passed', 'active']);
  });

  it('yrc 路径（词间没有空格字素）也会补出词间空格原子，不会连成 havetokeephinding', () => {
    const built = buildStageLines([
      {
        timeMs: 0,
        text: 'hello world',
        durationMs: 2000,
        words: [
          { timeMs: 0, durationMs: 900, text: 'hello' },
          { timeMs: 900, durationMs: 1100, text: 'world' },
        ],
      },
      lrc(4000, 'next'),
    ]);
    expect(built[0]?.atoms.map((atom) => atom.text)).toEqual(['hello', ' ', 'world']);
    // 词首字素（wordStart）仍然被保留给主题层用，语义没动
    expect(built[0]?.words[0]?.wordStart).toBe(true);
    expect(built[0]?.words[5]?.wordStart).toBe(true);
  });

  it('两个相邻的西文原子之间**一定**隔着空格原子（探针「英文被拆开」判据要求 0 次）', () => {
    const built = buildStageLines([
      lrc(0, "今日は競艇 hello world don't well-known"),
      lrc(4000, 'next'),
    ]);
    const atoms = built[0]?.atoms ?? [];
    expect(atoms.length).toBeGreaterThan(4);
    for (let index = 1; index < atoms.length; index += 1) {
      const previous = atoms[index - 1];
      const current = atoms[index];
      if (previous === undefined || current === undefined) continue;
      if (previous.spacer || current.spacer) continue;
      const touchingLatin = /[A-Za-z]$/.test(previous.text) && /^[A-Za-z]/.test(current.text);
      expect(touchingLatin).toBe(false);
    }
  });

  it('三态动效是确定性的：同一行算两次逐位相同（不抖、不每帧重排）', () => {
    const again = buildStageLines([lrc(0, 'hello world'), lrc(1100, 'next')]);
    expect(again[0]?.atoms).toEqual(phrase[0]?.atoms);
    // 不同**行起点**是不同的随机种子（同一行每次渲染一致，但行与行不该长成复制粘贴）
    const twoSame = buildStageLines([lrc(0, '甲乙'), lrc(4000, '甲乙')]);
    expect(twoSame[0]?.atoms).not.toEqual(twoSame[1]?.atoms);
  });

  it('原子带上三态参数；空白原子一个都不带（不冒、不转、不动）', () => {
    const built = buildStageLines([lrc(0, 'hello world'), lrc(4000, 'next')]);
    const words = (built[0]?.atoms ?? []).filter((atom) => !atom.spacer);
    expect(words.length).toBeGreaterThan(1);
    for (const atom of words) {
      expect(atom.scale).toBeGreaterThan(0);
      expect(Number.isFinite(atom.waitX)).toBe(true);
      expect(Number.isFinite(atom.waitY)).toBe(true);
      expect(Number.isFinite(atom.passedRot)).toBe(true);
    }
    for (const atom of built[0]?.atoms ?? []) {
      if (!atom.spacer) continue;
      expect(atom.x).toBe(0);
      expect(atom.y).toBe(0);
      expect(atom.rot).toBe(0);
      expect(atom.passedRot).toBe(0);
      expect(atom.scale).toBe(1);
      expect(atom.waitX).toBe(0);
      expect(atom.waitY).toBe(0);
      expect(atom.waitRot).toBe(0);
    }
  });
});

/**
 * **用户本轮第 2 条**：流光的入场动效照 folia classic 的三态模型重做。
 *
 * 下面这一组直接钉 `classicMotionFor` —— 它就是 folia `classic/Visualizer.tsx` 里
 * `WordLayoutConfig` 那几行的本仓等价物（数值全部自己算，没抄源码文本）：
 *   · 落点：`x / y = (rand − 0.5) × spread × 2`，`rot = (rand − 0.5) × baseRotate × 2`，
 *     `passedRot = (rand − 0.5) × 漂移角幅度`（folia 原值 45 ⇒ ±22.5°，**本仓按档位分档**：
 *     chaotic 45 / moderate 15 / calm 0），`scale = 1.1 + rand × 0.2`（狂暴档 0.8 + rand × 0.6）；
 *   · 未唱：`waitX = x + sin(y) × 100`、`waitY = y + cos(x) × 50`、`waitRot = rot + 20`；
 *   · 「正在唱」的放大 = `scale × CLASSIC_ACTIVE_SCALE`（1.4），唱完回落 —— 这一条同时是
 *     用户同轮给云阶要的那件事（「单个字唱完就恢复大小」）在流光这一侧的判据。
 */
describe('classic 三态动效（folia classic 的 waiting / active / passed）', () => {
  it('参数只吃「行起点 + 原子下标」：同一输入逐位相同，换个下标就换一组', () => {
    const first = classicMotionFor(12_000, 3, 'moderate', true);
    expect(classicMotionFor(12_000, 3, 'moderate', true)).toEqual(first);
    expect(classicMotionFor(12_000, 4, 'moderate', true)).not.toEqual(first);
    expect(classicMotionFor(13_000, 3, 'moderate', true)).not.toEqual(first);
  });

  it('常速档的六个数都落在 folia 的区间里', () => {
    const motion = classicMotionFor(12_000, 3, 'moderate', true);
    expect(Math.abs(motion.x)).toBeLessThanOrEqual(20);
    expect(Math.abs(motion.y)).toBeLessThanOrEqual(20);
    expect(Math.abs(motion.rot)).toBeLessThanOrEqual(5);
    // **用户本轮第 2 条（第二遍）**：漂移角跟着档位分档 —— moderate 是 ±7.5°（folia 的
    // 原值 ±22.5° 只留给 chaotic；22° 的唱后角在目标图里看不到）。
    expect(Math.abs(motion.passedRot)).toBeLessThanOrEqual(7.5);
    expect(motion.scale).toBeGreaterThanOrEqual(1.1);
    expect(motion.scale).toBeLessThanOrEqual(1.3);
    // 未唱那一格：把落点再甩出去，横最多 100px、纵最多 50px，并额外歪 20°。
    expect(Math.abs(motion.waitX - motion.x)).toBeLessThanOrEqual(100);
    expect(Math.abs(motion.waitY - motion.y)).toBeLessThanOrEqual(50);
    expect(motion.waitRot - motion.rot).toBeCloseTo(20, 6);
  });

  it('chaotic 档真的用上了更大的摆幅与倾角（spread 60px / rotate 30°）', () => {
    let maxX = 0;
    let maxRot = 0;
    for (let index = 0; index < 24; index += 1) {
      const motion = classicMotionFor(12_000, index, 'chaotic', true);
      expect(Math.abs(motion.x)).toBeLessThanOrEqual(60);
      expect(Math.abs(motion.y)).toBeLessThanOrEqual(60);
      expect(Math.abs(motion.rot)).toBeLessThanOrEqual(30);
      expect(motion.scale).toBeGreaterThanOrEqual(0.8);
      expect(motion.scale).toBeLessThanOrEqual(1.4);
      maxX = Math.max(maxX, Math.abs(motion.x));
      maxRot = Math.max(maxRot, Math.abs(motion.rot));
    }
    // 摆幅确实吃到 20px 以上、倾角吃到 5° 以上（否则就是「参数改了但公式没接上」）
    expect(maxX).toBeGreaterThan(20);
    expect(maxRot).toBeGreaterThan(5);
  });

  it('关掉逐字旋转 ⇒ 三种角全是 0，位移与缩放照旧（folia 的 enableWordRotation）', () => {
    for (let index = 0; index < 12; index += 1) {
      const on = classicMotionFor(12_000, index, 'moderate', true);
      const off = classicMotionFor(12_000, index, 'moderate', false);
      expect(off.rot).toBe(0);
      expect(off.waitRot).toBe(0);
      expect(off.passedRot).toBe(0);
      expect(off.x).toBe(on.x);
      expect(off.y).toBe(on.y);
      expect(off.scale).toBe(on.scale);
      expect(off.waitX).toBe(on.waitX);
      expect(off.waitY).toBe(on.waitY);
      // 开着的时候确实有角（否则上一条就是空转）
      if (index === 0) expect(Math.abs(on.passedRot)).toBeGreaterThan(0);
    }
  });

  it('「正在唱」比「唱过」大 `CLASSIC_ACTIVE_SCALE` 倍，唱完立刻回落', () => {
    const motion = classicMotionFor(12_000, 3, 'moderate', true);
    expect(CLASSIC_ACTIVE_SCALE).toBe(1.4);
    expect(motion.scale * CLASSIC_ACTIVE_SCALE).toBeGreaterThan(motion.scale);
  });
});

/**
 * 用户 m00001 第 5 条（本轮）：「这个远处就是歌词字体的边框位置，现在的飞行距离太远了」。
 *
 * 夹取的三层里，前两层是纯函数（这一组钉它们），第三层 `clampWaitingFlyToFrame` 要量 DOM
 * （布局矩形 + 字号），在 node 环境下没有渲染器可量，所以这里只钉它的两个零件：
 * 一维的「只缩不放」（`clampFlyToFrame`）与二维的「沿这个方向到框边还有多远」（`frameRunwayPx`）。
 *
 * 口径提醒：这一组全是**像素**世界。**用户本轮第 2 条**之后两轴的意图都来自
 * `classicMotionFor` 的 `waitX/waitY`（±100px / ±50px），下面的 `flyX` 系数是**假设输入**
 * —— 夹取那两层一个字都没放宽，它只发生在布局阶段、只让实际起点离落点更近。
 */
describe('「远处」夹到歌词框内缘（clampFlyToFrame / frameRunwayPx）', () => {
  const box = (left: number, top: number, right: number, bottom: number): FlyFrameBox => ({
    left,
    top,
    right,
    bottom,
  });

  it('可用距离比意图大 ⇒ 原样返回意图（只缩不放，不做「凑到框边」）', () => {
    expect(clampFlyToFrame(230, 400)).toBe(230);
    expect(clampFlyToFrame(-230, 400)).toBe(-230);
    // 恰好相等也原样：夹取不是「一律改成 availablePx」的写法
    expect(clampFlyToFrame(400, 400)).toBe(400);
    expect(clampFlyToFrame(-400, 400)).toBe(-400);
    // 极端大的余量也不放大（1.9em 的意图不会被拉到 1000px 的框边上去）
    expect(clampFlyToFrame(-0.55, 1e9)).toBe(-0.55);
  });

  it('可用距离更小 ⇒ 夹到 ±可用距离，**符号不变**（该往上飞的还往上飞、该往左偏的还往左偏）', () => {
    expect(clampFlyToFrame(230, 74)).toBe(74);
    expect(clampFlyToFrame(-230, 74)).toBe(-74);
    // 方向由 `classicMotionFor` 的 `waitX/waitY` 决定，夹取一个字都不许改。
    expect(Math.sign(clampFlyToFrame(-317, 12))).toBe(-1);
    expect(Math.sign(clampFlyToFrame(317, 12))).toBe(1);
    expect(Math.abs(clampFlyToFrame(317, 12))).toBe(Math.abs(clampFlyToFrame(-317, 12)));
  });

  it('0 / 负数 / 非有限值 ⇒ 返回 0，绝不出 NaN（NaN 会让 --pi-word-wait-x/y 整条失效、字瞬移到落点）', () => {
    expect(clampFlyToFrame(230, 0)).toBe(0);
    expect(clampFlyToFrame(230, -5)).toBe(0);
    expect(clampFlyToFrame(-230, -5)).toBe(0);
    expect(clampFlyToFrame(Number.NaN, 100)).toBe(0);
    expect(clampFlyToFrame(230, Number.NaN)).toBe(0);
    expect(clampFlyToFrame(Number.POSITIVE_INFINITY, 100)).toBe(0);
    for (const value of [
      clampFlyToFrame(230, 0),
      clampFlyToFrame(230, -5),
      clampFlyToFrame(Number.NaN, Number.NaN),
    ]) {
      expect(Number.isNaN(value)).toBe(false);
    }
  });

  it('frameRunwayPx：从字心沿这个方向到框内缘，取四条边里最近的那条', () => {
    const frame = box(0, 0, 1000, 200);
    expect(frameRunwayPx(500, 100, 0, -1, frame)).toBe(100); // 正上方 ⇒ 到上缘
    expect(frameRunwayPx(500, 100, 0, 1, frame)).toBe(100); // 正下方 ⇒ 到下缘
    expect(frameRunwayPx(500, 100, -1, 0, frame)).toBe(500); // 正左 ⇒ 到左缘
    expect(frameRunwayPx(500, 100, 1, 0, frame)).toBe(500); // 正右 ⇒ 到右缘
    // 斜向取**先撞上**的那条边：y 方向只剩 60px、x 方向还剩 500px ⇒ 60√2（方向已归一化）
    expect(frameRunwayPx(500, 60, 1, -1, frame)).toBeCloseTo(60 * Math.SQRT2, 6);
    // 起点已经在框外（布局上不该出现，纯函数也不许给负数）/ 方向为零 / 非有限输入
    expect(frameRunwayPx(1200, 100, 1, 0, frame)).toBe(0);
    expect(frameRunwayPx(500, 100, 0, 0, frame)).toBe(0);
    expect(frameRunwayPx(Number.NaN, 100, 0, -1, frame)).toBe(0);
    expect(frameRunwayPx(500, 100, 0, -1, box(Number.NaN, 0, 1000, 200))).toBe(0);
  });

  it('缩完的起点正好落在框内缘、且整段飞行都在框里（121.4px 字号 × 紧包一行的框）', () => {
    // 字号：参考窗 1518×1018 下 classic 的 `clamp(2.25rem, 8cqi, 12rem)` ≈ 121.4px。
    // 框：classic 没有纸面框，取 `.pi-lyricstage__viewport`（紧包当前行的那一层）——
    // 高 ≈ 行盒 = 1.22 × 字号 ≈ 148px，宽 = 舞台宽 1480px。
    const fontSize = 121.4;
    const frame = box(0, 0, 1480, 148);
    const centerX = 700;
    const centerY = 74;
    // 四组**假设**的意图组合（纵向 1.9~3.4em 是旧口径的最大值，横向 0.25~0.55em 是现行值）：
    // 真实的纵向意图从用户本轮第 2 条起是 0，这里留着纵向是为了钉住夹取在**两维**上都成立。
    const pairs = [
      [-0.4, -3.1],
      [0.4, 3.1],
      [-0.25, -1.9],
      [0.55, 2.4],
    ] as const;
    for (const [flyX, flyY] of pairs) {
      const intentX = flyX * fontSize;
      const intentY = flyY * fontSize;
      const intent = Math.hypot(intentX, intentY);
      const runway = frameRunwayPx(centerX, centerY, intentX / intent, intentY / intent, frame);
      const scale = clampFlyToFrame(intent, runway) / intent;
      // 1.9em 的纵向意图 ≈ 231px，而字心到框内缘只有 74px ⇒ 一定被缩（用户说的「太远了」）。
      expect(scale).toBeLessThan(1);
      expect(scale).toBeGreaterThan(0);
      const endX = centerX + intentX * scale;
      const endY = centerY + intentY * scale;
      // 缩完的位置**在框内**（±1px：端点就是内缘，浮点上下取整）
      expect(endX).toBeGreaterThanOrEqual(-1);
      expect(endX).toBeLessThanOrEqual(1481);
      expect(endY).toBeGreaterThanOrEqual(-1);
      expect(endY).toBeLessThanOrEqual(149);
      // 而且方向没被改：夹取前后符号一致
      expect(Math.sign(intentX * scale)).toBe(Math.sign(intentX));
      expect(Math.sign(intentY * scale)).toBe(Math.sign(intentY));
    }
  });
});

/**
 * **用户第 9 轮第 2 条**（原话：「图 2 是对于流光，比较短的歌词，字与字应该有足够大的空隙，
 * 像图 3 一样。具体空隙多大智能决定」）。
 *
 * 量测依据（写进 `CLASSIC_JUSTIFY_TARGET` 的注释）：对照图那条五字短句量到字距 ≈1.9em、
 * 整行铺满窗宽 88%；我们那张量到 0.3em、43%。口径 = 按这一行剩下的余量摊，长句夹回 0.3em。
 */
describe('classicJustifyGapPx（用户第 9 轮第 2 条：短句字距按余量摊开）', () => {
  /** 典型：6cqi 在 1182 宽的窗口上 ≈70.9px（`.pi-lyricstage[data-theme='classic']` 的字号标定）。 */
  const fontPx = 70.9;
  const frameWidth = 1182;
  /** 落点缩放 1.2：墨迹 ≈ 布局盒 × 1.2（`--pi-word-scale` 是 1.1~1.3）。 */
  const visualOf = (chars: number): number => chars * fontPx * 1.2;

  it('五个字的短句：字距落在 1.5~1.8em，整行 ≈ 框宽的 80%（对照图是 88%）', () => {
    const gap = classicJustifyGapPx(visualOf(5), frameWidth, 4, fontPx);
    expect(gap / fontPx).toBeGreaterThan(1.5);
    expect(gap / fontPx).toBeLessThanOrEqual(1.8);
    const lineWidth = visualOf(5) + gap * 4;
    expect(lineWidth / frameWidth).toBeGreaterThan(0.75);
    expect(lineWidth / frameWidth).toBeLessThanOrEqual(0.82);
  });

  it('长句（墨迹已经接近框宽）⇒ 夹回 0.3em，与改造前逐位相同（不会因此换行）', () => {
    // 12 个字、墨迹 1021px：余量是负的
    expect(classicJustifyGapPx(visualOf(12), frameWidth, 11, fontPx)).toBeCloseTo(0.3 * fontPx, 6);
    // 刚好占满框宽
    expect(classicJustifyGapPx(frameWidth, frameWidth, 5, fontPx)).toBeCloseTo(0.3 * fontPx, 6);
    // 一个字都没有余量时也是下界
    expect(classicJustifyGapPx(frameWidth * 1.4, frameWidth, 3, fontPx)).toBeCloseTo(
      0.3 * fontPx,
      6,
    );
  });

  it('上限 1.8em：两三个字的句子不会被拉成一根面条', () => {
    for (const chars of [2, 3, 4]) {
      const gap = classicJustifyGapPx(visualOf(chars), frameWidth, chars - 1, fontPx);
      expect(gap).toBeLessThanOrEqual(1.8 * fontPx + 1e-9);
      expect(gap).toBeGreaterThanOrEqual(0.3 * fontPx - 1e-9);
    }
  });

  it('单调：同一行越短（墨迹越窄）字距越大；越长越小，一直到下界', () => {
    const gaps = [3, 4, 5, 6, 8, 10, 14].map((chars) =>
      classicJustifyGapPx(visualOf(chars), frameWidth, chars - 1, fontPx),
    );
    for (let index = 1; index < gaps.length; index += 1) {
      expect(gaps[index] ?? 0).toBeLessThanOrEqual(gaps[index - 1] ?? 0);
    }
    expect(gaps[0]).toBeGreaterThan(gaps[gaps.length - 1] ?? 0);
  });

  it('退化输入（0 / 负数 / NaN / Infinity / 只有一个间隙位）一律退回下界，绝不出 NaN', () => {
    const floor = 0.3 * fontPx;
    expect(classicJustifyGapPx(0, 0, 0, fontPx)).toBe(floor);
    expect(classicJustifyGapPx(Number.NaN, frameWidth, 4, fontPx)).toBe(floor);
    expect(classicJustifyGapPx(100, Number.POSITIVE_INFINITY, 4, fontPx)).toBe(floor);
    expect(classicJustifyGapPx(100, frameWidth, -1, fontPx)).toBe(floor);
    expect(classicJustifyGapPx(100, frameWidth, Number.NaN, fontPx)).toBe(floor);
    // 字号拿不到（算不出来）时退回 0，而不是 NaN —— NaN 会让整条 margin-right 失效、字瞬移。
    for (const value of [
      classicJustifyGapPx(100, frameWidth, 4, 0),
      classicJustifyGapPx(100, frameWidth, 4, Number.NaN),
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(0);
    }
  });
});

/*
 * ===========================================================================
 * 用户第二十三轮第 3 条的两条口径。
 * ===========================================================================
 */
describe('连字符 = 音节分隔（用户第二十三轮第 3 条，图 2 / 图 4）', () => {
  it('Oh-ah-oh 拆成三段，连字符跟着前一段走，断口上补一个空格原子', () => {
    const built = buildStageLines([lrc(0, 'Oh-ah-oh'), lrc(1100, 'next')]);
    const atoms = built[0]?.atoms ?? [];
    expect(atoms.map((atom) => atom.text)).toEqual(['Oh-', ' ', 'ah-', ' ', 'oh']);
    expect(atoms.map((atom) => atom.spacer)).toEqual([false, true, false, true, false]);
    // 时间戳仍然逐字素跟着数据走：`Oh-ah-oh` 八个字素均分 1100ms ⇒ 每字素 137.5ms，
    // 三段各自从自己的首字素起算（下标 0 / 3 / 6）。
    expect(atoms[0]?.startMs).toBe(0);
    expect(atoms[2]?.startMs).toBeCloseTo(412.5, 6);
    expect(atoms[4]?.startMs).toBeCloseTo(825, 6);
  });

  it('波浪号 / 长短破折号同样算分隔符（用户图里的 `~` 也在这一档）', () => {
    const built = buildStageLines([lrc(0, 'ha~ha—ha'), lrc(1100, 'next')]);
    expect(built[0]?.atoms.map((atom) => atom.text)).toEqual(['ha~', ' ', 'ha—', ' ', 'ha']);
  });

  it('普通西文词一个字节都没变：well-known 之外的 hello world 照旧整词 + 空格', () => {
    const built = buildStageLines([lrc(0, 'hello world'), lrc(1100, 'next')]);
    expect(built[0]?.atoms.map((atom) => atom.text)).toEqual(['hello', ' ', 'world']);
  });

  it('行首就是连接符时不拆（不产出空原子），字素也不丢', () => {
    const built = buildStageLines([lrc(0, '-oh-'), lrc(1100, 'next')]);
    const texts = built[0]?.atoms.map((atom) => atom.text) ?? [];
    expect(texts.join('')).toBe('-oh-');
    expect(texts).not.toContain('');
  });
});

describe('放大溢出占位（用户第二十三轮第 3 条，图 3「几个字挤在一起」）', () => {
  it('左右各摊一半：(k−1)·w/2，k = 落点缩放 × 1.4', () => {
    // 100px 的字放大 1.4 倍 ⇒ 多出 40px ⇒ 左右各 20px。
    expect(classicActiveOverflowPadPx(100, 1, CLASSIC_ACTIVE_SCALE)).toBeCloseTo(20, 6);
    // 落点本身就带缩放时两个因子相乘。
    expect(classicActiveOverflowPadPx(100, 1.2, 1.4)).toBeCloseTo(34, 6);
  });

  it('没放大（k ≤ 1）与拿不到宽度时一律 0：长句 / 未唱字的排版逐位不变', () => {
    expect(classicActiveOverflowPadPx(100, 1, 1)).toBe(0);
    expect(classicActiveOverflowPadPx(0, 1, 1.4)).toBe(0);
    expect(classicActiveOverflowPadPx(-20, 1, 1.4)).toBe(0);
    expect(classicActiveOverflowPadPx(Number.NaN, 1, 1.4)).toBe(0);
    expect(classicActiveOverflowPadPx(100, Number.NaN, 1.4)).toBe(0);
  });

  it('单调：字越宽、放大越多，占位越大', () => {
    const narrow = classicActiveOverflowPadPx(60, 1, 1.4);
    const wide = classicActiveOverflowPadPx(120, 1, 1.4);
    const bigger = classicActiveOverflowPadPx(120, 1, 1.8);
    expect(wide).toBeGreaterThan(narrow);
    expect(bigger).toBeGreaterThan(wide);
  });
});
