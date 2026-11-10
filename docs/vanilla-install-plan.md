# Go-live plan: Travel between the four vanilla maps

This is the checklist for one character across Chernarus, Livonia, Sakhal and Nasdara, on vanilla servers. It goes
from a cold start to the first player trip, in order. Every step ends with a check. Do not start the next step
until the check passes.

The servers stay vanilla: Travel needs no Community Framework, no Terje and no Expansion (mod 0.8.0 or later). It
is still a mod, on the servers and on every player's game, so the servers show as modded in the launcher.

Your setup: one Windows dedicated machine runs all four DayZ servers and the Travel API.

| Server | Map | Game port (example) | Needs |
|---|---|---|---|
| Chernarus | `chernarusplus` | 2302 | the base game |
| Livonia | `enoch` | 2402 | the base game |
| Sakhal | `sakhal` | 2502 | the Frostline DLC |
| Nasdara | `nasdara` | 2602 | the Badlands DLC |

The ports are examples. Use your servers' own game ports wherever this plan shows one. The game servers reach the
API on the same machine at `http://127.0.0.1:6070`, so nothing is opened in the firewall for it and no HTTPS proxy
is needed. Where this plan says **your server's address**, use the public IP or host name players connect to, the
same one as in the DayZ launcher.

Plan on about an hour and a half, with the servers closed to players.

## What players need

- **The mod.** Travel is a client and server mod. Every player loads `@Highwatch-Travel`, the same build as the
  servers, or the server refuses them.
- **The DLC for the map they travel to.** Sakhal belongs to Frostline and Nasdara to Badlands. A player without a
  DLC can play and travel between the other maps. Travel reads what the player's own game says: a route to a map
  they cannot enter shows `DLC` on the departures board and cannot be taken, and a staff send there is refused. The
  character never leaves for a server its player cannot join.

## 0. Before you start

- [ ] An Administrator account on the machine, and PowerShell opened **as Administrator** for every command below.
- [ ] The `@Highwatch-Travel` mod, 0.8.0 or later: its `Addons` folder with the signed PBO, and `keys\Highwatch.bikey`.
- [ ] A password manager to hold what the install creates.
- [ ] If the servers already have players: **back up each server's persistence** (its
      `mpmissions\<mission>\storage_1` folder) and each server's `profiles` folder, with the servers stopped. Going
      live changes where characters live; this copy is your way back.
- [ ] Close the four servers to players for the window: set a `password` in each `serverDZ.cfg`. Staff keep it.

**Check:** a test join without the password is refused. With existing players, you have a dated copy of all four
`storage_1` folders.

## 1. Node.js and MongoDB

1. Check Node.js: `node -v`. It must print `v22.9.0` or newer. If it is missing or older:

   ```powershell
   winget install --id OpenJS.NodeJS.LTS --exact --scope machine
   ```

   Then close PowerShell and open a new one as Administrator.

2. MongoDB is installed by the script in step 2 (`-InstallMongo`). If MongoDB is already on this machine for
   something else, stop and read [scripts/windows/README.md](../scripts/windows/README.md) first: turning on its
   authentication would lock that other program out, and the script refuses to do it without asking.

**Check:** `node -v` prints 22.9 or newer. `Get-Service MongoDB` either shows nothing (the script installs it) or
shows `Running`.

## 2. Install the Travel API

1. Put the API in its own folder, for example `C:\HighwatchTravel\highwatch-travel-api`: `git clone` this
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
- The console answers at http://127.0.0.1:6070/console/ and opens with the admin token from the secrets file.
- `scripts\windows\secrets-*.txt` no longer exists.
- It survives a restart: run `.\scripts\windows\stop-api.ps1`, then
  `Start-ScheduledTask -TaskPath '\Highwatch\' -TaskName 'Highwatch Travel API'`. Within a minute
  http://127.0.0.1:6070/readyz answers `{"status":"ok","db":"ok"}` again.

## 3. Set up the network

One file describes the network, and one command sets it up.

1. Copy `examples\vanilla\network.json` to a folder of its own, for example `C:\HighwatchTravel\network\network.json`.
   Open it and set:
   - `"network"`: your community's name. Players see it on the departures board.
   - `"address"`: your server's address. The script stops while it says `SET_ME`.
   - each server's `"port"`: that server's game port.
   - `"admins"`: the Steam64 ids of the staff who may open the in-game admin panel (step 8). It can stay empty.

