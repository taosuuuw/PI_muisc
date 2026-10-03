import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MODE_LABEL } from '@pi/player-core';
import type { Song } from '@pi/shared';
import { errorMessage } from '../bridge';
import { coverAt, dailyCoverUrls } from '../lib/cover';
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

  /*
   * 退场相（用户第二十三轮第 2 条：「从歌曲页薄幕淡出回到歌曲播放页……表现都像闪了一下」）。
   *
   * 根因：关闭浮层时这里以前**立刻** `return null` —— 整块纸在一帧里消失、底下那张播放页
   * 同时接管，再叠上那层近乎不透明的薄幕，两次硬切拼在一起就是「闪一下」。
   * 现在关掉之后再陪跑 `OVERLAY_EXIT_MS`：期间用**上一次的内容**继续渲染，并挂
   * `data-closing` 让浮层自己淡出（`overlays.css` 的 `pi-listoverlay-crossfade-out`）。
   * 播放页一直在它下面渲染着，所以这一下是真的交叉淡出，而不是「先切页再盖一层」。
   */
  const lastPlaylist = useRef(playlist);
  const lastSongs = useRef(songs);
  /*
   * 记住「最后一次打开的是哪一个」，并且**互斥地**清掉另一份：两者共用同一个浮层入口，
   * 若只记住不清，从「歌曲列表」浮层退场时会把上一轮打开过的**歌单**又渲染出来
   * （退场那 320ms 里显示错了内容，探针按 `[data-songs]` 找不到也会假红）。
   */
  if (playlist !== null) {
    lastPlaylist.current = playlist;
    lastSongs.current = null;
  }
  if (songs !== null) {
    lastSongs.current = songs;
    lastPlaylist.current = null;
  }
  const open = playlist !== null || songs !== null;
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return undefined;
    }
    if (!mounted) return undefined;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, OVERLAY_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

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

  if (!mounted) return null;
  // 退场期间用记住的那一份继续渲染（store 已经清空了）。
  const shownPlaylist = playlist ?? lastPlaylist.current;
  const shownSongs = songs ?? lastSongs.current;
  const exitAttr = closing ? 'true' : undefined;

  if (shownPlaylist !== null) {
    return (
      <div
        className={collage ? 'pi-listoverlay pi-listoverlay--collage' : 'pi-listoverlay'}
        data-song-list-overlay="true"
        data-playlist={shownPlaylist.id}
        data-closing={exitAttr}
        onClick={(event) => {
          // 只有点到玻璃层本身（卡片盒子之外）才关；点盒子里冒泡上来的不算。
          if (event.target === event.currentTarget) closePlaylist();
        }}
      >
        <div
          className="pi-listoverlay__sheet"
          role="dialog"
          aria-modal="true"
          aria-label={shownPlaylist.name}
        >
          {/* key：换一个歌单就整块重挂，滚动位置、加载更多、拖拽焦点全部回到初始态。 */}
          <PlaylistDetail key={shownPlaylist.id} playlist={shownPlaylist} onClose={closePlaylist} />
        </div>
        {/* 第十八轮第 5/8/10 条（用户 m01482）：歌单页底部也要有那条药丸（与播放页同款，
            常态只留进度条），点它回歌曲播放页 —— `BottomBar` 自己会把这层浮层收掉。
            挂在浮层内是为了盖在玻璃之上；`.pi-collage-bar` 的 fixed 定位在浮层的
            堆叠上下文里照样成立（浮层 z-index 18）。 */}
        <BottomBar />
      </div>
    );
  }

  if (shownSongs !== null) {
    return <SongsListOverlay target={shownSongs} onClose={closeSongs} closing={closing} />;
  }

  return null;
}

interface SongsListProps {
  target: SongListTarget;
  onClose: () => void;
  /** 退场相（用户第二十三轮第 2 条）：正在淡出，见 `OVERLAY_EXIT_MS`。 */
  closing: boolean;
}

/**
 * 浮层的退场相时长（ms，用户第二十三轮第 2 条）：与 `overlays.css` 的
 * `pi-listoverlay-crossfade-out`（300ms）对齐并留一点余量。
 */
const OVERLAY_EXIT_MS = 320;

/**
 * 歌手 / 专辑 / 当前播放：同一套「标题 + 卡片流」（用户第九轮第 2、8 条）。
 *
 * 歌手与专辑走第九轮新加的两条通道（`library:artist-songs` / `library:album-songs`，
 * 见 `packages/ipc` 与 `packages/ncm-client`）；「当前播放」那一档直接读活着的 `usePlayer`——
 * 它不该被快照住，队列随时在变（点卡片进队列时用的是 `playAt`，不是把队列替换掉）。
 */
