# PI —— 歌曲自动过渡（Automix）计划书

> 文档状态：**草案 v1.1**（2026-10-28；P0 已实测并记录在 §6.1）
> 范围：`docs/PLAN.md` 的一个新子系统，不改动既有播放链的分层
> 结论先行：**先把「过渡」和「自动混音」分成两档做；v1 不上 htdemucs。**
> 相关：[ADR-0004 音频播放与本地代理](./ADR/0004-音频播放与本地代理.md)

---

## 一、问题定义：三个档位，别混着说

「自动过渡」在业内指的不是一件事。按实现门槛从低到高分三档：

| 档位 | 在做什么 | 需要的证据 | 参考实现 |
|---|---|---|---|
| **Crossfade** | 两首重叠，音量一升一降 | 只知道「还剩几秒」 | Apple 设置里的 Crossfade、LiveSort 的混入 |
| **AutoMix** | 在乐句边界交接，变速对齐拍点，低频换手 | 每首歌的 BPM + 拍网格 + 段落边界 | Spotify Automix、Apple AutoMix、folia |
| **DJ 级** | 上面全部 + 分轨 + 调性匹配 + 甩盘/回声 | 上面全部 + 人声分离 + 调性分析 | 现场 DJ、folia 完整形态 |

**本计划要交付的是第二档（AutoMix），第三档明确不做。** 第一档作为兜底先落地。

为什么必须先分清：Crossfade 只需要「快结束了」，AutoMix 需要「这首歌第几秒是第几拍、第几小节、从第几秒允许进场」。后者要求**每首歌一张节拍地图，且在播放前算好**。这是全部工作量的分水岭。

---

## 二、参考项目审计

### 2.1 qplayer（Apache-2.0）

一个 `fade` 开关：切歌/暂停/恢复时对增益做 700ms 淡入、900ms 淡出，16ms 独立 tick 驱动；自然结束前 900ms 提前淡出；手动切歌抑制下一次淡入。**只淡变、不重叠**。

- 可借鉴：独立调度器（不依赖 `timeupdate` 的 4Hz）、「淡变走独立 gain 层，不碰用户音量」、seek 回尾部时恢复增益。
- 结论：属于第一档，只做 P1。

### 2.2 LiveSort（**无许可证**）

浏览器端 Web Audio 离线分析 BPM/能量/亮度/首尾片段，按「演唱会兴趣曲线」重排歌单，再把两首首尾真正叠在一起，用 `OfflineAudioContext` 渲染成成品音频。

- 可借鉴：**过渡长度由素材决定**这条公式——`mix_lead_sec = clamp(9.1 + 尾部静音 × 0.62, 7.4, 13.2)`，再配 `mix_breath_sec` 控制重叠段。
- 不采用：它是批处理导出工具，不是实时播放器。
- **无许可证文件，等于保留所有权利，只学思路，不抄代码。**

### 2.3 folia-major（**AGPL-3.0**）

四层架构：证据（`TrackProfile`、`BeatGrid`、`TrackStems`）→ 决策（`TransitionPlan` 纯数据）→ 执行（Web Audio 增益曲线/滤波/软限幅）→ 绑定（React）。

两个神经网络都在**证据层**，只测事实、不做决定：

| 模型 | 作用 | 许可证 | 体积 | 运行时 |
|---|---|---|---|---|
| **Beat This!** | 拍点 + 强拍 → 小节线、乐句量化、入场对齐、变速相位 | MIT | 41.1MB | 渲染进程 WebGPU（自写 WGSL），CPU 退路 MNN |
| **htdemucs** | 四轨分离（drums/bass/other/vocals）→ 人声退场、鼓/贝/其余分时交接、build-up | MIT | 91.8MB | 分析 worker 内 MNN，CPU，30s 窗口约 4 秒 |

关键数据（来自其 README/MODELS.md）：

- 拍点：自带的 DSP 估算器在 30 首里只答得出 12 首、其中约一半正确（≈20% 可用）；Beat This! 的拍点与强拍 F 值为 **1.0000**。
- 分轨：盲测「分离 + 规则」对「主轨交叉淡化」为 **5.85 vs 4.00**（满分 10），样本量小，仅作量级参考。
- 数值常量：`AUTOMIX_ARM_LEAD_SEC = 1`、`RELEASE_MARGIN_SEC = 0.25`、`CUT_SECONDS = 0.05`、`SPLICE_SEC = 0.008`、`STRETCH_LIMIT = 0.12`、`DRIFT_LIMIT = 0.25`、`BEATS_PER_PHRASE = 16`、过渡长度夹在 `0.2–25s`、两曲实际重叠夹在 `0.8–25s`。

- **AGPL-3.0 与 PI 的 GPL-3.0 不兼容：只学思路与参数，不复制任何源码文本。**

---

## 三、PI 现状审计（决定工作量的部分）

| 事实 | 位置 | 影响 |
|---|---|---|
| 播放是**单例 `new Audio()`**，无 Web Audio 图 | `apps/renderer/src/lib/audio-engine.ts:25` | 要做双 deck 必须改这里 |
| 播放地址是主进程本地代理 `127.0.0.1:<port>/audio/<key>` | `apps/desktop/src/main/media-server.ts` | 跨源媒体，`MediaElementAudioSourceNode` 会输出零样本 |
| 转发响应头白名单**没有 CORS 头** | `apps/desktop/src/main/media-server.ts:36-44` | **P0 必须先加，否则整条方案不成立** |
| `getAudio()` 全仓 7 个调用点，集中在 2 个文件 | `state/player.ts`、`components/AudioEngine.tsx` | 改造面可控 |
| `window.__piAudio` 被主进程 UI 冒烟大量依赖 | `apps/desktop/src/main/index.ts` 多处 | 双 deck 后必须指向「活动元素」，否则冒烟全红 |
| 切歌 = `pause()` → 等解析 → 换 src → `play()` | `state/player.ts` | 解析延迟几百毫秒到几秒，预取必须提前 |
| 有六源歌词时间轴 | `packages/shared`、`lyric-prefetch.ts` | **可以免费替代 htdemucs 的「人声退场」判断** |
| 有下载/本地库 | `apps/desktop/src/main/downloads.ts` | 完整文件分析比流式可靠 |
| 设置结构集中 | `packages/shared/src/index.ts:592` | 新增开关只改一处 + 设置页 |

