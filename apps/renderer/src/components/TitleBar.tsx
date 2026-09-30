/**
 * 第十一轮第 5 条（用户 m03279：「app 窗口顶部的标题栏直接取消」）把这个组件删掉了。
 *
 * 这份文件本该被**删除**，但沙箱对该路径的删除被拒（`Remove-Item` / `[System.IO.File]::Delete` /
 * `Move-Item` 全部报 `Access to the path is denied`，同目录其它文件可正常建删），所以留成一个
 * 只剩说明的空壳：没有任何模块 import 它（`from '.*TitleBar'` 全仓 0 命中）。
 * 本机执行 `Remove-Item -LiteralPath 'apps\renderer\src\components\TitleBar.tsx'` 即可清掉。
 *
 * 取代它的是 `apps/renderer/src/components/WindowControls.tsx`：
 * 左上品牌键（仍带 `[data-nav-toggle]`，冒烟靠它开抽屉）+ 右上三键（最小化/最大化/关闭，
 * `[data-window-btn]`），两者都在指针接近对应角时向下浮出；窗口本身在 Windows 上已改成
 * `frame: false`（`apps/desktop/src/main/index.ts:168`）。
 */

export {};
