import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { RESERVE_MS, TRANSIT_MS, BEAT_STALE_MS } from '../src/store.mjs';

const GHOST = '76561198012030000', ROOK = '76561198012030001';

// A snapshot as the mod writes it, long enough to need three parts.
// The name has a two-byte letter: lengths are UTF-8 bytes on both sides, as Enforce counts them.
const snapshotFor = steamId => JSON.stringify({ steamId, version: 1, name: 'Zoë', characterType: 'SurvivorM_Mirek', items: Array.from({ length: 900 }, (_, i) => ({ t: 'Apple', p: -1, i })) });
const split = (text, size) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

async function network(f) {
  const a = await f.api.store.addServer('Chernarus'), b = await f.api.store.addServer('Livonia');
  const net = await f.staff('POST', '/v1/networks', { name: 'Badlands' });
  assert.equal(net.status, 201);
  const id = net.body.network.id;
  assert.equal((await f.staff('POST', `/v1/networks/${id}/members`, { server: a.id, address: '10.0.0.1', port: 2302, label: 'Chernarus' })).status, 200);
  assert.equal((await f.staff('POST', `/v1/networks/${id}/members`, { server: b.id, address: '10.0.0.2', port: 2402, label: 'Livonia' })).status, 200);
  for (const s of [a, b]) assert.equal((await f.mod(s.key, '/travel/beat', { players: [], maxPlayers: 60, world: 'x', terje: 'skills:v1' })).body.ok, true);
  return { id, a, b };
}

async function send(f, from, to, steamId) {
  const r = await f.mod(from.key, '/travel/transfers', { steamId, name: 'Ghost', to: to.id });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const text = snapshotFor(steamId);
  const parts = split(text, r.body.partChars);
  for (const [n, data] of parts.entries()) assert.equal((await f.mod(from.key, `/travel/transfers/${r.body.transferId}/part`, { n, data })).body.ok, true);
  assert.equal((await f.mod(from.key, `/travel/transfers/${r.body.transferId}/commit`, { parts: parts.length, length: text.length })).body.code, 'length', 'a UTF-16 count is refused');
  const c = await f.mod(from.key, `/travel/transfers/${r.body.transferId}/commit`, { parts: parts.length, length: Buffer.byteLength(text, 'utf8') });
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
  return { id: r.body.transferId, text };
}

