import { app, dialog, ipcMain, nativeImage } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BACKGROUND_IMAGE_EXTENSIONS,
  BACKGROUND_IMAGE_MAX_BYTES,
  CH,
  EVT,
  INPUT_SCHEMAS,
  OUTPUT_SCHEMAS,
  type BackgroundCommitRequest,
  type BackgroundPickResult,
  type BackgroundReadResult,
  type CacheClearRequest,
  type CommentLikeRequest,
  type CommentPostRequest,
  type CommentsRequest,
  type DownloadTask,
  type LikeCheckRequest,
  type LikeRequest,
  type LikeState,
  type LocalLibraryList,
  type LyricImportRequest,
  type LyricRemoveRequest,
  type LyricRequest,
  type MediaStateReport,
  /*
   * `RuntimeInfo` 保持从 `@pi/shared` 引（类型定义在那边）。
   * ⚠️ 别把它挪去 `@pi/ipc`：那条测试按**文本**抓「相对路径 + .js」的 import，
   * `@pi/ipc` 会被它规范化成 `./ipc.js` 而报出一个假自环（真踩过）。
   */
  type RouteMap,
  type SearchRequest,
} from '@pi/ipc';
import {
  type AccountCapability,
  type AutomixResources,
  type CacheClearResult,
  type CommentLikeResult,
  type CommentPage,
  type CommentPostResult,
  type DataStorageInfo,
  type Lyric,
  type PlayedTrack,
  type Playlist,
  type QrLoginState,
  type QrLoginTicket,
  type Quality,
  type RuntimeInfo,
  type SearchResult,
  type Settings,
  type Song,
  type TrackPage,
} from '@pi/shared';
import { NcmClient } from '@pi/ncm-client';
import type { Services } from './services.js';

/** 私人雷达一次取多少首。雷达内容每天变，30 首足够撑起一个区块。 */
const RADAR_TRACK_LIMIT = 30;

const DEV = Boolean(process.env.PI_DEV);
/**
 * `PI_IPC_LOG=1` 时逐条打印通道调用。
 *
 * 这是「渲染进程 ↔ 主进程确实通了」的直接证据：光看截图分辨不出
 * 「preload 桥断了」和「后端没数据」——两者都是空白界面（这个坑真踩过）。
 */
const IPC_LOG = process.env.PI_IPC_LOG === '1';

/** 扩展名 → MIME：只用于把字节包成 `data:` 地址；认不出的按 png 兜底（浏览器按内容嗅探）。 */
const BACKGROUND_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

/** 自定义背景的落盘目录（`userData/player-background/`，与设置、缓存同一个域）。 */
function backgroundDir(): string {
  return path.join(app.getPath('userData'), 'player-background');
}

/**
 * `bootstrap.json` 里记着的 GPU 崩溃累计次数（用户第五轮第 17 条）。
 *
 * 为什么在这里自己读一遍而不是从 `index.ts` 引 `readFlags()`：`index.ts` 会
 * `registerIpc` 从这里引 `./ipc.js`，反过来引就成环了 —— 而
 * `tests/main-module-graph.test.ts` 明确禁止主进程出现循环 import（第五轮那次
 * 启动崩溃就是环形 import 造成的，`Object.values(undefined)`）。
 * 那条测试是**按文本抓**相对 import 的，所以这段注释里也不要写出
 * 「from 加引号加 ./ipc.js」那种字面量 —— 它会把注释当成一条 import，报一个假的自环。
 *
 * 这里读的是**原始计数**（不做过期判定）：设置页只是把它显示给用户看，
 * 「过期了就重来」那套逻辑归 `index.ts` 的 `readFlags()` 单点负责。
 */
function readGpuCrashes(): number {
  try {
    const raw = readFileSync(path.join(app.getPath('userData'), 'bootstrap.json'), 'utf8');
    const parsed = JSON.parse(raw) as { gpuCrashes?: unknown };
    return typeof parsed.gpuCrashes === 'number' ? parsed.gpuCrashes : 0;
  } catch {
    return 0;
  }
}

/**
 * 统一的通道注册器。
 *
 * 双向校验：入参在 preload 与这里各校验一次，出参在开发期校验一次。
 * 目的不是安全（渲染进程已被沙箱隔离），而是**让契约漂移在开发期就报错**。
 */
