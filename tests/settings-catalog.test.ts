import { describe, expect, it } from "vitest";

import { SETTINGS_ENTRIES, searchSettings, visibleSettingsEntries } from "../lib/settings-catalog";

const ids = (query: string, isAdmin = false) => searchSettings(query, isAdmin).map((entry) => entry.id);

describe("settings catalogue", () => {
  it("gives every entry a unique id", () => {
    const seen = new Set(SETTINGS_ENTRIES.map((entry) => entry.id));
    expect(seen.size).toBe(SETTINGS_ENTRIES.length);
  });

  it("gives every entry a title, a subtitle and keywords", () => {
    for (const entry of SETTINGS_ENTRIES) {
      expect(entry.title.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.subtitle.trim().length, entry.id).toBeGreaterThan(0);
      // Without keywords an entry is only findable by words the user would have to already know.
      expect(entry.keywords.trim().length, entry.id).toBeGreaterThan(0);
    }
  });

  it("hides admin-only entries from everyone else", () => {
    expect(visibleSettingsEntries(false).some((entry) => entry.id === "admin")).toBe(false);
    expect(visibleSettingsEntries(true).some((entry) => entry.id === "admin")).toBe(true);
  });
});

describe("settings search", () => {
  it("returns everything the viewer may see for an empty query", () => {
    // A search screen that starts blank reads as broken. "Everything" still means everything that
    // viewer is allowed, so a non-admin does not get the count that includes the admin row.
    expect(searchSettings("").length).toBe(visibleSettingsEntries(false).length);
    expect(searchSettings("   ").length).toBe(visibleSettingsEntries(false).length);
    expect(searchSettings("", true).length).toBe(SETTINGS_ENTRIES.length);
  });

  it("matches on the title", () => {
    expect(ids("notif")).toContain("notifications");
    expect(ids("storage")).toContain("storage");
  });

  it("matches on words that are not in the title", () => {
    // The point of the keyword list: nobody searches for "two-step".
    expect(ids("fingerprint")).toEqual(["security"]);
    expect(ids("pin")).toContain("security");
    expect(ids("signed in")).toEqual(["devices"]);
    expect(ids("avatar")).toEqual(["profile"]);
  });

  it("ranks a title match above a keyword-only match", () => {
    // "block" appears in Privacy's keywords and in Blocked contacts' title.
    const results = ids("block");
    expect(results[0]).toBe("blocked");
    expect(results).toContain("privacy");
  });

  it("requires every term to appear, so a second word narrows rather than widens", () => {
    const broad = ids("chat");
    const narrowed = ids("chat theme");
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.length).toBeLessThanOrEqual(broad.length);
    expect(narrowed).toContain("chats");
  });

  it("is case insensitive", () => {
    expect(ids("STORAGE")).toEqual(ids("storage"));
  });

  it("returns nothing when nothing matches", () => {
    expect(ids("zzzzz")).toEqual([]);
  });

  it("does not surface an admin entry to a non-admin", () => {
    expect(ids("moderation")).toEqual([]);
    expect(ids("moderation", true)).toEqual(["admin"]);
  });
});
