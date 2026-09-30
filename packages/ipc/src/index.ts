/**
 * @pi/ipc —— 渲染进程与主进程之间的**唯一**通道契约。
 *
 * 设计要点（见 docs/PLAN.md §2.3）：
 * 1. 渲染进程不做任何直接网络/文件访问，一切经此契约走主进程。
 * 2. 每个通道都有 zod 运行时校验：preload 发出前校验入参，main 处理前后各校验一次。
 *    这样「接口悄悄变了」会在开发期立刻炸出来，而不是变成线上诡异 bug。
 * 3. 类型层面用 `AssertAssignable` 把 zod 契约钉死在 @pi/shared 的领域模型上，
 *    防止两处定义漂移。
 */
import { z } from 'zod';
import type {
  AccountCapability,
  AudioProbe,
  Comment,
  CommentPage,
  LxPluginSummary,
  Lyric,
  LyricLine,
  PlayedTrack,
  Playlist,
  QrLoginState,
  QrLoginTicket,
  Quality,
  QualityLogEntry,
  ResolvedAudio,
  ResolveAttempt,
  RuntimeInfo,
  SearchResult,
  Settings,
  Song,
  SourceStatus,
  TrackPage,
} from '@pi/shared';

/** 编译期断言：`A` 必须可赋值给 `B`，否则 TS 报错。零运行时开销。 */
type AssertAssignable<A extends B, B> = A;

/* ------------------------------------------------------------------ *
 * 基础枚举
 * ------------------------------------------------------------------ */

export const QUALITY_VALUES = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jymaster',
  'flac',
  'flac24bit',
] as const;

export const QualitySchema = z.enum(QUALITY_VALUES);
export type QualityValue = z.infer<typeof QualitySchema>;
/** 若 ipc 的枚举与 @pi/shared 的 Quality 不一致，这里会编译失败。 */
export type _QualitySame = AssertAssignable<QualityValue, import('@pi/shared').Quality>;
export type _QualitySameBack = AssertAssignable<import('@pi/shared').Quality, QualityValue>;

/* ------------------------------------------------------------------ *
 * 领域对象的线上形状
 * ------------------------------------------------------------------ */

const ArtistRefSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const AlbumRefSchema = z.object({
  id: z.number(),
  name: z.string(),
  coverUrl: z.string().optional(),
});

export const SongSchema = z.object({
  id: z.number(),
  name: z.string(),
  artists: z.array(ArtistRefSchema),
  album: AlbumRefSchema.optional(),
  durationMs: z.number().optional(),
  playable: z.boolean().optional(),
  maxQuality: QualitySchema.optional(),
});

export const PlaylistSchema = z.object({
  id: z.number(),
  name: z.string(),
  coverUrl: z.string().optional(),
  trackCount: z.number(),
  creator: z.string().optional(),
  description: z.string().optional(),
  specialType: z.number().optional(),
  subscribed: z.boolean().optional(),
});

export const SearchResultSchema = z.object({
  songs: z.array(SongSchema),
  playlists: z.array(PlaylistSchema),
  artists: z.array(ArtistRefSchema),
  albums: z.array(AlbumRefSchema),
});

/* ------------------------------------------------------------------ *
 * M1：登录与曲库
 * ------------------------------------------------------------------ */

export const QrCheckCodeSchema = z.union([
  z.literal(800),
  z.literal(801),
  z.literal(802),
  z.literal(803),
]);

export const QrLoginTicketSchema = z.object({
  key: z.string().min(1),
  image: z.string().min(1),
  url: z.string().optional(),
});

export const QrCheckRequestSchema = z.object({ key: z.string().min(1) });

