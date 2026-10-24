#!/usr/bin/env node
// Copyright (c) 2026 Highwatch. Source-available, not open source: see LICENSE.
// travel-admin: set up and look after a Travel network from the command line. It talks to MongoDB directly with
// TRAVEL_MONGO_URL (from .env when run as `npm run admin -- ...`), so it works before the API is first started.
// While the API runs, prefer the admin API for changes: the API serialises its own writes, not the CLI's.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { readConfig } from '../src/config.mjs';
import { TravelStore } from '../src/store.mjs';
import { runDoctor, formatResults } from '../src/doctor.mjs';

const HELP = `travel-admin <command>

  token                                   print a new admin token for TRAVEL_ADMIN_TOKEN (no database needed)
  doctor                                  check the database, indexes, token, servers, routes, trips and the API
  server add <name>                       register a game server; prints its key ONCE
  server list
  server rotate <server>                  new key for a server; prints it once, the old one stops working
  server remove <server>                  only when it is in no network
  network create <name>
  network list
  network show <network>
  network start-server <network> <server|none>   new characters must start there (none: anywhere)
  network admin <network> <on|off>        let the game servers' admins set up travel from the in-game admin panel
  network audit <network>                 what the in-game admin panel changed, newest first
  member add <network> <server> <address> <port> [label] [--closed]
  member remove <network> <server>
  route add <network> <route.json>        create, or update when the file has an "id"
  route remove <network> <route>
  character list <network> [search]
  character show <network> <steam64>
  character hold <network> <steam64>
  character release <network> <steam64> [home server]
  send <network> <steam64> <server>       staff send: the character's home server runs the trip

Server, network and route ids are the hex ids the list commands print. Full guide: README.md.`;

const args = process.argv.slice(2);
const [group, verb, ...rest] = args;
const out = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

