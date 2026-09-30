/**
 * `@pi/source-local/src/index.ts` 行为锁（M2.5 H6 的 L4 层，见 docs/ADR/0001-音源解析链.md）。
 *
 * 这个包是责任链的**最后一层兜底**，它守住三件事：
 *
 * 1. **不联网、不虚标、不要 cookie**：本地文件唯一的风险是匹配错，
 *    所以 `match()` 全程只读内存里的曲库；
 * 2. **曲库用函数取而不是构造时抓引用**：用户随时可能换文件夹/重扫，
 *    长生命周期的音源对象不能把旧曲库焊死；
 * 3. **`probe` 只是占位**：真实容器/码率由责任链的字节探针覆盖，
 *    这里给出的 `container: 'unknown'` + `pending-probe` 证据就是「还没测」的意思，
 *    绝不能拿它当实测结果（详见 resolver 的 probe 覆盖逻辑）。
 *
 * 全程离线：曲库是纯内存的假实现，不发任何请求、不起进程。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MatchInput, MusicSource } from '@pi/source-core';
import {
  LOCAL_MATCH_TIMEOUT_MS,
  LOCAL_SOURCE_ID,
  LOCAL_SOURCE_LABEL,
  LocalLibrary,
  createLocalSource,
  localAudioFor,
  qualityFromExtension,
  type LocalMatchResult,
  type LocalTrack,
} from './index.js';

/* ------------------------------------------------------------------ *
 * 测试脚手架（全部离线）
 * ------------------------------------------------------------------ */

/** 造一个本地曲目；默认与下面的 `wanted()` 完全对得上。 */
function track(overrides: Partial<LocalTrack> = {}): LocalTrack {
  const trackPath = overrides.path ?? path.join('C:', 'Music', '周杰伦 - 晴天.flac');
  return {
    id: createHash('sha1').update(trackPath, 'utf8').digest('hex').slice(0, 12),
    path: trackPath,
    title: '晴天',
    artists: ['周杰伦'],
    ext: 'flac',
    ...overrides,
  };
}

/** 造一个匹配输入；默认找 `track()` 那首歌。 */
function input(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    songId: 1_860_016,
    quality: 'lossless',
    title: '晴天',
    artists: ['周杰伦'],
    ...overrides,
  };
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

/** 取出命中结果；没命中就直接让用例失败，避免到处都是 `?.`。 */
async function matchOk(
  source: MusicSource,
  matchInput: MatchInput,
  signal: AbortSignal = freshSignal(),
) {
  const audio = await source.match(matchInput, signal);
  if (!audio) throw new Error(`期望 match 命中，实际返回 null（title=${matchInput.title}）`);
  return audio;
}

/* ------------------------------------------------------------------ *
 * qualityFromExtension
 * ------------------------------------------------------------------ */

describe('qualityFromExtension', () => {
  it('flac / ape / wav 天生无损容器 → lossless', () => {
    expect(qualityFromExtension('flac')).toBe('lossless');
    expect(qualityFromExtension('ape')).toBe('lossless');
    expect(qualityFromExtension('wav')).toBe('lossless');
  });

  it('开头带点的后缀照样认（`.FLAC` / `.Wav`）', () => {
    expect(qualityFromExtension('.flac')).toBe('lossless');
    expect(qualityFromExtension('.FLAC')).toBe('lossless');
    expect(qualityFromExtension('.Wav')).toBe('lossless');
  });

  it('有损后缀一律先按最高档 exhigh 自称（真实码率交给探针实测）', () => {
    for (const ext of ['mp3', 'm4a', 'ogg', 'opus', 'aac', 'wma']) {
      expect(qualityFromExtension(ext)).toBe('exhigh');
    }
    expect(qualityFromExtension('MP3')).toBe('exhigh');
  });

  it('不认识的后缀不是错误，同样退回 exhigh（本地什么怪容器都可能有）', () => {
    expect(qualityFromExtension('dsf')).toBe('exhigh');
    expect(qualityFromExtension('')).toBe('exhigh');
    expect(qualityFromExtension('.')).toBe('exhigh');
  });
});