function SongsListOverlay({ target, onClose, closing }: SongsListProps): ReactNode {
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

  /*
   * 抬头的封面。用户第二十一轮第 2 条：「每日推荐」既没有歌单 id 也没有歌单封面
   * （`target.coverUrl` 是空的），所以退到前几首歌的专辑封面 —— 和歌单卡那张拼图同一个来源。
   */
  const cover =
    coverAt(kind === 'queue' ? current?.album?.coverUrl : target.coverUrl, 400) ??
    (kind === 'daily' ? dailyCoverUrls(dailyQuery.data?.tracks, 1)[0] : undefined);
  const label =
    kind === 'artist'
      ? '歌手'
      : kind === 'album'
        ? '专辑'
        : kind === 'daily'
          ? '每日推荐'
          : '当前播放';
  const collageCls = collage
    ? 'pi-listoverlay pi-listoverlay--songs pi-listoverlay--collage'
    : 'pi-listoverlay pi-listoverlay--songs';

  /**
   * 诊断（用户 m00597 第 2 条「平凡模式进入每日推荐歌单页没有歌曲显示」）。
   *
   * 冒烟跑的是隔离档案（`--user-data-dir=<仓库>/.smoke-profile`），所以我那边永远有 32 首、
   * 复现不出用户看到的「什么都没有」。主进程这边已经把渲染层以 `[pi/` 开头的 console
   * 转发进 pi-launch.log（`apps/desktop/src/main/index.ts` 的 `webContents.on('console-message')`），
   * 于是在真机上挂上浮层后打一份快照：列表是空、在 loading、还是报错；纸面/顶栏/正文/首行
   * 各自落在窗口的哪里；uiStyle 到底是 plain 还是 avant。用户复现一次即可拿到事实。
   * 打点只认 daily 这一档，稳定 600ms 后打一次。
   */
  useEffect(() => {
    if (kind !== 'daily') return undefined;
    const timer = window.setTimeout(() => {
      const root = document.querySelector('.pi-listoverlay[data-songs="daily"]');
      const rectOf = (selector: string): string => {
        const box = root?.querySelector(selector)?.getBoundingClientRect();
        return box === undefined
          ? '无'
          : `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`;
      };
      console.info(
        `[pi/daily] ${JSON.stringify({
          uiStyle: collage ? 'avant' : 'plain',
          view: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
          list: list.length,
          loading,
          error: failure === null ? null : errorMessage(failure),
          current: current?.name ?? null,
          barText: root?.querySelector('.pi-songslist__bar strong')?.textContent ?? null,
          bar: rectOf('.pi-songslist__bar'),
          hero: rectOf('.pi-songslist__hero'),
          body: rectOf('.pi-songslist__body'),
          firstRow: rectOf('[data-song-row]'),
          placeholder: root?.querySelector('.pi-placeholder')?.textContent ?? null,
          floor: document.querySelector('[data-collage-bar]') === null ? '无' : '有',
        })}`,
      );
    }, 600);
    return () => window.clearTimeout(timer);
  }, [kind, collage, list.length, loading, failure, current?.name]);

  return (
    <div
      className={collageCls}
      data-song-list-overlay="true"
      data-songs={kind}
      data-target-id={target.id}
      /* 退场相：整层带着这条属性淡出（`overlays.css`），播放页就在它底下 ⇒ 交叉淡出。 */
      data-closing={closing ? 'true' : undefined}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="pi-listoverlay__sheet pi-songslist"
        role="dialog"
        aria-modal="true"
        aria-label={target.title}
      >
        <header className="pi-songslist__bar">
          <Icon
            name={
              kind === 'artist'
                ? 'artist'
                : kind === 'album'
                  ? 'album'
                  : kind === 'daily'
                    ? 'music'
                    : 'list'
            }
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
      {/* **用户 m00341 第 2 条**：「（每日推荐歌单页）底部也没有进度条部件」。
          歌单那一档（上面 `:80`）一直挂着它，`--songs` 这一档（当前播放 / 每日推荐）漏了 ——
          用户要的是「和歌曲播放页一致的那条药丸」，所以这里补上同一个 `BottomBar`：
          它自己 `position: fixed`、没在播歌时返回 null，行为与歌单档 / 我的喜欢页逐像素一致。
          平凡档的列表要在 CSS 里给正文垫出它的高度（`overlays.css` 的 `[data-songs]` 那条），
          先锋档的拼贴本来就是绝对定位铺满，不受影响。 */}
      <BottomBar />
    </div>
  );
}