if (!group || group === 'help' || group === '--help' || group === '-h') { out(HELP); process.exit(0); }
if (group === 'token') { out(randomBytes(32).toString('base64url')); process.exit(0); }
// doctor only reads, and must report a database it cannot reach, so it runs before the connection below.
// No process.exit here: exiting while fetch's sockets close can crash Node on Windows.
if (group === 'doctor') {
  const { results, failed } = await runDoctor(process.env);
  out(formatResults(results));
  process.exitCode = failed ? 1 : 0;
} else {
  let config;
  try { config = readConfig(process.env, { requireToken: false }); } catch (error) { console.error(error.message); process.exit(1); }
  const client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 8000, appName: 'travel-admin' });
  try {
    await client.connect();
    const store = await new TravelStore(client.db(config.dbName)).init();
    const need = (n, usage) => { if (rest.length < n) throw new Error(`Usage: travel-admin ${usage}`); };
    const show = net => {
      const lines = [`${net.network.name} (${net.network.id})${net.network.settings?.startServer ? `, start server ${net.network.settings.startServer}` : ''}`];
      for (const s of net.servers) lines.push(`  server ${s.id}  ${s.name.padEnd(16)} ${s.address}:${s.port}  ${s.online ? 'online' : 'offline'}${s.open ? '' : ', closed'}  players ${s.players}${s.world ? `  ${s.world}` : ''}`);
      for (const r of net.routes) lines.push(`  route  ${r.id}  ${r.name}${r.code ? ` [${r.code}]` : ''}: ${r.from} -> ${r.to}${r.enabled ? '' : ' (closed)'}`);
      return lines.join('\n');
    };
    if (group === 'server' && verb === 'add') {
      need(1, 'server add <name>');
      const s = await store.addServer(rest.join(' '));
      out(`Added server ${s.name} (${s.id}).\n\nServer key (shown once, keep it secret):\n${s.key}\n\nPut endpoint and apiKey in that game server's $profile:HighwatchTravel/config.json, then add it to a network:\n  travel-admin member add <network> ${s.id} <address players connect to> <game port> "${s.name}"`);
    } else if (group === 'server' && verb === 'list') {
      const list = await store.servers();
      out(list.length ? list.map(s => `${s.id}  ${s.name}  added ${s.createdAt}`).join('\n') : 'No servers yet. Add one with: travel-admin server add <name>');
    } else if (group === 'server' && verb === 'rotate') {
      need(1, 'server rotate <server>');
      out(`New key for ${rest[0]} (shown once):\n${(await store.rotateKey(rest[0])).key}`);
    } else if (group === 'server' && verb === 'remove') {
      need(1, 'server remove <server>'); await store.removeServer(rest[0]); out('Removed.');
    } else if (group === 'network' && verb === 'create') {
      need(1, 'network create <name>'); out(show(await store.createNetwork({ name: rest.join(' ') })));
    } else if (group === 'network' && verb === 'list') {
      const { networks } = await store.networks();
      out(networks.length ? networks.map(show).join('\n\n') : 'No networks yet. Create one with: travel-admin network create <name>');
    } else if (group === 'network' && verb === 'show') {
      need(1, 'network show <network>'); await store.netOrFail(rest[0]); out(show(await store.network(rest[0])));
    } else if (group === 'network' && verb === 'admin') {
      need(2, 'network admin <network> <on|off>');
      if (rest[1] !== 'on' && rest[1] !== 'off') throw new Error('Usage: travel-admin network admin <network> <on|off>');
      const n = await store.settings(rest[0], { inGameAdmin: rest[1] === 'on' });
      out(`In-game admin is ${n.network.settings.inGameAdmin ? 'on' : 'off'} for ${n.network.name}. Each game server's admins are the Steam64 ids in its profiles\\HighwatchTravel\\config.json "admins".`);
    } else if (group === 'network' && verb === 'audit') {
      need(1, 'network audit <network>');
      const rows = await store.auditOf(rest[0], 100);
      out(rows.length ? rows.map(a => `${a.at}  ${a.staffName || a.staffId} on ${a.server}  ${a.action}  ${JSON.stringify(a.detail)}`).join('\n') : 'No in-game admin changes yet.');
    } else if (group === 'network' && verb === 'start-server') {
      need(2, 'network start-server <network> <server|none>'); out(show(await store.settings(rest[0], { startServer: rest[1] === 'none' ? '' : rest[1] })));
    } else if (group === 'member' && verb === 'add') {
      need(4, 'member add <network> <server> <address> <port> [label] [--closed]');
      const closed = rest.includes('--closed');
      const [network, server, address, port, ...label] = rest.filter(x => x !== '--closed');
      out(show(await store.addMember(network, { server, address, port: Number(port), label: label.join(' '), open: !closed })));
    } else if (group === 'member' && verb === 'remove') {
      need(2, 'member remove <network> <server>'); out(show(await store.removeMember(rest[0], rest[1])));
    } else if (group === 'route' && verb === 'add') {
      need(2, 'route add <network> <route.json>');
      let route;
      try { route = JSON.parse(readFileSync(rest[1], 'utf8')); } catch (error) { throw new Error(`Could not read ${rest[1]} as JSON: ${error.message}`); }
      out(show(await store.saveRoute(rest[0], route)));
    } else if (group === 'route' && verb === 'remove') {
      need(2, 'route remove <network> <route>'); out(show(await store.removeRoute(rest[0], rest[1])));
    } else if (group === 'character' && verb === 'list') {
      need(1, 'character list <network> [search]');
      const { characters } = await store.characters(rest[0], { q: rest.slice(1).join(' '), limit: 200 });
      out(characters.length ? characters.map(c => `${c.steamId}  ${(c.name || '-').padEnd(20)} ${c.state.padEnd(8)} home ${c.home}  ${c.updatedAt}`).join('\n') : 'No characters yet.');
    } else if (group === 'character' && verb === 'show') {
      need(2, 'character show <network> <steam64>'); out(await store.history(rest[0], rest[1]));
    } else if (group === 'character' && (verb === 'hold' || verb === 'release')) {
      need(2, `character ${verb} <network> <steam64>${verb === 'release' ? ' [home server]' : ''}`);
      out(await store.setState(rest[0], rest[1], { state: verb === 'hold' ? 'held' : 'home', home: rest[2] ?? '' }, 'travel-admin'));
    } else if (group === 'send') {
      if (!verb || rest.length < 2) throw new Error('Usage: travel-admin send <network> <steam64> <server>');
      out(await store.send(verb, rest[0], rest[1], 'travel-admin'));
    } else {
      out(HELP); process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