/* ------------------------------------------------------------------ *
 * 源自身的元数据
 * ------------------------------------------------------------------ */

describe('createLocalSource 元数据', () => {
  it('id / label / tier / needsCookie / timeoutMs 符合「本地兜底」的约定', () => {
    const source = createLocalSource({ library: () => new LocalLibrary() });

    expect(source.id).toBe(LOCAL_SOURCE_ID);
    expect(source.id).toBe('local');
    expect(source.label).toBe(LOCAL_SOURCE_LABEL);
    expect(source.label).toBe('本地文件');
    expect(source.tier).toBe('local');
    // 本地文件不联网、不碰账号：永远不需要 cookie（§2.5 账号安全红线）
    expect(source.needsCookie).toBe(false);
    // 文件名匹配是微秒级；3 秒是给「曲库刚被重扫、还在建索引」留的余量
    expect(source.timeoutMs).toBe(LOCAL_MATCH_TIMEOUT_MS);
    expect(source.timeoutMs).toBe(3_000);
  });

  it('8 个音质档位全部算候选（真实档位由探针实测决定）', () => {
    const source = createLocalSource({ library: () => new LocalLibrary() });

    expect([...source.qualities]).toEqual([
      'standard',
      'higher',
      'exhigh',
      'lossless',
      'hires',
      'jymaster',
      'flac',
      'flac24bit',
    ]);
  });

  it('每次 match 都重新取曲库：换文件夹后无需重建音源对象', async () => {
    let calls = 0;
    const source = createLocalSource({
      library: () => {
        calls += 1;
        return new LocalLibrary();
      },
    });

    await source.match(input(), freshSignal());
    await source.match(input(), freshSignal());

    expect(calls).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * createLocalSource.match
 * ------------------------------------------------------------------ */

describe('createLocalSource.match 未命中路径', () => {
  it('signal 已经 abort 时立刻返回 null，连曲库都不去取', async () => {
    let libraryCalls = 0;
    const source = createLocalSource({
      library: () => {
        libraryCalls += 1;
        return new LocalLibrary([track()]);
      },
    });
    const controller = new AbortController();
    controller.abort();

    expect(await source.match(input(), controller.signal)).toBeNull();
    // 责任链已经放弃这一轮，没必要再去打扰曲库
    expect(libraryCalls).toBe(0);
  });

  it('曲库为空时返回 null（不给错误，让责任链继续往上收尾）', async () => {
    const source = createLocalSource({ library: () => new LocalLibrary() });

    expect(await source.match(input(), freshSignal())).toBeNull();
  });

  it('歌名对不上时返回 null —— 相似但不同的歌绝不匹配', async () => {
    const source = createLocalSource({
      library: () => new LocalLibrary([track({ title: '阴天' })]),
    });

    expect(await source.match(input(), freshSignal())).toBeNull();
  });

  it('歌名对得上但歌手完全不同时返回 null', async () => {
    const source = createLocalSource({
      library: () => new LocalLibrary([track({ artists: ['林俊杰'] })]),
    });

    expect(await source.match(input({ artists: ['周杰伦'] }), freshSignal())).toBeNull();
  });

  it('时长差超过容差（5% 不足 3 秒时按 3000ms 下限）时返回 null', async () => {
    const source = createLocalSource({
      library: () => new LocalLibrary([track({ durationMs: 30_000 })]),
    });

    expect(await source.match(input({ durationMs: 30_000 + 3_001 }), freshSignal())).toBeNull();
  });
});

describe('createLocalSource.match 命中路径', () => {
  it('命中：via=local、url 是 file:// 地址、localPath 就是曲目路径', async () => {
    const item = track({ path: path.join('C:', 'Music', '01. 周杰伦 - 晴天.flac'), durationMs: 269_000 });
    const source = createLocalSource({ library: () => new LocalLibrary([item]) });

    const audio = await matchOk(source, input({ durationMs: 269_000 }));

    expect(audio.via).toBe('local');
    expect(audio.url.startsWith('file://')).toBe(true);
    expect(audio.url).toBe(pathToFileURL(item.path).href);
    expect(audio.localPath).toBe(item.path);
    // 本地文件不是试听片段
    expect(audio.trial).toBeUndefined();
  });

  it('质量按后缀猜：flac → lossless，mp3 → exhigh', async () => {
    const flacSource = createLocalSource({
      library: () => new LocalLibrary([track({ ext: 'flac' })]),
    });
    const mp3Source = createLocalSource({
      library: () => new LocalLibrary([track({ ext: 'mp3' })]),
    });

    expect((await matchOk(flacSource, input())).quality).toBe('lossless');
    expect((await matchOk(mp3Source, input())).quality).toBe('exhigh');
  });

  it('probe 是占位而不是实测：container=unknown + pending-probe 证据', async () => {
    // 真实容器/码率由责任链的字节探针覆盖这枚占位（resolver 会拿实测 probe 替换掉它），
    // 所以这里只锁「占位」这件事：container 必须是 unknown，证据里必须自报 pending。
    const item = track({ path: path.join('C:', 'Music', '周杰伦 - 晴天.flac') });
    const source = createLocalSource({ library: () => new LocalLibrary([item]) });

    const audio = await matchOk(source, input());

    expect(audio.probe.container).toBe('unknown');
    expect(audio.probe.evidence).toContain('pending-probe');
    expect(audio.probe.evidence).toContain('晴天.flac');
    // 占位里不该冒出任何实测数字
    expect(audio.probe.sampleRate).toBeUndefined();
    expect(audio.probe.bitrateKbps).toBeUndefined();
  });

  it('命中时写一条带文件与原因的日志（排障靠它）', async () => {
    const seen: { message: string; detail: unknown }[] = [];
    const source = createLocalSource({
      library: () => new LocalLibrary([track({ durationMs: 269_000 })]),
      log: (message, detail) => seen.push({ message, detail }),
    });

    await matchOk(source, input({ durationMs: 269_000 }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toContain('本地曲库命中');
    expect(seen[0]?.detail).toMatchObject({ file: track().path, reason: '歌手对得上 · 时长差 0.0s' });
  });

  it('未命中时不写日志（避免把「没找到」刷成噪音）', async () => {
    const seen: string[] = [];
    const source = createLocalSource({
      library: () => new LocalLibrary([track({ title: '阴天' })]),
      log: (message) => seen.push(message),
    });

    await source.match(input(), freshSignal());

    expect(seen).toEqual([]);
  });

  it('多个候选都命中时取时长最接近的那一个', async () => {
    const library = new LocalLibrary([
      track({ path: path.join('C:', 'Music', 'a.flac'), durationMs: 200_000 }),
      track({ path: path.join('C:', 'Music', 'b.flac'), durationMs: 269_000 }),
    ]);
    const source = createLocalSource({ library: () => library });

    const audio = await matchOk(source, input({ durationMs: 269_500 }));

    expect(audio.localPath).toBe(path.join('C:', 'Music', 'b.flac'));
  });
});

/* ------------------------------------------------------------------ *
 * localAudioFor
 * ------------------------------------------------------------------ */

describe('localAudioFor', () => {
  it('容器占位 + 大小写成人话写进证据，方便排障时一眼看出是哪个文件', () => {
    const matched: LocalMatchResult = {
      track: track({ path: path.join('C:', 'Music', '周杰伦 - 晴天.flac'), sizeBytes: 5_242_880 }),
      reason: '歌手对得上 · 时长未知',
    };

    const audio = localAudioFor(matched);

    expect(audio.probe.container).toBe('unknown');
    expect(audio.probe.evidence).toContain('pending-probe');
    expect(audio.probe.evidence).toContain('晴天.flac');
    // 5MiB → 5.0MB
    expect(audio.probe.evidence).toContain('5.0MB');
    expect(audio.via).toBe('local');
  });

  it('拿不到文件大小时写「大小未知」，不影响其它字段', () => {
    const audio = localAudioFor({ track: track(), reason: '歌手对得上 · 时长未知' });

    expect(audio.probe.evidence).toContain('大小未知');
    expect(audio.url).toBe(pathToFileURL(track().path).href);
    expect(audio.localPath).toBe(track().path);
  });
});
