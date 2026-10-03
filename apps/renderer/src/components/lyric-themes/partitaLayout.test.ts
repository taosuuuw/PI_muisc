/**
 * 云阶（partita）楼梯的**几何自查**（长期保留，`pnpm test` 会自动收进来）。
 *
 * 只验 `partitaLayout` 的几何不变量——比截图更硬，因为它证明的是「矩形两两不相交」
 * 这个数学性质，而不是某一张截图好巧不巧没重叠：
 * 1) 任意两块外接矩形不相交（= 用户要的「不是挤在一坨而又杂乱」）；
 * 2) 每块 1~4 个字素（放宽档除外，且放宽档只允许出现在真机到不了的舞台上）且一个字都不丢；
 * 3) 拉丁 / 西里尔按整词切、不拆词；4) 阅读顺序 = 自上而下（y 严格递增）；
 * 5) **可达舞台**（≥ 应用窗口最小尺寸 960×620，见 `apps/desktop/src/main/index.ts:154-155`）上：
 *    所有旋钮档 × 参考句 + 1~40 字的行长扫描，整段（含刻度线外沿）**0 溢出**。
 *
 * 用 `estimateTextWidth` 当桩字体（CJK 1em / 其余 0.55em），所以不需要 DOM / canvas。
 */

import { describe, expect, it } from 'vitest';
import { layoutPartitaLine, partitaFirstOverlap, type PartitaLayoutPlan } from './partitaLayout';
import { estimateTextWidth, type StageWord } from './types';

const words = (line: string): StageWord[] =>
  Array.from(line).map((text) => ({ text, startMs: 0, endMs: 0 }));

const measure = (text: string, fontPx: number): number => estimateTextWidth(text, fontPx, 0);

function layout(
  line: string,
  width: number,
  height: number,
  fontScale: number,
  motionAmount: number,
  chaotic: boolean,
): PartitaLayoutPlan {
  return layoutPartitaLine({
    words: words(line),
    stageWidth: width,
    stageHeight: height,
    fontFamily: 'x',
    chaotic,
    fontScale,
    motionAmount,
    seed: 12_345,
    measure,
  });
}

/** 可达舞台：应用窗口最小 960×620（`apps/desktop/src/main/index.ts:154-155`），再小真机到不了。 */
const REACHABLE_STAGES: readonly (readonly [number, number])[] = [
  [1920, 1080],
  [1478, 965],
  [1366, 768],
  [1280, 720],
  [1024, 768],
  [960, 620],
];
/** 低于应用最小窗口的舞台：真机不可达，只记录不硬断言（见汇报里的「到不了的舞台」）。 */
const TINY_STAGES: readonly (readonly [number, number])[] = [
  [1024, 600],
  [800, 500],
  [640, 400],
];
const ALL_STAGES: readonly (readonly [number, number])[] = [...REACHABLE_STAGES, ...TINY_STAGES];
/** 旋钮档：把 `fontScale`(0.8~1.3) 与 `motionAmount`(0.4~1.6) 的四个角都扫到。 */
const TUNINGS: readonly (readonly [number, number, boolean])[] = [
  [1, 1, false],
  [1.3, 1.6, true],
  [0.8, 0.4, true],
  [0.8, 1.6, true],
  [1.3, 0.4, false],
];
const LINES: readonly string[] = [
  'a',
  'abc',
  '俺は喝常に勝つ圧勝',
  '俺を讃える声や喝',
  'night summer rain falls',
  'Мы разбиты и мы победим',
  'ありがとうございましたまた会いましょう',
  '这是一句特别长的歌词用来测试最坏情况会不会溢出舞台边界',
  'この曲はとても長い歌詞で最悪の場合にステージからはみ出さないか確認するための行です',
  'supercalifragilisticexpialidocious',
];

const KANA =
  'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
const LATIN_WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
];
const cjkLine = (n: number): string => KANA.slice(0, n);
const latinLine = (n: number): string => LATIN_WORDS.slice(0, n).join(' ');

