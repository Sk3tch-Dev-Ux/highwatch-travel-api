# Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
# Shared helpers for the Windows scripts. Dot-sourced, never run on its own. Works on Windows PowerShell 5.1 (what
# Task Scheduler runs) and on PowerShell 7.

# Load the modules used here before any -WhatIf is in force: under -WhatIf, Windows PowerShell 5.1 reports every
# alias a module defines while it loads as a "What if" line.
$hwWhatIf = $WhatIfPreference
$WhatIfPreference = $false
Import-Module CimCmdlets, ScheduledTasks -ErrorAction SilentlyContinue
$WhatIfPreference = $hwWhatIf

$script:TravelRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:ApiTaskPath = '\Highwatch\'
$script:ApiTaskName = 'Highwatch Travel API'
$script:BackupTaskName = 'Highwatch Travel Backup'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   OK    $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "   NOTE  $Text" -ForegroundColor Yellow }
function Write-Plan([string]$Text) { Write-Host "   WOULD $Text" -ForegroundColor Magenta }

function Test-IsAdministrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Text files without a byte order mark: Node's --env-file reads a BOM as part of the first key.
function Write-TextFile([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom) }
function Add-TextFile([string]$Path, [string]$Text) { [System.IO.File]::AppendAllText($Path, $Text, $script:Utf8NoBom) }

# Only Administrators, SYSTEM (the API's task runs as SYSTEM) and the person running the script may read the file.
function Protect-SecretFile([string]$Path) {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $null = & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-32-544:(F)' '*S-1-5-18:(F)' "*$($me):(F)" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict who can read $Path (icacls exit $LASTEXITCODE)." }
}

function Protect-SecretFolder([string]$Path) {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $null = & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)(F)' '*S-1-5-18:(OI)(CI)(F)' "*$($me):(OI)(CI)(F)" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict who can read $Path (icacls exit $LASTEXITCODE)." }
}

# A MongoDB connection string split into its parts. Without the database the backup tools take --db and
# --nsInclude instead, so the database in the path moves to authSource when there is none.
function Get-MongoUriParts([string]$Uri) {
    if ($Uri -notmatch '^(mongodb(?:\+srv)?://[^/?]+)(?:/([^?]*))?(\?.*)?$') { throw 'TRAVEL_MONGO_URL is not a MongoDB connection string.' }
    $base = $Matches[1]
    $db = ''
    if ($Matches[2]) { $db = [uri]::UnescapeDataString($Matches[2]) }
    $query = ''
    if ($Matches[3]) { $query = $Matches[3] }
    $noDb = $base + '/' + $query
    if ($db -and $query -notmatch '[?&]authSource=') {
        if ($query) { $noDb = $noDb + '&authSource=' + $db } else { $noDb = $noDb + '?authSource=' + $db }
    }
    return @{ Database = $db; WithoutDatabase = $noDb }
}
function Get-TravelDatabase([hashtable]$DotEnv) {
    if ($DotEnv['TRAVEL_DB']) { return $DotEnv['TRAVEL_DB'] }
    $parts = Get-MongoUriParts $DotEnv['TRAVEL_MONGO_URL']
    if ($parts.Database) { return $parts.Database }
    return 'highwatch_travel'
}

# A password of letters and digits only, so it never needs URL encoding in a connection string. 32 characters from
# 62 is about 190 bits. Rejection sampling keeps every character equally likely.
function New-StrongPassword([int]$Length = 32) {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $sb = New-Object System.Text.StringBuilder
    $buf = New-Object byte[] 1
    try {
        while ($sb.Length -lt $Length) {
            $rng.GetBytes($buf)
            if ($buf[0] -lt 248) { [void]$sb.Append($alphabet[$buf[0] % 62]) }
        }
    } finally { $rng.Dispose() }
    return $sb.ToString()
}

# .env: KEY=VALUE lines. Read gives a hashtable; Set replaces the given keys in place (first uncommented line) or
# appends them, and keeps every other line and comment as it was.
function Read-DotEnv([string]$Path) {
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
            $key = $Matches[1]
            if (-not $values.ContainsKey($key)) { $values[$key] = $Matches[2].Trim() }
        }
    }
    return $values
}
function Set-DotEnvText([string]$Text, [hashtable]$Values) {
    $lines = New-Object System.Collections.Generic.List[string]
    if ($Text) { foreach ($l in ($Text -split "\r?\n")) { $lines.Add($l) } }
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
    foreach ($key in ($Values.Keys | Sort-Object)) {
        $done = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match ('^\s*' + [regex]::Escape($key) + '\s*=')) { $lines[$i] = "$key=$($Values[$key])"; $done = $true; break }
        }
        if (-not $done) { $lines.Add("$key=$($Values[$key])") }
    }
    return (($lines -join "`r`n") + "`r`n")
}

