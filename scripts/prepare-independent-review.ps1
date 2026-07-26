param(
  [string]$OutputRoot,
  [switch]$SkipContractBuild,
  [switch]$SkipVerification,
  [switch]$IncludeRealNodeRun
)

$ErrorActionPreference = "Stop"
$nexusWorkspace = Split-Path -Parent $PSScriptRoot
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $nexusWorkspace ".artifacts\independent-review"
}
$nexusCampaignId = [DateTimeOffset]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$nexusCampaignRoot = Join-Path $OutputRoot $nexusCampaignId
$nexusSourceRoot = Join-Path $nexusCampaignRoot "source"
$nexusEvidenceRoot = Join-Path $nexusCampaignRoot "evidence"
$nexusContractsRoot = Join-Path $nexusCampaignRoot "contracts"
$nexusCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$nexusPnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $nexusCargo)) {
  throw "Cargo was not found at $nexusCargo"
}
if (-not $nexusPnpmCommand) {
  throw "pnpm.cmd was not found on PATH"
}
$nexusPnpm = $nexusPnpmCommand.Source

New-Item -ItemType Directory -Path $nexusSourceRoot -Force | Out-Null
New-Item -ItemType Directory -Path $nexusEvidenceRoot -Force | Out-Null
New-Item -ItemType Directory -Path $nexusContractsRoot -Force | Out-Null

function Invoke-NexusEvidenceCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$ArgumentList = @()
  )

  $nexusLog = Join-Path $nexusEvidenceRoot "$Name.log"
  $nexusQuotedArguments = @(
    foreach ($nexusArgument in $ArgumentList) {
      '"{0}"' -f $nexusArgument.Replace('"', '\"')
    }
  )
  $nexusProcessFile = $FilePath
  $nexusProcessArguments = $nexusQuotedArguments -join " "
  if ([IO.Path]::GetExtension($FilePath) -ieq ".cmd") {
    $nexusProcessFile = $env:ComSpec
    $nexusProcessArguments = '/d /s /c ""{0}" {1}"' -f $FilePath, $nexusProcessArguments
  }
  $nexusStartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $nexusStartInfo.FileName = $nexusProcessFile
  $nexusStartInfo.Arguments = $nexusProcessArguments
  $nexusStartInfo.WorkingDirectory = $nexusWorkspace
  $nexusStartInfo.UseShellExecute = $false
  $nexusStartInfo.CreateNoWindow = $true
  $nexusStartInfo.RedirectStandardOutput = $true
  $nexusStartInfo.RedirectStandardError = $true
  $nexusProcess = New-Object System.Diagnostics.Process
  $nexusProcess.StartInfo = $nexusStartInfo
  if (-not $nexusProcess.Start()) {
    throw "Review evidence command '$Name' could not be started"
  }
  $nexusStdoutTask = $nexusProcess.StandardOutput.ReadToEndAsync()
  $nexusStderrTask = $nexusProcess.StandardError.ReadToEndAsync()
  $nexusProcess.WaitForExit()
  $nexusStdout = $nexusStdoutTask.Result
  $nexusStderr = $nexusStderrTask.Result
  $nexusExitCode = $nexusProcess.ExitCode
  ($nexusStdout + $nexusStderr) | Set-Content -LiteralPath $nexusLog -Encoding utf8
  if ($nexusStdout) {
    Write-Host $nexusStdout.TrimEnd()
  }
  if ($nexusStderr) {
    Write-Host $nexusStderr.TrimEnd()
  }
  if ($nexusExitCode -ne 0) {
    throw "Review evidence command '$Name' failed. See $nexusLog"
  }
}

