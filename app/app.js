'use strict';
/* Test Invoice PWA — see README.md for the n8n contract. */

const BUILD = self.BUILD_INFO || { version: 'dev' };
const KEY = { settings: 'pi.settings', lookups: 'pi.lookups', sites: 'pi.sites', noInvoice: 'pi.noInvoice', emails: 'pi.emails', quote: 'pi.quote' };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const validEmails = (s) => { const l = String(s).split(/[,;]/).map(x => x.trim()).filter(Boolean); return l.length > 0 && l.every(e => EMAIL_RE.test(e)); };
const MAX_SIDE = 1600;            // px, longest edge of any uploaded image
const MAX_BYTES = 2.8 * 1024 * 1024; // stay under Xero's reported 3MB/attachment
const GST = 0.10;

// Sample data used when no webhook URL is set (prices are placeholders).
const SAMPLE = {
  contacts: [
    { id: 'sample-1', name: 'Sample Body Corporate' },
    { id: 'sample-2', name: 'Example Property Group' },
    { id: 'sample-3', name: 'Test Client Pty Ltd' }
  ],
  items: [
    { code: 'SAMPLE-PUMP', name: 'Monthly fire pump test', price: 150 },
    { code: 'SAMPLE-HYD', name: 'Hydrant flow test', price: 280 },
    { code: 'SAMPLE-SPR', name: 'Sprinkler valve test', price: 95 },
    { code: 'SAMPLE-CALL', name: 'Call-out', price: 85 }
  ]
};

const newJobId = () => crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2);
// jobId stays the same until the job is sent or cleared, so pressing Send again
// after a lost reply is recognised by n8n as the same job (no double email/invoice).
const state = { lookups: null, sample: true, photos: [], qty: {}, result: '', contactId: '', siteId: '', jobId: newJobId() };
const $ = (id) => document.getElementById(id);
const money = (n) => '$' + n.toFixed(2);
const log = (where, msg, data) => console.log(`[${where}] ${msg}`, data ?? '');

/* ---------- storage ---------- */
// n8n serves webhook HTML pages in a CSP sandbox (opaque "null" origin), where
// localStorage throws. Detect that and fall back to memory for this session.
const CAN_SAVE = (() => { try { localStorage.setItem('pi.t', '1'); localStorage.removeItem('pi.t'); return true; } catch { return false; } })();
const mem = {};
const store = {
  get(k, d) { try { return JSON.parse(CAN_SAVE ? localStorage.getItem(k) : (mem[k] ?? null)) ?? d; } catch { return d; } },
  set(k, v) { try { if (CAN_SAVE) localStorage.setItem(k, JSON.stringify(v)); else mem[k] = JSON.stringify(v); } catch (e) { log('store', 'write failed', e); } }
};
// When served from n8n itself (/webhook/...), default the API URL to the same server.
// Served from n8n (/webhook/...): same server. Self-hosted: the API base from buildInfo.js.
const DEFAULT_URL = location.pathname.startsWith('/webhook/') ? location.origin + '/webhook' : (BUILD.apiBase || '');
const settings = () => store.get(KEY.settings, { url: DEFAULT_URL, key: '' });

// Setup link: ...?key=XXXX or ...#key=XXXX (optional url=...).
// If the page can save, the key is stored and stripped from the address bar.
// If it can't (sandboxed), the key stays in the link so a bookmark / home-screen icon keeps working.
(function setupFromLink() {
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
  const key = q.get('key') || h.get('key');
  log('setup', 'link check', { canSave: CAN_SAVE, hasKey: !!key });
  if (!key) return;
  store.set(KEY.settings, { url: q.get('url') || h.get('url') || settings().url || DEFAULT_URL, key });
  if (CAN_SAVE) history.replaceState(null, '', location.pathname);
  else if (!q.get('key')) history.replaceState(null, '', location.pathname + '?key=' + encodeURIComponent(key));
})();
// Sandboxed: drop the manifest so iOS "Add to Home Screen" saves THIS url (with the key)
// instead of the manifest start_url (without it).
if (!CAN_SAVE) document.querySelector('link[rel="manifest"]')?.remove();

/* ---------- toast / busy ---------- */
let toastT;
function toast(msg, ms = 2500) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastT); toastT = setTimeout(() => (t.style.display = 'none'), ms);
}
const busy = (on, msg = 'Sending…') => { $('busy').textContent = msg; $('busy').style.display = on ? 'flex' : 'none'; };

