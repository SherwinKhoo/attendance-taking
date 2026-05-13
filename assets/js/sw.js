// Minimal service worker.
// Sole purpose: unlock the auto install prompt and serve offline.html as a
// fallback when the browser is offline. NO app-code caching — the main shell
// is always fetched live from network so users never run stale code.

const OFFLINE_VERSION = "v1";
const OFFLINE_URL = new URL("offline.html", self.registration.scope).href;
const CACHE_NAME = `attendance-offline-${OFFLINE_VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop older offline caches.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("attendance-offline-") && n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  // Only intercept top-level navigation requests; let everything else go to
  // the network normally.
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    (async () => {
      try {
        return await fetch(event.request);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(OFFLINE_URL);
        return cached ?? new Response("Offline", { status: 503 });
      }
    })(),
  );
});
