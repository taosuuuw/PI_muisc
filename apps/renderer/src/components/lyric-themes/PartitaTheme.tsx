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
 * `data-guide`（刻度线三态：`waiting` / `active` / `passed`）、
 * `data-word-state`（字素三态）、`[data-lyric-line]`。
 * 本轮只**新增**了块上的 `data-current`（当前进度那一块，给 `lyric-partita-tune.css` 挂辉光用）
 * 与 `data-block-index`（第 7 轮加：冒烟要靠一个稳定抓手逐块追「刻度线宽度有没有变」）。
 *
 * === 用户第 7 轮第 2 条 ===
 * 原话：「云阶动效是，**先出引导线**，同一页的引导线**不会放大缩小而是保持出现的位置和大小**，
 * 歌词沿着引导线出现。」后半段主人当天改成「**线和第一个字一起出现**」，所以**时序一个字没动**：
 * 门控仍是第 8 轮那套**按块**的（块内任一字素离开 `waiting`，这一块自己的线才入场，与它同帧）。
 *
 * 这一轮真正改的是前半段：**线不再随高光放大缩小**。刻度线（竖刻度 + 横基线）的宽度原来来自
 * 块元素的宽度，而当前块的字号会被放大 1.25~1.6 倍（第十四轮第 6 条）⇒ 线跟着一起被撑大，
 * 高光一路往前挪，肉眼就是「同一页的线不停放大缩小」。现在线宽只按**布局字号**（不含
 * `currentScale`）算一次，写成块上的 `--pi-partita-guide-w`（见 `PartitaRowTune.guideWidth`），
 * 于是「线出现时多大，之后就一直多大」——放大只发生在字上，线是那条不动的标尺。
 */

