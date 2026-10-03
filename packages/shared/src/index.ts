/**
 * @pi/shared —— 全仓共享的领域模型与常量。
 *
 * 约束：此包**零依赖**、不含任何 IO，可以被渲染进程、主进程、Node 脚本同时引用。
 * 只放「跨进程共享的数据形状」，不放实现。
 */

/* ------------------------------------------------------------------ *
 * 音质
 * ------------------------------------------------------------------ */

/**
 * 音质标识。
 * - `standard` / `higher` / `exhigh` / `lossless` / `hires` / `jymaster`：网易云官方等级
 * - `flac` / `flac24bit`：LX Music 自定义音源协议使用的等级
 */
export type Quality =
  'standard' | 'higher' | 'exhigh' | 'lossless' | 'hires' | 'jymaster' | 'flac' | 'flac24bit';

/** 由低到高。用于「取不超过账号上限的最高可用音质」这类比较。 */
export const QUALITY_ORDER: readonly Quality[] = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jymaster',
  'flac',
  'flac24bit',
] as const;

export const QUALITY_LABEL: Readonly<Record<Quality, string>> = {
  standard: '标准',
  higher: '较高',
  exhigh: '极高',
  lossless: '无损',
  hires: 'Hi-Res',
  jymaster: '超清母带',
  flac: '无损',
  flac24bit: 'Hi-Res 无损',
};

/** 是否属于需要 VIP 才能走的官方等级。 */
export const QUALITY_REQUIRES_VIP: Readonly<Record<Quality, boolean>> = {
  standard: false,
  higher: false,
  exhigh: false,
  lossless: true,
  hires: true,
  jymaster: true,
  flac: false,
  flac24bit: false,
};

export function qualityRank(q: Quality): number {
  return QUALITY_ORDER.indexOf(q);
}

/** 返回「不超过 cap 的最高音质」，用于在账号能力内挑选请求等级。 */
export function clampQuality(wanted: Quality, cap: Quality): Quality {
  return qualityRank(wanted) <= qualityRank(cap) ? wanted : cap;
}

/** 非 VIP 账号的官方上限。见 docs/PLAN.md §4.2 双能力设计。 */
export const NON_VIP_MAX_QUALITY: Quality = 'exhigh';

/* ------------------------------------------------------------------ *
 * 播放
 * ------------------------------------------------------------------ */

/**
 * 播放模式。四种，和网易云一致（用户 m03805 第 4 条）。
 * - `order`：列表循环（播到最后一首回到第一首）
 * - `repeat-one`：单曲循环（自动播放结束时重复本曲，手动「下一首」仍然换歌）
 * - `shuffle`：随机播放（一轮之内不重复）
 * - `sequence`：顺序播放（按列表顺序播到最后一首就停，**不回头**）
 *
 * 队列与模式的推进逻辑在 `@pi/player-core`，那边是纯函数、可单测。
 */
export type PlayMode = 'order' | 'repeat-one' | 'shuffle' | 'sequence';

/* ------------------------------------------------------------------ *
 * 音源解析
 * ------------------------------------------------------------------ */

export type AudioContainer = 'flac' | 'mp3' | 'm4a' | 'ogg' | 'wav' | 'aac' | 'unknown';

/** 实测音频特征。**不信任接口自称的音质**，一律以字节嗅探结果为准。 */
export interface AudioProbe {
  container: AudioContainer;
  sampleRate?: number;
  /** 仅在能算出时提供（如按字节数/时长估算）。 */
  bitrateKbps?: number;
  /** 字节嗅探的原始判定依据，便于排障。 */
  evidence: string;
}

/** 音源 id：`wy` 官方，`unm:*` UnblockNeteaseMusic 上游，`lx:*` 自定义音源脚本，`local` 本地文件。 */
export type SourceId = string;

