#!/usr/bin/env node
/**
 * PI 「离线便携版」打包脚本（零依赖，纯 Node）。
 *
 * 这个脚本产出「便携版」：手工拼一份 Electron 运行时 + 应用产物，双击 `pi.exe` 就能跑，
 * 卸载靠目录里自带的 `卸载 PI.cmd`。它不写注册表、不进「应用和功能」——
 * 要那个请跑 `pnpm installer`（`scripts/make-installer.mjs`，NSIS 安装包，载荷就是本目录）。
 * 便携版本身也有存在价值：它不依赖任何外部打包工具，且是安装包的载荷来源。
 *
 * 产物布局（`release/pi/`，其中 `pi.exe` 是 `electron.exe` 的副本改名 + PE 资源已改写）：
 *
 *   release/
 *   ├─ PI.lnk                      ← 带图标的快捷方式（WScript.Shell COM 生成）
 *   └─ pi/
 *      ├─ pi.exe                   ← electron.exe 改名副本（Electron 按 exe 同级找 resources/）
 *      ├─ pi.ico                   ← 图标（给快捷方式/uninstaller 用）
 *      ├─ 卸载 PI.cmd              ← 卸载（删自身目录 + 快捷方式，不碰用户音乐目录）
 *      ├─ 安装说明.txt
 *      ├─ uninstall-helper.ps1     ← 卸载用的延时清理脚本（正在跑的 .cmd 删不掉自己）
 *      ├─ (Electron 运行时：*.dll / *.pak / locales/ / icudtl.dat / …)
 *      ├─ build/pi.ico             ← 主进程 iconPath 候选①：<exe>/../../../build/pi.ico
 *      └─ resources/
 *         ├─ build/pi.ico         ← 主进程 iconPath 候选②：process.resourcesPath/build/pi.ico
 *         └─ app/
 *            ├─ package.json      ← 最小清单：name=pi / main=out/main.mjs
 *            ├─ out/main.mjs      ← apps/desktop/out/（esbuild 产物）
 *            ├─ out/preload.cjs
 *            ├─ renderer/dist/    ← apps/renderer/dist/（index.html + assets/，默认去掉 .map）
 *            └─ node_modules/     ← 运行时**外部依赖**（见下面「为什么要搬 node_modules」）
 *
 * 为什么渲染层放在 `resources/app/renderer/dist/`：
 *   主进程 `apps/desktop/src/main/index.ts` 的 `resolveRendererIndex()` 按顺序试四个候选：
 *     1. `PI_RENDERER_DIST`（环境变量）
 *     2. `path.resolve(app.getAppPath(), '../renderer/dist/index.html')`  → resources/renderer/dist/
 *     3. `path.resolve(app.getAppPath(), 'renderer/dist/index.html')`     → resources/app/renderer/dist/  ★
 *     4. `path.resolve(process.resourcesPath, 'renderer/index.html')`     → resources/renderer/
 *   打包里 `app.getAppPath()` = `resources/app`，所以按 **候选 3** 放，天然命中；
 *   `vite.config.ts` 里 `base: './'`，index.html 用的是相对路径 `./assets/…`，
 *   所以 `file://` 直接加载没问题（已核对 dist/index.html 第 16-17 行）。
 *
 * 为什么要搬 node_modules：
 *   esbuild 把主进程打成单文件，但**故意** external 了几个包，它们运行时才解析：
 *     · `NeteaseCloudMusicApi` —— 由 packages/ncm-server/src/host.ts:177 `resolveNcmEntry()`
 *       用 `createRequire(import.meta.url).resolve(...)` 找入口，再用 `ELECTRON_RUN_AS_NODE`
 *       以子进程跑（它用 fs.readdirSync + 动态 require 装路由，bundle 不了）。
 *     · `@unblockneteasemusic/server` —— packages/source-unm/src/index.ts:181 `createRequire` 装载（LGPL 要求不打包）。
 *     · `pino` / `pino-pretty` —— 动态 require；pino-pretty 还会在 Electron 里起 worker 线程，bundle 会炸。
 *   所以脚本会从 seed 包出发，递归读它们的 `dependencies`，把整棵运行时依赖树复制到
 *   `resources/app/node_modules/`（扁平布局）。不搬的话应用能开窗、但音源解析整条链会失败。
 *
 * 用法：
 *   node scripts/make-dist.mjs                  # 完整打包
 *   node scripts/make-dist.mjs --shortcut-only  # 只重新生成 release/PI.lnk
 *   node scripts/make-dist.mjs --keep-sourcemaps # 连 renderer 的 .map 一起搬（默认跳过，省 ~3MB）
 *   node scripts/make-dist.mjs --skip-node-modules
 *   node scripts/make-dist.mjs --max-nm-mb=250   # 运行时依赖体积上限（超过就停手并告警）
 *
 * 关于 `pi.exe` 的内嵌资源（这一步是**自动**的）：
 *   复制完 electron.exe 之后会调用 `scripts/patch-exe.mjs`（resedit，纯 JS、不联网）改写
 *   PE 资源段 —— 图标换成 `build/pi-embed.ico`（6 个尺寸），版本信息换成 PI / 0.1.0.0 /
 *   「PI —— 桌面音乐应用」，并删掉 Electron 带来的 SquirrelAwareVersion。
 *   于是文件属性页、资源管理器、任务管理器里显示的都是 PI，不再是 Electron。
 *
 * 仍**做不到**的事（写在这里免得被当成 bug）：
 *   · 便携版没有注册表登记，所以「应用和功能」里不会出现 PI，卸载只能跑 `卸载 PI.cmd`。
 *     要正规卸载项请用安装版（`pnpm installer`）。
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 「应用目录」的装配（主进程产物 + 清单 + 渲染层 + 运行时 node_modules）与
   `scripts/make-installer.mjs` 共用同一份实现，免得两种发行形态悄悄长歪。
   该模块只做装配，不碰 Electron 运行时 / 图标 / 卸载器 / 安装包外壳。 */
