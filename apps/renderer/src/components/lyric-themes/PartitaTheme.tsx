/**
 * 云阶 = `partita`（第十一轮重做排布；第十四轮第 6 条加「行级微调」）。
 *
 * === AGPL 说明 ===
 * 数值借鉴自 folia-major 的 **partita** 歌词主题（AGPL-3.0，`chthollyphile/folia-major@c249bde`），
 * **只取数值与思路**：下面每个表达式都是在本仓库里自己写的，没有拷贝 folia 源码文本。
 *
 * 观感（参考图 = 用户给的图 3 / 图 6 / 图 7）：整句歌词被切成几个 **2~4 个字素的短块**，
 * 短块按阅读顺序**自上而下**排成一条**楼梯**，第 k 块的横向偏移左右交替小幅摆动
 * （`俺は喝 / 常 / に勝 / つ / 圧勝`），每块下沿有细线刻度（竖刻度 + 横基线），
 * 唱到的字亮起、唱过的字落下，副歌那一句外面还有一圈涟漪。
 *
 * **切块与「放得下」的选档仍然全在 `partitaLayout.ts`**（纯函数，可脱离浏览器验证）：
 * 原子化 → 贪心分块 → 逐档缩字号试「横向 ≤ 舞台宽 − 64、纵向 ≤ 舞台高 × 0.8」。
 *
 * 第十四轮第 6 条（用户 m05281，参考图 3 / 图 4）在**这一层**给楼梯加四个行级参数
 * （`partitaLayout.ts` 一个字节都没动，那边算出的 `fontPx` 只是这里的**基准字号**）：
 *  1. **不同行不一样大**：第 i 块的字号 = `基准字号 × clamp(1 + jitter_i, 0.8, 1.2)`，
 *     `jitter_i = (seededFraction(行时间戳 + i × 7919 + 41) − 0.5) × 2 × 0.2`
 *     —— ±20%、确定性、可复现，重渲染 / 每帧都不抖。
 *  2. **当前进度那一块最大**：正在唱的那一块再乘 `1.25 + t × 0.35`（`t` 是同一套
 *     `seededFraction`，∈ [1.25, 1.6]），颜色改成 `--pi-th-accent`，并加两层
 *     `text-shadow` 辉光（半径 / 透明度乘 `glowIntensity`）。
 *     「当前进度落在哪一块」= 第一个 `active` 字素所在的块；没有 active 就退回最后一个
 *     `passed` 字素所在的块；出场行（`active === false`）不亮。
 *  3. **错位用设置里的 px**：第 i 块的横向偏移 = `±幅值_i + 抖动_i`，
 *     幅值 ∈ `[partitaStaggerMin, partitaStaggerMax]`（`seededFraction` 取点），符号按行序
 *     **左右交替**——`min === max` 时就是「幅值完全一样」的整齐楼梯。
 *     原来那套「舞台宽的比例 × motionAmount」不再用于基准偏移；`motionAmount` 仍然缩
 *     逐块抖动（±7px）与旋转（±2.2°），语义不变。
 *  4. **行距收紧**：相邻两行的中心距 = `(两行墨迹半高之和) × 0.88 + 2px`，
 *     墨迹半高 = `字号 × 0.62`（≈ 1.24em 的墨迹高，盖住 CJK 满字面与拉丁降部）。
 *     原来是一律 `最高一块的外接矩形 × 1.15 + 6px`，图 3 里四行是挤在一起的。
 *  5. **引导线开关**：`partitaGuides === false` 时 `__guide` / `__baseline` 直接不渲染。
 *
 * **放得下的兜底**（`buildTunePlan` 的 4 趟迭代）：横向偏移逐个夹到「半预算 − 半宽 − 线外沿」，
 * 所以 `2 × max(|x| + 半宽 + 线外沿) ≤ 舞台宽 − 64` 恒成立；纵向按 `availHeight` 超了就
 * 整体乘一档 `fit`（≤1，下限 0.42）再算。也就是说：**行级放大 / 错位不会把块推出舞台**。
 * 唯一放弃的旧保证是「任意两块的外接矩形不相交」——第 6 条要求的正是「错位变小、行挨近」，
 * 外接矩形必然重叠；实际墨迹之间仍留着 `≥ (0.12em + 2px)` 的纵向间隙（等字号时）。
 *
 * 其余沿用原实现（不动）：
 * - 只有一行（就是当前查看的那一行）+ 一个正在出场的上一行，永远只有一层云阶。
 * - 「副歌」没有元数据，用「同一句原文在整首歌里重复出现」代理（见 `isChorusLine`）。
 * - 三态 / 进出场 / 呼吸浮动全靠 CSS transition / animation（见 `lyric-themes.css`）；
 *   每帧不 setState，随机数只在 `useMemo` 里算一次。
 * - **颜色跟随歌曲**：读 `useLiveThemeColors`（祖先注入的 `--pi-th-*` 优先，palette prop 兜底），
 *   并用 `ensureContrast` 和底色混合保证字仍然清晰；刻度线 / 涟漪用 CSS 侧的
 *   `var(--pi-th-accent, …)` 兜底链。
 * - 字号由 JS 算成 `--pi-partita-font`（px）落到**块元素**上（CSS 只做兜底 clamp）。
 *
 * DOM 契约（冒烟脚本 / `lyric-themes.css` 指着它们，**一个都不能改**）：
 * `data-theme='partita'`、`.pi-lyricpartita__{line,float,rowbox,col,guide,baseline,stack,row,word,translated,ripple}`、
 * `data-guide`（刻度线三态）、`data-word-state`（字素三态）、`[data-lyric-line]`。
 * 本轮只**新增**了块上的 `data-current`（当前进度那一块，给 `lyric-partita-tune.css` 挂辉光用）。
 */

