/**
 * 锁住官方音源「降级阶梯 + 试听片段兜底」的承诺（packages/source-official/src/index.ts）：
 *
 * 1. 阶梯必须**从期望档位往下排**，官方没有的档位（flac/flac24bit）永远不出现；
 *    请求超出官方能力时退化成整条官方阶梯，而不是空数组；
 * 2. 官方源是唯一能用 cookie 的一层（`needsCookie === true`），tier 是 'official'；
 * 3. 最高档没 url 时逐级下降，`quality` 反映**实际用到的那一档**（不是用户想要的档位）；
 * 4. `freeTrial` 的档位只作兜底：先继续往下找完整版；全都没有时返回试听并标 `trial: true`
 *    （VIP 歌只给 30 秒，必须如实标注，不能让 UI 假装是整首歌）；
 * 5. 所有档位都拿不到 url 时返回 `null`，不抛错；
 * 6. 回源头必须带 `referer: https://music.163.com/`（第三方直链绝不能带，官方必须有）。
 *
 * 全部用假 provider，**不联网**：provider 是被注入的依赖（OfficialUrlProvider）。
 */

import { describe, expect, it } from 'vitest';
import { qualityRank } from '@pi/shared';
import type { Quality, ResolvedAudio } from '@pi/shared';
import type { MatchInput, MusicSource } from '@pi/source-core';
import {
  OFFICIAL_QUALITIES,
  OFFICIAL_SOURCE_ID,
  OFFICIAL_SOURCE_LABEL,
  OFFICIAL_UPSTREAM_HEADERS,
  createOfficialSource,
  officialLadder,
} from './index.js';
import type { OfficialUrlProvider } from './index.js';