**结论：卡点只有一个——CORS。** 其余都是工程量，不是可行性问题。

---

## 四、已定事项（本轮讨论结论）

| # | 结论 | 理由 |
|---|---|---|
| D1 | 分档交付：先 Crossfade（P1/P2），再 AutoMix（P3/P4） | 两档技术栈完全不同，混着做会两头不讨好 |
| D2 | **v1 不上 htdemucs** | 92MB + 每 30s 窗口 4 秒 CPU，只值 +1.85 分；且 build-up 一并放弃 |
| D3 | 拍点引擎用 **Beat This!（MIT）**，优先 `small`（8.1MB） | 把「知道小节线」从 ≈20% 可用拉到接近 100%；许可证与体积都可接受 |
| D4 | 只学 folia 的思路与数值，**不复制代码** | AGPL-3.0 与 GPL-3.0 不兼容 |
| D5 | 人声退场用**歌词时间轴**代替 stem | PI 白捡的优势，正好是 htdemucs 最值钱的那部分 |
| D6 | 必须接 Web Audio；CORS 是前置条件 | folia 的经验与 PI 现状都证明跨源无 CORS 会静音 |
| D7 | 双 deck（A/B 两个 `<audio>`） | 单元素无法重叠播放 |
| D8 | `window.__piAudio` 继续指向**当前活动元素** | 保住现有冒烟与排障能力 |
| D9 | 变速只弯**出场曲**，用元素的 `preservesPitch` | 不自己写 WSOLA（folia 的 150 行 worklet 曾把音高校正做了两遍） |
| D10 | 任何一步失败都**退回现有切歌路径** | 宁可退回硬切，也不能卡在半过渡或变哑 |
| D11 | 分析结果落盘缓存，按 `song.id + 音源指纹` 索引 | 一首歌只分析一次 |
| D12 | 不承诺「任意歌即时 automix」，用「就绪集合」 | Spotify 限歌单、Apple 限曲库，都没敢承诺 |
| D13 | 「跳过前奏」做成显式开关，**默认关** | Apple AutoMix 被吐槽最多的就是这点 |
| D14 | **Essentia.js 排除**（AGPL-3.0） | 与 GPL-3.0 不兼容 |

---

## 五、技术方案

### 5.1 分层（照 folia 的分法，规模缩小）

```
证据层   TrackProfile / BeatGrid / 歌词时间轴     ← 离线分析，落盘缓存
决策层   TransitionPlan（纯数据）                 ← 纯算术，无音频节点
执行层   双 deck + 增益曲线 + 分频段 + 软限幅     ← Web Audio
绑定层   React 外壳 / 播放 store 接线             ← 现有架构
```

### 5.2 新增模块（拟）

```
apps/renderer/src/lib/transition/
├── audio-graph.ts       AudioContext、双 deck 节点链、共享 master
├── analyzer.ts          fetch(Range) → decodeAudioData → 降采样 → 帧能量
├── beat-grid.ts         拍点后处理（Beat This! 输出 → {offset, period}）
├── sections.ts          结构/尾部形态/首部 leadIn/歌词 lastSung
├── profile.ts           TrackProfile 组装 + 磁盘缓存读写
├── plan.ts              选接法、算时长、量化到拍/小节/乐句
├── curves.ts            等功率曲线、平台、分频段、软限幅
├── deck-clock.ts        currentTime 阶梯拟合 → 毫秒级位置
└── session.ts           状态机 idle → armed → fading + 撤销条件
```

主进程侧只改一处：`media-server.ts` 加 CORS 头。

### 5.3 数据结构（草案）

```ts
interface BeatGrid { offset: number; period: number; confidence: number }

interface TrackProfile {
  songId: number;
  bpm: number | null;
  grid: BeatGrid | null;          // 来自 Beat This! 或 DSP 兜底
  durationMs: number;
  tail: { silenceSec: number; fadeOutSlopeDbPerSec: number | null; endsHot: boolean };
  head: { silenceSec: number; startsHot: boolean };
  lastSungMs: number | null;      // 歌词最后一句（代替人声分离）
  analyzedAt: number;
}

interface TransitionPlan {
  style: 'beatCut' | 'bassSwap' | 'tailRide' | 'plainBlend';
  overlapSec: number;
  fromStartAt: number;            // 出场曲进入过渡的时刻
  toStartAt: number;              // 进场曲开始的位置
  rate: number;                   // 变速比，1 表示不变
  reason: string;                 // 日志用：为什么这么选
  bands: { low: boolean; mid: boolean; high: boolean };
}
```

### 5.4 关键参数（来自 folia，**待听感校准**）

| 参数 | 初值 | 含义 |
|---|---|---|
| `ARM_LEAD_SEC` | 1.0 | 距歌尾多少秒开始备过渡 |
| `RELEASE_MARGIN_SEC` | 0.25 | 释放余量，避免拖尾 |
| `CUT_SEC` | 0.05 | 硬切也要有 50ms 斜坡，否则是爆音 |
| `STRETCH_LIMIT` | 0.12 | 变速上限，超过就不重叠 |
| `DRIFT_LIMIT` | 0.25 | 重叠上限，超过就干脆切 |
| `MIN_OVERLAP` | 0.8 | 短于此不算过渡 |
| `MAX_OVERLAP` | 25 | 长于此反而可疑 |
| `BEATS_PER_PHRASE` | 16 | 乐句 = 4 小节 × 4 拍 |