import { Fragment, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { DEFAULT_LYRIC_TUNING } from '@pi/shared';
import {
  clamp,
  ensureContrast,
  isChorusLine,
  measureTextWidth,
  parseRgb,
  rgba,
  seededFraction,
  isWideCodePoint,
  useElementFontFamily,
  useFullStageSize,
  useLiveThemeColors,
  tuningOf,
  wordStatesFor,
  type LyricThemeProps,
  type RgbColor,
  type StageLine,
  type StageWord,
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
/**
 * 行距 = (两行墨迹半高之和) × 这个比例 + 间隙。
 *
 * **用户第 6 轮第 2 条**（原话：「不同行歌词有大有小，但是**占据中间视野而不是缩成一团**」）：
 * 0.88 是第十四轮第 6 条按当时那张参考图定的「行距收紧」，`0.88 × (0.62em × 2) = 1.09em`
 * **比一个字面还小** ⇒ 相邻两块的外接框本身就叠着，整条楼梯看上去挤成一团（用户图 3 的样子）。
 * 改成 1.0：墨迹框正好相切，真实字形（≈1em 高）之间留出 ≈0.24em 的可见缝 —— 与用户给的图 2
 * 量到的步距对得上（图 2 里块心距 ≈ 140px、字号 ≈ 110px ⇒ 1.27em，其中 1.24em 来自本式、4px 来自间隙）。
 */
const PARTITA_TIGHT_STEP_RATIO = 1.0;
const PARTITA_TIGHT_STEP_GAP_PX = 4;
/**
 * **用户第 6 轮第 2 条**：真实几何下楼梯允许占到的**预算比例**（两轴各按它算「还能长多大」）。
 *
 * `buildTunePlan` 先按 `fit = 1` 量一次真实半外延，再用
 * `min(预算高 / 实高, 预算宽 / 实宽) × PARTITA_FILL_RATIO` 当起始 `fit`。
 * 取 0.92 是给「迭代里那几条不随字号缩放的小量（4px 间隙、刻度线外沿）」留余量：
 * 真实渲染的墨迹高 ≈ 预算的 0.72 × 0.8 ≈ 舞台高的 0.58（用户图 2 量到 ≈0.55）✔。
 */
const PARTITA_FILL_RATIO = 0.92;
/** 上面那个放大的安全阀：最多把 `partitaLayout` 挑的字号放大到 1.8 倍。 */
const PARTITA_FONT_GROW_MAX = 1.8;
/** 一行字的墨迹半高（em）：0.62 → 墨迹高按 1.24em 估（CJK 满字面 + 拉丁降部）。 */
const PARTITA_INK_HALF_EM = 0.62;
/**
 * 一行的**行高**（必须与 `lyric-themes.css` 里 `.pi-lyricpartita__word` 的 `line-height: 1.22`
 * 同值）：第 8 轮用它把块元素的盒子高度也**冻在布局字号上**（见 `PartitaRowTune.guideHeight`）。
 */
const PARTITA_LINE_HEIGHT = 1.22;
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
export interface PartitaRowTune {
  /** 相对舞台中轴的横向偏移（px，正 = 右）。 */
  readonly x: number;
  /** 相对舞台垂直中心的纵向偏移（px，正 = 下）。 */
  readonly y: number;
  /** 这一块的字号（px；已经乘过 `fontScale` 与整体缩放修正）。 */
  readonly fontPx: number;
  /**
   * 这一块的字号**倍率**（`clamp(1 + 抖动, floor, ceil)`，只含逐块抖动）。
   * 字号 = `plan.fontPx × mult × fit`，所以 `fontPx / mult` 对所有块都相等——冒烟就用这条恒等式
   * 证明「各块字号确实不一样」。
   *
   * **用户本轮第 1 条**之后它**不再**含 `currentScale`：那个「当前进度最大的那一块再乘
   * 1.25~1.6」的放大已经从块的字号挪到**正在唱的那一个字**的 `--pw-active-scale` 上
   *（见 `PartitaLineView`），否则一块里的 2~4 个字会一起挂着放大、要等整块（短句就是整行）
   * 唱完才恢复。
   */
  readonly mult: number;
  /**
   * **用户第 7 轮第 2 条**：这一块的**刻度线宽度**（px，竖刻度与横基线都按它定位）。
   *
   * 只按**布局字号**（`plan.fontPx × 抖动 × fit`，**不含**任何「当前」放大）量一次
   * ⇒ 唱到哪一块、放大落在哪一个字上，线都不动。
   * 写法与 `measureAt` 里那个「块的半宽」同源（同样的字重 / 字距 / 两个安全系数），
   * 所以线的两端正好落在块「按布局排版」时的左右边界上。
   */
  readonly guideWidth: number;
  /**
   * **用户第 8 轮第 1 条**（原话：「新的引导线的出现不应改把原有的引导线挤开……我希望的是每个引导线
   * 出现之前就划好了位置不会互相挤兑」）：这一块的**刻度线所在盒子的高度**（px，同样只按布局字号算）。
   *
   * 第 7 轮只冻了宽度，位置还是被动的：刻度线挂在块元素的下边缘（`bottom: -16px`），而块元素的高度
   * 是**被字撑开的**（行高 1.22 × 当前字号）⇒ 高光往前挪一块，刚失去高光的那一块字号缩回去、
   * 它的刻度线就跟着往上窜一截，看上去正是「最上面那条线和它的歌词被往上挤了」。
   * 现在宽高都写死成布局尺寸（`--pi-partita-guide-w/-h`），字放大时**只是字溢出盒子**，
   * 线从出现到离场一动不动。
   */
  readonly guideHeight: number;
}

/**
 * 行级微调的结果。**导出只为单测**（`PartitaTheme.test.ts` 直接钉「位置提前划定、与唱到哪一块无关」）。
 */
export interface PartitaTunePlan {
  /** 与 `plan.blocks` 一一对应。 */
  readonly rows: readonly PartitaRowTune[];
  /**
   * 当前进度那一块的**纯**放大倍数（∈ [1.25, 1.6]；不含逐块抖动）。冒烟接缝直接读它
   * （块上的 `data-current-scale`），**用户本轮第 1 条**之后它不再进块的字号，
   * 而是乘在那个正在唱的字自己的 `--pw-active-scale` 上。
   */
  readonly currentScale: number;
  /** `.pi-lyricpartita__rowbox` 的高度 = 整段楼梯的墨迹高。 */
  readonly boxHeight: number;
}

export interface PartitaTuneOptions {
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
 *
 * **用户第 5 轮第 3 条**（原话：「同一面的不同引导线的歌词应该提前划好位置，而不是后出现的歌词
 * 干扰到已经出现的歌词」）：**位置（每块的 x / y / 楼梯盒高）提前划好，与「现在高亮哪一块」无关。**
 *
 * 旧写法把 `currentScale`（1.25~1.6）直接乘进 `multipliers` 再拿去算墨迹半高，而行距是
 * 「相邻两块墨迹半高之和 × 0.88」逐块累加的 ⇒ **高亮每往前挪一块，整段楼梯的纵向间距就跟着变一次**，
 * 于是已经出现的那几块被后来居上的那一块**推着挪位**（0.42s 的 transform 过渡，肉眼就是「被挤走」）。
 * 现在分两套倍率：
 *   · `baseMults`（只含逐块抖动）= **布局**用：行距、横向夹逼、盒高；
 *   · `renderedMult` = `baseMults`（**用户本轮第 1 条**：连渲染字号也不再吃 `currentScale`，
 *     那个放大挪到正在唱的那一个字自己的 `--pw-active-scale` 上）。
 * 高亮换块时**任何**块的字号都不再变，位置与字号都提前定死。
 *
 * 代价与兜底：正在唱的那一个字最高会到 `1.2 × currentScale`（≈ 1.5~1.9 倍），
 * 因为行距是按基准字号收紧的，它会向四周溢出一点。所以**横向夹逼与「放得下」判定仍按预留字号**
 *（`reservedMult`，含 currentScale）来算 —— 保证「无论哪一个字被高亮」都不会顶出舞台，
 * 而**行距**保持基准的紧度。
 */
export function buildTunePlan(
  plan: PartitaLayoutPlan,
  options: PartitaTuneOptions,
): PartitaTunePlan {
  const blocks = plan.blocks;
  if (blocks.length === 0) return { rows: [], boxHeight: 0, currentScale: 1 };

  const availWidth = Math.max(options.stageWidth - PARTITA_STAGE_PAD_PX, 240);
  const availHalf = availWidth / 2;
  const upBias = options.stageHeight * PARTITA_UP_BIAS_RATIO;
  const availHeight = Math.max(options.stageHeight * PARTITA_HEIGHT_BUDGET_RATIO - 2 * upBias, 120);
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

  // 每块的确定性字号倍率（只含抖动）。**用户本轮第 1 条**之后它不再乘 `currentScale`：
  // 那个「当前进度最大」的放大整段挪到正在唱的那一个字上（见 `renderedMult` 的注释）。
  // **用户第 5 轮第 3 条**：这里分成两套 —— `baseMults`（只含抖动）定**位置**，渲染字号另算。
  const baseMults: number[] = [];
  const magnitudes: number[] = [];
  const signs: number[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const jitter =
      (seededFraction(options.seed + index * 7919 + 41) - 0.5) * 2 * PARTITA_ROW_SIZE_SPREAD;
    baseMults.push(clamp(1 + jitter, PARTITA_ROW_SIZE_FLOOR, PARTITA_ROW_SIZE_CEIL));
    const t = seededFraction(options.seed + index * 92821 + 7);
    magnitudes.push(staggerLo + (staggerHi - staggerLo) * t);
    // 符号按行序左右交替：幅值完全一样时（min === max）仍然是一条绕中轴的楼梯。
    signs.push(index % 2 === 0 ? -1 : 1);
  }
  /**
   * 渲染字号用的倍率。
   *
   * **用户本轮第 1 条**（原话：「不要等一行歌词结束才恢复这一行字的大小，而是单个字唱完就恢复大小」）：
   * 这里**不再**乘 `currentScale`。第十四轮第 6 条那套「当前那一块整块放大 1.25~1.6 倍」是把倍数
   * 乘进**块的渲染字号**里的，于是一块里的 2~4 个字一起挂着放大 —— 字的**大小**要等这一块唱完
   * （最后一块更要等这一行唱完，`currentBlockOf` 原来那条 `passed` 兜底一直把它顶成 current）才恢复。
   * 现在放大跟着**正在唱的那一个字**走：块的渲染字号只吃逐块抖动（「不同行不一样大」仍在），
   * `currentScale` 挪到那个字自己的 `--pw-active-scale` 上（见 `PartitaLineView`）——
   * 它唱完（`active → passed`）就立刻回到常态大小，与同一块里别的字无关。
   *
   * 峰值墨迹没有变大：今天「块 × currentScale」再叠「当前字 × `PARTITA_ACTIVE_SCALE`」，
   * 乘出来就是 `字号 × currentScale × 1.2`；现在只是把这个乘积原封不动地挂在**那一个字**上，
   * 其余块成员退回常态。所以 `measureAt` 里那套「按预留字号判放得下」的余量依然够用。
   */
  const renderedMult = (index: number): number => baseMults[index] ?? 1;
  /** 预留倍率：把「这一块被高亮」这一情形也算进去 —— 横向夹逼与放得下判定按它算。 */
  const reservedMult = (index: number): number => (baseMults[index] ?? 1) * currentScale;

  /**
   * 一趟 = 「按 `fit` 算块宽 / 墨迹半高 → 夹横向 → 收紧行距 → 量两轴的**半**外延」。
   *
   * 抽成函数是因为下面要先按 `fit = 1` 量一次真实几何（见 `PARTITA_FILL_RATIO` 那段注释）。
   */
  const measureAt = (
    fit: number,
  ): { rows: PartitaRowTune[]; boxHeight: number; halfWidth: number; halfHeight: number } => {
    const halfWidths: number[] = [];
    const inkHalves: number[] = [];
    /** 预留墨迹半高（按「这一块被高亮」的字号算）：只喂「放得下」判定，不进行距。 */
    const reservedInkHalves: number[] = [];
    /** **用户第 7/8 轮**：刻度线宽度与盒子高度，都只按布局字号量（见 `PartitaRowTune` 两条注释）。 */
    const guideWidths: number[] = [];
    const layoutFonts: number[] = [];
    const xs: number[] = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block === undefined) continue;
      // 布局字号：**不含**当前放大 —— 位置提前划定，与高亮落在哪一块无关（见函数头注释）。
      const fontPx = Math.max(plan.fontPx * (baseMults[index] ?? 1) * fit, 8);
      layoutFonts[index] = fontPx;
      // 预留字号：含当前放大。块的**宽度**按它量（放大后的块更宽，夹逼要留出位置）。
      const reserveFontPx = Math.max(plan.fontPx * reservedMult(index) * fit, 8);
      const width = measureTextWidth(
        block.text,
        reserveFontPx,
        PARTITA_FONT_WEIGHT,
        options.fontFamily,
        PARTITA_LETTER_SPACING_EM,
      );
      const half =
        (width / 2) * PARTITA_BLOCK_WIDTH_PAD + reserveFontPx * PARTITA_BLOCK_WIDTH_PAD_EM;
      halfWidths[index] = half;
      inkHalves[index] = fontPx * PARTITA_INK_HALF_EM;
      reservedInkHalves[index] = reserveFontPx * PARTITA_INK_HALF_EM;
      // 刻度线：**同一个式子**换成布局字号 ⇒ 线宽与「字还没被放大时块有多宽」完全一致。
      guideWidths[index] =
        measureTextWidth(
          block.text,
          fontPx,
          PARTITA_FONT_WEIGHT,
          options.fontFamily,
          PARTITA_LETTER_SPACING_EM,
        ) *
          PARTITA_BLOCK_WIDTH_PAD +
        fontPx * PARTITA_BLOCK_WIDTH_PAD_EM;
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
    const builtRows: PartitaRowTune[] = [];
    for (let index = 0; index < blocks.length; index += 1) {
      builtRows.push({
        x: xs[index] ?? 0,
        y: (rawYs[index] ?? 0) - shift,
        // 渲染字号才带当前放大：高亮换块时只有这一块的 `--pi-partita-font` 变，位置一动不动。
        fontPx: Math.max(plan.fontPx * renderedMult(index) * fit, 8),
        mult: renderedMult(index),
        // 线宽只跟布局字号走：高亮块的字号怎么变，这条线都是它出现时的那一条。
        guideWidth: Math.max(guideWidths[index] ?? 0, 8),
        // 盒子高度同理（行高 × 布局字号）：刻度线钉在它的下沿，所以「线出现时在哪就一直在哪」。
        guideHeight: Math.max((layoutFonts[index] ?? 0) * PARTITA_LINE_HEIGHT, 8),
      });
    }

    // 横向在上面已经夹过，这里只可能纵向超（改字号会同时改块宽，所以每趟都重算一次）。
    let needHalfWidth = 0;
    let needHalfHeight = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      needHalfWidth = Math.max(
        needHalfWidth,
        Math.abs(xs[index] ?? 0) + (halfWidths[index] ?? 0) + overhangX,
      );
      // 「放得下」的纵向按**预留**墨迹半高算：高亮块放大后仍然在预算内（行距本身还是基准的紧度）。
      needHalfHeight = Math.max(
        needHalfHeight,
        Math.abs(builtRows[index]?.y ?? 0) + (reservedInkHalves[index] ?? 0) + overhangY,
      );
    }
    return {
      rows: builtRows,
      boxHeight: Math.max(bottom - top, 0),
      halfWidth: needHalfWidth,
      halfHeight: needHalfHeight,
    };
  };

  /*
   * **用户第 6 轮第 2 条**（原话：「不同行歌词有大有小，但是**占据中间视野而不是缩成一团**」）。
   *
   * 字号是 `partitaLayout` 挑的，而它的**纵向**模型比真实渲染保守得多：它按「最高的一块 × 1.15 + 6px」
   * 算台阶（≈2.1em），可行距真正由本函数上面那套「相邻墨迹半高之和 × 1.0 + 4px」（≈1.28em）决定；
   * 它还把行高估到 1.3em（CSS 是 1.22）。两处叠起来，它算出的「楼梯总高」大约是真实渲染的 1.6 倍
   * ⇒ 它挑的字号永远只让真实楼梯占掉舞台高的三成上下，屏上就是一团挤在中央的短块（用户图 3）。
   *
   * 补法：先按 `fit = 1` 量一次**真实几何**，算出「还能长大多少」，再从这个 `fit` 起步走下面那条
   * 放得下迭代（真超框时会缩回来）。上限两处：`PARTITA_FONT_GROW_MAX`（安全阀）与
   * 「两轴各留 `1 − PARTITA_FILL_RATIO` 的余量」。
   */
  const probe = measureAt(1);
  let fit = clamp(
    Math.min(
      availHeight / Math.max(2 * probe.halfHeight, 1),
      availWidth / Math.max(2 * probe.halfWidth, 1),
    ) * PARTITA_FILL_RATIO,
    1,
    PARTITA_FONT_GROW_MAX,
  );
  let best = measureAt(fit);
  for (let pass = 0; pass < PARTITA_FIT_PASSES; pass += 1) {
    const overflow = Math.max(
      (2 * best.halfWidth) / availWidth,
      (2 * best.halfHeight) / availHeight,
    );
    if (overflow <= 1 || fit <= PARTITA_FIT_FLOOR) break;
    fit = Math.max(fit / overflow, PARTITA_FIT_FLOOR);
    best = measureAt(fit);
  }

  return { rows: best.rows, boxHeight: best.boxHeight, currentScale };
}

/**
 * 当前进度落在哪一块（-1 = 不亮）：**只有「正唱着一个字」的那一块**才算当前。
 *
 * **用户本轮第 1 条**（原话：「不要等一行歌词结束才恢复这一行字的大小，而是单个字唱完就恢复大小」）：
 * 旧写法在这条循环的末尾留了一个 `fallback` —— 扫完整行、没有任何 `active` 时退回**最后一个
 * `passed` 字素所在的块**。于是最后一块从它第一个字开口一直到**整行唱完**都被顶成「当前」，
 * 整行的字（短句本来就是一块）就一直挂着放大，要等换行才恢复。现在这条兜底整段删掉：
 * 这一块的最后一个字唱完（`active` 挪到下一块）它就立刻失去「当前」，放大跟着回到常态。
 */
function currentBlockOf(
  blocks: PartitaLayoutPlan['blocks'],
  states: readonly WordState[] | undefined,
  active: boolean,
): number {
  if (!active || states === undefined) return -1;
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block === undefined) continue;
    for (const atom of block.atoms) {
      for (const word of atom.words) {
        if ((states[word.index] ?? 'waiting') === 'active') return blockIndex;
      }
    }
  }
  return -1;
}

