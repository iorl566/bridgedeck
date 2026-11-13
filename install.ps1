param(
  [string]$Dest = (Join-Path $env:LOCALAPPDATA 'BridgeDeck'),
  [string]$NodePath = '',
  [switch]$AddToPath,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Dirs = @('bin', 'cli', 'daemon', 'lib', 'mcp', 'skill', 'extension', 'sdk')

if (-not (Test-Path (Join-Path $Root 'cli\bridge.mjs'))) {
  throw "install.ps1 must run from the BridgeDeck repository root"
}
$PreservedNode = $null
if (Test-Path $Dest) {
  if (-not $Force) { throw "destination exists: $Dest (use -Force to replace)" }
  $InstalledNode = Join-Path $Dest 'bin\node.exe'
  if (Test-Path $InstalledNode) {
    $PreservedNode = Join-Path $env:TEMP ('bb-node-' + [guid]::NewGuid().ToString('N') + '.exe')
    Copy-Item -LiteralPath $InstalledNode -Destination $PreservedNode -Force
  }
  Remove-Item -LiteralPath $Dest -Recurse -Force
}
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
foreach ($Dir in $Dirs) {
  $From = Join-Path $Root $Dir
  if (Test-Path $From) {
    Copy-Item -LiteralPath $From -Destination (Join-Path $Dest $Dir) -Recurse -Force
  }
}
if ($PreservedNode) {
  New-Item -ItemType Directory -Path (Join-Path $Dest 'bin') -Force | Out-Null
  Copy-Item -LiteralPath $PreservedNode -Destination (Join-Path $Dest 'bin\node.exe') -Force
  Remove-Item -LiteralPath $PreservedNode -Force -ErrorAction SilentlyContinue
}
Copy-Item -LiteralPath (Join-Path $Root 'package.json') -Destination (Join-Path $Dest 'package.json') -Force
if (Test-Path (Join-Path $Root 'tools\install-update.mjs')) {
  New-Item -ItemType Directory -Path (Join-Path $Dest 'tools') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root 'tools\install-update.mjs') -Destination (Join-Path $Dest 'tools\install-update.mjs') -Force
}
if (Test-Path (Join-Path $Root 'tools\make-cert.ps1')) {
  New-Item -ItemType Directory -Path (Join-Path $Dest 'tools') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root 'tools\make-cert.ps1') -Destination (Join-Path $Dest 'tools\make-cert.ps1') -Force
}

$Cmd = @'
@echo off
setlocal EnableExtensions
set "OLDCP="
for /f "tokens=2 delims=:" %%A in ('chcp') do set "OLDCP=%%A"
set "OLDCP=%OLDCP: =%"
if defined OLDCP if not "%OLDCP%"=="65001" chcp 65001 >nul
set "NODE_BIN=__NODE__"
if /I "%NODE_BIN%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
  )
)
if not exist "%NODE_BIN%" if /I not "%NODE_BIN%"=="node" (
  echo [bridge] node not found: %NODE_BIN%
  if defined OLDCP if not "%OLDCP%"=="65001" chcp %OLDCP% >nul
  exit /b 1
)
if /I "%NODE_BIN%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [bridge] Node.js 20+ is required: https://nodejs.org/
    if defined OLDCP if not "%OLDCP%"=="65001" chcp %OLDCP% >nul
    exit /b 1
  )
)
"%NODE_BIN%" "%~dp0..\cli\bridge.mjs" %*
set "RC=%ERRORLEVEL%"
if defined OLDCP if not "%OLDCP%"=="65001" chcp %OLDCP% >nul
exit /b %RC%
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
