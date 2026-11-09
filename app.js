import { firebaseConfig } from './firebase-config.js';
import { createDB } from './js/db.js';
import { buildDays, computeLegs, defaultNight } from './js/routing.js';
import { esc, safeUrl, fmtMin, gmaps, decodePolyline, loadPref, savePref } from './js/util.js';

const T = window.TRIP;
const byId = Object.fromEntries(T.events.map(e => [e.id, e]));
const dayById = Object.fromEntries(T.days.map(d => [d.id, d]));
const areaById = Object.fromEntries(T.airbnbAreas.map(a => [a.id, a]));
const LAST_DAY = T.days[T.days.length - 1].id;

const ICON = {
  flight: '✈️', car: '🚙', stay: '🛏️', sight: '📍', park: '🏔️', hike: '🥾', food: '🍽️', event: '🎄', amphi: '🎸',
  airbnb: '🏠', restaurant: '🍽️', cand: '⭐',
};
const MODE = { drive: '🚗', walk: '🚶', flight: '✈️' };
const TIERS = [
  ['概览', '只显示路线和主要节点 · 放大看更多'],
  ['区域', '显示各站名称和 Airbnb 区域 · 继续放大看房源'],
  ['详情', '显示时间和每套房源价格 · 悬停预览，点击看链接'],
  ['完整', '显示每站说明和房源名称、评分'],
];
// Things friends can add. `cat` is the filter category the marker belongs to.
const PLACE = {
  airbnb: { label: 'Airbnb', icon: '🏠', add: '添加 Airbnb', cat: 'airbnb', color: '#e11d48' },
  sight: { label: '可能的景点', icon: '⭐', add: '添加可能的景点', cat: 'cand', color: '#0e7490' },
  restaurant: { label: '餐厅', icon: '🍽️', add: '添加餐厅', cat: 'food', color: '#b45309' },
};
const CATS = [
  ['sight', '📍 行程景点'],
  ['cand', '⭐ 候选景点（大家添加的）'],
  ['food', '🍽️ 餐厅'],
  ['airbnb', '🏠 Airbnb 房源'],
  ['logistics', '✈️ 机场 / 住宿节点'],
];
const evCat = e => e.type === 'food' ? 'food' : ['stay', 'flight', 'car'].includes(e.type) ? 'logistics' : 'sight';
const nightDate = d => dayById[d].date.split(' ')[0];
const ts = p => (p.createdAt && p.createdAt.toMillis ? p.createdAt.toMillis() : p.createdAt) || 0;

const fmtLeg = l => l.mode === 'flight' ? `✈️ 约 ${fmtMin(l.min)}` : `${MODE[l.mode]} ${fmtMin(l.min)} · ${l.km} km`;
const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
const padTL = () => isPhone() ? [20, 20] : [380, 20];
const padBR = () => isPhone() ? [20, Math.round(window.innerHeight * 0.46) + 20] : [20, 20];
const popupOpts = () => ({ className: 'pop', maxWidth: 320, autoPanPaddingTopLeft: padTL(), autoPanPaddingBottomRight: padBR() });

const state = {
  db: null, user: null, canEdit: false,
  places: [],          // added by friends (from the shared database)
  final: null,         // confirmed final plan, or null
  finalLegs: null,     // final plan legs with decoded coordinates
  version: 'base',     // which route is drawn: 'base' (original plan) or 'final'
  justSaved: false,
  hidden: new Set(loadPref('trip.hidden', [])),         // hidden marker categories
  hiddenDays: new Set(loadPref('trip.hiddenDays', [])), // days whose route is hidden
  activeDay: 'all',
  fin: null,           // selection while choosing the final route
};

const panel = document.getElementById('panel');
const it = document.getElementById('itinerary');

// ---------- map & base layers ----------
const map = L.map('map', { zoomControl: false, minZoom: 4, maxZoom: 18, zoomSnap: 0.5 });
const mapEl = map.getContainer();
const bases = {
  '街道': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · 路线 OSRM',
  }),
  '地形': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri · 路线 OSRM / OpenStreetMap',
  }),
  '卫星': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri · 路线 OSRM / OpenStreetMap',
  }),
};
bases['街道'].addTo(map);
L.control.layers(bases, null, { position: 'topright' }).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

const fitAll = () => map.fitBounds(T.meta.bounds, { paddingTopLeft: padTL(), paddingBottomRight: padBR() });
map.setView(L.latLngBounds(T.meta.bounds).getCenter(), 9);
// The page can load while its tab is hidden (0×0 map), which makes fitBounds jump to max zoom.
if (map.getSize().x && map.getSize().y) fitAll();
else {
  const ro = new ResizeObserver(() => {
    if (!mapEl.clientWidth) return;
    ro.disconnect();
    map.invalidateSize();
    fitAll();
  });
  ro.observe(mapEl);
}

// Centre a point in the part of the map the side panel doesn't cover.
function flyToVisible(latlng, zoom) {
  const [l, t] = padTL(), [r, b] = padBR();
  const target = map.unproject(map.project(latlng, zoom).subtract(L.point((l - r) / 2, (t - b) / 2)), zoom);
  map.flyTo(target, zoom, { duration: 0.8 });
}

// ---------- routes (original plan or final) ----------
const baseLegs = T.legs.map(l => ({
  day: l.day, mode: l.mode, km: l.km, min: l.min, coords: l.coords,
  fromName: byId[l.from].title, toName: byId[l.to].title, toKey: 'ev:' + l.to,
}));
const showingFinal = () => state.version === 'final' && !!state.final;
const activeLegs = () => showingFinal() ? state.finalLegs : baseLegs;

let routeLayers = []; // {leg, day, mode, lines: [casing?, line], cum}
function drawRoutes() {
  stopAnimation();
  routeLayers.forEach(r => r.lines.forEach(ln => ln.remove()));
  routeLayers = activeLegs().map(l => {
    const color = dayById[l.day].color;
    const lines = l.mode === 'drive'
      ? [L.polyline(l.coords, { color: '#fff', weight: 8, opacity: .9, interactive: false }), L.polyline(l.coords, { color, weight: 4.5, opacity: .95 })]
      : l.mode === 'walk'
        ? [L.polyline(l.coords, { color, weight: 3.5, opacity: .95, dashArray: '2 7', lineCap: 'round' })]
        : [L.polyline(l.coords, { color, weight: 2.5, opacity: .8, dashArray: '8 8' })];
    const top = lines[lines.length - 1];
    const w = top.options.weight;
    top.bindTooltip(`<b>D${l.day} · ${esc(l.fromName)} → ${esc(l.toName)}</b><br>${fmtLeg(l)}`, { sticky: true, className: 'tip' });
    top.on('mouseover', () => top.setStyle({ weight: w + 2.5 }));
    top.on('mouseout', () => top.setStyle({ weight: w }));
    return { leg: l, day: l.day, mode: l.mode, lines, cum: null };
  });
  styleRoutes();
}

