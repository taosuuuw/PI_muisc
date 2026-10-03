/**
 * 全局快捷键监听（用户 m00001 第 5 条）。
 *
 * 挂在 `App` 根部，负责三件事：
 *   ① 把 window 上的 keydown / keyup 翻译成九种动作（Esc / Tab / Ctrl+A / Ctrl+S / 空格 / 方向键）；
 *   ② 长按的连续性：不用键盘的 `repeat` 事件，而是按下后起一个 rAF 循环，按时间匀速推进；
 *   ③ 设置页改绑时的「按下新键」捕获态——用 window **捕获阶段** 吃掉按键，
 *      这样设置框自己的 Esc 监听不会在我们等新键时把整个设置框关掉。
 *
 * 与既有 Esc 监听（`SettingsOverlay` / `NavDrawer` / `SearchOverlay` / `SongListOverlay` /
 * `PlaylistDetail` / `PiQuickOrb` / `PiQuickPanels`）共存：正常态下这里**不** stopPropagation，
 * 大家各关各的那一层，重复关同一层是幂等的；只有捕获态才拦。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { quickOrbHomePoint } from './PiQuickOrb';
import { bindingFromEvent, findMatchingAction, isEditableElement } from '../lib/shortcuts';
import { usePlayer } from '../state/player';
import { useShortcuts } from '../state/shortcuts';
import { useUi } from '../state/ui';

/** 点按一下的步长。 */
const SEEK_STEP_MS = 5_000;
const VOLUME_STEP = 0.05;

/** 长按期间的匀速速率（用户 m00001 第 5 条：长按是线性移动，不是一格一格跳）。 */
const SEEK_MS_PER_SECOND = 15_000; // 真实 1 秒走 15 秒音频
const VOLUME_PER_SECOND = 0.6; // 0 → 1 大约 1.7 秒

type HoldAction = 'volumeUp' | 'volumeDown' | 'seekBackward' | 'seekForward';

interface Hold {
  /** 上一帧的时间戳，用来算这一帧走了多久。 */
  lastMs: number;
  /**
   * 按住期间**自己累计**的 seek 目标（毫秒；`null` = 还没定锚，用 store 当前值起算）。
   *
   * **用户第 6 轮第 3 条**（「底部进度条可以连续按左右快捷键调节进度」）：原来每帧都读
   * `usePlayer.getState().positionMs` 再加一帧的增量。`<audio>` 的 `timeupdate` 也会往同一个字段
   * 回写**元素真实时间**，于是按住时这一帧的基准可能是「上一次 seek 之前的旧值」——
   * 增量被反复吃掉，按住的推进就变成一顿一顿（快慢取决于 timeupdate 什么时候到）。
   * 现在按住期间不再看 store：以按下那一刻的位置为锚，自己累加，每帧只把结果写出去。
   */
  targetMs: number | null;
}

function isHoldActionOf(action: string): action is HoldAction {
  return (
    action === 'volumeUp' ||
    action === 'volumeDown' ||
    action === 'seekBackward' ||
    action === 'seekForward'
  );
}

/** 按当前时长夹住进度：越界不写盘（`usePlayer.seek` 自己只夹下界）。 */
function seekBy(deltaMs: number): void {
  const player = usePlayer.getState();
  if (player.durationMs <= 0) return;
  const target = Math.min(player.durationMs, Math.max(0, player.positionMs + deltaMs));
  player.seek(target);
}

/** 点一下的那一小步：立刻给一次反馈，接着才是 rAF 的连续移动。 */
function nudge(action: HoldAction): void {
  const player = usePlayer.getState();
  switch (action) {
    case 'volumeUp':
      player.setVolume(player.volume + VOLUME_STEP);
      return;
    case 'volumeDown':
      player.setVolume(player.volume - VOLUME_STEP);
      return;
    case 'seekForward':
      seekBy(SEEK_STEP_MS);
      return;
    case 'seekBackward':
      seekBy(-SEEK_STEP_MS);
      return;
  }
}

