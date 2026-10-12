const CACHE = 'cocicp-v3';
const SHELL = ['/', '/index.html', '/app.html', '/login.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API: siempre network (nunca cache)
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // HTML: network-first (devuelve fresco siempre; cache solo si offline)
  const accept = e.request.headers.get('accept') || '';
  if (e.request.mode === 'navigate' || accept.includes('text/html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Resto (CSS/JS/imgs): cache-first (no cambian mucho)
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
