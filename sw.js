// Caches the game so repeat visits load instantly and work offline.
// Vendor libraries and fonts never change: cache-first.
// The game's own files: network-first (so edits show up), falling back to cache offline.
const CACHE = 'badger-gp-v2';
const IMMUTABLE = /\/vendor\/|fonts\.(googleapis|gstatic)\.com/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || /espn\.com/.test(request.url)) return; // live data is never cached
  const put = (res) => {
    if (res.ok || res.type === 'opaque') caches.open(CACHE).then((c) => c.put(request, res.clone()));
    return res;
  };
  if (IMMUTABLE.test(request.url)) {
    e.respondWith(caches.match(request).then((hit) => hit || fetch(request).then(put)));
  } else {
    e.respondWith(fetch(request).then(put).catch(() => caches.match(request)));
  }
});
