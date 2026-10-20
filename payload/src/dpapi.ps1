param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('protect', 'unprotect')]
    [string]$Action
)

# DPAPI helper for the PackingProof inner-mismatch adapter.
# Reads base64 from stdin, writes base64 to stdout, never logs the payload.
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $stdin = [Console]::In.ReadToEnd()
    $inputBytes = [Convert]::FromBase64String($stdin.Trim())
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($Action -eq 'protect') {
        $outputBytes = [System.Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, $scope)
    }
    else {
        $outputBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, $scope)
    }
    [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
    exit 0
}
catch {
    [Console]::Error.Write($_.Exception.Message)
    exit 1
}
