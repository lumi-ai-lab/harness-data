[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Runtime
)

$ErrorActionPreference = "Stop"
$runtimeRoot = (Resolve-Path -LiteralPath $Runtime -ErrorAction Stop).Path
$materialDir = Join-Path $runtimeRoot "config\qwenpaw"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$files = @(
    (Join-Path $materialDir "channel-auth.json"),
    (Join-Path $materialDir "session-hmac.secret")
)

foreach ($file in $files) {
    $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "拒绝符号链接材料文件：$file"
    }
    $acl = Get-Acl -LiteralPath $file
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
        [void]$acl.RemoveAccessRuleSpecific($rule)
    }
    foreach ($entry in @(
        @{ Identity = $currentUser; Rights = [System.Security.AccessControl.FileSystemRights]::Read },
        @{ Identity = "SYSTEM"; Rights = [System.Security.AccessControl.FileSystemRights]::FullControl },
        @{ Identity = "Administrators"; Rights = [System.Security.AccessControl.FileSystemRights]::FullControl }
    )) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $entry.Identity,
            $entry.Rights,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $file -AclObject $acl
    Write-Host "已收紧材料 ACL：$file"
}
