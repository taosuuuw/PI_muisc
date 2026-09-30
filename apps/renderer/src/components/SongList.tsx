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
 */
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
}

export function SongList({ songs, onSelect, metaOf, disablePlay, hint, emptyText }: SongListProps) {
  const play = usePlayer((s) => s.play);
  const playingId = usePlayer((s) => s.currentSong?.id);
  const isPlaying = usePlayer((s) => s.status === 'playing');

  if (songs.length === 0) {
    return <div className="pi-placeholder">{emptyText ?? '这里还没有歌曲。'}</div>;
  }

  return (
    <div className="pi-songlist" data-song-list="true" data-song-list-count={songs.length}>
      <ol className="pi-songlist__rows" data-song-list-rows="true">
        {songs.map((song, index) => {
          const active = song.id === playingId;
          const cover = coverAt(song.album?.coverUrl, 120);
          const meta = metaOf?.(song) ?? song.album?.name ?? '';
          return (
            <li key={`${song.id}-${index}`} className="pi-songlist__item">
              <button
                type="button"
                className="pi-songrow"
                data-song-row={song.id}
                data-song-row-index={index}
                data-playing={active ? 'true' : 'false'}
                title={`${song.name} - ${artistNames(song)}`}
                onClick={() => {
                  onSelect(song);
                  if (!disablePlay) void play(songs, index);
                }}
              >
                <span className="pi-songrow__no">
                  {active ? <Icon name="waveform" size={14} /> : index + 1}
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