/**
 * **用户本轮第 1 条**：一个字素的最终放大倍数。
 *
 *   · 正在唱（`active`）⇒ `PARTITA_ACTIVE_SCALE × currentScale` —— 峰值与改造前那颗字**逐位相同**
 *     （改造前是「块字号 × currentScale」再叠「字 × 1.2」）；
 *   · 其余（`waiting` / `passed`）⇒ 只有 `PARTITA_ACTIVE_SCALE` 这一档的**布局**放大，
 *     也就是「唱完立刻回到常态大小」。
 *
 * 导出只为单测（拉丁整词同亮 / 唱完立刻回落这两条都在这里钉）。
 */
export function partitaActiveScaleOf(state: WordState, currentScale: number): number {
  return state === 'active' ? PARTITA_ACTIVE_SCALE * currentScale : PARTITA_ACTIVE_SCALE;
}

/**
 * **用户第 8 轮第 2 条**（原话：「现在高光和辉光时间太短一下子就过去了，应该有一个渐变的动画」）
 * 与第 5/6 轮那条「一次只能有一个字是高光」的**冲突**就在这里解决：
 *
 * 交接时长不能写死。写死 260ms 那种档位在字素时值短的快歌里，一颗字「渐入 + 停留 + 渐出」
 * 的窗口（约 3 倍交接时长）会比字素本身还长，于是两三颗字同时挂在渐隐中的强调色上
 *（实测 380/420ms 时冒烟读到 3 块 ✗）。所以把交接时长**按这个字素自己的时值**算：
 * `hot = clamp(时值 × PARTITA_HOT_RATIO, PARTITA_HOT_MIN_MS, PARTITA_HOT_MAX_MS)`，
 * 并把它同时用作「渐入」「渐出」「渐入前的等待」——三倍 hot ≤ 时值本身就是那条不变式
 * （单测直接钉），于是任一瞬间**至多一颗字**在渐入或渐出 ⇒ 既有渐变、又不破「一次一个高光」。
 *
 * 慢歌（时值 1s 以上）取到上限 340ms，是「看得见的渐变」；快歌自动收到下限 110ms。
 */
