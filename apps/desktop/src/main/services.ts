import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JsonFileDriver } from '@pi/store';
import { NcmServerHost, type NcmServerState } from '@pi/ncm-server';
import { NcmClient } from '@pi/ncm-client';
import {
  ResolverChain,
  SourceHealthRegistry,
  describeNonAudio,
  sniffContainer,
  type MusicSource,
} from '@pi/resolver';
import { createOfficialSource } from '@pi/source-official';
import { createUnmSource } from '@pi/source-unm';
import { LocalLibrary, createLocalSource, scanAudioDirectory } from '@pi/source-local';
import {
  LxHost,
  LxPluginStore,
  createLxSource,
  parseScriptMeta,
  pluginIdFor,
  type LxPlugin,
  type StoredLxPlugin,
} from '@pi/source-lx';
import { NEUTRAL_UPSTREAM_HEADERS } from '@pi/source-core';
import type { DownloadTask, LikeState, LocalLibraryList } from '@pi/ipc';
import {
  ANONYMOUS_CAPABILITY,
  DEFAULT_LYRIC_TUNING,
  DEFAULT_SETTINGS,
  clampQuality,
  qualityRank,
  type AccountCapability,
  type AudioProbe,
  type CommentPage,
  type LxPluginSummary,
  type Lyric,
  type QrCheckCode,
  type QrLoginState,
  type QrLoginTicket,
  type Quality,
  type QualityLogEntry,
  type ResolvedAudio,
  type ResolveAttempt,
  type SafeStorageStatus,
  type Settings,
  type Song,
  type SourceStatus,
} from '@pi/shared';
import { MediaServer } from './media-server.js';
import { DownloadsManager, findPlayableDownload } from './downloads.js';
import { listLocalLibrary } from './library.js';

/** 存储 key 集中在此，避免字符串散落各处拼错。 */
export const KEYS = {
  settings: 'settings.app',
  session: 'auth.session',
  profile: 'auth.profile',
  history: 'history.tracks',
  /** 用户导入的自定义源插件（L3）。与记录类数据分开，坏掉/删掉不影响播放历史。 */
  plugins: 'sources.plugins',
  /** 音质日志：最近若干次解析的实测结果。 */
  qualityLog: 'sources.qualityLog',
  /** 下载清单（M5）：任务状态 + 原始歌曲元信息，重启后据此对账与继续下载。 */
  downloads: 'downloads.tasks',
} as const;

/** 音质日志保留条数。够回答「刚才那首歌到底走了哪个源」，又不至于把文件写大。 */
export const QUALITY_LOG_LIMIT = 200;

/** 探针只读文件/响应的开头这么多字节：容器头都在最前面。 */
const PROBE_HEAD_BYTES = 64 * 1024;

/**
 * 已下载文件在播放链路里的来源 id。
 *
 * 它不是 `@pi/source-*` 里的任何音源：字节来自本地磁盘，与「在线解析到了哪个源」是两回事。
 * 音质日志里单独标出来，才能一眼看出「这次播的是下载好的文件」而不是某个源又活了。
 */
const DOWNLOAD_SOURCE_ID = 'download';

export interface StoredSession {
  /** 网易云登录 cookie（含 MUSIC_U）。属于敏感数据，只允许本地持有。 */
  cookie: string;
  updatedAt: number;
  encrypted: boolean;
}

/** 账号资料缓存。存下来是为了「离线/后端没起来时也能显示头像昵称」。 */
export interface StoredProfile {
  userId: number;
  nickname?: string;
  avatarUrl?: string;
  vip: boolean;
  vipType: number;
  updatedAt: number;
}

/**
 * 主进程侧的服务容器。
 *
 * 设计原则：**任何一个子服务失败都不能让应用起不来**（docs/PLAN.md §2.6）。
 * 内嵌 API 挂了 → 在线功能不可用但 UI 依旧可用；加密不可用 → 降级为明文存储并提示。
 */
export class Services {
  readonly store: JsonFileDriver;
  readonly ncmHost: NcmServerHost;
  readonly ncm: NcmClient;
  /** 本地音频代理：渲染进程的 `<audio>` 只认它给出的地址。 */
  readonly media: MediaServer;
  /** M5 下载管理器：下载队列 + 本地文件清单。 */
  readonly downloads: DownloadsManager;

  /** 同一首歌 + 同一音质在 TTL 内不重复解析（直链本身带时效，不能永久缓存）。 */
  private readonly audioCache = new Map<string, { audio: ResolvedAudio; cachedAt: number }>();
  /** mediaKey → 解析结果。代理只按 key 取值，渲染进程看不到上游地址与请求头。 */
  private readonly mediaEntries = new Map<string, ResolvedAudio>();
  /** 音源健康度：连续失败的源会被临时降权，避免每次点歌都在死源上白等超时（H8）。 */
  readonly sourceHealth = new SourceHealthRegistry();

  /**
   * L1 第三方聚合源（UNM）。
   *
   * 只构造一次：`allowLossless` 是个闭包，设置改了立刻生效，不需要重建对象。
   * 第三方源**永远不碰 cookie**（`needsCookie: false`），这是账号安全红线的一部分。
   */
  private readonly unmSource = createUnmSource({
    allowLossless: () =>
      this.settingsCache?.allowThirdPartyLossless ?? DEFAULT_SETTINGS.allowThirdPartyLossless,
    log: (message, detail) => console.warn(message, detail),
  });

  /**
   * L3 自定义源沙箱池。
   *
   * 单独持有：导入/禁用/删除插件时要能精确地杀掉某个插件对应的子进程，
   * 而不是把整个音源对象重建（那样会连带清掉音频缓存与健康度）。
   */
  private readonly lxHost = new LxHost({ log: (message) => console.warn(message) });

  /**
   * L3 自定义源（LX 协议插件）。
   *
   * `plugins` 是**函数**：用户随时导入/禁用插件，而音源对象是长生命周期的。
   * 只构造一次，插件列表每次解析时现取。
   */
  private readonly lxSource = createLxSource({
    plugins: () => this.enabledLxPlugins(),
    host: this.lxHost,
    log: (message) => console.warn(message),
  });

