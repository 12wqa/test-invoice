'use strict';
/* Visits calendar logic shared by the phone app (index.html) and the visits page (visits.html).
   Data: POST photo-invoice-submit {action:'calendar', key, year?, loc?} -> { meta, sites:[{loc,name,address,suburb,clients,annual,visits:[{m,...}]}] }
   Schedule rule: only the yearly (annual) month is stored. 6-monthly = annual + 6. Every other month = monthly.
   site.pattern (register 'Visits' column, e.g. 'M 6 Y', '6 Y', 'Y', 'M') says which of those the site gets:
   no Y -> the yearly month falls back to 6 (or M); no 6 -> that month falls back to M; no M -> other months have no visit ('').
   Status per month: done (a job or filed report that month) / due (this month) / missed (past, nothing) / upcoming / norec (before records began). */
(function () {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const TYPE = { Y: 'Yearly', '6': '6-monthly', M: 'Monthly', '?': 'Monthly' };
  const STATUS = { done: 'Done', due: 'Due this month', missed: 'Not recorded', upcoming: 'Coming up', norec: 'Before records started', none: 'No visit' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const has = (site, k) => String(site.pattern || 'M 6 Y').toUpperCase().includes(k);
  // '' = no visit scheduled that month
  function typeOf(site, m) {
    const a = site.annual;
    if (a == null || a < 0) return has(site, 'M') ? '?' : '';   // yearly month unknown: can only place monthlies
    if (m === a) return has(site, 'Y') ? 'Y' : has(site, '6') ? '6' : has(site, 'M') ? 'M' : '';
    if (m === (a + 6) % 12) return has(site, '6') ? '6' : has(site, 'M') ? 'M' : '';
    return has(site, 'M') ? 'M' : '';
  }
  function statusOf(site, m, meta) {
    if ((site.visits || []).some(v => v.m === m)) return 'done';
    if (!typeOf(site, m)) return 'none';
    const [ty, tm] = String(meta.trackFrom || '0-1').split('-').map(Number);
    const idx = meta.year * 12 + m;
    if (idx < ty * 12 + (tm - 1)) return 'norec';
    if (meta.now === 12) return 'missed';        // a past year
    if (meta.now === -1) return 'upcoming';      // a future year
    if (m === meta.now) return 'due';
    return m < meta.now ? 'missed' : 'upcoming';
  }
  const xeroInvoice = (id) => 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' + encodeURIComponent(id);

  // HTML for one month of one site (the "tap a month" panel).
  function detailsHtml(site, m, meta) {
    const t = typeOf(site, m), s = statusOf(site, m, meta);
    const vs = (site.visits || []).filter(v => v.m === m);
    let h = `<div class="vd-head"><div class="vd-title">${MON[m]} ${meta.year} · ${t ? TYPE[t] + ' visit' : 'No visit scheduled'}</div>
      <div class="vd-site">${esc(site.name)} <span class="vd-loc">${esc(site.loc)}</span></div>
      <span class="vchip st-${s}">${STATUS[s]}</span>${t === '?' ? ' <span class="vd-note">Yearly month not set in the register</span>' : ''}
      <div class="vd-sub">Visits at this site: ${esc(patternText(site))}</div></div>`;
    if (!vs.length) {
      h += `<p class="vd-empty">${s === 'norec' ? 'Records in this calendar start ' + MON[(Number(String(meta.trackFrom).split('-')[1]) || 1) - 1] + ' ' + String(meta.trackFrom).split('-')[0] + '. Older reports are in the site\'s Drive folder.'
        : s === 'none' ? 'This site has no visit in this month.' : s === 'upcoming' ? 'Nothing yet — this visit is coming up.' : 'No job or filed report for this month.'}</p>`;
    }
    for (const v of vs) {
      const links = [];
      if (v.fileUrl) links.push(`<a href="${esc(v.fileUrl)}" target="_blank" rel="noopener">📄 Open report</a>`);
      if (v.driveUrl) links.push(`<a href="${esc(v.driveUrl)}" target="_blank" rel="noopener">📁 ${v.src === 'app' ? 'Job folder (photos & reports)' : 'Site folder'}</a>`);
      if (v.invoiceId) links.push(`<a href="${xeroInvoice(v.invoiceId)}" target="_blank" rel="noopener">🧾 ${esc(v.invoiceNumber || 'Invoice')}</a>`);
      else if (v.invoiceNumber) links.push(`🧾 ${esc(v.invoiceNumber)}`);
      if (v.quoteNumber) links.push(`📝 Quote ${esc(v.quoteNumber)}`);
      h += `<div class="vd-visit">
        <div class="vd-line"><b>${esc(v.date)}</b> · ${v.src === 'app' ? 'Job from the app' : 'Report filed (' + esc(v.client) + ')'}
          ${v.result ? ` · <span class="${v.result === 'fail' ? 'vd-fail' : 'vd-pass'}">${v.result === 'fail' ? 'FAIL' : 'Pass'}</span>` : ''}</div>
        ${v.src === 'app' && v.client ? `<div class="vd-sub">${esc(v.client)}${v.sentTo ? ' · emailed ' + esc(v.sentTo) : ''}</div>` : ''}
        ${v.file ? `<div class="vd-sub">${esc(v.file)}</div>` : ''}
        ${links.length ? `<div class="vd-links">${links.join('')}</div>` : '<div class="vd-sub">No links yet (still filing?)</div>'}
        ${v.note ? `<div class="vd-sub">${esc(v.note)}</div>` : ''}
      </div>`;
    }
    if (site.clients && site.clients.length) h += `<div class="vd-clients">Clients here: ${site.clients.map(esc).join(' · ')}</div>`;
    return h;
  }

  function patternText(site) {
    const p = String(site.pattern || 'M 6 Y').toUpperCase();
    return [p.includes('M') && 'monthly', p.includes('6') && '6-monthly', p.includes('Y') && 'yearly'].filter(Boolean).join(', ') || 'none';
  }
  async function fetchCalendar(api, key, opts = {}) {
    const r = await fetch(api.replace(/\/$/, '') + '/photo-invoice-submit', {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ key, action: 'calendar', year: opts.year || 0, loc: opts.loc || '' })
    });
    const body = await r.json().catch(() => ({}));
    console.log('[visits] calendar', { status: r.status, sites: body.sites && body.sites.length, opts });
    if (!r.ok || body.ok === false) throw new Error(body.error || 'HTTP ' + r.status);
    return body;
  }

  // Styles shared by both pages (injected once).
  const CSS = `
  .vchip { display:inline-block; font-size:12px; padding:2px 8px; border-radius:10px; font-weight:600; }
  .st-done { background:#dcfce7; color:#166534; } .st-due { background:#fef3c7; color:#92400e; }
  .st-missed { background:#fee2e2; color:#991b1b; } .st-upcoming { background:#f4f4f5; color:#52525b; } .st-norec { background:#fff; color:#a1a1aa; border:1px dashed #d4d4d8; }
  .st-none { background:transparent; color:#d4d4d8; }
  .vd-head { margin-bottom:10px; } .vd-title { font-size:17px; font-weight:700; } .vd-site { color:#52525b; margin:2px 0 6px; } .vd-loc { color:#a1a1aa; font-size:12px; }
  .vd-note { color:#b45309; font-size:12px; } .vd-empty { color:#71717a; }
  .vd-visit { border-top:1px solid #e4e4e7; padding:10px 0; } .vd-line { font-size:15px; } .vd-sub { color:#71717a; font-size:13px; margin-top:2px; word-break:break-word; }
  .vd-links { display:flex; flex-wrap:wrap; gap:8px 14px; margin-top:6px; } .vd-links a { color:#1d4ed8; text-decoration:none; font-weight:600; }
  .vd-pass { color:#15803d; font-weight:700; } .vd-fail { color:#b91c1c; font-weight:700; }
  .vd-clients { color:#71717a; font-size:12px; border-top:1px solid #e4e4e7; padding-top:8px; margin-top:6px; }
  .vstrip { display:grid; grid-template-columns:repeat(12, 1fr); gap:3px; }
  .vcell { border-radius:6px; text-align:center; padding:5px 0 4px; cursor:pointer; user-select:none; border:1px solid transparent; }
  .vcell .vm { font-size:10px; opacity:.75; display:block; line-height:1.1; } .vcell .vt { font-size:13px; font-weight:700; line-height:1.2; }
  .vcell.now { outline:2px solid #18181b; outline-offset:1px; }
  .vcell.st-norec { border:1px dashed #d4d4d8; }`;
  if (!document.getElementById('visits-css')) { const st = document.createElement('style'); st.id = 'visits-css'; st.textContent = CSS; document.head.appendChild(st); }

  // A 12-month strip for one site (phone). onPick(m) when a month is tapped.
  function stripHtml(site, meta) {
    return '<div class="vstrip">' + MON.map((mn, m) => {
      const t = typeOf(site, m), s = statusOf(site, m, meta);
      return `<div class="vcell st-${s}${m === meta.now ? ' now' : ''}" data-vm="${m}" title="${mn}: ${t ? TYPE[t] : 'no visit'} — ${STATUS[s]}"><span class="vm">${mn[0]}</span><span class="vt">${t === '?' ? 'M' : t || '·'}</span></div>`;
    }).join('') + '</div>';
  }

  self.VISITS = { MON, TYPE, STATUS, typeOf, statusOf, detailsHtml, stripHtml, fetchCalendar, esc, patternText };
})();
