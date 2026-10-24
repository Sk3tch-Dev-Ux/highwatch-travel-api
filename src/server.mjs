// Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
// The Highwatch Travel API over HTTP. Two kinds of caller:
//
// - The @Highwatch-Travel mod on each game server: POST /travel/... with its server key as the FIRST field of the
//   JSON body (DayZ's RestApi cannot set headers), and one GET for a snapshot, whose URL carries a one-time token.
//   RestCallback.OnError only ever receives a number, so a refusal the mod must read and show to the player
//   (offline, full, closed, already claimed) answers HTTP 200 with {ok:false, code, error}. A bad key and an
//   oversized body keep their real status.
// - The network's owner: /v1/... with `Authorization: Bearer <TRAVEL_ADMIN_TOKEN>`, the travel-admin CLI, or the web
//   console at /console, which is static files that call /v1 from the owner's browser.
//
// Every route is one row of ROUTES below; docs/openapi.yaml describes each one, and a test holds the two together.
// Every answer carries X-Request-Id. No request body, key or token is ever logged. Errors are one JSON line: request
// id, route, status, error name.

import http from 'node:http';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { readConfig } from './config.mjs';
import { TravelStore, refuse, PART_CHARS } from './store.mjs';
import { doctorInProcess } from './doctor.mjs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const KEY_HEAD_BYTES = 512;
const KEY_HEAD = /^\s*\{\s*"apiKey"\s*:\s*"([A-Za-z0-9_-]{20,200})"/;
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const iso = t => new Date(t).toISOString();
const CONSOLE_DIR = fileURLToPath(new URL('../console/', import.meta.url));

// The code an answer carries when the refusal has none of its own.
const STATUS_CODES = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'notFound', 405: 'methodNotAllowed', 409: 'conflict', 413: 'tooLarge', 429: 'rateLimited' };

// Security headers. The console is same-origin scripts and styles only: no inline script, no remote origin, and no
// form ever submits natively (form-action 'none'), so a token can never end up in a URL even if a script fails.
export const CONSOLE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
const FILE_TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', webmanifest: 'application/manifest+json' };

