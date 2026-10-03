/**
 * 云阶（partita）的**纯几何布局**——「楼梯」排布（第十一轮，用户 m03279 第 4 条）。
 *
 * 参考图（folia partita 的截图）长这样：一整句歌词被切成几个 **2~4 个字素的短块**，
 * 短块按阅读顺序**自上而下**排成一条楼梯，第 k 块的横向偏移左右交替
 * （`俺は喝 / 常 / に勝 / つ / 圧勝`），每块下沿有细线刻度，块与块**完全不重叠**。
 *
 * 这里只做三件事，全部是纯函数（除了 `measureTextWidth` 的 canvas 度量）：
 *  1. **切块**：按 word 边界把 `line.words` 合成「原子」（CJK 一字素一个原子，拉丁 / 西里尔
 *     一个词一个原子），再把原子按阅读顺序贪心分成 1~4 块（每块 1~4 个字素）。
 *  2. **楼梯**：块中心横向 = 节奏比例 × 舞台宽 × motionAmount（+ 确定性抖动），
 *     纵向 = 序号 × 步进，整段先居中、再按参考图略偏上。
 *  3. **自查**：算出每块的**外接矩形**（把「当前字素放大 1.2 倍」「逐字素抖动 / 旋转」
 *     「块自身旋转」「刻度线外沿」都算进去），并给出整条楼梯的包围盒。
 *
 * 保证（`PartitaTheme` 的渲染与算法自查都依赖这三条）：
 *  - `blocks[i].y` 随 `i` 严格递增，且**任意两块的外接矩形不相交**（见 `stepY` 的推导）；
 *  - `needWidth <= availWidth` 且 `needHeight <= availHeight` 时，所有矩形（含刻度线外沿）
 *    都落在舞台内、不会被 `.pi-lyricpartita { overflow: hidden }` 裁掉；
 *  - 放不下时按 `PARTITA_FONT_SHRINK_STEP` 逐档缩字号（下限 `PARTITA_FONT_MIN_PX`），
 *    同时把块数往下调，取第一组「两个方向都放得下」的解。
 */

import {
  clamp,
  makeRandom,
  measureTextWidth,
  seededFraction,
  usesWordSpaces,
  type StageWord,
} from './types';

// ---------------------------------------------------------------------------
// 常数（报告里逐个对得上）
// ---------------------------------------------------------------------------

/** 字重：与 CSS `.pi-lyricpartita__word { font-weight: 700 }` 一致。 */
const PARTITA_FONT_WEIGHT = 700;
/** 字距：CSS 没有设 `letter-spacing`。 */
const PARTITA_LETTER_SPACING_EM = 0;

/** 舞台横向预留（两侧总共 64px；与原实现一致）。 */
const PARTITA_STAGE_PAD_PX = 64;
/** 楼梯总高不得超过舞台高的这个比例（任务书第 4 条）。 */
const PARTITA_HEIGHT_BUDGET_RATIO = 0.8;
/** 整条楼梯相对舞台中心再上移舞台高的这个比例（参考图略偏上，且给译文字幕留空）。 */
const PARTITA_STAIR_UP_BIAS_RATIO = 0.03;

/**
 * 基准字号 = `clamp(舞台宽 × 0.072, 40, 120) × fontScale`，逐档 ×0.86，下限 20px。
 *
 * **用户第 6 轮第 2 条**（原话：「图 3 是现在云阶的歌词布置，图 2 是应该实现的歌词布置效果，即不同行
 * 歌词有大有小，但是**占据中间视野而不是缩成一团**」）：0.055 / 上限 72 是第十一轮按当时的参考图定的，
 * 在 1478 宽的窗口上正好被 72 的上限卡住（`0.055 × 1478 = 81 > 72`），于是整条楼梯只有 ~72px 字、
 * 挤在画面中央一小团里。新口径按用户的图 2 反推：那张图里最大的块 ≈ 110px 字（窗口 ≈1500 宽），
 * 所以 `0.072 × 1500 ≈ 108`；上限抬到 120 只对超宽窗口生效。
 *
 * 「放得下」仍然由下面那条逐档缩字号 + 块数扫描兜底：字号起点抬高后，长句会自动退档，不会溢出。
 */