function register<P, R>(channel: string, handler: (payload: P) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_event, raw: unknown) => {
    const inputSchema = INPUT_SCHEMAS[channel];
    const payload = inputSchema ? inputSchema.parse(raw ?? {}) : undefined;
    if (IPC_LOG) console.info('[pi/ipc] →', channel);
    try {
      const output = await handler(payload as P);
      const outputSchema = OUTPUT_SCHEMAS[channel];
      if (DEV && outputSchema) outputSchema.parse(output);
      return output;
    } catch (error) {
      if (DEV || IPC_LOG) console.error('[pi/ipc] ✗', channel, error);
      throw error;
    }
  });
}

/**
 * 注册全部 IPC 通道。
 *
 * `onSettingsPatched`（本轮第 4 条加）：设置写成功后回调一次，让主进程把需要**同步**读到的
 * 设置同步进缓存 —— 目前只有「关闭窗口时退到后台还是直接退出」（窗口的 `close` 事件是同步的，
 * 在里面 await 读设置来不及）。不传就不回调，冒烟里的独立调用点因此一个都不用改。
 *
 * `onMediaState`（主人本轮第 3 条加）：渲染层回报播放状态，主进程据此重挂任务栏缩略图工具栏
 * 中间那枚键（播放/暂停字形、没有在听的歌时三枚一起置灰）。同样可选，不传就当没接。
 */
