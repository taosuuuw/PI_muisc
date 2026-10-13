/**
 * 帧层「**阅读窗口 + 唱词节奏 + 连续预测焦点取景**」的集成用例。
 *
 * 这里守的是主人给的目标：
 * ① 长多行**不再为整镜 fit** 被缩成小字（对比旧的 `frameSonnetCameraToBody` 整镜约束）；
 * ② 当前词组**不被裁到只剩一两字**，更不允许"还在唱的整词持续在画外"；
 * ③ 同布局、不同 cue 密度**确实有快慢差异**（唱词时间轴节奏，不是音频 BPM）；
 * ④ 焦点**连续**（提前、不逐字摇摆、无 overshoot / 跳变）、seek 一致、幽灵字不进取景；
 * ⑤ 日文 / 英文 / 小视口都成立。
 *
 * ⚠ 本轮删掉了上一版"硬分页计划"的契约用例（提前量 / 死区 / 站序 / 迟到上限）：
 * 那套机制已被 `sonnetCameraFocus.ts` 的连续预测试点取代，契约随之作废。
 */

import { describe, expect, it } from 'vitest';
import { compileSonnetProgram } from './sonnetProgram';
import { buildSonnetFrame, type SonnetFrame } from './sonnetFrame';
import {
  SONNET_READING_FRAMING_MIN_ZOOM_RATIO,
  SONNET_READING_FRAMING_PLAN_PAN_RATIO,
  frameSonnetCameraToBody,
  frameSonnetCameraToReadingWindow,
  resolveSonnetBodyBounds,
  type SonnetFramingGlyph,
  type SonnetReadingFramingResult,
} from './sonnetCameraFraming';
import { SONNET_READING_MAX_SPAN_X, SONNET_READING_MAX_SPAN_Y } from './sonnetReadingWindow';
import type { StageLine, StageWord } from './types';

const VIEWPORT = { width: 1180, height: 760 } as const;

function makeLine(index: number, text: string, startMs: number, perCharMs = 400): StageLine {
  const chars = [...text];
  const words: StageWord[] = chars.map((char, position) => ({
    text: char,
    startMs: startMs + position * perCharMs,
    endMs: startMs + (position + 1) * perCharMs,
  }));
  return {
    index,
    timeMs: startMs,
    text,
    durationMs: chars.length * perCharMs,
    hint: 'normal',
    words,
    starts: words.map((word) => word.startMs),
    ends: words.map((word) => word.endMs),
  };
}

/** 一段长多行歌词：四行、每行十几个字、行间隔 1 秒 ⇒ 第一镜会把四行排在一起（"整镜"很大）。 */
const LONG_SONG = [
  makeLine(0, '窗外下着雨我把整夜都听成了潮声', 0, 120),
  makeLine(1, '狂跳的心脏不会说谎你说你也是', 1000, 120),
  makeLine(2, '雨停以后街灯还亮着像没说完的话', 2000, 120),
  makeLine(3, '我把整夜都听成了潮声', 3000, 120),
];
const LONG_PROGRAM = compileSonnetProgram(LONG_SONG, { seed: 'reading-window-integration' });

const frameInput = (
  program: ReturnType<typeof compileSonnetProgram>,
  timeSec: number,
  viewport: { readonly width: number; readonly height: number } = VIEWPORT,
) => ({
  program,
  timeSec,
  viewport,
  inkColor: '#ffffff',
  emphasisColor: '#ff0000',
});

/** 帧层字形 → 取景用的落位字形（ghost 排除，见 `SonnetTheme` 的同一口径）。 */
const framingGlyphs = (frame: SonnetFrame): SonnetFramingGlyph[] =>
  frame.glyphs
    .filter((glyph) => !glyph.ghost)
    .map((glyph) => ({
      x: glyph.x,
      y: glyph.y,
      fontPx: glyph.fontPx,
      rotation: glyph.rotation,
      layoutRotation: glyph.layoutRotation,
      scale: glyph.scale,
      text: glyph.text,
      weight: glyph.weight,
    }));

const readingFrameOf = (
  frame: SonnetFrame,
  viewport: { readonly width: number; readonly height: number } = VIEWPORT,
): SonnetReadingFramingResult =>
  frameSonnetCameraToReadingWindow(frame.camera, {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    pivotX: frame.pivot.x,
    pivotY: frame.pivot.y,
    basePositionX: frame.pivot.x + frame.anchorDelta.x,
    basePositionY: frame.pivot.y + frame.anchorDelta.y,
    windowBounds: {
      minX: frame.readingWindow.minX,
      minY: frame.readingWindow.minY,
      maxX: frame.readingWindow.maxX,
      maxY: frame.readingWindow.maxY,
    },
    /* 生产口径：平移只做**预测焦点舒适区**的温和兜底（见 `sonnetCameraFraming.ts`），缩放仍按阅读窗口。 */
    planBounds:
      frame.cameraFocus.blockCount === 0
        ? undefined
        : {
            minX: frame.cameraFocus.minX,
            minY: frame.cameraFocus.minY,
            maxX: frame.cameraFocus.maxX,
            maxY: frame.cameraFocus.maxY,
          },
    focusBounds: {
      minX: frame.readingWindow.activeMinX,
      minY: frame.readingWindow.activeMinY,
      maxX: frame.readingWindow.activeMaxX,
      maxY: frame.readingWindow.activeMaxY,
    },
  });

/** 活动块在视口里的**可见面积比例**（1 = 当前词完整可见，0 = 完全被裁掉）。 */
function focusVisibleRatio(
  result: SonnetReadingFramingResult,
  viewport: { readonly width: number; readonly height: number } = VIEWPORT,
): number {
  const box = result.focusScreen;
  if (box === null) return 0;
  const width = Math.max(1e-6, box.maxX - box.minX);
  const height = Math.max(1e-6, box.maxY - box.minY);
  const overlapX = Math.min(box.maxX, viewport.width) - Math.max(box.minX, 0);
  const overlapY = Math.min(box.maxY, viewport.height) - Math.max(box.minY, 0);
  return (Math.max(0, overlapX) * Math.max(0, overlapY)) / (width * height);
}

/** 当前词是不是**整词**都在画外（主人验收的红线）。 */
function focusFullyOffscreen(
  result: SonnetReadingFramingResult,
  viewport: { readonly width: number; readonly height: number } = VIEWPORT,
): boolean {
  const box = result.focusScreen;
  if (box === null) return true;
  return (
    box.minX >= viewport.width ||
    box.maxX <= 0 ||
    box.minY >= viewport.height ||
    box.maxY <= 0
  );
}

/**
 * 当前词的可读性读数。
 *
 * "当前词" = 阅读窗口的活动块（按**真实 cue 区间**离此刻最近的那一块，**不带**焦点的 lookahead）
 * —— 不是"每站首词"，也不是"窗口里任意一块"，所以整首歌的每一个词都要被量到。
 * 量的盒子是**落位几何**（`activeMin/Max`），不含逐字入场位移 ⇒ 入场滑入不会污染这个读数。
 * `worstActiveOffscreenRun` = 同一个活动块连续整块出画的最长时长（秒）。
 */
interface ReadabilityStats {
  readonly samples: number;
  readonly avgRatio: number;
  readonly overHalf: number;
  readonly minRatio: number;
  readonly minRatioTime: number;
  readonly offscreen: number;
  readonly worstActiveOffscreenRun: number;
  readonly maxWindowChars: number;
  /** 持续 ≥ 0.1 秒的"当前词整块出画"段（时间 / 镜 / 块 / 词盒尺寸），按长到短。 */
  readonly worstRuns: readonly string[];
}

function readabilityOf(
  program: ReturnType<typeof compileSonnetProgram>,
  viewport: { readonly width: number; readonly height: number },
  dt: number,
  from = 0,
  to = Infinity,
): ReadabilityStats {
  let samples = 0;
  let ratioSum = 0;
  let overHalf = 0;
  let minRatio = 1;
  let minRatioTime = -1;
  let offscreen = 0;
  let maxWindowChars = 0;
  let worstRun = 0;
  let runStart: number | null = null;
  let runEnd = 0;
  let runLabel = '';
  let lastActive = -1;
  const runDetails: { readonly seconds: number; readonly label: string }[] = [];
  const closeRun = (): void => {
    if (runStart !== null && runEnd - runStart + dt >= 0.1) {
      runDetails.push({ seconds: runEnd - runStart + dt, label: runLabel });
    }
    runStart = null;
  };
  for (let time = from; time <= to + 1e-6; time += dt) {
    const frame = buildSonnetFrame(frameInput(program, time, viewport));
    if (frame.glyphs.length === 0 || frame.readingWindow.blockCount === 0) {
      closeRun();
      continue;
    }
    const active = frame.readingWindow.activeIndex;
    if (active !== lastActive) {
      lastActive = active;
      closeRun();
    }
    const reading = readingFrameOf(frame, viewport);
    if (reading.focusScreen === null) continue;
    samples += 1;
    maxWindowChars = Math.max(maxWindowChars, frame.readingWindow.charCount);
    const ratio = focusVisibleRatio(reading, viewport);
    ratioSum += ratio;
    if (ratio >= 0.5) overHalf += 1;
    if (ratio < minRatio) {
      minRatio = ratio;
      minRatioTime = time;
    }
    if (focusFullyOffscreen(reading, viewport)) {
      offscreen += 1;
      const box = reading.focusScreen;
      if (runStart === null) {
        runStart = time;
        runLabel =
          `t=${time.toFixed(2)}s shot=${frame.shotId} kind=${frame.shotKind} act=${active} ` +
          `box=${Math.round(box.maxX - box.minX)}x${Math.round(box.maxY - box.minY)}`;
      }
      runEnd = time;
      worstRun = Math.max(worstRun, runEnd - runStart + dt);
    } else {
      closeRun();
    }
  }
  closeRun();
  return {
    samples,
    avgRatio: samples > 0 ? ratioSum / samples : 0,
    overHalf,
    minRatio,
    minRatioTime,
    offscreen,
    worstActiveOffscreenRun: worstRun,
    maxWindowChars,
    worstRuns: runDetails
      .sort((first, second) => second.seconds - first.seconds)
      .slice(0, 5)
      .map((detail) => `${detail.seconds.toFixed(2)}s ${detail.label}`),
  };
}

