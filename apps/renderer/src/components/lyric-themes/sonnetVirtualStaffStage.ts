/**
 * 把**器乐虚拟五线谱行**映射成我们的行类型（第 559 轮接线用）。
 *
 * 为什么要单独一份文件：`sonnetVirtualStaff.ts` 是**纯数据**（不依赖我们的行类型 ✓），
 * 而这一层要 `import type { StageLine }` ✓ ⇒ 分开之后"数据"与"适配"各自独立、各自可测 ✓。
 *
 * 字段对照（`SOURCE`：`types.ts:43~52` 的 `StageLine` ✓）：
 * `index` ← 虚拟序号 ✓；`timeMs` ← `startMs` ✓；`text` ← `'♪'` ✓；`durationMs` ← `6000` ✓；
 * `hint` ← **`'normal'`** ✓（⚠ 取值来自 `types.ts:21` 的 `Hint = 'normal' | 'short' | 'micro'` ✓，
 * 取 `'normal'` 是**我们的选择** ✗ —— 上游那处是否另有用意**未核** ✓）；
 * `words` / `starts` / `ends` ← **空数组** ✓（虚拟行没有词 ⇒ 没有逐字时间轴 ✓；
 * 而帧层那侧本来就是 `if (line.words.length === 0) continue;` ✓ ⇒ **天然兼容** ✓）。
 */

import type { StageLine } from './types';
import type { SonnetVirtualStaffLine } from './sonnetVirtualStaff';

export function toSonnetVirtualStaffStageLines(
  lines: readonly SonnetVirtualStaffLine[],
): readonly StageLine[] {
  return lines.map((line) => ({
    index: line.index,
    timeMs: line.startMs,
    text: line.text,
    durationMs: line.durationMs,
    hint: 'normal',
    words: [],
    starts: [],
    ends: [],
  }));
}
