/**
 * 外层元数据（`sonnetOuterMetadata.ts`）的用例（第 420 轮补）。
 * 期望值全部来自上游原文（`sonnetSceneBuilder.ts:128~169`）与手算 ✓。
 */

import { describe, expect, it } from 'vitest';
import {
  SONNET_OUTER_LABEL_ALPHA,
  SONNET_OUTER_LABEL_ROTATION,
  SONNET_OUTER_MARGIN,
  SONNET_OUTER_NOTE_ALPHA,
  shouldShowSonnetOuterMetadata,
  resolveSonnetOuterMetadata,
  type SonnetOuterMetadataInput,
} from './sonnetOuterMetadata';

const WIDTH = 1920;
const HEIGHT = 1080;

const base = (overrides: Partial<SonnetOuterMetadataInput> = {}): SonnetOuterMetadataInput => ({
  themeName: 'Sonnet',
  themeDescription: 'A deterministic typographic program.',
  width: WIDTH,
  height: HEIGHT,
  manualFontWeight: null,
  outerFrameMode: 'full',
  showOnlyText: false,
  ...overrides,
});

describe('外层元数据：门槛', () => {
  it('判据照抄上游：`!showOnlyText && outerFrameMode === "full"`', () => {
    expect(shouldShowSonnetOuterMetadata({ outerFrameMode: 'full', showOnlyText: false })).toBe(true);
    expect(shouldShowSonnetOuterMetadata({ outerFrameMode: 'full', showOnlyText: true })).toBe(false);
    expect(shouldShowSonnetOuterMetadata({ outerFrameMode: 'frame', showOnlyText: false })).toBe(false);
    expect(shouldShowSonnetOuterMetadata({ outerFrameMode: 'none', showOnlyText: false })).toBe(false);
  });

  it('两道门槛任一不过 ⇒ 两条都是 null', () => {
    expect(resolveSonnetOuterMetadata(base({ showOnlyText: true }))).toEqual({ label: null, note: null });
    expect(resolveSonnetOuterMetadata(base({ outerFrameMode: 'frame' }))).toEqual({
      label: null,
      note: null,
    });
    expect(resolveSonnetOuterMetadata(base({ outerFrameMode: 'none' }))).toEqual({
      label: null,
      note: null,
    });
  });

  it('文本为空是**各自独立**的（上游两段独立 if）：空名只掉标签、空说明只掉说明块', () => {
    const noName = resolveSonnetOuterMetadata(base({ themeName: '   ' }));
    expect(noName.label).toBeNull();
    expect(noName.note).not.toBeNull();

    const noDescription = resolveSonnetOuterMetadata(base({ themeDescription: null }));
    expect(noDescription.note).toBeNull();
    expect(noDescription.label).not.toBeNull();
  });
});

describe('外层元数据：标签（左下、竖排）', () => {
  it('文本 = `[ THEME ] ` + 大写主题名；字号 14、字距 4、alpha 0.2、旋转 −π/2', () => {
    const label = resolveSonnetOuterMetadata(base())!.label!;
    expect(label.text).toBe('[ THEME ] SONNET');
    expect(label.fontSize).toBe(14);
    expect(label.letterSpacing).toBe(4);
    expect(label.alpha).toBe(SONNET_OUTER_LABEL_ALPHA);
    expect(label.alpha).toBeCloseTo(0.2, 6);
    expect(label.rotation).toBeCloseTo(SONNET_OUTER_LABEL_ROTATION, 6);
    expect(label.rotation).toBeCloseTo(-Math.PI / 2, 6);
    expect(label.colorKey).toBe('primary');
  });

  it('位置 = (20, height − 20)、锚点 (0, 1)（左下）', () => {
    const label = resolveSonnetOuterMetadata(base())!.label!;
    expect(label.x).toBe(SONNET_OUTER_MARGIN);
    expect(label.x).toBe(20);
    expect(label.y).toBe(HEIGHT - SONNET_OUTER_MARGIN);
    expect(label.y).toBe(1060);
    expect([label.anchorX, label.anchorY]).toEqual([0, 1]);
  });

  it('小写主题名会被大写（`theme.name.toUpperCase()`）', () => {
    expect(resolveSonnetOuterMetadata(base({ themeName: 'sonnet' }))!.label!.text).toBe(
      '[ THEME ] SONNET',
    );
  });
});

describe('外层元数据：说明块（右上、可换行）', () => {
  it('字号 12、alpha 0.3、最大宽度 = width × 0.3、颜色取 secondary', () => {
    const note = resolveSonnetOuterMetadata(base())!.note!;
    expect(note.text).toBe('A deterministic typographic program.');
    expect(note.fontSize).toBe(12);
    expect(note.alpha).toBeCloseTo(0.3, 6);
    expect(note.alpha).toBe(SONNET_OUTER_NOTE_ALPHA);
    expect(note.maxWidth).toBeCloseTo(WIDTH * 0.3, 6);
    expect(note.maxWidth).toBe(576);
    expect(note.colorKey).toBe('secondary');
  });

  it('位置 = (width − 20, 20)、锚点 (1, 0)（右上）', () => {
    const note = resolveSonnetOuterMetadata(base())!.note!;
    expect(note.x).toBe(WIDTH - SONNET_OUTER_MARGIN);
    expect(note.x).toBe(1900);
    expect(note.y).toBe(SONNET_OUTER_MARGIN);
    expect(note.y).toBe(20);
    expect([note.anchorX, note.anchorY]).toEqual([1, 0]);
  });
});

describe('外层元数据：字重三分支（照抄上游规则）', () => {
  it('manualFontWeight === null ⇒ 标签 `bold`、说明块**不指定**（null）', () => {
    const result = resolveSonnetOuterMetadata(base({ manualFontWeight: null }))!;
    expect(result.label!.fontWeight).toBe('bold');
    expect(result.note!.fontWeight).toBeNull();
  });

  it('manualFontWeight 给数字 ⇒ 两条都用它的字符串形式', () => {
    const result = resolveSonnetOuterMetadata(base({ manualFontWeight: 700 }))!;
    expect(result.label!.fontWeight).toBe('700');
    expect(result.note!.fontWeight).toBe('700');
  });
});