  private readonly pluginStore: LxPluginStore;
  /** 已导入插件的内存副本（含脚本文本）。init() 里从磁盘加载。 */
  private lxPlugins: StoredLxPlugin[] | undefined;
  /** 音质日志环形缓冲（最新在前）。 */
  private qualityLog: QualityLogEntry[] = [];

  /**
   * L4 本地源（最后的兜底）。
   *
   * `library` 同样是**函数**：用户随时可能换文件夹或重扫。曲库为空时
   * `buildSources` 不会把它放进链（一个必然返回 null 的站点只会白占一次尝试记录）。
   */
  private readonly localSource = createLocalSource({
    library: () => this.localLibrary,
    log: (message, detail) => console.warn(message, detail),
  });
  /** 本地曲库的内存副本；扫描只读文件名，不含音频标签。 */
  private localLibrary = new LocalLibrary([]);

  private settingsCache: Settings | undefined;
  private session: StoredSession | undefined;
  private profile: StoredProfile | undefined;
  private capability: AccountCapability | undefined;
  private safeStorageStatus: SafeStorageStatus = 'unavailable';
  private readonly accountListeners = new Set<(capability: AccountCapability) => void>();
  /**
   * 只用于诊断：二维码状态的变化点。
   *
   * 「扫码后一直没反应」有两种完全不同的成因——手机没扫上（一直是 801），
   * 或者扫上了但没在手机上点确认（802）。只看界面分不出来，日志里差一行就清楚了。
   */
  private lastQrCode: QrCheckCode | undefined;

  constructor() {
    const userDataDir = app.getPath('userData');
    this.store = new JsonFileDriver({ baseDir: path.join(userDataDir, 'data') });
    this.pluginStore = new LxPluginStore(this.store, KEYS.plugins);

    this.ncmHost = new NcmServerHost({
      onStateChange: (state: NcmServerState) => {
        console.info(`[pi/ncm] 状态：${state.status}${state.port ? ` :${state.port}` : ''}`);
      },
    });

    this.ncm = new NcmClient({
      getBaseUrl: () => this.ncmHost.baseUrl,
      getCookie: () => this.session?.cookie,
    });

    this.media = new MediaServer({
      lookup: (key) => this.lookupMedia(key),
      upstreamHeaders: NEUTRAL_UPSTREAM_HEADERS,
      log: (message, detail) => console.warn(message, detail),
    });

    // M5 下载管理器。目录、音质夹逼、直链解析全部由 Services 注入：
    // 管理器自己不 import electron，也不碰 cookie，因此可以在 vitest 里被完整测到。
    this.downloads = new DownloadsManager({
      store: this.store,
      storeKey: KEYS.downloads,
      resolveDir: () => this.downloadDir(),
      pickQuality: async (_song, level) => {
        const [settings, capability] = await Promise.all([
          this.getSettings(),
          this.getCapability(),
        ]);
        // 下载的音质同样要被账号能力夹逼：非 VIP 点「无损」只会下回一段试听。
        return clampQuality(level ?? settings.preferredQuality, capability.maxQuality);
      },
      resolve: (song, downloadLevel) => this.resolveRemote(song, downloadLevel),
      beforeResolve: async () => {
        // 下载走的是和播放同一条责任链，官方源没起来时先等一会儿；
        // 等不到也不算失败——第三方源（和本地源）还在链上。
        await this.ensureNcmReady();
      },
      log: (message, detail) => console.warn(message, detail),
    });
  }

  async init(): Promise<void> {
    this.safeStorageStatus = probeSafeStorage();
    await this.store.warmup(['settings', 'auth', 'history', 'sources', 'downloads']);
    await this.loadProfile();
    await this.loadSession();
    await this.loadPlugins();
    await this.loadQualityLog();
    await this.loadLocalLibrary();
    // 下载清单要在窗口出来之前读完并对完账：界面第一帧就得是真状态，
    // 而不是先显示一串「已下载」、过一会儿又跳成「文件不见了」。
    await this.downloads.init();
    // 内嵌 API 启动失败不能阻塞界面，因此不 await 它的成功，只 await 它「不再挂起」。
    void this.ncmHost.start().catch((err: unknown) => {
      console.error('[pi/ncm] 启动内嵌 API 失败：', err);
    });
    void this.media
      .start(mediaPort())
      .then(() => {
        console.info(`[pi/media] 本地音频代理：${this.media.baseUrl}`);
      })
      .catch((err: unknown) => {
        console.error('[pi/media] 启动本地音频代理失败：', err);
      });
  }

  async getSettings(): Promise<Settings> {
    if (this.settingsCache) return this.settingsCache;
    const stored = await this.store.get<Partial<Settings>>(KEYS.settings);
    // 合并默认值：新版本新增的设置项对老用户自动生效。
    //
    // `lyricTuning` 要**逐字段**再兜一层：它是个嵌套对象，老设置文件里整个键都不存在，
    // 浅合并到那一层就够了；但如果哪天版本升级往里加了新字段，老用户盘上存着的
    // 那份 `lyricTuning` 就只有旧字段——浅合并会把新字段留成 `undefined`，
    // 一路传到渲染层变成 `NaN` 度量（字号/幅度全是乘法），画面直接坏掉。
    // 不用 zod 的 `.default()` 做这件事：`SettingsSchema.partial()` 在 zod 4 里
    // 不会吃掉子对象默认值，改音量也会顺手把动效参数打回默认（见 LyricTuningSchema 的注释）。
    const merged: Settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
    this.settingsCache = {
      ...merged,
      lyricTuning: { ...DEFAULT_LYRIC_TUNING, ...(stored?.lyricTuning ?? {}) },
    };
    return this.settingsCache;
  }

