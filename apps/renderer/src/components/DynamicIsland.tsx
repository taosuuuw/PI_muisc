import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ISLAND_LOADING_ID, useIsland } from '../state/island';
import '../styles/dynamic-island.css';

/**
 * 顶部灵动岛本体（用户本轮第 2 条）：把通知栈里的几条画成一排 ——
 * **最新那条是完整药丸（`lead`），先来的缩成小球（`ball`）挂在它旁边**；
 * 药丸消失后，剩下那条自己从小球长回药丸（形变全在 CSS 里，见 `styles/dynamic-island.css`）。
 *
 * 两条纪律（沿用上一版那颗岛）：
 *   ① **必须 `createPortal` 到 `document.body`**：`position: fixed` 的包含块会被带
 *      `transform` 的祖先吃掉（`.pi-home__card` 就有），挂到 body 上才真的是「贴视口顶部居中」；
 *   ② 整排 `pointer-events: none` + `-webkit-app-region: no-drag`：它浮在顶框拖拽带上方，
 *      绝不能把拖窗口的那一带吃成死区。
 *
 * 老抓手一个都没丢（冒烟与调试直接读属性，不读几何）：
 *   · 加载态那条 ∈ `data-loading-island="true"`（`PI_SMOKE_ISLAND` 探针在读）；
 *   · 切风格那条的 `data-style-toast` / `data-style-toast-style` / `data-style-toast-leaving`
 *     由发布者塞进 `notice.data` 原样落到 DOM（`apps/desktop/src/main/index.ts:15214` 起那段探针）。
 */
export function DynamicIsland(): ReactNode {
  const notices = useIsland((s) => s.notices);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.body);
  }, []);
  if (host === null || notices.length === 0) return null;

  /**
   * 谁是药丸：**最后一条没在退场的**。
   *
   * 退场那条（`leaving`）刻意不占药丸位：它一边收成小球淡出，另一边剩下那条**同时**开始长回药丸，
   * 看起来才是「接力」而不是「先等它消失、再长出来」。
   */
  const leadId = [...notices].reverse().find((notice) => notice.leaving !== true)?.id;

  return createPortal(
    <div className="pi-island-stack" data-island-stack="true">
      {notices.map((notice) => {
        const lead = notice.id === leadId;
        return (
          <span
            key={notice.id}
            className={`pi-island pi-island--${notice.tone}`}
            data-island-notice={notice.id}
            data-island-slot={lead ? 'lead' : 'ball'}
            {...(notice.leaving === true ? { 'data-island-leaving': 'true' } : {})}
            {...(notice.id === ISLAND_LOADING_ID ? { 'data-loading-island': 'true' } : {})}
            {...(notice.data ?? {})}
            role="status"
            aria-live="polite"
          >
            {/*
             * 主人第 10 轮第 1 条：「红圈框选的部分可以删去，灵动岛只保留文本显示」——
             * 原来药丸左边有一颗发光圆点（加载态早先还放过歌曲封面），现在整个图案区都不要了：
             * 药丸就是一颗盛文字的胶囊，收起来的小球就是一颗空的小黑球。
             *
             * 文字**必须**再包一层真元素（主人第 9 轮第 1 条：旧通知要真的缩成小球）：
             * 裸文本在 `grid-template-columns: 0fr → 1fr` 的收缩容器里会变成**匿名网格项**，
             * 匿名项的 `min-width` 是 `auto` 而不是 0，`0fr` 收缩不动它 —— 小球态的文字照样
             * 占满宽度，两条通知并排看起来就是「两个灵动岛」。包一层 span 之后
             * CSS 里的 `> * { min-width: 0 }` 才生效。
             */}
            <span className="pi-island__text">
              <span className="pi-island__label">{notice.text}</span>
            </span>
          </span>
        );
      })}
    </div>,
    host,
  );
}