const PARTITA_FONT_SPAN_RATIO = 0.072;
const PARTITA_FONT_SPAN_MIN_PX = 40;
const PARTITA_FONT_SPAN_MAX_PX = 120;
/** 字号逐档缩小的比例（任务书指定：沿用原实现）。 */
export const PARTITA_FONT_SHRINK_STEP = 0.86;
/** 字号下限（任务书指定）。 */
export const PARTITA_FONT_MIN_PX = 20;
/**
 * 字号最多试几档（安全上限，正常用不满）——必须够大到能踩到 20px 下限：
 * 最大基准字号 = `120 × fontScale(≤1.3)` = 156px，`0.86^14 ≈ 0.12` → `156 × 0.12 = 18.7 ≤ 20`，
 * 所以第 15 档就是下限那一档（16 档留了一档余量；第 6 轮把上限从 72 抬到 120 之后，
 * 档数**必须**跟着从 12 抬到 16，否则长句再也退不到 20px 下限）。
 * 之前是 10 档：从 93.6px 只能退到 `93.6 × 0.86^9 = 24.1px`，**根本到不了 20px 下限**，
 * 于是长句在「每块 4 个字素」还放得下的字号档上就被判成放宽档，白留了 4px 的字号。
 */
const PARTITA_FONT_STEPS = 16;
/** `fontScale` 的可信下限：外部传 0 之类也不至于把字号压没。 */
const PARTITA_MIN_FONT_SCALE = 0.8;
/** 原子特别多（长句）时整体再收一档字号。 */
const PARTITA_LONG_LINE_ATOMS = 40;
const PARTITA_LONG_LINE_FONT = 0.8;

/** 每块的**目标**字素数：参考图是 2~3 个字一块，偶尔 1 个字。 */
const PARTITA_ATOMS_PER_BLOCK = 2.2;
/** 一块最多几个字素（任务书：1~4）。 */
const PARTITA_MAX_ATOMS_PER_BLOCK = 4;
/**
 * 抖动时**优先**不超过这个数（参考图里 CJK 一块最多 3 个字）。
 * 结构性上限仍是 4：只有「块数已经少到不够分」时才会出现 4 个字的块。
 */
const PARTITA_PREFERRED_ATOMS_PER_BLOCK = 3;

/** 横向节奏（舞台宽的比例，左负右正，左右交替）——取自参考图。 */
const PARTITA_STAIR_RATIOS: readonly number[] = [-0.16, 0.06, -0.1, 0.14, -0.02];
/** 每个台阶在节奏之上再叠的确定性抖动（px × motionAmount）。 */
const PARTITA_BLOCK_JITTER_X = 7;
/** 单块最多转多少度（× motionAmount）。 */
const PARTITA_BLOCK_ROT_DEG = 2.2;

/** 纵向步进 = 最高的一块 × 这个比例（任务书：块高 × 1.15）。 */
const PARTITA_STEP_RATIO = 1.15;
/** 再额外留的块间空隙（px）：矩形不相交之外还要有视觉呼吸。 */
const PARTITA_BLOCK_GAP_PX = 6;

/** 块内逐字素的静止抖动 / 旋转（× motionAmount）。 */
const PARTITA_WORD_JITTER_X = 6;
const PARTITA_WORD_JITTER_Y = 4;
const PARTITA_WORD_ROT_CALM_DEG = 0.8;
const PARTITA_WORD_ROT_CHAOTIC_DEG = 2;
/** 多字素「词」的抖动系数：词要读得出来，不能抖散。 */
const PARTITA_WORD_SCATTER = 0.5;
/** 单字素还要为「字素自身旋转」在矩形外留的余量（em，× motionAmount）。 */
const PARTITA_WORD_ROT_PAD_EM = 0.06;

