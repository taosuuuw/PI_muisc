/**
 * 凝彩（tempera）**帧层**的自查（长期保留，`pnpm test` 的默认 include 会自动收进来）。
 *
 * 帧层是纯函数：给定时刻与视口，算出这一帧的面板 / 缝 / 字 / 装饰 / 相机。渲染层只负责执行它，
 * 所以这里守住的就是「观感逼近」的算术部分：相机插值与呼吸幅度、四档明度的单调性、
 * split 族的覆盖与兜底标记、字素落在排版框里、以及确定性（同一时刻两次求值必须逐字段一致）。
 */

import { describe, expect, it } from 'vitest';
import type { StageLine } from './types';
import { relativeLuminance, parseRgb } from './types';
import { TEMPERA_SHOT_KINDS, TEMPERA_SHOT_KINDS_BY_FAMILY } from './temperaKinds';
import { compileTemperaProgram, buildShotChunks } from './temperaProgram';
import type { TemperaShot } from './temperaProgram';
import { resolveTemperaShotProfile } from './temperaProfiles';
import { fallbackComposition } from './temperaCompositions';
import {
  TEMPERA_CAMERA_BREATH_MAX_OFFSET,
  TEMPERA_FRAGMENT_ALPHA,
  TEMPERA_PAPER_WASH_ALPHA,
  TEMPERA_SCREENTONE_ALPHA,
  TEMPERA_SCREENTONE_SIZE,
  TEMPERA_WATERMARK_ALPHA,
  resolveTemperaScreentoneSpacing,
  buildTemperaComposition,
  buildTemperaFrame,
  rectPolygon,
  resolveTemperaBaseFontSize,
  resolveTemperaBreathWeight,
  resolveTemperaCameraBreath,
  resolveTemperaCameraFrame,
  resolveTemperaTones,
} from './temperaFrame';

const VIEWPORT = { width: 1200, height: 800 };

function makeLine(index: number, timeMs: number, text: string, perWord = 2, stepMs = 220): StageLine {
  const chars = Array.from(text);
  const words = chars.map((char, charIndex) => ({
    text: char,
    startMs: timeMs + charIndex * stepMs,
    endMs: timeMs + (charIndex + 1) * stepMs,
    wordStart: charIndex % perWord === 0,
  }));
  return {
    index,
    timeMs,
    text,
    durationMs: chars.length * stepMs,
    hint: 'normal',
    words,
    starts: words.map((word) => word.startMs),
    ends: words.map((word) => word.endMs),
  };
}

const makeProgram = () =>
  compileTemperaProgram(
    [
      makeLine(0, 0, 'あいうえおかきくけこ'),
      makeLine(1, 3000, 'さしすせそたちつてと'),
      makeLine(2, 7000, 'なにぬねのはひふへほ'),
    ],
    'tempera-test',
  );

/** 造一个最简 shot 用于相机测试。 */
const makeShot = (camera: readonly [number, number, number, number], cameraEnd: readonly [number, number, number, number]): TemperaShot => ({
  id: 'p0-s0',
  kind: 'duo-split',
  startTime: 0,
  endTime: 2,
  lyricEndTime: 1.5,
  slices: [],
  isBridge: false,
  camera: { x: camera[0], y: camera[1], zoom: camera[2], rotation: camera[3] },
  cameraEnd: { x: cameraEnd[0], y: cameraEnd[1], zoom: cameraEnd[2], rotation: cameraEnd[3] },
  flowAngle: Math.PI / 2,
  decor: {
    motif: 'diamonds',
    hatchAngle: 0,
    crossCount: 1,
    scribbleSeed: 0,
    fragments: [],
    watermark: null,
  },
});

/**
 * 装饰的**基准字号**（上游 `temperaSceneBuilder.ts:459~464`，第 619 轮搬过来）。
 * 以前我们用 `scale × viewW / 12` 糊过去 —— 量级凑合，但**没有"最小 12px/48px"那道闸**，
 * 且它不是上游那条算式。这里把算式本身钉住。
 */
