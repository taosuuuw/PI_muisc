import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUi, type UiStyle } from '../state/ui';
import '../styles/style-toast.css';

/**
 * 「已切换 ⨯⨯ 风格」的顶框提示（用户 m02213 第 5 条 → **用户 m04183 第 2 条**）。
 *
 * 原文（m02213 第 5 条）：「圆球左划切换风格后，从顶框下滑一个提示『已切换xx风格』，显示 2s，
 * 就上升到顶框内消失。」
 * 本轮（**用户 m04183 第 2 条**）：「切换风格的提示改成灵动岛通知形式」——只换**形态**：
 * 原来那块贴着窗口顶边的深色胶囊，改成**漂浮在顶部中央的灵动岛药丸**（不贴边、四角全圆、
 * 高 32px、恒定近黑玻璃 + 一道内高光 + 柔和落影），进出场改成「小核展开 / 收拢上浮」。
 * 长相与关键帧全在 `styles/style-toast.css`，本组件一行逻辑没动。
 *
 * 做法：只**盯 `uiStyle` 的变化**，不掺和「谁改的」——圆球左划（`HomePage` 的 `toggleUiStyle`）、
 * 设置页里那排排版按钮，以及将来任何新的入口，只要排版真的换了就报一声。首帧（挂载时读到的
 * 那个值）不算切换，免得一进 app 就弹一条。
 *
 * 时序：出现 → `SHOW_MS` 后打上 `data-style-toast-leaving='true'`（`style-toast.css` 换成
 * 收拢上浮的关键帧 `pi-style-toast-out`）→ 再过 `EXIT_MS` 卸载。中途再切一次就重开一轮
 * （旧定时器在 effect 清理里撤销）。
 *
 * 可见性的抓手（冒烟用）：`data-style-toast`（存在即有提示）、`data-style-toast-style`
 * （提示的是哪一套：`plain` / `avant`）、`data-style-toast-leaving`（`true` = 正在收拢消失）。
 */
const STYLE_LABEL: Record<UiStyle, string> = { plain: '平凡', avant: '先锋' };

/**
 * 用户原话「显示 2s」；出场动画时长与 `style-toast.css` 的 `pi-style-toast-out` 对齐。
 *
 * 用户 m04183 第 2 条只改形态，**这两个数一个字都不动**：冒烟探针在
 * `apps/desktop/src/main/index.ts:8160`（2.26s 那一刻）要求「已卸载或 `leaving='true'`」，
 * 8161 行（2.68s）要求「已卸载」——`EXIT_MS` 一旦不等于 `pi-style-toast-out` 的时长就破约。
 */
const SHOW_MS = 2000;
const EXIT_MS = 240;

export function StyleToast(): ReactNode {
  const uiStyle = useUi((s) => s.uiStyle);
  /** 正在提示哪一套；`null` = 现在没有提示（整块不渲染）。 */
  const [shown, setShown] = useState<UiStyle | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** 挂载时读到的那套排版不算「切换」，跳过第一轮。 */
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setShown(uiStyle);
    setLeaving(false);
    const leaveTimer = window.setTimeout(() => setLeaving(true), SHOW_MS);
    const doneTimer = window.setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, SHOW_MS + EXIT_MS);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(doneTimer);
    };
  }, [uiStyle]);

  if (shown === null) return null;

  return (
    <div
      className="pi-style-toast"
      data-style-toast="true"
      data-style-toast-style={shown}
      data-style-toast-leaving={leaving ? 'true' : 'false'}
      role="status"
      aria-live="polite"
    >
      <span className="pi-style-toast__text">
        <span className="pi-style-toast__dot" aria-hidden="true" />
        已切换{STYLE_LABEL[shown]}风格
      </span>
    </div>
  );
}
