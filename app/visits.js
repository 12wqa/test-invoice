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

const st = { year: new Date().getFullYear(), data: null, filter: 'all', q: '', client: '', inactive: false };
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
  // summary for this month (current year only)
  if (meta.now >= 0 && meta.now <= 11) {
    let done = 0, due = 0, y = 0, six = 0, none = 0;
    const act = d.sites.filter(s => s.active !== false);   // counts are for active rows only
    for (const s of act) { const x = V.statusOf(s, meta.now, meta), t = V.typeOf(s, meta.now); if (x === 'done') done++; if (x === 'due') due++; if (x === 'none') none++; if (t === 'Y') y++; if (t === '6') six++; }
    $('summary').textContent = `${V.MON[meta.now]} ${meta.year}: ${done} done · ${due} still due · ${y} yearly · ${six} 6-monthly · ${none} with no visit this month · ${act.length} active site/client rows` + (d.sites.length > act.length ? ` (+${d.sites.length - act.length} inactive shown)` : '') + (d.unmatched ? ` · ${d.unmatched} record(s) couldn't be matched to a site` : '');
  } else $('summary').textContent = `${d.sites.filter(s => s.active !== false).length} active site/client rows` + (meta.now === 12 ? ' · past year' : ' · future year');
  if (!rows.length) { $('grid').className = 'msg'; $('grid').textContent = 'No sites match.'; return; }
  const head = '<thead><tr><th class="site">Site (' + rows.length + ')</th>' + V.MON.map((mn, m) => `<th class="${m === meta.now ? 'now' : ''}">${mn}</th>`).join('') + '</tr></thead>';
  const body = rows.map(s => '<tr' + (s.active === false ? ' class="off"' : '') + '><td class="site"><div class="n">' + V.esc(s.name) + '</div><div class="s">' + V.esc(s.loc) + ' · ' + V.esc(s.pattern || 'M 6 Y') + ' · ' + V.esc(s.client || 'no client') + (s.annual < 0 ? ' · <b style="color:#b45309">no yearly month</b>' : '') + '</div></td>'
    + V.MON.map((mn, m) => { const t = V.typeOf(s, m), x = V.statusOf(s, m, meta); const n = s.visits.filter(v => v.m === m).length;
      return `<td class="m${m === meta.now ? ' now' : ''}"><div class="c st-${x}" data-id="${V.esc(s.id)}" data-m="${m}" title="${mn}: ${t ? V.TYPE[t] : 'no visit'} — ${V.STATUS[x]}${n ? ' (' + n + ')' : ''}">${t === '?' ? 'M' : t || '·'}</div></td>`; }).join('')
    + '</tr>').join('');
  $('grid').className = ''; $('grid').innerHTML = '<table>' + head + '<tbody>' + body + '</tbody></table>';
}

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
$('showInactive').addEventListener('change', () => { st.inactive = $('showInactive').checked; load(); });
$('keySave').onclick = () => { const k = $('keyInput').value.trim(); if (!k) return; try { localStorage.setItem('pi.adminKey', k); } catch {} load(); };
load();