const PARTITA_HOT_RATIO = 0.3;
const PARTITA_HOT_MIN_MS = 110;
const PARTITA_HOT_MAX_MS = 340;
/**
 * **松手（渐出）的地板**：480ms。
 *
 * 第十五轮第 4 条那条「颜色是逐渐淡去」的冒烟判据要求**常态色的 color 过渡 ≥ 400ms**
 *（读的是声明值），所以渐出一律不低于这条地板。
 * 松手比「渐入 + 等待」长会造成两颗字同时挂着高光吗？不会：颜色那支走 `ease-out`（前快后慢）
 * —— 出场的字在松手的前一小段里就已经淡到不再算「挂着强调色」，而新一颗字要等
 * `delay`（= 它自己的渐入时长）才开始亮 ⇒ 同一瞬间至多一颗字算高光（冒烟按饱和度逐帧量）。
 * 渐入与等待仍按这一颗字自己的时值算，所以快歌里高光是**跟着字走**的，不会慢半拍。
 */
const PARTITA_HOT_OUT_MIN_MS = 480;

/** 一个时值 `windowMs` 的字素，它的渐入 / 等待各用多久（ms）。导出只为单测。 */
export function partitaHotMsOf(windowMs: number): number {
  return Math.round(clamp(windowMs * PARTITA_HOT_RATIO, PARTITA_HOT_MIN_MS, PARTITA_HOT_MAX_MS));
}

