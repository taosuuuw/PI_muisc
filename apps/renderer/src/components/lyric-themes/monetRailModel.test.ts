/**
 * 废弃标记的守卫用例。
 *
 * 存在的意义：如果哪天有人**又**在 `monetRailModel.ts` 里写实现，这条会提醒他先读废弃说明——
 * 莫奈的真正实现在 `monetLayout.ts`（`MonetTheme.tsx:77` 导入的就是它）。
 */

import { describe, expect, it } from 'vitest';
import { MONET_RAIL_MODEL_DEPRECATED } from './monetRailModel';

describe('monetRailModel 已废弃', () => {
  it('标记为真（实现请用 monetLayout.ts）', () => {
    expect(MONET_RAIL_MODEL_DEPRECATED).toBe(true);
  });
});