// Day checkboxes decide whether a route is on the map; the day tabs only dim the others.
function styleRoutes() {
  routeLayers.forEach(r => {
    const visible = !state.hiddenDays.has(r.day);
    const lit = state.activeDay === 'all' || r.day === state.activeDay;
    r.lines.forEach((ln, i) => {
      if (!visible) { ln.remove(); return; }
      if (!map.hasLayer(ln)) ln.addTo(map);
      ln.setStyle({ opacity: lit ? (r.mode === 'flight' ? .8 : i === 0 && r.lines.length > 1 ? .9 : .95) : .15 });
      if (lit) ln.bringToFront();
    });
  });
}

// ---------- route animation: each day draws from start to end like a progress bar ----------
const head = L.circleMarker([0, 0], { radius: 6, weight: 3, color: '#fff', fillOpacity: 1, interactive: false });
let animToken = 0;

function cumDist(r) {
  if (!r.cum) {
    const c = r.leg.coords;
    r.cum = [0];
    for (let i = 1; i < c.length; i++) r.cum.push(r.cum[i - 1] + Math.hypot(c[i][0] - c[i - 1][0], (c[i][1] - c[i - 1][1]) * 0.77));
  }
  return r.cum;
}

// Show the first fraction f of a leg; returns the point the line has reached.
function setPartial(r, f) {
  const c = r.leg.coords;
  if (f >= 1 || c.length < 2) { r.lines.forEach(ln => ln.setLatLngs(c)); return c[c.length - 1]; }
  const cum = cumDist(r), target = cum[cum.length - 1] * f;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const t = Math.max(0, Math.min(1, (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
  const tip = [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * t, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t];
  const part = c.slice(0, i).concat([tip]);
  r.lines.forEach(ln => ln.setLatLngs(part));
  return tip;
}

function playRoutes() {
  const token = ++animToken;
  const seq = routeLayers.filter(r => !state.hiddenDays.has(r.day));
  if (!seq.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  seq.forEach(r => setPartial(r, 0));
  document.getElementById('btn-play').classList.add('playing');
  let i = 0, start = null, prevDay = seq[0].day;
  const frame = now => {
    if (token !== animToken) return;
    const r = seq[i];
    if (!r) { finishAnimation(); return; }
    if (start === null) start = now + (r.day !== prevDay ? 400 : 0); // short pause between days
    const dur = r.mode === 'flight' ? 1400 : r.mode === 'walk' ? 450 : Math.min(1600, 250 + r.leg.km * 15);
    const f = Math.max(0, Math.min(1, (now - start) / dur));
    head.setLatLng(setPartial(r, f)).setStyle({ fillColor: dayById[r.day].color });
    if (!map.hasLayer(head)) head.addTo(map);
    head.bringToFront();
    if (f >= 1) { i++; start = null; prevDay = r.day; }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function finishAnimation() {
  head.remove();
  document.getElementById('btn-play').classList.remove('playing');
}

function stopAnimation() {
  animToken++;
  routeLayers.forEach(r => setPartial(r, 1));
  finishAnimation();
}

// ---------- region labels (overview only) ----------
T.regions.forEach(r => {
  L.marker([r.lat, r.lng], {
    interactive: false, keyboard: false,
    icon: L.divIcon({ className: 'region-marker', iconSize: null, iconAnchor: [0, 0], html: `<div class="region side-${r.side || 'top'}"><b>${esc(r.name)}</b><span>${esc(r.days)}</span></div>` }),
  }).addTo(map);
});

// Every clickable marker, keyed like the stops in a plan: ev:<event id>, bnb:<listing id>, place:<doc id>
const markerByKey = {};
const baseCatalog = {};

// ---------- event markers ----------
const nearbyButtons = ids => ids.length ? `<div class="nearby"><div class="nearby-h">附近的 Airbnb</div>${ids.map(id =>
  `<button data-area="${id}">🏠 ${esc(areaById[id].name)} · ${areaById[id].listings.length} 套</button>`).join('')}</div>` : '';
const baseLegTo = Object.fromEntries(baseLegs.map(l => [l.day + '|' + l.toKey, l]));

const eventMarkers = {};
T.events.forEach(e => {
  const d = dayById[e.day];
  const key = 'ev:' + e.id;
  baseCatalog[key] = { key, name: e.title, lat: e.lat, lng: e.lng, type: e.type };
  const html = `<div class="ev" style="--c:${d.color}">
      <div class="ev-dot"><span>${ICON[e.type]}</span><span class="ev-day">D${e.day}</span></div>
      <div class="ev-label"><div class="ev-l1"><span class="ev-time">${esc(e.time)}</span><span class="ev-title">${esc(e.title)}</span></div>
      <div class="ev-short">${esc(e.short)}</div></div></div>`;
  const m = L.marker([e.lat, e.lng], {
    icon: L.divIcon({ className: `ev-marker imp-${e.imp} day-${e.day} cat-${evCat(e)}`, html, iconSize: null, iconAnchor: [0, 0] }),
    zIndexOffset: 2000 - e.imp * 300,
    riseOnHover: true,
  });
  const leg = baseLegTo[e.day + '|' + key];
  m.bindTooltip(`<b>${ICON[e.type]} ${esc(e.title)}</b><br><span class="muted">D${e.day} · ${esc(d.date)} · ${esc(e.time)}</span><br>${esc(e.short)}<div class="hint">点击查看详情和链接</div>`,
    { direction: 'top', offset: [0, -18], className: 'tip' });
  const links = [...e.links.map(k => `<a href="${esc(k.url)}" target="_blank" rel="noopener">${esc(k.label)} ↗</a>`),
    `<a href="${gmaps(e.lat, e.lng)}" target="_blank" rel="noopener">Google 地图导航 ↗</a>`];
  m.bindPopup(`<div class="pop-body" style="--c:${d.color}">
      <div class="pop-head"><span class="pill">D${e.day} · ${esc(d.date)}</span><span>${esc(e.time)}</span></div>
      <h3>${ICON[e.type]} ${esc(e.title)}</h3>
      <p>${esc(e.desc)}</p>
      ${e.tips.length ? `<ul class="tips">${e.tips.map(t => `<li>💡 ${esc(t)}</li>`).join('')}</ul>` : ''}
      <div class="links">${links.join('')}</div>
      ${leg ? `<div class="legin">从上一站过来：${fmtLeg(leg)}</div>` : ''}
      ${nearbyButtons(e.nearby)}
    </div>`, popupOpts());
  m.on('click', () => onMarkerClick(key));
  m.addTo(map);
  eventMarkers[e.id] = m;
  markerByKey[key] = m;
});

// ---------- Airbnb (researched listings) ----------
const KIND = [['Farm stay', '农场民宿'], ['Townhouse', '联排别墅'], ['Cabin', '小木屋'], ['Condo', '公寓'], ['Villa', '别墅'], ['Rooms', '独立房间'], ['Home', '整栋房子']];
const kindZh = k => (KIND.find(([en]) => k.startsWith(en)) || [null, k])[1] + k.replace(/^.*? in /, ' · ');
const roomsZh = s => s.split(', ').map(p => p
  .replace(/^([\d.]+) bedrooms?$/, '$1 卧').replace(/^([\d.]+) (queen |king )?beds?$/, '$1 床')
  .replace(/^([\d.]+) baths?$/, '$1 卫')).join(' · ');
const nightsLabel = a => `${a.checkin.slice(5).replace('-', '/')}–${a.checkout.slice(5).replace('-', '/')} · ${a.nights} 晚`;
const bnbMarkers = [];
const areaMarkers = {};

T.airbnbAreas.forEach(a => {
  const ll = a.listings.map(x => [x[3], x[4]]);
  a.bounds = L.latLngBounds(ll);
  const center = [ll.reduce((s, p) => s + p[0], 0) / ll.length, ll.reduce((s, p) => s + p[1], 0) / ll.length];
  const searchUrl = `https://www.airbnb.com/s/${encodeURIComponent(a.searchQuery)}/homes?checkin=${a.checkin}&checkout=${a.checkout}&adults=8`;

  const am = L.marker(center, {
    icon: L.divIcon({ className: 'area-marker cat-airbnb', iconSize: null, iconAnchor: [0, 0], html: `<div class="area">🏠<b>${a.listings.length}</b><span class="nm">${esc(a.name)}</span></div>` }),
    zIndexOffset: 500,
  });
  am.bindTooltip(`<b>🏠 ${esc(a.name)}</b><br>${esc(a.forNights)}<br><span class="muted">${a.listings.length} 套适合 8 人的房源 · ${nightsLabel(a)}</span><div class="hint">点击放大查看每一套</div>`,
    { direction: 'top', offset: [0, -14], className: 'tip' });
  am.on('click', () => showArea(a.id));
  am.addTo(map);
  areaMarkers[a.id] = am;

  a.listings.forEach(([id, kind, name, lat, lng, price, rating, rooms, pic]) => {
    const key = 'bnb:' + id;
    baseCatalog[key] = { key, name, lat, lng, type: 'airbnb', price };
    const img = pic ? `${pic}?im_w=480` : '';
    const ratingTxt = rating && rating !== 'New' ? `★ ${rating}` : '新房源';
    const roomUrl = `https://www.airbnb.com/rooms/${id}?adults=8&check_in=${a.checkin}&check_out=${a.checkout}`;
    const m = L.marker([lat, lng], {
      icon: L.divIcon({
        className: `bnb-marker cat-airbnb area-${a.id}`, iconSize: null, iconAnchor: [0, 0],
        html: `<div class="bnb"><span class="bnb-ic">🏠</span><span class="bnb-price">${esc(price)}</span><span class="bnb-more">${esc(ratingTxt)} · ${esc(name)}</span></div>`,
      }),
      riseOnHover: true,
    });
    m.bindTooltip(`${img ? `<img src="${img}" alt="" loading="lazy">` : ''}<b>${esc(name)}</b><br>
        <span class="muted">${esc(kindZh(kind))}</span><br>${esc(roomsZh(rooms))} · ${esc(ratingTxt)}<br>
        <b>${esc(price)}</b> <span class="muted">/ ${nightsLabel(a)} 总价</span><div class="hint">点击查看链接</div>`,
      { direction: 'top', offset: [0, -30], className: 'tip' });
    m.bindPopup(`${img ? `<img class="photo" src="${img}" alt="">` : ''}<div class="pop-body" style="--c:var(--bnb)">
        <div class="pop-head"><span class="pill">🏠 ${esc(a.name)}</span><span>${esc(a.forNights)}</span></div>
        <h3>${esc(name)}</h3>
        <p>${esc(kindZh(kind))}<br>${esc(roomsZh(rooms))} · ${esc(ratingTxt)}</p>
        <p><b style="font-size:16px">${esc(price)}</b> <span class="muted">${nightsLabel(a)} 总价，8 人</span></p>
        <div class="links">
          <a class="primary" href="${roomUrl}" target="_blank" rel="noopener">在 Airbnb 打开 ↗</a>
          <a href="${gmaps(lat, lng)}" target="_blank" rel="noopener">Google 地图 ↗</a>
          <a href="${searchUrl}" target="_blank" rel="noopener">这一带全部房源 ↗</a>
        </div>
        <div class="fine">价格是 ${T.meta.airbnbQueried} 查询时 Airbnb 显示的总价，最终以结算页为准；Airbnb 只公开大致位置，图钉可能偏差几百米。</div>
      </div>`, popupOpts());
    m.on('click', () => onMarkerClick(key));
    m.addTo(map);
    m._area = a.id;
    bnbMarkers.push(m);
    markerByKey[key] = m;
  });
});

function showArea(id) {
  const a = areaById[id];
  map.closePopup();
  map.flyToBounds(a.bounds.pad(0.25), { paddingTopLeft: padTL(), paddingBottomRight: padBR(), maxZoom: 13.5, duration: 0.8 });
  map.once('moveend', () => {
    if (map.getZoom() < 12) map.setZoom(12);
    bnbMarkers.filter(m => m._area === id).forEach(m => {
      const el = m.getElement();
      if (!el) return;
      el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
    });
  });
}

// ---------- places friends added ----------
const placeLayer = L.layerGroup().addTo(map);
let placeMarkers = [];
const placeStop = p => p && { key: 'place:' + p.id, name: p.name, lat: p.lat, lng: p.lng, type: p.type === 'sight' ? 'cand' : p.type };
const stopFor = key => key.startsWith('place:') ? placeStop(state.places.find(p => 'place:' + p.id === key)) : baseCatalog[key];
const placeWhen = p => !p.day ? '' : p.type === 'airbnb' ? `第 ${p.day} 晚 · ${nightDate(p.day)}` : `D${p.day}`;

function placeMarker(p) {
  const P = PLACE[p.type] || PLACE.sight;
  const when = placeWhen(p);
  const url = safeUrl(p.url);
  const by = p.createdByName || p.createdBy || '';
  const icon = p.type === 'airbnb'
    ? L.divIcon({
      className: 'bnb-marker user-added cat-airbnb', iconSize: null, iconAnchor: [0, 0],
      html: `<div class="bnb"><span class="bnb-ic">🏠</span><span class="bnb-price">${esc(p.price || '新')}</span><span class="bnb-more">${esc(p.name)}</span></div>`,
    })
    : L.divIcon({
      className: `ev-marker imp-2 user-added cat-${P.cat}`, iconSize: null, iconAnchor: [0, 0],
      html: `<div class="ev" style="--c:${P.color}"><div class="ev-dot"><span>${P.icon}</span>${p.day ? `<span class="ev-day">D${p.day}</span>` : ''}</div>
        <div class="ev-label"><div class="ev-l1"><span class="ev-time">${esc(P.label)}</span><span class="ev-title">${esc(p.name)}</span></div>
        <div class="ev-short">${esc(p.note || (by ? `由 ${by} 添加` : ''))}</div></div></div>`,
    });
  const m = L.marker([p.lat, p.lng], { icon, zIndexOffset: 1200, riseOnHover: true });
  m.bindTooltip(`<b>${P.icon} ${esc(p.name)}</b><br><span class="muted">${esc(P.label)}${when ? ' · ' + esc(when) : ''}${p.price ? ' · ' + esc(p.price) : ''}</span>
      ${p.note ? `<br>${esc(p.note)}` : ''}<div class="hint">由 ${esc(by)} 添加 · 点击查看链接</div>`,
    { direction: 'top', offset: [0, p.type === 'airbnb' ? -30 : -18], className: 'tip' });
  const links = [
    url && `<a class="primary" href="${esc(url)}" target="_blank" rel="noopener">${/airbnb\./i.test(url) ? '在 Airbnb 打开' : '打开链接'} ↗</a>`,
    `<a href="${gmaps(p.lat, p.lng)}" target="_blank" rel="noopener">Google 地图 ↗</a>`,
  ].filter(Boolean);
  // A function, so the delete button reflects who is signed in when the popup opens.
  m.bindPopup(() => `<div class="pop-body" style="--c:${P.color}">
      <div class="pop-head"><span class="pill">${P.icon} ${esc(P.label)} · 大家添加</span><span>${esc(when || '日期不限')}</span></div>
      <h3>${esc(p.name)}</h3>
      ${p.price ? `<p><b style="font-size:16px">${esc(p.price)}</b></p>` : ''}
      ${p.note ? `<p>${esc(p.note)}</p>` : ''}
      <div class="links">${links.join('')}</div>
      <div class="fine">由 ${esc(by)} 添加</div>
      ${state.canEdit ? `<div class="pop-actions"><button class="danger" data-del="${esc(p.id)}">删除这个地点</button></div>` : ''}
    </div>`, popupOpts());
  m.on('click', () => onMarkerClick('place:' + p.id));
  m._place = p;
  return m;
}

function renderPlaces() {
  placeLayer.clearLayers();
  Object.keys(markerByKey).filter(k => k.startsWith('place:')).forEach(k => delete markerByKey[k]);
  placeMarkers = state.places.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng)).map(p => {
    const m = placeMarker(p).addTo(placeLayer);
    markerByKey['place:' + p.id] = m;
    return m;
  });
  refreshMarks();
  declutter();
}

// ---------- marker state classes: picked / in final route / replaced / dimmed ----------
function refreshMarks() {
  const f = state.fin;
  const picked = new Set(f ? [f.nights[f.day] && f.nights[f.day].key, ...(f.stops[f.day] || []).map(s => s.key)].filter(Boolean) : []);
  const sel = showingFinal() ? state.final.selection : null;
  const inFinal = new Set(sel ? [
    ...Object.values(sel.nights || {}).filter(Boolean).map(s => s.key),
    ...Object.values(sel.stops || {}).flat().map(s => s.key),
  ] : []);
  // Original stay pins that no night uses any more once the final route picked real Airbnbs.
  const replaced = new Set();
  if (sel) {
    const used = new Set(T.days.filter(d => d.id < LAST_DAY && !(sel.nights || {})[d.id]).map(d => 'ev:' + defaultNight(T, d.id)));
    T.events.filter(e => e.type === 'stay' && !used.has('ev:' + e.id)).forEach(e => replaced.add('ev:' + e.id));
  }
  for (const [key, m] of Object.entries(markerByKey)) {
    const el = m.getElement();
    if (!el) continue;
    el.classList.toggle('picked', picked.has(key));
    el.classList.toggle('in-final', inFinal.has(key));
    el.classList.toggle('replaced', replaced.has(key));
    const day = key.startsWith('ev:') ? byId[key.slice(3)].day : m._place ? m._place.day || 0 : 0;
    el.classList.toggle('dim', state.activeDay !== 'all' && day !== 0 && day !== state.activeDay);
  }
}

// ---------- zoom tiers + label declutter ----------
let tier = -1;
function applyTier() {
  const z = map.getZoom();
  const t = z < 10 ? 0 : z < 12 ? 1 : z < 14 ? 2 : 3;
  if (t !== tier) {
    mapEl.classList.remove('tier-0', 'tier-1', 'tier-2', 'tier-3');
    mapEl.classList.add('tier-' + t);
    tier = t;
    document.getElementById('hud-tier').textContent = TIERS[t][0];
    document.getElementById('hud-hint').textContent = TIERS[t][1];
  }
  declutter();
}

// Hide labels that would overlap a higher-priority label; the dot stays and hover still works.
function declutter() {
  const ordered = [
    ...Object.values(markerByKey).filter(m => m.getElement() && m.getElement().classList.contains('hl')),
    ...T.events.filter(e => e.imp === 1).map(e => eventMarkers[e.id]),
    ...Object.values(areaMarkers),
    ...T.events.filter(e => e.imp === 2).map(e => eventMarkers[e.id]),
    ...placeMarkers.filter(m => m._place.type !== 'airbnb'),
    ...T.events.filter(e => e.imp === 3).map(e => eventMarkers[e.id]),
    ...bnbMarkers,
    ...placeMarkers.filter(m => m._place.type === 'airbnb'),
  ];
  ordered.forEach(m => m.getElement() && m.getElement().classList.remove('nolabel'));
  const placed = [];
  const seen = new Set();
  const hit = (a, b) => !(a.right + 3 < b.left || b.right + 3 < a.left || a.bottom + 2 < b.top || b.bottom + 2 < a.top);
  ordered.forEach(m => {
    const el = m.getElement();
    if (!el || seen.has(el)) return;
    seen.add(el);
    const lab = el.querySelector('.ev-label, .area, .bnb');
    if (!lab || lab.offsetParent === null) return;
    const r = lab.getBoundingClientRect();
    if (!r.width) return;
    if (!el.classList.contains('hl') && placed.some(p => hit(p, r))) el.classList.add('nolabel');
    else placed.push(r);
    const dot = el.querySelector('.ev-dot');
    if (dot && dot.offsetParent !== null) placed.push(dot.getBoundingClientRect());
  });
}
map.on('zoomend', applyTier);

// ---------- filters ----------
function applyFilters() {
  CATS.forEach(([c]) => mapEl.classList.toggle('hide-' + c, state.hidden.has(c)));
  savePref('trip.hidden', [...state.hidden]);
  savePref('trip.hiddenDays', [...state.hiddenDays]);
  styleRoutes();
  declutter();
}

function renderFilterMenu() {
  document.getElementById('menu-filter').innerHTML = `
    <div class="menu-sec">地点</div>
    ${CATS.map(([c, label]) => `<label><input type="checkbox" data-cat="${c}" ${state.hidden.has(c) ? '' : 'checked'}> ${label}</label>`).join('')}
    <div class="menu-sec">路线</div>
    ${T.days.map(d => `<label><input type="checkbox" data-rday="${d.id}" ${state.hiddenDays.has(d.id) ? '' : 'checked'}>
      <span class="sw" style="--c:${d.color}"></span>D${d.id} 路线 · ${esc(nightDate(d.id))}</label>`).join('')}
    ${state.final ? `<div class="menu-sec">路线版本</div>
      <label><input type="radio" name="ver" value="final" ${showingFinal() ? 'checked' : ''}> ✅ 最终路线</label>
      <label><input type="radio" name="ver" value="base" ${showingFinal() ? '' : 'checked'}> 原计划</label>` : ''}
    <div class="menu-row"><button data-act="show-all">全部显示</button></div>`;
}

document.getElementById('menu-filter').addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.cat) state.hidden[t.checked ? 'delete' : 'add'](t.dataset.cat);
  else if (t.dataset.rday) state.hiddenDays[t.checked ? 'delete' : 'add'](+t.dataset.rday);
  else if (t.name === 'ver') return setVersion(t.value);
  applyFilters();
});
document.getElementById('menu-filter').addEventListener('click', e => {
  if (!e.target.closest('[data-act="show-all"]')) return;
  state.hidden.clear();
  state.hiddenDays.clear();
  applyFilters();
  renderFilterMenu();
});

function setVersion(v) {
  state.version = v;
  drawRoutes();
  playRoutes();
  renderPanel();
  renderFilterMenu();
  refreshMarks();
}

// ---------- day tabs ----------
function setDay(day) {
  state.activeDay = day;
  document.querySelectorAll('#daytabs button').forEach(b => b.classList.toggle('active', b.dataset.day === String(day)));
  document.querySelectorAll('.day').forEach(s => { s.style.display = day === 'all' || s.dataset.day === String(day) ? '' : 'none'; });
  refreshMarks();
  styleRoutes();
  if (day === 'all') { fitAll(); return; }
  const pts = [];
  activeLegs().filter(l => l.day === day && l.mode !== 'flight').forEach(l => pts.push(...l.coords));
  if (state.fin) (state.fin.stops[day] || []).concat(state.fin.nights[day] || []).forEach(s => pts.push([s.lat, s.lng]));
  if (pts.length) map.flyToBounds(L.latLngBounds(pts), { paddingTopLeft: padTL(), paddingBottomRight: padBR(), duration: 0.8, maxZoom: 14 });
}

// ---------- side panel ----------
document.getElementById('meta').textContent = `${T.meta.dates} · ${T.meta.people} · ORD ⇄ DEN`;
const tabs = document.getElementById('daytabs');
tabs.innerHTML = `<button data-day="all" class="active">全部</button>` +
  T.days.map(d => `<button data-day="${d.id}" style="--c:${d.color}"><span class="sw"></span>D${d.id}</button>`).join('');
tabs.addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (b) setDay(b.dataset.day === 'all' ? 'all' : +b.dataset.day);
});

