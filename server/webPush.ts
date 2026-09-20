import webpush from "web-push";

import * as db from "./db";

/**
 * Web Push: notifications that arrive with the page closed.
 *
 * A browser subscription is not a token. The push service is handed an encrypted blob that only the
 * subscribing browser can open, which is why the endpoint travels with two keys rather than alone.
 * This module is the only thing that knows how to put those back together.
 *
 * The whole feature is off unless a VAPID keypair is configured. That is deliberate: the app sends
 * messages whether or not anyone can be notified, and a missing key must not turn into an error on
 * every send. `isWebPushConfigured` is what callers check.
 */

/**
 * Cached because `setVapidDetails` validates the keypair and would otherwise run on every message.
 * `null` means "not worked out yet"; the answer cannot change while the process lives.
 */
let configured: boolean | null = null;

function vapidSubject(): string {
  const subject = process.env.VAPID_SUBJECT;
  // Push services reject a subject that is not a mailto: or https: URL, so a missing one falls back
  // to a valid address rather than an empty string that fails at send time.
  if (subject && (subject.startsWith("mailto:") || subject.startsWith("https://"))) return subject;
  return "mailto:no-reply@varnoxapp.blacklord.tech";
}

export function isWebPushConfigured(): boolean {
  if (configured !== null) return configured;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    configured = false;
    return configured;
  }

  try {
    webpush.setVapidDetails(vapidSubject(), publicKey, privateKey);
    configured = true;
  } catch (error) {
    // A malformed key is a deployment mistake, worth saying once and then treating as "off" rather
    // than throwing on every notification for the rest of the process's life.
    console.warn("[WebPush] the VAPID keypair was rejected, so web push is off:", error instanceof Error ? error.message : error);
    configured = false;
  }

  return configured;
}

/** The public half, for the browser to subscribe with. Safe to hand to a client. */
export function webPushPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

/**
 * Sends to every subscribed browser that should hear about this, and reports how many were reached.
 *
 * A subscription the push service has forgotten answers 404 or 410. Those rows are deleted rather
 * than retried: a dead subscription would otherwise be paid for on every message for ever, and the
 * count would overstate how many people actually got told.
 *
 * Every failure is swallowed. A message that was stored must never look unsent because a
 * notification could not be delivered.
 */
export async function sendWebPush(input: {
  userIds: number[];
  category?: "messages" | "groups" | "calls";
  title: string;
  body: string;
  data?: Record<string, string>;
}): Promise<number> {
  if (!isWebPushConfigured()) return 0;

  const subscriptions = await db.listWebPushSubscriptionsForPreference(input.userIds, input.category ?? "messages");
  if (subscriptions.length === 0) return 0;

  const payload = JSON.stringify({
    title: input.title,
    body: input.body,
    data: { ...(input.data ?? {}), url: "/" },
  });

  let delivered = 0;
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          payload,
        );
        delivered += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.deleteWebPushSubscription(subscription.endpoint).catch(() => undefined);
          return;
        }
        console.warn(`[WebPush] delivery failed (${status ?? "no status"})`);
      }
    }),
  );

  return delivered;
}
