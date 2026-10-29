/**
 * P2 验证探针：双 deck 等功率交叉在真实 Chromium 里的行为。
 *
 * 这个脚本**不属于应用功能**。它把 `apps/renderer/src/lib/transition/fade-graph.ts` 的
 * 交叉结构在同一套 Electron 运行时里重搭一遍：
 *
 * ```
 * A(440Hz) → gainA ┐
 *                  ├→ master → analyser → destination
 * B(660Hz) → gainB ┘
 * ```
 *
 * 测四件事：
 *   A 交叉前：只有 A 出声，RMS ≈ 0.424（0.6 振幅的正弦）
 *   B 交叉中：等功率曲线让总 RMS 基本不变（最小值不能塌到线性交叉那种 ~0.30）
 *   C 交叉后：只有 B 出声，RMS 回到 ≈ 0.424，A 已暂停
 *   D 交叉期间 A 与 B 的增益都真的在动（不是硬切）
 *
 * 跑法：npx electron --no-sandbox scripts/probe-crossfade.cjs
 * 结果写到 .tmp/probe-crossfade.json
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT_DIR = join(process.cwd(), '.tmp');
mkdirSync(OUT_DIR, { recursive: true });
const OUT_LOG = join(OUT_DIR, 'probe-crossfade.log');
const OUT_JSON = join(OUT_DIR, 'probe-crossfade.json');
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

/** 正弦 WAV，16bit 单声道 44100。 */
function makeWav(seconds, freq, rate = 44100) {
  const frames = Math.floor(seconds * rate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.6 * 32767);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const BODY_A = makeWav(20, 440);
const BODY_B = makeWav(20, 660);

const server = createServer((req, res) => {
  const body = (req.url ?? '').startsWith('/b') ? BODY_B : BODY_A;
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': String(body.length),
    'access-control-allow-origin': '*',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

const page = `<!doctype html><meta charset="utf-8"><body><script>
const BASE = 'http://127.0.0.1:__PORT__';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rmsOf(analyser, buffer) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const value of buffer) sum += value * value;
  return Math.sqrt(sum / buffer.length);
}

window.__runCrossfade = async () => {
  const out = {};
  const ctx = new AudioContext();
  await ctx.resume();
  out.contextState = ctx.state;

  const makeDeck = (path) => {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.src = BASE + path;
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    return { el, gain };
  };

  const a = makeDeck('/a.wav');
  const b = makeDeck('/b.wav');
  const master = ctx.createGain();
  master.gain.value = 1;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  a.gain.connect(master);
  b.gain.connect(master);
  master.connect(ctx.destination);
  master.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  b.gain.gain.value = 0;

  await a.el.play();
  await sleep(600);
  out.rmsBefore = Number(rmsOf(analyser, buffer).toFixed(3));

  // 开始交叉：B 起播，等功率曲线 3 秒（探针里缩短，逻辑与应用一致）。
  b.el.currentTime = 0;
  await b.el.play();
  const now = ctx.currentTime;
  const duration = 3;
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
  b.gain.gain.cancelScheduledValues(now);
  b.gain.gain.setValueAtTime(0, now);
  a.gain.gain.setValueCurveAtTime(fall, now, duration);
  b.gain.gain.setValueCurveAtTime(rise, now, duration);

  // 每 100ms 采一次 RMS，记录交叉期间的最低值。
  const samples = [];
  const started = performance.now();
  while (performance.now() - started < duration * 1000) {
    samples.push(Number(rmsOf(analyser, buffer).toFixed(3)));
    await sleep(100);
  }
  await sleep(250);
  out.rmsDuringMin = Math.min(...samples);
  out.rmsDuringMax = Math.max(...samples);
  out.sampleCount = samples.length;
  out.gainAEnd = Number(a.gain.gain.value.toFixed(3));
  out.gainBEnd = Number(b.gain.gain.value.toFixed(3));

  // 交叉收尾：暂停 A。
  a.el.pause();
  await sleep(300);
  out.rmsAfter = Number(rmsOf(analyser, buffer).toFixed(3));
  out.aPaused = a.el.paused;
  out.bPaused = b.el.paused;
  ctx.close();
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

  const result = await win.webContents.executeJavaScript('window.__runCrossfade()');
  writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  trace('result: ' + JSON.stringify(result));

  const verdict = {
    // 单路 RMS 应该 ≈ 0.424
    before: result && Math.abs(result.rmsBefore - 0.424) < 0.05,
    // 等功率交叉的中间不该塌：最低值至少要有单路的 ~90%
    during: result && result.rmsDuringMin > 0.38,
    after: result && Math.abs(result.rmsAfter - 0.424) < 0.05,
    finished: result && result.aPaused === true && result.bPaused === false,
    gains: result && result.gainAEnd < 0.02 && result.gainBEnd > 0.98,
  };
  console.log('\n===== P2 双 deck 交叉探针 =====');
  console.log(JSON.stringify(result, null, 2));
  console.log('判定：', JSON.stringify(verdict));
  const passed = Object.values(verdict).every(Boolean);
  console.log(passed ? '[PASS] 等功率交叉成立，收尾正确。' : '[FAIL] 有断言不成立，见上面数值。');
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
