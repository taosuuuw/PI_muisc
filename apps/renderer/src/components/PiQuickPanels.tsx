import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { QUALITY_LABEL, QUALITY_REQUIRES_VIP } from '@pi/shared';
import type { LyricTheme, Quality, ThemeMode } from '@pi/shared';
import { AccentPicker } from './AccentPicker';
import { Icon } from './Icons';
import type { IconName } from './Icons';
import type { AccentMode } from '../lib/accent';
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
 * - 迷你设置**顶层图标分页栏**（用户第二十轮第 3 条）：每颗
 *   `data-quick-tab="lyric|quality|theme|account"` + `data-active="true|false"`。
 * - 分页内容：每个 `<section>` 带 `data-quick-tabpanel="<同一个 id>"`（加 `data-active`），
 *   没选中的那颗有 `hidden` 属性——**节点不卸载**，所以下面那些抓手在任何分页下都找得到。
 * - 每一类设置的标题行（浅色小字 + 右侧当前值）：`data-quick-switch="lyric|quality|theme"`；
 *   账号那一类的行本身仍是 `data-quick-switch="account"`。
 * - 选项按键：`data-quick-choice="<值>"` + `data-active="true|false"`；
 *   装它们的方块网格 `data-quick-choices="lyric|quality|theme"`；
 *   音质那组的容器额外带 `data-quick-quality-group="true"`。
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
 *
 * `icon` 是**用户第二十轮第 3 条**要的「选项按键文字带图标」（参考图里每个按键都带一枚图标）：
 * 六套主题各挑一枚形状好认的既有图标，不改六套主题自己的实现。
 */
const QUICK_LYRIC_THEMES: readonly { key: LyricTheme; short: string; icon: IconName }[] = [
  { key: 'classic', short: '流光', icon: 'waveform' },
  { key: 'fume', short: '浮名', icon: 'comment' },
  { key: 'cadenza', short: '心象', icon: 'star' },
  { key: 'partita', short: '云阶', icon: 'bars' },
  { key: 'tilt', short: '倾诉', icon: 'artist' },
  { key: 'pendolo', short: '时计', icon: 'clock' },
];

/**
 * 官方音质档位。顺序同 `pages/SettingsPage.tsx:114` 的 `OFFICIAL_CHOICES`
 * （同样没导出，同样只能镜像）；**中文名**直接用 `@pi/shared` 导出的 `QUALITY_LABEL`，
 * 不另抄一份文案。
 *
 * 图标从低到高给一枚「越来越贵」的形状：音符 → 波形 → 信号格 → 唱片 → 星 → 王冠
 * （`signal` / `crown` 是这一轮新加的两枚，见 `components/Icons.tsx`）。
 */
const QUICK_QUALITIES: readonly { key: Quality; icon: IconName }[] = [
  { key: 'standard', icon: 'music' },
  { key: 'higher', icon: 'waveform' },
  { key: 'exhigh', icon: 'signal' },
  { key: 'lossless', icon: 'album' },
  { key: 'hires', icon: 'star' },
  { key: 'jymaster', icon: 'crown' },
];

/** 界面主题明暗（`Settings.theme`）。设置里没有独立的「主题颜色」字段，见交付报告。 */
const QUICK_THEMES: readonly { key: ThemeMode; short: string; icon: IconName }[] = [
  { key: 'light', short: '浅色', icon: 'sun' },
  { key: 'dark', short: '深色', icon: 'moon' },
  // 明暗那三档里「跟随系统」用刷新圈（`contrast` 让给下面的「黑白」主色档，同一页里不重复）。
  { key: 'system', short: '跟随系统', icon: 'refresh' },
];

/**
 * 应用主色的三档（用户第二十二轮第 2 条：「要在快捷设置页加上自定义主题色的功能栏」）。
 * 值与设置页那三档**同一份**（`state/ui.ts` 的 `accentMode`），点哪档两边一起变。
 */
const QUICK_ACCENTS: readonly { key: AccentMode; short: string; icon: IconName }[] = [
  { key: 'sky', short: '天蓝', icon: 'droplet' },
  { key: 'mono', short: '黑白', icon: 'contrast' },
  { key: 'custom', short: '自定义', icon: 'grid' },
];

/**
 * 顶部**图标分页栏**的四档（用户第二十轮第 3 条：「顶部加图标分页栏把不同类的设置分开」）。
 *
 * 参考图里那条栏只有图标、没有文字：所以这里也是图标 + `title`/`aria-label`（鼠标停上去有名字，
 * 读屏也读得到），标签字则留给每个分页内部那一行**浅色小标题**（同一条要求里的
 * 「『歌词动效』『默认音质』等这样的黑体标题缩小改成浅色」）——两者不重复堆在同一处。
 *
 * 四档与 `data-quick-switch` 的四个 id 一一对应，冒烟抓手不变。
 */
export type QuickTab = 'lyric' | 'quality' | 'theme' | 'account';

