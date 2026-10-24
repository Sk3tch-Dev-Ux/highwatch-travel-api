// Small DOM helpers. Every text goes in through textContent, never innerHTML, so nothing a game server or a player
// name carries can become markup.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) if (c) el.append(c);
  return el;
}

// Outline icons on a 24 grid, the same set the in-game screens use.
const PATHS = {
  check: 'M20 6 9 17l-5-5',
  alert: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01',
  clock: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19M12 7v5l3.5 2',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1',
  package: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7 12 12l8.7-5M12 22V12',
  nosignal: 'M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76M2 2l20 20',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  cross: 'M18 6 6 18M6 6l12 12',
  copy: 'M9 9h10v12H9zM5 15V3h10',
  key: 'M15 7a4 4 0 1 1-3.87 5H8v3H5v-3H3v-3h8.13A4 4 0 0 1 15 7Z',
  pin: 'M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
};
export function icon(name, cls = 'icon') {
  return s('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: PATHS[name] ?? PATHS.alert }));
}

// --- toasts: every action says what happened ------------------------------------------------------------------
export function toast(text, { error = false, detail = '' } = {}) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast${error ? ' error' : ''}` }, icon(error ? 'alert' : 'check'), h('div', {}, text, detail ? h('small', { text: detail }) : null));
  box.append(t);
  const ttl = error ? 9000 : 4500;
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 200); }, ttl);
}
export function toastError(error, what) {
  const detail = [error?.code ? `code ${error.code}` : '', error?.requestId && error?.status >= 500 ? `request ${error.requestId}` : ''].filter(Boolean).join(', ');
  toast(what ? `${what}: ${error?.message ?? 'it failed.'}` : (error?.message ?? 'That failed.'), { error: true, detail });
}

// --- dialogs ------------------------------------------------------------------------------------------------
// A native <dialog>: focus is trapped and Esc cancels. Resolves with the value of the button pressed.
export function dialog({ title, body = [], buttons = [], onOpen, labelledBy } = {}) {
  return new Promise(resolve => {
    const id = `dlg-${Math.random().toString(36).slice(2)}`;
    const foot = h('div', { class: 'dialog-foot' });
    const d = h('dialog', { 'aria-labelledby': `${id}-t` }, h('div', { class: 'dialog-body' }, h('h2', { id: `${id}-t`, text: title }), body), foot);
    let result = null;
    for (const b of buttons) {
      const btn = h('button', { class: `btn ${b.class ?? ''}`, type: 'button', text: b.label, onclick: async () => {
        if (b.run) { btn.classList.add('busy'); try { const ok = await b.run(); btn.classList.remove('busy'); if (ok === false) return; } catch { btn.classList.remove('busy'); return; } }
        result = b.value; d.close();
      } });
      if (b.autofocus) btn.dataset.autofocus = '1';
      foot.append(btn);
    }
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    document.body.append(d);
    d.showModal();
    (d.querySelector('[data-autofocus]') ?? d.querySelector('input, select, button'))?.focus();
    onOpen?.(d);
  });
}

// Every destructive action asks first. Cancel has the focus, so Enter alone never destroys anything.
export async function confirmAction({ title, text, confirm, danger = true, extra = null }) {
  const v = await dialog({
    title,
    body: [h('p', { text }), extra],
    buttons: [
      { label: 'Cancel', value: false, class: 'btn-quiet', autofocus: true },
      { label: confirm, value: true, class: danger ? 'btn-danger solid' : 'btn-primary' },
    ],
  });
  return v === true;
}

// A server key, shown once.
export async function showKey({ title, name, key, lead }) {
  const input = h('input', { type: 'text', readonly: true, value: key, class: 'mono', 'aria-label': `Server key for ${name}`, spellcheck: 'false' });
  const status = h('p', { class: 'hint', 'aria-live': 'polite' });
  const copy = h('button', { class: 'btn', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(key); status.textContent = 'Copied to the clipboard.'; copy.textContent = 'Copied'; }
    catch { input.focus(); input.select(); status.textContent = 'This browser blocked the clipboard. The key is selected: press Ctrl+C.'; }
  } }, icon('copy'), 'Copy');
  await dialog({
    title,
    body: [
      h('p', { text: lead }),
      h('div', { class: 'key-box' }, input, copy),
      status,
      h('div', { class: 'once' }, icon('alert'), h('span', {}, h('strong', { text: 'It will not be shown again. ' }), 'Only its fingerprint is stored. Put it in that game server\'s profiles\\HighwatchTravel\\config.json as "apiKey" now.')),
    ],
    buttons: [{ label: 'I have saved the key', value: true, class: 'btn-primary' }],
    onOpen: () => { input.focus(); input.select(); },
  });
}

// --- busy buttons ---------------------------------------------------------------------------------------------
export async function busy(btn, fn) {
  if (!btn) return fn();
  btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  try { return await fn(); } finally { btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); btn.disabled = false; }
}

// --- text -----------------------------------------------------------------------------------------------------
export function ago(iso, now = Date.now()) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return agoSec(s);
}
export function agoSec(s) {
  if (s === null || s === undefined) return 'never';
  if (s < 5) return 'just now';
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
export function until(iso, now = Date.now()) {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return `${agoSec(-s).replace(' ago', '')} overdue`;
  if (s < 90) return `in ${s} s`;
  return `in ${Math.round(s / 60)} min`;
}
export function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const grid = (x, z) => `${String(Math.floor(x / 100)).padStart(3, '0')} ${String(Math.floor(z / 100)).padStart(3, '0')}`;
export const money = n => Number(n).toLocaleString('en-US');

export function pill(text, tone) { return h('span', { class: `pill ${tone}`, text }); }
export function emptyState(title, text, action) {
  return h('div', { class: 'empty-state' }, h('h3', { text: title }), h('p', { text }), action ?? null);
}
export function skeleton(rows = 3) {
  return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' }, h('i', { class: 'tall' }), Array.from({ length: rows }, () => h('i')));
}
