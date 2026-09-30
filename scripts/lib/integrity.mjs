/**
 * Windows 强制完整性标签（Mandatory Integrity Label）小工具。
 *
 * 为什么需要它：Windows 进程的完整性级别不是由「谁启动它」决定，而是由**可执行文件自身的
 * 标签**决定。带 `Low Mandatory Level` 标签的 exe，双击后就是一个 Low 完整性进程 ——
 * 它能写同目录以及继承 Low 的位置，但写不了 Medium 对象（`%LOCALAPPDATA%`、`%TEMP%`、
 * HKCU 都是 Medium），于是安装器一建目录就报「对路径 … 的访问被拒绝」。
 *
 * 这个标签是怎么来的：构建产物所在的目录树本身带着 `Low (OI)(CI)(NW)`（某些同步盘 /
 * 沙箱 / 解压出来的工作区会这样），树里新建的文件会**继承**它。所以发出去的 exe 必须显式
 * 把标签改回 Medium —— 这一步同时修掉两件事：
 *   ① 安装器装不上（建不了 `%LOCALAPPDATA%\Programs\PI`）；
 *   ② 当初 NSIS 报的 `Error writing temporary file. Make sure your temp folder is valid.`
 *      （NSIS 安装时要往 `%TEMP%` 写）。
 *
 * 只用系统自带的 `icacls`，不需要管理员权限（用户对自己的文件有 WRITE_OWNER 就能改标签）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const IS_WINDOWS = process.platform === 'win32';

/* icacls 打印的是「Medium Mandatory Level」（中文系统上可能是「中等强制级别」），
   这里归一成级别词本身 —— 否则 `=== 'Medium'` 这种比较永远不成立（踩过一次）。 */
const LEVEL_WORDS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  system: 'System',
  低: 'Low',
  中: 'Medium',
  中等: 'Medium',
  高: 'High',
  系统: 'System',
};

function normalizeLevel(raw) {
  const text = String(raw ?? '').trim();
  const word = text.split(/\s+/)[0] ?? '';
  return LEVEL_WORDS[word.toLowerCase()] ?? text;
}

/** 读一个文件当前的强制完整性标签；没有标签行时返回 'Medium'（Windows 的默认级别）。 */
export function readIntegrityLabel(file) {
  if (!IS_WINDOWS || !existsSync(file)) return null;
  const result = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const match = /(?:Mandatory Label|强制标签)\\([^:\r\n]+)/.exec(text);
  return match ? normalizeLevel(match[1]) : 'Medium';
}

/** 把文件的强制完整性标签设成 Medium；失败不抛异常，只回报结果。 */
export function ensureMediumIntegrity(file, log = () => {}) {
  if (!IS_WINDOWS) {
    log('非 Windows：跳过完整性标签检查');
    return { ok: true, skipped: true, label: null };
  }
  const before = readIntegrityLabel(file);
  if (before === 'Medium') {
    log('已经是 Medium，无需修改');
    return { ok: true, label: 'Medium', changed: false };
  }
  const result = spawnSync('icacls', [file, '/setintegritylevel', 'Medium'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const after = readIntegrityLabel(file);
  const ok = after === 'Medium';
  log(
    `${before ?? '未知'} → ${after ?? '未知'}` +
      (ok
        ? '（已修正：双击后就是普通用户权限，能写 %LOCALAPPDATA%）'
        : `（icacls 退出码 ${result.status}，没改成功）`),
  );
  return { ok, label: after, changed: true, status: result.status };
}
