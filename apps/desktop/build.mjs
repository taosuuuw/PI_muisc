import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes('--dev');

/**
 * 主进程与 preload 的打包脚本。
 *
 * 为什么用 esbuild 而不是 tsc：
 * 1. `.mjs` 主进程 + `.cjs` preload 的混合产出，esbuild 一个配置就能搞定，
 *    不必和 tsconfig 的 module 模式纠缠。
 * 2. 打包出的单文件不依赖用户机器上的任何 Node 环境（见 docs/PLAN.md §2.6）。
 *
 * 注意：`NeteaseCloudMusicApi` 是**运行时按目录结构装载**的（动态 require），
 * 因此这里完全不碰它——由 @pi/ncm-server 在运行时解析路径并以子进程方式拉起。
 *
 * 同理，第三方音源 `@unblockneteasemusic/server` 也**必须在 external 里**：
 * 它是 LGPL-3.0 的独立模块（不打包才能满足 relink 要求），而且它的 pino 依赖
 * 用的是动态 require + worker 线程，被 bundle 进来就会炸。它由 @pi/source-unm
 * 在运行时用 `createRequire` 装载。
 */

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: [
    'electron',
    '@unblockneteasemusic/server',
    // pino 系列的动态 require/worker 在 bundle 里不可用；上面这个包被 external 之后
    // 它们走运行时解析，这里一并列出只是防止以后有人改成静态 import。
    'pino',
    'pino-pretty',
    'thread-stream',
  ],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
};

// ESM 产物里没有 require/__dirname，注入一个，防止被 bundle 进来的 CJS 依赖炸掉。
const cjsInteropBanner = [
  "import { createRequire as __piCreateRequire } from 'node:module';",
  "import { fileURLToPath as __piFileURLToPath } from 'node:url';",
  "import { dirname as __piDirname } from 'node:path';",
  'const require = __piCreateRequire(import.meta.url);',
  'const __filename = __piFileURLToPath(import.meta.url);',
  'const __dirname = __piDirname(__filename);',
].join('\n');

await build({
  ...shared,
  entryPoints: [path.join(here, 'src/main/index.ts')],
  outfile: path.join(here, 'out/main.mjs'),
  format: 'esm',
  banner: { js: cjsInteropBanner },
});

await build({
  ...shared,
  entryPoints: [path.join(here, 'src/preload/index.ts')],
  // sandbox: true 的 preload 必须是 CJS，不能用 ESM。
  outfile: path.join(here, 'out/preload.cjs'),
  format: 'cjs',
});

console.log(`[pi] desktop 构建完成（${dev ? 'dev' : 'production'}）`);
