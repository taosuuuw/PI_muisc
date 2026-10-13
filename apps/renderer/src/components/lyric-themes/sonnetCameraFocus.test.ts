/**
 * 商籁**预排构图**（`sonnetCameraFocus.ts`）的用例。
 *
 * 守的是替换掉"硬分页计划"之后必须成立的四条：
 * ① **提前**：下一词组开口**之前**焦点已经在向它靠（不是等它开唱才搬过去）；
 * ② **不逐字摇摆**：没有逐字落点数据时，同一个词组内焦点是常数（算法只吃"词组几何中心"）；
 * ③ **连续 / 无 overshoot / 无跳变**：密唱时焦点始终落在词组中心之间，采样变密则步长变小；
 * ④ **seek 一致**：`(词组, 时刻, 参数)` 决定一切，与访问顺序无关。
 * 另守参数口径（提前量 / 高斯宽度吃唱速、舒适区按世界缩放折算）与退化输入不产生 NaN。
 *
 * === 本轮新契约（用户录屏纠正）：镜头**不追字** ===
 * 焦点只吃三样：**最终落点**、**开始唱时刻**、**当前绝对时刻**。
 * 于是下面两组分别守：
 * · **长段低频推进**：长横排 / 长竖列在字还没出现前**不许**把焦点甩到整段远端，
 *   此后沿时间轴（不是沿入场运动）连续推进、唱完停在末字附近、密采样无速度尖峰；
 * · **与字形入场完全解耦**：任意改动逐字的入场位移 / α / 入场进度，焦点**逐值相同**
 *   —— 上一版"焦点跟着正在飞的那粒字走"的用例（及其接线）已按新契约删除。
 */

import { describe, expect, it } from 'vitest';

import {
  SONNET_CAMERA_FOCUS_COMFORT_HALF_X,
  SONNET_CAMERA_FOCUS_COMFORT_HALF_Y,
  SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_RATIO,
  SONNET_CAMERA_FOCUS_LEAD_BASE,
  SONNET_CAMERA_FOCUS_LEAD_SPEED_GAIN,
  SONNET_CAMERA_FOCUS_SIGMA_BASE,
  SONNET_CAMERA_FOCUS_SIGMA_SPEED_GAIN,
  emptySonnetCameraFocus,
  resolveSonnetCameraFocus,
  resolveSonnetCameraFocusBlockCenter,
  resolveSonnetCameraFocusFrontSigma,
  resolveSonnetCameraFocusHorizon,
  resolveSonnetCameraFocusLocalSigmas,
  type SonnetCameraFocus,
  type SonnetCameraFocusBlock,
} from './sonnetCameraFocus';
/* 入场用例要的是**帧层画字用的同一支**逐字运动函数（用它造"真的在飞"的入场数据）。 */
import { SONNET_GLYPH_CORE_ALPHA_BASE, resolveSonnetGlyphMotion } from './sonnetGlyphMotion';

const VIEWPORT = { viewportWidth: 1200, viewportHeight: 700 } as const;

/** 一个词组：中心 + **首 / 末字的开始唱时刻**（与帧层喂进来的区间同口径）。 */
function word(centerX: number, startTime: number, endTime: number, centerY = 350): SonnetCameraFocusBlock {
  return { startTime, endTime, centerX, centerY };
}

function focusAt(
  blocks: readonly SonnetCameraFocusBlock[],
  time: number,
  extra: Partial<Parameters<typeof resolveSonnetCameraFocus>[2]> = {},
): SonnetCameraFocus {
  const focus = resolveSonnetCameraFocus(blocks, time, { ...VIEWPORT, speed: 0.5, ...extra });
  if (focus === null) throw new Error(`t=${time} 没有焦点`);
  return focus;
}

/** 一行等距词组：每块 `duration` 秒、`gap` 秒间隔、横向 `step` 像素。 */
function lineOf(count: number, duration = 0.18, gap = 0.02, step = 90): SonnetCameraFocusBlock[] {
  return Array.from({ length: count }, (_unused, index) =>
    word(200 + index * step, index * (duration + gap), index * (duration + gap) + duration),
  );
}

/** 一个**长段**：`count` 粒字等距排开、每 `perGlyph` 秒出现一粒（`vertical` 时沿 y 排）。 */
function longRun(count: number, vertical = false, step = 100, perGlyph = 0.4): SonnetCameraFocusBlock {
  const glyphs = Array.from({ length: count }, (_unused, index) => ({
    x: vertical ? 100 : 100 + index * step,
    y: vertical ? 100 + index * step : 350,
    startTime: index * perGlyph,
  }));
  const span = (count - 1) * step;
  return {
    startTime: 0,
    endTime: (count - 1) * perGlyph,
    centerX: vertical ? 100 : 100 + span / 2,
    centerY: vertical ? 100 + span / 2 : 350,
    glyphs,
  };
}

describe('连续预测焦点：提前向下一个词组靠近', () => {
  const blocks = [word(0, 0, 0.4), word(1000, 2, 2.4)];

  it('下一词组开口前 0.3 秒，焦点已经基本落在那一边', () => {
    expect(focusAt(blocks, 0.1).aimX).toBeLessThan(50);
    const before = focusAt(blocks, 2 - 0.3).aimX;
    expect(before).toBeGreaterThan(900);
    /* 越接近开口越靠过去（单调，而不是"到点才搬"）。 */
    expect(focusAt(blocks, 2).aimX).toBeGreaterThan(before);
  });

  it('两个词组等距时焦点落在它们之间：不再按"还没显现"的 α 压住下一词组', () => {
    /*
     * 新契约：词组**之间**的权重只吃"到 cue 区间的距离"和局部唱速。
     * 上一版还乘了"该 run 逐字 α 的最大值"（0.6 + 0.4 × max α）—— 于是刚出现的词
     * 会把下一词组压下去，并且**每粒字入场都会改这个权重**，镜头就跟着字抖。
     * 这里两组的探针字都带 `motionX/motionY/weight/entryProgress`（真实入场那套字段），
     * 断言焦点只由几何与时间决定、落在两者之间。
     */
    const probeBlocks: SonnetCameraFocusBlock[] = [
      {
        startTime: 0,
        endTime: 0.8,
        centerX: 200,
        centerY: 350,
        glyphs: [{ x: 200, y: 350, startTime: 0, motionX: 40, motionY: 350, weight: 1, entryProgress: 1 }],
      },
      {
        startTime: 1,
        endTime: 1.3,
        centerX: 1000,
        centerY: 350,
        glyphs: [
          { x: 1000, y: 350, startTime: 1, motionX: 1300, motionY: 350, weight: 0.16, entryProgress: 0 },
        ],
      },
    ];
    const focus = focusAt(probeBlocks, 0.8);
    expect(focus.aimX).toBeGreaterThan(200);
    expect(focus.aimX).toBeLessThan(1000);
  });

  it('挪动是连续的：跨过前一词组的区间末端时没有台阶', () => {
    const dt = 1 / 240;
    let worstStep = 0;
    for (let time = 0.99; time <= 1.01; time += dt) {
      worstStep = Math.max(worstStep, Math.abs(focusAt(blocks, time + dt).aimX - focusAt(blocks, time).aimX));
    }
    /* 0.4 秒间隔、1000px 位移：跨过 cue 边界那一步只该走几个像素。 */
    expect(worstStep).toBeLessThan(20);
  });
});

describe('连续预测焦点：同一词组内不逐字摇摆', () => {
  it('只有一个词组时，焦点在整个区间与两侧都是那个词的几何中心（常数）', () => {
    const blocks = [word(321, 1, 2.5, 234)];
    for (let time = 0; time <= 4; time += 0.05) {
      const focus = focusAt(blocks, time);
      expect(focus.aimX).toBeCloseTo(321, 9);
      expect(focus.aimY).toBeCloseTo(234, 9);
    }
  });

  it('词组多字揭示期间同样不动：不给逐字揭示数据时算法没有逐字入口', () => {
    /* "多字词组"= 区间跨 1.2 秒（十来个字的唱时），焦点仍是常数。 */
    const blocks = [word(500, 3, 4.2, 350)];
    const first = focusAt(blocks, 3.1);
    for (let time = 3.1; time <= 4.1; time += 1 / 120) {
      const focus = focusAt(blocks, time);
      expect(focus.aimX).toBeCloseTo(first.aimX, 12);
      expect(focus.aimY).toBeCloseTo(first.aimY, 12);
    }
  });
});

