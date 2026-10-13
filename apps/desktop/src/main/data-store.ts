/**
 * 「本地数据存储位置 + 应用缓存大小 + 一键清理」（用户第五轮第 2 条）。
 *
 * 这一块存在的意义是**让用户看得见自己的东西存在哪、占了多少**：
 * 本地音乐应用必然会在磁盘上留下数据（歌单缓存、封面、音频分片、歌词），
 * 但用户没有任何别的途径知道它们在哪、有多大、能不能删。
 *
 * 两类数据刻意**分开报告、分开清理**：
 * - `groups` 是音乐数据与 Web/GPU 缓存 —— 可清理，删了会自动重建；
 * - `music` 是用户自己的东西（下载的歌、本地曲库目录、设置与账号）—— **永不清理**，
 *   只显示路径。把它们混进「一键清理」里是删用户文件，性质完全不同。
 */
import { app, session } from 'electron';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CacheGroup, DataStorageInfo, MusicPath } from '@pi/shared';
import type { LocalLyricStore } from './lyrics/store.js';

/**
 * 可清理的缓存分组。
 *
 * `paths` 一律相对 userData，绝不接受用户输入：这个接口会真的删目录，
 * 参数一旦来自界面就等于给了一个任意删除入口。
 */
export interface CacheGroupSpec {
  id: string;
  label: string;
  /** 删除后会发生什么（界面上那一行说明）。 */
  effect: string;
  /** 相对 userData 的目录名。 */
  paths: readonly string[];
}

export const CACHE_GROUPS: readonly CacheGroupSpec[] = [
  {
    id: 'web',
    label: '网页与界面缓存',
    effect: '界面的脚本、样式与字体缓存；删了下次启动会重新生成',
    paths: ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
      'GrShaderCache', 'ShaderCache', 'blob_storage', 'Shared Dictionary'],
  },
  {
    id: 'audio',
    label: '音频与封面缓存',
    effect: '试听分片、封面与接口数据；删了重新播放时自动重新缓存',
    // 网易云 API 子进程与网络层的 HTTP 缓存落在 Network / Service Worker 下。
    paths: ['Network', 'Service Worker'],
  },
];

async function safeStat(target: string): Promise<number> {
  try {
    const info = await stat(target);
    if (info.isFile()) return info.size;
    return await directorySize(target);
  } catch {
    return 0;
  }
}

/** 递归求目录大小；读不动的子项直接跳过（缓存目录里常有正在写的临时文件）。 */
async function directorySize(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const child = path.join(dir, entry);
    try {
      const info = await stat(child);
      if (info.isDirectory()) total += await directorySize(child);
      else total += info.size;
    } catch {
      /* 单个文件读不到/被占用：跳过，不影响总数 */
    }
  }
  return total;
}

export interface DataStorageDeps {
  readonly lyrics: LocalLyricStore;
  /** 下载目录（已解析过默认值）。 */
  downloadDir: () => Promise<string>;
  /** 本地曲库目录（设置里的值，空表示没设）。 */
  localLibraryDir: () => Promise<string>;
  /** 数据存储目录（`store` 落盘的目录）。 */
  dataDir: () => string;
}

export class DataStorage {
  private readonly userDataDir: string;

  constructor(
    private readonly deps: DataStorageDeps,
    userDataDir = app.getPath('userData'),
  ) {
    this.userDataDir = userDataDir;
  }

