param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactPath
)

$ErrorActionPreference = "Stop"

if (-not $env:NEXUS_CODESIGN_KEY_PATH -and -not $env:NEXUS_CODESIGN_PASSWORD) {
  Write-Host "Production Authenticode credentials are absent; leaving $ArtifactPath unsigned."
  exit 0
}
if (-not $env:NEXUS_CODESIGN_KEY_PATH -or -not $env:NEXUS_CODESIGN_PASSWORD) {
  throw "Both NEXUS_CODESIGN_KEY_PATH and NEXUS_CODESIGN_PASSWORD are required."
}

$nexusArtifact = Get-Item -LiteralPath $ArtifactPath -ErrorAction Stop
$nexusCertificate = Get-Item -LiteralPath $env:NEXUS_CODESIGN_KEY_PATH -ErrorAction Stop
$nexusSignTool = Get-Command signtool.exe -ErrorAction Stop
$nexusTimestampUrl = if ($env:NEXUS_CODESIGN_TIMESTAMP_URL) {
  $env:NEXUS_CODESIGN_TIMESTAMP_URL
} else {
  "http://timestamp.digicert.com"
}

if ($nexusTimestampUrl -notmatch "^https?://") {
  throw "NEXUS_CODESIGN_TIMESTAMP_URL must be an HTTP(S) RFC 3161 endpoint."
}

& $nexusSignTool.Source sign `
  /fd SHA256 `
  /td SHA256 `
  /tr $nexusTimestampUrl `
  /f $nexusCertificate.FullName `
  /p $env:NEXUS_CODESIGN_PASSWORD `
  $nexusArtifact.FullName
if ($LASTEXITCODE -ne 0) {
  throw "Authenticode signing failed for $($nexusArtifact.FullName)."
}

& $nexusSignTool.Source verify /pa /all /tw $nexusArtifact.FullName
if ($LASTEXITCODE -ne 0) {
  throw "Authenticode verification failed for $($nexusArtifact.FullName)."
}
