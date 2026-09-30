import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { getBridge } from './bridge';
import './styles/tokens.css';
import './styles/global.css';
import './styles/search-overlay.css';
import './styles/liked-wall.css';
import './styles/lyric-stage.css';
import './styles/song-cards.css';
// 第十三轮第 7 条（用户 m04663）：队列拼贴（`components/SongCollage.tsx`）。
// 组件里也 import 了同一份，这里再引一次是照本仓既有约定（样式统一在 main.tsx 集中引入）。
import './styles/song-collage.css';
// 用户 m08768 第 8 条：设置页改成参考图那样的「带外框的整页 + 分类 tab」。
import './styles/settings-frame.css';
// 用户 m08768 第 5 条：播放页的情绪背景（App 的播放页里由 `<StageMood>` 挂上）。
import './styles/immersive-background.css';
// 用户 m08768 第 4 条：歌词舞台的另外五套主题（云阶/倾诉/时计 与 浮名/心象）。
import './styles/lyric-themes.css';
import './styles/lyric-moods.css';
// 用户第八轮第 1/6/7 条：无操作自动隐藏、设置框浮层、歌曲卡片列表浮层、悬浮球塌缩。
// 必须放在最后：它要盖过 global.css 里名片/进度条/悬浮球/歌单详情的既有取值。
import './styles/overlays.css';
// 用户第十五轮第 2 条：歌单改用歌曲卡片那种卡片展示（悬浮球的歌单面板 + 歌单卡的观感）。
// overlays.css 里没有任何 `.pi-plcard*` / `.pi-plgrid` 规则，所以排在它之后不冲突；
// 放末尾是为了稳拿「同特异性靠后者」的覆盖权（`.pi-plcard*` 的旧值在 global.css 里）。
import './styles/playlist-cards.css';
// 用户第十七轮第 ②③⑤ 条：平凡风格的竖排歌曲列表。
// （先锋那套「全屏歌单封面卡片」原来另有一个 `playlist-coverflow.css`；第十八轮第 ③ 条把它并进
//  搜索那套 `SongCards` 之后，那个文件删了，外壳样式收口到 `playlist-cards.css` 的 `.pi-pllist*`。）
// 排在所有既有样式之后：新组件没有历史取值要盖，放末尾只为拿「同特异性靠后者」的稳定顺序。
import './styles/song-list.css';
// M5「下载与本地库」：`我的下载` 页的下载队列 + 本地库只读清单（`.pi-dl*` / `.pi-lib*`）。
// 同样排在末尾：新 class 前缀没有历史取值要覆盖，放这里只为顺序稳定。
import './styles/download-list.css';
// 用户 m02898 第 3 条：「收藏到歌单」的选歌单浮窗（`components/PlaylistPickerOverlay.tsx`）。
// 同样是新 class 前缀（`.pi-picker*`），没有历史取值要覆盖；放末尾只为顺序稳定——
// 那条要压 `.pi-home__toast` 的规则自带两个类名（`.pi-home__toast.pi-picker-toast`），不吃顺序。
import './styles/playlist-picker.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点：index.html 被改坏了？');
}

/**
 * 没有 preload 桥就**什么都做不了**，所以不要假装没事继续渲染空壳。
 *
 * 之前 main 进程把 preload 路径写错时，界面照样画得出来、只是数据全空，
 * 看起来像「后端没数据」而不是「桥断了」——所以这里直接摊开说清楚。
 */
if (!getBridge()) {
  createRoot(container).render(
    <div className="pi-fatal">
      <h1>预加载桥不可用</h1>
      <p>
        preload 脚本没有加载成功，渲染进程拿不到任何数据通道。
        请检查 <code>apps/desktop/out/preload.cjs</code> 是否存在（重新构建一次通常就好了）。
      </p>
    </div>,
  );
} else {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
