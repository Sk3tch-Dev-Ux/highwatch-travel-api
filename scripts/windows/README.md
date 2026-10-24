# Windows scripts

Install the Travel API on a Windows machine, keep it running through reboots and crashes, and back it up. Every
script runs from **PowerShell opened as Administrator** (right-click PowerShell, Run as administrator), from the
API's folder. They work on Windows PowerShell 5.1, which every Windows Server has, and on PowerShell 7.

Put the API in a short folder of its own, for example `C:\HighwatchTravel\highwatch-travel-api`. If you
downloaded the ZIP from GitHub, unblock the files once before running anything:

```powershell
cd C:\HighwatchTravel\highwatch-travel-api
Get-ChildItem -Recurse | Unblock-File
```

| Script | Does |
|---|---|
| `install.ps1` | Installs and configures everything. Safe to run again. |
| `run-api.ps1` | Runs the API and starts it again when it stops. The scheduled task runs it; you do not. |
| `stop-api.ps1` | Stops the API. |
| `backup.ps1` | Backs the database up into a dated folder and deletes backups older than 14 days. |
| `restore.ps1` | Puts a backup back, after you type RESTORE. |
| `common.ps1`, `mongo-users.mjs` | Helpers the scripts use. |

## Install

Look first. `-WhatIf` changes nothing and lists what a real run would do:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -WhatIf
```

Then the real run. `-InstallMongo` installs MongoDB Server and MongoDB Database Tools with winget when they are
missing; leave it out if MongoDB is already installed. `-RegisterBackup` adds the nightly backup.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -InstallMongo -RegisterBackup
```

What it does, in order. Each step checks first and only changes what is missing or wrong:

1. **Node.js 22.9 or newer.** It never installs Node for you. If it is missing it stops and tells you to run
   `winget install --id OpenJS.NodeJS.LTS --exact --scope machine`, then open a new PowerShell and run it again.
2. **Packages:** `npm ci --omit=dev`. If the API is already running, it is stopped first.
3. **MongoDB:** the `MongoDB` service is set to start automatically and to restart itself after a crash.
4. **Users:** `admin` (root, for you) and `travel` (read and write on `highwatch_travel` only, for the API), with
   new random passwords. Then **authentication is turned on** and MongoDB is bound to **127.0.0.1** in
   `mongod.cfg`. The old file is kept next to it as `mongod.cfg.before-highwatch-<date>`. MongoDB restarts once.
   If this MongoDB holds other databases, the script stops before turning authentication on, because programs
   using them would be locked out. Give them a user first, or add `-AcceptOtherDatabases` if nothing else uses it.
   If authentication is already on, it asks for the admin password (it does not show while you type).
5. **`.env`:** the travel connection string, a new admin token (`npm run admin -- token`), `TRAVEL_HOST=127.0.0.1`
   and `TRAVEL_PORT=6070`. Values that already work are kept. Only Administrators and SYSTEM can read the file.
6. **Start at boot:** the scheduled task `\Highwatch\Highwatch Travel API`, at startup, as SYSTEM, whether anyone
   is logged on or not. With `-RegisterBackup`, also `\Highwatch\Highwatch Travel Backup` at 04:00 every night.
7. **Check:** starts the API, prints `/healthz`, `/readyz` and `travel-admin doctor`.

**The secrets file.** New passwords and the admin token are written to `scripts\windows\secrets-<date>.txt`, and
nowhere else except `.env`. The script never prints them. Move them into your password manager, then delete the
file. Run again later, the script keeps what works and writes a new secrets file only for what it had to change.

Other options: `-Port 6071` (another port; every server's `config.json` must use it), `-KeepDays 30` (days of logs
and backups), `-BackupRoot D:\Backups\Travel` (where backups go; another disk is better).

## Running it

| You want to | Run |
|---|---|
| Start it | `Start-ScheduledTask -TaskPath '\Highwatch\' -TaskName 'Highwatch Travel API'` |
| Stop it | `powershell -ExecutionPolicy Bypass -File .\scripts\windows\stop-api.ps1` |
| Restart it | stop, then start |
| See if it is healthy | `npm run admin -- doctor` |
| See if it answers | open http://127.0.0.1:6070/readyz on the machine: `{"status":"ok","db":"ok"}` |

**How it survives crashes and reboots.** The task starts `run-api.ps1` 30 seconds after Windows starts.
`run-api.ps1` starts node and waits. When node stops for any reason, it starts it again after 5 seconds, then
10, 20, 40 and at most 60 while it keeps stopping within a minute, and back to 5 once it has run a minute. If
`run-api.ps1` itself dies, Task Scheduler starts it again within a minute. Only one copy runs at a time.

**Logs.** Everything the API prints goes to `logs\api-<yyyy-MM-dd>.log` in the API's folder, one file a day.
Files older than 14 days are deleted. A normal start shows
`Highwatch Travel API 1.1.0 listening on 127.0.0.1:6070`. Errors are one JSON line each. No key, token, password
or request body is ever written. Each line starts with the time on this machine. Backups write one line per run
to `logs\backup.log`.

**Updates.** `stop-api.ps1`, replace the files (`git pull`, or unpack the new ZIP over the old folder, keeping
`.env`), then run `install.ps1` again: it runs `npm ci` and starts the API.

### NSSM instead of Task Scheduler

If you prefer a Windows service, NSSM (https://nssm.cc) can run `run-api.ps1` instead. Do not use both. Remove the
task first (`Unregister-ScheduledTask -TaskPath '\Highwatch\' -TaskName 'Highwatch Travel API'`), then:

```powershell
nssm install HighwatchTravel "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File C:\HighwatchTravel\highwatch-travel-api\scripts\windows\run-api.ps1"
nssm set HighwatchTravel AppDirectory C:\HighwatchTravel\highwatch-travel-api
nssm set HighwatchTravel Start SERVICE_AUTO_START
nssm start HighwatchTravel
```

`run-api.ps1` keeps writing the same logs. Stop it with `nssm stop HighwatchTravel`.

## Backups

`backup.ps1` dumps the database with `mongodump` into `C:\ProgramData\HighwatchTravel\backups\travel-<date>_<time>`
and deletes backup folders older than 14 days, only after a new backup succeeded. It signs in with the travel
user from `.env`; the password never appears on a command line. It needs MongoDB Database Tools
(`winget install --id MongoDB.DatabaseTools --exact`, or `install.ps1 -InstallMongo`).

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\backup.ps1                 # one backup now
powershell -ExecutionPolicy Bypass -File .\scripts\windows\backup.ps1 -KeepDays 30     # keep 30 days
```

`install.ps1 -RegisterBackup` runs it every night at 04:00. Check that it does: `logs\backup.log` gets an
`OK backup` line every night. Copy the backups folder somewhere off this machine now and then; a backup on the
same disk does not survive the disk.

## Restore

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\restore.ps1                 # the newest backup
powershell -ExecutionPolicy Bypass -File .\scripts\windows\restore.ps1 -From C:\ProgramData\HighwatchTravel\backups\travel-2026-10-24_0400
```

It shows the backup, asks you to type `RESTORE`, stops the API, backs up the database as it is now (a
`...-before-restore` folder, so a wrong restore can be undone), restores, starts the API and checks `/readyz`.
Add `-WhatIf` to see what it would use without changing anything.

A restore takes the ledger back to the moment of the backup. A character that travelled after it may be listed on
the server it left, and that trip is gone. Look at recent trips afterwards: `npm run admin -- character list
<network>`.
