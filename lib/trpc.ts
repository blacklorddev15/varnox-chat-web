import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink, splitLink, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import superjson from "superjson";
import type { AppRouter } from "@/server/routers";
import { getApiBaseUrl } from "@/constants/oauth";
import * as Auth from "@/lib/_core/auth";
import { isOnline, OFFLINE_ACTION_MESSAGE } from "@/lib/offline";

/**
 * tRPC React client for type-safe API calls.
 *
 * IMPORTANT (tRPC v11): The `transformer` must be inside `httpBatchLink`,
 * NOT at the root createClient level. This ensures client and server
 * use the same serialization format (superjson).
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * Refuses a mutation outright when there is no connection.
 *
 * React Query is configured below to run mutations even while offline
 * (`networkMode: "always"`), which is what lets this link be reached at all: with the default
 * `"online"` it pauses a mutation instead of running it, the request never leaves the device, and
 * the promise the caller is awaiting never settles. A send button with no catch-able failure is a
 * button that hangs on "Sending…" forever.
 *
 * With this in place, an offline write fails in the ordinary way - immediately, with a message the
 * existing error handling already knows how to display. Screens that want to say something better
 * than a generic error check `isOnline()` before they call in; this is what catches the ones that
 * do not.
 *
 * Queries are deliberately left alone. They keep `networkMode: "online"`, so while offline they are
 * paused rather than fired and failed, and they resume on their own the moment the connection is
 * back. Reading from the persisted cache is what makes the app usable in the meantime.
 */
const offlineMutationLink: TRPCLink<AppRouter> = () => ({ op }) =>
  observable((observer) => {
    observer.error(new TRPCClientError(OFFLINE_ACTION_MESSAGE));
    return { unsubscribe() {} };
  });

/**
 * Creates the tRPC client with proper configuration.
 * Call this once in your app's root layout.
 */
export function createTRPCClient() {
  return trpc.createClient({
    links: [
      // Checked per operation, not once at start-up, so a client built before the network dropped
      // still refuses writes afterwards.
      splitLink({
        condition: (op) => op.type === "mutation" && !isOnline(),
        true: offlineMutationLink,
        false: httpBatchLink({
          url: `${getApiBaseUrl()}/api/trpc`,
          // tRPC v11: transformer MUST be inside httpBatchLink, not at root
          transformer: superjson,
          async headers() {
            const token = await Auth.getSessionToken();
            return token ? { Authorization: `Bearer ${token}` } : {};
          },
          // Custom fetch to include credentials for cookie-based auth
          fetch(url, options) {
            return fetch(url, {
              ...options,
              credentials: "include",
            });
          },
        }),
      }),
    ],
  });
}
