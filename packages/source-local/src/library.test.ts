/**
 * `@pi/source-local/src/library.ts` 行为锁（M2.5 H6 的 L4 层，见 docs/ADR/0001-音源解析链.md）。
 *
 * 本地源是责任链的**最后一层**，它的两条承诺必须钉死：
 *
 * 1. **认歌不认路径**：用户给文件起名千奇百怪（`01. 周杰伦 - 晴天.flac`、
 *    `1_夜曲.mp3`、`晴天.mp3`、`Artist－Title.m4a`…），所以文件名解析必须宽容；
 * 2. **宁可漏，不可错**：匹配是硬条件（歌名必须对上、双方都有歌手时必须有一位对上、
 *    双方都有时长时差距不得超过 `max(3000ms, 时长 5%)`），**没有「凑合匹配」这一档**。
 *    匹配错了等于放出另一首歌，而用户根本看不出问题出在链路哪一层。
 *
 * 全程离线：匹配逻辑跑在纯内存的 `LocalLibrary` 上；只有 `scanAudioDirectory`
 * 那一组会往 `os.tmpdir()` 里建一个几 KB 的临时目录（`afterAll` 里删掉），
 * 不扫任何真实音乐目录、不联网、不起进程。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIO_EXTENSIONS,
  LocalLibrary,
  extensionOf,
  isAudioFile,
  matchLocalTrack,
  normalizeForMatch,
  parseTrackFileName,
  scanAudioDirectory,
  type LocalTrack,
} from './library.js';

/* ------------------------------------------------------------------ *
 * 测试脚手架（全部离线）
 * ------------------------------------------------------------------ */

/** 造一个本地曲目；只写用例关心的字段，其余给稳定默认值。 */
function track(overrides: Partial<LocalTrack> = {}): LocalTrack {
  const trackPath = overrides.path ?? 'C:\\Music\\周杰伦 - 晴天.flac';
  return {
    id: createHash('sha1').update(trackPath, 'utf8').digest('hex').slice(0, 12),
    path: trackPath,
    title: '晴天',
    artists: ['周杰伦'],
    ext: 'flac',
    ...overrides,
  };
}

