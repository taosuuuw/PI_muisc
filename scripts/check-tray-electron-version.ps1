# 托盘「降版本对照」一键脚本（给主人自己跑；我这边被审查挡在下载这一步外面了）
#
# 背景：这台机器上
#   · .NET 的 NotifyIcon（底层就是 Windows 的 Shell_NotifyIcon）挂图标 → 系统登记表 +1 ✓
#   · 当前项目用的 Electron 44.4.5 挂三枚图标（含纯红 16×16） → 登记表 +0、可见区与隐藏抽屉都没有 ✗
# 怀疑是 Electron ≥43.4.1 的回归（见 KDE bug 524697）。这个脚本把「旧版 Electron 会不会好」量出来。
#
# 2026/10/13 更新（重要，先读这条再信上面的结论）：
#   上面那两条「背景」是在 **agent 沙箱** 里量的，而沙箱是 AppContainer/Low 完整性，
#   Shell_NotifyIcon 会被 UIPI 直接拒（实测 ERROR_ACCESS_DENIED=5），所以「Electron 登记表 +0」
#   至少有一部分是**沙箱造成的假象**，不能单独作为「Electron 有回归」的证据。
#   要下结论请在**普通桌面会话**里跑；另外 KDE bug 524697 / Electron #53215 是 Linux
#   StatusNotifierItem 的问题，跟 Windows 托盘无关，别拿它当 Windows 侧回归的依据。
#
# 本脚本只管理**自己启动的进程树**（PID / taskkill /T），不再按进程名杀 electron——
# 之前的写法会把主人正在跑的 PI、VS Code、ChatGPT 桌面版一起杀掉。
#
# 用法（在仓库根目录、普通 PowerShell 窗口里跑，不要在 agent 沙箱里）：
#   pwsh -NoProfile -File scripts\check-tray-electron-version.ps1
#   pwsh -NoProfile -File scripts\check-tray-electron-version.ps1 -Version 42.5.0   # 想换版本就加参数
#
# 它会做三件事：① 打印当前 Electron 的基准；② 下载并运行指定旧版，量登记表差值；
# ③ 打印结论（差值 >0 = 旧版能注册托盘图标 ⇒ 就是这个方向的回归）。
param(
  [string]$Version = '43.4.0',
  [int]$WaitSeconds = 40
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Get-TrayEntryCount {
  @(Get-ChildItem 'HKCU:\Control Panel\NotifyIconSettings' -ErrorAction SilentlyContinue).Count
}

# 只收尾「本脚本启动的那棵进程树」：PID 精确、含子进程，不碰其它 electron。
function Stop-ProbeTree([int]$RootPid) {
  if (-not $RootPid) { return }
  Start-Process -FilePath 'taskkill.exe' -ArgumentList '/T', '/PID', [string]$RootPid, '/F' -Wait -NoNewWindow
}

Write-Output '=== 托盘降版本对照实验 ==='
$probe = Join-Path $root '.tmp-tray-test.cjs'
if (-not (Test-Path $probe)) { Write-Output ('缺少探针脚本：' + $probe); exit 1 }

# --- ① 当前版本基准 ---
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (Test-Path $electron) {
  $current = (Get-Content (Join-Path $root 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version
  Write-Output ('当前版本 Electron ' + $current)
  $before = Get-TrayEntryCount
  $probeProc = Start-Process -FilePath $electron -ArgumentList $probe -PassThru
  Write-Output ('  探针 pid=' + $probeProc.Id + '（收尾只针对这棵树）')
  Start-Sleep -Seconds $WaitSeconds
  $after = Get-TrayEntryCount
  Write-Output ('  当前版本：登记表 ' + $before + ' → ' + $after + '（差值 ' + ($after - $before) + '）')
  Stop-ProbeTree $probeProc.Id
  Start-Sleep -Seconds 3
}

# --- ② 旧版本对照 ---
Write-Output ('下载并运行 Electron ' + $Version + '（首次约 150MB，走 npm；下载期间脚本会一直等）…')
$before = Get-TrayEntryCount
$npxProc = Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c npx --yes electron@' + $Version + ' "' + $probe + '"') -WorkingDirectory $root -PassThru
# 下载耗时不确定，所以「等探针进程真的起来」再计时：否则可能还没装上就把差值量成 0。
$deadline = (Get-Date).AddMinutes(10)
$seen = $false
while ((Get-Date) -lt $deadline) {
  $procs = Get-CimInstance Win32_Process -Filter "name='electron.exe'" |
    Where-Object { $_.CommandLine -like '*tray-test*' }
  if ($procs) { $seen = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $seen) {
  Write-Output '  10 分钟内没看到探针起来：可能是 npx 不在 PATH（或下载失败）。把这一行发我，我换个办法。'
}
Start-Sleep -Seconds $WaitSeconds
$after = Get-TrayEntryCount
$delta = $after - $before
Write-Output ('  ' + $Version + '：登记表 ' + $before + ' → ' + $after + '（差值 ' + $delta + '）')
Stop-ProbeTree $npxProc.Id

Write-Output ''
if ($delta -gt 0) {
  Write-Output ('结论：Electron ' + $Version + ' 能把托盘图标注册进系统（差值 ' + $delta + '）⇒ 当前 44.x 这一侧有回归，值得把版本钉到能用的那一版。')
} else {
  Write-Output ('结论：Electron ' + $Version + ' 也注册不进去（差值 0）⇒ 不是「43.4.1 之后」这一处，得继续往前试（比如 42.x）或者换别的思路。')
}
Write-Output '把上面两行差值发给我，我接着往下查。'
