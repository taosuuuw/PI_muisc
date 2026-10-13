/**
 * 商籁（sonnet）**排版角色**的自查：守的是从 folia `sonnetTypographyRoles.ts` 照抄来的那批数值。
 *
 * 最容易被"改顺眼"的就是字重：hero/次主角 900、装饰 **300**、其余 700。
 * 装饰比正文还细这一点看起来反直觉，但正是原版杂志排版味的来源。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_ROLE_WEIGHT,
  SONNET_SEMI_HERO_MIN_LINE_WORDS,
  findSonnetHeroLineIndex,
  findSonnetHeroSegmentIndex,
  isSonnetEmphasisRole,
  resolveSonnetLineRoles,
  resolveSonnetRoleWeight,
  resolveSonnetSegmentRoles,
  scoreSonnetHeroLine,
  sonnetVisibleLength,
} from './sonnetTypography';

/** 只给排版角色需要的那两个字段。 */
function line(text: string, seconds: number): { text: string; durationMs: number } {
  return { text, durationMs: seconds * 1000 };
}

describe('sonnet 排版角色（照抄的数值）', () => {
  it('四档字重：主角与次主角 900、装饰 300、其余 700', () => {
    expect(SONNET_ROLE_WEIGHT.hero).toBe(900);
    expect(SONNET_ROLE_WEIGHT['semi-hero']).toBe(900);
    expect(SONNET_ROLE_WEIGHT.support).toBe(700);
    expect(SONNET_ROLE_WEIGHT.decoration).toBe(300);
    expect(resolveSonnetRoleWeight('decoration')).toBe(300);
    expect(isSonnetEmphasisRole('hero')).toBe(true);
    expect(isSonnetEmphasisRole('semi-hero')).toBe(true);
    expect(isSonnetEmphasisRole('support')).toBe(false);
    expect(isSonnetEmphasisRole('decoration')).toBe(false);
  });

  it('可见字数不含空白', () => {
    expect(sonnetVisibleLength(line('啊 啊 啊', 1))).toBe(3);
    expect(sonnetVisibleLength(line('　全角空格也算', 1))).toBe(6);
  });

  it('主角评分：字数封顶 8、时长封顶 2.5 秒', () => {
    // 8 个字 × 14 = 112；2.5 秒 × 18 = 45 ⇒ 157（再多也不涨）。
    expect(scoreSonnetHeroLine(line('一二三四五六七八', 2.5))).toBeCloseTo(157, 6);
    expect(scoreSonnetHeroLine(line('一二三四五六七八九十十一', 9))).toBeCloseTo(157, 6);
    // 短句按实数走。
    expect(scoreSonnetHeroLine(line('一二', 0.5))).toBeCloseTo(2 * 14 + 0.5 * 18, 6);
  });

  it('主角是评分最高那一行，且全篇只有一个', () => {
    const lines = [line('短句', 0.4), line('这是一句很长的歌词文字', 2.2), line('中等长度的一句', 1.2)];
    const heroIndex = findSonnetHeroLineIndex(lines);
    expect(heroIndex).toBe(1);
    const roles = resolveSonnetLineRoles(lines);
    expect(roles.filter((role) => role === 'hero').length).toBe(1);
    expect(roles[heroIndex]).toBe('hero');
  });

  it('**主构图锚点取全 shot 最高分的实词片段**（段级；与逐行的 `heroIndices` 不是同一个数）', () => {
    /*
     * 上游 `sonnetTypographyLayout.ts:140`：`const heroIndex = findSonnetHeroSegmentIndex(segments)`，
     * 而 `segments = lines.flat()` ⇒ 锚点是**整个 shot** 里评分最高的实词片段。
     * 逐行的 `resolveSonnetSegmentRoles` 则各自每行选一个主角（那是**角色**，不是锚点）。
     * 这份夹具里最高分在**第二行**：首行 `x` 一个字、第二行 12 个字母。
     */
    const segments = [
      { text: 'x', durationMs: 600, isWordLike: true },
      { text: 'abcdefghijkl', durationMs: 3000, isWordLike: true },
      { text: '……', durationMs: 2000, isWordLike: false },
    ];
    expect(findSonnetHeroSegmentIndex(segments)).toBe(1);
    // 非实词 / 没有可见字的一律不参选（上游那行判据）。
    const onlyPunctuation = [
      { text: '。', durationMs: 9999, isWordLike: false },
      { text: '短', durationMs: 0.1, isWordLike: true },
    ];
    expect(findSonnetHeroSegmentIndex(onlyPunctuation)).toBe(1);
    // 同分取靠前；全都不合格时退回第一个实词片段，再退回第 0 个。
    expect(
      findSonnetHeroSegmentIndex([
        { text: '一二', durationMs: 1000, isWordLike: true },
        { text: '三四', durationMs: 1000, isWordLike: true },
      ]),
    ).toBe(0);
    expect(
      findSonnetHeroSegmentIndex([{ text: '', durationMs: 0 }, { text: '甲', durationMs: 0 }]),
    ).toBe(1);
    expect(findSonnetHeroSegmentIndex([])).toBe(0);
    // 与"行级"那个入口同判据（行与段共用同一个上游函数）。
    expect(findSonnetHeroLineIndex(segments)).toBe(findSonnetHeroSegmentIndex(segments));
  });

  it('行数太少（< 4 行可见）时不给次主角', () => {
    const lines = [line('第一句', 1), line('第二句长一点', 1.5), line('第三句', 1)];
    expect(lines.length).toBeLessThan(SONNET_SEMI_HERO_MIN_LINE_WORDS);
    const roles = resolveSonnetLineRoles(lines);
    expect(roles.filter((role) => role === 'semi-hero').length).toBe(0);
  });

  it('次主角挑在主角的对侧（主角靠前就往后挑）', () => {
    const lines = [
      line('开头这一句很长很长很长', 2.4),
      line('中间一句', 0.6),
      line('后面还有一句', 0.8),
      line('再补一句收尾', 0.7),
      line('最后一句也不短', 0.9),
    ];
    const roles = resolveSonnetLineRoles(lines);
    const heroIndex = roles.indexOf('hero');
    // 主角在第 0 行（前半段）⇒ 次主角只能在它后面。
    expect(heroIndex).toBe(0);
    const semiIndex = roles.indexOf('semi-hero');
    if (semiIndex !== -1) expect(semiIndex).toBeGreaterThan(heroIndex);
  });

  it('确定性：同一组行两次分配角色完全一致', () => {
    const lines = [
      line('第一句不算短', 1.1),
      line('第二句', 0.5),
      line('第三句稍微长一点点', 1.4),
      line('第四句', 0.6),
      line('第五句也挺长的', 1.2),
    ];
    expect(resolveSonnetLineRoles(lines)).toEqual(resolveSonnetLineRoles(lines));
  });

  it('空数组不炸', () => {
    expect(resolveSonnetLineRoles([])).toEqual([]);
    expect(findSonnetHeroLineIndex([])).toBe(0);
  });
});