export const QrLoginStateSchema = z.object({
  code: QrCheckCodeSchema,
  message: z.string().optional(),
  nickname: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export const PlayedTrackSchema = z.object({
  song: SongSchema,
  playCount: z.number(),
  lastPlayedAt: z.number(),
});

export const RecentTracksSchema = z.object({ tracks: z.array(PlayedTrackSchema) });

export const TrackPageSchema = z.object({
  tracks: z.array(SongSchema),
  total: z.number().optional(),
  hasMore: z.boolean(),
});

/* ------------------------------------------------------------------ *
 * M3 / M4：歌曲评论与「喜欢」
 * ------------------------------------------------------------------ */

const CommentUserSchema = z.object({
  id: z.number(),
  nickname: z.string(),
  avatarUrl: z.string().optional(),
});

const CommentReplySchema = z.object({
  nickname: z.string(),
  content: z.string(),
});

export const CommentSchema = z.object({
  id: z.number(),
  content: z.string(),
  /** 毫秒时间戳 */
  time: z.number(),
  likedCount: z.number(),
  user: CommentUserSchema,
  beReplied: z.array(CommentReplySchema).optional(),
  location: z.string().optional(),
});

/** 热门评论只有第一页才非空（见 @pi/shared 的 `CommentPage`）。 */
export const CommentPageSchema = z.object({
  total: z.number(),
  hasMore: z.boolean(),
  hot: z.array(CommentSchema),
  comments: z.array(CommentSchema),
});

/** 评论分页入参。上限 50：评论动辄上万条，一次拉太多只会拖慢弹层。 */
export const CommentsRequestSchema = z.object({
  songId: z.number().int().positive(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
export type CommentsRequest = z.input<typeof CommentsRequestSchema>;

export const LikeRequestSchema = z.object({
  songId: z.number().int().positive(),
  like: z.boolean(),
});
export type LikeRequest = z.infer<typeof LikeRequestSchema>;

/** 批量查「这些歌里哪些已喜欢」。上限与分页入参一致，避免一次问上千首。 */
export const LikeCheckRequestSchema = z.object({
  songIds: z.array(z.number().int()).max(200),
});
export type LikeCheckRequest = z.infer<typeof LikeCheckRequestSchema>;

/** 「已喜欢」的歌曲 id 列表——只列已喜欢的，不在列表里就是没喜欢。 */
export const LikeStateSchema = z.object({ liked: z.array(z.number().int()) });
export type LikeState = z.infer<typeof LikeStateSchema>;

/* ------------------------------------------------------------------ *
 * M4：歌词（ncm:lyric）
 * ------------------------------------------------------------------ */

/** 一行歌词：相对歌曲开头的毫秒数 + 文本。 */
export const LyricLineSchema = z.object({
  timeMs: z.number(),
  text: z.string(),
});

/**
 * 一首歌的歌词。
 *
 * `translated` 与 `hasLyric` 都是**必填**字段（没有翻译时给空数组，而不是省略）：
 * 渲染进程要靠 `hasLyric` 区分「这首歌就是没有歌词」与「歌词还没加载出来」，
 * 靠省略字段是分不出来的。
 */
export const LyricSchema = z.object({
  lines: z.array(LyricLineSchema),
  translated: z.array(LyricLineSchema),
  hasLyric: z.boolean(),
});

/** 歌词入参：只要歌曲 id（不需要登录）。 */
export const LyricRequestSchema = z.object({ songId: z.number().int().positive() });
export type LyricRequest = z.infer<typeof LyricRequestSchema>;

/* ------------------------------------------------------------------ *
 * 推荐页（M2.6）：私人雷达 / 推荐歌单 / 推荐新音乐
 * ------------------------------------------------------------------ */

/** 「一次要几条」的入参。上限 50：推荐位再多也没人往下翻。 */
export const LimitRequestSchema = z.object({
  limit: z.number().int().min(1).max(50).default(12),
});

export const PlaylistsSchema = z.object({ playlists: z.array(PlaylistSchema) });
export const SongsSchema = z.object({ tracks: z.array(SongSchema) });

/** 私人雷达：歌单元数据可能拿不到（接口抽风），歌曲列表照样要能显示。 */
export const RadarSchema = z.object({
  playlist: PlaylistSchema.nullable(),
  tracks: z.array(SongSchema),
});

/** 分页入参。上限 200 是为了避免一次拉几千首歌把 IPC 通道撑爆。 */
export const PagedRequestSchema = z.object({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(100),
});

export const PlaylistTracksRequestSchema = PagedRequestSchema.extend({
  playlistId: z.number().int().positive(),
});

/**
 * 「按一个 id 翻页」的入参（用户第九轮第 2 条：点名片里的歌手名 / 专辑名要出歌曲卡片）。
 *
 * 歌手与专辑都只需要「一个 id + 分页」，所以共用同一个入参；不共用
 * `PlaylistTracksRequestSchema` 是因为那个字段名写死了 `playlistId`。
 */
export const IdPageRequestSchema = PagedRequestSchema.extend({
  id: z.number().int().positive(),
});

/* ------------------------------------------------------------------ *
 * M3.5：改歌单（用户 m06982 第 1 条 —— 新建歌单 / 往歌单里加歌）
 * ------------------------------------------------------------------ */

/** 新建歌单：名字限长，避免把超长串直接甩给上游。 */
export const PlaylistCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(40),
});

export const PlaylistCreateResultSchema = z.object({
  playlistId: z.number().int().positive(),
});

/** 加歌 / 删歌：一次最多 200 首，和分页上限保持一致。 */
export const PlaylistEditTracksRequestSchema = z.object({
  playlistId: z.number().int().positive(),
  trackIds: z.array(z.number().int().positive()).min(1).max(200),
  op: z.enum(['add', 'del']).default('add'),
});

/* ------------------------------------------------------------------ *
 * M2：播放
 * ------------------------------------------------------------------ */

export const AudioContainerSchema = z.enum([
  'flac',
  'mp3',
  'm4a',
  'ogg',
  'wav',
  'aac',
  'unknown',
]);

/** 字节嗅探出的实测特征。UI 上的「无损」徽标只认它，不认接口自称。 */
export const AudioProbeSchema = z.object({
  container: AudioContainerSchema,
  sampleRate: z.number().optional(),
  bitrateKbps: z.number().optional(),
  evidence: z.string(),
});

export const ResolvedAudioSchema = z.object({
  url: z.string(),
  quality: QualitySchema,
  /** 来源自称的档位（只在被探针实测改写时存在），用于「自称 X / 实测 Y」这类展示。 */
  claimedQuality: QualitySchema.optional(),
  probe: AudioProbeSchema,
  via: z.string(),
  expiresAt: z.number().optional(),
  /**
   * 官方只给试听片段（VIP 歌曲 + 非 VIP 账号）。UI 必须如实显示「试听」，
   * 否则用户会以为播放器坏了。注意：`upstreamHeaders` **故意不在这里**——
   * 回源请求头绝不能离开主进程。
   */
  trial: z.boolean().optional(),
});

export const ResolveAttemptSchema = z.object({
  sourceId: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
  elapsedMs: z.number(),
});

/** 请求播放某首歌：带上整首歌的元信息，第三方音源只用「歌名 + 歌手」匹配。 */
export const PlayResolveRequestSchema = z.object({
  song: SongSchema,
  /** 期望音质；不传则由设置里的 preferredQuality 与账号能力共同决定。 */
  level: QualitySchema.optional(),
});

export const PlayResolveResponseSchema = z.object({
  /** 解析结果；null 表示所有音源都没拿到可播地址（该曲会被标记为不可播）。 */
  audio: ResolvedAudioSchema.nullable(),
  attempts: z.array(ResolveAttemptSchema),
  /** 交给 `<audio src>` 的本地代理地址（只指向 127.0.0.1，带会话 token）。 */
  src: z.string().optional(),
});

/* ------------------------------------------------------------------ *
 * M5：下载与本地库
 * ------------------------------------------------------------------ */

/**
 * 下载任务的状态机。
 *
 * - `queued` / `downloading` / `paused` 是「还没拿到完整文件」的三种活状态；
 * - `done` 表示文件已经完整落盘，**且**启动对账时文件还在；
 * - `missing` 表示记录还在、文件没了（用户手动删了、换机器了）——
 *   这时**不删记录**，只是如实告诉界面「这条下载已经失效」，用户可选择重下或删记录；
 * - `error` 是下载过程中失败（上游 404 / 断流 / 写盘失败），`error` 字段带原因。
 */
export const DOWNLOAD_STATUS_VALUES = [
  'queued',
  'downloading',
  'paused',
  'done',
  'error',
  'missing',
] as const;

export const DownloadStatusSchema = z.enum(DOWNLOAD_STATUS_VALUES);
export type DownloadStatus = z.infer<typeof DownloadStatusSchema>;

/**
 * 一条下载任务（`我的下载` 列表的一行）。
 *
 * 刻意**不包含**上游地址与回源请求头：那些只有主进程知道（docs/PLAN.md §2.5 安全红线）。
 * 渲染进程只拿得到本机文件路径，且路径已经落在用户的下载目录里，不泄漏任何凭据。
 *
 * 关于「暂停」的诚实说明（M5 验收要求如实记录，不许假装支持断点续传）：
 * 上游 CDN 若支持 HTTP `Range`，`resume` 会从 `.part` 文件已写好的字节继续拉；
 * 若上游对带 `Range` 的请求回 `200` 而不是 `206`（即不支持断点），
 * `resume` 会**从头重新下载**，并把这一事实写进主进程日志（`[pi/downloads] …不支持 Range…`）。
 * 无论哪种情况，用户看到的字节进度都是磁盘上真实写好的字节数，不会跳变。
 */
export interface DownloadTask {
  /** 任务 id（随机 UUID），不是歌曲 id——同一首歌可以有不同的下载记录。 */
  id: string;
  songId: number;
  name: string;
  /** 已拍平的歌手名（`A、B`），界面上直接显示，不必再 join 一次。 */
  artists: string;
  album: string;
  coverUrl?: string;
  /** 本次下载**实际请求**的音质档位（已被账号能力夹逼过）。 */
  quality: Quality;
  /** 档位的中文名（`QUALITY_LABEL`），省得渲染层再查一次表。 */
  qualityLabel?: string;
  status: DownloadStatus;
  /** 已落盘字节数（`paused` 时就是 `.part` 文件的真实大小）。 */
  receivedBytes: number;
  /** 上游声明的内容总长度；拿不到 `content-length` 时为 0（进度条按不确定态显示）。 */
  totalBytes: number;
  /** 目标文件绝对路径（下载中先写 `<filePath>.part`，完成后 rename 过去）。 */
  filePath: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export const DownloadTaskSchema = z.object({
  id: z.string(),
  songId: z.number(),
  name: z.string(),
  artists: z.string(),
  album: z.string(),
  coverUrl: z.string().optional(),
  quality: QualitySchema,
  qualityLabel: z.string().optional(),
  status: DownloadStatusSchema,
  receivedBytes: z.number(),
  totalBytes: z.number(),
  filePath: z.string(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type _DownloadTaskOk = AssertAssignable<z.infer<typeof DownloadTaskSchema>, DownloadTask>;
export type _DownloadTaskBack = AssertAssignable<DownloadTask, z.infer<typeof DownloadTaskSchema>>;

/** 出参统一是「整份下载列表」：任何变更后渲染层拿到的都是一份自洽的快照。 */
export const DownloadListSchema = z.array(DownloadTaskSchema);

/** 加入下载：带上整首歌的元信息；`level` 不传则用设置里的 preferredQuality。 */
export const DownloadAddRequestSchema = z.object({
  song: SongSchema,
  level: QualitySchema.optional(),
});

export const DownloadIdRequestSchema = z.object({
  id: z.string().min(1),
});

export const DownloadRemoveRequestSchema = z.object({
  id: z.string().min(1),
  /** 是否连磁盘上的音频文件一起删；默认 false（只删记录，文件留在下载目录里）。 */
  deleteFile: z.boolean().optional(),
});

/* ---------------- M5：本地库 ---------------- */

/**
 * 本地曲库里的一首歌。
 *
 * 形状**逐字**对齐 `packages/source-local` 的 `LocalTrack`（那边是权威定义）。
 * 这里手抄一份是因为 @pi/ipc 只依赖 @pi/shared + zod，不能 import @pi/source-local；
 * 两边的漂移由 `apps/desktop/src/main/library.ts` 里的 `AssertAssignable` 双向断言兜住
 * ——那边同时看得到两个包，谁改了形状谁编译失败。
 */
export interface LocalLibraryTrack {
  /** 稳定 id（绝对路径的 sha1 前 12 位）。 */
  id: string;
  /** 绝对路径。 */
  path: string;
  title: string;
  artists: string[];
  albumName?: string;
  durationMs?: number;
  /** 不含点的小写后缀，例如 `flac`。 */
  ext: string;
  sizeBytes?: number;
}

export const LocalLibraryTrackSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  albumName: z.string().optional(),
  durationMs: z.number().optional(),
  ext: z.string(),
  sizeBytes: z.number().optional(),
});

export type _LocalLibraryTrackOk = AssertAssignable<
  z.infer<typeof LocalLibraryTrackSchema>,
  LocalLibraryTrack
>;
export type _LocalLibraryTrackBack = AssertAssignable<
  LocalLibraryTrack,
  z.infer<typeof LocalLibraryTrackSchema>
>;

/**
 * `library:list` 的出参。
 *
 * `dir` 是**本次扫描实际用的目录**（绝对路径；设置为空时是空串），
 * 目录不存在或读不出音频时 `tracks` 是空数组而不是抛错——界面要能显示
 * 「这个目录里没有音频」。
 */
export interface LocalLibraryList {
  dir: string;
  tracks: LocalLibraryTrack[];
}

export const LocalLibraryListSchema = z.object({
  dir: z.string(),
  tracks: z.array(LocalLibraryTrackSchema),
});

export type _LocalLibraryListOk = AssertAssignable<
  z.infer<typeof LocalLibraryListSchema>,
  LocalLibraryList
>;
export type _LocalLibraryListBack = AssertAssignable<
  LocalLibraryList,
  z.infer<typeof LocalLibraryListSchema>
>;

export const RuntimeInfoSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  appVersion: z.string(),
  electronVersion: z.string(),
  nodeVersion: z.string(),
  chromeVersion: z.string(),
  userDataDir: z.string(),
  safeStorage: z.enum(['available', 'unavailable', 'error']),
  softwareRendering: z.boolean(),
});

export const AccountCapabilitySchema = z.object({
  loggedIn: z.boolean(),
  userId: z.number().optional(),
  nickname: z.string().optional(),
  avatarUrl: z.string().optional(),
  vip: z.boolean(),
  vipType: z.number(),
  maxQuality: QualitySchema,
  thirdPartyEnabled: z.boolean(),
});

/**
 * 歌词动效参数。
 *
 * 这里**故意一个 `.default()` 都不加**。`SettingsPatchSchema = SettingsSchema.partial()`
 * 在 zod 4 里不会拦掉子对象的默认值：`SettingsPatchSchema.parse({})` 会返回
 * `{ lyricTuning: <默认值> }`，而主进程 `patchSettings` 是**浅合并** `{ ...current, ...patch }`
 * ——于是「只改音量」也会把用户调好的动效参数悄悄打回默认。老设置文件里缺这个键
 * 由 `services.getSettings()` 的默认值兜底（见那里的注释），不靠 schema 的默认值。
 */
export const LyricTuningSchema = z
  .object({
    /** 舞台整体不透明度。0.4 是「还看得清」的下限，再低歌词就等于没唱。 */
    themeOpacity: z.number().min(0.4).max(1),
    /** 字号倍率。1.3 是上限，各主题内部还会按舞台宽再夹一次防溢出。 */
    fontScale: z.number().min(0.8).max(1.3),
    /** 动效幅度。`1` = 改造前的观感。 */
    motionAmount: z.number().min(0.4).max(1.6),
    /** 辉光强度。`1` = 改造前的观感，`0` = 完全不发光。 */
    glowIntensity: z.number().min(0).max(1.6),
    fpsCap: z.enum(['off', '120', '90', '60']),
    randomThemePerSong: z.boolean(),
    /** 浮名的镜头追焦方式（用户 m05281 第 3 条）。 */
    fumeCameraFollow: z.enum(['smooth', 'snap']),
    /** 浮名的镜头移动速度倍率。 */
    fumeCameraSpeed: z.number().min(0.4).max(2.5),
    /** 流光的逐字旋转开关（第 4 条）。 */
    classicWordSpin: z.boolean(),
    /** 云阶的引导线开关 + 错位上下界（第 6 条，px）。 */
    partitaGuides: z.boolean(),
    partitaStaggerMin: z.number().min(0).max(80),
    partitaStaggerMax: z.number().min(20).max(160),
    /** 时计的轮盘半径（短边百分比）/ 弧度角度（度）/ 擒纵咬合力 / 聚焦句缩放 / 表盘封面（第 7 条）。 */
    pendoloDialRadius: z.number().min(30).max(60),
    pendoloArcAngle: z.number().min(60).max(160),
    pendoloEscapeForce: z.number().min(0.5).max(3),
    pendoloFocusScale: z.number().min(1).max(1.7),
    pendoloCoverOnDial: z.boolean(),
  })
  // 未知键报错而不是静默丢弃：这个对象是整份传上来的，字段名写错时静默丢弃
  // 只会变成「设置页点了没反应」这种查不出来的 bug。
  .strict();

export const SettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  preferredQuality: QualitySchema,
  enableThirdPartySources: z.boolean(),
  /** 用户是否确认过第三方源的风险提示；没确认过就算开关是 true 也不启用（ADR-0001 第 6 条）。 */
  thirdPartyAcknowledged: z.boolean(),
  allowThirdPartyLossless: z.boolean(),
  scrobbleEnabled: z.boolean(),
  volume: z.number().min(0).max(1),
  // 用户 m03805 第 4 条：补上网易云的第四种「顺序播放」。老设置文件里只有前三个值，
  // 仍然是这个枚举的合法成员，所以持久化的设置不需要迁移。
  playMode: z.enum(['order', 'repeat-one', 'shuffle', 'sequence']),
  downloadDir: z.string(),
  localLibraryDir: z.string(),
  locale: z.enum(['zh-CN', 'en']),
  /**
   * 歌词主题（用户 m08768 第 4 条）。键名与 folia-major 的目录名对齐：
   * `classic` 流光（我们的默认，也是最先复刻的那套）/ `fume` 浮名 / `cadenza` 心象 /
   * `partita` 云阶 / `tilt` 倾诉 / `pendolo` 时计。
   */
  lyricTheme: z.enum(['classic', 'fume', 'cadenza', 'partita', 'tilt', 'pendolo']),
  /** 歌词动效细调（字号 / 幅度 / 辉光 / 帧率上限……）；每个字段都真的改变画面。 */
  lyricTuning: LyricTuningSchema,
});

export const SettingsPatchSchema = SettingsSchema.partial();

/* ------------------------------------------------------------------ *
 * 音源状态（M2.5 H7「来源可追溯」/ H8「健康降权」）
 * ------------------------------------------------------------------ */

export const SourceStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  tier: z.enum(['official', 'unm', 'aggregator', 'lx', 'local']),
  enabled: z.boolean(),
  needsCookie: z.boolean(),
  qualities: z.array(QualitySchema),
  consecutiveFailures: z.number(),
  demotedUntil: z.number().optional(),
  lastError: z.string().optional(),
  lastOkAt: z.number().optional(),
  ok: z.number(),
  missed: z.number(),
  rejected: z.number(),
});

