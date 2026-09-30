import { useEffect } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Quality, Settings, Song } from '@pi/shared';
import { CH, EVT, invoke, subscribeEvent } from '../bridge';

/**
 * 数据访问层：把 IPC 通道包装成 React Query 的查询。
 *
 * 为什么全部走 React Query 而不是自己写 useState + useEffect：
 * 缓存、去重、加载态、失败重试、窗口切换后的复用全都是白拿的，
 * 而且「登录态变了要重新拉数据」只需要 invalidateQueries。
 */

/** 当前账号能力（是否登录、昵称头像、VIP、音质上限）。 */
export function useAccount() {
  const queryClient = useQueryClient();

  // 主进程在登录成功后主动推送，渲染进程不需要轮询。
  useEffect(
    () =>
      subscribeEvent(EVT.accountChanged, (capability) => {
        queryClient.setQueryData(['capability'], capability);
        void queryClient.invalidateQueries({ queryKey: ['library'] });
      }),
    [queryClient],
  );

  return useQuery({
    queryKey: ['capability'],
    queryFn: () => invoke(CH.accountCapability),
    // 账号信息变化不频繁，且登录成功会推送；30 秒内不重复问。
    staleTime: 30_000,
  });
}

/** 退出登录。 */
export function useLogout(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void invoke(CH.authLogout).then(() => queryClient.invalidateQueries());
  };
}

/** 最近听过（最近一周）。 */
export function useRecentTracks(enabled: boolean, limit = 100) {
  return useQuery({
    queryKey: ['library', 'recent', limit],
    queryFn: () => invoke(CH.libraryRecent, { offset: 0, limit }),
    enabled,
  });
}

/** 我喜欢的音乐。 */
export function useLikedTracks(enabled: boolean, limit = 100) {
  return useQuery({
    queryKey: ['library', 'liked', limit],
    queryFn: () => invoke(CH.libraryLiked, { offset: 0, limit }),
    enabled,
  });
}

/**
 * 我喜欢的音乐（可翻页）。
 *
 * 第十六轮第 4 条(c)：用户要求拼贴视图里「可以一直拖拽看其他歌曲的拼贴，直到没有歌曲可以加载」。
 * 一次 `limit` 最多 200（`PagedRequestSchema` 的上限，见 `packages/ipc/src/index.ts:246-249`），
 * 所以「一直拖」必须靠 offset 翻页，而不是把 limit 一路调大。
 *
 * 和 `useLikedTracks` 并存：那个是「一次拿一屏」的老接口（别处还在用），这个是拼贴墙专用的
 * 无限列表。offset 用**已拿到的曲目数**推进（不是页数 × limit），这样最后一页不满时也不会
 * 跳号漏歌。
 */
export function useLikedTracksPaged(enabled: boolean, limit = 100) {
  return useInfiniteQuery({
    queryKey: ['library', 'liked', 'paged', limit],
    queryFn: ({ pageParam }) => invoke(CH.libraryLiked, { offset: pageParam, limit }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore
        ? allPages.reduce((count, page) => count + page.tracks.length, 0)
        : undefined,
    enabled,
  });
}

/** 我的歌单（含收藏来的）。 */
export function useMyPlaylists(enabled: boolean) {
  return useQuery({
    queryKey: ['library', 'playlists'],
    queryFn: () => invoke(CH.libraryMyPlaylists),
    enabled,
  });
}

/**
 * 新建歌单（用户 m06982 第 1 条：空白卡片点一下命名就建）。
 *
 * 成功后只让歌单列表失效：新歌单的封面/曲目数由列表接口下一次请求给出，
 * 不在本地拼一个可能与云端不一致的对象。
 */
export function useCreatePlaylist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => invoke(CH.libraryPlaylistCreate, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['library', 'playlists'] });
    },
  });
}