describe('tempera 装饰基准字号（上游 baseFontSize）', () => {
  it('算式 = max(34, min(150, (width / max(5, maxGraphemes × 1.05)) × 1.5))', () => {
    // 字很少 ⇒ 顶到上限 150。
    expect(resolveTemperaBaseFontSize(1200, 3)).toBe(150);
    // 字很多 ⇒ 落回下界 34。
    expect(resolveTemperaBaseFontSize(1200, 200)).toBe(34);
    // 中间段（1200 / 10.5 × 1.5 = 171.4）仍被上限夹住。
    expect(resolveTemperaBaseFontSize(1200, 10)).toBe(150);
    // 唯一落在开区间里的那一档：600 / 21 × 1.5 = 42.857…
    expect(resolveTemperaBaseFontSize(600, 20)).toBeCloseTo(42.857, 3);
  });

  it('帧上带着这个标尺，且落在上游的下界与上限之间', () => {
    // 这一块在 `describe('tempera 帧')` 之前，所以不能用它的 `frameAt`，就地构造一次。
    const frame = buildTemperaFrame({
      program: makeProgram(),
      timeSec: 0.6,
      viewport: VIEWPORT,
      paper: 'rgb(246, 243, 238)',
      deep: 'rgb(186, 58, 74)',
      glyph: 'rgb(255, 255, 255)',
      accent: 'rgb(216, 72, 88)',
      wordColorOf: (_text, fallback) => fallback,
    });
    expect(frame).not.toBeNull();
    if (frame === null) return;
    expect(frame.decorBaseFontSize).toBeGreaterThanOrEqual(34);
    expect(frame.decorBaseFontSize).toBeLessThanOrEqual(150);
  });
});

/**
 * 每镜那层**方点阵**（上游 `screentone`，第 620 轮补）：间距 `max(26, √(w·h / 6000))`、
 * 方块 1.6px、`tone4` @ alpha 0.05。视觉贡献小，但"没有它纸面就是数字纯色"。
 */
describe('tempera 方点阵（上游 screentone）', () => {
  it('方块 1.6px、alpha 0.05', () => {
    expect(TEMPERA_SCREENTONE_SIZE).toBe(1.6);
    expect(TEMPERA_SCREENTONE_ALPHA).toBe(0.05);
  });

  it('间距 = max(26, √(width × height / 6000))', () => {
    // 应用窗口与更小的画布都顶到下限 26（1182×772 ⇒ √152.1 = 12.3）。
    expect(resolveTemperaScreentoneSpacing(300, 200)).toBe(26);
    expect(resolveTemperaScreentoneSpacing(1182, 772)).toBe(26);
    // 4K 才越过下限：√(8294400 / 6000) = √1382.4 = 37.18…
    expect(resolveTemperaScreentoneSpacing(3840, 2160)).toBeCloseTo(37.18, 2);
  });
});

/**
 * 每镜最底的**满幅纸**（上游 `paperWash`，第 620 轮补）。
 * 它决定"留白读成纸"还是"留白读成背景穿帮"，所以不透明度按上游原文钉住。
 */
describe('tempera 满幅纸（上游 paperWash）', () => {
  it('不透明度 0.35', () => {
    expect(TEMPERA_PAPER_WASH_ALPHA).toBe(0.35);
  });
});

/**
 * 装饰两件的**不透明度是上游原文常量、而且没有时间轴**（第 617 轮接线，出处 `temperaTextView.ts`）。
 * 钉住它是因为"看着有点淡"太容易被顺手调亮，而这两个数在上游是写死的：
 * 页边散字 `node.alpha = 0.42`、超大装饰词 `node.alpha = 0.16`。
 */
describe('tempera 装饰透明度（上游原文常量）', () => {
  it('页边散字 0.42 / 超大装饰词 0.16', () => {
    expect(TEMPERA_FRAGMENT_ALPHA).toBe(0.42);
    expect(TEMPERA_WATERMARK_ALPHA).toBe(0.16);
  });
});

