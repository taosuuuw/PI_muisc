/**
 * 商籁（sonnet）的**排版角色**：一行字里谁是主角、谁是配角、字重怎么给。
 *
 * === 借鉴的数值（照抄，不是推断）===
 * 来源是 folia 的 `sonnet/sonnetTypographyRoles.ts`（AGPL-3.0，只取数值与做法，代码在本仓库重写）：
 *
 * - 四档角色：`hero`（主角）/ `semi-hero`（次主角）/ `support`（陪衬）/ `decoration`（装饰）。
 * - **字重**：hero 与 semi-hero 给 **900**，decoration 给 **300**，其余 **700** —— 注意不是"越大越重"，
 *   装饰反而是细的（这是原版"杂志排版"味的关键之一）。
 * - 主角评分：`min(可见字数, 8) * 14 + clamp(时长, 0, 2.5) * 18`（字数封顶 8、时长封顶 2.5 秒）。
 * - 次主角的门槛与约束：`MIN_GAP = 2`（离主角至少隔两段）、`MIN_VISIBLE_LENGTH = 2`、
 *   `MIN_LINE_WORDS = 4`（整行词太少就不给次主角）、`SCORE_RATIO = 0.35`（评分至少是主角的 35%）、
 *   `MULTI_WORD_COUNT = 9`（词够多才允许第二个次主角）。
 * - **选位规则**：次主角挑在主角的**对侧**（主角靠前半段就往后挑、反之往前挑），构图才不会一边倒。
 *
 * === 与 folia 的差异（照实记）===
 * folia 的角色挂在"语义段（词）"上。我们**现在两套都在**：
 * - **行级**（`resolveSonnetLineRoles`）：早先的实现，帧层目前仍在用；
 * - **段级**（`resolveSonnetSegmentRoles`，第 63 轮补）：照抄 folia 的流程 ——
 *   先把每行摊成段、**逐行**选出该行自己的主角段与次主角段，再折算成全局下标。
 *   帧层从"按行摆放"切到"按段摆放"时就用这一套（见 `docs/PLAN.md` 第 63 轮）。
 */

export interface SonnetTypographyLine {
  readonly text: string;
  readonly durationMs?: number | undefined;
  /**
   * 是不是**实词**（标点 / 空白 / 零碎段为 false）。
   *
   * 上游主角评选明确要这一条：`if (!segment.isWordLike || 可见字数 === 0) return;`
   * （`sonnetTypographyRoles.ts` 的 `findSonnetHeroSegmentIndex`）。我们原先没有这个字段、
   * 帧层也没传，于是标点/空白段也能当主角、再被放大 5.5 倍 ⇒ 画面上孤零零一个巨字。
   * **可选**：老调用与既有用例不传它时按"没限制"处理（只有显式 `false` 才排除）。
   */
  readonly isWordLike?: boolean | undefined;
}

/** 段（词）与行的形状一样，只是粒度不同 —— folia 那边是 `SonnetSemanticSegment`。 */
export type SonnetTypographySegment = SonnetTypographyLine;

export type SonnetSegmentRole = 'hero' | 'semi-hero' | 'support' | 'decoration';

/** 主角与次主角都算"强调"。 */
export function isSonnetEmphasisRole(role: SonnetSegmentRole): boolean {
  return role === 'hero' || role === 'semi-hero';
}

/** 设计好的字重档：强调 900、装饰 300、其余 700。 */
export const SONNET_ROLE_WEIGHT = {
  hero: 900,
  'semi-hero': 900,
  support: 700,
  decoration: 300,
} as const satisfies Record<SonnetSegmentRole, number>;

export function resolveSonnetRoleWeight(role: SonnetSegmentRole): number {
  return SONNET_ROLE_WEIGHT[role];
}

/** 次主角的门槛（照抄）。 */
export const SONNET_SEMI_HERO_MIN_GAP = 2;
export const SONNET_SEMI_HERO_MIN_VISIBLE_LENGTH = 2;
export const SONNET_SEMI_HERO_MIN_LINE_WORDS = 4;
export const SONNET_SEMI_HERO_SCORE_RATIO = 0.35;
export const SONNET_SEMI_HERO_MULTI_WORD_COUNT = 9;

