# Endfall go-live plan: the Travel API and Travel on four servers

This is the checklist for putting Highwatch Travel live on Endfall. It goes from a cold start to the first player
trip, in order. Every step ends with a check. Do not start the next step until the check passes.

Your setup: one Windows dedicated machine runs all four DayZ servers and the Travel API.

| Server | Game port |
|---|---|
| Chernarus | 2302 |
| Nasdara | 2402 |
| Namalsk | 2502 |
| Chernobyl | 2602 |

The game servers reach the API on the same machine at `http://127.0.0.1:6070`. Nothing needs to be opened in the
firewall for it, and no HTTPS proxy is needed. Where this plan says **your server's address**, use the public IP
or host name players connect to, the same one as in the DayZ launcher.

Plan on about two hours, inside a maintenance window with the servers closed to players.

## 0. Before you start

- [ ] An Administrator account on the machine, and PowerShell opened **as Administrator** for every command below.
- [ ] The Endfall Travel delivery: the `@Endfall-Travel` mod (client and server), `Highwatch.bikey`, and the
      per-server `config.json` files.
- [ ] A password manager to hold what the install creates.
- [ ] **Back up each game server's persistence** (its `mpmissions\<mission>\storage_1` folder) and each server's
      `profiles` folder, with the servers stopped. Going live changes where characters live; this copy is your way
      back.
- [ ] Close the four servers to players for the window: set a `password` in each `serverDZ.cfg`, or your usual
      whitelist. Staff keep that password.

**Check:** you have a dated copy of all four `storage_1` folders, and a test join without the password is refused.

## 1. Prerequisites: Node.js and MongoDB

1. Check Node.js: `node -v`. It must print `v22.9.0` or newer. If it is missing or older:

   ```powershell
   winget install --id OpenJS.NodeJS.LTS --exact --scope machine
   ```

   Then close PowerShell and open a new one as Administrator.

2. MongoDB is installed by the install script in step 2 (`-InstallMongo`). If MongoDB is already on this machine
   for something else, stop here and tell us: turning on its authentication would lock that other program out,
   and the script refuses to do it without asking.

**Check:** `node -v` prints 22.9 or newer. `Get-Service MongoDB` either shows nothing (the script installs it) or
shows `Running`.

## 2. Install the Travel API

1. Put the API in its own folder, for example `C:\HighwatchTravel\highwatch-travel-api`: `git clone` the
   repository there, or download the ZIP from GitHub and unpack it there. For the ZIP, unblock the files once:

   ```powershell
   cd C:\HighwatchTravel\highwatch-travel-api
   Get-ChildItem -Recurse | Unblock-File
   ```

2. Look before you change anything. This run changes nothing:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -InstallMongo -RegisterBackup -WhatIf
   ```

   Read the `WOULD` lines. A `NOTE ... a real run stops here` line means something needs you first; it says what.

3. The real run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -InstallMongo -RegisterBackup
   ```

   It installs MongoDB and its backup tools, creates the MongoDB users, turns MongoDB authentication on and keeps
   MongoDB on 127.0.0.1, writes `.env`, and registers two scheduled tasks: the API at every startup (restarted on
   failure) and a backup every night at 04:00. Details: [scripts/windows/README.md](../scripts/windows/README.md).

4. **Move the secrets.** The script wrote `scripts\windows\secrets-<date>.txt`: the MongoDB admin and travel
   passwords and the Travel admin token. Copy them into your password manager, then delete the file.

**Check:**
- The script ended with `GET http://127.0.0.1:6070/healthz -> 200 {"status":"ok",...}` and
  `GET http://127.0.0.1:6070/readyz -> 200 {"status":"ok","db":"ok"}`.
- `npm run admin -- doctor` shows `OK` for token, mongodb (`connected as travel@highwatch_travel`), indexes and api.
  A `WARN network no network yet` is expected now.
- The console answers at http://127.0.0.1:6070/console/ and opens with the admin token from the secrets file. From
  here on, every `npm run admin` step below can be done there instead ([docs/console.md](console.md)).
- `scripts\windows\secrets-*.txt` no longer exists.
- Survives a restart: run `.\scripts\windows\stop-api.ps1`, then
  `Start-ScheduledTask -TaskPath '\Highwatch\' -TaskName 'Highwatch Travel API'`. Within a minute
  http://127.0.0.1:6070/readyz answers `{"status":"ok","db":"ok"}` again.

## 3. Set up the network

All commands run in the API's folder, in PowerShell as Administrator. Do this before the game servers start with
Travel. (The delivery's `travel\setup-network.mjs` does steps 1 to 5 in one run from `endfall-network.json`; use
either, not both.)