describe('连续预测焦点：密唱连续、无 overshoot / 跳变、seek 一致', () => {
  const blocks = lineOf(14);

  const sampleSteps = (dt: number): { readonly worst: number; readonly min: number; readonly max: number } => {
    let worst = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let previous: number | null = null;
    for (let time = -0.5; time <= 3.5; time += dt) {
      const x = focusAt(blocks, time).aimX;
      min = Math.min(min, x);
      max = Math.max(max, x);
      if (previous !== null) worst = Math.max(worst, Math.abs(x - previous));
      previous = x;
    }
    return { worst, min, max };
  };

  it('焦点始终落在词组中心之间（加权中心是凸组合 ⇒ 不可能 overshoot）', () => {
    const fine = sampleSteps(1 / 240);
    const first = blocks[0]?.centerX ?? 0;
    const last = blocks[blocks.length - 1]?.centerX ?? 0;
    expect(fine.min).toBeGreaterThanOrEqual(Math.min(first, last) - 1e-9);
    expect(fine.max).toBeLessThanOrEqual(Math.max(first, last) + 1e-9);
  });

  it('采样越密步长越小（没有"一步搬过去"的跳变）', () => {
    const coarse = sampleSteps(1 / 60).worst;
    const fine = sampleSteps(1 / 240).worst;
    expect(fine).toBeLessThan(coarse);
    /* 60Hz 一步也不能走掉大半行（行宽 = 13 × 90 = 1170px）。 */
    expect(coarse).toBeLessThan(0.5 * 13 * 90);
  });

  it('往返量有界：总变差不超过首尾净位移（没有来回甩）', () => {
    const dt = 1 / 120;
    let travel = 0;
    let previous: number | null = null;
    let first: number | null = null;
    let last = 0;
    for (let time = -0.5; time <= 3.5; time += dt) {
      const x = focusAt(blocks, time).aimX;
      if (first === null) first = x;
      if (previous !== null) travel += Math.abs(x - previous);
      previous = x;
      last = x;
    }
    const net = Math.abs((last ?? 0) - (first ?? 0));
    expect(net).toBeGreaterThan(500);
    expect(travel / net).toBeLessThan(1.05);
  });

  it('seek 一致：先跑别处再回来，逐值相同', () => {
    const time = 1.234;
    const first = resolveSonnetCameraFocus(blocks, time, { ...VIEWPORT, speed: 0.5 });
    resolveSonnetCameraFocus(blocks, time + 2.5, { ...VIEWPORT, speed: 1 });
    resolveSonnetCameraFocus(blocks, 0, { ...VIEWPORT, speed: 0 });
    expect(resolveSonnetCameraFocus(blocks, time, { ...VIEWPORT, speed: 0.5 })).toEqual(first);
  });
});

describe('连续预测焦点：长段沿真实揭示推进（不整段抢跑）', () => {
  /* 21 粒字 × 100px = 2000px 的长句；每 0.4 秒出现一粒 ⇒ 整段唱 8 秒。 */
  const COUNT = 21;
  const STEP = 100;
  const PER_GLYPH = 0.4;
  const SPAN = (COUNT - 1) * STEP;
  const horizontal = longRun(COUNT, false, STEP, PER_GLYPH);

  it('横排：字还没出现时焦点停在首字附近，不跑到整段中心', () => {
    for (const time of [-2, -0.6, -0.2, 0]) {
      const focus = focusAt([horizontal], time);
      /* 首字在 x = 100；整段中心在 x = 1100。旧口径从第一个字起就给 1100。 */
      expect(focus.aimX).toBeLessThan(400);
    }
    expect(horizontal.centerX).toBeGreaterThan(1000);
  });

  it('竖排：同一套算法沿 y 走，字还没出现时同样停在首字附近', () => {
    const vertical = longRun(COUNT, true, STEP, PER_GLYPH);
    for (const time of [-2, -0.6, -0.2, 0]) {
      const focus = focusAt([vertical], time);
      expect(focus.aimY).toBeLessThan(400);
      /* 竖排时横坐标不该被"整段中心"带走（首字 x = 100）。 */
      expect(focus.aimX).toBeCloseTo(100, 6);
    }
    expect(vertical.centerY).toBeGreaterThan(1000);
  });

  it('沿 reveal 推进：揭示到哪儿焦点就在哪儿（不是整段中心）', () => {
    for (const fraction of [0.25, 0.5, 0.75]) {
      const time = fraction * (COUNT - 1) * PER_GLYPH;
      const focus = focusAt([horizontal], time);
      const rank = time / PER_GLYPH;
      /* 允许滞后（近期已显示的字主导）与一点点前瞻，但绝不允许提前到整段中心。 */
      expect(focus.aimX).toBeGreaterThan(100 + (rank - 3) * STEP);
      expect(focus.aimX).toBeLessThan(100 + (rank + 1.5) * STEP);
    }
  });

  it('连续：240Hz 采样下没有台阶，总变差接近净位移（不来回甩）', () => {
    let worstStep = 0;
    let travel = 0;
    let previous: number | null = null;
    let first: number | null = null;
    let last = 0;
    for (let time = -1; time <= (COUNT - 1) * PER_GLYPH + 1; time += 1 / 240) {
      const x = focusAt([horizontal], time).aimX;
      if (first === null) first = x;
      if (previous !== null) {
        worstStep = Math.max(worstStep, Math.abs(x - previous));
        travel += Math.abs(x - previous);
      }
      previous = x;
      last = x;
    }
    /* 一个字 100px / 0.4s：240Hz 一步约 1px，跨过"字出现"那一刻也不该有台阶。 */
    expect(worstStep).toBeLessThan(5);
    const net = Math.abs(last - (first ?? 0));
    expect(net).toBeGreaterThan(0.6 * SPAN);
    expect(travel / net).toBeLessThan(1.35);
  });

  it('焦点始终落在"出现过（或马上要出现）的字"的范围内（凸组合，不 overshoot）', () => {
    for (let time = -0.5; time <= (COUNT - 1) * PER_GLYPH + 0.5; time += 0.05) {
      const focus = focusAt([horizontal], time);
      const rank = Math.max(0, Math.min(COUNT - 1, time / PER_GLYPH));
      /* 凸组合：焦点永远在整行的字之间，不会 overshoot 到行外。 */
      expect(focus.aimX).toBeGreaterThan(100 - 1e-6);
      expect(focus.aimX).toBeLessThanOrEqual(100 + SPAN + 1e-6);
      /* 也不许抢在"还没出现的字"前面超过约一粒半（那就是"轻微提前"的上限）。 */
      expect(focus.aimX).toBeLessThanOrEqual(100 + (Math.ceil(rank) + 1.5) * STEP + 1e-6);
      expect(focus.aimY).toBeCloseTo(350, 6);
    }
  });

  it('短段（字同时出现）等价于原来的静态中心；没有逐字数据时逐值不变', () => {
    const block: SonnetCameraFocusBlock = {
      startTime: 1,
      endTime: 1,
      centerX: 480,
      centerY: 350,
      glyphs: [
        { x: 380, y: 350, startTime: 1 },
        { x: 480, y: 350, startTime: 1 },
        { x: 580, y: 350, startTime: 1 },
      ],
    };
    for (const time of [0.5, 1, 1.5, 3]) {
      const center = resolveSonnetCameraFocusBlockCenter(block, time);
      expect(center.x).toBeCloseTo(480, 9);
      expect(center.y).toBeCloseTo(350, 9);
    }
    const plain: SonnetCameraFocusBlock = { startTime: 1, endTime: 2, centerX: 321, centerY: 234 };
    expect(resolveSonnetCameraFocusBlockCenter(plain, 1.5)).toEqual({ x: 321, y: 234 });
    /* 逐字数据全不合法时也退回静态中心，绝不产生 NaN。 */
    const broken: SonnetCameraFocusBlock = {
      startTime: 1,
      endTime: 2,
      centerX: 321,
      centerY: 234,
      glyphs: [{ x: Number.NaN, y: 0, startTime: 1 }],
    };
    expect(resolveSonnetCameraFocusBlockCenter(broken, 1.5)).toEqual({ x: 321, y: 234 });
  });
});

