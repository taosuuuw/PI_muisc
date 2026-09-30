/**
 * 音源健康检查与自动降权（docs/PLAN.md 任务组 H8）。
 *
 * 为什么必须有：第三方音源（UNM 上游、LX 脚本）随平台反爬随时失效。
 * 没有降权机制时，用户每次点歌都要在一个已经死掉的源上白等 8 秒超时——
 * 「莫名播不了」的体验比「这个源不可用」更糟。
 *
 * 降权策略刻意保守：
 * - 只有**硬失败**（抛错 / 超时 / 探针拿不到音频）才累计，连续 `failureThreshold` 次才降权；
 * - `null`（未匹配到）只记 `missed` 计数，不降权——LX 脚本本来就只覆盖部分平台，
 *   把「这首歌它没有」当成「它坏了」会误杀正常音源；
 * - 降权是**临时**的（`cooldownMs` 后自动恢复），并且可以手动 `reset`。
 */

export interface SourceHealth {
  sourceId: string;
  /** 连续硬失败次数；一次成功即清零。 */
  consecutiveFailures: number;
  /** 被临时降权的截止时间（ms epoch）；未降权则不存在。 */
  demotedUntil?: number;
  lastError?: string;
  lastOkAt?: number;
  lastFailureAt?: number;
  lastMissAt?: number;
  /** 累计硬失败次数。 */
  failed: number;
  /** 累计成功次数（含降级标注的结果）。 */
  ok: number;
  /** 累计「未匹配到」（这个源没有这首歌），仅作观察，不影响可用性。 */
  missed: number;
  /**
   * 累计「有货但不够好」——拿到了可播地址，却因为试听片段、虚标降级而没能满足请求档位。
   *
   * 与 {@link missed} 分开统计：`missed` 是「它没有这首歌」，`rejected` 是「它有，但给的东西
   * 配不上用户要的音质」。两者混在一起时，用户看到「未匹配 40 次」会以为音源坏了，
   * 实际上是它一直在给 128k——这是完全不同的排障方向。
   */
  rejected: number;
}

export interface SourceHealthOptions {
  /** 连续硬失败达到几次就降权。 */
  failureThreshold?: number;
  /** 降权持续多久（毫秒）。 */
  cooldownMs?: number;
}

export interface SourceAvailability {
  available: boolean;
  health: SourceHealth;
  /** 仍在降权时，距离自动恢复还有多少毫秒。 */
  remainingMs?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

export class SourceHealthRegistry {
  private readonly entries = new Map<string, SourceHealth>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options: SourceHealthOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /** 责任链在尝试某个源之前先问一句：它现在可用吗？ */
  availability(sourceId: string, now = Date.now()): SourceAvailability {
    // 返回副本：调用方（责任链、UI）只该读，绝不能通过这个对象改到登记表内部状态。
    const health = { ...this.entry(sourceId) };
    if (health.demotedUntil !== undefined && health.demotedUntil > now) {
      return { available: false, health, remainingMs: health.demotedUntil - now };
    }
    return { available: true, health };
  }

  recordSuccess(sourceId: string, now = Date.now()): void {
    const health = this.entry(sourceId);
    health.ok += 1;
    health.consecutiveFailures = 0;
    health.lastOkAt = now;
    // 成功即恢复：不想让用户因为冷却期还没过而继续走更差的源。
    health.demotedUntil = undefined;
    health.lastError = undefined;
  }

  recordFailure(sourceId: string, error: string | undefined, now = Date.now()): void {
    const health = this.entry(sourceId);
    health.failed += 1;
    health.consecutiveFailures += 1;
    health.lastFailureAt = now;
    health.lastError = error;
    if (health.consecutiveFailures >= this.failureThreshold) {
      health.demotedUntil = now + this.cooldownMs;
    }
  }

  recordMiss(sourceId: string, now = Date.now()): void {
    const health = this.entry(sourceId);
    health.missed += 1;
    health.lastMissAt = now;
  }

  /** 「有货但不够好」：试听片段、虚标降级。同样不降权——它明明在正常工作。 */
  recordRejected(sourceId: string, now = Date.now()): void {
    const health = this.entry(sourceId);
    health.rejected += 1;
    health.lastMissAt = now;
  }

  /** 供 UI / 音质日志页读取的快照（复制一份，避免调用方改到内部状态）。 */
  snapshot(now = Date.now()): SourceHealth[] {
    return [...this.entries.values()].map((health) => ({
      ...health,
      ...(health.demotedUntil !== undefined && health.demotedUntil > now
        ? {}
        : { demotedUntil: undefined }),
    }));
  }

  /** 手动恢复（UI 上的「重试这个音源」）。不传 id 表示全部恢复。 */
  reset(sourceId?: string): void {
    // 指定 id 时只动**已登记**的源：给一个不存在的 id 不该在快照里凭空造出一个
    // 「幽灵音源」（全 0 记录），那会让设置页凭空多出一行、还让人以为它被降权过。
    const targets =
      sourceId === undefined
        ? [...this.entries.keys()]
        : this.entries.has(sourceId)
          ? [sourceId]
          : [];
    for (const id of targets) {
      const health = this.entry(id);
      health.consecutiveFailures = 0;
      health.demotedUntil = undefined;
      health.lastError = undefined;
    }
  }

  private entry(sourceId: string): SourceHealth {
    const existing = this.entries.get(sourceId);
    if (existing) return existing;
    const created: SourceHealth = {
      sourceId,
      consecutiveFailures: 0,
      failed: 0,
      ok: 0,
      missed: 0,
      rejected: 0,
    };
    this.entries.set(sourceId, created);
    return created;
  }
}
