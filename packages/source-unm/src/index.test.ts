/**
 * `@pi/source-unm` 行为锁（详见 `docs/ADR/0001-音源解析链.md`）。
 *
 * 这个包把 UnblockNeteaseMusic（UNM）当**库**内嵌，作为官方音源失败后的第三方兜底。
 * 它有几条不显眼、但一回归就会造成线上事故的承诺，本文件负责把它们钉住：
 *
 * 1. 码率 → 音质档位：UNM 只给 `br`，`999000` 是 FLAC 的魔法值（`fLaC` 被 decode 成 999
 *    再乘 1000），其余按 320k / 192k 分档，拿不到码率时一律兜底 standard。
 * 2. TTL 缓存：成功结果缓存 10 分钟、失败/未匹配负缓存 1 分钟，
 *    避免连点「下一首」把第三方接口打成限流。
 * 3. 「不允许第三方无损」是**策略**而非源的能力：缓存命中时依然要复查，
 *    而且策略性丢弃**绝不写缓存**——用户一改设置就必须立刻生效。
 * 4. 失败不是 Error：UNM 默认路径抛 `AggregateError`，`FOLLOW_SOURCE_ORDER` 模式下会
 *    reject 裸字符串，`check()` 甚至 `reject(undefined)`，所以不能 `instanceof Error` 硬猜。
 * 5. 超时：UNM 的 `match()` 不吃 `AbortSignal`，只能靠竞速，且必须抛「UNM 匹配超时」。
 * 6. 第三方直链**绝不能**带网易 Referer（带了会被上游当盗链拒绝）。
 *
 * 全程离线：`load` 一律注入假实现，绝不 `require('@unblockneteasemusic/server')`、
 * 绝不发起任何网络请求。
 */

import { describe, expect, it } from 'vitest';
import type { Quality, ResolvedAudio } from '@pi/shared';
import type { MatchInput, MusicSource } from '@pi/source-core';
import {
  UNM_CACHE_TTL_MS,
  UNM_DEFAULT_PROVIDERS,
  UNM_FLAC_BR,
  UNM_MATCH_TIMEOUT_MS,
  UNM_MISS_TTL_MS,
  UNM_SOURCE_ID,
  UnmCache,
  createUnmSource,
  describeUnmFailure,
  qualityFromBitrate,
} from './index.js';
import type { UnmAudioData, UnmMatchFn } from './index.js';

/* ------------------------------------------------------------------ *
 * 测试脚手架（全部离线：时钟与 loader 都是注入的）
 * ------------------------------------------------------------------ */

const SONG: MatchInput = {
  songId: 1_860_016,
  quality: 'exhigh',
  title: '测试曲目',
  artists: ['测试歌手'],
};

