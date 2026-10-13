/**
 * 歌词的多源责任链：**同一个契约把五个源串起来，按匹配率挑最合适的那一份**。
 *
 * 与音源解析链（`@pi/resolver`）的思路一致，但判据完全不同：音源追的是「能不能播、音质实不实」，
 * 歌词追的是「**这份歌词是不是这首歌**」。所以这里的核心是 `match.ts` 的三路匹配率，
 * 以及一条「宁可不显示也不显示错」的门槛。
 *
 * 三条设计约束：
 * 1. **不阻塞、不互斥**：五个源并行问，各自有超时；任何一个挂了都只影响自己那一格。
 * 2. **钉死的源优先于「更聪明」**：用户手动选了酷狗，哪怕网易云的匹配率更高也照用户选的。
 *    可预期比自动更值钱——自动挑选解决的是「用户不想选」的那部分场景。
 * 3. **界面要看得到全过程**：返回里带每个源的候选项（匹配率 / 有无翻译 / 有无逐字 / 失败原因），
 *    否则用户只会看到一个说不清来源的歌词页。
 */
import { LYRIC_SOURCE_MODE_LABEL, type Lyric, type LyricCandidateInfo, type LyricSourceMode } from '@pi/shared';
import { matchRate } from './match.js';
import { linesHaveWords, splitPlainText } from './parsers.js';
import { LocalLyricStore } from './store.js';
import type { LyricCandidate, LyricProvider, LyricQuery } from './types.js';

/** 一次解得的结果（已经拍完优先级、算完匹配率）。 */
export interface ResolvedLyric extends Lyric {
  candidates: LyricCandidateInfo[];
}

/** 结果缓存时长。歌词不会变，缓存只为了「切歌来回、重开歌词页」不重复请求。 */
const CACHE_TTL_MS = 30 * 60_000;
/** 缓存条数上限（超过就丢最早的那条）。 */
const CACHE_LIMIT = 64;

/** 单个源的耗时上限，超时就当它没有。 */
const PER_SOURCE_TIMEOUT_MS = Number.parseInt(process.env.PI_LYRIC_TIMEOUT_MS ?? '8000', 10);

/** 钉死某个源时，是否也要把别源的结果算出来（不算＝更快，界面上的候选列表就只有它自己）。 */
const PROBE_ALL_IN_PINNED_MODE = true;

interface CacheEntry {
  at: number;
  value: ResolvedLyric;
}

export interface ResolveOptions {
  mode: LyricSourceMode;
  /** 自动模式下允许参与挑选的源。 */
  enabled: Record<string, boolean>;
  /** 匹配率门槛 0~1。 */
  minMatch: number;
}

export class LyricResolver {
  private readonly providers: LyricProvider[];
  private readonly store: LocalLyricStore;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(providers: LyricProvider[], store: LocalLyricStore) {
    this.providers = providers;
    this.store = store;
  }

  /** 换设置后把缓存清掉（改了源或门槛，之前挑出来的那一份就不能再算数）。 */
  clearCache(): void {
    this.cache.clear();
  }

