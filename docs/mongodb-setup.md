# Setting up MongoDB for the Travel API

The Travel API keeps everything in one MongoDB database: the ledger of where every character lives, the
snapshots in transit, routes, servers and their keys. This guide takes you from nothing to a running,
password-protected database and the connection string the API needs.

**Which MongoDB.** MongoDB Community Server 8.0 or newer. It was tested on 9.0.2 (Windows 11, October 2026). A
single standalone server is enough: the API needs no replica set and no transactions. MongoDB Atlas (hosted) works
too.

**Where.** On the same machine as the API is simplest and safest: MongoDB then only listens on 127.0.0.1 and is
never reachable from the internet. Keep it that way unless you know why you need otherwise.

Pick one path:
- [Windows](#windows)
- [Linux (Ubuntu or Debian)](#linux-ubuntu-or-debian)
- [Docker](#docker)
- [MongoDB Atlas](#mongodb-atlas)

Then, for all of them: [create the users](#create-the-users), [turn on authentication](#turn-on-authentication),
[build the connection string](#the-connection-string), and set up [backups](#backups).

## Windows

1. Install the server, the shell and the backup tools. In PowerShell:

   ```powershell
   winget install --id MongoDB.Server --exact
   winget install --id MongoDB.Shell --exact
   winget install --id MongoDB.DatabaseTools --exact
   ```

   Or download the MSI from https://www.mongodb.com/try/download/community and choose **Run service as Network
   Service user**. Either way, MongoDB is installed as the Windows service **MongoDB**, started automatically.

2. Check it runs:

   ```powershell
   Get-Service MongoDB          # Status should be Running
   mongosh --eval "db.runCommand({ ping: 1 })"
   ```

   Open a new PowerShell window after installing if `mongosh` is not found.

3. Where things are (version 9.0; replace `9.0` with yours):
   - the config file: `C:\Program Files\MongoDB\Server\9.0\bin\mongod.cfg`
   - the data: `C:\Program Files\MongoDB\Server\9.0\data`
   - the log: `C:\Program Files\MongoDB\Server\9.0\log\mongod.log`

   The installer's config already has `bindIp: 127.0.0.1`, so the database only accepts connections from this
   machine. Leave it.

4. Optional, a window onto the data: `winget install --id MongoDB.Compass.Full --exact` (see
   [Looking at the data](#looking-at-the-data)).

Now [create the users](#create-the-users).

## Linux (Ubuntu or Debian)

Install `mongodb-org` from MongoDB's own package repository, following the page for your distribution and release:
- Ubuntu: https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-ubuntu/
- Debian: https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-debian/

(The distribution's own `mongodb` package is old or missing; use MongoDB's repository.) Then:

```sh
sudo systemctl enable --now mongod
mongosh --eval "db.runCommand({ ping: 1 })"
```

The config file is `/etc/mongod.conf`. It binds to `127.0.0.1` by default. Leave it.

Install the backup tools too (`mongodb-database-tools`, in the same repository).

Now [create the users](#create-the-users).

## Docker

`compose.yaml` in this repository runs MongoDB and the API together. MongoDB's data lives in a named volume, and
MongoDB is not published on any host port; only the API reaches it.

1. Create `.env` next to `compose.yaml` with a root password for MongoDB, a password for the travel user (both
   long and random, letters and digits only) and the admin token:

   ```sh
   MONGO_ROOT_PASSWORD=...
   TRAVEL_DB_PASSWORD=...
   TRAVEL_ADMIN_TOKEN=...
   ```

   Compose will not start anything until all three are set, so make the token without it:

   ```sh
   docker run --rm node:22-alpine node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

2. Start MongoDB alone first, and create the travel user (the root user already exists: the image makes it from
   `MONGO_ROOT_PASSWORD` on first start, and authentication is on):

   ```sh
   docker compose up -d mongo
   docker compose exec mongo mongosh -u root -p --authenticationDatabase admin
   ```

   Then run the second block of [Create the users](#create-the-users) (the `travel` user only).

3. Start the API: `docker compose up -d`. In Docker the connection string is built for you from
   `TRAVEL_DB_PASSWORD` (see `compose.yaml`).

You can skip [Turn on authentication](#turn-on-authentication): the image turns it on when a root user is set.

## MongoDB Atlas

1. Create a cluster at https://cloud.mongodb.com (the free tier is enough for one network).
2. **Database Access:** add a database user `travel` with a password, role **Read and write to any database**, or
   better, a custom role limited to the database `highwatch_travel`.
3. **Network Access:** allow only the public IP address of the machine that runs the API.
4. **Connect, Drivers:** copy the `mongodb+srv://...` string. Put the travel user's password in it, add the
   database name before the `?`, and use it as `TRAVEL_MONGO_URL`:

   ```
   mongodb+srv://travel:PASSWORD@cluster0.abcde.mongodb.net/highwatch_travel?retryWrites=true&w=majority
   ```

Atlas has authentication and backups of its own; skip to [The connection string](#the-connection-string).

## Create the users

Two users: an administrator for you, and `travel`, which can only read and write the Travel database. The API
connects as `travel`, so a leaked API config cannot touch anything else.

Open the shell on the database machine (`mongosh`). Before authentication is on, a local connection may create the
first user. Run:

```js
use admin
db.createUser({ user: "admin", pwd: passwordPrompt(), roles: [ { role: "root", db: "admin" } ] })
```

```js
use highwatch_travel
db.createUser({ user: "travel", pwd: passwordPrompt(), roles: [ { role: "readWrite", db: "highwatch_travel" } ] })
```

`passwordPrompt()` asks for the password without echoing it. Use long random passwords and keep them in your
password manager. `readWrite` is enough: the API creates its own collections and indexes on first start.

## Turn on authentication

Until you do this, anyone on the machine can read and change the database. (Docker and Atlas: already on.)

**Windows.** Open PowerShell **as Administrator**, edit the config, and restart the service:

```powershell
notepad "C:\Program Files\MongoDB\Server\9.0\bin\mongod.cfg"
```

Replace the line `#security:` with these two lines (two spaces before `authorization`):

```yaml
security:
  authorization: enabled
```

```powershell
Restart-Service MongoDB
```

**Linux.** Add the same two lines to `/etc/mongod.conf`, then `sudo systemctl restart mongod`.

**Check it.** This must now fail with "requires authentication":

```sh
mongosh --eval "db.getSiblingDB('highwatch_travel').routes.countDocuments()"
```

and this must work (it asks for the travel password):

```sh
mongosh "mongodb://travel@127.0.0.1:27017/highwatch_travel?authSource=highwatch_travel" --eval "db.runCommand({ ping: 1 })"
```

## The connection string

```
mongodb://travel:PASSWORD@127.0.0.1:27017/highwatch_travel?authSource=highwatch_travel
```

- `highwatch_travel` after the `/` is the database the API uses. Another name works too; use it in both places.
- `authSource=highwatch_travel` says where the user was created. Leave it out and you get "Authentication failed".
- A password with `@ : / ? # [ ]` or `%` in it must be URL-encoded (`@` becomes `%40`). Easier: use a password
  of letters and digits only.

Put it in the API's `.env` as `TRAVEL_MONGO_URL`. `npm start` then prints `listening on ...` and
`GET /readyz` answers `{"status":"ok","db":"ok"}`.

## Backups

The database is the only copy of the ledger and of every character in transit. Back it up.

```sh
mongodump --uri "mongodb://admin:PASSWORD@127.0.0.1:27017/?authSource=admin" --db highwatch_travel --gzip --archive=travel-YYYY-MM-DD.gz
```

Restore into an empty or replaced database (stop the API first):

```sh
mongorestore --uri "mongodb://admin:PASSWORD@127.0.0.1:27017/?authSource=admin" --gzip --archive=travel-YYYY-MM-DD.gz --drop
```

Run the dump every night (Task Scheduler on Windows, cron on Linux) and keep a week of them somewhere other than
the database's own disk. A restored backup brings the ledger back to the moment of the dump: a character that
travelled after it may be listed on the server it left. Check the latest trips (`travel-admin character list`)
after a restore.

## Looking at the data

MongoDB Compass connects with the admin connection string and shows each collection:

| Collection | Holds |
|---|---|
| `servers` | Each game server, its name and the SHA-256 of its key (never the key). |
| `networks`, `members` | Each network, its settings, and which servers belong to it with their address and last beat. |
| `characters` | Where each character lives: `home`, `transit` or `held`, and on which server. |
| `ledger` | Every change to a character, in order. Servers mirror it from here. |
| `transfers`, `parts` | Each trip, and the snapshot of a trip still in transit, in parts. |
| `routes` | The routes players can take. |
| `queue` | Chat lines and staff sends waiting for a server (kept an hour). |
| `held` | Items a destination could not build (its server lacks the class). |
| `counters` | Sequence numbers for the ledger, queue and held items. |

Read freely. **Do not edit by hand while the API runs:** change things with `travel-admin` or the admin API, which
keep the ledger and the trips consistent. Editing `characters` or `transfers` directly can duplicate or lose a
character.

## Upgrading MongoDB

Back up first. MongoDB upgrades one major version at a time (8.0 to 9.0, not 7.0 to 9.0). Follow MongoDB's upgrade
notes for your version. Stop the API during the upgrade; the game servers keep playing and simply cannot travel
until it is back.

## When it does not work

| Message | Cause |
|---|---|
| `Set TRAVEL_MONGO_URL to your MongoDB connection string` | `.env` is missing, or not in the folder you start the API from. |
| `Authentication failed` | Wrong password, or `authSource` missing from the connection string. |
| `connect ECONNREFUSED 127.0.0.1:27017` | MongoDB is not running: `Get-Service MongoDB` or `systemctl status mongod`. |
| `Server selection timed out` (Atlas) | The API machine's IP is not in Network Access. |
| `not authorized on highwatch_travel` | The travel user was created on another database, or with another role. |