/** 匀速推进 `deltaMs` 毫秒真实时间对应的那一段。 */
function advance(action: HoldAction, deltaMs: number, hold: Hold): void {
  const player = usePlayer.getState();
  if (action === 'volumeUp' || action === 'volumeDown') {
    const direction = action === 'volumeUp' ? 1 : -1;
    player.setVolume(player.volume + (direction * VOLUME_PER_SECOND * deltaMs) / 1000);
    return;
  }
  if (player.durationMs <= 0) return;
  const direction = action === 'seekForward' ? 1 : -1;
  // 见 `Hold.targetMs`：按住期间自己累计，不再逐帧读 store（那个字段会被 timeupdate 抢着写）。
  const base = hold.targetMs ?? player.positionMs;
  const next = Math.min(
    player.durationMs,
    Math.max(0, base + (direction * SEEK_MS_PER_SECOND * deltaMs) / 1000),
  );
  hold.targetMs = next;
  player.seek(next);
}

/**
 * Esc 的「退出当前页」：从最上面一层开始关，关掉一层就停；一层都没有才回播放页。
 * 顺序按用户 m00001 第 5 条：设置框 → 导航抽屉 → 歌单 / 歌曲浮层 → PI 卡片 → 搜索 → 播放页。
 */
function exitCurrentLayer(): void {
  const ui = useUi.getState();
  if (ui.settingsOpen) {
    ui.closeSettings();
    return;
  }
  if (ui.navOpen) {
    ui.closeNav();
    return;
  }
  if (ui.openedPlaylist !== null) {
    ui.closePlaylist();
    return;
  }
  if (ui.openedSongs !== null) {
    ui.closeSongs();
    return;
  }
  if (ui.quickPanel !== 'none') {
    ui.setQuickPanel('none');
    return;
  }
  if (ui.quickPos !== null) {
    ui.setQuickPos(null);
    return;
  }
  if (ui.searchOpen) {
    ui.closeSearch();
    return;
  }
  ui.navigate('home');
}

/**
 * Tab / Ctrl+A：把 PI 圆键的某张卡片开出来。
 *
 * 卡片只挂在播放页的 `QuickDock` 上（别的页 `HomePage` 被卸载，键和卡片都不存在），
 * 所以先 `navigate('home')`；`navigate` 会把 `quickPos` 清成 null，接着再把键召回来。
 * `summonQuick` 会把 `quickPanel` 重置成 `'none'`，所以顺序必须是「先 summon 再 setQuickPanel」。
 */
function toggleQuickPanel(target: 'collections' | 'settings'): void {
  const ui = useUi.getState();
  if (ui.quickPanel === target) {
    ui.setQuickPanel('none');
    return;
  }
  if (ui.nav !== 'home') ui.navigate('home');
  // 用户 m00736 第 5 条：快捷键召唤「歌单选择卡」时**不要连带出现圆球**——卡片挂在
  // `quickPos` 上（那是它的锚点），所以球照样摆出来、只是藏起来（`hideOrb`）。
  // Ctrl+A 的快捷设置卡保持现状（用户只提了歌单页）。
  const hideOrb = target === 'collections';
  if (useUi.getState().quickPos === null) {
    useUi.getState().summonQuick(quickOrbHomePoint(), null, hideOrb);
  } else if (hideOrb) {
    // 球已经在台上（比如上一次点击留下的）：也要把它收掉，只留卡片。
    useUi.getState().setQuickOrbHidden(true);
  }
  useUi.getState().setQuickPanel(target);
}

/** Ctrl+S：打开详细设置框。与快捷设置卡里那颗「详细设置」按钮同款，先把自己的卡片收干净。 */
function openDetailedSettings(): void {
  const ui = useUi.getState();
  if (ui.quickPanel !== 'none' || ui.quickPos !== null) {
    ui.setQuickPanel('none');
    ui.setQuickPos(null);
  }
  useUi.getState().openSettings();
}

