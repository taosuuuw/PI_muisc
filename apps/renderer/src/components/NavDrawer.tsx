import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CH, invoke } from '../bridge';
import { useUi } from '../state/ui';
import { AccountCard } from './AccountCard';
import { Icon, type IconName } from './Icons';

/**
 * 左侧抽屉 + 搜索。
 *
 * 用户需求（m04781 第 2 条）：原来常驻的那一栏折叠进一个可拖动的悬浮球里，
 * 点开后展开，**搜索放在顶部**。所以抽屉的第一屏就应该是「找歌」，
 * 而不是先看导航——导航是低频动作，搜索是高频动作。
 */
export type NavId =
  | 'home'
  | 'mine:recent'
  | 'mine:like'
  | 'mine:download'
  | 'mine:playlists'
  | 'playlist:star'
  /* 第十六轮第 6 条（用户 m07538）：悬浮球删掉后，「推荐歌单」需要落点 ⇒ 恢复一页。 */
  | 'playlist:recommend'
  | 'search';

/**
 * 抽屉里的一项的 id：`NavId` 之外多一个 `'settings'`。
 *
 * 第八轮第 7 条把「占满整个 app 界面的设置页」删掉了（`NavId` 里的 `settings` 随之去掉，
 * `App.tsx` 的 PAGES 里也没有这一条了），设置改成一个浮在播放页上的框。
 * 所以这一项不是「跳到设置页」，而是一个动作：点它 → `openSettings()`。
 */
type NavEntryId = NavId | 'settings';

interface NavItem {
  id: NavEntryId;
  label: string;
  icon: IconName;
}

interface NavGroup {
  title: string;
  items: readonly NavItem[];
}

/** 播放器主页排第一：「打开应用就在听歌」是这一版的主场景。 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: '正在播放',
    items: [{ id: 'home', label: '播放器主页', icon: 'music' }],
  },
  {
    title: '我的音乐',
    items: [
      { id: 'mine:recent', label: '最近听过', icon: 'clock' },
      { id: 'mine:like', label: '我的喜欢', icon: 'heart' },
      { id: 'mine:download', label: '我的下载', icon: 'download' },
      { id: 'mine:playlists', label: '我的歌单', icon: 'list' },
    ],
  },
  {
    title: '歌单',
    // m08768 第 3 条：推荐页去掉，只留收藏；推荐歌单走环形菜单的「推荐」封面环。
    // 第十六轮第 6 条：环形菜单（悬浮球）删掉了，推荐歌单必须有正经入口 ⇒ 补回这一项
    // （`PlaylistPage` 重新支持 `tab='recommend'`，走 `/personalized`，不吃登录）。
    items: [
      { id: 'playlist:star', label: '收藏', icon: 'star' },
      { id: 'playlist:recommend', label: '推荐歌单', icon: 'compass' },
    ],
  },
  {
    title: '发现',
    items: [{ id: 'search', label: '搜索', icon: 'search' }],
  },
  {
    title: '应用',
    // m08768 第 1 条：音质日志不再是一项独立入口，它已经变成设置里的「日志」tab；
    // 第八轮第 7 条：设置不再是整页，点这一项改成「让设置框浮出来」（见 PiOrb 的 run()）。
    items: [{ id: 'settings', label: '设置与音源', icon: 'settings' }],
  },
];

const STATUS_LABEL: Record<string, string> = {
  idle: '未启动',
  starting: '启动中',
  ready: '就绪',
  error: '不可用',
  stopped: '已停止',
};

export function NavDrawer(): ReactNode {
  const open = useUi((s) => s.navOpen);
  const closeNav = useUi((s) => s.closeNav);
  const navigate = useUi((s) => s.navigate);
  const openSettings = useUi((s) => s.openSettings);
  const current = useUi((s) => s.nav);
  const keywords = useUi((s) => s.searchKeywords);
  const setKeywords = useUi((s) => s.setSearchKeywords);
  const [input, setInput] = useState(keywords);

  // 每次展开都把搜索框同步成「上次搜的词」，收起/展开不丢上下文。
  useEffect(() => {
    if (open) setInput(keywords);
  }, [open, keywords]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeNav();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeNav]);

  const health = useQuery({
    queryKey: ['ncmHealth'],
    queryFn: () => invoke(CH.ncmHealth),
    refetchInterval: 4000,
  });

  const status = health.data?.status ?? 'idle';
  const statusColor =
    status === 'ready' ? 'var(--pi-primary)' : status === 'error' ? '#E5484D' : 'var(--pi-text-tertiary)';

  if (!open) return null;

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    const value = input.trim();
    if (value.length === 0) return;
    setKeywords(value);
    navigate('search');
  }

  return (
    <>
      <div className="pi-navdrawer__scrim" onClick={closeNav} />
      <aside className="pi-navdrawer" aria-label="导航与搜索">
        <form className="pi-searchbar pi-searchbar--drawer" onSubmit={onSubmit}>
          <Icon name="search" size={16} />
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="搜索歌曲、歌手、专辑…"
            spellCheck={false}
            autoFocus
          />
          <button type="submit" className="pi-btn" style={{ height: 28, padding: '0 12px' }}>
            搜索
          </button>
        </form>

        <div className="pi-navdrawer__scroll">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="pi-navdrawer__group">{group.title}</div>
              {group.items.map((item) => {
                const { id } = item;
                return (
                  <button
                    key={id}
                    type="button"
                    className="pi-navitem"
                    aria-current={current === id ? 'page' : undefined}
                    onClick={() => {
                      // 设置不是页面（第八轮第 7 条）：收起抽屉，让框式设置浮层出来。
                      if (id === 'settings') {
                        closeNav();
                        openSettings();
                        return;
                      }
                      navigate(id);
                    }}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="pi-navdrawer__footer">
          <AccountCard />
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: statusColor,
                display: 'inline-block',
              }}
            />
            内嵌 API：{STATUS_LABEL[status] ?? status}
          </span>
          {health.data?.error ? (
            <span style={{ color: '#E5484D' }} title={health.data.error}>
              {health.data.error}
            </span>
          ) : null}
        </div>
      </aside>
    </>
  );
}

/*
 * 抽屉底部的账号区已经搬到 `components/AccountCard.tsx`（用户 m08768 第 8 条：
 * 设置页也要有「账号」分类）。放在导航抽屉里而不是只放设置页，理由不变：
 * 「我没登录」是用户最需要立刻处理的状态，不该藏在设置里找。
 */
