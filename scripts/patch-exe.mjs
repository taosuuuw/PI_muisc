#!/usr/bin/env node
/**
 * 改写 Windows PE 的**内嵌资源**：图标（RT_ICON / RT_GROUP_ICON）+ 版本信息（RT_VERSION）。
 *
 * 为什么必须有这一步：`pi.exe` 本质是 `electron.exe` 改了名字，而「exe 的名字」和
 * 「exe 自己声称自己是谁」是两回事。任务管理器「进程」页、exe 属性页的「详细信息」、
 * 文件资源管理器里的大图标、安装包内嵌图标 —— 全部读的是 PE 资源，不看文件名。
 * 所以不写资源，PI 就永远显示成 Electron。
 *
 * 用纯 JS 的 resedit 实现，不需要 rcedit / Resource Hacker，不需要网络、不需要管理员权限。
 *
 * 用法：
 *   node scripts/patch-exe.mjs <exe 路径> [选项]
 *
 * 选项：
 *   --ico <file>        图标文件（默认 build/pi-embed.ico，回退 build/pi.ico）
 *   --product <name>    ProductName        （默认 PI）
 *   --desc <text>       FileDescription    （默认 "PI —— 桌面音乐应用"）
 *   --company <name>    CompanyName        （默认 PI）
 *   --version <x.y.z>   FileVersion/ProductVersion（默认取仓库根 package.json 的 version）
 *   --copyright <text>  LegalCopyright     （默认 "© 2026 PI"）
 *   --quiet             少打印
 *   --verify-only       只读并打印当前资源，不改写
 *
 * 注意：
 *  · 目标 exe **不能正在运行**（文件被占用时 Windows 会拒绝写入）。
 *  · `ignoreCert: true` 会让 resedit 丢弃原有的 Authenticode 签名 —— 这是必须的：
 *    改写后的文件签名必然失效，留着坏签名比没有签名更容易触发 SmartScreen 拦截。
 *  · Electron 运行时（*.dll / *.pak / icudtl.dat / locales）**不要**改写，只改主 exe。
 *  · Electron 的 MIT 许可证文本随发行包一起提供（packaging 时确认 dist 里的 LICENSE 被带上）。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ResEdit from 'resedit';
import { ensureMediumIntegrity } from './lib/integrity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* 资源类型常量：PE 规范里 RT_ICON=3、RT_GROUP_ICON=14、RT_VERSION=16、RT_MANIFEST=24 */
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;
const RT_MANIFEST = 24;

const TYPE_NAMES = {
  1: 'CURSOR',
  2: 'BITMAP',
  3: 'ICON',
  4: 'MENU',
  5: 'DIALOG',
  6: 'STRING',
  7: 'FONTDIR',
  8: 'FONT',
  9: 'ACCELERATOR',
  10: 'RCDATA',
  11: 'MESSAGETABLE',
  12: 'GROUP_CURSOR',
  14: 'GROUP_ICON',
  16: 'VERSION',
  17: 'DLGINCLUDE',
  19: 'PLUGPLAY',
  20: 'VXD',
  21: 'ANICURSOR',
  22: 'ANIICON',
  23: 'HTML',
  24: 'MANIFEST',
};

const typeName = (type) => TYPE_NAMES[type] ?? `TYPE_${type}`;

/* ---------------------------------------------------------------- 参数解析 */

function parseArgs(argv) {
  const opts = {
    exe: undefined,
    ico: undefined,
    product: 'PI',
    desc: 'PI —— 桌面音乐应用',
    company: 'PI',
    version: undefined,
    copyright: '© 2026 PI',
    quiet: false,
    verifyOnly: false,
  };
  const rest = [];
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
      case '--ico':
        opts.ico = next();
        break;
      case '--product':
        opts.product = next();
        break;
      case '--desc':
        opts.desc = next();
        break;
      case '--company':
        opts.company = next();
        break;
      case '--version':
        opts.version = next();
        break;
      case '--copyright':
        opts.copyright = next();
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--verify-only':
        opts.verifyOnly = true;
        break;
      case '-h':
      case '--help':
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`未知选项：${arg}`);
          process.exit(2);
        }
        rest.push(arg);
    }
  }
  opts.exe = opts.exe ?? rest[0];
  if (!opts.exe) {
    console.error('用法：node scripts/patch-exe.mjs <exe 路径> [--ico build/pi-embed.ico] ...');
    process.exit(2);
  }
  if (!opts.version) {
    const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    opts.version = rootPkg.version;
  }
  return opts;
}

