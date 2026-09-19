import { describe, expect, it } from "vitest";

import { PRESENCE_WINDOW_MS, TYPING_LEASE_MS, presenceViewFor, type PresenceRow } from "../server/db";

/** A fixed "now" so the window and lease arithmetic is decided by the code, not the clock. */
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const ME = 7;
const CHAT = "direct-1-4";

function row(overrides: Partial<PresenceRow> = {}): PresenceRow {
  return { userId: ME, lastSeenAt: new Date(NOW), typingConversationId: null, typingUntil: null, ...overrides };
}

describe("presenceViewFor", () => {
  it("treats a heartbeat inside the window as online", () => {
    const view = presenceViewFor(ME, row({ lastSeenAt: new Date(NOW - PRESENCE_WINDOW_MS + 1_000) }), false, NOW);
    expect(view.online).toBe(true);
  });

  it("treats a heartbeat older than the window as offline, but still reports last seen", () => {
    const stale = new Date(NOW - PRESENCE_WINDOW_MS - 1);
    const view = presenceViewFor(ME, row({ lastSeenAt: stale }), false, NOW);
    expect(view.online).toBe(false);
    expect(view.lastSeenAt).toEqual(stale);
  });

  it("does not report online exactly at the window boundary", () => {
    // Guards the comparison: `now - lastSeen < window` must exclude the boundary itself.
    const view = presenceViewFor(ME, row({ lastSeenAt: new Date(NOW - PRESENCE_WINDOW_MS) }), false, NOW);
    expect(view.online).toBe(false);
  });

  it("reports typing while the lease is live", () => {
    const view = presenceViewFor(ME, row({ typingConversationId: CHAT, typingUntil: new Date(NOW + TYPING_LEASE_MS) }), false, NOW);
    expect(view.typingIn).toBe(CHAT);
  });

  it("ignores a typing lease that has expired", () => {
    const view = presenceViewFor(ME, row({ typingConversationId: CHAT, typingUntil: new Date(NOW - 1) }), false, NOW);
    expect(view.typingIn).toBeNull();
  });

  it("ignores a live lease with no conversation attached to it", () => {
    // Defensive: a lease with no target cannot be attributed to a chat, so it must not surface.
    const view = presenceViewFor(ME, row({ typingConversationId: null, typingUntil: new Date(NOW + TYPING_LEASE_MS) }), false, NOW);
    expect(view.typingIn).toBeNull();
  });

  it("hides online AND last seen when the reader's counterpart has last-seen switched off", () => {
    const view = presenceViewFor(ME, row({ lastSeenAt: new Date(NOW) }), true, NOW);
    expect(view.online).toBe(false);
    expect(view.lastSeenAt).toBeNull();
  });

  it("still reports typing when last-seen is hidden", () => {
    // Deliberate, and the reason this test exists: hiding last-seen must not silently disable an
    // indicator the other person is actively sending.
    const view = presenceViewFor(ME, row({ typingConversationId: CHAT, typingUntil: new Date(NOW + 1_000) }), true, NOW);
    expect(view.typingIn).toBe(CHAT);
    expect(view.online).toBe(false);
  });

  it("reports nothing for someone with no presence row at all", () => {
    const view = presenceViewFor(ME, undefined, false, NOW);
    expect(view).toEqual({ userId: ME, online: false, lastSeenAt: null, typingIn: null });
  });

  it("keeps the window generous enough for one missed 20s heartbeat", () => {
    // The client beats every 20s; the window has to survive a single dropped beat or the dot
    // would flicker off for anyone on a flaky connection.
    expect(PRESENCE_WINDOW_MS).toBeGreaterThan(40_000);
    // And the lease has to outlast the 4s re-send interval in the typing effect.
    expect(TYPING_LEASE_MS).toBeGreaterThan(4_000);
  });
});
