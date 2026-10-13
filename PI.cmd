@echo off
rem  Switch the console to UTF-8 so the app's Chinese log lines are readable.
rem  This is only safe because this file is pure ASCII (byte offsets == character
rem  offsets), so changing the codepage cannot desync cmd's parser. Do NOT put
rem  Chinese text in this file and then "fix" it with chcp: that desyncs the parser.
chcp 65001 >nul
rem ---------------------------------------------------------------------------
rem  PI launcher (double-click to start the app)
rem
rem  KEEP THIS FILE PURE ASCII.  cmd.exe parses batch files in the OEM codepage,
rem  so UTF-8 Chinese here gets executed as garbage commands; adding `chcp 65001`
rem  inside the file is worse -- it changes the codepage while cmd is still
rem  parsing, and the parser loses its byte offset (random line fragments get
rem  run as commands).  Chinese product text belongs in the app, not in here.
rem
rem  Usage:
rem    double-click        -> build if artifacts are missing, then start PI
rem    PI_ALWAYS_BUILD=1   -> always rebuild first
rem    desktop shortcut    -> runs scripts\pi-silent.vbs (same thing, no console)
rem ---------------------------------------------------------------------------
cd /d "%~dp0"
setlocal EnableDelayedExpansion

set "NEED_BUILD="
if not exist "apps\desktop\out\main.mjs" set "NEED_BUILD=1"
if not exist "apps\desktop\out\preload.cjs" set "NEED_BUILD=1"
if not exist "apps\renderer\dist\index.html" set "NEED_BUILD=1"
if "%PI_ALWAYS_BUILD%"=="1" set "NEED_BUILD=1"

if defined NEED_BUILD (
  echo [PI] First run or missing build output - building now, about 10 seconds...
  call pnpm build
  if errorlevel 1 (
    echo.
    echo [PI] Build failed. In the project folder run: pnpm install ^&^& pnpm build
    if not "%PI_SILENT%"=="1" pause
    exit /b 1
  )
)

rem --- Chromium sandbox preflight -------------------------------------------
rem  Chromium refuses to initialise its sandbox when electron.exe carries a
rem  "low integrity" label, and the process then dies instantly with status
rem  0x80000003 (2147483651) printing nothing at all -- not even from the
rem  desktop shortcut.  Some sandboxing tools and security suites label a whole
rem  folder tree that way.
rem
rem  What label to write:
rem    * default = Medium.  A Medium launcher must not label the runtime above
rem      itself: a child any higher than its parent cannot be created.
rem    * if THIS launcher is already running at High or System (checked with
rem      whoami /groups), keep High instead of lowering electron.exe to Medium.
rem      Reason (measured on this machine): when the electron files carry a
rem      lower integrity label than the caller, the system refuses the tray
rem      icon registration and the app logs "Unable to create status tray
rem      icon" (electron ...\win\notify_icon.cc).  With the whole chain at High
rem      the same build registered the icon fine.  Lowering the label here was
rem      an active downgrade for such callers, and this preflight must never
rem      fight the caller's level.
rem
rem  Scope is deliberately unchanged: only node_modules\electron plus its dist.
rem  This is a label choice for this project's own runtime -- it is NOT an
rem  elevation path.  Nothing here calls runas, raises a UAC prompt, or changes
rem  any machine-wide policy.  Every value used below is a local variable and
rem  dies with the setlocal above.
if not exist "node_modules\electron\dist\electron.exe" goto :pi_preflight_done
set "PI_CALLER_IL=Medium"
call :pi_probe_caller_integrity
icacls "node_modules\electron" /setintegritylevel "(OI)(CI)!PI_CALLER_IL!" >nul 2>&1
icacls "node_modules\electron\dist" /setintegritylevel !PI_CALLER_IL! /T /C /Q >nul 2>&1
set "PI_CALLER_IL="
:pi_preflight_done

echo [PI] Starting... closing this window quits the app
call pnpm --filter @pi/desktop run start
if errorlevel 1 (
  echo.
  echo [PI] Failed to start - see the output above.
  echo [PI] If Electron is missing, run: pnpm electron:install
  if not "%PI_SILENT%"=="1" pause
  exit /b 1
)
exit /b 0

rem ---------------------------------------------------------------------------
rem  Is THIS launcher already at High (S-1-16-12288) or System (S-1-16-16384)?
rem  Kept in a subroutine on purpose: `cmd` parses parenthesised blocks up front,
rem  so a pipeline inside the build block above is exactly the kind of thing that
rem  goes wrong in a .cmd file.  Only the SID strings are matched, so this cannot
rem  misfire because of a different Windows display language.  Any failure in
rem  whoami / findstr leaves the caller at the safe default (Medium).
rem ---------------------------------------------------------------------------
:pi_probe_caller_integrity
set "PI_CALLER_IL=Medium"
whoami /groups | findstr /c:"S-1-16-12288" >nul 2>&1
if not errorlevel 1 set "PI_CALLER_IL=High"
whoami /groups | findstr /c:"S-1-16-16384" >nul 2>&1
if not errorlevel 1 set "PI_CALLER_IL=High"
exit /b 0