/* ------------------------------------------------------------------ 工具 */

/** 打印一个 PE 的资源条目 + 版本串 —— 改写前后都用它核对，肉眼可验证。 */
function dumpResources(exe, { title }) {
  const res = ResEdit.NtExecutableResource.from(exe);
  const groups = new Map();
  for (const entry of res.entries) {
    const key = typeName(entry.type);
    const list = groups.get(key) ?? [];
    list.push(`${entry.id}@${entry.lang}`);
    groups.set(key, list);
  }
  console.log(`  ${title} 资源表：`);
  for (const [key, list] of groups) {
    console.log(`    ${key}: ${list.join(', ')}`);
  }
  const versionInfos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  for (const vi of versionInfos) {
    for (const language of vi.getAllLanguagesForStringValues()) {
      const values = vi.getStringValues(language);
      console.log(`  ${title} 版本串（lang=${language.lang} codepage=${language.codepage}）：`);
      for (const key of Object.keys(values).sort()) {
        console.log(`    ${key} = ${JSON.stringify(values[key])}`);
      }
    }
  }
  const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  for (const group of iconGroups) {
    /* 尺寸以图标组资源自己的记录为准（这是资源管理器读的那份）。
       组里 256 的条目在 ICONDIRENTRY 里按规范写成 0，所以 0 要还原成 256。
       不要用 getIconItemsFromEntries 回来的 bitmapInfo.height —— 那是 BMP 帧里
       写了两倍高度（AND 掩码）的那个值，直接打印会得到 256x512 这种假尺寸。 */
    const sizes = group.icons.map((icon) => {
      const width = icon.width === 0 ? 256 : icon.width;
      const height = icon.height === 0 ? 256 : icon.height;
      return `${width}x${height}`;
    });
    console.log(`  ${title} 图标组 id=${group.id} lang=${group.lang}：${sizes.join(', ')}`);
  }
  return res;
}

/* ------------------------------------------------------------------ 主流程 */

const opts = parseArgs(process.argv.slice(2));

const exePath = path.resolve(opts.exe);
if (!existsSync(exePath)) {
  console.error(`找不到文件：${exePath}`);
  process.exit(1);
}

const before = statSync(exePath);
console.log(`目标：${exePath}（${(before.size / 1024 / 1024).toFixed(2)} MB）`);

const rawBuffer = readFileSync(exePath);
const exe = ResEdit.NtExecutable.from(rawBuffer, { ignoreCert: true });

if (opts.verifyOnly) {
  dumpResources(exe, { title: '当前' });
  process.exit(0);
}

/* 1) 图标：先删掉旧的 RT_ICON / RT_GROUP_ICON，再整组写入 */
let icoPath = opts.ico;
if (icoPath) icoPath = path.resolve(icoPath);
else {
  const embed = path.join(ROOT, 'build', 'pi-embed.ico');
  icoPath = existsSync(embed) ? embed : path.join(ROOT, 'build', 'pi.ico');
}
if (!existsSync(icoPath)) {
  console.error(`找不到图标：${icoPath}（先执行 \`pnpm icon\` 生成 build/pi.ico）`);
  process.exit(1);
}
const iconFile = ResEdit.Data.IconFile.from(readFileSync(icoPath));
const icons = iconFile.icons.map((item) => item.data);
if (icons.length === 0) {
  console.error(`图标文件里没有任何图像：${icoPath}`);
  process.exit(1);
}

