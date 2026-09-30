/**
 * `@pi/ncm-client/src/index.ts` 评论与「喜欢」的行为锁（M3 / M4）。
 *
 * 这几条承诺值得钉死，因为它们的坑都在「看不见的地方」：
 *
 * 1. **热门评论只有第一页**：`/comment/hot` 是另一个接口，翻页时再拉既多一次请求，
 *    也会让「热门」区块随页码跳动；
 * 2. **`like` 的失败必须炸出来**：内嵌 API 用 `query.like == 'false'` 判断取消，
 *    而未登录时上游只给一个非 200 的 `code`——如果这里安静地返回 false，界面上就会
 *    出现「心形按下去又弹回来，但没有任何提示」；
 * 3. **`likedSongIds` 走的是真实存在的路由**：`/song/like` 在内嵌 API 里根本不存在，
 *    正确的是 `/song/like/check`（已核对 `NeteaseCloudMusicApi/module/song_like_check.js`），
 *    而且它的元素形状上游没钉死，两种形态都得认；
 * 4. **歌词要吃得下上游的脏格式**：一行多标签、老式 `[mm:ss:xxx]`、`[offset:..]`、
 *    逐字歌词（yrc）的 `<mm:ss.xxx>` 与 `(开始,时长,未知)` 标记，都得处理干净；
 *    「这首歌没有歌词」必须靠 `hasLyric` 如实上报，不能靠 `lines.length` 猜。
 *
 * 全程离线：`call()` 被换成假实现，不发任何请求、不起进程。
 */

import { describe, expect, it } from 'vitest';
import { NcmApiError, NcmClient, parseLrc } from './index.js';

interface FakeCall {
  route: string;
  params: Record<string, unknown>;
}

/** 造一个「参数照单全收、响应按路由预置」的客户端；顺带把调用记录留下来供断言。 */
function createFakeClient(responses: Record<string, unknown>) {
  const calls: FakeCall[] = [];
  const client = new NcmClient({ getBaseUrl: () => 'http://127.0.0.1:1' });
  client.call = async (route: string, params: Record<string, unknown> = {}) => {
    calls.push({ route, params });
    return responses[route];
  };
  return {
    client,
    calls,
    routes: () => calls.map((item) => item.route),
    paramsOf: (route: string) => calls.find((item) => item.route === route)?.params,
  };
}

/** 一条「什么字段都有」的原始评论：故意包含可选字段，用来验证它们不会被丢掉。 */
const RAW_COMMENT = {
  commentId: 11,
  content: '好听',
  time: 1_700_000_000_000,
  likedCount: 3,
  ipLocation: '广东',
  user: { userId: 7, nickname: '小明', avatarUrl: 'http://p1.music.126.net/a.jpg' },
  beReplied: [{ user: { nickname: '小红' }, content: '+1' }],
};

/** 与之对应的领域模型：头像已被 `coverUrl` 升级成 https 并带上尺寸参数。 */
const MAPPED_COMMENT = {
  id: 11,
  content: '好听',
  time: 1_700_000_000_000,
  likedCount: 3,
  user: { id: 7, nickname: '小明', avatarUrl: 'https://p1.music.126.net/a.jpg?param=100y100' },
  beReplied: [{ nickname: '小红', content: '+1' }],
  location: '广东',
};

