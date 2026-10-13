import type { Lyric, LyricSourceMode, Song } from '@pi/shared';
import { CH, invoke } from '../bridge';
import { queryClient } from './query-client';
import { lyricQueryKey } from './queries';

/**
 * 歌词预取（用户第五轮第 10 条）。
 *
 * 用户原话：「有些歌一开始就开始唱，但是歌词没加载好，所以我觉得每个歌在加载歌词时
 * **先不播放歌曲**，而是显示原子岛提示」。
 *
 * 实现要点：
 * - **在渲染树之外**跑。播放状态机（`state/player.ts`）不知道 React 的存在，
 *   所以这里直接用那个全局唯一的 `queryClient`（`lib/query-client.ts`）；
 * - 写进的是 `useLyric` **同一个 key**（`lyricQueryKey`）。口径只有一份，
 *   于是界面上那一次查询天然命中缓存、`isPending` 立刻结束，不会「预取了还转圈」；
 * - 已经在跑或已缓存（`staleTime` 10 分钟）时 `prefetchQuery` 是**空操作**，
 *   所以这里不会为了「先加载」而多打一次接口；
 * - 歌词拿不到不算失败（纯音乐、上游没收录），失败就静默咽掉 —— 它只影响
 *   「要不要等」，绝不该把播放卡住或者弹一个红字。
 */
export async function prefetchLyric(song: Song, mode: LyricSourceMode = 'auto'): Promise<void> {
  if (typeof song?.id !== 'number' || song.id <= 0) return;
  try {
    await queryClient.prefetchQuery({
      queryKey: lyricQueryKey(song, mode),
      queryFn: () =>
        invoke(CH.ncmLyric, {
          songId: song.id,
          title: song.name ?? '',
          artists: (song.artists ?? []).map((artist) => artist.name),
          ...(song.durationMs !== undefined && song.durationMs > 0
            ? { durationMs: Math.round(song.durationMs) }
            : {}),
        }),
      staleTime: 10 * 60_000,
    });
  } catch {
    // 歌词取不到不该影响播放，见上面的注释。
  }
}

/**
 * 等歌词的时间上界（毫秒）。
 *
 * 用户本轮第 1、2 条之后，这道闸的语义变了：以前是「等一等等不到就先唱，歌词随后补」，
 * 现在要的是「**歌词没到位就不出声**」（切歌时上一首也不许再响、点播放键也一样）。
 * 所以这个上界不再是「忍到哪儿算哪儿」，而是**防挂死**：
 *
 * 歌词链里每个源都有 8 秒预算，而且**全部并行**跑（`apps/desktop/src/main/lyrics/resolver.ts`
 * 第 104 行的 `Promise.all` + 第 183 行的 `AbortSignal.timeout(PER_SOURCE_TIMEOUT_MS)`），
 * 所以整条链最坏约 8 秒就会给出结论（有词 / 纯音乐 / 这个源没有）。取 9 秒 = 那个最坏值 + 余量：
 * 正常情况都能在闸门内落定，只有网络彻底挂住才撞得上这个上界。
 *
 * 真撞上就照常播——歌词随后到了会自己补上（`useLyric` 那一次查询还在跑）。宁可偶尔「词晚到
 * 一点」，也不能因为某个源不响应就让整首歌永远不出声。
 *
 * `PI_LYRIC_GATE_MS=0`（或负数）可以整条关掉这道闸，退回「立刻播」的老行为。
 */
export const LYRIC_GATE_MS = readGateMs();

function readGateMs(): number {
  // `import.meta.env` 只在打包环境里存在（本仓的 tsconfig 没引 vite 的客户端类型，
  // 所以这里自己收窄一下形状，不去动全局类型声明 —— 一个开关不值得碰全局）。
  const meta = import.meta as { env?: Record<string, string | undefined> };
  const raw = meta.env?.['VITE_PI_LYRIC_GATE_MS'];
  const parsed = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 9000;
}

/** 歌词缓存里已经有这一首了吗（有就不必等）。 */
export function hasCachedLyric(song: Song, mode: LyricSourceMode = 'auto'): boolean {
  return queryClient.getQueryData<Lyric>(lyricQueryKey(song, mode)) !== undefined;
}

/**
 * 这一首的歌词**还在路上**吗（用户本轮第 2 条：点播放键也要等它）。
 *
 * 和 `hasCachedLyric` 的差别就在这一条判的是「落定没落定」而不是「有没有词」：
 * - 已经有数据 ⇒ 不在路上（正常按播放键，一秒都不多等）；
 * - 查过而且**失败**了（纯音乐、上游没收录）⇒ 也不在路上——不然每次按播放键都要白等一个闸门；
 * - 查询还在跑、或者压根还没查过 ⇒ 在路上，该等。
 *
 * 无效 id（0 / 非数字）一律不算「在路上」：那种歌连歌词请求都不会发出去，等它没有意义。
 */
export function isLyricPending(song: Song, mode: LyricSourceMode = 'auto'): boolean {
  // `!(id > 0)` 而不是 `id <= 0`：`NaN` 走 `<=` 会漏过去（与 NaN 比大小永远是 false）。
  if (typeof song?.id !== 'number' || !(song.id > 0)) return false;
  const key = lyricQueryKey(song, mode);
  if (queryClient.getQueryData<Lyric>(key) !== undefined) return false;
  const state = queryClient.getQueryState(key);
  if (state === undefined) return true;
  if (state.status === 'error') return false;
  return state.status === 'pending' || state.fetchStatus === 'fetching';
}
