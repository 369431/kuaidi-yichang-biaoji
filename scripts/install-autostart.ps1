param(
    [Parameter(Mandatory = $true)]
    [string]$StartCmd,

    [string]$Directory = ""
)

# Creates a Startup shortcut for the inner-mismatch panel.
# ASCII only: run by Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $StartCmd)) {
    throw "start.cmd not found: $StartCmd"
}

if ($Directory -eq "") {
    $Directory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
}
New-Item -ItemType Directory -Force -Path $Directory | Out-Null

$linkPath = Join-Path $Directory 'PackingProof InnerMismatch Panel.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = "$env:ComSpec"
$shortcut.Arguments = '/c start "" /min "' + $StartCmd + '"'
$shortcut.WorkingDirectory = $env:LOCALAPPDATA
$shortcut.WindowStyle = 7
$shortcut.Description = 'PackingProof inner-mismatch panel'
$shortcut.Save()

Write-Output ("Created: " + $linkPath)
Write-Output ("Target:  " + $shortcut.TargetPath)
Write-Output ("Args:    " + $shortcut.Arguments)