### 5.5 状态机

```
idle ──(距歌尾 ARM_LEAD_SEC)──▶ armed ──(到达过渡点)──▶ fading ──▶ idle
  │                              │                      │
  └──────────── 失败/取消 ───────┴──────────────────────┘
                              ▼
                    退回现有切歌路径（pause → resolve → src → play）
```

撤销条件至少覆盖：用户点下一首、暂停、seek 离开尾部、队列被改、下一首解析失败、音频元素报错。

---

## 六、分阶段计划

### P0 · 地基验证（✅ 已完成，2026-10-28）

已落地两处改动：

- `apps/desktop/src/main/media-server.ts`：`handle()` 统一补 `Access-Control-Allow-Origin: *`（含 403 / 404 / 416 / 502 等错误响应），并加 OPTIONS 预检与 `expose-headers`；
- `apps/renderer/src/lib/audio-engine.ts`：创建 `<audio>` 时设 `crossOrigin = 'anonymous'`（在设 `src` 之前）。

验证证据：

1. **单测** `apps/desktop/src/main/media-server.test.ts`：8 条全过（200 / 206 / HEAD / OPTIONS / 403 / 404 / 路径不匹配 / 416），每条都断言 `access-control-allow-origin` 存在。
2. **独立探针** `scripts/probe-cors-media.cjs`（页面 origin 为 opaque，模拟打包态的 `file://`）：

| 组 | 条件 | 结果 |
|---|---|---|
| A | 有 ACAO + `crossOrigin` | `peak=0.600009`（信号振幅 0.6）、`rms=0.4229`、context running ✅ |
| B | 无 ACAO + `crossOrigin` | `error:4`（MEDIA_ERR_SRC_NOT_SUPPORTED），元素直接拒载 |
| C | 无 ACAO + 不设 `crossOrigin` | `peak=0`、`rms=0`，而 `paused=false`、`currentTime=0.58`——**播放看着完全正常** |
| D | 有 ACAO、不建 source | AudioContext running ✅ |

   C 组就是 PI 改之前的状态：**播放正常但样本全 0**，坐实了 `apps/renderer/src/lib/audio-bands.ts` 顶部那条记录。
3. **应用回归**：`PI_SMOKE_PLAY=auto` 3/3 首经本地代理拿到可 Range 的字节（exit 0）；`PI_SMOKE_UI=1` 里「切页面不断音：2.19s → 5.16s ✓」与「播放器详情页 ✓」两条也过了——说明 `<audio crossOrigin>` 加上之后播放链没有断。
   **照实记**：UI 冒烟整跑 exit 1，但失败的是「下载写盘 EPERM（`Music` / `userData` 在本次受限环境里不可写）」与「十八轮⑪接下来播放名片 `left=-1px`」两条与音频元素无关的断言，不是 P0 引入的。

结论：Q1、Q2 已答（见 §7）；Q3（`preservesPitch`）留到 P4 前。

复现探针时的环境备注：

- 本机环境带 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node（`require('electron')` 返回路径字符串），跑之前要 `unset`；
- Electron 44.4.5 + Windows 下直接加载 `.mjs` 主进程会**静默退出（exit 3）**，CJS 入口正常——所以探针写成 `.cjs`；
- 在本机的受限沙箱里 Electron 渲染进程起不来（进程创建被限制），探针与冒烟需要完整权限。

探针跑法：`npx electron --no-sandbox scripts/probe-cors-media.cjs`，结果同时写到 `.tmp/probe-cors-media.json`。

### P1 · 淡变（✅ 已完成，2026-10-28）

落地内容：

- **新增** `apps/renderer/src/lib/transition/fade-graph.ts`：`元素 → MediaElementSource → fadeGain → masterGain → destination`；用户音量走 `masterGain`（30ms 斜坡），过渡走 `fadeGain`；`ensureGraph` 在没有 `AudioContext` 的环境里返回 `undefined`，所有原语安全 no-op（纯 Node 单测靠这个活着）。
- **改** `apps/renderer/src/lib/audio-engine.ts`：`applyVolume` 不再写 `element.volume`，元素固定满幅，音量交给 `masterGain`。
- **改** `apps/renderer/src/state/player.ts`：
  - `loadCurrent()` 手动切歌先 `fadeOut(90ms)` 再 `pause()`；新歌 `play()` 后 `fadeIn(700ms)`；
  - `toggle()` 暂停走 90ms 淡出、恢复走 90ms 淡入，并在淡出期间核对状态（防止把新歌踩回 paused）；
  - `seek()` 调 `resetFade()`（qplayer 踩过的「拖回尾部整首无声」）；
  - 新增 200ms 看门狗：`duration - currentTime <= 900ms` 时按剩余时间淡出；判定抽成纯函数 `shouldStartTailFade`。
- **改** `packages/shared/src/index.ts` + `packages/ipc/src/index.ts`：`Settings.songTransition: 'off' | 'fade'`，默认 `'fade'`。
- **改** `apps/renderer/src/pages/SettingsPage.tsx`：详情设置页 →「界面」田字格里新增「自动过渡」开关（淡变 / 关）。
- **改** `apps/renderer/src/components/PiQuickPanels.tsx`：右划快捷设置卡 →「默认音质」分页里新增同一开关（抓手 `data-quick-switch="song-transition"`）。两处写的是同一个 `songTransition` 字段，改哪边都即时生效。

验证证据：

1. **单测** `apps/renderer/src/lib/transition/fade-graph.test.ts` 8 条 + `state/player.test.ts` 4 条，共 12 条全过（含「没有 AudioContext 时全部 no-op」「歌尾判定边界 / NaN / 防重复触发」）。
2. **浏览器探针** `scripts/probe-fade-graph.cjs`（与 `fade-graph.ts` 同构的图，合成 440Hz 正弦）：

