/**
 * Manual integration check for the messaging features behind migration 0002.
 *
 *   set -a; . ../.secrets/db.env; set +a
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-messaging.ts
 *
 * It exercises the real query functions against a real database: reactions, stars, edits,
 * per-member flags, delivery cursors and the enriched message shape. Everything it writes is
 * removed again, and the two members' flags are restored to what they were, so running it
 * against the live database is safe.
 */
import {
  createMessage,
  deleteMessageForEveryone,
  editMessageBody,
  findOrCreateDirectConversation,
  listConversationsForUser,
  listMessages,
  listStarredMessages,
  markConversationDelivered,
  reactToMessage,
  setConversationMemberFlags,
  setMessageStar,
} from "../server/db";
import { getDb } from "../server/db";
import { conversationMembers, messages, users } from "../drizzle/schema";
import { and, eq, inArray } from "drizzle-orm";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!condition) failures += 1;
}

async function main() {
  const db = await getDb();
  if (!db) throw new Error("no database: is DATABASE_URL set?");

  const people = await db.select({ id: users.id, name: users.name }).from(users).orderBy(users.id).limit(2);
  if (people.length < 2) throw new Error("need at least two users to run this check");
  const [a, b] = people;
  console.log(`using users ${a.id} and ${b.id}`);

  const direct = await findOrCreateDirectConversation(a.id, b.id);
  if (!direct) throw new Error("could not open a direct conversation");
  const conversationId = direct.conversationId;

  // Remember the flags so they can be put back exactly as they were.
  const before = await db
    .select()
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, a.id)));
  const original = before[0];

  const messageId = `verify-${Date.now()}`;
  try {
    console.log("\n[1] send + react + star + edit");
    await createMessage({ id: messageId, conversationId, senderId: a.id, body: "verify original", kind: "text" });
    await reactToMessage(messageId, b.id, "👍");
    await setMessageStar(messageId, a.id, true);
    const edited = await editMessageBody(messageId, a.id, "verify edited");
    check("author can edit their own message", edited === true);

    console.log("\n[2] edits are refused for other people");
    const foreignEdit = await editMessageBody(messageId, b.id, "not allowed");
    check("non-author cannot edit", foreignEdit === false);

    console.log("\n[3] listMessages returns the enriched shape");
    const rows = await listMessages(conversationId, a.id);
    const mine = rows.find((row) => row.id === messageId);
    check("own message is present", Boolean(mine));
    check("reaction is attached", (mine?.reactions ?? []).some((r) => r.emoji === "👍") === true);
    check("star flag comes back", mine?.starred === true);
    check("editedAt is stamped", Boolean(mine?.editedAt));
    check("tick status is a known value", mine?.status === "sent" || mine?.status === "read", String(mine?.status));

    console.log("\n[4] per-member flags and the chat list");
    await setConversationMemberFlags(conversationId, a.id, { pinned: true, muted: true, archived: true, draft: "half written" });
    await markConversationDelivered(conversationId, a.id);
    const list = await listConversationsForUser(a.id);
    const row = list.find((item) => item.id === conversationId);
    check("pinned flag round-trips", row?.pinned === true);
    check("muted flag round-trips", row?.muted === true);
    check("archived flag round-trips", row?.archived === true);
    check("draft round-trips", row?.draft === "half written", String(row?.draft));

    console.log("\n[5] hidden and expired messages are filtered out");
    const hiddenId = `verify-hidden-${Date.now()}`;
    await createMessage({ id: hiddenId, conversationId, senderId: b.id, body: "hide me", kind: "text" });
    await setMessageStar(hiddenId, a.id, true);
    const starredBefore = await listStarredMessages(a.id);
    check("starred list includes the message", starredBefore.some((m) => m.id === hiddenId));
    const { hideMessageForUser } = await import("../server/db");
    await hideMessageForUser(hiddenId, a.id);
    const afterHide = await listMessages(conversationId, a.id);
    check("hidden message no longer listed", !afterHide.some((m) => m.id === hiddenId));
    await db.delete(messages).where(eq(messages.id, hiddenId));

    console.log("\n[6] delete for everyone tombstones the row");
    await deleteMessageForEveryone(messageId, a.id);
    const afterDelete = await listMessages(conversationId, a.id);
    const tombstone = afterDelete.find((row) => row.id === messageId);
    check("row survives as a tombstone", Boolean(tombstone));
    check("deletedAt is set", Boolean(tombstone?.deletedAt));
    check("body is cleared", tombstone?.body === null);
  } finally {
    // Clean up: this check must leave nothing behind.
    console.log("\n[cleanup]");
    await db.delete(messages).where(inArray(messages.id, [messageId]));
    const { messageReactions, messageStars } = await import("../drizzle/schema");
    await db.delete(messageReactions).where(eq(messageReactions.messageId, messageId));
    await db.delete(messageStars).where(eq(messageStars.messageId, messageId));
    if (original) {
      await db
        .update(conversationMembers)
        .set({ archived: original.archived, muted: original.muted, pinned: original.pinned, draft: original.draft, lastDeliveredAt: original.lastDeliveredAt })
        .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, a.id)));
    }
    console.log("  removed test rows and restored member flags");
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("VERIFY FAILED:", error);
  process.exit(1);
});
