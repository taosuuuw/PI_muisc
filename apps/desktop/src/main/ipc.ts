import { app, ipcMain } from 'electron';
import {
  CH,
  EVT,
  INPUT_SCHEMAS,
  OUTPUT_SCHEMAS,
  type CommentsRequest,
  type DownloadTask,
  type LikeCheckRequest,
  type LikeRequest,
  type LikeState,
  type LocalLibraryList,
  type LyricRequest,
  type RouteMap,
  type SearchRequest,
} from '@pi/ipc';
import {
  type AccountCapability,
  type CommentPage,
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

export function registerIpc(services: Services, getWindow: () => Electron.BrowserWindow | null): void {
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
  }));

  register<void, AccountCapability>(CH.accountCapability, () => services.getCapability());

  register<void, Settings>(CH.settingsGet, () => services.getSettings());

  register<Partial<Settings>, Settings>(CH.settingsPatch, (patch) =>
    services.patchSettings(patch ?? {}),
  );

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

  // 看歌词同样不需要登录（和看评论一致）；`hasLyric: false` 是正常结果，不是错误。
  register<LyricRequest, Lyric>(CH.ncmLyric, async (payload) => {
    await requireNcm();
    return services.songLyric(payload.songId);
  });

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
}
