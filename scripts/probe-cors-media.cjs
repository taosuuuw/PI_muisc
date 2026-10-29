/**
 * P0 验证探针：跨源媒体能不能进 Web Audio。
 *
 * 这个脚本**不属于应用功能**，只是把一个在 `docs/PLAN-AUTOMIX.md` §P0 里悬着的问题
 * （`MediaElementAudioSourceNode` 对跨源无 CORS 媒体会不会输出零样本）用 Electron 实测掉。
 *
 * 四组对照，同一份合成 WAV：
 *   A 有 ACAO + crossOrigin=anonymous   —— 我们改完之后的目标形态
 *   B 无 ACAO + crossOrigin=anonymous   —— 少一层 CORS 头会怎样
 *   C 无 ACAO + 不设 crossOrigin        —— 改之前 PI 的形态
 *   D 有 ACAO + crossOrigin=anonymous，但不建 source —— 只验 AudioContext 本身能不能 running
 *
 * 跑法：npx electron scripts/probe-cors-media.cjs
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT_DIR = join(process.cwd(), '.tmp');
mkdirSync(OUT_DIR, { recursive: true });
const OUT_LOG = join(OUT_DIR, 'probe-cors-media.log');
const OUT_JSON = join(OUT_DIR, 'probe-cors-media.json');
const trace = (line) => {
  try {
    appendFileSync(OUT_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* 日志写不进去也不该影响测量 */
  }
};
writeFileSync(OUT_LOG, '');
trace('script loaded');
process.on('uncaughtException', (error) => trace('uncaught: ' + (error && error.stack)));
process.on('exit', (code) => trace('exit: ' + code));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 受限环境里 GPU 进程可能起不来（退出码 3、无栈）；这个探针不需要 GPU。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

/** 440Hz 正弦，16bit 单声道 44100，2 秒。 */
function makeWav(seconds = 2, freq = 440, rate = 44100) {
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
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const headers = { 'content-type': 'audio/wav', 'content-length': String(BODY.length) };
  if (url.pathname.startsWith('/cors')) headers['access-control-allow-origin'] = '*';
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : BODY);
});

const page = `<!doctype html><meta charset="utf-8"><body><script>
const BASE = 'http://127.0.0.1:__PORT__';

async function runCase({ path, crossOrigin, useSource }) {
  const out = { path, crossOrigin, useSource };
  let ctx;
  try { ctx = new AudioContext(); } catch (error) { return { ...out, ctxError: String(error) }; }
  out.ctxState = ctx.state;
  try { if (ctx.state === 'suspended') await ctx.resume(); } catch (error) { out.resumeError = String(error); }
  out.ctxStateAfterResume = ctx.state;

  const el = new Audio();
  if (crossOrigin) el.crossOrigin = 'anonymous';
  el.src = BASE + path;
  el.preload = 'auto';

  let analyser = null;
  try {
    if (useSource) {
      const source = ctx.createMediaElementSource(el);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyser.connect(ctx.destination);
    } else {
      el.volume = 0;
    }
  } catch (error) {
    out.sourceError = (error && error.name) + ': ' + (error && error.message);
    return out;
  }

  const failure = await new Promise((resolve) => {
    el.addEventListener('error', () => resolve('error:' + (el.error && el.error.code)), { once: true });
    el.play().then(() => resolve(null), (error) => resolve('play-rejected:' + (error && error.name)));
  });
  if (failure) return { ...out, failure };

  await new Promise((resolve) => setTimeout(resolve, 800));
  out.currentTime = Number(el.currentTime.toFixed(2));
  out.paused = el.paused;
  if (analyser) {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let peak = 0;
    let sum = 0;
    for (const value of data) { peak = Math.max(peak, Math.abs(value)); sum += value * value; }
    out.peak = Number(peak.toFixed(6));
    out.rms = Number(Math.sqrt(sum / data.length).toFixed(6));
  }
  el.pause();
  ctx.close();
  return out;
}

window.__runProbe = async () => {
  const cases = [
    { path: '/cors/tone.wav', crossOrigin: true, useSource: true },
    { path: '/nocors/tone.wav', crossOrigin: true, useSource: true },
    { path: '/nocors/tone.wav', crossOrigin: false, useSource: true },
    { path: '/cors/tone.wav', crossOrigin: true, useSource: false },
  ];
  const results = [];
  for (const item of cases) results.push(await runCase(item));
  return results;
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
  // data: 页面的 origin 是 opaque（等价于打包态的 file://），正是要复现的跨源条件。
  const html = page.replaceAll('__PORT__', String(port));
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  trace('page loaded');

  const results = await win.webContents.executeJavaScript('window.__runProbe()');
  trace('probe finished: ' + JSON.stringify(results));
  writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  console.log('\n===== P0 探针结果（origin=opaque，模拟 file://）=====');
  for (const item of results) console.log(JSON.stringify(item));
  const [a, b, c, d] = results;
  const verdict = {
    okA: Boolean(a && !a.failure && a.peak > 0.1),
    expectedB: Boolean(!b || (b.failure ? true : b.peak !== undefined && b.peak < 0.01)),
    expectedC: Boolean(c && (c.failure ? false : c.peak !== undefined && c.peak < 0.01)),
    okD: Boolean(d && d.ctxStateAfterResume === 'running'),
  };
  console.log('\n判定：', JSON.stringify(verdict));
  console.log(
    verdict.okA
      ? '[PASS] A 组：有 ACAO + crossOrigin 时 MediaElementSource 拿到真实样本。'
      : '[FAIL] A 组：有 ACAO 也拿不到样本，P0 方案不成立。',
  );
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