test('a character moves once, the second claim is refused, and the ledger follows it', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  const lone = await f.api.store.addServer('Elsewhere');
  assert.equal((await f.mod(lone.key, '/travel/beat', {})).body.code, 'notMember', 'a server outside any network is told so in the body');
  assert.equal((await f.mod('hwt_' + 'n'.repeat(43), '/travel/beat', {})).status, 401, 'an unknown key keeps its real status');

  // First inbox call carries the whole ledger (empty) and a cursor.
  const first = await f.mod(b.key, '/travel/inbox', { wait: 0 });
  assert.equal(first.body.ledger.full, true);

  // B waits on its inbox; A sends Ghost. Every ledger change wakes B (the reservation records Ghost as first
  // seen on A, the commit moves him to transit), so B polls again with its cursor, as the mod does, until the
  // arrival is there. A woken poll answers at once instead of running out its wait.
  let ledgerAfter = first.body.ledger.cursor;
  const waiting = f.mod(b.key, '/travel/inbox', { wait: 15000, ledgerAfter, after: first.body.cursor });
  const started = Date.now();
  const trip = await send(f, a, b, GHOST);
  let inbox = await waiting;
  assert.ok(Date.now() - started < 5000, 'the long-poll was woken, not timed out');
  for (let i = 0; i < 5 && !inbox.body.arrivals.length; i++) { ledgerAfter = inbox.body.ledger.cursor; inbox = await f.mod(b.key, '/travel/inbox', { wait: 0, ledgerAfter, after: inbox.body.cursor }); }
  assert.ok(inbox.body.ledger.changes.some(c => c.steamId === GHOST && c.state === 'transit' && c.to === b.id) || inbox.body.arrivals.length, 'B learns Ghost is on his way');
  assert.equal(inbox.body.arrivals.length, 1);
  const arrival = inbox.body.arrivals[0];
  assert.equal(arrival.steamId, GHOST); assert.equal(arrival.from, a.id); assert.equal(arrival.length, Buffer.byteLength(trip.text, 'utf8'));

  // Once B holds the arrival (it says so in `seen`), the pending arrival no longer cuts its long-poll short.
  const held = Date.now();
  const quietPoll = await f.mod(b.key, '/travel/inbox', { wait: 300, ledgerAfter: inbox.body.ledger.cursor, after: inbox.body.cursor, seen: [arrival.transferId] });
  assert.ok(Date.now() - held >= 250, 'a known arrival is not news');
  assert.equal(quietPoll.body.arrivals.length, 1, 'but it is still listed');

  // The ledger now says transit, and A can neither send Ghost again nor read the snapshot early.
  assert.equal((await f.mod(a.key, '/travel/ledger', { steamId: GHOST })).body.state, 'transit');
  assert.equal((await f.mod(a.key, '/travel/transfers', { steamId: GHOST, to: b.id })).body.code, 'transit');
  assert.equal((await f.mod(a.key, `/travel/transfers/${trip.id}/reclaim`)).body.code, 'notExpired');

  // The download is the exact committed text; a wrong token is a plain 404.
  const got = await fetch(f.base + arrival.path);
  assert.equal(got.status, 200); assert.equal(await got.text(), trip.text);
  assert.equal((await fetch(f.base + arrival.path.replace(/[A-Za-z0-9_-]{43}$/, 'x'.repeat(43)))).status, 404);

  // One claim wins. The second, and a claim by the wrong server, never build a character.
  assert.equal((await f.mod(a.key, `/travel/transfers/${trip.id}/land`, {})).status, 403);
  assert.equal((await f.mod(b.key, `/travel/transfers/${trip.id}/land`, { length: Buffer.byteLength(trip.text, 'utf8') })).body.ok, true);
  assert.equal((await f.mod(b.key, `/travel/transfers/${trip.id}/land`, {})).body.code, 'claimed');
  assert.equal((await fetch(f.base + arrival.path)).status, 404, 'a landed snapshot is gone');
  const ledger = await f.mod(b.key, '/travel/ledger', { steamId: GHOST });
  assert.equal(ledger.body.state, 'home'); assert.equal(ledger.body.home, b.id);
  assert.equal((await f.mod(a.key, '/travel/transfers', { steamId: GHOST, to: b.id })).body.code, 'notHome', 'A no longer holds Ghost');

  // Staff see the whole story.
  const hist = await f.staff('GET', `/v1/networks/${id}/characters/${GHOST}`);
  assert.deepEqual(hist.body.ledger.map(r => r.reason), ['arrived', 'departed', 'first seen']);
  assert.equal(hist.body.transfers[0].state, 'landed');
});

test('an unclaimed character goes back to its source after the transit time, and only once', async t => {
  const f = await fixture(t);
  const { a, b } = await network(f);
  const trip = await send(f, a, b, GHOST);
  f.clock.now += TRANSIT_MS + 1000;
  for (const s of [a, b]) await f.mod(s.key, '/travel/beat', { terje: 'skills:v1' });
  const inbox = await f.mod(a.key, '/travel/inbox', { wait: 0, ledgerAfter: 1 });
  assert.deepEqual(inbox.body.returns.map(r => r.transferId), [trip.id]);
  const back = await f.mod(a.key, `/travel/transfers/${trip.id}/reclaim`);
  assert.equal(back.body.ok, true);
  assert.equal(await (await fetch(f.base + back.body.path)).text(), trip.text);
  assert.equal((await f.mod(a.key, `/travel/transfers/${trip.id}/land`, { as: 'return' })).body.ok, true);
  // B comes back late with the arrival it never processed: refused.
  assert.equal((await f.mod(b.key, `/travel/transfers/${trip.id}/land`, {})).body.code, 'claimed');
  assert.equal((await f.mod(a.key, '/travel/ledger', { steamId: GHOST })).body.home, a.id);
});