/** 可见字数：空白不算（我们这里按"去掉空格后的字数"算）。 */
export function sonnetVisibleLength(line: SonnetTypographyLine): number {
  return [...line.text].filter((char) => char.trim().length > 0).length;
}

/** 主角评分：字数（封顶 8）与时长（封顶 2.5 秒）各占一份权重。 */
export function scoreSonnetHeroLine(line: SonnetTypographyLine): number {
  const length = Math.min(sonnetVisibleLength(line), 8) * 14;
  const seconds = (line.durationMs ?? 0) / 1000;
  const duration = Math.min(2.5, Math.max(0, seconds)) * 18;
  return length + duration;
}

/**
 * 选**全 shot 的主片段**（原版 `findSonnetHeroSegmentIndex`）：在给定的一串片段里取评分最高者；
 * 同分取靠前的。
 *
 * 为什么它和下面的 `findSonnetHeroLineIndex` 是**两个不同的数**、两个都要：
 * · **角色**（谁能放大、谁吃强调色）是**逐行**选的（`resolveSonnetLineRoles` /
 *   `resolveSonnetSegmentRoles`，每行各有一个主角，原版也是这样）；
 * · **主构图锚点**（流程图版里 `heroIndex` 那一格，以及它"从画面下方 15% 升起"的入场）
 *   用的是**整个 shot 拉平之后评分最高的那个实词片段**（原版 `segments = lines.flat()` 之后
 *   调的就是这个函数）。我们早先拿 `heroIndices[0]`（首行的主角）当锚点，长词在后面那一行时，
 *   从下方升起、被当构图中心的就是首行那个小词。
 *
 * 全都没有合格片段时退回**第一个实词片段**、再退回第 0 个（`findIndex(isWordLike)` 的兜底）。
 */
export function findSonnetHeroSegmentIndex(
  segments: readonly SonnetTypographySegment[],
): number {
  const firstWordLike = segments.findIndex((segment) => segment.isWordLike === true);
  let bestIndex = firstWordLike >= 0 ? firstWordLike : 0;
  let bestScore = -Infinity;
  segments.forEach((segment, index) => {
    /* 照上游那行：非实词、或没有可见字，都不参与主角评选。 */
    if (segment.isWordLike === false) return;
    if (sonnetVisibleLength(segment) === 0) return;
    const score = scoreSonnetHeroLine(segment);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return Math.max(0, bestIndex);
}

/**
 * 选主角**行**：与 `findSonnetHeroSegmentIndex` 同一套判据（上游对"行"与"片段"用的是同一个
 * `findSonnetHeroSegmentIndex`；这里保留行级这个名字给既有调用方，实现委托过去，避免两份逻辑漂移）。
 */
export function findSonnetHeroLineIndex(lines: readonly SonnetTypographyLine[]): number {
  return findSonnetHeroSegmentIndex(lines);
}

/**
 * 给一组行分配角色：一行主角、最多两次主角，其余按"是否需要强调"分陪衬与装饰。
 *
 * 我们从简的地方与 folia 一致：**选定主角之后，主角两侧的落点由它的位置决定**（见选位规则）。
 */
export function resolveSonnetLineRoles(
  lines: readonly SonnetTypographyLine[],
  heroOverride?: number,
): SonnetSegmentRole[] {
  const roles: SonnetSegmentRole[] = lines.map(() => 'support');
  if (lines.length === 0) return roles;

  const heroIndexRaw = heroOverride ?? findSonnetHeroLineIndex(lines);
  /*
   * ⚠ **主角必须有"可见字"**（本轮；主人："有些字太大了十分别扭"）。
   *
   * 上游选主角时会跳过非实词与非可见段（`.folia-ref/…TypographyLayout.ts:164` 那行判据）；
   * 而这里原先**只给次主角设了可见长度门槛**（下面那行 `>= SONNET_SEMI_HERO_MIN_VISIBLE_LENGTH`），
   * **主角自己没有任何门槛** ⇒ 空白段 / 纯标点段也能被选成主角，再乘 5.5 倍（重字镜头那一档）
   * 就变成画面上一个孤零零的巨字 —— 正是主人截图里那几块大字母。
   * 这里补上门槛：选中项没有可见字时，退回**第一个有可见字的段**。
   */
  let heroIndex = heroIndexRaw;
  const heroLine = lines[heroIndexRaw];
  if (heroLine === undefined || sonnetVisibleLength(heroLine) === 0) {
    const fallback = lines.findIndex((line) => sonnetVisibleLength(line) > 0);
    if (fallback >= 0) heroIndex = fallback;
  }
  roles[heroIndex] = 'hero';

  const wordLikeCount = lines.filter((line) => sonnetVisibleLength(line) > 0).length;
  if (wordLikeCount < SONNET_SEMI_HERO_MIN_LINE_WORDS) return roles;

  const hero = lines[heroIndex];
  if (hero === undefined) return roles;
  const threshold = scoreSonnetHeroLine(hero) * SONNET_SEMI_HERO_SCORE_RATIO;
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line, index }) =>
        index !== heroIndex &&
        sonnetVisibleLength(line) >= SONNET_SEMI_HERO_MIN_VISIBLE_LENGTH &&
        Math.abs(index - heroIndex) >= SONNET_SEMI_HERO_MIN_GAP &&
        scoreSonnetHeroLine(line) >= threshold,
    );
  if (candidates.length === 0) return roles;

  const bestOf = (list: typeof candidates): number | null => {
    let bestIndex: number | null = null;
    let bestScore = -Infinity;
    for (const item of list) {
      const score = scoreSonnetHeroLine(item.line);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = item.index;
      }
    }
    return bestIndex;
  };

  // 主角靠前半段就往后挑，反之往前挑 —— 次主角落在**对侧**，构图才平衡。
  const heroLeansEarly = heroIndex <= (lines.length - 1) / 2;
  const primarySide = candidates.filter(({ index }) =>
    heroLeansEarly ? index > heroIndex : index < heroIndex,
  );
  const secondarySide = candidates.filter(({ index }) =>
    heroLeansEarly ? index < heroIndex : index > heroIndex,
  );

  const primary = bestOf(primarySide) ?? bestOf(secondarySide);
  if (primary === null) return roles;
  roles[primary] = 'semi-hero';

  if (wordLikeCount >= SONNET_SEMI_HERO_MULTI_WORD_COUNT) {
    const secondary = bestOf(
      secondarySide.filter(({ index }) => Math.abs(index - primary) >= SONNET_SEMI_HERO_MIN_GAP),
    );
    if (secondary !== null) roles[secondary] = 'semi-hero';
  }
  return roles;
}

