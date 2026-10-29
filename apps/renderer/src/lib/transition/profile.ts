import type { TrackProfileCore } from './analyze';

/**
 * 一首歌的离线档案（P3）。
 *
 * 在生产端落 localStorage：profile 只有几百字节，几百首歌也就几十 KB，比走 IPC 让主进程
 * 维护一个文件简单得多，而且天然跟着渲染进程的存储配额走。
 */
export interface TrackProfile extends TrackProfileCore {
  /** 歌曲 id（网易云的 `Song.id`）。 */
  songId: number;
  /** 分析算法版本：升级后旧档案作废、自动重算。 */
  version: number;
  /** 什么时候分析的（毫秒时间戳）。 */
  analyzedAt: number;
  /** 那次分析花了多久（毫秒），排障与「分析管线是否过重」的观测点。 */
  analysisMs: number;
}

export const PROFILE_CACHE_KEY = 'pi.automix.profiles.v1';
/** 算法改了就要抬这个数：旧档案的 `version` 对不上就当没有。 */
export const PROFILE_VERSION = 1;
/** 最多留多少条：超了按「最久没分析过」淘汰，防止 localStorage 被慢慢撑满。 */
export const MAX_PROFILES = 400;

/**
 * 淘汰旧档案（纯函数，便于单测）。
 *
 * 按 `analyzedAt` 从旧到新排序，只保留最新的 `max` 条；返回新对象，不改入参。
 */
export function pruneProfiles(
  all: Readonly<Record<string, TrackProfile>>,
  max = MAX_PROFILES,
): Record<string, TrackProfile> {
  const entries = Object.entries(all);
  if (entries.length <= max) return { ...all };
  entries.sort((a, b) => a[1].analyzedAt - b[1].analyzedAt);
  const kept: Record<string, TrackProfile> = {};
  for (const [key, value] of entries.slice(entries.length - max)) kept[key] = value;
  return kept;
}

/** 档案是否可用于当前版本（版本对得上、字段齐全）。 */
export function isUsableProfile(profile: TrackProfile | undefined): profile is TrackProfile {
  return Boolean(profile) && profile!.version === PROFILE_VERSION;
}