| 断言 | 实测 |
|---|---|
| 起播峰值 | `0.6000`（信号振幅 0.6） |
| `fadeOut(300ms)` 后 | `fadeGain=0`、峰值 `0` |
| `fadeIn(300ms)` 后 | `fadeGain=1`、峰值回到 `0.6` |
| `masterGain→0.5` 后 | 峰值 `0.3` |
| 元素音量 | 恒为 `1`（音量确实交给 master） |

3. **应用回归**：`PI_SMOKE_UI=1` 两次跑都是「切页面不断音：1.91s → 4.84s ✓」「1.88s → 4.80s ✓」，加上「播放器详情页 ✓」——接上 Web Audio 图之后声音照常出来、进度照常走。
   快捷设置卡的读数里也能看到新开关：`开关=[lyric,quality,lyric-source,song-transition,theme,accent,account]`，分页栏 4 颗 / 选中 1 颗、方块等宽 ✓。
   **照实记**：整跑 exit 1，失败的是「下载写盘 EPERM」「每日推荐卡封面 2/4 加载超时」「十八轮⑪接下来播放名片 `left=-1px`」这三条与音频图无关的断言；后来又出现一次「封面右下角键悬停浮出」的黄（合成指针在受限环境里不稳），同样与音频图无关。

**顺带修掉的前置问题**：冒烟日志暴露出 `apps/renderer/index.html` 的 CSP 是 `connect-src 'self'`，`fetch` 读本地代理的音频字节会被浏览器直接拦掉（`media-src` 早就放开了 `http://127.0.0.1:*`，`connect-src` 没有）。这条对 P1 没影响，但 P2/P3 的离线分析必须 `fetch(Range)`，所以这次一并把 `connect-src` 放到 `'self' http://127.0.0.1:*`，并写了注释说明范围与 `media-src` 一致。改完重跑冒烟：CSP 报错 **0 条**。

**还没做的**：「连续切 20 首无爆音」没有自动化判据（程序判不了「爆音」，需要人耳），只留了探针的客观数值；这一条按人工抽听验收。

### P2 · Crossfade（✅ 已完成，2026-10-28）

落地内容：

- **改** `apps/renderer/src/lib/audio-engine.ts`：单例元素 → 两个 deck（`a` / `b`）。`getAudio()` 永远返回**活动 deck**，`window.__piAudio` 跟着切；备用 deck 懒创建。
- **改** `apps/renderer/src/lib/transition/fade-graph.ts`：单图 → 双路图（`deckA → gainA`、`deckB → gainB` 汇到 `masterGain`）；新增 `crossfade(from, to, seconds)`，两条互补等功率曲线（`sin` / `cos`，平方和为 1），每 deck 一份独立的 fade 代次，互不顶掉。
- **改** `apps/renderer/src/components/AudioEngine.tsx`：两个元素都挂监听，但 `timeupdate / ended / error / play / pause` 只认**活动 deck**——交叉期间出场那一路的 `ended` 不再触发第二次切歌。
- **改** `apps/renderer/src/state/player.ts`：新增过渡状态机 `idle → arming → ready → fading`；
  - 距歌尾 12 秒解析下一首并装到备用 deck（静音）；
  - 距歌尾 5 秒：新 deck 起播 → 切活动 deck 与 store（`queue / currentSong / src / audio / positionMs`）→ 等功率交叉 → 暂停出场 deck 并复位增益；
  - 任何失败（解析不到、队列变了、新 deck 播不出来）都退回 `idle`，P1 的尾部淡出兜底；切歌 / 暂停 / seek / 换档位一律先 `abortTransition()`。
- **新增** `apps/renderer/src/lib/transition/schedule.ts`：`shouldArmNext` / `shouldStartCrossfade` 两个纯函数，把「什么时候预取、什么时候开交叉」从调度里拆出来。
- **改** 三处设置入口（`packages/shared`、`packages/ipc`、详情设置页、快捷设置卡）：档位从 `off | fade` 扩成 `off | fade | crossfade`，默认仍是 `fade`。

**P2 没做的**：音频分析（尾部静音量 / 首部静音）——长度先固定 5 秒，留给 P3 的管线。计划书原本把「轻量分析」写在 P2，实际做下来分析要 `fetch(Range)` + 解码，和 P3 是同一套基建，拆开只会重复劳动。

验证证据：

1. **单测** 22 条全过：`fade-graph` 8 条 + `schedule` 10 条 + `player` 4 条。
2. **浏览器探针** `scripts/probe-crossfade.cjs`（双 deck、440Hz 与 660Hz 两路，3 秒等功率交叉）：

| 断言 | 实测 |
|---|---|
| 交叉前 RMS（单路） | `0.425` |
| 交叉中 RMS 区间 | `0.419 – 0.431`（**不塌**；线性交叉会掉到 ~0.30） |
| 交叉后增益 | `gainA=0`、`gainB=1` |
| 交叉后状态 | `A.paused=true`、`B.paused=false` |
| 交叉后 RMS | `0.424` |

3. **应用回归**：`PI_SMOKE_UI=1` 里「切页面不断音：2.26s → 5.21s ✓」「播放器详情页 ✓」「快捷卡开关列表含 `song-transition` ✓」都过了；唯一红的是「M5 下载与本地库」，原因是 `Music` / `userData` 在本次受限环境里不可写（EPERM），与双 deck 无关。
   **照实记**：冒烟流程里没有「等 12 秒听交叉」的段落，所以应用级只验到「双 deck 不干扰正常播放、事件路由没串」；交叉本身由 `probe-crossfade.cjs` 在真实 Chromium 里验证。连续 20 首交叉的听感仍需真机抽听。

**P2 补丁：Crossfade 下「接下来播放」卡片不出现**（2026-10-28，主人反馈）

