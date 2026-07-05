// Kill-switch service worker (DESIGN §2): replaces v1's cache-first worker for
// existing installs — takes over immediately, deletes every cache, unregisters
// itself and reloads all open clients so the stale v1 shell can never be served.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
