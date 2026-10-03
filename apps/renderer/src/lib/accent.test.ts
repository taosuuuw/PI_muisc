/**
 * 应用主题色的换算（用户第二十一轮第 5 条）。
 *
 * `lib/accent.ts` 里全是纯函数，所以这里直接盯住三件事：
 * ① 十六进制解析的宽容度（`#rgb` / `#rrggbb` / 不带 `#` 都认，半截输入老实返回 null）；
 * ② 明暗两档的取色方向（亮档悬停要更深、暗档要更亮——和仓库里那套暗档 token 同向）；
 * ③ **主色底上的字得看得见**：`onPrimary` 与 `primary` 的 WCAG 对比度必须 ≥ 4.5，
 *    这一条是这一个功能最容易出的事故（暗档拿近白当主色 + 白字）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCENT_COLOR,
  customAccentTokens,
  onPrimaryFor,
  parseHexColor,
  relativeLuminance,
} from './accent';

/** WCAG 对比度（1–21），用来验 `onPrimary` 挑得对不对。 */
function contrast(a: string, b: string): number {
  const la = relativeLuminance(parseHexColor(a) ?? [0, 0, 0]);
  const lb = relativeLuminance(parseHexColor(b) ?? [0, 0, 0]);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('应用主题色换算（用户第二十一轮第 5 条）', () => {
  it('十六进制解析：三/六位、带不带 # 都认；半截输入返回 null', () => {
    expect(parseHexColor('#1f9bff')).toEqual([31, 155, 255]);
    expect(parseHexColor('1f9bff')).toEqual([31, 155, 255]);
    expect(parseHexColor('#F0A')).toEqual([255, 0, 170]);
    expect(parseHexColor('#F0A')).toEqual([255, 0, 170]);
    expect(parseHexColor('  #0d7bd0 ')).toEqual([13, 123, 208]);
    expect(parseHexColor('')).toBeNull();
    expect(parseHexColor('#12')).toBeNull();
    expect(parseHexColor('zzzzzz')).toBeNull();
    expect(parseHexColor('#1234567')).toBeNull();
  });

  it('相对亮度：纯黑 0、纯白 1，天蓝落在中间偏亮', () => {
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    const sky = relativeLuminance([31, 155, 255]);
    expect(sky).toBeGreaterThan(0.2);
    expect(sky).toBeLessThan(0.55);
  });

  it('主色底上的字：亮色配近黑、暗色配白', () => {
    expect(onPrimaryFor([255, 255, 255])).toBe('#14171c');
    expect(onPrimaryFor([255, 212, 0])).toBe('#14171c');
    expect(onPrimaryFor([31, 155, 255])).toBe('#ffffff');
    expect(onPrimaryFor([0, 0, 0])).toBe('#ffffff');
  });

  it('自定义色：亮档悬停更深、暗档更亮，淡底与前景色都跟着给全', () => {
    const light = customAccentTokens('#1f9bff', false);
    expect(light.primary).toBe('#1f9bff');
    expect(relativeLuminance(parseHexColor(light.hover) ?? [0, 0, 0])).toBeLessThan(
      relativeLuminance(parseHexColor(light.primary) ?? [0, 0, 0]),
    );
    expect(relativeLuminance(parseHexColor(light.deep) ?? [0, 0, 0])).toBeLessThan(
      relativeLuminance(parseHexColor(light.hover) ?? [0, 0, 0]),
    );
    expect(light.weak).toBe('rgba(31, 155, 255, 0.12)');
    expect(light.onPrimary).toBe('#ffffff');

    const dark = customAccentTokens('#1f9bff', true);
    expect(relativeLuminance(parseHexColor(dark.hover) ?? [0, 0, 0])).toBeGreaterThan(
      relativeLuminance(parseHexColor(dark.primary) ?? [0, 0, 0]),
    );
    expect(dark.weak).toBe('rgba(31, 155, 255, 0.2)');
    // 自定义色在暗档**不改主色本身**（那是用户挑的颜色），只把悬停 / 深色往亮的方向让开；
    // 主色底上的字照亮度判：天蓝这种中亮色仍然用白字，和改这一版之前一模一样。
    expect(dark.primary).toBe('#1f9bff');
    expect(dark.onPrimary).toBe('#ffffff');
  });

  it('认不出来的颜色：整组退回默认天蓝，不写 NaN', () => {
    for (const bad of ['', '#12', 'nope']) {
      const tokens = customAccentTokens(bad, false);
      expect(tokens).toEqual(customAccentTokens(DEFAULT_ACCENT_COLOR, false));
      for (const value of Object.values(tokens)) {
        expect(value).not.toContain('NaN');
      }
    }
  });

  it('前景色的两条硬约束：近白主色必须配近黑字，其余沿用现状', () => {
    const colors = ['#1f9bff', '#ffd400', '#7b3fe4', '#0d7bd0', '#f5f7fa', '#14171c', '#e91e63'];
    for (const color of colors) {
      for (const dark of [false, true]) {
        const tokens = customAccentTokens(color, dark);
        const primary = parseHexColor(tokens.primary) ?? [0, 0, 0];
        const ratio = contrast(tokens.onPrimary, tokens.primary);
        if (relativeLuminance(primary) >= 0.55) {
          // 亮到发白的主色：绝不能压白字（那就是白底白字），必须翻近黑且对比度够读。
          expect(tokens.onPrimary).toBe('#14171c');
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        } else {
          // 其余沿用这套界面一贯的白字压主色（默认天蓝本来就是 ≈2.9:1，与改动前一致）。
          expect(tokens.onPrimary).toBe('#ffffff');
          expect(ratio).toBeGreaterThan(2.8);
        }
      }
    }
  });
});