- **现象**：切到交叉档之后，左下角那张「接下来播放」小名片再也不出现；非交叉档正常。
- **原因**：那张卡片的窗口是「剩余 ≤ 5 秒」，而交叉恰好也在**剩余 5 秒**开始。交叉一开始就 `setState` 把 `currentSong` 与 `positionMs` 换成新歌，卡片的 `remainMs` 瞬间变回整首，条件不再成立——它连一帧都来不及画。
- **修法**：窗口按档位算（`apps/renderer/src/lib/transition/up-next-window.ts`）：非交叉档仍是 5 秒；交叉档是 `5s + 交叉时长`（10 秒）。于是交叉开始前先露满 5 秒，交叉开始时它照旧消失、由左下角歌曲名片接棒——与非交叉档的交接节奏完全一致。非 Crossfade 的观感一个像素都没动（有单测钉住两个档位各自的窗口）。
- **验证**：3 条单测钉住「off / fade = 5s」「crossfade = 5s + 交叉时长」；`PI_SMOKE_UI` 里非交叉档的「接下来播放名片左下+5s」仍然 ✓（尾声 7s 时 false、3s 时 true、`left=22px`）。**照实记**：交叉档的实际观感要真机把歌放到最后 10 秒才能确认，冒烟不覆盖这个档位。

### P3 · 分析管线 + Beat This!（✅ 已完成）

落地内容：

- **新增** `apps/renderer/src/lib/transition/mel.ts`：128 带 log-Mel 前处理——手写 radix-2 FFT + Slaney 三角滤波器组（n_fft 1024 / hop 441 / 22050Hz），与模型训练时的输入契约逐项对齐。
- **新增** `apps/renderer/src/lib/transition/beat-this.ts`：onnxruntime-web（WASM）加载模型、分块（1500 帧 + 6 帧边框）推理 `beat` / `downbeat` logits、峰值检测出拍网格。模型只加载一次，推理每块之后让出主线程。
- **新增** `apps/renderer/src/vendor/ort/ort.wasm.min.mjs` + `ort-wasm-simd-threaded.mjs`（约 430KB）：从 onnxruntime-web 1.31.1 vendor 出来的「外部 wasm」入口与加载器，由 Vite **静态**打进 bundle；同目录的 `.d.mts` 只声明用到的三样 API。
- **改** `apps/desktop/src/main/index.ts`：注册 `pi-ort://` 标准 scheme 并提供 `resources/ort/` 的只读访问（原因见下方「两个硬坑」）。
- **新增** `apps/renderer/src/lib/transition/analyze.ts`：DSP 分析核心（降采样、帧能量、尾部/头部静音、`startsHot`、comb 自相关拍点）。现在拍点优先走模型，它负责全部结构特征 + 模型不可用时的兜底。
- **新增** `analyze.worker.ts` / `profile.ts` / `profile-cache.ts` / `profile-service.ts`：结构分析进 Worker、档案落 localStorage（几百字节一条、容量淘汰）、整条链路在预取时 fire-and-forget。
- **改** `apps/desktop/src/main/services.ts` + `packages/ipc` + `packages/shared`：新增 `automix:resources` 通道，返回模型地址与 wasm 目录；缺文件时 `available=false`。
- **新增** `scripts/fetch-beatthis-model.mjs`：资源准备脚本（镜像分块下载模型 + 解包 runtime），`.gitignore` 排除 98MB 二进制。
- **新增** `apps/renderer/src/lib/transition/beat-this.worker.ts` + `beat-this.ts` 里的 `detectBeatWithModelInWorker`：推理整个搬进 Worker，主线程只负责解码与收结果。Worker 用 Vite 的 `?worker`（**非** inline）输出独立文件，`vite.config.ts` 里把 `worker.format` 设成 `'es'`。
- **改** `apps/renderer/index.html`：CSP 补 `worker-src 'self' blob:`（blob worker 会回退到 `script-src` 被拦）。
- **改** `apps/renderer/src/state/player.ts`：`armNextTrack` 成功后调 `ensureTrackProfile`。

关键决策：

- **拍点用 Beat This!，结构用 DSP**。模型在「有拍就给拍」上远强于自相关（DSP 兜底对弱节奏会直接答 `bpm=—`）；而尾部/头部静音是纯统计，DSP 又准又便宜，没必要喂给 83MB 的 transformer。
- **模型是 final0（83MB），不是 small（8.1MB）**：公开可下载的 ONNX 导出只有 `mosynthkey/beat_this_cpp` 里从 `final0.ckpt` 转的这一份；small 的 ONNX 没有现成产物，要换得自己从 PyTorch 转（需要 torch 环境）。代价是安装包与内存，收益是精度。
- **完整取字节、解码即降采样、缓存放 localStorage**（与纯 DSP 阶段相同的三条）：`decodeAudioData` 需要完整容器；`OfflineAudioContext(1,1,22050)` 让浏览器解码时就重采样；档案几百字节一条，没必要为它维护主进程文件。
- **推理暂时在主线程**：分块之间 `requestAnimationFrame` 让出，但单块仍是秒级占用。搬进 Worker 是下一步优化（见照实记）。

验证证据：

1. **单测**：`mel.test.ts` 7 条（FFT 峰值落位、静音全 0、滤波器组形状/单调、帧数、能量分布、log 静音不出 `-Infinity`）+ `analyze.test.ts` 12 条 + `profile-cache.test.ts` 5 条；过渡相关合计 **44 条**。
2. **推理探针** `scripts/probe-beatthis.cjs`（真实 Chromium + 12 秒 / 120 BPM 合成节拍）：

| 断言 | 实测 |
|---|---|
| 模型字节 | 83,077,778 |
| 输入 / 输出名 | `input_spectrogram` / `beat`、`downbeat` |
| 加载耗时 | 2,774ms |
| 单块推理（598 帧） | 1,986ms |
| 检出拍点 | 23 个，首个在第 23 帧 |
| 间隔中位数 | **25 帧 = 0.5 秒** |
| 推算 BPM | **120**（构造 120） |

