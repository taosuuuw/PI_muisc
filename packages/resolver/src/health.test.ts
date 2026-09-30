/**
 * SourceHealthRegistry 的单元测试（docs/PLAN.md 任务组 H8）。
 *
 * 这个文件守住 M2.5 的两条承诺：
 * 1. 「坏掉的音源自动走下一层」——只有**连续硬失败**达到阈值才临时降权，冷却到期自动恢复，
 *    一次成功立刻恢复（不让用户因为残留的冷却期继续走更差的源）；
 * 2. 「这首歌它没有 ≠ 它坏了」——`recordMiss`（未匹配到）只累计 `missed`，绝不降权，
 *    也不会把连续失败计数清零。
 *
 * 全部用例离线运行：时间全部由调用方注入的 `now` 推进，不做任何真实等待。
 */

import { describe, expect, it } from 'vitest';
import { SourceHealthRegistry } from './health.js';

/** 随便挑一个固定的假「当前时刻」，让所有时间断言可复现。 */
const T0 = 1_000_000;

describe('SourceHealthRegistry · 初始状态', () => {
  it('没有登记过的音源默认为可用、计数全为 0', () => {
    const registry = new SourceHealthRegistry();

    const availability = registry.availability('unm:qq', T0);

    expect(availability.available).toBe(true);
    expect(availability.remainingMs).toBeUndefined();
    expect(availability.health.sourceId).toBe('unm:qq');
    expect(availability.health.consecutiveFailures).toBe(0);
    expect(availability.health.failed).toBe(0);
    expect(availability.health.ok).toBe(0);
    expect(availability.health.missed).toBe(0);
    expect(availability.health.demotedUntil).toBeUndefined();
  });
});

describe('SourceHealthRegistry · 硬失败累计与降权', () => {
  it('连续失败达到默认阈值 3 次才降权，前两次仍然可用', () => {
    const registry = new SourceHealthRegistry();

    registry.recordFailure('unm:qq', '超时', T0);
    registry.recordFailure('unm:qq', '超时', T0);
    expect(registry.availability('unm:qq', T0).available).toBe(true);

    registry.recordFailure('unm:qq', '超时', T0);
    const demoted = registry.availability('unm:qq', T0);

    expect(demoted.available).toBe(false);
    expect(demoted.health.consecutiveFailures).toBe(3);
    expect(demoted.health.failed).toBe(3);
    expect(demoted.health.lastError).toBe('超时');
    expect(demoted.health.lastFailureAt).toBe(T0);
    // demotedUntil 必须在未来，且 remainingMs 为正、与截止时间对得上
    expect(demoted.health.demotedUntil).toBeGreaterThan(T0);
    expect(demoted.remainingMs ?? 0).toBeGreaterThan(0);
    expect(demoted.health.demotedUntil).toBe(T0 + (demoted.remainingMs ?? 0));
  });

  it('failureThreshold 可配置（例如 2 次就降权）', () => {
    const registry = new SourceHealthRegistry({ failureThreshold: 2 });

    registry.recordFailure('lx:test:kw', '脚本报错', T0);
    expect(registry.availability('lx:test:kw', T0).available).toBe(true);

    registry.recordFailure('lx:test:kw', '脚本报错', T0);
    expect(registry.availability('lx:test:kw', T0).available).toBe(false);
  });

  it('冷却时间过去后自动恢复可用（用注入的 now 推进，不真实等待）', () => {
    const registry = new SourceHealthRegistry({ cooldownMs: 1_000 });

    registry.recordFailure('unm:qq', '超时', 0);
    registry.recordFailure('unm:qq', '超时', 0);
    registry.recordFailure('unm:qq', '超时', 0);

    expect(registry.availability('unm:qq', 999).available).toBe(false);
    expect(registry.availability('unm:qq', 999).remainingMs).toBe(1);
    // 冷却截止那一刻（demotedUntil > now 为假）就恢复
    expect(registry.availability('unm:qq', 1_000).available).toBe(true);
    expect(registry.availability('unm:qq', 1_000).remainingMs).toBeUndefined();
  });

  it('降权期间再次硬失败会从当前时刻重新开始冷却', () => {
    const registry = new SourceHealthRegistry({ cooldownMs: 1_000 });

    for (let i = 0; i < 3; i += 1) registry.recordFailure('unm:qq', '超时', 0);
    registry.recordFailure('unm:qq', '超时', 500);

    expect(registry.availability('unm:qq', 1_499).available).toBe(false);
    expect(registry.availability('unm:qq', 1_499).remainingMs).toBe(1);
    expect(registry.availability('unm:qq', 1_500).available).toBe(true);
  });
});

