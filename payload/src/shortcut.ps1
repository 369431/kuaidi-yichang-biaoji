param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('create', 'remove')]
    [string]$Action,

    [string]$StartCmd = ""
)

# Creates or removes the per-user Startup shortcut for the panel. No administrator rights needed.
# ASCII only: Windows PowerShell 5.1 reads .ps1 files with the OEM code page.
$ErrorActionPreference = 'Stop'

$startupDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$linkPath = Join-Path $startupDirectory 'PackingProof InnerMismatch Panel.lnk'

try {
    if ($Action -eq 'remove') {
        if (Test-Path -LiteralPath $linkPath) { Remove-Item -LiteralPath $linkPath -Force }
        [Console]::Out.Write("REMOVED")
        exit 0
    }

    if ([string]::IsNullOrWhiteSpace($StartCmd) -or -not (Test-Path -LiteralPath $StartCmd)) {
        [Console]::Error.Write("start.cmd not found: $StartCmd")
        exit 1
    }

    New-Item -ItemType Directory -Force -Path $startupDirectory | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($linkPath)
    $hiddenLauncher = Join-Path (Split-Path -Parent $StartCmd) 'start-hidden.vbs'
    if (Test-Path -LiteralPath $hiddenLauncher) {
        # Run through the hidden launcher: no console window at sign-in.
        $shortcut.TargetPath = "$env:WINDIR\System32\wscript.exe"
        $shortcut.Arguments = '"' + $hiddenLauncher + '"'
        $shortcut.WindowStyle = 7
    }
    else {
        $shortcut.TargetPath = "$env:ComSpec"
        $shortcut.Arguments = '/c start "" /min "' + $StartCmd + '"'
        $shortcut.WindowStyle = 7
    }
    $shortcut.WorkingDirectory = $env:LOCALAPPDATA
    $shortcut.Description = 'PackingProof inner-mismatch panel'
    $shortcut.Save()
    [Console]::Out.Write("CREATED")
    exit 0
}
catch {
    [Console]::Error.Write($_.Exception.Message)
    exit 1
}
