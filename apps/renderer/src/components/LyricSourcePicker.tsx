import { useRef, useState, type ReactNode } from 'react';
import { LYRIC_SOURCE_INFO } from '@pi/ipc';
import type { LyricCandidateInfo, LyricSourceId, LyricSourceMode } from '@pi/shared';
import { Icon } from './Icons';
import {
  useImportLyric,
  useLyric,
  useLyricImports,
  usePatchSettings,
  useRemoveLyric,
  useSettings,
} from '../lib/queries';
import { usePlayer } from '../state/player';
import { errorMessage } from '../bridge';
import '../styles/lyric-sources.css';

/**
 * 歌词来源选择器（用户第五轮第 3 条：「歌词选择在快捷设置页和详细设置页都加上」）。
 *
 * 两个落点共用**同一个组件**，因为这一块的信息量确实不小，抄两份必然漂移：
 * - 详细设置页：完整形态（`variant="full"`），带每个源的能力标签与当前匹配情况；
 * - 快捷设置页：紧凑形态（`variant="compact"`），只留「当前源 + 一排图标键」，
 *   正合用户要求的「切换歌词源按键（按键显示图标别显示文字）」。
 *
 * ## 用户要的三个标签
 *
 * 「不同来源的歌词加上**是否含翻译**、**逐字**、**符合百分率**的标签」——
 * 三条都来自主进程那一跑的真实结果（`Lyric.candidates`），不是配置里写死的声称：
 * - 含翻译 = 这份歌词有没有 `translated` 行；
 * - 逐字 = 有没有 `words` 时间轴（流光的逐字点亮吃的就是它）；
 * - 符合率 = 歌名 / 歌手 / 时长三路加权算出来的匹配率（见主进程 `lyrics/match.ts`）。
 *
 * 还没跑过那一跑（没在放歌、或者这一趟还没回来）时，标签的位置显示「—」而不是
 * 「不支持」：前者是「不知道」，后者是「确定没有」，不能混。
 */
export interface LyricSourcePickerProps {
  /** `full` = 设置页那种带说明的竖排；`compact` = 快捷设置卡那种栅格。 */
  readonly variant: 'full' | 'compact';
}

/** 源的能力标签（含翻译 / 逐字 / 符合率）。 */
function SourceTags({ info }: { info: LyricCandidateInfo | undefined }): ReactNode {
  const tags: { key: string; label: string; on: boolean }[] = [
    { key: 'trans', label: '翻译', on: info?.hasTranslation === true },
    { key: 'word', label: '逐字', on: info?.hasWord === true },
  ];
  return (
    <span className="pi-lsrc__tags" data-lsrc-tags={info?.source ?? 'unknown'}>
      {tags.map((tag) => (
        <span
          key={tag.key}
          className="pi-lsrc__tag"
          data-lsrc-tag={tag.key}
          data-on={tag.on ? 'true' : 'false'}
        >
          {tag.label}
        </span>
      ))}
      <span
        className="pi-lsrc__tag pi-lsrc__tag--match"
        data-lsrc-tag="match"
        data-on={info !== undefined && info.match > 0 ? 'true' : 'false'}
      >
        {info === undefined || info.match <= 0 ? '符合率 —' : `符合率 ${Math.round(info.match * 100)}%`}
      </span>
    </span>
  );
}

/** 每个源在界面上的小图案：四枚用语义最近的既有图标，不新增图形。 */
const SOURCE_ICON: Record<LyricSourceId, 'music' | 'album' | 'waveform' | 'bars' | 'upload'> = {
  ncm: 'music',
  amll: 'album',
  qq: 'waveform',
  kugou: 'bars',
  local: 'upload',
};

/**
 * 导入当前这首歌的歌词文件。
 *
 * 文件选择用隐藏的 `<input type="file">`：Electron 的渲染进程有文件选择能力，
 * 而「导入链接」那条路刻意不做（和自定义源插件同一个理由——不能让界面变成任意地址抓取入口）。
 */
