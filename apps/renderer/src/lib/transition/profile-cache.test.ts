import { beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_VERSION, pruneProfiles, type TrackProfile } from './profile';
import {
  profileCacheSize,
  readProfile,
  resetProfileCacheForTests,
  writeProfile,
} from './profile-cache';

/**
 * 缓存测试跑在纯 Node 里（没有 localStorage）：`profile-cache` 会退化成内存 memo，
 * 正好用来验「写入→读回」「版本作废」「容量淘汰」这三条，不依赖浏览器。
 */
function profileOf(songId: number, analyzedAt = Date.now()): TrackProfile {
  return {
    songId,
    version: PROFILE_VERSION,
    durationMs: 200_000,
    bpm: 120,
    beatOffsetSec: 0.5,
    beatPeriodSec: 0.5,
    confidence: 0.8,
    tail: { silenceSec: 1.2, activityRatio: 0.4 },
    head: { silenceSec: 0.2, startsHot: false },
    analyzedAt,
    analysisMs: 42,
  };
}

beforeEach(() => {
  resetProfileCacheForTests();
});

describe('档案缓存', () => {
  it('写进去能读回来', () => {
    writeProfile(profileOf(101));
    expect(readProfile(101)?.songId).toBe(101);
    expect(profileCacheSize()).toBe(1);
  });

  it('没有的那首返回 undefined（不会瞎编）', () => {
    expect(readProfile(999)).toBeUndefined();
  });

  it('版本对不上就当没有（算法升级后自动重算）', () => {
    writeProfile({ ...profileOf(102), version: PROFILE_VERSION + 1 });
    expect(readProfile(102)).toBeUndefined();
  });
});

describe('容量淘汰', () => {
  it('超过上限时只留最新的 max 条', () => {
    const all: Record<string, TrackProfile> = {};
    for (let i = 0; i < 5; i += 1) all[String(i)] = profileOf(i, 1000 + i);
    const kept = pruneProfiles(all, 3);
    expect(Object.keys(kept).sort()).toEqual(['2', '3', '4']);
  });

  it('没超上限时原样保留（不排序、不改内容）', () => {
    const all: Record<string, TrackProfile> = { a: profileOf(1, 5), b: profileOf(2, 9) };
    expect(Object.keys(pruneProfiles(all, 10)).sort()).toEqual(['a', 'b']);
  });
});