function checkLength(req, max) {
  const size = req.headers['content-length'];
  if (size && (!/^\d+$/.test(size) || Number(size) > max)) throw refuse(413, 'Payload too large.', 'tooLarge');
}
async function readAll(req, max) {
  checkLength(req, max);
  const chunks = []; let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > max) throw refuse(413, 'Payload too large.', 'tooLarge');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req, max) {
  const buf = await readAll(req, max);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw refuse(400, 'Invalid JSON.', 'badJson'); }
}
// The mod's form: the key is read from the first bytes of the body, before the rest is parsed.
async function keyedBody(req, max) {
  const buf = await readAll(req, max);
  const head = KEY_HEAD.exec(buf.subarray(0, KEY_HEAD_BYTES).toString('utf8'));
  let payload;
  try { payload = JSON.parse(buf.toString('utf8')); } catch { throw refuse(400, 'Invalid JSON payload.', 'badJson'); }
  return { key: head ? head[1] : (typeof payload?.apiKey === 'string' ? payload.apiKey : ''), payload };
}
const equalText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// --- the routes -------------------------------------------------------------------------------------------------
// A path is written as docs/openapi.yaml writes it; each {name} matches the pattern in PARAMS.
const PARAMS = { server: '[a-f0-9]{16}', network: '[a-f0-9]{16}', steam64: '\\d{17}', route: '[a-f0-9]{8}', transfer: '[a-f0-9]{24}', group: '[a-f0-9]{24}', token: '[A-Za-z0-9_-]{43}', file: '[a-z0-9-]+(?:/[a-z0-9-]+)*\\.(?:html|css|js|mjs|svg|png|ico|webmanifest)' };
const STEP_MAX = { part: PART_CHARS * 2 + 4096 };
// kind: health, mod (a server key in the body), snapshot (a one-time token in the URL), owner (the admin token),
// console (static files, only when the console is on).
const mod = (p, run, { max = 8192, serial = true } = {}) => ({ method: 'POST', path: p, kind: 'mod', max, serial, run });
const owner = (method, p, run, status = 200) => ({ method, path: p, kind: 'owner', run, status });
export const ROUTES = [
  { method: 'GET', path: '/healthz', kind: 'health', run: async () => ({ status: 'ok', version: VERSION }) },
  { method: 'GET', path: '/readyz', kind: 'health', run: async ({ db, res }) => { try { await db.command({ ping: 1 }); return { status: 'ok', db: 'ok' }; } catch { res.statusCode = 503; return { status: 'not ready', db: 'unreachable' }; } } },

  mod('/travel/beat', ({ store }, srv, p) => store.beat(srv, p), { max: 65536 }),
  mod('/travel/inbox', ({ store }, srv, p) => store.inbox(srv, p), { serial: false }),
  mod('/travel/ledger', ({ store }, srv, p) => store.ledgerOf(srv, p)),
  mod('/travel/quote', ({ store }, srv, p) => store.quote(srv, p)),
  mod('/travel/home', ({ store }, srv, p) => store.claimHome(srv, p)),
  mod('/travel/chat', ({ store }, srv, p) => store.chat(srv, p)),
  mod('/travel/transfers', ({ store }, srv, p) => store.reserve(srv, p)),
  mod('/travel/transfers/{transfer}/part', ({ store, params }, srv, p) => store.part(srv, params.transfer, p), { max: STEP_MAX.part }),
  mod('/travel/transfers/{transfer}/commit', ({ store, params }, srv, p) => store.commit(srv, params.transfer, p)),
  mod('/travel/transfers/{transfer}/cancel', ({ store, params }, srv) => store.cancel(srv, params.transfer)),
  mod('/travel/transfers/{transfer}/reclaim', ({ store, params }, srv) => store.reclaim(srv, params.transfer)),
  mod('/travel/transfers/{transfer}/land', ({ store, params }, srv, p) => store.land(srv, params.transfer, p)),
  mod('/travel/groups', ({ store }, srv, p) => store.reserveGroup(srv, p)),
  mod('/travel/groups/{group}/cancel', ({ store, params }, srv) => store.cancelGroup(srv, params.group)),
  mod('/travel/admin', ({ store }, srv, p) => store.admin(srv, p)),
  { method: 'GET', path: '/travel/snapshot/{transfer}/{token}', kind: 'snapshot' },

  owner('GET', '/v1/overview', async ({ store, db, config, now }) => ({ version: VERSION, ...(await store.overview()), doctor: await doctorInProcess({ db, config, now, version: VERSION }) })),
  owner('GET', '/v1/doctor', ({ db, config, now }) => doctorInProcess({ db, config, now, version: VERSION })),
  owner('GET', '/v1/servers', async ({ store }) => ({ servers: await store.servers() })),
  owner('POST', '/v1/servers', async ({ store, body }) => store.serial(() => store.addServer(body?.name)), 201),
  owner('POST', '/v1/servers/{server}/rotate', ({ store, params }) => store.serial(() => store.rotateKey(params.server))),
  owner('DELETE', '/v1/servers/{server}', async ({ store, params }) => { await store.serial(() => store.removeServer(params.server)); return null; }, 204),
  owner('GET', '/v1/networks', ({ store }) => store.networks()),
  owner('POST', '/v1/networks', ({ store, body }) => store.serial(() => store.createNetwork(body)), 201),
  owner('GET', '/v1/networks/{network}', async ({ store, params }) => { await store.netOrFail(params.network); return store.network(params.network); }),
  owner('POST', '/v1/networks/{network}', ({ store, params, body }) => store.serial(() => store.settings(params.network, body))),
  owner('POST', '/v1/networks/{network}/members', ({ store, params, body }) => store.serial(() => store.addMember(params.network, body))),
  owner('DELETE', '/v1/networks/{network}/members/{server}', ({ store, params }) => store.serial(() => store.removeMember(params.network, params.server))),
  owner('GET', '/v1/networks/{network}/characters', ({ store, params, url, integer }) => store.characters(params.network, { q: (url.searchParams.get('q') ?? '').slice(0, 64), limit: integer('limit', 100, 1, 500) })),
  owner('GET', '/v1/networks/{network}/characters/{steam64}', ({ store, params }) => store.history(params.network, params.steam64)),
  owner('POST', '/v1/networks/{network}/characters/{steam64}', ({ store, params, body, actor }) => store.serial(() => store.setState(params.network, params.steam64, body, actor))),
  owner('POST', '/v1/networks/{network}/send', ({ store, params, body, actor }) => store.serial(() => store.send(params.network, String(body?.steamId ?? ''), String(body?.to ?? ''), actor))),
  owner('POST', '/v1/networks/{network}/routes', ({ store, params, body }) => store.serial(() => store.saveRoute(params.network, body))),
  owner('DELETE', '/v1/networks/{network}/routes/{route}', ({ store, params }) => store.serial(() => store.removeRoute(params.network, params.route))),
  owner('GET', '/v1/networks/{network}/audit', async ({ store, params, url, integer }) => ({ audit: await store.auditOf(params.network, integer('limit', 100, 1, 500), { server: (url.searchParams.get('server') ?? '').slice(0, 16), staff: (url.searchParams.get('staff') ?? '').slice(0, 64) }) })),

  { method: 'GET', path: '/', kind: 'console', redirect: '/console/' },
  { method: 'GET', path: '/console', kind: 'console', redirect: '/console/' },
  { method: 'GET', path: '/console/', kind: 'console', file: 'index.html' },
  { method: 'GET', path: '/console/{file}', kind: 'console' },
];
for (const r of ROUTES) {
  const names = [];
  const source = r.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{([a-z0-9]+)\}/g, (_, name) => { names.push(name); return `(${PARAMS[name]})`; });
  r.regex = new RegExp(`^${source}$`);
  r.names = names;
}