describe('comments', () => {
  it('第一页同时拉 /comment/music 与 /comment/hot，并翻译成领域模型', async () => {
    const fake = createFakeClient({
      '/comment/music': { total: 100, more: true, comments: [RAW_COMMENT] },
      '/comment/hot': { hotComments: [RAW_COMMENT] },
    });

    const page = await fake.client.comments(186016, 0, 20);

    expect(fake.routes()).toEqual(['/comment/music', '/comment/hot']);
    // type=0 是 `/comment/hot` 的必传参数（内嵌 API 靠它拼上游的 `R_SO_4_` 前缀）。
    expect(fake.paramsOf('/comment/music')).toEqual({
      id: 186016,
      type: 0,
      offset: 0,
      limit: 20,
    });
    expect(fake.paramsOf('/comment/hot')).toEqual({ id: 186016, type: 0, offset: 0, limit: 15 });
    expect(page).toEqual({
      total: 100,
      hasMore: true,
      hot: [MAPPED_COMMENT],
      comments: [MAPPED_COMMENT],
    });
  });

  it('翻页不再拉热门评论，`hot` 恒为空数组', async () => {
    const fake = createFakeClient({
      '/comment/music': { total: 100, more: true, comments: [RAW_COMMENT] },
    });

    const page = await fake.client.comments(186016, 20, 20);

    expect(fake.routes()).toEqual(['/comment/music']);
    expect(fake.paramsOf('/comment/music')?.['offset']).toBe(20);
    expect(page.hot).toEqual([]);
  });

  it('`more` 缺失时才用 offset + 本页条数 < total 兜底', async () => {
    const lastPage = createFakeClient({
      '/comment/music': { total: 1, comments: [RAW_COMMENT] },
    });
    expect((await lastPage.client.comments(1, 0, 20)).hasMore).toBe(false);

    const notLast = createFakeClient({
      '/comment/music': { total: 100, comments: [RAW_COMMENT] },
    });
    expect((await notLast.client.comments(1, 0, 20)).hasMore).toBe(true);

    // `more` 与兜底结论冲突时以接口为准（`total` 在高赞排序下会漂）。
    const explicit = createFakeClient({
      '/comment/music': { total: 100, more: false, comments: [RAW_COMMENT] },
    });
    expect((await explicit.client.comments(1, 0, 20)).hasMore).toBe(false);
  });

  it('缺 commentId/content 的评论被丢掉；可选字段缺失时不编造', async () => {
    const fake = createFakeClient({
      '/comment/music': {
        comments: [
          { commentId: 1, content: 'ok', time: 1, likedCount: 0, user: { userId: 9, nickname: '甲' } },
          { content: '没有 id' },
          { commentId: 2 },
        ],
      },
    });

    const page = await fake.client.comments(1, 0, 20);

    expect(page.comments).toEqual([
      { id: 1, content: 'ok', time: 1, likedCount: 0, user: { id: 9, nickname: '甲' } },
    ]);
    // `total` 缺失时退化成「本页实际拿到了几条」，至少不会算出负数或跳页。
    expect(page.total).toBe(1);
  });
});

describe('like', () => {
  it('喜欢传字符串 "true"，并且只有 code=200 才算成功', async () => {
    const fake = createFakeClient({ '/like': { code: 200 } });

    await expect(fake.client.like(347230, true)).resolves.toBe(true);
    expect(fake.paramsOf('/like')).toEqual({ id: 347230, like: 'true' });
  });

  it('取消喜欢传字符串 "false"（内嵌 API 只认这个字面量）', async () => {
    const fake = createFakeClient({ '/like': { code: 200 } });

    await expect(fake.client.like(347230, false)).resolves.toBe(true);
    expect(fake.paramsOf('/like')).toEqual({ id: 347230, like: 'false' });
  });

  it('业务失败（未登录 301）抛 NcmApiError，绝不静默返回 false', async () => {
    const fake = createFakeClient({ '/like': { code: 301, message: '需要登录' } });

    await expect(fake.client.like(347230, true)).rejects.toThrow(NcmApiError);
    await expect(fake.client.like(347230, true)).rejects.toThrow('需要登录');
  });
});

describe('likedSongIds', () => {
  it('指定 ids 时走 /song/like/check，兼裸 id 与 { id, liked } 两种形态', async () => {
    const fake = createFakeClient({
      '/song/like/check': {
        code: 200,
        data: [{ id: 1, liked: true }, { id: 2, liked: false }, 3, { songId: 4 }, { id: 5, liked: 0 }],
      },
    });

    expect(await fake.client.likedSongIds([1, 2, 3])).toEqual([1, 3, 4]);
    expect(fake.routes()).toEqual(['/song/like/check']);
    expect(fake.paramsOf('/song/like/check')).toEqual({ ids: '[1,2,3]' });
  });

  it('不传 ids 时先用 /user/account 换 uid，再查 /likelist 全量', async () => {
    const fake = createFakeClient({
      '/user/account': {
        account: { anonimousUser: false },
        profile: { userId: 42, nickname: '我' },
      },
      '/likelist': { ids: [7, '8', '不是数字'] },
    });

    expect(await fake.client.likedSongIds()).toEqual([7, 8]);
    expect(fake.routes()).toEqual(['/user/account', '/likelist']);
    // `/likelist` 的 uid 是必选参数，内嵌 API 不会从 cookie 里推。
    expect(fake.paramsOf('/likelist')).toEqual({ uid: 42 });
  });

  it('未登录（只有匿名账号）时抛出可读错误，而不是悄悄返回空列表', async () => {
    const fake = createFakeClient({
      '/user/account': { account: { anonimousUser: true }, profile: { userId: 9 } },
    });

    await expect(fake.client.likedSongIds()).rejects.toThrow(
      '这个功能需要先登录网易云账号。',
    );
  });
});

