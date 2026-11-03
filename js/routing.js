// Builds the "final route": the original plan's stops, with each night's stay swapped for the
// chosen Airbnb and extra places (restaurants, candidate sights) slotted into each day.
import { haversineKm, encodePolyline } from './util.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const evStop = e => ({
  key: 'ev:' + e.id, name: e.title, lat: e.lat, lng: e.lng, type: e.type, time: e.time,
  leg: e.leg, legFrom: e.legFrom ? 'ev:' + e.legFrom : null,
});

// The stay a day ends at in the original plan: that day's stay event, or where it returns to.
export const defaultNight = (T, d) =>
  (T.events.find(e => e.day === d && e.type === 'stay') || {}).id || (T.days.find(x => x.id === d) || {}).returnTo;

// Insert where it adds the least straight-line distance, never inside a walking stretch.
function insertCheapest(stops, s) {
  let best = -1, bestCost = Infinity;
  for (let i = 1; i < stops.length; i++) {
    const to = stops[i];
    if (to.leg !== 'drive') continue;
    const from = (to.legFrom && stops.find(x => x.key === to.legFrom)) || stops[i - 1];
    const cost = haversineKm(from, s) + haversineKm(s, to) - haversineKm(from, to);
    if (cost < bestCost) { bestCost = cost; best = i; }
  }
  if (best < 0) return;
  const to = stops[best];
  if (to.legFrom) { s.legFrom = to.legFrom; to.legFrom = null; }
  stops.splice(best, 0, s);
}

// sel = { nights: {1..4: stop|null}, stops: {1..5: [stop]} }; a stop is {key, name, lat, lng, type}
export function buildDays(T, sel) {
  const byId = Object.fromEntries(T.events.map(e => [e.id, e]));
  const last = T.days[T.days.length - 1].id;
  const night = d => (sel.nights[d] ? { ...sel.nights[d] } : evStop(byId[defaultNight(T, d)]));
  return T.days.map(({ id: d }) => {
    const stops = [];
    if (d > 1) stops.push({ ...night(d - 1), leg: 'none', legFrom: null, start: true });
    T.events.filter(e => e.day === d && e.type !== 'stay').forEach(e => stops.push(evStop(e)));
    if (d < last) stops.push({ ...night(d), leg: 'drive', legFrom: null, night: true });
    (sel.stops[d] || []).forEach(s => insertCheapest(stops, { ...s, leg: 'drive', legFrom: null, added: true }));
    return { day: d, stops };
  });
}

async function osrm(a, b) {
  const res = await fetch(`${OSRM}${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=polyline`);
  if (!res.ok) throw new Error(`导航服务返回 ${res.status}`);
  const j = await res.json();
  if (j.code !== 'Ok') throw new Error(`导航服务：${j.code}`);
  const r = j.routes[0];
  return { poly: r.geometry, km: +(r.distance / 1000).toFixed(1), min: Math.round(r.duration / 60) };
}

// Legs the original plan already has are reused; only new pairs go to the routing server.
export async function computeLegs(days, T, onProgress) {
  const byId = Object.fromEntries(T.events.map(e => [e.id, e]));
  const key = (a, b) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)}>${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
  const cache = new Map();
  T.legs.filter(l => l.mode === 'drive')
    .forEach(l => cache.set(key(byId[l.from], byId[l.to]), { poly: encodePolyline(l.coords), km: l.km, min: l.min }));

  const todo = [];
  days.forEach(({ day, stops }) => stops.forEach((s, i) => {
    if (i === 0 || s.leg === 'none') return;
    const from = (s.legFrom && stops.find(x => x.key === s.legFrom)) || stops[i - 1];
    todo.push({ day, from, to: s, mode: s.leg });
  }));

  const misses = todo.filter(t => t.mode === 'drive' && !cache.has(key(t.from, t.to)));
  for (let i = 0; i < misses.length; i++) {
    const t = misses[i];
    onProgress && onProgress(i + 1, misses.length);
    if (cache.has(key(t.from, t.to))) continue;
    cache.set(key(t.from, t.to), await osrm(t.from, t.to));
    await sleep(250); // the public OSRM server asks for gentle use
  }

  const flight = T.legs.find(l => l.mode === 'flight');
  return todo.map(t => {
    const base = { day: t.day, mode: t.mode, fromName: t.from.name, toName: t.to.name, toKey: t.to.key };
    if (t.mode === 'drive') return { ...base, ...cache.get(key(t.from, t.to)) };
    if (t.mode === 'flight') return { ...base, km: flight.km, min: flight.min, poly: encodePolyline(flight.coords) };
    const km = haversineKm(t.from, t.to) * 1.25;
    return { ...base, km: +km.toFixed(1), min: Math.round(km / 2.5 * 60),
      poly: encodePolyline([[t.from.lat, t.from.lng], [t.to.lat, t.to.lng]]) };
  });
}
