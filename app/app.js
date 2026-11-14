'use strict';
/* Test Invoice PWA — see README.md for the n8n contract. */

const BUILD = self.BUILD_INFO || { version: 'dev' };
const KEY = { settings: 'pi.settings', lookups: 'pi.lookups', sites: 'pi.sites', noInvoice: 'pi.noInvoice', emails: 'pi.emails', quote: 'pi.quote', quickOpen: 'pi.quickOpen', jobs: 'pi.jobs' };
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
const state = { lookups: null, sample: true, photos: [], qty: {}, result: '', contactId: '', siteId: '', locId: '', jobId: newJobId() };
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
async function loadLookups(force = false, quiet = false) {
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
    if (force && !quiet) toast('Clients & items updated');
    return { ok: true, contacts: data.contacts.length, items: data.items.length };
  } catch (e) {
    log('loadLookups', 'failed', e.message);
    if (!state.lookups) { state.lookups = { contacts: [], items: [] }; render(); }
    if (!quiet) toast(cached ? 'Offline — using saved list' : 'Could not load clients: ' + e.message, 4000);
    return { ok: false, error: e.message, cached: !!cached };
  }
}

// Sync button: newer app version? -> reload into it. Otherwise refresh clients/sites/items/quick items
// and send any queued jobs, then say what happened.
let syncing = false;
async function syncNow() {
  if (syncing) return;
  syncing = true; $('syncBtn').classList.add('spin'); log('sync', 'start');
  let newer = '';
  try {
    if (navigator.onLine !== false && !state.sample) {
      try {
        const r = await fetch('buildInfo.js?t=' + Date.now(), { cache: 'no-store' });
        const live = ((await r.text()).match(/version:\s*'([^']+)'/) || [])[1];
        log('sync', 'version check', { running: BUILD.version, live });
        if (live && live !== BUILD.version && !state.photos.length) {
          toast(`Updating to ${live}\u2026`); setTimeout(() => location.reload(), 600); return;
        }
        if (live && live !== BUILD.version) newer = live; // job in progress: don't reload, mention it below
      } catch (e) { log('sync', 'version check failed', e.message); }
    }
    const res = await loadLookups(true, true);
    await flushQueue(true);
    const waiting = QUEUE_OK ? (await Q.all().catch(() => [])).length : 0;
    const extra = newer ? ` \u2014 new version ${newer} loads once this job is sent (tap \u27f3 again then)` : '';
    if (res && res.ok) toast(`Synced \u2713 ${res.contacts} clients \u00b7 ${res.items} items` + (waiting ? ` \u00b7 ${waiting} job${waiting === 1 ? '' : 's'} still waiting` : '') + extra, newer ? 6000 : 3500);
    else if (res) toast((res.cached ? 'No signal \u2014 using the saved list' : 'Could not sync: ' + res.error) + (waiting ? ` \u00b7 ${waiting} waiting` : ''), 4500);
  } finally { syncing = false; $('syncBtn').classList.remove('spin'); }
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
function fuzzyFilter(list, query, textOf, boost) {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return list;
  return list.map(x => { const s = fuzzyScore(words, norm(textOf(x))); return { x, s: s < 0 ? s : s + (boost ? boost(x) : 0) }; })
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
    const all = o.items(input.value);
    const rows = fuzzyFilter(all, input.value, o.text, o.boost);
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
    if (el.dataset.add) { c.close(); input.blur(); if (o.onAdd) o.onAdd(input.value); return; }
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
// Sites show their AFS location number. s.id is the register row key (old Uptick P-numbers stay hidden).
const siteLabel = (s) => (s.loc || s.id) ? `${s.name} (${s.loc || s.id})` : s.name;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function setClient(id) {
  if (id === state.contactId) return;
  state.contactId = id; $('site').value = ''; state.siteId = ''; state.locId = '';
  log('client', 'set', { id });
  applyClientPrefs(); syncCombos(); validate();
}

// Every register site across all clients, tagged with its client.
function allSites() {
  const out = [];
  for (const c of state.lookups?.contacts || []) for (const s of c.sites || []) out.push(Object.assign({}, s, { clientId: c.id, clientName: c.name }));
  return out;
}
// No client picked: search every site (picking one sets the client).
// Client picked: its recent + register sites first; while typing, other clients' matching sites follow.
function siteOptions(q) {
  if (!state.contactId) return allSites();
  const me = currentClient(), sites = me?.sites || [];
  const tag = s => Object.assign({}, s, { clientId: state.contactId, clientName: me?.name || '' });
  const recent = (store.get(KEY.sites, {})[state.contactId] || []).map(r => {
    const id = (r.match(/\(([^()]+)\)$/) || [])[1] || '';
    const s = sites.find(x => x.loc === id || x.id === id); // old recents end in (P-xxxx), new ones in (AFS-xxxx)
    return s ? Object.assign(tag(s), { recent: true }) : Object.assign(tag({ id: '', name: r, search: r }), { recent: true });
  });
  const own = recent.filter((r, i) => !r.id || recent.findIndex(x => x.id === r.id) === i)
    .concat(sites.filter(s => !recent.some(r => r.id && r.id === s.id)).map(tag));
  if (!String(q || '').trim()) return own;
  return own.concat(allSites().filter(s => s.clientId !== state.contactId).map(s => Object.assign(s, { other: true })));
}

makeCombo({
  input: 'contactSearch', list: 'contactList', clear: 'contactClear',
  items: () => state.lookups?.contacts || [],
  text: c => c.name + ' ' + (c.registerId || '') + ' ' + (c.email || '') + ' ' + (c.sites || []).map(s => s.search).join(' '),
  boost: c => fuzzyScore(norm($('contactSearch').value).split(' ').filter(Boolean), norm(c.name)) >= 0 ? 500 : 0,
  row: (c, q) => {
    const w = norm(q).split(' ').filter(Boolean);
    let via = '';
    if (w.length && fuzzyScore(w, norm(c.name)) < 0) {
      const s = (c.sites || []).find(x => fuzzyScore(w, norm(x.search)) >= 0);
      if (s) via = ' · site: ' + highlight(s.name, q);
    }
    return `${highlight(c.name, q)}<div class="sub">${c.sites?.length ? plural(c.sites.length, 'site') : 'no register sites'}${via}${c.id === state.contactId ? ' · selected' : ''}</div>`;
  },
  empty: (q, all) => all.length ? `No client matches "${q}"` : 'Clients not loaded yet',
  onType: () => { if (state.contactId) setClient(''); },
  pick: c => { $('contactSearch').value = c.name; setClient(c.id); }
});

makeCombo({
  input: 'site', list: 'siteList', clear: 'siteClear',
  items: siteOptions,
  text: s => (s.search || s.name) + ' ' + (s.clientName || ''),
  boost: s => s.other ? 0 : 1000,
  row: (s, q) => `${highlight(s.name, q)}<div class="sub">${esc(s.loc || (s.id ? '' : 'typed address'))}${s.annual ? ' · yearly ' + esc(s.annual) : ''}${(!state.contactId || s.other) && s.clientName ? ' · ' + (s.other ? 'other client: ' : '') + highlight(s.clientName, q) : ''}${s.recent ? ' · recent' : ''}</div>`,
  head: q => (q.trim() && !state.siteId ? `<div class="opt opt-free" data-free="1">Use “${esc(q.trim())}” as the site (this job only)</div>` : '')
    + `<div class="opt opt-add" data-add="1">+ Add new site to the register</div>`,
  empty: (q, all) => !all.length ? (state.contactId ? 'No register sites for this client — type the address' : 'Sites not loaded yet')
    : 'No matching site — what you type will be used',
  onType: () => { state.siteId = ''; state.locId = ''; validate(); },
  pick: s => {
    if (s.clientId && s.clientId !== state.contactId) { // a register site sets (or switches) the client
      $('contactSearch').value = s.clientName; setClient(s.clientId); toast('Client: ' + s.clientName);
    }
    $('site').value = siteLabel(s); state.siteId = s.id || ''; state.locId = s.loc || ''; syncCombos(); validate();
  },
  onAdd: q => openAddSite(q)
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
  $('siteHint').textContent = state.siteId ? ''
    : !state.contactId ? 'Or search all sites here — picking a site fills in the client.'
    : n ? `${plural(n, 'site')} for this client — tap to pick or search (other clients' sites show too).` : 'No register sites for this client — type the address, or search all sites.';
  [['contactSearch', 'contactClear'], ['site', 'siteClear'], ['itemSearch', 'itemClear']].forEach(([i, x]) => { $(x).hidden = !$(i).value; });
  for (const cb of combos) if (cb.open) cb.show();
}

// Quick items: the common items set on the admin page (admin.html), as tap tiles. Tap = +1, − = take one off.
function quickList() {
  const items = state.lookups?.items || [];
  return (state.lookups?.quickItems || []).filter(q => !q.missing)
    .map(q => Object.assign({}, q, { item: items.find(i => i.code === q.itemCode) })).filter(q => q.item);
}
function renderQuick() {
  const q = quickList();
  $('quickWrap').hidden = !q.length;
  if (!q.length) return;
  const open = store.get(KEY.quickOpen, true);
  const total = q.reduce((n, x) => n + (state.qty[x.itemCode] || 0), 0);
  $('quickGrid').hidden = !open;
  $('quickToggle').innerHTML = `⚡ Quick items${total ? ` <b class="badge">${total}</b>` : ''} <span class="chev">${open ? '▴' : '▾'}</span>`;
  $('quickGrid').innerHTML = q.map(x => {
    const n = state.qty[x.itemCode] || 0;
    return `<div class="qt${n ? ' on' : ''}" data-qadd="${esc(x.itemCode)}"><div class="qt-label">${esc(x.label)}</div>
      <div class="qt-foot"><span class="qt-price">${money(+x.item.price)}</span>${n ? `<button class="qt-dec" data-qdec="${esc(x.itemCode)}" aria-label="One less">−</button><b class="qt-n">${n}</b>` : ''}</div></div>`;
  }).join('');
}

// Items on this job (pick more from the box above).
function renderItems() {
  const picked = (state.lookups?.items || []).filter(it => state.qty[it.code] > 0);
  $('items').innerHTML = picked.map(it => `<div class="item"><div class="nm">${esc(it.name)}<div class="pr">${money(+it.price)} ex GST</div></div>
      <div class="qty"><button class="secondary" data-dec="${esc(it.code)}">−</button><span>${state.qty[it.code]}</span>
      <button data-inc="${esc(it.code)}">+</button></div></div>`).join('')
    || '<div class="hint">Tap the box above to pick items — type to search.</div>';
  renderQuick();
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
  $('quoteBox').hidden = !$('wantQuote').checked;
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
    : state.sample ? label + ' (sample — not sent)'
    : (QUEUE_OK && !navigator.onLine) ? 'No signal — save job, send later' : label;
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

/* ---------- add a new site (register + report site list) ---------- */
// Server gives it an AFS number: same street address as a site on file = joins that site (one site, many clients).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function openAddSite(q) {
  const c = currentClient();
  $('asClient').textContent = c ? c.name : 'Pick the client first (step 1), then add the site.';
  $('asClient').classList.toggle('warn', !c);
  const typed = String(q || '').replace(/\s*\((AFS|P)-[^)]*\)\s*$/, '').trim();
  $('asAddress').value = /^\d/.test(typed) ? typed : '';
  $('asName').value = /^\d/.test(typed) ? '' : typed;
  $('asSuburb').value = ''; $('asPostcode').value = ''; $('asMonth').value = '';
  $('asSave').disabled = !c;
  $('addSite').classList.add('open');
  log('addSite', 'open', { client: c?.name, typed });
  setTimeout(() => (c ? ($('asAddress').value ? $('asSuburb') : $('asAddress')) : $('contactSearch')).focus(), 250);
}
async function saveAddSite() {
  const c = currentClient();
  if (!c) { toast('Pick the client first'); return; }
  const site = { address: $('asAddress').value.trim(), suburb: $('asSuburb').value.trim(), postcode: $('asPostcode').value.trim(), name: $('asName').value.trim(), month: $('asMonth').value };
  if (!/^\d/.test(site.address)) { toast('Street address should start with the number, e.g. 10 Essex St'); $('asAddress').focus(); return; }
  if (!site.suburb) { toast('Add the suburb'); $('asSuburb').focus(); return; }
  log('addSite', 'save', { client: c.name, site });
  if (state.sample) {
    const s = { id: 'NEW-' + Date.now(), loc: 'AFS-NEW', annual: site.month, name: site.name || site.address + ', ' + site.suburb };
    s.search = [s.loc, s.name, site.address, site.suburb].join(' ').toLowerCase();
    (c.sites = c.sites || []).push(s); $('addSite').classList.remove('open');
    pickNewSite(s); toast('Sample mode: site added on this phone only'); return;
  }
  if (navigator.onLine === false) { toast('Adding a site needs signal — use “Use … as the site” for now', 4500); return; }
  busy(true, 'Adding site…');
  try {
    const body = await postJob({ action: 'addSite', site, contact: { id: c.id, name: c.name, registerId: c.registerId || '' } });
    $('addSite').classList.remove('open');
    await loadLookups(true, true);
    const s = (currentClient()?.sites || []).find(x => x.id === body.site?.id) || Object.assign({ search: '' }, body.site);
    pickNewSite(s);
    toast((body.message || 'Site added') + (body.warning ? ' — ' + body.warning : ''), body.warning ? 7000 : 4500);
  } catch (e) {
    log('addSite', 'failed', e.message);
    toast('Site not added — ' + (e.network ? 'no signal' : e.message), 6000);
  } finally { busy(false); }
}
function pickNewSite(s) {
  $('site').value = siteLabel(s); state.siteId = s.id || ''; state.locId = s.loc || '';
  syncCombos(); validate();
}

/* ---------- quote items + tidy with an AI model (via n8n) ---------- */
// One box per quote item (talk each one in). Each item = one no-price line on the Xero draft quote.
// Tidy: pick Haiku / Kimi / ChatGPT (whichever has credits). If it fails, the others are tried in turn.
const TIDY = { haiku: 'Haiku', kimi: 'Kimi', chatgpt: 'ChatGPT' };
const KEY_TIDY = 'pi.tidyModel';
let quoteItems = [''];
let tidyPrev = null; // snapshot of the items before the last tidy (for Undo)
function tidyModel() { const m = store.get(KEY_TIDY, 'haiku'); return TIDY[m] ? m : 'haiku'; }
document.querySelectorAll('input[name=tidyModel]').forEach(r => {
  r.checked = r.value === tidyModel();
  r.addEventListener('change', () => { if (r.checked) { store.set(KEY_TIDY, r.value); log('tidy', 'model set', r.value); } });
});
const quoteText = () => quoteItems.map(s => String(s || '').trim()).filter(Boolean).join('\n').slice(0, 2000);
function renderQuoteItems(focus) {
  $('quoteItems').innerHTML = quoteItems.map((v, i) => `<div class="qi">
    <span class="qi-n">${i + 1}</span>
    <textarea rows="2" maxlength="600" data-qi="${i}" placeholder="${i ? 'Next item…' : 'What’s the quote for? Tap the keyboard mic and talk'}">${esc(v)}</textarea>
    <div class="qi-btns"><button class="secondary" type="button" data-qtidy="${i}" aria-label="Tidy this item">✨</button>${quoteItems.length > 1 ? `<button class="secondary" type="button" data-qdel="${i}" aria-label="Remove this item">✕</button>` : ''}</div>
  </div>`).join('');
  if (focus !== undefined) { const t = $('quoteItems').querySelector(`[data-qi="${focus}"]`); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
}
$('quoteItems').addEventListener('input', e => { const i = e.target.dataset.qi; if (i !== undefined) quoteItems[+i] = e.target.value; });
$('quoteItems').addEventListener('click', e => {
  const d = e.target.closest('[data-qdel]'); const t = e.target.closest('[data-qtidy]');
  if (d) { quoteItems.splice(+d.dataset.qdel, 1); if (!quoteItems.length) quoteItems = ['']; renderQuoteItems(); }
  if (t) tidyItems(+t.dataset.qtidy);
});
$('quoteAdd').onclick = () => {
  if (quoteItems.length && !String(quoteItems[quoteItems.length - 1]).trim()) { renderQuoteItems(quoteItems.length - 1); return; } // reuse the empty last box
  quoteItems.push(''); renderQuoteItems(quoteItems.length - 1); log('quote', 'item added', quoteItems.length);
};
function resetQuoteItems() { quoteItems = ['']; tidyPrev = null; $('tidyUndo').hidden = true; renderQuoteItems(); }

// which = index of one item, or undefined for all. Tidied lines replace that item (or all items); extra lines become new items.
async function tidyItems(which) {
  const idx = which === undefined ? quoteItems.map((_, i) => i) : [which];
  const text = idx.map(i => String(quoteItems[i] || '').trim()).filter(Boolean).join('\n');
  if (!text) { toast('Say or type the item first'); renderQuoteItems(which === undefined ? 0 : which); return; }
  if (state.sample) { toast('Sample mode — tidy is not sent anywhere'); return; }
  if (navigator.onLine === false) { toast('Tidy needs signal — what you said will be used as it is'); return; }
  const first = tidyModel();
  const order = [first].concat(Object.keys(TIDY).filter(m => m !== first));
  const failed = [];
  try {
    for (const model of order) {
      busy(true, `Tidying with ${TIDY[model]}…`);
      try {
        const body = await postJob({ action: 'tidyNote', model, text });
        const lines = String(body.text || '').split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) throw new Error('nothing came back');
        tidyPrev = quoteItems.slice(); $('tidyUndo').hidden = false;
        if (which === undefined) quoteItems = lines;
        else quoteItems.splice(which, 1, ...lines);
        renderQuoteItems();
        log('tidy', 'done', { model, which, lines: lines.length, failed });
        toast(failed.length ? `${failed.join(', ')} didn't answer — tidied with ${TIDY[model]}` : `Tidied with ${TIDY[model]} — check it, edit if needed`, failed.length ? 5000 : 3000);
        return;
      } catch (e) {
        log('tidy', 'model failed', { model, error: e.message });
        if (e.network) { toast('No signal — try Tidy again when you have signal'); return; }
        failed.push(TIDY[model]);
      }
    }
    toast('None of the models could tidy it (credits?) — what you said will be used as it is', 6000);
  } finally { busy(false); }
}
$('tidyBtn').onclick = () => tidyItems();
$('tidyUndo').onclick = () => { if (!tidyPrev) return; quoteItems = tidyPrev; tidyPrev = null; $('tidyUndo').hidden = true; renderQuoteItems(); };
renderQuoteItems();

/* ---------- submit ---------- */
const blobToDataUrl = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

/* ---------- job register (Jobs screen) ---------- */
// Server side: n8n data table 'Test Invoice Jobs' (submitted -> processed / attention), listed with action=listJobs.
// Phone side: jobs still in the offline queue show as 'In queue'. Last list is kept for viewing offline.
const JOB_STATUS = { queued: ['In queue', 'q'], submitted: ['Submitted', 's'], processed: ['Processed', 'p'], attention: ['Needs attention', 'a'] };
let jobsFilter = 'all';
async function openJobs() {
  $('jobsSheet').classList.add('open');
  await renderJobs(store.get(KEY.jobs, []));
  refreshJobs();
}
async function refreshJobs() {
  if (state.sample) { $('jobsNote').textContent = 'Sample mode — no register'; return; }
  const s = settings();
  $('jobsRefresh').classList.add('spin'); $('jobsNote').textContent = 'Updating…';
  try {
    const r = await fetch(s.url.replace(/\/$/, '') + '/photo-invoice-submit', {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ key: s.key || '', action: 'listJobs' })
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok) throw new Error(body.error || 'HTTP ' + r.status);
    store.set(KEY.jobs, body.jobs || []);
    log('jobs', 'loaded', { count: (body.jobs || []).length });
    await renderJobs(body.jobs || []);
    $('jobsNote').textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    log('jobs', 'load failed', e.message);
    $('jobsNote').textContent = 'No signal — showing the last saved list';
  } finally { $('jobsRefresh').classList.remove('spin'); }
}
const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
async function renderJobs(server) {
  const queued = QUEUE_OK ? await Q.all().catch(() => []) : [];
  const ids = new Set(server.map(j => j.jobId));
  const local = queued.filter(q => !ids.has(q.id)).map(q => ({
    jobId: q.id, status: q.status === 'failed' ? 'attention' : 'queued', client: q.label.client, site: q.label.site,
    mode: q.payload.mode, result: q.payload.result, quote: q.payload.quote, photos: q.payload.photos.length,
    note: q.status === 'failed' ? 'Not accepted: ' + q.error : 'On this phone — sends when there’s signal', createdAt: new Date(q.createdAt).toISOString(), local: true
  }));
  const all = local.concat(server);
  // A job still 'submitted' after 15 minutes has probably stopped part way - flag it.
  for (const j of all) if (j.status === 'submitted' && Date.now() - new Date(j.createdAt) > 15 * 60000) { j.status = 'attention'; j.note = j.note || 'Still marked as submitted after 15 min — check n8n / Xero'; }
  const count = (s) => all.filter(j => s === 'all' || j.status === s).length;
  $('jobsFilter').innerHTML = [['all', 'All'], ['queued', 'In queue'], ['submitted', 'Submitted'], ['processed', 'Processed'], ['attention', 'Needs attention']]
    .filter(([f]) => f === 'all' || count(f)).map(([f, label]) => `<button class="chip${jobsFilter === f ? ' on' : ''}" data-f="${f}">${label} ${count(f)}</button>`).join('');
  const list = all.filter(j => jobsFilter === 'all' || j.status === jobsFilter);
  $('jobsList').innerHTML = list.map(j => {
    const [label, cls] = JOB_STATUS[j.status] || [j.status, 's'];
    const bits = [j.result === 'fail' ? '<span class="fail">Fail</span>' : 'Pass', j.mode === 'email' ? 'email only' : 'invoice + email'];
    if (j.invoiceNumber) bits.push(esc(j.invoiceNumber));
    if (j.quoteNumber) bits.push('quote ' + esc(j.quoteNumber)); else if (j.quote) bits.push('quote requested');
    const xero = j.invoiceId ? `<a href="https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${encodeURIComponent(j.invoiceId)}" target="_blank" rel="noopener">Open ${esc(j.invoiceNumber || 'invoice')} in Xero</a>` : '';
    const drive = j.driveUrl ? `<a href="${esc(j.driveUrl)}" target="_blank" rel="noopener">📁 Open job folder in Drive</a>` : '';
    const driveNote = j.driveStatus && j.driveStatus !== 'filed' ? `<span class="${j.driveUrl ? 'mute' : 'fail'}">Drive: ${esc(j.driveStatus)}</span>` : '';
    if (j.driveUrl) bits.push('📁');
    return `<div class="job"><div class="job-top"><span class="st st-${cls}">${label}</span><span class="when">${when(j.createdAt)}</span></div>
      <div class="job-main"><b>${esc(j.client)}</b> — ${esc(j.site)}</div>
      <div class="sub">${bits.join(' · ')}</div>
      ${j.note ? `<div class="job-note">${esc(j.note)}</div>` : ''}
      <div class="job-more">${j.sentTo ? `Emailed to ${esc(j.sentTo)}<br>` : ''}${j.photos ? `${j.photos} photo${j.photos === 1 ? '' : 's'}<br>` : ''}${j.updatedAt && j.updatedAt !== j.createdAt ? `Last update ${when(j.updatedAt)}<br>` : ''}<span class="mute">Job ${esc(String(j.jobId).slice(0, 8))}</span>${xero ? '<br>' + xero : ''}${drive ? '<br>' + drive : ''}${driveNote ? '<br>' + driveNote : ''}</div></div>`;
  }).join('') || `<div class="hint" style="padding:16px">${all.length ? 'Nothing in this filter.' : 'No jobs yet — they appear here once sent.'}</div>`;
}

/* ---------- sending + offline queue ---------- */
// Jobs that can't be sent (no signal, or the send drops/times out) are saved on the phone in IndexedDB
// and sent automatically when there's signal again. Each job keeps its own ID, so if a send actually got
// through before the connection dropped, n8n recognises the resend and doesn't email/invoice twice.
const QUEUE_OK = CAN_SAVE && 'indexedDB' in self;
const SEND_TIMEOUT_MS = 120000;
const Q = (() => {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('test-invoice', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('queue', mode); const req = fn(t.objectStore('queue'));
      t.oncomplete = () => res(req.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return { put: j => run('readwrite', s => s.put(j)), del: id => run('readwrite', s => s.delete(id)), all: () => run('readonly', s => s.getAll()) };
})();
if (QUEUE_OK && navigator.storage?.persist) navigator.storage.persist().then(p => log('queue', 'persistent storage', p)).catch(() => {});

// One POST to n8n. Throws with e.network = true when it never got a proper answer (no signal, dropped, timed out).
async function postJob(payload) {
  const s = settings();
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  try {
    // text/plain + key in body = simple CORS request, no preflight. n8n parses the JSON.
    const r = await fetch(s.url.replace(/\/$/, '') + '/photo-invoice-submit', {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ key: s.key || '', ...payload }), signal: ctl.signal
    });
    const body = await r.json().catch(() => ({}));
    log('postJob', 'response', { id: payload.submissionId, status: r.status, body });
    if (!r.ok || body.ok === false) { const e = new Error(body.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
    return body;
  } catch (e) {
    if (e.status === undefined) { e.network = true; if (e.name === 'AbortError') e.message = 'no reply (timed out)'; }
    throw e;
  } finally { clearTimeout(timer); }
}

function sentMessage(body) {
  if (body.duplicate) return `Already sent earlier (${body.invoiceNumber}) - not sent again`;
  const parts = [];
  if (body.invoiceNumber) parts.push(`Draft ${body.invoiceNumber} in Xero`);
  if (body.sentTo) parts.push(`emailed to ${body.sentTo}`);
  if (body.quotePending) parts.push('quote being created in Xero');
  const msg = parts.join(' · ') + ' ✓';
  return body.warning ? msg + ' — ' + body.warning : msg;
}

async function submit() {
  const contactId = state.contactId, site = $('site').value.trim();
  const contact = currentClient();
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
      site, siteId: state.siteId, locationId: state.locId, reference: site,
      lineAmountTypes: 'Exclusive',
      mode: emailMode() ? 'email' : 'xero',
      clientEmail: $('clientEmail').value.trim(),
      result: state.result,
      quote: $('wantQuote').checked,
      quoteNote: $('wantQuote').checked ? quoteText() : '',
      lines: emailMode() ? [] : lines(),
      photos
    };
    const kb = Math.round(JSON.stringify(payload).length / 1024);
    log('submit', 'payload built', { ...payload, photos: photos.map(p => p.filename), kb });

    saveClientPrefs();
    if (state.sample) { toast(`Sample mode: ${payload.mode === 'email' ? 'email' : 'invoice'} built (${photos.length} photos, ${kb} KB) — not sent`, 4000); return; }

    if (QUEUE_OK && !navigator.onLine) { await queueJob(payload); return; }
    busy(true, 'Sending…');
    try {
      const body = await postJob(payload);
      rememberSite(contactId, site);
      resetJob();
      toast(sentMessage(body), 5000);
    } catch (e) {
      if (e.network && QUEUE_OK) { log('submit', 'no signal, queueing', e.message); await queueJob(payload); return; }
      throw e;
    }
  } catch (e) {
    log('submit', 'failed', e.message);
    toast('Not sent — ' + e.message + '. Your job is still here, try again.', 6000);
  } finally { busy(false); }
}

async function queueJob(payload) {
  const job = {
    id: payload.submissionId, createdAt: Date.now(), attempts: 0, status: 'waiting', error: '', payload,
    label: { client: payload.contact.name || '', site: payload.site, what: (payload.mode === 'email' ? 'email only' : 'invoice + email') + ' · ' + (payload.result === 'fail' ? 'fail' : 'pass') + (payload.quote ? ' · quote' : '') }
  };
  await Q.put(job);
  rememberSite(payload.contact.id, payload.site);
  resetJob();
  const n = (await Q.all()).length;
  log('queue', 'job saved', { id: job.id, waiting: n });
  toast(`No signal — job saved on this phone and will send automatically (${n} waiting)`, 6000);
  renderQueue();
}

// Send waiting jobs oldest first. Stops at the first "still no signal"; server rejections are marked so they
// stop retrying and show in the list. manual = the Send now button (also retries jobs marked as failed).
let flushing = false;
async function flushQueue(manual = false) {
  if (!QUEUE_OK || flushing || state.sample) return;
  flushing = true;
  try {
    const jobs = (await Q.all()).filter(j => manual || j.status !== 'failed').sort((x, y) => x.createdAt - y.createdAt);
    if (!jobs.length) return;
    if (!navigator.onLine) { if (manual) toast('Still no signal — jobs will send when you have signal'); return; }
    log('queue', 'sending', { count: jobs.length, manual });
    $('queueText').textContent = `Sending ${jobs.length} waiting job${jobs.length === 1 ? '' : 's'}…`;
    for (const j of jobs) {
      try {
        const body = await postJob(j.payload);
        await Q.del(j.id);
        toast(`Sent: ${j.label.client} — ${j.label.site}. ${sentMessage(body)}`, 5000);
      } catch (e) {
        if (e.network) { log('queue', 'still no signal', e.message); if (manual) toast('Still no signal — will keep trying'); break; }
        j.attempts = (j.attempts || 0) + 1; j.error = e.message;
        if (e.status >= 500 && j.attempts < 5) { await Q.put(j); log('queue', 'server error, retry later', e.message); break; }
        j.status = 'failed'; await Q.put(j);
        toast(`Queued job not accepted (${j.label.site}): ${e.message}`, 7000);
      }
    }
  } catch (e) { log('queue', 'flush failed', e.message); }
  finally { flushing = false; renderQueue(); if ($('jobsSheet').classList.contains('open')) refreshJobs(); }
}

let qDelArm = '';
async function renderQueue() {
  if (!QUEUE_OK) return;
  const jobs = (await Q.all().catch(() => [])).sort((x, y) => x.createdAt - y.createdAt);
  $('queueBar').hidden = !jobs.length;
  if (!jobs.length) return;
  const failed = jobs.filter(j => j.status === 'failed').length;
  $('queueText').textContent = `📤 ${jobs.length} job${jobs.length === 1 ? '' : 's'} waiting to send` + (failed ? ` (${failed} need attention)` : '');
  $('queueBar').classList.toggle('bad', failed > 0);
  $('queueList').innerHTML = jobs.map(j => `<div class="qjob"><div class="qinfo"><b>${esc(j.label.client)}</b> — ${esc(j.label.site)}
    <div class="sub">${new Date(j.createdAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · ${esc(j.label.what)} · ${j.payload.photos.length} photo${j.payload.photos.length === 1 ? '' : 's'}${j.status === 'failed' ? ` · <span class="err">${esc(j.error)}</span>` : ''}</div></div>
    <button class="secondary qdel" data-qdel="${esc(j.id)}">${qDelArm === j.id ? 'Tap again' : 'Delete'}</button></div>`).join('');
}

function rememberSite(contactId, site) {
  const all = store.get(KEY.sites, {});
  all[contactId] = [site, ...(all[contactId] || []).filter(s => s !== site)].slice(0, 8);
  store.set(KEY.sites, all);
}

function resetJob() {
  state.photos.forEach(p => URL.revokeObjectURL(p.url));
  state.photos = []; state.qty = {}; state.result = ''; state.jobId = newJobId();
  $('site').value = ''; state.siteId = ''; state.locId = '';
  $('wantQuote').checked = false; resetQuoteItems();
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
$('wantQuote').addEventListener('change', () => { log('quote', 'set', $('wantQuote').checked); renderMode(); if ($('wantQuote').checked) renderQuoteItems(0); });
$('quickToggle').addEventListener('click', () => { store.set(KEY.quickOpen, !store.get(KEY.quickOpen, true)); renderQuick(); });
$('quickGrid').addEventListener('click', e => {
  const dec = e.target.closest('[data-qdec]'), tile = e.target.closest('[data-qadd]');
  if (dec) { const c = dec.dataset.qdec; state.qty[c] = Math.max(0, (state.qty[c] || 0) - 1); }
  else if (tile) { const c = tile.dataset.qadd; state.qty[c] = (state.qty[c] || 0) + 1; }
  else return;
  log('quick', dec ? 'minus' : 'plus', { code: (dec || tile).dataset.qdec || (dec || tile).dataset.qadd });
  renderItems(); validate();
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
$('jobsBtn').onclick = openJobs;
$('jobsClose').onclick = () => $('jobsSheet').classList.remove('open');
$('jobsRefresh').onclick = refreshJobs;
$('jobsFilter').addEventListener('click', e => { const f = e.target.dataset.f; if (!f) return; jobsFilter = f; renderJobs(store.get(KEY.jobs, [])); });
$('jobsList').addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const j = e.target.closest('.job'); if (j) j.classList.toggle('open');
});
$('resetBtn').onclick = newJob;
$('syncBtn').onclick = syncNow;
$('settingsBtn').onclick = () => { const s = settings(); $('setUrl').value = s.url; $('setKey').value = s.key; $('settings').classList.add('open'); };
$('setClose').onclick = () => $('settings').classList.remove('open');
$('setSave').onclick = () => {
  store.set(KEY.settings, { url: $('setUrl').value.trim(), key: $('setKey').value.trim() });
  $('settings').classList.remove('open'); state.qty = {}; loadLookups(true);
};
$('asCancel').onclick = () => $('addSite').classList.remove('open');
$('asSave').onclick = saveAddSite;
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

$('queueSend').onclick = () => flushQueue(true);
$('queueToggle').onclick = () => { const l = $('queueList'); l.hidden = !l.hidden; $('queueToggle').textContent = l.hidden ? 'Show' : 'Hide'; };
$('queueList').addEventListener('click', async e => {
  const id = e.target.dataset.qdel; if (!id) return;
  if (qDelArm !== id) { qDelArm = id; renderQueue(); setTimeout(() => { if (qDelArm === id) { qDelArm = ''; renderQueue(); } }, 3000); return; }
  qDelArm = ''; await Q.del(id); log('queue', 'deleted', id); toast('Queued job deleted'); renderQueue();
});
addEventListener('online', () => { log('net', 'online'); validate(); flushQueue(); });
addEventListener('offline', () => { log('net', 'offline'); validate(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flushQueue(); });
setInterval(() => flushQueue(), 60000);

log('app', 'start', { ...BUILD, queue: QUEUE_OK });
loadLookups();
renderQueue().then(() => flushQueue());
