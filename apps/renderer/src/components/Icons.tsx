/**
 * 图标全部内联为 SVG path。
 * 理由（docs/PLAN.md §2.6 规则 4）：不引入图标字体、不依赖系统里是否装了某个字体，
 * 也不额外发起请求——离线打包与 Linux 发行版差异都不会让图标变成方框。
 */
export type IconName =
  | 'search'
  | 'clock'
  | 'heart'
  | 'download'
  | 'list'
  | 'compass'
  | 'star'
  | 'play'
  | 'pause'
  | 'prev'
  | 'next'
  | 'volume'
  | 'mute'
  | 'repeat'
  | 'repeatOne'
  | 'shuffle'
  /** 顺序播放（用户 m03805 第 4 条）。名字沿用父任务给的 `order`（「顺序」），
      对应的 `PlayMode` id 是 `sequence`（`order` 这个 id 已经被「列表循环」占了）。 */
  | 'order'
  | 'chevronUp'
  | 'chevronLeft'
  | 'close'
  | 'album'
  | 'artist'
  | 'comment'
  | 'user'
  | 'logout'
  | 'refresh'
  | 'settings'
  | 'waveform'
  | 'music'
  | 'home'
  | 'bars'
  | 'grid'
  | 'grip'
  | 'chevronDown'
  | 'info'
  | 'share'
  | 'plus'
  /** 「加入歌单」（用户 m04407 第 2 条）：左侧几道列表横线 + 右下角一个「＋」。
      `list` 是「三横线 + 右列短点」、`plus` 是居中的大十字，这一枚两者都不是，
      在 15px 下也能读成「往列表里加」。 */
  | 'playlistAdd';

