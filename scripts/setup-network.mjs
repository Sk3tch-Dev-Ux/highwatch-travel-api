#!/usr/bin/env node
// Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
// setup-network: set a whole Travel network up from one JSON file, through the owner API of a running Travel API.
// It registers every server, makes the network, adds each server with the address and port players connect to,
// adds the routes, sets the start server when the file names one, and writes each game server's config.json.
//
// Run it from the API's folder, after the API has started, so .env supplies the admin token:
//
//   npm run setup -- C:\HighwatchTravel\my-network.json
//   node --env-file=.env scripts/setup-network.mjs my-network.json [--rotate] [--check]
//
// The network file (examples/vanilla/network.json is a whole one):
//
//   {
//     "network": "My network",
//     "address": "203.0.113.10",            the IP or host name players connect to, for every server
//     "endpoint": "http://127.0.0.1:6070",  what the game servers call; left out: the address this script used
//     "admins": ["7656119..."],             Steam64 ids for the in-game admin panel, written into every config
//     "startServer": "",                    a server's name, or empty for none
//     "servers": [ { "name": "Chernarus", "port": 2302, "landingPoints": ["12989 10225"] } ],
//     "routes":  [ { "name": "To Livonia", "code": "LV", "from": "Chernarus", "to": "Livonia", ... } ]
//   }
//
// A server may carry its own "address" when the network spans machines. Routes name their servers by "name"; every
// other route field is the owner API's (docs/api.md, "A route").
//
// Keys. The API shows a server's key once, when the server is registered. This script never prints a key. It writes
// it into config/<name>.config.json beside the network file, with the endpoint, ready to copy to that server's
// profiles\HighwatchTravel\config.json. Keep those files as you keep passwords.
//
// Safe to run again: a server or network that exists is reused, a member is updated, and a route with the same code
// (or, without a code, the same name) between the same two servers is updated instead of made twice. A server that
// exists keeps its key, so its config file is left as it is; --rotate gives every server a new key and rewrites
// every config file. --check reads the file, checks it and the API, and changes nothing.
//
// Node 22.9 or newer, no packages.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rotate = args.includes('--rotate');
const checkOnly = args.includes('--check');
const file = args.find(a => !a.startsWith('--'));
const token = (process.env.TRAVEL_ADMIN_TOKEN ?? '').trim();
const port = process.env.TRAVEL_PORT || '6070';
const base = (process.env.TRAVEL_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');

// What the mod writes on its first start (HwTravelConfig in @Highwatch-Travel), with booleans as 1 and 0 the way it
// writes them. A config file that already exists keeps its own values.
const CONFIG_DEFAULTS = {
  endpoint: '', apiKey: '', enabled: 1, departSeconds: 5, departTimeoutSeconds: 60, landingPoints: [], landingRadius: 40,
  chatTravel: 0, globalChat: 1, chatPrefix: '!g ', debugLog: 0, partyInviteSeconds: 60, partyInviteRadius: 30,
  vehicleDeleteGraceSeconds: 90, roomSeconds: 120, debugRoomExtra: 0, noWaitingRoom: 0, admins: [],
};

class Stop extends Error {}
const fail = text => { throw new Stop(text); };
const nameOf = s => String(s?.name ?? s?.world ?? '').trim();

// Everything wrong with the file, found before anything is changed.
export function problems(net) {
  const out = [];
  if (!net || typeof net !== 'object') return ['The network file is not a JSON object.'];
  if (!String(net.network ?? '').trim()) out.push('"network" is missing: name the network.');
  const servers = Array.isArray(net.servers) ? net.servers : [];
  if (!servers.length) out.push('"servers" lists no servers.');
  const names = new Set();
  const top = String(net.address ?? '').trim();
  let unaddressed = 0;
  for (const s of servers) {
    const name = nameOf(s);
    if (!name) { out.push('A server has no "name".'); continue; }
    if (names.has(name.toLowerCase())) out.push(`Two servers are called ${name}.`);
    names.add(name.toLowerCase());
    if (!/^[A-Za-z0-9 _.-]+$/.test(name)) out.push(`${name}: use letters, digits, spaces, dots, dashes and underscores in a server's name (it names its config file).`);
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) out.push(`${name}: "port" must be the game port players connect to.`);
    const own = String(s.address ?? '').trim();
    if (own === 'SET_ME') out.push(`${name}: its "address" still says SET_ME.`);
    else if (!own && (!top || top === 'SET_ME')) unaddressed++;
    for (const p of s.landingPoints ?? []) if (!/^-?\d+(\.\d+)? -?\d+(\.\d+)?$/.test(String(p))) out.push(`${name}: landing point "${p}" must be "x z" in metres.`);
  }
  if (unaddressed) out.push('"address" is not set. Set it to the public IP or host name players connect to, the same one as in the DayZ launcher.');
  const ports = new Map();
  for (const s of servers) {
    const key = `${String(s.address ?? net.address ?? '').trim()}:${s.port}`;
    if (ports.has(key)) out.push(`${nameOf(s)} and ${ports.get(key)} share ${key}.`);
    ports.set(key, nameOf(s));
  }
  const seen = new Set();
  for (const r of Array.isArray(net.routes) ? net.routes : []) {
    const label = `Route ${r?.name ?? '(no name)'}`;
    for (const end of ['from', 'to']) if (!names.has(String(r?.[end] ?? '').toLowerCase())) out.push(`${label}: "${end}" is ${JSON.stringify(r?.[end])}, which is not one of the servers in the file.`);
    if (r?.from && r.from === r.to) out.push(`${label}: it goes from ${r.from} to itself.`);
    const key = `${r?.from}>${r?.to}>${r?.code || r?.name}`.toLowerCase();
    if (seen.has(key)) out.push(`${label}: a second route from ${r.from} to ${r.to} with the same code or name. Give each its own.`);
    seen.add(key);
  }
  if (net.startServer && !names.has(String(net.startServer).toLowerCase())) out.push(`"startServer" is ${net.startServer}, which is not one of the servers in the file.`);
  for (const a of net.admins ?? []) if (!/^\d{17}$/.test(String(a))) out.push(`"admins": ${a} is not a Steam64 id (17 digits).`);
  return out;
}

