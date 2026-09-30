import { useMemo, type CSSProperties, type ReactNode } from 'react';
import type { Song } from '@pi/shared';
import { coverAt } from '../lib/cover';
import { artistNames } from '../lib/format';
import { usePlayer } from '../state/player';
import { Icon } from './Icons';

/**
 * 「我的喜欢」的封面拼贴墙（用户 m06982 第 4 条）。
 *
 * 布局思路参考 folia-major 的 Lattice 海报墙（AGPL-3.0，**只借数值与思路、代码是自己写的**）：
 * 那片墙是「固定节距的格子 + 大小不一的方片正好铺满」，入场是 Metro 磁贴式的对角波。
 * 我们这里没有相机/虚拟滚动，也不需要展开重排，只保留三件事：
 * 方片风格、无洞的确定性铺法、按曼哈顿距离错开的入场波。
 *
 * 为什么铺法要自己算而不是交给 CSS Grid 的自动排布：自动排布遇到放不下的片型会把整块
 * 甩到下一行，右边留下一个洞；`grid-auto-flow: dense` 也只是让后面的小片去补，不保证补上。
 * 自己维护一张占用表、把位置显式写进 `grid-column/grid-row`，「没有洞」才是确定的。
 */

export interface LikedWallProps {
  songs: readonly Song[];
  onSelect: (song: Song) => void;
}

/** 片型：占几列 × 占几行（单位是格子，不是像素）。 */
type Shape = readonly [cols: number, rows: number];

interface Tile {
  song: Song;
  /** 这首歌在原列表里的下标：点一下要「从这首歌开始播」，队列得用整个列表。 */
  songIndex: number;
  /** 0 起的格坐标（写进 CSS 时 +1）。 */
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/**
 * 一屏最多铺这么多首。
 * `/likelist` + `/song/detail` 首屏最多给 100 首，留一截余量给以后翻页；
 * 再多也没数据不说，入场动画的窗口会被拖得很长。
 */
const MAX_TILES = 120;

/**
 * 固定 12 列。列数必须跟窗口宽度无关，否则「同一首歌永远在同一格」这件事就没了
 * —— 窗口一改大小整面墙都会重排。宽度变化交给 CSS 端的格子尺寸 clamp 去吸收。
 */
const WALL_COLS = 12;

/** 面积从大到小：既是可选的片型，也是放不下时的退让顺序。 */
const SHAPES: readonly Shape[] = [
  [2, 2],
  [2, 1],
  [1, 2],
  [1, 1],
];

/** 兜底片型：1×1 在任何空格上都能放下，所以铺法一定收敛。 */
const FALLBACK: Shape = [1, 1];

/**
 * 把歌铺进 `WALL_COLS` 列的格子。
 *
 * 行优先推进到第一个空格 → 用格子坐标的整数哈希挑一个片型 → 放不下就按面积从大到小退让
 * （1×1 一定能放下）→ 登记占用。全程整数运算、`Math.random()` 一次都不用，
 * 所以同一份列表每次算出来的位置完全一样（重渲染、切页面都不会跳）。
 *
 * 取舍：退让顺序刻意是「**最大**的放得下就用」，而不是一步退到 1×1。行尾差一格时
 * 直接给 1×1 会让整面墙退化成一片小方片，2×1 既补满了洞也保住了大小错落。
 */
function layoutTiles(songs: readonly Song[]): Tile[] {
  const taken = new Set<number>();
  const tiles: Tile[] = [];
  let col = 0;
  let row = 0;

  const key = (x: number, y: number): number => y * WALL_COLS + x;

  const fits = (x: number, y: number, shape: Shape): boolean => {
    const [cols, rows] = shape;
    if (x + cols > WALL_COLS) return false;
    for (let dx = 0; dx < cols; dx += 1) {
      for (let dy = 0; dy < rows; dy += 1) {
        if (taken.has(key(x + dx, y + dy))) return false;
      }
    }
    return true;
  };

  songs.slice(0, MAX_TILES).forEach((song, songIndex) => {
    // 走到第一个空格（游标不主动推进，等价于「后面的小片回头补洞」）。
    while (taken.has(key(col, row))) {
      col += 1;
      if (col >= WALL_COLS) {
        col = 0;
        row += 1;
      }
    }

    const hashed = SHAPES[(((col * 7 + row * 3) % SHAPES.length) + SHAPES.length) % SHAPES.length];
    const wanted = hashed ?? FALLBACK;
    const ordered: readonly Shape[] = [wanted, ...SHAPES.filter((shape) => shape !== wanted)];
    const shape = ordered.find((candidate) => fits(col, row, candidate)) ?? FALLBACK;
    const [cols, rows] = shape;

    for (let dx = 0; dx < cols; dx += 1) {
      for (let dy = 0; dy < rows; dy += 1) taken.add(key(col + dx, row + dy));
    }
    tiles.push({ song, songIndex, col, row, cols, rows });
  });

  return tiles;
}

export function LikedWall({ songs, onSelect }: LikedWallProps): ReactNode {
  const play = usePlayer((s) => s.play);
  const currentId = usePlayer((s) => s.currentSong?.id);

  // 铺法是纯函数：列表不变就不重算（否则每次 hover 重渲染都会重排整面墙）。
  const tiles = useMemo(() => layoutTiles(songs), [songs]);

  if (songs.length === 0) {
    return <div className="pi-placeholder">这里还没有内容。</div>;
  }

  return (
    <div className="pi-wall" data-liked-wall data-tiles={tiles.length}>
      {tiles.map((tile) => {
        const { song } = tile;
        const cover = coverAt(song.album?.coverUrl, 400);
        const artists = artistNames(song);
        return (
          <button
            key={song.id}
            type="button"
            className="pi-wall__tile"
            data-liked-tile={song.id}
            data-active={song.id === currentId}
            // 入场波的相位 = 离左上角那格的曼哈顿距离（格子数），CSS 里乘 18ms。
            style={
              {
                gridColumn: `${tile.col + 1} / span ${tile.cols}`,
                gridRow: `${tile.row + 1} / span ${tile.rows}`,
                '--pi-wave': tile.col + tile.row,
              } as CSSProperties
            }
            title={`${song.name} - ${artists}`}
            onClick={() => {
              onSelect(song);
              // 和 SongList 一样「点哪首就从哪首开始播」：onSelect 只管当前曲，
              // 真出声要靠 play(整个列表, 下标)。
              void play(songs, tile.songIndex);
            }}
          >
            {cover === undefined ? (
              <span className="pi-wall__cover pi-wall__cover--empty">
                <Icon name="music" />
              </span>
            ) : (
              <img className="pi-wall__cover" src={cover} alt="" loading="lazy" draggable={false} />
            )}
            <span className="pi-wall__meta">
              <span className="pi-wall__name">{song.name}</span>
              <span className="pi-wall__artists">{artists}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