export interface ResolvedAudio {
  url: string;
  /** 请求时实际使用的音质等级（官方阶梯可能降级）。 */
  quality: Quality;
  /**
   * 来源**自称**的档位，只在探针实测结果与它不一致时存在。
   *
   * 第三方源普遍虚标（128k 的 mp3 标成 flac），所以 UI 必须能同时说清
   * 「它自称什么」和「实测是什么」——只报实测会让人以为是我们给它降的级，
   * 只报自称就是帮着一起骗用户。
   */
  claimedQuality?: Quality;
  probe: AudioProbe;
  via: SourceId;
  /** 直链过期时间（ms epoch），部分上游会带。 */
  expiresAt?: number;
  /**
   * 回源请求头。**只在主进程里流转，绝不发给渲染进程**（`Services.publish` 会剥掉）。
   *
   * 官方直链必须带网易 Referer；第三方直链反过来绝不能带（会被上游当成盗链拒绝）。
   * 所以这个是 per-source 的，而不是全局一份。
   */
  upstreamHeaders?: Record<string, string>;
  /**
   * 本地文件（L4 本地源）在磁盘上的绝对路径。
   *
   * **同样只在主进程里流转**：媒体代理要用它去读文件，渲染进程只需要一个
   * `http://127.0.0.1:<port>/audio/<key>`，把本机路径发给网页是没必要的暴露。
   */
  localPath?: string;
  /** 官方对 VIP 歌曲只给试听片段时标记为 true——UI 必须如实告诉用户，不能假装是一首完整的歌。 */
  trial?: boolean;
}

/** 一次解析尝试的记录，用于 UI 上显示「这条歌是从哪来的」。 */
export interface ResolveAttempt {
  sourceId: SourceId;
  ok: boolean;
  /** 失败原因或跳过原因，直接面向排障。 */
  detail?: string;
  elapsedMs: number;
}

export interface ResolveResult {
  audio: ResolvedAudio | null;
  attempts: readonly ResolveAttempt[];
}

/* ------------------------------------------------------------------ *
 * 账号能力
 * ------------------------------------------------------------------ */

export interface AccountCapability {
  loggedIn: boolean;
  userId?: number;
  nickname?: string;
  avatarUrl?: string;
  vip: boolean;
  /** 网易云的 vipType：0 非会员，11 黑胶 VIP，10 音乐包等。 */
  vipType: number;
  /** 当前账号在**官方音源**上能拿到的最高等级。 */
  maxQuality: Quality;
  /** 该账号能否走第三方音源补齐无损（登录与否都允许，但需用户开关）。 */
  thirdPartyEnabled: boolean;
}

export const ANONYMOUS_CAPABILITY: AccountCapability = {
  loggedIn: false,
  vip: false,
  vipType: 0,
  maxQuality: 'higher',
  thirdPartyEnabled: true,
};

/* ------------------------------------------------------------------ *
 * 业务实体（与后端字段解耦的「我们自己的」模型）
 * ------------------------------------------------------------------ */

export interface ArtistRef {
  id: number;
  name: string;
}

export interface AlbumRef {
  id: number;
  name: string;
  coverUrl?: string;
}

export interface Song {
  id: number;
  name: string;
  artists: ArtistRef[];
  album?: AlbumRef;
  durationMs?: number;
  /** 是否可播放（网易云会下发版权状态，无版权时提前在 UI 上灰掉）。 */
  playable?: boolean;
  /** 该歌曲在网易云上可用的最高音质（用于灰化不可选的音质按钮）。 */
  maxQuality?: Quality;
}

export interface Playlist {
  id: number;
  name: string;
  coverUrl?: string;
  trackCount: number;
  creator?: string;
  /** 歌单简介（推荐歌单/私人雷达的副标题用它）。 */
  description?: string;
  /** 特殊歌单（我喜欢的音乐 / 最近播放等）的标记。 */
  specialType?: number;
  subscribed?: boolean;
}

/** yrc 行内一个「词」的逐字时间戳（LRC 只有行级时间戳，没有这个）。 */
export interface LyricWord {
  /** 相对歌曲开头的毫秒数。 */
  timeMs: number;
  /** 这个词唱多久；上游没给就由渲染层按字素均分。 */
  durationMs?: number;
  text: string;
}

export interface LyricLine {
  /** 相对歌曲开头的毫秒数。 */
  timeMs: number;
  text: string;
  /**
   * 这一行**真实**唱多久（毫秒）。
   *
   * 第十一轮第 1 条（用户 m03279「有和声的地方歌词进度不对」）：只有 yrc 的行首才带它
   * （`[开始毫秒,持续毫秒]`）。LRC 没有，渲染层就按「下一行的时间戳」推算——但和声行
   * 可能与主唱**同一时间戳**或**时间重叠**，那种推算会得到 0 或远小于真实长度的值，
   * 于是逐字点亮速度整体错位。有这个字段时以它为准。
   */
  durationMs?: number;
  /** yrc 的逐字时间戳；LRC 没有这个字段，渲染层退回「按行时长均分」。 */
  words?: LyricWord[];
}

