// The owner API's polish: one error shape with stable codes, request ids, the overview, the token limiter, and the
// console's files and headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSIT_MS } from '../src/store.mjs';
import { readConfig } from '../src/config.mjs';
import { fixture } from './fixture.mjs';

const GHOST = '76561198012030000';
const snapshot = steamId => JSON.stringify({ steamId, version: 1, items: [{ t: 'Apple', p: -1 }] });

async function network(f) {
  const a = await f.api.store.addServer('Chernarus'), b = await f.api.store.addServer('Namalsk');
  const id = (await f.staff('POST', '/v1/networks', { name: 'Endfall' })).body.network.id;
  await f.staff('POST', `/v1/networks/${id}/members`, { server: a.id, address: '10.0.0.1', port: 2302, label: 'Chernarus' });
  await f.staff('POST', `/v1/networks/${id}/members`, { server: b.id, address: '10.0.0.1', port: 2502, label: 'Namalsk' });
  for (const s of [a, b]) await f.mod(s.key, '/travel/beat', { players: [], maxPlayers: 60, world: 'chernarusplus', terje: 'skills:v1', version: '0.6.0' });
  return { id, a, b };
}

test('every owner refusal answers {error, code}, with the field when one is wrong', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  const cases = [
    [await f.staff('GET', '/v1/servers', undefined, {}), 401, 'unauthorized'],
    [await f.staff('GET', '/v1/nothing-here'), 404, 'notFound'],
    [await f.staff('PUT', '/v1/servers'), 405, 'methodNotAllowed'],
    [await f.staff('GET', '/v1/networks/0123456789abcdef'), 404, 'unknownNetwork'],
    [await f.staff('POST', '/v1/servers', {}), 400, 'invalid', 'name'],
    [await f.staff('DELETE', `/v1/servers/${a.id}`), 409, 'member'],
    [await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Loop', from: a.id, to: a.id }), 400, 'invalid', 'to'],
    [await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Bad wait', from: a.id, to: b.id, waitSeconds: 500 }), 400, 'invalid', 'waitSeconds'],
    [await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'Bad zone', from: a.id, to: b.id, terminal: { x: -1, z: 0, radius: 3 } }), 400, 'invalid', 'terminal'],
    [await f.staff('DELETE', `/v1/networks/${id}/routes/0badc0de`), 404, 'unknownRoute'],
    [await f.staff('POST', `/v1/networks/${id}/send`, { steamId: GHOST, to: b.id }), 409, 'notHome'],
    [await f.staff('GET', `/v1/networks/${id}/characters?limit=9999`), 400, 'invalid', 'limit'],
  ];
  for (const [r, status, code, field] of cases) {
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(typeof r.body.error, 'string'); assert.ok(r.body.error.length > 0);
    assert.equal(r.body.code, code, JSON.stringify(r.body));
    if (field) assert.equal(r.body.field, field, JSON.stringify(r.body));
  }
  const bad = await fetch(`${f.base}/v1/servers`, { method: 'POST', headers: { authorization: `Bearer ${f.config.adminToken}`, 'content-type': 'application/json' }, body: '{nope' });
  assert.deepEqual(await bad.json(), { error: 'Invalid JSON.', code: 'badJson' });
  // The mod's wire is unchanged: a refusal without a mod code still carries its status number.
  const s = await f.mod(b.key, '/travel/groups/0123456789abcdef01234567/cancel', {});
  assert.equal(s.body.ok, false); assert.equal(s.body.code, '404');
});

