import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CH, errorMessage, invoke } from '../bridge';
import { Icon } from '../components/Icons';
import { SongCards } from '../components/SongCards';
import { useNowPlaying } from '../state/nowPlaying';
import { useUi } from '../state/ui';

/**
 * 搜索页。
 * M0 唯一接通真实数据的页面：`/cloudsearch` → 主进程 → 内嵌 API 子进程。
 *
 * 关键词存在 `state/ui.ts`：M3 改版后侧边抽屉顶部也有一个搜索框，
 * 两个入口必须指向同一次搜索，否则从抽屉搜完跳过来会看到空页面。
 */
export function SearchPage(): ReactNode {
  const keywords = useUi((s) => s.searchKeywords);
  const setKeywords = useUi((s) => s.setSearchKeywords);
  const [input, setInput] = useState(keywords);
  const select = useNowPlaying((s) => s.select);

  // 抽屉里改了关键词（页面已经挂在屏幕上）时，把输入框也同步过来。
  useEffect(() => setInput(keywords), [keywords]);

  const query = useQuery({
    queryKey: ['search', keywords],
    queryFn: () => invoke(CH.ncmSearch, { keywords, limit: 30 }),
    enabled: keywords.length > 0,
    retry: 1,
  });
  // 先取出 data 再判空：TanStack Query 的 isPending/isError 布尔量不会缩小 data 的类型。
  const data = query.data;

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    const value = input.trim();
    if (value.length === 0) return;
    setKeywords(value);
  }

  return (
    <>
      <h1 className="pi-page-title">搜索</h1>
      <p className="pi-page-sub">数据来源：内嵌的网易云 API 子进程（127.0.0.1，仅本机）</p>

      <form className="pi-searchbar" onSubmit={onSubmit}>
        <Icon name="search" size={16} />
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="搜索歌曲、歌手、专辑…"
          spellCheck={false}
        />
        <button type="submit" className="pi-btn" style={{ height: 28, padding: '0 14px' }}>
          搜索
        </button>
      </form>

      {keywords.length === 0 ? (
        <div className="pi-card pi-placeholder">
          <strong>输入关键词开始搜索。</strong>
          <span>例如：周杰伦、晴天、海阔天空。</span>
        </div>
      ) : query.isError ? (
        <div className="pi-card pi-placeholder" style={{ color: '#E5484D' }}>
          <strong>搜索失败</strong>
          <span>{errorMessage(query.error)}</span>
        </div>
      ) : data === undefined ? (
        <div className="pi-card pi-placeholder">正在搜索「{keywords}」…</div>
      ) : (
        <>
          <p className="pi-page-sub">找到 {data.songs.length} 首歌曲</p>
          <SongCards songs={data.songs} onSelect={select} />
        </>
      )}
    </>
  );
}
