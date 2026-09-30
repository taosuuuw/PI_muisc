# PI 接口映射（IPC ↔ 上游）

本文件是 **契约层的单一事实来源**：每一个 `@pi/ipc` 通道对应哪个上游接口、参数从哪来、有没有走责任链。
渲染进程**不允许**直接访问网络或文件——它只能调用下表里的通道，出入参都由 zod 双向校验
（`packages/ipc/src/index.ts` 的 `CH` / `INPUT_SCHEMAS` / `OUTPUT_SCHEMAS`，编译期另有
`AssertAssignable` 锚定，防止领域模型与 schema 悄悄漂移）。

上游接口全部由内嵌的 `NeteaseCloudMusicApi` 子进程提供（`packages/ncm-server`，只监听 `127.0.0.1`），
由 `packages/ncm-client` 翻译成领域模型。**`x-apicache-bypass: true` 是所有请求的默认头**：
该后端用 `apicache` 缓存且 key 不含请求体，不加这个头会让「同一路由 + 不同参数」在 2 分钟内串成同一份响应。

## 一、请求/响应通道（`CH`）

| 通道 | 上游接口 | 说明 |
|---|---|---|
| `app:info` | — | 应用版本、平台、内嵌 API 端口、媒体代理端口 |
| `account:capability` | — | 由 `auth.profile` + `/vip/info` 推出的能力（登录态 / VIP / 最大音质）。M2.5 增 `thirdPartyEnabled` |
| `settings:get` | — | 读取 `Settings`（含 `preferredQuality`、`enableThirdPartySources`、`thirdPartyAcknowledged`、`allowThirdPartyLossless`、`localLibraryDir`、`scrobbleEnabled`、`playMode`、`volume`、`theme`、`locale`） |
| `settings:patch` | — | 局部更新设置；`localLibraryDir` 变化会立刻重扫本地曲库，任何改动都会清空播放地址缓存 |
| `ncm:health` | — | 内嵌 API 子进程状态（`idle` / `starting` / `ready` / `restarting` / `failed`） |
| `ncm:search` | `/cloudsearch?keywords=&type=` | 搜索（1 歌曲 / 10 专辑 / 100 歌手 / 1000 歌单） |
| `auth:qr-key` | `/login/qr/key` | 取二维码 unikey |
| `auth:qr-check` | `/login/qr/create?qrimg=1` → 轮询 `/login/qr/check` | 800 等待 / 801 待扫 / 802 过期 / 803 成功；803 时立刻落盘 cookie |
| `auth:logout` | `/logout` | 清 cookie 与 profile，广播 `account:changed` |
| `library:recent` | `/user/record?uid=&type=1` | 最近听过 |
| `library:liked` | `/likelist?uid=` + `/song/detail?ids=` | 我喜欢 |
| `library:my-playlists` | `/user/playlist?uid=` | `subscribed=false` 自建 / `true` 收藏 |
| `library:recommend` | `/recommend/songs` | 每日推荐（登录后才有） |
| `library:personalized` | `/personalized` | 推荐歌单 |
| `library:radar` | `/playlist/detail?id=3136952023` + `/playlist/track/all` | 私人雷达（固定歌单 id，内容按 cookie 个性化） |
| `library:new-songs` | `/personalized/newsong` | 推荐新音乐 |
| `library:playlist-tracks` | `/playlist/track/all?id=&limit=&offset=` | 歌单全量曲目（分页） |
| `ncm:comments` | `/comment/music?type=0`（首页另调 `/comment/hot?type=0&limit=15`） | 单曲评论：`{ songId, offset?, limit? }` → `{ total, hasMore, hot, comments }`。**不需要登录** |
| `ncm:like` | `/like?id=&like='true'\|'false'` | 喜欢 / 取消喜欢：`{ songId, like }` → `{ liked: number[] }`（该曲最新状态）。**需要登录**。`like` 必须是字符串，`module/like.js` 靠 `query.like == 'false'` 判断 |
| `ncm:like-check` | `/song/like/check`（不传 ids 时 `/user/account` 取 uid + `/likelist`） | 批量查已喜欢：`{ songIds: number[] }`（≤200）→ `{ liked: number[] }`。注意契约里假设的 `/song/like` 在内嵌 API 中不存在；不传 ids 时 uid 是 `/likelist` 的必选参数 |
| `ncm:lyric` | `/lyric/new?id=&lv=-1&kv=-1&tv=-1` | 单曲歌词：`{ songId }` → `{ lines, translated, hasLyric }`（`lines`/`translated` 各自按 `timeMs` 排好序，`hasLyric` 是必填的——纯音乐/未收录会返回「合法但没有歌词」，那不是错误）。**不需要登录**。**上游 yrc 的真实格式是「行首毫秒对 + 逐字括号组」**（`[16210,3460](16210,670,0)还(16880,410,0)没`），不是 `[mm:ss.xxx]`——解析器两种都认，且只在 yrc 解出 ≥1 行时采用它、否则回退 lrc |
| `player:resolve` | **责任链**，见第二节 | `{ song, level? }` → `{ audio \| null, attempts, src? }`；`src` 是本机代理地址 |
| `sources:list` | — | 每个音源的启用状态与健康度（失败 / 成功 / 未匹配 / 降级计数、降权剩余时间） |
| `sources:reset-health` | — | 清掉某个（或全部）音源的降权与计数 |
| `sources:plugins` | — | 已导入的 LX 自定义源插件（**不含脚本文本**） |
| `sources:import-plugin` | — | 导入脚本文本（**只收文本，不收 URL**）；导入时会在沙箱里真跑一次 |
| `sources:toggle-plugin` | — | 启用 / 停用某个插件 |
| `sources:remove-plugin` | — | 删除插件 |
| `sources:quality-log` | — | 最近 200 次解析记录（来源、实测格式、逐条 attempt） |
| `window:minimize` / `window:toggle-maximize` / `window:close` | — | 窗口控制 |

