import type { QueryClient } from "@tanstack/react-query";

/**
 * Keeps the last-seen data on the device, so the app is readable with no connection.
 *
 * This is the WhatsApp behaviour: with no network you can still read your chats, and anything that
 * has to reach the server - sending, calling - is unavailable. React Query already holds that data
 * in memory, which covers a connection dropping while the app is open. Persisting is what covers
 * closing the app and opening it again somewhere without signal.
 *
 * Written by hand rather than with React Query's persist-client package, for two reasons. It is
 * another dependency for about eighty lines of work. And its default is to keep everything, which
 * here would push media responses and link previews into a five-megabyte localStorage budget and
 * evict the conversations that are the entire point.
 *
 * Nothing here is trusted. A cached response is a copy of something the server once said, and it can
 * be stale, truncated or missing. It is only ever used to draw the screen; no write path reads it.
 */

const STORAGE_KEY = "varnox:offline-cache:v1";
/** Well inside the ~5 MB most browsers allow, leaving room for other site data. */
const MAX_BYTES = 3_000_000;
/** Coalesces a burst of query updates into one write. */
const WRITE_DELAY_MS = 1_500;

/**
 * Query paths that are never worth keeping.
 *
 * Presence and typing are true for seconds and would be a lie on the next launch. Previews are
 * fetched from third-party sites and are cheap to fetch again. Media is the one that could actually
 * fill the budget, since a single response can carry a base64 body.
 */
const SKIP_SEGMENTS = ["presence", "typing", "preview", "media", "avatar", "sticker"];

function queryPath(queryKey: unknown): string {
  // tRPC keys are [[router, procedure], { input, type }].
  const root = Array.isArray(queryKey) ? queryKey[0] : null;
  if (Array.isArray(root)) return root.join(".");
  if (typeof root === "string") return root;
  return "";
}

function isWorthKeeping(queryKey: unknown): boolean {
  const path = queryPath(queryKey).toLowerCase();
  if (!path) return false;
  return !SKIP_SEGMENTS.some((segment) => path.includes(segment));
}

type StoredEntry = { key: unknown; data: unknown; updatedAt: number };

function storage(): Storage | null {
  try {
    // Absent in a native build, and throwing in a browser with storage disabled. Either way there is
    // simply no offline cache - which degrades to the old behaviour rather than breaking anything.
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Copies what is worth keeping out of the cache and into storage.
 *
 * Newest first, stopping at the byte budget: if everything cannot fit, the conversations somebody
 * looked at today are kept over the ones they looked at last week.
 */
export function persistQueryCache(client: QueryClient): void {
  const store = storage();
  if (!store) return;

  try {
    const entries: StoredEntry[] = [];
    for (const query of client.getQueryCache().getAll()) {
      // Only successful results. An error or a paused query has no data to restore, and caching a
      // failure would mean showing "could not load" on a launch that never tried.
      if (query.state.status !== "success" || query.state.data === undefined) continue;
      if (!isWorthKeeping(query.queryKey)) continue;
      entries.push({ key: query.queryKey, data: query.state.data, updatedAt: query.state.dataUpdatedAt });
    }

    entries.sort((a, b) => b.updatedAt - a.updatedAt);

    let bytes = 0;
    const kept: StoredEntry[] = [];
    for (const entry of entries) {
      const size = JSON.stringify(entry).length;
      if (bytes + size > MAX_BYTES) break;
      bytes += size;
      kept.push(entry);
    }

    store.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), entries: kept }));
  } catch {
    // Quota exceeded, or storage disabled mid-write. The app works without an offline cache, so this
    // is not worth surfacing - and it must never interrupt whatever triggered the write.
  }
}

/**
 * Puts the stored results back into a fresh cache.
 *
 * `updatedAt` is restored alongside the data so React Query keeps its original opinion about how old
 * this is. Without it, everything would look brand new and a stale conversation list would be
 * treated as fresh the moment the app opened.
 */
export function restoreQueryCache(client: QueryClient): number {
  const store = storage();
  if (!store) return 0;

  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { entries?: StoredEntry[] };
    const entries = parsed?.entries;
    if (!Array.isArray(entries)) return 0;

    let restored = 0;
    for (const entry of entries) {
      if (!entry || entry.key === undefined) continue;
      try {
        // Both casts are the price of restoring a key this build only knows as `unknown`. A stored
        // cache cannot carry types, and the router's own types are the wrong ones to assert here
        // anyway: these entries were written by an older build and are validated by nothing but the
        // screen that reads them.
        client.setQueryData(entry.key as never, entry.data as never, { updatedAt: entry.updatedAt });
        restored += 1;
      } catch {
        // A key or payload this build no longer understands. Skip it rather than abandoning the
        // whole cache over one entry written by an older version.
      }
    }
    return restored;
  } catch {
    return 0;
  }
}

/** Debounced writer, so a screen that updates six queries on mount causes one write. */
export function createCachePersister(client: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const unsubscribe = client.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      persistQueryCache(client);
    }, WRITE_DELAY_MS);
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

/** Emptied on sign-out, so one account's chats are not left readable to the next person. */
export function clearQueryCache(): void {
  const store = storage();
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing useful to do; the data is on a device nobody is signed in to either way.
  }
}
