@echo off
rem BridgeDeck CLI entry (Windows). Prefers the bundled runtime next to this file.
setlocal
set "NODE_BIN=%~dp0node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"
if /I not "%NODE_BIN%"=="node" goto run
where node >nul 2>nul
if errorlevel 1 (
  echo [bridge] Node.js 20+ is required: https://nodejs.org/ 1>&2
  exit /b 1
)
:run
"%NODE_BIN%" "%~dp0..\cli\bridge.mjs" %*
exit /b %ERRORLEVEL%
