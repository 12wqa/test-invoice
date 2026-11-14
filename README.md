# Test Invoice

Allied Fire field app (phone PWA): pick client → site → test photos + auto-cropped document scans → Pass/Fail →
creates a Xero **draft** invoice (and optional draft quote) and emails the client the result with the photos
(Gmail label `Tested`, plus `Tested/Fail`). All the work happens in n8n; this repo is only the front end.

- Live: https://invoice.12wqa.com (Cloudflare tunnel `lan-services-tunnel` → Tower `http://192.168.0.10:8095`)
- API: n8n at https://n8n.12wqa.com - workflow **Test Invoice PWA API v1.0** (`UFrHbAiiA7kIjwey`)
  - `GET  /webhook/photo-invoice-lookups?key=…` → Xero customers + items + register sites
  - `POST /webhook/photo-invoice-submit` (text/plain JSON, key in body)
    - `action: 'listJobs'` → latest 100 jobs from the register
    - `action: 'saveQuickItems'` (admin key) → saves the quick-item tiles
- Job register: n8n data table **Test Invoice Jobs** - each job is inserted as `submitted` when n8n accepts it and
  updated to `processed` or `attention` (with the reason in `note`) when the invoice/email/quote steps finish.
  The phone's 📋 Jobs screen also shows jobs still in its offline queue as `In queue`.

## How a change gets to the phone
1. Edit files in `app/`, **bump the version** in `app/buildInfo.js` *and* line 1 of `app/sw.js` (same value).
2. Push to `main`. GitHub Actions builds `ghcr.io/12wqa/test-invoice:<version>` and `:latest`.
   The build fails on purpose if the two versions differ or the version was already published.
3. Unraid → Docker → **Check for Updates** → update `test-invoice` (or let the Auto Update plugin do it).
4. Phones get it next time the app is opened.

### Version rules
- `vMAJOR.MINOR` - major for new features / big changes (v2.1 → v3.0), minor for fixes and tweaks (v2.1 → v2.2).
- Never reuse a version. The version shows small in the top-left of the app.

## Layout
| Path | What |
|---|---|
| `app/` | The PWA (plain HTML/JS, no build step). `buildInfo.js` = version + n8n API base |
| `app/admin.html`, `app/admin.js` | Desktop admin page (quick items). Open `/admin.html#key=ADMIN_KEY` once; the admin key lives in n8n **Check Key (lookups)** + **Parse & Check** |
| `nginx/default.conf` | Web server settings (no caching of app files; the service worker handles offline) |
| `Dockerfile` | nginx:alpine + `app/` + `nginx/` |
| `.github/workflows/build.yml` | Build + publish on every push to `main` |
| `unraid/test-invoice.xml` | Unraid container template (bridge, port 8095 → 80) |

## Install on Unraid
Docker → Add Container: **Name** `test-invoice`, **Repository** `ghcr.io/12wqa/test-invoice:latest`,
**Network** Bridge, **Port** container `80` → host `8095`. No paths or variables needed.
(Or copy `unraid/test-invoice.xml` to `/boot/config/plugins/dockerMan/templates-user/my-test-invoice.xml`
and pick it under Add Container → Template.)

## First-time phone setup
Open `https://invoice.12wqa.com/#key=APP_KEY` once (the key is saved on the phone and removed from the
address bar), then Share → Add to Home Screen. The app key lives in n8n (**Check Key (lookups)** and
**Parse & Check**) - change both together.

## Drive filing (v7.0)

