import type {
  Comment,
  CommentPage,
  Lyric,
  LyricLine,
  LyricWord,
  PlayedTrack,
  Playlist,
  Quality,
  SearchResult,
  Song,
  TrackPage,
} from '@pi/shared';

/**
 * 网易云官方接口的瘦客户端（L0 音源）。
 *
 * 它只做两件事：把请求打到内嵌子进程，以及把**后端的原始响应**翻译成 @pi/shared
 * 的领域模型。翻译层刻意写得防御性很强——后端字段说改就改，解析失败应该是
 * 「少几个字段」而不是「整个页面白屏」。
 *
 * 账号安全红线（docs/PLAN.md §2.5）：cookie 只允许经由此客户端发往 127.0.0.1 的
 * 内嵌服务，**绝不允许**出现在任何第三方音源（L1/L2/L3）的请求里。
 */
export interface NcmClientOptions {
  /** 内嵌服务地址；未就绪时返回 undefined，调用方应自行等待。 */
  getBaseUrl: () => string | undefined;
  /** 登录 cookie（含 MUSIC_U）；未登录返回 undefined。 */
  getCookie?: () => string | undefined;
  timeoutMs?: number;
}

export class NcmApiError extends Error {
  constructor(
    message: string,
    readonly route: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'NcmApiError';
  }
}

export class NcmClient {
  constructor(private readonly options: NcmClientOptions) {}

  /** 原始调用。返回 `unknown`，由各 route 方法负责翻译。 */
  async call(route: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const baseUrl = this.options.getBaseUrl();
    if (!baseUrl) {
      throw new NcmApiError('内嵌网易云 API 尚未就绪', route);
    }
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      body.set(key, String(value));
    }
    const cookie = this.options.getCookie?.();
    if (cookie) {
      // NCM 支持从请求体读 cookie；比塞进 query string 更安全（不会进 URL 日志）。
      body.set('cookie', cookie);
    }
    // 网易云对「没有 cookie 的裸请求」风控更严，带上时间戳可显著降低空结果概率。
    body.set('timestamp', String(Date.now()));

