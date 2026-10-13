/**
 * 凝彩（tempera）**片尾海报的版式计算**（纯函数，不碰 pixi）。
 *
 * 来源：`chthollyphile/folia-major@main` 的
 * `src/components/visualizer/tempera/temperaSceneBuilder.ts` 的 `buildTemperaCreditsPoster`
 * （AGPL-3.0，**只取算法与数值，代码按本仓库风格重写**；快照 `.folia-ref/tempera__temperaSceneBuilder.ts`
 * 第 113~300 行；登记见 `docs/CREDITS.md`）。
 *
 * 上游设计意图（注释原文大意）：片尾卡**用与 shot 构图同一套语汇**拼出来——平铺色调底、
 * 硬边墨线的色块、一层网点、共用的交叉线与角饰——所以收尾读起来"**仍然是这首歌里的一个镜头**"，
 * 而不是外挂的标题页。色块是**圆心落在画面之外的部分圆盘**，弧线在中部交叉，
 * 让标题**横跨两三条色调边界**。
 *
 * ⚠ 两条约束（上游明确警告过）：
 * 1. **一切都围绕容器自身原点绘制**（所以交叉线要减去 `halfWidth/halfHeight`）；
 *    运行时只靠 `position` 居中 —— 再给容器加视口 pivot 曾把整张海报停到左上角、半张出画；
 * 2. 只有**一块**色块带网点（`hatchIndex`），没有它整张卡会退化成扁平矢量图。
 *
 * ⬜ 本模块只出"版式"，**不含绘制与动画**（`updateTime` 的逐帧应用仍待移植）。
 */

import { easeTemperaEnter } from './temperaEasing';
import { hashTemperaSeed, temperaHash01 } from './temperaProgram';

export const TEMPERA_CREDITS_DISC_COUNT = 3;

/** 渐近漂移的时间常数（秒）：一直在动，但永不跑飞。 */
export const TEMPERA_CREDITS_CREEP_SECONDS = 7;

/** `1 - exp(-max(0, elapsed) / 7)`：渐近曲线，卡片出现前为 0。 */
export function temperaCreditsCreep(elapsed: number): number {
  return 1 - Math.exp(-Math.max(0, elapsed) / TEMPERA_CREDITS_CREEP_SECONDS);
}

export interface TemperaCreditsMetadata {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
}

/** 三个字段任一 trim 后非空即算"有片尾元数据"（与商籁同一口径）。 */
export function hasTemperaCreditsMetadata(metadata: TemperaCreditsMetadata): boolean {
  return Boolean(
    (metadata.title && metadata.title.trim()) ||
      (metadata.artist && metadata.artist.trim()) ||
      (metadata.album && metadata.album.trim()),
  );
}

export interface TemperaCreditsLayoutInput {
  width: number;
  height: number;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  lyricsFontScale: number;
}

export interface TemperaCreditsDiscPlan {
  index: number;
  /** 圆心（**远在画面之外**：`distance` 是 0.58~0.72 倍对角线）。 */
  cx: number;
  cy: number;
  radius: number;
  /** 取 `tones[index]`（tone2 → tone3 → tone4，逐块提亮）。 */
  toneIndex: number;
  delay: number;
  enterDX: number;
  enterDY: number;
  driftX: number;
  driftY: number;
  /** 是否承担**唯一那层网点**。 */
  hasHatch: boolean;
  hatchDelay: number;
  outlineDelay: number;
}

export interface TemperaCreditsLayout {
  seed: number;
  /** 一个种子位镜像整套版式（`+1 / -1`），避免每次都长一样。 */
  flip: number;
  diagonal: number;
  bleed: number;
  /** 渐变角（弧度）；无渐变时仍算出，供调用方决定是否使用。 */
  gradientAngle: number;
  baseAngle: number;
  hatchIndex: number;
  discs: TemperaCreditsDiscPlan[];
  titleSize: number;
  wrapWidth: number;
  subtitle: string;
  /** 交叉线的进场延迟（上游 `0.5`）。 */
  linesDelay: number;
  linesEnterDX: number;
}

