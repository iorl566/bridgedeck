# backup-dsh-sessions.ps1 - back up DSH session storage (sessions + projection cache + workspace index)
#
# Why: on 2026-11-23 19:44 the whole ~/.dsh/sessions tree was deleted; DSH appends with
#      open(path,'a') and never recreates the directory, so the running session failed with
#      ENOENT. This script keeps an independent external copy.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\...\tools\backup-dsh-sessions.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\...\tools\backup-dsh-sessions.ps1 -DestRoot D:\dsh-backups -Keep 30
#
# Register every 2 hours for the current user (no admin required):
#   schtasks /Create /F /SC HOURLY /MO 2 /TN "DSH session backup" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File D:\...\tools\backup-dsh-sessions.ps1"
param(
  [string]$DestRoot = (Join-Path $env:USERPROFILE '.dsh-backups'),
  [int]$Keep = 14
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $DestRoot $stamp

New-Item -ItemType Directory -Force -Path $dest | Out-Null

$dshHome = Join-Path $env:USERPROFILE '.dsh'
$sources = @(
  @{ Path = (Join-Path $dshHome 'sessions');                  Name = 'sessions' },
  @{ Path = (Join-Path $dshHome 'storages\session_projcache'); Name = 'session_projcache' },
  @{ Path = (Join-Path $dshHome 'storages\workspace.json');    Name = 'workspace.json' }
)

foreach ($source in $sources) {
  if (-not (Test-Path -LiteralPath $source.Path)) { continue }
  Copy-Item -LiteralPath $source.Path -Destination (Join-Path $dest $source.Name) -Recurse -Force
}

$files = @(Get-ChildItem -LiteralPath $dest -Recurse -File -ErrorAction SilentlyContinue)
$total = 0
foreach ($file in $files) { $total += $file.Length }
Write-Output ("backup: {0}  files={1}  bytes={2}" -f $dest, $files.Count, $total)

# Rotation: keep the newest $Keep stamp-named directories; never touch DestRoot itself.
$existing = @(Get-ChildItem -LiteralPath $DestRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d{8}-\d{6}$' } |
  Sort-Object Name -Descending)
$existing | Select-Object -Skip $Keep | ForEach-Object {
  if ($_.FullName -ne $DestRoot) {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
  }
}
