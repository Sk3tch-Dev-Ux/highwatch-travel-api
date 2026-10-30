// Characters: search by name or Steam64, and one character's page with its ledger, trips and held luggage, where
// staff hold, release, move or send it.
import { api } from '../api.js';
import { net, serverName, routeName } from '../state.js';
import { h, icon, pill, ago, when, plural, toast, toastError, busy, confirmAction, emptyState, skeleton } from '../ui.js';

const STEAM64 = /^\d{17}$/;
const STATE = { home: ['At home', 'quiet'], transit: ['Travelling', 'ok'], held: ['Held', 'warn'] };
let lastQuery = '';

export async function render({ arg, reload, go }) {
  const n = net();
  if (!n) return h('div', { class: 'page' }, h('h1', { text: 'Characters' }), h('div', { class: 'panel' }, emptyState('No network yet', 'Create the network on the overview first.')));
  if (STEAM64.test(arg)) return detail(n, arg, reload);
  return list(n, arg === 'held', go);
}

export const statePill = st => pill(...(STATE[st] ?? [st, 'quiet']));

async function list(n, heldOnly, go) {
  const results = h('div', { class: 'panel', 'aria-live': 'polite' });
  const input = h('input', { id: 'ch-q', type: 'search', value: heldOnly ? '' : lastQuery, maxlength: 64, placeholder: 'Ghost, or 76561198...', autocomplete: 'off', spellcheck: 'false' });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Search' });
  const search = async q => {
    results.setAttribute('aria-busy', 'true');
    results.replaceChildren(h('div', { class: 'panel-pad' }, skeleton(2)));
    try {
      const { characters } = await api('GET', `/v1/networks/${n.network.id}/characters?q=${encodeURIComponent(q)}&limit=100`);
      results.replaceChildren(table(characters, q ? `No character matches "${q}". Names match in part, Steam64 ids in part too.` : 'The network has not seen a character yet. One appears the first time a player joins a member server.'));
    } catch (error) { results.replaceChildren(h('p', { class: 'panel-pad form-error', text: error.message })); toastError(error); }
    results.removeAttribute('aria-busy');
  };
  const form = h('form', { class: 'filters', role: 'search', novalidate: true, onsubmit: async e => {
    e.preventDefault();
    lastQuery = input.value.trim();
    if (heldOnly) { go('#/characters'); return; }
    await busy(btn, () => search(lastQuery));
  } }, h('div', { class: 'field' }, h('label', { for: 'ch-q', text: 'Name or Steam64' }), input), btn);
  const tabs = h('div', { class: 'actions', role: 'group', 'aria-label': 'Show' },
    h('a', { class: `btn ${heldOnly ? 'btn-quiet' : ''}`, href: '#/characters', 'aria-current': heldOnly ? null : 'true', text: 'Everyone' }),
    h('a', { class: `btn ${heldOnly ? '' : 'btn-quiet'}`, href: '#/characters/held', 'aria-current': heldOnly ? 'true' : null, text: `Held (${n.held.length})` }));
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Characters' }), h('p', { class: 'lede', text: `${plural(n.characters.home + n.characters.transit + n.characters.held, 'character')} in ${n.network.name}, newest change first.` })), tabs),
    form, results);
  if (heldOnly) results.replaceChildren(table(n.held, 'Nobody is held. A held character cannot join or travel until staff release it.'));
  else await search(lastQuery);
  return page;
}

