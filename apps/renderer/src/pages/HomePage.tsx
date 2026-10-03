import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MODE_LABEL } from '@pi/player-core';
import type { LyricTheme, PlayMode, Song } from '@pi/shared';
import { errorMessage } from '../bridge';
import { CommentPanel } from '../components/CommentPanel';
import { Icon, type IconName } from '../components/Icons';
import { ImmersiveBackground } from '../components/ImmersiveBackground';
import type { NavId } from '../components/NavDrawer';
import { LyricStage } from '../components/LyricStage';
import { PiQuickOrb, QUICK_ORB_LEAVE_MS } from '../components/PiQuickOrb';
import { PlaylistPickerOverlay } from '../components/PlaylistPickerOverlay';
import { UpNextCard } from '../components/UpNextCard';
import { VolumeSlider } from '../components/VolumeSlider';
import type { QuickSwipeDirection } from '../components/PiQuickOrb';
import { PiQuickPlaylistCard, PiQuickSettingsCard } from '../components/PiQuickPanels';
import type { QuickPlaylistItem } from '../components/PiQuickPanels';
import { audioTooltip, claimedLabel, measuredLabel, sourceLabel } from '../lib/audio-label';
import { coverAt } from '../lib/cover';
import { artistNames, formatDuration } from '../lib/format';
import type { ThemeColors } from '../lib/cover-palette';
import { useSongPalette } from '../lib/song-palette';
import { useAccount, useLikeCheck, useLyric, useSettings, useToggleLike } from '../lib/queries';
import { usePlayer } from '../state/player';
import { useUi } from '../state/ui';

/**
 * 播放器主页（用户 m05361 第 2 条；用户 m08768 第 6 条改成「整页给歌词」）。
 *
 * 两种样子：
 * - 什么都没放过 → 空白页 + 天蓝渐变的 PI 大字（左侧悬浮球是唯一入口，这里只做提示）；
 * - 正在播放 / 上次听过（`restoreLast`）→ 歌词占满整页，左上角挂一张「封面缩略图 + 歌名 +
 *   歌手·专辑 + 音源状态」的小名片，底部一条浮空的**时间 + 进度条**（第八轮第 2 条按用户
 *   要求只留进度条本身：播放键在悬浮球的环形菜单里，音量在设置的「播放」页里）。
 *
 * 第八轮又加了三件事：
 * - 第 1 条：没人操作时小名片 / 进度条 / 悬浮球自动隐藏，指针移到哪一件才叫回哪一件
 *   （开关在 `App.tsx` 的 `data-idle` 上，规则在 `global.css`）；
 * - 第 3 条：点某一句歌词 = 跳到那一句播放（原来只切换「看哪一句」，「回到当前」键也删了）；
 * - 第 4 条：整页配色改由当前歌曲封面提取（`useSongPalette`），歌词动效跟着歌走。
 *
 * 第九轮（用户 m01280）改了四处：
 * - 第 1 条：底部进度条默认收成原来的约 1/4，指针移上去才变长；左边浮出暂停键、
 *   右边浮出音量键，指针停在音量键上再向上弹出一条**竖向**音量条；
 * - 第 2 条：点空白处浮出的那层遮罩与四角按键**全部删掉**（原来是 `Frame` / `data-frame-layer`），
 *   名片从左上挪到左下；点名片向上伸出一个竖排操作框（评论/收藏/歌曲信息/分享）；
 *   名片直接显示封面、歌名、歌手（可点）、专辑（可点）与音质，点歌手/专辑名走 `openSongs`
 *   出「歌手歌曲卡片 / 专辑歌曲卡片」（实现在 `components/SongListOverlay.tsx`）。
 *
 * 第十九轮第 8 条（用户 m02213）：第九轮那个「点一下向上伸出的操作框」整块删掉
 * （连同它的 `actionsOpen` 状态、`data-card-actions` 抓手与 `styles/global.css` 里的 `.pi-actions` 样式）：
 * - 四项能力搬到**封面四角**——鼠标悬停在封面上才浮现的四个圆形半透明键
 *   （左上歌曲信息 / 右上分享 / 左下评论 / 右下收藏），常态隐藏；
 * - 名片右下角另挂一颗小爱心（`data-card-like`），进页就是当前这首歌真实的收藏态。
 * 两处「收藏」共用同一份数据源（`useAccount` / `useLikeCheck` / `useToggleLike`），不另造事实。
 *
 * 「上次听过的歌」由 `lib/last-played.ts` 存在 localStorage 里，启动时灌回播放状态，
 * 所以这里只认 `currentSong`，不用自己再管持久化。
 */
