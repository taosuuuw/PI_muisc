export interface RainFieldEncodeRequest {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
}

export interface RainFieldWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface RainFieldWorkerClientDeps {
  createWorker: () => RainFieldWorkerLike;
  fallback: (canvas: HTMLCanvasElement) => Promise<Blob>;
  timeoutMs?: number;
}

interface WorkerResponse {
  type: 'encoded' | 'error';
  jobId: number;
  blob?: Blob;
  message?: string;
}

interface PendingJob {
  jobId: number;
  request: RainFieldEncodeRequest;
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
}

/**
 * 一个 scene 一个 client；编码 gate 保证同时只有一个 pending job。
 * Worker 不可用/失败时才 fallback canvas.toBlob；绝不回同步 toDataURL。
 */
export class RainFieldWorkerClient {
  private worker: RainFieldWorkerLike | null = null;
  private pending: PendingJob | null = null;
  private nextJobId = 0;
  private broken = false;
  private disposed = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: RainFieldWorkerClientDeps) {
    try {
      this.worker = deps.createWorker();
      this.worker.onmessage = (event) => this.onMessage(event);
      this.worker.onerror = () => this.onWorkerFailure();
    } catch {
      this.worker = null;
      this.broken = true;
    }
  }

  get backend(): 'worker' | 'fallback' {
    return this.worker && !this.broken ? 'worker' : 'fallback';
  }

  encode(request: RainFieldEncodeRequest): Promise<Blob> {
    if (this.disposed) return Promise.reject(new Error('rain field client disposed'));
    if (this.pending) return Promise.reject(new Error('rain field worker busy'));
    if (this.broken || !this.worker) return this.deps.fallback(request.canvas);

    const jobId = ++this.nextJobId;
    return new Promise<Blob>((resolve, reject) => {
      this.pending = { jobId, request, resolve, reject };
      this.timeout = setTimeout(
        () => this.failPendingWithFallback(),
        this.deps.timeoutMs ?? 2000,
      );
      try {
        this.worker?.postMessage(
          {
            type: 'encode',
            jobId,
            width: request.width,
            height: request.height,
            pixels: request.pixels.buffer,
          },
          [request.pixels.buffer],
        );
      } catch {
        this.failPendingWithFallback();
      }
    });
  }

  cancel(): void {
    this.clearTimer();
    this.pending?.reject(new Error('rain field worker job cancelled'));
    this.pending = null;
    this.terminate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.pending?.reject(new Error('rain field worker disposed'));
    this.pending = null;
    this.terminate();
  }

  private onMessage(event: MessageEvent<unknown>): void {
    const data = event.data as WorkerResponse | null;
    if (!data || (data.type !== 'encoded' && data.type !== 'error')) return;
    const pending = this.pending;
    if (!pending || pending.jobId !== data.jobId) return;
    this.pending = null;
    this.clearTimer();
    if (data.type === 'encoded' && data.blob) {
      pending.resolve(data.blob);
      return;
    }
    this.broken = true;
    this.terminate();
    this.deps.fallback(pending.request.canvas).then(pending.resolve, pending.reject);
  }

  private onWorkerFailure(): void {
    this.broken = true;
    this.failPendingWithFallback();
  }

  private failPendingWithFallback(): void {
    const pending = this.pending;
    this.pending = null;
    this.clearTimer();
    this.terminate();
    if (!pending) return;
    this.deps.fallback(pending.request.canvas).then(pending.resolve, pending.reject);
  }

  private clearTimer(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
