/**
 * 歌词多源模块的内部类型。
 *
 * 放在 `apps/desktop/src/main` 下（而不是新开一个 `@pi/lyrics` 包），
 * 理由和 `downloads.ts` / `library.ts` 一样：它只用 Node 内置的 fetch/zlib/crypto
 * 与 `@pi/shared` 的领域类型，不需要别的包引用它；多一个包只会多一层构建与依赖配置。
 *
 * 出参的**线上形状**仍然是 `@pi/shared` 的 `Lyric`（`ncm:lyric` 通道），
 * 这里只定义「源怎么实现」这一侧的类型。
 */
import type { LyricLine, LyricSourceId } from '@pi/shared';

/**
 * 一次歌词查询要的全部歌曲信息。
 *
 * 除官方的 `songId` 外，其余字段都是给**跨平台匹配**用的：QQ 与酷狗都没有网易云的
 * 歌曲 id，只能按「歌名 + 歌手 + 时长」去它们的搜索接口里找同一首歌。
 * 匹配率算得出来多少，取决于这里给得全不全——只有 id 时非官方源全都会落空。
 */
export interface LyricQuery {
  /** 网易云歌曲 id（官方源与 AMLLDB 都用它）。 */
  songId: number;
  title: string;
  artists: readonly string[];
  /** 毫秒。跨平台匹配的第三道判据（前两道是歌名与歌手），缺了就只能凭名字对。 */
  durationMs?: number;
}

/** 一个源取回来的**候选**（可能命中多首，这里每首一条）。 */
export interface LyricCandidate {
  source: LyricSourceId;
  /** 源上那一首的标题（用于算匹配率，也用于在界面上说明「匹配到哪一首」）。 */
  title: string;
  artists: readonly string[];
  /** 源上那一首的时长（毫秒）；拿不到就不填。 */
  durationMs?: number;
  /** 源上的稳定 id（网易云 / AMLLDB 是歌曲 id；QQ 是 songmid；酷狗是 hash）。 */
  remoteId?: string;
  lines: LyricLine[];
  /** 译文行（与 `lines` 时间轴独立）。没有就是空数组。 */
  translated: LyricLine[];
  /** 音译行（罗马音等）。没有就是空数组。 */
  roman: LyricLine[];
  /** 纯文本兜底（解析失败时给用户看原文）。 */
  raw: string;
}

/**
 * 一个源的实现。
 *
 * `candidates()` 的契约：
 * - **命中与否都不抛**：没搜到、接口挂了、超时，统一返回空数组。歌词是增强功能，
 *   任何一个源出问题都不该让「听歌」这件事失败。
 * - 允许一次返回多条（搜索命中了多个版本），排序交给上层的打分器。
 */
export interface LyricProvider {
  readonly id: LyricSourceId;
  /** 界面上的名字（`LyricSourceId` → 中文名的唯一真相在 `@pi/shared` 的 `LYRIC_SOURCE_LABEL`）。 */
  readonly label: string;
  /** 这个源本身是否提供逐字（逐词）时间轴；用于界面上的能力标签与「没有逐字」时的解释。 */
  readonly supportsWord: boolean;
  /** 是否需要联网（本地导入的那个源不需要）。 */
  readonly needsNetwork: boolean;
  /**
   * 兜底源：**主力源一个都没命中时才问它**（目前只有 Lrclib）。
   *
   * 为什么要这个标记：解析器是并行问所有源、等最慢的那个回。兜底源是免费的社区接口，
   * 偶尔要好几秒（本机实测撞到过 8 秒超时），不标出来的话每次取词都会白等它一轮 ——
   * 哪怕平台早就把词给了。判定与两段式流程见 `resolver.ts` 的 `compute()`。
   */
  readonly fallback?: boolean;
  candidates(query: LyricQuery, signal: AbortSignal): Promise<LyricCandidate[]>;
}

/** 源在网络请求上的通用超时（毫秒）。歌词是「等得起的增强」，超时就当这个源没有。 */
export const LYRIC_SOURCE_TIMEOUT_MS = Number.parseInt(
  process.env.PI_LYRIC_TIMEOUT_MS ?? '8000',
  10,
);