export interface Lyrics {
  /** 逐行歌词（含翻译的合并结果）。 */
  lines: LyricLine[];
  /** 纯文本，作为解析失败时的兜底展示。 */
  raw: string;
  hasTranslation: boolean;
}

/**
 * 一首歌的歌词（`ncm:lyric` 通道的返回体）。
 *
 * `lines` 是原文、`translated` 是译文，两者各自按 `timeMs` 排好序、时间轴相互独立，
 * 渲染进程只要按播放进度找当前行即可，不需要自己做对齐。
 *
 * `hasLyric` 是**必填**的：上游对纯音乐/未收录的歌会回一份「合法但没有歌词」的响应，
 * 那不是错误。没有它，界面就只能靠 `lines.length` 猜「是没歌词还是还没加载出来」。
 */
export interface Lyric {
  lines: LyricLine[];
  translated: LyricLine[];
  hasLyric: boolean;
}

/** 评论作者。`avatarUrl` 已经过 CDN 尺寸参数与 https 升级（见 ncm-client 的 `coverUrl`）。 */
export interface CommentUser {
  id: number;
  nickname: string;
  avatarUrl?: string;
}

/** 被回复的那条评论。只留渲染进程要展示的两个字段，回复链再深也不展开。 */
export interface CommentReply {
  nickname: string;
  content: string;
}

export interface Comment {
  id: number;
  content: string;
  /** 毫秒时间戳 */
  time: number;
  likedCount: number;
  user: CommentUser;
  beReplied?: CommentReply[];
  location?: string;
}

export interface CommentPage {
  total: number;
  hasMore: boolean;
  /** 热门评论，只有第一页才有 */
  hot: Comment[];
  comments: Comment[];
}

export interface SearchResult {
  songs: Song[];
  playlists: Playlist[];
  artists: ArtistRef[];
  albums: AlbumRef[];
}

/* ------------------------------------------------------------------ *
 * 登录（二维码）
 * ------------------------------------------------------------------ */

export interface QrLoginTicket {
  /** 轮询用的 unikey。 */
  key: string;
  /** 二维码图片，形如 `data:image/png;base64,...`，渲染进程可直接填进 `<img src>`。 */
  image: string;
  /** 扫码链接。二维码图裂时的兜底，也方便用户复制到手机。 */
  url?: string;
}

/**
 * 二维码轮询状态码（网易云约定）：
 * 800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 授权成功。
 */
export type QrCheckCode = 800 | 801 | 802 | 803;

export interface QrLoginState {
  code: QrCheckCode;
  message?: string;
  /** 802/803 时后端会带昵称与头像，可即时给用户「是你吗」的反馈。 */
  nickname?: string;
  avatarUrl?: string;
}

/* ------------------------------------------------------------------ *
 * 曲库列表
 * ------------------------------------------------------------------ */

/** 带播放统计的歌曲（最近听过）。 */
export interface PlayedTrack {
  song: Song;
  playCount: number;
  /** 最后一次播放时间（ms epoch）。 */
  lastPlayedAt: number;
}

/** 分页歌曲列表。 */
export interface TrackPage {
  tracks: Song[];
  /** 后端给得出总数时才带（`/likelist` 能给出，`/playlist/track/all` 给不出）。 */
  total?: number;
  hasMore: boolean;
}

/* ------------------------------------------------------------------ *
 * 本地设置
 * ------------------------------------------------------------------ */

export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * 歌词动效主题（用户 m08768 第 4 条）。
 *
 * 六个键都对齐 folia-major 的目录名/模式名（`src/components/visualizer/<key>/`），
 * 方便以后对照它们的 `tuning.ts`：
 * `classic` 流光（folia 的默认主题，我们第六轮已复刻）、`fume` 浮名、`cadenza` 心象、
 * `partita` 云阶、`tilt` 倾诉、`pendolo` 时计。**只借鉴设计数值与做法（AGPL），不复制代码**。
 */