describe('连续预测焦点：参数口径与退化输入', () => {
  it('提前量 / 高斯宽度只由唱速决定', () => {
    const blocks = [word(400, 0, 0.4)];
    const slow = focusAt(blocks, 0.2, { speed: 0 });
    const fast = focusAt(blocks, 0.2, { speed: 1 });
    expect(slow.leadSeconds).toBeCloseTo(SONNET_CAMERA_FOCUS_LEAD_BASE, 9);
    expect(fast.leadSeconds).toBeCloseTo(SONNET_CAMERA_FOCUS_LEAD_BASE + SONNET_CAMERA_FOCUS_LEAD_SPEED_GAIN, 9);
    expect(slow.sigmaSeconds).toBeCloseTo(SONNET_CAMERA_FOCUS_SIGMA_BASE, 9);
    expect(fast.sigmaSeconds).toBeCloseTo(SONNET_CAMERA_FOCUS_SIGMA_BASE + SONNET_CAMERA_FOCUS_SIGMA_SPEED_GAIN, 9);
  });

  it('舒适区是焦点周围固定比例（按世界缩放折算回画布像素）', () => {
    const focus = focusAt([word(600, 0, 1, 300)], 0.5, { screenScale: 2 });
    const halfX = (VIEWPORT.viewportWidth * SONNET_CAMERA_FOCUS_COMFORT_HALF_X) / 2;
    const halfY = (VIEWPORT.viewportHeight * SONNET_CAMERA_FOCUS_COMFORT_HALF_Y) / 2;
    expect(focus.maxX - focus.aimX).toBeCloseTo(halfX, 9);
    expect(focus.maxY - focus.aimY).toBeCloseTo(halfY, 9);
    expect(focus.minX).toBeCloseTo(focus.aimX - halfX, 9);
    expect(focus.minY).toBeCloseTo(focus.aimY - halfY, 9);
  });

  it('没有词组 / 词组数据不合法 ⇒ null；空焦点读数是 blockCount = 0', () => {
    expect(resolveSonnetCameraFocus([], 1, VIEWPORT)).toBeNull();
    expect(resolveSonnetCameraFocus([word(0, 0, 1)], 1, { ...VIEWPORT, viewportWidth: 0 })).toBeNull();
    const broken: SonnetCameraFocusBlock = { startTime: Number.NaN, endTime: 1, centerX: 0, centerY: 0 };
    expect(resolveSonnetCameraFocus([broken], 1, VIEWPORT)).toBeNull();
    expect(emptySonnetCameraFocus(10, 20).blockCount).toBe(0);
    expect(emptySonnetCameraFocus(10, 20).summary).toBe('focus=none');
  });

  it('极长空档里高斯全部下溢时退回最近词组，绝不产生 NaN', () => {
    const blocks = [word(120, 1000, 1000.5), word(-50, 1001, 1001.5)];
    const focus = focusAt(blocks, 0);
    expect(Number.isFinite(focus.aimX)).toBe(true);
    expect(Number.isFinite(focus.aimY)).toBe(true);
    expect(focus.aimX).toBe(120);
  });
});

/*
 * === 长段揭示轨迹（实际逐字入场）===
 *
 * 这一组是**实际入场运动**，不是"理论落位静态盒"：
 * 每一粒字的位置与 α 都由 `resolveSonnetGlyphMotion`（帧层画字用的**同一支**函数）在
 * 当前时刻算出来 —— 正在入场的字在**真实画的位置**上，还没出现的字只给落点。
 * 守三件事：
 * ① 还没出现时停在首字附近，不跑向整段中心；
 * ② 出现之后单调向前推进、不抢在没出现的字前面太多；
 * ③ 正在入场的字**带着焦点走**（真实位置，不是最终落位）。
 */
const TRACK_COUNT = 21;
const TRACK_STEP = 100;
const TRACK_PER_GLYPH = 0.4;
/** 首字 x = 100、末字 x = 2100、整段静态中心 x = 1100（旧口径的"远端"）。 */
const TRACK_FIRST_X = 100;
const TRACK_LAST_X = TRACK_FIRST_X + (TRACK_COUNT - 1) * TRACK_STEP;

function aimAt(block: SonnetCameraFocusBlock, time: number): number {
  return focusAt([block], time).aimX;
}

describe('长段低频推进：沿时间轴（不是沿入场运动）走', () => {
  it('字还没出现时停在首字附近（不跑向整段中心 1100）', () => {
    const block = longRun(TRACK_COUNT, false, TRACK_STEP, TRACK_PER_GLYPH);
    for (const time of [-2, -0.5, -0.2, 0]) {
      expect(aimAt(block, time)).toBeLessThan(400);
    }
  });

  it('首字出现之后单调向前推进（采样 0.25 秒，没有回头）', () => {
    const block = longRun(TRACK_COUNT, false, TRACK_STEP, TRACK_PER_GLYPH);
    let previous = aimAt(block, 0);
    let advanced = 0;
    for (let time = 0.25; time <= (TRACK_COUNT - 1) * TRACK_PER_GLYPH; time += 0.25) {
      const x = aimAt(block, time);
      expect(x).toBeGreaterThanOrEqual(previous - 1e-9);
      advanced += x - previous;
      previous = x;
    }
    /* 整段唱完时确实走过了大半个行宽（不是"停在原地"）。 */
    expect(advanced).toBeGreaterThan(0.7 * (TRACK_LAST_X - TRACK_FIRST_X));
  });

  it('任何时刻都不抢在"还没出现的字"前面超过约一粒半', () => {
    const block = longRun(TRACK_COUNT, false, TRACK_STEP, TRACK_PER_GLYPH);
    for (let time = -0.5; time <= (TRACK_COUNT - 1) * TRACK_PER_GLYPH + 0.5; time += 0.05) {
      const rank = Math.max(0, Math.min(TRACK_COUNT - 1, time / TRACK_PER_GLYPH));
      const limit = TRACK_FIRST_X + (Math.ceil(rank) + 1.5) * TRACK_STEP;
      expect(aimAt(block, time)).toBeLessThanOrEqual(limit + 1e-6);
    }
  });

  it('唱完之后停在末字附近（不再漂）', () => {
    const block = longRun(TRACK_COUNT, false, TRACK_STEP, TRACK_PER_GLYPH);
    const settled = aimAt(block, (TRACK_COUNT - 1) * TRACK_PER_GLYPH + 1);
    expect(settled).toBeGreaterThan(TRACK_LAST_X - 1.5 * TRACK_STEP);
    expect(settled).toBeLessThanOrEqual(TRACK_LAST_X);
    /*
     * 再往后 3 秒只挪一点点：宽窗口的尾巴虽然比"单峰"长，远处字的相对权重仍然迅速变小。
     * 上限按**0.15 个字步**（15px）卡住 —— 足够松（宽窗口收尾本来就会轻轻继续靠），
     * 又足够紧（数秒内不漂出一个字）。
     */
    expect(Math.abs(aimAt(block, (TRACK_COUNT - 1) * TRACK_PER_GLYPH + 4) - settled)).toBeLessThan(15);
  });

  it('密采样没有速度尖峰：最长一步略高于恒定 250px/s，字出现的时刻不额外冲一下', () => {
    const block = longRun(TRACK_COUNT, false, TRACK_STEP, TRACK_PER_GLYPH);
    const dt = 1 / 240;
    const speeds: { readonly time: number; readonly speed: number }[] = [];
    let previous: number | null = null;
    for (let time = -0.5; time <= (TRACK_COUNT - 1) * TRACK_PER_GLYPH + 0.5; time += dt) {
      const x = aimAt(block, time);
      if (previous !== null) speeds.push({ time, speed: Math.abs(x - previous) / dt });
      previous = x;
    }
    const sorted = speeds.map((sample) => sample.speed).sort((first, second) => first - second);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const peak = sorted[sorted.length - 1] ?? 0;
    /* 100px / 0.4s = 250px/s 是这一段唱速下的基准；窗口把速度抹平，峰值不该远超它。 */
    expect(median).toBeGreaterThan(50);
    expect(peak).toBeLessThan(400);
    /* 字出现的时刻（±0.03s）速度与全体峰值同量级 ⇒ 没有"字一冒出来就抖一下"。 */
    let glyphPeak = 0;
    for (const sample of speeds) {
      const phase = sample.time / TRACK_PER_GLYPH;
      if (Math.abs(phase - Math.round(phase)) < 0.03 / TRACK_PER_GLYPH) {
        glyphPeak = Math.max(glyphPeak, sample.speed);
      }
    }
    expect(glyphPeak).toBeLessThanOrEqual(peak + 1e-9);
    expect(glyphPeak).toBeLessThan(400);
  });

  it('确定：同一时刻反复求值逐值相同（seek 可重放）', () => {
    const block = longRun(TRACK_COUNT, false, TRACK_STEP, TRACK_PER_GLYPH);
    const first = resolveSonnetCameraFocus([block], 3.7, { ...VIEWPORT, speed: 0.5 });
    resolveSonnetCameraFocus([block], 100, { ...VIEWPORT, speed: 1 });
    resolveSonnetCameraFocus([block], -5, { ...VIEWPORT, speed: 0 });
    expect(resolveSonnetCameraFocus([block], 3.7, { ...VIEWPORT, speed: 0.5 })).toEqual(first);
  });
});

