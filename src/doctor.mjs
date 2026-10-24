// Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
// travel-admin doctor: one line per check, OK, WARN or FAIL. It only reads. It never creates an index or changes
// a record, so what it reports is what is really there. A FAIL needs fixing before players travel; a WARN is worth
// a look. The exit code is 1 when any check fails.

import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { readConfig } from './config.mjs';
import { TravelStore, BEAT_STALE_MS } from './store.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43,128}$/;

// The indexes the API makes on start, read from TravelStore.init itself so this list never drifts from the store.
// init runs against a stand-in database that only records createIndex calls.
export async function expectedIndexes() {
  const wanted = [];
  const noop = async () => null;
  const collection = name => new Proxy({}, { get: (_, prop) => prop === 'createIndex' ? async (key, options = {}) => { wanted.push({ collection: name, key, unique: !!options.unique, name: options.name ?? '' }); return ''; } : noop });
  const db = new Proxy({}, { get: (_, prop) => prop === 'collection' ? collection : noop });
  try { await new TravelStore(db).init(); } catch { /* keep what was recorded */ }
  return wanted;
}

const ago = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s} s ago`;
  if (s < 7200) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

async function httpJson(url, timeoutMs) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

export async function runDoctor(env = process.env, { now = Date.now, timeoutMs = 5000 } = {}) {
  const results = [];
  const add = (level, check, text) => results.push({ level, check, text });

  let config = null;
  try { config = readConfig(env, { requireToken: false }); } catch (error) { add('FAIL', 'config', error.message); }

  const token = String(env.TRAVEL_ADMIN_TOKEN ?? '').trim();
  if (!token) add('FAIL', 'token', 'TRAVEL_ADMIN_TOKEN is not set. Make one with: npm run admin -- token. The API will not start without it.');
  else if (!TOKEN_FORMAT.test(token)) add('FAIL', 'token', 'TRAVEL_ADMIN_TOKEN is not a generated token (43 to 128 letters, digits, _ or -). Make one with: npm run admin -- token.');
  else add('OK', 'token', `admin token set (${token.length} characters)`);

  if (config) {
    const client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: timeoutMs, connectTimeoutMS: timeoutMs, appName: 'travel-admin doctor' });
    let db = null;
    try { await client.connect(); db = client.db(config.dbName); } catch (error) { add('FAIL', 'mongodb', `cannot use ${config.dbName}: ${error.message}`); }
    if (db && await checkMongo(db, config.dbName, add)) {
      try { await checkDatabase(db, add, now()); } catch (error) { add('FAIL', 'database', `could not read the travel records: ${error.message}`); }
    }
    await client.close().catch(() => {});

    const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' || config.host === '::1' ? '[::1]' : config.host;
    const base = `http://${host}:${config.port}`;
    try {
      const health = await httpJson(`${base}/healthz`, timeoutMs);
      if (health.status !== 200 || health.body?.status !== 'ok') add('FAIL', 'api', `${base}/healthz answered ${health.status}, not ok. Is something else on port ${config.port}?`);
      else {
        const ready = await httpJson(`${base}/readyz`, timeoutMs).catch(error => ({ status: 0, body: { db: error.message } }));
        const running = String(health.body.version ?? '');
        if (ready.status !== 200) add('FAIL', 'api', `answering on ${base}, version ${running}, but its database is ${ready.body?.db ?? 'not ready'} (/readyz ${ready.status})`);
        else if (running && running !== VERSION) add('WARN', 'api', `answering on ${base}, but it runs ${running} and the files here are ${VERSION}. Restart the API to run ${VERSION}.`);
        else add('OK', 'api', `answering on ${base}, version ${running}, database ok`);
      }
    } catch (error) {
      add('FAIL', 'api', `nothing answers on ${base}: ${error.cause?.code ?? error.name ?? error.message}. Is the API running? (scripts/windows/README.md, or npm start)`);
    }
  }

  return { results, failed: results.some(r => r.level === 'FAIL') };
}