/** 往歌单里加歌 / 从歌单里删歌。改完让这个歌单的曲目页与歌单列表都失效。 */
export function useEditPlaylistTracks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { playlistId: number; trackIds: number[]; op?: 'add' | 'del' }) =>
      invoke(CH.libraryPlaylistEditTracks, args),
    onSuccess: (_result, args) => {
      void queryClient.invalidateQueries({ queryKey: ['library', 'playlist', args.playlistId] });
      void queryClient.invalidateQueries({ queryKey: ['library', 'playlists'] });
    },
  });
}

/** 每日推荐。 */
export function useRecommend(enabled: boolean) {
  return useQuery({
    queryKey: ['library', 'recommend'],
    queryFn: () => invoke(CH.libraryRecommend),
    enabled,
  });
}

/** 推荐歌单（`/personalized`）。 */
export function usePersonalizedPlaylists(enabled: boolean, limit = 12) {
  return useQuery({
    queryKey: ['library', 'personalized', limit],
    queryFn: () => invoke(CH.libraryPersonalized, { limit }),
    enabled,
  });
}

/**
 * 私人雷达。
 *
 * 它和「每日推荐」不是一回事：每日推荐每天零点换一批固定歌曲，
 * 私人雷达是**同一个歌单 id、内容按你的历史实时生成**，所以不设 staleTime 之外的缓存。
 */
export function useRadar(enabled: boolean) {
  return useQuery({
    queryKey: ['library', 'radar'],
    queryFn: () => invoke(CH.libraryRadar),
    enabled,
  });
}

/** 推荐新音乐（`/personalized/newsong`）。 */
export function useNewSongs(enabled: boolean, limit = 10) {
  return useQuery({
    queryKey: ['library', 'new-songs', limit],
    queryFn: () => invoke(CH.libraryNewSongs, { limit }),
    enabled,
  });
}

/**
 * 歌手的歌曲（用户第九轮第 2 条：点播放页名片里的歌手名）。
 *
 * `enabled` 由调用方给（浮层没开就不发请求），另外 `id <= 0` 一律不发：
 * 上游没有 id 时拿名字去搜是另一条路（搜索页），不该在这里偷偷发请求。
 */
export function useArtistSongs(id: number, enabled: boolean, limit = 50) {
  return useQuery({
    queryKey: ['library', 'artist-songs', id, limit],
    queryFn: () => invoke(CH.libraryArtistSongs, { id, limit }),
    enabled: enabled && id > 0,
  });
}

/** 专辑的曲目（用户第九轮第 2 条：点播放页名片里的专辑名）。 */
export function useAlbumSongs(id: number, enabled: boolean, limit = 100) {
  return useQuery({
    queryKey: ['library', 'album-songs', id, limit],
    queryFn: () => invoke(CH.libraryAlbumSongs, { id, limit }),
    enabled: enabled && id > 0,
  });
}

/* ------------------------------------------------------------------ *
 * 设置与音源
 * ------------------------------------------------------------------ */

/** 应用设置。多处读同一份缓存，所以 key 是固定的 `['settings']`。 */
export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => invoke(CH.settingsGet),
    staleTime: 30_000,
  });
}

/**
 * 改设置。
 *
 * 主进程返回**改完之后的完整设置**，所以直接写进缓存即可，不必再拉一次；
 * 同时让音源列表失效——音源是否入链取决于设置。
 */
export function usePatchSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => invoke(CH.settingsPatch, patch),
    onSuccess: (next) => {
      queryClient.setQueryData(['settings'], next);
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

/**
 * 音源列表 + 健康度。
 *
 * 3 秒轮询：健康度是**播放时**在主进程里累加的，渲染进程没有推送事件，
 * 这个页面又是低频页面，轮询是最省事且够用的做法。
 */
export function useSources() {
  return useQuery({
    queryKey: ['sources'],
    queryFn: () => invoke(CH.sourcesList),
    refetchInterval: 3000,
  });
}

/** 手动恢复某个音源的健康度（传 undefined 表示全部）。 */
export function useResetSourceHealth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sourceId?: string) => invoke(CH.sourcesResetHealth, { sourceId }),
    onSuccess: (data) => queryClient.setQueryData(['sources'], data),
  });
}

