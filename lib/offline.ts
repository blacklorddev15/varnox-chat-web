import { onlineManager } from "@tanstack/react-query";

/**
 * The single source of truth for "is there a connection right now".
 *
 * This reads React Query's own `onlineManager` rather than adding a listener of its own. That
 * matters for more than tidiness: React Query uses exactly this flag to decide whether to send a
 * query or a mutation at all. With the default `networkMode: "online"`, a mutation fired while
 * offline is *paused* rather than failed - it never reaches the network and its promise never
 * settles. A send button that awaits such a mutation would hang forever with no error and no
 * toast. So the guard has to use the same flag the pause uses, and then the two can never disagree:
 * if `isOnline()` says yes, the mutation really will be sent.
 *
 * The honest caveat: this is backed by `navigator.onLine`, which reports a device that is on a
 * network, not a device that can reach the internet. A captive-portal wifi says "online" and then
 * fails. In that case the write is refused by the server and the existing error handling reports
 * it - this is a heads-up, not a guarantee.
 */
export function isOnline(): boolean {
  return onlineManager.isOnline();
}

/**
 * What to say when a write is refused.
 *
 * Kept here rather than in each screen so that every refusal reads the same way. A message that
 * says "could not send" without saying why leaves somebody tapping a button that is never going
 * to work.
 */
export const OFFLINE_SEND_MESSAGE = "No connection. Your message was not sent.";
export const OFFLINE_CALL_MESSAGE = "No connection. You can call when you are back online.";
export const OFFLINE_UPLOAD_MESSAGE = "No connection. Attachments need an internet connection.";
export const OFFLINE_ACTION_MESSAGE = "No connection. That needs an internet connection.";
