'use strict';
/* Test Invoice admin page (desktop). Edits settings that live in n8n (workflow "Test Invoice PWA API v1.0"):
   - Quick items: GET  photo-invoice-lookups?key=ADMIN  -> items + quickItems
                  POST photo-invoice-submit {key: ADMIN, action: 'saveQuickItems', quickItems: [{label, itemCode}]}
   The admin key is separate from the phone app key, so phones can't change settings. */

const BUILD = self.BUILD_INFO || { version: 'dev' };
const API = (BUILD.apiBase || location.origin + '/webhook').replace(/\/$/, '');
const KEY_STORE = 'pi.adminKey';
const MAX_ITEMS = 40;
const $ = (id) => document.getElementById(id);
const log = (where, msg, data) => console.log(`[admin:${where}] ${msg}`, data ?? '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toFixed(2);

const st = { key: '', items: [], byCode: {}, rows: [], dirty: false, saving: false };

function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } }
function setKey(k) { try { localStorage.setItem(KEY_STORE, k); } catch {} st.key = k; }

// #key=adm_... in the link: save it and tidy the address bar.
(function keyFromLink() {
  const k = new URLSearchParams(location.hash.slice(1)).get('key');
  if (k) { setKey(k); history.replaceState(null, '', location.pathname); log('key', 'saved from link'); }
})();

function status(text, cls = '') { const s = $('status'); s.textContent = text; s.className = 'status ' + cls; }
const optionValue = (it) => `${it.code} — ${it.name} (${money(it.price)})`;
function codeFromInput(v) {
  v = String(v || '').trim();
  if (st.byCode[v]) return v;                                   // typed a bare code
  const hit = st.items.find(it => optionValue(it) === v);        // picked from the list
  if (hit) return hit.code;
  const pre = v.split(' — ')[0];                                 // "CODE — ..." edited a bit
  return st.byCode[pre] ? pre : '';
}