import { assembleAppDir, mb, measure, readJson } from './lib/app-dir.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS_DIR, '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const RENDERER = path.join(ROOT, 'apps', 'renderer');
const BUILD_ICO = path.join(ROOT, 'build', 'pi.ico');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const RELEASE = path.join(ROOT, 'release');
const PI_DIR = path.join(RELEASE, 'pi');
const RESOURCES = path.join(PI_DIR, 'resources');
const APP_DIR = path.join(RESOURCES, 'app');
const LNK = path.join(RELEASE, 'PI.lnk');
const PI_EXE = path.join(PI_DIR, 'pi.exe');
const APP_ICON_IN_RESOURCES = path.join(RESOURCES, 'build', 'pi.ico');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const SHORTCUT_ONLY = has('--shortcut-only');
const KEEP_SOURCEMAPS = has('--keep-sourcemaps');
const SKIP_NODE_MODULES = has('--skip-node-modules');
const MAX_NM_MB = (() => {
  const hit = argv.find((item) => item.startsWith('--max-nm-mb='));
  const value = hit ? Number(hit.split('=')[1]) : 250;
  return Number.isFinite(value) && value > 0 ? value : 250;
})();

const log = (...args) => console.log('[dist]', ...args);

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

if (ROOT === path.parse(ROOT).root || !existsSync(path.join(ROOT, 'package.json'))) {
  console.error('[dist] 安全检查失败：仓库根看起来不对，拒绝执行：', ROOT);
  process.exit(1);
}

