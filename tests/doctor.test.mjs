import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TRANSIT_MS, BEAT_STALE_MS } from '../src/store.mjs';
import { expectedIndexes } from '../src/doctor.mjs';
import { fixture, MONGO_URL } from './fixture.mjs';

const GHOST = '76561198012030000';
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/travel-admin.mjs', import.meta.url));
const snapshot = steamId => JSON.stringify({ steamId, version: 1, items: [{ t: 'Apple', p: -1 }] });

// The doctor as an admin runs it: the CLI in its own process. Answers its lines and exit code.
async function doctor(env) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith('TRAVEL_')) delete clean[k];
  try {
    const { stdout } = await run(process.execPath, [cli, 'doctor'], { env: { ...clean, ...env }, timeout: 60000 });
    return { code: 0, lines: stdout.trim().split('\n') };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, lines: String(error.stdout).trim().split('\n') };
  }
}
const line = (lines, level, check, pattern) => lines.find(l => l.startsWith(level.padEnd(4) + ' ' + check.padEnd(9)) && pattern.test(l));
const envFor = f => ({ TRAVEL_MONGO_URL: MONGO_URL, TRAVEL_DB: f.config.dbName, TRAVEL_ADMIN_TOKEN: f.config.adminToken, TRAVEL_HOST: '127.0.0.1', TRAVEL_PORT: new URL(f.base).port });

async function network(f) {
  const a = await f.api.store.addServer('Chernarus'), b = await f.api.store.addServer('Nasdara');
  const net = (await f.staff('POST', '/v1/networks', { name: 'Endfall' })).body.network.id;
  await f.staff('POST', `/v1/networks/${net}/members`, { server: a.id, address: '10.0.0.1', port: 2302, label: 'Chernarus' });
  await f.staff('POST', `/v1/networks/${net}/members`, { server: b.id, address: '10.0.0.1', port: 2402, label: 'Nasdara' });
  const routed = await f.staff('POST', `/v1/networks/${net}/routes`, { name: 'Rail to Nasdara', from: a.id, to: b.id });
  assert.equal(routed.status, 200, JSON.stringify(routed.body));
  return { net, a, b, route: routed.body.routes[0].id };
}

test('the doctor lists the indexes the store makes, read from the store itself', async () => {
  const wanted = await expectedIndexes();
  assert.ok(wanted.length >= 15, `${wanted.length} indexes`);
  assert.ok(wanted.some(w => w.collection === 'transfers' && w.name === 'one_live_trip' && w.unique), 'the one live trip index is checked');
});

test('a healthy network: every check is OK (MongoDB may warn that authentication is off) and the exit code is 0', async t => {
  const f = await fixture(t);
  f.clock.now = Date.now();
  const { a, b } = await network(f);
  for (const s of [a, b]) assert.equal((await f.mod(s.key, '/travel/beat', { maxPlayers: 60, version: '0.5.0' })).body.ok, true);
  const { code, lines } = await doctor(envFor(f));
  assert.equal(code, 0, lines.join('\n'));
  assert.ok(lines.every(l => /^(OK|WARN) /.test(l)), lines.join('\n'));
  for (const check of ['token', 'indexes', 'network', 'routes', 'transfers', 'api']) assert.ok(line(lines, 'OK', check, /./), `${check} OK:\n${lines.join('\n')}`);
  assert.ok(line(lines, 'OK', 'server', /Chernarus .*online, last beat \d+ s ago, mod 0\.5\.0/), lines.join('\n'));
  assert.ok(line(lines, 'OK', 'server', /Nasdara .*online/), lines.join('\n'));
  assert.ok(lines.some(l => /^(OK|WARN) +mongodb/.test(l)), lines.join('\n'));
  assert.ok(!lines.join('\n').includes(f.config.adminToken), 'the token is never printed');
});