/**
 * 当前字素的放大倍数。
 * **必须与 CSS `.pi-lyricpartita__word[data-word-state='active']` 的 `--pw-active-scale` 一致**，
 * 否则算出来的矩形会比真实占位小。组件把同一个常数写成内联 CSS 变量。
 */
export const PARTITA_ACTIVE_SCALE = 1.2;
/** 行高估算：CSS `line-height: 1.22` + 一点余量（量不到真实字形高，宁可留白）。 */
const PARTITA_ROW_HEIGHT_RATIO = 1.3;
/** 刻度线外沿：`__guide` 往下 16px（`height: 32px; bottom: -16px`）。 */
const PARTITA_GUIDE_OVERHANG_Y = 16;
/** 刻度线外沿：`__baseline` 左右各 18px（`left: -18px; width: calc(100% + 36px)`）。 */
const PARTITA_GUIDE_OVERHANG_X = 18;
/** 空格宽度（em）：与 `estimateTextWidth` 的非 CJK 系数一致。 */
const PARTITA_SPACE_EM = 0.55;
/** 不超过这个字素数的「词」整词一个原子（正常的英文 / 西里尔词都在这个范围内）。 */
const PARTITA_MAX_WORD_GRAPHEMES = 16;
/** 超过上面那条的超长 token（URL / 无空格长串）切成这么长的几块，免得一块就比舞台还宽。 */
const PARTITA_LONG_TOKEN_CHUNK = 8;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一个字素的随机落点（种子只跟「行时间戳 + 它在 line.words 里的下标」有关，换块数也不抖）。 */
export interface PartitaWordPlan {
  /** 在 `line.words` 里的下标：`wordStatesFor` 给的三态按这个下标取。 */
  readonly index: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly rotate: number;
  readonly passedRotate: number;
  readonly waitX: number;
  readonly waitY: number;
  readonly waitRotate: number;
}

/** 块内的一个「原子」：一个 CJK 字素，或一个整词（词内字素横排，不拆词）。 */
export interface PartitaAtomPlan {
  readonly words: readonly PartitaWordPlan[];
  readonly text: string;
}

/** 一个「台阶」：1~4 个字素横排的短块 + 它在楼梯里的位置 + 外接矩形。 */
export interface PartitaBlockPlan {
  readonly atoms: readonly PartitaAtomPlan[];
  readonly text: string;
  /** 块中心相对「舞台中轴」的横向偏移（px，正 = 右）。 */
  readonly x: number;
  /** 块中心相对「舞台垂直中心」的纵向偏移（px，正 = 下）。 */
  readonly y: number;
  readonly rotate: number;
  /** 外接矩形宽（含逐字抖动 / 当前态放大 / 旋转 / 刻度线**不算**，刻度线在 need* 里）。 */
  readonly rectWidth: number;
  /** 外接矩形高（同上）。 */
  readonly rectHeight: number;
}

export interface PartitaLayoutPlan {
  readonly fontPx: number;
  readonly blocks: readonly PartitaBlockPlan[];
  /** 相邻两块的纵向步进（px）。 */
  readonly stepY: number;
  /** `.pi-lyricpartita__rowbox` 的高度 = 楼梯实际高（不含刻度线外沿）。 */
  readonly boxHeight: number;
  /** 放进舞台的两个判定量（含刻度线外沿、已含「略偏上」的偏移）。 */
  readonly needWidth: number;
  readonly needHeight: number;
  /** 本次拟合用的预算：`needWidth <= availWidth && needHeight <= availHeight` 即放得下。 */
  readonly availWidth: number;
  readonly availHeight: number;
}