function itineraryHTML() {
  const final = showingFinal();
  const legTo = Object.fromEntries(activeLegs().map(l => [l.day + '|' + l.toKey, l]));
  const banner = final
    ? `<div class="ver-banner">✅ 正在显示<b>最终路线</b>${state.final.updatedByName ? `（${esc(state.final.updatedByName)} 确认）` : ''} · <a href="#" data-act="ver-base">看原计划</a></div>`
    : state.final ? `<div class="ver-banner plain">正在显示原计划 · <a href="#" data-act="ver-final">看最终路线</a></div>` : '';
  return banner + T.days.map(d => {
    const drive = activeLegs().filter(l => l.day === d.id && l.mode === 'drive');
    const mins = drive.reduce((s, l) => s + l.min, 0), km = drive.reduce((s, l) => s + l.km, 0);
    const stops = final
      ? state.final.days.find(x => x.day === d.id).stops.filter(s => !s.start)
      : T.events.filter(e => e.day === d.id).map(e => ({ key: 'ev:' + e.id, name: e.title, type: e.type, time: e.time, lat: e.lat, lng: e.lng }));
    const rows = stops.map(s => {
      const leg = legTo[d.id + '|' + s.key];
      const ev = s.key.startsWith('ev:') ? byId[s.key.slice(3)] : null;
      const time = s.time || (s.night ? '晚上' : '');
      const tag = s.added ? '<span class="tag">新增</span>' : s.night && !ev ? '<span class="tag">最终住宿</span>' : '';
      return `${leg ? `<li class="leg">${fmtLeg(leg)}</li>` : ''}
        <li class="item" data-key="${esc(s.key)}" data-lat="${s.lat}" data-lng="${s.lng}"><span class="t">${esc(time)}</span><span>${ICON[s.type] || '📍'}</span>
        <span class="ti">${esc(s.name)}${tag}<small>${esc(ev ? ev.short : '')}</small></span></li>`;
    }).join('');
    return `<section class="day" data-day="${d.id}" style="--c:${d.color}">
        <h2><span class="dnum">D${d.id}</span>${esc(d.date)}<small>${esc(d.title)}</small></h2>
        <div class="stats">当天开车合计 ${fmtMin(mins)} · ${Math.round(km)} km</div>
        <ol>${rows}</ol></section>`;
  }).join('');
}