/* ------------------------------------------------------------------ *
 * 自定义源插件（L3）
 * ------------------------------------------------------------------ */

/** 已导入的插件列表（不含脚本文本）。 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: () => invoke(CH.sourcesPlugins),
    staleTime: 10_000,
  });
}

/**
 * 导入一份自定义源脚本。
 *
 * 主进程会在沙箱里真跑一次：语法错误、没有可用平台，都会让这个 mutation 失败，
 * 界面直接把原因显示出来（比「导入成功但点歌全失败」诚实得多）。
 */
export function useImportPlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (script: string) => invoke(CH.sourcesImportPlugin, { script }),
    onSuccess: (data) => {
      queryClient.setQueryData(['plugins'], data);
      // 插件会改变责任链，音源列表里的 L3 行要跟着刷新。
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

export function useTogglePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) => invoke(CH.sourcesTogglePlugin, args),
    onSuccess: (data) => {
      queryClient.setQueryData(['plugins'], data);
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

export function useRemovePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke(CH.sourcesRemovePlugin, { id }),
    onSuccess: (data) => {
      queryClient.setQueryData(['plugins'], data);
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

/** 音质日志：每次解析的实测结果，最新在前。 */
export function useQualityLog(enabled: boolean) {
  return useQuery({
    queryKey: ['quality-log'],
    queryFn: () => invoke(CH.sourcesQualityLog),
    enabled,
    // 播放一首歌就多一条，打开页面时拉一次就够（不需要实时刷）。
    staleTime: 5_000,
  });
}

/**
 * 歌曲评论（热门 + 最新）。
 *
 * 用 `useInfiniteQuery` 而不是自己攒 offset：翻页失败时 React Query 会保留
 * 已经拿到的页，不会把用户已经读过的评论清空。
 */
export function useComments(songId: number | null | undefined, limit = 20) {
  const ready = typeof songId === 'number' && songId > 0;
  return useInfiniteQuery({
    queryKey: ['comments', songId, limit],
    queryFn: ({ pageParam }) => invoke(CH.ncmComments, { songId: songId as number, offset: pageParam, limit }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (lastPage.hasMore ? allPages.length * limit : undefined),
    enabled: ready,
  });
}

/**
 * 查这些歌有没有被我点过喜欢。
 *
 * 网易云没有「单曲喜欢状态」这种接口，只能拿整个已喜欢 id 列表来对；
 * 所以这里缓存久一点（30 秒），并且在喜欢/取消之后直接写缓存，不再多问一次。
 */
export function useLikeCheck(songId: number | null | undefined, enabled: boolean) {
  const ready = enabled && typeof songId === 'number' && songId > 0;
  return useQuery({
    queryKey: ['like-check', songId],
    queryFn: () => invoke(CH.ncmLikeCheck, { songIds: [songId as number] }),
    enabled: ready,
    staleTime: 30_000,
  });
}

/** 喜欢 / 取消喜欢一首歌。 */
export function useToggleLike() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { songId: number; like: boolean }) => invoke(CH.ncmLike, args),
    onSuccess: (data, variables) => {
      // 接口回的就是最新已喜欢列表，直接写进缓存，省一次往返。
      queryClient.setQueryData(['like-check', variables.songId], data);
      // 「我的喜欢」页面要跟着变。
      void queryClient.invalidateQueries({ queryKey: ['library'] });
    },
  });
}

/**
 * 歌词（原文 + 翻译），解析在主进程完成（渲染层不碰网络）。
 *
 * 歌词一整天都不会变，所以缓存 10 分钟；换歌靠 queryKey 里的 songId 区分。
 * 拿不到歌词不是错误（纯音乐、没有翻译、接口没收录），`hasLyric` 会是 false。
 */