## 二、播放解析（`player:resolve`）——责任链

按优先级依次尝试，第一个**满足当前音质要求且通过字节嗅探**的结果胜出；全失败才判「不可播」。

| 层 | 实现 | 上游 | 备注 |
|---|---|---|---|
| L0 | `packages/source-official` | `/song/url/v1?id=&level=` | 阶梯 `lossless → hires → exhigh → higher → standard`；官方只给试听片段时**继续往下试其它层**，并把结果标成 `trial` |
| L1 | `packages/source-unm` | UnblockNeteaseMusic `match()`（kugou / bodian / migu 等平台） | 作为 npm 库进程内调用，**不用系统代理、不改 hosts、不装证书**；结果带 TTL 缓存（含负缓存） |
| L2 | 未实现（可选层，默认关闭） | — | 计划中的其它聚合源 |
| L3 | `packages/source-lx` | 用户导入的 LX 协议脚本 | 脚本跑在**独立子进程**里，白名单 `lx` API，`lx.request` 经主进程代理转发 |
| L4 | `packages/source-local` | 用户本机文件夹 | 只读文件名（不解析标签），歌名 + 歌手 + 时长三重硬条件匹配，宁可不中也不放错歌 |
| — | `packages/resolver` | `QualityProbe` | `HTTP Range: bytes=0-65535` 嗅探 `fLaC` / `ID3` / `ftyp` / `OggS` / `RIFF` / ADTS，FLAC 读 STREAMINFO 取真实采样率；与来源自称不一致时同时给出 `claimedQuality` |

**安全红线（写进代码而不是文档里）**：`MusicSource.needsCookie` 只有 L0 为 `true`；
`ResolvedAudio.upstreamHeaders`（回源请求头）与 `localPath`（本地文件路径）**在 `publish()` 里被剥掉**，
渲染进程拿到的永远是本机代理的不透明地址。

## 三、事件通道（`EVT`，主进程 → 渲染进程）

| 事件 | 何时发 |
|---|---|
| `account:changed` | 登录成功 / 退出 / cookie 失效后重新解析出账号能力 |
| `ncm:health-changed` | 内嵌 API 子进程状态变化（含重启） |

## 四、本机音频代理（不是 IPC，但属于对外契约）

`http://127.0.0.1:<随机端口>/audio/<每次播放现生成的 UUID>?t=<每次启动随机 token>`

- 只监听 `127.0.0.1`，只允许 loopback 来源；token 或路径不匹配直接 404。
- 上游直链、`Referer` / `User-Agent`、cookie 全在主进程处理；`Range` / `206` / `content-range` 透传。
- **本地文件走同一入口**：`localPath` 分支用 `createReadStream` 直接读盘（`Range` 自己算），
  渲染进程不需要（也不允许）知道文件在哪。
- 决策与备选见 [`docs/ADR/0004-音频播放与本地代理.md`](ADR/0004-音频播放与本地代理.md)。
