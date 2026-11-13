param(
  [Parameter(Mandatory = $true)][string]$File,
  [string]$Pfx = '',
  [string]$Password = '',
  [string]$Thumbprint = '',
  [string]$Subject = '',
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [string]$Description = 'BridgeDeck',
  [string]$Url = 'https://github.com/iorl566/bridgedeck',
  [switch]$NoTimestamp,
  [switch]$VerifyOnly,
  [switch]$RequireTimestamp
)

$ErrorActionPreference = 'Stop'
if ($NoTimestamp) { $TimestampUrl = '' }
if (-not (Test-Path -LiteralPath $File)) { throw "file not found: $File" }

function Get-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    "$env:ProgramFiles(x86)\Windows Kits\10\bin\*\x64\signtool.exe",
    "$env:ProgramFiles\Windows Kits\10\bin\*\x64\signtool.exe",
    "$env:ProgramFiles(x86)\Windows Kits\10\bin\*\arm64\signtool.exe"
  )
  foreach ($pattern in $candidates) {
    $found = Get-ChildItem $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  return $null
}

function Show-Signature {
  param([string]$Path)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $signature | Select-Object Status, StatusMessage, @{Name = 'Subject'; Expression = { $_.SignerCertificate.Subject } }, @{Name = 'Thumbprint'; Expression = { $_.SignerCertificate.Thumbprint } }, @{Name = 'Timestamp'; Expression = { $_.TimeStamperCertificate.NotBefore }} | Format-List
  if ($signature.Status -ne 'Valid') { throw "signature is not valid: $($signature.Status) $($signature.StatusMessage)" }
  if ($RequireTimestamp -and -not $signature.TimeStamperCertificate) { throw 'signature has no timestamp' }
  return $signature
}

if ($VerifyOnly) {
  Show-Signature -Path $File | Out-Null
  Write-Host "signature ok: $File"
  return
}

$hasPfx = -not [string]::IsNullOrWhiteSpace($Pfx)
$hasThumbprint = -not [string]::IsNullOrWhiteSpace($Thumbprint)
$hasSubject = -not [string]::IsNullOrWhiteSpace($Subject)
if (-not ($hasPfx -or $hasThumbprint -or $hasSubject)) {
  throw 'provide one of -Pfx, -Thumbprint or -Subject (or use -VerifyOnly)'
}

$signTool = Get-SignTool
if (-not $signTool) {
  Write-Host 'signtool.exe not found; falling back to Set-AuthenticodeSignature'
  $cert = $null
  if ($hasThumbprint) { $cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My | Where-Object Thumbprint -eq $Thumbprint | Select-Object -First 1 }
  elseif ($hasSubject) { $cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My | Where-Object { $_.Subject -like "*$Subject*" } | Select-Object -First 1 }
  if (-not $cert -and $hasPfx) {
    $secure = ConvertTo-SecureString $Password -AsPlainText -Force
    $cert = (Import-PfxCertificate -FilePath $Pfx -CertStoreLocation Cert:\CurrentUser\My -Password $secure)
  }
  if (-not $cert) { throw 'signing certificate not found' }
  $params = @{ FilePath = $File; Certificate = $cert }
  if ($TimestampUrl) { $params.TimestampServer = $TimestampUrl }
  $result = Set-AuthenticodeSignature @params
  if ($result.Status -eq 'NotSigned') { throw "signing failed: $($result.StatusMessage)" }
  Show-Signature -Path $File | Out-Null
  Write-Host "signed: $File"
  return
}

$arguments = @('sign', '/fd', 'SHA256', '/d', $Description)
if ($TimestampUrl) { $arguments += @('/tr', $TimestampUrl, '/td', 'SHA256') }
if ($hasPfx) {
  $arguments += @('/f', $Pfx)
  if ($Password) { $arguments += @('/p', $Password) }
} elseif ($hasThumbprint) {
  $arguments += @('/sha1', $Thumbprint)
} else {
  $arguments += @('/n', $Subject)
}
$arguments += $File
& $signTool @arguments
if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }
Show-Signature -Path $File | Out-Null
Write-Host "signed: $File"