2. From the API's folder, look first, then run it:

   ```powershell
   npm run setup -- C:\HighwatchTravel\network\network.json --check
   npm run setup -- C:\HighwatchTravel\network\network.json
   ```

   It registers the four servers, makes the network, adds each server with your address and its port, adds the
   twelve routes **closed**, and writes one config file per server into `C:\HighwatchTravel\network\config\`. Each
   file holds that server's key. The script never prints a key. Keep those files as you keep passwords.
   It is safe to run again after you change the file: nothing is made twice, and the keys stay as they are.

3. **Start server (a decision).** With a start server, a player the network has never seen is sent to it from any
   other server. The example sets none: each character lives on the server its player first joins. If you want
   everyone to start on one map, name **Chernarus or Livonia** in `"startServer"` and run the setup again. Never
   Sakhal or Nasdara: a player without that DLC could not join the server they were sent to.

**Check:** the script ended with `Done.` `npm run admin -- network list` shows your network; then
`npm run admin -- network show <network id>` lists four servers with your address and ports (all `offline` until
step 6) and twelve routes, every one `(closed)`. `npm run admin -- doctor` shows
`OK routes ... all between member servers`.

## 4. Put each server's config in place

Each game server has its own profiles folder (its `-profiles=` folder). Copy that server's file from
`C:\HighwatchTravel\network\config\` to `HighwatchTravel\config.json` inside it:

| From | To |
|---|---|
| `config\Chernarus.config.json` | `<Chernarus profiles>\HighwatchTravel\config.json` |
| `config\Livonia.config.json` | `<Livonia profiles>\HighwatchTravel\config.json` |
| `config\Sakhal.config.json` | `<Sakhal profiles>\HighwatchTravel\config.json` |
| `config\Nasdara.config.json` | `<Nasdara profiles>\HighwatchTravel\config.json` |

Make the `HighwatchTravel` folder if it is not there yet. Each server gets **its own** file: the keys differ.

**Check:** four `config.json` files, each with `"endpoint": "http://127.0.0.1:6070"` and an `"apiKey"` starting
with `hwt_`, and no two keys the same.

## 5. The mod and its key

On **all four servers**:

1. Copy the `@Highwatch-Travel` folder into the server folder and add it to `-mod=`. It is a client and server
   mod, never `-serverMod`.
2. Copy `Highwatch.bikey` into the server's `keys` folder.
3. Make the `-mod=` list **the same on all four servers**, in the same order. A DayZ client cannot change mods
   while it travels, so a player can only arrive on a server whose mods match theirs. With no other mod, the whole
   list is `-mod=@Highwatch-Travel`. If you add another client mod later, it goes on all four.

Then the players: they load `@Highwatch-Travel` too, the same build.

**Check:** put the four start commands (or launcher configs) side by side. The `-mod=` lists are identical and
include `@Highwatch-Travel`. Each server's `keys` folder has `Highwatch.bikey`.

## 6. First boot

Start the four servers (still closed to players).

**Check, on each server's script log** (`script_<date>.log` in its profiles folder), within a minute of the
mission loading:

```
[Highwatch Travel] 0.8.0 started on chernarusplus, Terje none.
[Highwatch Travel] In network <your network> as Chernarus (<id>).
[Highwatch Travel] Routes from this server: 3.
[Highwatch Travel] Ledger loaded: 0 characters in the network.
```

Each server shows its own map and name. `Terje none` is right for a vanilla server. If instead you see:

| Line | Fix |
|---|---|
| no `[Highwatch Travel]` line at all | Step 5: the mod is not in `-mod=`, or the folder is not in the server folder. |
| `No endpoint or apiKey in ...` | Step 4: the file is missing, or it is in the wrong profiles folder. |
| `The apiKey in ... is not a Travel API key` | The key must start with `hwt_`. Use the file from step 3. |
| `This server is not in a travel network yet` | Step 3: run the setup again and read what it says for that server. |

Then on the API: `npm run admin -- doctor` shows four `OK server ... online, last beat ... s ago, mod 0.8.0` lines,
all with **the same mod version**, and no `FAIL` line.

## 7. A staff-only test trip

With the servers still closed to players:

1. Join Chernarus with a staff account. Note your Steam64 id.
2. Send yourself (this ignores routes, so the closed routes do not matter):

   ```powershell
   npm run admin -- send <network id> <your steam64> <Livonia id>
   ```

3. In game: you freeze, the screen fades, and DayZ connects you to Livonia on its own. You wake at Topolin station
   with what you carried.
4. Open one route for the test: in the console (http://127.0.0.1:6070/console/, Routes), open **To Chernarus**
   from Livonia. At Topolin station the prompt shows **Departures**: open the board, hold Go, and travel. Close
   the route again.
5. If your account has the DLCs, send yourself to Sakhal and to Nasdara the same way, and back.

**Check:** `npm run admin -- character show <network id> <your steam64>` lists `departed` and `arrived` for each
trip, every transfer `landed`, and `held` is empty. Your gear arrived. `npm run admin -- doctor` shows
`OK transfers no trip is past its transit time`.

## 8. The hubs, and moving them

The example gives every map one hub. Routes leave from inside its zone (60 m) and arrivals land beside it (40 m).

| Map | Hub | x, z |
|---|---|---|
| Chernarus | Berezino station | 12989, 10244 |
| Livonia | Topolin station | 1640, 7470 |
| Sakhal | Nogovo bus station | 7868, 7750 |
| Nasdara | Nasdara bus station | 10327, 4310 |

Inside a hub's zone a player sees "Departures here" and the **Departures** action. Chat works too: `!routes` lists
the routes from this server, `!travel To Sakhal` takes one.

To move a hub, change the fares, the cooldown (30 minutes) or the wait (10 seconds): the console's Routes page, or
edit `network.json` and run the setup again. A change reaches the game servers within 30 seconds, with no restart.

To hang a real terminal on a wall or stand one on a counter, use the in-game admin panel. It opens for the Steam64
ids in `admins` in that server's `config.json`, from the key bound in Options, Controls, Travel, "Travel admin
panel". Terminals are saved by the server they stand on. To also let those admins change routes from the panel,
turn the switch on: `npm run admin -- network admin <network id> on`.

**Check:** every hub is where you want it, and a staff account sees "Departures here" there.

## 9. Open to players

1. Open the routes: in the console, or set `"enabled": true` on each route in `network.json` and run the setup
   again.
2. Remove the maintenance password and restart the servers.
3. Tell players three things. They need the `@Highwatch-Travel` mod. From now on they have **one character** across
   the four maps, and it lives on the server they join first. Sakhal and Nasdara need their DLC.

If the servers had players before: a body a server saved earlier stays where it is, unused, while the character
lives elsewhere. When the character first arrives on that server by Travel, it takes that body over and what the
old body carried is gone. Say so before you open, or start the four servers fresh.

**Check:** during the first hour, `npm run admin -- doctor` every 15 minutes shows four servers online and no
`FAIL`. A `WARN transfers ... past the transit time` line names a trip nobody claimed; it usually clears itself
when the server the player left takes the character back.

## 10. Backups

The install registered `\Highwatch\Highwatch Travel Backup`, every night at 04:00, into
`C:\ProgramData\HighwatchTravel\backups`, keeping 14 days.

1. Run one now: `powershell -ExecutionPolicy Bypass -File .\scripts\windows\backup.ps1`.
2. Once a week, copy the backups folder to another machine or cloud storage. A backup on the same disk does not
   survive the disk.

**Check:** `logs\backup.log` in the API's folder has an `OK backup ...` line for tonight, and again tomorrow
morning. `restore.ps1` is how a backup goes back ([scripts/windows/README.md](../scripts/windows/README.md#restore)).

## 11. Rolling back

If Travel must come out, in this order:

1. Close the servers to players.
2. Stop the API: `powershell -ExecutionPolicy Bypass -File .\scripts\windows\stop-api.ps1`, then stop it starting
   at boot: `Disable-ScheduledTask -TaskPath '\Highwatch\' -TaskName 'Highwatch Travel API'`.
3. On all four servers: take `@Highwatch-Travel` out of `-mod=`. Players stop loading it.
4. Start the servers.

What players keep: each server still has the bodies it saved. A character that travelled is on the server it
arrived on. For a full return to the moment before go-live, put back the `storage_1` copies from step 0 (servers
stopped); every change since then is lost. The Travel database stays untouched, so Travel can be turned on again.

**Check:** each server's log has no `[Highwatch Travel]` line, and a staff account joins without the mod.

## 12. When something fails: what to collect

For the minutes around the problem:

- [ ] When it happened, with your time zone, and the player's Steam64 id.
- [ ] Which servers: where the player was and where they were going.
- [ ] The `[Highwatch Travel]` lines from both servers' script logs.
- [ ] The API's log for that day: `logs\api-<date>.log` in the API's folder.
- [ ] `npm run admin -- doctor` output.
- [ ] `npm run admin -- character show <network id> <steam64>` output.
- [ ] What the player saw on screen (a screenshot helps).

**Never share** `.env`, the secrets file, the `config\*.json` files, any server's `apiKey`, the admin token or
MongoDB passwords. None of the items above contain them. If a key leaked, make a new one with
`npm run admin -- server rotate <server id>` and put it in that server's `config.json`.
