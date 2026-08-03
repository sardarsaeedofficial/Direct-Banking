// Minimal service worker: an app-shell cache for offline resilience. The API is
// never cached (financial data must be fresh); only static assets are.
const CACHE = "direct-banking-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api")) return; // never cache API
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).catch(() => caches.match("/index.html"))),
  );
});

// Browser-push-ready: handle push events when a subscription exists.
self.addEventListener("push", (event) => {
  const data = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return {};
    }
  })();
  event.waitUntil(
    self.registration.showNotification(data.title || "Direct Banking", {
      body: data.body || "You have an upcoming payment.",
      icon: "/favicon.svg",
    }),
  );
});