# mongod.cfg is YAML. These edits are line based and only touch what they must: net.bindIp becomes 127.0.0.1
# (bindIpAll is commented out) and security.authorization becomes enabled. Everything else stays as it was.
function Get-YamlSection($Lines, [string]$Name) {
    $start = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) { if ($Lines[$i] -match ('^' + [regex]::Escape($Name) + ':\s*(#.*)?$')) { $start = $i; break } }
    if ($start -lt 0) { return $null }
    $end = $Lines.Count
    for ($j = $start + 1; $j -lt $Lines.Count; $j++) { if ($Lines[$j] -match '^[^\s#]') { $end = $j; break } }
    return @{ Start = $start; End = $end }
}
function Get-YamlIndent($Lines, $Section) {
    for ($k = $Section.Start + 1; $k -lt $Section.End; $k++) { if ($Lines[$k] -match '^(\s+)[^\s#]') { return $Matches[1] } }
    return '  '
}
function Update-MongoCfgText([string]$Text) {
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($l in ($Text -split "\r?\n")) { $lines.Add($l) }

    $net = Get-YamlSection $lines 'net'
    if ($null -eq $net) {
        $lines.Add('net:'); $lines.Add('  port: 27017'); $lines.Add('  bindIp: 127.0.0.1')
    } else {
        $indent = Get-YamlIndent $lines $net
        $found = $false
        for ($k = $net.Start + 1; $k -lt $net.End; $k++) {
            if ($lines[$k] -match '^(\s+)bindIp\s*:') { $lines[$k] = "$($Matches[1])bindIp: 127.0.0.1"; $found = $true }
            elseif ($lines[$k] -match '^(\s+)bindIpAll\s*:') { $lines[$k] = "$($Matches[1])#$($lines[$k].TrimStart())  # off: Highwatch Travel keeps MongoDB on 127.0.0.1" }
        }
        if (-not $found) { $lines.Insert($net.Start + 1, "$($indent)bindIp: 127.0.0.1") }
    }

    $sec = Get-YamlSection $lines 'security'
    if ($null -eq $sec) {
        $commented = -1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^#\s*security\s*:\s*$') { $commented = $i; break } }
        if ($commented -ge 0) { $lines[$commented] = 'security:'; $lines.Insert($commented + 1, '  authorization: enabled') }
        else { $lines.Add('security:'); $lines.Add('  authorization: enabled') }
    } else {
        $indent = Get-YamlIndent $lines $sec
        $found = $false
        for ($k = $sec.Start + 1; $k -lt $sec.End; $k++) {
            if ($lines[$k] -match '^(\s+)authorization\s*:') { $lines[$k] = "$($Matches[1])authorization: enabled"; $found = $true }
        }
        if (-not $found) { $lines.Insert($sec.Start + 1, "$($indent)authorization: enabled") }
    }
    $nl = "`n"
    if ($Text -match "`r`n") { $nl = "`r`n" }
    return ($lines -join $nl)
}
function Get-MongoCfgPort([string]$Text) {
    if ($Text -match '(?m)^\s+port\s*:\s*(\d+)') { return [int]$Matches[1] }
    return 27017
}

# The MongoDB Windows service and the config file its command line names.
function Get-MongoService([string]$Name = 'MongoDB') {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
    if (-not $svc) { return $null }
    $cfg = ''
    if ($svc.PathName -match '(?:--config|-f)\s+"([^"]+)"') { $cfg = $Matches[1] }
    elseif ($svc.PathName -match '(?:--config|-f)\s+(\S+)') { $cfg = $Matches[1] }
    return @{ Name = $svc.Name; State = $svc.State; StartMode = $svc.StartMode; PathName = $svc.PathName; Config = $cfg }
}

# mongodump and mongorestore: on PATH, else the newest MongoDB Database Tools folder.
function Find-MongoTool([string]$Name) {
    $cmd = Get-Command "$Name.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($base in @("$env:ProgramFiles\MongoDB\Tools", "$env:ProgramFiles\MongoDB\Server")) {
        if (Test-Path -LiteralPath $base) {
            $hit = Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName "bin\$Name.exe" } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
            if ($hit) { return $hit }
        }
    }
    return $null
}

function Find-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe")) { if (Test-Path -LiteralPath $p) { return $p } }
    return $null
}

function Test-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutMs = 1000) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        return ($task.Wait($TimeoutMs) -and $client.Connected)
    } catch { return $false } finally { $client.Close() }
}

# A GET that reports the status and body for any answer, 503 included.
function Get-Http([string]$Url, [int]$TimeoutMs = 5000) {
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Timeout = $TimeoutMs
        $res = $req.GetResponse()
    } catch [System.Net.WebException] {
        $res = $_.Exception.Response
        if (-not $res) { return @{ Status = 0; Body = $_.Exception.Message } }
    }
    try {
        $reader = New-Object System.IO.StreamReader($res.GetResponseStream())
        return @{ Status = [int]$res.StatusCode; Body = $reader.ReadToEnd() }
    } finally { $res.Close() }
}

# The API's node processes, found by their command line (this folder's src\server.mjs), never by image name.
function Get-ApiProcess([string]$Root = $script:TravelRoot) {
    $server = Join-Path $Root 'src\server.mjs'
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($server, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

# The run-api.ps1 wrappers (Task Scheduler's, or one started by hand), by command line, so stop-api.ps1 can end them
# before their node, which they would otherwise start again.
function Get-ApiWrapperProcess {
    return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf('run-api.ps1', [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

# The travel connection string from .env, with the backup tools' YAML config written to a private temp file so the
# password is never on a command line. The caller deletes the file.
function New-MongoToolConfig([string]$Uri) {
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ("hwtravel-" + [guid]::NewGuid().ToString('N') + '.yaml')
    Write-TextFile $path ("uri: '" + $Uri.Replace("'", "''") + "'`r`n")
    Protect-SecretFile $path
    return $path
}
