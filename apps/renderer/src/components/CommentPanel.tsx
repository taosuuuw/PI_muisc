import { useMemo, useState, type ReactNode } from 'react';
import type { Comment } from '@pi/shared';
import { errorMessage } from '../bridge';
import { useAccount, useComments, useLikeComment, usePostComment } from '../lib/queries';
// 用户 m03805 第 1 条：「加载更多评论」按钮换成滑到底自动加载。
import { useAutoLoadMore } from '../lib/useAutoLoadMore';
import { useUi } from '../state/ui';
import { Icon } from './Icons';
import '../styles/comments.css';

/** 每页评论条数：够填满一屏，又不至于一次拉太多。 */
const PAGE_SIZE = 20;

/**
 * 网易云自己的评论上限；超出会被上游截断，不如在本地就拦住。
 */
const MAX_CONTENT = 140;

/**
 * 歌曲评论面板（用户需求 m04781 第 4 条 + docs/PLAN.md M4）。
 *
 * 两段式：热门评论在上，最新评论在下并支持「加载更多」。
 * 热门和最新会重复（网易云的热门就是从全部评论里挑的），按 id 去重。
 *
 * **用户第五轮第 8 条**：「评论页可以点击红心点赞，可以打字评论，回复评论」。
 * 三件事都在这个文件里落地：
 * - 红心：每条评论那枚心形是一颗**按钮**，点它点赞/取消；数字就地从缓存改（不重拉整页，
 *   否则用户滚到一半的位置会被冲掉）；
 * - 打字评论：面板顶部一个输入区（`Composer`），限长 140、Ctrl+Enter 发送；
 * - 回复：每条评论的「回复」把被回复者记进 `Composer` 的 `replyTo`，正文里由**主进程**
 *   拼上 `回复@某某:` 前缀（网易云要求正文与 `commentId` 一起给，见 `ncm-client`）。
 *
 * 三件事都要登录：未登录时红心与发送键点下去只给一句「要登录才能评论」并开登录浮层，
 * 不会静默失败。
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

  // 下面这几个 hook 同样必须无条件调用（原因同上）。
  const account = useAccount();
  const loggedIn = account.data?.loggedIn === true;
  const openLogin = useUi((state) => state.openLogin);
  const post = usePostComment();
  const likeComment = useLikeComment();
  /** 正在回复谁；`null` = 发顶层评论。 */
  const [replyTo, setReplyTo] = useState<{ commentId: number; nickname: string } | null>(null);

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

  const composer = (
    <Composer
      loggedIn={loggedIn}
      replyTo={replyTo}
      pending={post.isPending}
      error={post.error === null ? null : errorMessage(post.error)}
      onCancelReply={() => setReplyTo(null)}
      onRequireLogin={openLogin}
      onSubmit={(content) => {
        post.mutate(
          { songId, content, ...(replyTo === null ? {} : { replyTo: { commentId: replyTo.commentId, nickname: replyTo.nickname } }) },
          { onSuccess: () => setReplyTo(null) },
        );
      }}
    />
  );

  // 列表读到了但一条都没有：**输入区仍然要留下**（用户就是来发第一条评论的），
  // 所以这里返回的是一段带输入框的空态，而不是早退成一行提示。
  if (hot.length === 0 && latest.length === 0) {
    return (
      <div className="pi-comments">
        {composer}
        <p className="pi-comments__hint">这首歌还没有评论，来做第一个吧。</p>
      </div>
    );
  }

  return (
    <div className="pi-comments">
      {composer}

      {hot.length > 0 ? (
        <section className="pi-comments__group">
          <h3 className="pi-comments__title">
            <Icon name="comment" size={15} /> 热门评论
          </h3>
          {hot.map((item) => (
            <CommentRow
              key={`hot-${item.id}`}
              comment={item}
              loggedIn={loggedIn}
              likePending={likeComment.isPending}
              onRequireLogin={openLogin}
              onReply={() => setReplyTo({ commentId: item.id, nickname: item.user.nickname })}
              onLike={(next) =>
                likeComment.mutate({
                  songId,
                  commentId: item.id,
                  like: next,
                  likedCount: item.likedCount,
                })
              }
            />
          ))}
        </section>
      ) : null}

      <section className="pi-comments__group">
        <h3 className="pi-comments__title">
          最新评论{total > 0 ? <span className="pi-comments__count">{total}</span> : null}
        </h3>
        {latest.length === 0 ? (
          <p className="pi-comments__hint">暂时只有热门评论。</p>
        ) : (
          latest.map((item) => (
            <CommentRow
              key={`new-${item.id}`}
              comment={item}
              loggedIn={loggedIn}
              likePending={likeComment.isPending}
              onRequireLogin={openLogin}
              onReply={() => setReplyTo({ commentId: item.id, nickname: item.user.nickname })}
              onLike={(next) =>
                likeComment.mutate({
                  songId,
                  commentId: item.id,
                  like: next,
                  likedCount: item.likedCount,
                })
              }
            />
          ))
        )}
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

/**
 * 评论输入区（用户第五轮第 8 条）。
 *
 * 三件事必须同时成立才算「能发」：登录了、正文非空、没有还在飞的请求。
 * 未登录时不把输入框藏起来（那会让人以为「这里不能评论」），而是照常让用户打字，
 * 点发送时才告诉他「要登录」并把登录浮层叫出来 —— 打完字才被拦，比一开始就不给打字更友好。
 */
function Composer({
  loggedIn,
  replyTo,
  pending,
  error,
  onSubmit,
  onCancelReply,
  onRequireLogin,
}: {
  loggedIn: boolean;
  replyTo: { commentId: number; nickname: string } | null;
  pending: boolean;
  error: string | null;
  onSubmit: (content: string) => void;
  onCancelReply: () => void;
  onRequireLogin: () => void;
}): ReactNode {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const tooLong = trimmed.length > MAX_CONTENT;
  const canSend = trimmed.length > 0 && !tooLong && !pending;

  const submit = (): void => {
    if (!canSend) return;
    if (!loggedIn) {
      onRequireLogin();
      return;
    }
    onSubmit(trimmed);
    setText('');
  };

  return (
    <div className="pi-commentbox" data-comment-composer="true" data-reply-to={replyTo?.commentId ?? ''}>
      {replyTo === null ? null : (
        <div className="pi-commentbox__reply" data-comment-reply-to={replyTo.commentId}>
          <span>
            回复 <b>@{replyTo.nickname}</b>
          </span>
          <button
            type="button"
            className="pi-commentbox__replycancel"
            data-comment-reply-cancel="true"
            aria-label="取消回复"
            onClick={onCancelReply}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      <textarea
        className="pi-commentbox__input"
        data-comment-input="true"
        rows={2}
        value={text}
        placeholder={replyTo === null ? '说点什么…（Ctrl+Enter 发送）' : `回复 @${replyTo.nickname}…`}
        aria-label="评论内容"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
          if (event.key === 'Escape' && replyTo !== null) onCancelReply();
        }}
      />

      <div className="pi-commentbox__foot">
        <span
          className="pi-commentbox__count"
          data-comment-count={trimmed.length}
          data-comment-over={tooLong ? 'true' : 'false'}
        >
          {trimmed.length}/{MAX_CONTENT}
        </span>
        {error === null ? null : <span className="pi-commentbox__error">{error}</span>}
        <button
          type="button"
          className="pi-btn pi-btn--primary pi-commentbox__send"
          data-comment-send="true"
          disabled={!canSend}
          title={loggedIn ? '发表评论' : '要登录才能评论'}
          onClick={submit}
        >
          {pending ? '发送中…' : replyTo === null ? '发表' : '回复'}
        </button>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  loggedIn,
  likePending,
  onLike,
  onReply,
  onRequireLogin,
}: {
  comment: Comment;
  loggedIn: boolean;
  likePending: boolean;
  onLike: (next: boolean) => void;
  onReply: () => void;
  onRequireLogin: () => void;
}): ReactNode {
  const liked = comment.liked === true;

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
          <button
            type="button"
            className="pi-comment__replybtn"
            data-comment-reply={comment.id}
            onClick={onReply}
          >
            回复
          </button>
          {/* 红心是一颗**按钮**：点它点赞 / 取消（用户第五轮第 8 条）。 */}
          <button
            type="button"
            className="pi-comment__like"
            data-comment-like={comment.id}
            data-liked={liked ? 'true' : 'false'}
            aria-pressed={liked}
            aria-label={liked ? '取消点赞' : '点赞'}
            title={loggedIn ? (liked ? '取消点赞' : '点赞') : '要登录才能点赞'}
            disabled={likePending}
            onClick={() => {
              if (!loggedIn) {
                onRequireLogin();
                return;
              }
              onLike(!liked);
            }}
          >
            <Icon name="heart" size={13} />
            {comment.likedCount > 0 ? comment.likedCount : ''}
          </button>
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
