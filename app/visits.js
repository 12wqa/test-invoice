'use strict';
/* Visits calendar page: every AFS site × Jan–Dec. Data from n8n (action 'calendar'); logic in visits-core.js.
   Works with the admin key (pi.adminKey) or the phone app key (pi.settings.key) saved in this browser. */
const BUILD = self.BUILD_INFO || { version: 'dev' };
const V = self.VISITS;
const $ = (id) => document.getElementById(id);
const log = (where, msg, data) => console.log(`[visits:${where}] ${msg}`, data ?? '');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  raw(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
};
function api() { const s = store.get('pi.settings', null); return ((s && s.url) || BUILD.apiBase || location.origin + '/webhook').replace(/\/$/, ''); }
function key() { return store.raw('pi.adminKey') || (store.get('pi.settings', {}) || {}).key || ''; }
(function keyFromLink() {
  const k = new URLSearchParams(location.hash.slice(1)).get('key');
  if (k) { try { localStorage.setItem('pi.adminKey', k); } catch {} history.replaceState(null, '', location.pathname); }
})();

const st = { year: new Date().getFullYear(), data: null, filter: 'all', q: '', client: '', inactive: false, view: 'grid', mapM: -1 };
// One row per site + client (a site shared by two clients is two rows). Each row has its own Active flag.
$('ver').textContent = BUILD.version;

async function load() {
  if (!key()) { $('keyCard').hidden = false; $('main').hidden = true; return; }
  $('keyCard').hidden = true; $('main').hidden = false;
  $('yLabel').textContent = st.year;
  $('grid').className = 'msg'; $('grid').textContent = 'Loading ' + st.year + '…';
  try {
    st.data = await V.fetchCalendar(api(), key(), { year: st.year, inactive: st.inactive });
    const clients = [...new Set(st.data.sites.map(s => s.client).filter(Boolean))].sort();
    $('client').innerHTML = '<option value="">All clients</option>' + clients.map(c => `<option${c === st.client ? ' selected' : ''}>${V.esc(c)}</option>`).join('');
    render();
  } catch (e) {
    log('load', 'failed', e.message);
    if (/key/i.test(e.message)) { try { localStorage.removeItem('pi.adminKey'); } catch {} $('keyCard').hidden = false; $('main').hidden = true; return; }
    $('grid').textContent = 'Could not load the calendar: ' + e.message;
  }
}

function filtered() {
  const d = st.data, meta = d.meta, now = meta.now;
  const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
  return d.sites.filter(s => {
    if (st.client && s.client !== st.client) return false;
    if (words.length) { const t = [s.name, s.address, s.suburb, s.loc, s.client, s.id].join(' ').toLowerCase(); if (!words.every(w => t.includes(w))) return false; }
    const inYear = now >= 0 && now <= 11;
    switch (st.filter) {
      case 'due': return inYear && V.statusOf(s, now, meta) === 'due';
      case 'yearly': return inYear && V.typeOf(s, now) === 'Y';
      case 'six': return inYear && V.typeOf(s, now) === '6';
      case 'missed': return V.MON.some((_, m) => V.statusOf(s, m, meta) === 'missed');
      case 'noannual': return s.annual < 0;
      default: return true;
    }
  });
}

