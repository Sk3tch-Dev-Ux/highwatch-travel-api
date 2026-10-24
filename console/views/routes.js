// Routes: the board of every route, and the editor. The editor uses the in-game admin panel's words (Foot or
// Vehicle route, Leaves from, Lands at, Vehicle arrival point) and checks what the API checks before it sends.
import { api } from '../api.js';
import { net, serverName } from '../state.js';
import { h, icon, pill, money, grid, toast, toastError, busy, confirmAction, emptyState } from '../ui.js';

const SUGGEST = { footTerminal: 3, vehicleTerminal: 12, footLanding: 30, vehicleLanding: 25 };
const CLASS_NAME = /^[A-Za-z0-9_]{1,64}$/;
const HOURS = /^(\d{1,2})-(\d{1,2})$/;
const CODE = /^[A-Z0-9]{2,4}$/;
const MONEY_MAX = 10000000;

export async function render(ctx) {
  const n = net();
  if (!n) return h('div', { class: 'page' }, h('h1', { text: 'Routes' }), h('div', { class: 'panel' }, emptyState('No network yet', 'Create the network on the overview first.', h('a', { class: 'btn btn-primary', href: '#/overview', text: 'Go to the overview' }))));
  if (ctx.arg) return editor(n, ctx.arg === 'new' ? null : n.routes.find(r => r.id === ctx.arg), ctx);
  return board(n);
}

const zoneText = (z, none) => (z && z.radius > 0 ? `${z.label || `grid ${grid(z.x, z.z)}`}, ${z.radius} m` : none);
function fareText(r) {
  const parts = r.cost.map(c => `${c.count} ${c.type}`);
  if (r.money > 0) parts.push(`${money(r.money)} money${r.moneyFromAtm ? ', bank tops up' : ''}`);
  return parts.length ? parts.join(', ') : 'Free';
}

