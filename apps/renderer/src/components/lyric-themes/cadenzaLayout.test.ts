/**
 * 心象（cadenza）歌词排布的**几何自查**（长期保留，根 `pnpm test` 的默认 include 会自动收进来）。
 *
 * 只验 `buildCadenzaPlan` 算出来的矩形，不比截图：截图只能证明「这一帧好巧不巧没重叠」，
 * 这里证明的是数学性质——**所有舞台 × 所有旋钮档 × 1~20+ 字的行**下：
 * 1) 每个非强调词的**词心**相对焦点的纵向偏移都落在「纵向室」里——
 *    纵向室 = `min(max(folia 原式, 容量值), 视口安全线)`；folia 原式 = 上 `max(整块高 × 0.9, 行高 × 1.6)` /
 *    下 `max(整块高 × 0.9, 行高 × 1.45)`，容量值 = `ceil(总碰撞宽 ÷ 落位可用宽) × 行距 ÷ 2`。
 *    见 `plan.bounds`（`upPx/downPx` = 纵向室，`foliaUpPx/foliaDownPx` = folia 原式，
 *    `capacityHalfPx` = 容量值）；判定式 `|词心 y| ≤ 纵向室 + 词半高 + 1px`；
 * 2) 任意两个词的矩形都不相交（1px 容差）；
 * 3) 没有任何词的矩形跑出视口（含 `scale(1.3)` / 旋转 / 漂移 / 抖动的动效包络，20px 容差）；
 * 4) hero 居中、句子里 hero 左边的词都在左半、右边的词都在右半（= 「按阅读顺序铺开」）。
 *
 * 【第十四轮第 5 条（用户 m05281）把它改成 folia-major 的 cadenza 预设：绕 hero 螺旋铺开，
 *  所以第 1 条换了契约——原来的「±min(舞台高 × 0.22, 170px) 中间带」是第十三轮
 *  「沿阅读顺序收进中带」的规格，与 folia「撒开后按句成行」天然冲突。这一条改成
 *  「folia 原式 + 容量放宽 + 视口安全线」的纵向室，并按上层指定的「词心」形态判定
 *  （盒本身最多可探出纵向室 词半高；「不出视口」由第 3 条单独保证，「两词不相交」由第 2 条保证）。
 *  放宽量（实测 330 组可达用例）：folia 原式就够的有 112/330 组（短句 / 小字号），
 *  其余 218 组放宽到容量值，最大放宽 136.8px（最大容量半高 361.3px，出现在 24 字 × fs=1.3）。
 *  例：1 字句 @1920×1080 fs=1 的 folia 上 184.0/下 166.8 就是最终值（未放宽）；
 *  9 字句 @1920×1080 fs=1.3：folia 177.6/160.9 → 实际 199.7/199.7。
 *  另外「零重叠」靠两道机制兜住：预扫逐词收窄（下限 `MIN_WORD_SCALE = 0.2`）与落位冲突时
 *  逐级缩字（`PLACE_SHRINK_STEP = 0.9`，下限 `MIN_PLACE_SHRINK = 0.62`）——
 *  实测 138/3450 个词被缩（最小比例 0.620）。其余三条断言一字未改。
 *
 * 用户 m03279 第 3 条要的是「如图 4 / 图 5 那样沿句子铺开，而不是杂乱无章地散在页面上」，
 * 翻译成可验算的就是 2) + 4)：词彼此不相交、且严格按 hero 左右分侧。
 *
 * 桩字体：Node 里没有 canvas，`measureTextWidth` 本来就会回退到 `estimateTextWidth`
 * （CJK 1em / 其余 0.55em），所以这里用它反推宽度与内部量到的**同源**。
 * 真实 DOM 上 `.pi-lyriccadenza__inner` 还有 `letter-spacing: 0.01em`（≈1% 字宽），
 * 而碰撞盒比实测宽宽 26%、行内还留 `gap`（≥ 2×6+0.3×字号 px），吃得掉这点差异。
 * hero 不参与第 1 条：`y: 0` ⇒ 它的 DOM 盒从焦点往下挂，是**既有**的「居中放大」行为（本轮不动）。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_TUNING, type LyricTuning } from '@pi/shared';
import { buildCadenzaPlan } from './CadenzaTheme';
import {
  DEFAULT_PALETTE,
  estimateTextWidth,
  type AnimationIntensity,
  type LyricPalette,
  type StageLine,
  type StageWord,
} from './types';

/** 舞台锚点（`CadenzaTheme.tsx` 的模块常量没导出，这里跟着它的数值走：画面高 × 0.42）。 */
const FOCUS_Y_RATIO = 0.42;
/** 唱到时 `scale(1.3)`（以词的左上角为原点向右下扩），见 `CadenzaTheme.tsx:558`。 */
const ENTER_SCALE = 1.3;
/** 第十三轮的中间带规格 `min(舞台高 × 0.22, 170px)`：第 1 条已改用 folia 边界，
 *  这两个常量只留给「不可达舞台」与「打印数值」两个用例做**历史参考**日志。 */
