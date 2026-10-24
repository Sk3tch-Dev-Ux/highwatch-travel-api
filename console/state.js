// What the console knows: the last overview, and which network is open.
import { api } from './api.js';

const NETWORK = 'hwt.console.network';
export const state = { overview: null, at: 0, loading: null, failed: null };

export function networkId() {
  const all = state.overview?.networks ?? [];
  let id = '';
  try { id = sessionStorage.getItem(NETWORK) ?? ''; } catch { id = ''; }
  if (all.some(n => n.network.id === id)) return id;
  return all[0]?.network.id ?? '';
}
export function chooseNetwork(id) { try { sessionStorage.setItem(NETWORK, id); } catch { /* per tab only */ } }
export function net() { const id = networkId(); return state.overview?.networks.find(n => n.network.id === id) ?? null; }

export function serverName(id) {
  if (!id) return '';
  for (const n of state.overview?.networks ?? []) { const s = n.servers.find(x => x.id === id); if (s) return s.name; }
  return state.overview?.servers.find(x => x.id === id)?.name ?? id;
}
export function routeName(id) { return net()?.routes.find(r => r.id === id)?.name ?? ''; }

// One overview call at a time; a second caller waits for the first.
export async function loadOverview() {
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      state.overview = await api('GET', '/v1/overview');
      state.at = Date.now();
      state.failed = null;
    } catch (error) {
      state.failed = error;
      throw error;
    } finally { state.loading = null; }
    return state.overview;
  })();
  return state.loading;
}

// What needs the owner: stuck trips, held characters, offline servers, doctor warnings and failures.
export function attention(n = net()) {
  const out = { stuck: [], held: [], offline: [], doctor: [] };
  if (n) {
    out.stuck = n.transfers.filter(t => t.stuck);
    out.held = n.held;
    out.offline = n.servers.filter(s => !s.online);
  }
  out.doctor = (state.overview?.doctor?.results ?? []).filter(r => r.level !== 'OK');
  return out;
}
