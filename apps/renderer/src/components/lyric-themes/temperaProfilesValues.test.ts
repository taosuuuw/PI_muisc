/**
 * 凝彩构图**数值**对照（第 170 轮，**诊断型**）：把上游 0.7.12 与我们 `temperaProfiles.ts`
 * 每一条构图的 `region / enter / camera / mood` 抽出来逐条比，把差异**打印**出来。
 *
 * 为什么先做成"诊断"而不是"断言"：第 168 轮只抽检了 2 条，其余 119 条是否一致**尚不知道**；
 * 若直接写成严格断言，第一次跑很可能因为"默认值写法不同"（比如上游 `region()` 把 `fontScale`
 * 缺省成 1、我们直接省略）而红一片，反而把真正的差异淹没在噪声里。
 * 所以这一版：**只要求"每条都能解析出四个字段"**，差异列表打到 stdout，供人（与下一轮）判断。
 * 等差异清单确认干净后，再把它升级成严格断言。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const findRepoRoot = (): string | null => {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, '.folia-ref'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
};

const repoRoot = findRepoRoot();
const upstreamPath = repoRoot === null ? null : join(repoRoot, '.folia-ref', 'tempera__temperaShotProfiles.ts');
const hasUpstream = upstreamPath !== null && existsSync(upstreamPath);

/** 上游条目：`'name': { … },`（多行）。 */
const splitUpstreamEntries = (source: string): Map<string, string> => {
  const map = new Map<string, string>();
  const header = /^    '([a-z0-9-]+)': \{\s*$/gmu;
  const starts: { name: string; index: number }[] = [];
  for (const match of source.matchAll(header)) {
    starts.push({ name: match[1] as string, index: match.index ?? 0 });
  }
  starts.forEach((entry, index) => {
    const end = index + 1 < starts.length ? (starts[index + 1]?.index ?? source.length) : source.length;
    map.set(entry.name, source.slice(entry.index, end));
  });
  return map;
};

const numberFrom = (source: string, pattern: RegExp, fallback = 0): number => {
  const match = pattern.exec(source);
  return match === null ? fallback : Number(match[1]);
};

describe('凝彩构图数值对照（诊断）', () => {
  it.skipIf(!hasUpstream)('逐条抽取 region / enter / camera / mood，并把差异打印出来', () => {
    const upstream = splitUpstreamEntries(readFileSync(upstreamPath as string, 'utf8'));
    const oursSource = readFileSync(new URL('./temperaProfiles.ts', import.meta.url), 'utf8');
    const ours = splitUpstreamEntries(
      // 我们的条目是单行的：把它们规整成同样的"行首 + 多行块"形式，复用同一套解析。
      oursSource.replace(/^  '([a-z0-9-]+)': \{ (.+) \},$/gmu, (_all, name: string, body: string) => {
        const lines = body
          .split(/,\s*(?=[a-zA-Z]+:)/u)
          .map((part) => `        ${part.trim()},`)
          .join('\n');
        return `    '${name}': {\n${lines}\n    },`;
      }),
    );

    expect(upstream.size).toBeGreaterThan(100);
    expect(ours.size).toBe(upstream.size);

    const mismatches: string[] = [];
    for (const [name, block] of upstream) {
      const mine = ours.get(name);
      if (mine === undefined) {
        mismatches.push(`${name}: 我们缺这条`);
        continue;
      }
      const regionArgs = /region\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/u.exec(block);
      const mineRegion = /region: \[([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\]/u.exec(mine);
      if (regionArgs === null || mineRegion === null) {
        mismatches.push(`${name}: region 解析失败`);
        continue;
      }
      const pairs: [string, number, number][] = [
        ['cx', Number(regionArgs[1]), Number(mineRegion[1])],
        ['cy', Number(regionArgs[2]), Number(mineRegion[2])],
        ['w', Number(regionArgs[3]), Number(mineRegion[3])],
        ['h', Number(regionArgs[4]), Number(mineRegion[4])],
        ['enter.x', numberFrom(block, /enter: \{ x: (-?[\d.]+)/u), numberFrom(mine, /enter: \[(-?[\d.]+)/u)],
        [
          'enter.y',
          numberFrom(block, /enter: \{ x: -?[\d.]+, y: (-?[\d.]+)/u),
          numberFrom(mine, /enter: \[-?[\d.]+, (-?[\d.]+)\]/u),
        ],
        ['camera.travel', numberFrom(block, /travel: ([\d.]+)/u), numberFrom(mine, /camera: \[([\d.]+)/u)],
        [
          'camera.zoomStart',
          numberFrom(block, /zoomStart: ([\d.]+)/u),
          numberFrom(mine, /camera: \[[\d.]+, ([\d.]+)/u),
        ],
        [
          'camera.zoomEnd',
          numberFrom(block, /zoomEnd: ([\d.]+)/u),
          numberFrom(mine, /camera: \[[\d.]+, [\d.]+, ([\d.]+)/u),
        ],
      ];
      pairs.forEach(([field, want, got]) => {
        if (Math.abs(want - got) > 1e-9) mismatches.push(`${name}.${field}: 上游 ${want} vs 我们 ${got}`);
      });
      const wantMood = /mood: '([a-z]+)'/u.exec(block)?.[1] ?? '';
      const gotMood = /mood: '([a-z]+)'/u.exec(mine)?.[1] ?? '';
      if (wantMood !== gotMood) mismatches.push(`${name}.mood: 上游 ${wantMood} vs 我们 ${gotMood}`);
    }

    // 诊断输出（很大，但只在真的跑这条用例时出现）。
    if (mismatches.length === 0) {
      console.log(`[temperaProfiles] 数值对照：${upstream.size} 条全部一致 ✓`);
    } else {
      console.log(`[temperaProfiles] 数值对照：共 ${mismatches.length} 处差异：\n${mismatches.join('\n')}`);
    }
    // 第 170 轮诊断跑出"121 条全部一致" ⇒ 第 171 轮**升级为严格断言**（差异必须为空）。
    expect(mismatches).toEqual([]);
    expect(upstream.size).toBe(121);
  });
});
