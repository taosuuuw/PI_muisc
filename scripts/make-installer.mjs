#!/usr/bin/env node
/**
 * 编译 PI 安装包（NSIS）。
 *
 * 产物：`release/PI-Setup-<版本>.exe` —— 双击走向导式安装，装到
 * `%LOCALAPPDATA%\Programs\PI`，在「设置 → 应用 → 已安装的应用」（旧版叫
 * 「应用和功能」）里能看到条目，exe 自身带 PI 图标与版本信息。
 *
 * 为什么不用 electron-builder：它的 nsis 目标在构建中途会**真的执行**一遍中间
 * 安装器来产出卸载器，而本仓库的会话环境里 harness 启动的建窗口进程会阻塞，
 * 那一步过不去。这里改成直接调 makensis 编译 `scripts/pi-installer.nsi`，
 * 编译期不需要执行任何产物。
 *
 * 安装路径零临时文件（2026-09-30 用户实测「NSIS Error: Error writing temporary
 * file. Make sure your temp folder is valid.」之后定下的规矩）：
 *  · 安装器不使用任何插件 —— 插件必须先解压到 $PLUGINSDIR = %TEMP%\nsuXXXX.tmp；
 *  · 三个压缩档位都强制**非整块** —— `/SOLID` 会定义 NSIS_COMPRESS_WHOLE，运行时要
 *    先把整个载荷解压进 %TEMP%，建不出那个临时文件就弹这条错（NSIS 源码
 *    Source/exehead/fileform.c 的 `#ifdef NSIS_COMPRESS_WHOLE` 分支）；
 *  · 卸载器不再是安装期用 WriteUninstaller 生成的，而是由
 *    `scripts/pi-uninstaller.nsi` 单独编译成 `卸载 PI.exe` 随包安装。
 * 自检会用 makensis 的 /V4 日志确认安装包里一条插件解压条目都没有。
 *
 * 用法：
 *   node scripts/make-installer.mjs [选项]
 *
 * 选项：
 *   --payload <dir>       载荷目录（默认 release/pi，`pnpm dist` 的产物）
 *   --out <file>          输出 exe（默认 release/PI-Setup-<版本>.exe）
 *   --compressor <name>   zlib（默认，快）| lzma（小，但 400 MB 要跑十几分钟）| bzip2
 *                         （三档都强制非整块压缩：/SOLID 要求启动时把整个载荷解压到
 *                          %TEMP%，那正是「Error writing temporary file」的来源）
 *   --makensis <exe>      makensis 路径（默认自动查找，也可用环境变量 PI_MAKENSIS）
 *   --no-patch            不重新改写载荷里 pi.exe 的内嵌图标/版本信息
 *   --no-verify           跳过编译后的自检
 *   --quiet               少打印
 *
 * 注意：
 *  · makensis 是外部程序，在本仓库的沙箱会话里需要 danger-full-access 才能启动。
 *  · 子进程一律用 `stdio: 'inherit'` 或直接写文件描述符 —— 受限沙箱下用管道捕获
 *    子进程输出会 EPERM（见 scripts/make-dist.mjs 里 makeShortcut 的同类注释）。
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, mb } from './lib/app-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NSI = path.join(HERE, 'pi-installer.nsi');
const UNINST_NSI = path.join(HERE, 'pi-uninstaller.nsi');
const README_SRC = path.join(HERE, 'installer-readme.txt');
const TMP = path.join(ROOT, '.tmp');

const LOCALAPPDATA =
  process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
const EB_CACHE = path.join(LOCALAPPDATA, 'electron-builder', 'Cache');

/* ---------------------------------------------------------------- 参数解析 */

function parseArgs(argv) {
  const opts = {
    payload: path.join(ROOT, 'release', 'pi'),
    out: undefined,
    compressor: 'zlib',
    makensis: undefined,
    patch: true,
    verify: true,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(`选项 ${arg} 缺少值`);
        process.exit(2);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case '--payload':
        opts.payload = path.resolve(next());
        break;
      case '--out':
        opts.out = path.resolve(next());
        break;
      case '--compressor':
        opts.compressor = next();
        break;
      case '--makensis':
        opts.makensis = next();
        break;
      case '--no-patch':
        opts.patch = false;
        break;
      case '--no-verify':
        opts.verify = false;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '-h':
      case '--help':
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        console.error(`未知选项：${arg}`);
        process.exit(2);
    }
  }
  if (!['zlib', 'lzma', 'bzip2'].includes(opts.compressor)) {
    console.error(`--compressor 只支持 zlib / lzma / bzip2，收到：${opts.compressor}`);
    process.exit(2);
  }
  return opts;
}

