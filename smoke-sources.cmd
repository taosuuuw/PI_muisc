@echo off
rem  KEEP THIS FILE PURE ASCII (see PI.cmd): cmd parses batch files in the OEM
rem  codepage, so UTF-8 Chinese here would be executed as garbage commands.
rem
rem  Runs the M2.5 source-chain smoke outside the current console job, because
rem  electron.exe exits with 0x80000003 when launched directly from the agent's
rem  pwsh job object. Launch this file via explorer.exe instead.
rem
rem  --no-sandbox: Chromium's own sandbox cannot create a nested job object inside
rem  the agent's job, and it aborts with STATUS_BREAKPOINT (0x80000003) before any
rem  of our code runs. This flag is for the automated smoke only; the shipped app
rem  keeps its sandbox.
cd /d "X:\harness\wy_music_newworld"
set PI_SMOKE_SOURCES=1
set LOG_LEVEL=error
"X:\harness\wy_music_newworld\node_modules\electron\dist\electron.exe" apps\desktop --no-sandbox > "X:\harness\wy_music_newworld\smoke-sources.log" 2>&1
echo exit=%ERRORLEVEL% >> "X:\harness\wy_music_newworld\smoke-sources.log"
