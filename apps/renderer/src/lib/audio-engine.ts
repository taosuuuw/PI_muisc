/**
 * 两个 `<audio>` 元素（P2 起是双 deck）。
 *
 * 为什么不让 React 渲染 `<audio>`：切页面（以及开发期热更新）时组件一旦卸载就会直接断音，
 * 而「切换页面不断音」是 M2 的验收条件之一。元素脱离 React 生命周期后，
 * 由 `state/player.ts` 控制播放，由 `components/AudioEngine.tsx` 把元素事件接回 store。
 *
 * 为什么两个：交叉淡化要同时出声，一个元素做不到。约定：
 * - **活动 deck** 是「用户正在听的那一首」，`window.__piAudio` 永远指向它；
 * - 备用 deck 只在预取/交叉的那几秒有内容，交叉结束就被暂停并复位。
 *
 * 地址永远是 127.0.0.1 上的本地代理（`apps/desktop/src/main/media-server.ts`）：
 * 渲染进程既拿不到 cookie，也不该直接访问网易云 CDN。代理会回 `Access-Control-Allow-Origin`
 * （见 `docs/PLAN-AUTOMIX.md` §P0），所以这里设 `crossOrigin = 'anonymous'`——它是跨源媒体
 * 能进 Web Audio `MediaElementAudioSourceNode` 的前提；不设的话节点只会输出**零样本**。
 */
import { setMasterVolume, type DeckId } from './transition/fade-graph';

const decks: Partial<Record<DeckId, HTMLAudioElement>> = {};
let active: DeckId = 'a';

/**
 * 把**活动**元素挂到 `window.__piAudio`：主进程的 UI 冒烟（`PI_SMOKE_UI=1`）与排障要靠它读
 * 「现在到底有没有出声」（currentTime/paused/error）。切 deck 时这个引用要跟着换，
 * 否则冒烟会读到已经淡出的那一路。它不带任何额外能力——渲染进程本来就握着这两个元素。
 */
declare global {
  interface Window {
    __piAudio?: HTMLAudioElement;
  }
}

function createElement(): HTMLAudioElement {
  const element = new Audio();
  element.preload = 'auto';
  // 必须在任何 `src` 之前定下来。跨源媒体要带 ACAO（media-server 已补），否则
  // `MediaElementAudioSourceNode` 输出零样本：播放看着正常，波形全是 0。
  element.crossOrigin = 'anonymous';
  return element;
}

/** 取某个 deck 的元素（懒创建）。 */
export function getDeckElement(id: DeckId): HTMLAudioElement {
  let element = decks[id];
  if (!element) {
    element = createElement();
    decks[id] = element;
    // 第一次创建的是活动 deck（默认 a）。
    if (window.__piAudio === undefined && id === active) window.__piAudio = element;
  }
  return element;
}

/** 当前活动 deck 的元素。**所有「用户正在听」的操作都该用它。** */
export function getAudio(): HTMLAudioElement {
  return getDeckElement(active);
}

/** 当前活动 deck。 */
export function getActiveDeck(): DeckId {
  return active;
}

/**
 * 切活动 deck：只改路由与 `window.__piAudio`，不动增益，也不暂停任何东西。
 * 增益曲线由 `transition/fade-graph.ts` 的 `crossfade` / `fadeIn` 负责。
 */
export function switchActiveDeck(id: DeckId): void {
  active = id;
  window.__piAudio = getDeckElement(id);
}

/** 两个元素都建出来（交叉淡化要两路都在图上）。 */
export function ensureDecks(): Record<DeckId, HTMLAudioElement> {
  return { a: getDeckElement('a'), b: getDeckElement('b') };
}

export function currentTimeMs(): number {
  const audio = getAudio();
  return Number.isFinite(audio.currentTime) ? Math.round(audio.currentTime * 1000) : 0;
}

export function applyVolume(volume: number, muted: boolean): void {
  const audio = getAudio();
  // 元素本身固定满幅：真正的音量在 Web Audio 的 masterGain 上（见 `transition/fade-graph.ts`）。
  // 这样「用户音量」与「过渡的增益」是两层，互不覆盖——淡变永远不碰用户设的那一档。
  audio.volume = 1;
  setMasterVolume(volume, muted);
}
