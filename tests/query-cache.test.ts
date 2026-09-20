import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { clearQueryCache, createCachePersister, persistQueryCache, restoreQueryCache } from "../lib/query-cache";

/**
 * The offline cache is the difference between "the app is broken" and "I am out of signal", so the
 * cases that matter are the ones where it could quietly do the wrong thing: restoring something
 * that has since become a lie, keeping something too big to keep, or leaving one account's
 * conversations behind for the next person.
 *
 * The keys below are the real shape tRPC produces: [[router, procedure], { input, type }].
 */

const STORAGE_KEY = "varnox:offline-cache:v1";

const listKey = [["conversations", "list"], { type: "query" }];
const messagesKey = [["conversations", "messages"], { input: { conversationId: "c1" }, type: "query" }];
const presenceKey = [["presence", "inbox"], { type: "query" }];
const mediaKey = [["media", "get"], { input: { id: "m1" }, type: "query" }];

let store: Map<string, string>;

function installStorage(): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

/** The paths actually written, so a test can assert on what was left out as well as kept. */
function storedPaths(): string[] {
  const raw = store.get(STORAGE_KEY) ?? "{}";
  const parsed = JSON.parse(raw) as { entries?: Array<{ key: unknown[] }> };
  return (parsed.entries ?? []).map((entry) => (entry.key[0] as string[]).join("."));
}

beforeEach(() => {
  store = new Map();
  installStorage();
});

describe("offline query cache", () => {
  it("brings a conversation and its messages back on a launch with no connection", () => {
    const before = new QueryClient();
    before.setQueryData(listKey, [{ id: "c1", title: "Ada" }]);
    before.setQueryData(messagesKey, [{ id: "m1", body: "hello" }]);

    persistQueryCache(before);

    const after = new QueryClient();
    expect(restoreQueryCache(after)).toBe(2);
    expect(after.getQueryData(listKey)).toEqual([{ id: "c1", title: "Ada" }]);
    expect(after.getQueryData(messagesKey)).toEqual([{ id: "m1", body: "hello" }]);
  });

  it("restores the original age, so restored data is still treated as stale", () => {
    // Without this React Query would call a week-old conversation list brand new and decline to
    // refetch it, which is how a restored cache turns into a permanently out-of-date screen.
    const before = new QueryClient();
    before.setQueryData(listKey, [], { updatedAt: 1_700_000_000_000 });
    persistQueryCache(before);

    const after = new QueryClient();
    restoreQueryCache(after);
    expect(after.getQueryState(listKey)?.dataUpdatedAt).toBe(1_700_000_000_000);
  });

  it("leaves out the answers that would be untrue or too large to keep", () => {
    const client = new QueryClient();
    client.setQueryData(listKey, [{ id: "c1" }]);
    // True for seconds, and a lie by the next launch.
    client.setQueryData(presenceKey, [{ online: true }]);
    // A single response can be a whole image in base64, which would evict the conversations.
    client.setQueryData(mediaKey, { base64: "a".repeat(4_000_000) });

    persistQueryCache(client);

    expect(storedPaths()).toEqual(["conversations.list"]);
  });

  it("keeps only what actually loaded", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery({ queryKey: listKey, queryFn: async () => [{ id: "c1" }], retry: false });
    await expect(
      client.fetchQuery({ queryKey: messagesKey, queryFn: async () => { throw new Error("no network"); }, retry: false }),
    ).rejects.toThrow();

    persistQueryCache(client);

    // Caching the failure would mean an app opened offline shows "could not load" about a request
    // that was never even attempted.
    expect(storedPaths()).toEqual(["conversations.list"]);
  });

  it("coalesces a burst of updates into a single write", async () => {
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      const stop = createCachePersister(client);

      client.setQueryData(listKey, [{ id: "c1" }]);
      client.setQueryData(messagesKey, [{ id: "m1" }]);
      client.setQueryData(presenceKey, [{ online: true }]);
      expect(store.has(STORAGE_KEY)).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);

      expect(store.has(STORAGE_KEY)).toBe(true);
      expect(storedPaths()).toEqual(["conversations.list", "conversations.messages"]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("signing out takes the copy with it", () => {
    const client = new QueryClient();
    client.setQueryData(listKey, [{ id: "c1" }]);
    persistQueryCache(client);
    expect(store.has(STORAGE_KEY)).toBe(true);

    clearQueryCache();

    expect(store.has(STORAGE_KEY)).toBe(false);
    expect(restoreQueryCache(new QueryClient())).toBe(0);
  });

  it("survives a payload this build cannot read", () => {
    store.set(STORAGE_KEY, "{ this is not json");
    expect(restoreQueryCache(new QueryClient())).toBe(0);
  });

  it("degrades to no cache at all when storage is unavailable", () => {
    // A private window, a browser with storage switched off, or any non-web build. The app has to
    // keep working; it just has nothing to read on the next launch.
    Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: undefined });

    const client = new QueryClient();
    client.setQueryData(listKey, [{ id: "c1" }]);

    expect(() => persistQueryCache(client)).not.toThrow();
    expect(restoreQueryCache(new QueryClient())).toBe(0);
    expect(() => clearQueryCache()).not.toThrow();
  });
});