export interface PartitaLayoutOptions {
  readonly words: readonly StageWord[];
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly fontFamily: string;
  readonly chaotic: boolean;
  readonly fontScale: number;
  readonly motionAmount: number;
  /** 随机种子（用 `line.timeMs`：重渲染不抖、换行才抖）。 */
  readonly seed: number;
  /** 度量函数（默认走 canvas 的 `measureTextWidth`）；测试里可换成桩字体。 */
  readonly measure?: (text: string, fontPx: number) => number;
}

// ---------------------------------------------------------------------------
// 切块
// ---------------------------------------------------------------------------

interface PartitaAtomSource {
  readonly entries: readonly { readonly index: number; readonly text: string }[];
  readonly text: string;
}

const graphemesOf = (text: string): string[] => Array.from(text);

/**
 * 把 `line.words` 合成原子。
 *
 * 舞台把歌词切成字素，**空格自己也是一个 `StageWord`**，所以按空格分组就能还原词边界：
 * - 空格 → 分组边界（不渲染，只用来断词）；
 * - 组内多字素且是「用空格分词的语言」（拉丁 / 西里尔）→ **整组一个原子**（词内字素横排）；
 * - 否则（CJK / 假名 / 泰文：没有词间空格）→ **一字符一个原子**。
 *
 * 例外：超过 `PARTITA_MAX_WORD_GRAPHEMES` 个字符的「词」（URL、无空格长串）按
 * `PARTITA_LONG_TOKEN_CHUNK` 切成几块——这不是「拆词」而是**防溢出的安全阀**：
 * 一个原子宽过舞台时，再小的字号也放不下。
 */
function buildAtoms(words: readonly StageWord[]): PartitaAtomSource[] {
  const atoms: PartitaAtomSource[] = [];
  let buffer: { index: number; text: string }[] = [];
  let bufferText = '';

  const flush = (): void => {
    if (buffer.length === 0) return;
    const entries = buffer;
    const text = bufferText;
    buffer = [];
    bufferText = '';
    if (entries.length > 1 && usesWordSpaces(text)) {
      if (graphemesOf(text).length <= PARTITA_MAX_WORD_GRAPHEMES) {
        atoms.push({ entries, text });
        return;
      }
      for (let start = 0; start < entries.length; start += PARTITA_LONG_TOKEN_CHUNK) {
        const slice = entries.slice(start, start + PARTITA_LONG_TOKEN_CHUNK);
        atoms.push({ entries: slice, text: slice.map((entry) => entry.text).join('') });
      }
      return;
    }
    for (const entry of entries) {
      atoms.push({ entries: [entry], text: entry.text });
    }
  };

  words.forEach((word, index) => {
    if (word.text.trim() === '') {
      flush();
      return;
    }
    // 逐字时间戳（yrc）那条路径上词与词之间**没有**空格字素，只有 `wordStart` 标记；
    // 少了这一步整行英文会被收进一个原子，渲染成 `havetokeephinding`（第十四轮第 6 条复查）。
    if (word.wordStart === true && buffer.length > 0) flush();
    buffer.push({ index, text: word.text });
    bufferText += word.text;
  });
  flush();
  return atoms;
}

/**
 * 把 `total` 个原子按阅读顺序切成 `count` 块，返回每块的原子数（和 == `total`）。
 *
 * 从「平均 + 余数」出发，再做一遍**有界的**确定性抖动：在相邻两块之间挪 1 个原子
 * （只有两边都还落在 `1..PARTITA_MAX_ATOMS_PER_BLOCK` 时才挪）。
 * 于是「参考图里每块长短不一」是结构性保证，而**每块 1~4 个字素**也是——
 * 不会像「最后一块吃掉剩余」那样冒出 5 个字的块。
 *
 * 注意：`count < ceil(total / 4)` 时首轮就已经超过 4 个字素（这是 `layoutPartitaLine`
 * 的**放宽档**，只在「遵守 1~4 字素就无论多小的字号都放不下」时才走到）。
 */
