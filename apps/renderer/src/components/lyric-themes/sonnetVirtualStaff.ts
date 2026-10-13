/**
 * 商籁**器乐（没有歌词）时的虚拟五线谱行**（照抄 folia `VisualizerSonnet.tsx` 里 `virtualLines` 的数值；
 * 文字与代码我们重写；AGPL-3.0）。
 *
 * === 上游行为（`SOURCE`：`VisualizerSonnet.tsx`，全文已取回）===
 * 当整首歌**没有任何可排的词**时，上游**造 60 条虚拟行** ✓：
 * `id: 'virtual-staff-N'` ✓、**`startTime = N × 8`** ✓、**`endTime = N × 8 + 6`** ✓、
 * **`fullText: '♪'`** ✓、`words: []` ✓、`isChorus: false` ✓
 * ⇒ 于是**五线谱照样在走**：每 **8 秒**一段、每段**占前 6 秒** ✓、字只有 `♪` ✓。
 *
 * ⚠ 这个 8 秒与我们第 180 轮为**五线谱**定的 `CYCLE_SECONDS = 8` **正好对上** ✓
 * （不是巧合：上游那套谱子本来就是按 8 秒一圈走的 ✓）。
 *
 * ⚠ **本文件只出"行数据"** ✗ —— 不碰帧层/渲染层 ✓，也不假装知道 `StageLine` 的全部字段 ✓；
 * 接线时再由调用方映射成我们的行类型 ✓（`hint` 之类的字段**要读了类型再填** ✗，不许猜 ✓）。
 */

/** 虚拟行的**段长**（秒 ✓）。 */
export const SONNET_VIRTUAL_STAFF_LINE_SECONDS = 8;
/** 虚拟行**实际占用的时长**（秒 ✓）—— 每段后留 2 秒空档 ✓。 */
export const SONNET_VIRTUAL_STAFF_LINE_DURATION_SECONDS = 6;
/** 上游造多少条（**照抄 60** ✓）。 */
export const SONNET_VIRTUAL_STAFF_LINE_COUNT = 60;
/** 虚拟行唯一的"字"（照抄 ✓）。 */
export const SONNET_VIRTUAL_STAFF_LINE_TEXT = '♪';

/** 一条虚拟行（我们这边的最小形状 ✓）。 */
export interface SonnetVirtualStaffLine {
  /** 第几条（0 起 ✓）；上游用 `N × 8` 算起始时刻 ✓。 */
  readonly index: number;
  readonly startMs: number;
  readonly durationMs: number;
  readonly text: string;
}

/**
 * 造虚拟五线谱行 ✓。
 *
 * @param fromIndex 起始序号（默认 0 ✓）—— 允许调用方从"已有的段数"接着排 ✓。
 * @param count 条数（默认 60 ✓）；非正数 ⇒ 空数组 ✓（不抛错 ✓）。
 */
export function buildSonnetVirtualStaffLines(
  fromIndex = 0,
  count = SONNET_VIRTUAL_STAFF_LINE_COUNT,
): readonly SonnetVirtualStaffLine[] {
  const safeFrom = Math.max(0, Math.floor(fromIndex));
  const safeCount = Math.max(0, Math.floor(count));
  return Array.from({ length: safeCount }, (_unused, offset) => {
    const index = safeFrom + offset;
    return {
      index,
      startMs: index * SONNET_VIRTUAL_STAFF_LINE_SECONDS * 1000,
      durationMs: SONNET_VIRTUAL_STAFF_LINE_DURATION_SECONDS * 1000,
      text: SONNET_VIRTUAL_STAFF_LINE_TEXT,
    };
  });
}

/**
 * 这首歌**该不该用虚拟行** ✓：取决于"有没有可排的字" ✓。
 *
 * 上游的判据是"**整首没有词**" ✓（`words: []` 的虚拟行就是为它准备的 ✓）；
 * 我们这边取**更保守**的口径：**行里一个词都没有** ⇒ 才启用 ✓
 * （⚠ 这是**我们的判断** ✗：上游那处判据的确切形状（是看 `words` 还是看别的）**未核** ✓，
 *   登记在 `CREDITS.md` 里 ✓）。
 */
export function shouldUseSonnetVirtualStaffLines(
  lines: readonly { readonly words?: readonly unknown[] }[],
): boolean {
  if (lines.length === 0) {
    return true;
  }
  return lines.every((line) => (line.words ?? []).length === 0);
}
