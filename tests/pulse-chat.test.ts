import { describe, expect, it } from "vitest";

import { appendMessage, filterConversations, type PulseMessage } from "../lib/pulse-chat";

describe("Pulse chat utilities", () => {
  const conversations = [
    { name: "Maya Chen", preview: "The new collection looks incredible." },
    { name: "Design Circle", preview: "I’ll share the prototype at 3." },
  ];

  it("filters by contact name or preview text, case-insensitively", () => {
    expect(filterConversations(conversations, "maya")).toHaveLength(1);
    expect(filterConversations(conversations, "PROTOTYPE")[0].name).toBe("Design Circle");
    expect(filterConversations(conversations, "  ")).toEqual(conversations);
  });

  it("appends a new message without mutating the previous list", () => {
    const first: PulseMessage = { id: "m1", text: "Hello", time: "9:00 AM" };
    const second: PulseMessage = { id: "m2", text: "Hi back", time: "9:01 AM", mine: true };
    const original = [first];
    const next = appendMessage(original, second);

    expect(original).toEqual([first]);
    expect(next).toEqual([first, second]);
  });
});