    const res = await fetch(`${baseUrl}/${route.replace(/^\//, '')}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // 内嵌 API 挂了一个全局「2 分钟响应缓存」，它的 key 是
        // `hostname + originalUrl + cookies`——**不含请求体，也不区分请求方法**。
        // 而我们把所有参数都放在 POST body 里，所以不加这个头时，同一路由的第二次
        // 请求会直接返回第一次的响应（实测：三首不同的歌解析出同一个直链、同一个文件大小）。
        'x-apicache-bypass': 'true',
      },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new NcmApiError(
        `接口返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`,
        route,
        res.status,
      );
    }

    if (!res.ok) {
      throw new NcmApiError(
        `接口报错（HTTP ${res.status}）：${extractMessage(parsed) ?? '未知错误'}`,
        route,
        res.status,
      );
    }
    // 网易云习惯用 HTTP 200 + body.code !== 200 表示业务错误。
    const body404 = asRecord(parsed);
    const code = asNumber(body404?.['code']);
    if (code !== undefined && code !== 200 && code !== 0) {
      return parsed; // 交给调用方决定是否致命（很多接口会用 301 表示需要登录）
    }
    return parsed;
  }

  /** 综合搜索。M0 只取歌曲，M1 补歌单/歌手/专辑。 */
  async search(keywords: string, limit = 30): Promise<SearchResult> {
    const raw = asRecord(await this.call('/cloudsearch', { keywords, type: 1, limit }));
    const result = asRecord(raw?.['result']);
    const songs = asArray(result?.['songs']).map(mapSong).filter(isPresent);
    return { songs, playlists: [], artists: [], albums: [] };
  }

  /**
   * 取播放直链。
   * `level` 必须已被账号能力夹逼过（非 VIP 最高 exhigh，见 §4.2）。
   *
   * `freeTrial` 是**必须**传出去的：对 VIP 歌曲，官方会给一个只有 30 秒的试听直链，
   * 如果不标注，用户就会听到「播一半突然停」，还会以为是我们播坏了。
   */
  async songUrl(
    songId: number,
    level: Quality,
  ): Promise<{ url?: string; level?: string; freeTrial?: boolean }> {
    const raw = asRecord(await this.call('/song/url/v1', { id: songId, level }));
    const first = asArray(raw?.['data'])[0];
    const row = asRecord(first);
    const url = asString(row?.['url']);
    const trialInfo = asRecord(row?.['freeTrialInfo']);
    const freeTrial = trialInfo !== undefined && asNumber(trialInfo['end']) !== undefined;
    return {
      ...(url ? { url } : {}),
      ...(asString(row?.['level']) ? { level: asString(row?.['level']) } : {}),
      ...(freeTrial ? { freeTrial: true } : {}),
    };
  }

  /* ---------------------------------------------------------------- *
   * 登录（二维码）
   *
   * 网易云早已封禁「手机号 + 密码」登录（docs/PLAN.md §8），二维码是
   * 唯一稳定可用的登录方式。三步走：要 key → 用 key 生成二维码图 → 轮询 key。
   * ---------------------------------------------------------------- */

  async loginQrKey(): Promise<string> {
    const raw = asRecord(await this.call('/login/qr/key'));
    const key = asString(asRecord(raw?.['data'])?.['unikey']);
    if (!key) throw new NcmApiError('没能取到二维码 key', '/login/qr/key');
    return key;
  }

  async loginQrCreate(key: string): Promise<{ image: string; url?: string }> {
    const raw = asRecord(await this.call('/login/qr/create', { key, qrimg: true }));
    const data = asRecord(raw?.['data']);
    const image = asString(data?.['qrimg']);
    if (!image) throw new NcmApiError('没能生成二维码图片', '/login/qr/create');
    const url = asString(data?.['qrurl']);
    return { image, ...(url ? { url } : {}) };
  }

  /**
   * 轮询扫码状态。
   * 803（授权成功）时后端会在响应体里直接给 `cookie`（含 MUSIC_U）——这是唯一
   * 一次我们能拿到它的机会，调用方必须立刻加密落盘（见 services.saveSession）。
   */
  async loginQrCheck(key: string): Promise<{
    code: number;
    message?: string;
    cookie?: string;
    nickname?: string;
    avatarUrl?: string;
  }> {
    const raw = asRecord(await this.call('/login/qr/check', { key }));
    const cookie = asString(raw?.['cookie']);
    const nickname = asString(raw?.['nickname']);
    const avatarUrl = asString(raw?.['avatarUrl']);
    return {
      code: asNumber(raw?.['code']) ?? 801,
      ...(asString(raw?.['message']) ? { message: asString(raw?.['message']) } : {}),
      ...(cookie ? { cookie } : {}),
      ...(nickname ? { nickname } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    };
  }

  /**
   * 当前登录账号的基本信息。
   *
   * 两个坑：
   * 1. cookie 失效时后端返回 profile 为 null；
   * 2. 内嵌 API 启动时会用 `[register_anonimous]` 自己注册一个**匿名账号**，
   *    这个匿名账号同样带完整 profile 和 userId。不看 `anonimousUser` 标记的话，
   *    没登录的用户会被显示成「已登录 1000_XXXX」——M1 冒烟实测就撞上了这个。
   */
  async account(): Promise<
    { userId: number; nickname?: string; avatarUrl?: string; vipType: number } | undefined
  > {
    const raw = asRecord(await this.call('/user/account'));
    const wire = asRecord(raw?.['account']);
    if (wire?.['anonimousUser'] === true) return undefined;
    const profile = asRecord(raw?.['profile']);
    const userId = asNumber(profile?.['userId']);
    if (userId === undefined) return undefined;
    const nickname = asString(profile?.['nickname']);
    const avatar = coverUrl(asString(profile?.['avatarUrl']), 200);
    return {
      userId,
      ...(nickname ? { nickname } : {}),
      ...(avatar ? { avatarUrl: avatar } : {}),
      vipType: asNumber(profile?.['vipType']) ?? 0,
    };
  }

  /**
   * 会员信息。
   * 这个接口的返回形状在不同账号类型之间差异很大（普通用户 / 黑胶 / 音乐包），
   * 解析一律走防御式；失败返回 undefined，绝不因为「查不到 VIP」就让登录流程失败。
   */
  async vipInfo(uid: number): Promise<{ vip: boolean; vipType: number } | undefined> {
    try {
      const raw = asRecord(await this.call('/vip/info', { uid }));
      const data = asRecord(raw?.['data']);
      if (!data) return undefined;
      const redVipLevel = asNumber(data['redVipLevel']) ?? 0;
      const associator = asRecord(data['associator']);
      const vipCode = asNumber(associator?.['vipCode']) ?? 0;
      if (redVipLevel > 0) return { vip: true, vipType: 11 };
      if (vipCode > 0) return { vip: true, vipType: 10 };
      return { vip: false, vipType: 0 };
    } catch {
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- *
   * 曲库
   * ---------------------------------------------------------------- */

  /** 最近播放。`type: 1` 是最近一周，`type: 0` 是全部历史。 */
  async recentTracks(uid: number, limit = 100, type: 0 | 1 = 1): Promise<PlayedTrack[]> {
    const raw = asRecord(await this.call('/user/record', { uid, type }));
    const primary = asArray(raw?.[type === 1 ? 'weekData' : 'allData']);
    const rows = primary.length > 0 ? primary : asArray(raw?.['allData']);
    return rows
      .slice(0, limit)
      .map((item) => {
        const row = asRecord(item);
        const song = mapSong(row?.['song']);
        if (!song) return undefined;
        return {
          song,
          playCount: asNumber(row?.['playCount']) ?? 0,
          lastPlayedAt: asNumber(row?.['score']) ?? 0,
        } satisfies PlayedTrack;
      })
      .filter(isPresent);
  }

  /** 「我喜欢的音乐」的歌单 id（`/user/playlist` 里 specialType === 5 的那个）。 */
  static LIKED_SPECIAL_TYPE = 5;

  /**
   * 我喜欢的音乐。
   * `/likelist` 只给一堆 id，所以还要用 `/song/detail` 批量换成歌曲对象——
   * 好处是总数与分页完全由我们掌控，不依赖歌单接口的分页怪癖。
   */
  async likedTracks(uid: number, offset = 0, limit = 100): Promise<TrackPage> {
    const raw = asRecord(await this.call('/likelist', { uid }));
    const ids = asArray(raw?.['ids'])
      .map((item) => asNumber(item))
      .filter(isPresent);
    const slice = ids.slice(offset, offset + limit);
    const tracks = slice.length > 0 ? await this.songDetails(slice) : [];
    return { tracks, total: ids.length, hasMore: offset + limit < ids.length };
  }

  /** 批量取歌曲详情（`ids` 上限由后端限制在 1000，我们只按需取几十首）。 */
  async songDetails(ids: readonly number[]): Promise<Song[]> {
    if (ids.length === 0) return [];
    const raw = asRecord(await this.call('/song/detail', { ids: ids.join(',') }));
    return asArray(raw?.['songs']).map(mapSong).filter(isPresent);
  }

  /* ---------------------------------------------------------------- *
   * 评论与「喜欢」
   * ---------------------------------------------------------------- */

  /**
   * 歌曲评论（`/comment/music`）。
   *
   * 热门评论是**另一个接口**（`/comment/hot`，且 `type=0` 必传——内嵌 API 靠它拼
   * 上游的资源类型前缀 `R_SO_4_`，不传会拼出空前缀）。只在第一页拉一次：翻页时再拉
   * 既多一次请求，也会让「热门」区块随页码跳动。
   *
   * `total` / `more` 都取自 `/comment/music`；`more` 缺失时才用
   * `offset + 本页条数 < total` 兜底。
   */
  async comments(songId: number, offset = 0, limit = 20): Promise<CommentPage> {
    const raw = asRecord(await this.call('/comment/music', { id: songId, type: 0, offset, limit }));
    const comments = asArray(raw?.['comments']).map(mapComment).filter(isPresent);
    const total = asNumber(raw?.['total']) ?? offset + comments.length;
    const more = raw?.['more'];
    const hot = offset === 0 ? await this.hotComments(songId) : [];
    return {
      total,
      hasMore: typeof more === 'boolean' ? more : offset + comments.length < total,
      hot,
      comments,
    };
  }

  /** 热门评论（`/comment/hot`）。老版本返 `hotComments`，新版本给 `comments`，两个都认。 */
  async hotComments(songId: number, limit = 15): Promise<Comment[]> {
    const raw = asRecord(await this.call('/comment/hot', { id: songId, type: 0, offset: 0, limit }));
    const legacy = asArray(raw?.['hotComments']);
    const rows = legacy.length > 0 ? legacy : asArray(raw?.['comments']);
    return rows.map(mapComment).filter(isPresent);
  }

  /**
   * 喜欢 / 取消喜欢（`/like`）。
   *
   * `like` 必须显式传字符串：内嵌 API 用 `query.like == 'false'` 判断，只有这个字面量
   * 才会被当成「取消」。官方文档：成功时返回数据的 `code` 为 200，其余为失败
   * （未登录常见 301/250）——失败直接抛 `NcmApiError`，绝不返回一个会被上层误读成
   * 「已取消喜欢」的 false。
   */
  async like(songId: number, like: boolean): Promise<boolean> {
    const raw = asRecord(await this.call('/like', { id: songId, like: like ? 'true' : 'false' }));
    const code = asNumber(raw?.['code']);
    if (code !== 200) {
      throw new NcmApiError(
        extractMessage(raw) ?? '喜欢/取消喜欢失败（可能是未登录）',
        '/like',
        code,
      );
    }
    return true;
  }

  /**
   * 一批歌里「已喜欢」的 id。
   *
   * 路由是 `/song/like/check`——**不是** `/song/like`，后者在内嵌 API 里根本不存在
   * （已核对 `node_modules/NeteaseCloudMusicApi/module/song_like_check.js`）。它把 `ids`
   * 原样转给上游 `/api/song/like/check`；文档（该包 `public/docs/home.md`「歌曲是否喜爱」）
   * 只说返回「由这些 ID 中被标记为喜爱的歌曲组成的数组」，元素形状没钉死，所以下面
   * 两种形态都认：裸 id 数字，或 `{ id, liked }` 对象。
   *
   * 不传 `ids` 时退化为 `/likelist` 全量。`uid` 是 `/likelist` 的**必选**参数（内嵌 API
   * 不会从 cookie 里推 uid），所以这里先问一次 `/user/account` 拿自己的 uid。
   */
  async likedSongIds(ids?: readonly number[]): Promise<number[]> {
    if (ids && ids.length > 0) {
      const raw = asRecord(await this.call('/song/like/check', { ids: `[${ids.join(',')}]` }));
      return asArray(raw?.['data'])
        .map((item) => {
          const plain = asNumber(item);
          if (plain !== undefined) return plain;
          const row = asRecord(item);
          if (!row) return undefined;
          // 有的版本逐条给 `liked`，有的只把已喜欢的塞进结果里、不带这个字段。
          // 所以只排除「明确为假」的，其余一律算已喜欢。
          const liked = row['liked'];
          if (liked === false || liked === 0 || liked === 'false') return undefined;
          return asNumber(row['id']) ?? asNumber(row['songId']) ?? asNumber(row['trackId']);
        })
        .filter(isPresent);
    }

    const me = await this.account();
    if (!me) {
      throw new NcmApiError('这个功能需要先登录网易云账号。', '/likelist');
    }
    const raw = asRecord(await this.call('/likelist', { uid: me.userId }));
    return asArray(raw?.['ids']).map((item) => asNumber(item)).filter(isPresent);
  }

  /* ---------------------------------------------------------------- *
   * 歌词
   * ---------------------------------------------------------------- */

  /**
   * 取歌词（`/lyric/new`）。**不需要登录**——未登录也该能看歌词，和看评论是同一个理由。
   *
   * 上游可能同时给四份：`lrc`（原文）、`yrc`（逐字，时间轴更细）、`tlyric`（翻译）、
   * `romalrc`（罗马音）。有逐字就用逐字当原文，但**逐字解析不出东西时会退回 `lrc`**：
   * 宁可退化成普通歌词，也不该让一首明明有歌词的歌在界面上显示成「暂无歌词」。
   *
   * 纯音乐 / 未收录的歌上游给的是 `code: 200` + 空歌词，那不是错误，
   * 所以这里只如实上报 `hasLyric: false`，不抛异常。
   */
  async lyric(songId: number): Promise<Lyric> {
    const raw = asRecord(await this.call('/lyric/new', { id: songId, lv: -1, kv: -1, tv: -1 }));
    const code = asNumber(raw?.['code']);
    if (code !== 200) {
      throw new NcmApiError(extractMessage(raw) ?? '取歌词失败', '/lyric/new', code);
    }
    const yrc = parseLrc(asString(asRecord(raw?.['yrc'])?.['lyric']) ?? '');
    const lines = yrc.length > 0 ? yrc : parseLrc(asString(asRecord(raw?.['lrc'])?.['lyric']) ?? '');
    return {
      lines,
      translated: parseLrc(asString(asRecord(raw?.['tlyric'])?.['lyric']) ?? ''),
      hasLyric: lines.length > 0,
    };
  }

  /** 我的歌单（含收藏；`subscribed` 标记它是不是收藏来的）。 */
  async myPlaylists(uid: number): Promise<Playlist[]> {
    const raw = asRecord(await this.call('/user/playlist', { uid, limit: 1000, offset: 0 }));
    return asArray(raw?.['playlist']).map(mapPlaylist).filter(isPresent);
  }

  /**
   * 新建歌单（`/playlist/create`）。
   *
   * 内嵌 API 的 `module/playlist_create.js` 把 `name/privacy/type` 转给上游
   * `/api/playlist/create`，成功时 body 里带 `id` 与 `playlist`。名字违规、未登录
   * 等情况会以 `code !== 200` 回来，这里直接抛错 —— 绝不返回一个假 id 让界面
   * 以为自己建好了（用户看到空歌单却怎么也加不进歌是最难查的那种 bug）。
   */
  async createPlaylist(name: string): Promise<{ id: number; playlist?: Playlist }> {
    const raw = asRecord(await this.call('/playlist/create', { name }));
    const code = asNumber(raw?.['code']);
    if (code !== 200) {
      throw new NcmApiError(
        extractMessage(raw) ?? '新建歌单失败（可能是未登录）',
        '/playlist/create',
        code,
      );
    }
    const id =
      asNumber(raw?.['id']) ?? asNumber(asRecord(raw?.['playlist'])?.['id']);
    if (id === undefined) {
      throw new NcmApiError('新建歌单的返回里没有歌单 id', '/playlist/create', code);
    }
    const playlist = mapPlaylist(raw?.['playlist']);
    return { id, ...(playlist !== undefined ? { playlist } : {}) };
  }

  /**
   * 往歌单里加歌 / 从歌单里删歌（`/playlist/tracks`，`op` 为 `add`｜`del`）。
   *
   * 两个容易写错的点（已核对 `node_modules/NeteaseCloudMusicApi/module/playlist_tracks.js`）：
   * - 歌单 id 的参数名是 **`pid`**，不是 `id`；
   * - `tracks` 要是**逗号分隔的字符串**，模块自己会 split 成数组再序列化。
   */
  async playlistTracksEdit(
    playlistId: number,
    trackIds: readonly number[],
    op: 'add' | 'del' = 'add',
  ): Promise<void> {
    if (trackIds.length === 0) return;
    const raw = asRecord(
      await this.call('/playlist/tracks', { op, pid: playlistId, tracks: trackIds.join(',') }),
    );
    const code = asNumber(raw?.['code']);
    if (code !== 200) {
      throw new NcmApiError(
        extractMessage(raw) ??
          (op === 'add' ? '加进歌单失败（可能是未登录或没有权限）' : '从歌单里删除失败'),
        '/playlist/tracks',
        code,
      );
    }
  }

  /** 每日推荐（需要登录；非登录态后端返回空数组或 301）。 */
  async recommendTracks(): Promise<Song[]> {
    const raw = asRecord(await this.call('/recommend/songs'));
    const data = asRecord(raw?.['data']);
    const songs = asArray(data?.['dailySongs']);
    const fallback = songs.length > 0 ? songs : asArray(raw?.['recommend']);
    return fallback.map(mapSong).filter(isPresent);
  }

  /**
   * 歌单内的歌曲。
   * 注意 `/playlist/track/all` 不返回总数，所以 `hasMore` 只能用
   * 「这一页是否装满」来推断——这是该接口的已知限制，UI 上表现为
   * 「最后一页可能多出一次点击」，可以接受。
   */
  async playlistTracks(playlistId: number, offset = 0, limit = 100): Promise<TrackPage> {
    const raw = asRecord(
      await this.call('/playlist/track/all', { id: playlistId, limit, offset }),
    );
    const songs = asArray(raw?.['songs']).map(mapSong).filter(isPresent);
    const detail = asRecord(raw?.['playlist']);
    const total = asNumber(detail?.['trackCount']);
    return {
      tracks: songs,
      ...(total !== undefined ? { total } : {}),
      hasMore: songs.length >= limit,
    };
  }

  /**
   * 私人雷达。
   *
   * 网易云的「私人雷达」在所有用户眼里都是**同一个歌单 id**，内容却按各自的
   * 历史口味实时生成（官方动态歌单）。所以这里不需要新接口：固定 id +
   * 我们已有的 `/playlist/detail` 与 `/playlist/track/all` 就够了，
   * 个性化由请求里带的 cookie 决定。id 值来自社区维护的动态歌单清单。
   */
  static RADAR_PLAYLIST_ID = 3136952023;

  /** 歌单元数据（名称/封面/简介/曲目数）。 */
  async playlistDetail(playlistId: number): Promise<Playlist | undefined> {
    const raw = asRecord(await this.call('/playlist/detail', { id: playlistId }));
    return mapPlaylist(raw?.['playlist']);
  }

  /** 推荐歌单（`/personalized`；未登录也能拿到，只是不个性化）。 */
  async personalizedPlaylists(limit = 12): Promise<Playlist[]> {
    const raw = asRecord(await this.call('/personalized', { limit }));
    return asArray(raw?.['result']).map(mapPlaylist).filter(isPresent);
  }

  /** 推荐新音乐（`/personalized/newsong`）；结果里外层是 `{ song }`。 */
  async personalizedNewSongs(limit = 10): Promise<Song[]> {
    const raw = asRecord(await this.call('/personalized/newsong', { limit }));
    return asArray(raw?.['result'])
      .map((item) => mapSong(asRecord(item)?.['song'] ?? item))
      .filter(isPresent);
  }

  /**
   * 歌手的热门歌曲（用户第九轮第 2 条：点播放页名片里的歌手名 → 歌手歌曲卡片）。
   *
   * 用老的 `/artist/songs`：它带 `order=hot` 与分页，返回 `{ songs, more }`。
   * `more` 缺失时按「这一页装满了」推断还有下一页（和 `playlistTracks` 一个套路）。
   */
  async artistSongs(artistId: number, offset = 0, limit = 50): Promise<TrackPage> {
    const raw = asRecord(
      await this.call('/artist/songs', { id: artistId, order: 'hot', limit, offset }),
    );
    const songs = asArray(raw?.['songs']).map(mapSong).filter(isPresent);
    const more = raw?.['more'];
    return {
      tracks: songs,
      // 歌手歌曲的总数接口不给（只有 `more` 这个布尔量），所以 total 缺省。
      hasMore: typeof more === 'boolean' ? more : songs.length >= limit,
    };
  }

  /**
   * 专辑曲目（用户第九轮第 2 条：点播放页名片里的专辑名 → 专辑歌曲卡片）。
   *
   * `/album` 一次就把整张专辑的曲目给全了，所以这里在本地切片：`album.size` 是总数，
   * 但曲目一律以 `songs` 的实际长度为准（有些专辑 `size` 含已下架曲目）。
   */
  async albumSongs(albumId: number, offset = 0, limit = 100): Promise<TrackPage> {
    const raw = asRecord(await this.call('/album', { id: albumId }));
    const all = asArray(raw?.['songs']).map(mapSong).filter(isPresent);
    const detail = asRecord(raw?.['album']);
    const declared = asNumber(detail?.['size']);
    const sliced = all.slice(offset, offset + limit);
    return {
      tracks: sliced,
      total: all.length > 0 ? all.length : (declared ?? 0),
      hasMore: offset + limit < all.length,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 防御式解析工具（后端字段随时可能变，缺字段不应该炸）
 * ------------------------------------------------------------------ */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function extractMessage(payload: unknown): string | undefined {
  const record = asRecord(payload);
  return asString(record?.['message']) ?? asString(record?.['msg']);
}

/**
 * `picUrl` 是裸图，加 `?param=` 让 CDN 直接给我们需要的尺寸，省流量也省内存。
 *
 * 必须把 `http://` 升级成 `https://`：网易云一部分老接口（例如 `/user/record`）
 * 返回的 `picUrl` 还是明文的 `http://p1.music.126.net/...`，而渲染进程的 CSP
 * 只放行了 `https://*.music.126.net`，明文地址会被 CSP 直接拦掉——表现就是
 * 「列表里所有歌都没有封面」，而 `status`/日志里什么都看不到。
 */
export function coverUrl(raw: string | undefined, size = 300): string | undefined {
  if (!raw) return undefined;
  const base = (raw.split('?')[0] ?? raw).replace(/^http:\/\//i, 'https://');
  return `${base}?param=${size}y${size}`;
}

export function mapSong(value: unknown): Song | undefined {
  const record = asRecord(value);
  const id = asNumber(record?.['id']);
  const name = asString(record?.['name']);
  if (id === undefined || name === undefined) return undefined;

  const artists = asArray(record?.['ar'])
    .map((item) => {
      const artist = asRecord(item);
      const artistId = asNumber(artist?.['id']);
      const artistName = asString(artist?.['name']);
      return artistId !== undefined && artistName ? { id: artistId, name: artistName } : undefined;
    })
    .filter(isPresent);

  const album = asRecord(record?.['al']);
  const albumId = asNumber(album?.['id']);
  const durationMs = asNumber(record?.['dt']);

  return {
    id,
    name,
    artists,
    ...(albumId !== undefined
      ? {
          album: {
            id: albumId,
            name: asString(album?.['name']) ?? '',
            ...(coverUrl(asString(album?.['picUrl'])) ? { coverUrl: coverUrl(asString(album?.['picUrl'])) } : {}),
          },
        }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    // fee=1 表示需要 VIP，fee=4 表示需要付费专辑；0/8 为免费可听。
    playable: (asNumber(record?.['fee']) ?? 0) !== 4,
  };
}

/**
 * 评论的防御式解析。
 *
 * 字段名和歌曲**不一样**，别照搬 `mapSong`：评论 id 在 `commentId`（只有老接口才叫
 * `id`），用户信息在 `user`，楼层回复在 `beReplied[].user.nickname`，IP 归属地在
 * `ipLocation`。缺 `commentId`/`content` 的条目直接丢掉——渲染进程拿到半条评论只会
 * 显示成一个空白气泡，比少一条更难看。
 */
export function mapComment(value: unknown): Comment | undefined {
  const record = asRecord(value);
  const id = asNumber(record?.['commentId']) ?? asNumber(record?.['id']);
  const content = asString(record?.['content']);
  if (id === undefined || content === undefined) return undefined;

  const user = asRecord(record?.['user']);
  const avatar = coverUrl(asString(user?.['avatarUrl']), 100);
  const beReplied = asArray(record?.['beReplied'])
    .map((item) => {
      const reply = asRecord(item);
      const replyUser = asRecord(reply?.['user']);
      const nickname = asString(replyUser?.['nickname']);
      const replyContent = asString(reply?.['content']);
      return nickname !== undefined && replyContent !== undefined
        ? { nickname, content: replyContent }
        : undefined;
    })
    .filter(isPresent);
  const location = asString(record?.['ipLocation']);

  return {
    id,
    content,
    time: asNumber(record?.['time']) ?? 0,
    likedCount: asNumber(record?.['likedCount']) ?? 0,
    user: {
      id: asNumber(user?.['userId']) ?? asNumber(user?.['id']) ?? 0,
      nickname: asString(user?.['nickname']) ?? '',
      ...(avatar ? { avatarUrl: avatar } : {}),
    },
    ...(beReplied.length > 0 ? { beReplied } : {}),
    ...(location ? { location } : {}),
  };
}

export function mapPlaylist(value: unknown): Playlist | undefined {
  const record = asRecord(value);
  const id = asNumber(record?.['id']);
  const name = asString(record?.['name']);
  if (id === undefined || name === undefined) return undefined;

  // `/user/playlist` 用 `coverImgUrl`，`/personalized` 用 `picUrl`，两个都认。
  const cover = coverUrl(asString(record?.['coverImgUrl']) ?? asString(record?.['picUrl']), 400);
  const creator = asRecord(record?.['creator']);
  const creatorName = asString(creator?.['nickname']);
  const specialType = asNumber(record?.['specialType']);
  const description = asString(record?.['description']);

  return {
    id,
    name,
    ...(cover ? { coverUrl: cover } : {}),
    trackCount: asNumber(record?.['trackCount']) ?? 0,
    ...(creatorName ? { creator: creatorName } : {}),
    ...(specialType !== undefined ? { specialType } : {}),
    ...(description ? { description } : {}),
    subscribed: record?.['subscribed'] === true,
  };
}

/* ------------------------------------------------------------------ *
 * LRC / YRC 解析
 * ------------------------------------------------------------------ */

/** 一个 LRC 时间标签：`[mm:ss]`、`[mm:ss.xxx]`、老格式 `[mm:ss:xxx]`。 */
const LRC_TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * 逐字歌词（yrc）的行首标记：`[开始毫秒,持续毫秒]`。
 *
 * 真实上游的 yrc 行首**不是** `[mm:ss.xxx]`（那是 lrc），而是毫秒对，例如
 * `[16210,3460](16210,670,0)还(16880,410,0)没`，所以单独认一种。
 */
const YRC_LINE_HEAD = /^\[(\d+),(\d+)\]/;

/** 整首歌共用的毫秒偏移：`[offset:±ms]`。 */
const LRC_OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i;

/** yrc 行内夹带的逐字标记：`<mm:ss.xxx>`（有的上游还会带时长，形如 `<mm:ss.xxx,mm:ss.xxx,0>`）。 */
const YRC_INLINE_TAG = /<[^>]*>/g;

/** yrc 行内夹带的逐字括号标记：`(开始,时长,未知)`。 */
const YRC_INLINE_GROUP = /\([^)]*\)/g;

/**
 * yrc 行内**逐字**时间戳：`(开始毫秒,时长毫秒,保留位)` 后面跟着「到下一个标记之前」的文本。
 *
 * 例：`(16210,670,0)还(16880,410,0)没` ⇒ 两个词，各带自己的起点与时长。
 * 第三个数字上游固定是 0，有的版本会省略，所以整组可选。
 */
const YRC_WORD_TAG = /\((\d+),(\d+)(?:,\d+)?\)([^(]*)/g;

/**
 * 从一行 yrc 里读出逐字时间戳。
 *
 * **只在逐字文本拼起来正好等于整行文本时才认**：上游偶尔会把 `<mm:ss.xxx>` 标记混在词之间、
 * 或在词外多留空格，那种行宁可整行作废（渲染层退回「按行时长均分」的近似），也不要让字和
 * 时间戳错位——错位的后果是「唱到第二个字时第三个字先亮」，比粗略均匀更难看。
 */
function parseYrcWords(rawLine: string, body: string, offsetMs: number): LyricWord[] | undefined {
  const words: LyricWord[] = [];
  for (const match of rawLine.matchAll(YRC_WORD_TAG)) {
    const text = match[3] ?? '';
    if (text === '') continue;
    words.push({
      timeMs: Number.parseInt(match[1] ?? '0', 10) + offsetMs,
      durationMs: Number.parseInt(match[2] ?? '0', 10),
      text,
    });
  }
  if (words.length === 0) return undefined;
  if (words.map((word) => word.text).join('') !== body) return undefined;
  return words;
}

/**
 * 解析 LRC / YRC 文本成逐行歌词。纯函数，可单测。
 *
 * 规则都是被上游的脏数据逼出来的，不是洁癖：
 * - 认 `[mm:ss.xxx]`、老格式 `[mm:ss:xxx]`、`[mm:ss]`；小数位数决定单位（见 `fractionToMs`）。
 *   一行挂多个时间标签时展开成多行（副歌复用同一句歌词就是这么写的）。
 * - 按 `timeMs` 升序排序；同一时间点的重复文本去重。
 * - 文本 trim 后为空的行丢弃——LRC 里大量占位空行，留着只会让界面出现空行。
 * - `[ti:..]`/`[ar:..]`/`[al:..]`/`[by:..]` 这类元数据行没有时间标签，天然被跳过；
 *   `[offset:..]` 单独读出来，当作整首歌的毫秒偏移加到每一个时间上。
 * - yrc：先剥掉行首的毫秒对与行内的 `<mm:ss.xxx>` / `(开始,时长,未知)` 标记，再取文本。
 * - `timeMs` 一律取整为整数毫秒。
 */
export function parseLrc(text: string): LyricLine[] {
  if (text === '') return [];
  const offsetTag = LRC_OFFSET_TAG.exec(text);
  const offsetMs = offsetTag ? Number.parseInt(offsetTag[1] ?? '0', 10) : 0;

  const parsed: LyricLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // `matchAll` 要求全局正则，且它内部会克隆正则，不会污染 `LRC_TIME_TAG` 的 lastIndex。
    const timeTags = [...rawLine.matchAll(LRC_TIME_TAG)];
    const yrcHead = timeTags.length === 0 ? YRC_LINE_HEAD.exec(rawLine) : null;
    // 既没有 `[mm:ss]` 也没有 yrc 行首 → 元数据行 / JSON 行 / 纯文本说明行，都不是歌词。
    if (timeTags.length === 0 && yrcHead === null) continue;
    const body = lyricText(rawLine);
    if (body === '') continue;
    if (timeTags.length > 0) {
      for (const tag of timeTags) {
        parsed.push({
          timeMs: tagToMs(tag[1] ?? '0', tag[2] ?? '0', tag[3], offsetMs),
          text: body,
        });
      }
    } else if (yrcHead) {
      // yrc 行首给的就是毫秒，不需要再按 `mm:ss` 换算。
      const timeMs = Number.parseInt(yrcHead[1] ?? '0', 10) + offsetMs;
      // 第十一轮第 1 条（用户 m03279「有和声的地方歌词进度不对」）：行首第二个数字是
      // **这一行真实唱多久**，行内的 `(...)` 是**逐字**时间戳。两者以前都被丢掉，
      // 行时长只能按「下一行的时间戳」推，和声行（与主唱同一时间戳 / 时间重叠）因此算成 0。
      const durationMs = Number.parseInt(yrcHead[2] ?? '0', 10);
      const words = parseYrcWords(rawLine, body, offsetMs);
      parsed.push({
        timeMs,
        text: body,
        ...(durationMs > 0 ? { durationMs } : {}),
        ...(words === undefined ? {} : { words }),
      });
    }
  }

  parsed.sort((a, b) => a.timeMs - b.timeMs);
  // 去重放在排序之后：同一时间点的重复文本只留一条（多标签展开最容易造出重复）。
  const seen = new Map<number, Set<string>>();
  return parsed.filter((line) => {
    const texts = seen.get(line.timeMs) ?? new Set<string>();
    if (texts.has(line.text)) return false;
    texts.add(line.text);
    seen.set(line.timeMs, texts);
    return true;
  });
}

/** 剥掉时间标签与 yrc 的逐字标记后取文本；剥完只剩空白就说明这行没有歌词内容。 */
function lyricText(rawLine: string): string {
  return rawLine
    .replace(LRC_TIME_TAG, '')
    .replace(YRC_LINE_HEAD, '')
    .replace(YRC_INLINE_TAG, '')
    .replace(YRC_INLINE_GROUP, '')
    .trim();
}

/** `[mm:ss...]` → 整数毫秒（含整首歌的 offset）。 */
function tagToMs(
  minutes: string,
  seconds: string,
  fraction: string | undefined,
  offsetMs: number,
): number {
  return (
    Number.parseInt(minutes, 10) * 60_000 +
    Number.parseInt(seconds, 10) * 1_000 +
    fractionToMs(fraction) +
    offsetMs
  );
}

/** 小数部分按位数决定单位：`.xxx` 毫秒、`.xx` 厘秒、`.x` 分秒（LRC 的老约定）。 */
function fractionToMs(fraction: string | undefined): number {
  if (fraction === undefined || fraction === '') return 0;
  return Number.parseInt(fraction.padEnd(3, '0').slice(0, 3), 10);
}