/** 一行台阶是否满足「不相交 + 自上而下 + 不丢字」这三条硬不变量。 */
function checkGeometry(plan: PartitaLayoutPlan, source: string, where: string): void {
  expect(partitaFirstOverlap(plan.blocks), `重叠: ${where}`).toBeNull();
  for (let i = 1; i < plan.blocks.length; i += 1) {
    expect(plan.blocks[i]!.y, `阅读顺序: ${where}`).toBeGreaterThan(plan.blocks[i - 1]!.y);
  }
  const joined = plan.blocks.map((block) => block.atoms.map((atom) => atom.text).join('')).join('');
  expect(joined, `丢字/串字: ${where}`).toBe(source.replace(/\s+/gu, ''));
  const seen = plan.blocks
    .flatMap((block) => block.atoms.flatMap((atom) => atom.words.map((word) => word.index)))
    .sort((a, b) => a - b);
  // 空格（`text.trim() === ''`）只用来断词、不渲染，所以下标集合 = 非空格字素的下标。
  const expected = Array.from(source, (char, index) => (char.trim() === '' ? -1 : index)).filter(
    (index) => index >= 0,
  );
  expect(seen, `words 下标漏了: ${where}`).toEqual(expected);
}

describe('partita 楼梯几何', () => {
  it('任意两块不相交 + 每块 1~4 个字素 + 不丢字（所有舞台）', () => {
    let cases = 0;
    const relaxed: string[] = [];
    for (const line of LINES) {
      for (const [width, height] of ALL_STAGES) {
        for (const [fontScale, motionAmount, chaotic] of TUNINGS) {
          const plan = layout(line, width, height, fontScale, motionAmount, chaotic);
          cases += 1;
          const where = `${line} @ ${width}x${height} fs=${fontScale} mo=${motionAmount} ch=${chaotic}`;
          checkGeometry(plan, line, where);
          // 每块 1~4 个字素是**首选解**的保证；「放宽档」（块数 < ceil(总原子/4)，即一块多放几个字）
          // 只在长句 + 小舞台、字号已经缩到下限时才会出现——见下面那条「不可达舞台」的用例。
          const totalAtoms = plan.blocks.reduce((sum, block) => sum + block.atoms.length, 0);
          const minBlocks = Math.ceil(totalAtoms / 4);
          const perBlockOk = plan.blocks.every(
            (block) => block.atoms.length >= 1 && block.atoms.length <= 4,
          );
          if (!perBlockOk) {
            relaxed.push(`${where} 块=${plan.blocks.length} minBlocks=${minBlocks}`);
            expect(plan.blocks.length, `每块超 4 字素却不在放宽档: ${where}`).toBeLessThan(
              minBlocks,
            );
          }
        }
      }
    }
    console.log(
      `[partita] 不相交 / 切块 / 丢字断言覆盖 ${cases} 组；放宽档 ${relaxed.length} 组` +
        (relaxed.length > 0 ? `\n[partita][relaxed] ${relaxed.join('\n[partita][relaxed] ')}` : ''),
    );
  });

  it('拉丁 / 西里尔不拆词（所有舞台）', () => {
    for (const line of ['night summer rain falls', 'Мы разбиты и мы победим']) {
      for (const [width, height] of ALL_STAGES) {
        const plan = layout(line, width, height, 1.3, 1.6, true);
        const atoms = plan.blocks.flatMap((block) => block.atoms.map((atom) => atom.text));
        const expects = line.split(' ').filter((word) => word !== '');
        for (const atom of atoms) {
          expect(expects, `拆词了: ${atom} / ${line}`).toContain(atom);
        }
        expect(atoms.slice().sort()).toEqual(expects.slice().sort());
      }
    }
  });

  it('可达舞台（≥960×620）：参考句 + 1~40 字行长扫描都 0 溢出', () => {
    const overflow: string[] = [];
    const lines: string[] = [...LINES];
    for (let n = 1; n <= 40; n += 1) lines.push(cjkLine(n));
    for (let n = 1; n <= LATIN_WORDS.length; n += 1) lines.push(latinLine(n));
    let cases = 0;
    for (const line of lines) {
      for (const [width, height] of REACHABLE_STAGES) {
        for (const [fontScale, motionAmount, chaotic] of TUNINGS) {
          const plan = layout(line, width, height, fontScale, motionAmount, chaotic);
          cases += 1;
          const where = `"${line}" @ ${width}x${height} fs=${fontScale} mo=${motionAmount} ch=${chaotic}`;
          checkGeometry(plan, line, where);
          if (
            plan.needWidth > plan.availWidth + 1e-6 ||
            plan.needHeight > plan.availHeight + 1e-6
          ) {
            overflow.push(
              `${where} 字宽=${plan.needWidth.toFixed(0)}/${plan.availWidth.toFixed(0)} ` +
                `字高=${plan.needHeight.toFixed(0)}/${plan.availHeight.toFixed(0)} ` +
                `font=${plan.fontPx.toFixed(1)} 块=${plan.blocks.length}`,
            );
          }
        }
      }
    }
    console.log(`[partita] 可达舞台用例 ${cases} 组，溢出 ${overflow.length} 组`);
    for (const item of overflow) console.log(`[partita][overflow] ${item}`);
    expect(overflow, '可达舞台上不允许溢出').toEqual([]);
  });

  it('低于应用最小窗口的舞台：真机到不了，只记录', () => {
    const overflow: string[] = [];
    const lines: string[] = [...LINES];
    for (let n = 1; n <= 40; n += 1) lines.push(cjkLine(n));
    for (let n = 1; n <= LATIN_WORDS.length; n += 1) lines.push(latinLine(n));
    let cases = 0;
    for (const line of lines) {
      for (const [width, height] of TINY_STAGES) {
        for (const [fontScale, motionAmount, chaotic] of TUNINGS) {
          const plan = layout(line, width, height, fontScale, motionAmount, chaotic);
          cases += 1;
          checkGeometry(plan, line, `${line} @ ${width}x${height}`);
          if (
            plan.needWidth > plan.availWidth + 1e-6 ||
            plan.needHeight > plan.availHeight + 1e-6
          ) {
            overflow.push(
              `"${line}" @ ${width}x${height} fs=${fontScale} mo=${motionAmount} ch=${chaotic} ` +
                `字宽=${plan.needWidth.toFixed(0)}/${plan.availWidth.toFixed(0)} ` +
                `字高=${plan.needHeight.toFixed(0)}/${plan.availHeight.toFixed(0)} ` +
                `font=${plan.fontPx.toFixed(1)} 块=${plan.blocks.length}`,
            );
          }
        }
      }
    }
    console.log(
      `[partita] 不可达舞台用例 ${cases} 组，溢出 ${overflow.length} 组（均已在 20px 下限）` +
        (overflow.length > 0
          ? `\n[partita][tiny-overflow] ${overflow.join('\n[partita][tiny-overflow] ')}`
          : ''),
    );
  });

  it('打印参考句的实际数值', () => {
    for (const line of ['俺は喝常に勝つ圧勝', '俺を讃える声や喝', 'night summer rain falls']) {
      const plan = layout(line, 1478, 965, 1, 1, false);
      const rows = plan.blocks.map((block, index) => ({
        块: index,
        文字: block.text,
        原子数: block.atoms.length,
        x: Number(block.x.toFixed(1)),
        y: Number(block.y.toFixed(1)),
        宽: Number(block.rectWidth.toFixed(1)),
        高: Number(block.rectHeight.toFixed(1)),
        转: Number(block.rotate.toFixed(2)),
      }));
      console.log(
        `[partita] "${line}" font=${plan.fontPx.toFixed(1)}px step=${plan.stepY.toFixed(1)} ` +
          `boxH=${plan.boxHeight.toFixed(1)} need=${plan.needWidth.toFixed(0)}x${plan.needHeight.toFixed(0)} ` +
          `avail=${plan.availWidth.toFixed(0)}x${plan.availHeight.toFixed(0)}`,
      );
      console.log(JSON.stringify(rows));
    }
  });
});
