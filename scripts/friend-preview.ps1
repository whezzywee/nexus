param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8790
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDirectory = Join-Path $repositoryRoot ".runtime\friend-preview"
$sessionPath = Join-Path $runtimeDirectory "session.json"

New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null

if (Test-Path -LiteralPath $sessionPath) {
    $previous = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
    $running = @($previous.tunnelPid, $previous.gatewayPid) |
        Where-Object { $_ -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) }
    if ($running.Count -gt 0) {
        throw "A friend preview is already running. Use pnpm friend:stop first."
    }
}

function Find-Executable {
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [string[]]$Candidates = @()
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Get-OrCreateSecret {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (Test-Path -LiteralPath $Path) {
        $existing = (Get-Content -LiteralPath $Path -Raw).Trim()
        if ($existing.Length -ge 32) {
            return $existing
        }
        throw "The existing preview secret at $Path is unexpectedly short."
    }
    $bytes = New-Object byte[] 48
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    $secret = [Convert]::ToBase64String($bytes)
    [IO.File]::WriteAllText($Path, $secret, [Text.UTF8Encoding]::new($false))
    return $secret
}

$cloudflaredCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\cloudflared.exe"),
    (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "cloudflared\cloudflared.exe")
)
$cloudflared = Find-Executable -Name "cloudflared" -Candidates $cloudflaredCandidates
if (-not $cloudflared) {
    throw "cloudflared is required. Install it with: winget install --id Cloudflare.cloudflared"
}

$cargo = Find-Executable -Name "cargo" -Candidates @(
    (Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe")
)
if (-not $cargo) {
    throw "Rust cargo is required to build the meeting gateway."
}

$pnpm = Find-Executable -Name "pnpm"
if (-not $pnpm) {
    throw "pnpm is required to build Nexus Web."
}

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use."
}

$gatewaySecretPath = Join-Path $runtimeDirectory "gateway_hmac_secret"
$hostSecretPath = Join-Path $runtimeDirectory "meeting_host_secret"
$null = Get-OrCreateSecret -Path $gatewaySecretPath
$hostSecret = Get-OrCreateSecret -Path $hostSecretPath

$env:VITE_NEXUS_MEETING_ONLY = "true"
$env:VITE_NEXUS_MEETING_INVITE_URL = "/nexus/v1/meeting-invites"
$env:VITE_NEXUS_MEETING_SIGNAL_URL = "/nexus/v1/meetings"
$env:VITE_NEXUS_MEETING_HOST_SESSION_URL = "/nexus/v1/meeting-host-sessions"
$env:VITE_NEXUS_STUN_URLS = "stun:stun.cloudflare.com:3478"
Remove-Item Env:VITE_NEXUS_TURN_CREDENTIAL_URL -ErrorAction SilentlyContinue
Remove-Item Env:VITE_NEXUS_WEB_APP_URL -ErrorAction SilentlyContinue
Remove-Item Env:VITE_NEXUS_MEETING_HOST_AUTHORIZATION -ErrorAction SilentlyContinue

Push-Location $repositoryRoot
try {
    & $pnpm --filter "@nexus/web" build
    if ($LASTEXITCODE -ne 0) {
        throw "Nexus Web failed to build."
    }
    & $cargo build --locked --release -p nexus-gateway
    if ($LASTEXITCODE -ne 0) {
        throw "The Nexus meeting gateway failed to build."
    }
} finally {
    Pop-Location
}

$tunnelOutput = Join-Path $runtimeDirectory "cloudflared.stdout.log"
$tunnelError = Join-Path $runtimeDirectory "cloudflared.stderr.log"
$tunnel = Start-Process -FilePath $cloudflared `
    -ArgumentList @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$Port") `
    -WorkingDirectory $repositoryRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $tunnelOutput `
    -RedirectStandardError $tunnelError `
    -PassThru

