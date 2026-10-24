# Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
<#
.SYNOPSIS
Installs the Highwatch Travel API on this Windows machine and keeps it running.

.DESCRIPTION
Run from PowerShell opened as Administrator. Safe to run again: every step checks what is already there first and
only changes what is missing or wrong. With -WhatIf it changes nothing and says what it would do.

What it does, in order:
  1. Checks Node.js 22.9 or newer (it never installs Node for you).
  2. Stops the API if an earlier install runs it, then runs npm ci --omit=dev.
  3. Checks the MongoDB service. With -InstallMongo it installs MongoDB Server and the backup tools with winget.
  4. Creates the MongoDB users admin (root) and travel (readWrite on highwatch_travel) with new random passwords,
     then turns on authentication and binds MongoDB to 127.0.0.1 in mongod.cfg (backing the old file up first).
  5. Writes .env: the travel connection string, an admin token, 127.0.0.1 and the port.
  6. Registers the scheduled task "Highwatch Travel API": at startup, as SYSTEM, restarted on failure. With
     -RegisterBackup also "Highwatch Travel Backup", every night at 04:00.
  7. Starts the API and prints /healthz, /readyz and travel-admin doctor.

New passwords and tokens go only into .env and into secrets-<date>.txt next to this script. Move that file's
contents into your password manager, then delete it. Nothing secret is printed.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -WhatIf

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -InstallMongo -RegisterBackup
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Install MongoDB Server and MongoDB Database Tools with winget when they are missing.
    [switch]$InstallMongo,
    # Also register the nightly backup task (04:00).
    [switch]$RegisterBackup,
    # The port the API listens on, on 127.0.0.1.
    [int]$Port = 6070,
    [string]$Database = 'highwatch_travel',
    [string]$MongoService = 'MongoDB',
    [string]$MongoAdminUser = 'admin',
    [string]$BackupRoot = (Join-Path $env:ProgramData 'HighwatchTravel\backups'),
    # Days of API logs and of backups to keep.
    [int]$KeepDays = 14,
    # Turn on MongoDB authentication even though other databases are on this MongoDB (their programs then need
    # a user too).
    [switch]$AcceptOtherDatabases
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$Root = $script:TravelRoot
$script:DryRun = [bool]$WhatIfPreference
$TokenFormat = '^[A-Za-z0-9_-]{43,128}$'

function Invoke-Change([string]$What, [scriptblock]$Action) {
    if ($script:DryRun) { Write-Plan $What; return $null }
    Write-Host "   ...   $What"
    return (& $Action)
}

# Runs scripts\windows\mongo-users.mjs with the given environment variables and answers its JSON line.
function Invoke-MongoHelper([string]$Mode, [hashtable]$Vars) {
    $helper = Join-Path $PSScriptRoot 'mongo-users.mjs'
    $old = @{}
    foreach ($k in $Vars.Keys) { $old[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, [string]$Vars[$k], 'Process') }
    try { $out = & $script:Node $helper $Mode } finally { foreach ($k in $Vars.Keys) { [Environment]::SetEnvironmentVariable($k, $old[$k], 'Process') } }
    $last = @($out | Where-Object { $_ -and $_.Trim().StartsWith('{') }) | Select-Object -Last 1
    if (-not $last) { throw "The MongoDB helper ($Mode) gave no answer." }
    return ($last | ConvertFrom-Json)
}

function Read-Secret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Wait-Mongo([int]$MongoPort, [int]$Seconds = 60) {
    for ($i = 0; $i -lt $Seconds; $i++) { if (Test-TcpPort '127.0.0.1' $MongoPort 1000) { return $true }; Start-Sleep -Seconds 1 }
    return $false
}

Write-Host "Highwatch Travel API install, folder $Root"
if ($script:DryRun) { Write-Note 'Dry run (-WhatIf): nothing on this machine changes. WOULD lines are what a real run does.' }

# --- 1. Administrator and Node.js -------------------------------------------------------------------------
Write-Step 'Administrator'
if (Test-IsAdministrator) { Write-Ok 'running as Administrator' }
elseif ($script:DryRun) { Write-Note 'not running as Administrator. Fine for a dry run; the real install needs it.' }
else { throw 'Run this from PowerShell opened as Administrator (right-click PowerShell, Run as administrator).' }

