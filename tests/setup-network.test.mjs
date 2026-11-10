// scripts/setup-network.mjs: a whole network from one file, through the owner API, and the vanilla example.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.mjs';
import { problems } from '../scripts/setup-network.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'setup-network.mjs');
const example = path.join(root, 'examples', 'vanilla', 'network.json');

// The script runs as its own process, as an owner runs it. Asynchronously: the API under test lives in this process.
function run(f, args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, TRAVEL_ADMIN_TOKEN: f.config.adminToken, TRAVEL_URL: f.base, ...env } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
}

function workdir(t, edit = net => net) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'travel-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'network.json');
  cpSync(example, file);
  writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, 'utf8'))), null, 2));
  return { dir, file };
}

test('the vanilla example is the four maps, every pair connected, closed, and stops until it has an address', async t => {
  const net = JSON.parse(readFileSync(example, 'utf8'));
  assert.deepEqual(net.servers.map(s => s.name), ['Chernarus', 'Livonia', 'Sakhal', 'Nasdara']);
  assert.equal(net.routes.length, 12);
  for (const a of net.servers) for (const b of net.servers) {
    if (a === b) continue;
    const r = net.routes.filter(x => x.from === a.name && x.to === b.name);
    assert.equal(r.length, 1, `${a.name} to ${b.name}`);
    assert.equal(r[0].enabled, false, 'routes start closed');
    assert.ok(r[0].terminal.radius > 0 && r[0].landing.radius > 0, 'a route leaves from a hub and lands at one');
    assert.ok(!r[0].vehicles && !r[0].money && !r[0].cost, 'foot routes, free');
  }
  // One hub per map: every route from a map leaves from the same zone, and every route to it lands at the same one.
  for (const s of net.servers) {
    assert.equal(new Set(net.routes.filter(x => x.from === s.name).map(x => `${x.terminal.x} ${x.terminal.z} ${x.terminal.label}`)).size, 1, s.name);
    assert.equal(new Set(net.routes.filter(x => x.to === s.name).map(x => `${x.landing.x} ${x.landing.z} ${x.landing.label}`)).size, 1, s.name);
  }
  // No start server on a DLC map: an account without the DLC could never join where it is sent.
  assert.equal(net.startServer, '');
  assert.deepEqual(problems(net), ['"address" is not set. Set it to the public IP or host name players connect to, the same one as in the DayZ launcher.'], 'said once, not once per server');
  const f = await fixture(t);
  const { file } = workdir(t);
  const r = await run(f, [file]);
  assert.equal(r.code, 1);
  assert.match(r.out, /STOP: .*needs fixing first/s);
  assert.deepEqual((await f.staff('GET', '/v1/servers')).body.servers, [], 'nothing was registered');
});

test('one run sets the whole network up, writes each key into its config, and a second run changes nothing', async t => {
  const f = await fixture(t);
  const { dir, file } = workdir(t, net => ({ ...net, network: 'Badlands', address: '203.0.113.10', admins: ['76561198000000001'] }));
  const first = await run(f, [file]);
  assert.equal(first.code, 0, first.out);
  assert.doesNotMatch(first.out, /hwt_/, 'a key is never printed');
  const nets = (await f.staff('GET', '/v1/networks')).body.networks;
  assert.equal(nets.length, 1);
  const net = nets[0];
  assert.equal(net.network.name, 'Badlands');
  assert.deepEqual(net.servers.map(s => `${s.name} ${s.address}:${s.port}`).sort(), ['Chernarus 203.0.113.10:2302', 'Livonia 203.0.113.10:2402', 'Nasdara 203.0.113.10:2602', 'Sakhal 203.0.113.10:2502']);
  assert.equal(net.routes.length, 12);
  assert.ok(net.routes.every(r => r.enabled === false));
  const keys = new Set();
  for (const name of ['Chernarus', 'Livonia', 'Sakhal', 'Nasdara']) {
    const cfg = JSON.parse(readFileSync(path.join(dir, 'config', `${name}.config.json`), 'utf8'));
    assert.equal(cfg.endpoint, 'http://127.0.0.1:6070', 'the endpoint the file names, not the address the script used');
    assert.match(cfg.apiKey, /^hwt_/);
    assert.deepEqual(cfg.admins, ['76561198000000001']);
    assert.equal(cfg.landingPoints.length, 1);
    assert.equal(cfg.chatTravel, 0);
    keys.add(cfg.apiKey);
    // The key in the file is the one the API knows: the server's first beat is answered with its network.
    const beat = await f.mod(cfg.apiKey, '/travel/beat', { players: [], maxPlayers: 60, world: name.toLowerCase(), terje: '', version: '0.8.0' });
    assert.equal(beat.body.ok, true, JSON.stringify(beat.body));
    assert.equal(beat.body.network.name, 'Badlands');
    assert.equal(beat.body.routes.filter(r => r.from === beat.body.servers.find(s => s.self).id).length, 3);
  }
  assert.equal(keys.size, 4, 'each server has its own key');

  const again = await run(f, [file]);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /server Chernarus: already registered .* key kept/);
  assert.match(again.out, /route LV To Livonia: Chernarus to Livonia, updated, closed/);
  const after = (await f.staff('GET', '/v1/networks')).body.networks;
  assert.equal(after.length, 1);
  assert.equal(after[0].routes.length, 12, 'no route was made twice');
  assert.equal((await f.staff('GET', '/v1/servers')).body.servers.length, 4);
  for (const name of ['Chernarus', 'Livonia', 'Sakhal', 'Nasdara']) assert.ok(keys.has(JSON.parse(readFileSync(path.join(dir, 'config', `${name}.config.json`), 'utf8')).apiKey), 'the key was kept');
});

