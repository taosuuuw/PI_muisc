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
rem  folder tree that way.  Putting the level back to Medium is a no-op when it
rem  is already Medium, so this runs on every start on purpose.
if not exist "node_modules\electron\dist\electron.exe" goto :pi_preflight_done
icacls "node_modules\electron" /setintegritylevel "(OI)(CI)Medium" >nul 2>&1
icacls "node_modules\electron\dist" /setintegritylevel Medium /T /C /Q >nul 2>&1
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
