/**
 * 自定义源子进程的托管器（主进程侧）。
 *
 * 与 `runtime/lx-child.mjs` 的分工：这里负责「起进程、发命令、代理网络、限时限额」，
 * 脚本执行与 `lx` API 全在那个子进程里。为什么要子进程而不是直接在主进程里
 * `vm.runInContext`：**主进程握有网易 cookie、IPC 与所有文件句柄**，插件代码再怎么
 * 隔离也不该和它们同处一个地址空间。子进程崩了、死循环了，我们杀掉重开就是。
 *
 * 粒度是**一个插件一个子进程**（{@link LxSession}）：一个沙箱上下文里只能挂一个
 * 脚本的 `request` 处理器（后加载的会覆盖前一个），所以插件之间不能共享进程。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseInitedPayload, parseScriptMeta, type LxSourceDecls } from './protocol.js';

export interface LxPlugin {
  /** 稳定 id（导入时生成，用于启用/禁用与去重）。 */
  id: string;
  /** 脚本原文。 */
  script: string;
  /** 显示名，默认从脚本头部注释里取。 */
  name?: string;
}

export interface LxPluginInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  homepage: string;
  /** 脚本声明且被我们接受的源（键为 kw/kg/tx/wy/mg）。 */
  sources: LxSourceDecls;
}

export interface LxHttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, unknown>;
  formData?: Record<string, unknown>;
  timeout?: number;
}

export interface LxHttpResult {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  bytes: number;
  /** 响应体文本（二进制响应会是乱码，`rawBase64` 才是准的）。 */
  text: string;
  json?: unknown;
  hasJson: boolean;
  rawBase64: string;
}

/** 网络实现。默认走主进程的 `fetch`；可注入假实现，也能在这里加白名单/限流。 */
export type LxFetch = (
  url: string,
  request: LxHttpRequest,
  signal: AbortSignal,
) => Promise<LxHttpResult>;

