# PI tray-icon registration probe (read-only diagnostics for a REAL desktop session).
#
# WHY THIS EXISTS
#   "Close to background, but there is no tray icon" can mean three very different things:
#     1. the app never handed an icon to the shell (registration failed),
#     2. the shell has the icon but Windows 11 keeps it inside the overflow drawer ("^"),
#     3. the app process was started from a restricted context where Shell_NotifyIcon is
#        refused by UIPI (ERROR_ACCESS_DENIED = 5). Chrome/Electron apps started from a
#        sandboxed agent shell hit this every time.
#   This script tells (1)/(3) apart from (2) by asking Explorer itself: Windows records every
#   notification-area icon it accepts under HKCU\Control Panel\NotifyIconSettings, including
#   the ones that stay hidden in the overflow.
#
# WHAT IT TOUCHES
#   * reads HKCU\Control Panel\NotifyIconSettings (read-only, no writes, no deletes),
#   * starts the app you point it at (or the built-in default) and waits,
#   * enumerates that process' windows and asks Shell_NotifyIconGetRect for the tray host,
#   * with -StopProbe it stops ONLY the process tree it started (never by image name).
#   It never changes Explorer settings, never restarts Explorer, never touches other apps.
#
# USAGE (run it from a normal PowerShell window, NOT from a sandboxed agent shell)
#   pwsh -NoProfile -File scripts\probe-tray-registration.ps1
#   pwsh -NoProfile -File scripts\probe-tray-registration.ps1 -Exe "release\pi\pi.exe" -WaitSeconds 25
#   pwsh -NoProfile -File scripts\probe-tray-registration.ps1 -DryRun      # read-only, launches nothing
#
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless it has a BOM, and a
# stray multi-byte sequence can break parsing. Chinese explanation lives in the report.

[CmdletBinding()]
param(
  [string]$Exe,
  [string[]]$Arguments = @(),
  [int]$WaitSeconds = 20,
  [switch]$StopProbe,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$notifyKey = 'HKCU:\Control Panel\NotifyIconSettings'

function Get-NotifyIconSnapshot {
  $snap = @{}
  if (-not (Test-Path $notifyKey)) { return $snap }
  foreach ($sub in Get-ChildItem $notifyKey) {
    $p = Get-ItemProperty $sub.PSPath -ErrorAction SilentlyContinue
    $snap[$sub.PSChildName] = [pscustomobject]@{
      Exe  = [string]$p.ExecutablePath
      Tip  = [string]$p.InitialTooltip
      Path = $sub.PSPath
    }
  }
  return $snap
}

function Show-NotifyIconDiff($before, $after) {
  $new = @($after.Keys | Where-Object { -not $before.ContainsKey($_) })
  Write-Output ("notify-area entries: before=" + $before.Count + " after=" + $after.Count)
  if ($new.Count -eq 0) {
    Write-Output 'NEW ENTRIES: none'
    return $new
  }
  Write-Output 'NEW ENTRIES:'
  foreach ($k in $new) {
    Write-Output ("  " + $after[$k].Exe + "   tip='" + $after[$k].Tip + "'   key=" + $k)
  }
  return $new
}

# ---------------------------------------------------------------------------
# Window / tray-icon probing (P/Invoke, read-only)
# ---------------------------------------------------------------------------
if (-not ('TrayProbe.Api' -as [type])) {
  Add-Type -Namespace TrayProbe -Name Api -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
[StructLayout(LayoutKind.Explicit, Size=40)]
public struct NID {
  [FieldOffset(0)]  public int cbSize;
  [FieldOffset(8)]  public IntPtr hWnd;
  [FieldOffset(16)] public uint uID;
  [FieldOffset(20)] public Guid guidItem;
}
[DllImport("shell32.dll")] public static extern int Shell_NotifyIconGetRect(ref NID id, out RECT rect);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@
}

function Get-WindowsForPids([uint32[]]$Pids) {
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
  foreach ($p in $Pids) { [void]$set.Add([uint32]$p) }
  $rows = New-Object System.Collections.ArrayList
  $cb = [TrayProbe.Api+EnumProc]{
    param([IntPtr]$h, [IntPtr]$l)
    $wpid = [uint32]0
    [void][TrayProbe.Api]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($set.Contains($wpid)) {
      $sb = New-Object System.Text.StringBuilder 256
      [void][TrayProbe.Api]::GetClassName($h, $sb, 256)
      [void]$rows.Add([pscustomobject]@{ Hwnd = $h; Pid = $wpid; Class = $sb.ToString(); Visible = [TrayProbe.Api]::IsWindowVisible($h) })
    }
    return $true
  }
  [void][TrayProbe.Api]::EnumWindows($cb, [IntPtr]::Zero)
  return $rows
}

function Get-TrayHostRects($windows) {
  $hits = New-Object System.Collections.ArrayList
  foreach ($w in ($windows | Where-Object { $_.Class -like '*NotifyIconHostWindow' })) {
    for ($uid = 0; $uid -le 8; $uid++) {
      $id = New-Object TrayProbe.Api+NID
      $id.cbSize = 40
      $id.hWnd = $w.Hwnd
      $id.uID = [uint32]$uid
      $id.guidItem = [Guid]::Empty
      $rect = New-Object TrayProbe.Api+RECT
      $hr = [TrayProbe.Api]::Shell_NotifyIconGetRect([ref]$id, [ref]$rect)
      if ($hr -eq 0) {
        [void]$hits.Add([pscustomobject]@{ Pid = $w.Pid; Uid = $uid; Rect = "$($rect.left),$($rect.top)-$($rect.right),$($rect.bottom)" })
      }
    }
  }
  return $hits
}

function Get-DescendantPids([int]$Root) {
  $pids = @($Root)
  $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($row in $all) {
      if (($pids -contains [int]$row.ParentProcessId) -and -not ($pids -contains [int]$row.ProcessId)) {
        $pids += [int]$row.ProcessId
        $changed = $true
      }
    }
  }
  return $pids
}

