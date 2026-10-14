/**
 * 平凡风格的歌曲列表（用户第十七轮第 ② 条，参考 image 3 那张竖排列表）。
 *
 * 为什么另起一个组件而不是继续用 `SongCards`：用户把「歌单列表 / 歌曲列表」明确拆成了两套排版——
 * 平凡 = 平铺网格 + 竖排列表，先锋 = 封面卡片轮播 + 队列拼贴。`SongCards`（封面卡片轮播）在新方案里
 * 既不属于平凡（竖排列表）也不属于先锋（拼贴），所以**歌单/歌手/专辑/队列**这些列表都换成这里；
 * `SongCards` 只留给搜索浮层与「添加歌曲」面板（那里是搜索结果流，不是歌单内容）。
 *
 * 交互与 `SongCards` / `SongCollage` 对齐：点一行先 `onSelect(song)`（宿主拿它更新「当前选中」），
 * 再 `play(songs, index)` 把整张列表放上播放队列；`disablePlay` 可以关掉后半步（只读展示位用）。
 *
 * ── 主人本轮第 3 条加的两件事 ──
 * ① **编辑态**（`editing`）：每行**左边**浮出删除键（`onRemove` 决定「删掉」是什么含义：
 *    从云端歌单里删 / 从本地队列里出队），再点一下宿主的那个编辑键就收回去；
 * ② **长按拖动排序**（`onReorder`）：按住一行约 0.32 秒进入拖动，被拖的那行跟着指针走，
 *    松手落在哪就把这一首插到哪（纯函数 `moveInQueue` 负责算新顺序）。
 *    时间阈值与位移容差都在下面两个常量里 —— 短按仍然是「点一下播放」，不抢原来的手感。
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Song } from '@pi/shared';
import { coverAt } from '../lib/cover';
import { artistNames, formatDuration } from '../lib/format';
import { usePlayer } from '../state/player';
import { Icon } from './Icons';

export interface SongListProps {
  songs: readonly Song[];
  onSelect: (song: Song) => void;
  /** 行右侧的补充信息（例如「播放 4 次 · 3 天前」）；缺省显示专辑名。 */
  metaOf?: (song: Song) => string | undefined;
  disablePlay?: boolean;
  hint?: string;
  /** 空列表文案（宿主语境不同：歌单 / 歌手 / 队列）。 */
  emptyText?: string;
  /** 编辑态：每行左边浮出删除键（主人本轮第 3 条）。 */
  editing?: boolean;
  /** 点删除键。宿主决定「删掉」是什么意思（改歌单 / 出队列），本组件只如实报第几首。 */
  onRemove?: (song: Song, index: number) => void;
  /** 长按一行拖动改顺序；不给这个回调就完全没有拖动（只读列表用）。 */
  onReorder?: (from: number, to: number) => void;
}

/** 按住多久算「进入拖动」。比系统双击间隔长一点，短按照旧是「点一下播放」。 */
const DRAG_HOLD_MS = 320;
/** 长按期间挪动超过这么多像素，就当作「在滚动 / 在选字」，放弃进入拖动。 */
const DRAG_CANCEL_PX = 8;

