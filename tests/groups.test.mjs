import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { TRANSIT_MS } from '../src/store.mjs';

const LEAD = '76561198012040000', TWO = '76561198012040001', THREE = '76561198012040002';
const V6 = { terje: 'skills:v1', version: '0.6.0' };

async function network(f, beat = V6) {
  const a = await f.api.store.addServer('Chernarus'), b = await f.api.store.addServer('Namalsk');
  const id = (await f.staff('POST', '/v1/networks', { name: 'Endfall' })).body.network.id;
  await f.staff('POST', `/v1/networks/${id}/members`, { server: a.id, address: '10.0.0.1', port: 2302, label: 'Chernarus' });
  await f.staff('POST', `/v1/networks/${id}/members`, { server: b.id, address: '10.0.0.1', port: 2502, label: 'Namalsk' });
  for (const s of [a, b]) assert.equal((await f.mod(s.key, '/travel/beat', { players: [], maxPlayers: 60, world: 'x', ...beat })).body.ok, true);
  return { id, a, b };
}

// Uploads and commits one snapshot for a transfer; the vehicle's snapshot carries the vehicle id as its steamId.
async function commit(f, from, transferId, steamId) {
  const text = JSON.stringify({ steamId, version: 1, items: [{ t: 'Apple', p: -1 }] });
  assert.equal((await f.mod(from.key, `/travel/transfers/${transferId}/part`, { n: 0, data: text })).body.ok, true);
  return (await f.mod(from.key, `/travel/transfers/${transferId}/commit`, { parts: 1, length: Buffer.byteLength(text, 'utf8') })).body;
}

const party = [{ steamId: LEAD, name: 'Lead' }, { steamId: TWO, name: 'Two' }, { steamId: THREE, name: 'Three' }];

test('a party with a vehicle: reserved together, shown to the destination only when all are committed, landed each', async t => {
  const f = await fixture(t);
  const { a, b } = await network(f);
  const r = (await f.mod(a.key, '/travel/groups', { members: party, to: b.id, vehicle: true })).body;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transfers.length, 3);
  assert.match(r.vehicleTransferId, /^[a-f0-9]{24}$/);
  assert.equal(r.vehicleId, `v${r.group}`);

  // Two of three members and the vehicle committed: the destination still sees nothing.
  assert.equal((await commit(f, a, r.transfers[0].transferId, LEAD)).groupReady, false);
  assert.equal((await commit(f, a, r.transfers[1].transferId, TWO)).groupReady, false);
  assert.equal((await commit(f, a, r.vehicleTransferId, r.vehicleId)).groupReady, false);
  assert.equal((await f.mod(b.key, '/travel/inbox', { wait: 0 })).body.arrivals.length, 0);
  assert.equal((await f.mod(b.key, `/travel/transfers/${r.transfers[0].transferId}/land`, {})).body.code, 'notReady', 'no claim before the party is ready');

  // The last one makes the group ready; the destination sees all four, with group and kind.
  assert.equal((await commit(f, a, r.transfers[2].transferId, THREE)).groupReady, true);
  const arrivals = (await f.mod(b.key, '/travel/inbox', { wait: 0 })).body.arrivals;
  assert.equal(arrivals.length, 4);
  assert.ok(arrivals.every(x => x.group === r.group));
  assert.deepEqual(arrivals.map(x => x.kind).sort(), ['character', 'character', 'character', 'vehicle']);

  // Each lands on its own claim; the vehicle has no ledger row.
  for (const x of arrivals) assert.equal((await f.mod(b.key, `/travel/transfers/${x.transferId}/land`, {})).body.ok, true);
  for (const s of [LEAD, TWO, THREE]) assert.equal((await f.mod(b.key, '/travel/ledger', { steamId: s })).body.home, b.id);
  assert.equal(await f.api.store.c.characters.countDocuments({ steamId: r.vehicleId }), 0);
});

test('a party is all or nothing: a refusal names the member and writes nothing', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  // Three is held by staff.
  await f.mod(a.key, '/travel/home', { steamId: THREE, name: 'Three' });
  assert.equal((await f.staff('POST', `/v1/networks/${id}/characters/${THREE}`, { state: 'held' })).status, 200);
  const r = (await f.mod(a.key, '/travel/groups', { members: party, to: b.id })).body;
  assert.equal(r.ok, false); assert.equal(r.code, 'held'); assert.equal(r.who, THREE);
  assert.equal(await f.api.store.c.transfers.countDocuments({}), 0, 'nothing reserved');

  // Too many, twice the same, and a destination without room for all of them.
  assert.equal((await f.mod(a.key, '/travel/groups', { members: [...party, { steamId: '76561198012040003' }, { steamId: '76561198012040004' }], to: b.id })).body.ok, false);
  assert.equal((await f.mod(a.key, '/travel/groups', { members: [party[0], party[0]], to: b.id })).body.ok, false);
  await f.mod(b.key, '/travel/beat', { players: Array.from({ length: 59 }, (_, i) => ({ steamId: `7656119801205${String(i).padStart(4, '0')}`, name: 'x' })), maxPlayers: 60, world: 'x', ...V6 });
  const full = (await f.mod(a.key, '/travel/groups', { members: party.slice(0, 2), to: b.id })).body;
  assert.equal(full.code, 'full'); assert.match(full.error, /room for 1 more, not 2/);
});

