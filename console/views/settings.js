// Settings: the network's name, its start server, the in-game admin switch, the doctor, and a new network.
import { api } from '../api.js';
import { state, net, chooseNetwork } from '../state.js';
import { h, icon, toast, toastError, busy, confirmAction, emptyState } from '../ui.js';

export async function render({ reload }) {
  const n = net();
  const page = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Settings' }), h('p', { class: 'lede', text: n ? `For ${n.network.name}, and the health of the whole API.` : 'The health of the API, and a new network.' }))));
  if (n) page.append(h('div', { class: 'split' }, h('div', { class: 'stack' }, nameForm(n, reload), startForm(n, reload), adminSwitch(n, reload)), doctorPanel(reload)));
  else page.append(doctorPanel(reload));
  page.append(newNetwork(reload));
  return page;
}

function nameForm(n, reload) {
  const input = h('input', { id: 'st-name', type: 'text', maxlength: 64, value: n.network.name, 'aria-describedby': 'st-name-err' });
  const err = h('p', { class: 'field-error', id: 'st-name-err', role: 'alert', hidden: true });
  const btn = h('button', { class: 'btn', type: 'submit', text: 'Rename' });
  return h('form', { class: 'panel form-section', novalidate: true, 'aria-labelledby': 'st-name-h', onsubmit: async e => {
    e.preventDefault();
    const name = input.value.trim();
    err.hidden = true; input.removeAttribute('aria-invalid');
    if (!name) { err.hidden = false; err.textContent = 'Name the network.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    if (name === n.network.name) { toast('The name is unchanged.'); return; }
    await busy(btn, async () => {
      try { await api('POST', `/v1/networks/${n.network.id}`, { name }); toast(`Renamed the network to ${name}.`); await reload(); }
      catch (error) { err.hidden = false; err.textContent = error.message; toastError(error, 'Not renamed'); }
    });
  } }, h('h2', { id: 'st-name-h', text: 'Network name' }), h('div', { class: 'row-tight' }, h('div', { class: 'field' }, h('label', { class: 'sr-only', for: 'st-name', text: 'Network name' }), input), btn), err);
}

function startForm(n, reload) {
  const current = n.network.settings?.startServer ?? '';
  const sel = h('select', { id: 'st-start' }, h('option', { value: '', selected: !current, text: 'Any server: they start where they first join' }), n.servers.map(s => h('option', { value: s.id, selected: s.id === current, text: s.name })));
  const btn = h('button', { class: 'btn', type: 'submit', text: 'Set start server' });
  return h('form', { class: 'panel form-section', novalidate: true, 'aria-labelledby': 'st-start-h', onsubmit: async e => {
    e.preventDefault();
    const to = sel.value;
    if (to === current) { toast('The start server is unchanged.'); return; }
    const name = n.servers.find(s => s.id === to)?.name;
    if (to) {
      const ok = await confirmAction({ title: `Make ${name} the start server?`, text: `Anyone the network has not seen yet is turned away from every other server the first time they join, even a player who already has a character there. They must join ${name} first.`, confirm: 'Set start server' });
      if (!ok) return;
    }
    await busy(btn, async () => {
      try { await api('POST', `/v1/networks/${n.network.id}`, { startServer: to }); toast(to ? `New characters now start on ${name}.` : 'New characters start on any server.'); await reload(); }
      catch (error) { toastError(error, 'Start server unchanged'); }
    });
  } },
  h('h2', { id: 'st-start-h', text: 'Start server' }),
  h('div', { class: 'field' }, h('label', { for: 'st-start', text: 'New characters start on' }), sel),
  h('div', { class: 'notice' }, icon('alert'), h('span', {}, h('strong', { text: 'Careful on a live network. ' }), 'A start server turns away existing characters on other servers the first time they join, when the network has never seen them.')),
  h('div', {}, btn));
}

function adminSwitch(n, reload) {
  const on = n.network.settings?.inGameAdmin === true;
  const old = n.servers.filter(s => s.version && !atLeast(s.version, [0, 6, 0]));
  const sw = h('button', { class: 'switch', type: 'button', 'aria-pressed': String(on), 'aria-describedby': 'st-admin-text', onclick: async () => {
    if (!on) {
      const ok = await confirmAction({ title: 'Turn in-game admin on?', text: 'Each member server\'s admins can then change routes that start or end on their server, open or close servers, set the start server, and hold, release and send characters. Every change lands in the Audit.', confirm: 'Turn on', danger: false });
      if (!ok) return;
    }
    sw.disabled = true;
    try { await api('POST', `/v1/networks/${n.network.id}`, { inGameAdmin: !on }); toast(on ? 'In-game admin is off. The admin panels can no longer change anything.' : 'In-game admin is on.'); await reload(); }
    catch (error) { toastError(error, 'In-game admin unchanged'); sw.disabled = false; }
  } }, h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', { text: on ? 'On' : 'Off' }));
  return h('section', { class: 'panel form-section', 'aria-labelledby': 'st-admin-h' },
    h('h2', { id: 'st-admin-h', text: 'In-game admin' }),
    h('p', { class: 'lede', id: 'st-admin-text', text: 'Lets each member server\'s admins, the Steam64 ids in its profiles\\HighwatchTravel\\config.json "admins", set travel up from the in-game admin panel. Only you can turn it on.' }),
    sw,
    old.length ? h('p', { class: 'hint', text: `${old.map(s => s.name).join(', ')} ${old.length === 1 ? 'runs' : 'run'} a mod older than 0.6.0 and ${old.length === 1 ? 'has' : 'have'} no admin panel.` }) : null);
}
function atLeast(version, min) { const v = String(version).split('.').map(x => Number.parseInt(x, 10) || 0); for (let i = 0; i < min.length; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]; return true; }

// The doctor, with what to do about each warning in the console's own terms.
function doctorPanel(reload) {
  const results = state.overview?.doctor?.results ?? [];
  const btn = h('button', { class: 'btn', type: 'button', text: 'Run again', onclick: () => busy(btn, async () => { await reload(); toast('The doctor ran again.'); }) });
  const bad = results.filter(r => r.level !== 'OK').length;
  return h('section', { class: 'panel', 'aria-labelledby': 'st-doc-h' },
    h('div', { class: 'section-head panel-pad' }, h('h2', { id: 'st-doc-h', text: 'Doctor' }), h('div', { class: 'actions' }, h('span', { class: 'meta', text: bad ? `${bad} to look at` : 'All checks pass' }), btn)),
    results.length ? h('ul', { class: 'doctor' }, results.map(r => h('li', {},
      h('span', { class: `lvl ${r.level}`, text: r.level }),
      h('div', {}, h('p', { class: 'text' }, h('span', { class: 'check-name', text: r.check }), r.text), r.level !== 'OK' ? h('p', { class: 'fix' }, h('strong', { text: 'What to do: ' }), advice(r)) : null)))) : emptyState('No results yet', 'Run the doctor to check the database, servers, routes and trips.'));
}

// A short heading for a doctor line, in the console's words.
export function doctorTitle(r) {
  const t = r.text;
  switch (r.check) {
    case 'token': return 'The admin token is not set right';
    case 'mongodb': return /authentication is off/.test(t) ? 'MongoDB authentication is off' : 'MongoDB cannot be used';
    case 'database': return 'The travel records cannot be read';
    case 'indexes': return /no travel collections/.test(t) ? 'The database is empty' : 'Indexes are missing';
    case 'network': return /start server/.test(t) ? 'The start server is not a member' : 'A network has fewer than two servers';
    case 'server':
      if (/versions differ/.test(t)) return 'Mod versions differ between servers';
      if (/in no network/.test(t)) return `${/: (.+?) \(/.exec(t)?.[1] ?? 'A server'} is in no network`;
      if (/never sent a beat/.test(t)) return `${/^(.+?) \(/.exec(t)?.[1] ?? 'A server'} never sent a beat`;
      if (/offline/.test(t)) return `${/^(.+?) \(/.exec(t)?.[1] ?? 'A server'} is offline`;
      return 'A server needs a look';
    case 'routes': return /no routes/.test(t) ? 'No routes yet' : 'A route is broken';
    case 'transfers': return 'A trip is past its transit time';
    case 'api': return 'The API runs old files';
    default: return `${r.check} ${r.level === 'FAIL' ? 'fails' : 'warns'}`;
  }
}

export function advice(r) {
  const t = r.text;
  switch (r.check) {
    case 'token': return 'Set TRAVEL_ADMIN_TOKEN in the API\'s .env to a token from npm run admin -- token, then restart the API.';
    case 'mongodb': return /authentication is off/.test(t) ? 'Turn MongoDB authentication on (docs/mongodb-setup.md). Until then anyone on this machine can read and change the ledger.' : 'Check MongoDB is running and TRAVEL_MONGO_URL is right, then restart the API.';
    case 'database': return 'Check the API\'s MongoDB user can read and write the travel database.';
    case 'indexes': return 'Restart the API. It makes its indexes when it starts.';
    case 'network': return /start server/.test(t) ? 'Choose the start server again above.' : 'Add another server on the Servers page. Travel needs two.';
    case 'server':
      if (/never sent a beat/.test(t)) return 'Check the game server runs @Highwatch-Travel, and that endpoint and apiKey in its profiles\\HighwatchTravel\\config.json point at this API. Rotate its key on Servers if the key may be lost.';
      if (/offline/.test(t)) return 'Start the game server, or check it can still reach this API. Trips to it are refused until it beats again.';
      if (/versions differ/.test(t)) return 'Update @Highwatch-Travel so every server runs the same version. Mixed versions lose features on the older end.';
      if (/in no network/.test(t)) return 'Add it to the network on the Servers page, or delete it there.';
      return 'Open the Servers page and check that server.';
    case 'routes': return /no routes/.test(t) ? 'Make the first route on the Routes page.' : 'Open Routes and fix or delete the route it names. A route must run between two member servers.';
    case 'transfers': return 'Nothing to do at once: the server each trip left takes the character back while it is online. If that server stays down, open the character and move its home.';
    case 'api': return 'Restart the API so it runs the files on disk.';
    default: return 'Run travel-admin doctor on the API\'s machine for the full picture.';
  }
}

function newNetwork(reload) {
  const input = h('input', { id: 'st-new', type: 'text', maxlength: 64, placeholder: 'Badlands', 'aria-describedby': 'st-new-hint' });
  const btn = h('button', { class: 'btn', type: 'submit', text: 'Create network' });
  const many = (state.overview?.networks.length ?? 0) > 0;
  return h('form', { class: 'panel form-section', novalidate: true, 'aria-labelledby': 'st-new-h', onsubmit: async e => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) { input.setAttribute('aria-invalid', 'true'); input.focus(); toast('Name the new network first.', { error: true }); return; }
    await busy(btn, async () => {
      try { const made = await api('POST', '/v1/networks', { name }); chooseNetwork(made.network.id); toast(`Created ${made.network.name}. The console now shows it.`); await reload(); }
      catch (error) { toastError(error, 'Not created'); }
    });
  } },
  h('h2', { id: 'st-new-h', text: many ? 'Another network' : 'Your first network' }),
  h('p', { class: 'hint', id: 'st-new-hint', text: 'A server belongs to one network at a time. Most owners need only one; a second suits a separate cluster with its own characters.' }),
  h('div', { class: 'row-tight' }, h('div', { class: 'field' }, h('label', { for: 'st-new', text: 'Name' }), input), btn));
}
