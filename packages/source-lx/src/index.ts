/**
 * L3 自定义源（兼容 LX Music 的自定义源协议）。
 *
 * ## 为什么单独做一个包
 *
 * 这是「用户自己导入的第三方脚本」，在 docs/ADR/0001-音源解析链.md 里排在 L3——
 * 比内置的第三方聚合（L1 UNM）更靠后，因为它的可信度最低、行为最不可控。风险控制手段：
 *
 * 1. **默认关闭**：`enableThirdPartySources` + `thirdPartyAcknowledged` 双门控，
 *    与 UNM 共用同一套用户确认流程（见 apps/renderer 的设置页）。
 * 2. **隔离执行**：脚本跑在独立子进程里，详见 `host.ts` 与 `runtime/lx-child.mjs`。
 * 3. **不碰 cookie**：插件永远拿不到登录态；它对平台接口的访问全靠自己的脚本逻辑。
 * 4. **实测把关**：插件声称的无损照样要过责任链的字节嗅探，虚标会被降级标注。
 */

import type { Quality, ResolvedAudio } from '@pi/shared';
import { NEUTRAL_UPSTREAM_HEADERS, isLosslessQuality } from '@pi/source-core';
import type { MatchInput, MusicSource } from '@pi/source-core';
import {
  LxHost,
  type LxPlugin,
  type LxPluginInfo,
  type LxSessionOptions,
} from './host.js';
import {
  extractLxType,
  extractLxUrl,
  lxTypePreference,
  qualityFromLxType,
  toLxMusicInfo,
} from './protocol.js';

export * from './protocol.js';
export * from './store.js';
export {
  LxHost,
  LxSession,
  defaultLxFetch,
  resolveLxChildRuntime,
  type LxFetch,
  type LxHttpRequest,
  type LxHttpResult,
  type LxPlugin,
  type LxPluginInfo,
  type LxSessionOptions,
} from './host.js';

export const LX_SOURCE_ID = 'lx';
export const LX_SOURCE_LABEL = '自定义源（LX 插件）';

/**
 * LX 层的超时预算。
 *
 * 比责任链默认的 8 秒宽：第一次调用某个插件要现起子进程、加载脚本、等它 `inited`，
 * 冷启动就要一两秒；脚本自己还要发 HTTP。沙箱单次调用本身的上限是 15 秒
 * （`LxSessionOptions.invokeTimeoutMs`），这里对齐它，免得责任链先把它掐了。
 */
export const LX_MATCH_TIMEOUT_MS = 15_000;

/**
 * 询问顺序：**先网易**。
 *
 * 我们的歌曲元数据（歌名/歌手/时长）来自网易云，所以插件按网易的 id/字段去匹配
 * 命中率最高；其余平台是「拿网易的歌名歌手去搜」，排后面。
 */
export const LX_KEY_ORDER = ['wy', 'tx', 'kg', 'kw', 'mg'] as const;

export interface LxSourceOptions extends LxSessionOptions {
  /**
   * 当前启用的插件。
   *
   * 是**函数**：用户随时可能导入/禁用插件，而音源对象是长生命周期的，
   * 构造时取一次会把列表焊死。
   */
  plugins: () => readonly LxPlugin[];
  /** 注入宿主（测试用）。 */
  host?: LxHost;
  log?(message: string): void;
}

export function createLxSource(options: LxSourceOptions): MusicSource {
  const host = options.host ?? new LxHost(options);
  const log = options.log ?? ((): void => undefined);

  return {
    id: LX_SOURCE_ID,
    label: LX_SOURCE_LABEL,
    tier: 'lx',
    // 自定义源是用户自己的脚本，我们不给它任何账号信息。
    needsCookie: false,
    // 冷启动要现起沙箱子进程并等脚本 inited，用更宽的预算（见 LX_MATCH_TIMEOUT_MS）。
    timeoutMs: LX_MATCH_TIMEOUT_MS,
    // 插件的音质标签五花八门，我们用宽松名单接住（见 protocol.ts 的 LX_ALLOWED_QUALITYS）。
    qualities: [
      'standard',
      'higher',
      'exhigh',
      'lossless',
      'hires',
      'jymaster',
      'flac',
      'flac24bit',
    ],

    async match(input: MatchInput, signal: AbortSignal): Promise<ResolvedAudio | null> {
      const plugins = options.plugins();
      if (plugins.length === 0) return null;

      const preference = lxTypePreference(input.quality);

      for (const plugin of plugins) {
        if (signal.aborted) return null;
        let info: LxPluginInfo;
        try {
          info = await host.load(plugin);
        } catch (error) {
          // 单个插件坏了不该把整个 L3 层判死：记日志，继续下一个插件。
          log(
            `[pi/source-lx] 插件「${plugin.name ?? plugin.id}」加载失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }

        const found = await tryPlugin({ host, plugin, info, input, preference, signal, log });
        if (found) return found;
      }
      return null;
    },
  };
}

interface TryPluginArgs {
  host: LxHost;
  plugin: LxPlugin;
  info: LxPluginInfo;
  input: MatchInput;
  preference: readonly string[];
  signal: AbortSignal;
  log(message: string): void;
}

async function tryPlugin(args: TryPluginArgs): Promise<ResolvedAudio | null> {
  const { host, plugin, info, input, preference, signal, log } = args;
  const declaredKeys = LX_KEY_ORDER.filter((key) => info.sources[key] !== undefined);
  if (declaredKeys.length === 0) return null;

  for (const key of declaredKeys) {
    const decl = info.sources[key];
    if (!decl) continue;
    const types = preference.filter((type) => decl.qualitys.includes(type));
    if (types.length === 0) continue;

    for (const type of types) {
      if (signal.aborted) return null;
      try {
        const payload = await raceWithSignal(
          host.invoke(plugin, key, type, toLxMusicInfo(input, key)),
          signal,
        );
        const url = extractLxUrl(payload);
        if (!url) continue;
        // 插件可能给出与实际请求不同的档位（比如要 320k 却回了 flac），以它自报的为准，
        // 最终仍由责任链的探针实测校正。
        const reported = extractLxType(payload) ?? type;
        const quality: Quality = qualityFromLxType(reported);
        return {
          url,
          quality,
          probe: {
            container: 'unknown',
            evidence: `pending-probe（lx:${info.name} ${key} ${reported}）`,
          },
          via: `lx:${info.name}`,
          upstreamHeaders: NEUTRAL_UPSTREAM_HEADERS,
        };
      } catch (error) {
        log(
          `[pi/source-lx] ${info.name} 在 ${key}/${type} 上失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  log(`[pi/source-lx] ${info.name} 没有给出可用直链`);
  return null;
}

/**
 * 竞速取消。子进程那边是「一条命令一次回复」，没法中止已发出的调用，
 * 所以外层超时/用户切歌时我们只是**不再等**它（沙箱会在超时后被重启）。
 */
async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('已取消');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(new Error('已取消'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** 供 UI 展示：这个插件的声明里，是否存在任何一条无损路径。 */
export function pluginSupportsLossless(info: LxPluginInfo): boolean {
  return LX_KEY_ORDER.some((key) => {
    const decl = info.sources[key];
    if (!decl) return false;
    return decl.qualitys.some((type) => isLosslessQuality(qualityFromLxType(type)));
  });
}
