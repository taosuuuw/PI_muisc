/**
 * 托盘图标的**纯逻辑**：候选路径 → 解码校验 → 兜底图；以及「窗口能不能安心藏起来」的判定。
 *
 * 为什么单独一个文件、还要能注入依赖：
 * `apps/desktop/src/main/index.ts` 里原来的托盘代码是「文件存在就当图能用」——
 *   `const image = icon === undefined ? nativeImageFallback() : nativeImage.createFromPath(icon)`
 * 而 `nativeImageFallback()` 返回的是 `nativeImage.createEmpty()`。两个洞：
 *   ① `existsSync(路径)` 为真 **不代表** `createFromPath()` 解得出图（.ico 坏帧、
 *      只写了文件头、被杀软改写……）——那时拿到的是空图，`new Tray(空图)` 不抛异常，
 *      但系统通知区里**什么都看不见**，日志还写着「托盘图标已挂上」。
 *   ② 连文件都找不到时用空图兜底，等于「静默无图标」。
 * 这两条都只能靠日志猜，因为它们夹在 Electron API 与真实文件系统里、没法单测。
 * 所以把「选路径 / 判空 / 兜底」抽成这里一组接受注入的函数，`tray.test.ts` 全覆盖。
 *
 * 本文件不 import electron（只 import 类型），因此能在 vitest（纯 Node）里直接跑。
 */
import path from 'node:path';
import type { NativeImage } from 'electron';

/* ------------------------------------------------------------------ *
 * 候选路径
 * ------------------------------------------------------------------ */

export interface TrayIconPathInput {
  /** 主进程产物所在目录（`out/main.mjs` 的 dirname） */
  here: string;
  /** `process.resourcesPath`（Electron 一定有，但测试里允许缺省） */
  resourcesPath?: string | undefined;
  /** 可执行文件所在目录（`path.dirname(app.getPath('exe'))`） */
  exeDir?: string | undefined;
}

/**
 * 按「先开发布局、后打包布局」排好序的候选路径。
 *
 * - `here/../../../build/pi.ico`：开发态（`apps/desktop/out` → 仓库根 `build/pi.ico`）；
 *   打包态这里同时也能命中便携版里的 `<安装目录>/build/pi.ico`
 *   （`release/pi/resources/app/out` → `release/pi/build/pi.ico`，见 `scripts/make-dist.mjs` 步骤 6）。
 * - `resourcesPath/build/pi.ico`：打包态首选（`scripts/make-dist.mjs` 显式复制到这里）。
 * - `resourcesPath/pi.ico`：有些打包方式直接把图标放在 resources 根。
 * - `<exe 目录>/pi.ico`、`<exe 目录>/build/pi.ico`：便携版 `release/pi/pi.ico` 与旧布局。
 *
 * 去重并保序：顺序就是优先级，`resolveTrayIcon()` 拿第一个「存在且解得出非空图」的。
 */
export function trayIconCandidates(input: TrayIconPathInput): string[] {
  const candidates: string[] = [path.resolve(input.here, '../../../build/pi.ico')];
  if (input.resourcesPath) {
    candidates.push(path.join(input.resourcesPath, 'build', 'pi.ico'));
    candidates.push(path.join(input.resourcesPath, 'pi.ico'));
  }
  if (input.exeDir) {
    candidates.push(path.join(input.exeDir, 'pi.ico'));
    candidates.push(path.join(input.exeDir, 'build', 'pi.ico'));
  }
  return [...new Set(candidates)];
}

/* ------------------------------------------------------------------ *
 * 解析：存在 + 解得出 + 非空，缺一不可
 * ------------------------------------------------------------------ */

export type TrayIconSource = 'file' | 'fallback';

export interface TrayIconSkip {
  path: string;
  /** missing = 文件不在；empty = 在但解出来是空图（坏图/只读了一半/解码失败） */
  reason: 'missing' | 'empty';
}

export interface TrayIconResolution {
  image: NativeImage;
  source: TrayIconSource;
  /** 命中的文件路径；`source === 'fallback'` 时为 undefined */
  path?: string;
  skipped: TrayIconSkip[];
}

export interface ResolveTrayIconDeps {
  candidates: string[];
  exists(file: string): boolean;
  load(file: string): NativeImage;
  /** 兜底图（必须是**可见的非空图**，见 `buildFallbackTrayBitmap`） */
  fallback(): NativeImage;
}

/**
 * 逐个候选试：不存在 → 记 missing；`load()` 抛异常或 `isEmpty()` → 记 empty；
 * 都不行就用 `fallback()`。
 *
 * 承诺：**永不返回空图**（只要 `fallback()` 给的是非空图，生产实现就是这么给的）。
 */
