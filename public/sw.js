/**
 * Varnox service worker.
 *
 * It deliberately caches nothing. The app ships as a static export where every route is
 * fingerprinted, so a cache is unnecessary - and an aggressive one would serve a stale bundle
 * after a deploy, which is exactly the class of bug that is hardest to diagnose from a user
 * report. Its only jobs are to make the site installable and to answer honestly when offline.
 *
 * If offline support is ever wanted, do it as a deliberate change: precache the app shell by
 * revision and keep the API and media routes on the network.
 */

self.addEventListener("install", () => {
  // Take over as soon as possible so a new build is not shadowed by an older worker.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Never touch anything that is not a plain same-origin GET: mutations, and the API and media
  // routes, must always reach the network untouched.
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(request).catch(
      () =>
        new Response("You are offline. Reconnect to keep using Varnox.", {
          status: 503,
          statusText: "Offline",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    ),
  );
});