// The doctor inside a running API, for GET /v1/overview, GET /v1/doctor and the console. The same checks on the API's
// own database connection, except the HTTP one: the process answering is the API itself.
export async function doctorInProcess({ db, config, now = Date.now, version = VERSION }) {
  const results = [];
  const add = (level, check, text) => results.push({ level, check, text });
  add('OK', 'token', `admin token set (${config.adminToken.length} characters)`);
  if (await checkMongo(db, config.dbName, add)) {
    try { await checkDatabase(db, add, now()); } catch (error) { add('FAIL', 'database', `could not read the travel records: ${error.message}`); }
  }
  if (version !== VERSION) add('WARN', 'api', `this process runs ${version} and the files here are ${VERSION}. Restart the API to run ${VERSION}.`);
  else add('OK', 'api', `this API process, version ${version}, is answering`);
  return { results, failed: results.some(r => r.level === 'FAIL') };
}

// Reaches the database and says whether authentication is on. False when the database cannot be used.
async function checkMongo(db, dbName, add) {
  try {
    await db.command({ ping: 1 });
    const status = await db.command({ connectionStatus: 1 });
    const users = (status?.authInfo?.authenticatedUsers ?? []).map(u => `${u.user}@${u.db}`);
    let version = '';
    try { version = (await db.admin().command({ buildInfo: 1 })).version ?? ''; } catch { version = ''; }
    const on = `database ${dbName}${version ? `, MongoDB ${version}` : ''}`;
    if (users.length) add('OK', 'mongodb', `connected as ${users.join(', ')}, ${on}`);
    else add('WARN', 'mongodb', `connected without a user, so authentication is off. Turn it on (docs/mongodb-setup.md). ${on}`);
    return true;
  } catch (error) {
    add('FAIL', 'mongodb', `cannot use ${dbName}: ${error.message}`);
    return false;
  }
}

