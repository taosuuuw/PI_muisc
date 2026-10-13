/**
 * `apps/desktop/src/main/tray.ts` 行为锁。
 *
 * 这一串测试钉的是「托盘图标为什么可能什么都看不见」这一类**静默失败**：
 *   ① 文件不存在；② 文件在但 `createFromPath()` 解出来是空图（坏 .ico / 解码失败）；
 *   ③ 连文件都没有时兜底图必须是**可见的非空图**，不能又是空图；
 *   ④ 托盘与热键都没有时，关窗不许把窗口藏成「找不回来」。
 *
 * 全程纯函数 + 注入替身，不 import electron、不开窗口、不写盘。
 */
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { NativeImage } from 'electron';
import {
  buildFallbackTrayBitmap,
  decideBackgroundAction,
  describeTrayResolution,
  resolveTrayIcon,
  trayIconCandidates,
} from './tray.js';

/** 真实仓库根（本测试文件在 apps/desktop/src/main/ 下）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
/** 开发态主进程产物所在目录（`out/main.mjs` 的 dirname）＝ `here`。 */
const DEV_HERE = path.join(REPO_ROOT, 'apps', 'desktop', 'out');

/** 造一个假 NativeImage：只需要 `isEmpty()` / `getSize()`。 */
function fakeImage(width: number, height: number, empty = false): NativeImage {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
  } as unknown as NativeImage;
}

describe('trayIconCandidates', () => {
  const here = path.join('X:', 'repo', 'apps', 'desktop', 'out');

  it('开发态候选排在最前，命中仓库根的 build/pi.ico', () => {
    const list = trayIconCandidates({ here, resourcesPath: 'X:\\repo\\release\\pi\\resources' });
    expect(list[0]).toBe(path.resolve(here, '../../../build/pi.ico'));
    expect(list[0]?.replaceAll('\\', '/')).toBe('X:/repo/build/pi.ico');
  });

  it('打包态的 resources/build/pi.ico 在候选里（make-dist 步骤 6 复制的那份）', () => {
    const list = trayIconCandidates({ here, resourcesPath: 'X:\\repo\\release\\pi\\resources' });
    expect(list).toContain(path.join('X:\\repo\\release\\pi\\resources', 'build', 'pi.ico'));
  });

  it('可执行文件同级的 pi.ico（便携版 release/pi/pi.ico）也在候选里', () => {
    const list = trayIconCandidates({ here, exeDir: 'X:\\repo\\release\\pi' });
    expect(list).toContain(path.join('X:\\repo\\release\\pi', 'pi.ico'));
    expect(list).toContain(path.join('X:\\repo\\release\\pi', 'build', 'pi.ico'));
  });

  it('候选不重复', () => {
    const list = trayIconCandidates({
      here,
      resourcesPath: 'X:\\repo\\release\\pi\\resources',
      exeDir: 'X:\\repo\\release\\pi',
    });
    expect(new Set(list).size).toBe(list.length);
  });

  it('缺 resourcesPath/exeDir 时不炸（其它平台/异常环境）', () => {
    const list = trayIconCandidates({ here });
    expect(list.length).toBe(1);
  });
});