/**
 * **段级角色**：照抄 folia `resolveSonnetTypographyLayout` 开头那一段的流程。
 *
 * 原版的做法容易看漏：主角**不是全曲一个**，而是**每一行各选一个**（`lines.forEach` 里逐行
 * `findSonnetHeroSegmentIndex(lineSegs)`），次主角同样在"这一行内部"选、并且相对于**这一行自己的主角**。
 * 折成全局下标之后，同一行里的某个词就能单独被放大 —— 这正是我们早先缺的那层。
 *
 * 返回的 `roles` 与"把每行摊平后的段序列"一一对应；`heroIndices` / `semiHeroIndices` 是全局下标，
 * 便于帧层直接判断"这一段的角色是不是主角"。
 */
export function resolveSonnetSegmentRoles(
  lines: readonly (readonly SonnetTypographySegment[])[],
): {
  readonly roles: readonly SonnetSegmentRole[];
  readonly heroIndices: readonly number[];
  readonly semiHeroIndices: readonly number[];
} {
  const roles: SonnetSegmentRole[] = [];
  const heroIndices: number[] = [];
  const semiHeroIndices: number[] = [];
  let offset = 0;
  for (const line of lines) {
    const local = resolveSonnetLineRoles(line);
    heroIndices.push(offset + Math.max(0, local.indexOf('hero')));
    local.forEach((role, index) => {
      roles.push(role);
      if (role === 'semi-hero') semiHeroIndices.push(offset + index);
    });
    offset += line.length;
  }
  return { roles, heroIndices, semiHeroIndices };
}

/** 一行的**可见字数**（段序列版本）：`sonnetVisibleLength` 的批量形式。 */
export function sonnetSegmentsVisibleLength(segments: readonly SonnetTypographySegment[]): number {
  return segments.reduce((sum, segment) => sum + sonnetVisibleLength(segment), 0);
}
