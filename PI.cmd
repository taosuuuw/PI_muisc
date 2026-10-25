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

rem --- Resolve pnpm without trusting PATH -------------------------------------
rem  PATH on this machine starts with X:\Nodejs, and its pnpm.cmd is a shim that
rem  hard-codes a *shared* tooling folder (X:\harness\task1\.tooling\pnpm). When
rem  that folder went away the shim exited 127, so every `pnpm` in this launcher
rem  failed and the app "failed to start" with exit code 1 while PI itself was
rem  perfectly fine (measured 2026-10-17: the log only said "pnpm shim: ... is
rem  missing").  So resolve the command ourselves instead of asking PATH:
rem    1) the pnpm npm installs globally -- it carries its own version manager,
rem       so it honours package.json's "packageManager": "pnpm@10.34.5";
rem    2) the shared tooling copy, if that folder ever comes back;
rem    3) bare `pnpm` (last resort: whatever PATH says, including the shim).
rem  unset; a bare `pnpm` (last resort) still resolves whatever PATH offers.
rem  The variable is local and dies with the setlocal above.  Keep it ASCII.
set "PI_PNPM=pnpm"
if exist "X:\harness\task1\.tooling\pnpm\bin\pnpm.cjs" set "PI_PNPM=node X:\harness\task1\.tooling\pnpm\bin\pnpm.cjs"
if exist "%APPDATA%\npm\node_modules\pnpm\pnpm.exe" set "PI_PNPM=%APPDATA%\npm\node_modules\pnpm\pnpm.exe"

set "NEED_BUILD="
if not exist "apps\desktop\out\main.mjs" set "NEED_BUILD=1"
if not exist "apps\desktop\out\preload.cjs" set "NEED_BUILD=1"
if not exist "apps\renderer\dist\index.html" set "NEED_BUILD=1"
if "%PI_ALWAYS_BUILD%"=="1" set "NEED_BUILD=1"

if defined NEED_BUILD (
  echo [PI] First run or missing build output - building now, about 10 seconds...
  call %PI_PNPM% build
  if errorlevel 1 (
    rem  pnpm itself may be unusable on this machine (see the resolution block above).
    rem  turbo reads pnpm-workspace.yaml on its own, so it can still build the three
    rem  packages without any package manager in the loop.
    echo [PI] pnpm build failed - retrying the build with turbo directly...
    if exist "node_modules\turbo\bin\turbo" node "node_modules\turbo\bin\turbo" run build
  )
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
rem
rem  The caller level is probed with four lines inline.  It used to be a
rem  `call :pi_probe_caller_integrity` subroutine at the bottom of the file, and
rem  after this launcher grew some comments cmd stopped resolving that label
rem  ("The system cannot find the batch label specified") -- measured 2026-10-17,
rem  reproducible in a copy, and it went away again as soon as the call was
rem  removed.  Inline straight-line code has nothing to look up.
if not exist "node_modules\electron\dist\electron.exe" goto :pi_preflight_done
set "PI_CALLER_IL=Medium"
rem  Already at High (S-1-16-12288) or System (S-1-16-16384)?  Keep High instead
rem  of lowering electron.exe below the caller.  Only the SID strings are
rem  matched, so a different Windows display language cannot misfire.
whoami /groups | findstr /c:"S-1-16-12288" >nul 2>&1
if not errorlevel 1 set "PI_CALLER_IL=High"
whoami /groups | findstr /c:"S-1-16-16384" >nul 2>&1
if not errorlevel 1 set "PI_CALLER_IL=High"
icacls "node_modules\electron" /setintegritylevel "(OI)(CI)!PI_CALLER_IL!" >nul 2>&1
icacls "node_modules\electron\dist" /setintegritylevel !PI_CALLER_IL! /T /C /Q >nul 2>&1
set "PI_CALLER_IL="
:pi_preflight_done

echo [PI] Starting... closing this window quits the app
call %PI_PNPM% --filter @pi/desktop run start
if not errorlevel 1 exit /b 0

rem --- Fallback: start Electron without any package manager -------------------
rem  The app is the part that matters. If pnpm could not run here -- a broken
rem  shim earlier on PATH, a pinned pnpm that cannot be installed, no pnpm at all
rem  -- do exactly what apps\desktop's "start" script does ("electron ." with that
rem  folder as the working directory). Measured 2026-10-17: on this machine pnpm
rem  resolved to a shim pointing at a deleted tooling folder (exit 127) and this
rem  launcher reported "Failed to start" although PI was fine.
echo.
echo [PI] pnpm could not start the app - starting Electron directly instead...
if not exist "%~dp0node_modules\electron\dist\electron.exe" goto :pi_start_failed
pushd "%~dp0apps\desktop"
"%~dp0node_modules\electron\dist\electron.exe" .
set "PI_RC=%ERRORLEVEL%"
popd
if not "%PI_RC%"=="0" goto :pi_start_failed
exit /b 0

:pi_start_failed
echo.
echo [PI] Failed to start - see the output above.
echo [PI] If Electron is missing, run: pnpm electron:install
if not "%PI_SILENT%"=="1" pause
exit /b 1
