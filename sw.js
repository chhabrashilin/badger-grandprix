// Precache the HD shell so repeat visits skip network stalls, then keep
// game files network-first so edits still show up.
const CACHE = 'badger-gp-hd-v4';
const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './src/main.js',
  './src/gfx.js',
  './src/track.js',
  './src/kart.js',
  './src/race.js',
  './src/show.js',
  './src/bake.js',
  './src/util.js',
  './src/input.js',
  './src/audio.js',
  './src/teams.js',
  './src/rankings.js',
  './src/collision.js',
  './src/stadium-stand.js',
  './vendor/three.module.min.js',
];
const IMMUTABLE = /\/vendor\/|fonts\.(googleapis|gstatic)\.com/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || /espn\.com/.test(request.url)) return;
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
