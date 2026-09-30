/**
 * 「我的下载」（M5 的渲染层那一半）。
 *
 * 主进程侧的下载队列已经完工（`apps/desktop/src/main/downloads.ts`），这里只做三件事：
 * ① 把整份 `DownloadTask[]` 画出来（封面/歌名/歌手/专辑/音质/字节/状态/错误/进度）；
 * ② 按状态给出可用的动作（暂停/继续/重试/播放/移除），动作全部走 `lib/queries.ts` 的
 *    mutation —— 成功后的整份列表由主进程返回，界面不自己拼状态；
 * ③ 把「离线也能播」这件事显式说出来：`done` 的行有「本地」标记，点播放走 App 现有的
 *    播放路径（`state/player.ts` 的 `play`），由主进程的 `resolveForPlayback` 命中本地文件。
 *
 * 为什么进度条不自己算一个「看起来在动」的假进度：主进程推来的 `receivedBytes` 是磁盘上
 * 真实写好的字节数（见 `DownloadTask` 的注释），拿不到 `content-length` 时总量为 0，
 * 那时只能走不确定态动画 —— 编一个百分比就是在骗用户。
 */
import type { ReactNode } from 'react';
import type { DownloadStatus, DownloadTask } from '@pi/ipc';
import { QUALITY_LABEL, type Song } from '@pi/shared';
import { errorMessage } from '../bridge';
import { coverAt } from '../lib/cover';
import {
  useAddDownload,
  useDownloads,
  useLocalLibrary,
  usePauseDownload,
  useRemoveDownload,
  useResumeDownload,
  useRetryDownload,
  useSettings,
} from '../lib/queries';
import { usePlayer } from '../state/player';
import { Icon } from './Icons';

/** 状态 → 界面文案。`missing` 要让人一眼看懂「文件没了」，不是「下载失败」。 */
const STATUS_TEXT: Readonly<Record<DownloadStatus, string>> = {
  queued: '排队中',
  downloading: '下载中',
  paused: '已暂停',
  done: '已完成',
  error: '失败',
  missing: '文件缺失',
};

/**
 * 字节数转人读文本（`12.3MB`）。
 *
 * 非有限值 / 负数一律按 0 处理：进度那条路上一旦漏出 `NaN`，宽度就会变成
 * `NaN%`（CSS 直接忽略），界面看起来像「进度条不见了」，而日志里什么都没有。
 */
