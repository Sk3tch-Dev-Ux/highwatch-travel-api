// Servers: register one (its key shown once), rotate a key, delete one, and add, change or remove members.
import { api } from '../api.js';
import { state, net } from '../state.js';
import { h, icon, pill, agoSec, ago, toast, toastError, busy, confirmAction, showKey, emptyState } from '../ui.js';

const ADDRESS = /^[A-Za-z0-9.-]{1,253}$/;
// Which row has its form open, kept across a refresh of the page.
let open = { kind: '', id: '' };

export async function render({ reload }) {
  const n = net();
  const all = state.overview.servers;
  const members = n?.servers ?? [];
  const loose = all.filter(s => !s.network);
  const elsewhere = all.filter(s => s.network && s.network !== n?.network.id);
  const page = h('div', { class: 'page' });
  page.append(h('div', { class: 'page-head' }, h('div', {},
    h('h1', { text: 'Servers' }),
    h('p', { class: 'lede', text: n ? `Register a game server to get its key, then add it to ${n.network.name} with the address and port players connect to.` : 'Register a game server to get its key. Create a network on the overview to add it to one.' }))));

  page.append(registerForm(reload, n));

  if (n) {
    page.append(h('section', { 'aria-labelledby': 'mem-h' },
      h('div', { class: 'section-head' }, h('h2', { id: 'mem-h', text: `In ${n.network.name}` }), h('span', { class: 'meta', text: `${members.filter(s => s.online).length} of ${members.length} online` })),
      h('div', { class: 'panel' }, members.length ? members.map(s => memberRow(s, n, reload)) : emptyState('No member servers yet', `Add a registered server to ${n.network.name} below. Travel needs at least two.`))));
  }
  page.append(h('section', { 'aria-labelledby': 'loose-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'loose-h', text: 'Not in a network' }), h('span', { class: 'meta', text: loose.length ? `${loose.length}` : '' })),
    h('div', { class: 'panel' }, loose.length ? loose.map(s => looseRow(s, n, reload)) : h('p', { class: 'panel-pad lede', text: 'Every registered server is in a network.' }))));
  if (elsewhere.length) {
    page.append(h('section', { 'aria-labelledby': 'else-h' },
      h('div', { class: 'section-head' }, h('h2', { id: 'else-h', text: 'In other networks' })),
      h('div', { class: 'panel' }, elsewhere.map(s => h('div', { class: 'member' }, h('div', { class: 'member-row' },
        h('div', {}, h('div', { class: 'name', text: s.name }), h('div', { class: 'sub', text: s.id })),
        h('div', { class: 'sub', text: state.overview.networks.find(x => x.network.id === s.network)?.network.name ?? s.network }),
        h('div'), h('div')))))));
  }
  return page;
}

function registerForm(reload, n) {
  const input = h('input', { id: 'reg-name', type: 'text', maxlength: 64, placeholder: 'Chernarus', autocomplete: 'off', 'aria-describedby': 'reg-hint reg-err' });
  const err = h('p', { class: 'field-error', id: 'reg-err', role: 'alert', hidden: true });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus'), 'Register server');
  return h('section', { class: 'panel panel-pad', 'aria-labelledby': 'reg-h' },
    h('form', { class: 'stack', novalidate: true, onsubmit: async e => {
      e.preventDefault();
      const name = input.value.trim();
      err.hidden = true; input.removeAttribute('aria-invalid');
      if (!name) { err.hidden = false; err.textContent = 'Name the server.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      let made;
      try { made = await busy(btn, () => api('POST', '/v1/servers', { name })); }
      catch (error) { err.hidden = false; err.textContent = error.message; toastError(error, 'Could not register the server'); return; }
      input.value = '';
      await showKey({ title: `${made.name} is registered`, name: made.name, key: made.key, lead: 'This is its server key. The game server sends it with every call.' });
      toast(`Registered ${made.name}.`, { detail: n ? `Next: add it to ${n.network.name}.` : '' });
      open = { kind: 'add', id: made.id };
      await reload();
    } },
    h('h2', { id: 'reg-h', text: 'Register a server' }),
    h('div', { class: 'row-tight' }, h('div', { class: 'field' }, h('label', { for: 'reg-name', text: 'Server name' }), input), btn),
    h('p', { class: 'hint', id: 'reg-hint', text: 'The name players see on the departures board. You can change the shown name later per network.' }),
    err));
}

function status(s) {
  return h('div', { class: 'status-line' }, s.online ? pill('Online', 'ok') : pill('Offline', 'danger'),
    h('div', { class: 'sub', text: s.beatAgeSec === null ? 'never sent a beat' : `beat ${agoSec(s.beatAgeSec)}, ${s.players}/${s.slots || '?'} players` }));
}

function memberRow(s, n, reload) {
  const wrap = h('div', { class: 'member' });
  const sw = h('button', { class: 'switch', type: 'button', 'aria-pressed': String(!!s.open), 'aria-label': `${s.name}: open to arrivals`, onclick: async () => {
    sw.disabled = true;
    try {
      await api('POST', `/v1/networks/${n.network.id}/members`, { server: s.id, address: s.address, port: s.port, label: s.name, open: !s.open });
      toast(s.open ? `${s.name} is closed to arrivals. Players already there stay.` : `${s.name} is open to arrivals.`);
      await reload();
    } catch (error) { toastError(error, `Could not change ${s.name}`); sw.disabled = false; }
  } }, h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', { text: 'Open to arrivals' }));
  const edit = h('button', { class: 'btn', type: 'button', 'aria-label': `Change ${s.name}`, 'aria-expanded': String(open.kind === 'edit' && open.id === s.id), text: 'Change', onclick: () => { open = open.kind === 'edit' && open.id === s.id ? { kind: '', id: '' } : { kind: 'edit', id: s.id }; reload(); } });
  wrap.append(h('div', { class: 'member-row' },
    h('div', {}, h('div', { class: 'name', text: s.name }), h('div', { class: 'sub', title: s.id, text: `${s.world || 'world not reported'}  ${s.id}` })),
    h('div', {}, h('span', { class: 'key', text: 'Players connect to' }), h('div', { class: 'mono', text: `${s.address}:${s.port}` })),
    status(s),
    h('div', { class: 'actions' }, sw, edit, keyButton(s, reload), push(removeMember(s, n, reload)), deleteServer(s, reload, n.network.name))));
  if (open.kind === 'edit' && open.id === s.id) wrap.append(memberForm({ n, server: s.id, name: s.name, label: s.name, address: s.address, port: s.port, open: s.open, reload, saveLabel: 'Save changes' }));
  return wrap;
}

// The destructive buttons sit apart from the others, at the far end of the row.
const push = el => { el.classList.add('push'); return el; };

function looseRow(s, n, reload) {
  const wrap = h('div', { class: 'member' });
  const add = n ? h('button', { class: 'btn btn-primary', type: 'button', 'aria-expanded': String(open.kind === 'add' && open.id === s.id), text: `Add to ${n.network.name}`, 'aria-label': `Add ${s.name} to ${n.network.name}`, onclick: () => { open = open.kind === 'add' && open.id === s.id ? { kind: '', id: '' } : { kind: 'add', id: s.id }; reload(); } }) : null;
  wrap.append(h('div', { class: 'member-row' },
    h('div', {}, h('div', { class: 'name', text: s.name }), h('div', { class: 'sub', text: s.id })),
    h('div', { class: 'sub', text: `registered ${ago(s.createdAt)}` }),
    h('div'),
    h('div', { class: 'actions' }, add, keyButton(s, reload), push(deleteServer(s, reload)))));
  if (n && open.kind === 'add' && open.id === s.id) wrap.append(memberForm({ n, server: s.id, name: s.name, label: s.name, address: '', port: '', open: true, reload, saveLabel: `Add to ${n.network.name}` }));
  return wrap;
}

// Add a server to the network, or change how players reach it. Mirrors the API's checks.
function memberForm({ n, server, name, label, address, port, open: isOpen, reload, saveLabel }) {
  const id = k => `m-${server}-${k}`;
  const fLabel = h('input', { id: id('label'), type: 'text', maxlength: 64, value: label });
  const fAddr = h('input', { id: id('addr'), type: 'text', class: 'mono', value: address, placeholder: 'play.example.net', autocomplete: 'off', spellcheck: 'false' });
  const fPort = h('input', { id: id('port'), type: 'number', class: 'mono', min: 1, max: 65535, step: 1, value: port, placeholder: '2302', inputmode: 'numeric' });
  const fOpen = h('input', { id: id('open'), type: 'checkbox', checked: isOpen });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit', text: saveLabel });
  const bad = (input, text) => { input.setAttribute('aria-invalid', 'true'); err.hidden = false; err.textContent = text; input.focus(); };
  const form = h('form', { class: 'inline-form', novalidate: true, onsubmit: async e => {
    e.preventDefault();
    for (const i of [fLabel, fAddr, fPort]) i.removeAttribute('aria-invalid');
    err.hidden = true;
    const body = { server, label: fLabel.value.trim(), address: fAddr.value.trim(), port: Number(fPort.value), open: fOpen.checked };
    if (!ADDRESS.test(body.address)) return bad(fAddr, 'Give the address players connect to: an IP or a host name, letters, digits, dots and dashes.');
    if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) return bad(fPort, 'Give the game port, 1 to 65535.');
    await busy(btn, async () => {
      try {
        await api('POST', `/v1/networks/${n.network.id}/members`, body);
        toast(saveLabel.startsWith('Add') ? `${body.label || name} is in ${n.network.name}.` : `Saved ${body.label || name}.`);
        open = { kind: '', id: '' };
        await reload();
      } catch (error) {
        const target = { address: fAddr, port: fPort }[error.field];
        if (target) bad(target, error.message); else { err.hidden = false; err.textContent = error.message; }
        toastError(error, 'Not saved');
      }
    });
  } },
  h('div', { class: 'row' },
    h('div', { class: 'field' }, h('label', { for: id('label'), text: 'Name shown in this network' }), fLabel),
    h('div', { class: 'field' }, h('label', { for: id('addr'), text: 'Address players connect to' }), fAddr),
    h('div', { class: 'field' }, h('label', { for: id('port'), text: 'Game port' }), fPort)),
  h('label', { class: 'check', for: id('open') }, fOpen, h('span', {}, 'Open to arrivals', h('small', { text: 'Closed, the server keeps its players but takes no one in.' }))),
  err,
  h('div', { class: 'actions' }, btn, h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: () => { open = { kind: '', id: '' }; reload(); } })));
  // After the page has drawn the form: move into it.
  setTimeout(() => (address ? fLabel : fAddr).focus(), 0);
  return form;
}

