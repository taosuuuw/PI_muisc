import { describe, expect, it } from 'vitest';
import { RainFieldEncoder } from './rain-field-encoder';

function harness() {
  const blobs: Array<(blob: Blob | null) => void> = [];
  const decodes: Array<{ resolve: () => void; reject: () => void }> = [];
  const scheduled: Array<() => void> = [];
  const revoked: string[] = [];
  const hrefs: string[] = [];
  let nextUrl = 0;
  const encoder = new RainFieldEncoder({
    encode: (_request, done) => blobs.push(done),
    decode: () =>
      new Promise<void>((resolve, reject) => {
        decodes.push({ resolve, reject });
      }),
    createUrl: () => `blob:rain-${++nextUrl}`,
    revokeUrl: (url) => revoked.push(url),
    setHref: (url) => hrefs.push(url),
    schedule: (callback) => scheduled.push(callback),
    transparentUrl: 'transparent',
  });
  return { encoder, blobs, decodes, scheduled, revoked, hrefs };
}

const canvas = {} as HTMLCanvasElement;
const request = {
  pixels: new Uint8ClampedArray(4),
  width: 1,
  height: 1,
  canvas,
};

describe('RainFieldEncoder 单批异步 gate', () => {
  it('最多一个 inflight；提交后下一批要等完成的 gate 放行', async () => {
    const h = harness();
    const token = h.encoder.beginScene();
    expect(h.encoder.tryStart()).toBe(token);
    expect(h.encoder.tryStart()).toBeNull();

    let committed = false;
    h.encoder.submit(request, token, (value) => {
      committed = value;
    });
    expect(h.blobs).toHaveLength(1);
    h.blobs[0]?.(new Blob());
    h.decodes[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(committed).toBe(true);
    expect(h.hrefs.at(-1)).toBe('blob:rain-1');
    expect(h.encoder.tryStart()).toBe(token);
  });

  it('scene 取消后 late toBlob 不能碰新场，并释放上一张 URL', () => {
    const h = harness();
    const oldToken = h.encoder.beginScene();
    h.encoder.tryStart();
    h.encoder.submit(request, oldToken, () => undefined);
    const newToken = h.encoder.beginScene();
    const pending = h.blobs[0];
    pending?.(new Blob());

    expect(newToken).not.toBe(oldToken);
    expect(h.hrefs.at(-1)).toBe('transparent');
    expect(h.encoder.tryStart()).toBe(newToken);
  });

  it('decode 期间取消 scene 会 revoke 新 URL，不提交 href', async () => {
    const h = harness();
    const token = h.encoder.beginScene();
    h.encoder.tryStart();
    h.encoder.submit(request, token, () => undefined);
    h.blobs[0]?.(new Blob());
    h.encoder.beginScene();
    h.decodes[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.revoked).toContain('blob:rain-1');
    expect(h.hrefs.at(-1)).toBe('transparent');
  });

  it('新图提交后下一帧释放旧 URL；dispose 释放当前 URL', async () => {
    const h = harness();
    const token = h.encoder.beginScene();
    h.encoder.tryStart();
    h.encoder.submit(request, token, () => undefined);
    h.blobs[0]?.(new Blob());
    h.decodes[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const next = h.encoder.tryStart();
    expect(next).toBe(token);
    h.encoder.submit(request, token, () => undefined);
    h.blobs[1]?.(new Blob());
    h.decodes[1]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.hrefs.at(-1)).toBe('blob:rain-2');
    h.scheduled.forEach((callback) => callback());
    expect(h.revoked).toContain('blob:rain-1');

    h.encoder.dispose();
    expect(h.revoked).toContain('blob:rain-2');
  });
});