/** 渐出时长：与渐入同时值，但**不低于 `PARTITA_HOT_OUT_MIN_MS`**（理由见那条注释）。 */
export function partitaHotOutMsOf(windowMs: number): number {
  return Math.max(partitaHotMsOf(windowMs), PARTITA_HOT_OUT_MIN_MS);
}

/**
 * **用户本轮第 1 条**（原话：「对于字母组成的单词，高亮是整个单词高亮而不是单词中的单个字母高亮」）。
 *
 * `wordStatesFor` 给的是**字素**级三态（一行里同时只有一个字素是 `active`），而这一条要的是
 * **词**级：一个拉丁 / 西里尔单词的字母要一起亮、一起放大、一起回落。所以把每个词的字素
 * 统一成同一个状态：
 *   · 词内**有任何**字素是 `active` ⇒ 整词 `active`（词的首字母到点就整词亮起来）；
 *   · 否则**全部**已 `passed` ⇒ 整词 `passed`（词尾字母唱完才整词落下 —— 这正是
 *     「单个字唱完就恢复大小」在整词上的口径）；
 *   · 其余（还有字素没开口）⇒ 整词 `waiting`。
 *
 * CJK 一个字素就是一个词 ⇒ 本函数逐位等于输入（「一行上只有一个字可以有高光」对中文不变）；
 * 词边界不依赖 `wordStart` 标记（见 `partitaWordGroupsOf`：普通 LRC 一个标记都没有）。
 *
 * 第 8 轮那条「高光按词给」当时只落在**字色**上（`hotWordIndexesOf`），放大仍跟着字素走 ——
 * 于是英文单词仍然是一颗一颗字母鼓起来。现在三态本身按词合并，字色 / 放大 / 引导线三条一起整词走。
 * 导出只为单测。
 */