describe('sonnet 排版角色（**段级**，照抄 folia 的逐行流程）', () => {
  /** 把一句拆成词：逗号也自成一段（原版的分段就是"词 + 标点"）。 */
  const segments = (parts: readonly string[], seconds: number) =>
    parts.map((text) => line(text, seconds));

  it('**每一行各选一个主角** —— 不是全曲只有一个（原版 `lines.forEach` 里逐个选）', () => {
    const twoLines = [
      segments(['第一段', '有点长'], 1.2),
      segments(['第二段'], 0.6),
    ];
    const { heroIndices } = resolveSonnetSegmentRoles(twoLines);
    expect(heroIndices).toHaveLength(2);
    // 第一行两个段都在 [0,1] 内、第二行是全局下标 2。
    expect(heroIndices[0]).toBeLessThan(2);
    expect(heroIndices[1]).toBe(2);
  });

  it('角色数组与"摊平后的段"一一对应，且每行恰好一个 hero', () => {
    const lines = [
      segments(['这一行', '有', '三个', '段'], 1.0),
      segments(['第二行', '两个段'], 0.8),
    ];
    const { roles, heroIndices } = resolveSonnetSegmentRoles(lines);
    expect(roles).toHaveLength(6);
    expect(roles.filter((role) => role === 'hero')).toHaveLength(2);
    expect(heroIndices.every((index) => roles[index] === 'hero')).toBe(true);
    // 主角落在**段**上：同一条句子里可以只有某一个词变成主角。
    expect(heroIndices[0]).toBeGreaterThanOrEqual(0);
    expect(heroIndices[0]).toBeLessThanOrEqual(3);
  });

  it('次主角是全局下标、且与**本行主角**至少隔两段', () => {
    // 注意每段至少要 `MIN_VISIBLE_LENGTH = 2` 个可见字，否则连候选都进不去。
    const lines = [
      segments(['甲乙', '乙丙', '丙丁', '丁戊', '戊己', '己庚'], 1.0),
      segments(['庚辛', '辛壬', '壬癸', '癸子', '子丑', '丑寅'], 1.0),
    ];
    const { heroIndices, semiHeroIndices, roles } = resolveSonnetSegmentRoles(lines);
    expect(semiHeroIndices.length).toBeGreaterThan(0);
    for (const semi of semiHeroIndices) {
      expect(roles[semi]).toBe('semi-hero');
      const lineStart = semi < 6 ? 0 : 6;
      expect(semi - heroIndices[semi < 6 ? 0 : 1]!).toBeGreaterThanOrEqual(2);
      expect(lineStart).toBeLessThanOrEqual(semi);
    }
  });

  it('确定性 + 空输入不炸', () => {
    const lines = [segments(['一样长', '的两句'], 0.9), segments(['再来', '一句'], 0.9)];
    expect(resolveSonnetSegmentRoles(lines)).toEqual(resolveSonnetSegmentRoles(lines));
    expect(resolveSonnetSegmentRoles([])).toEqual({ roles: [], heroIndices: [], semiHeroIndices: [] });
  });
});