function placesHTML() {
  const list = [...state.places].sort((a, b) => ts(a) - ts(b));
  return `<section class="adds"><h2>✚ 大家添加的地点（${list.length}）</h2>
    ${list.length ? list.map(p => {
      const P = PLACE[p.type] || PLACE.sight;
      const when = placeWhen(p);
      return `<div class="place-row" data-key="place:${esc(p.id)}"><span class="ic">${P.icon}</span>
        <span><b>${esc(p.name)}</b><small>${esc(P.label)}${when ? ' · ' + esc(when) : ''}${p.price ? ' · ' + esc(p.price) : ''} · ${esc(p.createdByName || '')}</small></span></div>`;
    }).join('') : `<div class="note">还没有人添加。点右上角「✏️ 编辑行程」可以添加 Airbnb、景点或餐厅。</div>`}
  </section>`;
}

function staysHTML() {
  if (!T.airbnbAreas.length) return '';
  return `<section class="stays"><h2>🏠 Airbnb 房源（${bnbMarkers.length} 套）</h2>
    <div class="note">都是 ${T.meta.airbnbQueried} 按对应日期、8 位成人在 Airbnb 搜到的整套房源。价格为当时显示的总价，会变动。</div>
    ${T.airbnbAreas.map(a => `<div class="area-card" data-area="${a.id}"><div><b>${esc(a.name)}</b><small>${esc(a.forNights)} · ${nightsLabel(a)}</small></div><span class="count">${a.listings.length} 套 →</span></div>`).join('')}
  </section>`;
}