function render() {
  const d = st.data, meta = d.meta;
  const rows = filtered();
  if (st.view === 'map') renderMap(rows);
  // summary for this month (current year only)
  if (meta.now >= 0 && meta.now <= 11) {
    let done = 0, due = 0, y = 0, six = 0, none = 0;
    const act = d.sites.filter(s => s.active !== false);   // counts are for active rows only
    for (const s of act) { const x = V.statusOf(s, meta.now, meta), t = V.typeOf(s, meta.now); if (x === 'done') done++; if (x === 'due') due++; if (x === 'none') none++; if (t === 'Y') y++; if (t === '6') six++; }
    $('summary').textContent = `${V.MON[meta.now]} ${meta.year}: ${done} done · ${due} still due · ${y} yearly · ${six} 6-monthly · ${none} with no visit this month · ${act.length} active site/client rows` + (d.sites.length > act.length ? ` (+${d.sites.length - act.length} inactive shown)` : '') + (d.unmatched ? ` · ${d.unmatched} record(s) couldn't be matched to a site` : '');
  } else $('summary').textContent = `${d.sites.filter(s => s.active !== false).length} active site/client rows` + (meta.now === 12 ? ' · past year' : ' · future year');
  if (!rows.length) { $('grid').className = 'msg'; $('grid').textContent = 'No sites match.'; return; }
  const head = '<thead><tr><th class="site">Site (' + rows.length + ')</th>' + V.MON.map((mn, m) => `<th class="${m === meta.now ? 'now' : ''}">${mn}</th>`).join('') + '</tr></thead>';
  const body = rows.map(s => '<tr' + (s.active === false ? ' class="off"' : '') + '><td class="site"><div class="row1"><div><div class="n">' + V.esc(s.name) + '</div><div class="s">' + V.esc(s.client || 'no client') + ' · ' + V.esc(s.loc) + ' · ' + V.esc(s.pattern || 'M 6 Y') + (s.annual < 0 ? ' · <b style="color:#b45309">no yearly month</b>' : '') + '</div></div>'
    + '<label class="sw" title="' + (s.active === false ? 'Inactive for this client - tap to make active' : 'Active for this client - tap to make inactive') + '"><input type="checkbox" data-sw="' + V.esc(s.id) + '"' + (s.active === false ? '' : ' checked') + '><span></span></label></div></td>'
    + V.MON.map((mn, m) => { const t = V.typeOf(s, m), x = V.statusOf(s, m, meta); const n = s.visits.filter(v => v.m === m).length;
      return `<td class="m${m === meta.now ? ' now' : ''}"><div class="c st-${x}" data-id="${V.esc(s.id)}" data-m="${m}" title="${mn}: ${t ? V.TYPE[t] : 'no visit'} — ${V.STATUS[x]}${n ? ' (' + n + ')' : ''}">${t === '?' ? 'M' : t || '·'}</div></td>`; }).join('')
    + '</tr>').join('');
  $('grid').className = ''; $('grid').innerHTML = '<table>' + head + '<tbody>' + body + '</tbody></table>';
}

// Row switch: site + client active / inactive (writes register Status + Active). No popup - the switch is the confirm.
$('grid').addEventListener('change', async e => {
  const cb = e.target.closest('input[data-sw]'); if (!cb) return;
  const id = cb.dataset.sw, to = cb.checked, s = st.data.sites.find(x => x.id === id);
  cb.disabled = true;
  try {
    await V.setActive(api(), key(), id, to);
    if (s) s.active = to;
    log('switch', 'saved', { id, client: s && s.client, active: to });
  } catch (err) { cb.checked = !to; log('switch', 'failed', err.message); alert('Could not save: ' + err.message); }
  cb.disabled = false;
  render();
});
let panelAt = null;
function openPanel(id, m) {
  const s = st.data.sites.find(x => x.id === id); if (!s) return;
  panelAt = { id, m };
  $('panelBody').innerHTML = V.detailsHtml(s, m, st.data.meta);
  $('panel').classList.add('open');
  log('panel', 'open', { id, loc: s.loc, client: s.client, month: V.MON[m] });
}
$('panelBody').addEventListener('click', async e => {
  const b = e.target.closest('[data-active-toggle]'); if (!b) return;
  const id = b.dataset.activeToggle, to = b.dataset.activeTo === 'true';
  const s = st.data.sites.find(x => x.id === id);
  if (!to && !confirm(`Make "${s ? s.name : id}" inactive for ${s && s.client ? s.client : 'this client'}?\nIt drops off the schedule. You can turn it back on with Show inactive.`)) return;
  b.disabled = true; b.textContent = 'Saving…';
  try {
    await V.setActive(api(), key(), id, to);
    if (s) s.active = to;
    render(); if (panelAt) openPanel(panelAt.id, panelAt.m);
  } catch (err) { log('active', 'failed', err.message); alert('Could not save: ' + err.message); b.disabled = false; b.textContent = to ? 'Make active' : 'Make inactive'; }
});

$('grid').addEventListener('click', e => { const c = e.target.closest('.c[data-id]'); if (c) openPanel(c.dataset.id, +c.dataset.m); });
$('panelClose').onclick = () => $('panel').classList.remove('open');
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('panel').classList.remove('open'); });
$('q').addEventListener('input', () => { st.q = $('q').value; if (st.data) render(); });
$('client').addEventListener('change', () => { st.client = $('client').value; render(); });
$('chips').addEventListener('click', e => { const f = e.target.dataset.f; if (!f) return; st.filter = f; document.querySelectorAll('#chips button').forEach(b => b.classList.toggle('on', b.dataset.f === f)); render(); });
$('yPrev').onclick = () => { st.year--; load(); };
$('yNext').onclick = () => { st.year++; load(); };
$('reload').onclick = load;
/* ---------- Map view (MapLibre, the open-source map library, with Mapbox map tiles) ----------
   Pins = the same filtered rows as the grid, coloured by status in the chosen month. Coordinates come from
   register columns Lat / Lng. Tiles: Mapbox raster tiles with the user's public token (saved in this browser).
   To switch map provider, change TILE_URL only. */
