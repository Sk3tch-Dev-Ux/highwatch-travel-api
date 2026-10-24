// The landing page: the network as it is right now, and what needs the owner.
import { api } from '../api.js';
import { state, net, serverName, attention, chooseNetwork } from '../state.js';
import { h, icon, pill, plural, agoSec, ago, until, toast, toastError, busy, emptyState } from '../ui.js';
import { networkMap } from '../map.js';
import { doctorTitle, advice } from './settings.js';

export async function render({ reload, go }) {
  const n = net();
  if (!n) return firstNetwork(reload);
  const page = h('div', { class: 'page' });
  const online = n.servers.filter(s => s.online);
  const players = online.reduce((t, s) => t + s.players, 0);
  const slots = online.reduce((t, s) => t + s.slots, 0);
  const closedRoutes = n.routes.filter(r => !r.enabled).length;
  const c = n.characters;
  const total = c.home + c.transit + c.held;
  page.append(h('div', { class: 'page-head' }, h('div', {},
    h('h1', { text: n.network.name }),
    !n.servers.length ? h('p', { class: 'summary', text: 'Nothing in this network yet. Add servers, then routes between them.' }) : h('p', { class: 'summary' },
      h('strong', { text: `${online.length} of ${plural(n.servers.length, 'server')}` }), ' online, ',
      h('strong', { text: `${players}` }), ` ${players === 1 ? 'player' : 'players'} on ${slots} slots. `,
      h('strong', { text: plural(n.routes.length, 'route') }), closedRoutes ? `, ${closedRoutes} closed. ` : '. ',
      h('strong', { text: plural(total, 'character') }), total ? `: ${c.home} at home, ${c.transit} travelling, ${c.held} held.` : '.'),
  )));

  page.append(attentionPanel(n, go));

  page.append(h('section', { 'aria-labelledby': 'map-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'map-h', text: 'Network map' }), h('a', { class: 'btn btn-quiet', href: '#/routes', text: 'Edit routes' })),
    h('div', { class: 'panel map-panel' }, networkMap(n))));

  page.append(h('section', { 'aria-labelledby': 'srv-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'srv-h', text: 'Servers' }), h('span', { class: 'meta', text: 'Each card is as of its last beat.' })),
    n.servers.length ? h('div', { class: 'stations' }, n.servers.map(s => station(s, n))) : h('div', { class: 'panel' }, emptyState('No servers in this network yet', 'Register a game server, then add it with the address and port players connect to.', h('a', { class: 'btn btn-primary', href: '#/servers', text: 'Add a server' })))));

  const moving = n.transfers.filter(t => !t.stuck);
  page.append(h('section', { 'aria-labelledby': 'trips-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'trips-h', text: 'Trips in progress' }), h('span', { class: 'meta', text: moving.length ? plural(moving.length, 'trip') : '' })),
    h('div', { class: 'panel' }, moving.length ? tripsTable(moving) : h('p', { class: 'panel-pad lede', text: 'Nobody is between servers right now.' }))));
  return page;
}

function attentionPanel(n, go) {
  const a = attention(n);
  const items = [];
  for (const t of a.stuck) items.push(item('danger', 'alert',
    `${t.kind === 'vehicle' ? 'A vehicle' : t.name || t.steamId} is stuck between ${serverName(t.from)} and ${serverName(t.to)}`,
    `Committed ${ago(t.committedAt)} and not claimed by ${serverName(t.to)}. ${serverName(t.from)} takes ${t.kind === 'vehicle' ? 'it' : 'the character'} back while it is online.`,
    t.kind === 'vehicle' ? null : h('a', { class: 'btn', href: `#/characters/${t.steamId}`, text: 'Open character' })));
  for (const s of a.offline) items.push(item('danger', 'nosignal', `${s.name} is offline`,
    s.beatAgeSec === null ? 'It has never sent a beat. Check endpoint and apiKey in its profiles\\HighwatchTravel\\config.json.' : `Last beat ${agoSec(s.beatAgeSec)}. Trips to it are refused until it is back.`,
    h('a', { class: 'btn', href: '#/servers', text: 'Servers' })));
  if (a.held.length) items.push(item('warn', 'user', `${plural(a.held.length, 'character is', 'characters are')} held by staff`,
    `${a.held.slice(0, 4).map(c => c.name || c.steamId).join(', ')}${a.held.length > 4 ? ` and ${a.held.length - 4} more` : ''}. A held character cannot join or travel until released.`,
    h('a', { class: 'btn', href: '#/characters/held', text: 'Review' })));
  // The doctor's own lines, except the ones already said above.
  for (const d of a.doctor) {
    if (!aboutThis(d, n)) continue;
    if (d.check === 'server' && /: (offline|never sent a beat)/.test(d.text)) continue;
    items.push(item(d.level === 'FAIL' ? 'fail' : 'warn', 'alert', doctorTitle(d), advice(d), h('a', { class: 'btn', href: '#/settings', text: 'Doctor' })));
  }
  const head = h('div', { class: 'section-head' }, h('h2', { id: 'att-h', text: 'Needs you' }), h('span', { class: 'meta', text: items.length ? plural(items.length, 'item') : '' }));
  if (!items.length) return h('section', { 'aria-labelledby': 'att-h' }, head, h('div', { class: 'panel attention calm' }, icon('check'), h('span', { text: 'Nothing needs you right now. Every server is online, no trip is stuck and the doctor is content.' })));
  return h('section', { 'aria-labelledby': 'att-h' }, head, h('div', { class: 'panel attention' }, items));
}
// The doctor checks the whole API. Keep the lines about this network, or about no network in particular; stuck
// trips are already listed per network above.
function aboutThis(d, n) {
  if (d.check === 'transfers') return false;
  const others = state.overview.networks.filter(x => x.network.id !== n.network.id).map(x => x.network.name);
  return d.text.includes(n.network.name) || !others.some(name => d.text.includes(name));
}
function item(tone, ic, title, text, action) {
  return h('div', { class: `attention-item ${tone}` }, icon(ic), h('div', {}, h('h3', { text: title }), h('p', { text })), action ?? h('span'));
}

function station(s, n) {
  const full = s.slots && s.players >= s.slots;
  const share = s.slots ? Math.min(100, Math.round((s.players / s.slots) * 100)) : 0;
  const bar = h('div', { class: `load${full ? ' full' : ''}`, role: 'img', 'aria-label': `${s.players} of ${s.slots || 'unknown'} slots taken` }, h('i'));
  bar.firstChild.style.width = `${share}%`;
  const tags = [s.online ? pill('Online', 'ok') : pill('Offline', 'danger')];
  if (!s.open) tags.push(pill('Closed', 'danger'));
  if (n.network.settings?.startServer === s.id) tags.push(pill('Start', 'quiet'));
  const fact = (k, v, title) => h('div', {}, h('span', { class: 'key', text: k }), h('span', { class: 'v', text: v, title: title ?? v }));
  return h('article', { class: `panel station${s.online ? '' : ' offline'}`, 'aria-label': s.name },
    h('div', { class: 'station-head' }, h('div', {}, h('h3', { text: s.name }), h('p', { class: 'world', text: s.world || 'world not reported' })), h('div', { class: 'actions' }, tags)),
    h('div', {}, h('div', { class: 'row-tight' }, h('span', { class: 'key', text: 'Players' }), h('span', { class: 'mono', text: `${s.players} / ${s.slots || '?'}` })), bar),
    h('div', { class: 'facts' },
      fact('Last beat', s.beatAgeSec === null ? 'never' : agoSec(s.beatAgeSec)),
      fact('Mod', s.version || 'not reported'),
      fact('Terje', s.terje || 'none'),
      fact('Connect', `${s.address}:${s.port}`)));
}

export function tripsTable(list) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'board stack-sm' },
    h('thead', {}, h('tr', {}, h('th', { text: 'Who' }), h('th', { text: 'From' }), h('th', { text: 'To' }), h('th', { text: 'State' }), h('th', { text: 'Started' }), h('th', { text: 'Deadline' }))),
    h('tbody', {}, list.map(t => h('tr', {},
      h('td', { class: 'wide' }, t.kind === 'vehicle' ? h('span', { text: 'Vehicle' }) : h('a', { class: 'row-link', href: `#/characters/${t.steamId}`, text: t.name || t.steamId }), t.group ? h('span', { class: 'sub', text: 'party trip' }) : null),
      h('td', { text: serverName(t.from) }),
      h('td', { text: serverName(t.to) }),
      h('td', {}, t.stuck ? pill('Stuck', 'danger') : t.lapsing ? pill('Lapsing', 'warn') : t.state === 'committed' ? pill('In transit', 'ok') : pill('Packing', 'quiet')),
      h('td', { class: 'hide-sm', text: ago(t.createdAt) }),
      h('td', { class: 'hide-sm', text: until(t.expiresAt) }))))));
}

// No network yet: make the first one.
function firstNetwork(reload) {
  const input = h('input', { id: 'net-name', type: 'text', maxlength: 64, required: true, placeholder: 'Endfall' });
  const err = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Create network' });
  const form = h('form', { class: 'stack', novalidate: true, onsubmit: async e => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) { err.hidden = false; err.textContent = 'Name the network.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    await busy(btn, async () => {
      try { const made = await api('POST', '/v1/networks', { name }); chooseNetwork(made.network.id); toast(`Created ${made.network.name}.`); await reload(); }
      catch (error) { err.hidden = false; err.textContent = error.message; toastError(error); }
    });
  } }, h('div', { class: 'field' }, h('label', { for: 'net-name', text: 'Network name' }), input, h('p', { class: 'hint', text: 'Players never see it on its own; the in-game board shows it beside the time.' }), err), h('div', {}, btn));
  return h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Set up your travel network' }), h('p', { class: 'lede', text: `A network is the set of game servers one character can travel between. ${state.overview?.servers.length ? `You have ${plural(state.overview.servers.length, 'registered server')} waiting for one.` : 'Create it, then add your servers.'}` }))),
    h('div', { class: 'panel panel-pad' }, form));
}
