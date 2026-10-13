/**
 * 用户自己导入的歌词（图 1 里的第五个源「本地导入」）。
 *
 * 存在 `userData/data/lyrics/<songId>.json` 里，与其它记录类数据同一层。
 * 为什么单独存成文件而不是塞进 `JsonFileDriver` 的一个大对象：歌词正文动辄几十 KB，
 * 一首一个文件才能在读单曲时**只读那一份**，也不会因为一份坏数据把整份导入列表带崩。
 *
 * 导入的歌词**优先级最高**：用户手动放进来的一定是「他就是要这一份」，
 * 自动匹配再准也不该把它顶掉。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LyricLine } from '@pi/shared';

/** 磁盘上存的一份导入歌词。 */
export interface StoredLocalLyric {
  songId: number;
  /** 导入时用的文件名（界面上显示「来自 xxx.lrc」）。 */
  fileName: string;
  /** 判定出来的格式。 */
  format: 'lrc' | 'ttml' | 'krc' | 'txt';
  lines: LyricLine[];
  translated: LyricLine[];
  roman: LyricLine[];
  importedAt: number;
  /** 原始文本（保留一份，便于以后换解析器重新解）。 */
  raw: string;
}

export class LocalLyricStore {
  private readonly dir: string;

  constructor(userDataDir: string) {
    this.dir = path.join(userDataDir, 'data', 'lyrics');
  }

  /** 拿一首歌的导入歌词；没有就返回 `undefined`（**不抛**：读盘失败等同于没有）。 */
  async get(songId: number): Promise<StoredLocalLyric | undefined> {
    try {
      const text = await readFile(this.fileFor(songId), 'utf8');
      const parsed = JSON.parse(text) as StoredLocalLyric;
      if (!Array.isArray(parsed.lines) || parsed.lines.length === 0) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** 存一份导入歌词（同 id 覆盖）。 */
  async save(entry: StoredLocalLyric): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileFor(entry.songId), JSON.stringify(entry, null, 2), 'utf8');
  }

  /** 删掉一首歌的导入歌词；返回是否真的删掉了。 */
  async remove(songId: number): Promise<boolean> {
    try {
      await rm(this.fileFor(songId));
      return true;
    } catch {
      return false;
    }
  }

  /** 已导入的歌曲 id 列表（给「歌词」页显示条数）。 */
  async list(): Promise<number[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .filter((file) => file.endsWith('.json'))
        .map((file) => Number.parseInt(file.replace(/\.json$/, ''), 10))
        .filter((id) => Number.isInteger(id) && id > 0);
    } catch {
      return [];
    }
  }

  /** 这份目录占多少字节（缓存大小里的「导入歌词」那一项）。 */
  async sizeBytes(): Promise<number> {
    try {
      const files = await readdir(this.dir);
      let total = 0;
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const stat = await readFile(path.join(this.dir, file));
          total += stat.byteLength;
        } catch {
          /* 单个文件读不到就跳过，不影响总数 */
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  private fileFor(songId: number): string {
    return path.join(this.dir, `${songId}.json`);
  }
}
