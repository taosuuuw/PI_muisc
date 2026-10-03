import type { ReactNode } from 'react';
import { AsyncSection } from '../components/AsyncSection';
import { BottomBar } from '../components/BottomBar';
import { NeedsLogin } from '../components/NeedsLogin';
import { Icon } from '../components/Icons';
import { PlaylistGrid } from '../components/PlaylistGrid';
import { dailyCoverUrls } from '../lib/cover';
import { useAccount, useMyPlaylists, usePersonalizedPlaylists, useRecommend } from '../lib/queries';
import { useUi } from '../state/ui';

/**
 * 收藏页（只剩歌单网格）。
 *
 * 原来的「推荐」那一面（每日推荐 / 私人雷达 / 推荐歌单 / 推荐新音乐）整块删掉了：
 * 用户 m08768 第 3 条要求去掉推荐页，`App.tsx` 的 PAGES 里那条路由也已摘掉，
 * 只剩这里一具没有入口的空壳 —— 留着只会让 `useRecommend` / `useRadar` /
 * `usePersonalizedPlaylists` / `useNewSongs` 四个接口永远闲置。
 * `tab` 收成单值而不是把 prop 整个拿掉：导航那头仍然显式传 `tab`，
 * 类型收窄到 `'star'` 就够了，调用点一个字都不用改。
 *
 * 第八轮第 6 条又去掉了「点歌单 → 在这一页里渲染 `PlaylistDetail`」那条路：
 * 现在点一张歌单是让播放页上的卡片列表浮层接管（`openPlaylist` 顺手把 `nav` 拨回 `home`），
 * 所以这一页回到「就是一排歌单卡片」。
 */
export interface PlaylistPageProps {
  /**
   * `star` = 收藏的歌单；`recommend` = 推荐歌单（第十六轮第 6 条新增）。
   *
   * 为什么把推荐请回来：m08768 第 3 条删掉推荐页时，推荐歌单还能从**悬浮球**的「推荐」
   * 封面环里看到；第十六轮第 6 条把悬浮球整个删了，六块按键里的「推荐歌单」就必须有个
   * 正经落点，于是这一页多出 `recommend` 一档（数据走 `/personalized`，未登录也拿得到）。
   */
  tab: 'star' | 'recommend';
}

const TITLES: Record<PlaylistPageProps['tab'], { title: string; sub: string }> = {
  star: { title: '收藏', sub: '我收藏的歌单（/user/playlist 里 subscribed=1 的部分）' },
  recommend: { title: '推荐歌单', sub: '网易云的推荐歌单（/personalized，未登录也能看）' },
};

export function PlaylistPage({ tab }: PlaylistPageProps): ReactNode {
  const account = useAccount();
  const loggedIn = account.data?.loggedIn === true;
  const openPlaylist = useUi((s) => s.openPlaylist);
  const openSongs = useUi((s) => s.openSongs);

  const playlists = useMyPlaylists(loggedIn && tab === 'star');
  /* 第十六轮第 6 条：推荐面不吃登录（`/personalized` 未登录也能返回结果，只是不个性化）。 */
  const personalized = usePersonalizedPlaylists(tab === 'recommend', 30);
  const meta = TITLES[tab];
  // 收藏面只看订阅来的歌单；「我喜欢的音乐」这种 specialType=5 的系统歌单在「我的面」里。
  const starred = (playlists.data?.playlists ?? []).filter((item) => item.subscribed === true);
  const recommended = personalized.data?.playlists ?? [];
  const isRecommend = tab === 'recommend';
  const source = isRecommend ? personalized : playlists;
  const items = isRecommend ? recommended : starred;

  /* 推荐面网格最前面那张「每日推荐」卡：数据走 `library:recommend`（`/recommend/songs`）。
     点它不新开页面 —— `openSongs({ kind: 'daily', ... })` 把同一层歌曲浮层切到 `'daily'`，
     和歌手 / 专辑一样：点一首歌 = 把这一份列表当播放队列（见 `components/SongListOverlay.tsx`）。 */
  const daily = useRecommend(isRecommend);
  const dailyCount = daily.data?.tracks.length;
  /*
   * 每日推荐是伪歌单、上游没有封面（用户第二十一轮第 2 条：「每日推荐歌单没有封面，修一下」），
   * 所以照网易云的做法拿前几首歌的专辑封面拼一张 2×2（见 `lib/cover.ts` 的 `dailyCoverUrls`）。
   */
  const dailyCovers = dailyCoverUrls(daily.data?.tracks, 4);

  const dailyCard = (
    <button
      type="button"
      className="pi-plcard"
      data-daily-card="true"
      data-daily-count={dailyCount}
      data-daily-cover={dailyCovers.length}
      onClick={() => openSongs({ kind: 'daily', id: 0, title: '每日推荐' })}
      title="每日推荐"
    >
      {dailyCovers.length > 0 ? (
        <div className="pi-plcard__cover pi-plcard__cover--mosaic" data-daily-mosaic="true">
          {dailyCovers.map((url, index) => (
            <img key={`${url}-${index}`} src={url} alt="" loading="lazy" draggable={false} />
          ))}
        </div>
      ) : (
        <div className="pi-plcard__cover pi-plcard__cover--empty">
          <Icon name="music" size={26} />
        </div>
      )}
      <span className="pi-plcard__name">每日推荐</span>
      <span className="pi-plcard__meta">
        {dailyCount === undefined ? '每天零点换一批' : `每天零点换一批 · ${dailyCount} 首`}
      </span>
    </button>
  );

  return (
    <>
      <h1 className="pi-page-title">{meta.title}</h1>
      <p className="pi-page-sub">{meta.sub}</p>

      {account.isPending && !isRecommend ? (
        <div className="pi-placeholder">正在读取账号信息…</div>
      ) : loggedIn || isRecommend ? (
        <AsyncSection isPending={source.isPending} error={source.error}>
          {items.length === 0 ? (
            isRecommend ? (
              <>
                <div className="pi-placeholder">
                  上游这次没给出推荐歌单（可能没登录或接口空窗）。
                </div>
                <PlaylistGrid playlists={items} onOpen={openPlaylist} leading={dailyCard} />
              </>
            ) : (
              <div className="pi-placeholder">
                还没有收藏的歌单。在网易云里收藏一个，这里就会出现。
              </div>
            )
          ) : (
            <PlaylistGrid
              playlists={items}
              onOpen={openPlaylist}
              leading={isRecommend ? dailyCard : undefined}
            />
          )}
        </AsyncSection>
      ) : (
        <NeedsLogin what={meta.title} />
      )}

      {/* 用户 m02898 第 6 条后半段：「平凡风格下进入图5 所示的歌单选择页（推荐歌单 / 收藏
          歌单这一页），底部进度条部件也要存在，点击可以回到歌曲播放页」。
          挂的就是拼贴页 / 我的喜欢那**同一个** `BottomBar`（组件自己 `position: fixed`、
          没在播歌时返回 null），所以行为逐像素一致：拖进度条 / 音量不抢点击，原地轻点一下
          才 `closePlaylist() + closeSongs() + navigate('home')` 回播放页。 */}
      <BottomBar />
    </>
  );
}
