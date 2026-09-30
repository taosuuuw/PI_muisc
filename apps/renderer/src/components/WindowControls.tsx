import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CH, invoke } from '../bridge';
import { useUi } from '../state/ui';

/**
 * 窗口控制浮层（第十一轮第 5 条，用户 m03279：「app 窗口顶部的标题栏直接取消，
 * 鼠标接近右上方式，向下浮出三个按键」）。
 *
 * 标题栏整条删掉之后，它原来承担的三件事都搬到这里，但默认全部藏在窗口外，
 * 只有指针贴到窗口外沿的薄带上才向下滑出来：
 * ① 右上：最小化 / 最大化（最大化后变「还原」）/ 关闭 三键 → `<WindowControls />` 右面板；
 * ② 左上：**整块删掉了**（用户 m04183 第 1 条：「歌曲播放页左上角如图1所示部件删去，并且
 *    点击图标出现的菜单也删去」——图1 就是这块「PI 方块 + PI + v0.1.0 · win32/x64」，
 *    点它开出来的菜单就是导航抽屉）。左上那块面板与它的两张触发热区一并不再渲染；
 *    抽屉入口只剩下面那个 1×1、`opacity: 0`、`pointer-events: none` 的隐藏抓手
 *    `<button data-nav-toggle>`：冒烟 `openNav()`（`apps/desktop/src/main/index.ts:1023`）与
 *    它下游三十余处 `clickNav()` 全靠这个选择器，而界面上没有任何东西能点到它。
 * ③ 拖拽：无边框窗口必须自己给拖拽区 → 最上沿那条 32px 的 `__dragstrip`。
 *
 * 触发热区是「贴边的薄带」而不是一个 140×120 的整块透明矩形：整块矩形一旦吃指针，
 * 它盖住的内容就再也点不动——歌单页 `.pi-detail__bar` 右上角那枚「添加歌曲」键正好
 * 落在这片区域里（浮层 z-index 比它高）。薄带只吃窗口最外沿那条本来就被 drag 条占着、
 * 点不到的地方，沿着上沿/右沿滑到角落照样能触发。
 */

/** 收起前的宽限时间：指针在热区↔面板之间挪动时不会闪一下（与 CSS 的 0.2s 过渡配套）。 */
const HIDE_DELAY_MS = 240;

/**
 * 「靠近就出现」的接近区（**用户 m01402 第 4 条**：「右上角三个图标不要悬停在图标位置再出现，
 * 而是靠近就出现」）——从右上角往左、往下各量这么多像素，指针一进这块就浮出三键。
 *
 * 只改**判定**，不改指针：贴边的薄带（`__hot--top-right` / `__hot--side-right`）与 DOM 结构
 * 一个都没动。上面 :16-19 那条告诫仍然成立——大块 `pointer-events: auto` 会挡住歌单页
 * `.pi-detail__bar` 右上角那枚「添加歌曲」键，所以接近区挂在 window 的 `pointermove` 上算距离，
 * 而不是铺一块透明热区盒子。
 */
const NEAR_RIGHT_W = 132;
const NEAR_RIGHT_H = 96;

type Corner = 'left' | 'right';

function MinimizeGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M2.2 6h7.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeGlyph({ restored }: { restored: boolean }): ReactNode {
  if (restored) {
    // 还原：前后两个错开的方框
    return (
      <svg viewBox="0 0 12 12" width="15" height="15" aria-hidden="true" focusable="false">
        <rect x="2.2" y="3.9" width="5.9" height="5.9" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M4.5 3.9v-.7a1.3 1.3 0 0 1 1.3-1.3h2.7a1.3 1.3 0 0 1 1.3 1.3v2.7a1.3 1.3 0 0 1-1.3 1.3h-.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 12 12" width="15" height="15" aria-hidden="true" focusable="false">
      <rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function CloseGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function WindowControls(): ReactNode {
  const info = useQuery({
    queryKey: ['appInfo'],
    queryFn: () => invoke(CH.appInfo),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const toggleNav = useUi((state) => state.toggleNav);
  const navOpen = useUi((state) => state.navOpen);

  // 自绘三键只在无边框窗口（Windows）上出现；macOS 是系统红绿灯、Linux 保留系统边框，
  // 再画一套就重了。appInfo 还没回来时先用 UA 顶一下，避免首帧闪一下。
  const isWindows = info.data ? info.data.platform === 'win32' : navigator.userAgent.includes('Windows');

  const [revealed, setRevealed] = useState<Corner | null>(null);
  const [maximized, setMaximized] = useState(false);
  const hideTimer = useRef<number | null>(null);

  // 抽屉打开时浮层必须让位：导航抽屉（z-index 21）压不过浮层（56），热区不收起来
  // 就会挡住抽屉顶部与它的遮罩。
  useEffect(() => {
    if (!navOpen) return;
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setRevealed(null);
  }, [navOpen]);

  // 卸载时清掉挂起的收起定时器，避免对已卸载组件 setState。
  useEffect(
    () => () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  // 「最大化 → 还原」的图标状态。没有新增 IPC 事件，就用窗口尺寸与屏幕可用区比对：
  // 贴满时视为最大化。多显示器 / 任务栏在侧边时这个启发式会看错，纯视觉、无功能影响。
  useEffect(() => {
    const sync = (): void => {
      setMaximized(
        Math.abs(window.screen.availWidth - window.outerWidth) <= 24 &&
          Math.abs(window.screen.availHeight - window.outerHeight) <= 24,
      );
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  const cancelHide = (): void => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const show = (corner: Corner): void => {
    if (navOpen) return;
    if (corner === 'right' && !isWindows) return;
    cancelHide();
    if (corner === 'right') {
      // 浮出前再对一次最大化状态，免得图标停在过期的样子上。
      setMaximized(
        Math.abs(window.screen.availWidth - window.outerWidth) <= 24 &&
          Math.abs(window.screen.availHeight - window.outerHeight) <= 24,
      );
    }
    setRevealed(corner);
  };

  const scheduleHide = (): void => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setRevealed(null);
    }, HIDE_DELAY_MS);
  };

  /** 给下面那条 pointermove 监听读「现在露着哪一角」用，免得为它把 effect 反复重挂。 */
  const revealedRef = useRef<Corner | null>(null);
  useEffect(() => {
    revealedRef.current = revealed;
  }, [revealed]);

  /*
   * **用户 m01402 第 4 条**：指针「接近」右上角就浮出三键（原来只有贴到 14px 薄带上才浮出，
   * 得先瞄准图标位置）。只改判定：出了接近区就按老规矩 `scheduleHide()`（240ms 宽限，指针在
   * 面板↔热区之间挪动不会闪）；`revealedRef` 挡住「左下角正露着」的情况，不会被这条误收。
   * 抽屉打开时 `show` 自己会让位（`if (navOpen) return`），这里干脆连监听都不挂。
   */
  useEffect(() => {
    if (!isWindows || navOpen) return undefined;
    const onMove = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return;
      if (window.innerWidth - event.clientX <= NEAR_RIGHT_W && event.clientY <= NEAR_RIGHT_H) {
        show('right');
        return;
      }
      if (revealedRef.current === 'right') scheduleHide();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
    // `show` / `scheduleHide` 每次渲染都是新函数，但只读 `navOpen` / `isWindows` 与 ref，
    // 这两个都在依赖里 ⇒ 挂上来的那份闭包始终是最新的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWindows, navOpen]);

  const onMinimize = (): void => {
    void invoke(CH.windowMinimize);
  };
  const onToggleMaximize = (): void => {
    // 乐观翻一下图标，真正的状态由窗口 resize 事件纠回来。
    setMaximized((value) => !value);
    void invoke(CH.windowToggleMaximize);
  };
  const onClose = (): void => {
    void invoke(CH.windowClose);
  };

  const rightVisible = revealed === 'right';
  // 三键在 DOM 里恒在（冒烟的 querySelector('[data-window-btn=...]') 要拿到），
  // 非 Windows 只是永远不会被浮出。
  const armed = navOpen ? 'false' : 'true';

  return (
    <>
      {/* 无边框窗口的拖拽区：最上沿一条 7px 薄带。左右各让开 160px，
          不与角落热区/浮层重叠——重叠会让「这里到底算拖拽还是算页面」变得含糊。 */}
      <div className="pi-windowcontrols__dragstrip" aria-hidden="true" />

      {/* 触发热区：贴着窗口外沿的薄带，pointerenter 就浮出（不在 window 上挂全局 mousemove）。
          左上那两张（`__hot--top-left` / `__hot--side-left`）随品牌面板一起删了 —— 见文件头 ②。 */}
      {isWindows ? (
        <>
          <div
            className="pi-windowcontrols__hot pi-windowcontrols__hot--top-right"
            data-armed={armed}
            aria-hidden="true"
            onPointerEnter={() => show('right')}
            onPointerLeave={scheduleHide}
          />
          <div
            className="pi-windowcontrols__hot pi-windowcontrols__hot--side-right"
            data-armed={armed}
            aria-hidden="true"
            onPointerEnter={() => show('right')}
            onPointerLeave={scheduleHide}
          />
        </>
      ) : null}

      {/* 用户 m04183 第 1 条：左上「PI 方块 + PI + v0.1.0 · win32/x64」那块部件与它点开的
          导航抽屉都不要了，这里只留一个**看不见也点不到**的抽屉抓手 —— 冒烟
          `openNav()` 靠 `[data-nav-toggle]` 开抽屉，这个选择器不能删。 */}
      <button
        type="button"
        className="pi-windowcontrols__navhook"
        data-nav-toggle
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => toggleNav()}
      />

      {/* 右上：窗口三键。`data-window-controls` / `data-visible` 是冒烟探针的抓手。 */}
      <div
        className="pi-windowcontrols pi-windowcontrols--right"
        data-window-controls
        data-visible={rightVisible ? 'true' : 'false'}
        onPointerEnter={() => show('right')}
        onPointerLeave={scheduleHide}
      >
        <button
          type="button"
          className="pi-windowcontrols__btn"
          data-window-btn="minimize"
          title="最小化"
          aria-label="最小化"
          onClick={onMinimize}
        >
          <MinimizeGlyph />
        </button>
        <button
          type="button"
          className="pi-windowcontrols__btn"
          data-window-btn="maximize"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          onClick={onToggleMaximize}
        >
          <MaximizeGlyph restored={maximized} />
        </button>
        <button
          type="button"
          className="pi-windowcontrols__btn pi-windowcontrols__btn--close"
          data-window-btn="close"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <CloseGlyph />
        </button>
      </div>
    </>
  );
}