function board(n) {
  const page = h('div', { class: 'page' });
  page.append(h('div', { class: 'page-head' },
    h('div', {}, h('h1', { text: 'Routes' }), h('p', { class: 'lede', text: 'How players travel on their own. Staff sends ignore routes.' })),
    n.servers.length >= 2 ? h('a', { class: 'btn btn-primary', href: '#/routes/new' }, icon('plus'), 'New route') : null));
  if (n.servers.length < 2) {
    page.append(h('div', { class: 'panel' }, emptyState('A route needs two servers', `${n.network.name} has ${n.servers.length}. Add another on the Servers page first.`, h('a', { class: 'btn btn-primary', href: '#/servers', text: 'Servers' }))));
    return page;
  }
  if (!n.routes.length) {
    page.append(h('div', { class: 'panel' }, emptyState('No routes yet', 'Without a route players cannot travel on their own. Start with a foot route between your two busiest servers.', h('a', { class: 'btn btn-primary', href: '#/routes/new', text: 'Make the first route' }))));
    return page;
  }
  const rows = n.routes.map((r, i) => h('tr', { class: `link-row${r.enabled ? '' : ' dim'}`, onclick: e => { if (e.target.closest('a')) return; location.hash = `#/routes/${r.id}`; } },
    h('td', {}, h('span', { class: 'code-chip', text: r.code || `R${i + 1}` })),
    h('td', { class: 'wide' }, h('a', { class: 'row-link', href: `#/routes/${r.id}`, text: r.name }), h('span', { class: 'sub', text: r.vehicles ? 'Vehicle route' : 'Foot route' })),
    h('td', {}, h('span', { text: serverName(r.from) }), h('span', { class: 'sub', text: `to ${serverName(r.to)}` })),
    h('td', { class: 'hide-sm', text: zoneText(r.terminal, 'Anywhere') }),
    h('td', { class: 'hide-sm', text: zoneText(r.landing, 'Landing points') }),
    h('td', { class: 'hide-sm', text: fareText(r) }),
    h('td', { class: 'hide-sm mono', text: r.hours || 'Always' }),
    h('td', {}, r.enabled ? pill('Open', 'ok') : pill('Closed', 'warn'))));
  page.append(h('div', { class: 'panel table-wrap' }, h('table', { class: 'board stack-sm' },
    h('caption', { class: 'sr-only', text: `Routes in ${n.network.name}` }),
    h('thead', {}, h('tr', {}, ['Code', 'Route', 'Between', 'Leaves from', 'Lands at', 'Fare', 'Hours', 'State'].map(t => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, rows))));
  return page;
}

// --- the editor -----------------------------------------------------------------------------------------------
function editor(n, route, { go, reload }) {
  if (route === undefined) return h('div', { class: 'page' }, back(), h('div', { class: 'panel' }, emptyState('That route is gone', 'Someone may have removed it, here or from the in-game admin panel.', h('a', { class: 'btn', href: '#/routes', text: 'All routes' }))));
  const r = route ?? { name: '', code: '', from: n.servers[0]?.id ?? '', to: n.servers[1]?.id ?? '', terminal: null, landing: null, cost: [], money: 0, moneyFromAtm: false, vehicles: false, maxWeightKg: 0, hours: '', cooldownMin: 0, waitSeconds: 10, enabled: true };
  const isNew = !route;
  const errors = new Map();
  const uid = k => `rt-${k}`;
  const fieldError = k => { const p = h('p', { class: 'field-error', id: uid(`${k}-err`), role: 'alert', hidden: true }); errors.set(k, p); return p; };

  // Inputs
  const type = (value, title, text) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'rt-type', value, checked: (value === 'vehicle') === !!r.vehicles, 'aria-labelledby': `rt-type-${value}`, 'aria-describedby': `rt-type-${value}-d` }), h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', {}, h('strong', { id: `rt-type-${value}`, text: title }), h('small', { id: `rt-type-${value}-d`, text })));
  const fName = h('input', { id: uid('name'), type: 'text', maxlength: 48, value: r.name, required: true, 'aria-describedby': uid('name-err') });
  const fCode = h('input', { id: uid('code'), type: 'text', maxlength: 4, value: r.code, class: 'mono', placeholder: 'NL', autocomplete: 'off', 'aria-describedby': `${uid('code-hint')} ${uid('code-err')}` });
  const serverSelect = (k, value) => h('select', { id: uid(k), 'aria-describedby': uid(`${k}-err`) }, n.servers.map(s => h('option', { value: s.id, selected: s.id === value, text: s.name })));
  const fFrom = serverSelect('from', r.from), fTo = serverSelect('to', r.to);

  const zone = (k, z) => {
    const on = !!(z && z.radius > 0);
    const f = {
      x: h('input', { id: uid(`${k}-x`), type: 'number', class: 'mono', min: 0, max: 40960, step: 'any', value: on ? z.x : '', inputmode: 'decimal' }),
      z: h('input', { id: uid(`${k}-z`), type: 'number', class: 'mono', min: 0, max: 40960, step: 'any', value: on ? z.z : '', inputmode: 'decimal' }),
      radius: h('input', { id: uid(`${k}-r`), type: 'number', class: 'mono', min: 1, max: 2000, step: 'any', value: on ? z.radius : '', inputmode: 'decimal' }),
      label: h('input', { id: uid(`${k}-label`), type: 'text', maxlength: 40, value: on ? z.label : '' }),
      on,
    };
    return f;
  };
  const term = zone('terminal', r.terminal), land = zone('landing', r.landing);

  const costBox = h('div', { class: 'cost-lines' });
  const addCost = (c = { type: '', count: 1 }) => {
    const i = costBox.children.length;
    const t = h('input', { type: 'text', class: 'mono', value: c.type, placeholder: 'BandageDressing', 'aria-label': `Item class, line ${i + 1}`, spellcheck: 'false', autocomplete: 'off' });
    const k = h('input', { type: 'number', class: 'mono', min: 1, max: 100, step: 1, value: c.count, 'aria-label': `Count, line ${i + 1}`, inputmode: 'numeric' });
    const line = h('div', { class: 'cost-line' }, h('div', { class: 'field' }, i === 0 ? h('span', { class: 'key', text: 'Item class' }) : null, t), h('div', { class: 'field' }, i === 0 ? h('span', { class: 'key', text: 'Count' }) : null, k),
      h('button', { class: 'btn btn-quiet btn-icon', type: 'button', 'aria-label': `Remove line ${i + 1}`, onclick: () => { line.remove(); addBtn.disabled = costBox.children.length >= 8; draw(); } }, icon('cross')));
    costBox.append(line);
    addBtn.disabled = costBox.children.length >= 8;
    return t;
  };
  const addBtn = h('button', { class: 'btn', type: 'button', onclick: () => { addCost().focus(); draw(); } }, icon('plus'), 'Add an item');
  for (const c of r.cost) addCost(c);

  const fMoney = h('input', { id: uid('money'), type: 'number', class: 'mono', min: 0, max: MONEY_MAX, step: 1, value: r.money || '', placeholder: '0', inputmode: 'numeric', 'aria-describedby': `${uid('money-hint')} ${uid('money-err')}` });
  const fAtm = h('input', { id: uid('atm'), type: 'checkbox', checked: r.moneyFromAtm });
  const fWeight = h('input', { id: uid('weight'), type: 'number', class: 'mono', min: 0, max: 1000, step: 1, value: r.maxWeightKg || '', placeholder: 'No cap', inputmode: 'numeric' });
  const fHours = h('input', { id: uid('hours'), type: 'text', class: 'mono', value: r.hours, placeholder: 'Always', maxlength: 5, autocomplete: 'off', 'aria-describedby': `${uid('hours-hint')} ${uid('hours-err')}` });
  const fCool = h('input', { id: uid('cool'), type: 'number', class: 'mono', min: 0, max: 10080, step: 1, value: r.cooldownMin || '', placeholder: '0', inputmode: 'numeric' });
  const fWait = h('input', { id: uid('wait'), type: 'number', class: 'mono', min: 0, max: 120, step: 1, value: r.waitSeconds ?? '', placeholder: '0', inputmode: 'numeric' });
  const fOn = h('input', { id: uid('on'), type: 'checkbox', checked: r.enabled });

  const vehicle = () => form.querySelector('input[name="rt-type"]:checked')?.value === 'vehicle';

  // Leaves from / Lands at: a choice, then the zone's fields.
  const zoneBlock = (k, f, labels) => {
    const fields = h('div', { class: 'zone-fields' },
      h('div', { class: 'field' }, h('label', { for: f.x.id, text: 'x' }), f.x),
      h('div', { class: 'field' }, h('label', { for: f.z.id, text: 'z' }), f.z),
      h('div', { class: 'field' }, h('label', { for: f.radius.id, text: 'Radius, m' }), f.radius),
      h('div', { class: 'field' }, h('label', { for: f.label.id, text: 'Name players see' }), f.label));
    const hint = h('p', { class: 'hint' });
    const radios = [
      h('label', { class: 'choice choice-compact' }, h('input', { type: 'radio', name: `rt-${k}`, value: 'none', checked: !f.on, 'aria-labelledby': `rt-${k}-none` }), h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', {}, h('strong', { class: 'opt-none', id: `rt-${k}-none` }))),
      h('label', { class: 'choice choice-compact' }, h('input', { type: 'radio', name: `rt-${k}`, value: 'zone', checked: f.on, 'aria-labelledby': `rt-${k}-zone` }), h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', {}, h('strong', { class: 'opt-zone', id: `rt-${k}-zone` }))),
    ];
    const block = h('fieldset', { class: 'stack' }, h('legend', { class: 'sr-only', text: labels }), h('div', { class: 'choices' }, radios), h('div', { class: 'zone-wrap stack' }, fields, hint, fieldError(k)));
    block.zoneOn = () => block.querySelector(`input[name="rt-${k}"]:checked`)?.value === 'zone';
    block.hint = hint;
    return block;
  };
  const termBlock = zoneBlock('terminal', term, 'Leaves from');
  const landBlock = zoneBlock('landing', land, 'Lands at');
  const landTitle = h('h2', { id: 'rt-land-h' });

  const summary = h('div', { class: 'preview-route' });
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn btn-primary', type: 'submit', text: isNew ? 'Create route' : 'Save route' });
  const del = isNew ? null : h('button', { class: 'btn btn-danger', type: 'button', text: 'Delete route', onclick: () => remove(n, r, del, go, reload) });

  const section = (id, title, ...body) => h('section', { class: 'panel form-section', 'aria-labelledby': id }, typeof title === 'string' ? h('h2', { id, text: title }) : title, ...body);
  const form = h('form', { class: 'editor', novalidate: true },
    h('div', { class: 'stack' },
      section('rt-type-h', 'Foot or Vehicle', h('fieldset', {}, h('legend', { class: 'sr-only', text: 'Foot or Vehicle route' }), h('div', { class: 'choices' },
        type('foot', 'Foot route', 'Players on foot, alone or as a party, from a terminal. A car is refused.'),
        type('vehicle', 'Vehicle route', 'A party in a car, between vehicle terminals. Nobody goes on foot.')))),
      section('rt-what-h', 'Name and servers',
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', { for: fName.id, text: 'Route name' }), fName, fieldError('name')),
          h('div', { class: 'field' }, h('label', { for: fCode.id }, 'Board code', h('span', { class: 'optional', text: 'optional' })), fCode, h('p', { class: 'hint', id: uid('code-hint'), text: '2 to 4 letters or digits. Without one the board numbers it.' }), fieldError('code'))),
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', { for: fFrom.id, text: 'From' }), fFrom, fieldError('from')),
          h('div', { class: 'field' }, h('label', { for: fTo.id, text: 'To' }), fTo, fieldError('to')))),
      section('rt-dep-h', 'Leaves from', termBlock),
      section('rt-land-h', landTitle, landBlock),
      section('rt-fare-h', 'Fare',
        h('div', { class: 'field' }, h('span', { class: 'label', text: 'Items' }), h('p', { class: 'hint', text: 'Up to 8 item classes. An item that inherits the class counts. Count is items, not quantity.' }), costBox, h('div', {}, addBtn), fieldError('cost')),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: fMoney.id, text: 'Money fare' }), fMoney, h('p', { class: 'hint', id: uid('money-hint'), text: 'Expansion Market money, in the value its traders use. Needs mod 0.5.0 on the source.' }), fieldError('money'))),
        h('label', { class: 'check', for: fAtm.id }, fAtm, h('span', {}, 'Bank top-up', h('small', { text: 'The player\'s Expansion ATM balance pays what they do not carry.' })))),
      section('rt-rules-h', 'Rules',
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', { for: fWeight.id, text: 'Max load, kg' }), fWeight, fieldError('maxWeightKg')),
          h('div', { class: 'field' }, h('label', { for: fHours.id, text: 'Hours' }), fHours, h('p', { class: 'hint', id: uid('hours-hint'), text: 'In-game time, "06-22", or overnight "22-04". Empty is always.' }), fieldError('hours')),
          h('div', { class: 'field' }, h('label', { for: fCool.id, text: 'Cooldown, minutes' }), fCool, fieldError('cooldownMin')),
          h('div', { class: 'field' }, h('label', { for: fWait.id, text: 'Wait, seconds' }), fWait, fieldError('waitSeconds'))),
        h('label', { class: 'check', for: fOn.id }, fOn, h('span', {}, 'Enabled', h('small', { text: 'Off, the route stays on the board as closed.' }))))),
    h('aside', { class: 'editor-side' },
      h('div', { class: 'panel' }, summary),
      formError,
      h('div', { class: 'actions' }, save, h('a', { class: 'btn btn-quiet', href: '#/routes', text: 'Cancel' })),
      del ? h('div', { class: 'actions' }, del) : null));

  let lastType = null;
  const wasOn = { terminal: termBlock.zoneOn(), landing: landBlock.zoneOn() };
  function draw() {
    const v = vehicle();
    // A suggested radius follows the route type until the owner types their own.
    const kind = v ? 'vehicle' : 'foot';
    if (lastType && lastType !== kind) {
      const swap = (input, from, to) => { if (input.value === '' || Number(input.value) === from) input.value = to || ''; };
      swap(term.radius, SUGGEST[`${lastType}Terminal`], SUGGEST[`${kind}Terminal`]);
      swap(land.radius, SUGGEST[`${lastType}Landing`], SUGGEST[`${kind}Landing`]);
    }
    lastType = kind;
    termBlock.querySelector('.opt-none').textContent = 'Anywhere on the server';
    termBlock.querySelector('.opt-zone').textContent = v ? 'A vehicle terminal' : 'A terminal zone';
    termBlock.hint.textContent = `Players must stand inside it. ${v ? '12' : '3'} m around the terminal suits a ${v ? 'vehicle' : 'foot'} route.`;
    landTitle.textContent = v ? 'Vehicle arrival point' : 'Lands at';
    landBlock.querySelector('legend').textContent = landTitle.textContent;
    landBlock.querySelector('.opt-none').textContent = 'The server\'s landing points';
    landBlock.querySelector('.opt-zone').textContent = v ? 'A vehicle arrival point' : 'A landing zone';
    landBlock.hint.textContent = v ? 'Where the car and its party arrive. 25 m leaves room to land a car clear of others.' : 'Where players arrive. Leave it on the landing points to use the ones in the destination\'s config.json.';
    // Choosing a zone fills in the suggested radius once; after that the owner's number stands.
    for (const [k, block, f] of [['terminal', termBlock, term], ['landing', landBlock, land]]) {
      const on = block.zoneOn();
      if (on && !wasOn[k] && f.radius.value === '') f.radius.value = SUGGEST[`${kind}${k === 'terminal' ? 'Terminal' : 'Landing'}`];
      wasOn[k] = on;
    }
    termBlock.querySelector('.zone-wrap').hidden = !termBlock.zoneOn();
    landBlock.querySelector('.zone-wrap').hidden = !landBlock.zoneOn();
    fAtm.disabled = !(Number(fMoney.value) > 0);
    if (fAtm.disabled) fAtm.checked = false;
    const code = fCode.value.trim().toUpperCase() || (isNew ? 'NEW' : `R${n.routes.indexOf(r) + 1}`);
    summary.replaceChildren(
      h('div', { class: 'line' }, h('span', { class: 'code-chip', text: code }), h('span', { text: fName.value.trim() || 'Unnamed route' })),
      h('div', { class: 'line' }, h('span', { text: serverName(fFrom.value) }), icon('arrow'), h('span', { text: serverName(fTo.value) })),
      h('div', { class: 'actions' }, pill(v ? 'Vehicle route' : 'Foot route', 'quiet'), fOn.checked ? pill('Open', 'ok') : pill('Closed', 'warn')),
      h('p', { class: 'hint', text: `Fare: ${fareText({ cost: readCost(), money: Number(fMoney.value) || 0, moneyFromAtm: fAtm.checked })}.` }));
  }
  const readCost = () => [...costBox.children].map(line => { const [t, k] = line.querySelectorAll('input'); return { type: t.value.trim(), count: Number(k.value) }; }).filter(c => c.type || c.count !== 1);
  form.addEventListener('input', draw);
  form.addEventListener('change', draw);
  draw();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    formError.hidden = true;
    for (const p of errors.values()) p.hidden = true;
    for (const i of form.querySelectorAll('[aria-invalid]')) i.removeAttribute('aria-invalid');
    const num = (input, fallback = 0) => (input.value === '' ? fallback : Number(input.value));
    const zoneOf = (block, f) => block.zoneOn() ? { x: num(f.x, NaN), z: num(f.z, NaN), radius: num(f.radius, NaN), label: f.label.value.trim() } : null;
    const body = {
      ...(isNew ? {} : { id: r.id }),
      name: fName.value.trim(), code: fCode.value.trim().toUpperCase(), from: fFrom.value, to: fTo.value,
      terminal: zoneOf(termBlock, term), landing: zoneOf(landBlock, land),
      cost: readCost(), money: num(fMoney), moneyFromAtm: fAtm.checked && num(fMoney) > 0, vehicles: vehicle(),
      maxWeightKg: num(fWeight), hours: fHours.value.trim(), cooldownMin: num(fCool), waitSeconds: num(fWait), enabled: fOn.checked,
    };
    const problems = check(body);
    if (problems.length) {
      for (const [k, text] of problems) show(k, text);
      focusFirst(problems[0][0]);
      formError.hidden = false; formError.textContent = problems.length === 1 ? 'One thing to fix before it can be saved.' : `${problems.length} things to fix before it can be saved.`;
      return;
    }
    await busy(save, async () => {
      try {
        const out = await api('POST', `/v1/networks/${n.network.id}/routes`, body);
        const saved = isNew ? out.routes.find(x => !n.routes.some(y => y.id === x.id)) : out.routes.find(x => x.id === r.id);
        toast(isNew ? `Created ${saved?.name ?? body.name}.` : `Saved ${saved?.name ?? body.name}.`);
        await reload();
        go('#/routes');
      } catch (error) {
        formError.hidden = false; formError.textContent = `The API refused it: ${error.message}`;
        if (error.field) { show(error.field, error.message); focusFirst(error.field); }
        toastError(error, 'Route not saved');
      }
    });
  });

  function show(k, text) {
    const p = errors.get(k);
    if (p) { p.hidden = false; p.textContent = text; }
    const input = target(k);
    input?.setAttribute('aria-invalid', 'true');
  }
  function target(k) {
    return { name: fName, code: fCode, from: fFrom, to: fTo, money: fMoney, maxWeightKg: fWeight, hours: fHours, cooldownMin: fCool, waitSeconds: fWait, terminal: termBlock.zoneOn() ? (term.x.value === '' ? term.x : term.radius) : null, landing: landBlock.zoneOn() ? (land.x.value === '' ? land.x : land.radius) : null, cost: costBox.querySelector('input') }[k] ?? null;
  }
  function focusFirst(k) { (target(k) ?? form.querySelector('[aria-invalid="true"]'))?.focus(); }

  const page = h('div', { class: 'page' }, back(), h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: isNew ? 'New route' : r.name }), h('p', { class: 'lede', text: isNew ? 'Pick the kind first: it decides the terminal and the landing.' : `Route ${r.id}. The in-game admin panel shows the same fields.` }))), form);
  return page;
}

