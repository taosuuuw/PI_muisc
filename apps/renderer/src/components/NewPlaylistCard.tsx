import { useState, type ReactNode } from 'react';
import { errorMessage } from '../bridge';
import { useCreatePlaylist } from '../lib/queries';
import { Icon } from './Icons';

export interface NewPlaylistCardProps {
  /** 建好了：把新歌单的 id 与名字交给调用方（通常是直接打开它）。 */
  onCreated: (playlistId: number, name: string) => void;
}

/**
 * 「我的歌单」的空白卡片（用户 m06982 第 1 条）。
 *
 * 一个歌单都没有时，页面正中放一张虚线空卡片：点一下就地变成输入框，输名字回车
 * 即建；建完立刻把新歌单打开 —— 用户下一步一定是要往里加歌，不该再让他回列表点一次。
 * 名字交给云端（`/playlist/create`），本地不猜 id、不猜封面。
 */
export function NewPlaylistCard({ onCreated }: NewPlaylistCardProps): ReactNode {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const create = useCreatePlaylist();

  function submit(): void {
    const trimmed = name.trim();
    if (trimmed.length === 0 || create.isPending) return;
    create.mutate(trimmed, {
      onSuccess: (result) => {
        setNaming(false);
        setName('');
        onCreated(result.playlistId, trimmed);
      },
    });
  }

  if (!naming) {
    return (
      <button
        type="button"
        className="pi-newplaylist"
        data-newplaylist
        onClick={() => setNaming(true)}
      >
        <span className="pi-newplaylist__plus" aria-hidden="true">
          <Icon name="plus" size={26} />
        </span>
        <strong>新建歌单</strong>
        <span className="pi-newplaylist__hint">点一下起个名字，然后往里加歌</span>
      </button>
    );
  }

  return (
    <div className="pi-newplaylist pi-newplaylist--naming" data-newplaylist-naming>
      <strong>给这个歌单起个名字</strong>
      <input
        className="pi-newplaylist__input"
        data-newplaylist-input
        value={name}
        autoFocus
        maxLength={40}
        placeholder="例如：夜里听的"
        spellCheck={false}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            // 只退回卡片、别顺带把整个环形菜单收掉（PiOrb 在 document 上听 Escape）。
            // 和 AddTracksPanel 一个口径：面板先吃掉这一下。
            event.stopPropagation();
            setNaming(false);
            setName('');
          }
        }}
      />
      <div className="pi-newplaylist__actions">
        <button
          type="button"
          className="pi-btn pi-btn--primary"
          data-newplaylist-submit
          disabled={create.isPending || name.trim().length === 0}
          onClick={submit}
        >
          {create.isPending ? '正在创建…' : '创建'}
        </button>
        <button
          type="button"
          className="pi-btn"
          onClick={() => {
            setNaming(false);
            setName('');
          }}
        >
          取消
        </button>
      </div>
      {create.isError ? (
        <p className="pi-newplaylist__error">{errorMessage(create.error)}</p>
      ) : null}
    </div>
  );
}
