param(
  [string]$Subject = 'CN=BridgeDeck Self-Signed',
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist\signing'),
  [string]$Password = 'BridgeDeck-SelfSigned-2026!'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$Secure = ConvertTo-SecureString $Password -AsPlainText -Force
$Cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject -KeyUsage DigitalSignature `
  -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddYears(3) -FriendlyName 'BridgeDeck Self-Signed'
$Pfx = Join-Path $OutDir 'BridgeDeck-selfsigned.pfx'
$Cer = Join-Path $OutDir 'BridgeDeck-selfsigned.cer'
Export-PfxCertificate -Cert $Cert -FilePath $Pfx -Password $Secure | Out-Null
Export-Certificate -Cert $Cert -FilePath $Cer -Type CERT | Out-Null
Write-Host "thumbprint: $($Cert.Thumbprint)"
Write-Host "pfx:       $Pfx"
Write-Host "cer:       $Cer"
Write-Host "password:  $Password"
