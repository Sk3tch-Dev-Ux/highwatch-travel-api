import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TravelStore, TRANSIT_MS } from '../src/store.mjs';
import { fixture, MONGO_URL } from './fixture.mjs';

const GHOST = '76561198012030000';
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/travel-admin.mjs', import.meta.url));
const snapshot = steamId => JSON.stringify({ steamId, version: 1, items: [{ t: 'Apple', p: -1 }] });

async function pair(f) {
  const a = await f.api.store.addServer('Chernarus'), b = await f.api.store.addServer('Livonia');
  const net = (await f.staff('POST', '/v1/networks', { name: 'Lab' })).body.network.id;
  await f.staff('POST', `/v1/networks/${net}/members`, { server: a.id, address: '10.0.0.1', port: 2302 });
  await f.staff('POST', `/v1/networks/${net}/members`, { server: b.id, address: '10.0.0.2', port: 2402 });
  for (const s of [a, b]) await f.mod(s.key, '/travel/beat', { maxPlayers: 60 });
  return { net, a, b };
}
async function committed(f, a, b) {
  const r = await f.mod(a.key, '/travel/transfers', { steamId: GHOST, name: 'Ghost', to: b.id });
  const text = snapshot(GHOST);
  await f.mod(a.key, `/travel/transfers/${r.body.transferId}/part`, { n: 0, data: text });
  assert.equal((await f.mod(a.key, `/travel/transfers/${r.body.transferId}/commit`, { parts: 1, length: Buffer.byteLength(text) })).body.ok, true);
  return r.body.transferId;
}

test('the owner API needs the admin token; server keys are shown once, rotate, and are stored only as hashes', async t => {
  const f = await fixture(t);
  assert.equal((await f.staff('GET', '/v1/servers', undefined, {})).status, 401);
  assert.equal((await f.staff('GET', '/v1/networks', undefined, { authorization: `Bearer ${'x'.repeat(43)}` })).status, 401);
  const added = await f.staff('POST', '/v1/servers', { name: 'Chernarus' });
  assert.equal(added.status, 201); assert.match(added.body.key, /^hwt_[A-Za-z0-9_-]{43}$/);
  const listed = await f.staff('GET', '/v1/servers');
  assert.deepEqual(listed.body.servers.map(s => s.name), ['Chernarus']);
  assert.ok(!JSON.stringify(listed.body).includes(added.body.key), 'the key never comes back');
  const stored = await f.api.db.collection('servers').findOne({ _id: added.body.id });
  assert.equal(stored.keyHash.length, 64); assert.ok(!JSON.stringify(stored).includes(added.body.key), 'only the hash is stored');

  assert.equal((await f.mod(added.body.key, '/travel/beat', {})).body.code, 'notMember', 'a known key outside any network');
  const rotated = await f.staff('POST', `/v1/servers/${added.body.id}/rotate`);
  assert.equal((await f.mod(added.body.key, '/travel/beat', {})).status, 401, 'the old key stops working');
  assert.equal((await f.mod(rotated.body.key, '/travel/beat', {})).body.code, 'notMember');

  const net = (await f.staff('POST', '/v1/networks', { name: 'Lab' })).body.network.id;
  await f.staff('POST', `/v1/networks/${net}/members`, { server: added.body.id, address: '10.0.0.1', port: 2302 });
  assert.equal((await f.staff('DELETE', `/v1/servers/${added.body.id}`)).status, 409, 'not while it is in a network');
  assert.equal((await fetch(`${f.base}/healthz`).then(r => r.json())).status, 'ok');
  assert.equal((await fetch(`${f.base}/readyz`).then(r => r.json())).db, 'ok');
});

test('five reserves at once for one character: exactly one wins, the rest are told the character is travelling', async t => {
  const f = await fixture(t);
  const { a, b } = await pair(f);
  const results = await Promise.all(Array.from({ length: 5 }, () => f.mod(a.key, '/travel/transfers', { steamId: GHOST, name: 'Ghost', to: b.id })));
  assert.equal(results.filter(r => r.body.ok).length, 1, JSON.stringify(results.map(r => r.body.code)));
  assert.ok(results.filter(r => !r.body.ok).every(r => r.body.code === 'transit'));
});