3. **DSP 探针** `scripts/probe-analyze.cjs`（同一条链路的兜底路径）：BPM 120.2、头部静音 0.96s、尾部静音 2.39s、总耗时 54ms。
4. **真实应用**（`PI_SMOKE_UI=1`，本机设置 `crossfade`，预取触发分析）：
   `[pi/automix] 分析完成：ふわり（id=2034848078）bpm=83.3（Beat This!）尾部静音=4.28s 头部静音=0.72s 耗时=32328ms`
   —— 同一首歌在 DSP 兜底时是 `bpm=—`（完全测不出），模型给出了 83.3。这条日志是「模型真的进了应用、不是只在探针里」的直接证据。

**踩到的两个硬坑（都记下来，否则下次还得重踩）**：

- **`file://` 页面不能动态 import 跨源模块**。ONNX Runtime 的 wasm 加载器是运行时 `import(url)` 的，无论把 URL 指向 http（本地代理）还是 file，都会报 `Failed to fetch dynamically imported module`。最后用 `protocol.registerSchemesAsPrivileged` 注册了一个标准 scheme `pi-ort`（`standard/secure/supportFetchAPI/corsEnabled/stream`），由主进程 `protocol.handle` 只读提供 `resources/ort/`，动态 import 才成立。
- **CSP 要放行 WebAssembly**。`script-src 'self' pi-ort:` 下 `WebAssembly.instantiate` 会被拦（`'unsafe-eval' is not an allowed source`）；加 `'wasm-unsafe-eval'` 即可——它只放开 WebAssembly，不放开完整 eval。

**照实记**：

- **推理耗时：32.3 秒 → 8.1～9.4 秒**（同一首歌、同一台机器，多次跑有波动）。手段两条：
  ① **只推理开头 30 秒**——正好一块（1500 帧），BPM 用前 30 秒估，实测同一首仍是 **83.3**（和全曲推理一字不差）；
  ② **模型加载与音频下载/解码并行**（`warmUpBeatThis` 提前发起 83MB 的 fetch）。
  剩下的成本主要是单块 WASM 推理约 5 秒 + 整曲解码约 2 秒，都在预取窗口（12 秒）之内了。
- **那 5 秒已经搬进 Worker**：主线程只做解码和收结果，单次分析实测 **9.97 秒**（比主线程的 8.1 秒略慢——多了一次 Worker 启动与消息往返），但**界面不再被冻住**，冒烟里「切页面不断音」照常通过。Worker 里还有 `onerror` + 60 秒超时兜底：Worker 脚本加载失败时退回 DSP，绝不把分析链挂死。
- **Worker 踩的两个坑**：① `?worker&inline` 默认按 IIFE 打包，而 onnxruntime 的 wasm 加载器里有 top-level await（`await import('worker_threads')` 的环境探测），IIFE 直接打不出来 → 必须把 `worker.format` 设成 `'es'`；② 内联成 blob worker 后又被 CSP 拦（`worker-src` 未设置时回退到 `script-src`，不含 `blob:`）→ 改成**非 inline** 的独立文件 + CSP 补 `worker-src 'self' blob:`，才真正跑通。
- **再快的路都撞结构限制**：多线程 WASM 需要 `SharedArrayBuffer` + 跨源隔离（COOP/COEP），而打包态页面是 `file://`、拿不到响应头，这条路不通；WebGPU 要多带 29.5MB 的 `jsep` 运行时、且 GPU 在本机可用性未知，暂不引入。
- **模型 83MB 不进仓库**：`apps/desktop/resources/ort/` 在 `.gitignore` 里，新机器要先跑 `node scripts/fetch-beatthis-model.mjs`；缺文件时应用自动退回 DSP（日志会写「Beat This! 不可用」）。
- **30 首真实样本的可用率与耗时没测**：需要真实曲库与网络；合成信号只证明了「输入契约对、输出与构造的 BPM 一致」。
- **`lastSungMs` 没有进 profile**：歌词最后一行的位置在过渡那一刻现算更便宜，也更准（歌词可能在分析之后才到）。
- **冒烟的「接下来播放名片」断言按 5 秒写死**：本机设置是 `crossfade`（窗口 10 秒），所以这条在 P3 首跑时红了——不是 bug，是断言没跟上 P2 的窗口变化。而且取样点也不能用固定的「3 秒」：交叉档在剩余 5 秒就真的开始切歌，3 秒处卡片已经按设计消失。已改成按 `services.getSettings().songTransition` 算：窗口外取「窗口 + 2 秒」，窗口内取「窗口 − 2 秒」（fade 3s / crossfade 8s），两档都落在「该显示且还没开始交叉」的区间。

### P4 · AutoMix（✅ 已完成决策层 + 分频段曲线）

落地内容：

- **新增** `apps/renderer/src/lib/transition/automix.ts`：`planTransition` 纯函数——输入两端档案与剩余时间，输出 `style / durationSec / tempoRatio / reason`。
- **改** `apps/renderer/src/lib/transition/fade-graph.ts`：
  - 每个 deck 的链路上加 `lowShelf`（200Hz）+ `highShelf`（4kHz），平时都是 0dB（透明）；
  - master 后加 `DynamicsCompressor` 软限幅（-3dB / 20:1 / 3ms），防止两首峰值叠加削顶；
  - 新增 `automixCrossfade`：主曲线仍是等功率，按接法叠加低频/高频曲线；
  - 新增 `resetDeckFilters`（收尾复位，否则下一轮带着上一轮的 -12dB）。
