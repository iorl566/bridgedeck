$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Dest = if ($env:BB_SETUP_DEST) { $env:BB_SETUP_DEST } else { Join-Path $env:LOCALAPPDATA 'BridgeDeck' }
$Payload = Join-Path $Here 'payload.zip'
if (-not (Test-Path -LiteralPath $Payload)) { throw "payload.zip not found next to installer script" }
$Temp = Join-Path $env:TEMP ('bb-setup-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Temp -Force | Out-Null
try {
  Expand-Archive -LiteralPath $Payload -DestinationPath $Temp -Force
  $Args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Temp 'install.ps1'), '-Dest', $Dest, '-Force')
  if ($env:BB_SETUP_NODE) { $Args += @('-NodePath', $env:BB_SETUP_NODE) }
  & powershell @Args
  if ($LASTEXITCODE -ne 0) { throw "install.ps1 failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
