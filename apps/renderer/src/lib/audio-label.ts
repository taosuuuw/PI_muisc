import { QUALITY_LABEL, type ResolvedAudio } from '@pi/shared';

/**
 * 播放界面上的「来源 + 音质」文案。
 *
 * 两条纪律（docs/PLAN.md §1.2.1 反虚标规则）：
 * 1. **实测压过自称**：徽标上的容器/码率一律来自字节嗅探（`audio.probe`），
 *    接口说自己是 SQ/Hi-Res 不算数。
 * 2. **试听必须说出来**：官方对 VIP 歌只给 30 秒时会带 `trial: true`，
 *    界面必须如实标注，不能让用户以为播放器坏了。
 */

/** 音源 id → 人能读的名字。`unm:kugou` 这种带平台的也认。 */
export function sourceLabel(via: string | undefined): string | undefined {
  if (!via) return undefined;
  const [head, tail] = via.split(':');
  if (head === 'wy') return '网易云官方';
  if (head === 'unm') return tail ? `第三方 · ${tail}` : '第三方';
  if (head === 'lx') return tail ? `自定义源 · ${tail}` : '自定义源';
  if (head === 'local') return '本地文件';
  return via;
}

/** 实测格式徽标：容器 +（采样率或码率）。没探到容器时返回 undefined。 */
export function measuredLabel(audio: ResolvedAudio | null | undefined): string | undefined {
  if (!audio || audio.probe.container === 'unknown') return undefined;
  const parts = [audio.probe.container.toUpperCase()];
  if (audio.probe.sampleRate) parts.push(`${formatKHz(audio.probe.sampleRate)}kHz`);
  else if (audio.probe.bitrateKbps) parts.push(`${Math.round(audio.probe.bitrateKbps)}kbps`);
  return parts.join(' ');
}

/**
 * 悬浮说明：一次讲清「声称什么 / 实测是什么 / 依据是什么 / 是不是试听」。
 */
export function audioTooltip(audio: ResolvedAudio | null | undefined): string | undefined {
  if (!audio) return undefined;
  const lines = [
    `来源：${sourceLabel(audio.via) ?? audio.via}`,
    `声称音质：${QUALITY_LABEL[audio.quality]}（${audio.quality}）`,
    `实测依据：${audio.probe.evidence}`,
  ];
  if (audio.claimedQuality) {
    lines[1] = `声称音质：${QUALITY_LABEL[audio.claimedQuality]}（${audio.claimedQuality}）`;
    lines.push(`实测只到：${QUALITY_LABEL[audio.quality]}（${audio.quality}）`);
  }
  if (audio.trial) lines.push('注意：官方只提供了试听片段');
  return lines.join('\n');
}

/**
 * 「标称 X」徽标：只在探针结果低于来源自称时出现。
 *
 * 第三方源普遍虚标，所以不把「标称」当结论，只当**差异提示**——
 * 用户点开一首标称 Hi-Res 的歌，播放栏上是 MP3，得让人知道这不是我们的锅。
 */
export function claimedLabel(audio: ResolvedAudio | null | undefined): string | undefined {
  if (!audio?.claimedQuality) return undefined;
  return `标称 ${QUALITY_LABEL[audio.claimedQuality]}`;
}

function formatKHz(sampleRate: number): string {
  const khz = sampleRate / 1000;
  return Number.isInteger(khz) ? String(khz) : khz.toFixed(1);
}