const res = ResEdit.NtExecutableResource.from(exe);
const oldIconCount = res.entries.filter((e) => e.type === RT_ICON || e.type === RT_GROUP_ICON).length;
res.removeResourceEntry(RT_ICON);
res.removeResourceEntry(RT_GROUP_ICON);
/* replaceIconsForResource 会**原地**改写传入的数组，所以必须传 res.entries 本身 */
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  1,
  1033,
  icons,
);
console.log(
  `图标：${path.relative(ROOT, icoPath)} → RT_ICON/RT_GROUP_ICON` +
    `（清掉 ${oldIconCount} 条旧条目，写入 ${icons.length} 个尺寸：` +
    iconFile.icons
      .map((item) => `${item.width ?? '?'}x${item.height ?? '?'}`)
      .join(', ') +
    '）',
);

/* 2) 版本信息 */
let versionInfos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (versionInfos.length === 0) {
  const created = ResEdit.Resource.VersionInfo.createEmpty();
  created.lang = 1033;
  created.outputToResourceEntries(res.entries);
  versionInfos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  console.log('版本信息：原本没有 RT_VERSION，已新建（lang=1033）');
}

const values = {
  CompanyName: opts.company,
  FileDescription: opts.desc,
  /* FileVersion / ProductVersion 的字符串由 setFileVersion / setProductVersion 写，
     这里再显式写一遍是防止固定信息与字符串表不同步。 */
  FileVersion: opts.version,
  InternalName: 'pi.exe',
  LegalCopyright: opts.copyright,
  OriginalFilename: 'pi.exe',
  ProductName: opts.product,
  ProductVersion: opts.version,
};

for (const vi of versionInfos) {
  let languages = vi.getAllLanguagesForStringValues();
  if (languages.length === 0) languages = [{ lang: 1033, codepage: 1200 }];
  for (const language of languages) {
    vi.setStringValues(language, values, true);
    /* SquirrelAwareVersion 是 Squirrel.Windows / electron-updater 的标记，PI 用 NSIS，留着会误导 */
    vi.removeStringValue(language, 'SquirrelAwareVersion', false);
  }
  vi.setFileVersion(opts.version, 1033);
  vi.setProductVersion(opts.version, 1033);
  vi.outputToResourceEntries(res.entries);
}
console.log(
  `版本信息：ProductName=${opts.product} FileDescription=${opts.desc} ` +
    `CompanyName=${opts.company} version=${opts.version}（已移除 SquirrelAwareVersion）`,
);

/* 3) 落盘 */
res.outputResource(exe);
const output = Buffer.from(exe.generate());

try {
  writeFileSync(exePath, output);
} catch (error) {
  if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES') {
    console.error(`\n写不进去：${exePath}`);
    console.error('该文件正在被占用。请先关掉所有 PI / electron 进程，再重跑本脚本。');
    console.error(`（原始错误：${error.code} ${error.message}）`);
    process.exit(1);
  }
  throw error;
}

const after = statSync(exePath);
console.log(`已写入：${exePath}（${(after.size / 1024 / 1024).toFixed(2)} MB）`);

/* 3b) 完整性标签。新写出来的 exe 会**继承所在目录**的强制完整性标签。如果构建目录带
   `Low Mandatory Level:(OI)(CI)(NW)`，产出的 exe 双击后就是 Low 完整性进程 —— 它写不了
   Medium 对象（%LOCALAPPDATA%、%TEMP%、HKCU），于是「装不上」。这里显式改回 Medium；
   失败只警告，不影响上面图标 / 版本改写的结果。 */
process.stdout.write('完整性标签：');
const integrity = ensureMediumIntegrity(exePath, (message) => console.log(message));
if (!integrity.ok) {
  console.warn(`警告：没能把 ${path.basename(exePath)} 的完整性标签改成 Medium（当前 ${integrity.label ?? '未知'}）。`);
  console.warn('      这种 exe 双击后可能装不上（写 %LOCALAPPDATA% 会被拒绝）。');
}

/* 4) 回读校验：重新解析磁盘上的文件，确认改动真的生效（而不是只改了内存对象） */
const check = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
dumpResources(check, { title: '回读' });

if (opts.quiet) process.exit(0);
console.log('\n用 PowerShell 交叉核对（等价于资源管理器看到的）：');
console.log(`  (Get-Item '${exePath}').VersionInfo | Format-List *`);