const BAND_RATIO = 0.22;
const BAND_MAX_PX = 170;

/* ------------------------------------------------------------------ *
 * 用例矩阵
 * ------------------------------------------------------------------ */

/** 可达舞台：应用窗口最小尺寸 960×620（`apps/desktop/src/main/index.ts:154-155`）。 */
const REACHABLE_STAGES: readonly (readonly [number, number])[] = [
  [1920, 1080],
  [1478, 965],
  [1280, 720],
  [1024, 600],
  [960, 620],
  [800, 500],
];
/** 低于应用最小窗口：真机到不了，只记录（见「不可达舞台」用例）。 */
const TINY_STAGES: readonly (readonly [number, number])[] = [
  [640, 400],
];
/** 旋钮档：`fontScale`(0.8~1.3) × `motionAmount`(0.4~1.6) 的四个角 + 默认档。 */
const TUNINGS: readonly (readonly [number, number, boolean])[] = [
  [1, 1, false],
  [1.3, 1.6, true],
  [0.8, 0.4, true],
  [0.8, 1.6, true],
  [1.3, 0.4, false],
];

const KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも';
const LINES: readonly string[] = [
  'め', // 1 字
  'うまめ', // 3 字
  'うまめなく掴んない', // 图 4 那句
  '見えて手探りでな探い壁すよ', // 图 5 那句
  KANA.slice(0, 10), // 10 字
  KANA.slice(0, 24), // 24 字（> 20）
  'ありがとうございましたまた明日', // 14 字
  'この曲はとても長い歌詞で最悪の場合にステージからはみ出さないか確認するための行です', // 长句
  'night summer rain falls',
  'Мы разбиты и мы победим',
  'supercalifragilisticexpialidocious', // 单个超长单词（最坏情况）
];

const graphemes = (text: string): StageWord[] =>
  Array.from(text).map((text2) => ({ text: text2, startMs: 0, endMs: 0 }));

function makeLine(text: string, index: number): StageLine {
  const words = graphemes(text);
  return {
    index,
    timeMs: 4_000 + index * 5_000,
    text,
    durationMs: 3_200,
    hint: 'normal',
    words,
    starts: words.map((_, at) => at * 90),
    ends: words.map((_, at) => at * 90 + 90),
  };
}

function layout(
  line: StageLine,
  width: number,
  height: number,
  fontScale: number,
  motionAmount: number,
  chaotic: boolean,
): ReturnType<typeof buildCadenzaPlan> {
  const tuning: LyricTuning = { ...DEFAULT_LYRIC_TUNING, fontScale, motionAmount };
  const intensity: AnimationIntensity = chaotic ? 'chaotic' : 'calm';
  const palette: LyricPalette = { ...DEFAULT_PALETTE, animationIntensity: intensity, tuning };
  return buildCadenzaPlan(line, width, height, intensity, palette, 'stub-font', null);
}

