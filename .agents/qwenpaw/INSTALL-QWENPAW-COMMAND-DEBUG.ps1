[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Runtime,
    [string]$QwenPawPython = "python",
    [string]$QwenPawWorkingDir = "",
    [string]$AgentId = "qdmDataAgent",
    [ValidateSet("off", "command")]
    [string]$UserIdDisplayMode = "command",
    [ValidateSet("preserve", "strict")]
    [string]$ToolPolicy = "preserve"
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $PSCommandPath
$sourceRoot = $scriptRoot
$installer = Join-Path $sourceRoot "install-qwenpaw-plugin.py"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    $sourceRoot = Join-Path $scriptRoot "agents\qwenpaw"
    $installer = Join-Path $sourceRoot "install-qwenpaw-plugin.py"
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "QwenPaw 插件安装器不存在：$installer"
}

$arguments = @(
    $installer,
    "install",
    "--runtime", $Runtime,
    "--source", $sourceRoot,
    "--qwenpaw-python", $QwenPawPython,
    "--agent-id", $AgentId,
    "--user-id-display-mode", $UserIdDisplayMode,
    "--tool-policy", $ToolPolicy
)
if ($QwenPawWorkingDir) {
    $arguments += @("--qwenpaw-working-dir", $QwenPawWorkingDir)
}
& $QwenPawPython @arguments
exit $LASTEXITCODE
