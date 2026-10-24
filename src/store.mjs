// Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
// The Highwatch Travel store: one character across a network of DayZ servers, kept in MongoDB.
//
// The ledger owns every character. Each character in a network has one record that says where it lives: home on
// one server, in transit between two, or held by staff. A server may only build a character the ledger gives it,
// and a stored snapshot can be claimed exactly once. That one rule stops duplicated and lost characters, whatever
// order crashes and reconnects happen in. The protocol is in docs/api.md.
//
// How the rule holds on MongoDB, without multi-document transactions (so a single standalone mongod is enough):
// - Every state change of a transfer or a character is one conditional update (`{_id, state: 'committed'}` and so
//   on). Of two callers, exactly one sees modifiedCount 1; the other is refused and must not build the character.
// - A unique partial index on transfers {network, steamId} where `live` is true allows one live trip per character.
// - Inside this process every write runs through `serial()`, so reads that decide a write never interleave with
//   another write, and ledger sequence numbers are inserted in order (a reader's cursor never skips one).
// Run one API process per database. Long-polls wait in memory, and the serial queue is per process.

import { createHash, randomBytes } from 'node:crypto';

const STEAM64 = /^\d{17}$/;
export const SERVER_ID = /^[a-f0-9]{16}$/;
export const NETWORK_ID = /^[a-f0-9]{16}$/;
export const TRANSFER_ID = /^[a-f0-9]{24}$/;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const SERVER_KEY = /^hwt_[A-Za-z0-9_-]{43}$/;
const ADDRESS = /^[A-Za-z0-9.-]{1,253}$/;
// Snapshot parts. A part is a plain JSON string field; 128 parts of 32 KB is a 4 MB character, about ten times a
// full kit. The mod sends far smaller parts (an Enforce string built by appending stops at 8191 bytes).
export const PART_CHARS = 32768;
export const PARTS_MAX = 128;
// A reservation the source never commits (it crashed, the player logged out) lapses after this.
export const RESERVE_MS = 5 * 60000;
// A committed snapshot waits this long for the destination. After it, the source may take the character back.
export const TRANSIT_MS = 15 * 60000;
// A server whose last beat is older than this is offline for routing.
export const BEAT_STALE_MS = 90000;
// Long-poll: the inbox answers at once when it has something, else after this long.
export const WAIT_MAX_MS = 20000;
const QUEUE_KEEP_MS = 3600000;
const CHAT_CHARS = 256;
const ROUTE_ID = /^[a-f0-9]{8}$/;
const CLASS_NAME = /^[A-Za-z0-9_]{1,64}$/;
const HOURS = /^(\d{1,2})-(\d{1,2})$/;
const ROUTE_CODE = /^[A-Z0-9]{2,4}$/;
// Mods before 0.3.0 read routes and landing zones into classes without `code` and `label`, so they never get them.
const LABELS_FROM = [0, 3, 0];
// Mods from 0.5.0 charge a route's money fare (Expansion Market) and carry the ATM balance.
const MONEY_FROM = [0, 5, 0];
// Mods from 0.6.0 travel as a party, and with a vehicle (`/travel/groups`).
const GROUPS_FROM = [0, 6, 0];
export const PARTY_MAX = 4;
const MONEY_MAX = 10000000;
export const ROUTES_MAX = 64;
const HELD_MAX = 200;
const LIVE = ['reserved', 'committed'];