export function HomePage(): ReactNode {
  const song = usePlayer((s) => s.currentSong);
  const src = usePlayer((s) => s.src);
  const seek = usePlayer((s) => s.seek);
  /**
   * 这首歌的配色（用户第八轮第 4 条）。
   *
   * 歌词动效的颜色以前只跟全局主题色走（`lyric-themes.css` 里 `--pi-th-*` 回退到 `--pi-primary`）。
   * 现在从封面提色，并且把同一份颜色**两路**发下去：
   * - 写成 `--pi-th-primary / --pi-th-accent / --pi-th-surface`：CSS 里引用这三个变量的样式自动跟着变；
   * - 当 `palette` prop 交给 `LyricStage` → 主题组件（canvas / SVG 里把颜色画死的那些只能读 prop）。
   */
  const palette = useSongPalette(song);

  /**
   * 第十六轮第 3 条（用户 m07538）：「去掉切换歌曲的小名片，替代为显示播放页左下角的歌曲名片」。
   *
   * 原来切歌会从屏幕右侧飘出 `components/SongChangeCard.tsx` 那张独立小名片（和系统 Media
   * Session 的 SMTC 弹窗并存）。现在那个组件连同挂载一起删了，改成**左下角这张名片自己**在
   * 切歌时弹一下：`data-reveal='true'` 触发 `global.css` 里那条进场动画（上浮 + 描边发光），
   * 时间一到就落回常态。
   *
   * 第十八轮第 11 条（用户 m01482）：「下一首歌曲播放时出现的歌曲名片持续 5s」
   * ⇒ 停留时长从 3.4s（沿用被删掉那张小名片的 `SHOW_MS`）改成 `SONG_CARD_SHOW_MS = 5000`。
   */
  const [cardRevealed, setCardRevealed] = useState(false);
  // `undefined` = 还没跑过「首帧」（挂载后第一次进 effect）。跟 `null` 分开：`null` 是「跑过、
  // 但那时还没有歌」，`undefined` 才是「刚挂上、账本还是空的」。
  const lastSongId = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (!song) return undefined;
    /*
     * 用户 m01402 第 8 条：挂载后的第一趟**只记账、不露名片**。
     * 回到播放页（重挂）时当前这首歌并不算「刚切完」，凭空冒一张名片正是用户否掉的那件事；
     * 但要是刚在别处切完歌就回来了（模块级窗口还活着、而且是同一首），接着把尾巴露完。
     */
    if (lastSongId.current === undefined) {
      lastSongId.current = song.id;
      const tail = cardRevealUntil - Date.now();
      if (cardRevealSongId !== song.id || tail < CARD_REVEAL_MIN_TAIL_MS) return undefined;
      setCardRevealed(true);
      const tailTimer = window.setTimeout(() => setCardRevealed(false), tail);
      return () => window.clearTimeout(tailTimer);
    }
    if (lastSongId.current === song.id) return undefined;
    lastSongId.current = song.id;
    // 真的换歌了：把窗口写给模块级账本（重挂后还能接着露），本页立刻露 SONG_CARD_SHOW_MS。
    cardRevealSongId = song.id;
    cardRevealUntil = Date.now() + SONG_CARD_SHOW_MS;
    setCardRevealed(true);
    const timer = window.setTimeout(() => setCardRevealed(false), SONG_CARD_SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [song]);

  /**
   * 第十六轮第 6 条：点空白处 = 在那一点浮出一颗 PI 圆键（替代被删掉的悬浮球）。
   * 第十七轮第 1 条起改成「按下即浮现」，并把这根指针交给那颗键接管（跟手）。
   * 收回已划开的快捷卡片、以及后续「拖到哪就停在哪」的落点写回，都在 `summonQuick` /
   * `QuickDock` 里做掉（`QuickDock` 自己取 `setQuickPos`），所以这里只留一个入口。
   */
  const summonQuick = useUi((s) => s.summonQuick);

  /**
   * 「收藏到歌单」浮窗（用户 m02898 第 3 条）。
   *
   * 状态放在**页面**这一层而不是名片里：浮窗要挂在 `section.pi-home` 下面（和 `<QuickDock />` 并排），
   * 才不会被名片自己那条进场动画的 transform 收成局部定位（fixed 的参照物一旦变成名片，
   * 就不是「窗口正中心」了）。开关由名片封面右下角那颗 `data-card-action="like"` 键通过
   * `onAddToPlaylist` 回调上来。
   */
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * 加歌成功的轻提示。名片里那条 `toast`（`.pi-home__toast`）是 `HomeCard` 自己的状态，
   * 而浮窗是页面级的，所以这里另存一句、复用同一个类名（位置由 `styles/playlist-picker.css` 的
   * `.pi-picker-toast` 挪到窗口底部居中）。
   */
  const [pickerToast, setPickerToast] = useState<string | null>(null);

  useEffect(() => {
    if (!pickerToast) return undefined;
    const timer = window.setTimeout(() => setPickerToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [pickerToast]);

  if (!song) return <EmptyStage />;

  const themeVars =
    palette === null
      ? undefined
      : ({
          '--pi-th-primary': palette.primaryColor,
          '--pi-th-accent': palette.accentColor,
          '--pi-th-surface': palette.backgroundColor,
        } as CSSProperties);

  return (
    <section className="pi-home" style={themeVars}>
      <Backdrop song={song} />
      <StageMood song={song} />
      <div className="pi-home__body">
        <div
          className="pi-home__stage"
          role="presentation"
          onPointerDown={(event) => {
            /*
             * 第十六轮第 6 条：点空白处 = 浮出一颗 PI 圆键（替代被删掉的悬浮球）。
             * 第十七轮第 1 条：改成「按下即浮现」，并把这根指针交给键接管（跟手）。
             * 第十八轮第 2 条（用户 m01482）曾把落点改成固定家位；**用户 m00001 第 1 条**
             * 推翻了它：「歌曲播放页的圆球只在鼠标点击对应的位置出现」。所以这里重新用
             * `event.clientX/clientY`，并把按下的这根指针递给球当拖动起点（按住不放直接拖，
             * 暗槽当场摊开）——但球的**基准点**就是按下的那一点，拖动只让球在槽里滑，
             * 不再把整颗球搬走（见 `components/PiQuickOrb.tsx`）。
             * 鼠标只认左键（右键留给系统菜单）。
             */
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            // 按钮、输入、进度条、名片、右侧面板、**歌词行自己**都要响应点击。
            //
            // 第十二轮（用户 m04193 第 1/2/3 条）：倾诉 / 时计 / 流光 也铺满整窗之后，
            // 原来那条「整片歌词区（`.pi-home__lyrics`）都算非空白」的判据会让**整页**都点不出
            // 收起手势（这三套的舞台根是 `pointer-events: auto`，空白处的点击目标就是它）。
            // 所以收窄成「只有歌词行算歌词」——舞台空白重新算空白，收起手势回来了；
            // 另外四套铺满主题的根仍是 `pointer-events: none`，空白点击本来就落在这层，行为不变。
            if (
              (event.target as HTMLElement).closest(
                'button, a, input, .pi-home__bar, .pi-home__card, .pi-home__drawer, [data-lyric-line], .pi-lyricstage__line',
              )
            ) {
              return;
            }
            // 第十六轮第 6 条（用户 m07538）：悬浮球删掉之后，「点哪里、哪里就浮出一颗 PI 键」
            // 就是唯一的入口——上划开歌单卡、下划搜索、右划快捷设置、**左划切平凡/先锋**
            //（`QuickDock`）。球浮出来的位置见上面第十八轮第 2 条。
            summonQuick({ x: event.clientX, y: event.clientY }, event.pointerId);
          }}
        >
          <HomeCard
            song={song}
            revealed={cardRevealed}
            onAddToPlaylist={() => setPickerOpen(true)}
          />
          {/* 歌词的可用区：宽高都占满、居中，上下让开名片与进度条。
              舞台自己的尺寸归 `styles/lyric-stage.css` 管，这里只负责把地方腾出来。 */}
          <div className="pi-home__stage-lyrics">
            {/* 「点某一句 = 跳到那一句播放」（第八轮第 3 条）。地址还没解析出来时
                （重启后停在详情页，`src === null`）写 currentTime 会抛 InvalidStateError，
                所以和底部进度条一样，那种情况下只切「看哪一句」、不下发给播放器。 */}
            <Lyrics
              songId={song.id}
              palette={palette}
              onSeek={(timeMs) => {
                if (src) seek(timeMs);
              }}
            />
          </div>
        </div>
      </div>

      {/* 第十八轮第 1 条（用户 m01482）让药丸改回**以中心轴为基准放大**之后，
          悬停态的药丸右端会伸到右侧滑出面板（评论 / 歌曲信息，`.pi-home__drawer`，
          z-index 8）底下：`.pi-home__body` 自己带 `z-index: 1`（见 styles/global.css:2419），
          它是个层叠上下文，药丸挂在它里面时 `z-index: 9` 只能在内部生效，
          于是音量键被面板盖住、鼠标永远贴不到键上（实测合成指针落在
          `pi-home__drawer-body` 上、音量弹层一直不透明度 0）。
          所以把药丸挪出 `.pi-home__body`、直接挂在 `section.pi-home` 上（层级 9 才真的压得住面板 8）。
          它本来就是绝对定位（`left: 50%; bottom: 18px`），换参照盒子后位置逐像素不变
          ——`.pi-home` 与 `.pi-home__body` 都是满窗、padding 0、`overflow: hidden`。 */}
      <HomeBar song={song} />
      <Panel song={song} />
      {/* 第十七轮第 8 条（用户 m00006，参考图 5）：这一首快播完时，右下角浮出「接下来播放」。
          下一首真的开始播时它自己消失，改由左下角那张歌曲名片冒出来接棒。 */}
      <UpNextCard />
      {/* 第十六轮第 6 条：PI 快捷键 + 划开的两张拍立得卡（固定定位，跟着点下去的那一点走）。 */}
      <QuickDock />
      {/* 用户 m02898 第 3 条：名片封面右下角那颗键点开的「选歌单」浮窗（`position: fixed` 居中）。
          挂在页面这一层、和 `<QuickDock />` 平级，理由见上面 `pickerOpen` 那段注释。 */}
      {pickerOpen ? (
        <PlaylistPickerOverlay
          songId={song.id}
          onClose={() => setPickerOpen(false)}
          onAdded={(playlistName) => {
            setPickerOpen(false);
            setPickerToast(`已添加到「${playlistName}」`);
          }}
        />
      ) : null}
      {pickerToast ? (
        <p className="pi-home__toast pi-picker-toast" data-picker-toast="true" role="status">
          {pickerToast}
        </p>
      ) : null}
    </section>
  );
}

/**
 * 「指针接近名片」的判定范围：名片矩形四周各放宽这么多像素。
 *
 * 第十七轮第 7 条取 76；第十八轮第 9 条（用户 m01482）点名的就是这件事——
 * 「歌曲播放页左下歌曲名片要在鼠标接近**左下边框**时才出现」。76px 加在又高（≈330px）
 * 又宽（188px）的名片上，等于把左下半边一整块都算成「接近」，指针在左半边随便走走
 * 它就冒出来了，读起来不像「贴着边框」。
 *
 * 改成 32：判定区贴着名片本身（+左下的窗口边框），指针要真的走到左下角那一带才冒出来；
 * 同时名片藏起来时是 `translateY(46px)`，收紧之后这个位移仍在判定区内部（不会因为
 * 名片冒出来/沉回去而把指针甩出判定区、来回抖）。
 */
const CARD_NEAR_MARGIN = 32;

/**
 * 换歌时左下角歌曲名片停留多久。
 *
 * 第十八轮第 11 条（用户 m01482）：「下一首歌曲播放时出现的歌曲名片持续 5s」⇒ 5000；
 * **用户 m01402 第 8 条**收到 3s：「切换歌曲后显示的歌曲名片只显示 3s 就消失」。
 * 第十六轮沿用被删掉的 `SongChangeCard.SHOW_MS` 是 3400ms。
 */
const SONG_CARD_SHOW_MS = 3000;

/**
 * 「刚切完歌」这个窗口必须活得比播放页长（用户 m01402 第 8 条后半句：
 * 「只有从其他界面回到播放页时不出现歌曲名片，除非是刚切换完歌曲」）。
 *
 * 播放页是**卸载重挂**的（去歌单页 / 搜索页 / 详情页再回来都会重跑一遍下面 `[song]` 那条
 * effect），组件内的 `lastSongId` 归零之后会把「当前正在播的这首」误判成刚换的歌，于是每次
 * 回来都凭空冒一张名片。所以把「谁、露到什么时候」记在模块级：重挂时只有在窗口内、且还是
 * 同一首才接着露出来，否则安静地只记账。窗口只剩一点尾巴（< 700ms）也不露——冒一下就没，
 * 比不冒更像故障。
 */
let cardRevealSongId: number | null = null;
let cardRevealUntil = 0;
const CARD_REVEAL_MIN_TAIL_MS = 700;

/**
 * 左下角的小名片（用户第九轮第 2 条）。
 *
 * 第八轮它挂在左上角，点它会开关「一层遮罩 + 屏幕四角的按键」；第九轮把那层遮罩与四角键删掉，
 * 改成「点名片**向上**伸出一个竖排操作框（评论 / 收藏 / 歌曲信息 / 分享）」；第十九轮第 8 条
 * （用户 m02213）连那个框也删了——四项能力搬到**封面四角**（悬停封面才浮现），名片右下角
 * 再挂一颗「我的喜爱」小爱心。
 *
 * 名片本身要回答「这首歌是什么」：封面 + 歌名 + 歌手（可点）+ 专辑（可点）+ 音质 + 收藏态。
 * 歌手名与专辑名是 `<button>`，点了出对应的歌曲卡片（`openSongs` → `SongListOverlay`）；
 * 上游没给 id 时（本地文件、兜底数据）退回老路：把名字填进关键词跳搜索页。
 */
/**
 * 播放模式 → 封面左上角那颗键的图标（用户 m03805 第 4 条）。
 *
 * 列表循环 = `repeat`、单曲循环 = `repeatOne`、随机 = `shuffle`，第四种「顺序播放」用本轮
 * 新加的 `order` 字形（见 `components/Icons.tsx`）。这张表放在页面里而不是 `@pi/player-core`：
 * 那边是零 DOM 的纯逻辑包，不该认识图标。
 */
const MODE_ICON: Readonly<Record<PlayMode, IconName>> = {
  order: 'repeat',
  'repeat-one': 'repeatOne',
  shuffle: 'shuffle',
  sequence: 'order',
};

function HomeCard({
  song,
  revealed,
  onAddToPlaylist,
}: {
  song: Song;
  /** 第十六轮第 3 条：刚换了歌 ⇒ `data-reveal='true'`，CSS 里放一段进场动画。 */
  revealed: boolean;
  /**
   * 用户 m02898 第 3 条：封面右下角那颗键（`data-card-action="like"`）改成「收藏到歌单」——
   * 点它由页面弹出选歌单浮窗。**底部那颗 `data-card-like` 爱心不走这里**，它仍是「我喜欢的音乐」。
   */
  onAddToPlaylist: () => void;
}): ReactNode {
  const openSongs = useUi((s) => s.openSongs);
  const navigate = useUi((s) => s.navigate);
  const setSearchKeywords = useUi((s) => s.setSearchKeywords);
  const setHomePanel = useUi((s) => s.setHomePanel);
  /** 用户 m03805 第 4 条：封面左上角那颗键改成播放模式切换，要读当前模式与切换动作。 */
  const mode = usePlayer((s) => s.mode);
  const cycleMode = usePlayer((s) => s.cycleMode);
  /** 同一轮第 4 条后半：左下角那颗评论键要能开**也能关**，所以得知道面板当前是不是评论。 */
  const panel = useUi((s) => s.homePanel);

  /**
   * 「喜欢」这一份数据源（第十九轮第 8 条，用户 m02213）。
   *
   * 名片右下角的小爱心、封面右下角那颗「收藏」键，用的都是第九轮操作框里那套
   * `useAccount` / `useLikeCheck` / `useToggleLike`——收藏成功后 `useToggleLike` 会把结果写回
   * `['like-check', songId]` 这个缓存键，两处同时点亮，**没有第二份事实**。
   */
  const loggedIn = useAccount().data?.loggedIn === true;
  const likeCheck = useLikeCheck(song.id, loggedIn);
  const toggleLike = useToggleLike();
  const liked = likeCheck.data?.liked.includes(song.id) === true;
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  const likeTitle = toggleLike.error
    ? errorMessage(toggleLike.error)
    : liked
      ? '取消收藏'
      : '收藏到我喜欢';

  const onLike = (): void => {
    if (!loggedIn) {
      setToast('要登录才能收藏');
      return;
    }
    toggleLike.mutate(
      { songId: song.id, like: !liked },
      { onSuccess: () => setToast(liked ? '已取消收藏' : '已收藏到「我喜欢的音乐」') },
    );
  };

  /** 分享（右上角那颗键）：复制这首歌的网易云外链，实现与原来操作框里那条逐字相同。 */
  const onShare = (): void => {
    const link = `https://music.163.com/song?id=${song.id}`;
    void copyText(link).then((ok) => setToast(ok ? '链接已复制' : `请手动复制：${link}`));
  };

  /**
   * 第十七轮第 7 条：名片**常态隐藏**，只有「指针接近」或「刚切完歌」才从底部冒出来。
   * `revealed` 是后者（宿主给的），`near` 是前者——判定就写在下面这一段里。
   *
   * 为什么不用 CSS 的 `:hover` + 伪元素撑大命中区来做「接近」：
   * 那种伪元素会**真的吃掉指针**，等于在名片四周挖出一圈点不出 PI 键的死区，
   * 而那一圈恰恰是播放页最常点的空白。这里只判定「指针离得近不近」，
   * 指针事件照旧穿透到舞台（名片藏起来时还带 `pointer-events: none`）。
   */
  const cardRef = useRef<HTMLElement | null>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    let frame = 0;
    let at: { x: number; y: number } | null = null;
    const apply = (): void => {
      frame = 0;
      const node = cardRef.current;
      if (!node || !at) return;
      const rect = node.getBoundingClientRect();
      setNear(
        at.x >= rect.left - CARD_NEAR_MARGIN &&
          at.x <= rect.right + CARD_NEAR_MARGIN &&
          at.y >= rect.top - CARD_NEAR_MARGIN &&
          at.y <= rect.bottom + CARD_NEAR_MARGIN,
      );
    };
    const onMove = (event: PointerEvent): void => {
      at = { x: event.clientX, y: event.clientY };
      // rAF 合帧：pointermove 一帧来好几次，每次读 rect 都是强制布局。
      if (frame === 0) frame = window.requestAnimationFrame(apply);
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  const artist = song.artists[0];

  const onArtist = (): void => {
    if (!artist) return;
    if (artist.id > 0) {
      openSongs({
        kind: 'artist',
        id: artist.id,
        title: artist.name,
        subtitle: '歌手',
        ...(song.album?.coverUrl ? { coverUrl: song.album.coverUrl } : {}),
      });
      return;
    }
    setSearchKeywords(artist.name);
    navigate('search');
  };

  const onAlbum = (): void => {
    const album = song.album;
    if (!album) return;
    if (album.id > 0) {
      openSongs({
        kind: 'album',
        id: album.id,
        title: album.name,
        subtitle: artistNames(song),
        ...(album.coverUrl ? { coverUrl: album.coverUrl } : {}),
      });
      return;
    }
    setSearchKeywords(album.name);
    navigate('search');
  };

  // 用户 m00001 第 6 条：「小名片放大变成歌曲名片」只针对**刚切完歌**那一档（`revealed`）；
  // 指针靠近那一档（`near`）仍走原来那条「从底下冒出来」。CSS 靠 `data-handoff` 分流。
  //
  // 这一档在「藏 → 露」那一刻定档、整段露出期间不变：切歌那次露出满 5s 后 `revealed` 会落回，
  // 指针要是正好还靠在名片附近，`data-reveal` 仍为真而 `data-handoff` 会翻一次 ——
  // animation-name 一变动画就要重播（卡片先掉下去再冒上来）。定档之后这件事不会发生。
  const shown = revealed || near;
  const handoffRef = useRef(false);
  const shownRef = useRef(false);
  if (shown && !shownRef.current) handoffRef.current = revealed;
  shownRef.current = shown;

  return (
    <aside
      ref={cardRef}
      className="pi-home__card"
      data-home-card="true"
      data-reveal={shown}
      data-near={near}
      data-handoff={handoffRef.current ? 'true' : 'false'}
    >
      {/* 第十二轮第 4 条（用户 m04193）：封面挪到名片顶部并占满卡片宽（约 170 CSS px），
          2x 屏要 340+，所以取 400；不用拉 640 那么大的图。
          第十九轮第 8 条（用户 m02213）：封面上盖一层**四角动作键**，鼠标悬停 `.pi-home__coverwrap`
          才浮现（常态 `opacity: 0` + `pointer-events: none`，规则见 `styles/up-next-card.css`）。
          四颗键都带 `data-card-action` 抓手（`mode` / `share` / `comments` / `like`）。
          用户 m03805 第 4 条把左上角那颗从「歌曲信息」换成「播放模式」切换，
          左下角那颗评论键改成**开关**（开着再点就收起评论页，`data-on` 反映开合状态）。 */}
      <div className="pi-home__coverwrap">
        {/* 用户 m03805 第 4 条把原来这颗左上角的「歌曲信息」键改绑成了播放模式切换，
            于是「歌曲信息」面板（`HomePage` 底部的 `SongInfo`，与评论面板同一层抽屉）
            没了入口。这里把**封面本体**当入口补回来 —— 网易云点封面也是看歌曲详情，
            而且四角键是 `img` 的兄弟节点、点键不会冒泡到这里（不会改绑完又互相打架）。
            抓手用 `data-card-cover`，不是 `data-card-action`：冒烟那格数的是「封面四角键」，
            四颗就是四颗。 */}
        <img
          className="pi-home__cover"
          src={coverAt(song.album?.coverUrl, 400)}
          alt=""
          data-card-cover="info"
          title="歌曲信息"
          onClick={() => setHomePanel('info')}
        />
        {/* 用户 m03805 第 4 条：左上角那颗原本是「歌曲信息」，改成播放模式切换键
            （图标随模式变，点击按网易云的顺序轮换：列表循环 → 单曲循环 → 随机 → 顺序播放）。 */}
        <button
          type="button"
          className="pi-home__coverbtn pi-home__coverbtn--tl"
          data-card-action="mode"
          data-card-mode={mode}
          title={`播放模式：${MODE_LABEL[mode]}（点击切换）`}
          aria-label={`播放模式：${MODE_LABEL[mode]}（点击切换）`}
          onClick={cycleMode}
        >
          <Icon name={MODE_ICON[mode]} size={15} />
        </button>
        <button
          type="button"
          className="pi-home__coverbtn pi-home__coverbtn--tr"
          data-card-action="share"
          title="分享"
          aria-label="分享"
          onClick={onShare}
        >
          <Icon name="share" size={15} />
        </button>
        {/* 用户 m03805 第 4 条后半：评论键改成开关——评论页已经开着就关掉，否则打开。
            `data-on` 与右下角那颗收藏键同一套约定（`styles/up-next-card.css` 里点亮它）。 */}
        <button
          type="button"
          className="pi-home__coverbtn pi-home__coverbtn--bl"
          data-card-action="comments"
          data-on={panel === 'comments'}
          aria-pressed={panel === 'comments'}
          title="评论"
          aria-label="评论"
          onClick={() => setHomePanel(panel === 'comments' ? 'none' : 'comments')}
        >
          <Icon name="comment" size={15} />
        </button>
        {/* 用户 m04407 第 2 条：「封面角落的收藏到歌单图标与收藏的我喜欢的图标太相似，
            换一个收藏到歌单的图标」——原来这颗画的是 `heart`，名片最后一行右侧那颗
            「我喜欢」（`data-card-like`）也是 heart，两颗爱心挨着看混。这里换成
            `playlistAdd`（列表 + ＋）。`data-card-action='like'`、文案与 onClick 一个都没动。 */}
        <button
          type="button"
          className="pi-home__coverbtn pi-home__coverbtn--br"
          data-card-action="like"
          title="收藏到歌单"
          aria-label="收藏到歌单"
          onClick={onAddToPlaylist}
        >
          <Icon name="playlistAdd" size={15} />
        </button>
      </div>
      <div className="pi-home__meta">
        <h1 className="pi-home__title">{song.name}</h1>
        <button
          type="button"
          className="pi-home__artists"
          data-card-artist
          onClick={(event) => {
            event.stopPropagation();
            onArtist();
          }}
        >
          {artistNames(song) || '未知歌手'}
        </button>
        {song.album ? (
          <button
            type="button"
            className="pi-home__album"
            data-card-album
            onClick={(event) => {
              event.stopPropagation();
              onAlbum();
            }}
          >
            {song.album.name}
          </button>
        ) : null}
        {/* 最后一行：左音质、右爱心。爱心放这一行的右端 = 名片右下角
            （`data-card-like` 是冒烟抓手：'true' 就是当前已收藏、「我喜欢的音乐」里点亮的那些）。 */}
        <div className="pi-home__footer">
          <div className="pi-home__quality" data-card-quality>
            <StatusLine song={song} />
          </div>
          <button
            type="button"
            className="pi-home__like"
            data-card-like={liked ? 'true' : 'false'}
            data-on={liked}
            aria-pressed={liked}
            title={likeTitle}
            aria-label={liked ? '取消收藏' : '收藏到我喜欢'}
            onClick={onLike}
            disabled={toggleLike.isPending}
          >
            <Icon name="heart" size={16} />
          </button>
        </div>
      </div>
      {toast ? (
        <p className="pi-home__toast" role="status">
          {toast}
        </p>
      ) : null}
    </aside>
  );
}

/**
 * 底部浮动的进度条（用户第九轮第 1 条）。
 *
 * 第八轮按用户当时的图 1 把它做成「只留时间 + 进度条」；第九轮用户改主意了：默认收成
 * 原来的约 1/4，指针移上去才展开；展开时**左边**浮出暂停键、**右边**浮出音量键，
 * 指针停在音量键上再往上弹出一条**竖向**音量条（`input[type=range]` 用 CSS 转 90°）。
 *
 * 收起状态下这些键只是 `opacity: 0` + `pointer-events: none`，开合完全交给 CSS 的 `:hover`
 * （`.pi-home__bar` 的规则在 `styles/global.css`），所以这里不需要额外的 state。
 *
 * 进度直接读 store 里的 `positionMs`——`components/AudioEngine.tsx` 已经把 `<audio>` 的
 * `timeupdate` 回写进 `state/player.ts`（约 4Hz），所以这里**不自己 setInterval 轮询音频**。
 *
 * 拖动走 `seek()`，它直接写 `<audio>.currentTime`。地址还没解析出来时（重启后停在详情页，
 * `src === null`）写 currentTime 会抛 InvalidStateError，所以那种情况只挪滑块、不下发给元素。
 * 拖动期间用本地 `scrubMs`：seek 之后元素要重新缓冲，`positionMs` 的回写会把滑块拽回去。
 */
export function HomeBar({ song }: { song: Song }): ReactNode {
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const src = usePlayer((s) => s.src);
  const seek = usePlayer((s) => s.seek);
  const status = usePlayer((s) => s.status);
  const toggle = usePlayer((s) => s.toggle);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const setVolume = usePlayer((s) => s.setVolume);
  const setMuted = usePlayer((s) => s.setMuted);
  // 第十三轮第 3 条（用户 m04663）：进度条上部两端加「上一首 / 下一首」两个键。
  // 故意不叫 `prev`/`next`：下面两个 onChange 里各有一个局部 `const next`，同名会互相遮蔽。
  const goPrev = usePlayer((s) => s.prev);
  const goNext = usePlayer((s) => s.next);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  /*
   * 音量条拖动中（用户第二十二轮第 3 条：「音量条不能用鼠标线性调节」）：
   * 音量弹层只有 16px 宽，指针稍一偏就滑出它的 `:hover`，`pointer-events` 立刻变回 none
   * ⇒ 拖到一半就把滑块「甩掉」，读起来就是「调不动/不成线性」。
   * 所以按下到抬手之间把弹层**锁在浮出态**（`data-dragging` → CSS 里那一条），
   * 拖到哪儿都跟手；松手立刻恢复「指针离开就淡出」的原有行为。
   */
  const [volDragging, setVolDragging] = useState(false);

  // 解析出来的时长比接口给的更准，但解析前 store 里装的就是 `song.durationMs`
  // （`state/player.ts` 的 `restoreLast` / `loadCurrent` 都这么写），这里再兜一次底。
  const total = durationMs > 0 ? durationMs : (song.durationMs ?? 0);
  const raw = scrubMs ?? positionMs;
  const shown = total > 0 ? Math.min(raw, total) : raw;
  const progress = total > 0 ? Math.min(1, Math.max(0, shown / total)) : 0;
  // 时长未知时 max 给 1，免得 range 的 max=0；反正这时候拖动也 seek 不了。
  const max = Math.max(1, Math.round(total));
  const playing = status === 'playing';

  return (
    <div className="pi-home__bar" data-home-bar="true" data-playing={playing}>
      {/* 药丸的常驻内容。它自己高度固定（44px）且贴着药丸下沿，所以药丸向上长高时
          这一行不动，「进度条本身长度/位置不变」这条才算真的成立。 */}
      <div className="pi-home__barlyn">
        {/* 暂停/播放键：默认藏起来（CSS），指针移到进度条上才浮出来。 */}
        <button
          type="button"
          className="pi-home__play"
          data-home-play="true"
          onClick={() => void toggle()}
          aria-label={playing ? '暂停' : '播放'}
          title={playing ? '暂停' : '播放'}
        >
          <Icon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        {/* 第十四轮第 1 条（用户 m05281）：「参考图 1 重新设计……以及上一首/下一首所在位置」。
            参考图里 `‹` `›` 是**夹着中间那段内容、竖直居中**的，不在药丸顶角 —— 所以这两个键
            从第十二轮的「顶部两角」挪进这一行、夹在时间/进度条的两侧（`[播放] ‹ 时间 进度 时间 › [音量]`）。
            它们在行里占位（不是绝对定位）：这样静置与悬停的轨道长度逐像素相同，
            「变大时条长不变」继续成立。 */}
        <span className="pi-home__time">{clock(shown)}</span>
        {/* 第十五轮第 3 条（用户 m06435）：「上/下一首的按键应该在进度条本身首尾两端**上面**，
            而不是首尾旁边」——所以给轨道套一层相对定位的盒子（`.pi-home__track`），两个箭头
            绝对定位到这条轨道首尾两端的正上方（CSS 里），不再占行内位置：
            轨道因此长出两个键让出的宽度（原来它们夹在时间和进度条之间）。
            药丸悬停向上长高那 12px 正好是它们浮出来的地方。 */}
        <div
          className="pi-home__track"
          data-home-track="true"
          /* 用户 m04407 第 3 条：`--pi-progress` 从 `<input>` 挪到这一层——下面那层「已播胶囊」
             是 input 的**兄弟**，读不到 input 自己的自定义属性。挪上来两边都继承得到
             （全仓没有任何探针读 `--pi-progress`）。 */
          style={{ '--pi-progress': progress.toFixed(4) } as CSSProperties}
        >
          {/* 用户 m04407 第 3 条：「进度条的蓝色右端在常态和放大状态下都是一个竖线，
              我希望是圆润的曲线」。原来「已播」是画在 UA 轨道上的一层渐变
              （`::-webkit-slider-runnable-track` 的 `background-size`），右端天生是条竖直硬边。
              现在改用这个绝对定位的兄弟节点当填充：宽度跟着 `--pi-progress` 走、两端 999px 圆角，
              常态（轨 6px）与悬停放大（轨 10px）各是一个两端圆头的小胶囊。
              它绝对定位、input 是静态元素，所以按绘制顺序它盖在轨道上方；
              `data-home-progress-fill` 是给探针/冒烟认这层用的抓手。 */}
          <span
            className="pi-home__progressfill"
            data-home-progress-fill="true"
            aria-hidden="true"
          />
          <button
            type="button"
            className="pi-home__prev"
            data-home-prev="true"
            onClick={() => void goPrev()}
            aria-label="上一首"
            title="上一首"
          >
            <Icon name="prev" size={20} />
          </button>
          <input
            className="pi-home__progress"
            type="range"
            min={0}
            max={max}
            step={100}
            value={Math.round(Math.min(shown, max))}
            onChange={(event) => {
              const next = Number(event.target.value);
              setScrubMs(next);
              if (src) seek(next);
            }}
            onPointerUp={() => setScrubMs(null)}
            onPointerCancel={() => setScrubMs(null)}
            onBlur={() => setScrubMs(null)}
            aria-label="播放进度"
            data-home-progress="true"
          />
          <button
            type="button"
            className="pi-home__next"
            data-home-next="true"
            onClick={() => void goNext()}
            aria-label="下一首"
            title="下一首"
          >
            <Icon name="next" size={20} />
          </button>
        </div>
        <span className="pi-home__time">{formatDuration(total)}</span>
        {/* 音量：`data-home-volume` 这一层是 hover 的热区，鼠标停在音量键（或其弹出的竖条）上
            都算「还在里面」，所以竖条不会刚滑出来就消失。 */}
        <div
          className="pi-home__volume"
          data-home-volume="true"
          data-dragging={volDragging ? 'true' : 'false'}
          onPointerDown={() => setVolDragging(true)}
          onPointerUp={() => setVolDragging(false)}
          onPointerCancel={() => setVolDragging(false)}
        >
          <button
            type="button"
            className="pi-home__volbtn"
            data-home-volbtn="true"
            onClick={() => setMuted(!muted)}
            aria-label={muted ? '取消静音' : '静音'}
            aria-pressed={muted}
            title={muted ? '取消静音' : '静音'}
          >
            <Icon name={muted ? 'mute' : 'volume'} size={18} />
          </button>
          <div className="pi-home__volpop" data-home-volpop="true">
            {/*
              用户第二十二轮第 3 条：从原生 `<input type=range rotated>` 换成自己接指针的
              `components/VolumeSlider.tsx` —— 原来那根条「落点 → 值」非线性（实测四分之一处
              点下去读到 0.00、顶到最上面只有 0.87），而且合成输入驱动不了它的「按住拖」。
              组件内部自己算值、自己锁指针，判据（`data-silent` / `--pi-volume` / 布局盒 59×16）
              与原来逐字一致，所以冒烟抓手不用改。
              静音时显示 0，但不动 store 里的 volume：取消静音之后要能回到原来的响度。
            */}
            <VolumeSlider
              value={muted ? 0 : volume}
              silent={muted || Math.round(volume * 100) === 0}
              onDraggingChange={setVolDragging}
              onChange={(next) => {
                setVolume(next);
                if (next > 0 && muted) setMuted(false);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** `m:ss`：位置是 0 的时候也要显示 `0:00`（`formatDuration` 对 0 返回 `--:--`，那是留给「时长未知」的）。 */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * 第十六轮第 6 条（用户 m07538）：删掉悬浮球之后的**唯一入口**。
 *
 * 播放页点任意空白处 → 在**那一点**浮出一颗 PI 圆键（`components/PiQuickOrb.tsx`）：
 * - 上划 → 六块歌单按键卡（`PiQuickPlaylistCard`）；
 * - 下划 → 搜索浮层（`openSearch`）；
 * - 右划 → 拍立得迷你设置卡（`PiQuickSettingsCard`），卡底「详细设置」进完整设置页。
 *
 * 这一层挂在播放页上、元素自己 `position: fixed`，所以不管停在歌词页还是空白页，
 * 键都会出现在点下去的那一点（坐标存在 `useUi().quickPos`，见 `state/ui.ts`）。
 *
 * 六块按键的数据落点（**照实说**：前四块与队列是真数据，本地歌曲今天没有数据）：
 * - 收藏歌单 → `playlist:star`（`/user/playlist` 里 `subscribed === true` 的那些）；
 * - 我的歌单 → `mine:playlists`（同一份列表，不限 `subscribed`）；
 * - 推荐歌单 → `playlist:recommend`（第十六轮为这块按键新恢复的一页，数据 `/personalized`）；
 * - 最近听过 → `mine:recent`；
 * - 本地歌曲 → `mine:download`：**没有数据**（下载与本地库是 M4 的事），所以标
 *   `state='unavailable'` 并在卡上写清，不假装点得出歌来；
 * - 播放列表 → `SongListOverlay` 的 `kind: 'queue'`（当前播放队列，真数据）。
 */
function QuickDock(): ReactNode {
  const quickPos = useUi((s) => s.quickPos);
  const quickPanel = useUi((s) => s.quickPanel);
  const quickFollow = useUi((s) => s.quickFollow);
  const quickOrbHidden = useUi((s) => s.quickOrbHidden);
  const setQuickOrbHidden = useUi((s) => s.setQuickOrbHidden);
  const setQuickPos = useUi((s) => s.setQuickPos);
  const setQuickPanel = useUi((s) => s.setQuickPanel);
  const navigate = useUi((s) => s.navigate);
  const openSongs = useUi((s) => s.openSongs);
  const openSearch = useUi((s) => s.openSearch);
  const openSettings = useUi((s) => s.openSettings);
  const uiStyle = useUi((s) => s.uiStyle);
  const toggleUiStyle = useUi((s) => s.toggleUiStyle);

  /**
   * 用户 m00736 第 2 条：「圆球在鼠标松开后就消失，然后下次按下鼠标再出现」。
   *
   * 所以球只剩**一条**收起路径——松手（`PiQuickOrb` 的 `onRelease`，就是挂在 window 上的
   * 那记 `pointerup` / `pointercancel`）。第十八轮那条「指针离开互动范围就塌陷」的
   * pointermove 监听整条删掉：按住期间不收、抬手即收，两套并存只会互相打架。
   *
   * 收的动作分两拍：先置 `leaving` 让 CSS 播完 `pi-quick-orb-out`（`QUICK_ORB_LEAVE_MS`），
   * 再把 `quickOrbHidden` 置真、整颗摘掉。**卡片刻意不动**——它只看 `quickPos`（那是它的
   * 锚点），所以「松手同时划开卡片」照旧成立。
   */
  const [orbLeaving, setOrbLeaving] = useState(false);
  const leaveTimerRef = useRef(0);
  // 每次新的按下（`summonQuick` 每次都新建一个 quickPos 对象）都把上一拍的收起复位，
  // 免得上一颗球的计时器把新球也顺手收掉；卸载时同样清干净。
  useEffect(() => {
    setOrbLeaving(false);
    window.clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = 0;
    return () => window.clearTimeout(leaveTimerRef.current);
  }, [quickPos]);

  if (!quickPos) return null;

  /**
   * 松手即收（用户 m00736 第 2 条）：先让球播完向内塌陷动画，`QUICK_ORB_LEAVE_MS` 之后
   * 整颗摘掉。卡片不碰——见上面那段注释。
   */
  const onOrbRelease = (): void => {
    setOrbLeaving(true);
    window.clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = 0;
      setOrbLeaving(false);
      setQuickOrbHidden(true);
    }, QUICK_ORB_LEAVE_MS);
  };

  /** 全部收回：卡片关掉、键也收回去（点背板 / 点关闭 / 划开搜索都走它）。 */
  const dismiss = (): void => {
    setQuickPanel('none');
    setQuickPos(null);
  };

  const onSwipe = (direction: QuickSwipeDirection): void => {
    switch (direction) {
      case 'up':
        setQuickPanel(quickPanel === 'collections' ? 'none' : 'collections');
        return;
      case 'down':
        dismiss();
        openSearch();
        return;
      case 'right':
        setQuickPanel(quickPanel === 'settings' ? 'none' : 'settings');
        return;
      // 第十七轮第 1 条：左划不再是「没有对应卡片」的空动作——它是**平凡 / 先锋**两套
      // 排版的切换开关（用户原话：「圆球向左拖动实现平凡/先锋两种风格的切换」）。
      // 划完把球与卡片一起收回：风格已经换掉，视觉上应当立刻看到新排版。
      case 'left':
        toggleUiStyle();
        dismiss();
        return;
      default:
        return;
    }
  };

  const go = (id: NavId) => (): void => {
    dismiss();
    navigate(id);
  };

  const items: readonly QuickPlaylistItem[] = [
    {
      id: 'star',
      label: '收藏歌单',
      icon: <Icon name="star" size={20} />,
      onSelect: go('playlist:star'),
    },
    {
      id: 'mine',
      label: '我的歌单',
      icon: <Icon name="list" size={20} />,
      onSelect: go('mine:playlists'),
    },
    {
      id: 'recommend',
      label: '推荐歌单',
      icon: <Icon name="compass" size={20} />,
      onSelect: go('playlist:recommend'),
    },
    {
      id: 'recent',
      label: '最近听过',
      icon: <Icon name="clock" size={20} />,
      onSelect: go('mine:recent'),
    },
    {
      id: 'local',
      label: '本地歌曲',
      icon: <Icon name="download" size={20} />,
      // 用户 m02898 第 1 条：M5 的下载与本地库已经落地（`pages/MinePage.tsx` 的 `tab === 'download'`
      // 一档实测可下载 / 离线播放 / 看本地库清单），所以这里**不再**标 `unavailable`、
      // 也不再有「M4 才落地」那行灰字——走默认 `ready`，`data-quick-item-state` 自然变 ready。
      onSelect: go('mine:download'),
    },
    {
      id: 'queue',
      label: '播放列表',
      icon: <Icon name="waveform" size={20} />,
      onSelect: () => {
        dismiss();
        openSongs({ kind: 'queue', id: 0, title: '当前播放' });
      },
    },
  ];

  return (
    <>
      {/* 用户 m00736 第 2 条：`quickOrbHidden` 置真时整颗球不渲染（松手收掉之后，以及
          快捷键召唤歌单选择卡时），卡片照旧挂在下面——卡片只看 `quickPos`。 */}
      {quickOrbHidden ? null : (
        <PiQuickOrb
          x={quickPos.x}
          y={quickPos.y}
          onSwipe={onSwipe}
          onDismiss={dismiss}
          uiStyle={uiStyle}
          follow={quickFollow}
          // 用户 m00736 第 2 条：松手 ⇒ 先播向内塌陷动画（`leaving`），再由宿主摘掉整颗球。
          leaving={orbLeaving}
          onRelease={onOrbRelease}
        />
      )}
      {quickPanel === 'collections' ? (
        <PiQuickPlaylistCard items={items} onDismiss={dismiss} />
      ) : null}
      {quickPanel === 'settings' ? (
        <PiQuickSettingsCard
          onOpenSettings={() => {
            dismiss();
            openSettings();
          }}
          onDismiss={dismiss}
        />
      ) : null}
    </>
  );
}

/** 空白页：天蓝渐变的 PI。
 *  第十六轮第 6 条：悬浮球删掉之后这里不再有「展开环形菜单」的按钮——
 *  点页面任意空白处就会在**那一点**浮出一颗 PI 键（`QuickDock` 里的 `PiQuickOrb`）。 */
function EmptyStage(): ReactNode {
  const summonQuick = useUi((s) => s.summonQuick);
  return (
    <section
      className="pi-home pi-home--empty"
      data-empty="true"
      role="presentation"
      onPointerDown={(event) => {
        // 第十七轮第 1 条：和播放页同一条规矩——**按下**就浮现。
        // 用户 m00001 第 1 条：落点就是按下那一点（第十八轮第 2 条的固定家位已推翻）。
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if ((event.target as HTMLElement).closest('button, a, input')) return;
        summonQuick({ x: event.clientX, y: event.clientY }, event.pointerId);
      }}
    >
      <div className="pi-home__logo" aria-hidden="true">
        PI
      </div>
      <p className="pi-home__slogan">还没有在听的歌</p>
      <p className="pi-home__hint">
        点任意空白处：那里会浮出一颗 PI 键——上划看歌单，下划搜索，右划快捷设置，左划换排版。
      </p>
      <QuickDock />
    </section>
  );
}

/** 以封面为基础演变的背景：整张封面放大模糊 + 一层底色压住，保证文字看得清。 */
function Backdrop({ song }: { song: Song }): ReactNode {
  const cover = coverAt(song.album?.coverUrl, 640);
  return (
    <>
      {cover ? <div className="pi-home__bg" style={{ backgroundImage: `url(${cover})` }} /> : null}
      <div className="pi-home__scrim" />
    </>
  );
}

/**
 * 情绪背景（用户 m08768 第 5 条）：跟着「这首歌 + 这一句歌词」走的一层氛围底。
 *
 * 歌词数据在这里自己取一遍——`useLyric` 是 react-query 查询，和 `Lyrics` 里那次调用
 * 共用同一个缓存键，不会多打一次上游请求；`activeIndex` 也在本地算，免得为了一个下标
 * 把 `LyricStage` 的内部状态提到页面上来。
 */
function StageMood({ song }: { song: Song }): ReactNode {
  const query = useLyric(song.id);
  const positionMs = usePlayer((s) => s.positionMs);
  const lines = useMemo(() => query.data?.lines ?? [], [query.data]);

  const activeIndex = useMemo(() => {
    let index = -1;
    for (const line of lines) {
      if (line.timeMs > positionMs) break;
      index += 1;
    }
    return index;
  }, [lines, positionMs]);

  return <ImmersiveBackground song={song} lines={lines} activeIndex={activeIndex} />;
}

/** 播放状态那一行：解析中/报错/一次性提示，都得有地方说。 */ function StatusLine({
  song,
}: {
  song: Song;
}): ReactNode {
  const status = usePlayer((s) => s.status);
  const notice = usePlayer((s) => s.notice);
  const error = usePlayer((s) => s.error);
  const audio = usePlayer((s) => s.audio);

  return (
    <p className="pi-home__status" data-status={status}>
      {status === 'resolving' ? (
        <>正在解析《{song.name}》的音源…</>
      ) : error ? (
        <span className="pi-home__status--error">{error}</span>
      ) : notice ? (
        notice
      ) : (
        <>
          {measuredLabel(audio)}
          {audio ? <span className="pi-home__status-dim"> · {sourceLabel(audio.via)}</span> : null}
        </>
      )}
    </p>
  );
}

/**
 * 「每首歌随机主题」的候选池。
 *
 * 含 `classic`：folia 的 mode 枚举本身就包含默认那套，随机时不把它抽进来就变成
 * 「每首歌随机换一套**非默认**主题」，反而少了「这首歌恰好用回默认」的可能。
 * 顺序与设置页 `LYRIC_THEME_OPTIONS` 的展示顺序一致，方便对照。
 */
const RANDOM_THEME_POOL: readonly LyricTheme[] = [
  'classic',
  'fume',
  'cadenza',
  'partita',
  'tilt',
  'pendolo',
];

/**
 * 歌曲 id → 稳定的主题下标。
 *
 * 不能直接 `songId % 池长`：网易云的 id 是递增分配的，取模等于「按入库顺序轮着换」，
 * 相邻的歌必然不同、隔六首又必然相同，听感上像有规律地在跳。这里先做一次整数混淆
 * （murmur3 的收尾两步）再取模，同一个 id 结果固定，相邻 id 的落点却不再可预测。
 */
function stableThemeIndex(songId: number, count: number): number {
  if (count <= 0) return 0;
  let hash = (songId ^ 0x9e3779b9) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  return ((hash ^ (hash >>> 16)) >>> 0) % count;
}

/**
 * 歌词。
 *
 * 原文与译文两条时间轴相互独立（主进程已经排好序），这里按 `timeMs` 对齐后整段交给 `LyricStage`：
 * 单行居中的舞台、逐字素点亮、译文 + 下两句预览的字幕层（数值复刻 folia classic，见组件头注释）。
 *
 * 「读取中 / 读取失败 / 没有歌词」三种提示与取数方式原样保留——它们回答的是「有没有歌词」，
 * 跟怎么画无关；空态文案与 `.pi-lyrics` 容器也留着（冒烟脚本会数 `.pi-lyrics__line`）。
 */
function Lyrics({
  songId,
  palette,
  onSeek,
}: {
  songId: number;
  /** 当前歌曲的封面配色（第八轮第 4 条）；`null` = 还没算出来，主题就用它自己的默认配色。 */
  palette: ThemeColors | null;
  /** 点某一句歌词：跳到这一句播放（第八轮第 3 条）。 */
  onSeek: (timeMs: number) => void;
}): ReactNode {
  const query = useLyric(songId);
  const positionMs = usePlayer((s) => s.positionMs);
  /**
   * **用户第 5 轮第 2 条**：把「播放器是不是在出声」交给舞台 —— 两条平滑时钟（classic 自己的
   * 与主题层的 `usePositionClock`）都靠它区分「暂停」与「只是还没收到下一个 timeupdate」，
   * 否则暂停后歌词会先往前多走几步再猛地弹回暂停位置。
   */
  const playing = usePlayer((s) => s.status === 'playing');
  // 用户 m01402 第 3 条（M4 剩余项）：浮名曲尾的「剩余 N 秒」要整首时长（小于等于 0 就是不知道）。
  const totalMs = usePlayer((s) => s.durationMs);
  const settings = useSettings().data;
  // 用户 m08768 第 4 条：主题在设置里选，存在 `lyricTheme`（`classic` 是默认的「流光」）。
  //
  // 「每首歌随机主题」开着时按 songId 稳定地覆盖它：同一首歌每次都挑到同一套，
  // 切走再切回来不会换一张脸。关着时**原样**返回设置里的值——主进程冒烟会核对
  // 舞台的 `data-theme` 等于设置里的 `lyricTheme`，默认路径必须一个字节都不变。
  // 多写一层 `?.`：渲染进程可能连着一个还是旧入参形状的主进程，读不到这个设置就当关着。
  const theme = useMemo(() => {
    const configured = settings?.lyricTheme ?? 'classic';
    if (settings?.lyricTuning?.randomThemePerSong !== true) return configured;
    return RANDOM_THEME_POOL[stableThemeIndex(songId, RANDOM_THEME_POOL.length)] ?? configured;
  }, [settings?.lyricTheme, settings?.lyricTuning?.randomThemePerSong, songId]);

  const lines = useMemo(() => query.data?.lines ?? [], [query.data]);
  const translated = useMemo(
    () => new Map((query.data?.translated ?? []).map((line) => [line.timeMs, line.text])),
    [query.data],
  );

  // 第十轮第 6 条（用户 m02362：心象歌词「一抽一抽」）：交给舞台的 palette 必须是**稳定引用**。
  // 这个组件订阅 `positionMs`（歌词时钟，约 4Hz），每次 render 都新建 `{ ...palette, ... }`
  // 会让 CadenzaTheme 的 plan `useMemo`（deps 含 theme/palette）与紧随其后的 rAF effect 每
  // ~250ms 重启一次：逐词插值的「上一次值」缓存被清空，下一帧又拿 placement 兜底，与 DOM 上
  // 已经写好的 `left/top`（placement）叠加成双重偏移 ⇒ 每 250ms 瞬移一次再平滑滑回。
  // 动效参数（字号 / 幅度 / 辉光 / 帧率上限）挂在 palette 上一起下去。
  // `settings?.lyricTuning` 只在这里取一次：它必须是**稳定引用**，否则下面这个 memo
  // 每次都换新 palette，CadenzaTheme 的 plan memo + rAF effect 会跟着反复重启（见上）。
  const tuning = settings?.lyricTuning;
  const stagePalette = useMemo(
    () =>
      palette === null ? null : { ...palette, animationIntensity: 'chaotic' as const, tuning },
    [palette, tuning],
  );

  if (!query.isPending && !query.isError && query.data?.hasLyric && lines.length > 0) {
    return (
      <LyricStage
        lines={lines}
        translated={translated}
        positionMs={positionMs}
        {...(totalMs > 0 ? { durationMs: totalMs } : {})}
        playing={playing}
        theme={theme}
        // `animationIntensity` 是配色契约的一部分（folia 用它调动效密度）。这里固定
        // `chaotic`，与改造前 `LyricStage` 的 `DEFAULT_PALETTE` 一致：本次只换颜色，动画强弱不动。
        {...(stagePalette === null ? {} : { palette: stagePalette })}
        onSeek={onSeek}
      />
    );
  }

  let body: ReactNode;
  if (query.isPending) {
    body = <p className="pi-lyrics__hint">正在读取歌词…</p>;
  } else if (query.isError) {
    body = (
      <p className="pi-lyrics__hint pi-lyrics__hint--error">
        歌词读取失败：{errorMessage(query.error)}
      </p>
    );
  } else {
    body = <p className="pi-lyrics__hint">这首歌没有歌词（纯音乐，或者上游没收录）。</p>;
  }

  return (
    <div className="pi-lyrics" data-lines={lines.length}>
      {body}
    </div>
  );
}

/** 右侧滑出面板：评论 / 歌曲信息（含音源解析过程）。 */
function Panel({ song }: { song: Song }): ReactNode {
  const panel = useUi((s) => s.homePanel);
  const setHomePanel = useUi((s) => s.setHomePanel);
  if (panel === 'none') return null;
  return (
    <aside className="pi-home__drawer" data-panel={panel}>
      <header className="pi-home__drawer-head">
        <h2>{panel === 'comments' ? '评论' : '歌曲信息'}</h2>
        <button
          type="button"
          className="pi-iconbtn"
          onClick={() => setHomePanel('none')}
          aria-label="关闭面板"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="pi-home__drawer-body">
        {panel === 'comments' ? (
          <CommentPanel key={song.id} songId={song.id} />
        ) : (
          <SongInfo key={song.id} song={song} />
        )}
      </div>
    </aside>
  );
}

/** 歌曲信息：专辑 + 音源解析的实测结果（原来在听歌条副标题里的信息挪到这里）。 */
function SongInfo({ song }: { song: Song }): ReactNode {
  const audio = usePlayer((s) => s.audio);
  const attempts = usePlayer((s) => s.attempts);
  const navigate = useUi((s) => s.navigate);
  const setSearchKeywords = useUi((s) => s.setSearchKeywords);

  return (
    <div className="pi-info">
      <div className="pi-info__album">
        <img className="pi-info__cover" src={coverAt(song.album?.coverUrl, 300)} alt="" />
        <div className="pi-info__label">专辑</div>
        <div className="pi-info__value">{song.album?.name ?? '—'}</div>
        <div className="pi-info__label">歌手</div>
        <div className="pi-info__value">{artistNames(song)}</div>
        <div className="pi-info__jump">
          <button
            type="button"
            className="pi-btn pi-btn--ghost"
            onClick={() => {
              if (!song.album) return;
              setSearchKeywords(song.album.name);
              navigate('search');
            }}
          >
            <Icon name="search" size={15} /> 搜索这张专辑
          </button>
          <button
            type="button"
            className="pi-btn pi-btn--ghost"
            onClick={() => {
              const name = song.artists[0]?.name;
              if (!name) return;
              setSearchKeywords(name);
              navigate('search');
            }}
          >
            <Icon name="artist" size={15} /> 搜索这位歌手
          </button>
        </div>
      </div>

      <dl className="pi-info__list">
        <div className="pi-info__row">
          <dt>时长</dt>
          <dd>{formatDuration(song.durationMs)}</dd>
        </div>
        <div className="pi-info__row">
          <dt>音源</dt>
          <dd>{audio ? sourceLabel(audio.via) : '还没有解析'}</dd>
        </div>
        <div className="pi-info__row">
          <dt>实测音质</dt>
          <dd>{measuredLabel(audio)}</dd>
        </div>
        <div className="pi-info__row">
          <dt>接口自称</dt>
          <dd>{claimedLabel(audio) ?? '—'}</dd>
        </div>
        <div className="pi-info__row">
          <dt>歌曲 ID</dt>
          <dd>{song.id}</dd>
        </div>
      </dl>

      {audio ? <p className="pi-info__tooltip">{audioTooltip(audio)}</p> : null}

      <div className="pi-info__attempts">
        <div className="pi-info__label">音源链</div>
        {attempts.length === 0 ? (
          <p className="pi-info__dim">这一轮没有解析记录。</p>
        ) : (
          attempts.map((attempt, index) => (
            <div key={`${attempt.sourceId}-${index}`} className="pi-info__attempt">
              <span className={attempt.ok ? 'pi-info__ok' : 'pi-info__fail'}>
                {attempt.ok ? '✓' : '✗'} {attempt.sourceId}
              </span>
              <span className="pi-info__dim">{attempt.elapsedMs}ms</span>
              {attempt.detail ? <span className="pi-info__dim">{attempt.detail}</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 复制到剪贴板：Electron 里 `navigator.clipboard` 可能因为不是安全上下文而不可用，兜底走 textarea。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