describe('resolveTrayIcon', () => {
  const candidates = ['a.ico', 'b.ico'];

  it('第一个「存在且非空」的候选胜出，不再看后面的', () => {
    const load = vi.fn(() => fakeImage(256, 256));
    const result = resolveTrayIcon({
      candidates,
      exists: (file) => file === 'a.ico',
      load,
      fallback: () => fakeImage(32, 32),
    });
    expect(result.source).toBe('file');
    expect(result.path).toBe('a.ico');
    expect(result.skipped).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('文件不存在 → 记 missing，继续试下一个', () => {
    const result = resolveTrayIcon({
      candidates,
      exists: (file) => file === 'b.ico',
      load: () => fakeImage(256, 256),
      fallback: () => fakeImage(32, 32),
    });
    expect(result.path).toBe('b.ico');
    expect(result.skipped).toEqual([{ path: 'a.ico', reason: 'missing' }]);
  });

  it('文件在但解出来是空图 → 记 empty 并换下一个（这条正是原来的洞）', () => {
    const result = resolveTrayIcon({
      candidates,
      exists: () => true,
      load: (file) => (file === 'a.ico' ? fakeImage(0, 0, true) : fakeImage(256, 256)),
      fallback: () => fakeImage(32, 32),
    });
    expect(result.source).toBe('file');
    expect(result.path).toBe('b.ico');
    expect(result.skipped).toEqual([{ path: 'a.ico', reason: 'empty' }]);
  });

  it('createFromPath 抛异常也当 empty 处理，不让异常冒到启动流程', () => {
    const result = resolveTrayIcon({
      candidates: ['a.ico'],
      exists: () => true,
      load: () => {
        throw new Error('decode failed');
      },
      fallback: () => fakeImage(32, 32),
    });
    expect(result.source).toBe('fallback');
    expect(result.skipped).toEqual([{ path: 'a.ico', reason: 'empty' }]);
  });

  it('所有候选都不行 → 兜底图，且永不返回空图', () => {
    const fallback = vi.fn(() => fakeImage(32, 32));
    const result = resolveTrayIcon({
      candidates,
      exists: (file) => file === 'a.ico',
      load: () => fakeImage(0, 0, true),
      fallback,
    });
    expect(result.source).toBe('fallback');
    expect(result.path).toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.image.isEmpty()).toBe(false);
    expect(result.skipped).toEqual([
      { path: 'a.ico', reason: 'empty' },
      { path: 'b.ico', reason: 'missing' },
    ]);
  });
});

describe('buildFallbackTrayBitmap', () => {
  it('尺寸与缓冲区长度对得上（BGRA）', () => {
    const bitmap = buildFallbackTrayBitmap(32);
    expect(bitmap.width).toBe(32);
    expect(bitmap.height).toBe(32);
    expect(bitmap.buffer.length).toBe(32 * 32 * 4);
  });

  it('是一张**看得见**的图：大部分像素不透明，且有蓝有白', () => {
    const { width, height, buffer } = buildFallbackTrayBitmap(32);
    let opaque = 0;
    let blue = 0;
    let white = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      const b = buffer[i] ?? 0;
      const g = buffer[i + 1] ?? 0;
      const r = buffer[i + 2] ?? 0;
      const a = buffer[i + 3] ?? 0;
      if (a === 0xff) opaque++;
      if (a === 0xff && b === 0xf6 && g === 0x6b && r === 0x2f) blue++;
      if (a === 0xff && b === 0xff && g === 0xff && r === 0xff) white++;
    }
    const total = width * height;
    expect(opaque).toBeGreaterThan(total * 0.6); // 圆角只切掉四个角
    expect(blue).toBeGreaterThan(0);
    expect(white).toBeGreaterThan(0);
  });

  it('四角是透明的（圆角，不是一块实心方砖）', () => {
    const { width, height, buffer } = buildFallbackTrayBitmap(32);
    const alphaAt = (x: number, y: number): number => buffer[(y * width + x) * 4 + 3] ?? -1;
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(width - 1, 0)).toBe(0);
    expect(alphaAt(0, height - 1)).toBe(0);
    expect(alphaAt(width - 1, height - 1)).toBe(0);
  });

  it('缩到 16×16 仍然看得见（托盘真实尺寸）', () => {
    const { width, height, buffer } = buildFallbackTrayBitmap(16);
    let opaque = 0;
    for (let i = 3; i < buffer.length; i += 4) if (buffer[i] === 0xff) opaque++;
    expect(width).toBe(16);
    expect(height).toBe(16);
    expect(opaque).toBeGreaterThan(width * height * 0.4);
  });

  it('尺寸下限 16，不会被传成 0 而算出空图', () => {
    const bitmap = buildFallbackTrayBitmap(0);
    expect(bitmap.width).toBe(16);
    expect(bitmap.buffer.length).toBe(16 * 16 * 4);
  });
});