describe('tempera 相机', () => {
  it('progress 0 取起点、1 取终点，中段在两者之间', () => {
    const shot = makeShot([-0.05, -0.05, 1.05, 0], [0.05, 0.05, 1.15, 0]);
    expect(resolveTemperaCameraFrame(shot, 0).x).toBeCloseTo(-0.05, 6);
    expect(resolveTemperaCameraFrame(shot, 0).scale).toBeCloseTo(1.05, 6);
    expect(resolveTemperaCameraFrame(shot, 1).x).toBeCloseTo(0.05, 6);
    expect(resolveTemperaCameraFrame(shot, 1).scale).toBeCloseTo(1.15, 6);
    const middle = resolveTemperaCameraFrame(shot, 0.5);
    expect(middle.x).toBeGreaterThan(-0.05);
    expect(middle.x).toBeLessThan(0.05);
  });

  it('progress 超过 1 时继续漂出去（间隙里不冻帧），但幅度被压到 0.35 倍', () => {
    const shot = makeShot([0, 0, 1, 0], [0.1, 0, 1.1, 0]);
    const beyond = resolveTemperaCameraFrame(shot, 2);
    const atEnd = resolveTemperaCameraFrame(shot, 1);
    expect(beyond.x).toBeGreaterThan(atEnd.x);
    expect(beyond.x).toBeLessThanOrEqual(0.1 + 0.35 * 0.1 + 1e-9);
  });

  it('呼吸浮动在三档上限之内，且是绝对时间的确定性函数', () => {
    for (const time of [0, 0.37, 1.9, 12.5, 60]) {
      const breath = resolveTemperaCameraBreath(time, 3);
      expect(Math.abs(breath.x)).toBeLessThanOrEqual(TEMPERA_CAMERA_BREATH_MAX_OFFSET + 1e-9);
      expect(Math.abs(breath.y)).toBeLessThanOrEqual(TEMPERA_CAMERA_BREATH_MAX_OFFSET + 1e-9);
      expect(Math.abs(breath.scale)).toBeLessThanOrEqual(0.002 + 1e-9);
      expect(Math.abs(breath.rotation)).toBeLessThanOrEqual(0.0015 + 1e-9);
    }
    expect(resolveTemperaCameraBreath(5, 1)).toEqual(resolveTemperaCameraBreath(5, 1));
  });

  it('呼吸权重在入场走完之前是 0，之后 1.2s 内升到 1', () => {
    expect(resolveTemperaBreathWeight(1, 2)).toBe(0);
    expect(resolveTemperaBreathWeight(2, 2)).toBe(0);
    const half = resolveTemperaBreathWeight(2.6, 2);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
    expect(resolveTemperaBreathWeight(4, 2)).toBeCloseTo(1, 6);
  });
});