- **改** `apps/renderer/src/state/player.ts`：调度器把 `automix` 与 `crossfade` 并到同一条「预取 → 到点交叉」路径（此前只认 `crossfade`，智能档会静默掉进淡变兜底）；AutoMix 在预取阶段就算好 plan，`startCrossfade` 按 plan 执行：出场曲 `playbackRate`（`preservesPitch = true`）、新歌从 `incomingStartSec` 起播、打印 `[pi/automix] style（时长）：reason`。
- **新增** `apps/renderer/src/lib/transition/structure.ts`：结构段落检测（自相似矩阵 + 棋盘核 novelty + 段间聚类），纯 DSP、可单测。
- **改** `apps/renderer/src/lib/transition/automix.ts`：`planTransition` 用段落表算**起手点**——有段落表时从「最后一个副歌类的结束处」混入（那正是 outro 的入口），没有则退回「提前 4 小节」。
- **改** `apps/renderer/src/lib/transition/profile.ts` + `profile-service.ts`：档案加 `sections` / `chorusClassId`（版本抬到 2，旧档案自动重算），分析时对全曲跑一遍段落检测。
- **改** 设置三处入口：档位从 `off / fade / crossfade` 扩成 `off / crossfade / automix`（“智能”）。
  **`fade` 档已下线**（主人 2026-10-29 要求）：它只做淡入淡出、不重叠，实测和 `crossfade` 听感太接近，留着只是让设置项变成四选一；老用户盘上的 `fade` 在主进程读设置时归一到 `crossfade`，`DEFAULT_SETTINGS` 也改成 `crossfade`。快捷卡的三档因此正好落进三列网格，一行排完（此前四档会挤成「3+1」两行）。

规则（全部在 `automix.ts` 里，13 条单测钉住）：

- **两端都有可靠拍网格**（confidence ≥ 0.3）→ 过渡长度量化到 **16 / 8 / 4 拍**（取剩余时间放得下的最大整小节数），出场曲变速去贴进场曲的 BPM（**只弯出场曲，±12%**）。进场曲 `startsHot`（一上来就满电平）→ `bassSwap`，否则 `beatCut`。
- **提前在 outro 段起手**：`leadInSec = 16 拍`（4 小节，上限 20 秒）。过渡不是在「歌放完」时发生，而是在旧歌还没结束时就叠进去——这才是 DJ 式的混音点。
- **结构段落对齐**：有段落表时，起手点改成「旧歌最后一个副歌类的**结束处**」（outro 入口），而不是死算 4 小节；`startAtRemainingSec = max(过渡时长 + 2s, 总长 − 副歌结束点)`，保证既落在结构边界上、又给过渡留足长度。没有段落表才退回 4 小节。
- **进场曲跳过静音前奏**：`incomingStartSec = min(head.silenceSec, 8)`，只跳测出来是静音的段；有内容的前奏不动。
- **缺席一端的网格**：出场曲尾部静音 > 0.5s → `tailRide`（4~8 秒，随静音拉长），不变速、不提前。
- **都没有** → `plainBlend`（固定 5 秒，行为同 P2）。
- **预告窗口**（`up-next-window.ts`）：智能档要覆盖「提前 20 秒 + 过渡 8 秒 + 预告 5 秒」，否则卡片会在交叉已开始后才出现。

验证证据：

1. **单测** `automix.test.ts` 13 条：量化到 16 拍、4% 差变速后的时长换算、20% 差夹在 ±12%、只够 8/4 拍时退让、`startsHot → bassSwap`、尾部静音 → `tailRide`、低置信度当无网格、纯兜底、**提前 4 小节起手**、**跳静音前奏（上限 8 秒）**。全量 119 文件 / 1701 用例。
2. **浏览器探针** `scripts/probe-automix.cjs`（真实 Chromium，bassSwap 交叉 2 秒）：

| 断言 | 实测 |
|---|---|
| 交叉中总 RMS | 0.45 ~ 0.52（不塌） |
| 出场曲低频结束 | **-12.0 dB** |
| 进场曲低频结束 | **0.0 dB** |
| 两路叠加峰值 | **0.89**（不削顶，< 1.0） |
| 主曲线收尾 | gainA=0、gainB=1 |

2b. **结构检测**：`structure.test.ts` 3 条（A-B-A-B 合成信号能切段并识别重复类、单一音色不产生假重复类、全静音返回空）。真实应用里那首歌：**8 段、副歌类=1、耗时 999ms**（全曲 mel + SSM + 聚类）。

**照实记**：

- **段落检测是自相似 DSP，不是段落模型**：它只能回答「哪几段长得像、边界在哪」，不能命名「主歌/副歌」。所谓「副歌类」= 出现次数最多的重复类，对 A-B-A-B 这种规整结构最准；自由结构、长即兴、只唱一遍的歌容易切错或切不出。
- **结构对齐只用在旧歌的混音点上**（从最后一个副歌类结束处混入）；新歌仍从「静音前奏之后」进，没有做「从新歌的副歌直接 drop 进去」——那种做法会跳过整个主歌，对普通听众太突兀，等有了更可靠的段落分类再说。
- **首次播放某首歌时档案还没就绪**，那次过渡会退成 `plainBlend`（日志里能看到，`startAtRemainingSec` 只有 5 秒）——这是「分析在后台跑」的必然结果，第二遍才有结构混音。
- **拍网格只来自前 30 秒**（P3 的耗时优化）。尾部拍相位靠「BPM 恒定」假设从 `beatOffsetSec + period` 外推，遇到渐快/变速的歌会偏——这是 P3 裁剪的代价，不是 P4 的 bug。
- **接口里没有单独的 `beatOffsetSec` 对齐**：目前的对齐方式是「量化到整小节」，用的是出场曲的拍长与剩余时间；真正的相位锁定（把进场曲的第一拍卡在出场曲的拍点上）需要知道进场曲的拍相位在**交叉点**的位置，而那需要尾部网格。现在做到的是「长度对拍」，不是「相位对拍」。
- **`bassSwap` 是分频段近似，不是真 stem**：它压的是 200Hz 以下的能量，鼓和贝斯会一起让位，听感是「换鼓」而不是「只换贝斯」。
- **20 对真实曲目的听感抽测没做**：这台机器上只能验数值与规则。
- **`automix` 档的应用端到端**：冒烟（本机设置当时是 `automix`）里能看到 `[pi/automix] plainBlend（5.0s）：缺少可靠拍网格` 与 `段落=8段(副歌类=1)`——说明档位、规划、段落检测都真的进到了应用；但那次过渡因为档案还没算完而退成了 `plainBlend`，所以**结构混音本身的听感仍需真机第二遍确认**。

