/**
 * 锁住 LX Music「自定义源」协议层的对外承诺（packages/source-lx/src/protocol.ts）：
 *
 * 1. 头注释块必须位于**文件偏移 0**，否则报与 LX 文案一致的「无效的自定义源文件」；
 * 2. 元数据按 LX 的上限截断：name 24 / description 36 / version 36 / author 56 / homepage 1024；
 * 3. 脚本声明收敛到我们支持的集合：`type` 必须为 'music'、`local` 丢弃、`actions` 只留
 *    'musicUrl'、`qualitys` 与白名单取交集（未知标签静默丢弃，与 LX 的 handleInit 一致）；
 * 4. 音质标签映射（LX 标签 ↔ 内部 Quality）与偏好序列——**每一档都要留着降级路径**；
 * 5. 交给插件的 `musicInfo` 形状，以及直链提取的 `http(s)` / 2048 边界校验。
 *
 * 这里**只测纯函数**：不起 LxHost、不进 vm、不联网、不写盘。
 */

import { describe, expect, it } from 'vitest';
import { qualityRank } from '@pi/shared';
import type { Quality } from '@pi/shared';
import type { MatchInput } from '@pi/source-core';
import {
  LX_ALLOWED_QUALITYS,
  LX_SCRIPT_INVALID,
  extractLxType,
  extractLxUrl,
  intersectSourceDecls,
  lxTypePreference,
  parseScriptMeta,
  qualityFromLxType,
  toLxMusicInfo,
} from './protocol.js';

/** 造一个「头注释块位于偏移 0」的合法 LX 脚本（真实脚本后面还有带副作用的注册代码）。 */
function lxScript(metaLines: readonly string[]): string {
  const header = metaLines.map((line) => ` * ${line}`).join('\n');
  return `/*\n${header}\n */\nlx.send(lx.EVENT_NAMES.inited, { sources: {} });\n`;
}

/* ------------------------------------------------------------------ *
 * parseScriptMeta
 * ------------------------------------------------------------------ */

