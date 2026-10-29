/**
 * Beat This! 接入探针（不属于应用功能）。
 *
 * 目的：在真实 Chromium 里证明三件事，再把推理接进应用：
 *   1. onnxruntime-web（WASM）能加载 83MB 的 `beat_this.onnx`；
 *   2. 我们手写的 128 带 log-Mel 前处理（`mel.ts`）喂进去能得到合理输出；
 *   3. beat logits 的峰值间隔与合成节拍的 BPM 对得上。
 *
 * 用 12 秒 / 120 BPM 的合成节拍 WAV：如果模型正常，beat 输出的峰值应该每 25 帧
 * （22050/441 = 50 帧/秒，0.5 秒 = 25 帧）出现一次。
 *
 * 跑法：npx electron --no-sandbox scripts/probe-beatthis.cjs
 */
const { app, BrowserWindow } = require('electron');
const { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { buildSync } = require('esbuild');

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, '.tmp');
mkdirSync(OUT_DIR, { recursive: true });
const OUT_JSON = join(OUT_DIR, 'probe-beatthis.json');
const OUT_LOG = join(OUT_DIR, 'probe-beatthis.log');
const trace = (line) => appendFileSync(OUT_LOG, `[${new Date().toISOString()}] ${line}\n`);
writeFileSync(OUT_LOG, '');

const ORT_DIR = join(ROOT, '.tmp/ort/dist');
const MODEL = join(ROOT, 'apps/renderer/public/models/beat_this.onnx');
const MEL_ENTRY = join(ROOT, 'apps/renderer/src/lib/transition/mel.ts');

