/**
 * P1 验证探针：淡变图在真实 Chromium 里的行为。
 *
 * 这个脚本**不属于应用功能**。它把 `apps/renderer/src/lib/transition/fade-graph.ts` 的图结构
 * （`<audio> → MediaElementSource → fadeGain → masterGain → destination`）在同一套 Electron
 * 运行时里重搭一遍，用合成正弦测四件事：
 *
 *   A 起播后 peak ≈ 0.6（信号振幅）
 *   B fadeOut(300ms) 之后 peak ≈ 0（淡出真的到静音）
 *   C fadeIn(300ms) 之后 peak 回到 ≈ 0.6（恢复也是斜坡）
 *   D masterGain → 0.5 之后 peak ≈ 0.3（用户音量走 master，不碰 fade 层）
 *   另外断言 `element.volume` 始终是 1：音量不该再由元素承担。
 *
 * 图结构与应用代码同构，但不 import 它（探针是 CJS、应用是 ESM 构建产物）；
 * 这里验证的是**这套图在 Chromium 里成立**，应用侧的实现见 fade-graph.ts。
 *
 * 跑法：npx electron --no-sandbox scripts/probe-fade-graph.cjs
 * 结果写到 .tmp/probe-fade-graph.json
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT_DIR = join(process.cwd(), '.tmp');
mkdirSync(OUT_DIR, { recursive: true });
const OUT_LOG = join(OUT_DIR, 'probe-fade-graph.log');
const OUT_JSON = join(OUT_DIR, 'probe-fade-graph.json');
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

/** 440Hz 正弦，16bit 单声道 44100，3 秒。 */
function makeWav(seconds = 3, freq = 440, rate = 44100) {
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

const BODY = makeWav();

const server = createServer((req, res) => {
  const headers = {
    'content-type': 'audio/wav',
    'content-length': String(BODY.length),
    'access-control-allow-origin': '*',
  };
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : BODY);
});

const page = `<!doctype html><meta charset="utf-8"><body><script>
const BASE = 'http://127.0.0.1:__PORT__';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function peakOf(analyser, buffer) {
  analyser.getFloatTimeDomainData(buffer);
  let peak = 0;
  for (const value of buffer) peak = Math.max(peak, Math.abs(value));
  return Number(peak.toFixed(4));
}

window.__runFade = async () => {
  const out = {};
  const ctx = new AudioContext();
  await ctx.resume();
  out.contextState = ctx.state;

  const el = new Audio();
  el.crossOrigin = 'anonymous';
  el.src = BASE + '/tone.wav';
  el.loop = true;

  const source = ctx.createMediaElementSource(el);
  const fadeGain = ctx.createGain();
  const masterGain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(fadeGain);
  fadeGain.connect(masterGain);
  masterGain.connect(ctx.destination);
  masterGain.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  fadeGain.gain.value = 1;
  masterGain.gain.value = 1;

  const failure = await new Promise((resolve) => {
    el.addEventListener('error', () => resolve('error:' + (el.error && el.error.code)), { once: true });
    el.play().then(() => resolve(null), (error) => resolve('play-rejected:' + (error && error.name)));
  });
  if (failure) return { failure };

  await sleep(450);
  out.volumeIsOne = el.volume === 1;
  out.peakAfterStart = peakOf(analyser, buffer);

  // fadeOut 300ms
  let now = ctx.currentTime;
  fadeGain.gain.cancelScheduledValues(now);
  fadeGain.gain.setValueAtTime(fadeGain.gain.value, now);
  fadeGain.gain.linearRampToValueAtTime(0, now + 0.3);
  await sleep(450);
  out.fadeAfterOut = Number(fadeGain.gain.value.toFixed(3));
  out.peakAfterOut = peakOf(analyser, buffer);

  // fadeIn 300ms
  now = ctx.currentTime;
  fadeGain.gain.cancelScheduledValues(now);
  fadeGain.gain.setValueAtTime(fadeGain.gain.value, now);
  fadeGain.gain.linearRampToValueAtTime(1, now + 0.3);
  await sleep(450);
  out.fadeAfterIn = Number(fadeGain.gain.value.toFixed(3));
  out.peakAfterIn = peakOf(analyser, buffer);

  // masterGain 0.5（30ms 斜坡，与应用同口径）
  now = ctx.currentTime;
  masterGain.gain.cancelScheduledValues(now);
  masterGain.gain.setValueAtTime(masterGain.gain.value, now);
  masterGain.gain.linearRampToValueAtTime(0.5, now + 0.03);
  await sleep(200);
  out.masterAfterHalf = Number(masterGain.gain.value.toFixed(3));
  out.peakAfterHalfMaster = peakOf(analyser, buffer);

  el.pause();
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

  const result = await win.webContents.executeJavaScript('window.__runFade()');
  writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  trace('result: ' + JSON.stringify(result));

  const verdict = {
    start: result && result.peakAfterStart > 0.5,
    fadeOut: result && result.peakAfterOut < 0.01,
    fadeIn: result && result.peakAfterIn > 0.5,
    masterHalf: result && Math.abs(result.peakAfterHalfMaster - 0.3) < 0.05,
    volumeIsOne: result && result.volumeIsOne === true,
  };
  console.log('\n===== P1 淡变图探针 =====');
  console.log(JSON.stringify(result, null, 2));
  console.log('判定：', JSON.stringify(verdict));
  const passed = Object.values(verdict).every(Boolean);
  console.log(passed ? '[PASS] 图结构与三个增益层行为符合预期。' : '[FAIL] 有断言不成立，见上面的数值。');
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
}, 30_000).unref();
