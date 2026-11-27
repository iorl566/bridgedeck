# tools/publish-edge.ps1 — 从本机受限凭证目录读取 Edge 凭据并提交商店。
# 使用：powershell -NoProfile -File tools\publish-edge.ps1 [-DraftOnly] [-Package <zip>]
param(
  [switch]$DraftOnly,
  [string]$Package = ""
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$secretDir = 'D:\BridgeDeck-secrets'
function Read-Secret([string]$name) {
  $path = Join-Path $secretDir $name
  if (-not (Test-Path $path)) { throw "缺少凭证文件：$path" }
  return (Get-Content $path -Raw).Trim()
}
if (-not $Package) {
  $version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
  $Package = Join-Path $root "dist\BridgeDeck-extension-$version.zip"
}
if (-not (Test-Path $Package)) { throw "扩展包不存在：$Package" }
$env:EDGE_API_KEY = Read-Secret 'edge-api-key.txt'
$env:EDGE_CLIENT_ID = Read-Secret 'edge-client-id.txt'
$env:EDGE_PRODUCT_ID = Read-Secret 'edge-product-id.txt'
$cliArgs = @('tools/edge-publish.mjs', '--package', $Package, '--notes-file', 'docs/assets/store/release-notes-0.3.1.md')
if ($DraftOnly) { $cliArgs += '--draft-only' }
Push-Location $root
try {
  & node @cliArgs
} finally {
  Pop-Location
  Remove-Item Env:EDGE_API_KEY, Env:EDGE_CLIENT_ID, Env:EDGE_PRODUCT_ID -ErrorAction SilentlyContinue
}
