/**
 * 共享的「应用目录装配」逻辑。
 *
 * 为什么单独抽一个模块：PI 现在有**两种**发行形态，它们的「应用目录」是同一个东西：
 *   · 便携版   —— `scripts/make-dist.mjs`  产出 `release/pi/resources/app/`
 *   · 安装包   —— `scripts/make-installer.mjs` 产出 electron-builder 的 app 目录
 * 两份产物必须包含**逐字节相同**的 out / renderer/dist / 运行时 node_modules，否则
 * 「便携版能放歌、安装版放不了」这类问题会以最难查的方式出现。所以复制逻辑只留一份。
 *
 * 这里只关心「应用目录」本身（主进程产物 + 清单 + 渲染层 + 运行时依赖），
 * 不碰 Electron 运行时、图标、卸载器、安装包外壳 —— 那些由各自的脚本负责。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * 运行时必须随包走的「外部依赖」种子。种子只需写应用**直接**引用、且打包器
 * 不敢 bundle 的那几个包；它们的传递依赖由依赖树递归展开自动跟上。
 *
 * 为什么这些包不能靠打包器 bundle：见 make-dist.mjs 头部注释 ——
 * `NeteaseCloudMusicApi` 用 fs.readdirSync + 动态 require 装路由；
 * `@unblockneteasemusic/server` 由 source-unm 用 createRequire 装载（LGPL 要求不打包）；
 * `pino` / `pino-pretty` 是动态 require。
 *
 * 这里曾经还有 `thread-stream`（pino v7 起才有的传递依赖），但本仓库装的是 pino v6，
 * 那个包根本不存在 —— 于是每次打包都刷一条「没找到的依赖」的假警告。删掉即可：
 * 将来真升到 pino v7，它会作为 `pino` 的 dependencies 被上面那套递归自动带上。
 */
export const NM_SEEDS = [
  'NeteaseCloudMusicApi',
  '@unblockneteasemusic/server',
  'pino',
  'pino-pretty',
];

export const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/** 递归统计目录的文件数与字节数（读不到的文件按 0 计，不抛错）。 */
export function measure(dir) {
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
        info = statSync(full);
      } catch {
        continue;
      }
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

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function requireFile(file, why) {
  if (!existsSync(file)) {
    console.error(`缺少构建产物：${file}`);
    console.error(why);
    process.exit(1);
  }
}

/**
 * 解析一个包的真实目录。先走 Node 的解析算法（`fromDir` 优先，再回退仓库根），
 * 解析不到时再手写兜底查 `<base>/node_modules/<name>`：某些包的 `exports` 字段
 * 不含 `./package.json`，`require.resolve('x/package.json')` 会直接抛错。
 */
export function resolvePackageDir(name, fromDir, root) {
  const bases = fromDir ? [fromDir, root] : [root];
  for (const base of bases) {
    try {
      const req = createRequire(path.join(base, '__pi_resolve__.cjs'));
      return path.dirname(req.resolve(`${name}/package.json`));
    } catch {
      /* 走手写兜底 */
    }
    const guess = path.join(base, 'node_modules', ...name.split('/'));
    if (existsSync(path.join(guess, 'package.json'))) return guess;
  }
  return undefined;
}

/**
 * 展开运行时依赖树：从种子出发，递归读每个包的 `dependencies` /
 * `optionalDependencies`，得到「包名 → 真实目录」的完整计划。
 */
export function planRuntimeDeps({ root, seeds = NM_SEEDS }) {
  const planned = new Map();
  const missing = [];
  const queue = seeds.map((name) => ({ name, from: undefined }));
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    if (planned.has(name)) continue;
    const dir = resolvePackageDir(name, from, root);
    if (!dir) {
      missing.push(name);
      continue;
    }
    planned.set(name, dir);
    let pkg;
    try {
      pkg = readJson(path.join(dir, 'package.json'));
    } catch {
      continue;
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
    for (const dep of Object.keys(deps)) {
      if (!planned.has(dep)) queue.push({ name: dep, from: dir });
    }
  }
  return { planned, missing };
}

/**
 * 把一个仓库里的「应用」装配到 `dest`：
 *   dest/package.json         最小清单（name=pi / main=out/main.mjs，**故意不写 dependencies**）
 *   dest/out/                 主进程 esbuild 产物（main.mjs + preload.cjs）
 *   dest/renderer/dist/       渲染层产物（index.html + assets/）
 *   dest/node_modules/        运行时外部依赖（递归依赖树，扁平布局）
 *
 * 「清单里不写 dependencies」是有意的：安装包链路要让 electron-builder 认为
 * 这个 app 没有任何要安装的依赖，否则它会自己跑 install/prune，把这里精心
 * 复制好的 node_modules 冲掉。packaging 只负责把已有文件搬进去。
 *
 * @returns {{ appPkg: object, desktopOut: string, rendererDist: string, skippedMaps: number,
 *             nm: { copied: number, bytes: number, missing: string[], nestedSkipped: string[], capped: boolean } }}
 */