export function registerIpc(
  services: Services,
  getWindow: () => Electron.BrowserWindow | null,
  onSettingsPatched?: (next: Settings) => void,
  onMediaState?: (status: MediaStateReport['status']) => void,
): void {
  /** 需要联网的通道统一先等内嵌服务就绪，失败时给一句人能看懂的话。 */
  const requireNcm = async (): Promise<void> => {
    const ready = await services.ensureNcmReady();
    if (!ready) {
      throw new Error('内嵌网易云 API 未就绪，请稍后重试。可在日志中查看 [pi/ncm] 的输出。');
    }
  };

  // 登录态变化 → 主动推给渲染进程（渲染进程不必轮询）。
  services.onAccountChanged((capability) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(EVT.accountChanged, capability);
  });

  register<void, RuntimeInfo>(CH.appInfo, () => ({
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome ?? 'unknown',
    userDataDir: app.getPath('userData'),
    safeStorage: services.getSafeStorageStatus(),
    softwareRendering: Boolean(process.env.PI_SOFTWARE_RENDERING),
    gpuCrashes: readGpuCrashes(),
  }));

  register<void, AccountCapability>(CH.accountCapability, () => services.getCapability());

  register<void, Settings>(CH.settingsGet, () => services.getSettings());

  // P3：Beat This! 的模型 / WASM 地址（走本地代理）；缺文件时 available=false，渲染层退回 DSP。
  register<void, AutomixResources>(CH.automixResources, () => services.automixResources());

  register<Partial<Settings>, Settings>(CH.settingsPatch, async (patch) => {
    const next = await services.patchSettings(patch ?? {});
    // 主进程侧需要同步读到的设置（关窗行为）在这里同步过去，见 `registerIpc` 的注释。
    onSettingsPatched?.(next);
    return next;
  });

  register<void, RouteMap[typeof CH.ncmHealth]['output']>(CH.ncmHealth, () => {
    const state = services.getNcmState();
    return {
      status: state.status,
      ...(state.port !== undefined ? { port: state.port } : {}),
      ...(state.error !== undefined ? { error: state.error } : {}),
    };
  });

  register<SearchRequest, SearchResult>(CH.ncmSearch, async (payload) => {
    await requireNcm();
    return services.ncm.search(payload.keywords, payload.limit);
  });

  /* ---------------- 评论与「喜欢」 ---------------- */

  // 看评论不需要登录（和网易云自己的行为一致）；下面两条「喜欢」相关的一定要登录。
  register<CommentsRequest, CommentPage>(CH.ncmComments, async (payload) => {
    await requireNcm();
    return services.songComments(payload.songId, payload.offset ?? 0, payload.limit ?? 20);
  });

  /*
   * 评论的写操作（用户第五轮第 8 条：点赞 / 打字评论 / 回复评论）。
   *
   * 三条都要登录 —— `Services` 会在发请求**之前**先 `requireUserId()`，
   * 于是界面拿到的是「请先登录」这句人话，而不是网易云的 301/250 状态码。
   */
  register<CommentPostRequest, CommentPostResult>(CH.ncmCommentPost, async (payload) => {
    await requireNcm();
    return services.postComment({
      songId: payload.songId,
      content: payload.content,
      ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
    });
  });

  register<CommentLikeRequest, CommentLikeResult>(CH.ncmCommentLike, async (payload) => {
    await requireNcm();
    return services.likeComment({
      songId: payload.songId,
      commentId: payload.commentId,
      like: payload.like,
      ...(payload.likedCount === undefined ? {} : { likedCount: payload.likedCount }),
    });
  });

  /*
   * 看歌词同样不需要登录（和看评论一致）；`hasLyric: false` 是正常结果，不是错误。
   *
   * 第五轮第 3 条起这条通道是**多源**的：入参带上了歌名 / 歌手 / 时长，
   * 好让 QQ 与酷狗能按「歌名 + 歌手 + 时长」去找同一首歌（它们没有网易云的 id）。
   */
  register<LyricRequest, Lyric>(CH.ncmLyric, async (payload) => {
    await requireNcm();
    return services.songLyric({
      songId: payload.songId,
      title: payload.title ?? '',
      artists: payload.artists ?? [],
      ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
    });
  });

  /* ---------------- 歌词：导入 / 删除 / 清单（第五轮第 3 条） ---------------- */

  register<void, { songIds: number[] }>(CH.lyricsImports, async () => ({
    songIds: await services.listLyricImports(),
  }));

  register<LyricImportRequest, { songIds: number[] }>(CH.lyricsImport, async (payload) => ({
    songIds: await services.importLyric({
      songId: payload.songId,
      fileName: payload.fileName,
      content: payload.content,
      base64: payload.base64 ?? false,
    }),
  }));

  register<LyricRemoveRequest, { songIds: number[] }>(CH.lyricsRemove, async (payload) => ({
    songIds: await services.removeLyric(payload.songId),
  }));

  /* ---------------- 本地数据存储与缓存（第五轮第 2 条） ---------------- */

  register<void, DataStorageInfo>(CH.dataStorage, () => services.data.info());

  register<CacheClearRequest, CacheClearResult>(CH.dataClearCache, (payload) =>
    services.data.clear(payload?.only),
  );

  register<LikeRequest, LikeState>(CH.ncmLike, async (payload) => {
    await requireNcm();
    return services.setSongLiked(payload.songId, payload.like);
  });

  register<LikeCheckRequest, LikeState>(CH.ncmLikeCheck, async (payload) => {
    await requireNcm();
    return services.checkSongsLiked(payload.songIds);
  });

  /* ---------------- 登录 ---------------- */

  register<void, QrLoginTicket>(CH.authQrKey, () => services.createQrTicket());

  register<{ key: string }, QrLoginState>(CH.authQrCheck, (payload) => services.checkQr(payload.key));

  register<void, AccountCapability>(CH.authLogout, () => services.logout());

  /* ---------------- 曲库 ---------------- */

  register<{ offset?: number; limit?: number }, { tracks: PlayedTrack[] }>(
    CH.libraryRecent,
    async (payload) => {
      const uid = await services.requireUserId();
      await requireNcm();
      // 最近听过固定取「最近一周」（type=1）：type=0 的「全部历史」动辄上千条，
      // 首屏拉回来只会拖慢渲染，等 M3 做了虚拟列表再说。
      return { tracks: await services.ncm.recentTracks(uid, payload.limit ?? 100, 1) };
    },
  );

  register<{ offset?: number; limit?: number }, TrackPage>(CH.libraryLiked, async (payload) => {
    const uid = await services.requireUserId();
    await requireNcm();
    return services.ncm.likedTracks(uid, payload.offset ?? 0, payload.limit ?? 100);
  });

  register<void, { playlists: Playlist[] }>(CH.libraryMyPlaylists, async () => {
    const uid = await services.requireUserId();
    await requireNcm();
    return { playlists: await services.ncm.myPlaylists(uid) };
  });

  register<void, { tracks: Song[] }>(CH.libraryRecommend, async () => {
    await services.requireUserId();
    await requireNcm();
    return { tracks: await services.ncm.recommendTracks() };
  });

  register<{ playlistId: number; offset?: number; limit?: number }, TrackPage>(
    CH.libraryPlaylistTracks,
    async (payload) => {
      await services.requireUserId();
      await requireNcm();
      return services.ncm.playlistTracks(payload.playlistId, payload.offset ?? 0, payload.limit ?? 100);
    },
  );

  register<{ limit?: number }, { playlists: Playlist[] }>(
    CH.libraryPersonalized,
    async (payload) => {
      await requireNcm();
      return { playlists: await services.ncm.personalizedPlaylists(payload.limit ?? 12) };
    },
  );

  /**
   * 歌手的歌曲 / 专辑的曲目（用户第九轮第 2 条：点播放页名片里的歌手名、专辑名）。
   *
   * 都不要求登录：这两条是公开数据，未登录也能看（和推荐歌单同一个道理）。
   */
  register<{ id: number; offset?: number; limit?: number }, TrackPage>(
    CH.libraryArtistSongs,
    async (payload) => {
      await requireNcm();
      return services.ncm.artistSongs(payload.id, payload.offset ?? 0, payload.limit ?? 50);
    },
  );

  register<{ id: number; offset?: number; limit?: number }, TrackPage>(
    CH.libraryAlbumSongs,
    async (payload) => {
      await requireNcm();
      return services.ncm.albumSongs(payload.id, payload.offset ?? 0, payload.limit ?? 100);
    },
  );

  register<void, { playlist: Playlist | null; tracks: Song[] }>(CH.libraryRadar, async () => {
    await requireNcm();
    const id = NcmClient.RADAR_PLAYLIST_ID;
    // 歌单元数据拿不到也要能看歌：雷达的价值在歌曲，不在歌单名字。
    const [detail, page] = await Promise.all([
      services.ncm.playlistDetail(id).catch(() => undefined),
      services.ncm.playlistTracks(id, 0, RADAR_TRACK_LIMIT),
    ]);
    return { playlist: detail ?? null, tracks: page.tracks };
  });

  register<{ limit?: number }, { tracks: Song[] }>(CH.libraryNewSongs, async (payload) => {
    await requireNcm();
    return { tracks: await services.ncm.personalizedNewSongs(payload.limit ?? 10) };
  });

  /**
   * 新建歌单（用户 m06982 第 1 条：空白卡片点一下就能命名）。
   *
   * 只把上游给的 id 回给渲染进程；歌单的元数据（名字/封面/曲目数）由渲染进程
   * 用 id 走 `library:playlist-tracks` 自己取 —— 少一条「创建时顺手拼一个
   * Playlist 对象」的路，就不会出现「界面上的名字和云端不一致」。
   */
  register<{ name: string }, { playlistId: number }>(CH.libraryPlaylistCreate, async (payload) => {
    await services.requireUserId();
    await requireNcm();
    const created = await services.ncm.createPlaylist(payload.name);
    return { playlistId: created.id };
  });

  /** 加歌 / 删歌。成功没有返回值，失败了抛错让界面显示原因。 */
  register<{ playlistId: number; trackIds: number[]; op?: 'add' | 'del' }, void>(
    CH.libraryPlaylistEditTracks,
    async (payload) => {
      await services.requireUserId();
      await requireNcm();
      await services.ncm.playlistTracksEdit(payload.playlistId, payload.trackIds, payload.op ?? 'add');
    },
  );

  /* ---------------- 播放 ---------------- */

  register<{ song: Song; level?: Quality }, RouteMap[typeof CH.playerResolve]['output']>(
    CH.playerResolve,
    async (payload) => {
      const ready = await services.ensureNcmReady();
      if (!ready) {
        // 官方 API 没起来也不必直接放弃：责任链里还有第三方源（用户开了的话）。
        // 但一个源都没有时，早点说人话比让它链式失败更好。
        if (!(await services.hasEnabledThirdPartySource())) {
          throw new Error('内嵌网易云 API 未就绪，请稍后重试。可在日志中查看 [pi/ncm] 的输出。');
        }
        console.warn('[pi/player] 内嵌网易云 API 未就绪，本次解析将只走第三方音源');
      }
      return services.resolveForPlayback(payload.song, payload.level);
    },
  );

  /* ---------------- 下载与本地库（M5） ---------------- */

  /**
   * 下载队列的任何变化都主动推给渲染进程。
   *
   * 节流在管理器内部（约 4 次/秒）：进度条要顺滑，但没必要为每一个 16KB 数据块发一次 IPC。
   * 状态跃迁（排队→下载中→完成/失败/暂停）不走节流，会立刻推。
   */
  services.downloads.onChange((tasks) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(EVT.downloadsChanged, tasks);
  });

  register<void, DownloadTask[]>(CH.downloadsList, () => services.downloads.list());

  register<{ song: Song; level?: Quality }, DownloadTask[]>(CH.downloadsAdd, (payload) =>
    services.downloads.add(payload.song, payload.level),
  );

  register<{ id: string }, DownloadTask[]>(CH.downloadsPause, (payload) =>
    services.downloads.pause(payload.id),
  );

  register<{ id: string }, DownloadTask[]>(CH.downloadsResume, (payload) =>
    services.downloads.resume(payload.id),
  );

  register<{ id: string }, DownloadTask[]>(CH.downloadsRetry, (payload) =>
    services.downloads.retry(payload.id),
  );

  register<{ id: string; deleteFile?: boolean }, DownloadTask[]>(CH.downloadsRemove, (payload) =>
    services.downloads.remove(payload.id, payload.deleteFile ?? false),
  );

  /**
   * 本地库清单：只读、无入参。每次调用都重扫一遍设置的目录
   * （用户往文件夹里丢歌、或把目录删掉，刷新页面就该看到真状态）。
   */
  register<void, LocalLibraryList>(CH.libraryList, () => services.libraryList());

  /* ---------------- 音源 ---------------- */

  register<void, RouteMap[typeof CH.sourcesList]['output']>(CH.sourcesList, async () => ({
    sources: await services.listSources(),
  }));

  register<
    RouteMap[typeof CH.sourcesResetHealth]['input'],
    RouteMap[typeof CH.sourcesResetHealth]['output']
  >(CH.sourcesResetHealth, async (payload) => ({
    sources: await services.resetSourceHealth(payload?.sourceId),
  }));

  /* ---------------- 自定义源插件（L3）与音质日志 ---------------- */

  register<void, RouteMap[typeof CH.sourcesPlugins]['output']>(CH.sourcesPlugins, async () => ({
    plugins: await services.listPlugins(),
  }));

  register<
    RouteMap[typeof CH.sourcesImportPlugin]['input'],
    RouteMap[typeof CH.sourcesImportPlugin]['output']
  >(CH.sourcesImportPlugin, async (payload) => ({
    // 导入会真的在沙箱里跑一次；失败（语法错误/没有可用平台）会把原因抛回界面。
    plugins: await services.importPlugin(payload.script, payload.name),
  }));

  register<
    RouteMap[typeof CH.sourcesTogglePlugin]['input'],
    RouteMap[typeof CH.sourcesTogglePlugin]['output']
  >(CH.sourcesTogglePlugin, async (payload) => ({
    plugins: await services.setPluginEnabled(payload.id, payload.enabled),
  }));

  register<
    RouteMap[typeof CH.sourcesRemovePlugin]['input'],
    RouteMap[typeof CH.sourcesRemovePlugin]['output']
  >(CH.sourcesRemovePlugin, async (payload) => ({
    plugins: await services.removePlugin(payload.id),
  }));

  register<void, RouteMap[typeof CH.sourcesQualityLog]['output']>(CH.sourcesQualityLog, async () => ({
    entries: await services.qualityLogEntries(),
  }));

  register<void, void>(CH.windowMinimize, () => {
    getWindow()?.minimize();
  });
  register<void, void>(CH.windowToggleMaximize, () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  register<void, void>(CH.windowClose, () => {
    getWindow()?.close();
  });

  /* ---------------- 任务栏缩略图工具栏（主人本轮第 3 条） ---------------- */

  /*
   * 渲染层 → 主进程：**播放状态变了**。
   *
   * 只回报三态（playing / paused / idle），主进程拿它做两件事：中间那枚键画播放还是暂停、
   * 没有在听的歌时把三枚键一起置灰。状态本来该由渲染层说了算 —— 它才是持有 `<audio>`
   * 与队列状态机的那一侧（解析失败自动跳下一首这种事，主进程推算不出来）。
   */
  register<MediaStateReport, void>(CH.mediaState, (payload) => {
    onMediaState?.(payload?.status ?? 'idle');
  });

  /* ---------------- 播放页自定义背景（主人本轮第 1 条） ---------------- */

  /*
   * 四件事：挑（系统对话框）→ 存（写进 userData 的副本）→ 取（启动时读回来）→ 清。
   *
   * 为什么存副本而不是记用户的文件路径：用户的图可能在 U 盘/临时目录/会被挪走的相册里，
   * 记路径就等于埋一个「过几天背景消失了」的坑。副本放 `userData/player-background/`，
   * 与设置、缓存同域，跟着这个安装走。
   *
   * 为什么只留一张：设置里那一项本来就只有一个（`settings.playerBackground`），
   * 存两张会让「哪张在用」和磁盘占用都变得需要解释。换图时先清目录再写。
   */
  register<void, BackgroundPickResult>(CH.backgroundPick, async () => {
    const win = getWindow();
    const options: Electron.OpenDialogOptions = {
      title: '选一张播放页背景图',
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: [...BACKGROUND_IMAGE_EXTENSIONS] },
        { name: '所有文件', extensions: ['*'] },
      ],
    };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const filePath = picked.filePaths[0];
    if (picked.canceled || filePath === undefined) return { canceled: true };

    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!(BACKGROUND_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
      return {
        canceled: false,
        message: `认不出「.${ext}」这种格式。可以用：${BACKGROUND_IMAGE_EXTENSIONS.join(' / ')}。`,
      };
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch (error) {
      return { canceled: false, message: `这张图读不出来：${(error as Error).message}` };
    }
    if (bytes.length > BACKGROUND_IMAGE_MAX_BYTES) {
      return {
        canceled: false,
        message: `图太大了（${(bytes.length / 1024 / 1024).toFixed(1)}MB，上限 ${BACKGROUND_IMAGE_MAX_BYTES / 1024 / 1024}MB）。`,
      };
    }
    const size = nativeImage.createFromBuffer(bytes).getSize();
    return {
      canceled: false,
      name: path.basename(filePath),
      ext,
      dataUrl: `data:${BACKGROUND_MIME[ext] ?? 'image/png'};base64,${bytes.toString('base64')}`,
      ...(size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : {}),
    };
  });

  register<BackgroundCommitRequest, { id: string }>(CH.backgroundCommit, (payload) => {
    const ext = payload.ext.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ext === '') throw new Error('背景图的扩展名不合法。');
    const matched = /^data:[^;,]+;base64,([\s\S]+)$/.exec(payload.dataUrl);
    if (matched === null) throw new Error('背景图数据不是 data:base64 形式。');
    const bytes = Buffer.from(matched[1] ?? '', 'base64');
    if (bytes.length === 0) throw new Error('背景图是空的。');
    if (bytes.length > BACKGROUND_IMAGE_MAX_BYTES) {
      throw new Error(`背景图太大（上限 ${BACKGROUND_IMAGE_MAX_BYTES / 1024 / 1024}MB）。`);
    }
    const dir = backgroundDir();
    mkdirSync(dir, { recursive: true });
    for (const entry of readdirSync(dir)) {
      try {
        rmSync(path.join(dir, entry), { force: true });
      } catch {
        /* 删不掉旧的就留着，反正新的一张马上写下去，取的时候按设置里的文件名找。 */
      }
    }
    const id = `bg-${Date.now().toString(36)}.${ext}`;
    writeFileSync(path.join(dir, id), bytes);
    console.info(`[pi/background] 已存下播放页背景：${id}（${(bytes.length / 1024).toFixed(0)}KB）`);
    return { id };
  });

  register<{ id: string }, BackgroundReadResult>(CH.backgroundRead, (payload) => {
    // `basename` 是防目录穿越那道闸：id 来自渲染层，不能直接拼进路径。
    const file = path.join(backgroundDir(), path.basename(payload.id));
    if (!existsSync(file)) return { dataUrl: null, missing: true };
    const ext = path.extname(file).slice(1).toLowerCase();
    return {
      dataUrl: `data:${BACKGROUND_MIME[ext] ?? 'image/png'};base64,${readFileSync(file).toString('base64')}`,
      missing: false,
    };
  });

  register<void, { cleared: boolean }>(CH.backgroundClear, () => {
    const dir = backgroundDir();
    if (!existsSync(dir)) return { cleared: false };
    let cleared = false;
    for (const entry of readdirSync(dir)) {
      try {
        rmSync(path.join(dir, entry), { force: true });
        cleared = true;
      } catch {
        /* 忽略：下一张写进来时会再清一遍。 */
      }
    }
    return { cleared };
  });
}
