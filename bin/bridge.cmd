@echo off
rem BridgeDeck CLI entry (Windows). Prefers a bundled runtime, then PATH, then an installed copy.
setlocal EnableExtensions
set "OLDCP="
for /f "tokens=2 delims=:" %%A in ('chcp') do set "OLDCP=%%A"
set "OLDCP=%OLDCP: =%"
if defined OLDCP if not "%OLDCP%"=="65001" chcp 65001 >nul

set "NODE_BIN=%~dp0node.exe"
if exist "%NODE_BIN%" goto run
where node >nul 2>nul
if not errorlevel 1 (
  set "NODE_BIN=node"
  goto run
)
if exist "%LOCALAPPDATA%\BridgeDeck\bin\node.exe" (
  set "NODE_BIN=%LOCALAPPDATA%\BridgeDeck\bin\node.exe"
  goto run
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
  goto run
)
echo [bridge] Node.js 20+ is required: https://nodejs.org/ 1>&2
if defined OLDCP if not "%OLDCP%"=="65001" chcp %OLDCP% >nul
exit /b 1

:run
"%NODE_BIN%" "%~dp0..\cli\bridge.mjs" %*
set "RC=%ERRORLEVEL%"
if defined OLDCP if not "%OLDCP%"=="65001" chcp %OLDCP% >nul
exit /b %RC%