const legendHTML = () => `<section class="legend"><h2>图例</h2>
    <div class="row"><span class="line"></span>开车路线（颜色区分每天）</div>
    <div class="row"><span class="line walk"></span>徒步 / 步行</div>
    <div class="row"><span class="line flight"></span>航班</div>
    <div class="row"><span class="dash-dot"></span>虚线边框 = 大家添加的地点</div>
    <p>缩小只看路线和主要节点；放大到一个区域会显示每站的时间和说明。鼠标悬停预览，点击打开详情和链接。右上角「☰ 显示」可以选择显示哪些内容。</p>
  </section>`;

function finalizeHTML() {
  const f = state.fin, d = f.day, day = dayById[d];
  const row = (s, kind) => `<div class="fin-row"><span>${ICON[s.type] || '📍'} ${esc(s.name)}</span>
    <button class="x" data-act="fin-rm" data-kind="${kind}" data-key="${esc(s.key)}" title="移除">×</button></div>`;
  const count = x => (f.nights[x] ? 1 : 0) + f.stops[x].length;
  const night = d < LAST_DAY
    ? (f.nights[d] ? row(f.nights[d], 'night') : `<div class="empty">还没选。点地图上的 🏠 房源设为这晚的住宿；不选就沿用原计划的位置。</div>`)
    : `<div class="empty">D${d} 当天返程，不需要住宿。</div>`;
  const list = f.stops[d].length ? f.stops[d].map(s => row(s, 'stop')).join('')
    : `<div class="empty">还没有。点地图上的 🍽️ 餐厅或 ⭐ 候选景点加入这一天。</div>`;
  return `<section class="fin">
    <h2>✅ 确定最终路线</h2>
    <p class="hint">先选一天，再在地图上点：<b>🏠 房源</b>设为当晚住宿，<b>🍽️ 餐厅 / ⭐ 候选景点</b>加入当天（再点一次取消）。新加的地点会自动插到当天最顺路的位置。</p>
    <div class="fin-days">${T.days.map(x => `<button data-act="fin-day" data-day="${x.id}" class="${x.id === d ? 'active' : ''}" style="--c:${x.color}">D${x.id}${count(x.id) ? `<span class="n">${count(x.id)}</span>` : ''}</button>`).join('')}</div>
    <h3>D${d} · ${esc(day.date)} · 晚上住哪</h3>${night}
    <h3>D${d} 加入的地点</h3>${list}
    <div class="fin-actions"><button data-act="fin-cancel">取消</button><button class="primary" data-act="fin-save" ${f.busy ? 'disabled' : ''}>生成最终路线</button></div>
    <div class="fin-progress" id="fin-progress">${esc(f.progress || '')}</div>
  </section>`;
}

