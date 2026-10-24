# Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
<#
.SYNOPSIS
Runs the Travel API and keeps it running. The "Highwatch Travel API" scheduled task starts this at boot.

.DESCRIPTION
Starts node on src\server.mjs with the API's .env. When node stops for any reason, it is started again after a
short pause (5 seconds, doubling to at most 60 while it keeps stopping within a minute). Everything the API prints goes to
logs\api-<date>.log, one file per day; files older than -KeepDays are deleted. Only one copy runs at a time.

You do not normally run this by hand. To stop the API use stop-api.ps1; to start it, Start-ScheduledTask.
#>
param(
    [string]$NodePath = '',
    [int]$KeepDays = 14
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common.ps1')
$Root = $script:TravelRoot
$logs = Join-Path $Root 'logs'
$envFile = Join-Path $Root '.env'
$serverScript = Join-Path $Root 'src\server.mjs'
if (-not (Test-Path -LiteralPath $logs)) { $null = New-Item -ItemType Directory -Path $logs -Force }

$script:LogDay = ''
function Write-ApiLog([string]$Text) {
    $day = Get-Date -Format 'yyyy-MM-dd'
    if ($day -ne $script:LogDay) { $script:LogDay = $day; Remove-OldLogs }
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $Text + "`r`n"
    try { Add-TextFile (Join-Path $logs "api-$day.log") $line } catch { }
}
function Remove-OldLogs {
    $cutoff = (Get-Date).Date.AddDays(-$KeepDays)
    Get-ChildItem -LiteralPath $logs -Filter 'api-*.log' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff } | Remove-Item -Force -ErrorAction SilentlyContinue
}

# One copy per machine. A copy that died leaves the mutex abandoned, which the next one simply takes.
$mutex = New-Object System.Threading.Mutex($false, 'Global\HighwatchTravelApi')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { Write-ApiLog 'run-api.ps1 is already running the API; this copy exits.'; exit 0 }

# Holding the mutex, any API node process still running is an orphan of a copy that was killed (stopping the task
# ends this script, not always its node). Stop it by its process id so the port is free.
foreach ($p in (Get-ApiProcess $Root)) {
    Write-ApiLog "Stopping an API process left by an earlier run (process $($p.ProcessId))."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

if (-not $NodePath) { $NodePath = Find-Node }
$delay = 0
try {
    while ($true) {
        if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) { Write-ApiLog "Node.js not found ($NodePath). Run install.ps1 again. Retrying in 60 s."; Start-Sleep -Seconds 60; $NodePath = Find-Node; continue }
        if (-not (Test-Path -LiteralPath $envFile)) { Write-ApiLog "No .env in $Root. Run install.ps1. Retrying in 60 s."; Start-Sleep -Seconds 60; continue }
        Write-ApiLog "Starting the Travel API with $NodePath."
        $started = Get-Date
        Push-Location $Root
        try { & $NodePath "--env-file=$envFile" $serverScript 2>&1 | ForEach-Object { Write-ApiLog ([string]$_) } } finally { Pop-Location }
        $code = $LASTEXITCODE
        $ran = [int]((Get-Date) - $started).TotalSeconds
        if ($ran -ge 60) { $delay = 5 } else { $delay = [Math]::Max(5, [Math]::Min($delay * 2, 60)) }
        Write-ApiLog "The Travel API stopped (exit code $code after $ran s). Starting it again in $delay s."
        Start-Sleep -Seconds $delay
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