/** 手动恢复音源健康度（UI 上的「重试」）。不传 id 表示全部恢复。 */
export const SourceResetRequestSchema = z.object({ sourceId: z.string().optional() });
export const SourceListSchema = z.object({ sources: z.array(SourceStatusSchema) });

/* ------------------------------------------------------------------ *
 * 自定义源插件（M2.5 H4）与音质日志（H7）
 * ------------------------------------------------------------------ */

/**
 * 插件摘要。**不含脚本文本**——列表接口不该把几十 KB 的脚本反复发到渲染进程，
 * 而且渲染进程没有理由持有它。
 */
export const LxPluginSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().optional(),
  author: z.string().optional(),
  description: z.string().optional(),
  sources: z.array(z.string()),
  enabled: z.boolean(),
  importedAt: z.number(),
});

export const LxPluginListSchema = z.object({ plugins: z.array(LxPluginSummarySchema) });

/** 导入插件：只收文本（与 LX 一致，没有 URL 参数，避免「导入链接」变成 SSRF 入口）。 */
export const LxPluginImportRequestSchema = z.object({
  script: z.string().min(1),
  /** 可选覆盖显示名（默认取脚本头部注释里的 @name）。 */
  name: z.string().optional(),
});

export const LxPluginToggleRequestSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});