const str = v => typeof v === 'string' ? v : '';
const iso = v => v === null || v === undefined ? '' : new Date(v).toISOString();
export const failure = (status, message, code = '', who = '') => Object.assign(new Error(message), { status, code, who });
const token = () => randomBytes(32).toString('base64url');
const clean = (v, max) => str(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const atLeast = (version, min) => { const v = str(version).split('.').map(n => Number.parseInt(n, 10) || 0); for (let i = 0; i < min.length; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]; return true; };
export const hashKey = key => createHash('sha256').update(str(key)).digest('hex');
const charId = (network, steamId) => `${network}:${steamId}`;

export class TravelStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db; this.now = now;
    const c = name => db.collection(name);
    this.c = { servers: c('servers'), networks: c('networks'), members: c('members'), characters: c('characters'), ledger: c('ledger'), transfers: c('transfers'), parts: c('parts'), queue: c('queue'), routes: c('routes'), held: c('held'), counters: c('counters'), audit: c('audit') };
    // server id -> set of resolvers waiting on its inbox.
    this.waiters = new Map();
    this.tail = Promise.resolve();
  }

  // One write at a time in this process: see the header.
  serial(fn) { const run = this.tail.then(() => fn()); this.tail = run.catch(() => {}); return run; }

  async init() {
    const { c } = this;
    await Promise.all([
      c.servers.createIndex({ keyHash: 1 }, { unique: true }),
      c.members.createIndex({ network: 1 }),
      c.characters.createIndex({ network: 1, updatedAt: -1 }),
      c.ledger.createIndex({ network: 1, seq: 1 }, { unique: true }),
      c.ledger.createIndex({ network: 1, steamId: 1, seq: -1 }),
      c.transfers.createIndex({ network: 1, steamId: 1 }, { unique: true, partialFilterExpression: { live: true }, name: 'one_live_trip' }),
      c.transfers.createIndex({ network: 1, steamId: 1, createdAt: -1 }),
      c.transfers.createIndex({ toServer: 1, state: 1 }),
      c.transfers.createIndex({ fromServer: 1, state: 1, expiresAt: 1 }),
      c.transfers.createIndex({ state: 1, expiresAt: 1 }),
      c.transfers.createIndex({ group: 1 }, { partialFilterExpression: { group: { $type: 'string' } } }),
      c.parts.createIndex({ transfer: 1, n: 1 }, { unique: true }),
      c.queue.createIndex({ server: 1, _id: 1 }),
      c.queue.createIndex({ at: 1 }),
      c.routes.createIndex({ network: 1, createdAt: 1 }),
      c.held.createIndex({ network: 1, steamId: 1, _id: -1 }),
      c.audit.createIndex({ network: 1, at: -1 }),
    ]);
    return this;
  }

  async next(name) { const d = await this.c.counters.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }); return d.seq; }

  // --- servers and their keys -------------------------------------------------------------------------
  // A server key is shown once, when the server is added or its key rotated. Only its SHA-256 is stored.
  async addServer(name) {
    const label = clean(name, 64);
    if (!label) throw failure(400, 'Name the server.');
    const id = randomBytes(8).toString('hex'), key = `hwt_${token()}`;
    await this.c.servers.insertOne({ _id: id, name: label, keyHash: hashKey(key), createdAt: this.now() });
    return { id, name: label, key };
  }
  async rotateKey(id) {
    const key = `hwt_${token()}`;
    const r = await this.c.servers.updateOne({ _id: str(id) }, { $set: { keyHash: hashKey(key) } });
    if (!r.matchedCount) throw failure(404, 'Unknown server.');
    return { id, key };
  }
  async removeServer(id) {
    if (await this.c.members.findOne({ _id: str(id) })) throw failure(409, 'Remove the server from its network first.');
    const r = await this.c.servers.deleteOne({ _id: str(id) });
    if (!r.deletedCount) throw failure(404, 'Unknown server.');
  }
  async servers() { return (await this.c.servers.find({}, { projection: { keyHash: 0 } }).sort({ name: 1 }).toArray()).map(s => ({ id: s._id, name: s.name, createdAt: iso(s.createdAt) })); }
  async serverByKey(key) { if (!SERVER_KEY.test(str(key))) return null; const s = await this.c.servers.findOne({ keyHash: hashKey(key) }); return s ? { id: s._id, name: s.name } : null; }
  async serverRecord(id) { const s = SERVER_ID.test(str(id)) ? await this.c.servers.findOne({ _id: id }) : null; if (!s) throw failure(404, 'Unknown server.'); return s; }

  // --- routes ----------------------------------------------------------------------------------------
  // A route is how a player travels on their own: from one server to another, from an optional terminal zone,
  // to an optional landing zone, for a cost in items, under a weight cap, in opening hours (in-game time), with
  // a cooldown and a wait. Staff sends ignore routes. Hours are "08-20" (08:00 to 20:00) or "22-04" (overnight).
  async parseRoute(networkId, p) {
    const id = p?.id === undefined || p.id === '' ? randomBytes(4).toString('hex') : str(p.id);
    if (!ROUTE_ID.test(id)) throw failure(400, 'Invalid route id.');
    const member = async s => !!(await this.c.members.findOne({ _id: s, network: networkId }));
    const from = str(p?.from), to = str(p?.to);
    if (!(await member(from)) || !(await member(to)) || from === to) throw failure(400, 'A route goes from one member server to another.');
    const name = clean(p?.name, 48);
    if (!name) throw failure(400, 'Name the route.');
    // A zone's label is the name players see ("Berezino station"); the screens fall back to a grid reference.
    const zone = (z, what) => {
      if (z === null || z === undefined || z === '') return null;
      const x = Number(z.x), zz = Number(z.z), radius = Number(z.radius ?? 0);
      if (![x, zz, radius].every(Number.isFinite) || x < 0 || zz < 0 || x > 40960 || zz > 40960 || radius < 0 || radius > 2000) throw failure(400, `Invalid ${what}: x and z in metres, radius 0 to 2000.`);
      return { x, z: zz, radius, label: clean(z.label, 40) };
    };
    // The short code on the departures board ("NL"). Optional; the screens number routes without one.
    const code = str(p?.code).trim().toUpperCase();
    if (code && !ROUTE_CODE.test(code)) throw failure(400, 'A route code is 2 to 4 letters or digits.');
    const cost = (Array.isArray(p?.cost) ? p.cost : []).map(c => ({ type: str(c?.type).trim(), count: Number(c?.count ?? 1) }));
    if (cost.length > 8 || cost.some(c => !CLASS_NAME.test(c.type) || !Number.isInteger(c.count) || c.count < 1 || c.count > 100)) throw failure(400, 'A cost is up to 8 item classes, each 1 to 100 items.');
    const hours = str(p?.hours).trim();
    const hm = HOURS.exec(hours);
    if (hours && (!hm || Number(hm[1]) > 23 || Number(hm[2]) > 24)) throw failure(400, 'Hours are "08-20" in in-game time, or empty for always.');
    const int = (v, min, max, what) => { const n = v === undefined || v === null || v === '' ? 0 : Number(v); if (!Number.isInteger(n) || n < min || n > max) throw failure(400, `Invalid ${what}.`); return n; };
    // A fare in Expansion Market money, in the value its traders use; moneyFromAtm lets the bank pay what the player
    // does not carry.
    const money = int(p?.money, 0, MONEY_MAX, `money fare: a whole amount from 0 to ${MONEY_MAX}`);
    return { id, name, code, from, to, terminal: zone(p?.terminal, 'terminal'), landing: zone(p?.landing, 'landing'), cost, money, moneyFromAtm: money > 0 && p?.moneyFromAtm === true, vehicles: p?.vehicles === true, maxWeightKg: int(p?.maxWeightKg, 0, 1000, 'weight cap'), hours, cooldownMin: int(p?.cooldownMin, 0, 10080, 'cooldown'), waitSeconds: int(p?.waitSeconds, 0, 120, 'wait'), enabled: p?.enabled !== false };
  }
  // No zone goes out as radius 0, never null: the mod reads routes into fixed classes. With labels false (a mod
  // older than 0.3.0) the route carries no `code` and its zones no `label`, the keys that mod has no member for.
  // With money false (older than 0.5.0) it carries no `money` or `moneyFromAtm`; such a mod cannot take a money route
  // (reserve refuses it), so it never runs one for free.
  async routes(networkId, labels = true, money = true, groups = true) {
    return (await this.c.routes.find({ network: networkId }).sort({ createdAt: 1, _id: 1 }).toArray()).map(d => {
      const { code = '', money: fare = 0, moneyFromAtm = false, vehicles = false, ...rest } = d.body;
      const out = { ...rest, terminal: this.zoneOut(d.body.terminal, labels), landing: this.zoneOut(d.body.landing, labels) };
      if (labels) out.code = code;
      if (money) { out.money = fare; out.moneyFromAtm = moneyFromAtm; }
      // `vehicles`: a car may take this route (0.6.0). An older mod has no member for it and cannot send a car.
      if (groups) out.vehicles = vehicles;
      return out;
    });
  }
  zoneOut(z, labels) {
    const out = { x: z?.x ?? 0, z: z?.z ?? 0, radius: z?.radius ?? 0 };
    if (labels) out.label = z?.label ?? '';
    return out;
  }
  // Whether a member server's mod reads route codes and zone labels (its last beat said 0.3.0 or later).
  async readsLabels(serverId) { const m = await this.c.members.findOne({ _id: serverId }); return atLeast(m?.beat?.version, LABELS_FROM); }
  async readsMoney(serverId) { const m = await this.c.members.findOne({ _id: serverId }); return atLeast(m?.beat?.version, MONEY_FROM); }
  async readsGroups(serverId) { const m = await this.c.members.findOne({ _id: serverId }); return atLeast(m?.beat?.version, GROUPS_FROM); }
  async route(networkId, id) { const r = await this.c.routes.findOne({ _id: id, network: networkId }); return r ? r.body : null; }

  // --- helpers ---------------------------------------------------------------------------------------
  async membership(server) {
    const m = await this.c.members.findOne({ _id: server });
    if (!m) throw failure(409, 'This server is not in a travel network. Add it with travel-admin or the admin API first.', 'notMember');
    return m;
  }
  online(m) { return !!m.beatAt && this.now() - m.beatAt < BEAT_STALE_MS; }
  async character(network, steamId) { return await this.c.characters.findOne({ _id: charId(network, steamId) }); }
  // Writes the character and appends one ledger row. Only ever called inside serial(), so ledger rows are inserted
  // in sequence order and a reader's cursor never jumps a row that is not written yet.
  async setCharacter(network, steamId, name, state, home, transfer, reason, toServer = '') {
    const at = this.now();
    const set = { network, steamId, state, home, transfer, updatedAt: at };
    // A name only replaces the stored one when given; a new record without one starts with ''. (MongoDB refuses an
    // empty $setOnInsert, so it is only sent when it has something.)
    const update = { $set: set };
    if (name) set.name = name;
    else update.$setOnInsert = { name: '' };
    await this.c.characters.updateOne({ _id: charId(network, steamId) }, update, { upsert: true });
    const seq = await this.next(`ledger:${network}`);
    await this.c.ledger.insertOne({ _id: `${network}:${seq}`, network, seq, steamId, state, home, toServer, reason, at });
    // Every member mirrors the ledger, so each one is woken with the change.
    for (const r of await this.c.members.find({ network }, { projection: { _id: 1 } }).toArray()) this.wake(r._id);
  }
  async transfer(id) {
    if (!TRANSFER_ID.test(str(id))) throw failure(400, 'Invalid transfer.');
    const t = await this.c.transfers.findOne({ _id: id });
    if (!t) throw failure(404, 'Unknown transfer.');
    return t;
  }
  async settleTransfer(id, fromState, set) {
    const r = await this.c.transfers.updateOne({ _id: id, state: fromState }, { $set: { ...set, settledAt: this.now() }, $unset: { live: '' } });
    return r.modifiedCount === 1;
  }
  // Reservations past their time lapse; committed transfers nobody claimed only become reclaimable (the ledger keeps
  // them in transit until a server claims them).
  async sweep() {
    const now = this.now();
    for (const t of await this.c.transfers.find({ state: 'reserved', expiresAt: { $lt: now } }, { projection: { _id: 1 } }).toArray()) {
      if (await this.settleTransfer(t._id, 'reserved', { state: 'lapsed', reason: 'not committed in time' })) await this.c.parts.deleteMany({ transfer: t._id });
    }
    await this.c.queue.deleteMany({ at: { $lt: now - QUEUE_KEEP_MS } });
  }
  wake(server) { const set = this.waiters.get(server); if (!set) return; this.waiters.delete(server); for (const r of set) r(); }
  async enqueue(server, kind, body) { const seq = await this.next('queue'); await this.c.queue.insertOne({ _id: seq, server, kind, body, at: this.now() }); this.wake(server); }
  async serverView(m) {
    const beat = m.beat ?? {};
    let name = m.label;
    if (!name) { const s = await this.c.servers.findOne({ _id: m._id }); name = s?.name ?? m._id; }
    return { id: m._id, name, address: m.address, port: m.port, open: !!m.open, online: this.online(m), players: Array.isArray(beat.players) ? beat.players.length : 0, slots: Number.isInteger(beat.maxPlayers) ? beat.maxPlayers : 0, world: str(beat.world), terje: str(beat.terje), modset: str(beat.modset), beatAt: iso(m.beatAt) };
  }

  // --- mod facing ------------------------------------------------------------------------------------
  // Heartbeat: who is on this server, its slots and fingerprints. Answers with the network as this server sees it.
  async beat(server, p) {
    const m = await this.membership(server.id);
    const players = (Array.isArray(p?.players) ? p.players : []).slice(0, 512).filter(x => STEAM64.test(str(x?.steamId))).map(x => ({ steamId: x.steamId, name: clean(x.name, 64) }));
    const beat = { players, maxPlayers: Number.isInteger(p?.maxPlayers) && p.maxPlayers >= 0 && p.maxPlayers <= 1000 ? p.maxPlayers : 0, world: clean(p?.world, 64), modset: clean(p?.modset, 128), terje: clean(p?.terje, 128), version: clean(p?.version, 32) };
    await this.c.members.updateOne({ _id: server.id }, { $set: { beatAt: this.now(), beat } });
    return this.network(m.network, server.id);
  }
  async network(networkId, self = '') {
    const n = await this.c.networks.findOne({ _id: networkId });
    if (!n) throw failure(404, 'Unknown travel network.');
    const members = await this.c.members.find({ network: networkId }).sort({ label: 1, _id: 1 }).toArray();
    const servers = [];
    for (const m of members) servers.push({ ...(await this.serverView(m)), self: m._id === self });
    const roster = [];
    for (const m of members) {
      if (!this.online(m)) continue;
      for (const pl of m.beat?.players ?? []) roster.push({ steamId: pl.steamId, name: pl.name, server: m._id });
    }
    const groups = self === '' || await this.readsGroups(self);
    // inGameAdmin is a 0.6.0 key: an older mod reads settings into a class without it.
    const { inGameAdmin = false, ...older } = n.settings ?? {};
    const settings = groups ? { ...older, inGameAdmin } : older;
    return { network: { id: n._id, name: n.name, settings }, servers, players: roster, routes: await this.routes(networkId, self === '' || await this.readsLabels(self), self === '' || await this.readsMoney(self), groups) };
  }

  // The inbox: arrivals for this server, queued messages after its cursor and ledger changes after its ledger
  // cursor. Empty answers wait up to WAIT_MAX_MS (or `wait` ms) for something to arrive. A server asks for the
  // whole ledger with ledgerAfter -1 (or by leaving it out); 0 is a real cursor, the one an empty network has.
  async inboxNow(server, p) {
    await this.sweep();
    const m = await this.membership(server.id);
    const after = Number.isSafeInteger(p?.after) && p.after >= 0 ? p.after : 0;
    const ledgerAfter = Number.isSafeInteger(p?.ledgerAfter) && p.ledgerAfter >= 0 ? p.ledgerAfter : -1;
    const now = this.now();
    // The landing zone comes from the route; radius 0 means none, so the server's own landing points apply.
    const labels = await this.readsLabels(server.id);
    const groups = atLeast(m.beat?.version, GROUPS_FROM);
    const arrivals = [];
    // A party's transfers wait here until every one of them is committed (groupReady).
    for (const t of await this.c.transfers.find({ toServer: server.id, state: 'committed', $or: [{ group: { $in: [null, ''] } }, { groupReady: true }] }).sort({ committedAt: 1 }).toArray()) {
      const route = t.route ? await this.route(t.network, t.route) : null;
      const a = { transferId: t._id, steamId: t.steamId, name: t.name, from: t.fromServer, expiresAt: iso(t.expiresAt), expired: t.expiresAt < now, path: `/travel/snapshot/${t._id}/${t.destToken}`, length: t.length, route: t.route ?? '', landing: this.zoneOut(route?.landing, labels) };
      // A mod older than 0.6.0 reads arrivals into a class without these keys; it is never sent a party anyway.
      if (groups) { a.group = t.group ?? ''; a.kind = t.kind ?? 'character'; }
      arrivals.push(a);
    }
    // Committed transfers this server sent that nobody claimed in time: it may take them back.
    const returns = (await this.c.transfers.find({ fromServer: server.id, state: 'committed', expiresAt: { $lt: now } }).sort({ committedAt: 1 }).toArray())
      .map(t => ({ transferId: t._id, steamId: t.steamId, name: t.name, to: t.toServer }));
    const queue = (await this.c.queue.find({ server: server.id, _id: { $gt: after } }).sort({ _id: 1 }).limit(200).toArray()).map(r => ({ id: r._id, kind: r.kind, ...r.body }));
    const topDoc = await this.c.ledger.find({ network: m.network }).sort({ seq: -1 }).limit(1).next();
    const top = topDoc?.seq ?? 0;
    const full = ledgerAfter < 0 || ledgerAfter > top;
    let changes;
    if (full) {
      changes = [];
      for (const ch of await this.c.characters.find({ network: m.network }).toArray()) {
        let to = '';
        if (ch.state === 'transit') to = (await this.c.transfers.findOne({ _id: ch.transfer }, { projection: { toServer: 1 } }))?.toServer ?? '';
        changes.push({ steamId: ch.steamId, state: ch.state, home: ch.home, to });
      }
    } else {
      changes = (await this.c.ledger.find({ network: m.network, seq: { $gt: ledgerAfter } }).sort({ seq: 1 }).toArray()).map(r => ({ steamId: r.steamId, state: r.state, home: r.home, to: r.toServer }));
    }
    return { arrivals, returns, queue, cursor: queue.length ? queue.at(-1).id : after, ledger: { full, cursor: top, changes } };
  }
  async inbox(server, p) {
    const first = await this.serial(() => this.inboxNow(server, p));
    // Arrivals and returns stay listed until they settle, so they only count as news when the mod does not hold
    // them yet (`seen`, the transfer ids it is already downloading or holds). Otherwise a pending arrival would
    // answer every poll at once for its whole transit time.
    const seen = new Set((Array.isArray(p?.seen) ? p.seen : []).slice(0, 200).filter(id => typeof id === 'string'));
    const quiet = r => r.arrivals.every(a => seen.has(a.transferId)) && r.returns.every(a => seen.has(a.transferId)) && !r.queue.length && !r.ledger.changes.length;
    if (!quiet(first) || first.ledger.full) return first;
    const wait = Number.isInteger(p?.wait) ? Math.max(0, Math.min(WAIT_MAX_MS, p.wait)) : WAIT_MAX_MS;
    if (!wait) return first;
    await new Promise(resolve => {
      const set = this.waiters.get(server.id) ?? new Set();
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size && this.waiters.get(server.id) === set) this.waiters.delete(server.id); resolve(); };
      const timer = setTimeout(done, wait);
      if (timer.unref) timer.unref();
      set.add(done); this.waiters.set(server.id, set);
    });
    return this.serial(() => this.inboxNow(server, p));
  }
  closeWaiters() { for (const id of [...this.waiters.keys()]) this.wake(id); }

  // Where a character lives. A server asks on connect when its mirror has no row yet.
  async ledgerOf(server, p) {
    const m = await this.membership(server.id);
    if (!STEAM64.test(str(p?.steamId))) throw failure(400, 'Invalid Steam64.');
    const c = await this.character(m.network, p.steamId);
    return { steamId: p.steamId, state: c?.state ?? 'none', home: c?.home ?? '', transfer: c?.transfer ?? '' };
  }
  // The time left on each route's cooldown from this server, for the departures board. Seconds, so the two clocks
  // never need to agree. The same rule reserve applies: minutes since the last departure on any trip.
  async quote(server, p) {
    const m = await this.membership(server.id);
    if (!STEAM64.test(str(p?.steamId))) throw failure(400, 'Invalid Steam64.');
    const out = [];
    for (const r of (await this.routes(m.network)).filter(x => x.from === server.id)) out.push({ id: r.id, cooldownLeftSec: Math.max(0, Math.ceil((await this.cooldownLeft(m.network, p.steamId, r)) / 1000)) });
    return { ok: true, routes: out };
  }
  async cooldownLeft(network, steamId, route) {
    if (!route?.cooldownMin) return 0;
    const last = await this.c.transfers.find({ network, steamId, committedAt: { $ne: null } }).sort({ committedAt: -1 }).limit(1).next();
    return last ? last.committedAt + route.cooldownMin * 60000 - this.now() : 0;
  }
  // First sight of a character with no record: it lives where it first played, unless the network names a start server.
  async claimHome(server, p) {
    const m = await this.membership(server.id);
    if (!STEAM64.test(str(p?.steamId))) throw failure(400, 'Invalid Steam64.');
    const existing = await this.character(m.network, p.steamId);
    if (existing) return { steamId: p.steamId, state: existing.state, home: existing.home, created: false };
    const settings = (await this.c.networks.findOne({ _id: m.network }))?.settings ?? {};
    if (settings.startServer && settings.startServer !== server.id) throw failure(409, 'New characters start on the network start server.', 'startServer');
    await this.setCharacter(m.network, p.steamId, clean(p.name, 64), 'home', server.id, '', 'first seen');
    return { steamId: p.steamId, state: 'home', home: server.id, created: true };
  }

  async reserve(server, p) {
    await this.sweep();
    const m = await this.membership(server.id);
    if (!STEAM64.test(str(p?.steamId))) throw failure(400, 'Invalid Steam64.');
    const dest = await this.destination(server, m, p?.to, 1);
    const c = await this.characterFree(m, server, p.steamId);
    const routeId = await this.routeFor(m, server, p, p.steamId);
    // A vehicle route runs between vehicle terminals and takes cars only (owner, 2026-10-24): nobody goes on foot.
    if (routeId && (await this.route(m.network, routeId))?.vehicles) throw failure(409, 'This is a vehicle route. Drive up to its vehicle terminal.', 'vehicleOnly');
    const id = await this.insertTransfer(m, server, dest, { steamId: p.steamId, name: clean(p.name, 64), route: routeId, kind: 'character', group: null });
    // A character the ledger never saw lives here from now on, so the commit has a record to move.
    if (!c) await this.setCharacter(m.network, p.steamId, clean(p.name, 64), 'home', server.id, '', 'first seen');
    return { transferId: id, expiresAt: iso(this.now() + RESERVE_MS), partChars: PART_CHARS, partsMax: PARTS_MAX };
  }
  // The destination must be in the network, open, online, on the same Terje settings, with room for `seats`.
  async destination(server, m, to, seats) {
    if (!SERVER_ID.test(str(to)) || to === server.id) throw failure(400, 'Choose another server in the network.');
    const dest = await this.c.members.findOne({ _id: to, network: m.network });
    if (!dest) throw failure(404, 'That server is not in this network.', 'unknownServer');
    if (!dest.open) throw failure(409, 'That server is closed for travel.', 'closed');
    if (!this.online(dest)) throw failure(409, 'That server is offline.', 'offline');
    const beat = dest.beat ?? {}, mine = m.beat ?? {};
    if (beat.terje && mine.terje && beat.terje !== mine.terje) throw failure(409, 'Terje settings differ between the two servers.', 'terje');
    const online = Array.isArray(beat.players) ? beat.players.length : 0;
    if (beat.maxPlayers && online + seats > beat.maxPlayers) throw failure(409, seats > 1 ? `That server has room for ${Math.max(0, beat.maxPlayers - online)} more, not ${seats}.` : 'That server is full.', 'full');
    return dest;
  }
  // The character lives here and is free to go. Returns its record, or null when the ledger never saw it.
  async characterFree(m, server, steamId, who = '') {
    const c = await this.character(m.network, steamId);
    if (c && c.state === 'held') throw failure(409, 'This character is held by staff.', 'held', who);
    if (c && c.state === 'transit') throw failure(409, 'This character is already travelling.', 'transit', who);
    if (c && c.home !== server.id) throw failure(409, 'This character does not live on this server.', 'notHome', who);
    return c;
  }
  // A route, when the mod names one, must run from here to there and be open. Its cooldown counts from the
  // character's last departure on any route or send.
  async routeFor(m, server, p, steamId, who = '') {
    if (p?.route === undefined || p.route === '') return '';
    const r = ROUTE_ID.test(str(p.route)) ? await this.route(m.network, p.route) : null;
    if (!r || r.from !== server.id || r.to !== p.to) throw failure(404, 'That route does not run from here to there.', 'unknownRoute');
    if (!r.enabled) throw failure(409, 'That route is closed.', 'routeClosed');
    if (r.money > 0 && !atLeast(m.beat?.version, MONEY_FROM)) throw failure(409, 'This route charges money, which needs Highwatch Travel 0.5.0 or later on this server.', 'upgrade');
    if (r.cooldownMin) {
      const left = await this.cooldownLeft(m.network, steamId, r);
      if (left > 0) throw failure(409, `You can travel again in ${Math.ceil(left / 60000)} minutes.`, 'cooldown', who);
    }
    return r.id;
  }
  async insertTransfer(m, server, dest, { steamId, name, route, kind, group }) {
    const id = randomBytes(12).toString('hex');
    const now = this.now();
    try {
      // `live` and the unique partial index allow one reserved or committed trip per character, across processes too.
      await this.c.transfers.insertOne({ _id: id, network: m.network, steamId, name, fromServer: server.id, toServer: dest._id, state: 'reserved', live: true, createdAt: now, committedAt: null, expiresAt: now + RESERVE_MS, settledAt: null, settledBy: '', parts: 0, length: 0, sha256: '', destToken: '', backToken: '', reason: '', route, kind, group, groupReady: false });
    } catch (error) {
      if (error?.code === 11000) throw failure(409, 'This character is already travelling.', 'transit', steamId);
      throw error;
    }
    return id;
  }
  // A party, and its vehicle, as one trip: a transfer per member (and one for the vehicle) under one group id.
  // Every member is checked before anything is written, so a refusal names who and writes nothing. The destination
  // sees none of the group's arrivals until every transfer in it is committed (commit marks the group ready).
  async reserveGroup(server, p) {
    await this.sweep();
    const m = await this.membership(server.id);
    if (!atLeast(m.beat?.version, GROUPS_FROM)) throw failure(409, 'Travelling as a party needs Highwatch Travel 0.6.0 or later on this server.', 'upgrade');
    const list = Array.isArray(p?.members) ? p.members : [];
    if (!list.length || list.length > PARTY_MAX) throw failure(400, `A party is 1 to ${PARTY_MAX} players.`);
    const members = list.map(x => ({ steamId: str(x?.steamId), name: clean(x?.name, 64) }));
    if (members.some(x => !STEAM64.test(x.steamId))) throw failure(400, 'Invalid Steam64.');
    if (new Set(members.map(x => x.steamId)).size !== members.length) throw failure(400, 'A player is in the party twice.');
    const dest = await this.destination(server, m, p?.to, members.length);
    if (!atLeast(dest.beat?.version, GROUPS_FROM)) throw failure(409, 'The destination needs Highwatch Travel 0.6.0 or later to take a party.', 'upgrade');
    const known = new Map();
    let routeId = '';
    for (const x of members) {
      known.set(x.steamId, await this.characterFree(m, server, x.steamId, x.steamId));
      routeId = await this.routeFor(m, server, p, x.steamId, x.steamId);
    }
    const vehicleRoute = routeId ? (await this.route(m.network, routeId))?.vehicles === true : false;
    if (p?.vehicle === true && routeId && !vehicleRoute) throw failure(409, 'This route does not take vehicles. Use a vehicle terminal.', 'noVehicles');
    if (p?.vehicle !== true && vehicleRoute) throw failure(409, 'This is a vehicle route. Drive up to its vehicle terminal.', 'vehicleOnly');
    const group = randomBytes(12).toString('hex');
    const made = [];
    try {
      for (const x of members) made.push({ steamId: x.steamId, transferId: await this.insertTransfer(m, server, dest, { steamId: x.steamId, name: x.name, route: routeId, kind: 'character', group }) });
      if (p?.vehicle === true) made.push({ steamId: `v${group}`, transferId: await this.insertTransfer(m, server, dest, { steamId: `v${group}`, name: 'Vehicle', route: routeId, kind: 'vehicle', group }), vehicle: true });
    } catch (error) {
      for (const t of made) if (await this.settleTransfer(t.transferId, 'reserved', { state: 'cancelled', reason: 'the party could not reserve' })) await this.c.parts.deleteMany({ transfer: t.transferId });
      throw error;
    }
    for (const x of members) if (!known.get(x.steamId)) await this.setCharacter(m.network, x.steamId, x.name, 'home', server.id, '', 'first seen');
    const vehicle = made.find(t => t.vehicle);
    return { group, transfers: made.filter(t => !t.vehicle).map(({ steamId, transferId }) => ({ steamId, transferId })), vehicleTransferId: vehicle?.transferId ?? '', vehicleId: vehicle?.steamId ?? '', expiresAt: iso(this.now() + RESERVE_MS), partChars: PART_CHARS, partsMax: PARTS_MAX };
  }
  // Calls a party trip off: every transfer of the group that the destination has not been shown yet, committed ones
  // too, and their characters back home here. Once the group is ready (shown to the destination) it is too late.
  async cancelGroup(server, group) {
    const all = await this.c.transfers.find({ group, fromServer: server.id }).toArray();
    if (!all.length) throw failure(404, 'Unknown party trip.');
    if (all.some(t => t.groupReady)) throw failure(409, 'The party is already on its way.', 'departed');
    let cancelled = 0;
    for (const t of all) {
      const was = t.state;
      if (was !== 'reserved' && was !== 'committed') continue;
      if (!(await this.settleTransfer(t._id, was, { state: 'cancelled', reason: 'the party trip was called off' }))) continue;
      await this.c.parts.deleteMany({ transfer: t._id });
      if (was === 'committed' && t.kind !== 'vehicle') await this.setCharacter(t.network, t.steamId, t.name, 'home', server.id, '', 'trip called off');
      cancelled++;
    }
    return { ok: true, cancelled };
  }
  async ownTransfer(server, id, state) {
    const t = await this.transfer(id);
    if (t.fromServer !== server.id) throw failure(403, 'This transfer belongs to another server.');
    if (state && t.state !== state) throw failure(409, `This transfer is ${t.state}.`, t.state);
    return t;
  }
  async part(server, id, p) {
    const t = await this.ownTransfer(server, id, 'reserved');
    if (t.expiresAt < this.now()) throw failure(409, 'The reservation lapsed.', 'lapsed');
    if (!Number.isInteger(p?.n) || p.n < 0 || p.n >= PARTS_MAX) throw failure(400, `A part number is 0 to ${PARTS_MAX - 1}.`);
    if (typeof p?.data !== 'string' || !p.data.length || Buffer.byteLength(p.data, 'utf8') > PART_CHARS) throw failure(400, `A part is 1 to ${PART_CHARS} bytes.`);
    await this.c.parts.updateOne({ _id: `${t._id}:${p.n}` }, { $set: { transfer: t._id, n: p.n, body: p.data } }, { upsert: true });
    return { ok: true, n: p.n };
  }
  async joined(id) { return (await this.c.parts.find({ transfer: id }).sort({ n: 1 }).toArray()).map(r => r.body).join(''); }
  async commit(server, id, p) {
    const t = await this.ownTransfer(server, id, 'reserved');
    if (t.expiresAt < this.now()) throw failure(409, 'The reservation lapsed.', 'lapsed');
    const parts = await this.c.parts.find({ transfer: t._id }, { projection: { n: 1 } }).sort({ n: 1 }).toArray();
    if (!Number.isInteger(p?.parts) || p.parts < 1 || p.parts !== parts.length || parts.some((x, i) => x.n !== i)) throw failure(409, 'Parts are missing. Send every part, then commit.', 'parts');
    const text = await this.joined(t._id);
    // Lengths are UTF-8 bytes on both sides: Enforce counts bytes, and the destination compares what it downloaded.
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!Number.isInteger(p?.length) || p.length !== bytes) throw failure(409, `The snapshot length does not match what was sent (${bytes} bytes arrived, ${Number.isInteger(p?.length) ? p.length : 'no length'} declared).`, 'length');
    let doc = null;
    try { doc = JSON.parse(text); } catch { doc = null; }
    if (!doc || typeof doc !== 'object' || doc.steamId !== t.steamId) throw failure(400, 'The snapshot is not a character snapshot for this player.', 'snapshot');
    const vehicle = t.kind === 'vehicle';
    if (!vehicle) {
      const c = await this.character(t.network, t.steamId);
      if (!c || c.home !== server.id || c.state !== 'home') throw failure(409, 'This character does not live on this server.', 'notHome');
    }
    const now = this.now();
    const sha256 = createHash('sha256').update(text).digest('hex');
    const r = await this.c.transfers.updateOne({ _id: t._id, state: 'reserved' }, { $set: { state: 'committed', committedAt: now, expiresAt: now + TRANSIT_MS, parts: parts.length, length: bytes, sha256, destToken: token(), backToken: token() } });
    if (r.modifiedCount !== 1) throw failure(409, 'This transfer changed while committing.');
    if (!vehicle) await this.setCharacter(t.network, t.steamId, t.name, 'transit', server.id, t._id, 'departed', t.toServer);
    // A party is shown to the destination only when every transfer in it is committed, and together.
    let groupReady = !t.group;
    if (t.group && !(await this.c.transfers.countDocuments({ group: t.group, state: { $ne: 'committed' } }))) {
      await this.c.transfers.updateMany({ group: t.group }, { $set: { groupReady: true } });
      groupReady = true;
    }
    if (groupReady) this.wake(t.toServer);
    return { ok: true, transferId: t._id, sha256, expiresAt: iso(now + TRANSIT_MS), groupReady };
  }
  async cancel(server, id) {
    const t = await this.ownTransfer(server, id, 'reserved');
    if (await this.settleTransfer(t._id, 'reserved', { state: 'cancelled', reason: 'cancelled by the source' })) await this.c.parts.deleteMany({ transfer: t._id });
    return { ok: true };
  }
  // The snapshot download. Only the right token for the right side: the destination's while committed, the
  // source's once the transfer is past its time. Answers the snapshot text exactly as committed.
  async snapshot(id, tok) {
    const t = await this.transfer(id);
    if (!TOKEN.test(str(tok)) || t.state !== 'committed') throw failure(404, 'Unknown snapshot.');
    const dest = tok === t.destToken, back = tok === t.backToken && t.expiresAt < this.now();
    if (!dest && !back) throw failure(404, 'Unknown snapshot.');
    return this.joined(t._id);
  }
  // The source asks to take an unclaimed character back. Gives it the download path for its own snapshot.
  async reclaim(server, id) {
    const t = await this.ownTransfer(server, id, 'committed');
    if (t.expiresAt >= this.now()) throw failure(409, 'The destination still has time to claim this character.', 'notExpired');
    return { transferId: t._id, steamId: t.steamId, path: `/travel/snapshot/${t._id}/${t.backToken}`, length: t.length };
  }
  // The one claim. The destination may claim while the transfer is committed; the source only after it expired.
  // Exactly one conditional update wins; every other caller gets 409 and must not build the character.
  async land(server, id, p) {
    const t = await this.transfer(id);
    const asReturn = p?.as === 'return';
    if (asReturn ? t.fromServer !== server.id : t.toServer !== server.id) throw failure(403, 'This transfer is not yours to claim.');
    if (asReturn && t.expiresAt >= this.now()) throw failure(409, 'The destination still has time to claim this character.', 'notExpired');
    if (Number.isInteger(p?.length) && p.length !== t.length) throw failure(409, 'The snapshot you hold is not the one committed.', 'length');
    if (!asReturn && t.group && !t.groupReady) throw failure(409, 'The rest of the party has not left yet.', 'notReady');
    if (!(await this.settleTransfer(t._id, 'committed', { state: asReturn ? 'returned' : 'landed', settledBy: server.id }))) throw failure(409, `This transfer is ${(await this.transfer(id)).state}; do not build the character.`, 'claimed');
    if (t.kind !== 'vehicle') await this.setCharacter(t.network, t.steamId, t.name, 'home', server.id, '', asReturn ? 'returned' : 'arrived');
    await this.c.parts.deleteMany({ transfer: t._id });
    // Held luggage: classes this server has no config for, so they could not be built. Kept, never deleted.
    const held = new Map();
    for (const cl of (Array.isArray(p?.held) ? p.held : []).slice(0, HELD_MAX)) if (CLASS_NAME.test(str(cl))) held.set(cl, (held.get(cl) ?? 0) + 1);
    for (const [className, count] of held) await this.c.held.insertOne({ _id: await this.next('held'), network: t.network, steamId: t.steamId, transfer: t._id, server: server.id, className, count, at: this.now(), releasedAt: null });
    return { ok: true, home: server.id };
  }
  // Global chat: queued for every other member of the network.
  async chat(server, p) {
    const m = await this.membership(server.id);
    if (!STEAM64.test(str(p?.steamId))) throw failure(400, 'Invalid Steam64.');
    const text = clean(p?.text, CHAT_CHARS);
    if (!text) throw failure(400, 'Empty message.');
    const body = { steamId: p.steamId, name: clean(p?.name, 64), text, from: server.id, at: iso(this.now()) };
    for (const r of await this.c.members.find({ network: m.network, _id: { $ne: server.id } }, { projection: { _id: 1 } }).toArray()) await this.enqueue(r._id, 'chat', body);
    return { ok: true };
  }

  // --- admin facing (/v1, travel-admin) ---------------------------------------------------------------
  async networks() {
    const out = [];
    for (const n of await this.c.networks.find({}).sort({ name: 1 }).toArray()) {
      const counts = {};
      for (const r of await this.c.characters.aggregate([{ $match: { network: n._id } }, { $group: { _id: '$state', n: { $sum: 1 } } }]).toArray()) counts[r._id] = r.n;
      out.push({ ...(await this.network(n._id)), characters: counts });
    }
    return { networks: out };
  }
  async createNetwork(p) {
    const name = clean(p?.name, 64);
    if (!name) throw failure(400, 'Name the network.');
    const id = randomBytes(8).toString('hex');
    await this.c.networks.insertOne({ _id: id, name, settings: {}, createdAt: this.now() });
    return this.network(id);
  }
  async netOrFail(id) { if (!NETWORK_ID.test(str(id)) || !(await this.c.networks.findOne({ _id: id }, { projection: { _id: 1 } }))) throw failure(404, 'Unknown travel network.'); return id; }
  async settings(id, p) {
    await this.netOrFail(id);
    const cur = (await this.c.networks.findOne({ _id: id })).settings ?? {};
    const set = {};
    if (p?.name !== undefined) { const name = clean(p.name, 64); if (!name) throw failure(400, 'Name the network.'); set.name = name; }
    if (p?.startServer !== undefined) {
      const s = str(p.startServer);
      if (s && !(await this.c.members.findOne({ _id: s, network: id }))) throw failure(400, 'The start server must be a member of this network.');
      cur.startServer = s;
    }
    // In-game admin: the member servers' admins may set up routes, servers and characters from the game's admin panel.
    // Only the network's owner turns it on (owner API or travel-admin), never a game server.
    if (p?.inGameAdmin !== undefined) cur.inGameAdmin = p.inGameAdmin === true;
    await this.c.networks.updateOne({ _id: id }, { $set: { ...set, settings: cur } });
    return this.network(id);
  }
  async addMember(id, p) {
    await this.netOrFail(id);
    const server = str(p?.server);
    await this.serverRecord(server);
    const address = str(p?.address).trim(), port = p?.port;
    if (!ADDRESS.test(address)) throw failure(400, 'Give the address players connect to (IP or host name).');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure(400, 'Give the game port.');
    const other = await this.c.members.findOne({ _id: server });
    if (other && other.network !== id) throw failure(409, 'That server is in another travel network.');
    await this.c.members.updateOne({ _id: server }, { $set: { network: id, label: clean(p?.label, 64), address, port, open: p?.open !== false }, $setOnInsert: { beatAt: null, beat: {} } }, { upsert: true });
    return this.network(id);
  }
  async removeMember(id, server) {
    await this.netOrFail(id);
    if (await this.c.transfers.findOne({ network: id, state: { $in: LIVE }, $or: [{ fromServer: server }, { toServer: server }] })) throw failure(409, 'A character is travelling to or from that server. Wait for it to land.');
    // A route to or from a server that is not a member would show on the board and fail on every reserve.
    const routes = (await this.c.routes.find({ network: id, $or: [{ 'body.from': server }, { 'body.to': server }] }).toArray()).map(r => r.body.name);
    if (routes.length) throw failure(409, `Remove its routes first: ${routes.join(', ')}.`, 'routes');
    await this.c.members.deleteOne({ _id: server, network: id });
    return this.network(id);
  }
  async characters(id, { q = '', limit = 100 } = {}) {
    await this.netOrFail(id);
    const filter = { network: id };
    const needle = str(q).replace(/[^A-Za-z0-9 _-]/g, '');
    if (needle) filter.$or = [{ steamId: { $regex: needle } }, { name: { $regex: needle, $options: 'i' } }];
    return { characters: (await this.c.characters.find(filter).sort({ updatedAt: -1 }).limit(limit).toArray()).map(c => ({ steamId: c.steamId, name: c.name, state: c.state, home: c.home, transfer: c.transfer, updatedAt: iso(c.updatedAt) })) };
  }
  async history(id, steamId) {
    await this.netOrFail(id);
    if (!STEAM64.test(str(steamId))) throw failure(400, 'Invalid Steam64.');
    return {
      ledger: (await this.c.ledger.find({ network: id, steamId }).sort({ seq: -1 }).limit(100).toArray()).map(r => ({ state: r.state, home: r.home, to: r.toServer, reason: r.reason, at: iso(r.at) })),
      transfers: (await this.c.transfers.find({ network: id, steamId }).sort({ createdAt: -1 }).limit(50).toArray()).map(t => ({ id: t._id, from: t.fromServer, to: t.toServer, route: t.route ?? '', state: t.state, createdAt: iso(t.createdAt), committedAt: iso(t.committedAt), expiresAt: iso(t.expiresAt), settledAt: iso(t.settledAt), settledBy: t.settledBy, length: t.length, sha256: t.sha256, reason: t.reason })),
      held: (await this.c.held.find({ network: id, steamId }).sort({ _id: -1 }).limit(200).toArray()).map(h => ({ id: h._id, transfer: h.transfer, server: h.server, className: h.className, count: h.count, at: iso(h.at), releasedAt: iso(h.releasedAt) })),
    };
  }
  // Staff hold or release a character, or move its home (only while it is not travelling).
  async setState(id, steamId, p, actor = 'Staff') {
    await this.netOrFail(id);
    if (!STEAM64.test(str(steamId))) throw failure(400, 'Invalid Steam64.');
    const c = await this.character(id, steamId);
    if (c?.state === 'transit') throw failure(409, 'This character is travelling. Wait for it to land or return.');
    const state = p?.state === 'held' ? 'held' : 'home';
    const home = str(p?.home) || c?.home || '';
    if (!(await this.c.members.findOne({ _id: home, network: id }))) throw failure(400, 'Choose a home server in this network.');
    await this.setCharacter(id, steamId, c?.name ?? '', state, home, '', `${state === 'held' ? 'held' : 'set'} by ${clean(actor, 64) || 'Staff'}`);
    const now = await this.character(id, steamId);
    return { steamId: now.steamId, name: now.name, state: now.state, home: now.home, transfer: now.transfer, updatedAt: iso(now.updatedAt) };
  }
  // --- in-game admin --------------------------------------------------------------------------------
  // The admin panel of a member server. The game server has checked `staff` against its own admin list; the network
  // must have inGameAdmin on. Routes may only be changed when they start or end on the calling server. Every change
  // goes to the audit collection with the staff member and the server.
  async admin(server, p) {
    const m = await this.membership(server.id);
    const net = await this.c.networks.findOne({ _id: m.network });
    if (net?.settings?.inGameAdmin !== true) throw failure(409, 'In-game admin is off for this network. The network owner turns it on with travel-admin network admin <network> on.', 'adminOff');
    const staffId = str(p?.staff?.steamId), staffName = clean(p?.staff?.name, 64);
    if (!STEAM64.test(staffId)) throw failure(400, 'Name the staff member (Steam64).');
    const actor = `${staffName || staffId} on ${(await this.serverView(m)).name}`;
    const id = m.network;
    const audit = async (action, detail) => this.c.audit.insertOne({ _id: await this.next('audit'), network: id, server: server.id, staffId, staffName, action, detail, at: this.now() });
    const ownRoute = async routeId => {
      const r = await this.route(id, str(routeId));
      if (!r) throw failure(404, 'Unknown route.', 'unknownRoute');
      if (r.from !== server.id && r.to !== server.id) throw failure(409, 'Change this route from one of its own servers.', 'notYours');
      return r;
    };
    const action = str(p?.action);
    if (action === 'overview') {
      const n = await this.network(id);
      const servers = [];
      for (const mem of await this.c.members.find({ network: id }).sort({ label: 1, _id: 1 }).toArray()) servers.push({ ...(await this.serverView(mem)), version: str(mem.beat?.version) });
      return { network: n.network, servers, routes: n.routes, me: server.id };
    }
    if (action === 'route.save') {
      const body = p?.route ?? {};
      if (body.from !== server.id && body.to !== server.id) throw failure(409, 'A route set up here must start or end on this server.', 'notYours');
      if (body.id) await ownRoute(body.id);
      const out = await this.saveRoute(id, body);
      await audit('route.save', { route: body.id || out.routes.at(-1)?.id || '', name: clean(body.name, 48) });
      return { routes: out.routes };
    }
    if (action === 'route.remove') {
      const r = await ownRoute(p?.routeId);
      const out = await this.removeRoute(id, r.id);
      await audit('route.remove', { route: r.id, name: r.name });
      return { routes: out.routes };
    }
    if (action === 'member.open') {
      const mem = await this.c.members.findOne({ _id: str(p?.server), network: id });
      if (!mem) throw failure(404, 'That server is not in this network.', 'unknownServer');
      await this.c.members.updateOne({ _id: mem._id }, { $set: { open: p?.open === true } });
      await audit('member.open', { server: mem._id, open: p?.open === true });
      return { servers: (await this.network(id)).servers };
    }
    if (action === 'network.startServer') {
      const out = await this.settings(id, { startServer: str(p?.server) });
      await audit('network.startServer', { server: str(p?.server) });
      return { network: out.network };
    }
    if (action === 'characters') return { characters: (await this.characters(id, { q: str(p?.q), limit: Math.min(100, Number(p?.limit) || 50) })).characters };
    if (action === 'character') {
      if (!STEAM64.test(str(p?.steamId))) throw failure(400, 'Invalid Steam64.');
      const c = await this.character(id, p.steamId);
      if (!c) throw failure(404, 'The network has never seen this character.', 'unknownCharacter');
      const h = await this.history(id, p.steamId);
      return { character: { steamId: c.steamId, name: c.name, state: c.state, home: c.home, transfer: c.transfer, updatedAt: iso(c.updatedAt) }, trips: h.transfers.slice(0, 10), held: h.held.slice(0, 50) };
    }
    if (action === 'character.hold' || action === 'character.release') {
      const out = await this.setState(id, str(p?.steamId), { state: action === 'character.hold' ? 'held' : 'home', home: str(p?.home) }, actor);
      await audit(action, { steamId: str(p?.steamId), home: out.home });
      return { character: out };
    }
    if (action === 'send') {
      const out = await this.send(id, str(p?.steamId), str(p?.to), actor);
      await audit('send', { steamId: str(p?.steamId), to: str(p?.to) });
      return out;
    }
    throw failure(400, 'Unknown admin action.', 'unknownAction');
  }
  async auditOf(id, limit = 100) {
    await this.netOrFail(id);
    return (await this.c.audit.find({ network: id }).sort({ _id: -1 }).limit(Math.min(500, limit)).toArray()).map(a => ({ id: a._id, server: a.server, staffId: a.staffId, staffName: a.staffName, action: a.action, detail: a.detail, at: iso(a.at) }));
  }
  async saveRoute(id, p) {
    await this.netOrFail(id);
    const r = await this.parseRoute(id, p);
    const exists = await this.c.routes.findOne({ _id: r.id }, { projection: { network: 1 } });
    if (exists && exists.network !== id) throw failure(409, 'That route id belongs to another network.');
    if (!exists && await this.c.routes.countDocuments({ network: id }) >= ROUTES_MAX) throw failure(409, `A network has at most ${ROUTES_MAX} routes.`);
    await this.c.routes.updateOne({ _id: r.id }, { $set: { network: id, body: r }, $setOnInsert: { createdAt: this.now() } }, { upsert: true });
    return this.network(id);
  }
  async removeRoute(id, routeId) {
    await this.netOrFail(id);
    await this.c.routes.deleteOne({ _id: routeId, network: id });
    return this.network(id);
  }
  // Staff send a character to another server: queued to its home server, which runs the trip as if the player asked.
  async send(id, steamId, to, actor = 'Staff') {
    await this.netOrFail(id);
    if (!STEAM64.test(str(steamId))) throw failure(400, 'Invalid Steam64.');
    const c = await this.character(id, steamId);
    if (!c || c.state !== 'home') throw failure(409, 'Only a character at home on a server can be sent.');
    if (!(await this.c.members.findOne({ _id: str(to), network: id })) || to === c.home) throw failure(400, 'Choose another server in this network.');
    await this.enqueue(c.home, 'send', { steamId, to, by: clean(actor, 64) || 'Staff' });
    return { ok: true, queuedOn: c.home };
  }
}