export function LyricImportButton({
  variant,
}: {
  readonly variant: 'full' | 'compact';
}): ReactNode {
  const song = usePlayer((state) => state.currentSong);
  const importLyric = useImportLyric();
  const inputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const disabled = song === null || importLyric.isPending;

  const onPick = (file: File): void => {
    // 进来之前先抓一份当前歌曲：`reader.onload` 是异步的，读盘期间用户可能已经切歌了。
    const target = song;
    if (target === null) return;
    const base64 = /\.krc$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const raw = reader.result;
      const content =
        typeof raw === 'string'
          ? base64
            ? // KRC 是二进制：`readAsText` 会把非 UTF-8 字节毁掉，所以走 dataURL 取 base64。
              (raw.split(',')[1] ?? '')
            : raw
          : '';
      if (content === '') {
        setNotice('这个文件读不出内容。');
        return;
      }
      setNotice(null);
      importLyric.mutate(
        { songId: target.id, fileName: file.name, content, base64 },
        {
          onSuccess: () => setNotice(`已导入「${file.name}」，这首歌现在用你导入的歌词。`),
        },
      );
    };
    reader.onerror = () => setNotice('文件读取失败。');
    if (base64) reader.readAsDataURL(file);
    else reader.readAsText(file, 'utf-8');
  };

  return (
    <>
      <button
        type="button"
        className={variant === 'compact' ? 'pi-lsrc__iconbtn' : 'pi-btn'}
        data-lyric-import="true"
        disabled={disabled}
        title={song === null ? '先在播放页放一首歌，再导入它的歌词' : '导入 .lrc / .ttml / .krc / .txt 歌词文件'}
        aria-label="导入歌词"
        onClick={() => inputRef.current?.click()}
      >
        <Icon name="upload" size={variant === 'compact' ? 16 : 13} />
        {variant === 'compact' ? null : '导入歌词'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".lrc,.yrc,.qrc,.ttml,.krc,.txt,text/plain"
        style={{ display: 'none' }}
        data-lyric-import-input="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onPick(file);
        }}
      />
      {notice === null ? null : <p className="pi-setting__hint pi-lsrc__notice">{notice}</p>}
      {importLyric.error ? (
        <p className="pi-dialog__error">导入失败：{errorMessage(importLyric.error)}</p>
      ) : null}
    </>
  );
}