describe('商籁阅读窗口（帧层集成）：长多行不为整镜 fit 缩成小字', () => {
  const shot = LONG_PROGRAM.paragraphs[0]?.shots[0];

  it('整镜很长时：窗口字数有上限、取景缩放有下限，而旧"整镜 fit"明显更小', () => {
    if (shot === undefined) throw new Error('没有镜头');
    const totalChars = LONG_SONG.reduce((sum, line) => sum + [...line.text].length, 0);
    expect(totalChars).toBeGreaterThan(50);
    let samples = 0;
    let maxWindowChars = 0;
    let readingWorstZoom = 1;
    let legacyWorstZoom = 1;
    for (let time = shot.startTime; time <= shot.endTime; time += 0.1) {
      const frame = buildSonnetFrame(frameInput(LONG_PROGRAM, time));
      if (frame.glyphs.length === 0) continue;
      samples += 1;
      maxWindowChars = Math.max(maxWindowChars, frame.readingWindow.charCount);
      const reading = readingFrameOf(frame);
      readingWorstZoom = Math.min(readingWorstZoom, reading.zoomRatio);
      /* 旧的"整镜全部落位边界"约束（生产层已移除）作为对照。 */
      const legacyBounds = resolveSonnetBodyBounds(framingGlyphs(frame), () => Number.NaN);
      if (legacyBounds !== null) {
        const legacy = frameSonnetCameraToBody(frame.camera, {
          viewportWidth: VIEWPORT.width,
          viewportHeight: VIEWPORT.height,
          pivotX: frame.pivot.x,
          pivotY: frame.pivot.y,
          basePositionX: frame.pivot.x + frame.anchorDelta.x,
          basePositionY: frame.pivot.y + frame.anchorDelta.y,
          bodyBounds: legacyBounds,
        });
        legacyWorstZoom = Math.min(legacyWorstZoom, legacy.zoomRatio);
      }
    }
    expect(samples).toBeGreaterThan(10);
    /*
     * 窗口始终是"当前词 + 少量邻块"：密唱时最多四五块、约一二十字，
     * 而整镜是 57 字（旧口径会把全部 57 字一起塞进画面）。
     */
    expect(maxWindowChars).toBeLessThanOrEqual(20);
    expect(maxWindowChars).toBeLessThan(totalChars * 0.4);
    expect(maxWindowChars).toBeGreaterThanOrEqual(2);
    /* 阅读窗口取景的缩放下限：字不会被缩成小字 */
    expect(readingWorstZoom).toBeGreaterThanOrEqual(SONNET_READING_FRAMING_MIN_ZOOM_RATIO - 1e-9);
    /* 旧口径确实更狠 ⇒ 证明"不再整镜 fit"是有效的行为变化（不是同一条式子的改名） */
    expect(legacyWorstZoom).toBeLessThan(readingWorstZoom);
  });

  it('长多行：当前词始终读得到（可读性 + 不会持续整块出画）', () => {
    if (shot === undefined) throw new Error('没有镜头');
    const stats = readabilityOf(LONG_PROGRAM, VIEWPORT, 0.05, shot.startTime, shot.endTime);
    console.info(
      `[reading-frame][long] samples=${stats.samples} avg=${stats.avgRatio.toFixed(3)} ` +
        `overHalf=${(stats.overHalf / stats.samples).toFixed(3)} ` +
        `off=${(stats.offscreen / stats.samples).toFixed(3)} ` +
        `worstRun=${stats.worstActiveOffscreenRun.toFixed(2)}s ` +
        `min=${stats.minRatio.toFixed(3)}@${stats.minRatioTime.toFixed(2)} ` +
        `runs=[${stats.worstRuns.join(' | ')}]`,
    );
    expect(stats.samples).toBeGreaterThan(40);
    /* 平均可读性：当前词大部分时候是完整可见的。 */
    expect(stats.avgRatio).toBeGreaterThan(0.8);
    expect(stats.overHalf / stats.samples).toBeGreaterThan(0.85);
    /* 红线：当前词整块出画的帧要极少，且绝不长时间持续。 */
    expect(stats.offscreen / stats.samples).toBeLessThan(0.08);
    expect(stats.worstActiveOffscreenRun).toBeLessThan(0.3);
  });

  it('窗口宽度永远不超过视口比例上限（长句只取局部）', () => {
    if (shot === undefined) throw new Error('没有镜头');
    for (let time = shot.startTime; time <= shot.endTime; time += 0.2) {
      const frame = buildSonnetFrame(frameInput(LONG_PROGRAM, time));
      if (frame.readingWindow.blockCount === 0) continue;
      const window = frame.readingWindow;
      expect(window.maxX - window.minX).toBeLessThanOrEqual(
        SONNET_READING_MAX_SPAN_X * VIEWPORT.width + 1e-6,
      );
      expect(window.maxY - window.minY).toBeLessThanOrEqual(
        SONNET_READING_MAX_SPAN_Y * VIEWPORT.height + 1e-6,
      );
    }
  });
});

describe('商籁阅读窗口（帧层集成）：同布局、不同 cue 密度有快慢差异', () => {
  const denseLine = makeLine(0, '甲乙丙丁戊己庚辛壬癸子丑', 0, 150);
  const sparseLine = makeLine(0, '甲乙丙丁戊己庚辛壬癸子丑', 0, 900);
  const denseProgram = compileSonnetProgram([denseLine], { seed: 'density-dense' });
  const sparseProgram = compileSonnetProgram([sparseLine], { seed: 'density-sparse' });

  it('密唱：跟得更紧、平滑窗更小、呼吸收住；长音：更缓、呼吸更明显', () => {
    const denseShot = denseProgram.paragraphs[0]?.shots[0];
    const sparseShot = sparseProgram.paragraphs[0]?.shots[0];
    if (denseShot === undefined || sparseShot === undefined) throw new Error('没有镜头');
    const dense = buildSonnetFrame(
      frameInput(denseProgram, (denseShot.startTime + denseShot.endTime) / 2),
    );
    const sparse = buildSonnetFrame(
      frameInput(sparseProgram, (sparseShot.startTime + sparseShot.endTime) / 2),
    );
    expect(dense.rhythm.cueDensity).toBeGreaterThan(sparse.rhythm.cueDensity);
    expect(dense.rhythm.speed).toBeGreaterThan(sparse.rhythm.speed);
    expect(dense.rhythm.trackingFactor).toBeGreaterThan(sparse.rhythm.trackingFactor);
    expect(dense.rhythm.smoothingWindow).toBeLessThan(sparse.rhythm.smoothingWindow);
    expect(dense.rhythm.breathScale).toBeLessThan(sparse.rhythm.breathScale);
    /* 快唱 ⇒ 提前量更早、高斯更窄；慢唱反过来（连续预测试点的参数口径）。 */
    expect(dense.cameraFocus.leadSeconds).toBeGreaterThan(sparse.cameraFocus.leadSeconds);
    expect(dense.cameraFocus.sigmaSeconds).toBeGreaterThan(sparse.cameraFocus.sigmaSeconds);
    /* 同一份布局：两边的窗口范围都不受"整镜"影响 */
    expect(dense.readingWindow.charCount).toBeLessThanOrEqual(12);
    expect(sparse.readingWindow.charCount).toBeLessThanOrEqual(12);
  });

  it('节奏随时间连续：密唱那句里跟拍因子不会一步跳变', () => {
    const shot = denseProgram.paragraphs[0]?.shots[0];
    if (shot === undefined) throw new Error('没有镜头');
    let previous: number | null = null;
    let worst = 0;
    for (let time = shot.startTime; time <= shot.endTime; time += 1 / 120) {
      const frame = buildSonnetFrame(frameInput(denseProgram, time));
      if (previous !== null) worst = Math.max(worst, Math.abs(frame.rhythm.trackingFactor - previous));
      previous = frame.rhythm.trackingFactor;
    }
    expect(worst).toBeLessThan(0.02);
  });
});

