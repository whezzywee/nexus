$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sessionPath = Join-Path $repositoryRoot ".runtime\friend-preview\session.json"

if (-not (Test-Path -LiteralPath $sessionPath)) {
    Write-Host "No Nexus friend preview session is recorded."
    exit 0
}

$session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
$targets = @(
    @{ Id = [int]$session.gatewayPid; Expected = "nexus-gateway.exe" },
    @{ Id = [int]$session.tunnelPid; Expected = "cloudflared.exe" }
)

foreach ($target in $targets) {
    $process = Get-Process -Id $target.Id -ErrorAction SilentlyContinue
    if (-not $process) {
        continue
    }
    if ($process.ProcessName + ".exe" -ne $target.Expected) {
        throw "PID $($target.Id) is not the expected $($target.Expected); refusing to stop it."
    }
    Stop-Process -Id $target.Id -Force
}

Remove-Item -LiteralPath $sessionPath
Write-Host "Nexus friend preview stopped. Local secrets and logs were preserved."