function partitionAtoms(total: number, count: number, seed: number): number[] {
  const base = Math.floor(total / count);
  const extra = total - base * count;
  const sizes: number[] = [];
  for (let block = 0; block < count; block += 1) {
    sizes.push(base + (block < extra ? 1 : 0));
  }
  for (let block = 0; block + 1 < count; block += 1) {
    const current = sizes[block] ?? 1;
    const next = sizes[block + 1] ?? 1;
    const forward = seededFraction(seed + block * 131 + 104729) < 0.5;
    // 两个分支都要同时守住两端：给出去的那边 ≥1、接过来的那边 ≤4。
    // 只判「接收方 < 4」是不够的——会把 `next` 减成 0，造出一个**空台阶**（楼梯上一个洞）。
    if (forward && current < PARTITA_PREFERRED_ATOMS_PER_BLOCK && next > 1) {
      sizes[block] = current + 1;
      sizes[block + 1] = next - 1;
    } else if (!forward && current > 1 && next < PARTITA_PREFERRED_ATOMS_PER_BLOCK) {
      sizes[block] = current - 1;
      sizes[block + 1] = next + 1;
    }
  }
  return sizes;
}

// ---------------------------------------------------------------------------
// 字素落点
// ---------------------------------------------------------------------------

/** 一个字素的静止 / 出场目标值（`scatter` 把多字素词抖得轻一点）。 */
function planWord(
  entry: { readonly index: number; readonly text: string },
  seed: number,
  chaotic: boolean,
  scatter: number,
  motionAmount: number,
): PartitaWordPlan {
  const rand = makeRandom(seed);
  const rotBase = chaotic ? PARTITA_WORD_ROT_CHAOTIC_DEG : PARTITA_WORD_ROT_CALM_DEG;
  const x = (rand() - 0.5) * 2 * PARTITA_WORD_JITTER_X * scatter * motionAmount;
  const y = (rand() - 0.5) * 2 * PARTITA_WORD_JITTER_Y * scatter * motionAmount;
  const rotate = (rand() - 0.5) * 2 * rotBase * scatter * motionAmount;
  const passedSign = rand() < 0.5 ? -1 : 1;
  return {
    index: entry.index,
    text: entry.text,
    x,
    y,
    rotate,
    passedRotate: rotate + passedSign * 12 * scatter,
    // 未唱到时「飞出画面」：以配置点为圆心按 sin/cos 甩出去（folia 的 waiting 目标值）。
    waitX: x + Math.sin(y) * 100 * scatter,
    waitY: y + Math.cos(x) * 50 * scatter,
    waitRotate: rotate + 20 * scatter,
  };
}

// ---------------------------------------------------------------------------
// 楼梯
// ---------------------------------------------------------------------------

interface CandidateContext {
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly fontPx: number;
  readonly seed: number;
  readonly chaotic: boolean;
  readonly motionAmount: number;
  readonly upBias: number;
  readonly measure: (text: string, fontPx: number) => number;
}