test('a party trip called off before it is ready puts committed members back home; after, it is too late', async t => {
  const f = await fixture(t);
  const { a, b } = await network(f);
  const r = (await f.mod(a.key, '/travel/groups', { members: party.slice(0, 2), to: b.id })).body;
  await commit(f, a, r.transfers[0].transferId, LEAD);
  assert.equal((await f.mod(a.key, '/travel/ledger', { steamId: LEAD })).body.state, 'transit');
  const off = (await f.mod(a.key, `/travel/groups/${r.group}/cancel`, {})).body;
  assert.equal(off.ok, true); assert.equal(off.cancelled, 2);
  const lead = (await f.mod(a.key, '/travel/ledger', { steamId: LEAD })).body;
  assert.equal(lead.state, 'home'); assert.equal(lead.home, a.id);
  assert.equal((await f.mod(b.key, '/travel/inbox', { wait: 0 })).body.arrivals.length, 0);

  // A second party leaves; once it is ready the cancel is refused.
  const s = (await f.mod(a.key, '/travel/groups', { members: party.slice(0, 2), to: b.id })).body;
  assert.equal(s.ok, true, JSON.stringify(s));
  await commit(f, a, s.transfers[0].transferId, LEAD);
  await commit(f, a, s.transfers[1].transferId, TWO);
  assert.equal((await f.mod(a.key, `/travel/groups/${s.group}/cancel`, {})).body.code, 'departed');
  // Another server cannot call it off.
  assert.equal((await f.mod(b.key, `/travel/groups/${s.group}/cancel`, {})).body.code, '404');
});

test('a party member the destination never claims goes back to the source after the transit time', async t => {
  const f = await fixture(t);
  const { a, b } = await network(f);
  const r = (await f.mod(a.key, '/travel/groups', { members: party.slice(0, 2), to: b.id })).body;
  await commit(f, a, r.transfers[0].transferId, LEAD);
  await commit(f, a, r.transfers[1].transferId, TWO);
  assert.equal((await f.mod(b.key, `/travel/transfers/${r.transfers[0].transferId}/land`, {})).body.ok, true);
  f.clock.now += TRANSIT_MS + 1000;
  const back = (await f.mod(a.key, '/travel/inbox', { wait: 0 })).body.returns;
  assert.deepEqual(back.map(x => x.steamId), [TWO]);
  assert.equal((await f.mod(a.key, `/travel/transfers/${r.transfers[1].transferId}/land`, { as: 'return' })).body.ok, true);
  assert.equal((await f.mod(a.key, '/travel/ledger', { steamId: TWO })).body.home, a.id);
  assert.equal((await f.mod(a.key, '/travel/ledger', { steamId: LEAD })).body.home, b.id);
});

test('a car takes only a route marked vehicles; mods older than 0.6.0 never see the flag', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  const saved = (await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Rail', from: a.id, to: b.id })).body.routes[0];
  assert.equal(saved.vehicles, false);
  assert.equal((await f.mod(a.key, '/travel/groups', { members: party.slice(0, 1), to: b.id, route: saved.id, vehicle: true })).body.code, 'noVehicles');
  const road = (await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Road', from: a.id, to: b.id, vehicles: true })).body.routes.find(r => r.name === 'Road');
  assert.equal(road.vehicles, true);
  assert.equal((await f.mod(a.key, '/travel/groups', { members: party.slice(0, 1), to: b.id, route: road.id, vehicle: true })).body.ok, true);
  // A vehicle route is for cars only: nobody on foot, alone or as a party.
  assert.equal((await f.mod(a.key, '/travel/transfers', { steamId: TWO, name: 'Two', to: b.id, route: road.id })).body.code, 'vehicleOnly');
  assert.equal((await f.mod(a.key, '/travel/groups', { members: party.slice(1, 2), to: b.id, route: road.id })).body.code, 'vehicleOnly');
  const old = (await f.mod(a.key, '/travel/beat', { players: [], maxPlayers: 60, world: 'x', terje: 'skills:v1', version: '0.5.0' })).body.routes[0];
  assert.equal('vehicles' in old, false);
});

test('parties need 0.6.0 on both ends; older destinations get no group keys', async t => {
  const f = await fixture(t);
  const { a, b } = await network(f, { terje: 'skills:v1', version: '0.5.0' });
  assert.equal((await f.mod(a.key, '/travel/groups', { members: party.slice(0, 1), to: b.id })).body.code, 'upgrade');
  await f.mod(a.key, '/travel/beat', { players: [], maxPlayers: 60, world: 'x', ...V6 });
  assert.equal((await f.mod(a.key, '/travel/groups', { members: party.slice(0, 1), to: b.id })).body.code, 'upgrade', 'the destination is still 0.5.0');
  // A solo trip to a 0.5.0 destination: its arrival has no group or kind key.
  const solo = (await f.mod(a.key, '/travel/transfers', { steamId: LEAD, name: 'Lead', to: b.id })).body;
  await commit(f, a, solo.transferId, LEAD);
  const arrival = (await f.mod(b.key, '/travel/inbox', { wait: 0 })).body.arrivals[0];
  assert.equal('group' in arrival, false); assert.equal('kind' in arrival, false);
});

test('a server with routes cannot leave the network until its routes are removed', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  const route = (await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'North line', from: a.id, to: b.id })).body.routes[0];
  const refused = await f.staff('DELETE', `/v1/networks/${id}/members/${b.id}`);
  assert.equal(refused.status, 409); assert.match(refused.body.error, /North line/);
  assert.equal((await f.staff('DELETE', `/v1/networks/${id}/routes/${route.id}`)).status, 200);
  assert.equal((await f.staff('DELETE', `/v1/networks/${id}/members/${b.id}`)).status, 200);
});