import { Fragment, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { DEFAULT_LYRIC_TUNING } from '@pi/shared';
import {
  HINT_LOOKAHEAD,
  clamp,
  ensureContrast,
  isChorusLine,
  measureTextWidth,
  parseRgb,
  rgba,
  seededFraction,
  useElementFontFamily,
  useFullStageSize,
  useLiveThemeColors,
  tuningOf,
  wordStatesFor,
  type LyricThemeProps,
  type RgbColor,
  type StageLine,
  type WordState,
} from './types';
import { PARTITA_ACTIVE_SCALE, layoutPartitaLine, type PartitaLayoutPlan } from './partitaLayout';
import '../../styles/lyric-partita-tune.css';

/* ------------------------------------------------------------------ *
 * 第十四轮第 6 条的常数（报告里逐个对得上）
 * ------------------------------------------------------------------ */

/** 每一块字号的确定性抖动幅度（±20%）。 */
const PARTITA_ROW_SIZE_SPREAD = 0.2;
/** 抖动后的字号倍率上下限（0.8 / 1.2 = ±20% 夹到边界）。 */
const PARTITA_ROW_SIZE_FLOOR = 0.8;
const PARTITA_ROW_SIZE_CEIL = 1.2;
/** 当前进度那一块的放大区间（用户原话：1.25~1.6 倍）。 */
const PARTITA_CURRENT_FONT_MIN = 1.25;
const PARTITA_CURRENT_FONT_MAX = 1.6;
/** 行距 = (两行墨迹半高之和) × 这个比例 + 间隙。0.88 → 比 1.22 行高紧 ~11%。 */
const PARTITA_TIGHT_STEP_RATIO = 0.88;
const PARTITA_TIGHT_STEP_GAP_PX = 2;
/** 一行字的墨迹半高（em）：0.62 → 墨迹高按 1.24em 估（CJK 满字面 + 拉丁降部）。 */
const PARTITA_INK_HALF_EM = 0.62;
/** 块宽的安全系数（当前字素放大 1.2、逐字抖动 6px、块旋转都在里面）。 */
const PARTITA_BLOCK_WIDTH_PAD = 1.14;
const PARTITA_BLOCK_WIDTH_PAD_EM = 0.1;

/**
 * 与 `partitaLayout.ts` **必须同值**的私有常数（那边没导出，这里各写一份）。
 * 它们只用于「放得下」判定，飘了就会让块贴着 / 爬出舞台边。
 */
const PARTITA_STAGE_PAD_PX = 64;
const PARTITA_HEIGHT_BUDGET_RATIO = 0.8;
const PARTITA_UP_BIAS_RATIO = 0.03;
const PARTITA_GUIDE_OVERHANG_X = 18;
const PARTITA_GUIDE_OVERHANG_Y = 16;
/** 逐块横向抖动（px，乘 motionAmount）：与 `partitaLayout` 的 `PARTITA_BLOCK_JITTER_X` 同值。 */
const PARTITA_BLOCK_JITTER_X = 7;
/** 度量用的字重 / 字距：与 `partitaLayout` 的 `PARTITA_FONT_WEIGHT` / 字距一致。 */
const PARTITA_FONT_WEIGHT = 700;
const PARTITA_LETTER_SPACING_EM = 0;
/** 放得下判定的迭代趟数 / 整体缩放的下限。 */
const PARTITA_FIT_PASSES = 4;
const PARTITA_FIT_FLOOR = 0.42;

/** 辉光：近核 / 远晕的模糊半径（px，再乘 `glowIntensity`）与颜色透明度。 */
const PARTITA_GLOW_CORE_PX = 6;
const PARTITA_GLOW_BLUR_PX = 26;
const PARTITA_GLOW_ALPHA = 0.5;

/**
 * 第十五轮第 4 条（用户本轮原话）：「所有歌词都应该是白色，高亮时才有其他颜色（辉光），
 * 并且颜色是逐渐淡去」。
 *
 * 云阶的**常态字色**就是这支白：`data-current="true"` 那一块继续用强调色 + 辉光，
 * 其余块（以及当前块变成「唱过」之后）一律白。层次不做成灰，靠不透明度分层
 * （字素 0.82 / 未唱 0，见 lyric-themes.css）。
 *
 * 写成 `var(--pi-lyric-ink, #fff)` 而不是 `#fff`，是为了和 classic 共用同一个「常态白」
 * 开关：`--pi-lyric-ink` 定义在 lyric-stage.css 的 `.pi-lyricstage` 上，主题舞台是它的子节点，
 * 所以六套主题的白永远只在一处定义。
 */
const PARTITA_INK = 'var(--pi-lyric-ink, #fff)';

/* ------------------------------------------------------------------ *
 * 行级微调
 * ------------------------------------------------------------------ */

/** 一个台阶（块）最终的落点与字号。 */
interface PartitaRowTune {
  /** 相对舞台中轴的横向偏移（px，正 = 右）。 */
  readonly x: number;
  /** 相对舞台垂直中心的纵向偏移（px，正 = 下）。 */
  readonly y: number;
  /** 这一块的字号（px；已经乘过 `fontScale` 与整体缩放修正）。 */
  readonly fontPx: number;
  /**
   * 这一块的字号**倍率**（`clamp(1 + 抖动, floor, ceil)`；当前进度那一块再乘 `currentScale ∈ [1.25, 1.6]`）。
   * 字号 = `plan.fontPx × mult × fit`，所以 `fontPx / mult` 对所有块都相等——冒烟就用这条恒等式
   * 证明「当前句真的被放大」：只看跨行的绝对字号会被「各行基准不同」骗过去。
   */
  readonly mult: number;
}

interface PartitaTunePlan {
  /** 与 `plan.blocks` 一一对应。 */
  readonly rows: readonly PartitaRowTune[];
  /** 当前块的**纯**放大倍数（∈ [1.25, 1.6]；不含逐块抖动）。冒烟接缝直接读它。 */
  readonly currentScale: number;
  /** `.pi-lyricpartita__rowbox` 的高度 = 整段楼梯的墨迹高。 */
  readonly boxHeight: number;
}

interface PartitaTuneOptions {
  /** 随机种子（用行的 `timeMs`：重渲染不抖、换行才换）。 */
  readonly seed: number;
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly fontFamily: string;
  /** 引导线开关：关掉时线外沿（左右 18px / 下 16px）不再计入预算。 */
  readonly guides: boolean;
  readonly staggerMin: number;
  readonly staggerMax: number;
  /** 动效幅度：只缩逐块抖动（基准偏移改用设置里的 px，不再乘它）。 */
  readonly motionAmount: number;
  /** 当前进度落在第几块（-1 = 没有）。 */
  readonly currentBlock: number;
}

interface PartitaLinePlan extends PartitaLayoutPlan {
  readonly line: StageLine;
}

/** 把一行的字素排成「楼梯」（几何全在纯函数里，这里只补上 `line`）。 */
function buildLinePlan(
  line: StageLine,
  stageWidth: number,
  stageHeight: number,
  fontFamily: string,
  chaotic: boolean,
  fontScale: number,
  motionAmount: number,
): PartitaLinePlan {
  return {
    line,
    ...layoutPartitaLine({
      words: line.words,
      stageWidth,
      stageHeight,
      fontFamily,
      chaotic,
      fontScale,
      motionAmount,
      seed: line.timeMs,
    }),
  };
}

/**
 * 在 `partitaLayout` 的结果上做行级微调：不同行不同字号 + 当前进度块放大 + px 错位 + 收紧行距。
 *
 * 一趟 = 「按当前 fit 算字号 → 算块宽 / 墨迹半高 → 夹横向偏移 → 收紧行距 → 判放得下」；
 * 放不下就整体缩一档 `fit` 再来一趟。横向的夹逼保证了「任何一趟都不会出舞台」，
 * 所以最后一趟的结果一定在预算内（纵向极限时由 `.pi-lyricpartita` 的 `overflow: hidden` 兜底）。
 */
function buildTunePlan(plan: PartitaLayoutPlan, options: PartitaTuneOptions): PartitaTunePlan {
  const blocks = plan.blocks;
  if (blocks.length === 0) return { rows: [], boxHeight: 0, currentScale: 1 };

  const availWidth = Math.max(options.stageWidth - PARTITA_STAGE_PAD_PX, 240);
  const availHalf = availWidth / 2;
  const upBias = options.stageHeight * PARTITA_UP_BIAS_RATIO;
  const availHeight = Math.max(
    options.stageHeight * PARTITA_HEIGHT_BUDGET_RATIO - 2 * upBias,
    120,
  );
  // 线外沿也要算进预算（`partitaLayout` 的 `needWidth` / `needHeight` 同样算它）。
  const overhangX = options.guides ? PARTITA_GUIDE_OVERHANG_X : 4;
  const overhangY = options.guides ? PARTITA_GUIDE_OVERHANG_Y : 0;

  // 设置里的上下界：可能被拖成 min > max，先归一化；再防一手「老设置没有这两个字段」。
  const rawMin = Number.isFinite(options.staggerMin)
    ? options.staggerMin
    : DEFAULT_LYRIC_TUNING.partitaStaggerMin;
  const rawMax = Number.isFinite(options.staggerMax)
    ? options.staggerMax
    : DEFAULT_LYRIC_TUNING.partitaStaggerMax;
  const staggerLo = clamp(Math.min(rawMin, rawMax), 0, 400);
  const staggerHi = clamp(Math.max(rawMin, rawMax), 0, 400);

  /** 当前进度那一块的放大倍数（行内确定，∈ [1.25, 1.6]）。 */
  const currentScale =
    PARTITA_CURRENT_FONT_MIN +
    seededFraction(options.seed + 6131) * (PARTITA_CURRENT_FONT_MAX - PARTITA_CURRENT_FONT_MIN);

  // 每块的确定性字号倍率；当前进度那一块再乘 currentScale（所以它一定是最大的那一块）。
  const multipliers: number[] = [];
  const magnitudes: number[] = [];
  const signs: number[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const jitter = (seededFraction(options.seed + index * 7919 + 41) - 0.5) * 2 * PARTITA_ROW_SIZE_SPREAD;
    multipliers.push(
      clamp(1 + jitter, PARTITA_ROW_SIZE_FLOOR, PARTITA_ROW_SIZE_CEIL) *
        (index === options.currentBlock ? currentScale : 1),
    );
    const t = seededFraction(options.seed + index * 92821 + 7);
    magnitudes.push(staggerLo + (staggerHi - staggerLo) * t);
    // 符号按行序左右交替：幅值完全一样时（min === max）仍然是一条绕中轴的楼梯。
    signs.push(index % 2 === 0 ? -1 : 1);
  }

  let fit = 1;
  let rows: PartitaRowTune[] = [];
  let boxHeight = 0;

  for (let pass = 0; pass < PARTITA_FIT_PASSES; pass += 1) {
    const halfWidths: number[] = [];
    const inkHalves: number[] = [];
    const xs: number[] = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block === undefined) continue;
      const fontPx = Math.max(plan.fontPx * (multipliers[index] ?? 1) * fit, 8);
      const width = measureTextWidth(
        block.text,
        fontPx,
        PARTITA_FONT_WEIGHT,
        options.fontFamily,
        PARTITA_LETTER_SPACING_EM,
      );
      const half = (width / 2) * PARTITA_BLOCK_WIDTH_PAD + fontPx * PARTITA_BLOCK_WIDTH_PAD_EM;
      halfWidths[index] = half;
      inkHalves[index] = fontPx * PARTITA_INK_HALF_EM;
      const jitterX =
        (seededFraction(options.seed + index * 6151 + 29) - 0.5) *
        2 *
        PARTITA_BLOCK_JITTER_X *
        options.motionAmount;
      // 夹到「半预算 − 半宽 − 线外沿」：无论设置把错位拖多大都不会出舞台（窄舞台上会自动缩到贴着中轴）。
      const limit = Math.max(availHalf - half - overhangX, 0);
      xs[index] = clamp((signs[index] ?? 1) * (magnitudes[index] ?? 0) + jitterX, -limit, limit);
    }

    // 纵向：相邻两行按**各自的**墨迹半高收紧（原来一律按「最高的一块」留，小块的缝就白留了）。
    const rawYs: number[] = [];
    let cursor = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      if (index > 0) {
        cursor +=
          ((inkHalves[index - 1] ?? 0) + (inkHalves[index] ?? 0)) * PARTITA_TIGHT_STEP_RATIO +
          PARTITA_TIGHT_STEP_GAP_PX;
      }
      rawYs[index] = cursor;
    }
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < blocks.length; index += 1) {
      top = Math.min(top, (rawYs[index] ?? 0) - (inkHalves[index] ?? 0));
      bottom = Math.max(bottom, (rawYs[index] ?? 0) + (inkHalves[index] ?? 0));
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
      top = 0;
      bottom = 0;
    }
    // 整段先垂直居中、再按参考图略偏上（与 `partitaLayout` 的 upBias 同一个意思）。
    const shift = (top + bottom) / 2 + upBias;
    rows = [];
    for (let index = 0; index < blocks.length; index += 1) {
      rows.push({
        x: xs[index] ?? 0,
        y: (rawYs[index] ?? 0) - shift,
        fontPx: Math.max(plan.fontPx * (multipliers[index] ?? 1) * fit, 8),
        mult: multipliers[index] ?? 1,
      });
    }
    boxHeight = Math.max(bottom - top, 0);

    // 横向在上面已经夹过，这里只可能纵向超（改字号会同时改块宽，所以每趟都重算一次）。
    let needHalfWidth = 0;
    let needHalfHeight = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      needHalfWidth = Math.max(
        needHalfWidth,
        Math.abs(xs[index] ?? 0) + (halfWidths[index] ?? 0) + overhangX,
      );
      needHalfHeight = Math.max(
        needHalfHeight,
        Math.abs(rows[index]?.y ?? 0) + (inkHalves[index] ?? 0) + overhangY,
      );
    }
    const overflow = Math.max((2 * needHalfWidth) / availWidth, (2 * needHalfHeight) / availHeight);
    if (overflow <= 1 || fit <= PARTITA_FIT_FLOOR) break;
    fit = Math.max(fit / overflow, PARTITA_FIT_FLOOR);
  }

  return { rows, boxHeight, currentScale };
}

