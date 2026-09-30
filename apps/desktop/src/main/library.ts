/**
 * M5「本地库」：把本地音乐文件夹的扫描结果整理成渲染层要的形状。
 *
 * 这个模块**故意不 import electron**（也不用 Services）：
 * 目录解析、空目录、目录不存在、权限不足这些分支都是纯逻辑，
 * 应该能被 vitest 直接测，而不是只能靠「起一个 Electron 点点看」。
 * 目录从外面传进来（`library:list` 的调用方从 settings 里取）。
 *
 * 与 `services.ts` 里那份 `loadLocalLibrary()` 的关系：
 * 那份是**启动时的缓存**（L4 本地兜底音源用），这里是**按需重扫**。
 * 两者共用同一个扫描器（`scanAudioDirectory`），所以看到的永远同一份清单。
 */

import path from 'node:path';
import { scanAudioDirectory, type LocalTrack } from '@pi/source-local';
import type { LocalLibraryList, LocalLibraryTrack } from '@pi/ipc';

/**
 * 编译期断言：`A` 必须能赋给 `B`（@pi/ipc 里的同名工具没有导出，这里就地来一份，
 * 免得为了一个类型断言去动已经冻结的契约包）。两边都成立 = 形状完全一致。
 */
type AssertAssignable<A extends B, B> = A;

/** 扫描器的形状（可注入替身，测试里不必真读盘）。 */
export type LocalLibraryScanFn = (
  dir: string,
  options: { onWarn?: (message: string, detail?: unknown) => void },
) => Promise<LocalTrack[]>;

export interface ListLocalLibraryOptions {
  /** 默认 `scanAudioDirectory`。注入替身即可绕开文件系统。 */
  scan?: LocalLibraryScanFn;
  /** 扫描过程中的软失败（读不了某个子目录）。默认打 `[pi/source-local]` 前缀的 warn。 */
  onWarn?: (message: string, detail?: unknown) => void;
}

/**
 * 契约漂移的编译期守卫。
 *
 * `LocalLibraryTrack` 是 @pi/ipc 里手抄的一份形状（@pi/ipc 只依赖 @pi/shared + zod，
 * 不能 import @pi/source-local），所以这里在**能同时看到两边**的地方钉死：
 * 一旦 `packages/source-local` 改了 `LocalTrack`，这一行会直接编译失败。
 */
export type _LocalTrackToList = AssertAssignable<LocalTrack, LocalLibraryTrack>;
export type _LocalTrackListBack = AssertAssignable<LocalLibraryTrack, LocalTrack>;

/**
 * 扫一个目录，返回 `{ dir, tracks }`。
 *
 * - 目录为空串（设置里没填）→ `{ dir: '', tracks: [] }`，不报错：这是「用户没开这个功能」。
 * - 相对路径解析成绝对路径再扫：条目里的 `path` 会被 MediaServer 直接按 Range 读，
 *   相对路径换个工作目录就失效了。
 * - 目录不存在 / 读不了 → `{ dir, tracks: [] }`，并且**不抛**：
 *   界面上要能显示「这个目录里没有音频」，而不是弹一个红叉。
 */
export async function listLocalLibrary(
  dir: string,
  options: ListLocalLibraryOptions = {},
): Promise<LocalLibraryList> {
  const warn =
    options.onWarn ?? ((message: string, detail?: unknown) => console.warn(message, detail));
  const target = dir.trim();
  if (target === '') return { dir: '', tracks: [] };

  const absolute = path.resolve(target);
  const scan = options.scan ?? scanAudioDirectory;
  try {
    const tracks = await scan(absolute, { onWarn: warn });
    return { dir: absolute, tracks };
  } catch (error) {
    // 目前 scanAudioDirectory 内部已经把可预期的错误消化成空数组 + warn；
    // 这一层保底是为了「扫描器将来抛了」也不会把 IPC handler 变成异常。
    warn(`[pi/source-local] 扫描本地曲库失败（${absolute}）`, error);
    return { dir: absolute, tracks: [] };
  }
}
