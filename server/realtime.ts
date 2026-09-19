import type { Response } from "express";

/**
 * A tiny in-process publish/subscribe bus backing Server-Sent Events.
 *
 * Deliberately process-local. That is the correct shape for a single long-lived Node process (the
 * self-hosted deployment) and the wrong shape for serverless, where a request may land on any
 * instance and a client would only ever hear about events that happened to reach the same one.
 * `isRealtimeEnabled()` encodes that distinction, and the client falls back to polling when it is
 * false - so the same build runs correctly in both places.
 */

type Subscriber = { res: Response; keepAlive: ReturnType<typeof setInterval> };

const subscribers = new Map<number, Set<Subscriber>>();

/** A stream only makes sense where one process serves everyone. Vercel's functions are not that. */
export function isRealtimeEnabled(): boolean {
  return process.env.VERCEL !== "1";
}

export type RealtimeEvent = { type: string; conversationId?: string; [key: string]: unknown };

/**
 * Registers a response as a live stream for one user and returns its teardown function.
 *
 * The keep-alive comment matters more than it looks: a proxy in front of the process (nginx
 * normally fronts a Pterodactyl deployment) drops idle connections, and that looks to the client
 * exactly like a broken server.
 */
export function subscribe(userId: number, res: Response): () => void {
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // Socket already gone; the close handler will clean up.
    }
  }, 25_000);

  const subscriber: Subscriber = { res, keepAlive };
  const forUser = subscribers.get(userId) ?? new Set<Subscriber>();
  forUser.add(subscriber);
  subscribers.set(userId, forUser);

  return () => {
    clearInterval(keepAlive);
    const current = subscribers.get(userId);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) subscribers.delete(userId);
  };
}

/** Delivers one event to every live stream belonging to the given users. Returns the count sent. */
export function publishToUsers(userIds: number[], event: RealtimeEvent): number {
  if (userIds.length === 0) return 0;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  let delivered = 0;
  for (const userId of userIds) {
    const forUser = subscribers.get(userId);
    if (!forUser) continue;
    for (const subscriber of forUser) {
      try {
        subscriber.res.write(payload);
        delivered += 1;
      } catch {
        // Dead socket; its own close handler removes it.
      }
    }
  }
  return delivered;
}

/** Diagnostics and tests: how many streams are open right now. */
export function subscriberCount(): number {
  let total = 0;
  for (const forUser of subscribers.values()) total += forUser.size;
  return total;
}
