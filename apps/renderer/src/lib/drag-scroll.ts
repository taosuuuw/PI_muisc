import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/**
 * 鼠标左右拖拽滚动（用户 m06982 第 7 条）。
 *
 * 为什么不用滑块：一行封面卡是「一张张孤立的卡片」，滚动条既占地方又要瞄准；
 * 直接按住卡片横向拖，更接近「翻卡片」的直觉。
 *
 * 三个要点：
 * - 用 pointer 事件 + `setPointerCapture`：鼠标拖到元素外面也不会丢事件；
 * - 横向位移超过 `DRAG_THRESHOLD` 才算「拖」，否则原样放行，点卡片照常播歌；
 * - 真的拖动过之后，紧跟的那次 click 由 `onClickCapture` 吃掉
 *   （和悬浮球那边「拖动转过角度就别当点击」是同一类坑）。
 */
const DRAG_THRESHOLD = 5;
/** 拖完没有后续 click 时，过期自动复位，免得吞掉下一次真正的点击。 */
const MOVE_FLAG_TTL = 400;

export interface DragScrollHandlers<T extends HTMLElement> {
  onPointerDown: (event: ReactPointerEvent<T>) => void;
  onPointerMove: (event: ReactPointerEvent<T>) => void;
  onPointerUp: (event: ReactPointerEvent<T>) => void;
  onPointerCancel: (event: ReactPointerEvent<T>) => void;
  onClickCapture: (event: ReactMouseEvent<T>) => void;
}

export interface DragScroll<T extends HTMLElement> {
  ref: RefObject<T | null>;
  /** 正在拖：交给 CSS 换 grabbing 光标、关掉子元素的 hover 位移。 */
  dragging: boolean;
  handlers: DragScrollHandlers<T>;
}

export function useDragScroll<T extends HTMLElement>(): DragScroll<T> {
  const ref = useRef<T | null>(null);
  const origin = useRef<{ x: number; scroll: number } | null>(null);
  const moved = useRef(false);
  const timer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  function finish(): void {
    origin.current = null;
    setDragging(false);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      moved.current = false;
      timer.current = null;
    }, MOVE_FLAG_TTL);
  }

  const handlers: DragScrollHandlers<T> = {
    onPointerDown: (event) => {
      // 只接左键；右键留给系统菜单。
      if (event.button !== 0) return;
      const element = ref.current;
      // 没得滚（卡片还没超过一行）就别接管指针，否则会白吃一次点击。
      if (element === null || element.scrollWidth <= element.clientWidth) return;
      origin.current = { x: event.clientX, scroll: element.scrollLeft };
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      moved.current = false;
      element.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event) => {
      const element = ref.current;
      const from = origin.current;
      if (element === null || from === null) return;
      const delta = event.clientX - from.x;
      if (!moved.current) {
        if (Math.abs(delta) < DRAG_THRESHOLD) return;
        moved.current = true;
        setDragging(true);
      }
      // 鼠标往左拖 = 看右边的卡片，所以滚动方向与位移相反。
      element.scrollLeft = from.scroll - delta;
      event.preventDefault();
    },
    onPointerUp: (event) => {
      const element = ref.current;
      if (element !== null && element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      if (origin.current !== null) finish();
    },
    onPointerCancel: (event) => {
      const element = ref.current;
      if (element !== null && element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      if (origin.current !== null) finish();
    },
    onClickCapture: (event) => {
      if (!moved.current) return;
      moved.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  return { ref, dragging, handlers };
}
