/**
 * 第三方音源（UnblockNeteaseMusic）连通性探针 —— 排障用的小工具，不属于产品代码。
 *
 * 什么时候用它：责任链日志里出现 `unm ✗ UNM 匹配超时` 或 `unm ✗ ...` 时，
 * 先用它回答「这台机器/这个网络现在到底还能不能从第三方拿到地址」，
 * 免得在 Electron、责任链、探针之间瞎猜。
 *
 * 用法（在仓库根目录）：
 *   node scripts/probe-unm.mjs              # 默认一首歌，逐个平台计时
 *   $env:UNM_TEST_ID=186016; node scripts/probe-unm.mjs
 *
 * 它刻意**不经过 Electron**：直接 require 那个第三方包，能看到 pino 的原始报错。
 * 关键环境变量必须在 require **之前**设好——UNM 在模块加载时就读它们
 * （见 packages/source-unm/src/index.ts 里的说明）。
 */
process.env['ENABLE_FLAC'] = 'true';
process.env['JSON_LOG'] = 'true';
process.env['LOG_LEVEL'] = 'error';
process.env['FOLLOW_SOURCE_ORDER'] = 'true';

const { createRequire } = await import('node:module');
const require_ = createRequire(import.meta.url);
const match = require_('@unblockneteasemusic/server');

const songId = Number(process.env['UNM_TEST_ID'] ?? 186016);
console.log('match 是函数：', typeof match === 'function', '| 歌曲 id =', songId);

/** br=999000 表示 FLAC（fLaC 魔数被解成 999 再 ×1000），其余是 kbps。 */
function describeBr(br) {
  if (br === undefined || br === null) return 'br=?';
  return br === 999_000 ? 'br=999000（FLAC）' : `br=${br}（${Math.round(br / 1000)}kbps）`;
}

async function attempt(label, providers) {
  const started = Date.now();
  try {
    const result = await match(songId, providers);
    console.log(
      `[${label}] OK ${Date.now() - started}ms source=${result?.source} ${describeBr(result?.br)}`,
      `url=${String(result?.url).slice(0, 90)}`,
    );
  } catch (error) {
    const name = error?.constructor?.name ?? typeof error;
    console.log(`[${label}] 失败 ${Date.now() - started}ms ${name}: ${String(error).slice(0, 200)}`);
  }
}

await attempt('全部默认', undefined);
for (const provider of ['bodian', 'kugou', 'migu']) {
  await attempt(provider, [provider]);
}
console.log('诊断结束');