function renderPanel() {
  it.innerHTML = state.fin ? finalizeHTML() : itineraryHTML() + placesHTML() + staysHTML() + legendHTML();
  if (!state.fin) document.querySelectorAll('.day').forEach(s => {
    s.style.display = state.activeDay === 'all' || s.dataset.day === String(state.activeDay) ? '' : 'none';
  });
}

function renderStatus() {
  const mode = state.db ? state.db.mode : 'readonly';
  const s = mode === 'readonly' ? '🔒 只读：编辑功能还没开启'
    : mode === 'local' ? '🧪 本机测试模式：添加的内容只保存在这台电脑的浏览器里'
      : !state.user ? '👀 只读 · 登录后可以编辑'
        : state.canEdit ? `🟢 ${esc(state.user.name)} · 可以编辑`
          : `🔒 ${esc(state.user.email)} 还没有编辑权限`;
  document.getElementById('status').innerHTML = s;
}

function focusKey(key, lat, lng) {
  const m = markerByKey[key];
  const ll = m ? m.getLatLng() : L.latLng(lat, lng);
  if (isPhone()) panel.classList.add('collapsed');
  flyToVisible(ll, Math.max(map.getZoom(), 14));
  if (m) map.once('moveend', () => m.openPopup());
}

it.addEventListener('click', ev => {
  const act = ev.target.closest('[data-act]');
  if (act) {
    ev.preventDefault();
    const a = act.dataset.act;
    if (a === 'ver-base' || a === 'ver-final') setVersion(a === 'ver-final' ? 'final' : 'base');
    else if (a === 'fin-day') { state.fin.day = +act.dataset.day; renderPanel(); refreshMarks(); setDay(state.fin.day); }
    else if (a === 'fin-rm') {
      const f = state.fin;
      if (act.dataset.kind === 'night') f.nights[f.day] = null;
      else f.stops[f.day] = f.stops[f.day].filter(s => s.key !== act.dataset.key);
      renderPanel(); refreshMarks();
    } else if (a === 'fin-cancel') exitFinalize();
    else if (a === 'fin-save') saveFinal();
    return;
  }
  const item = ev.target.closest('li.item, .place-row');
  if (item) { focusKey(item.dataset.key, +item.dataset.lat, +item.dataset.lng); return; }
  const card = ev.target.closest('.area-card');
  if (card) {
    if (isPhone()) panel.classList.add('collapsed');
    showArea(card.dataset.area);
  }
});

// hovering an itinerary row highlights its marker
const clearHl = () => document.querySelectorAll('.leaflet-marker-icon.hl').forEach(el => el.classList.remove('hl'));
it.addEventListener('mouseover', ev => {
  const item = ev.target.closest('li.item, .place-row');
  clearHl();
  if (!item) return;
  const m = markerByKey[item.dataset.key];
  if (!m || !m.getElement()) return;
  m.getElement().classList.add('hl');
  m.setZIndexOffset(5000);
});
it.addEventListener('mouseleave', () => {
  clearHl();
  T.events.forEach(e => eventMarkers[e.id].setZIndexOffset(2000 - e.imp * 300));
  bnbMarkers.forEach(m => m.setZIndexOffset(0));
  placeMarkers.forEach(m => m.setZIndexOffset(1200));
  declutter();
});

function onMarkerClick(key) {
  if (state.fin) { map.closePopup(); finClick(key); return; }
  document.querySelectorAll('li.item.hl, .place-row.hl').forEach(el => el.classList.remove('hl'));
  const row = it.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!row) return;
  row.classList.add('hl');
  if (row.offsetParent) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// "附近的 Airbnb" and "删除" buttons inside popups
map.on('popupopen', ev => {
  const el = ev.popup.getElement();
  el.querySelectorAll('[data-area]').forEach(b => b.addEventListener('click', () => showArea(b.dataset.area)));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const p = state.places.find(x => x.id === b.dataset.del);
    if (!p || !confirm(`确定删除「${p.name}」吗？所有人都会看不到它。`)) return;
    try { await state.db.deletePlace(p.id); map.closePopup(); toast('已删除'); } catch (e) { toast('删除失败：' + (e.message || e)); }
  }));
});

// ---------- toolbar menus ----------
const closeMenus = () => document.querySelectorAll('.menu').forEach(m => { m.hidden = true; });
document.querySelectorAll('[data-menu]').forEach(btn => btn.addEventListener('click', e => {
  e.stopPropagation();
  const m = document.getElementById(btn.dataset.menu);
  const open = m.hidden;
  closeMenus();
  m.hidden = !open;
}));
document.addEventListener('click', e => { if (!e.target.closest('.tb-item')) closeMenus(); });

