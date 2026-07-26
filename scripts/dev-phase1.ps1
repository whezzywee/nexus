param(
  [ValidateSet("tauri", "desktop", "web")]
  [string]$Client = "tauri"
)

$ErrorActionPreference = "Stop"

$nexusWorkspace = Split-Path -Parent $PSScriptRoot
$nexusDefaultCore = Join-Path $nexusWorkspace ".research\freenet-install\bin\freenet.exe"
$nexusContractWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_message_segment_contract.wasm"
$nexusAttachmentIndexWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_attachment_index_contract.wasm"
$nexusAttachmentChunkWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_attachment_chunk_contract.wasm"
$nexusCommunityWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_community_membership_contract.wasm"
$nexusConversationWasm = Join-Path $nexusWorkspace "target\wasm32-unknown-unknown\release\nexus_private_conversation_contract.wasm"
$nexusRuntimeDirectory = Join-Path $nexusWorkspace ".runtime"
$nexusRuntimeConfig = Join-Path $nexusRuntimeDirectory "phase1.json"
$nexusRuntimeStop = Join-Path $nexusRuntimeDirectory "phase1.stop"
$nexusRuntimeExecutable = Join-Path $nexusWorkspace "target\debug\nexus-phase1-runtime.exe"
$nexusCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$nexusVcVars = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if (-not (Test-Path -LiteralPath $nexusCargo)) {
  $nexusCargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
  if (-not $nexusCargoCommand) {
    throw "Cargo was not found. Install Rust or add cargo.exe to PATH."
  }
  $nexusCargo = $nexusCargoCommand.Source
}
$nexusCargoDirectory = Split-Path -Parent $nexusCargo
if (-not (($env:Path -split ";") -contains $nexusCargoDirectory)) {
  $env:Path = "$nexusCargoDirectory;$env:Path"
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

New-Item -ItemType Directory -Force -Path $nexusRuntimeDirectory | Out-Null
$nexusResolvedWorkspace = [System.IO.Path]::GetFullPath($nexusWorkspace)
foreach ($nexusTransientFile in @($nexusRuntimeConfig, $nexusRuntimeStop)) {
  $nexusResolvedTransient = [System.IO.Path]::GetFullPath($nexusTransientFile)
  if (-not $nexusResolvedTransient.StartsWith($nexusResolvedWorkspace, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a runtime file outside the Nexus workspace."
  }
  if (Test-Path -LiteralPath $nexusResolvedTransient) {
    Remove-Item -LiteralPath $nexusResolvedTransient
  }
}

Push-Location $nexusWorkspace
$nexusRuntimeProcess = $null
try {
  & $nexusCargo build -p nexus-message-segment-contract -p nexus-attachment-index-contract -p nexus-attachment-chunk-contract -p nexus-community-membership-contract -p nexus-private-conversation-contract --release --target wasm32-unknown-unknown
  if ($LASTEXITCODE -ne 0) {
    throw "The Nexus message-segment contract failed to build."
  }
  & $nexusCargo build -p nexus-freenet-two-node-tests --bin nexus-phase1-runtime
  if ($LASTEXITCODE -ne 0) {
    throw "The Nexus Phase 1 runtime failed to build."
  }

  $env:NEXUS_CONTRACT_WASM = $nexusContractWasm
  $env:NEXUS_ATTACHMENT_INDEX_CONTRACT_WASM = $nexusAttachmentIndexWasm
  $env:NEXUS_ATTACHMENT_CHUNK_CONTRACT_WASM = $nexusAttachmentChunkWasm
  $env:NEXUS_COMMUNITY_CONTRACT_WASM = $nexusCommunityWasm
  $env:NEXUS_PRIVATE_CONVERSATION_CONTRACT_WASM = $nexusConversationWasm
  $env:NEXUS_RUNTIME_CONFIG = $nexusRuntimeConfig
  $env:NEXUS_RUNTIME_STOP_FILE = $nexusRuntimeStop
  $nexusRuntimeProcess = Start-Process -FilePath $nexusRuntimeExecutable -PassThru -WindowStyle Hidden

  for ($nexusAttempt = 0; $nexusAttempt -lt 240; $nexusAttempt++) {
    if (Test-Path -LiteralPath $nexusRuntimeConfig) {
      break
    }
    if ($nexusRuntimeProcess.HasExited) {
      throw "The local Freenet runtime exited before it became ready."
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $nexusRuntimeConfig)) {
    throw "The local Freenet runtime did not become ready within 60 seconds."
  }

  $nexusDescriptor = Get-Content -Raw -LiteralPath $nexusRuntimeConfig | ConvertFrom-Json
  if ($Client -eq "web") {
    Remove-Item Env:VITE_NEXUS_FREENET_WS_URL_A -ErrorAction SilentlyContinue
    Remove-Item Env:VITE_NEXUS_FREENET_WS_URL_B -ErrorAction SilentlyContinue
    Remove-Item Env:VITE_NEXUS_FREENET_WS_URL -ErrorAction SilentlyContinue
  } else {
    $env:VITE_NEXUS_FREENET_WS_URL_A = $nexusDescriptor.peer_a_websocket_url
    $env:VITE_NEXUS_FREENET_WS_URL_B = $nexusDescriptor.peer_b_websocket_url
  }
  $env:VITE_NEXUS_CONTRACT_INSTANCE_ID = $nexusDescriptor.contract_instance_id
  $env:VITE_NEXUS_CONTRACT_CODE_HASH = $nexusDescriptor.contract_code_hash
  $env:VITE_NEXUS_BRIDGE_URL = $nexusDescriptor.bridge_url
  $env:VITE_NEXUS_BRIDGE_TOKEN = $nexusDescriptor.bridge_token
  $env:VITE_NEXUS_CHANNEL_ID = $nexusDescriptor.channel_id
  $env:VITE_NEXUS_DISPLAY_NAME = "Mara"

  Write-Host ""
  Write-Host "Nexus Phase 1 is using two real Freenet nodes."
  Write-Host "Open one client as ?node=a&identity=Mara and another as ?node=b&identity=Theo."
  Write-Host ""
  if ($Client -eq "tauri") {
    & pnpm --filter "@nexus/desktop" tauri dev
  } else {
    & pnpm --filter "@nexus/$Client" dev
  }
} finally {
  if ($nexusRuntimeProcess -and -not $nexusRuntimeProcess.HasExited) {
    Set-Content -LiteralPath $nexusRuntimeStop -Value "stop"
    try {
      Wait-Process -Id $nexusRuntimeProcess.Id -Timeout 15 -ErrorAction Stop
    } catch {
      Stop-Process -Id $nexusRuntimeProcess.Id -ErrorAction SilentlyContinue
    }
  }
  Pop-Location
}
