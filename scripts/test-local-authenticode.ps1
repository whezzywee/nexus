$ErrorActionPreference = "Stop"

$nexusWorkspace = Split-Path -Parent $PSScriptRoot
$nexusSignTool = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
$nexusInstaller = Get-ChildItem (Join-Path $nexusWorkspace ".artifacts\release") `
  -Filter "Nexus_*_x64-setup.exe" -File -Recurse |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not (Test-Path -LiteralPath $nexusSignTool)) {
  throw "SignTool was not found at $nexusSignTool."
}
if (-not $nexusInstaller) {
  throw "Build a Nexus Windows installer before running Authenticode acceptance."
}

$nexusAcceptanceRoot = Join-Path $nexusWorkspace ".artifacts\signing-acceptance"
$nexusRunDirectory = Join-Path $nexusAcceptanceRoot (Get-Date -Format "yyyyMMdd-HHmmss")
$nexusSignedInstaller = Join-Path $nexusRunDirectory $nexusInstaller.Name
$nexusCertificatePath = Join-Path $nexusRunDirectory "nexus-local-acceptance.cer"
$nexusEvidencePath = Join-Path $nexusRunDirectory "verification.json"
$nexusTamperedInstaller = Join-Path $nexusRunDirectory "tampered-$($nexusInstaller.Name)"
$nexusCertificate = $null

New-Item -ItemType Directory -Force -Path $nexusRunDirectory | Out-Null
Copy-Item -LiteralPath $nexusInstaller.FullName -Destination $nexusSignedInstaller

try {
  $nexusCertificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=Nexus Local Authenticode Acceptance" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable `
    -NotAfter (Get-Date).AddDays(1)

  Export-Certificate -Cert $nexusCertificate -FilePath $nexusCertificatePath | Out-Null

  & $nexusSignTool sign `
    /fd SHA256 `
    /sha1 $nexusCertificate.Thumbprint `
    /s My `
    $nexusSignedInstaller
  if ($LASTEXITCODE -ne 0) {
    throw "Local Authenticode signing failed."
  }

  $nexusSignature = Get-AuthenticodeSignature -LiteralPath $nexusSignedInstaller
  if (
    $nexusSignature.SignatureType -ne "Authenticode" -or
    $nexusSignature.SignerCertificate.Thumbprint -ne $nexusCertificate.Thumbprint -or
    $nexusSignature.Status -notin @("UnknownError", "NotTrusted")
  ) {
    throw "The signed artifact did not expose the expected untrusted local Authenticode signature."
  }

  Copy-Item -LiteralPath $nexusSignedInstaller -Destination $nexusTamperedInstaller
  $nexusTamperedBytes = [System.IO.File]::ReadAllBytes($nexusTamperedInstaller)
  $nexusTamperedBytes[128] = $nexusTamperedBytes[128] -bxor 0x01
  [System.IO.File]::WriteAllBytes($nexusTamperedInstaller, $nexusTamperedBytes)
  $nexusTamperedSignature = Get-AuthenticodeSignature -LiteralPath $nexusTamperedInstaller
  if ($nexusTamperedSignature.Status -ne "HashMismatch") {
    throw "Authenticode did not reject the deliberately modified installer."
  }

  [ordered]@{
    schemaVersion = 1
    acceptanceOnly = $true
    publicTrustClaim = $false
    installer = $nexusSignedInstaller
    installerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $nexusSignedInstaller).Hash.ToLowerInvariant()
    signerSubject = $nexusSignature.SignerCertificate.Subject
    signerThumbprint = $nexusSignature.SignerCertificate.Thumbprint
    timestampSubject = $null
    status = "CryptographicallySignedUntrustedLocalRoot"
    tamperStatus = $nexusTamperedSignature.Status.ToString()
    verifiedAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $nexusEvidencePath -Encoding utf8

  Write-Host "Local Authenticode cryptographic acceptance passed; public trust is not claimed."
  Write-Host "Evidence: $nexusEvidencePath"
} finally {
  if ($nexusCertificate) {
    foreach ($nexusStorePath in @(
      "Cert:\CurrentUser\My\$($nexusCertificate.Thumbprint)"
    )) {
      if (Test-Path -LiteralPath $nexusStorePath) {
        Remove-Item -LiteralPath $nexusStorePath -Force
      }
    }
  }
}