function renderEditMenu() {
  const db = state.db;
  let html;
  if (!db || db.mode === 'readonly') html = `<div class="menu-note">编辑功能还没开启：需要先在 <code>firebase-config.js</code> 里填好 Firebase 配置。</div>`;
  else if (!state.user) html = `<div class="menu-note">用 Google 账号登录后才能编辑行程。</div><button data-act="login">使用 Google 登录</button>`;
  else if (!state.canEdit) html = `<div class="menu-note">你登录的账号 <b>${esc(state.user.email)}</b> 还没有编辑权限。请把这个邮箱发给网站管理员，加入编辑名单后刷新页面。</div><button data-act="logout">退出登录</button>`;
  else html = `${['airbnb', 'sight', 'restaurant'].map(t => `<button data-act="add" data-type="${t}">${PLACE[t].icon} ${PLACE[t].add}</button>`).join('')}
    <hr><button data-act="finalize">✅ 确定最终路线</button>
    ${state.final ? `<button data-act="clear-final" class="danger-text">清除最终路线</button>` : ''}
    ${db.mode === 'firebase' ? `<hr><div class="menu-note small">已登录：${esc(state.user.email)}</div><button data-act="logout">退出登录</button>` : ''}`;
  document.getElementById('menu-edit').innerHTML = html;
}

document.getElementById('menu-edit').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  closeMenus();
  const a = b.dataset.act;
  try {
    if (a === 'login') await state.db.signIn();
    else if (a === 'logout') await state.db.signOut();
    else if (a === 'add') openAddForm(b.dataset.type);
    else if (a === 'finalize') enterFinalize();
    else if (a === 'clear-final' && confirm('确定清除最终路线吗？所有人都会回到原计划。')) { await state.db.clearFinal(); toast('已清除最终路线'); }
  } catch (err) {
    if (err && err.code === 'auth/popup-closed-by-user') return;
    toast('出错了：' + (err && err.message || err));
  }
});

const playBtn = document.getElementById('btn-play');
playBtn.addEventListener('click', () => (playBtn.classList.contains('playing') ? stopAnimation() : playRoutes()));
document.getElementById('reset').addEventListener('click', () => setDay('all'));
document.getElementById('panel-toggle').addEventListener('click', () => panel.classList.toggle('collapsed'));

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ---------- add-a-place form ----------
const modal = document.getElementById('modal');
const pickbar = document.getElementById('pickbar');
let pin = null;
const pinIcon = L.divIcon({ className: 'pin-marker', iconSize: null, iconAnchor: [0, 0], html: '<div class="pin">📌</div>' });

function closeModal() {
  modal.hidden = true;
  modal.innerHTML = '';
  if (pin) { pin.remove(); pin = null; }
}

// "39.75, -105.22", or a Google Maps link containing @lat,lng or !3dlat!4dlng
function parseCoords(q) {
  const m = q.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || q.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || q.match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
}

async function geocode(q) {
  const c = parseCoords(q);
  if (c) return [{ name: `坐标 ${c.lat}, ${c.lng}`, ...c }];
  // Nominatim (OpenStreetMap) asks for at most one request per second: we only search on demand.
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=us&accept-language=en` +
    `&viewbox=-106.3,40.9,-104.3,39.2&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`地址搜索返回 ${res.status}`);
  return (await res.json()).map(x => ({ name: x.display_name, lat: +x.lat, lng: +x.lon }));
}

function openAddForm(type) {
  const P = PLACE[type];
  const dayOpts = type === 'airbnb'
    ? `<option value="0">不限</option>` + T.days.filter(d => d.id < LAST_DAY).map(d => `<option value="${d.id}">第 ${d.id} 晚 · ${nightDate(d.id)}</option>`).join('')
    : `<option value="0">不限 / 还没定</option>` + T.days.map(d => `<option value="${d.id}">D${d.id} · ${esc(d.date)}</option>`).join('');
  modal.innerHTML = `<form class="modal-card" id="add-form" novalidate>
    <h2>${P.icon} ${P.add}</h2>
    <label>名称 *<input name="name" maxlength="120" placeholder="${type === 'airbnb' ? '房源标题' : type === 'restaurant' ? '餐厅名' : '景点名'}"></label>
    <label>链接<input name="url" maxlength="500" placeholder="${type === 'airbnb' ? 'https://www.airbnb.com/rooms/…' : '官网、Google 地图或点评链接'}"></label>
    ${type === 'airbnb' ? `<label>价格<input name="price" maxlength="40" placeholder="例：$900 / 2 晚"></label>` : ''}
    <label>${type === 'airbnb' ? '想住哪一晚' : '哪一天去'}<select name="day">${dayOpts}</select></label>
    <label>备注<textarea name="note" maxlength="500" rows="2" placeholder="${type === 'restaurant' ? '推荐菜、要不要订位…' : '为什么推荐、注意事项…'}"></textarea></label>
    <fieldset><legend>位置 *</legend>
      <div class="search"><input name="q" placeholder="搜索地址、粘贴坐标或 Google 地图链接"><button type="button" data-act="search">搜索</button></div>
      <div class="results" id="geo-results"></div>
      <button type="button" class="link" data-act="pick">或者在地图上点一下选位置 →</button>
      <div class="loc" id="loc-status">还没选位置</div>
    </fieldset>
    <div class="err" id="form-err"></div>
    <div class="form-actions"><button type="button" data-act="cancel">取消</button><button type="submit" class="primary">保存</button></div>
  </form>`;
  modal.hidden = false;
  const form = document.getElementById('add-form');
  const err = msg => { document.getElementById('form-err').textContent = msg; };
  let loc = null;
  let results = [];
  form.elements.name.focus();

  const setLoc = (lat, lng, label) => {
    loc = { lat, lng };
    document.getElementById('loc-status').innerHTML = `📌 已选：${esc(label || '地图上的位置')}<br><span class="muted">${lat.toFixed(5)}, ${lng.toFixed(5)}</span>`;
    document.getElementById('geo-results').innerHTML = '';
    if (pin) pin.setLatLng([lat, lng]); else pin = L.marker([lat, lng], { icon: pinIcon, interactive: false, zIndexOffset: 6000 }).addTo(map);
    flyToVisible([lat, lng], Math.max(map.getZoom(), 13));
    err('');
  };

  const search = async () => {
    const q = form.elements.q.value.trim();
    if (!q) return;
    const box = document.getElementById('geo-results');
    box.innerHTML = '<div class="muted">搜索中…</div>';
    try {
      results = await geocode(q);
      if (results.length === 1 && parseCoords(q)) { setLoc(results[0].lat, results[0].lng, results[0].name); return; }
      box.innerHTML = results.length
        ? results.map((r, i) => `<button type="button" data-res="${i}">${esc(r.name)}</button>`).join('')
        : '<div class="muted">没找到。换个关键词，或者直接在地图上点选。</div>';
    } catch (e) {
      box.innerHTML = `<div class="muted">搜索失败：${esc(e.message)}。可以直接在地图上点选。</div>`;
    }
  };

  form.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.name === 'q') { e.preventDefault(); search(); }
  });
  form.addEventListener('click', e => {
    const res = e.target.closest('[data-res]');
    if (res) { const r = results[+res.dataset.res]; setLoc(r.lat, r.lng, r.name.split(',')[0]); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'search') search();
    else if (b.dataset.act === 'cancel') closeModal();
    else if (b.dataset.act === 'pick') startPick(ll => setLoc(ll.lat, ll.lng));
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(form);
    const name = f.get('name').trim(), url = f.get('url').trim();
    if (!name) return err('请填写名称');
    if (url && !safeUrl(url)) return err('链接需要以 http:// 或 https:// 开头');
    if (!loc) return err('请先选位置：搜索地址，或者在地图上点一下');
    if (loc.lat < 36.9 || loc.lat > 41.1 || loc.lng < -109.1 || loc.lng > -102) return err('位置需要在科罗拉多州范围内');
    const data = { type, name, url, note: f.get('note').trim(), day: +f.get('day'), lat: +loc.lat.toFixed(6), lng: +loc.lng.toFixed(6) };
    if (type === 'airbnb') data.price = f.get('price').trim();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await state.db.addPlace(data);
      closeModal();
      toast(`已添加「${name}」`);
    } catch (e2) {
      btn.disabled = false;
      btn.textContent = '保存';
      err('保存失败：' + (e2.code === 'permission-denied' ? '没有编辑权限' : e2.message || e2));
    }
  });
}