/*
 * === 新契约：镜头**不追字** ===
 *
 * 用户录屏指出"每个歌词字冒出来镜头就抖一次"——根因是上一版把**正在入场的字**直接喂进
 * 世界轴心：段内中心用 `motionX/motionY`（落位 + 入场位移）、权重用**真实入场 α**，
 * 段间还按"每个 run 逐字 α 的最大值"再乘一次。于是每一粒字冒出都会顶一下镜头。
 *
 * 新契约把路径的输入收缩到**只有**：最终落点、开始唱时刻、当前绝对时刻。
 * 下面这一组就用**同一份最终排版、同一份时间轴**，只改逐字入场数据（位移 / α / 进度都来自
 * 帧层画字用的同一支 `resolveSonnetGlyphMotion`），断言焦点**逐值相同**。
 */
const ENTRY_FONT_PX = 80;
const ENTRY_SHOT_SPAN = 11;
const ENTRY_PER_GLYPH = 0.5;
const ENTRY_DURATION = 0.8;
/** 入场位移取 mask-reveal 那一档的量级（`−0.2 ×` 视口宽 ≈ 300px）。 */
const ENTRY_OFFSET = 300;

/** 一段**真的在入场**的长句：逐字带 `motionX/motionY/weight/entryProgress`（帧层给的那套）。 */
function enteringRun(count: number, vertical: boolean, time: number): SonnetCameraFocusBlock {
  const glyphs = Array.from({ length: count }, (_unused, index) => {
    const startTime = index * ENTRY_PER_GLYPH;
    const settleTime = startTime + ENTRY_DURATION;
    const enterX = vertical ? 0 : -ENTRY_OFFSET;
    const enterY = vertical ? ENTRY_OFFSET : 0;
    const motion = resolveSonnetGlyphMotion({
      startTime,
      settleTime,
      time,
      finalRotation: 0,
      entryRotation: 0,
      enterX,
      enterY,
      emphasis: false,
      shotKind: 'editorial-column',
      role: 'support',
      fontPx: ENTRY_FONT_PX,
      normal: { x: 0, y: 1 },
      shotDuration: ENTRY_SHOT_SPAN,
      echoSide: 1,
    });
    const x = vertical ? 600 : TRACK_FIRST_X + index * TRACK_STEP;
    const y = vertical ? TRACK_FIRST_X + index * TRACK_STEP : 350;
    return {
      x,
      y,
      startTime,
      motionX: x + motion.offsetX,
      motionY: y + motion.offsetY,
      /* 与帧层同式：还没轮到的字给"它出现那一刻的 α"，不是 0。 */
      weight: motion.waiting ? SONNET_GLYPH_CORE_ALPHA_BASE : motion.alpha,
      entryProgress: motion.progress,
    };
  });
  const last = TRACK_FIRST_X + (count - 1) * TRACK_STEP;
  return {
    startTime: 0,
    endTime: (count - 1) * ENTRY_PER_GLYPH,
    centerX: vertical ? 600 : (TRACK_FIRST_X + last) / 2,
    centerY: vertical ? (TRACK_FIRST_X + last) / 2 : 350,
    glyphs,
  };
}

/**
 * **同一份排版、同一份时间轴，但只给最终落点** —— 把入场字段整体剥掉，
 * 与真实入场版的差就只剩"有没有那些字段"。
 */
function landingOnly(block: SonnetCameraFocusBlock): SonnetCameraFocusBlock {
  return {
    ...block,
    glyphs: block.glyphs?.map((glyph) => ({
      x: glyph.x,
      y: glyph.y,
      startTime: glyph.startTime,
    })),
  };
}

/** **改造前的口径**：落点 + 权重一律 1（没有逐字 α）。 */
function boxOnly(block: SonnetCameraFocusBlock): SonnetCameraFocusBlock {
  return {
    ...block,
    glyphs: block.glyphs?.map((glyph) => ({
      x: glyph.x,
      y: glyph.y,
      startTime: glyph.startTime,
    })),
  };
}

function centerOf(block: SonnetCameraFocusBlock, time: number): { x: number; y: number } {
  return resolveSonnetCameraFocusBlockCenter(block, time);
}

describe('新契约：镜头与逐字入场解耦（不再追字）', () => {
  const ENTRY_TIMES = [-0.5, 0, 0.05, 0.9, 2.05, 2.55, 3.6, 5.55, 8.2];

  it('段内中心：同一份时间轴与落点上，任意改动入场位移 / α / 入场进度都逐值相同（横排 / 竖排）', () => {
    for (const vertical of [false, true]) {
      for (const time of ENTRY_TIMES) {
        const block = enteringRun(12, vertical, time);
        for (const sampleTime of [time, time + 0.09, time + 0.5]) {
          const withMotion = centerOf(block, sampleTime);
          const without = centerOf(landingOnly(block), sampleTime);
          const legacy = centerOf(boxOnly(block), sampleTime);
          expect(withMotion).toEqual(without);
          expect(withMotion).toEqual(legacy);
          expect(Number.isFinite(withMotion.x)).toBe(true);
          expect(Number.isFinite(withMotion.y)).toBe(true);
        }
      }
    }
  });

  it('整段焦点：任意改动入场位移 / α / 进度都逐值相同（横排 / 竖排）', () => {
    for (const vertical of [false, true]) {
      for (const time of ENTRY_TIMES) {
        const withMotion = resolveSonnetCameraFocus([enteringRun(12, vertical, time)], time, {
          ...VIEWPORT,
          speed: 0.5,
        });
        const without = resolveSonnetCameraFocus([landingOnly(enteringRun(12, vertical, time))], time, {
          ...VIEWPORT,
          speed: 0.5,
        });
        expect(withMotion).not.toBeNull();
        expect(withMotion).toEqual(without);
      }
    }
  });

  it('还没出现的字不会改镜头：只有"最终排版 + cue"决定焦点', () => {
    /*
     * 上一版这里守的是"未来字只做低权重前瞻"；新契约下未来字的**入场 α** 根本不进算法 ——
     * 无论给不给 α，焦点都由这一段的落点与 cue 时间算出，和已经唱出来的那几粒同一条路径。
     */
    const time = 0.05;
    const block = enteringRun(12, false, time);
    const withMotion = resolveSonnetCameraFocus([block], time, { ...VIEWPORT, speed: 0.5 });
    const old = resolveSonnetCameraFocus([boxOnly(block)], time, { ...VIEWPORT, speed: 0.5 });
    expect(withMotion).not.toBeNull();
    expect(old).toEqual(withMotion);
    /* 首字刚出现时焦点在首字附近：不因为后面 11 粒字的落点被拽走。 */
    expect(withMotion?.aimX).toBeLessThan(TRACK_FIRST_X + 2.5 * TRACK_STEP);
  });

  it('入场途中镜头也不动：逐字"飞"的过程中焦点只随时间轴走', () => {
    /*
     * 第 6 粒（index 5）在 t = 2.5 出现、0.8 秒后才落位。旧口径下这 0.8 秒里它的
     * `motionX` 从 −300px 漂回落点、α 从 0.16 涨到 1，镜头会跟着这条曲线走。
     * 新口径：这 0.8 秒里镜头只按 cue 时间轴推进（下面用"同一时刻的落点版"逐值对齐来证明）。
     */
    /*
     * 入场位移实测（0.8 秒的 `expoOut`）：300 → 126 → 53 → 9 → 2 px —— α 同步从 0.16 涨到 1。
     * 旧口径下焦点会沿这条曲线挪 300px；新口径下逐值等于"同一时刻的落点版"。
     */
    for (const time of [2.5, 2.6, 2.7, 2.9, 3.1]) {
      const block = enteringRun(12, false, time);
      const enteringGlyph = block.glyphs?.[5];
      expect(enteringGlyph).toBeDefined();
      if (enteringGlyph === undefined) continue;
      if (time <= 2.7) {
        /* 至少前三拍确实在"飞"（真实位置与落点差着入场位移量级）。 */
        expect(Math.abs((enteringGlyph.motionX ?? 0) - enteringGlyph.x)).toBeGreaterThan(50);
      }
      const focus = resolveSonnetCameraFocus([block], time, { ...VIEWPORT, speed: 0.5 });
      const landingFocus = resolveSonnetCameraFocus([landingOnly(block)], time, {
        ...VIEWPORT,
        speed: 0.5,
      });
      expect(focus).toEqual(landingFocus);
    }
  });
});

