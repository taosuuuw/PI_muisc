/**
 * 把帧层的 `runs`（placement 表）折成**装饰性开放边框**的帧清单（照抄 folia `sonnetFrameDecor.ts` 的语义）。
 *
 * 三层分工：
 * · `sonnetFrameDecor.ts`：选择判据 + 几何常数（照抄 ✓）；
 * · `sonnetFrameDecorShapes.ts`：几何 → 图元清单（照抄为主，两处近似已标注 ✓）；
 * · **本文件**：`runs` → "这一帧要画哪些边框、各自什么档位多大" ✓（对应上游 `buildSonnetFrameDecor` 的入口判断 ✓）。
 *
 * === 与 folia 的差异（照实记，两处）===
 * ① **哈希来源**：上游 `resolveSonnetFrameDecorSpec(segment)` 自己把段文本拼串哈希
 *    （`hashSonnetSeed('[text]:[start]:[end]:frame-decor')` ✓）；
 *    我方**没有那个字符串哈希** ⇒ 改用我们既有的确定性哈希族
 *    `mixSonnetSeed(frameShotSeed + index × SONNET_FRAME_DECOR_SEED_STRIDE, SALT)` ✓
 *    （位运算判据与取档仍是照抄 ✓）；
 * ② **尺寸来源**：上游 placement 带 **真实宽高**（`halfW/halfH` 全靠它 ✓），
 *    而我们的 `SonnetGlyphRun` **没有尺寸字段** ✗ ⇒ 这里**估算**：
 *    横排 `width ≈ graphemeCount × fontPx`（按 1 em/字 ✓）、`height ≈ fontPx × 1.2`（按行高 ✓）；
 *    竖排（`vertical === true`）宽高对调 ✓。**边框大小因此会有出入** ✓（已登记 `CREDITS.md`）。
 * ③ 上游在 `placement.role === 'decoration'` 时**不画**边框 ✓ ⇒ 我们同样**跳过** ✓。
 */

import { mixSonnetSeed } from './sonnetGeo';
import { resolveSonnetFrameDecorSpec } from './sonnetFrameDecor';

/** 每个 run 的种子步长（与背景装饰的 `131` 同族，但 salt 不同 ⇒ 两条线互不相关 ✓）。 */
export const SONNET_FRAME_DECOR_SEED_STRIDE = 131;

/** 本层用的 salt（自定 ✓，只要能跟别处区分开即可 ✓）。 */
export const SONNET_FRAME_DECOR_SEED_SALT = 0x9e3779b9;

/** 行高估算系数（`1.2 em` ✓）。 */
export const SONNET_FRAME_DECOR_LINE_HEIGHT_RATIO = 1.2;

/**
 * 生长时长的倍数（照抄上游：`growDuration = glyphMotionDuration × 1.25` ✓）。
 *
 * ⚠ **差异**：上游的 `glyphMotionDuration` 取的是**整镜**（`shotStartTime → shotEndTime` ✓），
 * 而这里用的是**该 run 自身**的时长（`run.endTime − run.startTime` ✓）——
 * 因为帧层把整镜时长传进来还要多接一路参数 ✗，而 run 自身时长在同一个 shot 内量级相同 ✓。
 * **所以边框的生长节奏可能比上游略快/略慢** ✓（已登记 `CREDITS.md` 待补 ✓）。
 */
export const SONNET_FRAME_DECOR_GROW_DURATION_SCALE = 1.25;

/** 帧层 `runs` 里我们**真正用到**的那几个字段（结构化类型 ⇒ 不绑死 `SonnetGlyphRun` ✓）。 */
export interface SonnetFrameDecorRunLike {
  readonly fontPx: number;
  readonly vertical: boolean;
  readonly rotation: number;
  readonly graphemeCount: number;
  readonly x: number;
  readonly y: number;
  readonly role: string;
  /** 该 run 的时间窗（用来推生长时长 ✓）。 */
  readonly startTime: number;
  readonly endTime: number;
}

export interface SonnetFrameDecorFrame {
  /** 该 run 在 `runs` 里的下标（调试/探针用 ✓）。 */
  readonly index: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly fontSize: number;
  readonly rotation: number;
  readonly variant: number;
  /** **估算**的局部宽高（见文件头差异 ② ✓）。 */
  readonly width: number;
  readonly height: number;
  /** 开始生长（= 该 run 的开始时间 ✓）。 */
  readonly startTime: number;
  /** 生长结束（= `startTime + 时长 × 1.25` ✓）。 */
  readonly endTime: number;
}

/** 估算一条 run 的局部尺寸（估算规则写死在文件头 ✓，这里只实现 ✓）。 */
export function resolveSonnetFrameDecorRunSize(
  run: Pick<SonnetFrameDecorRunLike, 'fontPx' | 'vertical' | 'graphemeCount'>,
): { readonly width: number; readonly height: number } {
  const along = Math.max(1, run.graphemeCount) * run.fontPx;
  const across = run.fontPx * SONNET_FRAME_DECOR_LINE_HEIGHT_RATIO;
  return run.vertical ? { width: across, height: along } : { width: along, height: across };
}

/**
 * 这一帧的边框清单 ✓：跳过 `role === 'decoration'` ✓、按 `applied` 过滤 ✓、
 * 尺寸用估算 ✓、`variant` 照抄取档 ✓。
 */
export function resolveSonnetFrameDecorFrames(
  frameShotSeed: number,
  runs: readonly SonnetFrameDecorRunLike[],
): readonly SonnetFrameDecorFrame[] {
  const frames: SonnetFrameDecorFrame[] = [];
  runs.forEach((run, index) => {
    if (run.role === 'decoration') return;
    const hash = mixSonnetSeed(
      frameShotSeed + index * SONNET_FRAME_DECOR_SEED_STRIDE,
      SONNET_FRAME_DECOR_SEED_SALT,
    );
    const spec = resolveSonnetFrameDecorSpec(hash);
    if (!spec.applied) return;
    const size = resolveSonnetFrameDecorRunSize(run);
    const startTime = run.startTime;
    const growDuration = Math.max(0, run.endTime - run.startTime) * SONNET_FRAME_DECOR_GROW_DURATION_SCALE;
    frames.push({
      index,
      anchorX: run.x,
      anchorY: run.y,
      fontSize: run.fontPx,
      rotation: run.rotation,
      variant: spec.variant,
      width: size.width,
      height: size.height,
      startTime,
      endTime: startTime + growDuration,
    });
  });
  return frames;
}