export function assembleAppDir({
  root,
  dest,
  keepSourcemaps = false,
  skipNodeModules = false,
  maxNmMb = 250,
  log = () => {},
}) {
  const rootPkg = readJson(path.join(root, 'package.json'));
  const desktopOut = path.join(root, 'apps', 'desktop', 'out');
  const rendererDist = path.join(root, 'apps', 'renderer', 'dist');

  requireFile(
    path.join(desktopOut, 'main.mjs'),
    '先执行 `pnpm -F @pi/desktop build`（或 `pnpm build`）。',
  );
  requireFile(
    path.join(desktopOut, 'preload.cjs'),
    '先执行 `pnpm -F @pi/desktop build`（或 `pnpm build`）。',
  );
  requireFile(
    path.join(rendererDist, 'index.html'),
    '先执行 `pnpm -F @pi/renderer build`（渲染层产物缺失时应用只会显示一张「产物缺失」提示页）。',
  );

  mkdirSync(dest, { recursive: true });
  mkdirSync(path.join(dest, 'out'), { recursive: true });

  /* 主进程 + 清单 */
  cpSync(desktopOut, path.join(dest, 'out'), { recursive: true, dereference: true });

  const appPkg = {
    name: 'pi',
    productName: 'PI',
    version: rootPkg.version,
    private: true,
    description: rootPkg.description ?? 'PI —— 桌面音乐应用',
    main: 'out/main.mjs',
    license: 'UNLICENSED',
  };
  writeFileSync(path.join(dest, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`, 'utf8');
  log(`主进程 → ${path.join(dest, 'out')}，清单 package.json（name=${appPkg.name}, main=${appPkg.main}）`);

  /* 渲染层（默认跳过 sourcemap） */
  let skippedMaps = 0;
  cpSync(rendererDist, path.join(dest, 'renderer', 'dist'), {
    recursive: true,
    dereference: true,
    filter: (src) => {
      if (!keepSourcemaps && src.toLowerCase().endsWith('.map')) {
        skippedMaps += 1;
        return false;
      }
      return true;
    },
  });
  log(
    `渲染层 → ${path.join(dest, 'renderer', 'dist')}` +
      (keepSourcemaps ? '，含 sourcemap' : `，跳过 ${skippedMaps} 个 .map`),
  );

  /* 运行时依赖 */
  const nm = { copied: 0, bytes: 0, missing: [], nestedSkipped: [], capped: false };
  if (skipNodeModules) {
    log('跳过运行时 node_modules：应用能开窗，但音源解析会失败。');
  } else {
    const { planned, missing } = planRuntimeDeps({ root });
    const destRoot = path.join(dest, 'node_modules');
    const maxBytes = maxNmMb * 1024 * 1024;
    for (const [name, dir] of planned) {
      const nested = path.join(dir, 'node_modules');
      if (existsSync(nested)) {
        const nestedInfo = measure(nested);
        nm.nestedSkipped.push(`${name}(${nestedInfo.files} 个文件/${mb(nestedInfo.bytes)})`);
      }
      const target = path.join(destRoot, ...name.split('/'));
      const { bytes } = measure(dir);
      if (nm.bytes + bytes > maxBytes) {
        nm.capped = true;
        break;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      // **整包原样搬**，包含包内自带的嵌套 node_modules：
      // 实测依赖树里有 7 处版本冲突（qrcode→yargs@15 vs 顶层 yargs@17、
      // axios→agent-base@6 vs 顶层 @7 等），只搬扁平层会让这些包 resolve 到错误版本。
      // 嵌套目录一共才十几项、几百 KB，原样保留最安全（Node 解析也是「先看包内 node_modules」）。
      cpSync(dir, target, { recursive: true, dereference: true });
      nm.copied += 1;
      nm.bytes += bytes;
    }
    nm.missing = missing;
    log(
      `运行时依赖 → ${destRoot}（${nm.copied} 个包，${mb(nm.bytes)}）` +
        (nm.capped ? `【已达 ${maxNmMb} MB 上限，提前停手，剩下的没搬】` : ''),
    );
    if (missing.length > 0) {
      log(`⚠ 没找到的依赖（启动时可能报「未安装 xxx」）：${missing.join(', ')}`);
    }
    if (nm.nestedSkipped.length > 0) {
      log(
        `ℹ 包内嵌套 node_modules 已原样保留（保版本正确）：${nm.nestedSkipped.slice(0, 8).join(', ')}` +
          (nm.nestedSkipped.length > 8 ? ` 等 ${nm.nestedSkipped.length} 个` : ''),
      );
    }
  }

  return { appPkg, desktopOut, rendererDist, skippedMaps, nm };
}