Write-Step 'Node.js'
$script:Node = Find-Node
if (-not $script:Node) {
    throw "Node.js is not installed. Install Node.js 22.9 or newer with:`n    winget install --id OpenJS.NodeJS.LTS --exact --scope machine`nor from https://nodejs.org. Then close this window, open a new PowerShell as Administrator and run install.ps1 again."
}
$nodeVersionText = (& $script:Node -v | Out-String).Trim().TrimStart('v')
$nodeVersion = [version]($nodeVersionText -replace '[^0-9.].*$', '')
if ($nodeVersion -lt [version]'22.9') {
    throw "Node.js $nodeVersionText is too old; the API needs 22.9 or newer. Upgrade with:`n    winget upgrade --id OpenJS.NodeJS.LTS --exact`nthen open a new PowerShell as Administrator and run install.ps1 again."
}
$npm = Join-Path (Split-Path -Parent $script:Node) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) { $c = Get-Command npm.cmd -ErrorAction SilentlyContinue; if ($c) { $npm = $c.Source } else { throw 'npm is missing next to node.exe. Reinstall Node.js.' } }
Write-Ok "Node.js $nodeVersionText at $($script:Node)"
if ($script:Node -like "$env:SystemDrive\Users\*") { Write-Note "Node.js is installed for one user only. The API task runs as SYSTEM and can still use it, but a machine-wide install is safer: winget install --id OpenJS.NodeJS.LTS --exact --scope machine" }

# --- 2. Packages --------------------------------------------------------------------------------------------
Write-Step 'API packages'
$task = Get-ScheduledTask -TaskPath $script:ApiTaskPath -TaskName $script:ApiTaskName -ErrorAction SilentlyContinue
$running = @(Get-ApiProcess $Root)
if (($task -and $task.State -eq 'Running') -or $running.Count) {
    Invoke-Change 'stop the running API while its packages are replaced' { & (Join-Path $PSScriptRoot 'stop-api.ps1') | Out-Null }
}
Invoke-Change 'run npm ci --omit=dev' {
    Push-Location $Root
    try { & $npm ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)." } } finally { Pop-Location }
}
$haveModules = Test-Path -LiteralPath (Join-Path $Root 'node_modules\mongodb')
if ($haveModules) { Write-Ok 'packages installed' } elseif ($script:DryRun) { Write-Note 'no node_modules yet, so the dry run cannot look inside MongoDB.' }

# --- 3. MongoDB service -------------------------------------------------------------------------------------
Write-Step 'MongoDB'
$svc = Get-MongoService $MongoService
$winget = Get-Command winget.exe -ErrorAction SilentlyContinue
if (-not $svc) {
    if (-not $InstallMongo) { throw "MongoDB Server is not installed (there is no '$MongoService' service). Run install.ps1 -InstallMongo to install it with winget, or install it yourself (docs/mongodb-setup.md), then run install.ps1 again." }
    if (-not $winget) { throw 'winget is not available on this machine. Install MongoDB Server from https://www.mongodb.com/try/download/community (MSI, "Run service as Network Service user"), then run install.ps1 again.' }
    Invoke-Change 'install MongoDB Server with winget (MongoDB.Server)' {
        & $winget.Source install --id MongoDB.Server --exact --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw "winget could not install MongoDB Server (exit $LASTEXITCODE)." }
    }
    $svc = Get-MongoService $MongoService
    if (-not $svc -and -not $script:DryRun) { throw "MongoDB Server installed, but there is no '$MongoService' service. Open a new PowerShell as Administrator and run install.ps1 again." }
}
if (-not (Find-MongoTool 'mongodump')) {
    if ($InstallMongo -and $winget) {
        Invoke-Change 'install MongoDB Database Tools with winget (MongoDB.DatabaseTools), for backups' {
            & $winget.Source install --id MongoDB.DatabaseTools --exact --silent --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) { Write-Note "winget could not install MongoDB Database Tools (exit $LASTEXITCODE). Backups need them." }
        }
    } else { Write-Note 'MongoDB Database Tools (mongodump) are not installed. Backups need them: winget install --id MongoDB.DatabaseTools --exact' }
} else { Write-Ok "backup tools found: $(Find-MongoTool 'mongodump')" }