function input(quality: Quality): MatchInput {
  return { songId: 621_234, quality, title: '晴天', artists: ['周杰伦'] };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** 假 provider：按档位查表答 url，并把被问到的档位按顺序记进 calls。 */
function providerFrom(
  table: Partial<Record<Quality, { url?: string; freeTrial?: boolean }>>,
  calls: Quality[] = [],
): OfficialUrlProvider {
  return {
    async songUrl(_songId: number, level: Quality) {
      calls.push(level);
      return table[level] ?? {};
    },
  };
}

/** 断言解析出了音频并收窄类型（expect 不做类型收窄，所以显式抛）。 */
async function matchOrThrow(
  source: MusicSource,
  quality: Quality,
  abortSignal: AbortSignal = signal(),
): Promise<ResolvedAudio> {
  const audio = await source.match(input(quality), abortSignal);
  if (!audio) throw new Error('期望解析出音频，实际拿到 null');
  return audio;
}

/* ------------------------------------------------------------------ *
 * officialLadder
 * ------------------------------------------------------------------ */

describe('officialLadder', () => {
  it('期望 lossless 时从高到低降级，带 exhigh/higher/standard 兜底', () => {
    expect(officialLadder('lossless')).toEqual(['lossless', 'exhigh', 'higher', 'standard']);
  });

  it('期望 hires 时先试 hires 再落到 lossless（官方最常见的「hires 未上架但有无损」）', () => {
    expect(officialLadder('hires')).toEqual(['hires', 'lossless', 'exhigh', 'higher', 'standard']);
  });

  it('期望 jymaster 时覆盖整条官方阶梯（从高到低）', () => {
    expect(officialLadder('jymaster')).toEqual([...OFFICIAL_QUALITIES].reverse());
    expect(officialLadder('jymaster')).toEqual([
      'jymaster',
      'hires',
      'lossless',
      'exhigh',
      'higher',
      'standard',
    ]);
  });

  it('期望 standard 时只有一档，不会去问更高档位', () => {
    expect(officialLadder('standard')).toEqual(['standard']);
  });

  it('请求超出官方能力的档位（flac/flac24bit）时退化成整条官方阶梯，且不含官方不认的档位', () => {
    for (const beyond of ['flac', 'flac24bit'] as Quality[]) {
      const ladder = officialLadder(beyond);

      expect(ladder).toEqual([...OFFICIAL_QUALITIES].reverse());
      expect(ladder).not.toContain('flac');
      expect(ladder).not.toContain('flac24bit');
    }
  });

  it('不变量：任何档位的阶梯都是「max 往下到 standard」的连续一段，音质单调不升', () => {
    const descending = [...OFFICIAL_QUALITIES].reverse();

    for (const max of OFFICIAL_QUALITIES) {
      const ladder = officialLadder(max);

      // 阶梯是官方档位表里「max 往下到 standard」的连续尾段（不是从头取）。
      expect(ladder).toEqual(descending.slice(descending.length - ladder.length));
      expect(ladder).toContain(max);
      expect(ladder.at(-1)).toBe('standard');

      const ranks = ladder.map((quality) => qualityRank(quality));
      const strictlyDescending = ranks.every(
        (rank, index) => index === 0 || rank < (ranks[index - 1] ?? -1),
      );
      expect(strictlyDescending).toBe(true);
      for (const rank of ranks) {
        expect(rank).toBeLessThanOrEqual(qualityRank(max));
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * createOfficialSource
 * ------------------------------------------------------------------ */

describe('createOfficialSource 元数据', () => {
  it('id/label/tier=official，且是唯一需要 cookie 的一层', () => {
    const source = createOfficialSource(providerFrom({}));

    expect(source.id).toBe(OFFICIAL_SOURCE_ID);
    expect(source.id).toBe('wy');
    expect(source.label).toBe(OFFICIAL_SOURCE_LABEL);
    expect(source.tier).toBe('official');
    expect(source.needsCookie).toBe(true);
    expect(source.qualities).toEqual(OFFICIAL_QUALITIES);
  });

  it('id/label/headers 可被注入（便于别处复用这一层）', () => {
    const overrides = { referer: 'https://example.invalid/' };
    const source = createOfficialSource(providerFrom({}), {
      id: 'wy:test',
      label: '测试官方源',
      headers: overrides,
    });

    expect(source.id).toBe('wy:test');
    expect(source.label).toBe('测试官方源');
  });
});

describe('createOfficialSource 降级阶梯', () => {
  it('最高档拿不到 url 时逐级下降，quality 反映实际用到的那一档', async () => {
    const calls: Quality[] = [];
    const provider = providerFrom({ higher: { url: 'https://cdn.example.com/higher.mp3' } }, calls);

    const audio = await matchOrThrow(createOfficialSource(provider), 'lossless');

    expect(calls).toEqual(['lossless', 'exhigh', 'higher']);
    expect(audio.url).toBe('https://cdn.example.com/higher.mp3');
    // 如实记录实际档位，而不是用户原本想要的 lossless。
    expect(audio.quality).toBe('higher');
    expect(audio.via).toBe('wy');
    // 格式交给责任链的字节嗅探，官方源不自己下结论。
    expect(audio.probe).toEqual({ container: 'unknown', evidence: 'pending-probe' });
    expect(audio.trial).toBeUndefined();
  });

  it('第一个能出完整版的档位立即返回，不再往下多问', async () => {
    const calls: Quality[] = [];
    const provider = providerFrom(
      {
        lossless: { url: 'https://cdn.example.com/lossless.flac' },
        exhigh: { url: 'https://cdn.example.com/exhigh.mp3' },
      },
      calls,
    );

    const audio = await matchOrThrow(createOfficialSource(provider), 'lossless');

    expect(calls).toEqual(['lossless']);
    expect(audio.quality).toBe('lossless');
  });

  it('期望档位高于账号能力时，从阶梯最高档开始试', async () => {
    const calls: Quality[] = [];
    const provider = providerFrom({ exhigh: { url: 'https://cdn.example.com/exhigh.mp3' } }, calls);

    const audio = await matchOrThrow(createOfficialSource(provider), 'jymaster');

    expect(calls).toEqual(['jymaster', 'hires', 'lossless', 'exhigh']);
    expect(audio.quality).toBe('exhigh');
  });

  it('所有档位都拿不到 url 时返回 null，不抛错', async () => {
    const calls: Quality[] = [];
    const provider = providerFrom({}, calls);
    const source = createOfficialSource(provider);

    await expect(source.match(input('lossless'), signal())).resolves.toBeNull();
    // 整条阶梯都问过了才放弃。
    expect(calls).toEqual(['lossless', 'exhigh', 'higher', 'standard']);
  });
});

describe('createOfficialSource 试听片段兜底', () => {
  it('某档返回 freeTrial 时继续往下找完整版，最终用完整版', async () => {
    const calls: Quality[] = [];
    const provider = providerFrom(
      {
        lossless: { url: 'https://cdn.example.com/lossless-trial.mp3', freeTrial: true },
        exhigh: { url: 'https://cdn.example.com/exhigh-full.mp3' },
      },
      calls,
    );

    const audio = await matchOrThrow(createOfficialSource(provider), 'lossless');

    expect(calls).toEqual(['lossless', 'exhigh']);
    expect(audio.url).toBe('https://cdn.example.com/exhigh-full.mp3');
    expect(audio.quality).toBe('exhigh');
    // 拿到完整版就绝不能标 trial，否则 UI 会误报「只有 30 秒」。
    expect(audio.trial).toBeUndefined();
  });

  it('全都不行时返回试听片段并标 trial=true（VIP 歌只给 30 秒的诚实标注）', async () => {
    const calls: Quality[] = [];
    const provider = providerFrom(
      {
        lossless: { url: 'https://cdn.example.com/lossless-trial.mp3', freeTrial: true },
        exhigh: { url: 'https://cdn.example.com/exhigh-trial.mp3', freeTrial: true },
      },
      calls,
    );

    const audio = await matchOrThrow(createOfficialSource(provider), 'lossless');

    // 一直找到最低档才收手。
    expect(calls).toEqual(['lossless', 'exhigh', 'higher', 'standard']);
    // 兜底取最先遇到的（也就是最高档的）试听片段。
    expect(audio.url).toBe('https://cdn.example.com/lossless-trial.mp3');
    expect(audio.quality).toBe('lossless');
    expect(audio.trial).toBe(true);
  });

  it('只有低档的试听片段可用时也能兜住，并如实标注档位', async () => {
    const provider = providerFrom({
      higher: { url: 'https://cdn.example.com/higher-trial.mp3', freeTrial: true },
    });

    const audio = await matchOrThrow(createOfficialSource(provider), 'lossless');

    expect(audio.quality).toBe('higher');
    expect(audio.trial).toBe(true);
  });
});

describe('createOfficialSource 回源请求头', () => {
  it('官方直链的回源头上必须带 referer: https://music.163.com/', async () => {
    expect(OFFICIAL_UPSTREAM_HEADERS.referer).toBe('https://music.163.com/');

    const provider = providerFrom({ lossless: { url: 'https://cdn.example.com/a.flac' } });
    const audio = await matchOrThrow(createOfficialSource(provider), 'lossless');

    expect(audio.upstreamHeaders).toEqual(OFFICIAL_UPSTREAM_HEADERS);
    expect(audio.upstreamHeaders?.referer).toBe('https://music.163.com/');
  });

  it('注入的 headers 会替代默认值（便于测试与镜像调试）', async () => {
    const overrides = { referer: 'https://mirror.invalid/' };
    const provider = providerFrom({ lossless: { url: 'https://cdn.example.com/a.flac' } });
    const source = createOfficialSource(provider, { headers: overrides });

    const audio = await matchOrThrow(source, 'lossless');

    expect(audio.upstreamHeaders).toEqual(overrides);
  });
});

describe('createOfficialSource 取消', () => {
  it('调用前已被取消时直接抛「解析已取消」，不发任何请求', async () => {
    const calls: Quality[] = [];
    const provider = providerFrom({}, calls);
    const controller = new AbortController();
    controller.abort();

    await expect(
      createOfficialSource(provider).match(input('lossless'), controller.signal),
    ).rejects.toThrow('解析已取消');
    expect(calls).toEqual([]);
  });
});
