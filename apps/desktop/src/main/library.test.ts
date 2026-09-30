/**
 * `library:list` 背后那份纯逻辑的单测。
 *
 * 这里**不 import electron / services**：被测模块 `./library.js` 只做
 * 「目录解析 + 扫描 + 错误兜底」，所以能直接在 node 里跑真文件系统。
 * 四组用例分别钉住：没配目录、扫描器炸了、目录不存在/是空的、目录里真有音频。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanAudioDirectory } from '@pi/source-local';
import { describe, expect, it } from 'vitest';
import { listLocalLibrary, type LocalLibraryScanFn } from './library.js';

/** 每例一个独立临时目录，结束就删干净（不往仓库里留垃圾）。 */
async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'pi-library-'));
}

describe('本地库扫描：listLocalLibrary', () => {
  it('设置里没填目录（空串）→ 空清单，且根本不去碰文件系统', async () => {
    const calls: string[] = [];
    const scan: LocalLibraryScanFn = async (dir) => {
      calls.push(dir);
      return [];
    };

    const result = await listLocalLibrary('   ', { scan });

    expect(result).toEqual({ dir: '', tracks: [] });
    expect(calls).toEqual([]);
  });

  it('扫描器抛异常 → 兜底成空清单 + 一条 warn，异常不往外冒', async () => {
    const warnings: unknown[][] = [];
    const scan: LocalLibraryScanFn = async () => {
      throw new Error('boom');
    };

    const result = await listLocalLibrary(path.join(tmpdir(), 'pi-library-missing'), {
      scan,
      onWarn: (message, detail) => warnings.push([message, detail]),
    });

    expect(result.tracks).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.[0]).toContain('扫描本地曲库失败');
  });

  it('目录不存在 / 目录是空的 → 都是 tracks: []，不抛错，dir 已解析成绝对路径', async () => {
    const missing = path.join(tmpdir(), `pi-library-nope-${Date.now()}`);
    const missingResult = await listLocalLibrary(missing, { onWarn: () => {} });
    expect(missingResult.tracks).toEqual([]);
    expect(missingResult.dir).toBe(path.resolve(missing));
    expect(path.isAbsolute(missingResult.dir)).toBe(true);

    const empty = await makeTempDir();
    try {
      const emptyResult = await listLocalLibrary(empty, { onWarn: () => {} });
      expect(emptyResult.tracks).toEqual([]);
      expect(emptyResult.dir).toBe(path.resolve(empty));
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('目录里真有音频 → 条数与 scanAudioDirectory 一致；相对路径输入也会给出绝对路径', async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(path.join(dir, 'A - B.flac'), 'not-really-audio');
      await writeFile(path.join(dir, 'c.mp3'), 'not-really-audio');
      await writeFile(path.join(dir, 'notes.txt'), 'ignored');
      await mkdir(path.join(dir, 'sub'));
      await writeFile(path.join(dir, 'sub', 'd.m4a'), 'not-really-audio');

      const baseline = await scanAudioDirectory(dir);
      // 同一个目录，这次故意用相对路径喂进去（跨盘时 path.relative 会给出绝对路径，
      // 断言仍然成立：无论如何 dir/path 都要是绝对路径）。
      const viaRelative = await listLocalLibrary(path.relative(process.cwd(), dir), {
        onWarn: () => {},
      });

      expect(baseline.length).toBe(3); // 子目录也被递归到了，.txt 不算
      expect(viaRelative.tracks.length).toBe(baseline.length);
      expect(viaRelative.dir).toBe(path.resolve(dir));
      expect(viaRelative.tracks.every((track) => path.isAbsolute(track.path))).toBe(true);
      expect(
        viaRelative.tracks
          .map((track) => track.path)
          .sort()
          .map((p) => path.basename(p)),
      ).toEqual(['A - B.flac', 'c.mp3', 'd.m4a']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
