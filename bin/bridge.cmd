@echo off
rem BridgeDeck CLI entry. Prefers node on PATH; falls back to the DSH bundled node.
setlocal
set "NODE_BIN=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_BIN=C:\Users\CFT\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_BIN%" if /I not "%NODE_BIN%"=="node" (
  echo [bridge] node not found: %NODE_BIN% 1>&2
  exit /b 1
)
"%NODE_BIN%" "%~dp0..\cli\bridge.mjs" %*
exit /b %ERRORLEVEL%
