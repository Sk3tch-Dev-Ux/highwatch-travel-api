import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';

const STAFF = { steamId: '76561198012050000', name: 'Vis' };
const PLAYER = '76561198012050001';

async function network(f) {
  const a = await f.api.store.addServer('Chernarus'), b = await f.api.store.addServer('Namalsk'), c = await f.api.store.addServer('Nasdara');
  const id = (await f.staff('POST', '/v1/networks', { name: 'Endfall' })).body.network.id;
  for (const [s, port] of [[a, 2302], [b, 2502], [c, 2402]]) await f.staff('POST', `/v1/networks/${id}/members`, { server: s.id, address: '10.0.0.1', port, label: s.name });
  for (const s of [a, b, c]) await f.mod(s.key, '/travel/beat', { players: [], maxPlayers: 60, world: 'x', terje: 'skills:v1', version: '0.6.0' });
  return { id, a, b, c };
}
const admin = (f, s, action, extra = {}) => f.mod(s.key, '/travel/admin', { staff: STAFF, action, ...extra }).then(r => r.body);

test('in-game admin is off until the network owner turns it on', async t => {
  const f = await fixture(t);
  const { id, a } = await network(f);
  const off = await admin(f, a, 'overview');
  assert.equal(off.ok, false); assert.equal(off.code, 'adminOff');
  assert.equal((await f.staff('POST', `/v1/networks/${id}`, { inGameAdmin: true })).body.network.settings.inGameAdmin, true);
  const on = await admin(f, a, 'overview');
  assert.equal(on.ok, true); assert.equal(on.me, a.id); assert.equal(on.servers.length, 3);
  assert.equal(on.servers.find(s => s.id === a.id).version, '0.6.0');
  assert.equal((await f.mod(a.key, '/travel/admin', { action: 'overview' })).body.ok, false, 'the staff member must be named');
});

test('an admin sets up routes from and to their own server only, and every change is audited', async t => {
  const f = await fixture(t);
  const { id, a, b, c } = await network(f);
  await f.staff('POST', `/v1/networks/${id}`, { inGameAdmin: true });
  const saved = await admin(f, a, 'route.save', { route: { name: 'North line', code: 'NM', from: a.id, to: b.id, terminal: { x: 12989, z: 10244, radius: 3, label: 'Berezino terminal' }, money: 50, vehicles: true } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const route = saved.routes.find(r => r.name === 'North line');
  assert.equal(route.money, 50); assert.equal(route.vehicles, true); assert.equal(route.terminal.label, 'Berezino terminal');

  // Namalsk (the destination) sets the landing on the same route.
  const landed = await admin(f, b, 'route.save', { route: { ...route, landing: { x: 6065.6, z: 11802.1, radius: 30, label: 'Lighthouse' } } });
  assert.equal(landed.ok, true); assert.equal(landed.routes.find(r => r.id === route.id).landing.label, 'Lighthouse');

  // Nasdara is neither end: it may not create, edit or remove it.
  assert.equal((await admin(f, c, 'route.save', { route: { name: 'Elsewhere', from: a.id, to: b.id } })).code, 'notYours');
  assert.equal((await admin(f, c, 'route.save', { route: { ...route, name: 'Hijack' } })).code, 'notYours');
  assert.equal((await admin(f, c, 'route.remove', { routeId: route.id })).code, 'notYours');
  // The API's own route rules still apply.
  assert.equal((await admin(f, a, 'route.save', { route: { name: 'Bad', from: a.id, to: b.id, money: -1 } })).ok, false);

  assert.equal((await admin(f, a, 'route.remove', { routeId: route.id })).ok, true);
  const audit = (await f.staff('GET', `/v1/networks/${id}/audit`)).body.audit;
  assert.deepEqual(audit.map(x => x.action), ['route.remove', 'route.save', 'route.save']);
  assert.ok(audit.every(x => x.staffName === 'Vis'));
  assert.deepEqual(audit.map(x => x.server), [a.id, b.id, a.id]);
});

test('an admin opens and closes servers, sets the start server, and holds, releases and sends characters', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  await f.staff('POST', `/v1/networks/${id}`, { inGameAdmin: true });
  const closed = await admin(f, a, 'member.open', { server: b.id, open: false });
  assert.equal(closed.servers.find(s => s.id === b.id).open, false);
  assert.equal((await admin(f, a, 'member.open', { server: b.id, open: true })).servers.find(s => s.id === b.id).open, true);
  assert.equal((await admin(f, a, 'network.startServer', { server: a.id })).network.settings.startServer, a.id);
  assert.equal((await admin(f, a, 'network.startServer', { server: '' })).network.settings.startServer, '');

  await f.mod(a.key, '/travel/home', { steamId: PLAYER, name: 'Ghost' });
  assert.equal((await admin(f, a, 'characters', { q: 'gho' })).characters[0].steamId, PLAYER);
  assert.equal((await admin(f, a, 'character', { steamId: PLAYER })).character.home, a.id);
  assert.equal((await admin(f, a, 'character', { steamId: '76561198012059999' })).code, 'unknownCharacter');
  assert.equal((await admin(f, a, 'character.hold', { steamId: PLAYER })).character.state, 'held');
  const released = await admin(f, a, 'character.release', { steamId: PLAYER, home: b.id });
  assert.equal(released.character.state, 'home'); assert.equal(released.character.home, b.id);
  assert.equal((await admin(f, a, 'send', { steamId: PLAYER, to: a.id })).queuedOn, b.id);
  // The ledger names the staff member and the server.
  const ledger = (await f.staff('GET', `/v1/networks/${id}/characters/${PLAYER}`)).body.ledger;
  assert.ok(ledger.some(r => /Vis on Chernarus/.test(r.reason)), JSON.stringify(ledger));
  assert.equal((await admin(f, a, 'nonsense')).code, 'unknownAction');
});