export const LxPluginRemoveRequestSchema = z.object({ id: z.string().min(1) });

export const QualityLogEntrySchema = z.object({
  at: z.number(),
  songId: z.number(),
  title: z.string(),
  artist: z.string().optional(),
  requested: QualitySchema,
  via: z.string().optional(),
  quality: QualitySchema.optional(),
  container: z.string().optional(),
  sampleRate: z.number().optional(),
  bitrate: z.number().optional(),
  trial: z.boolean().optional(),
  claimed: QualitySchema.optional(),
  elapsedMs: z.number(),
  attempts: z.array(ResolveAttemptSchema),
});

export const QualityLogSchema = z.object({ entries: z.array(QualityLogEntrySchema) });

/** 编译期对齐检查：线上形状必须与领域模型一致。 */
export type _QrTicketOk = AssertAssignable<z.infer<typeof QrLoginTicketSchema>, QrLoginTicket>;
export type _QrStateOk = AssertAssignable<z.infer<typeof QrLoginStateSchema>, QrLoginState>;
export type _PlayedTrackOk = AssertAssignable<z.infer<typeof PlayedTrackSchema>, PlayedTrack>;
export type _TrackPageOk = AssertAssignable<z.infer<typeof TrackPageSchema>, TrackPage>;
export type _RuntimeInfoOk = AssertAssignable<z.infer<typeof RuntimeInfoSchema>, RuntimeInfo>;
export type _CapabilityOk = AssertAssignable<
  z.infer<typeof AccountCapabilitySchema>,
  AccountCapability
