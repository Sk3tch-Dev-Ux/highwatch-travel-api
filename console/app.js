// The Highwatch Travel console: sign in, the shell, the router and the 15 second refresh.
import { api, session, whenUnauthorized } from './api.js';
import { state, loadOverview, net, networkId, chooseNetwork, attention } from './state.js';
import { h, toast, agoSec, skeleton } from './ui.js';
import { NARROW } from './map.js';
import * as overview from './views/overview.js';
import * as servers from './views/servers.js';
import * as routes from './views/routes.js';
import * as characters from './views/characters.js';
import * as audit from './views/audit.js';
import * as settings from './views/settings.js';

const VIEWS = { overview, servers, routes, characters, audit, settings };
const TITLES = { overview: 'Overview', servers: 'Servers', routes: 'Routes', characters: 'Characters', audit: 'Audit', settings: 'Settings' };
const REFRESH_MS = 15000;
const $ = id => document.getElementById(id);

// --- theme: dark by default; the choice is a per-viewer convenience -------------------------------------------
const THEME = 'hwt.console.theme';
function theme(next) {
  let t = next;
  if (!t) { try { t = localStorage.getItem(THEME) || 'dark'; } catch { t = 'dark'; } }
  document.documentElement.dataset.theme = t;
  if (next) { try { localStorage.setItem(THEME, t); } catch { /* fine */ } }
  const b = $('theme');
  b.setAttribute('aria-label', t === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme');
  b.title = b.getAttribute('aria-label');
}
theme();
$('theme').addEventListener('click', () => theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

// --- sign in --------------------------------------------------------------------------------------------------
function showLogin(message = '') {
  $('app').hidden = true;
  $('login').hidden = false;
  const err = $('login-error');
  err.hidden = !message; err.textContent = message;
  $('login-staff').value = session.staff || $('login-staff').value;
  $('login-token').value = '';
  $('login-token').focus();
  document.title = 'Highwatch Travel console';
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const token = $('login-token').value.trim();
  const staff = $('login-staff').value.trim().slice(0, 64);
  const err = $('login-error');
  const btn = e.submitter ?? $('login-form').querySelector('button');
  if (!token) { err.hidden = false; err.textContent = 'Paste the admin token first.'; $('login-token').setAttribute('aria-invalid', 'true'); $('login-token').focus(); return; }
  btn.classList.add('busy'); btn.disabled = true;
  try {
    await api('GET', '/v1/doctor', undefined, { token, quietAuth: true });
    session.open(token, staff);
    $('login-token').value = '';
    $('login-token').removeAttribute('aria-invalid');
    await start();
  } catch (error) {
    err.hidden = false;
    $('login-token').setAttribute('aria-invalid', 'true');
    if (error.status === 401) err.textContent = 'That is not the admin token. Copy TRAVEL_ADMIN_TOKEN from the API\'s .env again, all of it.';
    else if (error.status === 429) err.textContent = 'Too many wrong tokens from this address. Wait ten minutes, then try again.';
    else err.textContent = error.message;
    $('login-token').focus();
  } finally { btn.classList.remove('busy'); btn.disabled = false; }
});

$('logout').addEventListener('click', () => { session.close(); stopTimer(); state.overview = null; showLogin(); toast('Logged out. The token is gone from this tab.'); });
whenUnauthorized(() => { session.close(); stopTimer(); state.overview = null; showLogin('The API no longer accepts this token. It may have changed: paste the current one.'); });

// --- the shell ------------------------------------------------------------------------------------------------
let timer = null;
function stopTimer() { clearInterval(timer); timer = null; }

async function start() {
  $('login').hidden = true;
  $('app').hidden = false;
  $('who').textContent = session.staff ? `Signed in as ${session.staff}` : 'Signed in as Owner';
  $('main').replaceChildren(skeleton(4));
  if (!location.hash) history.replaceState(null, '', '#/overview');
  await refresh({ render: true });
  stopTimer();
  timer = setInterval(() => { if (!document.hidden) refresh({ render: false }); }, REFRESH_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && timer && Date.now() - state.at > REFRESH_MS) refresh({ render: false }); });
$('refresh').addEventListener('click', async () => { await refresh({ render: true, quiet: false }); });

