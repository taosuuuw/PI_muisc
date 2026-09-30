import type { AudioProbe, Quality, ResolvedAudio, ResolveAttempt, ResolveResult } from '@pi/shared';
import { isLosslessQuality, qualityFromProbe } from '@pi/source-core';
import type { MatchInput, MusicSource } from '@pi/source-core';
import { SourceHealthRegistry } from './health.js';
import { isLosslessContainer } from './probe.js';

export type { MatchInput, MusicSource } from '@pi/source-core';

/**
 * 拉取直链文件头用于嗅探。由主进程注入，便于测试时替换。
 *
 * 参数是整个解析结果而不是裸 URL：探针必须带上该来源自己的回源请求头
 * （官方要 Referer，第三方直链带 Referer 反而会被拒）。
 */
export type ProbeFn = (audio: ResolvedAudio, signal: AbortSignal) => Promise<AudioProbe>;

export interface ResolverOptions {
  /** 每个源的超时。第三方源挂掉时不能把整个播放卡住。 */
  perSourceTimeoutMs?: number;
  /** 音源健康登记表；传入后责任链会跳过被临时降权的源，并回报成败。 */
  health?: SourceHealthRegistry;
  onAttempt?: (attempt: ResolveAttempt) => void;
}

export class ResolverChain {
  constructor(
    private readonly sources: readonly MusicSource[],
    private readonly probe: ProbeFn,
    private readonly options: ResolverOptions = {},
  ) {}

  /**
   * 按顺序尝试各音源，返回第一个可用结果。
   * 若结果实测不是无损而我们期望无损，会继续往后找更好的源（除非已到链尾）。
   */
  async resolve(input: MatchInput): Promise<ResolveResult> {
    const attempts: ResolveAttempt[] = [];
    const perSourceTimeout = this.options.perSourceTimeoutMs ?? 8000;
    const health = this.options.health;
    let fallback: ResolvedAudio | null = null;

    for (const source of this.sources) {
      if (!source.qualities.includes(input.quality)) {
        this.record(attempts, {
          sourceId: source.id,
          ok: false,
          detail: `不支持音质 ${input.quality}`,
          elapsedMs: 0,
        });
        continue;
      }

      if (health) {
        const availability = health.availability(source.id);
        if (!availability.available) {
          this.record(attempts, {
            sourceId: source.id,
            ok: false,
            detail: `已临时降权（连续失败 ${availability.health.consecutiveFailures} 次，${
              Math.ceil((availability.remainingMs ?? 0) / 1000)
            }s 后自动恢复）`,
            elapsedMs: 0,
          });
          continue;
        }
      }

      const started = Date.now();
      const controller = new AbortController();
      // 源可以自带预算（第三方聚合串行试多个平台，8 秒不够）。
      const timer = setTimeout(() => controller.abort(), source.timeoutMs ?? perSourceTimeout);
      try {
        // 超时由我们兜底，而不是只靠源自觉：`Promise.race` 保证哪怕某个源
        // （第三方脚本、UNM 的串行试探）挂在 await 里不动，这里也一定会往下走。
        // 先注册 abort 的是源自己（它把 listener 建在 match 内部），所以「配合的源」
        // 报出的具体原因仍然会赢下竞速，我们只是补上最后一道保险。
        const raw = await raceAbort(
          source.match(input, controller.signal),
          controller.signal,
          `音源 ${source.id} 超时`,
        );
        if (!raw) {
          health?.recordMiss(source.id);
          this.record(attempts, {
            sourceId: source.id,
            ok: false,
            detail: '未匹配到可用音源',
            elapsedMs: Date.now() - started,
          });
          continue;
        }

        // 实测校验：声称的和实际的必须对上，否则按实测改写音质并降级标注。
        const probe = await this.probe(raw, controller.signal);
        const actualQuality = qualityFromProbe(probe, raw.quality);
        const verified: ResolvedAudio = {
          ...raw,
          probe,
          quality: actualQuality,
          // 被探针改写过就留一份原始自称：UI 要能说清「它自称 X、实测 Y」，
          // 音质日志也要留证据（M2.5 的「音质以实测为准」）。
          ...(actualQuality !== raw.quality ? { claimedQuality: raw.quality } : {}),
        };
        const trusted = !raw.trial && this.reconcile(raw.quality, probe);

        this.record(attempts, {
          sourceId: source.id,
          ok: true,
          detail: raw.trial
            ? `仅提供试听片段（${actualQuality}），继续尝试其它音源`
            : trusted
              ? `实测 ${probe.container}${probe.sampleRate ? ` ${probe.sampleRate}Hz` : ''} @ ${actualQuality}`
              : `实测为 ${probe.container} @ ${actualQuality}，达不到声称的 ${raw.quality}，已降级标注`,
          elapsedMs: Date.now() - started,
        });

        if (trusted) {
          health?.recordSuccess(source.id);
          return { audio: verified, attempts };
        }
        // 拿到了可播的、只是不够好：不算这个源失败（它在正常工作），但也不是「没这首歌」，
        // 所以单独记 rejected，然后继续往后找更好的。
        health?.recordRejected(source.id);
        fallback ??= verified;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        health?.recordFailure(source.id, detail);
        this.record(attempts, {
          sourceId: source.id,
          ok: false,
          detail,
          elapsedMs: Date.now() - started,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    return { audio: fallback, attempts };
  }

  /** 声称无损但实测不是 → 不可信，降级为「继续往后找」。 */
  private reconcile(claimed: Quality, probe: AudioProbe): boolean {
    if (!isLosslessQuality(claimed)) return true;
    return isLosslessContainer(probe.container);
  }

  private record(into: ResolveAttempt[], attempt: ResolveAttempt): void {
    into.push(attempt);
    this.options.onAttempt?.(attempt);
  }
}

/** 兜底源：永远返回 null。用于「用户关闭了第三方音源」时占位，让链结构保持完整。 */
export class NullSource implements MusicSource {
  readonly tier = 'aggregator' as const;
  readonly qualities: readonly Quality[] = [
    'standard',
    'higher',
    'exhigh',
    'lossless',
    'hires',
    'jymaster',
    'flac',
    'flac24bit',
  ];
  readonly needsCookie = false;

  constructor(
    readonly id: string,
    readonly label: string,
  ) {}

  async match(): Promise<ResolvedAudio | null> {
    return null;
  }
}

/**
 * 把「源的 Promise」与「signal 被中止」竞速。
 *
 * 为什么不只靠 `signal`：`AbortSignal` 是**请求**取消，不是取消保证。一个忽略 signal
 * 的源（第三方脚本卡在网络调用、UNM 的 Promise.any 还在等最慢的平台）会让
 * `await` 永远不返回——而「8 秒拿不到就换下一个源」是播放体验的硬承诺。
 * 注意这里不会真的终止那个还在跑的调用（JS 没有抢占式取消），但它至少不再阻塞责任链。
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    let fallback: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      if (fallback !== undefined) clearTimeout(fallback);
    };
    const onAbort = (): void => {
      // 先给源自己一个「说话」的机会：它往往能给出更具体的原因（连接被拒、脚本报错、
      // 平台无货），比我们这句通用超时有用得多。它若在一轮事件循环里没反应，我们再兜底，
      // 这样「配合的源」报出的原因永远赢下竞速，而「不配合的源」也不会把链挂住。
      fallback = setTimeout(() => {
        cleanup();
        reject(new Error(message));
      }, 0);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