/**
 * 当前进度落在哪一块（-1 = 不亮）。
 * 先找正在唱的字素；一行唱完（全 passed）就落在最后一块；还没开口 / 出场行就返回 -1。
 */
function currentBlockOf(
  blocks: PartitaLayoutPlan['blocks'],
  states: readonly WordState[] | undefined,
  active: boolean,
): number {
  if (!active || states === undefined) return -1;
  let fallback = -1;
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block === undefined) continue;
    for (const atom of block.atoms) {
      for (const word of atom.words) {
        const state = states[word.index] ?? 'waiting';
        if (state === 'active') return blockIndex;
        if (state === 'passed') fallback = blockIndex;
      }
    }
  }
  return fallback;
}

/** 前景色在底色上看得清就行（云阶的字素颜色统一走这条链）。 */
function readableOn(color: string, surface: RgbColor | null): string {
  const parsed = parseRgb(color);
  if (parsed === null || surface === null) return color;
  return ensureContrast(parsed, surface);
}

interface PartitaLineViewProps {
  readonly plan: PartitaLinePlan;
  readonly tune: PartitaTunePlan;
  /** 当前进度那一块的下标（-1 = 不亮）。 */
  readonly currentBlock: number;
  /** 引导线（十字细线 + 横基线）开关。 */
  readonly guides: boolean;
  /** 辉光强度（0 = 不画），来自设置的 `glowIntensity`。 */
  readonly glowIntensity: number;
  /** 当前歌曲的强调色（`--pi-th-accent` 的解析值）：当前进度那一块用它。 */
  readonly accent: string;
  /** 出场行不逐字判定，整行按「已唱」画。 */
  readonly states: readonly WordState[] | undefined;
  readonly active: boolean;
  readonly phase: 'enter' | 'exit';
  readonly translatedText: string | undefined;
  readonly chorus: boolean;
  readonly chaotic: boolean;
  /** 当前歌曲的底色（palette / `--pi-th-surface` 解析值）：用来保证**强调色**的对比度。 */
  readonly surface: RgbColor | null;
}

