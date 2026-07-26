param(
  [ValidateRange(1, 86400)]
  [int]$Seconds = 300,
  [ValidateSet("address", "leak", "memory", "thread", "none")]
  [string]$Sanitizer = "address"
)

$ErrorActionPreference = "Stop"
$nexusWorkspace = Split-Path -Parent $PSScriptRoot
$nexusCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$nexusNightly = "nightly-2026-07-20"
$nexusTargets = @("community", "conversation", "attachment", "voice", "release")
$nexusMaxTotalTime = "-max_total_time=$Seconds"
$nexusTimeout = "-timeout=10"
$nexusMaxRuns = "-runs=1000000"

if (
  [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT -and
  $Sanitizer -ne "none"
) {
  $nexusRuntime = $null
  if ($env:NEXUS_LLVM_RUNTIME_DIR) {
    $nexusRuntime = Get-Item -LiteralPath $env:NEXUS_LLVM_RUNTIME_DIR -ErrorAction SilentlyContinue
  }
  if (-not $nexusRuntime) {
    $nexusClang = Get-Command clang.exe -ErrorAction SilentlyContinue
    if ($nexusClang) {
      $nexusResourceDir = (& $nexusClang.Source --print-resource-dir).Trim()
      $nexusRuntime = Get-Item -LiteralPath (Join-Path $nexusResourceDir "lib\windows") -ErrorAction SilentlyContinue
    }
  }
  if (
    -not $nexusRuntime -or
    -not (Test-Path -LiteralPath (Join-Path $nexusRuntime.FullName "clang_rt.asan_dynamic-x86_64.dll"))
  ) {
    throw @"
The Windows sanitizer runtime is unavailable. Install the matching LLVM runtime
or set NEXUS_LLVM_RUNTIME_DIR to the directory containing
clang_rt.asan_dynamic-x86_64.dll. Use -Sanitizer none only for a supplemental
coverage-guided campaign; it does not satisfy the protected sanitizer gate.
"@
  }
  $env:PATH = "$($nexusRuntime.FullName);$env:PATH"
}

Push-Location $nexusWorkspace
try {
  foreach ($nexusTarget in $nexusTargets) {
    Write-Host "Running $nexusTarget input campaign with $Sanitizer for up to $Seconds seconds."
    & $nexusCargo "+$nexusNightly" fuzz run $nexusTarget --fuzz-dir fuzz --sanitizer $Sanitizer -- $nexusMaxRuns $nexusMaxTotalTime $nexusTimeout
    if ($LASTEXITCODE -ne 0) {
      throw "$nexusTarget contract input campaign found a crash or failed to run."
    }
  }
} finally {
  Pop-Location
}