const PATHS: Record<IconName, string> = {
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-3.8-3.8',
  clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7.5V12l3 2',
  heart: 'M12 20s-7-4.6-7-9.4A4.1 4.1 0 0 1 12 7.6 4.1 4.1 0 0 1 19 10.6C19 15.4 12 20 12 20z',
  download: 'M12 4v11m0 0 4-4m-4 4-4-4M5 20h14',
  list: 'M4 6h9M4 12h9M4 18h9M18 6h2M18 12h2M18 18h2',
  compass: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM15.6 8.4l-2.1 5.1-5.1 2.1 2.1-5.1z',
  star: 'M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8z',
  /* play / pause / prev / next 都是**填充**图形：路径必须是闭合面积，
     写字用的描边路径（比如 `M9.2 5v14`）填出来是空的、按钮会变成一片空白。 */
  play: 'M8.2 5.4v13.2L19 12z',
  pause: 'M8.6 5h2.9v14H8.6zM12.5 5h2.9v14h-2.9z',
  prev: 'M7 5h2.2v14H7zM20 5.6v12.8L9.9 12z',
  next: 'M14.8 5H17v14h-2.2zM4 5.6v12.8L14.1 12z',
  volume: 'M4 9.5h3l4-3.5v12l-4-3.5H4zM15.5 9.2a4 4 0 0 1 0 5.6',
  mute: 'M4 9.5h3l4-3.5v12l-4-3.5H4zM16 9.8l4 4.4m0-4.4-4 4.4',
  repeat: 'M4.5 9.5A5 5 0 0 1 9.5 4.5H19m0 0-3-3m3 3-3 3M19.5 14.5a5 5 0 0 1-5 5H5m0 0 3 3m-3-3 3-3',
  repeatOne:
    'M4.5 9.5A5 5 0 0 1 9.5 4.5H19m0 0-3-3m3 3-3 3M19.5 14.5a5 5 0 0 1-5 5H5m0 0 3 3m-3-3 3-3M11.6 10.6l1.6-1.1v5',
  shuffle: 'M4 7h4l3.2 4.4M4 17h4l1.6-2.2M20 7h-5.2l-1.5 2.1M20 17h-5.2l-3.3-4.5M20 7l-2.6-2.6M20 7l-2.6 2.6M20 17l-2.6-2.6M20 17l-2.6 2.6',
  /* 顺序播放：描边的 ⏭ + 右侧竖条（「按顺序往下走，走到头就停」）。和 `next` 形状一样，
     但 `next` 是填充的、这里按 24×24 描边风格画，缩小到 15px 放进封面角上不会糊成一团。 */
  order: 'M6.5 7.3v9.4L14.4 12zM18 6.6v10.8',
  chevronUp: 'M6 15l6-6 6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  /* 描边十字：新建歌单的空卡片上用它，跟 close 的叉叉方向不同、不会看混。 */
  plus: 'M12 5v14M5 12h14',
  /* 用户 m04407 第 2 条：封面右下角那颗「收藏到歌单」原来画的是 heart，和名片里的
     「我喜欢」那颗爱心长得一模一样，换成这枚「列表 + ＋」。第三道横线故意只画到 x=9，
     把右下角让给那个「＋」（臂长 7、中心 (18,16)）；横线间距 5.5 而描边只有 1.7，
     缩到 15px（×0.625 ⇒ 线距 3.4px、描边 1.06px）时三横线之间仍有约 2.4px 的空隙，
     不会糊成一团。 */
  playlistAdd: 'M4 6h9M4 11.5h9M4 17h5M18 12.5v7M14.5 16h7',
  album: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 10.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z',
  artist: 'M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4zM6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3',
  comment: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H9.5L4 20z',
  user: 'M12 4a3.2 3.2 0 1 1 0 6.4A3.2 3.2 0 0 1 12 4zM5 20c0-3.3 3.1-5.4 7-5.4s7 2.1 7 5.4',
  logout: 'M15 5H7.5A1.5 1.5 0 0 0 6 6.5v11A1.5 1.5 0 0 0 7.5 19H15M14 12h7m0 0-3-3m3 3-3 3',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4.5V9h-4.5',
  settings:
    'M12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM19.4 14.2a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.6 1v.3a1.8 1.8 0 1 1-3.6 0v-.2a1.5 1.5 0 0 0-2.6-1l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1-2.6H4.2a1.8 1.8 0 1 1 0-3.6H4.4a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 2.6-1V4.2a1.8 1.8 0 1 1 3.6 0V4.4a1.5 1.5 0 0 0 2.6 1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1 2.6h.3a1.8 1.8 0 1 1 0 3.6h-.3a1.5 1.5 0 0 0-1 .9z',
  music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  waveform: 'M4 10v4M8 6.5v11M12 9v6M16 4.5v15M20 10v4',
  home: 'M4.5 11.4 12 5l7.5 6.4V19a1.4 1.4 0 0 1-1.4 1.4H5.9A1.4 1.4 0 0 1 4.5 19zM9.8 20.4v-5.4h4.4v5.4',
  bars: 'M4 7h16M4 12h16M4 17h16',
  /* 四宫格（第十七轮第 1 条）：先锋风格——歌单是封面卡片轮播、歌曲是队列拼贴，
     都是「一块一块」的排布，所以用四个方块而不是一堆横线。 */
  grid: 'M4.6 4.6h6v6h-6zM13.4 4.6h6v6h-6zM4.6 13.4h6v6h-6zM13.4 13.4h6v6h-6z',
  /* 拖动手柄：六个圆点，靠 strokeLinecap=round 把极短线段画成点 */
  grip: 'M9.5 6.5h.01M9.5 12h.01M9.5 17.5h.01M14.5 6.5h.01M14.5 12h.01M14.5 17.5h.01',
  chevronDown: 'M6 9l6 6 6-6',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11.2v5.2M12 7.6h.01',
  share: 'M12 15.5V4m0 0L8.4 7.6M12 4l3.6 3.6M6 13.4v5.1A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5v-5.1',
};

/** play / pause / prev / next 这类图形用线描反而难看，单独填充。 */
const FILLED: ReadonlySet<IconName> = new Set(['play', 'pause', 'prev', 'next']);

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 18, className }: IconProps) {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
