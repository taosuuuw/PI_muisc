/**
 * ⚠ **本文件已废弃（第 215 轮清理）**：里面的行窗口 / token / 色调接线 / 辉光接线等实现，
 * **`monetLayout.ts` 早已有对应且更完整的版本**（`positionMonetRailEntries`、`resolveMonetLineTone`、
 * `buildMonetGraphemeOffsets`、`resolveMonetLineGap`、`monetSweepMaskImage` ……）。
 *
 * 重复实现已全部移除。**不要在这里重新实现任何东西** —— 需要什么就去看 `monetLayout.ts`。
 *
 * 保留这个文件与下面这枚标记，是为了让"这里曾经走过弯路"这件事在代码里可见：
 * 接手时先 `grep export monetLayout.ts`，再决定要写什么。
 */

/** 该模块已废弃；仅为让废弃状态**可被断言/可被搜索**而保留。 */
export const MONET_RAIL_MODEL_DEPRECATED = true as const;