describe('parseScriptMeta', () => {
  it('头注释块在偏移 0 时解析出 name/description/version/author/homepage', () => {
    const raw = lxScript([
      '@name 测试音源',
      '@description 一个用来测试的源',
      '@version 1.2.3',
      '@author 张三',
      '@homepage https://example.com/src.js',
    ]);

    const meta = parseScriptMeta(raw);

    expect(meta.name).toBe('测试音源');
    expect(meta.description).toBe('一个用来测试的源');
    expect(meta.version).toBe('1.2.3');
    expect(meta.author).toBe('张三');
    expect(meta.homepage).toBe('https://example.com/src.js');
    // rawScript 必须原样保留（LX 的 rawScript，后续要整段喂给沙箱）。
    expect(meta.rawScript).toBe(raw);
  });

  it('头注释块不在偏移 0 时抛「无效的自定义源文件」（与 LX 文案一致）', () => {
    const valid = lxScript(['@name 测试音源']);
    const notAtZero = [
      `\n${valid}`, // 前面有空行
      `  ${valid}`, // 前面有空格
      `// 一行行注释\n${valid}`, // 前面有别的东西
      `const foo = 1;\n${valid}`, // 前面是代码
    ];

    for (const text of notAtZero) {
      expect(() => parseScriptMeta(text)).toThrow(LX_SCRIPT_INVALID);
      expect(() => parseScriptMeta(text)).toThrow('无效的自定义源文件');
    }
  });

  it('没有可用的头注释块时一律抛无效（空串 / 未闭合块注释）', () => {
    expect(() => parseScriptMeta('')).toThrow(LX_SCRIPT_INVALID);
    expect(() => parseScriptMeta('lx.send(lx.EVENT_NAMES.inited, {});')).toThrow(LX_SCRIPT_INVALID);
    expect(() => parseScriptMeta('/*\n * @name 测试音源\n')).toThrow(LX_SCRIPT_INVALID);
  });

  it('超长元数据按 LX 的上限截断（name 24 / description 36 / version 36 / author 56）', () => {
    const longName = 'N'.repeat(60);
    const longDescription = 'D'.repeat(60);
    const longVersion = 'V'.repeat(60);
    const longAuthor = 'A'.repeat(60);

    const meta = parseScriptMeta(
      lxScript([
        `@name ${longName}`,
        `@description ${longDescription}`,
        `@version ${longVersion}`,
        `@author ${longAuthor}`,
      ]),
    );

    expect(meta.name).toBe(longName.slice(0, 24));
    expect(meta.name).toHaveLength(24);
    expect(meta.description).toBe(longDescription.slice(0, 36));
    expect(meta.description).toHaveLength(36);
    expect(meta.version).toBe(longVersion.slice(0, 36));
    expect(meta.version).toHaveLength(36);
    expect(meta.author).toBe(longAuthor.slice(0, 56));
    expect(meta.author).toHaveLength(56);
  });

  it('超长 homepage 截断到 1024（这是上限最大的一个字段）', () => {
    const longHomepage = `https://example.com/${'h'.repeat(1100)}`;
    const meta = parseScriptMeta(lxScript(['@name 测试音源', `@homepage ${longHomepage}`]));

    expect(meta.homepage).toHaveLength(1024);
    expect(meta.homepage).toBe(longHomepage.slice(0, 1024));
  });

  it('没有声明 name 时回落默认名「未命名音源」', () => {
    const meta = parseScriptMeta(lxScript(['@description 没有名字的源', '@author 李四']));

    expect(meta.name).toBe('未命名音源');
    expect(meta.description).toBe('没有名字的源');
  });

  it('没有声明的字段一律是空串，不是 undefined（下游按字符串用）', () => {
    const meta = parseScriptMeta(lxScript(['@name 测试音源']));

    expect(meta.description).toBe('');
    expect(meta.version).toBe('');
    expect(meta.author).toBe('');
    expect(meta.homepage).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * intersectSourceDecls
 * ------------------------------------------------------------------ */

describe('intersectSourceDecls', () => {
  it('type 不是 music 的条目被丢弃，合法的只保留我们认识的源 key', () => {
    const raw = {
      kw: { type: 'music', qualitys: ['128k'] },
      kg: { type: 'local', qualitys: ['320k'] }, // 不是网络音源 → 丢
      tx: { qualitys: ['flac'] }, // 没声明 type → 丢
      wy: { type: 'music', qualitys: ['flac24bit', 'bogus'] },
      mg: { type: 'MUSIC', qualitys: ['128k'] }, // 大小写敏感 → 丢
      unknown: { type: 'music', qualitys: ['flac'] }, // 不是 LX 的源 key → 丢
    };

    expect(intersectSourceDecls(raw)).toEqual({
      kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
      wy: { type: 'music', actions: ['musicUrl'], qualitys: ['flac24bit'] },
    });
  });

  it('local 是本地文件源，即使声明 type: music 也丢弃', () => {
    expect(intersectSourceDecls({ local: { type: 'music', qualitys: ['flac'] } })).toEqual({});
    // 同一份声明里，local 被丢掉但网络源要留下。
    expect(
      intersectSourceDecls({
        local: { type: 'music', qualitys: ['flac'] },
        kw: { type: 'music', qualitys: ['flac'] },
      }),
    ).toEqual({ kw: { type: 'music', actions: ['musicUrl'], qualitys: ['flac'] } });
  });

  it('actions 收敛成 [musicUrl]：插件声明的其它动作一律丢掉', () => {
    const result = intersectSourceDecls({
      kw: { type: 'music', actions: ['lyric', 'pic', 'musicUrl'], qualitys: ['128k'] },
    });

    expect(result.kw?.actions).toEqual(['musicUrl']);
  });

  it('qualitys 与白名单取交集，未知音质被过滤，且顺序按白名单而非脚本声明', () => {
    const result = intersectSourceDecls({
      kw: {
        type: 'music',
        qualitys: ['master', '320k', 'bogus', 'flac24bit', '128k', 'hires24bit', '『未知』'],
      },
    });

    expect(result.kw?.qualitys).toEqual(['128k', '320k', 'flac24bit', 'hires24bit', 'master']);
  });

  it('过滤后的音质一定都在白名单里', () => {
    const result = intersectSourceDecls({
      wy: { type: 'music', qualitys: [...LX_ALLOWED_QUALITYS, 'not-a-quality', ''] },
    });

    expect(result.wy?.qualitys).toEqual([...LX_ALLOWED_QUALITYS]);
    for (const quality of result.wy?.qualitys ?? []) {
      expect(LX_ALLOWED_QUALITYS).toContain(quality);
    }
  });

  it('空/畸形输入返回空结果且不抛错', () => {
    const garbage: unknown[] = [
      undefined,
      null,
      0,
      '',
      'not-an-object',
      [],
      {},
      { kw: 'str' }, // 条目不是对象
      { kw: null },
      { kw: [] }, // 数组是对象但没声明 type
    ];

    for (const input of garbage) {
      expect(() => intersectSourceDecls(input)).not.toThrow();
      expect(intersectSourceDecls(input)).toEqual({});
    }
  });

  it('qualitys 不是数组时视为「没声明音质」，条目本身仍然有效', () => {
    expect(intersectSourceDecls({ mg: { type: 'music', qualitys: 'flac' } })).toEqual({
      mg: { type: 'music', actions: ['musicUrl'], qualitys: [] },
    });
    expect(intersectSourceDecls({ mg: { type: 'music' } })).toEqual({
      mg: { type: 'music', actions: ['musicUrl'], qualitys: [] },
    });
  });
});

/* ------------------------------------------------------------------ *
 * 音质映射
 * ------------------------------------------------------------------ */

describe('qualityFromLxType', () => {
  const table: ReadonlyArray<readonly [string, Quality]> = [
    ['128k', 'standard'],
    ['192k', 'higher'],
    ['320k', 'exhigh'],
    ['flac', 'lossless'],
    ['ape', 'lossless'],
    ['wav', 'lossless'],
    ['flac24bit', 'flac24bit'],
    ['hires', 'hires'],
    ['hires24bit', 'hires'],
    ['atmos', 'jymaster'],
    ['master', 'jymaster'],
  ];

  it('LX 标签映射到内部档位', () => {
    for (const [lxType, expected] of table) {
      expect(qualityFromLxType(lxType)).toBe(expected);
    }
  });

  it('未知标签兜底到 standard（绝不让未知值变成高音质）', () => {
    for (const unknown of ['', 'unknown', '128K', 'FLAC', 'flac 24bit', 'jymaster', '』']) {
      expect(qualityFromLxType(unknown)).toBe('standard');
    }
  });
});

describe('lxTypePreference', () => {
  const table: ReadonlyArray<readonly [Quality, readonly string[]]> = [
    ['standard', ['128k']],
    ['higher', ['192k', '128k']],
    ['exhigh', ['320k', '192k', '128k']],
    ['lossless', ['flac24bit', 'flac', 'ape', 'wav', '320k']],
    ['flac', ['flac', 'flac24bit', 'ape', 'wav', '320k']],
    ['flac24bit', ['flac24bit', 'flac', 'ape', 'wav', '320k']],
    ['hires', ['hires24bit', 'hires', 'master', 'atmos', 'flac24bit', 'flac', '320k']],
    ['jymaster', ['hires24bit', 'hires', 'master', 'atmos', 'flac24bit', 'flac', '320k']],
  ];

  it('每个档位返回固定的询问序列（从高到低）', () => {
    for (const [quality, expected] of table) {
      expect(lxTypePreference(quality)).toEqual(expected);
    }
  });

  it('序列里一定留着降级路径：末尾是有损兜底标签', () => {
    const lossy = ['320k', '192k', '128k'];

    for (const [quality] of table) {
      const sequence = lxTypePreference(quality);
      expect(sequence.length).toBeGreaterThan(0);
      // standard 已经是最低档，它的末尾就是 128k（floor）。
      expect(lossy).toContain(lastTag(sequence));
    }
  });

  it('比 standard 高的档位，兜底标签的实测档位必须真的更低（真的能降级）', () => {
    for (const [quality] of table) {
      if (quality === 'standard') continue;
      const tail = lastTag(lxTypePreference(quality));
      expect(qualityRank(qualityFromLxType(tail))).toBeLessThan(qualityRank(quality));
    }
  });

  it('要无损时给出的都是无损或更高的标签，有损只作为末尾兜底', () => {
    const sequence = lxTypePreference('lossless');
    // flac24bit 是自己的档位（不算 lossless），但同样是无损级别。
    const losslessOrAbove = sequence.slice(0, -1);

    expect(losslessOrAbove).toEqual(['flac24bit', 'flac', 'ape', 'wav']);
    for (const tag of losslessOrAbove) {
      expect(qualityRank(qualityFromLxType(tag))).toBeGreaterThanOrEqual(qualityRank('lossless'));
    }
    expect(lastTag(sequence)).toBe('320k');
  });
});

/** 取序列末位（noUncheckedIndexedAccess 下不靠非空断言）。 */
function lastTag(sequence: readonly string[]): string {
  const tag = sequence.at(-1);
  if (tag === undefined) throw new Error('偏好序列不应为空');
  return tag;
}

/* ------------------------------------------------------------------ *
 * musicInfo
 * ------------------------------------------------------------------ */

describe('toLxMusicInfo', () => {
  const input: MatchInput = {
    songId: 1_234_567,
    quality: 'lossless',
    title: '晴天',
    artists: ['周杰伦', '方文山'],
    albumName: '叶惠美',
    durationMs: 269_000,
  };

  it('歌手用「、」连接，歌名/专辑/时长按 LX 形状透传', () => {
    const info = toLxMusicInfo(input, 'wy');

    expect(info.name).toBe('晴天');
    expect(info.singer).toBe('周杰伦、方文山');
    expect(info.albumName).toBe('叶惠美');
    // LX 的 interval 单位是毫秒（不是秒）。
    expect(info.interval).toBe(269_000);
    expect(info.source).toBe('wy');
  });

  it('songmid 是字符串形式的网易歌曲 id', () => {
    expect(toLxMusicInfo(input, 'wy').songmid).toBe('1234567');
    expect(typeof toLxMusicInfo(input, 'wy').songmid).toBe('string');
  });

  it('缺专辑/时长时给出 LX 约定的空值（interval 为 null 而不是 undefined）', () => {
    const info = toLxMusicInfo(
      { songId: 42, quality: 'standard', title: '无题', artists: [] },
      'kw',
    );

    expect(info.singer).toBe('');
    expect(info.albumName).toBe('');
    expect(info.interval).toBeNull();
    expect(info.source).toBe('kw');
    expect(info.songmid).toBe('42');
  });

  it('我们没有的平台专属字段一律填空容器，不瞎编（插件会自己走搜索逻辑）', () => {
    const info = toLxMusicInfo(input, 'wy');

    expect(info.img).toBeNull();
    expect(info.albumId).toBe('');
    expect(info.typeUrl).toEqual({});
    expect(info.types).toEqual({});
    expect(info._types).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * 直链提取
 * ------------------------------------------------------------------ */

describe('extractLxUrl', () => {
  const url = 'https://m10.music.126.net/abc/song.mp3';

  it('接受裸字符串与 { url } 两种社区写法', () => {
    expect(extractLxUrl(url)).toBe(url);
    expect(extractLxUrl({ url })).toBe(url);
    // 社区脚本常把 type 和 url 一起返回，多余字段不影响取直链。
    expect(extractLxUrl({ type: 'flac', url })).toBe(url);
    // http 也算合法（部分源走明文）。
    expect(extractLxUrl('http://example.com/a.mp3')).toBe('http://example.com/a.mp3');
  });

  it('拒绝非 http(s) 的值', () => {
    for (const bad of [
      'ftp://example.com/a.mp3',
      '//example.com/a.mp3',
      'example.com/a.mp3',
      'HTTP://example.com/a.mp3', // 协议名大小写敏感
      'javascript:alert(1)',
      ' https://example.com/a.mp3', // 前导空格
    ]) {
      expect(extractLxUrl(bad)).toBeUndefined();
    }
  });

  it('拒绝空值/未定义/非字符串的 url', () => {
    for (const bad of [
      undefined,
      null,
      '',
      42,
      true,
      {},
      [],
      { url: '' },
      { url: 42 },
      { url: null },
    ]) {
      expect(extractLxUrl(bad)).toBeUndefined();
    }
  });

  it('长度上限是 2048：恰好 2048 通过，2049 拒绝', () => {
    const base = 'https://a.example.com/';
    const exact = base + 'a'.repeat(2048 - base.length);

    expect(exact).toHaveLength(2048);
    expect(extractLxUrl(exact)).toBe(exact);
    expect(extractLxUrl(`${exact}a`)).toBeUndefined();
  });
});

describe('extractLxType', () => {
  it('只在对象里有字符串 type 时给出标签', () => {
    expect(extractLxType({ type: 'flac', url: 'https://example.com/a.flac' })).toBe('flac');
    expect(extractLxType({ type: 'flac' })).toBe('flac');
  });

  it('裸字符串/缺字段/非字符串 type 都没有标签', () => {
    expect(extractLxType('flac')).toBeUndefined();
    expect(extractLxType({ url: 'https://example.com/a.flac' })).toBeUndefined();
    expect(extractLxType({ type: 42 })).toBeUndefined();
    expect(extractLxType(undefined)).toBeUndefined();
    expect(extractLxType(null)).toBeUndefined();
  });
});