# ---------------------------------------------------------------------------
# Pick what to launch
# ---------------------------------------------------------------------------
if (-not $Exe) {
  $portable = Join-Path $root 'release\pi\pi.exe'
  if (Test-Path $portable) {
    $Exe = $portable
    $Arguments = @()
  } else {
    $Exe = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $Arguments = @((Join-Path $root 'scripts\pi-silent.vbs'))
  }
}
Write-Output "target: $Exe $($Arguments -join ' ')"
Write-Output ("windows build: " + (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').DisplayVersion + " / " + (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuild)

$before = Get-NotifyIconSnapshot
if ($DryRun) {
  Write-Output 'DRY RUN: snapshot only, nothing launched.'
  Write-Output ("entries now: " + $before.Count)
  $matching = @($before.Values | Where-Object { $_.Exe -match 'electron\.exe|\\pi\.exe' })
  if ($matching.Count -gt 0) {
    Write-Output 'existing entries for electron.exe / pi.exe:'
    foreach ($m in $matching) { Write-Output ("  " + $m.Exe + "  tip='" + $m.Tip + "'") }
  } else {
    Write-Output 'no existing tray entry for electron.exe / pi.exe (icon never accepted by the shell so far)'
  }
  exit 0
}

$proc = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru -WorkingDirectory $root
Write-Output ("started pid=" + $proc.Id + ", waiting " + $WaitSeconds + "s ...")
Start-Sleep -Seconds $WaitSeconds

$pids = @(Get-DescendantPids -Root $proc.Id)
Write-Output ("process tree pids: " + ($pids -join ', '))

$windows = @(Get-WindowsForPids -Pids $pids)
$hosts = @($windows | Where-Object { $_.Class -like '*NotifyIconHostWindow' })
Write-Output ("tray host windows (Electron_NotifyIconHostWindow): " + $hosts.Count)
foreach ($h in $hosts) { Write-Output ("  hwnd=0x{0:X} pid={1}" -f [int64]$h.Hwnd, $h.Pid) }
if ($hosts.Count -eq 0) {
  Write-Output '  -> the app did NOT create a Tray object (or it crashed before doing so)'
}

$rects = @(Get-TrayHostRects -windows $windows)
if ($rects.Count -eq 0) {
  Write-Output 'Shell_NotifyIconGetRect: no rect (note: icons that sit in the overflow drawer can also return nothing here)'
} else {
  foreach ($r in $rects) { Write-Output ("Shell_NotifyIconGetRect: pid=" + $r.Pid + " uID=" + $r.Uid + " rect=" + $r.Rect) }
}

$after = Get-NotifyIconSnapshot
$new = Show-NotifyIconDiff $before $after

Write-Output ''
Write-Output '=== VERDICT ==='
if ($new.Count -gt 0) {
  Write-Output 'REGISTERED: Explorer accepted at least one new notification-area icon for this launch.'
  Write-Output 'If you still cannot see it next to the clock, it is in the overflow drawer:'
  Write-Output '  click the "^" chevron on the taskbar, then drag the PI icon onto the taskbar.'
  Write-Output 'You can also manage it in Settings > Personalization > Taskbar > Other system tray icons.'
} else {
  Write-Output 'NOT REGISTERED: Explorer did not record any new notification-area icon for this launch.'
  Write-Output 'Most likely causes, in order:'
  Write-Output '  1) the process was started from a restricted/sandboxed shell (Shell_NotifyIcon -> ERROR_ACCESS_DENIED).'
  Write-Output '     Launch PI by double-clicking the desktop shortcut from your own session and run this probe again.'
  Write-Output '  2) the Tray object was never created (see the tray host windows line above).'
  Write-Output '  3) the Windows shell is in a bad state (a known Windows 11 symptom); signing out/in usually clears it.'
}

if ($StopProbe) {
  Write-Output ("stopping only the process tree we started (root pid " + $proc.Id + ") ...")
  Start-Process -FilePath 'taskkill.exe' -ArgumentList ('/T','/PID',[string]$proc.Id,'/F') -Wait -NoNewWindow
} else {
  Write-Output 'the app is left running on purpose (-StopProbe stops only the tree started here).'
}
