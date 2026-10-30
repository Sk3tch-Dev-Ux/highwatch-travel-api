# Travel API reference

Two kinds of caller: the **@Highwatch-Travel mod** on each game server, and the **network's owner**.

## The mod: `/travel/...`

Every route is `POST` with JSON, and the server key is the **first field** of the body:
`{"apiKey":"hwt_...", ...}`. DayZ's `RestApi` cannot set headers, so the key cannot go in one. The API reads it
from the body's first 512 bytes.

`RestCallback.OnError` in DayZ only receives a number, never a body. So a refusal the player should see answers
**HTTP 200** with `{ "ok": false, "code": "...", "error": "..." }`. A bad key (401, `unknownKey`), too many bad keys
from one address (429, `rateLimited`) and an oversized body (413, `tooLarge`) keep their real status, with the
owner API's refusal shape (below). A refusal the mod has no code for carries its status as text (`"400"`), as it
always has.

| Route | Body | Answer |
|---|---|---|
| `POST /travel/beat` | players `[{steamId, name}]`, maxPlayers, world, terje, version | the network, its servers, everyone online, its routes |
| `POST /travel/inbox` | after, ledgerAfter (-1 asks for the whole ledger), wait (ms, at most 20000), seen (transfer ids already held) | arrivals, returns, queue (chat, send), ledger changes, cursors |
| `POST /travel/ledger` | steamId | where the character lives: state, home, transfer |
| `POST /travel/quote` | steamId | seconds left on each route's cooldown from this server |
| `POST /travel/home` | steamId, name | claims a never-seen character for this server (or `startServer`) |
| `POST /travel/chat` | steamId, name, text | queues the line for every other server in the network |
| `POST /travel/transfers` | steamId, name, to, route (optional) | reserves a trip: transferId, partChars, partsMax |
| `POST /travel/transfers/:id/part` | n, data | stores one part of the snapshot |
| `POST /travel/transfers/:id/commit` | parts, length (UTF-8 bytes) | the snapshot is safe: sha256, expiresAt |
| `POST /travel/transfers/:id/cancel` | | gives up a reservation |
| `POST /travel/transfers/:id/reclaim` | | after the transit time: the source's own download path |
| `POST /travel/transfers/:id/land` | length, as (`return` for the source), held (classes not built) | **the one claim** |
| `GET /travel/snapshot/:id/:token` | | the snapshot text. The token is one-time per side; no key in the URL. |
| `POST /travel/groups` | members `[{steamId, name}]` (1 to 4), to, route (optional), vehicle (bool) | a party trip: group, transfers `[{steamId, transferId}]`, vehicleTransferId and vehicleId when vehicle, partChars, partsMax. A refusal names the member in `who` and reserves nothing. From mod 0.6.0, on both ends. |
| `POST /travel/groups/:group/cancel` | | calls the party trip off, committed members too, and puts their characters back home. Refused (`departed`) once the group is ready. |
| `POST /travel/admin` | staff `{steamId, name}`, action, and the action's fields | the in-game admin panel (see below). Only with the network's `inGameAdmin` on. |

Refusal codes: `notMember`, `notHome`, `transit`, `held`, `offline`, `closed`, `full`, `terje`, `lapsed`,
`parts`, `length`, `claimed`, `notExpired`, `startServer`, `unknownServer`, `unknownRoute`, `routeClosed`,
`cooldown`, `snapshot`, `upgrade`, `notReady`, `departed`, `noVehicles`, `adminOff`, `notYours`, `unknownAction`,
`unknownCharacter`, `routes`, `vehicleOnly`. A refusal may name a party member in `who`.

### Parties and vehicles (mod 0.6.0)

A party trip is one transfer per member, plus one for the vehicle when there is one, under one `group` id. The
vehicle's transfer has the synthetic id `v<group>` where a character has its Steam64, and its snapshot carries that
id as its `steamId`; it has no ledger row. Each transfer takes its parts and commit as a solo trip does. The
destination sees none of the group until every transfer in it is committed: the commit that completes the group
answers `groupReady: true`, and only then does the source send anyone. Arrivals to a 0.6.0 destination carry
`group` and `kind` (`character` or `vehicle`). A member the destination never claims goes back to the source after
the transit time, like a solo trip; the others keep their landing.

### The in-game admin panel (mod 0.6.0)

