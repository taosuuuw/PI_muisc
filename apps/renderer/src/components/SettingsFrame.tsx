import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icons';

/**
 * 设置页的外壳（用户 m08768 第 8 条）。
 *
 * 参考图 `docs/ref-m08768-settings-frame.png` 的结构是**一块带外框的整页**：
 * 中间一排分类 tab，tab 下面是内容区，底部内容自滚。
 * 所以这一层只做**展示**：它不认识设置、不碰 IPC、不自己存 tab 状态——
 * 内容由 `SettingsPage` 通过 `children` 灌进来，选中哪个 tab 也由外面决定。
 *
 * 第十轮第 1 条（用户 m02362）：**顶部那张「当前播放大封面 + 黑胶」整块去掉了**
 * （原来 `SettingsHeader` 会订阅播放状态、把封面与唱片画在设置页顶上）。设置页是
 * 调参数的地方，不该再摆一遍正在播的歌；去掉后这一层也不再依赖 `usePlayer`，
 * 彻底变成纯展示组件。CSS 里 `.pi-settings-frame__head/__art/__cover/__meta/__song/__artist`
 * 与 `.pi-vinyl*` 一并删掉，别留死规则。
 *
 * 第十二轮（用户 m02362 的参考图 `docs/ref-settings-polaroid.png`）：换成「拍立得」皮肤——
 * 分类 tab 从「图标 + 文字」的长条收成一排圆形图标键（文字进 title / aria-label，
 * `.pi-settings-frame__tablabel` 仍在 DOM 里当无障碍名），卡片与行都是厚白边 + 大圆角 +
 * 柔和落影，行内说明收短。**这一层依旧只做展示**：它不认识设置、不碰 IPC、不存 tab 状态。
 */

export type SettingsTabId = 'audio' | 'playback' | 'ui' | 'lyric' | 'account' | 'log';

export interface SettingsTabDef {
  id: SettingsTabId;
  label: string;
  icon: IconName;
}

/**
 * 六个分类的顺序就是需求给的顺序：音源 / 播放 / 界面 / 歌词 / 账号 / 日志。
 * 图标只借用现有 Icons 里语义最近的几个，不新增图标（Icons.tsx 不在本次改动范围内）。
 */
export const SETTINGS_TABS: readonly SettingsTabDef[] = [
  { id: 'audio', label: '音源', icon: 'music' },
  { id: 'playback', label: '播放', icon: 'play' },
  { id: 'ui', label: '界面', icon: 'settings' },
  { id: 'lyric', label: '歌词', icon: 'waveform' },
  { id: 'account', label: '账号', icon: 'user' },
  { id: 'log', label: '日志', icon: 'list' },
];

export interface SettingsFrameProps {
  active: SettingsTabId;
  onTabChange: (id: SettingsTabId) => void;
  children: ReactNode;
}

export function SettingsFrame({ active, onTabChange, children }: SettingsFrameProps): ReactNode {
  return (
    <div className="pi-settings-frame">
      <div className="pi-settings-frame__tabs" role="tablist" aria-label="设置分类">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="pi-settings-frame__tab"
            data-settings-tab={tab.id}
            data-active={tab.id === active ? 'true' : 'false'}
            aria-selected={tab.id === active}
            /* 拍立得皮肤（第十二轮）：tab 收成一枚圆形图标键，文案退到提示与无障碍名里；
               可见文字变少，但 `data-settings-tab` 与 DOM 里的 `.pi-settings-frame__tablabel`
               一个字没动——冒烟按前者枚举 6 个 tab，读屏按后者报名字。 */
            aria-label={tab.label}
            title={tab.label}
            onClick={() => onTabChange(tab.id)}
          >
            <Icon name={tab.icon} size={17} />
            <span className="pi-settings-frame__tablabel">{tab.label}</span>
          </button>
        ))}
      </div>

      {/*
        `key={active}` 是为了让换 tab 时内容区**回到顶部**：内容区自己滚动（外框不动），
        不换 key 的话从「音源」长列表切到「歌词」会停在半空中，看起来像少了半页。
      */}
      <div className="pi-settings-frame__body" role="tabpanel" data-panel={active} key={active}>
        {children}
      </div>
    </div>
  );
}
