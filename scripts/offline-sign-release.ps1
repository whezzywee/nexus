param(
  [Parameter(Mandatory = $true)]
  [string]$UnsignedRecord,
  [Parameter(Mandatory = $true)]
  [string]$PrivateKeyFile,
  [Parameter(Mandatory = $true)]
  [string]$SignedRecord
)

$ErrorActionPreference = "Stop"
$nexusWorkspace = Split-Path -Parent $PSScriptRoot
$nexusCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$nexusUnsigned = [IO.Path]::GetFullPath($UnsignedRecord)
$nexusPrivateKey = [IO.Path]::GetFullPath($PrivateKeyFile)
$nexusSigned = [IO.Path]::GetFullPath($SignedRecord)

if (-not (Test-Path -LiteralPath $nexusUnsigned -PathType Leaf)) {
  throw "Unsigned release record was not found."
}
if (-not (Test-Path -LiteralPath $nexusPrivateKey -PathType Leaf)) {
  throw "Offline private key file was not found."
}
if ($nexusPrivateKey.StartsWith(([IO.Path]::GetFullPath($nexusWorkspace) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
  throw "The offline release private key must not be stored inside the Nexus workspace."
}
if ($nexusPrivateKey -eq $nexusSigned) {
  throw "The signed record cannot overwrite the private key."
}

& $nexusCargo run --quiet -p nexus-protocol --bin sign_release_record -- $nexusUnsigned $nexusPrivateKey $nexusSigned
if ($LASTEXITCODE -ne 0) {
  throw "Offline release signing failed."
}
Write-Host "Signed release record created at $nexusSigned"
