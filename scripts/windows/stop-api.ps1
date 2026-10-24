# Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
<#
.SYNOPSIS
Stops the Travel API: the scheduled task, then its node process. Start it again with
Start-ScheduledTask -TaskPath '\Highwatch\' -TaskName 'Highwatch Travel API'.

.DESCRIPTION
Game servers keep running while the API is stopped; travel just pauses until it is back. Run as Administrator.
The node process is found by its command line (this folder's src\server.mjs) and stopped by its process id.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$task = Get-ScheduledTask -TaskPath $script:ApiTaskPath -TaskName $script:ApiTaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
    if ($PSCmdlet.ShouldProcess($script:ApiTaskName, 'Stop scheduled task')) { Stop-ScheduledTask -TaskPath $script:ApiTaskPath -TaskName $script:ApiTaskName; Write-Host "Stopped the task $($script:ApiTaskName)." }
} elseif ($task) { Write-Host "The task $($script:ApiTaskName) is not running ($($task.State))." }
else { Write-Host "There is no task $($script:ApiTaskName)." }

foreach ($w in (Get-ApiWrapperProcess)) {
    if ($PSCmdlet.ShouldProcess("run-api.ps1 process $($w.ProcessId)", 'Stop')) { Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Stopped run-api.ps1 (process $($w.ProcessId))." }
}

for ($i = 0; $i -lt 10; $i++) {
    $left = @(Get-ApiProcess)
    if (-not $left.Count) { break }
    foreach ($p in $left) {
        if ($PSCmdlet.ShouldProcess("node process $($p.ProcessId)", 'Stop the Travel API')) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Stopped the API process $($p.ProcessId)." }
    }
    if ($WhatIfPreference) { break }
    Start-Sleep -Milliseconds 500
}
if (-not $WhatIfPreference -and @(Get-ApiProcess).Count) { throw 'The API process is still running. Run stop-api.ps1 again as Administrator.' }