test('a broken setup: bad token, missing index, a route off the network, a stuck trip, a silent server, mixed versions, no API', async t => {
  const f = await fixture(t);
  f.clock.now = Date.now();
  const { net, a, b } = await network(f);
  const c = await f.api.store.addServer('Namalsk');
  await f.staff('POST', `/v1/networks/${net}/members`, { server: c.id, address: '10.0.0.1', port: 2502, label: 'Namalsk' });
  const d = await f.api.store.addServer('Chernobyl');
  await f.staff('POST', `/v1/networks/${net}/members`, { server: d.id, address: '10.0.0.1', port: 2602, label: 'Chernobyl' });
  assert.equal((await f.staff('POST', `/v1/networks/${net}/routes`, { name: 'Rail to Chernobyl', from: a.id, to: d.id })).status, 200);

  // A trip committed long enough ago that its transit time is over: nobody claimed it.
  f.clock.now = Date.now() - TRANSIT_MS - 5 * 60000;
  for (const s of [a, b]) await f.mod(s.key, '/travel/beat', { maxPlayers: 60, version: s === a ? '0.5.0' : '0.4.0' });
  const r = await f.mod(a.key, '/travel/transfers', { steamId: GHOST, name: 'Ghost', to: b.id });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const text = snapshot(GHOST);
  await f.mod(a.key, `/travel/transfers/${r.body.transferId}/part`, { n: 0, data: text });
  assert.equal((await f.mod(a.key, `/travel/transfers/${r.body.transferId}/commit`, { parts: 1, length: Buffer.byteLength(text) })).body.ok, true);
  f.clock.now = Date.now();
  // Nasdara beats now; Chernarus's last beat is the old one, so it reads as offline. Namalsk was silent from the start.
  await f.mod(b.key, '/travel/beat', { maxPlayers: 60, version: '0.4.0' });
  assert.ok(Date.now() - (await f.api.db.collection('members').findOne({ _id: a.id })).beatAt >= BEAT_STALE_MS);

  // Chernobyl leaves the network, but its route stays behind. And one index is gone.
  assert.equal((await f.staff('DELETE', `/v1/networks/${net}/members/${d.id}`)).status, 200);
  await f.api.db.collection('transfers').dropIndex('one_live_trip');

  const { code, lines } = await doctor({ ...envFor(f), TRAVEL_ADMIN_TOKEN: 'short', TRAVEL_PORT: '1' });
  const all = lines.join('\n');
  assert.equal(code, 1, all);
  assert.ok(line(lines, 'FAIL', 'token', /not a generated token/), all);
  assert.ok(line(lines, 'FAIL', 'indexes', /transfers one_live_trip/), all);
  assert.ok(line(lines, 'FAIL', 'routes', /Rail to Chernobyl .*Chernobyl \([a-f0-9]{16}\), not a member/), all);
  assert.ok(line(lines, 'WARN', 'transfers', new RegExp(`1 trip past the transit time: ${GHOST} Chernarus to Nasdara`)), all);
  assert.ok(line(lines, 'WARN', 'server', /Chernarus .*offline, last beat \d+ min ago, mod 0\.5\.0/), all);
  assert.ok(line(lines, 'WARN', 'server', /Namalsk .*never sent a beat/), all);
  assert.ok(line(lines, 'OK', 'server', /Nasdara .*online.*mod 0\.4\.0/), all);
  assert.ok(line(lines, 'WARN', 'server', /mod versions differ \(0\.5\.0 on Chernarus; 0\.4\.0 on Nasdara\)/), all);
  assert.ok(line(lines, 'WARN', 'server', /in no network: Chernobyl/), all);
  assert.ok(line(lines, 'FAIL', 'api', /nothing answers on http:\/\/127\.0\.0\.1:1/), all);
});

test('a database it cannot reach is one FAIL line, not a crash, and the other checks still run', async () => {
  const { code, lines } = await doctor({ TRAVEL_MONGO_URL: 'mongodb://127.0.0.1:1/highwatch_travel?serverSelectionTimeoutMS=1500', TRAVEL_ADMIN_TOKEN: 'a'.repeat(43), TRAVEL_PORT: '1' });
  const all = lines.join('\n');
  assert.equal(code, 1, all);
  assert.ok(line(lines, 'FAIL', 'mongodb', /cannot use highwatch_travel/), all);
  assert.ok(line(lines, 'OK', 'token', /43 characters/), all);
  assert.ok(line(lines, 'FAIL', 'api', /nothing answers/), all);
  assert.ok(!lines.some(l => / indexes /.test(l)), 'no database checks without a database');
});

test('no settings at all: the doctor says what to set', async () => {
  const { code, lines } = await doctor({ TRAVEL_MONGO_URL: '', TRAVEL_ADMIN_TOKEN: '' });
  assert.equal(code, 1);
  assert.ok(line(lines, 'FAIL', 'config', /Set TRAVEL_MONGO_URL/), lines.join('\n'));
  assert.ok(line(lines, 'FAIL', 'token', /not set/), lines.join('\n'));
});