describe('tempera 色阶与构图', () => {
  it('四档明度从纸色单调走到墨色', () => {
    const tones = resolveTemperaTones('rgb(250, 250, 250)', 'rgb(10, 10, 10)', 'rgb(200, 40, 60)');
    const lums = tones.tone.map((color) => {
      const parsed = parseRgb(color);
      expect(parsed).not.toBeNull();
      return parsed === null ? 0 : relativeLuminance(parsed);
    });
    for (let index = 1; index < lums.length; index += 1) {
      expect(lums[index]).toBeLessThan(lums[index - 1] ?? 1);
    }
  });

  it('split 族 13 种都给出真实构图（不是兜底），且面板覆盖整幅画面', () => {
    const bleed = 96;
    for (const kind of TEMPERA_SHOT_KINDS_BY_FAMILY.split) {
      const spec = buildTemperaComposition(kind, 12345, VIEWPORT, bleed);
      expect(spec.fallback).toBe(false);
      expect(spec.panels.length).toBeGreaterThan(0);
      for (const panel of spec.panels) {
        expect(panel.points.length).toBeGreaterThanOrEqual(6);
        expect(panel.points.length % 2).toBe(0);
        for (const coordinate of panel.points) expect(Number.isFinite(coordinate)).toBe(true);
        expect(panel.span).toBeGreaterThan(0);
        expect(panel.tone).toBeGreaterThanOrEqual(0);
        expect(panel.tone).toBeLessThanOrEqual(3);
      }
      /*
       * 构图必须**铺满整幅画面**：所有面板的并集外接框要越过四边（含出血）。
       * 不能拿「面板盖住画面中心」当判据 —— `pillar-gap` 的中心是**故意留出来的亮缝**
       * （两块重物夹一条缝，歌词站在缝里），`diagonal-halves` 的中心又正好落在斜边上。
       */
      const xs = spec.panels.flatMap((panel) =>
        panel.points.filter((_value, index) => index % 2 === 0),
      );
      const ys = spec.panels.flatMap((panel) =>
        panel.points.filter((_value, index) => index % 2 === 1),
      );
      expect(Math.min(...xs)).toBeLessThanOrEqual(0);
      expect(Math.max(...xs)).toBeGreaterThanOrEqual(VIEWPORT.width);
      expect(Math.min(...ys)).toBeLessThanOrEqual(0);
      expect(Math.max(...ys)).toBeGreaterThanOrEqual(VIEWPORT.height);
      // 且不是一堆碎屑：至少有一块的面积超过画面的两成。
      const largest = Math.max(
        ...spec.panels.map((panel) => {
          const panelXs = panel.points.filter((_value, index) => index % 2 === 0);
          const panelYs = panel.points.filter((_value, index) => index % 2 === 1);
          return (
            (Math.max(...panelXs) - Math.min(...panelXs)) *
            (Math.max(...panelYs) - Math.min(...panelYs))
          );
        }),
      );
      expect(largest).toBeGreaterThan(VIEWPORT.width * VIEWPORT.height * 0.2);
    }
  });

  it('收官：121 种构图全部有实现，兜底只留给异常路径', () => {
    /*
     * 这条断言在族的推进过程中改过三次口径：
     * 「挑一个具体族当未实现举例」→「动态判定哪些 kind 还在兜底（下界 > 0）」→ 现在是「**必须为空**」。
     * 凝彩的 121 种构图到此全部落地，`fallbackComposition` 只在族工厂全部返回 `null` 时才被用到。
     */
    const stillFallback = TEMPERA_SHOT_KINDS.filter(
      (kind) => buildTemperaComposition(kind, 7, VIEWPORT, 96).fallback,
    );
    expect(stillFallback).toEqual([]);
    expect(TEMPERA_SHOT_KINDS.length).toBe(121);
  });

  it('兜底构图本身仍然有结构（万一将来有新的 kind 漏掉）', () => {
    const spec = fallbackComposition(VIEWPORT, 96);
    expect(spec.fallback).toBe(true);
    expect(spec.panels.length).toBeGreaterThan(1);
    expect(spec.panels.length + spec.strokes.length).toBeGreaterThan(0);
  });

  it('rectPolygon 是顺时针四点闭合（左上 → 右上 → 右下 → 左下）', () => {
    expect(rectPolygon(10, 20, 30, 40)).toEqual([10, 20, 40, 20, 40, 60, 10, 60]);
  });
});