export function useLyric(songId: number | null | undefined) {
  const ready = typeof songId === 'number' && songId > 0;
  return useQuery({
    queryKey: ['lyric', songId],
    queryFn: () => invoke(CH.ncmLyric, { songId: songId as number }),
    enabled: ready,
    staleTime: 10 * 60_000,
  });
}

/* ------------------------------------------------------------------ *
 * M5：下载与本地库（渲染层这一半）
 * ------------------------------------------------------------------ */

/**
 * 下载任务列表（`我的下载` 页的数据源）。
 *
 * 主进程在队列有任何变化（入队 / 进度 / 状态）之后都会推一份**完整**列表
 * （`EVT.downloadsChanged`，那边节流到约 4 次/秒），所以推送本身就是最新快照：
 * 直接 `setQueryData` 覆盖缓存即可，**不要**再 `invalidateQueries` ——
 * 那等于在每次进度推送之后再问主进程一遍，请求量翻倍而数据一模一样。
 *
 * 订阅在 cleanup 里退订：这一页不是常驻页面，切走之后没必要继续收推送。
 */
export function useDownloads() {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      subscribeEvent(EVT.downloadsChanged, (list) => {
        queryClient.setQueryData(['downloads'], list);
      }),
    [queryClient],
  );

  return useQuery({
    queryKey: ['downloads'],
    queryFn: () => invoke(CH.downloadsList),
  });
}

/**
 * 把一首歌加入下载队列。
 *
 * `level` 不传 = 主进程按设置里的 `preferredQuality` 下载（渲染层不替用户决定档位）。
 * 五个下载动作的出参都是**整份列表**，所以成功后直接写缓存，不再是「先写缓存再失效」。
 */
export function useAddDownload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { song: Song; level?: Quality }) => invoke(CH.downloadsAdd, args),
    onSuccess: (list) => queryClient.setQueryData(['downloads'], list),
  });
}

/** 暂停某个任务（`downloading` 时把连接收掉，已落盘的字节留在 `.part` 里）。 */
export function usePauseDownload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke(CH.downloadsPause, { id }),
    onSuccess: (list) => queryClient.setQueryData(['downloads'], list),
  });
}

/** 继续某个已暂停的任务（上游支持 `Range` 才是真续传，否则主进程从头下，见 `DownloadTask` 注释）。 */
export function useResumeDownload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke(CH.downloadsResume, { id }),
    onSuccess: (list) => queryClient.setQueryData(['downloads'], list),
  });
}

/** 重试失败 / 文件缺失的任务。 */
export function useRetryDownload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke(CH.downloadsRetry, { id }),
    onSuccess: (list) => queryClient.setQueryData(['downloads'], list),
  });
}

/**
 * 移除一条下载记录。
 *
 * `deleteFile` 由调用方决定（界面上的口径：`done` 的行连磁盘文件一起删，其余只删记录）——
 * 不在这里替用户猜，删文件是不可逆的。
 */
export function useRemoveDownload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; deleteFile?: boolean }) => invoke(CH.downloadsRemove, args),
    onSuccess: (list) => queryClient.setQueryData(['downloads'], list),
  });
}

/**
 * 本地库清单（磁盘上那个目录里扫出来的音频文件，只读）。
 *
 * 和下载队列不是一回事：下载队列是「我们拉下来的任务」（有状态、能暂停），本地库是
 * 「这个目录里有什么文件」。所以这里没有事件推送（主进程只在扫描时读一次目录，
 * 没有 watcher），想让清单变新只能显式 `refetch()`——界面上的「重新扫描」就是干这个的。
 *
 * 出参里的 `tracks` 为空数组是**正常态**（目录没设 / 不存在 / 里面没有音频），
 * 不是错误，所以界面要区分 `error` 与「空」。
 */
export function useLocalLibrary() {
  return useQuery({
    queryKey: ['local-library'],
    queryFn: () => invoke(CH.libraryList),
  });
}

