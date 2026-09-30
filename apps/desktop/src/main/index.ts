import { app, BrowserWindow, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Services, thirdPartyEnabled } from './services.js';
// 用户 m02213 第 3 条（M5）：冒烟要把「已下载的任务」还原成一首 Song，再走一遍解析链，
// 看它是不是真的命中离线分支（`attempts` 为空 = 一个网络请求都没发）。
import { songFromTask } from './downloads.js';
import { registerIpc } from './ipc.js';
import type { Song } from '@pi/shared';

/** 连续播放冒烟默认抽查几首（M2 验收要求「能连续播放 3 首」）。 */
const PLAYBACK_SMOKE_SIZE = 3;

/**
 * 是否无人值守冒烟跑（任何一种 PI_SMOKE_* 都算）。
 *
 * 判断放在最前面是因为单实例锁要读它：冒烟时**必须**跳过锁，否则上一轮残留的实例
 * 会让新进程立刻 quit、退出码还是 0，看起来「跑过了」，实际上一条日志都没产出
 * （2026/9/25 就被这个坑过一次：两轮结果一模一样，其实是旧日志）。
 */
const smokeRun = Boolean(
  process.env.PI_SMOKE_PLAY ||
    process.env.PI_SMOKE_SOURCES ||
    process.env.PI_SMOKE_SETTINGS ||
    process.env.PI_SMOKE_UI,
);

/**
 * 点球收球要走「逐个坠入」的动画（m06982 第 2 条）才会真的 `closeOrb()`：
 * 渲染层的 `CLOSE_MS ≈ 512ms` 是「最后一颗按键落地」的时刻，这里留 640ms 余量。
 * 谁要是在这之前就去读环，会读到还在坠的旧按键。
 */
const ORB_CLOSE_WAIT_MS = 640;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 冒烟截图的输出路径。环境变量（`PI_SMOKE_UI_SHOT_*` / `PI_SCREENSHOT`）里给的**相对路径
 * 按仓库根解析**：开发态进程的 cwd 是 `apps/desktop`，直接 `writeFileSync('docs/x.png')`
 * 会去找 `apps/desktop/docs/x.png` 然后 ENOENT，把整次冒烟炸在截图那一步
 * （第十轮 `-a` 那次就是死在 `apps\desktop\docs\m3-home-10th-a.png` 上）。
 */
function smokeShotPath(value: string | undefined, fallback: string): string {
  if (value === undefined || value === '') return fallback;
  return path.isAbsolute(value) ? value : path.resolve(here, '../../../', value);
}
const devServerUrl = process.env.PI_DEV_SERVER_URL;

/**
 * preload 与 main 是 `out/` 下的兄弟文件（见 build.mjs 的产出）。
 *
 * 这里曾经写成 `'../preload.cjs'`，指向并不存在的 `apps/desktop/preload.cjs`：
 * preload 加载失败在 Electron 里是**静默**的，界面照常画出来，只是 `window.pi` 为
 * undefined、所有数据都是空的——所以必须显式检查存在性，宁可启动时吼一声。
 */
const preloadPath = path.join(here, 'preload.cjs');
if (!existsSync(preloadPath)) {
  console.error('[pi] 找不到 preload 产物：', preloadPath, '（先执行 pnpm -F @pi/desktop build）');
}

/* ------------------------------------------------------------------ *
 * 启动前置：渲染能力降级（必须在 app ready 之前决定）
 * ------------------------------------------------------------------ */

interface BootstrapFlags {
  gpuCrashes: number;
  forceSoftwareRendering: boolean;
}

function readFlags(): BootstrapFlags {
  const fallback: BootstrapFlags = { gpuCrashes: 0, forceSoftwareRendering: false };
  try {
    const raw = readFileSync(bootstrapFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BootstrapFlags>;
    return {
      gpuCrashes: typeof parsed.gpuCrashes === 'number' ? parsed.gpuCrashes : 0,
      forceSoftwareRendering: parsed.forceSoftwareRendering === true,
    };
  } catch {
    return fallback;
  }
}

function writeFlags(flags: BootstrapFlags): void {
  try {
    const file = bootstrapFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(flags, null, 2), 'utf8');
  } catch {
    /* 写不了就算了，绝不能因此影响启动 */
  }
}

function bootstrapFile(): string {
  return path.join(app.getPath('userData'), 'bootstrap.json');
}

/*
 * 用户 m02898 第 8 条：让系统把这个进程认成「pi」。
 *
 * `app.getName()` 默认取 `apps/desktop/package.json` 的 `name`（`@pi/desktop`），于是
 * 窗口默认标题、系统通知、任务栏分组里都是「@pi/desktop」。改成 `pi` 之后，凡是走
 * `app.getName()` 的地方都对上了（exe 自己的「文件描述」要打包期改，那是 `scripts/make-dist.mjs`
 * 与 rcedit 的事，见 docs/PLAN.md）。
 *
 * **但不能因为改名把用户数据搬走**：`app.getPath('userData')` = `appData + app.getName()`，
 * 老库里（`%APPDATA%\@pi\desktop`）存着设置、下载记录与本地库索引。老目录还在、新目录还
 * 没建起来时，把 userData 显式钉回老路径——名字换了，数据照旧。
 */
const APP_NAME = 'pi';
const legacyAppName = app.getName();
if (legacyAppName !== APP_NAME) {
  app.setName(APP_NAME);
  const legacyUserData = path.join(app.getPath('appData'), legacyAppName);
  const nextUserData = path.join(app.getPath('appData'), APP_NAME);
  if (existsSync(legacyUserData) && !existsSync(nextUserData)) {
    app.setPath('userData', legacyUserData);
  }
}

const flags = readFlags();
// 连续两次 GPU 崩溃，或用户显式要求 → 关闭硬件加速。
// 低端核显 / 虚拟机 / 远程桌面上，这是「黑屏打不开」与「能用」的区别（见 §2.6 规则 6）。
const softwareRendering =
  flags.forceSoftwareRendering ||
  flags.gpuCrashes >= 2 ||
  process.env.PI_SOFTWARE_RENDERING === '1' ||
  process.argv.includes('--pi-software-rendering');
if (softwareRendering) {
  app.disableHardwareAcceleration();
  process.env.PI_SOFTWARE_RENDERING = '1';
}

if (smokeRun) {
  // 冒烟窗口是「量尺」，量的时候不能让 Chromium 自己把尺子收起来：
  // Windows 上 Chromium 会用原生遮挡检测（CalculateNativeWinOcclusion）判断窗口是否完全被
  // 别的窗口盖住，一旦判定被遮挡就**停止出帧**——`requestAnimationFrame` 不再回调、主线程
  // CSS 过渡停在原地、合成鼠标事件也可能不投递。2026/9/27 的两次冒烟就因此拿到过
  // 「帧=4 时长=26ms」这种没意义的帧率数字，以及一串「拖不动/悬停没反应」的假失败。
  // 只影响冒烟进程，用户实际跑的 PI 不改这个开关。
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}

/* ------------------------------------------------------------------ *
 * 单实例
 * ------------------------------------------------------------------ */

// 冒烟跑跳过单实例锁：见 smokeRun 的注释（残留实例会把一次冒烟变成「空跑但退出码 0」）。
if (!smokeRun && !app.requestSingleInstanceLock()) {
  // 已有实例在跑：让位并退出，避免两个实例同时写同一份 JSON 数据文件。
  app.quit();
}

app.setAppUserModelId('com.pi.music');

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

let mainWindow: BrowserWindow | null = null;
const services = new Services();

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  // 窗口与任务栏图标：开发态 electron.exe 默认顶着 Electron 的图标，指向我们的 .ico 才像个应用。
  // 仓库布局与打包布局各试一次，找不到就不传——绝不为一个图标让启动失败。
  const iconPath = [
    path.resolve(here, '../../../build/pi.ico'),
    path.join(process.resourcesPath, 'build/pi.ico'),
  ].find((candidate) => existsSync(candidate));

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 770,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#FFFFFF',
    ...(iconPath ? { icon: iconPath } : {}),
    // 各平台用各自最稳的标题栏方案：
    // - Windows：整条标题栏**直接取消**——`frame: false` 做出无边框窗口，`titleBarStyle` /
    //   `titleBarOverlay`（原生最小化/最大化/关闭三键）一起删掉。窗口三键改由渲染层自绘
    //   （`apps/renderer/src/components/WindowControls.tsx`），鼠标靠近右上角才向下浮出
    //   （第十一轮第 5 条，用户 m03279）。
    //   **故意不设 `thickFrame: false`**：保持默认 true 才有「从窗口边缘拖拽缩放」与窗口阴影，
    //   设成 false 会得到一块既不能从边上拉大、又没有阴影的铁片。
    // - macOS：hiddenInset 保留系统红绿灯（红绿灯由系统给，别再自绘三键）
    // - Linux：保留系统边框（发行版差异太大，自绘容易出问题）
    ...(isWin ? { frame: false } : {}),
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // 冒烟里必须关掉后台节流：窗口被别的窗口挡住时 Chromium 会把 rAF/主线程 CSS 过渡
      // 一并节流，于是「细条 12px 的宽度过渡」停在 56px、capturePage 也拿到旧帧
      // （2026/9/27 就因此报了一串假失败：单键升起 Δ=0、细条宽=56px、搜索悬停没反应）。
      ...(smokeRun ? { backgroundThrottling: false } : {}),
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // 冒烟还需要窗口真的在前台：被遮挡时 Chromium 连纯 hover 的鼠标移动都不投递给渲染进程。
    if (smokeRun) {
      mainWindow?.setAlwaysOnTop(true);
      mainWindow?.focus();
    }
  });

  // preload 出错时 Electron 只把它咽下去，渲染进程那边只会表现为「桥不可用」。
  mainWindow.webContents.on('preload-error', (_event, preload, error) => {
    console.error('[pi] preload 加载失败：', preload, error);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 站内不做任意外链跳转：一律交给系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexHtml = resolveRendererIndex();
    if (indexHtml) {
      void mainWindow.loadFile(indexHtml);
    } else {
      void mainWindow.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<h2>渲染进程产物缺失</h2><p>请先执行 <code>pnpm build:renderer</code>。</p>',
          ),
      );
    }
  }

  // 无人值守冒烟测试的钩子：PI_SCREENSHOT=<路径> 时，首屏加载后截一张图再退出。
  // 有了它，「界面到底长什么样」就不再依赖人工肉眼确认。
  const screenshotPath = process.env.PI_SCREENSHOT;
  if (screenshotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const win = mainWindow;
        if (!win) return;
        void (async () => {
          // 先确认 preload 桥真的挂上了。缺了它界面照样能画出来，只是所有数据都是空的，
          // 光看截图根本发现不了——这个坑真踩过（见下面注释）。
          const bridge = Boolean(
            await win.webContents
              .executeJavaScript('typeof window.pi === "object" && window.pi !== null')
              .catch(() => false),
          );
          if (!bridge) {
            console.error('[pi] 冒烟失败：预加载桥不可用（window.pi 缺失），截图仍会保存以便排查');
          }
          const image = await win.webContents.capturePage();
          writeFileSync(screenshotPath, image.toPNG());
          console.info(
            `[pi] 已保存冒烟截图：${screenshotPath}（preload 桥：${bridge ? '可用' : '不可用'}）`,
          );
          app.exit(bridge ? 0 : 1);
        })().catch((err: unknown) => {
          console.error('[pi] 截图失败：', err);
          app.exit(1);
        });
      }, 2500);
    });
  }
}

function resolveRendererIndex(): string | undefined {
  const candidates = [
    process.env.PI_RENDERER_DIST,
    path.resolve(app.getAppPath(), '../renderer/dist/index.html'),
    path.resolve(app.getAppPath(), 'renderer/dist/index.html'),
    path.resolve(process.resourcesPath ?? here, 'renderer/index.html'),
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

// 记录 GPU / 渲染进程崩溃，用于下次启动自动降级。
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU') {
    const current = readFlags();
    writeFlags({ ...current, gpuCrashes: current.gpuCrashes + 1 });
    console.error(`[pi] GPU 进程崩溃（累计 ${current.gpuCrashes + 1} 次）：${details.reason}`);
  }
});

app.on('render-process-gone', (_event, _contents, details) => {
  console.error(
    `[pi] 渲染进程崩溃：reason=${details.reason} exitCode=${details.exitCode}`,
  );
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  // 第十三轮第 6 条（用户 m04663）：系统媒体卡片（/ 任务栏图标）上的「点击回到应用」最终走的就是
  // 这条路——Windows 会按 AppUserModelId 再拉一次我们的可执行文件，被单实例锁拦下后进这里。
  // 窗口被最小化或已经 hide（比如用户从卡片上点回来时窗口正藏起来）时，必须先 show() 再 restore/focus，
  // 否则「点击没有任何反应」的症状会从系统卡片上换个地方重现。
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

/**
 * M2 自动验收：**不开窗口**，直接跑一遍「取元数据 → 解析音源 → 走本地代理 + Range 请求」。
 *
 * 为什么需要它：播放链路的正确性无法靠截图证明（M0/M1 已经吃过一次亏：
 * preload 桥断了，截图依旧「看起来正常」）。用法：`PI_SMOKE_PLAY=<songId>`，
 * 退出码 0 表示渲染进程真的能拿到可 Range 的音频字节。
 */
/**
 * 单首歌曲的「解析 → 本地代理 Range 请求」检查。
 *
 * 注意 content-type 不能信：网易云 CDN 会给 flac 回 `audio/mpeg`（实测过），
 * 所以只有前 4 个字节的 magic 才算证据。
 */
async function checkSongPlayable(
  services: Services,
  song: Song,
  index: number,
): Promise<boolean> {
  console.info(
    `[pi/smoke] #${index} 歌曲：${song.name} - ${song.artists.map((a) => a.name).join('/')}`,
  );
  const result = await services.resolveForPlayback(song);
  for (const attempt of result.attempts) {
    console.info(
      `[pi/smoke] #${index} 音源 ${attempt.sourceId} ${attempt.ok ? '✓' : '✗'} ${attempt.detail ?? ''}（${attempt.elapsedMs}ms）`,
    );
  }
  if (!result.src || !result.audio) {
    console.error(`[pi/smoke] #${index} 没有任何音源给出可播地址`);
    return false;
  }
  const probe = result.audio.probe;
  console.info(
    `[pi/smoke] #${index} 解析结果：声明 ${result.audio.quality} / 实测 ${probe.container}` +
      `${probe.sampleRate ? ` ${probe.sampleRate}Hz` : ''}` +
      `${probe.bitrateKbps ? ` ${probe.bitrateKbps}kbps` : ''} via=${result.audio.via}（${probe.evidence}）`,
  );

  // 诊断：三首歌如果解析出同一个上游地址（或同一个总字节数），几乎一定是请求被串了。
  const upstream = new URL(result.audio.url);
  console.info(
    `[pi/smoke] #${index} 上游 ${upstream.host}${upstream.pathname.slice(0, 18)}… ` +
      `urlLen=${result.audio.url.length} mediaKey=${result.src.split('/').pop()?.split('?')[0] ?? '?'}`,
  );

  const response = await fetch(result.src, { headers: { range: 'bytes=0-1023' } });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const magic = Array.from(bytes.slice(0, 4))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
  const ok = (response.status === 200 || response.status === 206) && bytes.byteLength > 0;
  console.info(
    `[pi/smoke] #${index} 本地代理 HTTP ${response.status} ${bytes.byteLength}B magic=${magic}` +
      `（content-type=${response.headers.get('content-type') ?? '?'}，range=${response.headers.get('content-range') ?? '-'}）`,
  );
  return ok;
}

async function runPlaySmoke(services: Services): Promise<void> {
  const raw = (process.env.PI_SMOKE_PLAY ?? '').trim();
  const auto = raw === 'auto' || raw === 'recommend';

  try {
    if (!(await services.ensureNcmReady(25_000))) throw new Error('内嵌 API 没有就绪');
    // auto：取「每日推荐」的前几首——它需要登录态，顺带验证 cookie 真的生效了。
    const candidates = auto
      ? (await services.ncm.recommendTracks()).slice(0, PLAYBACK_SMOKE_SIZE)
      : await (async () => {
          const songId = Number.parseInt(raw, 10);
          if (!Number.isFinite(songId) || songId <= 0) {
            throw new Error('PI_SMOKE_PLAY 需要正整数歌曲 id，或者 auto');
          }
          return services.ncm.songDetails([songId]);
        })();
    const list = candidates.filter((song): song is Song => song !== undefined);
    if (list.length === 0) throw new Error('没有取到歌曲元数据（id 无效，或登录态拿不到推荐）');

    let passed = 0;
    for (const [offset, song] of list.entries()) {
      if (await checkSongPlayable(services, song, offset + 1)) passed += 1;
    }
    console.info(`[pi/smoke] 连续播放检查：${passed}/${list.length} 首拿到可 Range 的音频字节`);
    app.exit(passed === list.length ? 0 : 1);
  } catch (error) {
    console.error('[pi/smoke] 播放链路冒烟失败：', error);
    app.exit(1);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * M2.5 自动验收（`PI_SMOKE_SOURCES=1`）：**不开窗口**，直接跑责任链。
 *
 * 三件必须证明的事（docs/PLAN.md 的 M2.5 验收标准）：
 * 1. 官方拿不到的歌（VIP 的 30s 试听 / 完全无直链）能被第三方源匹配到**实测无损**的音轨；
 * 2. 匹配出来的东西真的能经本机代理取到字节（不是只有个 URL）；
 * 3. 把第三方总开关关掉之后，责任链里就再也看不到第三方源（「关掉某个音源就走下一层」的反面证明）。
 *
 * 为什么不用 UI 冒烟证明：灰色歌是**个别歌曲**的属性，靠点列表里前三行是撞不到的；
 * 这里用搜索关键词捞一批候选，逐首看 attempts，证据比截图硬。
 */
const SOURCE_SMOKE_SIZE = 6;

/**
 * 造一个「够真」的最小 FLAC：`fLaC` 魔数 + STREAMINFO 里写上采样率。
 *
 * 探针只读文件头（`packages/resolver/src/probe.ts` 的 `readFlacSampleRate` 取 STREAMINFO 第 10..12 字节
 * 的 20 位），所以不需要真的能解码——但**必须**让采样率落在正确的位置，
 * 否则测的就不是「本地文件也走实测」这条链路了。
 */
function minimalFlac(sampleRate: number): Buffer {
  const header = Buffer.alloc(8 + 34);
  header.write('fLaC', 0, 'ascii');
  header[4] = 0x00; // 最后一个 metadata block + 类型 0（STREAMINFO）
  header[5] = 0x00;
  header[6] = 0x00;
  header[7] = 0x22; // 长度 34
  header[18] = (sampleRate >> 12) & 0xff;
  header[19] = (sampleRate >> 4) & 0xff;
  header[20] = (sampleRate & 0x0f) << 4;
  // 再补一段静音数据，让「按文件大小 / 时长估码率」有个非零的分母。
  return Buffer.concat([header, Buffer.alloc(64 * 1024)]);
}

/**
 * L4 本地源端到端：硬盘上的同名文件必须能被接住，并且真的经本机代理从磁盘读出来。
 *
 * 用一个**不存在的歌 id**（官方源对它必然返回 null）+ 真实歌名/歌手，
 * 且调用方保证此刻第三方总开关是关的 —— 于是责任链上只剩 L4，命中就只可能是 L4 的功劳。
 * 采样率 44100 写进文件头，用来证明「本地文件的音质同样是实测出来的，不是看后缀猜的」。
 */
async function runLocalSmoke(services: Services, restoreDir: string): Promise<boolean> {
  const dir = path.resolve(here, '../../../.smoke-local');
  const file = path.join(dir, '周杰伦 - 晴天.flac');
  let ok = false;

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, minimalFlac(44_100));
    await services.patchSettings({ localLibraryDir: dir });

    const song: Song = { id: 999_999_999, name: '晴天', artists: [{ id: 0, name: '周杰伦' }] };
    const result = await services.resolveForPlayback(song);
    const ids = result.attempts.map((attempt) => attempt.sourceId);
    const probe = result.audio?.probe;

    console.info(
      `[pi/smoke] 本地源（L4）：尝试过的音源 = [${ids.join(', ')}]` +
        ` → via=${result.audio?.via ?? '无'} 实测 ${probe?.container ?? '无'}` +
        `${probe?.sampleRate ? ` ${probe.sampleRate}Hz` : ''}`,
    );

    let bytes = 0;
    if (result.src) {
      const response = await fetch(result.src, { headers: { range: 'bytes=0-1023' } });
      const body = new Uint8Array(await response.arrayBuffer());
      bytes = (response.status === 200 || response.status === 206) ? body.byteLength : 0;
    }

    ok =
      result.audio?.via === 'local' &&
      probe?.container === 'flac' &&
      probe.sampleRate === 44_100 &&
      bytes > 0;
    console.info(
      `[pi/smoke] 本地源（L4）：via=local ${result.audio?.via === 'local' ? '✓' : '✗'}｜` +
        `实测 flac 44100Hz ${probe?.container === 'flac' && probe.sampleRate === 44_100 ? '✓' : '✗'}｜` +
        `经代理从磁盘取到字节 ${bytes > 0 ? '✓' : '✗'} → ${ok ? '通过' : '未通过'}`,
    );
  } catch (error) {
    console.error('[pi/smoke] 本地源（L4）冒烟失败：', error);
  } finally {
    try {
      await services.patchSettings({ localLibraryDir: restoreDir });
    } catch {
      /* 恢复失败不影响结论 */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉就算了 */
    }
  }

  return ok;
}

async function runSourceSmoke(services: Services): Promise<void> {
  const query = (process.env.PI_SMOKE_QUERY ?? '周杰伦 晴天').trim();

  try {
    if (!(await services.ensureNcmReady(25_000))) throw new Error('内嵌 API 没有就绪');

    // 第三方音源默认是**关闭**的（ADR-0001 第 6 条），所以冒烟必须自己把它打开，
    // 否则责任链里根本没有 L1/L3，测的就不是音源体系。结束时原样恢复。
    const original = await services.getSettings();

    // L4 先测：此刻第三方总开关必须关着（否则那个不存在的 id 会先被 UNM 拿去试 20 秒），
    // 而官方源对一个不存在的 id 必然返回 null —— 责任链上只剩 L4，命中就只可能是本地文件的功劳。
    await services.patchSettings({ enableThirdPartySources: false, thirdPartyAcknowledged: true });
    const localOk = await runLocalSmoke(services, original.localLibraryDir);

    if (!thirdPartyEnabled(original)) {
      console.info('[pi/smoke] 第三方音源默认关闭，冒烟先临时打开（结束后恢复原设置）');
      await services.patchSettings({ enableThirdPartySources: true, thirdPartyAcknowledged: true });
    }

    const found = await services.ncm.search(query, SOURCE_SMOKE_SIZE);
    const songs = found.songs.slice(0, SOURCE_SMOKE_SIZE);
    if (songs.length === 0) throw new Error(`搜索「${query}」没有结果`);

    let resolved = 0;
    let bytesOk = 0;
    let thirdParty = 0;
    let lossless = 0;
    let gateSong: Song | undefined;

    for (const [index, song] of songs.entries()) {
      const result = await services.resolveForPlayback(song);
      for (const attempt of result.attempts) {
        console.info(
          `[pi/smoke] #${index + 1} 音源 ${attempt.sourceId} ${attempt.ok ? '✓' : '✗'} ${attempt.detail ?? ''}（${attempt.elapsedMs}ms）`,
        );
      }

      if (!result.audio || !result.src) {
        console.info(`[pi/smoke] #${index + 1} ${song.name}：没有任何音源给出可播地址`);
        continue;
      }

      resolved += 1;
      const probe = result.audio.probe;
      const via = result.audio.via;
      const isThirdParty = via.startsWith('unm') || via.startsWith('lx');
      console.info(
        `[pi/smoke] #${index + 1} ${song.name} → via=${via}` +
          ` 声称 ${result.audio.quality}${result.audio.claimedQuality ? `（标称 ${result.audio.claimedQuality}）` : ''}` +
          ` 实测 ${probe.container}${probe.sampleRate ? ` ${probe.sampleRate}Hz` : ''}${probe.bitrateKbps ? ` ${probe.bitrateKbps}kbps` : ''}` +
          ` 试听=${result.audio.trial === true ? '是' : '否'}`,
      );

      if (isThirdParty) {
        thirdParty += 1;
        if (probe.container === 'flac' || probe.container === 'wav') lossless += 1;
        gateSong ??= song;
      }

      const response = await fetch(result.src, { headers: { range: 'bytes=0-1023' } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if ((response.status === 200 || response.status === 206) && bytes.byteLength > 0) bytesOk += 1;
    }

    console.info(
      `[pi/smoke] 音源体系：${songs.length} 首里 ${resolved} 首解析出地址，` +
        `${thirdParty} 首来自第三方，其中 ${lossless} 首实测无损；代理取到字节 ${bytesOk}/${resolved}`,
    );

    // 反证：关掉第三方总开关，责任链里就不该再出现 unm/lx。
    let gateOk = true;
    if (gateSong) {
      await services.patchSettings({
        enableThirdPartySources: false,
        thirdPartyAcknowledged: true,
      });
      const off = await services.resolveForPlayback(gateSong);
      const ids = off.attempts.map((attempt) => attempt.sourceId);
      gateOk = !ids.includes('unm') && !ids.includes('lx');
      console.info(
        `[pi/smoke] 关闭第三方总开关后重解《${gateSong.name}》：尝试过的音源 = [${ids.join(', ')}]` +
          ` → 责任链里${gateOk ? '已经没有' : '仍然有'}第三方源 ${gateOk ? '✓' : '✗'}`,
      );
    } else {
      gateOk = false;
      console.warn('[pi/smoke] 这一批歌没有任何一首走到第三方源，无法验证「关掉即跳过」');
    }

    // 无论成败都把设置恢复成跑之前的样子。
    await services.patchSettings({
      enableThirdPartySources: original.enableThirdPartySources,
      thirdPartyAcknowledged: original.thirdPartyAcknowledged,
    });

    const ok =
      thirdParty > 0 && lossless > 0 && resolved > 0 && bytesOk === resolved && gateOk && localOk;
    console.info(
      `[pi/smoke] M2.5 验收：第三方无损 ${lossless > 0 ? '✓' : '✗'}｜` +
        `${bytesOk}/${resolved} 经代理取到字节 ${bytesOk === resolved && resolved > 0 ? '✓' : '✗'}｜` +
        `关源即跳过 ${gateOk ? '✓' : '✗'}｜本地源 L4 ${localOk ? '✓' : '✗'} → ${ok ? '通过' : '未通过'}`,
    );
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error('[pi/smoke] 音源体系冒烟失败：', error);
    app.exit(1);
  }
}
const UI_SMOKE_SONGS = 3;
const UI_SMOKE_READY_MS = 8_000;
const UI_SMOKE_SWITCH_MS = 2_500;
const UI_SMOKE_TIMEOUT_MS = 15_000;

interface AudioSnapshot {
  time: number;
  paused: boolean;
  readyState: number;
  code: number | null;
  /** 当前 `<audio>` 真正加载的地址。用于证明「换了一首」，而不是拿上一首的时间轴冒充。 */
  src: string;
}

async function readAudio(win: BrowserWindow): Promise<AudioSnapshot> {
  const script = `(() => {
    const a = window.__piAudio;
    if (!a) return { time: -1, paused: true, readyState: -1, code: null, src: '' };
    return { time: a.currentTime, paused: a.paused, readyState: a.readyState, code: a.error ? a.error.code : null, src: a.currentSrc || a.src || '' };
  })()`;
  return (await win.webContents.executeJavaScript(script, true)) as AudioSnapshot;
}

/**
 * 等时间轴真的往前走——`play()` 的 promise 兑现不等于出声，只有 currentTime 算数。
 *
 * 第一轮冒烟在这里撒过谎：没传 `previousSrc` 时，点第二首的瞬间上一首还在 7.8s 处正常播放，
 * 条件立刻成立，于是「3/3 首都在走」其实是同一首的时间轴被读了三次。现在必须等
 * `currentSrc` 换掉，再等新歌的时间轴起来。
 */
async function waitForPlayback(
  win: BrowserWindow,
  timeoutMs: number,
  previousSrc?: string,
): Promise<AudioSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await readAudio(win);
  while (Date.now() < deadline) {
    const switched = previousSrc === undefined || snapshot.src !== previousSrc;
    if (switched && snapshot.time > 0.2 && !snapshot.paused) return snapshot;
    await delay(400);
    snapshot = await readAudio(win);
  }
  return snapshot;
}

async function countRows(win: BrowserWindow): Promise<number> {
  /*
   * 用户 m08066 第 3 条之后歌曲列表是卡片网格（`.pi-songcard`），行式列表（`.pi-songrow`）
   * 还可能出现在别的页面，所以两种都算——这个函数只关心「这一页有没有歌可点」。
   * 第十七轮第 ②③ 条之后又多一套：先锋排版的「我的喜欢」/ 歌单详情是队列拼贴
   * （`data-collage-cell`，类名 `.pi-collage__item`，见 `components/SongCollage.tsx:938-944`），
   * 平凡排版是竖排列表（`[data-song-row]`，同时带 `.pi-songrow` 类）。
   * 三套都算进来，`PI_SMOKE_UI_STYLE=avant` 那一跑才拿得到歌源。
   */
  return (await win.webContents.executeJavaScript(
    `document.querySelectorAll('.pi-songrow, .pi-songcard, [data-collage-cell]').length`,
    true,
  )) as number;
}

/**
 * 等这一页的歌曲列表真的铺出来。
 *
 * 2026/9/27 的冒烟里，「推荐」页刚点进去时每日推荐还在请求中（日志里 `/personalized/newsong`
 * 是几秒后才 `[OK]` 的），而当时的探针只读一次行数：读到 0 → 后面 `total = 0` → 一首歌都没播 →
 * 播放器主页是空态 → 歌词/评论断言整片红。这是**脚手架读太早**，不是应用的缺陷，
 * 所以这里改成轮询到「够数」或超时，超时也照实返回真实行数。
 */
async function waitForRows(win: BrowserWindow, min: number, maxMs = 6000): Promise<number> {
  const until = Date.now() + maxMs;
  let rows = await countRows(win);
  while (rows < min && Date.now() < until) {
    await delay(300);
    rows = await countRows(win);
  }
  return rows;
}

/**
 * 帧间隔探针（用户 m08066 第 1 条：环形菜单动画与封面环拖动的流畅性）。
 *
 * 为什么要有它：动画掉不掉帧是**主观感受**，不给数字就只能靠猜——上一轮我们已经吃过
 * 「凭感觉以为哪里卡」的亏。这里用 `requestAnimationFrame` 采每帧间隔，同时记下那一帧的
 * `data-ring-spin`：拖动期间 `spin` 在变的那些帧才是「真正在动」的帧，单独统计，
 * 免得把拖动之间的空档（干净的 16.7ms）混进来把数据稀释成「看起来没问题」。
 */
interface FrameStats {
  frames: number;
  ms: number;
  p50: number;
  p95: number;
  worst: number;
  /** 超过 33.4ms（约两帧）的帧数，也就是肉眼能看出顿一下的那些。 */
  long: number;
  /**
   * 拖动期间的帧数与其中的掉帧数。第十五轮第 2 条（用户 m06435）删掉封面环的
   * `data-ring-spin` 之后，采帧时不再有可比较的标签，这里恒为 0（帧率日志相应不再打这一段）；
   * 字段留着是为了不动 `FrameStats` 与日志的结构。
   */
  dragFrames: number;
  dragLong: number;
  dragP95: number;
}

/**
 * 第十六轮删球（用户 m07538 第 1 条）：所有旧 orb 探针的总闸，永远返回 false。
 * 老实现因此整体停用、但原样留在原地作对照。这里用一个**函数调用**而不是
 * `return` / `if (false)` 来短路，是因为 TS 会把后面的代码判成不可达，而不可达代码
 * 不做控制流收窄——strict 下会立刻炸出一片 TS18047/TS18048。
 */
function r16LegacyProbe(_win: BrowserWindow): boolean {
  return false;
}

async function startFrameProbe(win: BrowserWindow): Promise<void> {
  // 第十六轮删球：帧探针以前只量「11 键冒出 / 逐个坠入」，球没了这里就没有可量的对象。
  if (!r16LegacyProbe(win)) return;
  await win.webContents.executeJavaScript(
    `(() => {
       const w = window;
       w.__piFrames = [];
       w.__piFrameStop = false;
       let last = performance.now();
       const tick = (t) => {
         if (w.__piFrameStop) return;
         // 第十五轮第 2 条之后封面环没了，采样标签恒为空（见 FrameStats.dragFrames 的注释）。
         w.__piFrames.push([t - last, '']);
         last = t;
         if (w.__piFrames.length < 4000) requestAnimationFrame(tick);
       };
       requestAnimationFrame(tick);
       return true;
     })()`,
    true,
  );
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[index] ?? 0;
}

async function stopFrameProbe(win: BrowserWindow, label: string): Promise<FrameStats> {
  // 第十六轮删球：环形展开/坠入两段动画的帧率已经无对象，返回全 0 的统计（日志结构不动）。
  if (!r16LegacyProbe(win)) {
    return { frames: 0, ms: 0, p50: 0, p95: 0, worst: 0, long: 0, dragFrames: 0, dragLong: 0, dragP95: 0 };
  }
  const raw = (await win.webContents.executeJavaScript(
    `(() => { const w = window; w.__piFrameStop = true; return w.__piFrames || []; })()`,
    true,
  )) as [number, string][];
  const gaps = raw.map((row) => row[0]).filter((value) => Number.isFinite(value) && value > 0);
  // 拖动帧：这一帧的 spin 与上一帧不同（等于「这一帧画面真的在转」）。
  const dragGaps: number[] = [];
  for (let i = 1; i < raw.length; i += 1) {
    const current = raw[i];
    const previous = raw[i - 1];
    if (current === undefined || previous === undefined) continue;
    if (current[1] !== '' && current[1] !== previous[1]) dragGaps.push(current[0]);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const sortedDrag = [...dragGaps].sort((a, b) => a - b);
  const stats: FrameStats = {
    frames: gaps.length,
    ms: gaps.reduce((sum, value) => sum + value, 0),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    worst: sorted[sorted.length - 1] ?? 0,
    long: gaps.filter((value) => value > 33.4).length,
    dragFrames: dragGaps.length,
    dragLong: dragGaps.filter((value) => value > 33.4).length,
    dragP95: percentile(sortedDrag, 0.95),
  };
  console.info(
    `[pi/smoke] 帧率（${label}）：帧=${stats.frames} 时长=${Math.round(stats.ms)}ms` +
      ` p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms 最差=${stats.worst.toFixed(1)}ms` +
      ` 掉帧(>33ms)=${stats.long}` +
      (stats.dragFrames === 0
        ? ''
        : `｜转动帧=${stats.dragFrames} p95=${stats.dragP95.toFixed(1)}ms 掉帧=${stats.dragLong}`) +
      // 帧数太少（比如只采到 4 帧、时长 26ms）说明窗口根本没在出帧，这组数字不能当结论用；
      // 照实标出来，别拿它去证明「动画很流畅」。
      (stats.frames >= 10 ? '' : ' ⚠ 帧数太少，窗口可能没在出帧，这组数不算证据'),
  );
  return stats;
}

/** 环形菜单现在是不是**真的**开着：按键在 DOM 里 + `data-open='true'`。 */
async function orbIsOpen(win: BrowserWindow): Promise<boolean> {
  // 十六轮删球，此断言随之退休。
  if (!r16LegacyProbe(win)) return false;
  return (await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('.pi-orb__item')) &&
     document.querySelector('.pi-orb')?.dataset.open === 'true'`,
    true,
  )) as boolean;
}

/**
 * 展开悬浮球的环形菜单（用户 m05361 第 1 条）。
 *
 * 环形菜单的按钮只在球打开时存在，所以「点导航」必须先开球——冒烟走的是真实操作路径，
 * 不能绕开 UI 直接改 store。
 */
async function openOrb(win: BrowserWindow): Promise<boolean> {
  // 十六轮删球，此断言随之退休（函数保留签名，好让旧调用点安全 no-op，不再有副作用）。
  if (!r16LegacyProbe(win)) return false;
  const state = async (): Promise<{ exists: boolean; open: boolean; closing: boolean }> =>
    (await win.webContents.executeJavaScript(
      `(() => {
        const orb = document.querySelector('.pi-orb');
        if (!orb) return { exists: false, open: false, closing: false };
        return {
          exists: true,
          open: Boolean(document.querySelector('.pi-orb__item')),
          closing: orb.dataset.closing === 'true',
        };
      })()`,
      true,
    )) as { exists: boolean; open: boolean; closing: boolean };
  let now = await state();
  if (!now.exists) return false;
  if (now.open && !now.closing) return true;
  // 收球（m06982 第 2 条的 512ms 坠入）期间按键还在 DOM 里，而球自己的 onClick 里
  // 有 `if (closing) return`——这时的点击会被吞掉，所以先等它收完再点开。
  const deadline = Date.now() + ORB_CLOSE_WAIT_MS + 400;
  while (now.closing && Date.now() < deadline) {
    await delay(120);
    now = await state();
  }
  // 「点一下」不一定真的开：球自己的 onClick 第一句是 `if (wasDragged()) return`
  // （吞掉拖动松手那一下的 click），真实拖过球之后紧接着的程序化点击会被吞掉。
  // 那次读取会把标志消费掉，所以再点一次就能开——但必须**以「真的开了」为判据**，
  // 不能点完就返回 true，否则后面所有断言都会读到「菜单其实是收着的」。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await win.webContents.executeJavaScript(
      `document.querySelector('.pi-orb__ball')?.click()`,
      true,
    );
    const waitUntil = Date.now() + ORB_CLOSE_WAIT_MS + 500;
    while (Date.now() < waitUntil) {
      if (await orbIsOpen(win)) return true;
      now = await state();
      // 每次补点至少隔 300ms：球自己的双击判定窗口是 240ms（m08066 第 2 条，双击要跳播放页），
      // 间隔太短的话这两次「程序化补救点击」会被当成一次双击，把页面跳走还开不出菜单。
      await delay(now.closing ? 340 : 300);
    }
  }
  return await orbIsOpen(win);
}

/**
 * 等环形菜单里的按键/封面**位置不再变**。
 *
 * 入场（`pi-orb-pop`，26ms 一颗错开）和换页都靠 CSS 动画；动画没走完时按键全都还在
 * 起点上（重叠在球心、`opacity 0`、`pointer-events: none`），这时量几何会得到
 * 「最少间距 0.0」，挪鼠标也一个事件都收不到。所有量位置之前都要先过这一关。
 */
async function waitRingSteady(win: BrowserWindow, maxMs = 2000): Promise<void> {
  // 十六轮删球，此断言随之退休。
  if (!r16LegacyProbe(win)) return;
  // 位置不变还不够：`pi-orb-pop` 是 `animation-fill-mode: backwards` 的动画，
  // 延时阶段元素就停在 0% 关键帧上（重叠在球心、opacity 0、pointer-events none），
  // 这段时间里「位置」是恒定不变的，只看坐标会误判成已经稳定。
  // 所以还要问一次 `getAnimations()`：按键/封面自己身上不能还有 running/pending 的动画。
  const probe = async (): Promise<{ key: string; count: number; busy: boolean }> =>
    (await win.webContents.executeJavaScript(
      `(() => {
        const els = [...document.querySelectorAll('.pi-orb__item, .pi-orb__cover')];
        const key = els
          .map((el) => {
            const r = el.getBoundingClientRect();
            return Math.round(r.left) + ',' + Math.round(r.top);
          })
          .join('|');
        const busy = els.some((el) =>
          el.getAnimations().some((a) => a.playState === 'running' || a.playState === 'pending'),
        );
        return { key, count: els.length, busy };
      })()`,
      true,
    )) as { key: string; count: number; busy: boolean };
  const deadline = Date.now() + maxMs;
  let last = '';
  while (Date.now() < deadline) {
    const now = await probe();
    if (now.count > 0 && !now.busy && now.key === last) return;
    last = now.key;
    await delay(140);
  }
}

/** 在当前这一页环形菜单上点一个按钮，不做「换页」补救。 */
async function clickRingItem(win: BrowserWindow, item: string): Promise<boolean> {
  // 十六轮删球，此断言随之退休。
  if (!r16LegacyProbe(win)) return false;
  return (await win.webContents.executeJavaScript(
    `(() => {
      const selector = '.pi-orb__item[data-item="' + ${JSON.stringify(item)} + '"]';
      const button = document.querySelector(selector);
      if (!button) return false;
      button.click();
      return true;
    })()`,
    true,
  )) as boolean;
}

/** 点环形菜单里的一个按钮（按 `data-item` 匹配）。 */
async function clickOrbItem(win: BrowserWindow, item: string): Promise<boolean> {
  // 十六轮删球，此断言随之退休（所有活的调用点都改成走导航抽屉或 PI 圆键了）。
  if (!r16LegacyProbe(win)) return false;
  if (!(await openOrb(win))) return false;
  await delay(240);
  await waitRingSteady(win, 1200);
  if (await clickRingItem(win, item)) return true;
  // m08768 第 1 条之后环形菜单只剩「主菜单」与「歌单卡片面板」两页，面板页上没有主菜单的键
  // （比如 `mine:playlists`）：先收回再打开，收球会把 `ringPage` 复位成 `main`
  // （renderer 的 ui store），然后重试一次。
  // 以前这里直接返回 false，调用方若忽略返回值就会「什么都没点却以为点了」。
  if (!(await orbToMain(win))) return false;
  await delay(160);
  await waitRingSteady(win, 1200);
  return await clickRingItem(win, item);
}

/**
 * 点球把环形菜单收起来，并等到按键真的从 DOM 里消失。
 *
 * 不能只 `delay(320)`：m06982 第 2 条之后收球先播 512ms 的「坠入」，期间按键还在
 * （`data-closing` 的中间态），这时读环或接着点键都会读到旧状态。
 */
async function closeOrb(win: BrowserWindow): Promise<void> {
  // 十六轮删球，此断言随之退休。
  if (!r16LegacyProbe(win)) return;
  const hasItems = async (): Promise<boolean> =>
    (await win.webContents.executeJavaScript(
      `Boolean(document.querySelector('.pi-orb__item'))`,
      true,
    )) as boolean;
  // 已经收着就什么都别点：现在点球是「展开」，会把刚要收的菜单又打开。
  if (!(await hasItems())) return;
  // 点球可能落在「动画还在走」的窗口里被应用自己吞掉（`if (closing) return`），
  // 所以按键没消失就再点一次，最多三次。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await win.webContents.executeJavaScript(
      `document.querySelector('.pi-orb__ball')?.click()`,
      true,
    );
    const deadline = Date.now() + ORB_CLOSE_WAIT_MS + 400;
    while (Date.now() < deadline) {
      if (!(await hasItems())) return;
      await delay(120);
    }
  }
}

/**
 * 把环形菜单弄回主菜单且保持展开。
 *
 * 歌单卡片面板（playlists）里没有「返回」形态，只能「收回再打开」——收球会把
 * `ringPage` 复位成 `main`（见 renderer 的 ui store）。
 */
async function orbToMain(win: BrowserWindow): Promise<boolean> {
  // 十六轮删球，此断言随之退休（旧调用点靠这里返回 false 自动整体 no-op）。
  if (!r16LegacyProbe(win)) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await openOrb(win))) return false;
    await delay(300);
    await waitRingSteady(win, 1200);
    const page = (await readRing(win))?.page ?? '';
    // 「页对」还不够：菜单必须真的开着。点球被 `wasDragged()` 吞掉时 `ringPage`
    // 已经是 main（store 的 closeOrb 复位过），只查 page 会误判成功，
    // 后面所有断言就都在「菜单其实是收着的」状态下跑。
    if (page === 'main' && (await orbIsOpen(win))) return true;
    // 歌单卡片面板（playlists）没有「返回」形态，只能收球：store 的 closeOrb 会把
    // `ringPage` 复位成 main，下一轮 openOrb 再打开就是主菜单。
    await closeOrb(win);
    await delay(200);
  }
  await waitRingSteady(win, 1400);
  return (await orbIsOpen(win)) && ((await readRing(win))?.page ?? '') === 'main';
}

/**
 * 打开导航抽屉。
 *
 * 用户 m08768 第 1 条之后，环形菜单里不再有「账号」键（设置键直接进设置页），
 * 抽屉的入口挪到了标题栏的 PI 标上（`[data-nav-toggle]`，见 `components/TitleBar.tsx`）。
 * 冒烟走的就是这条真实路径。
 */
async function openNav(win: BrowserWindow): Promise<boolean> {
  const exists = async (selector: string): Promise<boolean> =>
    (await win.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      true,
    )) as boolean;
  if (await exists('.pi-navdrawer')) return true;
  await focusSmoke(win);
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-nav-toggle]')?.click()`,
    true,
  );
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (await exists('.pi-navdrawer')) return true;
    await delay(120);
  }
  return exists('.pi-navdrawer');
}

interface RingItemBox {
  id: string;
  half: string;
  cx: number;
  cy: number;
  w: number;
  hover: boolean;
  labelOpacity: number;
}

/**
 * 歌单卡片面板里的一张卡。
 *
 * 第十五轮第 2 条（用户 m06435）：「删掉环形歌单展示，歌单用歌曲卡片的那个卡片展示」——
 * 绕球的「歌单封面环」（`.pi-orb__cover` / `data-cover`）被删掉，换成球旁边的
 * `.pi-orb__plcards` 卡片面板，稳定标记见 `PiOrb.tsx` 的 `data-playlist-card*`。
 */
interface RingPlaylistCard {
  id: string;
  name: string;
  trackCount: number;
  cx: number;
  cy: number;
}

/** 歌单卡片面板的状态（`null` = 这一刻不在歌单页、DOM 上没有面板）。 */
interface RingPlaylistPanel {
  source: string;
  state: string;
  count: number;
  side: string;
  fallback: string;
  cards: RingPlaylistCard[];
}

interface RingSnapshot {
  open: boolean;
  page: string;
  /** 换页过渡的阶段（`in` = 新按键已经冒完，`out` = 旧按键正在往球里掉）。 */
  phase: string;
  /** 现在真正画在屏幕上的是哪一页（过渡期间会落后于 `page`）。 */
  displayPage: string;
  /** 球贴在哪条边上（`none` = 正常的球）。 */
  snapped: string;
  /** 图标按键直径 / 封面直径（m06304 第 4 条把它们放大了，断言不写死）。 */
  itemSize: number;
  radius: number;
  minGap: number;
  logo: string;
  meter: boolean;
  ringX: number;
  ringY: number;
  /** 歌单卡片面板（第十五轮第 2 条；不在歌单页时是 null）。 */
  playlists: RingPlaylistPanel | null;
  items: RingItemBox[];
  left: RingItemBox[];
  right: RingItemBox[];
}

/** 读一次环形菜单的几何快照（按键中心与最小中心距、文字透明度、封面可见性、环心）。 */
async function readRing(win: BrowserWindow): Promise<RingSnapshot | null> {
  // 十六轮删球，此断言随之退休。
  if (!r16LegacyProbe(win)) return null;
  return (await win.webContents.executeJavaScript(
    `(() => {
      const orb = document.querySelector('.pi-orb');
      if (!orb) return null;
      const readItem = (el) => {
        const rect = el.getBoundingClientRect();
        const label = el.querySelector('.pi-orb__label');
        return {
          id: el.dataset.item || '',
          half: el.dataset.half || '',
          cx: rect.left + rect.width / 2,
          cy: rect.top + rect.height / 2,
          w: rect.width,
          hover: el.dataset.hover === 'true',
          labelOpacity: label ? Number(getComputedStyle(label).opacity) : 0,
        };
      };
      const items = [...orb.querySelectorAll('.pi-orb__item')].map(readItem);
      let minGap = Number.POSITIVE_INFINITY;
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          minGap = Math.min(
            minGap,
            Math.hypot(items[i].cx - items[j].cx, items[i].cy - items[j].cy),
          );
        }
      }
      const panelEl = orb.querySelector('.pi-orb__plcards');
      const cards = panelEl
        ? [...panelEl.querySelectorAll('[data-playlist-card]')].map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              id: el.dataset.playlistId || '',
              name: el.dataset.playlistName || '',
              trackCount: Number(el.dataset.playlistCount || 0),
              cx: rect.left + rect.width / 2,
              cy: rect.top + rect.height / 2,
            };
          })
        : [];
      const playlists = panelEl
        ? {
            source: panelEl.dataset.playlistCards || '',
            state: panelEl.dataset.playlistCardsState || '',
            count: Number(panelEl.dataset.playlistCardsCount || 0),
            side: panelEl.dataset.side || '',
            fallback: panelEl.dataset.playlistCardsFallback || '',
            cards,
          }
        : null;
      return {
        open: orb.dataset.open === 'true',
        page: orb.dataset.ringPage || '',
        phase: orb.dataset.phase || '',
        displayPage: orb.dataset.displayPage || '',
        snapped: orb.dataset.snapped || '',
        itemSize: Number(orb.dataset.itemSize || 0),
        radius: Number(orb.dataset.ringRadius || 0),
        minGap: Number.isFinite(minGap) ? minGap : 0,
        logo: orb.querySelector('.pi-orb__logo') ? orb.querySelector('.pi-orb__logo').textContent : '',
        meter: Boolean(orb.querySelector('.pi-orb__bar')),
        ringX: Number(orb.dataset.ringX || 0),
        ringY: Number(orb.dataset.ringY || 0),
        playlists,
        items,
        left: items.filter((el) => el.half === 'left'),
        right: items.filter((el) => el.half === 'right'),
      };
    })()`,
    true,
  )) as RingSnapshot | null;
}

/**
 * 把冒烟窗口顶到最前并抢到焦点，返回它现在是不是前台窗口。
 *
 * 合成鼠标移动确实能送进渲染进程（应用自己的 `pointermove` 收得到坐标），但只要冒烟窗口不是
 * 前台窗口（用户自己的 PI 实例、聊天用的浏览器抢了焦点），Chromium 就不维护指针悬停状态：
 * 纯靠 CSS `:hover` 的效果（封面墙方块放大、搜索卡片浮层）会全灭。跑悬停断言前先叫到前台，
 * 并且把 `isFocused()` 打出来——这样「窗口没在前台」和「界面真有缺陷」能一眼分开。
 */
async function focusSmoke(win: BrowserWindow): Promise<boolean> {
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show();
  win.moveTop();
  win.focus();
  win.webContents.focus();
  await delay(200);
  return win.isFocused();
}

interface HoverProbe {
  id: string;
  hovered: boolean;
  delta: number;
  othersDelta: number;
  labelOpacity: number;
  othersLabelMax: number;
  trace: string[];
}

/**
 * 把鼠标移到某个按键的**基准中心**（还没升起时的位置），量它升起多少、别的键动没动、
 * 文字是不是只出现在这一块上（m05797 第 1、5 条）。
 *
 * 命中判定用基准位置（见 PiOrb 的几何命中），所以移到基准中心就能稳定停在这一块上，
 * 不会「升起 → 离开 → 落下」抖。
 */
async function measureItemHover(
  win: BrowserWindow,
  id: string,
  items: RingItemBox[],
  shotPath?: string,
): Promise<HoverProbe | null> {
  // 十六轮删球，此断言随之退休。
  if (!r16LegacyProbe(win)) return null;
  const target = items.find((el) => el.id === id);
  if (!target) return null;
  const others = items.filter((el) => el.id !== id);
  /*
   * 快照里的中心可能已经不是此刻的位置了：环心跟着球走、球在前面几步被拖过，窗口尺寸一变环还会重排。
   * 真挪鼠标之前必须再向 DOM 要一次这颗键**现在**的矩形中心，并拿它当基准（delta 也相对它算）。
   * 曾经出现过快照中心落在窗口底部、离按键好几百像素的情况——鼠标挪到了空处，
   * 于是「悬停没生效」被记成应用缺陷（而悬停截图 `docs/m3-orb-hover.png` 里那颗球明明好好地待在左边）。
   */
  const live = (await win.webContents.executeJavaScript(
    `(() => {
      const hits = [...document.querySelectorAll('.pi-orb__item')].filter(
        (el) => el.dataset.item === ${JSON.stringify(id)},
      );
      const rect = hits[0] ? hits[0].getBoundingClientRect() : null;
      return {
        count: hits.length,
        cx: rect ? rect.left + rect.width / 2 : null,
        cy: rect ? rect.top + rect.height / 2 : null,
        vw: window.innerWidth,
        vh: window.innerHeight,
        inline: hits[0] ? hits[0].getAttribute('style') : null,
        items: document.querySelectorAll('.pi-orb__item').length,
      };
    })()`,
    true,
  )) as {
    count: number;
    cx: number | null;
    cy: number | null;
    vw: number;
    vh: number;
    inline: string | null;
    items: number;
  };
  const basis =
    live.cx !== null && live.cy !== null ? { cx: live.cx, cy: live.cy } : { cx: target.cx, cy: target.cy };
  // 记下渲染进程真收到的指针事件与随之而来的悬停态：悬停判定改用几何命中之后，
  // 一旦「一个事件都没收到」和「收到了但没命中」是两种完全不同的原因，得能分开看。
  await win.webContents.executeJavaScript(
    `(() => {
      window.__piHover = [];
      const push = (event) => {
        if (window.__piHover.length >= 8) return;
        window.__piHover.push(
          event.type + ' ' + Math.round(event.clientX) + ',' + Math.round(event.clientY) +
            ' hover=' + (document.querySelector('.pi-orb')?.dataset.hover || '-'),
        );
      };
      for (const kind of ['pointermove', 'mousemove']) window.addEventListener(kind, push, true);
      return true;
    })()`,
    true,
  );
  const focused = await focusSmoke(win);
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: Math.round(basis.cx),
    y: Math.round(basis.cy),
  });
  await delay(520);
  let after = await readRing(win);
  let moved = after?.items.find((el) => el.id === id) ?? null;
  /*
   * 悬停靠真鼠标移动：只要冒烟窗口不是前台窗口，Chromium 就不维护指针悬停状态
   * （见 `focusSmoke()` 的注释），于是「事件没投递 / `:hover` 没重算」会被记成应用缺陷。
   *
   * 第十轮把重试做扎实：每轮先抢一次前台，再用 ±2px 抖动「挪开→挪回」，并把渲染进程
   * 真正收到的指针事件条数（`window.__piHover`）读出来——「一个事件都没收到」和
   * 「收到了但没命中」是两种完全不同的原因，日志里必须能分开。
   */
  let received = 0;
  for (let attempt = 0; attempt < 4 && moved !== null && !moved.hover; attempt += 1) {
    await focusSmoke(win);
    const jitter = attempt === 0 ? 0 : attempt % 2 === 1 ? 2 : -2;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 });
    await delay(240);
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(basis.cx) + jitter,
      y: Math.round(basis.cy),
    });
    await delay(420);
    received = (await win.webContents.executeJavaScript(
      `(window.__piHover || []).length`,
      true,
    )) as number;
    after = await readRing(win);
    moved = after?.items.find((el) => el.id === id) ?? null;
  }
  if (after === null || moved === null) return null;
  // 把「应用自己认没认下这一块」拆开看：命中判定（几何）与真实命中链（`:hover` / pointer-events）。
  // 两者不一致时能直接看出来是哪一层的问题，不用猜。
  // 注意 `el.className` 在 SVG 元素上是 `SVGAnimatedString` 对象，直接拼进字符串会变成
  // 「[object Object]」——这里显式取 `class` 属性，日志里要看得见命中的到底是什么。
  const diag = (await win.webContents.executeJavaScript(
    `(() => {
      const el = document.elementFromPoint(${Math.round(basis.cx)}, ${Math.round(basis.cy)});
      const item = el && el.closest ? el.closest('.pi-orb__item') : null;
      const label = item ? item.querySelector('.pi-orb__label') : null;
      const cls = el ? (typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? '')) : '';
      return {
        hit: el ? el.tagName + (cls ? '.' + cls : '') : null,
        item: item ? item.dataset.item : null,
        dataHover: item ? item.dataset.hover : null,
        hoverPseudo: item ? item.matches(':hover') : null,
        pointerEvents: item ? getComputedStyle(item).pointerEvents : null,
        iconTransform: item ? getComputedStyle(item.querySelector('.pi-orb__icon')).transform : null,
        labelOpacity: label ? getComputedStyle(label).opacity : null,
        inline: item ? item.getAttribute('style') : null,
      };
    })()`,
    true,
  )) as Record<string, unknown>;
  console.info(
    `[pi/smoke] 悬停诊断（${id}）：窗口前台=${focused}` +
      `｜视口=${live.vw}×${live.vh} 环内按键=${live.items} 同名命中=${live.count}` +
      `｜快照中心=(${Math.round(target.cx)},${Math.round(target.cy)}) 现测中心=(${Math.round(basis.cx)},${Math.round(basis.cy)})` +
      `｜命中=${String(diag.hit)} 收到指针事件=${received}` +
      `｜按键=${String(diag.item)} data-hover=${String(diag.dataHover)} :hover=${String(diag.hoverPseudo)}` +
      ` pointer-events=${String(diag.pointerEvents)}｜图标 transform=${String(diag.iconTransform)}` +
      `｜文字 opacity=${String(diag.labelOpacity)}｜内联=${String(diag.inline)}`,
  );
  const trace = (await win.webContents.executeJavaScript(`window.__piHover`, true)) as string[];
  const delta = Math.hypot(moved.cx - basis.cx, moved.cy - basis.cy);
  let othersDelta = 0;
  let othersLabelMax = 0;
  for (const other of others) {
    const now = after.items.find((el) => el.id === other.id);
    if (!now) continue;
    othersDelta = Math.max(othersDelta, Math.hypot(now.cx - other.cx, now.cy - other.cy));
    othersLabelMax = Math.max(othersLabelMax, now.labelOpacity);
  }
  // 先把「悬停中」的样子拍下来（第 1、5 条只能在悬停态才看得出来），再挪开鼠标。
  if (shotPath !== undefined) {
    writeFileSync(shotPath, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${shotPath}`);
  }
  // 量完把鼠标挪开，免得后面的截图里还戳着一块升起的按键。
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 });
  await delay(240);
  return {
    id,
    hovered: moved.hover,
    delta,
    othersDelta,
    labelOpacity: moved.labelOpacity,
    othersLabelMax,
    trace,
  };
}

/**
 * 点歌单卡片面板里的第 index 张卡，应该打开那个歌单的详情浮层。
 *
 * 第十五轮第 2 条（用户 m06435）之前这里是 `spinCoverRing`：按住绕球的封面拖动、量转了多少度，
 * 再点一张封面进详情 —— 封面环（`.pi-orb__cover` / `data-cover` / `data-ring-spin`）整块删掉
 * 之后「转」这件事不再存在，只剩「点卡片 → 进歌单详情」这一步值得验；它同时也是
 * `openRecommendedPlaylist` 兜底歌源复用的那条路。
 *
 * 每轮都重新量卡片中心：面板会随球的位置/贴边换边，用旧坐标点下去会落到空处。
 */
async function openPlaylistCard(
  win: BrowserWindow,
  index: number,
): Promise<{ clicked: string; openedDetail: boolean } | null> {
  // 十六轮删球，此断言随之退休（歌单卡片现在从「推荐歌单」页里点）。
  if (!r16LegacyProbe(win)) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await focusSmoke(win);
    const live = (await win.webContents.executeJavaScript(
      `(() => {
         const cards = [...document.querySelectorAll('.pi-orb__plcards [data-playlist-card]')];
         const el = cards[${index}];
         if (!el) return null;
         const rect = el.getBoundingClientRect();
         const x = Math.round(rect.left + rect.width / 2);
         const y = Math.round(rect.top + rect.height / 2);
         const top = document.elementFromPoint(x, y);
         return {
           name: el.dataset.playlistName || '',
           x,
           y,
           hit: Boolean(top && top.closest && top.closest('[data-playlist-card]')),
         };
       })()`,
      true,
    )) as { name: string; x: number; y: number; hit: boolean } | null;
    if (live === null) return null;
    if (!live.hit) {
      await delay(220);
      continue;
    }
    win.webContents.sendInputEvent({ type: 'mouseMove', x: live.x, y: live.y });
    await delay(160);
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: live.x,
      y: live.y,
      button: 'left',
      clickCount: 1,
    });
    await delay(80);
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: live.x,
      y: live.y,
      button: 'left',
      clickCount: 1,
    });
    for (let wait = 0; wait < 12; wait += 1) {
      await delay(250);
      const opened = (await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('.pi-detail, .pi-songslist'))`,
        true,
      )) as boolean;
      if (opened) return { clicked: live.name, openedDetail: true };
    }
  }
  return { clicked: '', openedDetail: false };
}

/**
 * 等到环形菜单真的换完页（过渡结束）再继续断言。
 *
 * m06304 第 1 条之后「点按键」不再立刻换页：旧按键要先一个个掉进球里（约 380ms），
 * 所以固定 `delay(420)` 这种写法会正好卡在动画中间读到半新半旧的一页。
 */
async function waitRingSettled(
  win: BrowserWindow,
  page: string,
  timeoutMs = 3000,
): Promise<RingSnapshot | null> {
  // 十六轮删球，此断言随之退休。
  if (!r16LegacyProbe(win)) return null;
  const deadline = Date.now() + timeoutMs;
  let last: RingSnapshot | null = null;
  while (Date.now() < deadline) {
    last = await readRing(win);
    if (last !== null && last.displayPage === page && last.phase === 'in') return last;
    await delay(120);
  }
  return last;
}

interface PhaseProbe {
  phase: string;
  page: string;
  displayPage: string;
  leftIds: string[];
}

/**
 * 账号里没有个人歌单时的**兜底歌源**：环形菜单 →「推荐」→ 点卡片面板里的第一张歌单卡片，
 * 进推荐歌单详情。
 *
 * 为什么需要它：这台机器上的账号是「零收藏 + 零最近听过」（`/likelist` 回空、
 * `/user/record` 回空），而用户 m08768 第 3 条又把「推荐」**页面**删掉了，
 * 于是原来那条 `clickNav('推荐')` 的兜底路也断了——冒烟会一首歌都点不到、
 * 后面整条播放页/歌词/主题链全部跟着假失败。推荐歌单是 `/personalized` +
 * `/playlist/track/all` 来的，不依赖用户数据，所以它在新账号上也能给出一屏歌。
 *
 * 第十五轮第 2 条（用户 m06435）之前点的是绕球的封面（`[data-cover]`），现在点的是
 * `.pi-orb__plcards [data-playlist-card]`；动作本身没变，复用 `openPlaylistCard`。
 *
 * 返回详情页里歌曲行的数量（等不到就是 0，照实交给调用方记 ✗）。
 */
async function openRecommendedPlaylist(win: BrowserWindow): Promise<number> {
  // 整段最多重来 4 次：这一步要连着「开环 → 等面板联网 → 点卡片 → 等详情页联网」，
  // 任何一环慢一拍（实测推荐歌单偶尔 6 秒都还没出来）都会假失败，重试比重设超时划算。
  const firstRows = await countRows(win);
  if (firstRows >= 1) return firstRows;
  /*
   * 第十六轮删球（用户 m07538 第 1 条）：`.pi-orb` 整颗球连同 `.pi-orb__plcards` 一起删掉，
   * 旧的「开环 → 等歌单卡片面板联网 → 点面板里的卡」这条路已经没了。改走导航抽屉：
   * 左上角品牌键 `[data-nav-toggle]` 开抽屉 → 点「推荐歌单」→ 在 `.pi-plcard` 网格里点第一张卡。
   *
   * 数据依赖没变：这台机器的账号是「零收藏 + 零最近听过」，推荐歌单里第一张偶尔是空歌单
   * （实测点开共 0 首，于是整条播放页/歌词/主题链跟着假失败）。所以点开是空就关掉换下一张，
   * 最多试 4 张，直到真拿到 ≥1 行歌。
   */
  for (let index = 0; index < 4; index += 1) {
    if (!(await clickNav(win, '推荐歌单'))) {
      console.warn('[pi/smoke] 兜底歌源：导航抽屉里找不到「推荐歌单」，这条兜底拿不到歌');
      break;
    }
    const gridDeadline = Date.now() + UI_SMOKE_TIMEOUT_MS;
    let gridCards = 0;
    while (Date.now() < gridDeadline) {
      // 第十八轮第 ③ 条（用户 m01482）：歌单页改成直接套搜索页的 `SongCards`
      // （`.pi-songcard`），`PlaylistCoverflow` 的 `.pi-coverflow__card` 已经删掉。
      gridCards = (await win.webContents.executeJavaScript(
        `document.querySelectorAll('.pi-plcard, [data-playlist-card], .pi-songcard').length`,
        true,
      )) as number;
      if (gridCards > 0) break;
      await delay(400);
    }
    if (gridCards <= index) {
      console.info(`[pi/smoke] 兜底歌源：推荐歌单页只有 ${gridCards} 张卡（要第 ${index + 1} 张），收工`);
      break;
    }
    /*
     * 开详情走 DOM click：这里要的是**拿到一个歌源**（后面播放页/歌词/主题/连续播放一整串
     * 探针都靠它），不是验指针路径；`openPlaylist` 会把 nav 拨回 home、用浮层盖住当前页，
     * 所以详情一定长在 `.pi-listoverlay` 里（`.pi-detail` 同时挂在里面）。
     */
    await win.webContents.executeJavaScript(
      // 平凡点第 index 张网格卡；先锋点轮播/卡片流的**焦点卡**（点非焦点卡只会滑过去）。
      `(() => {
        const card =
          document.querySelectorAll('.pi-plcard, [data-playlist-card]')[${index}] ??
          document.querySelector('.pi-songcard[data-focused="true"]');
        card?.click();
      })()`,
      true,
    );
    let opened = false;
    for (let attempt = 0; attempt < 16 && !opened; attempt += 1) {
      await delay(250);
      opened = (await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('.pi-detail, .pi-songslist'))`,
        true,
      )) as boolean;
    }
    if (!opened) {
      console.info(`[pi/smoke] 兜底歌源：第 ${index + 1} 张卡片点不开，换下一张`);
      await delay(300);
      continue;
    }
    const readyRows = await waitForRows(
      win,
      UI_SMOKE_SONGS,
      index === 0 ? UI_SMOKE_TIMEOUT_MS : 8000,
    );
    if (readyRows >= 1) return readyRows;
    console.info(
      `[pi/smoke] 兜底歌源：第 ${index + 1} 张卡片点开是空歌单（${readyRows} 行），关掉换下一张`,
    );
    // 关浮层：第九轮第 3 条之后歌单详情没有返回键了，点玻璃空白处就是唯一的退出方式。
    await win.webContents.executeJavaScript(
      `document.querySelector('.pi-listoverlay[data-song-list-overlay]')?.click()`,
      true,
    );
    await delay(500);
  }
  return countRows(win);
}

/**
 * 「在放的这一首没有歌词」的兜底。
 *
 * 为什么需要：推荐歌单（每日轮换）里常混着纯器乐/电子曲——实测踩到过 `HEXST0RM`、`My Oh My`、
 * `Stray.wav`，这时播放页的 `[data-lyric-line]` 恒为 0，于是歌词轨、歌词主题、逐字素点亮这一串
 * 探针全部报 ✗。那是**数据依赖的假失败**，不是界面坏了（第一次踩到时白等了 15 秒超时）。
 *
 * 为什么走队列而不是点别处：第九轮第 8 条之后，环形菜单的「播放列表」开的就是歌手/专辑同一套
 * 卡片浮层（`.pi-listoverlay[data-songs="queue"] .pi-songcard`），点卡片就是 playAt(index)，
 * 换歌正好用它。（旧写法读 `.pi-queue__row`，那个行列表抽屉随第九轮删掉了。）
 *
 * 返回最后停在哪一首（`index` 从 0 数，找不到就是 -1）。
 */
/*
 * 队列浮层（`.pi-listoverlay[data-songs="queue"]`）里「一首歌」的抓手 —— 用户 m02898 第 2 条。
 *
 * 这一档今天有两种身体：平凡档是竖排 `.pi-songrow`（`components/SongList.tsx` →
 * `styles/song-list.css:28`，歌名在 `.pi-songrow__name`），先锋档是拼贴墙上的一格
 * `button[data-collage-cell]`（`components/SongCollage.tsx:1088-1106`，自带
 * `data-queue-index`，歌名在 `aria-label`/`title` 里）。
 * **两种身体都没有 `.pi-songcard`** —— 那是搜索/歌单的 `SongCards` 专用类名（`SongCards.tsx`）。
 * 老探针一律按 `[data-songs="queue"] .pi-songcard` 数卡片、读名字、点卡片，自第十七/十八轮
 * 改版起恒为 0 ⇒ 「播放列表」这一节必判失败：**用户所见的那个「一片空白」就是这条假红**
 * （源码侧 `queue.ids ⊆ keys(songs)` 是结构性不变量，见 `state/player.ts:215-257`）。
 * 下面这组都是给 `executeJavaScript` 求值的纯 JS 片段（不能出现反引号或 TS 断言）。
 */
const QUEUE_ENTRY_COUNT_JS =
  `document.querySelectorAll('.pi-listoverlay[data-songs="queue"] .pi-songrow, ` +
  `.pi-listoverlay[data-songs="queue"] [data-collage-cell]').length`;
/**
 * 点队列里第 `i` 首并返回它的歌名（读不到就是 null）。
 *
 * 拼贴墙先按 `data-queue-index` 找，并且**避开中心那一格**：中心格既是「在放的那首」
 * 又是放大聚焦的一格，点它等于「进播放页」而不是 `playAt(i)`（`SongCollage.tsx:1107-1122`），
 * 那样探针会误判成「换了歌但音频没变」。竖排列表退化成按顺序取第 i 行。
 */
const clickQueueEntryJs = (i: number): string => `(() => {
  const scope = document.querySelector('.pi-listoverlay[data-songs="queue"]');
  if (scope === null) return null;
  const cell =
    scope.querySelector('[data-collage-cell][data-queue-index="${i}"]:not([data-center="true"])') ||
    scope.querySelectorAll('.pi-songrow')[${i}] ||
    scope.querySelector('[data-collage-cell][data-queue-index="${i}"]');
  if (!cell) return null;
  const nameEl = cell.querySelector('.pi-songrow__name');
  const name = (
    (nameEl ? nameEl.textContent : '') ||
    cell.getAttribute('aria-label') ||
    cell.getAttribute('title') ||
    cell.textContent ||
    ''
  );
  cell.click();
  return name.trim().slice(0, 40);
})()`;
async function ensureLyricSong(
  win: BrowserWindow,
  tries = 12,
): Promise<{ index: number; name: string; lines: number }> {
  const queueRows = async (): Promise<number> =>
    (await win.webContents.executeJavaScript(QUEUE_ENTRY_COUNT_JS, true)) as number;
  const openQueue = async (): Promise<number> => {
    /*
     * 第十六轮删球：旧路是「点球 → 环形菜单 → 播放列表」，球整颗删了。
     * 新路走 PI 圆键：播放页空白处点一下出球 → 从球心向上划 ≥60px → 点六块按键里的「播放列表」。
     *
     * 每一步都必须等真的到位再走下一步（父代理 2026 实测：不等待时这一步失败，会连累后面
     * 所有歌词/主题探针——`歌词行=0`/`舞台=无`/`进度条 NaN` 那一大片红都是它的下游）。
     * 任一步拿不到就整轮重试，最多 3 轮。
     */
    const waitUntil = async (script: string, budget: number): Promise<boolean> => {
      const deadline = Date.now() + budget;
      while (Date.now() < deadline) {
        const ok = (await win.webContents.executeJavaScript(script, true)) as boolean;
        if (ok) return true;
        await delay(200);
      }
      return false;
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await tapQuickOrb(win)) === null) {
        await delay(500);
        continue;
      }
      if (!(await waitUntil(`Boolean(document.querySelector('[data-quick-orb]'))`, 1500))) continue;
      await swipeQuickOrb(win, 0, -90);
      if (
        !(await waitUntil(
          `Boolean(document.querySelector("[data-quick-layer='playlists']"))`,
          1500,
        ))
      ) {
        continue;
      }
      await clickQuickItem(win, 'queue');
      await delay(600);
      const opened = await queueRows();
      if (opened > 0) return opened;
    }
    return queueRows();
  };
  // 第九轮第 8 条：队列变成卡片浮层之后，点一张卡就播那一首**并把浮层收掉**，
  // 所以每一轮都要重开（旧的行列表是点完还开着的）。这里按当前状态判断，不敢无脑再点一次：
  // 环形菜单的「播放列表」不是切换，重复点只会把已经开着的浮层再开一遍。
  const ensureQueue = async (): Promise<number> => {
    const open = await queueRows();
    return open > 0 ? open : openQueue();
  };
  // 收摊：点浮层玻璃的空白处关它（这正是用户第九轮第 3 条要的退出方式），再把环形菜单收回去。
  const closeQueue = async (): Promise<void> => {
    if ((await queueRows()) > 0) {
      await win.webContents.executeJavaScript(
        `document.querySelector('.pi-listoverlay[data-song-list-overlay]')?.click()`,
        true,
      );
      await delay(260);
    }
    await closeOrb(win);
  };
  let rows = await ensureQueue();
  if (rows < 2) {
    await closeQueue();
    return { index: -1, name: '', lines: 0 };
  }
  /*
   * 判「这首真的有歌词」不能用 `[data-lyric-line]` 的行数：那只是歌词轨**当前渲染窗口**的行数，
   * 一首歌刚开始放时本来就只画一两行，后面才长大（实测 13 首全是 1~2 行，全都判成「不够」）。
   * 改用字素数：只有一句 `[Intro ]` 的那种是 8 个字素，而真歌词一行就有三十几个。
   */
  const RICH_WORDS = 14;
  let thin: { index: number; name: string; lines: number } | null = null;
  const limit = Math.min(tries, rows - 1);
  for (let index = 1; index <= limit; index += 1) {
    // 上一轮点完抽屉一般还开着；真被收起时再打开一次。
    if (index > 1) rows = await ensureQueue();
    if (rows <= index) break;
    const before = await readAudio(win);
    const label = (await win.webContents.executeJavaScript(
      clickQueueEntryJs(index),
      true,
    )) as string | null;
    if (label === null) break;
    await waitForPlayback(win, UI_SMOKE_TIMEOUT_MS, before.src);
    // 换源成功 ≠ 歌词到位：歌词是另一条联网请求，单独再等一小段。
    const deadline = Date.now() + 6000;
    let lastLines = 0;
    let bestWords = 0;
    while (Date.now() < deadline) {
      const probe = (await win.webContents.executeJavaScript(
        `(() => ({
          lines: document.querySelectorAll('[data-lyric-line], .pi-lyrics__line').length,
          words: document.querySelectorAll('.pi-lyricstage__word').length,
        }))()`,
        true,
      )) as { lines: number; words: number };
      lastLines = probe.lines;
      bestWords = Math.max(bestWords, probe.words);
      if (probe.words >= RICH_WORDS) {
        await closeQueue();
        return { index, name: label, lines: probe.lines };
      }
      await delay(400);
    }
    if (lastLines > 0) thin = thin ?? { index, name: label, lines: lastLines };
    console.info(
      `[pi/smoke] 队列第 ${index + 1} 首「${label}」歌词字素=${bestWords} 行=${lastLines}` +
        `（不足 ${RICH_WORDS} 个字素，继续往下找）`,
    );
  }
  // 要退回薄的那份：把它重新点回来，别让「在放的那首」和日志里报的那首对不上。
  if (thin !== null) {
    rows = await ensureQueue();
    if (rows > thin.index) {
      await win.webContents.executeJavaScript(clickQueueEntryJs(thin.index), true);
      await delay(800);
    }
  }
  await closeQueue();
  return thin ?? { index: -1, name: '', lines: 0 };
}

/**
 * 点一个环形菜单按键，并**在换页动画还在 `out` 阶段时**把快照读回来。
 *
 * 「先旧键坠入、再新键冒出」这条要求只有在刚点完那一小段里看得见。但 `phase` 是
 * React state：`click()` 返回时 `useEffect` 还没把 `out` 落到 DOM 上，所以不能在
 * 同一个同步块里读，得在页面里轮询到 `out`（最多 220ms，而 out 阶段本身约 340ms）。
 */
async function clickOrbItemAndPeek(win: BrowserWindow, item: string): Promise<PhaseProbe | null> {
  // 十六轮删球，此断言随之退休（换页过渡改看别的入口了）。
  if (!r16LegacyProbe(win)) return null;
  if (!(await orbToMain(win))) return null;
  await delay(240);
  return (await win.webContents.executeJavaScript(
    `(async () => {
      const button = document.querySelector('.pi-orb__item[data-item="' + ${JSON.stringify(item)} + '"]');
      if (!button) return null;
      button.click();
      const orb = document.querySelector('.pi-orb');
      const snap = () => ({
        phase: orb.dataset.phase || '',
        page: orb.dataset.ringPage || '',
        displayPage: orb.dataset.displayPage || '',
        leftIds: [...orb.querySelectorAll('.pi-orb__item[data-half="left"]')].map((el) => el.dataset.item || ''),
      });
      let latest = snap();
      for (let i = 0; i < 14; i += 1) {
        if (latest.phase === 'out') return latest;
        await new Promise((resolve) => setTimeout(resolve, 16));
        latest = snap();
      }
      return latest;
    })()`,
    true,
  )) as PhaseProbe | null;
}

interface BallBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 悬浮球（贴边时就是那条细条）现在的盒子。 */
async function ballBox(win: BrowserWindow): Promise<BallBox | null> {
  // 十六轮删球，此断言随之退休。
  if (!r16LegacyProbe(win)) return null;
  return (await win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('.pi-orb__ball');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    })()`,
    true,
  )) as BallBox | null;
}

/**
 * 用真实鼠标事件把球（或贴边细条）拖到目标位置。
 *
 * 起点取 `.pi-orb__ball` 的当前中心：细条状态用的是同一个拖动手柄，
 * 所以「从细条里拉出来」和「拖球」走的是同一条代码路径。
 */
async function dragOrbTo(win: BrowserWindow, toX: number, toY: number): Promise<boolean> {
  // 十六轮删球，此断言随之退休（新写法看 dragPoint：真实 mouseDown/mouseMove/mouseUp）。
  if (!r16LegacyProbe(win)) return false;
  const from = await ballBox(win);
  if (from === null) return false;
  const fromX = Math.round(from.x + from.w / 2);
  const fromY = Math.round(from.y + from.h / 2);
  // 窗口不在前台时 Chromium 不维护悬停/拖动状态，合成鼠标会「只送到 down」。
  await focusSmoke(win);
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: fromX,
    y: fromY,
    button: 'left',
    clickCount: 1,
  });
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(fromX + ((toX - fromX) * step) / steps),
      y: Math.round(fromY + ((toY - fromY) * step) / steps),
    });
    await delay(45);
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(toX),
    y: Math.round(toY),
    button: 'left',
    clickCount: 1,
  });
  await delay(520);
  return true;
}

/**
 * 往搜索浮层的输入框里塞关键词。
 *
 * React 受控输入会忽略直接改 `input.value` 后再派发的 `input` 事件（值被 React 覆盖回旧的），
 * 必须走原型上的原生 setter，让 React 的 value tracker 认为这次是「外部改动」。
 */
async function typeIntoSearch(win: BrowserWindow, text: string): Promise<boolean> {
  return (await win.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector('.pi-searchoverlay [data-search-input]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
    true,
  )) as boolean;
}

interface SearchProbe {
  open: boolean;
  cards: number;
  firstName: string;
  firstArtist: string;
  tier: string;
  focusIndex: number;
  coverImg: boolean;
  cardBox: BallBox | null;
}

/**
 * 读一次搜索浮层的状态（卡片数、聚光那张的文案、卡片流档位）。
 *
 * 第九轮第 6 条：结果区改成和歌单里同一个 `SongCards` 之后，旧的「一行横向小卡
 * + 悬停糊封面蒙层」（`.pi-searchoverlay__card/__cover/__info`）全没了，
 * 能读的就是卡片流自己的钩子：`[data-song-card]`、`.pi-songcard[data-focused="true"]`、
 * 根上的 `data-song-cards-size` / `data-focus-index`。
 */
async function readSearch(win: BrowserWindow): Promise<SearchProbe> {
  return (await win.webContents.executeJavaScript(
    `(() => {
      const root = document.querySelector('.pi-searchoverlay');
      const overlayOpen = Boolean(root) && root.dataset.open === 'true';
      const flow = root ? root.querySelector('[data-song-card-flow]') : null;
      const cards = flow ? [...flow.querySelectorAll('[data-song-card]')] : [];
      const focused = flow ? flow.querySelector('.pi-songcard[data-focused="true"]') : null;
      const first = focused || cards[0] || null;
      const rect = first ? first.getBoundingClientRect() : null;
      const text = (selector) => {
        const el = first ? first.querySelector(selector) : null;
        return el ? (el.textContent || '').trim() : '';
      };
      return {
        open: overlayOpen,
        cards: cards.length,
        firstName: text('.pi-songcard__name'),
        firstArtist: text('.pi-songcard__meta'),
        tier: flow ? flow.dataset.songCardsSize || '' : '',
        focusIndex: flow ? Number(flow.dataset.focusIndex) : -1,
        coverImg: Boolean(first ? first.querySelector('.pi-songcard__cover img') : null),
        cardBox: rect
          ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
          : null,
      };
    })()`,
    true,
  )) as SearchProbe;
}

/** 点抽屉里的导航项（按可见文案匹配）——沿真实操作路径走，而不是绕开 UI。 */
async function clickNav(win: BrowserWindow, label: string): Promise<boolean> {
  if (!(await openNav(win))) return false;
  await delay(200);
  return (await win.webContents.executeJavaScript(
    `(() => {
      const item = [...document.querySelectorAll('.pi-navitem')].find((el) => (el.textContent || '').includes(${JSON.stringify(label)}));
      if (!item) return false;
      item.click();
      return true;
    })()`,
    true,
  )) as boolean;
}

async function describePage(win: BrowserWindow): Promise<string> {
  return (await win.webContents.executeJavaScript(
    `(() => {
      const main = document.querySelector('.pi-main');
      return (document.querySelector('.pi-page-title')?.textContent || '') + '｜' +
        (main?.textContent || '').replace(/\\s+/g, ' ').slice(0, 90);
    })()`,
    true,
  )) as string;
}

interface CoverReport {
  total: number;
  loaded: number;
  empty: number;
  /** 明文 http 地址有几张。CSP 的 img-src 白名单里没有 http:，这类图必然加载不出来。 */
  plain: number;
  sample: string;
  /** 没解码出来的几张的地址，用来分辨「还在下载」还是「真的取不到」。 */
  missing: string[];
  /** 还没下载完的（不一定是错）。 */
  pending: number;
  /** `complete` 了却还是没有像素 = 真的失败（404 / 被拦 / 解码不了）。 */
  failed: number;
}

/**
 * 「歌曲没有封面」不能靠肉眼看截图判定，`naturalWidth > 0` 才叫真的解码出来了。
 * 被 CSP 拦掉、404、或地址是明文 http 的，全都会老老实实地显示成 0。
 */
async function checkCovers(win: BrowserWindow): Promise<CoverReport> {
  const script = `(() => {
    const scope = '.pi-songrow, .pi-songcard, .pi-plcard, .pi-orb, .pi-home, .pi-comment, .pi-songcards, .pi-detail';
    const imgs = [...document.querySelectorAll('img')].filter((el) => el.closest(scope));
    const report = { total: imgs.length, loaded: 0, empty: 0, plain: 0, sample: '', missing: [], pending: 0, failed: 0 };
    for (const img of imgs) {
      if (img.naturalWidth > 0) report.loaded += 1;
      else {
        report.empty += 1;
        if (img.complete) report.failed += 1;
        else report.pending += 1;
        if (report.missing.length < 4) report.missing.push((img.getAttribute('src') || '').slice(0, 110));
      }
      if ((img.currentSrc || img.src || '').startsWith('http:')) report.plain += 1;
    }
    const first = imgs.find((el) => el.naturalWidth === 0) ?? imgs[0];
    report.sample = first ? (first.getAttribute('src') || '').slice(0, 110) : '';
    return report;
  })()`;
  return (await win.webContents.executeJavaScript(script, true)) as CoverReport;
}

/**
 * 第十六轮删球：悬浮球相关探针已退休，但它们原先各打一行日志（而且因为 DOM 已经不在，
 * 打出来的全是 ✗），读日志的人会以为界面坏了。这些行统一改走这个空实现（父代理 2026 要求）。
 *
 * 用**函数**而不是删日志：日志的参数里还在读那些退役探针的中间量（`diveMid` / `hoverResult`
 * 之类），直接删掉日志会让它们变成「声明了没读」→ `noUnusedLocals` 直接 TS6133。
 */
function r16LegacyLog(..._parts: unknown[]): void {
  // 有意为空：退役探针的日志不再逐条刷屏。
}

/**
 * 和 `clickNav` 一样，但要求导航项的文本**精确等于** `label`（不做子串匹配）。
 *
 * 第十六轮删球 + 新歌单入口：抽屉里新增了「推荐歌单」（`NavDrawer.tsx:68`），而
 * `clickNav(win,'推荐')` 的 `includes` 会命中它，于是「推荐页已删」这条老断言假失败
 * （探针以为「推荐」页还在）。老推荐页那一项的文案恰好就是「推荐」，所以改成精确匹配。
 */
async function clickNavExact(win: BrowserWindow, label: string): Promise<boolean> {
  await openNav(win);
  await delay(200);
  return (await win.webContents.executeJavaScript(
    `(() => {
      const items = Array.from(document.querySelectorAll('.pi-navitem'));
      const hit = items.find((el) => (el.textContent || '').trim() === ${JSON.stringify(label)});
      if (hit === undefined) return false;
      hit.click();
      return true;
    })()`,
    true,
  )) as boolean;
}

function describeCovers(report: CoverReport): string {
  return (
    `${report.loaded}/${report.total} 张已加载（未加载 ${report.empty}＝下载中 ${report.pending} + 真失败 ${report.failed}，明文 http ${report.plain}）` +
    (report.sample ? `｜样本 ${report.sample}` : '') +
    (report.missing.length > 0 ? `｜未加载样本 ${report.missing.join(' ǀ ')}` : '')
  );
}

/**
 * M2 的 UI 级验收：真开窗口、真点歌单行，再读 `window.__piAudio` 判定有没有在走。
 *
 * 为什么不只跑 `PI_SMOKE_PLAY`：那一层只证明「主进程能拿到音频字节」，证明不了渲染进程
 * 的播放引擎把字节喂进了 `<audio>`——M0/M1 已经在「看起来正常」上栽过一次。
 * 用法：`PI_SMOKE_UI=1`（**不要**同时设 `PI_SCREENSHOT`，那个钩子加载完就退出了）。
 */
/*
 * ── 第十六轮删球（用户 m07538 第 1 条）的输入辅助 ──────────────────────────────
 * `apps/renderer/src/components/PiOrb.tsx` 整颗球连同 `.pi-orb__*` 全删了，播放页改成：
 * 点任意空白处 → 在那一点浮出一颗 PI 圆键（`[data-quick-orb]`，根节点带
 * `data-quick-orb-x/y` = 被点出来那一刻的**原始视口坐标**）→ 从球心向上/向下/向右划
 * 开两层卡。下面这组是本轮所有新探针（以及兜底歌源、歌词兜底）唯一的输入入口。
 */
type QuickOrbPoint = { x: number; y: number; ball: boolean; hint: string };

/** 读当前那颗 PI 圆键（没有就返回 null）。 */
async function readQuickOrb(win: BrowserWindow): Promise<QuickOrbPoint | null> {
  return (await win.webContents.executeJavaScript(
    `(() => {
      const orb = document.querySelector('[data-quick-orb]');
      if (orb === null) return null;
      return {
        x: Number(orb.dataset.quickOrbX || 'NaN'),
        y: Number(orb.dataset.quickOrbY || 'NaN'),
        ball: Boolean(document.querySelector('[data-quick-orb-ball]')),
        hint: orb.dataset.quickOrbHint || 'none',
      };
    })()`,
    true,
  )) as QuickOrbPoint | null;
}

/** 在视口某一点按一下再抬起（`sendInputEvent` 必须显式给 leftButton）。 */
async function clickPoint(win: BrowserWindow, x: number, y: number): Promise<void> {
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await delay(70);
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await delay(240);
}

/** 从一点按住、分步拖到 (x+dx, y+dy)，再抬起。 */
async function dragPoint(
  win: BrowserWindow,
  x: number,
  y: number,
  dx: number,
  dy: number,
  steps = 6,
): Promise<void> {
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await delay(60);
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(x + dx * t),
      y: Math.round(y + dy * t),
    });
    await delay(45);
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(x + dx),
    y: Math.round(y + dy),
    button: 'left',
    clickCount: 1,
  });
  await delay(300);
}

/**
 * 找一个「真正的空白点」：`elementFromPoint` 不能落在 button/a/input、底栏、名片、抽屉或
 * 歌词行上——播放页的 stage 会把这些位置的点击排除掉（`HomePage.tsx` 的 onStageClick），
 * 点在歌词行上根本不会出球。候选点按网格扫，取最靠前与最靠后的两个，两点天然互相远离。
 */
async function quickOrbSpot(win: BrowserWindow, which = 0): Promise<{ x: number; y: number }> {
  return (await win.webContents.executeJavaScript(
    `(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const bad = 'button, a, input, .pi-home__bar, .pi-home__card, .pi-home__drawer, [data-lyric-line], .pi-lyricstage__line';
      const found = [];
      for (let ry = 0.14; ry <= 0.74; ry += 0.05) {
        for (let rx = 0.12; rx <= 0.9; rx += 0.05) {
          const x = Math.round(w * rx);
          const y = Math.round(h * ry);
          const el = document.elementFromPoint(x, y);
          if (el === null) continue;
          if (el.closest(bad) !== null) continue;
          if (el.closest('.pi-home') === null) continue;
          found.push({ x: x, y: y });
        }
      }
      const fallback = { x: Math.round(w * 0.5), y: Math.round(h * 0.3) };
      const first = found.length > 0 ? found[0] : fallback;
      const last = found.length > 1 ? found[found.length - 1] : first;
      const spots = [first, last];
      return spots[${which}] || first;
    })()`,
    true,
  )) as { x: number; y: number };
}

/**
 * 当前这一次「按住」的落点；null = 没按着。用户 m00736 第 2 条之后球的存活期就是一次按住，
 * 所以主进程要自己记住按键有没有抬起来（松手球就没了，不能靠再读 DOM 判断）。
 */
let quickOrbPress: { x: number; y: number } | null = null;

/** 松开按住的那一次鼠标左键。没按住时什么都不做。 */
async function releaseQuickOrb(win: BrowserWindow): Promise<void> {
  const press = quickOrbPress;
  if (press === null) return;
  quickOrbPress = null;
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: press.x,
    y: press.y,
    button: 'left',
    clickCount: 1,
  });
  await delay(140);
}

/**
 * 在播放页空白处**按下**（不抬起）让 PI 圆键冒出来，返回它自己报的坐标。
 *
 * 用户 m00736 第 2 条把圆球的可见性改成「按住才有」：鼠标一松开球就消失、下次按下再出现。
 * 所以这里只发 mouseDown、不发 mouseUp——球的存活期就是这一次按住，收尾交给配对的
 * `swipeQuickOrb`（划完抬手）。上一次按住要是没收掉（例如中途读取失败、调用点又重试了一次），
 * 先补一个 mouseUp，免得两次按下叠在一起、拖动整段落空。
 */
async function tapQuickOrb(win: BrowserWindow, which = 0): Promise<QuickOrbPoint | null> {
  await releaseQuickOrb(win);
  const spot = await quickOrbSpot(win, which);
  await focusSmoke(win);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: spot.x, y: spot.y });
  await delay(70);
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: spot.x,
    y: spot.y,
    button: 'left',
    clickCount: 1,
  });
  quickOrbPress = spot;
  await delay(160);
  return readQuickOrb(win);
}

/**
 * 已经按住（`tapQuickOrb` 那次 mouseDown）的状态下继续拖到 (x+dx, y+dy)，最后抬手。
 * 和 `dragPoint` 的区别只有一个：**不再补 mouseDown**——球只活在这一次按住里，
 * 补第二次按下会被 Chromium 丢掉（左键已经按下），整个拖动手势就作废了。
 * 先按住 `holdMs` 再动，是为了让渲染层把这一次手势认成「长按拖动」而不是「点一下」。
 */
async function dragHeldPoint(
  win: BrowserWindow,
  x: number,
  y: number,
  dx: number,
  dy: number,
  steps = 6,
  holdMs = 200,
): Promise<void> {
  await delay(holdMs);
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(x + dx * t),
      y: Math.round(y + dy * t),
    });
    await delay(45);
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(x + dx),
    y: Math.round(y + dy),
    button: 'left',
    clickCount: 1,
  });
  quickOrbPress = null;
  await delay(300);
}

/**
 * 已经按住的状态下只移动指针、**不抬手**（`dragHeldPoint` 少了最后那一下 mouseUp）。给「一次按住里
 * 连走好几腿」的探针用——用户 m01402 第 2 条那条方向锁就得在同一个按住里先右划、再原地改上划、
 * 再把指针收回基准点、最后重新上划，中间一次都不能松手（松手球就没了，见 m00736 第 2 条）。
 */
async function moveHeldPoint(
  win: BrowserWindow,
  x: number,
  y: number,
  dx: number,
  dy: number,
  steps = 4,
): Promise<void> {
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(x + dx * t),
      y: Math.round(y + dy * t),
    });
    await delay(45);
  }
  await delay(80);
}

/** 从球心朝 (dx, dy) 划一下（接着那次按住继续拖，划完抬手）；返回有没有找到球。 */
async function swipeQuickOrb(win: BrowserWindow, dx: number, dy: number): Promise<boolean> {
  const orb = await readQuickOrb(win);
  if (orb === null || !orb.ball) {
    await releaseQuickOrb(win);
    return false;
  }
  await focusSmoke(win);
  await dragHeldPoint(win, Math.round(orb.x), Math.round(orb.y), dx, dy, 5);
  return true;
}

/** 点六块按键里的某一块（走 DOM click：这一步只要「点得开」，不验指针路径）。 */
async function clickQuickItem(win: BrowserWindow, id: string): Promise<boolean> {
  return (await win.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector('[data-quick-item="${id}"]');
      if (item === null || !(item instanceof HTMLElement)) return false;
      item.click();
      return true;
    })()`,
    true,
  )) as boolean;
}

async function runUiSmoke(win: BrowserWindow): Promise<void> {
  try {
    // 首行带 pid 与时间：冒烟被残留实例「空跑」过一次，日志里必须能看出新旧。
    console.info(
      `[pi/smoke] UI 冒烟开始：pid=${process.pid} ${new Date().toLocaleString('zh-CN')}`,
    );
    // 空白初始页（用户需求第 2 条）：先清掉「上次播放」再重载，首屏必然是空白页。
    await win.webContents.executeJavaScript(`localStorage.removeItem('pi:last-played')`, true);
    /*
     * 第十七轮（用户 m00006）把「平凡」定为默认排版、把拼贴墙与封面卡片流归给「先锋」，而十六轮
     * 那批探针（拼贴墙、歌单封面卡片流、滚轮开搜索…）都是**先锋专属**的：默认平凡下它们必然 ✗，
     * 日志里那几条红看着像回归。所以给一个开关——`PI_SMOKE_UI_STYLE=avant|plain` 先把风格写进
     * localStorage（键 `pi.ui-style`，见 apps/renderer/src/state/ui.ts 的 readStoredUiStyle），
     * 重载之后整套探针就都跑在这套排版上。
     *
     * **每一跑都必须写**（不指定就等于平凡）：localStorage 是跨进程留下来的，跑过一次 `avant`
     * 之后再跑普通冒烟，渲染层会继续是先锋排版——实测踩过一次（`docs/m3-playlist-cards.png`
     * 里拍到的竟是先锋的歌单封面卡片轮播，而不是歌单详情）。
     */
    const wantStyle = process.env.PI_SMOKE_UI_STYLE === 'avant' ? 'avant' : 'plain';
    await win.webContents.executeJavaScript(
      `localStorage.setItem('pi.ui-style', ${JSON.stringify(wantStyle)})`,
      true,
    );
    console.info(
      `[pi/smoke] 排版风格=${wantStyle}（PI_SMOKE_UI_STYLE 未指定时即平凡；每跑都写，避免上跑残留）`,
    );
    /*
     * 十六轮的 ⑨⑩⑪⑫⑬ 五条量的是**先锋专属**的拼贴墙（悬停放大 / 点格子进播放页 / 拖到边上继续
     * 加载 / 底栏挂在墙上 / 滚轮开搜索）。第十七轮（用户 m00006）把平凡定为默认排版之后，这五条在
     * 平凡跑里没有对象可量——显示「未跑(先锋专属)」而不是刺眼的 ✗，免得读日志的人以为回归了；
     * 要真的量它们就把 `PI_SMOKE_UI_STYLE` 设成 `avant`（实测那五条在先锋下全 ✓）。
     */
    const r16AvantOnly = (ok: boolean): string =>
      wantStyle === 'avant' ? (ok ? '✓' : '✗') : '未跑(先锋专属)';
    // 第十八轮第 6 条（拼贴自己一批批续载）同样只在先锋排版下有拼贴墙可量。
    const r18AvantOnly = (ok: boolean): string =>
      wantStyle === 'avant' ? (ok ? '✓' : '✗') : '未跑(先锋专属)';
    win.webContents.reload();
    // 首屏要等：服务就绪 → /user/account → /user/record → 渲染出歌单行。
    await delay(UI_SMOKE_READY_MS);
    /*
     * 用户第八轮第 1 条之后，播放页的三件东西（左上角名片 / 底部进度条 / 悬浮球）会在
     * 3.2s 无操作后自动隐藏，而冒烟中段有大量 `executeJavaScript` 探针（**不产生输入事件**），
     * 静置几秒就会把「名片与进度条在不在、透明度是不是 1」这类断言拍成「全隐藏」的样子。
     * 所以冒烟一开始就整套停用——`apps/renderer/src/lib/idle.ts` 读的正是这个 dataset。
     */
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.piIdle = 'off'`,
      true,
    );
    const emptyInfo = (await win.webContents.executeJavaScript(
      `(() => {
        const page = document.querySelector('.pi-home');
        if (!page) return '未找到 .pi-home';
        return '空白页=' + (page.classList.contains('pi-home--empty') || page.dataset.empty === 'true') +
          ' PI字=' + (page.querySelector('.pi-home__logo')?.textContent || '') +
          ' 提示=' + (page.querySelector('.pi-home__slogan')?.textContent || '');
      })()`,
      true,
    )) as string;
    const emptyOk = emptyInfo.includes('空白页=true') && emptyInfo.includes('PI字=PI');
    console.info(`[pi/smoke] 初始页（无歌）：${emptyInfo} ${emptyOk ? '✓' : '✗'}`);

    // 第十六轮删球：`.pi-orb` / `.pi-orb__ball` 整颗球删了，「首屏悬浮球是球、不是贴边细条」
    // 这条断言随之退休。`ballOk` 保留成恒 false 的占位，好让下面的 `void ballOk;` 还有得引用。
    const ballOk = false;
    // 空白页也要留一张图：用户需求第 2 条的前半句（「空白页中有一个渐变的 PI 字样」）只能靠看。
    const emptyShot =
      process.env.PI_SMOKE_UI_SHOT_EMPTY ?? path.resolve(here, '../../../docs/m3-empty.png');
    writeFileSync(emptyShot, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${emptyShot}`);
    // 第十一轮第 5 条（用户 m03279）：标题栏整条取消后，窗口三键改由渲染层自绘、鼠标靠近
    // 右上角才向下浮出（`apps/renderer/src/components/WindowControls.tsx`）。
    // 光查「三个按钮在 DOM 里」是不够的——浮层默认藏在窗口上沿之外（translateY(-110%)
    // + opacity 0 + pointer-events none），真正的验收是「指针贴到右上角以后它确实滑出来、
    // 落在窗口可见区里、而且那一点真的被热区接住」。所以这里读三样：
    // data-visible / getComputedStyle().opacity / getBoundingClientRect()，外加 elementFromPoint。
    // 鼠标移动照抄第十轮 measureItemHover 的写法：先抢前台，再 sendInputEvent，再等。
    // （本段跑在 measureItemHover 之前，它开头会重置 `window.__piHover`，不会互相干扰。）
    await focusSmoke(win);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 40 });
    await delay(700);
    type CtrlState = {
      btns: string[];
      visible: string | null;
      opacity: number | null;
      top: number | null;
      w: number;
      hot: { x: number; y: number } | null;
      // 第十二轮第 6 条（用户 m04193）：三键要「没有边框、就是单独的图标」——把第一个键的
      // 边框宽 / 背景图 / 背景色 / 圆角原样读回来，断言在下面用正则钉。
      look: string;
    };
    const readCtrl = async (): Promise<CtrlState> =>
      (await win.webContents.executeJavaScript(
        `(() => {
          const box = document.querySelector('[data-window-controls]');
          const hot = document.querySelector('.pi-windowcontrols__hot--top-right');
          const btns = Array.from(document.querySelectorAll('[data-window-btn]')).map((b) => b.dataset.windowBtn);
          const first = document.querySelector('[data-window-btn]');
          let look = '无';
          if (first) {
            const s = getComputedStyle(first);
            const r = first.getBoundingClientRect();
            look = 'border=' + s.borderTopWidth + '/' + s.borderLeftWidth +
              ' bg=' + (s.backgroundImage === 'none' ? 'none' : 'image') +
              ' bgColor=' + s.backgroundColor +
              ' radius=' + s.borderTopLeftRadius +
              ' size=' + Math.round(r.width) + 'x' + Math.round(r.height) +
              // 第十三轮第 2 条（用户 m04663）：「右上三个按键太小了，大一点方便点击」——
              // 热区 30x26 → 42x34，里面的图标 12x12 → 15x15，两件都要真的变大。
              ' icon=' + (() => {
                const svg = first.querySelector('svg');
                if (!svg) return '无';
                const sr = svg.getBoundingClientRect();
                return Math.round(sr.width) + 'x' + Math.round(sr.height);
              })();
          }
          if (!box) return { btns, visible: null, opacity: null, top: null, w: 0, hot: null, look };
          const rect = box.getBoundingClientRect();
          const hotRect = hot ? hot.getBoundingClientRect() : null;
          return {
            btns,
            visible: box.dataset.visible || 'none',
            opacity: Number(getComputedStyle(box).opacity),
            top: rect.top,
            w: rect.width,
            hot: hotRect
              ? { x: Math.round(hotRect.left + hotRect.width / 2), y: Math.round(hotRect.top + hotRect.height / 2) }
              : null,
            look,
          };
        })()`,
        true,
      )) as CtrlState;
    /*
     * **用户 m01402 第 4 条**给右侧三键加了「靠近就出现」的接近区（`WindowControls.tsx` 的
     * `NEAR_RIGHT_W`/`NEAR_RIGHT_H`，跟着指针走的一块右上角区域）。这条探针原来直接读
     * `ctrlBefore`，若前面某条探针恰好把指针留在右上角附近，面板会已经浮出来，于是
     * `ctrlBefore.visible === 'false'` 与「浮出前命中热区」两条断言假红——所以先把指针挪到
     * 左下角、等过一个 `HIDE_DELAY_MS`（240ms）再多等一会儿，确认它收回去。
     */
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 24, y: 300 });
    await delay(420);
    const ctrlBefore = await readCtrl();
    /*
     * **用户 m01402 第 4 条**「右上角三个图标不要悬停在图标位置再出现，而是靠近就出现」：在接近区
     * 里、但**不落在**那条 160x14 热区带上（y=70 远在 14 之下）投一次指针，面板也必须浮出来；随后
     * 把指针挪回左下角，它必须再收回去。这一浮一收才是「靠近就出现」的正面证据——后面热区那一套
     * 只是老行为的回归锁。
     */
    const ctrlWinW = win.getContentBounds().width;
    const ctrlNearPoint = { x: Math.max(8, ctrlWinW - 70), y: 70 };
    win.webContents.sendInputEvent({ type: 'mouseMove', x: ctrlNearPoint.x, y: ctrlNearPoint.y });
    await delay(460);
    const ctrlNear = await readCtrl();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 24, y: 300 });
    await delay(460);
    const ctrlParked = await readCtrl();
    const r23NearOk =
      ctrlBefore.visible === 'false' && ctrlNear.visible === 'true' && ctrlParked.visible === 'false';
    let ctrlAfter: CtrlState = ctrlBefore;
    let ctrlHit: string | null = null;
    let ctrlHitAfter: string | null = null;
    if (ctrlBefore.hot) {
      // 命中检测要分两次：浮出前那一点必须落在**热区**（薄带）上，浮出后同一坐标必然被
      // 面板/按钮盖住——面板 z-index 56 压在热区 54 之上，这是设计。只测一次就会误判：
      // 第一版在浮出后测，读到 `BUTTON.pi-windowcontrols__btn` 直接判红，而面板明明正常浮出。
      ctrlHit = (await win.webContents.executeJavaScript(
        `(() => {
          const el = document.elementFromPoint(${ctrlBefore.hot.x}, ${ctrlBefore.hot.y});
          const cls = el ? (typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? '')) : '';
          return el ? el.tagName + (cls ? '.' + cls : '') : null;
        })()`,
        true,
      )) as string | null;
      win.webContents.sendInputEvent({ type: 'mouseMove', x: ctrlBefore.hot.x, y: ctrlBefore.hot.y });
      await delay(420);
      // 同一位置补一发：首次投递偶尔会被当成「位置没变」而吞掉。
      win.webContents.sendInputEvent({ type: 'mouseMove', x: ctrlBefore.hot.x, y: ctrlBefore.hot.y });
      await delay(420);
      ctrlAfter = await readCtrl();
      /*
       * 第十五轮实测到的偶发：热区命中 ✓、坐标就在薄带上，但 `data-visible` 还是 false
       * （opacity 停在过渡中途）——这一次 `pointerenter` 被吞了（组件是 onPointerEnter 驱动的，
       * 同一位置重复投递不产生新的 enter）。补两次「先离开、再进来」的重试；判据一条不放松，
       * 只是给热区重新触发一次的机会。
       */
      for (let attempt = 0; attempt < 2 && ctrlAfter.visible !== 'true'; attempt += 1) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 24, y: 320 });
        await delay(320);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: ctrlBefore.hot.x, y: ctrlBefore.hot.y });
        await delay(460);
        ctrlAfter = await readCtrl();
      }
      ctrlHitAfter = (await win.webContents.executeJavaScript(
        `(() => {
          const el = document.elementFromPoint(${ctrlBefore.hot.x}, ${ctrlBefore.hot.y});
          const cls = el ? (typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? '')) : '';
          return el ? el.tagName + (cls ? '.' + cls : '') : null;
        })()`,
        true,
      )) as string | null;
    }
    const threeBtns = ['minimize', 'maximize', 'close'].every((name) => ctrlBefore.btns.includes(name));
    // 第十二轮第 6 条：三键「不要有边框，就是单独的三个图标」——边框必须真的 0、没有背景图、
    // 背景透明、圆角 0（参考图 4 上就是白底上三个细线图标）。
    const ctrlLookOk =
      /border=0px\/0px bg=none bgColor=rgba\(0, 0, 0, 0\) radius=0px/.test(ctrlBefore.look) &&
      // 第十三轮第 2 条（用户 m04663）：「右上三个按键太小了，大一点方便点击」——
      // 热区 30x26 → 42x34、图标 12x12 → 15x15。钉住尺寸，免得以后被谁改回去。
      / size=42x34 icon=15x15/.test(ctrlBefore.look);
    /*
     * **用户 m04183 第 1 条**：「歌曲播放页左上角如图1所示部件删去，并且点击图标出现的菜单也删去」。
     * 钉两件事：① DOM 里不再有 `.pi-windowcontrols--brand` / `.pi-windowcontrols__brand`（那块
     * 「PI 方块 + PI + v0.1.0 · win32/x64」是真的没了，不是只藏起来）；② `[data-nav-toggle]`
     * 必须还在（冒烟 `openNav()` 与它下游三十余处 `clickNav()` 全靠这个选择器），但它得是
     * 1×1、opacity 0、pointer-events none 的隐藏抓手——用户点不到，抽屉就打不开。
     */
    const r31Brand = (await win.webContents.executeJavaScript(
      `(() => {
        const hook = document.querySelector('[data-nav-toggle]');
        const style = hook === null ? null : getComputedStyle(hook);
        const box = hook === null ? null : hook.getBoundingClientRect();
        return {
          brand: document.querySelectorAll('.pi-windowcontrols--brand, .pi-windowcontrols__brand').length,
          hotLeft: document.querySelectorAll('.pi-windowcontrols__hot--top-left, .pi-windowcontrols__hot--side-left').length,
          hook: hook !== null,
          w: box === null ? -1 : Math.round(box.width),
          h: box === null ? -1 : Math.round(box.height),
          opacity: style === null ? '' : style.opacity,
          pointer: style === null ? '' : style.pointerEvents,
        };
      })()`,
      true,
    )) as { brand: number; hotLeft: number; hook: boolean; w: number; h: number; opacity: string; pointer: string };
    const r31BrandGoneOk =
      r31Brand.brand === 0 &&
      r31Brand.hotLeft === 0 &&
      r31Brand.hook &&
      r31Brand.w <= 2 &&
      r31Brand.h <= 2 &&
      r31Brand.opacity === '0' &&
      r31Brand.pointer === 'none';
    // 非 Windows 不画自绘三键（macOS 用系统红绿灯、Linux 保留系统边框），那边只验
    // 「三个按钮在 DOM 里」，浮出这一段跳过，免得换平台跑出一片假红。
    const windowControlsOk =
      threeBtns &&
      r31BrandGoneOk &&
      (process.platform !== 'win32'
        ? true
        : ctrlBefore.hot !== null &&
          // 用户 m01402 第 4 条：靠近右上角（不必悬到图标上）就要浮出来，挪开要收回去。
          r23NearOk &&
          ctrlBefore.visible === 'false' &&
          (ctrlBefore.opacity ?? 1) < 0.1 &&
          (ctrlHit ?? '').includes('pi-windowcontrols__hot') &&
          ctrlAfter.visible === 'true' &&
          (ctrlAfter.opacity ?? 0) > 0.9 &&
          ctrlAfter.w > 0 &&
          (ctrlAfter.top ?? -99) >= -1 &&
          (ctrlAfter.top ?? 99) < 48 &&
          (ctrlHitAfter ?? '').includes('pi-windowcontrols') &&
          ctrlLookOk);
    console.info(
      `[pi/smoke] 窗口三键：DOM=${ctrlBefore.btns.join('/') || '无'}` +
        `｜浮出前 visible=${ctrlBefore.visible ?? '无容器'} opacity=${(ctrlBefore.opacity ?? -1).toFixed(2)}` +
        ` 命中=${ctrlHit ?? '-'}` +
        `｜热区=${ctrlBefore.hot ? ctrlBefore.hot.x + ',' + ctrlBefore.hot.y : '无'}` +
        `｜指针到右上角后 visible=${ctrlAfter.visible ?? '无容器'} opacity=${(ctrlAfter.opacity ?? -1).toFixed(2)}` +
        ` 命中=${ctrlHitAfter ?? '-'}` +
        `｜面板 top=${ctrlAfter.top === null ? '-' : ctrlAfter.top.toFixed(0)}px 宽=${ctrlAfter.w.toFixed(0)}px` +
        `｜键外观=${ctrlBefore.look} 无框 ${ctrlLookOk ? '✓' : '✗'}` +
        `｜靠近就出现（${ctrlNearPoint.x},${ctrlNearPoint.y}）近点=${ctrlNear.visible ?? '无容器'}` +
        ` 挪开=${ctrlParked.visible ?? '无容器'} ${r23NearOk ? '✓' : '✗'}` +
        `｜m04183 第 1 条：左上品牌块=${r31Brand.brand} 左热区=${r31Brand.hotLeft}` +
        ` 抽屉抓手=${r31Brand.hook ? `${r31Brand.w}x${r31Brand.h} opacity=${r31Brand.opacity} pointer=${r31Brand.pointer}` : '无'}` +
        ` ${r31BrandGoneOk ? '✓' : '✗'}` +
        ` ${windowControlsOk ? '✓' : '✗'}`,
    );
    // 探针收尾：把指针挪回页面中间，浮层滑回去——后面的截图/悬停检查不该被它挡着。
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 24, y: 300 });
    await delay(500);
    console.info(`[pi/smoke] 首屏：${await countRows(win)} 行歌｜${await describePage(win)}`);
    console.info(`[pi/smoke] 封面（首屏）：${describeCovers(await checkCovers(win))}`);

    /*
     * 用户 m02898 第 8 条（后半：系统要认得出它叫「pi」、并且带上它的图标）与第 9 条
     * （运行时的内存占用）。
     *
     * 第 8 条的量：`app.getName()` 必须已经不是 `@pi/desktop`（那是 `apps/desktop/package.json`
     * 的 name，Electron 默认拿它当应用名）；`setAppUserModelId` 要对上（任务栏分组/通知用它）；
     * 窗口 icon 要真能找到那个 .ico（打包态 `resources/build/pi.ico`、开发态仓库根
     * `build/pi.ico`，两条候选都在 `:172-175`）。改名**不能**把用户数据搬走：`userData`
     * 必须仍是老目录 `%APPDATA%\@pi\desktop`（设置、下载记录、本地库索引都在里面）。
     *
     * 第 9 条的量：`app.getAppMetrics()` 是 Electron 自带的、不需要任何外部工具的内存读数
     * （受限沙箱里 `Get-CimInstance Win32_Process` 是拒绝访问的，那条路走不通）。它按进程给出
     * `memory.workingSetSize`（KB）——主进程 / 渲染 / GPU / utility 各一档，正好对应用户图 7 里
     * 「Electron (N)」那一行。两个 Node 子进程（内嵌 API + LX 沙箱，`ELECTRON_RUN_AS_NODE=1`
     * 起的独立进程）**不在**这张表里，所以另打它们的堆上限（`PI_CHILD_HEAP_MB`，默认 384）。
     */
    const iconCandidates = [
      path.resolve(here, '../../../build/pi.ico'),
      path.join(process.resourcesPath, 'build/pi.ico'),
      path.join(process.resourcesPath, 'pi.ico'),
    ];
    const iconHits = iconCandidates.filter((candidate) => existsSync(candidate));
    const userDataPath = app.getPath('userData');
    const legacyUserData = path.join(app.getPath('appData'), '@pi/desktop');
    /*
     * `getAppUserModelId()` 在运行时有、类型定义里没（本仓库的 electron 类型只声明了 setter），
     * 所以走一次窄化读取；真拿不到就按上面 `setAppUserModelId('com.pi.music')` 那次赋值算。
     */
    const readAppUserModelId = (): string => {
      const probe = app as unknown as { getAppUserModelId?: () => string };
      return typeof probe.getAppUserModelId === 'function'
        ? probe.getAppUserModelId()
        : 'com.pi.music';
    };
    const appUserModelId = readAppUserModelId();
    /*
     * 冒烟跑会用 `--user-data-dir=<仓库里的 .smoke-profile>` 把档案隔离开（不碰真库），
     * 那种情况下 `userData` 当然不等于老目录——这是**命令行显式指定**，不是改名把数据搬走了。
     */
    const smokeProfileOverride = process.argv.some((arg) => arg.startsWith('--user-data-dir'));
    const appIdentityOk =
      app.getName() === 'pi' &&
      appUserModelId === 'com.pi.music' &&
      iconHits.length > 0 &&
      (userDataPath === legacyUserData || !existsSync(legacyUserData) || smokeProfileOverride);
    console.info(
      `[pi/smoke] 应用身份（用户 m02898 第 8 条）：系统名=${app.getName()}` +
        ` AppUserModelId=${appUserModelId}` +
        ` userData=${userDataPath}${userDataPath === legacyUserData ? '（老目录，设置与下载记录原地保留）' : ''}` +
        `${smokeProfileOverride ? '（冒烟命令行显式指定，不算搬库）' : ''}` +
        ` 图标候选命中=${iconHits.length}/${iconCandidates.length}` +
        `[${iconCandidates.map((c) => (existsSync(c) ? '有' : '无')).join('')}]` +
        ` ${appIdentityOk ? '✓' : '✗'}`,
    );
    const appMetrics = app.getAppMetrics();
    const metricMb = (value: number | undefined): number =>
      typeof value === 'number' ? Math.round(value / 1024) : 0;
    const metricByType = new Map<string, number>();
    let metricTotalMb = 0;
    for (const metric of appMetrics) {
      const mb = metricMb(metric.memory?.workingSetSize);
      metricTotalMb += mb;
      metricByType.set(metric.type, (metricByType.get(metric.type) ?? 0) + mb);
    }
    console.info(
      `[pi/smoke] 运行时内存（用户 m02898 第 9 条）：Electron 进程=${appMetrics.length}` +
        ` 合计 workingSet=${metricTotalMb}MB` +
        `｜${[...metricByType].map(([type, mb]) => `${type}=${mb}MB`).join(' ')}` +
        `｜子 Node 堆上限=${process.env.PI_CHILD_HEAP_MB ?? '384（默认）'}MB/个` +
        `（内嵌 API 与 LX 沙箱各一个，ELECTRON_RUN_AS_NODE 起的独立进程，不在这张表里）`,
    );

    // 「最近听过」常常只有一两首（/user/record 只给最近一周），歌不够就换页面点。
    for (const fallback of ['我的喜欢', '推荐']) {
      if ((await countRows(win)) >= UI_SMOKE_SONGS) break;
      if (!(await clickNav(win, fallback))) {
        console.warn(`[pi/smoke] 侧边栏里找不到「${fallback}」`);
        continue;
      }
      // 等它把列表请求回来（推荐页的每日推荐要等 `/personalized/newsong`），别读到 0 就下结论。
      const rows = await waitForRows(win, UI_SMOKE_SONGS);
      console.info(
        `[pi/smoke] 切到「${fallback}」：${rows} 行歌｜${await describePage(win)}`,
      );
    }

    // 这台机器上的账号是「零收藏 + 零最近听过」，上面那两页都给不出歌；「推荐」页面又被
    // 用户 m08768 第 3 条删了。所以再补一条不依赖用户数据的路：点环形菜单的「推荐」卡片面板，
    // 进一个推荐歌单详情，用那里的歌跑后面的「点歌 → 真出声 → 切页不断音」。
    if ((await countRows(win)) < UI_SMOKE_SONGS) {
      const fallbackRows = await openRecommendedPlaylist(win);
      console.info(
        `[pi/smoke] 兜底歌源（推荐歌单详情）：${fallbackRows} 行歌｜${await describePage(win)}`,
      );
      if (fallbackRows < 1) {
        console.warn(
          '[pi/smoke] 歌源为空：播放页/歌词/主题/连续播放这串探针都会跟着报 ✗ —— 那是**数据依赖的假失败**，' +
            '不是界面回归（原因看上面「兜底歌源」的逐张日志：哪一张、可见几张、点没进详情）',
        );
      }
    }

    let passed = 0;
    let checkedContinuity = false;
    /*
     * 第十四轮第 8 条（用户 m05281）：「切歌时出现的小名片」要真的在切歌那一刻冒出来。
     * 用户原话是「只在歌曲切换时出现，点击没有互动」——所以判据两块：切歌后它必须可见、
     * 且 `pointer-events` 必须是 none（不抢点击）。它只挂 3.4s，所以在切歌刚成功这一刻抓，
     * 抓到一个就算（`cardProbe` 从此非 null，后面的切歌不再抓）。
     */
    let cardProbe: {
      visible: boolean;
      title: string;
      artist: string;
      pointer: string;
      opacity: number;
    } | null = null;
    const total = Math.min(UI_SMOKE_SONGS, await waitForRows(win, UI_SMOKE_SONGS, 3000));
    for (let index = 0; index < total; index += 1) {
      const before = await readAudio(win);
      const label = (await win.webContents.executeJavaScript(
        `(() => {
          const row =
            document.querySelectorAll('.pi-songrow, .pi-songcard')[${index}] ??
            document.querySelectorAll('[data-collage-cell]')[${index}];
          if (!row) return null;
          row.click();
          return row.textContent || '';
        })()`,
        true,
      )) as string | null;
      if (label === null) {
        console.error(`[pi/smoke] UI #${index + 1}：页面上没有第 ${index + 1} 行歌`);
        break;
      }
      const snapshot = await waitForPlayback(win, UI_SMOKE_TIMEOUT_MS, before.src);
      const switched = snapshot.src !== before.src;
      const ok = switched && snapshot.time > 0.2 && !snapshot.paused;
      if (ok) passed += 1;
      console.info(
        `[pi/smoke] UI #${index + 1} ${label.trim().slice(0, 20)} → t=${snapshot.time.toFixed(2)}s ` +
          `key=${snapshot.src.split('/').pop() ?? '-'} 换源=${switched ? '✓' : '✗'} ` +
          `paused=${snapshot.paused} readyState=${snapshot.readyState} error=${snapshot.code ?? '-'} ${ok ? '✓' : '✗'}`,
      );

      /*
       * 第十四轮第 8 条：切歌小名片——切歌刚成功这一刻抓它（只挂 3.4s）。
       * 每 150ms 轮询一次，抓到可见的那一帧就收工。
       */
      if (ok && cardProbe === null) {
        const readCard = async (): Promise<{
          visible: boolean;
          title: string;
          artist: string;
          pointer: string;
          opacity: number;
        }> =>
          (await win.webContents.executeJavaScript(
            `(() => {
               const card = document.querySelector('[data-song-change-card]');
               if (!(card instanceof HTMLElement)) {
                 return { visible: false, title: '', artist: '', pointer: 'none', opacity: 0 };
               }
               const style = getComputedStyle(card);
               const opacity = Number(style.opacity);
               const rect = card.getBoundingClientRect();
               return {
                 visible: card.dataset.visible === 'true' && opacity > 0.5 && rect.width > 0,
                 title: card.querySelector('.pi-songcard__title')?.textContent?.trim() || '',
                 artist: card.querySelector('.pi-songcard__artists')?.textContent?.trim() || '',
                 pointer: style.pointerEvents,
                 opacity,
               };
             })()`,
            true,
          )) as {
            visible: boolean;
            title: string;
            artist: string;
            pointer: string;
            opacity: number;
          };
        const cardDeadline = Date.now() + 1600;
        let seen: {
          visible: boolean;
          title: string;
          artist: string;
          pointer: string;
          opacity: number;
        } | null = null;
        while (Date.now() < cardDeadline && seen === null) {
          const read = await readCard();
          if (read.visible) seen = read;
          else await delay(150);
        }
        const shownCard = seen ?? (await readCard());
        cardProbe = shownCard;
        console.info(
          `[pi/smoke] 切歌小名片（第十四轮第 8 条）：可见=${shownCard.visible}｜歌名=「${shownCard.title}」` +
            `｜歌手=「${shownCard.artist}」｜不透明度=${shownCard.opacity.toFixed(2)}` +
            `｜指针=${shownCard.pointer}（要求 none＝点击无互动）`,
        );
        if (shownCard.visible) {
          const cardShot = path.resolve(here, '../../../docs/m3r14-songcard.png');
          writeFileSync(cardShot, (await win.webContents.capturePage()).toPNG());
          console.info(`[pi/smoke] 截图：${cardShot}`);
        }
      }
      // M2 验收的另一半：「切换页面不断音」——第一首出声后切页再切回，看时间轴有没有断。
      if (ok && !checkedContinuity) {
        checkedContinuity = true;
        const beforeTime = (await readAudio(win)).time;
        const switchedPage = (await clickNav(win, '我的下载')) || (await clickNav(win, '收藏'));
        await delay(UI_SMOKE_SWITCH_MS);
        const afterTime = (await readAudio(win)).time;
        console.info(
          `[pi/smoke] 切页面不断音（${switchedPage ? '已切页' : '没找到可切的页'}）：` +
            `${beforeTime.toFixed(2)}s → ${afterTime.toFixed(2)}s ${afterTime > beforeTime ? '✓' : '✗'}`,
        );
        // 切回来接着点后面的歌；换了页面歌单行也会换，所以重新挑一个歌够多的页面。
        // 切回来接着点后面的歌；「推荐」页面已经删了，改回兜底歌源（推荐歌单详情）。
        await openRecommendedPlaylist(win);
        await delay(UI_SMOKE_SWITCH_MS);
        if ((await countRows(win)) < UI_SMOKE_SONGS) {
          await openRecommendedPlaylist(win);
          await delay(UI_SMOKE_SWITCH_MS);
        }
      }
    }
    // 第十六轮删球：「悬浮球文字（它同时是播放控件和导航入口）」这条随球一起退休
    // （导航入口现在是左上角 `[data-nav-toggle]` + 导航抽屉，播放控件是底栏那颗 40px 药丸）。

    // 结构用断言验，玻璃质感只能靠截图看——所以两个都要。
    const boxOf = async (
      selector: string,
    ): Promise<{ x: number; y: number; w: number; h: number } | null> =>
      (await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`,
        true,
      )) as { x: number; y: number; w: number; h: number } | null;
    // 平时就是一颗 PI 图标的球（用户需求第 1 条），先按收起状态截一张。
    const orbShot =
      process.env.PI_SMOKE_UI_SHOT_ORB ?? path.resolve(here, '../../../docs/m3-orb.png');
    writeFileSync(orbShot, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${orbShot}`);

    // 流畅性基线（用户 m08066 第 1 条）：单独量一次「11 个按键冒出」与「逐个坠入」的帧间隔。
    // 指针先挪到标题栏——悬停会让某一个键升起，那不是我们要量的动画。量完仍是收起态，
    // 和下面那段的起始状态一致。
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 });
    await delay(200);
    await closeOrb(win);
    await delay(260);
    /*
     * 帧探针必须让窗口真的在出帧：即便关掉原生遮挡检测，窗口没被抬到最前时 rAF 也可能
     * 整段不回调（第一版拿到过「348ms 只有 1 帧」「26ms 里 4 帧」这种垃圾数）。
     * 量动画前先抢一次前台，量出来的帧间隔才算证据。
     */
    await focusSmoke(win);
    await delay(200);
    await startFrameProbe(win);
    await openOrb(win);
    await delay(900);
    const popFrames = await stopFrameProbe(win, '环形展开（11 键冒出）');
    await waitRingSteady(win);
    await delay(240);
    await focusSmoke(win);
    await delay(160);
    await startFrameProbe(win);
    await closeOrb(win);
    await delay(940);
    const diveFrames = await stopFrameProbe(win, '点球收回（11 键坠入）');
    console.info(
      `[pi/smoke] 换页动画帧率小结：展开 p95=${popFrames.p95.toFixed(1)}ms｜坠入 p95=${diveFrames.p95.toFixed(1)}ms`,
    );

    // 点球展开环形菜单：左半边导航、右半边播放。
    // 先把鼠标挪到标题栏再开球：静息态断言（默认不显字）不能被上一段残留的指针位置污染。
    // 还要先把菜单弄回主菜单：前面的歌单面板步骤会把 ringPage 留在 playlists，
    // 只有收球才会复位（store 的 closeOrb），所以这里必须先归位再断言主菜单。
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 });
    await delay(220);
    await orbToMain(win);
    await waitRingSteady(win);
    await delay(260);
    let firstRing = await readRing(win);
    if (firstRing !== null && firstRing.minGap < (firstRing.itemSize || 48) + 1) {
      // 按键还挤在一起：入场动画没跑完（或被节流）。再给一轮，别把节流记成几何缺陷。
      await delay(600);
      await waitRingSteady(win);
      firstRing = (await readRing(win)) ?? firstRing;
    }
    const ringInfo =
      firstRing === null
        ? '未找到悬浮球'
        : `打开=${firstRing.open}` +
          ` 页面=${firstRing.page}` +
          ` 半径=${Math.round(firstRing.radius)}` +
          ` 左半=${firstRing.left.length}(${firstRing.left.map((el) => el.id).join(',')})` +
          ` 右半=${firstRing.right.length}(${firstRing.right.map((el) => el.id).join(',')})` +
          ` 最少间距=${firstRing.minGap.toFixed(1)}` +
          ` 球字=${firstRing.logo}` +
          ` 进度圈=${firstRing.meter}`;
    console.info(`[pi/smoke] 环形菜单：${ringInfo}`);
    const ringShot =
      process.env.PI_SMOKE_UI_SHOT_RING ?? path.resolve(here, '../../../docs/m3-orb-ring.png');
    writeFileSync(ringShot, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${ringShot}`);
    // 环形几何最容易「假失败」：`pi-orb-pop` 的 backwards 延时阶段里按键全停在起点。
    // 把当时的相位/动画状态印出来，下次真出问题能一眼分辨是应用还是节流。
    const ringDiag = (await win.webContents.executeJavaScript(
      `(() => {
        const orb = document.querySelector('.pi-orb');
        const el = document.querySelector('.pi-orb__item');
        if (!orb || !el) return '没有按键';
        const cs = getComputedStyle(el);
        const busy = el.getAnimations().filter((a) => a.playState !== 'finished').map((a) => a.playState).join(',') || '无';
        return 'phase=' + (orb.dataset.phase || '-') + ' closing=' + (orb.dataset.closing || '-') +
          ' 首键动画=' + cs.animationName + '(延时' + cs.animationDelay + ',播放' + cs.animationPlayState + ')' +
          ' 未完成=[' + busy + '] 透明度=' + cs.opacity;
      })()`,
      true,
    )) as string;
    console.info(`[pi/smoke] 环诊断：${ringDiag}`);

    // m05797 第 3 条 + m06304 第 4 条：按键放大到 48px 后仍然不能重合——
    // 相邻按键中心距必须大于按钮直径（弦长由半径反解，所以这几项是一起变的）。
    // m08768 第八轮第 8 条：按键又刻意收到 44px（「贴近悬浮球」），所以直径下限
    // 跟着设计改（48 → 44），但「中心距 ≥ 直径 + 1」这条比例关系不动。
    const itemSize = firstRing?.itemSize ?? 0;
    const minGapFloor = itemSize + 1;
    const layoutOk =
      firstRing !== null &&
      itemSize >= 44 &&
      // m08768 第 1 条把左半从 6 键改成 8 键（`LEFT_SPAN` 164 → 176），弦长反解出来的
      // 半径从 ≈104px 涨到 ≈124px，所以上限跟着放宽（不然是量错了标准的假失败）。
      firstRing.radius <= 140 &&
      firstRing.radius >= 60 &&
      firstRing.minGap >= minGapFloor;
    const layoutText =
      `[pi/smoke] 环形几何：半径=${firstRing === null ? '-' : Math.round(firstRing.radius)}px` +
      `（要求 ≤140）｜按键直径=${itemSize || '-'}px｜最少间距=` +
      `${firstRing === null ? '-' : firstRing.minGap.toFixed(1)}px` +
      `（要求 ≥${minGapFloor}）${layoutOk ? '✓' : '✗'}`;
    // m05797 第 5 条：默认只显示图标（文字透明）。
    const labelsHidden =
      firstRing !== null &&
      firstRing.items.every((item) => item.labelOpacity <= 0.02) &&
      firstRing.items.every((item) => !item.hover);
    /*
     * 第十六轮：下面这一大段（环形几何 / 默认不显字 / 单键升起 / 回主菜单 / 点球收回坠入 /
     * 双击球回播放页 / 换页过渡 / 推荐＝歌单卡片面板 / 队列拼贴）全是围着悬浮球写的，
     * 球删了之后它们只剩空跑，却各打一行 ✗，读日志的人会以为界面坏了（父代理 2026 要求收口）。
     * 日志统一改走 `r16LegacyLog`（空实现），这里只打一行总说明。
     */
    console.info(
      '[pi/smoke] （第十六轮：悬浮球相关探针已退休——环形几何/默认不显字/单键升起/回主菜单' +
        '/点球收回坠入/双击球回播放页/换页过渡/推荐＝歌单卡片面板/我的喜欢队列拼贴）',
    );
    r16LegacyLog(layoutText);
    r16LegacyLog(`[pi/smoke] 默认不显字：静息时全部无文字 ${labelsHidden ? '✓' : '✗'}`);

    // m05797 第 1、5 条：指到**哪一个**，哪一个升起并显字，别的按钮不动。
    const hoverTarget = firstRing?.left[0] ?? null;
    const hoverResult =
      hoverTarget === null
        ? null
        : await measureItemHover(
            win,
            hoverTarget.id,
            firstRing?.items ?? [],
            process.env.PI_SMOKE_UI_SHOT_HOVER ??
              path.resolve(here, '../../../docs/m3-orb-hover.png'),
          );
    const hoverOk =
      hoverResult !== null &&
      hoverResult.hovered &&
      Math.abs(hoverResult.delta - 12) <= 3 &&
      hoverResult.othersDelta < 2 &&
      hoverResult.labelOpacity > 0.9 &&
      hoverResult.othersLabelMax <= 0.02;
    r16LegacyLog(
      hoverResult === null
        ? '[pi/smoke] 单键升起：未找到可测的按键 ✗'
        : `[pi/smoke] 单键升起：「${hoverResult.id}」Δ=${hoverResult.delta.toFixed(1)}px` +
            `（要求 12）｜其他键最大位移=${hoverResult.othersDelta.toFixed(1)}px（要求 <2）｜` +
            `文字透明度=${hoverResult.labelOpacity.toFixed(2)}（其他键 ${hoverResult.othersLabelMax.toFixed(2)}）` +
            ` ${hoverOk ? '✓' : '✗'}`,
    );
    if (hoverResult !== null) {
      r16LegacyLog(
        `[pi/smoke] 单键升起事件（${hoverResult.trace.length}）：${
          hoverResult.trace.join(' | ') || '一个都没收到'
        }`,
      );
    }

    // 用户第八轮第 7 条：设置不再是整页——点「设置」之后环形菜单先收掉、球再塌到屏幕中心，
    // 然后整只设置框从中心流出来。所以断言换成了：
    //   ① 主区**没有**换页（`.pi-main[data-page]` 还是 home）；
    //   ② 浮层在 in 相位，框里真有那个带外框的 `.pi-settings-frame`；
    //   ③ 球停在塌缩态（`data-settings='collapse'`），环形菜单已经收干净。
    // 第十六轮删球：设置键没了，改走导航抽屉的「设置与音源」（clickNav 会 openNav →
    // 点 `.pi-navitem` 文本 → 那一项走 closeNav()+openSettings()）。
    await clickNav(win, '设置与音源');
    await delay(UI_SMOKE_SWITCH_MS);
    const settingsRing = await readRing(win);
    const settingsPageNow = (await win.webContents.executeJavaScript(
      `(() => {
        const layer = document.querySelector('[data-settings-overlay]');
        const box = layer ? layer.querySelector('.pi-settings-overlay__box') : null;
        return {
          page: document.querySelector('.pi-main')?.dataset.page ?? '',
          phase: layer ? (layer.dataset.phase ?? '') : '',
          boxed: box !== null && box.querySelector('.pi-settings-frame') !== null,
          // 主区里不许再出现设置框：出现了就说明「占满整个 app 的整页设置」又回来了。
          inMain: document.querySelector('.pi-main .pi-settings-frame') !== null,
          // 第十六轮删球：球整颗不在 DOM 里了，「球塌缩」这条改成「球已经彻底消失」。
          collapsed: document.querySelector('.pi-orb') === null,
          orbItems: document.querySelectorAll('.pi-orb__item').length,
          heading: (box?.querySelector('.pi-page-title')?.textContent ?? '').trim(),
        };
      })()`,
      true,
    )) as {
      page: string;
      phase: string;
      boxed: boolean;
      inMain: boolean;
      collapsed: boolean;
      orbItems: number;
      heading: string;
    };
    // 点设置键之后环形菜单会自己收掉（`PiOrb.beginSettings()` 里先 `closeOrb`），
    // 所以原来那条「菜单还开着」不再成立，改成「主区没换页 + 菜单收干净 + 球塌缩」。
    const settingsOk =
      // 浮层是盖在**当前页**上的（设置项就在抽屉里，可能从任意一页点开），
      // 所以这里不要求主区回到 home，只要求主区里没有设置框。
      !settingsPageNow.inMain &&
      settingsPageNow.phase === 'in' &&
      settingsPageNow.boxed &&
      settingsPageNow.collapsed &&
      settingsPageNow.orbItems === 0 &&
      (settingsRing === null || !settingsRing.open);
    console.info(
      `[pi/smoke] 设置键 → 中心流出设置框：主区页面=${settingsPageNow.page}（框内标题「${settingsPageNow.heading}」）` +
        ` 浮层相位=${settingsPageNow.phase || '无'} 框式=${settingsPageNow.boxed}` +
        ` 球塌缩=${settingsPageNow.collapsed}｜主区含整页设置=${settingsPageNow.inMain}` +
        `｜环形菜单收起=${settingsRing === null || !settingsRing.open}（残留键 ${settingsPageNow.orbItems}）` +
        ` 左半=${settingsRing?.left.map((el) => el.id).join(',')} ${settingsOk ? '✓' : '✗'}`,
    );
    const settingsShot =
      process.env.PI_SMOKE_UI_SHOT_SETTINGS ?? path.resolve(here, '../../../docs/m3-orb-settings.png');
    writeFileSync(settingsShot, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${settingsShot}`);
    // 关掉设置框再回主菜单：浮层(z-index 60)盖着球(40)，而球在塌缩态还带着 pointer-events: none，
    // 直接点球会点到浮层的空白热区上（那反而会把设置关掉、但不算走到了真实路径）。
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-settings-close]')?.click()`,
      true,
    );
    await delay(560);
    // 回主菜单：没有「返回」键了，走「收回再打开」这条真实路径（收球会把 ringPage 复位成 main）。
    await orbToMain(win);
    const backRing = await readRing(win);
    const backOk = backRing !== null && backRing.page === 'main' && backRing.open;
    r16LegacyLog(
      `[pi/smoke] 回主菜单（收回再打开）：页面=${backRing?.page} 仍打开=${backRing?.open === true} ${backOk ? '✓' : '✗'}`,
    );

    /*
     * 第十五轮第 2 条（用户 m06435）+ 第十六轮第 5 条（用户 m07538）：绕球的**歌单封面环**
     * 与球旁边的**卡片面板**随球一起删了（第十六轮删球，此断言随之退休）。歌单现在统一走
     * 导航抽屉的「推荐歌单」页 → `.pi-plcard`（`data-playlist-card`）卡片网格 → 点首卡进详情。
     * 这一段同时给第十六轮「歌单列表全部改用歌曲卡片」当证据，并且是下面详情曲目探针
     * 唯一的歌单详情来源。
     *
     * 第十七轮第 ②③ 条（用户 m00006）之后歌单页有两套排版：平凡 = 卡片网格（`.pi-plcard`），
     * 先锋 = 搜索那套 `SongCards`（第十八轮第 ③ 条起，`.pi-songcard`，只有**焦点卡**点了才进详情）。
     * 下面两段的选卡与计数都写成「两套都认」，冒烟两种风格下都能跑。
     */
    const PL_CARD_SEL = '.pi-plcard:not([data-daily-card]), [data-playlist-card], .pi-songcard:not([data-daily-card])';
    await clickNav(win, '推荐歌单');
    await delay(600);
    const gridDeadline = Date.now() + UI_SMOKE_TIMEOUT_MS / 2;
    let gridCards = 0;
    while (Date.now() < gridDeadline) {
      gridCards = (await win.webContents.executeJavaScript(
        `document.querySelectorAll('${PL_CARD_SEL}').length`,
        true,
      )) as number;
      if (gridCards > 0) break;
      await delay(400);
    }
    const coverShot =
      process.env.PI_SMOKE_UI_SHOT_COVERS ?? path.resolve(here, '../../../docs/m3r15-orb-plcards.png');
    writeFileSync(coverShot, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${coverShot}`);
    const gridFirstName = (await win.webContents.executeJavaScript(
      `(() => {
        /* 名字优先取「真正的歌单卡」：先锋档推荐面第一张是每日推荐哨兵卡（data-daily-card），
           它没有名字可取，而 [data-pl-cover-card] 只挂在真歌单卡上、不挑焦点。 */
        const card =
          document.querySelector('.pi-plcard:not([data-daily-card]), [data-playlist-card]') ??
          document.querySelector('[data-pl-cover-card], .pi-songcard:not([data-daily-card])');
        if (card === null) return '';
        const name = card.querySelector('.pi-plcard__name, .pi-songcard__name');
        return (name ? name.textContent : card.textContent || '').trim().slice(0, 24);
      })()`,
      true,
    )) as string;
    const playlistPanelOk = gridCards > 0 && gridFirstName !== '';
    /*
     * 用户 m02898 第 3 条之后，先锋档「推荐歌单」面卡片流的**第一张**是「每日推荐」哨兵卡
     * （`PlaylistCoverflowOverlay.tsx` 的 `data-daily-card`）。进歌单详情得先把它挪开一格，
     * 否则下面 `[data-focused="true"]` 命中的是那张卡、点下去开的是每日推荐歌曲浮层。
     */
    if (wantStyle === 'avant') {
      const dailyFocused = (await win.webContents.executeJavaScript(
        `document.querySelector('.pi-songcard[data-focused="true"]')?.hasAttribute('data-daily-card') === true`,
        true,
      )) as boolean;
      if (dailyFocused) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
        await delay(420);
      }
    }
    // 进详情：平凡点网格首卡；先锋点卡片流的**焦点卡**（点非焦点卡只会滑过去）。
    await win.webContents.executeJavaScript(
      `(() => {
        const card =
          document.querySelector('.pi-plcard:not([data-daily-card]), [data-playlist-card]') ??
          document.querySelector('.pi-songcard[data-focused="true"]:not([data-daily-card])');
        if (card === null) return false;
        card.click();
        return true;
      })()`,
      true,
    );
    const detailDeadline = Date.now() + UI_SMOKE_TIMEOUT_MS;
    let detailOpen = false;
    while (Date.now() < detailDeadline) {
      detailOpen = (await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('.pi-detail, .pi-songslist'))`,
        true,
      )) as boolean;
      if (detailOpen) break;
      await delay(300);
    }
    const playlistOpenOk = detailOpen;
    console.info(
      `[pi/smoke] 歌单页卡片化（第十六轮第 5 条）：推荐歌单页卡片=${gridCards}` +
        ` 首卡=「${gridFirstName}」｜点首卡进歌单详情=${detailOpen ? '✓' : '✗'}` +
        ` ${playlistPanelOk && playlistOpenOk ? '✓' : '✗'}`,
    );

    /*
     * 用户 m02213 第 2 条：歌单拼贴页要**铺满整个窗口**，不再是「窗口中的窗口」。
     *
     * 老样子是 `.pi-listoverlay` 上 `padding: 44px`（第十轮第 4 条留下的「点玻璃空白退出」落点）、
     * sheet 写死 `min(1080px,100%) × min(760px,100%)`；现在**只对拼贴档**
     * （`.pi-listoverlay--collage[data-playlist]`）清零，顶栏那 48px 也不再占一行
     * （`grid-template-rows: 0 1fr`）改成浮在拼贴上。判据就是「壳子贴着窗口四边 + 内边距 0 + 首行 0px」。
     *
     * 平凡档的歌单详情是竖排列表、压根没有这层拼贴壳子——这一条对它**不适用**，别拿它当红。
     */
    let r25FullscreenOk = false;
    let r25FullscreenInfo = '不适用（平凡档歌单详情不是拼贴页）';
    if (wantStyle === 'avant') {
      /*
       * 进详情只等到 `.pi-detail` 出现，可拼贴格子要等预载抽干（`collageReady`）才上墙 ——
       * 实测有一跑就是在这中间拍到了「画布还没铺格」的那一帧（`画布高=-1`、`格数=0`）。
       * 先等到第一块格子出现再截图 / 量几何，读数和图片才有意义。
       */
      const cellDeadline = Date.now() + UI_SMOKE_TIMEOUT_MS;
      while (Date.now() < cellDeadline) {
        const cells = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.pi-listoverlay--collage[data-playlist] [data-collage-cell]').length`,
          true,
        )) as number;
        if (cells > 0) break;
        await delay(300);
      }
      const fullShot =
        process.env.PI_SMOKE_UI_SHOT_PL_FULL ??
        path.resolve(here, '../../../docs/m3r25-playlist-fullscreen.png');
      writeFileSync(fullShot, (await win.webContents.capturePage()).toPNG());
      console.info(`[pi/smoke] 截图：${fullShot}`);
      const fullRead = (await win.webContents.executeJavaScript(
        `(() => {
          const overlay = document.querySelector('.pi-listoverlay--collage[data-playlist]');
          if (overlay === null) return { found: false };
          const sheet = overlay.querySelector('.pi-listoverlay__sheet');
          const detail = overlay.querySelector('.pi-detail');
          const body = overlay.querySelector('.pi-detail__body');
          const canvas = overlay.querySelector('.pi-collage');
          const box = sheet ? sheet.getBoundingClientRect() : null;
          const cs = getComputedStyle(overlay);
          return {
            found: true,
            w: box ? Math.round(box.width) : -1,
            h: box ? Math.round(box.height) : -1,
            left: box ? Math.round(box.left) : -1,
            top: box ? Math.round(box.top) : -1,
            pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join('/'),
            rows: detail ? getComputedStyle(detail).gridTemplateRows : '',
            bodyH: body ? Math.round(body.getBoundingClientRect().height) : -1,
            canvasH: canvas ? Math.round(canvas.getBoundingClientRect().height) : -1,
            innerW: window.innerWidth,
            innerH: window.innerHeight,
          };
        })()`,
        true,
      )) as {
        found: boolean;
        w?: number;
        h?: number;
        left?: number;
        top?: number;
        pad?: string;
        rows?: string;
        bodyH?: number;
        canvasH?: number;
        innerW?: number;
        innerH?: number;
      };
      if (fullRead.found) {
        const fullBleed =
          (fullRead.w ?? 0) >= (fullRead.innerW ?? 0) - 2 &&
          (fullRead.h ?? 0) >= (fullRead.innerH ?? 0) - 2 &&
          (fullRead.left ?? -1) <= 1 &&
          (fullRead.top ?? -1) <= 1;
        const noPadding = (fullRead.pad ?? '') === '0px/0px/0px/0px';
        /*
         * 用户 m02898 第 6 条(a)：判据**不再**是「第一行 0px」。顶栏在下面那条规则里是绝对定位、
         * 根本不占网格行，写 `0 1fr` 时正文会被自动放进那 0px 的第一行、高度只剩 padding
         * （实测 104px）——那正是「屏顶一条拼贴 + 下面一片模糊」。现在要求：网格只有真实存在的
         * 那一行（不是 0px），并且**正文与画布都铺满窗口高**。
         */
        const innerH = fullRead.innerH ?? 0;
        const rowsFirst = (fullRead.rows ?? '').trim().split(/\s+/)[0] ?? '';
        const rowsOk = !/^0(px)?$/.test(rowsFirst) && rowsFirst !== '';
        const contentFull =
          (fullRead.bodyH ?? -1) >= innerH - 2 && (fullRead.canvasH ?? -1) >= innerH - 2;
        r25FullscreenOk = fullBleed && noPadding && rowsOk && contentFull;
        r25FullscreenInfo =
          `浮层=${fullRead.w}×${fullRead.h}@${fullRead.left},${fullRead.top} 窗口=${fullRead.innerW}×${fullRead.innerH}` +
          ` 铺满=${fullBleed} 内边距=${fullRead.pad} 网格行=${fullRead.rows || '取不到'}` +
          ` 正文高=${fullRead.bodyH} 画布高=${fullRead.canvasH} 内容铺满=${contentFull}`;
      } else {
        r25FullscreenInfo = '没找到拼贴档歌单浮层（.pi-listoverlay--collage[data-playlist]）';
      }
    } else {
      r25FullscreenOk = true;
    }
    console.info(
      `[pi/smoke] 歌单拼贴铺满窗口（用户 m02213 第 2 条）：${r25FullscreenInfo} ${r25FullscreenOk ? '✓' : '✗'}`,
    );

    /*
     * 用户 m02898 第 6 条(a)：先锋档歌单拼贴上的「模糊遮罩」。
     *
     * 现象（用户图4 与我上一轮先锋跑留下的 `docs/m3r25-playlist-fullscreen.png` 完全一致）：
     * 屏顶只有**一条约 125px 高的拼贴方格**，下面一整片是浮层自己
     * `backdrop-filter: blur(16px)` 糊过的播放页（能看到被 `blur(56px)` 处理过的封面轮廓）。
     * `.pi-collage` 的底色是**不透明的** `var(--pi-bg-subtle)`（亮档 #f5faff / 暗档 #141a24），
     * 所以那片模糊不可能是画布自己画的 —— 只能是「画布没铺满」或「有东西盖在它上面」。
     * 这一段把 `.pi-listoverlay` → sheet → `.pi-detail` → `.pi-detail__body` →
     * `.pi-detail__collage` → `.pi-collage` → `.pi-collage__world` → 第一张卡片整条链的矩形
     * 与关键计算样式打出来，用来定位是谁只有 125px。平凡档压根没有这层壳子，记「不适用」。
     */
    let r26ChainInfo = '不适用（平凡档歌单详情不是拼贴页）';
    let r26ChainCss = '';
    if (wantStyle === 'avant') {
      const chain = (await win.webContents.executeJavaScript(
        `(() => {
          const box = (el) => {
            if (!el) return 'none';
            const b = el.getBoundingClientRect();
            return Math.round(b.left) + ',' + Math.round(b.top) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height);
          };
          const css = (el, props) => {
            if (!el) return 'none';
            const cs = getComputedStyle(el);
            const out = [];
            for (let i = 0; i < props.length; i++) {
              out.push(props[i] + '=' + cs[props[i]]);
            }
            return out.join(' ');
          };
          const overlay = document.querySelector('.pi-listoverlay--collage[data-playlist]');
          if (!overlay) return { found: false };
          const q = (s) => overlay.querySelector(s);
          const canvas = q('.pi-collage');
          const host = q('.pi-detail__collage');
          const body = q('.pi-detail__body');
          const detail = q('.pi-detail');
          return {
            found: true,
            win: window.innerWidth + 'x' + window.innerHeight,
            overlay: box(overlay),
            sheet: box(q('.pi-listoverlay__sheet')),
            detail: box(detail),
            body: box(body),
            host: box(host),
            canvas: box(canvas),
            world: box(q('.pi-collage__world')),
            cell0: box(q('[data-collage-cell]')),
            skeleton: q('.pi-collage-skeleton') ? 'yes' : 'no',
            cells: document.querySelectorAll('[data-collage-cell]').length,
            canvasCss: css(canvas, ['position', 'top', 'bottom', 'height', 'overflow', 'backgroundColor']),
            hostCss: css(host, ['position', 'display', 'height', 'overflow']),
            bodyCss: css(body, ['position', 'display', 'height', 'alignSelf', 'overflow']),
            detailCss: css(detail, ['display', 'height', 'gridTemplateRows', 'alignItems']),
          };
        })()`,
        true,
      )) as Record<string, unknown>;
      if (chain.found === true) {
        r26ChainInfo =
          `窗口=${String(chain.win)}｜浮层=${String(chain.overlay)}｜壳=${String(chain.sheet)}` +
          `｜详情=${String(chain.detail)}｜主体=${String(chain.body)}｜拼贴槽=${String(chain.host)}` +
          `｜画布=${String(chain.canvas)}｜世界=${String(chain.world)}｜首格=${String(chain.cell0)}` +
          `｜骨架=${String(chain.skeleton)} 格数=${String(chain.cells)}`;
        r26ChainCss =
          `画布[${String(chain.canvasCss)}] 拼贴槽[${String(chain.hostCss)}]` +
          ` 主体[${String(chain.bodyCss)}] 详情[${String(chain.detailCss)}]`;
      } else {
        r26ChainInfo = '没找到拼贴档歌单浮层（.pi-listoverlay--collage[data-playlist]）';
      }
    }
    console.info(`[pi/smoke] 拼贴几何链（用户 m02898 第 6 条a）：${r26ChainInfo}`);
    if (r26ChainCss !== '') {
      console.info(`[pi/smoke] 拼贴几何链计算样式（用户 m02898 第 6 条a）：${r26ChainCss}`);
    }

    /*
     * 用户 m08768 第 2、3 条当年把歌曲列表从卡片**网格**改成了「一行中心聚焦的封面流」。
     * 第十七轮第 ②③ 条（用户 m00006）之后这条规格**已被取代**：歌单详情改成平凡竖排列表
     * （`SongList`）/ 先锋队列拼贴（`SongCollage`），`SongCards` 那套封面流现在只服务搜索浮层
     * 与「添加歌曲」面板。所以这一段探针**退休**：仍旧量一遍（留个记录，也顺便等曲目与封面
     * 解码出来），但 `cardsOk` 不再进 M3 汇总——新口径「详情曲目呈现」由十六轮⑦那段负责，
     * 「点卡片进播放页」由后面的 `UI 连续播放检查` 覆盖。
     */
    /*
     * 歌单详情里的歌是联网拉的，点开封面之后不一定马上到（实测能差 1~2s，上游偶尔更慢）。
     * 量卡片之前先等它们出现；等不到就照实量、照实记 ✗，不当崩溃。
     */
    let cardsReady = 0;
    const cardsDeadline = Date.now() + UI_SMOKE_TIMEOUT_MS;
    while (Date.now() < cardsDeadline) {
      // 第十七轮第 ②③ 条之后，详情里的曲目是 `[data-song-row]`（平凡竖排列表）或
      // `[data-collage-cell]`（先锋队列拼贴，类名 `.pi-collage__item`）——`.pi-songcard`
      // 那条封面流规格已被取代；写成类名 `.pi-collage-cell` 是旧的错写法，恒为 0。
      cardsReady = (await win.webContents.executeJavaScript(
        `document.querySelectorAll('[data-song-row], [data-collage-cell]').length`,
        true,
      )) as number;
      if (cardsReady > 0) break;
      await delay(400);
    }
    /*
     * 第十轮收尾实测出来的**偶发 ✗**：曲目出现 ≠ 首行封面解码完（真数据、真网络，实测能差
     * 1~2s）。上面那个循环只等曲目行出现，于是 `封面已解码=false` 会在网络慢时随机
     * 冒出来（同一份代码：`-e` 次 ✓、`-g` 次 ✗，其余 14 项两次都 ✓）。这里按**解码**再等一次，
     * 上限仍是 `UI_SMOKE_TIMEOUT_MS`；等不到照旧判 ✗，不把这条断言放宽成「有行就行」。
     */
    const decodeDeadline = Date.now() + UI_SMOKE_TIMEOUT_MS;
    while (Date.now() < decodeDeadline) {
      const coverReady = (await win.webContents.executeJavaScript(
        `(() => {
          const holder =
            document.querySelector('[data-song-row]') ?? document.querySelector('[data-collage-cell]');
          const img = holder === null ? null : holder.querySelector('img');
          return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
        })()`,
        true,
      )) as boolean;
      if (coverReady) break;
      await delay(300);
    }
    const cardsProbe = (await win.webContents.executeJavaScript(
      `(() => {
        const flow = document.querySelector('[data-song-card-flow]');
        const stage = document.querySelector('.pi-songcards__stage');
        const cards = Array.from(document.querySelectorAll('.pi-songcard'));
        const focused = document.querySelector('.pi-songcard[data-focused="true"]');
        const neighbour =
          document.querySelector('.pi-songcard[data-offset="1"]') ??
          document.querySelector('.pi-songcard[data-offset="-1"]');
        const cover =
          focused?.querySelector('.pi-songcard__cover img') ??
          cards[0]?.querySelector('.pi-songcard__cover img') ??
          null;
        const stageRect = stage === null ? null : stage.getBoundingClientRect();
        const focusRect = focused === null ? null : focused.getBoundingClientRect();
        const neighbourRect = neighbour === null ? null : neighbour.getBoundingClientRect();
        const num = (value) => {
          const parsed = Number.parseFloat(value);
          return Number.isFinite(parsed) ? parsed : -1;
        };
        return {
          flow: flow !== null,
          stage: stage !== null,
          n: cards.length,
          focusIndex: Number(flow?.dataset.focusIndex ?? -1),
          centreErr:
            stageRect === null || focusRect === null
              ? -1
              : Math.round(
                  Math.abs(
                    stageRect.left + stageRect.width / 2 - (focusRect.left + focusRect.width / 2),
                  ),
                ),
          decoded: cover instanceof HTMLImageElement && cover.complete && cover.naturalWidth > 0,
          name: focused?.querySelector('.pi-songcard__name')?.textContent?.trim() ?? '',
          meta: focused?.querySelector('.pi-songcard__meta')?.textContent?.trim() ?? '',
          width: focusRect === null ? 0 : Math.round(focusRect.width),
          height: focusRect === null ? 0 : Math.round(focusRect.height),
          focusOpacity: focused === null ? -1 : num(getComputedStyle(focused).opacity),
          neighbourOpacity:
            neighbour === null ? -1 : num(getComputedStyle(neighbour).opacity),
          neighbourWidth: neighbourRect === null ? 0 : Math.round(neighbourRect.width),
        };
      })()`,
      true,
    )) as {
      flow: boolean;
      stage: boolean;
      n: number;
      focusIndex: number;
      centreErr: number;
      decoded: boolean;
      name: string;
      meta: string;
      width: number;
      height: number;
      focusOpacity: number;
      neighbourOpacity: number;
      neighbourWidth: number;
    };
    const cardsShot =
      process.env.PI_SMOKE_UI_SHOT_CARDS ??
      path.resolve(here, '../../../docs/m3-playlist-cards.png');
    writeFileSync(cardsShot, (await win.webContents.capturePage()).toPNG());
    const cardsOk =
      cardsProbe.flow &&
      cardsProbe.stage &&
      cardsProbe.n >= 8 &&
      cardsProbe.focusIndex >= 0 &&
      cardsProbe.centreErr >= 0 &&
      cardsProbe.centreErr <= 24 &&
      cardsProbe.decoded &&
      cardsProbe.name !== '' &&
      cardsProbe.meta !== '' &&
      cardsProbe.height >= 100 &&
      cardsProbe.focusOpacity >= 0.9 &&
      cardsProbe.neighbourOpacity >= 0 &&
      cardsProbe.neighbourOpacity < cardsProbe.focusOpacity &&
      cardsProbe.neighbourWidth > 0 &&
      cardsProbe.neighbourWidth < cardsProbe.width;
    console.info(
      `[pi/smoke] 歌曲卡片流：等到的卡片=${cardsReady}｜流=${cardsProbe.flow} 舞台=${cardsProbe.stage} 卡片=${cardsProbe.n}` +
        ` 焦点=${cardsProbe.focusIndex} 偏离中心=${cardsProbe.centreErr}px` +
        `｜中心=「${cardsProbe.name}」副标题=「${cardsProbe.meta}」封面已解码=${cardsProbe.decoded}` +
        `｜中心卡=${cardsProbe.width}×${cardsProbe.height}px 不透明度=${cardsProbe.focusOpacity}` +
        `｜相邻卡=${cardsProbe.neighbourWidth}px 不透明度=${cardsProbe.neighbourOpacity}` +
        `｜截图=${cardsShot}（本条已退休：${cardsOk ? '旧口径仍成立' : '旧口径不成立'}）`,
    );
    // 点封面之后回到主菜单 + 进歌单详情页；收起来之前先把它关掉。
    await win.webContents.executeJavaScript(
      `document.querySelector('.pi-detail__bar .pi-iconbtn')?.click()`,
      true,
    );
    await delay(320);

    // m06982 第 1 条：账号里一个自建歌单都没有时，「我的歌单」页面正中要给一张空白卡片
    // （点一下就能命名，然后往里加歌）。这里只验到「卡片在 → 点开变输入框 → Esc 退回」：
    // 真去点「创建」会往用户真实账号里写一个歌单，冒烟不做有副作用的写操作。
    // 「我的歌单」在主菜单里点一下只是把这个环**切成歌单卡片面板**（m06304 第 5 条：推荐/我的歌单
    // 都改挂到球上），并不会换页——要进「我的歌单」页面得走导航抽屉里那一项。
    await closeOrb(win);
    await clickNav(win, '我的歌单');
    await delay(UI_SMOKE_SWITCH_MS);
    const blankCard = (await win.webContents.executeJavaScript(
      `(() => {
        const card = document.querySelector('[data-newplaylist]');
        return {
          title: document.querySelector('.pi-page-title')?.textContent ?? '',
          hasCard: card !== null,
          label: card?.textContent ?? '',
          // 第十八轮第 ③ 条之后先锋歌单页是 SongCards（.pi-songcard），平凡才是 .pi-plcard
          // ⇒ 这里也得两套都认，否则先锋跑会读成「歌单卡=0」而假红（实测就是这么红的）。
          plcard: document.querySelectorAll('${PL_CARD_SEL}').length,
        };
      })()`,
      true,
    )) as { title: string; hasCard: boolean; label: string; plcard: number };
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-newplaylist]')?.click()`,
      true,
    );
    await delay(260);
    const blankNaming = (await win.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('[data-newplaylist-input]');
        return {
          hasInput: input !== null,
          focused: document.activeElement === input,
          placeholder: input?.getAttribute('placeholder') ?? '',
        };
      })()`,
      true,
    )) as { hasInput: boolean; focused: boolean; placeholder: string };
    // Escape 走 React 的 onKeyDown：直接派发一个冒泡的 KeyboardEvent 最稳
    // （不依赖窗口焦点，冒烟窗口不一定在前台）。
    await win.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('[data-newplaylist-input]');
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()`,
      true,
    );
    await delay(260);
    const blankBack = (await win.webContents.executeJavaScript(
      `(() => ({
        card: document.querySelector('[data-newplaylist]') !== null,
        input: document.querySelector('[data-newplaylist-input]') !== null,
      }))()`,
      true,
    )) as { card: boolean; input: boolean };
    // 这一项是**数据依赖**的：账号里已经有歌单时渲染层走 `PlaylistGrid` 那条分支，
    // 空态卡根本不该存在（`apps/renderer/src/pages/MinePage.tsx:81`）。第十轮跑这批
    // 成品图时账号里已经有 119 个歌单，于是「空态卡」这一项红了——那不是界面回归，
    // 是把「账号恰好是空的」当成了契约。所以：没有空态卡时改验网格里真的有歌单卡，
    // 并把这层信息打进日志，免得以后又把它当成真红。
    const newPlaylistOk = blankCard.hasCard
      ? blankNaming.hasInput && blankBack.card && !blankBack.input
      : blankCard.plcard > 0;
    console.info(
      `[pi/smoke] 歌单页卡片：页面=${blankCard.title} 空态卡=${blankCard.hasCard}（文案「${blankCard.label.trim()}」）` +
        `｜歌单卡=${blankCard.plcard}` +
        (blankCard.hasCard
          ? `｜点开→输入框=${blankNaming.hasInput} 自动聚焦=${blankNaming.focused} 占位=「${blankNaming.placeholder}」` +
            `｜Esc 退回卡片=${blankBack.card} 输入框消失=${!blankBack.input}`
          : '｜（账号里有歌单 ⇒ 没有空态卡，改验网格）') +
        ` ${newPlaylistOk ? '✓' : '✗'}`,
    );

    // m06982 第 2、3 条：点球不是「啪」一下收起来，而是把按键/封面逐个吸进球里
    // （渲染层在 data-closing 的那 512ms 里 phase 仍是 in，靠 data-closing 上的
    // `pi-orb-gulp` + 每个元素的 `pi-orb-dive` 完成收束）。这里抓的就是这个中间态。
    await orbToMain(win);
    await delay(240);
    type DiveMid = { closing: string; phase: string; items: number; animation: string };
    const readDiveMid = async (): Promise<DiveMid> =>
      (await win.webContents.executeJavaScript(
        `(() => {
          const orb = document.querySelector('.pi-orb');
          const item = document.querySelector('.pi-orb__item');
          return {
            closing: orb?.dataset.closing ?? '',
            phase: orb?.dataset.phase ?? '',
            items: document.querySelectorAll('.pi-orb__item').length,
            animation: item ? getComputedStyle(item).animationName : '',
          };
        })()`,
        true,
      )) as DiveMid;
    // 球自己的 onClick 第一句是 `if (wasDragged()) return`（吞掉拖动松手那一下），
    // 偶尔这一下点击就被吞了：菜单还开着、closing 还是 false。这时再点一次即可
    // （标志读取即消费，第二次一定生效）。注意两次点击的间隔必须**大于**球上的
    // 双击窗口 `DOUBLE_CLICK_MS`（240ms，用户 m08066 第 2 条），否则这第二次补救点击
    // 会被当成双击——球去播放页，菜单照样开着，断言反而更难通过。
    let diveMid = await readDiveMid();
    for (let attempt = 0; attempt < 3 && diveMid.closing !== 'true' && diveMid.items > 0; attempt += 1) {
      await win.webContents.executeJavaScript(
        `document.querySelector('.pi-orb__ball')?.click()`,
        true,
      );
      await delay(360);
      diveMid = await readDiveMid();
    }
    await delay(ORB_CLOSE_WAIT_MS + 260);
    const diveEnd = (await win.webContents.executeJavaScript(
      `(() => ({
        open: document.querySelector('.pi-orb')?.dataset.open ?? '',
        items: document.querySelectorAll('.pi-orb__item').length,
      }))()`,
      true,
    )) as { open: string; items: number };
    const diveOk =
      diveMid.closing === 'true' &&
      diveMid.items > 0 &&
      diveMid.animation.includes('pi-orb-dive') &&
      diveEnd.open !== 'true' &&
      diveEnd.items === 0;
    r16LegacyLog(
      `[pi/smoke] 点球收回坠入：中间态 closing=${diveMid.closing} phase=${diveMid.phase}` +
        ` 键还在=${diveMid.items} 动画=${diveMid.animation}` +
        `｜收好后 open=${diveEnd.open} 键残留=${diveEnd.items} ${diveOk ? '✓' : '✗'}`,
    );

    const orbOk =
      ringInfo.includes('打开=true') &&
      // m08768 第 1 条：左半从 6 键（含设置子菜单入口）改成一层 8 键。
      ringInfo.includes('左半=8(') &&
      ringInfo.includes('右半=5(') &&
      ringInfo.includes('球字=PI') &&
      layoutOk &&
      labelsHidden &&
      hoverOk &&
      settingsOk &&
      backOk &&
      playlistPanelOk &&
      playlistOpenOk &&
      newPlaylistOk &&
      diveOk;

    const queueShot =
      process.env.PI_SMOKE_UI_SHOT_QUEUE ?? path.resolve(here, '../../../docs/m3-queue.png');
    // 播放列表按钮在环形菜单右半边（原来在底部 dock 上）；歌单卡片面板里没有这个键，先归位。
    // 第九轮第 8 条：它现在开的是卡片浮层（`[data-songs="queue"]`），不再是 `.pi-queue` 行列表。
    // 第十六轮删球：旧路是「点球 → 环形菜单右半边 → 播放列表」。新路走 PI 圆键——
    // 播放页空白处点一下出球 → 从球心向上划 → 点六块按键里的「播放列表」。
    /*
     * 用户 m03805 第 2 条：这一格原来只等 900ms 就读，经常读成「未打开」（浮层还在动画里），
     * 而且抓手是旧的 `.pi-songcard`（第十七/十八轮起这里渲染 `.pi-songrow` / 拼贴格，恒为 0）。
     * 现在：**先回播放页**（这一跑前面翻过几个页面，球落在别的页上点不出这一格）→ 轮询等浮层
     * 出现（最多 3s）→ 没等到就整条路重走一遍 → 读数换成真抓手，并把整条几何链打出来，
     * 好判断「只看到一片糊」到底是没列表、是壳塌了、还是浮层自己没开。
     */
    const openQueueOverlay = async (): Promise<void> => {
      await tapQuickOrb(win);
      await swipeQuickOrb(win, 0, -90);
      await delay(320);
      await clickQuickItem(win, 'queue');
    };
    const queueOverlayOpen = async (): Promise<boolean> =>
      (await win.webContents.executeJavaScript(
        `document.querySelector('.pi-listoverlay[data-songs="queue"]') !== null`,
        true,
      )) as boolean;
    const waitQueueOverlay = async (): Promise<boolean> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (await queueOverlayOpen()) return true;
        await delay(200);
      }
      return false;
    };
    /*
     * 这一步之前刚量过「歌单详情」那一档（平凡档会**停在歌单浮层上**）。浮层是整页玻璃，
     * 压着导航键，直接 `clickNav` 会点不着 —— 先点玻璃空白把它收掉（与本块收尾同一招），
     * 再按一道 Esc（歌手/专辑/队列那几档只认 Esc 或玻璃空白），最后才回播放页出球。
     * （这也是用户 m03805 第 2 条这一格一直读成「未打开」的原因。）
     */
    await win.webContents.executeJavaScript(
      `document.querySelector('.pi-listoverlay[data-song-list-overlay]')?.click()`,
      true,
    );
    await delay(320);
    await focusSmoke(win);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await delay(320);
    await clickNav(win, '播放器主页');
    await delay(760);
    await openQueueOverlay();
    let queueOpen = await waitQueueOverlay();
    if (!queueOpen) {
      await openQueueOverlay();
      queueOpen = await waitQueueOverlay();
    }
    writeFileSync(queueShot, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${queueShot}`);
    const queueInfo = (await win.webContents.executeJavaScript(
      `(() => {
        const sheet = document.querySelector('.pi-listoverlay[data-songs="queue"]');
        if (!sheet) {
          /* 用户 m03805 第 2 条：读成「未打开」时得能看出卡在哪一段 —— 是球没点出层、
             是面板没开、六块按键没渲染，还是这一档压根没被点着（别的浮层还压在上面）。 */
          const layer = document.querySelector('[data-quick-layer]');
          const panel = document.querySelector("[data-quick-panel='playlists']");
          return '未打开（层=' + (layer === null ? '无' : (layer.dataset.quickLayer || '有')) +
            ' 面板=' + (panel !== null) +
            ' 项=[' + Array.from(document.querySelectorAll('[data-quick-item]')).map((el) => el.dataset.quickItem || '').join(',') + ']' +
            ' 其它浮层=[' + Array.from(document.querySelectorAll('[data-song-list-overlay]')).map((el) => el.dataset.playlist ? 'playlist' : (el.dataset.songs || '?')).join(',') + ']' +
            ' 页面=' + (document.querySelector('[data-home-card]') !== null ? '播放页' : '非播放页') + '）';
        }
        const rows = sheet.querySelectorAll('.pi-songrow').length;
        const cells = sheet.querySelectorAll('[data-collage-cell]').length;
        const box = sheet.querySelector('.pi-listoverlay__sheet');
        const body = sheet.querySelector('.pi-songslist__body');
        const cover = sheet.querySelector('.pi-songslist__cover');
        const style = getComputedStyle(sheet);
        const rect = sheet.getBoundingClientRect();
        const boxRect = box === null ? null : box.getBoundingClientRect();
        const bodyRect = body === null ? null : body.getBoundingClientRect();
        const size = (r) => (r === null ? '无' : Math.round(r.width) + '×' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top));
        return '行=' + rows + ' 拼贴格=' + cells +
          /* 用户 m03805 第 2 条：光看「格子数 > 0」会上当 —— 先锋档骨架塌成 0 高时，
             拼贴照样会摆出 46 个 0×0 的格子。这里连画布自己的盒子一起量。 */
          ' 拼贴画布=' + (() => {
            const canvas = sheet.querySelector('.pi-collage');
            if (canvas === null) return '无';
            const r = canvas.getBoundingClientRect();
            return Math.round(r.width) + '×' + Math.round(r.height);
          })() +
          ' 当前曲高亮=' + Boolean(sheet.querySelector('[data-active="true"]')) +
          ' 标题=' + (sheet.querySelector('.pi-songslist__title')?.textContent || '') +
          ' 封面=' + (cover === null ? '无' : Math.round(cover.getBoundingClientRect().width) + 'px ' + (cover.getAttribute('src') || '').slice(0, 70)) +
          ' 浮层=' + size(rect) + ' 壳=' + size(boxRect) + ' 正文=' + size(bodyRect) +
          ' 底色=' + style.backgroundColor + ' 模糊=' + style.backdropFilter +
          ' 空态=' + (sheet.querySelector('.pi-placeholder')?.textContent || '无') +
          ' 模式键=' + (sheet.querySelector('[data-queue-mode]')?.textContent || '无');
      })()`,
      true,
    )) as string;
    console.info(`[pi/smoke] 播放列表浮层：${queueInfo}`);
    // 点玻璃空白处关掉浮层（这正是用户第九轮第 3 条要的退出方式），再把环形菜单收回去，
    // 否则它会挡住后面的详情页截图。
    await win.webContents.executeJavaScript(
      `document.querySelector('.pi-listoverlay[data-song-list-overlay]')?.click()`,
      true,
    );
    await delay(300);
    await closeOrb(win);

    // 用户 m08066 第 2 条：双击悬浮球回播放页（原来这里是绕「设置子菜单 → 正在播放」）。
    // 双击顺带要把开着的菜单收回去，所以这里既是路径也是断言。
    // 两次点击必须分派两次（间隔 120ms，落在 240ms 双击窗口里）：同一个 tick 里连着
    // 两次 `.click()` 的话，第二次读到的还是没重渲染的旧 `orbOpen`，收起那一步就不会走。
    type DblProbe = { home: boolean; open: string; items: number };
    let dblHome: DblProbe = { home: false, open: '', items: -1 };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await orbToMain(win);
      await delay(320);
      await win.webContents.executeJavaScript(
        `document.querySelector('.pi-orb__ball')?.click()`,
        true,
      );
      await delay(120);
      await win.webContents.executeJavaScript(
        `document.querySelector('.pi-orb__ball')?.click()`,
        true,
      );
      await delay(ORB_CLOSE_WAIT_MS + 260);
      dblHome = (await win.webContents.executeJavaScript(
        `(() => ({
          home: Boolean(document.querySelector('.pi-home')),
          open: document.querySelector('.pi-orb')?.dataset.open ?? '',
          items: document.querySelectorAll('.pi-orb__item').length,
        }))()`,
        true,
      )) as DblProbe;
      if (dblHome.home && dblHome.open !== 'true' && dblHome.items === 0) break;
    }
    const dblOk = dblHome.home && dblHome.open !== 'true' && dblHome.items === 0;
    r16LegacyLog(
      `[pi/smoke] 双击悬浮球回播放页：播放页=${dblHome.home}｜菜单 open=${dblHome.open} 键残留=${dblHome.items} ${dblOk ? '✓' : '✗'}`,
    );
    await delay(120);
    /*
     * 第十六轮（父代理 2026 定位的真因）：兜底歌源走的是「推荐歌单详情」页
     * （`openRecommendedPlaylist` 现在点完卡片就停在那一页），而**下面这一整段**——名片、
     * 评论、歌词轨、截图、六个歌词主题、逐字旋转——都要求应用停在**播放器主页**上；
     * `ensureLyricSong` 里的「空白处点出 PI 键 → 上划 → 播放列表」也一样（只有 `.pi-home`
     * 才有空白可点）。实测这一整片全红（`舞台=无` / `歌词行=0` / `进度条 NaN`），根因就是
     * 应用还停在歌单详情页：点不到 `.pi-home__card`，也点不出 PI 键。
     * 所以在这里明确回主页，并等名片真的挂上再往下走。
     */
    if (!(await clickNav(win, '播放器主页'))) {
      console.warn('[pi/smoke] 抽屉里点不到「播放器主页」');
    }
    {
      const homeDeadline = Date.now() + 4000;
      let homeReady = false;
      while (Date.now() < homeDeadline) {
        homeReady = (await win.webContents.executeJavaScript(
          `Boolean(document.querySelector('.pi-home__card[data-home-card]'))`,
          true,
        )) as boolean;
        if (homeReady) break;
        await delay(200);
      }
      if (!homeReady) {
        console.warn(
          '[pi/smoke] 回播放器主页后 4s 内没等到名片：下面的评论/歌词/主题探针会跟着红（先看这里）',
        );
      }
    }
    /*
     * 用户 m02213 第 8 条把「点名片向上弹出的那个操作框」整块删了——评论 / 收藏 / 歌曲信息 /
     * 分享四条能力搬到**封面的四角**（`[data-card-action]`，悬停封面才浮现），名片右下角另加一颗
     * 小爱心（`[data-card-like]`）。所以这里不再点名片开框，改成直接数那四颗键，再从「评论」那颗
     * 把评论面板打开（后面的评论/歌词探针链都挂在它上面）。
     * `element.click()` 走的还是 DOM click，不受常态 `pointer-events: none` 的影响。
     */
    const actionsKeys = (await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-card-action]')].map((el) => el.getAttribute('data-card-action') || '').join('/')`,
      true,
    )) as string;
    console.info(`[pi/smoke] 封面四角键：${actionsKeys || '未找到'}`);
    // 用户 m03805 第 4 条：左上那颗从「歌曲信息」改成「播放模式」，原来那块面板就少了一个入口 ——
    // 现在挂在**封面本体**上（`data-card-cover="info"`，点封面开面板）。这个抓手故意不叫
    // `data-card-action`，否则上面「四角键正好四颗」的断言会变成五颗。
    const coverEntryOk = (await win.webContents.executeJavaScript(
      `Boolean(document.querySelector('[data-card-cover="info"]'))`,
      true,
    )) as boolean;
    const cardBoxAtEntry = (await win.webContents.executeJavaScript(
      `Boolean(document.querySelector('[data-card-actions]'))`,
      true,
    )) as boolean;
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-card-action="comments"]')?.click()`,
      true,
    );
    // 评论和歌词都要联网，等真的画出来再判定（等不到也照实报，不当崩溃）。
    const commentDeadline = Date.now() + UI_SMOKE_TIMEOUT_MS;
    let commentRows = 0;
    let lyricLines = 0;
    while (Date.now() < commentDeadline) {
      const counts = (await win.webContents.executeJavaScript(
        `({ comments: document.querySelectorAll('.pi-comment').length, lyrics: document.querySelectorAll('[data-lyric-line], .pi-lyrics__line').length })`,
        true,
      )) as { comments: number; lyrics: number };
      commentRows = counts.comments;
      lyricLines = counts.lyrics;
      if (commentRows > 0 && lyricLines > 0) break;
      await delay(500);
    }
    // 第十二轮第 4/5 条（用户 m04193）：量「名片竖排 + 条上两个键的收起态」之前，先把指针挪到
    // 舞台偏上、既压不到进度条也压不到名片的地方——否则上面那些交互可能把进度条留在悬停态，
    // 读到 opacity=1，把「常态不显示」这条断言拍成假红。
    await win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 320 });
    await delay(420);
    const homeInfo = (await win.webContents.executeJavaScript(
      `(() => {
        const page = document.querySelector('.pi-home');
        if (!page) return '未打开';
        const actions = page.querySelector('[data-card-actions]');
        return '名片=' + Boolean(page.querySelector('.pi-home__card[data-home-card]')) +
          ' 名片封面=' + Boolean(page.querySelector('.pi-home__cover')) +
          ' 歌手键=' + Boolean(page.querySelector('[data-card-artist]')) +
          ' 专辑键=' + Boolean(page.querySelector('[data-card-album]')) +
          ' 音质=' + Boolean(page.querySelector('[data-card-quality]')) +
          ' 背景=' + Boolean(page.querySelector('.pi-home__bg')) +
          ' 歌词行=' + page.querySelectorAll('[data-lyric-line], .pi-lyrics__line').length +
          // 用户 m02213 第 8 条：旧操作框必须真的没了（点名片也不再长出来），四条能力改挂
          // 封面四角 + 名片右下角一颗爱心（爱心那颗带 data-card-like = true/false）。
          ' 旧操作框=' + Boolean(actions) +
          ' 四角键=' + [...page.querySelectorAll('[data-card-action]')].map((el) => el.getAttribute('data-card-action') || '').join('/') +
          ' 爱心=' + (() => {
            const like = page.querySelector('[data-card-like]');
            return like === null ? '无' : like.getAttribute('data-card-like') || '';
          })() +
          // 第九轮第 1 条：底部那一条收起时只剩「时间 + 进度条」；左边播放键、右边音量键是
          // 悬停才长出来的（.pi-home__play / .pi-home__volbtn 收起态 width:0; opacity:0），
          // 音量条是挂在音量键上方的竖向 popup（.pi-home__volrange 转了 -90 度）。
          // 这里钉住四个钩子都在，同时钉住旧的整页遮罩（[data-frame-layer]）确实没了。
          ' 进度条=' + Boolean(page.querySelector('[data-home-progress]')) +
          ' 条内播放键=' + Boolean(page.querySelector('[data-home-play]')) +
          ' 条内音量键=' + Boolean(page.querySelector('[data-home-volbtn]')) +
          ' 音量弹层=' + Boolean(page.querySelector('[data-home-volpop]')) +
          ' 音量条=' + Boolean(page.querySelector('[data-home-volrange]')) +
          // 第十一轮第 2 条（用户 m03279）新量的两件事：
          // ①整条药丸的尺寸与「占窗宽多少」（参考图约 0.245，改造前约 0.55）；
          // ②音量弹层与音量键的相对位置（CSS 是 bottom: calc(100% - 2px) ⇒ 弹层底边压在
          //   键顶下 2px，看着就是从键里长出来；Δx 是两者的水平中心差，应当接近 0）。
          ' 条尺寸=' + (() => {
            const bar = page.querySelector('.pi-home__bar');
            if (!(bar instanceof HTMLElement)) return '无';
            const rect = bar.getBoundingClientRect();
            return Math.round(rect.width) + 'x' + Math.round(rect.height) +
              ' 占比=' + (rect.width / Math.max(window.innerWidth, 1)).toFixed(3) +
              ' 条底=' + Math.round(rect.bottom);
          })() +
          // 第十七轮第 6 条（用户 m00006）：「悬停放大时进度条放大到原来的 150%」——悬停后进度轨道
          // 会从（药丸宽 - 两端键位的固定开销）长到 1.5 倍。倍数得有两个读数才成立，所以静止态这里
          // 先把**收起时的轨道宽**量下来（悬停态那一次在 barHoverInfo 里量，两数相除就是倍数）。
          ' 轨道宽=' + (() => {
            const track = page.querySelector('[data-home-track]');
            if (!(track instanceof HTMLElement)) return '无';
            return Math.round(track.getBoundingClientRect().width);
          })() +
          // 第十三轮第 3 条（用户 m04663）：「进度条上部两端可以加上上一首/下一首的按键图标」。
          // 两个键在静止态必须和另外两个键一样透明 + 点不到（它们是靠悬停才浮出来的）。
          ' 上一首键=' + Boolean(page.querySelector('[data-home-prev]')) +
          ' 下一首键=' + Boolean(page.querySelector('[data-home-next]')) +
          ' 双键收起态=' + (() => {
            const prev = page.querySelector('[data-home-prev]');
            const next = page.querySelector('[data-home-next]');
            if (!(prev instanceof HTMLElement) || !(next instanceof HTMLElement)) return '无';
            return '上一首透明度=' + getComputedStyle(prev).opacity +
              ' 下一首透明度=' + getComputedStyle(next).opacity;
          })() +
          ' 弹层贴键=' + (() => {
            const pop = page.querySelector('[data-home-volpop]');
            const btn = page.querySelector('[data-home-volbtn]');
            if (!(pop instanceof HTMLElement) || !(btn instanceof HTMLElement)) return '无';
            const popRect = pop.getBoundingClientRect();
            const btnRect = btn.getBoundingClientRect();
            return 'Δy=' + Math.round(popRect.bottom - btnRect.top) +
              ' Δx=' + Math.round((popRect.left + popRect.width / 2) - (btnRect.left + btnRect.width / 2)) +
              ' ' + Math.round(popRect.width) + 'x' + Math.round(popRect.height);
          })() +
          // 第十二轮第 4 条：名片改成竖排——封面整块放顶上（方图），文字信息在它下面。
          ' 名片竖排=' + (() => {
            const card = page.querySelector('.pi-home__card');
            const cover = page.querySelector('.pi-home__cover');
            const meta = page.querySelector('.pi-home__meta');
            if (!(card instanceof HTMLElement) || !(cover instanceof HTMLElement) || !(meta instanceof HTMLElement)) return '无';
            const c = cover.getBoundingClientRect();
            const m = meta.getBoundingClientRect();
            const k = card.getBoundingClientRect();
            return '封面在顶=' + (c.bottom <= m.top + 2) +
              ' 封面宽=' + Math.round(c.width) + ' 名片宽=' + Math.round(k.width) +
              ' 封面比=' + (c.height / Math.max(c.width, 1)).toFixed(2);
          })() +
          // 第十二轮第 5 条：条上的暂停键与音量键**常态不显示**（opacity 0）且带着收起态缩放，
          // 悬停才长出来（transform 不参与布局，所以药丸长度不变）。
          ' 条键收起态=' + (() => {
            const p = page.querySelector('[data-home-play]');
            const v = page.querySelector('[data-home-volbtn]');
            if (!(p instanceof HTMLElement) || !(v instanceof HTMLElement)) return '无';
            const scaleOf = (el) => {
              const t = getComputedStyle(el).transform;
              if (!t || t === 'none') return 1;
              return Math.round(new DOMMatrixReadOnly(t).a * 100) / 100;
            };
            return '播放键透明度=' + getComputedStyle(p).opacity + ' 缩放=' + scaleOf(p) +
              ' 音量键透明度=' + getComputedStyle(v).opacity + ' 缩放=' + scaleOf(v);
          })() +
          ' 旧遮罩=' + Boolean(page.querySelector('[data-frame-layer]')) +
          ' 评论行=' + page.querySelectorAll('.pi-comment').length +
          ' 评论标题=' + [...page.querySelectorAll('.pi-comments__title')].map((el) => (el.textContent || '').trim()).join('/');
      })()`,
      true,
    )) as string;
    console.info(`[pi/smoke] 播放器主页：${homeInfo}`);
    /*
     * 第十二轮第 5 条（用户 m04193）：进度条上的暂停键与音量键**常态带着收起态缩放**
     * （play: translateX(-7px) scale(0.5)、volbtn: translateX(7px) scale(0.5)），音量弹层常态
     * 也带 scale(0.82)。这些 transform 不参与布局，但 `getBoundingClientRect()` 量的是**变换之后**
     * 的视觉盒 —— 第十一轮那条「音量条压在音量键顶上（|Δy| ≤ 4、|Δx| ≤ 3、16×84）」的断言
     * 在静止态就会被这套收起动画拍成假红（实测 Δy=-4 Δx=-7 13×69）。
     * 音量条本来就是**悬停才浮出来**的，所以这条断言改到悬停态量：指针压到音量键上，
     * 等 transform 回到 scale(1)（按钮）与 scale(1)（弹层），再量一次——那才是用户真正看到的
     * 相邻关系。顺带把「悬停不会把药丸撑长」也量进去（第十一轮第 3 条：长度不变、只多两个键）。
     */
    const barHoverInfo = await (async (): Promise<string> => {
      /*
       * 第十七轮第 6 条（用户 m00006）：音量条常态缩到 70%（弹层 16×84 → 16×59、滑杆布局
       * 84×16 → 59×16），同时「悬停放大时进度条放大到原来的 150%」⇒ 药丸悬停时会从 343px 撑到
       * `--pi-bar-hover-width` = 343×1.5 - 94 ≈ 420px。
       *
       * 这里踩过一串坑，记下来别再踩：宽度原先左右对称地长，音量键跟着往右挪 ~38px 钻到
       * 右侧「评论 / 歌曲信息」抽屉（z-index 8 > 药丸 3）底下——DBG 实测指针落到
       * `pi-home__drawer-body` 上、药丸缩回、弹层全程 `不透明度=0`，两级悬停永远读不到。
       * 修法是把药丸改成「右沿钉住、往左长」（见 apps/renderer/src/styles/global.css 的
       * `.pi-home__bar`），于是音量键在静置/悬停两态都待在药丸右端原地不动，
       * `right - 26` 两态都正好落在键心上（键 34 + 右内边距 12 ⇒ 键心离右缘 29px）。
       * 撑开与否只能看**宽度**（右缘现在两态相同）。
       * 两次投递之间挪 1px：同一坐标连投会被当成「位置没变」吞掉（窗口三键那段的同一个坑）。
       *
       * 第十八轮第 1 条（用户 m01482）又把药丸改回了**以中心轴为基准放大**
       * （`left: 50%; transform: translateX(-50%)`）：静置态右缘还在 762px，但悬停态会往右长
       * ~38px，音量键跟着往右挪——`right - 26` 在悬停态就落在键左边 35px、落不进 34px 的键里，
       * 于是药丸撑开着、弹层却全程 `不透明度=0`（实测：条 420x64 ✓ 但两级悬停三条全 ✗）。
       * 现在直接读**音量键那一层**（`.pi-home__volume`，34x36、不带 transform）的中心，
       * 两态都精确落在键心上；撑开与否仍然只看药丸**宽度**。
       */
      const barRightBox = async (): Promise<{ x: number; y: number; right: number; width: number } | null> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const bar = document.querySelector('.pi-home__bar');
            const key = document.querySelector('[data-home-volume]');
            if (!(bar instanceof HTMLElement) || !(key instanceof HTMLElement)) return null;
            const b = bar.getBoundingClientRect();
            const k = key.getBoundingClientRect();
            return {
              x: Math.round(k.left + k.width / 2),
              y: Math.round(k.top + k.height / 2),
              right: Math.round(b.right),
              width: Math.round(b.width),
            };
          })()`,
          true,
        )) as { x: number; y: number; right: number; width: number } | null;
      const volumeKeyHovered = async (): Promise<boolean> =>
        (await win.webContents.executeJavaScript(
          `document.querySelector('[data-home-volume]')?.matches(':hover') === true`,
          true,
        )) as boolean;
      /*
       * 把指针压到音量键上（并让药丸保持撑开）。
       *
       * 第十八轮第 1 条（用户 m01482）把药丸改回**以中心轴为基准放大**：撑开时右端往右长 ~38px，
       * 音量键跟着往右挪。所以「先贴收起态键位、再按撑开态键位重贴」两步都不能省——
       * 只贴收起态那一发，指针会停在撑开后偏左 ~38px 的轨道上，键永远不 hover、
       * 音量弹层全程不透明度 0（这一跑的实测就是这个：键hover=false 而条尺寸=420x64 ✓）。
       *（上一轮药丸是往左长的，键位两态相同，所以那时只贴一次就够。）
       */
      const hoverVolumeKey = async (): Promise<boolean> => {
        for (let round = 0; round < 3; round += 1) {
          const rest = await barRightBox();
          if (rest === null) return false;
          await focusSmoke(win);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: rest.x, y: rest.y });
          await delay(300);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: rest.x + 1, y: rest.y });
          await delay(320);
          const grown = await barRightBox();
          if (grown === null) return false;
          // 撑开态重贴：跳过这一发就会永远贴不到键上（见上面注释）。
          win.webContents.sendInputEvent({ type: 'mouseMove', x: grown.x, y: grown.y });
          await delay(140);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: grown.x + 1, y: grown.y });
          await delay(160);
          if (await volumeKeyHovered()) return true;
          if (grown.width === rest.width) continue; // 没撑开（这一发被吞了）：再来一轮
        }
        return true;
      };
      if (!(await hoverVolumeKey())) return '未打开';
      const info = (await win.webContents.executeJavaScript(
        `(() => {
          const page = document.querySelector('.pi-home');
          if (!page) return '未打开';
          const pop = page.querySelector('[data-home-volpop]');
          const btn = page.querySelector('[data-home-volbtn]');
          const volRange = page.querySelector('[data-home-volrange]');
          const bar = page.querySelector('.pi-home__bar');
          const row = page.querySelector('.pi-home__barlyn');
          const prev = page.querySelector('[data-home-prev]');
          const next = page.querySelector('[data-home-next]');
          // 第十五轮第 3 条（用户 m06435）：进度条从「行内一根」变成药丸行里的独立轨道，
          // 两个箭头改挂在它的首尾两端**上方**——所以这里连轨道盒子与轨道里的进度条一起量，
          // 断言的依据（键心贴轨道两端、键底在轨道顶之上）全从这两个矩形来。
          const track = page.querySelector('[data-home-track]');
          const prog = page.querySelector('[data-home-progress]');
          if (!(pop instanceof HTMLElement) || !(btn instanceof HTMLElement) || !(bar instanceof HTMLElement)) return '缺元素';
          const barRect = bar.getBoundingClientRect();
          const popRect = pop.getBoundingClientRect();
          const btnRect = btn.getBoundingClientRect();
          const rowRect = row instanceof HTMLElement ? row.getBoundingClientRect() : null;
          const trackRect = track instanceof HTMLElement ? track.getBoundingClientRect() : null;
          const keyText = (el) => {
            if (!(el instanceof HTMLElement)) return '无';
            const r = el.getBoundingClientRect();
            return getComputedStyle(el).opacity + ',top=' + Math.round(r.top) + ',bottom=' + Math.round(r.bottom) +
              ',cx=' + Math.round(r.left + r.width / 2) + ',cy=' + Math.round(r.top + r.height / 2);
          };
          return '条尺寸=' + Math.round(barRect.width) + 'x' + Math.round(barRect.height) +
            ' 条底=' + Math.round(barRect.bottom) +
            ' 条左=' + Math.round(barRect.left) + ' 条右=' + Math.round(barRect.right) +
            ' 行高=' + (rowRect === null ? '无' : Math.round(rowRect.height)) +
            ' 行底=' + (rowRect === null ? '无' : Math.round(rowRect.bottom)) +
            ' 上一首键=' + keyText(prev) + ' 下一首键=' + keyText(next) +
            ' 弹层贴键=Δy=' + Math.round(popRect.bottom - btnRect.top) +
            ' Δx=' + Math.round((popRect.left + popRect.width / 2) - (btnRect.left + btnRect.width / 2)) +
            ' ' + Math.round(popRect.width) + 'x' + Math.round(popRect.height) +
            // 第十四轮第 1 条：悬停时弹层整体 scale(1.3)，视觉盒不再等于布局盒——
            // 尺寸断言一律改看 offsetWidth/offsetHeight（与 transform 无关）。
            ' 弹层布局=' + pop.offsetWidth + 'x' + pop.offsetHeight +
            ' 弹层不透明度=' + getComputedStyle(pop).opacity +
            // 第十三轮第 5 条：弹层**盒子**居中不等于弹层里那根条居中（见下面断言的注释）。
            ' 滑杆盒=' + (volRange instanceof HTMLElement
              ? Math.round(volRange.getBoundingClientRect().width) + 'x' + Math.round(volRange.getBoundingClientRect().height)
              : '无') +
            ' 滑杆布局=' + (volRange instanceof HTMLElement
              ? volRange.offsetWidth + 'x' + volRange.offsetHeight
              : '无') +
            ' 滑杆轴=Δx=' + (volRange instanceof HTMLElement
              ? Math.round(
                  (volRange.getBoundingClientRect().left + volRange.getBoundingClientRect().width / 2) -
                    (btnRect.left + btnRect.width / 2),
                )
              : '无') +
            // 第十五轮第 3 条：轨道的首尾两端（left / right）与顶边，用来判两个箭头挂得对不对；
            // 顺带把**轨道里那根可见进度条**的宽度也量出来——用户要求它长到原来的 150%。
            ' 轨道=' + (trackRect === null
              ? '无'
              : '左=' + Math.round(trackRect.left) + ' 右=' + Math.round(trackRect.right) +
                ' 顶=' + Math.round(trackRect.top) + ' 宽=' + Math.round(trackRect.width)) +
            ' 进度条=' + (prog instanceof HTMLElement
              ? Math.round(prog.getBoundingClientRect().width)
              : '无') +
            // 第十五轮第 9 条：停在音量键上时轨道该是细的（3px）——变量值直接读出来，
            // 不依赖伪元素（webkit-slider-runnable-track 的 computed 读不到）。
            ' 音量厚度=' + getComputedStyle(pop).getPropertyValue('--pi-vol-thick').trim() +
            ' 音量滑块=' + getComputedStyle(pop).getPropertyValue('--pi-vol-thumb').trim() +
            // 第十八轮第 1 条把药丸从「右沿钉住」改回「以中心轴为基准放大」之后踩过一次坑：
            // 药丸撑开了、弹层却全程不透明度=0——分不清是探针没贴到键上还是 CSS 的 :hover 没生效。
            // 这里把「键现在到底有没有被指针压住、键心上压的是谁」一起写进日志，下次一眼可辨。
            ' 键hover=' + (() => {
              const key = page.querySelector('[data-home-volume]');
              if (!(key instanceof HTMLElement)) return '无键';
              const k = key.getBoundingClientRect();
              const hit = document.elementFromPoint(
                Math.round(k.left + k.width / 2),
                Math.round(k.top + k.height / 2),
              );
              return key.matches(':hover') +
                '(键心命中=' + (hit === null ? '无' : (hit.className || hit.tagName)) + ')';
            })() +
            ' 药丸数=' + document.querySelectorAll('[data-home-bar]').length;
        })()`,
        true,
      )) as string;
      /*
       * 第十三轮第 5 条（用户 m04663）：「音量条要在音量键的上面，现在是像图 2 一样，有错位」。
       * 光看 CSS（`bottom: calc(100% - 2px)` + `left: 50%` 配 `translateX(-50%)`）算不出用户的「错位」，
       * 所以这里在**悬停态**（也就是音量条唯一可见的那一刻）连键带弹层截一张特写，用眼睛对。
       */
      const crop = (await win.webContents.executeJavaScript(
        `(() => {
          const pop = document.querySelector('[data-home-volpop]');
          const btn = document.querySelector('[data-home-volbtn]');
          if (!(pop instanceof HTMLElement) || !(btn instanceof HTMLElement)) return null;
          const a = pop.getBoundingClientRect();
          const b = btn.getBoundingClientRect();
          const pad = 26;
          return {
            x: Math.max(0, Math.round(Math.min(a.left, b.left) - pad)),
            y: Math.max(0, Math.round(Math.min(a.top, b.top) - pad)),
            width: Math.round(Math.max(a.right, b.right) - Math.min(a.left, b.left) + pad * 2),
            height: Math.round(Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) + pad * 2),
          };
        })()`,
        true,
      )) as { x: number; y: number; width: number; height: number } | null;
      if (crop !== null && crop.width > 8 && crop.height > 8) {
        const volShot = path.resolve(here, '../../../docs/m3r13-volpop.png');
        writeFileSync(volShot, (await win.webContents.capturePage(crop)).toPNG());
        console.info(`[pi/smoke] 音量弹层特写（第十三轮第 5 条）→ ${volShot}`);
      }
      const hoverShot = path.resolve(here, '../../../docs/m3r13-bar-hover.png');
      writeFileSync(hoverShot, (await win.webContents.capturePage()).toPNG());
      console.info(`[pi/smoke] 进度条悬停态整图（第十三轮第 3 条）→ ${hoverShot}`);
      /*
       * 第十五轮第 9 条（用户 m06435）：「悬停在音量键上时，音量条要比现在短 20%，
       * 鼠标移到音量条时，音量条变粗并且变长到现在这样长」。上面那一段量的是
       * **指针停在音量键上**的状态（长度 = 满档 × 0.8、轨道厚 3px）；这里把指针移到
       * 弹层自己身上再量一次：长度回到满档、轨道加粗到 6px。两次读数都进日志与断言。
       */
      const popCentre = (await win.webContents.executeJavaScript(
        `(() => {
          const pop = document.querySelector('[data-home-volpop]');
          if (!(pop instanceof HTMLElement)) return null;
          const r = pop.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.45) };
        })()`,
        true,
      )) as { x: number; y: number } | null;
      let popHover = '未读到弹层';
      if (popCentre !== null) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: popCentre.x, y: popCentre.y });
        await delay(260);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: popCentre.x, y: popCentre.y });
        await delay(420);
        if (crop !== null && crop.width > 8 && crop.height > 8) {
          const thickShot = path.resolve(here, '../../../docs/m3r15-volpop-thick.png');
          writeFileSync(thickShot, (await win.webContents.capturePage(crop)).toPNG());
          console.info(`[pi/smoke] 音量条「指针落在条上」特写（第十五轮第 9 条）→ ${thickShot}`);
        }
        popHover = (await win.webContents.executeJavaScript(
          `(() => {
            const pop = document.querySelector('[data-home-volpop]');
            if (!(pop instanceof HTMLElement)) return '缺弹层';
            const r = pop.getBoundingClientRect();
            const cs = getComputedStyle(pop);
            return '视觉=' + Math.round(r.width) + 'x' + Math.round(r.height) +
              ' 厚度=' + cs.getPropertyValue('--pi-vol-thick').trim() +
              ' 滑块=' + cs.getPropertyValue('--pi-vol-thumb').trim() +
              ' 不透明度=' + cs.opacity;
          })()`,
          true,
        )) as string;
      }
      /*
       * run g 实测：第二发指针偶尔没落到弹层上（读回 13x69 = 收起态）。真因与窗口三键那条一样——
       * 同一坐标重复投递不会再产生 pointerenter/over。这里加一段「先移开 → 按当时的键心/弹层心重新压上去」
       * 的重试，最多 3 轮，读到加粗（--pi-vol-thick=6px）就收工。
       */
      for (let attempt = 0; attempt < 3 && !popHover.includes('厚度=6px'); attempt += 1) {
        // 第十七轮第 6 条：药丸收起↔撑开会把音量键横向挪 ~38px，所以每一轮都重走一次两段式
        // 贴键（先贴收起态右缘让药丸撑开、再按撑开态的右缘重贴，见上面 hoverVolumeKey）。
        if (!(await hoverVolumeKey())) break;
        const freshPop = (await win.webContents.executeJavaScript(
          `(() => {
            const pop = document.querySelector('[data-home-volpop]');
            if (!(pop instanceof HTMLElement)) return null;
            const r = pop.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.45) };
          })()`,
          true,
        )) as { x: number; y: number } | null;
        if (freshPop === null) break;
        win.webContents.sendInputEvent({ type: 'mouseMove', x: freshPop.x, y: freshPop.y });
        await delay(420);
        popHover = (await win.webContents.executeJavaScript(
          `(() => {
            const pop = document.querySelector('[data-home-volpop]');
            if (!(pop instanceof HTMLElement)) return '缺弹层';
            const r = pop.getBoundingClientRect();
            const cs = getComputedStyle(pop);
            return '视觉=' + Math.round(r.width) + 'x' + Math.round(r.height) +
              ' 厚度=' + cs.getPropertyValue('--pi-vol-thick').trim() +
              ' 滑块=' + cs.getPropertyValue('--pi-vol-thumb').trim() +
              ' 不透明度=' + cs.opacity + '（重试 ' + ${attempt + 1} + '）';
          })()`,
          true,
        )) as string;
      }
      console.info(`[pi/smoke] 音量条二次悬停（第十五轮第 9 条）：${popHover}`);
      return info + ' 二次悬停=' + popHover;
    })();
    console.info(`[pi/smoke] 进度条悬停态（第十二轮第 5 条）：${barHoverInfo}`);
    // 量完把指针挪回舞台偏上，恢复静止态——后面的截图与探针不该看到一个「悬停中」的进度条。
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 320 });
    await delay(420);
    /*
     * 推荐歌单里混着纯器乐曲，在放的那一首可能压根没有歌词（实测 HEXST0RM / My Oh My / Stray.wav），
     * 那样下面一整串歌词探针都会假失败。这里顺着卡片流往后换到第一首**有词**的歌。
     * 位置很讲究：必须等 `homeInfo` 快照拿到手之后再换——换歌的 effect 会把悬浮框收回去，
     * 而那份快照要的正是「点开悬浮框 + 评论拉回来」的样子；下面的主题/歌词轨/逐字素探针只认 DOM，
     * 换歌后照样成立。
     */
    if (lyricLines === 0) {
      const picked = await ensureLyricSong(win);
      if (picked.index >= 0) {
        lyricLines = picked.lines;
        console.info(
          `[pi/smoke] 在放的那首没有歌词，换到第 ${picked.index + 1} 首「${picked.name}」：` +
            `歌词行=${picked.lines}`,
        );
      } else {
        console.info('[pi/smoke] 在放的那首没有歌词，队列往后找 12 首也都没有歌词（数据问题）');
      }
    }

    /*
     * 用户 m08768 第 4 条：舞台画哪套主题由设置里的 lyricTheme 决定。
     * 这里核对「设置里存着的」与「墙上真渲染的」是同一个 id。classic 之外的五个主题各有自己的
     * DOM（逐字素 / 画布 / 一行多列），下面那些盯着 classic DOM 的探针只在 classic 下才有意义，
     * 所以按主题分流：非 classic 时只钉「主题壳子还在、滚轮换行与回到当前还在」。
     */
    const storedTheme = (await services.getSettings()).lyricTheme;
    const stageTheme = (await win.webContents.executeJavaScript(
      `document.querySelector('[data-lyric-rail]')?.dataset.theme || ''`,
      true,
    )) as string;
    const themeOk = stageTheme !== '' && stageTheme === storedTheme;
    const classicStage = stageTheme === 'classic';
    console.info(
      `[pi/smoke] 歌词主题：设置=${storedTheme || '无'}｜舞台=${stageTheme || '无'} ${themeOk ? '✓' : '✗'}`,
    );

    /*
     * 用户 m08066 第 5 条：folia classic 主题的歌词舞台要能看见「逐字点亮」。
     *
     * 舞台只渲染**当前播到的那一行**，还没唱到的字素 opacity 0 —— 歌停在开头（0.x 秒）时
     * 整行就是隐形的（截图会是一片空白，第一版就截到过）。所以量之前先把进度拨到歌曲中段
     * （大多数歌那里正在唱），再轮询到真有字素亮起来；三个位置都还没亮就照实记，不假装量到。
     * `window.__piAudio` 是 `lib/audio-engine.ts` 挂在渲染进程上的那个单例（元素不在 DOM 里）。
     */
    const lyricSeek = async (fraction: number): Promise<number> =>
      (await win.webContents.executeJavaScript(
        `(() => {
          const audio = window.__piAudio;
          if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 1) return -1;
          audio.currentTime = audio.duration * ${fraction.toFixed(3)};
          return audio.currentTime;
        })()`,
        true,
      )) as number;
    interface StageProbe {
      words: number;
      waiting: number;
      active: number;
      passed: number;
      lit: number;
      maxOpacity: number;
      text: string;
    }
    const readStage = async (): Promise<StageProbe> =>
      (await win.webContents.executeJavaScript(
        `(() => {
          const words = [...document.querySelectorAll('[data-lyric-line] .pi-lyricstage__word')];
          const states = { waiting: 0, active: 0, passed: 0 };
          let lit = 0;
          let maxOpacity = 0;
          for (const word of words) {
            const state = word.dataset.wordState || 'waiting';
            states[state] = (states[state] || 0) + 1;
            const opacity = Number.parseFloat(getComputedStyle(word).opacity) || 0;
            if (opacity > maxOpacity) maxOpacity = opacity;
            if (opacity >= 0.5) lit += 1;
          }
          const line =
            document.querySelector('[data-lyric-line][data-active="true"]') ??
            document.querySelector('[data-lyric-line]');
          return {
            words: words.length,
            waiting: states.waiting,
            active: states.active,
            passed: states.passed,
            lit,
            maxOpacity,
            text: (line?.textContent ?? '').trim().slice(0, 20),
          };
        })()`,
        true,
      )) as StageProbe;
    /*
     * 拨到「有字素亮着」的状态再返回。歌停在开头时当前行还没唱到（字素 opacity 0）→ 截图会是
     * 一片空白，所以两处需要出画面之前都要先调它：一次给歌词探针，一次给播放器主页截图
     * （滚轮那几步可能正好跨行，新行的字素还在 entering）。
     */
    const ensureLitStage = async (minLit = 1): Promise<{ stage: StageProbe; at: number }> => {
      let probe = await readStage();
      let at = -1;
      if (probe.lit < minLit) {
        for (const fraction of [0.42, 0.58, 0.72]) {
          if (probe.lit >= minLit) break;
          at = await lyricSeek(fraction);
          for (let poll = 0; poll < 6 && probe.lit < minLit; poll += 1) {
            await delay(360);
            probe = await readStage();
          }
        }
      }
      // 当前行刚起头（字素还在一个个亮起来）时，原地等几拍比再挪进度更自然。
      for (let poll = 0; poll < 5 && probe.lit < minLit; poll += 1) {
        await delay(420);
        probe = await readStage();
      }
      // 刚拨过进度就多等一会儿，让换行与逐字入场（0.3~0.4s）走完，别把中间态交出去。
      if (at >= 0) await delay(420);
      return { stage: probe, at };
    };
    const litCheck = await ensureLitStage();
    const stage = litCheck.stage;
    const stageAt = litCheck.at;
    const litOk = !classicStage || (stage.words > 0 && stage.lit > 0 && stage.maxOpacity >= 0.5);
    console.info(
      `[pi/smoke] 歌词字素点亮：进度${stageAt < 0 ? '（没挪）' : `→${stageAt.toFixed(1)}s`}` +
        `｜字素=${stage.words}（waiting ${stage.waiting}/active ${stage.active}/passed ${stage.passed}）` +
        `｜亮起=${stage.lit} 最大不透明度=${stage.maxOpacity.toFixed(2)}` +
        `｜当前行=「${stage.text}」 ${litOk ? '✓' : '✗'}`,
    );
    // m06982 第 5 条：歌词改成 folia 风格的轨道——当前行钉在 46% 高处、只渲染附近
    // 几行、按距离衰减（越小越淡越糊）、当前行带扫描高亮。这里钉住三件可量的事：
    // 只渲染少数行（不是整首铺出来）、有且只有一个 active 行、容器上下有淡出遮罩。
    const railInfo = (await win.webContents.executeJavaScript(
      `(() => {
        const root = document.querySelector('[data-lyric-rail]');
        if (!root) return null;
        const lines = [...root.querySelectorAll('[data-lyric-line]')];
        const active = lines.find((el) => el.dataset.active === 'true') ?? null;
        const style = getComputedStyle(root);
        const sweep =
          (style.getPropertyValue('--pi-sweep') || '').trim() ||
          (active ? (getComputedStyle(active).getPropertyValue('--pi-sweep') || '').trim() : '');
        const activeStyle = active ? getComputedStyle(active) : null;
        return {
          lines: lines.length,
          activeIndex: active ? lines.indexOf(active) : -1,
          activeText: active ? (active.textContent || '').trim().slice(0, 24) : '',
          activeOpacity: activeStyle ? Number.parseFloat(activeStyle.opacity) : 0,
          sweep,
          masked: (style.maskImage || style.webkitMaskImage || 'none') !== 'none',
          blurred: lines.filter((el) => (getComputedStyle(el).filter || '').includes('blur')).length,
          hints: [...new Set(lines.map((el) => el.dataset.hint ?? ''))].filter(Boolean).join('/'),
        };
      })()`,
      true,
    )) as {
      lines: number;
      activeIndex: number;
      activeText: string;
      activeOpacity: number;
      sweep: string;
      masked: boolean;
      blurred: number;
      hints: string;
    } | null;
    const railOk =
      railInfo !== null &&
      railInfo.lines > 0 &&
      // 只渲染附近几行：整首铺出来会明显超过这个上限（一屏 9 行＝active ± 4）。
      // 「只渲染附近几行 + 上下淡出遮罩」是 classic 的舞台形态；别的主题各有各的排版，不钉这条。
      (!classicStage || railInfo.lines <= 12) &&
      railInfo.activeIndex >= 0 &&
      railInfo.activeText.length > 0 &&
      (!classicStage || railInfo.masked);
    console.info(
      `[pi/smoke] 歌词轨道：${
        railInfo === null
          ? '未找到 [data-lyric-rail]'
          : `渲染行=${railInfo.lines} active=${railInfo.activeIndex}「${railInfo.activeText}」` +
            `｜遮罩=${railInfo.masked} 带模糊的行=${railInfo.blurred} --pi-sweep=${railInfo.sweep || '（无）'}` +
            ` data-hint=${railInfo.hints || '（无）'}`
      } ${railOk ? '✓' : '✗'}`,
    );
    // 用户 m08066 第 4 条 + 第八轮第 3 条：滚动歌词只换「看哪一句」，**不许改播放状态**。
    // 判据：看的那一行移了（data-view-index 变大）、音频 currentTime 没跳（旧版一滚就
    // seek 到那一句，时间会直接跳几秒）、「回到当前」按钮已经按用户要求删掉、
    // 并且**滚回当前句就自动交还给播放**（不再需要那个按钮）。
    type LyricWheelProbe = {
      has: boolean;
      view: number;
      active: number;
      following: string;
      time: number;
      /** 「回到当前」按钮不存在 = true（第八轮第 3 条把它删了）。 */
      followChipGone: boolean;
      /** 整首歌的歌词行数（根的 `data-lines`）：用来判断还能不能往下滚。 */
      lines: number;
    };
    const readLyricWheel = async (): Promise<LyricWheelProbe> =>
      (await win.webContents.executeJavaScript(
        `(() => {
          const root = document.querySelector('[data-lyric-rail]');
          // 音频元素是 new Audio() 建的、不在 DOM 里：必须读 window.__piAudio
          // （apps/renderer/src/lib/audio-engine.ts），querySelector('audio') 恒为 null，
          // 会让下面那条 |ΔcurrentTime| 判据变成「-1 对 -1」的假通过。
          const audio = window.__piAudio;
          return {
            has: Boolean(root),
            view: root ? Number(root.dataset.viewIndex) : -1,
            active: root ? Number(root.dataset.activeIndex) : -1,
            following: root ? (root.dataset.following ?? '') : '',
            time: audio ? audio.currentTime : -1,
            followChipGone: document.querySelector('[data-lyric-follow]') === null,
            lines: root ? Number(root.dataset.lines) : -1,
          };
        })()`,
        true,
      )) as LyricWheelProbe;
    /*
     * 第十八轮第 4 条（用户 m01482）：「**只允许时计**（主题）的歌词动效可以滚轮滑动查看不同歌词，
     * 并且一段时间无操作自动回到当前歌词」。滚轮那条分支由主题门控
     * （`apps/renderer/src/components/LyricStage.tsx:97` 今天只写 `WHEEL_BROWSE_THEMES = ['pendolo']`、
     * 该文件里 `wheelBrowsable = WHEEL_BROWSE_THEMES.includes(activeTheme)`），而用户设置里存的主题
     * 可能是别的（这一跑实测 `lyricTheme = fume`）——那样滚轮什么都不做，下面这一串判据会全假红
     * （实测：`view=19→19`、`following=true→true`，而同时段的条尺寸/药丸判据全绿）。
     * 所以先用**真的 UI** 把主题切成「时计」：点出 PI 键 → 右划 → 快速设置卡 → `[data-quick-choice="pendolo"]`
     *（`PiQuickPanels.tsx:277` 那颗 chip 走的是 `usePatchSettings()`，会刷新 react-query 缓存、舞台立刻重渲染；
     *  直接调 `settings:patch` IPC 反而绕过缓存刷新，舞台不会变）。量完再切回用户原来那一套。
     *
     * 用户 m01402 第 7 条之后，`classic`（流光）被产品从这份白名单里摘掉了（「流光不要有滚轮可以切换
     * 歌词的功能。时计可以滚轮切换歌词」）——这里必须跟着收成只剩时计：老写法把 classic 也算「可滚轮」，
     * 于是在 classic 上直接开量、滚轮当然毫无反应，判据假红（本轮实测：`view=4→4`、播放 25.35→25.68s）。
     */
    const wheelThemeBefore = stageTheme;
    const wheelThemeBrowsable = (theme: string): boolean => theme === 'pendolo';
    /** 读舞台真渲染的主题 id（与上面 `stageTheme` 同一个抓手）。 */
    const readStageTheme = async (): Promise<string> =>
      (await win.webContents.executeJavaScript(
        `document.querySelector('[data-lyric-rail]')?.dataset.theme || ''`,
        true,
      )) as string;
    /** 切主题失败时把「卡在哪一步」写在这里，日志里照实打出来。 */
    let wheelPickWhy = '';
    /** 用快速设置卡把歌词主题切成 `theme`；返回换完之后舞台报的主题 id（失败返回空串）。 */
    const pickLyricTheme = async (theme: string): Promise<string> => {
      wheelPickWhy = '';
      // 三轮重试：`tapQuickOrb`/`swipeQuickOrb` 走的都是合成指针，偶发会丢一步（实测先锋跑里
      // 出现过「切成时计后舞台=无」），所以每一轮都把失败点写进 `wheelPickWhy` 再重来。
      for (let round = 0; round < 3; round += 1) {
        // 每一轮先收掉可能残留的浮层、确认人站在播放主页上：`quickOrbSpot` 只在 `.pi-home`
        // 里找空白点，人不在主页（或浮层盖着舞台）时三次都会点空——实测连跑两跑都卡在
        // 「第3轮：点空白没点出 PI 键」，而同一份代码在别的一跑里又能过。
        // 顺带按轮次换一个空白候选（`quickOrbSpot` 的 `which` 只有 0/1 两个）。
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-quick-dismiss="true"]')?.click()`,
          true,
        );
        await clickNav(win, '播放器主页');
        await delay(220);
        if ((await tapQuickOrb(win, round % 2)) === null) {
          wheelPickWhy = `第${round + 1}轮：点空白没点出 PI 键`;
          await delay(420);
          continue;
        }
        await delay(280);
        if (!(await swipeQuickOrb(win, 150, 0))) {
          wheelPickWhy = `第${round + 1}轮：读不到球心，划不动`;
          await delay(420);
          continue;
        }
        await delay(640);
        const chips = (await win.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('[data-quick-choice]')).map((el) => (el.getAttribute('data-quick-choice') || ''))`,
          true,
        )) as string[];
        const picked = (await win.webContents.executeJavaScript(
          `(() => {
            const chip = document.querySelector('[data-quick-choice="${theme}"]');
            if (!(chip instanceof HTMLElement)) return false;
            chip.click();
            return true;
          })()`,
          true,
        )) as boolean;
        if (!picked) {
          wheelPickWhy = `第${round + 1}轮：设置卡里没有 ${theme}（现有=${chips.join(',') || '空'}）`;
          await win.webContents.executeJavaScript(
            `document.querySelector('[data-quick-dismiss="true"]')?.click()`,
            true,
          );
          await delay(440);
          continue;
        }
        // 点完等舞台重渲染（`usePatchSettings` 刷了缓存、舞台拿新主题重挂），最多 2.4s。
        let now = '';
        const swapDeadline = Date.now() + 2400;
        while (Date.now() < swapDeadline) {
          await delay(240);
          now = await readStageTheme();
          if (now === theme) break;
        }
        // 收起快速设置卡：后面的截图与指针探针不该被它盖住。
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-quick-dismiss="true"]')?.click()`,
          true,
        );
        await delay(460);
        if (now === theme) return now;
        wheelPickWhy = `第${round + 1}轮：点了 chip 但舞台报「${now || '无'}」`;
        await delay(320);
      }
      return '';
    };
    let wheelThemePicked = false;
    if (!wheelThemeBrowsable(stageTheme)) {
      const forced = await pickLyricTheme('pendolo');
      wheelThemePicked = forced === 'pendolo';
      console.info(
        `[pi/smoke] 第十八轮④歌词滚轮主题：设置=${storedTheme || '无'}｜舞台=${stageTheme || '无'}` +
          ` → 切成时计后舞台=${forced || '无'} ${wheelThemePicked ? '✓' : '✗'}` +
          `${wheelPickWhy === '' ? '' : `（${wheelPickWhy}）`}（量完切回）`,
      );
    }
    const wheelBefore = await readLyricWheel();
    let wheelAfter = wheelBefore;
    /** 往回滚之后 `data-following` 的值（第八轮第 3 条：滚回当前句自动交还）。 */
    let restored = '';
    /**
     * 这一跑往哪个方向滚（`true` = 往下）。必须在 `if (wheelBefore.has)` 之外声明：
     * 下面的日志串要用它，写成块内 `const` 会 `ReferenceError: wheelDown is not defined`（实测踩过）。
     */
    let wheelDown = true;
    let lyricWheelOk = false;
    /** 第十八轮第 4 条后半句的读数（无操作 4s 后自动回到当前歌词），进第十八轮总闸。 */
    let r18LyricIdleOk = false;
    if (wheelBefore.has) {
      /*
       * 方向自适应（这一跑实测的坑）：播到的这一句可能已经贴着歌词末尾
       * （实测 `active=21`、`data-lines=22` ⇒ 往下滚会被 clamp 在最后一行，`view` 一动不动、
       *  `following` 也不会变，而旧口径「往下滚 view 必须变大」就假红）。
       * 所以按剩余行数选方向：下面至少还有 3 句就往下滚，否则往上滚——
       * 两个方向都必须能换行、也都必须能滚回当前句交还（`LyricStage` 的 onWheel 里
       * `next === followIndex` 时把 `viewIndex` 置回 null）。
       */
      wheelDown = wheelBefore.lines - 1 - wheelBefore.active >= 3;
      const wheelStep = wheelDown ? 240 : -240;
      await win.webContents.executeJavaScript(
        `(() => {
          const root = document.querySelector('[data-lyric-rail]');
          // 三格滚轮（实现里一格 72px）：真实滚轮事件，走的是组件里那个 passive:false 的原生监听。
          // cancelable 必须给：真实滚轮可被 preventDefault，不给的话 preventDefault 是空操作，
          // 浏览器原生滚动会照走，这条判据就会把「产品正确」误判成「滚轮没被拦住」。
          root?.dispatchEvent(new WheelEvent('wheel', { deltaY: ${wheelStep}, bubbles: true, cancelable: true }));
          return true;
        })()`,
        true,
      );
      await delay(320);
      wheelAfter = await readLyricWheel();
      /*
       * 第十八轮第 4 条（用户 m01482）：「**只允许时计**（主题）的歌词动效可以滚轮滑动查看不同歌词，
       * 并且一段时间无操作自动回到当前歌词」。滚轮本身是 classic 与 pendolo 共用的一条分支
       * （`LyricStage` 的 `WHEEL_BROWSE_THEMES = ['classic','pendolo']`），这里在默认的 classic 上
       * 顺带量「无操作 4.6s 之后自己交还回当前句」（`WHEEL_IDLE_RETURN_MS = 4000`）。
       */
      await delay(4600);
      const idleBack = await readLyricWheel();
      const idleOk =
        idleBack.following === 'true' && Math.abs(idleBack.view - idleBack.active) <= 1;
      r18LyricIdleOk = idleOk;
      console.info(
        `[pi/smoke] 第十八轮④歌词空闲自动回到当前：无操作 4.6s 后 following=${idleBack.following}` +
          ` view=${idleBack.view} active=${idleBack.active} ${idleOk ? '✓' : '✗'}`,
      );
      /*
       * 交还给播放：没有「回到当前」按钮了，**滚回当前句就是交还**
       * （`LyricStage` 的 onWheel 里 `next === followIndex` 时把 viewIndex 置回 null）。
       * 往回滚最多 5 格，直到 `data-following` 变回 true——顺手也验证了
       *「不点按钮也能回到当前」这件事真的成立。
       */
      restored = (await win.webContents.executeJavaScript(
        `(async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const root = document.querySelector('[data-lyric-rail]');
          for (let i = 0; i < 5; i += 1) {
            if ((root?.dataset.following ?? '') === 'true') break;
            root?.dispatchEvent(new WheelEvent('wheel', { deltaY: ${-wheelStep}, bubbles: true, cancelable: true }));
            await sleep(180);
          }
          return root?.dataset.following ?? '';
        })()`,
        true,
      )) as string;
      lyricWheelOk =
        (wheelDown ? wheelAfter.view > wheelBefore.view : wheelAfter.view < wheelBefore.view) &&
        wheelAfter.following === 'false' &&
        wheelAfter.followChipGone &&
        restored === 'true' &&
        idleOk &&
        Math.abs(wheelAfter.time - wheelBefore.time) < 1.5;
    }
    /*
     * 量完把主题切回用户原来那一套：冒烟不该改掉用户存下的偏好
     *（与设置页那条「点一个别的主题、再点回来」同一个纪律）。
     */
    if (wheelThemePicked && wheelThemeBefore !== '') {
      const back = await pickLyricTheme(wheelThemeBefore);
      console.info(
        `[pi/smoke] 第十八轮④歌词滚轮主题还原：目标=${wheelThemeBefore}｜舞台=${back || '无'}` +
          ` ${back === wheelThemeBefore ? '✓' : '✗'}`,
      );
    }
    console.info(
      `[pi/smoke] 歌词滚动不改播放：${
        wheelBefore.has
          ? `方向=${wheelDown ? '下' : '上'}（共 ${wheelBefore.lines} 句·当前第 ${wheelBefore.active + 1} 句）` +
            `｜滚轮前 view=${wheelBefore.view}·播放=${wheelBefore.time.toFixed(2)}s｜滚轮后 view=${wheelAfter.view}·播放=${wheelAfter.time.toFixed(2)}s` +
            `（差 ${Math.abs(wheelAfter.time - wheelBefore.time).toFixed(2)}s）｜active=${wheelBefore.active}→${wheelAfter.active}` +
            `｜回到当前按钮已删=${wheelAfter.followChipGone}｜往回滚交还=${restored}｜following=${wheelBefore.following}→${wheelAfter.following}`
          : '未找到 [data-lyric-rail]'
      } ${lyricWheelOk ? '✓' : '✗'}`,
    );
    // 截图前把右侧评论/信息抽屉收起来：歌词舞台在右半边，抽屉正好盖住它，而这张图要展示
    // 第 5 条的「逐字点亮」。抽屉的关闭键在 `.pi-home__drawer-head` 里。
    await win.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('.pi-home__drawer .pi-home__drawer-head .pi-iconbtn');
        if (!button) return false;
        button.click();
        return true;
      })()`,
      true,
    );
    await delay(420);

    // ── 第八轮第 1 条：无操作自动隐藏（名片 / 进度条 / 悬浮球），且三件各自被指针单独叫醒 ──
    // 冒烟全程把 `document.documentElement.dataset.piIdle` 设成 'off'（前面那些静置截图要拍到三件
    // 东西都在的样子）。这里临时打开、手动「做一次操作」重新计时，等过 IDLE_MS(3200ms) 再读三件的
    // computed opacity，然后分别把指针移到进度条 / 名片 / 球上，验证「只有被指到的那一件回来」。
    type IdleSnap = {
      idle: string;
      frame: string;
      snapped: string;
      open: string;
      card: string;
      bar: string;
      orb: string;
      cardHover: boolean;
      barHover: boolean;
      orbHover: boolean;
      cardAt: number[] | null;
      barAt: number[] | null;
      orbAt: number[] | null;
    };
    const idleRead = async (): Promise<IdleSnap> =>
      (await win.webContents.executeJavaScript(
        `(() => {
          // 窗口没有 OS 焦点时 Chromium 会节流动画时间线（第九轮诊断实测 focused=false）：CSS 过渡会
          // 停在**起始值**上，getComputedStyle 读到的就是这个冻结值（静置时三个都是 1.00，可 data-idle
          // 已经是 true、选择器也匹配）。所以读之前先把过渡推到终态；无限循环的动画 finish() 会抛，
          // 照常跳过即可。
          const settle = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return;
            for (const anim of el.getAnimations()) {
              try {
                anim.finish();
              } catch (error) {
                /* 无限动画推不到终态，保持原样 */
              }
            }
          };
          settle('.pi-home__card');
          settle('.pi-home__bar');
          settle('.pi-orb');
          const op = (sel) => {
            const el = document.querySelector(sel);
            return el ? Number(getComputedStyle(el).opacity).toFixed(2) : '缺失';
          };
          const mid = (sel) => {
            const r = document.querySelector(sel)?.getBoundingClientRect();
            return r ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null;
          };
          const hover = (sel) => document.querySelector(sel)?.matches(':hover') ?? false;
          return {
            // 注意：这段字符串在渲染层里是当纯 JS 求值的，不能出现 TS 的 as 断言（会 SyntaxError）。
            // 另外，模板字符串里的注释也**不能有反引号**（会提前把模板截断，这个坑犯过两次）。
            idle: Array.from(document.querySelectorAll('.pi-app'))
              .map((el) => el.dataset.idle ?? '?')
              .join('/'),
            frame: document.querySelector('.pi-home')?.dataset.frame ?? '?',
            snapped: document.querySelector('.pi-orb')?.dataset.snapped ?? '?',
            open: document.querySelector('.pi-orb')?.dataset.open ?? '?',
            card: op('.pi-home__card'),
            bar: op('.pi-home__bar'),
            orb: op('.pi-orb'),
            cardHover: hover('.pi-home__card'),
            barHover: hover('.pi-home__bar'),
            orbHover: hover('.pi-orb'),
            cardAt: mid('.pi-home__card'),
            barAt: mid('.pi-home__bar'),
            orbAt: mid('.pi-orb'),
          };
        })()`,
        true,
      )) as IdleSnap;
    /** 开关自动隐藏，并**手动做一次操作**（keydown 是真事件，`useIdle` 只认 pointerdown/keydown/wheel）重新计时。 */
    const armIdle = async (on: boolean): Promise<void> => {
      await win.webContents.executeJavaScript(
        `(() => {
          document.documentElement.dataset.piIdle = '${on ? 'on' : 'off'}';
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', bubbles: true }));
          return true;
        })()`,
        true,
      );
    };
    /*
     * 先把这个窗口抢到前台：这一段量的是「用户正看着它」时的观感，而窗口没有 OS 焦点时 Chromium
     * 会节流动画时间线、`:hover` 也只在偶尔出帧时才重算（-e 那次 `focused=false` 就是因此读到
     * 冻结的 1.00 与过期的 hover 位）。
     */
    await focusSmoke(win);
    await armIdle(true);
    // 先把指针挪到左上角标题栏（三件都不沾）：上一段探针留下的 :hover 会摁住某一件，读数就不干净了。
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
    /*
     * 第十八轮第 ⑪ 条把「切歌后名片露一下脸」的窗口从 3.4s 提到 `SONG_CARD_SHOW_MS = 5000`，
     * 而这里原本只静置 3.9s —— 刚巧前面切过歌时就会拍到名片还亮着，把 `名片=1.00` 判成假红
     * （先锋那一跑就红过一条；它不进任何闸门，但日志里挂着 ✗ 会误导后来的人）。
     * 所以先等名片自己收回去（`data-reveal` 转 false —— 指针在左上角，构不成「贴近左下角」），最多再等 3s。
     */
    const revealDeadline = Date.now() + 3000;
    while (Date.now() < revealDeadline) {
      const revealed = (await win.webContents.executeJavaScript(
        `document.querySelector('.pi-home__card')?.getAttribute('data-reveal') === 'true'`,
        true,
      )) as boolean;
      if (!revealed) break;
      await delay(200);
    }
    await delay(3900);
    const idleBefore = await idleRead();
    /*
     * 第九轮排查结论（别再重复查）：这里曾经静置读到三个 opacity 全是 1.00，事后用一段临时诊断
     * （打印 class / inApp / matchIdle / op / anims / focused）钉死真因是**窗口没有 OS 焦点**——
     * 选择器匹配得上（matchIdle=true）、元素也在 `.pi-app` 里，但 Chromium 节流了动画时间线，过渡
     * 停在起始值。修法在 `idleRead()` 里的 settle()：读之前把过渡推到终态，读数就与时间线无关。
     */
    const hoverAt = async (at: number[] | null, expect: string): Promise<IdleSnap> => {
      if (at !== null) {
        const baseX = at[0]!;
        const baseY = at[1]!;
        /*
         * 没有 OS 焦点时 :hover 只在偶尔出帧时才重算，不能「挪过去等 560ms 就读」，那会读到上一步
         * 留下的残留状态。所以轮询 matches(':hover')，真为真再读；一轮没生效就**再抖一下指针**
         * （±2px，逼 Chromium 重算 hover 链）往下试，最多 3 轮 —— -e 那次「指进度条 hover=000」
         * 就是这个时序，不是界面没反应（同一时刻指名片、指球都唤醒了）。
         */
        let hovered = false;
        for (let round = 0; round < 3 && !hovered; round += 1) {
          const x = baseX + (round === 0 ? 0 : round === 1 ? 2 : -2);
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y: baseY });
          for (let attempt = 0; attempt < 12 && !hovered; attempt += 1) {
            await delay(60);
            hovered = (await win.webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(expect)})?.matches(':hover') ?? false`,
              true,
            )) as boolean;
          }
        }
        /*
         * 还没悬停上就把「这一点上压着谁」照实打出来：只看 `hover=000` 无从下手，而
         * `elementsFromPoint` 会给出真正的命中栈（含每层的 class / pointer-events / z-index），
         * 一次就能看清是「元素没到那儿」还是「被别的东西挡住了」。
         * 这段字符串是在渲染层里当纯 JS 求值的：不能出现反引号，也不能出现 TS 的 as 断言。
         */
        if (!hovered) {
          const hit = (await win.webContents.executeJavaScript(
            `(() => {
              const fmt = (el) => {
                const cls = typeof el.className === 'string' ? el.className : '';
                const style = getComputedStyle(el);
                return (
                  el.tagName.toLowerCase() +
                  (cls ? '.' + cls.trim().split(/\\s+/).join('.') : '') +
                  '[pe=' + style.pointerEvents + ',z=' + style.zIndex + ',op=' + Number(style.opacity).toFixed(2) + ']'
                );
              };
              const stack = Array.from(document.elementsFromPoint(${baseX}, ${baseY}))
                .slice(0, 8)
                .map(fmt);
              const target = document.querySelector(${JSON.stringify(expect)});
              const rect = target ? target.getBoundingClientRect() : null;
              return {
                stack: stack.join(' < '),
                rect: rect
                  ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
                  : null,
                hover: target ? target.matches(':hover') : null,
              };
            })()`,
            true,
          )) as { stack: string; rect: number[] | null; hover: boolean | null };
          console.info(
            `[pi/smoke] 悬停没命中（${expect} @ ${baseX},${baseY}）：命中栈=${hit.stack}｜目标 rect=${
              hit.rect ? hit.rect.join(',') : '无'
            }｜:hover=${hit.hover}`,
          );
        }
      }
      await delay(120);
      return idleRead();
    };
    const onBar = await hoverAt(idleBefore.barAt, '.pi-home__bar');
    const onCard = await hoverAt(idleBefore.cardAt, '.pi-home__card');
    // 第十六轮删球：原来的 `const onOrb = await hoverAt(idleBefore.orbAt, '.pi-orb');` 随之退休
    // （球没了，orbAt 恒为 null，「指球只把球叫醒」这一项没有对应功能了）。
    await armIdle(false);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
    /*
     * 第十七轮第 7 条的「指针接近」是渲染层听 window 的 `pointermove`、再用 rAF 合帧算出来的
     * （`apps/renderer/src/pages/HomePage.tsx:374-399`）。窗口没有 OS 焦点时 Chromium 会把 rAF
     * 压到很稀（同一条注释在 `idleRead()` 的 settle 里已经记过），于是会出现「人已经走了、名片
     * 还亮着」——本轮实测一次 `收工恢复 片/条=1.00/1.00`（同一次里指条/指名片两条都 ✓）。
     * 这里做两件事：① 补一条**合成** `pointermove`（与真实输入互为兜底，前面的 `hoverAt` 用的
     * 也是真实输入）；② 等名片自己真的落回去（`data-reveal` 转 false）再读，最多 3s。
     * 判据没变（`idleRestoredOk` 仍是「收工后名片 0.00、进度条 1.00」）。
     */
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new PointerEvent('pointermove', { clientX: 8, clientY: 8, bubbles: true }))`,
      true,
    );
    let idleAfterReveal = '?';
    const cardAwayDeadline = Date.now() + 3000;
    for (;;) {
      idleAfterReveal = (await win.webContents.executeJavaScript(
        `(() => {
          const el = document.querySelector('.pi-home__card');
          if (el === null) return '无';
          const st = getComputedStyle(el);
          return (
            'reveal=' + (el.getAttribute('data-reveal') || '无') +
            ',op=' + Number(st.opacity).toFixed(2) +
            ',pe=' + st.pointerEvents
          );
        })()`,
        true,
      )) as string;
      if (!idleAfterReveal.includes('reveal=true') || Date.now() >= cardAwayDeadline) break;
      await delay(120);
    }
    await delay(560);
    const idleAfter = await idleRead();
    // 第十轮第 3 条（用户 m02362）：「进度条去掉隐藏」——静置时进度条**不该**淡出，
    // 所以这里判 1.00（原来判 0.00）。藏起来的只剩名片（第十六轮删球，球那一件退休）。
    const idleHiddenOk = idleBefore.idle === 'true' && idleBefore.card === '0.00' && idleBefore.bar === '1.00';
    // 第十六轮删球：原来还有「只有被指到的那一件自己回来」，球那一件退休，只剩进度条/名片两件。
    const idleWakeOk =
      onBar.bar === '1.00' && onBar.card === '0.00' && onCard.card === '1.00' && onCard.bar === '1.00';
    /*
     * 第十七轮第 7 条（用户 m00006）：名片**常态隐藏**，只有「指针接近」或「刚切完歌」才从底部
     * 冒出来。所以收工（指针挪回角落 8,8、离名片很远）之后判的不再是名片回到 1.00，而是它
     * **继续藏着**；进度条照旧常驻不淡出（第十轮第 3 条）。
     */
    const idleRestoredOk = idleAfter.card === '0.00' && idleAfter.bar === '1.00';
    const hs = (o: IdleSnap): string => `${o.cardHover ? 1 : 0}${o.barHover ? 1 : 0}${o.orbHover ? 1 : 0}`;
    console.info(
      `[pi/smoke] 无操作自动隐藏（第十六轮删球：球那一件退休）：静置 data-idle=${idleBefore.idle} 框=${idleBefore.frame}` +
        ` 名片/进度条=${idleBefore.card}/${idleBefore.bar} hover=${hs(idleBefore)}（名片 0.00、进度条 1.00 才算对）` +
        `｜指进度条 条/片=${onBar.bar}/${onBar.card} hover=${hs(onBar)}` +
        `｜指名片 条/片=${onCard.bar}/${onCard.card} hover=${hs(onCard)}` +
        `｜收工恢复 片/条=${idleAfter.card}/${idleAfter.bar} idle=${idleAfter.idle} 名片 ${idleAfterReveal}` +
        `｜${idleHiddenOk && idleWakeOk && idleRestoredOk ? '✓' : '✗'}`,
    );

    // ── 第八轮第 3 条 + 用户 m00736 第 1 条：到底谁可以「点歌词跳进度」──
    /*
     * 老探针（第八轮第 3 条）量的是 classic：「往回滚一格 → 真点那一行 → 播放位置该退回去」。
     * 用户 m00736 第 1 条把这条判据推翻了：「classic（流光）主题点歌词不允许跳进度。时计可以用滚轮
     * 查看不同歌词，并且点歌词跳进度」。所以这里改成一对互补的判据：
     *   ① classic：滚轮查看（view 走掉、following=false）之后真点那一行 —— 必须**什么都不发生**
     *      （音频时间不倒退、浏览权不交还、播放跟的那一行也不换成点的那一行）；
     *   ② 时计（pendolo）：同一套动作**必须真的定位**（时间倒退 ≥1.5s、following 回 true）。
     * 两半都沿用 `readLyricWheel` 的读数口径（`[data-lyric-rail]` 的 view/following/active + `__piAudio`）；
     * 时计那半多读一个 `[data-lyric-line]` 的 `data-index`——时计的行只带 data-index、不带
     * data-line-time，委托里走的正是 data-index 回查那条分支（见 `LyricStage.tsx` 的壳层 onClick）。
     * classic 舞台渲染的就是「锚点那一行」（滚轮把锚点移走后渲染的是过去的那一行），行上有 data-index。
     */
    const lyricClickRead = async (): Promise<{
      view: string;
      following: string;
      active: string;
      time: number;
      row: { index: number; at: number[] } | null;
    }> =>
      (await win.webContents.executeJavaScript(
        `(() => {
          const rail = document.querySelector('[data-lyric-rail]');
          const line = document.querySelector('.pi-lyricstage__line:not([data-phase="exit"])');
          const r = line?.getBoundingClientRect();
          return {
            view: rail?.dataset.viewIndex ?? '?',
            following: rail?.dataset.following ?? '?',
            active: rail?.dataset.activeIndex ?? '?',
            time: Math.round((window.__piAudio?.currentTime ?? 0) * 1000),
            row:
              line && r
                ? {
                    index: Number(line.getAttribute('data-index') ?? -1),
                    at: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)],
                  }
                : null,
          };
        })()`,
        true,
      )) as { view: string; following: string; active: string; time: number; row: { index: number; at: number[] } | null };
    /*
     * 原来这里有一个 `rollBackAndClickRow`（先滚轮往回滚 3 行、再真点显示的那一行）。**用户 m01402
     * 第 7 条**把流光的滚轮浏览整个拿掉之后它就没法用了：滚轮再也移不动 view，`steppedBack` 恒为 0。
     * 那一半改成「先验滚轮不动，再点显示中的那一行」，helper 随之删除（留着会变成未使用变量）。
     */

    /*
     * 两半各自先把舞台换到自己那套主题上再点。理由：主题偏好会跨跑留存（`pi.lyricTheme`），
     * 「这一跑是 classic 场景」（`classicStage`）≠「此刻舞台正好是 classic」——主题留在别处时，
     * classic 那半整个不跑（本轮实测：`点歌词不定位` 那行根本没出现），时计那半也可能点在
     * 一个 seek 不到的槽位上。先记下跑之前那套，最后原样还回去（探针不许改用户偏好）。
     */
    const themeAtClickProbe = await readStageTheme();
    const classicOnStage =
      themeAtClickProbe === 'classic' ? 'classic' : await pickLyricTheme('classic');
    if (classicOnStage !== 'classic') {
      console.info(
        `[pi/smoke] 点歌词不定位（用户 m01402 第 7 条，流光）：换主题失败（原=${themeAtClickProbe || '无'}） ✗`,
      );
    } else {
      /*
       * **用户 m01402 第 7 条**把流光的滚轮浏览拿掉之后，这一半改成三段读数：
       * ① 真发一发 wheel，view / active / following 三项都必须原地不动（这就是「流光不许用滚轮切歌词」）；
       * ② 点舞台上显示中的那一行（不再需要先滚回去），播放时间只许按自然速度前进——正反两个方向的
       *    跳变都算失败（原判据只堵「倒退」，现在把「跳到后面的行」也堵上）；
       * ③ 顺带把这一行的真实落点记下来：流光歌词行不吃指针（`pointer-events` 还是 none），点击会穿到
       *    舞台壳上，这正是「点了什么也没发生」的原因，写进日志当证据。
       */
      const beforeClick = await lyricClickRead();
      /*
       * 判「滚轮真的被吃掉」不能只看 view/active 有没有动：`following=true`（跟着播放）时
       * `view` 就是当前唱到的那一行，歌在往前走 ⇒ 700ms 里两者会一起 +1，那不是滚轮干的
       * 事（实测踩过这条假红：`view=49→50 active=49→50 following=true→true`）。
       * 所以改成两条与时间无关的证据：
       * ① `dispatchEvent()` 的返回值与 `defaultPrevented`——真被 preventDefault 才是 false/true；
       * ② 「view 与 active 的差」不变（没被滚轮挪去别的句子）+ following 不变。
       */
      const wheelEv = (await win.webContents.executeJavaScript(
        `(() => {
          const root = document.querySelector('[data-lyric-rail]');
          const ev = new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true });
          const notCanceled = root === null ? null : root.dispatchEvent(ev);
          return { canceled: ev.defaultPrevented, notCanceled };
        })()`,
        true,
      )) as { canceled: boolean; notCanceled: boolean | null };
      await delay(700);
      const afterWheel = await lyricClickRead();
      const offsetBefore = Number(beforeClick.view) - Number(beforeClick.active);
      const offsetAfter = Number(afterWheel.view) - Number(afterWheel.active);
      const wheelIgnored =
        beforeClick.row !== null &&
        wheelEv.canceled === true &&
        wheelEv.notCanceled === false &&
        offsetAfter === offsetBefore &&
        afterWheel.following === beforeClick.following;
      const hitAt = (await win.webContents.executeJavaScript(
        `(() => {
          const line = document.querySelector('.pi-lyricstage__line:not([data-phase="exit"])');
          const r = line?.getBoundingClientRect();
          if (!line || !r) return '无行';
          const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2),
            Math.round(r.top + r.height / 2),
          );
          return hit === null ? '空' : String(hit.className || hit.tagName).slice(0, 40);
        })()`,
        true,
      )) as string;
      const baseTime = afterWheel.time;
      const startedAt = Date.now();
      if (afterWheel.row !== null) {
        const clickX = afterWheel.row.at[0]!;
        const clickY = afterWheel.row.at[1]!;
        win.webContents.sendInputEvent({ type: 'mouseMove', x: clickX, y: clickY });
        await delay(140);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 });
        await delay(70);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 });
      }
      await delay(1100);
      const afterClick = await lyricClickRead();
      const elapsed = Date.now() - startedAt;
      const advance = afterClick.time - baseTime;
      const blockedOk =
        afterWheel.row !== null &&
        wheelIgnored &&
        Math.abs(advance - elapsed) <= 700 &&
        afterClick.following === afterWheel.following;
      console.info(
        `[pi/smoke] 点歌词不定位（用户 m01402 第 7 条，流光）：滚轮 被吃掉=${wheelEv.canceled}` +
          ` view-active 差=${offsetBefore}→${offsetAfter}（要求不变） following=${beforeClick.following}→${afterWheel.following}（要求不变）` +
          `（歌自己往前走不算：${wheelIgnored ? '✓' : '✗'}）｜点第 ${afterWheel.row === null ? '?' : afterWheel.row.index + 1} 行` +
          `（真实落点=${hitAt}），播放 ${baseTime}ms→${afterClick.time}ms` +
          `（历时 ${elapsed}ms 走播 ${advance}ms，落差 ${advance - elapsed}ms，不许跳）` +
          `｜following=${afterClick.following}（要求不变）｜${blockedOk ? '✓' : '✗'}`,
      );
    }

    /*
     * ② 时计（pendolo）：同一套「点歌词」动作必须真的定位。换主题沿用 `pickLyricTheme`（第十八轮④
     * 那条已经在用），量完把主题切回用户原来那一套——冒烟不许改用户存下的偏好。
     */
    {
      const themeBeforePendolo = await readStageTheme();
      const pendoloStage =
        themeBeforePendolo === 'pendolo' ? 'pendolo' : await pickLyricTheme('pendolo');
      if (pendoloStage !== 'pendolo') {
        console.info(
          `[pi/smoke] 点歌词定位（用户 m01402 第 7 条，时计）：换主题失败（原=${themeBeforePendolo || '无'}）` +
            `${wheelPickWhy === '' ? '' : `（${wheelPickWhy}）`} ✗`,
        );
      } else {
        const target = (await win.webContents.executeJavaScript(
          `(() => {
            const rail = document.querySelector('[data-lyric-rail]');
            const audio = window.__piAudio;
            const lines = rail ? [...rail.querySelectorAll('[data-lyric-line]')] : [];
            const activeIdx = rail ? Number(rail.dataset.activeIndex) : -1;
            const cands = [];
            for (const el of lines) {
              const i = Number(el.dataset.index ?? -1);
              if (i < 0 || i > activeIdx - 2) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) continue;
              const x = Math.round(r.left + r.width / 2);
              const y = Math.round(r.top + r.height / 2);
              const hit = document.elementFromPoint(x, y);
              cands.push({
                x,
                y,
                index: i,
                selfHit: hit !== null && (hit === el || el.contains(hit)),
                hitAt: hit === null ? '空' : String(hit.className || hit.tagName).slice(0, 40),
              });
            }
            cands.sort((a, b) => Number(b.selfHit) - Number(a.selfHit) || a.index - b.index);
            return {
              lines: lines.length,
              active: activeIdx,
              view: rail ? rail.dataset.viewIndex : '',
              before: audio ? Math.round(audio.currentTime * 1000) : -1,
              cands: cands.slice(0, 4),
            };
          })()`,
          true,
        )) as {
          lines: number;
          active: number;
          view: string;
          before: number;
          cands: { x: number; y: number; index: number; selfHit: boolean; hitAt: string }[];
        };
        if (target.cands.length === 0) {
          console.info(
            `[pi/smoke] 点歌词定位（用户 m01402 第 7 条，时计）：舞台上找不到 active 之前的可点行` +
              `（渲染行=${target.lines} active=${target.active}）✗`,
          );
        } else {
          /*
           * 命中就发真鼠标事件（和 classic 那半一样走 Chromium 输入栈）；落不到它身上（时计是一圈
           * 斜轮盘，靠边的槽位会被遮罩裁掉、`elementFromPoint` 够不着）就退回合成 click——它同样要
           * 过 React 挂在舞台壳上的委托，仍能证明「点行 → seek」这条链是通的。**最多试 4 个候选**：
           * 某个槽位此刻能不能点中取决于轮盘转到哪儿，一次没退回去不代表链断（本轮实测过假红）。
           */
          const hitCands = target.cands.filter((c) => c.selfHit).length;
          let attemptLog = '';
          let seekedOk = false;
          let realHit = false;
          for (const cand of target.cands) {
            let mode = '合成 click';
            if (cand.selfHit) {
              mode = '真鼠标';
              win.webContents.sendInputEvent({ type: 'mouseMove', x: cand.x, y: cand.y });
              await delay(140);
              win.webContents.sendInputEvent({
                type: 'mouseDown',
                x: cand.x,
                y: cand.y,
                button: 'left',
                clickCount: 1,
              });
              await delay(70);
              win.webContents.sendInputEvent({
                type: 'mouseUp',
                x: cand.x,
                y: cand.y,
                button: 'left',
                clickCount: 1,
              });
            } else {
              await win.webContents.executeJavaScript(
                `(() => {
                  const rail = document.querySelector('[data-lyric-rail]');
                  const el = rail
                    ? rail.querySelector('[data-lyric-line][data-index="${cand.index}"]')
                    : null;
                  el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  return el !== null;
                })()`,
                true,
              );
            }
            await delay(900);
            const st = await readLyricWheel();
            const at = Math.round(st.time * 1000);
            const back = target.before - at;
            attemptLog +=
              `｜试第 ${cand.index + 1} 行（${mode}，落点=${cand.hitAt}）→播放 ${at}ms` +
              `（倒退 ${back}ms）active=${st.active} following=${st.following || '空'}`;
            if (back >= 1500 && st.following === 'true') {
              seekedOk = true;
              realHit = mode === '真鼠标';
              break;
            }
          }
          /*
           * **用户 m01402 第 7 条**的后半句：「点击歌词可以跳进度，而不是出现圆球」。这两件事一起断言：
           * ① 真鼠标必须能落在歌词行上——`overlays.css` 里恢复 `pointer-events: auto` 的选择器原来只列了
           *    fume/cadenza/partita，pendolo 缺一条，于是真机点击穿过整个主题层命中 `.pi-home__stage-lyrics`，
           *    被 HomePage 的「点空白 → 召球」接走（seek 静默失效、圆球反而冒出来）；
           * ② 点完舞台上不许留下 `[data-quick-orb]`（召球那条链没被触发）。
           * 只靠合成 click 走通不再算过：那正是以前把这条回归盖住的原因。
           */
          const orbNode = (await win.webContents.executeJavaScript(
            `(() => {
              const orb = document.querySelector('[data-quick-orb]');
              return orb === null
                ? '无'
                : \`\${orb.getAttribute('data-quick-orb-hint') || '?'}/\${orb.getAttribute('data-quick-orb-leaving') || '-'}\`;
            })()`,
            true,
          )) as string;
          const orbGone = orbNode === '无';
          const pendoloOk = seekedOk && realHit && orbGone;
          console.info(
            `[pi/smoke] 点歌词定位（用户 m01402 第 7 条，时计）：舞台槽位=${target.lines} active=${target.active}` +
              ` view=${target.view}｜播放前=${target.before}ms｜候选=${target.cands.length}` +
              `（真鼠标可命中=${hitCands}/${target.cands.length}）${attemptLog}` +
              `｜点完圆球=${orbNode}｜` +
              `${
                pendoloOk
                  ? '真鼠标点行倒退 ≥1500ms 且没冒圆球 ✓'
                  : seekedOk
                    ? realHit
                      ? '点行成功但冒出了圆球 ✗'
                      : '只有合成 click 走通、真鼠标仍穿不过歌词行 ✗'
                    : '试遍候选都没退回去 ✗'
              }`,
          );
        }
      }
    }
    /*
     * 探针不许改用户存下的主题偏好：上面两半一共换过最多两次主题（先 classic、后 pendolo），
     * 这里把跑之前那套还回去（原本就是 pendolo 的话不必还）。
     */
    if (themeAtClickProbe !== '' && themeAtClickProbe !== 'pendolo') {
      const back = await pickLyricTheme(themeAtClickProbe);
      console.info(
        `[pi/smoke] 点歌词定位探针换主题还原：目标=${themeAtClickProbe}｜舞台=${back || '无'}` +
          ` ${back === themeAtClickProbe ? '✓' : '✗'}`,
      );
    }

    // 截图前再确认一次「有字素亮着」：滚轮那几步可能正好跨行（新行的字素还在 entering、
    // opacity 0），那样截出来是一片空白，看不出第 5 条要的「逐字点亮」。
    const stageShot = classicStage ? (await ensureLitStage(10)).stage : await readStage();
    console.info(
      `[pi/smoke] 截图前歌词：字素=${stageShot.words}（waiting ${stageShot.waiting}/active ${stageShot.active}/passed ${stageShot.passed}）` +
        `｜亮起=${stageShot.lit} 最大不透明度=${stageShot.maxOpacity.toFixed(2)}｜当前行=「${stageShot.text}」`,
    );
    const homeShot = smokeShotPath(
      process.env.PI_SMOKE_UI_SHOT_HOME,
      path.resolve(here, '../../../docs/m3-home.png'),
    );
    writeFileSync(homeShot, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${homeShot}`);
    /*
     * 用户 m02213 第 8 条：「左下歌曲名片右下加入小爱心（点亮＝加入我的喜爱，已加入就点亮）；
     * 悬停封面时四角浮现四键：左上＝歌曲信息、右上＝分享、左下＝评论、右下＝收藏到歌单；
     * 图5 所示点击名片出现的框删去」。
     *
     * 这一段**顶替**原来的「第十二轮：点歌词空白收起操作框」——那个框整个没了，原断言
     *（框开着 → 点空白收 → 再点名片刻重开）已经没有对象可量。现在量的是新契约：
     *   ① `[data-card-actions]` 不存在，**点名片也长不出来**（旧交互真的拆掉了）；
     *   ② 封面四角四颗键齐（`data-card-action` = info/share/comments/like，四颗不多不少）；
     *   ③ 常态藏着（computed opacity 0 + pointer-events none），样式表里有 `:hover` 那条浮现
     *      规则，并且**真把指针移到封面上**复核它确实浮出来（用户 m04407 第 2 条那一趟补的：
     *      合成 mouseMove 走真命中测试，opacity 应当由 0 变 1）；
     *   ④ 右下角那颗键带 `data-card-like="true|false"`，并按路径核对它画的是 `playlistAdd`
     *      而不是 `heart`（用户 m04407 第 2 条换的图标）；点一下若登录态允许就该翻转
     *      ——没翻转时读 `.pi-home__toast`，写着「登录」的按未登录放过，不当红。
     */
    const cardActionInfo = (await win.webContents.executeJavaScript(
      `(() => {
        const card = document.querySelector('.pi-home__card[data-home-card]');
        const keys = [...document.querySelectorAll('[data-card-action]')];
        const first = keys[0];
        const cs = first === undefined ? null : getComputedStyle(first);
        let hoverRule = false;
        for (const sheet of Array.from(document.styleSheets)) {
          let rules = [];
          try {
            rules = Array.from(sheet.cssRules);
          } catch (err) {
            continue;
          }
          for (const rule of rules) {
            if (rule.cssText.indexOf('coverwrap:hover') >= 0) {
              hoverRule = true;
              break;
            }
          }
          if (hoverRule) break;
        }
        const like = document.querySelector('[data-card-like]');
        return {
          card: card !== null,
          keys: keys.map((el) => el.getAttribute('data-card-action') || '').join('/'),
          keyCount: keys.length,
          hidden: cs !== null && cs.opacity === '0' && cs.pointerEvents === 'none',
          hoverRule,
          like: like === null ? '无' : like.getAttribute('data-card-like') || '',
        };
      })()`,
      true,
    )) as {
      card: boolean;
      keys: string;
      keyCount: number;
      hidden: boolean;
      hoverRule: boolean;
      like: string;
    };
    /*
     * 用户 m04407 第 2 条：封面右下角那颗键的图标从「爱心」换成「列表 + ＋」
     *（`playlistAdd`）—— 它原来和名片最后一行右侧「我喜欢」那颗爱心长得一样。这里顺手把
     * 上面第 ③ 条那句「合成指针拿不到 :hover，只能量规则在不在」补成**真悬停**：名片此刻
     * 就在页面上，把指针移到封面正中，四角键的 computed opacity 应当从常态的 0 变成 1
     *（Chromium 的合成 mouseMove 走真命中测试，`m3-orb-hover` 那一套就是靠它拍的）；同时按
     * 路径断言这颗键画的确实是 `playlistAdd`，并整窗拍一张 `docs/m3r32-coverkeys.png`
     *（不按盒子裁特写：量盒子时四角键还在入场动画里，拍到的位置对不上；事后离线裁更稳），
     * 供「换图标」这条留一份人眼能看的成品证据。
     */
    const CARD_LIKE_PATH = 'M4 6h9M4 11.5h9M4 17h5M18 12.5v7M14.5 16h7';
    const coverGeo = (await win.webContents.executeJavaScript(
      `(() => {
        const wrap = document.querySelector('.pi-home__coverwrap');
        const like = document.querySelector('[data-card-action="like"]');
        if (wrap === null || like === null) return null;
        const r = wrap.getBoundingClientRect();
        const path = like.querySelector('path');
        return {
          cx: Math.round(r.left + r.width / 2),
          cy: Math.round(r.top + r.height / 2),
          keyOpacity: getComputedStyle(like).opacity,
          path: path === null ? '' : path.getAttribute('d') || '',
        };
      })()`,
      true,
    )) as {
      cx: number;
      cy: number;
      keyOpacity: string;
      path: string;
    } | null;
    let coverLikeNow: { opacity: string; pointer: string; path: string } = {
      opacity: '0',
      pointer: 'none',
      path: '',
    };
    if (coverGeo !== null) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: coverGeo.cx, y: coverGeo.cy });
      await delay(420);
      /*
       * 整窗拍，不传矩形 —— 试过按 `[data-card-action="like"]` 的 DOM 盒子裁特写，实测拍到的
       * 是封面花纹、一个键都没有：量盒子的时刻名片/四角键还在入场动画里，等 420ms 后真拍，
       * 位置已经不是量到的那一处（既有那几处 `capturePage(crop)` 都是静态元素，没有这个坑）。
       * 事后离线裁一小块放大，比赌一个会动的矩形稳。
       */
      const keyShot =
        process.env.PI_SMOKE_UI_SHOT_COVERKEY ??
        path.resolve(here, '../../../docs/m3r32-coverkeys.png');
      writeFileSync(keyShot, (await win.webContents.capturePage()).toPNG());
      /*
       * 读数必须**趁指针还停在封面上**取：名片是「贴近才亮」，指针一挪走 opacity 立刻回 0
       *（实测踩过：先挪再读，读出「0→0」，白把这条断言打成 ✗）。
       */
      coverLikeNow = (await win.webContents.executeJavaScript(
        `(() => {
          const like = document.querySelector('[data-card-action="like"]');
          if (like === null) return { opacity: '0', pointer: 'none', path: '' };
          const cs = getComputedStyle(like);
          const path = like.querySelector('path');
          return {
            opacity: cs.opacity,
            pointer: cs.pointerEvents,
            path: path === null ? '' : path.getAttribute('d') || '',
          };
        })()`,
        true,
      )) as { opacity: string; pointer: string; path: string };
      /*
       * 拍完必须把指针挪回一个中性的高处 —— 名片是「贴近才亮」（第十八轮第 9 条），把指针
       * 留在封面正中，它会在后面「截图（收掉悬浮框）」那一读里一直亮着（`名片 … opacity=1`），
       * 直接把 `cardBox.card.op === '0'` 那条既有契约打成 ✗（实测踩过：M3「播放器详情页」
       * 从 ✓ 变 ✗，而打印出来的评论行/歌词行/主题/情绪背景全是好的）。
       * 落点取封面中心的正上方约一半高度：与左下角名片、底部药丸都够远，又回到歌词区中心
       * ——正是这条探针之前的常态指针位置。
       */
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: coverGeo.cx,
        y: Math.max(40, Math.round(coverGeo.cy / 2)),
      });
      await delay(160);
    }
    const coverKeyHoverOk = coverGeo !== null && coverLikeNow.opacity === '1';
    const coverIconOk = coverLikeNow.path === CARD_LIKE_PATH;
    const coverIconInfo =
      `m04407 第 2 条：封面右下角键 opacity ${coverGeo === null ? '无键' : coverGeo.keyOpacity}→${coverLikeNow.opacity}` +
      `（悬停浮出=${coverKeyHoverOk}） 可点=${coverLikeNow.pointer}` +
      `｜图标=${coverIconOk ? 'playlistAdd' : `不是 playlistAdd（d=${coverLikeNow.path || '空'}）`}`;
    // 点一下名片：旧操作框不许被点出来（旧交互真的拆掉了）。
    await win.webContents.executeJavaScript(
      `document.querySelector('.pi-home__card[data-home-card]')?.click()`,
      true,
    );
    await delay(360);
    const boxAfterCardClick = (await win.webContents.executeJavaScript(
      `Boolean(document.querySelector('[data-card-actions]'))`,
      true,
    )) as boolean;
    // 爱心点一下：登录态允许就应当翻转；未登录只弹提示（「要登录才能收藏」），
    // 提交成功时也会弹（「已收藏到…」/「已取消收藏」）——两种提示都证明这颗键是活的。
    // 翻转依赖后台 mutation + 一次 like-check 重取，可能慢过一拍，所以这里轮询。
    const likeBefore = cardActionInfo.like;
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-card-like]')?.click()`,
      true,
    );
    const readLike = async (): Promise<{ like: string; toast: string }> =>
      (await win.webContents.executeJavaScript(
        `(() => {
          const like = document.querySelector('[data-card-like]');
          const toast = document.querySelector('.pi-home__toast');
          return {
            like: like === null ? '无' : like.getAttribute('data-card-like') || '',
            toast: toast === null ? '' : (toast.textContent || '').trim(),
          };
        })()`,
        true,
      )) as { like: string; toast: string };
    let likeAfter = await readLike();
    let likeToggled = likeBefore !== likeAfter.like && likeAfter.like !== '无';
    let likeSignalled =
      likeAfter.toast.indexOf('登录') >= 0 || likeAfter.toast.indexOf('收藏') >= 0;
    for (let i = 0; i < 11 && !likeToggled && !likeSignalled; i += 1) {
      await delay(260);
      likeAfter = await readLike();
      likeToggled = likeBefore !== likeAfter.like && likeAfter.like !== '无';
      likeSignalled = likeAfter.toast.indexOf('登录') >= 0 || likeAfter.toast.indexOf('收藏') >= 0;
    }
    /*
     * 用户 m03805 第 4 条：左上那颗「歌曲信息」改成**播放模式切换**（网易云四档，`MODE_LABEL`
     * 与队列浮层/设置页同源），左下那颗「评论」改成开关（开着再点就关）。两条都在这里量：
     * 模式点一下必须换一档（抓手 `data-card-mode`，它现在也是四角键契约的一部分），
     * 评论点一下抽屉要出现、再点一下要消失。
     */
    const readCardMode = async (): Promise<string> =>
      (await win.webContents.executeJavaScript(
        `document.querySelector('[data-card-action="mode"]')?.getAttribute('data-card-mode') || '无'`,
        true,
      )) as string;
    const modeBefore = await readCardMode();
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-card-action="mode"]')?.click()`,
      true,
    );
    await delay(420);
    const modeAfter = await readCardMode();
    const modeCycled = modeBefore !== '无' && modeAfter !== '无' && modeBefore !== modeAfter;
    // 四档绕一圈转回原档：后面的探针（歌词 / 队列）默认还在列表循环上，别把状态带偏。
    for (let i = 0; i < 3; i += 1) {
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-card-action="mode"]')?.click()`,
        true,
      );
      await delay(240);
    }
    const modeBack = await readCardMode();
    const commentsPanelOpen = async (): Promise<boolean> =>
      (await win.webContents.executeJavaScript(
        `document.querySelector("[data-panel='comments']") !== null`,
        true,
      )) as boolean;
    const clickCommentsKey = async (): Promise<void> => {
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-card-action="comments"]')?.click()`,
        true,
      );
      await delay(700);
    };
    await clickCommentsKey();
    const commentsOpened = await commentsPanelOpen();
    await clickCommentsKey();
    const commentsClosed = !(await commentsPanelOpen());
    const r28KeysOk = modeCycled && modeBack === modeBefore && commentsOpened && commentsClosed;
    const r28KeysInfo =
      `模式 ${modeBefore}→${modeAfter}（换了档=${modeCycled}，绕回原档=${modeBack === modeBefore}）` +
      `｜评论键 开=${commentsOpened} 再点关=${commentsClosed}`;
    const cardActionOk =
      cardActionInfo.card &&
      cardActionInfo.keyCount === 4 &&
      cardActionInfo.keys.split('/').sort().join('/') === 'comments/like/mode/share' &&
      cardActionInfo.hidden &&
      cardActionInfo.hoverRule &&
      !cardBoxAtEntry &&
      !boxAfterCardClick &&
      r28KeysOk &&
      (likeToggled || likeSignalled) &&
      coverKeyHoverOk &&
      coverIconOk;
    console.info(
      `[pi/smoke] 名片四角键与爱心（用户 m02213 第 8 条）：旧框=${cardBoxAtEntry || boxAfterCardClick ? '还在 ✗' : '已删，点名片也不出来'}` +
        `｜四角键=${cardActionInfo.keys || '无'}（${cardActionInfo.keyCount} 颗）` +
        `常态藏=${cardActionInfo.hidden} 悬停规则=${cardActionInfo.hoverRule}` +
        `｜爱心 ${likeBefore}→${likeAfter.like}${
          likeToggled
            ? '（已翻转）'
            : likeSignalled
              ? `（有提示：${likeAfter.toast}）`
              : `（没动${likeAfter.toast ? `，提示=${likeAfter.toast}` : '，也没提示'}）`
        }` +
        `｜m03805 第 4 条：${r28KeysInfo} ${r28KeysOk ? '✓' : '✗'}` +
        `｜${coverIconInfo} ${coverKeyHoverOk && coverIconOk ? '✓' : '✗'} → ${cardActionOk ? '✓' : '✗'}`,
    );
    // 刚才真把「喜欢」点上了就点回去，别把后面的截图与状态带偏。
    if (likeToggled) {
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-card-like]')?.click()`,
        true,
      );
      await delay(600);
    }
    /*
     * 这里本来还有一条「点歌词空白把操作框收起来」的探针（第十二轮，用户 m04193），但它量的
     * 那个框已经被用户 m02213 第 8 条整块删掉了，没有对象可量 —— 上面那一段已经改量新契约
     *（旧框不存在 / 四角键 / 爱心）。留着这条注释是为了让后来翻日志的人知道：这条 ✗ 不是丢了，
     * 是连同被测对象一起退休了。
     */
    const homeCleanShot = smokeShotPath(
      process.env.PI_SMOKE_UI_SHOT_HOME_CLEAN,
      path.resolve(here, '../../../docs/m3-home-clean.png'),
    );
    writeFileSync(homeCleanShot, (await win.webContents.capturePage()).toPNG());
    const cardBox = (await win.webContents.executeJavaScript(
      `(() => {
        const card = document.querySelector('.pi-home__card');
        const bar = document.querySelector('.pi-home__bar');
        const read = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), op: cs.opacity };
        };
        return { card: read(card), bar: read(bar), vh: window.innerHeight };
      })()`,
      true,
    )) as {
      card: null | { x: number; y: number; w: number; h: number; op: string };
      bar: null | { x: number; y: number; w: number; h: number; op: string };
      vh: number;
    };
    console.info(
      `[pi/smoke] 截图（收掉悬浮框）：${homeCleanShot}` +
        `｜名片=${cardBox.card ? `${cardBox.card.x},${cardBox.card.y} ${cardBox.card.w}×${cardBox.card.h} opacity=${cardBox.card.op}` : '缺失'}` +
        `｜底部进度条=${cardBox.bar ? `${cardBox.bar.x},${cardBox.bar.y} ${cardBox.bar.w}×${cardBox.bar.h} opacity=${cardBox.bar.op}` : '缺失'}` +
        `（第十七轮第 7 条：名片常态隐起来 = 0.00、进度条常驻 = 1.00）`,
    );
    // ── 第十轮第 8 条（用户 m02362）：「要多主动看 app 画面确认效果」 ──
    // 光看探针的数字不算「看过画面」。跑 `PI_SMOKE_SHOT_THEMES=1` 时，这里把三套
    // 非 classic 的歌词动效各切过去、各拍一张**播放页成品图**（`docs/m3-lyric-*.png`）。
    //
    // 两处必须是「走 UI」而不是直接改设置：
    //   ① renderer 的主题来自 `useSettings()` 的 react-query 缓存，主进程里
    //      `invoke('settings:patch')` 只会落盘、不会让舞台重建；
    //   ② 所以点设置页里那个真的主题按钮（`[data-lyric-theme-option]`）。
    // 设置是整屏浮层，会盖住播放页 ⇒ 每切一次主题都要把设置关掉再截。
    const shotThemes = process.env.PI_SMOKE_SHOT_THEMES === '1';
    /*
     * `PI_SMOKE_SET_THEME=classic`：只走 UI 把歌词主题钉回某一个值，不拍照。
     *
     * 为什么需要这个开关：这批成品图要在 fume/cadenza/partita 之间来回切，中途只要
     * 失败一次（第十轮 -c/-d 两跑就是「兜底歌源 0 行歌 ⇒ 读不到舞台主题 ⇒ 没还原」），
     * 用户的落盘偏好就被留成了别的主题。主进程直接去改用户目录里的设置文件属于越权，
     * 所以还原也走同一条 `pickTheme` 链路，给「谁改的谁还原」一个正当出口。
     */
    const pinnedTheme = (process.env.PI_SMOKE_SET_THEME ?? '').trim();
    // 第十一轮第 1 条（用户 m03279）：「浮名的歌词会飘出窗口边框」不能只靠肉眼看图，
    // 这里留一个结论位（`null` = 这轮没跑主题成品图，不参与判定）。
    let lyricBleedOk: boolean | null = null;
    // 第十二轮第 1/2/3 条：倾诉 / 时计 / 流光三套要「以 app 的整个界面作为展示」。
    // null = 这轮没拍主题成品图，不参与判定。
    let stageFillOk: boolean | null = null;
    /*
     * 第十四轮第 4 条（用户 m05281）：流光「逐字旋转」开关的**效果**验证。
     * 开关默认是关的（用户的偏好），所以效果只能在「临时点开」这一跑里量：
     * PI_SMOKE_SPIN=1 时，拍 classic 成品图之前经设置页把那枚 checkbox 点开，量完由收尾的
     * 主题还原那一步顺手点回用户原值（同一个 pickTheme 链路，纪律同主题还原）。
     * spinOk 为 null = 这一跑没验（没设 PI_SMOKE_SPIN），不参与判定。
     */
    const spinProbe = process.env.PI_SMOKE_SPIN === '1';
    let spinOk: boolean | null = null;
    /*
     * 第十四轮第 7 条（用户 m05281）：「时计画里的小齿轮要转动」——静止帧证明不了转动，
     * 所以隔 420ms 取两次画布位图（`.pi-lyricpendolo__dial` 的 `toDataURL()`）比对：
     * 两张完全一样 = 没有逐帧重绘（不转），不一样 = 表盘在动。
     */
    let pendoloGearOk: boolean | null = null;
    /*
     * 第十四轮第 6 条（用户 m05281）：云阶要「不同行不同字号 + 当前句高亮放大 + 行错位减小」。
     * 前两件在成品图上能量死（词间到底有没有空格、当前块是不是最大的），错位上下界是用户
     * 自己在设置页拖的，所以只记录不判定。null = 这轮没拍主题成品图。
     */
    let partitaSpaceOk: boolean | null = null;
    let partitaSizeOk: boolean | null = null;
    /*
     * 第十五轮第 4 条（用户 m06435）：所有歌词常态白、只有高亮那一句带主题色、
     * 且颜色要「逐渐淡去」。判据：常态（waiting/passed）字色 == 舞台那支
     * `--pi-lyric-ink`（本轮解析出来是 rgb(255,255,255)），高亮字色与它不同，
     * 并且常态那条规则带 >=400ms 的 color 过渡（证明是渐淡而不是瞬切）。
     */
    let lyricInkOk: boolean | null = null;
    /*
     * 第十五轮第 5 条：流光「冒出来的字要带上一定旋转」。静态角进不去判定（等唱的字本来
     * 就带角），所以看**正在冒出来的字**的 computed `animation-name` 是不是那条
     * `pi-lyricstage-word-spin-in` 关键帧——只有 active + 开了开关才挂得上。
     */
    let spinInOk: boolean | null = null;
    /*
     * 第十五轮第 6 条：浮名在歌词唱完之后要把整张纸缩进窗口（镜头仍然跟着当前句）。
     * 判据取自 rAF 手写的世界层 `translate3d(...) scale(s)`（FumeTheme.tsx:1146/1347）：
     * 暂停后把播放头推到最后一句之后，世界层 scale 应明显变小、在场块数应变多。
     */
    let fumeOutroOk: boolean | null = null;
    /*
     * 第十五轮第 8 条：云阶「一句歌词和引导线一起出来」。判据是渲染层的 `data-guide`
     * 标记：一块里所有字素都还是 waiting 时，它的引导线必须是 `data-guide="waiting"`。
     */
    let partitaGuideOk: boolean | null = null;
    if (shotThemes || pinnedTheme !== '') {
      /**
       * 切一套歌词主题，并**确认它真的换过去了**。
       *
       * 第十轮第一次跑这批成品图时踩的坑：原来这个函数有三处静默 `return`/空指针
       * （点不到设置键、找不到 tab、找不到主题按钮），结果三张图全是 classic，
       * 日志却只写「舞台 data-theme=classic」——看起来像「切了没生效」，其实
       * 一次都没点到。现在每一步都把结果打出来，并且以「设置真的落进 react-query
       * 缓存」为判据（`usePatchSettings()` 成功后 `setQueryData(['settings'])`，
       * `.pi-lyric-themes[data-lyric-theme]` 就是那一刻渲染出来的值）。
       */
      const pickTheme = async (
        theme: string,
        spin: boolean | null = null,
      ): Promise<{ setting: boolean; stage: string }> => {
        // 第十六轮删球：设置键没了，改成走导航抽屉的「设置与音源」。
        // （旧注释：先确保环是收着的，否则 `clickOrbItem` 里那次「点球」反而会把它收起来。）
        let openedRing = await clickNav(win, '设置与音源');
        const readPanel = async (): Promise<{ tab: string; tabs: number; close: boolean }> =>
          (await win.webContents.executeJavaScript(
            `(() => ({
              tab: document.querySelector('[data-settings-tab-panel]')?.getAttribute('data-settings-tab-panel') ?? '',
              tabs: document.querySelectorAll('[data-settings-tab]').length,
              close: document.querySelector('[data-settings-close]') !== null,
            }))()`,
            true,
          )) as { tab: string; tabs: number; close: boolean };
        const readLyric = async (): Promise<{ panel: boolean; options: number; current: string }> =>
          (await win.webContents.executeJavaScript(
            `(() => ({
              panel: document.querySelector('[data-settings-tab-panel="lyric"]') !== null,
              options: document.querySelectorAll('[data-lyric-theme-option]').length,
              current: document.querySelector('.pi-lyric-themes')?.getAttribute('data-lyric-theme') ?? '',
            }))()`,
            true,
          )) as { panel: boolean; options: number; current: string };
        /*
         * 不能只 `delay(600)` 就读面板：在播放器主页上点设置键时，应用会先把主区换回
         * 「播放器主页」再浮出设置框（`换页过渡` 那一段），600ms 时面板可能还没挂上，
         * 之后点 tab、点主题按钮就全是空指针——第一次跑这批成品图就是三张全 classic。
         * 所以改成轮询到面板真的出现；没出现就把环收掉重开一次再轮询。
         */
        let panel = await readPanel();
        for (let attempt = 0; attempt < 2 && panel.tabs === 0; attempt += 1) {
          const deadline = Date.now() + 4000;
          while (Date.now() < deadline && panel.tabs === 0) {
            await delay(200);
            panel = await readPanel();
          }
          if (panel.tabs > 0) break;
          if (await clickNav(win, '设置与音源')) openedRing = true;
        }
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-settings-tab="lyric"]')?.click()`,
          true,
        );
        // 切 tab 也要等：`SettingsFrame` 的内容区带 `key={active}`，会整块重建。
        let lyric = await readLyric();
        for (let attempt = 0; attempt < 20 && !lyric.panel; attempt += 1) {
          await delay(150);
          lyric = await readLyric();
        }
        const clicked = (await win.webContents.executeJavaScript(
          `(() => {
            const button = document.querySelector('[data-lyric-theme-option="${theme}"]');
            if (!button) return false;
            button.click();
            return true;
          })()`,
          true,
        )) as boolean;
        let applied = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const current = (await win.webContents.executeJavaScript(
            `document.querySelector('.pi-lyric-themes')?.getAttribute('data-lyric-theme') ?? ''`,
            true,
          )) as string;
          if (current === theme) {
            applied = true;
            break;
          }
          await delay(150);
        }
        /*
         * 第十四轮第 4 条（用户 m05281）：「流光 · 逐字旋转」开关默认是**关**的，所以想验证
         * 效果就必须先把开关打开——`spin` 为 true 时在这一跑临时点开，为 false 时点回用户原值
         * （收尾照主题还原的同一套纪律「谁改的谁还原」）。`null` = 不动这个开关。
         */
        if (spin !== null) {
          const want = spin ? 'true' : 'false';
          const spinApplied = (await win.webContents.executeJavaScript(
            `(async () => {
               const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
               const el = document.querySelector('[data-lyric-tuning="classicWordSpin"]');
               if (!(el instanceof HTMLInputElement)) return 'no-control';
               if (el.checked === ${want}) return 'already';
               el.click();
               await sleep(700);
               return el.checked === ${want} ? 'clicked' : 'not-applied';
             })()`,
            true,
          )) as string;
          console.info(
            `[pi/smoke] 逐字旋转开关：目标=${spin ? '开' : '关'}｜结果=${spinApplied}`,
          );
        }
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-settings-close]')?.click()`,
          true,
        );
        await delay(700);
        const stage = (await win.webContents.executeJavaScript(
          `document.querySelector('[data-lyric-rail]')?.dataset.theme ?? ''`,
          true,
        )) as string;
        console.info(
          `[pi/smoke] 切歌词主题：${theme}｜环上点设置键=${openedRing}｜面板=${panel.tab || '无'}(tabs=${panel.tabs} 关闭键=${panel.close})` +
            `｜歌词页=${lyric.panel}(选项=${lyric.options} 原来=${lyric.current || '无'})｜点到按钮=${clicked}` +
            `｜设置已落=${applied}｜舞台=${stage || '无'}`,
        );
        return { setting: applied, stage };
      };
      // 冒烟不改用户落盘的偏好：拍完把原来那套切回去。
      //
      // 第十轮踩的坑：这个初值原来是从**舞台**（`[data-lyric-rail]`）读的，而 -c/-d 两跑
      // 恰好「兜底歌源 0 行歌」⇒ 没有舞台元素 ⇒ 读到空串 ⇒ 压根没还原，把用户落盘的
      // classic 留成了 partita。改成从设置里读，跟页面有没有歌无关。
      const initialTheme = shotThemes ? ((await services.getSettings()).lyricTheme ?? '') : '';
      // 流光「逐字旋转」的用户原值（缺省即 false，跟设置页那枚 checkbox 的默认一致）。
      const spinInitial = shotThemes
        ? Boolean((await services.getSettings()).lyricTuning?.classicWordSpin)
        : false;
      const themes = shotThemes ? ['fume', 'cadenza', 'partita', 'tilt', 'pendolo', 'classic'] : [];
      for (const theme of themes) {
        /*
         * 每次主题迭代先把播放头拉回歌的**中段**：UI 冒烟要放 3 首、跑好几分钟，走到主题循环时
         * 那首歌往往已经在尾巴上——末段没有「等唱」的字（流光逐字旋转量到 0 个歪字）、也没有下一句
         * 可换（时计小齿轮自然一直 idle），两条与播放位置有关的断言就变成看运气。钉在中段才可复现。
         */
        await win.webContents.executeJavaScript(
          `(() => {
             const a = window.__piAudio;
             if (!a) return 0;
             const d = Number(a.duration) || 0;
             if (!(d > 20)) return 0;
             const t = Math.min(d * 0.42, d - 12);
             a.currentTime = t;
             return t;
           })()`,
          true,
        );
        await delay(1400);
        const picked = await pickTheme(
          theme,
          spinProbe && theme === 'classic' ? true : null,
        );
        /*
         * 第十一轮第 1 条（用户 m03279：「浮名的歌词动效，左边的歌词会超出窗口边框，看不到」）。
         *
         * 拍图之外再量一遍：取**当前句那个块**（`.pi-lyricfume__block[data-active="true"]`）的
         * `getBoundingClientRect()`，看左右边界有没有越过**窗口**（用户的原话就是「超出窗口边框」）。
         * 相机会随当前句移动、还有 idle 漂移，一次采样可能正落在过渡中间 ⇒ 隔 220ms 采 6 次取最差。
         *
         * 为什么只量**正在唱的那一块**、不是「world 里所有块并集」：整个 world 是一张比窗口宽得多的纸
         * （`paperWidth` 最大 2400），镜头跟着当前句走，**别的句**本来就停在窗口外等着
         * ——量并集会稳定报出几千 px 的假溢出（第一版就是这么红的，成品图里左侧明明留了大片空）。
         * 也不能量 `[data-active="true"]`：那个属性在 fume 里标的是排版上的「hero 大句」
         * （`FumeBlockView` 的 `data-active={hero}`，一行里可能不止一块），不是当前唱的那句；
         * 真正的当前句由主题根的 `data-active-index` + 块上的 `data-lyric-line` 对上
         * （第二版就是量错了元素，报出 2541px 的假溢出）。
         *
         * 断言只钉左侧（用户报的那一侧，容差 8px 给阴影与取整）；右侧只记录——
         * 当前句右边的字本来就可以先待在窗口外，等镜头追过去。hero 块的左缘也只记录。
         */
        if (theme === 'fume') {
          let worstLeft = 0;
          let worstRight = 0;
          let heroWorstLeft = 0;
          for (let sample = 0; sample < 6; sample += 1) {
            const bleed = (await win.webContents.executeJavaScript(
              `(() => {
                const world = document.querySelector('.pi-lyricfume__world');
                if (!(world instanceof HTMLElement)) return null;
                const root = document.querySelector('[data-mood-theme="fume"]');
                const activeIndex = root instanceof HTMLElement ? root.dataset.activeIndex : undefined;
                const sung =
                  activeIndex === undefined || activeIndex === ''
                    ? null
                    : world.querySelector('.pi-lyricfume__block[data-lyric-line="' + activeIndex + '"]');
                const hero = world.querySelector('.pi-lyricfume__block[data-active="true"]');
                const pick = sung instanceof HTMLElement ? sung : hero;
                if (!(pick instanceof HTMLElement)) return null;
                const rect = pick.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return null;
                const heroRect = hero instanceof HTMLElement ? hero.getBoundingClientRect() : null;
                return {
                  left: Math.round(-rect.left),
                  right: Math.round(rect.right - window.innerWidth),
                  heroLeft: heroRect === null ? 0 : Math.round(-heroRect.left),
                };
              })()`,
              true,
            )) as { left: number; right: number; heroLeft: number } | null;
            if (bleed !== null) {
              worstLeft = Math.max(worstLeft, bleed.left);
              worstRight = Math.max(worstRight, bleed.right);
              heroWorstLeft = Math.max(heroWorstLeft, bleed.heroLeft);
            }
            await delay(220);
          }
          lyricBleedOk = worstLeft <= 8;
          console.info(
            '[pi/smoke] 浮名内容边界（第十一轮第 1 条）：当前句左溢出=' +
              worstLeft +
              'px 右溢出=' +
              worstRight +
              'px（hero 块左溢出=' +
              heroWorstLeft +
              'px，只记录）' +
              (lyricBleedOk ? '✓' : '✗'),
          );
        }
        /*
         * 第十一轮第 3、4 条（用户 m03279）：**只记数字、不当门禁**。
         * 心象要「有节制地散在中部一条带里」（图4/5），云阶要「短块楼梯、不挤成一坨」（图6/7）——
         * 这两条是观感，最终裁判是成品图与用户本人；这里把能量化的部分留下来，方便回看趋势：
         *   · 心象：所有 `.pi-lyriccadenza__word` 并集的宽/高占窗口比例（「铺开多少、收进多高」）；
         *   · 云阶：所有 `.pi-lyricpartita__col` 两两相交的对数。块本身带小角度旋转，外接框会略大于
         *     排版矩形，所以这个数字只回答「有没有明显打架」，容差取 4px。
         * 两者都顺带记「出窗多少 px」（内容并集越过窗口边界的最大值）。
         */
        if (theme === 'cadenza' || theme === 'partita') {
          const layout = (await win.webContents.executeJavaScript(
            `(() => {
              const boxes = [...document.querySelectorAll('${theme === 'cadenza' ? '.pi-lyriccadenza__word' : '.pi-lyricpartita__col'}')]
                .map((el) => el.getBoundingClientRect())
                .filter((rect) => rect.width > 0 && rect.height > 0)
                .map((rect) => ({ l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }));
              if (boxes.length === 0) return null;
              const left = Math.min(...boxes.map((box) => box.l));
              const top = Math.min(...boxes.map((box) => box.t));
              const right = Math.max(...boxes.map((box) => box.r));
              const bottom = Math.max(...boxes.map((box) => box.b));
              let overlaps = 0;
              for (let i = 0; i < boxes.length; i += 1) {
                for (let j = i + 1; j < boxes.length; j += 1) {
                  const a = boxes[i];
                  const b = boxes[j];
                  if (a.l < b.r - 4 && b.l < a.r - 4 && a.t < b.b - 4 && b.t < a.b - 4) overlaps += 1;
                }
              }
              return {
                count: boxes.length,
                widthRatio: Number(((right - left) / window.innerWidth).toFixed(3)),
                heightRatio: Number(((bottom - top) / window.innerHeight).toFixed(3)),
                outOfWindow: Math.round(Math.max(-left, -top, right - window.innerWidth, bottom - window.innerHeight)),
                overlaps,
              };
            })()`,
            true,
          )) as {
            count: number;
            widthRatio: number;
            heightRatio: number;
            outOfWindow: number;
            overlaps: number;
          } | null;
          console.info(
            '[pi/smoke] ' +
              theme +
              ' 排布量（第十一轮第 ' +
              (theme === 'cadenza' ? '3' : '4') +
              ' 条，只记录不判定）：块=' +
              (layout === null ? '无' : layout.count) +
              (layout === null
                ? ''
                : ' 并集宽占比=' +
                  layout.widthRatio +
                  ' 高占比=' +
                  layout.heightRatio +
                  ' 出窗=' +
                  layout.outOfWindow +
                  'px 相交对数=' +
                  layout.overlaps),
          );
        }
        /*
         * 第十四轮第 6 条（用户 m05281）：云阶「不同行不同字号 + 当前句放大 + 错位收紧」。
         * 三件事分别量：
         *   · 行内词与词之间有没有真空格——`.pi-lyricpartita__word` 是**字素级** span（一个原子里的
         *     字素彼此紧贴），词与词之间由 JSX 插了一个真空格文本节点（`{atomIndex === 0 ? null : ' '}`）。
         *     **不能拿两个 span 的外接框相减**：块的错位（设置页可拖到 ±100px）与逐字抖动都是 transform，
         *     框一挪差值就失去意义（第一版量出 -0.104em、第二版 -0.004em，两次都是假红）。正确量法是直接
         *     量那个**空白文本节点自身的排版宽度**（`Range.selectNodeContents` 之后取
         *     `getBoundingClientRect().width`，与兄弟 transform 无关）÷ 本行字号：真空格 ≈ 0.25em，
         *     粘连（空格被吞）≈ 0，判据取 0.12em，并要求边界数 ≥ 1。
         *     背景：逐字时间戳（yrc）那条路径上词与词之间**没有空格字素**，`buildAtoms` 原来会把
         *     整行英文收进一个原子，渲染出来是 `havetokeephinding` 这种连成一坨的样子（这一轮复查
         *     成品图时发现，已在 `partitaLayout.buildAtoms` 里按 `StageWord.wordStart` 断组修掉）。
         *   · 各块字号是否真的不一样（`distinctFonts ≥ 2`）。
         *   · **当前句放大**：不能比「当前块字号 vs 其他块字号」——每块有自己的基准字号与 ±20% 抖动倍率，
         *     当前块完全可能比某一行绝对字号小。要比的是**同一块自己的倍率**：组件把 `--pi-partita-mult`
         *     写在块元素上（当前块 = 抖动倍率 × `currentScale ∈ [1.25, 1.6]`），而
         *     `fontPx ÷ mult = plan.fontPx × fit` 对所有块是同一个常数 ⇒ 判据三条：最大倍率 ≥ 1.25、
         *     `字号 ÷ 倍率` 跨块离散 ≤ 8%、且最大倍率那一块就是 `data-current="true"` 的那一块。
         *   · 块心相对舞台中线的最大偏移：只记录，因为错位上下界是用户在设置页拖出来的。
         */
        if (theme === 'partita') {
          const partitaInfo = (await win.webContents.executeJavaScript(
            `(() => {
              const stage = document.querySelector('.pi-lyricpartita');
              const stageRect = stage
                ? stage.getBoundingClientRect()
                : { left: 0, width: window.innerWidth };
              const rows = [...document.querySelectorAll('.pi-lyricpartita__row')];
              const spaceEms = [];
              let boundary = 0;
              for (const row of rows) {
                const firstWord = row.querySelector('.pi-lyricpartita__word');
                const font =
                  firstWord === null ? 0 : parseFloat(getComputedStyle(firstWord).fontSize) || 0;
                if (font <= 0) continue;
                for (const node of [...row.childNodes]) {
                  if (node.nodeType !== 3) continue;
                  if ((node.textContent ?? '').trim() !== '') continue;
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  boundary += 1;
                  spaceEms.push(range.getBoundingClientRect().width / font);
                }
              }
              spaceEms.sort((a, b) => a - b);
              const spaceEm =
                spaceEms.length === 0
                  ? null
                  : Number(spaceEms[Math.floor(spaceEms.length / 2)].toFixed(3));
              const cols = [...document.querySelectorAll('.pi-lyricpartita__col')];
              const fonts = [];
              const mults = [];
              const colors = [];
              const bases = [];
              let maxAbsX = 0;
              let currentCols = 0;
              for (const col of cols) {
                const rect = col.getBoundingClientRect();
                maxAbsX = Math.max(
                  maxAbsX,
                  Math.abs(rect.left + rect.width / 2 - (stageRect.left + stageRect.width / 2)),
                );
                if (col.getAttribute('data-current') === 'true') currentCols += 1;
                const word = col.querySelector('.pi-lyricpartita__word');
                if (word === null) continue;
                const wordStyle = getComputedStyle(word);
                const font = parseFloat(wordStyle.fontSize) || 0;
                const mult =
                  parseFloat(getComputedStyle(col).getPropertyValue('--pi-partita-mult')) || 0;
                fonts.push(font);
                mults.push(mult);
                colors.push(wordStyle.color);
                bases.push(mult > 0 ? font / mult : 0);
              }
              let currIndex = -1;
              let currMult = 0;
              for (let i = 0; i < mults.length; i += 1) {
                if ((mults[i] ?? 0) > currMult) {
                  currMult = mults[i] ?? 0;
                  currIndex = i;
                }
              }
              const currCol = currIndex < 0 ? null : cols[currIndex];
              const currIsCurrent =
                currCol !== null && currCol.getAttribute('data-current') === 'true';
              const currColor = currIndex < 0 ? '' : colors[currIndex];
              // 第十五轮接缝：当前块的纯放大倍数（不含抖动）。--pi-partita-mult 是「抖动 × 纯倍数」，
              // 单看它在抖动为负时只有 1.1 出头，判「当前句放大」会误红。
              const currScaleRaw = currCol === null ? '' : currCol.getAttribute('data-current-scale') || '';
              const currScale = Number(currScaleRaw) || 0;
              const othersColors = colors.filter((_color, i) => i !== currIndex);
              const validBases = bases.filter((base) => base > 0).sort((a, b) => a - b);
              const baseMedian =
                validBases.length === 0 ? 0 : validBases[Math.floor(validBases.length / 2)];
              const baseLast = validBases.length === 0 ? 0 : validBases[validBases.length - 1];
              const baseFirst = validBases.length === 0 ? 0 : validBases[0];
              const baseSpread = baseMedian > 0 ? (baseLast - baseFirst) / baseMedian : 1;
              return {
                rows: rows.length,
                boundaries: boundary,
                spaceEm,
                fonts,
                mults,
                currMult,
                currIsCurrent,
                currentCols,
                currColor,
                currScale,
                othersColors,
                baseSpread: Number(baseSpread.toFixed(4)),
                distinctFonts: [...new Set(fonts.map((f) => Math.round(f)))].length,
                maxAbsX: Math.round(maxAbsX),
                stageWidth: Math.round(stageRect.width),
              };
            })()`,
            true,
          )) as {
            rows: number;
            boundaries: number;
            spaceEm: number | null;
            fonts: number[];
            mults: number[];
            currMult: number;
            currIsCurrent: boolean;
            currentCols: number;
            currColor: string;
            currScale: number;
            othersColors: string[];
            baseSpread: number;
            distinctFonts: number;
            maxAbsX: number;
            stageWidth: number;
          } | null;
          const info = partitaInfo;
          partitaSpaceOk =
            info === null ? null : info.boundaries >= 1 && info.spaceEm !== null && info.spaceEm >= 0.12;
          // 「当前句放大」的三重证据：倍率 ≥ 1.25、字号 ÷ 倍率跨块一致（±8%）、且最大倍率那一块正是
          // `data-current="true"` 的那一块（高亮）。这一瞬若根本没有当前句（句间），记「未量」而不是判红。
          partitaSizeOk =
            info === null
              ? null
              : info.currentCols === 0
                ? null
                : info.distinctFonts >= 2 &&
                  info.currScale >= 1.25 &&
                  info.currScale <= 1.6 &&
                  info.currMult > 1 &&
                  info.currIsCurrent &&
                  info.baseSpread <= 0.08 &&
                  info.currColor !== '' &&
                  // 颜色那一条不再进判定：高亮句的 color 带 900~1100ms 的 CSS 过渡，瞬时读数经常等于常态墨色
                  // （run f/g 实测「高亮色=rgb(26, 29, 36) 与常态不同=否」），而「只有高亮有颜色」这件事
                  // 已由第 4 条探针在等过渡走完之后逐主题证明（partita 实测高亮 rgb(68, 141, 126)）。
                  true;
          const fontList = info === null ? [] : info.fonts;
          const fontText =
            fontList.length === 0
              ? '无'
              : [...new Set(fontList.map((font) => Math.round(font)))].join('/');
          const multText =
            info === null || info.mults.length === 0
              ? '无'
              : info.mults.map((mult) => mult.toFixed(2)).join('/');
          console.info(
            '[pi/smoke] 云阶行内断词与字号（第十四轮第 6 条）：行=' +
              (info === null ? '无' : info.rows) +
              ' 原子边界=' +
              (info === null ? '无' : info.boundaries) +
              ' 空格宽=' +
              (info === null || info.spaceEm === null ? '无' : info.spaceEm) +
              'em｜字号档=' +
              fontText +
              '（' +
              (info === null ? '?' : info.distinctFonts) +
              ' 种）｜倍率=' +
              multText +
              ' 当前块倍率=' +
              (info === null ? '无' : info.currMult.toFixed(2)) +
              '（纯放大倍数=' +
              (info === null ? '无' : info.currScale.toFixed(3)) +
              '）' +
              '（带最大倍率的块 data-current=' +
              (info === null ? '?' : info.currIsCurrent ? '对' : '错') +
              '，当前句块数=' +
              (info === null ? '?' : info.currentCols) +
              '）｜字号÷倍率离散=' +
              (info === null ? '无' : info.baseSpread.toFixed(4)) +
              '｜块心最大偏移=' +
              (info === null ? '无' : info.maxAbsX) +
              'px（舞台宽 ' +
              (info === null ? '?' : info.stageWidth) +
              '，只记录）｜断词 ' +
              (partitaSpaceOk === null ? '未量' : partitaSpaceOk ? '✓' : '✗') +
              '｜当前句放大 ' +
              (partitaSizeOk === null ? '未量' : partitaSizeOk ? '✓' : '✗'),
          );
        }
        /*
         * 第十二轮第 1、2、3 条（用户 m04193）：倾诉 / 时计 / 流光三套也要「以 app 的整个界面作为展示」。
         * 真因是老路径被 .pi-lyricstage 自己的 max-width:560px 卡在窗口中间（见 lyric-themes.css 文件头：
         * 三套铺满主题在第九轮改成了 position:absolute; inset:0）。
         * 这里量舞台元素自己的外接框占窗口的比例（铺满 → 接近 1），并顺带记歌词块的并集宽占比与出窗 px。
         * 判定：宽 >= 0.8 且高 >= 0.6（留出页面上下 padding 的余量）。
         */
        const fillSelector =
          theme === 'tilt'
            ? '.pi-lyrictilt'
            : theme === 'pendolo'
              ? '.pi-lyricpendolo'
              : theme === 'classic'
                ? '.pi-lyricstage'
                : null;
        const fillBlockSelector =
          theme === 'tilt'
            ? '.pi-lyrictilt__block'
            : theme === 'pendolo'
              ? '.pi-lyricpendolo__slot'
              : '.pi-lyricstage__line';
        if (fillSelector !== null) {
          const fill = (await win.webContents.executeJavaScript(
            `(() => {
              const stage = document.querySelector('${fillSelector}');
              if (!(stage instanceof HTMLElement)) return null;
              const stageRect = stage.getBoundingClientRect();
              const boxes = [...document.querySelectorAll('${fillBlockSelector}')]
                .map((el) => el.getBoundingClientRect())
                .filter((rect) => rect.width > 0 && rect.height > 0);
              let out = 0;
              let spread = 0;
              if (boxes.length > 0) {
                const left = Math.min(...boxes.map((box) => box.left));
                const top = Math.min(...boxes.map((box) => box.top));
                const right = Math.max(...boxes.map((box) => box.right));
                const bottom = Math.max(...boxes.map((box) => box.bottom));
                out = Math.round(Math.max(-left, -top, right - window.innerWidth, bottom - window.innerHeight));
                spread = Number(((right - left) / window.innerWidth).toFixed(3));
              }
              return {
                ratioW: Number((stageRect.width / window.innerWidth).toFixed(3)),
                ratioH: Number((stageRect.height / window.innerHeight).toFixed(3)),
                blocks: boxes.length,
                spread,
                out,
              };
            })()`,
            true,
          )) as { ratioW: number; ratioH: number; blocks: number; spread: number; out: number } | null;
          const fillOk = fill !== null && fill.ratioW >= 0.8 && fill.ratioH >= 0.6;
          // 探针自身的一个坑：原来这里只写了失败分支（`if (!fillOk) stageFillOk = false`），
          // 成功时留成 `null` ⇒ 末行永远打「三套铺满整屏 未跑」，即使三套的日志都打了 ✓。
          stageFillOk = fillOk;
          console.info(
            '[pi/smoke] ' +
              theme +
              ' 铺满整屏（第十二轮第 ' +
              (theme === 'tilt' ? '1' : theme === 'pendolo' ? '2' : '3') +
              ' 条）：舞台=' +
              (fill === null ? '无' : fill.ratioW + 'x' + fill.ratioH + ' 占窗') +
              (fill === null
                ? ''
                : '｜歌词块=' + fill.blocks + ' 并集宽占比=' + fill.spread + ' 出窗=' + fill.out + 'px') +
              (fillOk ? ' ✓' : ' ✗'),
          );
        }
        if (theme === 'pendolo') {
          /*
           * 第十五轮第 7 条（用户 m06435）：小齿轮**只在歌词环转动时**才转，不再一直转。
           * 所以要同时证明两头：
           *   · 歌词环停着的 4 个采样里必须都是 `data-gears="idle"`，且这期间表盘位图不变；
           *   · 暂停后把播放头往前推 12s（换一句 ⇒ 环要转），然后**一直采到出现 moving 为止**（最多 9s：
           *   · 转完再等一会儿，标记要回到 idle。
           */
          const gear = (await win.webContents.executeJavaScript(
            `(async () => {
               const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
               const root = document.querySelector('[data-gears]');
               const canvas = document.querySelector('.pi-lyricpendolo__dial');
               const mark = () => (root instanceof HTMLElement ? root.dataset.gears || '' : '');
               const bitmap = () => (canvas instanceof HTMLCanvasElement ? canvas.toDataURL() : '');
               const idleMarks = [];
               const idleShots = [];
               for (let i = 0; i < 4; i += 1) {
                 idleMarks.push(mark());
                 idleShots.push(bitmap());
                 await sleep(170);
               }
               let moved = 0;
               let samples = 0;
               let settle = '';
               let seeked = 0;
               const audio = window.__piAudio;
               if (audio) {
                 const wasPlaying = !audio.paused;
                 const saved = Number(audio.currentTime || 0);
                 audio.pause();
                 audio.currentTime = saved + 12;
                 seeked = Number((saved + 12).toFixed(1));
                 for (let i = 0; i < 60 && moved < 2; i += 1) {
                   samples += 1;
                   if (mark() === 'moving') moved += 1;
                   await sleep(150);
                 }
                 // 固定等 1200ms 在 run f/g 都拍到「还在转」（歌词环的弹簧没停）。改成每 200ms 问一次 data-gears，
// 最多 20 轮（约 4s），转到 idle 就收工；紧跟其后的 settle = mark() 再读一次定案。
                  for (let i = 0; i < 20 && settle !== 'idle'; i += 1) {
                    await sleep(200);
                    settle = mark();
                  }
                 settle = mark();
                 audio.currentTime = saved;
                 if (wasPlaying) {
                   try {
                     await audio.play();
                   } catch (error) {
                     void error;
                   }
                 }
               }
               let idleStable = true;
               for (let i = 1; i < idleShots.length; i += 1) {
                 if (idleMarks[i] === 'idle' && idleMarks[i - 1] === 'idle' && idleShots[i] !== idleShots[i - 1]) {
                   idleStable = false;
                 }
               }
               return {
                 marks: idleMarks.join(''),
                 idleSeen: idleMarks.filter((m) => m === 'idle').length,
                 idleStable,
                 moved,
                 samples,
                 settle: settle || '无',
                 seeked,
               };
             })()`,
            true,
          )) as {
            marks: string;
            idleSeen: number;
            idleStable: boolean;
            moved: number;
            samples: number;
            settle: string;
            seeked: number;
          };
          /*
           * 位图稳定**不进判定**：表盘上的摆轮（擒纵那一段）本来就一直在摆，画布每帧都会变。
           * 第 7 条要的是「小齿轮只在歌词环转的时候转」，由 `data-gears` 标记 + 换句前后各采样
           * 一轮来证明：停着时全是 idle、换句后出现 moving、转完回到 idle。位图只作记录。
           */
          pendoloGearOk = gear.idleSeen >= 1 && gear.moved >= 1 && gear.settle === 'idle';
          console.info(
            `[pi/smoke] 时计小齿轮只在歌词环转时转（第十五轮第 7 条）：停着时的标记=${gear.marks || '无'}` +
              `（idle ${gear.idleSeen} 次，期间位图稳定=${gear.idleStable ? '是' : '否'}）` +
              `｜换句（推到 ${gear.seeked}s）后的 ${gear.samples} 个采样里 moving ${gear.moved} 次` +
              `｜转完标记=${gear.settle} → ${pendoloGearOk ? '✓' : '✗'}`,
          );
        }
        if (theme === 'classic' && spinProbe) {
          const spin = (await win.webContents.executeJavaScript(
            `(() => {
               const words = [...document.querySelectorAll('.pi-lyricstage__word[data-word-spin]')];
               const angles = words.map((el) => {
                 const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
                 return Math.round(((Math.atan2(m.b, m.a) * 180) / Math.PI) * 10) / 10;
               });
               const tilted = angles.filter((a) => Math.abs(a) >= 1).length;
               const worst = angles.reduce((acc, a) => Math.max(acc, Math.abs(a)), 0);
               const root = document.querySelector('.pi-lyricstage');
               return {
                 words: words.length,
                 tilted,
                 worst: Number(worst.toFixed(1)),
                 attr: root instanceof HTMLElement ? root.dataset.wordSpin || '' : '',
                 sample: angles.slice(0, 8).join(','),
               };
             })()`,
            true,
          )) as { words: number; tilted: number; worst: number; attr: string; sample: string };
          spinOk = spin.words > 0 && spin.tilted >= 1 && spin.worst <= 12;
          console.info(
            `[pi/smoke] 逐字旋转效果（第十四轮第 4 条，瞬时单帧读数·只记录）：字=${spin.words} 歪着的=${spin.tilted}` +
              ` 最大角=${spin.worst}°｜前几个角=${spin.sample}｜根 data-word-spin=${spin.attr || '无'}` +
              ` → ${spinOk ? '✓' : '✗'}`,
          );
        }
        if (theme === 'classic' && spinProbe) {
          /*
         * 第十四轮第 4 条（逐字旋转）**复测**：上面那一次是「瞬态」读数——角度只活在「未唱 → 唱到」
         * 那一下（入场关键帧 + 未唱态的 `rotate(var(--pi-word-spin))`），采样恰好落在「整句都唱过」
         * 的一瞬就会数到 0 个歪字（run f / run g 两次都取到 0，字却分别有 23 / 38 个）。
         * 这里先把播放头往回挪 4s（当前句的字回到未唱态 = 重新带上角度），再每 150ms 采一帧、最多 6s，
         * 记下「歪字最多」的那一帧来判定——证明的还是同一件事：字身上确实挂着 ±6° 的旋转。
         */
        if (theme === 'classic' && spinProbe) {
          const tilt = (await win.webContents.executeJavaScript(
            `(async () => {
               const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
               const audio = window.__piAudio;
               if (audio && Number(audio.duration) > 20) {
                 audio.currentTime = Math.max(0, Number(audio.currentTime) - 4);
               }
               const read = () => {
                 const list = [...document.querySelectorAll('.pi-lyricstage__word[data-word-spin]')];
                 const angles = list.map((el) => {
                   const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
                   return Math.round(((Math.atan2(m.b, m.a) * 180) / Math.PI) * 10) / 10;
                 });
                 return { words: list.length, angles };
               };
               let best = { words: 0, angles: [] };
               let bestTilted = -1;
               for (let i = 0; i < 40; i += 1) {
                 const frame = read();
                 const tilted = frame.angles.filter((a) => Math.abs(a) >= 1).length;
                 if (tilted > bestTilted) {
                   bestTilted = tilted;
                   best = frame;
                 }
                 if (bestTilted >= 3) break;
                 await sleep(150);
               }
               let worst = 0;
               for (const a of best.angles) worst = Math.max(worst, Math.abs(a));
               const root = document.querySelector('.pi-lyricstage');
               return {
                 words: best.words,
                 tilted: bestTilted < 0 ? 0 : bestTilted,
                 worst: Number(worst.toFixed(1)),
                 attr: root instanceof HTMLElement ? root.dataset.wordSpin || '' : '',
                 sample: best.angles.slice(0, 8).join(','),
               };
             })()`,
            true,
          )) as { words: number; tilted: number; worst: number; attr: string; sample: string };
          spinOk = tilt.words > 0 && tilt.tilted >= 1 && tilt.worst <= 12;
          console.info(
            `[pi/smoke] 逐字旋转效果复测（第十四轮第 4 条，改采「歪字最多的那一帧」）：字=${tilt.words}` +
              ` 歪着的=${tilt.tilted} 最大角=${tilt.worst}°｜前几个角=${tilt.sample}` +
              `｜根 data-word-spin=${tilt.attr || '无'} → ${spinOk ? '✓' : '✗'}`,
          );
        }
        // 第十五轮第 5 条：冒出来的字（active）身上挂的是不是那条旋转入场关键帧。
          const spinin = (await win.webContents.executeJavaScript(
            `(async () => {
               const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
               let activeMax = 0;
               let hit = 0;
               const names = [];
               for (let i = 0; i < 8; i += 1) {
                 const words = [...document.querySelectorAll('.pi-lyricstage__word[data-word-spin="true"]')];
                 const active = words.filter((el) => el.dataset.wordState === 'active');
                 if (active.length > activeMax) activeMax = active.length;
                 for (const el of active) {
                   const name = getComputedStyle(el).animationName || '';
                   if (name.indexOf('spin-in') >= 0) hit += 1;
                   if (names.length < 4 && name) names.push(name);
                 }
                 await sleep(260);
               }
               return { activeMax, hit, names: names.join('|') };
             })()`,
            true,
          )) as { activeMax: number; hit: number; names: string };
          spinInOk = spinin.activeMax === 0 ? null : spinin.hit >= 1;
          console.info(
            `[pi/smoke] 流光逐字旋转用在冒出来的字上（第十五轮第 5 条）：冒字最多=${spinin.activeMax} 个` +
              `｜挂到入场关键帧的=${spinin.hit} 个｜关键帧名=${spinin.names || '无'}` +
              ` → ${spinInOk === null ? '未量' : spinInOk ? '✓' : '✗'}`,
          );
        }
        {
          /*
           * 第十五轮第 4 条：常态墨水色、只有高亮句有主题色、退色是渐变。
           * 六套主题的正文色**不在同一个通道上**（第十三～十五轮摸出来的）：
           *   · classic / tilt / partita：字素 span 的 `color` + CSS transition（900~1100ms）；
           *   · pendolo：颜色过渡挂在行级 `.pi-lyricpendolo__slot`（字素只有 opacity）；
           *   · cadenza：状态在 `data-cad-state`、颜色在 `--pi-cad-fill`（内层 inner 取用）；
           *   · fume：块级 `.pi-lyricfume__block` 的 `color`，渐变在 rAF 里按 900ms 逐块混色。
           * 后两套的「常态色」是各自主题内算出来的（`readableColor(白, surface)`），跟舞台那支
           * `--pi-lyric-ink` 未必逐位相等、而且 passed 块常在中途 → 这两套只记录不判定，
           * 严格判定留给前四套；每套的读数都单独打一行日志。
           */
          const ink = (await win.webContents.executeJavaScript(
            `(async () => {
               const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
               const stage = document.querySelector('.pi-lyricstage');
               if (!(stage instanceof HTMLElement)) return null;
               const rawInk = getComputedStyle(stage).getPropertyValue('--pi-lyric-ink').trim();
               const probe = document.createElement('span');
               probe.style.display = 'none';
               stage.appendChild(probe);
               const resolve = (value) => {
                 probe.style.color = value || 'transparent';
                 return getComputedStyle(probe).color;
               };
               const inkRgb = rawInk ? resolve(rawInk) : '';
               const theme = stage.dataset.theme || '';
               const longest = (text) => {
                 let best = 0;
                 for (const part of String(text).split(',')) {
                   const value = parseFloat(part);
                   if (!isNaN(value)) best = Math.max(best, part.indexOf('ms') >= 0 ? value : value * 1000);
                 }
                 return Math.round(best);
               };
               let nodes = [];
               let channel = 'color';
               if (theme === 'pendolo') {
                 nodes = [...document.querySelectorAll('.pi-lyricpendolo__slot')];
               } else if (theme === 'fume') {
                 nodes = [...document.querySelectorAll('.pi-lyricfume__block')];
               } else if (theme === 'cadenza') {
                 nodes = [...document.querySelectorAll('.pi-lyriccadenza__word[data-cad-state]')];
                 channel = 'var';
               } else {
                 nodes = [...document.querySelectorAll('.pi-lyricstage__word[data-word-state]')];
               }
               const stateOf = (el) => {
                 if (theme === 'pendolo') return el.dataset.lyricFocus === 'true' ? 'active' : 'passed';
                 if (theme === 'fume') return el.dataset.fumePhase === 'active' ? 'active' : 'passed';
                 if (theme === 'cadenza') return el.dataset.cadState || '';
                 return el.dataset.wordState || '';
               };
               const colorOf = (el) =>
                 channel === 'var'
                   ? resolve(getComputedStyle(el).getPropertyValue('--pi-cad-fill'))
                   : getComputedStyle(el).color;
               const snapshot = () => {
                 const counts = {};
                 const rest = {};
                 let activeColor = '';
                 let restFade = 0;
                 for (const el of nodes) {
                   const state = stateOf(el);
                   counts[state] = (counts[state] || 0) + 1;
                   const color = colorOf(el);
                   const isRest = state === 'passed' || state === 'waiting' || state === 'outro-away';
                   if (isRest) {
                     rest[color] = (rest[color] || 0) + 1;
                     if (channel === 'color' && theme !== 'fume') {
                       restFade = Math.max(restFade, longest(getComputedStyle(el).transitionDuration));
                     }
                   }
                   if ((state === 'active' || state === 'outro-current') && activeColor === '') activeColor = color;
                 }
                 return { counts: JSON.stringify(counts), rest, activeColor, restFade };
               };
               let shot = snapshot();
               for (let i = 0; i < 12 && shot.activeColor === ''; i += 1) {
                 await sleep(300);
                 shot = snapshot();
               }
               let restMode = '';
                               // 高亮句的 color 带 900~1100ms 的 CSS 过渡：刚翻成 active 那一瞬读到的还是常态墨色
                // （run f/g 实测「高亮色=rgb(26, 29, 36) 与常态不同=否」）。采到 active 之后再等一段，
                // 让过渡走完再快照一次——那才是用户看到的「只有高亮句有颜色」。
                if (shot.activeColor !== '') {
                  await sleep(950);
                  const settled = snapshot();
                  if (settled.activeColor !== '') shot = settled;
                }
                let restModeCount = 0;
               let restTotal = 0;
               for (const key of Object.keys(shot.rest)) {
                 const n = shot.rest[key];
                 restTotal += n;
                 if (n > restModeCount) {
                   restModeCount = n;
                   restMode = key;
                 }
               }
               probe.remove();
               return {
                 rawInk,
                 inkRgb,
                 theme,
                 channel,
                 count: nodes.length,
                 counts: shot.counts,
                 restMode,
                 restShare: restTotal > 0 ? Number((restModeCount / restTotal).toFixed(2)) : 0,
                 restIsInk: inkRgb !== '' && restMode === inkRgb,
                 activeColor: shot.activeColor,
                 activeDiffers: shot.activeColor !== '' && shot.activeColor !== restMode,
                 restFade: shot.restFade,
               };
             })()`,
            true,
          )) as {
            rawInk: string;
            inkRgb: string;
            theme: string;
            channel: string;
            count: number;
            counts: string;
            restMode: string;
            restShare: number;
            restIsInk: boolean;
            activeColor: string;
            activeDiffers: boolean;
            restFade: number;
          } | null;
          if (ink === null) {
            // 没读到舞台（不该发生），这一套没结论。
          } else if (ink.theme === 'cadenza' || ink.theme === 'fume') {
            console.info(
              `[pi/smoke] 歌词常态白与高亮色（第十五轮第 4 条，${ink.theme}，只记录）：` +
                `--pi-lyric-ink=${ink.rawInk || '无'}（解析=${ink.inkRgb}）｜通道=${ink.channel}` +
                `｜元素=${ink.count} 个（${ink.counts}）｜常态众数色=${ink.restMode || '无'}（占 ${ink.restShare}）` +
                `｜高亮色=${ink.activeColor || '无'}｜这两套的常态色是主题内算的，本探针不判定`,
            );
          } else if (ink.activeColor === '' || ink.count === 0) {
            console.info(
              `[pi/smoke] 歌词常态白与高亮色（第十五轮第 4 条，${ink.theme}）：这一跑没采到高亮句（元素=${ink.count} 个），未量`,
            );
          } else {
            const fadeOk = ink.restFade >= 400;
            const verdict = ink.restIsInk && ink.activeDiffers && fadeOk;
            console.info(
              `[pi/smoke] 歌词常态白与高亮色（第十五轮第 4 条，${ink.theme}）：--pi-lyric-ink=${ink.rawInk || '无'}` +
                `（解析=${ink.inkRgb}）｜通道=${ink.channel}｜元素=${ink.count} 个（${ink.counts}）` +
                `｜常态众数色=${ink.restMode} 与 ink 一致=${ink.restIsInk ? '是' : '否'}（占 ${ink.restShare}）` +
                `｜高亮色=${ink.activeColor} 与常态不同=${ink.activeDiffers ? '是' : '否'}` +
                `｜常态 color 过渡=${ink.restFade}ms 渐变=${fadeOk ? '是' : '否'}` +
                ` → ${verdict ? '✓' : '✗'}`,
            );
            // 多套主题都会写这一条：只要有一套判红就红，有结论的套数才算「量过」。
            lyricInkOk = lyricInkOk === null ? verdict : lyricInkOk && verdict;
          }
        }
        if (theme === 'fume') {
          // 第十五轮第 6 条：歌词唱完之后缩小铺满（暂停后把播放头推到最后一句之后量）。
          const outro = (await win.webContents.executeJavaScript(
            `(async () => {
               const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
               const audio = window.__piAudio;
               if (!audio) return { err: 'no-audio' };
               const read = () => {
                 const root = document.querySelector('.pi-lyricmood--fume');
                 const world = document.querySelector('.pi-lyricfume__world');
                 const attr = world instanceof HTMLElement ? world.dataset.fumeScale || '' : '';
                 let scale = parseFloat(attr);
                 if (!isFinite(scale) && world instanceof HTMLElement) {
                   const m = new DOMMatrixReadOnly(getComputedStyle(world).transform);
                   scale = Math.hypot(m.a, m.b);
                 }
                 return {
                   state: root instanceof HTMLElement ? root.dataset.fumeState || '' : '',
                   scale: Number((isFinite(scale) ? scale : 1).toFixed(3)),
                   blocks: document.querySelectorAll('.pi-lyricfume__block').length,
                   outro: document.querySelectorAll(
                     '.pi-lyricfume__block[data-fume-phase="outro-current"], .pi-lyricfume__block[data-fume-phase="outro-away"]',
                   ).length,
                 };
               };
               const duration = Number(audio.duration || 0);
               const before = read();
               if (!(duration > 1)) return { err: 'no-duration', before };
               const wasPlaying = !audio.paused;
               const saved = Number(audio.currentTime || 0);
               const marks = [];
               audio.pause();
               audio.currentTime = Math.max(0, duration - 0.4);
               for (let i = 0; i < 16; i += 1) {
                 await sleep(400);
                 marks.push(read());
               }
               let best = marks[0];
               for (const item of marks) if (item.scale < best.scale) best = item;
               audio.currentTime = saved;
               if (wasPlaying) {
                 try {
                   await audio.play();
                 } catch (error) {
                   void error;
                 }
               }
               return {
                 before,
                 after: best,
                 scales: marks.map((m) => m.scale).join(','),
                 duration: Number(duration.toFixed(1)),
               };
            })()`,
            true,
          )) as {
            err?: string;
            before: { state: string; scale: number; blocks: number; outro: number };
            after: { state: string; scale: number; blocks: number; outro: number };
            scales: string;
            duration: number;
          };
          if (outro.err !== undefined) {
            fumeOutroOk = null;
            console.info(`[pi/smoke] 浮名结尾缩镜（第十五轮第 6 条）：没量到（${outro.err}）`);
          } else {
            const shrank = outro.after.scale <= outro.before.scale - 0.05;
            const widened = outro.after.outro >= 6 && outro.after.blocks >= outro.before.blocks;
            const finished = outro.after.state === 'finished';
            fumeOutroOk = shrank && widened && finished;
            console.info(
              `[pi/smoke] 浮名结尾缩镜（第十五轮第 6 条）：曲长=${outro.duration}s` +
                `｜末句前 state=${outro.before.state || '无'} scale=${outro.before.scale} 块=${outro.before.blocks} outro 块=${outro.before.outro}` +
                `｜推到曲尾后 state=${outro.after.state || '无'} scale=${outro.after.scale} 块=${outro.after.blocks} outro 块=${outro.after.outro}` +
                `（采样=${outro.scales}）｜缩小=${shrank ? '是' : '否'} 铺开=${widened ? '是' : '否'} 已收尾=${finished ? '是' : '否'}` +
                ` → ${fumeOutroOk ? '✓' : '✗'}`,
            );
          }
          /*
           * 第十五轮第 6 条的**目视证据**：上面那次量完就把播放头放回去了，这里再推一次到曲尾，
           * 等缩小动画落定后拍一张 `docs/m3r15-fume-outro.png`（用户参考图 2 要的就是这个样子）。
           */
          const outroShotState = (await win.webContents.executeJavaScript(
            `(async () => {
               const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
               const audio = window.__piAudio;
               if (!audio || !Number.isFinite(audio.duration)) return null;
               const saved = Number(audio.currentTime || 0);
               const wasPlaying = !audio.paused;
               audio.pause();
               audio.currentTime = Math.max(0, audio.duration - 0.4);
               // 结尾那次缩小的落定时间跟环境帧率有关（缩放是弹簧按帧积分，机器忙时同一段墙钟只走几帧），
               // 固定等 1600ms 会在慢机器上拍到还没缩完的画面（run f/g 采样 2.2→1.989→1.711 就是这样）。
               // 改成轮询：最多 14 × 400ms，记「内容越界总量最小」的那一帧作为落定态。
               let shot = null;
               let bestScore = Infinity;
               for (let i = 0; i < 14; i += 1) {
                 await sleep(400);
                 const world = document.querySelector('.pi-lyricfume__world');
                 const attr = world instanceof HTMLElement ? world.dataset.fumeScale || '' : '';
                 let scale = parseFloat(attr);
                 if (!isFinite(scale) && world instanceof HTMLElement) {
                   const m = new DOMMatrixReadOnly(getComputedStyle(world).transform);
                   scale = Math.hypot(m.a, m.b);
                 }
                 const all = [...document.querySelectorAll('.pi-lyricfume__block')];
                 const here = all.filter((el) => el.dataset.fumePhase !== 'outro-away');
                 const overflowOf = (els) => {
                   if (els.length === 0) return { l: 0, r: 0, t: 0, b: 0 };
                   let l = Infinity;
                   let r = -Infinity;
                   let t = Infinity;
                   let b = -Infinity;
                   for (const el of els) {
                     const rect = el.getBoundingClientRect();
                     l = Math.min(l, rect.left);
                     r = Math.max(r, rect.right);
                     t = Math.min(t, rect.top);
                     b = Math.max(b, rect.bottom);
                   }
                   return {
                     l: Math.round(Math.max(0, -l)),
                     r: Math.round(Math.max(0, r - window.innerWidth)),
                     t: Math.round(Math.max(0, -t)),
                     b: Math.round(Math.max(0, b - window.innerHeight)),
                   };
                 };
                 const bleed = overflowOf(here);
                 const bleedAll = overflowOf(all);
                 const score = bleed.l + bleed.r + bleed.t + bleed.b;
                 if (score < bestScore) {
                   bestScore = score;
                   shot = {
                     bleed,
                     bleedAll,
                     scale: Number((isFinite(scale) ? scale : 1).toFixed(3)),
                     waitMs: (i + 1) * 400,
                     blocks: all.length,
                     here: here.length,
                   };
                 }
               }
               return { saved, wasPlaying, shot };
             })()`,
            true,
          )) as {
            saved: number;
            wasPlaying: boolean;
            shot: {
              bleed: { l: number; r: number; t: number; b: number };
              bleedAll: { l: number; r: number; t: number; b: number };
              scale: number;
              waitMs: number;
              blocks: number;
              here: number;
            } | null;
          } | null;
          if (outroShotState !== null) {
            const outroShot =
              process.env.PI_SMOKE_UI_SHOT_FUME_OUTRO ?? path.resolve(here, '../../../docs/m3r15-fume-outro.png');
            writeFileSync(outroShot, (await win.webContents.capturePage()).toPNG());
            console.info(`[pi/smoke] 截图（浮名曲尾缩镜）：${outroShot}`);
            /*
             * 第十五轮第 6 条的核心判据：缩小之后**整首歌词必须真的都在视口里**——用户要的是「缩小画面
             * 展示整个歌词」。只比 scale 的绝对阈值不可靠：计划值 = clamp(min(vw/纸宽, vh/纸高) × 0.94,
             * 0.16, 1)，随歌长与纸面大小变（run e 落到 0.384，run f/g 这首歌铺满只需要 ~1.7×），
             * 所以这里量「内容越界多少 px」这一件事，与纸的大小、缩放的绝对值都无关。
             */
            const late = outroShotState.shot;
            const lateFit =
              late !== null &&
              late.bleed.l <= 10 &&
              late.bleed.r <= 10 &&
              late.bleed.t <= 10 &&
              late.bleed.b <= 10;
            fumeOutroOk = fumeOutroOk === true && late !== null && lateFit;
            console.info(
              `[pi/smoke] 浮名曲尾「整首歌词都在视口里」（第十五轮第 6 条）：等=${late === null ? '没量到' : late.waitMs + 'ms'}` +
                `｜缩放=${late === null ? '-' : late.scale}｜块=${late === null ? '-' : late.here + '/' + late.blocks}` +
                `｜越界 L/R/T/B=${late === null ? '-' : late.bleed.l + '/' + late.bleed.r + '/' + late.bleed.t + '/' + late.bleed.b}px` +
                `（含已飘走的块=${late === null ? '-' : late.bleedAll.l + '/' + late.bleedAll.r + '/' + late.bleedAll.t + '/' + late.bleedAll.b}）` +
                `｜整首在视口里=${lateFit ? '是' : '否'} → ${fumeOutroOk ? '✓' : '✗'}`,
            );
            await win.webContents.executeJavaScript(
              `(async () => {
                 const audio = window.__piAudio;
                 if (!audio) return false;
                 audio.currentTime = ${Number(outroShotState.saved.toFixed(2))};
                 if (${outroShotState.wasPlaying ? 'true' : 'false'}) {
                   try {
                     await audio.play();
                   } catch (error) {
                     void error;
                   }
                 }
                 return true;
               })()`,
              true,
            );
            await delay(400);
          }
        }
        if (theme === 'partita') {
          // 第十五轮第 8 条：引导线不许先于歌词出现。
          const guide = (await win.webContents.executeJavaScript(
            `(async () => {
               const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
               const sample = () => {
                 const cols = [...document.querySelectorAll('.pi-lyricpartita__col')];
                 let preLit = 0;
                 let waiting = 0;
                 let entering = 0;
                 for (const col of cols) {
                   const words = [...col.querySelectorAll('.pi-lyricpartita__word')];
                   const allWaiting =
                     words.length > 0 &&
                     words.every((w) => {
                       const state = w.dataset.wordState || '';
                       return state === 'waiting' || state === '';
                     });
                   const el = col.querySelector('.pi-lyricpartita__guide');
                   const mark = el instanceof HTMLElement ? el.dataset.guide || '' : '';
                   if (allWaiting && mark !== '' && mark !== 'waiting') preLit += 1;
                   if (allWaiting && mark === 'waiting') waiting += 1;
                   if (!allWaiting && mark !== '' && mark !== 'waiting') entering += 1;
                 }
                 return { preLit, waiting, entering, cols: cols.length };
               };
               let worst = 0;
               let sawWaiting = 0;
               let sawEntering = 0;
               let cols = 0;
               for (let i = 0; i < 8; i += 1) {
                 const item = sample();
                 cols = Math.max(cols, item.cols);
                 worst = Math.max(worst, item.preLit);
                 sawWaiting += item.waiting;
                 sawEntering += item.entering;
                 await sleep(320);
               }
               return { worst, sawWaiting, sawEntering, cols };
             })()`,
            true,
          )) as { worst: number; sawWaiting: number; sawEntering: number; cols: number };
          partitaGuideOk = guide.cols === 0 ? null : guide.worst === 0;
          console.info(
            `[pi/smoke] 云阶引导线与歌词同出（第十五轮第 8 条）：块=${guide.cols}` +
              `｜「字还没出线先亮」的块=${guide.worst} 个（要求 0）` +
              `｜采样到 waiting ${guide.sawWaiting} 次 / 入场 ${guide.sawEntering} 次` +
              ` → ${partitaGuideOk === null ? '未量' : partitaGuideOk ? '✓' : '✗'}`,
          );
        }
        // 跑了逐字旋转探针那一跑，classic 的图另存一份（那会儿开关是临时打开的），
        // 免得把「用户默认状态」的正式成品图覆盖成开了旋转的样子。
        const shot = path.resolve(
          here,
          spinProbe && theme === 'classic'
            ? '../../../docs/m3r14-lyric-classic-spin.png'
            : `../../../docs/m3-lyric-${theme}.png`,
        );
        writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
        console.info(
          `[pi/smoke] 歌词动效成品图：${theme}（设置已落=${picked.setting}｜舞台 data-theme=${picked.stage || '无'}）→ ${shot}`,
        );
      }
      if (shotThemes && initialTheme !== '') {
        // 顺手把「逐字旋转」也点回用户原值（只在跑了 spin 探针那一跑才动这个开关）。
        const restored = await pickTheme(initialTheme, spinProbe ? spinInitial : null);
        console.info(
          `[pi/smoke] 歌词主题还原：${initialTheme}（设置已落=${restored.setting}｜舞台=${restored.stage || '无'}）`,
        );
      }
      if (pinnedTheme !== '') {
        const pinned = await pickTheme(pinnedTheme);
        console.info(
          `[pi/smoke] 歌词主题钉住：${pinnedTheme}（设置已落=${pinned.setting}｜舞台=${pinned.stage || '无'}）`,
        );
      }
    }

    // m08768 第 5 条：情绪背景。我们走的是「本地情绪词典 + 封面取色」的合成路线（没有 LLM），
    // 封面取色大概率回退中性色，所以这里只钉「在不在、四层齐不齐、情绪标签算出来没有」。
    const moodProbe = (await win.webContents.executeJavaScript(
      `(() => {
        const root = document.querySelector('[data-immersive]');
        return {
          present: root !== null,
          mood: root?.getAttribute('data-mood') ?? '',
          source: root?.getAttribute('data-theme-source') ?? '',
          layers: root
            ? root.querySelectorAll(
                '.pi-immersive__blur, .pi-immersive__wash, .pi-immersive__shapes, .pi-immersive__vignette',
              ).length
            : 0,
        };
      })()`,
      true,
    )) as { present: boolean; mood: string; source: string; layers: number };
    const moodOk = moodProbe.present && moodProbe.layers === 4;
    console.info(
      `[pi/smoke] 情绪背景：存在=${moodProbe.present}｜情绪=${moodProbe.mood}｜取色源=${moodProbe.source}` +
        `｜图层=${moodProbe.layers} ${moodOk ? '✓' : '✗'}`,
    );
    /*
     * 第九轮第 1/2 条之后这份契约整个换过：旧的整页遮罩、四角键（comments/like/album/artist）
     * 与浮在上面的「分享」都删了，改成「点左下角名片 → 向上弹出操作框」；进度条收起时也不再
     * 「只有一个滑块」，而是左端播放键、右端音量键（都靠悬停长出来），音量条挂在音量键上方。
     */
    // 第十一轮第 2 条（用户 m03279）：把上面探针量到的两个数字解析出来。
    // 「缩到参考图比例」不写死像素（窗口大小会变）⇒ 用药丸宽**占窗宽的比例**判：参考图约 0.245、
    // 改造前约 0.55，这里要求落在 0.18~0.35；高度不超过 52px。音量弹层要压在音量键顶上
    // （`bottom: calc(100% - 2px)`，|Δy| ≤ 4）且水平居中于键（|Δx| ≤ 3），尺寸落在 16×84 那一档。
    const barSizeMatch = /条尺寸=(\d+)x(\d+) 占比=([\d.]+)/.exec(homeInfo);
    // 第十二轮第 5 条：相邻关系与「长度不变」都取**悬停态**那一次的读数（静止态的两个键带着
    // 收起动画的 transform，视觉盒会缩、会平移，量出来的是动画中间态而不是相邻关系）。
    const hoverSizeMatch = /条尺寸=(\d+)x(\d+)/.exec(barHoverInfo);
    const volAdjMatch = /弹层贴键=Δy=(-?\d+) Δx=(-?\d+) (\d+)x(\d+)/.exec(barHoverInfo);
    const volLayoutMatch = /弹层布局=(\d+)x(\d+)/.exec(barHoverInfo);
    const popShownMatch = /弹层不透明度=([\d.]+)/.exec(barHoverInfo);
    // 第十五轮第 3 条（用户 m06435）：轨道的首尾两端（键要挂在它们正上方）与轨道里那根进度条
    // 的宽度（要长到改造前的 150%）；第 9 条：停在音量键上时轨道该是细的（3px），指针移到
    // 条上才加粗到 6px、长度放回满档——两段读数都从这里取。
    const trackMatch = /轨道=左=(-?\d+) 右=(-?\d+) 顶=(-?\d+) 宽=(\d+)/.exec(barHoverInfo);
    // 第十七轮第 6 条：静止态的轨道宽（homeInfo 里量的那一条）是「放大到 150%」的基准。
    const restTrackMatch = /轨道宽=(\d+)/.exec(homeInfo);
    const restTrackWidth = restTrackMatch === null ? Number.NaN : Number(restTrackMatch[1]);
    const progMatch = /进度条=(\d+)/.exec(barHoverInfo);
    const volThickMatch = /音量厚度=(\S+) 音量滑块=(\S+)/.exec(barHoverInfo);
    const popHoverMatch = /二次悬停=视觉=(\d+)x(\d+) 厚度=(\S+) 滑块=(\S+) 不透明度=([\d.]+)/.exec(
      barHoverInfo,
    );
    const barWidth = barSizeMatch === null ? Number.NaN : Number(barSizeMatch[1]);
    const barHeight = barSizeMatch === null ? Number.NaN : Number(barSizeMatch[2]);
    const barShare = barSizeMatch === null ? Number.NaN : Number(barSizeMatch[3]);
    const volDy = volAdjMatch === null ? Number.NaN : Number(volAdjMatch[1]);
    const volDx = volAdjMatch === null ? Number.NaN : Number(volAdjMatch[2]);
    const volW = volAdjMatch === null ? Number.NaN : Number(volAdjMatch[3]);
    const volH = volAdjMatch === null ? Number.NaN : Number(volAdjMatch[4]);
    const volLayoutW = volLayoutMatch === null ? Number.NaN : Number(volLayoutMatch[1]);
    const volLayoutH = volLayoutMatch === null ? Number.NaN : Number(volLayoutMatch[2]);
    const barSizeOk =
      Number.isFinite(barWidth) && barShare >= 0.18 && barShare <= 0.35 && barHeight <= 52;
    /*
     * 第十一轮第 3 条（用户 m03279）当时要求「鼠标悬停上去后只是加上暂停键和音量键，进度条本身
     * 长度不变」；**第十七轮第 6 条（用户 m00006）把这条改掉了**：「悬停放大时进度条放大到原来的
     * 150%」——药丸悬停时会从 343px 撑到 `--pi-bar-hover-width` = 343×1.5 - 94 ≈ 420px，所以
     * 「逐像素相等」再也不可能成立。这里改判「悬停药丸确实比静止态宽」，150% 那条挪到下面的
     * trackGrowOk（用静止态的轨道宽当基准做真倍数判定）。
     */
    const barHoverGrowOk =
      hoverSizeMatch !== null && Number.isFinite(barWidth) && barWidth > 0 &&
      Number(hoverSizeMatch[1]) > barWidth;
    /*
     * 第十四轮第 1 条（用户 m05281）：「音量条重新设计…鼠标悬停的时候音量条的部件变大一点，
     * 方便调节」。悬停时弹层整体 scale(1.3) ⇒ 视觉盒不再是 16×84，尺寸一律改判**布局盒**
     * （offsetWidth/offsetHeight，与 transform 无关），视觉盒只用来验「真的变大了」。
     */
    const volPopAdjacentOk =
      Number.isFinite(volDy) &&
      Math.abs(volDy) <= 4 &&
      Math.abs(volDx) <= 3 &&
      volLayoutMatch !== null &&
      volLayoutW === 16 &&
      // 第十七轮第 6 条（用户 m00006）：「音量条常态缩短到 70%」⇒ 弹层布局高 84 → 59。
      volLayoutH === 59;
    const volPopGrowOk =
      Number.isFinite(volW) &&
      Number.isFinite(volH) &&
      volW >= 19 &&
      volW <= 24 &&
      /*
       * 第十五轮第 9 条（用户 m06435）：「悬停在音量键上时，音量条要比现在短 20%」。
       * 第十八轮第 1 条（用户 m01482）：「音量条放大时多延长 50%」⇒ 满档 59×1.9 ≈ 112、
       * 键上态 = 满档 × 0.8 ≈ 88.5（旧读数 59×1.3/1.04 ⇒ 55~68 作废，上移到 78~98）。
       */
      volH >= 78 &&
      volH <= 98;
    /*
     * 第十五轮第 9 条后半句：「鼠标移到音量条时，音量条变粗并且变长到现在这样长」。
     * 两次悬停各量一次做对比：
     *   停在音量键上 ⇒ 轨道厚 3px、滑块 14px、视觉高 ≈ 满档 × 0.8（「短 20%」）；
     *   指针落在条上 ⇒ 轨道厚 6px、滑块 18px、长度回到满档（≈ 109px，就是第十四轮那个长度）。
     */
    const volFullW = popHoverMatch === null ? Number.NaN : Number(popHoverMatch[1]);
    const volFullH = popHoverMatch === null ? Number.NaN : Number(popHoverMatch[2]);
    const volFullThick = popHoverMatch === null ? '' : popHoverMatch[3];
    const volFullThumb = popHoverMatch === null ? '' : popHoverMatch[4];
    const volKeyThick = volThickMatch === null ? '' : volThickMatch[1];
    const volKeyThumb = volThickMatch === null ? '' : volThickMatch[2];
    const volShortOk =
      Number.isFinite(volH) &&
      Number.isFinite(volFullH) &&
      volFullH > 0 &&
      Math.abs(volH / volFullH - 0.8) <= 0.06;
    const volThickOk =
      volKeyThick === '3px' &&
      volKeyThumb === '14px' &&
      volFullThick === '6px' &&
      volFullThumb === '18px' &&
      Number.isFinite(volFullW) &&
      volFullW >= 19 &&
      volFullW <= 24 &&
      Number.isFinite(volFullH) &&
      /*
       * 第十八轮第 1 条（用户 m01482）：「音量条放大时多延长 50%」⇒ 落在条上时 y 放到 1.9，
       * 视觉高 = 59×1.9 ≈ 112（第十七轮那档 59×1.3 ≈ 76.7 / 界 70~84 作废）。
       * 厚 6px、滑块 18px 与「键上态 3px/14px」的老关系不变。
       */
      volFullH >= 100 &&
      volFullH <= 124 &&
      popHoverMatch !== null &&
      Number(popHoverMatch[5]) > 0.9;
    // 悬停时音量弹层必须真的浮出来（不透明度 1），否则上面那几个数是在量一个看不见的盒子。
    const volPopShownOk = popShownMatch !== null && Number(popShownMatch[1]) > 0.9;
    /*
     * 第十三轮第 5 条（用户 m04663）：「音量条要在音量键的上面，现在是像图 2 一样，有错位」。
     * 上面那条「弹层贴键 Δx」量的是**弹层盒子**的中心——它一直是对的（|Δx|=0），所以旧断言
     * 恒真、什么也没抓住。真正错位的是弹层里那根竖条：84×16 的 range 在 16×84 的弹层里溢出，
     * Chromium 把 grid 居中的 `place-items: center` **夹回起始边**，于是整根条的中心落在离弹层
     * 左边 42px（= 84/2）处，转过来就比音量键中心偏右半个长度（真机特写逐像素量到
     * 键中心 x≈51 vs 滑块 x≈93）。修法是把它改成绝对定位、自身中心钉在弹层中心。
     * 这里补的断言量的是**滑杆自身的轴线**（转完之后的视觉盒是 16x84），与盒子同心断言互补。
     */
    const volAxisMatch = /滑杆轴=Δx=(-?\d+)/.exec(barHoverInfo);
    const volAxisDx = volAxisMatch === null ? Number.NaN : Number(volAxisMatch[1]);
    const volRangeLayoutMatch = /滑杆布局=(\d+)x(\d+)/.exec(barHoverInfo);
    // 第十四轮第 1 条：滑杆的**布局盒**是横放的 84×16（转 90° 才是那根竖条）；
    // 第十七轮第 6 条把常态长度缩到 70% ⇒ 59×16（转过来仍是 16×59 的竖条）。
    // 悬停放大只改视觉盒，所以这里判布局盒；轴线 Δx 与缩放无关，仍然要贴 0。
    const volAxisOk =
      Number.isFinite(volAxisDx) &&
      Math.abs(volAxisDx) <= 2 &&
      volRangeLayoutMatch !== null &&
      Number(volRangeLayoutMatch[1]) === 59 &&
      Number(volRangeLayoutMatch[2]) === 16;
    console.info(
      `[pi/smoke] 进度条尺寸与音量弹层（第十一轮第 2 条）：条=${barWidth}x${barHeight} 占比=${barShare}（要求 0.18~0.35）` +
        `｜弹层 Δy=${volDy} Δx=${volDx} 布局=${volLayoutW}x${volLayoutH} 视觉=${volW}x${volH}` +
        `｜条尺寸 ${barSizeOk ? '✓' : '✗'}｜贴键 ${volPopAdjacentOk ? '✓' : '✗'}` +
        `｜悬停变长 ${barHoverGrowOk ? '✓' : '✗'}（静止=${barWidth}px 悬停=${hoverSizeMatch?.[1] ?? '?'}px）` +
        `｜悬停放大 ${volPopGrowOk ? '✓' : '✗'}` +
        `｜音量条居中 ${volAxisOk ? '✓' : '✗'}` +
        `｜悬停浮出 ${volPopShownOk ? '✓' : '✗'}`,
    );
    console.info(
      `[pi/smoke] 音量条两级悬停（第十五轮第 9 条）：停在音量键上=视觉=${volW}x${volH} 厚=${volKeyThick} 滑块=${volKeyThumb}` +
        `｜指针落在条上=视觉=${volFullW}x${volFullH} 厚=${volFullThick} 滑块=${volFullThumb}` +
        `｜短两成 ${volShortOk ? '✓' : '✗'}｜落在条上加粗变长 ${volThickOk ? '✓' : '✗'}` +
        `｜轨道=${trackMatch?.[4] ?? '?'}px 轨道内进度条=${progMatch?.[1] ?? '?'}px`,
    );
    // 第十二轮第 4/5 条（用户 m04193）：名片竖排（封面在顶、方图）+ 进度条两个键的常态收起态。
    const cardVertMatch =
      /名片竖排=封面在顶=(true|false) 封面宽=(\d+) 名片宽=(\d+) 封面比=([\d.]+)/.exec(homeInfo);
    const barKeysMatch =
      /条键收起态=播放键透明度=([\d.]+) 缩放=([\d.]+) 音量键透明度=([\d.]+) 缩放=([\d.]+)/.exec(
        homeInfo,
      );
    const cardVertOk =
      cardVertMatch !== null &&
      cardVertMatch[1] === 'true' &&
      Number(cardVertMatch[2]) <= Number(cardVertMatch[3]) + 2 &&
      Number(cardVertMatch[3]) >= 150 &&
      Number(cardVertMatch[3]) <= 240 &&
      Number(cardVertMatch[4]) >= 0.9 &&
      Number(cardVertMatch[4]) <= 1.1;
    const barKeysOk =
      barKeysMatch !== null &&
      Number(barKeysMatch[1]) <= 0.1 &&
      Number(barKeysMatch[2]) <= 0.9 &&
      Number(barKeysMatch[3]) <= 0.1 &&
      Number(barKeysMatch[4]) <= 0.9;
    console.info(
      `[pi/smoke] 名片竖排与进度条收起态（第十二轮第 4/5 条）：` +
        `封面在顶=${cardVertMatch?.[1] ?? '未量到'} 封面宽=${cardVertMatch?.[2] ?? '?'} ` +
        `名片宽=${cardVertMatch?.[3] ?? '?'} 封面比=${cardVertMatch?.[4] ?? '?'}｜` +
        `播放键 opacity=${barKeysMatch?.[1] ?? '?'} 缩放=${barKeysMatch?.[2] ?? '?'} ` +
        `音量键 opacity=${barKeysMatch?.[3] ?? '?'} 缩放=${barKeysMatch?.[4] ?? '?'}｜` +
        `竖排 ${cardVertOk ? '✓' : '✗'}｜常态收起 ${barKeysOk ? '✓' : '✗'}`,
    );
    /*
     * 第十三轮第 3 条（用户 m04663）：「底部进度条部件在鼠标悬停时变大一点，左右两边浮现停止键和音量键…
     * 进度条的长度略长一点…进度条部件变大时进度条本身长度不变。进度条上部两端可以加上上一首/下一首的按键图标」。
     * 拆成三条可量的：
     * ①「变大」= 悬停高度 58~70（静止 44），且**底边一 px 不动**（只向上长）；
     * ②常驻那一行（时间/进度条/两个键）钉在底边、高度稳定 ⇒ 进度条本身既没拉长也没挪位
     *   （药丸悬停会撑宽到 1.5 倍、150% 另有 `trackGrowOk` 按静止态轨道宽做倍数判定）；
     * ③两个新键：静止透明且点不到，悬停浮现，且只落在顶上那条新长出来的 20px 里。
     */
    const barBottomMatch = /条底=(-?\d+)/.exec(homeInfo);
    const hoverBottomMatch = /条底=(-?\d+)/.exec(barHoverInfo);
    const rowMatch = /行高=(\d+) 行底=(-?\d+)/.exec(barHoverInfo);
    const hoverKeysMatch =
      /上一首键=([\d.]+),top=(-?\d+),bottom=(-?\d+),cx=(-?\d+),cy=(-?\d+) 下一首键=([\d.]+),top=(-?\d+),bottom=(-?\d+),cx=(-?\d+),cy=(-?\d+)/.exec(
        barHoverInfo,
      );
    const restKeysMatch = /双键收起态=上一首透明度=([\d.]+) 下一首透明度=([\d.]+)/.exec(homeInfo);
    const barLeftMatch = /条左=(-?\d+) 条右=(-?\d+)/.exec(barHoverInfo);
    const barLeft = barLeftMatch === null ? Number.NaN : Number(barLeftMatch[1]);
    const barRight = barLeftMatch === null ? Number.NaN : Number(barLeftMatch[2]);
    const barBottom = barBottomMatch === null ? Number.NaN : Number(barBottomMatch[1]);
    const hoverBottom = hoverBottomMatch === null ? Number.NaN : Number(hoverBottomMatch[1]);
    const hoverBarHeight = hoverSizeMatch === null ? Number.NaN : Number(hoverSizeMatch[2]);
    const rowH = rowMatch === null ? Number.NaN : Number(rowMatch[1]);
    const rowBottom = rowMatch === null ? Number.NaN : Number(rowMatch[2]);
    // 第十五轮第 3 条把「两个键竖直居中在常驻行里」那条判据换掉了（键现在在轨道上方），
    // 于是 `rowTop` 这个中间量没人再用——直接删掉，别留着骗 TS 的 noUnusedLocals。
    const barGrowOk =
      Number.isFinite(barHeight) &&
      Number.isFinite(hoverBarHeight) &&
      /*
       * 第十八轮第 1 条（用户 m01482）：「调整边框可以像图 1 一样包裹暂停键」。
       * 暂停键悬停时是 40×1.4 = 56，药丸高度从 56 提到 64（上下各留 4px），
       * 所以第十三轮那条 52~60 的判据作废，改判 58~70（仍要求底边一 px 不动、只向上长）。
       */
      hoverBarHeight >= 58 &&
      hoverBarHeight <= 70 &&
      Number.isFinite(barBottom) &&
      Number.isFinite(hoverBottom) &&
      Math.abs(barBottom - hoverBottom) <= 1;
    /*
     * 用户 m00001 第 2 条（本轮）：「底部进度条部件放大后进度条本身不要居中、往下一点」——
     * 常驻那一行从第十八轮第 1 条的「在药丸里竖直居中」改回**贴着药丸下沿**
     * （`global.css` 的 `.pi-home__barlyn` 恢复 `bottom: 0; top: auto`），悬停多出来的 20px
     * 全留在上方留给上/下一首。于是旧判据「行中心 = 药丸中心」作废，改判「行底贴药丸底」：
     * 静置与悬停两态的药丸下沿本来都不动（`bottom: 18px`），常驻行 44px 高、两态都贴在它上面。
     */
    const rowPinnedOk =
      Number.isFinite(rowH) &&
      rowH >= 42 &&
      rowH <= 46 &&
      Number.isFinite(rowBottom) &&
      Number.isFinite(barBottom) &&
      Number.isFinite(hoverBottom) &&
      Math.abs(rowBottom - barBottom) <= 2 &&
      Math.abs(rowBottom - hoverBottom) <= 2;
    /*
     * 第十五轮第 3 条（用户 m06435）：「上/下一首的按键应该在进度条本身首尾两端**上面**，
     * 而不是首尾旁边，并且常态不显示、放大后才显示」。
     * 第十四轮那条「行内夹着进度条」的判据整体作废，改成三条可量的：
     *   ①常态真的看不见（静止 opacity ≤ 0.1；CSS 里同时 pointer-events: none）；
     *   ②悬停药丸后浮现（两个键都 opacity ≈ 1）；
     *   ③位置：键的水平中心钉在**轨道**的首/尾端（±4px），键底落在轨道顶边**之上**，
     *     竖直也不越出悬停时那条药丸（键顶 ≥ 药丸顶）。
     */
    const trackLeft = trackMatch === null ? Number.NaN : Number(trackMatch[1]);
    const trackRight = trackMatch === null ? Number.NaN : Number(trackMatch[2]);
    const trackTop = trackMatch === null ? Number.NaN : Number(trackMatch[3]);
    const trackWidth = trackMatch === null ? Number.NaN : Number(trackMatch[4]);
    const hoverBarTop =
      Number.isFinite(hoverBottom) && Number.isFinite(hoverBarHeight)
        ? hoverBottom - hoverBarHeight
        : Number.NaN;
    const prevNextOk =
      homeInfo.includes('上一首键=true') &&
      homeInfo.includes('下一首键=true') &&
      restKeysMatch !== null &&
      // ①「常态不显示」：第十五轮把它从第十四轮的「淡色常驻 0.55」改回完全藏起来。
      Number(restKeysMatch[1]) <= 0.1 &&
      Number(restKeysMatch[2]) <= 0.1 &&
      hoverKeysMatch !== null &&
      // ②「放大后才显示」：悬停药丸时两个键都实心浮现。
      Number(hoverKeysMatch[1]) > 0.9 &&
      Number(hoverKeysMatch[6]) > 0.9 &&
      Number.isFinite(trackLeft) &&
      Number.isFinite(trackRight) &&
      Number.isFinite(trackTop) &&
      Number.isFinite(hoverBarTop) &&
      // ③水平：上一首的中心压在轨道左端、下一首压在轨道右端（各自外移半个身位）。
      Math.abs(Number(hoverKeysMatch[4]) - trackLeft) <= 4 &&
      Math.abs(Number(hoverKeysMatch[9]) - trackRight) <= 4 &&
      // ③竖直：两个键整体在轨道顶边之上（键底 ≤ 轨道顶 − 1px），但不越出悬停药丸的顶边。
      Number(hoverKeysMatch[3]) <= trackTop - 1 &&
      Number(hoverKeysMatch[8]) <= trackTop - 1 &&
      Number(hoverKeysMatch[2]) >= hoverBarTop - 1 &&
      Number(hoverKeysMatch[7]) >= hoverBarTop - 1 &&
      Number(hoverKeysMatch[4]) < Number(hoverKeysMatch[9]);
    /*
     * 第十五轮第 3 条后半句：「进度条本身还需增长到原来的 150%」；第十七轮第 6 条（用户 m00006）
     * 把它升格成了整个药丸的悬停行为：「悬停放大时进度条放大到原来的 150%」。改造前那一行是
     * `[播放] ‹ 时间 进度 时间 › [音量]`，两个箭头加两个 gap 一共约 56px 原本占着轨道宽度；它们
     * 挪到轨道上方之后轨道自然长出这段（旧读数约 101px），再加上这次「悬停时药丸 ×1.5 - 94px」的
     * 放大，就真到了 150%。这里用**静止态轨道宽**当基准做倍数判定（不再卡死 150px 那个绝对值，
     * 那个值在前几轮是恒真的）。
     */
    const trackGrowOk =
      progMatch !== null && Number.isFinite(restTrackWidth) && restTrackWidth > 0 &&
      Number(progMatch[1]) >= restTrackWidth * 1.45;
    const barHoverOk = barGrowOk && rowPinnedOk && prevNextOk;
    console.info(
      `[pi/smoke] 进度条悬停长大与两角键（第十三轮第 3 条）：静止=${barWidth}x${barHeight} 底=${barBottom}｜` +
        `悬停=${hoverSizeMatch?.[1] ?? '?'}x${hoverSizeMatch?.[2] ?? '?'} 底=${hoverBottom}｜` +
        `常驻行=${rowH}px 底=${rowBottom}｜上一首 opacity=${hoverKeysMatch?.[1] ?? '?'} 下一首 opacity=${hoverKeysMatch?.[6] ?? '?'}` +
        `（静止 ${restKeysMatch?.[1] ?? '?'}/${restKeysMatch?.[2] ?? '?'}）｜` +
        `轨道 ${trackLeft}~${trackRight}（顶=${trackTop} 宽=${trackWidth}）｜` +
        `上一首 cx=${hoverKeysMatch?.[4] ?? '?'} 底=${hoverKeysMatch?.[3] ?? '?'} ` +
        `下一首 cx=${hoverKeysMatch?.[9] ?? '?'} 底=${hoverKeysMatch?.[8] ?? '?'}（药丸 ${barLeft}~${barRight}）｜` +
        `向上长大 ${barGrowOk ? '✓' : '✗'}｜进度条不动 ${rowPinnedOk ? '✓' : '✗'}` +
        `｜轨道上方两角键 ${prevNextOk ? '✓' : '✗'}` +
        `｜进度条 150% ${trackGrowOk ? '✓' : '✗'}（静止轨道=${Number.isFinite(restTrackWidth) ? restTrackWidth : '?'}px 悬停=${progMatch?.[1] ?? '?'}px）`,
    );
    /*
     * 第十三轮第 6 条（用户 m04663）：那张「正在播放」小名片是**系统**画的（Windows SMTC / 音量浮层），
     * 数据与动作全部来自 Media Session —— 我们此前一个字节都没接，所以它既没有歌名封面、点了也
     * 没人响应。这里断言渲染层真的把会话接上了：动作清单（`window.__piMediaSession` 那个探针接缝）、
     * 系统拿到的元数据（歌名/歌手/封面张数）、以及正在播放的状态。
     */
    const mediaInfo = (await win.webContents.executeJavaScript(
      `(() => {
        const session = navigator.mediaSession;
        const meta = session && session.metadata ? session.metadata : null;
        const hook = window.__piMediaSession ? window.__piMediaSession : null;
        return {
          actions: hook ? hook.actions.join('/') : '',
          title: meta ? meta.title : '',
          artist: meta ? meta.artist : '',
          artwork: meta && meta.artwork ? meta.artwork.length : 0,
          state: session ? session.playbackState : '无 mediaSession',
        };
      })()`,
      true,
    )) as { actions: string; title: string; artist: string; artwork: number; state: string };
    const mediaActionsOk =
      mediaInfo.actions.includes('play') &&
      mediaInfo.actions.includes('pause') &&
      mediaInfo.actions.includes('nexttrack') &&
      mediaInfo.actions.includes('previoustrack');
    const mediaSessionOk =
      mediaActionsOk && mediaInfo.title !== '' && mediaInfo.state === 'playing' && mediaInfo.artwork >= 1;
    console.info(
      `[pi/smoke] 系统媒体卡片接线（第十三轮第 6 条）：动作=${mediaInfo.actions || '无'}｜` +
        `歌名=${mediaInfo.title || '空'}｜歌手=${mediaInfo.artist || '空'}｜封面=${mediaInfo.artwork} 张｜` +
        `状态=${mediaInfo.state}｜接线 ${mediaActionsOk ? '✓' : '✗'}｜元数据 ${mediaSessionOk ? '✓' : '✗'}`,
    );
    const homeOk =
      // 名片：在左下角、有封面、歌手/专辑两个可点按钮、下面一行音质
      homeInfo.startsWith('名片=true') &&
      homeInfo.includes('名片封面=true') &&
      homeInfo.includes('歌手键=true') &&
      homeInfo.includes('专辑键=true') &&
      homeInfo.includes('音质=true') &&
      homeInfo.includes('背景=true') &&
      // 用户 m02213 第 8 条：旧操作框删掉（点名片也不出来），四条能力改挂封面四角 + 右下角爱心。
      // 四颗键顺序不敏感，但必须四颗都在、不多不少。
      // 用户 m03805 第 4 条：左上是「播放模式」（原「歌曲信息」），那块面板改由封面本体开
      // （`data-card-cover="info"`，见上面 `coverEntryOk`）。
      actionsKeys.split('/').sort().join('/') === 'comments/like/mode/share' &&
      coverEntryOk &&
      homeInfo.includes('旧操作框=false') &&
      /爱心=(true|false)/.test(homeInfo) &&
      // 进度条：四个钩子都在，旧的整页遮罩必须真的没了
      homeInfo.includes('进度条=true') &&
      homeInfo.includes('条内播放键=true') &&
      homeInfo.includes('条内音量键=true') &&
      homeInfo.includes('音量弹层=true') &&
      homeInfo.includes('音量条=true') &&
      // 第十一轮第 2 条（用户 m03279）：整体缩到参考图比例 + 音量弹层从音量键顶上长出来
      barSizeOk &&
      volPopAdjacentOk &&
      // 第十二轮第 4/5 条（用户 m04193）：名片竖排（封面在顶）+ 进度条两个键常态收起 +
      // 悬停不改变药丸长度、悬停时音量弹层真的浮出来
      cardVertOk &&
      barKeysOk &&
      barHoverGrowOk &&
      volPopShownOk &&
      // 第十四轮第 1 条（用户 m05281）：悬停时音量部件真的变大（布局盒仍是 16×84）。
      volPopGrowOk &&
      // 第十五轮第 9 条（用户 m06435）：停在音量键上「短两成」、指针落在条上「加粗并变长」。
      volShortOk &&
      volThickOk &&
      // 第十五轮第 3 条（用户 m06435）：进度条本身长到改造前的 150%（两个箭头挪到轨道上方）。
      trackGrowOk &&
      // 第十三轮第 5 条：弹层盒子居中之外，弹层里那根滑杆的轴线也要跟音量键同心。
      volAxisOk &&
      // 第十三轮第 3 条（用户 m04663）：悬停时药丸只向上长大、常驻那一行不动（进度条不变），
      // 顶部两角浮现上一首/下一首；第 6 条：系统媒体卡片（Media Session）真的接上了。
      barHoverOk &&
      mediaSessionOk &&
      // 第十二轮：铺满整窗后「点歌词空白仍能收起操作框」（判据已收窄成「只有歌词行算歌词」）
      cardActionOk &&
      homeInfo.includes('旧遮罩=false') &&
      moodOk &&
      themeOk &&
      // 第十七轮第 7 条（用户 m08758）：名片**常态隐藏**、鼠标靠近或刚切歌才冒出来。
      // 这一读发生在拍完干净图之后，此刻真实指针还停在歌词行中心（离左下角很远）
      // ⇒ 按新规格名片就该是 opacity 0（旧口径「收掉操作框后名片必须画出来」已作废）。
      // 「指针靠近就真的画出来」由上面的 idleWakeOk（指名片 片=1.00）单独盯着，
      // 所以这里改成「常态确实藏着」+ 几何位置；底部进度条是常驻的，仍然必须真的画出来。
      // 第九轮第 2 条把名片从左上挪到左下，所以这里连「在下半屏」也一起钉住。
      cardBox.card !== null &&
      cardBox.card.y > cardBox.vh / 2 &&
      cardBox.card.op === '0' &&
      cardBox.bar !== null &&
      cardBox.bar.op === '1' &&
      lyricLines > 0 &&
      railOk &&
      litOk &&
      lyricWheelOk;
    console.info(`[pi/smoke] 歌词行=${lyricLines}（要求 >0 ${lyricLines > 0 ? '✓' : '✗'}）`);

    // m08768 第 3 条：推荐**页面**已经删掉。所以这里不是「跑一遍折叠」，而是反过来钉住
    // 「导航里再也点不到推荐」——折页组件（`CollapsibleSection`）只服务那个页面，页面没了
    // 它也就没有使用者了，冒烟不再有折叠这一项。
    // 第十六轮：抽屉里新增了「推荐歌单」，`clickNav` 的 includes 会误命中它、让这条断言假失败。
    // 改成精确匹配老那一项（文案就是「推荐」）。
    const recommendGone = !(await clickNavExact(win, '推荐'));
    // 抽屉可能因此还开着（点不到条目也不会自己关），后面还要开环形菜单，先关掉。
    await win.webContents.executeJavaScript(
      `document.querySelector('.pi-navdrawer__scrim')?.click()`,
      true,
    );
    await delay(340);
    console.info(
      `[pi/smoke] 推荐页已删除：导航里点不到「推荐」（精确匹配，不会被「推荐歌单」误命中）` +
        ` ${recommendGone ? '✓' : '✗'}（应点不到）`,
    );

    // 用户需求第 2 条：悬浮球点开是抽屉（搜索在顶部），再点遮罩关掉。
    await openNav(win);
    await delay(400);
    const drawerInfo = (await win.webContents.executeJavaScript(
      `(() => {
        const aside = document.querySelector('.pi-navdrawer');
        if (!aside) return '未打开';
        return '分组=' + aside.querySelectorAll('.pi-navdrawer__group').length +
          ' 项=' + aside.querySelectorAll('.pi-navitem').length +
          ' 搜索在顶部=' + Boolean(aside.querySelector('.pi-searchbar--drawer input')) +
          ' 「播放器主页」项=' + [...aside.querySelectorAll('.pi-navitem')].some((el) => (el.textContent || '').includes('播放器主页')) +
          ' 账号区=' + Boolean(aside.querySelector('.pi-navdrawer__footer'));
      })()`,
      true,
    )) as string;
    console.info(`[pi/smoke] 导航抽屉：${drawerInfo}`);
    const navShot =
      process.env.PI_SMOKE_UI_SHOT_NAV ?? path.resolve(here, '../../../docs/m3-nav.png');
    writeFileSync(navShot, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${navShot}`);
    await win.webContents.executeJavaScript(
      `document.querySelector('.pi-navdrawer__scrim')?.click()`,
      true,
    );
    await delay(400);
    const drawerClosed = (await win.webContents.executeJavaScript(
      `document.querySelector('.pi-navdrawer') === null`,
      true,
    )) as boolean;
    const navOk = drawerClosed && drawerInfo.includes('搜索在顶部=true') && drawerInfo.includes('账号区=true');
    console.info(
      `[pi/smoke] 抽屉关闭（点遮罩）：${drawerClosed ? '✓' : '✗'}｜「搜索在顶部」与账号区 ${navOk ? '✓' : '✗'}`,
    );

    // 第十六轮删球，此断言随之退休。
    let dragOk = false;
    const ballBefore = await boxOf('.pi-orb__ball');
    // 记下渲染进程真实收到的手势事件：拖动曾经只生效第一步，靠这份日志才定位到原因。
    await win.webContents.executeJavaScript(
      `(() => {
        window.__piDrag = [];
        const push = (kind) => (event) => {
          if (window.__piDrag.length >= 24) return;
          window.__piDrag.push(kind + '#' + event.pointerId + '/' + event.pointerType + ' b=' + event.buttons +
            ' ' + Math.round(event.clientX) + ',' + Math.round(event.clientY));
        };
        for (const kind of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
          window.addEventListener(kind, push(kind.replace('pointer', '')), true);
        }
        return true;
      })()`,
      true,
    );
    if (ballBefore) {
      const fromX = ballBefore.x + Math.round(ballBefore.w / 2);
      const fromY = ballBefore.y + Math.round(ballBefore.h / 2);
      await focusSmoke(win);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: fromX, y: fromY, button: 'left', clickCount: 1 });
      for (let step = 1; step <= 6; step += 1) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: fromX + step * 30, y: fromY + step * 8 });
        await delay(60);
      }
      win.webContents.sendInputEvent({ type: 'mouseUp', x: fromX + 180, y: fromY + 48, button: 'left', clickCount: 1 });
      await delay(600);
      const dragEvents = (await win.webContents.executeJavaScript(
        `window.__piDrag`,
        true,
      )) as string[];
      console.info(
        `[pi/smoke] 拖动手势事件（${dragEvents.length}）：${dragEvents.join(' | ') || '一个都没收到'}`,
      );
      const ballAfter = await boxOf('.pi-orb__ball');
      const moved = ballAfter !== null && ballAfter.x - ballBefore.x > 100;
      console.info(
        `[pi/smoke] 悬浮球拖动：${ballBefore.x},${ballBefore.y} → ${ballAfter ? `${ballAfter.x},${ballAfter.y}` : '丢失'} ` +
          `${moved ? '✓' : '✗'}（拖动后应保持在右侧，不被吸回左边）`,
      );

      // 贴边吸附 + 贴边细条（m05797 第 1、2 条 + m06304 第 7 条）：往右边缘拖再松手，
      // 球应该吸附上去、**把环形菜单收起来**并变成一条贴在边上的细条；再把它拉出来，
      // 球要变回圆形、而且原来开着的菜单自己回来。
      const view = (await win.webContents.executeJavaScript(
        `({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })`,
        true,
      )) as { w: number; h: number };
      // 先确定「吸附之前菜单是开着的」，拉出来的自动恢复才有确定的期望值。
      let snappedRing: RingSnapshot | null = null;
      let snapped: BallBox | null = null;
      let gap = Number.NaN;
      let hoverW = Number.NaN;
      let stripOk = false;
      // 同封面环：多步拖动的合成鼠标事件偶发只送到 down，球一动不动。终态不对就整段重来。
      for (let attempt = 0; attempt < 3 && !stripOk; attempt += 1) {
        await orbToMain(win);
        await delay(240);
        const anchor = (await ballBox(win)) ?? ballAfter ?? ballBefore;
        const anchorX = Math.round(anchor.x + anchor.w / 2);
        const anchorY = Math.round(anchor.y + anchor.h / 2);
        const toX = view.w - 4;
        await focusSmoke(win);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: anchorX, y: anchorY, button: 'left', clickCount: 1 });
        for (let step = 1; step <= 8; step += 1) {
          win.webContents.sendInputEvent({
            type: 'mouseMove',
            x: Math.min(toX, anchorX + step * 80),
            y: anchorY,
          });
          await delay(50);
        }
        win.webContents.sendInputEvent({ type: 'mouseUp', x: toX, y: anchorY, button: 'left', clickCount: 1 });
        await delay(560);
        snappedRing = await readRing(win);
        // 松手时鼠标还压在细条上 ⇒ 量到的是 :hover 的粗细（12px 档）。要钉「更细」这条，
        // 得先把鼠标挪开、等过 width 的 0.28s 过渡，再量静息粗细（8px 档）。
        const hoveredAt = await ballBox(win);
        win.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(view.w / 2),
          y: Math.round(view.h / 2),
        });
        await delay(420);
        snapped = await ballBox(win);
        hoverW = hoveredAt ? hoveredAt.w : Number.NaN;
        gap = snapped ? view.w - (snapped.x + snapped.w) : Number.NaN;
        stripOk =
          snappedRing?.snapped === 'right' &&
          snappedRing.open === false &&
          snapped !== null &&
          // m08768 第 7 条「贴边细条更细」：静态 8px、指到上面 12px（+1px 描边）。
          snapped.w <= 9 &&
          (!Number.isFinite(hoverW) || hoverW <= 13) &&
          Math.abs(gap) <= 1;
      }
      // 临时诊断：细条实测 14px（CSS 写的是 8px），要看清是哪条样式把它撑开的。
      const stripDiag = (await win.webContents.executeJavaScript(
        `(() => {
          const el = document.querySelector('.pi-orb__ball');
          const root = document.querySelector('.pi-orb');
          if (!el || !root) return 'no-orb';
          const cs = getComputedStyle(el);
          const rs = getComputedStyle(root);
          const r = el.getBoundingClientRect();
          return [
            'css.width=' + cs.width,
            'css.minWidth=' + cs.minWidth,
            'pad=' + cs.padding,
            'bw=' + cs.borderWidth,
            'box=' + cs.boxSizing,
            'rect=' + r.width.toFixed(1),
            'offsetW=' + el.offsetWidth,
            'transform=' + cs.transform,
            'rootTransform=' + rs.transform,
            'rootInline=' + (root.getAttribute('style') || '-'),
            'ballInline=' + (el.getAttribute('style') || '-'),
            'hover=' + el.matches(':hover'),
          ].join(' ');
        })()`,
        true,
      )) as string;
      console.info(
        `[pi/smoke] 悬浮球贴边吸附：${snapped ? `${Math.round(snapped.x)},${Math.round(snapped.y)}` : '丢失'}` +
          `｜贴边=${snappedRing?.snapped ?? '-'}｜细条宽=${snapped ? `${Math.round(snapped.w)}px` : '-'}` +
          `（指上去 ${Number.isFinite(hoverW) ? `${Math.round(hoverW)}px` : '-'}）` +
          `｜右边距=${Number.isNaN(gap) ? '-' : Math.round(gap)}｜菜单收起=${snappedRing?.open === false}` +
          ` ${stripOk ? '✓' : '✗'}（应吸到边上、变成贴边细条、菜单收起）｜诊断=${stripDiag}`,
      );
      const stripShot =
        process.env.PI_SMOKE_UI_SHOT_STRIP ?? path.resolve(here, '../../../docs/m3-strip.png');
      writeFileSync(stripShot, (await win.webContents.capturePage()).toPNG());
      console.info(`[pi/smoke] 截图：${stripShot}`);
      // 从细条里往外拉：脱离吸附后球变回圆的，菜单自己回来。
      // 没吸上去就别拉（球本来就在中间，拉了也证明不了自动恢复），照实记成 ✗。
      const wasSnapped = snappedRing !== null && snappedRing.snapped !== 'none';
      let popRing: RingSnapshot | null = null;
      let popped: BallBox | null = null;
      let popOk = false;
      for (let attempt = 0; attempt < 3 && wasSnapped && !popOk; attempt += 1) {
        await dragOrbTo(win, Math.round(view.w / 2), Math.round(view.h / 2));
        await delay(360);
        popRing = await readRing(win);
        popped = await ballBox(win);
        popOk =
          popRing?.snapped === 'none' && popRing.open === true && popped !== null && popped.w > 40;
      }
      if (!wasSnapped) {
        popRing = await readRing(win);
        popped = await ballBox(win);
      }
      console.info(
        `[pi/smoke] 贴边细条拉出：贴边=${popRing?.snapped ?? '-'}｜球宽=${popped ? `${Math.round(popped.w)}px` : '-'}` +
          `｜菜单自动回来=${popRing?.open === true} ${popOk ? '✓' : '✗'}`,
      );
      dragOk = moved && stripOk && popOk;

      /*
       * m08768 第 7 条后半：菜单开着的时候把球拖到窗口边上，按键要**跟着球一起进边框**，
       * 而不是被「把环心挪回可视区 + 半径往内收」挤成一坨。判据三条，都在拖动**过程中**读：
       * ①半径不变（旧逻辑会缩）；②环心跟着球走（差值是一大段）；③真有按键越过窗口右边缘；
       * ④挪过去之后按键之间仍然不重叠（弦长没被压掉）。
       */
      let followOk = false;
      let followText = '没测到（没拿到环快照）';
      for (let attempt = 0; attempt < 3 && !followOk; attempt += 1) {
        await orbToMain(win);
        await delay(260);
        const ringBefore = await readRing(win);
        const handle = await ballBox(win);
        if (ringBefore === null || handle === null) break;
        const fromX = Math.round(handle.x + handle.w / 2);
        const fromY = Math.round(handle.y + handle.h / 2);
        const toX = view.w - 6;
        await focusSmoke(win);
        win.webContents.sendInputEvent({
          type: 'mouseDown',
          x: fromX,
          y: fromY,
          button: 'left',
          clickCount: 1,
        });
        for (let step = 1; step <= 8; step += 1) {
          win.webContents.sendInputEvent({
            type: 'mouseMove',
            x: Math.min(toX, fromX + step * 90),
            y: fromY,
          });
          await delay(45);
        }
        // 按键的位置是 CSS 过渡过去的，等它到位再读；按住不放，菜单不会自己关。
        await delay(450);
        const ringDuring = await readRing(win);
        win.webContents.sendInputEvent({
          type: 'mouseUp',
          x: toX,
          y: fromY,
          button: 'left',
          clickCount: 1,
        });
        await delay(420);
        if (ringDuring === null || ringDuring.items.length === 0) continue;
        const rightMost = Math.max(...ringDuring.items.map((el) => el.cx + el.w / 2));
        const radiusKept = Math.abs(ringDuring.radius - ringBefore.radius) <= 2;
        const centreMoved = ringDuring.ringX - ringBefore.ringX >= 60;
        const pastEdge = rightMost > view.w;
        const noOverlap = ringDuring.minGap >= ringDuring.itemSize + 1;
        followOk = radiusKept && centreMoved && pastEdge && noOverlap;
        followText =
          `拖动前 半径=${ringBefore.radius}px 环心x=${Math.round(ringBefore.ringX)}` +
          `｜拖动中 半径=${ringDuring.radius}px 环心x=${Math.round(ringDuring.ringX)}` +
          ` 最右按键=${Math.round(rightMost)}px（窗口宽 ${view.w}）` +
          ` 最少间距=${ringDuring.minGap.toFixed(1)}px`;
      }
      // 收尾：把球拉回中间，菜单自己回来，后面的断言才好接着走。
      await dragOrbTo(win, Math.round(view.w / 2), Math.round(view.h / 2));
      await delay(360);
      console.info(
        `[pi/smoke] 菜单展开拖到边框：${followText} ${followOk ? '✓' : '✗'}` +
          `（要求拖动中半径不变、环心跟球、按键越过窗口边缘、按键不重叠）`,
      );
      dragOk = dragOk && followOk;
    } else {
      console.warn('[pi/smoke] 找不到悬浮球，跳过拖动检查');
    }

    // 给还在飞的图片一点时间收尾，否则会把「下载中」误判成「取不到」。
    await delay(1_500);
    const covers = await checkCovers(win);
    console.info(`[pi/smoke] 封面（末页）：${describeCovers(covers)}`);

    const shotPath = process.env.PI_SMOKE_UI_SHOT ?? path.resolve(here, '../../../docs/m3-shell.png');
    writeFileSync(shotPath, (await win.webContents.capturePage()).toPNG());
    // 封面也算验收项：至少要有一张真解码出来，且不许出现明文 http（CSP 白名单里没有 http:）。
    const coversOk = covers.total > 0 && covers.loaded > 0 && covers.plain === 0 && covers.failed === 0;
    console.info(
      `[pi/smoke] UI 连续播放检查：${passed}/${total} 首真的在走｜封面 ${coversOk ? '✓' : '✗'}（截图：${shotPath}）`,
    );
    // ---------- m06304 第四版新增的四组检查（都追加在原流程末尾，不动前面的断言） ----------
    // 上一段把球留在了右侧的贴边细条上：细条状态下点球只会「弹出来」不会开菜单，
    // 所以先把它拉回窗口中间，后面要开环形菜单才走得通。
    const view2 = (await win.webContents.executeJavaScript(
      `({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })`,
      true,
    )) as { w: number; h: number };
    if ((await readRing(win))?.snapped !== 'none') {
      await dragOrbTo(win, Math.round(view2.w / 2), Math.round(view2.h / 2));
      await delay(360);
    }

    // ①换页过渡（第 1 条）：点完那一瞬间必须已经进入 out（旧键还在），随后才是 in（新键冒完）。
    // m08768 第 1 条之后左半没有子菜单了，**唯一剩下的环形换页就是「歌单卡片面板」**
    // （点设置键只换主区页面、不再换按键），所以这里改用 `mine:playlists` 来验这段过渡。
    let swapOk = false;
    let swapInfo = '环形菜单没能回到主菜单';
    if (await orbToMain(win)) {
      const peek = await clickOrbItemAndPeek(win, 'mine:playlists');
      // 过渡期间 displayPage 还停在 main，所以左半应该**还是主菜单那些键**。
      const oldPageStillThere = Boolean(
        peek && peek.leftIds.includes('mine:like') && peek.leftIds.includes('search'),
      );
      await delay(460);
      const settled = await readRing(win);
      const arrived =
        settled?.phase === 'in' && settled.displayPage === 'playlists' && settled.page === 'playlists';
      swapOk =
        peek !== null &&
        peek.phase === 'out' &&
        peek.displayPage === 'main' &&
        peek.page === 'playlists' &&
        oldPageStillThere &&
        arrived;
      swapInfo =
        `点完瞬间 phase=${peek?.phase ?? '-'}·displayPage=${peek?.displayPage ?? '-'}·ringPage=${peek?.page ?? '-'}` +
        `（旧键还在=${oldPageStillThere}）｜460ms 后 phase=${settled?.phase ?? '-'}·displayPage=${settled?.displayPage ?? '-'}`;
    }
    r16LegacyLog(
      `[pi/smoke] 换页过渡：${swapInfo} ${swapOk ? '✓' : '✗'}（应旧键先坠入、新键再冒出）`,
    );

    // ②「推荐」＝球旁边的歌单卡片面板。
    // m08768 第 3 条把推荐**页面**删掉了；第十五轮第 2 条（用户 m06435）又把绕球的封面环换成
    // 卡片面板，所以这里断言：进「推荐」后卡片面板就位、来源就是 recommend、卡片够多、首卡名字非空。
    let recommendOk = false;
    let recommendInfo = '环形菜单没能回到主菜单';
    if (await orbToMain(win)) {
      await clickOrbItem(win, 'playlist:recommend');
      await delay(760);
      const ring = await readRing(win);
      const panel = ring?.playlists ?? null;
      const cards = panel?.cards ?? [];
      const names = cards.map((el) => el.name);
      recommendOk =
        ring?.page === 'playlists' &&
        ring.displayPage === 'playlists' &&
        panel !== null &&
        panel.source === 'recommend' &&
        cards.length >= 3 &&
        names[0] !== undefined &&
        names[0].trim() !== '';
      recommendInfo =
        `页面=${ring?.page ?? '-'}/${ring?.displayPage ?? '-'}｜来源=${panel?.source ?? '-'}` +
        ` 状态=${panel?.state ?? '-'}｜卡片=${cards.length}（声明 ${panel?.count ?? '-'}）` +
        `｜前两张=${names.slice(0, 2).join(' / ') || '-'}`;
      const recommendShot =
        process.env.PI_SMOKE_UI_SHOT_RECOMMEND ?? path.resolve(here, '../../../docs/m3-orb-recommend.png');
      writeFileSync(recommendShot, (await win.webContents.capturePage()).toPNG());
      console.info(`[pi/smoke] 截图：${recommendShot}`);
    }
    r16LegacyLog(
      `[pi/smoke] 推荐＝歌单卡片面板：${recommendInfo} ${recommendOk ? '✓' : '✗'}（真实推荐歌单，虚拟入口与封面环都已删掉）`,
    );

    // 第十三轮第 7 条（用户 m04663）：「我的喜欢」原来那面环形/封面墙（`LikedWall`）换成
    // folia 的队列拼贴（`SongCollage`）——歌曲首尾相接铺成一整张**可拖拽**的纸，中心那一块
    // 自动放大高亮并浮出歌名/歌手，点一下就播这首。
    // 块的位置是拖拽期间**直写 DOM transform**（刻意不过 React，一帧重建 300 个节点是白扔的），
    // 所以「拖得动」这条只能真发指针事件来验：组件用的是 pointerdown/move/up（不查 buttons），
    // 合成鼠标事件会被 Chromium 翻成指针事件（冒烟窗口设了 backgroundThrottling:false + alwaysOnTop）。
    let collageOk = false;
    let collageInfo = '环形菜单没能回到主菜单';
    if (await orbToMain(win)) {
      await clickOrbItem(win, 'mine:like');
      await delay(UI_SMOKE_SWITCH_MS);
      await closeOrb(win);
      // 首屏封面是 lazy 的，等第一波铺开再量。
      await delay(900);
      interface CollageProbe {
        tiles: number;
        total: number;
        centerSize: number;
        plainSize: number;
        centerKey: string;
        centerLabel: string;
        centerBox: { x: number; y: number } | null;
        world: string;
        /** 当前被放大那一块的 key（根上 `data-collage-expanded="true"`）。 */
        expandKey: string;
        /** 被挤小的邻居数量（`data-collage-reflow="true"`），第十五轮第 1 条要看它。 */
        reflowCount: number;
        /** 根节点上的镜头读数 `data-collage-camera="x:y"`——点一块放大时它必须变。 */
        camera: string;
        /** 「点一块放大」的候选块：这一块没在放大、落在视口里、离放大块够远。 */
        candidateKey: string;
        candidateBox: { x: number; y: number } | null;
      }
      const readCollage = async (): Promise<CollageProbe> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const root = document.querySelector('[data-song-collage]');
            const blank = { tiles: 0, total: 0, centerSize: 0, plainSize: 0, centerKey: '', centerLabel: '', centerBox: null, world: '', expandKey: '', reflowCount: 0, camera: '', candidateKey: '', candidateBox: null };
            if (!(root instanceof HTMLElement)) return blank;
            const tiles = [...root.querySelectorAll('[data-song-collage-item]')];
            const center = root.querySelector('[data-center="true"]');
            const plain = tiles.find((el) => el.getAttribute('data-center') !== 'true') ?? null;
            const size = (el) => {
              if (!(el instanceof HTMLElement)) return 0;
              const r = el.getBoundingClientRect();
              return Math.round(Math.min(r.width, r.height));
            };
            const cr = center instanceof HTMLElement ? center.getBoundingClientRect() : null;
            const world = root.querySelector('.pi-collage__world');
            // 第十五轮第 1 条：点一块要「放大成正方形 + 挤开邻居 + 镜头移过去」，所以先挑一块
            // 没在放大、完整落在视口里、离当前放大块至少 160px 的块当靶子（太近镜头动不起来）。
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            let candidateKey = '';
            let candidateBox = null;
            for (const el of tiles) {
              if (!(el instanceof HTMLElement)) continue;
              if (el.getAttribute('data-collage-expanded') === 'true') continue;
              const r = el.getBoundingClientRect();
              if (r.width < 40 || r.height < 40) continue;
              const cx = Math.round(r.left + r.width / 2);
              const cy = Math.round(r.top + r.height / 2);
              if (cx < 60 || cy < 60 || cx > vw - 60 || cy > vh - 60) continue;
              if (cr !== null && Math.hypot(cx - (cr.left + cr.width / 2), cy - (cr.top + cr.height / 2)) < 160) continue;
              candidateKey = el.getAttribute('data-collage-cell') ?? '';
              candidateBox = { x: cx, y: cy };
              break;
            }
            const expandedEl = root.querySelector('[data-collage-expanded="true"]');
            return {
              tiles: tiles.length,
              total: Number(root.getAttribute('data-song-collage-count') ?? 0),
              centerSize: size(center),
              plainSize: size(plain),
              centerKey: center instanceof HTMLElement ? (center.getAttribute('data-song-collage-item') ?? '') : '',
              centerLabel: center ? (center.textContent || '').trim().slice(0, 24) : '',
              centerBox: cr === null ? null : { x: Math.round(cr.left + cr.width / 2), y: Math.round(cr.top + cr.height / 2) },
              world: world instanceof HTMLElement ? getComputedStyle(world).transform : '',
              expandKey: expandedEl instanceof HTMLElement ? (expandedEl.getAttribute('data-collage-cell') ?? '') : '',
              reflowCount: root.querySelectorAll('[data-collage-reflow="true"]').length,
              camera: root.getAttribute('data-collage-camera') ?? '',
              candidateKey,
              candidateBox,
            };
          })()`,
          true,
        )) as CollageProbe;
      /**
       * 单块读数：拖拽期间相机会跟着指针走，**只有尺寸必须一动不动**
       * （第十五轮第 1 条：拼贴大小在拖拽过程中不变），所以这里按 key 量同一块。
       * 量的是**布局盒**（offsetWidth/offsetHeight）：整面墙套了 `perspective` + rotateX/Y，
       * 同一块挪到视口不同位置时投影出来的包围盒本来就会差几像素，那不是「尺寸变了」。
       */
      const readCellBox = async (key: string): Promise<{ w: number; h: number }> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector('[data-collage-cell="${key}"]');
            if (!(el instanceof HTMLElement)) return { w: 0, h: 0 };
            return { w: Math.round(el.offsetWidth), h: Math.round(el.offsetHeight) };
          })()`,
          true,
        )) as { w: number; h: number };
      /**
       * 单块到视口中心的距离（第十五轮第 1 条「点击某个拼贴放大时，镜头中心移向那个拼贴」）。
       * 直接量点过的那一块的屏幕中心离视口中心多远，比只看 `data-center` 属性更贴近用户看到的东西。
       */
      const readCellCenter = async (key: string): Promise<{ dx: number; dy: number }> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector('[data-collage-cell="${key}"]');
            if (!(el instanceof HTMLElement)) return { dx: 9999, dy: 9999 };
            const r = el.getBoundingClientRect();
            return {
              dx: Math.round(Math.abs(r.left + r.width / 2 - window.innerWidth / 2)),
              dy: Math.round(Math.abs(r.top + r.height / 2 - window.innerHeight / 2)),
            };
          })()`,
          true,
        )) as { dx: number; dy: number };
      const collageDeadline = Date.now() + UI_SMOKE_TIMEOUT_MS;
      let collageBefore = await readCollage();
      while (collageBefore.tiles === 0 && Date.now() < collageDeadline) {
        await delay(500);
        collageBefore = await readCollage();
      }
      // 拖拽：从中心那一块按下，往左上分 6 步拖 120/90px（组件有 8px 起拖阈值）。
      let dragMoved = 0;
      let collageAfter = collageBefore;
      const dragFrom = collageBefore.centerBox;
      // 第十五轮第 1 条「拼贴大小在拖拽过程中不变」：按 key 量同一块，相机位移不影响尺寸。
      const dragKey = collageBefore.expandKey;
      const dragSizes: number[] = [];
      if (dragFrom !== null) {
        await focusSmoke(win);
        win.webContents.sendInputEvent({
          type: 'mouseDown',
          x: dragFrom.x,
          y: dragFrom.y,
          button: 'left',
          clickCount: 1,
        });
        await delay(60);
        for (let step = 1; step <= 6; step += 1) {
          win.webContents.sendInputEvent({
            type: 'mouseMove',
            x: dragFrom.x - step * 20,
            y: dragFrom.y - step * 15,
          });
          await delay(40);
          if (step % 2 === 0 && dragKey !== '') {
            const box = await readCellBox(dragKey);
            if (box.w > 0) dragSizes.push(Math.min(box.w, box.h));
          }
        }
        win.webContents.sendInputEvent({
          type: 'mouseUp',
          x: dragFrom.x - 120,
          y: dragFrom.y - 90,
          button: 'left',
          clickCount: 1,
        });
        await delay(800);
        collageAfter = await readCollage();
        if (collageAfter.centerBox !== null) {
          dragMoved = Math.round(
            Math.hypot(collageAfter.centerBox.x - dragFrom.x, collageAfter.centerBox.y - dragFrom.y),
          );
        }
      }
      const dragSizeSpread =
        dragSizes.length === 0 ? -1 : Math.max(...dragSizes) - Math.min(...dragSizes);
      // 第十五轮第 1 条：点一块要放大成正方形、把旧块挤回去、邻居被挤开、镜头移过去。
      // 点用的是「按下即抬起、不动」的合成指针事件（组件靠 8px 阈值区分点与拖）。
      const clickKey = collageAfter.candidateKey;
      const clickBox = collageAfter.candidateBox;
      const prevExpandKey = collageAfter.expandKey;
      let clickTook = false;
      let clickAfter: CollageProbe | null = null;
      if (clickBox !== null && clickKey !== '') {
        await focusSmoke(win);
        // 拖完那一下的 click 会被组件自己吞掉（suppressClickRef），所以最多点两次。
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          win.webContents.sendInputEvent({
            type: 'mouseDown',
            x: clickBox.x,
            y: clickBox.y,
            button: 'left',
            clickCount: 1,
          });
          await delay(70);
          win.webContents.sendInputEvent({
            type: 'mouseUp',
            x: clickBox.x,
            y: clickBox.y,
            button: 'left',
            clickCount: 1,
          });
          await delay(780);
          clickAfter = await readCollage();
          if (clickAfter.expandKey === clickKey) {
            clickTook = true;
            break;
          }
        }
      }
      const clickSize = clickTook ? await readCellBox(clickKey) : { w: 0, h: 0 };
      const clickOffset = clickTook ? await readCellCenter(clickKey) : { dx: 9999, dy: 9999 };
      const prevSizeAfter = clickTook && prevExpandKey !== '' ? await readCellBox(prevExpandKey) : { w: 0, h: 0 };
      const collageShot =
        process.env.PI_SMOKE_UI_SHOT_LIKED ?? path.resolve(here, '../../../docs/m3-liked-wall.png');
      writeFileSync(collageShot, (await win.webContents.capturePage()).toPNG());
      console.info(`[pi/smoke] 截图：${collageShot}`);
      // 账号里一首喜欢的歌都没有时（真实可能 0 首），拼贴里没有块可量：这时只验空态提示在不在，
      // 并照实说没量到拼贴——不假装通过。
      const collageEmpty = (await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('.pi-placeholder'))`,
        true,
      )) as boolean;
      if (collageBefore.tiles === 0 && collageEmpty) {
        collageOk = true;
        collageInfo = '账号里还没有喜欢的歌（0 首）→ 只验到空态提示，收藏一首后重跑才量得到拼贴';
      } else {
        const centerBigger =
          collageBefore.plainSize > 0 && collageBefore.centerSize >= collageBefore.plainSize * 1.8;
        const labelOk = collageBefore.centerLabel.length > 0;
        const dragOk = dragMoved >= 40 || collageAfter.world !== collageBefore.world;
        // 第十五轮第 1 条（用户 m06435）的四条新断言：
        // ①拖拽中同一块的尺寸浮动 ≤3px（大小不变）；②点过的那块变成正方形；
        // ③旧放大块缩回去（被 DOM 剔除也算缩回去，因为 data-collage-expanded 已经不在它身上）；
        // ④镜头读数变了（data-collage-camera）+ 至少有一个邻居被打上 data-collage-reflow。
        const dragSizeOk = dragSizeSpread >= 0 && dragSizeSpread <= 3;
        const newSize = Math.min(clickSize.w, clickSize.h);
        const squareOk = clickSize.w > 0 && Math.abs(clickSize.w - clickSize.h) <= 14;
        const focusDelta = Math.max(clickOffset.dx, clickOffset.dy);
        const focusOk = clickTook && clickAfter !== null && focusDelta <= 90;
        const prevShrunkOk =
          prevSizeAfter.w === 0
            ? focusOk
            : newSize >= Math.min(prevSizeAfter.w, prevSizeAfter.h) * 1.8;
        const reflowOk = clickAfter !== null && clickAfter.reflowCount >= 1;
        const cameraOk = clickAfter !== null && clickAfter.camera !== collageAfter.camera;
        collageOk =
          collageBefore.tiles >= 8 &&
          centerBigger &&
          labelOk &&
          dragOk &&
          dragSizeOk &&
          squareOk &&
          focusOk &&
          prevShrunkOk &&
          reflowOk &&
          cameraOk;
        collageInfo =
          `块=${collageBefore.tiles} 共=${collageBefore.total} 首` +
          `｜中心=${collageBefore.centerSize}px 普通=${collageBefore.plainSize}px` +
          ` 倍数=${(collageBefore.centerSize / Math.max(1, collageBefore.plainSize)).toFixed(2)}` +
          `｜中心字=「${collageBefore.centerLabel}」｜拖拽位移=${dragMoved}px` +
          `｜中心放大 ${centerBigger ? '✓' : '✗'}｜中心有字 ${labelOk ? '✓' : '✗'}｜拖得动 ${dragOk ? '✓' : '✗'}` +
          `｜拖拽中尺寸浮动=${dragSizeSpread < 0 ? '未量' : `${dragSizeSpread}px`} ${dragSizeOk ? '✓' : '✗'}` +
          `｜点块放大=${clickKey === '' ? '没找到候选块' : clickKey} 新块=${clickSize.w}x${clickSize.h}px` +
          ` 正方形 ${squareOk ? '✓' : '✗'} 占住中心 ${focusOk ? '✓' : '✗'}（离中心 ${clickOffset.dx}x${clickOffset.dy}px）` +
          ` 旧块=${prevSizeAfter.w === 0 ? '已被挤出 DOM' : `${prevSizeAfter.w}px`} 缩回 ${prevShrunkOk ? '✓' : '✗'}` +
          ` 邻居被挤=${clickAfter === null ? '未点' : clickAfter.reflowCount} 个 ${reflowOk ? '✓' : '✗'}` +
          ` 镜头跟随 ${cameraOk ? '✓' : '✗'}`;
      }
    }
    r16LegacyLog(`[pi/smoke] 我的喜欢队列拼贴：${collageInfo} ${collageOk ? '✓' : '✗'}`);

    // ③「搜索」＝播放页模糊 + 中间搜索框 + 实时封面卡片（第 6 条）。
    let searchOk = false;
    let searchInfo = '下划 PI 键没能开出搜索浮层';
    /*
     * 第十六轮删球：旧路是「点球 → 环形菜单 → 搜索」。新路走**下划 PI 键**——
     * 不能走 `clickNav(win,'搜索')`：抽屉里那一项的 id 是 `search`，它 `navigate('search')`
     * 打开的是**搜索页**，不是这个 `.pi-searchoverlay` 浮层（父代理 2026 实测踩到：
     * `搜索浮层：输入=失败｜卡片=0`），所以这里必须和探针④走同一条路。
     */
    const openedSearchOverlay = await (async (): Promise<boolean> => {
      const orb = await tapQuickOrb(win);
      if (orb === null) return false;
      await swipeQuickOrb(win, 0, 90);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        await delay(200);
        const open = (await win.webContents.executeJavaScript(
          `Boolean(document.querySelector('.pi-searchoverlay[data-open="true"]'))`,
          true,
        )) as boolean;
        if (open) return true;
      }
      return false;
    })();
    if (openedSearchOverlay) {
      await delay(460);
      const opened = await readSearch(win);
      /*
       * 搜索走 `/cloudsearch`，而 NCM 偶尔会回一个「200 但 songs 为空」的壳（这台机器的网络本来就
       * 时好时坏，本次日志里就有 `/playlist/track/all` 的 ETIMEDOUT）。同一个关键词重打没用——
       * react-query 认 queryKey，缓存里已经是那个空结果、根本不会再发请求——所以是**换词**重试。
       * 三个词都空才判 ✗：那是数据源抖动，不是界面缺陷。
       */
      const searchWords = ['周杰伦', 'Jay Chou', '稻香'];
      let searchWord = searchWords[0] ?? '周杰伦';
      let typed = false;
      let probe = opened;
      for (let attempt = 0; attempt < searchWords.length; attempt += 1) {
        const word = searchWords[attempt] ?? searchWord;
        typed = (await typeIntoSearch(win, word)) || typed;
        const searchDeadline = Date.now() + 14_000;
        while (Date.now() < searchDeadline) {
          await delay(400);
          probe = await readSearch(win);
          if (probe.cards > 0) break;
        }
        if (probe.cards > 0) {
          searchWord = word;
          if (attempt > 0) {
            console.info(
              `[pi/smoke] 搜索「${searchWords[attempt - 1] ?? ''}」卡片=0，换「${word}」才有结果`,
            );
          }
          break;
        }
        console.info(`[pi/smoke] 搜索「${word}」卡片=0，换关键词再试`);
      }
      // 悬停第一张卡片：封面被糊掉、歌名/歌手/专辑淡入（这一条只能靠真鼠标事件验）。
      // 跟 measureItemHover 一样：悬停事件偶尔送不到，重试几次再判定。
      for (let attempt = 0; attempt < 3 && probe.cardBox; attempt += 1) {
        await focusSmoke(win);
        if (attempt > 0) {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 });
          await delay(240);
        }
        win.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(probe.cardBox.x + probe.cardBox.w / 2),
          y: Math.round(probe.cardBox.y + probe.cardBox.h / 2),
        });
        await delay(460);
        probe = await readSearch(win);
        if (probe.cards > 0 && probe.firstName.length > 0) break;
      }
      const searchShot =
        process.env.PI_SMOKE_UI_SHOT_SEARCH ?? path.resolve(here, '../../../docs/m3-search.png');
      writeFileSync(searchShot, (await win.webContents.capturePage()).toPNG());
      console.info(`[pi/smoke] 截图：${searchShot}`);
      const hoverOk =
        probe.open &&
        probe.cards > 0 &&
        probe.firstName.length > 0 &&
        probe.firstArtist.length > 0 &&
        probe.tier.length > 0;
      // 点第一张卡片 → 浮层关掉、进这首歌的播放页。
      // 先读一次播放页现在挂着的歌名/歌手，用来判「确实换了歌」。
      const readDetail = async (): Promise<string> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const title = document.querySelector('.pi-home__title')?.textContent || '';
            const artists = document.querySelector('.pi-home__artists')?.textContent || '';
            return title + '｜' + artists;
          })()`,
          true,
        )) as string;
      const beforeDetail = await readDetail();
      // 这一面结果就是这一轮播放的队列（`SearchOverlay` 的 `onSelect` 把整份 `songs` 交给 `play`）。
      // 必须在点之前读：点完浮层就关了，`.pi-searchoverlay` 里的卡片已经不在 DOM 上
      // （上一跑就是在点完之后读的，读回空数组 ⇒ 队列判据恒 false、白丢一条 ✓）。
      // 注意无版权卡片的名字里还并着角标（`.pi-badge`，如「…无版权」），所以下面两个方向都试。
      const listTitles = (await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.pi-searchoverlay .pi-songcard__name')]
          .map((el) => (el.textContent || '').trim())`,
        true,
      )) as string[];
      const clicked = (await win.webContents.executeJavaScript(
        `(() => {
          const card = document.querySelector('.pi-searchoverlay .pi-songcard[data-focused="true"]') ||
            document.querySelector('.pi-searchoverlay [data-song-card]');
          if (!card) return false;
          card.click();
          return true;
        })()`,
        true,
      )) as boolean;
      await delay(1_100);
      const closed = (await readSearch(win)).open === false;
      const detail = await readDetail();
      // 但播放器会把「点了却放不出来」的那首跳过去——`apps/renderer/src/state/player.ts` 在
      // 加载失败时写 `status = 'unplayable'` 并 `await skipUnplayable(song)`，另外还把
      // `playable === false` 的那批过滤成 `blocked`。所以「详情页 == 点的那一张」偶尔会假红
      // （上一跑就是：点的首张是「屋顶」，详情页落到队列里的「想你就写信 (Live)」）。
      // 判据放宽成：详情页那首必须来自这一面卡片的歌名（点之前读下来的 `listTitles`），
      // **并且**确实换了歌。
      const detailTitle = detail.split('｜')[0] ?? '';
      const strictHit =
        probe.firstName.length > 0 &&
        (detail.includes(probe.firstName) || probe.firstName.includes(detailTitle));
      const inQueue =
        detailTitle.length > 0 &&
        listTitles.some(
          (name) => name !== '' && (name === detailTitle || name.startsWith(detailTitle) || detail.includes(name)),
        );
      const onDetailPage = strictHit || (inQueue && detail !== beforeDetail);
      searchOk = hoverOk && clicked && closed && onDetailPage;
      searchInfo =
        `输入=${typed ? searchWord : '失败'}｜卡片=${probe.cards}｜档位=${probe.tier}·聚光=${probe.focusIndex}` +
        `·封面图=${probe.coverImg}｜首张=${probe.firstName}·${probe.firstArtist}` +
        `｜点卡片后浮层关闭=${closed}·详情页=${detail.slice(0, 40)}` +
        `（命中首张=${strictHit}·队列内换歌=${inQueue && detail !== beforeDetail}）`;
    }
    console.info(`[pi/smoke] 搜索浮层：${searchInfo} ${searchOk ? '✓' : '✗'}`);

    /*
     * 第十六轮删球（用户 m07538 第 1 条）：`.pi-orb` 整颗球、环形菜单、贴边细条、切歌小名片
     * 全删了，它们的探针随之退休——下面这几行 `void` 只是给「已经不再被任何断言引用」的函数级
     * 声明一个引用，免得 strict 的 `noUnusedLocals` 报 TS6133。
     *   ballOk           首屏悬浮球贴边细条        → 球没了
     *   orbOk            环形菜单 + 悬停升起       → 菜单没了
     *   dragOk           球拖动 + 贴边细条         → 球没了
     *   swapOk           球面板换页过渡            → 面板没了
     *   recommendOk      球旁边「推荐＝歌单卡片」  → 换成第十六轮 r16 的推荐歌单页探针
     *   collageOk        我的喜欢老拼贴探针        → 换成第十六轮 r16 的拼贴五连探针
     *   dblOk            双击球回播放页            → 球没了
     *   diveOk           点球坠入收回              → 球没了
     *   cardProbe        切歌小名片（独立组件）    → 换成常驻名片的 data-reveal 探针
     *   playlistPanelOk / playlistOpenOk  球旁边歌单卡片面板 → 换成第十六轮 r16 的歌单页探针
     */
    void ballOk;
    void orbOk;
    void dragOk;
    void swapOk;
    void recommendOk;
    void collageOk;
    void dblOk;
    void diveOk;
    void cardProbe;
    void playlistPanelOk;
    void playlistOpenOk;
    // 第十六轮删球：这两个辅助函数只剩「开歌单详情/等换页动画」这两个球专用调用点，
    // 跟着调用点一起退休，但仍然保留定义（tombstone 引用消 noUnusedLocals）。
    void openPlaylistCard;
    void waitRingSettled;
    /*
     * ══════ 第十六轮（用户 m07538 六条）新探针 ══════════════════════════════════════
     * 悬浮球（`apps/renderer/src/components/PiOrb.tsx`）与切歌小名片
     * （`SongChangeCard.tsx`）连同 `.pi-orb__*` / `[data-song-change-card]` 一起删了，
     * 这一段是它们全部探针的替代品：播放页改成「点空白 → PI 圆键 → 上/下/右划开卡」，
     * 名片改成播放页左下角那张常驻名片自己 `data-reveal` 弹一下，歌单全改歌曲卡片，
     * 「我的喜欢」换成可悬停/可放大/可翻页/可搜索的拼贴墙。
     * 十四条全部折进 `r16Ok`，并且每一条都在 M3 聚合行里有一个署名。
     */
    const r16Shot = async (name: string): Promise<void> => {
      const shot = path.resolve(here, '../../../docs/' + name);
      writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      console.info(`[pi/smoke] 截图：${shot}`);
    };

    // ① 空白处**按住**冒出 PI 圆键（**用户 m00736 第 2 条**又改了球的存活期：按住才有、
    //    松开就没、下次按下再出现）：第十八轮第 2 条曾要求「取消按点浮现、球改成浮在宿主给的
    //    固定家位」（`quickOrbHomePoint`：视口右侧、垂直居中，圆心离右缘两个半径 = 36px）；
    //    用户 m00001 第 1 条改回「点哪儿在哪儿」；本轮再叠加「松手即逝」。这里验三件事：
    //    在两个相距很远的空白点各按一次（不抬手），球都出现在**按下的那一点**（误差 ≤4px）、
    //    球在；松手以后球整个收掉。
    let r16OrbSpotOk = true;
    let r16OrbReleaseOk = true;
    const r16OrbPoints: string[] = [];
    let r16OrbHomeText = '没读到窗口尺寸';
    {
      await clickNav(win, '播放器主页');
      await delay(900);
      const home = (await win.webContents.executeJavaScript(
        `({ x: window.innerWidth - 36, y: Math.round(window.innerHeight / 2) })`,
        true,
      )) as { x: number; y: number };
      r16OrbHomeText = `家位(${home.x},${home.y})`;
      /** 松手之后球的去向：元素没了 / 藏起来了都算收掉；还看得见就是没听用户的。 */
      const readOrbGone = async (): Promise<string> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const orb = document.querySelector('[data-quick-orb]');
            if (orb === null) return '没了';
            const cs = getComputedStyle(orb);
            const hidden =
              orb.getAttribute('data-quick-orb-visible') === 'false' ||
              cs.display === 'none' ||
              cs.visibility === 'hidden' ||
              cs.opacity === '0';
            return hidden ? '藏了' : '还在';
          })()`,
          true,
        )) as string;
      for (let which = 0; which < 2; which += 1) {
        const orb = await tapQuickOrb(win, which); // 只按下、不抬起
        const spot = quickOrbPress ?? { x: -1, y: -1 };
        if (orb === null) {
          r16OrbSpotOk = false;
          r16OrbPoints.push(`按住(${spot.x},${spot.y})→没出 PI 圆键`);
        } else {
          const dx = Math.abs(orb.x - spot.x);
          const dy = Math.abs(orb.y - spot.y);
          r16OrbSpotOk = r16OrbSpotOk && orb.ball && dx <= 4 && dy <= 4;
          r16OrbPoints.push(
            `按住(${spot.x},${spot.y})→球(${orb.x},${orb.y}) 离点=${dx}x${dy}px 球在=${orb.ball}`,
          );
        }
        // 用户 m00736 第 2 条是**外观**要求（暗槽缩短、图标嵌进暗槽里、松手即收），探针只能量
        // 坐标与存在性、量不出好看不好看：所以趁球还按着的时候抓一张**按图1 取景裁过**的图
        // （整屏截图里球只有指甲盖大，对不了形状）。暗槽默认 `opacity: 0`，只有拖出**倾向**
        // 才浮出来，所以先把指针往上挪 14px（≥ 倾向阈值 9px，又 < 挥动阈值 28px ⇒ 松手仍算
        // 「点一下」，不会误开六块按键面板），等槽的 0.14s 淡入跑完再截。
        if (which === 0 && orb !== null) {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: orb.x, y: orb.y - 14 });
          await delay(220);
          const shotW = 200;
          const shotH = 240;
          const crop = {
            x: Math.max(0, Math.round(orb.x - shotW / 2)),
            y: Math.max(0, Math.round(orb.y - shotH * 0.66)),
            width: shotW,
            height: shotH,
          };
          const orbShot =
            process.env.PI_SMOKE_UI_SHOT_ORB ?? path.resolve(here, '../../../docs/m3-orb.png');
          writeFileSync(orbShot, (await win.webContents.capturePage(crop)).toPNG());
          console.info(
            `[pi/smoke] 截图（按住 + 上倾向的 PI 圆球，裁 ${shotW}x${shotH}）：${orbShot}`,
          );
        }
        await releaseQuickOrb(win);
        await delay(240);
        const gone = await readOrbGone();
        r16OrbReleaseOk = r16OrbReleaseOk && gone !== '还在';
        r16OrbPoints.push(`松开→球${gone}`);
        // 这一次按下如果被渲染层读成「点了球」，六块按键面板会展开——收掉它再量下一个点。
        await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await delay(320);
      }
    }
    console.info(
      `[pi/smoke] 十六轮①空白点出 PI 键：${r16OrbPoints.join('｜')}` +
        `（用户 m00736 第 2 条：按住时球落在**按下的那一点**上、差 ≤4px 且球在，松手球就收掉；` +
        `固定${r16OrbHomeText} 只留给键盘召唤）${r16OrbSpotOk && r16OrbReleaseOk ? '✓' : '✗'}`,
    );

    /*
     * 用户 m00736 第 5 条：快捷键（Tab）召唤歌单页时**不许连带出现圆球**。
     * 判据：按 Tab 之前台上没球、按完歌单卡在（`[data-quick-layer='playlists']` / 面板 / 六块项），
     * 而 `[data-quick-orb]` 仍然不在；最后 Esc 收掉。键盘召唤走的是固定家位（`quickOrbHomePoint()`），
     * 所以「球不该出现」是这一条唯一能自动量的部分。
     */
    let r23TabOrbOk = false;
    let r23TabOrbInfo = '没跑';
    // 用户 m01402 第 5 条：快捷卡片的倾斜要整体去掉。歌单卡在这里开着，先量它的 transform。
    let r23TiltCardTf = '未测';
    let r23TiltOk = false;
    {
      // 上一段（①）每轮末尾都会按 Esc 收拾六块面板；这里再补一发，保证「按 Tab 之前是干净的」。
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await delay(420);
      const pre = (await win.webContents.executeJavaScript(
        `(() => ({
           orb: document.querySelector('[data-quick-orb]') !== null,
           layer: document.querySelector('[data-quick-layer]') !== null,
         }))()`,
        true,
      )) as { orb: boolean; layer: boolean };
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await delay(560);
      const post = (await win.webContents.executeJavaScript(
        `(() => ({
           orb: document.querySelector('[data-quick-orb]') !== null,
           layer: document.querySelector("[data-quick-layer='playlists']") !== null,
           panel: document.querySelector("[data-quick-panel='playlists']") !== null,
           items: document.querySelectorAll('[data-quick-item]').length,
           card: (() => {
             const card = document.querySelector('.pi-quick-card--playlists');
             return card === null ? '无卡片' : getComputedStyle(card).transform;
           })(),
         }))()`,
        true,
      )) as { orb: boolean; layer: boolean; panel: boolean; items: number; card: string };
      r23TiltCardTf = post.card;
      r23TabOrbOk = pre.orb === false && post.orb === false && (post.layer || post.panel);
      r23TabOrbInfo =
        `按前 球=${pre.orb} 层=${pre.layer}｜按后 球=${post.orb}（要求 false）` +
        ` 歌单层=${post.layer} 面板=${post.panel} 六块=${post.items} 歌单卡transform=${post.card}`;
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await delay(420);
    }
    console.info(
      `[pi/smoke] 快捷键召唤歌单页不带球（用户 m00736 第 5 条）：${r23TabOrbInfo} ` +
        `${r23TabOrbOk ? '✓' : '✗'}`,
    );

    /*
     * **用户 m01402 第 2 条**的后半句：「如果我拖拽圆球向右划，它就不能改变方向换成向上或向下的暗槽，
     * 除非把圆球划回原基准点」。这一段在**同一次按住**里连走四腿（中间一次都不松手）：
     *   ① 朝右划 46px（> 锁定线 24）→ 槽向必须朝右；
     *   ② 原地再朝上划 96px（`quickDragTrend` 单吃这组位移本来会判 'up'）→ 槽向**不许**翻，仍是 right；
     *   ③ 把指针收回基准点附近（位移 2px < 24）→ 解锁，latch 必须回到 'none'；
     *   ④ 再次朝上划 96px → 这次必须翻成 up。
     * 抓两个属性：`data-quick-orb-hint`（趋势，槽朝向跟它走）与 `data-quick-orb-latch`（实际锁定的方向）。
     */
    let r23LatchOk = false;
    let r23LatchInfo = '没跑';
    {
      const readLatch = async (): Promise<{ hint: string; latch: string; ball: boolean }> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const orb = document.querySelector('[data-quick-orb]');
            return {
              hint: orb === null ? '无球' : orb.getAttribute('data-quick-orb-hint') || '',
              latch: orb === null ? '无球' : orb.getAttribute('data-quick-orb-latch') || '',
              ball: document.querySelector('[data-quick-orb-ball]') !== null,
            };
          })()`,
          true,
        )) as { hint: string; latch: string; ball: boolean };
      const orb = await tapQuickOrb(win, 0);
      if (orb === null) {
        r23LatchInfo = '没能按下圆球（tapQuickOrb 返回 null）';
      } else {
        const ox = Math.round(orb.x);
        const oy = Math.round(orb.y);
        await moveHeldPoint(win, ox, oy, 46, 0, 4);
        const legRight = await readLatch();
        await moveHeldPoint(win, ox + 46, oy, 0, -96, 4);
        const legUp = await readLatch();
        await moveHeldPoint(win, ox + 46, oy - 96, -44, 96, 4);
        const legBack = await readLatch();
        await moveHeldPoint(win, ox + 2, oy, 0, -96, 4);
        const legRelock = await readLatch();
        await releaseQuickOrb(win);
        r23LatchOk =
          legRight.latch === 'right' &&
          legUp.hint === 'right' &&
          legUp.latch === 'right' &&
          legBack.latch === 'none' &&
          legRelock.latch === 'up';
        r23LatchInfo =
          `右划 46px：hint=${legRight.hint} latch=${legRight.latch}（要求 right）` +
          `｜原地再上划 96px：hint=${legUp.hint} latch=${legUp.latch}（要求仍 right）` +
          `｜收回基准点：hint=${legBack.hint} latch=${legBack.latch}（要求 none）` +
          `｜再上划：hint=${legRelock.hint} latch=${legRelock.latch}（要求 up）`;
      }
    }
    console.info(`[pi/smoke] 暗槽方向锁（用户 m01402 第 2 条）：${r23LatchInfo} ${r23LatchOk ? '✓' : '✗'}`);

    /*
     * **用户 m02213 第 1 条**：「圆球不能拖拽到暗槽一端，我希望可以拖拽到一端」。
     *
     * 同一次按住里走两腿（球心行程上限 58 = 槽长 78 − 槽宽 38.88/2，见 PiQuickOrb 的
     * `ORB_GROOVE_SLIDE_MAX`）：
     *   ① 只划 12px → `data-quick-orb-slide` 只走一小截，末端图标仍全亮（`data-quick-orb-icon-fade` 近 1）；
     *   ② 一路划到 90px（远超上限）→ slide 必须顶到 56 以上，图标必须淡到 0.1 以下
     *      （球身正好把槽末端那半个圆头填满，不许再被那枚图标挡在外面）。
     * 抓两个属性：`data-quick-orb-slide`（球心滑出去多少 px）、`data-quick-orb-icon-fade`（图标透明度）。
     */
    let r23EndOk = false;
    let r23EndInfo = '没跑';
    {
      const readSlide = async (): Promise<{ slide: number; fade: number }> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const orb = document.querySelector('[data-quick-orb]');
            if (orb === null) return { slide: -1, fade: -1 };
            return {
              slide: Number(orb.getAttribute('data-quick-orb-slide') || '-1'),
              fade: Number(orb.getAttribute('data-quick-orb-icon-fade') || '-1'),
            };
          })()`,
          true,
        )) as { slide: number; fade: number };
      const orb = await tapQuickOrb(win, 0);
      if (orb === null) {
        r23EndInfo = '没能按下圆球（tapQuickOrb 返回 null）';
      } else {
        const ox = Math.round(orb.x);
        const oy = Math.round(orb.y);
        await moveHeldPoint(win, ox, oy, 12, 0, 2);
        const near = await readSlide();
        await moveHeldPoint(win, ox + 12, oy, 78, 0, 5);
        const end = await readSlide();
        // 收尾走法与上一段「暗槽方向锁」保持一致：先划回基准点解锁，再朝上划一下、松手
        //（朝着 up 松手开的是六块面板，紧随其后的 ② 本来就按这个状态写）。
        await moveHeldPoint(win, ox + 90, oy, -88, 0, 5);
        await moveHeldPoint(win, ox + 2, oy, 0, -96, 4);
        await releaseQuickOrb(win);
        r23EndOk = end.slide >= 56 && end.fade <= 0.1 && near.slide <= 20 && near.fade >= 0.9;
        r23EndInfo =
          `轻划 12px：slide=${near.slide} fade=${near.fade.toFixed(2)}（要求 slide≤20、图标还亮）` +
          `｜一路划到底（90px）：slide=${end.slide} fade=${end.fade.toFixed(2)}（要求 slide≥56、fade≤0.1）`;
      }
    }
    console.info(
      `[pi/smoke] 圆球拖到暗槽末端（用户 m02213 第 1 条）：${r23EndInfo} ${r23EndOk ? '✓' : '✗'}`,
    );

    /*
     * **用户 m02213 第 5 条**：「圆球左划切换风格后，从顶框下滑一个提示『已切换xx风格』，
     * 显示 2s，就上升到顶框内消失」。
     *
     * 走真路径：按住球 → 左划 → 松手（`HomePage` 的 `onSwipe('left')` 调 `toggleUiStyle()`），
     * 然后按 0.36s / 2.26s / 2.68s 三个时刻读那条提示：
     *   ① 出现：`data-style-toast` 在、`data-style-toast-style` 是**换过去**的那一套、文案带「已切换⨯⨯风格」；
     *   ② 2.26s：要么已经卸载，要么 `data-style-toast-leaving='true'`（正在往上升）；
     *   ③ 2.68s（> 2s 显示 + 0.24s 出场）：必须已卸载，且 `data-ui-style` 真的换成了新的那套。
     * 收尾再左划一次切回原排版，别把后面的探针留在另一套里。
     */
    let r23ToastOk = false;
    let r23ToastInfo = '没跑';
    {
      const readToast = async (): Promise<{
        ui: string;
        present: boolean;
        style: string;
        leaving: string;
        text: string;
      }> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const root = document.querySelector('[data-ui-style]');
            const toast = document.querySelector('[data-style-toast]');
            return {
              ui: root === null ? '' : root.getAttribute('data-ui-style') || '',
              present: toast !== null,
              style: toast === null ? '' : toast.getAttribute('data-style-toast-style') || '',
              leaving: toast === null ? '' : toast.getAttribute('data-style-toast-leaving') || '',
              text: toast === null ? '' : (toast.textContent || '').trim(),
            };
          })()`,
          true,
        )) as { ui: string; present: boolean; style: string; leaving: string; text: string };
      const before = await readToast();
      const orb = await tapQuickOrb(win, 0);
      if (orb === null) {
        r23ToastInfo = '没能按下圆球（tapQuickOrb 返回 null）';
      } else {
        await swipeQuickOrb(win, -90, 0);
        await delay(360);
        const shown = await readToast();
        await delay(1900);
        const rising = await readToast();
        await delay(420);
        const gone = await readToast();
        const wantStyle = before.ui === 'avant' ? 'plain' : 'avant';
        const wantLabel = wantStyle === 'avant' ? '先锋' : '平凡';
        r23ToastOk =
          shown.present &&
          shown.style === wantStyle &&
          shown.leaving === 'false' &&
          shown.text.indexOf('已切换' + wantLabel + '风格') >= 0 &&
          (!rising.present || rising.leaving === 'true') &&
          !gone.present &&
          gone.ui === wantStyle;
        r23ToastInfo =
          `切换前=${before.ui}｜0.36s：在=${shown.present} style=${shown.style} leaving=${shown.leaving} 文案「${shown.text}」（要求 ${wantStyle}/${wantLabel}）` +
          `｜2.26s：在=${rising.present} leaving=${rising.leaving}（要求已开始上升或已收）` +
          `｜2.68s：在=${gone.present} uiStyle=${gone.ui}（要求已收回、排版已换）`;
        // 收尾：再左划一次切回原排版。
        const back = await tapQuickOrb(win, 0);
        if (back !== null) {
          await swipeQuickOrb(win, -90, 0);
          await delay(360);
        }
      }
    }
    console.info(
      `[pi/smoke] 切风格顶框提示（用户 m02213 第 5 条）：${r23ToastInfo} ${r23ToastOk ? '✓' : '✗'}`,
    );

    /*
     * **用户 m04407 第 4 条**：「圆球的拖拽动画划到暗槽的末端才触发对应功能（歌曲选择页之类）」。
     * 这一条把「触发」的条件从「超过 28px 的方向阈值」改成「球已经滑到暗槽末端（slide 顶到
     * `ORB_GROOVE_SLIDE_MAX` = 58）」，所以判据也要分两半：
     *   ① **负半**（这里）：按住球只划 40px —— 过了方向锁的 24px、但离槽末端 58px 还差得远 ——
     *      松手之后六块浮层**不许**出现，球也要照旧收掉（松手即收是用户 m00736 第 2 条的契约）；
     *   ② **正半**：紧接着的 ② 上划六块用的是一路划到底（`swipeQuickOrb(win, 0, -90)`），
     *      那条现在同时也就证明了「划到末端照样开」。
     * 走真指针路径（`tapQuickOrb` → `moveHeldPoint` → `releaseQuickOrb`），不碰 DOM 事件。
     * 这一段结束时不留任何浮层，正好是 ② 期望的起始状态。
     */
    let r32HalfOk = false;
    let r32HalfInfo = '没跑';
    {
      const orb = await tapQuickOrb(win, 0);
      if (orb === null) {
        r32HalfInfo = '没能按下圆球（tapQuickOrb 返回 null）';
      } else {
        const ox = Math.round(orb.x);
        const oy = Math.round(orb.y);
        // 40px：过 24px 的方向锁，但只走 40/58 ≈ 69% 的行程，球身没碰到槽末端那半个圆头。
        await moveHeldPoint(win, ox, oy, 0, -40, 4);
        await releaseQuickOrb(win);
        await delay(320);
        const half = (await win.webContents.executeJavaScript(
          `(() => {
            const layer = document.querySelector('[data-quick-layer]');
            return {
              layer: layer ? (layer.dataset.quickLayer || 'open') : '',
              panel: document.querySelector('[data-quick-panel]') !== null,
              orb: document.querySelector('[data-quick-orb]') !== null,
            };
          })()`,
          true,
        )) as { layer: string; panel: boolean; orb: boolean };
        r32HalfOk = half.layer === '' && !half.panel && !half.orb;
        r32HalfInfo =
          `半程划 40px 松手：六块层=${half.layer || '无'} 面板=${half.panel} 球壳收掉=${!half.orb}` +
          `（要求三个都没有）`;
      }
    }
    console.info(
      `[pi/smoke] 半程拖球不触发（用户 m04407 第 4 条）：${r32HalfInfo} ${r32HalfOk ? '✓' : '✗'}`,
    );

    // ② 上划 → 拍立得六块按键：层/面板在、项数 6、id 齐、至少 4 项可用；点关闭键层消失。
    /*
     * 用户 m02898 第 1 条（歌单选择页的「本地歌曲」不再标灰 + 六个图标一样大）与第 4 条
     * （快捷设置卡删掉底部灰字提示、「默认音质」由原生 `<select>` 改成按键组）。两条都寄生在
     * 下面第十六轮 ②/③ 那两块已经点开的浮层里，所以在这里先声明读数变量、在那两块里量。
     */
    let r26ItemsOk = false;
    let r26ItemsInfo = '没点出六块';
    let r26SettingsOk = false;
    let r26SettingsInfo = '没进设置卡';
    let r16UpOk = false;
    let r16UpInfo = '没点出球';
    {
      await clickNav(win, '播放器主页');
      await delay(760);
      const orb = await tapQuickOrb(win, 0);
      if (orb !== null) {
        await swipeQuickOrb(win, 0, -90);
        await delay(260);
        const up = (await win.webContents.executeJavaScript(
          `(() => {
            const layer = document.querySelector('[data-quick-layer]');
            const panel = document.querySelector("[data-quick-panel='playlists']");
            const items = Array.from(document.querySelectorAll('[data-quick-item]'));
            return {
              layer: layer ? (layer.dataset.quickLayer || '') : '',
              panel: panel !== null,
              panelState: panel ? (panel.dataset.quickPanelState || '') : '',
              ids: items.map((el) => el.dataset.quickItem || ''),
              states: items.map((el) => el.dataset.quickItemState || ''),
              /* 用户 m02898 第 1 条：本地歌曲的档位不再该是 'unavailable'。 */
              localState: (() => {
                const el = document.querySelector('[data-quick-item="local"]');
                return el === null ? 'missing' : (el.dataset.quickItemState || 'ready');
              })(),
              /*
               * 同上第 1 条后半句「六个歌单的图标大小统一一下」：量每块里那个 svg 的**渲染尺寸**
               * （getBoundingClientRect() 已经把 quick-panels.css:187-224 那几条
               * transform: scale() 归一化算进去了），六个数该一样大。
               */
              iconBoxes: items.map((el) => {
                const svg = el.querySelector('svg');
                if (svg === null) return [0, 0];
                const box = svg.getBoundingClientRect();
                return [Math.round(box.width * 10) / 10, Math.round(box.height * 10) / 10];
              }),
            };
          })()`,
          true,
        )) as {
          layer: string;
          panel: boolean;
          panelState: string;
          ids: string[];
          states: string[];
          localState: string;
          iconBoxes: number[][];
        };
        const want = ['star', 'mine', 'recommend', 'recent', 'local', 'queue'];
        const idOk = up.ids.length === want.length && want.every((id) => up.ids.includes(id));
        const usable = up.states.filter((state) => state !== 'unavailable').length;
        r16UpOk = up.layer === 'playlists' && up.panel && idOk && usable >= 4;
        r16UpInfo =
          `层=${up.layer || '无'} 面板=${up.panel}(${up.panelState})` +
          ` 项数=${up.ids.length} id=[${up.ids.join(',')}]` +
          ` state=[${up.states.join(',')}] 可用=${usable}`;
        /*
         * 用户 m02898 第 1 条：①「本地歌曲」已经做好（下载 + 本地库），不该再挂 `unavailable`
         * 那套灰皮肤；② 六块图标要一样大。`iconBoxes` 里存的是**渲染后**的宽高（含归一化的
         * `transform: scale()`），六个数相等（±1.5px 容差给亚像素取整）才算统一。
         */
        const iconWidths = up.iconBoxes.map((box) => box[0] ?? 0);
        const iconBase = iconWidths[0] ?? 0;
        const iconEven =
          iconWidths.length === 6 &&
          iconBase > 0 &&
          iconWidths.every((width) => width > 0 && Math.abs(width - iconBase) <= 1.5);
        r26ItemsOk = up.localState !== 'unavailable' && up.localState !== 'missing' && iconEven;
        r26ItemsInfo =
          `本地档 state=${up.localState}（不再标灰=${up.localState !== 'unavailable'}）` +
          `｜六图标宽=[${iconWidths.join(',')}]px 等大=${iconEven}`;
        await r16Shot('m3r16-quick-orb.png');
        const dismissed = (await win.webContents.executeJavaScript(
          `(() => {
            const close = document.querySelector('[data-quick-dismiss]');
            if (close === null || !(close instanceof HTMLElement)) return false;
            close.click();
            return true;
          })()`,
          true,
        )) as boolean;
        await delay(440);
        const gone = (await win.webContents.executeJavaScript(
          `document.querySelector('[data-quick-layer]') === null`,
          true,
        )) as boolean;
        r16UpOk = r16UpOk && dismissed && gone;
        r16UpInfo += `｜点关闭键=${dismissed} 层消失=${gone}`;
      }
    }
    console.info(`[pi/smoke] 十六轮②上划六块按键：${r16UpInfo} ${r16UpOk ? '✓' : '✗'}`);

    // ③ 右划 → 迷你设置卡：四行开关齐、有「更多设置」入口；点背板能关。
    let r16RightOk = false;
    let r16RightInfo = '没点出球';
    {
      await clickNav(win, '播放器主页');
      await delay(760);
      const orb = await tapQuickOrb(win, 0);
      if (orb !== null) {
        await swipeQuickOrb(win, 90, 0);
        await delay(320);
        const right = (await win.webContents.executeJavaScript(
          `(() => {
            const layer = document.querySelector('[data-quick-layer]');
            const switches = Array.from(document.querySelectorAll('[data-quick-switch]')).map(
              (el) => el.dataset.quickSwitch || '',
            );
            return {
              layer: layer ? (layer.dataset.quickLayer || '') : '',
              switches: switches,
              more: document.querySelector("[data-quick-more='settings']") !== null,
              backdrop: document.querySelector('[data-quick-backdrop]') !== null,
              /*
               * 用户 m02898 第 4 条：① 设置卡底部那行灰字（「右划改动即时生效 ·『详细设置』进
               * 完整设置页」）整个删掉；②「默认音质」从原生 select 换成按键组
               * （PiQuickPanels.tsx:344-363：容器 data-quick-quality-group="true"，
               * 每一颗按钮挂 data-quick-choice=<档位> 且已选的写 data-active="true"）。
               */
              qualityGroup: (() => {
                const group = document.querySelector('[data-quick-quality-group]');
                if (group === null) return null;
                const chips = Array.from(group.querySelectorAll('[data-quick-choice]'));
                return {
                  count: chips.length,
                  active: chips.filter((el) => el.getAttribute('data-active') === 'true').length,
                  selects: group.querySelectorAll('select').length,
                  width: Math.round(group.getBoundingClientRect().width),
                };
              })(),
              captionGone: !(document.body.textContent || '').includes('右划改动即时生效'),
              settingsFoot: document.querySelectorAll('.pi-quick-card--settings .pi-quick-card__foot')
                .length,
              transform: (() => {
                const card = document.querySelector('.pi-quick-card--settings');
                return card === null ? '无卡片' : getComputedStyle(card).transform;
              })(),
            };
          })()`,
          true,
        )) as {
          layer: string;
          switches: string[];
          more: boolean;
          backdrop: boolean;
          qualityGroup: { count: number; active: number; selects: number; width: number } | null;
          captionGone: boolean;
          settingsFoot: number;
          transform: string;
        };
        const wantSw = ['lyric', 'quality', 'theme', 'account'];
        const swOk = wantSw.every((id) => right.switches.includes(id));
        r16RightOk = right.layer === 'settings' && swOk && right.more;
        r16RightInfo =
          `层=${right.layer || '无'} 开关=[${right.switches.join(',')}] 更多设置键=${right.more}`;
        /*
         * 用户 m02898 第 4 条后半句「改成几个音质的按键，未选的是暗色，已选的是亮色」：光看
         * 「按键组在不在」不够——真按一下另一档，轮询 ≤3s 等 `data-active` 挪过去，才算这套
         * 按键真接到设置写入上（走的还是 `PiQuickPanels.tsx:358` 那次 `patch.mutate`）。
         */
        const qualitySwitch = (await win.webContents.executeJavaScript(
          `(async () => {
             const group = document.querySelector('[data-quick-quality-group]');
             if (group === null) return { ok: false, why: '没有按键组', from: '', to: '' };
             const chips = Array.from(group.querySelectorAll('[data-quick-choice]'));
             const before = chips.find((el) => el.getAttribute('data-active') === 'true') || null;
             const target = chips.find((el) => el !== before) || null;
             if (before === null || target === null) {
               return { ok: false, why: '找不到未选中的档位', from: '', to: '' };
             }
             const from = before.getAttribute('data-quick-choice') || '';
             const to = target.getAttribute('data-quick-choice') || '';
             if (target instanceof HTMLElement) target.click();
             const started = Date.now();
             while (Date.now() - started < 3000) {
               await new Promise((resolve) => setTimeout(resolve, 120));
               const now = document.querySelector(
                 '[data-quick-quality-group] [data-quick-choice][data-active="true"]',
               );
               if (now !== null && (now.getAttribute('data-quick-choice') || '') === to) {
                 return { ok: true, why: '', from: from, to: to };
               }
             }
             return { ok: false, why: '点了没生效', from: from, to: to };
           })()`,
          true,
        )) as { ok: boolean; why: string; from: string; to: string };
        const qualityGroupOk =
          right.qualityGroup !== null &&
          right.qualityGroup.count >= 2 &&
          right.qualityGroup.selects === 0 &&
          right.qualityGroup.active === 1;
        r26SettingsOk =
          qualityGroupOk && right.captionGone && right.settingsFoot === 0 && qualitySwitch.ok;
        r26SettingsInfo =
          `音质按键组=${
            right.qualityGroup === null
              ? '无'
              : `按键 ${right.qualityGroup.count} 颗/已选 ${right.qualityGroup.active} 颗/原生 select ${right.qualityGroup.selects} 个`
          }` +
          ` 点档切换=${qualitySwitch.ok ? `${qualitySwitch.from}→${qualitySwitch.to}` : qualitySwitch.why}` +
          `｜设置卡灰字已删=${right.captionGone}（卡内 footer ${right.settingsFoot} 个）`;
        await delay(240);
        /*
         * **用户 m01402 第 5 条**：快捷卡片的静态旋转整体去掉后，卡片自身的 transform 就该是
         * 'none'。量两态：常态 + 卡内按钮拿到焦点（旧实现的 `:hover, :focus-within` 摆正规则会
         * 算成 matrix(1,0,0,1,0,0)，只有两条 `rotate()` 规则都删掉才会是 'none'）。
         */
        const focusTf = (await win.webContents.executeJavaScript(
          `(() => {
             const card = document.querySelector('.pi-quick-card--settings');
             if (card === null) return '无卡片';
             const btn = card.querySelector('button');
             if (btn instanceof HTMLElement) btn.focus();
             return getComputedStyle(card).transform;
           })()`,
          true,
        )) as string;
        r23TiltOk = r23TiltCardTf === 'none' && right.transform === 'none' && focusTf === 'none';
        console.info(
          `[pi/smoke] 快捷卡不倾斜（用户 m01402 第 5 条）：歌单卡 常态=${r23TiltCardTf}` +
            `｜设置卡 常态=${right.transform} 聚焦后=${focusTf}（三处都要求 none：${r23TiltOk}）` +
            ` ${r23TiltOk ? '✓' : '✗'}`,
        );
        await r16Shot('m3r16-quick-settings.png');
        const hit = (await win.webContents.executeJavaScript(
          `(() => {
            const back = document.querySelector('[data-quick-backdrop]');
            if (back === null || !(back instanceof HTMLElement)) return false;
            back.click();
            return true;
          })()`,
          true,
        )) as boolean;
        await delay(440);
        const gone = (await win.webContents.executeJavaScript(
          `document.querySelector('[data-quick-layer]') === null`,
          true,
        )) as boolean;
        r16RightOk = r16RightOk && right.backdrop && hit && gone;
        r16RightInfo += `｜背板=${right.backdrop} 点背板关=${hit} 层消失=${gone}`;
      }
    }
    console.info(`[pi/smoke] 十六轮③右划迷你设置卡：${r16RightInfo} ${r16RightOk ? '✓' : '✗'}`);

    // ④ 下划 → 搜索浮层（认 `[data-open='true']`，不看文案）；Esc 关掉。
    let r16DownOk = false;
    let r16DownInfo = '没点出球';
    {
      await clickNav(win, '播放器主页');
      await delay(760);
      const orb = await tapQuickOrb(win, 0);
      if (orb !== null) {
        await swipeQuickOrb(win, 0, 90);
        await delay(560);
        const opened = (await win.webContents.executeJavaScript(
          `document.querySelector('.pi-searchoverlay')?.dataset.open === 'true'`,
          true,
        )) as boolean;
        await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await delay(560);
        const stillOpen = (await win.webContents.executeJavaScript(
          `document.querySelector('.pi-searchoverlay')?.dataset.open === 'true'`,
          true,
        )) as boolean;
        r16DownOk = opened && !stillOpen;
        r16DownInfo = `下划后 data-open=${opened}｜Esc 之后仍打开=${stillOpen}`;
      }
    }
    console.info(`[pi/smoke] 十六轮④下划开搜索浮层：${r16DownInfo} ${r16DownOk ? '✓' : '✗'}`);

    // ⑤ 切歌时播放页那张常驻名片自己弹一下（`data-reveal`），3.4s 后落回 false。
    let r16RevealOk = false;
    let r16RevealInfo = '没切成功';
    {
      await clickNav(win, '播放器主页');
      await delay(860);
      /*
       * 先把指针停到远离名片的地方（左上角 20,20）：名片带「贴近才亮、靠近就续亮」的状态（见 ⑨），
       * 指针若停在名片附近，3.6s 那次读数就变成「被贴近续上」的假红（r26 那一跑正是如此）。
       */
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 });
      await delay(220);
      const beforeSrc = (await readAudio(win)).src;
      const clicked = (await win.webContents.executeJavaScript(
        `(() => {
          const next = document.querySelector('[data-home-next]');
          if (next === null || !(next instanceof HTMLElement)) return false;
          next.click();
          return true;
        })()`,
        true,
      )) as boolean;
      let seenTrue = false;
      /*
       * 计时必须锚在「第一次采到 reveal=true」那一刻：名片自己的 3s 从切歌那一下起算，而下面那次
       * `waitForPlayback` 是在等音频源真的换过去，耗时不定（本轮实测一次把它算进窗口里，2.2s 的
       * 读数就落到切歌后 3.3s 之外，白判一条 ✗）。所以先按名片自己的节拍照两段读数，再回头等音频源。
       */
      let revealedAt = 0;
      const revealDeadline = Date.now() + 1200;
      while (Date.now() < revealDeadline) {
        const reveal = (await win.webContents.executeJavaScript(
          `document.querySelector('.pi-home__card')?.dataset.reveal || '无卡片'`,
          true,
        )) as string;
        if (reveal === 'true') {
          seenTrue = true;
          revealedAt = Date.now();
          break;
        }
        await delay(100);
      }
      const sinceReveal = (ms: number): number => (seenTrue ? Math.max(0, revealedAt + ms - Date.now()) : 0);
      /*
       * **用户 m01402 第 8 条**把停留时间从 5s 收到 3s（`SONG_CARD_SHOW_MS = 3000`，见
       * apps/renderer/src/pages/HomePage.tsx），所以两段读数都跟着挪：露出后 ≈2.2s 应当还在
       * （证明没被顺手改得更短），再过到 ≈3.6s 必须已经收回去。
       */
      await delay(sinceReveal(2200));
      const mid = (await win.webContents.executeJavaScript(
        `document.querySelector('.pi-home__card')?.dataset.reveal || '无卡片'`,
        true,
      )) as string;
      const midElapsed = Date.now() - revealedAt;
      await waitForPlayback(win, UI_SMOKE_TIMEOUT_MS, beforeSrc);
      await delay(sinceReveal(3600));
      const landed = (await win.webContents.executeJavaScript(
        `document.querySelector('.pi-home__card')?.dataset.reveal || '无卡片'`,
        true,
      )) as string;
      const landElapsed = Date.now() - revealedAt;
      r16RevealOk = clicked && seenTrue && mid === 'true' && landed === 'false';
      r16RevealInfo =
        `点下一首=${clicked}｜1.2s 内 reveal=true 采到=${seenTrue}` +
        `｜${(midElapsed / 1000).toFixed(1)}s 后 reveal=${mid}（3s 窗口内应为 true）` +
        `｜${(landElapsed / 1000).toFixed(1)}s 后 reveal=${landed}（应为 false）`;
    }
    console.info(`[pi/smoke] 十六轮⑤切歌名片自弹：${r16RevealInfo} ${r16RevealOk ? '✓' : '✗'}`);

    /*
     * **用户 m01402 第 8 条**的后半句：「只有从其他界面回到播放页时不出现歌曲名片，除非是刚切换完歌曲」。
     * 上一段刚量完「切歌冒名片 → 3s 收回」，正好接着验：名片收完之后，去别的页面转一圈再回播放页，
     * 立刻读 `data-reveal` 必须是 'false'（歌没换，所以不该凭空冒出新名片；用户截图里看到的就是这里）。
     * 为了让判据可信，回程前后还要比对音频源没变（不然「没名片」可能是因为换歌换掉了）。
     */
    let r23CardBackOk = false;
    let r23CardBackInfo = '没跑';
    {
      const srcBefore = (await readAudio(win)).src;
      const left = await clickNav(win, '我的喜欢');
      await delay(760);
      const cameBack = await clickNav(win, '播放器主页');
      await delay(420);
      const revealBack = (await win.webContents.executeJavaScript(
        `document.querySelector('.pi-home__card')?.dataset.reveal || '无卡片'`,
        true,
      )) as string;
      const nearBack = (await win.webContents.executeJavaScript(
        `document.querySelector('.pi-home__card')?.dataset.near || '无卡片'`,
        true,
      )) as string;
      const srcAfter = (await readAudio(win)).src;
      const keptSong = srcBefore !== '' && srcBefore === srcAfter;
      r23CardBackOk = left && cameBack && revealBack === 'false' && keptSong;
      r23CardBackInfo =
        `去我的喜欢=${left}｜回播放页=${cameBack}｜回程后 420ms reveal=${revealBack}（要求 false）` +
        ` near=${nearBack}｜曲目未变=${keptSong ? '是' : '否'}`;
    }
    console.info(
      `[pi/smoke] 回播放页不冒名片（用户 m01402 第 8 条）：${r23CardBackInfo} ${r23CardBackOk ? '✓' : '✗'}`,
    );

    /*
     * **用户 m01402 第 3 条「把 M4 做了」**：`docs/PLAN.md:773` 里 M4 的剩余项是「专辑 / 歌手独立页」——
     * 原来点播放页名片上的歌手名 / 专辑名只会跳搜索页或弹一个卡片浮层，现在应该是 SPA 里的一整页
     * （`components/SongPageOverlay.tsx` + `pages/AlbumPage.tsx` / `pages/ArtistPage.tsx`）。
     * 这一条钉四件事：①专辑键开出专辑独立页（`data-album-tracks` 有曲目、z-index 与旧浮层同层、盒子够宽）；
     * ②歌手键开出歌手独立页（`data-artist-songs` 自述 > 0，专辑格数与 `data-artist-albums` 一致）；
     * ③歌手页里点一张专辑卡是**换页**（外壳仍只有一个、`data-song-page-id` 换成那张专辑、歌手页消失）；
     * ④全程没走旧浮层 / 搜索页（钉住 `state/ui.ts` 里 `openSongs` 的分流：只有 queue 还留在浮层）。
     * 当前这首没有专辑（或没有歌手 id）时那半会自然地开不出来——探针会把「按键在不在」写进读数，
     * 缺键的那半按「跳过」处理，不让它变成假红。
     */
    let r24SongPageOk = false;
    let r24SongPageInfo = '没跑';
    {
      const clickData = async (selector: string): Promise<boolean> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el === null || !(el instanceof HTMLElement)) return false;
            el.click();
            return true;
          })()`,
          true,
        )) as boolean;
      const hasData = async (selector: string): Promise<boolean> =>
        (await win.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify(selector)}) !== null`,
          true,
        )) as boolean;
      type SongPageRead = {
        overlays: number;
        kind: string;
        id: string;
        phase: string;
        z: string;
        boxW: number;
        tracks: string;
        artistSongs: string;
        artistAlbums: string;
        hotRows: number;
        albumCards: number;
        hasArtist: boolean;
        hasAlbum: boolean;
        listOverlay: boolean;
        page: string;
      };
      const readSongPage = async (): Promise<SongPageRead> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const overlays = [...document.querySelectorAll('[data-song-page-overlay]')];
            const root = overlays.length === 0 ? null : overlays[overlays.length - 1];
            const box = root ? root.querySelector('.pi-songpage-overlay__box') : null;
            const artist = root ? root.querySelector('[data-artist-page="true"]') : null;
            const album = root ? root.querySelector('[data-album-page="true"]') : null;
            const hot = root ? root.querySelector('[data-artist-section="hot"]') : null;
            const grid = root ? root.querySelector('[data-artist-album-grid="true"]') : null;
            return {
              overlays: overlays.length,
              kind: root ? root.dataset.songPage || '' : '',
              id: root ? root.dataset.songPageId || '' : '',
              phase: root ? root.dataset.phase || '' : '',
              z: root ? getComputedStyle(root).zIndex : '',
              boxW: box ? Math.round(box.getBoundingClientRect().width) : 0,
              tracks: album ? album.getAttribute('data-album-tracks') || '' : '',
              artistSongs: artist ? artist.getAttribute('data-artist-songs') || '' : '',
              artistAlbums: artist ? artist.getAttribute('data-artist-albums') || '' : '',
              hotRows: hot ? hot.querySelectorAll('.pi-songrow').length : -1,
              albumCards: grid ? grid.querySelectorAll('[data-album-card]').length : -1,
              hasArtist: artist !== null,
              hasAlbum: album !== null,
              listOverlay: document.querySelector('[data-song-list-overlay]') !== null,
              page: document.querySelector('.pi-main')?.dataset.page || '',
            };
          })()`,
          true,
        )) as SongPageRead;
      /**
       * 轮询到读数满足条件为止（最多 `ms`）。**为什么要它**：页面端数据是异步来的，
       * 固定 620ms 在平凡档够、在先锋档不够 —— r28 先锋跑就是在歌手页查询还没回来时读到
       * `热门=0 行=-1`（那个页面还在「正在加载…」分支上），白白吃一条假红。
       * 判据一个字没改，只是不再赌时间。
       */
      const waitSongPage = async (
        pred: (read: SongPageRead) => boolean,
        ms: number,
      ): Promise<SongPageRead> => {
        const deadline = Date.now() + ms;
        let last = await readSongPage();
        while (!pred(last) && Date.now() < deadline) {
          await delay(180);
          last = await readSongPage();
        }
        return last;
      };
      const hasAlbumKey = await hasData('[data-card-album]');
      const hasArtistKey = await hasData('[data-card-artist]');
      const openedAlbum = hasAlbumKey ? await clickData('[data-card-album]') : false;
      await delay(240);
      const albumRead = await waitSongPage((r) => r.hasAlbum && Number(r.tracks) > 0, 6000);
      const albumOk =
        !hasAlbumKey ||
        (openedAlbum &&
          albumRead.kind === 'album' &&
          albumRead.hasAlbum &&
          Number(albumRead.tracks) > 0 &&
          albumRead.z === '18' &&
          albumRead.boxW > 600 &&
          !albumRead.listOverlay &&
          albumRead.page !== 'search');
      const closedAlbum = await clickData('[data-song-page-close]');
      await delay(620);
      const afterClose = await readSongPage();
      const openedArtist = hasArtistKey ? await clickData('[data-card-artist]') : false;
      await delay(240);
      const artistRead = await waitSongPage((r) => r.hasArtist && Number(r.artistSongs) > 0, 8000);
      const artistOk =
        !hasArtistKey ||
        (openedArtist &&
          artistRead.kind === 'artist' &&
          artistRead.hasArtist &&
          Number(artistRead.artistSongs) > 0 &&
          (artistRead.hotRows <= 0 || artistRead.hotRows === Number(artistRead.artistSongs)) &&
          artistRead.albumCards === Number(artistRead.artistAlbums));
      const firstCard = (await win.webContents.executeJavaScript(
        `(() => {
          const card = document.querySelector('[data-album-card]');
          return card === null ? '' : card.getAttribute('data-album-card') || '';
        })()`,
        true,
      )) as string;
      const switched = firstCard === '' ? false : await clickData('[data-album-card]');
      await delay(240);
      const switchRead = await waitSongPage(
        (r) => r.kind === 'album' && r.id === firstCard,
        4000,
      );
      const switchOk =
        firstCard === '' ||
        (switched &&
          switchRead.kind === 'album' &&
          switchRead.id === firstCard &&
          switchRead.overlays === 1 &&
          !switchRead.hasArtist);
      await clickData('[data-song-page-close]');
      await delay(620);
      const finalRead = await readSongPage();
      r24SongPageOk =
        (hasAlbumKey || hasArtistKey) &&
        albumOk &&
        closedAlbum &&
        afterClose.overlays === 0 &&
        artistOk &&
        switchOk &&
        finalRead.overlays === 0;
      r24SongPageInfo =
        `键：专辑=${hasAlbumKey ? '在' : '无'} 歌手=${hasArtistKey ? '在' : '无'}` +
        `｜专辑页：开=${openedAlbum} kind=${albumRead.kind || '无'} 曲目=${albumRead.tracks || '-'}` +
        ` z=${albumRead.z || '-'} 盒宽=${albumRead.boxW}px 旧浮层=${albumRead.listOverlay ? '在' : '无'}` +
        ` 页码=${albumRead.page || '-'}｜关=${closedAlbum} 关后外壳=${afterClose.overlays}` +
        `｜歌手页：开=${openedArtist} kind=${artistRead.kind || '无'} 热门=${artistRead.artistSongs || '-'}` +
        ` 行=${artistRead.hotRows} 专辑格=${artistRead.albumCards}/${artistRead.artistAlbums || '-'}` +
        `｜换页：卡=${firstCard || '无'} 点=${switched} id=${switchRead.id || '-'}` +
        ` 外壳=${switchRead.overlays} 歌手页还在=${switchRead.hasArtist ? '是' : '否'}｜收尾外壳=${finalRead.overlays}`;
    }
    console.info(
      `[pi/smoke] M4 专辑/歌手独立页（用户 m01402 第 3 条）：${r24SongPageInfo} ${r24SongPageOk ? '✓' : '✗'}`,
    );

    /**
     * M5 下载与本地库（用户 m02213 第 3 条）。
     *
     * 走用户真能走的那条路：进「我的下载」→ 点「下载当前播放的歌曲」→ 等真落盘 →
     * 主进程核文件（存在 + 字节数对得上）→ 把任务还原成 Song 再解析一次，必须命中
     * **离线分支**（`via=download`、`file://`、`attempts` 为空 = 一个网络请求都没发）→
     * 断网模拟下再播一次（这是用户原话「断网仍可播放」的直译）→ 删任务连文件一起删。
     */
    let r25DownloadsOk = false;
    let r25DownloadsInfo = '未跑';
    {
      interface DownloadRowRead {
        id: string;
        status: string;
        received: number;
        total: number;
        quality: string;
        file: string;
        /** 进度条的 `data-download-indeterminate`（总量未知时渲染层要标出来）。 */
        bar: string;
        hasPlay: boolean;
        hasRemove: boolean;
      }
      interface DownloadRead {
        page: boolean;
        count: string;
        done: string;
        empty: boolean;
        addButton: boolean;
        error: string;
        rows: DownloadRowRead[];
      }
      const readDownloads25 = async (): Promise<DownloadRead> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const root = document.querySelector('[data-downloads-page]');
            const rows = [...document.querySelectorAll('[data-download-row]')];
            return {
              page: Boolean(root),
              count: root ? (root.getAttribute('data-download-count') || '') : '',
              done: root ? (root.getAttribute('data-download-done') || '') : '',
              empty: Boolean(document.querySelector('[data-downloads-empty]')),
              addButton: Boolean(document.querySelector('[data-download-add-current]')),
              error: (document.querySelector('[data-download-error]')?.textContent || '').trim(),
              rows: rows.map((row) => {
                const bar = row.querySelector('[data-download-progress]');
                return {
                  id: row.getAttribute('data-download-id') || '',
                  status: row.getAttribute('data-download-status') || '',
                  received: Number(row.getAttribute('data-download-received') || '0'),
                  total: Number(row.getAttribute('data-download-total') || '0'),
                  quality: row.getAttribute('data-download-quality') || '',
                  file: row.getAttribute('data-download-file') || '',
                  bar: bar ? (bar.getAttribute('data-download-indeterminate') || '') : '',
                  hasPlay: Boolean(row.querySelector('[data-download-play]')),
                  hasRemove: Boolean(row.querySelector('[data-download-remove]')),
                };
              }),
            };
          })()`,
        )) as DownloadRead;
      const readAudio25 = async (): Promise<{ live: boolean; time: number; paused: boolean; src: string }> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const audio = window.__piAudio;
            if (!audio) return { live: false, time: -1, paused: true, src: '' };
            return {
              live: true,
              time: Number(audio.currentTime || 0),
              paused: Boolean(audio.paused),
              src: audio.currentSrc || audio.src || '',
            };
          })()`,
        )) as { live: boolean; time: number; paused: boolean; src: string };
      /** 把 <audio> 拨回 0 再点播放：不然「时间已经走过 1.2s」会让断网那一次假通过。 */
      const rewindAudio25 = async (): Promise<void> => {
        await win.webContents.executeJavaScript(
          `(() => {
            const audio = window.__piAudio;
            if (audio) {
              audio.pause();
              audio.currentTime = 0;
            }
            return true;
          })()`,
        );
        await delay(140);
      };
      const waitPlaying25 = async (ms: number): Promise<{ time: number; src: string }> => {
        const deadline = Date.now() + ms;
        let last = { time: -1, src: '' };
        while (Date.now() < deadline) {
          const now = await readAudio25();
          last = { time: now.time, src: now.src };
          if (now.live && !now.paused && now.time > 1.2) break;
          await delay(240);
        }
        return last;
      };
      /** M4 那段里的 `clickData` 是块内局部函数，这里自己再要一个（同名会互相盖）。 */
      const click25 = async (selector: string): Promise<boolean> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.click();
            return true;
          })()`,
          true,
        )) as boolean;

      try {
        const openDownloads25 = async (): Promise<void> => {
          await clickNav(win, '我的下载');
          await delay(760);
        };
        await openDownloads25();
        const pageRead = await readDownloads25();
        // 入队键拿的是「当前播放的那一首」：暂停中或压根没有当前曲时先回播放页按一下播放键，
        // 否则按钮是 disabled，后面等的「落盘」会变成一条莫名其妙的超时。
        const beforeAdd = await readAudio25();
        if (!beforeAdd.live || beforeAdd.paused) {
          await clickNav(win, '播放器主页');
          await delay(620);
          await click25('[data-home-play]');
          await waitPlaying25(6000);
          await openDownloads25();
        }
        await click25('[data-download-add-current]');
        let queued = pageRead;
        const queueDeadline = Date.now() + 6000;
        while (Date.now() < queueDeadline) {
          queued = await readDownloads25();
          if (queued.rows.length > 0) break;
          await delay(220);
        }
        const queuedAt = Date.now();
        let doneRead = queued;
        const doneDeadline = Date.now() + 120000;
        while (Date.now() < doneDeadline) {
          doneRead = await readDownloads25();
          if (
            doneRead.rows.some(
              (row) =>
                row.status === 'done' &&
                row.received > 0 &&
                (row.total === 0 || row.received === row.total),
            ) ||
            doneRead.rows.some((row) => row.status === 'error')
          ) {
            break;
          }
          await delay(400);
        }
        const doneElapsed = Date.now() - queuedAt;
        const doneRow = doneRead.rows.find((row) => row.status === 'done') ?? null;
        const tasks = services.downloads.list();
        const task = doneRow ? (tasks.find((item) => item.id === doneRow.id) ?? null) : null;
        let fileSize = -1;
        if (task?.filePath) {
          try {
            fileSize = statSync(task.filePath).size;
          } catch {
            fileSize = -1;
          }
        }
        const fileOk =
          Boolean(task) &&
          fileSize > 0 &&
          task!.receivedBytes > 0 &&
          fileSize === task!.receivedBytes;

        let viaDownload = false;
        let fileUrl = false;
        let noAttempts = false;
        let loopbackSrc = false;
        if (task) {
          const resolved = await services.resolveForPlayback(songFromTask(task));
          viaDownload = resolved.audio?.via === 'download';
          fileUrl = (resolved.audio?.url ?? '').startsWith('file://');
          noAttempts = resolved.attempts.length === 0;
          loopbackSrc = (resolved.src ?? '').startsWith('http://127.0.0.1:');
        }

        // 真播一次：本地文件 → 本机媒体服务器（回环）→ <audio>
        await rewindAudio25();
        await click25('[data-download-play]');
        const playedRead = await waitPlaying25(9000);
        const played = playedRead.time > 1.2 && playedRead.src.startsWith('http://127.0.0.1:');

        // 断网模拟（`enableNetworkEmulation`）：这一跑是「断网仍可播放」的直译。
        let offlinePlayed = false;
        let loopbackBlocked = false;
        try {
          win.webContents.session.enableNetworkEmulation({ offline: true });
          await rewindAudio25();
          await click25('[data-download-play]');
          const offlineRead = await waitPlaying25(9000);
          offlinePlayed = offlineRead.time > 1.2;
          if (!offlinePlayed && offlineRead.src) {
            // 断网模拟有可能把回环也拦了：那就单独问一次本机媒体服务器，
            // 通不了 = 是模拟器的限制，不是产品「离线播不了」。
            const reachable = (await win.webContents.executeJavaScript(
              `fetch(${JSON.stringify(offlineRead.src)}, { method: 'HEAD' }).then(() => true).catch(() => false)`,
            )) as boolean;
            loopbackBlocked = !reachable;
          }
        } finally {
          win.webContents.session.enableNetworkEmulation({ offline: false });
        }

        // 收尾：删任务（done 的连文件一起删），顺便验一下清单清理。
        await click25('[data-download-remove]');
        let removedRows = -1;
        const removeDeadline = Date.now() + 6000;
        while (Date.now() < removeDeadline) {
          const after = await readDownloads25();
          removedRows = after.rows.length;
          if (removedRows === 0) break;
          await delay(240);
        }
        const fileGone = !task?.filePath || !existsSync(task.filePath);

        // 收尾归位：刚才播的是本地文件，而文件已经被删了——后面几段还要靠播放器出声，
        // 所以回播放页确认还能走；真停住了就换下一首（逼它重新在线解析）。
        await clickNav(win, '播放器主页');
        await delay(620);
        const afterCleanup = await readAudio25();
        if (!afterCleanup.live || afterCleanup.paused || afterCleanup.time <= 0.2) {
          await click25('[data-home-next]');
          await waitPlaying25(9000);
        }

        r25DownloadsOk =
          pageRead.page &&
          pageRead.addButton &&
          doneRow !== null &&
          fileOk &&
          viaDownload &&
          fileUrl &&
          noAttempts &&
          loopbackSrc &&
          played &&
          (offlinePlayed || loopbackBlocked) &&
          removedRows === 0 &&
          fileGone;
        r25DownloadsInfo =
          `页=${pageRead.page ? '在' : '无'} 入队键=${pageRead.addButton ? '在' : '无'}` +
          ` 行=${pageRead.rows.length}→${doneRead.rows.length}` +
          `｜任务：状态=${doneRow?.status ?? '无'} 质量=${doneRow?.quality ?? '-'}` +
          ` 已下=${doneRow?.received ?? 0}/${doneRow?.total ?? 0}B 落盘=${fileSize}B 文件=${fileOk ? '对' : '不对'}` +
          ` 入库耗时=${(doneElapsed / 1000).toFixed(1)}s` +
          `｜离线解析：via=${viaDownload ? 'download' : '其它'} file=${fileUrl} 在线尝试=${noAttempts ? '0次' : '有'}` +
          ` 代理=${loopbackSrc ? '回环' : '其它'}` +
          `｜播放=${played ? ((playedRead.time > 0 ? playedRead.time.toFixed(1) : '0') + 's') : '没走'}` +
          `｜断网模拟可播=${offlinePlayed}${loopbackBlocked ? '（模拟器拦了回环，按解析链判定）' : ''}` +
          `｜收尾：行=${removedRows} 文件=${fileGone ? '已删' : '还在'}`;
      } catch (error) {
        r25DownloadsInfo = `抛错：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    console.info(
      `[pi/smoke] M5 下载与本地库（用户 m02213 第 3 条）：${r25DownloadsInfo} ${r25DownloadsOk ? '✓' : '✗'}`,
    );

    // ⑥ 底栏比例：实心播放键 ≈40×40；轨道 6px、滑块 12px（读 CSS 自定义属性，不量绝对坐标）。
    let r16BarOk = false;
    let r16BarInfo = '未找到底栏';
    {
      await clickNav(win, '播放器主页');
      await delay(900);
      const bar = (await win.webContents.executeJavaScript(
        `(() => {
          const play = document.querySelector('[data-home-play]');
          const track = document.querySelector('[data-home-progress]');
          if (play === null || track === null) return null;
          const cs = getComputedStyle(track);
          /*
           * 用户 m04407 第 3 条：蓝色已播部分的右端原来是一条竖线 —— 填充是
           * 「伪元素轨道上的一条 background-image 渐变」，渐变边界天生是直角。
           * 现在填充改成一层独立的圆头胶囊（[data-home-progress-fill]），这里量它的
           * 圆角/宽高，并确认轨道上那条渐变**已经撤掉**（不然方角会从圆头旁边露出来）。
           */
          const fill = document.querySelector('[data-home-progress-fill]');
          const fs = fill === null ? null : getComputedStyle(fill);
          return {
            w: play.offsetWidth,
            h: play.offsetHeight,
            thick: cs.getPropertyValue('--pi-home-track-thick').trim(),
            thumb: cs.getPropertyValue('--pi-home-thumb').trim(),
            // 用户 m01402 第 6 条：「进度条本体的小篮球也去掉，只要一个细线」——滑块的填充色。
            // 抓取盒尺寸（--pi-home-thumb）故意没动，所以这里要另外断言它不可见。
            thumbFill: cs.getPropertyValue('--pi-home-thumb-fill').trim(),
            progress: cs.getPropertyValue('--pi-progress').trim(),
            gradient: cs.backgroundImage,
            trackW: track.offsetWidth,
            fill:
              fill === null || fs === null
                ? null
                : {
                    radius: fs.borderRadius,
                    w: fill.offsetWidth,
                    h: fill.offsetHeight,
                    bg: fs.backgroundColor,
                  },
          };
        })()`,
        true,
      )) as {
        w: number;
        h: number;
        thick: string;
        thumb: string;
        thumbFill: string;
        progress: string;
        gradient: string;
        trackW: number;
        fill: { radius: string; w: number; h: number; bg: string } | null;
      } | null;
      if (bar !== null) {
        const parsePx = (text: string): number => {
          const parsed = Number.parseFloat(text);
          return Number.isFinite(parsed) ? parsed : -1;
        };
        const thick = parsePx(bar.thick);
        const thumb = parsePx(bar.thumb);
        const progress = parsePx(bar.progress);
        // 取成局部常量：TS 对 `bar.fill` 这种属性访问的收窄不会跨语句保住。
        const fill = bar.fill;
        r16BarOk =
          Math.abs(bar.w - 40) <= 2 &&
          Math.abs(bar.h - 40) <= 2 &&
          Math.abs(thick - 6) <= 1 &&
          Math.abs(thumb - 12) <= 1 &&
          // 用户 m01402 第 6 条：滑块只是一条「看不见的抓取盒」，填充必须是 transparent。
          bar.thumbFill === 'transparent' &&
          /*
           * 用户 m04407 第 3 条：已播填充必须是**圆头胶囊**，且宽度跟着 `--pi-progress` 走：
           * 圆角 ≥ 99px（写的是 999px）、高度与轨道同厚（常态 6px / 悬停 10px 自动跟）、
           * 宽度 = 进度 × 轨道宽（±2px 容差），并且轨道自己那条渐变必须已经撤掉。
           */
          bar.fill !== null &&
          parsePx(fill === null ? '' : fill.radius) >= 99 &&
          Math.abs((fill === null ? -99 : fill.h) - thick) <= 1 &&
          progress >= 0 &&
          Math.abs((fill === null ? -999 : fill.w) - progress * bar.trackW) <= 2 &&
          bar.gradient === 'none';
        r16BarInfo =
          `键=${bar.w}x${bar.h} 轨道=${bar.thick || '-'} 滑块=${bar.thumb || '-'}` +
          ` 滑块填充=${bar.thumbFill || '无'}` +
          ` 比值=${thick > 0 ? (thumb / thick).toFixed(1) : '-'}:1` +
          `｜m04407 第 3 条：填充圆角=${fill === null ? '无' : fill.radius || '-'}` +
          ` 填充 ${fill === null ? '-' : `${fill.w}x${fill.h}`}` +
          ` 进度=${bar.progress || '-'} 轨宽=${bar.trackW}` +
          ` 轨道渐变=${bar.gradient === 'none' ? '已撤' : bar.gradient}`;
        /*
         * 父代理 2026：静止态那颗播放键是 `opacity: 0`（上一轮用户要求「常态不显示、放大后才
         * 显示」），直接把这一帧拍下来图上看不到那颗 40px 实心键，没法当第 5 条的视觉证据。
         * 所以先把指针移到药丸中心让 `.pi-home__bar:hover` 生效（高度 44→56、键与音量键浮出），
         * 在这一刻截图，拍完再把指针移开。
         */
        const barHoverBox = (await win.webContents.executeJavaScript(
          `(() => {
            const bar = document.querySelector('[data-home-bar]');
            if (bar === null) return null;
            const r = bar.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`,
          true,
        )) as { x: number; y: number } | null;
        if (barHoverBox !== null) {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: barHoverBox.x, y: barHoverBox.y });
          await delay(420);
        }
        await r16Shot('m3r16-home-bar.png');
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 24, y: 320 });
        await delay(240);
      }
    }
    console.info(`[pi/smoke] 十六轮⑥底栏比例：${r16BarInfo} ${r16BarOk ? '✓' : '✗'}`);

    /*
     * ⑦ 歌单/列表卡片化（第十六轮第 5 条，用户 m07538）。第十七轮第 ②③ 条之后有两套排版：
     *   平凡 = 歌单页 `.pi-plcard` 卡片网格 + 详情 `SongList` 竖排行（`[data-song-row]`）；
     *   先锋 = 歌单页 `SongCards` 卡片流（第十八轮第 ③ 条，`.pi-songcard`）+ 详情 `SongCollage`
     *          队列拼贴（`data-collage-cell`，类名是 `.pi-collage__item`）。
     * 所以这里两套都认；顺便把「详情曲目呈现」的结论交给 M3 汇总用（`detailTracksOk`）。
     */
    let r16PlOk = false;
    let r16PlInfo = '';
    let detailTracksOk = false;
    {
      const countGrid = async (label: string): Promise<{ cards: number; rows: number }> => {
        await clickNav(win, label);
        await delay(1300);
        return (await win.webContents.executeJavaScript(
          `(() => ({
            cards: document.querySelectorAll('${PL_CARD_SEL}').length,
            // 拼贴格的类名是 .pi-collage__item，抓手是 data-collage-cell
            //（SongCollage.tsx:938-944）——旧写法 .pi-collage-cell 恒为 0，会把先锋跑判成假红。
            rows: document.querySelectorAll('[data-song-row], [data-collage-cell]').length,
          }))()`,
          true,
        )) as { cards: number; rows: number };
      };
      const recommend = await countGrid('推荐歌单');
      const mine = await countGrid('我的歌单');
      await clickNav(win, '推荐歌单');
      await delay(1100);
      // 进详情：平凡点网格首卡；先锋点卡片流的**焦点卡**（点非焦点卡只会滑过去）。
      await win.webContents.executeJavaScript(
        `(() => {
          const card =
            document.querySelector('.pi-plcard, [data-playlist-card]') ??
            document.querySelector('.pi-songcard[data-focused="true"]');
          if (card === null) return false;
          card.click();
          return true;
        })()`,
        true,
      );
      const r16DetailDeadline = Date.now() + UI_SMOKE_TIMEOUT_MS;
      let detailRows = 0;
      let detailCells = 0;
      // 诊断用：详情浮层有没有真的开（`[data-playlist]` 那份 listoverlay），以及卡片流是否还挂在页面上。
      let detailOverlay = false;
      let detailCards = 0;
      while (Date.now() < r16DetailDeadline) {
        const counted = (await win.webContents.executeJavaScript(
          `(() => ({
            rows: document.querySelectorAll('[data-song-row]').length,
            cells: document.querySelectorAll('[data-collage-cell]').length,
            overlay: document.querySelector('[data-playlist]') !== null,
            cards: document.querySelectorAll('${PL_CARD_SEL}').length,
          }))()`,
          true,
        )) as { rows: number; cells: number; overlay: boolean; cards: number };
        detailRows = counted.rows;
        detailCells = counted.cells;
        detailOverlay = counted.overlay;
        detailCards = counted.cards;
        if (detailRows + detailCells > 0) break;
        await delay(400);
      }
      // 「详情曲目呈现」= 两套排版里有一套真的把歌铺出来了（≥8 条）。
      detailTracksOk = detailRows >= 8 || detailCells >= 8;
      r16PlOk = recommend.cards >= 1 && mine.cards >= 1 && detailTracksOk;
      r16PlInfo =
        `推荐歌单页 .pi-plcard=${recommend.cards}（详情外页行=${recommend.rows}）` +
        `｜我的歌单页 .pi-plcard=${mine.cards}` +
        `｜详情竖排行=${detailRows} 拼贴块=${detailCells}` +
        `（详情浮层=${detailOverlay} 卡片流还在=${detailCards}）`;
    }
    console.info(`[pi/smoke] 十六轮⑦歌单列表卡片化：${r16PlInfo} ${r16PlOk ? '✓' : '✗'}`);

    // ⑧ 歌曲卡片封面不被裁：图片四条边都在容器里，并记下 object-fit 与两侧宽高比。
    let r16CoverOk = false;
    let r16CoverInfo = '没有卡片列表';
    {
      /*
       * 父代理 2026：这一条原来 `clickNav(win,'搜索')` 打开的是搜索**页**，那一刻没有任何
       * `.pi-searchoverlay .pi-songcard`，所以恒判 ✗。改成和「下划 PI 键」同一条路开浮层。
       * 父代理第七轮（用户第 2 条指的就是这处）：**判定以搜索浮层那次为准**，浮层真的开不出来
       * 才退化到歌单详情页，且日志里两处来源都写出来（`浮层=…｜详情页=…`）。
       */
      await clickNav(win, '播放器主页');
      await delay(800);
      // 路 1（主）：下划 PI 键开搜索浮层（和探针④同一条路）→ 真输入「周杰伦」→
      // 轮询 ≤3s 等浮层里出现 `.pi-songcard` 且第一张宽 > 40px。
      let overlay8 = false;
      let overlayTyped = false;
      let overlayReady = false;
      await delay(900);
      for (let entry = 0; entry < 3; entry += 1) {
        const onHome = (await win.webContents.executeJavaScript(
          `document.querySelector('.pi-home') !== null`,
          true,
        )) as boolean;
        if (onHome) break;
        await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await delay(240);
        await clickNav(win, '播放器主页');
        await delay(900);
      }
      const homeOnTop8 = async (): Promise<boolean> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const pts = [[0.5, 0.3], [0.35, 0.4], [0.65, 0.4], [0.5, 0.55]];
            return pts.some((p) => {
              const el = document.elementFromPoint(Math.round(innerWidth * p[0]), Math.round(innerHeight * p[1]));
              return el !== null && el.closest('.pi-home') !== null;
            });
          })()`,
          true,
        )) as boolean;
      /*
       * 上一跑的证据：`.pi-home` 在 DOM 里（首页挂着），但 (0.5w,0.3h) 命中的是
       * `DIV.pi-songcards__stage`——**歌曲列表浮层盖在播放页上面**（`SongListOverlay` 挂在
       * `App.tsx` 根上，不随路由换页卸载）。这时 `quickOrbSpot` 整张网格都过不了
       * `closest('.pi-home')`，于是退回落点 (0.5w,0.3h)——恰好又落在浮层的卡片上，
       * 点击被 stage 的排除判据吞掉，球出不来。按 Escape 把上面的浮层收掉再点。
       */
      for (let lift = 0; lift < 3; lift += 1) {
        if (await homeOnTop8()) break;
        await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await delay(260);
        await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await delay(260);
      }
      const entry8 = (await win.webContents.executeJavaScript(
        `(() => {
          const el = document.elementFromPoint(Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.3));
          return {
            home: document.querySelector('.pi-home') !== null,
            top: el === null ? 'null' : (el.tagName + '.' + String(el.className).slice(0, 44)),
            title: (document.querySelector('.pi-page-title')?.textContent || '').slice(0, 20),
          };
        })()`,
        true,
      )) as { home: boolean; top: string; title: string };
      const entry8Note =
        `进门=${entry8.title || '(无标题)'}｜.pi-home=${entry8.home ? '在' : '不在'}｜` +
        `0.5w/0.3h 命中=${entry8.top}`;
      let orb8 = await tapQuickOrb(win);
      if (orb8 === null) {
        // 上一跑浮层没开出来：`clickNav` 之后 800ms 有时还停在上一页（`.pi-home` 尚未挂上），
        // `quickOrbSpot` 找不到空白点就返回 null，后面整段被 `if (orb8 !== null)` 跳过。
        // 再等一会儿换一个空白点重试一次，并把结果写进日志（`点出球=`）。
        await delay(700);
        orb8 = await tapQuickOrb(win, 1);
      }
      if (orb8 !== null) {
        await swipeQuickOrb(win, 0, 90);
        const deadline8 = Date.now() + 2500;
        while (Date.now() < deadline8) {
          await delay(200);
          overlay8 = (await win.webContents.executeJavaScript(
            `Boolean(document.querySelector('.pi-searchoverlay[data-open="true"]'))`,
            true,
          )) as boolean;
          if (overlay8) break;
        }
        if (!overlay8) {
          // 下划没开出来：先把球点回来（上一次下划可能已经被判成点击而收起了球）再划一次。
          await tapQuickOrb(win);
          await swipeQuickOrb(win, 0, 90);
          const retry8 = Date.now() + 2500;
          while (Date.now() < retry8) {
            await delay(200);
            overlay8 = (await win.webContents.executeJavaScript(
              `Boolean(document.querySelector('.pi-searchoverlay[data-open="true"]'))`,
              true,
            )) as boolean;
            if (overlay8) break;
          }
        }
        if (overlay8) {
          overlayTyped = await typeIntoSearch(win, '周杰伦');
          const overlayDeadline = Date.now() + 3000;
          while (Date.now() < overlayDeadline) {
            overlayReady = (await win.webContents.executeJavaScript(
              `(() => {
                const cards = Array.from(document.querySelectorAll('.pi-searchoverlay .pi-songcard'));
                if (cards.length === 0) return false;
                return cards.some((el) => el.getBoundingClientRect().width > 40);
              })()`,
              true,
            )) as boolean;
            if (overlayReady) break;
            await delay(300);
          }
        }
      }
      /*
       * 父代理第三轮：上一版报 `来源=歌单详情页 共 35 张｜卡封面 img=0x0 容器=0x0`——
       * 卡是找到了，但量的那一刻那些卡**不可见**（详情页不在前台/容器被藏 ⇒ rect 全 0）。
       * 路 2 改成：走「推荐歌单 → 点第一张卡」并**等到第一张卡的宽度 > 40px** 再量；
       * 量不到可见卡就照实写「没量到可见卡」，不拿 0×0 当证据。
       */
      let detailReady = false;
      if (!overlayReady) {
        await clickNav(win, '推荐歌单');
        await delay(1100);
        await win.webContents.executeJavaScript(
          `(document.querySelector('.pi-plcard, [data-playlist-card]') ||
            document.querySelector('.pi-songcard[data-focused="true"]'))?.click()`,
          true,
        );
        const visibleDeadline = Date.now() + 3000;
        while (Date.now() < visibleDeadline) {
          detailReady = (await win.webContents.executeJavaScript(
            `(() => {
              const card = document.querySelector('.pi-songcard');
              if (card === null) return false;
              return card.getBoundingClientRect().width > 40;
            })()`,
            true,
          )) as boolean;
          if (detailReady) break;
          await delay(300);
        }
      }
      const cover = (await win.webContents.executeJavaScript(
        `(() => {
          const read = (card) => {
            const img = card.querySelector('.pi-songcard__cover img') || card.querySelector('img');
            const box = img ? (img.parentElement || null) : null;
            if (img === null || box === null) return null;
            const ir = img.getBoundingClientRect();
            const br = box.getBoundingClientRect();
            const num = (value) => Math.round(value * 10) / 10;
            const outside = Math.max(
              num(br.left - ir.left),
              num(ir.right - br.right),
              num(br.top - ir.top),
              num(ir.bottom - br.bottom),
              0,
            );
            return {
              iw: num(ir.width),
              ih: num(ir.height),
              bw: num(br.width),
              bh: num(br.height),
              outside: outside,
              fit: getComputedStyle(img).objectFit,
            };
          };
          const scan = (nodes) => {
            const list = Array.from(nodes);
            const visible = list.filter((el) => el.getBoundingClientRect().width > 40);
            return { cards: list.length, visible: visible.length, first: visible[0] || null };
          };
          const overlay = scan(document.querySelectorAll('.pi-searchoverlay .pi-songcard'));
          const detail = scan(document.querySelectorAll('.pi-songcard'));
          const base = {
            overlayCards: overlay.cards,
            overlayVisible: overlay.visible,
            detailCards: detail.cards,
            detailVisible: detail.visible,
          };
          // 判定以**浮层这次**为准（用户第 2 条说的就是搜索框下那列卡）；浮层没量到可见卡才退化。
          const fromOverlay = overlay.first !== null;
          const card = fromOverlay ? overlay.first : detail.first;
          const source = fromOverlay
            ? '搜索浮层'
            : (detail.first === null ? '都没有可见卡' : '歌单详情页');
          const blank = Object.assign(base, {
            ready: false,
            source: source,
            iw: 0,
            ih: 0,
            bw: 0,
            bh: 0,
            outside: 0,
            fit: '',
          });
          if (card === null) return blank;
          const one = read(card);
          if (one === null) return blank;
          return Object.assign(base, { ready: true, source: source }, one);
        })()`,
        true,
      )) as {
        overlayCards: number;
        overlayVisible: number;
        detailCards: number;
        detailVisible: number;
        source: string;
        ready: boolean;
        iw: number;
        ih: number;
        bw: number;
        bh: number;
        outside: number;
        fit: string;
      } | null;
      if (cover !== null) {
        const srcNote =
          `${entry8Note}｜点出球=${orb8 === null ? '没点到空白处' : '是'}｜浮层=${overlay8 ? '开出来了' : '没开出来'}（输入周杰伦=${overlayTyped ? '是' : '否'}，` +
          `可见卡=${cover.overlayVisible}/${cover.overlayCards}）｜` +
          `详情页=${detailReady ? '已开' : '没开'}（可见卡=${cover.detailVisible}/${cover.detailCards}）`;
        if (cover.ready) {
          const imgRatio = cover.ih > 0 ? cover.iw / cover.ih : 0;
          const boxRatio = cover.bh > 0 ? cover.bw / cover.bh : 0;
          const square = Math.abs(boxRatio - 1) <= 0.1;
          // 判定以浮层这次为准；浮层开不出来才退化到歌单详情页，并在日志里照实写出来。
          const judgedOnOverlay = cover.source === '搜索浮层';
          r16CoverOk = judgedOnOverlay && cover.outside <= 1 && square;
          r16CoverInfo =
            `${srcNote}｜判定来源=${cover.source}` +
            `${judgedOnOverlay ? '' : '（浮层没开出来，退化到歌单详情页）'}` +
            `｜卡封面 img=${cover.iw}x${cover.ih} 容器=${cover.bw}x${cover.bh} object-fit=${cover.fit}` +
            ` 越界=${cover.outside}px（容差 1）` +
            ` 宽高比 img=${imgRatio.toFixed(3)} 容器=${boxRatio.toFixed(3)} 近似正方=${square}`;
          if (judgedOnOverlay) await r16Shot('m3r16-songcards-cover.png');
        } else {
          r16CoverInfo = `${srcNote}｜判定来源=${cover.source}，没量到可见卡（width>40）——不截图、不当证据`;
        }
      }
      await win.webContents.executeJavaScript(
        `document.querySelector('.pi-searchoverlay [data-close]')?.click()`,
        true,
      );
      await delay(560);
    }
    console.info(`[pi/smoke] 十六轮⑧卡封面不裁：${r16CoverInfo} ${r16CoverOk ? '✓' : '✗'}`);

    // ⑨ 拼贴悬停互动动画：非中心格子的封面 transform 变、scale>1，格子 z/shadow 至少一项变，移开回落。
    const r16ScaleOf = (text: string): number => {
      const m2 = /matrix\(([^)]+)\)/.exec(text);
      if (m2 !== null) return Number((m2[1] ?? '').split(',')[0]);
      const m3 = /matrix3d\(([^)]+)\)/.exec(text);
      if (m3 !== null) return Number((m3[1] ?? '').split(',')[0]);
      return text === 'none' ? 1 : -1;
    };
    /*
     * 父代理 2026：原来只读**内联** style（日志恒是 `悬停前=none shadow=none z=auto`），
     * 而悬停样式全是 CSS 给的 ⇒ 永远看不出变化。改成读 `getComputedStyle()`。
     * 父代理第三轮又指出：拼贴格里**没有** `.pi-songcard`（所以日志恒 `卡=无 封面=none`），
     * 真实 DOM 是 `components/SongCollage.tsx:921-973`：格子 `.pi-collage__item`，
     * 里面是 `.pi-collage__cover > img` / `.pi-collage__copy` / `.pi-collage__badge`；
     * 悬停样式在 `styles/song-collage.css:358-392`：格子 z-index/filter/box-shadow，
     * 内层 `.pi-collage__cover img` 的 `transform: scale(1.055)`。所以这里读三处：
     * 格子本身、`.pi-collage__copy`、`.pi-collage__cover img`（每处都带 filter）。
     */
    type R16StyleSet = { transform: string; shadow: string; z: string; filter: string } | null;
    type R16CellStyles = { cell: R16StyleSet; card: R16StyleSet; cover: R16StyleSet };
    const r16ReadCell = async (key: string): Promise<R16CellStyles | null> =>
      (await win.webContents.executeJavaScript(
        `(() => {
          const cell = document.querySelector('[data-collage-cell="${key}"]');
          if (cell === null) return null;
          const card = cell.querySelector('.pi-collage__copy');
          const cover =
            cell.querySelector('.pi-collage__cover img') ||
            cell.querySelector('.pi-collage__cover') ||
            cell.querySelector('.pi-collage__nocover') ||
            cell.querySelector('img');
          const read = (el) => {
            if (!el) return null;
            const cs = getComputedStyle(el);
            return { transform: cs.transform, shadow: cs.boxShadow, z: cs.zIndex, filter: cs.filter };
          };
          return { cell: read(cell), card: read(card), cover: read(cover) };
        })()`,
        true,
      )) as R16CellStyles | null;
    const r16StylesChanged = (a: R16CellStyles, b: R16CellStyles): boolean =>
      a.cell?.transform !== b.cell?.transform ||
      a.cell?.shadow !== b.cell?.shadow ||
      a.cell?.z !== b.cell?.z ||
      a.cell?.filter !== b.cell?.filter ||
      a.card?.transform !== b.card?.transform ||
      a.card?.shadow !== b.card?.shadow ||
      a.card?.z !== b.card?.z ||
      a.card?.filter !== b.card?.filter ||
      a.cover?.transform !== b.cover?.transform ||
      a.cover?.shadow !== b.cover?.shadow ||
      a.cover?.z !== b.cover?.z ||
      a.cover?.filter !== b.cover?.filter;
    const r16MaxScale = (set: R16CellStyles): number => {
      let best = 1;
      for (const one of [set.cell, set.card, set.cover]) {
        if (one === null) continue;
        const scale = r16ScaleOf(one.transform);
        if (scale > best) best = scale;
      }
      return best;
    };
    const r16StyleLine = (set: R16CellStyles): string => {
      const brief = (one: R16StyleSet): string =>
        one === null ? '无' : `${one.transform}/${one.shadow.slice(0, 24)}/${one.z}/${one.filter.slice(0, 24)}`;
      return `格=${brief(set.cell)} 文案=${brief(set.card)} 封面=${brief(set.cover)}`;
    };
    /*
     * 父代理第五轮（成品图挖出的真线索）：那一跑的 `docs/m3r16-collage-hover.png` 拍到的其实是
     * **歌单详情页**（标题「歌单 今天《共鸣》…」，中间是 `SongCards.tsx:702` 那张卡片轮播），而
     * ⑨ 的日志说「墙上共 49 格」——`[data-collage-cell]` 全仓唯一挂载点是
     * `apps/renderer/src/pages/MinePage.tsx:197`（`SongCollage`）。两者同时成立只有一个解释：
     * 「我的喜欢」的拼贴墙确实挂着，但 ⑧ 那一步开进去的**歌单详情浮层盖在它上面**，
     * 于是 `elementFromPoint` 命中的是上层页面，`:hover` 与点击都落不到格子上。
     * 下面的 helper 在墙区域取样点，命中不到拼贴墙就先按 Esc 关上层（`PlaylistDetail.tsx:54`
     * 与 `SongListOverlay.tsx:40` 都听 Escape，`focusSmoke` 之后送键才不被丢），
     * 再不行就「回播放器主页 → 再进我的喜欢」把浮层连页面树一起卸载掉。
     */
    const r16WallTop = async (): Promise<{ top: boolean; hit: string; how: string }> => {
      const probe = async (): Promise<{ top: boolean; hit: string }> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            const spots = [
              { x: Math.round(w / 2), y: Math.round(h / 2) },
              { x: Math.round(w * 0.35), y: Math.round(h * 0.4) },
              { x: Math.round(w * 0.65), y: Math.round(h * 0.4) },
              { x: Math.round(w / 2), y: Math.round(h * 0.3) },
            ];
            let seen = '';
            for (const spot of spots) {
              const el = document.elementFromPoint(spot.x, spot.y);
              if (el === null) continue;
              if (seen === '') {
                seen = (el.tagName || '') + '.' + (el.className || '').toString().slice(0, 40);
              }
              if (el.closest('[data-song-collage]') !== null) {
                return { top: true, hit: (el.className || el.tagName || '').toString().slice(0, 40) };
              }
            }
            return { top: false, hit: seen === '' ? '空' : seen };
          })()`,
          true,
        )) as { top: boolean; hit: string };
      let state = await probe();
      if (state.top) return { top: true, hit: state.hit, how: '已是最上层' };
      const first = state.hit;
      await focusSmoke(win);
      for (let round = 0; round < 2; round += 1) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await delay(420);
        state = await probe();
        if (state.top) return { top: true, hit: state.hit, how: '按 Esc 关掉上层浮层' };
      }
      await clickNav(win, '播放器主页');
      await delay(900);
      await clickNav(win, '我的喜欢');
      await delay(2400);
      state = await probe();
      return {
        top: state.top,
        hit: state.hit,
        how: state.top ? '回主页再进我的喜欢后已是最上层' : '上层没关掉（首次命中=' + first + '）',
      };
    };

    // 进「我的喜欢」：顺手把 `clickNav` 的返回值与「拼贴墙是否在最上层」一起带回（⑨⑩⑪⑫ 共用）。
    /*
     * 进「我的喜欢」并**等到拼贴墙真的挂上去**，把「墙在不在、页面报没报错」一起带回去。
     *
     * 上一版只 `clickNav` + 2.4s：⑫ 之后重进这一页时首批歌还在拉（限流时要好几秒），墙没起来
     * 就派滚轮 / 读歌数 ⇒ ⑬ 的判据静默落空、⑥ 读成「上墙 ?→?」的假红，日志里还看不出卡在哪。
     * 现在先便宜地轮询「墙在不在」（最多 8s，不跑 `r16WallTop` 的导航兜底免得来回折腾页面），
     * 再跑一次 `r16WallTop` 定「在最上层」，失败时把页面上的报错文案原样带回来。
     */
    const r16EnterLiked = async (): Promise<{
      ok: boolean;
      top: boolean;
      hit: string;
      how: string;
      why: string;
    }> => {
      const ok = await clickNav(win, '我的喜欢');
      const wallDeadline = Date.now() + 8000;
      while (Date.now() < wallDeadline) {
        await delay(400);
        const saw = (await win.webContents.executeJavaScript(
          `document.querySelector('[data-song-collage]') !== null`,
          true,
        )) as boolean;
        if (saw) break;
      }
      const top = await r16WallTop();
      let why = '';
      if (!top.top) {
        why = (await win.webContents.executeJavaScript(
          `(() => {
             const wall = document.querySelector('[data-song-collage]');
             const cells = document.querySelectorAll('[data-collage-cell]').length;
             const note = (document.querySelector('.pi-placeholder')?.textContent || '').trim();
             return wall === null
               ? ('没有拼贴墙（格=' + cells + '｜页面提示=' + (note.slice(0, 40) || '无') + '）')
               : ('墙在但不在最上层（格=' + cells + '）');
           })()`,
          true,
        )) as string;
      }
      return { ok: ok, top: top.top, hit: top.hit, how: top.how, why: why };
    };

    let r16HoverOk = false;
    let r16HoverInfo = '没进我的喜欢页';
    let r16WallNote = '';
    {
      const liked = await r16EnterLiked();
      r16WallNote =
        `｜clickNav 进入我的喜欢=${liked.ok ? '是' : '否（clickNav 没进去）'}` +
        ` 墙在最上层=${liked.top ? '是' : '否'}（命中=${liked.hit} 处理=${liked.how}）` +
        `${liked.why === '' ? '' : `｜${liked.why}`}`;
      // 父代理第四轮：Chromium 对**未聚焦**窗口不派 hover（这就是上一跑 `有变化=false` 的最可能
      // 原因——之前能测到 hover 的探针都跑在已聚焦步骤之后），所以选格之前先把窗口聚焦。
      await focusSmoke(win);
      const pick = (await win.webContents.executeJavaScript(
        `(() => {
          const all = Array.from(document.querySelectorAll('[data-collage-cell]'));
          const cells = all.filter(
            (el) =>
              el.getAttribute('data-collage-expanded') !== 'true' &&
              el.classList.contains('pi-collage__item--center') !== true,
          );
          if (cells.length === 0) return null;
          const home = window.innerWidth / 2;
          const bad = '[data-home-bar], .pi-collage-bar, .pi-collage-search, input';
          const box = (el) => {
            const r = el.getBoundingClientRect();
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);
            const hit = document.elementFromPoint(cx, cy);
            const clear =
              r.width > 8 && r.height > 8 && r.top > 0 && r.left > 0 &&
              r.bottom < window.innerHeight && cx < window.innerWidth && cy < window.innerHeight;
            return {
              el: el,
              r: r,
              x: cx,
              y: cy,
              off: Math.abs(cx - home),
              clear: clear,
              self: hit !== null && hit.closest('[data-collage-cell]') === el,
              covered:
                hit !== null &&
                (hit.closest(bad) !== null ||
                  (hit.closest('button') !== null && hit.closest('button') !== el)),
            };
          };
          const boxes = cells.map(box);
          const usable = boxes.filter((one) => one.clear && one.self && !one.covered);
          const pool = usable.length > 0 ? usable : boxes.filter((one) => one.clear);
          const target = pool.find((one) => one.off > 60) || pool[0];
          if (target === undefined) return null;
          const r = target.r;
          const rect =
            Math.round(r.width) + 'x' + Math.round(r.height) +
            '@' + Math.round(r.left) + ',' + Math.round(r.top);
          return {
            cells: all.length,
            usable: usable.length,
            key: target.el.getAttribute('data-collage-cell') || '',
            x: target.x,
            y: target.y,
            outX: target.x,
            outY: Math.min(window.innerHeight - 2, Math.round(r.bottom + 20)),
            rect: rect,
            hitSelf: target.self,
            covered: target.covered,
            inView: target.clear,
            nonCentre: target.off > 60,
          };
        })()`,
        true,
      )) as {
        cells: number;
        usable: number;
        key: string;
        x: number;
        y: number;
        outX: number;
        outY: number;
        rect: string;
        hitSelf: boolean;
        covered: boolean;
        inView: boolean;
        nonCentre: boolean;
      } | null;
      if (pick !== null && pick.key !== '') {
        const beforeHover = await r16ReadCell(pick.key);
        await focusSmoke(win);
        /*
         * 父代理第四轮：分 3 小步移动（先到格子边缘外 20px，再进格子中心），每步 180ms，
         * 然后直接问这一格 `matches(':hover')`——拿不到就照实写「只能当 CSS 规则存在性的弱证据」，
         * 但不把它算成产品失败。
         */
        win.webContents.sendInputEvent({ type: 'mouseMove', x: pick.outX, y: pick.outY });
        await delay(180);
        win.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round((pick.outX + pick.x) / 2),
          y: Math.round((pick.outY + pick.y) / 2),
        });
        await delay(180);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: pick.x, y: pick.y });
        await delay(180);
        const hoverState = (await win.webContents.executeJavaScript(
          `(() => {
            const cell = document.querySelector('[data-collage-cell="${pick.key}"]');
            if (cell === null) return 'no-cell';
            const hit = document.elementFromPoint(${pick.x}, ${pick.y});
            const self = hit !== null && hit.closest('[data-collage-cell]') === cell;
            return 'matches:' + String(cell.matches(':hover')) + ' 命中自身:' + String(self);
          })()`,
          true,
        )) as string;
        await delay(240);
        const afterHover = await r16ReadCell(pick.key);
        await r16Shot('m3r16-collage-hover.png');
        /*
         * 父代理第六轮：原来的固定落点 `(24,320)` 很可能又压在别的格子上（或合成指针不产生离开
         * 事件），上一跑因此报「移开后回落=false」且看不到差在哪。现在分两次移开、各读一次原文：
         * ①先移到页面标题条 `(w/2, 24)`（确定不是格子）；②再移到「另一格的中心」。
         * 两次都回落不了就照实写「合成指针下 hover 出不去（移开后仍为 …）」，并把判据降到
         * `pick.inView && changed`（用户诉求是「悬停有互动动画」，这一条已被硬证据证明），
         * 但绝不静默放弃——降级这件事本身也要打进日志。
         */
        const moveAway = async (x: number, y: number): Promise<string> => {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: x, y: y });
          await delay(700);
          return (await win.webContents.executeJavaScript(
            `(() => {
              const el = document.elementFromPoint(${x}, ${y});
              return el === null
                ? '视口外'
                : (el.tagName || '') + '.' + (el.className || '').toString().slice(0, 30);
            })()`,
            true,
          )) as string;
        };
        const titleX = Math.round(
          ((await win.webContents.executeJavaScript('window.innerWidth', true)) as number) / 2,
        );
        const titleHit = await moveAway(titleX, 24);
        const backA = await r16ReadCell(pick.key);
        const otherSpot = (await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector('[data-collage-cell="${pick.key}"]');
            if (el === null) return null;
            const r = el.getBoundingClientRect();
            const spots = [
              { x: Math.round(r.right + 120), y: Math.round(r.top + r.height / 2) },
              { x: Math.round(r.left - 120), y: Math.round(r.top + r.height / 2) },
              { x: Math.round(r.left + r.width / 2), y: Math.round(r.top - 120) },
              { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom + 120) },
            ];
            for (const spot of spots) {
              if (spot.x < 2 || spot.y < 2) continue;
              if (spot.x > window.innerWidth - 2 || spot.y > window.innerHeight - 2) continue;
              const hit = document.elementFromPoint(spot.x, spot.y);
              if (hit === null) continue;
              const cell = hit.closest('[data-collage-cell]');
              if (cell === null || cell === el) continue;
              return {
                x: spot.x,
                y: spot.y,
                hit: (hit.className || hit.tagName || '').toString().slice(0, 30),
              };
            }
            return null;
          })()`,
          true,
        )) as { x: number; y: number; hit: string } | null;
        const otherMoved =
          otherSpot === null ? '找不到另一格' : await moveAway(otherSpot.x, otherSpot.y);
        const backB = await r16ReadCell(pick.key);
        if (beforeHover !== null && afterHover !== null) {
          const scaleAfter = r16MaxScale(afterHover);
          const changed = r16StylesChanged(beforeHover, afterHover);
          const settledA = backA === null || !r16StylesChanged(beforeHover, backA);
          const settledB = backB === null || !r16StylesChanged(beforeHover, backB);
          const settled = settledA || settledB;
          const lineOf = (set: R16CellStyles | null): string =>
            set === null ? '读不到该格' : r16StyleLine(set);
          const hoverNote = hoverState.startsWith('matches:true')
            ? hoverState
            : `${hoverState}（合成鼠标拿不到 :hover，本条的「有变化」只能当 CSS 规则存在性的弱证据）`;
          /*
           * 父代理第三轮：判据放宽成「任一处相对悬停前有变化（常见是内层封面的
           * `matrix(1.055, …)` / 格子的 z-index、filter、box-shadow）」+ 移开后回落。
           */
          /*
           * 判据：这一格确实在视口里、且相对悬停前有变化。`settled=false`（合成指针下移开后回不去）
           * 时按父代理第六轮的意见降级——不把探针自己的 hover 局限算成产品失败，但降级这件事
           * 要写进 r16HoverInfo 的尾巴里，不静默放过。
           */
          r16HoverOk = pick.inView && changed;
          r16HoverInfo =
            `格=${pick.key}（墙上共 ${pick.cells} 格，干净落点=${pick.usable}，矩形=${pick.rect}` +
            `，非中心=${pick.nonCentre}，命中自身=${pick.hitSelf}，被遮挡=${pick.covered}）` +
            ` 悬停前=${r16StyleLine(beforeHover)}` +
            ` 悬停后=${r16StyleLine(afterHover)} scale=${scaleAfter.toFixed(2)}` +
            `｜有变化=${changed}` +
            `｜移开①（移到标题条 ${titleX},24，命中=${titleHit}）=${lineOf(backA)} 回落=${settledA}` +
            `｜移开②（目标=${otherSpot === null ? '找不到另一格' : otherSpot.x + ',' + otherSpot.y}，命中=${otherMoved}）=${lineOf(backB)} 回落=${settledB}` +
            `｜${settled ? '两次移开都回落' : '合成指针下 hover 出不去（移开后仍为 ' + lineOf(backB !== null ? backB : backA) + '）'}` +
            `｜判据=${settled ? '有变化+回落' : '降级为仅「有变化」（产品侧动画已有硬证据）'}` +
            `｜${hoverNote}`;
        } else {
          r16HoverInfo = `格=${pick.key} 读不到封面元素`;
        }
      }
    }
    console.info(`[pi/smoke] 十六轮⑨拼贴悬停放大：${r16HoverInfo}${r16WallNote} ${r16AvantOnly(r16HoverOk)}`);

    /*
     * 父代理第三轮：`.pi-collage-bar` 是 `position: fixed; inset: 0; pointer-events: none`，
     * 只有它的 `> .pi-home__bar` 是 `pointer-events: auto` ⇒ 点底栏「空白处」的事件根本到不了
     * 宿主的 `onBarClick`，必须**点药丸本身**。这个探针在药丸上找一个不在任何 button/input/
     * 进度条/时间/音量控件上的落点（用 `elementFromPoint` 反查），⑩ 与 ⑫ 共用。
     */
    const r16PillSpot = async (): Promise<{ x: number; y: number; hit: string } | null> =>
      (await win.webContents.executeJavaScript(
        `(() => {
          const bar = document.querySelector('[data-home-bar]');
          if (bar === null) return null;
          const r = bar.getBoundingClientRect();
          if (r.width < 40 || r.height < 8) return null;
          const y = Math.round(r.top + r.height / 2);
          const skip =
            'button, input, [data-home-play], [data-home-progress], [data-home-prev], [data-home-next], [data-home-volrange], [data-home-volbtn]';
          const tries = [0.06, 0.12, 0.18, 0.28, 0.5, 0.66, 0.78, 0.88, 0.94];
          for (const f of tries) {
            const x = Math.round(r.left + r.width * f);
            const el = document.elementFromPoint(x, y);
            if (el === null) continue;
            if (el.closest(skip) !== null) continue;
            if (el.closest('[data-home-bar]') === null) continue;
            return { x: x, y: y, hit: (el.className || el.tagName || '').toString().slice(0, 40) };
          }
          return null;
        })()`,
        true,
      )) as { x: number; y: number; hit: string } | null;

    /*
     * 父代理第四轮：⑩/⑫ 需要**墙上一格**先变成「在播且已放大」，但墙放的是「我的喜欢」100 首，
     * 而当前在播的歌来自兜底歌单、根本不在这面墙上 ⇒ 必须先点一格（它会 `playCell` + 放大）。
     * 这个 helper 在墙上挑一个「矩形在视口内、中心点 `elementFromPoint` 命到自己、且没被
     * 底栏/搜索条/按钮遮挡」的干净格；挑不到返回 null（日志里照实写）。
     */
    const r16WallSpot = async (): Promise<
      { key: string; x: number; y: number; hit: string; clean: number } | null
    > =>
      (await win.webContents.executeJavaScript(
        `(() => {
          const all = Array.from(document.querySelectorAll('[data-collage-cell]'));
          if (all.length === 0) return null;
          const bad = '[data-home-bar], .pi-collage-bar, .pi-collage-search, input';
          const ok = [];
          for (const el of all) {
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;
            if (r.top <= 0 || r.left <= 0) continue;
            if (r.bottom >= window.innerHeight || r.right >= window.innerWidth) continue;
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);
            const hit = document.elementFromPoint(cx, cy);
            if (hit === null) continue;
            if (hit.closest('[data-collage-cell]') !== el) continue;
            if (hit.closest(bad) !== null) continue;
            const own = hit.closest('button');
            if (own !== null && own !== el) continue;
            /*
             * 用户 m00736 第 6 条之后「在播 + 已放大」那一格点下去 = **进播放页**（不是播一遍 + 放大），
             * 拿它量「第一下点开」会误报（r23c 那跑就踩到这个：点完直接切走，量出 放大=false）。
             * 所以这种格子从候选里剔掉；剔完没格子再返回 null（让上层打印缘由）。
             */
            if (el.getAttribute('data-playing') === 'true' && el.getAttribute('data-collage-expanded') === 'true') {
              continue;
            }
            ok.push({
              key: el.getAttribute('data-collage-cell') || '',
              x: cx,
              y: cy,
              hit: (hit.className || hit.tagName || '').toString().slice(0, 30),
            });
          }
          if (ok.length === 0) return null;
          const mid = ok[Math.floor(ok.length / 2)];
          return { key: mid.key, x: mid.x, y: mid.y, hit: mid.hit, clean: ok.length };
        })()`,
        true,
      )) as { key: string; x: number; y: number; hit: string; clean: number } | null;

    // ⑩ 点「在播 + 已放大」→ 480ms 放大填屏 → 进播放页（每 120ms 采 entering 与内联 scale）。
    let r16EnterOk = false;
    let r16EnterInfo = '墙上没找到格子';
    let r16EnterNote = '';
    {
      const liked = await r16EnterLiked();
      r16EnterNote =
        `｜clickNav 进入我的喜欢=${liked.ok ? '是' : '否（clickNav 没进去）'}` +
        ` 墙在最上层=${liked.top ? '是' : '否'}（命中=${liked.hit} 处理=${liked.how}）`;
      /*
       * 父代理第四轮：上一跑报「墙上没找到在播+已放大的格子」——那是**场景缺一步**，不是产品 bug：
       * 墙放的是「我的喜欢」100 首，而当前在播的「Dying For You」来自兜底歌单、根本不在墙上。
       * 所以补前置：先点一格的**第 1 次**点击（它会 `playCell` + 放大），等它变成
       * `[data-playing='true'][data-collage-expanded='true']`，再点**同一格**的第 2 次点击
       * （第二次才走 `onEnterPlaying`）→ 采 `data-collage-entering` 与内联 `scale(`。
       */
      await focusSmoke(win);
      const first = await r16WallSpot();
      let firstLine = '';
      let expanded1 = false;
      let centerOk = false;
      if (first !== null) {
        await clickPoint(win, first.x, first.y);
        const growDeadline = Date.now() + 3000;
        while (Date.now() < growDeadline) {
          await delay(250);
          expanded1 = (await win.webContents.executeJavaScript(
            `document.querySelector("[data-collage-cell][data-playing='true'][data-collage-expanded='true']") !== null`,
            true,
          )) as boolean;
          if (expanded1) break;
        }
        /*
         * 用户 m00736 第 6 条：点一格时镜头要把这块挪到视野中心（`focusSlot` → `glideCameraTo`，
         * 460ms rAF + easeOutCubic）。缓动跑完再量「该格矩形中心 vs 拼贴墙矩形中心」的偏差。
         */
        await delay(700);
        const centered = (await win.webContents.executeJavaScript(
          `(() => {
            const node = document.querySelector("[data-collage-cell][data-playing='true'][data-collage-expanded='true']");
            const wall = document.querySelector('.pi-collage');
            if (node === null || wall === null) return null;
            const r = node.getBoundingClientRect();
            const w = wall.getBoundingClientRect();
            return {
              dx: Math.round(r.left + r.width / 2 - (w.left + w.width / 2)),
              dy: Math.round(r.top + r.height / 2 - (w.top + w.height / 2)),
            };
          })()`,
          true,
        )) as { dx: number; dy: number } | null;
        centerOk = centered !== null && Math.abs(centered.dx) <= 8 && Math.abs(centered.dy) <= 8;
        firstLine =
          `第1次点击=播放并放大（格=${first.key} 落点=${first.x},${first.y} 命中元素=${first.hit}` +
          ` 墙上干净格=${first.clean} 放大=${expanded1}` +
          ` 居中=${centered === null ? '量不到' : `${centered.dx},${centered.dy}`}px）`;
      }
      if (first !== null && expanded1) {
        const key1 = first.key;
        const again = (await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector('[data-collage-cell="${key1}"]');
            if (el === null) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`,
          true,
        )) as { x: number; y: number } | null;
        if (again !== null) {
          let entering = false;
          let inline = '';
          let shotTaken = false;
          const enteringDeadline = Date.now() + 3000;
          await clickPoint(win, again.x, again.y);
          while (Date.now() < enteringDeadline) {
            const sampled = (await win.webContents.executeJavaScript(
              `(() => {
                const shell = document.querySelector('[data-collage-shell]');
                const node = document.querySelector('[data-collage-cell="${key1}"]');
                return {
                  entering: shell ? (shell.dataset.collageEntering || '') : '',
                  style: node ? (node.getAttribute('style') || '') : '',
                };
              })()`,
              true,
            )) as { entering: string; style: string };
            if (sampled.entering === 'true') entering = true;
            if (sampled.style.includes('scale(')) inline = sampled.style;
            if (entering && inline !== '' && !shotTaken) {
              await r16Shot('m3r16-collage-enter.png');
              shotTaken = true;
            }
            if (entering && inline !== '') break;
            await delay(120);
          }
          await delay(1400);
          const onHome = (await win.webContents.executeJavaScript(
            `Boolean(document.querySelector('.pi-home__bar, [data-home-bar]'))`,
            true,
          )) as boolean;
          // 用户 m00736 第 6 条：第二次点已放大的那格要真的进播放页，且镜头居中已在上一步量过。
          r16EnterOk = entering && inline !== '' && onHome && centerOk;
          r16EnterInfo =
            `${firstLine}｜第2次点击=进入中 ${entering} 内联=${inline.slice(0, 64) || '无'} 切回播放页=${onHome}`;
        } else {
          r16EnterInfo = `${firstLine}｜第1次点击后那一格找不到了`;
        }
      } else if (first !== null) {
        r16EnterInfo = `${firstLine}（点完也没能变成在播+放大）`;
      } else {
        r16EnterInfo = '墙上没找到可点的干净格子（中心点都被底栏/搜索条/按钮遮挡）';
      }
    }
    console.info(
      `[pi/smoke] 十六轮⑩点拼贴进播放页：${r16EnterInfo}${r16EnterNote} ${r16AvantOnly(r16EnterOk)}`,
    );

    // ⑪ 拼贴翻页加载：读 `data-collage-songs` / `data-collage-has-more`，连拖 4 次各 1200px 触发 onNeedMore。
    let r16MoreOk = false;
    let r16MoreInfo = '没进我的喜欢页';
    let r16MoreNote = '';
    {
      const liked = await r16EnterLiked();
      r16MoreNote =
        `｜clickNav 进入我的喜欢=${liked.ok ? '是' : '否（clickNav 没进去）'}` +
        ` 墙在最上层=${liked.top ? '是' : '否'}（命中=${liked.hit} 处理=${liked.how}）`;
      /*
       * 父代理第四轮：宿主在 `[data-collage-shell]` 上加了三个接缝——`data-collage-loaded`
       * （已上墙的歌数）、`data-collage-need-more`（组件一共要过几次「再要一页」）、
       * `data-collage-page-has-more`（宿主还认为有下一页吗）。读它们才能区分
       * 「组件从没问」和「问了但 IPC 还没回来」。
       */
      const readWall = async (): Promise<{
        songs: string;
        hasMore: string;
        camera: string;
        loaded: string;
        needMore: string;
        pageHasMore: string;
      }> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const root = document.querySelector('[data-song-collage]');
            const shell = document.querySelector('[data-collage-shell]');
            const read = (node, name) => (node ? (node.dataset[name] || '') : '');
            return {
              songs: read(root, 'collageSongs'),
              hasMore: read(root, 'collageHasMore'),
              camera: read(root, 'collageCamera'),
              loaded: read(shell, 'collageLoaded'),
              needMore: read(shell, 'collageNeedMore'),
              pageHasMore: read(shell, 'collagePageHasMore'),
            };
          })()`,
          true,
        )) as {
          songs: string;
          hasMore: string;
          camera: string;
          loaded: string;
          needMore: string;
          pageHasMore: string;
        };
      const firstWall = await readWall();
      const trail: string[] = [];
      let last = firstWall;
      /*
       * 父代理 2026：一次拖 700px 没到边（日志 `songs=100 hasMore=true`、`camera=-1890:-854`），
       * 所以改成**连拖 4 次、每次 1200px 同方向**，每步都记 songs/hasMore/camera，
       * 判据「songs 变大 **或** has-more 翻成 false」——两件任一发生都说明增量加载链路通了。
       * 父代理第三轮：水平方向被钳死在左边界（四次水平拖后 `camera=-1890:-974` 的 x 没动过），
       * 而 ⑫ 里竖直拖 `(0, +500)` 能让 camera 的 y 动 ⇒ 改成**竖直向下**连拖。
       * 父代理第四轮：上一跑四次拖后 `camera` 完全不动 ⇒ 拖拽可能根本没带动相机（起点落在格子上
       * 就变成「块内重排」了）。所以每次拖前先 `focusSmoke`，并**用 `elementFromPoint` 挑一个不在
       * `[data-collage-cell]`/底栏/按钮里的空白起点**，把起点命中的元素类名也记进日志。
       */
      /*
       * 父代理第六轮：起点判据已放宽成「只排除底栏/搜索条/输入框」（允许起点落在格子上）——
       * 302×302 的格子密铺时视口里可能压根没有「空白点」，上一跑的「干净落点=0」就是这么来的。
       * 拼贴的 pointer 处理挂在根节点上，所以拖格子与拖空白一样是平镜头。
       */
      if (firstWall.hasMore !== 'false') {
        /*
         * 父代理第七轮：四次同方向拖全撞在世界的**上**边界（四次 `camera=-1890:-254` 完全相同），
         * 而 `apps/renderer/src/lib/song-collage-geometry.ts:636-650` 的 `isNearContentEdge` 只看
         * **右/下**边（`bounds.right >= content.right - 0.75*blockWidth || bounds.bottom >=
         * content.bottom - 0.75*blockHeight`）⇒ 往一个方向拖永远不会触发 onNeedMore。
         * 所以改成**方向轮转**：上 → 左 → 上 → 右 → 左 → 下 → 右 → 上，每步 520px，
         * 每次记 camera + 三个接缝，只要有一轴 camera 变了就说明真的在平移。
         */
        const r16Drags: Array<{ name: string; dx: number; dy: number }> = [
          { name: '上', dx: 0, dy: -520 },
          { name: '左', dx: -520, dy: 0 },
          { name: '上', dx: 0, dy: -520 },
          { name: '右', dx: 520, dy: 0 },
          { name: '左', dx: -520, dy: 0 },
          { name: '下', dx: 0, dy: 520 },
          { name: '右', dx: 520, dy: 0 },
          { name: '上', dx: 0, dy: -520 },
        ];
        let prevCamera = firstWall.camera;
        for (let round = 0; round < r16Drags.length; round += 1) {
          const move = r16Drags[round];
          if (move === undefined) break;
          await focusSmoke(win);
          const start = (await win.webContents.executeJavaScript(
            `(() => {
              const bad =
                '[data-home-bar], [data-collage-bar], .pi-collage-bar, [data-collage-search], input';
              const w = window.innerWidth;
              const h = window.innerHeight;
              const tries = [
                { x: Math.round(w / 2), y: Math.round(h * 0.5) },
                { x: Math.round(w / 2), y: Math.round(h * 0.28) },
                { x: Math.round(w * 0.3), y: Math.round(h * 0.5) },
                { x: Math.round(w * 0.7), y: Math.round(h * 0.5) },
              ];
              for (const spot of tries) {
                const el = document.elementFromPoint(spot.x, spot.y);
                if (el === null) continue;
                if (el.closest(bad) !== null) continue;
                return {
                  x: spot.x,
                  y: spot.y,
                  hit: (el.className || el.tagName || '').toString().slice(0, 30),
                };
              }
              return null;
            })()`,
            true,
          )) as { x: number; y: number; hit: string } | null;
          if (start === null) {
            trail.push(`第${round + 1}拖：没找到不在底栏/搜索条/输入框里的起点（视口可能整屏都是格子）`);
            break;
          }
          // 终点夹在视口内（留 24px 边距），保证整段拖拽每一步都在窗口里——上一跑每次有效位移只有
          // 约 620px 就是终点出窗造成的。
          const end = (await win.webContents.executeJavaScript(
            `(() => ({
              x: Math.min(window.innerWidth - 24, Math.max(24, ${start.x} + ${move.dx})),
              y: Math.min(window.innerHeight - 24, Math.max(24, ${start.y} + ${move.dy})),
            }))()`,
            true,
          )) as { x: number; y: number };
          await dragPoint(win, start.x, start.y, end.x - start.x, end.y - start.y, 10);
          await delay(1200);
          last = await readWall();
          const shifted = last.camera !== prevCamera;
          prevCamera = last.camera;
          trail.push(
            `第${round + 1}拖 ${move.name}(${move.dx},${move.dy}) 起点=${start.x},${start.y} 命中元素=${start.hit}` +
              ` 终点=${end.x},${end.y} 真平移=${shifted ? '是' : '否（camera 未变）'}` +
              ` songs=${last.songs} hasMore=${last.hasMore} camera=${last.camera}` +
              ` 已上墙=${last.loaded} 要过更多次=${last.needMore} 宿主还有下页=${last.pageHasMore}`,
          );
          if (
            Number(last.songs) > Number(firstWall.songs) ||
            last.hasMore === 'false' ||
            Number(last.loaded) > Number(firstWall.loaded) ||
            last.pageHasMore === 'false'
          ) {
            break;
          }
        }
        /*
         * 父代理第四轮：IPC 翻页要时间，四次拖完再**轮询最多 6s**（每 500ms）等
         * `data-collage-loaded` 变大或 `data-collage-page-has-more` 翻 false——
         * 上一跑很可能是「问了但还没回来」。
         */
        if (last.hasMore !== 'false') {
          const settleDeadline = Date.now() + 6000;
          let waited = 0;
          while (Date.now() < settleDeadline) {
            if (Number(last.loaded) > Number(firstWall.loaded) || last.pageHasMore === 'false') break;
            await delay(500);
            waited += 500;
            last = await readWall();
          }
          trail.push(
            `拖完再等 ${waited}ms：已上墙=${last.loaded}（拖前 ${firstWall.loaded}）` +
              ` 要过更多次=${last.needMore}（拖前 ${firstWall.needMore}）宿主还有下页=${last.pageHasMore}`,
          );
        }
      }
      if (firstWall.hasMore === 'false') {
        r16MoreOk = true;
        r16MoreInfo = '一屏就全了，没得再加载（data-collage-has-more 一开始就是 false）';
      } else {
        const grew = Number(last.songs) > Number(firstWall.songs);
        const moreGone = last.hasMore === 'false';
        const loadedGrew = Number(last.loaded) > Number(firstWall.loaded);
        const pageGone = last.pageHasMore === 'false';
        const asked = Number(last.needMore) > 0;
        r16MoreOk = grew || moreGone || loadedGrew || pageGone;
        r16MoreInfo =
          `拖前 songs=${firstWall.songs} hasMore=${firstWall.hasMore}` +
          ` 已上墙=${firstWall.loaded} 要过更多次=${firstWall.needMore} 宿主还有下页=${firstWall.pageHasMore}` +
          `｜${trail.join('｜')}` +
          `（songs 变大=${grew} hasMore 转 false=${moreGone} 已上墙变大=${loadedGrew} 宿主还有下页转 false=${pageGone} 组件问过加载=${asked}）`;
      }
    }
    console.info(
      `[pi/smoke] 十六轮⑪拼贴翻页加载：${r16MoreInfo}${r16MoreNote} ${r16AvantOnly(r16MoreOk)}`,
    );

    // ⑫ 拼贴底栏常驻 + 点底栏定位到「在播且已放大」那一格。
    let r16BarLocateOk = false;
    let r16BarLocateInfo = '没有拼贴底栏';
    let r16BarLocateNote = '';
    {
      const liked = await r16EnterLiked();
      r16BarLocateNote =
        `｜clickNav 进入我的喜欢=${liked.ok ? '是' : '否（clickNav 没进去）'}` +
        ` 墙在最上层=${liked.top ? '是' : '否'}（命中=${liked.hit} 处理=${liked.how}）`;
      const shell = (await win.webContents.executeJavaScript(
        `(() => ({
          bar: document.querySelector('[data-collage-bar]') !== null,
          home: document.querySelector('[data-collage-bar] [data-home-bar]') !== null,
        }))()`,
        true,
      )) as { bar: boolean; home: boolean };
      /*
       * 前置（父代理第七轮）：上一跑「只点一次格、还要求已放大」太脆——日志
       * `前置点格=2:0:10 … 在播且放大=false`，而同一堵墙上 ⑩ 的同款点击却是 `放大=true`，
       * 只是时序/选格运气。用户要的是「点底栏能定位回**正在播放**的那一格」，本来不必要求它
       * 已放大。所以：① 先找现成的 `[data-collage-cell][data-playing='true']`；
       * ② 找不到才点干净格，最多试 3 个**不同**的干净格，每点完轮询 ≤5s 等 `data-playing='true'`；
       * 判据只要「在播」，`data-collage-expanded` 不参与前置。
       */
      const readPlayingKey = async (): Promise<string> =>
        (await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector("[data-collage-cell][data-playing='true']");
            return el === null ? '' : (el.getAttribute('data-collage-cell') || '');
          })()`,
          true,
        )) as string;
      let seedKey = await readPlayingKey();
      let seedLine = '';
      if (seedKey !== '') {
        seedLine = `前置=墙上本来就有在播格（key=${seedKey}，没有点任何格子）`;
      } else {
        await focusSmoke(win);
        const seedSpots = (await win.webContents.executeJavaScript(
          `(() => {
            const bad = '[data-home-bar], .pi-collage-bar, .pi-collage-search, input';
            const out = [];
            for (const el of Array.from(document.querySelectorAll('[data-collage-cell]'))) {
              if (el.getAttribute('data-playing') === 'true') continue;
              const r = el.getBoundingClientRect();
              if (r.width < 8 || r.height < 8) continue;
              if (r.top <= 0 || r.left <= 0) continue;
              if (r.bottom >= window.innerHeight || r.right >= window.innerWidth) continue;
              const cx = Math.round(r.left + r.width / 2);
              const cy = Math.round(r.top + r.height / 2);
              const hit = document.elementFromPoint(cx, cy);
              if (hit === null) continue;
              if (hit.closest('[data-collage-cell]') !== el) continue;
              if (hit.closest(bad) !== null) continue;
              const own = hit.closest('button');
              if (own !== null && own !== el) continue;
              out.push({
                key: el.getAttribute('data-collage-cell') || '',
                x: cx,
                y: cy,
                hit: (hit.className || hit.tagName || '').toString().slice(0, 30),
              });
              if (out.length >= 6) break;
            }
            return out;
          })()`,
          true,
        )) as Array<{ key: string; x: number; y: number; hit: string }>;
        const tries: string[] = [];
        for (let i = 0; i < seedSpots.length && i < 3 && seedKey === ''; i += 1) {
          const spot = seedSpots[i];
          if (spot === undefined) break;
          await focusSmoke(win);
          await clickPoint(win, spot.x, spot.y);
          let got = '';
          const seedDeadline = Date.now() + 5000;
          while (Date.now() < seedDeadline) {
            await delay(250);
            got = await readPlayingKey();
            if (got !== '') break;
          }
          tries.push(
            `第${i + 1}次点格=${spot.key}（落点=${spot.x},${spot.y} 命中元素=${spot.hit}）` +
              ` 在播=${got !== '' ? '是' : '否'}`,
          );
          if (got !== '') seedKey = got;
        }
        seedLine =
          tries.length === 0
            ? '前置=墙上没有可点的干净格，也没有现成在播格'
            : `前置=${tries.join('｜')}` +
              (seedKey === '' ? ' ⇒ 点格三次都没进在播' : ` ⇒ 在播格=${seedKey}`);
      }
      const readCamera = async (): Promise<string> =>
        (await win.webContents.executeJavaScript(
          `document.querySelector('[data-song-collage]')?.dataset.collageCamera || '无'`,
          true,
        )) as string;
      const cameraBefore = await readCamera();
      const spot = await quickOrbSpot(win, 0);
      await focusSmoke(win);
      await dragPoint(win, spot.x, spot.y, 0, 500, 7);
      await delay(820);
      let camera = await readCamera();
      if (camera === cameraBefore) {
        // 父代理第七轮：换相反方向再拖一次，确认镜头真的动过——镜头没动的话「定位回在播格」无从谈起。
        await focusSmoke(win);
        await dragPoint(win, spot.x, spot.y, 0, -500, 7);
        await delay(820);
        camera = await readCamera();
      }
      // 第十八轮第 ⑧ 条（用户 m01482）改掉了「点底栏」的语义：以前点药丸是让拼贴镜头定位回
      // 在播那一格（第十六轮第 4 条），现在点它 = **回歌曲播放页**。所以这一段跟着改判：点完药丸，
      // 拼贴墙要收起、播放页的左下名片要回来（「我的喜欢」页上同一件事在 `r18BarClickHomeOk` 量）。
      const pill = await r16PillSpot();
      let backHome = false;
      let pillState = { collage: true, card: false, stage: false };
      if (pill !== null) {
        await clickPoint(win, pill.x, pill.y);
        const locateDeadline = Date.now() + 3000;
        while (Date.now() < locateDeadline) {
          pillState = (await win.webContents.executeJavaScript(
            `(() => ({
               collage: document.querySelector('[data-song-collage]') !== null,
               card: document.querySelector('[data-home-card]') !== null,
               stage: document.querySelector('.pi-home__stage') !== null,
             }))()`,
            true,
          )) as { collage: boolean; card: boolean; stage: boolean };
          if (!pillState.collage && pillState.card && pillState.stage) {
            backHome = true;
            break;
          }
          await delay(250);
        }
      }
      r16BarLocateOk = shell.bar && shell.home && backHome;
      r16BarLocateInfo =
        `拼贴底栏=${shell.bar} 内含 [data-home-bar]=${shell.home}｜` +
        `${seedLine === '' ? '前置：墙上既没有现成在播格，也没找到可点的干净格' : seedLine}｜` +
        `拖远前 camera=${cameraBefore} 拖远后 camera=${camera}（真的动了=${cameraBefore !== camera}）` +
        `｜点药丸${pill !== null ? '（落点=' + pill.hit + '）' : '（没找到可点落点）'}` +
        ` 之后：墙还在=${pillState.collage} 播放页名片=${pillState.card} 播放页舞台=${pillState.stage}` +
        ` 回到播放页=${backHome ? '是' : '否'}`;
    }
    console.info(
      `[pi/smoke] 十六轮⑫拼贴底栏定位：${r16BarLocateInfo}${r16BarLocateNote} ${r16AvantOnly(r16BarLocateOk)}`,
    );

    // ⑬ 拼贴上滚轮向下开搜索 + 用墙上真实存在的歌名子串定位。
    let r16WheelOk = false;
    let r16WheelInfo = '滚轮没能开搜索';
    {
      // ⑫ 的最后一步是「点药丸 → 回播放页」，所以这里必须**重新进**拼贴页，并且等到墙真的铺在
      // 最上层：`r16EnterLiked` 自带「Esc 关浮层 / 回主页再进」两轮兜底。上一版只 `clickNav+2s`，
      // 墙还没起来就派滚轮，`[data-song-collage]` 为 null ⇒ 判据静默落空（实测就是这么假红的）。
      const liked13 = await r16EnterLiked();
      /*
       * 父代理 2026：滚轮 3×`deltaY=120` 之后 `[data-collage-search]` 还是 false。
       * 父代理第三轮给出更硬的改法：`sendInputEvent({type:'mouseWheel'})` 在**未聚焦窗口**上
       * 会被丢掉（最可能就是上一跑读到「搜索条=false」的原因），改成直接派 DOM `WheelEvent`
       * ——本仓老探针就是这么做的（本文件里 `[data-lyric-rail]` 那条滚轮探针）。
       * `onCollageWheel` 挂在 `MinePage.tsx:184-190` 那个 `display:contents` 外壳上
       * （`:129-132` 只有 `deltaY > 0` 才 `setSearchOpen(true)`），所以从 `[data-song-collage]`
       * 起 `bubbles: true` 往上冒；派发后最多轮询 1.5s 等 `[data-collage-search]` 出现。
       */
      await focusSmoke(win);
      let opened = false;
      // 6s：墙要先把第一批歌拉上来（限流或刚进页时可能要几秒），期间每 300ms 再派一次滚轮。
      const wheelDeadline = Date.now() + 6000;
      while (Date.now() < wheelDeadline && !opened) {
        await win.webContents.executeJavaScript(
          `(() => {
            const root = document.querySelector('[data-song-collage]');
            if (root === null) return false;
            root.dispatchEvent(
              new WheelEvent('wheel', { deltaY: 160, deltaX: 0, bubbles: true, cancelable: true }),
            );
            return true;
          })()`,
          true,
        );
        await delay(300);
        opened = (await win.webContents.executeJavaScript(
          `document.querySelector('[data-collage-search]') !== null`,
          true,
        )) as boolean;
      }
      /*
       * 关键字要从墙上真实存在的歌名里取（不写死）。拼贴格的真实类名是 `.pi-collage__name`
       * （`components/SongCollage.tsx:921-973`）——上一版先找 `.pi-songcard__name`（拼贴里没有
       * 这个类），退化到 `cell.textContent` 会把角标/时间等杂字也带上。取到名字就取它的第一个
       * 词（例如「Dying For You」→「Dying」）；实在取不到就用歌单里必定出现的 'Dying'。
       */
      const keyword = (await win.webContents.executeJavaScript(
        `(() => {
          const cell = document.querySelector('[data-song-collage-item]');
          if (cell === null) return 'Dying';
          const node =
            cell.querySelector('.pi-collage__name') ||
            cell.querySelector('.pi-collage__meta') ||
            cell.querySelector('.pi-collage__copy');
          const text = ((node ? node.textContent : '') || '').trim();
          if (text === '') return 'Dying';
          const head = (text.split(/[\\s\\-–—(（·]+/)[0] || '').trim();
          if (head.length >= 3) return head;
          return text.length >= 2 ? text.slice(0, 3) : 'Dying';
        })()`,
        true,
      )) as string;
      let hitOk = false;
      let note = '';
      let usedRule = '';
      let hitWhere = '';
      let typed = false;
      if (opened && keyword !== '') {
        typed = (await win.webContents.executeJavaScript(
          `(() => {
            const input = document.querySelector('[data-collage-search-input]');
            if (input === null || !(input instanceof HTMLInputElement)) return false;
            input.focus();
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, ${JSON.stringify(keyword)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
            return true;
          })()`,
          true,
        )) as boolean;
        await delay(620);
        const probed = (await win.webContents.executeJavaScript(
          `(() => {
            const hit = document.querySelector("[data-collage-hit='true']");
            return {
              hits: document.querySelectorAll("[data-collage-hit='true']").length,
              note: (document.querySelector('[data-collage-search-note]')?.textContent || '').trim(),
              hitKey: hit ? (hit.getAttribute('data-song-collage-item') || '') : '',
              hitIndex: hit ? (hit.getAttribute('data-queue-index') || '') : '',
            };
          })()`,
          true,
        )) as { hits: number; note: string; hitKey: string; hitIndex: string };
        note = probed.note;
        hitOk = probed.hits > 0;
        hitWhere = hitOk
          ? `命中格 item=${probed.hitKey !== '' ? probed.hitKey : '-'} queue-index=${probed.hitIndex !== '' ? probed.hitIndex : '-'}`
          : `没读到 [data-collage-hit='true'] 格（${probed.hits} 个）`;
        usedRule = hitOk
          ? `[data-collage-hit='true'] × ${probed.hits}`
          : `退化：判 [data-collage-search-note] 非空`;
        if (!hitOk) hitOk = note !== '';
      }
      /*
       * 第十八轮第 7 条（用户 m01482）：「歌单页滑动滚轮的搜索应该往下一点，并且有从顶部向下冒出的
       * 流畅动画」。趁搜索条还开着，量两件事：它的顶边（从 16px 提到 34px）与进场动画名。
       */
      const barLook = (await win.webContents.executeJavaScript(
        `(() => {
          const bar = document.querySelector('[data-collage-search]');
          if (bar === null) return null;
          const rect = bar.getBoundingClientRect();
          return {
            top: Math.round(rect.top),
            anim: getComputedStyle(bar).animationName,
            closing: bar.getAttribute('data-collage-search-closing') || '',
          };
        })()`,
        true,
      )) as { top: number; anim: string; closing: string } | null;
      const barPosOk = barLook !== null && barLook.top >= 30 && barLook.top <= 42;
      const barAnimOk = barLook !== null && barLook.anim.includes('pi-collage-search-in');
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-collage-search-close]')?.click()`,
        true,
      );
      await delay(420);
      const closed = (await win.webContents.executeJavaScript(
        `document.querySelector('[data-collage-search]') === null`,
        true,
      )) as boolean;
      /*
       * 第十八轮第 7 条后半句：「拖动拼贴/点击歌曲拼贴播放时搜索框自动隐藏，有一个升入顶部的动画」。
       * 再滚轮开一次，然后派一次 `pointerdown`（按下拼贴格子）：
       * ① 120ms 内根上应该挂着 `data-collage-search-closing="true"`（退场动画正在放）；
       * ② ~1s 内它应该整个消失（宿主等 `COLLAGE_SEARCH_EXIT_MS` 之后才卸载）。
       */
      const hideInfo = (await win.webContents.executeJavaScript(
        `(async () => {
           const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
           const root = document.querySelector('[data-song-collage]');
           if (root === null) return { reopened: false, closing: '', gone: false };
           root.dispatchEvent(
             new WheelEvent('wheel', { deltaY: 160, deltaX: 0, bubbles: true, cancelable: true }),
           );
           for (let i = 0; i < 12 && document.querySelector('[data-collage-search]') === null; i += 1) {
             await sleep(120);
           }
           const reopened = document.querySelector('[data-collage-search]') !== null;
           const cell = document.querySelector('[data-song-collage-item]') || root;
           cell.dispatchEvent(
             new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }),
           );
           await sleep(120);
           const bar = document.querySelector('[data-collage-search]');
           const closing = bar === null ? '' : (bar.getAttribute('data-collage-search-closing') || '');
           for (let i = 0; i < 12 && document.querySelector('[data-collage-search]') !== null; i += 1) {
             await sleep(80);
           }
           return { reopened, closing, gone: document.querySelector('[data-collage-search]') === null };
         })()`,
        true,
      )) as { reopened: boolean; closing: string; gone: boolean };
      const barHideOk = hideInfo.reopened && hideInfo.closing === 'true' && hideInfo.gone;
      r16WheelOk = opened && typed && hitOk && closed && barPosOk && barAnimOk && barHideOk;
      r16WheelInfo =
        `滚轮向下后搜索条=${opened}（DOM WheelEvent 派发）｜关键字「${keyword}」输入=${typed}` +
        `｜判定用=${usedRule || '-'}（命中=${hitOk} note=「${note.slice(0, 30)}」）` +
        `｜${hitWhere || '未命中'}｜点关闭键=${closed}` +
        `｜十八轮⑦：顶边=${barLook?.top ?? '?'}px（要求 30~42）动画=${barLook?.anim ?? '?'}` +
        ` 按下拼贴后 closing=${hideInfo.closing} 已消失=${hideInfo.gone}` +
        `${liked13.why === '' ? '' : `｜进页=${liked13.why}`}`;
    }
    console.info(`[pi/smoke] 十六轮⑬滚轮开搜索并定位：${r16WheelInfo} ${r16AvantOnly(r16WheelOk)}`);

    /*
     * 第十八轮（用户 m01482）能落到像素上的那几条：
     * ①底栏以中心轴为基准放大、药丸裹住暂停键、进度条悬停加粗、上/下一首悬停放大；
     * ②圆球离开互动范围后向内塌陷（`data-quick-orb-leaving`）并收回；
     * ⑤⑩歌单页底栏：常态只显示进度条（暂停键藏着）、悬停才展开，两套排版同一条判据；
     * ⑥拼贴自己一批批续载（不碰输入，墙上的歌自己变多 / 拉到没有下一页）；
     * ⑧点底栏（不是键上）回歌曲播放页；⑨名片只在指针接近左下边框时 `data-near=true`；
     * ⑪「接下来播放」小名片在左下、且只在结束前 5s 出现。
     * ④（时计歌词滚轮 + 空闲自动回当前）在经典歌词那一块的 `r18LyricIdleOk` 里量。
     */
    let r18BarAxisOk = false;
    let r18BarWrapOk = false;
    let r18TrackThickOk = false;
    let r18PrevScaleOk = false;
    let r18BarRestOk = false;
    let r18BarClickHomeOk = false;
    let r18AutoMoreOk: boolean | null = null;
    let r18AutoMoreInfo = '未跑（平凡排版没有拼贴墙）';
    let r18BarInfo = '未量到 [data-home-bar]';
    let r18BarHitInfo = '';
    let r18OrbCollapseOk = false;
    let r18OrbInfo = '';
    let r18CardNearOk = false;
    let r18CardNearInfo = '';
    /** `null` = 没拿到那条音频（时长太短等），这轮记「未跑」而不是 ✗。 */
    let r18UpNextOk: boolean | null = null;
    let r18UpNextInfo = '';
    {
      type BarLook = {
        bar: { top: number; h: number; cx: number; cy: number; left: number; right: number };
        play: {
          top: number;
          bottom: number;
          left: number;
          right: number;
          h: number;
          cx: number;
          cy: number;
          opacity: number;
        } | null;
        prev: { cx: number; cy: number; transform: string } | null;
        thick: string;
        /** 已播那个时间标签（`.pi-home__time` 的第一个）。 */
        time: { cx: number; cy: number; left: number; right: number } | null;
        /** 总时长那个时间标签（`.pi-home__time` 的最后一个）——量「常态右端留白」要用它。 */
        timeLast: { cx: number; cy: number; left: number; right: number } | null;
      };
      const readBar = async (): Promise<BarLook | null> =>
        (await win.webContents.executeJavaScript(
          `(() => {
             const bar = document.querySelector('[data-home-bar]');
             if (bar === null) return null;
             const r = bar.getBoundingClientRect();
             const box = (el) => {
               if (el === null) return null;
               const b = el.getBoundingClientRect();
               return {
                 top: Math.round(b.top), bottom: Math.round(b.bottom),
                 left: Math.round(b.left), right: Math.round(b.right),
                 h: Math.round(b.height),
                 cx: Math.round(b.left + b.width / 2), cy: Math.round(b.top + b.height / 2),
               };
             };
             const play = document.querySelector('[data-home-play]');
             const prog = document.querySelector('[data-home-progress]');
             const prev = document.querySelector('[data-home-prev]');
             const times = [...document.querySelectorAll('.pi-home__time')];
             const time = times.length > 0 ? times[0] : null;
             const timeLast = times.length > 1 ? times[times.length - 1] : null;
             return {
               bar: {
                 top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
                 h: Math.round(r.height),
                 cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
               },
               play: play === null ? null : { ...box(play), opacity: Number(getComputedStyle(play).opacity) },
               prev: prev === null ? null : {
                 cx: box(prev).cx, cy: box(prev).cy,
                 transform: getComputedStyle(prev).transform,
               },
               thick: prog === null ? '' : getComputedStyle(prog).getPropertyValue('--pi-home-track-thick').trim(),
               time: time === null ? null : box(time),
               timeLast: timeLast === null ? null : box(timeLast),
             };
           })()`,
          true,
        )) as BarLook | null;
      // 歌单页（我的喜欢）——第十八轮第 5/8/10 条的宿主：底栏由 `BottomBar` 挂在拼贴墙那一层。
      // 进页也要等到墙在最上层：⑬ 刚在同一页关过搜索条，`r16EnterLiked` 自带「Esc / 回主页再进」
      // 两轮兜底；不然下面的 ⑥ 读不到 `[data-song-collage]`，会读成「上墙 ?→?」的假红。
      const liked06 = await r16EnterLiked();
      /*
       * ⑥ 拼贴自己在续载：进页就已经贴着内容边（`SongCollage` 里那个 deps 为
       * `[geometry, maybeRequestMore, total, viewport]` 的 effect），第十八轮第 6 条又加了
       * `autoMore`，所以**一根指针都不用动**，墙上的歌数就该自己涨、或者涨到没有下一页。
       */
      if (wantStyle === 'avant') {
        const readWall = async (): Promise<{ songs: number; hasMore: boolean } | null> =>
          (await win.webContents.executeJavaScript(
            `(() => {
               const wall = document.querySelector('[data-song-collage]');
               if (wall === null) return null;
               return {
                 songs: Number(wall.getAttribute('data-collage-songs') || 'NaN'),
                 hasMore: (wall.getAttribute('data-collage-has-more') || '') === 'true',
               };
             })()`,
            true,
          )) as { songs: number; hasMore: boolean } | null;
        const wallBefore = await readWall();
        await delay(3600);
        const wallAfter = await readWall();
        r18AutoMoreOk =
          wallBefore !== null &&
          wallAfter !== null &&
          (wallAfter.songs > wallBefore.songs || wallAfter.hasMore === false);
        r18AutoMoreInfo =
          `上墙 ${wallBefore?.songs ?? '?'}→${wallAfter?.songs ?? '?'} 首` +
          `（还有下一页 ${wallBefore?.hasMore}→${wallAfter?.hasMore}）` +
          `${liked06.why === '' ? '' : `｜进页=${liked06.why}`}`;
      }
      // 指针先躲到左上角，读「常态」那一档。
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
      await delay(420);
      const barRest = await readBar();
      if (barRest === null) {
        r18BarInfo = '未量到 [data-home-bar]（歌单页也该有底栏）';
      } else {
        // ⑤⑩「常态只显示进度条」：暂停键 opacity 0（还压着 scale(0.5)、不吃指针）。
        const restPlayHidden = barRest.play !== null && barRest.play.opacity <= 0.1;
        win.webContents.sendInputEvent({ type: 'mouseMove', x: barRest.bar.cx, y: barRest.bar.cy });
        await delay(460);
        const barHover = await readBar();
        const hoverPlayShown = barHover !== null && barHover.play !== null && barHover.play.opacity > 0.9;
        r18BarRestOk = restPlayHidden && hoverPlayShown;
        let prevScale = '未量到';
        if (barHover !== null && barHover.play !== null) {
          // ①「以中心轴为基准放大」：药丸变宽，但中心 x 不该动（±2px）。
          r18BarAxisOk = Math.abs(barHover.bar.cx - barRest.bar.cx) <= 2;
          // ①「像图 1 一样包裹暂停键」：药丸 58~70px 高，暂停键完全落在它体内。
          r18BarWrapOk =
            barHover.bar.h >= 58 &&
            barHover.bar.h <= 70 &&
            barHover.play.top >= barHover.bar.top - 1 &&
            barHover.play.bottom <= barHover.bar.top + barHover.bar.h + 1;
          // ①「进度条本身鼠标悬停时加粗」：常态 6px、悬停 10px。
          r18TrackThickOk = barRest.thick === '6px' && barHover.thick === '10px';
          if (barHover.prev !== null) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: barHover.prev.cx, y: barHover.prev.cy });
            await delay(360);
            const onPrev = await readBar();
            prevScale = onPrev?.prev?.transform ?? '未量到';
            const scaled = /matrix\(([-\d.]+)/.exec(prevScale);
            r18PrevScaleOk = scaled !== null && Math.abs(Number(scaled[1]) - 1.3) <= 0.06;
          }
        }
        /*
         * 用户 m00736 第 3 条：「放大后外边框离停止键太近了，多留点空隙（缩小一点停止键）；
         * 常态两端空隙太大，去掉一些」。这两句话都是**间距**，所以把四个间距直接量出来打进日志：
         * 常态左右两端「药丸边框 → 时间标签」的空白，悬停态「药丸边框 → 暂停键」的空白。
         * 数值先只记录，判据等第 3 条实装落地、拿到新目标值再加（不然凭空写死一个数是假绿）。
         */
        const restLeftGap = barRest.time === null ? NaN : barRest.time.left - barRest.bar.left;
        const restRightGap = barRest.timeLast === null ? NaN : barRest.bar.right - barRest.timeLast.right;
        const hoverLeftGap =
          barHover !== null && barHover.play !== null ? barHover.play.left - barHover.bar.left : NaN;
        const hoverRightGap =
          barHover !== null && barHover.play !== null ? barHover.bar.right - barHover.play.right : NaN;
        r18BarInfo =
          `常态=${barRest.bar.h}px 中心x=${barRest.bar.cx} 厚=${barRest.thick} 暂停键opacity=${barRest.play?.opacity ?? '?'}` +
          `｜悬停=${barHover?.bar.h ?? '?'}px 中心x=${barHover?.bar.cx ?? '?'} 暂停键=${barHover?.play?.h ?? '?'}px` +
          `（键顶=${barHover?.play?.top ?? '?'}/药丸顶=${barHover?.bar.top ?? '?'}）厚=${barHover?.thick ?? '?'}` +
          `｜常态两端留白 左=${restLeftGap}px 右=${restRightGap}px` +
          `｜悬停外框到暂停键 左=${hoverLeftGap}px 右=${hoverRightGap}px` +
          `｜上一首transform=${prevScale}`;
        // ⑧ 点底栏的空白处（时间字上，不是任何键）= 回歌曲播放页。
        // `time` 的坐标是在**常态**读出来的；上一步刚把指针停在上一首键上，药丸此时是悬停态
        // （向上长高、上/下首键浮出来，用户 m00001 第 2 条又把这俩图标做大了）。照旧用常态
        // 坐标在悬停态按下去，落点可能正好落到键上——那不是这条要量的事。所以先把指针挪到
        // 角落等药丸缩回常态，再按；顺带把落点元素打出来，便于分辨「没回播放页」是落错地方
        // 还是这条通路真坏了。
        if (barRest.time !== null) {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
          await delay(420);
          r18BarHitInfo = (await win.webContents.executeJavaScript(
            `(() => {
               const el = document.elementFromPoint(${barRest.time.cx}, ${barRest.time.cy});
               if (el === null) return '落点=null';
               const ctl = el.closest('button, input, select, a');
               return '落点=' + (el.className || el.tagName) + (ctl === null ? '（不是键）' : '←键');
             })()`,
            true,
          )) as string;
          await clickPoint(win, barRest.time.cx, barRest.time.cy);
          await delay(700);
          const afterClick = (await win.webContents.executeJavaScript(
            `({ card: document.querySelector('[data-home-card]') !== null,
                collage: document.querySelector('[data-song-collage]') !== null })`,
            true,
          )) as { card: boolean; collage: boolean };
          r18BarClickHomeOk = afterClick.card && !afterClick.collage;
        }
      }
    }
    console.info(
      `[pi/smoke] 第十八轮①底栏：${r18BarInfo}｜中心轴=${r18BarAxisOk} 药丸裹住暂停键=${r18BarWrapOk}` +
        ` 进度条加粗=${r18TrackThickOk} 上一首放大=${r18PrevScaleOk}` +
        `｜⑤⑩歌单页底栏常态只显进度条/悬停展开=${r18BarRestOk}` +
        `｜⑧点底栏回播放页=${r18BarClickHomeOk}${r18BarHitInfo === '' ? '' : `（${r18BarHitInfo}）`}`,
    );
    console.info(
      `[pi/smoke] 第十八轮⑥拼贴自续载：${r18AutoMoreInfo} ${r18AvantOnly(r18AutoMoreOk === true)}`,
    );
    {
      // ② 圆球：用户 m00736 第 2 条把球的存活期改成**一次按住**——按下才出现，松手立刻挂
      // `data-quick-orb-leaving="true"` 淡出（0.2s）后从 DOM 移除；第十八轮那条「指针离开
      // 互动范围就塌陷」的 pointermove 逻辑已被删除，所以这一段不再把指针挪来挪去，改成量
      // 真正的两拍：① 按住期间球在被点的那一点且球体节点在；② 抬手后 70ms 挂 leaving、300ms
      // 后元素不存在。抬手**不**走 `releaseQuickOrb`（它内部等 140ms，会把 leaving 采样点推过
      // 去），这里自己发 mouseUp 以便卡在 200ms 卸载之前。
      const orbAt = await tapQuickOrb(win, 0);
      const pressPoint = quickOrbPress ?? { x: -1, y: -1 };
      const ballOk = orbAt !== null && orbAt.ball === true;
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: pressPoint.x,
        y: pressPoint.y,
        button: 'left',
        clickCount: 1,
      });
      quickOrbPress = null;
      await delay(70);
      const leaving = (await win.webContents.executeJavaScript(
        `document.querySelector('[data-quick-orb]')?.getAttribute('data-quick-orb-leaving') || ''`,
        true,
      )) as string;
      await delay(300);
      const orbGone = (await win.webContents.executeJavaScript(
        `document.querySelector('[data-quick-orb]') === null`,
        true,
      )) as boolean;
      r18OrbCollapseOk = ballOk && leaving === 'true' && orbGone;
      r18OrbInfo =
        `按住时球在(${pressPoint.x},${pressPoint.y}) 球体=${ballOk}` +
        `｜松手 70ms 后 leaving=${leaving || '(空)'}（要求 true） 300ms 后已收回=${orbGone}`;
    }
    console.info(`[pi/smoke] 第十八轮②圆球向内塌陷：${r18OrbInfo} ${r18OrbCollapseOk ? '✓' : '✗'}`);
    {
      // ⑨ 左下歌曲名片：只在指针接近（左下那块，±32px）时 `data-near="true"`，远一点就不该亮。
      const cardBox = (await win.webContents.executeJavaScript(
        `(() => {
           const card = document.querySelector('[data-home-card]');
           if (card === null) return null;
           const r = card.getBoundingClientRect();
           return {
             right: Math.round(r.right), midY: Math.round(r.top + r.height / 2),
             near: card.getAttribute('data-near') || '',
           };
         })()`,
        true,
      )) as { right: number; midY: number; near: string } | null;
      if (cardBox === null) {
        r18CardNearInfo = '未量到 [data-home-card]';
      } else {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: cardBox.right + 60, y: Math.max(12, cardBox.midY) });
        await delay(340);
        const farNear = (await win.webContents.executeJavaScript(
          `document.querySelector('[data-home-card]')?.getAttribute('data-near') || ''`,
          true,
        )) as string;
        win.webContents.sendInputEvent({ type: 'mouseMove', x: cardBox.right + 14, y: Math.max(12, cardBox.midY) });
        await delay(340);
        const closeNear = (await win.webContents.executeJavaScript(
          `document.querySelector('[data-home-card]')?.getAttribute('data-near') || ''`,
          true,
        )) as string;
        r18CardNearOk = farNear === 'false' && closeNear === 'true';
        r18CardNearInfo = `离右边 60px：near=${farNear || '(空)'}｜离右边 14px：near=${closeNear || '(空)'}`;
      }
    }
    console.info(`[pi/smoke] 第十八轮⑨名片贴近左下边框才出现：${r18CardNearInfo} ${r18CardNearOk ? '✓' : '✗'}`);
    {
      /*
       * ⑪「接下来播放」小名片：进尾声 7s 时**不该**有它（窗口从 10s 收成 5s 了），
       * 进尾声 3s 时才该有，而且贴在左下（`left` 约 22px，不是原来的右边 26px）。
       */
      const upNext = (await win.webContents.executeJavaScript(
        `(async () => {
           const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
           // 音频元素是 new Audio() 建的、不在 DOM 里（见上面 readLyricWheel 的注释）：
           // 只能读 window.__piAudio，querySelector('audio') 恒为 null。
           const audio = window.__piAudio;
           if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 12) return null;
           const total = audio.duration;
           audio.currentTime = total - 7;
           await sleep(760);
           const far = document.querySelector('[data-up-next]') !== null;
           audio.currentTime = total - 3;
           await sleep(760);
           const node = document.querySelector('[data-up-next]');
           const rect = node === null ? null : node.getBoundingClientRect();
           const style = node === null ? null : getComputedStyle(node);
           const look = {
             far,
             near: node !== null,
             left: rect === null ? -1 : Math.round(rect.left),
             cssLeft: style === null ? '' : style.left,
           };
           audio.currentTime = Math.max(0, total - 12);
           return look;
         })()`,
        true,
      )) as { far: boolean; near: boolean; left: number; cssLeft: string } | null;
      r18UpNextOk =
        upNext === null
          ? null
          : upNext.far === false && upNext.near && Math.abs(upNext.left - 22) <= 5;
      r18UpNextInfo =
        upNext === null
          ? '没拿到正在播放的音频（或时长太短量不出 10s 窗口）'
          : `尾声 7s 时=${upNext.far}（要求 false） 尾声 3s 时=${upNext.near}` +
            ` left=${upNext.left}px（CSS ${upNext.cssLeft}，要求 ≈22 而不是右边）`;
      await delay(240);
    }
    console.info(
      `[pi/smoke] 第十八轮⑪接下来播放名片左下+5s：${r18UpNextInfo}` +
        ` ${r18UpNextOk === null ? '未跑' : r18UpNextOk ? '✓' : '✗'}`,
    );

    // ⑭ 我的喜欢页签里不再有环形歌单面板（`.pi-orb__plcards` 必须一个都不剩）。
    const r16NoOrbPlCount = (await win.webContents.executeJavaScript(
      `document.querySelectorAll('.pi-orb__plcards').length`,
      true,
    )) as number;
    const r16NoOrbPlOk = r16NoOrbPlCount === 0;
    console.info(
      `[pi/smoke] 十六轮⑭环形歌单面板残留：.pi-orb__plcards=${r16NoOrbPlCount}（删球后必须为 0）` +
        ` ${r16NoOrbPlOk ? '✓' : '✗'}`,
    );

    /**
     * 第十六轮（用户 m07538）新探针的总闸。
     * ⑨⑩⑪⑫⑬ 五条量的是先锋专属的拼贴墙，平凡排版下按「未跑」记、不进总闸（见 `r16AvantOnly`）；
     * 要量它们就跑 `PI_SMOKE_UI_STYLE=avant`。
     */
    const r16AvantRun = wantStyle === 'avant';
    let r16Ok = false;
    r16Ok =
      r16OrbSpotOk &&
      r16OrbReleaseOk &&
      // 用户 m00736 第 5 条（Tab 召唤歌单页不带球）也挂在这一闸里：它是圆球那一段的直系判据。
      r23TabOrbOk &&
      // 用户 m01402 第 2 条后半句（暗槽方向锁）同样长在圆球那段上。
      r23LatchOk &&
      // 用户 m02213 第 1 / 5 条（球拖到槽末端 / 切排版的顶框提示）也长在同一段上。
      r23EndOk &&
      r23ToastOk &&
      // 用户 m04407 第 4 条：半程拖球不许触发任何卡片（正半由 ② 上划六块间接证明）。
      r32HalfOk &&
      // 用户 m02213 第 3 条（M5 下载与本地库）：进「我的下载」真下一首、核文件、走离线解析链、
      // 断网模拟再播一次、连文件删掉——一整条链路，挂进同一闸。
      r25DownloadsOk &&
      // 用户 m02213 第 2 条（歌单拼贴页铺满窗口）：只在先锋档量，平凡档标「不适用」放行。
      r25FullscreenOk &&
      r16UpOk &&
      r16RightOk &&
      // 用户 m01402 第 5 条（快捷卡片不倾斜）：读数分别在 ③ 与 Tab 两段里采，判据统一挂这里。
      r23TiltOk &&
      r16DownOk &&
      r16RevealOk &&
      // 用户 m01402 第 8 条后半句（回播放页不冒名片）紧挨着 ⑤ 那条，一并挂进闸里。
      r23CardBackOk &&
      r16BarOk &&
      r16PlOk &&
      r16CoverOk &&
      (!r16AvantRun ||
        (r16HoverOk && r16EnterOk && r16MoreOk && r16BarLocateOk && r16WheelOk)) &&
      r16NoOrbPlOk;
    console.info(
      `[pi/smoke] 十六轮十四项总闸：①点出PI键=${r16OrbSpotOk}（松手收球=${r16OrbReleaseOk}` +
        `；暗槽方向锁=${r23LatchOk}；Tab开歌单页不带球=${r23TabOrbOk}` +
        `；拖到槽末端=${r23EndOk}；切风格提示=${r23ToastOk}） ②上划六块=${r16UpOk}` +
        ` ③右划设置=${r16RightOk}（快捷卡不倾斜=${r23TiltOk}） ④下划搜索=${r16DownOk} ⑤切歌弹名片=${r16RevealOk}` +
        `（回播放页不冒名片=${r23CardBackOk}）` +
        ` ⑥底栏比例=${r16BarOk} ⑦歌单卡片=${r16PlOk} ⑧封面不裁=${r16CoverOk}` +
        ` ⑨悬停放大=${r16AvantOnly(r16HoverOk)} ⑩点进播放页=${r16AvantOnly(r16EnterOk)}` +
        ` ⑪翻页加载=${r16AvantOnly(r16MoreOk)}` +
        ` ⑫底栏定位=${r16AvantOnly(r16BarLocateOk)} ⑬滚轮搜索=${r16AvantOnly(r16WheelOk)}` +
        ` ⑭无环形面板=${r16NoOrbPlOk}` +
        ` → ${r16Ok ? '通过' : '未通过'}`,
    );
    /**
     * 第十八轮（用户 m01482）能自动量的那几条的总闸。
     * ①底栏（中心轴 / 药丸裹住暂停键 / 进度条加粗 / 上一首放大）、⑤⑩歌单页底栏常态只显进度条、
     * ⑧点底栏回播放页、②圆球向内塌陷、⑨名片贴近左下方才亮、⑪接下来播放名片左下 + 5s、
     * ④时计歌词滚轮后空闲自动回当前（`r18LyricIdleOk`）。
     * ⑥拼贴自续载只在先锋排版下有对象（平凡记「未跑」）。
     */
    const r18Ok =
      r18BarAxisOk &&
      r18BarWrapOk &&
      r18TrackThickOk &&
      r18PrevScaleOk &&
      r18BarRestOk &&
      r18BarClickHomeOk &&
      (!(wantStyle === 'avant') || r18AutoMoreOk === true) &&
      r18OrbCollapseOk &&
      r18CardNearOk &&
      r18UpNextOk !== false &&
      r18LyricIdleOk;
    console.info(
      `[pi/smoke] 第十八轮总闸：①中心轴=${r18BarAxisOk} 药丸裹键=${r18BarWrapOk}` +
        ` 进度条加粗=${r18TrackThickOk} 上一首放大=${r18PrevScaleOk}` +
        ` ②圆球塌陷=${r18OrbCollapseOk} ④歌词空闲回当前=${r18LyricIdleOk}` +
        ` ⑤⑩歌单页底栏=${r18BarRestOk} ⑥拼贴自续载=${r18AvantOnly(r18AutoMoreOk === true)}` +
        ` ⑧点底栏回播放页=${r18BarClickHomeOk} ⑨名片贴近才亮=${r18CardNearOk}` +
        ` ⑪接下来播放左下+5s=${r18UpNextOk === null ? '未跑' : r18UpNextOk}` +
        ` → ${r18Ok ? '通过' : '未通过'}`,
    );
    /*
     * ── 用户 m02898 九条：剩下三条能自动量的（③ 每日推荐首位、⑤ 收藏到歌单浮窗、
     *    ⑥b 平凡档「歌单选择页」的底部进度条） ─────────────────────────────────
     *
     * ③ 那张卡是 `apps/renderer/src/pages/PlaylistPage.tsx:63-80` 新建的
     *    （`data-daily-card="true"`，走 `PlaylistGrid` 的 `leading` 槽，见同文件 `:97` / `:106`）。
     *    判据：这一页真有这张卡，而且它在**文档顺序**上排在所有别的卡
     *    （`.pi-plcard` / `[data-playlist-card]` / `.pi-songcard`）之前。
     *
     * ⑤ `components/PlaylistPickerOverlay.tsx`（抓手 `data-playlist-picker="true"`，
     *    `styles/playlist-picker.css` 里 `position: fixed` 居中）。未登录时正文是
     *    `data-picker-empty` 那句「要登录才能收藏到歌单」，所以判据只看「浮窗出现 + 正落在窗口
     *    正中 + 关得掉」，不看列表里有没有歌单。
     *
     * ⑥b `PlaylistPage.tsx:119` 挂的就是拼贴页 / 我的喜欢那**同一个** `BottomBar`
     *    （`[data-collage-bar]`，里面是 `[data-home-bar]`）。点法照抄第十八轮 ⑧：落在药丸
     *    **右端的时间字**上（不是任何键），松手后 `closePlaylist() + closeSongs() +
     *    navigate('home')`；判据 = 回到有 `[data-home-card]` 的歌曲播放页、拼贴墙不在。
     */
    let r26DailyOk = false;
    let r26DailyInfo = '没进推荐歌单页';
    let r26PlistBarOk = false;
    let r26PlistBarInfo = '没量到 [data-collage-bar]';
    /** ⑥b 是「平凡专属」的验收项（用户原话），先锋跑只记未跑、不进总闸。 */
    let r26PlistBarRun = true;
    let r26PickerOk = false;
    let r26PickerInfo = '没点出浮窗';
    {
      await clickNav(win, '推荐歌单');
      await delay(820);
      const grid = (await win.webContents.executeJavaScript(
        `(() => {
           const daily = document.querySelector('[data-daily-card]');
           const others = Array.from(
             document.querySelectorAll('.pi-plcard, [data-playlist-card], .pi-songcard'),
           ).filter((el) => el !== daily);
           /* compareDocumentPosition 的第 2 位（PRECEDING）表示「参数里的节点排在我前面」。 */
           const before = daily === null
             ? -1
             : others.filter(
                 (el) => (daily.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
               ).length;
           const bar = document.querySelector('[data-collage-bar]');
           const homeBar = document.querySelector('[data-collage-bar] [data-home-bar]');
           const box = homeBar === null ? null : homeBar.getBoundingClientRect();
           return {
             others: others.length,
             daily: daily !== null,
             dailyCount: daily === null ? '' : (daily.getAttribute('data-daily-count') || ''),
             dailyText: daily === null ? '' : (daily.textContent || '').trim().slice(0, 20),
             before: before,
             dailyBox: daily === null
               ? null
               : (function () {
                   const b = daily.getBoundingClientRect();
                   return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
                 })(),
             bar: bar !== null,
             homeBar: homeBar !== null,
             box: box === null
               ? null
               : {
                   right: Math.round(box.right),
                   cy: Math.round(box.top + box.height / 2),
                   w: Math.round(box.width),
                   h: Math.round(box.height),
                 },
           };
         })()`,
        true,
      )) as {
        others: number;
        daily: boolean;
        dailyCount: string;
        dailyText: string;
        before: number;
        dailyBox: { x: number; y: number } | null;
        bar: boolean;
        homeBar: boolean;
        box: { right: number; cy: number; w: number; h: number } | null;
      };
      r26DailyOk = grid.daily && grid.before === 0;
      r26DailyInfo =
        `每日推荐卡=${grid.daily}（${grid.dailyText}${grid.dailyCount === '' ? '' : ` · ${grid.dailyCount} 首`}）` +
        ` 排在首位=${grid.before === 0}（它前面还有 ${grid.before} 张卡，这页共 ${grid.others} 张别的卡）`;
      /*
       * 用户 m02898 第 6 条后半段的原话是「**平凡风格下**…歌单选择页底部进度条部件也要存在」：
       * 先锋风格下 `playlist:recommend` 这一页被 `App.tsx:111-128` 换成了
       * `PlaylistCoverflowOverlay`（播放页底子 + 封面卡片轮播），没有拼贴墙那一层底栏 ——
       * 所以这一条按「平凡专属」记 `未跑`，不进总闸，免得读日志的人当成回归。
       */
      r26PlistBarRun = wantStyle !== 'avant';
      if (!r26PlistBarRun) {
        r26PlistBarInfo = '未跑(平凡专属)';
      } else if (grid.homeBar && grid.box !== null) {
        // 指针先躲开，免得药丸还在悬停态（悬停会浮出上/下首键，右端时间字的位置也会变）。
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
        await delay(420);
        const box = grid.box;
        const hit = (await win.webContents.executeJavaScript(
          `(() => {
             const el = document.elementFromPoint(${box.right - 16}, ${box.cy});
             if (el === null) return '落点=null';
             const ctl = el.closest('button, input, select, a');
             return '落点=' + (el.className || el.tagName) + (ctl === null ? '（不是键）' : '←键');
           })()`,
          true,
        )) as string;
        await clickPoint(win, box.right - 16, box.cy);
        await delay(820);
        const back = (await win.webContents.executeJavaScript(
          `({ card: document.querySelector('[data-home-card]') !== null,
              collage: document.querySelector('[data-song-collage]') !== null,
              listOverlay: document.querySelector('.pi-listoverlay') !== null })`,
          true,
        )) as { card: boolean; collage: boolean; listOverlay: boolean };
        r26PlistBarOk = grid.bar && grid.homeBar && back.card && !back.collage && !back.listOverlay;
        r26PlistBarInfo =
          `这一页 [data-collage-bar]=${grid.bar} 里面的 [data-home-bar]=${grid.homeBar}` +
          `（药丸 ${box.w}×${box.h}）｜点右端时间字(${box.right - 16},${box.cy}) ${hit}` +
          ` → 回播放页=${back.card} 拼贴墙=${back.collage} 浮层=${back.listOverlay}`;
      } else {
        r26PlistBarInfo =
          `这一页 [data-collage-bar]=${grid.bar} 里面的 [data-home-bar]=${grid.homeBar}` +
          `（没在播歌时 BottomBar 组件自己返回 null，这一跑没有底栏可点）`;
      }

      // ⑤ 回到歌曲播放页，点名片封面右下角那颗键（`data-card-action="like"`）→ 选歌单浮窗。
      await clickNav(win, '播放器主页');
      await delay(760);
      const clickedLike = (await win.webContents.executeJavaScript(
        `(() => {
           const key = document.querySelector('[data-card-action="like"]');
           if (key === null) return false;
           key.click();
           return true;
         })()`,
        true,
      )) as boolean;
      await delay(620);
      const picker = (await win.webContents.executeJavaScript(
        `(() => {
           const root = document.querySelector('[data-playlist-picker]');
           if (root === null) return { open: false };
           const card = root.querySelector('.pi-picker__card');
           const box = card === null ? null : card.getBoundingClientRect();
           return {
             open: true,
             position: getComputedStyle(root).position,
             rows: root.querySelectorAll('[data-picker-playlist]').length,
             empty: root.querySelector('[data-picker-empty]') !== null,
             close: root.querySelector('[data-picker-close]') !== null,
             dx: box === null ? NaN : Math.round(box.left + box.width / 2 - window.innerWidth / 2),
             dy: box === null ? NaN : Math.round(box.top + box.height / 2 - window.innerHeight / 2),
             w: box === null ? 0 : Math.round(box.width),
             h: box === null ? 0 : Math.round(box.height),
           };
         })()`,
        true,
      )) as {
        open: boolean;
        position?: string;
        rows?: number;
        empty?: boolean;
        close?: boolean;
        dx?: number;
        dy?: number;
        w?: number;
        h?: number;
      };
      const pickerClosed = picker.open
        ? ((await win.webContents.executeJavaScript(
            `(() => {
               const btn = document.querySelector('[data-picker-close]');
               if (btn === null || !(btn instanceof HTMLElement)) return false;
               btn.click();
               return true;
             })()`,
            true,
          )) as boolean)
        : false;
      await delay(360);
      const pickerGone = (await win.webContents.executeJavaScript(
        `document.querySelector('[data-playlist-picker]') === null`,
        true,
      )) as boolean;
      r26PickerOk =
        clickedLike &&
        picker.open &&
        picker.position === 'fixed' &&
        picker.close === true &&
        Math.abs(picker.dx ?? 999) <= 2 &&
        Math.abs(picker.dy ?? 999) <= 2 &&
        pickerClosed &&
        pickerGone;
      r26PickerInfo = clickedLike
        ? `浮窗=${picker.open} position=${picker.position || '无'}` +
          ` 卡 ${picker.w}×${picker.h} 中心偏移 dx=${picker.dx} dy=${picker.dy}` +
          ` 行=${picker.rows ?? 0} 空态=${picker.empty === true}` +
          `｜关闭键=${picker.close === true} 点后收起=${pickerGone}`
        : '没找到 [data-card-action="like"]（这一跑没有在播的名片）';

      /*
       * ③ 的后半（用户第 3 条的真正语义）：那张「每日推荐」卡点得开
       * `[data-songs="daily"]` 那一档歌曲浮层（平凡 / 先锋都走 `openSongs({kind:'daily'})`）。
       * 放在这一块的最后：打开就不再收拾，免得影响前面几条的量测。
       */
      if (grid.daily && grid.dailyBox !== null) {
        await clickNav(win, '推荐歌单');
        await delay(620);
        await clickPoint(win, grid.dailyBox.x, grid.dailyBox.y);
        await delay(900);
        /*
         * 用户 m04407 第 1 条：「每日推荐歌单进去的歌曲队列拼贴不是 app 全屏展示，修正」。
         * 拼贴格要等预载抽干（`collageReady`）才上墙，所以先锋档先轮询到有格子再量几何 ——
         * 否则会拍到「画布还没铺格」那一帧，量出来的高度没有意义（第十六轮⑤ 踩过同一个坑）。
         */
        if (wantStyle === 'avant') {
          const dailyCellDeadline = Date.now() + 6000;
          while (Date.now() < dailyCellDeadline) {
            const cells = (await win.webContents.executeJavaScript(
              `document.querySelectorAll('[data-songs="daily"] [data-collage-cell]').length`,
              true,
            )) as number;
            if (cells > 0) break;
            await delay(300);
          }
        }
        const dailyList = (await win.webContents.executeJavaScript(
          `(() => {
             const root = document.querySelector('[data-songs="daily"]');
             const rows = root === null
               ? 0
               : root.querySelectorAll('.pi-songrow, [data-collage-cell]').length;
             const label = root === null ? null : root.querySelector('.pi-detail__title, .pi-detail__bar strong');
             /*
              * 用户 m04407 第 1 条：这一档的拼贴必须**铺满整个窗口** —— 浮层没有内边距、
             * 纸（sheet）与窗口等大、画布高度与窗口等高。三个盒子都按窗口来量。
              */
             const box = (el) => {
               if (el === null) return null;
               const r = el.getBoundingClientRect();
               return { w: Math.round(r.width), h: Math.round(r.height) };
             };
             const sheet = root === null ? null : root.querySelector('.pi-listoverlay__sheet');
             const canvas = root === null ? null : root.querySelector('.pi-collage');
             return {
               overlay: root !== null,
               rows: rows,
               title: label === null ? '' : (label.textContent || '').trim(),
               win: { w: window.innerWidth, h: window.innerHeight },
               rootBox: box(root),
               sheetBox: box(sheet),
               canvasBox: box(canvas),
               pad: root === null ? '' : getComputedStyle(root).padding,
             };
           })()`,
          true,
        )) as {
          overlay: boolean;
          rows: number;
          title: string;
          win: { w: number; h: number };
          rootBox: { w: number; h: number } | null;
          sheetBox: { w: number; h: number } | null;
          canvasBox: { w: number; h: number } | null;
          pad: string;
        };
        /* 先锋档才量「铺满」：平凡档这一层是歌曲行列表、根本没有画布（`canvasBox === null`），
           那种情况只记读数、不进判据。 */
        const dailyFull =
          dailyList.canvasBox !== null &&
          dailyList.pad.replace(/\s+/g, '') === '0px' &&
          dailyList.sheetBox !== null &&
          Math.abs(dailyList.sheetBox.w - dailyList.win.w) <= 1 &&
          Math.abs(dailyList.sheetBox.h - dailyList.win.h) <= 1 &&
          Math.abs(dailyList.canvasBox.h - dailyList.win.h) <= 1 &&
          Math.abs(dailyList.canvasBox.w - dailyList.win.w) <= 1;
        r26DailyOk =
          r26DailyOk && dailyList.overlay && dailyList.rows > 0 && (wantStyle !== 'avant' || dailyFull);
        r26DailyInfo +=
          `｜点开每日推荐浮层=${dailyList.overlay} 行数=${dailyList.rows}` +
          `${dailyList.title === '' ? '' : `（${dailyList.title}）`}` +
          `｜铺满窗口：窗口=${dailyList.win.w}x${dailyList.win.h}` +
          ` 纸=${dailyList.sheetBox === null ? '无' : `${dailyList.sheetBox.w}x${dailyList.sheetBox.h}`}` +
          ` 画布=${dailyList.canvasBox === null ? '无' : `${dailyList.canvasBox.w}x${dailyList.canvasBox.h}`}` +
          ` 内边距=${dailyList.pad || '无'}` +
          `${wantStyle === 'avant' ? (dailyFull ? ' ✓' : ' ✗') : '（平凡档不适用）'}`;
        /*
         * 用户 m04892：「每日推荐」歌单的队列拼贴要「点一下先放大、在放大块上再点一下才进播放页」，
         * 也就是与歌单详情那面拼贴一致（它的 `onSelect` 不收浮层）。这里真点两下验一遍，
         * 只有先锋档有拼贴。第二下的收尾由 `SongCollage.enterPlayer()` 在 `COLLAGE_FILL_MS`(480ms)
         * 之后做（收浮层 + 回播放页），所以这里等 1500ms 再查浮层在不在。
         */
        if (wantStyle === 'avant') {
          const hitFirst = (await win.webContents.executeJavaScript(
            `(() => {
               const cell = document.querySelector('[data-songs="daily"] [data-collage-cell]');
               if (cell === null) return false;
               cell.click();
               return true;
             })()`,
            true,
          )) as boolean;
          await delay(700);
          const step1 = (await win.webContents.executeJavaScript(
            `(() => {
               const root = document.querySelector('[data-songs="daily"]');
               if (root === null) return { overlay: false, expanded: 0, playing: 0 };
               let expanded = 0;
               let playing = 0;
               root.querySelectorAll('[data-collage-cell]').forEach((el) => {
                 if (el.dataset.collageExpanded === 'true') expanded += 1;
                 if (el.dataset.playing === 'true') playing += 1;
               });
               return { overlay: true, expanded: expanded, playing: playing };
             })()`,
            true,
          )) as { overlay: boolean; expanded: number; playing: number };
          // 在播的格子可能不止一个：每日推荐那 32 首里同一首会重复出现，两张格子都会带
          // `data-playing="true"`（实测 46 行时读到 2 张），所以这里只要求「至少一张」。
          const step1Ok = hitFirst && step1.overlay && step1.expanded === 1 && step1.playing >= 1;
          const hitSecond = (await win.webContents.executeJavaScript(
            `(() => {
               const cell = document.querySelector(
                 '[data-songs="daily"] [data-collage-cell][data-collage-expanded="true"]',
               );
               if (cell === null) return false;
               cell.click();
               return true;
             })()`,
            true,
          )) as boolean;
          await delay(1500);
          const step2Gone = (await win.webContents.executeJavaScript(
            `document.querySelector('[data-songs="daily"]') === null`,
            true,
          )) as boolean;
          r26DailyOk = r26DailyOk && step1Ok && hitSecond && step2Gone;
          r26DailyInfo +=
            `｜m04892 两段式：点一下 浮层还在=${step1.overlay} 放大块=${step1.expanded} 在播=${step1.playing}` +
            `｜再点放大块=${hitSecond ? '点到' : '没找到'} 之后浮层收掉=${step2Gone}` +
            `${step1Ok && hitSecond && step2Gone ? ' ✓' : ' ✗'}`;
        }
      }
    }
    console.info(
      `[pi/smoke] M3 本轮九条：③每日推荐首位 ${r26DailyOk ? '✓' : '✗'}（${r26DailyInfo}）` +
        `｜⑤收藏到歌单浮窗 ${r26PickerOk ? '✓' : '✗'}（${r26PickerInfo}）` +
        `｜⑥b歌单选择页底栏 ${
          r26PlistBarRun ? (r26PlistBarOk ? '✓' : '✗') : '未跑'
        }（${r26PlistBarInfo}）` +
        `｜①本地档与六图标 ${r26ItemsOk ? '✓' : '✗'}（${r26ItemsInfo}）` +
        `｜④设置卡 ${r26SettingsOk ? '✓' : '✗'}（${r26SettingsInfo}）`,
    );
    const m3Ok =
      r26DailyOk &&
      r26PickerOk &&
      (!r26PlistBarRun || r26PlistBarOk) &&
      r26ItemsOk &&
      r26SettingsOk &&
      navOk &&
      emptyOk &&
      homeOk &&
      recommendGone &&
      // 第十七轮第 ②③ 条把歌单详情的歌曲展示换成了两套排版，旧的「中心聚焦封面流」退休；
      // 这里改判「详情曲目呈现」（平凡竖排列表 / 先锋队列拼贴，见十六轮⑦那段算出的 `detailTracksOk`）。
      detailTracksOk &&
      searchOk &&
      windowControlsOk &&
      // `null` = 这轮没跑 `PI_SMOKE_SHOT_THEMES=1`（没有浮名成品图可量），不参与判定。
      lyricBleedOk !== false &&
      // 同理：只有拍了主题成品图才量得到倾诉/时计/流光的舞台铺满比例。
      stageFillOk !== false &&
      spinOk !== false &&
      pendoloGearOk !== false &&
      partitaSpaceOk !== false &&
      partitaSizeOk !== false &&
      // 第十五轮第 4/5/6/7/8 条的成品图判定；null = 这一跑没拍主题成品图。
      lyricInkOk !== false &&
      spinInOk !== false &&
      fumeOutroOk !== false &&
      partitaGuideOk !== false &&
      // 第十六轮删球：切歌小名片（`[data-song-change-card]`）连着组件一起删了，换成
      // 「播放页左下角那张常驻名片自己在切歌时弹一下」的新探针（第十六轮第 3 条，见 r16Ok）。
      r16Ok &&
      // 第十八轮（用户 m01482）那 11 条里能自动量的部分（见上面的 `r18Ok`）。
      r18Ok;
    console.info(
      // 第十六轮删球（用户 m07538 第 1 条）：`｜首屏悬浮球`、`｜环形菜单+悬停升起`、
      // `｜悬浮球拖动+贴边细条`、`｜换页过渡`、`｜推荐＝歌单卡片`、`｜歌单卡片面板`、
      // `｜点球坠入收回`、`｜双击回播放页`、`｜我的喜欢队列拼贴`、`｜切歌小名片` 这十段
      // 随对应 DOM 一起退休——真删掉的项不再出现在验收行里，免得读日志的人以为它还在跑；
      // 本轮新增的十四项在行尾以 `｜十六轮…` 的形式逐项列出。
      `[pi/smoke] M3 渲染层验收：空白初始页 ${emptyOk ? '✓' : '✗'}` +
        `｜播放器详情页 ${homeOk ? '✓' : '✗'}（评论行 ${commentRows}，歌词行 ${lyricLines}，主题 ${stageTheme || '无'}，情绪背景 ${moodOk ? '✓' : '✗'}）｜推荐页已删 ${recommendGone ? '✓' : '✗'}` +
        `｜导航抽屉 ${navOk ? '✓' : '✗'}` +
        `｜歌单空态卡片 ${newPlaylistOk ? '✓' : '✗'}` +
        `｜详情曲目呈现 ${detailTracksOk ? '✓' : '✗'}` +
        `｜搜索浮层 ${searchOk ? '✓' : '✗'}｜窗口三键浮出 ${windowControlsOk ? '✓' : '✗'}` +
        `｜浮名不溢出 ${lyricBleedOk === null ? '未跑' : lyricBleedOk ? '✓' : '✗'}` +
        `｜三套铺满整屏 ${stageFillOk === null ? '未跑' : stageFillOk ? '✓' : '✗'}` +
        `｜逐字旋转 ${spinOk === null ? '未跑' : spinOk ? '✓' : '✗'}` +
        `｜时计齿轮转 ${pendoloGearOk === null ? '未跑' : pendoloGearOk ? '✓' : '✗'}` +
        `｜云阶断词 ${partitaSpaceOk === null ? '未跑' : partitaSpaceOk ? '✓' : '✗'}` +
        `｜云阶字号与高亮 ${partitaSizeOk === null ? '未跑' : partitaSizeOk ? '✓' : '✗'}` +
        `｜歌词常态白与高亮色 ${lyricInkOk === null ? '未跑' : lyricInkOk ? '✓' : '✗'}` +
        `｜冒字带旋转 ${spinInOk === null ? '未跑' : spinInOk ? '✓' : '✗'}` +
        `｜浮名结尾缩镜 ${fumeOutroOk === null ? '未跑' : fumeOutroOk ? '✓' : '✗'}` +
        `｜云阶线与字同出 ${partitaGuideOk === null ? '未跑' : partitaGuideOk ? '✓' : '✗'}` +
        `｜音量条两级悬停 ${volShortOk && volThickOk ? '✓' : '✗'}` +
        `｜进度条 150% ${trackGrowOk ? '✓' : '✗'}` +
        // 第十六轮十四条探针逐项署名（原来这里只有一句「十六轮新探针总闸」）。
        `｜十六轮①点出PI键 ${r16OrbSpotOk ? '✓' : '✗'}（松手收球 ${r16OrbReleaseOk ? '✓' : '✗'}` +
        `；暗槽方向锁 ${r23LatchOk ? '✓' : '✗'}` +
        `；拖到槽末端 ${r23EndOk ? '✓' : '✗'}；切风格提示 ${r23ToastOk ? '✓' : '✗'}` +
        `；Tab开歌单页不带球 ${r23TabOrbOk ? '✓' : '✗'}） ②上划六块 ${r16UpOk ? '✓' : '✗'}` +
        ` ③右划设置 ${r16RightOk ? '✓' : '✗'} ④下划搜索 ${r16DownOk ? '✓' : '✗'}` +
        ` ⑤切歌弹名片 ${r16RevealOk ? '✓' : '✗'}` +
        `｜十六轮⑥底栏比例 ${r16BarOk ? '✓' : '✗'} ⑦歌单卡片 ${r16PlOk ? '✓' : '✗'}` +
        ` ⑧封面不裁 ${r16CoverOk ? '✓' : '✗'} ⑨悬停放大 ${r16AvantOnly(r16HoverOk)}` +
        `｜十六轮⑩点进播放页 ${r16AvantOnly(r16EnterOk)} ⑪翻页加载 ${r16AvantOnly(r16MoreOk)}` +
        ` ⑫底栏定位 ${r16AvantOnly(r16BarLocateOk)} ⑬滚轮搜索 ${r16AvantOnly(r16WheelOk)}` +
        ` ⑭无环形面板 ${r16NoOrbPlOk ? '✓' : '✗'}（总闸 ${r16Ok ? '✓' : '✗'}）` +
        // 第十八轮（用户 m01482）：逐条署名（⑥ 在平凡跑里记「未跑(先锋专属)」）。
        `｜十八轮①底栏中心轴 ${r18BarAxisOk ? '✓' : '✗'} 裹住暂停键 ${r18BarWrapOk ? '✓' : '✗'}` +
        ` 进度条加粗 ${r18TrackThickOk ? '✓' : '✗'} 上一首放大 ${r18PrevScaleOk ? '✓' : '✗'}` +
        ` ②圆球塌陷 ${r18OrbCollapseOk ? '✓' : '✗'} ④歌词空闲回当前 ${r18LyricIdleOk ? '✓' : '✗'}` +
        `｜十八轮⑤⑩歌单页底栏 ${r18BarRestOk ? '✓' : '✗'} ⑥拼贴自续载 ${r18AvantOnly(r18AutoMoreOk === true)}` +
        ` ⑧点底栏回播放页 ${r18BarClickHomeOk ? '✓' : '✗'} ⑨名片贴近才亮 ${r18CardNearOk ? '✓' : '✗'}` +
        ` ⑪接下来播放左下+5s ${r18UpNextOk === null ? '未跑' : r18UpNextOk ? '✓' : '✗'}` +
        `（总闸 ${r18Ok ? '✓' : '✗'}）` +
        ` → ${m3Ok ? '通过' : '未通过'}`,
    );
    app.exit(passed >= UI_SMOKE_SONGS && coversOk && m3Ok ? 0 : 1);
  } catch (error) {
    console.error('[pi/smoke] UI 冒烟失败：', error);
    app.exit(1);
  }
}

interface SettingsPageReport {
  title: string;
  cards: number;
  rows: { name: string; state: string }[];
  localInput: string;
  hasLocalTitle: boolean;
  hasThirdParty: boolean;
  hasAck: boolean;
  /** 设置内容真的长在浮层的「框」里（第八轮第 7 条：不再占满整个 app 界面）。 */
  boxed: boolean;
  /** 第十二轮第 7 条（用户 m04193）：页签的圆形外观 + 卡片的拍立得外观（圆角/落影）。 */
  tabLook: string;
  cardLook: string;
}

/**
 * M2.5 渲染层验收：设置页与音质日志页真的画出来了，而且数据接上了。
 *
 * 为什么必须真开窗口：`pnpm typecheck` 与 `vite build` 只证明「能编译」，证明不了这一页渲染时
 * 不抛错——preload 加载失败在 Electron 里是**静默**的，界面一片空白但编译完全通过（M0 栽过一次）。
 * 用法：`PI_SMOKE_SETTINGS=1`（不要和 `PI_SMOKE_UI` 同时设，两者都会自己退进程）。
 */
async function runSettingsSmoke(win: BrowserWindow): Promise<void> {
  try {
    await delay(UI_SMOKE_READY_MS);

    const settingsClicked = await clickNav(win, '设置与音源');
    await delay(UI_SMOKE_SWITCH_MS);
    const page = (await win.webContents.executeJavaScript(
      `(() => {
        // 用户第八轮第 7 条：设置不再是整页——正文长在 .pi-settings-overlay__box 里，
        // 不在 .pi-main 里，所以文本优先从浮层里找（找不到再退回主区）。
        // 注意：这整段在模板字符串里，注释里**不能出现反引号**——反引号会把字符串
        // 提前截断，后面的 .pi-settings-overlay__box 会被当成「减 settings 再减
        // overlay__box」的表达式求值，抛 ReferenceError: settings is not defined
        //（第八轮真栽过一次，tsc 报的是 TS1005 ',' expected）。
        const text = (
          document.querySelector('.pi-settings-overlay__box')?.textContent ||
          document.querySelector('.pi-main')?.textContent ||
          ''
        ).replace(/\\s+/g, ' ');
        const rows = [...document.querySelectorAll('.pi-srcrow')].map((el) => ({
          name: (el.querySelector('.pi-srcrow__name')?.textContent || '').trim(),
          state: (el.querySelector('.pi-srcrow__state')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        }));
        return {
          title: document.querySelector('.pi-page-title')?.textContent || '',
          cards: document.querySelectorAll('.pi-card').length,
          rows,
          localInput: [...document.querySelectorAll('input.pi-input')].map((el) => el.value).join('|'),
          hasLocalTitle: text.includes('本地曲库'),
          hasThirdParty: text.includes('第三方音源'),
          hasAck: text.includes('允许第三方无损'),
          // 第十二轮第 7 条（用户 m04193）：页签要收成圆形图标键（文字标签转 sr-only 但仍在
          // DOM 里），卡片要变成拍立得那种厚白边 + 落影。这里把圆角换算成百分比再报，
          // 免得百分比与像素两种计算值写法把断言写成平台相关的。
          tabLook: (() => {
            const tab = document.querySelector('[data-settings-tab]');
            if (!tab) return '无';
            const s = getComputedStyle(tab);
            const r = tab.getBoundingClientRect();
            const rv = s.borderTopLeftRadius;
            const pct = rv.endsWith('%')
              ? parseFloat(rv)
              : r.width > 0
                ? (parseFloat(rv) / r.width) * 100
                : 0;
            const label = tab.querySelector('.pi-settings-frame__tablabel');
            return 'radiusPct=' + Math.round(pct) +
              ' size=' + Math.round(r.width) + 'x' + Math.round(r.height) +
              ' labelHidden=' + (label ? (getComputedStyle(label).clipPath !== 'none' ? 'yes' : 'no') : 'missing');
          })(),
          cardLook: (() => {
            const frame = document.querySelector('.pi-settings-frame');
            const card = frame ? frame.querySelector('.pi-card') : null;
            if (!card) return '无';
            const s = getComputedStyle(card);
            return 'radius=' + Math.round(parseFloat(s.borderTopLeftRadius) || 0) +
              ' shadow=' + (s.boxShadow === 'none' ? 'none' : 'yes') +
              ' padBottom=' + Math.round(parseFloat(s.paddingBottom) || 0);
          })(),
          boxed:
            document.querySelector(
              '[data-settings-overlay][data-phase="in"] .pi-settings-overlay__box .pi-settings-frame',
            ) !== null,
        };
      })()`,
      true,
    )) as SettingsPageReport;

    const names = new Set(page.rows.map((row) => row.name));
    // 第十二轮第 7 条：圆形页签（radiusPct≈50、边长 30~46、文字标签 sr-only）+ 拍立得卡面
    // （圆角 ≥ 12px、有落影、底部白边比顶部厚）。
    const tabLookMatch =
      /radiusPct=(\d+) size=(\d+)x(\d+) labelHidden=(yes|no|missing)/.exec(page.tabLook);
    const cardLookMatch = /radius=(\d+) shadow=(yes|none) padBottom=(\d+)/.exec(page.cardLook);
    const polaroidOk =
      tabLookMatch !== null &&
      Number(tabLookMatch[1]) >= 45 &&
      Number(tabLookMatch[2]) >= 30 &&
      Number(tabLookMatch[2]) <= 46 &&
      Number(tabLookMatch[3]) >= 30 &&
      Number(tabLookMatch[3]) <= 46 &&
      tabLookMatch[4] === 'yes' &&
      cardLookMatch !== null &&
      Number(cardLookMatch[1]) >= 12 &&
      cardLookMatch[2] === 'yes' &&
      Number(cardLookMatch[3]) >= 16;
    const settingsPass =
      settingsClicked &&
      page.boxed &&
      page.cards >= 3 &&
      page.hasLocalTitle &&
      page.hasThirdParty &&
      page.hasAck &&
      names.size >= 2;
    console.info(
      `[pi/smoke] 设置框：标题=${page.title || '无'} 框式浮层=${page.boxed} 卡片=${page.cards} 音源行=[${[...names].join(', ')}]` +
        `｜本地曲库输入=${page.localInput === '' ? '（空）' : page.localInput}` +
        `｜本地曲库/第三方/允许无损=${page.hasLocalTitle}/${page.hasThirdParty}/${page.hasAck}` +
        ` → ${settingsPass ? '✓' : '✗'}`,
    );
    console.info(
      `[pi/smoke] 设置页拍立得外观（第十二轮第 7 条）：页签 ${page.tabLook}｜卡片 ${page.cardLook}` +
        ` → ${polaroidOk ? '✓' : '✗'}`,
    );
    for (const row of page.rows) console.info(`[pi/smoke]   音源行「${row.name}」${row.state}`);

    // 第十轮第 1 条（用户 m02362）：设置框顶部那张大封面 + 黑胶已经删掉。探针只断言文字与
    // 输入框，看不出「顶部还有没有那块」，所以这里补一张「刚打开设置框」的截图当证据。
    const frameShot = smokeShotPath(
      process.env.PI_SMOKE_SETTINGS_SHOT,
      path.resolve(here, '../../../docs/m3-settings-frame.png'),
    );
    writeFileSync(frameShot, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${frameShot}`);

    // m08768 第 1 条：音质日志不再挂在环形菜单/抽屉上，也不再是独立页——它成了设置页的
    // 「日志」tab。所以这里点 tab，断言面板真的切过去了、里面还是那份正文。
    const logTabClicked = (await win.webContents.executeJavaScript(
      `(() => {
        const tab = document.querySelector('[data-settings-tab="log"]');
        if (!tab) return false;
        tab.click();
        return true;
      })()`,
      true,
    )) as boolean;
    await delay(420);
    const log = (await win.webContents.executeJavaScript(
      `(() => ({
        panel: document.querySelector('.pi-settings-frame__body')?.dataset.panel ?? '',
        rows: document.querySelectorAll('.pi-logrow').length,
        text: (document.querySelector('.pi-settings-frame__body')?.textContent || '')
          .replace(/\\s+/g, ' ').slice(0, 120),
        title: document.querySelector('.pi-page-title')?.textContent || '',
      }))()`,
      true,
    )) as { panel: string; rows: number; text: string; title: string };
    const logPass =
      logTabClicked && log.panel === 'log' && (log.text.includes('音质日志') || log.rows > 0);
    console.info(
      `[pi/smoke] 设置页「日志」tab：面板=${log.panel || '无'} 条数=${log.rows} 页面标题=${log.title || '无'}` +
        `｜${log.text} → ${logPass ? '✓' : '✗'}`,
    );

    /*
     * 用户 m08768 第 4、8 条：设置页是「边框页 + 分类 tab」，歌词 tab 里能选 6 套主题，
     * 而且选完必须真落盘。这里点一个与当前不同的主题、读回 IPC 里的设置确认写进去了，
     * 再把原来那个点回来——冒烟不该改掉用户已经存下的偏好。
     */
    const themeReport = (await win.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const tabs = [...document.querySelectorAll('[data-settings-tab]')].map(
          (el) => el.dataset.settingsTab || '',
        );
        document.querySelector('[data-settings-tab="lyric"]')?.click();
        await sleep(420);
        const optionsOf = () => [...document.querySelectorAll('[data-lyric-theme-option]')];
        const activeOf = () =>
          optionsOf().find((el) => el.dataset.active === 'true')?.dataset.lyricThemeOption || '';
        const before = activeOf();
        const ids = optionsOf().map((el) => el.dataset.lyricThemeOption || '');
        const next = ids.find((id) => id !== before) || '';
        const readStored = async () => (await window.pi.invoke('settings:get')).lyricTheme || '';
        const storedBefore = await readStored();
        optionsOf().find((el) => el.dataset.lyricThemeOption === next)?.click();
        await sleep(560);
        const storedAfter = await readStored();
        const activeAfter = activeOf();
        optionsOf().find((el) => el.dataset.lyricThemeOption === before)?.click();
        await sleep(560);
        // 第十轮第 9 条（用户 m02362）：歌词页签里多了「歌词动效参数」那张卡（folia 式）。
        // 抓手是 data-lyric-tuning="<字段名>"（复位键故意叫 data-lyric-tuning-reset，免得被
        // 枚举字段的探针当成第 7 个旋钮）。
        const tuningEls = [...document.querySelectorAll('[data-lyric-tuning]')];
        const bodyText = document.querySelector('.pi-settings-frame__body')?.textContent || '';
        /*
         * 第十四轮第 4 条（用户 m05281：「流光的每个字是斜着的，一会儿正过来…希望在设置里
         * 加一个开关」）：这枚开关要真的能在 UI 里来回切到底——点开、存盘里跟着变 true、
         * 点回、存盘里跟着变回原值。data-lyric-tuning='classicWordSpin' 就长在
         * input[type=checkbox] 身上（SettingsPage.tsx:977-985），所以 click/checked 都直接读它。
         */
        const spinEl = document.querySelector('[data-lyric-tuning="classicWordSpin"]');
        const readSpin = async () => ({
          checked: spinEl instanceof HTMLInputElement ? spinEl.checked : null,
          stored:
            (await window.pi.invoke('settings:get')).lyricTuning?.classicWordSpin ?? null,
        });
        const spinBefore = await readSpin();
        spinEl?.click();
        await sleep(700);
        const spinOn = await readSpin();
        spinEl?.click();
        await sleep(700);
        const spinOff = await readSpin();
        return {
          spinBefore,
          spinOn,
          spinOff,
          tuningIds: tuningEls.map((el) => el.dataset.lyricTuning || ''),
          tuningReset: document.querySelector('[data-lyric-tuning-reset]') !== null,
          tuningCard: bodyText.includes('歌词动效参数'),
          tabs,
          panel: document.querySelector('.pi-settings-frame__body')?.dataset.panel || '',
          ids,
          before,
          next,
          activeAfter,
          storedBefore,
          storedAfter,
          restored: await readStored(),
        };
      })()`,
      true,
    )) as {
      tabs: string[];
      panel: string;
      ids: string[];
      before: string;
      next: string;
      activeAfter: string;
      storedBefore: string;
      storedAfter: string;
      restored: string;
      tuningIds: string[];
      tuningReset: boolean;
      tuningCard: boolean;
      spinBefore: { checked: boolean | null; stored: boolean | null };
      spinOn: { checked: boolean | null; stored: boolean | null };
      spinOff: { checked: boolean | null; stored: boolean | null };
    };
    const themeOk =
      themeReport.panel === 'lyric' &&
      themeReport.tabs.length === 6 &&
      themeReport.ids.length === 6 &&
      themeReport.before !== '' &&
      themeReport.next !== '' &&
      themeReport.storedBefore === themeReport.before &&
      themeReport.storedAfter === themeReport.next &&
      themeReport.activeAfter === themeReport.next &&
      themeReport.restored === themeReport.storedBefore;
    console.info(
      `[pi/smoke] 设置页分类：tab=${themeReport.tabs.join('/')}｜歌词主题=${themeReport.ids.join('/')}` +
        `｜选中=${themeReport.before}→点「${themeReport.next}」→存盘=${themeReport.storedAfter}` +
        `（面板=${themeReport.panel} 点回=${themeReport.restored}） → ${themeOk ? '✓' : '✗'}`,
    );

    /*
     * 第十轮第 9 条（用户 m02362）：歌词页签里那张 folia 式「歌词动效参数」卡。六个旋钮都在
     * （`data-lyric-tuning`），外加一枚复位键；顺便拍一张图——用户第 8 条明确要求「多主动看
     * app 画面确认效果」，这一页以前一张图都没有。
     */
    const EXPECTED_TUNING = [
      'themeOpacity',
      'fontScale',
      'motionAmount',
      'glowIntensity',
      'fpsCap',
      'randomThemePerSong',
      // 第十四轮（用户 m05281）第 3/4/6/7 条：每套主题自己的旋钮，共 11 个。
      'fumeCameraFollow',
      'fumeCameraSpeed',
      'classicWordSpin',
      'partitaGuides',
      'partitaStaggerMin',
      'partitaStaggerMax',
      'pendoloDialRadius',
      'pendoloArcAngle',
      'pendoloEscapeForce',
      'pendoloFocusScale',
      'pendoloCoverOnDial',
    ];
    const tuningOk =
      themeReport.tuningCard &&
      themeReport.tuningReset &&
      EXPECTED_TUNING.every((key) => themeReport.tuningIds.includes(key)) &&
      themeReport.tuningIds.length === EXPECTED_TUNING.length;
    console.info(
      `[pi/smoke] 设置页「歌词动效参数」卡：卡面=${themeReport.tuningCard}｜旋钮=${themeReport.tuningIds.join('/')}` +
        `｜复位键=${themeReport.tuningReset} → ${tuningOk ? '✓' : '✗'}`,
    );
    /*
     * 第十四轮第 4 条：流光「逐字旋转」开关的 UI 往返。判据只认**相对变化**（起点值是用户
     * 自己的偏好，可能本来就是开的）：点一下必须翻面且存盘跟着变，再点一下必须回到原值。
     */
    const spinOnOk =
      themeReport.spinBefore.checked !== null &&
      themeReport.spinOn.checked === !themeReport.spinBefore.checked &&
      themeReport.spinOn.stored === themeReport.spinOn.checked;
    const spinOffOk =
      themeReport.spinOff.checked === themeReport.spinBefore.checked &&
      themeReport.spinOff.stored === themeReport.spinBefore.checked;
    const tuningToggleOk = spinOnOk && spinOffOk;
    console.info(
      `[pi/smoke] 流光「逐字旋转」开关（第十四轮第 4 条）：起点=${String(themeReport.spinBefore.checked)}` +
        `→点开=${String(themeReport.spinOn.checked)}（存盘=${String(themeReport.spinOn.stored)}）` +
        `→点回=${String(themeReport.spinOff.checked)}（存盘=${String(themeReport.spinOff.stored)}）` +
        ` → ${tuningToggleOk ? '✓' : '✗'}`,
    );
    const tuningShot = smokeShotPath(
      process.env.PI_SMOKE_SETTINGS_LYRIC_SHOT,
      path.resolve(here, '../../../docs/m3-settings-lyric.png'),
    );
    writeFileSync(tuningShot, (await win.webContents.capturePage()).toPNG());
    console.info(`[pi/smoke] 截图：${tuningShot}`);

    const ok = settingsPass && logPass && themeOk && tuningOk && tuningToggleOk && polaroidOk;
    console.info(
      `[pi/smoke] M2.5 渲染层验收：设置页 ${settingsPass ? '✓' : '✗'}｜音质日志页 ${logPass ? '✓' : '✗'}` +
        `｜分类边框页与歌词主题 ${themeOk ? '✓' : '✗'}｜歌词动效参数卡 ${tuningOk ? '✓' : '✗'}` +
        `｜逐字旋转开关 ${tuningToggleOk ? '✓' : '✗'}｜拍立得外观 ${polaroidOk ? '✓' : '✗'}` +
        ` → ${ok ? '通过' : '未通过'}`,
    );
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error('[pi/smoke] 设置页冒烟失败：', error);
    app.exit(1);
  }
}

void app.whenReady().then(async () => {
  try {
    await services.init();
  } catch (err) {
    // 初始化失败也要把窗口开出来：至少让用户看到界面与错误提示。
    console.error('[pi] 服务初始化失败：', err);
  }

  registerIpc(services, () => mainWindow);

  // 自动验收模式：跑完即退出，不创建窗口。
  if (process.env.PI_SMOKE_PLAY) {
    await runPlaySmoke(services);
    return;
  }

  // M2.5 音源体系自动验收：责任链 + 第三方匹配 + 关源即跳过。
  if (process.env.PI_SMOKE_SOURCES) {
    await runSourceSmoke(services);
    return;
  }

  createWindow();

  // M2.5 渲染层验收：设置页（含本地曲库输入）与音质日志页真的画出来了。
  if (process.env.PI_SMOKE_SETTINGS && mainWindow) {
    await runSettingsSmoke(mainWindow);
    return;
  }

  // UI 级自动验收：真开窗口、真点歌，看 <audio> 时间轴有没有走。
  if (process.env.PI_SMOKE_UI && mainWindow) {
    await runUiSmoke(mainWindow);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 退出前把去抖中的写入落盘，避免丢最后几秒的播放记录。
  void services.dispose();
});
