# Highwatch Travel API

The service behind **Highwatch Travel**: one DayZ character across a network of servers. Your players move their
character, with its gear and its Terje progress, from one of your servers to another, and the character lives on
exactly one server at a time.

This API is the network's memory. It holds the **ledger** of where every character lives, the snapshot of every
character in transit, the routes players can take, and each server's key. Every game server in the network runs the
**@Highwatch-Travel** mod, which talks to this API. You run the API yourself, on your own machine, with your own
MongoDB.

```
 game server A                         this API                       game server B
 @Highwatch-Travel  --- HTTPS --->  ledger, trips, routes  <--- HTTPS ---  @Highwatch-Travel
                                           |
                                        MongoDB
```

**Why it cannot duplicate or lose a character.** A stored snapshot can be claimed exactly once. Of two servers that
try, MongoDB lets one conditional update succeed and refuses the other, so only one server ever builds the
character. A trip nobody claims in 15 minutes goes back to the server it left. The rules are in `src/store.mjs`'s
header; the protocol is in [docs/api.md](docs/api.md).

## What you need

- A machine that is always on and that every game server in the network can reach over HTTPS. The machine that
  runs one of your game servers is fine.
- **Node.js 22.9 or newer** (https://nodejs.org, or `winget install OpenJS.NodeJS.LTS`).
- **MongoDB 8.0 or newer.** Setup, step by step: [docs/mongodb-setup.md](docs/mongodb-setup.md). Or use
  `compose.yaml`, which runs MongoDB and the API together in Docker.
- The **@Highwatch-Travel** mod on every game server in the network, on the same version everywhere.

## Install

**On Windows**, one script does all of this, including MongoDB, its users, `.env` and starting at boot:
[scripts/windows/README.md](scripts/windows/README.md). Endfall's go-live checklist, from a cold start to the first
trip, is [docs/endfall-install-plan.md](docs/endfall-install-plan.md). By hand, on any system:

1. **Set up MongoDB** with its two users and authentication on: [docs/mongodb-setup.md](docs/mongodb-setup.md).
   Keep the travel user's connection string.

2. **Get the API:**

   ```sh
   git clone https://github.com/Sk3tch-Dev-Ux/highwatch-travel-api.git
   cd highwatch-travel-api
   npm ci
   ```

   (Or download the ZIP from GitHub, unpack it, and run `npm ci` inside.)

3. **Configure:** copy `.env.example` to `.env`, then fill in:
   - `TRAVEL_MONGO_URL`: the travel user's connection string from step 1;
   - `TRAVEL_ADMIN_TOKEN`: `npm run admin -- token` prints one. It is the password to the owner API: keep it secret.

4. **Start it:** `npm start`. It prints `Highwatch Travel API 1.0.0 listening on 127.0.0.1:6070`. Check
   http://127.0.0.1:6070/readyz in a browser: `{"status":"ok","db":"ok"}`.

## Reach it from your game servers

The API listens on 127.0.0.1 only. Put a reverse proxy with HTTPS in front of it, so the keys travel encrypted.
Caddy is the shortest (it fetches the certificate itself). Point a DNS name at the machine, open TCP 443, and use
this `Caddyfile`:

```
travel.example.com {
    reverse_proxy 127.0.0.1:6070
}
```

Then set `TRAVEL_TRUST_PROXY=1` in `.env` and restart the API. The endpoint your game servers use is
`https://travel.example.com`.

When the API and every game server are on the same machine, the game servers can use `http://127.0.0.1:6070` and
you need no proxy.

## Set up your network

`npm run admin -- <command>` works on the database directly (`npm run admin -- help` lists every command). The same
things are in the owner API ([docs/api.md](docs/api.md)), for scripts and, later, the Highwatch desk.

1. **Add each game server.** The key is shown once: copy it now.

   ```sh
   npm run admin -- server add "Chernarus"
   npm run admin -- server add "Livonia"
   ```

2. **On each game server**, put the API's address and that server's key in
   `<profiles>/HighwatchTravel/config.json` (the mod writes this file with defaults on its first start), then
   restart the game server:

   ```json
   {
       "endpoint": "https://travel.example.com",
       "apiKey": "hwt_...",
       ...
   }
   ```

3. **Make the network and add the servers to it.** The address and port are the ones players connect to; the mod
   hops players there.

   ```sh
   npm run admin -- network create "Badlands"
   npm run admin -- member add <network> <chernarus server> 203.0.113.10 2302 "Chernarus"
   npm run admin -- member add <network> <livonia server> 203.0.113.10 2402 "Livonia"
   ```

   Within 30 seconds each game server's log says `[Highwatch Travel] In network Badlands as Chernarus`.
   `npm run admin -- network show <network>` shows both online.

4. **Add routes**, one JSON file each (every field is in [docs/api.md](docs/api.md#a-route)):

   ```sh
   npm run admin -- route add <network> ferry-to-livonia.json
   ```

   Players see them at the departures board in game, or with `!routes` in chat. Route changes reach the game servers
   within 30 seconds; no restart.

5. **Optional:** `npm run admin -- network start-server <network> <server>` makes every new character start on that
   server.

## Keep it running

**Windows:** `scripts\windows\install.ps1` registers a Task Scheduler task that starts the API at boot as SYSTEM,
starts it again whenever it stops, and writes its output to `logspi-<date>.log` (14 days kept). NSSM works too.
Both are in [scripts/windows/README.md](scripts/windows/README.md).

**Linux (systemd):** `/etc/systemd/system/highwatch-travel.service`:

```ini
[Unit]
Description=Highwatch Travel API
After=network-online.target mongod.service

[Service]
WorkingDirectory=/opt/highwatch-travel-api
ExecStart=/usr/bin/node --env-file=.env src/server.mjs
Restart=on-failure
User=highwatch

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now highwatch-travel`.

**Run one API process per database.** It holds waiting game servers and its write queue in memory. Two processes
on one database stay safe (MongoDB still lets only one claim win), but game servers would wait longer for news.

## Back up

The database is the only copy of the ledger and of every character in transit. Back it up every night:
[docs/mongodb-setup.md, Backups](docs/mongodb-setup.md#backups). On Windows, `scripts\windows\backup.ps1` and
`restore.ps1` do it, and `install.ps1 -RegisterBackup` runs the backup at 04:00 every night.

## Check it

```sh
npm run admin -- doctor
```

One line per check, `OK`, `WARN` or `FAIL`: MongoDB reachable and signed in, the indexes, the admin token's format,
each server's last beat and mod version, routes that use a server outside their network, trips past their transit
time, and the API answering on its port. It only reads. It exits with 1 when a check fails, so a monitoring task
can run it.

## Update

```sh
git pull
npm ci
```

Then restart the API. Game servers keep playing while it restarts; travel pauses until it is back. Read the release
notes first: a new API version can need a new mod version on every server.

## Look after characters

```sh
npm run admin -- character list <network> [name or steam64]
npm run admin -- character show <network> <steam64>      # its ledger, trips and held items
npm run admin -- character hold <network> <steam64>       # nobody can build it until released
npm run admin -- character release <network> <steam64> [home server]
npm run admin -- send <network> <steam64> <server>        # its home server runs the trip
```

## Security

- Server keys are stored as SHA-256 hashes; the API cannot show a key again. A leaked key:
  `npm run admin -- server rotate <server>`, then put the new one in that server's config.
- Thirty unknown keys from one address in ten minutes and it is refused for a while.
- No key, token or request body is ever written to the log.
- MongoDB listens on 127.0.0.1 with authentication on, and the API connects as a user that can only touch its own
  database.

## For developers

`npm test` runs the suite against a real MongoDB, on a throwaway database per test that is dropped afterwards
(`TRAVEL_TEST_MONGO_URL`, default `mongodb://127.0.0.1:27017`, needs a server without authentication or a user that
may create and drop databases). The tests include claims racing from two processes.

## Licence

Source-available, not open source: you may run it for a network of DayZ servers you own or operate, and change it
for that. You may not redistribute it, host it for other people's networks, or sell it. See [LICENSE](LICENSE).
Questions: the Highwatch Discord, https://discord.gg/9ug8Yv4kg8.
