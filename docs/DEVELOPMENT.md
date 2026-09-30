# PI

桌面音乐应用：接入网易云音乐的数据（歌曲 / 歌单 / 评论 / 登录），并按「多源音源解析链」尽可能拿到无损。

- 技术栈：Electron + React + TypeScript + Vite，pnpm monorepo
- 设计文档：[`docs/PLAN.md`](docs/PLAN.md)（需求 → 架构 → 里程碑），接口清单 [`docs/API-MAP.md`](docs/API-MAP.md)，决策记录在 [`docs/ADR/`](docs/ADR)
- 主题：白底 + 天蓝点缀（`--pi-primary #1F9BFF`）+ 播放器/歌词面板用「液态玻璃」质感，听歌详情页取专辑封面模糊色
- 鸣谢与借鉴来源：[`docs/CREDITS.md`](docs/CREDITS.md)——歌词舞台的版式/逐字数值参考 [`chthollyphile/folia-major`](https://github.com/chthollyphile/folia-major)（AGPL-3.0，只取数值与做法，不复制其代码），文件里同时登记了 folia 致谢的项目与「我们到底用没用」

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | `>= 22.12.0`（Electron 44 与 Vite 8 的下限） |
| 包管理器 | pnpm `10.x`（`corepack enable` 或 `npm i -g pnpm`） |
| 系统 | Windows 10/11、macOS 10.15+、Linux（glibc ≥ 2.28） |

> 本仓库**不使用 npm**（在某些 Windows 环境下 npm 的 shim 已损坏）；所有命令都用 `pnpm`。

## 快速开始

```bash
pnpm install          # 安装依赖
pnpm electron:install # 首次必须：下载 Electron 运行时（约 250MB）
pnpm dev              # 同时启动 Vite 与 Electron
```

`pnpm dev` 会：启动渲染进程的 Vite 开发服务器 → 等它就绪 → 再启动 Electron 主进程。

> **关于 `pnpm electron:install`**：Electron 44 起不再有 `postinstall`，运行时二进制改在首次
> `require('electron')` 时懒下载。不预热也能跑，但第一次 `pnpm dev` 会静默下载 250MB，
> 看起来像卡死（日志里会先出现 `Downloading Electron binary...`）。CI 请显式预热。
> 详见 [`docs/ADR/0003`](docs/ADR/0003-Electron运行时与内嵌API分发.md)。

### 调试用环境变量

| 变量 | 作用 |
| --- | --- |
| `PI_DEV_SERVER_URL` | 让主进程加载 Vite 开发服务器而不是本地产物 |
| `PI_RENDERER_DIST` | 显式指定渲染进程产物 `index.html` 的路径 |
| `PI_NCM_PORT` | 固定内嵌网易云 API 的端口（排障与自动化测试用） |
| `PI_SOFTWARE_RENDERING=1` | 强制软件渲染（低端机 / 虚拟机 / 远程桌面） |
| `PI_SCREENSHOT=<路径>` | 首屏加载后自动截图并退出（无人值守冒烟测试用）。截图前会断言 `window.pi` 存在，缺 preload 桥时以 exit 1 退出 |
| `PI_IPC_LOG=1` | 主进程逐条打印收到的 IPC 通道调用，用于区分「桥没通」和「后端没数据」 |
| `PI_MEDIA_PORT` | 固定本机音频代理的端口（默认随机；排障用） |
| `PI_SMOKE_PLAY=<songId>` | 无窗口的播放链路冒烟：`/song/detail` → 解析音源 → 探针 → 经本地代理取前 1KB，全通过 exit 0。可写 `auto` / `recommend` 取每日推荐前 3 首 |
| `PI_SMOKE_UI=1` | **UI 级冒烟**：真开窗口、真点歌单行，读 `window.__piAudio` 判定出声（必须看到 `currentSrc` 换掉才算换歌）、验证切页面不断音、**统计封面 `naturalWidth`**（有真失败或明文 http 地址就 exit 1），并按现界面断言：**空白初始页**（清掉 `pi:last-played` 重载后必须是空态）、**首屏悬浮球**（第一帧就必须是 56px 的球、`data-snapped=none`，不能是贴边细条——`PI` 两个字在细条里也读得到，所以这条只看盒子尺寸与 `data-snapped`）、**环形菜单**（左半 8 个导航 / 右半 5 个播放 / 球字 `PI` / 进度圈 / 半径 ≤140px / 任意两键中心距 ≥45px（按键直径 44，第八版收紧） / 静息时一律不显文字）、**单键升起**（真实鼠标事件：命中的那个键位移 ≈12px、其他键 <2px 且不显文字）、**设置框**（点设置键：一圈按键逐个坠入 → 球塌缩到窗口中心 → 从中心流出设置框；主区里不能出现整页 `.pi-settings-frame`）、**歌单卡片面板**（第十五轮第 2 条起：绕球的封面环已删——点「我的歌单 / 收藏歌单 / 推荐」时在球旁边开出一块卡片面板，断言面板的 `data-playlist-cards` 来源、`data-playlist-cards-state`、卡片张数与每张卡的名字/首数、点一张卡能真的进歌单详情）、**播放器详情页**（**第九版契约**：封面·背景·歌词行数·**名片五项**（封面 / 歌名 / 歌手键 / 专辑键 / 音质）·点名片伸出的操作框与四键 comments/like/info/share·**进度条条内播放键 + 音量键 + 音量弹层 + 音量条**·**旧遮罩与四角键必须不存在**（故意留的反证探针 `旧遮罩=false`）·评论行数）、推荐页折叠、导航抽屉（分组·项数·搜索在顶部·账号区）、以及**悬浮球拖动 + 贴边吸附**（`element.sendInputEvent` 真发 8 条指针事件）、**第四版新增的四组断言**（换页过渡必须「先 `out` 后 `in`」且动画期间旧页还在；点「推荐」出来的是歌单环且每日推荐/私人雷达靠前；点「搜索」出浮层 → 输入关键词 → 出封面卡片 → 悬停能看到歌名/歌手/专辑 → 点卡片进播放页；贴到边上 `data-snapped` 变细条且菜单收起、拉出来菜单自己回来）、**第五版新增的四组断言**（「我的歌单」空态正中一张空白卡片：点它出命名框且自动聚焦、Esc 退回卡片——**刻意不点「创建」**，免得往真实账号里写歌单；点球收起的中间态必须有 `data-closing=true` 且按键动画是 `pi-orb-dive`、收好后按键从 DOM 里消失；「我的喜欢」封面墙的方块数 + 悬停放大/浮层淡入（账号真的一首都没有时只验空态提示，并照实说没量到拼贴）；播放页歌词轨道 `[data-lyric-line]` 的行数/`data-active`/遮罩/模糊行数/`data-hint`），**第六版新增的五组断言**（双击悬浮球 → 回到播放页且菜单收起、按键残留 0；歌单卡片列表 `[data-song-cards]` 的网格/张数/首张封面 `naturalWidth>0`/标题副标题非空/卡片高 ≥100px；歌词字素点亮——数 `.pi-lyricstage__word` 的 `data-word-state` 与 computed `opacity`，必要时用 `window.__piAudio` 把进度拨到 0.42/0.58/0.72 再轮询到真有字素亮起；滚歌词不改播放——原生 wheel 后 `data-view-index` 变大、`data-following=false`、「回到当前」按钮**已删**（`[data-lyric-follow] === null`）、往回滚自己把跟随交还，而 `window.__piAudio.currentTime` 只前进 <1.5s；帧率——`requestAnimationFrame` 采样展开/坠入/封面环拖动，打印帧数与 p50/p95/掉帧，**只有窗口在前台时这组数才可信**）、**第八版新增的三组断言**（**无操作自动隐藏**——把 `documentElement.dataset.piIdle` 打开并真发一次 keydown 重新计时，静置 3.9s 后名片与球的 computed opacity 都到 `0.00`、**进度条恒为 `1.00`**（第十版第 3 条明确要求「进度条去掉隐藏」，所以这一项从「三件一起隐」改成「两件隐、进度条不隐」，探针打印 `静置 名片/球=0.00/0.00、进度条=1.00`），把指针移到名片/球上时只有被指到的那一件回 `1.00`（探针先 `mouseMove` 到标题栏，免得上一段留下的僵住 `:hover` 把读数弄脏），收工都回 `1.00`；**点歌词定位**——真滚轮往回 3 行后真点那一行的中心，`data-active-index` 回到被点的那一行、`data-following` 回 `true`、播放位置回退 ≥1.5s；**卡片列表浮层 + 实时高亮**——卡片流拖动的每一帧 `data-focus-index` 都跟着变、中心卡不透明度 1/相邻 0.45），结束截图并退出。**第十六轮（删悬浮球）起**：上面那些悬浮球 / 环形菜单 / 封面环 / 球拖动贴边 / 双击球回播放页的断言已随球删除而退役（脚本里留成恒假的 `r16LegacyProbe`，不再逐条打 ✗），代之以**十六轮十四项**：①空白处点出 PI 键（`data-quick-orb`，两次点击位置误差 0px）②上划六块按键卡（`data-quick-item` 六项 star/mine/recommend/recent/local/queue）③右划迷你设置卡（`data-quick-switch` 四个开关 + 进详细设置）④下划开搜索浮层（`.pi-searchoverlay[data-open=true]`，Esc 收起）⑤切歌时左下角名片自弹（`data-reveal=true`，3.4s 后落回）⑥底栏停止键 40×40 / 轨道 6px / 滑块 12px ⑦歌单列表卡片化（`.pi-plcard` 或 `[data-playlist-card]`，老 `.pi-songrow` 必须为 0）⑧歌曲卡片封面不被裁（盒子近正方、封面不越界）⑨拼贴悬停互动（`z-index`/`filter`/`box-shadow`/封面 `scale` 任一变化）⑩点「在播且已放大」的拼贴进播放页（`data-collage-entering`）⑪拼贴拖拽翻页加载（`data-collage-loaded` 变大或 `data-collage-page-has-more` 转 false）⑫拼贴底栏仍在、点它能定位回在播拼贴（那一格回镜头中心 ≤15% 视口）⑬拼贴页滚轮向下开搜索、输入关键字定位到拼贴（`data-collage-hit`）⑭悬浮球与环形面板已无残留（`.pi-orb__plcards` 计数 0）。不要与 `PI_SCREENSHOT` 同用 |
| `PI_SMOKE_UI_SHOT=<路径>` | 指定 UI 冒烟主截图的输出路径（默认 `docs/m3-shell.png`） |
| `PI_SMOKE_UI_SHOT_EMPTY` / `_ORB` / `_RING` / `_HOVER` / `_SETTINGS` / `_COVERS` / `_QUEUE` / `_HOME` / `_FOLDS` / `_NAV` / `_RECOMMEND` / `_SEARCH` / `_STRIP` / `_LIKED` / `_CARDS` | 分别指定空白初始页、收起态悬浮球、展开的环形菜单、悬停某个按键（那一下的升起 + 文字）、点设置键后塌缩/流出设置框（第八版）、歌单卡片面板（第十五轮第 2 条起；原来绕球的封面环已删）、队列（第九版起是卡片浮层 `[data-songs="queue"]`，不再是行列表抽屉）、播放器详情页、推荐页折叠、导航抽屉、点「推荐」出来的歌单环、搜索浮层（悬停在卡片上）、贴边细条、我的喜欢封面墙、歌单卡片列表十五张过程截图的路径（默认 `docs/m3-empty.png`、`m3-orb.png`、`m3-orb-ring.png`、`m3-orb-hover.png`、`m3-orb-settings.png`、`m3r15-orb-plcards.png`、`m3-queue.png`、`m3-home.png`、`m3-folds.png`、`m3-nav.png`、`m3-orb-recommend.png`、`m3-search.png`、`m3-strip.png`、`m3-liked-wall.png`、`m3-playlist-cards.png`）；**第十六轮起**这些球 / 环相关的图（`m3-orb*.png`、`m3-strip.png`、`m3-orb-recommend.png`）已随悬浮球删除而退役（脚本里那两条 `console.info('截图：…')` 还在，但它们不再对应任何断言），新增的六张成品图由脚本按固定路径写出、不占 env 变量：`docs/m3r16-quick-orb.png`（点出的 PI 键 + 六块按键卡）、`m3r16-quick-settings.png`（右划的迷你设置卡）、`m3r16-home-bar.png`（40px 实心播放键 + 6px 轨道）、`m3r16-songcards-cover.png`（卡片封面不再被裁）、`m3r16-collage-hover.png`（拼贴悬停互动）、`m3r16-collage-enter.png`（点进播放页的放大那一帧） |
| `PI_SMOKE_SHOT_THEMES=1` | **歌词动效成品图**（第十版起，配合 `PI_SMOKE_UI=1`）：在播放页上走**真 UI**（球 → 设置键 → 歌词页签 → 主题按钮，每步都打日志并轮询到「面板真的出现 / 设置真的落进 react-query 缓存」为止）依次切到 `fume` / `cadenza` / `partita` / `tilt` / `pendolo` / `classic`（**第十二版起六套全拍**），各拍一张 `docs/m3-lyric-<主题>.png`，**拍完把用户原来那套主题切回去**（初值从设置里读，所以哪怕这一跑没有歌也能还原） |
| `PI_SMOKE_SET_THEME=<主题>` | 只走同一条 UI 链路把歌词主题钉到指定的一套（不拍照）。用途是**冒烟自己收拾自己**：来回切主题时万一中途失败，别把用户落盘的偏好留在别的主题上（实际就是用它把被上一轮留下的 `partita` 还原成 `classic`） |
| `PI_SMOKE_SPIN=1` | **流光逐字旋转的成品图与断言**（第十四轮新增，配合 `PI_SMOKE_UI=1`）：经真 UI 把设置页那张卡上的「流光 · 逐字旋转」临时点开 → 拍 `docs/m3r14-lyric-classic-spin.png`（不覆盖用户默认状态的 `docs/m3-lyric-classic.png`）→ 量 `.pi-lyricstage__word[data-word-spin]` 的 computed 旋转角，要求「歪着的 ≥1 个、最大角 ≤12°、舞台根 `data-word-spin=true`」→ **收尾时把开关点回用户原来的值**（与主题还原同一段） |
| `PI_SMOKE_SOURCES=1` | **音源体系冒烟**（无窗口）：搜 6 首歌逐首解析，打印每条的 `via` / 标称 / **实测**容器·采样率·码率 / 是否试听，统计「解析成功数 / 经代理取到字节数 / 第三方数 / 无损数」，最后关掉第三方总开关重解同一首做**反证**（attempts 里不该再有 `unm`/`lx`），全通过 exit 0。可配 `PI_SMOKE_QUERY`（默认 `周杰伦 晴天`）。它会在结束时把设置恢复原样 |
| — | 上面这条冒烟同时验 **L4 本地源**：先在仓库内 `.smoke-local/` 造一个 44100Hz 的最小 FLAC 并指给「本地曲库」，再解析一个不存在的歌 id（官方源必然返回 null），断言 `via=local`、实测 flac 44100Hz、且真经代理从磁盘取到字节；跑完删掉临时目录（`.smoke-local/` 已在 `.gitignore`） |
| `PI_SMOKE_SETTINGS=1` | **设置页冒烟**（真开窗口）：点标题栏最左边那颗 `PI` 品牌键开抽屉（`[data-nav-toggle]`，第十六轮删悬浮球后这是抽屉的唯一入口）→ 点文本含「设置与音源」的 `.pi-navitem`，断言卡片数、音源表里至少有官方与其它音源、以及「本地曲库 / 第三方音源 / 允许第三方无损」三项都在，并读一遍本地曲库输入框；再点「音质日志」，断言标题与已记录的解析条数；再点「歌词」页签，断言 6 套主题的按钮都在、选中一个与当前不同的主题确实**写进了设置**（再把原来那套点回来，冒烟不该改掉用户存下的偏好），并断言第十轮新加的那张「**歌词动效参数**」卡有全部 **17 个旋钮**（第十四轮从 6 项扩到 17 项：多一个少一个都判红——`themeOpacity`/`fontScale`/`motionAmount`/`glowIntensity`/`fpsCap`/`randomThemePerSong` + 第十四轮新增的 `fumeCameraFollow`/`fumeCameraSpeed`/`classicWordSpin`/`partitaGuides`/`partitaStaggerMin`/`partitaStaggerMax`/`pendoloDialRadius`/`pendoloArcAngle`/`pendoloEscapeForce`/`pendoloFocusScale`/`pendoloCoverOnDial`）+ 1 枚复位键，另验一次「流光 · 逐字旋转」开关的 UI 往返（点一下翻面且存盘跟着变、再点回原值）。全通过 exit 0。顺手拍两张图：`docs/m3-settings-frame.png`（刚打开的设置框——第十轮第 1 条把顶部那张大封面与黑胶删掉了，探针只断言文字看不出来，得看图）与 `docs/m3-settings-lyric.png`（歌词页签 + 动效参数卡）。可用 `PI_SMOKE_SETTINGS_SHOT` / `PI_SMOKE_SETTINGS_LYRIC_SHOT` 改路径。编译通过证明不了渲染不炸（preload 失败是静默的），所以这一条必须真开窗口 |
| — | 所有冒烟都跳过单实例锁（否则残留实例会让新进程静默退出、你看到的还是上一轮日志），并在日志首行打印 `pid + 时间`；跑之前最好先 `Get-Process electron | Stop-Process` |
| `PI_CHILD_HEAP_MB` | 两个**子 Node 进程**（内嵌网易云 API `packages/ncm-server`、LX 音源沙箱 `packages/source-lx`，都用 `ELECTRON_RUN_AS_NODE` 起）的 V8 老生代堆上限；默认 **384**，小于 128 时按 384 算。写成 `spawn(process.execPath, ['--max-old-space-size=<MB>', '--max-semi-space-size=8', entry])`，**堆参数必须排在入口脚本之前**，否则会被当成脚本参数。两个包各留一份 `childNodeFlags()`（互不依赖）。改大改小都要重启应用才生效 |

## 启动应用（日常使用）

不用开发服务器，双击就行：

| 方式 | 说明 |
| --- | --- |
| 桌面快捷方式「PI 音乐」 | 走 `scripts/pi-silent.vbs`：**无控制台窗口**，全部输出追加到仓库根的 `pi-launch.log`，启动失败会弹窗告诉你日志在哪 |
| `PI.cmd`（仓库根） | 同样的流程但保留控制台，排障时用它。产物缺失时自动 `pnpm build`；`set PI_ALWAYS_BUILD=1` 可强制每次重建 |
| `pnpm start` | 等价于 `pnpm -F @pi/desktop start`，假定已经 `pnpm build` 过 |

> `PI.cmd` 启动前还会跑一次「Chromium 沙箱预检」：把 `node_modules\electron` 的完整性级别补回 Medium。
> 仓库目录一旦被外部工具标成 Low 完整性，Electron 会在建沙箱时直接崩掉、**一行日志都没有**（见「常见问题」第一条）。
> 这一步已经是 Medium 时是无操作，耗时几毫秒。

> **两个启动脚本都只能是纯 ASCII。** `cmd.exe` 按 OEM 代码页解析 `.cmd`，WSH 按 ANSI 读 `.vbs`；
> 中文写进去会变成「'xxx' 不是内部或外部命令」，或者在静默模式下弹一个没人看得见的「Invalid character」框——
> 用户看到的现象就是「双击毫无反应」（`wscript` 进程还在，日志却根本没生成）。中文一律留在应用界面里。
>
> `chcp 65001` 只允许出现在纯 ASCII 脚本的**第二行**（`PI.cmd` 就是这么做的）：它让应用输出的中文日志在控制台里可读，
> 而文件全 ASCII 时字节偏移等于字符偏移，不会破坏 cmd 的解析。反过来，文件里有中文再用 `chcp` 去救，
> 就会在 cmd 解析到文件中间时切换代码页，让它按错误的偏移继续读、把后半行当命令执行。
>
> 另一个坑：`if (...)` 块里不许出现未转义的 `(` `)`——例如 `echo ... (about 10 seconds)` 里那个 `)` 会**提前闭合代码块**，
> cmd 只报一句 `此时不应有 ...。`，然后整个脚本一行都不执行。因为 cmd 是「先把整块解析完再执行」，条件为假也照样炸。
> 排障时用 `cmd /c "<仓库>\PI.cmd"` 直接看输出，比猜测快得多。
>
> 图标由 `pnpm icon` 生成（`build/pi.ico`，零依赖脚本），Electron 窗口与桌面快捷方式共用它。

## 构建

```bash
pnpm typecheck        # 全仓类型检查（tsc 只做检查，不做构建）
pnpm build:renderer   # 渲染进程产物 → apps/renderer/dist
pnpm build:desktop    # 主进程 / preload 产物 → apps/desktop/out
pnpm build            # 以上全部（turbo 编排）
```

## 打包与安装

```bash
pnpm icon             # 生成 build/pi.ico（窗口/快捷方式）与 build/pi-embed.ico（写进 exe）
pnpm dist             # 便携版 → release/pi/（绿色目录，双击 pi.exe 即跑，目标机不需要 Node.js/网络）
pnpm installer        # 安装包 → release/PI-Setup-<版本>.exe（C# 自解压安装器，向导式）
pnpm installer:nsis   # 已弃用：旧的 NSIS 路线（见下文「为什么换成自解压」）
pnpm release          # 一条龙：build → dist → installer
```

- **便携版** `release/pi/`：整个目录就是应用本体，自带 Electron 运行时；卸载跑目录里的 `卸载 PI.cmd`。
  它同时是安装包的**载荷来源**（`pnpm installer` 默认吃 `release/pi`，所以先要有它）。
- **安装包** `release/PI-Setup-<版本>.exe`：装到 `%LOCALAPPDATA%\Programs\PI`（按用户，不需要管理员 / UAC），
  建开始菜单项，并在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\PI` 登记 ⇒
  「设置 → 应用 → 已安装的应用」（旧称「应用和功能」）里能看到 PI，也能从那里卸载。
- 两种产物用的是**同一份**应用目录（`scripts/lib/app-dir.mjs`），并且 `pi.exe` 的内嵌图标与版本信息
  都会被 `scripts/patch-exe.mjs`（resedit，纯 JS、不联网）改写成 PI —— 文件属性页、资源管理器、
  任务管理器里显示的都不再是 Electron。
- 安装包是 `scripts/pi-app.cs`（C# 单文件，用系统自带 `csc.exe` 编译）**自解压**出来的一个 exe：
  应用目录被 deflate 压在自己尾巴上（尾部 32 字节 trailer：`PIPAYL01` + 数据偏移 + 数据长度 + 原始字节数），
  运行时边读自身边解压到目标目录，**全程不落地任何临时文件**。
- **为什么换成自解压**（详见 `docs/PLAN.md` §4.34）：用户双击 NSIS 版时弹过
  `NSIS Error: Error writing temporary file. Make sure your temp folder is valid.`；这条文案在 NSIS 源码里
  只可能来自「整块压缩 `/SOLID` 把整个载荷先解压进 `%TEMP%`」或「插件解压到 `$PLUGINSDIR`」两条路，
  而我们的包两条都不走（zlib 非整块、零插件）。**2026-09-30 定案**：真因是同一个 Low 完整性标签 ——
  NSIS 无论走哪条路都要往 `%TEMP%` 写，而 Low 进程写不了 Medium 的 `%TEMP%`，于是报出那句文案；
  本机「复现不出来」也是因为本机 `release\` 里的 exe 同样带 Low（见 §4.34 ⑥）。
  即便如此仍保留自解压路线：它**结构上完全不碰 `%TEMP%`**，比 NSIS 少一整层可失败点，改动成本也已经付了。
  旧的 NSIS 脚本（`scripts/pi-installer.nsi` / `pi-uninstaller.nsi` / `make-installer.mjs`）保留作历史记录，
  入口是 `pnpm installer:nsis`。
- 安装器做的事：解压到 `%LOCALAPPDATA%\Programs\PI`（**向导里可以改**：直接编辑输入框，或点「浏览…」
  选一个文件夹 —— 选已有文件夹时会自动往下建一层 `PI`，避免 Electron 运行时散进你的目录里；按用户装，
  不需要管理员 / UAC）→ 写
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\PI`（`DisplayName` / `DisplayVersion` /
  `DisplayIcon` / `Publisher` / `InstallLocation` / `UninstallString` / `QuietUninstallString` /
  `NoModify` / `NoRepair` / `InstallDate` / `EstimatedSize`）⇒「设置 → 应用 → 已安装的应用」（旧称「应用和功能」）
  里能看到 PI、也能从那里卸载 → 建开始菜单与桌面快捷方式。注册表先走 .NET API，失败自动回退系统 `reg.exe`；
  注册表或快捷方式失败**不会**让安装白干（只记警告）。
- 卸载器是同一份源码用 `/define:UNINSTALLER_MODE` 编出来的 `卸载 PI.exe`，随包装在应用目录里；
  它**优先按自己所在的目录**定位安装位置（注册表丢了也能卸干净），删完文件交给系统 `cmd` 延时删目录，
  用户数据 `%APPDATA%\PI` 保留 —— 卸载同样不写临时文件。
- 安装日志按**三级回退**落盘（同时回显到 stdout，`--log <路径>` 可强制指定第一级）：
  `%LOCALAPPDATA%\PI\安装日志.txt` → `%TEMP%\PI-安装日志.txt` → **安装包自己所在的目录**。
  失败时错误框里显示的是**实际落点**（不是首选路径），日志第二行写明「首选位置写不进去，已退到…」；
  万一安装失败，把这份日志发回来就能定位停在哪一步。
- 报错 `对路径"…"的访问被拒绝` 时怎么读：这是**写权限**问题，不是安装包坏了。头号原因是
  **exe 自己带着 Low 强制完整性标签**（同「常见问题」第一条的机制：进程的完整性级别跟着 exe 走，
  Low 进程写不了 Medium 的 `%LOCALAPPDATA%` / `%TEMP%` / HKCU，却能写自己所在目录 —— 所以症状是
  「能往安装包旁边写日志、装到哪个正常位置都被拒」）。构建链已修：`scripts/lib/integrity.mjs` 把成品
  改回 Medium，`make-csharp-installer.mjs` 还把它当**硬自检**（不是 Medium 就不许出货）。
  万一手里是旧包：把安装包**复制到桌面**再双击，或执行
  `icacls "<安装包路径>" /setintegritylevel Medium`。
  次要来源：安全软件（如 360 主动防御 `ZhuDongFangYu`）拦截无签名程序的写入。
- 静默/脚本化安装：`PI-Setup-<版本>.exe --silent --target <目录> --no-shortcuts`；
  自检时可用环境变量 `PI_DEBUG_REG_ROOT` 把卸载登记写到别的键下，不污染真实卸载项。

## 目录结构

```
apps/
  desktop/           Electron 主进程 + preload（esbuild 打包）
  renderer/          React 界面（Vite 打包，file:// 加载）
packages/
  shared/            零依赖领域模型与常量（跨进程共享）
  ipc/               通道契约 + zod 校验（渲染进程唯一的对外出口）
  store/             StorageDriver 抽象 + JSON 文件实现
  ncm-client/        网易云接口客户端（把后端响应翻译成领域模型）
  ncm-server/        内嵌网易云 API 子进程的托管（端口分配 / 健康检查 / 重启）
  resolver/          音源解析链（L0 官方 → L1/L3 第三方 → L4 本地，含字节嗅探反虚标与健康降权）
  source-core/       音源契约（MusicSource / MatchInput / 音质映射）
  source-official/   L0：官方 /song/url/v1 的 lossless→hires→…→standard 阶梯 + 试听识别
  source-unm/        L1：内嵌 UnblockNeteaseMusic 的 match() 多平台匹配（库调用，无系统侵入）
  source-lx/         L3：LX Music 自定义源协议 + 子进程沙箱（白名单 lx API）
  source-local/      L4：本地文件夹兜底（歌名/歌手/时长硬条件匹配）
  player-core/       纯逻辑播放队列（列表循环 / 单曲循环 / 随机，零 DOM）
PI.cmd                 带控制台的启动器（缺产物自动构建）
scripts/dev.mjs        开发启动器（零依赖）
scripts/pi-silent.vbs  桌面快捷方式用的静默启动器（纯 ASCII）
scripts/make-icon.mjs  零依赖图标生成器（PNG + ICO）
scripts/make-dist.mjs  便携版打包 → release/pi/（并在打包中改写 pi.exe 内嵌资源）
scripts/make-csharp-installer.mjs 安装包打包 → release/PI-Setup-*.exe（csc 编译 + 自解压载荷）
scripts/pi-app.cs       安装器/卸载器单文件源码（GUI + --silent；自解压、零临时文件、无外部依赖）
scripts/make-installer.mjs 已弃用：旧的 NSIS 打包（对应 pnpm installer:nsis）
scripts/pi-installer.nsi   已弃用：旧 NSIS 安装脚本（保留作历史记录）
scripts/pi-uninstaller.nsi 已弃用：旧 NSIS 卸载脚本
scripts/patch-exe.mjs  改写 exe 的 PE 资源（内嵌图标 + 版本信息，resedit，不联网）
scripts/lib/app-dir.mjs 应用目录装配（便携版与安装版共用同一份实现）
scripts/probe-unm.mjs  UNM 直连诊断脚本（绕过 Electron 单独验 match()，看 br=999000 即 FLAC）
build/pi.ico           应用图标（窗口 / 快捷方式，由 pnpm icon 生成）
build/pi-embed.ico     写进 exe 的图标（BMP 帧，由 pnpm icon 生成）
```

## 架构约束（改代码前请先看）

1. **渲染进程不做任何直接网络/文件访问。** 一切经 `@pi/ipc` 的通道契约走主进程，出入参都有 zod 校验。
2. **账号安全红线：cookie / `MUSIC_U` 只发往 `127.0.0.1` 的内嵌服务**，绝不允许出现在任何第三方音源请求里。
   代码里用 `MusicSource.needsCookie` 把这条红线写成了类型约束。
3. **不信任任何接口自称的音质。** 一律用 HTTP Range 取前几个字节嗅探容器（`fLaC` / `ID3` / `ftyp` / `OggS`），
   UI 上的音质徽标只显示实测结果。
4. **跨环境可运行是硬约束**（[`docs/PLAN.md`](docs/PLAN.md) §2.6）：禁止原生模块；不依赖用户机器上的 Node；
   系统字体栈不硬编码；图标全部内联 SVG；`safeStorage` 不可用时降级而不是启动失败；无 GPU 时自动回退软件渲染。
5. 不支持 Windows 7/8，不产出 32 位包。
6. **图片地址一律走 `coverUrl()`（主进程侧）或 `coverAt()`（渲染侧）**：网易云不同路由返回的协议不一致，
   `http://` 会被 CSP 的 `img-src` 白名单静默拦掉（现象是「所有歌都没有封面」）。这两个函数负责统一升级 `https` 并追加 `?param=`。
7. **第三方音源默认关闭，首次启用必须二次确认**（[`docs/ADR/0001`](docs/ADR/0001-音源解析链.md) 第 6 条）：
   `enableThirdPartySources` 与 `thirdPartyAcknowledged` 是**与**关系，两个都为 true 才进责任链。
8. **LX 自定义源脚本只跑在独立子进程的沙箱里**（白名单 `lx` API，没有 `require` / `process` / `fs`），
   `lx.request` 经 IPC 回主进程转发；脚本拿不到 cookie。渲染进程也拿不到上游直链——`upstreamHeaders`
   与 `localPath` 在 `publish()` 里就被删掉了。

## 音源体系（M2.5）

一首歌的播放地址由**责任链**逐层尝试，第一个「满足音质要求且通过字节嗅探」的结果胜出：

| 层 | 音源 | 何时用 |
| --- | --- | --- |
| L0 | 网易云官方（`/song/url/v1`） | 一直先试；官方只给试听片段时**不当作命中**，继续往下走 |
| L1 | 内嵌 UnblockNeteaseMusic（kugou / bodian / migu） | 歌单里变灰、官方没版权时；**默认关闭，首次启用要过风险确认** |
| L2 | 其它聚合源 | 留位未实现 |
| L3 | 你导入的 LX Music 自定义源脚本 | 前两层都没货时的兜底；脚本在独立沙箱子进程里跑 |
| L4 | 本地文件夹 | 最后一层：硬盘里的同名文件（歌名 + 歌手 + 时长都对得上才用） |

- **徽标只显示实测结果**：拿 HTTP `Range` 取文件头嗅探容器与采样率。来源自称与实测不一致时会显示
  「标称 X，实测只到 Y」——第三方音源虚标很常见。
- **来源可追溯**：播放器详情页与「音质日志」页显示当前来源；抽屉里的「音质日志」页记录最近 200 次解析（含每个音源成功/失败/耗时）。
- **健康降权**：连续 3 次硬失败自动降权 5 分钟（设置页可见、可手动重试）；「未匹配到这首歌」不算失败。
- **账号安全**：登录 cookie 只发给 `127.0.0.1` 的内嵌服务，任何第三方音源都拿不到。

## 界面（第十六轮改版：悬浮球删除换「空白点出 PI 键 + 上/下/右划」手势 + 歌单列表全部卡片化与封面裁切修复 + 切歌小名片改成播放页名片脉冲 + 拼贴悬停动画/点击放大填屏/无限拖拽/底栏定位/滚轮搜索 + 底部进度条停止键比例）

**第十六轮（用户 m07538 的六条，附参考图 m07537 —— 一张 451×72 的底部控制条裁图：左边一颗占满高度的实心深色圆键（暂停图标）、上方居中歌名「深夜诗人」、下方一行 `01:07 ▬▬▬▬ 03:14`（粗填充 + 浅灰余段）；仍点名参考 `chthollyphile/folia-major`——AGPL-3.0，只借数值与交互，代码没抄）改了这些地方**：

- **所有歌单/歌曲列表一律卡片式**（第 1 条，子代理）：全仓排查后只剩 `components/AddTracksPanel.tsx` 还是「一行行」（旧 `<ul class="pi-addtracks__list">` + `<li class="pi-addtracks__row">`，封面 `coverAt(url, 88)`），本轮 145 → 137 行换成 `<SongCards songs onSelect={add} disablePlay hint=… metaOf=… cardDataOf=… />`；`SongCards.tsx:56` 新增 `cardDataOf?: (song) => Record<string, string|number|undefined>`、`:58` 新增 `hint?: string`（原 `data-*` 与默认行为一字未改）。已经是卡片流的（未改）：`pages/SearchPage.tsx:74`（基准）、`components/SearchOverlay.tsx:110`、`components/PlaylistDetail.tsx:131`、`components/SongListOverlay.tsx:185`、`pages/MinePage.tsx:126`。**照实说**：`components/PlaylistGrid.tsx` 是歌单卡（不是歌曲，本就不适用）；`components/LikedWall.tsx` 是零引用死代码（`MinePage.tsx:4` 注明已被 `SongCollage` 取代），按「不动无关文件」没改；`global.css:471` 的 `.pi-songlist` 与 `global.css:3364-3404` 的 `.pi-addtracks__list/__row/__cover` 成了无引用残留 CSS（`global.css` 本轮不在该子代理的改动范围里）。
- **搜索框下歌曲卡片的封面被裁掉 —— 真因是类名冲撞 + 打包顺序，不是 `object-fit`**（第 2 条）：`styles/song-change-card.css:37-43` 的 `.pi-songcard__cover { flex: 0 0 auto; width: 44px; height: 44px; border-radius: 10px; object-fit: cover }`（切歌小名片的 44px 小封面）与 `styles/song-cards.css:139-151` 的 `.pi-songcard__cover { display: block; width: 100%; aspect-ratio: 1 / 1; … }`（**没有 `height`**）同权重 `0,1,0`；产物 `apps/renderer/dist/assets/index-*.css` 里名片规则在偏移 0/613/702/1157，卡片流在 74310+ ⇒ 逐属性后者胜：`width`/`aspect-ratio` 用卡片流的，**`height: 44px` 漏下来**；宽高都确定时 `aspect-ratio` 不参与换算 ⇒ lg 档封面盒变成 **312×44（只看得见 44/312 = 14.1%）**，里面的 `img { width:100%; height:100%; object-fit: cover }` 把方封面裁成一条横带。修法是 `styles/song-cards.css:107-118` 用**祖先选择器**（`0,2,0` > 名片的 `0,1,0`，不依赖打包顺序）硬复位：`.pi-songcards .pi-songcard { pointer-events: auto; align-items: stretch; max-width: none }`、`.pi-songcards .pi-songcard__cover { flex: 0 0 auto; width: 100%; height: auto; aspect-ratio: 1 / 1 }`、`.pi-songcards .pi-songcard__meta { display: block }` ⇒ 封面盒恢复 lg 312×312 / md 256×256 / sm 224×224（`coverAt` 不动：lg 340 / md 280 / sm 250 像素仍有余量）。**顺带查出另两处同源泄漏**：`.pi-songcard { pointer-events: none }`（名片有意不吃指针事件，而该属性可继承）⇒ 卡片整棵子树不参与命中测试，`document.elementFromPoint(...).closest('.pi-songcard')` 永远拿不到卡片 —— **真人点卡片没反应**（合成 `click()` 与拖动照旧，所以冒烟不一定报）；`.pi-songcard__meta { display: grid }` ⇒ 副标题 `text-overflow: ellipsis` 在 grid 容器上失效。两条都在同一次复位里修掉。
- **切歌小名片删掉，改用播放页左下角那张歌曲名片的「脉冲」**（第 3 条，我落盘）：删除 `components/SongChangeCard.tsx` 与它的挂载（`App.tsx`）；`pages/HomePage.tsx` 新增 `const [cardRevealed, setCardRevealed] = useState(false)` + `lastSongId = useRef<number | null>(null)`，`useEffect([song])` 里首次/换歌时 `data-reveal='true'` 并用 `window.setTimeout(…, 3400)`（原名片的 `SHOW_MS`）落回（定时器在 cleanup 清掉）；`HomeCard` 多一个必填 prop `revealed`，根节点写 `data-reveal={revealed}`；`styles/global.css` 新增 `@keyframes pi-home-card-reveal`（0% `translateY(12px) scale(0.94)` + 主色光晕、38% `scale(1.035)`、100% 回位）与 `.pi-home__card[data-reveal='true'] { animation: pi-home-card-reveal 1.05s cubic-bezier(0.22, 1, 0.36, 1) }`——选 `box-shadow`/`transform` 之外的独立关键帧是因为 `.pi-home__card` 的既有 `:hover`/`[data-actions='true']` 只改 `box-shadow`/`border-color`，**没有 `transform`**，不会互相覆盖。
- **队列拼贴：悬停互动 + 点「在播且已放大」的块放大填屏进播放页 + 一直拖到没有可加载 + 底栏常驻且点击定位 + 滚轮向下开搜索并自动定位**（第 4 条，子代理做组件、我接宿主）：悬停是**纯 CSS**（`styles/song-collage.css:344-421`：描边/落影/z-index/提亮、封面 `scale(1.055)`、文字 `translateY(-3px)`、序号 `-2px + scale(1.06)`、`::after` 只在悬停时生成扫光）；点块的语义改成 `if (isPlaying && isCenter && onEnterPlaying) { setExitingKey(item.key); onEnterPlaying(song) }`（`SongCollage.tsx:813-817`），那一格加 class `.pi-collage__item--exiting`（`animation: none` + `transition: transform 480ms` + `z-index: 60`）并打 `data-collage-exiting`，宿主 `MinePage` 只负责在 `COLLAGE_FILL_MS = 480` 之后 `navigate('home')`（**刻意不 `select`**：那格本来就在播）；填屏用的目标变换来自 `song-collage-geometry.ts:843 viewportFillTransform(rect, viewport)` 与 `:879 collageCellExitTransform(rect, viewport, parentScale)`（位移先按屏幕像素算再 `/ parentScale` 换回世界像素）；「一直拖到没有可加载」= 新 props `hasMore`/`onNeedMore`（`maybeRequestMore()` 只在「贴到已建内容边 + `hasMore` + 同一批 `total` 只发一次 + 400ms 冷却」时回调，宿主接 `fetchNextPage`），**并因此修掉一个真 bug**：`contentBoundsOf` 原来拿最后一个块的列号当右边界，而行主序铺位 ⇒ 300 首在 1440×900 下第 5 行只有 1 块、右边界少算 5 块，`isNearContentEdge` 一进视口就真、`onNeedMore` 连发（增量加载等于不存在），现按实际行/列跨度算（`song-collage-geometry.ts:614-632`，回归断言 `:519-546`）；底栏 = `MinePage` 里 `<div class="pi-collage-bar" data-collage-bar><HomeBar song persistent /></div>`（`HomeBar` 因此导出并支持 `persistent`：常驻档下播放/音量/上下首键一直可见，`.pi-collage-bar` 是 `position: fixed; inset: 0; z-index: 6; pointer-events: none` 的罩子、只有药丸收事件），点罩子空白处（`target.closest('button, input, select, a')` 不命中时）调 `SongCollageHandle.focusPlaying()`（`forwardRef` + `useImperativeHandle`，`SongCollage.tsx:468`）；滚轮向下（`deltaY > 0`）不在组件里绑（**刻意不 `preventDefault`**），由宿主的 `.pi-collage-shell` 接住开一条 `.pi-collage-search` 搜索条，输入关键字调 `focusSong(keyword)`（trim + 忽略大小写匹配已加载歌曲的歌名/专辑/歌手，命中就居中放大并打 `data-collage-hit="true"`）。「我的喜欢」的分页也因此从固定 `offset: 0` 的 `useLikedTracks` 换成新写的 `lib/queries.ts useLikedTracksPaged(enabled, limit = 100)`（`useInfiniteQuery`，`getNextPageParam` 按累计条数要下一页；IPC 的 `PagedRequestSchema` 上限 200、`TrackPageSchema = { tracks, total?, hasMore }`）。
- **底部进度条：停止键与进度条的大小对比照参考图改**（第 5 条，我落盘）：参考图是「键 : 轨道 ≈ 6.5 : 1」（451×72 的裁图里键占满 72px 高、轨道约 10px），而改造前是 38px 键 + 3px 轨道 ≈ 12.7 : 1（轨道太细）⇒ `.pi-home__play` 38 → **40×40 实心圆**（`background: var(--pi-primary)`、`color: #fff`、`overflow: hidden`，底色仍用主题主色而**不是**参考图那颗纯黑键）、进度轨道 3 → **6px**、滑块 10 → **12px**（`margin-top: (6 − 12) / 2 = −3px` 跟着改），`global.css` 里把这两个数提成 `--pi-home-track-thick` / `--pi-home-thumb` 两个自定义属性（轨道画在 UA 影子 DOM 里，探针量不到高度，只能读变量）；`.pi-home__play:hover` 从 `var(--pi-primary)` 改成 `var(--pi-primary-deep)`（静置就是主色实心圆了，悬停必须加深才有反馈）。音量条那两颗数（`--pi-vol-thick` 3px / 滑块 14px / 悬停 6px、18px）**一个都没动**，免得打掉第十五轮第 9 条已验证的读数。
- **悬浮球删掉，改成「点空白处 → 那一点浮出 PI 键 → 上/下/右划」+ 拼贴页滚轮搜索**（第 6 条，子代理做组件、我接宿主）：`components/PiOrb.tsx` **整个文件删除**（`state/ui.ts` 里 `ringPage`/`playlistSource`/`orbOpen`/`toggleOrb`/`closeOrb`/`openOrb`/`orbPos`/`setOrbPos` 整组状态一并拿掉，换成 `QuickPanel = 'none' | 'collections' | 'settings'` + `quickPos: Point | null`（视口坐标）+ `quickPanel`，`navigate()`/`toggleNav()` 会把这两项收干净）；新组件 `components/PiQuickOrb.tsx`（根 `.pi-quick-orb` 带 `data-quick-orb`/`data-quick-orb-x`/`data-quick-orb-y`/`data-quick-orb-hint`，球体 `[data-quick-orb-ball]`；根 `pointer-events: none`、只有球 `auto` ⇒ **不会吃掉播放页的空白点击**）、`components/PiQuickPanels.tsx`（拍立得六块按键卡 + 快捷设置卡）、`components/quick-swipe.ts`（纯函数 `quickSwipeDirection(dx, dy, threshold)`，`QUICK_SWIPE_THRESHOLD = 28`、`QUICK_SWIPE_DOMINANCE = 1.2`）+ `quick-swipe.test.ts`（7 例）；宿主 `pages/HomePage.tsx` 的 `QuickDock()` 管接线：`up` → 六块按键卡、`down` → `openSearch()`、`right` → 快捷设置卡；六块按键的落点 = 收藏歌单 `playlist:star`、我的歌单 `mine:playlists`、推荐歌单 **`playlist:recommend`（本轮给 `PlaylistPage` 重新加回 `tab='recommend'`，走 `/personalized`，不吃登录）**、最近听过 `mine:recent`、本地歌曲 `mine:download`（**照实标注「M4 才落地」**）、播放列表 `openSongs({ kind: 'queue', id: 0, title: '当前播放' })`；快捷设置卡自己读 `useSettings()`/`usePatchSettings()`/`useAccount()`，四行 `[data-quick-switch='lyric|quality|theme|account']`，并有 `[data-quick-more='settings']` 进详细设置页。**照实说**：①「本地歌曲」是**占位**——主进程建了 `LocalLibrary`（`apps/desktop/src/main/services.ts:258-268`）但 `packages/ipc/src/index.ts:577-588` 没有任何列举通道；②「主题颜色」是**半真**——`Settings.theme` 只有 `light|dark|system`，`Settings` 里没有 accent 字段（主色由封面提色写 `--th-*`），所以那一行只能切明暗而不是换主色；③`openSettings()` 不能深链到账号 tab（那个按键只把设置页打开）。原先靠悬浮球进的设置页并没有丢：`components/NavDrawer.tsx` 的「设置与音源」一直直接 `openSettings()`；删球后推荐歌单则靠抽屉新增的那一项（`{ id: 'playlist:recommend', label: '推荐歌单', icon: 'compass' }`）进去。拼贴页那半（滚轮向下开搜索、输入关键字自动定位到歌曲拼贴）见第 4 条。
- **验收**（最终代码树上重跑，日志 `.gate-16th13-ui.log`（167 行）/ `.gate-16th13-settings.log`（23 行））：渲染层 `tsc` **exit 0**、主进程 `tsc` **exit 0**；`vitest` **17 files / 305 用例 exit 0**（第十五轮 16 files / 293，多出来的 `components/quick-swipe.test.ts` 7 例 + 拼贴贴边判定的回归组）；渲染层 `vite build` **exit 0**（235 modules、`dist/assets/index-BZz5pQEy.css 124.79 kB`、`index-Ewoe931g.js 570.92 kB`）、主进程 `node build.mjs` **exit 0**（`out/main.mjs 754.4kb`、`out/preload.cjs 451.5kb`）；`PI_SMOKE_UI=1 PI_SMOKE_SHOT_THEMES=1 PI_SMOKE_SPIN=1` **exit 0**，末行「十六轮十四项总闸」**十四项全 ✓**：`①点出PI键=true ②上划六块=true ③右划设置=true ④下划搜索=true ⑤切歌弹名片=true ⑥底栏比例=true ⑦歌单卡片=true ⑧封面不裁=true ⑨悬停放大=true ⑩点进播放页=true ⑪翻页加载=true ⑫底栏定位=true ⑬滚轮搜索=true ⑭无环形面板=true → 通过`；同一跑里 M3 渲染层验收 **23 段全 ✓**（空白初始页 / 播放器详情页（评论行 35，歌词行 1，主题 classic，情绪背景）/ 推荐页已删 / 导航抽屉 / 歌单空态卡片 / 歌曲卡片流 / 搜索浮层 / 窗口三键浮出 / 浮名不溢出 / 三套铺满整屏 / 逐字旋转 / 时计齿轮转 / 云阶断词 / 云阶字号与高亮 / 歌词常态白与高亮色 / 冒字带旋转 / 浮名结尾缩镜 / 云阶线与字同出 / 音量条两级悬停 / 进度条 150% / 十六轮十四项）`→ 通过`；`PI_SMOKE_SETTINGS=1` **exit 0**（`设置页 ✓｜音质日志页 ✓｜分类边框页与歌词主题 ✓｜歌词动效参数卡 ✓｜逐字旋转开关 ✓｜拍立得外观 ✓ → 通过`，17 个旋钮一个不多一个不少）。数字证据（原文摘录）：①`点(142,108)→球(142,108) 误差=0x0px 球在=true｜点(1028,533)→球(1028,533) 误差=0x0px`；②`层=playlists 面板=true(ready) 项数=6 id=[star,mine,recommend,recent,local,queue] state=[ready,ready,ready,ready,unavailable,ready] 可用=5｜点关闭键=true 层消失=true`；③`层=settings 开关=[lyric,quality,theme,account] 更多设置键=true｜背板=true 点背板关=true 层消失=true`；④`下划后 data-open=true｜Esc 之后仍打开=false`；⑤`点下一首=true｜1.2s 内 reveal=true｜3.4s 后 reveal=false`；⑥`键=40x40 轨道=6px 滑块=12px`（键:轨道 = 6.7:1，参考图是 6.5:1）；⑦`推荐歌单页 .pi-plcard=30（老 .pi-songrow=0）｜我的歌单页 .pi-plcard=119｜详情曲目 .pi-songcard=35 老 .pi-songrow=0`；⑧`进门=(无标题)｜.pi-home=在｜0.5w/0.3h 命中=DIV.pi-lyricstage…｜点出球=是｜浮层=开出来了（输入周杰伦=是，可见卡=5/12）｜判定来源=搜索浮层｜卡封面 img=279.8x279.8 容器=281.6x281.6 object-fit=cover 越界=0px（容差 1） 宽高比 img=1.000 容器=1.000 近似正方=true`——**量的正是用户说的「搜索框下那列卡」**；⑨`干净落点=1 矩形=302x302@283,181 命中自身=true 被遮挡=false…悬停后=格=…/rgba(0, 0, 0, 0.26) 0px /5/saturate(1.08)…文案=matrix(1, 0, 0, 1, 0, -3) 封面=matrix(1.055,…)｜有变化=true｜移开①（命中=IMG.）回落=true｜移开②（目标=705,333，命中=IMG.）回落=true｜两次移开都回落｜matches:true｜clickNav 进入我的喜欢=是 墙在最上层=是`；⑩`第1次点击=播放并放大（格=1:1:4 落点=434,333 命中元素=IMG 放大=true）｜第2次点击=进入中 true 内联=left:2852px; top:1492px; width:808px; height:808px｜切回播放页=true`；⑪八步方向轮转（上/左/上/右/左/下/右/上，每步按视口夹住）里有真的平移与 `已上墙` 增长；⑫点药丸后那一格回到镜头中心；⑬`滚轮向下后搜索条=true（DOM WheelEvent）｜关键字「Sundaland」输入=true｜判定用=[data-collage-hit='true'] × 1（命中格 item=854041 queue-index=12，note=「已定位到第 13 首拼贴」）`；⑭`.pi-orb__plcards=0`。成品图（`docs/`，六张**全部落盘**）：`m3r16-quick-orb.png`（点出的 PI 键 + 六块按键卡）、`m3r16-quick-settings.png`（快捷设置拍立得卡）、`m3r16-home-bar.png`（40px 实心圆键 + 6px 轨道 + 12px 滑块 + 药丸上方两角键）、`m3r16-songcards-cover.png`（搜索浮层里 279.8×279.8 的正方封面卡，越界 0px）、`m3r16-collage-hover.png`（悬停格描边+上提，底栏药丸仍在）、`m3r16-collage-enter.png`（点块后放大填屏的中间帧）。
- **照实记（本轮没做/没验的）**：①「本地歌曲」那块按键是**占位**（`state: 'unavailable'`，卡片上写着「M4 才落地（下载与本地库还没做）」，点了进的是「下载」占位页）——主进程已经有 `LocalLibrary`（`apps/desktop/src/main/services.ts:258-268`），但 `packages/ipc/src/index.ts:577-588` 没有任何列举通道，这一轮没顺手加；②「主题颜色」是**半真**：`Settings.theme` 只有 `light | dark | system`，`Settings` 里没有 accent 字段（主色由封面提色写 `--th-*`），所以那一行只能切明暗、**不能换主色**；③`openSettings()` 不能深链到账号 tab，「账号」那一行只把设置页打开（要深链得给设置页加分组参数）；④拼贴视图只挂在「我的喜欢」这一面（`apps/renderer/src/pages/MinePage.tsx:197`），歌单详情页里的曲目仍是卡片轮播，**没有**做成拼贴墙（用户第 4 条说的是「歌单的歌曲都应该能在队列拼贴的视图里观察互动」，本轮按授权只落了「我的喜欢」这一面 + 一直拖到底加载下一页）；⑤渲染层仍然**没有 DOM 渲染测试**（单测只到几何与纯函数），拼贴的悬停光效、填屏过渡、命中脉冲的**观感**只有探针数值 + 我逐张看成品图，没有逐帧目视；⑥⑨那条悬停判据是「任一内层有变化 + 两次移开都回落」，**合成指针**下 `:hover` 本来就靠 `focusSmoke` 才生效，探针为此每次都要先把指针移到标题条；⑦⑧的判定来源以**搜索浮层**为准，浮层真的开不出来时退化到歌单详情页并在日志里写明（退化那次的 ✗ 是照实判，不是静默放过）；⑪的方向轮转只在能碰到右下边的那几步真正触发 `onNeedMore`，其余步只是把镜头挪到能触边的位置；⑩⑫的前置是「墙上已经有在播格」，没有时最多点 3 个干净格、三次都点不出在播就照实 ✗；⑧删球前那两张遗留图 `docs/m3-orb.png` / `docs/m3-orb-ring.png` 的 `console.info('截图：…')` 两行**还在**（不对应任何断言，也不进判定），要收掉得连 `writeFileSync` 一起改；⑨沙箱里**没有 git 仓库**，改动没法提交（用户自行提交）。

## 界面（第十五轮改版：队列拼贴 3D 俯仰与点击放大成方形 + 环形歌单展示删除换卡片墙 + 进度条 150% 且两端长上下首键 + 歌词常态墨色/高亮渐退 + 冒字带旋转 + 浮名曲尾缩镜到整首可见 + 时计齿轮只随歌词环转 + 云阶线与字同出 + 音量条两级悬停）

**第十五轮（用户 m06435 的九条，附两张参考图，仍点名参考 `chthollyphile/folia-major`——AGPL-3.0，只借数值与交互，代码没抄）改了这些地方**：

- **队列拼贴：3D 俯仰 + 块内重排 + 点击放大成正方形并挤开邻居 + 镜头跟着移过去 + 全屏无白边**（第 1 条，子代理做几何、我补探针）：`components/song-collage-geometry.ts` 新增 `COLLAGE_PERSPECTIVE_PX = 1400`（整墙一个透视，块按世界坐标做俯仰/偏摆）与**块内重排**（放大块内部的小格重排而不是直接盖住邻居）；`SongCollage.tsx` 加 `data-collage-camera`（镜头中心）、`data-collage-reflow`（重排次数）两个冒烟接缝，`handleClickCapture` 开头用 `suppressClickRef` 吞掉拖拽后的第一下 click；点击某块的语义 = `focusSlot(item.ref)`（镜头中心移到它）+ `playCell(...)`（**不跳页**，所以探针还能读到那棵树）。实测 `块=49 共=100 首｜中心=631px 普通=196px 倍数=3.22｜中心字=「79Heart Like CaliforniaB」｜拖拽位移=232px｜中心放大 ✓｜拖得动 ✓｜拖拽中尺寸浮动=0px ✓（大小全程不变）｜点块放大=新块 808x808px 正方形 ✓ 占住中心 ✓（离中心 3×3px）｜旧块=400px 缩回 ✓｜邻居被挤=11 个 ✓｜镜头跟随 ✓`。**没做**：块内重排的**逐帧目视**（只有几何单测 + 上述数值）。
- **环形歌单展示删掉，歌单改用「歌曲卡片」那种卡片墙**（第 2 条，子代理）：`PiOrb.tsx` 1177 → 1045 行——删掉 `RingItem` 那圈封面环、`coverSlots`、`data-ring-spin`、`data-cover-size`、`.pi-orb__cover`、`.pi-orb__caption`；新面板契约 `.pi-orb__plcards` 带 `data-playlist-cards`(mine|star|recommend)、`data-playlist-cards-state`(login|loading|empty|ready)、`data-playlist-cards-count`、`data-playlist-cards-fallback`，每张卡 `data-playlist-card="true"` / `data-playlist-id` / `data-playlist-count` / `data-playlist-name`；新增 `styles/playlist-cards.css`（186 行）与 `components/PlaylistGrid.tsx`。实测 `歌单卡片面板：源=mine:playlists 状态=ready 卡片=119（声明 119）｜首卡=？（202 首）｜点首卡进歌单详情=✓`；`推荐＝歌单卡片面板：卡片=50（声明 50）｜前两张=今天《共鳴》爱不释耳|私人雷达 / 女神异闻录3Reload 音乐集 ✓（真实推荐歌单，虚拟入口与封面环都已删掉）`。
- **进度条：上/下一首键改到轨道**首尾两端上面**（不是旁边），常态不显示、悬停才露出；进度条本体长到原来的 150%**（第 3 条，我落盘）：`HomeBar`（`pages/HomePage.tsx:339`）把两键从常驻行里抽出去，新增 `.pi-home__track` 包住 `[上一首][进度条][下一首]`，两键 `position: absolute; bottom: calc(100% + 2px); opacity: 0; pointer-events: none`，悬停药丸时 `opacity: 1; pointer-events: auto` 且 `scale(0.7 → 1)`；两键让出 22+22+2×6 = 56px 后轨道自动变长，`--pi-bar-width` **一个数都没动**。实测 `轨道 516~671（顶=723 宽=155）｜上一首 cx=516 底=721 下一首 cx=671 底=721（药丸 420~763）｜向上长大 ✓｜进度条不动 ✓｜轨道上方两角键 ✓｜进度条缩短前=155px（改造前约 101px）150% ✓`。
- **所有歌词常态一个墨色，只有高亮句有主题色，且颜色是渐隐过去的**（第 4 条，子代理 + 我写探针）：`styles/lyric-stage.css:44-56` 定义 `.pi-lyricstage { --pi-lyric-ink: #fff; --pi-lyric-fade-ms: 900ms }`，classic 逐字的常态/passed 回到墨色、只有 active 用主题色，`color`/`text-shadow` 过渡 normal 1100ms / short 700ms / micro 520ms；六个主题各自接上（`PartitaTheme.tsx:138`、`CadenzaTheme.tsx:245`、`FumeTheme.tsx:403` + `:1417-1420` 的 `mixColor(主题色, 墨色, passedFade)`、`PendoloTheme.tsx` 行级 slot、`lyric-themes.css` 的 tilt/partita/pendolo 段）。实测 classic `元素=38（passed 36/active 1/waiting 1）｜常态众数色=rgb(26,29,36) 与 ink 一致（占 0.73）｜高亮色=rgb(13,123,208) 与常态不同 ✓｜常态 color 过渡=1100ms ✓`；pendolo `元素=11（passed 10/active 1）｜高亮色=color(srgb 0.121569 0.607843 1)｜过渡 900ms ✓`。**照实说**：本机是**亮档**（播放页幕布由 `--pi-bg #ffffff` 混出），字面纯白会失去可读性，所以 `lyric-stage.css:77-78` 留了一行亮档兜底 `[data-theme='light'] .pi-lyricstage { --pi-lyric-ink: var(--pi-text) }` ⇒ 实测解析出 `rgb(26,29,36)` 而**不是** `#fff`（暗档仍是纯白）；要字面「所有主题纯白」就删这两行。另外这一跑只在 classic / pendolo 采到高亮句，partita / tilt 落在没有高亮句的一帧（记「未量」），cadenza / fume 的常态色是主题内算的（只记录不判定）。
- **流光：冒出来的字带一点旋转**（第 5 条，子代理）：`lyric-stage.css:296-319` 新增 `@keyframes pi-lyricstage-word-spin-in { from { transform: rotate(var(--pi-word-spin, 0deg)) scale(0.5) } to { transform: rotate(0deg) scale(1.4) } }`，只挂 `.pi-lyricstage__word[data-word-state='active'][data-word-spin='true']`（420/260/180ms），仍受设置页「逐字旋转」开关管。实测 `冒字最多=3 个｜挂到入场关键帧的=19 个｜关键帧名=pi-lyricstage-word-spin-in|…` ✓；另有复测 `字=38 歪着的=24 最大角=2.9°`。
- **浮名：歌尾歌词唱完后缩镜，把整首歌词摊开给你看，镜头跟着高亮句走**（第 6 条，子代理做缩镜、我改判据）：`FumeTheme.tsx:432-446 fumeOutroPlan(ms, lastEndMs, paperW, paperH, vw, vh)`——判据只有一条 `positionMs >= lastEndMs`（歌词唱完），`fit = min(vw/paperW, vh/paperH)`、`scale = clamp(fit × 0.94, 0.16, 1)`；镜头 `:454-470 fumeOutroOffset(focusWorld, paperSize, viewportSize, scale)` 把纸面夹进视口并跟当前句；`data-fume-phase`(waiting|active|passed|outro-current|outro-away) / `data-fume-state`(playing|finished) / `data-fume-scale` 是探针接缝。实测 `曲长=196.7s｜末句前 state=playing scale=2.2 块=21 outro 块=0｜推到曲尾后 state=finished scale=0.384 块=32 outro 块=32 ✓`，新判据 `浮名曲尾「整首歌词都在视口里」：缩放=0.398｜越界 L/R/T/B=0/0/0/0px（含已飘走的块=0/0/0/0）｜整首在视口里=是 ✓`；成品图 `docs/m3r15-fume-outro.png` **我看过**：整页歌词（四栏）全在窗口里、当前句高亮。**照实说**：判据原来只有「歌词已结束」而不是「剩余 ≤N 秒」；**用户 m01402 第 3 条已把它作为 M4 剩余项补上**——`FumeTheme.tsx` 新增 `durationMs` prop（`LyricThemeProps` / `LyricStageProps` 透传，播放页从 `usePlayer((s) => s.durationMs)` 取），判据改成 `ms >= lastEndMs || (durationMs − ms ≤ FUME_OUTRO_LEAD_MS = 5000)`，`data-fume-state` 也从两态扩成 `playing | outro-soon | finished`（`fumeOutroSoon` 是纯函数、另有单测）。
- **时计：小齿轮只在歌词环转动时才转，不再一直转**（第 7 条，子代理做驱动、我改采样）：`PendoloTheme.tsx:146-171 pendoloGearDrive(travelRad, ringDeltaRad, epsilon)`，齿距累积 `PENDOLO_GEAR_TRAVEL_RATIO = 6`、每帧阈值 `PENDOLO_GEAR_MOVE_EPSILON_RAD = 1e-4`，小齿轮角 `direction × gearTravel × 6 × (22 / gear.teeth)`（**不再吃墙钟**），两个节点挂 `data-gears="moving"|"idle"`。实测 `停着时的标记=idleidleidleidle（idle 4 次）｜换句（推到 99.4s）后的采样里 moving 2 次｜转完标记=idle ✓`。
- **云阶：引导线和歌词一起出来，不能线先亮、字后到**（第 8 条，子代理）：`PartitaTheme.tsx:440-462 guideStateOf(blockIndex)` 改成**按块门控**——块内任一字素离开 `waiting` 才轮到这条线的入场（同一次 React commit、同一条 0.4s ease-out），`data-guide` 在 `:512` / `:519`。实测 `块=3｜「字还没出线先亮」的块=0 个（要求 0）｜采样到 waiting 0 次 / 入场 24 次 ✓`。
- **音量条两级悬停：停在音量键上时短两成，鼠标压到音量条上才变粗变长**（第 9 条，我落盘）：键上悬停弹层 `scale(1.3, 1.04)`（长度 84 → 约 87px = 满长 109px 的 80%）、轨道 3px、滑块 14px；指针落到**滑杆本体**上时 `.pi-home__volume:hover .pi-home__volpop:hover { transform: translateX(-50%) scale(1.3); --pi-vol-thick: 6px; --pi-vol-thumb: 18px }`（两条 `:hover` 叠起来才压得住 `0-3-0` 的那条规则）⇒ 恢复满长、轨道 6px、滑块 18px。实测 `停在音量键上=视觉=21x87 厚=3px 滑块=14px｜指针落在条上=视觉=21x109 厚=6px 滑块=18px｜短两成 ✓｜落在条上加粗变长 ✓`。
- **验收**：`apps/renderer` / `apps/desktop` 的 `tsc` 各 **exit 0**；`vitest` **16 files / 293 用例 exit 0**（第十四轮 14 files / 271）；渲染层 `vite build` **exit 0**（233 modules、CSS 114.48 kB、JS 571.05 kB）；`apps/desktop` 的 `node build.mjs` **exit 0**（`out/main.mjs 704.7kb`、`out/preload.cjs 451.5kb`）；`PI_SMOKE_UI=1 PI_SMOKE_SHOT_THEMES=1 PI_SMOKE_SPIN=1` **exit 0**，末行聚合 **30 项全 ✓**（新六条：`歌单卡片面板 ✓｜歌单空态卡片 ✓｜歌词常态白与高亮色 ✓｜冒字带旋转 ✓｜浮名结尾缩镜 ✓｜云阶线与字同出 ✓`，另有 `我的喜欢队列拼贴 ✓`——它这轮从「形似」升级到 3D 俯仰 + 点击放大 + 挤开邻居 + 镜头跟随）、`PI_SMOKE_SETTINGS=1` **exit 0**（17 个旋钮 + `逐字旋转开关 ✓` + 拍立得外观）。成品图：`docs/m3r15-fume-outro.png`（曲尾缩镜，**看过**）、`docs/m3r15-orb-plcards.png`（卡片墙歌单面板，**看过**）、`docs/m3-liked-wall.png`（3D 拼贴墙）、六套 `docs/m3-lyric-*.png` 与 `docs/m3r14-lyric-classic-spin.png`。细节与这一轮踩的坑写在 `docs/PLAN.md` §4.17。
- **照实记（本轮没做/没验的）**：①亮档兜底让墨色解析成 `rgb(26,29,36)`（不是字面纯白），要纯白删 `lyric-stage.css:77-78`；②④ 这一跑只在 classic / pendolo 采到高亮句，partita / tilt 记「未量」；③⑥ 的判据是「歌词结束」而非「剩余 N 秒」；④渲染层仍没有 DOM 渲染测试，拼贴的 3D 俯仰与块内重排只有几何单测 + 探针数值、**没有逐帧目视**；⑤歌单「空态卡」这一跑没验到（账号里有 119 个歌单 ⇒ 探针改验网格并如实标注）；⑥沙箱里没有 git 仓库，改动没法提交（用户自行提交）。

## 界面（第十四轮改版：底部控制条按参考图重排 + 「我的喜欢」/心象复刻 folia 的形似 + 浮名镜头跟随当前句 + 流光逐字旋转开关 + 云阶字号错落与当前句放大 + 时计小齿轮转动与表盘四旋钮 + 切歌小名片重做）

**第十四轮（用户 m05281 的八条，附六张参考图，仍点名参考 `chthollyphile/folia-major`——AGPL-3.0，只借数值与交互，代码没抄）改了这些地方**：

- **底部控制条按参考图 1 重排**（第 1 条，用户逐条点名六项）：`--pi-bar-width` `clamp(226px, 27%, 420px)` → **`clamp(248px, 29%, 440px)`**（条再长一档）、药丸圆角 `22px → 999px`、悬停高度 **64 → 56px**（上一轮长到 64 是为了给顶角那两键腾地方；这轮两键进了行内，那 20px 不再需要，但**仍然只往上长**——常驻那一行钉在药丸下沿，进度条的位置与长度一动不动）；**播放键 30 → 38×38**（圆形、弱主色底、图标 18）、**音量键 30 → 34×34 并彻底去框**（`border-radius: 0; background: none`，平时只有一枚图标，悬停才变主色）；**上一首/下一首从药丸上两角挪进常驻行**（参考图里 `‹` `›` 就夹着中间内容）：`[播放] ‹ 时间 进度 时间 › [音量]`，静止是三级淡色（`opacity: 0.55`）且**点得到**，悬停药丸时变主色 + `scale(1.12)`；**音量条去掉那颗蓝色圆球**：轨道 4 → **3px**，已调音量改由**轨道自身填充**表示（`background-size: calc(var(--pi-volume, 0) * 100%) 100%`，竖起来之后从底端往上长），滑块从 `10×10 蓝圆 + 落影` 变成 **14×3 细胶囊、无落影**；弹层悬停放大 `scale(0.82) → 1.3`（轴仍钉在底边，所以「从音量键顶上长出来」那 2px 的贴合不变，也更方便调）。实测 `条=343x44 占比=0.29｜悬停=343x56 底=754｜常驻行=44px 底=753｜上一首 opacity=1 下一首 opacity=1（静止 0.55/0.55）｜上一首 x=488 下一首 x=699（药丸 420~763）｜弹层 布局=16x84 视觉=21x109 贴键 Δy=1 Δx=0｜向上长大 ✓｜进度条不动 ✓｜行内两角键 ✓｜悬停放大 ✓｜音量条居中 ✓`。**照实说**：参考图 1 是 folia 的**深色药丸 + 白色实心大圆播放键**，这一版保留了 PI 自己的浅色玻璃药丸与配色，只落实用户逐条点名的那六项。
- **「我的喜欢」拼贴复刻 folia 的形似**（第 2 条，子代理）：新增 `components/song-collage-geometry.ts`（475 行，纯几何、照 folia 数值自己重写：`COLLAGE_CELL_SIZE=128`/`COLLAGE_GAP=8`/`COLLAGE_PITCH=136`/`BLOCK_COLS=12`/`BLOCK_ROWS=8`/`SLOTS_PER_BLOCK=12`/`EXPANSION_SIZE=808`/`FIELD_ASPECT=2.2`/`OVERSCAN=500`/`MAX_RENDERED_SLOTS=400`、入场 `0.03/格`、上限 `0.34`、窗 `1100ms`、抬升 `90px`、相机 `0.52|0.64|0.76`、`PAN_MARGIN_X=480`/`PAN_MARGIN_Y=360`）；4 套手工模板 ×4 镜像 = 16 朝向；**槽位行跨格上限刻意取 3**（中心 808 vs 普通 400 ⇒ 倍数恒 **2.02**；取 4 会掉到 1.51、冒烟那条「中心 ≥ 普通 ×1.8」的断言必挂）。`SongCollage.tsx` 重写（518 行，props 与手势/惯性代码未变）：定位改成「世界中心 + CSS `translate(-50%,-50%)`」、入场动画只动 opacity/translateY、新增 `SETTLE_MS=140`。`styles/song-collage.css` 重写（336 行）：folia 材质（**两层 radial 辉光 + 复用 `--pi-noise` 颗粒 ×0.55 + 四周暗角**）、直角卡、**不用 `will-change`/`backdrop-filter`**、左上序号徽章、按卡片宽度缩字号、中心块 z-index 20 + 大落影 + 2px 主色内描边。新增 `song-collage-geometry.test.ts`（7 例）。实测 `块=45 共=100 首｜中心=614px 普通=201px 倍数=3.05｜中心字=「79Heart Like CaliforniaB」｜拖拽位移=221px｜中心放大 ✓｜中心有字 ✓｜拖得动 ✓`。**没做**：块内重排（放大块直接盖住邻居）、返回键与播放 chrome。
- **浮名：镜头中心跟随当前亮着的歌词**（第 3 条，子代理）：镜头从「按整块内容居中」改成**跟当前句**，运动学换成**弹簧 + 隐式积分**（不再每帧硬设中心，避免跟随时的抖动与过冲）；新增设置页旋钮 `fumeCameraFollow`（`smooth` 平滑 / `snap` 定格）与 `fumeCameraSpeed`（0.4~2.5x），消费点在 `FumeTheme.tsx:977-981`。实测 `浮名内容边界：当前句左溢出=0px 右溢出=101px（hero 块左溢出=0px）✓`。**风险照实说**：`snap` 档在歌词不动时仍有轻微飘移（弹簧没到静止就换句）；**没有逐帧目视**。
- **流光：设置页加「逐字旋转」开关**（第 4 条）：`LyricStage.tsx` 加 `SPIN_ANGLES = [-6, 4.5, -3.5, 6, -5, 2.5, -4.5, 3.5]`，每个字素写 `data-word-spin` 与行内 `--pi-word-spin`，舞台根写 `data-word-spin`；**只作用于 classic**（`classicSpin = Themed === undefined && tuningOf(...).classicWordSpin === true`），`lyric-stage.css` 的三态规则改成组合 `rotate(var(--pi-word-spin, 0deg))` ⇒ **只有还没唱到的那一段是歪的**，唱到就摆正、唱过保持正。默认 `classicWordSpin: false`（不点开就是原样）。实测（冒烟里经设置页临时点开、拍完点回）`字=51 歪着的=41 最大角=6°｜前几个角=0,0,0,0,0,0,0,0｜根 data-word-spin=true → ✓`，成品图 `docs/m3r14-lyric-classic-spin.png`（单独存，不覆盖用户默认状态的 `docs/m3-lyric-classic.png`）。
- **心象复刻 folia 的实现**（第 5 条，子代理）：`CadenzaTheme.tsx` 依 folia 重写排布（`EFFECT_PAD_X=40`/`EFFECT_PAD_Y=54`/`ENTER_SCALE=1.3`/`SWING_SPILL_PX=12`/`MIN_WORD_SCALE=0.2`/`PLACE_SHRINK_STEP=0.9`/`MIN_PLACE_SHRINK=0.62`/`SIDE_GAP=0.5`/`FOCUS_Y_RATIO=0.42`），新增 `styles/lyric-cadenza.css`（**只有一条规则**：`.pi-lyricmood--cadenza .pi-lyriccadenza__word { transform-origin: 50% 42%; }`——覆盖原来的 `0 0`，等价 folia 的「词心偏上」锚点）。`cadenzaLayout.test.ts` **按授权只放宽第 1 条**（旧的「词心 ±170px 中间带」契约作废，改成 folia 的纵向落位边界 + 容量室：`112/330` 组用 folia 原值、`218/330` 组放宽到容量值，**最大放宽 136.8px**，`138/3450` 个词被缩字号到最小 0.620；取代关系写在测试文件头），另三条断言（不相交、动效包络、阅读顺序）一字未动且全绿：`词心越界 0 个｜330 组重叠 0 对｜动效包络 0 出界｜阅读顺序越轴 0 个`（不可达的 640×400 舞台有 5 组微重叠，只记录）。目视 `docs/m3-lyric-cadenza.png`：词散布在舞台中部、当前句最大居中最亮、上一句淡色在上。
- **云阶：字号错落 + 当前句放大 + 两个真 bug**（第 6 条，子代理做字号/错位/引导线，**两个真 bug 我查出来修掉**）：`PartitaTheme.tsx` 328 → 711 行 + 新增 `styles/lyric-partita-tune.css`；每块字号 `plan.fontPx × clamp(1 + jitter, 0.8, 1.2) × act × fit`（`jitter` 确定性 ±20%）、当前块 `act = 1.25 + t×0.35`、错位 `x = clamp(sign×mag + jitterX, ±(availHalf − half − 18))`、行距 `step = (inkHalf_i + inkHalf_{i+1}) × 0.88 + 2`、4 趟 `fit /= overflow`（下限 0.42）；`partitaGuides === false` 时引导线/基线完全不渲染。**真 bug A（词粘成一坨，渲染成 `havetokeephiding`）**：逐字时间戳那条路上**词与词之间没有空格字素**，而 `partitaLayout.buildAtoms` 只按空格字素断组 ⇒ 整行英文被收进**一个原子**；修法是给 `types.ts` 的 `StageWord` 加 `wordStart?: boolean`（`LyricStage.tsx` 的 `timedWords` 按 `index === 0` 写），`buildAtoms` 在 `wordStart && buffer.length > 0` 时断一次（有空格字素时是 no-op，不会双重断词）。**真 bug B（空格按基础字号画）**：`.pi-lyricpartita__word` 自带 `font-size: var(--pi-partita-font)`，而 JSX 插的那个**空白文本节点**只继承本行字号（舞台基础 ~16px）⇒ 65px 大字之间只剩 **3.7px** 的缝；修法是给 `.pi-lyricpartita__row` 显式写上 `font-size: var(--pi-partita-font, clamp(2.5rem, 5.5vw, 4.5rem))`。两条新断言的量法也记在 §4.16：**量词间空格必须用 `document.createRange()` 量那个空白文本节点自身**（拿两个 span 的外接框相减是错的——块的错位与逐字抖动都是 transform，前两版量出 -0.104em / -0.004em 都是假红）；**判「当前句放大」不能比跨行绝对字号**（每块有各自基准字号 × ±20% 抖动，当前块不一定最大），要比**同一块自己的倍率** `--pi-partita-mult`。实测 `行=3 原子边界=4 空格宽=0.292em｜字号档=66/97/60（3 种）｜倍率=1.02/1.50/0.93 当前块倍率=1.50（带最大倍率的块 data-current=对，当前句块数=1）｜字号÷倍率离散=0.0001｜块心最大偏移=70px（舞台宽 1182，只记录）｜断词 ✓｜当前句放大 ✓`。**照实说**：`partitaStaggerMin/Max` 默认仍是 **20px / 100px**（参考图 4 的读数，也是改造前的上下界），「行错位减小」落在行距收紧（`×0.88 + 2`）与错位夹取上，**没有**把默认区间本身调小。
- **时计：画里的小齿轮要转动 + 表盘四个旋钮 + 表盘显示封面**（第 7 条，子代理 + 我补探针）：`PendoloTheme.tsx` 的消费点 `:661-696` + `:719-728` + `:756`——`radius = min(宽, 高) × pendoloDialRadius / 100`（30~60%）、`angleStep = pendoloArcAngle / ARC_SLOT_DIVISOR`（60~160°）、`springStiffness = SPRING_STIFFNESS × pendoloEscapeForce`、`springDamping = SPRING_DAMPING_BASE + SPRING_DAMPING_FORCE / pendoloEscapeForce`（0.5~3x）、聚焦句 `scale = pendoloFocusScale`（1~1.7x）、歌曲封面只在 `pendoloCoverOnDial === true` 时画在 **0.88R / alpha 0.42**；同时把左下那三只小齿轮接进动画循环（原来只有主轮/游丝/摆锤在动）。**探针不看代码看像素**：隔 420ms 取两次 `.pi-lyricpendolo__dial` 的 `toDataURL()` 比对，一致=still、不同=moving ⇒ 实测 `画布=moving ✓`。实测 `铺满整屏：舞台=1x1 占窗｜歌词块=11 并集宽占比=0.569 出窗=-48px ✓`（**这条随当前歌词内容浮动**：另一跑同一断言读到 0.865，别拿它当固定基线）。成品图 `docs/m3-lyric-pendolo.png` 我看过：表盘 + 小齿轮 + 中英文歌词的空格都正常。
- **切歌小名片重做**（第 8 条）：新建 `components/SongChangeCard.tsx`（`SHOW_MS = 3400`；watch `currentSong`；`lastId` ref **初始化为挂载时那一首** ⇒ 启动/恢复不弹，只有真换歌才弹；根节点 `data-song-change-card`/`data-visible`；`role="status"` + `aria-live="polite"`；封面 `coverAt(coverUrl, 120)`）+ 新建 `styles/song-change-card.css`（顶部居中、z-index 30、复用玻璃 token、**`pointer-events: none`**、opacity/transform 过渡、`prefers-reduced-motion` 分支）+ `App.tsx` 挂载。实测 `可见=true｜歌名=「unhappy」｜歌手=「s0rrow」｜不透明度=1.00｜指针=none ✓`——「点击无互动」就是那个 `pointer-events: none`，截图 `docs/m3r14-songcard.png`。
- **设置页新增 11 个旋钮**：`packages/shared` 的 `LyricTuning` 与 `DEFAULT_LYRIC_TUNING` 新增 `fumeCameraFollow: 'smooth'`、`fumeCameraSpeed: 1`、`classicWordSpin: false`、`partitaGuides: true`、`partitaStaggerMin: 20`、`partitaStaggerMax: 100`、`pendoloDialRadius: 42`、`pendoloArcAngle: 100`、`pendoloEscapeForce: 2`、`pendoloFocusScale: 1.25`、`pendoloCoverOnDial: true`（后四个默认值就是参考图 5 的读数）；歌词动效参数卡里多了四张子卡（浮名·镜头 / 流光·逐字 / 云阶·错落 / 时计·表盘），复位键文案改成「全部一次写回出厂值」。设置冒烟把「歌词动效参数」卡面必须有这 17 项旋钮写成**个数完全相等**的断言（多一个少一个都判红）。实测 `旋钮=themeOpacity/fontScale/motionAmount/glowIntensity/fpsCap/randomThemePerSong/fumeCameraFollow/fumeCameraSpeed/classicWordSpin/partitaGuides/partitaStaggerMin/partitaStaggerMax/pendoloDialRadius/pendoloArcAngle/pendoloEscapeForce/pendoloFocusScale/pendoloCoverOnDial｜复位键=true → ✓`。11 个旋钮**全部真被主题消费**（grep 实证：`FumeTheme.tsx:977-981`、`PendoloTheme.tsx:661-696`/`:719-728`/`:756`、`PartitaTheme.tsx:564-569`）。
- **验收**：`apps/renderer` / `apps/desktop` 的 `tsc` 各 **exit 0**、`vitest` **14 files / 271 用例** exit 0（第十三轮 13 files / 264）、渲染层 `vite build` exit 0（232 modules、CSS 109.22 kB、JS 568.36 kB）、`apps/desktop` 的 `node build.mjs` exit 0（`out/main.mjs 672.1kb`、`out/preload.cjs 451.5kb`）、`PI_SMOKE_UI=1 PI_SMOKE_SHOT_THEMES=1 PI_SMOKE_SPIN=1` **exit 0**（末行 **23 项全 ✓**：新增「逐字旋转 ✓」「切歌小名片 ✓」「时计齿轮转 ✓」「云阶断词 ✓」「云阶字号与高亮 ✓」，另有「我的喜欢队列拼贴 ✓」「窗口三键浮出 ✓」「浮名不溢出 ✓」「三套铺满整屏 ✓」）、`PI_SMOKE_SETTINGS=1` **exit 0**（含新增的「逐字旋转开关 ✓」）；截图 `docs/m3r13-bar-hover.png`（重排后的控制条：38px 圆播放键、行内 `‹`/`›`、无框音量键）、`docs/m3r13-volpop.png`（无蓝色圆球的细长音量条 + 14×3 胶囊滑块）、`docs/m3-liked-wall.png`（45 块 folia 式拼贴 + 614px 中心块）、`docs/m3-lyric-partita.png`、`docs/m3-lyric-cadenza.png`、`docs/m3r14-lyric-classic-spin.png`、`docs/m3r14-songcard.png` 与六套 `docs/m3-lyric-*.png`（**逐张看过**）。细节与六条踩坑写在 `docs/PLAN.md` §4.16。

**第十三轮（用户 m04663 的八条，附四张参考图，并点名参考 `chthollyphile/folia-major`——AGPL-3.0，只借数值与交互，代码没抄）改了这些地方**：

- **歌词进度为什么总像慢半拍、切歌那一瞬为什么会跳**（第十三轮第 1 条，子代理）：两处真 bug。**A** 进度只由 `<audio>` 的 `timeupdate` 驱动（`AudioEngine.tsx` 的 `onTime`），Chromium 大约 250ms 一跳且不均匀；主题分支有 `usePositionClock` 补偿，**classic 没有** ⇒ 每个字素平均晚 125ms、最多 250ms。**B** `state/player.ts` 的 `loadCurrent()` 先把进度清 0，`await invoke(playerResolve)` 期间 `<audio>` 里还是**上一首**、还在发 `timeupdate`，而 `reportTime` 没有守卫 ⇒ **旧进度被写回 store**（切歌那一瞬进度条先跳一下旧值）。修法：`player.ts` 加模块级 `clockArmed`（`loadCurrent` 首行 false、`element.src = result.src` 之后 true、`restoreLast` false、`reportTime` 首行 `if (!clockArmed) return;`）；`LyricStage.tsx` 加平滑时钟（`CLOCK_STALL_MS = 400`——必须大于 `timeupdate` 的 250ms；停摆超阈值就冻在锚点、新值一到硬对齐；`findActiveIndex` 换成二分但语义逐位不变；classic 从此多一个常驻 rAF，**只有帧键变了才 setState**）。新增 11 例单测。**没有真机听感验证**。
- **右上三键太小**（第 2 条）：`WindowControls.tsx` 四处内联 svg `12 → 15`，`.pi-windowcontrols__btn` **30×26 → 42×34**（无框、悬停 `scale(1.12)`、关闭键悬停变红都不变）。实测 `size=42x34 icon=15x15`。
- **进度条悬停变大 + 两角浮出上一首/下一首 + 两个键也跟着变大**（第 3 条）：`--pi-bar-width` `clamp(196px, 25%, 372px)` → **`clamp(226px, 27%, 420px)`**（略长一档）、窄窗档 `clamp(170px, 30%, 300px)` → `clamp(200px, 32%, 330px)`；常驻那一行抽成 `.pi-home__barlyn`（绝对定位**钉在药丸下沿**）⇒ 悬停时进度条的位置与长度都不动，`:hover/:focus-within { height: 64px }` 只向上长（44 → 64）；播放/音量键 24 → **30**、图标 14 → 17；新增 `.pi-home__prev` / `.pi-home__next`（26×20 绝对定位在上两角，静止 `opacity: 0; translateY(8px) scale(0.6)`，悬停回弹到 `scale(1)` 且**进场延后 0.1s**——药丸要 0.3s 才长高，两键等顶部那 20px 真长出来再露脸）。JSX 里新增的取用函数**故意叫 `goPrev`/`goNext`**：两处 `onChange` 里有局部 `const next` 会遮蔽。实测 `静止=319x44 底=754｜悬停=319x64 底=754｜常驻行=44px 底=753｜两键 opacity 悬停 1（静止 0/0）`。
- **时计表盘按参考图补齐九类图元**（第 4 条，子代理，只改 `PendoloTheme.tsx` 559 → 751 行，CSS 一行未动）：把参考图与成品图 dump 成 raw BGRA，用 Node 做**圆心拟合**（参考图圆心 `(−2.6, 501.1)`、大齿轮外沿 `R = 431.4` rms 6.2）+ 径向直方图 + 极坐标剖面，把每类要素实测值折回 `R = 0.42 × min(w,h)` 再补：主拾纵轮 36 齿 / 齿深 `R+15`、**0.85R 引导环单独加粗**成 1.6px、新增**内接正方形构造线**、新增**五角星**（外径 `0.058R`，一角朝上）、新增**长箭头**（0.8R → 引导环）、太阳小齿轮 `0.16R → 0.225R` 并改红、左下**三只小齿轮**（22/16/24 齿 + 孔圈 + 辐条）、游丝 4.5 圈。`drawStaticFace`/`drawMovingParts` 签名、11 槽位、弹簧、DPR 与脏矩形全未改。**没有像素级比对与真机目视**；已知风险：新图元画在静态层，会被每帧那条中心径向渐变蒙一层（嫌淡就移到 `drawMovingParts` 之后画，数值不用改）。
- **音量条与音量键不同心**（第 5 条，真因用像素证据钉死）：`.pi-home__volrange` 是 **84×16** 的 range，在 **16×84** 的弹层里靠 `rotate(-90deg)` 转成竖条——而 **84 > 16 溢出容器时，Chromium 会把 grid 的 `place-items: center` 夹回起始边**（溢出对齐是 clamp 而不是对称溢出），于是它的中心落在离弹层左边 **42px（= 84/2）** 处，转过来整根竖条就比音量键偏右半个长度。用自写的零依赖 PNG 解码脚本（`.tmp-png-map.mjs`）量 `docs/m3r13-volpop.png`：音量键的蓝色 blob 中心 x = **51**、滑块的 x = **93**（差 42px）——而旧断言量的 `弹层贴键 Δx=0` 是**弹层盒子**的中心（一直是 0，所以从来没抓住过）。改成 `position: absolute; left: 50%; top: 50%; margin: -8px 0 0 -42px`（自身中心直接钉在弹层中心），并新增断言 `volAxisOk = |滑杆轴 Δx| ≤ 2 && 滑杆盒 = 16x84`（注意 `getBoundingClientRect()` 报的是**转完之后**的视觉盒：16x84，不是 84x16）。实测 `滑杆盒=16x84 滑杆轴=Δx=0`。
- **系统「正在播放」小名片点了没反应**（第 6 条）：那张名片是**系统画的**（Windows SMTC），app 侧只能提供元数据与动作、并保证点击能回到应用。新建 `lib/media-session.ts`：`installMediaSession()` 幂等注册 play/pause → `toggle()`、previoustrack → `prev()`、nexttrack → `next('manual')`、seekto/seekbackward/seekforward → `seek()`（每个 `setActionHandler` 单独吞 `NotSupportedError`），成功注册的动作挂到 `window.__piMediaSession.actions` 作**探针接缝**；`sync()` 换歌时设 `MediaMetadata`（歌手用 `' / '` 连、封面 `coverAt(coverUrl, 640)`）、`playbackState`、`setPositionState`。`App.tsx` 里 `useMediaSession()`。主进程 `app.on('second-instance')` 补 `if (!mainWindow.isVisible()) mainWindow.show();`——系统卡片/任务栏「点击回到应用」走的就是这条路。实测 `动作=play/pause/previoustrack/nexttrack/seekto/seekbackward/seekforward｜歌名=Dying For You｜封面=1 张｜状态=playing｜接线 ✓｜元数据 ✓`。**名片外观不可定制，也没法脚本化点它**，只验到接线与那条 `show()` 通道。
- **「我的喜欢」改成 folia 式队列拼贴（一期）**（第 7 条，子代理）：新增 `components/SongCollage.tsx`（515 行）+ `lib/collage-layout.ts`（157 行，`geometryFor`/`clampCamera`/`centerCellOf`/`queueIndexAt`）+ `lib/collage-layout.test.ts`（11 例）+ `styles/song-collage.css`（214 行）；`pages/MinePage.tsx` 把 `LikedWall` 换成 `<SongCollage songs={liked.data?.tracks ?? []} onSelect={select} />`（`LikedWall.tsx` 保留但不再被引用）。folia Lattice 的数值照搬：`BLOCK_COLS=12`/`BLOCK_ROWS=8`/`SLOTS_PER_BLOCK=12`、4 套手工 slot 模板 ×4 镜像 = 16 朝向、`queueIndex = cellSlot % totalEntries`、`CELL_SIZE=128`/`GAP=8` ⇒ 节距 136；卡片直角、序号徽章在左上、**不用 `backdrop-filter`**（否则每张卡都提升成独立合成层）、**不加 `will-change`**（分数缩放下会有 1px 接缝）。布局：节距 136/120/104 三档、列数 `ceil((视口宽 + pitch)/pitch)`、行数 `max(铺满一屏, ceil(歌数/列数))` ⇒ 1 首到 1000 首都拖不出空白；中心块 `pitch*2.4 - inset*2`（≈312px vs 普通 124px）+ 白描边 + 歌名/歌手浮层；拖拽用 pointer + `setPointerCapture`、起拖 8px、`clampCamera` 夹 `[world − viewport, 0]`、松手惯性 2600/60/0.9；**拖动期间不经过 React**（直写 world transform 与 `data-center`）；只画与视口相交的块（`OVERSCAN=220`、`MAX_ITEMS=420`）；封面 lazy（中心 480、其余 200）。它自己抓到并修掉两个真 bug：`clampCamera` 在「世界比视口小」时上界反了（左下露白）、`.pi-main` 是 `overflow-y: auto` 导致子元素 `height: 100%` 塌成 0（改 `calc(100vh - 220px); min-height: 360px`）。实测 `块=70 共=100 首｜中心=314px 普通=124px 倍数=2.53｜拖拽位移=486px｜中心放大 ✓｜中心有字 ✓｜拖得动 ✓`。**这一轮只落「我的喜欢」这一页——环形歌单展示还没删**（用户裁定的顺序：歌单/列表其余部分下一轮再铺开）。**没做**捏合缩放与顺序持久化；「我的喜欢」首屏只取前 100 首（页面自己写明「共 1247 首（首屏只显示前 100 首）」）。
- **照 folia 仓库学**（第 8 条）：只参考它 `src/components/app/lattice/` 的常数与交互语义，**没拷代码**（AGPL-3.0）。
- **验收**：`apps/renderer` / `apps/desktop` 的 `tsc` 各 **exit 0**（沙箱里 `pnpm` 跑不了，逐包跑）、`vitest` **13 files / 264 用例** exit 0（第十二轮 12 files / 242）、渲染层 `vite build` exit 0（228 modules、CSS 105.23 kB、JS 549.55 kB）、`apps/desktop` 的 `node build.mjs` exit 0、`PI_SMOKE_UI=1`（含 `PI_SMOKE_SHOT_THEMES=1`）**exit 0**（末行 **18 项全 ✓**：`…｜播放器详情页 ✓（评论行 35，歌词行 1，主题 cadenza，情绪背景 ✓）｜…｜我的喜欢队列拼贴 ✓｜歌曲卡片流 ✓｜…｜窗口三键浮出 ✓｜浮名不溢出 ✓｜三套铺满整屏 ✓ → 通过`）、`PI_SMOKE_SETTINGS=1` **exit 0**；截图 `docs/m3r13-bar-hover.png`（药丸向上长大、上两角浮出上一首/下一首、两键放大）、`docs/m3r13-volpop.png`（音量弹层 103×201 特写，键与滑杆同心）、`docs/m3-liked-wall.png`（70 块带序号徽章的拼贴墙 + 中心 314px 放大块）、`docs/m3-lyric-pendolo.png`（补齐后的表盘）与六套 `docs/m3-lyric-*.png`（**逐张看过**）。细节与五条踩坑写在 `docs/PLAN.md` §4.15。

**第十一轮（用户 m03279 的五条，附七张参考图）改了这些地方**——这一轮的判断标准是「画面像不像参考图」：

- **浮名：左边的歌词不再被窗口切掉**（第十一轮第 1 条前半）：真因在**相机横向夹取的下界**，不在字号/内边距——`FumeTheme.tsx` 的 `clampCameraOffset` 原本 `min = viewport − covered + guard`、`max = −guard`，`max` 那条只管「纸面左边缘可以在窗口外 88px」，而**决定歌词会不会被切的是 `min`**：镜头缩放最大到 2.2 时 `covered = 纸面宽 × 2.2`，`min` 能到 −3714px，正在唱的那一行就被推出窗口左边（实测溢出 2541px）。第一版把内容边界写进 `max`（方向反了，所以那一版冒烟仍然红）；现在改成按**正在唱的那一块自己**夹（`activeBlock ?? viewBlock`）：`clampCameraOffset` 收 `contentLead`（块左缘换算到屏幕的像素）与 `contentSize`（块宽），`margin = 窗口宽 × 0.03`、`headMin = margin − contentLead` **同时抬下界与上界** ⇒ 块左缘永远不会落到窗口左边外；再算 `fitMax = 窗口宽 − margin − contentLead − contentSize` 当上界 ⇒ 块放得下时**右缘也不许出去（整行看得见）**，放不下只钉左缘、尾巴留在窗口外等镜头。纵向故意不按内容夹（否则曲首第一行会被钉到窗口顶）。实测 `当前句左溢出=0px`、成品图里当前句从 45px 起排。
- **浮名：和声处的歌词进度对了**（第十一轮第 1 条后半）：上游 yrc **本来就带**行时长（行首 `[开始毫秒,持续毫秒]`）与逐字时间戳（行内 `(开始,时长,?)`），`parseLrc` 以前把两者都丢了；和声行与主唱行时间戳相同 ⇒ 行时长被算成 1ms ⇒ 那一行「瞬间唱完」、逐字进度全错。现在 `packages/shared` 的 `LyricLine` 多出可选 `durationMs` / `words`，`packages/ncm-client` 用 `parseYrcWords()` 把逐字时间带上来（**逐字文本拼起来必须严格等于整行，否则宁可不认**，免得字与时间错位），舞台的行时长取 `max(真行时长, 第一个严格更晚的时间戳 − 行首)`，逐字状态机（`starts` / `ends`）直接跟着真时间戳走。纯 LRC 行两个字段缺省 ⇒ 行为与改造前一致。
- **标题栏整条取消，窗口三键改成鼠标接近右上角才向下浮出**（第十一轮第 5 条）：Windows 窗口从 `titleBarStyle: 'hidden'` + `titleBarOverlay` 改成 **`frame: false`**（**故意不设 `thickFrame: false`**——保留默认 true，无边框窗口才还有边缘拖拽缩放与阴影），macOS 保留系统的红绿灯、Linux 未动。渲染层删掉 `components/TitleBar.tsx` 与 `.pi-app` 网格里的 `titlebar` 行，新增 `components/WindowControls.tsx`：左上品牌键（**仍带 `[data-nav-toggle]`**，冒烟就是点它开抽屉）+ 版本小字，右上三键 `button[data-window-btn="minimize|maximize|close"]`。热区**不是**一整块透明矩形（`pointer-events: auto` 的整块会吃掉歌单页右上那枚「添加歌曲」键），而是每角两条细 L 形带（160×14 / 14×120），`pointerenter` 触发、移开 240ms 收回、0.2s 浮出；窗口最上沿另留一条 7px 高的 `-webkit-app-region: drag` 拖动条。三条窗口通道（`window:minimize` / `window:toggle-maximize` / `window:close`）在 `packages/ipc` 与 `apps/desktop/src/main/ipc.ts` 里**本来就齐**，这一版只是渲染层第一次真的调用它们。
- **进度条整体缩小到参考图比例、音量条从音量键里长出来**（第十一轮第 2 条）：**结构一个都没动**（时间仍在药丸里、音量键也还在条右端），改的全是尺度——`--pi-bar-width` 从 `clamp(240px, calc(100% - 540px), 760px)` 收到 **`clamp(196px, 25%, 372px)`**（参考图那根药丸约占窗宽 1/4，改造前约占 55%），高 56→44、圆角 28→22、键 32→24px、时间 11.5→10.5px、轨道 20→16px（track 4→3、滑块 12→10）；音量弹层从 `bottom: calc(100% + 10px)` 改成 `calc(100% - 2px)`（原来那道 10px 的缝没了，看着就是从键顶上伸出来），尺寸 20×112 → 16×84。逐条写在 `docs/PLAN.md` §4.13。

- **心象：字沿阅读顺序散在中间带，不再满屏乱飞**（第十一轮第 3 条）：删掉随机撒点与「hero 最小间距」那一套，改成 hero 居中放大、其余字按**阅读顺序**往两侧铺（`x = side × (heroHalfW + gap + cursor + wordHalfW)`），纵向在 `band = min(窗口高×0.22, 170px)` 里分层错落，解重叠的螺旋半径收到 ≤64px；一行装不下时先横向放宽、再 12 档等比缩小（缩完字号仍 ≥ 28px）。实测 6 块并集宽占窗宽 0.735、高 0.378、最远出窗 −120px、**两两相交 0 对**。新增 `cadenzaLayout.test.ts`（6 用例）。
- **云阶：竖列堆词改成短块楼梯**（第十一轮第 4 条）：新建 `partitaLayout.ts`（纯几何，`layoutPartitaLine` 是唯一入口：`buildAtoms` 按空格断词、拉丁/西里尔整词一原子、CJK 一字符一原子 → `partitionAtoms` 切成 1~4 字素的块 → 按阅读顺序自上而下摆成楼梯，每块按 `[-0.16, 0.06, -0.10, 0.14, -0.02] × 舞台宽` 左右交替偏移、步进 `tallest × 1.15 + 6px`，整段垂直居中），字号 `clamp(舞台宽×0.055, 40, 72) × max(fontScale, 0.8)` 逐档 ×0.86 到 20px 下限；`PartitaTheme.tsx` 改成只负责渲染，DOM 契约（`data-theme` / `__col` / `__guide` / `data-word-state`）一个没改。自查：450 组几何断言 0 对重叠；可达舞台（≥960×620）1860 组 **0 溢出**；不可达小舞台（真机到不了）930 组里 87 组溢出、全已退到 20px 下限，只记录不断言。新增 `partitaLayout.test.ts`（5 用例，长期保留）。
- **验收**：`pnpm typecheck` 14/14、`pnpm test` **12 files / 242 用例**、`pnpm build` 2/2、`PI_SMOKE_UI=1` **exit 0**（末行 **17 项全 ✓**，含「窗口三键浮出 ✓」「浮名不溢出 ✓」）、`PI_SMOKE_SETTINGS=1` **exit 0**（4 条断言全 ✓）；成品图 `docs/m3r11-home.png`、`docs/m3-lyric-fume.png` / `docs/m3-lyric-cadenza.png` / `docs/m3-lyric-partita.png`（**逐张看过**）。

**第十二轮（用户 m04193 的七条，附五张参考图）改了这些地方**——判断标准仍是「画面像不像参考图」：

- **倾诉 / 时计 / 流光三套也「以整个界面作为展示」**（第十二轮第 1、2、3 条）：三条一个真因——基础 `.pi-lyricstage` 自带 `max-width: 560px` + `margin: 0 auto` + `min-height: 300px`，外面静态的 `.pi-home__stage-lyrics` 又压了一层 `padding: 108px 24px 92px`，歌词只剩窗口中间一竖条。解法与第九轮给浮名/心象/云阶的**完全一样**：`position: absolute; inset: 0` 贴住 `position: relative` 的 `.pi-home__stage`（绝对定位的包含块取最近的定位祖先，静态那一层的 padding 自然失效）——`styles/lyric-themes.css` 新增 `[data-theme='tilt']`（:422-434）与 `[data-theme='pendolo']`（:555-568），`styles/lyric-stage.css` 新增 `[data-theme='classic']`（:81-93）。字号按参考图**逐像素重标**：倾诉 `NORMAL_MAX_PX 90 → 144`、`ITALIC_MAX_PX 90 → 165`、新增 `ITALIC_VW 0.079` / `ITALIC_MIN_PX 57`（1518px 窗实算普通行 **100.3px**、斜体行 **114.9px**——旧值 38.5px **比普通行还小**，这就是「斜体没更大」的老 bug）；流光大字 `clamp(1.6rem, 4.6cqi, 3.1rem) → clamp(2.25rem, 8cqi, 12rem)`（**49.6px → 121.4px**，参考图那行大字横跨窗宽 92.7%）、字幕层从网格第二行改成**绝对贴底**（否则大字被顶到 40.6%）；时计四档字号改 `clamp(22px,2.75vmin,44px)` / `clamp(28px,3.5vmin,56px)` / `clamp(12px,1.5vmin,24px)` / `clamp(16px,2vmin,32px)`，另给每帧加**脏矩形贴图**（铺满后画布从一列变成整窗，全量重绘白烧 GPU），表盘几何一个数没动。探针实测「铺满整窗」：倾诉 **并集宽占比 0.946 / 出窗 −32px**、时计 **0.641 / −48px**、流光 **0.977 / −14px**，全部 ✓。**一处刻意的偏离**：倾诉没写 `pointer-events: none`——滚轮换行的监听挂在舞台根节点上（`LyricStage.tsx:439`，`lyric-stage.css:49-51` 明文要求那里必须是 `auto`），铺满后设 `none` 会让滚轮换行静默失效。
- **名片改竖排、封面整块放顶部**（第十二轮第 4 条）：`.pi-home__card` 从横排（340px 上限）改成 `flex-direction: column; width: 188px`，`.pi-home__cover` 从 56×56 改成 `width: 100%; aspect-ratio: 1/1`，封面请求从 200 提到 **400**（168px 方图在 2× 屏上要 336px，旧值会糊）。实测 `封面在顶=true 封面宽=168 名片宽=188 封面比=1.00`。
- **条上两个键常态不显示、悬停回弹长出**（第十二轮第 5 条）：两个键收起态在 `opacity: 0; pointer-events: none` 之外加 `translateX(∓7px) scale(0.5)`、显示态回 `translateX(0) scale(1)`，过渡 `transform .36s cubic-bezier(0.34,1.56,0.64,1)`（回弹）；音量弹层收起态 `scale(0.82)` + `transform-origin: bottom center`（底边不动 ⇒ 第十一轮那条「贴着音量键」在静止态仍成立）。`transform` **不参与布局**⇒ 悬停不会改变药丸长度，探针把这条也钉住了（静止 296px = 悬停 296px）。实测常态 `两键 opacity=0 缩放=0.5`、悬停 `弹层 Δy=2 Δx=0 16x84 不透明度=1`。
- **右上三键去掉边框、只剩三个图标**（第十二轮第 6 条）：`.pi-windowcontrols--right` 从「玻璃底 + 描边 + 落影 + 圆角」改成全透明无框（`border: 0; border-radius: 0; background: none; backdrop-filter: none; box-shadow: none`），按键 36×30 → **30×26**、悬停不再铺底（只变色 + `scale(1.12)`，关闭键悬停 `#e5484d`）；左上品牌浮层（带版本号）**保留**玻璃底。实测 `border=0px/0px bg=none bgColor=rgba(0,0,0,0) radius=0px size=30x26`。
- **设置页改成拍立得卡片式、选项简化**（第十二轮第 7 条）：`components/SettingsFrame.tsx` 的页签从「图标 + 文字长条」改成 **38×38 圆形图标键**（文字标签转 sr-only 但**留在 DOM**，冒烟抓手是 `dataset.settingsTab`）、补 `aria-label`/`title`；`pages/SettingsPage.tsx` 新增 `Segmented<T>`，播放模式 / 外观 / 界面语言由 `<select>` 改成分段控件，各页签的两行长说明收成「短 hint + `title` 全文」；`styles/settings-frame.css` 把面板做成拍立得厚白边（`padding: 14px 16px 24px; border-radius: 18px; background: var(--pi-surface)`）、设置行改浅底 pill、勾选框改成 **38×22 开关**外观、滑杆自绘 4px 轨道 + 14px 深色圆点。实测 `页签 radiusPct=50 size=38x38 labelHidden=yes｜卡片 radius=18 shadow=yes padBottom=24`。参考图顶部那张大封面卡（第十轮已按用户要求删掉）与那排三个大方块动作按钮**没做**（设置页没有对应功能）。
- **顺带修的一个行为回退**（不在七条里，但被上面三条引入）：三套铺满主题的舞台根原来挂 `.pi-home__lyrics`，而 `pages/HomePage.tsx:88-93` 用「target 落在 `.pi-home__lyrics` 里 ⇒ 不算空白」判「点空白收起名片操作框」⇒ 铺满整窗后**整页都点不出收起手势**（倾诉/流光/时计的舞台根是 `pointer-events: auto`，空白处的命中目标就是它）。判据收窄成「只有歌词行（`[data-lyric-line]` / `.pi-lyricstage__line`）算歌词」，舞台空白重新算空白；另四套主题的根仍是 `none`、空白点击本来就落在这层，行为不变（新增一条冒烟断言盯住它）。
- **验收**：`pnpm typecheck` 14/14、`pnpm test` **12 files / 242 用例**、`pnpm build` 2/2、`PI_SMOKE_UI=1` **exit 0**（末行 **18 项全 ✓**，六套歌词主题各拍一张成品图：`docs/m3-lyric-{tilt,pendolo,classic,fume,cadenza,partita}.png`，含「三套铺满整屏 ✓」）、`PI_SMOKE_SETTINGS=1` **exit 0**（`设置页 ✓｜音质日志页 ✓｜分类边框页与歌词主题 ✓｜歌词动效参数卡 ✓｜拍立得外观 ✓`）；另外两张：`docs/m3r12-home.png`（竖排名片：方封面在顶，歌名/歌手/专辑/音质在下面）、`docs/m3-settings-frame.png` / `docs/m3-settings-lyric.png`（圆形图标页签 + 拍立得卡面 + 开关式勾选 + 自绘滑杆）。细节与四条踩坑写在 `docs/PLAN.md` §4.14。

**第十轮（用户 m02362 的十条）改了这些地方**——下面按轮次的历史描述仍然逐条有效，这里只列这一轮动过的：

- **设置页去掉了顶部那张大封面与黑胶**（第十轮第 1 条）：框里直接从页签开始。`components/SettingsFrame.tsx` 里
  `SettingsHeader` 与取当前歌的那两个 import 删掉，`styles/settings-frame.css` 里的 `.pi-settings-frame__head/__art/__cover/__meta/__song/__artist`
  与整套 `.pi-vinyl*`（含 `@keyframes pi-vinyl-spin`）一起消失。
- **球 / 名片 / 进度条三件常驻控件换成「透光玻璃」**（第十轮第 2 条）：`styles/tokens.css` 新增
  `--pi-glass-bg-light: rgba(255,255,255,0.34)`（暗档 `rgba(20,26,36,0.34)`）、`--pi-glass-blur-light: blur(18px) saturate(1.7) brightness(1.06)`、
  `--pi-glass-border-light: rgba(255,255,255,0.58)`，**只**给这三件用；设置框那种大面板仍是原来 0.62 的 `--pi-glass-bg`
  （大片半透明会看不清字）。现在背景封面、歌词、环形按键的光都能从这三件里透出来。
- **进度条定长、悬停只加键、音量条去掉框、而且不再自动隐藏**（第十轮第 3 条）：`--pi-bar-collapsed/--pi-bar-expanded`
  与宽度过渡全删，只剩一个 `--pi-bar-width: clamp(240px, calc(100% - 540px), 760px)`（就是第九轮悬停展开后那一档——
  用户判第九轮的 1/4 长「太短了」）；`.pi-home__play` / `.pi-home__volbtn` 恒定 32px 宽、默认 `opacity: 0; pointer-events: none`，
  悬停只把不透明度拉起来，**条本身一动不动**；音量弹层从 40×136 的玻璃面板缩成 20×112 的**纯热区**（没有底、没有描边、
  没有阴影），滑块才有落影；`styles/overlays.css` 的自动隐藏只留名片与球，进度条常驻。实测探针：
  `无操作自动隐藏：静置 名片/球=0.00/0.00、进度条=1.00`。
- **卡片浮层（歌单 / 歌手 / 专辑 / 当前播放）现在是真把播放页糊掉，而不是盖一层白纱**（第十轮第 10 条）：
  `.pi-listoverlay` 的底色从 38% 降到 **8%**、`blur(26px)` 收到 `blur(16px)` + `saturate(1.12)`，背景的封面、歌词、部件都还看得见
  只是被模糊；浮起来的卡片本身高度改成 `min(760px, 100%)`，四周留出真能命中的玻璃空白，**点空白或 Esc 就退回播放页**（第十轮第 4 条）。
- **三套歌词动效的真 bug**（第十轮第 5、6、7 条，都是先用 `PI_SMOKE_SHOT_THEMES=1` 拍成品图再定位的）：
  **浮名**的取景偏移漏乘了相机缩放（`frameCameraOffset` 少了 `scale` 参数），歌词会飘出窗口——补上并在每帧积分后再夹一次；
  **心象**有两个原因——兜底初值把 `placement.x/y` 又加了一遍（应该从 0 起算）+ `palette` 每帧换引用导致歌词舞台的
  `useMemo`/rAF 每 ~250ms 重启一次、逐字素插值缓存被清空，所以看着一抽一抽；
  **云阶**也是两个原因——`fitColumns` 从「最少列」往上试（第一档必然通过 ⇒ 永远挤成一坨）改成从 `maxColumns` 往下试，
  并且字号缩放与列缩放原来叠乘成 `scale²`（现在只有列缩放 `0.92~1.12`）。
- **设置页「歌词」页签多了第二张卡：folia 式歌词动效参数**（第十轮第 9 条）：透明度 / 字号 / 动效幅度 / 辉光强度四个滑杆、
  帧率上限（不限 / 120 / 90 / 60）、「每首歌随机换主题」一个勾选，外加「恢复默认」。六个旋钮真接进了那几套主题的渲染
  （`fpsCap` 覆盖浮名 / 心象 / 倾诉 / 时计，云阶是纯 CSS、classic 按用户要求一个像素没动）；探针抓手是
  `[data-lyric-tuning="<字段名>"]`。细节与「老设置文件怎么迁移」写在 `docs/PLAN.md` §4.12。
- **「多主动看画面」这件事进了流程**（第十轮第 8 条）：见上面环境变量表里的 `PI_SMOKE_SHOT_THEMES` / `PI_SMOKE_SET_THEME`；
  这一轮的成品图是 `docs/m3-home-10th-e.png`、`docs/m3-lyric-fume.png`、`docs/m3-lyric-cadenza.png`、`docs/m3-lyric-partita.png`。


- **悬浮球是唯一的常驻控件**：屏幕上一颗 56px 玻璃球，球心是天蓝渐变 `PI` 字样，外圈一圈进度弧（
  解析中球心会转圈）。**它可以在屏幕上拖着走**（松手离边太近就自动吸附、留 12px 边距）。
- **单击展开/收起环形菜单**（**再点一次球才收回**，Esc 也可以）：按钮绕着球排成两半——**左半 8 个导航键**
  （设置 / 我的歌单 / 收藏 / 推荐 / 我的喜欢 / **最近听过** / **我的下载** / 搜索），**右半 5 个播放键**
  （播放模式 / 上一首 / 播放暂停 / 下一首 / 播放列表）。**默认只显示图标，鼠标停在哪个按键上，那个按键才升起 12px 并显示文字**。
- **导航抽屉的入口挪到了标题栏最左边那个「PI」上**（环形菜单里不再有一个单独的抽屉键）。
- **「最近听过」「我的下载」提到了环形菜单一层**（第七轮第 1 条）；**点「设置」不再展开子菜单**了，也不再进一张
  占满 app 的整页（第八轮第 7 条）：**一圈按键先逐个坠进球里，球再塌到屏幕正中央，然后从中心流出一只设置框**——
  框里就是原来那份分类面板（顶部封面 + 黑胶、一排页签、底部「同步数据」），原来的「音质日志」页是框里的**「日志」页签**
  （导航抽屉里也不再单列这一项）。框外点一下或 Esc 关掉，退场动画演完才卸载。
- **点「我的歌单」或「收藏」→ 按键换成歌单封面环绕球**：**按住任意封面拖动就能绕着球转**看其他歌单
  （滚轮也行），点封面直接进那个歌单。这个账号的「我的歌单 / 收藏」都是空的，所以现在会回退显示
  **推荐歌单**并在下方写明「我的歌单是空的 · 改看推荐歌单」。
- **按键与封面都放大了一号**（按键 40 → 48px、图标 18 → 21px、歌单封面 44 → 60px），封面环也整体往外挪，
  不那么容易点错、封面也看得清。**第八轮第 8 条又把阵列收到贴着球**：键径 48 → **44px**、图标 21 → 19px，
  环半径从约 124px 收到 **98px**；第一版只给两半之间留 18° 空档，那对相邻键中心距只剩 28.4px、44px 的键直接叠上
  （冒烟「最少间距」抓出来的），现在 46.9px。
- **「推荐」键不再是推荐页，而是绕着球的歌单环**：**每日推荐 / 私人雷达 / 推荐新音乐**排在最前面，
  后面才是推荐歌单列表，点哪个进哪个。
- **「搜索」键不再是搜索页，而是一层盖在当前页上的毛玻璃浮层**：中间的搜索框边打字边出结果
  （220ms 防抖），结果**就是歌单里那套「一行中心聚焦封面流」**（第九轮第 6 条：原来那种「一行小卡 + 悬停糊封面」
  整块删掉了），点中心那张就播、并直接进播放页。Esc / 点空白 / 右上角 × 都能关掉。
- **切换环形菜单的页时有过渡动画**：旧一页的按键按顺序「坠」进球里，新一页的按键再从球里按顺序冒出来。
- **材质统一成 iOS 毛玻璃**：按键、封面、说明胶囊、详情页边框、四角按钮、抽屉、队列、列表卡片都是半透明 +
  背景模糊；页面底层垫了一层极淡的天蓝/藕色光晕（`backdrop-filter` 得后面有东西可糊，纯白底上玻璃看着还是白的）。
- **球贴到窗口边缘会自动吸附并收成一条细条**（贴在那一边的玻璃胶囊，里面那截蓝色是播放进度）：
  吸附时环形菜单自动收起；**把球从边上拉出来，菜单会自己回来**（吸附前没开的话就不会开）；点一下细条球就弹回屏幕里。
  **细条更细了**（第七轮第 7 条）：静息 **8px**、鼠标指上去 12px（原来是 12/16）——顺手修掉一个真 bug：
  那颗球的 `<button>` 没归零 UA 的 `padding: 1px 6px`，border-box 下 8px 被顶成 13.6px，所以「更细」原本根本没生效。
- **菜单开着时把球拖到屏幕边上，一圈按键跟着进入边框一侧、不会被挤住**（第七轮第 7 条后半：拖动期间不再 clamp 环心）。
- 另外修掉一个真 bug：**播放中暂停键是空白的**——`pause` 图标原本是两条描边线，却被当填充图形渲染，面积为零。
- **没有任何在播歌曲时**，播放器页是一张空白页：一颗很大的天蓝渐变 `PI` 字样 + 一句提示，没有别的控件。
- **只要在播、或者上一次播放过**，播放器页就是**歌曲详情页**（第七轮第 6 条重排版式，第八、九轮连改三轮）：
  **封面与歌名缩成左下角一张小名片**（第九轮第 2 条从左上挪到左下；56px 缩略图 + 歌名 + **歌手（可点）** +
  **专辑（可点）** + 音质），**整页都留给歌词**；**点一下名片，从它上方伸出一个竖排操作框**（评论 / 收藏 /
  歌曲信息 / 分享——第九轮第 2 条。以前那套「点页面浮出一整片毛玻璃遮罩 + 四角按键 + 分享/收起」整块删掉了，
  点空白处只收操作框）。**点名片里的歌手名 → 歌手歌曲卡片，点专辑名 → 专辑歌曲卡片**（第九轮第 2 条后半，
  走两条新后台通道 `library:artist-songs` / `library:album-songs`，都是公开数据、不需要登录）。
  底部是**一条横向浮空的进度条**：**收起时只有原先的 1/4 左右（190px）**，**鼠标悬停（或键盘焦点进入）时变长**，
  并且**左端长出播放/暂停键、右端长出音量键**，**鼠标移到音量键上会弹出上下方向的音量条**（第九轮第 1 条；
  第八轮第 2 条那版「只有时间 + 进度条」就此结束）。**名片、进度条、悬浮球在没人动的时候会自己藏起来**
  （第八轮第 1 条）：3.2 秒内没有按下/滚轮/按键就淡出，藏起来以后**把指针移到哪一件上、哪一件才回来**
  （刻意不监听鼠标移动——划过页面中间不该把三件一起叫醒），随便点一下或滚一下滚轮则三件全回来；
  **第九轮第 7 条**又补一条：**拖着悬浮球走的时候不会把已经藏起来的名片/进度条叫醒**（拖动不算「有人动」）。
  歌词本身仍是 folia classic 的**逐字点亮**（已唱的字是天蓝主色、未唱的仍是淡灰，下面淡出预览后两句）；
  **滚轮只切换「要看的那一句」、绝不改播放进度**，**点某一行则直接跳到那一句播放并交还自动跟随**（第八轮第 3 条，
  六套动效主题走同一套事件委托），原来底部那颗「太大」的「回到当前」按钮**整块删掉**（往回滚仍然自动交还）。
  为这件事还修掉一个真 bug：classic 行被第七版 CSS 写成 `pointer-events: none`，所以「点歌词跳播」**最初根本不工作**。
  「上次播放过」是靠 `localStorage` 记住的，所以冷启动后它仍停在详情页（此时状态是暂停，按播放才会联网解析）。
- **歌词动效主题有六套**（第七轮第 4 条，在设置页的「歌词」页签里选、存进设置）：`classic`（folia 默认主题的复刻）、
  **浮名 `fume`**、**心象 `cadenza`**、**云阶 `partita`**、**倾诉 `tilt`**、**时计 `pendolo`**——名字与数值骨架都对应
  folia 的 visualizer 主题，实现全部自己写（见 `docs/CREDITS.md` §1 借鉴五）。**第八轮把用户点名的三套重做了**
  （第 4 条，浮名 `fume` / 心象 `cadenza` / 云阶 `partita`）：①动效现在真的**铺满整个视口**——第七版只画在歌词那一列里
  （用户怀疑的「展示范围不是全屏」属实）；②**按语言切单位**：`Intl.Segmenter` 的字素 + 空白/连字符规则，中文逐字、
  拉丁逐词，中/日/英歌都不再挤成一团；③颜色改成**跟这首歌的封面取色**（`lib/song-palette.ts`：封面 640px → 提色 →
  派生 `--pi-th-primary/accent/surface`，取不到回退中性色），不再一味跟主题色；倾诉 `tilt` 与时计 `pendolo`
  还是第七版的数值（没做语言自适应与跟色，照实记在 `docs/PLAN.md` §4.10）。
  **第九轮第 4 条把「铺满」从「用负外边距凑」换成布局保证**：三套主题的舞台改成相对 `.pi-home__stage` 的
  `position: absolute; inset: 0`，主题内部一律按 `ResizeObserver` 量到的视口尺寸重算——**窗口缩放、最大化、
  全屏、任意宽高比都不留白、不变形**，一个 px 常量与断点都不剩；顺手修掉两处真溢出（浮名相机漏乘 scale
  把靠后的列推出屏幕、心象的落位半径让词落到视口外被裁），详见 `docs/PLAN.md` §4.11。
- **播放页背景是跟着歌曲情绪与歌词走的沉浸式背景**（第七轮第 5 条）：模糊封面 + 色洗 + 15 个形状 + 20 个粒子 + 暗角四层，
  随「情绪标签 / 是不是副歌 / 能量」变化。**我们没有走 LLM**：情绪是本地 89 条中英情绪词典按歌词打分算的，
  能量是「时间 + 歌词位置 + 歌 id 种子」的伪能量（**不是**真音频分析），封面取不到字节时会回退中性色——
  这几条限制照实写进 `docs/PLAN.md` §4.9。**第九轮第 5 条**把封面从「糊成色块」改成**认得出是哪张封面**：
  模糊 40px → 3px（底下垫一层 56px 的柔化层做环境色）、色洗不透明度 0.75 → 0.34，并给封面加了极慢的漂移；
  逐句驱动除了情绪词典，还多了一层**字形**度量（可见字数 / 拉丁占比 / 情绪标点密度），但**只乘幅度与浓度、
  不动动画时长**（改时长会让循环动画相位跳变＝闪）。
- **推荐页已删除**（第七轮第 3 条）：导航抽屉与环形菜单里都点不到它了，`components/CollapsibleSection.tsx`、
  `pages/QualityLogPage.tsx`、`components/QualityLogBody.tsx` 随之删掉（后两者的内容搬进设置页的「日志」页签）。
- **双击悬浮球直接回播放页**（不用 `onDoubleClick`：第一下已经把菜单弹开了，等浏览器再判双击会先弹出再收回、闪一下；
  改成自己记 240ms 内的两次点击，拖动松手那一下不算）。
- **所有歌曲列表都是「一行中心聚焦封面流」**（第七轮第 2、3 条，`components/SongCards.tsx` 整文件重写）：
  **中间那张放大变亮（1.1 倍）、两侧依次缩小变暗并向侧转**，标题与「歌手 · 专辑」跟在卡片下方；
  **按住左右拖动可以平滑切换**（滚轮/键盘也行），松手回弹到最近一张，点中心那张就播。
  唯一例外是**「我的喜欢」——它仍是封面拼贴墙**。**第八轮第 6 条又改了它的打开方式**：点歌单/歌曲不再进单独的
  歌单页，而是**当前播放页整体模糊、卡片列表浮上来**（`components/SongListOverlay.tsx`，`position: fixed` + `blur(26px)`），
  点空白关掉；**拖拽时每一帧就换中心高亮**（每帧写 `data-focus-index`/`data-focused`），不用等松手。
  **这里踩过一个真 bug**：浮层第一版 `z-index: 45` 压住了悬浮球（40），球被盖住后封面环**转不动**了——
  落点探针打出 `命中=DIV|pi-songcards__stage`，降到 18 之后才 `命中=BUTTON|pi-orb__cover`、`spin 0→-36°`；
  层绞阶梯（页面 1~8 < 卡片列表 18 < 抽屉 20/21 < 球 40 < 搜索/设置 60）连同理由写进了 CSS 注释。
  **第九轮第 2、6、8 条**把「所有歌曲列表都走这套卡片流」收了口：搜索结果是它、点名片里的歌手/专辑名是它、
  环形菜单的「播放列表」也是它（旧的 `.pi-queue` 行列表抽屉与 `components/QueuePanel.tsx` 已删，详见 §4.11）；
  **歌单详情页的返回键也去掉了**（第九轮第 3 条）——**点玻璃空白处或按 Esc** 就退出，回到播放页。
- **流畅性**：环形菜单展开/坠入的那 0.65 秒里按键不跑背景模糊（`data-transiting`），封面环拖动用
  `requestAnimationFrame` 把一帧内的多次 `pointermove` 合成一次重渲染。不过 144Hz + 硬件加速下实测帧时间
  本来就已跑满（p95 ≈ 7.1ms），这两项减少的是白算的活、量不出帧时间收益——A/B 数据照实写在 `docs/PLAN.md` §4.8。
  **第八轮第 5 条**又给歌单环加了三件预取：球一展开就发请求（不再等到进封面环）、歌单数 12 → **50**、
  进环时用 `new Image()` 预热每张缩略图——实测 50 张封面、拖动 135 帧 `p50=6.9ms` 掉帧 0。
- **设置是一页边框式分类面板**（第七轮第 8 条做成「页」，第八轮第 7 条改成**从屏幕中心流出来的框**）：
  顶部一张大封面 + 一个纯 CSS 黑胶（播放时转、暂停时停），下面一排页签图标——**音源 / 播放 / 界面 / 歌词 / 账号 / 日志**，
  切换时内容在**小框里成组**显示这一类设置，账号卡单独一块，底部是「同步数据」按钮（真的会让当前所有查询失效并重取）。
  **框外点一下或 Esc 关掉**；整页设置路由已从 `PAGES` 里删掉（`NavId` 不再有 `settings`，抽屉里那一项改调 `openSettings()`）。
- 自动隐藏的计时在 `apps/renderer/src/lib/idle.ts`（第九轮第 7 条：**拖悬浮球走的时候不唤醒**已经隐掉的名片/进度条）、
  封面取色在 `apps/renderer/src/lib/song-palette.ts`、
  拖动与吸附的实现都在 `apps/renderer/src/lib/drag-snap.ts`；完整设计说明与踩过的坑见
  `docs/PLAN.md` §4.12（第十轮）、§4.11（第九轮）、§4.10（第八轮）、§4.9（第七轮）与 §4.8（第六轮）；更早的：第四版 §4.6、第三版「单键升起 / 设置子菜单 / 歌单封面环」在 §4.5，
  第二版「悬停哪半边升起 / 更多抽屉」在 §4.4，第一版「悬浮球 + 底部 dock」在 §4.3。

## 里程碑

M0 地基 ✅ → M1 账号与我的面 ✅ → M2 播放引擎 ✅ → M2.6 反馈修订（封面 / 详情页版式 / 队列 / 推荐页 / 天蓝玻璃）✅ →
M2.5 音源体系 ✅ → M3/M4 **界面改版第一版（悬浮球 + 抽屉 + 可拖动 dock + 播放器主页 + 评论/喜欢）**✅ →
M3/M4 **界面改版第二版（悬浮球与 dock 合成一个球 + 环形菜单 + 空白初始页 + 详情页歌词/悬浮框）**✅ →
M3/M4 **界面改版第三版（单键升起 + 设置子菜单 + 阵列收紧 + 歌单封面环绕球）**✅ →
M3/M4 **界面改版第四版（iOS 毛玻璃 + 换页过渡动画 + 按键/封面放大 + 推荐改歌单环 + 搜索浮层 + 贴边细条 + 暂停图标修复）**✅ →
M3/M4 **界面改版第五版（空歌单卡片一键建单/加歌 + 点球逐个坠入 + 我的喜欢封面拼贴墙 + 播放页歌词轨道 + folia 材质 + 搜索卡片鼠标拖拽）**✅ →
M3/M4 **界面改版第六版（性能优化 + 双击悬浮球回播放页 + 歌曲卡片列表 + 滚歌词只浏览不改播放 + folia classic 歌词舞台复刻 + 鸣谢账本）**✅ →
M3/M4 **界面改版第七版（环形菜单一层化 + 中心聚焦封面流 + 六套歌词主题 + 沉浸式情绪背景 + 播放页小名片与底部浮空进度条 + 细条更细且拖到边上不被挤 + 边框式设置页）**✅ →
M3/M4 **界面改版第八版（无操作自动隐藏 + 进度条只留进度 + 点歌词跳播 + 三套歌词动效全屏/多语言/跟封面色 + 歌单环预取 + 卡片列表改模糊浮层且实时高亮 + 中心流出设置框 + 环形按键贴近球）**✅ →
M3/M4 **界面改版第九版（进度条悬停展开 + 名片操作框与歌手/专辑卡片 + 歌单点空白退出 + 三套歌词主题铺满全屏 + 沉浸式背景认得出封面 + 搜索与播放列表统一成卡片流）**✅ →
M3/M4 **界面改版第十版（设置页删掉封面黑胶 + 球/名片/进度条换透光玻璃 + 进度条定长且不再隐藏 + 卡片浮层改真模糊并点空白退出 + 浮名/心象/云阶三处真 bug + folia 式歌词动效设置 + 冒烟能拍歌词成品图）**✅ →
M3/M4 **界面改版第十一版（浮名相机按「正在唱的那块」夹取 + 和声/逐字真时间轴 + 进度条缩到参考图比例且音量条从音量键里长出来 + 心象沿阅读顺序收进中间带 + 云阶改短块楼梯 + 取消标题栏改右上角浮出三键）**✅ →
M3/M4 **界面改版第十二版（倾诉/时计/流光也铺满整窗并重标字号 + 名片改竖排且封面在顶 + 进度条两键常态收起、悬停回弹长出 + 右上三键去边框只留图标 + 设置页改拍立得卡片式）**✅ →
M3/M4 **界面改版第十三版（歌词进度两处真 bug + 右上三键放大 + 进度条悬停向上长大且上两角浮出上一首/下一首 + 时计表盘按参考图补齐 + 音量条归轴 + 接上系统媒体卡片 + 「我的喜欢」改 folia 式队列拼贴一期）**✅ →
M3/M4 **界面改版第十四版（底部控制条按参考图重排 + 「我的喜欢」/心象复刻 folia 的形似 + 浮名镜头跟随当前句 + 流光逐字旋转开关 + 云阶字号错落与当前句放大 + 时计小齿轮转动与表盘四旋钮 + 切歌小名片重做）**✅ →
M3/M4 **界面改版第十五版（队列拼贴 3D 俯仰与点击放大成方形 + 删环形歌单展示改卡片墙 + 进度条 150% 与轨道两端上下首键 + 歌词常态墨色/高亮渐退 + 冒字带旋转 + 浮名曲尾缩镜到整首可见 + 时计齿轮只随环转 + 云阶线与字同出 + 音量条两级悬停）**✅ →
M3/M4 **用户 m01402 八条改版（歌单卡片页去白边直接露模糊播放页 + 暗槽与球同宽·去文字·末端无边框图标·拖出基准点锁方向 + M4 专辑/歌手独立页与浮名曲尾「剩余 N 秒」+ 右上三键靠近就出现 + 快捷卡去倾斜 + 底栏键原地缩小消失与进度条去小篮球 + 流光禁滚轮·时计可点跳进度且不出球 + 切歌名片 3s 与回页不重弹）**✅ →
**M4 已收口**：专辑/歌手独立页（用户 m01402 第 3 条）与浮名曲尾「剩余 N 秒」判据都已做（见上文浮名一条与 `docs/PLAN.md`）；亮档歌词墨色**判为保持 `var(--pi-text)`**（实测 `rgb(26,29,36)`）——本机幕布是白的，字面纯白会让没唱到的行看不见，要改就删 `styles/lyric-stage.css:77-78` 那两行兜底。 →
M3/M4 **用户 m02213 八条改版（PI 球能拖到暗槽一端 + 歌单拼贴改真全屏 + 先锋「我的喜欢」先预拉满再拼贴 + 左划切风格顶框弹「已切换⨯⨯风格」2s + 顶框长按改拖窗口 + 快捷设置账号栏重做 + 名片右下爱心与悬停封面四角四键·删掉旧操作框）**✅ →
M3/M4 **用户 m02898 九条改版（本地歌曲不再标灰且六个图标等大 + 播放列表浮层正常显示歌曲 + 推荐歌单「每日推荐」置顶（平凡卡片网格与先锋封面轮播两档都做）+ 快捷设置删灰字提示并把「默认音质」改成六颗按键组 + 名片角落「收藏到歌单」改窗口正中浮窗选择 + 先锋歌单拼贴「模糊遮罩」真因修掉（网格行 `0 1fr` 把正文压成 104px）·平凡档歌单选择页补底部进度条 + 评论页顶部让出右上三键 46px + 文件瘦身 62.99MB·离线便携产物·应用系统名改 pi` + 子进程堆上限 384MB）**✅ →
**用户 m02898 九条的实测读数**（`PI_SMOKE_UI=1`，平凡 + 先锋各跑一次，两跑都到「十六轮十四项总闸 → 通过」「第十八轮总闸 → 通过」「M3 渲染层验收 → 通过」）：①`本地档 state=ready 六图标宽=[20.4,20,20,20,20,20]px 等大=true`；③`每日推荐卡=true（每天零点换一批 · 32 首）排在首位=true（前面 0 张卡）｜点开每日推荐浮层=true 行数=32/26`；④`音质按键 6 颗/已选 1 颗/原生 select 0 个 点档切换=hires→standard`、`设置卡灰字已删=true（卡内 footer 0 个）`；⑤`浮窗=true position=fixed 卡 340×724 中心偏移 dx=0 dy=0 行=120 关闭键=true`；⑥a`歌单拼贴铺满窗口：浮层=1182×772@0,0 铺满=true 内边距=0 网格行=772px 正文高=772 画布高=772 内容铺满=true ✓`（修前 `主体=0,0 1182x104`、`网格行=0px 772px`）；⑥b`这一页 [data-collage-bar]=true 内 [data-home-bar]=true（药丸 269×44）点右端时间字(710,732) 落点=pi-home__barlyn → 回播放页=true`；⑦评论档 `top=46px`（三键浮层高 38px + 8px 呼吸）；⑧`系统名=pi AppUserModelId=com.pi.music userData=C:\Users\asus\AppData\Roaming\@pi\desktop（老库原地保留）图标候选命中=1/3`，`scripts/clean.mjs --apply` 删 409 项 / 释放 62.99MB，`scripts/make-dist.mjs` 产出 `release/pi/` 3311 文件 / 398.75MB；⑨`运行时内存：Electron 进程=4 合计 workingSet=390MB｜Browser=119 GPU=117 Utility=48 Tab=106｜子 Node 堆上限=384（默认）MB/个`。**照实说**：⑧改不了 `pi.exe` 内嵌 PE 资源（本机无 rcedit 也无网络）⇒ 任务管理器「进程」标签与 exe 属性页仍显示 Electron，也没注册表登记（「应用和功能」里不会有 PI，真正 setup 要 electron-builder/Inno）——**【2026-09-30 更新：此条已解决】**`scripts/patch-exe.mjs`（resedit，纯 JS、不联网）现在会在打包时改写 `pi.exe` 的 PE 资源段（内嵌图标 6 个尺寸 + ProductName/FileDescription/CompanyName/LegalCopyright，并删掉 Electron 带来的 SquirrelAwareVersion），`scripts/make-installer.mjs` + `scripts/pi-installer.nsi` 另行产出 `release/PI-Setup-<版本>.exe`：按用户装到 `%LOCALAPPDATA%\Programs\PI`、建开始菜单项、登记 HKCU 卸载键 ⇒ 「设置 → 应用 → 已安装的应用」里能看到 PI 并卸载；本行其余读数（①③④⑤⑥⑦⑨）未变；⑨的 390MB 是**本机亮档实跑**读数，子进程堆上限是**上限**而不是实测占用（那个 1GB 的「Node.js JavaScript Runtime」在用户图上极可能是 `pnpm dev` 工具链而非发行版应用）。细节与这一轮踩的坑写在 `docs/PLAN.md` §4.20。 →
M3/M4 **用户 m03805 五条改版（三处「加载更多」按钮全删改下滑自动加载 + 播放列表浮层真因修掉（`.pi-songslist` 的 `48px auto 1fr` 把正文塞进 `auto` 轨道）·应用图标只占左上角的真因修掉（底板建在像素空间、采样在 256 空间）·名片封面四角键改「播放模式」与评论开关（播放模式补齐网易云四档，含「顺序播放」末首停）·我的下载页补底部进度条）**✅ →
**用户 m03805 五条的实测读数**（`PI_SMOKE_UI=1`，平凡 + 先锋各跑一次，两跑都到「十六轮十四项总闸 → 通过」「第十八轮总闸 → 通过」「M3 渲染层验收 → 通过」，红项 0 条）：①三处「加载更多」全变成 `div.pi-loadmore` 哨兵 + `IntersectionObserver`（`root` 由 `findScrollParent` 取、`PRELOAD_MARGIN='240px 0px'`、StrictMode 单次闸门），`grep 加载更多` 在 `apps/renderer/src` 只剩注释；②平凡 `播放列表浮层：行=34 拼贴格=0 标题=当前播放 正文=1080×594@51,904`、先锋 `行=0 拼贴格=46 拼贴画布=1080×636`（真因是 `.pi-listoverlay--collage .pi-songslist { grid-template-rows: 48px 1fr }` 一条新规则，修前正文只剩 `auto` 轨道的 0 高）；③图标不透明覆盖率 128/64/48/32/16 = **92.8 / 90.9 / 94.6 / 95.3 / 95.3 %**（修前 22.7 / 6.0 / 3.3 / 1.6 / 0.4 %，256 帧 sha256 逐字节不变），`build/pi.ico` 2816 → 3687 B、`release/pi/` 三份副本同覆；④`四角键=mode/share/comments/like（4 颗）｜模式 order→repeat-one（换了档=true，绕回原档=true）｜评论键 开=true 再点关=true ✓`，「歌曲信息」面板改由封面本体开（`data-card-cover="info"`）；⑤`tab === 'download'` 也挂 `<BottomBar />`（**照实说**：这一条冒烟没单独加断言，靠同页「我的喜欢」档的 ⑥b 覆盖，配置逐字相同）。验收：`tsc` 三包 0、`vitest --pool=threads` 22 files / 416 tests、build 2/2、两跑全绿；两跑 `EXIT=1` 仍只因既有的 `UI #3`（环境里那份歌单只有 2 首能播）。细节与踩的坑写在 `docs/PLAN.md` §4.21。 →
M3/M4 **用户 m04183 三条改版（歌曲播放页左上「PI 方块 + 版本号」部件与它点开的导航抽屉入口一起删除（只留一个 1×1 隐藏抓手给冒烟，用户点不到）+ 切风格提示改「灵动岛」近黑药丸（`top: 8px`·高 32px·恒定深色不跟主题·0.3s 撑开 / 0.24s 收拢）+ 悬浮球暗槽改成真正的凹槽（亮档 `--pi-text` 8% 混底板 = #E3E8ED、内投影上暗下亮，暗档 9% 白混底板 = #292F38 比背景亮一档））**✅ →
**用户 m04183 三条的实测读数**（`PI_SMOKE_UI=1`，平凡 + 先锋各跑一次，两跑都到「十六轮十四项总闸 → 通过」「第十八轮总闸 → 通过」「M3 渲染层验收 → 通过」，✗ 行 0 条）：①`窗口三键：…｜m04183 第 1 条：左上品牌块=0 左热区=0 抽屉抓手=1x1 opacity=0 pointer=none ✓`（三键面板本身没受影响：`命中=BUTTON.pi-windowcontrols__btn｜面板 top=0px 宽=150px｜size=42x34 icon=15x15 无框 ✓｜靠近就出现 ✓`），版本号 `v0.1.0 · win32/x64` 随部件一起消失（全仓再无第二处显示）；②`切风格顶框提示：0.36s 在=true style=avant leaving=false 文案「已切换先锋风格」｜2.26s 在=false｜2.68s 在=false uiStyle=avant ✓`（时间契约 `SHOW_MS=2000` / `EXIT_MS=240` 未动，`StyleToast.tsx` 只改注释）；③暗槽亮档填充 `#E3E8ED`（对页面白 1.233:1）、上内壁 `#C3C8CD`、下内壁 `#F7F8FA`，暗档填充 `#292F38`（对 `--pi-bg #0F1218` 1.391:1）。验收：`tsc` 三包 0、`vitest --pool=threads` 22 files / 416 tests、build 2/2（`out/main.mjs 873848B`、`index-DImkZXmW.css 156798B`）、两跑全绿；两次 `EXIT=1` 仍只因既有的 `UI #3`。**照实说**：②③ 没有截图（沙箱起不了 Electron，颜色是数值推算）；① 的抽屉组件 `NavDrawer.tsx` 与 `toggleNav` 仍在，本轮只删了「用户可见的入口」。细节写在 `docs/PLAN.md` §4.22。 →
M3/M4 **用户 m04407 四条改版（每日推荐队列拼贴铺满整窗（真因是纸的 `min(1080px,100%) × min(760px,100%)` 上限 + 44px 留白）+ 名片封面右下角键从爱心换成「列表 + ＋」并补真悬停·图标路径断言与成品图 + 底部进度条已播胶囊改圆头（`::-webkit-slider-runnable-track` 渐变 → 实心圆头 span）· 悬浮球必须拖到暗槽末端（58px）才开卡、半程松手什么都不开）**✅ →
**用户 m04407 四条的实测读数**（`PI_SMOKE_UI=1`，平凡 + 先锋各跑一次，两跑都到「十六轮十四项总闸 → 通过」「第十八轮总闸 → 通过」「M3 渲染层验收 → 通过」）：①先锋 `歌单拼贴铺满窗口：浮层=1182×772@0,0 窗口=1182×772 铺满=true 内边距=0px/0px/0px/0px 网格行=772px 正文高=772 画布高=772 内容铺满=true ✓`（修前 1080×636 + 44px 留白；平凡档该档不是拼贴页，打印「不适用」）；②`m04407 第 2 条：封面右下角键 opacity 0→1（悬停浮出=true） 可点=auto｜图标=playlistAdd ✓ → ✓`（真指针移到封面正中后复读，并留成品图 `docs/m3r32-coverkeys.png`（整窗）与 `docs/m3r32-coverkeys-zoom.png`（封面四角 3× 放大）——右下角是「三横线 + ＋」，与「我喜欢」的爱心一眼分得开）；③`十六轮⑥底栏比例：键=40x40 轨道=6px 滑块=12px 滑块填充=transparent 比值=2.0:1｜m04407 第 3 条：填充圆角=999px 填充 2x6 进度=0.0122 轨宽=153 轨道渐变=已撤 ✓`（先锋档 `进度=0.0121`）；④`半程拖球不触发（用户 m04407 第 4 条）：半程划 40px 松手：六块层=无 面板=false 球壳收掉=true ✓`（正半由既有的「②上划六块」一路划到底覆盖）。验收：`tsc` 两包 0、`vitest --pool=threads` 22 files / 416 tests、build 2/2（`out/main.mjs 880520B`、`index-DYgceeyE.css 157356B`）、平凡跑 ✗ 行 0 条；两次 `EXIT=1` 仍只因既有的 `UI #3`（那份歌单只有 2 首能播）。**照实说**：先锋第一跑同时踩中 `⑤切歌名片自弹` 与 `⑪拼贴翻页加载` 两条既有时序抖动（总闸未过），同一份代码原样重跑两条都 ✓。细节与踩的坑（含「按 DOM 盒子裁特写拍到了封面花纹」与「先挪指针再读 opacity 读出 0→0」两处）写在 `docs/PLAN.md` §4.23。 →
M3 **用户 m04892：先锋档「每日推荐」队列拼贴改成两段式（点一下先放大、再点一下才进播放页，与歌单详情那面拼贴一致）**✅ → `apps/renderer/src/components/SongListOverlay.tsx` 的 `SongsListOverlay.onSelect`（歌手/专辑/每日推荐/当前播放共用）末尾原本**无条件** `onClose()`，先锋档点第一下就收浮层 ⇒ 把 `collage` 判断提到 `onSelect` 之前、改成 `if (!collage) onClose();`（第二下交给 `SongCollage.enterPlayer()`：`COLLAGE_FILL_MS = 480` 后收浮层 + 回播放页）；平凡档列表逐字未动。实测（先锋 `.tmp-r33b-avant.log` 35505B，`AVANT_EXIT=0`）：`｜m04892 两段式：点一下 浮层还在=true 放大块=1 在播=2｜再点放大块=点到 之后浮层收掉=true ✓`，M3 本轮九条 ③ ✓、十六轮十四项总闸 → 通过、第十八轮总闸 → 通过、M3 渲染层验收 → 通过；`tsc` 两包 0、两次 build 0、vitest 22 files / 416 tests。细节见 `docs/PLAN.md` §4.24。 →
**M5 下载与本地库已收口**（用户 m02213 第 3 条）：`apps/desktop/src/main/downloads.ts` 下载队列（并发 2、Range 续传、清单落 `downloads.tasks`、启动对账缺文件标 `missing`）+ `resolveForPlayback` 命中已下载就直接发 `file://`（**一个网络请求都不发**）+ `library:list` 本地库只读清单，界面在「我的 → 我的下载」；实测 64.5MB Hi-Res 9~11s 下完、`在线尝试=0次`、**断网模拟下仍能播**、移除后文件真的删掉（详见 `docs/PLAN.md` §4.19） → M6 打磨与打包。
详见 [`docs/PLAN.md`](docs/PLAN.md) §5 与 §9（进度与实测记录），鸣谢与技术来源见 [`docs/CREDITS.md`](docs/CREDITS.md)。

## 常见问题

- **双击快捷方式毫无反应、一闪而过**（`pi-launch.log` 里只有 `Exit status 2147483651`，**一行 `[pi/` 都没有**）：
  `2147483651` = `0x80000003`，是 Chromium 的沙箱**拒绝初始化**时的退出码。真因是
  `node_modules\electron\dist\electron.exe` 带着 **Low 完整性标签**（某些沙箱 / 安全软件会把整棵目录树标成低完整性），
  而 Chromium 在浏览器映像为低完整性时不肯建沙箱，于是 `LOG(FATAL)` 直接崩——logging 的初始化排在失败步骤之后，
  所以加 `--enable-logging=stderr --v=1` 也一个字节都不打印。`PI.cmd` 每次启动都会用 `icacls` 把这一层补回 Medium
  （已经是 Medium 时无操作）；手工修：
  `icacls node_modules\electron\dist /setintegritylevel Medium /T /C /Q`。
  快速诊断：`node_modules\electron\dist\electron.exe --version` —— 没有输出就是中招了（正常打印 `v44.4.5`）。
  **`--no-sandbox` 不是修法**，那只是绕过沙箱、关掉渲染进程的安全隔离。
- **`pnpm install` 卡在 Electron 下载**：`.npmrc` 里已配好国内镜像；若仍失败，检查代理是否拦截了 `npmmirror.com`。
- **窗口一片空白**：多半是渲染进程产物缺失。生产模式下主进程会在找不到 `dist/index.html` 时给出提示页。
- **界面卡顿/黑屏**：主进程会记录 GPU 崩溃次数，连续两次后自动改为软件渲染（`bootstrap.json`）。
- **变灰的歌点了不出声**：先去「设置与音源」确认第三方音源已启用（默认关闭，要过一次风险确认），
  再去「音质日志」看这一首的解析链——每一层的失败原因与耗时都在那里。
- **无人值守冒烟起不来 Electron**：同一个 Low 完整性问题会让 `electron.exe` 以 `0x80000003` 立刻退出
  （代码一行都没跑到，连 `--version` 都没输出）。修法与上面那条一样（`PI.cmd` 里就是那两行）；另外 Chromium 写
  `%APPDATA%` 被拒时 `requestSingleInstanceLock()` 返回 false 会静默退出，所以冒烟固定用仓库内的 profile：
  `node_modules\electron\dist\electron.exe apps\desktop --user-data-dir=<仓库>\.smoke-profile`。
  完整性级别正确时**不需要** `--no-sandbox`（2026-09-25 两条无窗口/渲染层冒烟都不带它，均通过）。