async function load() {
  status('Loading…');
  try {
    const r = await fetch(`${API}/photo-invoice-lookups?key=${encodeURIComponent(st.key)}`);
    if (r.status === 401) { setKey(''); showKey('That key was not accepted — check it and try again.'); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    st.items = (data.items || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    st.byCode = Object.fromEntries(st.items.map(it => [it.code, it]));
    st.rows = (data.quickItems || []).map(q => ({ label: q.label, code: q.itemCode, text: st.byCode[q.itemCode] ? optionValue(st.byCode[q.itemCode]) : q.itemCode }));
    $('xeroItems').innerHTML = st.items.map(it => `<option value="${esc(optionValue(it))}"></option>`).join('');
    log('load', 'ok', { items: st.items.length, quickItems: st.rows.length, updated: data.quickItemsUpdated });
    $('keyCard').hidden = true; $('main').hidden = false;
    st.dirty = false; render();
    status(data.quickItemsUpdated ? 'Last saved ' + new Date(data.quickItemsUpdated).toLocaleString('en-AU') : 'Nothing saved yet');
  } catch (e) {
    log('load', 'failed', e.message);
    status('Could not load: ' + e.message, 'err');
  }
}

function render() {
  $('rows').innerHTML = st.rows.map((r, i) => {
    const it = st.byCode[r.code];
    const missing = r.text && !it;
    return `<tr data-i="${i}">
      <td class="num">${i + 1}</td>
      <td><input type="text" data-f="label" maxlength="30" placeholder="e.g. Alarm test" value="${esc(r.label)}" class="${r.label.trim() ? '' : 'bad'}"></td>
      <td><input type="text" data-f="item" list="xeroItems" placeholder="Search Xero items…" value="${esc(r.text)}" class="${it ? '' : 'bad'}">
        ${missing ? '<div class="warn">Not a current Xero item — pick one from the list</div>' : ''}</td>
      <td class="price">${it ? money(it.price) : ''}</td>
      <td class="acts"><button class="icon" data-act="up" ${i ? '' : 'disabled'} title="Move up">↑</button>
        <button class="icon" data-act="down" ${i < st.rows.length - 1 ? '' : 'disabled'} title="Move down">↓</button>
        <button class="icon" data-act="del" title="Remove">✕</button></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="hint">No quick items yet — add your common ones.</td></tr>';
  $('addRow').disabled = st.rows.length >= MAX_ITEMS;
  renderPreview();
}

function renderPreview() {
  $('preview').innerHTML = st.rows.filter(r => r.label.trim() && st.byCode[r.code])
    .map(r => `<div class="qt"><b>${esc(r.label)}</b><span>${money(st.byCode[r.code].price)}</span></div>`).join('')
    || '<span class="hint">Tiles appear here as you add them.</span>';
}

function markDirty() { st.dirty = true; status('Unsaved changes', 'dirty'); }

$('rows').addEventListener('input', e => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const r = st.rows[+tr.dataset.i];
  if (e.target.dataset.f === 'label') { r.label = e.target.value; e.target.classList.toggle('bad', !r.label.trim()); }
  if (e.target.dataset.f === 'item') {
    r.text = e.target.value; r.code = codeFromInput(r.text);
    e.target.classList.toggle('bad', !r.code);
    tr.querySelector('.price').textContent = r.code ? money(st.byCode[r.code].price) : '';
    // picked from the list: show the tidy full value; suggest a tile name if empty
    if (r.code && r.text !== optionValue(st.byCode[r.code]) && st.items.some(it => optionValue(it) === r.text)) e.target.value = r.text = optionValue(st.byCode[r.code]);
    if (r.code && !r.label.trim()) { r.label = st.byCode[r.code].name.slice(0, 30); tr.querySelector('[data-f=label]').value = r.label; tr.querySelector('[data-f=label]').classList.remove('bad'); }
  }
  markDirty(); renderPreview();
});
$('rows').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const i = +b.closest('tr').dataset.i, act = b.dataset.act;
  if (act === 'up' && i > 0) [st.rows[i - 1], st.rows[i]] = [st.rows[i], st.rows[i - 1]];
  if (act === 'down' && i < st.rows.length - 1) [st.rows[i + 1], st.rows[i]] = [st.rows[i], st.rows[i + 1]];
  if (act === 'del') st.rows.splice(i, 1);
  markDirty(); render();
});
$('addRow').onclick = () => {
  if (st.rows.length >= MAX_ITEMS) return;
  st.rows.push({ label: '', code: '', text: '' }); markDirty(); render();
  const inputs = $('rows').querySelectorAll('tr:last-child input'); if (inputs[0]) inputs[0].focus();
};

$('save').onclick = async () => {
  const bad = st.rows.findIndex(r => !r.label.trim() || !st.byCode[r.code]);
  if (bad >= 0) { status(`Row ${bad + 1} needs a name and a Xero item from the list`, 'err'); return; }
  const quickItems = st.rows.map(r => ({ label: r.label.trim(), itemCode: r.code }));
  $('save').disabled = true; status('Saving…');
  try {
    const r = await fetch(`${API}/photo-invoice-submit`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ key: st.key, action: 'saveQuickItems', quickItems })
    });
    const body = await r.json().catch(() => ({}));
    log('save', 'response', { status: r.status, body });
    if (!r.ok || !body.ok) throw new Error(body.error || 'HTTP ' + r.status);
    st.dirty = false;
    status(`Saved ✓ ${body.quickItems.length} quick item${body.quickItems.length === 1 ? '' : 's'} — ${new Date(body.updated).toLocaleTimeString('en-AU')}`, 'ok');
  } catch (e) {
    status('Not saved — ' + e.message, 'err');
  } finally { $('save').disabled = false; }
};

addEventListener('beforeunload', e => { if (st.dirty) { e.preventDefault(); e.returnValue = ''; } });

function showKey(msg) {
  $('main').hidden = true; $('keyCard').hidden = false;
  if (msg) $('keyCard').querySelector('.lead').textContent = msg;
  $('keyInput').focus();
}
$('keySave').onclick = () => { const k = $('keyInput').value.trim(); if (k) { setKey(k); load(); } };
$('keyInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('keySave').click(); });

$('ver').textContent = BUILD.version;
st.key = getKey();
log('start', 'admin page', { version: BUILD.version, api: API, hasKey: !!st.key });
if (st.key) load(); else showKey();
