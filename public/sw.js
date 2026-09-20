/**
 * Varnox service worker.
 *
 * This used to cache nothing at all, on the grounds that the app ships as a static export where
 * every route is fingerprinted, and that an aggressive cache serves a stale bundle after a deploy.
 * Both of those are still true of the assets, and the second is still the thing to be careful about.
 *
 * It caches now because the app has to open with no connection. The data was already kept on the
 * device - the last conversations and messages - but that was beside the point while the document
 * itself could not load: Vercel serves the HTML with `must-revalidate`, so a browser with no
 * connection cannot use its own copy, and the app never got as far as showing the messages it had.
 * Caching the data without caching the shell was caching something nobody could reach.
 *
 * The shape of it:
 *
 *   - The document is network-first. Online, a deploy is picked up immediately, which is what the
 *     original note was protecting. Offline, the last copy is served instead of a browser error.
 *     That copy is stored under "/" rather than by URL, so a navigation to any route - the app
 *     routes on the client - is answered with the newest document this device saw.
 *   - Fingerprinted assets are cache-first. Their names contain a content hash, so a cache hit is
 *     the right answer by construction and no staleness is possible.
 *   - The API is never cached and never intercepted. Messages, calls and media always go to the
 *     network, or fail, honestly.
 *   - Non-GET is never touched, so nothing that writes can be replayed from a cache.
 *
 * It also carries push, which is how a notification arrives while the page is closed. That is
 * unrelated to the caching and is unchanged.
 */

const SHELL_CACHE = "varnox-shell-v2";
const ASSET_CACHE = "varnox-assets-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // Take over as soon as possible so a new build is not shadowed by an older worker.
      await self.skipWaiting();
      // Precached so a first launch with a connection leaves something behind to open later. A
      // failure here is not fatal: a device that installs while offline simply has nothing yet.
      try {
        const cache = await caches.open(SHELL_CACHE);
        await cache.add(new Request("/", { cache: "reload" }));
      } catch {
        // Nothing to store. The navigation handler below will cache the next successful one.
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Any cache from an earlier revision goes, so an old document cannot outlive its own deploy.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== SHELL_CACHE && name !== ASSET_CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/**
 * The notification itself.
 *
 * `event.waitUntil` is required: without it the worker may be torn down before the notification is
 * shown, and the message would arrive as silence.
 *
 * The payload comes from server/webPush.ts, already encrypted in transit and decrypted by the
 * browser before it reaches here. Anything missing falls back rather than throwing, because a
 * notification with a blank title is still better than a push event that fails and reaches nobody.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A payload that is not JSON means a sender we do not control. Show something generic rather
    // than dropping the event.
    payload = {};
  }

  const title = payload.title || "Varnox";
  const options = {
    body: payload.body || "You have a new message.",
    // `tag` collapses repeats: several messages in one conversation replace the earlier
    // notification instead of stacking, which is what a chat app should do.
    tag: (payload.data && payload.data.conversationId) || "varnox",
    renotify: true,
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * What a tap does.
 *
 * An open window is focused rather than a second one opened, so a notification does not leave the
 * user with duplicate tabs of the same app.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});

/** What to say when there is no connection and no copy to fall back on. */
function offlineResponse() {
  return new Response("You are offline, and this device has not stored a copy yet. Reconnect once to keep using Varnox offline.", {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Never touch anything that is not a plain same-origin GET: mutations, and the API and media
  // routes, must always reach the network untouched. A cached write is a write that never happened.
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Fingerprinted build output and anything else under a hashed path. Cache-first, because the name
  // changes whenever the contents do.
  const isFingerprintedAsset = url.pathname.startsWith("/_expo/static/") || url.pathname.startsWith("/assets/");

  if (isFingerprintedAsset) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const response = await fetch(request);
          // Only a complete, successful response is worth keeping. A partial or opaque one stored
          // here would be served as a broken file for as long as the cache lives.
          if (response && response.status === 200 && response.type === "basic") await cache.put(request, response.clone());
          return response;
        } catch {
          return offlineResponse();
        }
      })(),
    );
    return;
  }

  // The document, and anything else that is not build output: network first, so a deploy is picked
  // up on the next load rather than whenever a cache decides to expire.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (request.mode === "navigate" && response && response.status === 200) {
          const cache = await caches.open(SHELL_CACHE);
          // Stored under "/" deliberately. The app routes on the client, so every route is served by
          // the same document, and keeping one copy means one revision rather than a mixture.
          await cache.put("/", response.clone());
        }
        return response;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        const cached = (await cache.match(request, { ignoreSearch: true })) ?? (await cache.match("/"));
        return cached ?? offlineResponse();
      }
    })(),
  );
});
