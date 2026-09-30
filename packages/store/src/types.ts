/**
 * @pi/store —— 本地持久化抽象。
 *
 * 为什么不是 SQLite：见 docs/ADR/0002。核心原因是原生模块（native addon）必须匹配
 * 「平台 + 架构 + Electron ABI」，这是「大部分环境都能跑」的头号敌人。
 *
 * 因此这里定义 `StorageDriver` 接口，默认实现是纯 JS 的 JSON 文件驱动；
 * 将来若要换 SQLite，只需新增一个实现，业务层零改动。
 */

export interface StorageDriver {
  /** 驱动标识，写进日志便于排障。 */
  readonly kind: string;

  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;

  /** 列出某个「域」下所有值。域 = key 的第一段，例如 `history`。 */
  list<T>(domain: string): Promise<T[]>;

  /** 在同一事务内执行多次写操作，结束时统一落盘一次。 */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** 立即落盘（应用退出前调用）。 */
  flush(): Promise<void>;

  /** 关闭驱动（不再接受写入）。 */
  close(): Promise<void>;
}

/** key 的规范形式：`<domain>.<name>`，例如 `settings.app`、`history.tracks`。 */
export function parseKey(key: string): { domain: string; file: string } {
  const dot = key.indexOf('.');
  const domain = dot === -1 ? key : key.slice(0, dot);
  if (!/^[a-z0-9_-]+$/.test(domain)) {
    throw new Error(
      `非法的存储 key：「${key}」。域名必须是 [a-z0-9_-]+，完整形式为 <domain>.<name>`,
    );
  }
  return { domain, file: `${domain}.json` };
}