/*
 * === 水平长句：显现前沿（因果平滑）与屏幕锚定 ===
 *
 * 这一组守 `resolveSonnetCameraFocusHorizon` 的性质与"屏幕锚定只在
 * ① 落位确实是一条横向阅读路径、② 调用者给得出取景事实 时才启用"这条闸门。
 * 连续性口径是 **C¹**（Rayleigh 核 `K′(0⁺) = 0`，每粒字 cue 处速度没有台阶），
 * 屏幕上的最终比例由 `sonnetReadingFrame.test.ts` 的**生产投影**用例验收。
 */

/** 一条横排长段：每粒字一个"最终右缘"（`edgeX`），每 `perGlyph` 秒出现一粒。 */
function horizonRun(count: number, step: number, perGlyph: number, edgePad = 45): SonnetCameraFocusGlyphLike[] {
  return Array.from({ length: count }, (_unused, index) => ({
    x: 100 + index * step,
    y: 350,
    startTime: index * perGlyph,
    edgeX: 100 + index * step + edgePad,
  }));
}

interface SonnetCameraFocusGlyphLike {
  readonly x: number;
  readonly y: number;
  readonly startTime: number;
  readonly edgeX: number;
}

/** "最近已经开始唱的那一粒的最终右缘"——阶梯。 */
function staircaseEdge(glyphs: readonly SonnetCameraFocusGlyphLike[], time: number): number {
  let chosen = glyphs[0];
  for (const glyph of glyphs) {
    if (glyph.startTime <= time + 1e-9 && (chosen === undefined || glyph.startTime >= chosen.startTime)) {
      chosen = glyph;
    }
  }
  return chosen?.edgeX ?? 0;
}

describe('水平长句显现前沿：因果平滑（永不领先阶梯 / 单调 / C¹ 连续）', () => {
  const GLYPHS = horizonRun(21, 100, 0.4);
  const SIGMA = resolveSonnetCameraFocusFrontSigma(GLYPHS);
  const horizon = (time: number, glyphs = GLYPHS): number =>
    resolveSonnetCameraFocusHorizon(glyphs, time, SIGMA, 0);

  it('任何时刻都不领先"最近已开始唱的那一粒的右缘"（单边核只滞后）', () => {
    for (let time = -1; time <= 10; time += 1 / 120) {
      expect(horizon(time)).toBeLessThanOrEqual(staircaseEdge(GLYPHS, time) + 1e-9);
    }
  });

  it('单调不减，且唱完之后停在尾端（不再漂）', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (let time = -1; time <= 12; time += 1 / 120) {
      const value = horizon(time);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
    expect(horizon(12)).toBeCloseTo(GLYPHS.at(-1)?.edgeX ?? 0, 6);
  });

  it('1/240 秒采样没有台阶：一步只有约一个字距 / 240 / (字距秒数) 的量级', () => {
    let worst = 0;
    let previous: number | null = null;
    for (let time = -1; time <= 9; time += 1 / 240) {
      const value = horizon(time);
      if (previous !== null) worst = Math.max(worst, Math.abs(value - previous));
      previous = value;
    }
    /* 100px / 0.4s = 250px/s ⇒ 1/240 秒一步约 1px；因果平滑不该放大它。 */
    expect(worst).toBeLessThan(2);
  });

  it('每粒字 cue 处**速度没有台阶**（C¹）：左右有限差分随 eps → 0 收敛到同一值', () => {
    /*
     * 旧核（正态 CDF `erf`）在 cue 处的右导数 = `√(2/π) / σ ≈ 0.798 / σ`、左导数 = 0，
     * 于是每一粒字都叠一个"跳变 × 0.798 / σ"的速度台阶；独立探针（25 粒字、100px 步进、
     * 0.36s 字距、σ = 0.216）实测左 93.54 / 右 462.94px/s、跳幅 369.40，而且**换 eps 不变**
     * （真的断，不是采样误差）。Rayleigh 核 `K′(0⁺) = 0` ⇒ 台阶消失：左右差分只差一个
     * 随 eps 线性归零的余项（本用例的 fixture 是 0.4s 字距 ⇒ σ = 0.18，余项略大但同样归零）。
     */
    const oneSidedGap = (eps: number): number => {
      let worst = 0;
      for (let index = 1; index < GLYPHS.length; index += 1) {
        const cue = GLYPHS[index]?.startTime ?? 0;
        const left = (horizon(cue) - horizon(cue - eps)) / eps;
        const right = (horizon(cue + eps) - horizon(cue)) / eps;
        worst = Math.max(worst, Math.abs(right - left));
      }
      return worst;
    };
    const coarse = oneSidedGap(1e-4);
    const fine = oneSidedGap(1e-5);
    const finer = oneSidedGap(1e-6);
    /* 台阶若还在，这三个数会几乎相等（旧核恒 ≈ 369px/s）；现在必须一路归零。 */
    expect(coarse).toBeLessThan(1);
    expect(fine).toBeLessThan(0.1);
    expect(finer).toBeLessThan(0.01);
    expect(finer).toBeLessThan(fine * 0.2);
    expect(fine).toBeLessThan(coarse * 0.2);
  });

  it('未来的字不进式：把还没开始唱的字挪远，当前前沿逐值不变', () => {
    const time = 1.2;
    const base = horizon(time);
    const moved = GLYPHS.map((glyph, index) =>
      index >= 6 ? { ...glyph, x: glyph.x + 900, edgeX: glyph.edgeX + 900 } : glyph,
    );
    expect(horizon(time, moved)).toBe(base);
  });

  it('没有逐字数据 / 参数不合法时退回兜底值，绝不产生 NaN', () => {
    expect(resolveSonnetCameraFocusHorizon([], 1, 0.2, 123)).toBe(123);
    expect(resolveSonnetCameraFocusHorizon(GLYPHS, Number.NaN, Number.NaN, 7)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(resolveSonnetCameraFocusHorizon(GLYPHS, 3.3, 0, 0))).toBe(true);
  });
});

/*
 * ------------------------------------------------------------------ *
 * SONNET_RESET_CONTINUOUS_20261014：**C¹ 也会逐字顿挫**
 *
 * 用户截图确认（向井太一《リセット》1:11 起）：镜头"随逐字冒出一停一顿"。
 * 复现口径是**实际歌曲**的 YRC 逐字 cue（第 12 行 71.78~76.23，间隔
 * `0.32 0.19 0.61 0.41 0.52 0.32 0.71 0.25 0.25 0.32 0.39 0.10` 秒，中位 0.32）。
 *
 * 根因不是"有台阶"（Rayleigh 核 `K′(0⁺)=0` 已经把台阶归零，上一轮验过），而是
 * **整段共用一个 σ**：`σ = 0.45 × 中位字距 ≈ 0.14s`，而 0.52~0.71s 的空档里
 * 上一跳的核早已衰减到 ~0 ⇒ 下一粒字开口前整条前沿**停住**，四秒半里出现 12 个
 * 逐字速度脉冲（生产 fixture 实测固定世界点速度在 74.68~74.85s 掉到 ~0px/s）。
 *
 * 修法：把 σ 逐跳化 —— `σᵢ = base × clamp(max(前一字距, 后一字距)/中位字距, 1, 2)`。
 * 均匀字距 ⇒ 倍率恒 1 ⇒ 与旧口径**逐值相同**（上面整组用例一字未改），
 * 不均匀字距里长音前的跳被摊宽，下一粒字开口时仍在贡献速度 ⇒ 速度不落近 0。
 * 下面这一组同时守住"判别性"（旧口径真的会停）与三条老性质（永不领先 / 单调 / C¹）。
 */
