import type { ReactNode } from 'react';
import { QUALITY_LABEL, type Quality, type QualityLogEntry } from '@pi/shared';
import { errorMessage } from '../bridge';
import { sourceLabel } from '../lib/audio-label';
import { useQualityLog } from '../lib/queries';

/**
 * 音质日志的**正文**（不含页面标题）。
 *
 * 用户 m08768 第 1 条：环形菜单里删掉的「音质日志」键，功能要落到设置页里。
 * 所以同一份内容现在有两个出口——独立的「音质日志」页，和设置页边框页里的「日志」tab。
 * 抽成一个组件是为了让两处**永远逐字节一样**：各写一份的话，加字段时必然会漏掉一边，
 * 用户就会看到「设置页里有这条、日志页里没有」这种没法解释的差异。
 *
 * 存在的理由（docs/PLAN.md §5「音源可追溯」）：音源体系里最容易被糊弄的就是音质。
 * 接口说自己是 FLAC、聚合搜索返回一个 320k 的 mp3、自定义源只给了半首歌——
 * 这些只有在**解析完真正落到字节上**才看得出来。所以每次点歌都记一条：
 * 请求的档位、最终来源、实测容器/采样率/码率，以及责任链上每个源为什么被跳过。
 *
 * 只保留最近 200 条（`QUALITY_LOG_LIMIT`，主进程裁剪），够复盘「刚才那首为什么没声」。
 */
export function QualityLogPanel(): ReactNode {
  const log = useQualityLog(true);
  const entries = log.data?.entries ?? [];

  return (
    <>
      {log.isPending ? (
        <div className="pi-placeholder">正在读取日志…</div>
      ) : log.error ? (
        <p className="pi-dialog__error">{errorMessage(log.error)}</p>
      ) : entries.length === 0 ? (
        <div className="pi-placeholder">还没有记录。播放一首歌之后这里会有内容。</div>
      ) : (
        <section className="pi-card">
          <div className="pi-sectionhead">
            <span className="pi-setting__title">最近 {entries.length} 次解析</span>
            <button
              type="button"
              className="pi-btn pi-btn--ghost"
              onClick={() => void log.refetch()}
            >
              刷新
            </button>
          </div>
          {entries.map((entry, index) => (
            <LogRow key={`${entry.at}-${entry.songId}-${index}`} entry={entry} />
          ))}
        </section>
      )}
    </>
  );
}

function LogRow({ entry }: { entry: QualityLogEntry }): ReactNode {
  return (
    <div className="pi-logrow">
      <div>
        <div className="pi-logrow__title">
          {entry.title}
          {entry.artist ? <span className="pi-logrow__meta"> · {entry.artist}</span> : null}
        </div>
        <div className="pi-logrow__meta">
          请求 {qualityLabel(entry.requested)} · 实际 {describeActual(entry)} ·{' '}
          {sourceLabel(entry.via) ?? '未解析到音源'} · 用时 {entry.elapsedMs} ms ·{' '}
          {timeAgo(entry.at)}
        </div>
      </div>

      <div className="pi-logrow__meta" style={{ textAlign: 'right' }}>
        {entry.trial ? <span className="pi-badge pi-badge--warn">试听片段</span> : null}
        {entry.claimed ? (
          <span className="pi-badge pi-badge--warn">
            标称 {QUALITY_LABEL[entry.claimed]}，实测只到 {qualityLabel(entry.quality)}
          </span>
        ) : null}
      </div>

      <div className="pi-logrow__chain">
        {entry.attempts.map((attempt, index) => (
          <span
            key={`${attempt.sourceId}-${index}`}
            className={`pi-logrow__attempt${attempt.ok ? ' pi-logrow__attempt--ok' : ''}${
              attempt.ok ? '' : ' pi-logrow__attempt--bad'
            }`}
            title={attempt.detail ?? ''}
          >
            {attempt.sourceId}
            {attempt.detail ? ` · ${truncate(attempt.detail, 48)}` : ''} · {attempt.elapsedMs}ms
          </span>
        ))}
        {entry.attempts.length === 0 ? (
          <span className="pi-logrow__attempt">没有任何音源被尝试</span>
        ) : null}
      </div>
    </div>
  );
}

/** 「实际」那一栏：探到容器就写容器 + 采样率/码率，没探到就退回档位名。 */
function describeActual(entry: QualityLogEntry): string {
  const parts: string[] = [];
  if (entry.container) parts.push(entry.container.toUpperCase());
  if (entry.sampleRate) parts.push(`${formatKHz(entry.sampleRate)}kHz`);
  else if (entry.bitrate) parts.push(`${Math.round(entry.bitrate)}kbps`);
  if (parts.length === 0) return qualityLabel(entry.quality);
  return `${parts.join(' ')}（${qualityLabel(entry.quality)}）`;
}

function qualityLabel(quality: Quality | undefined): string {
  if (!quality) return '无';
  return `${QUALITY_LABEL[quality]}（${quality}）`;
}

function formatKHz(sampleRate: number): string {
  const khz = sampleRate / 1000;
  return Number.isInteger(khz) ? String(khz) : khz.toFixed(1);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}