export function LyricSourcePicker({ variant }: LyricSourcePickerProps): ReactNode {
  const settings = useSettings();
  const patch = usePatchSettings();
  const removeLyric = useRemoveLyric();
  const imports = useLyricImports();
  const song = usePlayer((state) => state.currentSong);
  const lyric = useLyric(song);
  /** 紧凑形态里「点图标再显示」的那个开关；详细形态永远展开。 */
  const [expanded, setExpanded] = useState(false);

  const value = settings.data;
  const mode: LyricSourceMode = value?.lyricSource ?? 'auto';
  const enabled = value?.lyricSourceEnabled;
  const candidates = lyric.data?.candidates ?? [];
  const infoOf = (id: LyricSourceId): LyricCandidateInfo | undefined =>
    candidates.find((entry) => entry.source === id);
  const usedSource = lyric.data?.source;

  const imported = imports.data?.songIds ?? [];
  const currentImported = song !== null && imported.includes(song.id);

  if (!value) return null;

  const choose = (next: LyricSourceMode): void => {
    if (next === mode) return;
    patch.mutate({ lyricSource: next });
    // 钉死某一个源之后就把列表收起来：这一步动作已经完成，界面该回到那一行图标。
    if (variant === 'compact') setExpanded(false);
  };

  const currentLabel =
    usedSource !== undefined
      ? (LYRIC_SOURCE_INFO.find((entry) => entry.id === usedSource)?.label ?? usedSource)
      : mode === 'auto'
        ? '自动匹配'
        : (LYRIC_SOURCE_INFO.find((entry) => entry.id === mode)?.label ?? mode);
  const currentInfo = usedSource === undefined ? undefined : infoOf(usedSource);

  /*
   * 紧凑形态（快捷设置卡，用户第五轮第 4 条）：
   * 「几个歌词源整合起来，点击一个图标再显示；本地导入也改成一个图标」——
   * 所以这里平时**只有一行图标 + 当前源名字 + 三个标签**，点图标才把源列表展开。
   * 详细设置页仍然用展开式（那里地方够，一眼看全更省事）。
   */
  if (variant === 'compact') {
    return (
      <div className="pi-lsrc" data-lsrc="compact" data-lsrc-expanded={expanded ? 'true' : 'false'}>
        <div className="pi-lsrc__compactbar">
          <button
            type="button"
            className="pi-lsrc__iconbtn pi-lsrc__iconbtn--source"
            data-lsrc-toggle="source"
            aria-expanded={expanded}
            title={expanded ? '收起歌词源' : '切换歌词源（点开选择）'}
            aria-label={expanded ? '收起歌词源' : '切换歌词源'}
            disabled={patch.isPending}
            onClick={() => setExpanded((open) => !open)}
          >
            <Icon
              name={
                mode === 'auto'
                  ? 'refresh'
                  : (SOURCE_ICON[mode as LyricSourceId] ?? 'waveform')
              }
              size={16}
            />
          </button>
          {/*
            用户第五轮第 7 条：「红框所在大致位置就是一个按键可以点击进入歌词源选择页」。
            红框圈的是这一整条（名字 + 三个标签），所以它就是那颗键 ——
            点它和点左边那颗图标键是同一个动作（展开/收起源列表）。
          */}
          <button
            type="button"
            className="pi-lsrc__mainbtn"
            data-lsrc-toggle="main"
            aria-expanded={expanded}
            title="点这里选择歌词源"
            disabled={patch.isPending}
            onClick={() => setExpanded((open) => !open)}
          >
            <span className="pi-lsrc__current-name" data-lsrc-current={usedSource ?? mode}>
              {currentLabel}
            </span>
            <SourceTags info={currentInfo} />
          </button>
          {/* 本地导入：同样收成一颗图标（用户第五轮第 4 条）。 */}
          <LyricImportButton variant="compact" />
          {currentImported ? (
            <button
              type="button"
              className="pi-lsrc__iconbtn pi-lsrc__iconbtn--danger"
              data-lyric-remove="true"
              disabled={removeLyric.isPending}
              title="删掉这首歌导入的歌词"
              aria-label="删掉导入的歌词"
              onClick={() => {
                if (song === null) return;
                if (!window.confirm('删掉这首歌导入的歌词？之后会回到自动匹配。')) return;
                removeLyric.mutate(song.id);
              }}
            >
              <Icon name="close" size={15} />
            </button>
          ) : null}
        </div>

        {expanded ? (
          <div className="pi-lsrc__picker" data-lsrc-list="true" role="radiogroup" aria-label="歌词来源">
            <button
              type="button"
              className="pi-lsrc__row pi-lsrc__row--auto"
              data-lsrc-option="auto"
              data-active={mode === 'auto'}
              role="radio"
              aria-checked={mode === 'auto'}
              disabled={patch.isPending}
              onClick={() => choose('auto')}
            >
              <span className="pi-lsrc__icon" aria-hidden="true">
                <Icon name="refresh" size={15} />
              </span>
              <span className="pi-lsrc__meta">
                <span className="pi-lsrc__name">自动匹配</span>
              </span>
              <SourceTags info={currentInfo} />
            </button>
            {LYRIC_SOURCE_INFO.map((entry) => {
              const info = infoOf(entry.id);
              const on = enabled?.[entry.id] !== false;
              return (
                <div
                  key={entry.id}
                  className="pi-lsrc__row"
                  data-lsrc-option={entry.id}
                  data-active={mode === entry.id}
                  data-lsrc-enabled-state={on ? 'on' : 'off'}
                >
                  <button
                    type="button"
                    className="pi-lsrc__pick"
                    role="radio"
                    aria-checked={mode === entry.id}
                    aria-label={`使用 ${entry.label}`}
                    disabled={patch.isPending}
                    onClick={() => choose(entry.id)}
                  >
                    <span className="pi-lsrc__icon" aria-hidden="true">
                      <Icon name={SOURCE_ICON[entry.id]} size={15} />
                    </span>
                    <span className="pi-lsrc__meta">
                      <span className="pi-lsrc__name">{entry.label}</span>
                    </span>
                    <SourceTags info={info} />
                  </button>
                  {/* 关掉的源不参与自动匹配 —— 同一个开关在详细设置页也能改。 */}
                  <input
                    type="checkbox"
                    className="pi-check"
                    data-lsrc-enabled={entry.id}
                    aria-label={`自动匹配时使用 ${entry.label}`}
                    checked={on}
                    disabled={patch.isPending}
                    onChange={(event) =>
                      patch.mutate({
                        lyricSourceEnabled: {
                          ncm: enabled?.ncm !== false,
                          amll: enabled?.amll !== false,
                          qq: enabled?.qq !== false,
                          kugou: enabled?.kugou !== false,
                          local: enabled?.local !== false,
                          [entry.id]: event.target.checked,
                        },
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="pi-lsrc" data-lsrc={variant}>
      <div className="pi-lsrc__head">
        <span className="pi-setting__title" title="自动匹配会同时问所有开启的源，按匹配率挑最合适的一份；钉死某一个源时永远用它的歌词。">
          歌词来源
        </span>
        <span className="pi-lsrc__current" data-lsrc-current={usedSource ?? 'none'}>
          {usedSource === undefined
            ? mode === 'auto'
              ? '自动匹配 · 暂无结果'
              : '这一首没有歌词'
            : `当前：${LYRIC_SOURCE_INFO.find((entry) => entry.id === usedSource)?.label ?? usedSource}`}
        </span>
      </div>

      {/*
        源列表。`auto` 单独一颗在最前面（它不是一个源，是一种策略），
        所以它的标签区显示的是「挑中的那一份」的三个标签。
      */}
      <div className="pi-lsrc__list" data-lsrc-list="true" role="radiogroup" aria-label="歌词来源">
        <button
          type="button"
          className="pi-lsrc__row pi-lsrc__row--auto"
          data-lsrc-option="auto"
          data-active={mode === 'auto'}
          aria-checked={mode === 'auto'}
          role="radio"
          disabled={patch.isPending}
          onClick={() => choose('auto')}
        >
          <span className="pi-lsrc__icon" aria-hidden="true">
            <Icon name="refresh" size={16} />
          </span>
          <span className="pi-lsrc__meta">
            <span className="pi-lsrc__name">自动匹配</span>
            <span className="pi-lsrc__note">同时问所有开启的源，挑匹配率最高的那一份</span>
          </span>
          <SourceTags info={usedSource === undefined ? undefined : infoOf(usedSource)} />
        </button>

        {LYRIC_SOURCE_INFO.map((entry) => {
          const info = infoOf(entry.id);
          const on = enabled?.[entry.id] !== false;
          return (
            <div
              key={entry.id}
              className="pi-lsrc__row"
              data-lsrc-option={entry.id}
              data-active={mode === entry.id}
              data-lsrc-used={usedSource === entry.id ? 'true' : 'false'}
            >
              <button
                type="button"
                className="pi-lsrc__pick"
                role="radio"
                aria-checked={mode === entry.id}
                aria-label={`使用 ${entry.label}`}
                disabled={patch.isPending}
                onClick={() => choose(entry.id)}
              >
                <span className="pi-lsrc__icon" aria-hidden="true">
                  <Icon name={SOURCE_ICON[entry.id]} size={16} />
                </span>
                <span className="pi-lsrc__meta">
                  <span className="pi-lsrc__name">{entry.label}</span>
                  <span className="pi-lsrc__note">{info?.reason ?? entry.note}</span>
                </span>
                <SourceTags info={info} />
              </button>
              {/* 「自动匹配时要问这个源吗」是一个**独立**于「现在用哪个」的开关，
                  所以它有自己的勾选框，而不是跟选中态绑在一起。 */}
              <input
                type="checkbox"
                className="pi-check"
                data-lsrc-enabled={entry.id}
                aria-label={`自动匹配时使用 ${entry.label}`}
                checked={on}
                disabled={patch.isPending}
                onChange={(event) =>
                  patch.mutate({
                    lyricSourceEnabled: {
                      ncm: enabled?.ncm !== false,
                      amll: enabled?.amll !== false,
                      qq: enabled?.qq !== false,
                      kugou: enabled?.kugou !== false,
                      local: enabled?.local !== false,
                      [entry.id]: event.target.checked,
                    },
                  })
                }
              />
            </div>
          );
        })}
      </div>

      <div className="pi-lsrc__actions">
        <LyricImportButton variant={variant} />
        {currentImported ? (
          <button
            type="button"
            className="pi-btn pi-btn--ghost"
            data-lyric-remove="true"
            disabled={removeLyric.isPending}
            onClick={() => {
              if (!window.confirm('删掉这首歌导入的歌词？之后会回到自动匹配。')) return;
              removeLyric.mutate(song.id);
            }}
          >
            删除导入
          </button>
        ) : null}
        <span className="pi-setting__hint pi-lsrc__count">
          已导入 {imported.length} 首
        </span>
      </div>

      {variant === 'full' ? (
        <div className="pi-setting pi-lsrc__threshold">
          <span>
            <span
              className="pi-setting__title"
              title="自动匹配时低于这一档的候选直接丢弃。定得高一点更保守——错歌词比没歌词更糟；定得低一点更容易匹配上，但可能撞到别的版本。"
            >
              匹配率门槛
            </span>
            <span className="pi-setting__hint">
              当前 {Math.round((value.lyricMinMatch ?? 0.62) * 100)}% · 低于它宁可不显示
            </span>
          </span>
          <input
            className="pi-range"
            type="range"
            data-lyric-tuning="lyricMinMatch"
            min={0.3}
            max={0.95}
            step={0.01}
            value={value.lyricMinMatch ?? 0.62}
            aria-label="歌词匹配率门槛"
            onChange={(event) =>
              patch.mutate({ lyricMinMatch: Number(event.target.value) })
            }
          />
        </div>
      ) : null}
    </div>
  );
}