test('a second API process on the same database cannot reserve the same character: the unique index holds without the queue', async t => {
  const f = await fixture(t);
  const { a, b } = await pair(f);
  // A second store over the same database stands for a second process: it does not share the first one's queue.
  const other = await new TravelStore(f.api.db, { now: () => f.clock.now }).init();
  const server = { id: a.id, name: a.name };
  const tries = await Promise.allSettled([f.api.store.reserve(server, { steamId: GHOST, to: b.id }), other.reserve(server, { steamId: GHOST, to: b.id }), other.reserve(server, { steamId: GHOST, to: b.id })]);
  assert.equal(tries.filter(x => x.status === 'fulfilled').length, 1);
  assert.ok(tries.filter(x => x.status === 'rejected').every(x => x.reason.code === 'transit'));
  assert.equal(await f.api.db.collection('transfers').countDocuments({ live: true }), 1);
});

test('claims racing for one snapshot: one land wins, whether the rivals are repeats, a second process, or the source taking it back', async t => {
  const f = await fixture(t);
  const { a, b } = await pair(f);
  const id = await committed(f, a, b);
  const lands = await Promise.all(Array.from({ length: 4 }, () => f.mod(b.key, `/travel/transfers/${id}/land`, {})));
  assert.equal(lands.filter(r => r.body.ok).length, 1);
  assert.ok(lands.filter(r => !r.body.ok).every(r => r.body.code === 'claimed'));

  // After the transit time the destination and the source may both claim. Across two processes, still one wins.
  const back = await f.mod(b.key, '/travel/transfers', { steamId: GHOST, name: 'Ghost', to: a.id });
  const text = snapshot(GHOST);
  await f.mod(b.key, `/travel/transfers/${back.body.transferId}/part`, { n: 0, data: text });
  await f.mod(b.key, `/travel/transfers/${back.body.transferId}/commit`, { parts: 1, length: Buffer.byteLength(text) });
  f.clock.now += TRANSIT_MS + 1000;
  const other = await new TravelStore(f.api.db, { now: () => f.clock.now }).init();
  const tries = await Promise.allSettled([f.api.store.land({ id: a.id }, back.body.transferId, {}), other.land({ id: b.id }, back.body.transferId, { as: 'return' })]);
  assert.equal(tries.filter(x => x.status === 'fulfilled').length, 1, JSON.stringify(tries.map(x => x.reason?.code ?? 'ok')));
  const where = (await f.mod(a.key, '/travel/ledger', { steamId: GHOST })).body;
  const winner = tries[0].status === 'fulfilled' ? a.id : b.id;
  assert.equal(where.state, 'home'); assert.equal(where.home, winner, 'the ledger names the server that won');
});

test('travel-admin sets a network up from nothing, and its key works against the API', async t => {
  const f = await fixture(t);
  const env = { ...process.env, TRAVEL_MONGO_URL: MONGO_URL, TRAVEL_DB: f.config.dbName };
  const admin = async (...a) => (await run(process.execPath, [cli, ...a], { env })).stdout;
  assert.match(await admin('token'), /^[A-Za-z0-9_-]{43}\n$/);
  const added = await admin('server', 'add', 'Chernarus', 'lab');
  const key = /^(hwt_[A-Za-z0-9_-]{43})$/m.exec(added)[1];
  const serverId = /\(([a-f0-9]{16})\)/.exec(added)[1];
  const net = /\(([a-f0-9]{16})\)/.exec(await admin('network', 'create', 'Badlands'))[1];
  const shown = await admin('member', 'add', net, serverId, '127.0.0.1', '2307', 'Chernarus');
  assert.match(shown, /127\.0\.0\.1:2307/);
  const beat = await f.mod(key, '/travel/beat', { maxPlayers: 60 });
  assert.equal(beat.body.ok, true); assert.equal(beat.body.network.name, 'Badlands'); assert.equal(beat.body.servers[0].name, 'Chernarus');
  await assert.rejects(run(process.execPath, [cli, 'member', 'add', net], { env }), /Usage/);
});
