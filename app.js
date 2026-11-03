(() => {
  const T = window.TRIP;
  const byId = Object.fromEntries(T.events.map(e => [e.id, e]));
  const dayById = Object.fromEntries(T.days.map(d => [d.id, d]));
  const areaById = Object.fromEntries(T.airbnbAreas.map(a => [a.id, a]));
  const legTo = Object.fromEntries(T.legs.map(l => [l.to + '@' + l.day, l]));

  const ICON = { flight: '✈️', car: '🚙', stay: '🛏️', sight: '📍', park: '🏔️', hike: '🥾', food: '🍽️', event: '🎄', amphi: '🎸' };
  const MODE = { drive: '🚗', walk: '🚶', flight: '✈️' };
  const TIERS = [
    ['概览', '只显示路线和主要节点 · 放大看更多'],
    ['区域', '显示各站名称和 Airbnb 区域 · 继续放大看房源'],
    ['详情', '显示时间和每套房源价格 · 悬停预览，点击看链接'],
    ['完整', '显示每站说明和房源名称、评分'],
  ];

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMin = m => m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
  const fmtLeg = l => l.mode === 'flight' ? '✈️ 约 2 小时 40 分' : `${MODE[l.mode]} ${fmtMin(l.min)} · ${l.km} km`;
  const gmaps = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  const padTL = () => isPhone() ? [20, 20] : [380, 20];
  const padBR = () => isPhone() ? [20, Math.round(window.innerHeight * 0.46) + 20] : [20, 20];

  // ---------- map & base layers ----------
  const map = L.map('map', { zoomControl: false, minZoom: 4, maxZoom: 18, zoomSnap: 0.5 });
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
      if (!map.getContainer().clientWidth) return;
      ro.disconnect();
      map.invalidateSize();
      fitAll();
    });
    ro.observe(map.getContainer());
  }

  // ---------- routes ----------
  const routeLayers = []; // {day, lines: [casing, line]}
  T.legs.forEach(l => {
    const color = dayById[l.day].color;
    const lines = [];
    if (l.mode === 'drive') {
      lines.push(L.polyline(l.coords, { color: '#fff', weight: 8, opacity: .9, interactive: false }));
      lines.push(L.polyline(l.coords, { color, weight: 4.5, opacity: .95 }));
    } else if (l.mode === 'walk') {
      lines.push(L.polyline(l.coords, { color, weight: 3.5, opacity: .95, dashArray: '2 7', lineCap: 'round' }));
    } else {
      lines.push(L.polyline(l.coords, { color, weight: 2.5, opacity: .8, dashArray: '8 8' }));
    }
    const top = lines[lines.length - 1];
    top.bindTooltip(
      `<b>D${l.day} · ${esc(byId[l.from].title)} → ${esc(byId[l.to].title)}</b><br>${fmtLeg(l)}`,
      { sticky: true, className: 'tip' });
    top.on('mouseover', () => top.setStyle({ weight: l.mode === 'drive' ? 7 : 5 }));
    top.on('mouseout', () => top.setStyle({ weight: l.mode === 'drive' ? 4.5 : l.mode === 'walk' ? 3.5 : 2.5 }));
    lines.forEach(x => x.addTo(map));
    routeLayers.push({ day: l.day, mode: l.mode, lines });
  });

  // ---------- region labels (overview only) ----------
  T.regions.forEach(r => {
    L.marker([r.lat, r.lng], {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'region-marker', iconSize: null, iconAnchor: [0, 0], html: `<div class="region side-${r.side || 'top'}"><b>${esc(r.name)}</b><span>${esc(r.days)}</span></div>` }),
    }).addTo(map);
  });

  // ---------- event markers ----------
  const nearbyButtons = ids => ids.length ? `<div class="nearby"><div class="nearby-h">附近的 Airbnb</div>${ids.map(id =>
    `<button data-area="${id}">🏠 ${esc(areaById[id].name)} · ${areaById[id].listings.length} 套</button>`).join('')}</div>` : '';

  const eventMarkers = {};
  T.events.forEach(e => {
    const d = dayById[e.day];
    const html = `<div class="ev" style="--c:${d.color}">
        <div class="ev-dot"><span>${ICON[e.type]}</span><span class="ev-day">D${e.day}</span></div>
        <div class="ev-label"><div class="ev-l1"><span class="ev-time">${esc(e.time)}</span><span class="ev-title">${esc(e.title)}</span></div>
        <div class="ev-short">${esc(e.short)}</div></div></div>`;
    const m = L.marker([e.lat, e.lng], {
      icon: L.divIcon({ className: `ev-marker imp-${e.imp} day-${e.day}`, html, iconSize: null, iconAnchor: [0, 0] }),
      zIndexOffset: 2000 - e.imp * 300,
      riseOnHover: true,
    });
    const leg = legTo[e.id + '@' + e.day];
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
      </div>`, { className: 'pop', maxWidth: 320, autoPanPaddingTopLeft: padTL(), autoPanPaddingBottomRight: padBR() });
    m.addTo(map);
    eventMarkers[e.id] = m;
  });

  // ---------- Airbnb ----------
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
    a.searchUrl = searchUrl;

    const am = L.marker(center, {
      icon: L.divIcon({ className: 'area-marker', iconSize: null, iconAnchor: [0, 0], html: `<div class="area">🏠<b>${a.listings.length}</b><span class="nm">${esc(a.name)}</span></div>` }),
      zIndexOffset: 500,
    });
    am.bindTooltip(`<b>🏠 ${esc(a.name)}</b><br>${esc(a.forNights)}<br><span class="muted">${a.listings.length} 套适合 8 人的房源 · ${nightsLabel(a)}</span><div class="hint">点击放大查看每一套</div>`,
      { direction: 'top', offset: [0, -14], className: 'tip' });
    am.on('click', () => showArea(a.id));
    am.addTo(map);
    areaMarkers[a.id] = am;

    a.listings.forEach(([id, kind, name, lat, lng, price, rating, rooms, pic]) => {
      const img = pic ? `${pic}?im_w=480` : '';
      const ratingTxt = rating && rating !== 'New' ? `★ ${rating}` : '新房源';
      const roomUrl = `https://www.airbnb.com/rooms/${id}?adults=8&check_in=${a.checkin}&check_out=${a.checkout}`;
      const m = L.marker([lat, lng], {
        icon: L.divIcon({
          className: `bnb-marker area-${a.id}`, iconSize: null, iconAnchor: [0, 0],
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
        </div>`, { className: 'pop', maxWidth: 320, autoPanPaddingTopLeft: padTL(), autoPanPaddingBottomRight: padBR() });
      m.addTo(map);
      m._area = a.id;
      bnbMarkers.push(m);
    });
  });

  // Centre a point in the part of the map the side panel doesn't cover.
  function flyToVisible(latlng, zoom) {
    const [l, t] = padTL(), [r, b] = padBR();
    const target = map.unproject(map.project(latlng, zoom).subtract(L.point((l - r) / 2, (t - b) / 2)), zoom);
    map.flyTo(target, zoom, { duration: 0.8 });
  }

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

  // ---------- zoom tiers + label declutter ----------
  const mapEl = map.getContainer();
  let tier = -1;
  function applyTier() {
    const t = map.getZoom() < 10 ? 0 : map.getZoom() < 12 ? 1 : map.getZoom() < 14 ? 2 : 3;
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
      ...Object.values(eventMarkers).filter(m => m.getElement() && m.getElement().classList.contains('hl')),
      ...T.events.filter(e => e.imp === 1).map(e => eventMarkers[e.id]),
      ...Object.values(areaMarkers),
      ...T.events.filter(e => e.imp === 2).map(e => eventMarkers[e.id]),
      ...T.events.filter(e => e.imp === 3).map(e => eventMarkers[e.id]),
      ...bnbMarkers,
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
  applyTier();

  // ---------- day filter ----------
  let activeDay = 'all';
  function setDay(day) {
    activeDay = day;
    document.querySelectorAll('#daytabs button').forEach(b => b.classList.toggle('active', b.dataset.day === String(day)));
    document.querySelectorAll('.day').forEach(s => { s.style.display = day === 'all' || s.dataset.day === String(day) ? '' : 'none'; });
    T.events.forEach(e => {
      const el = eventMarkers[e.id].getElement();
      if (el) el.classList.toggle('dim', day !== 'all' && e.day !== day);
    });
    routeLayers.forEach(r => {
      const on = day === 'all' || r.day === day;
      r.lines.forEach((ln, i) => ln.setStyle({ opacity: on ? (r.mode === 'drive' && i === 0 ? .9 : .95) : .15 }));
      if (on) r.lines.forEach(ln => ln.bringToFront());
    });
    if (day === 'all') { fitAll(); return; }
    const pts = T.events.filter(e => e.day === day && e.id !== 'ord-depart').map(e => [e.lat, e.lng]);
    T.legs.filter(l => l.day === day && l.mode !== 'flight').forEach(l => pts.push(...l.coords));
    map.flyToBounds(L.latLngBounds(pts), { paddingTopLeft: padTL(), paddingBottomRight: padBR(), duration: 0.8, maxZoom: 14 });
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

  const it = document.getElementById('itinerary');
  it.innerHTML = T.days.map(d => {
    const legs = T.legs.filter(l => l.day === d.id && l.mode === 'drive');
    const mins = legs.reduce((s, l) => s + l.min, 0), km = legs.reduce((s, l) => s + l.km, 0);
    const rows = T.events.filter(e => e.day === d.id).map(e => {
      const leg = legTo[e.id + '@' + e.day];
      return `${leg ? `<li class="leg">${fmtLeg(leg)}</li>` : ''}
        <li class="item" data-id="${e.id}"><span class="t">${esc(e.time)}</span><span>${ICON[e.type]}</span>
        <span class="ti">${esc(e.title)}<small>${esc(e.short)}</small></span></li>`;
    }).join('');
    return `<section class="day" data-day="${d.id}" style="--c:${d.color}">
        <h2><span class="dnum">D${d.id}</span>${esc(d.date)}<small>${esc(d.title)}</small></h2>
        <div class="stats">当天开车合计 ${fmtMin(mins)} · ${Math.round(km)} km</div>
        <ol>${rows}</ol></section>`;
  }).join('') +
    `<section class="stays"><h2>🏠 Airbnb 房源（${bnbMarkers.length} 套）</h2>
      <div class="note">都是 ${T.meta.airbnbQueried} 按对应日期、8 位成人在 Airbnb 搜到的整套房源。价格为当时显示的总价，会变动。</div>
      ${T.airbnbAreas.map(a => `<div class="area-card" data-area="${a.id}"><div><b>${esc(a.name)}</b><small>${esc(a.forNights)} · ${nightsLabel(a)}</small></div><span class="count">${a.listings.length} 套 →</span></div>`).join('')}
    </section>
    <section class="legend"><h2>图例</h2>
      <div class="row"><span class="line"></span>开车路线（颜色区分每天）</div>
      <div class="row"><span class="line walk"></span>徒步 / 步行</div>
      <div class="row"><span class="line flight"></span>航班</div>
      <p>缩小只看路线和主要节点；放大到一个区域会显示每站的时间、说明和附近每套 Airbnb 的价格。鼠标悬停预览，点击打开详情和链接。</p>
    </section>`;

  it.addEventListener('click', ev => {
    const item = ev.target.closest('li.item');
    if (item) {
      const e = byId[item.dataset.id];
      const m = eventMarkers[e.id];
      if (isPhone()) document.getElementById('panel').classList.add('collapsed');
      flyToVisible([e.lat, e.lng], Math.max(map.getZoom(), 14));
      map.once('moveend', () => m.openPopup());
      return;
    }
    const card = ev.target.closest('.area-card');
    if (card) {
      if (isPhone()) document.getElementById('panel').classList.add('collapsed');
      showArea(card.dataset.area);
    }
  });

  // hovering an itinerary row highlights its marker
  it.addEventListener('mouseover', ev => {
    const item = ev.target.closest('li.item');
    document.querySelectorAll('.ev-marker.hl').forEach(el => el.classList.remove('hl'));
    if (!item) return;
    const m = eventMarkers[item.dataset.id];
    m.getElement() && m.getElement().classList.add('hl');
    m.setZIndexOffset(5000);
  });
  it.addEventListener('mouseleave', () => {
    document.querySelectorAll('.ev-marker.hl').forEach(el => el.classList.remove('hl'));
    T.events.forEach(e => eventMarkers[e.id].setZIndexOffset(2000 - e.imp * 300));
    declutter();
  });

  // clicking a map marker highlights its row in the panel
  T.events.forEach(e => eventMarkers[e.id].on('click', () => {
    document.querySelectorAll('li.item.hl').forEach(el => el.classList.remove('hl'));
    const row = it.querySelector(`li.item[data-id="${e.id}"]`);
    if (!row) return;
    row.classList.add('hl');
    if (row.offsetParent) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }));

  // "附近的 Airbnb" buttons inside event popups
  map.on('popupopen', ev => {
    ev.popup.getElement().querySelectorAll('[data-area]').forEach(b => b.addEventListener('click', () => showArea(b.dataset.area)));
  });

  document.getElementById('reset').addEventListener('click', () => setDay('all'));
  document.getElementById('panel-toggle').addEventListener('click', () => document.getElementById('panel').classList.toggle('collapsed'));
})();