// The API's route rules, on the client, with its own sentences where it has them.
export function check(b) {
  const out = [];
  if (!b.name) out.push(['name', 'Name the route.']);
  if (b.code && !CODE.test(b.code)) out.push(['code', 'A route code is 2 to 4 letters or digits.']);
  if (b.from === b.to) out.push(['to', 'A route goes from one member server to another.']);
  for (const [k, z, what] of [['terminal', b.terminal, b.vehicles ? 'vehicle terminal' : 'terminal'], ['landing', b.landing, b.vehicles ? 'vehicle arrival point' : 'landing zone']]) {
    if (!z) continue;
    if (![z.x, z.z, z.radius].every(Number.isFinite) || z.x < 0 || z.z < 0 || z.x > 40960 || z.z > 40960) out.push([k, `Give the ${what}'s x and z in metres, 0 to 40960.`]);
    else if (!(z.radius > 0) || z.radius > 2000) out.push([k, `Give the ${what} a radius from 1 to 2000 m, or choose the other option.`]);
  }
  if (b.cost.length > 8 || b.cost.some(c => !CLASS_NAME.test(c.type) || !Number.isInteger(c.count) || c.count < 1 || c.count > 100)) out.push(['cost', 'A cost is up to 8 item classes (letters, digits and _), each 1 to 100 items.']);
  if (!Number.isInteger(b.money) || b.money < 0 || b.money > MONEY_MAX) out.push(['money', `A money fare is a whole amount from 0 to ${money(MONEY_MAX)}.`]);
  if (!Number.isInteger(b.maxWeightKg) || b.maxWeightKg < 0 || b.maxWeightKg > 1000) out.push(['maxWeightKg', 'Max load is a whole number of kg, 0 to 1000. 0 is no cap.']);
  const hm = HOURS.exec(b.hours);
  if (b.hours && (!hm || Number(hm[1]) > 23 || Number(hm[2]) > 24)) out.push(['hours', 'Hours are "08-20" in in-game time, or empty for always.']);
  if (!Number.isInteger(b.cooldownMin) || b.cooldownMin < 0 || b.cooldownMin > 10080) out.push(['cooldownMin', 'A cooldown is 0 to 10080 minutes (a week).']);
  if (!Number.isInteger(b.waitSeconds) || b.waitSeconds < 0 || b.waitSeconds > 120) out.push(['waitSeconds', 'A wait is 0 to 120 seconds.']);
  return out;
}

async function remove(n, r, btn, go, reload) {
  const ok = await confirmAction({ title: `Delete ${r.name}?`, text: `It leaves the board on ${serverName(r.from)} at the next beat. Trips already on their way still land.`, confirm: 'Delete route' });
  if (!ok) return;
  await busy(btn, async () => {
    try { await api('DELETE', `/v1/networks/${n.network.id}/routes/${r.id}`); toast(`Deleted ${r.name}.`); await reload(); go('#/routes'); }
    catch (error) { toastError(error, `${r.name} was not deleted`); }
  });
}

const back = () => h('a', { class: 'crumb', href: '#/routes' }, icon('back'), 'All routes');