/**
 * 把一行字素按**词**分组（返回每组的字素下标）。规则与 `partitaLayout.buildAtoms` 完全一致
 * ——「词」在这里就等于渲染用的那个**原子**：
 *   · 空白字素 = 词界；
 *   · 宽字符（CJK / 假名 / 谚文 / 全角标点）= 一个字素一个词；
 *   · 其余（拉丁 / 西里尔 / 半角标点）= **连续字素聚成一个词**；
 *   · `wordStart` 标记（yrc 逐字时间戳那条路径）也算词界。
 *
 * **用户本轮第 1 条（第二遍）**：上一版只认 `wordStart`，而**普通 LRC 一行一个标记都没有**
 * （逐字时间是均摊的），于是英文单词在渲染里是「一个原子 / 整词一起冒」，三态却还是逐字母算的
 * —— 词首字母可能还在 waiting、词中间的字母已经 active，一个单词一半透明一半亮、放大也各放各的。
 * 现在分组不依赖标记，词级三态 / 高光 / 放大在**两种歌词数据下**都成立。
 */
function partitaWordGroupsOf(words: readonly StageWord[]): readonly (readonly number[])[] {
  const groups: number[][] = [];
  let buffer: number[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    groups.push(buffer);
    buffer = [];
  };
  words.forEach((word, index) => {
    const text = word.text;
    if (text.trim() === '') {
      flush();
      return;
    }
    const wide = Array.from(text).some((char) => isWideCodePoint(char.codePointAt(0) ?? 0));
    if (wide) {
      flush();
      groups.push([index]);
      return;
    }
    if (word.wordStart === true) flush();
    buffer.push(index);
  });
  flush();
  return groups;
}

export function partitaWordStatesOf(
  line: StageLine,
  states: readonly WordState[],
): readonly WordState[] {
  const out = states.slice();
  for (const group of partitaWordGroupsOf(line.words)) {
    if (group.length <= 1) continue;
    let anyActive = false;
    let allPassed = true;
    for (const index of group) {
      const state = states[index] ?? 'waiting';
      if (state === 'active') anyActive = true;
      if (state !== 'passed') allPassed = false;
    }
    const merged: WordState = anyActive ? 'active' : allPassed ? 'passed' : 'waiting';
    for (const index of group) out[index] = merged;
  }
  return out;
}

/**
 * **用户第 8 轮第 1 条**（原话：「对于云阶的歌词动效来说，字母组成的单词要以单词为单位标记高光，
 * 而不是字母」）：高光落在**整个词**上。
 *
 * 「词」的边界来自 `StageWord.wordStart`（只在每个词的**首**字素上为 true，见 `types.ts`）：
 *   · CJK：每个字素自己就是一个词（`wordStart` 恒为 true）⇒ 结果与「只亮一个字」逐位相同
 *     （第 6 轮「一行上就只有一个字可以有高光」那条对中文仍然成立）；
 *   · 拉丁 / 西里尔：一个词有多个字素，只有首字素带 `wordStart` ⇒ 整个词一起亮，
 *     不会出现「一个单词里的字母一个一个亮过去」。
 *
 * 返回 null = 这一帧没有高光（出场行 / 还没开口）；返回的集合最多覆盖**一个词**。
 * 导出只为单测（`PartitaTheme.test.ts` 钉死「拉丁整词同亮、CJK 单字」）。
 */
