param(
  [ValidateRange(0.01, 720)]
  [double]$DurationHours = 24,
  [ValidateRange(0, 100000)]
  [int]$MaxIterations = 0,
  [ValidateRange(0, 3600)]
  [int]$PauseSeconds = 30,
  [string]$EvidenceRoot
)

$ErrorActionPreference = "Stop"

$nexusWorkspace = Split-Path -Parent $PSScriptRoot
$nexusHarness = Join-Path $PSScriptRoot "test-freenet-two-node.ps1"
if (-not (Test-Path -LiteralPath $nexusHarness -PathType Leaf)) {
  throw "The two-node acceptance harness was not found."
}

if (-not $EvidenceRoot) {
  $EvidenceRoot = Join-Path $nexusWorkspace ".artifacts\soak\freenet"
}
$nexusEvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
$nexusWorkspaceRoot = [IO.Path]::GetFullPath($nexusWorkspace)
if (-not $nexusEvidenceRoot.StartsWith(
  $nexusWorkspaceRoot + [IO.Path]::DirectorySeparatorChar,
  [StringComparison]::OrdinalIgnoreCase
)) {
  throw "Soak evidence must be written under the Nexus workspace."
}

$nexusCampaignId = [DateTimeOffset]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$nexusCampaignDirectory = Join-Path $nexusEvidenceRoot $nexusCampaignId
New-Item -ItemType Directory -Path $nexusCampaignDirectory -Force | Out-Null

$nexusEventsPath = Join-Path $nexusCampaignDirectory "events.jsonl"
$nexusSummaryPath = Join-Path $nexusCampaignDirectory "summary.json"
$nexusStartedAt = [DateTimeOffset]::UtcNow
$nexusDeadline = $nexusStartedAt.AddHours($DurationHours)
$nexusIteration = 0
$nexusPassed = 0
$nexusFailed = 0
$nexusFinalStatus = "running"

try {
  while ([DateTimeOffset]::UtcNow -lt $nexusDeadline) {
    if ($MaxIterations -gt 0 -and $nexusIteration -ge $MaxIterations) {
      break
    }

    $nexusIteration++
    $nexusRunStartedAt = [DateTimeOffset]::UtcNow
    $nexusLogPath = Join-Path $nexusCampaignDirectory (
      "iteration-{0:D5}.log" -f $nexusIteration
    )

    $nexusPreviousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $nexusOutput = & powershell.exe `
        -NoProfile `
        -ExecutionPolicy Bypass `
        -File $nexusHarness 2>&1
      $nexusExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $nexusPreviousErrorActionPreference
    }
    $nexusOutput | Set-Content -LiteralPath $nexusLogPath -Encoding utf8

    $nexusRunEndedAt = [DateTimeOffset]::UtcNow
    $nexusTranscript = $nexusOutput | Out-String
    $nexusTransientDetected = $nexusTranscript -match "hit a transient"
    $nexusSucceeded = $nexusExitCode -eq 0 -and -not $nexusTransientDetected
    if ($nexusSucceeded) {
      $nexusPassed++
    } else {
      $nexusFailed++
    }

    [ordered]@{
      schemaVersion = 1
      iteration = $nexusIteration
      startedAt = $nexusRunStartedAt.ToString("O")
      endedAt = $nexusRunEndedAt.ToString("O")
      durationSeconds = [Math]::Round(
        ($nexusRunEndedAt - $nexusRunStartedAt).TotalSeconds,
        3
      )
      status = if ($nexusSucceeded) { "passed" } else { "failed" }
      exitCode = $nexusExitCode
      transientRetryDetected = $nexusTransientDetected
      log = [IO.Path]::GetFileName($nexusLogPath)
    } |
      ConvertTo-Json -Compress |
      Add-Content -LiteralPath $nexusEventsPath -Encoding utf8

    if (-not $nexusSucceeded) {
      $nexusFailureKind = if ($nexusTransientDetected) {
        "required a transient retry"
      } else {
        "failed"
      }
      throw "Two-node soak iteration $nexusIteration $nexusFailureKind. See $nexusLogPath"
    }

    if (
      $PauseSeconds -gt 0 -and
      [DateTimeOffset]::UtcNow.AddSeconds($PauseSeconds) -lt $nexusDeadline
    ) {
      Start-Sleep -Seconds $PauseSeconds
    }
  }

  if ($nexusIteration -eq 0) {
    throw "The soak campaign completed without running an iteration."
  }
  $nexusFinalStatus = "passed"
} catch {
  $nexusFinalStatus = "failed"
  throw
} finally {
  $nexusEndedAt = [DateTimeOffset]::UtcNow
  [ordered]@{
    schemaVersion = 1
    campaignId = $nexusCampaignId
    status = $nexusFinalStatus
    startedAt = $nexusStartedAt.ToString("O")
    endedAt = $nexusEndedAt.ToString("O")
    requestedDurationHours = $DurationHours
    maxIterations = $MaxIterations
    pauseSeconds = $PauseSeconds
    iterations = $nexusIteration
    passed = $nexusPassed
    failed = $nexusFailed
    coreBinary = $env:NEXUS_FREENET_BIN
  } |
    ConvertTo-Json |
    Set-Content -LiteralPath $nexusSummaryPath -Encoding utf8

  Write-Host "Soak evidence: $nexusCampaignDirectory"
}
