#!/usr/bin/env node
/**
 * PI 仓库清理脚本（零依赖，纯 Node）。
 *
 * 设计原则：**默认 dry-run**，只报告会删什么、能释放多少；加 `--apply` 才真的删。
 * 只删**可再生**的东西，白名单写死在这里，任何一条不匹配就绝不碰：
 *
 *   1. 根目录 `./.gate-*`   —— 门禁/冒烟日志（`*.log` / `*.err` / `*.out`），跑一次门禁就重新产出
 *   2. 根目录 `./.tmp-*`    —— 临时探针脚本与输出（只删**文件**，`.tmp-*` 目录一律跳过）
 *   3. 根目录 `./*.log`     —— 零散日志（`cad-test.log` / `typecheck.log` / `pi-launch*.log` …）
 *   4. `.turbo/cache`       —— turbo 自己的缓存目录，下一次 `pnpm build` 会重建
 *
 * 明确**不删**（即使它们看起来像垃圾）：`node_modules/`、各 app 的 `dist/` 目录、
 * `apps/desktop/out/`、`docs/**`（截图是验收证据）、`build/pi.ico`、任何源码、
 * `.tmp/` `.smoke-profile/` `.ui-profile/` 等目录（里面有登录态 / 用户数据）。
 *
 * 用法：
 *   node scripts/clean.mjs                 # dry-run，只报告
 *   node scripts/clean.mjs --apply         # 真的删
 *   node scripts/clean.mjs --apply --json  # 机器可读结果
 *
 * 退出码：0 = 正常；1 = 安全检查未通过（例如仓库根被识别成盘根）。
 */
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');
/** 单次 dry-run 里最多列举几个大文件。 */
const TOP_N = 12;

/** 白名单规则：只作用于 `ROOT` 的**直接**子项。 */
const FILE_RULES = [
  {
    id: 'gate',
    label: '门禁/冒烟日志 .gate-*',
    test: (name) => name.startsWith('.gate-'),
  },
  {
    id: 'tmp',
    label: '临时探针文件 .tmp-*',
    test: (name) => name.startsWith('.tmp-'),
  },
  {
    id: 'log',
    label: '根目录日志 *.log',
    test: (name) => name.toLowerCase().endsWith('.log'),
  },
];

/** 目录规则（只有这一条，写死绝对路径，避免手滑）。 */
const DIR_RULES = [
  {
    id: 'turbo-cache',
    label: 'turbo 构建缓存 .turbo/cache',
    target: path.join(ROOT, '.turbo', 'cache'),
  },
];

