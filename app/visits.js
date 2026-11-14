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

const st = { year: new Date().getFullYear(), data: null, filter: 'all', q: '', client: '' };
$('ver').textContent = BUILD.version;

async function load() {
  if (!key()) { $('keyCard').hidden = false; $('main').hidden = true; return; }
  $('keyCard').hidden = true; $('main').hidden = false;
  $('yLabel').textContent = st.year;
  $('grid').className = 'msg'; $('grid').textContent = 'Loading ' + st.year + '…';
  try {
    st.data = await V.fetchCalendar(api(), key(), { year: st.year });
    const clients = [...new Set(st.data.sites.flatMap(s => s.clients.map(c => c.split(' / ')[0].replace(/\s*\(via .*\)$/, ''))))].sort();
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
    if (st.client && !s.clients.some(c => c.startsWith(st.client))) return false;
    if (words.length) { const t = [s.name, s.address, s.suburb, s.loc, ...s.clients].join(' ').toLowerCase(); if (!words.every(w => t.includes(w))) return false; }
    const inYear = now >= 0 && now <= 11;
    switch (st.filter) {
      case 'due': return inYear && V.statusOf(s, now, meta) === 'due';
      case 'yearly': return inYear && V.typeOf(s, now) === 'Y';
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
    let done = 0, due = 0, y = 0;
    let none = 0;
    for (const s of d.sites) { const x = V.statusOf(s, meta.now, meta); if (x === 'done') done++; if (x === 'due') due++; if (x === 'none') none++; if (V.typeOf(s, meta.now) === 'Y') y++; }
    $('summary').textContent = `${V.MON[meta.now]} ${meta.year}: ${done} done · ${due} still due · ${y} yearly · ${none} with no visit this month · ${d.sites.length} active sites` + (d.unmatched ? ` · ${d.unmatched} record(s) couldn't be matched to a site` : '');
  } else $('summary').textContent = `${d.sites.length} active sites` + (meta.now === 12 ? ' · past year' : ' · future year');
  if (!rows.length) { $('grid').className = 'msg'; $('grid').textContent = 'No sites match.'; return; }
  const head = '<thead><tr><th class="site">Site (' + rows.length + ')</th>' + V.MON.map((mn, m) => `<th class="${m === meta.now ? 'now' : ''}">${mn}</th>`).join('') + '</tr></thead>';
  const body = rows.map(s => '<tr><td class="site"><div class="n">' + V.esc(s.name) + '</div><div class="s">' + V.esc(s.loc) + ' · ' + V.esc(s.pattern || 'M 6 Y') + ' · ' + V.esc(s.clients.map(c => c.split(' / ')[0]).join(', ') || 'no client') + (s.annual < 0 ? ' · <b style="color:#b45309">no yearly month</b>' : '') + '</div></td>'
    + V.MON.map((mn, m) => { const t = V.typeOf(s, m), x = V.statusOf(s, m, meta); const n = s.visits.filter(v => v.m === m).length;
      return `<td class="m${m === meta.now ? ' now' : ''}"><div class="c st-${x}" data-loc="${V.esc(s.loc)}" data-m="${m}" title="${mn}: ${t ? V.TYPE[t] : 'no visit'} — ${V.STATUS[x]}${n ? ' (' + n + ')' : ''}">${t === '?' ? 'M' : t || '·'}</div></td>`; }).join('')
    + '</tr>').join('');
  $('grid').className = ''; $('grid').innerHTML = '<table>' + head + '<tbody>' + body + '</tbody></table>';
}

function openPanel(loc, m) {
  const s = st.data.sites.find(x => x.loc === loc); if (!s) return;
  $('panelBody').innerHTML = V.detailsHtml(s, m, st.data.meta);
  $('panel').classList.add('open');
  log('panel', 'open', { loc, month: V.MON[m] });
}

$('grid').addEventListener('click', e => { const c = e.target.closest('.c[data-loc]'); if (c) openPanel(c.dataset.loc, +c.dataset.m); });
$('panelClose').onclick = () => $('panel').classList.remove('open');
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('panel').classList.remove('open'); });
$('q').addEventListener('input', () => { st.q = $('q').value; if (st.data) render(); });
$('client').addEventListener('change', () => { st.client = $('client').value; render(); });
$('chips').addEventListener('click', e => { const f = e.target.dataset.f; if (!f) return; st.filter = f; document.querySelectorAll('#chips button').forEach(b => b.classList.toggle('on', b.dataset.f === f)); render(); });
$('yPrev').onclick = () => { st.year--; load(); };
$('yNext').onclick = () => { st.year++; load(); };
$('reload').onclick = load;
$('keySave').onclick = () => { const k = $('keyInput').value.trim(); if (!k) return; try { localStorage.setItem('pi.adminKey', k); } catch {} load(); };
load();
