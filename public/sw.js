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
 *
 * It does have one job beyond installability: receiving push. That is the whole reason notifications
 * arrive while the page is closed - a push event wakes this worker, and the worker is what shows the
 * notification. Nothing here caches, so that is unaffected.
 */

self.addEventListener("install", () => {
  // Take over as soon as possible so a new build is not shadowed by an older worker.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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
