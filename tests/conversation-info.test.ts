import { describe, expect, it } from "vitest";

import { describeConversation, isStrandedGroup } from "../lib/conversation-info";

/**
 * The reported bug: a one-to-one chat opened "Group info" when its name was tapped.
 *
 * The header used to push to the group screen unconditionally, so the screen you landed on said
 * nothing about what the conversation was - it was always the group one. These cases pin the
 * decision to `kind`, which is the only field that actually knows, and pin the two shapes that must
 * not be confused with each other.
 */

describe("describeConversation", () => {
  it("sends a one-to-one chat to the contact screen, not the group screen", () => {
    const info = describeConversation({ kind: "direct", memberCount: 2 });
    expect(info.direct).toBe(true);
    expect(info.route).toBe("/chat/contact-info");
  });

  it("sends a group to the group screen", () => {
    const info = describeConversation({ kind: "group", memberCount: 5 });
    expect(info.direct).toBe(false);
    expect(info.route).toBe("/chat/group-info");
  });

  it("treats a two-person group as a group", () => {
    // The tempting shortcut is "two members means direct". It would relabel every small group and
    // hide its member list and invite link from somebody who needs them.
    const info = describeConversation({ kind: "group", memberCount: 2 });
    expect(info.direct).toBe(false);
    expect(info.route).toBe("/chat/group-info");
  });

  it("says what is behind the header, so the wrong screen cannot pass unnoticed", () => {
    // The subtitle is the one place somebody learns what tapping the name does. It used to read
    // "tap for group info" on a group and nothing at all on a direct chat.
    expect(describeConversation({ kind: "direct", memberCount: 2 }).subtitle).toBe("tap for contact info");
    expect(describeConversation({ kind: "group", memberCount: 3 }).subtitle).toBe("tap for group info");
  });

  it("falls back to the contact screen when the kind is missing", () => {
    // Rows predating the column, or a client reading a stale cached list. Opening the lighter screen
    // is the safer default: it has no leave-group, no invite link and no admin controls to misuse.
    expect(describeConversation({}).direct).toBe(true);
    expect(describeConversation({ kind: null }).route).toBe("/chat/contact-info");
  });
});

describe("isStrandedGroup", () => {
  it("flags a group with nobody else in it", () => {
    // The visible symptom of a chat whose messages are delivered to nobody.
    expect(isStrandedGroup({ kind: "group", memberCount: 1 })).toBe(true);
    expect(isStrandedGroup({ kind: "group", memberCount: 0 })).toBe(true);
  });

  it("does not flag a group that has other people", () => {
    expect(isStrandedGroup({ kind: "group", memberCount: 2 })).toBe(false);
    expect(isStrandedGroup({ kind: "group", memberCount: 40 })).toBe(false);
  });

  it("does not flag a direct chat", () => {
    // A 1:1 is between two people by construction, and the count is not the test for it.
    expect(isStrandedGroup({ kind: "direct", memberCount: 2 })).toBe(false);
    expect(isStrandedGroup({ kind: "direct", memberCount: 1 })).toBe(false);
  });
});