After every job the API workflow hands the job to **Test Invoice Drive Filer v1.0** (n8n, runs on its own so the phone isn't kept waiting). It files into the same tree as the Service Report Processor:

`Service Report Management / <client> / <site> / <year> / <yyyy-mm-dd> PASS|FAIL - <INV / QU / job id>/`

- every photo and report scan
- `Job summary.txt` (client, site, result, who was emailed, items, invoice/quote numbers, job status)
- `Invoice INV-xxxx (draft).pdf` and `Quote QU-xxxx (draft).pdf` from Xero - a copy at filing time, while still DRAFT

The folder link and a status (`filed`, `filed, N file(s) missing`, `not filed: ...`) go into the jobs register (`driveUrl`, `driveStatus`) and show on the phone Jobs screen.

To file somewhere else, change `rootId` in the filer's **Settings** node. To use different storage (Unraid share, S3, OneDrive), replace only the filer workflow: it receives one JSON job (fields + base64 photos) and nothing else depends on Drive.

## Site numbers and adding sites (v8.0)

Every physical address has one **AFS number** (`AFS-0001`…), kept in the register Sites tab column **Location ID** (and Site_List column H). One AFS site can have many clients (one register row per client). The app shows AFS numbers only; the old Uptick P-numbers stay in the register's **Site ID** column as hidden row keys and still match when searched.

**+ Add new site to the register** sits at the top of the site search. It needs the client picked first and signal. The API (`action: addSite`) then:

- same client already at that address → nothing written (re-activates the row if it was switched off)
- address already on file for another client → new register row with that site's AFS number (joins the site)
- new address → next AFS number, new register row **and** a new Site_List row for the report automation

The yearly (annual) month is optional; set it later in the register (column **Annual month**) if unsure. Jobs send `locationId`, and the Drive job summary shows the AFS number.

## Quote note tidy (v9.0)

The quote note is a text box: tap the keyboard mic and talk. **✨ Tidy** sends it to n8n (`action: tidyNote`), which asks the picked model (Haiku via the Anthropic key, Kimi via OpenRouter, ChatGPT via the OpenAI key) to turn it into short scope lines without adding anything. The picked model is remembered on the phone; if it fails (no credits) the app tries the others. **↩ Undo** puts back what you said. Without signal the note goes as typed.

Each line of the note becomes its own description-only line on the Xero draft quote (no quantity or price), so you just price them in Xero. Model names are in **Parse & Check** (`MODELS`); to swap one, change it there (and the matching **Ask …** node's credential if the provider changes).

## Quote items (v10.0)

The quote is a list of boxes, one per item: talk one in, tap **+ Add another item**, talk the next. ✕ removes an item. ✨ on an item tidies just that one (if the model splits it, the extra lines become new items); **✨ Tidy all** tidies the lot; **↩ Undo tidy** puts back the last tidy. Sent to n8n as the same `quoteNote` (one item per line), so no server change.

## Visits calendar (v11.0)

- **Phone:** pick a site and a 12-month strip shows under it (Y yearly, 6 six-monthly, M monthly; green done, amber due this month, red not recorded, grey coming up, dashed = before records started). Tap a month for its reports, job folder and invoice. Cached per site for no-signal use.
- **All sites:** `visits.html` (linked from the phone strip and the admin page) — every active AFS site × Jan–Dec, search, client filter, Due this month / Yearly this month / Missed / No yearly month. Click a cell for the details panel. Uses the admin key or the phone's app key.
- **Data:** n8n `action: calendar` (API workflow → Build Calendar). Schedule = register **Annual month** (most common across a site's rows); 6-monthly = +6; the rest monthly. "Done" = an app job (jobs register, matched by `locationId` / Site ID) or a filed service report (`sr_ledger`, matched via Site_List SITE### → AFS) in that month. Test-route and duplicate reports are ignored. Records start Nov 2026 (`trackFrom` in Build Calendar); earlier months show as "before records".

## Visit patterns (v11.1)

Register Sites tab column **Visits** (AB) says which visits a site gets: any of `M` (monthly), `6` (6-monthly), `Y` (yearly), e.g. `M 6 Y`, `6 Y`, `Y`, `M`. Pre-filled 14 Nov 2026 from the Uptick services / email frequency notes; blank rows were set to `M 6 Y`. Edit it in the sheet; the calendar picks it up on the next load.

Placement: yearly in the **Annual month**; 6-monthly six months later; monthly in every other month. Missing types fall back: no `Y` → the annual month shows `6` (or `M`); no `6` → that month shows `M`; no `M` → other months show `·` (no visit, never counted as due or missed).

## Clients, active switch, quote quick items (v12.0)
- **One row per site + client.** A site serviced for two clients (e.g. Balmoral and Maximum at 1 Moola Ct) shows as two calendar rows with the same AFS number. Each register row has its own visit pattern, yearly month and Active flag.
- **Active / inactive** is per client: the switch on each row of the visits page (v12.1), or *Make inactive* / *Make active* in any month panel. It writes register columns R (Status) and S (Active). Rows are never deleted. Visits page: tick *Show inactive* to see and re-activate them (greyed out).
- **Phone strip** shows the row for the job's client, plus "Also here: …" for other clients at that site.
- **6-monthly this month** filter on the visits page; the summary counts yearly and 6-monthly visits for active rows only.
- **Quote quick items:** with *Also start a quote* ticked, the quick-item tiles add priced lines to the Xero draft quote (counted separately from the invoice). Typed items stay as no-price lines below them.
