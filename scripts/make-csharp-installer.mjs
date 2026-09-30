#!/usr/bin/env node
/*
 * 编出自解压安装包 `release\PI-Setup-<版本>.exe`（C# 版，替代 NSIS）。
 *
 * 为什么换掉 NSIS：见 scripts/pi-app.cs 顶部与 docs/PLAN.md §4.34 —— 用户机器上任何
 * NSIS 安装器都会在 .onInit 之前弹「Error writing temporary file. Make sure your temp
 * folder is valid.」，而我们的包既不是整块压缩也没有插件（不该走那两条路），本机又
 * 复现不了。现在改成：载荷以 deflate 流追加在 exe 尾部，安装时从自身文件流式解压，
 * 结构上不可能写 %TEMP%。
 *
 * 步骤：
 *   1. 用 .NET Framework 自带的 csc.exe 编三个产物：
 *        PI-Setup-gui.exe      图形界面安装器（不带载荷，会被当 base 打包）
 *        卸载 PI.exe            卸载器（UNINSTALLER_MODE）
 *        pi-setup-console.exe  控制台版，用于 --pack 打包与 --silent 自检
 *   2. patch-exe.mjs 给前两个写 PE 图标 + 版本信息（和便携版 pi.exe 同一套图标）。
 *   3. 控制台版 --pack：把 release\pi 整个目录 + 卸载器追到 gui base 后面。
 *   4. 自检：读打包报告核对条目数；回读成品 exe 的 PE 资源。
 *
 * 用法：node scripts/make-csharp-installer.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp', 'cs');
const RELEASE = path.join(ROOT, 'release');
const PAYLOAD = path.join(RELEASE, 'pi');
const ICON = path.join(ROOT, 'build', 'pi-embed.ico');
const SRC = path.join(ROOT, 'scripts', 'pi-app.cs');
import { ensureMediumIntegrity } from './lib/integrity.mjs';

const PATCH = path.join(ROOT, 'scripts', 'patch-exe.mjs');
const PROBE_DIR = path.join(ROOT, '.tmp', 'nsis-probes');

const WINDIR = process.env.WINDIR || 'C:\\Windows';
const FW64 = path.join(WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const FW32 = path.join(WINDIR, 'Microsoft.NET', 'Framework', 'v4.0.30319');
const CSHARP = '© 2026 PI';

const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = rootPkg.version;

const GUI_EXE = path.join(TMP, 'PI-Setup-gui.exe');
const UNINST_EXE = path.join(TMP, '卸载 PI.exe');
const CONSOLE_EXE = path.join(TMP, 'pi-setup-console.exe');
const REPORT = path.join(TMP, 'pack-report.txt');
const OUT_EXE = path.join(RELEASE, `PI-Setup-${VERSION}.exe`);

function log(...args) {
  console.log(...args);
}

function fail(msg) {
  console.error(`\n[setup] 失败：${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.error) fail(`${cmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) fail(`${path.basename(cmd)} 退出码 ${r.status}`);
  return r;
}

function findCsc() {
  for (const dir of [FW64, FW32]) {
    const exe = path.join(dir, 'csc.exe');
    if (existsSync(exe)) return exe;
  }
  fail('找不到 csc.exe（需要 .NET Framework 4.x）');
}

function countTree(dir) {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        dirs++;
        walk(p);
      } else {
        files++;
        bytes += statSync(p).size;
      }
    }
  };
  walk(dir);
  return { files, dirs, bytes };
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

/* ------------------------------------------------------------------ 开始 */

const csc = findCsc();
log(`[setup] csc：${csc}`);
log(`[setup] 版本：${VERSION}`);

if (!existsSync(PAYLOAD)) fail(`载荷目录不存在：${PAYLOAD}（先跑 pnpm dist）`);
if (!existsSync(ICON)) fail(`图标不存在：${ICON}（先跑 pnpm icon）`);

/* 清理上一次的产物。本机沙箱下整目录 rmSync 可能直接拿到 EPERM（目录里还有残留
   句柄/子目录），所以退化成逐个删；删不掉也不要紧 —— 后面每一步都是按路径覆盖写。 */
try {
  rmSync(TMP, { recursive: true, force: true });
} catch (err) {
  log(`[setup] 整目录清理被拒（${err.code || err.message}），改为逐个删除`);
  for (const f of readdirSync(TMP)) {
    try { rmSync(path.join(TMP, f), { recursive: true, force: true }); } catch {}
  }
}
mkdirSync(TMP, { recursive: true });

/* 把 NSIS 时代的探针从 release 挪走，保证 release 里只有真正的安装包 */
if (existsSync(RELEASE)) {
  for (const f of readdirSync(RELEASE)) {
    if (/^NSISprobe-.*\.exe$/i.test(f)) {
      mkdirSync(PROBE_DIR, { recursive: true });
      renameSync(path.join(RELEASE, f), path.join(PROBE_DIR, f));
      log(`[setup] 把探针挪到 .tmp/nsis-probes：${f}`);
    }
  }
}

const refs = [
  'System.dll',
  'System.Core.dll',
  'System.Drawing.dll',
  'System.Windows.Forms.dll',
  'System.IO.Compression.dll',
  'System.IO.Compression.FileSystem.dll',
].flatMap((f) => ['/r:' + f]);