describe('lyric', () => {
  it('走 /lyric/new 并带上 lv/kv/tv=-1，翻译单独成列', async () => {
    const fake = createFakeClient({
      '/lyric/new': {
        code: 200,
        lrc: { lyric: '[00:01.00]第一句\n[00:02.50]第二句' },
        tlyric: { lyric: '[00:01.00]line one' },
      },
    });

    const result = await fake.client.lyric(186016);

    expect(fake.routes()).toEqual(['/lyric/new']);
    expect(fake.paramsOf('/lyric/new')).toEqual({ id: 186016, lv: -1, kv: -1, tv: -1 });
    expect(result).toEqual({
      lines: [
        { timeMs: 1000, text: '第一句' },
        { timeMs: 2500, text: '第二句' },
      ],
      translated: [{ timeMs: 1000, text: 'line one' }],
      hasLyric: true,
    });
  });

  it('同时有 yrc 时以 yrc 为原文，并剥掉逐字标记', async () => {
    const fake = createFakeClient({
      '/lyric/new': {
        code: 200,
        lrc: { lyric: '[00:01.00]普通歌词' },
        yrc: { lyric: '[00:01.00]<00:01.00>逐(1000,200,0)<00:01.20>字(1200,200,0)' },
      },
    });

    const result = await fake.client.lyric(1);

    expect(result.lines).toEqual([{ timeMs: 1000, text: '逐字' }]);
    expect(result.hasLyric).toBe(true);
  });

  it('yrc 解析不出东西时退回 lrc，绝不显示成「没有歌词」', async () => {
    const fake = createFakeClient({
      '/lyric/new': {
        code: 200,
        lrc: { lyric: '[00:01.00]普通歌词' },
        // 上游的 yrc 里会混进 JSON 元数据行；整份都解析不出来时不能把 lrc 也丢掉。
        yrc: { lyric: '{"t":0,"c":[{"tx":"作曲: "}]}' },
      },
    });

    expect((await fake.client.lyric(1)).lines).toEqual([{ timeMs: 1000, text: '普通歌词' }]);
  });

  it('没有 tlyric 时 translated 是空数组（而不是省略字段）', async () => {
    const fake = createFakeClient({
      '/lyric/new': { code: 200, lrc: { lyric: '[00:01.00]啊' } },
    });

    const result = await fake.client.lyric(1);

    expect(result.translated).toEqual([]);
    expect(Object.keys(result).sort()).toEqual(['hasLyric', 'lines', 'translated']);
  });

  it('lrc 缺失或为空串时 hasLyric=false、lines=[]，且这不抛错', async () => {
    const missing = createFakeClient({ '/lyric/new': { code: 200 } });
    await expect(missing.client.lyric(1)).resolves.toEqual({
      lines: [],
      translated: [],
      hasLyric: false,
    });

    const blank = createFakeClient({ '/lyric/new': { code: 200, lrc: { lyric: '' } } });
    await expect(blank.client.lyric(1)).resolves.toEqual({
      lines: [],
      translated: [],
      hasLyric: false,
    });
  });

  it('业务失败（code !== 200）抛 NcmApiError，绝不静默返回空歌词', async () => {
    const fake = createFakeClient({ '/lyric/new': { code: 404, message: '没有这首歌' } });

    await expect(fake.client.lyric(1)).rejects.toThrow(NcmApiError);
    await expect(fake.client.lyric(1)).rejects.toThrow('没有这首歌');
  });
});