export function ShortcutLayer(): ReactNode {
  /** 当前按住的动作 → 上一帧时间戳。 */
  const holdsRef = useRef(new Map<HoldAction, Hold>());
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const holds = holdsRef.current;

    const frame = (nowMs: number): void => {
      frameRef.current = null;
      holds.forEach((hold, action) => {
        const deltaMs = Math.max(0, nowMs - hold.lastMs);
        hold.lastMs = nowMs;
        advance(action, deltaMs, hold);
      });
      if (holds.size > 0) frameRef.current = window.requestAnimationFrame(frame);
    };

    const startHold = (action: HoldAction): void => {
      if (holds.has(action)) return;
      holds.set(action, { lastMs: performance.now(), targetMs: null });
      if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(frame);
    };

    const stopHold = (action: HoldAction): void => {
      holds.delete(action);
      if (holds.size === 0 && frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const stopAllHolds = (): void => {
      holds.clear();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      const shortcuts = useShortcuts.getState();

      // ① 捕获态：这一下（以及后面每一个键）都归捕获用，别让设置框 / 抽屉的 Esc 抢走。
      if (shortcuts.capturing !== null) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (event.key === 'Escape') {
          shortcuts.cancelCapture();
          return;
        }
        const binding = bindingFromEvent(event);
        // 纯修饰键按下了：binding 为 null，什么都不做，继续等真正的键。
        if (binding !== null) shortcuts.setBinding(shortcuts.capturing, binding);
        return;
      }

      // ② 焦点在输入框 / 文本域 / 下拉 / contenteditable：除了 Esc（先让它失焦）一律不抢。
      //
      // **用户第 6 轮第 3 条**（原话：「底部进度条可以连续按左右快捷键调节进度」）：**底部进度条**
      // （`input[type=range][data-home-progress]`）例外 —— 它就是进度控件，`input` 判定原来把它
      // 一并让给浏览器原生行为，而原生在滑杆上是「按一次步进 `step=100`」，按住也只是跟系统重复速率
      // 一格一格挪，读起来不是连续调进度。这里放行之后，方向键照旧走下面的全局动作
      //（点一下 5s + 按住 15 倍速的 rAF 匀速推进），并且 `preventDefault` 会把原生的步进吃掉。
      // 设置页那些滑杆 / 真正的输入框不在例外里，本机原生行为一字不动。
      const target = event.target;
      const onProgressBar =
        target instanceof HTMLInputElement &&
        target.type === 'range' &&
        target.dataset.homeProgress !== undefined;
      if (!onProgressBar && target instanceof Element && isEditableElement(target)) {
        if (event.key === 'Escape') {
          if (target instanceof HTMLElement) target.blur();
          event.preventDefault();
        }
        return;
      }

      const action = findMatchingAction(shortcuts.bindings, event);
      if (action === null) return;

      // 命中的一律拦掉浏览器默认行为：Tab 不跳焦点、空格不滚页 / 不点按钮、Ctrl+A 不全选。
      event.preventDefault();
      // 长按的连续移动由上面的 rAF 负责，键盘自己的 repeat 事件只用来拦默认行为。
      if (event.repeat) return;

      switch (action) {
        case 'exit':
          exitCurrentLayer();
          return;
        case 'collections':
          toggleQuickPanel('collections');
          return;
        case 'quickSettings':
          toggleQuickPanel('settings');
          return;
        case 'openSettings':
          openDetailedSettings();
          return;
        case 'togglePlay':
          void usePlayer.getState().toggle();
          return;
        default:
          break;
      }

      if (isHoldActionOf(action)) {
        nudge(action);
        startHold(action);
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (holds.size === 0) return;
      if (useShortcuts.getState().capturing !== null) return;
      const action = findMatchingAction(useShortcuts.getState().bindings, event);
      if (action !== null && isHoldActionOf(action)) stopHold(action);
    };

    // 切出去 / 最小化时不会再有 keyup：把按住的动作停掉，免得回来还在走。
    const onBlur = (): void => stopAllHolds();
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') stopAllHolds();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      stopAllHolds();
    };
  }, []);

  // 只负责监听，不画东西。
  return null;
}
