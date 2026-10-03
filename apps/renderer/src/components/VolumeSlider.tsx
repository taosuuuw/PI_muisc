import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

/**
 * 竖向音量条（用户第二十二轮第 3 条：「音量条不能用鼠标线性调节，修正一下」）。
 *
 * ## 为什么不用原生 `<input type="range">`
 *
 * 原来那根条是 `<input type=range>` 加 `transform: rotate(-90deg)` 转出来的。两件事都坏：
 *
 * ① **落点 → 值不是线性的**。浏览器按「滑块**中心**的可移动区间」映射指针位置，而我们的滑块
 *    （`--pi-vol-thumb` 14px）比轨道（59px）粗得多，两端各有一截死区。实测（125% 缩放下
 *    按弹层高度的 0 / 25 / 50 / 75 / 100% 处点下去）：`0.00, 0.00, 0.35, 0.60, 0.87` ——
 *    四分之一处完全没反应、顶到最上面也只有 0.87，正是用户说的「调不到底 / 不成线性」。
 * ② **合成输入驱动不了它的「按住拖」**：Chromium 的原生滑块只认可信事件，Electron 的
 *    `sendInputEvent` 合成的 `mouseMove` 不带按键掩码，于是自动化里永远量不出拖动效果。
 *
 * 自己接指针这两条一起解决：值 = 「指针在**视觉盒**里的高度比例」（`getBoundingClientRect`
 * 拿到的就是转过之后的盒子，所以映射与旋转无关、天然线性、两端都到得了），
 * 拖动期间用 `setPointerCapture` 锁住指针 —— 滑到条外面也继续跟手。
 *
 * ## 与旧实现的兼容面（冒烟抓手都在）
 *
 * 还是同一个 `.pi-home__volrange` 节点、还是 `width: 59px / height: 16px` 的布局盒
 * （第十一轮那条「滑杆布局=59x16」的断言照旧成立），还是把 `--pi-volume`（0–1）写在根节点上
 * （像素探针按它数「已播量」），`data-silent` 也还挂在根节点上（静音 / 音量为 0 时滑块不涂色）。
 * 轨道、已播量、滑块从伪元素换成三个真元素（`__track` / `__fill` / `__thumb`）。
 */
export interface VolumeSliderProps {
  /** 当前音量 0–1（静音时调用方传 0 的显示值，但真值仍由 store 记着）。 */
  value: number;
  /** 静音，或音量真的是 0：滑块不涂色（用户第十九轮第 2 条 + 第二十轮第 1 条）。 */
  silent: boolean;
  /** 值变化（0–1）。 */
  onChange: (next: number) => void;
  /** 拖拽开始 / 结束：调用方用它把弹层锁在浮出态（`data-dragging`）。 */
  onDraggingChange: (dragging: boolean) => void;
}

/** 键盘步长：一下 5%（`Home` / `End` 直接到底 / 到顶）。 */
const STEP = 0.05;

export function VolumeSlider({
  value,
  silent,
  onChange,
  onDraggingChange,
}: VolumeSliderProps): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * 正在拖的那个 pointerId。
   *
   * 为什么不用 `hasPointerCapture` 当开关：合成输入（Electron 的 `sendInputEvent`、自动化测试）
   * 不携带按键掩码，浏览器会在指针一离开元素时就把隐式捕获丢掉——于是「按住拖」在中途变成
   * 「没在拖」，值不再跟手。自己记 id 更稳：真机鼠标有捕获（滑出窄条也收得到 move），
   * 合成输入没有捕获（但指针在条内时依然收得到 move），两种都能跟手。
   */
  const activeId = useRef<number | null>(null);
  /**
   * 正在拖（组件自己的状态，拖完通知父层把弹层锁放掉）。
   *
   * 收尾挂在 **window** 上而不是只看元素自己的 `pointerup`：真机鼠标拖到条外再抬手时，
   * 事件目标是别的元素，元素自己的 handler 收不到；合成输入（没有指针捕获）也一样。
   * 所以只要进入拖动状态就挂一对 window 级监听，任何地方的抬手都能把锁解开——
   * 否则弹层会一直赖在浮出态（那正是「拖完不收」的观感）。
   */
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    onDraggingChange(dragging);
  }, [dragging, onDraggingChange]);

  useEffect(() => {
    if (!dragging) return undefined;
    const stop = (): void => {
      activeId.current = null;
      setDragging(false);
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragging]);

  /**
   * 指针高度 → 值：0 在**底端**（视觉上转过 90°，盒子的底面就是轨道起点）。
   *
   * **底部死区（用户第二十三轮第 1 条）**：滑块（`--pi-vol-thumb`，14px ≈ 轨道的 24%）比轨道
   * 粗得多，所以「拖到底」只要手指落在离底端几像素的地方，读出来就是 3~8% —— 那一截滑块照样
   * 涂着主色，看上去就是「明明拖到底了还留一截」的残余（用户给的图 1 正是这一截）。
   * 底部 4% 直接归零，用户就一定摸得到底；顶端同理留 1%，免得贴着顶边反而到不了 100%。
   */
  const valueAt = (clientY: number): number => {
    const box = rootRef.current?.getBoundingClientRect();
    if (box === undefined || box.height <= 0) return value;
    const ratio = (box.bottom - clientY) / box.height;
    if (ratio <= 0.04) return 0;
    if (ratio >= 0.99) return 1;
    return ratio;
  };

  const applyPointer = (event: PointerEvent<HTMLDivElement>): void => {
    onChange(valueAt(event.clientY));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(Math.min(1, value + STEP));
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft')
      onChange(Math.max(0, value - STEP));
    else if (event.key === 'Home') onChange(0);
    else if (event.key === 'End') onChange(1);
    else return;
    event.preventDefault();
  };

  const percent = Math.round((silent ? 0 : value) * 100);

  return (
    <div
      ref={rootRef}
      className="pi-home__volrange"
      data-home-volrange="true"
      data-silent={silent}
      style={{ '--pi-volume': (silent ? 0 : value).toFixed(4) } as CSSProperties}
      role="slider"
      tabIndex={0}
      aria-label="音量"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
      onPointerDown={(event) => {
        activeId.current = event.pointerId;
        try {
          // 锁住指针：真机鼠标滑出这条 16px 宽的窄条也继续跟手（用户第二十二轮第 3 条）。
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* 合成输入不支持捕获：忽略即可，值仍然按 pointermove 算。 */
        }
        setDragging(true);
        applyPointer(event);
      }}
      onPointerMove={(event) => {
        // 只在「这一颗指针正在拖」时更新；`activeId` 为空时纯 hover 不动值。
        if (activeId.current !== null && activeId.current === event.pointerId) applyPointer(event);
      }}
      onPointerUp={(event) => {
        if (activeId.current === event.pointerId) activeId.current = null;
        try {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        } catch {
          /* 同上：捕获可能早就没了 */
        }
        setDragging(false);
      }}
      onPointerCancel={(event) => {
        if (activeId.current === event.pointerId) activeId.current = null;
        setDragging(false);
      }}
      /*
       * 捕获丢失**不等于**拖拽结束（合成输入会丢捕获），所以这里什么都不做：
       * 收尾只认 pointerup / pointercancel，免得拖到一半弹层就把自己收回去。
       */
      onKeyDown={onKeyDown}
    >
      <span className="pi-home__volrange-track" aria-hidden="true" />
      <span className="pi-home__volrange-fill" aria-hidden="true" />
    </div>
  );
}
