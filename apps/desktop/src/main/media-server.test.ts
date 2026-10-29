import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedAudio } from '@pi/shared';
import { MediaServer } from './media-server';

/**
 * 本地音频代理的跨源头。
 *
 * 为什么这些断言值得存在：`MediaElementAudioSourceNode` 对「跨源且无 ACAO」的媒体输出零样本，
 * 症状是播放看着正常、波形全 0（`docs/PLAN-AUTOMIX.md` §P0）。这条链路一旦退化成没有 CORS 头，
 * 界面上不会报错，只会让自动过渡永远只能拿到静音——所以把每一类响应都钉死。
 */

/** 最小编码的 16bit 单声道 WAV，内容不重要，只要字节能被正常分发。 */
function wavBytes(samples: number): Buffer {
  const dataLength = samples * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(22050, 24);
  buffer.writeUInt32LE(22050 * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

const KEY = 'probe-key-0001';

let directory = '';
let server: MediaServer;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-media-'));
  const file = join(directory, 'tone.wav');
  await writeFile(file, wavBytes(2205));
  const entry = {
    url: 'http://127.0.0.1:1/never',
    quality: 'standard',
    probe: { container: 'wav', sampleRate: 22050, bitrate: 705600 },
    via: 'test',
    localPath: file,
  } as unknown as ResolvedAudio;
  server = new MediaServer({ lookup: (key) => (key === KEY ? entry : undefined) });
  await server.start(0);
});

afterAll(async () => {
  await server.stop();
});

const tokenOf = (): string => new URL(server.urlFor(KEY)).searchParams.get('t') ?? '';

describe('本地音频代理：跨源头', () => {
  it('200 带 ACAO，且 Content-Type 正确', async () => {
    const response = await fetch(server.urlFor(KEY));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
  });

  it('206（Range）同样带 ACAO 与 expose-headers', async () => {
    const response = await fetch(server.urlFor(KEY), { headers: { range: 'bytes=0-1' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('content-range')).toMatch(/^bytes 0-1\//);
    expect(response.headers.get('access-control-expose-headers')).toContain('content-range');
  });

  it('HEAD 带 ACAO', async () => {
    const response = await fetch(server.urlFor(KEY), { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('OPTIONS 预检：204 + 允许的方法', async () => {
    const response = await fetch(server.urlFor(KEY), { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
    expect(response.headers.get('access-control-max-age')).toBe('600');
  });

  it('token 不对仍是 403，但错误响应也带 ACAO', async () => {
    const url = new URL(server.urlFor(KEY));
    url.searchParams.set('t', 'wrong-token');
    const response = await fetch(url);
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('未知 mediaKey 是 404，也带 ACAO', async () => {
    const response = await fetch(server.urlFor('unknown-key-0002'));
    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('路径不匹配是 404，也带 ACAO', async () => {
    const response = await fetch(`${server.baseUrl}/nope?t=${tokenOf()}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('416（越界 Range）也带 ACAO', async () => {
    const response = await fetch(server.urlFor(KEY), { headers: { range: 'bytes=999999-1000000' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});
