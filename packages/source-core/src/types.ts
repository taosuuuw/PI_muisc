import type { Quality, ResolvedAudio, SourceTier } from '@pi/shared';

// 层级的唯一定义在 @pi/shared（IPC 契约与 UI 也要用同一套值）。
export type { SourceTier };

/**
 * 音源契约（docs/PLAN.md §2.5 / ADR-0001）。
 *
 * 所有音源——官方（L0）、UNM 多平台匹配（L1）、聚合（L2）、LX 自定义源脚本（L3）、
 * 本地文件（L4）——都只实现这一个接口。责任链只认接口不认来源：
 * 某个第三方源挂了，删掉一个实现即可，调用方一行都不用改。
 */
export interface MatchInput {
  /** 网易云歌曲 id。官方源与 UNM 用它，LX 脚本通常只用「歌名 + 歌手」。 */
  songId: number;
  /** 期望音质（已被账号能力夹逼过）。 */
  quality: Quality;
  /** 歌名与歌手用于第三方源匹配（它们只认「歌名 + 歌手」而不是 id）。 */
  title: string;
  artists: string[];
  albumName?: string;
  durationMs?: number;
}

/** 一个音源实现。`tier` 决定它在责任链里的位置（见 docs/ADR/0001）。 */
export interface MusicSource {
  /** 稳定 id：`wy` / `unm:qq` / `lx:<脚本名>:<源 key>` / `local`。 */
  readonly id: string;
  /** 展示给用户的名字，例如「网易云官方」「QQ 音乐」。 */
  readonly label: string;
  readonly tier: SourceTier;
  /** 该源声称支持的音质；实际下发仍以字节嗅探为准（见 resolver 的 probe）。 */
  readonly qualities: readonly Quality[];
  /** 是否需要登录 cookie。第三方源必须为 false（见 §2.5 账号安全红线）。 */
  readonly needsCookie: boolean;
  /**
   * 这个源自己的超时预算（毫秒）。不填就用责任链的默认值（8 秒）。
   *
   * 为什么允许逐源覆盖：官方源一次 HTTP 就完事，而第三方聚合要在多个平台之间
   * 串行试探，实测「酷狗无货 → 咪咕无货 → 波点出 FLAC」要 4–6 秒，冷启动时更长。
   * 一刀切的短超时会把「慢但真能出无损」这条腿直接砍掉。
   */
  readonly timeoutMs?: number;
  match(input: MatchInput, signal: AbortSignal): Promise<ResolvedAudio | null>;
}
