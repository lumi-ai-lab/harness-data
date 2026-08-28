[CmdletBinding()]
param(
    [string]$Revision = "r14",
    [string]$MaterialSource = "",
    [switch]$SkipAcl
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dist = Join-Path $root "dist"
$base = Join-Path $dist "harness-data-runtime-qwenpaw-plugin-compat-validation-20260826-r13"
$name = "harness-data-runtime-qwenpaw-plugin-compat-validation-20260826-$Revision"
$staging = Join-Path $dist $name
if (Test-Path -LiteralPath $staging) { throw "staging already exists: $staging" }
if (-not $MaterialSource) { $MaterialSource = Join-Path $dist "harness-data-runtime-qwenpaw-plugin-compat-validation-20260826-r12/config/qwenpaw" }
Copy-Item -LiteralPath $base -Destination $staging -Recurse
robocopy (Join-Path $root ".agents/qwenpaw") (Join-Path $staging "agents/qwenpaw") /E /IS /IT /NFL /NDL /NJH /NJS | Out-Null
Copy-Item (Join-Path $MaterialSource "channel-auth.json") (Join-Path $staging "config/qwenpaw/channel-auth.json") -Force
Copy-Item (Join-Path $MaterialSource "session-hmac.secret") (Join-Path $staging "config/qwenpaw/session-hmac.secret") -Force
Get-ChildItem $staging -Recurse -Directory -Filter __pycache__ | ForEach-Object { [IO.Directory]::Delete($_.FullName,$true) }
if (-not $SkipAcl -and $env:OS -eq "Windows_NT") {
    $user = "$($env:USERDOMAIN)\$($env:USERNAME)"
    foreach ($file in "channel-auth.json", "session-hmac.secret") {
        icacls.exe (Join-Path $staging "config/qwenpaw/$file") /inheritance:r /grant:r "$user:R" /grant "SYSTEM:F" /grant "Administrators:F" | Out-Null
    }
}
$zip = "$staging.zip"
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
[IO.File]::WriteAllText("$zip.sha256", $hash)
Write-Output "staging=$staging"
Write-Output "package=$zip"
Write-Output "sha256=$hash"