describe('decideBackgroundAction', () => {
  it('托盘可用 → 藏（正常路径不变）', () => {
    expect(decideBackgroundAction({ trayUsable: true, hotkeyRegistered: false })).toBe('hide');
  });

  it('托盘不可用但热键注册上了 → 仍然藏（热键是第二条恢复路径）', () => {
    expect(decideBackgroundAction({ trayUsable: false, hotkeyRegistered: true })).toBe('hide');
  });

  it('托盘与热键都没有 → 不藏，窗口留在屏幕上', () => {
    expect(decideBackgroundAction({ trayUsable: false, hotkeyRegistered: false })).toBe(
      'keep-visible',
    );
  });
});

describe('describeTrayResolution', () => {
  it('用文件时打印路径', () => {
    const text = describeTrayResolution({
      image: fakeImage(256, 256),
      source: 'file',
      path: 'X:\\repo\\build\\pi.ico',
      skipped: [],
    });
    expect(text).toContain('X:\\repo\\build\\pi.ico');
  });

  it('用兜底图时打印尺寸，并列出每个被跳过的候选与原因', () => {
    const text = describeTrayResolution({
      image: fakeImage(32, 32),
      source: 'fallback',
      skipped: [
        { path: 'a.ico', reason: 'missing' },
        { path: 'b.ico', reason: 'empty' },
      ],
    });
    expect(text).toContain('代码内置兜底图');
    expect(text).toContain('32x32');
    expect(text).toContain('a.ico（不存在）');
    expect(text).toContain('b.ico（解不出图/空图）');
  });
});

/**
 * 用**真实仓库路径**跑的回归（不是假文件系统）：
 * 开发态那条 `here/../../../build/pi.ico` 一旦算错，托盘与窗口图标会一起失效，
 * 而且只在真机上才看得出来——所以这里直接钉住它，并确认那份 .ico 容器本身是好的。
 */
describe('开发态资源路径（真实文件系统）', () => {
  it('dev here 推导出的第一个候选正好是仓库根的 build/pi.ico，且它真的存在', () => {
    const list = trayIconCandidates({ here: DEV_HERE });
    const devIcon = path.join(REPO_ROOT, 'build', 'pi.ico');
    expect(list[0]).toBe(devIcon);
    expect(existsSync(devIcon)).toBe(true);
  });

  it('打包态 here 能推导出 resources/build/pi.ico（make-dist 复制的那份）', () => {
    const portableHere = path.join(REPO_ROOT, 'release', 'pi', 'resources', 'app', 'out');
    const list = trayIconCandidates({
      here: portableHere,
      resourcesPath: path.join(REPO_ROOT, 'release', 'pi', 'resources'),
      exeDir: path.join(REPO_ROOT, 'release', 'pi'),
    });
    expect(list).toContain(path.join(REPO_ROOT, 'release', 'pi', 'resources', 'build', 'pi.ico'));
    expect(list).toContain(path.join(REPO_ROOT, 'release', 'pi', 'pi.ico'));
  });

  it('build/pi.ico 本身是有效 ICO 容器（不是改了后缀的 PNG / 空壳）', () => {
    const file = path.join(REPO_ROOT, 'build', 'pi.ico');
    const bytes = readFileSync(file);
    expect(bytes.length).toBeGreaterThan(1024);
    // ICONDIR: reserved=0, type=1(icon), count>=1
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    const frames = bytes.readUInt16LE(4);
    expect(frames).toBeGreaterThanOrEqual(1);
    // 至少要有一帧 32bpp：托盘取小尺寸那一帧
    let has32bpp = false;
    for (let i = 0; i < frames; i++) {
      if (bytes.readUInt16LE(6 + i * 16 + 6) === 32) has32bpp = true;
    }
    expect(has32bpp).toBe(true);
    expect(statSync(file).size).toBe(bytes.length);
  });
});
