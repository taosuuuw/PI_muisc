import type { ReactNode } from 'react';

import { Icon } from './Icons';

/**
 * 第十八轮第 7 条（用户 m01482）：拼贴视图顶上那条「滚轮向下打开」的搜索条。
 *
 * 原来这份 markup 直接内联在 `pages/MinePage.tsx` 里（第十六轮第 6 条做的），
 * 这一轮歌单详情的拼贴浮层也要同一根条，所以抽出来给两个宿主共用：
 * 位置 / 进·退场动画 / 玻璃皮肤都在 `styles/global.css` 的 `.pi-collage-search` 里，
 * 本组件只负责结构。属性选择器（`data-collage-search` 等）与原来逐字一致，
 * 冒烟探针继续按老口径读得到。
 *
 * `closing` 是「正在升回顶部」的那一帧：宿主先置 `closing`、等
 * `COLLAGE_SEARCH_EXIT_MS` 之后再卸载本组件（退场动画放完）。
 */
export const COLLAGE_SEARCH_EXIT_MS = 220;

export interface CollageSearchBarProps {
  value: string;
  note: string;
  /** 正在播退场动画（升回顶部）。 */
  closing?: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
}

export function CollageSearchBar({
  value,
  note,
  closing = false,
  onChange,
  onClose,
}: CollageSearchBarProps): ReactNode {
  return (
    <div
      className="pi-collage-search"
      data-collage-search="true"
      data-collage-search-closing={closing ? 'true' : 'false'}
    >
      <Icon name="search" size={16} />
      <input
        className="pi-collage-search__input"
        data-collage-search-input="true"
        value={value}
        autoFocus
        spellCheck={false}
        placeholder="搜这面墙上的歌名 / 歌手 / 专辑"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // 歌单详情浮层自己也挂着 window 上的 Esc（收整层浮层）。在搜索框里按 Esc 只该
            // 收起搜索条，所以这里把事件拦在 React 根里，别冒到 window 上去。
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="pi-collage-search__note" data-collage-search-note="true">
        {note}
      </span>
      <button
        type="button"
        className="pi-iconbtn"
        data-collage-search-close="true"
        aria-label="收起搜索"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