function compile(outExe, target, extra = []) {
  const args = [
    '/nologo',
    '/optimize+',
    `/target:${target}`,
    ...refs,
    ...extra,
    `/out:${outExe}`,
    SRC,
  ];
  log(`\n[setup] 编译 ${path.basename(outExe)} …`);
  run(csc, args);
  const size = statSync(outExe).size;
  log(`[setup]   → ${path.basename(outExe)}  ${size.toLocaleString('en-US')} 字节`);
  return outExe;
}

compile(GUI_EXE, 'winexe');
compile(UNINST_EXE, 'winexe', ['/define:UNINSTALLER_MODE']);
compile(CONSOLE_EXE, 'exe');

/* 图标 + 版本信息（和便携版 pi.exe 用同一套） */
log('\n[setup] 写 PE 图标与版本信息 …');
run(process.execPath, [
  PATCH, GUI_EXE,
  '--ico', ICON,
  '--product', 'PI',
  '--desc', 'PI 安装程序',
  '--company', 'PI',
  '--version', VERSION,
  '--copyright', CSHARP,
  '--quiet',
]);
run(process.execPath, [
  PATCH, UNINST_EXE,
  '--ico', ICON,
  '--product', 'PI',
  '--desc', 'PI 卸载程序',
  '--company', 'PI',
  '--version', VERSION,
  '--copyright', CSHARP,
  '--quiet',
]);

/* 打包：把 release\pi 与卸载器追到 gui base 后面。
   注意一个自己踩出来的坑：上一次的成品已经被打上 **Medium** 完整性标签，而打包器自己是 **Low**
   （它在带 Low 标签的目录树里编译出来，patch-exe 只给 GUI / 卸载器两个 base 改标签）——
   Low 进程覆盖不了 Medium 文件，会报 `对路径 …PI-Setup-x.y.z.exe 的访问被拒绝`。
   所以先把旧成品删掉：node 是正常完整性进程，删得掉。 */
try {
  rmSync(OUT_EXE, { force: true });
} catch (error) {
  fail(`删不掉上一次的成品 ${path.basename(OUT_EXE)}：${error.message}`);
}

const payloadStat = countTree(PAYLOAD);
log(`\n[setup] 载荷：${payloadStat.files} 文件 / ${payloadStat.dirs} 子目录 / ${mb(payloadStat.bytes)}`);
log('[setup] 追加载荷（deflate）…');
const t0 = Date.now();
run(CONSOLE_EXE, [
  '--pack',
  '--base', GUI_EXE,
  '--payload', PAYLOAD,
  '--extra', UNINST_EXE,
  '--out', OUT_EXE,
  '--report', REPORT,
]);
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

/* ------------------------------------------------------------------ 自检 */

const report = Object.fromEntries(
  readFileSync(REPORT, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const outSize = statSync(OUT_EXE).size;
const expectFiles = payloadStat.files + 1; // + 卸载 PI.exe
const expectDirs = payloadStat.dirs;
const expectEntries = expectFiles + expectDirs;

log('\n[setup] ——— 自检 ———');
let bad = 0;
const check = (ok, text) => {
  log(`  ${ok ? '✓' : '✗'} ${text}`);
  if (!ok) bad++;
};

check(Number(report.files) === expectFiles, `打包文件数 ${report.files}（期望 ${expectFiles} = 载荷 ${payloadStat.files} + 卸载器 1）`);
check(Number(report.dirs) === expectDirs, `打包目录数 ${report.dirs}（期望 ${expectDirs}）`);
check(Number(report.entries) === expectEntries, `条目总数 ${report.entries}（期望 ${expectEntries}）`);
check(Number(report.payloadBytes) === payloadStat.bytes, `载荷字节 ${report.payloadBytes}（期望 ${payloadStat.bytes}）`);
check(Number(report.outBytes) === outSize, `成品大小 ${outSize.toLocaleString('en-US')} 字节与报告一致`);
check(Number(report.dataOffset) > 0 && Number(report.dataLength) > 0, `载荷偏移 ${report.dataOffset} / 长度 ${report.dataLength}`);
check(outSize < payloadStat.bytes, `已压缩：${mb(outSize)}（载荷的 ${((outSize / payloadStat.bytes) * 100).toFixed(1)}%）`);

log('\n[setup] 回读成品 exe 的 PE 资源 …');
run(process.execPath, [PATCH, OUT_EXE, '--verify-only']);

/* 成品是打包器**新写出来**的文件，会继承 release\ 目录的强制完整性标签。那个标签若是
   Low，用户双击它就是 Low 完整性进程，装到哪儿都被拒（写 %LOCALAPPDATA% 需要 Medium）。
   所以这里必须改回 Medium，并且把结果当成一项自检 —— 不许再发一个 Low 的安装包出去。 */
log('\n[setup] 完整性标签（Low 会让安装包双击后装不上）…');
const integrity = ensureMediumIntegrity(OUT_EXE, (message) => log(`  ${message}`));
check(integrity.ok, `成品完整性标签 = ${integrity.label ?? '未知'}（必须是 Medium）`);

if (bad > 0) fail(`自检有 ${bad} 项不通过`);
log(`\n[setup] 完成：${OUT_EXE}`);
log(`[setup] 大小 ${mb(outSize)}，打包用时 ${seconds}s`);
log('[setup] 双击它会弹图形界面安装；脚本自检用：');
log(`[setup]   "${OUT_EXE}" --silent --target <目录> --no-shortcuts`);
