/**
 * Browser push, from the browser's side.
 *
 * Everything here is guarded on the APIs existing. Push needs a service worker and the Push API, and
 * neither is present in the native shell or on a page not served over HTTPS, so each entry point
 * reports "unsupported" rather than throwing into a screen that cannot do anything about it.
 *
 * None of this sends anything to the server. It only produces the subscription; deciding what to do
 * with it belongs to the caller.
 */

export type WebPushState = "unsupported" | "denied" | "off" | "on";

function isSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/**
 * VAPID keys arrive as base64url and have to be bytes.
 *
 * `applicationServerKey` rejects a plain string, and the padding is not always present in a key that
 * has been copied between systems - so it is normalised first. A missing pad character is the usual
 * reason this fails with an unhelpful error.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalised);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

export async function currentWebPushState(): Promise<WebPushState> {
  if (!isSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    return existing ? "on" : "off";
  } catch {
    return "unsupported";
  }
}

export type EnableResult = { ok: true; subscription: { endpoint: string; p256dh: string; auth: string } } | { ok: false; reason: string };

/**
 * Asks permission, then subscribes.
 *
 * A subscription that already exists is reused rather than replaced: calling subscribe again on an
 * existing registration throws in some browsers, and replacing it would silently invalidate the row
 * the server already holds.
 */
export async function enableWebPush(publicKey: string): Promise<EnableResult> {
  if (!isSupported()) return { ok: false, reason: "This app cannot receive browser notifications." };

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return { ok: false, reason: permission === "denied" ? "Notifications are blocked for this site in your browser settings." : "Notifications were not allowed." };
    }

    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    // The cast is for the type definition, not the value: `applicationServerKey` wants a BufferSource
    // backed by a plain ArrayBuffer, and a Uint8Array built here is typed as possibly backed by a
    // SharedArrayBuffer. The bytes are the same either way.
    const applicationServerKey = urlBase64ToUint8Array(publicKey) as unknown as BufferSource;
    const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));

    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!json.endpoint || !p256dh || !auth) {
      return { ok: false, reason: "The browser returned an incomplete subscription." };
    }

    return { ok: true, subscription: { endpoint: json.endpoint, p256dh, auth } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Could not turn notifications on." };
  }
}

/** Cancels the browser subscription and returns the endpoint it had, so the server row can go too. */
export async function disableWebPush(): Promise<string | null> {
  if (!isSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return null;
    const { endpoint } = subscription;
    await subscription.unsubscribe();
    return endpoint;
  } catch {
    return null;
  }
}

/**
 * The current subscription, if there is one.
 *
 * Used to re-register on sign-in: a subscription made before signing in belongs to no user, and the
 * browser keeps it across sessions, so the server has to be told about it again afterwards.
 */
export async function currentSubscription() {
  if (!isSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return null;
    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!json.endpoint || !p256dh || !auth) return null;
    return { endpoint: json.endpoint, p256dh, auth };
  } catch {
    return null;
  }
}