test('refusals the player sees (offline, closed, Terje mismatch, lapsed reservation, held)', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  assert.equal((await f.mod(a.key, '/travel/beat', { terje: 'skills:v2' })).body.ok, true);
  assert.equal((await f.mod(a.key, '/travel/transfers', { steamId: GHOST, to: b.id })).body.code, 'terje');
  await f.mod(a.key, '/travel/beat', { terje: 'skills:v1' });
  f.clock.now += BEAT_STALE_MS + 1000;
  await f.mod(a.key, '/travel/beat', { terje: 'skills:v1' });
  assert.equal((await f.mod(a.key, '/travel/transfers', { steamId: GHOST, to: b.id })).body.code, 'offline');
  await f.mod(b.key, '/travel/beat', { terje: 'skills:v1' });
  await f.staff('POST', `/v1/networks/${id}/members`, { server: b.id, address: '10.0.0.2', port: 2402, open: false });
  assert.equal((await f.mod(a.key, '/travel/transfers', { steamId: GHOST, to: b.id })).body.code, 'closed');
  await f.staff('POST', `/v1/networks/${id}/members`, { server: b.id, address: '10.0.0.2', port: 2402 });

  const r = await f.mod(a.key, '/travel/transfers', { steamId: ROOK, to: b.id });
  assert.equal(r.body.ok, true);
  f.clock.now += RESERVE_MS + 1000;
  assert.equal((await f.mod(a.key, `/travel/transfers/${r.body.transferId}/part`, { n: 0, data: '{}' })).body.code, 'lapsed');

  assert.equal((await f.staff('POST', `/v1/networks/${id}/characters/${ROOK}`, { state: 'held' })).status, 200);
  await f.mod(b.key, '/travel/beat', {}); await f.mod(a.key, '/travel/beat', {});
  assert.equal((await f.mod(a.key, '/travel/transfers', { steamId: ROOK, to: b.id })).body.code, 'held');
});

test('global chat reaches the other servers, staff send queues on the home server, a start server gates new characters', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  const cur = (await f.mod(b.key, '/travel/inbox', { wait: 0 })).body.cursor;
  assert.equal((await f.mod(a.key, '/travel/chat', { steamId: GHOST, name: 'Ghost', text: 'anyone near Zelenogorsk?\n' })).body.ok, true);
  const inbox = await f.mod(b.key, '/travel/inbox', { wait: 0, after: cur, ledgerAfter: 1 });
  assert.equal(inbox.body.queue.length, 1);
  assert.equal(inbox.body.queue[0].kind, 'chat'); assert.equal(inbox.body.queue[0].text, 'anyone near Zelenogorsk?'); assert.equal(inbox.body.queue[0].from, a.id);
  assert.equal((await f.mod(a.key, '/travel/inbox', { wait: 0, after: 0, ledgerAfter: 1 })).body.queue.length, 0, 'the sender does not get its own line back');

  assert.equal((await f.staff('POST', `/v1/networks/${id}`, { startServer: a.id })).status, 200);
  assert.equal((await f.mod(b.key, '/travel/home', { steamId: ROOK, name: 'Rook' })).body.code, 'startServer');
  assert.equal((await f.mod(a.key, '/travel/home', { steamId: ROOK, name: 'Rook' })).body.created, true);
  const sent = await f.staff('POST', `/v1/networks/${id}/send`, { steamId: ROOK, to: b.id });
  assert.equal(sent.body.queuedOn, a.id);
  const onA = await f.mod(a.key, '/travel/inbox', { wait: 0, after: 0, ledgerAfter: 1 });
  assert.equal(onA.body.queue.at(-1).kind, 'send'); assert.equal(onA.body.queue.at(-1).to, b.id);
  assert.equal((await f.staff('DELETE', `/v1/networks/${id}/members/${b.id}`)).status, 200);
  assert.equal((await f.staff('GET', '/v1/networks')).body.networks[0].servers.length, 1);
});

test('an empty network long-polls instead of answering at once (ledger cursor 0 is a real cursor)', async t => {
  const f = await fixture(t);
  const { a } = await network(f);
  const first = await f.mod(a.key, '/travel/inbox', { ledgerAfter: -1, wait: 0 });
  assert.equal(first.body.ledger.full, true); assert.equal(first.body.ledger.cursor, 0);
  const started = Date.now();
  const next = await f.mod(a.key, '/travel/inbox', { ledgerAfter: 0, after: first.body.cursor, wait: 300 });
  assert.ok(Date.now() - started >= 250, 'the poll was held');
  assert.equal(next.body.ledger.full, false); assert.equal(next.body.ledger.changes.length, 0);
});

