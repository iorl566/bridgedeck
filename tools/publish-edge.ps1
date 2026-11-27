# tools/publish-edge.ps1 — 从本机受限凭证目录读取 Edge 凭据并提交商店。
# 使用：powershell -NoProfile -File tools\publish-edge.ps1 [-DraftOnly] [-Package <zip>] [-NotesFile <md>]
# 说明：-DraftOnly 只上传包为 draft；不带该参数会上传后用 certification notes 提交审核。
param(
  [switch]$DraftOnly,
  [string]$Package = "",
  [string]$NotesFile = "docs/assets/store/certification-notes-0.3.1.md"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$secretDir = 'D:\BridgeDeck-secrets'

function Read-Secret([string]$name) {
  $path = Join-Path $secretDir $name
  if (-not (Test-Path $path)) { throw "缺少凭证文件：$path" }
  return (Get-Content $path -Raw).Trim()
}

function Resolve-Node {
  $candidates = @()
  if ($env:BRIDGEDECK_NODE) { $candidates += $env:BRIDGEDECK_NODE }
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  $candidates += 'D:\tools\node\node.exe', (Join-Path $env:ProgramFiles 'nodejs\node.exe')
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  throw '找不到 node.exe：安装 Node.js，或设置环境变量 BRIDGEDECK_NODE 指向 node.exe'
}

if (-not $Package) {
  $version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $Package = Join-Path $root "dist\BridgeDeck-extension-$version.zip"
}
if (-not (Test-Path $Package)) { throw "扩展包不存在：$Package" }
$notesPath = Join-Path $root $NotesFile
if (-not (Test-Path $notesPath)) { throw "认证备注不存在：$notesPath" }

$node = Resolve-Node
$env:EDGE_API_KEY = Read-Secret 'edge-api-key.txt'
$env:EDGE_CLIENT_ID = Read-Secret 'edge-client-id.txt'
$env:EDGE_PRODUCT_ID = Read-Secret 'edge-product-id.txt'
$cliArgs = @('tools/edge-publish.mjs', '--package', $Package, '--notes-file', $NotesFile)
if ($DraftOnly) { $cliArgs += '--draft-only' }
Push-Location $root
try {
  & $node @cliArgs
  $exit = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item Env:EDGE_API_KEY, Env:EDGE_CLIENT_ID, Env:EDGE_PRODUCT_ID -ErrorAction SilentlyContinue
}
exit $exit