function table(rows, empty) {
  if (!rows.length) return emptyState('Nothing to show', empty);
  return h('div', { class: 'table-wrap' }, h('table', { class: 'board stack-sm' },
    h('thead', {}, h('tr', {}, ['Character', 'Steam64', 'State', 'Home', 'Changed'].map(t => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, rows.map(c => h('tr', { class: 'link-row', onclick: e => { if (!e.target.closest('a')) location.hash = `#/characters/${c.steamId}`; } },
      h('td', { class: 'wide' }, h('a', { class: 'row-link', href: `#/characters/${c.steamId}`, text: c.name || 'No name yet' })),
      h('td', { class: 'mono hide-sm', text: c.steamId }),
      h('td', {}, statePill(c.state)),
      h('td', { text: serverName(c.home) }),
      h('td', { class: 'hide-sm', text: ago(c.updatedAt) }))))));
}

async function detail(n, steamId, reload) {
  const back = h('a', { class: 'crumb', href: '#/characters' }, icon('back'), 'All characters');
  let d;
  try { d = await api('GET', `/v1/networks/${n.network.id}/characters/${steamId}`); }
  catch (error) { return h('div', { class: 'page' }, back, h('div', { class: 'panel' }, emptyState('This character could not load', error.message))); }
  const c = d.character;
  if (!c) return h('div', { class: 'page' }, back, h('div', { class: 'panel' }, emptyState('The network has never seen this character', `No server in ${n.network.name} has reported Steam64 ${steamId}. It appears the first time the player joins a member server.`)));

  const name = c.name || c.steamId;
  const others = n.servers.filter(s => s.id !== c.home);
  const pick = (id, label, list, selected) => {
    const sel = h('select', { id }, list.map(s => h('option', { value: s.id, selected: s.id === selected, text: `${s.name}${s.online ? '' : ' (offline)'}` })));
    return { sel, el: h('div', { class: 'field' }, h('label', { for: id, text: label }), sel) };
  };
  const act = async (btn, title, text, confirm, run, extra = null, danger = true) => {
    const ok = await confirmAction({ title, text, confirm, extra: extra?.el ?? null, danger });
    if (!ok) return;
    await busy(btn, async () => {
      try { const done = await run(extra?.sel.value); toast(done); await reload(); }
      catch (error) { toastError(error, `${name} is unchanged`); }
    });
  };
  const post = body => api('POST', `/v1/networks/${n.network.id}/characters/${steamId}`, body);

  const actions = h('div', { class: 'actions' });
  if (c.state === 'home') {
    const hold = h('button', { class: 'btn btn-danger', type: 'button', text: 'Hold' });
    hold.addEventListener('click', () => act(hold, `Hold ${name}?`, `They cannot join any server or travel until released. Their home stays ${serverName(c.home)}.`, 'Hold character', async () => { await post({ state: 'held' }); return `${name} is held.`; }));
    const send = h('button', { class: 'btn', type: 'button', disabled: !others.length }, icon('arrow'), 'Send to a server');
    send.addEventListener('click', () => act(send, `Send ${name} to another server?`, `${serverName(c.home)} runs the trip with no route rules, as soon as it picks the order up. The order waits there up to an hour.`, 'Send', async to => { const r = await api('POST', `/v1/networks/${n.network.id}/send`, { steamId, to }); return `Sent ${name} to ${serverName(to)}. The order is queued on ${serverName(r.queuedOn)}.`; }, pick('ch-send-to', 'Send to', others, others[0]?.id), false));
    const move = h('button', { class: 'btn', type: 'button', disabled: !others.length, text: 'Move home' });
    move.addEventListener('click', () => act(move, `Move ${name}'s home?`, 'Only the ledger changes. The character is built on the new home the next time the player joins it; their body on the old server is not moved.', 'Move home', async home => { await post({ state: 'home', home }); return `${name} now lives on ${serverName(home)}.`; }, pick('ch-move-to', 'New home', others, others[0]?.id)));
    actions.append(send, move, hold);
  } else if (c.state === 'held') {
    const release = h('button', { class: 'btn btn-primary', type: 'button', text: 'Release' });
    release.addEventListener('click', () => act(release, `Release ${name}?`, 'They can join and travel again. Release them home, or to another server.', 'Release', async home => { await post({ state: 'home', home }); return `Released ${name} to ${serverName(home)}.`; }, pick('ch-release-to', 'Release to', n.servers, c.home), false));
    actions.append(release);
  }

  const live = d.transfers.find(t => t.state === 'reserved' || t.state === 'committed');
  const page = h('div', { class: 'page' }, back,
    h('section', { class: 'panel ticket', 'aria-label': `${name}, ${STATE[c.state]?.[0] ?? c.state}` },
      h('div', {}, h('h1', { text: name }), h('p', { class: 'id', text: `Steam64 ${c.steamId}` })),
      h('div', { class: 'actions' }, statePill(c.state)),
      h('div', { class: 'perf', 'aria-hidden': 'true' }),
      h('dl', { class: 'dl' },
        h('dt', { text: c.state === 'transit' ? 'Left from' : 'Home' }), h('dd', { text: serverName(c.home) || 'none' }),
        live ? [h('dt', { text: 'Going to' }), h('dd', { text: serverName(live.to) })] : null,
        h('dt', { text: 'Last change' }), h('dd', { text: `${when(c.updatedAt)}, ${ago(c.updatedAt)}` })),
      h('div', {}, actions)),
    c.state === 'transit' ? h('div', { class: 'notice' }, icon('clock'), live && Date.parse(live.expiresAt) < Date.now()
      ? h('span', {}, h('strong', { text: 'Stuck. ' }), `${serverName(live.to)} has not claimed this character since it left ${ago(live.committedAt)}. ${serverName(live.from)} takes it back while it is online. Holds, releases and sends wait until then.`)
      : h('span', {}, h('strong', { text: 'Travelling. ' }), 'Holds, releases and sends wait until the character lands or goes back.')) : null);

  page.append(h('div', { class: 'split' },
    h('section', { 'aria-labelledby': 'ledger-h' }, h('h2', { id: 'ledger-h', text: 'Ledger' }), h('div', { class: 'panel panel-pad' }, d.ledger.length ? h('ol', { class: 'timeline' }, d.ledger.map(row => h('li', {},
      h('span', { class: `tick ${row.state}`, 'aria-hidden': 'true' }),
      h('div', {}, h('div', { class: 'what', text: ledgerLine(row) }), h('div', { class: 'why', text: row.reason }), h('div', { class: 'when', text: `${when(row.at)}, ${ago(row.at)}` }))))) : h('p', { class: 'lede', text: 'No ledger rows yet.' }))),
    h('section', { 'aria-labelledby': 'held-h' }, h('h2', { id: 'held-h', text: 'Held luggage' }), h('div', { class: 'panel' }, d.held.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'board' },
      h('thead', {}, h('tr', {}, ['Item class', 'Count', 'Kept by', 'Since'].map(t => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, d.held.map(x => h('tr', {}, h('td', { class: 'mono', text: x.vehicle ? `${x.className} (the party's vehicle)` : x.className }), h('td', { class: 'num', text: String(x.count) }), h('td', { text: serverName(x.server) }), h('td', { text: x.releasedAt ? `given back ${ago(x.releasedAt)}` : ago(x.at) })))))) : h('p', { class: 'panel-pad lede', text: 'Nothing held. Items a destination has no class for are kept here, never deleted.' })))));

  page.append(h('section', { 'aria-labelledby': 'trips-h' }, h('h2', { id: 'trips-h', text: 'Trips' }), h('div', { class: 'panel' }, d.transfers.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'board stack-sm' },
    h('thead', {}, h('tr', {}, ['Started', 'From', 'To', 'Route', 'Outcome'].map(t => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, d.transfers.map(t => h('tr', {},
      h('td', { class: 'wide', text: when(t.createdAt) }),
      h('td', { text: serverName(t.from) }), h('td', { text: serverName(t.to) }),
      h('td', { class: 'hide-sm', text: t.route ? routeName(t.route) || t.route : 'staff send' }),
      h('td', {}, outcome(t))))))) : h('p', { class: 'panel-pad lede', text: 'This character has never travelled.' }))));
  return page;
}

function ledgerLine(r) {
  if (r.state === 'transit') return `Left ${serverName(r.home)} for ${serverName(r.to)}`;
  if (r.state === 'held') return `Held, home ${serverName(r.home)}`;
  return `At home on ${serverName(r.home)}`;
}
function outcome(t) {
  const map = { landed: ['Landed', 'ok'], returned: ['Went back', 'quiet'], lapsed: ['Lapsed', 'quiet'], cancelled: ['Cancelled', 'quiet'], committed: [Date.parse(t.expiresAt) < Date.now() ? 'Stuck' : 'In transit', Date.parse(t.expiresAt) < Date.now() ? 'danger' : 'ok'], reserved: ['Packing', 'quiet'] };
  return pill(...(map[t.state] ?? [t.state, 'quiet']));
}
