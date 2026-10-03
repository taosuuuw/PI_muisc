import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MODE_LABEL, PLAYLIST_MODES } from '@pi/player-core';
import {
  DEFAULT_LYRIC_TUNING,
  QUALITY_LABEL,
  type LyricFpsCap,
  type LyricTheme,
  type LyricTuning,
  type Quality,
  type SourceStatus,
  type ThemeMode,
} from '@pi/shared';
import { Icon } from '../components/Icons';
import { AccentPicker } from '../components/AccentPicker';
import { AccountCard } from '../components/AccountCard';
import { SettingsFrame, type SettingsTabId } from '../components/SettingsFrame';
import { QualityLogPanel } from '../components/QualityLogPanel';
import { errorMessage } from '../bridge';
import { SHORTCUT_DEFINITIONS, findConflict, formatBinding, shortcutLabel } from '../lib/shortcuts';
import {
  useImportPlugin,
  usePatchSettings,
  usePlugins,
  useRemovePlugin,
  useResetSourceHealth,
  useSettings,
  useSources,
  useTogglePlugin,
} from '../lib/queries';
import { usePlayer } from '../state/player';
import { useShortcuts } from '../state/shortcuts';
import { useUi } from '../state/ui';
import type { AccentMode } from '../lib/accent';

/**
 * 设置页（用户 m08768 第 8 条重做）。
 *
 * 从「一竖列长卡片」改成参考图 `docs/ref-m08768-settings-frame.png` 那种**带外框的整页**：
 * 顶部封面 + 黑胶，中间六个分类 tab（音源 / 播放 / 界面 / 歌词 / 账号 / 日志），底部同步按钮。
 */
