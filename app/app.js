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
const state = { lookups: null, sample: true, photos: [], qty: {}, result: '', siteId: '', jobId: newJobId() };
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
  renderContacts(); renderSites(); renderItems(); renderThumbs(); validate();
}

// Client list can be 600+ — the search box narrows the dropdown.
function renderContacts() {
  const L = state.lookups || { contacts: [] };
  const sel = $('contact'), cur = sel.value;
  const q = $('contactSearch').value.trim().toLowerCase();
  const list = L.contacts.filter(c => !q || c.name.toLowerCase().includes(q));
  sel.innerHTML = `<option value="">${q ? list.length + ' match' + (list.length === 1 ? '' : 'es') : 'Select client…'}</option>` +
    list.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  sel.value = list.some(c => c.id === cur) ? cur : '';
  if (q && list.length === 1) sel.value = list[0].id; // one match: pick it
  if (sel.value !== cur) { $('site').value = ''; state.siteId = ''; renderSites(); applyClientPrefs(); }
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Site chips: the client's register sites (search by name/address/alias/ID) + recently used sites.
const siteLabel = (s) => `${s.name} (${s.id})`;
function renderSites() {
  const id = $('contact').value;
  const c = (state.lookups?.contacts || []).find(x => x.id === id);
  const sites = c?.sites || [];
  const recent = store.get(KEY.sites, {})[id] || [];
  const q = $('site').value.trim().toLowerCase();
  let chips = [], hint = '';
  if (state.siteId) chips = [];
  else if (q && sites.length) {
    const words = q.split(/\s+/);
    chips = sites.filter(s => words.every(w => s.search.includes(w))).slice(0, 12).map(s => ({ label: siteLabel(s), id: s.id }));
    if (!chips.length) hint = 'No matching site - what you type will be used as the site.';
  } else if (!q) {
    chips = recent.map(r => ({ label: r, id: (r.match(/\(([^()]+)\)$/) || [])[1] || '' }));
    if (sites.length <= 8) chips = chips.concat(sites.filter(s => !recent.includes(siteLabel(s))).map(s => ({ label: siteLabel(s), id: s.id })));
    else hint = `${sites.length} sites for this client - type to search (address, name or P-number).`;
  }
  $('siteChips').innerHTML = chips.map(s => `<button class="chip" data-site="${esc(s.label)}" data-siteid="${esc(s.id)}">${esc(s.label)}</button>`).join('');
  $('siteHint').textContent = hint || (sites.length ? '' : 'Type the site address.');
}

// Selected items always show; others only when they match the search (max 40).
function renderItems() {
  const all = state.lookups?.items || [];
  const q = $('itemSearch').value.trim().toLowerCase();
  const picked = all.filter(it => state.qty[it.code] > 0);
  const matches = q ? all.filter(it => !(state.qty[it.code] > 0) &&
    (it.name.toLowerCase().includes(q) || String(it.code).toLowerCase().includes(q))).slice(0, 40) : [];
  const items = all.length <= 12 ? all : picked.concat(matches);
  const hint = all.length > 12 && !q ? `<div class="hint">Type to search ${all.length} items.</div>` : '';
  $('items').innerHTML = hint + items.map(it => {
    const q = state.qty[it.code] || 0;
    return `<div class="item"><div class="nm">${esc(it.name)}<div class="pr">${money(+it.price)} ex GST</div></div>
      <div class="qty"><button class="secondary" data-dec="${esc(it.code)}">−</button><span>${q}</span>
      <button data-inc="${esc(it.code)}">+</button></div></div>`;
  }).join('') || (hint ? '' : `<div class="hint">${q ? 'No matching items.' : 'No items loaded.'}</div>`);
  const sub = lines().reduce((a, l) => a + l.qty * l.unitAmount, 0);
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
  const id = $('contact').value;
  const contact = (state.lookups?.contacts || []).find(c => c.id === id);
  $('noInvoice').checked = !!(id && store.get(KEY.noInvoice, {})[id]);
  $('clientEmail').value = (id && store.get(KEY.emails, {})[id]) || contact?.testEmail || contact?.email || '';
  log('applyClientPrefs', 'applied', { id, noInvoice: $('noInvoice').checked, email: $('clientEmail').value });
  renderMode();
}

function saveClientPrefs() {
  const id = $('contact').value; if (!id) return;
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
  if (!$('contact').value) need.push('client');
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
  const s = settings(), contactId = $('contact').value, site = $('site').value.trim();
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
  const busyJob = state.photos.length || $('contact').value || $('site').value.trim() || Object.values(state.qty).some(q => q > 0);
  if (busyJob && !armT) {
    b.textContent = 'Tap again to clear';
    armT = setTimeout(() => { armT = 0; b.textContent = '↺ New job'; }, 3000);
    return;
  }
  clearTimeout(armT); armT = 0; b.textContent = '↺ New job';
  resetJob();
  $('contactSearch').value = ''; $('itemSearch').value = '';
  renderContacts(); $('contact').value = '';
  $('noInvoice').checked = false; $('clientEmail').value = '';
  render(); renderMode();
  scrollTo(0, 0);
  log('newJob', 'cleared', { jobId: state.jobId });
  toast('New job');
}

/* ---------- events ---------- */
$('ver').textContent = BUILD.version;
$('contact').addEventListener('change', () => { $('site').value = ''; state.siteId = ''; renderSites(); applyClientPrefs(); });
$('noInvoice').addEventListener('change', () => { saveClientPrefs(); renderMode(); });
$('clientEmail').addEventListener('input', validate);
document.querySelectorAll('button.result').forEach(b => b.addEventListener('click', () => { state.result = b.dataset.result; log('result', 'set', state.result); renderMode(); }));
$('wantQuote').addEventListener('change', () => { log('quote', 'set', $('wantQuote').checked); renderMode(); if ($('wantQuote').checked) $('quoteNote').focus(); });
$('contactSearch').addEventListener('input', () => { renderContacts(); validate(); });
$('itemSearch').addEventListener('input', renderItems);
$('site').addEventListener('input', () => { state.siteId = ''; renderSites(); validate(); });
$('siteChips').addEventListener('click', e => {
  const s = e.target.dataset.site; if (!s) return;
  $('site').value = s; state.siteId = e.target.dataset.siteid || ''; log('site', 'picked', { s, id: state.siteId });
  renderSites(); validate();
});
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
