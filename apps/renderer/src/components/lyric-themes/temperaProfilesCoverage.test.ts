/**
 * 凝彩构图**命名覆盖**的回归检查（第 169 轮）。
 *
 * 为什么要有这条：第 168 轮我是**手数**出来的"121 / 121 命名对齐" —— 手数的结论不会随代码演进被自动重验。
 * 这里把它固化成断言：从本地上游快照（`.folia-ref/tempera__temperaShotProfiles.ts`）里抽出所有构图名，
 * 与我们 `temperaProfiles.ts` 的条目名**逐一对照**，要求"一个不多、一个不少"。
 *
 * **缺失即跳过**：`.folia-ref/` 是本地参考快照，可能不在其它环境里 —— 文件不存在时这条用例
 * **跳过而不是失败**（不能让"没有参考资料"变成红灯）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 从当前目录往上找含 `.folia-ref` 的仓库根（vitest 的 cwd 可能是包目录，也可能是仓库根）。 */
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

/** 抽出"顶层字符串键"形式的构图名（上游是多行 `'name': {`，我们是单行 `'name': { … },`）。 */
const extractNames = (source: string): string[] => {
  const names: string[] = [];
  for (const match of source.matchAll(/^\s{2,4}'([a-z0-9-]+)':\s*\{/gmu)) {
    names.push(match[1] as string);
  }
  return names;
};

const repoRoot = findRepoRoot();
const upstreamPath = repoRoot === null ? null : join(repoRoot, '.folia-ref', 'tempera__temperaShotProfiles.ts');
const hasUpstream = upstreamPath !== null && existsSync(upstreamPath);

describe('凝彩构图命名覆盖（对照本地上游快照）', () => {
  it.skipIf(!hasUpstream)('我们的构图名与上游 0.7.12 一一对应（不多不少）', () => {
    const upstream = extractNames(readFileSync(upstreamPath as string, 'utf8'));
    const ours = extractNames(readFileSync(new URL('./temperaProfiles.ts', import.meta.url), 'utf8'));
    expect(upstream.length).toBeGreaterThan(100);
    // 逐一对照：缺的、多的都要能一眼看出来。
    const missing = upstream.filter((name) => !ours.includes(name));
    const extra = ours.filter((name) => !upstream.includes(name));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(ours.length).toBe(upstream.length);
  });
});
