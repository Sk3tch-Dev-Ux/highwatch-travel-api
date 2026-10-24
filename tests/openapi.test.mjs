// docs/openapi.yaml describes every route the server answers, and nothing it does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTES } from '../src/server.mjs';

const yaml = readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// The paths block, read line by line: a path at two spaces, its methods at four. Enough for a file we write.
function documented() {
  const out = new Set();
  const lines = yaml.split('\n');
  const start = lines.indexOf('paths:');
  assert.ok(start >= 0, 'openapi.yaml has a paths block');
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const p = /^ {2}(\/\S*):\s*$/.exec(line);
    if (p) { current = p[1].replace(/^'|'$/g, ''); continue; }
    const m = /^ {4}(get|post|put|delete|patch):\s*$/.exec(line);
    if (m && current) out.add(`${m[1].toUpperCase()} ${current}`);
  }
  return out;
}

test('openapi.yaml is OpenAPI 3.1 and documents exactly the routes in server.mjs', () => {
  assert.match(yaml, /^openapi: 3\.1\.\d+$/m);
  const inDocs = documented();
  const inServer = new Set(ROUTES.map(r => `${r.method} ${r.path}`));
  const missing = [...inServer].filter(r => !inDocs.has(r));
  const extra = [...inDocs].filter(r => !inServer.has(r));
  assert.deepEqual(missing, [], `routes the server answers that openapi.yaml does not describe: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `routes openapi.yaml describes that the server does not answer: ${extra.join(', ')}`);
});

test('every owner refusal code the server can send is listed in openapi.yaml', () => {
  const store = readFileSync(new URL('../src/store.mjs', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const codes = new Set();
  for (const m of (store + server).matchAll(/refuse\(\d+, (?:'[^']*'|`[^`]*`), '([A-Za-z]+)'/g)) codes.add(m[1]);
  for (const m of server.matchAll(/(\d{3}): '([A-Za-z]+)'/g)) codes.add(m[2]);
  codes.add('unavailable');
  const listed = /enum:\n((?: {12}- [A-Za-z]+\n)+)/.exec(yaml.slice(yaml.indexOf('OwnerCode:')));
  assert.ok(listed, 'OwnerCode has an enum');
  const enumCodes = new Set(listed[1].trim().split('\n').map(l => l.trim().slice(2)));
  const missing = [...codes].filter(c => !enumCodes.has(c));
  assert.deepEqual(missing, [], `codes missing from OwnerCode: ${missing.join(', ')}`);
});
