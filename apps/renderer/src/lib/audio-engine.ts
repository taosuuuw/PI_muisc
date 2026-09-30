/**
 * `<audio>` 元素的单例。
 *
 * 为什么不让 React 渲染 `<audio>`：切页面（以及开发期热更新）时组件一旦卸载就会直接断音，
 * 而「切换页面不断音」是 M2 的验收条件之一。元素脱离 React 生命周期后，
 * 由 `state/player.ts` 控制播放，由 `components/AudioEngine.tsx` 把元素事件接回 store。
 *
 * 地址永远是 127.0.0.1 上的本地代理（`apps/desktop/src/main/media-server.ts`）：
 * 渲染进程既拿不到 cookie，也不该直接访问网易云 CDN。这里**不设 `crossOrigin`**——
 * 网易云 CDN 不返回 CORS 头，加了反而会被浏览器拒绝（同类坑见 docs/PLAN.md §4.1）。
 */
let element: HTMLAudioElement | undefined;

/**
 * 把元素挂到 `window.__piAudio`：主进程的 UI 冒烟（`PI_SMOKE_UI=1`）与排障要靠它读
 * 「现在到底有没有出声」（currentTime/paused/error）。它不带任何额外能力——渲染进程本来
 * 就握着这个元素，只是主进程隔着 contextIsolation 看不到它。
 */
declare global {
  interface Window {
    __piAudio?: HTMLAudioElement;
  }
}

export function getAudio(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = 'auto';
    window.__piAudio = element;
  }
  return element;
}

export function currentTimeMs(): number {
  const audio = getAudio();
  return Number.isFinite(audio.currentTime) ? Math.round(audio.currentTime * 1000) : 0;
}

export function applyVolume(volume: number, muted: boolean): void {
  getAudio().volume = muted ? 0 : Math.min(1, Math.max(0, volume));
}
