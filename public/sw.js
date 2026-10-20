// Service Worker: Push-Meldungen anzeigen, Klick öffnet das Ticket, App-Hülle für schnellen Start cachen.
const CACHE = 'zm-shell-v1';
const SCOPE = self.registration.scope; // endet mit /
const SHELL = ['', 'index.html', 'app.js', 'app.css', 'vendor/purify.js', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((p) => SCOPE + p))).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Netzwerk zuerst für die App-Hülle (damit Updates sofort greifen), Cache nur offline. API nie cachen.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !url.href.startsWith(SCOPE) || url.pathname.includes('/api/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok && SHELL.some((p) => url.href === SCOPE + p)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Zammad', body: e.data?.text() || '' }; }
  const title = data.title || 'Zammad';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: SCOPE + 'icons/icon-192.png',
    badge: SCOPE + 'icons/badge-96.png',
    timestamp: Date.now(),
    data: { url: data.url ? new URL(data.url, SCOPE).href : SCOPE },
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
      try { data.badge ? await self.navigator.setAppBadge(data.badge) : await self.navigator.clearAppBadge(); } catch { /* egal */ }
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || SCOPE;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => c.url.startsWith(SCOPE));
    if (client) {
      await client.focus();
      client.postMessage({ type: 'open', url: target });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
