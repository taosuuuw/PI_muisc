import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseKey, type StorageDriver } from './types.js';

export interface JsonFileDriverOptions {
  /** 数据目录，通常是 Electron 的 app.getPath('userData')。 */
  baseDir: string;
  /** 写盘去抖，避免高频写入打爆磁盘。 */
  flushDebounceMs?: number;
}

interface DomainState {
  /** 已解析的内存镜像。 */
  data: Record<string, unknown>;
  /** 是否有未落盘的改动。 */
  dirty: boolean;
  /** 正在进行的写盘 Promise，用于串行化。 */
  writing?: Promise<void>;
}

/**
 * 零原生依赖的 JSON 文件存储。
 *
 * 落盘策略：写入临时文件后 `rename` 覆盖（同目录 rename 是原子操作），
 * 因此进程被强杀也不会留下半个文件。写盘按域串行，避免并发 rename 竞态。
 */
export class JsonFileDriver implements StorageDriver {
  readonly kind = 'json-file';

  private readonly baseDir: string;
  private readonly debounceMs: number;
  private readonly domains = new Map<string, DomainState>();
  private flushTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: JsonFileDriverOptions) {
    this.baseDir = options.baseDir;
    this.debounceMs = options.flushDebounceMs ?? 500;
  }

  /** 预加载一批域，让启动后的首次读取不必等 IO。 */
  async warmup(domains: readonly string[]): Promise<void> {
    await Promise.all(domains.map((d) => this.loadDomain(d)));
  }

  async get<T>(key: string): Promise<T | undefined> {
    const { domain } = parseKey(key);
    const state = await this.loadDomain(domain);
    return state.data[key] as T | undefined;
  }

  async has(key: string): Promise<boolean> {
    const { domain } = parseKey(key);
    const state = await this.loadDomain(domain);
    return Object.prototype.hasOwnProperty.call(state.data, key);
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.assertOpen();
    const { domain } = parseKey(key);
    const state = await this.loadDomain(domain);
    state.data[key] = value;
    state.dirty = true;
    this.scheduleFlush();
  }

  async delete(key: string): Promise<boolean> {
    this.assertOpen();
    const { domain } = parseKey(key);
    const state = await this.loadDomain(domain);
    if (!Object.prototype.hasOwnProperty.call(state.data, key)) return false;
    delete state.data[key];
    state.dirty = true;
    this.scheduleFlush();
    return true;
  }

  async list<T>(domain: string): Promise<T[]> {
    const state = await this.loadDomain(domain);
    return Object.values(state.data) as T[];
  }

  /**
   * 事务只保证「落盘次数减少」，不是数据库级隔离——
   * 单进程单窗口场景下够用；这也是 ADR-0002 记录的代价之一。
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.clearTimer();
    try {
      return await fn();
    } finally {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    this.clearTimer();
    const pending = [...this.domains.entries()].filter(([, s]) => s.dirty);
    await Promise.all(pending.map(([domain]) => this.writeDomain(domain)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }

  /* ---------------------------------------------------------------- */

  private assertOpen(): void {
    if (this.closed) throw new Error('存储已关闭，不能再写入');
  }

  private scheduleFlush(): void {
    this.clearTimer();
    this.flushTimer = setTimeout(() => {
      void this.flush().catch((err: unknown) => {
        console.error('[pi/store] 去抖落盘失败：', err);
      });
    }, this.debounceMs);
    // 不要让未落盘的定时器把进程钉住。
    this.flushTimer.unref?.();
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private async loadDomain(domain: string): Promise<DomainState> {
    const cached = this.domains.get(domain);
    if (cached) return cached;

    const state: DomainState = { data: {}, dirty: false };
    this.domains.set(domain, state);

    const file = path.join(this.baseDir, parseKey(`${domain}.x`).file);
    try {
      const raw = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        state.data = parsed as Record<string, unknown>;
      } else {
        console.warn(`[pi/store] ${file} 顶层不是对象，已忽略其内容`);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // 文件损坏不应导致应用起不来：备份后从空开始。
        console.error(`[pi/store] 读取 ${file} 失败，将从空数据开始：`, err);
        await this.backupCorrupt(file);
      }
    }
    return state;
  }

  private async writeDomain(domain: string): Promise<void> {
    const state = this.domains.get(domain);
    if (!state || !state.dirty) {
      if (state?.writing) await state.writing;
      return;
    }
    if (state.writing) await state.writing;

    const snapshot = JSON.stringify(state.data, null, 2);
    state.dirty = false;

    const run = async (): Promise<void> => {
      await mkdir(this.baseDir, { recursive: true });
      const file = path.join(this.baseDir, parseKey(`${domain}.x`).file);
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, file);
    };

    state.writing = run().finally(() => {
      state.writing = undefined;
    });
    await state.writing;
  }

  private async backupCorrupt(file: string): Promise<void> {
    try {
      await rename(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* 备份失败就算了，不能因此阻塞启动 */
    }
  }
}