/* -------------------------------------------------------------------- 工具 */

const log = (opts) => (message) => {
  if (!opts.quiet) console.log(message);
};

/** 定位 makensis：显式参数 → 环境变量 → 常规安装位置 → electron-builder 下载缓存。 */
function findMakensis(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.PI_MAKENSIS) candidates.push(process.env.PI_MAKENSIS);
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (base) candidates.push(path.join(base, 'NSIS', 'makensis.exe'));
  }
  if (existsSync(EB_CACHE)) {
    for (const top of readdirSync(EB_CACHE)) {
      if (!top.startsWith('nsis-')) continue;
      const topPath = path.join(EB_CACHE, top);
      if (!statSync(topPath).isDirectory()) continue;
      for (const sub of readdirSync(topPath)) {
        candidates.push(path.join(topPath, sub, 'Bin', 'makensis.exe'));
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return path.resolve(candidate);
  }
  return undefined;
}

/** VIProductVersion 必须是四段数字，`0.1.0` → `0.1.0.0`。 */
function toVersion4(version) {
  const parts = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) && part >= 0 ? part : 0));
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join('.');
}

/** 说明文件要随安装包进 Windows：加 BOM + CRLF，记事本打开才不会乱码。 */
function prepareReadme() {
  const raw = readFileSync(README_SRC, 'utf8').replace(/^\ufeff/, '');
  const crlf = raw.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const target = path.join(TMP, 'installer-readme.txt');
  mkdirSync(TMP, { recursive: true });
  writeFileSync(target, `\ufeff${crlf}`, 'utf8');
  return target;
}

/* ------------------------------------------------------------------ 主流程 */

const opts = parseArgs(process.argv.slice(2));
const say = log(opts);

const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = rootPkg.version ?? '0.0.0';
const productName = 'PI';
const outFile = opts.out ?? path.join(ROOT, 'release', `PI-Setup-${version}.exe`);

/* 1) 检查载荷 */
if (!existsSync(opts.payload) || !statSync(opts.payload).isDirectory()) {
  console.error(`载荷目录不存在：${opts.payload}`);
  console.error('先跑 `pnpm dist` 生成 release/pi。');
  process.exit(1);
}
const payloadEntries = readdirSync(opts.payload);
if (payloadEntries.length === 0) {
  console.error(`载荷目录是空的：${opts.payload}`);
  process.exit(1);
}
const payloadSize = measure(opts.payload);
say(`载荷：${path.relative(ROOT, opts.payload)}（${payloadSize.files} 个文件，${mb(payloadSize.bytes)}）`);
for (const [relative, why] of [
  ['pi.exe', '缺少 pi.exe —— 安装完没法启动'],
  [path.join('resources', 'app', 'out', 'main.mjs'), '缺少主进程入口 —— 载荷不完整'],
  [path.join('resources', 'app', 'renderer', 'dist', 'index.html'), '缺少渲染层页面 —— 载荷不完整'],
  [path.join('resources', 'app', 'package.json'), '缺少应用清单 —— 载荷不完整'],
]) {
  if (!existsSync(path.join(opts.payload, relative))) {
    console.warn(`警告：${why}（${relative}）`);
  }
}

/* 2) 改写载荷里 pi.exe 的内嵌图标与版本信息（PE 资源） */
if (opts.patch) {
  const appExe = path.join(opts.payload, 'pi.exe');
  if (existsSync(appExe)) {
    say('\n改写 pi.exe 的内嵌图标与版本信息…');
    const patched = spawnSync(
      process.execPath,
      [path.join(HERE, 'patch-exe.mjs'), appExe, '--product', productName, '--version', version],
      { stdio: 'inherit', cwd: ROOT },
    );
    if (patched.status !== 0) {
      console.error('改写 pi.exe 失败（见上面输出）。');
      process.exit(1);
    }
  } else {
    say('载荷里没有 pi.exe，跳过资源改写。');
  }
} else {
  say('（--no-patch：不改写 pi.exe）');
}