Push-Location $nexusWorkspace
try {
  $nexusRootFiles = @(
    ".env.example",
    ".gitignore",
    "biome.json",
    "Cargo.lock",
    "Cargo.toml",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "NOTICE",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "README.md",
    "rust-toolchain.toml",
    "SECURITY.md",
    "tsconfig.base.json"
  )
  $nexusSourceFiles = @(
    $nexusRootFiles
    & rg --files .github apps deploy docs freenet fuzz packages scripts tests
  ) |
    Where-Object {
      $_ -and
      $_ -notmatch '(^|[\\/])(node_modules|target|dist|\.artifacts|\.runtime|\.research)([\\/]|$)' -and
      $_ -notmatch '(^|[\\/])docs[\\/]qa([\\/]|$)' -and
      $_ -notmatch '\.(exe|dll|pdb|wasm|png|jpg|jpeg|webp|gif|mp4|webm|log)$'
    } |
    Sort-Object -Unique

  foreach ($nexusRelativePath in $nexusSourceFiles) {
    $nexusSourcePath = Join-Path $nexusWorkspace $nexusRelativePath
    if (-not (Test-Path -LiteralPath $nexusSourcePath -PathType Leaf)) {
      continue
    }
    $nexusDestination = Join-Path $nexusSourceRoot $nexusRelativePath
    $nexusDestinationParent = Split-Path -Parent $nexusDestination
    New-Item -ItemType Directory -Path $nexusDestinationParent -Force | Out-Null
    Copy-Item -LiteralPath $nexusSourcePath -Destination $nexusDestination
  }

  $nexusSourceManifest = Get-ChildItem -LiteralPath $nexusSourceRoot -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
      $nexusRelative = $_.FullName.Substring($nexusSourceRoot.Length).TrimStart([char[]]"\/").Replace("\", "/")
      $nexusHash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      "$nexusHash  $nexusRelative"
    }
  $nexusSourceManifest | Set-Content -LiteralPath (Join-Path $nexusCampaignRoot "SOURCE-SHA256SUMS.txt") -Encoding ascii

  $nexusArchive = Join-Path $nexusCampaignRoot "nexus-review-source.zip"
  Compress-Archive -Path (Join-Path $nexusSourceRoot "*") -DestinationPath $nexusArchive -CompressionLevel Optimal
  (Get-FileHash -LiteralPath $nexusArchive -Algorithm SHA256).Hash.ToLowerInvariant() |
    Set-Content -LiteralPath (Join-Path $nexusCampaignRoot "SOURCE-ARCHIVE-SHA256.txt") -Encoding ascii

  $nexusGitRevision = "not-a-git-checkout"
  $nexusGit = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($nexusGit -and (Test-Path -LiteralPath (Join-Path $nexusWorkspace ".git"))) {
    $nexusGitResult = & $nexusGit.Source rev-parse HEAD 2>$null
    if ($LASTEXITCODE -eq 0) {
      $nexusGitRevision = $nexusGitResult.Trim()
    }
  }

  @(
    "campaignId=$nexusCampaignId"
    "createdAt=$([DateTimeOffset]::UtcNow.ToString('O'))"
    "gitRevision=$nexusGitRevision"
    "os=$([System.Environment]::OSVersion.VersionString)"
    "powershell=$($PSVersionTable.PSVersion)"
    "node=$(& node --version)"
    "pnpm=$(& pnpm --version)"
    "cargo=$(& $nexusCargo --version)"
    "rustc=$(& (Join-Path (Split-Path -Parent $nexusCargo) 'rustc.exe') --version)"
  ) | Set-Content -LiteralPath (Join-Path $nexusEvidenceRoot "toolchain.txt") -Encoding utf8

  & pnpm list -r --depth 0 --json |
    Set-Content -LiteralPath (Join-Path $nexusEvidenceRoot "pnpm-direct-dependencies.json") -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm dependency inventory failed"
  }
  & $nexusCargo metadata --locked --format-version 1 |
    Set-Content -LiteralPath (Join-Path $nexusEvidenceRoot "cargo-metadata.json") -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    throw "Cargo dependency inventory failed"
  }
  & $nexusCargo tree --locked |
    Set-Content -LiteralPath (Join-Path $nexusEvidenceRoot "cargo-tree.txt") -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    throw "Cargo dependency tree failed"
  }

  if (-not $SkipContractBuild) {
    $nexusContractPackages = @(
      "nexus-message-segment-contract",
      "nexus-community-membership-contract",
      "nexus-private-conversation-contract",
      "nexus-attachment-index-contract",
      "nexus-attachment-chunk-contract",
      "nexus-voice-session-contract",
      "nexus-release-manifest-contract"
    )
    $nexusBuildArguments = @("build", "--locked", "--release", "--target", "wasm32-unknown-unknown")
    foreach ($nexusPackage in $nexusContractPackages) {
      $nexusBuildArguments += @("-p", $nexusPackage)
    }
    & $nexusCargo @nexusBuildArguments
    if ($LASTEXITCODE -ne 0) {
      throw "Contract build failed"
    }
    Get-ChildItem -LiteralPath "target\wasm32-unknown-unknown\release" -Filter "nexus_*_contract.wasm" |
      ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $nexusContractsRoot
      }
    Get-ChildItem -LiteralPath $nexusContractsRoot -File |
      Sort-Object Name |
      ForEach-Object {
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
      } |
      Set-Content -LiteralPath (Join-Path $nexusContractsRoot "SHA256SUMS.txt") -Encoding ascii
  }

  if (-not $SkipVerification) {
    Invoke-NexusEvidenceCommand -Name "pnpm-lint" -FilePath $nexusPnpm -ArgumentList @("lint")
    Invoke-NexusEvidenceCommand -Name "pnpm-typecheck" -FilePath $nexusPnpm -ArgumentList @("typecheck")
    Invoke-NexusEvidenceCommand -Name "pnpm-test" -FilePath $nexusPnpm -ArgumentList @("test")
    Invoke-NexusEvidenceCommand -Name "cargo-fmt-check" -FilePath $nexusCargo `
      -ArgumentList @("fmt", "--all", "--", "--check")
    Invoke-NexusEvidenceCommand -Name "cargo-clippy" -FilePath $nexusCargo `
      -ArgumentList @("clippy", "--workspace", "--all-targets", "--", "-D", "warnings")
    Invoke-NexusEvidenceCommand -Name "cargo-test" -FilePath $nexusCargo `
      -ArgumentList @("test", "--workspace", "--all-targets")
  }

  if ($IncludeRealNodeRun) {
    Invoke-NexusEvidenceCommand -Name "freenet-two-node" -FilePath $nexusPnpm `
      -ArgumentList @("test:freenet-two-node")
    $nexusRealNodeLog = Join-Path $nexusEvidenceRoot "freenet-two-node.log"
    if (Select-String -LiteralPath $nexusRealNodeLog -Pattern "hit a transient" -Quiet) {
      throw "The real-node review run required a retry and is not qualifying evidence. See $nexusRealNodeLog"
    }
  }

  $nexusArchiveHash = Get-Content -LiteralPath (Join-Path $nexusCampaignRoot "SOURCE-ARCHIVE-SHA256.txt")
  @"
# Nexus independent-review packet

- Campaign: ``$nexusCampaignId``
- Created: ``$([DateTimeOffset]::UtcNow.ToString("O"))``
- Git revision: ``$nexusGitRevision``
- Source archive SHA-256: ``$nexusArchiveHash``

## Contents

- ``nexus-review-source.zip``: exact review source snapshot.
- ``SOURCE-SHA256SUMS.txt``: per-file source manifest.
- ``contracts/``: reviewed contract Wasm and hashes when contract build was enabled.
- ``evidence/``: toolchain, dependency inventories, and verification logs.
- ``source/tests/fixtures/protocol-v2-message.json``: browser-generated cross-language signature fixture.

This packet contains no production keys, TURN secrets, access tokens, or user data.
Independent reviewers must record this archive hash in their report.
"@ | Set-Content -LiteralPath (Join-Path $nexusCampaignRoot "REVIEW-PACKET.md") -Encoding utf8

  Write-Host "Independent-review packet created at $nexusCampaignRoot"
} finally {
  Pop-Location
}