>;
export type _SettingsOk = AssertAssignable<z.infer<typeof SettingsSchema>, Settings>;
export type _SearchOk = AssertAssignable<z.infer<typeof SearchResultSchema>, SearchResult>;
export type _AudioProbeOk = AssertAssignable<z.infer<typeof AudioProbeSchema>, AudioProbe>;
export type _ResolvedAudioOk = AssertAssignable<z.infer<typeof ResolvedAudioSchema>, ResolvedAudio>;
export type _ResolveAttemptOk = AssertAssignable<z.infer<typeof ResolveAttemptSchema>, ResolveAttempt>;
export type _SourceStatusOk = AssertAssignable<z.infer<typeof SourceStatusSchema>, SourceStatus>;
export type _LxPluginOk = AssertAssignable<
  z.infer<typeof LxPluginSummarySchema>,
  LxPluginSummary
>;
export type _QualityLogOk = AssertAssignable<
  z.infer<typeof QualityLogEntrySchema>,
  QualityLogEntry
>;
export type _CommentOk = AssertAssignable<z.infer<typeof CommentSchema>, Comment>;
export type _CommentPageOk = AssertAssignable<z.infer<typeof CommentPageSchema>, CommentPage>;
export type _LyricLineOk = AssertAssignable<z.infer<typeof LyricLineSchema>, LyricLine>;
export type _LyricOk = AssertAssignable<z.infer<typeof LyricSchema>, Lyric>;

