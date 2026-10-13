/**
 * 把 `resolveSonnetOuterMetadata` 出来的**参数**变成**两个 Pixi 文本节点**（第 423 轮建、第 426 轮修类型）。
 *
 * 为什么单独一个文件：商籁是**整块 Pixi canvas** 的主题（`lyric-sonnet.css` 里只有
 * `.pi-lyricstage[data-theme='sonnet'] / .pi-lyricsonnet / canvas` 三条规则 ✓），
 * 所以外层元数据**必须画在 Pixi 里**（与上游 `sonnetSceneBuilder.ts` 完全一致 ✓），而不是 DOM ✓。
 *
 * === 边界 ===
 * · 本文件**不认识我们项目的 Pixi 导入方式** ✗ —— `pixi` 用一个**结构化最小类型**（`{ Text }` ✓）传入，
 *   避免把"导入形状"这种易变的东西写死在这里 ✓；
 * · **泛型 `<T>`**：`Text` 造出来的**真实类型**会原样透出（`{ label: T | null; note: T | null; nodes: T[] }` ✓），
 *   这样渲染层 `addChild(...nodes)` 时**不需要任何强转** ✓（第 426 轮修的就是这个 ✗）；
 * · 颜色类型是 **`string | number`** ✗：我们项目主题色是**字符串**（`:133 colors.ink` 那套 ✓），
 *   而上游 Pixi 用**数字** ✓ —— 两种都收，别假设哪一种 ✓（第 426 轮修的另一个 ✗）；
 * · `rotation / fontSize / letterSpacing / alpha / wordWrap* / 位置` **全部来自参数** ✓，
 *   本文件**不另写任何版面常数** ✗（纪律：常数只许在 `sonnetOuterMetadata.ts` 里 ✓）。
 */

import type { SonnetOuterMetadata } from './sonnetOuterMetadata';

/** Pixi 文本节点的**最小结构**（只列我们会设置/读取的字段 ✓）。 */
export interface SonnetOuterMetadataTextLike {
  text: string;
  alpha: number;
  rotation: number;
  position: { set(x: number, y: number): void };
  anchor: { set(x: number, y: number): void };
}

export type SonnetOuterMetadataColor = string | number;

interface SonnetOuterMetadataTextStyleInit {
  fontFamily: string;
  fontSize: number;
  fill: SonnetOuterMetadataColor;
  fontWeight?: string;
  letterSpacing?: number;
  wordWrap?: boolean;
  wordWrapWidth?: number;
}

export interface SonnetOuterMetadataPixiModule<T extends SonnetOuterMetadataTextLike> {
  Text: new (options: {
    text: string;
    style: SonnetOuterMetadataTextStyleInit;
  }) => T;
}

export interface SonnetOuterMetadataColors {
  /** 主题主色（对应上游 `theme.primaryColor`）✓ —— 标签用它 ✓。 */
  readonly primary: SonnetOuterMetadataColor;
  /** 主题次色（对应上游 `theme.secondaryColor` ✓；我方映射到 `colors.accent` ✓）—— 说明块用它 ✓。 */
  readonly secondary: SonnetOuterMetadataColor;
}

export interface SonnetOuterMetadataNodes<T extends SonnetOuterMetadataTextLike> {
  readonly label: T | null;
  readonly note: T | null;
  /** 按"标签在前、说明块在后"给渲染层用的列表（方便一次性 `addChild(...nodes)` ✓）。 */
  readonly nodes: readonly T[];
}

/**
 * 造节点 ✓。两条各自为 `null` 时就各自不造 ✓（与 `resolveSonnetOuterMetadata` 的语义一致 ✓）。
 * 字重：`null` 表示**不指定** ⇒ 不往 `TextStyle` 里塞 `fontWeight` 字段 ✓（对应上游的 `undefined` ✓）。
 */
export function buildSonnetOuterMetadataNodes<T extends SonnetOuterMetadataTextLike>(
  pixi: SonnetOuterMetadataPixiModule<T>,
  metadata: SonnetOuterMetadata,
  fontFamily: string,
  colors: SonnetOuterMetadataColors,
): SonnetOuterMetadataNodes<T> {
  const label = metadata.label
    ? new pixi.Text({
        text: metadata.label.text,
        style: {
          fontFamily,
          fontSize: metadata.label.fontSize,
          fill: colors.primary,
          fontWeight: metadata.label.fontWeight,
          letterSpacing: metadata.label.letterSpacing,
        },
      })
    : null;

  if (label && metadata.label) {
    label.alpha = metadata.label.alpha;
    label.rotation = metadata.label.rotation;
    label.position.set(metadata.label.x, metadata.label.y);
    label.anchor.set(metadata.label.anchorX, metadata.label.anchorY);
  }

  const note = metadata.note
    ? new pixi.Text({
        text: metadata.note.text,
        style: {
          fontFamily,
          fontSize: metadata.note.fontSize,
          fill: colors.secondary,
          ...(metadata.note.fontWeight === null ? {} : { fontWeight: metadata.note.fontWeight }),
          wordWrap: true,
          wordWrapWidth: metadata.note.maxWidth,
        },
      })
    : null;

  if (note && metadata.note) {
    note.alpha = metadata.note.alpha;
    note.position.set(metadata.note.x, metadata.note.y);
    note.anchor.set(metadata.note.anchorX, metadata.note.anchorY);
  }

  return {
    label,
    note,
    nodes: [label, note].filter((node): node is T => node !== null),
  };
}
