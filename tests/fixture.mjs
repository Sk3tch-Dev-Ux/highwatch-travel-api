// A Travel API on a throwaway database of a real MongoDB, a fake clock, and helpers that speak as the mod and as
// the owner. TRAVEL_TEST_MONGO_URL picks the server (default: a local mongod, see docs/mongodb-setup.md). Each test
// gets its own database, dropped afterwards.
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { createApi } from '../src/server.mjs';

export const BASE = Date.parse('2026-10-20T12:00:00Z');
export const MONGO_URL = process.env.TRAVEL_TEST_MONGO_URL || 'mongodb://127.0.0.1:27017';

export async function fixture(t) {
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  try { await client.connect(); } catch (error) { throw new Error(`The tests need a MongoDB at ${MONGO_URL} (set TRAVEL_TEST_MONGO_URL): ${error.message}`); }
  const dbName = `travel_test_${randomBytes(6).toString('hex')}`;
  const config = { mongoUrl: MONGO_URL, dbName, adminToken: randomBytes(32).toString('base64url'), host: '127.0.0.1', port: 0, trustProxy: false };
  const clock = { now: BASE };
  const api = await createApi(config, { now: () => clock.now, log: () => {}, client });
  const { port } = await api.listen(0, '127.0.0.1');
  t.after(async () => { await api.close(); await client.db(dbName).dropDatabase(); await client.close(); });
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' };
  const staff = (method, route, body, headers = auth) => fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json() }));
  // The mod's form: the key first in the body.
  const mod = (key, route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: key, ...body }) }).then(async r => ({ status: r.status, body: await r.json() }));
  return { api, base, clock, staff, mod, config };
}