$cfgPath = ''
$cfgText = ''
$newCfg = ''
$mongoPort = 27017
$authInCfg = $false
if ($svc) {
    Write-Ok "service $($svc.Name): $($svc.State), start mode $($svc.StartMode)"
    if ($svc.StartMode -ne 'Auto') { Invoke-Change "set the $MongoService service to start automatically" { Set-Service -Name $MongoService -StartupType Automatic } }
    Invoke-Change "set the $MongoService service to restart itself after a crash" { $null = & sc.exe failure $MongoService reset= 86400 actions= restart/5000/restart/10000/restart/60000; if ($LASTEXITCODE -ne 0) { throw "sc.exe failure exit $LASTEXITCODE" } }
    if ($svc.State -ne 'Running') { Invoke-Change "start the $MongoService service" { Start-Service -Name $MongoService } }
    $cfgPath = $svc.Config
    if (-not $cfgPath -or -not (Test-Path -LiteralPath $cfgPath)) { throw "Could not find mongod.cfg from the service's command line: $($svc.PathName)" }
    $cfgText = [System.IO.File]::ReadAllText($cfgPath)
    $mongoPort = Get-MongoCfgPort $cfgText
    $newCfg = Update-MongoCfgText $cfgText
    $authInCfg = ($cfgText -eq $newCfg) -or ($cfgText -match '(?m)^\s+authorization\s*:\s*enabled')
    Write-Ok "config $cfgPath, port $mongoPort"
    if ($cfgText -eq $newCfg) { Write-Ok 'mongod.cfg already has authorization enabled and bindIp 127.0.0.1' }
    else {
        $before = $cfgText -split "\r?\n"
        foreach ($l in ($newCfg -split "\r?\n")) { if ($before -notcontains $l) { Write-Host "          mongod.cfg will have: $l" } }
    }
    if (-not $script:DryRun -and -not (Wait-Mongo $mongoPort 60)) { throw "MongoDB does not answer on 127.0.0.1:$mongoPort. Look at its log (systemLog.path in $cfgPath)." }
}

# --- 4. Users, authentication -------------------------------------------------------------------------------
Write-Step 'MongoDB users and authentication'
$envPath = Join-Path $Root '.env'
$dotenv = Read-DotEnv $envPath
$envValues = @{}
$secrets = New-Object System.Collections.Generic.List[string]
$travelUrl = ''
$needRestart = $false
$canProbe = $haveModules -and $svc -and (Test-TcpPort '127.0.0.1' $mongoPort 1000)

# An admin token, made by the repository's own generator, when .env has no valid one.
$token = ''
if ($dotenv['TRAVEL_ADMIN_TOKEN'] -match $TokenFormat) { Write-Ok '.env already has an admin token; keeping it' }
elseif ($haveModules) {
    Push-Location $Root
    try { $token = (& $npm run --silent admin '--' token | Out-String).Trim() } finally { Pop-Location }
    if ($token -notmatch $TokenFormat) { throw 'npm run admin -- token did not print a token.' }
} else { Write-Plan 'make an admin token with npm run admin -- token' }

$existing = $dotenv['TRAVEL_MONGO_URL']
$urlWorks = $false
if ($existing -and $existing -notmatch 'CHANGE_ME' -and $canProbe) {
    $r = Invoke-MongoHelper 'check' @{ HW_URL = $existing; HW_DB = $Database }
    if ($r.ok -and $r.authenticated) { $urlWorks = $true; Write-Ok ".env's connection string signs in as $($r.users -join ', ') and may write $Database; keeping it" }
    elseif ($r.ok) { Write-Note ".env's connection string has no user; making the travel user" }
    else { Write-Note ".env's connection string does not work ($($r.error)); setting a new travel password" }
}

