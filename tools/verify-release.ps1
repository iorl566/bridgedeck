param(
  [string]$Dist = (Join-Path $PSScriptRoot '..\dist')
)

$ErrorActionPreference = 'Stop'
$ManifestPath = Join-Path $Dist 'release.json'
if (-not (Test-Path -LiteralPath $ManifestPath)) { throw "release.json not found: $ManifestPath" }
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$Problems = @()
foreach ($Artifact in @($Manifest.artifacts)) {
  $Path = Join-Path $Dist $Artifact.name
  if (-not (Test-Path -LiteralPath $Path)) { $Problems += "missing $($Artifact.name)"; continue }
  $Hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Hash -ne $Artifact.sha256) { $Problems += "sha256 mismatch $($Artifact.name)" }
  if ($Artifact.name -like '*.exe') {
    $Signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($Signature.Status -ne 'Valid') { $Problems += "signature $($Signature.Status) $($Artifact.name)" }
  }
}
$Checksums = Join-Path $Dist 'SHA256SUMS'
if (-not (Test-Path -LiteralPath $Checksums)) { $Problems += 'missing SHA256SUMS' }
$Setup = Get-ChildItem -LiteralPath $Dist -Filter 'BridgeDeckSetup-*.exe' -ErrorAction SilentlyContinue
foreach ($File in @($Setup)) {
  $Sig = Get-AuthenticodeSignature -LiteralPath $File.FullName
  if ($Sig.Status -eq 'NotSigned') { $Problems += "unsigned setup $($File.Name)"; continue }
  if ($Sig.Status -eq 'UnknownError') { Write-Warning "self-signed/untrusted chain: $($File.Name) [$($Sig.SignerCertificate.Subject)]" }
  else { Write-Host "setup signature: $($File.Name) $($Sig.Status)" }
}
if ($Problems.Count) {
  $Problems | ForEach-Object { Write-Error $_ }
  exit 1
}
Write-Host "verify ok: $($Manifest.version) / $(@($Manifest.artifacts).Count) artifacts"
