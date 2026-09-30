import { useCallback, useEffect, useRef } from 'react';

/**
 * 用户 m03805 第 1 条（原来的「加载更多」按钮改成下滑自动加载）：
 * 三处「加载更多」按钮（歌单详情平凡列表、我的喜欢平凡列表、评论面板）全部删掉按钮，
 * 改成「哨兵一进预载区就要下一页」。这个 hook 就是那唯一的实现，三处共用。
 *
 * 为什么是 IntersectionObserver 而不是监听 scroll 事件：
 *  ① 三处的滚动容器互不相同（浮层正文、主区、抽屉正文），`scroll` 事件得一路冒到 window
 *     才能拿到，还得自己按 `scrollTop + clientHeight` 算距离，容器换了就得改；
 *  ② 观察者天生带「进/出区域」的边沿语义，滚动之外的原因（新歌插入、窗口缩放、抽屉展开）
 *     导致哨兵位置变化时照样会回调，不需要额外补 ResidentObserver 之类的钩子。
 *
 * 为什么必须往上找最近的滚动祖先当 `root`：歌单详情浮层和评论抽屉各自是独立的滚动容器，
 * 以视口为 root 时，它们内部滚到底并不会改变哨兵与**视口**的相交关系（容器本身没动），
 * 于是永远收不到回调。找不到滚动祖先（哨兵直接躺在文档流里）才退回视口。
 */

/**
 * 预载距离：哨兵离滚动容器底边还有 240px 就开始拉下一页 ——
 * 等真正滚到底才发请求，用户会看到明显的一段空白等待。
 */
const PRELOAD_MARGIN = '240px 0px';

export interface AutoLoadMoreOptions {
  /** 还有下一页可拉（`hasMore` / `hasNextPage`）——没有就完全不触发。 */
  canLoad: boolean;
  /** 当前是否已有翻页请求在飞（`isFetching` / `isFetchingNextPage`）：在飞时绝不重复触发。 */
  loading: boolean;
  /** 真的去要一页：沿用调用方原来的分页管道（`fetchNextPage()` / `setOffset(n => n + PAGE_SIZE)`）。 */
  onLoad: () => void;
}

/**
 * 往上找「真的能滚」的祖先：`overflow-y` 允许滚动，而且内容确实溢出了。
 * 两个条件都要 —— 只看 `overflow-y: auto` 会挑中那些「暂时没内容可滚」的壳子，
 * 以它为 root 时预载区只有它自己的高度，滚动起来反而收不到边沿回调。
 */
function findScrollParent(node: HTMLElement): HTMLElement | null {
  let parent = node.parentElement;
  while (parent !== null) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    if (scrollable && parent.scrollHeight > parent.clientHeight + 1) return parent;
    parent = parent.parentElement;
  }
  return null;
}

/**
 * 下滑自动加载。返回一个 **ref 回调**，把它挂到列表末尾那个被动的哨兵元素上：
 *
 * ```tsx
 * const moreRef = useAutoLoadMore({
 *   canLoad: hasMore,
 *   loading: query.isFetching,
 *   onLoad: () => setOffset((n) => n + PAGE_SIZE),
 * });
 * return <div className="pi-loadmore" ref={moreRef} />;
 * ```
 *
 * 触发条件三条同时成立：哨兵落在预载区里、`canLoad` 为真、没有请求在飞。
 * 一页到货后（`loading` 由真回落为假）会立刻复检一次：用户要是还贴在底部，就接着要下一页，
 * 这是无限滚动该有的手感；哨兵被新内容顶出预载区后自然停手。
 */
export function useAutoLoadMore({
  canLoad,
  loading,
  onLoad,
}: AutoLoadMoreOptions): (node: HTMLElement | null) => void {
  /**
   * 每次渲染后把最新入参存进 ref：观察者回调和复检 effect 都从这里读，
   * 于是「建观察者」这件事一次就够，不必跟着 `canLoad`/`loading` 反复重建
   *（重建会立刻收到一条初始 entry，反而容易重复发请求）。
   */
  const latest = useRef<AutoLoadMoreOptions>({ canLoad, loading, onLoad });
  useEffect(() => {
    latest.current = { canLoad, loading, onLoad };
  });

  const observerRef = useRef<IntersectionObserver | null>(null);
  /** 哨兵此刻是否落在预载区里，由观察者回调维护。 */
  const inRangeRef = useRef(false);
  /**
   * 已经为「当前这一页」发过请求，等 `loading` 起来再解锁。
   * 为什么要锁：`onLoad()` 把 `loading` 翻成 true 要下一帧才可见，中间若再来一条 entry
   * （StrictMode 的重复挂载、容器尺寸抖动）就会白发第二页 —— 而 `setOffset(n => n + PAGE_SIZE)`
   * 是累加的，白发一次就整整少了一页的歌。
   */
  const firedRef = useRef(false);
  /** 见过 `loading` 起来 —— 只有见过，回落时才认定「这一页到货了」。 */
  const sawLoadingRef = useRef(false);

  /** 唯一的发车口：三个条件都满足才真的要一页。 */
  const maybeLoad = useCallback(() => {
    if (firedRef.current) return;
    if (!inRangeRef.current) return;
    const { canLoad: can, loading: busy, onLoad: load } = latest.current;
    if (!can || busy) return;
    firedRef.current = true;
    load();
  }, []);

  /** 挂哨兵的 ref 回调：节点换了才重建观察者（回调本身是稳定的）。 */
  const attach = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      inRangeRef.current = false;
      if (node === null) return;
      // 没有 IntersectionObserver 的环境（例如 jsdom 下的单测）安静退化：
      // 不自动加载，也绝不炸整棵树。
      if (typeof IntersectionObserver === 'undefined') return;

      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1];
          if (entry === undefined) return;
          inRangeRef.current = entry.isIntersecting;
          if (!entry.isIntersecting) {
            // 滚出预载区就解锁：下次再滚回来还能重新发车。
            if (!latest.current.loading) firedRef.current = false;
            return;
          }
          maybeLoad();
        },
        { root: findScrollParent(node), rootMargin: PRELOAD_MARGIN },
      );
      observerRef.current = observer;
      observer.observe(node);
    },
    [maybeLoad],
  );

  /** 卸载时收尾；回调 ref 在卸载时也会收到 null，这里只是双保险。 */
  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    [],
  );

  /**
   * 复检：`canLoad` 由假翻真（又有下一页了）或 `loading` 回落（这一页到货）时，
   * 都得重新问一次「哨兵还在预载区里吗」。
   */
  useEffect(() => {
    if (loading) {
      sawLoadingRef.current = true;
      return;
    }
    if (sawLoadingRef.current) {
      sawLoadingRef.current = false;
      firedRef.current = false;
    }
    maybeLoad();
  }, [canLoad, loading, maybeLoad]);

  return attach;
}
