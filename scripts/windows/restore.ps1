# Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
<#
.SYNOPSIS
Replaces the Travel database with a backup made by backup.ps1. Asks you to type RESTORE first.

.DESCRIPTION
Steps: shows the backup it will use, asks for confirmation, stops the API, backs up the database as it is now
(a "before-restore" folder, so a wrong restore can be undone), restores with mongorestore --drop, starts the API
and checks /readyz.

A restore takes the ledger back to the moment of the backup. A character that travelled after it may be listed on
the server it left, and its trip is gone. Check recent trips afterwards (travel-admin character list).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\windows\restore.ps1
Restores the newest backup.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\windows\restore.ps1 -From C:\ProgramData\HighwatchTravel\backups\travel-2026-10-24_0400
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # A backup folder (travel-...). Default: the newest in -BackupRoot.
    [string]$From = '',
    [string]$BackupRoot = (Join-Path $env:ProgramData 'HighwatchTravel\backups'),
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$Root = $script:TravelRoot
$dry = [bool]$WhatIfPreference

$dotenv = Read-DotEnv (Join-Path $Root '.env')
if (-not $dotenv['TRAVEL_MONGO_URL']) { throw "No TRAVEL_MONGO_URL in $Root\.env. Run install.ps1 first." }
$db = Get-TravelDatabase $dotenv
$uri = (Get-MongoUriParts $dotenv['TRAVEL_MONGO_URL']).WithoutDatabase
if (-not $Port) { $Port = 6070; if ($dotenv['TRAVEL_PORT']) { $Port = [int]$dotenv['TRAVEL_PORT'] } }
$mongorestore = Find-MongoTool 'mongorestore'
if (-not $mongorestore) { throw 'mongorestore not found. Install MongoDB Database Tools: winget install --id MongoDB.DatabaseTools --exact' }

if (-not $From) {
    $newest = Get-ChildItem -LiteralPath $BackupRoot -Directory -Filter 'travel-*' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^travel-\d{4}-\d{2}-\d{2}_\d{4}' } | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $newest) { throw "No backups in $BackupRoot. Give one with -From." }
    $From = $newest.FullName
}
$From = (Resolve-Path -LiteralPath $From).Path
$files = @(Get-ChildItem -LiteralPath (Join-Path $From $db) -Filter '*.bson.gz' -ErrorAction SilentlyContinue)
if (-not $files.Count) { throw "$From has no $db folder with collections in it. Give the travel-... folder that backup.ps1 made." }

Write-Host "Backup:   $From ($($files.Count) collections, written $((Get-Item -LiteralPath $From).LastWriteTime))"
Write-Host "Replaces: the database $db, every collection in it"
Write-Host 'Trips and changes made after this backup are lost. The API is stopped while it runs.'
if ($dry) { Write-Host 'WOULD ask you to type RESTORE, stop the API, back up the database as it is now, restore, start the API.'; exit 0 }

$answer = Read-Host "Type RESTORE to replace $db with this backup"
if ($answer -cne 'RESTORE') { Write-Host 'Nothing changed.'; exit 1 }

& (Join-Path $PSScriptRoot 'stop-api.ps1')
Write-Host 'Backing up the database as it is now, so this restore can be undone...'
& (Join-Path $PSScriptRoot 'backup.ps1') -BackupRoot $BackupRoot -KeepDays 36500 -Label 'before-restore'
if ($LASTEXITCODE -ne 0) { throw 'The safety backup failed, so nothing was restored. The API is stopped: start it with Start-ScheduledTask.' }

$cfg = New-MongoToolConfig $uri
try {
    $ErrorActionPreference = 'Continue'
    & $mongorestore "--config=$cfg" "--nsInclude=$db.*" '--drop' '--gzip' "--dir=$From" 2>&1 | ForEach-Object { Write-Host "   $_" }
    $code = $LASTEXITCODE
} finally {
    $ErrorActionPreference = 'Stop'
    Remove-Item -LiteralPath $cfg -Force -ErrorAction SilentlyContinue
}
if ($code -ne 0) { throw "mongorestore failed (exit $code). The API is stopped. The database as it was before is in the newest travel-...-before-restore folder in $BackupRoot." }
Write-Host 'Restored.'

if (Get-ScheduledTask -TaskPath $script:ApiTaskPath -TaskName $script:ApiTaskName -ErrorAction SilentlyContinue) { Start-ScheduledTask -TaskPath $script:ApiTaskPath -TaskName $script:ApiTaskName }
else { Write-Host "There is no task $($script:ApiTaskName). Start the API the way you run it (install.ps1 registers the task)." }
$ready = @{ Status = 0; Body = '' }
for ($i = 0; $i -lt 60; $i++) { $ready = Get-Http "http://127.0.0.1:$Port/readyz" 2000; if ($ready.Status -eq 200) { break }; Start-Sleep -Seconds 1 }
Write-Host "GET /readyz -> $($ready.Status) $($ready.Body)"
Write-Host 'Check recent trips now: npm run admin -- character list <network>'