/* requireFile 在共用实现之外加一层 `[dist]` 前缀，保持本脚本输出同一口吻。 */
function requireFile(file, why) {
  if (!existsSync(file)) {
    console.error(`[dist] 缺少构建产物：${file}`);
    console.error(`[dist] ${why}`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ *
 * 步骤 0：前置检查
 * ------------------------------------------------------------------ */

const rootPkg = readJson(path.join(ROOT, 'package.json'));

if (SHORTCUT_ONLY) {
  requireFile(PI_EXE, '先跑一次 `node scripts/make-dist.mjs` 完整打包，再来生成快捷方式。');
  requireFile(BUILD_ICO, '先跑 `pnpm icon` 生成 build/pi.ico。');
} else {
  requireFile(path.join(DESKTOP, 'out', 'main.mjs'), '先执行 `pnpm -F @pi/desktop build`。');
  requireFile(path.join(DESKTOP, 'out', 'preload.cjs'), '先执行 `pnpm -F @pi/desktop build`。');
  requireFile(
    path.join(RENDERER, 'dist', 'index.html'),
    '先执行 `pnpm -F @pi/renderer build`（渲染层产物缺失时应用只会显示一张「产物缺失」提示页）。',
  );
  requireFile(path.join(ELECTRON_DIST, 'electron.exe'), '先执行 `pnpm electron:install`。');
  requireFile(BUILD_ICO, '先执行 `pnpm icon`。');
}

/* ------------------------------------------------------------------ *
 * 生成/刷新快捷方式
 * ------------------------------------------------------------------ */

function makeShortcut() {
  const helper = path.join(SCRIPTS_DIR, 'make-shortcut.ps1');
  if (!existsSync(helper)) {
    log('× scripts/make-shortcut.ps1 不存在，跳过快捷方式。');
    return { ok: false, reason: 'make-shortcut.ps1 缺失' };
  }
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helper,
    '-LnkPath',
    LNK,
    '-TargetPath',
    PI_EXE,
    '-IconLocation',
    BUILD_ICO,
    '-WorkingDirectory',
    PI_DIR,
    '-Description',
    'PI 音乐应用（便携版）',
  ];
  let res;
  try {
    // 注意：**必须** 用 stdio: 'inherit'，不能捕获子进程输出。
    // 在受限沙箱里，「Node 起子进程并读它的管道输出」会被拒（spawnSync ... EPERM），
    // 而 `stdio: 'inherit'` 直接把 PowerShell 的输出接到本进程控制台，不建管道，因此可用。
    res = spawnSync('powershell.exe', args, { stdio: 'inherit', windowsHide: true, timeout: 90_000 });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (res.error) return { ok: false, reason: `powershell 起不来：${res.error.message}` };
  if (res.status === 0 && existsSync(LNK)) return { ok: true, reason: 'ok' };
  return { ok: false, reason: `powershell 退出码 ${String(res.status)}` };
}

if (SHORTCUT_ONLY) {
  const result = makeShortcut();
  log(result.ok ? `✓ 快捷方式已生成：${LNK}` : `× 快捷方式生成失败：${result.reason}`);
  if (!result.ok) {
    log('  退化方案：手动跑 powershell -File scripts/make-shortcut.ps1 -LnkPath ... -TargetPath ...');
  }
  process.exit(result.ok ? 0 : 1);
}

/* ------------------------------------------------------------------ *
 * 步骤 1：清空旧的 release/pi
 * ------------------------------------------------------------------ */

const releaseGuard =
  path.basename(PI_DIR) === 'pi' &&
  path.dirname(PI_DIR) === RELEASE &&
  RELEASE.startsWith(ROOT + path.sep);
if (!releaseGuard) {
  console.error('[dist] 安全检查失败：release/pi 路径不对，拒绝删除：', PI_DIR);
  process.exit(1);
}
if (existsSync(PI_DIR)) {
  const old = measure(PI_DIR);
  rmSync(PI_DIR, { recursive: true, force: true });
  log(`清理旧产物 release/pi（${old.files} 个文件，${mb(old.bytes)}）`);
}
mkdirSync(PI_DIR, { recursive: true });
mkdirSync(APP_DIR, { recursive: true });

/* ------------------------------------------------------------------ *
 * 步骤 2：Electron 运行时 + electron.exe → pi.exe
 * ------------------------------------------------------------------ */

const t0 = Date.now();
cpSync(ELECTRON_DIST, PI_DIR, {
  recursive: true,
  dereference: true,
  filter: (src) => path.basename(src).toLowerCase() !== 'electron.exe',
});
copyFileSync(path.join(ELECTRON_DIST, 'electron.exe'), PI_EXE);
const runtime = measure(PI_DIR);
log(`Electron 运行时 → release/pi/（${mb(runtime.bytes)}），electron.exe 副本改名 pi.exe`);

/* ------------------------------------------------------------------ *
 * 步骤 2b：改写 pi.exe 的内嵌资源（图标 + 版本信息）
 * ------------------------------------------------------------------ */

/* 必须**在**复制之后、装配之前做：它重写整个 PE 资源段，文件大小会变。
   走 patch-exe.mjs（resedit，纯 JS，不联网）——
   于是文件属性页 / 资源管理器 / 任务管理器里显示的都是 PI，而不是 Electron。
   失败就直接退出：一个「图标还对但资源没换」的 pi.exe 正是这一步要消灭的东西。 */
const patchResult = spawnSync(
  process.execPath,
  [
    path.join(SCRIPTS_DIR, 'patch-exe.mjs'),
    PI_EXE,
    '--ico',
    path.join(ROOT, 'build', 'pi-embed.ico'),
    '--product',
    'PI',
    '--desc',
    'PI —— 桌面音乐应用',
    '--company',
    'PI',
    '--version',
    rootPkg.version,
  ],
  { stdio: 'inherit', cwd: ROOT },
);
if (patchResult.status !== 0) {
  console.error(`[dist] pi.exe 内嵌资源改写失败（patch-exe.mjs 退出码 ${String(patchResult.status)}）`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 步骤 3~5：应用目录（主进程产物 + 清单 + 渲染层 + 运行时 node_modules）
 * ------------------------------------------------------------------ */

/* 这三步与安装包脚本共用 `scripts/lib/app-dir.mjs` 一份实现：便携版和安装版的
   out / renderer/dist / node_modules 必须逐字节一致，否则会出现「便携版能放歌、
   安装版放不了」这类最难查的问题。 */
assembleAppDir({
  root: ROOT,
  dest: APP_DIR,
  keepSourcemaps: KEEP_SOURCEMAPS,
  skipNodeModules: SKIP_NODE_MODULES,
  maxNmMb: MAX_NM_MB,
  log: (message) => log(String(message).replaceAll(ROOT + path.sep, '').replaceAll('\\', '/')),
});



/* ------------------------------------------------------------------ *
 * 步骤 6：图标（三条路径都放，主进程两个候选都能命中）
 * ------------------------------------------------------------------ */

copyFileSync(BUILD_ICO, path.join(PI_DIR, 'pi.ico')); // 快捷方式/说明用
mkdirSync(path.dirname(APP_ICON_IN_RESOURCES), { recursive: true });
copyFileSync(BUILD_ICO, APP_ICON_IN_RESOURCES); // 主进程候选②：process.resourcesPath/build/pi.ico
mkdirSync(path.join(PI_DIR, 'build'), { recursive: true });
copyFileSync(BUILD_ICO, path.join(PI_DIR, 'build', 'pi.ico')); // 主进程候选①：<exe>/../../../build/pi.ico
log('图标 → release/pi/pi.ico、resources/build/pi.ico、build/pi.ico');

/* ------------------------------------------------------------------ *
 * 步骤 7：卸载器 + 说明
 * ------------------------------------------------------------------ */

// .cmd 用 UTF-8（无 BOM）+ 首行 chcp 65001：命令本身全是 ASCII 路径，
// 中文只出现在 echo 文本里，即使某些终端编码诡异也不影响卸载功能。
const UNINSTALL_CMD = `@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title PI 卸载
echo ============================================================
echo   PI（便携版）卸载
echo ============================================================
echo.
echo 将要删除：
echo    安装目录        %~dp0
echo    桌面快捷方式    %USERPROFILE%\\Desktop\\PI.lnk
echo    开始菜单快捷方式 %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\PI.lnk
echo    release 下的 PI.lnk
echo.
echo 不会删除：
echo    你的音乐 / 下载目录里的任何文件
echo    %APPDATA%\\PI 下的设置与缓存（要一起清就手动删这个目录）
echo.
set "ANSWER="
set /p ANSWER=确认卸载？输入 y 回车继续，直接回车取消：
if /i not "%ANSWER%"=="y" goto :cancelled

echo.
echo [1/3] 删除快捷方式 ...
if exist "%USERPROFILE%\\Desktop\\PI.lnk" del /f /q "%USERPROFILE%\\Desktop\\PI.lnk"
if exist "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\PI.lnk" del /f /q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\PI.lnk"
if exist "%~dp0..\\PI.lnk" del /f /q "%~dp0..\\PI.lnk"

echo [2/3] 删除安装目录 ...
echo        （正在运行的批处理删不掉自己，交给一个延时 2 秒的后台 PowerShell）
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0uninstall-helper.ps1" "%~dp0"

echo [3/3] 完成，本窗口会自动关闭。
exit /b 0

:cancelled
echo.
echo 已取消，什么都没删。
pause
exit /b 0
`;

const UNINSTALL_PS1 = `<#
  uninstall-helper.ps1 —— 卸载器的真正执行者。
  为什么单独一个脚本：Windows 上**正在运行的 .cmd 自己删不掉自己**（cmd.exe 还开着它），
  所以 `+"`卸载 PI.cmd`"+` 只做确认与删快捷方式，然后把这个脚本以最小化窗口拉起来就退出；
  这里先睡 2 秒等父进程彻底退出，再删掉整个安装目录（本脚本自己也在里面，一起没）。
  用法：powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-helper.ps1 "<安装目录>"
#>
param([Parameter(Mandatory = $true)][string]$InstallDir)

Start-Sleep -Seconds 2

if (-not (Test-Path -LiteralPath $InstallDir)) {
  exit 0
}

# 只允许删「自己所在的那个目录」，避免参数被传错时误删别处。
$self = Split-Path -Parent $MyInvocation.MyCommand.Path
if ((Resolve-Path -LiteralPath $InstallDir).Path.TrimEnd('\\') -ne (Resolve-Path -LiteralPath $self).Path.TrimEnd('\\')) {
  Write-Error "[uninstall] 安装目录 ($InstallDir) 与本脚本所在目录 ($self) 不一致，拒绝删除。"
  exit 1
}

try {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction Stop
} catch {
  # 偶尔有文件被杀软/索引器短暂占用，再试一次。
  Start-Sleep -Seconds 1
  Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
`;

writeFileSync(path.join(PI_DIR, '卸载 PI.cmd'), UNINSTALL_CMD.replace(/\n/g, '\r\n'), 'utf8');
// 为什么带 BOM：Windows PowerShell 5.1（powershell.exe）读 .ps1 时不认「无 BOM 的 UTF-8」，
// 会按 ANSI(GBK) 解码，中文注释里的多字节序列能拼出一个撇号，直接把脚本解析炸掉
// （实测报错：The string is missing the terminator: '.）。
// 注意：上面那个 .cmd **绝不能**带 BOM（cmd.exe 会把 BOM 当成命令），它靠首行 `chcp 65001` 解决编码。
writeFileSync(
  path.join(PI_DIR, 'uninstall-helper.ps1'),
  `\uFEFF${UNINSTALL_PS1.replace(/\n/g, '\r\n')}`,
  'utf8',
);

const README_TXT = `PI 音乐应用 —— 便携版（portable）
================================================
生成时间：${new Date().toLocaleString('zh-CN')}
版本：${rootPkg.version}

【这是什么】
这是一个「绿色便携版」——整个文件夹就是应用本体，不写注册表、不进「应用和功能」。
里面已经包含 Electron 运行时（pi.exe 就是改了名的 electron.exe，图标与版本信息已换成 PI）
与渲染层产物，所以目标机器**不需要**装 Node.js，也不需要联网。

【怎么用】
1. 双击 release\\pi\\pi.exe 直接启动；
2. 想要桌面图标：把 release\\PI.lnk 复制到桌面或开始菜单
   （.lnk 用的是自己的图标；直接给 pi.exe 建快捷方式也行，图标取自 exe 内嵌资源）；
3. 不想每次找目录：把整个 release\\pi 拷到任意位置（U 盘也行），再更新 PI.lnk 的目标路径。

【怎么卸载】
双击 release\\pi\\卸载 PI.cmd，输入 y 回车。
它会删掉自身所在目录与桌面/开始菜单里的 PI.lnk，
**不会**动你音乐、下载目录里的任何文件；
%APPDATA%\\PI 下的设置与缓存会保留（要彻底清干净就手动删那个目录）。

【想要正规安装版】
跑 pnpm installer 产出 release\\PI-Setup-<版本>.exe：装到
%LOCALAPPDATA%\\Programs\\PI，建开始菜单项，并在「设置 → 应用 → 已安装的应用」
（旧称「应用和功能」）里登记，卸载走系统那一套。
便携版和安装版用的是**同一份**应用产物，功能一样。

【已知限制（诚实说明）】
1. 便携版不写注册表，所以「应用和功能」里不会出现 PI，卸载只能跑目录里的「卸载 PI.cmd」；
   要系统级卸载项请用安装版（见上）。
2. 首次启动会在 %APPDATA%\\PI 建数据目录（曲库缓存、登录态、bootstrap.json）；
   便携版仍是「按用户」存数据，不会写进本目录。
`;

writeFileSync(path.join(PI_DIR, '安装说明.txt'), `\uFEFF${README_TXT.replace(/\n/g, '\r\n')}`, 'utf8');

log('卸载器 → 卸载 PI.cmd + uninstall-helper.ps1；说明 → 安装说明.txt');

/* ------------------------------------------------------------------ *
 * 步骤 8：快捷方式 + 汇总
 * ------------------------------------------------------------------ */

const shortcut = makeShortcut();
if (shortcut.ok) {
  log(`快捷方式 → release/PI.lnk（IconLocation=build/pi.ico，WorkingDirectory=release/pi）`);
} else {
  log(`⚠ 快捷方式没生成：${shortcut.reason}`);
  log('  退化方案：手动跑 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-shortcut.ps1`');
  log('                -LnkPath release\\PI.lnk -TargetPath release\\pi\\pi.exe -IconLocation build\\pi.ico -WorkingDirectory release\\pi');
}

const total = measure(PI_DIR);
log('');
log('=== 产物 ===');
log(`release/pi/  ${total.files} 个文件，合计 ${mb(total.bytes)}`);
const top = readdirSync(PI_DIR, { withFileTypes: true })
  .map((entry) => {
    const full = path.join(PI_DIR, entry.name);
    const info = statSync(full);
    const size = info.isDirectory() ? measure(full) : { bytes: info.size, files: 1 };
    return { name: entry.name + (info.isDirectory() ? '/' : ''), ...size };
  })
  .sort((a, b) => b.bytes - a.bytes);
for (const item of top) {
  log(`  ${item.name.padEnd(28, ' ')} ${mb(item.bytes).padStart(10)}  ${item.files} 文件`);
}
log(`  以上 + release/PI.lnk ${existsSync(LNK) ? '✓' : '✗'}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
log(`启动：release\\pi\\pi.exe（或双击 release\\PI.lnk）；卸载：release\\pi\\卸载 PI.cmd`);