export function hotWordIndexesOf(
  line: StageLine,
  states: readonly WordState[] | undefined,
  active: boolean,
): ReadonlySet<number> | null {
  if (!active || states === undefined) return null;
  const words = line.words;
  let activeIndex = -1;
  for (let index = 0; index < words.length; index += 1) {
    if ((states[index] ?? 'waiting') === 'active') {
      activeIndex = index;
      break;
    }
  }
  if (activeIndex < 0) return null;
  /*
   * **用户本轮第 1 条（第二遍）**：分组与 `partitaWordStatesOf` 换成同一个 `partitaWordGroupsOf`
   * （不再依赖 `wordStart` 标记）—— 普通 LRC 的英文行同样会整词一起亮。
   * 老写法在「一个标记都没有」时退回「只亮一个字素」，那正是用户看到的「单词里的字母单独高亮」。
   */
  for (const group of partitaWordGroupsOf(line.words)) {
    if (group.includes(activeIndex)) return new Set<number>(group);
  }
  // 兜底（分组对不上，理论上到不了）：只亮这一个字素。
  return new Set<number>([activeIndex]);
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
  /**
   * **用户第 8 轮第 1 条**：这一帧该挂高光的字素集合（`hotWordIndexesOf` 的结果，最多一个词）。
   * `null` = 没有高光。
   */
  readonly hotWords: ReadonlySet<number> | null;
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
  readonly chorus: boolean;
  readonly chaotic: boolean;
  /** 当前歌曲的底色（palette / `--pi-th-surface` 解析值）：用来保证**强调色**的对比度。 */
  readonly surface: RgbColor | null;
}