function keyButton(s, reload) {
  const b = h('button', { class: 'btn', type: 'button', 'aria-label': `Rotate the key for ${s.name}`, onclick: async () => {
    const ok = await confirmAction({ title: `Rotate the key for ${s.name}?`, text: `The old key stops working at once. ${s.name} cannot reach the network until its config.json has the new key.`, confirm: 'Rotate key' });
    if (!ok) return;
    await busy(b, async () => {
      try {
        const r = await api('POST', `/v1/servers/${s.id}/rotate`);
        await showKey({ title: `New key for ${s.name}`, name: s.name, key: r.key, lead: 'The old key no longer works. Replace it in the game server\'s config.json and restart the mod or the server.' });
        toast(`Rotated the key for ${s.name}.`);
        await reload();
      } catch (error) { toastError(error, `Could not rotate the key for ${s.name}`); }
    });
  } }, icon('key'), 'Rotate key');
  return b;
}

function removeMember(s, n, reload) {
  const b = h('button', { class: 'btn btn-danger', type: 'button', text: 'Remove from network', 'aria-label': `Remove ${s.name} from ${n.network.name}`, onclick: async () => {
    const ok = await confirmAction({ title: `Remove ${s.name} from ${n.network.name}?`, text: `Players can no longer travel to or from it. Its characters keep their records. The API refuses while a trip or a route still uses it.`, confirm: 'Remove from network' });
    if (!ok) return;
    await busy(b, async () => {
      try { await api('DELETE', `/v1/networks/${n.network.id}/members/${s.id}`); toast(`Removed ${s.name} from ${n.network.name}.`); await reload(); }
      catch (error) { toastError(error, `${s.name} stays in the network`); }
    });
  } });
  return b;
}

function deleteServer(s, reload, inNetwork = '') {
  const b = h('button', { class: 'btn btn-danger', type: 'button', text: 'Delete', 'aria-label': `Delete ${s.name}`, onclick: async () => {
    const ok = await confirmAction({ title: `Delete ${s.name}?`, text: inNetwork ? `Its key stops working and it is gone from the list. ${s.name} is in ${inNetwork}, so the API refuses until you remove it from there.` : 'Its key stops working and it is gone from the list.', confirm: 'Delete server' });
    if (!ok) return;
    await busy(b, async () => {
      try { await api('DELETE', `/v1/servers/${s.id}`); toast(`Deleted ${s.name}.`); await reload(); }
      catch (error) { toastError(error, `${s.name} was not deleted`); }
    });
  } });
  return b;
}
