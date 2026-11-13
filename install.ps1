param(
  [string]$Dest = (Join-Path $env:LOCALAPPDATA 'BridgeDeck'),
  [string]$NodePath = '',
  [switch]$AddToPath,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Dirs = @('bin', 'cli', 'daemon', 'lib', 'mcp', 'skill', 'extension')

if (-not (Test-Path (Join-Path $Root 'cli\bridge.mjs'))) {
  throw "install.ps1 must run from the BridgeDeck repository root"
}
if (Test-Path $Dest) {
  if (-not $Force) { throw "destination exists: $Dest (use -Force to replace)" }
  Remove-Item -LiteralPath $Dest -Recurse -Force
}
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
foreach ($Dir in $Dirs) {
  $From = Join-Path $Root $Dir
  if (Test-Path $From) {
    Copy-Item -LiteralPath $From -Destination (Join-Path $Dest $Dir) -Recurse -Force
  }
}
Copy-Item -LiteralPath (Join-Path $Root 'package.json') -Destination (Join-Path $Dest 'package.json') -Force

$Cmd = @'
@echo off
setlocal
set "NODE_BIN=__NODE__"
if /I "%NODE_BIN%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
  )
)
if not exist "%NODE_BIN%" if /I not "%NODE_BIN%"=="node" (
  echo [bridge] node not found: %NODE_BIN%
  exit /b 1
)
if /I "%NODE_BIN%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [bridge] Node.js 18+ is required: https://nodejs.org/
    exit /b 1
  )
)
"%NODE_BIN%" "%~dp0..\cli\bridge.mjs" %*
exit /b %ERRORLEVEL%
'@
$Cmd = $Cmd.Replace('__NODE__', $(if ($NodePath) { $NodePath } elseif (Test-Path (Join-Path $Dest 'bin\node.exe')) { '%~dp0node.exe' } else { 'node' }))
New-Item -ItemType Directory -Path (Join-Path $Dest 'bin') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $Dest 'bin\bridge.cmd') -Value $Cmd -Encoding ASCII

$Bin = Join-Path $Dest 'bin'
Write-Host "BridgeDeck installed: $Dest"
Write-Host "Run: $Bin\bridge.cmd status"
if ($AddToPath) {
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $UserPath) { $UserPath = '' }
  $Parts = @($UserPath -split ';' | Where-Object { $_ })
  if ($Parts -notcontains $Bin) {
    $NewPath = (@($Parts) + $Bin) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    Write-Host "Added to user PATH (open a new terminal): $Bin"
  } else {
    Write-Host "Already on user PATH: $Bin"
  }
} else {
  Write-Host "Not added to PATH; use -AddToPath to add it."
}