/* 3) 找 makensis */
const makensis = findMakensis(opts.makensis);
if (!makensis) {
  console.error('找不到 makensis.exe。三种办法：');
  console.error('  · 装 NSIS（https://nsis.sourceforge.io/）后重跑；');
  console.error('  · 用 --makensis <路径> 指定；');
  console.error('  · 设置环境变量 PI_MAKENSIS。');
  console.error(`（已找过：%ProgramFiles(x86)%\\NSIS、%ProgramFiles%\\NSIS、${EB_CACHE}\\nsis-*）`);
  process.exit(1);
}
say(`makensis：${makensis}`);

/* 4) 编译 */
const readme = prepareReadme();
const iconFile = existsSync(path.join(ROOT, 'build', 'pi-embed.ico'))
  ? path.join(ROOT, 'build', 'pi-embed.ico')
  : path.join(ROOT, 'build', 'pi.ico');
if (!existsSync(iconFile)) {
  console.error(`找不到图标：${iconFile}（先跑 \`pnpm icon\`）`);
  process.exit(1);
}

/* 4b) 编译随包安装的独立卸载器（scripts/pi-uninstaller.nsi）。
   为什么单独编一个而不是用 WriteUninstaller：安装期生成卸载器是我们无法在本机做
   运行级验证的引擎行为，而「安装路径零临时文件」这条规矩要求把安装路径上的不确定
   因素降到最低。卸载器只在用户点「卸载」时才跑，没有这个顾虑。
   产物先落在 .tmp 下的 ASCII 文件名，最终的中文名 `卸载 PI.exe` 由 pi-installer.nsi
   的 `File /oname=` 决定 —— 中文不能经 /D 传递（makensis 按 ANSI 解析命令行）。 */
const uninstFile = path.join(TMP, 'pi-uninstaller.exe');
say('\n编译随包安装的独立卸载器…');
const uninstBuild = spawnSync(
  makensis,
  [
    '/V2',
    '/NOCD',
    `/O${path.join(TMP, 'makensis-uninst.log')}`,
    '/INPUTCHARSET',
    'UTF8',
    '/OUTPUTCHARSET',
    'UTF8',
    `/DOUT_FILE=${uninstFile}`,
    `/DICON_FILE=${iconFile}`,
    `/DPRODUCT_NAME=${productName}`,
    `/DAPP_VERSION=${version}`,
    `/DAPP_VERSION4=${toVersion4(version)}`,
    '/DPUBLISHER=PI',
    UNINST_NSI,
  ],
  { stdio: 'inherit', cwd: ROOT },
);
if (uninstBuild.status !== 0 || !existsSync(uninstFile)) {
  console.error('\nmakensis 编译卸载器失败。完整日志：.tmp/makensis-uninst.log');
  process.exit(1);
}
say(`  卸载器：${mb(statSync(uninstFile).size)}`);

const estimatedKb = Math.max(1, Math.round(payloadSize.bytes / 1024));
/* 只传 ASCII 值：makensis 按系统 ANSI 代码页解析命令行，非 ASCII 会走样
   （实测 COPYRIGHT 里的 "©" 变成 "?"）。中文显示文案全部写在 pi-installer.nsi 里。 */
const defines = {
  PAYLOAD: opts.payload,
  OUT_FILE: outFile,
  ICON_FILE: iconFile,
  README_FILE: readme,
  UNINST_FILE: uninstFile,
  PRODUCT_NAME: productName,
  APP_VERSION: version,
  APP_VERSION4: toVersion4(version),
  PUBLISHER: 'PI',
  ESTIMATED_KB: String(estimatedKb),
  COMPRESSOR: opts.compressor,
};

/* /D 与其它选项必须排在脚本路径**之前** —— makensis 按顺序处理参数。
   `/NOCD` 禁止它把工作目录切到 .nsi 所在目录，保证路径解析完全由我们给的值决定。
   `/OUTPUTCHARSET UTF8` 让编译日志是 UTF-8，否则它是 ANSI（中文机器上 GBK），
   读日志时会被当成非法 UTF-8。
   `/V4` 是必需的、不是图热闹：只有这个级别 makensis 才会为每个打进安装包的文件写一行
   `File: "<源名>" [compress] …`，编译后的自检就是靠数这些行来确认载荷没漏。 */
const makensisArgs = [
  '/V4',
  '/NOCD',
  `/O${path.join(TMP, 'makensis.log')}`,
  '/INPUTCHARSET',
  'UTF8',
  '/OUTPUTCHARSET',
  'UTF8',
];
for (const [key, value] of Object.entries(defines)) makensisArgs.push(`/D${key}=${value}`);
makensisArgs.push(NSI);

