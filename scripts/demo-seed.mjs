#!/usr/bin/env node
// Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
//
// DEMO DATA ONLY. Fills a throwaway database with a made-up travel network so the console has something to show:
// four servers (Chernarus, Namalsk, Nasdara, Chernobyl) and a spare one, foot and vehicle routes, characters at home,
// travelling, held and stuck, held luggage, and in-game admin audit rows. Every name, Steam64 id and address in it is
// invented. It refuses any database whose name does not contain "demo", so it can never touch a real ledger.
//
//   TRAVEL_MONGO_URL=mongodb://127.0.0.1:27017/console_demo node scripts/demo-seed.mjs
//
// It drops that database first, so each run starts clean. Add --beat to keep the live servers online while you look.
// Drop the database when you are done:
//   node scripts/demo-seed.mjs --drop

import { MongoClient } from 'mongodb';
import { readConfig } from '../src/config.mjs';
import { TravelStore } from '../src/store.mjs';

const config = readConfig(process.env, { requireToken: false });
if (!/demo/i.test(config.dbName)) {
  console.error(`Refusing: ${config.dbName} does not look like a demo database. Use a name with "demo" in it, for example mongodb://127.0.0.1:27017/console_demo.`);
  process.exit(1);
}
const client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 5000 });
await client.connect();
const db = client.db(config.dbName);
await db.dropDatabase();
if (process.argv.includes('--drop')) { console.log(`Dropped ${config.dbName}.`); await client.close(); process.exit(0); }

const MIN = 60000, HOUR = 60 * MIN;
const store = await new TravelStore(db).init();
// A store whose clock runs behind, for things that happened earlier.
const past = ms => new TravelStore(db, { now: () => Date.now() - ms });

// Invented Steam64 ids: 76561190000 followed by six digits (no real account has this prefix today).
let next = 100;
const steam = () => `76561190000${String(next++).padStart(6, '0')}`;
const names = ['Ghost', 'Mara Voss', 'Kestrel', 'Old Pyotr', 'Juno', 'Ash', 'Brannigan', 'Lisichka', 'Tamsin', 'Dubrovsky', 'Wren', 'Halloran', 'Nadya', 'Ox', 'Sable', 'Teodor', 'Ilse', 'Rook', 'Venka', 'Cass', 'Marek', 'Lumi', 'Fitch', 'Oskar'];
const people = names.map(name => ({ steamId: steam(), name }));
const snapshot = p => JSON.stringify({ steamId: p.steamId, version: 1, demo: true, items: [{ t: 'Apple', p: -1 }, { t: 'BandageDressing', p: -1 }] });

async function trip(s, from, to, p, { route = '', land = true, held = [], clock = store } = {}) {
  const r = await clock.reserve(from, { steamId: p.steamId, name: p.name, to: to.id, route });
  const text = snapshot(p);
  await clock.part(from, r.transferId, { n: 0, data: text });
  await clock.commit(from, r.transferId, { parts: 1, length: Buffer.byteLength(text) });
  if (land) await clock.land(to, r.transferId, { length: Buffer.byteLength(text), held });
  return r.transferId;
}

// --- servers and the network ---------------------------------------------------------------------------------
const add = async name => { const s = await store.addServer(name); return { id: s.id, name: s.name }; };
const cher = await add('Chernarus'), nam = await add('Namalsk'), nas = await add('Nasdara'), cbl = await add('Chernobyl');
await add('Livonia test bed');
const { network } = await store.createNetwork({ name: 'Highwatch Demo' });
const id = network.id;
const members = [
  [cher, 'chernarus.demo.example', 2302, true],
  [nam, 'namalsk.demo.example', 2402, true],
  [nas, 'nasdara.demo.example', 2502, true],
  [cbl, 'chernobyl.demo.example', 2602, false],
];
for (const [s, address, port, open] of members) await store.addMember(id, { server: s.id, address, port, label: s.name, open });

const beat = (s, players, maxPlayers, world, version, clock = store) => clock.beat(s, { players, maxPlayers, world, terje: 'skills:v2 medicine:v1', modset: 'demo', version });
// Chernobyl's last beat was two hours ago: it is offline, and the doctor says so.
await beat(cbl, [], 40, 'chernobyl', '0.6.0', past(2 * HOUR));

// Who plays where right now.
const at = { [cher.id]: people.slice(0, 9), [nam.id]: people.slice(9, 15), [nas.id]: people.slice(15, 20) };
await beat(cher, at[cher.id], 60, 'chernarusplus', '0.6.0');
await beat(nam, at[nam.id], 50, 'namalsk', '0.6.0');
await beat(nas, at[nas.id], 40, 'nasdara', '0.5.2');
for (const [sid, list] of Object.entries(at)) for (const p of list) await store.claimHome({ id: sid }, p);