export type LyricTheme = 'classic' | 'fume' | 'cadenza' | 'partita' | 'tilt' | 'pendolo';

/**
 * 歌词动效的帧率上限档位。
 *
 * 120 / 90 / 60 是**上限**而不是目标帧率：显示器刷新率比它低时以显示器为准，
 * 因为 rAF 本来就不会快过刷新率。`off` = 不设限。
 */
export type LyricFpsCap = 'off' | '120' | '90' | '60';

/**
 * 歌词动效参数（用户「加一套和 folia 一样的歌词动效设置」）。
 *
 * folia 是**每个主题各有一套 tuning**；这里只抽出六套主题都吃得到的公共量，
 * 否则设置页会变成一张参数墙。取值的边界照抄 folia 的默认值——`1` 一律等于
 * 改造前的观感，这样老用户升级后画面不会莫名其妙变样。
 *
 * **每一个字段都必须真的改变画面**：只落盘不改观感的开关一概不收。
 */
export interface LyricTuning {
  /** 主题舞台的整体不透明度 0.4~1。classic（流光）一个像素都不动。 */
  themeOpacity: number;
  /** 字号倍率 0.8~1.3；各主题在自己的字号计算点上乘它。 */
  fontScale: number;
  /** 动效幅度 0.4~1.6；缩放「随机错落 / 飘移幅值」，`1` = 改造前的观感。 */
  motionAmount: number;
  /** 辉光强度 0~1.6；缩放 text-shadow 的模糊半径与透明度，默认 1.5（见下面默认值处的说明）。 */
  glowIntensity: number;
  /** 逐帧主题（fume / cadenza / pendolo / tilt）的帧率上限。 */
  fpsCap: LyricFpsCap;
  /**
   * 每首歌按 id 稳定地挑一套主题。
   *
   * **默认关**：舞台的 `data-theme` 必须等于设置里的 `lyricTheme`
   * （主进程冒烟就是这么核对的），随机只有在用户明确打开后才允许两者不一致。
   */
  randomThemePerSong: boolean;
  /**
   * 浮名（fume）的镜头追焦方式（用户 m05281 第 3 条）：
   * `smooth` = 弹簧插值跟住当前句（默认），`snap` = 定格式直跳（切句瞬间换机位）。
   */
  fumeCameraFollow: 'smooth' | 'snap';
  /** 浮名（fume）的镜头移动速度倍率 0.4~2.5；越大越跟手，`1` = 改造前的观感。 */
  fumeCameraSpeed: number;
  /** 流光（classic）的逐字旋转开关（用户 m05281 第 4 条）：字亮起时按行内位置轻微旋转。 */
  classicWordSpin: boolean;
  /** 云阶（partita）的引导线（十字细线）开关（用户 m05281 第 6 条）。 */
  partitaGuides: boolean;
  /** 云阶（partita）行错位的最小绝对值（px）；越接近最大值，行与行越对齐。 */
  partitaStaggerMin: number;
  /** 云阶（partita）行错位的最大绝对值（px）。 */
  partitaStaggerMax: number;
  /** 时计（pendolo）的轮盘半径占舞台短边的百分比 30~60（用户 m05281 第 7 条）。 */
  pendoloDialRadius: number;
  /** 时计（pendolo）歌词弧的张角（度）60~160。 */
  pendoloArcAngle: number;
  /** 时计（pendolo）的擒纵咬合力倍率 0.5~3：小齿轮转速与弹簧回弹的力度。 */
  pendoloEscapeForce: number;
  /** 时计（pendolo）当前焦点句的缩放 1~1.7。 */
  pendoloFocusScale: number;
  /** 时计（pendolo）表盘中心是否显示歌曲封面。 */
  pendoloCoverOnDial: boolean;
}

