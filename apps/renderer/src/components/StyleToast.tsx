import { useEffect, useRef, type ReactNode } from 'react';
import { ISLAND_STYLE_ID, useIsland } from '../state/island';
import { useUi, type UiStyle } from '../state/ui';

/**
 * 「已切换 ⨯⨯ 风格」的提示（用户 m02213 第 5 条 → 用户 m04183 第 2 条 → **本轮第 2 条**）。
 *
 * 原文（m02213 第 5 条）：「圆球左划切换风格后，从顶框下滑一个提示『已切换xx风格』，显示 2s，
 * 就上升到顶框内消失。」
 * 形态（m04183 第 2 条）：从贴边胶囊改成**浮动在顶部中央的灵动岛药丸**。
 * 本轮（用户第 2 条）：它不再自己画那颗药丸，而是**往共享的灵动岛通知栈里发一条通知**
 * （`state/island.ts`）——于是它可以与「少女祈祷中⭐」同时存在：新来的顶到前面当药丸，
 * 先来的缩成小球挂在旁边；它一消失，旁边那条自己从小球长回药丸。渲染全在 `DynamicIsland`。
 *
 * 做法：只**盯 `uiStyle` 的变化**，不掺和「谁改的」——圆球左划、设置页那排排版按钮，
 * 以及将来任何新入口，只要排版真的换了就报一声。首帧（挂载时读到的那个值）不算切换。
 *
 * 时序（**一个字都不能动**）：出现 → `SHOW_MS` 后标记 `leaving` → 再过 `EXIT_MS` 撤下。
 * `apps/desktop/src/main/index.ts` 的冒烟探针按 0.36s / 2.26s / 2.68s 三个时刻验它：
 * 2.26s 那一刻要么已经撤下、要么 `data-style-toast-leaving='true'`；2.68s 必须已经撤下。
 *
 * 抓手（冒烟用）：`data-style-toast`（存在即有提示）、`data-style-toast-style`
 * （提示的是哪一套：`plain` / `avant`）、`data-style-toast-leaving`（`true` = 正在收拢消失）。
 * 这三个属性现在由本组件塞进通知的 `data` 里、`DynamicIsland` 原样落到 DOM 上，位置没变。
 */
const STYLE_LABEL: Record<UiStyle, string> = { plain: '平凡', avant: '先锋' };

const SHOW_MS = 2000;
const EXIT_MS = 240;

export function StyleToast(): ReactNode {
  const uiStyle = useUi((s) => s.uiStyle);
  const publish = useIsland((s) => s.publish);
  const dismiss = useIsland((s) => s.dismiss);
  /** 挂载时读到的那套排版不算「切换」，跳过第一轮。 */
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const notice = (leaving: boolean) => ({
      id: ISLAND_STYLE_ID,
      text: `已切换${STYLE_LABEL[uiStyle]}风格`,
      tone: 'info' as const,
      leaving,
      data: {
        'data-style-toast': 'true',
        'data-style-toast-style': uiStyle,
        'data-style-toast-leaving': leaving ? 'true' : 'false',
      },
    });
    publish(notice(false));
    const leaveTimer = window.setTimeout(() => publish(notice(true)), SHOW_MS);
    const doneTimer = window.setTimeout(() => dismiss(ISLAND_STYLE_ID), SHOW_MS + EXIT_MS);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(doneTimer);
    };
  }, [uiStyle, publish, dismiss]);

  /* 本体交给灵动岛（可能正与加载态那颗并排显示）。 */
  return null;
}
