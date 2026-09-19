import { describe, expect, it } from "vitest";

import { completeMention, mentionQuery, mentionedNames, parseMentions } from "../lib/mentions";

const NAMES = ["Ann", "Anna", "Ben Okafor", "Ben"];

describe("parseMentions", () => {
  it("marks a mention and leaves the rest plain", () => {
    expect(parseMentions("hi @Ann how are you", NAMES)).toEqual([
      { text: "hi ", mention: false },
      { text: "@Ann", mention: true },
      { text: " how are you", mention: false },
    ]);
  });

  it("prefers the longest name, so a two-word member is not truncated to their first name", () => {
    const segments = parseMentions("@Ben Okafor please review", ["Ben", "Ben Okafor"]);
    expect(segments[0]).toEqual({ text: "@Ben Okafor", mention: true });
  });

  it("does not match a shorter name inside a longer one", () => {
    // "@Anna" must not highlight "@Ann" - they are different people.
    const segments = parseMentions("@Anna hello", ["Ann"]);
    expect(segments.every((segment) => !segment.mention)).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(mentionedNames("hey @ann", ["Ann"])).toEqual(["Ann"]);
  });

  it("returns the caller's spelling, not what was typed", () => {
    expect(mentionedNames("@ANN and @bEn", ["Ann", "Ben"])).toEqual(["Ann", "Ben"]);
  });

  it("ignores an @ that does not name anyone", () => {
    expect(mentionedNames("meet at 5 @ the cafe", NAMES)).toEqual([]);
  });

  it("does not treat an email address as a mention", () => {
    expect(mentionedNames("write to ben@Ann.com", NAMES)).toEqual([]);
  });

  it("finds several mentions in one message", () => {
    expect(mentionedNames("@Ann @Ben ping", NAMES)).toEqual(["Ann", "Ben"]);
  });

  it("returns a single plain run when nothing matches", () => {
    expect(parseMentions("nothing to see", NAMES)).toEqual([{ text: "nothing to see", mention: false }]);
  });

  it("handles empty input and an empty member list", () => {
    expect(parseMentions("", NAMES)).toEqual([]);
    expect(parseMentions("@Ann", [])).toEqual([{ text: "@Ann", mention: false }]);
  });
});

describe("mentionQuery", () => {
  it("picks up the fragment after a trailing @", () => {
    expect(mentionQuery("hello @an")).toBe("an");
  });

  it("reports an empty fragment right after @", () => {
    expect(mentionQuery("hello @")).toBe("");
  });

  it("ignores an @ earlier in the sentence", () => {
    // Otherwise the menu would stay open for the rest of the message.
    expect(mentionQuery("@Ann hello there")).toBeNull();
  });

  it("is null when there is no @ at all", () => {
    expect(mentionQuery("plain text")).toBeNull();
  });
});

describe("completeMention", () => {
  it("replaces the fragment and leaves a space to keep typing", () => {
    expect(completeMention("hello @an", "Ann")).toBe("hello @Ann ");
  });

  it("handles a mention at the very start", () => {
    expect(completeMention("@be", "Ben")).toBe("@Ben ");
  });

  it("leaves earlier text untouched", () => {
    expect(completeMention("ask @an about it", "Ann")).toBe("ask @an about it");
  });
});
