'use strict';
/* Phone sites map (v14.0). Search or tap a pin -> card -> Navigate (Apple Maps / Google Maps / Waze) or use the site for this job.
   Data: the visits calendar (n8n action 'calendar'), active site/client rows with register Lat / Lng. Cached on the phone for no-signal use.
   Map: MapLibre (open source, app/vendor/maplibre) + Mapbox raster tiles. To change provider, change PM_TILE_URL only.
   Uses app.js globals: $, store, settings, toast, log, esc, state, allSites, setClient, siteLabel, syncCombos, validate, showSiteVisits.
   Tech debt: the map setup and pin grouping are duplicated from visits.js - fold both into one shared file when either changes again. */
(function () {
  const KEY_TOKEN = 'pi.mapboxToken';           // raw string (shared with visits.html in the same browser)
  const KEY_DATA = 'pi.mapData';                // last calendar rows for the map (offline)
  const PM_TILE_URL = (t) => 'https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=' + encodeURIComponent(t);
  const COLOR = { done: '#16a34a', due: '#f59e0b', missed: '#dc2626', upcoming: '#71717a', norec: '#ffffff', none: '#ffffff' };
  const RANK = { none: 0, norec: 1, done: 2, upcoming: 3, due: 4, missed: 5 };
  const RANK_STATUS = ['none', 'norec', 'done', 'upcoming', 'due', 'missed'];
  const V = () => self.VISITS;

  let pmap = null, ready = null, data = null, me = null, markers = {}, loading = false;

  const token = () => { try { const v = localStorage.getItem(KEY_TOKEN) || ''; return v.startsWith('"') ? JSON.parse(v) : v; } catch { return ''; } };
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const km = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const dist = (s) => me && s.lat ? km(me, s) : null;
  const fmtKm = (d) => d == null ? '' : d < 1 ? Math.round(d * 1000) + ' m' : d.toFixed(d < 10 ? 1 : 0) + ' km';

  function loadLib() {
    if (self.maplibregl) return Promise.resolve();
    return new Promise((ok, bad) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/maplibre/maplibre-gl.css'; document.head.appendChild(css);
      const js = document.createElement('script'); js.src = 'vendor/maplibre/maplibre-gl.js'; js.onload = ok; js.onerror = () => bad(new Error('Map library did not load')); document.head.appendChild(js);
    });
  }

  async function loadData() {
    if (!data) { const c = store.get(KEY_DATA, null); if (c && c.sites) data = c; }
    if (navigator.onLine === false || loading) return;
    loading = true;
    try {
      const s = settings();
      const body = await V().fetchCalendar(s.url, s.key, {});
      data = { meta: body.meta, at: Date.now(), sites: (body.sites || []).filter(x => x.lat && x.lng && x.active !== false)
        .map(x => ({ id: x.id, loc: x.loc, name: x.name, address: x.address, suburb: x.suburb, client: x.client, lat: x.lat, lng: x.lng,
          annual: x.annual, pattern: x.pattern, visits: (x.visits || []).map(v => ({ m: v.m })) })) };
      store.set(KEY_DATA, data);
      log('map', 'data', { sites: data.sites.length });
    } catch (e) { log('map', 'data failed', e.message); if (!data) toast('Map data not loaded: ' + e.message, 4000); }
    finally { loading = false; }
  }

  function ensureMap() {
    if (ready) return ready;
    const tok = token();
    if (!/^pk\./.test(tok)) { $('pmapKey').hidden = false; return Promise.reject(new Error('no key')); }
    $('pmapKey').hidden = true;
    ready = loadLib().then(() => new Promise(ok => {
      pmap = new maplibregl.Map({
        container: 'pmap', center: [145.0, -37.83], zoom: 9, attributionControl: false,
        style: { version: 8, sources: { base: { type: 'raster', tiles: [PM_TILE_URL(tok)], tileSize: 512,
          attribution: '© <a href="https://www.mapbox.com/about/maps/" target="_blank">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' } },
          layers: [{ id: 'base', type: 'raster', source: 'base' }] }
      });
      pmap.addControl(new maplibregl.AttributionControl({ compact: true }));
      const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false, showUserLocation: true, fitBoundsOptions: { maxZoom: 11.5 } });
      pmap.addControl(geo, 'top-right');
      geo.on('geolocate', p => { me = { lat: p.coords.latitude, lng: p.coords.longitude }; });
      pmap.on('error', e => log('map', 'error', e && e.error && e.error.message));
      pmap.on('load', () => {
        pmap.addSource('sites', { type: 'geojson', data: { type: 'FeatureCollection', features: [] },
          cluster: true, clusterRadius: 55, clusterMaxZoom: 14,
          clusterProperties: { rank: ['max', ['get', 'rank']], rows: ['+', ['get', 'n']] } });
        pmap.addLayer({ id: 'sites', type: 'circle', source: 'sites', filter: ['!', ['has', 'point_count']], paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 7, 14, 12], 'circle-color': ['get', 'color'],
          'circle-stroke-color': ['get', 'stroke'], 'circle-stroke-width': 2 } });
        pmap.on('click', 'sites', e => { showCard(String(e.features[0].properties.ids).split('|')); pmap.easeTo({ center: e.features[0].geometry.coordinates, padding: { bottom: Math.round(innerHeight * 0.45) } }); });
        pmap.on('click', e => { if (!pmap.queryRenderedFeatures(e.point, { layers: ['sites'] }).length) $('mapCard').hidden = true; });
        pmap.on('render', updateMarkers);
        geo.trigger(); // ask for location once: zooms to where you are
        ok();
      });
    }));
    ready.catch(e => { log('map', 'failed', e.message); ready = null; });
    return ready;
  }

  function drawPins() {
    if (!pmap || !data || !pmap.getSource('sites')) return;
    const meta = data.meta, m = meta.now >= 0 && meta.now <= 11 ? meta.now : 0, at = new Map();
    for (const s of data.sites) {
      const k = s.lat.toFixed(5) + ',' + s.lng.toFixed(5), x = V().statusOf(s, m, meta);
      const g = at.get(k) || { lat: s.lat, lng: s.lng, ids: [], st: 'none' };
      g.ids.push(s.id); if (RANK[x] > RANK[g.st]) g.st = x; at.set(k, g);
    }
    pmap.getSource('sites').setData({ type: 'FeatureCollection', features: [...at.values()].map(g => ({ type: 'Feature',
      geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
      properties: { ids: g.ids.join('|'), color: COLOR[g.st], stroke: g.st === 'none' || g.st === 'norec' ? '#71717a' : '#fff', rank: RANK[g.st], n: g.ids.length } })) });
    log('map', 'pins', { pins: at.size, rows: data.sites.length });
  }

  // numbered group circles (HTML markers: no map fonts needed)
  function updateMarkers() {
    if (!pmap || !pmap.getSource('sites') || !pmap.isSourceLoaded('sites')) return;
    const keep = {};
    for (const f of pmap.querySourceFeatures('sites')) {
      const p = f.properties; if (!p.cluster || keep[p.cluster_id]) continue;
      const id = p.cluster_id, n = p.rows || p.point_count, stName = RANK_STATUS[p.rank] || 'none';
      let mk = markers[id];
      if (!mk) {
        const el = document.createElement('div'); el.className = 'mclus';
        el.addEventListener('click', async ev => { ev.stopPropagation();
          try { const z = await pmap.getSource('sites').getClusterExpansionZoom(id); pmap.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z + 0.3, 17) }); }
          catch { pmap.easeTo({ center: f.geometry.coordinates, zoom: pmap.getZoom() + 2 }); } });
        mk = new maplibregl.Marker({ element: el }).setLngLat(f.geometry.coordinates).addTo(pmap);
      }
      const el = mk.getElement(), sz = n < 10 ? 30 : n < 50 ? 36 : 44;
      el.textContent = n;
      Object.assign(el.style, { width: sz + 'px', height: sz + 'px', background: COLOR[stName], color: stName === 'none' || stName === 'norec' ? '#3f3f46' : '#fff', zIndex: String(n) });
      keep[id] = mk;
    }
    for (const id in markers) if (!keep[id]) markers[id].remove();
    markers = keep;
  }

  // Bottom card: every client row at that spot, with this month's visit, then Navigate / Use for this job.
  function showCard(ids) {
    const meta = data.meta, m = meta.now >= 0 && meta.now <= 11 ? meta.now : 0;
    const rows = ids.map(id => data.sites.find(s => s.id === id)).filter(Boolean);
    if (!rows.length) return;
    const s0 = rows[0], d = dist(s0);
    $('mapCard').innerHTML = `<button class="x" data-mc-close aria-label="Close">✕</button>`
      + `<div class="mc-name">${esc(s0.name)}</div><div class="sub">${esc([s0.address, s0.suburb].filter(Boolean).join(', '))}${d != null ? ' · ' + fmtKm(d) + ' away' : ''} · ${esc(s0.loc)}</div>`
      + rows.map(s => { const t = V().typeOf(s, m), x = V().statusOf(s, m, meta);
        return `<div class="mc-row"><b>${esc(s.client)}</b><div class="sub">${V().MON[m]}: ${t ? V().TYPE[t] : 'no visit'} · ${V().STATUS[x]}</div>
          <button class="secondary" type="button" data-use="${esc(s.id)}" style="margin-top:6px;width:100%">Use for this job</button></div>`; }).join('')
      + `<div class="mc-btns"><button type="button" data-nav="${esc(s0.id)}">🧭 Navigate</button></div><div class="nav" id="mcNav" hidden></div>`;
    $('mapCard').hidden = false; $('mapRes').hidden = true;
    log('map', 'card', { ids });
  }
  function navLinks(s) {
    const ll = s.lat + ',' + s.lng, q = encodeURIComponent([s.address, s.suburb].filter(Boolean).join(', ') || s.name);
    return `<a href="https://maps.apple.com/?daddr=${ll}&dirflg=d&q=${q}" target="_blank" rel="noopener">Apple Maps</a>`
      + `<a href="https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving" target="_blank" rel="noopener">Google Maps</a>`
      + `<a href="https://waze.com/ul?ll=${ll}&navigate=yes" target="_blank" rel="noopener">Waze</a>`;
  }
  // Pick a map row as this job's site (and client), the same as picking it in the site box.
  function useForJob(id) {
    const reg = allSites().find(x => x.id === id);
    const row = data.sites.find(x => x.id === id);
    if (!reg) { toast('That site is not in the loaded client list yet - tap ⟳ Sync, then try again', 4000); return; }
    if (reg.clientId && reg.clientId !== state.contactId) { $('contactSearch').value = reg.clientName; setClient(reg.clientId); }
    $('site').value = siteLabel(reg); state.siteId = reg.id || ''; state.locId = reg.loc || (row && row.loc) || '';
    syncCombos(); validate();
    $('mapSheet').classList.remove('open');
    toast('Job: ' + (reg.clientName || '') + ' · ' + reg.name);
    log('map', 'use for job', { id, client: reg.clientName });
  }

  // Search: name, address, suburb, client, AFS number. Nearest first when we know where you are.
  function search() {
    const w = words($('mapQ').value);
    if (!data) { $('mapRes').hidden = true; return; }
    let list;
    if (!w.length) {
      if (!me) { $('mapRes').hidden = true; return; }
      list = data.sites.slice().sort((a, b) => dist(a) - dist(b)).slice(0, 8);
    } else {
      list = data.sites.filter(s => { const t = words([s.name, s.address, s.suburb, s.client, s.loc].join(' ')).join(' '); return w.every(x => t.includes(x)); });
      list.sort((a, b) => me ? dist(a) - dist(b) : a.name.localeCompare(b.name)); list = list.slice(0, 12);
    }
    $('mapRes').innerHTML = (w.length ? '' : '<div class="mh">Nearest to you</div>')
      + (list.length ? list.map(s => `<div class="mr" data-go="${esc(s.id)}"><div>${esc(s.name)}</div><div class="sub">${esc(s.client)} · ${esc(s.suburb || s.loc)}${me ? ' · ' + fmtKm(dist(s)) : ''}</div></div>`).join('')
        : '<div class="mr"><div class="sub">No site matches</div></div>');
    $('mapRes').hidden = false;
  }

  async function openMap() {
    $('mapSheet').classList.add('open'); $('mapCard').hidden = true; $('mapRes').hidden = true;
    const dataP = loadData();
    try { await ensureMap(); } catch { return; }
    if (data) drawPins();
    await dataP; drawPins(); pmap.resize();
  }

  $('mapBtn').onclick = openMap;
  $('mapClose').onclick = () => $('mapSheet').classList.remove('open');
  $('mapQ').addEventListener('input', search);
  $('mapQ').addEventListener('focus', search);
  $('mapRes').addEventListener('click', e => {
    const r = e.target.closest('[data-go]'); if (!r) return;
    const s = data.sites.find(x => x.id === r.dataset.go); if (!s) return;
    $('mapQ').blur(); $('mapRes').hidden = true;
    pmap.flyTo({ center: [s.lng, s.lat], zoom: 15, padding: { bottom: Math.round(innerHeight * 0.45) } }); // keep the pin above the card
    const same = data.sites.filter(x => x.lat === s.lat && x.lng === s.lng).map(x => x.id);
    showCard(same);
  });
  $('mapCard').addEventListener('click', e => {
    if (e.target.closest('[data-mc-close]')) { $('mapCard').hidden = true; return; }
    const u = e.target.closest('[data-use]'); if (u) { useForJob(u.dataset.use); return; }
    const n = e.target.closest('[data-nav]');
    if (n) { const s = data.sites.find(x => x.id === n.dataset.nav); $('mcNav').innerHTML = navLinks(s); $('mcNav').hidden = false; log('map', 'navigate', { id: s.id }); }
  });
  $('pmapKeySave').onclick = () => {
    const k = $('pmapKeyInput').value.trim();
    if (!/^pk\./.test(k)) { toast('That is not a public key - it should start with pk.', 4000); return; }
    try { localStorage.setItem(KEY_TOKEN, k); } catch {}
    $('pmapKeyInput').value = ''; openMap();
  };
})();