A member server's admins can set travel up from the game. The game server checks the staff member against its own
`admins` list (`profiles/HighwatchTravel/config.json`) before it calls; the API checks the network allows it:
`inGameAdmin`, which only the owner sets (`POST /v1/networks/:id {inGameAdmin: true}`, or
`travel-admin network admin <network> on`). Off, every action answers `adminOff`. Every change is written to the
audit (`GET /v1/networks/:id/audit`, `travel-admin network audit <network>`) with the staff member and the server,
and character changes name them in the ledger.

| Action | Fields | Answer |
|---|---|---|
| `overview` | | network, servers (with each one's mod `version`), routes, `me` (the calling server) |
| `route.save` | route (the owner route body; `id` to update) | routes. The route must start or end on the calling server (`notYours`). |
| `route.remove` | routeId | routes. Same rule. |
| `member.open` | server, open | servers |
| `network.startServer` | server ("" for any) | network |
| `characters` | q, limit | characters |
| `character` | steamId | character, its last 10 trips, held luggage |
| `character.hold`, `character.release` | steamId, home (release only, optional) | character |
| `send` | steamId, to | queuedOn |

### Timing the mod relies on

| | |
|---|---|
| A reservation not committed in time lapses | 5 minutes |
| A committed trip waits for the destination | 15 minutes; after that the source may take the character back |
| A server whose last beat is older than this is offline | 90 seconds |
| An empty inbox is held at most | 20 seconds (the mod asks for 8: DayZ's RestApi times reads out at 10) |
| Queued chat and sends are kept | 1 hour |

## The owner: `/v1/...`

Every route needs `Authorization: Bearer <TRAVEL_ADMIN_TOKEN>`, and nothing under `/v1`, not even "not found",
answers without it. Thirty wrong tokens from one address in ten minutes answer 429 (`rateLimited`) until the window
ends; the right token always passes. `X-Travel-Staff: <name>` puts a name on holds, releases and sends in the ledger;
it may be percent-encoded UTF-8 (`encodeURIComponent`), since a browser cannot send other characters in a header.
Bodies are JSON. Ids are lower-case hex: servers and networks 16 characters, routes 8, characters are Steam64 ids.
Every route, mod and owner, is described in [openapi.yaml](openapi.yaml) (OpenAPI 3.1).

### Refusals

Every refusal answers one shape, with its real HTTP status:

```json
{ "error": "Give the game port.", "code": "invalid", "field": "port" }
```

`code` is stable: build on it. `error` is a sentence for people and may change. `field` is there when one body or
query field is wrong. The codes:

| Code | Status | Means |
|---|---|---|
| `invalid` | 400 | a field is wrong; `field` names it |
| `badJson` | 400 | the body is not JSON |
| `unauthorized` | 401 | wrong or missing admin token |
| `rateLimited` | 429 | too many wrong tokens or keys from this address |
| `notFound`, `methodNotAllowed` | 404, 405 | no such route, or not with this method (`Allow` lists the methods) |
| `tooLarge` | 413 | the body is too large |
| `unknownServer`, `unknownNetwork`, `unknownRoute` | 404 | no such id |
| `member` | 409 | the server is in a network: remove it there first |
| `otherNetwork` | 409 | the server or route id belongs to another network |
| `travelling` | 409 | a trip is on its way to or from that server |
| `routes` | 409 | routes still use that server |
| `transit` | 409 | the character is travelling |
| `notHome` | 409 | only a character at home can be sent |
| `routesMax` | 409 | the network has 64 routes |
| `unavailable` | 503 | the database did not answer; try again |

### Request ids

Every answer, mod and owner, carries `X-Request-Id`. Send your own (8 to 64 letters, digits, `.`, `_` or `-`, as a
reverse proxy does) and it is kept. The log line of a failed request names it, so a report can point at one line.
Keys, tokens and bodies are still never logged.

### Routes

| Route | Does |
|---|---|
| `GET /v1/overview` | everything the console's landing page shows, in one call: every registered server (with `network`, `""` when in none), and each network with its servers (with mod `version` and `beatAgeSec`), routes, character counts by state, held characters, held luggage still kept, live trips (`stuck` when committed and past the transit time, `lapsing` when a reservation is past its time), plus the doctor's results |
| `GET /v1/doctor` | the checks of `travel-admin doctor`, run inside the API: `{results: [{level, check, text}], failed}` |
| `GET /v1/servers` | every server (never its key) |
| `POST /v1/servers` `{name}` | adds a server. The answer holds its key, **shown once**. |
| `POST /v1/servers/:id/rotate` | a new key; the old one stops working at once |
| `DELETE /v1/servers/:id` | only when it is in no network |
| `GET /v1/networks` | every network with its servers, routes and character counts |
| `POST /v1/networks` `{name}` | creates a network |
| `GET /v1/networks/:id` | one network |
| `POST /v1/networks/:id` `{name?, startServer?}` | renames it, or names the server new characters must start on (`""` for any) |
| `POST /v1/networks/:id/members` `{server, address, port, label?, open?}` | adds a server, or changes it. `address` and `port` are what players connect to. `open: false` closes it to arrivals. |
| `DELETE /v1/networks/:id/members/:server` | removes it, unless a trip is on its way to or from it |
| `GET /v1/networks/:id/characters?q=&limit=` | characters, newest change first |
| `GET /v1/networks/:id/characters/:steam64` | one character (`character`, null when never seen), its ledger, trips and held items. A party vehicle the destination could not place is held under the group's vehicle id and shows on every member's record with `vehicle: true` and its `group`. |
| `POST /v1/networks/:id/characters/:steam64` `{state: "held"\|"home", home?}` | holds it, releases it, or moves its home (never while travelling) |
| `POST /v1/networks/:id/send` `{steamId, to}` | a staff send: the home server runs the trip, with no route rules |
| `POST /v1/networks/:id/routes` `{...route}` | creates a route, or updates it when the body has its `id` |
| `DELETE /v1/networks/:id/routes/:route` | removes it (`unknownRoute` when there is none) |
| `GET /v1/networks/:id/audit?limit=&server=&staff=` | what the in-game admin panels changed, newest first; `server` and `staff` (a Steam64 or a name) narrow it |

### A route

```json
{
  "name": "Ferry to Livonia",
  "code": "FL",
  "from": "<chernarus server id>",
  "to": "<livonia server id>",
  "terminal": { "x": 12989, "z": 10244, "radius": 60, "label": "Berezino station" },
  "landing": { "x": 1858, "z": 7330, "radius": 40, "label": "Topolin" },
  "cost": [ { "type": "BandageDressing", "count": 1 } ],
  "money": 250,
  "moneyFromAtm": false,
  "maxWeightKg": 40,
  "hours": "06-22",
  "cooldownMin": 30,
  "waitSeconds": 10,
  "enabled": true
}
```

| Field | Meaning |
|---|---|
| `code` | 2 to 4 letters or digits on the departures board. Optional. |
| `terminal` | Where it leaves from. Leave it out, or radius 0, for anywhere. |
| `landing` | Where it arrives. Leave it out for the destination's own landing points. |
| `cost` | Up to 8 item classes. An item that inherits the class counts. Count is items, not quantity. |
| `money` | A fare in Expansion Market money, in the value its traders use, 0 to 10,000,000. 0 for none. Charged from the money the player carries, with change. Needs Expansion Market and Highwatch Travel 0.5.0 on the source server: an older mod never sees the field and is refused the route (`upgrade`). |
| `moneyFromAtm` | With a fare, the player's Expansion ATM balance pays what they do not carry. Default false. |
| `maxWeightKg` | What the player may carry. 0 for no cap. |
| `hours` | In-game hours, `"08-20"` or overnight `"22-04"`. Empty for always. |
| `cooldownMin` | Minutes since the character's last departure on any trip. |
| `waitSeconds` | A frozen countdown before the trip, 0 to 120. |
| `vehicles` | A vehicle route: it runs between vehicle terminals and takes a party in a car only, never anyone on foot (`vehicleOnly`); a car on a route without it is refused (`noVehicles`). Default false. Mods older than 0.6.0 never see it. |

## Health

`GET /healthz` answers `{status, version}` while the process runs. `GET /readyz` also pings MongoDB and answers 503
when it cannot.

## The console

`GET /console/` and the files under it are the web console ([console.md](console.md)): static files that call
`/v1` from the owner's browser. `GET /` and `GET /console` send a browser there. They answer with
`Content-Security-Policy` allowing only the API's own scripts, styles and calls, no framing and no form posts;
every answer also carries `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options:
nosniff`. `TRAVEL_CONSOLE=0` turns the console off: its paths answer 404 and nothing else changes.
