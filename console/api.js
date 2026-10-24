// The console's one door to the API. The token lives in this tab's sessionStorage only: it is sent as an
// Authorization header, never in a URL, and closing the tab forgets it.

const TOKEN = 'hwt.console.token';
const STAFF = 'hwt.console.staff';

function read(key) { try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; } }
function write(key, value) { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* private mode: kept in memory below */ } }
const memory = { token: '', staff: '' };

export const session = {
  get token() { return read(TOKEN) || memory.token; },
  get staff() { return read(STAFF) || memory.staff; },
  open(token, staff) { memory.token = token; memory.staff = staff; write(TOKEN, token); write(STAFF, staff); },
  close() { memory.token = ''; memory.staff = ''; write(TOKEN, ''); write(STAFF, ''); },
};

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', field = '', requestId = '' } = {}) {
    super(message);
    Object.assign(this, { status, code, field, requestId });
  }
}

let onUnauthorized = () => {};
export function whenUnauthorized(fn) { onUnauthorized = fn; }

export async function api(method, path, body, { token = session.token, quietAuth = false } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  // A header can only carry Latin-1, so the staff name goes percent-encoded; the API decodes it.
  if (session.staff) headers['x-travel-staff'] = encodeURIComponent(session.staff);
  if (body !== undefined) headers['content-type'] = 'application/json';
  let r;
  try {
    r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new ApiError('The API did not answer. Check that it is running and that this page is opened from it.', { code: 'offline' });
  }
  const requestId = r.headers.get('x-request-id') ?? '';
  if (r.status === 204) return null;
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) {
    const err = new ApiError(data?.error ?? `The API answered ${r.status}.`, { status: r.status, code: data?.code ?? '', field: data?.field ?? '', requestId });
    if (r.status === 401 && !quietAuth) onUnauthorized(err);
    throw err;
  }
  return data;
}