export async function createApi(config, { now = Date.now, log = console.error, client: given = null } = {}) {
  const client = given ?? new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 10000, appName: 'highwatch-travel-api' });
  if (!given) await client.connect();
  const db = client.db(config.dbName);
  const store = await new TravelStore(db, { now }).init();
  const consoleOn = config.console !== false;
  const logLine = fields => log(JSON.stringify({ at: iso(Date.now()), ...fields }));

  // Failed attempts per client address, for server keys and the admin token alike: after thirty in ten minutes the
  // address gets 429 instead of 401. A valid key or token always passes, so a rotated key never locks a real server
  // out and the owner is never locked out by someone else's guesses from another address.
  const attempts = new Map();
  const clientAddress = req => { if (config.trustProxy) { const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean); if (xff.length) return xff.at(-1); } return req.socket?.remoteAddress ?? ''; };
  const limited = req => { const a = attempts.get(clientAddress(req)); return !!a && a.count > 30 && Date.now() - a.since < 600000; };
  const failedAttempt = req => {
    const ip = clientAddress(req); const a = attempts.get(ip);
    if (!a || Date.now() - a.since >= 600000) attempts.set(ip, { count: 1, since: Date.now() }); else a.count += 1;
    // Forget windows that are over, so many addresses cannot grow the map without end.
    if (attempts.size > 10000) for (const [k, v] of attempts) if (Date.now() - v.since >= 600000) attempts.delete(k);
  };
  const serverFor = async (req, key) => {
    const s = await store.serverByKey(key);
    if (s) return s;
    failedAttempt(req);
    if (limited(req)) throw refuse(429, 'Too many unknown keys from this address. Try again in a few minutes.', 'rateLimited');
    throw refuse(401, 'Unknown server key.', 'unknownKey');
  };
  const admin = req => {
    if (equalText(req.headers.authorization ?? '', `Bearer ${config.adminToken}`)) return;
    failedAttempt(req);
    if (limited(req)) throw refuse(429, 'Too many wrong admin tokens from this address. Try again in a few minutes.', 'rateLimited');
    throw refuse(401, 'Wrong or missing admin token.', 'unauthorized');
  };
  // X-Travel-Staff may be percent-encoded UTF-8 (a browser cannot send other characters in a header).
  const staffName = req => {
    let v = String(req.headers['x-travel-staff'] ?? '');
    if (/%[0-9A-Fa-f]{2}/.test(v)) { try { v = decodeURIComponent(v); } catch { /* keep it as sent */ } }
    return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'Owner';
  };

  const consoleFile = async (req, res, name, finish) => {
    let buf;
    try { buf = await readFile(path.join(CONSOLE_DIR, ...name.split('/'))); } catch { throw refuse(404, 'Not found.', 'notFound'); }
    const tag = `"${createHash('sha1').update(buf).digest('base64url')}"`;
    res.setHeader('Content-Security-Policy', CONSOLE_CSP);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', tag);
    if (req.headers['if-none-match'] === tag) { res.statusCode = 304; res.end(); return; }
    finish(200, buf, FILE_TYPES[name.split('.').at(-1)]);
  };

  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
    const incoming = String(req.headers['x-request-id'] ?? '');
    const requestId = REQUEST_ID.test(incoming) ? incoming : randomBytes(8).toString('hex');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', API_CSP);
    const gzipOk = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const finish = (status, body, type) => {
      if (res.destroyed) return;
      res.statusCode = status;
      res.setHeader('Content-Type', type);
      if (!gzipOk || body.length <= 4096 || type === 'image/png') { res.end(body); return; }
      res.setHeader('Vary', 'Accept-Encoding');
      zlib.gzip(body, (error, buffer) => { if (res.destroyed) return; if (error) { res.end(body); return; } res.setHeader('Content-Encoding', 'gzip'); res.end(buffer); });
    };
    const send = (status, data) => { if (status === 204) { res.statusCode = 204; res.end(); return; } finish(status, JSON.stringify(data), 'application/json'); };
    let url, route = null;
    try { url = new URL(req.url, 'http://travel.local'); } catch { send(400, { error: 'Bad request.', code: 'badRequest' }); return; }
    try {
      const p = url.pathname;
      // The owner API answers nothing, not even "not found", before the token is checked.
      const ownerPath = p === '/v1' || p.startsWith('/v1/');
      if (ownerPath) admin(req);
      const matches = ROUTES.filter(r => r.regex.test(p) && (r.kind !== 'console' || consoleOn));
      route = matches.find(r => r.method === req.method) ?? null;
      if (!route) {
        if (matches.length) { res.setHeader('Allow', [...new Set(matches.map(r => r.method))].join(', ')); throw refuse(405, 'Method not allowed.', 'methodNotAllowed'); }
        throw refuse(404, 'Not found.', 'notFound');
      }
      const m = route.regex.exec(p);
      const params = Object.fromEntries(route.names.map((n, i) => [n, m[i + 1]]));
      const integer = (name, fallback, min, max) => {
        const value = url.searchParams.get(name);
        if (value === null || value === '') return fallback;
        const n = /^\d{1,16}$/.test(value) ? Number(value) : NaN;
        if (!(n >= min && n <= max)) throw refuse(400, `Invalid ${name}: a whole number from ${min} to ${max}.`, 'invalid', name);
        return n;
      };
      const ctx = { req, res, url, params, store, db, config, now, integer };

      if (route.kind === 'health') { const out = await route.run(ctx); send(res.statusCode === 503 ? 503 : 200, out); return; }
      if (route.kind === 'console') {
        if (route.redirect) { res.statusCode = 302; res.setHeader('Location', route.redirect); res.end(); return; }
        await consoleFile(req, res, route.file ?? params.file, finish); return;
      }
      if (route.kind === 'snapshot') { finish(200, await store.snapshot(params.transfer, params.token), 'application/json'); return; }
      if (route.kind === 'mod') {
        const { key, payload } = await keyedBody(req, route.max);
        const srv = await serverFor(req, key);
        let result;
        try {
          result = route.serial ? await store.serial(() => route.run(ctx, srv, payload)) : await route.run(ctx, srv, payload);
        } catch (error) {
          if (![400, 404, 409].includes(error.status)) throw error;
          // Unchanged since mod 0.1.0: the mod reads these codes, and a refusal with none carries its status number.
          send(200, { ok: false, code: error.code || String(error.status), error: error.message, who: error.who || '' }); return;
        }
        send(200, { ok: true, ...result }); return;
      }
      // owner
      ctx.actor = staffName(req);
      ctx.body = req.method === 'POST' ? await jsonBody(req, route.path.endsWith('/routes') ? 4096 : 2048) : undefined;
      send(route.status, await route.run(ctx));
    } catch (error) {
      const known = Number.isInteger(error?.status);
      const status = known ? error.status : 503;
      if (status === 413 || (!req.complete && [401, 429].includes(status))) res.setHeader('Connection', 'close');
      if (status >= 500) logLine({ msg: 'Highwatch Travel API could not process a request.', requestId, route: route?.path ?? 'other', method: req.method, status, error: error?.name ?? 'Error', code: typeof error?.code === 'number' ? error.code : undefined });
      // One shape for every refusal: {error, code}, plus `field` when one body field is wrong.
      const code = (known && (error.code || error.apiCode)) || STATUS_CODES[status] || 'unavailable';
      const body = { error: status >= 500 ? 'Travel API temporarily unavailable.' : error.message, code };
      if (known && error.field) body.field = error.field;
      send(status, body);
    }
  });

  let closing = null;
  return {
    server, store, db, client, version: VERSION,
    listen: (port = config.port, host = config.host) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: () => {
      if (closing) return closing;
      closing = (async () => {
        store.closeWaiters();
        await new Promise(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
        await store.tail.catch(() => {});
        if (!given) await client.close();
      })();
      return closing;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = readConfig();
    const api = await createApi(config);
    const at = await api.listen();
    const where = `${at.family === 'IPv6' ? `[${at.address}]` : at.address}:${at.port}`;
    console.log(`Highwatch Travel API ${VERSION} listening on ${where}, database ${config.dbName}. ${config.console ? `Console at http://${where}/console/.` : 'Console off.'} No keys, tokens or bodies are logged.`);
    const stop = async () => { const t = setTimeout(() => process.exit(1), 10000); t.unref(); try { await api.close(); } finally { process.exit(0); } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