$probe = $null
if ($canProbe) {
    $probe = Invoke-MongoHelper 'probe' @{ HW_MONGO_PORT = $mongoPort; HW_DB = $Database; HW_ADMIN_USER = $MongoAdminUser }
    if (-not $probe.reachable) { throw "Cannot reach MongoDB on 127.0.0.1:$($mongoPort): $($probe.error)" }
    if ($probe.authRequired) { Write-Ok 'authentication is already on' }
    else {
        Write-Ok 'authentication is off; this run turns it on'
        if ($authInCfg) { $needRestart = $true }
        # Turning authentication on locks out every other program that uses this MongoDB without a user.
        $others = @($probe.databases | Where-Object { @('admin', 'config', 'local', $Database) -notcontains $_ })
        if ($others.Count -and -not $AcceptOtherDatabases) {
            $msg = "This MongoDB also holds other databases: $($others -join ', '). Turning on authentication locks out any program that uses them without a user. Give those programs a user first, or run install.ps1 again with -AcceptOtherDatabases if nothing else uses this MongoDB."
            if ($script:DryRun) { Write-Note "a real run stops here. $msg" } else { throw $msg }
        }
    }
}

if (-not $urlWorks -and $canProbe) {
    $travelPassword = New-StrongPassword
    $adminPassword = ''
    $authPassword = ''
    if (-not $probe.authRequired) {
        if ($probe.adminUser) { Write-Ok "MongoDB user $MongoAdminUser exists; keeping it and its password" } else { $adminPassword = New-StrongPassword }
        if ($probe.travelUser) { Write-Ok 'MongoDB user travel exists; it gets a new password' }
    } else {
        # Authentication on and no user yet: MongoDB lets this machine make the first one. Otherwise ask.
        $adminPassword = New-StrongPassword
    }
    $travelUrl = "mongodb://travel:$travelPassword@127.0.0.1:$mongoPort/$($Database)?authSource=$Database"
    $vars = @{ HW_MONGO_PORT = $mongoPort; HW_DB = $Database; HW_ADMIN_USER = $MongoAdminUser; HW_TRAVEL_PASSWORD = $travelPassword; HW_NEW_ADMIN_PASSWORD = $adminPassword }
    if ($script:DryRun) {
        if ($adminPassword) { Write-Plan "create the MongoDB user $MongoAdminUser (root) with a new random password" }
        Write-Plan "create the MongoDB user travel (readWrite on $Database) with a new random password, or give the existing one a new password"
    } else {
        $result = Invoke-MongoHelper 'ensure' $vars
        if (-not $result.ok -and $result.code -eq 'needAdmin') {
            Write-Note "MongoDB asks for a sign-in. Type the password of its user '$MongoAdminUser' (nothing shows while you type)."
            $authPassword = Read-Secret "Password of MongoDB user $MongoAdminUser"
            $vars['HW_NEW_ADMIN_PASSWORD'] = ''
            $vars['HW_AUTH_PASSWORD'] = $authPassword
            $result = Invoke-MongoHelper 'ensure' $vars
            $vars['HW_AUTH_PASSWORD'] = ''
            $authPassword = ''
        }
        if (-not $result.ok) { throw "Could not set up the MongoDB users: $($result.error)" }
        if ($result.admin -eq 'created') {
            Write-Ok "MongoDB user $MongoAdminUser created"
            $secrets.Add("MongoDB administrator (root). For backups by hand, Compass, upgrades.")
            $secrets.Add("  user:       $MongoAdminUser")
            $secrets.Add("  password:   $adminPassword")
            $secrets.Add("  connection: mongodb://$($MongoAdminUser):$adminPassword@127.0.0.1:$mongoPort/?authSource=admin")
            $secrets.Add('')
        }
        Write-Ok "MongoDB user travel $($result.travel)"
        $secrets.Add("MongoDB travel user (the API signs in with it; it is also in .env as TRAVEL_MONGO_URL).")
        $secrets.Add('  user:       travel')
        $secrets.Add("  password:   $travelPassword")
        $secrets.Add("  connection: $travelUrl")
        $secrets.Add('')
        $envValues['TRAVEL_MONGO_URL'] = $travelUrl
    }
} elseif (-not $urlWorks) {
    Write-Plan "create the MongoDB users $MongoAdminUser and travel, and put the travel connection string in .env"
}

if ($token) {
    $envValues['TRAVEL_ADMIN_TOKEN'] = $token
    $secrets.Add('Travel API admin token (TRAVEL_ADMIN_TOKEN in .env; the password to the owner API /v1).')
    $secrets.Add("  token:      $token")
    $secrets.Add('')
}