/* ---------- lookups (Xero contacts + items via n8n) ---------- */
async function loadLookups(force = false) {
  const s = settings();
  state.sample = !s.url;
  $('modeTag').textContent = state.sample ? 'SAMPLE' : '';
  log('loadLookups', 'called', { sample: state.sample, force });

  if (state.sample) { state.lookups = SAMPLE; return render(); }

  const cached = store.get(KEY.lookups, null);
  if (cached && !force) { state.lookups = cached; render(); }

  try {
    // Key goes in the query string (no custom headers) so the browser makes a
    // "simple" CORS request with no preflight.
    const r = await fetch(s.url.replace(/\/$/, '') + '/photo-invoice-lookups?key=' + encodeURIComponent(s.key || ''));
    if (r.status === 401) throw new Error('app key missing — open your setup link');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    log('loadLookups', 'received', { contacts: data.contacts?.length, items: data.items?.length });
    if (!Array.isArray(data.contacts) || !Array.isArray(data.items)) throw new Error('Bad lookups shape');
    data.contacts.sort((a, b) => a.name.localeCompare(b.name));
    state.lookups = data; store.set(KEY.lookups, data); render();
    if (force) toast('Clients & items updated');
  } catch (e) {
    log('loadLookups', 'failed', e.message);
    if (!state.lookups) { state.lookups = { contacts: [], items: [] }; render(); }
    toast(cached ? 'Offline — using saved list' : 'Could not load clients: ' + e.message, 4000);
  }
}

/* ---------- render ---------- */
function render() {
  syncCombos(); renderItems(); renderThumbs(); validate();
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- fuzzy search ---------- */
// Every typed word must match somewhere: as a substring (best, especially at a word start),
// as letters in order ("hydrt" -> hydrant), or with one typo / swapped letters ("hydarnt").
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
function near(a, b) { // edit distance <= 1, counting two swapped neighbours as one edit
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i)
    || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
}
function fuzzyScore(words, text) {
  let total = 0;
  for (const w of words) {
    const at = text.indexOf(w);
    if (at >= 0) { total += 100 + w.length * 3 + (at === 0 ? 40 : text[at - 1] === ' ' ? 25 : 0) - Math.min(at, 40) / 4; continue; }
    let from = 0, last = -1, gaps = 0, ok = true;
    for (const ch of w) {
      const f = text.indexOf(ch, from);
      if (f < 0) { ok = false; break; }
      if (last >= 0) gaps += f - last - 1;
      last = f; from = f + 1;
    }
    if (ok && gaps <= w.length * 2) { total += 50 - gaps; continue; }
    if (w.length >= 4 && text.split(' ').some(t => near(w, t))) { total += 35; continue; }
    return -1;
  }
  return total;
}
function fuzzyFilter(list, query, textOf) {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return list;
  return list.map(x => ({ x, s: fuzzyScore(words, norm(textOf(x))) }))
    .filter(r => r.s >= 0).sort((p, q) => q.s - p.s).map(r => r.x);
}
// Bold the parts of a label that literally match a typed word.
function highlight(label, query) {
  label = String(label || '');
  const words = norm(query).split(' ').filter(w => w.length > 1);
  if (!words.length) return esc(label);
  const re = new RegExp(words.join('|'), 'gi');
  let out = '', last = 0;
  label.replace(re, (m, i) => { out += esc(label.slice(last, i)) + '<mark>' + esc(m) + '</mark>'; last = i + m.length; return m; });
  return out + esc(label.slice(last));
}