function startPick(onPick) {
  modal.hidden = true;
  pickbar.hidden = false;
  mapEl.classList.add('picking');
  const done = ll => {
    map.off('click', onMap);
    document.removeEventListener('keydown', onKey);
    mapEl.classList.remove('picking');
    pickbar.hidden = true;
    modal.hidden = false;
    if (ll) onPick(ll);
  };
  const onMap = e => done(e.latlng);
  const onKey = e => { if (e.key === 'Escape') done(null); };
  map.on('click', onMap);
  document.addEventListener('keydown', onKey);
  pickbar.querySelector('button').onclick = () => done(null);
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeMenus();
  if (!modal.hidden && pickbar.hidden) closeModal();
});

// ---------- choosing the final route ----------
function enterFinalize() {
  const sel = state.final && state.final.selection;
  const nights = {}, stops = {};
  T.days.forEach(d => {
    stops[d.id] = [...((sel && sel.stops && sel.stops[d.id]) || [])];
    if (d.id < LAST_DAY) nights[d.id] = (sel && sel.nights && sel.nights[d.id]) || null;
  });
  state.fin = { day: 1, nights, stops, busy: false, progress: '' };
  // Everything you can pick has to be visible.
  ['airbnb', 'food', 'cand'].forEach(c => state.hidden.delete(c));
  applyFilters();
  renderFilterMenu();
  map.closePopup();
  mapEl.classList.add('finalizing');
  panel.classList.add('finalizing');
  if (isPhone()) panel.classList.remove('collapsed');
  renderPanel();
  setDay(1);
}

function exitFinalize() {
  state.fin = null;
  mapEl.classList.remove('finalizing');
  panel.classList.remove('finalizing');
  renderPanel();
  setDay('all');
}

function finClick(key) {
  const s = stopFor(key);
  const f = state.fin;
  if (!s || f.busy) return;
  const d = f.day;
  if (s.type === 'airbnb') {
    if (d === LAST_DAY) { toast(`D${d} 当天返程，不需要住宿`); return; }
    const same = f.nights[d] && f.nights[d].key === key;
    f.nights[d] = same ? null : s;
    if (!same && d < LAST_DAY - 1 && !f.nights[d + 1] && defaultNight(T, d) === defaultNight(T, d + 1)) {
      f.nights[d + 1] = s; // the original plan stays two nights here — keep that unless changed
      toast(`已设为第 ${d} 晚住宿；第 ${d + 1} 晚原计划也住同一处，先一起设好，可以在 D${d + 1} 改`);
    } else toast(same ? `已取消 D${d} 的住宿` : `已设为 D${d}（${nightDate(d)}）晚上的住宿`);
  } else if (key.startsWith('place:')) {
    const i = f.stops[d].findIndex(x => x.key === key);
    if (i >= 0) f.stops[d].splice(i, 1); else f.stops[d].push(s);
    toast(i >= 0 ? `已从 D${d} 移除「${s.name}」` : `已加入 D${d}：「${s.name}」`);
  } else {
    toast('这是原计划里的站点，会自动保留');
    return;
  }
  renderPanel();
  refreshMarks();
}

async function saveFinal() {
  const f = state.fin;
  if (f.busy) return;
  f.busy = true;
  f.progress = '正在计算路线…';
  renderPanel();
  try {
    const days = buildDays(T, f);
    const legs = await computeLegs(days, T, (i, n) => {
      f.progress = `正在计算新路段 ${i}/${n}…`;
      const el = document.getElementById('fin-progress');
      if (el) el.textContent = f.progress;
    });
    // JSON round-trip drops undefined values, which Firestore rejects.
    const plan = JSON.parse(JSON.stringify({ version: 1, selection: { nights: f.nights, stops: f.stops }, days, legs }));
    state.justSaved = true;
    await state.db.saveFinal(plan);
    exitFinalize();
    toast('最终路线已生成，所有人都能看到');
  } catch (e) {
    state.justSaved = false;
    f.busy = false;
    f.progress = '失败：' + (e.code === 'permission-denied' ? '没有编辑权限' : e.message || e);
    renderPanel();
  }
}

// ---------- shared data ----------
let finalSig = null, firstFinal = true, played = false;

function onFinal(plan) {
  const sig = plan ? JSON.stringify(plan.selection) + '#' + plan.legs.length : null;
  const changed = sig !== finalSig;
  const wasFinal = showingFinal();
  finalSig = sig;
  state.final = plan;
  if (changed) state.finalLegs = plan ? plan.legs.map(l => ({ ...l, coords: decodePolyline(l.poly) })) : null;
  if (!plan) state.version = 'base';
  else if (firstFinal || state.justSaved) state.version = 'final';
  const redraw = firstFinal ? showingFinal() || !played : changed && (wasFinal || showingFinal());
  if (redraw) { drawRoutes(); playRoutes(); played = true; }
  if (changed) state.justSaved = false;
  firstFinal = false;
  if (!state.fin) renderPanel();
  renderFilterMenu();
  renderEditMenu();
  refreshMarks();
}

function onPlaces(list) {
  state.places = list;
  renderPlaces();
  if (!state.fin) renderPanel();
}

function onAuth(s) {
  state.user = s.user;
  state.canEdit = s.canEdit;
  renderStatus();
  renderEditMenu();
}

// ---------- start ----------
drawRoutes();
applyTier();
applyFilters();
renderFilterMenu();
renderPanel();
renderEditMenu();
renderStatus();
setTimeout(() => { if (!played) { played = true; playRoutes(); } }, 2500);

const LOCAL_DEV = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || location.hostname.endsWith('.localhost');
const mode = firebaseConfig && firebaseConfig.apiKey ? 'firebase' : LOCAL_DEV ? 'local' : 'readonly';
try {
  state.db = await createDB(mode, firebaseConfig);
} catch (e) {
  console.error(e);
  state.db = await createDB('readonly');
  toast('连接 Firebase 失败，暂时只能查看');
}
state.db.onAuth(onAuth);
state.db.onPlaces(onPlaces, e => { console.error(e); toast('读取大家添加的地点失败：' + (e.code || e.message)); });
state.db.onFinal(onFinal, e => { console.error(e); if (!played) { played = true; playRoutes(); } });
renderStatus();
renderEditMenu();