say(`\n编译安装包（compressor=${opts.compressor}，预计 ${mb(payloadSize.bytes)} 载荷）…`);
mkdirSync(path.dirname(outFile), { recursive: true });
const started = Date.now();
const build = spawnSync(makensis, makensisArgs, { stdio: 'inherit', cwd: ROOT });
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (build.status !== 0) {
  console.error(`\nmakensis 失败（exit=${build.status}）。完整日志：.tmp/makensis.log`);
  process.exit(1);
}
if (!existsSync(outFile)) {
  console.error(`\nmakensis 报告成功，但没有生成 ${outFile}。看 .tmp/makensis.log。`);
  process.exit(1);
}

const setupSize = statSync(outFile).size;
const ratio = ((setupSize / payloadSize.bytes) * 100).toFixed(1);
say(`\n已生成：${outFile}`);
say(`  大小：${mb(setupSize)}（压缩到载荷的 ${ratio}%）  用时：${seconds}s`);

/* 5) 自检 */
if (opts.verify) {
  say('\n自检 1/2：安装包自己的 PE 资源（图标 + 版本信息）');
  spawnSync(process.execPath, [path.join(HERE, 'patch-exe.mjs'), outFile, '--verify-only'], {
    stdio: 'inherit',
    cwd: ROOT,
  });

  /* 清点 makensis 究竟把哪些文件打进了安装包。
     为什么不用 7z 核对：本机的 7za.exe 是 7-Zip 的 standalone 精简版，根本不认 NSIS
     格式（`7za l setup.exe` 直接 "Cannot open the file as archive"）。改成读 makensis
     自己的 /V4 日志，口径比任何外部工具都直接。 */
  say('\n自检 2/2：清点安装包内嵌的载荷（读 makensis /V4 日志）');
  const lines = readFileSync(path.join(TMP, 'makensis.log'), 'utf8').split(/\r?\n/);
  const packed = lines.filter((line) => line.startsWith('File: "'));
  const descents = lines.filter((line) => line.startsWith('File: Descending to:')).length;
  say(`  载荷 ${payloadSize.files} 个文件、${descents} 个子目录 → 日志记录 ${packed.length} 条打包条目`);
  /* 日志里必然比载荷多两条：安装版说明文件 1 条 + 独立卸载器 exe 1 条。 */
  const extra = packed.length - payloadSize.files;
  if (extra >= 2) {
    say(`  多出的 ${extra} 条是附加项（安装版说明 1 条 + 独立卸载器 1 条）`);
  } else {
    console.warn(`  警告：打包条目只比载荷多 ${extra} 条（应为 ≥2），可能有文件没进安装包`);
    console.warn('  详见 .tmp/makensis.log（搜 `File: "`）');
  }
  /* 插件条目必须是 0：任何插件都要先解压到 $PLUGINSDIR = %TEMP%\nsuXXXX.tmp，
     临时目录不可用时就弹「Error writing temporary file」—— 这正是要根除的东西。 */
  const plugins = lines.filter((line) => line.includes('PLUGINSDIR'));
  if (plugins.length > 0) {
    console.error(`  错误：安装包里有 ${plugins.length} 条 $PLUGINSDIR 条目，安装器又要用 %TEMP% 了：`);
    for (const line of plugins.slice(0, 5)) console.error(`    ${line.trim()}`);
    process.exitCode = 1;
  } else {
    say('  插件条目 0 条 ✓（安装路径完全不需要 %TEMP%）');
  }
  const totalLine = lines.find((line) => line.startsWith('Total size:'));
  if (totalLine) {
    say(`  makensis 汇总：${totalLine.trim()}`);
    const fromLog = Number.parseInt(totalLine.match(/Total size:\s+(\d+)/)?.[1] ?? '', 10);
    if (Number.isFinite(fromLog) && fromLog !== setupSize) {
      console.warn(`  警告：日志 Total size=${fromLog} 与磁盘上的 ${setupSize} 不一致`);
    }
  }
}

say(`\n下一步：双击 ${path.relative(ROOT, outFile)} 走一遍安装向导，`);
say('然后在「设置 → 应用 → 已安装的应用」里确认 PI 出现、图标正确、能卸载。');
say('安装时会在安装包旁边写一份 PI-安装日志.txt（纯 ASCII 的进度日志）：');
say('万一中途失败，把那份日志发回来就能定位停在哪一步。');