  async patchSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.getSettings();
    const next: Settings = { ...current, ...patch };
    this.settingsCache = next;
    await this.store.set(KEYS.settings, next);
    // 设置一变，解析缓存必须作废：用户刚把「第三方音源」关掉，
    // 之前缓存的第三方地址还在的话，接下来几分钟里听起来就像开关没生效。
    this.audioCache.clear();
    // 换了本地音乐文件夹就得重扫曲库；否则新目录要等下次启动才生效。
    if (patch.localLibraryDir !== undefined && next.localLibraryDir !== current.localLibraryDir) {
      await this.loadLocalLibrary(next.localLibraryDir);
    }
    return next;
  }

  /**
   * 扫描本地音乐文件夹（L4）。
   *
   * 这是纯粹的增强：路径为空、目录不存在、权限不足，都只是「没有本地兜底」，
   * 绝不能让设置保存失败或播放报错——所以扫描出的异常在这里就地消化成空曲库 + 日志。
   */
  private async loadLocalLibrary(dir?: string): Promise<void> {
    const target = (dir ?? (await this.getSettings()).localLibraryDir).trim();
    if (target === '') {
      this.localLibrary = new LocalLibrary([]);
      return;
    }
    const tracks = await scanAudioDirectory(target, {
      onWarn: (message, detail) => console.warn(`[pi/source-local] ${message}`, detail),
    });
    this.localLibrary = new LocalLibrary(tracks);
    console.info(`[pi/source-local] 本地曲库 ${tracks.length} 首（${target}）`);
  }

  /**
   * 「本地库」页要的清单（`library:list`）。
   *
   * 和上面那份启动缓存不同：这里**每次调用都重扫**。理由是页面语义——
   * 用户往目录里丢了几首新歌、或者干脆把目录改名/删掉了，刷新一下就该看到真状态；
   * 用启动时的旧清单反而会显示一堆已经不存在的文件。
   *
   * 顺带把内部曲库换成刚扫出来的这份：L4 本地兜底音源与「本地库」页必须看到同一份清单，
   * 否则会出现「页面上有、播不出来」这种最让人困惑的状态。
   * 目录为空 / 不存在 / 读不了一律返回空清单，**不抛错**。
   */
  async libraryList(): Promise<LocalLibraryList> {
    const dir = (await this.getSettings()).localLibraryDir;
    const result = await listLocalLibrary(dir, {
      onWarn: (message, detail) => console.warn(`[pi/source-local] ${message}`, detail),
    });
    this.localLibrary = new LocalLibrary(result.tracks);
    return result;
  }

  /**
   * 确保内嵌 API 可用；最多等待 timeoutMs。
   * 用于「用户点了搜索」这种可以稍微等一下的场景。
   */
  async ensureNcmReady(timeoutMs = 25_000): Promise<boolean> {
    const state = this.ncmHost.getState();
    if (state.status === 'ready') return true;
    if (state.status === 'error') return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = this.ncmHost.getState();
      if (now.status === 'ready') return true;
      if (now.status === 'error') return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.ncmHost.getState().status === 'ready';
  }

  getNcmState(): NcmServerState {
    return this.ncmHost.getState();
  }

  getSafeStorageStatus(): SafeStorageStatus {
    return this.safeStorageStatus;
  }

  /* ---------------------------------------------------------------- *
   * 账号能力
   * ---------------------------------------------------------------- */

  /**
   * 当前账号能力（是否登录、昵称头像、VIP、官方音质上限）。
   *
   * 结论会被缓存：这个值会被 UI 多处读取，不能每次都发网络请求。
   * 登录/登出会显式 `force` 刷新。
   */
  async getCapability(force = false): Promise<AccountCapability> {
    const settings = await this.getSettings();
    if (!this.session) {
      return { ...ANONYMOUS_CAPABILITY, thirdPartyEnabled: settings.enableThirdPartySources };
    }
    if (this.capability && !force) return this.capability;
    const capability = await this.loadCapability(settings);
    this.capability = capability;
    return capability;
  }

  private async loadCapability(settings: Settings): Promise<AccountCapability> {
    // loggedIn 不在这里写死：只有真拿到账号资料才算登录成功。
    // （内嵌 API 的匿名注册账号也会返回资料，ncm.account() 已把那种情况过滤掉。）
    const base: AccountCapability = {
      ...ANONYMOUS_CAPABILITY,
      thirdPartyEnabled: settings.enableThirdPartySources,
    };
    await this.ensureNcmReady(5_000);

    let profile = this.profile;
    if (this.ncmHost.getState().status === 'ready') {
      try {
        const fresh = await this.ncm.account();
        if (fresh) {
          profile = {
            ...fresh,
            vip: profile?.vip ?? false,
            updatedAt: Date.now(),
          };
        } else {
          // profile 为 null 通常意味着 cookie 已失效，但网络抖动也可能走到这里，
          // 所以只警告不自动登出——避免一次断网把用户踢下线。
          console.warn('[pi/auth] 后端未返回账号资料，可能 cookie 已失效');
        }
      } catch (err) {
        console.warn('[pi/auth] 拉取账号资料失败，先使用本地缓存：', err);
      }
      if (profile) {
        const vipInfo = await this.ncm.vipInfo(profile.userId).catch(() => undefined);
        if (vipInfo) {
          profile = {
            ...profile,
            vip: vipInfo.vip,
            vipType: vipInfo.vip ? vipInfo.vipType : profile.vipType,
          };
        }
      }
    }

    if (profile && profileChanged(profile, this.profile)) {
      await this.saveProfile(profile);
    }
    const vip = profile?.vip ?? false;
    return {
      ...base,
      loggedIn: profile !== undefined,
      ...(profile
        ? {
            userId: profile.userId,
            ...(profile.nickname ? { nickname: profile.nickname } : {}),
            ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
          }
        : {}),
      vip,
      vipType: profile?.vipType ?? 0,
      maxQuality: this.maxQualityFor(vip),
    };
  }

  /** 当前账号在官方音源上的音质上限。非 VIP 走到「极高」，VIP 放行到超清母带。 */
  maxQualityFor(vip: boolean): Quality {
    return vip ? 'jymaster' : 'exhigh';
  }

  getCookie(): string | undefined {
    return this.session?.cookie;
  }

  /** 需要登录的操作统一从这里取 uid，未登录时抛出面向用户的可读错误。 */
  async requireUserId(): Promise<number> {
    const capability = await this.getCapability();
    if (!capability.loggedIn || capability.userId === undefined) {
      throw new Error('这个功能需要先登录网易云账号。');
    }
    return capability.userId;
  }

  /** 订阅账号能力变化（登录成功、登出）。返回取消订阅函数。 */
  onAccountChanged(listener: (capability: AccountCapability) => void): () => void {
    this.accountListeners.add(listener);
    return () => {
      this.accountListeners.delete(listener);
    };
  }

  private emitAccount(capability: AccountCapability): void {
    for (const listener of this.accountListeners) {
      try {
        listener(capability);
      } catch (err) {
        console.error('[pi/auth] 账号事件监听器抛错：', err);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 二维码登录
   * ---------------------------------------------------------------- */

  /** 取一张新二维码。每次打开登录弹窗都应重新调用——旧二维码会过期。 */
  async createQrTicket(): Promise<QrLoginTicket> {
    const ready = await this.ensureNcmReady();
    if (!ready) {
      throw new Error('内嵌网易云 API 尚未就绪，暂时无法登录。可在日志中查看 [pi/ncm] 的输出。');
    }
    const key = await this.ncm.loginQrKey();
    this.lastQrCode = undefined;
    const { image, url } = await this.ncm.loginQrCreate(key);
    return { key, image, ...(url ? { url } : {}) };
  }

  /**
   * 轮询扫码状态。803 时把 cookie 落盘、刷新能力、广播事件，一步做完，
   * 这样渲染进程不需要（也拿不到）cookie 本身。
   */
  async checkQr(key: string): Promise<QrLoginState> {
    const res = await this.ncm.loginQrCheck(key);
    const code = normalizeQrCode(res.code);
    if (this.lastQrCode !== code) {
      this.lastQrCode = code;
      console.info(`[pi/auth] 二维码状态：${code}${res.message ? `（${res.message}）` : ''}`);
    }
    if (code !== 803 || !res.cookie) {
      return {
        code,
        ...(res.message ? { message: res.message } : {}),
        ...(res.nickname ? { nickname: res.nickname } : {}),
        ...(res.avatarUrl ? { avatarUrl: res.avatarUrl } : {}),
      };
    }

    // cookie 只在这里出现一次，立刻加密落盘；它绝不进入渲染进程。
    await this.saveSession(res.cookie);
    this.profile = undefined;
    this.capability = undefined;
    const capability = await this.getCapability(true);
    this.emitAccount(capability);
    return {
      code,
      ...(capability.nickname ? { nickname: capability.nickname } : {}),
      ...(capability.avatarUrl ? { avatarUrl: capability.avatarUrl } : {}),
    };
  }

  async logout(): Promise<AccountCapability> {
    await this.clearSession();
    this.profile = undefined;
    this.capability = undefined;
    await this.store.delete(KEYS.profile);
    const capability = await this.getCapability(true);
    this.emitAccount(capability);
    return capability;
  }

  /* ---------------------------------------------------------------- *
   * 登录态持久化
   * ---------------------------------------------------------------- */

  /**
   * 保存登录 cookie。
   * `safeStorage` 不可用时（常见于缺少 keyring 的 Linux 桌面）**降级为明文 +
   * 本地混淆**，而不是抛错——否则这些环境的应用会直接不可用。
   */
  async saveSession(cookie: string): Promise<void> {
    const canEncrypt = this.safeStorageStatus === 'available';
    /**
     * 内存里必须留**明文**：`getCookie()` 把它当作 cookie 头发给内嵌 API，
     * 发密文过去只会被当成无效 cookie，于是后端退回匿名账号——表现得就像
     * 「扫码成功了但界面毫无反应」。加密只针对落盘的那份副本。
     * （`loadSession()` 本来就是解密后再放进内存的，这里原先漏了同样一步。）
     */
    this.session = { cookie, updatedAt: Date.now(), encrypted: canEncrypt };
    await this.store.set(KEYS.session, {
      ...this.session,
      cookie: canEncrypt ? encrypt(cookie) : cookie,
    });
  }

  async clearSession(): Promise<void> {
    this.session = undefined;
    await this.store.delete(KEYS.session);
  }

  private async loadProfile(): Promise<void> {
    const stored = await this.store.get<StoredProfile>(KEYS.profile);
    if (stored && typeof stored.userId === 'number') this.profile = stored;
  }

  private async saveProfile(profile: StoredProfile): Promise<void> {
    this.profile = { ...profile, updatedAt: Date.now() };
    await this.store.set(KEYS.profile, this.profile);
  }

  private async loadSession(): Promise<void> {
    const stored = await this.store.get<StoredSession>(KEYS.session);
    if (!stored) return;
    if (stored.encrypted) {
      const decrypted = decrypt(stored.cookie);
      if (decrypted === undefined) {
        console.warn('[pi/auth] 已保存的登录信息无法解密，将要求重新登录');
        await this.store.delete(KEYS.session);
        return;
      }
      this.session = { ...stored, cookie: decrypted };
      return;
    }
    this.session = stored;
  }

  /* ---------------------------------------------------------------- *
   * 播放解析（M2）
   * ---------------------------------------------------------------- */

  /**
   * 责任链的音源列表（docs/ADR/0001-音源解析链.md 的链序）。
   *
   * L0 官方永远在第一位：它是唯一能用 cookie、唯一有官方版权信息的源。
   * L1/L2/L3 第三方源要等 `enableThirdPartySources` 打开才入链——
   * 「第三方源默认关闭、首次启用需二次确认」是账号安全红线（PLAN §2.5），不是默认值偏好。
   */
  private buildSources(settings: Settings): MusicSource[] {
    const sources: MusicSource[] = [buildOfficialSource(this.ncm)];
    if (thirdPartyEnabled(settings)) {
      // 链序按 ADR-0001：L1 内置聚合在前，L3 用户脚本在后。
      // 自定义源是用户自己的脚本，可信度最低，只有内置源都拿不到东西时才轮到它。
      sources.push(this.unmSource);
      if (this.enabledLxPlugins().length > 0) sources.push(this.lxSource);
    }
    // L4 本地文件永远在最后：它不需要联网也不需要授权，但**只该在别的源都没辙时**才用。
    // 用户硬盘上的同名文件不该抢在官方音源前面（那会让人以为在线音源失效了）。
    if (this.localLibrary.size > 0) sources.push(this.localSource);
    return sources;
  }

  /** 所有**候选**音源（含当前未启用的），供设置页展示与手动恢复健康度。 */
  private candidateSources(): MusicSource[] {
    const sources: MusicSource[] = [buildOfficialSource(this.ncm), this.unmSource, this.localSource];
    if (this.lxPlugins !== undefined) sources.push(this.lxSource);
    return sources;
  }

  /**
   * 音源列表 + 健康度快照（M2.5 H7/H8）。
   *
   * `buildOfficialSource` 每次返回一个新的轻对象（它无状态），这样「候选列表」与
   * 「真正入链的列表」用同一个构造函数，避免两处漂移。
   */
  async listSources(): Promise<SourceStatus[]> {
    const settings = await this.getSettings();
    const activeIds = new Set(this.buildSources(settings).map((source) => source.id));
    const health = new Map(this.sourceHealth.snapshot().map((item) => [item.sourceId, item]));
    return this.candidateSources().map((source) => {
      const state = health.get(source.id);
      return {
        id: source.id,
        label: source.label,
        tier: source.tier,
        enabled: activeIds.has(source.id),
        needsCookie: source.needsCookie,
        qualities: [...source.qualities],
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        ...(state?.demotedUntil !== undefined ? { demotedUntil: state.demotedUntil } : {}),
        ...(state?.lastError !== undefined ? { lastError: state.lastError } : {}),
        ...(state?.lastOkAt !== undefined ? { lastOkAt: state.lastOkAt } : {}),
        ok: state?.ok ?? 0,
        missed: state?.missed ?? 0,
        rejected: state?.rejected ?? 0,
      };
    });
  }

  /** 当前是否有第三方源真的会入链（播放通道用它决定「官方没起来」时是直接报错还是继续）。 */
  async hasEnabledThirdPartySource(): Promise<boolean> {
    return thirdPartyEnabled(await this.getSettings());
  }

  /** 「重试这个音源」：清掉降权与错误，下一次点歌会重新尝试它。 */
  async resetSourceHealth(sourceId?: string): Promise<SourceStatus[]> {
    this.sourceHealth.reset(sourceId);
    return this.listSources();
  }

  /* ---------------------------------------------------------------- *
   * 自定义源插件（L3，M2.5 H4）
   * ---------------------------------------------------------------- */

  private async loadPlugins(): Promise<void> {
    try {
      this.lxPlugins = await this.pluginStore.load();
      if (this.lxPlugins.length > 0) {
        const enabled = this.lxPlugins.filter((plugin) => plugin.enabled).length;
        console.info(`[pi/source-lx] 已加载 ${this.lxPlugins.length} 个自定义源插件（启用 ${enabled} 个）`);
      }
    } catch (error) {
      // 插件存储坏了不能拖垮应用：当作「没有插件」，播放照常。
      this.lxPlugins = [];
      console.warn('[pi/source-lx] 插件列表读取失败，本次按没有插件处理：', error);
    }
  }

  /**
   * 入链用的插件（只挑启用的）。
   *
   * 同步：责任链在解析热路径上，不能为了拿插件列表去 await 一次磁盘。
   */
  private enabledLxPlugins(): LxPlugin[] {
    return (this.lxPlugins ?? [])
      .filter((plugin) => plugin.enabled)
      .map((plugin) => ({ id: plugin.id, script: plugin.script, name: plugin.name }));
  }

  async listPlugins(): Promise<LxPluginSummary[]> {
    const stored = this.lxPlugins ?? (await this.pluginStore.load());
    this.lxPlugins = stored;
    return stored.map((plugin) => ({ ...summarizePlugin(plugin) }));
  }

  /**
   * 导入一份自定义源脚本。
   *
   * **导入时会真的在沙箱里跑一次**：语法错误、或者声明的平台一个都不认识，
   * 都应该在这一刻告诉用户，而不是等他点歌时才失败（那时他只会看到「播放失败」）。
   * 同一个脚本重复导入是幂等的（按脚本文本哈希去重）。
   */
  async importPlugin(script: string, name?: string): Promise<LxPluginSummary[]> {
    const id = pluginIdFor(script);
    const stored = this.lxPlugins ?? [];
    if (stored.some((plugin) => plugin.id === id)) {
      console.info('[pi/source-lx] 这份脚本已经导入过了，忽略重复导入');
      return this.listPlugins();
    }

    const meta = parseScriptMeta(script);
    const displayName = name?.trim() || meta.name;
    const info = await this.lxHost.load({ id, script, name: displayName });
    const declaredSources = Object.keys(info.sources);
    const next: StoredLxPlugin[] = [
      ...stored,
      {
        id,
        name: displayName,
        script,
        enabled: true,
        importedAt: Date.now(),
        declaredSources,
      },
    ];
    this.lxPlugins = next;
    await this.pluginStore.save(next);
    console.info(
      `[pi/source-lx] 已导入插件「${displayName}」（${declaredSources.join('/')}），默认启用`,
    );
    return this.listPlugins();
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<LxPluginSummary[]> {
    const stored = this.lxPlugins ?? [];
    const next = stored.map((plugin) => (plugin.id === id ? { ...plugin, enabled } : plugin));
    this.lxPlugins = next;
    await this.pluginStore.save(next);
    // 禁用后立刻收掉它的子进程：不然那个沙箱会一直挂着，内存白占。
    if (!enabled) await this.stopPlugin(id);
    return this.listPlugins();
  }

  async removePlugin(id: string): Promise<LxPluginSummary[]> {
    const next = (this.lxPlugins ?? []).filter((plugin) => plugin.id !== id);
    this.lxPlugins = next;
    await this.pluginStore.save(next);
    await this.stopPlugin(id);
    return this.listPlugins();
  }

  private async stopPlugin(id: string): Promise<void> {
    try {
      await this.lxHost.stopPlugin(id);
    } catch (error) {
      console.warn('[pi/source-lx] 关闭插件沙箱失败：', error);
    }
  }

  /* ---------------------------------------------------------------- *
   * 歌曲评论与「喜欢」（M3 / M4）
   * ---------------------------------------------------------------- */

  /** 歌曲评论。**不需要登录**：未登录也该能看评论，这是「先看评论再决定听不听」的常见路径。 */
  async songComments(songId: number, offset = 0, limit = 20): Promise<CommentPage> {
    return this.ncm.comments(songId, offset, limit);
  }

  /**
   * 歌曲歌词（`/lyric/new`）。
   *
   * **不需要登录**——和看评论是同一个理由：未登录也该能看歌词。
   * 这里如实转发上游的 `hasLyric`，不把「这首歌本来就没歌词」包装成错误。
   */
  async songLyric(songId: number): Promise<Lyric> {
    return this.ncm.lyric(songId);
  }

  /**
   * 喜欢 / 取消喜欢。
   *
   * 返回这首歌**最新**的状态，而不是「操作成功」的布尔值：取消喜欢之后渲染进程要立刻
   * 刷新心形图标，让它再发一次 `ncm:like-check` 只是白多一次往返。
   *
   * 未登录在这里就抛错（`requireUserId`），不会静默变成「提示成功了但其实没生效」。
   */
  async setSongLiked(songId: number, like: boolean): Promise<LikeState> {
    await this.requireUserId();
    await this.ncm.like(songId, like);
    return { liked: await this.ncm.likedSongIds([songId]) };
  }

  /** 批量查「这些歌里哪些已经喜欢」。同样需要登录——这个接口靠 cookie 认人。 */
  async checkSongsLiked(songIds: readonly number[]): Promise<LikeState> {
    await this.requireUserId();
    return { liked: await this.ncm.likedSongIds(songIds) };
  }

  /* ---------------------------------------------------------------- *
   * 音质日志（M2.5 H7「音质以实测为准」）
   * ---------------------------------------------------------------- */

  async qualityLogEntries(): Promise<QualityLogEntry[]> {
    return [...this.qualityLog];
  }

  private async loadQualityLog(): Promise<void> {
    try {
      const stored = await this.store.get<QualityLogEntry[]>(KEYS.qualityLog);
      this.qualityLog = Array.isArray(stored) ? stored.slice(0, QUALITY_LOG_LIMIT) : [];
    } catch (error) {
      this.qualityLog = [];
      console.warn('[pi/player] 音质日志读取失败，本次从空开始：', error);
    }
  }

  /**
   * 记一条音质日志。
   *
   * 失败只记日志不抛：它是诊断设施，用户点歌不该因为它写不进去而失败。
   */
  private async recordQualityLog(entry: QualityLogEntry): Promise<void> {
    this.qualityLog = [entry, ...this.qualityLog].slice(0, QUALITY_LOG_LIMIT);
    try {
      await this.store.set(KEYS.qualityLog, this.qualityLog);
    } catch (error) {
      console.warn('[pi/player] 音质日志写入失败：', error);
    }
  }

  /** 所有已导入插件（含脚本文本）——给日志与排障用，不发给渲染进程。 */
  listAllPlugins(): StoredLxPlugin[] {
    return [...(this.lxPlugins ?? [])];
  }

  /**
   * 把一首歌解析成「渲染进程能播的地址」。
   *
   * 分工：解析链与字节嗅探都留在主进程（需要 cookie 与 Referer），
   * 渲染进程拿到的是一个不带任何上游信息、带随机 token 的本地代理地址。
   */
  async resolveForPlayback(
    song: Song,
    level?: Quality,
  ): Promise<{ audio: ResolvedAudio | null; attempts: ResolveAttempt[]; src?: string }> {
    const [settings, capability] = await Promise.all([this.getSettings(), this.getCapability()]);
    // 期望音质必须被账号能力夹逼：非 VIP 直接请求 lossless，官方只会给试听片段。
    const effective = clampQuality(level ?? settings.preferredQuality, capability.maxQuality);

    // ---- M5：离线优先 ----
    // 下载好的文件就躺在磁盘上：它不受断网、上游直链过期、会员到期的影响，
    // 是整个播放链路里唯一「一定能播」的来源，所以放在责任链**之前**。
    //
    // 唯一的例外是「已下载的档位比这次请求的低」（下了 320k、这次想听无损）：
    // 这时先试在线解析，解析不到再退回本地文件 —— 不为了图快而偷偷降质。
    const downloaded = findPlayableDownload(this.downloads.list(), song.id);
    if (downloaded && qualityRank(downloaded.quality) >= qualityRank(effective)) {
      const offline = await this.downloadedAudio(downloaded);
      if (offline) {
        console.info(
          `[pi/player] 命中已下载文件，离线播放：${downloaded.name}（${downloaded.quality}）`,
        );
        return this.publish(offline, []);
      }
    }

    const { audio, attempts } = await this.resolveRemote(song, effective);
    if (audio) return this.publish(audio, attempts);

    // 在线一个源都没解析到（断网 / 上游全挂）：此刻已下载的那份文件就是最好的结果。
    // 状态照实推给界面 —— attempts 里全是失败记录，音质日志也会写 via=download。
    if (downloaded) {
      const offline = await this.downloadedAudio(downloaded);
      if (offline) {
        console.warn(
          `[pi/player] 在线解析失败，退回已下载文件：${downloaded.name}（${downloaded.quality}）`,
        );
        return this.publish(offline, attempts);
      }
    }
    return { audio: null, attempts };
  }

  /**
   * 走音源责任链解析（不含离线兜底，也不 publish）。
   *
   * 播放与下载共用同一条链与同一份音频缓存，但**各自决定怎么用结果**：
   * 播放要经过本地代理（`publish`），下载要的是上游地址 + 回源请求头（只有主进程拿得到）。
   */
  private async resolveRemote(
    song: Song,
    level: Quality,
  ): Promise<{ audio: ResolvedAudio | null; attempts: ResolveAttempt[] }> {
    const settings = await this.getSettings();
    const cacheKey = `${song.id}:${level}`;

    const cached = this.audioCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < AUDIO_CACHE_TTL_MS) {
      return { audio: cached.audio, attempts: [] };
    }

    const chain = new ResolverChain(
      this.buildSources(settings),
      (audio, signal) => probeRemote(audio, signal, song.durationMs),
      {
        perSourceTimeoutMs: 8000,
        health: this.sourceHealth,
        onAttempt: (attempt) => {
          console.info(
            `[pi/player] ${attempt.sourceId} ${attempt.ok ? '✓' : '✗'} ${attempt.detail ?? ''}（${attempt.elapsedMs}ms）`,
          );
        },
      },
    );

    const { audio, attempts } = await chain.resolve({
      songId: song.id,
      quality: level,
      title: song.name,
      artists: song.artists.map((artist) => artist.name),
      ...(song.durationMs !== undefined ? { durationMs: song.durationMs } : {}),
    });

    // 音质日志：记「要求什么 → 走了哪些源 → 最后实测到什么」。
    // 这是回答「为什么这首会员歌只有 30 秒」「为什么说是无损却是 mp3」的唯一凭据。
    await this.recordQualityLog(buildQualityLogEntry({ song, requested: level, audio, attempts }));

    if (!audio) return { audio: null, attempts: [...attempts] };
    this.audioCache.set(cacheKey, { audio, cachedAt: Date.now() });
    return { audio, attempts: [...attempts] };
  }

  /**
   * 把一条已完成的下载记录变成可播的 `ResolvedAudio`。
   *
   * 关键在于 `localPath`：本地代理（`media-server.ts` 的 `pipeFile`）会直接按 Range
   * 从磁盘读这个文件，**完全不碰网络** —— 「下载完后断网仍可播放」就落在这里。
   *
   * 探针照常读一遍文件头：界面上显示的容器与码率必须来自实测，
   * 而不是下载时那个「我们请求了什么」的档位。
   */
  private async downloadedAudio(task: DownloadTask): Promise<ResolvedAudio | undefined> {
    try {
      const probe = await probeLocalFile(task.filePath);
      return {
        url: pathToFileURL(task.filePath).href,
        quality: task.quality,
        probe,
        via: DOWNLOAD_SOURCE_ID,
        localPath: task.filePath,
      };
    } catch (err) {
      console.warn(`[pi/downloads] 已下载文件读不出来（${task.filePath}）：`, err);
      return undefined;
    }
  }

  /**
   * 本次下载写到哪个目录。
   *
   * 设置为空 = 用默认目录：系统音乐目录下的 `PI 下载`，而不是 app 的 userData。
   * 下载好的文件是**用户自己的音乐**，应该能在资源管理器/音乐库里看见，
   * 不该藏在 AppData 里。
   *
   * 改设置只影响之后的下载：已经在下的任务按原路径写完，不半路搬家
   * （搬一半会留下一个谁也对不上的孤儿文件）。
   */
  private async downloadDir(): Promise<string> {
    const configured = (await this.getSettings()).downloadDir.trim();
    if (configured !== '') return configured;
    try {
      return path.join(app.getPath('music'), 'PI 下载');
    } catch {
      // 少数环境（无 XDG 目录的 Linux / 精简过的容器）拿不到音乐目录。
      return path.join(app.getPath('userData'), 'downloads');
    }
  }

  /**
   * 把解析结果登记到本地代理，并返回给渲染进程的地址。
   *
   * **`upstreamHeaders` 与 `localPath` 必须在这一步剥掉**：前者是回源请求头（可能含第三方源的
   * 伪装头），后者是本机磁盘路径；两者都只能活在主进程里（docs/PLAN.md §2.5 安全红线）。
   */
  private publish(
    audio: ResolvedAudio,
    attempts: readonly ResolveAttempt[],
  ): { audio: ResolvedAudio; attempts: ResolveAttempt[]; src?: string } {
    const clientAudio: ResolvedAudio = { ...audio };
    delete clientAudio.upstreamHeaders;
    delete clientAudio.localPath;
    if (!this.media.running)
      return { audio: clientAudio, attempts: [...attempts] };
    const key = randomUUID();
    // 代理层拿的是**带**回源头的那一份：它才是真正去 CDN 拉字节的人。
    this.mediaEntries.set(key, audio);
    // Map 保序：超量就丢最早的那条（越早解析的直链也越可能已经过期）。
    while (this.mediaEntries.size > MEDIA_ENTRY_LIMIT) {
      const oldest = this.mediaEntries.keys().next();
      if (oldest.done) break;
      this.mediaEntries.delete(oldest.value);
    }
    return { audio: clientAudio, attempts: [...attempts], src: this.media.urlFor(key) };
  }

  private lookupMedia(key: string): ResolvedAudio | undefined {
    const entry = this.mediaEntries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.mediaEntries.delete(key);
      return undefined;
    }
    return entry;
  }

  async dispose(): Promise<void> {
    try {
      await this.media.stop();
    } catch (err) {
      console.error('[pi/media] 停止本地音频代理失败：', err);
    }
    try {
      await this.ncmHost.stop();
    } catch (err) {
      console.error('[pi/ncm] 停止内嵌 API 失败：', err);
    }
    try {
      // 自定义源是外部脚本，可能挂着长连接或定时器：退出时必须显式收掉，
      // 否则 Electron 进程会以为「还有活儿没干完」而拖着不退。
      await this.lxHost.stop();
    } catch (err) {
      console.error('[pi/source-lx] 停止自定义源沙箱失败：', err);
    }
    try {
      // 下载可能正连着几个 CDN：先断开并把最后的进度落盘，
      // 否则退出瞬间的字节数会丢（下次续传就会重复下一小段）。
      await this.downloads.dispose();
    } catch (err) {
      console.error('[pi/downloads] 停止下载管理器失败：', err);
    }
    await this.store.close();
  }
}

/* ------------------------------------------------------------------ */

/** 网易云偶尔会冒出约定之外的状态码，一律按「还没扫码」处理，避免卡住轮询。 */
function normalizeQrCode(code: number): QrCheckCode {
  return code === 800 || code === 802 || code === 803 ? code : 801;
}

/** 只有真正影响展示的字段变了才写盘，避免每次轮询都产生一次磁盘写。 */
function profileChanged(next: StoredProfile, current: StoredProfile | undefined): boolean {
  if (!current) return true;
  return (
    next.userId !== current.userId ||
    next.nickname !== current.nickname ||
    next.avatarUrl !== current.avatarUrl ||
    next.vip !== current.vip ||
    next.vipType !== current.vipType
  );
}

function probeSafeStorage(): SafeStorageStatus {
  try {
    return safeStorage.isEncryptionAvailable() ? 'available' : 'unavailable';
  } catch (err) {
    console.error('[pi/auth] safeStorage 探测失败：', err);
    return 'error';
  }
}

function encrypt(plain: string): string {
  try {
    return safeStorage.encryptString(plain).toString('base64');
  } catch (err) {
    console.error('[pi/auth] 加密失败，降级为明文：', err);
    return plain;
  }
}

function decrypt(stored: string): string | undefined {
  try {
    const buffer = Buffer.from(stored, 'base64');
    // safeStorage 解密失败会抛异常（例如换了机器或 keyring 变了）。
    return safeStorage.decryptString(buffer);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 播放解析：常量与小工具
 * ------------------------------------------------------------------ */

/** 解析结果缓存时长。直链本身通常几十分钟有效，5 分钟足够覆盖「来回切歌」。 */
const AUDIO_CACHE_TTL_MS = 5 * 60_000;
/** 本地代理最多同时记住多少条解析结果。 */
const MEDIA_ENTRY_LIMIT = 64;

/** 第三方源是否**真的**可用：开关打开 **且** 用户确认过风险提示（ADR-0001 第 6 条）。 */
export function thirdPartyEnabled(settings: Settings): boolean {
  return settings.enableThirdPartySources && settings.thirdPartyAcknowledged;
}

/** 存储项 → 对外的插件摘要。**故意不带脚本文本**（几十 KB 不该反复穿过 IPC）。 */
function summarizePlugin(plugin: StoredLxPlugin): LxPluginSummary {
  const meta = parseScriptMeta(plugin.script);
  return {
    id: plugin.id,
    name: plugin.name,
    ...(meta.version ? { version: meta.version } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    sources: [...(plugin.declaredSources ?? [])],
    enabled: plugin.enabled,
    importedAt: plugin.importedAt,
  };
}

/**
 * 组装一条音质日志。
 *
 * `requested` 是我们**要求**的档位，`audio.quality` 是探针**实测**的档位，
 * `audio.claimedQuality` 是来源自己说的——这三者不一致正是最需要留证据的时刻。
 */
function buildQualityLogEntry(args: {
  song: Song;
  requested: Quality;
  audio: ResolvedAudio | null;
  attempts: readonly ResolveAttempt[];
}): QualityLogEntry {
  const { song, requested, audio, attempts } = args;
  return {
    at: Date.now(),
    songId: song.id,
    title: song.name,
    ...(song.artists.length > 0
      ? { artist: song.artists.map((artist) => artist.name).join('、') }
      : {}),
    requested,
    elapsedMs: attempts.reduce((total, attempt) => total + attempt.elapsedMs, 0),
    attempts: [...attempts],
    ...(audio
      ? {
          via: audio.via,
          quality: audio.quality,
          ...(audio.claimedQuality ? { claimed: audio.claimedQuality } : {}),
          container: audio.probe.container,
          ...(audio.probe.sampleRate ? { sampleRate: audio.probe.sampleRate } : {}),
          ...(audio.probe.bitrateKbps ? { bitrate: audio.probe.bitrateKbps } : {}),
          ...(audio.trial ? { trial: true } : {}),
        }
      : {}),
  };
}

/** 默认 0 = 让系统分配随机端口（避免和用户其它程序抢端口）。 */
function mediaPort(): number {
  const raw = Number.parseInt(process.env.PI_MEDIA_PORT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 && raw < 65_536 ? raw : 0;
}

/**
 * L0 官方源现在住在 `@pi/source-official`（M2.5）。
 * 这里保留一个薄的构造点，方便把音源健康表与日志一起挂上。
 */
function buildOfficialSource(ncm: NcmClient): MusicSource {
  return createOfficialSource(ncm);
}

/**
 * 拉一段字节判断「真的是音频吗、到底是哪种格式」。
 * 只取前 64KB：容器头都在最前面，而为了嗅探把整首歌下载一遍是不可接受的。
 *
 * 本地文件（L4）不走网络，直接读盘：既省一次 fetch，也避免把本机路径交给
 * 只该处理 URL 的代码路径。
 */
async function probeRemote(
  audio: ResolvedAudio,
  signal: AbortSignal,
  durationMs?: number,
): Promise<AudioProbe> {
  if (audio.localPath) return probeLocalFile(audio.localPath, durationMs);
  const response = await fetch(audio.url, {
    headers: { ...(audio.upstreamHeaders ?? NEUTRAL_UPSTREAM_HEADERS), range: 'bytes=0-65535' },
    redirect: 'follow',
    signal,
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`探针请求失败：HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const notAudio = describeNonAudio(bytes);
  if (notAudio) throw new Error(notAudio);
  const probe = sniffContainer(bytes);
  const totalBytes = readTotalBytes(
    response.headers.get('content-range'),
    response.headers.get('content-length'),
  );
  if (durationMs !== undefined && durationMs > 0 && totalBytes !== undefined) {
    const bitrateKbps = Math.round((totalBytes * 8) / durationMs);
    if (bitrateKbps > 0) return { ...probe, bitrateKbps };
  }
  return probe;
}

/** 本地探针：读文件头 64KB + 拿文件大小算平均码率，完全不联网。 */
export async function probeLocalFile(
  filePath: string,
  durationMs?: number,
): Promise<AudioProbe> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(PROBE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PROBE_HEAD_BYTES, 0);
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
    const notAudio = describeNonAudio(bytes);
    if (notAudio) throw new Error(notAudio);
    const probe = sniffContainer(bytes);
    const size = (await handle.stat()).size;
    if (durationMs !== undefined && durationMs > 0 && size > 0) {
      // 平均码率：本地文件是完整文件，没有「试听片段」这种干扰。
      const bitrateKbps = Math.round((size * 8) / durationMs);
      if (bitrateKbps > 0) return { ...probe, bitrateKbps };
    }
    return probe;
  } finally {
    await handle.close();
  }
}

/** `content-range: bytes 0-65535/12345678` 里的总数才是整首大小；没有就退回 content-length。 */
function readTotalBytes(
  contentRange: string | null,
  contentLength: string | null,
): number | undefined {
  if (contentRange) {
    const total = Number.parseInt(contentRange.split('/')[1] ?? '', 10);
    if (Number.isFinite(total) && total > 0) return total;
  }
  if (contentLength) {
    const total = Number.parseInt(contentLength, 10);
    if (Number.isFinite(total) && total > 0) return total;
  }
  return undefined;
}