describe('商籁阅读窗口（帧层集成）：seek 一致 / 幽灵字不进窗口', () => {
  const shot = LONG_PROGRAM.paragraphs[0]?.shots[0];

  it('同一时刻逐值一致（先跑别处再回来也一样）', () => {
    if (shot === undefined) throw new Error('没有镜头');
    const time = shot.startTime + 0.6;
    const first = buildSonnetFrame(frameInput(LONG_PROGRAM, time));
    buildSonnetFrame(frameInput(LONG_PROGRAM, time + 2));
    buildSonnetFrame(frameInput(LONG_PROGRAM, Math.max(shot.startTime, time - 0.4)));
    expect(buildSonnetFrame(frameInput(LONG_PROGRAM, time))).toEqual(first);
    expect(first.readingWindow.activeIndex).toBeGreaterThanOrEqual(0);
    expect(first.cameraFocus.blockCount).toBeGreaterThan(0);
  });

  it('巨型幽灵字（decoration）开关不影响阅读窗口、节奏与焦点', () => {
    if (shot === undefined) throw new Error('没有镜头');
    const time = shot.startTime + 0.7;
    const withGhosts = buildSonnetFrame({
      ...frameInput(LONG_PROGRAM, time),
      showGiantDecorativeText: true,
    });
    const without = buildSonnetFrame({
      ...frameInput(LONG_PROGRAM, time),
      showGiantDecorativeText: false,
    });
    expect(withGhosts.readingWindow).toEqual(without.readingWindow);
    expect(withGhosts.rhythm).toEqual(without.rhythm);
    expect(withGhosts.cameraFocus).toEqual(without.cameraFocus);
  });

  /*
   * **本轮新契约（用户录屏纠正）**：镜头不追字。
   * `animationScale` 是帧层**唯一**能改逐字入场位移 / α / 入场进度的输入（它同时缩放入场位移
   * 与轴心混合），所以把它从 1 拉到 1.4：字形动画变了，焦点读数必须**逐值不动**
   * —— 上一版这里会跟着入场曲线晃。
   */
  it('逐字入场动画档（animationScale）不影响焦点与瞄准点：镜头只看排版与 cue', () => {
    if (shot === undefined) throw new Error('没有镜头');
    /* 只比**不受动画档影响**的那几项：`min/max` 是舒适区，它按世界缩放（含动画档）折算。 */
    const focusCore = (
      focus: SonnetFrame['cameraFocus'],
    ): {
      readonly aimX: number;
      readonly aimY: number;
      readonly blockCount: number;
      readonly activeIndex: number;
      readonly leadSeconds: number;
      readonly sigmaSeconds: number;
      readonly speed: number;
    } => ({
      aimX: focus.aimX,
      aimY: focus.aimY,
      blockCount: focus.blockCount,
      activeIndex: focus.activeIndex,
      leadSeconds: focus.leadSeconds,
      sigmaSeconds: focus.sigmaSeconds,
      speed: focus.speed,
    });
    const samples = [shot.startTime + 0.2, shot.startTime + 0.7, shot.startTime + 1.2];
    for (const time of samples) {
      const full = buildSonnetFrame({ ...frameInput(LONG_PROGRAM, time), animationScale: 1 });
      const extra = buildSonnetFrame({ ...frameInput(LONG_PROGRAM, time), animationScale: 1.4 });
      /* 逐字入场动画档变了（位移 / α / 入场进度全变），焦点与瞄准点必须逐值不动。 */
      expect(focusCore(extra.cameraFocus)).toEqual(focusCore(full.cameraFocus));
      expect(extra.cameraPlan.aimX).toBe(full.cameraPlan.aimX);
      expect(extra.cameraPlan.aimY).toBe(full.cameraPlan.aimY);
      /*
       * 字形确实"动得不一样了"（同刻的逐字位移不同）⇒ 上面那两条不是"两帧本来就没动画"骗过的；
       * `pivot` 与运镜按各自的动画档走（轴心混合、运镜幅度本来就该吃这个档），不在本契约内。
       */
      const fullDelta = full.glyphs.find((glyph) => glyph.deltaX !== 0 || glyph.deltaY !== 0);
      const extraDelta = extra.glyphs.find((glyph) => glyph.deltaX !== 0 || glyph.deltaY !== 0);
      expect(fullDelta).toBeDefined();
      expect(extraDelta).toBeDefined();
      expect(
        Math.abs((extraDelta?.deltaY ?? 0) - (fullDelta?.deltaY ?? 0)),
      ).toBeGreaterThan(0);
    }
  });
});