export function SettingsPage(): ReactNode {
  const settings = useSettings();
  const [tab, setTab] = useState<SettingsTabId>('audio');

  const value = settings.data;

  return (
    <>
      {/*
        页面标题必须是 `.pi-page-title` 且文本为「设置」：
        `apps/desktop/src/main/index.ts` 的 `PI_SMOKE_SETTINGS` 段用这一条判定设置页画出来了。
        所以 tab 标题一律不用 `.pi-page-title`（各 tab 自己的标题见 `.pi-settings__subtitle`）。
      */}
      <h1 className="pi-page-title">设置</h1>
      <p className="pi-page-sub">音质、外观与音源。改动立即生效，不需要重启。</p>

      {settings.isPending ? (
        <div className="pi-placeholder">正在读取设置…</div>
      ) : !value ? (
        <div className="pi-placeholder">读取设置失败，请查看主进程日志。</div>
      ) : (
        <SettingsFrame active={tab} onTabChange={setTab}>
          {tab === 'audio' ? <AudioTab /> : null}
          {tab === 'playback' ? <PlaybackTab /> : null}
          {tab === 'ui' ? <UiTab /> : null}
          {tab === 'lyric' ? <LyricTab /> : null}
          {tab === 'account' ? <AccountTab /> : null}
          {tab === 'log' ? <LogTab /> : null}
          <SettingsSyncButton />
        </SettingsFrame>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 分段 pill（参考图里「默认 | AI主题 | 自定义」那一排）
 * ------------------------------------------------------------------ */

/**
 * 互斥选项 ≤ 3 个时用分段 pill 替掉下拉：一眼能看全、少一次点击。
 * 选项多的（音质 6 档、帧率 4 档）继续用 `.pi-select`——排成 pill 会挤成两行反而更难读。
 *
 * 这一层只画按钮，值由外面的 `patch.mutate` 写盘，和原来的下拉落到同一个字段，
 * 没有任何新增设置项。
 */
function Segmented<T extends string>(props: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly onChange: (next: T) => void;
}): ReactNode {
  return (
    <div className="pi-seg" role="group" aria-label={props.ariaLabel}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="pi-seg__item"
          data-active={option.value === props.value ? 'true' : 'false'}
          aria-pressed={option.value === props.value}
          disabled={props.disabled}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 音源 tab：音质 / 第三方源 / 音源状态 / 插件 / 本地曲库
 * ------------------------------------------------------------------ */

/** 官方音质档位。第三方标签（flac/flac24bit）不在这里选，由「允许第三方无损」控制。 */
const OFFICIAL_CHOICES: readonly Quality[] = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jymaster',
];

const TIER_LABEL: Record<SourceStatus['tier'], string> = {
  official: 'L0 · 官方',
  unm: 'L1 · 聚合',
  aggregator: 'L2 · 聚合',
  lx: 'L3 · 自定义源',
  local: 'L4 · 本地',
};

/**
 * 音源。
 *
 * M2.5 的核心在这里：**音源**。它必须是一等公民而不是藏在配置文件里，
 * 因为「第三方源默认关闭、首次启用要二次确认」是账号安全红线（ADR-0001 第 6 条），
 * 用户得看得见自己开了什么、每个源现在健不健康、怎么手动重试。
 *
 * 卡片结构（`.pi-card` / `.pi-setting` / `.pi-srcrow` / `input.pi-input`）一个字没动，
 * 只是从页面顶层搬进了这个 tab——`PI_SMOKE_SETTINGS` 靠这些选择器验收，改了就等于砸掉冒烟。
 */
function AudioTab(): ReactNode {
  const settings = useSettings();
  const patch = usePatchSettings();
  const sources = useSources();
  const reset = useResetSourceHealth();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const value = settings.data;
  const thirdPartyOn =
    (value?.enableThirdPartySources ?? false) && (value?.thirdPartyAcknowledged ?? false);

  const error = patch.error ?? reset.error;

  if (!value) return null;

  return (
    <div className="pi-settings">
      <section className="pi-card">
        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="官方音源会从这一档往下试，直到网易云给出一条能播的直链。非 VIP 账号的上限是「极高」。"
            >
              首选音质
            </span>
            <span className="pi-setting__hint">往下试到能播为止</span>
          </span>
          <select
            className="pi-select"
            value={value.preferredQuality}
            disabled={patch.isPending}
            onChange={(event) => patch.mutate({ preferredQuality: event.target.value as Quality })}
          >
            {OFFICIAL_CHOICES.map((quality) => (
              <option key={quality} value={quality}>
                {QUALITY_LABEL[quality]}
              </option>
            ))}
          </select>
        </div>

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="官方没有版权（歌单里变灰）时，用公开接口到其它平台匹配同一首歌。默认关闭；开启前请先读一遍风险说明。"
            >
              第三方音源
            </span>
            <span className="pi-setting__hint">官方变灰时去其它平台匹配同一首</span>
          </span>
          <input
            type="checkbox"
            className="pi-check"
            checked={thirdPartyOn}
            disabled={patch.isPending}
            onChange={(event) => {
              if (!event.target.checked) {
                patch.mutate({ enableThirdPartySources: false });
                return;
              }
              // 首次开启必须先确认风险，不能靠一个 checkbox 就悄悄打开（ADR-0001 第 6 条）。
              if (!value.thirdPartyAcknowledged) setConfirmOpen(true);
              else patch.mutate({ enableThirdPartySources: true });
            }}
          />
        </div>

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="关掉时第三方源只提供有损音轨。无损文件更大、匹配更慢，也可能只是「标称无损」——实际格式一律以实测字节为准。"
            >
              允许第三方无损
            </span>
            <span className="pi-setting__hint">关掉后第三方只给有损音轨</span>
          </span>
          <input
            type="checkbox"
            className="pi-check"
            checked={value.allowThirdPartyLossless}
            disabled={patch.isPending || !thirdPartyOn}
            onChange={(event) => patch.mutate({ allowThirdPartyLossless: event.target.checked })}
          />
        </div>
      </section>

      <section className="pi-card">
        <div className="pi-sectionhead">
          <span className="pi-setting__title">音源状态</span>
          <button
            type="button"
            className="pi-btn pi-btn--ghost"
            disabled={reset.isPending}
            onClick={() => reset.mutate(undefined)}
          >
            <Icon name="refresh" size={13} /> 全部重试
          </button>
        </div>

        {sources.isPending ? (
          <div className="pi-placeholder">正在读取音源…</div>
        ) : (
          (sources.data?.sources ?? []).map((source) => (
            <div key={source.id} className={`pi-srcrow${source.enabled ? '' : ' pi-srcrow--off'}`}>
              <span className="pi-srcrow__name">
                {source.label}
                <span className="pi-srcrow__tier">{TIER_LABEL[source.tier]}</span>
              </span>
              <span className="pi-srcrow__state">{describeSource(source)}</span>
              <button
                type="button"
                className="pi-btn pi-btn--ghost"
                disabled={reset.isPending}
                onClick={() => reset.mutate(source.id)}
              >
                重试
              </button>
            </div>
          ))
        )}

        <p
          className="pi-setting__hint"
          title="连续 3 次硬失败会被临时降权 5 分钟，期间责任链直接跳到下一个音源；「未匹配」不算失败，不会触发降权。"
        >
          连续 3 次硬失败降权 5 分钟；「未匹配」不算失败。
        </p>
      </section>

      <PluginSection />

      <LocalLibrarySection />

      {error ? <p className="pi-dialog__error">{errorMessage(error)}</p> : null}

      {confirmOpen ? (
        <div className="pi-mask" role="dialog" aria-modal="true">
          <div className="pi-dialog">
            <div className="pi-dialog__head">
              <strong>启用第三方音源</strong>
              <button
                type="button"
                className="pi-iconbtn"
                aria-label="关闭"
                onClick={() => setConfirmOpen(false)}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <div className="pi-dialog__body" style={{ justifyItems: 'start', textAlign: 'left' }}>
              <p className="pi-dialog__hint" style={{ textAlign: 'left' }}>
                这些音源通过公开接口在酷狗、咪咕等平台按「歌名 + 歌手 + 时长」匹配音轨：
              </p>
              <ul
                className="pi-dialog__hint"
                style={{ textAlign: 'left', margin: 0, paddingLeft: 18 }}
              >
                <li>匹配结果可能不是同一个版本（现场版、翻录、错误时长）。</li>
                <li>接口随时可能失效，届时会自动跳过它并尝试下一个音源。</li>
                <li>匹配到的音质以本地实测字节为准，标称无损不等于真的无损。</li>
                <li>
                  <strong>你的网易云 cookie 不会交给第三方</strong>
                  ，它们只能拿到歌名歌手这类公开信息。
                </li>
              </ul>
            </div>
            <div className="pi-dialog__foot">
              <button type="button" className="pi-btn" onClick={() => setConfirmOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="pi-btn pi-btn--primary"
                disabled={patch.isPending}
                onClick={() => {
                  patch.mutate({ enableThirdPartySources: true, thirdPartyAcknowledged: true });
                  setConfirmOpen(false);
                }}
              >
                我已了解，启用
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 播放 tab
 * ------------------------------------------------------------------ */

/* 播放模式的「名字」和「顺序」各只有一份真相：`@pi/player-core` 的 `MODE_LABEL` / `PLAYLIST_MODES`。
   这里原来手抄了一份，还把 `order` 错标成「顺序播放」（用户 m03805 第 4 条：`order` 是列表循环，
   「顺序播放」是本轮新增的第四种 `sequence`）。手抄的副本已经漂移过一次，所以直接引用源表，
   顺带保证这颗下拉框和队列浮层上那颗模式键（`components/SongListOverlay.tsx`）永远说同一套词。 */

/**
 * 播放。
 *
 * 这里**没有发明任何新字段**：音量与播放模式在 `Settings` 里本来就有
 * （`volume` / `playMode`）。音量的权威是播放器 store（`state/player.ts` 的 `setVolume`
 * 已经负责落盘去抖），所以滑杆直接驱动 store，不再自己写 `settingsPatch`——两条写路径
 * 会互相打架。播放模式则直接 patch，和环形菜单里那颗模式键落到同一个字段。
 */
function PlaybackTab(): ReactNode {
  const settings = useSettings();
  const patch = usePatchSettings();
  const volume = usePlayer((state) => state.volume);
  const setVolume = usePlayer((state) => state.setVolume);

  const value = settings.data;
  if (!value) return null;

  return (
    <div className="pi-settings" data-settings-tab-panel="playback">
      <section className="pi-card">
        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="拖动会立即改变播放音量，松手后写进设置，下次启动沿用。"
            >
              音量
            </span>
            <span className="pi-setting__hint">当前 {Math.round(volume * 100)}%</span>
          </span>
          <input
            className="pi-range"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label="音量"
            onChange={(event) => setVolume(Number(event.target.value))}
          />
        </div>

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="和环形菜单里的模式键是同一个设置：随机播放会打乱队列顺序，单曲循环在一首播完后重新开始同一首。"
            >
              播放模式
            </span>
            <span className="pi-setting__hint">和环形菜单的模式键同一个设置</span>
          </span>
          <Segmented
            ariaLabel="播放模式"
            value={value.playMode}
            disabled={patch.isPending}
            options={PLAYLIST_MODES.map((mode) => ({ value: mode, label: MODE_LABEL[mode] }))}
            onChange={(next) => patch.mutate({ playMode: next })}
          />
        </div>
      </section>

      <DownloadDirSection />
    </div>
  );
}

/**
 * 下载目录。
 *
 * 字段 `downloadDir` 早就在 `Settings` 里（空表示用默认目录），但一直没有界面——
 * 这里补上，仍然只是「写一个已存在的键」，没有新增任何后端字段。
 */
function DownloadDirSection(): ReactNode {
  const settings = useSettings();
  const patch = usePatchSettings();
  // null = 跟随已保存的值；非 null = 用户正在编辑。这样保存成功后输入框会自动回到权威值。
  const [draft, setDraft] = useState<string | null>(null);

  const saved = settings.data?.downloadDir ?? '';
  const value = draft ?? saved;
  const dirty = value.trim() !== saved.trim();

  return (
    <section className="pi-card">
      <div className="pi-setting">
        <span>
          <span
            className="pi-setting__title"
            title="下载歌曲存到哪个文件夹；空着表示用系统默认下载目录。改完要按「保存」才落盘。"
          >
            下载目录
          </span>
          <span className="pi-setting__hint">空着用系统默认下载目录，改完按保存</span>
        </span>
      </div>

      <div className="pi-pathrow">
        <input
          className="pi-input"
          type="text"
          value={value}
          spellCheck={false}
          placeholder="例如 D:\\Music\\PI"
          disabled={patch.isPending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="button"
          className="pi-btn"
          disabled={patch.isPending || !dirty}
          onClick={() =>
            patch.mutate({ downloadDir: value.trim() }, { onSuccess: () => setDraft(null) })
          }
        >
          保存
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 界面 tab
 * ------------------------------------------------------------------ */

const THEME_LABEL: Readonly<Record<ThemeMode, string>> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

const THEME_ORDER: readonly ThemeMode[] = ['light', 'dark', 'system'];

/**
 * 界面语言的两个选项。
 * 值必须原样是设置里存的字符串（`'zh-CN' | 'en'`），别另造 id——这里只换控件外观，
 * 字段与写盘路径和原来的 `<select>` 完全一样。
 */
const LOCALE_OPTIONS: readonly {
  readonly value: 'zh-CN' | 'en';
  readonly label: string;
}[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
];

/**
 * 应用主题色的三档（用户第二十一轮第 5 条：「将黑白/天蓝设为默认色，并且有自定义选项」）。
 * 值就是 `state/ui.ts` 里 `accentMode` 的字面量，别另造 id。
 */
const ACCENT_OPTIONS: readonly { readonly value: AccentMode; readonly label: string }[] = [
  { value: 'sky', label: '天蓝' },
  { value: 'mono', label: '黑白' },
  { value: 'custom', label: '自定义' },
];

/** 界面：主题明暗与界面语言。都是 `Settings` 里现成的字段。 */
function UiTab(): ReactNode {
  const settings = useSettings();
  const patch = usePatchSettings();
  /*
   * 应用主题色（用户第二十一轮第 5 条）：它和 `uiStyle` 一样只存本机
   * （`state/ui.ts` 的 `pi.accent`），所以不走 `patch.mutate`，直接读 zustand。
   * 真正把它变成 CSS 变量的是 `App.tsx` 的 `useAccent`。
   */
  const accentMode = useUi((state) => state.accentMode);
  const accentColor = useUi((state) => state.accentColor);
  const setAccentMode = useUi((state) => state.setAccentMode);
  const setAccentColor = useUi((state) => state.setAccentColor);

  const value = settings.data;
  if (!value) return null;

  return (
    <div className="pi-settings" data-settings-tab-panel="ui">
      <section className="pi-card">
        <div className="pi-setting">
          <span>
            <span className="pi-setting__title" title="跟随系统时会实时响应系统的深色模式切换。">
              外观
            </span>
            <span className="pi-setting__hint">跟随系统会实时响应深色切换</span>
          </span>
          <Segmented
            ariaLabel="外观"
            value={value.theme}
            disabled={patch.isPending}
            options={THEME_ORDER.map((mode) => ({ value: mode, label: THEME_LABEL[mode] }))}
            onChange={(next) => patch.mutate({ theme: next })}
          />
        </div>

        <div className="pi-setting" data-accent-setting="true">
          <span>
            <span
              className="pi-setting__title"
              title="改的是界面主色（按钮、进度条、选中态那套）。天蓝是原来的默认；黑白在亮档用近黑、暗档用近白；自定义按挑的颜色现算悬停/淡底/前景色。"
            >
              应用主题色
            </span>
            <span className="pi-setting__hint">
              {accentMode === 'mono'
                ? '亮档近黑 / 暗档近白，按钮跟着走'
                : accentMode === 'custom'
                  ? '主色 / 悬停 / 淡底都按这枚颜色现算'
                  : '默认天蓝，按钮与选中态都吃它'}
            </span>
          </span>
          <Segmented
            ariaLabel="应用主题色"
            value={accentMode}
            disabled={false}
            options={ACCENT_OPTIONS}
            onChange={(next) => setAccentMode(next)}
          />
        </div>

        {/*
          用户第二十二轮第 2 条：自定义主题色不再用一个原生取色块，而是整块**取色面板**
          （选色方块 + 色相条 + 当前选色 + 推荐色，见 `components/AccentPicker.tsx`）。
          这一栏因此改成竖排（`.pi-setting--stack`）：面板要整宽才好拖手柄。
        */}
        {accentMode === 'custom' ? (
          <div className="pi-setting pi-setting--stack" data-accent-custom="true">
            <span>
              <span className="pi-setting__title">自定义主色</span>
              <span className="pi-setting__hint">
                方块选饱和度与明度、彩虹条选色相，或点下面的推荐色 / 直接填十六进制
              </span>
            </span>
            <AccentPicker value={accentColor} onChange={setAccentColor} />
          </div>
        ) : null}

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="目前整套界面文案只有中文一套，选英文只把这个偏好记进设置文件，界面不会变——等翻译表做出来再由这里切换。"
            >
              界面语言
            </span>
            <span className="pi-setting__hint">英文只记偏好，界面暂不变</span>
          </span>
          <Segmented
            ariaLabel="界面语言"
            value={value.locale}
            disabled={patch.isPending}
            options={LOCALE_OPTIONS}
            onChange={(next) => patch.mutate({ locale: next })}
          />
        </div>
      </section>

      <section className="pi-card">
        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="把播放上报给网易云，影响「最近听过」和私人雷达。第三方音源播放的歌曲不上报。"
            >
              上报听歌记录
            </span>
            <span className="pi-setting__hint">第三方音源播放的歌不上报</span>
          </span>
          <input
            type="checkbox"
            className="pi-check"
            checked={value.scrobbleEnabled}
            disabled={patch.isPending}
            onChange={(event) => patch.mutate({ scrobbleEnabled: event.target.checked })}
          />
        </div>
      </section>

      <ShortcutSettingsCard />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 快捷键（用户 m00001 第 5 条）
 * ------------------------------------------------------------------ */

/**
 * 九条快捷键逐条改绑。
 *
 * 交互：点右侧的键位 → 该行进入「按下新键…」的捕获态，下一个非修饰键就是新绑定，
 * 再点一次同一行或按 Esc 取消。真正的按键由 `components/ShortcutLayer.tsx` 在 window
 * **捕获阶段**吃掉（所以捕获时设置框自己的 Esc 监听不会先把设置框关掉）。
 *
 * 配置只存本机：`state/shortcuts.ts` 写 localStorage 的 `pi.shortcuts`
 * （与 `uiStyle` 的 `pi.ui-style` 同一套路，不进 `packages/shared` 的 Settings）。
 */
function ShortcutSettingsCard(): ReactNode {
  const bindings = useShortcuts((state) => state.bindings);
  const capturing = useShortcuts((state) => state.capturing);
  const beginCapture = useShortcuts((state) => state.beginCapture);
  const cancelCapture = useShortcuts((state) => state.cancelCapture);
  const resetBindings = useShortcuts((state) => state.resetBindings);

  return (
    <section className="pi-card pi-scut">
      <div className="pi-sectionhead">
        <span className="pi-setting__title">快捷键</span>
        <button
          type="button"
          className="pi-btn pi-btn--ghost"
          data-shortcut-reset="all"
          title="把九条绑定全部还原成出厂设置。"
          onClick={() => resetBindings()}
        >
          <Icon name="refresh" size={13} /> 恢复默认
        </button>
      </div>

      <p className="pi-scut__note">
        点右侧键位就能改：按下想用的新键立即生效，按 Esc 取消。配置保存在本机。
      </p>

      {SHORTCUT_DEFINITIONS.map((definition) => {
        const active = capturing === definition.action;
        const other = findConflict(bindings, definition.action);
        return (
          <div
            className="pi-scut__row"
            key={definition.action}
            data-shortcut-row={definition.action}
            data-shortcut-capturing={active ? 'true' : 'false'}
          >
            <span className="pi-scut__meta">
              <span className="pi-setting__title">{definition.label}</span>
              <span className="pi-setting__hint">{definition.hint}</span>
              {other === null ? null : (
                <span className="pi-scut__conflict" data-shortcut-conflict={definition.action}>
                  与「{shortcutLabel(other)}」用了同一个组合，只有靠前的那个会生效
                </span>
              )}
            </span>
            <button
              type="button"
              className="pi-scut__key"
              data-shortcut-key={definition.action}
              data-shortcut-binding={formatBinding(bindings[definition.action])}
              aria-label={`修改「${definition.label}」的快捷键，当前是 ${formatBinding(bindings[definition.action])}`}
              onClick={() => (active ? cancelCapture() : beginCapture(definition.action))}
            >
              {active ? '按下新键…' : formatBinding(bindings[definition.action])}
            </button>
          </div>
        );
      })}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 歌词 tab
 * ------------------------------------------------------------------ */

interface LyricThemeOption {
  key: LyricTheme;
  name: string;
  /** 卡面上那一行短标签（拍立得皮肤：说明收短，一屏能扫完六套）。 */
  tag: string;
  /** 完整说明：不占版面，鼠标悬停时由 `title` 给出。 */
  desc: string;
}

/**
 * 六个歌词动效主题。
 *
 * 名字与一句话描述按用户 m08768 第 4 条给的那套写；描述逐条自己重写了一遍，
 * 不抄 folia 的文案。这一栏**只写设置**：`lyricTheme` 是唯一被允许新增的字段，
 * 而且它早就在 `packages/shared/src/index.ts` 里定义好了；真正换渲染主题由歌词组件那边接。
 */
const LYRIC_THEME_OPTIONS: readonly LyricThemeOption[] = [
  {
    key: 'classic',
    name: '流光',
    tag: '大字铺满，唱到哪亮到哪',
    desc: '默认。当前这句铺满一行大字，唱过的字从左往右被光扫亮，没唱到的字压暗等在那儿。',
  },
  {
    key: 'fume',
    name: '浮名',
    tag: '歌词上浮，镜头跟着唱句走',
    desc: '整屏歌词层层叠着往上浮，镜头跟着正在唱的那句慢慢移动，前后几句都留一点余光。',
  },
  {
    key: 'cadenza',
    name: '心象',
    tag: '单字撒满画面，自己连成句',
    desc: '整句被拆成一个个单字撒在画面各处，随着节拍轻轻漂动，读完一句要自己把字连起来。',
  },
  {
    key: 'partita',
    name: '云阶',
    tag: '沿引导线错落，唱到即亮',
    desc: '歌词沿着一条引导线一块块错落排开，像一级级台阶铺向远处，唱到哪一块哪一块亮起。',
  },
  {
    key: 'tilt',
    name: '倾诉',
    tag: '长句断行，偶有一行斜压其上',
    desc: '长句自动断成短行堆在一起，偶尔抽出一行变成斜体压在上面，像低声重复了一句。',
  },
  {
    key: 'pendolo',
    name: '时计',
    tag: '封面作钟面，歌词贴外圈推',
    desc: '封面嵌进一面钟表盘，歌词贴着外圈弧线一格一格推过去，整首歌像在走时。',
  },
];

/** 帧率上限的展示顺序；值就是设置里存的字符串，别另造一套 id。 */
const FPS_CAP_ORDER: readonly LyricFpsCap[] = ['off', '120', '90', '60'];

const FPS_CAP_LABEL: Record<LyricFpsCap, string> = {
  off: '不限',
  '120': '120 帧',
  '90': '90 帧',
  '60': '60 帧',
};

/**
 * 「歌词动效参数」里的一行 range。
 *
 * 拖动时只改本地草稿：`patch.mutate` 是走 IPC 落盘的，而主进程每收一次 patch 都要清音频缓存、
 * 比一遍目录，把每条 `onChange` 都发出去等于拖一下就打出上百个请求。松手（`onPointerUp`）
 * 或键盘操作失焦（`onBlur`）才提交——两件事都会触发也无所谓，重复值不会真的写盘。
 */
function TuningRange(props: {
  readonly field: string;
  readonly title: string;
  /** 一行短说明，和「当前 x.xx」并排显示。 */
  readonly hint: string;
  /** 完整说明，进 `title` 悬停提示（拍立得不摆长文案）。 */
  readonly tip: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly resetNonce: number;
  readonly onCommit: (next: number) => void;
  /**
   * 草稿值的显示格式（第十四轮：新增的几项带单位——`42%` / `100°` / `2.0x` / `20px`）。
   * 默认还是老样子 `1.00`，所以老六项一字未改。
   */
  readonly format?: (next: number) => string;
}): ReactNode {
  const [draft, setDraft] = useState<number | null>(null);
  const committed = useRef(props.value);

  useEffect(() => {
    // 设置里的值变了（写盘回来，或点了「恢复默认」）就把草稿丢掉，回到「以设置为准」。
    // `resetNonce` 一并盯着：值本来就是默认值时 `value` 不会变，草稿就没人清。
    if (committed.current === props.value) return;
    committed.current = props.value;
    setDraft(null);
  }, [props.value]);

  useEffect(() => {
    setDraft(null);
  }, [props.resetNonce]);

  const shown = draft ?? props.value;
  const format = props.format ?? ((next: number) => next.toFixed(2));

  return (
    <div className="pi-setting">
      <span>
        <span className="pi-setting__title" title={props.tip}>
          {props.title}
        </span>
        <span className="pi-setting__hint">
          当前 {format(shown)} · {props.hint}
        </span>
      </span>
      <input
        className="pi-range"
        type="range"
        data-lyric-tuning={props.field}
        min={props.min}
        max={props.max}
        step={props.step}
        value={shown}
        aria-label={props.title}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={() => {
          if (draft !== null) props.onCommit(draft);
        }}
        onBlur={() => {
          if (draft !== null) props.onCommit(draft);
        }}
      />
    </div>
  );
}

/** 歌词：选一个动效主题，写进 `settings.lyricTheme`。 */
function LyricTab(): ReactNode {
  const settings = useSettings();
  const patch = usePatchSettings();
  // 「恢复默认」的自增信号：见 TuningRange 里那段注释。
  const [resetNonce, setResetNonce] = useState(0);

  const value = settings.data;
  if (!value) return null;

  const tuning = value.lyricTuning;

  /**
   * 嵌套字段必须**整份**传：`patch` 是顶层 partial（`SettingsPatchSchema = SettingsSchema.partial()`），
   * 主进程 `patchSettings` 也是浅合并 `{ ...current, ...patch }`——只传 `{ fontScale: 1.1 }`
   * 会把整个 `lyricTuning` 换成一个缺字段的对象，schema 校验当场就把这次 patch 打回去。
   */
  const writeTuning = (partial: Partial<LyricTuning>): void => {
    patch.mutate({ lyricTuning: { ...tuning, ...partial } });
  };

  return (
    <div className="pi-settings" data-settings-tab-panel="lyric">
      <section className="pi-card">
        <div className="pi-sectionhead">
          <span className="pi-setting__title">歌词动效</span>
        </div>
        <p
          className="pi-setting__hint"
          title="播放器主页的歌词用哪一套动效。改动立即生效，下一句歌词就用新的；只影响歌词怎么画，不影响音源与音质。"
        >
          选一套动效，改动立即生效
        </p>

        <div className="pi-lyric-themes" data-lyric-theme={value.lyricTheme}>
          {LYRIC_THEME_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className="pi-lyric-theme"
              data-lyric-theme-option={option.key}
              data-active={option.key === value.lyricTheme ? 'true' : 'false'}
              aria-pressed={option.key === value.lyricTheme}
              disabled={patch.isPending}
              title={option.desc}
              onClick={() => patch.mutate({ lyricTheme: option.key })}
            >
              <span className="pi-lyric-theme__name">{option.name}</span>
              <span className="pi-lyric-theme__desc">{option.tag}</span>
            </button>
          ))}
        </div>

        {patch.error ? <p className="pi-dialog__error">{errorMessage(patch.error)}</p> : null}
      </section>

      <section className="pi-card">
        <div className="pi-sectionhead">
          <span className="pi-setting__title">歌词动效参数</span>
        </div>
        <p
          className="pi-setting__hint"
          title="这几项和上面选的主题无关，会套在每一套主题上：主题决定「画成什么样」，参数决定「画多浓、多快、多飘」。滑杆拖动时画面和数字立刻跟着动，松手才写进设置。"
        >
          套在每一套主题上的浓淡与快慢，松手才落盘
        </p>

        <TuningRange
          field="themeOpacity"
          title="主题不透明度"
          hint="整套舞台的浓淡"
          tip="整套主题舞台的浓淡：1 完全不透明，0.4 时压到四成。经典主题是纯内置版式，不受这项影响。"
          min={0.4}
          max={1}
          step={0.01}
          value={tuning.themeOpacity}
          resetNonce={resetNonce}
          onCommit={(next) => writeTuning({ themeOpacity: next })}
        />

        <TuningRange
          field="fontScale"
          title="字号"
          hint="字号的倍数"
          tip="歌词字号的倍数。每套主题都会再按舞台宽高收敛一次，所以调大不会把字挤出舞台。"
          min={0.8}
          max={1.3}
          step={0.01}
          value={tuning.fontScale}
          resetNonce={resetNonce}
          onCommit={(next) => writeTuning({ fontScale: next })}
        />

        <TuningRange
          field="motionAmount"
          title="动效幅度"
          hint="飘移与摆动的幅度"
          tip="错落、飘移、摆动这些「幅度」的倍数：1 是现在这套观感，调小更安静，调大更飘。"
          min={0.4}
          max={1.6}
          step={0.01}
          value={tuning.motionAmount}
          resetNonce={resetNonce}
          onCommit={(next) => writeTuning({ motionAmount: next })}
        />

        <TuningRange
          field="glowIntensity"
          title="辉光强度"
          hint="0 就是关掉辉光"
          tip="字上那层辉光的倍数，0 就是彻底关掉。只对自带辉光的主题（心象、浮名）有肉眼可见的变化。"
          min={0}
          max={1.6}
          step={0.01}
          value={tuning.glowIntensity}
          resetNonce={resetNonce}
          onCommit={(next) => writeTuning({ glowIntensity: next })}
        />

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="给歌词动画限一个最高帧率，省电、降风扇噪音。只作用于自己跑动画循环的主题（浮名、心象、倾诉、时计）；云阶是纯 CSS 过渡，不受这项影响。「不限」等于现在的行为。"
            >
              帧率上限
            </span>
            <span className="pi-setting__hint">省电、降风扇噪音</span>
          </span>
          <select
            className="pi-select"
            data-lyric-tuning="fpsCap"
            value={tuning.fpsCap}
            disabled={patch.isPending}
            onChange={(event) => writeTuning({ fpsCap: event.target.value as LyricFpsCap })}
          >
            {FPS_CAP_ORDER.map((cap) => (
              <option key={cap} value={cap}>
                {FPS_CAP_LABEL[cap]}
              </option>
            ))}
          </select>
        </div>

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="开着时按歌曲挑一套主题，同一首歌每次进来都是同一套（切歌不会换回来再换过去）；关着时用上面选中的那一套。"
            >
              每首歌随机主题
            </span>
            <span className="pi-setting__hint">同一首歌固定同一套</span>
          </span>
          <input
            className="pi-check"
            type="checkbox"
            data-lyric-tuning="randomThemePerSong"
            aria-label="每首歌随机主题"
            checked={tuning.randomThemePerSong}
            disabled={patch.isPending}
            onChange={(event) => writeTuning({ randomThemePerSong: event.target.checked })}
          />
        </div>

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="把这一页所有歌词参数一次写回出厂值，不动主题本身，也不动其它设置页。"
            >
              恢复默认
            </span>
            <span className="pi-setting__hint">全部一次写回出厂值</span>
          </span>
          <button
            type="button"
            className="pi-btn"
            data-lyric-tuning-reset="true"
            disabled={patch.isPending}
            onClick={() => {
              setResetNonce((nonce) => nonce + 1);
              patch.mutate({ lyricTuning: { ...DEFAULT_LYRIC_TUNING } });
            }}
          >
            恢复默认
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------------
       * 第十四轮（用户 m05281）第 3/4/6/7 条：每套主题各有一小组「跟着它走」的旋钮。
       * 参考图 4/5 就是这种「标题 + 数值 → 一条细滑杆」的行。默认值刻意等于改造前的观感，
       * 所以这一页第一次打开时，画面与老版本一模一样。
       * ------------------------------------------------------------------ */}
      <section className="pi-card">
        <div className="pi-sectionhead">
          <span className="pi-setting__title">浮名 · 镜头</span>
        </div>
        <p
          className="pi-setting__hint"
          title="浮名的镜头一直追着「当前唱到的那一句」走：这三项决定它怎么追、追多快。"
        >
          镜头追着当前那句走
        </p>

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="平滑＝镜头一路跟拍过去（有加速度与一点点过冲）；定格＝切到新的一句时镜头直接落位，中途不补间。两种模式都保留原来那圈「歌词不会飘出窗口」的边界守卫。"
            >
              镜头追焦方式
            </span>
            <span className="pi-setting__hint">平滑跟拍 / 定格直落</span>
          </span>
          <select
            className="pi-select"
            data-lyric-tuning="fumeCameraFollow"
            value={tuning.fumeCameraFollow}
            disabled={patch.isPending}
            onChange={(event) =>
              writeTuning({
                fumeCameraFollow: event.target.value as LyricTuning['fumeCameraFollow'],
              })
            }
          >
            <option value="smooth">平滑</option>
            <option value="snap">定格</option>
          </select>
        </div>

        <TuningRange
          field="fumeCameraSpeed"
          title="镜头移动速度"
          hint="跟拍的快慢"
          tip="镜头移动速度的倍数：1 是改造前的速度，调大更利落、调小更慢摇。只影响镜头的插值快慢，不改取景倍率。"
          min={0.4}
          max={2.5}
          step={0.05}
          value={tuning.fumeCameraSpeed}
          resetNonce={resetNonce}
          format={(next) => `${next.toFixed(2)}x`}
          onCommit={(next) => writeTuning({ fumeCameraSpeed: next })}
        />
      </section>

      <section className="pi-card">
        <div className="pi-sectionhead">
          <span className="pi-setting__title">流光 · 逐字</span>
        </div>
        <p
          className="pi-setting__hint"
          title="流光那一行大字是一个字一个字亮起来的：开着逐字旋转时，还没唱到的字各自歪一点，唱到它才转正。"
        >
          一个字一个字转正
        </p>

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="开着时，未唱的字各带一个固定的小角度（±6° 以内，同一句每次都一样），唱到时弹回正位；关着时就是原来的「只放大不旋转」。"
            >
              逐字旋转
            </span>
            <span className="pi-setting__hint">未唱的字歪一点，唱到转正</span>
          </span>
          <input
            className="pi-check"
            type="checkbox"
            data-lyric-tuning="classicWordSpin"
            aria-label="逐字旋转"
            checked={tuning.classicWordSpin}
            disabled={patch.isPending}
            onChange={(event) => writeTuning({ classicWordSpin: event.target.checked })}
          />
        </div>
      </section>

      <section className="pi-card">
        <div className="pi-sectionhead">
          <span className="pi-setting__title">云阶 · 错落</span>
        </div>
        <p
          className="pi-setting__hint"
          title="云阶把一句拆成几块错着摆。这里决定「错多远」和「要不要画那几条十字引导线」。"
        >
          错落的远近与引导线
        </p>

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="关掉后不画细十字引导线，只剩歌词块本身的基线。"
            >
              引导线
            </span>
            <span className="pi-setting__hint">块与块之间的细十字线</span>
          </span>
          <input
            className="pi-check"
            type="checkbox"
            data-lyric-tuning="partitaGuides"
            aria-label="引导线"
            checked={tuning.partitaGuides}
            disabled={patch.isPending}
            onChange={(event) => writeTuning({ partitaGuides: event.target.checked })}
          />
        </div>

        <TuningRange
          field="partitaStaggerMin"
          title="错位最小值"
          hint="相邻块最近错开多少"
          tip="相邻两块至少错开这么多像素：调小更整齐，调大更松散。最大值不能小于最小值，主进程会按上下限夹一次。"
          min={0}
          max={80}
          step={1}
          value={tuning.partitaStaggerMin}
          resetNonce={resetNonce}
          format={(next) => `${Math.round(next)}px`}
          onCommit={(next) => writeTuning({ partitaStaggerMin: next })}
        />

        <TuningRange
          field="partitaStaggerMax"
          title="错位最大值"
          hint="相邻块最多错开多少"
          tip="相邻两块最多错开这么多像素：和上面的最小值一起定出错落的区间。"
          min={20}
          max={160}
          step={1}
          value={tuning.partitaStaggerMax}
          resetNonce={resetNonce}
          format={(next) => `${Math.round(next)}px`}
          onCommit={(next) => writeTuning({ partitaStaggerMax: next })}
        />
      </section>

      <section className="pi-card">
        <div className="pi-sectionhead">
          <span className="pi-setting__title">时计 · 表盘</span>
        </div>
        <p
          className="pi-setting__hint"
          title="时计的线框表盘与歌词弧线共用这几个数：改完表盘和歌词一起动。"
        >
          表盘与歌词弧线共用这几个数
        </p>

        <TuningRange
          field="pendoloDialRadius"
          title="轮盘半径"
          hint="占舞台短边的百分比"
          tip="表盘半径占舞台短边的百分比：42% 就是改造前的大小，调大更满、调小更收。"
          min={30}
          max={60}
          step={1}
          value={tuning.pendoloDialRadius}
          resetNonce={resetNonce}
          format={(next) => `${Math.round(next)}%`}
          onCommit={(next) => writeTuning({ pendoloDialRadius: next })}
        />

        <TuningRange
          field="pendoloArcAngle"
          title="弧度角度"
          hint="歌词铺开的总角度"
          tip="歌词沿表盘外圈铺开的总角度：100° 是改造前那圈，调小歌词更聚、调大更散。"
          min={60}
          max={160}
          step={1}
          value={tuning.pendoloArcAngle}
          resetNonce={resetNonce}
          format={(next) => `${Math.round(next)}°`}
          onCommit={(next) => writeTuning({ pendoloArcAngle: next })}
        />

        <TuningRange
          field="pendoloEscapeForce"
          title="擒纵咬合力"
          hint="歌词咬合得有多紧"
          tip="擒纵机构的咬合力：2.0x 是改造前的手感，调大更硬更快（焦点句弹得更利落），调小更软更飘。"
          min={0.5}
          max={3}
          step={0.05}
          value={tuning.pendoloEscapeForce}
          resetNonce={resetNonce}
          format={(next) => `${next.toFixed(2)}x`}
          onCommit={(next) => writeTuning({ pendoloEscapeForce: next })}
        />

        <TuningRange
          field="pendoloFocusScale"
          title="聚焦句缩放"
          hint="当前句放多大"
          tip="当前唱到的那一句放多大：1.25x 是改造前的大小，调到 1.00x 就与别的句一样大。"
          min={1}
          max={1.7}
          step={0.01}
          value={tuning.pendoloFocusScale}
          resetNonce={resetNonce}
          format={(next) => `${next.toFixed(2)}x`}
          onCommit={(next) => writeTuning({ pendoloFocusScale: next })}
        />

        <div className="pi-setting">
          <span>
            <span
              className="pi-setting__title"
              title="关掉后表盘中心不画歌曲封面（连封面图都不加载），表盘就是一张干净的空表。"
            >
              表盘显示歌曲封面
            </span>
            <span className="pi-setting__hint">表盘正中那张封面</span>
          </span>
          <input
            className="pi-check"
            type="checkbox"
            data-lyric-tuning="pendoloCoverOnDial"
            aria-label="表盘显示歌曲封面"
            checked={tuning.pendoloCoverOnDial}
            disabled={patch.isPending}
            onChange={(event) => writeTuning({ pendoloCoverOnDial: event.target.checked })}
          />
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 账号 / 日志 tab
 * ------------------------------------------------------------------ */

/**
 * 账号。
 *
 * 面板态直接用抽屉里那同一张卡：`AccountCard` 是全应用唯一的登录入口，
 * 复制一份就会有两套 pending 与两套退出逻辑（详见那个组件的注释）。
 */
function AccountTab(): ReactNode {
  return (
    <div className="pi-settings" data-settings-tab-panel="account">
      <section className="pi-card">
        <div className="pi-sectionhead">
          <span className="pi-setting__title">账号</span>
        </div>
        <AccountCard variant="panel" />
        <p
          className="pi-setting__hint"
          title="登录用的是网易云官方扫码，cookie 只留在本机、不会交给任何第三方音源；退出登录会立刻清掉本地凭证。"
        >
          官方扫码登录，cookie 只留在本机
        </p>
      </section>
    </div>
  );
}

/**
 * 日志。
 *
 * 环形菜单里删掉的「音质日志」键落到这里，正文与独立页共用 `QualityLogPanel`。
 * 卡片标题里保留「音质日志」四个字：主进程冒烟与用户搜索都靠它认这一块。
 */
function LogTab(): ReactNode {
  return (
    <div className="pi-settings" data-settings-tab-panel="log">
      <section className="pi-card">
        <div className="pi-sectionhead">
          <span className="pi-setting__title">音质日志</span>
        </div>
        <p className="pi-setting__hint" style={{ marginTop: 0 }}>
          每次解析的实测结果（请求档位、实际容器/采样率/码率、责任链上每个源为什么被跳过）。
        </p>
      </section>

      <QualityLogPanel />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 底部：同步数据
 * ------------------------------------------------------------------ */

type SyncState = 'idle' | 'busy' | 'done' | 'failed';

const SYNC_LABEL: Readonly<Record<SyncState, string>> = {
  idle: '同步数据',
  busy: '同步中…',
  done: '已刷新',
  failed: '同步失败',
};

/**
 * 同步数据（参考图底部那颗键）。
 *
 * 「真做事」的含义就是：把全局查询缓存全部作废，让当前页面与后台正在看的页面都重新去主进程
 * 取一次最新数据（歌单、最近听过、音源健康度、设置都在里面）。本地缓存不是数据库，
 * 没有别的「同步」可做，所以这里不假装有进度条、也不弹窗。
 */
function SettingsSyncButton(): ReactNode {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SyncState>('idle');

  const run = (): void => {
    if (state === 'busy') return;
    setState('busy');
    void queryClient
      .invalidateQueries()
      .then(() => setState('done'))
      .catch(() => setState('failed'));
  };

  return (
    <div className="pi-settings-frame__foot">
      <button
        type="button"
        className="pi-syncbtn"
        data-sync-state={state}
        disabled={state === 'busy'}
        onClick={run}
      >
        <Icon name="refresh" size={15} />
        {SYNC_LABEL[state]}
      </button>
      <span className="pi-settings-frame__foothint">
        {state === 'done'
          ? '已重新向主进程拉取最新数据。'
          : state === 'failed'
            ? '刷新失败，稍后再试；页面上的数据仍是上一次取到的。'
            : '把歌单、最近听过与音源状态重新拉一遍。'}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 音源 tab 里的两块（本地曲库 / 自定义源插件）
 * ------------------------------------------------------------------ */

/**
 * 本地曲库（L4）。
 *
 * 责任链的最后一层：官方变灰、第三方也匹配不到时，从用户自己的硬盘里找同名文件。
 * 只读文件名（不解析音频标签），扫描上限 2000 首，匹配宁可不中也不放错歌。
 */
function LocalLibrarySection(): ReactNode {
  const settings = useSettings();
  const patch = usePatchSettings();
  // null = 跟随已保存的值；非 null = 用户正在编辑。这样保存成功后输入框会自动回到权威值。
  const [draft, setDraft] = useState<string | null>(null);

  const saved = settings.data?.localLibraryDir ?? '';
  const value = draft ?? saved;
  const dirty = value.trim() !== saved.trim();

  return (
    <section className="pi-card">
      <div className="pi-setting">
        <span>
          <span
            className="pi-setting__title"
            title="填一个文件夹（含子目录）：官方变灰、第三方也匹配不到时，最后一层从硬盘里找同名文件。只读文件名不解析标签，空着表示不用本地兜底。"
          >
            本地曲库
          </span>
          <span className="pi-setting__hint">官方变灰时的最后一层：硬盘里找同名文件</span>
        </span>
      </div>

      <div className="pi-pathrow">
        <input
          className="pi-input"
          type="text"
          value={value}
          spellCheck={false}
          placeholder="例如 D:\\Music"
          disabled={patch.isPending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="button"
          className="pi-btn"
          disabled={patch.isPending || !dirty}
          onClick={() =>
            patch.mutate({ localLibraryDir: value.trim() }, { onSuccess: () => setDraft(null) })
          }
        >
          保存
        </button>
      </div>
    </section>
  );
}

/**
 * 自定义源插件（L3）。
 *
 * 只接受**粘贴文本或选一个 .js 文件**，不接受 URL：内置脚本不受同源策略保护，
 * 「导入链接」就等于给界面一个任意地址抓取入口（ADR-0001 第 6 条）。
 */
function PluginSection(): ReactNode {
  const plugins = usePlugins();
  const importPlugin = useImportPlugin();
  const toggle = useTogglePlugin();
  const remove = useRemovePlugin();
  const [script, setScript] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const list = plugins.data?.plugins ?? [];
  const busy = importPlugin.isPending || toggle.isPending || remove.isPending;

  const runImport = (text: string): void => {
    setNotice(null);
    importPlugin.mutate(text, {
      onSuccess: (data) => {
        setScript('');
        setNotice(`已导入 ${data.plugins.length} 个插件（同内容的脚本只会保留一份）`);
      },
    });
  };

  return (
    <section className="pi-card">
      <div className="pi-sectionhead">
        <span className="pi-setting__title">自定义源插件（L3）</span>
      </div>

      <p
        className="pi-setting__hint"
        style={{ marginTop: 0 }}
        title="兼容 LX Music 的自定义源脚本。脚本在独立沙箱进程里运行，拿不到你的 cookie，所有网络请求都经主进程转发；但它仍然是你从网上拿来的第三方代码，只导入你信得过的来源。"
      >
        兼容 LX Music 的自定义源脚本，在<strong>独立沙箱进程</strong>里跑
      </p>

      {plugins.isPending ? (
        <div className="pi-placeholder">正在读取插件…</div>
      ) : list.length === 0 ? (
        <div className="pi-placeholder">还没有导入任何插件。</div>
      ) : (
        list.map((plugin) => (
          <div key={plugin.id} className={`pi-srcrow${plugin.enabled ? '' : ' pi-srcrow--off'}`}>
            <span className="pi-srcrow__name">
              {plugin.name}
              {plugin.version ? <span className="pi-srcrow__tier">v{plugin.version}</span> : null}
            </span>
            <span className="pi-srcrow__state">
              {plugin.sources.length > 0 ? `支持 ${plugin.sources.join('/')}` : '未声明任何平台'}
              {plugin.author ? ` · ${plugin.author}` : ''}
            </span>
            <input
              type="checkbox"
              className="pi-check"
              checked={plugin.enabled}
              disabled={busy}
              aria-label={`启用 ${plugin.name}`}
              onChange={(event) => toggle.mutate({ id: plugin.id, enabled: event.target.checked })}
            />
            <button
              type="button"
              className="pi-btn pi-btn--ghost"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`删除插件「${plugin.name}」？`)) return;
                remove.mutate(plugin.id);
              }}
            >
              删除
            </button>
          </div>
        ))
      )}

      <div className="pi-plugin-import">
        <textarea
          className="pi-textarea"
          rows={4}
          value={script}
          spellCheck={false}
          placeholder="把自定义源脚本的全文粘贴到这里（开头必须有 /* @name ... */ 注释块）"
          onChange={(event) => setScript(event.target.value)}
        />
        <div className="pi-plugin-import__actions">
          <label className="pi-btn pi-btn--ghost">
            选择 .js 文件
            <input
              type="file"
              accept=".js,text/javascript,application/javascript"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void file.text().then((text) => runImport(text));
                event.target.value = '';
              }}
            />
          </label>
          <button
            type="button"
            className="pi-btn pi-btn--primary"
            disabled={busy || script.trim().length === 0}
            onClick={() => runImport(script)}
          >
            {importPlugin.isPending ? '正在沙箱里试跑…' : '导入并试跑'}
          </button>
        </div>
        <p
          className="pi-setting__hint"
          title="导入时会立即在沙箱里执行一次：脚本报错或没有声明任何平台，会当场告诉你，而不是等你点歌时才发现。"
        >
          导入时先在沙箱里试跑一次，报错当场告诉你
        </p>
        {notice ? <p className="pi-setting__hint">{notice}</p> : null}
        {importPlugin.error ? (
          <p className="pi-dialog__error">导入失败：{errorMessage(importPlugin.error)}</p>
        ) : null}
        {toggle.error ? <p className="pi-dialog__error">{errorMessage(toggle.error)}</p> : null}
        {remove.error ? <p className="pi-dialog__error">{errorMessage(remove.error)}</p> : null}
      </div>
    </section>
  );
}

/** 一行状态文案：说清「现在能不能用」以及「为什么不能用」。 */
function describeSource(source: SourceStatus): string {
  if (!source.enabled) return source.needsCookie ? '未启用 · 需要登录' : '未启用';

  const now = Date.now();
  if (source.demotedUntil !== undefined && source.demotedUntil > now) {
    const seconds = Math.ceil((source.demotedUntil - now) / 1000);
    return `已临时降权 · ${seconds}s 后自动恢复`;
  }
  if (source.lastError) return `最近失败：${truncate(source.lastError, 40)}`;

  const parts: string[] = [];
  if (source.ok > 0) parts.push(`成功 ${source.ok} 次`);
  if (source.missed > 0) parts.push(`未匹配 ${source.missed} 次`);
  if (source.rejected > 0) parts.push(`有货但降级 ${source.rejected} 次`);
  if (source.lastOkAt !== undefined) parts.push(`上次成功 ${timeAgo(source.lastOkAt)}`);
  if (parts.length === 0) parts.push(source.needsCookie ? '还没用过 · 需要登录' : '还没用过');
  return parts.join(' · ');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}
