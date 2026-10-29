/**
 * 准备 Beat This! 的推理资源（P3）。
 *
 * 两样东西都不进仓库（`.gitignore` 里已排除）：
 *   - `beat_this.onnx`：83MB 的 final0 模型（`mosynthkey/beat_this_cpp` 的官方 ONNX 导出）；
 *   - `ort-wasm-simd-threaded.{wasm,mjs}`：onnxruntime-web 1.31.1 的 WASM 与加载器。
 *
 * 模型走 `ghfast.top` 镜像 + Range 分块（GitHub raw 的 83MB 直连在本机会被连接重置）；
 * runtime 用 npmmirror 的 tarball。`ort.bundle.min.mjs` 是源码依赖（417KB），直接放进
 * `apps/renderer/src/vendor/ort/`，由 Vite 打包。
 *
 * 跑法：node scripts/fetch-beatthis-model.mjs
 * 幂等：已存在且大小对得上就跳过。
 */
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ORT_DIR = join(ROOT, 'apps/desktop/resources/ort');
const VENDOR_DIR = join(ROOT, 'apps/renderer/src/vendor/ort');
const TMP_DIR = join(ROOT, '.tmp');
const MODEL = join(ORT_DIR, 'beat_this.onnx');
const MODEL_BYTES = 83_077_778;

const MODEL_URLS = [
  'https://ghfast.top/https://raw.githubusercontent.com/mosynthkey/beat_this_cpp/main/onnx/beat_this.onnx',
  'https://ghproxy.net/https://raw.githubusercontent.com/mosynthkey/beat_this_cpp/main/onnx/beat_this.onnx',
];
const RUNTIME_TGZ = 'https://registry.npmmirror.com/onnxruntime-web/-/onnxruntime-web-1.31.1.tgz';
const CHUNK = 4 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(ORT_DIR, { recursive: true });
mkdirSync(VENDOR_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

async function fetchRange(base, start, end) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(base, { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status !== 206) throw new Error(`status ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== end - start + 1) throw new Error(`short ${buf.length}`);
      return buf;
    } catch (error) {
      console.log(`  重试 ${start}-${end} #${attempt + 1}：${String(error).slice(0, 60)}`);
      await sleep(600 * (attempt + 1));
    }
  }
  return undefined;
}

async function ensureModel() {
  if (existsSync(MODEL) && statSync(MODEL).size === MODEL_BYTES) {
    console.log('模型已就绪，跳过。');
    return;
  }
  for (const base of MODEL_URLS) {
    try {
      const head = await fetch(base, { headers: { Range: 'bytes=0-0' } });
      if (head.status !== 206) continue;
      console.log(`从 ${base.split('/')[2]} 下载模型（分块）…`);
      const fd = openSync(MODEL, 'w');
      for (let start = 0; start < MODEL_BYTES; start += CHUNK) {
        const end = Math.min(MODEL_BYTES - 1, start + CHUNK - 1);
        const buf = await fetchRange(base, start, end);
        if (!buf) throw new Error('分块下载失败');
        writeSync(fd, buf, 0, buf.length, start);
      }
      closeSync(fd);
      if (statSync(MODEL).size !== MODEL_BYTES) throw new Error('大小不对');
      console.log('模型下载完成。');
      return;
    } catch (error) {
      console.log(`镜像失败：${String(error).slice(0, 80)}`);
    }
  }
  throw new Error('所有镜像都失败了，模型没下载下来');
}

async function ensureRuntime() {
  const need = ['ort-wasm-simd-threaded.wasm'];
  const allThere =
    need.every((name) => existsSync(join(ORT_DIR, name))) &&
    existsSync(join(VENDOR_DIR, 'ort.min.mjs')) &&
    existsSync(join(VENDOR_DIR, 'ort-wasm-simd-threaded.mjs'));
  if (allThere) {
    console.log('runtime 已就绪，跳过。');
    return;
  }
  const tgz = join(TMP_DIR, 'onnxruntime-web-1.31.1.tgz');
  if (!existsSync(tgz)) {
    console.log('下载 onnxruntime-web…');
    const res = await fetch(RUNTIME_TGZ);
    if (!res.ok) throw new Error(`runtime HTTP ${res.status}`);
    const fd = openSync(tgz, 'w');
    writeSync(fd, Buffer.from(await res.arrayBuffer()));
    closeSync(fd);
  }
  const unpack = join(TMP_DIR, 'ort-unpack');
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', unpack, '--strip-components=1']);
  const dist = join(unpack, 'dist');
  for (const name of need) copyFileSync(join(dist, name), join(ORT_DIR, name));
  /*
   * 只 vendor「外部 wasm」入口（ort.min.mjs + 加载器），不 vendor 完整 bundle：
   * - 完整 bundle 会在运行时动态 import 加载器，而打包态页面是 `file://`，
   *   Chromium 不允许它 import 跨源模块（实测报 "Failed to fetch dynamically imported module"）；
   * - 外部入口把加载器作为普通模块打进 bundle，运行时只需要 fetch 一个 `.wasm` 二进制，
   *   而 http 的 fetch 在 file:// 页面里是通的（CORS `*`）。
   */
  copyFileSync(join(dist, 'ort.min.mjs'), join(VENDOR_DIR, 'ort.min.mjs'));
  copyFileSync(join(dist, 'ort-wasm-simd-threaded.mjs'), join(VENDOR_DIR, 'ort-wasm-simd-threaded.mjs'));
  console.log('runtime 就位。');
}

await ensureModel();
await ensureRuntime();
console.log('全部就绪：', ORT_DIR);