# The secrets file, written before anything else uses the new values so no password can be lost.
if ($secrets.Count) {
    $secretsPath = Join-Path $PSScriptRoot ('secrets-' + (Get-Date -Format 'yyyy-MM-dd') + '.txt')
    $head = "Highwatch Travel API secrets, written by install.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm') on $env:COMPUTERNAME.`r`nMove them into your password manager, then delete this file.`r`n`r`n"
    Invoke-Change "write the new passwords and token to $secretsPath (only Administrators can read it)" {
        if (Test-Path -LiteralPath $secretsPath) { Add-TextFile $secretsPath ("`r`n" + $head + ($secrets -join "`r`n") + "`r`n") }
        else { Write-TextFile $secretsPath ($head + ($secrets -join "`r`n") + "`r`n"); Protect-SecretFile $secretsPath }
    }
}

# mongod.cfg: authentication on and 127.0.0.1 only. The users exist by now, so turning it on locks nobody out.
if ($svc -and $cfgText -ne $newCfg) {
    $cfgBackup = "$cfgPath.before-highwatch-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Invoke-Change "back up mongod.cfg to $cfgBackup and write authorization enabled, bindIp 127.0.0.1" {
        Copy-Item -LiteralPath $cfgPath -Destination $cfgBackup
        Write-TextFile $cfgPath $newCfg
    }
    $needRestart = $true
}
if ($needRestart) {
    Invoke-Change "restart the $MongoService service so the config takes effect" {
        Restart-Service -Name $MongoService -Force
        if (-not (Wait-Mongo $mongoPort 90)) { throw "MongoDB did not come back on 127.0.0.1:$mongoPort after the restart. Its log is at systemLog.path in $cfgPath. The old config is at $cfgBackup." }
    }
}

# --- 5. .env --------------------------------------------------------------------------------------------------
Write-Step '.env'
$envValues['TRAVEL_HOST'] = '127.0.0.1'
$envValues['TRAVEL_PORT'] = [string]$Port
if (-not $dotenv.ContainsKey('TRAVEL_TRUST_PROXY')) { $envValues['TRAVEL_TRUST_PROXY'] = '0' }
$envText = ''
if (Test-Path -LiteralPath $envPath) { $envText = [System.IO.File]::ReadAllText($envPath) }
elseif (Test-Path -LiteralPath (Join-Path $Root '.env.example')) { $envText = [System.IO.File]::ReadAllText((Join-Path $Root '.env.example')) }
$newEnv = Set-DotEnvText $envText $envValues
if ((Test-Path -LiteralPath $envPath) -and $newEnv -eq $envText) { Write-Ok '.env is up to date' }
else {
    $keys = ($envValues.Keys | Sort-Object) -join ', '
    Invoke-Change "write $envPath ($keys; only Administrators and SYSTEM can read it)" { Write-TextFile $envPath $newEnv; Protect-SecretFile $envPath }
}

# Check the final connection string against the restarted MongoDB: signed in, and authentication enforced.
if (-not $script:DryRun -and $haveModules -and $svc) {
    $finalUrl = (Read-DotEnv $envPath)['TRAVEL_MONGO_URL']
    $r = Invoke-MongoHelper 'check' @{ HW_URL = $finalUrl; HW_DB = $Database }
    if (-not ($r.ok -and $r.authenticated)) { throw "The travel connection string in .env does not sign in: $($r.error). Run install.ps1 again; it sets a new travel password." }
    Write-Ok "the API signs in as $($r.users -join ', ')"
    $p = Invoke-MongoHelper 'probe' @{ HW_MONGO_PORT = $mongoPort; HW_DB = $Database; HW_ADMIN_USER = $MongoAdminUser }
    if ($p.authRequired) { Write-Ok 'MongoDB refuses connections without a user' } else { Write-Note "MongoDB still accepts connections without a user. Check that $cfgPath has security: authorization: enabled, then Restart-Service $MongoService." }
}