describe('不均匀 cue：长音前的跳不被摊成"逐字起停"（本轮修）', () => {
  /** 真实《リセット》第 12 行的 cue 间隔（秒），与 fixture 逐值一致。 */
  const REAL_GAPS = [0.32, 0.19, 0.61, 0.41, 0.52, 0.32, 0.71, 0.25, 0.25, 0.32, 0.39, 0.1];
  /** 一条不均匀字距的长横排：字身步进仍取 100px，只有 cue 间隔不均匀。 */
  const UNEVEN: SonnetCameraFocusGlyphLike[] = (() => {
    const glyphs: SonnetCameraFocusGlyphLike[] = [{ x: 100, y: 350, startTime: 0, edgeX: 145 }];
    let time = 0;
    REAL_GAPS.forEach((gap, index) => {
      time += gap;
      glyphs.push({
        x: 100 + (index + 1) * 100,
        y: 350,
        startTime: time,
        edgeX: 145 + (index + 1) * 100,
      });
    });
    return glyphs;
  })();
  const SIGMA = resolveSonnetCameraFocusFrontSigma(UNEVEN);

  /** **旧口径**（本轮前）：整段共用 `SIGMA`，逐跳跳变量取"逐字右缘差"。 */
  const uniformSigmaHorizon = (time: number): number => {
    let value = UNEVEN[0]?.edgeX ?? 0;
    for (let index = 1; index < UNEVEN.length; index += 1) {
      const current = UNEVEN[index];
      const previous = UNEVEN[index - 1];
      if (current === undefined || previous === undefined) continue;
      const offset = time - current.startTime;
      if (offset <= 0) continue;
      value += (current.edgeX - previous.edgeX) * -Math.expm1(-0.5 * (offset / SIGMA) * (offset / SIGMA));
    }
    return value;
  };
  const horizonAt = (time: number): number =>
    resolveSonnetCameraFocusHorizon(UNEVEN, time, SIGMA, UNEVEN[0]?.edgeX ?? 0);

  /** 行内速度曲线（`dt` 秒采样）：从**第二粒字之后**量起，跳过"首字还没有跳变"的引子。 */
  const velocity = (horizon: (time: number) => number, dt: number): number[] => {
    const from = (UNEVEN[1]?.startTime ?? 0) + 0.1;
    const to = UNEVEN.at(-1)?.startTime ?? 0;
    const values: number[] = [];
    let previous = horizon(from);
    for (let time = from + dt; time <= to + 1e-9; time += dt) {
      const value = horizon(time);
      values.push((value - previous) / dt);
      previous = value;
    }
    return values;
  };
  /** 近 0 谷占比（速度 < 20% 均值）——"逐字走停"的可数形式。 */
  const nearZeroShare = (values: readonly number[]): number => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return values.filter((value) => value < mean * 0.2).length / values.length;
  };

  it('均匀字距逐值不变：每粒字的核宽都等于基准 σ（不回归既有横排读数）', () => {
    const uniform = horizonRun(21, 100, 0.4);
    const sigma = resolveSonnetCameraFocusFrontSigma(uniform);
    const sigmas = resolveSonnetCameraFocusLocalSigmas(uniform, sigma);
    expect(sigmas).toHaveLength(uniform.length);
    for (const value of sigmas) expect(value).toBeCloseTo(sigma, 12);
    /* 逐值对拍：整段一个 σ 与逐跳 σ 在同一条时间轴上给出同一个前沿。 */
    for (let time = -0.5; time <= 9; time += 1 / 120) {
      let reference = uniform[0]?.edgeX ?? 0;
      for (let index = 1; index < uniform.length; index += 1) {
        const current = uniform[index];
        const previous = uniform[index - 1];
        if (current === undefined || previous === undefined) continue;
        const offset = time - current.startTime;
        if (offset <= 0) continue;
        reference +=
          (current.edgeX - previous.edgeX) *
          -Math.expm1(-0.5 * (offset / sigma) * (offset / sigma));
      }
      expect(resolveSonnetCameraFocusHorizon(uniform, time, sigma, 0)).toBeCloseTo(reference, 9);
    }
  });

  it('不均匀字距：长音两侧的跳按局部字距摊宽（夹到基准 σ 的 2 倍以内），未来落点不进式', () => {
    const sigmas = resolveSonnetCameraFocusLocalSigmas(UNEVEN, SIGMA);
    expect(sigmas).toHaveLength(UNEVEN.length);
    /* 每个核宽都在 [σ, 2σ] 内：只放大、不缩小，且放大有上限。 */
    for (const value of sigmas) {
      expect(value).toBeGreaterThanOrEqual(SIGMA - 1e-12);
      expect(value).toBeLessThanOrEqual(SIGMA * 2 + 1e-12);
    }
    /* 局部字距超过中位的那些跳确实被摊宽（否则本用例是空转）。 */
    const widened = sigmas.filter((value) => value > SIGMA * 1.5).length;
    expect(widened).toBeGreaterThanOrEqual(4);
    /* 长音前的跳（后面跟着 0.71 / 0.61 / 0.52 秒空档）是摊得最宽的那几粒。 */
    const widest = Math.max(...sigmas);
    expect(widest).toBeCloseTo(SIGMA * 2, 6);
    /* 未来落点不进式：把还没开始唱的字挪远，当前前沿逐值不变。 */
    const time = 1.2;
    const base = horizonAt(time);
    const moved = UNEVEN.map((glyph, index) =>
      index >= 6 ? { ...glyph, x: glyph.x + 900, edgeX: glyph.edgeX + 900 } : glyph,
    );
    expect(resolveSonnetCameraFocusHorizon(moved, time, SIGMA, 0)).toBe(base);
  });

  it('行内速度不再出现近 0 谷：与"整段一个 σ"的判别性对照', () => {
    const dt = 1 / 120;
    const oldShare = nearZeroShare(velocity(uniformSigmaHorizon, dt));
    const newValues = velocity(horizonAt, dt);
    const newShare = nearZeroShare(newValues);
    const mean = newValues.reduce((sum, value) => sum + value, 0) / newValues.length;
    /* 旧口径真的会"逐字走停"（否则本用例证明不了任何东西）。 */
    expect(oldShare).toBeGreaterThan(0.08);
    /* 新口径行内不落近 0：近 0 谷占比从 ~19% 降到 ~1% 以下，最低速度仍 ≥ 均值的 15%。 */
    expect(newShare).toBeLessThan(0.01);
    expect(Math.min(...newValues)).toBeGreaterThan(mean * 0.15);
    /* 有歌曲节奏、但不是逐字脉冲：峰谷比收在 2.6 以内。 */
    expect(Math.max(...newValues) / mean).toBeLessThan(2.6);
  });

  it('自适应后三条老性质一条不少：永不领先阶梯 / 单调不减 / cue 处速度无台阶（C¹）', () => {
    const from = (UNEVEN[0]?.startTime ?? 0) - 0.5;
    const to = (UNEVEN.at(-1)?.startTime ?? 0) + 3;
    let previous = Number.NEGATIVE_INFINITY;
    for (let time = from; time <= to; time += 1 / 240) {
      const value = horizonAt(time);
      expect(value).toBeLessThanOrEqual(staircaseEdge(UNEVEN, time) + 1e-9);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
    const oneSidedGap = (eps: number): number => {
      let worst = 0;
      for (let index = 1; index < UNEVEN.length; index += 1) {
        const cue = UNEVEN[index]?.startTime ?? 0;
        const left = (horizonAt(cue) - horizonAt(cue - eps)) / eps;
        const right = (horizonAt(cue + eps) - horizonAt(cue)) / eps;
        worst = Math.max(worst, Math.abs(right - left));
      }
      return worst;
    };
    const coarse = oneSidedGap(1e-4);
    const fine = oneSidedGap(1e-5);
    expect(coarse).toBeLessThan(2);
    expect(fine).toBeLessThan(0.2);
    expect(fine).toBeLessThan(coarse * 0.3);
  });
});