1. **Add the four servers.** Each prints its **key once**. Put each key in your password manager at once, labelled
   with the server's name.

   ```powershell
   npm run admin -- server add "Chernarus"
   npm run admin -- server add "Nasdara"
   npm run admin -- server add "Namalsk"
   npm run admin -- server add "Chernobyl"
   npm run admin -- server list
   ```

   `server list` shows each server's id (16 letters and digits). You need them below.

2. **Make the network:**

   ```powershell
   npm run admin -- network create "Endfall"
   ```

   It prints the network's id.

3. **Add each server to the network** with your server's address and that server's game port. This is where the
   mod sends players when they travel.

   ```powershell
   npm run admin -- member add <network id> <Chernarus id> <your server's address> 2302 "Chernarus"
   npm run admin -- member add <network id> <Nasdara id>   <your server's address> 2402 "Nasdara"
   npm run admin -- member add <network id> <Namalsk id>   <your server's address> 2502 "Namalsk"
   npm run admin -- member add <network id> <Chernobyl id> <your server's address> 2602 "Chernobyl"
   ```

4. **Routes.** One JSON file per route, for example `C:\HighwatchTravel\routes\chernarus-namalsk.json`. Add them
   **closed** (`"enabled": false`) for now; you open them in step 8. Every field is in
   [api.md, A route](api.md#a-route).

   ```json
   {
     "name": "Rail to Namalsk",
     "code": "NM",
     "from": "<Chernarus id>",
     "to": "<Namalsk id>",
     "terminal": { "x": 12989, "z": 10244, "radius": 60, "label": "Berezino station" },
     "cooldownMin": 30,
     "waitSeconds": 10,
     "enabled": false
   }
   ```

   ```powershell
   npm run admin -- route add <network id> C:\HighwatchTravel\routes\chernarus-namalsk.json
   ```

   The answer lists the route with its id. Write the id into the file as `"id": "<route id>"`: running
   `route add` again with the same file then changes that route instead of making a second one.
   A route with a money fare needs Travel 0.5.0 or later on its source server.

5. **Start server (a decision).** With a start server, a player the network has never seen is sent to it from
   any other server. Your players already have characters on several servers. If you set Chernarus now, a player
   whose character is on Nasdara is sent to Chernarus on their first join and starts there. We suggest **no start
   server at go-live**: each character then lives where its player first joins after go-live. Set one later, once
   your regulars have played:

   ```powershell
   npm run admin -- network start-server <network id> <Chernarus id>     # later
   npm run admin -- network start-server <network id> none               # undo
   ```

**Check:** `npm run admin -- network show <network id>` lists four servers with your server's address and ports
2302, 2402, 2502 and 2602 (all `offline` until step 6), and every route as `(closed)`. `npm run admin -- doctor`
shows `OK routes ... all between member servers`.

## 4. Put each server's key in its config.json

Each game server has its own profiles folder, and in it `HighwatchTravel\config.json`. Use the matching file from
the delivery (`travel\config\<World>.config.json`) and set two values in it:

```json
{
    "endpoint": "http://127.0.0.1:6070",
    "apiKey": "hwt_... (this server's key from step 3.1)",
    ...
}
```

Keep the rest of the delivery's file as it is (landing points, chat settings). Each server gets **its own** key:
Chernarus's key in Chernarus's file, and so on.

**Check:** four files, each with `endpoint` `http://127.0.0.1:6070` and an `apiKey` starting with `hwt_`, and no two
keys the same.

## 5. The mod, the key, and MapLink out

On **all four servers**:

1. Copy `@Endfall-Travel` into the server folder and add it to `-mod=` after CF and Terje. It is a client and
   server mod, never `-serverMod`.
2. Copy `Highwatch.bikey` into the server's `keys` folder.
3. **Take MapLink out**: remove `@MapLink` from `-mod=` (and `-serverMod=` if it is there). MapLink and Travel
   both decide which server a character lives on, so they must never run together. Keep MapLink's folder and its
   settings files on disk; you need them only to roll back.
4. Make the `-mod=` list **the same on all four servers**, in the same order. A DayZ client cannot change mods
   while it travels, so a player can only arrive on a server whose mods match theirs. That means the Namalsk and
   Chernobyl map mods load on all four servers.

Then the **player modpack** (launcher, collection or modlist): add `@Endfall-Travel`, remove `@MapLink`, so it
matches the servers' `-mod=` list exactly.

**Check:** put the four start commands (or launcher configs) side by side. The `-mod=` lists are identical, include
`@Endfall-Travel`, and none has `@MapLink`. Each server's `keys` folder has `Highwatch.bikey`.

## 6. First boot

Start the four servers (still closed to players).

**Check, on each server's script log** (in its profiles folder), within a minute of the mission loading:

```
[Highwatch Travel] In network Endfall as Chernarus (<id>).
[Highwatch Travel] Routes from this server: ...
[Highwatch Travel] Ledger loaded: 0 characters in the network.
```

Each server shows its own name. If instead you see:

| Line | Fix |
|---|---|
| `No endpoint or apiKey in ...` | Step 4: the file is missing a value, or it is in the wrong profiles folder. |
| `The apiKey in ... is not a Travel API key` | The key must start with `hwt_`. Use the one from step 3.1. |
| `This server is not in a travel network yet` | Step 3.3: that server is not a member. |

Then on the API: `npm run admin -- doctor` shows four `OK server ... online, last beat ... s ago, mod <version>`
lines, all with **the same mod version**, and no `FAIL` line.

## 7. A staff-only test trip

With the servers still closed to players:

1. Join Chernarus with a staff account. Note your Steam64 id.
2. Send yourself (this ignores routes, so the closed routes do not matter):

   ```powershell
   npm run admin -- send <network id> <your steam64> <Namalsk id>
   ```

3. In game: you freeze, the screen fades, and DayZ connects you to Namalsk on its own. You wake there with what you
   carried.
4. Open one route for the test (set `"enabled": true` in its file, then `route add` again), use the departures
   board at its terminal, take the trip, and close the route again (`"enabled": false`, `route add`).
5. Take a route or a send back to Chernarus.

**Check:** `npm run admin -- character show <network id> <your steam64>` lists `departed` and `arrived` for each
trip, every transfer `landed`, and `held` is empty (or lists items a server has no class for). Your gear arrived.
`npm run admin -- doctor` shows `OK transfers no trip is past its transit time`.

## 8. Open to players

1. Open the routes you want: set `"enabled": true` in each file and run `route add` again for each.
2. Remove the maintenance password (or whitelist) and restart the servers.
3. Tell players: **join the server you last played on first.** That is where their character is; Travel records it
   there on that first join. Players see the routes at the departures boards, or with `!routes` in chat.

**Check:** during the first hour, `npm run admin -- doctor` every 15 minutes shows four servers online and no
`FAIL`. A `WARN transfers ... past the transit time` line names a trip nobody claimed; it usually clears itself
when the server the player left takes the character back.

## 9. Backups

The install registered `\Highwatch\Highwatch Travel Backup`, every night at 04:00, into
`C:\ProgramData\HighwatchTravel\backups`, keeping 14 days.

1. Run one now: `powershell -ExecutionPolicy Bypass -File .\scripts\windows\backup.ps1`.
2. Once a week, copy the backups folder to another machine or cloud storage. A backup on the same disk does not
   survive the disk.

**Check:** `logs\backup.log` in the API's folder has an `OK backup ...` line for tonight, and again tomorrow
morning. `restore.ps1` is how a backup goes back ([scripts/windows/README.md](../scripts/windows/README.md#restore)).

## 10. Rolling back

If Travel must come out, in this order:

1. Close the servers to players.
2. Stop the API: `powershell -ExecutionPolicy Bypass -File .\scripts\windows\stop-api.ps1`, then stop it starting
   at boot: `Disable-ScheduledTask -TaskPath '\Highwatch\' -TaskName 'Highwatch Travel API'`.
3. On all four servers and in the player modpack: take `@Endfall-Travel` out of `-mod=`, put `@MapLink` back as it
   was.
4. Start the servers and check MapLink's own log lines as before.

What players keep: each server still has the bodies it saved. A character that travelled with Travel is on the
server it arrived on, and MapLink's records are from before go-live, so some players may find an older body. For
a full return to the moment before go-live, also put back the `storage_1` copies from step 0 (servers stopped);
every change since then is lost. The Travel database stays untouched, so Travel can be turned on again later.

**Check:** each server's log has no `[Highwatch Travel]` line, and MapLink works on a staff test.

## 11. When something fails: what to send us

Collect these, for the minutes around the problem:

- [ ] When it happened, with your time zone, and the player's Steam64 id.
- [ ] Which servers: where the player was and where they were going.
- [ ] The `[Highwatch Travel]` lines from both servers' script logs.
- [ ] The API's log for that day: `logs\api-<date>.log` in the API's folder.
- [ ] `npm run admin -- doctor` output.
- [ ] `npm run admin -- character show <network id> <steam64>` output.
- [ ] What the player saw on screen (a screenshot helps).

**Never send** `.env`, the secrets file, any server's `apiKey`, the admin token or MongoDB passwords. None of the
items above contain them. If a key leaked, make a new one with `npm run admin -- server rotate <server id>` and put
it in that server's `config.json`.