/** 给定「字号 + 块数」算一版楼梯（不做任何放得下判定，判定在 `layoutPartitaLine` 里）。 */
function buildCandidate(
  atoms: readonly PartitaAtomSource[],
  count: number,
  ctx: CandidateContext,
): PartitaLayoutPlan {
  const { fontPx, measure, motionAmount, chaotic } = ctx;
  const sizes = partitionAtoms(atoms.length, count, ctx.seed);
  const wordJitterX = PARTITA_WORD_JITTER_X * motionAmount;
  const wordJitterY = PARTITA_WORD_JITTER_Y * motionAmount;
  const blockJitterX = PARTITA_BLOCK_JITTER_X * motionAmount;
  const rotAmp = PARTITA_BLOCK_ROT_DEG * motionAmount;
  const wordRotPad = PARTITA_WORD_ROT_PAD_EM * fontPx * motionAmount;
  const rowHeight = fontPx * PARTITA_ROW_HEIGHT_RATIO;

  interface Draft {
    readonly block: PartitaBlockPlan;
    readonly baseWidth: number;
    readonly baseHeight: number;
  }
  const drafts: Draft[] = [];
  let cursor = 0;

  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index] ?? 1;
    const planAtoms: PartitaAtomPlan[] = [];
    let text = '';
    let contentWidth = 0;
    let widestAtom = 0;
    for (let offset = 0; offset < size; offset += 1) {
      const atom = atoms[cursor + offset];
      if (atom === undefined) continue;
      const atomWidth = measure(atom.text, fontPx);
      if (planAtoms.length > 0) {
        // 词与词之间的空格：DOM 里也是同一个文本节点，宽度按同一个 ≈0.55em 算。
        contentWidth += PARTITA_SPACE_EM * fontPx;
      }
      contentWidth += atomWidth;
      widestAtom = Math.max(widestAtom, atomWidth);
      text += (planAtoms.length > 0 ? ' ' : '') + atom.text;
      planAtoms.push({
        text: atom.text,
        words: atom.entries.map((entry) =>
          planWord(
            entry,
            ctx.seed + entry.index * 131 + 7,
            chaotic,
            atom.entries.length > 1 ? PARTITA_WORD_SCATTER : 1,
            motionAmount,
          ),
        ),
      });
    }
    cursor += size;

    const ratio = PARTITA_STAIR_RATIOS[index % PARTITA_STAIR_RATIOS.length] ?? 0;
    const jitterX = (seededFraction(ctx.seed + index * 7919 + 13) - 0.5) * 2 * blockJitterX;
    const x = ratio * ctx.stageWidth * motionAmount + jitterX;
    const rotate = (seededFraction(ctx.seed + index * 6151 + 29) - 0.5) * 2 * rotAmp;

    // 「当前字素放大 1.2 倍」往外伸的量（缩放是绕字素自身中心做的）。
    const activePad = ((PARTITA_ACTIVE_SCALE - 1) * widestAtom) / 2;
    const baseWidth = contentWidth + 2 * activePad + 2 * wordJitterX + 2 * wordRotPad;
    const baseHeight = PARTITA_ACTIVE_SCALE * rowHeight + 2 * wordJitterY + 2 * wordRotPad;
    drafts.push({
      baseWidth,
      baseHeight,
      block: {
        atoms: planAtoms,
        text,
        x,
        y: 0,
        rotate,
        rectWidth: 0,
        rectHeight: 0,
      },
    });
  }

  // 步进：最高的一块（最宽的那块转得最狠 → 外接矩形最高）× 1.15 + 6px。
  const rid = Math.abs((Math.PI * rotAmp) / 180);
  const cosr = Math.cos(rid);
  const sinr = Math.sin(rid);
  const tallest =
    Math.max(...drafts.map((draft) => draft.baseWidth), 1) * sinr +
    Math.max(...drafts.map((draft) => draft.baseHeight), 1) * cosr;
  const stepY = tallest * PARTITA_STEP_RATIO + PARTITA_BLOCK_GAP_PX;

  // 先把每个台阶按「序号 × 步进」摆好，再整段垂直居中、再上移 `upBias`。
  const raw: { y: number; rectWidth: number; rectHeight: number }[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    if (draft === undefined) continue;
    const rad = Math.abs((Math.PI * draft.block.rotate) / 180);
    const rectWidth = draft.baseWidth * Math.cos(rad) + draft.baseHeight * Math.sin(rad);
    const rectHeight = draft.baseWidth * Math.sin(rad) + draft.baseHeight * Math.cos(rad);
    raw.push({ y: index * stepY, rectWidth, rectHeight });
  }
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const item of raw) {
    top = Math.min(top, item.y - item.rectHeight / 2);
    bottom = Math.max(bottom, item.y + item.rectHeight / 2);
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
    top = 0;
    bottom = 0;
  }
  const centre = (top + bottom) / 2;
  const shift = centre + ctx.upBias;

  const blocks: PartitaBlockPlan[] = [];
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let high = Number.POSITIVE_INFINITY;
  let low = Number.NEGATIVE_INFINITY;
  drafts.forEach((draft, index) => {
    const item = raw[index];
    if (item === undefined) return;
    const y = item.y - shift;
    blocks.push({
      ...draft.block,
      y,
      rectWidth: item.rectWidth,
      rectHeight: item.rectHeight,
    });
    left = Math.min(left, draft.block.x - item.rectWidth / 2);
    right = Math.max(right, draft.block.x + item.rectWidth / 2);
    high = Math.min(high, y - item.rectHeight / 2);
    low = Math.max(low, y + item.rectHeight / 2);
  });
  if (blocks.length === 0) {
    left = 0;
    right = 0;
    high = 0;
    low = 0;
  }
  // 刻度线还往外伸：`__baseline` 左右各 18px、`__guide` 往下 16px。判定要把它们算上，
  // 否则「矩形不相交 + 在预算内」成立了，线却会贴着（甚至爬出）舞台边。
  const needWidth =
    2 *
    Math.max(Math.abs(left) + PARTITA_GUIDE_OVERHANG_X, Math.abs(right) + PARTITA_GUIDE_OVERHANG_X);
  const needHeight = 2 * Math.max(Math.abs(high), Math.abs(low + PARTITA_GUIDE_OVERHANG_Y));
  return {
    fontPx,
    blocks,
    stepY,
    boxHeight: Math.max(low - high, 0),
    needWidth,
    needHeight,
    availWidth: Number.POSITIVE_INFINITY,
    availHeight: Number.POSITIVE_INFINITY,
  };
}