test('every answer has a request id, and the logged line for a failure carries it but no token or body', async t => {
  const lines = [];
  const f = await fixture(t, { log: line => lines.push(line) });
  const r = await fetch(`${f.base}/healthz`);
  assert.match(r.headers.get('x-request-id'), /^[a-f0-9]{16}$/);
  const mine = await fetch(`${f.base}/healthz`, { headers: { 'x-request-id': 'proxy-1234abcd' } });
  assert.equal(mine.headers.get('x-request-id'), 'proxy-1234abcd', 'a proxy id is kept');
  const junk = await fetch(`${f.base}/healthz`, { headers: { 'x-request-id': 'a b' } });
  assert.match(junk.headers.get('x-request-id'), /^[a-f0-9]{16}$/, 'an unsafe id is replaced');

  f.api.store.servers = async () => { throw new Error('the disk is on fire'); };
  const failed = await fetch(`${f.base}/v1/servers`, { headers: { authorization: `Bearer ${f.config.adminToken}` } });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'Travel API temporarily unavailable.', code: 'unavailable' });
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.requestId, failed.headers.get('x-request-id'));
  assert.equal(logged.route, '/v1/servers'); assert.equal(logged.status, 503);
  assert.ok(!lines[0].includes(f.config.adminToken) && !lines[0].includes('fire'), lines[0]);
});

test('the overview shows servers, routes, character counts, live and stuck trips, and the doctor', async t => {
  const f = await fixture(t);
  f.clock.now = Date.now();
  const { id, a, b } = await network(f);
  const loose = await f.api.store.addServer('Spare');
  await f.staff('POST', `/v1/networks/${id}/routes`, { name: 'North line', code: 'NL', from: a.id, to: b.id, vehicles: true });
  const r = await f.mod(a.key, '/travel/transfers', { steamId: GHOST, name: 'Ghost', to: b.id });
  const text = snapshot(GHOST);
  await f.mod(a.key, `/travel/transfers/${r.body.transferId}/part`, { n: 0, data: text });
  await f.mod(a.key, `/travel/transfers/${r.body.transferId}/commit`, { parts: 1, length: Buffer.byteLength(text) });
  await f.mod(b.key, '/travel/home', { steamId: '76561198012030001', name: 'Held' });
  await f.staff('POST', `/v1/networks/${id}/characters/76561198012030001`, { state: 'held' });

  const live = (await f.staff('GET', '/v1/overview')).body;
  assert.equal(live.servers.find(s => s.id === loose.id).network, '');
  const net = live.networks[0];
  assert.equal(net.network.name, 'Endfall');
  const cher = net.servers.find(s => s.id === a.id);
  assert.equal(cher.version, '0.6.0'); assert.equal(cher.online, true); assert.equal(cher.terje, 'skills:v1'); assert.equal(typeof cher.beatAgeSec, 'number');
  assert.equal(net.routes[0].vehicles, true);
  assert.deepEqual(net.characters, { home: 0, transit: 1, held: 1 });
  assert.equal(net.held[0].steamId, '76561198012030001');
  assert.equal(net.transfers.length, 1); assert.equal(net.transfers[0].stuck, false);
  assert.ok(live.doctor.results.some(x => x.check === 'api' && x.level === 'OK'));
  assert.ok(live.doctor.results.some(x => x.check === 'server' && /Spare/.test(x.text)), 'the doctor warns about the loose server');

  f.clock.now += TRANSIT_MS + 60000;
  const later = (await f.staff('GET', '/v1/overview')).body;
  assert.equal(later.networks[0].transfers[0].stuck, true);
  assert.ok(later.doctor.results.some(x => x.check === 'transfers' && x.level === 'WARN'));
  const doctor = (await f.staff('GET', '/v1/doctor')).body;
  assert.equal(doctor.failed, false); assert.ok(Array.isArray(doctor.results));

  const detail = (await f.staff('GET', `/v1/networks/${id}/characters/${GHOST}`)).body;
  assert.equal(detail.character.state, 'transit'); assert.equal(detail.character.home, a.id);
});

