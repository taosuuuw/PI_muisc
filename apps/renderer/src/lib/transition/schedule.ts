/**
 * 过渡调度的纯判定（P2）。
 *
 * 真正的调度在 `state/player.ts` 的看门狗里（读 `currentTime`、开定时器、动真元素），
 * 那部分不好测；而**什么时候该预取、什么时候该开始交叉**才是容易写错的地方：
 * 提前量太晚就变成空档，太早又会在用户手动切歌前白解析一首。
 * 所以判定单独放这里，用纯函数钉住。
 */

/** 交叉淡化时长：P2 先固定；P3 有了尾部静音分析再按素材调。 */
export const CROSSFADE_SEC = 5;

/** 距歌尾多少秒开始解析下一首。PI 的解析链要联网，给足余量。 */
export const PREFETCH_LEAD_SEC = 12;

/**
 * 过渡状态机：
 *
 * ```
 * idle ──(arm)──▶ arming ──(地址到手)──▶ ready ──(交叉)──▶ fading ──▶ idle
 * ```
 */
export type TransitionPhase = 'idle' | 'arming' | 'ready' | 'fading';

/**
 * 现在该不该去解析下一首。
 *
 * 上界 `leadSec`：太早解析会浪费流量，而且用户很可能在这之前就手动切歌了。
 * 下界 `crossfadeSec + 1`：离交叉点太近就没意义了——解析链通常要几秒，
 * 解析完歌也快结束了，不如让尾部淡出兜底。
 */
export function shouldArmNext(
  remainingSec: number,
  phase: TransitionPhase,
  leadSec = PREFETCH_LEAD_SEC,
  crossfadeSec = CROSSFADE_SEC,
): boolean {
  if (phase !== 'idle') return false;
  if (!Number.isFinite(remainingSec)) return false;
  if (remainingSec <= 0) return false;
  return remainingSec <= leadSec && remainingSec > crossfadeSec + 1;
}

/**
 * 现在该不该开始交叉。
 *
 * 只认 `ready`：地址没到手就交叉等于把两首歌都切哑。上界留 50ms 余量——看门狗 200ms
 * 才跳一次，正好卡在 5.0 上会等下一跳，尾巴就短了。
 */
export function shouldStartCrossfade(
  remainingSec: number,
  phase: TransitionPhase,
  crossfadeSec = CROSSFADE_SEC,
): boolean {
  if (phase !== 'ready') return false;
  if (!Number.isFinite(remainingSec) || remainingSec <= 0) return false;
  return remainingSec <= crossfadeSec + 0.05;
}
