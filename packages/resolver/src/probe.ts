import type { AudioContainer, AudioProbe } from '@pi/shared';

/**
 * 字节嗅探：**不信任接口自称的音质**，只看文件头。
 *
 * 背景：第三方音源普遍存在「虚标无损」——接口写 lossless，实际下发 320k MP3。
 * UI 上的无损徽标必须来自这里的结果，否则就是在骗用户。
 */
export function sniffContainer(head: Uint8Array): AudioProbe {
  const ascii = (start: number, len: number): string => {
    let out = '';
    for (let i = start; i < start + len && i < head.length; i += 1) {
      out += String.fromCharCode(head[i] ?? 0);
    }
    return out;
  };

  if (ascii(0, 4) === 'fLaC') {
    return { container: 'flac', sampleRate: readFlacSampleRate(head), evidence: 'magic:fLaC' };
  }
  if (ascii(0, 4) === 'OggS') {
    return { container: 'ogg', evidence: 'magic:OggS' };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    return { container: 'wav', evidence: 'magic:RIFF/WAVE' };
  }
  if (ascii(4, 4) === 'ftyp') {
    return { container: 'm4a', evidence: 'magic:ftyp@4' };
  }
  if (ascii(0, 3) === 'ID3') {
    return { container: 'mp3', evidence: 'magic:ID3' };
  }
  const b0 = head[0];
  const b1 = head[1];
  if (b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0) {
    return { container: 'mp3', evidence: `magic:MPEG-frame(${hex(b0)}${hex(b1)})` };
  }
  if (b0 === 0xff && b1 !== undefined && (b1 & 0xf6) === 0xf0) {
    return { container: 'aac', evidence: 'magic:ADTS' };
  }
  return { container: 'unknown', evidence: `unrecognized(${hex(b0)}${hex(b1)})` };
}

/** 后端可能返回 HTML 错误页或 JSON 错误体，明确标出来便于排障。 */
export function describeNonAudio(head: Uint8Array): string | undefined {
  const ascii = String.fromCharCode(...head.subarray(0, 16));
  if (/^\s*</.test(ascii)) return '返回的是 HTML（多半是错误页或需登录）';
  if (/^\s*\{/.test(ascii)) return '返回的是 JSON（多半是错误响应）';
  return undefined;
}

function readFlacSampleRate(head: Uint8Array): number | undefined {
  // STREAMINFO 位于 "fLaC"(4) + metadata 头(4) 之后，采样率是其中第 10..12 字节的 20 位。
  if (head.length < 21) return undefined;
  const b10 = head[18] ?? 0;
  const b11 = head[19] ?? 0;
  const b12 = head[20] ?? 0;
  const rate = ((b10 << 12) | (b11 << 4) | (b12 >> 4)) & 0xfffff;
  return rate > 0 ? rate : undefined;
}

function hex(n: number | undefined): string {
  return n === undefined ? '??' : n.toString(16).padStart(2, '0');
}

export const LOSSLESS_CONTAINERS: readonly AudioContainer[] = ['flac', 'wav'];

export function isLosslessContainer(container: AudioContainer): boolean {
  return LOSSLESS_CONTAINERS.includes(container);
}
