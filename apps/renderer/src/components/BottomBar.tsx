import { useCallback, useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { HomeBar } from '../pages/HomePage';
import { usePlayer } from '../state/player';
import { useUi } from '../state/ui';

/**
 * 歌单 / 拼贴页底部的进度条部件（第十八轮第 5、8、10 条，用户 m01482）。
 *
 * 前因：第十六轮第 4 条(d) 给「我的喜欢」的拼贴墙挂过一条 `persistent`（常驻档）底栏，
 * 当时的要求是「拼贴页的键要一直看得见」。第十八轮第 5 条把这条规则**收回去**了 ——
 * 用户贴的图 3 就是那个「键全露」的截图，说它「正常应该与歌曲播放页的表现一致，
 * 即常态只显示进度条，鼠标悬停才放大显示其他功能」。所以这里挂的是**同一个** `HomeBar`
 * （不带常驻档），开合完全交给 `global.css` 的 `:hover`，和播放页逐像素一致。
 *
 * 第 8 条：点这条药丸 = 回到歌曲播放页。浮层（歌单 / 歌手 / 专辑 / 当前播放）也算
 * 「歌单页」，所以顺手把它们收掉，否则人回到播放页了上面还盖着一层玻璃。
 *
 * 第 10 条：平凡风格下它也在（两个风格共用这一个挂载组件，挂载点是 `MinePage`
 * 的「我的喜欢」页与 `SongListOverlay`）。
 *
 * 点判定：只有「原地按一下」（位移 < 6px、按下不到 400ms）才算点击。拖进度条 / 拖音量 /
 * 长按都留给控件自己，不然拖一次进度就被拽回播放页。控件（button / input）上起的点击也不抢。
 */
export function BottomBar(): ReactNode {
  const song = usePlayer((s) => s.currentSong);
  const navigate = useUi((s) => s.navigate);
  const closePlaylist = useUi((s) => s.closePlaylist);
  const closeSongs = useUi((s) => s.closeSongs);
  const press = useRef<{ x: number; y: number; at: number } | null>(null);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    press.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
  }, []);

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      const start = press.current;
      press.current = null;
      if (start === null) return;
      const target = event.target;
      // 播放 / 上下首 / 音量 / 进度条自己有事要做，点到它们就不抢。
      if (target instanceof HTMLElement && target.closest('button, input, select, a') !== null) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      if (event.timeStamp - start.at > 400) return;
      closePlaylist();
      closeSongs();
      navigate('home');
    },
    [closePlaylist, closeSongs, navigate],
  );

  if (song === null) return null;

  return (
    <div
      className="pi-collage-bar"
      data-collage-bar="true"
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <HomeBar song={song} />
    </div>
  );
}
