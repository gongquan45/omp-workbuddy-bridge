<#
.SYNOPSIS
    Install the omp-wb-bridge extension for OMP.

.DESCRIPTION
    This script has one job: verify that Bun and OMP are present, then hand off to
    src/install.ts, which performs the actual installation and configuration.

    It deliberately does not install, upgrade or configure Bun, OMP or WorkBuddy.
    Those are the user's environment; replacing them from an extension installer
    would be a surprising and hard-to-undo change. When one is missing the script
    stops and names the official place to get it.

    The default is a read-only preview. Review that plan before passing
    -ApplyConfig to apply the release, plugin registration and WorkBuddy MCP entry.

.PARAMETER ApplyConfig
    Apply the planned installation and configuration. Without it the installer
    stops after showing what it would do.

.PARAMETER DryRun
    Run every preflight check and stop before installing anything.

.EXAMPLE
    .\install.ps1 -DryRun

.EXAMPLE
    .\install.ps1 -ApplyConfig
#>
[CmdletBinding()]
param(
    [switch]$ApplyConfig,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The installer is the single source of truth; this script only finds it.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $root 'src/install.ts'

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message"
}

function Stop-WithGuidance {
    param([string]$Reason, [string]$Advice)
    Write-Host ""
    Write-Host "Stopping: $Reason" -ForegroundColor Red
    if ($Advice) { Write-Host "  $Advice" }
    Write-Host ""
    Write-Host "Nothing has been installed or changed."
    exit 1
}

Write-Host "omp-wb-bridge installer" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path -LiteralPath $entry)) {
    Stop-WithGuidance -Reason "the installer entry point is missing" `
        -Advice "Run this script from the unpacked release directory; expected $entry."
}

Write-Step "Checking Bun"
$bun = Get-Command bun -ErrorAction SilentlyContinue
if ($null -eq $bun) {
    Stop-WithGuidance -Reason "Bun is not on PATH" `
        -Advice "Install Bun 1.4 or newer from https://bun.sh, reopen this terminal, and re-run."
}

Write-Step "Checking OMP"
$omp = Get-Command omp -ErrorAction SilentlyContinue
if ($null -eq $omp) {
    Stop-WithGuidance -Reason "OMP is not on PATH" `
        -Advice "Install OMP 18.10.3 or newer (the host this extension targets), then re-run."
}

Write-Step "Checking WorkBuddy"
$workbuddy = Get-Process -Name 'WorkBuddy*' -ErrorAction SilentlyContinue
if ($null -eq $workbuddy) {
    Write-Host "    WorkBuddy is not running. Its configuration will take effect the next time it starts."
} else {
    Write-Host "    WorkBuddy is running. It will keep using its current configuration until you restart it."
    Write-Host "    This installer will not close or restart it."
}

if ($DryRun) {
    Write-Step "Dry run: preflight passed, nothing was installed"
    Write-Host "    Remove -DryRun to preview the plan; use -ApplyConfig to apply it after review."
    exit 0
}

Write-Step "Running the installer"
$arguments = @($entry)
if ($ApplyConfig) { $arguments += '--apply' } else { $arguments += '--preview' }

# Run through the resolved Bun so the same runtime the installer verifies is the
# one that executes it.
& $bun.Source @arguments
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host ""
    Write-Host "The installer reported a problem (exit $exitCode). See the output above." -ForegroundColor Yellow
    exit $exitCode
}

Write-Host ""
if ($ApplyConfig) {
    Write-Host "Installation applied. Restart OMP and verify the loaded extension, then run /wb setup in your project." -ForegroundColor Green
} else {
    Write-Host "Preview only. Nothing was installed. Review the plan, then re-run with -ApplyConfig to apply it." -ForegroundColor Cyan
}
