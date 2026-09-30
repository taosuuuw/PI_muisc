import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';

export type NcmServerStatus = 'idle' | 'starting' | 'ready' | 'error' | 'stopped';

export interface NcmServerState {
  status: NcmServerStatus;
  port?: number;
  error?: string;
}

export interface NcmServerHostOptions {
  /** 启动超时。 */
  startTimeoutMs?: number;
  /** 崩溃后最多自动重启几次。 */
  maxRestarts?: number;
  onStateChange?: (state: NcmServerState) => void;
}

/**
 * 内嵌网易云 API 子进程的托管器。
 *
 * 为什么放子进程而不是塞进主进程（docs/PLAN.md §2.3 / §2.6）：
 * 1. **崩溃隔离**：第三方 API 实现偶发的未捕获异常不会带走整个 UI。
 * 2. **规避打包陷阱**：NeteaseCloudMusicApi 在 `module/` 目录下用
 *    `fs.readdirSync` + 动态 require 装载路由，esbuild 无法静态分析这种模式。
 *    与其和打包器搏斗，不如让它以「原始文件 + Electron 自带 Node」运行。
 *
 * 因此这里**不做 bundle**，而是用 `ELECTRON_RUN_AS_NODE` 让 Electron 可执行文件
 * 本身充当 Node 运行时——这样用户机器上完全不需要装 Node。
 */
/**
 * 用户 m02898 第 9 条（运行时内存）：给内嵌 API 子进程的 V8 戴上上限。
 *
 * 这个子进程是我们自己的 Node（`ELECTRON_RUN_AS_NODE`），默认堆上限跟着**机器物理内存**走
 * ——这台机能开到 GB 量级。NetEaseCloudMusicApi 启动时会把 `module/` 下几百个路由模块一次
 * `require` 进来，常驻对象其实不大，但上限很高时 V8 会一路让堆长上去、迟迟不做完整 GC，
 * 任务管理器里就表现为一个常驻几百兆的进程（用户图7 那颗 1GB 的 Node.js）。
 * 这份数据规模本来就是百兆级：旧生代 384MB + 半空间 8MB 够用，超了宁可 GC 也不要 RSS。
 *
 * 真碰上吃内存的极端歌单，用 `PI_CHILD_HEAP_MB`（>=128）抬上去即可，不必改代码。
 * 同一份实现也在 `packages/source-lx/src/host.ts`（两包不互相依赖，各自留一份）。
 */
export function childNodeFlags(): string[] {
  const mb = Number(process.env.PI_CHILD_HEAP_MB);
  const heap = Number.isFinite(mb) && mb >= 128 ? Math.round(mb) : 384;
  return [`--max-old-space-size=${heap}`, '--max-semi-space-size=8'];
}

export class NcmServerHost {
  private child: ChildProcess | undefined;
  private state: NcmServerState = { status: 'idle' };
  private restarts = 0;
  private readonly startTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly onStateChange: ((state: NcmServerState) => void) | undefined;
  private stopping = false;

  constructor(options: NcmServerHostOptions = {}) {
    this.startTimeoutMs = options.startTimeoutMs ?? 20_000;
    this.maxRestarts = options.maxRestarts ?? 2;
    this.onStateChange = options.onStateChange;
  }

  getState(): NcmServerState {
    return { ...this.state };
  }

  get baseUrl(): string | undefined {
    return this.state.status === 'ready' && this.state.port
      ? `http://127.0.0.1:${this.state.port}`
      : undefined;
  }

  async start(): Promise<NcmServerState> {
    if (this.state.status === 'ready' || this.state.status === 'starting') return this.getState();
    this.stopping = false;
    this.setState({ status: 'starting' });

    let entry: string;
    try {
      entry = resolveNcmEntry();
    } catch (err) {
      this.setState({
        status: 'error',
        error: `找不到内嵌 API 的入口文件：${err instanceof Error ? err.message : String(err)}`,
      });
      return this.getState();
    }

    const port = await resolvePort();
    // 堆上限必须写在 entry **之前**：Node 只把脚本名之前的参数当自己的命令行开关。
    const child = spawn(process.execPath, [...childNodeFlags(), entry], {
      cwd: path.dirname(entry),
      env: {
        ...process.env,
        // 让 electron.exe 以纯 Node 模式运行，不弹窗口。
        ELECTRON_RUN_AS_NODE: '1',
        HOST: '127.0.0.1',
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      log('info', chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      log('error', chunk.toString());
    });
    child.on('exit', (code, signal) => {
      this.child = undefined;
      if (this.stopping) {
        this.setState({ status: 'stopped' });
        return;
      }
      log('error', `内嵌 API 子进程退出 code=${code} signal=${signal}`);
      if (this.restarts < this.maxRestarts) {
        this.restarts += 1;
        log('info', `尝试重启内嵌 API（第 ${this.restarts} 次）`);
        setTimeout(() => {
          void this.start();
        }, 500 * this.restarts);
      } else {
        this.setState({
          status: 'error',
          error: `内嵌 API 反复退出（code=${code}），已停止重试`,
        });
      }
    });

    const ready = await this.waitForReady(port);
    if (!ready) {
      this.setState({
        status: 'error',
        error: `内嵌 API 在 ${this.startTimeoutMs}ms 内没有就绪（端口 ${port}）`,
      });
      return this.getState();
    }

    this.restarts = 0;
    this.setState({ status: 'ready', port });
    return this.getState();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.setState({ status: 'stopped' });
      return;
    }
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once('exit', done);
      child.kill();
      // 兜底：1.5s 内没退就强杀，避免应用关不干净。
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, 1500).unref?.();
    });
    this.child = undefined;
    this.setState({ status: 'stopped' });
  }

  private async waitForReady(port: number): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          method: 'GET',
          signal: AbortSignal.timeout(1500),
        });
        // 只要能收到 HTTP 响应就说明监听已就绪（/ 返回 200 或 404 都算）。
        if (res.status < 500) return true;
      } catch {
        /* 还没起来，继续等 */
      }
      await sleep(250);
    }
    return false;
  }

  private setState(state: NcmServerState): void {
    this.state = state;
    this.onStateChange?.(this.getState());
  }
}

/** NCM 的入口文件必须在「已安装的包目录内」运行，因为它用 __dirname 找 module/。 */
export function resolveNcmEntry(): string {
  const require = createRequire(import.meta.url);
  const candidates = [
    'NeteaseCloudMusicApi/app.js',
    'NeteaseCloudMusicApi/main.js',
    'NeteaseCloudMusicApi',
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('未安装 NeteaseCloudMusicApi，请先执行 pnpm install');
}

/**
 * 选端口。
 * 默认让系统分配空闲端口；`PI_NCM_PORT` 可以固定端口——排障和自动化冒烟测试
 * 都需要「事先知道端口是多少」，否则只能去翻日志。
 */
async function resolvePort(): Promise<number> {
  const forced = Number(process.env.PI_NCM_PORT);
  if (Number.isInteger(forced) && forced > 0 && forced < 65536) return forced;
  return findFreePort();
}

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('无法分配本地端口')));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level: 'info' | 'error', message: string): void {
  const text = `[pi/ncm] ${message.trim()}`;
  if (level === 'error') console.error(text);
  else console.info(text);
}