async function checkDatabase(db, add, now) {
  // Indexes. A collection that does not exist yet means the API has never started on this database.
  const wanted = await expectedIndexes();
  const existing = new Map();
  let created = 0;
  for (const name of [...new Set(wanted.map(w => w.collection))]) {
    try { existing.set(name, await db.collection(name).listIndexes().toArray()); created += 1; } catch (error) {
      if (error?.code !== 26) throw error;
      existing.set(name, null);
    }
  }
  if (!created) add('WARN', 'indexes', 'the database has no travel collections yet. Start the API once: it creates them and their indexes.');
  else {
    const missing = wanted.filter(w => {
      const have = existing.get(w.collection);
      if (!have) return true;
      return !have.some(i => JSON.stringify(i.key) === JSON.stringify(w.key) && !!i.unique === w.unique);
    }).map(w => `${w.collection} ${w.name || Object.keys(w.key).join('_')}`);
    if (missing.length) add('FAIL', 'indexes', `missing ${missing.length} of ${wanted.length}: ${missing.join(', ')}. Restart the API: it makes them on start.`);
    else add('OK', 'indexes', `all ${wanted.length} indexes present`);
  }

  const networks = await db.collection('networks').find({}).sort({ name: 1 }).toArray();
  const members = await db.collection('members').find({}).toArray();
  const servers = await db.collection('servers').find({}, { projection: { keyHash: 0 } }).toArray();
  const serverName = new Map(servers.map(s => [s._id, s.name]));
  const netName = new Map(networks.map(n => [n._id, n.name]));
  const label = id => { const m = members.find(x => x._id === id); return m?.label || serverName.get(id) || id; };

  if (!networks.length) add('WARN', 'network', 'no network yet. Create one with: travel-admin network create <name>');
  for (const n of networks) {
    const mine = members.filter(m => m.network === n._id);
    const start = n.settings?.startServer ?? '';
    if (start && !mine.some(m => m._id === start)) add('FAIL', 'network', `${n.name}: its start server ${start} is not a member. Set it again: travel-admin network start-server ${n._id} <server|none>`);
    else if (mine.length < 2) add('WARN', 'network', `${n.name} (${n._id}) has ${mine.length} server${mine.length === 1 ? '' : 's'}. Travel needs at least two.`);
    else add('OK', 'network', `${n.name} (${n._id}): ${mine.length} servers${start ? `, new characters start on ${label(start)}` : ''}`);
  }

  // Each member's last beat and mod version.
  for (const m of members.sort((a, b) => String(a.label).localeCompare(String(b.label)))) {
    const where = `${label(m._id)} (${m._id}) in ${netName.get(m.network) ?? `unknown network ${m.network}`}`;
    const version = String(m.beat?.version ?? '');
    const mod = version ? `mod ${version}` : 'mod version not reported';
    if (!m.beatAt) add('WARN', 'server', `${where}: never sent a beat. Check endpoint and apiKey in that server's profiles\\HighwatchTravel\\config.json.`);
    else if (now - m.beatAt >= BEAT_STALE_MS) add('WARN', 'server', `${where}: offline, last beat ${ago(now - m.beatAt)}, ${mod}`);
    else add('OK', 'server', `${where}: online, last beat ${ago(now - m.beatAt)}, ${mod}, ${Array.isArray(m.beat?.players) ? m.beat.players.length : 0} players`);
  }
  for (const n of networks) {
    const versions = new Map();
    for (const m of members.filter(x => x.network === n._id && x.beat?.version)) versions.set(m.beat.version, [...(versions.get(m.beat.version) ?? []), label(m._id)]);
    if (versions.size > 1) add('WARN', 'server', `${n.name}: mod versions differ (${[...versions].map(([v, who]) => `${v} on ${who.join(', ')}`).join('; ')}). Run the same version on every server.`);
  }
  const loose = servers.filter(s => !members.some(m => m._id === s._id));
  if (loose.length) add('WARN', 'server', `in no network: ${loose.map(s => `${s.name} (${s._id})`).join(', ')}. Add with travel-admin member add, or remove with travel-admin server remove.`);

  // Routes must run between two members of their own network.
  const routes = await db.collection('routes').find({}).toArray();
  const bad = [];
  for (const r of routes) {
    const body = r.body ?? {};
    const name = `${body.name ?? r._id} (${r._id})`;
    if (!netName.has(r.network)) { bad.push(`${name} is in a network that no longer exists`); continue; }
    const isMember = id => members.some(m => m._id === id && m.network === r.network);
    const off = [body.from, body.to].filter(id => !isMember(id));
    if (off.length) bad.push(`${name} in ${netName.get(r.network)} uses ${off.map(id => serverName.get(id) ? `${serverName.get(id)} (${id})` : id).join(' and ')}, not a member`);
  }
  if (bad.length) add('FAIL', 'routes', `${bad.length} of ${routes.length} broken: ${bad.join('; ')}. Fix with travel-admin route add (same id) or route remove.`);
  else if (routes.length) add('OK', 'routes', `${routes.length} route${routes.length === 1 ? '' : 's'}, all between member servers`);
  else if (networks.length) add('WARN', 'routes', 'no routes yet, so players cannot travel on their own. Add one with: travel-admin route add <network> <route.json>');

  // Committed trips past their transit time: nobody claimed them. The source server takes the character back when
  // it is online; until then the character is in limbo.
  const stuck = await db.collection('transfers').find({ state: 'committed', expiresAt: { $lt: now } }).sort({ expiresAt: 1 }).limit(50).toArray();
  if (stuck.length) add('WARN', 'transfers', `${stuck.length}${stuck.length === 50 ? '+' : ''} trip${stuck.length === 1 ? '' : 's'} past the transit time: ${stuck.slice(0, 10).map(t => `${t.steamId} ${label(t.fromServer)} to ${label(t.toServer)}, due ${ago(now - t.expiresAt)} (${t._id})`).join('; ')}. The server each one left takes it back while it is online. Detail: travel-admin character show <network> <steam64>.`);
  else add('OK', 'transfers', 'no trip is past its transit time');
}

export function formatResults(results) {
  return results.map(r => `${r.level.padEnd(4)} ${r.check.padEnd(9)} ${r.text}`).join('\n');
}