export function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe === 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = safe;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 字节位不带小数，更大单位保留一位（`12.3MB / 45.6MB`）。
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text}${units[unit] ?? ''}`;
}

/** 进度百分比；总量未知（`totalBytes === 0`）时返回 0 —— 那条路走不确定态动画。 */
export function progressPercent(task: Pick<DownloadTask, 'receivedBytes' | 'totalBytes'>): number {
  const total = Number.isFinite(task.totalBytes) ? task.totalBytes : 0;
  const received = Number.isFinite(task.receivedBytes) ? Math.max(0, task.receivedBytes) : 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (received / total) * 100));
}

/**
 * 把一条下载记录还原成播放用的 `Song`。
 *
 * 只填播放必需的东西：主进程 `resolveForPlayback` 靠 `song.id` 就能找到本地那份文件
 *（离线优先，见 `services.ts:836-845`），所以这里不需要（也拿不到）上游地址。
 * 歌手在主进程已经拍平成 `A、B` 一个字符串了，这里包成单元素数组照原样显示。
 */
function songFromTask(task: DownloadTask): Song {
  return {
    id: task.songId,
    name: task.name,
    artists: task.artists ? [{ id: 0, name: task.artists }] : [],
    album: { id: 0, name: task.album, coverUrl: task.coverUrl },
  };
}

interface DownloadRowProps {
  task: DownloadTask;
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onRemove: () => void;
}

function DownloadRow({
  task,
  onPlay,
  onPause,
  onResume,
  onRetry,
  onRemove,
}: DownloadRowProps): ReactNode {
  const total = Number.isFinite(task.totalBytes) ? task.totalBytes : 0;
  const received = Number.isFinite(task.receivedBytes) ? Math.max(0, task.receivedBytes) : 0;
  const known = total > 0;
  const percent = progressPercent(task);
  const cover = coverAt(task.coverUrl, 120);

  const busy = task.status === 'queued' || task.status === 'downloading';
  const failed = task.status === 'error' || task.status === 'missing';
  const finished = task.status === 'done';

  const bytesText = known
    ? `${formatBytes(received)} / ${formatBytes(total)}`
    : `${formatBytes(received)} · 大小未知`;

  return (
    <li className="pi-dl__item">
      <div
        className="pi-dl__row"
        data-download-row="true"
        data-download-id={task.id}
        data-download-status={task.status}
        data-download-received={String(received)}
        data-download-total={String(total)}
        data-download-quality={task.quality}
        data-download-file={task.filePath || ''}
      >
        <span className="pi-dl__cover">
          {cover ? (
            <img src={cover} alt="" loading="lazy" />
          ) : (
            <span className="pi-dl__cover-empty">
              <Icon name="music" size={16} />
            </span>
          )}
        </span>

        <span className="pi-dl__main">
          <span className="pi-dl__name" title={task.name}>
            {task.name}
          </span>
          <span className="pi-dl__sub">
            {[task.artists, task.album].filter((part) => part !== '').join(' · ') || '未知歌手'}
          </span>
        </span>

        <span className="pi-dl__quality" title="这一份实际下载的档位">
          {task.qualityLabel ?? QUALITY_LABEL[task.quality]}
        </span>

        <span className="pi-dl__bytes">{bytesText}</span>

        <span className="pi-dl__status" data-download-status-text={task.status}>
          {STATUS_TEXT[task.status]}
        </span>

        {/* 「离线也能播」的显式标记：下完的文件不受断网 / 会员到期影响。 */}
        {finished ? (
          <span className="pi-dl__local" data-download-local="true" title="文件已在本机，断网也能播">
            本地
          </span>
        ) : null}

        <span className="pi-dl__actions">
          {busy ? (
            <button
              type="button"
              className="pi-dl__btn"
              data-download-pause="true"
              onClick={onPause}
              title="暂停这个任务"
            >
              <Icon name="pause" size={12} />
              <span>暂停</span>
            </button>
          ) : null}
          {task.status === 'paused' ? (
            <button
              type="button"
              className="pi-dl__btn"
              data-download-resume="true"
              onClick={onResume}
              title="从已下载的字节继续"
            >
              <Icon name="play" size={12} />
              <span>继续</span>
            </button>
          ) : null}
          {failed ? (
            <button
              type="button"
              className="pi-dl__btn"
              data-download-retry="true"
              onClick={onRetry}
              title="重新下载这一首"
            >
              <Icon name="refresh" size={12} />
              <span>重试</span>
            </button>
          ) : null}
          {finished ? (
            <button
              type="button"
              className="pi-dl__btn pi-dl__btn--play"
              data-download-play="true"
              onClick={onPlay}
              title="播放这首（走 App 的播放路径，命中本地文件）"
            >
              <Icon name="play" size={12} />
              <span>播放</span>
            </button>
          ) : null}
          <button
            type="button"
            className="pi-dl__btn pi-dl__btn--danger"
            data-download-remove="true"
            onClick={onRemove}
            title={finished ? '删除这条记录，并删掉磁盘上的文件' : '删除这条下载记录（磁盘上的临时文件一并清掉）'}
          >
            <Icon name="close" size={12} />
            <span>移除</span>
          </button>
        </span>

        <span className="pi-dl__track">
          <span
            className="pi-dl__progress"
            data-download-progress="true"
            /* 总量未知时宽度是 0，靠 `data-download-indeterminate` 走扫描动画；
               宽度永远是个有限数字，不会是 NaN。 */
            data-download-indeterminate={known ? undefined : 'true'}
            style={{ width: `${percent}%` }}
          />
        </span>

        {task.error ? (
          <span className="pi-dl__error" data-download-error="true">
            {task.error}
          </span>
        ) : null}

        {task.status === 'missing' ? (
          <span className="pi-dl__warn" data-download-missing="true">
            文件不在了：本地文件已被删除或移动，本地播放不了。点「重试」重新下载，或「移除」这条记录。
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * 下载页整块内容（含工具栏、空态、列表、失败提示）。
 *
 * 根节点带 `data-downloads-page` / `data-download-count` / `data-download-done`，
 * 桌面冒烟探针靠这三个抓手判断「这一页是不是真有内容」，所以它们在**任何**状态下都在。
 */
export function DownloadList(): ReactNode {
  const downloads = useDownloads();
  const settings = useSettings();
  const currentSong = usePlayer((state) => state.currentSong);
  const play = usePlayer((state) => state.play);

  const add = useAddDownload();
  const pause = usePauseDownload();
  const resume = useResumeDownload();
  const retry = useRetryDownload();
  const remove = useRemoveDownload();

  const tasks = downloads.data ?? [];
  const doneCount = tasks.filter((task) => task.status === 'done').length;

  /** 会用哪档音质：设置还没到手就什么都不写，不编一个假档位上去。 */
  const preferred = settings.data?.preferredQuality;
  const qualityHint = preferred ? QUALITY_LABEL[preferred] : undefined;

  /**
   * 五个动作里最近一次失败。React Query 在重新发起时会自己把 `error` 清掉，
   * 所以这里不需要额外的 state；重点是**不静默吞**——失败一定在页面上有字。
   */
  const failure = add.error ?? pause.error ?? resume.error ?? retry.error ?? remove.error;

  return (
    <div
      className="pi-dl"
      data-downloads-page="true"
      data-download-count={tasks.length}
      data-download-done={doneCount}
    >
      <div className="pi-dl__bar">
        <button
          type="button"
          className="pi-btn pi-btn--small pi-dl__add"
          data-download-add-current="true"
          /* 没有正在播放的歌就没得下（不是「随便下一首」）。 */
          disabled={!currentSong}
          title={
            currentSong
              ? `把《${currentSong.name}》下载到本地${qualityHint ? `（${qualityHint}）` : ''}`
              : '还没有正在播放的歌曲'
          }
          onClick={() => {
            // 双击不会再入队一条：主进程允许同一首歌有多条记录，但用户不是这个意思。
            if (!currentSong || add.isPending) return;
            add.mutate({ song: currentSong });
          }}
        >
          <Icon name="download" size={14} />
          <span>下载当前播放的歌曲</span>
          {qualityHint ? (
            <span className="pi-dl__quality-hint" data-download-quality-hint="true">
              {qualityHint}
            </span>
          ) : null}
        </button>
        <span className="pi-dl__summary">
          共 {tasks.length} 首，已完成 {doneCount} 首
        </span>
      </div>

      {failure ? (
        <p className="pi-dl__failure" data-download-error="true">
          操作失败：{errorMessage(failure)}
        </p>
      ) : null}

      {downloads.isPending ? (
        <div className="pi-placeholder">正在读取下载列表…</div>
      ) : downloads.error ? (
        <div className="pi-card pi-placeholder">
          <strong>下载列表读取失败</strong>
          <span>{errorMessage(downloads.error)}</span>
        </div>
      ) : tasks.length === 0 ? (
        <div className="pi-card pi-placeholder pi-dl__empty" data-downloads-empty="true">
          <strong>还没有下载的歌曲</strong>
          <span>播放一首歌后点上面的「下载当前播放的歌曲」，下好的歌会出现在这里，断网也能播。</span>
        </div>
      ) : (
        <ul className="pi-dl__list" data-download-list="true">
          {tasks.map((task) => (
            <DownloadRow
              key={task.id}
              task={task}
              onPlay={() => {
                // 走 App 现有的播放路径：把这一首放上队列并解析。
                // 主进程 `resolveForPlayback` 会优先命中本地文件（离线优先），
                // 这里**不**碰 `<audio>`，也不自己拼本地地址。
                void play([songFromTask(task)]);
              }}
              onPause={() => pause.mutate(task.id)}
              onResume={() => resume.mutate(task.id)}
              onRetry={() => retry.mutate(task.id)}
              onRemove={() =>
                // 界面口径：下好的行连文件一起删（用户说「移除」时想清掉磁盘占用）；
                // 没下完的行只删记录，主进程会顺手清掉 `.part`。
                remove.mutate({ id: task.id, deleteFile: task.status === 'done' })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 「本地库」区块（M5 的只读清单，用户 m02213 第 3 条后半）。
 *
 * 与上面的下载队列是**两回事**：下载队列是我们自己拉下来的任务（带状态、可暂停），
 * 本地库是磁盘上那个目录里扫出来的音频文件（只读，主进程只按文件名猜 `title`/`artists`）。
 *
 * 所以这里刻意**不**显示专辑与时长：主进程不解析音频标签，`albumName` / `durationMs`
 * 永远是缺省值，画个空白占位出来就是在暗示「有这回事只是还没加载完」——缺就什么都不画。
 *
 * 为什么这个组件跟 `DownloadList` 挤在同一个文件里：这一轮的文件白名单只给了
 * `components/DownloadList.tsx`，新增文件越界，所以同页的两块放一起。两块各有自己的
 * 根节点与抓手，互不影响。
 */
export function LocalLibrarySection(): ReactNode {
  const library = useLocalLibrary();
  const tracks = library.data?.tracks ?? [];
  const dir = library.data?.dir ?? '';

  return (
    <section className="pi-lib" data-library-section="true" data-library-count={tracks.length}>
      <div className="pi-lib__bar">
        <h2 className="pi-lib__title">本地库</h2>
        <button
          type="button"
          className="pi-btn pi-btn--small pi-lib__rescan"
          data-library-rescan="true"
          /* 重新扫一遍目录：`refetch()` 会再 invoke 一次并覆盖缓存（不清空旧清单，
             扫描期间还看得见上一次的结果，不会闪成空态）。 */
          onClick={() => void library.refetch()}
          disabled={library.isFetching}
          title="重新扫描本地库目录"
        >
          <Icon name="refresh" size={14} />
          <span>{library.isFetching ? '扫描中…' : '重新扫描'}</span>
        </button>
      </div>

      <p className="pi-lib__dir" data-library-dir="true" title={dir}>
        {dir || '未设置本地库目录'}
      </p>

      {library.isPending ? (
        <div className="pi-placeholder">正在扫描本地库…</div>
      ) : library.error ? (
        <div className="pi-card pi-placeholder">
          <strong>本地库读取失败</strong>
          <span>{errorMessage(library.error)}</span>
        </div>
      ) : tracks.length === 0 ? (
        <div className="pi-card pi-placeholder pi-lib__empty" data-library-empty="true">
          <strong>这个目录里还没有音频</strong>
          <span>
            {dir
              ? '把音频文件放进上面这个目录，再点「重新扫描」。'
              : '先在设置里指定本地库目录，再点「重新扫描」。'}
          </span>
        </div>
      ) : (
        <ul className="pi-lib__list" data-library-list="true">
          {tracks.map((track) => (
            <li
              className="pi-lib__row"
              key={track.id}
              data-library-row="true"
              data-library-path={track.path}
              data-library-title={track.title}
              /* 多歌手用 `/` 连接（抓手口径），界面上也照这个显示，两边一致。 */
              data-library-artists={track.artists.join('/')}
              data-library-ext={track.ext}
              data-library-size={String(track.sizeBytes ?? 0)}
            >
              <span className="pi-lib__name" title={track.path}>
                {track.title}
              </span>
              <span className="pi-lib__artists">{track.artists.join(' / ') || '未知歌手'}</span>
              <span className="pi-lib__ext" title="文件后缀">
                {track.ext}
              </span>
              <span className="pi-lib__size">{formatBytes(track.sizeBytes ?? 0)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