  /**
   * 一次性把「存在哪、占多大」都算出来。
   *
   * 是真的去磁盘上算（不是估算）：目录大小对用户来说只有「准」才有意义——
   * 报一个假的数，一键清理之后对不上，用户只会更不敢点。
   */
  async info(): Promise<DataStorageInfo> {
    // 「听歌数据」= 曲库缓存、播放历史、设置、账号 —— 全是 store 那一个目录。
    const musicBytes = await safeStat(this.deps.dataDir());

    const lyricBytes = await this.deps.lyrics.sizeBytes();

    const groups: CacheGroup[] = [];
    for (const spec of CACHE_GROUPS) {
      let bytes = 0;
      for (const relative of spec.paths) {
        bytes += await safeStat(path.join(this.userDataDir, relative));
      }
      groups.push({ id: spec.id, label: spec.label, effect: spec.effect, bytes });
    }
    // 「歌词缓存」是用户导入的那份目录（跟上面的 HTTP 缓存不是一回事，单独一项）。
    groups.push({
      id: 'lyrics',
      label: '歌词缓存',
      effect: '各源歌词与你自己导入的歌词文件；删了会重新匹配（导入的那份也会没）',
      bytes: lyricBytes,
    });

    const musicPaths = await this.musicPaths();
    const cacheBytes = groups.reduce((total, group) => total + group.bytes, 0);

    return {
      userDataDir: this.userDataDir,
      dataDir: this.deps.dataDir(),
      downloadDir: await this.deps.downloadDir(),
      localLibraryDir: await this.deps.localLibraryDir(),
      musicBytes,
      lyricsBytes: lyricBytes,
      cacheBytes,
      groups,
      musicPaths,
    };
  }

  private async musicPaths(): Promise<MusicPath[]> {
    const list: MusicPath[] = [
      {
        label: '数据存储位置',
        path: this.deps.dataDir(),
        hint: '曲库缓存、播放历史、设置与账号信息（听歌数据都在这里）',
      },
      {
        label: '下载目录',
        path: await this.deps.downloadDir(),
        hint: '下载的歌曲文件（你自己的音乐文件，不会被清理）',
      },
    ];
    return list;
  }

  /**
   * 一键清理：把可清理的分组删掉。
   *
   * 两条安全线：
   * ① `only` 只认 `CACHE_GROUPS` 里的 id —— 界面上传来的字符串不参与拼路径；
   * ② 清理 `lyrics` 那一组时**连用户导入的歌词一起删**，所以界面上的文案已明确写出来，
   *    调用方也只有在用户点了确认之后才会把它放进 `only`。
   */
  async clear(only?: readonly string[]): Promise<{ freedBytes: number; info: DataStorageInfo }> {
    const before = await this.info();
    const selected =
      only === undefined || only.length === 0
        ? CACHE_GROUPS.map((group) => group.id)
        : CACHE_GROUPS.filter((group) => only.includes(group.id)).map((group) => group.id);

    for (const id of selected) {
      if (id === 'lyrics') continue;
      const spec = CACHE_GROUPS.find((group) => group.id === id);
      if (spec === undefined) continue;
      for (const relative of spec.paths) {
        await this.removeDir(path.join(this.userDataDir, relative));
      }
    }

    // 网易云 API 子进程与窗口自己的 HTTP 缓存：Electron 有官方入口，优先用它。
    try {
      await session.defaultSession.clearCache();
    } catch (error) {
      console.warn('[pi/data] 清理 Electron HTTP 缓存失败：', error);
    }

    // 导入的歌词（只有勾了这一项才删）。
    if (selected.includes('lyrics')) {
      for (const songId of await this.deps.lyrics.list()) {
        await this.deps.lyrics.remove(songId);
      }
    }

    const info = await this.info();
    return { freedBytes: Math.max(before.cacheBytes - info.cacheBytes, 0), info };
  }

  private async removeDir(target: string): Promise<void> {
    // 只删 userData 下面的东西：万一以后有人把路径写错成绝对路径，这一层会拦住它。
    const relative = path.relative(this.userDataDir, target);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      console.warn(`[pi/data] 拒绝清理 userData 之外的路径：${target}`);
      return;
    }
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      // 正在被占用的文件（Chromium 自己的缓存句柄）删不掉很正常：下次启动会重建。
      console.warn(`[pi/data] 清理 ${relative} 未完全成功：`, error);
    }
  }
}
