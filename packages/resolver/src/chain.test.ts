/**
 * ResolverChain 的单元测试（docs/PLAN.md 任务组 H5「真实音质校验」+ H8「音源健康降权」）。
 *
 * 这个文件守住 M2.5 的承诺：
 * 1. 「关掉某个音源后自动走下一层」——不支持的音质跳过去、抛错的源只记一条失败、
 *    被降权的源根本不碰、某个源挂住也不会拖死整条链（逐源超时）；
 * 2. 「第三方虚标会被抓出来」——责任链只认探针的字节证据：声称 lossless 而实测
 *    mp3@128kbps 会被改写成 standard 并留下 claimedQuality，而且不算可信、继续往后找。
 *
 * 全部用例离线运行：没有网络、没有 Electron、不写磁盘；音源与探针都是本地假实现，
 * 唯一涉及真实计时的是逐源超时那条用例（30ms 预算，但不做紧贴数值的断言）。
 */

import { describe, expect, it } from 'vitest';
import type { AudioProbe, Quality, ResolvedAudio } from '@pi/shared';
import type { MatchInput, MusicSource } from '@pi/source-core';
import { ResolverChain, SourceHealthRegistry, type ProbeFn } from './index.js';

/** 每个用例都用来请求「无损」的输入。 */
const INPUT: MatchInput = {
  songId: 347230,
  quality: 'lossless',
  title: '测试歌曲',
  artists: ['测试歌手'],
};

/** 假音源默认声称支持全部有损 + 无损档位。 */
const ALL_QUALITIES: readonly Quality[] = ['standard', 'higher', 'exhigh', 'lossless'];

const FLAC_44K: AudioProbe = { container: 'flac', sampleRate: 44_100, evidence: 'magic:fLaC' };
const FLAC_96K: AudioProbe = { container: 'flac', sampleRate: 96_000, evidence: 'magic:fLaC' };
const MP3_128K: AudioProbe = { container: 'mp3', bitrateKbps: 128, evidence: 'magic:ID3' };

/** 造一份音源自称的结果；`probe` 只是占位，责任链会用真探针覆盖它。 */
function audio(via: string, quality: Quality, extra: Partial<ResolvedAudio> = {}): ResolvedAudio {
  return {
    url: `https://cdn.test.invalid/${via}`,
    quality,
    probe: { container: 'unknown', evidence: '来源自己塞的占位探针（不该被返回）' },
    via,
    ...extra,
  };
}

/** 假音源：只实现契约，不做任何 IO。 */
function fakeSource(
  id: string,
  match: MusicSource['match'],
  options: { qualities?: readonly Quality[]; timeoutMs?: number } = {},
): MusicSource {
  return {
    id,
    label: `假音源 ${id}`,
    tier: 'aggregator',
    qualities: options.qualities ?? ALL_QUALITIES,
    needsCookie: false,
    timeoutMs: options.timeoutMs,
    match,
  };
}

/** 假探针：按 `via` 查表返回「字节嗅探结果」，查不到就返回 unknown。 */
function probeByVia(map: Record<string, AudioProbe>): ProbeFn {
  return async (resolved) =>
    map[resolved.via] ?? { container: 'unknown', evidence: '用例没有为这个源配置探针' };
}