/* ---------- searchable dropdowns ---------- */
// One box + a scrollable list under it: tap the box to see everything, type to fuzzy-filter, tap a row to pick.
const MAX_ROWS = 80;
const combos = [];
function makeCombo(o) {
  const input = $(o.input), list = $(o.list), clear = $(o.clear);
  const c = { input, list, open: false, rows: [] };
  c.show = () => {
    const all = o.items();
    const rows = fuzzyFilter(all, input.value, o.text);
    const head = o.head ? o.head(input.value) : '';
    list.innerHTML = head + (rows.length
      ? rows.slice(0, MAX_ROWS).map((x, i) => `<div class="opt" data-i="${i}">${o.row(x, input.value)}</div>`).join('')
        + (rows.length > MAX_ROWS ? `<div class="opt-more">${rows.length - MAX_ROWS} more — keep typing to narrow it down</div>` : '')
      : `<div class="opt-more">${esc(o.empty(input.value, all))}</div>`);
    c.rows = rows; list.hidden = false; c.open = true;
  };
  c.close = () => { list.hidden = true; c.open = false; };
  const pick = (x) => { c.close(); input.blur(); o.pick(x); clear.hidden = !input.value; log('combo', 'picked', { box: o.input }); };
  input.addEventListener('focus', () => { c.show(); list.scrollTop = 0; setTimeout(() => input.scrollIntoView({ block: 'start', behavior: 'smooth' }), 300); });
  input.addEventListener('input', () => { if (o.onType) o.onType(input.value); c.show(); list.scrollTop = 0; clear.hidden = !input.value; });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (c.rows[0] && input.value.trim()) pick(c.rows[0]); else { c.close(); input.blur(); } }
    if (e.key === 'Escape') c.close();
  });
  list.addEventListener('click', e => {
    const el = e.target.closest('.opt'); if (!el) return;
    if (el.dataset.free) { c.close(); input.blur(); return; } // "use what I typed"
    pick(c.rows[+el.dataset.i]);
  });
  clear.addEventListener('click', () => { input.value = ''; clear.hidden = true; if (o.onType) o.onType(''); input.focus(); c.show(); });
  combos.push(c);
  return c;
}
document.addEventListener('pointerdown', e => {
  for (const c of combos) if (c.open && !c.input.closest('.combo').contains(e.target)) c.close();
});

const currentClient = () => (state.lookups?.contacts || []).find(c => c.id === state.contactId);
const siteLabel = (s) => s.id ? `${s.name} (${s.id})` : s.name;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function setClient(id) {
  if (id === state.contactId) return;
  state.contactId = id; $('site').value = ''; state.siteId = '';
  log('client', 'set', { id });
  applyClientPrefs(); syncCombos(); validate();
}

// Client's register sites, with recently used ones (incl. typed addresses) first.
function siteOptions() {
  const sites = currentClient()?.sites || [];
  const recent = (store.get(KEY.sites, {})[state.contactId] || []).map(r => {
    const id = (r.match(/\(([^()]+)\)$/) || [])[1] || '';
    const s = sites.find(x => x.id === id);
    return s ? Object.assign({}, s, { recent: true }) : { id: '', name: r, search: r, recent: true };
  });
  return recent.concat(sites.filter(s => !recent.some(r => r.id && r.id === s.id)));
}

makeCombo({
  input: 'contactSearch', list: 'contactList', clear: 'contactClear',
  items: () => state.lookups?.contacts || [],
  text: c => c.name + ' ' + (c.registerId || '') + ' ' + (c.email || ''),
  row: (c, q) => `${highlight(c.name, q)}<div class="sub">${c.sites?.length ? plural(c.sites.length, 'site') : 'no register sites'}${c.id === state.contactId ? ' · selected' : ''}</div>`,
  empty: (q, all) => all.length ? `No client matches "${q}"` : 'Clients not loaded yet',
  onType: () => { if (state.contactId) setClient(''); },
  pick: c => { $('contactSearch').value = c.name; setClient(c.id); }
});

makeCombo({
  input: 'site', list: 'siteList', clear: 'siteClear',
  items: siteOptions,
  text: s => s.search || s.name,
  row: (s, q) => `${highlight(s.name, q)}<div class="sub">${esc(s.id || 'typed address')}${s.recent ? ' · recent' : ''}</div>`,
  head: q => q.trim() && !state.siteId ? `<div class="opt opt-free" data-free="1">Use “${esc(q.trim())}” as the site</div>` : '',
  empty: (q, all) => !state.contactId ? 'Pick a client first, or just type the address'
    : all.length ? 'No matching site — what you type will be used' : 'No register sites for this client — type the address',
  onType: () => { state.siteId = ''; validate(); },
  pick: s => { $('site').value = siteLabel(s); state.siteId = s.id || ''; validate(); }
});

