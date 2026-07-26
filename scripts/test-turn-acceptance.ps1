$ErrorActionPreference = "Stop"

$nexusWorkspace = Split-Path -Parent $PSScriptRoot
$nexusGo = Join-Path $env:LOCALAPPDATA "NexusBuildTools\go1.26.4\bin\go.exe"
$nexusTurnTests = Join-Path $nexusWorkspace "tests\turn-acceptance"

if (-not (Test-Path -LiteralPath $nexusGo)) {
  throw "The verified portable Go 1.26.4 toolchain is required at $nexusGo."
}

Push-Location $nexusTurnTests
try {
  & $nexusGo test -v -count=1 -timeout=2m ./...
  if ($LASTEXITCODE -ne 0) {
    throw "TURN REST and media acceptance failed."
  }
} finally {
  Pop-Location
}