describe('ResolverChain · 音质能力与实测校正', () => {
  it('跳过不支持所请求音质的源，并把原因记进 attempt', async () => {
    let skippedMatchCalls = 0;
    const onlyStandard = fakeSource(
      'only-standard',
      async () => {
        skippedMatchCalls += 1;
        return audio('only-standard', 'standard');
      },
      { qualities: ['standard'] },
    );
    const good = fakeSource('good', async () => audio('good', 'lossless'));

    const chain = new ResolverChain([onlyStandard, good], probeByVia({ good: FLAC_44K }));
    const result = await chain.resolve(INPUT);

    // 不支持就直接跳过：不该白跑一次匹配（更不能等它超时）
    expect(skippedMatchCalls).toBe(0);
    expect(result.attempts[0]).toMatchObject({
      sourceId: 'only-standard',
      ok: false,
      elapsedMs: 0,
    });
    expect(result.attempts[0]?.detail).toContain('不支持音质');
    expect(result.attempts[0]?.detail).toContain('lossless');
    expect(result.audio?.via).toBe('good');
  });

  it('探针实测 flac 且来源声称 lossless → trusted，返回的 quality / probe 都是实测值', async () => {
    let laterCalls = 0;
    const claimed = fakeSource('claimed', async () => audio('claimed', 'lossless'));
    const later = fakeSource('later', async () => {
      laterCalls += 1;
      return audio('later', 'lossless');
    });

    const chain = new ResolverChain(
      [claimed, later],
      probeByVia({ claimed: FLAC_44K, later: FLAC_44K }),
    );
    const result = await chain.resolve(INPUT);

    // 拿到可信结果就不再往后试
    expect(laterCalls).toBe(0);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.ok).toBe(true);
    expect(result.attempts[0]?.detail).toContain('实测 flac 44100Hz @ lossless');
    expect(result.audio?.via).toBe('claimed');
    expect(result.audio?.quality).toBe('lossless');
    // probe 必须是探针给的实测对象，而不是来源自己塞进 raw 里的占位
    expect(result.audio?.probe).toEqual(FLAC_44K);
    expect(result.audio?.claimedQuality).toBeUndefined();
    expect(result.audio?.trial).toBeUndefined();
  });

  it('实测比声称更高时同样以实测为准（声称 standard、实测 flac 96kHz → hires）', async () => {
    const modest = fakeSource('modest', async () => audio('modest', 'standard'));
    const chain = new ResolverChain([modest], probeByVia({ modest: FLAC_96K }));

    const result = await chain.resolve(INPUT);

    expect(result.audio?.quality).toBe('hires');
    expect(result.audio?.claimedQuality).toBe('standard');
    expect(result.audio?.probe).toEqual(FLAC_96K);
    expect(result.attempts[0]?.detail).toContain('实测 flac 96000Hz @ hires');
  });

  it('来源只给试听片段时继续往后找，拿到完整版就用完整版', async () => {
    const trial = fakeSource('official', async () => audio('official', 'lossless', { trial: true }));
    const full = fakeSource('third-party', async () => audio('third-party', 'lossless'));

    const chain = new ResolverChain(
      [trial, full],
      probeByVia({ official: FLAC_44K, 'third-party': FLAC_44K }),
    );
    const result = await chain.resolve(INPUT);

    expect(result.attempts[0]?.ok).toBe(true);
    expect(result.attempts[0]?.detail).toContain('仅提供试听片段');
    expect(result.audio?.via).toBe('third-party');
    expect(result.audio?.trial).toBeUndefined();
  });

  it('后面没有更好的源时，最终仍然返回试听片段（trial 如实为 true）', async () => {
    const trial = fakeSource('official', async () => audio('official', 'lossless', { trial: true }));
    const empty = fakeSource('third-party', async () => null);

    const chain = new ResolverChain([trial, empty], probeByVia({ official: FLAC_44K }));
    const result = await chain.resolve(INPUT);

    expect(result.audio?.via).toBe('official');
    expect(result.audio?.trial).toBe(true);
    expect(result.attempts[1]?.detail).toBe('未匹配到可用音源');
  });

  it('第三方虚标：声称 lossless、实测 mp3@128kbps → 改写为 standard 并保留 claimedQuality', async () => {
    const liar = fakeSource('liar', async () => audio('liar', 'lossless'));
    const chain = new ResolverChain([liar], probeByVia({ liar: MP3_128K }));

    const result = await chain.resolve(INPUT);

    // 后面没有更好的源，兜底返回它——但音质必须是实测出来的
    expect(result.audio?.via).toBe('liar');
    expect(result.audio?.quality).toBe('standard');
    expect(result.audio?.claimedQuality).toBe('lossless');
    expect(result.audio?.probe).toEqual(MP3_128K);
    expect(result.attempts[0]?.ok).toBe(true);
    expect(result.attempts[0]?.detail).toContain('达不到声称的 lossless');
    expect(result.attempts[0]?.detail).toContain('已降级标注');
  });

  it('虚标结果不算可信，责任链继续往后找真实无损', async () => {
    const liar = fakeSource('liar', async () => audio('liar', 'lossless'));
    const honest = fakeSource('honest', async () => audio('honest', 'lossless'));

    const chain = new ResolverChain(
      [liar, honest],
      probeByVia({ liar: MP3_128K, honest: FLAC_44K }),
    );
    const result = await chain.resolve(INPUT);

    expect(result.attempts).toHaveLength(2);
    expect(result.audio?.via).toBe('honest');
    expect(result.audio?.quality).toBe('lossless');
    expect(result.audio?.claimedQuality).toBeUndefined();
  });
});

