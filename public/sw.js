const CACHE = 'caja-v5';
const FILES = ['/pos.html', '/api.js', '/app.css', '/cart.js', '/queue.js', '/scanner.js', '/caja.js', '/caja.webmanifest', '/img/icon-caja-256.png', '/img/icon-caja-512.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => clients.claim())
));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || /^\/(api|receipts)\//.test(u.pathname)) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