// The header's freshness line, every second.
setInterval(() => tick(), 1000);
function tick() {
  const f = $('freshness');
  if (!state.at) { f.textContent = ''; return; }
  const age = Math.round((Date.now() - state.at) / 1000);
  f.textContent = state.failed ? `Refresh failed, data from ${agoSec(age)}` : `Updated ${agoSec(age)}`;
  f.classList.toggle('stale', !!state.failed || age > 45);
}

// Pages that re-draw on every refresh are the read-only ones; a page with a form keeps what is being typed.
const LIVE = new Set(['overview']);

async function refresh({ render = false, quiet = true } = {}) {
  try {
    await loadOverview();
    if (!quiet) toast('Refreshed.');
  } catch (error) {
    if (error.status === 401) return;
    if (!state.overview) { $('main').replaceChildren(h('div', { class: 'page' }, h('div', { class: 'panel empty-state' }, h('h2', { text: 'The console cannot reach the API' }), h('p', { text: error.message }), h('button', { class: 'btn', type: 'button', onclick: () => refresh({ render: true }), text: 'Try again' })))); tick(); return; }
    if (!quiet) toast(`Refresh failed: ${error.message}`, { error: true });
  }
  tick();
  drawNetworkPick();
  drawNavCounts();
  const { view } = parse();
  if (render || (LIVE.has(view) && !document.querySelector('dialog[open]'))) await draw({ keepFocus: !render });
}

function drawNetworkPick() {
  const box = $('network-pick');
  const all = state.overview?.networks ?? [];
  if (all.length > 1) {
    const sel = h('select', { 'aria-label': 'Network', onchange: e => { chooseNetwork(e.target.value); toast(`Showing ${e.target.selectedOptions[0].textContent}.`); refresh({ render: true }); } },
      all.map(n => h('option', { value: n.network.id, selected: n.network.id === networkId(), text: n.network.name })));
    box.replaceChildren(sel);
  } else box.replaceChildren(all[0] ? h('span', { class: 'network-name', text: all[0].network.name }) : '');
}

function drawNavCounts() {
  const a = attention();
  const counts = { overview: [a.stuck.length + a.doctor.filter(d => d.level === 'FAIL').length, 'danger'], characters: [a.held.length, ''] };
  for (const link of document.querySelectorAll('[data-nav]')) {
    link.querySelector('.nav-count')?.remove();
    const [n, tone] = counts[link.dataset.nav] ?? [0];
    if (n) link.append(h('span', { class: `nav-count ${tone}`, text: String(n), 'aria-label': `${n} need attention` }));
  }
}

// --- routing: #/view/arg. The hash never carries the token or anything secret. --------------------------------
function parse() {
  const [, view = 'overview', ...rest] = location.hash.replace(/^#/, '').split('/');
  return { view: VIEWS[view] ? view : 'overview', arg: decodeURIComponent(rest.join('/')) };
}

let drawing = 0;
async function draw({ keepFocus = false } = {}) {
  if ($('app').hidden || !state.overview) return;
  const { view, arg } = parse();
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  const n = net();
  document.title = `${TITLES[view]}${n ? `, ${n.network.name}` : ''}: Highwatch Travel`;
  const ticket = ++drawing;
  const main = $('main');
  const focusedId = keepFocus ? document.activeElement?.id : '';
  const scroll = window.scrollY;
  let page;
  try {
    page = await VIEWS[view].render({ arg, reload, go });
  } catch (error) {
    if (error.status === 401) return;
    page = h('div', { class: 'page' }, h('div', { class: 'panel empty-state' }, h('h2', { text: 'This page could not load' }), h('p', { text: error.message }), h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => draw() })));
  }
  if (ticket !== drawing) return;
  main.replaceChildren(page);
  if (keepFocus) { window.scrollTo(0, scroll); if (focusedId) document.getElementById(focusedId)?.focus(); }
}

// After an action: fetch the overview again and re-draw this page.
async function reload() {
  try { await loadOverview(); } catch { /* the page shows what it has */ }
  tick(); drawNetworkPick(); drawNavCounts();
  await draw({ keepFocus: true });
}
function go(hash) {
  if (location.hash === hash) draw(); else location.hash = hash;
}

// The map is drawn for the width it has: draw again when the page crosses the phone width.
window.matchMedia(NARROW).addEventListener('change', () => draw({ keepFocus: true }));

window.addEventListener('hashchange', async () => {
  await draw();
  // A new page: move focus to it, so keyboard and screen reader users start at its top.
  const main = $('main');
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

if (session.token) start().catch(() => showLogin()); else showLogin();
