import { useCallback, useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { HomeBar } from '../pages/HomePage';
import { usePlayer } from '../state/player';
import { useUi } from '../state/ui';

/**
 * `document.startViewTransition` 的最小形状（Chromium 111+；本机 Electron 有，取不到就走老路）。
 * 用**结构类型 + unknown 断言**而不是 `interface extends Document`：lib.dom 自己也声明了
 * 这个成员，`extends` 会撞签名（`flushSync` 那条口径允许回调返回 void）。
 */
type ViewTransitionDocument = { startViewTransition?: (callback: () => void) => unknown };

/**
 * 真正换到播放页。**能用 View Transition 就用**（用户第二十五轮第 2 条）。
 *
 * 为什么非它不可：逐帧证明过副本已经**在换页前 48ms** 挂好、全程 `opacity: 1`，
 * 可换页那一瞬仍然有两帧整屏只剩底色（均值 89 → 35 35 → 83）—— 变的是 Chromium 自己
 * 在拆掉旧页、建立新页合成层之间的那点空档，靠「多盖一层 DOM」是盖不住的。
 * View Transition 把旧画面先**截成一张纹理**，新页面画好之后再让那张纹理单向淡出，
 * 于是换页这一帧不再是「什么都没有」，而是两次绘制结果之间的混合。
 *
 * `flushSync` 是官方口径：React 的状态更新必须在这一帧内同步落地，快照才对得上。
 */
function switchHome(navigate: (id: 'home') => void): void {
  const doc = document as unknown as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== 'function') {
    navigate('home');
    return;
  }
  doc.startViewTransition(() => {
    flushSync(() => navigate('home'));
  });
}

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
  const arriveHome = useUi((s) => s.arriveHome);
  /*
   * 第二十三轮第 2 条：这一下是不是「浮层退场」那一档。
   * 浮层（`.pi-listoverlay`）自己会带着 `data-closing` 淡出，播放页在它底下一直挂着 ⇒
   * 那一路不铺薄幕（铺了就是把正在交接的两边一起糊住）。平凡档的歌单页是**整页**换掉的，
   * 没有能淡出的旧层，所以还是要薄幕。
   */
  const overlayOpen = useUi((s) => s.openedSongs !== null || s.openedPlaylist !== null);
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
      /*
       * 播放 / 上下首 / 音量 / 进度条自己有事要做，点到它们就不抢。
       * 第二十二轮第 3 条之后音量条是**自己接指针的 div**（`components/VolumeSlider.tsx`，
       * 不再是 `<input type=range>`），所以除了控件标签还要显式认 `[data-home-volrange]`：
       * 原地按一下音量条是「设音量」，不该顺带被当成「点空白回播放页」。
       */
      if (
        target instanceof HTMLElement &&
        target.closest('button, input, select, a, [data-home-volrange], [role="slider"]') !== null
      ) {
        return;
      }
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      if (event.timeStamp - start.at > 400) return;
      /*
       * 用户第二十二轮第 4 条：「从歌单页点击进度条部件回到歌曲播放页的加个过渡动画，
       * 不只是指歌单选择页，还指歌单**歌曲展示页**」。
       * 前者是换页（`navigate('home')` 自己会记那一下），后者是**浮层**（`nav` 一直是 home），
       * 所以这里主动声明一次「我回播放页了」，让 `App.tsx` 那层过渡照常放。
       */
      arriveHome(overlayOpen ? 'overlay' : 'page');
      closePlaylist();
      closeSongs();
      /*
       * **换页推迟两帧**（用户第二十五轮第 2 条「还是有闪」的最终修法）。
       *
       * 逐合成帧亮度实测：换页后那两帧整屏只剩底色（均值 95 → 35 → 35 → 86），
       * 因为 `.pi-page-leaving` 里那份「旧页副本」是**重新挂载**的，图片要两帧才上屏。
       * 这里把真正的换页推到两帧之后：这两帧里副本已经挂在真页面**之上**并画好，
       * 真页面还在下面顶着 ⇒ 换页那一刻屏幕上什么都没变，随后才开始淡出。
       * 浮层那一档（`overlayOpen`）本来就自己交叉淡出，不走这条路。
       */
      if (overlayOpen) {
        switchHome(navigate);
      } else {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => switchHome(navigate));
          });
        });
      }
    },
    [arriveHome, closePlaylist, closeSongs, navigate, overlayOpen],
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
