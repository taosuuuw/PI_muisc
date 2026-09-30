import type { Playlist } from '@pi/shared';

/**
 * 歌单列表里那条「我喜欢的音乐」。
 *
 * 网易云把它当成一条普通的 specialType=5 系统歌单塞在 `/user/playlist` 里，
 * 之前 `MinePage` 是把它**过滤掉**的（因为「我的喜欢」单独有一页）。
 * 用户第十七轮第 ④ 条要求它回到「我的歌单」并且排第一，所以过滤改成置首。
 */
export const LIKED_SPECIAL_TYPE = 5;

/** 上游偶尔不给这条系统歌单名字，这时用这个兜底（只在展示层用）。 */
export const LIKED_NAME = '我喜欢的音乐';

export function isLikedPlaylist(playlist: Pick<Playlist, 'specialType'>): boolean {
  return playlist.specialType === LIKED_SPECIAL_TYPE;
}

/**
 * 把「我喜欢的音乐」挪到首位（用户第十七轮第 ④ 条），其余歌单保持上游顺序。
 *
 * 为什么用 `specialType` 而不是名字判断：名字会跟着账号语言变，`specialType` 不会；
 * 而且用户自己完全可以建一个叫「我喜欢的音乐」的普通歌单。
 */
export function withLikedFirst(playlists: readonly Playlist[]): Playlist[] {
  const liked: Playlist[] = [];
  const rest: Playlist[] = [];
  for (const playlist of playlists) {
    if (!isLikedPlaylist(playlist)) {
      rest.push(playlist);
      continue;
    }
    liked.push(playlist.name ? playlist : { ...playlist, name: LIKED_NAME });
  }
  return [...liked, ...rest];
}
