import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * 可拖动 + 靠近窗口边缘自动吸附。
 *
 * 用户需求（m04781 第 1、2 条）：dock 栏与悬浮球都要能拖，且「靠近页面边框就吸附」。
 * 两个组件的交互规则完全一样，所以逻辑只写一份，位置交给调用方存（zustand）。
 *
 * 几个刻意的取舍：
 * - 位置用**视口坐标的左上角**而不是 transform：吸附要跟窗口尺寸做比较，左上角最好算。
 * - 手势期间同时挂 `window` 上的 pointermove/up：只靠 React 元素上的监听，
 *   指针一旦划出元素（悬浮球只有 48px，稍微一拖就出去了）拖动就断，
 *   而 `setPointerCapture` 在真实窗口里未必失败、在自动化输入下却可能不生效——
 *   两路都用，重复调用是幂等的（位移按「起点 + 总位移」算，不是增量累加）。
 * - 位移小于 `tolerance` 不算拖动：悬浮球既是按钮又是拖动手柄，
 *   不区分的话每次点击都会顺手把它挪走几像素。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface DragSnapOptions {
  /** 受控位置；`null` 表示「用户还没拖过」，用 `defaultPos`。 */
  value: Point | null;
  defaultPos: (viewport: Viewport) => Point;
  /** 被拖元素尺寸（用来钳制边界与算吸附距离）。 */
  size: Size;
  onChange: (pos: Point) => void;
  /** 松手时离某条边小于它就吸附过去。 */
  snapDistance?: number;
  /** 吸附后与窗口边缘的间距。 */
  margin?: number;
  /** 小于这个位移（曼哈顿距离）不算拖动。 */
  tolerance?: number;
}

export interface DragSnapResult {
  pos: Point;
  dragging: boolean;
  /** 摊到被拖元素上即可（容器或手柄都行）。 */
  dragProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  };
  /** 读一次就清空：用来吞掉拖动结束后紧跟的那次 click。 */
  wasDragged: () => boolean;
}

interface Gesture {
  pointerId: number;
  pointerType: string;
  from: Point;
  origin: Point;
  moved: boolean;
}

/**
 * 同一个手势的判定。
 *
 * 正常情况下认 pointerId 就够了；但自动化输入（`sendInputEvent`）里同一串鼠标事件
 * 的 pointerId 不保证稳定，会出现「第一次 move 生效、后面全部对不上」的现象。
 * 鼠标在一个窗口里不可能有两个指针，所以 pointerType 都是 mouse 时按同一手势处理；
 * 触摸/笔仍然严格按 id 区分，多指不会互相串。
 */
function matchesPointer(active: Gesture, pointerId: number, pointerType: string): boolean {
  if (active.pointerId === pointerId) return true;
  return active.pointerType === 'mouse' && pointerType === 'mouse';
}

