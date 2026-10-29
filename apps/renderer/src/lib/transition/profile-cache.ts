import {
  PROFILE_CACHE_KEY,
  PROFILE_VERSION,
  pruneProfiles,
  type TrackProfile,
} from './profile';

/**
 * `TrackProfile` 的 localStorage 读写（P3）。
 *
 * 整份 map 一个 key：profile 只有几百字节，几百首歌也就几十 KB，逐条一个 key 反而要处理
 * 「列不出来」的问题。读一次就 memo，写的时候整份回写；配额满了就静默放弃——
 * 档案只是「下次更快」，丢了不影响播放。
 */
let memo: Record<string, TrackProfile> | undefined;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    // 某些沙箱环境下访问 localStorage 会抛 SecurityError。
    return undefined;
  }
}

function loadAll(): Record<string, TrackProfile> {
  if (memo) return memo;
  const store = storage();
  if (!store) {
    memo = {};
    return memo;
  }
  try {
    const raw = store.getItem(PROFILE_CACHE_KEY);
    memo = raw ? (JSON.parse(raw) as Record<string, TrackProfile>) : {};
  } catch {
    memo = {};
  }
  return memo;
}

/** 读一首歌的档案（没有或版本对不上都返回 undefined）。 */
export function readProfile(songId: number): TrackProfile | undefined {
  const profile = loadAll()[String(songId)];
  if (!profile || profile.version !== PROFILE_VERSION) return undefined;
  return profile;
}

/** 写一首歌的档案（会顺带按容量淘汰旧条目）。 */
export function writeProfile(profile: TrackProfile): void {
  const all = loadAll();
  const next = pruneProfiles({ ...all, [String(profile.songId)]: profile });
  memo = next;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PROFILE_CACHE_KEY, JSON.stringify(next));
  } catch {
    // 配额满：放弃落盘，内存里这份仍然可用。
  }
}

/** 当前缓存条数（排障 / 冒烟用）。 */
export function profileCacheSize(): number {
  return Object.keys(loadAll()).length;
}

/** 仅测试用：清掉 memo，让下一次读重新走 localStorage。 */
export function resetProfileCacheForTests(): void {
  memo = undefined;
}
