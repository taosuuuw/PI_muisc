/**
 * 自定义源插件的持久化。
 *
 * 存的是**脚本文本 + 启用状态**，不存任何执行结果（脚本行为完全由它自己决定，
 * 缓存它的返回值只会让用户更难理解为什么换了版本没生效）。
 *
 * 去重靠**脚本文本的哈希**：同一份脚本文本再次导入会被识别为同一个插件，
 * 不会出现「导了三次、列表里三条、每次解析问三遍」的荒唐情况。
 */

import { createHash } from 'node:crypto';

export interface StoredLxPlugin {
  id: string;
  name: string;
  script: string;
  enabled: boolean;
  importedAt: number;
  /**
   * 导入时那次沙箱试跑回报的源声明（`kw|kg|tx|wy|mg` 的子集）。
   *
   * 存下来是为了让设置页不必为了显示「这插件支持哪些平台」而重新执行脚本——
   * 执行脚本是有副作用的事，不该在列表刷新时发生。
   */
  declaredSources?: string[];
}

/** 只需要这两个方法，避免这个包依赖具体的存储实现。 */
export interface PluginDriver {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export const LX_PLUGINS_KEY = 'sources.plugins';

/** 脚本 → 稳定 id。12 位十六进制足够区分个人用户的插件数量。 */
export function pluginIdFor(script: string): string {
  return createHash('sha1').update(script, 'utf8').digest('hex').slice(0, 12);
}

export class LxPluginStore {
  constructor(
    private readonly driver: PluginDriver,
    private readonly key = LX_PLUGINS_KEY,
  ) {}

  async load(): Promise<StoredLxPlugin[]> {
    const stored = await this.driver.get<StoredLxPlugin[]>(this.key);
    if (!Array.isArray(stored)) return [];
    // 存储文件是用户可编辑的：脏数据只丢弃，不能让整个音源体系起不来。
    return stored.filter(
      (item): item is StoredLxPlugin =>
        !!item &&
        typeof item.id === 'string' &&
        typeof item.script === 'string' &&
        typeof item.name === 'string',
    );
  }

  async save(plugins: readonly StoredLxPlugin[]): Promise<void> {
    await this.driver.set(this.key, plugins);
  }
}
