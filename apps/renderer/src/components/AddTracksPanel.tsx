import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Song } from '@pi/shared';
import { CH, errorMessage, invoke } from '../bridge';
import { useEditPlaylistTracks } from '../lib/queries';
import { Icon } from './Icons';
import { SongCards } from './SongCards';

export interface AddTracksPanelProps {
  playlistId: number;
  onClose: () => void;
  /** 成功加进去一首：调用方据此把曲目列表重新拉一遍。 */
  onAdded: () => void;
}

const SEARCH_LIMIT = 20;
const DEBOUNCE_MS = 220;

/**
 * 「往歌单里加歌」面板（用户 m06982 第 1 条）。
 *
 * 交互取舍（沿用）：一次加一首，不做多选再统一提交。这个操作几乎总是「搜一首、加一首」，
 * 多选会把「加进去了没有」这个最需要即时确认的事推迟到批量提交之后。
 *
 * 展示形式（本轮用户反馈 ①「所有歌展示都要是卡片式」）：搜索结果不再是一行行的
 * `.pi-addtracks__row`，而是和搜索框下那张列表**同一套** `SongCards` 卡片流。
 * 于是「加入」这个动作挂到卡片本身——点正中那张 = 加入，和别处「点中心卡片 = 播放」
 * 是同一套语义；卡片流里点旁边那张只会把它滑到正中、不触发 `onSelect`，所以不存在
 * 「想看清旁边那张的歌名，结果手滑把它加进去」的风险。「已加入」就地显示在同一张卡的
 * 副标题行末尾（`metaOf`）。
 *
 * `data-*` 契约：`.pi-addtracks`（面板）/ `-input` / `-close`（头部）不变；换成卡片流之后，
 * 原来的每行抓手改由 `SongCards` 的 `cardDataOf` 挂在卡片按钮上——
 * `data-addtracks-row={song.id}` 与 `data-addtracks-add={song.id}` 语义仍在（点它 = 点这张卡），
 * 另外多一个 `data-addtracks-added`（`'true'` = 这一首已经加进去了）。
 */
export function AddTracksPanel({ playlistId, onClose, onAdded }: AddTracksPanelProps): ReactNode {
  const [input, setInput] = useState('');
  const [keywords, setKeywords] = useState('');
  const [added, setAdded] = useState<number[]>([]);
  const edit = useEditPlaylistTracks();

  // 输入去抖：每敲一个字都打一次搜索接口既慢又容易被上游限流。
  useEffect(() => {
    const trimmed = input.trim();
    if (trimmed === keywords) return;
    const timer = window.setTimeout(() => setKeywords(trimmed), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input, keywords]);

  const query = useQuery({
    queryKey: ['search-add', keywords, SEARCH_LIMIT],
    queryFn: () => invoke(CH.ncmSearch, { keywords, limit: SEARCH_LIMIT }),
    enabled: keywords.length > 0,
    retry: 1,
  });

  function add(song: Song): void {
    if (edit.isPending) return;
    edit.mutate(
      { playlistId, trackIds: [song.id], op: 'add' },
      {
        onSuccess: () => {
          setAdded((prev) => (prev.includes(song.id) ? prev : [...prev, song.id]));
          onAdded();
        },
      },
    );
  }

  const songs = query.data?.songs ?? [];

  return (
    <section className="pi-addtracks" data-addtracks aria-label="往歌单里加歌">
      <header className="pi-addtracks__bar">
        <Icon name="search" size={18} />
        <input
          className="pi-addtracks__input"
          data-addtracks-input
          value={input}
          autoFocus
          spellCheck={false}
          placeholder="搜歌名、歌手或专辑，点正中那张卡片加入"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // 只关面板、不关整个歌单页：面板抢在 window 那个 Escape 监听之前吃掉这一下。
            event.stopPropagation();
            onClose();
          }}
        />
        <button type="button" className="pi-iconbtn" data-addtracks-close onClick={onClose} aria-label="收起">
          <Icon name="close" />
        </button>
      </header>

      {edit.isError ? (
        <div className="pi-card pi-placeholder pi-addtracks__error">
          <strong>加歌失败</strong>
          <span>{errorMessage(edit.error)}</span>
        </div>
      ) : null}

      {query.isError ? (
        <div className="pi-card pi-placeholder">
          <strong>搜索失败</strong>
          <span>{errorMessage(query.error)}</span>
        </div>
      ) : null}

      {keywords.length === 0 ? (
        <p className="pi-placeholder">输入关键词开始搜索。</p>
      ) : query.isPending ? (
        <p className="pi-placeholder">正在搜索…</p>
      ) : songs.length === 0 ? (
        <p className="pi-placeholder">没有搜到「{keywords}」。</p>
      ) : (
        <SongCards
          songs={songs}
          // 点正中那张 = 把这一首加进歌单（点旁边那张只聚焦，见文件头注释）。
          onSelect={add}
          // 加歌面板不该顺手改播放队列 / 开播放页。
          disablePlay
          hint="滚轮 / ←→ / 拖动切换，点正中那张卡片加入"
          // 「已加入」就地显示在副标题行末尾（和「播放 12 次」同一套 metaOf）。
          metaOf={(song) => (added.includes(song.id) ? '已加入' : undefined)}
          // 老抓手照旧挂在每张卡片上；多一个 data-addtracks-added 供自动化判断加没加过。
          cardDataOf={(song) => ({
            'data-addtracks-row': song.id,
            'data-addtracks-add': song.id,
            'data-addtracks-added': added.includes(song.id) ? 'true' : undefined,
          })}
        />
      )}
    </section>
  );
}