export function buildTemperaCreditsLayout(
  input: TemperaCreditsLayoutInput,
): TemperaCreditsLayout {
  const { width, height, title, artist, album, lyricsFontScale } = input;
  const seed = hashTemperaSeed(`${title ?? ''}|${artist ?? ''}`);
  const diagonal = Math.hypot(width, height);
  const bleed = diagonal * 0.25;
  // 一个种子位镜像整套版式。
  const flip = temperaHash01(seed, 1, 229) > 0.5 ? 1 : -1;
  // 渐变模式会抬升每个 shot 的填充；少了它，这张卡会是全曲唯一的一帧平色。
  const gradientAngle = temperaHash01(seed, 3, 197) * Math.PI * 2;
  const baseAngle = temperaHash01(seed, 4, 241) * Math.PI * 2;
  const hatchIndex =
    Math.floor(temperaHash01(seed, 5, 251) * TEMPERA_CREDITS_DISC_COUNT) %
    TEMPERA_CREDITS_DISC_COUNT;

  const discs: TemperaCreditsDiscPlan[] = [];
  for (let index = 0; index < TEMPERA_CREDITS_DISC_COUNT; index += 1) {
    // 沿圆周平分，再在自己那一份里抖动。
    const angle =
      baseAngle +
      (index * Math.PI * 2) / TEMPERA_CREDITS_DISC_COUNT +
      (temperaHash01(seed, index, 257) - 0.5) * 0.7;
    const distance = diagonal * (0.58 + temperaHash01(seed, index, 263) * 0.14);
    // 近边落在中线之外 —— 这正是"弧线穿过文字"的来源。
    const radius = distance + diagonal * (0.06 + temperaHash01(seed, index, 269) * 0.1);
    const delay = 0.08 + index * 0.16;
    discs.push({
      index,
      cx: Math.cos(angle) * distance,
      cy: Math.sin(angle) * distance,
      radius,
      toneIndex: index,
      delay,
      // 沿各自内向向量进场，之后继续同向爬（所以 drift 与 enter 反向）。
      enterDX: Math.cos(angle) * diagonal * 0.16,
      enterDY: Math.sin(angle) * diagonal * 0.16,
      driftX: -Math.cos(angle) * diagonal * 0.024,
      driftY: -Math.sin(angle) * diagonal * 0.024,
      hasHatch: index === hatchIndex,
      hatchDelay: delay + 0.06,
      outlineDelay: delay + 0.04,
    });
  }

  const subtitle = [artist, album].filter(Boolean).join(' - ');
  return {
    seed,
    flip,
    diagonal,
    bleed,
    gradientAngle,
    baseAngle,
    hatchIndex,
    discs,
    titleSize: Math.max(26, Math.min(width, height) * 0.085 * lyricsFontScale),
    wrapWidth: Math.min(width * 0.72, diagonal * 0.52),
    subtitle,
    linesDelay: 0.5,
    linesEnterDX: width * 0.2,
  };
}

/** 片尾里每一个"会动的零件"（上游 `CreditsItem`）。 */
export interface TemperaCreditsItem {
  baseX: number;
  baseY: number;
  baseAlpha: number;
  enterDX: number;
  enterDY: number;
  delay: number;
  driftX: number;
  driftY: number;
  grow: number;
}

export interface TemperaCreditsItemFrame {
  alpha: number;
  visible: boolean;
  x: number;
  y: number;
  scale: number;
}

/**
 * 逐项推进片尾零件（照搬上游 `updateTime` 的循环体，`:322~343`）：
 * ```
 * enter   = easeTemperaEnter((elapsed - delay) / 1.1)
 * alpha   = baseAlpha * enter
 * visible = enter > 0.001
 * pos     = base + enterD * (1 - enter) + drift * creep
 * scale   = grow !== 0 ? 1 + grow * creep : 1
 * ```
 * —— 进场沿 `enterD` 收进来（`1 - enter` 从 1 收到 0），随后由 `creep` 带着 `drift` 继续缓漂。
 * 注意 `enter` 用 `easeTemperaEnter`（**不是** InOut）：进场前置决断、尾巴拖长。
 */
export function resolveTemperaCreditsItemFrame(
  item: TemperaCreditsItem,
  elapsed: number,
): TemperaCreditsItemFrame {
  const creep = temperaCreditsCreep(elapsed);
  const enter = easeTemperaEnter((elapsed - item.delay) / 1.1);
  return {
    alpha: item.baseAlpha * enter,
    visible: enter > 0.001,
    x: item.baseX + item.enterDX * (1 - enter) + item.driftX * creep,
    y: item.baseY + item.enterDY * (1 - enter) + item.driftY * creep,
    scale: item.grow !== 0 ? 1 + item.grow * creep : 1,
  };
}