### P5 · 产品化（5–7 天）

- 设置页：模式（关/淡变/交叉/智能）、长度档位、是否允许变速；
- 就绪标记（哪些歌已分析完）；
- 过渡期间视觉（复用 `SongChangeCard` 或 tempera 转场）；
- `docs/ADR/0005` 与 `PLAN.md` 索引更新。

**总计：约 6–9 周（单人）。**

---

## 七、未定问题（需要拍板）

### 验证类

- **Q1（已答）** 用 `*`，不回写 `Origin`：请求不带凭据（token 在 URL 里），`*` 对 `file://` 的 `null` origin 同样成立；另补 `access-control-expose-headers` 供将来读 `content-range`。
- **Q2（已答）** 必须两边同时加。只加 `crossOrigin` 而响应没有 ACAO 时，元素直接 `error:4`（不是静默变哑），所以漏加会被 `error` 事件抓到；8 类响应已由单测钉住。
- **Q3（待测）** `preservesPitch` 在 Electron/Chromium 下与 `playbackRate` 的实际行为还没实测——它不影响 P0 结论，放到 P4 变速之前用探针验证。

### 引擎类

- **Q4** 拍点模型用 `small`（8.1MB）还是 `final0`（41MB）？推理跑在哪：渲染进程 WebGPU、Worker + onnxruntime-node、还是 WASM？
- **Q5** 分析音频从哪来：走下载链路拿完整文件、还是 Range 取首尾 30 秒？前者准但慢，后者快但看不到全曲。
- **Q6** 分析窗口取多长：全曲、首尾各 30 秒、还是首尾 + 副歌段？直接决定 P3 的工作量与效果。
- **Q7** 没有模型（首次启动、模型缺失）时，是退回 DSP 估算（≈20% 可用）还是直接禁用 AutoMix 档？

### 产品类

- **Q8** 哪些歌启用 AutoMix：全部（边播边分析）、仅已分析完成的、还是仅本地/已下载文件？UI 怎么表达「就绪」？
- **Q9** 过渡长度给几档：2/4/8 小节（Spotify 式）、秒数（Apple Crossfade 式），还是两者都给？
- **Q10** 「跳过前奏」默认关，但要不要在设置里给一个「更激进」的档？这会让部分歌从副歌开始。
- **Q11** 过渡期间歌词页显示什么：保持当前歌的最后一句、切到下一首、还是叠一层「即将播放」卡片？
- **Q12** 要不要显示 BPM/Key（像 Spotify 的 Mix 功能那样给用户排序用）？需要额外的调性分析。

### 工程类

- **Q13** 双 deck 的元素是常驻两个还是按需创建？常驻省时但多占一份解码缓冲。
- **Q14** 分析缓存放哪（`userData` 下）、配额多大、什么时候清？
- **Q15** 过渡中用户点暂停/切歌/拖进度条时，撤销与恢复的精确规则？需要列一张条件表。
- **Q16** 听感评估怎么做：几个人、多少对、是否盲测？如果不做，就只留「客观指标 + 自测」并写清楚这个局限。
- **Q17** 性能预算：分析时的 CPU 峰值上限、内存上限、对首屏的影响，定多少？

### 合规类

- **Q18** Beat This! 的 MIT 声明放在哪（`LICENSE` 附录 / `CREDITS.md` / 设置里的第三方许可页）？
- **Q19** 如果将来引入其他模型，许可证准入线怎么定？建议写死为「MIT / Apache-2.0 / BSD 可用，AGPL 不可用」。

---

## 八、风险与回退

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| CORS 加完仍有零样本 | 低 | 方案作废 | P0 就是干这个；失败退回 P1 |
| 双 deck 破坏「切页面不断音」 | 中 | 回归 | 元素仍挂模块单例，不进 React 生命周期 |
| 解析链偶发失败 | 中 | 过渡中断 | 一律回退现有切歌，不静默 |
| 网络流 seek 不可靠 | 中 | 入场对齐失效 | 入场不做 seek，只对本地/下载文件开 |
| 分析拖慢主线程 | 中 | 卡顿 | Worker + 降采样 + 只分析首尾 |
| 磁盘缓存膨胀 | 低 | 占空间 | 上限 + LRU 清理 |
| 听感回归无人发现 | 中 | 效果变差 | 每次改参数必须复跑固定样本并记录 |

---

## 九、明确不做（挂账）

- **htdemucs 分轨**（v1 不做；`bassSwap` 用分频段近似，人声退场用歌词）。
- **build-up 表现模式**（依赖分轨，整条不做）。
- **离线渲染成品音频**（LiveSort 那种批处理形态，不是播放器该做的事）。
- **DJ 级功能**：甩盘、回声抛掷、调性匹配。
- **对任意歌即时 automix 的承诺**。

---

## 十、许可证合规

| 来源 | 许可证 | 能用什么 |
|---|---|---|
| folia-major | AGPL-3.0 | **只学思路与数值**，不复制代码 |
| LiveSort | 无许可证 | **只学思路**，不复制代码 |
| qplayer | Apache-2.0 | 可参考实现，建议独立重写 |
| Beat This! | MIT（代码与权重） | 可随包分发，需保留声明 |
| Essentia.js | AGPL-3.0 | **排除** |
| aubio | GPL-3.0 | 兼容，可作备选 |
| PI 本体 | GPL-3.0-or-later | — |

---

## 十一、下一步

建议顺序：**先 P0 验证 CORS，同时把 Q1–Q3 实测掉**。这三件事的结果决定后面所有排期，其余问题可以边做边定。
