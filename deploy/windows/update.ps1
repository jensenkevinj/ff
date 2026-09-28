# Pull the latest code, rebuild, and restart the ff service. From an admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\ff\deploy\windows\update.ps1
# (-ExecutionPolicy Bypass applies to this one run, so Windows' script policy doesn't need changing.)

# Stop on errors from PowerShell cmdlets such as Restart-Service.
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 doesn't stop when a program like git or npm fails; it only sets $LASTEXITCODE.
# Check it after each one, so a failed build never restarts the service onto a broken dist\.
function Invoke-Step {
    param([string]$Command, [string[]]$Arguments)
    Write-Host "> $Command $Arguments"
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "'$Command $Arguments' failed with exit code $LASTEXITCODE; the service was not restarted."
    }
}

# Run from the repo root (two folders up from this script), wherever the script was called from.
Set-Location (Join-Path $PSScriptRoot '..\..')

# --ff-only refuses to create a merge commit, so local edits on this machine surface as an error instead.
Invoke-Step git @('pull', '--ff-only')
Invoke-Step npm @('ci')
Invoke-Step npm @('run', 'build')

Restart-Service ff
Get-Service ff
