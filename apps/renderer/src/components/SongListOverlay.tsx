import { useEffect, type ReactNode } from 'react';
import { MODE_LABEL } from '@pi/player-core';
import type { Song } from '@pi/shared';
import { errorMessage } from '../bridge';
import { coverAt } from '../lib/cover';
import { useAlbumSongs, useArtistSongs, useRecommend } from '../lib/queries';
import { usePlayer } from '../state/player';
import { useUi, type SongListTarget } from '../state/ui';
// 第十八轮第 5/8/10 条：歌单浮层底部那条药丸（与播放页同款 + 点它回播放页）。
import { BottomBar } from './BottomBar';
import { Icon } from './Icons';
import { PlaylistDetail } from './PlaylistDetail';
// 第十七轮第 ②③ 条：浮层里的歌曲列表也跟风格走 —— 平凡 = 竖排列表，先锋 = 队列拼贴。
import { SongCollage } from './SongCollage';
import { SongList } from './SongList';

/**
 * 歌曲卡片列表浮层（用户第八轮第 6 条；第九轮第 2、8 条把歌手 / 专辑 / 播放列表也并进来）。
 *
 * 以前从环形菜单的歌单封面点进一个歌单，是**换一整页**（`mine:playlists` / `playlist:star`
 * 那两个页面里塞一份 `PlaylistDetail`）——用户的原话是「不要进入单独的歌单页（删去）」。
 * 现在改成：仍然停在歌曲播放页，整页玻璃模糊 + 中间浮出一张卡片列表。
 *
 * 第九轮第 8 条又把环形菜单的「播放列表」也改成同一套卡片（原来是个 `.pi-queue` 行列表抽屉）。
 *
 * 浮层挂在 `App` 里而不是 `HomePage` 里，是为了让 `backdrop-filter` 能糊到**整页**
 * （包括沉浸式背景、左下角名片、底部进度条）；挂在页面内部的话会连带把浮层自己一起糊掉。
 * 打开的那几个入口（环形菜单的封面环、我的歌单/收藏页的网格、名片里的歌手/专辑名、
 * 环形菜单的「播放列表」）都会顺手 `navigate('home')`，所以它总是出现在播放页上。
 */