makeCombo({
  input: 'itemSearch', list: 'itemList', clear: 'itemClear',
  items: () => state.lookups?.items || [],
  text: it => it.name + ' ' + it.code,
  row: (it, q) => `<div class="opt-row"><span>${highlight(it.name, q)}<div class="sub">${money(+it.price)} ex GST · ${esc(it.code)}</div></span>${state.qty[it.code] ? `<b class="badge">×${state.qty[it.code]}</b>` : ''}</div>`,
  empty: (q, all) => all.length ? `No item matches "${q}"` : 'Items not loaded yet',
  pick: it => { state.qty[it.code] = (state.qty[it.code] || 0) + 1; $('itemSearch').value = ''; renderItems(); validate(); toast('Added: ' + it.name); }
});

function syncCombos() {
  const c = currentClient();
  if (c && document.activeElement !== $('contactSearch')) $('contactSearch').value = c.name;
  const n = c?.sites?.length || 0;
  $('siteHint').textContent = !state.contactId || state.siteId ? '' : n ? `${plural(n, 'site')} for this client — tap the box to pick or search.` : 'No register sites for this client — type the address.';
  [['contactSearch', 'contactClear'], ['site', 'siteClear'], ['itemSearch', 'itemClear']].forEach(([i, x]) => { $(x).hidden = !$(i).value; });
  for (const cb of combos) if (cb.open) cb.show();
}

// Items on this job (pick more from the box above).
function renderItems() {
  const picked = (state.lookups?.items || []).filter(it => state.qty[it.code] > 0);
  $('items').innerHTML = picked.map(it => `<div class="item"><div class="nm">${esc(it.name)}<div class="pr">${money(+it.price)} ex GST</div></div>
      <div class="qty"><button class="secondary" data-dec="${esc(it.code)}">−</button><span>${state.qty[it.code]}</span>
      <button data-inc="${esc(it.code)}">+</button></div></div>`).join('')
    || '<div class="hint">Tap the box above to pick items — type to search.</div>';
  const sub = lines().reduce((s, l) => s + l.qty * l.unitAmount, 0);
  $('totals').innerHTML = sub ? `Subtotal ${money(sub)} · GST ${money(sub * GST)}<br><b>Total ${money(sub * (1 + GST))}</b>` : '';
}

function renderThumbs() {
  $('thumbs').innerHTML = state.photos.map((p, i) =>
    `<div class="thumb"><img src="${p.url}" alt=""><span class="tag">${p.kind === 'document' ? 'Doc' : 'Photo ' + (i + 1)}</span>
     <button class="x" data-del="${i}">×</button></div>`).join('');
}

function lines() {
  return (state.lookups?.items || []).filter(it => state.qty[it.code] > 0).map(it => ({
    itemCode: it.code, description: it.name, qty: state.qty[it.code], unitAmount: +it.price
  }));
}

const emailMode = () => $('noInvoice').checked;

// Per-client memory: the No-invoice switch and the email address. (Quote is per job, not remembered.)
function applyClientPrefs() {
  const id = state.contactId;
  const contact = currentClient();
  $('noInvoice').checked = !!(id && store.get(KEY.noInvoice, {})[id]);
  $('clientEmail').value = (id && store.get(KEY.emails, {})[id]) || contact?.testEmail || contact?.email || '';
  log('applyClientPrefs', 'applied', { id, noInvoice: $('noInvoice').checked, email: $('clientEmail').value });
  renderMode();
}

function saveClientPrefs() {
  const id = state.contactId; if (!id) return;
  const ni = store.get(KEY.noInvoice, {}); ni[id] = emailMode(); store.set(KEY.noInvoice, ni);
  const em = $('clientEmail').value.trim();
  if (em) { const all = store.get(KEY.emails, {}); all[id] = em; store.set(KEY.emails, all); }
}

function renderMode() {
  $('itemsCard').hidden = emailMode(); // contract jobs: no items, the test reports say what was done
  document.querySelectorAll('button.result').forEach(b => b.classList.toggle('on', b.dataset.result === state.result));
  $('quoteNote').hidden = !$('wantQuote').checked;
  validate();
}