/* ------------------------------------------------------------------ *
 * 内嵌网易云 API 子进程
 * ------------------------------------------------------------------ */

export const NcmHealthSchema = z.object({
  status: z.enum(['idle', 'starting', 'ready', 'error', 'stopped']),
  port: z.number().optional(),
  error: z.string().optional(),
});
export type NcmHealth = z.infer<typeof NcmHealthSchema>;

export const SearchRequestSchema = z.object({
  keywords: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(30),
});
export type SearchRequest = z.input<typeof SearchRequestSchema>;

/* ------------------------------------------------------------------ *
 * 通道表
 * ------------------------------------------------------------------ */

export const CH = {
  appInfo: 'app:info',
  accountCapability: 'account:capability',
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  ncmHealth: 'ncm:health',
  ncmSearch: 'ncm:search',
  ncmComments: 'ncm:comments',
  ncmLyric: 'ncm:lyric',
  ncmLike: 'ncm:like',
  ncmLikeCheck: 'ncm:like-check',
  authQrKey: 'auth:qr-key',
  authQrCheck: 'auth:qr-check',
  authLogout: 'auth:logout',
  libraryRecent: 'library:recent',
  libraryLiked: 'library:liked',
  libraryMyPlaylists: 'library:my-playlists',
  libraryRecommend: 'library:recommend',
  libraryPersonalized: 'library:personalized',
  libraryRadar: 'library:radar',
  libraryNewSongs: 'library:new-songs',
  libraryArtistSongs: 'library:artist-songs',
  libraryAlbumSongs: 'library:album-songs',
  libraryPlaylistTracks: 'library:playlist-tracks',
  libraryPlaylistCreate: 'library:playlist-create',
  libraryPlaylistEditTracks: 'library:playlist-edit-tracks',
  playerResolve: 'player:resolve',
  /** M5 下载：列表 / 加入 / 暂停 / 继续 / 重试 / 移除。出参统一是整份列表。 */
  downloadsList: 'downloads:list',
  downloadsAdd: 'downloads:add',
  downloadsPause: 'downloads:pause',
  downloadsResume: 'downloads:resume',
  downloadsRetry: 'downloads:retry',
  downloadsRemove: 'downloads:remove',
  /** M5 本地库：扫一遍 settings.localLibraryDir，返回目录 + 音频清单（只读，无入参）。 */
  libraryList: 'library:list',
  sourcesList: 'sources:list',
  sourcesResetHealth: 'sources:reset-health',
  sourcesPlugins: 'sources:plugins',
  sourcesImportPlugin: 'sources:import-plugin',
  sourcesTogglePlugin: 'sources:toggle-plugin',
  sourcesRemovePlugin: 'sources:remove-plugin',
  sourcesQualityLog: 'sources:quality-log',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
} as const;

/**
 * 主进程 → 渲染进程的**推送**事件。
 *
 * 和 CH 分开是因为它们方向相反：CH 是「渲染进程问、主进程答」，
 * 这里是「主进程主动告知」（登录态变了、内嵌服务挂了）。
 */
export const EVT = {
  accountChanged: 'account:changed',
  ncmHealthChanged: 'ncm:health-changed',
  /** 下载队列有任何变化（新增/进度/状态）就推一份完整列表；主进程侧节流到约 4 次/秒。 */
  downloadsChanged: 'downloads:changed',
} as const;

export type Channel = (typeof CH)[keyof typeof CH];
export type EventName = (typeof EVT)[keyof typeof EVT];

/** 事件 → 载荷类型。渲染进程订阅时靠它拿到类型提示。 */
export interface EventMap {
  [EVT.accountChanged]: AccountCapability;
  [EVT.ncmHealthChanged]: NcmHealth;
  [EVT.downloadsChanged]: DownloadTask[];
}