function input(overrides: Partial<MatchInput> = {}): MatchInput {
  return { ...SONG, ...overrides };
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function resolved(url: string, quality: Quality = 'standard'): ResolvedAudio {
  return { url, quality, probe: { container: 'unknown', evidence: 'test' }, via: UNM_SOURCE_ID };
}

interface LoaderSpy {
  load: () => UnmMatchFn;
  calls: () => number;
  lastSongId: () => number | undefined;
  lastSources: () => readonly string[] | undefined;
}

/** 假 loader：只记账，绝不碰真实第三方包。 */
function spyLoader(
  impl: (songId: number, sources?: readonly string[]) => Promise<UnmAudioData>,
): LoaderSpy {
  let calls = 0;
  const seen: { songId?: number; sources?: readonly string[] } = {};
  const matchFn: UnmMatchFn = async (id, sources) => {
    calls += 1;
    seen.songId = id;
    seen.sources = sources;
    return impl(id, sources);
  };
  return {
    load: () => matchFn,
    calls: () => calls,
    lastSongId: () => seen.songId,
    lastSources: () => seen.sources,
  };
}

async function matchOk(
  source: MusicSource,
  matchInput: MatchInput,
  signal: AbortSignal = freshSignal(),
): Promise<ResolvedAudio> {
  const audio = await source.match(matchInput, signal);
  if (!audio) throw new Error(`期望 match 返回结果，实际是 null（quality=${matchInput.quality}）`);
  return audio;
}

/* ------------------------------------------------------------------ *
 * qualityFromBitrate
 * ------------------------------------------------------------------ */

describe('qualityFromBitrate', () => {
  it('UNM 的 FLAC 魔法值 999000 映射到 flac 档', () => {
    expect(UNM_FLAC_BR).toBe(999_000);
    expect(qualityFromBitrate(999_000)).toBe('flac');
  });

  it('够到 320k（含 320000/321000）记 exhigh', () => {
    expect(qualityFromBitrate(320_000)).toBe('exhigh');
    expect(qualityFromBitrate(321_000)).toBe('exhigh');
    expect(qualityFromBitrate(998_999)).toBe('exhigh');
  });

  it('192k 档记 higher', () => {
    expect(qualityFromBitrate(192_000)).toBe('higher');
    expect(qualityFromBitrate(319_999)).toBe('higher');
  });

  it('128k 与 96k 都落到 standard', () => {
    expect(qualityFromBitrate(128_000)).toBe('standard');
    expect(qualityFromBitrate(96_000)).toBe('standard');
    expect(qualityFromBitrate(191_999)).toBe('standard');
  });

  it('0 / null / undefined 都当 standard 兜底，不抛错', () => {
    expect(qualityFromBitrate(0)).toBe('standard');
    expect(qualityFromBitrate(null)).toBe('standard');
    expect(qualityFromBitrate(undefined)).toBe('standard');
  });
});

/* ------------------------------------------------------------------ *
 * 源自身的元数据
 * ------------------------------------------------------------------ */

describe('createUnmSource 元数据', () => {
  it('id / tier / needsCookie / timeoutMs 符合第三方兜底的约定', () => {
    const source = createUnmSource({ load: () => async () => ({ url: 'https://x/y' }) });

    expect(source.id).toBe('unm');
    expect(source.id).toBe(UNM_SOURCE_ID);
    expect(source.tier).toBe('unm');
    // 第三方源永远不碰 cookie（docs/PLAN.md §2.5 账号安全红线）。
    expect(source.needsCookie).toBe(false);
    // UNM 要串行试多个平台，用自己的 20 秒预算而不是责任链默认的 8 秒。
    expect(source.timeoutMs).toBe(UNM_MATCH_TIMEOUT_MS);
    expect(source.timeoutMs).toBe(20_000);
  });

  it('默认平台顺序是 bodian → kugou → migu', () => {
    // bodian 排第一：本机实测只有它能出货（3.8–5.9s 返回 FLAC），
    // 酷狗 114ms 就 No audioData!、咪咕同样无货。先问能出货的那家，延迟减半。
    expect([...UNM_DEFAULT_PROVIDERS]).toEqual(['bodian', 'kugou', 'migu']);
  });

  it('需要外部二进制或登录 cookie 的平台不默认启用', () => {
    for (const platform of ['ytdlp', 'qq', 'joox', 'bilibili']) {
      expect(UNM_DEFAULT_PROVIDERS).not.toContain(platform);
    }
  });
});

/* ------------------------------------------------------------------ *
 * match：正常命中
 * ------------------------------------------------------------------ */

describe('createUnmSource.match 正常命中', () => {
  it('无损结果：via/quality/中性回源头/probe 证据都如实上报', async () => {
    const loader = spyLoader(async () => ({
      url: 'https://cdn.example/unm.flac',
      br: UNM_FLAC_BR,
      source: 'bodian',
    }));
    const source = createUnmSource({ load: loader.load, now: fakeClock().now });

    const audio = await matchOk(source, input({ quality: 'lossless' }));

    expect(audio.via).toBe('unm');
    expect(audio.quality).toBe('flac');
    expect(audio.url).toBe('https://cdn.example/unm.flac');
    // 真实格式交给责任链的字节嗅探，UNM 说的不算数。
    expect(audio.probe.container).toBe('unknown');
    // 证据里要能看出「哪个平台、什么码率」，排障时全靠这一句。
    expect(audio.probe.evidence).toContain('bodian');
    expect(audio.probe.evidence).toContain('999kbps');
    expect(audio.probe.evidence).toContain('unm');
    expect(loader.calls()).toBe(1);
  });

  it('第三方直链只带中性头：有 user-agent、绝不能有 referer', async () => {
    const loader = spyLoader(async () => ({
      url: 'https://cdn.example/unm.flac',
      br: UNM_FLAC_BR,
      source: 'bodian',
    }));
    const source = createUnmSource({ load: loader.load });

    const audio = await matchOk(source, input({ quality: 'lossless' }));

    expect(audio.upstreamHeaders).toBeDefined();
    const keys = Object.keys(audio.upstreamHeaders ?? {}).map((key) => key.toLowerCase());
    expect(keys).toContain('user-agent');
    // 网易 Referer 属于官方源；第三方直链带上它会被对方当盗链拒绝。
    expect(keys).not.toContain('referer');
  });

  it('320k 命中记 exhigh，证据里是 320kbps', async () => {
    const loader = spyLoader(async () => ({
      url: 'https://cdn.example/unm.mp3',
      br: 320_000,
      source: 'kugou',
    }));
    const source = createUnmSource({ load: loader.load });

    const audio = await matchOk(source, input({ quality: 'exhigh' }));

    expect(audio.quality).toBe('exhigh');
    expect(audio.probe.evidence).toContain('kugou');
    expect(audio.probe.evidence).toContain('320kbps');
  });

  it('调用 UNM 时传的是网易歌曲 id 与平台顺序', async () => {
    const loader = spyLoader(async () => ({ url: 'https://x/y', br: 320_000, source: 'kugou' }));
    const source = createUnmSource({ load: loader.load });

    await matchOk(source, input({ songId: 42 }));

    expect(loader.lastSongId()).toBe(42);
    // 顺序只在 FOLLOW_SOURCE_ORDER=true 时有意义：串行试探、先成功先返回。
    expect(loader.lastSources()).toEqual(['bodian', 'kugou', 'migu']);
    expect(loader.lastSources()).toEqual([...UNM_DEFAULT_PROVIDERS]);
  });

  it('providers 选项会覆盖默认顺序', async () => {
    const loader = spyLoader(async () => ({ url: 'https://x/y', br: 320_000, source: 'migu' }));
    const source = createUnmSource({ load: loader.load, providers: ['migu', 'kugou'] });

    await matchOk(source, input());

    expect(loader.lastSources()).toEqual(['migu', 'kugou']);
  });
});

/* ------------------------------------------------------------------ *
 * match：「不允许第三方无损」是策略，优先级高于缓存
 * ------------------------------------------------------------------ */

describe('createUnmSource.match 无损策略', () => {
  it('allowLossless=false 时丢弃无损，且这条策略结论不进缓存', async () => {
    const loader = spyLoader(async () => ({
      url: 'https://cdn.example/unm.flac',
      br: UNM_FLAC_BR,
      source: 'bodian',
    }));
    let allow = false;
    const source = createUnmSource({ load: loader.load, allowLossless: () => allow });
    const query = input({ quality: 'lossless' });

    expect(await source.match(query, freshSignal())).toBeNull();
    expect(loader.calls()).toBe(1);

    // 用户刚把开关改回 true：必须重新走到 loader，而不是拿到上一次策略丢弃写下的缓存。
    allow = true;
    const audio = await matchOk(source, query);
    expect(audio.quality).toBe('flac');
    expect(loader.calls()).toBe(2);
  });

  it('缓存命中时依然复查开关：策略优先于缓存，且不删缓存', async () => {
    const loader = spyLoader(async () => ({
      url: 'https://cdn.example/unm.flac',
      br: UNM_FLAC_BR,
      source: 'bodian',
    }));
    let allow = true;
    const source = createUnmSource({ load: loader.load, allowLossless: () => allow });
    const query = input({ quality: 'lossless' });

    expect((await matchOk(source, query)).quality).toBe('flac');

    // 关掉开关：旧缓存里的无损不能漏出去。
    allow = false;
    expect(await source.match(query, freshSignal())).toBeNull();
    // 这次是缓存命中后的策略判定，没有再去打扰第三方。
    expect(loader.calls()).toBe(1);

    // 再打开：原缓存还在（策略丢弃不写缓存、也不清缓存），依旧不用重新请求。
    allow = true;
    expect((await matchOk(source, query)).quality).toBe('flac');
    expect(loader.calls()).toBe(1);
  });

  it('allowLossless 缺省是「允许」，无损正常下发', async () => {
    const loader = spyLoader(async () => ({
      url: 'https://cdn.example/unm.flac',
      br: UNM_FLAC_BR,
      source: 'bodian',
    }));
    const source = createUnmSource({ load: loader.load });

    expect((await matchOk(source, input({ quality: 'lossless' }))).quality).toBe('flac');
  });
});

/* ------------------------------------------------------------------ *
 * match：TTL 缓存
 * ------------------------------------------------------------------ */

describe('createUnmSource.match TTL 缓存', () => {
  it('成功结果缓存 10 分钟：TTL 内不再调用 loader，过期后重新调用', async () => {
    const clock = fakeClock();
    const loader = spyLoader(async () => ({
      url: 'https://x/a.mp3',
      br: 320_000,
      source: 'kugou',
    }));
    const source = createUnmSource({ load: loader.load, now: clock.now });
    const query = input({ quality: 'exhigh' });

    await matchOk(source, query);
    expect(loader.calls()).toBe(1);

    clock.advance(UNM_CACHE_TTL_MS - 1);
    await matchOk(source, query);
    expect(loader.calls()).toBe(1); // 仍在 10 分钟窗口内

    clock.advance(1); // 正好到 expiresAt：expiresAt <= now 即过期
    await matchOk(source, query);
    expect(loader.calls()).toBe(2);
  });

  it('缓存键带上期望档位：同曲不同档位互不串味', async () => {
    const loader = spyLoader(async () => ({
      url: 'https://x/a.mp3',
      br: 320_000,
      source: 'kugou',
    }));
    const source = createUnmSource({ load: loader.load });

    await matchOk(source, input({ quality: 'standard' }));
    await matchOk(source, input({ quality: 'exhigh' }));

    expect(loader.calls()).toBe(2);
  });

  it('可以注入外部 UnmCache 并真的被使用', async () => {
    const cache = new UnmCache();
    const loader = spyLoader(async () => ({
      url: 'https://x/a.mp3',
      br: 320_000,
      source: 'kugou',
    }));
    const source = createUnmSource({ load: loader.load, cache });

    await matchOk(source, input());
    expect(cache.size).toBe(1);

    await matchOk(source, input());
    expect(loader.calls()).toBe(1);
  });

  it('loader 抛错时错误原样冒泡，并把这次失败负缓存到 miss TTL', async () => {
    const clock = fakeClock();
    const boom = new Error('所有平台都没匹配到（No audioData!）');
    const loader = spyLoader(async () => {
      throw boom;
    });
    const source = createUnmSource({ load: loader.load, now: clock.now });
    const query = input({ quality: 'exhigh' });

    // 失败要给调用方看见（责任链靠它记录 attempts），不能被吞成 null。
    await expect(source.match(query, freshSignal())).rejects.toBe(boom);
    expect(loader.calls()).toBe(1);

    // miss TTL 内：不再打扰第三方，直接给 null。
    expect(await source.match(query, freshSignal())).toBeNull();
    expect(loader.calls()).toBe(1);

    clock.advance(UNM_MISS_TTL_MS);
    await expect(source.match(query, freshSignal())).rejects.toBe(boom);
    expect(loader.calls()).toBe(2);
  });

  it('UNM 返回空 url 视为未匹配：给 null 而不是抛错，并负缓存', async () => {
    const clock = fakeClock();
    const loader = spyLoader(async () => ({ br: 320_000, source: 'kugou' }));
    const source = createUnmSource({ load: loader.load, now: clock.now });
    const query = input();

    expect(await source.match(query, freshSignal())).toBeNull();
    expect(await source.match(query, freshSignal())).toBeNull();
    expect(loader.calls()).toBe(1);

    clock.advance(UNM_MISS_TTL_MS);
    expect(await source.match(query, freshSignal())).toBeNull();
    expect(loader.calls()).toBe(2);
  });

  it('loader 本身加载失败（连 require 都没成功）也走同一套冒泡语义', async () => {
    const loadError = new Error('@unblockneteasemusic/server 没有导出 match 函数，版本可能变了');
    const source = createUnmSource({
      load: () => {
        throw loadError;
      },
    });

    await expect(source.match(input(), freshSignal())).rejects.toBe(loadError);
  });
});

/* ------------------------------------------------------------------ *
 * match：超时（UNM 不吃 AbortSignal，只能竞速）
 * ------------------------------------------------------------------ */

describe('createUnmSource.match 超时', () => {
  it('signal 已经 abort 时立刻以「UNM 匹配超时」失败', async () => {
    const controller = new AbortController();
    controller.abort();
    const loader = spyLoader(async () => ({ url: 'https://x/a.mp3', br: 320_000 }));
    const source = createUnmSource({ load: loader.load });

    const error = await source.match(input(), controller.signal).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('UNM 匹配超时');
  });

  it('匹配过程中 abort 也以超时收场（第三方卡住时不无限等）', async () => {
    const controller = new AbortController();
    // 永不 settle：模拟 UNM 卡在串行试探上，而责任链已经放弃这轮解析。
    const loader = spyLoader(() => new Promise<UnmAudioData>(() => {}));
    const source = createUnmSource({ load: loader.load });

    const pending = source.match(input(), controller.signal);
    controller.abort();

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('UNM 匹配超时');
    expect(loader.calls()).toBe(1);
  });

  it('调用方取消不写负缓存：取消不是「这个源没有货」', async () => {
    const loader = spyLoader(async () => ({ url: 'https://x/a.mp3', br: 320_000 }));
    const source = createUnmSource({ load: loader.load });
    const cancelled = new AbortController();
    cancelled.abort();

    await expect(source.match(input(), cancelled.signal)).rejects.toThrow('UNM 匹配超时');

    // 同一个键、干净 signal：必须真的再去问一次第三方。
    // 若取消被写成负缓存，这里会静默返回 null，用户跳歌一次就等于这首歌被封一分钟。
    const audio = await source.match(input(), freshSignal());
    expect(audio?.url).toBe('https://x/a.mp3');
    expect(loader.calls()).toBe(2);
  });

  it('负缓存时长从失败时刻算起（跑满一次超时不该让一分钟缩水）', async () => {
    const clock = fakeClock();
    const loader = spyLoader(async () => {
      clock.advance(19_000);
      throw new Error('boom');
    });
    const source = createUnmSource({ load: loader.load, now: clock.now });
    const query = input({ quality: 'exhigh' });

    await expect(source.match(query, freshSignal())).rejects.toThrow('boom');

    // 从调用开始算的话（60 秒基准），此刻 64 秒早就过期了；从失败时刻算（79 秒）就还在负缓存里。
    clock.advance(45_000);
    expect(await source.match(query, freshSignal())).toBeNull();
    expect(loader.calls()).toBe(1);

    clock.advance(16_000);
    await expect(source.match(query, freshSignal())).rejects.toThrow('boom');
    expect(loader.calls()).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * describeUnmFailure：失败不一定是 Error
 * ------------------------------------------------------------------ */

describe('describeUnmFailure', () => {
  it('AggregateError：把每个平台的原因拼成一句', () => {
    const error = new AggregateError([new Error('酷狗无货'), 'No audioData!'], 'all failed');
    expect(describeUnmFailure(error)).toBe('所有平台都没匹配到（酷狗无货；No audioData!）');
  });

  it('AggregateError 里什么都没带时也给人话', () => {
    expect(describeUnmFailure(new AggregateError([], 'all failed'))).toBe('所有平台都没匹配到');
  });

  it('AggregateError 允许嵌套 AggregateError', () => {
    const nested = new AggregateError([new Error('咪咕 2.1s 无货')], 'inner');
    expect(describeUnmFailure(new AggregateError([nested], 'outer'))).toBe(
      '所有平台都没匹配到（所有平台都没匹配到（咪咕 2.1s 无货））',
    );
  });

  it('普通 Error 取 message', () => {
    expect(describeUnmFailure(new Error('请求超时'))).toBe('请求超时');
  });

  it('裸字符串：FOLLOW_SOURCE_ORDER 模式下 UNM 就是这么 reject 的', () => {
    expect(describeUnmFailure('No audioData!')).toBe('No audioData!');
  });

  it('undefined：check() 失败时会 reject(undefined)', () => {
    expect(describeUnmFailure(undefined)).toBe(
      '匹配被拒绝（UNM 在探测失败时会 reject(undefined)）',
    );
  });

  it('其它怪东西退回 String()，绝不假设 instanceof Error', () => {
    expect(describeUnmFailure(403)).toBe('403');
    expect(describeUnmFailure(null)).toBe('null');
    expect(describeUnmFailure({ code: 403 })).toBe('[object Object]');
  });
});

/* ------------------------------------------------------------------ *
 * UnmCache：注入时钟，不真的等
 * ------------------------------------------------------------------ */

describe('UnmCache', () => {
  it('没设过的键返回 undefined', () => {
    expect(new UnmCache().get('missing', 0)).toBeUndefined();
  });

  it('get 按注入的 now 判定：expiresAt <= now 即过期', () => {
    const cache = new UnmCache();
    cache.set('k', { audio: null, expiresAt: 100 });

    expect(cache.get('k', 99)?.audio).toBeNull();
    expect(cache.get('k', 100)).toBeUndefined(); // 边界：到点就算过期
  });

  it('读到过期条目会顺手删掉', () => {
    const cache = new UnmCache();
    cache.set('k', { audio: resolved('https://x/a.mp3'), expiresAt: 10 });
    expect(cache.size).toBe(1);

    expect(cache.get('k', 10)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('超过 maxEntries 时淘汰最老的键（Map 插入序，不是 LRU）', () => {
    const cache = new UnmCache(2);
    cache.set('a', { audio: null, expiresAt: 1_000 });
    cache.set('b', { audio: null, expiresAt: 1_000 });
    cache.set('c', { audio: null, expiresAt: 1_000 });

    expect(cache.size).toBe(2);
    expect(cache.get('a', 0)).toBeUndefined(); // 最老的 a 被挤掉
    expect(cache.get('b', 0)).toBeDefined();
    expect(cache.get('c', 0)).toBeDefined();
  });

  it('覆盖已有键不会触发淘汰，即使缓存已满', () => {
    const cache = new UnmCache(2);
    cache.set('a', { audio: null, expiresAt: 1_000 });
    cache.set('b', { audio: null, expiresAt: 1_000 });
    cache.set('a', { audio: resolved('https://x/a.mp3'), expiresAt: 5_000 });

    expect(cache.size).toBe(2);
    expect(cache.get('b', 0)).toBeDefined();
    expect(cache.get('a', 0)?.expiresAt).toBe(5_000);
  });

  it('默认容量上限是 64', () => {
    const cache = new UnmCache();
    for (let index = 0; index < 100; index += 1) {
      cache.set(`k${index}`, { audio: null, expiresAt: 10_000 });
    }

    expect(cache.size).toBe(64);
    expect(cache.get('k35', 0)).toBeUndefined(); // 前 36 个已被挤出
    expect(cache.get('k36', 0)).toBeDefined();
    expect(cache.get('k99', 0)).toBeDefined();
  });

  it('clear 清空全部条目', () => {
    const cache = new UnmCache();
    cache.set('a', { audio: null, expiresAt: 1_000 });
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('a', 0)).toBeUndefined();
  });
});
