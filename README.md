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