/** 通道 → { 入参, 出参 }。主进程与 preload 都以此表为准。 */
export interface RouteMap {
  [CH.appInfo]: { input: void; output: RuntimeInfo };
  [CH.accountCapability]: { input: void; output: AccountCapability };
  [CH.settingsGet]: { input: void; output: Settings };
  [CH.settingsPatch]: {
    input: z.input<typeof SettingsPatchSchema>;
    output: Settings;
  };
  [CH.ncmHealth]: { input: void; output: NcmHealth };
  [CH.ncmSearch]: { input: SearchRequest; output: SearchResult };
  /** 歌曲评论分页；第一页额外带热门评论。不需要登录。 */
  [CH.ncmComments]: { input: CommentsRequest; output: CommentPage };
  /** 歌词（原文 + 翻译）。和评论一样**不需要登录**。 */
  [CH.ncmLyric]: { input: LyricRequest; output: Lyric };
  /** 喜欢/取消喜欢，返回这首歌**最新**的状态（内部就是再查一次 like-check）。 */
  [CH.ncmLike]: { input: LikeRequest; output: LikeState };
  /** 批量查「这些歌里哪些已喜欢」。靠 cookie 认人，所以需要登录。 */
  [CH.ncmLikeCheck]: { input: LikeCheckRequest; output: LikeState };
  /** 取一张新的二维码。每次打开登录弹窗都应重新调用（旧二维码会过期）。 */
  [CH.authQrKey]: { input: void; output: QrLoginTicket };
  /** 轮询扫码状态；返回 803 时主进程已把 cookie 存好并广播 accountChanged。 */
  [CH.authQrCheck]: { input: z.input<typeof QrCheckRequestSchema>; output: QrLoginState };
  [CH.authLogout]: { input: void; output: AccountCapability };
  [CH.libraryRecent]: { input: z.input<typeof PagedRequestSchema>; output: { tracks: PlayedTrack[] } };
  [CH.libraryLiked]: { input: z.input<typeof PagedRequestSchema>; output: TrackPage };
  [CH.libraryMyPlaylists]: { input: void; output: { playlists: Playlist[] } };
  [CH.libraryRecommend]: { input: void; output: { tracks: Song[] } };
  /** 推荐歌单：非个性化也有内容，所以未登录也允许调。 */
  [CH.libraryPersonalized]: {
    input: z.input<typeof LimitRequestSchema>;
    output: { playlists: Playlist[] };
  };
  /** 私人雷达：同一个歌单 id，内容由 cookie 个性化。 */
  [CH.libraryRadar]: { input: void; output: { playlist: Playlist | null; tracks: Song[] } };
  /** 推荐新音乐。 */
  [CH.libraryNewSongs]: { input: z.input<typeof LimitRequestSchema>; output: { tracks: Song[] } };
  /** 歌手的歌曲（用户第九轮第 2 条：点播放页名片里的歌手名）。 */
  [CH.libraryArtistSongs]: {
    input: z.input<typeof IdPageRequestSchema>;
    output: TrackPage;
  };
  /** 专辑的曲目（用户第九轮第 2 条：点播放页名片里的专辑名）。 */
  [CH.libraryAlbumSongs]: {
    input: z.input<typeof IdPageRequestSchema>;
    output: TrackPage;
  };
  [CH.libraryPlaylistTracks]: {
    input: z.input<typeof PlaylistTracksRequestSchema>;
    output: TrackPage;
  };
  /** 新建歌单（用户 m06982 第 1 条）：只回 id，界面拿到后自己刷新列表。 */
  [CH.libraryPlaylistCreate]: {
    input: z.input<typeof PlaylistCreateRequestSchema>;
    output: z.infer<typeof PlaylistCreateResultSchema>;
  };
  /** 往歌单里加歌 / 从歌单里删歌。成功即无返回内容，失败会抛错。 */
  [CH.libraryPlaylistEditTracks]: {
    input: z.input<typeof PlaylistEditTracksRequestSchema>;
    output: void;
  };
  /** 解析可播地址：主进程走音源解析链 + 字节嗅探，渲染进程只拿到本地代理地址。 */
  [CH.playerResolve]: {
    input: z.input<typeof PlayResolveRequestSchema>;
    output: z.infer<typeof PlayResolveResponseSchema>;
  };
  /**
   * M5 下载队列。六个通道的出参都是**整份** `DownloadTask[]`：
   * 队列是主进程的单一真相，界面拿快照渲染，省掉一堆增量同步的边界 bug。
   */
  [CH.downloadsList]: { input: void; output: DownloadTask[] };
  [CH.downloadsAdd]: { input: z.input<typeof DownloadAddRequestSchema>; output: DownloadTask[] };
  [CH.downloadsPause]: { input: z.input<typeof DownloadIdRequestSchema>; output: DownloadTask[] };
  [CH.downloadsResume]: { input: z.input<typeof DownloadIdRequestSchema>; output: DownloadTask[] };
  [CH.downloadsRetry]: { input: z.input<typeof DownloadIdRequestSchema>; output: DownloadTask[] };
  [CH.downloadsRemove]: {
    input: z.input<typeof DownloadRemoveRequestSchema>;
    output: DownloadTask[];
  };
  /** M5 本地库：只读清单。用领域类型（`LocalLibraryTrack.artists` 是可变数组，但条数/形状以 zod 为准）。 */
  [CH.libraryList]: { input: void; output: LocalLibraryList };
  /**
   * 音源列表 + 健康度。用领域类型而不是 `z.infer`：`SourceStatus.qualities` 是
   * `readonly Quality[]`（音源不应被调用方改写），zod 推出来的是可变数组，方向对不上。
   * 线上形状由 `SourceStatusSchema` 在开发期校验。
   */
  [CH.sourcesList]: { input: void; output: { sources: SourceStatus[] } };
  /** 手动恢复音源健康度（「重试这个音源」）。 */
  [CH.sourcesResetHealth]: {
    input: z.input<typeof SourceResetRequestSchema>;
    output: { sources: SourceStatus[] };
  };
  /** 已导入的自定义源插件（L3）。同样用领域类型，理由见上。 */
  [CH.sourcesPlugins]: { input: void; output: { plugins: LxPluginSummary[] } };
  /**
   * 导入一份自定义源脚本。
   *
   * 只收文本、不收 URL：内置脚本不可能像浏览器那样受同源策略保护，
   * 「导入链接」等于给渲染进程一个任意地址抓取入口。要导入链接就让用户自己下载再粘贴。
   */
  [CH.sourcesImportPlugin]: {
    input: z.input<typeof LxPluginImportRequestSchema>;
    output: { plugins: LxPluginSummary[] };
  };
  [CH.sourcesTogglePlugin]: {
    input: z.input<typeof LxPluginToggleRequestSchema>;
    output: { plugins: LxPluginSummary[] };
  };
  [CH.sourcesRemovePlugin]: {
    input: z.input<typeof LxPluginRemoveRequestSchema>;
    output: { plugins: LxPluginSummary[] };
  };
  /** 音质日志：本次运行解析过的歌曲（实测结果，不是来源自称）。 */
  [CH.sourcesQualityLog]: { input: void; output: { entries: QualityLogEntry[] } };
  [CH.windowMinimize]: { input: void; output: void };
  [CH.windowToggleMaximize]: { input: void; output: void };
  [CH.windowClose]: { input: void; output: void };
}

