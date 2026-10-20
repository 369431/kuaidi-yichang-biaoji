param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [string]$RuleName = "PackingProof InnerMismatch Panel"
)

# Adds the inbound firewall rule. This script is started elevated (UAC) by the adapter.
# ASCII only: Windows PowerShell 5.1 reads .ps1 files with the OEM code page.
$ErrorActionPreference = 'Stop'

try {
    netsh advfirewall firewall delete rule name="$RuleName" | Out-Null
    $output = netsh advfirewall firewall add rule name="$RuleName" dir=in action=allow protocol=TCP localport=$Port profile=private,domain
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.Write("netsh failed: " + ($output -join ' '))
        exit 1
    }
    [Console]::Out.Write("OK")
    exit 0
}
catch {
    [Console]::Error.Write($_.Exception.Message)
    exit 1
}