function PartitaLineView({
  plan,
  tune,
  currentBlock,
  guides,
  glowIntensity,
  accent,
  states,
  active,
  phase,
  translatedText,
  chorus,
  chaotic,
  surface,
}: PartitaLineViewProps): ReactNode {
  const { line, blocks, fontPx } = plan;
  const floatDistance = line.hint === 'micro' ? 18 : line.hint === 'short' ? 14 : 10;
  const floatDuration = line.hint === 'micro' ? 5.8 : line.hint === 'short' ? 7 : 8.5;
  const lineStyle = {
    '--pi-partita-font': `${fontPx.toFixed(2)}px`,
    '--pi-float-d': `${floatDistance}px`,
    '--pi-float-dur': `${floatDuration}s`,
  } as CSSProperties;
  /**
   * 第十五轮第 8 条（用户本轮原话）：「云阶歌词动效，一句歌词和引导线一起出来，
   * 而不是先有引导线再出现歌词」。
   *
   * 旧写法是**按行**给三态（`active ? 'active' : exiting ? 'passed' : 'waiting'`）：
   * 只要这一行是「当前行」，它内部每一块的引导线就立刻 `scaleY(0) → 1` 画出来，
   * 而块里的字素是按各自的时间戳逐个冒出来的 —— 观感正是「先亮线、后出字」。
   * 现在改成**按块**判：这一块的字素里只要有**任何一个已经不是 waiting**，
   * 引导线才和那个字素同一帧开始入场（走的还是 CSS 里同一条 `0.4s ease-out`）。
   * 出场行（`states === undefined`，字素整行按「已唱」画）仍然整行亮线，行为不变。
   */
  const guideStateOf = (blockIndex: number): 'active' | 'passed' | 'waiting' => {
    const block = blocks[blockIndex];
    if (block === undefined) return 'waiting';
    let entered = false;
    for (const atom of block.atoms) {
      for (const word of atom.words) {
        // 默认值与下面渲染字素那一处**必须一致**（出场行的 `states` 是 undefined，
        // 字素按「已唱」画），否则出场行的引导线会整行消失。
        if ((states?.[word.index] ?? 'passed') !== 'waiting') {
          entered = true;
          break;
        }
      }
      if (entered) break;
    }
    if (!entered) return 'waiting';
    return active ? 'active' : 'passed';
  };
  // 当前进度那一块的辉光：半径 / 透明度都乘 glowIntensity（0 时半径 0px + 全透明 = 不画）。
  const glowVars = {
    '--pi-partita-glow-core': `${(PARTITA_GLOW_CORE_PX * glowIntensity).toFixed(2)}px`,
    '--pi-partita-glow-blur': `${(PARTITA_GLOW_BLUR_PX * glowIntensity).toFixed(2)}px`,
    '--pi-partita-glow-color': rgba(accent, clamp(PARTITA_GLOW_ALPHA * glowIntensity, 0, 0.9)),
  } as CSSProperties;
  const accentOnSurface = readableOn(accent, surface);
  return (
    <div
      className="pi-lyricpartita__line"
      data-lyric-line={line.index}
      data-line-time={line.timeMs}
      data-index={line.index}
      data-active={active}
      data-hint={line.hint}
      data-phase={phase}
      style={lineStyle}
    >
      <div className="pi-lyricpartita__float">
        <div
          className="pi-lyricpartita__rowbox"
          // 行盒子就是「楼梯」的包围盒：块用绝对定位按中心点摆，高度必须由 JS 给出
          // （CSS 侧不再有 flex / min-height，见 lyric-themes.css 的第十一轮注记）。
          style={{
            perspective: `${chaotic ? 720 : 1000}px`,
            height: `${tune.boxHeight.toFixed(2)}px`,
          }}
        >
          {blocks.map((block, blockIndex) => {
            const row = tune.rows[blockIndex];
            const current = blockIndex === currentBlock;
            return (
              <div
                key={`${blockIndex}-${block.text}`}
                className="pi-lyricpartita__col"
                data-current={current}
                // 冒烟接缝（第十五轮）：当前块的**纯放大倍数**（∈ [1.25, 1.6]）。块上的
                // `--pi-partita-mult` 是「抖动 × 这个倍数」，单看它无法把抖动摘掉——
                // run g 采样时当前块读到 1.13，看着像没放大，其实是抖动把 1.25 压下去了。
                data-current-scale={current ? tune.currentScale.toFixed(4) : undefined}
                style={
                  {
                    '--pi-chunk-x': `${(row?.x ?? block.x).toFixed(2)}px`,
                    '--pi-chunk-y': `${(row?.y ?? block.y).toFixed(2)}px`,
                    '--pi-chunk-rot': `${block.rotate.toFixed(2)}deg`,
                    // 行字号写在**块**上：第 6 条要「不同行不一样大」，它盖掉行元素上的基准值，
                    // 块里的每个字素（`font-size: var(--pi-partita-font)`）都跟着这块走。
                    '--pi-partita-font': `${(row?.fontPx ?? fontPx).toFixed(2)}px`,
                    // 冒烟接缝：把这一块的倍率也写出来（`fontPx / mult` 对所有块恒等，
                    // 于是「当前句放大」可被证明，而不必赌「当前块一定比别行绝对字号大」）。
                    '--pi-partita-mult': `${(row?.mult ?? 1).toFixed(4)}`,
                    ...(current ? glowVars : {}),
                  } as CSSProperties
                }
              >
                {guides ? (
                  <span
                    className="pi-lyricpartita__guide"
                    data-guide={guideStateOf(blockIndex)}
                    aria-hidden="true"
                  />
                ) : null}
                {guides ? (
                  <span
                    className="pi-lyricpartita__baseline"
                    data-guide={guideStateOf(blockIndex)}
                    aria-hidden="true"
                  />
                ) : null}
                <span className="pi-lyricpartita__stack">
                  <span className="pi-lyricpartita__row">
                    {block.atoms.map((atom, atomIndex) => (
                      <Fragment key={`${atomIndex}-${atom.text}`}>
                        {/* 原子之间补一个真空格：拉丁 / 西里尔整词一级之后还得读得出词界，
                            宽度与 JS 拟合时用的 ≈0.55em 对齐（见 partitaLayout 的 PARTITA_SPACE_EM）。 */}
                        {atomIndex === 0 ? null : ' '}
                        {atom.words.map((word) => {
                          const state: WordState = states?.[word.index] ?? 'passed';
                          // 第十五轮第 4 条：当前进度那一块用强调色（+辉光），其余块一律**常态白**。
                          // 旧写法是「其余块保持次级色 / 情绪色」，本轮按用户要求统一收成白。
                          const color = current ? accentOnSurface : PARTITA_INK;
                          return (
                            <span
                              key={`${word.index}-${word.text}`}
                              className="pi-lyricstage__word pi-lyricpartita__word"
                              data-word-state={state}
                              style={
                                {
                                  '--pw-color': color,
                                  '--pw-x': `${word.x.toFixed(2)}px`,
                                  '--pw-y': `${word.y.toFixed(2)}px`,
                                  '--pw-rot': `${word.rotate.toFixed(2)}deg`,
                                  '--pw-passed-rot': `${word.passedRotate.toFixed(2)}deg`,
                                  // 字的缩放**不乘块的 transform**：块的 `scale()` 已经去过一遍了，
                                  // 再乘一遍净效果是 `scale²`，字会把块间距压没。
                                  '--pw-scale': '1',
                                  // 与 `partitaLayout.ts` 的 `PARTITA_ACTIVE_SCALE` 必须是同一个值：
                                  // 外接矩形就是按它算「当前字素放大后占多宽」的。
                                  '--pw-active-scale': PARTITA_ACTIVE_SCALE.toFixed(2),
                                  '--pw-wait-x': `${word.waitX.toFixed(2)}px`,
                                  '--pw-wait-y': `${word.waitY.toFixed(2)}px`,
                                  '--pw-wait-rot': `${word.waitRotate.toFixed(2)}deg`,
                                } as CSSProperties
                              }
                            >
                              {word.text}
                            </span>
                          );
                        })}
                      </Fragment>
                    ))}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {translatedText === undefined || translatedText === '' ? null : (
        <div className="pi-lyricpartita__translated">{translatedText}</div>
      )}
      {chorus ? (
        <span
          className="pi-lyricpartita__ripple"
          aria-hidden="true"
          style={
            { '--pi-ripple-scale': (1.5 + (line.index % 7) * 0.3).toFixed(2) } as CSSProperties
          }
        />
      ) : null}
    </div>
  );
}

/**
 * 云阶主题。
 *
 * 只渲染两行：正在看的那一行（`viewIndex`）+ 正在演完出场的上一行（`leavingIndex`）。
 * 这两行的 `[data-lyric-line]` 数量远小于冒烟脚本的 12 行上限。
 */
export function PartitaTheme(props: LyricThemeProps): ReactNode {
  const { lines, translated, activeIndex, viewIndex, leavingIndex, positionMs, theme } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  // 主题根节点铺满整个播放页视口（lyric-themes.css 把 `.pi-lyricstage[data-theme='partita']`
  // 定成 `position:absolute; inset:0`），测不到尺寸时回退视口尺寸。
  const stage = useFullStageSize(rootRef);
  const fontFamily = useElementFontFamily(rootRef);
  const colors = useLiveThemeColors(rootRef, theme);
  const chaotic = theme.animationIntensity === 'chaotic';
  // 设置的动效参数：`fontScale` 进双边拟合（`partitaLayout`），`motionAmount` 缩逐块抖动 / 旋转，
  // `glowIntensity` 缩当前进度那一块的辉光，第 6 条新加的三个字段管引导线 / 错位上下界。
  const {
    fontScale,
    motionAmount,
    glowIntensity,
    partitaGuides,
    partitaStaggerMin,
    partitaStaggerMax,
  } = tuningOf(theme);
  // 引导线默认**开**（与改造前一致）：只有设置里明确是 `false` 才不渲染。
  const guides = partitaGuides !== false;
  const surface = parseRgb(colors.surface);
  const anchor = lines[viewIndex];
  const plan = useMemo(
    () =>
      anchor === undefined
        ? undefined
        : buildLinePlan(
            anchor,
            stage.width,
            stage.height,
            fontFamily,
            chaotic,
            fontScale,
            motionAmount,
          ),
    [anchor, stage.width, stage.height, fontFamily, chaotic, fontScale, motionAmount],
  );
  const states = useMemo(
    () =>
      plan === undefined
        ? undefined
        : wordStatesFor(plan.line, positionMs, HINT_LOOKAHEAD[plan.line.hint]),
    [plan, positionMs],
  );
  const activeLine = activeIndex === viewIndex;
  // 只留一个**整数**当下游依赖：位置每 ~250ms 变一次，但「当前进度落在哪一块」很少变，
  // 所以楼梯不会跟着播放进度每帧重排（重排只在换块那一刻发生）。
  const currentBlock = useMemo(
    () => (plan === undefined ? -1 : currentBlockOf(plan.blocks, states, activeLine)),
    [plan, states, activeLine],
  );
  const tune = useMemo(
    () =>
      plan === undefined
        ? undefined
        : buildTunePlan(plan, {
            seed: plan.line.timeMs,
            stageWidth: stage.width,
            stageHeight: stage.height,
            fontFamily,
            guides,
            staggerMin: partitaStaggerMin,
            staggerMax: partitaStaggerMax,
            motionAmount,
            currentBlock,
          }),
    [
      plan,
      stage.width,
      stage.height,
      fontFamily,
      guides,
      partitaStaggerMin,
      partitaStaggerMax,
      motionAmount,
      currentBlock,
    ],
  );
  const chorus = useMemo(
    () => (anchor === undefined ? false : isChorusLine(lines, anchor.index)),
    [lines, anchor],
  );

  if (plan === undefined || tune === undefined) return null;

  const leaving =
    leavingIndex === null || leavingIndex === undefined || leavingIndex === viewIndex
      ? undefined
      : lines[leavingIndex];
  const leavingPlan =
    leaving === undefined
      ? undefined
      : buildLinePlan(
          leaving,
          stage.width,
          stage.height,
          fontFamily,
          chaotic,
          fontScale,
          motionAmount,
        );
  // 出场行永远不亮（不逐字判定，整行按「已唱」画），所以 currentBlock = -1。
  const leavingTune =
    leavingPlan === undefined
      ? undefined
      : buildTunePlan(leavingPlan, {
          seed: leavingPlan.line.timeMs,
          stageWidth: stage.width,
          stageHeight: stage.height,
          fontFamily,
          guides,
          staggerMin: partitaStaggerMin,
          staggerMax: partitaStaggerMax,
          motionAmount,
          currentBlock: -1,
        });

  // 契约：主题根元素带 `data-theme='partita'`（`LyricStage` 的舞台根也有同名属性；
  // 这里再挂一份，让「主题根」自己就能被定位 / 断言）。
  return (
    <div className="pi-lyricpartita" data-theme="partita" ref={rootRef}>
      {leavingPlan === undefined || leavingTune === undefined ? null : (
        <PartitaLineView
          key={`out-${leavingPlan.line.index}-${leavingPlan.line.timeMs}`}
          plan={leavingPlan}
          tune={leavingTune}
          currentBlock={-1}
          guides={guides}
          glowIntensity={glowIntensity}
          accent={colors.accent}
          states={undefined}
          active={false}
          phase="exit"
          translatedText={undefined}
          chorus={false}
          chaotic={chaotic}
          surface={surface}
        />
      )}
      <PartitaLineView
        key={`in-${plan.line.index}-${plan.line.timeMs}`}
        plan={plan}
        tune={tune}
        currentBlock={currentBlock}
        guides={guides}
        glowIntensity={glowIntensity}
        accent={colors.accent}
        states={states}
        active={activeLine}
        phase="enter"
        translatedText={translated.get(plan.line.timeMs)}
        chorus={chorus}
        chaotic={chaotic}
        surface={surface}
      />
    </div>
  );
}
