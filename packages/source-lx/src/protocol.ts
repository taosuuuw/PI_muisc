/**
 * LX Music「自定义源」协议的**纯函数**部分。
 *
 * 这里只做协议本身的解析与映射，不碰进程、不碰 vm、不碰网络——那些在
 * `host.ts` / `runtime/lx-child.mjs`。分层的理由：协议规则最容易被 LX 上游改动，
 * 放在纯函数里可以用单测钉死，不需要真的起一个沙箱。
 *
 * 协议要点（逐条对着 `lyswhut/lx-music-desktop` master 核过）：
 * 1. 脚本头部**必须**是一段块注释（由 `/*` 开始、`*` + `/` 结束），且位于文件偏移 0，元数据写在里面；
 * 2. 脚本是**带副作用的**：它自己调 `lx.on(lx.EVENT_NAMES.request, handler)` 注册处理函数，
 *    再用 `lx.send(lx.EVENT_NAMES.inited, { sources })` 声明自己能干什么；
 * 3. 宿主对 `sources` 里声明的东西会做**交集过滤**：`actions` 只留 `musicUrl`，
 *    `qualitys` 只留一个白名单。这不是我们的发明，是 LX 自己的 `handleInit` 干的。
 */

import type { Quality } from '@pi/shared';
import type { MatchInput } from '@pi/source-core';

/** 脚本头注释的正则：与 LX 源码里的 `/^\/\*[\S|\s]+?\*\//` 完全一致。 */
const SCRIPT_HEADER = /^\/\*[\S|\s]+?\*\//;

export const LX_SCRIPT_INVALID = '无效的自定义源文件';

export interface LxScriptMeta {
  name: string;
  description: string;
  version: string;
  author: string;
  homepage: string;
  /** 元数据解析前的完整脚本，原样保留（LX 的 `rawScript`）。 */
  rawScript: string;
}

/** LX 的 `sources` 键。`local` 是我们不用的本地文件源（本地由 L4 负责）。 */
export const LX_SOURCE_KEYS = ['kw', 'kg', 'tx', 'wy', 'mg', 'local'] as const;
export type LxSourceKey = (typeof LX_SOURCE_KEYS)[number];

/** 平台 key → 人类可读的名字（日志与 UI 用）。 */
export const LX_SOURCE_LABELS: Record<string, string> = {
  kw: '酷我',
  kg: '酷狗',
  tx: 'QQ 音乐',
  wy: '网易云',
  mg: '咪咕',
  local: '本地文件',
};

export interface LxSourceDecl {
  type: 'music';
  actions: readonly string[];
  qualitys: readonly string[];
}

export type LxSourceDecls = Partial<Record<LxSourceKey, LxSourceDecl>>;

/**
 * 我们愿意接受的 LX 音质标签。
 *
 * LX desktop 自己只留 `['128k','320k','flac','flac24bit']`，把 `hires`/`atmos`/`master`
 * 全部丢掉——因为它的界面只认这四个。我们比它**宽松**：多认 `192k`/`ape`/`wav` 和几个
 * 高清标签，这样流行的社区脚本里那些 `hires` 声明不会白写。
 * 代价是声明过的音质未必真有——不过没关系，责任链会用字节嗅探实测校正（见 packages/resolver）。
 */
export const LX_ALLOWED_QUALITYS = [
  '128k',
  '192k',
  '320k',
  'flac',
  'flac24bit',
  'ape',
  'wav',
  'hires',
  'hires24bit',
  'atmos',
  'master',
] as const;

/** LX 的 `actions` 白名单：非 local 源只保留取直链这一个动作。 */
const LX_ALLOWED_ACTIONS = ['musicUrl'] as const;

/**
 * 解析脚本头部注释里的元数据。
 *
 * 头部缺失时抛 {@link LX_SCRIPT_INVALID}——错误文案故意和 LX 一样，
 * 这样用户在别处看到的教程/报错能对上号。
 */
export function parseScriptMeta(rawScript: string): LxScriptMeta {
  const match = SCRIPT_HEADER.exec(rawScript);
  if (!match) throw new Error(LX_SCRIPT_INVALID);
  const header = match[0];
  // LX 的截断长度：name 24 / description 36 / author 56 / homepage 1024 / version 36。
  const meta: LxScriptMeta = {
    name: readMeta(header, 'name', 24),
    description: readMeta(header, 'description', 36),
    version: readMeta(header, 'version', 36),
    author: readMeta(header, 'author', 56),
    homepage: readMeta(header, 'homepage', 1024),
    rawScript,
  };
  if (!meta.name) meta.name = '未命名音源';
  return meta;
}

function readMeta(header: string, key: string, limit: number): string {
  // 只能匹配**同一行**里标签后面的值：`\s` 会跨行，于是 `@author` 空着时
  // 它的值会吞掉下一行（甚至注释结尾的 `*/`），静默产出垃圾元数据。
  const match = new RegExp(`@${key}[ \\t]+([^\\r\\n]*)`).exec(header);
  return (match?.[1] ?? '').trim().slice(0, limit);
}

/**
 * 对脚本声明的 `sources` 做交集过滤。
 *
 * 静默丢弃是**故意的**，与 LX 行为一致：脚本声明的能力超出宿主允许范围时，
 * 宿主不是报错而是把它裁掉（脚本照样能跑，只是那些能力不可用）。
 */