function PartitaLineView({
  plan,
  tune,
  currentBlock,
  hotWords,
  guides,
  glowIntensity,
  accent,
  states,
  active,
  phase,
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
                /** 第 7 轮：冒烟靠这个稳定抓手逐块追「线的宽度变没变」（不能拿块里的文字当键，会重复）。 */
                data-block-index={blockIndex}
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
                    // **用户第 7 轮第 2 条**：刻度线宽度（只按布局字号算过一次）。
                    // CSS 那边把它当块元素的宽度（`.pi-lyricpartita__col { width: var(...) }`），
                    // 竖刻度与横基线都定位在这个盒子里 ⇒ 高光放大字、线一动不动。
                    '--pi-partita-guide-w': `${(row?.guideWidth ?? 0).toFixed(2)}px`,
                    /**
                     * **用户第 8 轮第 1 条**：块元素的**盒子高度**也冻在布局字号上（行高 × 布局字号）。
                     * 刻度线钉在盒子的下沿，所以「线出现时在哪、之后一直在哪」——字号放大只让字溢出盒子，
                     * 不再把线往上/往下挤。
                     */
                    '--pi-partita-guide-h': `${(row?.guideHeight ?? 0).toFixed(2)}px`,
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
                        {/*
                         * **用户本轮第 1 条**：「云阶中，单词是一个整体，不要把单词中的字母单独做
                         * 放大等处理，而是以单词为单位放大、高光等做动画」。
                         *
                         * 一个 atom 就是**一个词**（CJK 是一个字；拉丁 / 西里尔是整词，见
                         * `partitaLayout.buildAtoms`）。所以这一层容器 = 词容器：
                         *   · `--pw-active-scale`（`partitaActiveScaleOf`）挂在**它**身上 ——
                         *     整词一起缩放，字母间距按比例跟着变大；
                         *   · 字素自己只留「位移 + 旋转」（`--pw-x/y/rot/passed-rot/wait-*`）。
                         * 此前 scale 挂在每个字素上，词内字母各自绕自身中心放大、间距不变 ⇒
                         * 看起来就是「单词里的字母各自放大」（用户看到的那一版）。
                         *
                         * `data-word-state` 与 `states` 同源（`partitaWordStatesOf` 已把同一个词
                         * 的字素合并成同一个状态，所以取词内第一个字素即可）。 */}
                        <span
                          className="pi-lyricpartita__atom"
                          data-word-state={states?.[atom.words[0]?.index ?? -1] ?? 'passed'}
                          style={
                            {
                              '--pw-active-scale': partitaActiveScaleOf(
                                states?.[atom.words[0]?.index ?? -1] ?? 'passed',
                                tune.currentScale,
                              ).toFixed(4),
                            } as CSSProperties
                          }
                        >
                        {atom.words.map((word) => {
                          const state: WordState = states?.[word.index] ?? 'passed';
                          /*
                           * 第十五轮第 4 条：常态一律白，只有高光那一个字有颜色。
                           * **用户第 6 轮第 2 条**（原话：「高光不是一整行消除，而是在一行上就只有一个字
                           * 可以有高光」）：高光的载体从**一整块**收到**一个字素** —— 正在唱的那一个。
                           * **用户第 8 轮第 1 条**（原话：「字母组成的单词要以单词为单位标记高光，
                           * 而不是字母」）：载体再按**词**合并 —— `hotWords` 里带的是整词的字素
                           * （中文仍然只有一个字，拉丁是一个单词的全部字母）。
                           */
                          const hot = hotWords?.has(word.index) === true;
                          const color = hot ? accentOnSurface : PARTITA_INK;
                          /**
                           * 第 8 轮：这一颗字的交接时长（渐入 = 渐出 = 等待 = 它自己的时值 × 0.3）。
                           * 时值取自舞台行里的字素（`line.words[index]` 带逐字时间戳）；
                           * 写在行内变量上 —— 出场行没有逐字时值，那时 CSS 退到固定兜底。
                           */
                          const stageWord = line.words[word.index];
                          const wordWindowMs =
                            stageWord === undefined ? 0 : stageWord.endMs - stageWord.startMs;
                          const hotMs = partitaHotMsOf(wordWindowMs);
                          const hotOutMs = partitaHotOutMsOf(wordWindowMs);
                          return (
                            <span
                              key={`${word.index}-${word.text}`}
                              className="pi-lyricstage__word pi-lyricpartita__word"
                              data-word-state={state}
                              style={
                                {
                                  '--pw-color': color,
                                  // 第 8 轮：交接时长按这一颗字自己的时值算（见 `partitaHotMsOf`）。
                                  '--pi-pw-hot-ms': `${hotMs}ms`,
                                  '--pi-pw-hot-delay': `${hotMs}ms`,
                                  '--pi-pw-hot-out': `${hotOutMs}ms`,
                                  '--pw-x': `${word.x.toFixed(2)}px`,
                                  '--pw-y': `${word.y.toFixed(2)}px`,
                                  '--pw-rot': `${word.rotate.toFixed(2)}deg`,
                                  '--pw-passed-rot': `${word.passedRotate.toFixed(2)}deg`,
                                  // 常态（唱过 / 未唱）的缩放：1 —— 缩放已经整支挪到**词容器**
                                  // `.pi-lyricpartita__atom` 上（**用户本轮第 1 条**：以单词为单位
                                  // 放大），字素这里只剩位移与旋转。
                                  '--pw-scale': '1',
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
                        </span>
                      </Fragment>
                    ))}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
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
  const { lines, activeIndex, viewIndex, leavingIndex, positionMs, theme } = props;
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
        : /*
           * **用户第 6 轮第 2 条**：预读窗口收成 **0**。
           *
           * 原口径用的是 `HINT_LOOKAHEAD[hint]`（30 / 80 / 150ms，「partita 规格」）：下一个字还没到点
           * 就先算 `active` —— 于是**同时会有两个字**是 active（一个字在唱、下一个已经提前亮），
           * 而用户要的是「一行上就只有一个字可以有高光」。窗口收成 0 之后
           * `activeCount = passedCount + 1` 恒成立（见 `wordStatesFor`），全行至多一个字素是 active ⇒
           * 强调色 / 辉光 / 放大这三样同时只落在那一个字上。代价是那个字正好**到点**才亮，
           * 不再提前 30~150ms（用户要的是「唯一」，这条优先）。
           *
           * **用户本轮第 1 条**再把它按**词**合并（`partitaWordStatesOf`）：拉丁 / 西里尔的一个单词
           * 整词同亮同落，CJK 仍是一字素一态。
           */
          partitaWordStatesOf(plan.line, wordStatesFor(plan.line, positionMs, 0)),
    [plan, positionMs],
  );
  const activeLine = activeIndex === viewIndex;
  /**
   * **用户第 8 轮第 1 条**：高光按**词**给（中文一词一字 ⇒ 与第 6 轮逐位相同；拉丁整词一起亮）。
   * 上面 `states` 已经按词合并过了，所以这里对拉丁词是恒等展开 —— 留着这一层是为了让**字色**
   * 的语义独立于「放大」那一路（两处的词边界约定由同一个 `wordStart` 决定）。
   */
  const hotWords = useMemo(
    () => (plan === undefined ? null : hotWordIndexesOf(plan.line, states, activeLine)),
    [plan, states, activeLine],
  );
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
        });

  /*
   * **用户第 6 轮第 2 条**（原话：「以及翻译歌词要在底部进度条部件的上面，和流光的翻译歌词一致的
   * 布置就行」）当时是在本主题里复刻了一层字幕；**用户第 8 轮第 2 条**（原话：「所有的歌词动效的
   * 翻译歌词都设置在进度条部件的上面，并且一次只显示一句」）把这件事收归 `LyricStage`：
   * 六套主题共用同一层 `.pi-lyricstage__sub`（绝对贴底 + 让开进度条），而且只显示一句。
   * 本主题自己那份（译文 + 两句原文预览）整段删掉，`translated` 这个 prop 也不再需要。
   */

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
          hotWords={null}
          guides={guides}
          glowIntensity={glowIntensity}
          accent={colors.accent}
          states={undefined}
          active={false}
          phase="exit"
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
        hotWords={hotWords}
        guides={guides}
        glowIntensity={glowIntensity}
        accent={colors.accent}
        states={states}
        active={activeLine}
        phase="enter"
        chorus={chorus}
        chaotic={chaotic}
        surface={surface}
      />
    </div>
  );
}
