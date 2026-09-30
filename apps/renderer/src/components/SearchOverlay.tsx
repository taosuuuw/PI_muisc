import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CH, errorMessage, invoke } from '../bridge';
import { Icon } from './Icons';
import { SongCards } from './SongCards';
import { usePlayer } from '../state/player';
import { useUi } from '../state/ui';

/**
 * 搜索浮层（用户 m06304 第 6 条）。
 *
 * 与搜索页的分工：搜索页是「整页」，这里只是**盖在当前页上的一层**。
 * 点环形菜单的「搜索」时用户多半正在听歌或翻歌单，把整页换掉等于把上下文冲掉，
 * 所以这里只做整体模糊 + 中间一个搜索框，点结果直接播，不跳搜索页。
 *
 * 第九轮第 6 条：结果不再是「一行横向小卡」（`.pi-searchoverlay__card` 那套已删），
 * 而是和歌单里**一模一样**的 `SongCards` 卡片流（含它自己的拖拽与实时高亮）。
 */
export function SearchOverlay(): ReactNode {
  const searchOpen = useUi((s) => s.searchOpen);
  const closeSearch = useUi((s) => s.closeSearch);
  const navigate = useUi((s) => s.navigate);
  const play = usePlayer((s) => s.play);

  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState('');
  const [keywords, setKeywords] = useState('');

  // 开合都清空：打开时是一次全新的搜索，关上后也不把关键词留在 store 里。
  useEffect(() => {
    setInput('');
    setKeywords('');
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  // 去抖 220ms：内嵌的 API 子进程是串行的，逐字符打过去会把输入拖顿。
  useEffect(() => {
    const timer = window.setTimeout(() => setKeywords(input.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    if (!searchOpen) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeSearch();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [searchOpen, closeSearch]);

  const query = useQuery({
    queryKey: ['search-overlay', keywords],
    queryFn: () => invoke(CH.ncmSearch, { keywords, limit: 12 }),
    enabled: keywords.length > 0,
    retry: 1,
  });
  // 先取出 data 再判空：TanStack Query 的布尔量不会缩小 data 的类型（同搜索页）。
  const songs = query.data?.songs ?? [];

  if (!searchOpen) return null;

  return (
    <div
      className="pi-searchoverlay"
      data-open={searchOpen}
      data-cards={songs.length}
      onClick={(event) => {
        // 只有点到玻璃层本身（盒子之外）才关：点盒子里或卡片上冒泡上来不算。
        if (event.target === event.currentTarget) closeSearch();
      }}
    >
      <div className="pi-searchoverlay__box" role="dialog" aria-modal="true" aria-label="搜索">
        <Icon name="search" size={18} className="pi-searchoverlay__icon" />
        <input
          ref={inputRef}
          className="pi-searchoverlay__input"
          data-search-input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // 这里不是 <form>，但 Enter 仍要吃掉：否则会冒泡给底下的页面。
            if (event.key === 'Enter') event.preventDefault();
          }}
          placeholder="搜索歌曲、歌手、专辑…"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="pi-searchoverlay__close"
          data-close
          aria-label="关闭搜索"
          onClick={closeSearch}
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      {keywords.length === 0 ? (
        <p className="pi-searchoverlay__hint">输入关键词，实时搜索歌曲、歌手、专辑。</p>
      ) : query.isError ? (
        <p className="pi-searchoverlay__error">{errorMessage(query.error)}</p>
      ) : query.data === undefined ? (
        <p className="pi-searchoverlay__hint">正在搜索「{keywords}」…</p>
      ) : songs.length === 0 ? (
        <p className="pi-searchoverlay__hint">没有找到「{keywords}」相关的歌曲。</p>
      ) : (
        <div className="pi-searchoverlay__stage" data-results data-cards={songs.length}>
          <SongCards
            songs={songs}
            onSelect={(song) => {
              // 整行结果当作播放队列：点一首之后还能顺着往下听。
              const index = songs.findIndex((item) => item.id === song.id);
              void play(songs, index < 0 ? 0 : index);
              navigate('home');
              closeSearch();
            }}
          />
        </div>
      )}
    </div>
  );
}