function clamp(value: number, min: number, max: number): number {
  // max < min（窗口比元素还小）时让 min 赢，元素至少贴住左上角。
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 把位置钳进视口，窗口缩小后元素不会跑到屏幕外。 */
export function clampToViewport(pos: Point, size: Size, viewport: Viewport, margin: number): Point {
  return {
    x: clamp(pos.x, margin, viewport.width - size.width - margin),
    y: clamp(pos.y, margin, viewport.height - size.height - margin),
  };
}

/** 贴住了哪条边（角落上会同时贴两条）。 */
export type EdgeSide = 'left' | 'right' | 'top' | 'bottom';

/**
 * 这个位置算不算「已经贴在某条边上」。
 *
 * 与吸附共用同一份判定：悬浮球要按它决定「自己现在是球还是贴边细条」，
 * 两处各写一遍就会出现「渲染成细条了、松手却没吸过去」这种对不上的状态。
 */
export function snappedEdges(
  pos: Point,
  size: Size,
  viewport: Viewport,
  snapDistance: number,
): { x: 'left' | 'right' | null; y: 'top' | 'bottom' | null } {
  const right = viewport.width - (pos.x + size.width);
  const bottom = viewport.height - (pos.y + size.height);
  return {
    x: Math.min(pos.x, right) < snapDistance ? (pos.x <= right ? 'left' : 'right') : null,
    y: Math.min(pos.y, bottom) < snapDistance ? (pos.y <= bottom ? 'top' : 'bottom') : null,
  };
}

/** 每条轴各自判断：贴近哪条边就贴上去，所以角落能同时吸两个方向。 */
function snapToEdges(
  pos: Point,
  size: Size,
  viewport: Viewport,
  margin: number,
  snapDistance: number,
): Point {
  const edges = snappedEdges(pos, size, viewport, snapDistance);
  return {
    x:
      edges.x === 'left'
        ? margin
        : edges.x === 'right'
          ? viewport.width - size.width - margin
          : pos.x,
    y:
      edges.y === 'top'
        ? margin
        : edges.y === 'bottom'
          ? viewport.height - size.height - margin
          : pos.y,
  };
}

/**
 * 视口尺寸进 state：窗口缩放时组件会重渲染，默认位置也跟着重算。
 *
 * 也导出给环形菜单用：菜单半径必须按当前可用空间收缩，否则球拖到角落时
 * 半圈按钮会伸到窗口外面点不到。
 */
export function useViewport(): Viewport {
  // 用 documentElement.clientWidth 而不是 innerWidth：fixed 定位的包含块是「布局视口」，
  // 有滚动条时 innerWidth 会把滚动条宽度算进去，元素会被推到滚动条底下。
  const read = (): Viewport => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  });
  const [viewport, setViewport] = useState<Viewport>(read);

  useEffect(() => {
    const update = (): void => setViewport(read());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return viewport;
}

export function useDragSnap(options: DragSnapOptions): DragSnapResult {
  const { value, defaultPos, size, onChange, snapDistance = 56, margin = 12, tolerance = 4 } = options;
  const viewport = useViewport();
  const [live, setLive] = useState<Point | null>(null);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const dragged = useRef(false);

  const pos = clampToViewport(live ?? value ?? defaultPos(viewport), size, viewport, margin);
  const posRef = useRef(pos);
  posRef.current = pos;

  // 窗口变小后把已保存的位置拉回可见区域（拖过一次才需要）。
  useEffect(() => {
    if (!value) return;
    const clamped = clampToViewport(value, size, viewport, margin);
    if (clamped.x !== value.x || clamped.y !== value.y) onChange(clamped);
  }, [value, size.width, size.height, viewport.width, viewport.height, margin, onChange]);

  const applyMove = (
    pointerId: number,
    pointerType: string,
    clientX: number,
    clientY: number,
  ): void => {
    const active = gesture.current;
    if (!active || !matchesPointer(active, pointerId, pointerType)) return;
    const dx = clientX - active.from.x;
    const dy = clientY - active.from.y;
    if (!active.moved && Math.abs(dx) + Math.abs(dy) < tolerance) return;
    active.moved = true;
    dragged.current = true;
    setLive(
      clampToViewport({ x: active.origin.x + dx, y: active.origin.y + dy }, size, viewport, margin),
    );
  };

  const detach = useCallback((): void => {
    const { move, up, cancel } = bus.current;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  }, []);

  const applyFinish = (
    pointerId: number,
    pointerType: string,
    clientX: number,
    clientY: number,
    commit: boolean,
  ): void => {
    const active = gesture.current;
    if (!active || !matchesPointer(active, pointerId, pointerType)) return;
    gesture.current = null;
    detach();
    setDragging(false);
    setLive(null);
    if (!commit || !active.moved) return;
    // 用事件坐标直接算终态，避免读到上一个渲染的 live。
    const released = clampToViewport(
      {
        x: active.origin.x + (clientX - active.from.x),
        y: active.origin.y + (clientY - active.from.y),
      },
      size,
      viewport,
      margin,
    );
    onChange(snapToEdges(released, size, viewport, margin, snapDistance));
  };

  // window 上的监听要能一直调到最后一次渲染的闭包（尺寸/视口/回调都可能变）。
  const api = useRef({ applyMove, applyFinish });
  api.current = { applyMove, applyFinish };
  const bus = useRef({
    move: (event: PointerEvent): void =>
      api.current.applyMove(event.pointerId, event.pointerType, event.clientX, event.clientY),
    up: (event: PointerEvent): void =>
      api.current.applyFinish(event.pointerId, event.pointerType, event.clientX, event.clientY, true),
    cancel: (event: PointerEvent): void =>
      api.current.applyFinish(event.pointerId, event.pointerType, event.clientX, event.clientY, false),
  });

  useEffect(() => detach, [detach]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || gesture.current) return;
      const target = event.target as HTMLElement;
      const fromHandle = target.closest('[data-drag-handle]') !== null;
      // 控件上的按下不拖；但「元素本身就是被拖对象」时例外（悬浮球既是按钮又是手柄）。
      const blocker = target.closest('button, input, textarea, select, a, label');
      if (!fromHandle && blocker !== null && blocker !== event.currentTarget) return;

      // 指针捕获失败不该让拖动整体失效（合成事件、多指抢占、元素被卸载都会抛）。
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* 有 window 兜底，没有捕获也能拖 */
      }

      gesture.current = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        from: { x: event.clientX, y: event.clientY },
        origin: posRef.current,
        moved: false,
      };
      dragged.current = false;
      setDragging(true);

      const { move, up, cancel } = bus.current;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    },
    [],
  );

  const wasDragged = useCallback(() => {
    const value = dragged.current;
    dragged.current = false;
    return value;
  }, []);

  return {
    pos,
    dragging,
    dragProps: {
      onPointerDown,
      onPointerMove: (event) =>
        applyMove(event.pointerId, event.pointerType, event.clientX, event.clientY),
      onPointerUp: (event) =>
        applyFinish(event.pointerId, event.pointerType, event.clientX, event.clientY, true),
      onPointerCancel: (event) =>
        applyFinish(event.pointerId, event.pointerType, event.clientX, event.clientY, false),
    },
    wasDragged,
  };
}