export function SongList({
  songs,
  onSelect,
  metaOf,
  disablePlay,
  hint,
  emptyText,
  editing,
  onRemove,
  onReorder,
}: SongListProps) {
  const play = usePlayer((s) => s.play);
  const playingId = usePlayer((s) => s.currentSong?.id);
  const isPlaying = usePlayer((s) => s.status === 'playing');

  const listRef = useRef<HTMLOListElement>(null);
  /** 长按计时器：到点就把这一行「拎起来」。 */
  const holdRef = useRef<number | null>(null);
  /** 按下时的起点（第几首 + 指针 Y）。 */
  const startRef = useRef<{ index: number; y: number } | null>(null);
  /**
   * 「这一下是拖完之后的收尾点击，别当播放」。
   *
   * 拖动结束一定会再跟一个 `click`（指针从按下到抬起都落在同一行里），
   * 而那时行已经被重排、用户看到的是「拖完就播了」这种莫名其妙的行为。
   * 所以抬起后到那个 click 之间把它置真，由行的 `onClick` 吃掉一次；随后立刻复位
   * （用 0ms 定时器排在 click 之后），免得把下一次真正的点击也吞掉。
   */
  const draggingRef = useRef(false);
  /** 拖动中的位置：`from` = 拎起来的那一行，`to` = 松手会落到的位置，`dy` = 跟手位移。 */
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null);

  if (songs.length === 0) {
    return <div className="pi-placeholder">{emptyText ?? '这里还没有歌曲。'}</div>;
  }

  const clearHold = (): void => {
    if (holdRef.current !== null) {
      window.clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  };

  /** 指针落在第几行上（按每行的竖直中线判定）—— 就是松手后的目标下标。 */
  const targetAt = (clientY: number): number => {
    const items = listRef.current === null ? [] : Array.from(listRef.current.children);
    if (items.length === 0) return 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) continue;
      const rect = item.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return index;
    }
    return items.length - 1;
  };

  const onRowPointerDown = (index: number) => (event: ReactPointerEvent<HTMLElement>) => {
    if (onReorder === undefined || event.button !== 0) return;
    /* 编辑态下的删除键自己处理点击，不要被卷进拖动。 */
    if ((event.target as HTMLElement).closest('[data-song-row-del]') !== null) return;
    startRef.current = { index, y: event.clientY };
    clearHold();
    holdRef.current = window.setTimeout(() => {
      holdRef.current = null;
      draggingRef.current = true;
      setDrag({ from: index, to: index, dy: 0 });
    }, DRAG_HOLD_MS);
    /* 把这一串指针事件锁在这一行上：指针滑出行外也还收得到 move / up。 */
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onListPointerMove = (event: ReactPointerEvent<HTMLOListElement>): void => {
    const start = startRef.current;
    if (start === null) return;
    if (drag === null) {
      /* 还没到长按时长就挪开了：多半是在滚列表或选字，放掉这一轮。 */
      if (Math.abs(event.clientY - start.y) > DRAG_CANCEL_PX) {
        clearHold();
        startRef.current = null;
      }
      return;
    }
    setDrag({ from: start.index, to: targetAt(event.clientY), dy: event.clientY - start.y });
  };

  const onListPointerUp = (): void => {
    clearHold();
    const start = startRef.current;
    startRef.current = null;
    const current = drag;
    setDrag(null);
    if (current !== null && start !== null && current.to !== start.index) {
      onReorder?.(start.index, current.to);
    }
    if (draggingRef.current) {
      /* 排在紧随其后的那个 click 之后再复位（0ms 就够，click 比它早）。 */
      window.setTimeout(() => {
        draggingRef.current = false;
      }, 0);
    }
  };

  const dragging = drag !== null;

  return (
    <div
      className="pi-songlist"
      data-song-list="true"
      data-song-list-count={songs.length}
      data-song-list-editing={editing === true ? 'true' : 'false'}
      data-song-list-sortable={onReorder !== undefined ? 'true' : 'false'}
      {...(dragging ? { 'data-song-list-dragging': 'true' } : {})}
    >
      <ol
        className="pi-songlist__rows"
        data-song-list-rows="true"
        ref={listRef}
        onPointerMove={onListPointerMove}
        onPointerUp={onListPointerUp}
        onPointerCancel={onListPointerUp}
      >
        {songs.map((song, index) => {
          const active = song.id === playingId;
          const cover = coverAt(song.album?.coverUrl, 120);
          const meta = metaOf?.(song) ?? song.album?.name ?? '';
          const isDragged = drag?.from === index;
          return (
            <li
              key={`${song.id}-${index}`}
              className="pi-songlist__item"
              data-song-list-item={index}
              {...(isDragged ? { 'data-dragging': 'true' } : {})}
              {...(dragging && drag?.to === index && !isDragged ? { 'data-drop-target': 'true' } : {})}
              {...(isDragged && drag !== null
                ? { style: { transform: `translateY(${drag.dy}px)` } }
                : {})}
            >
              {/* 编辑态左列的删除键：平时宽度为 0（连点击都不接），进编辑态才「浮现」。 */}
              {onRemove !== undefined ? (
                <button
                  type="button"
                  className="pi-songrow__del"
                  data-song-row-del={song.id}
                  aria-label={`移除 ${song.name}`}
                  tabIndex={editing === true ? 0 : -1}
                  onClick={() => onRemove(song, index)}
                >
                  <Icon name="close" size={13} />
                </button>
              ) : null}
              <button
                type="button"
                className="pi-songrow"
                data-song-row={song.id}
                data-song-row-index={index}
                data-playing={active ? 'true' : 'false'}
                title={`${song.name} - ${artistNames(song)}`}
                onPointerDown={onRowPointerDown(index)}
                onClick={() => {
                  /* 拖完那一下的收尾点击不算播放（见 `draggingRef` 的注释）。 */
                  if (draggingRef.current) {
                    draggingRef.current = false;
                    return;
                  }
                  onSelect(song);
                  if (!disablePlay) void play(songs, index);
                }}
              >
                <span className="pi-songrow__no">
                  {dragging && onReorder !== undefined ? (
                    <Icon name="grip" size={14} />
                  ) : active ? (
                    <Icon name="waveform" size={14} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="pi-songrow__cover">
                  {cover ? (
                    <img src={cover} alt="" loading="lazy" />
                  ) : (
                    <span className="pi-songrow__cover-empty">
                      <Icon name="music" size={16} />
                    </span>
                  )}
                  <span className="pi-songrow__badge" aria-hidden="true">
                    <Icon name={active && isPlaying ? 'pause' : 'play'} size={11} />
                  </span>
                </span>
                <span className="pi-songrow__main">
                  <span className="pi-songrow__name">{song.name}</span>
                  <span className="pi-songrow__artists">{artistNames(song) || '未知歌手'}</span>
                </span>
                <span className="pi-songrow__meta">{meta}</span>
                <span className="pi-songrow__time">{formatDuration(song.durationMs)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {hint ? <p className="pi-songlist__hint">{hint}</p> : null}
    </div>
  );
}