/** 匹配输入的默认值：歌名 + 歌手都对得上 `track()`。 */
function wanted(overrides: Partial<{ title: string; artists: string[]; durationMs: number }> = {}) {
  return {
    title: '晴天',
    artists: ['周杰伦'],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * AUDIO_EXTENSIONS / isAudioFile / extensionOf
 * ------------------------------------------------------------------ */

describe('isAudioFile 与 extensionOf', () => {
  it('AUDIO_EXTENSIONS 是锁定的 9 个后缀，且都是小写不含点', () => {
    expect([...AUDIO_EXTENSIONS]).toEqual([
      'flac',
      'mp3',
      'm4a',
      'aac',
      'ogg',
      'opus',
      'wav',
      'ape',
      'wma',
    ]);
    for (const ext of AUDIO_EXTENSIONS) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext.startsWith('.')).toBe(false);
    }
  });

  it('大小写混写的后缀照样认得（后缀比对前先 lowercase）', () => {
    expect(isAudioFile('晴天.FLAC')).toBe(true);
    expect(isAudioFile('晴天.Mp3')).toBe(true);
    expect(isAudioFile('晴天.M4A')).toBe(true);
    expect(isAudioFile('晴天.OpUs')).toBe(true);
  });

  it('非音频文件与没有后缀的名字不算音频', () => {
    expect(isAudioFile('晴天.jpg')).toBe(false);
    expect(isAudioFile('README')).toBe(false);
    expect(isAudioFile('列表.txt')).toBe(false);
    // 后缀前少一个点：`flac` 是文件名的一部分而不是后缀
    expect(isAudioFile('晴天flac')).toBe(false);
  });

  it('extensionOf 返回小写、不含点的后缀', () => {
    expect(extensionOf('/music/晴天.FLAC')).toBe('flac');
    expect(extensionOf('C:\\Music\\晴天.Mp3')).toBe('mp3');
    expect(extensionOf('没有后缀')).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * parseTrackFileName
 * ------------------------------------------------------------------ */

describe('parseTrackFileName · 音轨号前缀', () => {
  it('`01. 歌手 - 歌名` 去掉音轨号后按歌手/歌名拆开', () => {
    expect(parseTrackFileName('01. 周杰伦 - 晴天.flac')).toEqual({
      title: '晴天',
      artists: ['周杰伦'],
    });
  });

  it('`02 - 林俊杰 - 歌名` 里的 `02` 是音轨号而不是歌手', () => {
    expect(parseTrackFileName('02 - 林俊杰 - 不为谁而作的歌.mp3')).toEqual({
      title: '不为谁而作的歌',
      artists: ['林俊杰'],
    });
  });

  it('`1_夜曲` 与 `003、孤勇者` 的下划线 / 顿号前缀也是音轨号', () => {
    expect(parseTrackFileName('1_夜曲.mp3')).toEqual({ title: '夜曲', artists: [] });
    expect(parseTrackFileName('003、孤勇者.wav')).toEqual({ title: '孤勇者', artists: [] });
  });

  it('`01 - 晴天` 去前缀后只剩一个片段 → 无歌手信息', () => {
    expect(parseTrackFileName('01 - 晴天.mp3')).toEqual({ title: '晴天', artists: [] });
  });

  it('前缀超长（4 位数字）不当作音轨号，整体都是歌名', () => {
    // 音轨号上限 3 位：`1000. nope` 不像音轨号，宁可不拆也不算错。
    expect(parseTrackFileName('1000. nope.mp3')).toEqual({ title: '1000. nope', artists: [] });
  });

  it('前缀去重音轨号后只剩数字时退回原名（`01.mp3` 歌名就是 `01`）', () => {
    expect(parseTrackFileName('01.mp3')).toEqual({ title: '01', artists: [] });
  });

  it('名字本身就是纯数字时原样当歌名（`123.mp3`）', () => {
    expect(parseTrackFileName('123.mp3')).toEqual({ title: '123', artists: [] });
  });

  it('`05.  泡沫 ` 这类多余空白会被吃掉', () => {
    expect(parseTrackFileName(' 05.  泡沫 .mp3')).toEqual({ title: '泡沫', artists: [] });
  });
});

describe('parseTrackFileName · 分隔符与歌手', () => {
  it('四种分隔符 `-` / `–` / `—` / `－` 都按「歌手 - 歌名」拆', () => {
    expect(parseTrackFileName('Artist - Title.mp3')).toEqual({ title: 'Title', artists: ['Artist'] });
    expect(parseTrackFileName('Artist–Title.mp3')).toEqual({ title: 'Title', artists: ['Artist'] });
    expect(parseTrackFileName('Artist—Title.mp3')).toEqual({ title: 'Title', artists: ['Artist'] });
    expect(parseTrackFileName('Artist－Title.mp3')).toEqual({ title: 'Title', artists: ['Artist'] });
  });

  it('多位歌手的五种分隔（`、,，&/`）都会拆成数组', () => {
    expect(parseTrackFileName('周杰伦、费玉清 - 千里之外.flac')).toEqual({
      title: '千里之外',
      artists: ['周杰伦', '费玉清'],
    });
    expect(parseTrackFileName('周杰伦,费玉清 - 千里之外.flac').artists).toEqual(['周杰伦', '费玉清']);
    expect(parseTrackFileName('周杰伦，费玉清 - 千里之外.flac').artists).toEqual(['周杰伦', '费玉清']);
    expect(parseTrackFileName('周杰伦&费玉清 - 千里之外.flac').artists).toEqual(['周杰伦', '费玉清']);
  });

  it('斜杠是路径分隔符（不是歌手分隔符），所以斜杠左边那一级目录名会丢掉', () => {
    // 说明：`path.basename` 在 Windows 与 POSIX 上都把 `/` 当路径分隔符，
    // 所以 `周杰伦/费玉清 - 千里之外.flac` 先变成 `费玉清 - 千里之外.flac`，再按 `-` 切。
    // 真实文件名里不可能出现 `/`（它是路径分隔符），因此这里只锁当前行为，不当作 bug。
    expect(parseTrackFileName('周杰伦/费玉清 - 千里之外.flac')).toEqual({
      title: '千里之外',
      artists: ['费玉清'],
    });
  });

  it('没有分隔符的文件名 → 整段都是歌名，歌手为空数组', () => {
    expect(parseTrackFileName('晴天.mp3')).toEqual({ title: '晴天', artists: [] });
    expect(parseTrackFileName('Instrumental Track.flac')).toEqual({
      title: 'Instrumental Track',
      artists: [],
    });
  });

  it('歌名里带 `-`（如 ` - Live`）时，只有最右一段当歌名', () => {
    expect(parseTrackFileName('01. 晴天 - Live.mp3')).toEqual({ title: 'Live', artists: ['晴天'] });
  });

  it('空歌手段被过滤（`周杰伦 - 晴天 -`）', () => {
    expect(parseTrackFileName('周杰伦 - 晴天 -.mp3')).toEqual({ title: '晴天', artists: ['周杰伦'] });
  });

  it('`feat.` 原样留在歌手串里（归一化阶段才处理合作歌手）', () => {
    expect(parseTrackFileName('周杰伦 feat. 费玉清 - 千里之外.mp3')).toEqual({
      title: '千里之外',
      artists: ['周杰伦 feat. 费玉清'],
    });
  });

  it('扩展名大小写不影响解析，且扩展名本身不出现在歌名里', () => {
    expect(parseTrackFileName('晴天.MP3')).toEqual({ title: '晴天', artists: [] });
    expect(parseTrackFileName('01. 周杰伦 - 晴天.FLAC')).toEqual({
      title: '晴天',
      artists: ['周杰伦'],
    });
  });
});

/* ------------------------------------------------------------------ *
 * normalizeForMatch
 * ------------------------------------------------------------------ */

describe('normalizeForMatch', () => {
  it('大小写与空白被抹平（比较用的是归一化结果）', () => {
    expect(normalizeForMatch('  Hello, World!  ')).toBe('helloworld');
    expect(normalizeForMatch('HELLO WORLD')).toBe(normalizeForMatch('hello world'));
  });

  it('半角与全角括号里的版本说明一律剥掉', () => {
    expect(normalizeForMatch('晴天 (Live)')).toBe('晴天');
    expect(normalizeForMatch('晴天（Live）')).toBe('晴天');
    expect(normalizeForMatch('晴天 [Live]')).toBe('晴天');
    expect(normalizeForMatch('晴天【Live】')).toBe('晴天');
  });

  it('从 `feat.` / `ft.` / `with` 处截断合作歌手', () => {
    expect(normalizeForMatch('起风了 feat. 买辣椒也用券')).toBe('起风了');
    expect(normalizeForMatch('起风了 ft. 买辣椒也用券')).toBe('起风了');
    expect(normalizeForMatch('A with B')).toBe('a');
  });

  it('这几个关键词大小写不敏感，且本身就是关键词时归一化成空串', () => {
    expect(normalizeForMatch('A WITH B')).toBe('a');
    expect(normalizeForMatch('Feat. X')).toBe('');
    expect(normalizeForMatch('with you')).toBe('');
  });

  it('关键词嵌在字母中间不算截断点（`abcWITHdef` 保持完整）', () => {
    expect(normalizeForMatch('abcWITHdef')).toBe('abcwithdef');
  });

  it('常见标点与分隔符全部删掉，全角字符保留', () => {
    expect(normalizeForMatch('歌名: 副标题; 结尾')).toBe('歌名副标题结尾');
    expect(normalizeForMatch('A·B')).toBe('ab');
    expect(normalizeForMatch('周杰伦 - 晴天')).toBe('周杰伦晴天');
    // 全角字符只做 lowercase（全角 Ａ 的小写就是全角 ａ），不做半角化
    expect(normalizeForMatch('ＡＣ/ＤＣ')).toBe('ａｃｄｃ');
  });

  it('括号里的内容先于关键词剥除处理', () => {
    expect(normalizeForMatch('晴天 (Live) feat. 张三')).toBe('晴天');
  });
});

/* ------------------------------------------------------------------ *
 * matchLocalTrack
 * ------------------------------------------------------------------ */

describe('matchLocalTrack · 歌名', () => {
  it('归一化后歌名完全相等 → 命中', () => {
    const result = matchLocalTrack(wanted(), track({ durationMs: 269_000 }));

    expect(result?.track.title).toBe('晴天');
    expect(result?.reason).toContain('歌手对得上');
  });

  it('歌名归一化后相等即可，原始写法（大小写/空格/括号）不必一样', () => {
    expect(
      matchLocalTrack(wanted({ title: 'Qing Tian' }), track({ title: 'qingtian' })),
    ).toBeDefined();
    expect(
      matchLocalTrack(wanted({ title: '晴天' }), track({ title: '晴天 (Live)' })),
    ).toBeDefined();
  });

  it('一方包含另一方也算命中（两个方向都试）', () => {
    // 输入更长：歌名里多了副标题
    expect(
      matchLocalTrack(wanted({ title: '晴天 现场版' }), track({ title: '晴天' })),
    ).toBeDefined();
    // 曲目更长：文件名里多了后缀说明
    expect(
      matchLocalTrack(wanted({ title: '晴天' }), track({ title: '晴天 录音室版' })),
    ).toBeDefined();
  });

  it('相似但不同的歌名**不匹配**——没有「凑合匹配」这一档', () => {
    // 「晴天」与「晴天娃娃」互相包含，但它们是两首歌；硬条件只认包含关系之外的差别。
    // 这里用真正不相交的名字锁死「猜不出就别猜」：宁可漏，不可错。
    expect(matchLocalTrack(wanted({ title: '晴天' }), track({ title: '阴天' }))).toBeUndefined();
    expect(
      matchLocalTrack(wanted({ title: '起风了' }), track({ title: '起风了（Live）' })),
    ).toBeDefined();
  });

  it('归一化后歌名为空（例如标题只有 `feat. X`）直接不匹配', () => {
    expect(matchLocalTrack(wanted({ title: 'feat. X' }), track())).toBeUndefined();
    expect(matchLocalTrack(wanted({ title: '晴天' }), track({ title: 'ft. Y' }))).toBeUndefined();
  });
});

describe('matchLocalTrack · 歌手', () => {
  it('双方都有歌手时至少要有一位对得上，否则拒绝', () => {
    const result = matchLocalTrack(
      wanted({ artists: ['周杰伦'] }),
      track({ artists: ['周杰伦', '袁咏琳'] }),
    );
    expect(result).toBeDefined();
    expect(result?.reason).toContain('歌手对得上');

    // 歌名一模一样但歌手完全不同：不能放行
    expect(
      matchLocalTrack(wanted({ artists: ['林俊杰'] }), track({ artists: ['周杰伦'] })),
    ).toBeUndefined();
  });

  it('歌手是一方包含另一方也算对得上（feat. 串里的主歌手）', () => {
    expect(
      matchLocalTrack(wanted({ artists: ['周杰伦'] }), track({ artists: ['周杰伦 feat. 费玉清'] })),
    ).toBeDefined();
  });

  it('输入侧没有歌手信息时不卡歌手，只靠歌名', () => {
    const result = matchLocalTrack(wanted({ artists: [] }), track({ artists: ['周杰伦'] }));

    expect(result).toBeDefined();
    expect(result?.reason).toContain('文件名没有歌手信息');
  });

  it('曲目侧没有歌手信息（裸歌名文件名）时同样不卡歌手', () => {
    const result = matchLocalTrack(wanted({ artists: ['周杰伦'] }), track({ artists: [] }));

    expect(result).toBeDefined();
    expect(result?.reason).toContain('文件名没有歌手信息');
  });

  it('歌手名归一化后为空的那些条目不参与比对', () => {
    // 曲目侧只有一个空归一化名字 → 视作「没有歌手信息」，命中
    expect(matchLocalTrack(wanted({ artists: ['周杰伦'] }), track({ artists: [''] }))).toBeDefined();
  });
});

describe('matchLocalTrack · 时长容差', () => {
  it('3000ms 下限：时长短到 5% 不足 3 秒时按 3 秒算（3000ms 整允许、3001ms 拒绝）', () => {
    // 30000 * 5% = 1500 < 3000 → 取下限 3000
    const item = track({ durationMs: 30_000 });

    expect(matchLocalTrack(wanted({ durationMs: 30_000 + 3_000 }), item)).toBeDefined();
    expect(matchLocalTrack(wanted({ durationMs: 30_000 - 3_000 }), item)).toBeDefined();
    expect(matchLocalTrack(wanted({ durationMs: 30_000 + 3_001 }), item)).toBeUndefined();
  });

  it('5% 分支：时长够长时 5% 超过 3 秒，就按 5% 放宽', () => {
    // 100000 * 5% = 5000 > 3000 → 容差 5000
    const item = track({ durationMs: 100_000 });

    expect(matchLocalTrack(wanted({ durationMs: 105_000 }), item)).toBeDefined();
    expect(matchLocalTrack(wanted({ durationMs: 105_001 }), item)).toBeUndefined();

    // 240000 * 5% = 12000：4 分钟的曲子能容 12 秒差（正式版 vs 现场版）
    const fourMinutes = track({ durationMs: 240_000 });
    expect(matchLocalTrack(wanted({ durationMs: 240_000 + 12_000 }), fourMinutes)).toBeDefined();
    expect(matchLocalTrack(wanted({ durationMs: 240_000 + 12_001 }), fourMinutes)).toBeUndefined();
  });

  it('两个分支的交界：60 秒时 5% 正好等于 3000ms 下限', () => {
    // 60000 * 5% = 3000 —— 边界两侧的判定由同一个数给出
    const item = track({ durationMs: 60_000 });

    expect(matchLocalTrack(wanted({ durationMs: 63_000 }), item)).toBeDefined();
    expect(matchLocalTrack(wanted({ durationMs: 63_001 }), item)).toBeUndefined();
  });

  it('任一侧没有时长就不做时长判定（reason 里如实写「时长未知」）', () => {
    const noDuration = matchLocalTrack(wanted({ durationMs: 269_000 }), track());
    expect(noDuration).toBeDefined();
    expect(noDuration?.reason).toContain('时长未知');

    const noWanted = matchLocalTrack(wanted(), track({ durationMs: 269_000 }));
    expect(noWanted).toBeDefined();
    expect(noWanted?.reason).toContain('时长未知');

    const neither = matchLocalTrack(wanted(), track());
    expect(neither).toBeDefined();
    expect(neither?.reason).toContain('时长未知');
  });

  it('时长为 0 视作未知，不参与判定', () => {
    expect(matchLocalTrack(wanted({ durationMs: 0 }), track({ durationMs: 269_000 }))).toBeDefined();
    expect(matchLocalTrack(wanted({ durationMs: 269_000 }), track({ durationMs: 0 }))).toBeDefined();
  });

  it('命中时 reason 里带上人话的时长差（保留 1 位小数）', () => {
    const result = matchLocalTrack(wanted({ durationMs: 269_000 }), track({ durationMs: 267_500 }));

    expect(result?.reason).toBe('歌手对得上 · 时长差 1.5s');
  });
});

/* ------------------------------------------------------------------ *
 * LocalLibrary
 * ------------------------------------------------------------------ */

describe('LocalLibrary', () => {
  it('默认是空库：size 为 0、list 为空数组', () => {
    const library = new LocalLibrary();

    expect(library.size).toBe(0);
    expect(library.list()).toEqual([]);
  });

  it('构造时复制传入数组：外部改原数组不影响库内容', () => {
    const source = [track({ title: 'A' })];
    const library = new LocalLibrary(source);
    source.push(track({ title: 'B' }));

    expect(library.size).toBe(1);
    expect(library.list().map((item) => item.title)).toEqual(['A']);
  });

  it('list() 返回全部曲目且保持插入顺序', () => {
    const library = new LocalLibrary([
      track({ title: 'A', path: 'C:\\Music\\A.flac' }),
      track({ title: 'B', path: 'C:\\Music\\B.flac' }),
    ]);

    expect(library.list().map((item) => item.title)).toEqual(['A', 'B']);
  });

  it('空库 find() 返回 undefined', () => {
    expect(new LocalLibrary().find(wanted())).toBeUndefined();
  });

  it('多个候选都命中时取时长最接近的那个', () => {
    const library = new LocalLibrary([
      track({ title: '晴天', durationMs: 200_000, path: 'C:\\Music\\A.flac' }),
      track({ title: '晴天', durationMs: 269_000, path: 'C:\\Music\\B.flac' }),
      track({ title: '晴天', durationMs: 400_000, path: 'C:\\Music\\C.flac' }),
    ]);

    // 只有 A 与 B 满足容差（C 差 140 秒），其中 B 的 9 秒差最小
    const matched = library.find(wanted({ durationMs: 260_000 }));

    expect(matched?.track.path).toBe('C:\\Music\\B.flac');
  });

  it('时长都不知道时取第一个命中的候选', () => {
    const library = new LocalLibrary([
      track({ title: '晴天', path: 'C:\\Music\\A.flac' }),
      track({ title: '晴天', path: 'C:\\Music\\B.flac' }),
    ]);

    expect(library.find(wanted())?.track.path).toBe('C:\\Music\\A.flac');
  });

  it('找不到候选时返回 undefined（存在曲目但都不匹配）', () => {
    const library = new LocalLibrary([track({ title: '阴天' })]);

    expect(library.find(wanted())).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * scanAudioDirectory（只建一个几 KB 的临时目录，afterAll 清理）
 * ------------------------------------------------------------------ */

describe('scanAudioDirectory', () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pi-source-local-'));
    mkdirSync(path.join(root, 'sub'));
    mkdirSync(path.join(root, 'empty'));

    // 大小写混写的后缀 → 必须都算音频
    writeFileSync(path.join(root, 'Track01.FLAC'), 'fake-flac');
    writeFileSync(path.join(root, 'track02.Mp3'), 'fake-mp3');
    writeFileSync(path.join(root, 'cover.jpg'), 'not-audio');
    writeFileSync(path.join(root, 'playlist.m3u'), 'not-audio');
    writeFileSync(path.join(root, 'sub', '03 - 周杰伦 - 晴天.wav'), 'fake-wav');
    writeFileSync(path.join(root, 'sub', 'notes.txt'), 'not-audio');
  });

  afterAll(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  it('默认递归扫描：后缀大小写不敏感地收集音频，忽略非音频文件', async () => {
    const tracks = await scanAudioDirectory(root);
    const names = tracks.map((item) => path.basename(item.path)).sort();

    expect(names).toEqual(['03 - 周杰伦 - 晴天.wav', 'Track01.FLAC', 'track02.Mp3']);
    // 非音频的 jpg / m3u / txt 一个都没进来
    expect(names.some((name) => name.endsWith('.jpg') || name.endsWith('.m3u'))).toBe(false);
  });

  it('每个曲目带上小写 ext、稳定 sha1 id 与真实文件大小', async () => {
    const tracks = await scanAudioDirectory(root);
    const flac = tracks.find((item) => path.basename(item.path) === 'Track01.FLAC');

    expect(flac?.ext).toBe('flac');
    expect(flac?.sizeBytes).toBe(Buffer.byteLength('fake-flac'));
    // id = 绝对路径 sha1 前 12 位（同一首歌移动位置后会变，这是设计）
    expect(flac?.id).toBe(
      createHash('sha1')
        .update(path.join(root, 'Track01.FLAC'), 'utf8')
        .digest('hex')
        .slice(0, 12),
    );
  });

  it('解析出的歌手/歌名与 parseTrackFileName 一致', async () => {
    const tracks = await scanAudioDirectory(root);
    const wav = tracks.find((item) => path.extname(item.path).toLowerCase() === '.wav');

    expect(wav?.title).toBe('晴天');
    expect(wav?.artists).toEqual(['周杰伦']);
  });

  it('recursive: false 时不进子目录', async () => {
    const tracks = await scanAudioDirectory(root, { recursive: false });
    const names = tracks.map((item) => path.basename(item.path)).sort();

    expect(names).toEqual(['Track01.FLAC', 'track02.Mp3']);
  });

  it('limit 截断：只收前 limit 个音频', async () => {
    const tracks = await scanAudioDirectory(root, { limit: 1 });

    expect(tracks).toHaveLength(1);
    expect(isAudioFile(path.basename(tracks[0]?.path ?? ''))).toBe(true);
  });

  it('目录不存在时只 warn 一次、返回空数组，绝不抛错', async () => {
    const warnings: { message: string; detail: unknown }[] = [];
    const missing = path.join(root, '这不是目录');

    const tracks = await scanAudioDirectory(missing, {
      onWarn: (message, detail) => warnings.push({ message, detail }),
    });

    expect(tracks).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('读不了目录');
    expect(warnings[0]?.message).toContain(missing);
    // detail 是底层 ENOENT，排障时要能看到
    expect(warnings[0]?.detail).toBeInstanceOf(Error);
  });

  it('空目录返回空库且不 warn', async () => {
    const warnings: string[] = [];

    const tracks = await scanAudioDirectory(path.join(root, 'empty'), {
      onWarn: (message) => warnings.push(message),
    });

    expect(tracks).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('不存在的目录没有 onWarn 时也不抛错（用户填错路径不该让音源体系起不来）', async () => {
    await expect(scanAudioDirectory(path.join(root, '并不存在'))).resolves.toEqual([]);
    expect(existsSync(path.join(root, '并不存在'))).toBe(false);
  });
});