# --- 6. Scheduled tasks -----------------------------------------------------------------------------------------
Write-Step 'Start at boot'
$logs = Join-Path $Root 'logs'
if (-not (Test-Path -LiteralPath $logs)) { Invoke-Change "create the log folder $logs" { $null = New-Item -ItemType Directory -Path $logs } }
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$runApi = Join-Path $PSScriptRoot 'run-api.ps1'
$apiArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runApi`" -NodePath `"$($script:Node)`" -KeepDays $KeepDays"
Invoke-Change "register the task $($script:ApiTaskPath)$($script:ApiTaskName): at startup, as SYSTEM, restart every minute on failure, runs $runApi" {
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $apiArgs -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT30S'
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Priority 4
    $null = Register-ScheduledTask -TaskPath $script:ApiTaskPath -TaskName $script:ApiTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Highwatch Travel API. Logs in the logs folder of the API. Stop with scripts\windows\stop-api.ps1.' -Force
}
if ($RegisterBackup) {
    $backupArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'backup.ps1')`" -BackupRoot `"$BackupRoot`" -KeepDays $KeepDays"
    if (-not (Test-Path -LiteralPath $BackupRoot)) { Invoke-Change "create the backup folder $BackupRoot (only Administrators and SYSTEM can read it)" { $null = New-Item -ItemType Directory -Path $BackupRoot -Force; Protect-SecretFolder $BackupRoot } }
    Invoke-Change "register the task $($script:ApiTaskPath)$($script:BackupTaskName): every night at 04:00, as SYSTEM, into $BackupRoot, keeps $KeepDays days" {
        $action = New-ScheduledTaskAction -Execute $powershell -Argument $backupArgs -WorkingDirectory $Root
        $trigger = New-ScheduledTaskTrigger -Daily -At '04:00'
        # Local time with no zone, so it stays 04:00 across daylight saving changes.
        $trigger.StartBoundary = (Get-Date -Hour 4 -Minute 0 -Second 0).ToString('yyyy-MM-ddTHH:mm:ss')
        $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
        $null = Register-ScheduledTask -TaskPath $script:ApiTaskPath -TaskName $script:BackupTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Highwatch Travel nightly MongoDB backup (scripts\windows\backup.ps1).' -Force
    }
}

# --- 7. Start and check ---------------------------------------------------------------------------------------
Write-Step 'Start and check'
if ((Test-TcpPort '127.0.0.1' $Port 1000) -and -not (Get-ApiProcess $Root).Count) {
    Write-Note "something that is not this API already listens on port $Port. Stop it, or run install.ps1 -Port <another port> (and use that port in every config.json)."
}
Invoke-Change "start the task $($script:ApiTaskName)" { Start-ScheduledTask -TaskPath $script:ApiTaskPath -TaskName $script:ApiTaskName }
$base = "http://127.0.0.1:$Port"
if ($script:DryRun) {
    Write-Plan "wait for $base/healthz and $base/readyz, then run travel-admin doctor"
} else {
    $health = @{ Status = 0; Body = '' }
    for ($i = 0; $i -lt 60; $i++) { $health = Get-Http "$base/healthz" 2000; if ($health.Status -eq 200) { break }; Start-Sleep -Seconds 1 }
    $ready = Get-Http "$base/readyz" 5000
    Write-Host "   GET $base/healthz  ->  $($health.Status) $($health.Body)"
    Write-Host "   GET $base/readyz   ->  $($ready.Status) $($ready.Body)"
    if ($health.Status -eq 200 -and $ready.Status -eq 200) { Write-Ok 'the API is up and reaches its database' }
    else { Write-Note "the API is not answering yet. Its log is in $logs (api-<date>.log)." }
    Write-Host ''
    Write-Host '   travel-admin doctor:'
    Push-Location $Root
    try { & $script:Node "--env-file=$envPath" (Join-Path $Root 'bin\travel-admin.mjs') doctor | ForEach-Object { Write-Host "   $_" } } finally { Pop-Location }
}

Write-Host ''
if ($secrets.Count -and -not $script:DryRun) {
    Write-Host "New passwords and the admin token are in $secretsPath" -ForegroundColor Yellow
    Write-Host 'Move them into your password manager now, then delete that file.' -ForegroundColor Yellow
}
Write-Host "Game servers on this machine use the endpoint http://127.0.0.1:$Port"
Write-Host 'Next: set up the network with npm run admin (docs/endfall-install-plan.md, or README.md "Set up your network").'
