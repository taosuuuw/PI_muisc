# ADR-0003：Electron 运行时获取与内嵌 API 的分发方式

- 状态：已采纳
- 日期：M0 地基阶段
- 相关：`docs/PLAN.md` §2.3 / §2.6，`docs/ADR/0002`

## 背景

M0 收尾时踩到两个和「跨环境可运行」直接冲突的坑，必须留下记录，否则下一个接手的人会重踩：

1. **Electron 44 移除了 postinstall。** 安装 `electron@44.4.5` 后 `node_modules/electron/dist` 是空的，`path.txt` 也不存在——因为它的 `package.json` 里根本没有 `postinstall` 脚本。
2. **`NeteaseCloudMusicApi` 无法被 esbuild 打包。** 它的 `pkg.assets` 里列了 `module` 目录：路由是用 `fs.readdirSync('module')` + 动态 `require` 装载的。esbuild 只能静态分析依赖图，这种模式打包出来的产物在运行时会「少一堆路由」，而且报错点很隐蔽。

## 备选方案

### A. 依赖依赖包的 `postinstall` 自动下载 Electron 二进制
- 过去十年的事实标准写法（`onlyBuiltDependencies` / `--ignore-scripts=false`）。
- **否决**：Electron 44 起该脚本已不存在，配置写得再对也不会执行。

### B. 在 CI 里手工 `curl` 下载并解压，或用 `ELECTRON_OVERRIDE_DIST_PATH` 指到自建目录
- 可控性最强，内网镜像友好。
- **否决**：把「官方支持的获取路径」换成自己的脚本，等于把 Electron 的版本/校验/平台矩阵维护责任揽到自己身上（`@electron/get` 已经做了 checksum 校验与多镜像回退）。

### C. 保留 Electron 官方的**懒下载**，另外提供显式预热命令
- `electron@44` 的 `index.js` 在首次 `require('electron')` 时若发现 `dist`/`path.txt` 缺失，会自动 spawn `install.js` 下载（`@electron/get` + `checksums.json` 校验，镜像由 `.npmrc` 的 `electron_mirror` 决定）。
- **采纳**：不逆着上游设计走；同时加一条 `pnpm electron:install`（直接调用包自带的 `install-electron` bin）供 CI 与「首次开发」显式预热，避免把一次 250MB 下载埋在第一次 `pnpm dev` 里让人以为卡死。

### D. 把 `NeteaseCloudMusicApi` 打成单文件 bundle 随包分发
- 体积最友好，符合最初 §2.6 规则 2 的设想。
- **否决**：动态 require 导致产物缺路由（见背景 2）。要救就得写自定义 esbuild 插件去遍历 `module/` 目录生成虚入口，维护成本高于收益，而且每次上游加路由都要重新对齐。

## 决策

**Electron 运行时**：采用 C。
- `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 只保留 `esbuild`（`electron` 已无脚本可放行，留着只会误导）。
- 根 `package.json` 提供 `electron:install` 脚本；README 与 CI 都应先跑它。
- 首次 `pnpm dev` 若看到 `Downloading Electron binary...`，那是预期行为，不是卡死。

**内嵌 API 分发**：不 bundle，改为「**原始文件 + Electron 自带的 Node**」。
- 只 bundle 我们自己的 bootstrap（`apps/desktop` 的 main/preload）。
- 运行时用 `createRequire(import.meta.url).resolve('NeteaseCloudMusicApi/app.js')` 在**已安装的包目录内**求出入口，再以 `spawn(process.execPath, [entry], { cwd: dirname(entry), env: { ELECTRON_RUN_AS_NODE: '1', HOST, PORT } })` 启动。
- `cwd` 必须是包目录，否则它用 `__dirname`/相对路径找 `module/` 会失败。
- M6 打包时用 `extraResources` 把这个包（解包约 8.6MB，纯 JS，无原生模块）原样放进产物，而不是打包整个 `node_modules`。

## 后果

- ✅ 用户机器上不需要任何 Node / Python / 编译工具链，与 §2.6「零运行时依赖」一致。
- ✅ 内嵌 API 天然崩溃隔离：它挂了只是在线功能不可用，UI 照常启动（主进程只在后台重试，最多 2 次）。
- ⚠️ 首次启动有一次性 250MB 下载；离线环境必须提前预热缓存（CI 用 `pnpm electron:install`）。
- ⚠️ 产物里会多出 `NeteaseCloudMusicApi` 的原始文件树，打包脚本要显式把它列进 `extraResources`（M6 任务，已记入 PLAN §6/G3）。
- ⚠️ 内嵌服务用的是 Electron 自带的 Node，因此**不能**在它里面使用需要 Node 特定 ABI 的原生模块——本来也不需要。

## 复审触发条件

- Electron 恢复 postinstall，或改为其它获取机制（`@electron/get` 大版本变更）。
- `NeteaseCloudMusicApi` 改为静态路由装载（那时 bundle 重新变得可行）。
- 需要把内嵌 API 换成自研实现（则本 ADR 的分发部分整体作废）。