describe('SourceHealthRegistry · 未匹配到（miss）', () => {
  it('第三方没货只累计 missed，不降权', () => {
    const registry = new SourceHealthRegistry();

    registry.recordMiss('lx:test:kw', T0);
    registry.recordMiss('lx:test:kw', T0);
    registry.recordMiss('lx:test:kw', T0);
    registry.recordMiss('lx:test:kw', T0);

    const availability = registry.availability('lx:test:kw', T0);

    expect(availability.available).toBe(true);
    expect(availability.health.missed).toBe(4);
    expect(availability.health.consecutiveFailures).toBe(0);
    expect(availability.health.failed).toBe(0);
    expect(availability.health.demotedUntil).toBeUndefined();
    expect(availability.health.lastMissAt).toBe(T0);
  });

  it('miss 既不清零也不累加连续失败计数', () => {
    const registry = new SourceHealthRegistry();

    registry.recordFailure('unm:qq', '超时', T0);
    registry.recordFailure('unm:qq', '超时', T0);
    registry.recordMiss('unm:qq', T0);
    expect(registry.availability('unm:qq', T0).available).toBe(true);

    // 两次硬失败 + 一次 miss 之后再来一次硬失败，仍然算「连续 3 次」
    registry.recordFailure('unm:qq', '超时', T0);
    const availability = registry.availability('unm:qq', T0);

    expect(availability.available).toBe(false);
    expect(availability.health.consecutiveFailures).toBe(3);
    expect(availability.health.missed).toBe(1);
  });
});

describe('SourceHealthRegistry · 成功即恢复', () => {
  it('一次 recordSuccess 立刻清掉降权与连续失败，但保留累计统计', () => {
    const registry = new SourceHealthRegistry();

    for (let i = 0; i < 3; i += 1) registry.recordFailure('unm:qq', '超时', 0);
    registry.recordMiss('unm:qq', 0);
    expect(registry.availability('unm:qq', 0).available).toBe(false);

    registry.recordSuccess('unm:qq', 100);
    const availability = registry.availability('unm:qq', 100);

    expect(availability.available).toBe(true);
    expect(availability.remainingMs).toBeUndefined();
    expect(availability.health.consecutiveFailures).toBe(0);
    expect(availability.health.demotedUntil).toBeUndefined();
    expect(availability.health.lastError).toBeUndefined();
    expect(availability.health.lastOkAt).toBe(100);
    // 累计值不受成功影响：它们只做观察 / 排障
    expect(availability.health.ok).toBe(1);
    expect(availability.health.failed).toBe(3);
    expect(availability.health.missed).toBe(1);
  });
});

describe('SourceHealthRegistry · snapshot', () => {
  it('返回每个源的副本，且过期的降权不再显示', () => {
    const registry = new SourceHealthRegistry({ cooldownMs: 1_000 });
    for (let i = 0; i < 3; i += 1) registry.recordFailure('unm:qq', '超时', 0);
    registry.recordMiss('lx:test:kw', 0);

    const snapshot = registry.snapshot(0);
    expect(snapshot.map((health) => health.sourceId)).toEqual(['unm:qq', 'lx:test:kw']);
    expect(snapshot.find((health) => health.sourceId === 'unm:qq')?.demotedUntil).toBe(1_000);

    // 副本语义：改快照不会污染登记表内部状态
    const demoted = snapshot.find((health) => health.sourceId === 'unm:qq');
    if (demoted) demoted.consecutiveFailures = 99;
    expect(registry.availability('unm:qq', 0).health.consecutiveFailures).toBe(3);

    // 冷却过期后，快照里不再带 demotedUntil（UI 不该再显示「降权中」）
    expect(
      registry.snapshot(1_000).find((health) => health.sourceId === 'unm:qq')?.demotedUntil,
    ).toBeUndefined();
    // 但快照只是观察，不改内部状态：内部仍然记着那个截止时间
    expect(registry.availability('unm:qq', 1_000).health.demotedUntil).toBe(1_000);
    expect(registry.availability('unm:qq', 1_000).available).toBe(true);
  });
});

describe('SourceHealthRegistry · reset', () => {
  it('reset(sourceId) 只恢复指定源，reset() 恢复全部', () => {
    const registry = new SourceHealthRegistry();
    for (let i = 0; i < 3; i += 1) registry.recordFailure('unm:qq', 'qq 挂了', 0);
    for (let i = 0; i < 3; i += 1) registry.recordFailure('lx:test:kw', 'kw 挂了', 0);

    registry.reset('unm:qq');
    const restored = registry.availability('unm:qq', 0);

    expect(restored.available).toBe(true);
    expect(restored.health.consecutiveFailures).toBe(0);
    expect(restored.health.demotedUntil).toBeUndefined();
    expect(restored.health.lastError).toBeUndefined();
    // reset 不是清空统计：累计失败次数仍然留作证据
    expect(restored.health.failed).toBe(3);
    // 别的源不受影响
    expect(registry.availability('lx:test:kw', 0).available).toBe(false);

    registry.reset();
    expect(registry.availability('lx:test:kw', 0).available).toBe(true);
    expect(registry.availability('lx:test:kw', 0).health.consecutiveFailures).toBe(0);
  });
});
