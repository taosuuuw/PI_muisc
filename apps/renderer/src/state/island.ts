import { create } from 'zustand';

/**
 * 顶部「灵动岛」的通知栈（用户本轮第 2 条）。
 *
 * 前因：岛上原本只有两条**各自独立**的通知 —— 加载态那颗「少女祈祷中⭐」
 * （`HomePage` 里的 `LoadingIsland`，只在等音源/等歌词时挂）与切风格那颗
 * 「已切换 ⨯⨯ 风格」（`StyleToast`）。两人各挂各的 `position: fixed`、都落在顶部中间，
 * 于是**同时出现时正好叠在一起**。用户的原话是：
 *
 * > 灵动岛提示遇到多个通知同时存在时，新出现的通知可以暂时顶到前面，
 * > 旧通知缩成小球在旁边……新通知消失旧通知还存在时，旧通知从小球变成灵动岛。
 *
 * 所以这里收一个**共享的通知栈**：谁在岛上、谁排前面，由这一个数组说了算。
 * 「新来的排最后」＝最新那条显示成完整药丸（`lead`），先来的留在前面缩成小球（`ball`）；
 * 药丸那条一消失，数组里最后一条自然变成 `lead`，CSS 就把小球**长回**药丸（形变见
 * `styles/dynamic-island.css`，靠宽度与文字裁剪过渡，不需要量文字宽度）。
 *
 * 为什么用全局 store 而不是 props 往下传：发布者分处两地（`HomePage` 的加载态、
 * `App` 顶层的切风格提示），而渲染点只有 `DynamicIsland` 一个 —— 这正是 store 的用途。
 * 数组里同 id 的通知只会有一条（再发一次＝把那条刷新并顶到最前），不会叠出两颗一样的岛。
 */
export type IslandTone = 'loading' | 'info';

export interface IslandNotice {
  /** 稳定 id：`loading` / `style`。同 id 再发一次就是「刷新那一条」，不会叠出第二条。 */
  id: string;
  text: string;
  tone: IslandTone;
  /** 球里那张小图（当前歌曲封面，够小）；缺省画一颗发光圆点。 */
  cover?: string;
  /** 正在退场：CSS 让它收成小球并淡出（时序由发布者决定，岛自己不管时间）。 */
  leaving?: boolean;
  /** 直接落到 DOM 上的抓手属性（老冒烟探针要读 `data-style-toast-style` 这类）。 */
  data?: Readonly<Record<string, string>>;
}

interface IslandState {
  /** 顺序即优先级：**最后一条是药丸**，前面的都是小球。 */
  notices: readonly IslandNotice[];
  publish: (notice: IslandNotice) => void;
  /** 只改内容、不改变前后次序（例如封面晚一步才拿到）。 */
  update: (id: string, patch: Partial<IslandNotice>) => void;
  dismiss: (id: string) => void;
}

/**
 * 退场动画时长（与 `styles/dynamic-island.css` 的 `pi-island-out` 对齐）。
 *
 * 主人第 10 轮第 1 条：「小球淡出的动画缺失」—— 原来只有「切风格」那条会自己先打
 * `leaving` 再撤下，**加载态那条是直接消失的**（加载一结束组件卸载、`dismiss` 立刻把它从
 * 数组里摘掉），所以缩成小球那条是「啪」一下不见的。现在改成：`dismiss` 先把这一条标成
 * `leaving`（CSS 收成小球 + 淡出），过 `ISLAND_EXIT_MS` 才真摘掉。
 */
export const ISLAND_EXIT_MS = 240;

export const useIsland = create<IslandState>((set, get) => ({
  notices: [],
  publish: (notice) =>
    set((state) => ({
      notices: [...state.notices.filter((item) => item.id !== notice.id), notice],
    })),
  update: (id, patch) =>
    set((state) => ({
      notices: state.notices.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })),
  dismiss: (id) => {
    const current = get().notices.find((item) => item.id === id);
    if (current === undefined) return;
    /*
     * 已经在退场里的（发布者自己按秒表打了 `leaving`，比如「已切换 ⨯⨯ 风格」那条）**立刻摘掉**：
     * 它的退场时间由发布者按冒烟探针的要求算好了，这里再叠 240ms 会把那套时序顶破。
     */
    if (current.leaving === true) {
      set((state) => ({ notices: state.notices.filter((item) => item.id !== id) }));
      return;
    }
    set((state) => ({
      notices: state.notices.map((item) => (item.id === id ? { ...item, leaving: true } : item)),
    }));
    window.setTimeout(() => {
      /* 这 240ms 内又被重新发布过（`leaving` 已被清掉）就留着它，别误删。 */
      set((state) => ({
        notices: state.notices.filter((item) => !(item.id === id && item.leaving === true)),
      }));
    }, ISLAND_EXIT_MS);
  },
}));

/** 加载态的岛（`LoadingIsland` 发布）—— 老探针读的就是这个 id 上的属性。 */
export const ISLAND_LOADING_ID = 'loading';
/** 切风格提示的岛（`StyleToast` 发布）。 */
export const ISLAND_STYLE_ID = 'style';
