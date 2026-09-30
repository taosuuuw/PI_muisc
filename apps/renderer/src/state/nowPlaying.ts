import { create } from 'zustand';
import type { Song } from '@pi/shared';

interface NowPlayingState {
  song: Song | null;
  /**
   * 记录「当前选中的歌」，供列表高亮使用；真正的播放由 `state/player.ts` 负责。
   * （M3 改版前这里还有一个 `detailOpen` 浮层开关，详情页改成播放器主页后不需要了。）
   */
  select: (song: Song) => void;
}

export const useNowPlaying = create<NowPlayingState>((set) => ({
  song: null,
  select: (song) => set({ song }),
}));
