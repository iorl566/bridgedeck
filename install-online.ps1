# BridgeDeck 在线安装（一行安装）
# 用法：
#   irm https://raw.githubusercontent.com/iorl566/bridgedeck/main/install-online.ps1 | iex
# 可选参数（高级）：
#   $env:BRIDGEDECK_DEST = 'D:\Apps\BridgeDeck'    # 自定义安装目录
#   .\install-online.ps1 -Dest D:\Apps\BridgeDeck -AddToPath
param(
  [string]$Dest = (Join-Path $env:LOCALAPPDATA 'BridgeDeck'),
  [switch]$AddToPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'iorl566/bridgedeck'
$work = Join-Path $env:TEMP ('bridgedeck-online-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
  Write-Host '[bridge] 查询最新版本…'
  $release = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repo/releases/latest"
  $asset = $release.assets |
    Where-Object { $_.name -like 'BridgeDeck-cli-*-win32-x64.zip' } |
    Select-Object -First 1
  if (-not $asset) { $asset = $release.assets | Where-Object { $_.name -like 'BridgeDeck-cli-bundle-*.zip' } | Select-Object -First 1 }
  if (-not $asset) { throw 'latest release has no Windows CLI asset' }
  $zip = Join-Path $work 'bundle.zip'
  Write-Host "[bridge] 下载 $($asset.name)…"
  Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $zip
  Expand-Archive -LiteralPath $zip -DestinationPath $work -Force

  $installer = Join-Path $work 'install.ps1'
  if (-not (Test-Path $installer)) { throw 'install.ps1 missing in bundle' }

  Write-Host "[bridge] 安装到 $Dest …"
  $installArgs = @{ Dest = $Dest; Force = $true }
  if ($AddToPath) { $installArgs.AddToPath = $true }
  & $installer @installArgs

  $bridge = Join-Path $Dest 'bin\bridge.cmd'
  Write-Host '[bridge] 验证：'
  & $bridge status
  Write-Host ''
  Write-Host '完成。扩展请从商店安装，或在 edge://extensions 加载解压目录：'
  Write-Host '  https://microsoftedge.microsoft.com/addons/detail/ieflpefpmlmmlfgmpfakaglhgmcbcnig'
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
