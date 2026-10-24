// The network map: member servers as stations, routes as lines between them. A foot route is a solid line in the
// accent; a vehicle route a wider dashed line; a closed route is faded. Both directions of a pair bow apart so
// each route keeps its own line and its code.
import { h, s } from './ui.js';

// On a phone the map is drawn narrower and taller, so its text stays readable instead of shrinking.
export const NARROW = '(max-width: 700px)';
let W = 900, NODE_W = 168, NODE_H = 50;

export function networkMap(n) {
  const narrow = window.matchMedia(NARROW).matches;
  W = narrow ? 420 : 900; NODE_W = narrow ? 136 : 168;
  const servers = n.servers;
  const H = servers.length <= 2 ? (narrow ? 200 : 240) : narrow ? 480 : 400;
  const titleId = `map-t-${n.network.id}`, descId = `map-d-${n.network.id}`;
  const name = id => servers.find(x => x.id === id)?.name ?? id;
  const svg = s('svg', { class: 'map', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-labelledby': `${titleId} ${descId}` },
    s('title', { id: titleId, text: `Map of ${n.network.name}` }),
    s('desc', { id: descId, text: n.routes.length ? n.routes.map(r => `${r.vehicles ? 'Vehicle' : 'Foot'} route ${r.code || ''} ${r.name}, ${name(r.from)} to ${name(r.to)}${r.enabled ? '' : ', closed'}.`).join(' ') : 'No routes yet.' }),
    s('defs', {},
      marker('arrow-foot', 'arrow-foot'),
      marker('arrow-vehicle', 'arrow-vehicle'),
    ),
  );
  if (!servers.length) {
    svg.append(s('text', { class: 'empty', x: W / 2, y: H / 2, 'text-anchor': 'middle', text: 'Add servers to the network to see the map.' }));
    return wrap(svg, false);
  }

  // Stations on an ellipse, the first at the top (or left and right for two).
  const pos = new Map();
  const cx = W / 2, cy = H / 2, rx = W / 2 - NODE_W / 2 - 24, ry = H / 2 - NODE_H / 2 - 18;
  servers.forEach((srv, i) => {
    const k = servers.length;
    const a = k === 1 ? -Math.PI / 2 : k === 2 ? Math.PI * (i === 0 ? 1 : 0) : -Math.PI / 2 + (i * 2 * Math.PI) / k;
    pos.set(srv.id, { x: k === 1 ? cx : cx + rx * Math.cos(a), y: k === 1 ? cy : cy + ry * Math.sin(a) });
  });

  // Group routes by their pair of servers, in one fixed orientation, so offsets are shared by both directions.
  const pairs = new Map();
  for (const r of n.routes) {
    if (!pos.has(r.from) || !pos.has(r.to)) continue;
    const key = [r.from, r.to].sort().join('|');
    pairs.set(key, [...(pairs.get(key) ?? []), r]);
  }
  const edges = s('g', {}), labels = s('g', {});
  for (const [key, list] of pairs) {
    const [a, b] = key.split('|');
    const A = pos.get(a), B = pos.get(b);
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    list.forEach((r, i) => {
      const off = (i - (list.length - 1) / 2) * 34;
      const C = { x: (A.x + B.x) / 2 + nx * off, y: (A.y + B.y) / 2 + ny * off };
      const F = pos.get(r.from), T = pos.get(r.to);
      const start = exit(F, C, 4), end = exit(T, C, 10);
      const kind = r.vehicles ? 'vehicle' : 'foot';
      edges.append(s('path', { class: `edge ${kind}${r.enabled ? '' : ' off'}`, d: `M${start.x.toFixed(1)} ${start.y.toFixed(1)} Q${C.x.toFixed(1)} ${C.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`, 'marker-end': `url(#arrow-${kind})` }));
      const mid = { x: 0.25 * start.x + 0.5 * C.x + 0.25 * end.x, y: 0.25 * start.y + 0.5 * C.y + 0.25 * end.y };
      const text = r.code || `R${n.routes.indexOf(r) + 1}`;
      const w = 12 + text.length * 7.4;
      labels.append(s('g', { class: 'edge-label' },
        s('rect', { x: (mid.x - w / 2).toFixed(1), y: (mid.y - 10).toFixed(1), width: w.toFixed(1), height: 20, rx: 4 }),
        s('text', { x: mid.x.toFixed(1), y: (mid.y + 4).toFixed(1), 'text-anchor': 'middle', text })));
    });
  }
  svg.append(edges, labels);

  const start = n.network.settings?.startServer ?? '';
  for (const srv of servers) {
    const p = pos.get(srv.id);
    const state = [srv.online ? 'online' : 'offline', srv.open ? '' : 'closed'].filter(Boolean).join(' ');
    const sub = `${srv.world || 'world not reported'}  ${srv.online ? `${srv.players}/${srv.slots || '?'}` : 'offline'}${srv.open ? '' : ', closed'}${start === srv.id ? ', start' : ''}`;
    svg.append(s('a', { class: `node ${state}`, href: '#/servers', 'aria-label': `${srv.name}: ${srv.online ? 'online' : 'offline'}${srv.open ? '' : ', closed to arrivals'}` },
      s('rect', { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2, width: NODE_W, height: NODE_H, rx: 8 }),
      s('text', { class: 'name', x: p.x - NODE_W / 2 + 14, y: p.y - 3, text: clip(srv.name, narrow ? 13 : 17) }),
      s('text', { class: 'world', x: p.x - NODE_W / 2 + 14, y: p.y + 14, text: clip(sub, narrow ? 19 : 24) }),
      s('circle', { class: 'state', cx: p.x + NODE_W / 2 - 14, cy: p.y - NODE_H / 2 + 14, r: 5 })));
  }
  return wrap(svg, n.routes.length > 0);
}

function wrap(svg, legend = true) {
  const line = cls => s('svg', { viewBox: '0 0 34 10', 'aria-hidden': 'true' }, s('line', { class: cls, x1: 1, y1: 5, x2: 33, y2: 5 }));
  return h('div', {}, svg, !legend ? null : h('div', { class: 'legend', 'aria-hidden': 'true' },
    h('span', {}, line('l-foot'), 'Foot route'),
    h('span', {}, line('l-vehicle'), 'Vehicle route'),
    h('span', {}, line('l-off'), 'Closed route')));
}

function marker(id, cls) {
  return s('marker', { id, viewBox: '0 0 10 10', refX: 6, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' },
    s('path', { class: cls, d: 'M0 0 10 5 0 10z' }));
}

// Where the line from a station's centre toward a point leaves the station's box, plus a gap.
function exit(P, toward, gap) {
  const dx = toward.x - P.x, dy = toward.y - P.y;
  const hw = NODE_W / 2 + gap, hh = NODE_H / 2 + gap;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: P.x + dx * t, y: P.y + dy * t };
}
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
