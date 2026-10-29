/**
 * P3 验证探针：分析管线在真实 Chromium 里的行为。
 *
 * 这个脚本**不属于应用功能**。它把 `apps/renderer/src/lib/transition/analyze.ts` 用 esbuild
 * 原样打成 IIFE 注入页面，再走一遍和 `profile-service.ts` 相同的链路：
 *
 * ```
 * fetch(wav) → OfflineAudioContext(1,1,22050).decodeAudioData → 降成单声道 → analyzeSamples
 * ```
 *
 * 用一段**人工构造的节拍音频**（120 BPM、开头 1 秒静音、结尾 2 秒静音），所以每个结果都有
 * 精确的预期：bpm≈120、头部静音≈1s、尾部静音≈2.4s。
 *
 * 这验证的是「解码 + 降采样 + 分析」这根链条在浏览器里成立，以及耗时可接受；
 * Worker 路径由类型与单测覆盖（探针页面里没有 Worker）。
 *
 * 跑法：npx electron --no-sandbox scripts/probe-analyze.cjs
 * 结果写到 .tmp/probe-analyze.json
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { buildSync } = require('esbuild');

const OUT_DIR = join(process.cwd(), '.tmp');
mkdirSync(OUT_DIR, { recursive: true });
const OUT_LOG = join(OUT_DIR, 'probe-analyze.log');
const OUT_JSON = join(OUT_DIR, 'probe-analyze.json');
const trace = (line) => {
  try {
    appendFileSync(OUT_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* 日志写不进去也不该影响测量 */
  }
};
writeFileSync(OUT_LOG, '');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

const RATE = 22_050;
const SECONDS = 12;
const BPM = 120;

/** 12 秒节拍：0~1s 静音、1~9.56s 每 0.5s 一个 60ms burst、10~12s 静音。 */
function makeBeatWav() {
  const length = SECONDS * RATE;
  const data = new Float32Array(length);
  const interval = 60 / BPM;
  for (let time = 1; time < 10; time += interval) {
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

const bundle = buildSync({
  entryPoints: [join(process.cwd(), 'apps/renderer/src/lib/transition/analyze.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'PI_ANALYZE',
  platform: 'browser',
  write: false,
});
const ANALYZE_JS = bundle.outputFiles[0].text;

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/analyze.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' });
    res.end(ANALYZE_JS);
    return;
  }
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': String(WAV.length),
    'access-control-allow-origin': '*',
  });
  res.end(req.method === 'HEAD' ? undefined : WAV);
});

const page = `<!doctype html><meta charset="utf-8"><body>
<script src="http://127.0.0.1:__PORT__/analyze.js"></script>
<script>
window.__runAnalyze = async () => {
  const BASE = 'http://127.0.0.1:__PORT__';
  const started = performance.now();
  const out = {};
  const response = await fetch(BASE + '/beat.wav');
  out.httpStatus = response.status;
  const bytes = await response.arrayBuffer();
  const t0 = performance.now();
  const context = new OfflineAudioContext(1, 1, 22050);
  const buffer = await context.decodeAudioData(bytes.slice(0));
  out.decodeMs = Math.round(performance.now() - t0);
  out.sampleRate = buffer.sampleRate;
  out.durationSec = Number(buffer.duration.toFixed(2));
  const t1 = performance.now();
  const samples = PI_ANALYZE.downmixAndDownsample(buffer, 22050);
  out.downsampleMs = Math.round(performance.now() - t1);
  out.samplesLength = samples.length;
  const t2 = performance.now();
  const profile = PI_ANALYZE.analyzeSamples(samples, 22050, Math.round(buffer.duration * 1000));
  out.analyzeMs = Math.round(performance.now() - t2);
  out.profile = profile;
  out.totalMs = Math.round(performance.now() - started);
  return out;
};
window.__probeReady = true;
</script></body>`;

async function main() {
  trace('whenReady');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  trace('server listening on ' + port);

  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const html = page.replaceAll('__PORT__', String(port));
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  trace('page loaded');

  const result = await win.webContents.executeJavaScript('window.__runAnalyze()');
  writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  trace('result: ' + JSON.stringify(result));

  const profile = result && result.profile;
  const verdict = {
    http: result && result.httpStatus === 200,
    decodeRate: result && result.sampleRate === 22050,
    bpm: profile && profile.bpm !== null && Math.abs(profile.bpm - 120) < 6,
    tail: profile && profile.tail.silenceSec > 1.8 && profile.tail.silenceSec < 3.2,
    head: profile && profile.head.silenceSec > 0.8 && profile.head.silenceSec < 1.4,
    startsHot: profile && profile.head.startsHot === false,
    fastEnough: result && result.totalMs < 5000,
  };
  console.log('\n===== P3 分析管线探针 =====');
  console.log(JSON.stringify(result, null, 2));
  console.log('判定：', JSON.stringify(verdict));
  const passed = Object.values(verdict).every(Boolean);
  console.log(passed ? '[PASS] 解码/降采样/分析链路成立，结果与合成信号一致。' : '[FAIL] 有断言不成立。');
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
  console.error('[probe] 超时退出');
  app.quit();
}, 45_000).unref();