export interface LxSessionOptions {
  runtimePath?: string;
  /** 单个 HTTP 请求的上限，默认 20 秒（LX 自己夹到 60 秒）。 */
  requestTimeoutMs?: number;
  /** 单次 `musicUrl` 调用的上限。 */
  invokeTimeoutMs?: number;
  /** 加载（含等到 `inited`）的上限。 */
  initTimeoutMs?: number;
  /** 单个响应体上限，默认 8MB。 */
  maxResponseBytes?: number;
  http?: LxFetch;
  log?(message: string): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_INVOKE_TIMEOUT_MS = 15_000;
const DEFAULT_INIT_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** LX 把 timeout 夹在 60 秒内，我们照抄这个上限。 */
const LX_MAX_TIMEOUT_MS = 60_000;

/**
 * 用户 m02898 第 9 条（运行时内存）：自定义源沙箱子进程的 V8 上限。
 *
 * 和 `packages/ncm-server/src/host.ts` 同一个理由：子进程是我们自己的 Node
 * （`ELECTRON_RUN_AS_NODE`），默认堆上限跟着物理内存走，LX 那些脚本一旦把大响应体
 * （默认 8MB 上限）或者整张歌单拉进内存，V8 就会一路养堆而不做完整 GC。
 * 旧生代 384MB + 半空间 8MB 足够沙箱用；真遇到吃内存的源，`PI_CHILD_HEAP_MB`（>=128）抬。
 * 两包不互相依赖，所以这份实现各留一份。
 */
export function childNodeFlags(): string[] {
  const mb = Number(process.env.PI_CHILD_HEAP_MB);
  const heap = Number.isFinite(mb) && mb >= 128 ? Math.round(mb) : 384;
  return [`--max-old-space-size=${heap}`, '--max-semi-space-size=8'];
}

/**
 * 解析子进程入口。
 *
 * 必须解析到**真实文件路径**而不是依赖被打包的主进程 bundle：子进程由 Electron 以
 * `ELECTRON_RUN_AS_NODE` 直接执行，bundle 里的代码它一行也不认识。
 */
export function resolveLxChildRuntime(): string {
  const require = createRequire(import.meta.url);
  for (const candidate of ['@pi/source-lx/runtime/lx-child.mjs']) {
    try {
      return require.resolve(candidate);
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    '找不到自定义源沙箱入口（@pi/source-lx/runtime/lx-child.mjs），请先执行 pnpm install',
  );
}

interface PendingReply {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** 一个插件 ↔ 一个子进程。 */
export class LxSession {
  private child: ChildProcess | undefined;
  private startup: Promise<void> | undefined;
  private ready: Promise<void> | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private readonly pendingReplies = new Map<number, PendingReply>();
  private readonly aborters = new Map<number, AbortController>();
  private info: LxPluginInfo | undefined;
  private seq = 0;
  private stopping = false;
  private stdoutBuffer = '';

  constructor(
    readonly plugin: LxPlugin,
    private readonly options: LxSessionOptions = {},
  ) {}

  get isAlive(): boolean {
    return this.child !== undefined && !this.stopping;
  }

  get pluginInfo(): LxPluginInfo | undefined {
    return this.info;
  }

  /** 起进程（幂等）。插件第一次被用到时才付这个启动成本。 */
  async start(): Promise<void> {
    if (this.isAlive && this.ready) return this.ready;
    if (this.startup) return this.startup;
    this.startup = this.spawnChild();
    return this.startup;
  }

  /** 加载脚本并返回源声明。 */
  async load(): Promise<LxPluginInfo> {
    if (this.info) return this.info;
    await this.start();
    const meta = parseScriptMeta(this.plugin.script);
    const name = this.plugin.name?.trim() || meta.name;
    const result = (await this.send({ kind: 'load', script: this.plugin.script, info: { ...meta, name } }, this.timeout('initTimeoutMs', DEFAULT_INIT_TIMEOUT_MS))) as
      | { payload?: unknown }
      | undefined;
    const sources = parseInitedPayload(result?.payload);
    if (Object.keys(sources).length === 0) {
      throw new Error(`插件「${name}」没有声明任何我们支持的音源`);
    }
    this.info = {
      id: this.plugin.id,
      name,
      version: meta.version,
      author: meta.author,
      description: meta.description,
      homepage: meta.homepage,
      sources,
    };
    return this.info;
  }

  /** 调一次 `musicUrl`。 */
  async invoke(source: string, type: string, musicInfo: unknown): Promise<unknown> {
    await this.start();
    await this.load();
    return this.send(
      { kind: 'invoke', source, type, info: musicInfo },
      this.timeout('invokeTimeoutMs', DEFAULT_INVOKE_TIMEOUT_MS),
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.startup = undefined;
    this.rejectReady?.(new Error('自定义源沙箱已关闭'));
    for (const [id, pending] of this.pendingReplies) {
      clearTimeout(pending.timer);
      pending.reject(new Error('自定义源沙箱已关闭'));
      this.pendingReplies.delete(id);
    }
    for (const controller of this.aborters.values()) controller.abort();
    this.aborters.clear();
    this.info = undefined;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once('exit', done);
      try {
        child.stdin?.write(`${JSON.stringify({ kind: 'exit' })}\n`);
      } catch {
        /* 管道可能已经断了 */
      }
      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, 1500);
      timer.unref?.();
    });
  }

  /** 超时后强杀。卡住的脚本会拖垮后续调用，所以宁可重启。 */
  async kill(reason: string): Promise<void> {
    this.options.log?.(`[lx] ${reason}，重启插件「${this.plugin.name ?? this.plugin.id}」的沙箱`);
    await this.stop().catch(() => undefined);
  }

  /* ---------------------------------------------------------------- */

  private timeout(key: 'requestTimeoutMs' | 'invokeTimeoutMs' | 'initTimeoutMs', fallback: number): number {
    return this.options[key] ?? fallback;
  }

  private spawnChild(): Promise<void> {
    const runtimePath = this.options.runtimePath ?? resolveLxChildRuntime();
    // 堆上限必须写在 runtimePath **之前**：Node 只把脚本名之前的参数当自己的开关。
    const child = spawn(process.execPath, [...childNodeFlags(), runtimePath], {
      // 子进程只需要一个干净的 Node 环境：不继承我们的环境变量（里面可能有令牌）。
      env: minimalEnv(),
      cwd: path.dirname(runtimePath),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.stopping = false;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => undefined);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) this.options.log?.(`[lx-child] ${text}`);
    });
    child.on('error', (error) => {
      this.rejectReady?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.on('exit', (code, signal) => {
      this.child = undefined;
      this.startup = undefined;
      this.ready = undefined;
      this.info = undefined;
      if (!this.stopping) {
        this.options.log?.(`[lx] 沙箱子进程退出 code=${code} signal=${signal}`);
        this.rejectReady?.(new Error(`自定义源沙箱退出（code=${code}）`));
      }
    });
    return this.ready;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this.onMessage(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  private onMessage(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.options.log?.(`[lx-child] 无法解析的输出：${line.slice(0, 200)}`);
      return;
    }

    switch (message['kind']) {
      case 'ready':
        this.resolveReady?.();
        return;
      case 'log':
        this.options.log?.(`[lx:${String(message['level'] ?? 'info')}] ${String(message['message'] ?? '')}`);
        return;
      case 'http': {
        const reqId = Number(message['reqId']);
        void this.handleHttp(reqId, String(message['url']), (message['options'] ?? {}) as LxHttpRequest);
        return;
      }
      case 'reply': {
        const id = Number(message['id']);
        const pending = this.pendingReplies.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingReplies.delete(id);
        if (message['ok']) pending.resolve(message['result']);
        else pending.reject(new Error(String(message['error'] ?? '未知错误')));
        return;
      }
      default:
        this.options.log?.(`[lx-child] 未知消息：${line.slice(0, 200)}`);
    }
  }

  /** 把脚本的 HTTP 请求转发出去（这就是「网络经主进程代理」）。 */
  private async handleHttp(reqId: number, url: string, request: LxHttpRequest): Promise<void> {
    if (!/^https?:\/\//.test(url)) {
      this.replyHttp(reqId, false, `只允许 http(s) 请求：${url.slice(0, 80)}`);
      return;
    }
    const controller = new AbortController();
    this.aborters.set(reqId, controller);
    const timeout = clampTimeout(request.timeout ?? this.timeout('requestTimeoutMs', DEFAULT_REQUEST_TIMEOUT_MS));
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const fetchImpl = this.options.http ?? defaultLxFetch(this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES);
      const result = await fetchImpl(url, request, controller.signal);
      this.replyHttp(reqId, true, result);
    } catch (error) {
      this.replyHttp(reqId, false, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      this.aborters.delete(reqId);
    }
  }

  private replyHttp(reqId: number, ok: boolean, payload: unknown): void {
    this.write({ kind: 'http-result', reqId, ok, ...(ok ? { response: payload } : { error: payload }) });
  }

  private send(command: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = ++this.seq;
    if (!this.child) return Promise.reject(new Error('自定义源沙箱没有在运行'));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(id);
        reject(new Error(`沙箱操作超时（${timeoutMs}ms）`));
        // 超时的调用无法取消（脚本可能卡在同步死循环里），只能重启这一个插件的沙箱。
        void this.kill('调用超时');
      }, timeoutMs);
      this.pendingReplies.set(id, { resolve, reject, timer });
      this.write({ ...command, id });
    });
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.options.log?.(`[lx] 无法写入沙箱：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * 插件池：每个启用中的插件一个 {@link LxSession}，按需启动、加载失败即弃。
 *
 * 上层（{@link createLxSource}）把「有哪些插件」交给它，其余细节这里包圆。
 */
export class LxHost {
  private readonly sessions = new Map<string, LxSession>();

  constructor(private readonly options: LxSessionOptions = {}) {}

  /** 确保插件已加载，返回它的声明。 */
  async load(plugin: LxPlugin): Promise<LxPluginInfo> {
    const session = this.sessionFor(plugin);
    try {
      return await session.load();
    } catch (error) {
      // 加载失败就别留着半个沙箱：下次调用重新来过。
      await session.stop().catch(() => undefined);
      this.sessions.delete(plugin.id);
      throw error;
    }
  }

  /** 调一次 `musicUrl`。会话死了会自动重建（脚本会重新加载）。 */
  async invoke(plugin: LxPlugin, source: string, type: string, musicInfo: unknown): Promise<unknown> {
    const session = this.sessionFor(plugin);
    try {
      return await session.invoke(source, type, musicInfo);
    } catch (error) {
      if (!session.isAlive) this.sessions.delete(plugin.id);
      throw error;
    }
  }

  listLoaded(): LxPluginInfo[] {
    return [...this.sessions.values()]
      .map((session) => session.pluginInfo)
      .filter((info): info is LxPluginInfo => info !== undefined);
  }

  async stop(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.stop().catch(() => undefined)));
  }

  /**
   * 只关掉某个插件的沙箱（禁用/删除插件时用，也要给应用退出时逐个收）。
   *
   * 有的插件进程会留着长连接或定时器，不能等进程自己退。
   */
  async stopPlugin(id: string): Promise<void> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (!session) return;
    await session.stop().catch(() => undefined);
  }

  private sessionFor(plugin: LxPlugin): LxSession {
    const existing = this.sessions.get(plugin.id);
    if (existing) return existing;
    const session = new LxSession(plugin, this.options);
    this.sessions.set(plugin.id, session);
    return session;
  }
}

function clampTimeout(value: number): number {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(Math.max(ms, 1000), LX_MAX_TIMEOUT_MS);
}

/** 只给子进程留最基本的环境变量：不继承任何可能含密钥的变量。 */
function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of ['SystemRoot', 'TEMP', 'TMP', 'windir']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/**
 * 默认网络实现：用主进程的 `fetch`。
 *
 * 几个细节刻意对齐 LX / needle，社区脚本依赖这些行为：
 * - 响应头**全部小写**（脚本常写 `headers['content-type']`）；
 * - JSON 响应自动解析成对象（脚本常写 `resp.body.xxx`）；
 * - 同时给出文本（`text`）与原始字节（`rawBase64`），因为解密流程要 Buffer；
 * - `form` + GET 拼到查询串上，这是 needle 的老习惯。
 */
export function defaultLxFetch(maxResponseBytes: number): LxFetch {
  return async (url, request, signal) => {
    const method = (request.method ?? 'get').toUpperCase();
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      headers.set(key, String(value));
    }

    let target = url;
    let body: string | Buffer | FormData | undefined;
    let contentType = '';

    if (request.formData) {
      const form = new FormData();
      for (const [key, value] of Object.entries(request.formData)) form.append(key, String(value));
      body = form;
    } else if (request.form && method === 'GET') {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(request.form)) query.set(key, String(value));
      target += `${target.includes('?') ? '&' : '?'}${query.toString()}`;
    } else if (request.form) {
      body = new URLSearchParams(
        Object.entries(request.form).map(([key, value]) => [key, String(value)] as [string, string]),
      ).toString();
      contentType = 'application/x-www-form-urlencoded';
    } else if (request.body !== undefined) {
      const decoded = decodeBody(request.body);
      body = decoded.body;
      if (decoded.json) contentType = 'application/json';
    }

    if (contentType && !headers.has('content-type')) headers.set('content-type', contentType);

    const response = await fetch(target, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal,
      redirect: 'follow',
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxResponseBytes) {
      throw new Error(`响应体过大（${buffer.byteLength} 字节，上限 ${maxResponseBytes}）`);
    }
    const text = buffer.toString('utf8');
    const responseType = response.headers.get('content-type') ?? '';
    let json: unknown;
    let hasJson = false;
    if (responseType.includes('json') || /^\s*[[{]/.test(text)) {
      try {
        json = JSON.parse(text) as unknown;
        hasJson = true;
      } catch {
        hasJson = false;
      }
    }

    const headersOut: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headersOut[key.toLowerCase()] = value;
    });

    return {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: headersOut,
      bytes: buffer.byteLength,
      text,
      ...(hasJson ? { json } : {}),
      hasJson,
      rawBase64: buffer.toString('base64'),
    };
  };
}

function decodeBody(body: unknown): { body: string | Buffer; json: boolean } {
  if (typeof body === 'string') return { body, json: false };
  if (body && typeof body === 'object' && '__piBuffer' in body) {
    const base64 = (body as { __piBuffer?: unknown }).__piBuffer;
    return { body: Buffer.from(String(base64 ?? ''), 'base64'), json: false };
  }
  return { body: JSON.stringify(body), json: true };
}
