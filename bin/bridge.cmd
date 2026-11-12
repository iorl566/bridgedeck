@echo off
rem BridgeDeck CLI 入口。优先用 PATH 上的 node，找不到就用 DSH 内置 node。
setlocal
set "NODE_BIN=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_BIN=C:\Users\CFT\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_BIN%" if "%NODE_BIN%" neq "node" (
  echo [bridge] 找不到 node：%NODE_BIN% 1>&2
  exit /b 1
)
"%NODE_BIN%" "%~dp0..\cli\bridge.mjs" %*
exit /b %ERRORLEVEL%
