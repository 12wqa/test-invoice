# Test Invoice

Allied Fire field app (phone PWA): pick client → site → test photos + auto-cropped document scans → Pass/Fail →
creates a Xero **draft** invoice (and optional draft quote) and emails the client the result with the photos
(Gmail label `Tested`, plus `Tested/Fail`). All the work happens in n8n; this repo is only the front end.

- Live: https://invoice.12wqa.com (Cloudflare tunnel `lan-services-tunnel` → Tower `http://192.168.0.10:8095`)
- API: n8n at https://n8n.12wqa.com - workflow **Test Invoice PWA API v1.0** (`UFrHbAiiA7kIjwey`)
  - `GET  /webhook/photo-invoice-lookups?key=…` → Xero customers + items + register sites
  - `POST /webhook/photo-invoice-submit` (text/plain JSON, key in body)

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
