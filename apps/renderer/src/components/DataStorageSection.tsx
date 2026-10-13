import { useState, type ReactNode } from 'react';
import { Icon } from './Icons';
import { errorMessage } from '../bridge';
import { useClearCache, useDataStorage } from '../lib/queries';
import '../styles/data-storage.css';

/**
 * 本地数据存储位置与缓存（用户第五轮第 2 条）。
 *
 * 用户要的两件事：
 * ① 「本地数据存储位置（这个是关于听歌和使用缓存的）」—— 路径写在界面上，要能选中复制；
 * ② 「应用缓存大小和一键清理按键」—— 数字来自**真的去磁盘上算**（主进程 `data-store.ts`），
 *    不是一个估数；清理之后立刻用主进程回传的新占用刷新，用户能看见它真的变小了。
 *
 * ## 两类东西分开摆，这是刻意的
 *
 * - 上半「音乐数据」：歌单缓存 / 播放历史 / 设置 / 账号 / 下载目录 —— **只显示路径**，
 *   没有任何清理按钮。把这些混进「一键清理」等于删用户自己的东西，性质完全不同。
 * - 下半「可清理缓存」：网页缓存、音频与封面缓存、导入的歌词 —— 删了应用会自己重建。
 *
 * 「听歌缓存」这个说法用户用得很笼统，所以界面上把每一项**删了会怎样**都写在一行说明里，
 * 而不是只给一个笼统的「清理缓存」按钮。
 */

/** 字节 → 人能读的大小。1024 进制，保留一位小数（<1KB 给整数）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** 一行路径：标签 + 可复制的路径 + 说明。 */
function PathRow({
  label,
  path,
  hint,
}: {
  label: string;
  path: string;
  hint: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  return (
    <div className="pi-dstore__pathrow" data-dstore-path={label}>
      <span className="pi-dstore__pathmeta">
        <span className="pi-setting__title">{label}</span>
        <span className="pi-setting__hint">{hint}</span>
      </span>
      <span className="pi-dstore__pathline">
        {/* `readOnly` 的 input 而不是一段文字：这样路径能被选中、能被 Ctrl+C 复制，
            也不会像纯文本那样在窄窗口里把卡片撑破。 */}
        <input
          className="pi-input pi-dstore__path"
          type="text"
          readOnly
          value={path}
          spellCheck={false}
          aria-label={`${label}路径`}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="pi-btn pi-btn--ghost"
          data-dstore-copy={label}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(path)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              })
              .catch(() => setCopied(false));
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </span>
    </div>
  );
}

export function DataStorageSection(): ReactNode {
  const storage = useDataStorage();
  const clear = useClearCache();
  const [notice, setNotice] = useState<string | null>(null);

  const info = storage.data;

  return (
    <section className="pi-card pi-dstore" data-dstore="true">
      <div className="pi-sectionhead">
        <span className="pi-setting__title">
          <Icon name="database" size={14} /> 本地数据与缓存
        </span>
        <span className="pi-dstore__total" data-dstore-cache-total="true">
          {info ? `缓存占用 ${formatBytes(info.cacheBytes)}` : '正在统计…'}
        </span>
      </div>

      <p className="pi-setting__hint" style={{ marginTop: 0 }}>
        听歌数据与缓存都放在你的用户目录里，不会上传到任何地方
      </p>

      {storage.isPending ? (
        <div className="pi-placeholder">正在统计磁盘占用…</div>
      ) : !info ? (
        <div className="pi-placeholder">
          读取存储信息失败：{storage.error ? errorMessage(storage.error) : '未知原因'}
        </div>
      ) : (
        <>
          <div className="pi-dstore__paths" data-dstore-paths="true">
            <PathRow
              label="数据存储位置"
              path={info.dataDir}
              hint="曲库缓存、播放历史、设置与账号信息（听歌数据都在这里）"
            />
            <PathRow
              label="下载目录"
              path={info.downloadDir}
              hint="下载的歌曲文件（你自己的音乐，不会被下面的清理动到）"
            />
            {info.localLibraryDir.trim() === '' ? null : (
              <PathRow
                label="本地曲库"
                path={info.localLibraryDir}
                hint="本地兜底音源扫描的文件夹（只读文件名，不解析标签）"
              />
            )}
          </div>

          <div className="pi-dstore__groups" data-dstore-groups="true">
            {info.groups.map((group) => (
              <div className="pi-dstore__group" key={group.id} data-dstore-group={group.id}>
                <span className="pi-dstore__groupmeta">
                  <span className="pi-dstore__groupname">{group.label}</span>
                  <span className="pi-setting__hint">{group.effect}</span>
                </span>
                <span className="pi-dstore__bytes" data-dstore-group-bytes={group.id}>
                  {formatBytes(group.bytes)}
                </span>
              </div>
            ))}
          </div>

          <div className="pi-dstore__actions">
            <button
              type="button"
              className="pi-btn pi-btn--primary"
              data-dstore-clear="all"
              disabled={clear.isPending || info.cacheBytes <= 0}
              title="删掉网页缓存、音频与封面缓存、以及各源歌词缓存（你自己导入的歌词也会删掉）。下载好的歌曲文件不受影响。"
              onClick={() => {
                if (!window.confirm('清理全部缓存？你导入的歌词也会一起删掉，下载好的歌曲不受影响。')) {
                  return;
                }
                setNotice(null);
                clear.mutate(undefined, {
                  onSuccess: (result) => setNotice(`已释放 ${formatBytes(result.freedBytes)}`),
                });
              }}
            >
              <Icon name="refresh" size={13} /> {clear.isPending ? '正在清理…' : '一键清理缓存'}
            </button>
            <button
              type="button"
              className="pi-btn pi-btn--ghost"
              data-dstore-clear="web"
              disabled={clear.isPending}
              title="只清网页与界面缓存（脚本、样式、GPU 着色器）；歌词与音频缓存留着。"
              onClick={() => {
                setNotice(null);
                clear.mutate(['web'], {
                  onSuccess: (result) => setNotice(`已释放 ${formatBytes(result.freedBytes)}`),
                });
              }}
            >
              只清界面缓存
            </button>
            <button
              type="button"
              className="pi-btn pi-btn--ghost"
              data-dstore-refresh="true"
              disabled={storage.isFetching}
              onClick={() => {
                setNotice(null);
                void storage.refetch();
              }}
            >
              重新统计
            </button>
            {notice === null ? null : (
              <span className="pi-dstore__notice" data-dstore-notice="true">
                {notice}
              </span>
            )}
          </div>

          {clear.error ? (
            <p className="pi-dialog__error">清理失败：{errorMessage(clear.error)}</p>
          ) : null}

          <p className="pi-setting__hint" data-dstore-music-bytes="true">
            音乐数据（歌单缓存 / 播放历史 / 设置）约 {formatBytes(info.musicBytes)}，
            其中歌词约 {formatBytes(info.lyricsBytes)}；这些不参与清理。
          </p>
        </>
      )}
    </section>
  );
}
