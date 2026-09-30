import { useMemo, type ReactNode } from 'react';
import type { Comment } from '@pi/shared';
import { errorMessage } from '../bridge';
import { useComments } from '../lib/queries';
// 用户 m03805 第 1 条：「加载更多评论」按钮换成滑到底自动加载。
import { useAutoLoadMore } from '../lib/useAutoLoadMore';
import { Icon } from './Icons';

/** 每页评论条数：够填满一屏，又不至于一次拉太多。 */
const PAGE_SIZE = 20;

/**
 * 歌曲评论面板（用户需求 m04781 第 4 条 + docs/PLAN.md M4）。
 *
 * 两段式：热门评论在上，最新评论在下并支持「加载更多」。
 * 热门和最新会重复（网易云的热门就是从全部评论里挑的），按 id 去重。
 */
export function CommentPanel({ songId }: { songId: number }): ReactNode {
  const query = useComments(songId, PAGE_SIZE);
  const pages = useMemo(() => query.data?.pages ?? [], [query.data]);

  const hot = useMemo(() => {
    const seen = new Set<number>();
    return (pages[0]?.hot ?? []).filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  }, [pages]);

  const latest = useMemo(() => {
    const seen = new Set<number>();
    const out: Comment[] = [];
    for (const page of pages) {
      for (const item of page.comments) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [pages]);

  const total = pages[0]?.total ?? 0;

  /**
   * 用户 m03805 第 1 条（原来的「加载更多」按钮改成下滑自动加载）：
   * 哨兵滚进抽屉正文（`.pi-home__drawer-body`，本组件最近的滚动祖先）的预载区就要下一页。
   * 注意这个 hook 必须在下面那几个提前 return 之前调用 —— 否则「先 pending 后成功」时
   * hook 数量会变，React 直接报错。
   */
  const moreRef = useAutoLoadMore({
    canLoad: query.hasNextPage,
    loading: query.isFetchingNextPage,
    onLoad: () => void query.fetchNextPage(),
  });

  if (query.isPending) {
    return <p className="pi-comments__hint">正在读取评论…</p>;
  }

  if (query.isError) {
    return (
      <p className="pi-comments__hint pi-comments__hint--error">
        评论读取失败：{errorMessage(query.error)}
      </p>
    );
  }

  if (hot.length === 0 && latest.length === 0) {
    return <p className="pi-comments__hint">这首歌还没有评论。</p>;
  }

  return (
    <div className="pi-comments">
      {hot.length > 0 ? (
        <section className="pi-comments__group">
          <h3 className="pi-comments__title">
            <Icon name="comment" size={15} /> 热门评论
          </h3>
          {hot.map((item) => (
            <CommentRow key={`hot-${item.id}`} comment={item} />
          ))}
        </section>
      ) : null}

      <section className="pi-comments__group">
        <h3 className="pi-comments__title">
          最新评论{total > 0 ? <span className="pi-comments__count">{total}</span> : null}
        </h3>
        {latest.map((item) => (
          <CommentRow key={item.id} comment={item} />
        ))}
      </section>

      {query.hasNextPage ? (
        /* 用户 m03805 第 1 条（原来的「加载更多」按钮改成下滑自动加载）：按钮删掉，
           只留一颗被动哨兵；加载中显示一行淡字，其余时候什么都不渲染。 */
        <div className="pi-loadmore" data-auto-loadmore="true" ref={moreRef}>
          {query.isFetchingNextPage ? (
            <span className="pi-comments__hint">正在加载更多评论…</span>
          ) : null}
        </div>
      ) : latest.length > 0 ? (
        <p className="pi-comments__hint">已经到底了。</p>
      ) : null}
    </div>
  );
}

function CommentRow({ comment }: { comment: Comment }): ReactNode {
  return (
    <article className="pi-comment">
      {comment.user.avatarUrl ? (
        <img className="pi-comment__avatar" src={comment.user.avatarUrl} alt="" loading="lazy" />
      ) : (
        <div className="pi-comment__avatar pi-comment__avatar--empty">
          <Icon name="user" size={16} />
        </div>
      )}
      <div className="pi-comment__body">
        <div className="pi-comment__head">
          <span className="pi-comment__name">{comment.user.nickname}</span>
          <span className="pi-comment__time">{formatCommentTime(comment.time)}</span>
        </div>
        <p className="pi-comment__text">{comment.content}</p>
        {comment.beReplied && comment.beReplied.length > 0 ? (
          <blockquote className="pi-comment__reply">
            {comment.beReplied.map((reply, index) => (
              <span key={index}>
                <b>@{reply.nickname}</b>：{reply.content}
              </span>
            ))}
          </blockquote>
        ) : null}
        <div className="pi-comment__foot">
          {comment.location ? <span className="pi-comment__loc">{comment.location}</span> : null}
          <span className="pi-comment__like">
            <Icon name="heart" size={13} />
            {comment.likedCount > 0 ? comment.likedCount : ''}
          </span>
        </div>
      </div>
    </article>
  );
}

/** 今天只显示时分，跨年才带年份——评论区最常看的是「多久以前」。 */
function formatCommentTime(time: number): string {
  if (!time || time <= 0) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}-${md}`;
}