describe('ResolverChain · 失败、降权与超时', () => {
  it('某个源 match 抛错：该 attempt 记为失败并带上错误信息，责任链继续', async () => {
    const broken = fakeSource('broken', async () => {
      throw new Error('上游 502 Bad Gateway');
    });
    const good = fakeSource('good', async () => audio('good', 'lossless'));

    const chain = new ResolverChain([broken, good], probeByVia({ good: FLAC_44K }));
    const result = await chain.resolve(INPUT);

    expect(result.attempts[0]).toMatchObject({ sourceId: 'broken', ok: false });
    expect(result.attempts[0]?.detail).toBe('上游 502 Bad Gateway');
    expect(result.audio?.via).toBe('good');
  });

  it('未匹配到（返回 null）只记 missed，不导致降权，责任链继续', async () => {
    const empty = fakeSource('empty', async () => null);
    const good = fakeSource('good', async () => audio('good', 'lossless'));
    const health = new SourceHealthRegistry();

    const chain = new ResolverChain([empty, good], probeByVia({ good: FLAC_44K }), { health });
    const result = await chain.resolve(INPUT);

    expect(result.attempts[0]?.detail).toBe('未匹配到可用音源');
    expect(result.audio?.via).toBe('good');

    const snapshot = health.snapshot();
    const emptyHealth = snapshot.find((state) => state.sourceId === 'empty');
    expect(emptyHealth?.missed).toBe(1);
    expect(emptyHealth?.consecutiveFailures).toBe(0);
    expect(emptyHealth?.demotedUntil).toBeUndefined();
    expect(health.availability('empty').available).toBe(true);
    // 成功出结果的源记 ok
    expect(snapshot.find((state) => state.sourceId === 'good')?.ok).toBe(1);
  });

  it('被临时降权的源直接跳过，attempt 里说明「已临时降权」', async () => {
    let demotedMatchCalls = 0;
    const flaky = fakeSource('flaky', async () => {
      demotedMatchCalls += 1;
      return audio('flaky', 'lossless');
    });
    const good = fakeSource('good', async () => audio('good', 'lossless'));

    const health = new SourceHealthRegistry();
    for (let i = 0; i < 3; i += 1) health.recordFailure('flaky', '连续超时');
    expect(health.availability('flaky').available).toBe(false);

    const chain = new ResolverChain([flaky, good], probeByVia({ good: FLAC_44K }), { health });
    const result = await chain.resolve(INPUT);

    expect(demotedMatchCalls).toBe(0);
    expect(result.attempts[0]?.ok).toBe(false);
    expect(result.attempts[0]?.elapsedMs).toBe(0);
    expect(result.attempts[0]?.detail).toContain('已临时降权');
    expect(result.attempts[0]?.detail).toContain('连续失败 3 次');
    expect(result.attempts[0]?.detail).toContain('后自动恢复');
    expect(result.audio?.via).toBe('good');
  });

  it('逐源超时：挂住的源被中断，后面的源照常出结果', async () => {
    let stalledAborted = false;
    const stalled = fakeSource(
      'stalled',
      (_input, signal) =>
        // 永不自己 resolve；只有被逐源超时 abort 时才 reject——这正是「超时生效」的证据
        new Promise<ResolvedAudio | null>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            stalledAborted = true;
            reject(new Error('被逐源超时中断'));
          });
        }),
      { timeoutMs: 30 },
    );
    const good = fakeSource('good', async () => audio('good', 'lossless'));

    const chain = new ResolverChain([stalled, good], probeByVia({ good: FLAC_44K }));
    const result = await chain.resolve(INPUT);

    expect(stalledAborted).toBe(true);
    expect(result.attempts[0]).toMatchObject({ sourceId: 'stalled', ok: false });
    expect(result.attempts[0]?.detail).toBe('被逐源超时中断');
    // 后面的源照常拿到结果
    expect(result.audio?.via).toBe('good');
    expect(result.audio?.quality).toBe('lossless');
  });
});
