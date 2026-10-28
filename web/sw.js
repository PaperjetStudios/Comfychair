// ComfyChair service worker (only registered over HTTPS). Network first, always: the app shell is
// cached only so the home-screen app still opens (and says the server is unreachable) when the box
// is off. API calls, files and the websocket are never cached.
//
// There is no list of the app's files to keep up to date: every page, module, style and icon the app
// loads is kept as it loads (modules come as name.js?v=<ui_version>, app/main.py module_js), and a
// module of an older version is dropped when the new one arrives, so the cache holds one version.
const CACHE = 'comfydeck-shell-v13';
const SHELL = ['/', 'index.html', 'app.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isApp = (url) => url.origin === location.origin && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/files/') && url.pathname !== '/ws';

async function keep(req, res) {
  const c = await caches.open(CACHE), v = new URL(req.url).searchParams.get('v');
  if (v) {   // a new version of the modules: forget the old ones
    for (const k of await c.keys()) { const o = new URL(k.url).searchParams.get('v'); if (o && o !== v) await c.delete(k); }
  }
  await c.put(req, res);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !isApp(url)) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && r.type === 'basic') { const copy = r.clone(); e.waitUntil(keep(e.request, copy)); }
    return r;
  }).catch(async () => (await caches.match(e.request)) || (await caches.match(e.request, { ignoreSearch: true }))
    || (e.request.mode === 'navigate' ? caches.match('/') : Response.error())));
});

// tapping a "done" notification brings the app forward
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('/'))));
});
