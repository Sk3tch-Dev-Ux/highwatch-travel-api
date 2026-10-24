// Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
// install.ps1's MongoDB helper. It uses the API's own MongoDB driver, so the install needs no mongosh. Passwords
// only ever arrive in environment variables, never on a command line, and the answer (one JSON line) never holds one.
//
//   node mongo-users.mjs probe    HW_MONGO_PORT, HW_DB
//     Can we reach MongoDB, is authentication on, which databases and users exist (when it is off).
//   node mongo-users.mjs ensure   HW_MONGO_PORT, HW_DB, HW_TRAVEL_PASSWORD, HW_ADMIN_USER,
//                                 HW_NEW_ADMIN_PASSWORD (creates the admin user when there is none),
//                                 HW_AUTH_PASSWORD (signs in as HW_ADMIN_USER when authentication is already on)
//     Creates the admin user if missing (an existing one is kept), and creates the travel user or sets its password.
//   node mongo-users.mjs check    HW_URL, HW_DB
//     Signs in with a connection string and says whether it may read and write the travel database.

import { MongoClient } from 'mongodb';

const env = process.env;
const port = Number(env.HW_MONGO_PORT || 27017);
const dbName = env.HW_DB || 'highwatch_travel';
const adminUser = env.HW_ADMIN_USER || 'admin';
const UNAUTHORIZED = [13, 18];
const answer = (o, code = 0) => { console.log(JSON.stringify(o)); process.exitCode = code; };
const local = (user, password) => user ? `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/?authSource=admin&directConnection=true` : `mongodb://127.0.0.1:${port}/?directConnection=true`;
const open = async url => { const c = new MongoClient(url, { serverSelectionTimeoutMS: 6000, appName: 'highwatch-travel-install' }); await c.connect(); return c; };
const userExists = async (client, db, user) => ((await client.db(db).command({ usersInfo: { user, db } })).users ?? []).length > 0;

async function probe() {
  let client;
  try { client = await open(local()); await client.db('admin').command({ ping: 1 }); } catch (error) { answer({ reachable: false, error: error.message }, 1); await client?.close(); return; }
  try {
    const { databases } = await client.db('admin').command({ listDatabases: 1, nameOnly: true });
    answer({ reachable: true, authRequired: false, databases: databases.map(d => d.name), adminUser: await userExists(client, 'admin', adminUser), travelUser: await userExists(client, dbName, 'travel') });
  } catch (error) {
    if (UNAUTHORIZED.includes(error?.code)) answer({ reachable: true, authRequired: true });
    else answer({ reachable: true, error: error.message }, 1);
  } finally { await client.close(); }
}

async function ensure() {
  const travelPassword = env.HW_TRAVEL_PASSWORD || '';
  if (!/^[A-Za-z0-9]{24,128}$/.test(travelPassword)) { answer({ ok: false, error: 'HW_TRAVEL_PASSWORD must be 24 to 128 letters and digits.' }, 1); return; }
  const authPassword = env.HW_AUTH_PASSWORD || '';
  const newAdminPassword = env.HW_NEW_ADMIN_PASSWORD || '';
  let client = await open(authPassword ? local(adminUser, authPassword) : local());
  const result = { ok: true, admin: 'kept', travel: '' };
  try {
    let hasAdmin;
    try { hasAdmin = await userExists(client, 'admin', adminUser); } catch (error) {
      // Authentication is on and we are not signed in. With no user at all yet, MongoDB still lets a local
      // connection create the first one (the localhost exception).
      if (!UNAUTHORIZED.includes(error?.code) || authPassword || !newAdminPassword) throw Object.assign(new Error('MongoDB asks for a sign-in. Give the administrator password.'), { code: 'needAdmin' });
      try { await client.db('admin').command({ createUser: adminUser, pwd: newAdminPassword, roles: [{ role: 'root', db: 'admin' }] }); } catch {
        throw Object.assign(new Error('MongoDB asks for a sign-in. Give the administrator password.'), { code: 'needAdmin' });
      }
      result.admin = 'created';
      await client.close();
      client = await open(local(adminUser, newAdminPassword));
      hasAdmin = true;
    }
    if (!hasAdmin) {
      if (!newAdminPassword) throw new Error(`There is no ${adminUser} user and no password was given for one.`);
      await client.db('admin').command({ createUser: adminUser, pwd: newAdminPassword, roles: [{ role: 'root', db: 'admin' }] });
      result.admin = 'created';
    }
    const roles = [{ role: 'readWrite', db: dbName }];
    if (await userExists(client, dbName, 'travel')) { await client.db(dbName).command({ updateUser: 'travel', pwd: travelPassword, roles }); result.travel = 'updated'; }
    else { await client.db(dbName).command({ createUser: 'travel', pwd: travelPassword, roles }); result.travel = 'created'; }
    answer(result);
  } catch (error) {
    answer({ ok: false, code: typeof error.code === 'string' ? error.code : UNAUTHORIZED.includes(error?.code) ? 'needAdmin' : String(error.code ?? ''), error: error.message }, 1);
  } finally { await client.close(); }
}

async function check() {
  let client;
  try {
    client = await open(env.HW_URL || '');
    const db = client.db(dbName);
    await db.command({ ping: 1 });
    const status = await db.command({ connectionStatus: 1 });
    const users = (status?.authInfo?.authenticatedUsers ?? []).map(u => `${u.user}@${u.db}`);
    const roles = status?.authInfo?.authenticatedUserRoles ?? [];
    const canWrite = !users.length || roles.some(r => (['readWrite', 'dbOwner'].includes(r.role) && r.db === dbName) || ['root', 'readWriteAnyDatabase'].includes(r.role));
    answer({ ok: canWrite, authenticated: users.length > 0, users, canWrite });
  } catch (error) {
    answer({ ok: false, code: String(error?.code ?? ''), error: error.message }, 1);
  } finally { await client?.close(); }
}

const mode = process.argv[2];
if (mode === 'probe') await probe();
else if (mode === 'ensure') await ensure();
else if (mode === 'check') await check();
else answer({ ok: false, error: 'Usage: node mongo-users.mjs probe|ensure|check' }, 1);