describe('tempera 帧', () => {
  const frameAt = (timeSec: number) =>
    buildTemperaFrame({
      program: makeProgram(),
      timeSec,
      viewport: VIEWPORT,
      paper: 'rgb(246, 243, 238)',
      deep: 'rgb(186, 58, 74)',
      glyph: 'rgb(255, 255, 255)',
      accent: 'rgb(216, 72, 88)',
      wordColorOf: (_text, fallback) => fallback,
    });

  it('时间轴上任意时刻都能算出一帧（含间隙）', () => {
    for (const time of [0, 0.4, 1.6, 3.2, 6.5, 9.4, 20]) {
      const frame = frameAt(time);
      expect(frame).not.toBeNull();
      /*
       * 判据是"这一帧得有东西画"，不能只看面板：`sparse` 族里 `quiet-line` / `hair-grid` /
       * `blank-page` 这些**一块面板都没有**（留白就是它们的本意），画面全靠线条撑。
       */
      expect((frame?.panels.length ?? 0) + (frame?.strokes.length ?? 0)).toBeGreaterThan(0);
      expect(Number.isFinite(frame?.camera.scale ?? Number.NaN)).toBe(true);
    }
  });

  it('字素落在排版框内，且延迟按序号递增、hero 词更大', () => {
    const frame = frameAt(0.6);
    expect(frame).not.toBeNull();
    if (frame === null) return;
    expect(frame.glyphs.length).toBeGreaterThan(0);
    const profile = resolveTemperaShotProfile(frame.shotKind);
    const [cx, cy, w, h] = profile.region;
    const left = cx * VIEWPORT.width - (w * VIEWPORT.width) / 2;
    const right = cx * VIEWPORT.width + (w * VIEWPORT.width) / 2;
    const top = cy * VIEWPORT.height - (h * VIEWPORT.height) / 2;
    for (const glyph of frame.glyphs) {
      // 允许半格字宽/字高的出框（centering 的取整），但绝不能飞到别的框里去。
      expect(glyph.x).toBeGreaterThanOrEqual(left - glyph.fontPx);
      expect(glyph.x).toBeLessThanOrEqual(right + glyph.fontPx);
      expect(glyph.y).toBeGreaterThanOrEqual(top - glyph.fontPx);
      expect(glyph.fontPx).toBeGreaterThanOrEqual(8);
      expect(glyph.span).toBeGreaterThan(0);
    }
    // 延迟严格递增（入场是一颗颗落下来的）。
    for (let index = 1; index < frame.glyphs.length; index += 1) {
      expect(frame.glyphs[index]?.delay ?? 0).toBeGreaterThan(frame.glyphs[index - 1]?.delay ?? 0);
    }
    // hero 词（第一个词）比后面那些被压小的词更大。
    const first = frame.glyphs[0]?.fontPx ?? 0;
    const later = frame.glyphs[frame.glyphs.length - 1]?.fontPx ?? 0;
    expect(first).toBeGreaterThan(later);
  });

  it('只有**真命中词色**的 hero 词才带 keyword 标记（其余仍留在反色层）', () => {
    const hit = buildTemperaFrame({
      program: makeProgram(),
      timeSec: 0.6,
      viewport: VIEWPORT,
      paper: 'rgb(246, 243, 238)',
      deep: 'rgb(186, 58, 74)',
      glyph: 'rgb(255, 255, 255)',
      accent: 'rgb(216, 72, 88)',
      // 命中词色：换成一个**不是墨色**的主题色。
      wordColorOf: () => 'rgb(12, 200, 120)',
    });
    expect(hit).not.toBeNull();
    if (hit === null) return;
    const keyword = hit.glyphs.filter((glyph) => glyph.keyword === true);
    expect(keyword.length).toBeGreaterThan(0);
    for (const glyph of keyword) expect(glyph.color).toBe('rgb(12, 200, 120)');
    /*
     * 关键断言：进 keyword 层的必须是**少数**（只有那个 hero 词），
     * 否则整句退出反色层、字不再随背景翻色 —— 第 618 轮实测踩过这一脚（15/16）。
     */
    expect(keyword.length).toBeLessThan(hit.glyphs.length);
    expect(hit.glyphs.some((glyph) => glyph.keyword === undefined)).toBe(true);
  });

  it('没命中词色时 hero 用 accent 兜底，但**仍留在反色层**（keyword 层不启用）', () => {
    const frame = frameAt(0.6);
    expect(frame).not.toBeNull();
    if (frame === null) return;
    // 条件展开：未置位时连键都没有（产物形状与接线前一致）。
    expect(frame.glyphs.every((glyph) => glyph.keyword === undefined)).toBe(true);
    // "hero 被着色"这件事没变（兜底成 accent），变的只是它去哪个层。
    expect(frame.glyphs.some((glyph) => glyph.color === 'rgb(216, 72, 88)')).toBe(true);
  });

  it('同一时刻两次求值逐字段一致（seek 前后画面不变）', () => {
    const first = frameAt(1.27);
    const second = frameAt(1.27);
    expect(first).toEqual(second);
    // 不同时刻必须不同（否则就是冻帧）。
    expect(JSON.stringify(frameAt(1.27))).not.toBe(JSON.stringify(frameAt(2.4)));
  });

  it('shot 切分产出的 slice 与编译行对得上（帧层能查到字）', () => {
    const program = makeProgram();
    const lines = program.paragraphs.flatMap((paragraph) => paragraph.lines);
    const chunks = buildShotChunks(lines, 'tempera-test', 0, false);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const line = lines.find((item) => item.sourceIndex === chunk.lineIndex);
      expect(line).toBeDefined();
      const slice = (line?.segments ?? []).slice(chunk.segmentStart, chunk.segmentEnd);
      expect(slice.length).toBeGreaterThan(0);
      expect(slice.length).toBeLessThanOrEqual(4);
    }
  });
});
