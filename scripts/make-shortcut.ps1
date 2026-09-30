# scripts/make-shortcut.ps1 —— 生成一个「带图标」的 Windows 快捷方式（.lnk）。
#
# 为什么需要它：`.cmd` 文件在资源管理器里永远是那个白底齿轮图标，只有 `.lnk`
# （shell link）才能自定义 IconLocation。Windows 上建 .lnk 的官方途径就是
# WScript.Shell 这个 COM 对象——它随系统提供，不需要装任何东西。
#
# 用法（被 scripts/make-dist.mjs 调用，也可以单独跑）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-shortcut.ps1 `
#       -LnkPath   "X:\...\release\PI.lnk" `
#       -TargetPath "X:\...\release\pi\pi.exe" `
#       -IconLocation "X:\...\build\pi.ico" `
#       -WorkingDirectory "X:\...\release\pi"
#
# 退出码：0 = 成功；1 = 建不出来（沙箱禁用 COM / 路径不存在），调用方据此退化处理。
param(
  [Parameter(Mandatory = $true)][string]$LnkPath,
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][string]$IconLocation,
  [string]$WorkingDirectory = '',
  [string]$Description = 'PI 音乐播放器'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $TargetPath)) {
  Write-Error "[shortcut] 目标不存在：$TargetPath"
  exit 1
}
if (-not (Test-Path -LiteralPath $IconLocation)) {
  Write-Error "[shortcut] 图标不存在：$IconLocation"
  exit 1
}

$dir = Split-Path -Parent $LnkPath
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

try {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($LnkPath)
  $link.TargetPath = $TargetPath
  $link.IconLocation = "$IconLocation,0"
  if ($WorkingDirectory -ne '') { $link.WorkingDirectory = $WorkingDirectory }
  $link.Description = $Description
  # 1 = 常规窗口（3 = 最大化，7 = 最小化）
  $link.WindowStyle = 1
  $link.Save()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
  Write-Output "[shortcut] OK $LnkPath -> $TargetPath (icon=$IconLocation)"
  exit 0
} catch {
  Write-Error "[shortcut] WScript.Shell 不可用：$($_.Exception.Message)"
  exit 1
}
