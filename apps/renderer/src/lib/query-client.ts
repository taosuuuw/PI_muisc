import { QueryClient } from '@tanstack/react-query';

/**
 * 全应用**唯一**的 React Query 客户端。
 *
 * 为什么单独放一个模块而不是在 `main.tsx` 里 `new` 一个：
 * 播放状态机（`state/player.ts`）需要**在渲染树之外**预取歌词
 * （用户第五轮第 10 条：「每个歌在加载歌词时先不播放歌曲」），
 * 它拿不到 `useQueryClient()`——只能 import 这个单例。
 *
 * `main.tsx` 与 `state/player.ts` 都引它，**不存在循环**：
 * 本模块不 import 任何应用内模块。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});
