// app v3.0 - changing this line makes every phone pick up the new version (must match buildInfo.js version)
importScripts('./buildInfo.js');
const CACHE = 'photo-invoice-' + self.BUILD_INFO.version;
const SHELL = ['./', 'index.html', 'app.js', 'geometry.js', 'buildInfo.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

// New versions take over straight away (safe now that app files are network-first).
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

// App files: network first (always the latest version when there's signal), saved copy only when offline.
// Everything else (the n8n API) always goes to the network and is never saved.
const SHELL_PATHS = SHELL.map(p => new URL(p, self.registration.scope.endsWith('/') ? self.registration.scope : self.registration.scope + '/').pathname);
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !SHELL_PATHS.includes(url.pathname)) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(url.pathname, copy)); }
    return r;
  }).catch(() => caches.match(url.pathname, { ignoreSearch: true })));
});
