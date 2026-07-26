$ErrorActionPreference = "Stop"

$nexusWorkspace = Split-Path -Parent $PSScriptRoot
$nexusDefaultCore = Join-Path $nexusWorkspace ".research\freenet-install\bin\freenet.exe"
$nexusContractWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_message_segment_contract.wasm"
$nexusCommunityContractWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_community_membership_contract.wasm"
$nexusPrivateConversationContractWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_private_conversation_contract.wasm"
$nexusAttachmentChunkContractWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_attachment_chunk_contract.wasm"
$nexusAttachmentIndexContractWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_attachment_index_contract.wasm"
$nexusVoiceContractWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_voice_session_contract.wasm"
$nexusReleaseContractWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_release_manifest_contract.wasm"
$nexusCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$nexusVcVars = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if (-not (Test-Path -LiteralPath $nexusCargo)) {
  $nexusCargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
  if (-not $nexusCargoCommand) {
    throw "Cargo was not found. Install Rust or add cargo.exe to PATH."
  }
  $nexusCargo = $nexusCargoCommand.Source
}

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

if (-not $env:NEXUS_FREENET_BIN) {
  if (Test-Path -LiteralPath $nexusDefaultCore) {
    $env:NEXUS_FREENET_BIN = $nexusDefaultCore
  } else {
    $nexusInstalledCore = Get-Command freenet.exe -ErrorAction SilentlyContinue
    if ($nexusInstalledCore) {
      $env:NEXUS_FREENET_BIN = $nexusInstalledCore.Source
    }
  }
}

if (-not $env:NEXUS_FREENET_BIN -or -not (Test-Path -LiteralPath $env:NEXUS_FREENET_BIN)) {
  throw "Set NEXUS_FREENET_BIN to a Freenet Core 0.2.107 executable."
}

function Invoke-NexusFreenetTest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TestName,
    [Parameter(Mandatory = $true)]
    [string]$FailureMessage
  )

  for ($nexusAttempt = 1; $nexusAttempt -le 3; $nexusAttempt++) {
    & $nexusCargo test -p nexus-freenet-two-node-tests --test $TestName -- --ignored --nocapture
    if ($LASTEXITCODE -eq 0) {
      # Each test owns a fresh pair of Core processes and loopback transports.
      # Give their completed teardown a bounded drain window before the next
      # pair is created; immediate churn can otherwise race recently closed
      # sockets and measure harness teardown rather than contract propagation.
      Start-Sleep -Seconds 2
      return
    }
    if ($nexusAttempt -lt 3) {
      Write-Warning "$TestName hit a transient two-node startup/propagation failure (attempt $nexusAttempt of 3); retrying."
      Start-Sleep -Seconds 2
    }
  }

  throw $FailureMessage
}

Push-Location $nexusWorkspace
try {
  & $nexusCargo build -p nexus-message-segment-contract --release --target wasm32-unknown-unknown
  if ($LASTEXITCODE -ne 0) {
    throw "The Nexus message-segment contract failed to build."
  }

  & $nexusCargo build -p nexus-community-membership-contract --release --target wasm32-unknown-unknown
  if ($LASTEXITCODE -ne 0) {
    throw "The Nexus community-membership contract failed to build."
  }

  & $nexusCargo build -p nexus-private-conversation-contract --release --target wasm32-unknown-unknown
  if ($LASTEXITCODE -ne 0) {
    throw "The Nexus private-conversation contract failed to build."
  }

  & $nexusCargo build -p nexus-attachment-chunk-contract -p nexus-attachment-index-contract --release --target wasm32-unknown-unknown
  if ($LASTEXITCODE -ne 0) {
    throw "The Nexus attachment contracts failed to build."
  }

  & $nexusCargo build -p nexus-voice-session-contract --release --target wasm32-unknown-unknown
  if ($LASTEXITCODE -ne 0) {
    throw "The Nexus voice-session contract failed to build."
  }

  & $nexusCargo build -p nexus-release-manifest-contract --release --target wasm32-unknown-unknown
  if ($LASTEXITCODE -ne 0) {
    throw "The Nexus release-manifest contract failed to build."
  }

  $env:NEXUS_CONTRACT_WASM = $nexusContractWasm
  Invoke-NexusFreenetTest `
    -TestName "message_roundtrip" `
    -FailureMessage "The Nexus two-node Freenet integration test failed."

  $env:NEXUS_COMMUNITY_CONTRACT_WASM = $nexusCommunityContractWasm
  Invoke-NexusFreenetTest `
    -TestName "community_roundtrip" `
    -FailureMessage "The Nexus two-node community integration test failed."

  $env:NEXUS_PRIVATE_CONVERSATION_CONTRACT_WASM = $nexusPrivateConversationContractWasm
  Invoke-NexusFreenetTest `
    -TestName "private_conversation_roundtrip" `
    -FailureMessage "The Nexus two-node private-conversation integration test failed."

  $env:NEXUS_ATTACHMENT_CHUNK_CONTRACT_WASM = $nexusAttachmentChunkContractWasm
  $env:NEXUS_ATTACHMENT_INDEX_CONTRACT_WASM = $nexusAttachmentIndexContractWasm
  Invoke-NexusFreenetTest `
    -TestName "attachment_roundtrip" `
    -FailureMessage "The Nexus two-node attachment integration test failed."

  $env:NEXUS_VOICE_CONTRACT_WASM = $nexusVoiceContractWasm
  Invoke-NexusFreenetTest `
    -TestName "voice_roundtrip" `
    -FailureMessage "The Nexus two-node voice-session integration test failed."

  $env:NEXUS_RELEASE_CONTRACT_WASM = $nexusReleaseContractWasm
  Invoke-NexusFreenetTest `
    -TestName "release_roundtrip" `
    -FailureMessage "The Nexus two-node release-manifest integration test failed."
} finally {
  Pop-Location
}
