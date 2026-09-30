/**
 * L0 官方音源（docs/PLAN.md 任务组 H2「官方 lossless/hires 协商」）。
 *
 * 这一层的职责只有一件：**在官方音质阶梯上从上往下试，直到拿到一首能完整播的歌**。
 *
 * 为什么需要阶梯而不是「要什么给什么」：
 * - 官方 `/song/url/v1` 对没有更高音质的歌会返回 `url: null`（不是报错），
 *   直接问 lossless 经常一首歌就白解析了；
 * - 对 VIP 歌曲，非 VIP 账号拿到的是一个**只有 30 秒的试听直链**——
 *   比不给更糟，因为用户会听到一半突然停；
 * - 所以「降一级再试」是常态，「试听片段」只作为最后兜底，并且必须打上 `trial` 标记。
 *
 * 只有这一层能用 cookie（docs/PLAN.md §2.5 账号安全红线）。
 */

import { qualityRank, type Quality, type ResolvedAudio } from '@pi/shared';
import type { MatchInput, MusicSource } from '@pi/source-core';

export const OFFICIAL_SOURCE_ID = 'wy';
export const OFFICIAL_SOURCE_LABEL = '网易云官方';

/** 官方阶梯里的档位。`flac`/`flac24bit` 是第三方源才有的档位，官方不认。 */
export const OFFICIAL_QUALITIES: readonly Quality[] = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jymaster',
];

/**
 * 从期望音质往下排的尝试顺序。
 *
 * 例：期望 `lossless` → `['lossless','exhigh','higher','standard']`。
 * 期望 `hires` 时会先试 hires（没有）再试 lossless（有）——这正是官方最常见的
 * 「hires 未上架但有无损」场景。
 */
export function officialLadder(max: Quality): Quality[] {
  const ceiling = qualityRank(max);
  return OFFICIAL_QUALITIES.filter((quality) => qualityRank(quality) <= ceiling).sort(
    (a, b) => qualityRank(b) - qualityRank(a),
  );
}

/**
 * 官方直链的回源请求头。
 *
 * 网易云 CDN 校验 Referer：裸请求直链经常得到 403 或一段 HTML 错误页而不是音频字节。
 * 这个头**只跟随官方解析结果**（`ResolvedAudio.upstreamHeaders`），
 * 不会被套用到第三方直链上——那样会被对方当成盗链。
 */
export const OFFICIAL_UPSTREAM_HEADERS: Record<string, string> = {
  referer: 'https://music.163.com/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

/** 官方音源只需要 ncm 客户端的这一个方法，单独声明便于测试时替换。 */
export interface OfficialUrlProvider {
  songUrl(
    songId: number,
    level: Quality,
  ): Promise<{ url?: string; level?: string; freeTrial?: boolean }>;
}

export interface OfficialSourceOptions {
  id?: string;
  label?: string;
  /** 回源头；默认 {@link OFFICIAL_UPSTREAM_HEADERS}。 */
  headers?: Record<string, string>;
}

export function createOfficialSource(
  provider: OfficialUrlProvider,
  options: OfficialSourceOptions = {},
): MusicSource {
  const id = options.id ?? OFFICIAL_SOURCE_ID;
  const label = options.label ?? OFFICIAL_SOURCE_LABEL;
  const headers = options.headers ?? OFFICIAL_UPSTREAM_HEADERS;

  return {
    id,
    label,
    tier: 'official',
    // 只有官方源能用 cookie；第三方源一律 false（docs/PLAN.md §2.5）。
    needsCookie: true,
    qualities: OFFICIAL_QUALITIES,

    async match(input: MatchInput, signal: AbortSignal): Promise<ResolvedAudio | null> {
      let trialFallback: ResolvedAudio | null = null;

      for (const level of officialLadder(input.quality)) {
        if (signal.aborted) throw new Error('解析已取消');
        const result = await provider.songUrl(input.songId, level);
        if (!result.url) continue;

        const audio: ResolvedAudio = {
          url: result.url,
          // 如实记录这一档，而不是用户原本想要的档位——UI 上的徽标要对得上实际听到的东西。
          quality: level,
          // 占位：真实格式由责任链的字节嗅探覆盖，绝不让「接口自称」变成 UI 结论。
          probe: { container: 'unknown', evidence: 'pending-probe' },
          via: id,
          upstreamHeaders: headers,
          ...(result.freeTrial ? { trial: true } : {}),
        };

        if (result.freeTrial) {
          // 试听片段先留着当兜底，但继续往下降级找完整版（exhigh 常常是完整的）。
          trialFallback ??= audio;
          continue;
        }
        return audio;
      }

      return trialFallback;
    },
  };
}
