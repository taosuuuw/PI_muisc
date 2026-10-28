/**
 * `<audio>` 元素的单例。
 *
 * 为什么不让 React 渲染 `<audio>`：切页面（以及开发期热更新）时组件一旦卸载就会直接断音，
 * 而「切换页面不断音」是 M2 的验收条件之一。元素脱离 React 生命周期后，
 * 由 `state/player.ts` 控制播放，由 `components/AudioEngine.tsx` 把元素事件接回 store。
 *
 * 地址永远是 127.0.0.1 上的本地代理（`apps/desktop/src/main/media-server.ts`）：
 * 渲染进程既拿不到 cookie，也不该直接访问网易云 CDN。代理现在会回 `Access-Control-Allow-Origin`
 * （见 `docs/PLAN-AUTOMIX.md` §P0），所以这里设 `crossOrigin = 'anonymous'`——它是跨源媒体
 * 能进 Web Audio `MediaElementAudioSourceNode` 的前提；不设的话节点只会输出**零样本**。
 * 注意：这不是「给外网 CDN 加 crossOrigin」——播放链上没有任何外网地址，只有本机代理。
 */
import { setMasterVolume } from './transition/fade-graph';

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
    // 必须在任何 `src` 之前定下来。跨源媒体要带 ACAO（media-server 已补），否则
    // `MediaElementAudioSourceNode` 输出零样本：播放看着正常，波形全是 0。
    element.crossOrigin = 'anonymous';
    window.__piAudio = element;
  }
  return element;
}

export function currentTimeMs(): number {
  const audio = getAudio();
  return Number.isFinite(audio.currentTime) ? Math.round(audio.currentTime * 1000) : 0;
}

export function applyVolume(volume: number, muted: boolean): void {
  const audio = getAudio();
  // 元素本身固定满幅：真正的音量在 Web Audio 的 masterGain 上（见 `transition/fade-graph.ts`）。
  // 这样「用户音量」与「过渡的 fadeGain」是两层，互不覆盖——淡变永远不碰用户设的那一档。
  audio.volume = 1;
  setMasterVolume(volume, muted);
}