if (ROOT === path.parse(ROOT).root) {
  console.error('[clean] 安全检查失败：仓库根解析成了盘根，拒绝执行。', ROOT);
  process.exit(1);
}
if (!existsSync(path.join(ROOT, 'package.json'))) {
  console.error('[clean] 安全检查失败：%s 下没有 package.json，拒绝执行。', ROOT);
  process.exit(1);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/** 递归统计一个目录的大小（字节）与文件数，用来算 `.turbo/cache`。 */
function measureDir(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let info;
      try {
        info = lstatSync(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue; // 不跟随符号链接/junction，避免删到别处
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) {
        bytes += info.size;
        files += 1;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

const report = {
  root: ROOT,
  apply: APPLY,
  rules: [],
  skippedDirs: [],
  totalBytes: 0,
  totalFiles: 0,
  deleted: [],
  errors: [],
  remainingRootJunk: { files: 0, bytes: 0, names: [] },
};

/* ---------------- 收集（只读，无论 dry-run 还是 --apply 都先收集） ---------------- */

const claimed = new Set(); // 防止同一文件被两条规则重复计数
const rootEntries = readdirSync(ROOT, { withFileTypes: true });

for (const rule of FILE_RULES) {
  const targets = [];
  let bytes = 0;
  for (const entry of rootEntries) {
    if (!rule.test(entry.name)) continue;
    const full = path.join(ROOT, entry.name);
    if (claimed.has(full)) continue;
    let info;
    try {
      info = lstatSync(full);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue; // 根目录下的链接不动
    if (info.isDirectory()) {
      // `.tmp-*` 里有 `.tmp-band-probe/`、`.tmp-crops/` 这类真实目录：白名单只针对文件，
      // 目录里可能有截图/数据，一律跳过并单独报出来。
      if (!report.skippedDirs.some((item) => item.path === full)) {
        report.skippedDirs.push({ rule: rule.id, path: full });
      }
      continue;
    }
    if (!info.isFile()) continue;
    claimed.add(full);
    targets.push({ path: full, bytes: info.size });
    bytes += info.size;
  }
  targets.sort((a, b) => b.bytes - a.bytes);
  report.rules.push({ id: rule.id, label: rule.label, targets, bytes, count: targets.length });
  report.totalBytes += bytes;
  report.totalFiles += targets.length;
}

for (const rule of DIR_RULES) {
  const exists = existsSync(rule.target);
  const { bytes, files } = exists ? measureDir(rule.target) : { bytes: 0, files: 0 };
  report.rules.push({
    id: rule.id,
    label: rule.label,
    targets: exists ? [{ path: rule.target, bytes, dir: true }] : [],
    bytes,
    count: exists ? 1 : 0,
  });
  report.totalBytes += bytes;
  report.totalFiles += files;
}

/* ---------------- 删除（--apply） ---------------- */

if (APPLY) {
  for (const rule of report.rules) {
    for (const target of rule.targets) {
      // 二次安全检查：删除目标必须真的是本仓库根下的直接子项，或白名单里写死的那个缓存目录。
      const rel = path.relative(ROOT, target.path);
      const isRootChild = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
      const isTurboCache = path.resolve(target.path) === path.resolve(DIR_RULES[0].target);
      if (!isRootChild && !isTurboCache) {
        report.errors.push(`拒绝删除（不在白名单路径上）：${target.path}`);
        continue;
      }
      try {
        rmSync(target.path, { recursive: Boolean(target.dir), force: true });
        report.deleted.push(target.path);
      } catch (err) {
        report.errors.push(`删除失败：${target.path} —— ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/* ---------------- 顺带报告：留下的根目录 "点文件" 垃圾（不在白名单，未删） ---------------- */

const whitelisted = new Set(report.rules.flatMap((rule) => rule.targets.map((t) => t.path)));
const keepNames = new Set([
  '.gitignore',
  '.editorconfig',
  '.npmrc',
  '.prettierignore',
  '.prettierrc.json',
  '.git',
  '.github',
]);
for (const entry of rootEntries) {
  if (!entry.name.startsWith('.')) continue;
  if (keepNames.has(entry.name)) continue;
  const full = path.join(ROOT, entry.name);
  if (whitelisted.has(full)) continue;
  if (entry.isDirectory()) {
    // 目录留着（.tmp/ .smoke-profile/ .ui-profile/ 等），只列出名字。
    report.remainingRootJunk.names.push(`${entry.name}/（目录，未删）`);
    continue;
  }
  let info;
  try {
    info = lstatSync(full);
  } catch {
    continue;
  }
  report.remainingRootJunk.files += 1;
  report.remainingRootJunk.bytes += info.size;
  report.remainingRootJunk.names.push(`${entry.name}（${mb(info.size)}）`);
}

/* ---------------- 输出 ---------------- */

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[clean] 仓库根：${ROOT}`);
  console.log(`[clean] 模式：${APPLY ? 'APPLY —— 真的删' : 'DRY-RUN —— 只报告，加 --apply 才删'}`);
  console.log('');
  for (const rule of report.rules) {
    console.log(`▌ ${rule.label}：${rule.count} 项，${mb(rule.bytes)}`);
    if (rule.id === 'turbo-cache') continue;
    for (const target of rule.targets.slice(0, TOP_N)) {
      console.log(`    - ${path.basename(target.path)}  ${mb(target.bytes)}`);
    }
    if (rule.targets.length > TOP_N) {
      console.log(`    … 其余 ${rule.targets.length - TOP_N} 项略（最大 ${TOP_N} 个已列出）`);
    }
  }
  if (report.skippedDirs.length > 0) {
    console.log('');
    console.log('▌ 跳过（白名单只删文件，目录一律不碰）：');
    for (const item of report.skippedDirs) {
      const { bytes, files } = measureDir(item.path);
      console.log(`    - ${path.basename(item.path)}/  ${files} 个文件，${mb(bytes)}`);
    }
  }
  console.log('');
  console.log(`[clean] 合计可释放：${mb(report.totalBytes)}（${report.totalFiles} 个文件）`);
  if (APPLY) {
    console.log(`[clean] 实际删除：${report.deleted.length} 项`);
  }
  if (report.errors.length > 0) {
    console.log('[clean] 错误：');
    for (const err of report.errors) console.log(`    ! ${err}`);
  }
  if (report.remainingRootJunk.files > 0) {
    console.log('');
    console.log(
      `[clean] 未删（不在白名单）：根目录还有 ${report.remainingRootJunk.files} 个点文件，共 ${mb(report.remainingRootJunk.bytes)}`,
    );
    for (const name of report.remainingRootJunk.names.slice(0, 40)) console.log(`    · ${name}`);
    if (report.remainingRootJunk.names.length > 40) {
      console.log(`    … 其余 ${report.remainingRootJunk.names.length - 40} 项略`);
    }
  }
  console.log('');
  console.log(
    APPLY
      ? `[clean] 完成：释放 ${mb(report.totalBytes)}。`
      : `[clean] dry-run 结束：跑 \`node scripts/clean.mjs --apply\` 才会真的删掉这 ${mb(report.totalBytes)}。`,
  );
}

process.exit(report.errors.length > 0 ? 1 : 0);