test('--check changes nothing, --rotate gives new keys, and a config an owner edited keeps its values', async t => {
  const f = await fixture(t);
  const { dir, file } = workdir(t, net => ({ ...net, address: 'play.example.org', startServer: 'Chernarus', endpoint: '' }));
  const check = await run(f, [file, '--check']);
  assert.equal(check.code, 0, check.out);
  assert.match(check.out, /server Sakhal: would be registered/);
  assert.deepEqual((await f.staff('GET', '/v1/servers')).body.servers, []);
  assert.ok(!existsSync(path.join(dir, 'config', 'Sakhal.config.json')));

  assert.equal((await run(f, [file])).code, 0);
  const net = (await f.staff('GET', '/v1/networks')).body.networks[0];
  assert.equal(net.network.settings.startServer, net.servers.find(s => s.name === 'Chernarus').id);
  const cfgPath = path.join(dir, 'config', 'Sakhal.config.json');
  const before = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(before.endpoint, f.base, 'with no endpoint in the file, the address the script reached');
  writeFileSync(cfgPath, JSON.stringify({ ...before, landingRadius: 25, admins: ['76561198000000009'] }, null, 4));
  const rotated = await run(f, [file, '--rotate']);
  assert.equal(rotated.code, 0, rotated.out);
  assert.doesNotMatch(rotated.out, /hwt_/);
  const now = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.notEqual(now.apiKey, before.apiKey);
  assert.equal(now.landingRadius, 25);
  assert.deepEqual(now.admins, ['76561198000000009']);
  assert.equal((await f.mod(before.apiKey, '/travel/beat', { players: [] })).status, 401, 'the old key stopped working');
  assert.equal((await f.mod(now.apiKey, '/travel/beat', { players: [], maxPlayers: 60, world: 'sakhal', version: '0.8.0' })).body.ok, true);
});

test('a file with mistakes is refused whole, with every mistake named', () => {
  const wrong = problems({ network: '', address: 'SET_ME', startServer: 'Namalsk', admins: ['me'], servers: [{ name: 'Chernarus', port: 2302 }, { name: 'chernarus', port: 2302 }, { name: 'Sakhal', port: 0, address: '10.0.0.5', landingPoints: ['here'] }],
    routes: [{ name: 'Loop', from: 'Sakhal', to: 'Sakhal' }, { name: 'Nowhere', from: 'Chernarus', to: 'Livonia' }] });
  const text = wrong.join('\n');
  for (const part of ['"network" is missing', 'Two servers are called chernarus', '"address" is not set', 'Sakhal: "port" must be', 'landing point "here"', 'Route Loop: it goes from Sakhal to itself', 'Route Nowhere: "to" is "Livonia"', '"startServer" is Namalsk', 'me is not a Steam64 id']) assert.ok(text.includes(part), `${part}\n---\n${text}`);
  assert.deepEqual(problems({ network: 'N', address: '10.0.0.1', servers: [{ name: 'A', port: 2302 }, { name: 'B', port: 2402 }], routes: [{ name: 'Go', from: 'A', to: 'B' }, { name: 'Back', from: 'B', to: 'A' }] }), []);
  assert.match(problems({ network: 'N', address: '10.0.0.1', servers: [{ name: 'A', port: 2302 }, { name: 'B', port: 2302 }] }).join('\n'), /share 10\.0\.0\.1:2302/);
});