describe('parseLrc', () => {
  it('一行多个时间标签展开成多行', () => {
    expect(parseLrc('[00:01.00][00:05.00]重复')).toEqual([
      { timeMs: 1000, text: '重复' },
      { timeMs: 5000, text: '重复' },
    ]);
  });

  it('支持 [mm:ss.xxx]、老格式 [mm:ss:xxx] 与 [mm:ss]，并按时间升序', () => {
    expect(parseLrc('[01:02.345]A\n[01:02:50]B\n[00:03]C')).toEqual([
      { timeMs: 3000, text: 'C' },
      { timeMs: 62_345, text: 'A' },
      { timeMs: 62_500, text: 'B' },
    ]);
  });

  it('同一时间点的重复文本去重', () => {
    expect(parseLrc('[00:10.00]后\n[00:01.00]前\n[00:01.00]前')).toEqual([
      { timeMs: 1000, text: '前' },
      { timeMs: 10_000, text: '后' },
    ]);
  });

  it('文本 trim 后为空的行丢弃（占位空行不留进界面）', () => {
    expect(parseLrc('[00:01.00]有词\n[00:02.00]\n[00:03.00]   \n[00:04.00]还有')).toEqual([
      { timeMs: 1000, text: '有词' },
      { timeMs: 4000, text: '还有' },
    ]);
  });

  it('元数据行（[ti:..]/[ar:..]/[al:..]/[by:..]）一律跳过', () => {
    const text = '[ti:歌名]\n[ar:歌手]\n[al:专辑]\n[by:制作]\n[00:01.00]正文';
    expect(parseLrc(text)).toEqual([{ timeMs: 1000, text: '正文' }]);
  });

  it('[offset:..] 作为整首歌的毫秒偏移加到所有时间上', () => {
    expect(parseLrc('[offset:-500]\n[00:01.00]偏了')).toEqual([{ timeMs: 500, text: '偏了' }]);
    expect(parseLrc('[offset:250]\n[00:01.00]偏了')).toEqual([{ timeMs: 1250, text: '偏了' }]);
  });

  it('yrc 的 [mm:ss.xxx] 行 + 括号尾巴能被剥掉', () => {
    expect(parseLrc('[00:12.34]你好(12.34,0.5)')).toEqual([{ timeMs: 12_340, text: '你好' }]);
  });

  it('yrc 真实上游格式的行首 [开始毫秒,持续毫秒] 也能解析', () => {
    expect(parseLrc('[16210,3460](16210,670,0)还(16880,410,0)没')).toEqual([
      {
        timeMs: 16_210,
        text: '还没',
        // 第十一轮第 1 条：行首的第二个数（这一行真实唱多久）与行内的逐字时间戳都带上来
        durationMs: 3460,
        words: [
          { timeMs: 16_210, durationMs: 670, text: '还' },
          { timeMs: 16_880, durationMs: 410, text: '没' },
        ],
      },
    ]);
  });

  it('yrc 逐字标记漏掉一部分文本时只保留行时长，不给出错位的 words', () => {
    // 「还没」在第一个 `(...)` **之前** ⇒ 没有任何组覆盖它 ⇒ 整行不作 words（渲染层退回均分）
    expect(parseLrc('[16210,3460]还没(16210,670,0)')).toEqual([
      { timeMs: 16_210, text: '还没', durationMs: 3460 },
    ]);
  });

  it('yrc 一个组覆盖连续多字时按「一个词」收下（渲染层再按字素均分这个词的时长）', () => {
    expect(parseLrc('[16210,3460](16210,670,0)还没')).toEqual([
      {
        timeMs: 16_210,
        text: '还没',
        durationMs: 3460,
        words: [{ timeMs: 16_210, durationMs: 670, text: '还没' }],
      },
    ]);
  });

  it('yrc 逐字标记里夹着 <> 标签时同样不给 words（宁可不认，不错位）', () => {
    expect(parseLrc('[16210,3460]<16210,670,0>还(16880,410,0)没')).toEqual([
      { timeMs: 16_210, text: '还没', durationMs: 3460 },
    ]);
  });

  it('yrc 的 [offset:..] 同时加到行时间与逐字时间上', () => {
    expect(parseLrc('[offset:100]\n[1000,2000](1000,500,0)甲(1500,500,0)乙')).toEqual([
      {
        timeMs: 1100,
        text: '甲乙',
        durationMs: 2000,
        words: [
          { timeMs: 1100, durationMs: 500, text: '甲' },
          { timeMs: 1600, durationMs: 500, text: '乙' },
        ],
      },
    ]);
  });

  it('纯 LRC 行不带 durationMs / words（渲染层仍按下一行推算）', () => {
    expect(parseLrc('[00:01.00]甲\n[00:05.00]乙')).toEqual([
      { timeMs: 1000, text: '甲' },
      { timeMs: 5000, text: '乙' },
    ]);
  });

  it('空文本返回空数组', () => {
    expect(parseLrc('')).toEqual([]);
  });
});