describe('水平长句屏幕锚定：只在"横向阅读路径 + 有取景事实"时启用', () => {
  const LONG = longRun(21, false, 100, 0.4);
  const VERTICAL = longRun(21, true, 100, 0.4);
  const SHORT: SonnetCameraFocusBlock = {
    startTime: 0,
    endTime: 0.6,
    centerX: 400,
    centerY: 350,
    glyphs: Array.from({ length: 4 }, (_unused, index) => ({
      x: 400 + index * 40,
      y: 350,
      startTime: index * 0.2,
      edgeX: 400 + index * 40 + 20,
    })),
  };
  /** 生产口径的最小取景事实：屏幕原点 + 本帧世界缩放（+ 句末构图比例）。 */
  const anchor = {
    ...VIEWPORT,
    speed: 0.5,
    basePositionX: 600,
    worldScale: 1,
    horizontalTailRatio: 0.67,
  } as const;

  it('横向长句：轴心按 `basePosition + 世界缩放 × (落点 − 轴心)` 反解 ⇒ 前沿落在目标比例上', () => {
    /* 展开期（显现前沿世界进度 ≈ 0.3 < 0.55）目标就是 `frontRatio`。 */
    const focus = focusAt([LONG], 3, anchor);
    expect(focus.screenAnchored).toBe(true);
    const frontScreen = anchor.basePositionX + anchor.worldScale * (focus.frontRatio - focus.aimX);
    expect(frontScreen).toBeCloseTo(SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_RATIO * VIEWPORT.viewportWidth, 6);
  });

  it('句末构图：显现前沿走到整行末端时目标比例渐变到 0.67（前沿就是尾端）', () => {
    /*
     * 两段口径（本轮改）：句末渐变的进度取自**显现前沿的世界进度**（前沿走到整行末端 = 1），
     * 不再是 cue 时间进度。前沿是因果平滑量，**渐近**逼近末端（Rayleigh 尾），所以：
     * · 末字起唱后 0.6 秒（t=8.6）尾端已经落在 0.67 的**一个像素以内**；
     * · 完全饱和（t=10，offset/σ ≫ 8.6 ⇒ `K` 在 double 下精确为 1）时**逐值等于 0.67**。
     */
    const nearlyDone = focusAt([LONG], 8.6, anchor);
    expect(nearlyDone.screenAnchored).toBe(true);
    const nearlyScreen =
      anchor.basePositionX + anchor.worldScale * (nearlyDone.frontRatio - nearlyDone.aimX);
    expect(Math.abs(nearlyScreen - 0.67 * VIEWPORT.viewportWidth)).toBeLessThan(1);

    const saturated = focusAt([LONG], 10, anchor);
    expect(saturated.screenAnchored).toBe(true);
    const frontScreen =
      anchor.basePositionX + anchor.worldScale * (saturated.frontRatio - saturated.aimX);
    expect(frontScreen).toBeCloseTo(0.67 * VIEWPORT.viewportWidth, 6);
  });

  it('竖排长列不被强加：给不给取景事实，轴心逐值相同（且不标记屏幕锚定）', () => {
    const withAnchor = focusAt([VERTICAL], 3, anchor);
    const plain = focusAt([VERTICAL], 3, VIEWPORT);
    expect(withAnchor.screenAnchored).toBe(false);
    expect(withAnchor.aimX).toBe(plain.aimX);
    expect(withAnchor.frontRatio).toBe(plain.frontRatio);
  });

  it('短句不被强加：横向跨度不够时同样逐值退回旧口径', () => {
    const withAnchor = focusAt([SHORT], 0.3, anchor);
    const plain = focusAt([SHORT], 0.3, VIEWPORT);
    expect(withAnchor.screenAnchored).toBe(false);
    expect(withAnchor.aimX).toBe(plain.aimX);
  });

  it('二维散布 / 走回头路的排版不被当成横向阅读路径', () => {
    /* 交叉轴散布很大：y 极差 1200 > max(0.2 × 700, 0.3 × 2000) = 600。 */
    const scattered: SonnetCameraFocusBlock = {
      ...longRun(21, false, 100, 0.4),
      glyphs: Array.from({ length: 21 }, (_unused, index) => ({
        x: 100 + index * 100,
        y: index % 2 === 0 ? 100 : 1300,
        startTime: index * 0.4,
        edgeX: 100 + index * 100 + 45,
      })),
    };
    expect(focusAt([scattered], 4, anchor).screenAnchored).toBe(false);
    /* 走回头路：x 一左一右（总变差 ≫ 净位移）。 */
    const zigzag: SonnetCameraFocusBlock = {
      ...longRun(21, false, 100, 0.4),
      glyphs: Array.from({ length: 21 }, (_unused, index) => ({
        x: index % 2 === 0 ? 100 + index * 100 : 100 + (index - 1) * 100 - 400,
        y: 350,
        startTime: index * 0.4,
        edgeX: (index % 2 === 0 ? 100 + index * 100 : 100 + (index - 1) * 100 - 400) + 45,
      })),
    };
    expect(focusAt([zigzag], 4, anchor).screenAnchored).toBe(false);
  });
});

/*
 * ------------------------------------------------------------------ *
 * SONNET_RIGHTWARD_SWAY_20261013：**同一横向阅读通路不许左右拉扯**
 *
 * 两个根因各守一条（都是"预排路径"层面的口径，不是历史低通滤波）：
 *
 * ① **小幅局部反向落点**：排版允许某一粒字落在前一粒的左边（强调块换行 / 字重 / 间距），
 *    而"总变差 ≤ 1.45 × 净位移"的闸门恰恰放行它们。旧口径把"**最近开始唱的那一粒**的右缘"
 *    当阶梯 ⇒ 前沿跟着这粒字回头 ⇒ 屏幕锚定出的轴心在词间左右拉扯。
 *    新口径取沿读法方向的**运行极值**（= "已显现内容的引导边界"）：反向落点只让边界原地不动。
 *    对严格单调的排版，运行极值与逐字口径**逐值相同**（下面的对拍用例）。
 *
 * ② **句末构图的空档**：旧口径按 **cue 时间进度**把目标比例从 `frontRatio` 推向 `tailRatio`。
 *    遇到长音空档时前沿在世界里停住、目标比例还在往 0.67 爬 —— 屏幕上的尾端要往右挪，
 *    只能靠镜头**往左退**（真歌《One More Light》167.05~172.25s 那一镜实测反向 66.9px）。
 *    新口径按**显现前沿的世界进度**推：前沿不涨，目标不动 ⇒ 空档里轴心停住而不是倒退。
 *
 * 记录（Codex 只读 baseline-source 对照，1/120 秒采样、同一份 fixture）：
 * · A 反向落点：`rev 4 / 87.9px / maxRun 50.8px` → `rev 0 / 0px`；
 * · B 句末空档：`rev 1 / 249.5px / maxRun 249.5px` → `rev 0 / 0px`。
 */
