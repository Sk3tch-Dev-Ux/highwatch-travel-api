# Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
<#
.SYNOPSIS
Backs up the Travel database with mongodump into a dated folder, and deletes backups older than -KeepDays.

.DESCRIPTION
Each run writes <BackupRoot>\travel-<yyyy-MM-dd_HHmm>\<database>\*.bson.gz. It signs in with TRAVEL_MONGO_URL from
the API's .env; the password goes to mongodump in a private temporary config file, never on its command line.
Old backups are only deleted after a backup succeeded, so a run of failures never leaves you with none.
Each run adds one line to logs\backup.log. install.ps1 -RegisterBackup runs this every night at 04:00.
Needs MongoDB Database Tools: winget install --id MongoDB.DatabaseTools --exact

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\windows\backup.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$BackupRoot = (Join-Path $env:ProgramData 'HighwatchTravel\backups'),
    [int]$KeepDays = 14,
    # Added to the folder name, for example before-restore.
    [string]$Label = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$Root = $script:TravelRoot
$logs = Join-Path $Root 'logs'
$dry = [bool]$WhatIfPreference

function Write-BackupLog([string]$Text) {
    Write-Host $Text
    if ($dry) { return }
    try {
        if (-not (Test-Path -LiteralPath $logs)) { $null = New-Item -ItemType Directory -Path $logs -Force }
        Add-TextFile (Join-Path $logs 'backup.log') ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $Text + "`r`n")
    } catch { }
}

try {
    $dotenv = Read-DotEnv (Join-Path $Root '.env')
    if (-not $dotenv['TRAVEL_MONGO_URL']) { throw "No TRAVEL_MONGO_URL in $Root\.env. Run install.ps1 first." }
    $db = Get-TravelDatabase $dotenv
    $uri = (Get-MongoUriParts $dotenv['TRAVEL_MONGO_URL']).WithoutDatabase
    $mongodump = Find-MongoTool 'mongodump'
    if (-not $mongodump) { throw 'mongodump not found. Install MongoDB Database Tools: winget install --id MongoDB.DatabaseTools --exact' }

    $name = 'travel-' + (Get-Date -Format 'yyyy-MM-dd_HHmm')
    if ($Label) { $name = $name + '-' + ($Label -replace '[^A-Za-z0-9-]', '') }
    $target = Join-Path $BackupRoot $name
    $n = 2
    while (Test-Path -LiteralPath $target) { $target = Join-Path $BackupRoot "$name-$n"; $n++ }

    if ($dry) { Write-Host "WOULD dump the database $db with $mongodump into $target" }
    else {
        if (-not (Test-Path -LiteralPath $BackupRoot)) { $null = New-Item -ItemType Directory -Path $BackupRoot -Force; Protect-SecretFolder $BackupRoot }
        $cfg = New-MongoToolConfig $uri
        $output = New-Object System.Collections.Generic.List[string]
        try {
            $ErrorActionPreference = 'Continue'
            & $mongodump "--config=$cfg" "--db=$db" '--gzip' "--out=$target" 2>&1 | ForEach-Object { $output.Add([string]$_) }
            $code = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = 'Stop'
            Remove-Item -LiteralPath $cfg -Force -ErrorAction SilentlyContinue
        }
        if ($code -ne 0) { throw "mongodump failed (exit $code): $(($output | Select-Object -Last 3) -join ' | ')" }
        $files = @(Get-ChildItem -LiteralPath (Join-Path $target $db) -Filter '*.bson.gz' -ErrorAction SilentlyContinue)
        if (-not $files.Count) { throw "mongodump finished but $target\$db holds no collections. Is $db the right database?" }
        $bytes = ($files | Measure-Object -Property Length -Sum).Sum
        Write-BackupLog "OK backup $target, $($files.Count) collections, $([Math]::Round($bytes / 1KB)) KB"
    }

    # Keep -KeepDays days. Only folders this script makes (travel-yyyy-MM-dd_HHmm...) are ever deleted.
    $cutoff = (Get-Date).AddDays(-$KeepDays)
    foreach ($dir in @(Get-ChildItem -LiteralPath $BackupRoot -Directory -Filter 'travel-*' -ErrorAction SilentlyContinue)) {
        if ($dir.Name -notmatch '^travel-(\d{4}-\d{2}-\d{2}_\d{4})') { continue }
        $when = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd_HHmm', [Globalization.CultureInfo]::InvariantCulture)
        if ($when -lt $cutoff -and $dir.FullName -ne $target) {
            if ($dry) { Write-Host "WOULD delete the old backup $($dir.FullName)" }
            else { Remove-Item -LiteralPath $dir.FullName -Recurse -Force; Write-BackupLog "deleted the old backup $($dir.FullName)" }
        }
    }
} catch {
    Write-BackupLog "FAIL backup: $($_.Exception.Message)"
    exit 1
}
