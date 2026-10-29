/**
 * P4 验证探针：AutoMix 的分频段交叉与软限幅。
 *
 * 这个脚本**不属于应用功能**。它按 `fade-graph.ts` 里 `automixCrossfade` 的同一组数值
 * （等功率主曲线 + lowshelf -12dB + master 后的 20:1 压缩器）在真实 Chromium 里搭一遍：
 *
 * ```
 * A(440Hz) → lowA → highA → gainA ┐
 *                                  ├→ master → limiter → analyser → destination
 * B(660Hz) → lowB → highB → gainB ┘
 * ```
 *
 * 测四件事：
 *   A 交叉中总 RMS 不塌（等功率成立）
 *   B bassSwap：出场曲低频 0 → -12dB，进场曲低频 -12 → 0dB
 *   C 两路叠加后的峰值不超过 1.0（软限幅生效）
 *   D 主曲线结束时 A 已静音、B 满幅
 *
 * 跑法：npx electron --no-sandbox scripts/probe-automix.cjs
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT_DIR = join(process.cwd(), '.tmp');
mkdirSync(OUT_DIR, { recursive: true });
const OUT_JSON = join(OUT_DIR, 'probe-automix.json');
const OUT_LOG = join(OUT_DIR, 'probe-automix.log');
writeFileSync(OUT_LOG, '');
const trace = (line) => appendFileSync(OUT_LOG, `[${new Date().toISOString()}] ${line}\n`);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

const RATE = 22_050;
function makeWav(freq, seconds = 20) {
  const frames = Math.floor(seconds * RATE);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * 0.6 * 32767),
      i * 2,
    );
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
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
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const WAV_A = makeWav(440);
const WAV_B = makeWav(660);

const server = createServer((req, res) => {
  const body = (req.url ?? '').startsWith('/b') ? WAV_B : WAV_A;
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': String(body.length),
    // data: 页面的 origin 是 null，`<audio crossOrigin>` 与 MediaElementSource 都要求 ACAO。
    'access-control-allow-origin': '*',
  });
  res.end(body);
});

const page = `<!doctype html><meta charset="utf-8"><body><script>
const BASE = 'http://127.0.0.1:__PORT__';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

window.__runAutomix = async () => {
  const out = {};
  const ctx = new AudioContext();
  await ctx.resume();

  const makeDeck = (path) => {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.src = BASE + path;
    const source = ctx.createMediaElementSource(el);
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 200;
    low.gain.value = 0;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 4000;
    high.gain.value = 0;
    const gain = ctx.createGain();
    source.connect(low); low.connect(high); high.connect(gain);
    return { el, low, high, gain };
  };

  const a = makeDeck('/a.wav');
  const b = makeDeck('/b.wav');
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  a.gain.connect(master); b.gain.connect(master);
  master.connect(limiter); limiter.connect(analyser); analyser.connect(ctx.destination);
  const buffer = new Float32Array(analyser.fftSize);

  const stats = () => {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0, peak = 0;
    for (const v of buffer) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
    return { rms: Math.sqrt(sum / buffer.length), peak };
  };

  b.gain.gain.value = 0;
  await a.el.play();
  await sleep(600);
  out.rmsBefore = Number(stats().rms.toFixed(3));

  // 交叉：2 秒，bassSwap。
  b.el.currentTime = 0;
  await b.el.play();
  const now = ctx.currentTime;
  const duration = 2;
  const points = 128;
  const rise = new Float32Array(points);
  const fall = new Float32Array(points);
  for (let i = 0; i < points; i += 1) {
    const t = i / (points - 1);
    rise[i] = Math.sin((t * Math.PI) / 2);
    fall[i] = Math.cos((t * Math.PI) / 2);
  }
  a.gain.gain.cancelScheduledValues(now);
  a.gain.gain.setValueAtTime(1, now);
  a.gain.gain.setValueCurveAtTime(fall, now, duration);
  b.gain.gain.cancelScheduledValues(now);
  b.gain.gain.setValueAtTime(0, now);
  b.gain.gain.setValueCurveAtTime(rise, now, duration);

  // bassSwap：出场曲低频 0 → -12（前半），进场曲低频 -12 → 0（全程）。
  a.low.gain.cancelScheduledValues(now);
  a.low.gain.setValueAtTime(0, now);
  a.low.gain.linearRampToValueAtTime(-12, now + duration * 0.5);
  b.low.gain.cancelScheduledValues(now);
  b.low.gain.setValueAtTime(-12, now);
  b.low.gain.linearRampToValueAtTime(0, now + duration);

  const samples = [];
  const started = performance.now();
  while (performance.now() - started < duration * 1000) {
    const s = stats();
    samples.push({ rms: s.rms, peak: s.peak });
    await sleep(100);
  }
  await sleep(250);
  const last = samples[samples.length - 1] || { rms: 0, peak: 0 };
  out.rmsDuringMin = Number(Math.min(...samples.map((s) => s.rms)).toFixed(3));
  out.rmsDuringMax = Number(Math.max(...samples.map((s) => s.rms)).toFixed(3));
  out.peakMax = Number(Math.max(...samples.map((s) => s.peak)).toFixed(3));
  out.rmsAfter = Number(stats().rms.toFixed(3));
  out.gainAEnd = Number(a.gain.gain.value.toFixed(3));
  out.gainBEnd = Number(b.gain.gain.value.toFixed(3));
  out.lowAEnd = Number(a.low.gain.value.toFixed(2));
  out.lowBEnd = Number(b.low.gain.value.toFixed(2));
  out.lastRms = Number(last.rms.toFixed(3));
  ctx.close();
  return out;
};
</script></body>`;

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  win.webContents.on('console-message', (_event, level, message) => {
    trace(`[renderer:${level}] ${message}`);
  });
  await win.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(page.replaceAll('__PORT__', String(port))),
  );
  const result = await win.webContents.executeJavaScript('window.__runAutomix()');
  writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  trace(JSON.stringify(result));

  const verdict = {
    rmsStable: result.rmsDuringMin > 0.38,
    bassFrom: Math.abs(result.lowAEnd + 12) < 0.6,
    bassTo: Math.abs(result.lowBEnd) < 0.6,
    limited: result.peakMax <= 1.02,
    finished: result.gainAEnd < 0.02 && result.gainBEnd > 0.98,
  };
  console.log('\n===== P4 AutoMix 探针 =====');
  console.log(JSON.stringify(result, null, 2));
  console.log('判定：', JSON.stringify(verdict));
  console.log(Object.values(verdict).every(Boolean) ? '[PASS]' : '[FAIL]');
  win.destroy();
  server.close();
  app.quit();
}

app.whenReady().then(main).catch((error) => {
  trace('failed: ' + String(error && error.stack ? error.stack : error));
  console.error('[probe]', error);
  app.quit();
});
setTimeout(() => {
  console.error('[probe] 超时');
  app.quit();
}, 60_000).unref();
