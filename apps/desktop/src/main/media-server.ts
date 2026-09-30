import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ResolvedAudio } from '@pi/shared';

/**
 * 本地音频代理。
 *
 * 为什么必须存在这一层：
 * - 渲染进程拿不到 cookie，也不该直接去网易云 CDN 拉音频（上游直链是带时效签名的临时地址，而且校验 Referer）；
 * - `<audio src>` 需要可 Range 的 http 地址，`file://` 在打包态不可控、`blob:` 对大文件 seek 不可靠；
 * - 直链过期后重新解析只发生在主进程，渲染进程始终只认本地地址。
 *
 * 安全：只监听 127.0.0.1，且每个地址都带随机 token；渲染进程只拿到不透明的 mediaKey，
 * 既看不到上游 URL，也看不到任何请求头。
 */

export interface MediaServerOptions {
  /** 按 mediaKey 取一次解析结果（由 Services 在 player:resolve 时写入）。 */
  lookup(key: string): ResolvedAudio | undefined;
  /**
   * 回源请求头的兜底值（音源自己没给时用）。
   *
   * 真正的头是**逐条结果**的：官方直链必须带网易 Referer，第三方直链绝不能带
   * （会被对方当成盗链），所以优先用 `ResolvedAudio.upstreamHeaders`。
   */
  upstreamHeaders?: Record<string, string>;
  log?(message: string, detail?: unknown): void;
}

const MEDIA_KEY_PATTERN = /^\/audio\/([A-Za-z0-9_-]{8,64})$/;
const FORWARDED_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
] as const;

export class MediaServer {
  private server: Server | undefined;
  private port: number | undefined;
  private readonly token = randomBytes(16).toString('hex');
  private readonly inFlight = new Set<AbortController>();

  constructor(private readonly options: MediaServerOptions) {}

  get running(): boolean {
    return this.port !== undefined;
  }

  get baseUrl(): string {
    return this.port === undefined ? '' : `http://127.0.0.1:${this.port}`;
  }

  /** 给 `<audio src>` 用：不透明地址，除了 token 不泄露任何上游信息。 */
  urlFor(key: string): string {
    return `${this.baseUrl}/audio/${key}?t=${this.token}`;
  }

  async start(preferredPort = 0): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(preferredPort, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      server.close();
      throw new Error('本地音频代理没有拿到监听端口');
    }
    this.port = address.port;
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopback(req.socket.remoteAddress)) {
        this.fail(res, 403, '仅允许本机访问');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.searchParams.get('t') !== this.token) {
        this.fail(res, 403, 'token 无效');
        return;
      }
      const key = MEDIA_KEY_PATTERN.exec(url.pathname)?.[1];
      if (!key) {
        this.fail(res, 404, '未知路径');
        return;
      }
      const entry = this.options.lookup(key);
      if (!entry) {
        this.fail(res, 404, '解析结果已过期，请重新点播');
        return;
      }
      await this.pipe(entry, req, res);
    } catch (error) {
      this.fail(res, 502, error instanceof Error ? error.message : String(error));
    }
  }

  private async pipe(
    entry: ResolvedAudio,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // L4 本地源：文件在磁盘上，没有上游可回源，直接按 Range 读盘。
    if (entry.localPath) {
      await this.pipeFile(entry.localPath, req, res);
      return;
    }
    const controller = new AbortController();
    this.inFlight.add(controller);
    const headers: Record<string, string> = {
      ...(entry.upstreamHeaders ?? this.options.upstreamHeaders),
    };
    if (typeof req.headers.range === 'string') headers['range'] = req.headers.range;
    try {
      const upstream = await fetch(entry.url, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!upstream.ok && upstream.status !== 206) {
        this.fail(res, 502, `上游返回 HTTP ${upstream.status}`);
        return;
      }
      res.writeHead(upstream.status, collectHeaders(upstream.headers));
      const body = upstream.body;
      if (req.method === 'HEAD' || body === null) {
        res.end();
        return;
      }
      const source = Readable.fromWeb(body as unknown as WebReadableStream);
      source.on('error', () => {
        res.destroy();
      });
      res.on('close', () => {
        source.destroy();
        controller.abort();
      });
      source.pipe(res);
    } finally {
      this.inFlight.delete(controller);
    }
  }

  /**
   * 本地文件的分发。
   *
   * 为什么本地文件也要走代理而不是给渲染进程 `file://`：
   * 1. 渲染进程的 CSP 只允许 `http(s)` 与 `blob/data`，`file://` 会被直接拦掉；
   * 2. 拖动进度条依赖 Range，浏览器对 `file://` 的 Range 支持因环境而异；
   * 3. 路径留在主进程里，页面永远只看到一个不透明的 key。
   */
  private async pipeFile(
    filePath: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let info;
    try {
      info = await stat(filePath);
    } catch (error) {
      this.fail(res, 404, `本地文件读不到：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!info.isFile()) {
      this.fail(res, 404, '本地路径不是一个文件');
      return;
    }
    if (info.size === 0) {
      res.writeHead(200, { 'content-type': contentTypeFor(filePath), 'content-length': '0' });
      res.end();
      return;
    }

    const range = parseRange(req.headers.range, info.size);
    const contentType = contentTypeFor(filePath);
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, info.size - 1);

    if (range && range.invalid) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` });
      res.end();
      return;
    }

    res.writeHead(range ? 206 : 200, {
      'content-type': contentType,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = createReadStream(filePath, { start, end });
    stream.on('error', () => {
      res.destroy();
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  }

  private fail(res: ServerResponse, status: number, message: string): void {
    this.options.log?.('[pi/media] 拒绝请求', { status, message });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message }));
  }
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** 解析 `bytes=start-end`。`invalid` 表示语法或范围不合法 → 416。 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number; invalid?: boolean } | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { start: 0, end: 0, invalid: true };
  const [, rawStart = '', rawEnd = ''] = match;
  // `bytes=-500`：后缀范围，要最后 500 字节。
  if (rawStart === '') {
    const length = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(length) || length <= 0) return { start: 0, end: 0, invalid: true };
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number.parseInt(rawStart, 10);
  const end = rawEnd === '' ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { start: 0, end: 0, invalid: true };
  }
  return { start, end };
}

/** 本地文件的后缀 → MIME。大多解码器只看内容，但给对类型能让浏览器少猜一次。 */
function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  switch (ext) {
    case 'flac':
      return 'audio/flac';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'ape':
      return 'audio/x-ape';
    case 'wma':
      return 'audio/x-ms-wma';
    default:
      return 'application/octet-stream';
  }
}