export const DEFAULT_LYRIC_TUNING: LyricTuning = {
  themeOpacity: 1,
  fontScale: 1,
  motionAmount: 1,
  /*
   * 辉光强度默认 `1.5`（用户第二十五轮第 1 条：「辉光的默认强度调到如图 1 所示」）。
   *
   * 那张图里的辉光又宽又亮（晕散半径约等于字高的三成、alpha 也高），比改造前的观感明显重，
   * 所以默认不再等于「改造前的 1」，而是取滑杆高位 1.5（上限是 1.6，留一档余量）。
   * 注意：**已经存过盘的 profile 不受影响** —— 默认值只在没存过 / 复位后才生效，
   * 想看这一档的效果要在设置里点一下复位键（或把滑杆拉过去）。
   */
  glowIntensity: 1.5,
  fpsCap: 'off',
  randomThemePerSong: false,
  fumeCameraFollow: 'smooth',
  fumeCameraSpeed: 1,
  classicWordSpin: true,
  partitaGuides: true,
  // 参考图 4 的读数就是 20px / 100px，也是改造前错落幅度的上下界。
  partitaStaggerMin: 20,
  partitaStaggerMax: 100,
  // 参考图 5 的读数 42% / 100° / 2.0x / 1.25x 与原实现一致。
  pendoloDialRadius: 42,
  pendoloArcAngle: 100,
  pendoloEscapeForce: 2,
  pendoloFocusScale: 1.25,
  pendoloCoverOnDial: true,
};

/** 音源层级（docs/ADR/0001-音源解析链.md 的链序）。 */
export type SourceTier = 'official' | 'unm' | 'aggregator' | 'lx' | 'local';

export interface Settings {
  theme: ThemeMode;
  /** 默认请求音质；实际会被账号能力与实测结果夹逼。 */
  preferredQuality: Quality;
  /**
   * 是否允许第三方音源兜底。
   *
   * **默认关闭**（docs/ADR/0001 第 6 条）：第三方源要用你的 IP 去别人的平台匹配音源，
   * 属于账号红线之外的风险，必须由用户明确开启。
   */
  enableThirdPartySources: boolean;
  /**
   * 用户是否已经读过并确认「开启第三方源」的风险提示。
   *
   * 与 `enableThirdPartySources` 是**与**关系：老版本设置里可能存着 true，
   * 但没确认过就不能真的启用。确认过一次后不再打扰。
   */
  thirdPartyAcknowledged: boolean;
  /** 当官方源拿不到无损时，是否允许第三方源补无损。 */
  allowThirdPartyLossless: boolean;
  /** 是否把播放记录回传网易云（/scrobble），默认开，尊重用户隐私时可关。 */
  scrobbleEnabled: boolean;
  /** 音量 0-1。 */
  volume: number;
  /** 播放模式；跟着设置一起持久化，重启后保持用户上次的选择。 */
  playMode: PlayMode;
  /** 下载目录；空表示使用默认目录。 */
  downloadDir: string;
  /**
   * 本地音乐文件夹（L4 本地源的曲库）；空表示不使用本地兜底。
   *
   * 责任链的最后一层：前面所有源都拿不到时，才会去这里按「歌名 + 歌手 + 时长」找。
   * 扫描只读文件名、不解析音频标签，所以路径填错最坏结果是「没有本地兜底」，不会坏事。
   */
  localLibraryDir: string;
  /** UI 语言。 */
  locale: 'zh-CN' | 'en';
  /** 播放器主页歌词用哪套动效主题（m08768 第 4 条）；设置页里选。 */
  lyricTheme: LyricTheme;
  /** 歌词动效的细调参数；和 `lyricTheme` 一样只影响歌词怎么画。 */
  lyricTuning: LyricTuning;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  preferredQuality: 'lossless',
  // 第三方源默认关闭——这是账号安全红线，不是默认值偏好。
  enableThirdPartySources: false,
  thirdPartyAcknowledged: false,
  allowThirdPartyLossless: true,
  scrobbleEnabled: true,
  volume: 0.8,
  playMode: 'order',
  downloadDir: '',
  // 默认不扫任何目录：本地曲库可能是几万首歌，未经用户指定不该去读磁盘。
  localLibraryDir: '',
  locale: 'zh-CN',
  // 默认还是 folia 的 classic（我们已经一比一复刻过的那套「流光」）。
  lyricTheme: 'classic',
  // 展开一份副本：`DEFAULT_SETTINGS` 与 `DEFAULT_LYRIC_TUNING` 是两个导出的常量，
  // 直接共享同一个对象会让「改默认值」和「改某次设置」互相串味。
  lyricTuning: { ...DEFAULT_LYRIC_TUNING },
};