  async resolve(query: LyricQuery, options: ResolveOptions): Promise<ResolvedLyric> {
    /*
     * 缓存键必须带上**歌名与歌手**，不能只认歌曲 id。
     *
     * 现场验收抓到的：同一个 id 先用「晴天 / 周杰伦」查一次，再用同一个 id 换一个
     * 完全不相干的歌名查第二次，第二次会直接命中第一次的缓存——因为它只看了 `songId`。
     * 平时两个字段是一起变的，所以看不出来；但只要有一条路只改了标题
     * （比如界面先渲染占位名、随后换成真名），就会稳定复现「歌词张冠李戴」。
     */
    const cacheKey =
      `${query.songId}:${query.title}:${query.artists.join('/')}:${options.mode}:${options.minMatch}` +
      `:${Object.keys(options.enabled).filter((id) => options.enabled[id] !== false).join(',')}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const value = await this.compute(query, options);
    this.cache.set(cacheKey, { at: Date.now(), value });
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return value;
  }

  private async compute(query: LyricQuery, options: ResolveOptions): Promise<ResolvedLyric> {
    const pinned: LyricProvider | undefined =
      options.mode === 'auto' ? undefined : this.providers.find((item) => item.id === options.mode);

    // 「用户手动导入的那一份」永远优先：他不是在等匹配，他是在指定用这一份。
    const local = await this.fromLocalImport(query);

    const targets =
      pinned === undefined
        ? this.providers.filter((item) => item.id !== 'local' && options.enabled[item.id] !== false)
        : PROBE_ALL_IN_PINNED_MODE || pinned.id === 'local'
          ? this.providers.filter((item) => item.id !== 'local')
          : [pinned];

    const outcomes = await Promise.all(targets.map((provider) => this.runProvider(provider, query)));

    const infos: LyricCandidateInfo[] = outcomes.map((outcome) => outcome.info);
    // 钉死某一源时，别的源的结果**只用来展示**（用户能看出「自动会挑哪一个」），不参与选择。
    const selectable =
      pinned === undefined
        ? outcomes
        : outcomes.filter((outcome) => outcome.info.source === options.mode);

    const scored = selectable
      .flatMap((outcome) => outcome.scored)
      .sort((left, right) => right.match - left.match);

    const best = scored.find((entry) => entry.match >= options.minMatch) ?? undefined;

    if (best !== undefined) {
      for (const info of infos) if (info.source === best.candidate.source) info.used = true;
      return this.toResolved(best.candidate, best.match, options.mode, infos, query);
    }

    /*
     * 门槛内一份都没有。
     *
     * 钉死某个源时**照旧给它的结果**，哪怕符合率低于门槛——「钉死」这个动作本身就是
     * 用户的判断（他可能就是想要那个平台的版本），此时按门槛拦下来会变成
     * 「我选了酷狗却看到网易云的词」，比给一份 55% 的酷狗词更让人困惑。
     * 界面上会如实标出这个符合率，用户看得见自己钉的是什么。
     */
    if (pinned !== undefined) {
      const pinnedBest = scored[0];
      if (pinnedBest !== undefined) {
        for (const info of infos) if (info.source === pinned.id) info.used = true;
        return this.toResolved(pinnedBest.candidate, pinnedBest.match, options.mode, infos, query);
      }
    }
    if (local !== undefined) {
      for (const info of infos) if (info.source === 'local') info.used = true;
      return this.toResolved(local, 1, options.mode, infos, query);
    }

    const reason = this.explain(options, infos, scored);
    return {
      lines: [],
      translated: [],
      roman: [],
      hasLyric: false,
      source: undefined,
      mode: options.mode,
      candidates: infos,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  /** 跑一个源：计时、兜住异常、把它回的候选逐个算匹配率。**永不抛**。 */
  private async runProvider(
    provider: LyricProvider,
    query: LyricQuery,
  ): Promise<{ info: LyricCandidateInfo; scored: { candidate: LyricCandidate; match: number }[] }> {
    const started = Date.now();
    const base: LyricCandidateInfo = {
      source: provider.id,
      used: false,
      match: 0,
      hasTranslation: false,
      hasWord: false,
      lineCount: 0,
      elapsedMs: 0,
    };
    try {
      /*
       * **整个源共用一份时间预算**，而不是每个请求各给一份。
       *
       * 现场验收抓到的：AMLLDB 那条会依次试五条镜像，每一条都有 8 秒超时，
       * 于是「五条全挂」时这个源要拖 40 秒才认输（实测「起风了」那一跑 14.5 秒），
       * 而歌词页在这期间一直是空的。外面套一层 `Promise.race`，
       * 无论源内部串了几次请求，超了就按「这个源没有」处理。
       */
      const outcome = await Promise.race([
        provider
          .candidates(query, AbortSignal.timeout(PER_SOURCE_TIMEOUT_MS))
          .then((list) => ({ list, timedOut: false })),
        new Promise<{ list: LyricCandidate[]; timedOut: boolean }>((resolve) =>
          setTimeout(() => resolve({ list: [], timedOut: true }), PER_SOURCE_TIMEOUT_MS + 50),
        ),
      ]);
      const candidates = outcome.list;
      const scored = candidates
        .map((candidate) => ({
          candidate,
          match: matchRate(
            { title: query.title, artists: query.artists, durationMs: query.durationMs },
            {
              title: candidate.title,
              artists: candidate.artists,
              ...(candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }),
            },
          ).total,
        }))
        .sort((left, right) => right.match - left.match);
      const top = scored[0];
      return {
        scored,
        info: top === undefined
          ? {
              ...base,
              elapsedMs: Date.now() - started,
              // 超时与「确实没有」是两件事，界面上给的原因要分开。
              reason: outcome.timedOut ? `读取超时（超过 ${PER_SOURCE_TIMEOUT_MS / 1000} 秒）` : '没有这首歌的歌词',
            }
          : {
              ...base,
              title: top.candidate.title,
              artists: top.candidate.artists,
              match: top.match,
              hasTranslation: top.candidate.translated.length > 0,
              hasWord: linesHaveWords(top.candidate.lines),
              lineCount: top.candidate.lines.length,
              elapsedMs: Date.now() - started,
            },
      };
    } catch (error) {
      return {
        scored: [],
        info: {
          ...base,
          elapsedMs: Date.now() - started,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /** 手动导入的那一份（不需要联网，也不算匹配率——它就是用户指定的）。 */
  private async fromLocalImport(query: LyricQuery): Promise<LyricCandidate | undefined> {
    const stored = await this.store.get(query.songId);
    if (stored === undefined) return undefined;
    return {
      source: 'local',
      title: query.title,
      artists: query.artists,
      ...(query.durationMs === undefined ? {} : { durationMs: query.durationMs }),
      lines: stored.lines,
      translated: stored.translated,
      roman: stored.roman,
      raw: stored.raw,
    };
  }

  private toResolved(
    candidate: LyricCandidate,
    match: number,
    mode: LyricSourceMode,
    candidates: LyricCandidateInfo[],
    query: LyricQuery,
  ): ResolvedLyric {
    // 一条时间标签都没有的纯文本（用户导入的 txt）：按行铺开，别让界面空白。
    const lines =
      candidate.lines.length === 0
        ? splitPlainText(candidate.raw)
        : candidate.lines;
    return {
      lines,
      translated: candidate.translated,
      roman: candidate.roman,
      hasLyric: lines.length > 0,
      source: candidate.source,
      mode,
      match: Math.round(match * 1000) / 1000,
      candidates,
      ...(candidate.source === 'local'
        ? {}
        : {
            // 记一下「这一份是从哪首歌匹配来的」，方便用户判断是不是撞了别的版本。
            ...(candidate.title === query.title ? {} : { matchedTitle: candidate.title }),
          }),
    };
  }

  /** 「一份都没挑中」时给界面的一句人话。 */
  private explain(
    options: ResolveOptions,
    infos: readonly LyricCandidateInfo[],
    scored: readonly { match: number }[],
  ): string | undefined {
    if (scored.length > 0) {
      const best = Math.max(...scored.map((entry) => entry.match));
      return `匹配率最高只有 ${Math.round(best * 100)}%，低于门槛 ${Math.round(options.minMatch * 100)}%，已跳过`;
    }
    const responded = infos.filter((info) => info.lineCount > 0).length;
    if (responded === 0) return '所有歌词源都没有这首歌的歌词';
    return undefined;
  }
}

/** 界面上「当前用的是哪个源」的文案。 */
export function describeMode(mode: LyricSourceMode): string {
  return LYRIC_SOURCE_MODE_LABEL[mode];
}
