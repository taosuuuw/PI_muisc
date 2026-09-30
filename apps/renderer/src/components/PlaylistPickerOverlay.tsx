import { useEffect, useState, type ReactNode } from 'react';
import { errorMessage } from '../bridge';
import { coverAt } from '../lib/cover';
import { useAccount, useEditPlaylistTracks, useMyPlaylists } from '../lib/queries';
import { Icon } from './Icons';
import '../styles/playlist-picker.css';

/**
 * 「收藏到歌单」选歌单浮窗（用户 m02898 第 3 条）。
 *
 * 起因：播放页左下名片封面**右下角**那颗 `data-card-action="like"` 键原来只是
 * 「加入我喜欢的音乐」的第二个入口（和名片底部那颗 `data-card-like` 爱心同源、同一次
 * `useToggleLike()`）。用户要的是：点它 → **窗口正中心**弹一层浮窗列出「我的歌单」，
 * 选一个 → 把当前这首歌加进那个歌单。底部那颗爱心**不动**，它仍然是「我喜欢的音乐」开关。
 *
 * ## 数据与写入口子全用既有的
 * - 歌单列表：`lib/queries.ts:87` 的 `useMyPlaylists(enabled)`（查 `[library, playlists]`，
 *   输出 `{ playlists: Playlist[] }`，与「我的歌单」页同一份缓存）。
 * - 加歌：`lib/queries.ts:112` 的 `useEditPlaylistTracks()`，入参
 *   `{ playlistId, trackIds, op?: 'add' | 'del' }`；成功后它自己让
 *   `[library, playlist, id]` 与 `[library, playlists]` 失效（曲目数会跟着刷新）。
 * - 登录态：`useAccount()`，与名片、快捷设置卡同一个 hook。
 * 这里**不新建**任何 IPC 通道、不自己拼歌单 id，也不在本地改缓存。
 *
 * ## data-* 契约（冒烟/自动化靠它找节点，不要改名）
 * - 浮层根：`data-playlist-picker="true"`（`position: fixed` 居中，见 `styles/playlist-picker.css`）。
 * - 背板：`data-picker-backdrop="true"`（点它 = 关闭）。
 * - 关闭键：`data-picker-close="true"`。
 * - 每一行歌单：`data-picker-playlist="<歌单 id>"`；正在提交的那行 `data-active="true"`。
 * - 空态（含**未登录**那条提示）：`data-picker-empty="true"`。
 * - 出错（加歌失败 / 列表拉取失败）：`data-picker-error="true"`，正文是 `errorMessage(error)`。
 */
export interface PlaylistPickerOverlayProps {
  /** 要加进歌单的那首歌（`Song.id`，就是网易云 songId）。 */
  songId: number;
  /** 收起浮窗（点关闭键、点背板、按 Esc、加歌成功后都走它）。 */
  onClose: () => void;
  /** 加歌成功：把歌单名交回调用方，由它收起浮窗并给一句轻提示。 */
  onAdded: (playlistName: string) => void;
}

export function PlaylistPickerOverlay({
  songId,
  onClose,
  onAdded,
}: PlaylistPickerOverlayProps): ReactNode {
  const loggedIn = useAccount().data?.loggedIn === true;
  // 未登录就不发这个请求（`enabled=false`）：那一档直接渲染「要登录才能收藏到歌单」，
  // 而不是等一个注定失败的 IPC 再显示错误。
  const playlists = useMyPlaylists(loggedIn);
  const edit = useEditPlaylistTracks();
  /** 正在提交的那一行（只用来做「加入中…」与 `data-active`，提交权仍归 `edit.isPending`）。 */
  const [pendingId, setPendingId] = useState<number | null>(null);

  // Esc 收起：和快捷卡片（`components/PiQuickPanels.tsx` 的 `useEscapeToDismiss`）同一套做法。
  // 只在本浮窗真的挂在页面上时才会注册，所以不需要额外判断「当前是不是我在最上层」。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = playlists.data?.playlists ?? [];

  const pick = (playlistId: number, playlistName: string): void => {
    if (edit.isPending) return;
    setPendingId(playlistId);
    edit.mutate(
      { playlistId, trackIds: [songId], op: 'add' },
      {
        onSuccess: () => onAdded(playlistName),
        // 失败**不关窗**：错误就显示在列表上方（`data-picker-error`），用户可以直接改选另一个歌单。
        onError: () => setPendingId(null),
      },
    );
  };

  return (
    <div
      className="pi-picker"
      data-playlist-picker="true"
      role="dialog"
      aria-modal="true"
      aria-label="添加到歌单"
    >
      <div
        className="pi-picker__backdrop"
        data-picker-backdrop="true"
        role="presentation"
        onClick={onClose}
      />
      <section className="pi-picker__card">
        <header className="pi-picker__head">
          <h2 className="pi-picker__title">添加到歌单</h2>
          <button
            type="button"
            className="pi-picker__close"
            data-picker-close="true"
            aria-label="关闭"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        {/* 加歌失败：留在窗里，用户可以直接换一个歌单重试。 */}
        {edit.isError ? (
          <p className="pi-picker__error" data-picker-error="true">
            {errorMessage(edit.error)}
          </p>
        ) : null}

        {!loggedIn ? (
          <p className="pi-picker__empty" data-picker-empty="true">
            要登录才能收藏到歌单
          </p>
        ) : playlists.isPending ? (
          <p className="pi-picker__empty">正在读取歌单…</p>
        ) : playlists.isError ? (
          <p className="pi-picker__error" data-picker-error="true">
            {errorMessage(playlists.error)}
          </p>
        ) : rows.length === 0 ? (
          <p className="pi-picker__empty" data-picker-empty="true">
            还没有歌单，先去「我的歌单」建一个
          </p>
        ) : (
          <div className="pi-picker__list">
            {rows.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                className="pi-picker__row"
                data-picker-playlist={playlist.id}
                data-active={pendingId === playlist.id ? 'true' : 'false'}
                disabled={edit.isPending}
                onClick={() => pick(playlist.id, playlist.name)}
              >
                {playlist.coverUrl ? (
                  <img
                    className="pi-picker__cover"
                    src={coverAt(playlist.coverUrl, 80)}
                    alt=""
                  />
                ) : (
                  <span className="pi-picker__cover pi-picker__cover--empty" aria-hidden="true">
                    <Icon name="list" size={16} />
                  </span>
                )}
                <span className="pi-picker__meta">
                  <span className="pi-picker__name">{playlist.name}</span>
                  <span className="pi-picker__count">{playlist.trackCount} 首</span>
                </span>
                {pendingId === playlist.id && edit.isPending ? (
                  <span className="pi-picker__busy">加入中…</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