export function intersectSourceDecls(raw: unknown): LxSourceDecls {
  const result: LxSourceDecls = {};
  if (!raw || typeof raw !== 'object') return result;

  for (const key of LX_SOURCE_KEYS) {
    const entry = (raw as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object') continue;
    const decl = entry as { type?: unknown; qualitys?: unknown };
    // `type` 必须是 'music'，否则整条源直接跳过。
    if (decl.type !== 'music') continue;
    if (key === 'local') continue; // 本地文件走 L4 LocalSource，不走自定义源。

    const declared = Array.isArray(decl.qualitys) ? decl.qualitys : [];
    const qualitys = LX_ALLOWED_QUALITYS.filter((q) =>
      declared.some((item) => item === q),
    );
    result[key] = { type: 'music', actions: [...LX_ALLOWED_ACTIONS], qualitys };
  }
  return result;
}

/**
 * `inited` 事件的载荷。
 *
 * LX 的 `handleInit` 在这里还会做一堆校验（源名去重、id 合法性……），
 * 我们只做必要的一条：**至少要有一个我们能用的源**，否则这个插件留着也没意义。
 */
export function parseInitedPayload(payload: unknown): LxSourceDecls {
  const data = payload as { sources?: unknown } | undefined;
  return intersectSourceDecls(data?.sources);
}

/* ------------------------------------------------------------------ *
 * 音质映射
 * ------------------------------------------------------------------ */

/** LX 音质标签 → 我们内部的 {@link Quality}。 */
export function qualityFromLxType(type: string): Quality {
  switch (type) {
    case '128k':
      return 'standard';
    case '192k':
      return 'higher';
    case '320k':
      return 'exhigh';
    case 'flac24bit':
      return 'flac24bit';
    case 'hires':
    case 'hires24bit':
      return 'hires';
    case 'atmos':
    case 'master':
      return 'jymaster';
    // flac / ape / wav 都是无损，只是容器不同；实际格式交给探针实测。
    case 'flac':
    case 'ape':
    case 'wav':
      return 'lossless';
    default:
      return 'standard';
  }
}

/**
 * 我们想要某个档位时，按顺序去问插件哪些 LX 音质标签。
 *
 * 顺序里**总是留降级路径**：要无损却只给得出 320k 时，责任链会把它当「可播但不够好」的
 * 兜底结果继续往后找（见 packages/resolver/src/chain.ts），比直接失败强得多。
 */
export function lxTypePreference(quality: Quality): readonly string[] {
  switch (quality) {
    case 'jymaster':
    case 'hires':
      return ['hires24bit', 'hires', 'master', 'atmos', 'flac24bit', 'flac', '320k'];
    case 'flac24bit':
      return ['flac24bit', 'flac', 'ape', 'wav', '320k'];
    case 'flac':
      return ['flac', 'flac24bit', 'ape', 'wav', '320k'];
    case 'lossless':
      return ['flac24bit', 'flac', 'ape', 'wav', '320k'];
    case 'exhigh':
      return ['320k', '192k', '128k'];
    case 'higher':
      return ['192k', '128k'];
    default:
      return ['128k'];
  }
}

/* ------------------------------------------------------------------ *
 * musicInfo
 * ------------------------------------------------------------------ */

/**
 * 交给插件 `musicUrl(musicInfo, type)` 的 `musicInfo`。
 *
 * LX 会在把它送进插件之前用 `toOldMusicInfo()` 拍平，字段名与我们内部模型完全不同。
 * 这里只填我们有把握的字段：我们是**从网易云的歌来反查别的平台**，所以
 * `songmid` 是网易的歌曲 id，`source` 固定 'wy'。各平台专属字段（`hash`/`strMediaMid`/
 * `copyrightId`）我们手上没有——那是 LX 在「本地曲库 + 平台直连」场景才有的东西。
 * 插件拿不到这些字段时会走它自己的搜索逻辑（社区脚本普遍如此）。
 */
export interface LxMusicInfo {
  name: string;
  singer: string;
  source: string;
  songmid: string;
  interval: number | null;
  albumName: string;
  img: string | null;
  typeUrl: Record<string, string>;
  albumId: string;
  types: Record<string, string>;
  _types: Record<string, string>;
}

export function toLxMusicInfo(input: MatchInput, source: string): LxMusicInfo {
  return {
    name: input.title,
    singer: input.artists.join('、'),
    source,
    songmid: String(input.songId),
    // LX 的 interval 单位是毫秒。
    interval: input.durationMs ?? null,
    albumName: input.albumName ?? '',
    img: null,
    typeUrl: {},
    albumId: '',
    types: {},
    _types: {},
  };
}

/**
 * 从插件的返回值里取直链。
 *
 * 社区脚本两种写法都有：直接返回字符串，或者返回 `{ type, url }`（LX 自带的那批脚本
 * 是后者）。LX 对 url 的校验很严，我们照抄：必须是 `http(s)://` 开头、长度 ≤ 2048。
 */
export function extractLxUrl(payload: unknown): string | undefined {
  const candidate =
    typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object'
        ? (payload as { url?: unknown }).url
        : undefined;
  if (typeof candidate !== 'string') return undefined;
  if (candidate.length === 0 || candidate.length > 2048) return undefined;
  if (!/^https?:\/\//.test(candidate)) return undefined;
  return candidate;
}

/** 从插件的返回值里取它实际给出的音质标签（可能没有）。 */
export function extractLxType(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const type = (payload as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}
