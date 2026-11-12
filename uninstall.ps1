param(
  [string]$Dest = (Join-Path $env:LOCALAPPDATA 'BridgeDeck'),
  [switch]$RemoveFromPath
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Dest)) {
  Write-Host "not installed: $Dest"
  return
}
if ($RemoveFromPath) {
  $Bin = Join-Path $Dest 'bin'
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($UserPath) {
    $Parts = @($UserPath -split ';' | Where-Object { $_ -and $_ -ne $Bin })
    [Environment]::SetEnvironmentVariable('Path', ($Parts -join ';'), 'User')
    Write-Host "Removed from user PATH: $Bin"
  }
}
Remove-Item -LiteralPath $Dest -Recurse -Force
Write-Host "Removed: $Dest"
