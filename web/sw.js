// ComfyDeck service worker (only registered over HTTPS). Network first, always: the app shell is
// cached only so the home-screen app still opens (and says the server is unreachable) when the box
// is off. API calls, files and the websocket are never cached.
const CACHE = 'comfydeck-shell-v1';
const SHELL = ['/', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin
      || url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/') || url.pathname === '/ws') return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && SHELL.some((p) => url.pathname === (p.startsWith('/') ? p : `/${p}`))) {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request).then((m) => m || caches.match('/'))));
});

// tapping a "done" notification brings the app forward
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('/'))));
});
