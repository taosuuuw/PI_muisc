import { useEffect, useRef, useState } from 'react';

/**
 * 「用户已经多久没操作了」（用户第八轮第 1 条）。
 *
 * 播放页左上角的名片、底部的进度条、以及唯一常驻的悬浮球，没人动的时候要自动隐藏；
 * 藏起来之后**只有把指针移到那一件上**才把它单独叫回来（那是 CSS 的 `:hover` 干的，
 * 见 `global.css` 的 `[data-idle]` 规则），所以这里刻意**不监听 pointermove**：
 * 鼠标在页面中间划来划去不该把三件东西一起唤醒。
 * 只有「真的做了点什么」——按下、滚轮、按键——才算一次操作，并重新计时。
 *
 * `document.documentElement.dataset.piIdle === 'off'` 时整套机制停用：冒烟脚本要拍
 * 「三件东西都在」的静置画面，否则等 3 秒截图就拍到全隐藏的样子了（见 `apps/desktop/src/main`）。
 */
const IDLE_MS = 3200;
const WAKE_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

/** 冒烟/调试开关：`document.documentElement.dataset.piIdle = 'off'` 就不再自动隐藏。 */
function idleDisabled(): boolean {
  return document.documentElement.dataset['piIdle'] === 'off';
}

export function useIdle(timeoutMs: number = IDLE_MS): boolean {
  const [idle, setIdle] = useState(false);
  /** 用 ref 兜一层：滚轮一秒能来几十次，已经醒了就别再 setState（每次都是整棵树重渲染）。 */
  const idleRef = useRef(false);

  useEffect(() => {
    let timer = 0;
    const arm = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (idleDisabled()) return;
        idleRef.current = true;
        setIdle(true);
      }, timeoutMs);
    };
    /**
     * 用户第九轮第 7 条：拖悬浮球时，已经藏起来的名片与进度条要**保持隐藏**。
     * 按住球本身就是一次 `pointerdown`，本来会把三件东西一起叫醒；所以「球内部按下」
     * （含展开后的环形按键、球上挂的队列浮层）不算一次操作，既不唤醒也不重新计时。
     */
    const fromOrb = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest('.pi-orb') !== null;

    const wake = (event: Event): void => {
      if (event.type === 'pointerdown' && fromOrb(event.target)) return;
      if (idleRef.current) {
        idleRef.current = false;
        setIdle(false);
      }
      arm();
    };

    arm();
    for (const type of WAKE_EVENTS) {
      window.addEventListener(type, wake, { passive: true, capture: true });
    }
    return () => {
      window.clearTimeout(timer);
      for (const type of WAKE_EVENTS) {
        window.removeEventListener(type, wake, true);
      }
    };
  }, [timeoutMs]);

  return idle;
}