// Every job: client, site, Pass/Fail, client email, at least one photo. Invoice jobs also need an item.
// While something is missing the button says what, so it never just sits greyed out.
function validate() {
  const need = [];
  if (!state.contactId) need.push('client');
  if (!$('site').value.trim()) need.push('site');
  if (!state.photos.length) need.push('photo');
  if (!state.result) need.push('pass/fail');
  if (!validEmails($('clientEmail').value)) need.push('email');
  if (!emailMode() && !lines().length) need.push('item');
  $('sendBtn').disabled = need.length > 0;
  const label = emailMode() ? 'Email client (no invoice)' : 'Create invoice + email client';
  $('sendBtn').textContent = need.length ? 'Still need: ' + need.join(', ')
    : (state.sample ? label + ' (sample — not sent)' : label);
}

/* ---------- image helpers ---------- */
async function fileToCanvas(file, maxSide) {
  const bmp = await createImageBitmap(file); // respects EXIF orientation in current browsers
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

async function canvasToJpeg(c) {
  let q = 0.82, blob;
  do {
    blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
    q -= 0.12;
  } while (blob.size > MAX_BYTES && q > 0.3);
  log('canvasToJpeg', 'encoded', { w: c.width, h: c.height, kb: Math.round(blob.size / 1024) });
  return blob;
}

function addPhoto(blob, kind) {
  state.photos.push({ blob, kind, url: URL.createObjectURL(blob) });
  renderThumbs(); validate();
}

/* ---------- crop editor ---------- */
const crop = { src: null, pts: null, drag: -1 };

async function openCropper(file) {
  busy(true, 'Finding document…');
  try {
    crop.src = await fileToCanvas(file, 2000);
    crop.pts = autoPts() || defaultPts();
    $('cropper').classList.add('open');
    requestAnimationFrame(drawCrop);
  } finally { busy(false); }
}

function defaultPts() {
  const { width: w, height: h } = crop.src, m = 0.08;
  return [{ x: w * m, y: h * m }, { x: w * (1 - m), y: h * m }, { x: w * (1 - m), y: h * (1 - m) }, { x: w * m, y: h * (1 - m) }];
}

function autoPts() {
  // Detect on a small copy for speed, then scale back up.
  const s = Math.min(1, 400 / Math.max(crop.src.width, crop.src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(crop.src.width * s); c.height = Math.round(crop.src.height * s);
  const ctx = c.getContext('2d'); ctx.drawImage(crop.src, 0, 0, c.width, c.height);
  const pts = Geo.detectDocument(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  log('autoPts', pts ? 'document found' : 'no document found', pts);
  return pts && pts.map(p => ({ x: p.x / s, y: p.y / s }));
}

function cropView() {
  const cv = $('cropCanvas'), dpr = devicePixelRatio || 1;
  const W = cv.clientWidth * dpr, H = cv.clientHeight * dpr;
  const f = Math.min(W / crop.src.width, H / crop.src.height);
  return { cv, dpr, W, H, f, ox: (W - crop.src.width * f) / 2, oy: (H - crop.src.height * f) / 2 };
}

function drawCrop() {
  const v = cropView(); v.cv.width = v.W; v.cv.height = v.H;
  const ctx = v.cv.getContext('2d');
  ctx.drawImage(crop.src, v.ox, v.oy, crop.src.width * v.f, crop.src.height * v.f);
  const P = crop.pts.map(p => ({ x: v.ox + p.x * v.f, y: v.oy + p.y * v.f }));
  ctx.beginPath(); P.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
  ctx.fillStyle = 'rgba(185,28,28,.18)'; ctx.fill();
  ctx.lineWidth = 3 * v.dpr; ctx.strokeStyle = '#ef4444'; ctx.stroke();
  P.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 14 * v.dpr, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); });
}

function cropPointer(e) {
  const v = cropView(), r = v.cv.getBoundingClientRect();
  const x = ((e.clientX - r.left) * v.dpr - v.ox) / v.f, y = ((e.clientY - r.top) * v.dpr - v.oy) / v.f;
  if (e.type === 'pointerdown') {
    let best = -1, bd = (40 * v.dpr) / v.f;
    crop.pts.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = i; } });
    crop.drag = best; if (best >= 0) v.cv.setPointerCapture(e.pointerId);
  } else if (e.type === 'pointermove' && crop.drag >= 0) {
    crop.pts[crop.drag] = { x: Math.max(0, Math.min(crop.src.width, x)), y: Math.max(0, Math.min(crop.src.height, y)) };
    drawCrop();
  } else if (e.type === 'pointerup' || e.type === 'pointercancel') crop.drag = -1;
}