$publicUrl = $null
for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    if ($tunnel.HasExited) {
        throw "cloudflared stopped before creating a URL. See $tunnelError"
    }
    $logs = @(
        (Get-Content -LiteralPath $tunnelOutput -Raw -ErrorAction SilentlyContinue),
        (Get-Content -LiteralPath $tunnelError -Raw -ErrorAction SilentlyContinue)
    ) -join "`n"
    $match = [regex]::Match($logs, "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($match.Success) {
        $publicUrl = $match.Value
        break
    }
    Start-Sleep -Milliseconds 500
}

if (-not $publicUrl) {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    throw "Timed out waiting for a temporary public URL. See $tunnelError"
}

$env:NEXUS_GATEWAY_BIND = "127.0.0.1:$Port"
$env:NEXUS_GATEWAY_ID = "nexus-friend-preview"
$env:NEXUS_GATEWAY_HMAC_SECRET_FILE = $gatewaySecretPath
$env:NEXUS_GATEWAY_MEETING_ONLY = "true"
$env:NEXUS_GATEWAY_ORIGINS = $publicUrl
$env:NEXUS_MEETING_HOST_SECRET_FILE = $hostSecretPath
$env:NEXUS_MEETING_HOST_SESSION_TTL_SECONDS = "900"
$env:NEXUS_MEETING_INVITE_TTL_SECONDS = "86400"
$env:NEXUS_WEB_STATIC_DIR = (Resolve-Path (Join-Path $repositoryRoot "apps\web\dist")).Path
$env:RUST_LOG = "nexus_gateway=info,tower_http=info"
Remove-Item Env:NEXUS_GATEWAY_HMAC_SECRET -ErrorAction SilentlyContinue
Remove-Item Env:NEXUS_GATEWAY_UPSTREAM_URL -ErrorAction SilentlyContinue
Remove-Item Env:NEXUS_GATEWAY_UPSTREAM_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:NEXUS_GATEWAY_CONTRACT_KEYS -ErrorAction SilentlyContinue
Remove-Item Env:NEXUS_TURN_SECRET -ErrorAction SilentlyContinue
Remove-Item Env:NEXUS_TURN_SECRET_FILE -ErrorAction SilentlyContinue
Remove-Item Env:NEXUS_TURN_URLS -ErrorAction SilentlyContinue

$gatewayOutput = Join-Path $runtimeDirectory "gateway.stdout.log"
$gatewayError = Join-Path $runtimeDirectory "gateway.stderr.log"
$gatewayExecutable = Join-Path $repositoryRoot "target\release\nexus-gateway.exe"
$gateway = Start-Process -FilePath $gatewayExecutable `
    -WorkingDirectory $repositoryRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $gatewayOutput `
    -RedirectStandardError $gatewayError `
    -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if ($gateway.HasExited) {
        Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
        throw "The meeting gateway stopped during startup. See $gatewayError"
    }
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/nexus/v1/health" -TimeoutSec 2
        if ($health.status -eq "ready" -and $health.freenet -eq "disabled") {
            $ready = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

if (-not $ready) {
    Stop-Process -Id $gateway.Id, $tunnel.Id -Force -ErrorAction SilentlyContinue
    throw "The meeting gateway did not become ready. See $gatewayError"
}

$session = [ordered]@{
    publicUrl = $publicUrl
    gatewayPid = $gateway.Id
    tunnelPid = $tunnel.Id
    port = $Port
    startedAt = [DateTimeOffset]::UtcNow.ToString("O")
}
[IO.File]::WriteAllText(
    $sessionPath,
    ($session | ConvertTo-Json),
    [Text.UTF8Encoding]::new($false)
)

Write-Host ""
Write-Host "Nexus friend preview is ready." -ForegroundColor Green
Write-Host "Public page: $publicUrl"
Write-Host "Private host passphrase: $hostSecret"
Write-Host ""
Write-Host "Keep the passphrase private. Open the page, choose Share link, enter it once,"
Write-Host "then share only the generated meeting link with friends."
Write-Host "Your computer must stay online. Stop the preview with: pnpm friend:stop"
Write-Host "This temporary tunnel has no uptime guarantee and uses direct WebRTC/STUN;"
Write-Host "some restrictive networks still require the optional TURN deployment."

Start-Process $publicUrl