for (const file of [MODEL, join(ORT_DIR, 'ort.bundle.min.mjs'), join(ORT_DIR, 'ort-wasm-simd-threaded.wasm')]) {
  if (!existsSync(file)) {
    console.error('缺文件：', file);
    process.exit(1);
  }
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

const bundle = buildSync({
  entryPoints: [MEL_ENTRY],
  bundle: true,
  format: 'iife',
  globalName: 'PI_MEL',
  platform: 'browser',
  write: false,
});
const MEL_JS = bundle.outputFiles[0].text;

const RATE = 22_050;
const SECONDS = 12;
const BPM = 120;

function makeBeatWav() {
  const length = SECONDS * RATE;
  const data = new Float32Array(length);
  const interval = 60 / BPM;
  for (let time = 0; time < SECONDS; time += interval) {
    const start = Math.floor(time * RATE);
    const frames = Math.floor(0.06 * RATE);
    for (let i = 0; i < frames && start + i < length; i += 1) {
      const decay = 1 - i / frames;
      data[start + i] = Math.sin((2 * Math.PI * 1000 * i) / RATE) * 0.8 * decay;
    }
  }
  const bytes = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i += 1) bytes.writeInt16LE(Math.round(data[i] * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}

const WAV = makeBeatWav();

function serveFile(res, path, contentType) {
  const stat = statSync(path);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(stat.size),
    'access-control-allow-origin': '*',
  });
  createReadStream(path).pipe(res);
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  try {
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (path === '/mel.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' });
      res.end(MEL_JS);
      return;
    }
    if (path === '/beat.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(WAV.length) });
      res.end(WAV);
      return;
    }
    if (path === '/model.onnx') {
      serveFile(res, MODEL, 'application/octet-stream');
      return;
    }
    if (path.startsWith('/ort/')) {
      const name = path.slice('/ort/'.length);
      const file = join(ORT_DIR, name);
      if (!existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      serveFile(res, file, name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});

const page = `<!doctype html><meta charset="utf-8"><body>
<script src="/mel.js"></script>
<script>
window.__err = null;
window.__bootState = 'pending';
window.__ready = (async () => {
  try {
    const ort = await import('/ort/ort.bundle.min.mjs');
    ort.env.wasm.wasmPaths = '/ort/';
    ort.env.wasm.numThreads = 1;
    window.__ort = ort;
    window.__bootState = 'imported';
    window.__run = async () => {
      const out = {};
      const t0 = performance.now();
      const modelBytes = new Uint8Array(await (await fetch('/model.onnx')).arrayBuffer());
      out.modelBytes = modelBytes.length;
      const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
      out.loadMs = Math.round(performance.now() - t0);
      out.inputNames = session.inputNames;
      out.outputNames = session.outputNames;

      const wav = await (await fetch('/beat.wav')).arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 22050);
      const buffer = await ctx.decodeAudioData(wav.slice(0));
      const samples = PI_MEL.logMelSpectrogram(buffer.getChannelData(0), 22050);
      out.melFrames = samples.frames;
      out.melBands = samples.bands;

      const frames = samples.frames;
      const bands = samples.bands;
      const input = new Float32Array(frames * bands);
      input.set(samples.data);
      const tensor = new ort.Tensor('float32', input, [1, frames, bands]);
      const t1 = performance.now();
      const result = await session.run({ input_spectrogram: tensor });
      out.inferMs = Math.round(performance.now() - t1);
      const beat = result.beat.data;
      const downbeat = result.downbeat.data;
      out.beatLen = beat.length;
      out.downbeatLen = downbeat.length;
      let maxBeat = -Infinity;
      let maxDown = -Infinity;
      for (const v of beat) maxBeat = Math.max(maxBeat, v);
      for (const v of downbeat) maxDown = Math.max(maxDown, v);
      out.maxBeat = Math.round(maxBeat * 1000) / 1000;
      out.maxDownbeat = Math.round(maxDown * 1000) / 1000;

      const peaks = [];
      for (let i = 1; i < beat.length - 1; i += 1) {
        if (beat[i] > 0.5 && beat[i] >= beat[i - 1] && beat[i] >= beat[i + 1]) peaks.push(i);
      }
      out.peakCount = peaks.length;
      out.firstPeaks = peaks.slice(0, 8);
      if (peaks.length >= 3) {
        const gaps = [];
        for (let i = 1; i < peaks.length; i += 1) gaps.push(peaks[i] - peaks[i - 1]);
        gaps.sort((a, b) => a - b);
        const median = gaps[Math.floor(gaps.length / 2)];
        out.medianGapFrames = median;
        out.bpm = Math.round(((60 * (22050 / 441)) / median) * 10) / 10;
      }
      return out;
    };
    return 'ok';
  } catch (error) {
    window.__err = String((error && error.stack) || error);
    window.__bootState = 'failed';
    return 'fail';
  }
})();
</script></body>`;

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  trace('listening ' + port);

  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    trace(`[renderer:${level}] ${message}`);
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  trace('page loaded');
  const boot = await win.webContents.executeJavaScript('window.__ready');
  const bootError = await win.webContents.executeJavaScript('window.__err');
  trace('boot=' + boot + ' err=' + String(bootError));
  if (boot !== 'ok') {
    console.error('[probe] 页面启动失败：', bootError);
    win.destroy();
    server.close();
    app.quit();
    return;
  }

  const result = await win.webContents.executeJavaScript('window.__run()');
  writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  trace('result: ' + JSON.stringify(result));

  const verdict = {
    model: result && result.modelBytes > 80_000_000,
    outputs: result && result.outputNames?.includes('beat') && result.outputNames?.includes('downbeat'),
    beats: result && result.peakCount > 10,
    bpm: result && result.bpm !== undefined && Math.abs(result.bpm - 120) < 6,
  };
  console.log('\n===== Beat This! 探针 =====');
  console.log(JSON.stringify(result, null, 2));
  console.log('判定：', JSON.stringify(verdict));
  const passed = Object.values(verdict).every(Boolean);
  console.log(passed ? '[PASS] 模型能跑，拍点与合成节拍一致。' : '[FAIL] 见上面数值。');
  win.destroy();
  server.close();
  app.quit();
}

app.whenReady().then(main).catch((error) => {
  trace('main failed: ' + (error && error.stack));
  console.error('[probe] 失败：', error);
  app.quit();
});

setTimeout(() => {
  trace('timeout');
  console.error('[probe] 超时');
  app.quit();
}, 180_000).unref();