test('routes carry a landing zone to the destination, keep a cooldown, and held luggage is recorded on landing', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  assert.equal((await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Bad', from: a.id, to: a.id })).status, 400, 'a route needs two different members');
  assert.equal((await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Bad', from: a.id, to: b.id, cost: [{ type: 'Apple; DROP', count: 1 }] })).status, 400, 'a cost is a class name');
  assert.equal((await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Bad', from: a.id, to: b.id, hours: '25-99' })).status, 400);
  const saved = await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Ferry', from: a.id, to: b.id, terminal: { x: 7500, z: 2700, radius: 30 }, landing: { x: 1800, z: 7300, radius: 60 }, cost: [{ type: 'BandageDressing', count: 1 }], maxWeightKg: 40, hours: '06-22', cooldownMin: 30, waitSeconds: 10 });
  assert.equal(saved.status, 200);
  const route = saved.body.routes[0];
  assert.equal(route.name, 'Ferry'); assert.match(route.id, /^[a-f0-9]{8}$/); assert.deepEqual(route.landing, { x: 1800, z: 7300, radius: 60, label: '' });
  // The beat hands every server the network's routes.
  assert.equal((await f.mod(a.key, '/travel/beat', { terje: 'skills:v1' })).body.routes[0].id, route.id);

  // A route must run from here to there.
  assert.equal((await f.mod(b.key, '/travel/transfers', { steamId: GHOST, to: a.id, route: route.id })).body.code, 'unknownRoute');
  const r = await f.mod(a.key, '/travel/transfers', { steamId: GHOST, name: 'Ghost', to: b.id, route: route.id });
  assert.equal(r.body.ok, true);
  const text = snapshotFor(GHOST);
  assert.equal((await f.mod(a.key, `/travel/transfers/${r.body.transferId}/part`, { n: 0, data: text })).body.ok, true);
  assert.equal((await f.mod(a.key, `/travel/transfers/${r.body.transferId}/commit`, { parts: 1, length: Buffer.byteLength(text, 'utf8') })).body.ok, true);
  const arrival = (await f.mod(b.key, '/travel/inbox', { wait: 0 })).body.arrivals[0];
  assert.equal(arrival.route, route.id); assert.deepEqual(arrival.landing, { x: 1800, z: 7300, radius: 60 });
  assert.equal((await f.mod(b.key, `/travel/transfers/${r.body.transferId}/land`, { held: ['RFFS_Heli_Part', 'RFFS_Heli_Part', 'Bad name!'] })).body.ok, true);
  const hist = await f.staff('GET', `/v1/networks/${id}/characters/${GHOST}`);
  assert.deepEqual(hist.body.held.map(h => [h.className, h.count]), [['RFFS_Heli_Part', 2]], 'counted, and a bad class name is dropped');
  assert.equal(hist.body.transfers[0].route, route.id);

  // Back on a route with a cooldown: refused until 30 minutes after the last departure.
  const back = await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Ferry back', from: b.id, to: a.id, cooldownMin: 30 });
  const backId = back.body.routes.find(x => x.name === 'Ferry back').id;
  const refused = await f.mod(b.key, '/travel/transfers', { steamId: GHOST, to: a.id, route: backId });
  assert.equal(refused.body.code, 'cooldown'); assert.match(refused.body.error, /30 minutes/);
  f.clock.now += 31 * 60000;
  for (const s of [a, b]) await f.mod(s.key, '/travel/beat', { terje: 'skills:v1' });
  assert.equal((await f.mod(b.key, '/travel/transfers', { steamId: GHOST, name: 'Ghost', to: a.id, route: backId })).body.ok, true);
  assert.equal((await f.staff('DELETE', `/v1/networks/${id}/routes/${route.id}`)).body.routes.length, 1);
});

test('route codes and zone labels reach 0.3.0 mods only, and the quote gives each route its cooldown left', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  assert.equal((await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Bad', from: a.id, to: b.id, code: 'TOOLONG' })).status, 400);
  const saved = await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Northern Line', code: 'nl', from: a.id, to: b.id, terminal: { x: 12989, z: 10200, radius: 40, label: ' Berezino station\u0007 ' }, landing: { x: 1858, z: 7330, radius: 250, label: 'Topolin' }, cooldownMin: 30 });
  const route = saved.body.routes[0];
  assert.equal(route.code, 'NL', 'upper-cased');
  assert.equal(route.terminal.label, 'Berezino station', 'control characters and spaces cleaned');

  // A 0.2.0 mod gets neither key: it reads routes into classes without them.
  const old = (await f.mod(a.key, '/travel/beat', { terje: 'skills:v1', version: '0.2.0' })).body.routes[0];
  assert.equal('code' in old, false); assert.equal('label' in old.terminal, false); assert.equal('label' in old.landing, false);
  const now = (await f.mod(a.key, '/travel/beat', { terje: 'skills:v1', version: '0.3.0' })).body.routes[0];
  assert.equal(now.code, 'NL'); assert.equal(now.landing.label, 'Topolin');
  // A route saved before codes existed still reads back with empty ones.
  const plain = await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Back', from: b.id, to: a.id });
  const back = plain.body.routes.find(r => r.name === 'Back');
  assert.equal(back.code, ''); assert.deepEqual(back.terminal, { x: 0, z: 0, radius: 0, label: '' });

  // The arrival's landing follows the same rule, by the destination's version.
  await f.mod(b.key, '/travel/beat', { terje: 'skills:v1', version: '0.3.0' });
  const quote0 = await f.mod(a.key, '/travel/quote', { steamId: GHOST });
  assert.deepEqual(quote0.body, { ok: true, routes: [{ id: route.id, cooldownLeftSec: 0 }] }, 'no departures yet, and only routes from this server');
  const r = await f.mod(a.key, '/travel/transfers', { steamId: GHOST, name: 'Ghost', to: b.id, route: route.id });
  const text = snapshotFor(GHOST);
  await f.mod(a.key, `/travel/transfers/${r.body.transferId}/part`, { n: 0, data: text });
  assert.equal((await f.mod(a.key, `/travel/transfers/${r.body.transferId}/commit`, { parts: 1, length: Buffer.byteLength(text, 'utf8') })).body.ok, true);
  assert.equal((await f.mod(b.key, '/travel/inbox', { wait: 0 })).body.arrivals[0].landing.label, 'Topolin');
  f.clock.now += 10 * 60000;
  assert.equal((await f.mod(a.key, '/travel/quote', { steamId: GHOST })).body.routes[0].cooldownLeftSec, 20 * 60);
  assert.equal((await f.mod(a.key, '/travel/quote', { steamId: 'nope' })).body.ok, false, 'a bad Steam64 is refused the way the mod reads refusals');
});

test('money fares: validated, held back from mods older than 0.5.0, and refused to them on reserve', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  assert.equal((await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Bad', from: a.id, to: b.id, money: -5 })).status, 400);
  assert.equal((await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Bad', from: a.id, to: b.id, money: 2.5 })).status, 400);
  assert.equal((await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Bad', from: a.id, to: b.id, money: 10000001 })).status, 400);
  const saved = await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Paid', from: a.id, to: b.id, money: 250, moneyFromAtm: true });
  const paid = saved.body.routes[0];
  assert.equal(paid.money, 250); assert.equal(paid.moneyFromAtm, true);
  const free = (await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Free', from: a.id, to: b.id, moneyFromAtm: true })).body.routes.find(r => r.name === 'Free');
  assert.equal(free.money, 0); assert.equal(free.moneyFromAtm, false, 'no bank top-up on a route with no fare');

  // A 0.4.0 mod reads routes into classes without the money keys, and cannot charge a fare: it never sees them and
  // reserve refuses the route, so a money route never runs free.
  const old = (await f.mod(a.key, '/travel/beat', { terje: 'skills:v1', version: '0.4.0' })).body.routes.find(r => r.name === 'Paid');
  assert.equal('money' in old, false); assert.equal('moneyFromAtm' in old, false);
  const refused = await f.mod(a.key, '/travel/transfers', { steamId: GHOST, name: 'Ghost', to: b.id, route: paid.id });
  assert.equal(refused.body.code, 'upgrade');
  assert.equal((await f.mod(a.key, '/travel/transfers', { steamId: ROOK, name: 'Rook', to: b.id, route: free.id })).body.ok, true, 'a free route still runs on 0.4.0');

  const now = (await f.mod(a.key, '/travel/beat', { terje: 'skills:v1', version: '0.5.0' })).body.routes.find(r => r.name === 'Paid');
  assert.equal(now.money, 250); assert.equal(now.moneyFromAtm, true);
  assert.equal((await f.mod(a.key, '/travel/transfers', { steamId: GHOST, name: 'Ghost', to: b.id, route: paid.id })).body.ok, true);
});
