import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { QUALITY_LABEL, QUALITY_REQUIRES_VIP } from '@pi/shared';
import type { LyricTheme, Quality, ThemeMode } from '@pi/shared';
import { Icon } from './Icons';
import { coverAt } from '../lib/cover';
import { useAccount, usePatchSettings, useSettings } from '../lib/queries';
import { useUi } from '../state/ui';
import '../styles/quick-panels.css';
// 账号行的皮肤单独一张表（用户 m02213 第 7 条重做）：放在 quick-panels.css **之后**导入，
// 好让同优先级的 `.pi-quick-account-row` 覆盖掉基类 `.pi-quick-switch` 的两列网格。
import '../styles/quick-account.css';

/**
 * 快捷拍立得卡片（第十六轮第 6 条）。
 *
 * 用户要的是「划开一张拍立得」：向上划是六块歌单按键，向右划是一张迷你设置页。
 * 两张卡共用同一套拍立得皮肤——白/浅色的厚边框（下沿比上沿厚，所以像一张照片）、
 * 轻微旋转、落影、底部一条说明条。皮肤视觉语言来自
 * `styles/settings-frame.css` 的 `.pi-settings-frame .pi-card`
 * （`padding: 14px 16px 24px` / `border: 1px solid var(--pi-divider)` /
 * `border-radius: 18px` / `background: var(--pi-surface)` /
 * `box-shadow: var(--pi-glass-edge), var(--pi-shadow-float)`），
 * 但那张表挂在 `.pi-settings-frame` 作用域下，而这里是浮在播放页上的独立浮层，
 * 所以同款数值在本文件配套的 `styles/quick-panels.css` 里重写了一遍。
 *
 * ## data-* 契约（冒烟/选择器靠它找节点，不要改名）
 * 两张卡都套在同一层里：
 * - 外层 `.pi-quick-layer`：`data-quick-layer="playlists|settings"`。
 * - 点击关闭的背板 `.pi-quick-layer__backdrop`：`data-quick-backdrop="true"`。
 * - 卡片本身：`data-quick-panel="playlists"` 或 `"settings"`；
 *   设置卡在设置还没读到时额外带 `data-quick-panel-state="loading"`。
 * - 六宫格每个按键：`data-quick-item="<id>"` + `data-quick-item-state="ready|empty|unavailable"`。
 * - 迷你设置每一行：`data-quick-switch="lyric|quality|theme|account"`；
 *   按钮式选项 `data-quick-choice="<值>"` + `data-active="true|false"`；
 *   音质那行**不再是**原生 `<select>`（用户 m02898 第 2 条改成按键组）：六个官方档位全部
 *   渲染成 `data-quick-choice` 按钮，装它们的容器带 `data-quick-quality-group="true"`，
 *   选中的那个 `data-active="true"`。
 * - 账号行（用户 m02213 第 7 条重做）：行本身 `data-quick-switch="account"` 不变；
 *   昵称块 `data-quick-account-state="loggedIn|loggedOut"` 不变（状态只挂在**一个**节点上）；
 *   右侧独立按钮 `data-quick-more="account"` 不变。三个抓手原样保留，改名会让冒烟假红。
 * - 打开详细设置的两个入口：`data-quick-more="settings"`（卡片底部）与
 *   `data-quick-more="account"`（账号行）。
 * - 关闭按键：`data-quick-dismiss="true"`。
 */

/* ------------------------------------------------------------------ *
 * 六块歌单按键卡
 * ------------------------------------------------------------------ */

export interface QuickPlaylistItem {
  /** 稳定 id，同时是 `data-quick-item` 的值（如 `star` / `mine` / `recent`）。 */
  id: string;
  label: string;
  /** 图标用 ReactNode 而不是 `IconName`：`components/Icons.tsx` 的 `Icon` 只吃 name， */
  /** 但调用方可能想塞自己的 SVG，所以这里放宽。 */
  icon: ReactNode;
  /** `ready` 正常；`empty` 点得进去但里面是空的；`unavailable` 这条链今天还没有数据。 */
  state?: 'ready' | 'empty' | 'unavailable';
  /** 补一行小字说明（例如「本地曲库未设置」）。 */
  note?: string;
  onSelect: () => void;
}

export interface PiQuickPlaylistCardProps {
  items: readonly QuickPlaylistItem[];
  onDismiss?: () => void;
  /** 卡片抬头，默认「去哪儿听」。 */
  title?: string;
}

