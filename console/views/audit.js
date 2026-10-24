// Audit: what the member servers' admins changed from the in-game admin panel, newest first.
import { api } from '../api.js';
import { net, serverName, routeName } from '../state.js';
import { h, icon, when, ago, toastError, busy, emptyState, skeleton } from '../ui.js';

const filters = { server: '', staff: '' };

export async function render() {
  const n = net();
  if (!n) return h('div', { class: 'page' }, h('h1', { text: 'Audit' }), h('div', { class: 'panel' }, emptyState('No network yet', 'Create the network on the overview first.')));
  const results = h('div', { class: 'panel', 'aria-live': 'polite' }, h('div', { class: 'panel-pad' }, skeleton(2)));
  const fServer = h('select', { id: 'au-server' }, h('option', { value: '', text: 'Every server' }), n.servers.map(s => h('option', { value: s.id, selected: s.id === filters.server, text: s.name })));
  const fStaff = h('input', { id: 'au-staff', type: 'search', value: filters.staff, list: 'au-staff-list', maxlength: 64, placeholder: 'Name or Steam64', autocomplete: 'off' });
  const staffList = h('datalist', { id: 'au-staff-list' });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Show' });
  const clear = h('button', { class: 'btn btn-quiet', type: 'button', text: 'Clear', hidden: !(filters.server || filters.staff), onclick: async () => { filters.server = ''; filters.staff = ''; fServer.value = ''; fStaff.value = ''; await busy(btn, load); fServer.focus(); } });
  const load = async () => {
    const q = new URLSearchParams({ limit: '300' });
    if (filters.server) q.set('server', filters.server);
    if (filters.staff) q.set('staff', filters.staff);
    clear.hidden = !(filters.server || filters.staff);
    try {
      const { audit } = await api('GET', `/v1/networks/${n.network.id}/audit?${q}`);
      if (!filters.server && !filters.staff) staffList.replaceChildren(...[...new Set(audit.map(a => a.staffName).filter(Boolean))].map(v => h('option', { value: v })));
      results.replaceChildren(audit.length ? board(audit) : emptyState(filters.server || filters.staff ? 'No changes match' : 'No in-game changes yet',
        filters.server || filters.staff ? 'Try every server, or clear the staff name.' : n.network.settings?.inGameAdmin ? 'Changes made from the in-game admin panel appear here, with who made them and from which server.' : 'In-game admin is off for this network, so nothing can change from the game. Turn it on in Settings.'));
    } catch (error) { results.replaceChildren(h('p', { class: 'panel-pad form-error', text: error.message })); toastError(error); }
  };
  const form = h('form', { class: 'filters', novalidate: true, onsubmit: async e => {
    e.preventDefault();
    filters.server = fServer.value; filters.staff = fStaff.value.trim();
    await busy(btn, load);
  } },
  h('div', { class: 'field' }, h('label', { for: 'au-server', text: 'Server' }), fServer),
  h('div', { class: 'field' }, h('label', { for: 'au-staff', text: 'Staff' }), fStaff, staffList),
  btn, clear);
  fServer.addEventListener('change', () => form.requestSubmit());
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Audit' }), h('p', { class: 'lede', text: 'What member servers\' admins changed from the in-game admin panel, newest first. Your own changes here are in each character\'s ledger.' }))),
    form, results);
  await load();
  return page;
}

function board(rows) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'board stack-sm' },
    h('thead', {}, h('tr', {}, ['When', 'Staff', 'From server', 'Change'].map(t => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, rows.map(a => h('tr', {},
      h('td', { class: 'hide-sm' }, h('span', { text: when(a.at) }), h('span', { class: 'sub', text: ago(a.at) })),
      h('td', {}, h('span', { text: a.staffName || 'Unnamed' }), h('span', { class: 'sub mono', text: a.staffId })),
      h('td', { text: serverName(a.server) }),
      h('td', { class: 'wide' }, change(a)))))));
}

function change(a) {
  const d = a.detail ?? {};
  const who = id => h('a', { class: 'row-link', href: `#/characters/${id}`, text: id });
  switch (a.action) {
    case 'route.save': return h('span', {}, 'Saved route ', h('strong', { text: d.name || routeName(d.route) || d.route }));
    case 'route.remove': return h('span', {}, 'Removed route ', h('strong', { text: d.name || d.route }));
    case 'member.open': return h('span', { text: `${d.open ? 'Opened' : 'Closed'} ${serverName(d.server)} ${d.open ? 'to' : 'for'} arrivals` });
    case 'network.startServer': return h('span', { text: d.server ? `Set the start server to ${serverName(d.server)}` : 'Let new characters start on any server' });
    case 'character.hold': return h('span', {}, 'Held ', who(d.steamId));
    case 'character.release': return h('span', {}, 'Released ', who(d.steamId), ` to ${serverName(d.home)}`);
    case 'send': return h('span', {}, 'Sent ', who(d.steamId), ` to ${serverName(d.to)}`);
    default: return h('span', {}, icon('alert'), ` ${a.action}`);
  }
}
