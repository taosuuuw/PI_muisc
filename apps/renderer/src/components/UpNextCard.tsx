import type { ReactNode } from 'react';
import type { QueueState } from '@pi/player-core';
import { usePlayer } from '../state/player';
import { coverAt } from '../lib/cover';
import '../styles/up-next-card.css';

/**
 * 「接下来播放」小名片（用户第十七轮第 8 条，对应参考图 5）。
 *
 * 用户原话：「即将播放下一首歌时，加如图 5 所示的小名片，下一首歌刚播放时展示歌曲名片
 * 而不是小名片。」
 *
 * 第十八轮第 11 条（用户 m01482）改了两处：
 * - 「在**左下**显示而不是右下」⇒ 位置跟着歌曲名片一起挪到左下（`styles/up-next-card.css`）；
 * - 「在结束前 **5s** 出现」⇒ 窗口从 10s 收到 5s。
 *
 * 所以这张卡片的生命周期是**一首歌的最后一小段**：
 * - 剩余时间 ≤ `UP_NEXT_WINDOW_MS`（5s）才出现——这是「即将播放」的定义，
 *   不是「队列里还有下一首」就出（那会有一整首歌的时间都挂着它，等于噪声）；
 * - 下一首真的开始播时，剩余时间回到整首，本卡片自己消失；同时左下角那张歌曲名片
 *   按 `HomePage` 的换歌逻辑冒出来（停留 5s，见 `SONG_CARD_SHOW_MS`）——正好就是用户要的交接。
 *
 * 为什么自己算「下一首」而不用现成的函数：`player-core` 只有 `advance`（会真的换歌），
 * 预览下一首得另算，见 `peekNextId`。
 */

/**
 * 剩余多少毫秒之内算「马上要播下一首」（第十八轮第 11 条：结束前 5s）。
 */
export const UP_NEXT_WINDOW_MS = 5_000;

/**
 * 预览队列里的下一首 id（不改状态）。
 *
 * 语义与 `advance` 对齐，四种模式各有说法：
 * - `order`：`ids[(index + 1) % count]`，到尾回头（列表循环）；
 * - `shuffle`：随机排列里的下一个游标。排列没建全（`shuffleOrder.length !== count`）
 *   就返回 `null`——那说明下一个是谁还没定，宁可不显示，也别预告错人；
 * - `repeat-one`：自动播完还是这一首，「下一首」根本不存在，返回 `null`；
 * - `sequence`（顺序播放，用户 m03805 第 4 条）：最后一首后面没有下一首了，返回 `null`，
 *   与 `advance()` 走到末尾就停的行为一致。
 */
export function peekNextId(queue: QueueState): number | null {
  const count = queue.ids.length;
  if (count === 0 || queue.index < 0) return null;
  if (queue.mode === 'repeat-one') return null;
  if (queue.mode === 'sequence' && queue.index >= count - 1) return null;
  if (queue.mode === 'shuffle') {
    if (queue.shuffleOrder.length !== count) return null;
    const cursor = (queue.shuffleCursor + 1) % count;
    return queue.shuffleOrder[cursor] ?? null;
  }
  return queue.ids[(queue.index + 1) % count] ?? null;
}

/**
 * 小名片本体。挂在播放页**左下**角（第十八轮第 11 条；第十七轮时在右下），不接指针事件——
 * 它只是预告，用户想点歌该去点进度条或队列。
 */
export function UpNextCard(): ReactNode {
  const queue = usePlayer((s) => s.queue);
  const songs = usePlayer((s) => s.songs);
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const status = usePlayer((s) => s.status);

  const nextId = peekNextId(queue);
  const next = nextId === null ? null : songs[nextId];
  // 只在「正在播 / 暂停中」出：解析中、出错、全部音源都没地址时不出。
  if (!next || (status !== 'playing' && status !== 'paused')) return null;
  if (durationMs <= 0) return null;
  const remainMs = durationMs - positionMs;
  if (remainMs > UP_NEXT_WINDOW_MS) return null;

  const cover = coverAt(next.album?.coverUrl, 120);
  const artists = next.artists?.map((artist) => artist.name).join(' / ') ?? '';

  return (
    <aside
      className="pi-upnext"
      data-up-next="true"
      data-up-next-id={next.id}
      data-up-next-remain={Math.max(0, Math.round(remainMs / 1000))}
      aria-live="polite"
    >
      {cover ? (
        <img className="pi-upnext__cover" src={cover} alt="" loading="lazy" />
      ) : (
        <span className="pi-upnext__cover pi-upnext__cover--empty" aria-hidden="true" />
      )}
      <span className="pi-upnext__body">
        <span className="pi-upnext__kicker">接下来播放</span>
        <strong className="pi-upnext__name">{next.name}</strong>
        {artists ? <span className="pi-upnext__artists">{artists}</span> : null}
      </span>
    </aside>
  );
}