async function useCrop() {
  busy(true, 'Flattening…');
  try {
    const { width: sw, height: sh } = crop.src;
    const src = crop.src.getContext('2d').getImageData(0, 0, sw, sh).data;
    const { w, h } = Geo.outputSize(crop.pts, MAX_SIDE);
    log('useCrop', 'warping', { pts: crop.pts, w, h });
    let px = Geo.warp(src, sw, sh, crop.pts, w, h);
    if ($('cropEnhance').checked) px = Geo.enhance(px);
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    out.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
    addPhoto(await canvasToJpeg(out), 'document');
    closeCrop();
  } catch (e) {
    log('useCrop', 'failed', e); toast('Crop failed: ' + e.message, 4000);
  } finally { busy(false); }
}

function closeCrop() { $('cropper').classList.remove('open'); crop.src = null; }

/* ---------- submit ---------- */
const blobToDataUrl = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

async function submit() {
  const s = settings(), contactId = state.contactId, site = $('site').value.trim();
  const contact = state.lookups.contacts.find(c => c.id === contactId);
  const stamp = new Date().toISOString().slice(0, 10);
  busy(true);
  try {
    const photos = await Promise.all(state.photos.map(async (p, i) => ({
      filename: `${stamp}-${p.kind === 'document' ? 'document' : 'photo-' + (i + 1)}.jpg`,
      contentType: 'image/jpeg',
      base64: (await blobToDataUrl(p.blob)).split(',')[1]
    })));
    const payload = {
      appVersion: BUILD.version,
      submissionId: state.jobId,
      date: stamp,
      contact: { id: contactId, name: contact?.name },
      site, siteId: state.siteId, reference: site,
      lineAmountTypes: 'Exclusive',
      mode: emailMode() ? 'email' : 'xero',
      clientEmail: $('clientEmail').value.trim(),
      result: state.result,
      quote: $('wantQuote').checked,
      quoteNote: $('wantQuote').checked ? $('quoteNote').value.trim().slice(0, 200) : '',
      lines: emailMode() ? [] : lines(),
      photos
    };
    const kb = Math.round(JSON.stringify(payload).length / 1024);
    log('submit', 'payload built', { ...payload, photos: photos.map(p => p.filename), kb });

    saveClientPrefs();
    if (state.sample) { toast(`Sample mode: ${payload.mode === 'email' ? 'email' : 'invoice'} built (${photos.length} photos, ${kb} KB) — not sent`, 4000); return; }

    // text/plain + key in body = simple CORS request, no preflight. n8n parses the JSON.
    const r = await fetch(s.url.replace(/\/$/, '') + '/photo-invoice-submit', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ key: s.key || '', ...payload })
    });
    const body = await r.json().catch(() => ({}));
    log('submit', 'response', { status: r.status, body });
    if (!r.ok || body.ok === false) throw new Error(body.error || 'HTTP ' + r.status);

    rememberSite(contactId, site);
    resetJob();
    const parts = [];
    if (body.invoiceNumber) parts.push(`Draft ${body.invoiceNumber} in Xero`);
    if (body.sentTo) parts.push(`emailed to ${body.sentTo}`);
    if (body.quotePending) parts.push('quote being created in Xero');
    const msg = body.duplicate ? `Already sent earlier (${body.invoiceNumber}) - not sent again` : parts.join(' · ') + ' ✓';
    toast(body.warning ? msg + ' — ' + body.warning : msg, 5000);
  } catch (e) {
    log('submit', 'failed', e.message);
    toast('Not sent — ' + e.message + '. Your job is still here, try again.', 5000);
  } finally { busy(false); }
}

function rememberSite(contactId, site) {
  const all = store.get(KEY.sites, {});
  all[contactId] = [site, ...(all[contactId] || []).filter(s => s !== site)].slice(0, 8);
  store.set(KEY.sites, all);
}

function resetJob() {
  state.photos.forEach(p => URL.revokeObjectURL(p.url));
  state.photos = []; state.qty = {}; state.result = ''; state.jobId = newJobId();
  $('site').value = ''; state.siteId = '';
  $('wantQuote').checked = false; $('quoteNote').value = '';
  render();
}