/**
 * 入参校验器。`void` 型通道不需要入参。
 * 用宽松的 `Record<string, z.ZodType>` 而非精确映射，是为了让「按通道查表」
 * 在泛型上下文中保持可用；精确性由上面的 AssertAssignable 与调用点类型保证。
 */
export const INPUT_SCHEMAS: Record<string, z.ZodType> = {
  [CH.settingsPatch]: SettingsPatchSchema,
  [CH.ncmSearch]: SearchRequestSchema,
  [CH.ncmComments]: CommentsRequestSchema,
  [CH.ncmLyric]: LyricRequestSchema,
  [CH.ncmLike]: LikeRequestSchema,
  [CH.ncmLikeCheck]: LikeCheckRequestSchema,
  [CH.authQrCheck]: QrCheckRequestSchema,
  [CH.libraryRecent]: PagedRequestSchema,
  [CH.libraryLiked]: PagedRequestSchema,
  [CH.libraryPlaylistTracks]: PlaylistTracksRequestSchema,
  [CH.libraryPlaylistCreate]: PlaylistCreateRequestSchema,
  [CH.libraryPlaylistEditTracks]: PlaylistEditTracksRequestSchema,
  [CH.libraryPersonalized]: LimitRequestSchema,
  [CH.libraryNewSongs]: LimitRequestSchema,
  [CH.libraryArtistSongs]: IdPageRequestSchema,
  [CH.libraryAlbumSongs]: IdPageRequestSchema,
  [CH.playerResolve]: PlayResolveRequestSchema,
  [CH.downloadsAdd]: DownloadAddRequestSchema,
  [CH.downloadsPause]: DownloadIdRequestSchema,
  [CH.downloadsResume]: DownloadIdRequestSchema,
  [CH.downloadsRetry]: DownloadIdRequestSchema,
  [CH.downloadsRemove]: DownloadRemoveRequestSchema,
  [CH.sourcesResetHealth]: SourceResetRequestSchema,
  [CH.sourcesImportPlugin]: LxPluginImportRequestSchema,
  [CH.sourcesTogglePlugin]: LxPluginToggleRequestSchema,
  [CH.sourcesRemovePlugin]: LxPluginRemoveRequestSchema,
};

/** 出参校验器，用于开发期契约测试。 */
export const OUTPUT_SCHEMAS: Record<string, z.ZodType> = {
  [CH.appInfo]: RuntimeInfoSchema,
  [CH.accountCapability]: AccountCapabilitySchema,
  [CH.settingsGet]: SettingsSchema,
  [CH.settingsPatch]: SettingsSchema,
  [CH.ncmHealth]: NcmHealthSchema,
  [CH.ncmSearch]: SearchResultSchema,
  [CH.ncmComments]: CommentPageSchema,
  [CH.ncmLyric]: LyricSchema,
  [CH.ncmLike]: LikeStateSchema,
  [CH.ncmLikeCheck]: LikeStateSchema,
  [CH.authQrKey]: QrLoginTicketSchema,
  [CH.authQrCheck]: QrLoginStateSchema,
  [CH.authLogout]: AccountCapabilitySchema,
  [CH.libraryRecent]: RecentTracksSchema,
  [CH.libraryLiked]: TrackPageSchema,
  [CH.libraryMyPlaylists]: z.object({ playlists: z.array(PlaylistSchema) }),
  [CH.libraryRecommend]: z.object({ tracks: z.array(SongSchema) }),
  [CH.libraryPlaylistTracks]: TrackPageSchema,
  [CH.libraryPlaylistCreate]: PlaylistCreateResultSchema,
  [CH.libraryPersonalized]: PlaylistsSchema,
  [CH.libraryRadar]: RadarSchema,
  [CH.libraryNewSongs]: SongsSchema,
  [CH.libraryArtistSongs]: TrackPageSchema,
  [CH.libraryAlbumSongs]: TrackPageSchema,
  [CH.playerResolve]: PlayResolveResponseSchema,
  [CH.downloadsList]: DownloadListSchema,
  [CH.downloadsAdd]: DownloadListSchema,
  [CH.downloadsPause]: DownloadListSchema,
  [CH.downloadsResume]: DownloadListSchema,
  [CH.downloadsRetry]: DownloadListSchema,
  [CH.downloadsRemove]: DownloadListSchema,
  [CH.libraryList]: LocalLibraryListSchema,
  [CH.sourcesList]: SourceListSchema,
  [CH.sourcesResetHealth]: SourceListSchema,
  [CH.sourcesPlugins]: LxPluginListSchema,
  [CH.sourcesImportPlugin]: LxPluginListSchema,
  [CH.sourcesTogglePlugin]: LxPluginListSchema,
  [CH.sourcesRemovePlugin]: LxPluginListSchema,
  [CH.sourcesQualityLog]: QualityLogSchema,
};

/** preload 暴露到 `window.pi` 上的形状。 */
export interface PreloadBridge {
  invoke<K extends Channel>(channel: K, payload?: RouteMap[K]['input']): Promise<RouteMap[K]['output']>;
  /** 主进程 → 渲染进程的单向事件（播放状态、下载进度、登录态变更等）。 */
  on(event: EventName | string, listener: (payload: unknown) => void): () => void;
}

export const PRELOAD_KEY = 'pi';