test('the audit filters by server and staff', async t => {
  const f = await fixture(t);
  const { id, a, b } = await network(f);
  await f.staff('POST', `/v1/networks/${id}`, { inGameAdmin: true });
  await f.mod(a.key, '/travel/admin', { staff: { steamId: '76561198012050000', name: 'Vis' }, action: 'member.open', server: b.id, open: false });
  await f.mod(b.key, '/travel/admin', { staff: { steamId: '76561198012050001', name: 'Kay' }, action: 'member.open', server: b.id, open: true });
  assert.equal((await f.staff('GET', `/v1/networks/${id}/audit`)).body.audit.length, 2);
  assert.deepEqual((await f.staff('GET', `/v1/networks/${id}/audit?server=${a.id}`)).body.audit.map(x => x.staffName), ['Vis']);
  assert.deepEqual((await f.staff('GET', `/v1/networks/${id}/audit?staff=Kay`)).body.audit.map(x => x.server), [b.id]);
  assert.deepEqual((await f.staff('GET', `/v1/networks/${id}/audit?staff=76561198012050000`)).body.audit.map(x => x.staffName), ['Vis']);
});

test('wrong admin tokens are throttled per address like unknown server keys, and the right token still passes', async t => {
  const f = await fixture(t);
  const wrong = { authorization: `Bearer ${'x'.repeat(43)}` };
  let last;
  for (let i = 0; i < 31; i++) last = await f.staff('GET', '/v1/servers', undefined, wrong);
  assert.equal(last.status, 429); assert.equal(last.body.code, 'rateLimited');
  assert.equal((await f.staff('GET', '/v1/servers')).status, 200, 'the real token is never locked out');
});

test('X-Travel-Staff may be percent-encoded UTF-8', async t => {
  const f = await fixture(t);
  const { id, a } = await network(f);
  await f.mod(a.key, '/travel/home', { steamId: GHOST, name: 'Ghost' });
  await f.staff('POST', `/v1/networks/${id}/characters/${GHOST}`, { state: 'held' }, { ...{ authorization: `Bearer ${f.config.adminToken}`, 'content-type': 'application/json' }, 'x-travel-staff': encodeURIComponent('Влад') });
  const ledger = (await f.staff('GET', `/v1/networks/${id}/characters/${GHOST}`)).body.ledger;
  assert.equal(ledger[0].reason, 'held by Влад');
});

test('the console is served with strict headers, never outside its folder, and TRAVEL_CONSOLE turns it off', async t => {
  const f = await fixture(t);
  const page = await fetch(`${f.base}/console/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/); assert.match(csp, /frame-ancestors 'none'/); assert.ok(!/unsafe-inline|https?:/.test(csp), csp);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const html = await page.text();
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline script');
  assert.ok(!/\sstyle=|<style/.test(html), 'no inline style');
  assert.ok(!/https?:\/\//.test(html.replace(/<a [^>]*>/g, '')), 'no remote origin');
  const etag = page.headers.get('etag');
  assert.equal((await fetch(`${f.base}/console/`, { headers: { 'if-none-match': etag } })).status, 304);
  assert.equal((await fetch(`${f.base}/console`, { redirect: 'manual' })).headers.get('location'), '/console/');
  assert.match((await fetch(`${f.base}/console/app.js`)).headers.get('content-type'), /^text\/javascript/);
  for (const sneaky of ['/console/../package.json', '/console/%2e%2e/package.json', '/console/..%2fpackage.json', '/console/missing.js', '/console/.env']) {
    const r = await fetch(f.base + sneaky);
    assert.equal(r.status, 404, sneaky);
  }

  const off = await fixture(t, { config: { console: false } });
  assert.equal((await fetch(`${off.base}/console/`)).status, 404);
  assert.equal((await fetch(`${off.base}/healthz`)).status, 200);
  const env = { TRAVEL_MONGO_URL: 'mongodb://127.0.0.1:27017/x', TRAVEL_ADMIN_TOKEN: 'a'.repeat(43) };
  assert.equal(readConfig(env).console, true);
  assert.equal(readConfig({ ...env, TRAVEL_CONSOLE: 'off' }).console, false);
  assert.equal(readConfig({ ...env, TRAVEL_CONSOLE: '0' }).console, false);
  assert.throws(() => readConfig({ ...env, TRAVEL_CONSOLE: 'maybe' }), /TRAVEL_CONSOLE/);
});