/** Esc 收回：两张卡都要的行为，抽出来省一份键盘监听。 */
function useEscapeToDismiss(onDismiss?: () => void): void {
  useEffect(() => {
    if (!onDismiss) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);
}

/**
 * 背板 + 卡片外壳：两张卡共用的拍立得外框与说明条。
 *
 * 说明条（`caption`）是**可选**的（用户 m02898 第 2 条）：设置卡底部那行灰字
 * 「右划改动即时生效 ·『详细设置』进完整设置页」要整条删掉，而歌单卡底下的
 * 「上划选歌单 · 下划搜索 · 右划设置」照旧留着。所以这里不传 `caption` 就不渲染
 * `<footer>`，而不是给设置卡传空串——空串会留下一条只有虚线分隔线的空条。
 */
function QuickCardShell({
  kind,
  title,
  caption,
  onDismiss,
  loading,
  children,
}: {
  kind: 'playlists' | 'settings';
  title: string;
  caption?: string;
  onDismiss?: () => void;
  loading?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="pi-quick-layer" data-quick-layer={kind}>
      <div
        className="pi-quick-layer__backdrop"
        data-quick-backdrop="true"
        onClick={onDismiss}
        role="presentation"
      />
      <section
        className={`pi-quick-card pi-quick-card--${kind}`}
        data-quick-panel={kind}
        data-quick-panel-state={loading ? 'loading' : 'ready'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="pi-quick-card__head">
          <span className="pi-quick-card__kicker">PI · 快捷</span>
          <h2 className="pi-quick-card__title">{title}</h2>
          {onDismiss ? (
            <button
              type="button"
              className="pi-quick-card__close"
              data-quick-dismiss="true"
              aria-label="收起"
              onClick={onDismiss}
            >
              <Icon name="close" size={15} />
            </button>
          ) : null}
        </header>
        <div className="pi-quick-card__body">{children}</div>
        {/* 拍立得那张照片底下的白边：写一句「这张卡怎么用」。设置卡没有这句话（用户 m02898 第 2 条）。 */}
        {caption ? <footer className="pi-quick-card__caption">{caption}</footer> : null}
      </section>
    </div>
  );
}

/**
 * 上划出来的六块按键卡。
 *
 * 六个入口的**数据从哪来**由使用方决定（这份组件只画按钮），现状见交付报告：
 * 收藏/我的/推荐/最近听过有真实通道，本地歌曲与播放队列各有各的说法。
 */
export function PiQuickPlaylistCard({
  items,
  onDismiss,
  title = '去哪儿听',
}: PiQuickPlaylistCardProps): ReactNode {
  useEscapeToDismiss(onDismiss);

  return (
    <QuickCardShell
      kind="playlists"
      title={title}
      caption="上划选歌单 · 下划搜索 · 右划设置"
      onDismiss={onDismiss}
    >
      <div className="pi-quick-grid">
        {items.map((item) => {
          const state = item.state ?? 'ready';
          return (
            <button
              key={item.id}
              type="button"
              className="pi-quick-item"
              data-quick-item={item.id}
              data-quick-item-state={state}
              aria-disabled={state === 'unavailable'}
              title={item.note ?? item.label}
              onClick={item.onSelect}
            >
              <span className="pi-quick-item__icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="pi-quick-item__label">{item.label}</span>
              {item.note ? <span className="pi-quick-item__note">{item.note}</span> : null}
            </button>
          );
        })}
      </div>
    </QuickCardShell>
  );
}

/* ------------------------------------------------------------------ *
 * 迷你设置卡
 * ------------------------------------------------------------------ */

/**
 * 六套歌词动效的短标签。
 *
 * 键与 `pages/SettingsPage.tsx:585` 的 `LYRIC_THEME_OPTIONS` 一一对应（classic 流光 /
 * fume 浮名 / cadenza 心象 / partita 云阶 / tilt 倾诉 / pendolo 时计）。
 * 那份表是 `SettingsPage.tsx` 的模块内常量、没有导出，而任务约束禁止改那个文件，
 * 所以短标签在这里镜像了一份；**键本身**仍来自 `@pi/shared` 的 `LyricTheme`，
 * 加第七套主题时这里会类型报错，不会悄悄漏掉。
 */
const QUICK_LYRIC_THEMES: readonly { key: LyricTheme; short: string }[] = [
  { key: 'classic', short: '流光' },
  { key: 'fume', short: '浮名' },
  { key: 'cadenza', short: '心象' },
  { key: 'partita', short: '云阶' },
  { key: 'tilt', short: '倾诉' },
  { key: 'pendolo', short: '时计' },
];

/**
 * 官方音质档位。顺序同 `pages/SettingsPage.tsx:114` 的 `OFFICIAL_CHOICES`
 * （同样没导出，同样只能镜像）；**中文名**直接用 `@pi/shared` 导出的 `QUALITY_LABEL`，
 * 不另抄一份文案。
 */
const QUICK_QUALITIES: readonly Quality[] = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jymaster',
];

/** 界面主题明暗（`Settings.theme`）。设置里没有独立的「主题颜色」字段，见交付报告。 */
const QUICK_THEMES: readonly { key: ThemeMode; short: string }[] = [
  { key: 'light', short: '浅色' },
  { key: 'dark', short: '深色' },
  { key: 'system', short: '跟随系统' },
];

export interface PiQuickSettingsCardProps {
  /** 打开完整设置页（`useUi().openSettings()`）。 */
  onOpenSettings: () => void;
  onDismiss?: () => void;
}

/**
 * 右划出来的迷你设置卡。
 *
 * 四项快捷开关**不自己发明状态**，全部走既有 store：
 * - 歌词动效 → `Settings.lyricTheme`（`packages/shared/src/index.ts:459-500`，schema 见
 *   `packages/ipc/src/index.ts:428`）；
 * - 默认音质 → `Settings.preferredQuality`，文案来自 `QUALITY_LABEL`
 *   （`packages/shared/src/index.ts:39`）；
 * - 主题颜色 → 只有 `Settings.theme` 的明暗三档（`packages/ipc/src/index.ts:411`），
 *   没有「主色 / accent」字段（主题色由封面提色决定，见 `lib/song-palette.ts`）；
 * - 账号 → `useAccount()`（`lib/queries.ts:15`）。
 * 读写统一走 `useSettings()` / `usePatchSettings()`（`lib/queries.ts:169` / `:183`），
 * 和设置页改的是同一份缓存，两边不会打架。
 */
export function PiQuickSettingsCard({
  onOpenSettings,
  onDismiss,
}: PiQuickSettingsCardProps): ReactNode {
  useEscapeToDismiss(onDismiss);

  const settings = useSettings();
  const patch = usePatchSettings();
  const account = useAccount();
  // 「去登录」直接用全应用那个登录浮层（`components/LoginDialog.tsx`，同一份 `useUi`），
  // 不在卡片里另开一套登录入口——`AccountCard` 也是这么做的。
  const openLogin = useUi((state) => state.openLogin);

  const value = settings.data;
  const capability = account.data;
  const loggedIn = capability?.loggedIn === true;
  /**
   * 账号 VIP 能力（用户 m02898 第 2 条）：音质那组按键用它决定 `title` 里要不要写「需要 VIP」。
   * 判据与下面账号行那颗 VIP 徽章逐字相同（`vipType > 0`），**不是**第二个事实来源。
   */
  const vip = loggedIn && (capability?.vipType ?? 0) > 0;
  // 头像走 `lib/cover.ts` 的 `coverAt`：它顺手把明文 `http://` 升成 https（页面 CSP 只放行
  // `https://*.music.126.net`，不升级的话图片会被静默拦掉）并补上 `?param=100y100` 裁剪。
  const avatar = loggedIn ? coverAt(capability?.avatarUrl, 100) : undefined;

  /**
   * 账号行右侧那颗按钮的落点。
   *
   * 登录态：维持原样，去完整设置页（那里能换号 / 退出）。
   * 未登录态：先收起这张卡**再**开登录浮层——登录遮罩是 z-index 40（`global.css:796`），
   * 比快捷卡的 46 低，不先收卡的话二维码会被卡片盖住。
   */
  const onAccountAction = (): void => {
    if (loggedIn) {
      onOpenSettings();
      return;
    }
    onDismiss?.();
    openLogin();
  };

  return (
    <QuickCardShell
      kind="settings"
      title="快速设置"
      onDismiss={onDismiss}
      loading={!value}
    >
      {value ? (
        <div className="pi-quick-switches">
          <div className="pi-quick-switch" data-quick-switch="lyric">
            <span className="pi-quick-switch__label">歌词动效</span>
            <span className="pi-quick-switch__value">
              {QUICK_LYRIC_THEMES.find((theme) => theme.key === value.lyricTheme)?.short ?? '—'}
            </span>
            <div className="pi-quick-switch__choices">
              {QUICK_LYRIC_THEMES.map((theme) => (
                <button
                  key={theme.key}
                  type="button"
                  className="pi-quick-chip"
                  data-quick-choice={theme.key}
                  data-active={value.lyricTheme === theme.key}
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ lyricTheme: theme.key })}
                >
                  {theme.short}
                </button>
              ))}
            </div>
          </div>

          <div className="pi-quick-switch" data-quick-switch="quality">
            <span className="pi-quick-switch__label">默认音质</span>
            <span className="pi-quick-switch__value">
              {QUALITY_LABEL[value.preferredQuality]}
            </span>
            {/*
              用户 m02898 第 2 条：「默认音质」从原生 `<select>` 改成**按键组**——
              未选中=暗色（`.pi-quick-chip` 的默认皮肤：淡描边 + 透明底），
              已选=亮色（`[data-active='true']` 那条主色底/主色字）。
              档位仍然只有 `OFFICIAL_CHOICES` 那六个（`pages/SettingsPage.tsx:116`，同一套
              `@pi/shared` 的 `Quality`），不发明新字符串；VIP 门槛用既有的
              `QUALITY_REQUIRES_VIP` 只做 `title` 提示，**不禁用**按钮——设置页那边也是随便选、
              由主进程按账号能力往下试（`SettingsPage.tsx:165` 的 title 原话）。
              `data-quick-choice` 挂到**每一颗**按钮上（原来只挂在 `<select>` 自己身上），
              外层容器另给 `data-quick-quality-group="true"`。
            */}
            <div className="pi-quick-switch__choices" data-quick-quality-group="true">
              {QUICK_QUALITIES.map((quality) => (
                <button
                  key={quality}
                  type="button"
                  className="pi-quick-chip"
                  data-quick-choice={quality}
                  data-active={value.preferredQuality === quality}
                  title={
                    vip || !QUALITY_REQUIRES_VIP[quality]
                      ? QUALITY_LABEL[quality]
                      : `${QUALITY_LABEL[quality]}（需要 VIP）`
                  }
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ preferredQuality: quality })}
                >
                  {QUALITY_LABEL[quality]}
                </button>
              ))}
            </div>
          </div>

          <div className="pi-quick-switch" data-quick-switch="theme">
            <span className="pi-quick-switch__label">主题颜色</span>
            <div className="pi-quick-switch__choices">
              {QUICK_THEMES.map((theme) => (
                <button
                  key={theme.key}
                  type="button"
                  className="pi-quick-chip"
                  data-quick-choice={theme.key}
                  data-active={value.theme === theme.key}
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ theme: theme.key })}
                >
                  {theme.short}
                </button>
              ))}
            </div>
            {/* 诚实提示：设置里没有独立主题色，主色跟着当前封面走。 */}
            <span className="pi-quick-switch__hint">没有独立主色，配色跟着封面走</span>
          </div>

          {/*
            账号行（用户 m02213 第 7 条重做）。
            原来是一坨：竖排「账号」标题 + 挤在标题下的 VIP 徽章 + 右侧一行灰字用户名 +
            单独一行的蓝色「切换账号」文字。现在改成左中右三段：
              ① 40px 圆形头像（拿不到头像地址时退回 `user` 图标占位；未登录同款占位）；
              ② 中间两块字：第一行昵称（VIP 徽章跟昵称同行，不再压标题）、第二行身份小字
                 （已登录给 `ID: <userId>`，未登录给「登录后同步歌单与收藏」）；
              ③ 右侧一颗独立按钮：已登录「切换账号」、未登录「去登录」。
            三个冒烟抓手（`data-quick-switch="account"` / `data-quick-account-state` /
            `data-quick-more="account"`）都留在原来的节点层级上。
          */}
          <div className="pi-quick-switch pi-quick-account-row" data-quick-switch="account">
            {avatar ? (
              <img className="pi-quick-account__avatar" src={avatar} alt="" />
            ) : (
              <span
                className="pi-quick-account__avatar pi-quick-account__avatar--empty"
                aria-hidden="true"
              >
                <Icon name="user" size={19} />
              </span>
            )}
            <span
              className="pi-quick-account"
              data-quick-account-state={loggedIn ? 'loggedIn' : 'loggedOut'}
            >
              <span className="pi-quick-account__line">
                <span
                  className="pi-quick-account__name"
                  title={loggedIn ? (capability?.nickname ?? undefined) : undefined}
                >
                  {loggedIn ? (capability?.nickname ?? `用户 ${capability?.userId ?? ''}`) : '未登录'}
                </span>
                {loggedIn && (capability?.vipType ?? 0) > 0 ? (
                  <span className="pi-quick-account__vip">VIP</span>
                ) : null}
              </span>
              <span className="pi-quick-account__meta">
                {loggedIn
                  ? capability?.userId !== undefined
                    ? `ID: ${capability.userId}`
                    : '已登录'
                  : '登录后同步歌单与收藏'}
              </span>
            </span>
            <button
              type="button"
              className="pi-quick-account__action"
              data-quick-more="account"
              onClick={onAccountAction}
            >
              {loggedIn ? '切换账号' : '去登录'}
            </button>
          </div>
        </div>
      ) : (
        <p className="pi-quick-loading">正在读取设置…</p>
      )}

      <button
        type="button"
        className="pi-quick-more"
        data-quick-more="settings"
        onClick={onOpenSettings}
      >
        <Icon name="settings" size={16} />
        详细设置
      </button>
    </QuickCardShell>
  );
}
