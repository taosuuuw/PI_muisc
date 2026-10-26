import { describe, expect, it, vi } from 'vitest';
import {
  RainFieldWorkerClient,
  type RainFieldWorkerLike,
} from './rain-field-worker-client';

class FakeWorker implements RainFieldWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  terminated = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.messages.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  fail(): void {
    this.onerror?.({} as ErrorEvent);
  }
}

const request = () => ({
  pixels: new Uint8ClampedArray(4),
  width: 1,
  height: 1,
  canvas: {} as HTMLCanvasElement,
});

describe('RainFieldWorkerClient', () => {
  it('真 worker 提交像素并 transfer buffer，回应只完成当前 job', async () => {
    const worker = new FakeWorker();
    const fallback = vi.fn(async () => new Blob(['fallback']));
    const client = new RainFieldWorkerClient({
      createWorker: () => worker,
      fallback,
    });
    const job = client.encode(request());
    expect(client.backend).toBe('worker');
    expect(worker.messages).toHaveLength(1);
    expect(worker.messages[0]?.transfer).toHaveLength(1);
    await expect(client.encode(request())).rejects.toThrow('busy');

    worker.respond({ type: 'encoded', jobId: 1, blob: new Blob(['worker']) });
    await expect(job).resolves.toBeInstanceOf(Blob);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('worker failure 转 fallback，terminate 旧 worker，late response 不重复完成', async () => {
    const worker = new FakeWorker();
    const fallback = vi.fn(async () => new Blob(['fallback']));
    const client = new RainFieldWorkerClient({
      createWorker: () => worker,
      fallback,
    });
    const job = client.encode(request());
    worker.fail();
    await expect(job).resolves.toBeInstanceOf(Blob);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(worker.terminated).toBe(true);
    expect(client.backend).toBe('fallback');

    worker.respond({ type: 'encoded', jobId: 1, blob: new Blob(['late']) });
    await Promise.resolve();
  });

  it('cancel 拒绝 pending、终止 worker，之后走 fallback', async () => {
    const worker = new FakeWorker();
    const fallback = vi.fn(async () => new Blob(['fallback']));
    const client = new RainFieldWorkerClient({
      createWorker: () => worker,
      fallback,
    });
    const job = client.encode(request());
    client.cancel();
    await expect(job).rejects.toThrow('cancelled');
    expect(worker.terminated).toBe(true);
    await expect(client.encode(request())).resolves.toBeInstanceOf(Blob);
    expect(fallback).toHaveBeenCalled();
  });

  it('Worker 构造失败直接 fallback；dispose 拒绝 pending 并终止', async () => {
    const fallback = vi.fn(async () => new Blob(['fallback']));
    const client = new RainFieldWorkerClient({
      createWorker: () => {
        throw new Error('worker unavailable');
      },
      fallback,
    });
    expect(client.backend).toBe('fallback');
    await client.encode(request());
    expect(fallback).toHaveBeenCalledTimes(1);

    const worker = new FakeWorker();
    const second = new RainFieldWorkerClient({
      createWorker: () => worker,
      fallback,
    });
    const pending = second.encode(request());
    second.dispose();
    await expect(pending).rejects.toThrow('disposed');
    expect(worker.terminated).toBe(true);
  });
});
