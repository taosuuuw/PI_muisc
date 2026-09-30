import { useEffect, useState, type ReactNode } from 'react';
import { AlbumPage } from '../pages/AlbumPage';
import { ArtistPage } from '../pages/ArtistPage';
import { useUi, type SongPageTarget } from '../state/ui';
import { Icon } from './Icons';

/**
 * 专辑页 / 歌手页的**外壳**（M4 剩余项）。
 *
 * 形态：铺满窗口的玻璃页，中间一张 `min(1080px, 100%) × min(760px, 100%)` 的纸，
 * 四段结构 = 顶栏（来源图标 + 「专辑 / 歌手」+ 关闭键）/ 大封面 + 名称 /（页体自己再分曲目与专辑区）。
 * 与 `components/SettingsOverlay.tsx` 同一套相位进出场（`data-phase` + 退场动画跑完才卸载），
 * 与 `components/SongListOverlay.tsx` 同一层 z-index(18) 与同一套玻璃材质 ——
 * 所以它盖得住播放页、又压不过搜索(60)/设置(60)。
 *
 * 挂在 `App` 根部而不是页面里：`backdrop-filter` 要能糊到**整页**（沉浸式背景、左下角名片、
 * 底部进度条），挂在页面内部会连它自己一起糊掉（`SongListOverlay` 的注释里已经踩过这一条）。
 *
 * 与浮层（`openedSongs`）的分工：歌手 / 专辑是**能独立存在的一级页面**，队列那一档仍走浮层。
 * 两边的状态在 `state/ui.ts` 里是两个字段，见那里的注释。
 *
 * 为什么在歌手页里点专辑卡**不重播**进出场：那一跳只换 `target`，`visible` 一直是 true，
 * 所以外壳原样留着、只有页体按新 id 重挂（下面 `key`）。这正是「从歌手页点进专辑页」
 * 该有的手感——不是退出再打开一次。
 */
const EXIT_MS = 280;

export function SongPageOverlay(): ReactNode {
  const target = useUi((s) => s.openedSongPage);
  const close = useUi((s) => s.closeSongPage);
  const open = target !== null;
  /** 卸载要等退场动画跑完，所以「要不要画」与「想不想开着」是两个状态（同 `SettingsOverlay`）。 */
  const [visible, setVisible] = useState(open);
  /** 关的那一瞬间 `target` 已经是 null，但退场动画期间还得画着**上一次**的内容。 */
  const [last, setLast] = useState<SongPageTarget | null>(target);

  useEffect(() => {
    if (target !== null) setLast(target);
  }, [target]);

  useEffect(() => {
    if (open) {
      setVisible(true);
      return;
    }
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, visible]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, open]);

  if (!visible || last === null) return null;
  const shown = target ?? last;
  const artist = shown.kind === 'artist';

  return (
    <div
      className={artist ? 'pi-songpage-overlay pi-songpage-overlay--artist' : 'pi-songpage-overlay'}
      data-song-page-overlay="true"
      /* 冒烟钩子：`data-song-page` 是 artist|album，`data-song-page-id` 是当前那一条的 id，
         页面内部的 `data-artist-*` / `data-album-*` 由页体自己给（见 pages/ArtistPage.tsx）。 */
      data-song-page={shown.kind}
      data-song-page-id={shown.id}
      data-phase={open ? 'in' : 'out'}
      onClick={(event) => {
        // 只有点到玻璃层本身（纸之外）才关；纸里冒泡上来的不算。
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="pi-songpage-overlay__box"
        role="dialog"
        aria-modal="true"
        aria-label={`${artist ? '歌手' : '专辑'}：${shown.title}`}
      >
        <header className="pi-songpage__bar">
          <Icon name={artist ? 'artist' : 'album'} size={16} />
          <strong>{artist ? '歌手' : '专辑'}</strong>
          <span className="pi-detail__spacer" />
          <button
            type="button"
            className="pi-iconbtn"
            data-song-page-close="true"
            aria-label={artist ? '关闭歌手页' : '关闭专辑页'}
            title="关闭（Esc）"
            onClick={close}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        {/* key：换一个歌手 / 专辑就整块重挂，滚动位置与列表内部状态全部回到初始态。 */}
        {artist ? (
          <ArtistPage key={`artist-${shown.id}`} target={shown} />
        ) : (
          <AlbumPage key={`album-${shown.id}`} target={shown} />
        )}
      </section>
    </div>
  );
}
