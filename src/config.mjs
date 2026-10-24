// Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
// Settings come from the environment (or a .env file, which `npm start` reads). Every value is checked here, so a
// typo stops the service at start with a plain message instead of failing later.

// The travel-admin CLI talks to the database directly and needs no admin token: { requireToken: false }.
export function readConfig(env = process.env, { requireToken = true } = {}) {
  const mongoUrl = String(env.TRAVEL_MONGO_URL ?? '').trim();
  if (!/^mongodb(\+srv)?:\/\/\S+$/.test(mongoUrl)) throw new Error('Set TRAVEL_MONGO_URL to your MongoDB connection string, for example mongodb://travel:PASSWORD@127.0.0.1:27017/highwatch_travel (see docs/mongodb-setup.md).');
  // The database is the one named in the URL's path, else TRAVEL_DB, else highwatch_travel.
  let urlDb = '';
  try { urlDb = decodeURIComponent(new URL(mongoUrl.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1)); } catch { urlDb = ''; }
  const dbName = String(env.TRAVEL_DB ?? '').trim() || urlDb || 'highwatch_travel';
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) throw new Error('TRAVEL_DB must be 1 to 63 letters, digits, _ or -.');
  const adminToken = String(env.TRAVEL_ADMIN_TOKEN ?? '').trim();
  if (requireToken && !/^[A-Za-z0-9_-]{43,128}$/.test(adminToken)) throw new Error('Set TRAVEL_ADMIN_TOKEN to a generated token of at least 32 bytes. `npm run admin -- token` prints one.');
  const host = String(env.TRAVEL_HOST ?? '127.0.0.1').trim();
  if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host)) throw new Error('TRAVEL_HOST must be 127.0.0.1, ::1, 0.0.0.0 or ::.');
  const port = env.TRAVEL_PORT === undefined || env.TRAVEL_PORT === '' ? 6070 : Number(env.TRAVEL_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('TRAVEL_PORT must be a port number.');
  // Behind a reverse proxy (Caddy, nginx), the client address for the failed-key limiter is the last X-Forwarded-For entry.
  const trustProxy = ['1', 'true', 'yes'].includes(String(env.TRAVEL_TRUST_PROXY ?? '').trim().toLowerCase());
  // The web console at /console. On unless switched off; it binds wherever the API binds.
  const consoleSetting = String(env.TRAVEL_CONSOLE ?? '').trim().toLowerCase();
  if (consoleSetting && !['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'].includes(consoleSetting)) throw new Error('TRAVEL_CONSOLE must be on or off (1 or 0).');
  const consoleOn = !['0', 'false', 'no', 'off'].includes(consoleSetting);
  return { mongoUrl, dbName, adminToken, host, port, trustProxy, console: consoleOn };
}
