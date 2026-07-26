param(
  [Parameter(Mandatory = $true)]
  [string]$UnsignedPin,
  [Parameter(Mandatory = $true)]
  [string]$PrivateKeyFile,
  [Parameter(Mandatory = $true)]
  [string]$SignedPin
)

$ErrorActionPreference = "Stop"
$nexusWorkspace = Split-Path -Parent $PSScriptRoot
$nexusCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$nexusUnsigned = [IO.Path]::GetFullPath($UnsignedPin)
$nexusPrivateKey = [IO.Path]::GetFullPath($PrivateKeyFile)
$nexusSigned = [IO.Path]::GetFullPath($SignedPin)

if (-not (Test-Path -LiteralPath $nexusUnsigned -PathType Leaf)) {
  throw "Unsigned compatibility pin was not found."
}
if (-not (Test-Path -LiteralPath $nexusPrivateKey -PathType Leaf)) {
  throw "Offline private key file was not found."
}
if ($nexusPrivateKey.StartsWith(([IO.Path]::GetFullPath($nexusWorkspace) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
  throw "The offline release private key must not be stored inside the Nexus workspace."
}
if ($nexusPrivateKey -eq $nexusSigned) {
  throw "The signed compatibility pin cannot overwrite the private key."
}

& $nexusCargo run --quiet -p nexus-protocol --bin sign_core_compatibility_pin -- $nexusUnsigned $nexusPrivateKey $nexusSigned
if ($LASTEXITCODE -ne 0) {
  throw "Offline compatibility-pin signing failed."
}
Write-Host "Signed compatibility pin created at $nexusSigned"
