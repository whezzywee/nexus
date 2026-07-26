$ErrorActionPreference = "Stop"

$nexusWorkspace = Split-Path -Parent $PSScriptRoot
$nexusCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$nexusVcVars = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$nexusTimestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$nexusReleaseDir = Join-Path $nexusWorkspace ".artifacts\release\$nexusTimestamp"
$nexusSigningConfigured =
  -not [string]::IsNullOrWhiteSpace($env:NEXUS_CODESIGN_KEY_PATH) -and
  -not [string]::IsNullOrWhiteSpace($env:NEXUS_CODESIGN_PASSWORD)

if (-not (Test-Path -LiteralPath $nexusCargo)) {
  throw "Cargo was not found at $nexusCargo."
}
$nexusCargoDir = Split-Path -Parent $nexusCargo
$env:PATH = "$nexusCargoDir;$env:PATH"

if (Test-Path -LiteralPath $nexusVcVars) {
  $nexusVsEnvironment = & cmd.exe /d /s /c "`"$nexusVcVars`" >nul && set"
  foreach ($nexusEnvironmentLine in $nexusVsEnvironment) {
    $nexusSeparator = $nexusEnvironmentLine.IndexOf("=")
    if ($nexusSeparator -gt 0) {
      $nexusName = $nexusEnvironmentLine.Substring(0, $nexusSeparator)
      $nexusValue = $nexusEnvironmentLine.Substring($nexusSeparator + 1)
      [Environment]::SetEnvironmentVariable($nexusName, $nexusValue, "Process")
    }
  }
}

Push-Location $nexusWorkspace
try {
  pnpm lint
  if ($LASTEXITCODE -ne 0) { throw "Lint failed." }
  pnpm typecheck
  if ($LASTEXITCODE -ne 0) { throw "Typecheck failed." }
  pnpm test
  if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
  & $nexusCargo test --workspace --all-targets
  if ($LASTEXITCODE -ne 0) { throw "Rust tests failed." }
  & $nexusCargo clippy --workspace --all-targets -- -D warnings
  if ($LASTEXITCODE -ne 0) { throw "Clippy failed." }
  & $nexusCargo build `
    -p nexus-message-segment-contract `
    -p nexus-community-membership-contract `
    -p nexus-private-conversation-contract `
    -p nexus-attachment-index-contract `
    -p nexus-attachment-chunk-contract `
    -p nexus-voice-session-contract `
    -p nexus-release-manifest-contract `
    --release --target wasm32-unknown-unknown
  if ($LASTEXITCODE -ne 0) { throw "The Freenet contract build failed." }
  pnpm --filter @nexus/desktop tauri build --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw "The Windows installer build failed." }

  New-Item -ItemType Directory -Path $nexusReleaseDir -Force | Out-Null
  $nexusInstaller = Get-ChildItem -LiteralPath (Join-Path $nexusWorkspace "target\release\bundle\nsis") -Filter "*.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $nexusInstaller) {
    throw "Tauri completed without producing an NSIS installer."
  }
  Copy-Item -LiteralPath $nexusInstaller.FullName -Destination $nexusReleaseDir
  $nexusContractNames = @(
    "nexus_message_segment_contract.wasm",
    "nexus_community_membership_contract.wasm",
    "nexus_private_conversation_contract.wasm",
    "nexus_attachment_index_contract.wasm",
    "nexus_attachment_chunk_contract.wasm",
    "nexus_voice_session_contract.wasm",
    "nexus_release_manifest_contract.wasm"
  )
  foreach ($nexusContractName in $nexusContractNames) {
    $nexusContract = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\$nexusContractName"
    Copy-Item -LiteralPath $nexusContract -Destination $nexusReleaseDir
  }

  $nexusArtifacts = Get-ChildItem -LiteralPath $nexusReleaseDir -File | ForEach-Object {
    $nexusHash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
    [PSCustomObject]@{
      name = $_.Name
      bytes = $_.Length
      sha256 = $nexusHash.Hash.ToLowerInvariant()
    }
  }
  $nexusManifest = [PSCustomObject]@{
    schemaVersion = 1
    product = "Nexus"
    version = "0.1.0"
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    coreCompatibility = "0.2.107"
    signatureStatus = if ($nexusSigningConfigured) {
      "authenticode-production"
    } else {
      "unsigned-development"
    }
    artifacts = @($nexusArtifacts)
  }
  $nexusManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $nexusReleaseDir "release-manifest.json") -Encoding utf8
  $nexusArtifacts |
    ForEach-Object { "$($_.sha256)  $($_.name)" } |
    Set-Content -LiteralPath (Join-Path $nexusReleaseDir "SHA256SUMS.txt") -Encoding ascii

  Write-Host "Release package created at $nexusReleaseDir"
  if (-not $nexusSigningConfigured) {
    Write-Warning "This development package is checksummed but unsigned. Do not publish it as a trusted update."
  }
} finally {
  Pop-Location
}