describe('横向阅读通路方向连贯：反向落点与句末空档都不许回头', () => {
  /** 量一条采样序列的"反向次数 / 累计反向距离 / 单次反向行程"（主方向 = 净位移方向）。 */
  function reversalsOf(
    values: readonly number[],
    dt: number,
    noise: number,
  ): { readonly reversals: number; readonly reverseDistance: number; readonly maxReverseRun: number } {
    const net = (values.at(-1) ?? 0) - (values[0] ?? 0);
    const dominant = net >= 0 ? 1 : -1;
    let reversals = 0;
    let reverseDistance = 0;
    let maxReverseRun = 0;
    let run = 0;
    for (let index = 1; index < values.length; index += 1) {
      const delta = (values[index] ?? 0) - (values[index - 1] ?? 0);
      const speed = delta / dt;
      if (Math.abs(speed) > noise && speed * dominant < 0) {
        if (run === 0) reversals += 1;
        run += Math.abs(delta);
        reverseDistance += Math.abs(delta);
        if (run > maxReverseRun) maxReverseRun = run;
      } else {
        run = 0;
      }
    }
    return { reversals, reverseDistance, maxReverseRun };
  }

  /** 一串等距字：run 内部 x 单调、给定起点（起点可"退"到上一 run 末字左边 ⇒ 反向落点）。 */
  function focusRun(
    startX: number,
    startTime: number,
    count = 6,
    pitch = 100,
    step = 0.4,
  ): SonnetCameraFocusBlock {
    const glyphs = Array.from({ length: count }, (_unused, index) => {
      const x = startX + index * pitch;
      return { x, y: 0, startTime: startTime + index * step, edgeX: x + pitch * 0.5 };
    });
    const minX = glyphs[0]?.x ?? startX;
    const maxX = (glyphs.at(-1)?.edgeX ?? startX) as number;
    return {
      startTime,
      endTime: startTime + (count - 1) * step,
      centerX: (minX + maxX) / 2,
      centerY: 0,
      minX,
      minY: -pitch * 0.5,
      maxX,
      maxY: pitch * 0.5,
      glyphs,
    };
  }

  const ANCHOR_FACTS = {
    viewportWidth: 1524,
    viewportHeight: 827,
    speed: 0.5,
    basePositionX: 762,
    worldScale: 1,
    horizontalFrontRatio: SONNET_CAMERA_FOCUS_HORIZONTAL_FRONT_RATIO,
    horizontalTailRatio: 0.67,
  } as const;

  function sampleFocus(
    blocks: readonly SonnetCameraFocusBlock[],
    to: number,
    extra: Partial<Parameters<typeof resolveSonnetCameraFocus>[2]> = {},
  ): { readonly aim: number[]; readonly front: number[]; readonly anchored: boolean[] } {
    const dt = 1 / 120;
    const aim: number[] = [];
    const front: number[] = [];
    const anchored: boolean[] = [];
    for (let time = 0; time <= to; time += dt) {
      const focus = resolveSonnetCameraFocus(blocks, time, { ...ANCHOR_FACTS, ...extra });
      if (focus === null) continue;
      aim.push(focus.aimX);
      front.push(focus.frontRatio);
      anchored.push(focus.screenAnchored);
    }
    return { aim, front, anchored };
  }

  it('① 多 run 长横排 + 小幅局部反向落点：轴心不回头，且前沿取的是"已显现内容的引导边界"', () => {
    /*
     * 4 个 run × 6 字、字距 100；每个 run 的起点比上一个 run 的末字 x **退回** 10~30px：
     * 总变差 / 净位移 = 1.062（闸门 1.45 放行），但逐字右缘在 3 个 run 边界各回一次头。
     */
    const blocks = [
      focusRun(0, 0),
      focusRun(470, 2.4),
      focusRun(950, 4.8),
      focusRun(1440, 7.2),
    ];
    const sorted = blocks
      .flatMap((block) => block.glyphs ?? [])
      .slice()
      .sort((first, second) => first.startTime - second.startTime);
    let variation = 0;
    for (let index = 1; index < sorted.length; index += 1) {
      variation += Math.abs((sorted[index]?.x ?? 0) - (sorted[index - 1]?.x ?? 0));
    }
    const net = Math.abs((sorted.at(-1)?.x ?? 0) - (sorted[0]?.x ?? 0));
    /* 先确认 fixture 真的是"闸门放行的反向落点"，不是单调排版。 */
    expect(variation / net).toBeGreaterThan(1);
    expect(variation / net).toBeLessThan(1.45);

    const { aim, front, anchored } = sampleFocus(blocks, 12);
    expect(anchored.every((value) => value)).toBe(true);
    const aimMotion = reversalsOf(aim, 1 / 120, 8);
    expect(aimMotion.reversals).toBe(0);
    expect(aimMotion.reverseDistance).toBeLessThan(1);
    /* 前沿本身沿读法方向单调，且停在整行引导边界（最大右缘）上。 */
    for (let index = 1; index < front.length; index += 1) {
      expect(front[index]!).toBeGreaterThanOrEqual((front[index - 1] ?? 0) - 1e-9);
    }
    const maxEdge = Math.max(...sorted.map((glyph) => glyph.edgeX ?? glyph.x));
    expect(front.at(-1)!).toBeCloseTo(maxEdge, 4);
  });

  it('① 对拍：严格单调的排版上，运行极值口径与"最近一粒右缘"逐值相同（不回归旧读数）', () => {
    const glyphs = Array.from({ length: 15 }, (_unused, index) => ({
      x: 100 + index * 100,
      y: 0,
      startTime: index * 0.4,
      edgeX: 100 + index * 100 + 40,
    }));
    const sigma = resolveSonnetCameraFocusFrontSigma(glyphs);
    const oldFormula = (time: number): number => {
      let value = glyphs[0]?.edgeX ?? 0;
      for (let index = 1; index < glyphs.length; index += 1) {
        const current = glyphs[index];
        const previous = glyphs[index - 1];
        if (current === undefined || previous === undefined) continue;
        const offset = time - current.startTime;
        if (offset <= 0) continue;
        const jump = current.edgeX - previous.edgeX;
        value += jump * -Math.expm1(-0.5 * (offset / sigma) * (offset / sigma));
      }
      return value;
    };
    for (let time = -0.5; time <= 7; time += 1 / 120) {
      expect(resolveSonnetCameraFocusHorizon(glyphs, time, sigma, 0)).toBeCloseTo(oldFormula(time), 9);
    }
  });

  it('② 句末空档：前沿停住时目标比例不动（轴心不倒退），且末字之后仍走到 0.67', () => {
    /*
     * 12 字：前 10 字 0.3s 一粒（2.7s 唱完），空 **1.5 秒** 再唱 11/12 字（4.2 / 4.5s）。
     * 空档正好落在句末渐变区（前沿世界进度 > 0.55）—— 旧 cue 进度口径会在这段把目标往 0.67 推。
     */
    const glyphs = Array.from({ length: 12 }, (_unused, index) => {
      const x = 100 + index * 130;
      const startTime = index < 10 ? index * 0.3 : 4.2 + (index - 10) * 0.3;
      return { x, y: 0, startTime, edgeX: x + 65 };
    });
    const block: SonnetCameraFocusBlock = {
      startTime: 0,
      endTime: 4.5,
      centerX: (100 + (100 + 11 * 130 + 65)) / 2,
      centerY: 0,
      minX: 100,
      minY: -65,
      maxX: 100 + 11 * 130 + 65,
      maxY: 65,
      glyphs,
    };
    const { aim, front } = sampleFocus([block], 10);
    const aimMotion = reversalsOf(aim, 1 / 120, 8);
    expect(aimMotion.reversals).toBe(0);
    expect(aimMotion.reverseDistance).toBeLessThan(1);

    /* 空档窗口（前沿已完全饱和、下一粒字还没开始：3.9s ~ 4.15s）里**目标屏幕比例逐值不动**。 */
    const dt = 1 / 120;
    let minTarget = Number.POSITIVE_INFINITY;
    let maxTarget = Number.NEGATIVE_INFINITY;
    for (let time = 3.9; time <= 4.15; time += dt) {
      const index = Math.round(time / dt);
      const target =
        ANCHOR_FACTS.basePositionX + ((front[index] ?? 0) - (aim[index] ?? 0)) * ANCHOR_FACTS.worldScale;
      minTarget = Math.min(minTarget, target);
      maxTarget = Math.max(maxTarget, target);
    }
    /* 旧 cue 进度口径在这段会推 240px（实测反向 249.5px）；新口径目标比例是常数。 */
    expect(maxTarget - minTarget).toBeLessThan(0.5);
    /* 末字唱完、前沿饱和之后，尾端仍落在 0.67（前沿就是尾端）。 */
    const tail = resolveSonnetCameraFocus([block], 9, ANCHOR_FACTS);
    expect(tail?.screenAnchored).toBe(true);
    const tailScreen =
      ANCHOR_FACTS.basePositionX + ANCHOR_FACTS.worldScale * ((tail?.frontRatio ?? 0) - (tail?.aimX ?? 0));
    expect(tailScreen).toBeCloseTo(0.67 * ANCHOR_FACTS.viewportWidth, 4);
    expect(front.at(-1)!).toBeGreaterThan(0);
  });

  it('③ 非横排语义 run 邻组吸引：给得出取景事实也不强加横排锚定，反向只发生在真正换组处', () => {
    /*
     * 2D 散布的 8 个语义 run（cue 顺序里 x 忽左忽右）：交叉轴散布 524 > max(0.2×827, 0.3×1120) = 336
     * ⇒ 闸门出局、`screenAnchored === false`（镜头在组间移动是"换组"，不是横向阅读通路的拉扯）。
     * 这里守两件事：① 不被强加横排锚定；② 累计变差不超过"组心的折线路径长度"（没有额外振荡）。
     */
    const positions: readonly (readonly [number, number])[] = [
      [-600, -280],
      [-380, -280],
      [50, -280],
      [-534, -150],
      [-345, 46],
      [28, -19],
      [520, -19],
      [-481, 244],
    ];
    const blocks: SonnetCameraFocusBlock[] = positions.map(([centerX, centerY], index) => ({
      startTime: index * 1.2,
      endTime: index * 1.2 + 0.6,
      centerX,
      centerY,
      minX: centerX - 60,
      minY: centerY - 40,
      maxX: centerX + 60,
      maxY: centerY + 40,
      glyphs: Array.from({ length: 3 }, (_unused, step) => ({
        x: centerX + (step - 1) * 40,
        y: centerY,
        startTime: index * 1.2 + step * 0.3,
        edgeX: centerX + (step - 0.5) * 40,
      })),
    }));
    const { aim, anchored } = sampleFocus(blocks, 11);
    expect(anchored.some((value) => value)).toBe(false);
    const aimMotion = reversalsOf(aim, 1 / 120, 8);
    expect(aimMotion.reversals).toBeLessThanOrEqual(blocks.length - 1);
    let variation = 0;
    for (let index = 1; index < aim.length; index += 1) {
      variation += Math.abs((aim[index] ?? 0) - (aim[index - 1] ?? 0));
    }
    let pathLength = 0;
    for (let index = 1; index < positions.length; index += 1) {
      pathLength += Math.abs((positions[index]?.[0] ?? 0) - (positions[index - 1]?.[0] ?? 0));
    }
    expect(variation).toBeLessThanOrEqual(pathLength * 1.2 + 200);
  });
});