const QUICK_TABS: readonly { key: QuickTab; label: string; icon: IconName }[] = [
  { key: 'lyric', label: '歌词动效', icon: 'waveform' },
  { key: 'quality', label: '默认音质', icon: 'music' },
  { key: 'theme', label: '主题颜色', icon: 'contrast' },
  { key: 'account', label: '账号', icon: 'user' },
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
 * - 主题颜色 → 只有 `Settings.theme` 的明暗三档（`packages/ipc/src/index.ts:411`）；
 *   **界面主色**（用户第二十一轮第 5 条）是本机的 `pi.accent`（`state/ui.ts`），
 *   它在设置页「界面」tab 里选，这张卡只写一句提示指过去——卡片里那三档是明暗，不是主色。
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

  /**
   * 当前分页（用户第二十轮第 3 条的图标分页栏）。
   *
   * 默认停在「歌词动效」：六套歌词动效是这张卡里改得最勤的一项，也是最常被打开的那一格。
   * 四个分页的 DOM **一直挂着**（没选中的那颗只加 `hidden`），所以 `data-quick-choice` /
   * `data-quick-quality-group` / `data-quick-more="account"` 这些冒烟抓手在任何分页下都找得到。
   */
  const [tab, setTab] = useState<QuickTab>('lyric');
  // 应用主色（用户第二十二轮第 2 条）：与设置页同一份 store，改哪边都一起变。
  const accentMode = useUi((state) => state.accentMode);
  const accentColor = useUi((state) => state.accentColor);
  const setAccentMode = useUi((state) => state.setAccentMode);
  const setAccentColor = useUi((state) => state.setAccentColor);

  return (
    <QuickCardShell kind="settings" title="快速设置" onDismiss={onDismiss} loading={!value}>
      {value ? (
        <div className="pi-quick-body">
          {/*
            顶部图标分页栏（用户第二十轮第 3 条）。
            抓手：每颗 `data-quick-tab="lyric|quality|theme|account"` + `data-active`；
            下面每个分页 `data-quick-tabpanel="<同一个 id>"` + `data-active`，没选中的带 `hidden`
            （`hidden` 只是 `display:none`，节点还在 DOM 里，所以 `[data-quick-switch]` /
            `[data-quick-choice]` 这些老抓手一个都不少，冒烟照旧找得到）。
            样式表里必须写 `.pi-quick-panel[hidden] { display: none }`：本文件给
            `.pi-quick-panel` 定了 `display: grid`，作者样式会盖掉浏览器默认的 `[hidden]`。
          */}
          <div className="pi-quick-tabs" role="tablist" aria-label="快速设置分类">
            {QUICK_TABS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                className="pi-quick-tab"
                data-quick-tab={entry.key}
                data-active={tab === entry.key}
                aria-selected={tab === entry.key}
                aria-label={entry.label}
                title={entry.label}
                onClick={() => setTab(entry.key)}
              >
                <Icon name={entry.icon} size={18} />
              </button>
            ))}
          </div>

          <section
            className="pi-quick-panel"
            data-quick-tabpanel="lyric"
            data-active={tab === 'lyric'}
            hidden={tab !== 'lyric'}
          >
            <div className="pi-quick-head" data-quick-switch="lyric">
              <span className="pi-quick-head__label">歌词动效</span>
              <span className="pi-quick-head__value">
                {QUICK_LYRIC_THEMES.find((theme) => theme.key === value.lyricTheme)?.short ?? '—'}
              </span>
            </div>
            <div className="pi-quick-choices" data-quick-choices="lyric">
              {QUICK_LYRIC_THEMES.map((theme) => (
                <button
                  key={theme.key}
                  type="button"
                  className="pi-quick-choice"
                  data-quick-choice={theme.key}
                  data-active={value.lyricTheme === theme.key}
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ lyricTheme: theme.key })}
                >
                  <span className="pi-quick-choice__icon" aria-hidden="true">
                    <Icon name={theme.icon} size={18} />
                  </span>
                  <span className="pi-quick-choice__text">{theme.short}</span>
                </button>
              ))}
            </div>
          </section>

          <section
            className="pi-quick-panel"
            data-quick-tabpanel="quality"
            data-active={tab === 'quality'}
            hidden={tab !== 'quality'}
          >
            <div className="pi-quick-head" data-quick-switch="quality">
              <span className="pi-quick-head__label">默认音质</span>
              <span className="pi-quick-head__value">{QUALITY_LABEL[value.preferredQuality]}</span>
            </div>
            {/*
              用户 m02898 第 2 条：「默认音质」从原生 `<select>` 改成**按键组**。
              用户第二十轮第 3 条：六颗按键从「一条分段轨道上的纯文字」改成「图标 + 文字的方块」
              （`.pi-quick-choice`，见 `styles/quick-panels.css`），与歌单卡那六块按键同一套语言。
              档位仍然只有 `OFFICIAL_CHOICES` 那六个（`pages/SettingsPage.tsx:116`，同一套
              `@pi/shared` 的 `Quality`），不发明新字符串；VIP 门槛用既有的
              `QUALITY_REQUIRES_VIP` 只做 `title` 提示，**不禁用**按钮——设置页那边也是随便选、
              由主进程按账号能力往下试（`SettingsPage.tsx:165` 的 title 原话）。
              `data-quick-choice` 挂到**每一颗**按钮上，外层容器仍给 `data-quick-quality-group="true"`
              （冒烟「点了要真换成那一档」那条探针认它）。
            */}
            <div
              className="pi-quick-choices"
              data-quick-choices="quality"
              data-quick-quality-group="true"
            >
              {QUICK_QUALITIES.map((quality) => (
                <button
                  key={quality.key}
                  type="button"
                  className="pi-quick-choice"
                  data-quick-choice={quality.key}
                  data-active={value.preferredQuality === quality.key}
                  title={
                    vip || !QUALITY_REQUIRES_VIP[quality.key]
                      ? QUALITY_LABEL[quality.key]
                      : `${QUALITY_LABEL[quality.key]}（需要 VIP）`
                  }
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ preferredQuality: quality.key })}
                >
                  <span className="pi-quick-choice__icon" aria-hidden="true">
                    <Icon name={quality.icon} size={18} />
                  </span>
                  <span className="pi-quick-choice__text">{QUALITY_LABEL[quality.key]}</span>
                </button>
              ))}
            </div>
          </section>

          <section
            className="pi-quick-panel"
            data-quick-tabpanel="theme"
            data-active={tab === 'theme'}
            hidden={tab !== 'theme'}
          >
            <div className="pi-quick-head" data-quick-switch="theme">
              <span className="pi-quick-head__label">主题颜色</span>
            </div>
            <div className="pi-quick-choices" data-quick-choices="theme">
              {QUICK_THEMES.map((theme) => (
                <button
                  key={theme.key}
                  type="button"
                  className="pi-quick-choice"
                  data-quick-choice={theme.key}
                  data-active={value.theme === theme.key}
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ theme: theme.key })}
                >
                  <span className="pi-quick-choice__icon" aria-hidden="true">
                    <Icon name={theme.icon} size={18} />
                  </span>
                  <span className="pi-quick-choice__text">{theme.short}</span>
                </button>
              ))}
            </div>
            {/*
              用户第二十二轮第 2 条：「要在快捷设置页加上自定义主题色的功能栏」。
              与设置页「界面」tab 改的是**同一份** `state/ui.ts` 的 `accentMode` / `accentColor`，
              所以两边互为镜像；自定义档直接把那块取色面板（紧凑档）搬进来。
            */}
            <div className="pi-quick-head" data-quick-switch="accent">
              <span className="pi-quick-head__label">应用主色</span>
              <span className="pi-quick-head__value">
                {QUICK_ACCENTS.find((entry) => entry.key === accentMode)?.short ?? '天蓝'}
              </span>
            </div>
            <div className="pi-quick-choices" data-quick-choices="accent">
              {QUICK_ACCENTS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className="pi-quick-choice"
                  data-quick-choice={entry.key}
                  data-active={accentMode === entry.key}
                  onClick={() => setAccentMode(entry.key)}
                >
                  <span className="pi-quick-choice__icon" aria-hidden="true">
                    <Icon name={entry.icon} size={18} />
                  </span>
                  <span className="pi-quick-choice__text">{entry.short}</span>
                </button>
              ))}
            </div>
            {accentMode === 'custom' ? (
              <AccentPicker compact value={accentColor} onChange={setAccentColor} />
            ) : null}
            {/* 诚实提示：歌词配色跟着封面走，界面主色就是上面这一栏。 */}
            <p className="pi-quick-note">
              歌词配色跟着封面走；上面这栏改的是按钮、进度条那套界面主色
            </p>
          </section>

          {/*
            账号行（用户 m02213 第 7 条重做；用户第二十轮第 3 条搬进「账号」分页）。
            原来是一坨：竖排「账号」标题 + 挤在标题下的 VIP 徽章 + 右侧一行灰字用户名 +
            单独一行的蓝色「切换账号」文字。现在改成左中右三段：
              ① 40px 圆形头像（拿不到头像地址时退回 `user` 图标占位；未登录同款占位）；
              ② 中间两块字：第一行昵称（VIP 徽章跟昵称同行，不再压标题）、第二行身份小字
                 （已登录给 `ID: <userId>`，未登录给「登录后同步歌单与收藏」）；
              ③ 右侧一颗独立按钮：已登录「切换账号」、未登录「去登录」。
            三个冒烟抓手（`data-quick-switch="account"` / `data-quick-account-state` /
            `data-quick-more="account"`）都留在原来的节点层级上。
          */}
          <section
            className="pi-quick-panel"
            data-quick-tabpanel="account"
            data-active={tab === 'account'}
            hidden={tab !== 'account'}
          >
            <div className="pi-quick-head">
              <span className="pi-quick-head__label">账号</span>
              <span className="pi-quick-head__value">
                {loggedIn ? (capability?.nickname ?? '已登录') : '未登录'}
              </span>
            </div>
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
                    {loggedIn
                      ? (capability?.nickname ?? `用户 ${capability?.userId ?? ''}`)
                      : '未登录'}
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
          </section>
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