interface Box {
  readonly index: number;
  readonly text: string;
  readonly hero: boolean;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 词的 **DOM 矩形**（相对舞台中心）：`placement.x/y` 就是左上角（`.pi-lyriccadenza__word`
 *  是 `left/top` 定位 + `transform-origin: 0 0`），宽用 `estimateTextWidth` 反推，
 *  高 = `placement.fontPx`（`.pi-lyriccadenza__inner` 是 `line-height: 1`）。 */
function domBoxes(plan: ReturnType<typeof buildCadenzaPlan>): Box[] {
  return plan.words.map((word) => {
    const width = estimateTextWidth(word.text, word.placement.fontPx, 0);
    const height = word.placement.fontPx;
    return {
      index: word.index,
      text: word.text,
      hero: word.hero,
      left: word.placement.x,
      top: word.placement.y,
      right: word.placement.x + width,
      bottom: word.placement.y + height,
    };
  });
}

interface Case {
  readonly where: string;
  readonly plan: ReturnType<typeof buildCadenzaPlan>;
  readonly boxes: readonly Box[];
  readonly stage: { readonly w: number; readonly h: number };
  /** 这一档舞台的中间带半径 = `min(舞台高 × 0.22, 170px)`（第十三轮规格，只作日志参考）。 */
  readonly band: number;
  /** 视口在「相对舞台中心」坐标系里的范围（行原点 = (视口宽/2, focusY)）。 */
  readonly view: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
}

function buildCases(
  lines: readonly string[],
  stages: readonly (readonly [number, number])[],
): Case[] {
  const cases: Case[] = [];
  for (const text of lines) {
    for (const [w, h] of stages) {
      for (const [fontScale, motionAmount, chaotic] of TUNINGS) {
        const line = makeLine(text, cases.length);
        const plan = layout(line, w, h, fontScale, motionAmount, chaotic);
        cases.push({
          where: `"${text}" @ ${w}x${h} fs=${fontScale} mo=${motionAmount} ch=${chaotic}`,
          plan,
          boxes: domBoxes(plan),
          stage: { w, h },
          band: Math.min(h * BAND_RATIO, BAND_MAX_PX),
          view: {
            left: -w / 2,
            right: w / 2,
            top: -h * FOCUS_Y_RATIO,
            bottom: h * (1 - FOCUS_Y_RATIO),
          },
        });
      }
    }
  }
  return cases;
}

let cache: Case[] | null = null;
const allCases = (): Case[] => {
  cache ??= buildCases(LINES, REACHABLE_STAGES);
  return cache;
};

const overlapArea = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** `placement` 里参与动效的那几个字段（结构类型，避免依赖组件未导出的类型）。 */
interface Motion {
  readonly drift: number;
  readonly jitterX: number;
  readonly jitterY: number;
  readonly rotate: number;
  readonly passedRotate: number;
  readonly outwardX: number;
  readonly outwardY: number;
}

/**
 * 含动效包络的外接矩形：`scale(1.3)`（以左上角为原点向右下扩）→ 两个方向的
 * `±rotate / ±passedRotate` 各算一遍取并集 → 再加漂移与抖动。
 * 比静止矩形大，所以它落在视口内 ⇒ 动画过程中也不会被裁。
 */
function motionBox(box: Box, motion: Motion): Box {
  const width = (box.right - box.left) * ENTER_SCALE;
  const height = (box.bottom - box.top) * ENTER_SCALE;
  const originX = box.left + motion.outwardX * motion.drift + motion.jitterX;
  const originY = box.top + motion.outwardY * motion.drift + motion.jitterY;
  let left = originX;
  let right = originX;
  let top = originY;
  let bottom = originY;
  for (const angle of [motion.rotate, -motion.rotate, motion.passedRotate, -motion.passedRotate]) {
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    for (const [px, py] of [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ] as const) {
      const x = originX + px * cos - py * sin;
      const y = originY + px * sin + py * cos;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return { ...box, left, top, right, bottom };
}

const centerY = (box: Box): number => (box.top + box.bottom) / 2;
const centerX = (box: Box): number => (box.left + box.right) / 2;

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

describe('cadenza 心象排布几何', () => {
  it('每个非强调词的词心都在 folia 的纵向落位边界里（1px 容差）', () => {
    const out: string[] = [];
    let heroCount = 0;
    let words = 0;
    let shrunk = 0;
    let minRatio = 1;
    for (const item of allCases()) {
      const { upPx, downPx } = item.plan.bounds;
      for (let at = 0; at < item.boxes.length; at += 1) {
        const box = item.boxes[at]!;
        words += 1;
        if (box.hero) {
          heroCount += 1;
          continue;
        }
        // 逐词收窄（预扫 + 冲突时回退缩字号）是否真的被用上：只作日志证据。
        const ratio = item.plan.fontPx > 0 ? (box.bottom - box.top) / item.plan.fontPx : 1;
        if (ratio < 0.999) {
          shrunk += 1;
          minRatio = Math.min(minRatio, ratio);
        }
        const half = (box.bottom - box.top) / 2;
        const center = centerY(box);
        const limit = (center < 0 ? upPx : downPx) + half;
        if (Math.abs(center) > limit + 1) {
          out.push(
            `${item.where} "${box.text}" 词心 y=${center.toFixed(1)} 超出 folia 边界 + 词半高 ${limit.toFixed(1)}` +
              `（边界 -${upPx.toFixed(1)}..${downPx.toFixed(1)}，词高 ${(half * 2).toFixed(1)}）`,
          );
        }
      }
    }
    const sample = allCases()[0];
    const long = allCases().find((item) => item.boxes.length >= 9 && item.stage.w === 1920);
    let widened = 0;
    let maxSpill = 0;
    let maxCapacity = 0;
    for (const item of allCases()) {
      const { upPx, downPx, foliaUpPx, foliaDownPx, capacityHalfPx } = item.plan.bounds;
      const spill = Math.max(upPx - foliaUpPx, downPx - foliaDownPx);
      if (spill > 0.5) widened += 1;
      maxSpill = Math.max(maxSpill, spill);
      maxCapacity = Math.max(maxCapacity, capacityHalfPx);
    }
    console.log(
      `[cadenza] folia 纵向边界断言：${words} 个词（hero ${heroCount} 个走视口断言），词心越界 ${out.length} 个；` +
        `被缩小字号的词 ${shrunk}/${words - heroCount} 个（最小比例 ${minRatio.toFixed(3)}）；` +
        `容量室比 folia 原式宽的有 ${widened}/${allCases().length} 组，最大放宽 ${maxSpill.toFixed(1)}px` +
        `（最大容量半高 ${maxCapacity.toFixed(1)}px）` +
        (sample === undefined
          ? ''
          : `；例 1 字句 @${sample.stage.w}x${sample.stage.h} folia 上 ${sample.plan.bounds.foliaUpPx.toFixed(1)}/下` +
            ` ${sample.plan.bounds.foliaDownPx.toFixed(1)} → 实际 上 ${sample.plan.bounds.upPx.toFixed(1)}/下 ${sample.plan.bounds.downPx.toFixed(1)}`) +
        (long === undefined
          ? ''
          : `，9 字句 @${long.stage.w}x${long.stage.h} folia ${long.plan.bounds.foliaUpPx.toFixed(1)}/` +
            `${long.plan.bounds.foliaDownPx.toFixed(1)} → 实际 ${long.plan.bounds.upPx.toFixed(1)}/${long.plan.bounds.downPx.toFixed(1)}`),
    );
    expect(out.length, out.slice(0, 12).join('\n')).toBe(0);
  });

  it('任意两个词的矩形不相交（含 hero，1px 容差）', () => {
    const out: string[] = [];
    for (const item of allCases()) {
      for (let i = 1; i < item.boxes.length; i += 1) {
        const a = item.boxes[i]!;
        for (let j = 0; j < i; j += 1) {
          const b = item.boxes[j]!;
          const area = overlapArea(a, b);
          if (area >= 1) {
            out.push(`${item.where} "${a.text}" × "${b.text}" 重叠 ${area.toFixed(1)}px²`);
          }
        }
      }
    }
    console.log(`[cadenza] 不相交断言：${allCases().length} 组用例，重叠 ${out.length} 对`);
    expect(out.length, out.slice(0, 12).join('\n')).toBe(0);
  });

  it('没有词被裁：含 scale(1.3) / 旋转 / 漂移 / 抖动的外框仍在视口内（20px 容差）', () => {
    const out: string[] = [];
    for (const item of allCases()) {
      for (let at = 0; at < item.boxes.length; at += 1) {
        const box = item.boxes[at]!;
        const motion = item.plan.words[at]?.placement;
        if (motion === undefined) continue;
        const outer = motionBox(box, motion);
        const over = Math.max(
          item.view.left - outer.left,
          outer.right - item.view.right,
          item.view.top - outer.top,
          outer.bottom - item.view.bottom,
        );
        if (over > 20) {
          out.push(`${item.where} "${box.text}" 出界 ${over.toFixed(1)}px`);
        }
      }
    }
    console.log(`[cadenza] 动效包络不出界断言：出界 ${out.length} 个`);
    expect(out.length, out.slice(0, 12).join('\n')).toBe(0);
  });

  it('按阅读顺序铺开：hero 居中，句子左边的词都在左半、右边的词都在右半', () => {
    const out: string[] = [];
    const roughness: string[] = [];
    for (const item of allCases()) {
      const hero = item.plan.heroIndex;
      if (hero < 0) continue;
      for (const box of item.boxes) {
        if (box.hero) {
          if (Math.abs(centerX(box)) > 1) out.push(`${item.where} hero 没居中：${centerX(box).toFixed(1)}`);
          continue;
        }
        const x = centerX(box);
        if (box.index < hero && x > 0) out.push(`${item.where} 左边的词跑到右侧："${box.text}" x=${x.toFixed(1)}`);
        if (box.index > hero && x < 0) out.push(`${item.where} 右边的词跑到左侧："${box.text}" x=${x.toFixed(1)}`);
      }
      // 同一行内「离 hero 越远、|x| 越大」；只当粗糙度统计（跨行比较无意义）。
      const rows = new Map<number, Box[]>();
      for (const box of item.boxes) {
        if (box.hero) continue;
        const key = Math.round(centerY(box) / 6);
        rows.set(key, [...(rows.get(key) ?? []), box]);
      }
      for (const row of rows.values()) {
        const sorted = [...row].sort((a, b) => Math.abs(a.index - hero) - Math.abs(b.index - hero));
        for (let i = 1; i < sorted.length; i += 1) {
          if (Math.abs(centerX(sorted[i]!)) + 0.5 < Math.abs(centerX(sorted[i - 1]!))) {
            roughness.push(`${item.where} 行内乱序："${sorted[i]!.text}"`);
          }
        }
      }
    }
    console.log(
      `[cadenza] 阅读顺序断言：越轴 ${out.length} 个；行内 |x| 乱序（只记录）${roughness.length} 个`,
    );
    expect(out.length, out.slice(0, 12).join('\n')).toBe(0);
  });

  it('低于应用最小窗口的舞台（640×400）：真机到不了，只记录', () => {
    const cases = buildCases(LINES, TINY_STAGES);
    const bandOut: string[] = [];
    const overlapOut: string[] = [];
    const fonts = new Set<string>();
    for (const item of cases) {
      fonts.add(`${item.stage.w}x${item.stage.h}:${item.plan.fontPx.toFixed(1)}`);
      for (const box of item.boxes) {
        if (box.hero) continue;
        const reach = Math.abs(centerY(box)) + (box.bottom - box.top) / 2;
        if (reach > item.band + 1) bandOut.push(`${item.where} reach=${reach.toFixed(1)} band=${item.band.toFixed(1)}`);
      }
      for (let i = 1; i < item.boxes.length; i += 1) {
        for (let j = 0; j < i; j += 1) {
          const area = overlapArea(item.boxes[i]!, item.boxes[j]!);
          if (area >= 1) overlapOut.push(`${item.where} 重叠 ${area.toFixed(1)}px²`);
        }
      }
    }
    console.log(
      `[cadenza] 不可达舞台（640×400）${cases.length} 组：越带（第十三轮参考值）${bandOut.length} 组，重叠 ${overlapOut.length} 组；` +
        `字号档 ${[...fonts].join(' ')}` +
        (overlapOut.length > 0 ? `\n[cadenza][tiny-overlap] ${overlapOut.slice(0, 8).join('\n[cadenza][tiny-overlap] ')}` : ''),
    );
  });

  it('打印图 4 / 图 5 那两句的实际数值', () => {
    for (const text of ['うまめなく掴んない', '見えて手探りでな探い壁すよ', KANA.slice(0, 24)]) {
      for (const [w, h] of [
        [1478, 965],
        [800, 500],
      ] as const) {
        const plan = layout(makeLine(text, 0), w, h, 1, 1, false);
        const boxes = domBoxes(plan);
        const reach = Math.max(
          ...boxes.filter((box) => !box.hero).map((box) => Math.abs(centerY(box)) + (box.bottom - box.top) / 2),
          0,
        );
        console.log(
          `[cadenza] "${text}" @ ${w}x${h} font=${plan.fontPx.toFixed(1)} hero=${plan.heroIndex}` +
            `(${plan.words[plan.heroIndex]?.placement.fontPx.toFixed(1)}px) band=${Math.min(h * BAND_RATIO, BAND_MAX_PX).toFixed(1)}` +
            ` 词最大 |y|+h/2=${reach.toFixed(1)} spread=${(Math.max(...boxes.map((b) => b.right)) - Math.min(...boxes.map((b) => b.left))).toFixed(0)}`,
        );
        console.log(
          `[cadenza] 词中心 y=[${boxes.map((b) => (b.hero ? 'H' : centerY(b).toFixed(0))).join(',')}]` +
            ` x=[${boxes.map((b) => centerX(b).toFixed(0)).join(',')}]`,
        );
      }
    }
  });
});