// --- routes ----------------------------------------------------------------------------------------------------
const route = async body => (await store.saveRoute(id, body)).routes.at(-1);
const coast = await route({ name: 'Coast rail', code: 'CR', from: cher.id, to: nam.id, terminal: { x: 12989, z: 10244, radius: 3, label: 'Berezino station' }, landing: { x: 6065, z: 11802, radius: 30, label: 'Lighthouse' }, cost: [{ type: 'BandageDressing', count: 1 }], hours: '06-22', cooldownMin: 30, waitSeconds: 10 });
await route({ name: 'Ferry south', code: 'FS', from: nam.id, to: cher.id, terminal: { x: 8340, z: 10880, radius: 3, label: 'Sebjan pier' }, money: 250, waitSeconds: 15 });
await route({ name: 'Northern convoy', code: 'NC', from: cher.id, to: nas.id, vehicles: true, terminal: { x: 4520, z: 10230, radius: 12, label: 'Vybor airfield gate' }, landing: { x: 7210, z: 3890, radius: 25, label: 'Border depot' }, money: 500, moneyFromAtm: true, cooldownMin: 60, waitSeconds: 20 });
await route({ name: 'Convoy home', code: 'CH', from: nas.id, to: cher.id, vehicles: true, terminal: { x: 7180, z: 3920, radius: 12, label: 'Border depot' }, money: 500, cooldownMin: 60, waitSeconds: 20 });
await route({ name: 'Mountain pass', code: 'MP', from: nas.id, to: nam.id, cost: [{ type: 'Battery9V', count: 2 }, { type: 'Canteen', count: 1 }], maxWeightKg: 35, waitSeconds: 10 });
await route({ name: 'Zone crossing', code: 'ZX', from: nam.id, to: cbl.id, terminal: { x: 4100, z: 8000, radius: 3, label: 'Checkpoint 9' }, cooldownMin: 120, enabled: false });

// --- characters in every state -----------------------------------------------------------------------------
const extra = people.slice(20);
// Earlier trips that landed, one with luggage the destination had no class for.
await trip(store, cher, nam, extra[0], { route: coast.id, clock: past(5 * HOUR), held: ['M4A1_Tactical_Kit', 'GorkaHelmetVisor'] });
await trip(store, nam, cher, extra[0], { clock: past(3 * HOUR) });
await trip(store, cher, nas, extra[1], { clock: past(4 * HOUR) });
// Travelling right now: committed a minute ago, waiting for Namalsk to claim it.
await trip(store, cher, nam, extra[2], { land: false, clock: past(1 * MIN) });
// Stuck: committed 22 minutes ago and nobody claimed it. Chernarus takes it back when it can.
await trip(store, cher, nas, extra[3], { land: false, clock: past(22 * MIN) });
// Held by staff.
await store.setState(id, people[4].steamId, { state: 'held' }, 'Demo owner');
await store.setState(id, people[11].steamId, { state: 'held' }, 'Demo owner');

// --- in-game admin, and its audit ----------------------------------------------------------------------------
await store.settings(id, { inGameAdmin: true });
const vis = { steamId: '76561190000900001', name: 'Vis' }, kay = { steamId: '76561190000900002', name: 'Kay' };
await past(50 * MIN).admin(cher, { staff: vis, action: 'route.save', route: { ...coast, waitSeconds: 10 } });
await past(40 * MIN).admin(nam, { staff: kay, action: 'member.open', server: nam.id, open: false });
await past(38 * MIN).admin(nam, { staff: kay, action: 'member.open', server: nam.id, open: true });
await past(20 * MIN).admin(cher, { staff: vis, action: 'character.hold', steamId: people[4].steamId });
await past(12 * MIN).admin(nas, { staff: kay, action: 'send', steamId: people[16].steamId, to: nam.id });

const counts = await db.collection('characters').aggregate([{ $group: { _id: '$state', n: { $sum: 1 } } }]).toArray();
console.log(`DEMO network "Highwatch Demo" (${id}) seeded in ${config.dbName}: 5 servers, 6 routes, characters ${counts.map(c => `${c._id} ${c.n}`).join(', ')}.`);
console.log('Server keys were made and thrown away: this network is for looking at, not for game servers.');
// --beat keeps the three live servers beating every 30 s, so they stay online while you look. Ctrl+C stops it.
if (process.argv.includes('--beat')) {
  console.log('Beating for Chernarus, Namalsk and Nasdara every 30 s. Ctrl+C to stop.');
  const again = async () => {
    await beat(cher, at[cher.id], 60, 'chernarusplus', '0.6.0');
    await beat(nam, at[nam.id], 50, 'namalsk', '0.6.0');
    await beat(nas, at[nas.id], 40, 'nasdara', '0.5.2');
  };
  setInterval(() => again().catch(error => console.error(error.message)), 30000);
} else await client.close();
