/**
 * 主题明暗的本机首帧缓存。
 *
 * 真正的设置在主进程里，读回来是异步的；如果等它到位再画，启动第一帧只能按默认浅色，
 * 深色用户会先看到一帧白、再闪成黑（开场动画盖住整屏时尤其明显）。
 *
 * 所以每次主题解析完都往 localStorage 写一份原始档位（`light` / `dark` / `system`），
 * `main.tsx` 在 React 挂载前同步读它、先给 `<html data-theme>` 上好色；设置读回来后再由
 * `useThemeMode` 校正。缓存只是首帧的「上次已知值」，不是第二事实来源。
 */
export const THEME_CACHE_KEY = 'pi.theme';

/** 首帧能直接用的明暗：缓存是 system 时按系统媒体查询展开。 */
export function cachedTheme(): 'light' | 'dark' {
  try {
    const raw = window.localStorage.getItem(THEME_CACHE_KEY);
    if (raw === 'dark' || raw === 'light') return raw;
    if (raw === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  } catch {
    /* 隐私模式禁用 localStorage 时退回默认浅色。 */
  }
  return 'light';
}

/** React 挂载前调用：给根节点一个正确的首帧明暗。 */
export function applyCachedTheme(): void {
  document.documentElement.dataset.theme = cachedTheme();
}

/** 设置解析完 / 变化时写回原始档位（不是解析后的明暗），供下一次启动首帧使用。 */
export function cacheTheme(theme: 'light' | 'dark' | 'system'): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    /* 写不进去只影响下次首帧，不影响本次。 */
  }
}