// New job button: clear everything, client included. If the job has anything in it,
// the first tap asks "Tap again to clear" (no popup - popups can be blocked in n8n's sandbox).
let armT = 0;
function newJob() {
  const b = $('resetBtn');
  const busyJob = state.photos.length || state.contactId || $('site').value.trim() || Object.values(state.qty).some(q => q > 0);
  if (busyJob && !armT) {
    b.textContent = 'Tap again to clear';
    armT = setTimeout(() => { armT = 0; b.textContent = '↺ New job'; }, 3000);
    return;
  }
  clearTimeout(armT); armT = 0; b.textContent = '↺ New job';
  resetJob();
  $('contactSearch').value = ''; $('itemSearch').value = ''; state.contactId = '';
  $('noInvoice').checked = false; $('clientEmail').value = '';
  render(); renderMode();
  scrollTo(0, 0);
  log('newJob', 'cleared', { jobId: state.jobId });
  toast('New job');
}

/* ---------- events ---------- */
$('ver').textContent = BUILD.version;
$('noInvoice').addEventListener('change', () => { saveClientPrefs(); renderMode(); });
$('clientEmail').addEventListener('input', validate);
document.querySelectorAll('button.result').forEach(b => b.addEventListener('click', () => { state.result = b.dataset.result; log('result', 'set', state.result); renderMode(); }));
$('wantQuote').addEventListener('change', () => { log('quote', 'set', $('wantQuote').checked); renderMode(); if ($('wantQuote').checked) $('quoteNote').focus(); });
$('items').addEventListener('click', e => {
  const inc = e.target.dataset.inc, dec = e.target.dataset.dec;
  if (inc) state.qty[inc] = (state.qty[inc] || 0) + 1;
  else if (dec) state.qty[dec] = Math.max(0, (state.qty[dec] || 0) - 1);
  else return;
  renderItems(); validate();
});
$('thumbs').addEventListener('click', e => {
  const i = e.target.dataset.del; if (i === undefined) return;
  URL.revokeObjectURL(state.photos[i].url); state.photos.splice(+i, 1); renderThumbs(); validate();
});
$('addPhoto').onclick = () => $('photoInput').click();
$('addDoc').onclick = () => $('docInput').click();
// Take a photo or pick one or more from the library (iOS shows the choice).
$('photoInput').onchange = async e => {
  const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
  log('photoInput', 'files picked', files.length);
  busy(true, files.length > 1 ? `Saving ${files.length} photos…` : 'Saving photo…');
  let failed = 0;
  for (const f of files) {
    try { addPhoto(await canvasToJpeg(await fileToCanvas(f, MAX_SIDE)), 'test'); }
    catch (err) { failed++; log('photoInput', 'failed', err); }
  }
  busy(false);
  if (failed) toast(`${failed} photo${failed > 1 ? 's' : ''} could not be read`);
};
$('docInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openCropper(f); };

const cc = $('cropCanvas');
['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(t => cc.addEventListener(t, cropPointer));
addEventListener('resize', () => crop.src && drawCrop());
$('cropCancel').onclick = closeCrop;
$('cropAuto').onclick = () => {
  const p = autoPts(); crop.pts = p || defaultPts(); drawCrop();
  if (!p) toast('Could not find edges — drag the corners');
};
$('cropUse').onclick = useCrop;

$('sendBtn').onclick = submit;
$('resetBtn').onclick = newJob;
$('settingsBtn').onclick = () => { const s = settings(); $('setUrl').value = s.url; $('setKey').value = s.key; $('settings').classList.add('open'); };
$('setClose').onclick = () => $('settings').classList.remove('open');
$('setSave').onclick = () => {
  store.set(KEY.settings, { url: $('setUrl').value.trim(), key: $('setKey').value.trim() });
  $('settings').classList.remove('open'); state.qty = {}; loadLookups(true);
};
$('setRefresh').onclick = () => { $('settings').classList.remove('open'); loadLookups(true); };

/* ---------- service worker + update banner ---------- */
if (CAN_SAVE && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(self.BUILD_INFO.swPath || 'sw.js', self.BUILD_INFO.swScope ? { scope: self.BUILD_INFO.swScope } : undefined).then(reg => {
    const offer = (w) => { $('updateBanner').style.display = 'block'; $('updateBanner').onclick = () => w.postMessage('skipWaiting'); };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
  }).catch(e => log('sw', 'register failed', e));
  // Only reload when an update replaces an existing version (not on first install).
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
}

log('app', 'start', BUILD);
loadLookups();