describe('商籁阅读窗口（帧层集成）：日文 / 英文 / 小视口', () => {
  it('日文：窗口有限、当前块存在、取景缩放在下限之上', () => {
    const program = compileSonnetProgram([makeLine(0, '言葉にできない想いがまた', 0, 300)], {
      seed: 'jp-window',
    });
    const shot = program.paragraphs[0]?.shots[0];
    if (shot === undefined) throw new Error('没有镜头');
    for (let time = shot.startTime; time <= shot.endTime; time += 0.25) {
      const frame = buildSonnetFrame(frameInput(program, time));
      if (frame.glyphs.length === 0) continue;
      expect(frame.readingWindow.activeIndex).toBeGreaterThanOrEqual(0);
      expect(frame.readingWindow.charCount).toBeGreaterThanOrEqual(2);
      expect(frame.readingWindow.charCount).toBeLessThanOrEqual(12);
      const reading = readingFrameOf(frame);
      expect(reading.zoomRatio).toBeGreaterThanOrEqual(SONNET_READING_FRAMING_MIN_ZOOM_RATIO - 1e-9);
      expect(Number.isFinite(reading.camera.zoom)).toBe(true);
    }
  });

  it('英文（空格分词）：窗口按块限流，不会被整句拉远', () => {
    const program = compileSonnetProgram(
      [makeLine(0, 'you said you would be there tonight', 0, 220)],
      { seed: 'en-window' },
    );
    const shot = program.paragraphs[0]?.shots[0];
    if (shot === undefined) throw new Error('没有镜头');
    let maxChars = 0;
    for (let time = shot.startTime; time <= shot.endTime; time += 0.2) {
      const frame = buildSonnetFrame(frameInput(program, time));
      if (frame.readingWindow.blockCount === 0) continue;
      maxChars = Math.max(maxChars, frame.readingWindow.charCount);
      expect(frame.readingWindow.blockCount).toBeLessThanOrEqual(4);
    }
    expect(maxChars).toBeLessThanOrEqual(20);
  });

  it('小视口（320×200）：窗口仍受跨度上限约束、取景结果有限且不越下限', () => {
    const small = { width: 320, height: 200 } as const;
    const shot = LONG_PROGRAM.paragraphs[0]?.shots[0];
    if (shot === undefined) throw new Error('没有镜头');
    for (let time = shot.startTime; time <= shot.endTime; time += 0.3) {
      const frame = buildSonnetFrame(frameInput(LONG_PROGRAM, time, small));
      if (frame.readingWindow.blockCount === 0) continue;
      const window = frame.readingWindow;
      expect(window.maxX - window.minX).toBeLessThanOrEqual(SONNET_READING_MAX_SPAN_X * small.width + 1e-6);
      expect(window.maxY - window.minY).toBeLessThanOrEqual(SONNET_READING_MAX_SPAN_Y * small.height + 1e-6);
      const reading = readingFrameOf(frame, small);
      expect(Number.isFinite(reading.camera.x)).toBe(true);
      expect(Number.isFinite(reading.camera.y)).toBe(true);
      expect(reading.camera.zoom).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 主人点名的**真实 fixture**（Codex 回放同一份文本与 cue 权重）
 * ------------------------------------------------------------------ */

/**
 * 4 秒一行、每行 `durationMs = 3600`；每字 cue 权重：**前 35% = 1、中 15% = 5、其余 = 1.5**，
 * 权重归一到 3.6 秒 ⇒ 同一行里 cue 间隔有 **1:5** 变化（普通唱 / 长音 / 中速）。
 * 前四行就是主人给的四句（中文短句 / 中文长句 / 英文 / 日文），其余是长短不一的补充行。
 */
const REAL_READING_TEXTS = [
  '沿着夜色向前奔跑听见心跳越来越快忽然停下来等待下一束光',
  '长长的歌词应该随着歌声推进而不是一次缩成一张完整的小海报',
  'We keep moving through the night and let the words follow every change in the rhythm',
  '弱さを凌ぐもの一番になりたいありふれた言葉にこの世界を飛び越えて',
  '这一句很短',
  '快快向前走停下来听一听然后再出发',
  'Hold this note and then run through every word again',
  '揺れる心と夢のあいだ光を追いかけてゆく',
  '让镜头跟着这一段歌词重新慢下来',
  'The final phrase comes into view',
] as const;

function makePacedLine(index: number, text: string): StageLine {
  const chars = [...text];
  const timeMs = index * 4000;
  const durationMs = 3600;
  const spans = chars.map((_char, position) =>
    position < Math.floor(chars.length * 0.35)
      ? 1
      : position < Math.floor(chars.length * 0.5)
        ? 5
        : 1.5,
  );
  const spanTotal = spans.reduce((sum, span) => sum + span, 0);
  let cursor = timeMs;
  const words: StageWord[] = chars.map((char, position) => {
    const startMs = cursor;
    cursor += (durationMs * (spans[position] ?? 1)) / spanTotal;
    return { text: char, startMs, endMs: cursor };
  });
  return {
    index,
    text,
    timeMs,
    durationMs,
    hint: 'normal',
    words,
    starts: words.map((word) => word.startMs),
    ends: words.map((word) => word.endMs),
  };
}

/**
 * ⚠ **真实组件 seed**：生产层由帧层用 `lines.length | 首行文本 | 末行文本` 决定分镜 / 布局 / 取景随机源，
 * 换 seed 就换了整份排版 ⇒ 只有用同一个 seed 才算"同一份真实排版"。
 */
const REAL_COMPONENT_SEED = `${REAL_READING_TEXTS.length}|${REAL_READING_TEXTS[0]}|${REAL_READING_TEXTS.at(-1)}`;
const REAL_READING_PROGRAM = compileSonnetProgram(
  REAL_READING_TEXTS.map((text, index) => makePacedLine(index, text)),
  { seed: REAL_COMPONENT_SEED },
);
const REAL_VIEWPORT = { width: 1524, height: 827 } as const;
const REAL_SONG_SECONDS = REAL_READING_TEXTS.length * 4;

describe('真实 fixture（实际 frame 词 bounds 投影）：当前词的可读性', () => {
  it('10 行 · 0.05 秒采样：当前词几乎不整块出画，整体可见比例高', () => {
    const stats = readabilityOf(REAL_READING_PROGRAM, REAL_VIEWPORT, 0.05, 0, REAL_SONG_SECONDS);
    console.info(
      `[reading-frame][real] samples=${stats.samples} avgRatio=${stats.avgRatio.toFixed(3)} ` +
        `overHalf=${(stats.overHalf / stats.samples).toFixed(3)} ` +
        `off=${(stats.offscreen / stats.samples).toFixed(3)} ` +
        `worstActiveRun=${stats.worstActiveOffscreenRun.toFixed(2)}s ` +
        `min=${stats.minRatio.toFixed(3)}@${stats.minRatioTime.toFixed(2)}s ` +
        `runs=[${stats.worstRuns.join(' | ')}]`,
    );
    expect(stats.samples).toBeGreaterThan(600);
    expect(stats.avgRatio).toBeGreaterThan(0.85);
    expect(stats.overHalf / stats.samples).toBeGreaterThan(0.9);
    /*
     * 红线：当前词整块出画的帧必须极少，而且**绝不长时间持续** ——
     * "还在唱的整个词持续在画外"不能用来换平滑。
     */
    expect(stats.offscreen / stats.samples).toBeLessThan(0.02);
    expect(stats.worstActiveOffscreenRun).toBeLessThan(0.25);
  });

  it('细采样（1/120 秒）：换块 / 换镜 + 入场 0.35 秒之后，可见比例仍在同一量级', () => {
    const stats = readabilityOf(REAL_READING_PROGRAM, REAL_VIEWPORT, 1 / 120, 0, REAL_SONG_SECONDS);
    console.info(
      `[reading-frame][real-fine] samples=${stats.samples} avgRatio=${stats.avgRatio.toFixed(3)} ` +
        `overHalf=${(stats.overHalf / stats.samples).toFixed(3)} ` +
        `off=${(stats.offscreen / stats.samples).toFixed(3)} ` +
        `worstActiveRun=${stats.worstActiveOffscreenRun.toFixed(2)}s ` +
        `runs=[${stats.worstRuns.join(' | ')}]`,
    );
    expect(stats.samples).toBeGreaterThan(1500);
    expect(stats.avgRatio).toBeGreaterThan(0.85);
    expect(stats.offscreen / stats.samples).toBeLessThan(0.02);
    expect(stats.worstActiveOffscreenRun).toBeLessThan(0.25);
  });

  it('取景的兜底平移有上限：修正量永远 ≤ 0.10 视口（不再"无限硬纠偏"）', () => {
    let frames = 0;
    let maxAbsPan = 0;
    for (let time = 0; time <= REAL_SONG_SECONDS + 1e-6; time += 0.1) {
      const frame = buildSonnetFrame(frameInput(REAL_READING_PROGRAM, time, REAL_VIEWPORT));
      if (frame.glyphs.length === 0 || frame.cameraFocus.blockCount === 0) continue;
      const reading = readingFrameOf(frame, REAL_VIEWPORT);
      frames += 1;
      maxAbsPan = Math.max(maxAbsPan, Math.abs(reading.panX), Math.abs(reading.panY));
    }
    expect(frames).toBeGreaterThan(300);
    expect(maxAbsPan).toBeLessThanOrEqual(SONNET_READING_FRAMING_PLAN_PAN_RATIO + 1e-9);
  });
});

describe('真实 fixture：连续预测焦点本身（提前 / 不摇摆 / 连续 / seek）', () => {
  const shot = REAL_READING_PROGRAM.paragraphs[0]?.shots[0];

  /** 同一镜内的焦点采样（换镜会换排版与 cue 集合 ⇒ 连续只比镜内）。 */
  function sampleShot(dt: number): { readonly time: number; readonly x: number; readonly y: number; readonly shot: string }[] {
    if (shot === undefined) throw new Error('没有镜头');
    const samples: { time: number; x: number; y: number; shot: string }[] = [];
    for (let time = shot.startTime; time <= shot.endTime + 1e-6; time += dt) {
      const frame = buildSonnetFrame(frameInput(REAL_READING_PROGRAM, time, REAL_VIEWPORT));
      if (frame.cameraFocus.blockCount === 0) continue;
      samples.push({ time, x: frame.cameraFocus.aimX, y: frame.cameraFocus.aimY, shot: frame.shotId });
    }
    return samples;
  }

  it('焦点随时间连续：采样变密则步长变小，且没有一步搬完的大跳', () => {
    const coarse = sampleShot(1 / 60);
    const fine = sampleShot(1 / 240);
    const worstStep = (samples: { readonly x: number; readonly shot: string }[]): number => {
      let worst = 0;
      for (let index = 1; index < samples.length; index += 1) {
        const previous = samples[index - 1];
        const current = samples[index];
        if (previous === undefined || current === undefined || previous.shot !== current.shot) continue;
        worst = Math.max(worst, Math.abs(current.x - previous.x));
      }
      return worst;
    };
    const coarseWorst = worstStep(coarse);
    const fineWorst = worstStep(fine);
    console.info(
      `[reading-frame][focus-continuity] coarse=${coarseWorst.toFixed(1)}px/60Hz ` +
        `fine=${fineWorst.toFixed(1)}px/240Hz`,
    );
    expect(coarse.length).toBeGreaterThan(20);
    expect(fineWorst).toBeLessThan(coarseWorst);
    /* 60Hz 一步不能走掉半个画面宽（焦点是连续融合，不是按站搬）。 */
    expect(coarseWorst).toBeLessThan(REAL_VIEWPORT.width * 0.5);
  });

  it('同一活动块内焦点不来回甩：到该词中心的距离单调（没有逐字摇摆）', () => {
    if (shot === undefined) throw new Error('没有镜头');
    const dt = 1 / 120;
    let runs = 0;
    let samples = 0;
    let reversals = 0;
    let lastActive = -1;
    let previousDistance: number | null = null;
    let direction = 0;
    for (let time = shot.startTime; time <= shot.endTime + 1e-6; time += dt) {
      const frame = buildSonnetFrame(frameInput(REAL_READING_PROGRAM, time, REAL_VIEWPORT));
      if (frame.readingWindow.blockCount === 0) continue;
      const active = frame.readingWindow.activeIndex;
      if (active !== lastActive) {
        lastActive = active;
        previousDistance = null;
        direction = 0;
        runs += 1;
        continue;
      }
      const window = frame.readingWindow;
      const centerX = (window.activeMinX + window.activeMaxX) / 2;
      const centerY = (window.activeMinY + window.activeMaxY) / 2;
      const distance = Math.hypot(frame.pivot.x - centerX, frame.pivot.y - centerY);
      if (previousDistance !== null) {
        const delta = distance - previousDistance;
        if (Math.abs(delta) > 2) {
          const sign = delta > 0 ? 1 : -1;
          if (direction !== 0 && sign !== direction) reversals += 1;
          direction = sign;
        }
      }
      previousDistance = distance;
      samples += 1;
    }
    console.info(
      `[reading-frame][focus-wobble] runs=${runs} samples=${samples} reversals=${reversals} ` +
        `perRun=${(reversals / Math.max(1, runs)).toFixed(2)}`,
    );
    expect(runs).toBeGreaterThan(5);
    expect(samples).toBeGreaterThan(200);
    /* 平均每个活动块不到一次折返：焦点是"往这个词靠"，不是按字来回抖。 */
    expect(reversals / runs).toBeLessThan(1);
  });
});

/* ------------------------------------------------------------------ *
 * 主人点名的**集成回归**：真实组件 seed + 生产 frame + 生产 framing，
 * 用**最终世界变换**（pivot / camera.x,y / zoom / rotation）投影固定世界点，
 * 检查当前词可读性与位移速度（排除换镜）。
 * ------------------------------------------------------------------ */

interface WorldMotionMetrics {
  /** 预测焦点（pivot）引起的屏幕位移峰值（px/s，= |Δpivot| × 最终 zoom）。 */
  readonly focusPanPeak: number;
  /** 取景平移（camera.x/y）引起的屏幕位移峰值（px/s）。 */
  readonly framingPanPeak: number;
  /** 固定世界点的**总**屏幕位移峰值（含阅读窗口变焦；px/s）。 */
  readonly fixedPointPeak: number;
  /** 取景缩放下限（越小越接近"整镜 fit"）。 */
  readonly minZoomRatio: number;
}

const SCALE = 1;
function worldMotion(viewport: { readonly width: number; readonly height: number }): WorldMotionMetrics {
  let focusPanPeak = 0;
  let framingPanPeak = 0;
  let fixedPointPeak = 0;
  let minZoomRatio = 1;
  let previous: {
    readonly shot: string;
    readonly point: { readonly x: number; readonly y: number };
    readonly pivot: { readonly x: number; readonly y: number };
    readonly cam: { readonly x: number; readonly y: number; readonly zoom: number };
  } | null = null;
  const dt = 1 / 60;
  for (let time = 0; time <= REAL_SONG_SECONDS + 1e-6; time += dt) {
    const frame = buildSonnetFrame(frameInput(REAL_READING_PROGRAM, time, viewport));
    if (frame.glyphs.length === 0) continue;
    const reading = readingFrameOf(frame, viewport);
    const cam = reading.camera;
    minZoomRatio = Math.min(minZoomRatio, reading.zoomRatio);
    const cosine = cam.zoom * Math.cos(cam.rotation);
    const sine = cam.zoom * Math.sin(cam.rotation);
    /* 固定世界点：取画布中心；屏幕位置 = basePosition + camera×视口 + R(rotation)·(zoom·(局部 − pivot))。 */
    const localX = viewport.width / 2;
    const localY = viewport.height / 2;
    const dx = localX - frame.pivot.x;
    const dy = localY - frame.pivot.y;
    const point = {
      x:
        frame.pivot.x +
        frame.anchorDelta.x +
        cam.x * viewport.width * SCALE +
        cosine * dx -
        sine * dy,
      y:
        frame.pivot.y +
        frame.anchorDelta.y +
        cam.y * viewport.height * SCALE +
        sine * dx +
        cosine * dy,
    };
    if (previous !== null && previous.shot === frame.shotId) {
      focusPanPeak = Math.max(
        focusPanPeak,
        Math.hypot(frame.pivot.x - previous.pivot.x, frame.pivot.y - previous.pivot.y) * cam.zoom * 60,
      );
      framingPanPeak = Math.max(
        framingPanPeak,
        Math.hypot(
          (cam.x - previous.cam.x) * viewport.width,
          (cam.y - previous.cam.y) * viewport.height,
        ) * 60,
      );
      fixedPointPeak = Math.max(
        fixedPointPeak,
        Math.hypot(point.x - previous.point.x, point.y - previous.point.y) * 60,
      );
    }
    previous = {
      shot: frame.shotId,
      point,
      pivot: { x: frame.pivot.x, y: frame.pivot.y },
      cam: { x: cam.x, y: cam.y, zoom: cam.zoom },
    };
  }
  return { focusPanPeak, framingPanPeak, fixedPointPeak, minZoomRatio };
}

describe('真实组件 seed：最终世界变换（当前词可读性 / 位移速度）', () => {
  const SMALL_VIEWPORT = { width: 900, height: 520 } as const;
  const big = worldMotion(REAL_VIEWPORT);
  const small = worldMotion(SMALL_VIEWPORT);
  const bigRead = readabilityOf(REAL_READING_PROGRAM, REAL_VIEWPORT, 0.05, 0, REAL_SONG_SECONDS);
  const smallRead = readabilityOf(REAL_READING_PROGRAM, SMALL_VIEWPORT, 0.05, 0, REAL_SONG_SECONDS);

  const report = (label: string, metrics: WorldMotionMetrics, read: ReadabilityStats): void => {
    console.info(
      `[reading-frame][world ${label}] focusPanPeak=${metrics.focusPanPeak.toFixed(0)}px/s ` +
        `framingPanPeak=${metrics.framingPanPeak.toFixed(0)}px/s ` +
        `fixedPointPeak=${metrics.fixedPointPeak.toFixed(0)}px/s ` +
        `minZoom=${metrics.minZoomRatio.toFixed(3)} ` +
        `offRatio=${(read.offscreen / read.samples).toFixed(4)} ` +
        `worstRun=${read.worstActiveOffscreenRun.toFixed(2)}s ` +
        `runs=[${read.worstRuns.join(' | ')}]`,
    );
  };

  it('1524×827：当前词读得到（不会为了平滑让唱着的整词持续出画），且长句不被缩成整镜', () => {
    report('big', big, bigRead);
    expect(bigRead.samples).toBeGreaterThan(600);
    expect(bigRead.offscreen / bigRead.samples).toBeLessThan(0.02);
    expect(bigRead.worstActiveOffscreenRun).toBeLessThan(0.25);
    /* 长句不缩整镜：缩放比例永远不低于 0.78。 */
    expect(big.minZoomRatio).toBeGreaterThanOrEqual(SONNET_READING_FRAMING_MIN_ZOOM_RATIO - 1e-9);
  });

  it('1524×827：焦点摇移 / 取景平移 / 最终世界点都没有大位移尖峰', () => {
    /* 三条速度上限：焦点摇移 / 取景平移 / 固定世界点的总屏幕位移，都按视口宽成比例卡。 */
    expect(big.focusPanPeak).toBeLessThanOrEqual(REAL_VIEWPORT.width * 2.2);
    expect(big.framingPanPeak).toBeLessThanOrEqual(REAL_VIEWPORT.width * 0.25);
    expect(big.fixedPointPeak).toBeLessThanOrEqual(REAL_VIEWPORT.width * 2.2);
    /* 排除换镜后仍然有运动（不是"整首歌不动"骗过尖峰检查）。 */
    expect(big.focusPanPeak).toBeGreaterThan(200);
  });

  it('小窗口（900×520）：同一条契约仍然成立（速度按视口缩放）', () => {
    report('small', small, smallRead);
    expect(smallRead.samples).toBeGreaterThan(600);
    expect(smallRead.offscreen / smallRead.samples).toBeLessThan(0.02);
    expect(smallRead.worstActiveOffscreenRun).toBeLessThan(0.25);
    expect(small.minZoomRatio).toBeGreaterThanOrEqual(SONNET_READING_FRAMING_MIN_ZOOM_RATIO - 1e-9);
    expect(small.focusPanPeak).toBeLessThanOrEqual(900 * 2.2);
    expect(small.framingPanPeak).toBeLessThanOrEqual(900 * 0.25);
    expect(small.fixedPointPeak).toBeLessThanOrEqual(900 * 2.2);
  });
});

/* ------------------------------------------------------------------ *
 * 主人点名的**长横排 fixture**：三行、行间隔 10s、每行 9s 逐字均分；
 * 用**生产取景器**投影每一粒字的**最终落位右缘**，验收两条屏幕比例：
 *   ① 展开中"最近已经开始唱的那一粒字的右缘" ≥ 0.45 视口宽；
 *   ② 末字起唱之后（这一行的尾端已经确定）尾端落在 0.62 ~ 0.72 视口宽。
 * 这段文本的行宽（实测 2349px @1524 视口）**远大于视口** ⇒ 覆盖"长句超出视口"这一档，
 * 并且取景缩放有下限（不把整句缩小 fit，旧字从左侧出血）。
 * ------------------------------------------------------------------ */

/** 三行真实 fixture 文本（与 Codex 只读探针、主人截图同一份）。 */
const HORIZONTAL_TEXTS = [
  '第六感あやかって疾走する狂跳のハートは嘘つけないよ',
  '夜色の中で夢を追いかける',
  '今ここから始めよう4',
] as const;
const HORIZONTAL_LINE_STEP_MS = 10000;
const HORIZONTAL_LINE_DURATION_MS = 9000;
const HORIZONTAL_SEED = `${HORIZONTAL_TEXTS.length}|${HORIZONTAL_TEXTS[0]}|${HORIZONTAL_TEXTS.at(-1)}`;

/** 逐字**均分**的固定 fixture（每行 9s 均分给它的字数）。 */
function makeHorizontalLine(index: number, text: string): StageLine {
  return makeLine(index, text, index * HORIZONTAL_LINE_STEP_MS, HORIZONTAL_LINE_DURATION_MS / [...text].length);
}

/**
 * **变速 cue** 版：同一份文本 / 同一份 seed（⇒ 同一份排版），只把逐字间隔改成 1 : 5 : 1.5 三段
 * （前 35% = 1、中 15% = 5、其余 = 1.5），总时长仍是 9 秒 —— 覆盖"连续时间轴按 cue 速度变化"。
 */
function makeHorizontalPacedLine(index: number, text: string): StageLine {
  const chars = [...text];
  const timeMs = index * HORIZONTAL_LINE_STEP_MS;
  const spans = chars.map((_char, position) =>
    position < Math.floor(chars.length * 0.35) ? 1 : position < Math.floor(chars.length * 0.5) ? 5 : 1.5,
  );
  const total = spans.reduce((sum, span) => sum + span, 0);
  let cursor = timeMs;
  const words: StageWord[] = chars.map((char, position) => {
    const startMs = cursor;
    cursor += (HORIZONTAL_LINE_DURATION_MS * (spans[position] ?? 1)) / total;
    return { text: char, startMs, endMs: cursor };
  });
  return {
    index,
    text,
    timeMs,
    durationMs: HORIZONTAL_LINE_DURATION_MS,
    hint: 'normal',
    words,
    starts: words.map((word) => word.startMs),
    ends: words.map((word) => word.endMs),
  };
}

const HORIZONTAL_PROGRAM = compileSonnetProgram(
  HORIZONTAL_TEXTS.map((text, index) => makeHorizontalLine(index, text)),
  { seed: HORIZONTAL_SEED },
);
const HORIZONTAL_PACED_PROGRAM = compileSonnetProgram(
  HORIZONTAL_TEXTS.map((text, index) => makeHorizontalPacedLine(index, text)),
  { seed: HORIZONTAL_SEED },
);

interface HorizontalProjection {
  readonly shotId: string;
  readonly shotKind: string;
  /** 最近"已经开始唱"的那一粒字的**最终落位右缘**投到屏幕后的 x / 视口宽（没有字时为 null）。 */
  readonly frontRatio: number | null;
  /** 这一行最后一粒字的落位右缘投到屏幕后的 x / 视口宽。 */
  readonly tailRatio: number | null;
  /** 这一镜的字**全部开始唱**了没有（尾端位置这时才算"确定"）。 */
  readonly allStarted: boolean;
  /** 逐字落位的横向跨度（画布像素）——用来确认这确实是"长句超出视口"那一档。 */
  readonly layoutSpanX: number;
  readonly zoomRatio: number;
  readonly framed: SonnetReadingFramingResult;
}

/**
 * **生产投影**：屏幕 = `取景锚点 + framedCamera.x/y × 视口 + R(rotation) · (zoom · (局部 − pivot))`
 * （与 `SonnetTheme.tsx` 施加到 `world` 上的那条式子逐项一致）。
 * 只投**最终落位**（`glyph.x/y` 与 `glyph.edgeX`），**不含**逐字入场位移 / 缩放
 * —— 前沿是"排到哪儿了"，不是"这一帧那粒字飞到哪儿了"。
 */
function projectHorizontalFrame(
  frame: SonnetFrame,
  viewport: { readonly width: number; readonly height: number },
  timeSec: number,
): HorizontalProjection {
  const framed = readingFrameOf(frame, viewport);
  const cam = framed.camera;
  const originX = frame.pivot.x + frame.anchorDelta.x + cam.x * viewport.width;
  const cosine = Math.cos(cam.rotation);
  const sine = Math.sin(cam.rotation);
  const projectX = (x: number, y: number): number =>
    originX + (cosine * (x - frame.pivot.x) - sine * (y - frame.pivot.y)) * cam.zoom;
  const body = frame.glyphs.filter((glyph) => !glyph.ghost);
  if (body.length === 0) {
    return {
      shotId: frame.shotId,
      shotKind: frame.shotKind,
      frontRatio: null,
      tailRatio: null,
      allStarted: false,
      layoutSpanX: 0,
      zoomRatio: framed.zoomRatio,
      framed,
    };
  }
  let latest = Number.NEGATIVE_INFINITY;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const glyph of body) {
    if (Number.isFinite(glyph.startTime)) latest = Math.max(latest, glyph.startTime);
    minX = Math.min(minX, glyph.x);
    maxX = Math.max(maxX, glyph.x);
  }
  /* "最近已经开始唱的那一粒"：按时间轴过一遍（不假设 `glyphs` 数组已按 cue 排序）。 */
  let frontGlyph = body[0];
  for (const glyph of body) {
    const start = glyph.startTime;
    if (!Number.isFinite(start) || start > timeSec + 1e-9) continue;
    const current = frontGlyph?.startTime ?? Number.NEGATIVE_INFINITY;
    if (frontGlyph === undefined || !Number.isFinite(current) || start >= current) frontGlyph = glyph;
  }
  const tailGlyph = body.at(-1);
  const edgeOf = (glyph: SonnetFrame['glyphs'][number]): number =>
    Number.isFinite(glyph.edgeX) ? glyph.edgeX : glyph.x;
  return {
    shotId: frame.shotId,
    shotKind: frame.shotKind,
    frontRatio:
      frontGlyph === undefined ? null : projectX(edgeOf(frontGlyph), frontGlyph.y) / viewport.width,
    tailRatio: tailGlyph === undefined ? null : projectX(edgeOf(tailGlyph), tailGlyph.y) / viewport.width,
    allStarted: latest <= timeSec + 1e-9,
    layoutSpanX: maxX - minX,
    zoomRatio: framed.zoomRatio,
    framed,
  };
}

function horizontalFrameAt(
  program: ReturnType<typeof compileSonnetProgram>,
  timeSec: number,
  viewport: { readonly width: number; readonly height: number },
  lyricsFontScale?: number,
  animationScale?: number,
): HorizontalProjection {
  const frame = buildSonnetFrame({
    ...frameInput(program, timeSec, viewport),
    lyricsFontScale,
    animationScale,
  });
  return projectHorizontalFrame(frame, viewport, timeSec);
}

/**
 * 这一行的**展开验收**：按给定采样逐点算出前沿 / 尾端。
 * `warmupSeconds` 之后才把前沿计入"最低值"（开场首字的淡入允许短暂例外）。
 */
function sweepHorizontal(
  program: ReturnType<typeof compileSonnetProgram>,
  viewport: { readonly width: number; readonly height: number },
  options: { readonly dt: number; readonly to: number; readonly lyricsFontScale?: number; readonly warmupSeconds?: number },
): {
  readonly warmMinFront: number;
  readonly warmMinFrontTime: number;
  readonly minFront: number;
  readonly maxFront: number;
  readonly tailAfterAllStarted: number;
  readonly tailAtLastSample: number;
  readonly layoutSpanX: number;
  readonly minZoomRatio: number;
  readonly samples: number;
} {
  const warmup = options.warmupSeconds ?? 0.5;
  let minFront = Number.POSITIVE_INFINITY;
  let maxFront = Number.NEGATIVE_INFINITY;
  let warmMinFront = Number.POSITIVE_INFINITY;
  let warmMinFrontTime = -1;
  let tailAfterAllStarted = Number.NaN;
  let tailAtLastSample = Number.NaN;
  let layoutSpanX = 0;
  let minZoomRatio = 1;
  let samples = 0;
  for (let time = 0; time <= options.to + 1e-9; time += options.dt) {
    const projection = horizontalFrameAt(program, time, viewport, options.lyricsFontScale);
    if (projection.frontRatio === null || projection.shotId !== 'p0-shot-0') continue;
    samples += 1;
    layoutSpanX = Math.max(layoutSpanX, projection.layoutSpanX);
    minZoomRatio = Math.min(minZoomRatio, projection.zoomRatio);
    minFront = Math.min(minFront, projection.frontRatio);
    maxFront = Math.max(maxFront, projection.frontRatio);
    if (time >= warmup && projection.frontRatio < warmMinFront) {
      warmMinFront = projection.frontRatio;
      warmMinFrontTime = time;
    }
    tailAtLastSample = projection.tailRatio ?? tailAtLastSample;
    if (projection.allStarted) tailAfterAllStarted = projection.tailRatio ?? tailAfterAllStarted;
  }
  return {
    warmMinFront,
    warmMinFrontTime,
    minFront,
    maxFront,
    tailAfterAllStarted,
    tailAtLastSample,
    layoutSpanX,
    minZoomRatio,
    samples,
  };
}

describe('长横排 fixture（生产取景器投影）：前沿 ≥ 0.45W、句末尾端 0.62~0.72W', () => {
  const VIEW = { width: 1524, height: 827 } as const;
  const SMALL_VIEW = { width: 1024, height: 768 } as const;
  /*
   * 验收用的容差：屏幕锚定是**构造保证**"实测前沿 ≥ 目标比例"的（因果核只让前沿滞后），
   * 取景器还有一档 ≤ 22% 的拉远（`zoomRatio`）会带来几个像素的残差 —— 实测最坏 0.450。
   * 这里按"目标 − 0.005"卡：既守住用户的 0.45 红线，又不把取景器的正常残差当成错误。
   */
  const FRONT_FLOOR = 0.45 - 0.005;

  /**
   * **生产口径的固定世界点**屏幕位置（与上面 `worldMotion` 同式）：
   * `pivot + anchorDelta + camera × 视口 + R(rotation) · zoom · (世界点 − pivot)`。
   */
  const fixedWorldPoint = (frame: SonnetFrame, viewport: { readonly width: number; readonly height: number }): { x: number; y: number } => {
    const cam = readingFrameOf(frame, viewport).camera;
    const dx = viewport.width / 2 - frame.pivot.x;
    const dy = viewport.height / 2 - frame.pivot.y;
    const cosine = cam.zoom * Math.cos(cam.rotation);
    const sine = cam.zoom * Math.sin(cam.rotation);
    return {
      x: frame.pivot.x + frame.anchorDelta.x + cam.x * viewport.width + cosine * dx - sine * dy,
      y: frame.pivot.y + frame.anchorDelta.y + cam.y * viewport.height + sine * dx + cosine * dy,
    };
  };

  /** 本镜（`p0-shot-0`）固定世界点的**总**屏幕速度峰值（px/s，排除换镜）。 */
  const fixedPointPeak = (dt: number): number => {
    let peak = 0;
    let previous: { readonly x: number; readonly y: number } | null = null;
    for (let time = 0; time <= 9.6 + 1e-9; time += dt) {
      const frame = buildSonnetFrame(frameInput(HORIZONTAL_PROGRAM, time, VIEW));
      if (frame.shotId !== 'p0-shot-0') {
        previous = null;
        continue;
      }
      const point = fixedWorldPoint(frame, VIEW);
      if (previous !== null) {
        peak = Math.max(peak, Math.hypot(point.x - previous.x, point.y - previous.y) / dt);
      }
      previous = point;
    }
    return peak;
  };

  /**
   * **相邻 cue 两侧的一阶速度差**：对每粒字的开始唱时刻做左右有限差分再相减。
   * 旧核（`erf`）在这里是 320~860px/s 的实打实台阶；Rayleigh 核应当只剩 ~14px/s 的
   * 加速度折角余项（且随 `dt` 变小不增大）。
   */
  const cueVelocityJumps = (dt: number): { worst: number; rows: readonly number[] } => {
    const rows: number[] = [];
    const perGlyphSeconds = HORIZONTAL_LINE_DURATION_MS / [...HORIZONTAL_TEXTS[0]].length / 1000;
    for (let position = 4; position <= 23; position += 1) {
      const cue = position * perGlyphSeconds;
      const before = fixedWorldPoint(buildSonnetFrame(frameInput(HORIZONTAL_PROGRAM, cue - dt, VIEW)), VIEW);
      const at = fixedWorldPoint(buildSonnetFrame(frameInput(HORIZONTAL_PROGRAM, cue, VIEW)), VIEW);
      const after = fixedWorldPoint(buildSonnetFrame(frameInput(HORIZONTAL_PROGRAM, cue + dt, VIEW)), VIEW);
      const left = Math.hypot(at.x - before.x, at.y - before.y) / dt;
      const right = Math.hypot(after.x - at.x, after.y - at.y) / dt;
      rows.push(Math.abs(right - left));
    }
    return { worst: Math.max(...rows), rows };
  };

  it('1524×827 · 主人点名的时刻：前沿全程 ≥ 0.45，末字起唱后尾端落在 0.62~0.72', () => {
    for (const time of [1, 2, 3, 4, 5, 6, 7, 8, 9, 9.3]) {
      const projection = horizontalFrameAt(HORIZONTAL_PROGRAM, time, VIEW);
      expect(projection.shotId).toBe('p0-shot-0');
      expect(projection.shotKind).toBe('tracking-ribbon');
      const front = projection.frontRatio;
      expect(front).not.toBeNull();
      /* ① 展开中（含末字刚起唱那一刻）前沿都在 0.45 以上。 */
      expect(front ?? 0).toBeGreaterThanOrEqual(FRONT_FLOOR);
      /* ② 末字起唱之后，尾端（= 前沿）落在 0.62~0.72，且绝不冲到 0.8 以外。 */
      if (projection.allStarted) {
        expect(projection.tailRatio ?? 0).toBeGreaterThanOrEqual(0.62);
        expect(projection.tailRatio ?? 1).toBeLessThanOrEqual(0.72);
      }
      expect(front ?? 1).toBeLessThanOrEqual(0.8);
    }
  });

  it('1524×827 · 1/60 秒细扫：热身后前沿最低值仍 ≥ 0.45（不是只有几个采样点侥幸）', () => {
    const stats = sweepHorizontal(HORIZONTAL_PROGRAM, VIEW, { dt: 1 / 60, to: 9.6 });
    console.info(
      `[horizontal][1524] samples=${stats.samples} warmMin=${stats.warmMinFront.toFixed(3)}` +
        `@${stats.warmMinFrontTime.toFixed(2)} min=${stats.minFront.toFixed(3)} ` +
        `max=${stats.maxFront.toFixed(3)} tail=${stats.tailAfterAllStarted.toFixed(3)} ` +
        `span=${Math.round(stats.layoutSpanX)} minZoom=${stats.minZoomRatio.toFixed(3)}`,
    );
    expect(stats.samples).toBeGreaterThan(500);
    /* 长句确实**超出视口**：这一行的逐字落位跨度远大于 1524。 */
    expect(stats.layoutSpanX).toBeGreaterThan(VIEW.width * 1.3);
    expect(stats.warmMinFront).toBeGreaterThanOrEqual(FRONT_FLOOR);
    expect(stats.maxFront).toBeLessThanOrEqual(0.8);
    /* 长句不缩小 fit：取景缩放比例始终 ≥ 0.78。 */
    expect(stats.minZoomRatio).toBeGreaterThanOrEqual(SONNET_READING_FRAMING_MIN_ZOOM_RATIO - 1e-9);
    /* 尾端落在主人量到的 0.67 附近。 */
    expect(stats.tailAfterAllStarted).toBeGreaterThanOrEqual(0.62);
    expect(stats.tailAfterAllStarted).toBeLessThanOrEqual(0.72);
  });

  it('1024×768 · 同一份验收成立（近视口也有效）', () => {
    for (const time of [1, 2, 3, 4, 5, 6, 7, 8, 9, 9.3]) {
      const projection = horizontalFrameAt(HORIZONTAL_PROGRAM, time, SMALL_VIEW);
      expect(projection.shotId).toBe('p0-shot-0');
      expect(projection.frontRatio ?? 0).toBeGreaterThanOrEqual(FRONT_FLOOR);
      if (projection.allStarted) {
        expect(projection.tailRatio ?? 0).toBeGreaterThanOrEqual(0.62);
        expect(projection.tailRatio ?? 1).toBeLessThanOrEqual(0.72);
      }
    }
    const stats = sweepHorizontal(HORIZONTAL_PROGRAM, SMALL_VIEW, { dt: 1 / 60, to: 9.6 });
    console.info(
      `[horizontal][1024] samples=${stats.samples} warmMin=${stats.warmMinFront.toFixed(3)}` +
        `@${stats.warmMinFrontTime.toFixed(2)} max=${stats.maxFront.toFixed(3)} ` +
        `tail=${stats.tailAfterAllStarted.toFixed(3)} span=${Math.round(stats.layoutSpanX)}`,
    );
    expect(stats.layoutSpanX).toBeGreaterThan(SMALL_VIEW.width * 1.3);
    expect(stats.warmMinFront).toBeGreaterThanOrEqual(FRONT_FLOOR);
    expect(stats.tailAfterAllStarted).toBeGreaterThanOrEqual(0.62);
    expect(stats.tailAfterAllStarted).toBeLessThanOrEqual(0.72);
  });

  it('变速 cue（逐字间隔 1:5:1.5，同一份排版）：前沿与尾端仍然成立', () => {
    const stats = sweepHorizontal(HORIZONTAL_PACED_PROGRAM, VIEW, { dt: 1 / 60, to: 9.6 });
    console.info(
      `[horizontal][paced] samples=${stats.samples} warmMin=${stats.warmMinFront.toFixed(3)}` +
        `@${stats.warmMinFrontTime.toFixed(2)} max=${stats.maxFront.toFixed(3)} ` +
        `tail=${stats.tailAfterAllStarted.toFixed(3)}`,
    );
    expect(stats.samples).toBeGreaterThan(500);
    expect(stats.warmMinFront).toBeGreaterThanOrEqual(FRONT_FLOOR);
    expect(stats.maxFront).toBeLessThanOrEqual(0.8);
    expect(stats.tailAfterAllStarted).toBeGreaterThanOrEqual(0.62);
    expect(stats.tailAfterAllStarted).toBeLessThanOrEqual(0.72);
  });

  it('字号 1.4 倍：前沿与尾端仍然成立（不靠"只有某个字号才对"）', () => {
    const stats = sweepHorizontal(HORIZONTAL_PROGRAM, VIEW, {
      dt: 1 / 60,
      to: 9.6,
      lyricsFontScale: 1.4,
    });
    console.info(
      `[horizontal][font1.4] samples=${stats.samples} warmMin=${stats.warmMinFront.toFixed(3)}` +
        `@${stats.warmMinFrontTime.toFixed(2)} max=${stats.maxFront.toFixed(3)} ` +
        `tail=${stats.tailAfterAllStarted.toFixed(3)}`,
    );
    expect(stats.warmMinFront).toBeGreaterThanOrEqual(FRONT_FLOOR);
    expect(stats.maxFront).toBeLessThanOrEqual(0.8);
    expect(stats.tailAfterAllStarted).toBeGreaterThanOrEqual(0.62);
    expect(stats.tailAfterAllStarted).toBeLessThanOrEqual(0.72);
  });

  it('镜头只吃排版与 cue：入场动画档（animationScale 1 / 1.4）不改显现前沿轨迹本身', () => {
    /*
     * `animationScale` 是帧层唯一能改逐字入场位移 / α / 入场进度的输入，但它**同时**是运镜强度档
     * （原版口径：缩放运镜幅度、轴心混合与世界缩放）—— 所以"轴心的屏幕解算"必须跟着世界缩放变，
     * 那是相机事实、不是追字。这里守的是**上游那一层**：
     * · `frontRatio`（显现前沿的画布位置）、`activeIndex`、`blockCount`、`lead/sigma/speed`
     *   必须**逐值相同** —— 它们只由落点 + cue + 绝对时间决定，与入场动画、与相机缩放都无关；
     * · 而且两种档位下**投影出来的屏幕构图都成立**（前沿 / 尾端仍在验收带里）
     *   ⇒ 动画档变化不会把长横排构图弄坏。
     */
    for (const time of [1, 3.5, 6, 8.5, 9.2]) {
      const full = buildSonnetFrame({ ...frameInput(HORIZONTAL_PROGRAM, time, VIEW), animationScale: 1 });
      const extra = buildSonnetFrame({ ...frameInput(HORIZONTAL_PROGRAM, time, VIEW), animationScale: 1.4 });
      expect(extra.cameraFocus.frontRatio).toBe(full.cameraFocus.frontRatio);
      expect(extra.cameraFocus.activeIndex).toBe(full.cameraFocus.activeIndex);
      expect(extra.cameraFocus.blockCount).toBe(full.cameraFocus.blockCount);
      expect(extra.cameraFocus.leadSeconds).toBe(full.cameraFocus.leadSeconds);
      expect(extra.cameraFocus.sigmaSeconds).toBe(full.cameraFocus.sigmaSeconds);
      expect(extra.cameraFocus.speed).toBe(full.cameraFocus.speed);
      /* 字形确实动得不一样（不是"两帧本来就没动画"骗过的）。 */
      const fullDelta = full.glyphs.find((glyph) => glyph.deltaX !== 0 || glyph.deltaY !== 0);
      const extraDelta = extra.glyphs.find((glyph) => glyph.deltaX !== 0 || glyph.deltaY !== 0);
      expect(fullDelta).toBeDefined();
      expect(extraDelta).toBeDefined();
      expect(
        Math.abs((extraDelta?.deltaY ?? 0) - (fullDelta?.deltaY ?? 0)),
      ).toBeGreaterThan(0);
      /* 两种档位下屏幕构图都成立。 */
      const projectionFull = projectHorizontalFrame(full, VIEW, time);
      const projectionExtra = projectHorizontalFrame(extra, VIEW, time);
      expect(projectionFull.frontRatio ?? 0).toBeGreaterThanOrEqual(FRONT_FLOOR);
      expect(projectionExtra.frontRatio ?? 0).toBeGreaterThanOrEqual(FRONT_FLOOR);
      expect(projectionFull.frontRatio ?? 1).toBeLessThanOrEqual(0.8);
      expect(projectionExtra.frontRatio ?? 1).toBeLessThanOrEqual(0.8);
    }
  });

  it('相邻 cue 处固定世界点**没有速度台阶**（旧核 320~860px/s → 现 ~14px/s），且总速度仍 ≤ 2.2W', () => {
    /*
     * 旧核（正态 CDF）在每粒字 cue 处右导数 `√(2/π)/σ`、左导数 0 ⇒ 固定世界点实测
     * 320~860px/s 的速度台阶，用户观感就是"每粒字顿一下"。Rayleigh 核 `K′(0⁺) = 0`
     * 把台阶归零：实测最坏一跳只剩整条轨迹峰值速度的 ~1.5%。
     * 同时**不放宽**原 strict 红线：固定世界点总速度仍 ≤ 视口宽 × 2.2。
     */
    const peak = fixedPointPeak(1 / 240);
    const jumps = cueVelocityJumps(1 / 240);
    const finer = cueVelocityJumps(1 / 480);
    const worstIndex = jumps.rows.indexOf(jumps.worst);
    console.info(
      `[horizontal][cue-velocity] fixedPeak=${peak.toFixed(0)}px/s ` +
        `worstJump=${jumps.worst.toFixed(2)}px/s@cue${worstIndex + 4} ` +
        `worstJump480=${finer.worst.toFixed(2)}px/s limit=${(VIEW.width * 2.2).toFixed(0)}`,
    );
    expect(peak).toBeLessThanOrEqual(VIEW.width * 2.2);
    /* 台阶消失：最坏一跳必须只是峰值速度的零头（旧核这里是 0.3~0.9 倍）。 */
    expect(jumps.worst).toBeLessThan(peak * 0.04);
    expect(jumps.worst).toBeLessThan(VIEW.width * 0.02);
    expect(finer.worst).toBeLessThan(VIEW.width * 0.02);
    /* 两个步长的结论一致（不是某个采样相位恰好躲过台阶）。 */
    expect(finer.worst).toBeLessThanOrEqual(jumps.worst * 1.2);
  });

  it('animationScale = 0：关动画档保留静态 `basePivot`（屏幕锚定不在 0 档绕过强度混合）', () => {
    /*
     * `screenAnchored` 的轴心直接采信只在动画强度 > 0 时生效。0 档（关动画）必须回到
     * 本镜静态 `basePivot`：此前无条件采信会把 `pivot.x` 钉到 `aimX`，于是关掉动画后
     * 镜头仍逐帧从 −141 走到 1600（实测）。正强度档仍直接采信 ⇒ 构图目标不变。
     */
    const times = [1, 3, 6, 8.5];
    const frozen = times.map((time) =>
      buildSonnetFrame({ ...frameInput(HORIZONTAL_PROGRAM, time, VIEW), animationScale: 0 }),
    );
    for (const frame of frozen) {
      /* 这些时刻确实处于横向长句屏幕锚定（否则本用例测不到那条分支）。 */
      expect(frame.cameraFocus.screenAnchored).toBe(true);
      /* 0 档轴心既不等于 `aimX`，也不随前沿逐帧移动。 */
      expect(Math.abs(frame.pivot.x - frame.cameraFocus.aimX)).toBeGreaterThan(1);
    }
    const first = frozen[0];
    expect(first).toBeDefined();
    for (const frame of frozen) {
      expect(frame.pivot.x).toBeCloseTo(first?.pivot.x ?? Number.NaN, 9);
      expect(frame.pivot.y).toBeCloseTo(first?.pivot.y ?? Number.NaN, 9);
    }
    /* 同一段里 `aimX` 明显在动 ⇒ 上面的"静止"不是"这段本来就没焦点"骗过的。 */
    const aimSpread =
      Math.max(...frozen.map((frame) => frame.cameraFocus.aimX)) -
      Math.min(...frozen.map((frame) => frame.cameraFocus.aimX));
    expect(aimSpread).toBeGreaterThan(200);
    /* 正强度档仍然直接采信屏幕锚定轴心（1 档构图目标不退化）。 */
    const anchored = buildSonnetFrame({ ...frameInput(HORIZONTAL_PROGRAM, 6, VIEW), animationScale: 1 });
    expect(anchored.pivot.x).toBeCloseTo(anchored.cameraFocus.aimX, 9);
    /*
     * `pivot + anchorDelta` 恒等于本镜取景锚点：0 档与 1 档同一个数
     * ⇒ 关动画只是"不混合焦点"，没有把画面整体搬走。
     */
    for (const frame of [...frozen, anchored]) {
      expect(frame.pivot.x + frame.anchorDelta.x).toBeCloseTo(
        (first?.pivot.x ?? 0) + (first?.anchorDelta.x ?? 0),
        6,
      );
      expect(frame.pivot.y + frame.anchorDelta.y).toBeCloseTo(
        (first?.pivot.y ?? 0) + (first?.anchorDelta.y ?? 0),
        6,
      );
    }
  });

  it('seek 确定性：同一时刻先跑别处再回来，帧与投影逐值相同', () => {
    const time = 4.7;
    const first = buildSonnetFrame(frameInput(HORIZONTAL_PROGRAM, time, VIEW));
    buildSonnetFrame(frameInput(HORIZONTAL_PROGRAM, time + 3.1, VIEW));
    buildSonnetFrame(frameInput(HORIZONTAL_PROGRAM, 0.2, VIEW));
    const again = buildSonnetFrame(frameInput(HORIZONTAL_PROGRAM, time, VIEW));
    expect(again).toEqual(first);
    const projectionFirst = projectHorizontalFrame(first, VIEW, time);
    const projectionAgain = projectHorizontalFrame(again, VIEW, time);
    expect(projectionAgain.frontRatio).toBe(projectionFirst.frontRatio);
    expect(projectionAgain.tailRatio).toBe(projectionFirst.tailRatio);
    expect(projectionFirst.frontRatio).not.toBeNull();
  });

  it('竖排 / 短句不被强加横向锚定：`mask-reveal` 竖排镜的前沿不贴在 0.45 上', () => {
    /*
     * 三行 fixture 的第二镜是竖排为主的 `mask-reveal`（今ここから始めよう4）。
     * 判据挡掉它以后，焦点仍走旧口径（块中心），**不会**被钉在 0.45 / 0.67 这两个锚点上 ——
     * 也就是"不全局强加"这条契约的可测形式：前沿随排版自己走，且与"要不要横向锚定"无关。
     */
    const frame = buildSonnetFrame(frameInput(HORIZONTAL_PROGRAM, 20.4, VIEW));
    expect(frame.shotKind).toBe('mask-reveal');
    const projection = projectHorizontalFrame(frame, VIEW, 20.4);
    expect(projection.frontRatio).not.toBeNull();
    expect(Math.abs((projection.frontRatio ?? 0) - 0.45)).toBeGreaterThan(0.02);
  });

  it('同一横向阅读通路：最终 world 投影固定世界点只朝读法方向推进（水平速度不反向）', () => {
    /*
     * SONNET_RIGHTWARD_SWAY_20261013 的验收口径：不比 `maxspeed`，而是把**固定世界点**
     * 过一遍最终 world 变换（pivot + anchorDelta + camera×视口 + R·zoom·(世界点 − pivot)），
     * 量它的水平速度方向反转次数 / 累计反向距离。同一镜内（`p0-shot-0`，排除换镜）。
     *
     * 这段 fixture 的排版严格单调（闸门里"总变差 = 净位移"），所以它是一条**基线护栏**：
     * 反向落点与句末空档两个方向的判别性用例在 `sonnetCameraFocus.test.ts`（含 baseline 对照）。
     */
    const dt = 1 / 60;
    const xs: number[] = [];
    let collecting = false;
    for (let time = 0; time <= 9.6 + 1e-9; time += dt) {
      const frame = buildSonnetFrame(frameInput(HORIZONTAL_PROGRAM, time, VIEW));
      if (frame.shotId !== 'p0-shot-0') {
        /* 收满这一镜就停：换镜会换排版，不能与镜内的速度混在一起比。 */
        if (collecting) break;
        continue;
      }
      collecting = true;
      xs.push(fixedWorldPoint(frame, VIEW).x);
    }
    expect(xs.length).toBeGreaterThan(400);
    const net = (xs.at(-1) ?? 0) - (xs[0] ?? 0);
    const dominant = net >= 0 ? 1 : -1;
    let reversals = 0;
    let reverseDistance = 0;
    let run = 0;
    for (let index = 1; index < xs.length; index += 1) {
      const delta = (xs[index] ?? 0) - (xs[index - 1] ?? 0);
      const speed = delta / dt;
      if (Math.abs(speed) > 8 && speed * dominant < 0) {
        if (run === 0) reversals += 1;
        run += Math.abs(delta);
        reverseDistance += Math.abs(delta);
      } else {
        run = 0;
      }
    }
    console.info(
      `[horizontal][direction] net=${net.toFixed(0)}px reversals=${reversals} ` +
        `reverseDistance=${reverseDistance.toFixed(1)}px`,
    );
    /* 长横排一路向右推镜：固定世界点水平速度最多允许一次（开场瞬间）反向，累计 < 1% 视口宽。 */
    expect(reversals).toBeLessThanOrEqual(1);
    expect(reverseDistance).toBeLessThan(VIEW.width * 0.01);
  });
});