async function api(method, route, body) {
  let r;
  try {
    r = await fetch(base + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-travel-staff': 'setup-network' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    fail(`Cannot reach the Travel API at ${base}: ${error.message}. Is it running? Open ${base}/readyz on this machine.`);
  }
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { error: text }; }
  if (!r.ok) fail(`${method} ${route} answered ${r.status} ${json.code ?? ''}: ${json.error ?? text}`);
  return json;
}

async function run() {
  if (!file) fail('Usage: npm run setup -- <network file> [--rotate] [--check]');
  if (!existsSync(file)) fail(`No network file at ${file}.`);
  let net;
  try { net = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { fail(`${file} is not valid JSON: ${error.message}`); }
  const wrong = problems(net);
  if (wrong.length) fail(`${file} needs fixing first:\n  - ${wrong.join('\n  - ')}`);
  if (!token) fail('TRAVEL_ADMIN_TOKEN is not set. Run from the API folder with: npm run setup -- <network file>');

  const health = await fetch(`${base}/readyz`).then(r => r.json()).catch(() => null);
  if (!health || health.status !== 'ok') fail(`The Travel API at ${base} is not ready (${JSON.stringify(health)}). Start it, then run this again.`);
  const existing = (await api('GET', '/v1/servers')).servers ?? [];
  console.log(`Travel API at ${base} is ready. ${net.servers.length} servers and ${(net.routes ?? []).length} routes in ${path.basename(file)}.`);
  if (checkOnly) {
    for (const s of net.servers) console.log(`server ${nameOf(s)}: ${existing.some(x => x.name === nameOf(s)) ? 'already registered' : 'would be registered'}`);
    console.log('Checked. Nothing was changed.');
    return;
  }

  // 1. Servers. The key comes back once, on registration or on rotate, and goes into the config file only.
  const configDir = path.join(path.dirname(path.resolve(file)), 'config');
  mkdirSync(configDir, { recursive: true });
  const endpoint = String(net.endpoint ?? '').trim() || base;
  const ids = new Map();
  const noKey = [];
  for (const s of net.servers) {
    const name = nameOf(s);
    let known = existing.find(x => x.name === name);
    let key = '';
    if (!known) {
      const made = await api('POST', '/v1/servers', { name });
      known = { id: made.id, name };
      key = made.key ?? '';
      console.log(`server ${name}: registered (${known.id})`);
    } else if (rotate) {
      key = (await api('POST', `/v1/servers/${known.id}/rotate`)).key ?? '';
      console.log(`server ${name}: key rotated (${known.id})`);
    } else {
      console.log(`server ${name}: already registered (${known.id}), key kept`);
    }
    if (!known.id) fail(`The API gave no id for ${name}.`);
    ids.set(name.toLowerCase(), known.id);
    const cfgPath = path.join(configDir, s.config ?? `${name}.config.json`);
    let cfg = {};
    if (existsSync(cfgPath)) { try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { fail(`${cfgPath} is not valid JSON. Fix or delete it, then run again.`); } }
    const next = { ...CONFIG_DEFAULTS, ...cfg, endpoint };
    if (key) next.apiKey = key;
    if (Array.isArray(s.landingPoints) && !(cfg.landingPoints ?? []).length) next.landingPoints = s.landingPoints.map(String);
    if (Array.isArray(net.admins) && !(cfg.admins ?? []).length) next.admins = net.admins.map(String);
    writeFileSync(cfgPath, JSON.stringify(next, null, 4) + '\n');
    if (key) console.log(`  key written into ${cfgPath}`);
    else if (!/^hwt_/.test(next.apiKey ?? '')) noKey.push(name);
  }

  // 2. The network.
  let network = ((await api('GET', '/v1/networks')).networks ?? []).find(n => n.network.name === net.network)?.network;
  if (network) console.log(`network ${net.network}: exists (${network.id})`);
  else { network = (await api('POST', '/v1/networks', { name: net.network })).network; console.log(`network ${net.network}: created (${network?.id})`); }
  if (!network?.id) fail('The API gave no network id.');

  // 3. Members: the address and port players connect to. A server already open or closed to arrivals stays so.
  for (const s of net.servers) {
    const address = String(s.address ?? net.address).trim();
    await api('POST', `/v1/networks/${network.id}/members`, { server: ids.get(nameOf(s).toLowerCase()), address, port: s.port, label: nameOf(s) });
    console.log(`member ${nameOf(s)}: ${address}:${s.port}`);
  }

  // 4. Routes: one with the same code (or name, without a code) between the same two servers is updated.
  let current = (await api('GET', `/v1/networks/${network.id}`)).routes ?? [];
  for (const r of net.routes ?? []) {
    const from = ids.get(String(r.from).toLowerCase()), to = ids.get(String(r.to).toLowerCase());
    const same = current.find(x => x.from === from && x.to === to && (r.code ? x.code === r.code : x.name === r.name));
    const body = { ...r, from, to };
    if (same) body.id = same.id;
    current = (await api('POST', `/v1/networks/${network.id}/routes`, body)).routes ?? current;
    const row = current.find(x => x.from === from && x.to === to && (r.code ? x.code === r.code : x.name === r.name));
    console.log(`route ${r.code ?? ''} ${r.name}: ${r.from} to ${r.to}, ${same ? 'updated' : 'added'}${row && row.enabled === false ? ', closed' : ''}${r.vehicles ? ', vehicles' : ''}`);
  }

  // 5. The start server, only when the file names one.
  if (net.startServer) {
    await api('POST', `/v1/networks/${network.id}`, { startServer: ids.get(String(net.startServer).toLowerCase()) });
    console.log(`start server: ${net.startServer}`);
  } else console.log('start server: none (each character lives where its player first joins)');

  if (noKey.length) console.log(`\nNOTE: ${noKey.join(', ')} ${noKey.length === 1 ? 'was' : 'were'} registered before and ${noKey.length === 1 ? 'its config file has' : 'their config files have'} no key. A key is shown once. If you do not have it, run this again with --rotate and copy the new config files to every server.`);
  console.log(`\nDone. Next: copy each config\\<name>.config.json to that server's profiles\\HighwatchTravel\\config.json, then: npm run admin -- network show ${network.id}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run(); } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.error(`\nSTOP: ${error.message}`);
    process.exitCode = 1;
  }
}