/**
 * 拟合一行楼梯：字号从大到小（`×0.86` 一档，下限 20px）、每档字号里块数从多到少，
 * 取第一组「横向不超 `舞台宽 − 64`、纵向不超 `舞台高 × 0.8`」的解。
 *
 * 块数越少 → 每块越宽（横向更容易放不下）；块数越多 → 台阶越多（纵向更容易放不下），
 * 所以两个方向都要试。优先级：
 * 1. 每块 1~4 个字素（`count >= minBlocks`）且放得下 —— 正常歌词都走这条；
 * 2. 放得下优先：允许一块超过 4 个字素（只在长句 + 小舞台、字号已经缩到 20px 时才走），
 *    取「字号最大」的那一版；
 * 3. 连放得下都做不到 → 「溢出最少」的那一版，由 CSS 的 `overflow: hidden` 兜底。
 */
export function layoutPartitaLine(options: PartitaLayoutOptions): PartitaLayoutPlan {
  const { stageWidth, stageHeight, fontFamily, chaotic, seed } = options;
  const motionAmount = clamp(options.motionAmount, 0.4, 1.6);
  const fontScale = Math.max(options.fontScale, PARTITA_MIN_FONT_SCALE);
  const measure =
    options.measure ??
    ((text: string, fontPx: number): number =>
      measureTextWidth(text, fontPx, PARTITA_FONT_WEIGHT, fontFamily, PARTITA_LETTER_SPACING_EM));

  const atoms = buildAtoms(options.words);
  const availWidth = Math.max(stageWidth - PARTITA_STAGE_PAD_PX, 240);
  const upBias = stageHeight * PARTITA_STAIR_UP_BIAS_RATIO;
  const availHeight = Math.max(stageHeight * PARTITA_HEIGHT_BUDGET_RATIO - 2 * upBias, 120);

  const baseFont =
    clamp(
      stageWidth * PARTITA_FONT_SPAN_RATIO,
      PARTITA_FONT_SPAN_MIN_PX,
      PARTITA_FONT_SPAN_MAX_PX,
    ) *
    fontScale *
    (atoms.length > PARTITA_LONG_LINE_ATOMS ? PARTITA_LONG_LINE_FONT : 1);

  if (atoms.length === 0) {
    return {
      fontPx: baseFont,
      blocks: [],
      stepY: 0,
      boxHeight: 0,
      needWidth: 0,
      needHeight: 0,
      availWidth,
      availHeight,
    };
  }

  // 块数随行长度自适应（**不**钉死在 4）：常规目标 2~3 个字素一块，
  // `minBlocks` 是「每块 ≤ 4 个字素」时至少需要的块数，用于区分首选解与放宽档。
  const desiredBlocks = clamp(Math.ceil(atoms.length / PARTITA_ATOMS_PER_BLOCK), 1, atoms.length);
  const minBlocks = clamp(Math.ceil(atoms.length / PARTITA_MAX_ATOMS_PER_BLOCK), 1, atoms.length);
  const surfaceOf = (plan: PartitaLayoutPlan): PartitaLayoutPlan => ({
    ...plan,
    availWidth,
    availHeight,
  });

  let relaxed: PartitaLayoutPlan | undefined;
  let best: PartitaLayoutPlan | undefined;
  let bestOverflow = Number.POSITIVE_INFINITY;
  for (let step = 0; step < PARTITA_FONT_STEPS; step += 1) {
    const fontPx = Math.max(baseFont * PARTITA_FONT_SHRINK_STEP ** step, PARTITA_FONT_MIN_PX);
    // 字号从大到小扫；同一档字号里块数从多到少扫（块多 = 每块短 = 更接近参考图）。
    for (let count = desiredBlocks; count >= 1; count -= 1) {
      const plan = surfaceOf(
        buildCandidate(atoms, count, {
          stageWidth,
          stageHeight,
          fontPx,
          seed,
          chaotic,
          motionAmount,
          upBias,
          measure,
        }),
      );
      const overflow = Math.max(plan.needWidth / availWidth, plan.needHeight / availHeight);
      if (overflow <= 1) {
        // 首选解：整段放得下 **且** 每块 1~4 个字素。
        if (count >= minBlocks) return plan;
        // 放宽档：只有「每块 ≤ 4 个字素」无论多小的字号都放不下时才会走到。
        // 字号是从大到小扫的，第一个放宽解就是字号最大的那个；记下来继续往小字号找首选解。
        if (relaxed === undefined) relaxed = plan;
        break;
      }
      if (overflow < bestOverflow) {
        bestOverflow = overflow;
        best = plan;
      }
    }
    if (fontPx <= PARTITA_FONT_MIN_PX) break;
  }
  // 极端长句 / 小舞台：宁可一块多放几个字，也不让台阶爬出舞台
  //（用户把「必须整体放得下」排在「1~4 个字素」前面）。
  if (relaxed !== undefined) return relaxed;
  if (best !== undefined) return best;
  // 理论上到不了这里（`atoms.length > 0` 时 count = 1 一定能算出一版）。
  return surfaceOf(
    buildCandidate(atoms, 1, {
      stageWidth,
      stageHeight,
      fontPx: PARTITA_FONT_MIN_PX,
      seed,
      chaotic,
      motionAmount,
      upBias,
      measure,
    }),
  );
}

// ---------------------------------------------------------------------------
// 自查（开发期用；正式渲染不需要）
// ---------------------------------------------------------------------------

/** 两个矩形（中心 + 宽高）是否相交（共边不算相交）。 */
export function partitaRectsOverlap(a: PartitaBlockPlan, b: PartitaBlockPlan): boolean {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  const halfW = (a.rectWidth + b.rectWidth) / 2;
  const halfH = (a.rectHeight + b.rectHeight) / 2;
  // 用严格小于：留 0 说明正好相切，也算「不相交」。
  return dx < halfW && dy < halfH;
}

/** 返回第一对相交的块下标；全部不相交返回 `null`。 */
export function partitaFirstOverlap(
  blocks: readonly PartitaBlockPlan[],
): readonly [number, number] | null {
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i];
      const b = blocks[j];
      if (a === undefined || b === undefined) continue;
      if (partitaRectsOverlap(a, b)) return [i, j];
    }
  }
  return null;
}