/**
 * 一个音源在 UI 上的可见状态。
 *
 * 「这条歌到底是从哪来的」必须能回答，否则第三方源出问题时用户只会看到「播放失败」。
 */
export interface SourceStatus {
  id: SourceId;
  label: string;
  tier: SourceTier;
  /** 当前是否在链上（官方永远在；第三方取决于设置与健康度）。 */
  enabled: boolean;
  /** 是否依赖网易 cookie（只有官方为 true）。 */
  needsCookie: boolean;
  /** 能提供的档位。 */
  qualities: readonly Quality[];
  /** 连续失败次数（成功一次即清零）。 */
  consecutiveFailures: number;
  /** 被临时降权的到期时间（ms epoch）；未降权则无。 */
  demotedUntil?: number;
  /** 最近一次失败原因，直接给用户看。 */
  lastError?: string;
  /** 最近一次成功时间（ms epoch）。 */
  lastOkAt?: number;
  ok: number;
  /** 累计「这个源没有这首歌」。 */
  missed: number;
  /** 累计「有货但不够好」（试听片段、虚标降级）——和 missed 分开，排障方向不同。 */
  rejected: number;
}

/**
 * 一个已导入的自定义源插件（L3）的对外摘要。
 *
 * **不带脚本文本**：那份脚本可能几十 KB，UI 只需要知道「是谁、声明了哪些平台、开没开」。
 * 想看全文可以去数据目录里的 sources.plugins 存储项，或者重新导入一份。
 */
export interface LxPluginSummary {
  id: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
  /** 插件声明的平台（`kw|kg|tx|wy|mg` 的子集，按 LX 的键名）。 */
  sources: readonly string[];
  /** 是否启用。禁用的插件不参与解析，但保留在列表里。 */
  enabled: boolean;
  importedAt: number;
}

/**
 * 一条音质日志。
 *
 * 存在的唯一理由：**音源说的音质不算数**。第三方源普遍虚标（拿 128k 冒充 flac），
 * 探针的实测结果才是真的；把「要求什么 → 走了哪些源 → 最后实测到了什么」留成可查的记录，
 * 用户遇到「这歌明明是会员却只有 30 秒」「说是无损其实是 mp3」时不用截图求助。
 */
export interface QualityLogEntry {
  at: number;
  songId: number;
  title: string;
  /** 歌手拼接串（`、` 分隔），仅用于展示。 */
  artist?: string;
  /** 用户要求的档位（设置的「首选音质」）。 */
  requested: Quality;
  /** 最终采用的来源；全部失败时无。 */
  via?: SourceId;
  /** 最终实测档位（不是来源自称的那个）。 */
  quality?: Quality;
  /** 实测容器：flac/mp3/m4a/ogg/wav/unknown… */
  container?: string;
  sampleRate?: number;
  bitrate?: number;
  /** 是否只是试听片段。 */
  trial?: boolean;
  /** 该来源自称的档位（与实测不一致时，日志里能一眼看出被降级标注了）。 */
  claimed?: Quality;
  /** 总共花了多久（含所有失败源的白等时间）。 */
  elapsedMs: number;
  /** 完整尝试轨迹：每个源的成败与原因。 */
  attempts: readonly ResolveAttempt[];
}

/* ------------------------------------------------------------------ *
 * 运行时能力（跨环境可运行性，见 docs/PLAN.md §2.6）
 * ------------------------------------------------------------------ */

/** Electron `safeStorage` 的可用性。不可用时必须降级，绝不能因此启动失败。 */
export type SafeStorageStatus = 'available' | 'unavailable' | 'error';

/**
 * 运行平台。
 * 刻意不写 `NodeJS.Platform`——本包要被渲染进程引用，而渲染进程的 tsconfig
 * 不引入 @types/node（引入等于给渲染进程开 Node 类型后门）。
 */
export type PiPlatform = 'win32' | 'darwin' | 'linux' | (string & {});

export interface RuntimeInfo {
  platform: PiPlatform;
  arch: string;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  /** 数据目录（app.getPath('userData')）。 */
  userDataDir: string;
  safeStorage: SafeStorageStatus;
  /** 是否因渲染环境异常而回退到软件渲染。 */
  softwareRendering: boolean;
}
