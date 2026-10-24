// Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
// The Highwatch Travel API over HTTP. Two kinds of caller:
//
// - The @Highwatch-Travel mod on each game server: POST /travel/... with its server key as the FIRST field of the
//   JSON body (DayZ's RestApi cannot set headers), and one GET for a snapshot, whose URL carries a one-time token.
//   RestCallback.OnError only ever receives a number, so a refusal the mod must read and show to the player
//   (offline, full, closed, already claimed) answers HTTP 200 with {ok:false, code, error}. A bad key and an
//   oversized body keep their real status.
// - The network's owner: /v1/... with `Authorization: Bearer <TRAVEL_ADMIN_TOKEN>`, or the travel-admin CLI.
//
// No request body, key or token is ever logged. Errors are one JSON line: route, status, error name.

import http from 'node:http';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { readConfig } from './config.mjs';
import { TravelStore, failure, TRANSFER_ID, TOKEN, PART_CHARS } from './store.mjs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const KEY_HEAD_BYTES = 512;
const KEY_HEAD = /^\s*\{\s*"apiKey"\s*:\s*"([A-Za-z0-9_-]{20,200})"/;
const iso = t => new Date(t).toISOString();

function checkLength(req, max) {
  const size = req.headers['content-length'];
  if (size && (!/^\d+$/.test(size) || Number(size) > max)) throw failure(413, 'Payload too large.');
}
async function readAll(req, max) {
  checkLength(req, max);
  const chunks = []; let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > max) throw failure(413, 'Payload too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req, max) {
  const buf = await readAll(req, max);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw failure(400, 'Invalid JSON.'); }
}
// The mod's form: the key is read from the first bytes of the body, before the rest is parsed.
async function keyedBody(req, max) {
  const buf = await readAll(req, max);
  const head = KEY_HEAD.exec(buf.subarray(0, KEY_HEAD_BYTES).toString('utf8'));
  let payload;
  try { payload = JSON.parse(buf.toString('utf8')); } catch { throw failure(400, 'Invalid JSON payload.'); }
  return { key: head ? head[1] : (typeof payload?.apiKey === 'string' ? payload.apiKey : ''), payload };
}
const equalText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export function routePattern(p) {
  let m;
  if (['/healthz', '/readyz'].includes(p)) return p;
  if ((m = /^\/travel\/(beat|inbox|ledger|quote|home|chat|transfers|groups)(?:\/[a-f0-9]{24}\/([a-z]+))?$/.exec(p))) return m[2] ? `/travel/${m[1]}/:id/${m[2]}` : `/travel/${m[1]}`;
  if (/^\/travel\/snapshot\//.test(p)) return '/travel/snapshot/:id/:token';
  if (/^\/v1\/servers/.test(p)) return '/v1/servers';
  if ((m = /^\/v1\/networks(?:\/[a-f0-9]{16}(?:\/([a-z]+))?)?/.exec(p))) return m[0] === '/v1/networks' ? m[0] : `/v1/networks/:id${m[1] ? `/${m[1]}` : ''}`;
  return 'other';
}

export async function createApi(config, { now = Date.now, log = console.error, client: given = null } = {}) {
  const client = given ?? new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 10000, appName: 'highwatch-travel-api' });
  if (!given) await client.connect();
  const db = client.db(config.dbName);
  const store = await new TravelStore(db, { now }).init();
  const logError = fields => log(JSON.stringify({ at: iso(Date.now()), msg: 'Highwatch Travel API could not process a request.', ...fields }));

  // Failed key attempts per client address: after thirty in ten minutes the address gets 429 instead of 401. A valid
  // key always passes, so a rotated key never locks a real server out.
  const attempts = new Map();
  const clientAddress = req => { if (config.trustProxy) { const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean); if (xff.length) return xff.at(-1); } return req.socket?.remoteAddress ?? ''; };
  const limited = req => { const a = attempts.get(clientAddress(req)); return !!a && a.count > 30 && Date.now() - a.since < 600000; };
  const failedKey = req => { const ip = clientAddress(req); const a = attempts.get(ip); if (!a || Date.now() - a.since >= 600000) attempts.set(ip, { count: 1, since: Date.now() }); else a.count += 1; };
  const serverFor = async (req, key) => {
    const s = await store.serverByKey(key);
    if (s) return s;
    failedKey(req);
    if (limited(req)) throw failure(429, 'Too many unknown keys from this address. Try again in a few minutes.');
    throw failure(401, 'Unknown server key.');
  };
  const admin = req => { if (!equalText(req.headers.authorization ?? '', `Bearer ${config.adminToken}`)) throw failure(401, 'Unauthorized.'); };
  const integer = (value, fallback, min, max) => { if (value === null || value === '') return fallback; if (!/^\d{1,16}$/.test(value)) throw failure(400, 'Invalid number.'); const n = Number(value); if (n < min || n > max) throw failure(400, 'Invalid number.'); return n; };

  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const gzipOk = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const finish = (status, text, type) => {
      if (res.destroyed) return;
      res.statusCode = status;
      res.setHeader('Content-Type', type);
      if (!gzipOk || text.length <= 4096) { res.end(text); return; }
      res.setHeader('Vary', 'Accept-Encoding');
      zlib.gzip(text, (error, buffer) => { if (res.destroyed) return; if (error) { res.end(text); return; } res.setHeader('Content-Encoding', 'gzip'); res.end(buffer); });
    };
    const send = (status, data) => { if (status === 204) { res.statusCode = 204; res.end(); return; } finish(status, JSON.stringify(data), 'application/json'); };
    let url;
    try { url = new URL(req.url, 'http://travel.local'); } catch { send(400, { error: 'Bad request.' }); return; }
    try {
      const p = url.pathname;
      if (p === '/healthz' && req.method === 'GET') { send(200, { status: 'ok', version: VERSION }); return; }
      if (p === '/readyz' && req.method === 'GET') {
        try { await db.command({ ping: 1 }); send(200, { status: 'ok', db: 'ok' }); } catch { send(503, { status: 'not ready', db: 'unreachable' }); }
        return;
      }

      // --- the mod -----------------------------------------------------------------------------------
      const snap = /^\/travel\/snapshot\/([a-f0-9]{24})\/([A-Za-z0-9_-]{43})$/.exec(p);
      if (snap && req.method === 'GET') {
        if (!TRANSFER_ID.test(snap[1]) || !TOKEN.test(snap[2])) throw failure(404, 'Unknown snapshot.');
        finish(200, await store.snapshot(snap[1], snap[2]), 'application/json'); return;
      }
      const travel = /^\/travel\/(beat|inbox|ledger|quote|home|chat|transfers|groups|admin)(?:\/([a-f0-9]{24})\/(part|commit|cancel|reclaim|land))?$/.exec(p);
      if (travel && req.method === 'POST') {
        const [, verb, tid, step] = travel;
        if (tid && verb !== 'transfers' && !(verb === 'groups' && step === 'cancel')) throw failure(404, 'Not found.');
        const max = step === 'part' ? PART_CHARS * 2 + 4096 : verb === 'beat' ? 65536 : 8192;
        const { key, payload } = await keyedBody(req, max);
        const srv = await serverFor(req, key);
        let result;
        try {
          if (verb === 'inbox') result = await store.inbox(srv, payload);
          else result = await store.serial(() => {
            if (verb === 'beat') return store.beat(srv, payload);
            if (verb === 'ledger') return store.ledgerOf(srv, payload);
            if (verb === 'quote') return store.quote(srv, payload);
            if (verb === 'home') return store.claimHome(srv, payload);
            if (verb === 'chat') return store.chat(srv, payload);
            if (verb === 'groups') return tid ? store.cancelGroup(srv, tid) : store.reserveGroup(srv, payload);
            if (verb === 'admin') return store.admin(srv, payload);
            if (!tid) return store.reserve(srv, payload);
            if (step === 'part') return store.part(srv, tid, payload);
            if (step === 'commit') return store.commit(srv, tid, payload);
            if (step === 'cancel') return store.cancel(srv, tid);
            if (step === 'reclaim') return store.reclaim(srv, tid);
            return store.land(srv, tid, payload);
          });
        } catch (error) {
          if (![400, 404, 409].includes(error.status)) throw error;
          send(200, { ok: false, code: error.code || String(error.status), error: error.message, who: error.who || '' }); return;
        }
        send(200, { ok: true, ...result }); return;
      }

      // --- the owner ---------------------------------------------------------------------------------
      if (p === '/v1/servers' && req.method === 'GET') { admin(req); send(200, { servers: await store.servers() }); return; }
      if (p === '/v1/servers' && req.method === 'POST') { admin(req); const b = await jsonBody(req, 2048); send(201, await store.serial(() => store.addServer(b?.name))); return; }
      const srvMatch = /^\/v1\/servers\/([a-f0-9]{16})(\/rotate)?$/.exec(p);
      if (srvMatch) {
        admin(req);
        if (srvMatch[2] && req.method === 'POST') { send(200, await store.serial(() => store.rotateKey(srvMatch[1]))); return; }
        if (!srvMatch[2] && req.method === 'DELETE') { await store.serial(() => store.removeServer(srvMatch[1])); send(204); return; }
        throw failure(404, 'Not found.');
      }
      if (p === '/v1/networks' && req.method === 'GET') { admin(req); send(200, await store.networks()); return; }
      if (p === '/v1/networks' && req.method === 'POST') { admin(req); const b = await jsonBody(req, 2048); send(201, await store.serial(() => store.createNetwork(b))); return; }
      const net = /^\/v1\/networks\/([a-f0-9]{16})(?:\/(members|characters|send|routes|audit)(?:\/([a-f0-9]{16}|\d{17}|[a-f0-9]{8}))?)?$/.exec(p);
      if (net) {
        admin(req);
        const [, nid, part, item] = net;
        const actor = String(req.headers['x-travel-staff'] ?? '').slice(0, 64) || 'Owner';
        if (!part && req.method === 'GET') { await store.netOrFail(nid); send(200, await store.network(nid)); return; }
        if (!part && req.method === 'POST') { const b = await jsonBody(req, 2048); send(200, await store.serial(() => store.settings(nid, b))); return; }
        if (part === 'members' && !item && req.method === 'POST') { const b = await jsonBody(req, 2048); send(200, await store.serial(() => store.addMember(nid, b))); return; }
        if (part === 'members' && item && req.method === 'DELETE') { send(200, await store.serial(() => store.removeMember(nid, item))); return; }
        if (part === 'characters' && !item && req.method === 'GET') { send(200, await store.characters(nid, { q: (url.searchParams.get('q') ?? '').slice(0, 64), limit: integer(url.searchParams.get('limit'), 100, 1, 500) })); return; }
        if (part === 'characters' && item && req.method === 'GET') { send(200, await store.history(nid, item)); return; }
        if (part === 'characters' && item && req.method === 'POST') { const b = await jsonBody(req, 1024); send(200, await store.serial(() => store.setState(nid, item, b, actor))); return; }
        if (part === 'send' && !item && req.method === 'POST') { const b = await jsonBody(req, 1024); send(200, await store.serial(() => store.send(nid, String(b?.steamId ?? ''), String(b?.to ?? ''), actor))); return; }
        if (part === 'routes' && !item && req.method === 'POST') { const b = await jsonBody(req, 4096); send(200, await store.serial(() => store.saveRoute(nid, b))); return; }
        if (part === 'routes' && item && req.method === 'DELETE') { send(200, await store.serial(() => store.removeRoute(nid, item))); return; }
        if (part === 'audit' && !item && req.method === 'GET') { send(200, { audit: await store.auditOf(nid, integer(url.searchParams.get('limit'), 100, 1, 500)) }); return; }
        throw failure(404, 'Not found.');
      }
      throw failure(404, 'Not found.');
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503;
      if (status === 413 || (!req.complete && [401, 429].includes(status))) res.setHeader('Connection', 'close');
      if (status >= 500) logError({ route: routePattern(url.pathname), method: req.method, status, error: error?.name ?? 'Error', code: typeof error?.code === 'number' ? error.code : undefined });
      send(status, { error: status >= 500 ? 'Travel API temporarily unavailable.' : error.message });
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
    console.log(`Highwatch Travel API ${VERSION} listening on ${at.address}:${at.port}, database ${config.dbName}. No keys, tokens or bodies are logged.`);
    const stop = async () => { const t = setTimeout(() => process.exit(1), 10000); t.unref(); try { await api.close(); } finally { process.exit(0); } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
