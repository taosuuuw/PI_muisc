import type { ReactNode } from 'react';
import type { Playlist } from '@pi/shared';
import { coverAt } from '../lib/cover';
import { Icon } from './Icons';

export interface PlaylistGridProps {
  playlists: readonly Playlist[];
  onOpen: (playlist: Playlist) => void;
  /**
   * 网格**最前面**那张特殊卡（推荐歌单面的「每日推荐」）。
   *
   * 给了它就不再因为「上游没给推荐歌单」而整块退化成空态：那张卡和 `/personalized`
   * 是两个接口，空窗不该连带把每日推荐一起藏掉。收藏面不传，行为一字不变。
   */
  leading?: ReactNode;
}

export function PlaylistGrid({ playlists, onOpen, leading }: PlaylistGridProps) {
  if (playlists.length === 0 && leading === undefined) {
    return <div className="pi-placeholder">这里还没有歌单。</div>;
  }

  return (
    <div className="pi-grid">
      {leading}
      {playlists.map((playlist) => {
        const cover = coverAt(playlist.coverUrl, 400);
        return (
          <button
            key={playlist.id}
            type="button"
            className="pi-plcard"
            /* 第十五轮第 2 条：给歌单卡补上稳定标记，和悬浮球面板里的歌单卡用同一套名字，
               方便冒烟探针按 `[data-playlist-card]` 数卡 / 认歌单（原来只有 `.pi-plcard` 可用）。 */
            data-playlist-card="true"
            data-playlist-id={playlist.id}
            data-playlist-count={playlist.trackCount}
            data-playlist-name={playlist.name}
            onClick={() => onOpen(playlist)}
            title={playlist.name}
          >
            {cover ? (
              <img className="pi-plcard__cover" src={cover} alt="" loading="lazy" />
            ) : (
              <div className="pi-plcard__cover pi-plcard__cover--empty">
                <Icon name="music" size={26} />
              </div>
            )}
            <span className="pi-plcard__name">{playlist.name}</span>
            <span className="pi-plcard__meta">
              {playlist.trackCount} 首
              {playlist.creator ? ` · ${playlist.creator}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}