export function resolveTrayIcon(deps: ResolveTrayIconDeps): TrayIconResolution {
  const skipped: TrayIconSkip[] = [];
  for (const candidate of deps.candidates) {
    if (!deps.exists(candidate)) {
      skipped.push({ path: candidate, reason: 'missing' });
      continue;
    }
    let image: NativeImage;
    try {
      image = deps.load(candidate);
    } catch {
      skipped.push({ path: candidate, reason: 'empty' });
      continue;
    }
    if (!image || image.isEmpty()) {
      skipped.push({ path: candidate, reason: 'empty' });
      continue;
    }
    return { image, source: 'file', path: candidate, skipped };
  }
  return { image: deps.fallback(), source: 'fallback', skipped };
}

/* ------------------------------------------------------------------ *
 * 兜底图：代码里画一枚 π，不依赖任何文件
 * ------------------------------------------------------------------ */

/** 图标里的品牌蓝（BGR 顺序写在下面）与白。 */
const FALLBACK_BLUE = { b: 0xf6, g: 0x6b, r: 0x2f };
const FALLBACK_WHITE = { b: 0xff, g: 0xff, r: 0xff };

/**
 * 生成一张 16×16（默认 32×32，Windows 会自己缩）的 π 图标位图：蓝色圆角方块 + 白色 π。
 *
 * 为什么在代码里画而不是读 `build/pi-icon-256.png`：
 * 兜底图的**全部意义**就是「文件系统里的东西不可靠时还有图可挂」——
 * 再去读一个文件就又把同一个失败点引回来了。纯代码生成 ⇒ 任何环境下都画得出来。
 *
 * 返回 BGRA（Chromium `nativeImage.createFromBitmap` 要的顺序），alpha=0 表示透明。
 */
export function buildFallbackTrayBitmap(size = 32): {
  width: number;
  height: number;
  buffer: Buffer;
} {
  const width = Math.max(16, Math.round(size));
  const height = width;
  const buffer = Buffer.alloc(width * height * 4);
  const scale = width / 32;
  const px = (value: number): number => Math.round(value * scale);

  // 圆角方块：四角各切掉一个半径 r 的圆，其余填蓝。
  const r = px(6);
  const inSquare = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const cornerX = x < r ? r - 1 - x : x >= width - r ? x - (width - r) : 0;
    const cornerY = y < r ? r - 1 - y : y >= height - r ? y - (height - r) : 0;
    if (cornerX === 0 || cornerY === 0) return true;
    return cornerX * cornerX + cornerY * cornerY <= r * r;
  };
  // π：一横 + 两竖（坐标按 32×32 设计，再按 scale 缩放）。
  const inPi = (x: number, y: number): boolean => {
    const bar = y >= px(8) && y <= px(11) && x >= px(6) && x <= px(25);
    const leftStem = y >= px(9) && y <= px(25) && x >= px(8) && x <= px(12);
    const rightStem = y >= px(9) && y <= px(25) && x >= px(19) && x <= px(23);
    return bar || leftStem || rightStem;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const color = inPi(x, y) ? FALLBACK_WHITE : inSquare(x, y) ? FALLBACK_BLUE : null;
      if (color === null) continue; // 透明
      buffer[offset] = color.b;
      buffer[offset + 1] = color.g;
      buffer[offset + 2] = color.r;
      buffer[offset + 3] = 0xff;
    }
  }
  return { width, height, buffer };
}

/* ------------------------------------------------------------------ *
 * 「关窗能不能藏起来」的判定
 * ------------------------------------------------------------------ */

export type BackgroundAction = 'hide' | 'keep-visible';

/**
 * `closeAction === 'background'` 时，这一次关窗到底藏不藏。
 *
 * 规矩（用户要求「不能藏起来就没法恢复」）：
 *   · 托盘对象造出来了 **或** 全局快捷键注册上了 ⇒ 藏，两条恢复路径至少有其一；
 *   · 两条都没有 ⇒ **不藏**：宁可把窗口留在屏幕上，也不能让用户对着一个
 *     既没有托盘图标、又没有热键的隐形播放器。
 */
export function decideBackgroundAction(input: {
  trayUsable: boolean;
  hotkeyRegistered: boolean;
}): BackgroundAction {
  return input.trayUsable || input.hotkeyRegistered ? 'hide' : 'keep-visible';
}

/** 把一次托盘解析压成一行日志（含跳过的候选与原因），排障时一眼能看完。 */
export function describeTrayResolution(resolution: TrayIconResolution): string {
  const skipped = resolution.skipped
    .map((item) => `${item.path}（${item.reason === 'missing' ? '不存在' : '解不出图/空图'}）`)
    .join('、');
  const head =
    resolution.source === 'file'
      ? `图标=${resolution.path}`
      : `图标=代码内置兜底图（${resolution.image.getSize().width}x${resolution.image.getSize().height}）`;
  return skipped === '' ? head : `${head}｜跳过的候选：${skipped}`;
}