const KEY_MAPBOX = 'pi.mapboxToken';
const TILE_URL = (t) => 'https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=' + encodeURIComponent(t);
const COLOR = { done: '#16a34a', due: '#f59e0b', missed: '#dc2626', upcoming: '#71717a', norec: '#ffffff', none: '#ffffff' };
let map = null, mapReady = null, mapPopup = null;
function mapToken() { return store.raw(KEY_MAPBOX); }
function loadMapLib() {
  if (self.maplibregl) return Promise.resolve();
  return new Promise((ok, bad) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/maplibre/maplibre-gl.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.src = 'vendor/maplibre/maplibre-gl.js'; js.onload = ok; js.onerror = () => bad(new Error('Map library did not load')); document.head.appendChild(js);
  });
}
function ensureMap() {
  if (mapReady) return mapReady;
  const tok = mapToken();
  if (!/^pk\./.test(tok)) { $('mapKeyCard').hidden = false; return Promise.reject(new Error('no key')); }
  $('mapKeyCard').hidden = true;
  mapReady = loadMapLib().then(() => new Promise(ok => {
    map = new maplibregl.Map({
      container: 'map', center: [145.0, -37.83], zoom: 9.3, attributionControl: false,
      style: { version: 8, sources: { base: { type: 'raster', tiles: [TILE_URL(tok)], tileSize: 512,
        attribution: '© <a href="https://www.mapbox.com/about/maps/" target="_blank">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' } },
        layers: [{ id: 'base', type: 'raster', source: 'base' }] }
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
    map.on('error', e => log('map', 'error', e && e.error && e.error.message));
    map.on('load', () => {
      // Grouping: nearby pins merge into a numbered circle (count = site/client rows); colour = worst status inside.
      map.addSource('sites', { type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        cluster: true, clusterRadius: 55, clusterMaxZoom: 14,
        clusterProperties: { rank: ['max', ['get', 'rank']], rows: ['+', ['get', 'n']], act: ['max', ['get', 'a']] } });
      map.addLayer({ id: 'sites', type: 'circle', source: 'sites', filter: ['!', ['has', 'point_count']], paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 13, 9], 'circle-color': ['get', 'color'],
        'circle-stroke-color': ['get', 'stroke'], 'circle-stroke-width': 1.5, 'circle-opacity': ['get', 'op'] } });
      map.on('click', 'sites', e => showPopup(e.features[0]));
      map.on('render', updateClusterMarkers);
      map.on('mouseenter', 'sites', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'sites', () => { map.getCanvas().style.cursor = ''; });
      log('map', 'ready');
      ok();
    });
  }));
  mapReady.catch(e => { log('map', 'failed', e.message); mapReady = null; });
  return mapReady;
}
function mapMonth() { const n = st.data.meta.now; return st.mapM >= 0 ? st.mapM : (n >= 0 && n <= 11 ? n : 0); }
let fitted = false;
async function renderMap(rows) {
  const meta = st.data.meta, m = mapMonth();
  $('mapMonth').innerHTML = V.MON.map((mn, i) => `<option value="${i}"${i === m ? ' selected' : ''}>${mn} ${meta.year}${i === meta.now ? ' (now)' : ''}</option>`).join('');
  try { await ensureMap(); } catch { return; }
  // one pin per location; rows at the same spot (several clients) share it, worst status wins the colour
  const rank = { missed: 5, due: 4, upcoming: 3, done: 2, norec: 1, none: 0 };
  const at = new Map();
  let noGps = 0;
  for (const s of rows) {
    if (!s.lat || !s.lng) { noGps++; continue; }
    const k = s.lat.toFixed(5) + ',' + s.lng.toFixed(5);
    const x = V.statusOf(s, m, meta);
    const g = at.get(k) || { lat: s.lat, lng: s.lng, ids: [], st: 'none', act: false };
    g.ids.push(s.id); if (rank[x] > rank[g.st]) g.st = x; if (s.active !== false) g.act = true;
    at.set(k, g);
  }
  const features = [...at.values()].map(g => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
    properties: { ids: g.ids.join('|'), color: COLOR[g.st], stroke: g.st === 'none' || g.st === 'norec' ? '#71717a' : '#ffffff', op: g.act ? 1 : 0.45,
      rank: rank[g.st], n: g.ids.length, a: g.act ? 1 : 0 } }));
  map.getSource('sites').setData({ type: 'FeatureCollection', features });
  $('mapCount').textContent = `${rows.length - noGps} on map` + (noGps ? ` · ${noGps} without GPS` : '');
  if (!fitted && features.length) {
    const b = new maplibregl.LngLatBounds(); features.forEach(f => b.extend(f.geometry.coordinates));
    map.fitBounds(b, { padding: 40, maxZoom: 13, duration: 0 }); fitted = true;
  }
  map.resize();
  log('map', 'rendered', { pins: features.length, rows: rows.length, noGps, month: V.MON[m] });
}
// Numbered group circles are HTML markers (no map fonts needed, so any tile provider works).
const RANK_STATUS = ['none', 'norec', 'done', 'upcoming', 'due', 'missed'];
let clusterMarkers = {};
function updateClusterMarkers() {
  if (!map || !map.getSource('sites') || !map.isSourceLoaded('sites')) return;
  const keep = {};
  for (const f of map.querySourceFeatures('sites')) {
    const p = f.properties; if (!p.cluster) continue;
    const id = p.cluster_id; if (keep[id]) continue;
    let mk = clusterMarkers[id];
    const stName = RANK_STATUS[p.rank] || 'none', n = p.rows || p.point_count;
    if (!mk) {
      const el = document.createElement('div'); el.className = 'mclus';
      el.addEventListener('click', ev => { ev.stopPropagation(); zoomCluster(id, f.geometry.coordinates); });
      mk = new maplibregl.Marker({ element: el }).setLngLat(f.geometry.coordinates);
    }
    const el = mk.getElement(), sz = n < 10 ? 28 : n < 50 ? 34 : 42;
    el.textContent = n; el.title = n + ' site/client rows - tap to zoom in';
    // set single properties: cssText would wipe the transform the map uses to position the marker
    Object.assign(el.style, { width: sz + 'px', height: sz + 'px', background: COLOR[stName], color: stName === 'none' || stName === 'norec' ? '#3f3f46' : '#fff', opacity: p.act ? 1 : 0.55, zIndex: String(n) });
    if (!clusterMarkers[id]) mk.addTo(map);
    keep[id] = mk;
  }
  for (const id in clusterMarkers) if (!keep[id]) clusterMarkers[id].remove();
  clusterMarkers = keep;
}
async function zoomCluster(id, at) {
  try { const z = await map.getSource('sites').getClusterExpansionZoom(id); map.easeTo({ center: at, zoom: Math.min(z + 0.3, 17) }); }
  catch (e) { log('map', 'cluster zoom failed', e.message); map.easeTo({ center: at, zoom: map.getZoom() + 2 }); }
}
function showPopup(f) {
  const meta = st.data.meta, m = mapMonth();
  const ids = String(f.properties.ids).split('|');
  const html = '<div class="mpop">' + ids.map(id => { const s = st.data.sites.find(x => x.id === id); if (!s) return '';
    const x = V.statusOf(s, m, meta), t = V.typeOf(s, m);
    return `<div class="pr"><b>${V.esc(s.name)}</b><span class="cl">${V.esc(s.client)} · ${V.esc(s.loc)}${s.active === false ? ' · inactive' : ''}</span><br>
      <span class="vchip st-${x}">${V.MON[m]}: ${t ? V.TYPE[t] + ' · ' : ''}${V.STATUS[x]}</span><br><button type="button" data-open="${V.esc(s.id)}">Open month</button></div>`; }).join('') + '</div>';
  if (mapPopup) mapPopup.remove();
  mapPopup = new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
  mapPopup.getElement().addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) openPanel(b.dataset.open, m); });
}
function setView(v) {
  st.view = v;
  document.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('gridWrap').hidden = v !== 'grid'; $('mapWrap').hidden = v !== 'map';
  try { localStorage.setItem('pi.visitsView', v); } catch {}
  if (st.data) render();
}
$('views').addEventListener('click', e => { const v = e.target.closest('[data-v]'); if (v) setView(v.dataset.v); });
$('mapMonth').addEventListener('change', () => { st.mapM = +$('mapMonth').value; render(); });
$('mapKeySave').onclick = () => {
  const k = $('mapKeyInput').value.trim();
  if (!/^pk\./.test(k)) { alert('That is not a public key. It should start with pk.'); return; }
  try { localStorage.setItem(KEY_MAPBOX, k); } catch {}
  $('mapKeyInput').value = ''; if (map) { map.remove(); map = null; } mapReady = null; fitted = false; render();
};
$('mapKeyEdit').onclick = () => { $('mapKeyCard').hidden = !$('mapKeyCard').hidden; };
if (store.raw('pi.visitsView') === '"map"' || store.raw('pi.visitsView') === 'map') setView('map');
$('showInactive').addEventListener('change', () => { st.inactive = $('showInactive').checked; load(); });
$('keySave').onclick = () => { const k = $('keyInput').value.trim(); if (!k) return; try { localStorage.setItem('pi.adminKey', k); } catch {} load(); };
load();