export function SongListOverlay(): ReactNode {
  const playlist = useUi((s) => s.openedPlaylist);
  const closePlaylist = useUi((s) => s.closePlaylist);
  const songs = useUi((s) => s.openedSongs);
  const closeSongs = useUi((s) => s.closeSongs);
  /**
   * 第十七轮第 ③ 条：先锋风格的曲目列表是队列拼贴，要给浮层挂一个 `--collage` 修饰类，
   * 由 `overlays.css` 把拼贴从 `fixed inset:0` 收回正文格里（不然它会盖住浮层顶栏）。
   */
  const uiStyle = useUi((s) => s.uiStyle);
  const collage = uiStyle === 'avant';

  /**
   * 第九轮第 3 条：歌单浮层的「返回」键删掉了，退出方式只剩「点玻璃空白处」与 Esc。
   * 歌单那一档的 Esc 在 `PlaylistDetail` 里已经有一份，这里只管歌手/专辑/队列。
   */
  useEffect(() => {
    if (songs === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeSongs();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [songs, closeSongs]);

  if (playlist !== null) {
    return (
      <div
        className={collage ? 'pi-listoverlay pi-listoverlay--collage' : 'pi-listoverlay'}
        data-song-list-overlay="true"
        data-playlist={playlist.id}
        onClick={(event) => {
          // 只有点到玻璃层本身（卡片盒子之外）才关；点盒子里冒泡上来的不算。
          if (event.target === event.currentTarget) closePlaylist();
        }}
      >
        <div
          className="pi-listoverlay__sheet"
          role="dialog"
          aria-modal="true"
          aria-label={playlist.name}
        >
          {/* key：换一个歌单就整块重挂，滚动位置、加载更多、拖拽焦点全部回到初始态。 */}
          <PlaylistDetail key={playlist.id} playlist={playlist} onClose={closePlaylist} />
        </div>
        {/* 第十八轮第 5/8/10 条（用户 m01482）：歌单页底部也要有那条药丸（与播放页同款，
            常态只留进度条），点它回歌曲播放页 —— `BottomBar` 自己会把这层浮层收掉。
            挂在浮层内是为了盖在玻璃之上；`.pi-collage-bar` 的 fixed 定位在浮层的
            堆叠上下文里照样成立（浮层 z-index 18）。 */}
        <BottomBar />
      </div>
    );
  }

  if (songs !== null) return <SongsListOverlay target={songs} onClose={closeSongs} />;

  return null;
}

interface SongsListProps {
  target: SongListTarget;
  onClose: () => void;
}

/**
 * 歌手 / 专辑 / 当前播放：同一套「标题 + 卡片流」（用户第九轮第 2、8 条）。
 *
 * 歌手与专辑走第九轮新加的两条通道（`library:artist-songs` / `library:album-songs`，
 * 见 `packages/ipc` 与 `packages/ncm-client`）；「当前播放」那一档直接读活着的 `usePlayer`——
 * 它不该被快照住，队列随时在变（点卡片进队列时用的是 `playAt`，不是把队列替换掉）。
 */
function SongsListOverlay({ target, onClose }: SongsListProps): ReactNode {
  const kind = target.kind;

  const artistQuery = useArtistSongs(target.id, kind === 'artist', 50);
  const albumQuery = useAlbumSongs(target.id, kind === 'album', 100);
  // 「每日推荐」那一档：走 `library:recommend`（`/recommend/songs`），和歌手/专辑同一副身体。
  const dailyQuery = useRecommend(kind === 'daily');

  const queue = usePlayer((s) => s.queue);
  const allSongs = usePlayer((s) => s.songs);
  const current = usePlayer((s) => s.currentSong);
  const mode = usePlayer((s) => s.mode);
  const cycleMode = usePlayer((s) => s.cycleMode);
  const playAt = usePlayer((s) => s.playAt);
  const play = usePlayer((s) => s.play);

  const queueSongs = queue.ids
    .map((id) => allSongs[id])
    .filter((song): song is Song => song !== undefined);

  const list: readonly Song[] =
    kind === 'queue'
      ? queueSongs
      : ((kind === 'artist'
          ? artistQuery.data?.tracks
          : kind === 'daily'
            ? dailyQuery.data?.tracks
            : albumQuery.data?.tracks) ?? []);

  const query = kind === 'artist' ? artistQuery : kind === 'daily' ? dailyQuery : albumQuery;
  const loading = kind !== 'queue' && query.isPending;
  const failure = kind === 'queue' ? null : query.error;
  /** 第十七轮第 ②③ 条：同一个浮层，平凡给竖排列表、先锋给队列拼贴。 */
  const collage = useUi((s) => s.uiStyle) === 'avant';

  const onSelect = (song: Song): void => {
    if (kind === 'queue') {
      // 队列里点卡片 = 跳到那一首（保留整条队列），不是把队列换成这一首。
      const index = queueSongs.findIndex((item) => item.id === song.id);
      if (index >= 0) void playAt(index);
    } else {
      // 歌手/专辑里点卡片 = 这一串当播放队列，和搜索浮层一致。
      const index = list.findIndex((item) => item.id === song.id);
      void play([...list], index < 0 ? 0 : index);
    }
    /**
     * 用户 m04892：先锋档的队列拼贴要「点一下先放大、在放大块上再点一下才进播放页」，
     * 与歌单详情那面拼贴（`PlaylistDetail`，它的 `onSelect` 是 `select`、不收浮层）一致。
     * 所以拼贴这一档点第一下**不能**收浮层 —— 收掉就再没有第二次点击的机会了，
     * 第二下交给 `SongCollage` 自己的 `enterPlayer()`（等放大动画放完再收浮层 + 回播放页）。
     * 平凡档是竖排列表，点一行就收浮层，行为不变。
     */
    if (!collage) onClose();
  };

  const cover = coverAt(kind === 'queue' ? current?.album?.coverUrl : target.coverUrl, 400);
  const label =
    kind === 'artist'
      ? '歌手'
      : kind === 'album'
        ? '专辑'
        : kind === 'daily'
          ? '每日推荐'
          : '当前播放';
  const collageCls = collage ? 'pi-listoverlay pi-listoverlay--songs pi-listoverlay--collage' : 'pi-listoverlay pi-listoverlay--songs';

  return (
    <div
      className={collageCls}
      data-song-list-overlay="true"
      data-songs={kind}
      data-target-id={target.id}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="pi-listoverlay__sheet pi-songslist" role="dialog" aria-modal="true" aria-label={target.title}>
        <header className="pi-songslist__bar">
          <Icon
            name={kind === 'artist' ? 'artist' : kind === 'album' ? 'album' : kind === 'daily' ? 'music' : 'list'}
            size={16}
          />
          <strong>{label}</strong>
          <span className="pi-detail__spacer" />
          {kind === 'queue' ? (
            <button
              type="button"
              className="pi-btn pi-btn--small"
              data-queue-mode
              onClick={cycleMode}
              title={`播放模式：${MODE_LABEL[mode]}（点击切换）`}
            >
              {MODE_LABEL[mode]}
            </button>
          ) : null}
        </header>

        <div className="pi-songslist__hero">
          {cover ? (
            <img className="pi-songslist__cover" src={cover} alt="" />
          ) : (
            <div className="pi-songslist__cover pi-plcard__cover--empty">
              <Icon name="music" size={30} />
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <h2 className="pi-songslist__title">{target.title}</h2>
            <p className="pi-page-sub">
              {target.subtitle === undefined ? '' : `${target.subtitle} · `}
              {list.length} 首
            </p>
          </div>
        </div>

        <div className="pi-songslist__body">
          {failure !== null && failure !== undefined ? (
            <p className="pi-placeholder">{errorMessage(failure)}</p>
          ) : loading ? (
            <p className="pi-placeholder">正在加载…</p>
          ) : list.length === 0 ? (
            <p className="pi-placeholder">
              {kind === 'queue' ? '队列还是空的。在列表里点一首歌就会进来。' : '这里还没有歌。'}
            </p>
          ) : collage ? (
            <SongCollage songs={list} onSelect={onSelect} />
          ) : (
            <SongList songs={list} onSelect={onSelect} emptyText="这里还没有歌。" />
          )}
        </div>
      </div>
    </div>
  );
}
