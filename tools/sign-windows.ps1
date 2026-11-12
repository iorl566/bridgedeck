param(
  [Parameter(Mandatory = $true)][string]$File,
  [Parameter(Mandatory = $true)][string]$Pfx,
  [string]$Password = '',
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [switch]$NoTimestamp
)

$ErrorActionPreference = 'Stop'
if ($NoTimestamp) { $TimestampUrl = '' }
if (-not (Test-Path -LiteralPath $File)) { throw "file not found: $File" }
if (-not (Test-Path -LiteralPath $Pfx)) { throw "pfx not found: $Pfx" }

$SignTool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $SignTool) {
  $Candidates = @(
    "$env:ProgramFiles(x86)\Windows Kits\10\bin\*\x64\signtool.exe",
    "$env:ProgramFiles\Windows Kits\10\bin\*\x64\signtool.exe"
  )
  foreach ($Pattern in $Candidates) {
    $Found = Get-ChildItem $Pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($Found) { $SignTool = $Found; break }
  }
}
if (-not $SignTool) {
  Write-Host "signtool.exe not found; falling back to Set-AuthenticodeSignature"
  $Secure = ConvertTo-SecureString $Password -AsPlainText -Force
  $Cert = Import-PfxCertificate -FilePath $Pfx -CertStoreLocation Cert:\CurrentUser\My -Password $Secure
  $Params = @{ FilePath = $File; Certificate = $Cert }
  if ($TimestampUrl) { $Params.TimestampServer = $TimestampUrl }
  $Result = Set-AuthenticodeSignature @Params
  $Result | Select-Object Status, StatusMessage, SignerCertificate | Format-List
  if ($Result.Status -eq 'NotSigned') { throw "signing failed: $($Result.StatusMessage)" }
  return
}

$Args = @('sign', '/fd', 'SHA256', '/f', $Pfx)
if ($Password) { $Args += @('/p', $Password) }
if ($TimestampUrl) { $Args += @('/tr', $TimestampUrl, '/td', 'SHA256') }
$Args += $File
& $SignTool.Source @Args
if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }
Get-AuthenticodeSignature -LiteralPath $File | Select-Object Status, StatusMessage, SignerCertificate | Format-List
