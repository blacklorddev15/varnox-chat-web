import { and, desc, eq, gt, ilike, inArray, isNull, like, lt, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { appeals, authTokens, blockedContacts, calls, channelFollowers, channelPosts, channels, conversationMembers, conversations, InsertUser, messageHides, messageMedia, messageReactions, messageStars, messages, presence, pushTokens, statusUpdates, statusViews, userAvatars, userSettings, users } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: Pool | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try { _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); _db = drizzle(_pool); }
    catch (error) { console.warn("[Database] Failed to connect:", error); _db = null; }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  // Explicit allowlist: anything missing here is silently dropped on insert, which is how
  // the phone number passed from registration used to be lost.
  const textFields = ["name", "email", "username", "passwordHash", "loginMethod", "moderationReason", "phone"] as const;
  for (const field of textFields) {
    if (user[field] !== undefined) { values[field] = user[field] ?? null; updateSet[field] = user[field] ?? null; }
  }
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
  if (user.moderationStatus !== undefined) { values.moderationStatus = user.moderationStatus; updateSet.moderationStatus = user.moderationStatus; }
  if (user.suspendedUntil !== undefined) { values.suspendedUntil = user.suspendedUntil; updateSet.suspendedUntil = user.suspendedUntil; }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
  await db.insert(users).values(values).onConflictDoUpdate({ target: users.openId, set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function getUserByUsername(username: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return result[0];
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0];
}

export async function listUsersForAdmin() {
  const db = await getDb();
  if (!db) return [];
  return db.select({ id: users.id, openId: users.openId, username: users.username, name: users.name, email: users.email, role: users.role, moderationStatus: users.moderationStatus, suspendedUntil: users.suspendedUntil, moderationReason: users.moderationReason, createdAt: users.createdAt, lastSignedIn: users.lastSignedIn }).from(users).orderBy(desc(users.createdAt)).limit(200);
}

export async function moderateUser(id: number, status: "active" | "suspended" | "banned", suspendedUntil: Date | null, reason: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.update(users).set({ moderationStatus: status, suspendedUntil, moderationReason: reason }).where(eq(users.id, id));
  return getUserById(id);
}

export async function isConversationMember(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return false;
  const result = await db.select({ userId: conversationMembers.userId }).from(conversationMembers).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId))).limit(1);
  return result.length > 0;
}

/**
 * Conversations for a user, each with what a chat list and an alert needs: the other
 * participant (direct chats), the newest message, and an unread count derived from the
 * member's lastReadAt. The client previously rendered a hardcoded list, so this is the
 * first real consumer of these rows.
 */
export async function listConversationsForUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ conversation: conversations, member: conversationMembers })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversationMembers.conversationId, conversations.id))
    .where(eq(conversationMembers.userId, userId))
    .orderBy(desc(conversations.updatedAt));

  const result = [];
  // Messages this user hid ("delete for me") must never come back as a preview or a badge.
  const hidden = await db.select({ messageId: messageHides.messageId }).from(messageHides).where(eq(messageHides.userId, userId));
  const hiddenIds = new Set(hidden.map((row) => row.messageId));

  for (const { conversation, member } of rows) {
    const members = await db
      .select({
        userId: conversationMembers.userId,
        lastReadAt: conversationMembers.lastReadAt,
        name: users.name,
        username: users.username,
        avatarUpdatedAt: users.avatarUpdatedAt,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(eq(conversationMembers.conversationId, conversation.id));

    const mine = members.find((m) => m.userId === userId) ?? null;
    const other = members.find((m) => m.userId !== userId) ?? null;

    // Walk back a few rows rather than one: a hidden or expired message must not become the
    // preview, and taking only the newest would leave the row looking empty while the chat is not.
    const recent = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(desc(messages.createdAt))
      .limit(20);
    const nowMs = Date.now();
    const latest = recent.filter((m) => !hiddenIds.has(m.id) && (!m.expiresAt || m.expiresAt.getTime() > nowMs));

    const unreadWhere = mine?.lastReadAt
      ? and(eq(messages.conversationId, conversation.id), ne(messages.senderId, userId), gt(messages.createdAt, mine.lastReadAt))
      : and(eq(messages.conversationId, conversation.id), ne(messages.senderId, userId));
    const unreadRows = await db.select({ id: messages.id, expiresAt: messages.expiresAt }).from(messages).where(unreadWhere);
    const unread = unreadRows.filter((row) => !hiddenIds.has(row.id) && (!row.expiresAt || row.expiresAt.getTime() > nowMs));

    result.push({
      id: conversation.id,
      title: conversation.title,
      kind: conversation.kind,
      updatedAt: conversation.updatedAt,
      memberCount: members.length,
      otherMember: other
        ? { id: other.userId, name: other.name, username: other.username, avatarUpdatedAt: other.avatarUpdatedAt }
        : null,
      description: conversation.description,
      disappearSeconds: conversation.disappearSeconds,
      lastMessage: latest[0] ?? null,
      unreadCount: unread.length,
      archived: member.archived === 1,
      muted: member.muted === 1,
      pinned: member.pinned === 1,
      draft: member.draft ?? null,
    });
  }
  return result;
}

/** Stores attachment bytes in the database (used when object storage is not configured). */
export async function saveMessageMedia(ownerId: number, mimeType: string, fileName: string, base64: string) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const rows = await db
    .insert(messageMedia)
    .values({ ownerId, mimeType, fileName, data: base64 })
    .returning({ id: messageMedia.id });
  return rows[0]?.id;
}

export async function getMessageMedia(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(messageMedia).where(eq(messageMedia.id, id)).limit(1);
  return rows[0];
}

/** Searches message text inside the conversations the user is a member of. */
export async function searchMessages(userId: number, query: string, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ message: messages, conversation: conversations, senderName: users.name, senderUsername: users.username })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(
      conversationMembers,
      and(eq(conversationMembers.conversationId, messages.conversationId), eq(conversationMembers.userId, userId)),
    )
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(ilike(messages.body, `%${query}%`))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.message.id,
    conversationId: row.message.conversationId,
    conversationTitle: row.conversation.title,
    body: row.message.body,
    kind: row.message.kind,
    mediaName: row.message.mediaName,
    createdAt: row.message.createdAt,
    senderId: row.message.senderId,
    senderName: row.senderName,
    senderUsername: row.senderUsername,
  }));
}

/** Marks a conversation as read for one member, which is what drives the unread badge. */
export async function markConversationRead(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(conversationMembers)
    .set({ lastReadAt: new Date() })
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
}

/** The caller's role in a conversation: "owner" | "admin" | "member", or undefined if absent. */
export async function getConversationRole(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select({ role: conversationMembers.role })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
    .limit(1);
  return rows[0]?.role;
}

/** Members of a conversation, with the profile fields the group screen needs. */
export async function listConversationMembersDetailed(conversationId: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      userId: conversationMembers.userId,
      role: conversationMembers.role,
      joinedAt: conversationMembers.joinedAt,
      name: users.name,
      username: users.username,
      avatarUpdatedAt: users.avatarUpdatedAt,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(eq(conversationMembers.conversationId, conversationId));
}

/**
 * Creates a group conversation: the creator becomes the owner, everyone else a member.
 * A first message is inserted so a brand new group is not an empty screen.
 */
export async function createGroupConversation(creatorId: number, title: string, memberIds: number[]) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const id = `grp_${crypto.randomUUID()}`;
  const members = Array.from(new Set([creatorId, ...memberIds])).filter((value) => Number.isInteger(value));

  await db.transaction(async (tx) => {
    await tx.insert(conversations).values({ id, kind: "group", title, createdBy: creatorId });
    await tx.insert(conversationMembers).values(
      members.map((userId) => ({
        conversationId: id,
        userId,
        role: userId === creatorId ? "owner" : "member",
      })),
    );
    await tx.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId: id,
      senderId: creatorId,
      kind: "text",
      body: `Created the group "${title}"`,
    });
  });

  return id;
}

/** Adds members to a group, skipping anyone already in it. Returns how many were added. */
export async function addConversationMembers(conversationId: string, userIds: number[]) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const rows = userIds
    .filter((value) => Number.isInteger(value))
    .map((userId) => ({ conversationId, userId, role: "member" }));
  if (rows.length === 0) return 0;
  const inserted = await db.insert(conversationMembers).values(rows).onConflictDoNothing().returning({ userId: conversationMembers.userId });
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  return inserted.length;
}

export async function setConversationMemberRole(conversationId: string, userId: number, role: string) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db
    .update(conversationMembers)
    .set({ role })
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
}

export async function removeConversationMember(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db
    .delete(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
}

// ---------------------------------------------------------------- calls

export async function createCallRecord(conversationId: string, initiatorId: number, room: string, kind: string) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const id = crypto.randomUUID();
  await db.insert(calls).values({ id, conversationId, initiatorId, room, kind, status: "ringing" });
  return id;
}

export async function getCallRecord(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(calls).where(eq(calls.id, id)).limit(1);
  return rows[0];
}

/** A call that has been ringing for more than a minute was never answered. */
export async function expireStaleCalls(conversationId: string) {
  const db = await getDb();
  if (!db) return;
  const cutoff = new Date(Date.now() - 60_000);
  await db
    .update(calls)
    .set({ status: "missed", endedAt: new Date() })
    .where(and(eq(calls.conversationId, conversationId), eq(calls.status, "ringing"), lt(calls.startedAt, cutoff)));
}

export async function setCallStatus(id: string, status: string) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const patch: Record<string, unknown> = { status };
  if (status === "active") patch.answeredAt = new Date();
  if (status === "ended" || status === "missed" || status === "declined") patch.endedAt = new Date();
  await db.update(calls).set(patch).where(eq(calls.id, id));
}

/** A call currently ringing for this user, started by someone else, within the last minute. */
export async function getIncomingCallForUser(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const cutoff = new Date(Date.now() - 60_000);
  const rows = await db
    .select({ call: calls, title: conversations.title })
    .from(calls)
    .innerJoin(conversations, eq(conversations.id, calls.conversationId))
    .innerJoin(
      conversationMembers,
      and(eq(conversationMembers.conversationId, calls.conversationId), eq(conversationMembers.userId, userId)),
    )
    .where(and(eq(calls.status, "ringing"), ne(calls.initiatorId, userId), gt(calls.startedAt, cutoff)))
    .orderBy(desc(calls.startedAt))
    .limit(1);

  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.call.id,
    conversationId: row.call.conversationId,
    conversationTitle: row.title,
    kind: row.call.kind,
    initiatorId: row.call.initiatorId,
    startedAt: row.call.startedAt,
  };
}

/** Recent calls across the user's conversations, for the Calls tab. */
export async function listRecentCalls(userId: number, limit = 30) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ call: calls, title: conversations.title })
    .from(calls)
    .innerJoin(conversations, eq(conversations.id, calls.conversationId))
    .innerJoin(
      conversationMembers,
      and(eq(conversationMembers.conversationId, calls.conversationId), eq(conversationMembers.userId, userId)),
    )
    .orderBy(desc(calls.startedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.call.id,
    conversationId: row.call.conversationId,
    conversationTitle: row.title,
    initiatorId: row.call.initiatorId,
    outgoing: row.call.initiatorId === userId,
    kind: row.call.kind,
    status: row.call.status,
    startedAt: row.call.startedAt,
    endedAt: row.call.endedAt,
  }));
}

/**
 * Messages in a conversation, enriched with everything the chat screen renders: the quoted reply,
 * reactions, stars, edit and delete state, and the tick status of the caller's own messages.
 *
 * Expired (disappearing) and hidden ("delete for me") rows are filtered here rather than in the
 * client, so a second device cannot display what the first one removed.
 */
export async function listMessages(conversationId: string, userId: number, since?: Date) {
  const db = await getDb();
  if (!db || !(await isConversationMember(conversationId, userId))) return [];
  const whereClause = since
    ? and(eq(messages.conversationId, conversationId), gt(messages.createdAt, since))
    : eq(messages.conversationId, conversationId);

  const rows = await db.select().from(messages).where(whereClause).orderBy(messages.createdAt);
  if (rows.length === 0) return [];

  const nowMs = Date.now();
  const ids = rows.map((row) => row.id);

  // Per-person extras, fetched in bulk so a long thread stays at a handful of queries.
  const hidden = await db.select({ messageId: messageHides.messageId }).from(messageHides).where(and(eq(messageHides.userId, userId), inArray(messageHides.messageId, ids)));
  const hiddenIds = new Set(hidden.map((row) => row.messageId));
  const stars = await db.select({ messageId: messageStars.messageId }).from(messageStars).where(and(eq(messageStars.userId, userId), inArray(messageStars.messageId, ids)));
  const starredIds = new Set(stars.map((row) => row.messageId));

  const reactionRows = await db
    .select({ messageId: messageReactions.messageId, userId: messageReactions.userId, emoji: messageReactions.emoji, name: users.name, username: users.username })
    .from(messageReactions)
    .leftJoin(users, eq(users.id, messageReactions.userId))
    .where(inArray(messageReactions.messageId, ids));

  const reactionsByMessage = new Map<string, Array<{ userId: number; emoji: string; name: string }>>();
  for (const row of reactionRows) {
    const list = reactionsByMessage.get(row.messageId) ?? [];
    list.push({ userId: row.userId, emoji: row.emoji, name: row.name ?? row.username ?? "Someone" });
    reactionsByMessage.set(row.messageId, list);
  }

  // Quoted messages are fetched by id, and may themselves already have been deleted.
  const replyIds = [...new Set(rows.map((row) => row.replyToId).filter((id): id is string => Boolean(id)))];
  const quoted = replyIds.length
    ? await db
        .select({ id: messages.id, body: messages.body, kind: messages.kind, mediaName: messages.mediaName, senderId: messages.senderId, deletedAt: messages.deletedAt, name: users.name, username: users.username })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.senderId))
        .where(inArray(messages.id, replyIds))
    : [];
  const quotedById = new Map(quoted.map((row) => [row.id, row]));

  // Ticks: one of my messages counts as read only once every other member's cursor has passed it.
  // Somebody who turned read receipts off never contributes a read, which is the point of the
  // setting - otherwise the toggle would be decorative.
  const others = await db
    .select({ lastReadAt: conversationMembers.lastReadAt, lastDeliveredAt: conversationMembers.lastDeliveredAt, readReceipts: userSettings.readReceipts })
    .from(conversationMembers)
    .leftJoin(userSettings, eq(userSettings.userId, conversationMembers.userId))
    .where(and(eq(conversationMembers.conversationId, conversationId), ne(conversationMembers.userId, userId)));

  const receiptOthers = others.filter((other) => other.readReceipts !== 0 && other.lastReadAt);
  const allReadAt = receiptOthers.length > 0 ? new Date(Math.min(...receiptOthers.map((other) => other.lastReadAt!.getTime()))) : null;
  const deliveredOthers = others.filter((other) => other.lastDeliveredAt);
  const allDeliveredAt = deliveredOthers.length > 0 ? new Date(Math.min(...deliveredOthers.map((other) => other.lastDeliveredAt!.getTime()))) : null;

  return rows
    .filter((row) => !hiddenIds.has(row.id) && (!row.expiresAt || row.expiresAt.getTime() > nowMs))
    .map((row) => {
      const quote = row.replyToId ? quotedById.get(row.replyToId) ?? null : null;
      const mine = row.senderId === userId;
      const status: "sent" | "delivered" | "read" | null = !mine ? null : allReadAt && allReadAt >= row.createdAt ? "read" : allDeliveredAt && allDeliveredAt >= row.createdAt ? "delivered" : "sent";
      return {
        ...row,
        starred: starredIds.has(row.id),
        reactions: reactionsByMessage.get(row.id) ?? [],
        replyTo: quote
          ? {
              id: quote.id,
              body: quote.deletedAt ? null : quote.body,
              kind: quote.kind,
              mediaName: quote.mediaName,
              senderId: quote.senderId,
              senderName: quote.name ?? quote.username ?? "Someone",
              deleted: Boolean(quote.deletedAt),
            }
          : null,
        status,
      };
    });
}

export async function createConversation(conversationId: string, createdBy: number, title?: string, memberIds: number[] = []) {
  const db = await getDb();
  if (!db) return;
  await db.insert(conversations).values({ id: conversationId, createdBy, title: title ?? null, kind: memberIds.length > 1 ? "group" : "direct" });
  await db.insert(conversationMembers).values([{ conversationId, userId: createdBy }, ...memberIds.filter((id) => id !== createdBy).map((userId) => ({ conversationId, userId }))]);
}

/**
 * Returns the existing 1:1 conversation between two users, creating it when there is none.
 *
 * Tapping a person in the new-conversation sheet used to only show a toast, so there was no
 * conversation to open and therefore no composer. This makes that tap idempotent: the second
 * tap on the same person reuses the same conversation instead of creating a duplicate thread.
 */
export async function findOrCreateDirectConversation(userId: number, otherUserId: number) {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select({ id: conversationMembers.conversationId })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(and(eq(conversations.kind, "direct"), inArray(conversationMembers.userId, [userId, otherUserId])));

  const memberCount = new Map<string, number>();
  for (const row of rows) memberCount.set(row.id, (memberCount.get(row.id) ?? 0) + 1);
  for (const [id, count] of memberCount) {
    if (count >= 2) return { conversationId: id, created: false };
  }

  // Stable id so the same pair can never end up with two parallel threads.
  const conversationId = `direct-${Math.min(userId, otherUserId)}-${Math.max(userId, otherUserId)}`;
  const existing = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (existing.length === 0) {
    await createConversation(conversationId, userId, undefined, [otherUserId]);
  } else {
    await addConversationMember(conversationId, userId);
    await addConversationMember(conversationId, otherUserId);
  }
  return { conversationId, created: true };
}

export async function addConversationMember(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.insert(conversationMembers).values({ conversationId, userId }).onConflictDoUpdate({ target: [conversationMembers.conversationId, conversationMembers.userId], set: { userId } });
}

export async function createMessage(input: typeof messages.$inferInsert) {
  const db = await getDb();
  if (!db) return input;
  await db.insert(messages).values(input);
  return input;
}

export async function listConversationMemberIds(conversationId: string) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ userId: conversationMembers.userId }).from(conversationMembers).where(eq(conversationMembers.conversationId, conversationId));
  return rows.map((row) => row.userId);
}

export async function registerPushToken(userId: number, token: string, platform?: string) {
  const db = await getDb();
  if (!db) return;
  await db.insert(pushTokens).values({ userId, token, platform: platform ?? null }).onConflictDoUpdate({ target: pushTokens.token, set: { userId, platform: platform ?? null, updatedAt: new Date() } });
}

export async function listPushTokens(userIds: number[]) {
  const db = await getDb();
  if (!db || userIds.length === 0) return [];
  const rows = await db.select({ token: pushTokens.token }).from(pushTokens).where(inArray(pushTokens.userId, userIds));
  return rows.map((row) => row.token);
}

export async function searchUsers(query: string, currentUserId: number) {
  const db = await getDb();
  if (!db) return [];
  const pattern = `%${query.trim()}%`;
  return db.select({ id: users.id, username: users.username, name: users.name, email: users.email, openId: users.openId }).from(users).where(and(ne(users.id, currentUserId), eq(users.moderationStatus, "active"), or(like(users.username, pattern), like(users.name, pattern), like(users.email, pattern)))).limit(20);
}


export async function getUserSettings(userId: number) {
  const db = await getDb();
  if (!db) return null;
  const existing = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  if (existing[0]) return existing[0];
  await db.insert(userSettings).values({ userId });
  const created = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  return created[0] ?? null;
}

export async function updateUserSettings(userId: number, patch: Partial<Omit<typeof userSettings.$inferInsert, "userId">>) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.insert(userSettings).values({ userId, ...patch }).onConflictDoUpdate({ target: userSettings.userId, set: { ...patch, updatedAt: new Date() } });
  return getUserSettings(userId);
}

export async function listBlockedContacts(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select({ id: users.id, username: users.username, name: users.name, email: users.email, createdAt: blockedContacts.createdAt }).from(blockedContacts).innerJoin(users, eq(users.id, blockedContacts.blockedUserId)).where(eq(blockedContacts.userId, userId)).orderBy(desc(blockedContacts.createdAt));
}

export async function setBlockedContact(userId: number, blockedUserId: number, blocked: boolean) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  if (blocked) await db.insert(blockedContacts).values({ userId, blockedUserId }).onConflictDoUpdate({ target: [blockedContacts.userId, blockedContacts.blockedUserId], set: { createdAt: new Date() } });
  else await db.delete(blockedContacts).where(and(eq(blockedContacts.userId, userId), eq(blockedContacts.blockedUserId, blockedUserId)));
  return listBlockedContacts(userId);
}

export async function createAppeal(userId: number, reason: string) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.insert(appeals).values({ userId, reason });
  const rows = await db.select().from(appeals).where(eq(appeals.userId, userId)).orderBy(desc(appeals.createdAt)).limit(1);
  return rows[0];
}

export async function listAppealsForUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(appeals).where(eq(appeals.userId, userId)).orderBy(desc(appeals.createdAt));
}

export async function listAppealsForAdmin() {
  const db = await getDb();
  if (!db) return [];
  return db.select({ appeal: appeals, username: users.username, name: users.name, email: users.email }).from(appeals).innerJoin(users, eq(users.id, appeals.userId)).orderBy(desc(appeals.createdAt)).limit(200);
}

export async function reviewAppeal(id: number, reviewerId: number, status: "approved" | "rejected", note: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const rows = await db.select().from(appeals).where(eq(appeals.id, id)).limit(1);
  const appeal = rows[0];
  if (!appeal) throw new Error("Appeal not found");
  await db.update(appeals).set({ status, reviewedBy: reviewerId, reviewNote: note }).where(eq(appeals.id, id));
  if (status === "approved") await db.update(users).set({ moderationStatus: "active", suspendedUntil: null, moderationReason: null }).where(eq(users.id, appeal.userId));
  return appeal;
}

export async function createAuthToken(userId: number, kind: string, tokenHash: string, expiresAt: Date) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.insert(authTokens).values({ userId, kind, tokenHash, expiresAt });
}

export async function consumeAuthToken(kind: string, tokenHash: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(authTokens).where(and(eq(authTokens.kind, kind), eq(authTokens.tokenHash, tokenHash))).limit(1);
  const token = rows[0];
  if (!token || token.usedAt || token.expiresAt < new Date()) return null;
  await db.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, token.id));
  return token;
}


export async function listPushTokensForPreference(userIds: number[], category: "messages" | "groups" | "calls") {
  const db = await getDb();
  if (!db || userIds.length === 0) return [];
  const field = category === "messages" ? userSettings.notificationsMessages : category === "groups" ? userSettings.notificationsGroups : userSettings.notificationsCalls;
  const rows = await db.select({ token: pushTokens.token }).from(pushTokens).leftJoin(userSettings, eq(userSettings.userId, pushTokens.userId)).where(and(inArray(pushTokens.userId, userIds), or(eq(field, 1), eq(field, null as any))));
  return rows.map((row) => row.token);
}


export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result[0];
}

export async function markEmailVerified(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
}

export async function updatePasswordHash(userId: number, passwordHash: string) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function updateUserProfile(userId: number, patch: { name?: string; about?: string; phone?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.about !== undefined) set.about = patch.about;
  if (patch.phone !== undefined) set.phone = patch.phone;
  await db.update(users).set(set).where(eq(users.id, userId));
  return getUserById(userId);
}

/** Stores the profile photo as base64 and stamps users.avatarUpdatedAt for cache-busting. */
export async function setUserAvatar(userId: number, mimeType: string, data: string) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const now = new Date();
  await db
    .insert(userAvatars)
    .values({ userId, mimeType, data, updatedAt: now })
    .onConflictDoUpdate({ target: userAvatars.userId, set: { mimeType, data, updatedAt: now } });
  await db.update(users).set({ avatarUpdatedAt: now, updatedAt: now }).where(eq(users.id, userId));
  return now;
}

export async function getUserAvatar(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(userAvatars).where(eq(userAvatars.userId, userId)).limit(1);
  return rows[0];
}

export async function clearUserAvatar(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.delete(userAvatars).where(eq(userAvatars.userId, userId));
  await db.update(users).set({ avatarUpdatedAt: null, updatedAt: new Date() }).where(eq(users.id, userId));
}

// ---------------------------------------------------------------- status updates

/** Everyone the user shares a conversation with: the audience a status update is visible to. */
export async function listContactIdsForUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const mine = await db.select({ conversationId: conversationMembers.conversationId }).from(conversationMembers).where(eq(conversationMembers.userId, userId));
  if (mine.length === 0) return [];
  const peers = await db.select({ userId: conversationMembers.userId }).from(conversationMembers).where(inArray(conversationMembers.conversationId, mine.map((row) => row.conversationId)));
  return Array.from(new Set(peers.map((row) => row.userId))).filter((id) => id !== userId);
}

export async function createStatus(input: { id: string; userId: number; kind: string; body: string | null; mediaUrl: string | null; background: string; expiresAt: Date }) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.insert(statusUpdates).values(input);
  return input.id;
}

/** Live statuses (unexpired, not moderated away) from the given authors, newest first. */
export async function listActiveStatusesByAuthors(authorIds: number[]) {
  const db = await getDb();
  if (!db || authorIds.length === 0) return [];
  return db
    .select({ id: statusUpdates.id, userId: statusUpdates.userId, kind: statusUpdates.kind, body: statusUpdates.body, mediaUrl: statusUpdates.mediaUrl, background: statusUpdates.background, createdAt: statusUpdates.createdAt, expiresAt: statusUpdates.expiresAt, authorName: users.name, authorUsername: users.username, authorAvatarUpdatedAt: users.avatarUpdatedAt })
    .from(statusUpdates)
    .innerJoin(users, eq(users.id, statusUpdates.userId))
    .where(and(inArray(statusUpdates.userId, authorIds), isNull(statusUpdates.removedAt), gt(statusUpdates.expiresAt, new Date())))
    .orderBy(desc(statusUpdates.createdAt))
    .limit(300);
}

export async function getStatus(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(statusUpdates).where(eq(statusUpdates.id, id)).limit(1);
  return rows[0];
}

/** Which of these statuses the viewer has already opened, so the ring can render as seen. */
export async function listViewedStatusIds(statusIds: string[], viewerId: number): Promise<string[]> {
  const db = await getDb();
  if (!db || statusIds.length === 0) return [];
  const rows = await db.select({ statusId: statusViews.statusId }).from(statusViews).where(and(inArray(statusViews.statusId, statusIds), eq(statusViews.viewerId, viewerId)));
  return rows.map((row) => row.statusId);
}

export async function markStatusViewed(statusId: string, viewerId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.insert(statusViews).values({ statusId, viewerId }).onConflictDoNothing();
}

export async function listStatusViewers(statusId: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ userId: users.id, name: users.name, username: users.username, viewedAt: statusViews.viewedAt })
    .from(statusViews)
    .innerJoin(users, eq(users.id, statusViews.viewerId))
    .where(eq(statusViews.statusId, statusId))
    .orderBy(desc(statusViews.viewedAt))
    .limit(200);
}

export async function deleteStatus(id: string, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.delete(statusUpdates).where(and(eq(statusUpdates.id, id), eq(statusUpdates.userId, userId)));
}

export async function listStatusesForAdmin(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ id: statusUpdates.id, userId: statusUpdates.userId, kind: statusUpdates.kind, body: statusUpdates.body, mediaUrl: statusUpdates.mediaUrl, createdAt: statusUpdates.createdAt, expiresAt: statusUpdates.expiresAt, removedAt: statusUpdates.removedAt, authorName: users.name, authorUsername: users.username })
    .from(statusUpdates)
    .innerJoin(users, eq(users.id, statusUpdates.userId))
    .orderBy(desc(statusUpdates.createdAt))
    .limit(limit);
}

/** Soft delete: the row stays for the audit trail, the feed filters it out. */
export async function adminRemoveStatus(id: string, adminId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.update(statusUpdates).set({ removedAt: new Date(), removedBy: adminId }).where(eq(statusUpdates.id, id));
}

// ---------------------------------------------------------------- channels

export async function createChannel(ownerId: number, name: string, description: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const id = `chn_${crypto.randomUUID()}`;
  await db.transaction(async (tx) => {
    await tx.insert(channels).values({ id, ownerId, name, description });
    // The owner follows their own channel so it appears under "Following" like any other.
    await tx.insert(channelFollowers).values({ channelId: id, userId: ownerId });
  });
  return id;
}

export async function getChannel(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
  return rows[0];
}

type ChannelRow = { id: string; ownerId: number; name: string; description: string | null; createdAt: Date; suspendedAt: Date | null };

/** Adds follower/post counts, the newest post time, and whether this user follows it. */
async function decorateChannels<T extends ChannelRow>(rows: T[], userId: number) {
  const db = await getDb();
  if (!db || rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const followers = await db.select({ channelId: channelFollowers.channelId, userId: channelFollowers.userId }).from(channelFollowers).where(inArray(channelFollowers.channelId, ids));
  const posts = await db.select({ channelId: channelPosts.channelId, createdAt: channelPosts.createdAt }).from(channelPosts).where(and(inArray(channelPosts.channelId, ids), isNull(channelPosts.removedAt)));
  return rows.map((row) => {
    const mine = posts.filter((post) => post.channelId === row.id);
    const newest = mine.reduce((latest, post) => Math.max(latest, post.createdAt.getTime()), 0);
    return { ...row, followerCount: followers.filter((f) => f.channelId === row.id).length, postCount: mine.length, lastPostAt: newest > 0 ? new Date(newest) : null, isFollowing: followers.some((f) => f.channelId === row.id && f.userId === userId), isOwner: row.ownerId === userId };
  });
}

export async function listChannelsForUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: channels.id, ownerId: channels.ownerId, name: channels.name, description: channels.description, createdAt: channels.createdAt, suspendedAt: channels.suspendedAt }).from(channels).orderBy(desc(channels.createdAt)).limit(200);
  return decorateChannels(rows, userId);
}

export async function searchChannels(query: string, userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: channels.id, ownerId: channels.ownerId, name: channels.name, description: channels.description, createdAt: channels.createdAt, suspendedAt: channels.suspendedAt }).from(channels).where(ilike(channels.name, `%${query}%`)).orderBy(desc(channels.createdAt)).limit(60);
  return decorateChannels(rows, userId);
}

export async function isChannelFollower(channelId: string, userId: number) {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ userId: channelFollowers.userId }).from(channelFollowers).where(and(eq(channelFollowers.channelId, channelId), eq(channelFollowers.userId, userId))).limit(1);
  return rows.length > 0;
}

export async function followChannel(channelId: string, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.insert(channelFollowers).values({ channelId, userId }).onConflictDoNothing();
}

export async function unfollowChannel(channelId: string, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.delete(channelFollowers).where(and(eq(channelFollowers.channelId, channelId), eq(channelFollowers.userId, userId)));
}

export async function listChannelFollowers(channelId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select({ userId: users.id, name: users.name, username: users.username, followedAt: channelFollowers.followedAt }).from(channelFollowers).innerJoin(users, eq(users.id, channelFollowers.userId)).where(eq(channelFollowers.channelId, channelId)).orderBy(desc(channelFollowers.followedAt)).limit(200);
}

export async function markChannelRead(channelId: string, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.update(channelFollowers).set({ lastReadAt: new Date() }).where(and(eq(channelFollowers.channelId, channelId), eq(channelFollowers.userId, userId)));
}

export async function listChannelPosts(channelId: string, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ id: channelPosts.id, channelId: channelPosts.channelId, authorId: channelPosts.authorId, body: channelPosts.body, mediaUrl: channelPosts.mediaUrl, createdAt: channelPosts.createdAt, authorName: users.name, authorUsername: users.username })
    .from(channelPosts)
    .innerJoin(users, eq(users.id, channelPosts.authorId))
    .where(and(eq(channelPosts.channelId, channelId), isNull(channelPosts.removedAt)))
    .orderBy(desc(channelPosts.createdAt))
    .limit(limit);
}

export async function createChannelPost(input: { id: string; channelId: string; authorId: number; body: string; mediaUrl: string | null }) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.transaction(async (tx) => {
    await tx.insert(channelPosts).values(input);
    await tx.update(channels).set({ updatedAt: new Date() }).where(eq(channels.id, input.channelId));
  });
  return input.id;
}

export async function removeChannelPost(postId: string, removedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.update(channelPosts).set({ removedAt: new Date(), removedBy }).where(eq(channelPosts.id, postId));
}

export async function getChannelPost(postId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(channelPosts).where(eq(channelPosts.id, postId)).limit(1);
  return rows[0];
}

export async function listChannelsForAdmin(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: channels.id, ownerId: channels.ownerId, name: channels.name, description: channels.description, createdAt: channels.createdAt, suspendedAt: channels.suspendedAt, suspendedReason: channels.suspendedReason, ownerName: users.name, ownerUsername: users.username }).from(channels).innerJoin(users, eq(users.id, channels.ownerId)).orderBy(desc(channels.createdAt)).limit(limit);
  const decorated = await decorateChannels(rows, -1);
  return rows.map((row, index) => ({ ...row, followerCount: decorated[index]?.followerCount ?? 0, postCount: decorated[index]?.postCount ?? 0, lastPostAt: decorated[index]?.lastPostAt ?? null }));
}

/** Suspending keeps the channel and its posts; it only blocks new posts. */
export async function setChannelSuspended(id: string, suspended: boolean, reason: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.update(channels).set({ suspendedAt: suspended ? new Date() : null, suspendedReason: suspended ? reason : null }).where(eq(channels.id, id));
}

export async function deleteChannel(id: string) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.transaction(async (tx) => {
    await tx.delete(channelPosts).where(eq(channelPosts.channelId, id));
    await tx.delete(channelFollowers).where(eq(channelFollowers.channelId, id));
    await tx.delete(channels).where(eq(channels.id, id));
  });
}

export async function listChannelPostsForAdmin(limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ id: channelPosts.id, channelId: channelPosts.channelId, authorId: channelPosts.authorId, body: channelPosts.body, createdAt: channelPosts.createdAt, removedAt: channelPosts.removedAt, channelName: channels.name, authorUsername: users.username })
    .from(channelPosts)
    .innerJoin(channels, eq(channels.id, channelPosts.channelId))
    .innerJoin(users, eq(users.id, channelPosts.authorId))
    .orderBy(desc(channelPosts.createdAt))
    .limit(limit);
}

/** A single channel with its counts, for the channel screen header. */
export async function getChannelDetail(id: string, userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select({ id: channels.id, ownerId: channels.ownerId, name: channels.name, description: channels.description, createdAt: channels.createdAt, suspendedAt: channels.suspendedAt, suspendedReason: channels.suspendedReason }).from(channels).where(eq(channels.id, id)).limit(1);
  if (rows.length === 0) return undefined;
  const [decorated] = await decorateChannels(rows, userId);
  return decorated;
}

// ---------------------------------------------------------------- message actions
// Everything the message menu does: react, star, edit, delete, view-once. Membership and ownership
// are checked in the router; these are the row-level operations themselves.

export async function getMessageById(messageId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  return rows[0];
}

/** One reaction per person per message: reacting again replaces the previous emoji. */
export async function reactToMessage(messageId: string, userId: number, emoji: string | null) {
  const db = await getDb();
  if (!db) return;
  if (emoji === null) {
    await db.delete(messageReactions).where(and(eq(messageReactions.messageId, messageId), eq(messageReactions.userId, userId)));
    return;
  }
  await db
    .insert(messageReactions)
    .values({ messageId, userId, emoji })
    .onConflictDoUpdate({ target: [messageReactions.messageId, messageReactions.userId], set: { emoji, createdAt: new Date() } });
}

export async function setMessageStar(messageId: string, userId: number, starred: boolean) {
  const db = await getDb();
  if (!db) return;
  if (starred) {
    await db.insert(messageStars).values({ messageId, userId }).onConflictDoNothing();
    return;
  }
  await db.delete(messageStars).where(and(eq(messageStars.messageId, messageId), eq(messageStars.userId, userId)));
}

/**
 * Only the author may edit, and only text: changing a photo would need a new upload, and letting
 * the body change without marking editedAt would silently rewrite history.
 */
export async function editMessageBody(messageId: string, userId: number, body: string) {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .update(messages)
    .set({ body, editedAt: new Date() })
    .where(and(eq(messages.id, messageId), eq(messages.senderId, userId), isNull(messages.deletedAt)))
    .returning({ id: messages.id });
  return rows.length > 0;
}

/**
 * "Delete for everyone": the row is tombstoned rather than removed, so both sides can honestly
 * show that something was deleted instead of the message quietly vanishing mid-conversation.
 */
export async function deleteMessageForEveryone(messageId: string, userId: number) {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .update(messages)
    .set({ deletedAt: new Date(), body: null, mediaUrl: null, mediaName: null, mediaMime: null, voiceDurationMs: null })
    .where(and(eq(messages.id, messageId), eq(messages.senderId, userId), isNull(messages.deletedAt)))
    .returning({ id: messages.id });
  if (rows.length === 0) return false;
  // Reactions attached to a tombstone are noise.
  await db.delete(messageReactions).where(eq(messageReactions.messageId, messageId));
  return true;
}

/** "Delete for me": hides the row from one reader, leaving it intact for everybody else. */
export async function hideMessageForUser(messageId: string, userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.insert(messageHides).values({ messageId, userId }).onConflictDoNothing();
}

/**
 * Opens a view-once attachment. The stored URL is dropped in the same request, so a second open -
 * on this device or any other - has nothing left to show. The sender cannot consume their own.
 */
export async function consumeViewOnce(messageId: string, userId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), ne(messages.senderId, userId), eq(messages.viewOnce, 1)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.mediaUrl) return null;
  await db.update(messages).set({ mediaUrl: null }).where(eq(messages.id, messageId));
  return { id: row.id, mediaUrl: row.mediaUrl, mediaName: row.mediaName, kind: row.kind };
}

/** Per-member chat preferences. Each one is personal, so they live on the membership row. */
export async function setConversationMemberFlags(
  conversationId: string,
  userId: number,
  flags: { archived?: boolean; muted?: boolean; pinned?: boolean; draft?: string | null },
) {
  const db = await getDb();
  if (!db) return;
  const patch: Record<string, unknown> = {};
  if (flags.archived !== undefined) patch.archived = flags.archived ? 1 : 0;
  if (flags.muted !== undefined) patch.muted = flags.muted ? 1 : 0;
  if (flags.pinned !== undefined) patch.pinned = flags.pinned ? 1 : 0;
  if (flags.draft !== undefined) patch.draft = flags.draft ? flags.draft.slice(0, 2000) : null;
  if (Object.keys(patch).length === 0) return;
  await db
    .update(conversationMembers)
    .set(patch)
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
}

/** A separate cursor from lastReadAt: delivered does not mean read. */
export async function markConversationDelivered(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(conversationMembers)
    .set({ lastDeliveredAt: new Date() })
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
}

export async function setConversationDescription(conversationId: string, description: string | null) {
  const db = await getDb();
  if (!db) return;
  await db.update(conversations).set({ description, updatedAt: new Date() }).where(eq(conversations.id, conversationId));
}

/** The per-chat disappearing timer. New messages inherit it; existing ones are left alone. */
export async function setConversationDisappearing(conversationId: string, seconds: number | null) {
  const db = await getDb();
  if (!db) return;
  await db.update(conversations).set({ disappearSeconds: seconds, updatedAt: new Date() }).where(eq(conversations.id, conversationId));
}

/** Everything this user starred, for the Starred messages screen. */
export async function listStarredMessages(userId: number, limit = 200) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ message: messages, starredAt: messageStars.createdAt, conversationTitle: conversations.title, name: users.name, username: users.username })
    .from(messageStars)
    .innerJoin(messages, eq(messages.id, messageStars.messageId))
    .innerJoin(conversationMembers, and(eq(conversationMembers.conversationId, messages.conversationId), eq(conversationMembers.userId, userId)))
    .leftJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(and(eq(messageStars.userId, userId), isNull(messages.deletedAt)))
    .orderBy(desc(messageStars.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.message.id,
    conversationId: row.message.conversationId,
    conversationTitle: row.conversationTitle,
    body: row.message.body,
    kind: row.message.kind,
    mediaName: row.message.mediaName,
    createdAt: row.message.createdAt,
    starredAt: row.starredAt,
    senderId: row.message.senderId,
    senderName: row.name ?? row.username ?? "Someone",
  }));
}

/** Adds the disappearing clock to an outgoing message, when the chat has a timer set. */
export async function conversationDisappearSeconds(conversationId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ seconds: conversations.disappearSeconds }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  return rows[0]?.seconds ?? null;
}

// ---------------------------------------------------------------- presence
/** A heartbeat stays trustworthy this long. Clients beat every 20s, so one miss is tolerated. */
export const PRESENCE_WINDOW_MS = 45_000;
/** How long one "typing" signal survives. The client re-sends it while the user keeps typing. */
export const TYPING_LEASE_MS = 8_000;

export type PresenceView = {
  userId: number;
  online: boolean;
  lastSeenAt: Date | null;
  /** The conversation this user is typing in, while that signal is still fresh. */
  typingIn: string | null;
};

/**
 * Records that a user is active now, and optionally that they are typing in one conversation.
 * Callers send their current state on every beat, so a plain beat clearing a stale typing flag is
 * correct rather than a race.
 */
export async function recordPresence(userId: number, typingConversationId?: string | null): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = new Date();
  const typingUntil = typingConversationId ? new Date(now.getTime() + TYPING_LEASE_MS) : null;
  try {
    await db
      .insert(presence)
      .values({ userId, lastSeenAt: now, typingConversationId: typingConversationId ?? null, typingUntil })
      .onConflictDoUpdate({ target: presence.userId, set: { lastSeenAt: now, typingConversationId: typingConversationId ?? null, typingUntil } });
  } catch (error) {
    // The table arrives with `pnpm db:push`. Until a deployment has run that, presence stays dark
    // rather than breaking the request that recorded it.
    console.warn("[Presence] heartbeat failed; has the presence table been migrated?", error);
  }
}

/**
 * Presence for a set of users, filtered to what the reader may see. The `lastSeen` privacy toggle
 * hides "online" *and* the last-seen time - they are the same disclosure, so honouring one while
 * leaking the other would defeat the setting.
 *
 * Typing is deliberately not gated by it: typing is an act the user performs towards this reader,
 * and the reference app treats it the same way. Hiding last-seen must not silently disable the
 * indicator someone else is actively sending.
 */
export type PresenceRow = {
  userId: number;
  lastSeenAt: Date | null;
  typingConversationId: string | null;
  typingUntil: Date | null;
};

/**
 * Turns one stored row into what a given reader may see.
 *
 * Pure on purpose: the freshness window and the typing lease are exactly the kind of arithmetic
 * that reads fine in review and shows the wrong thing in production, so both are tested without
 * needing a database.
 */
export function presenceViewFor(
  userId: number,
  row: PresenceRow | undefined,
  lastSeenHidden: boolean,
  now: number,
): PresenceView {
  const lastSeenAt = row?.lastSeenAt ?? null;
  const typing = Boolean(row?.typingUntil && row.typingUntil.getTime() > now && row.typingConversationId);
  return {
    userId,
    // Hiding last-seen hides "online" too: they are the same disclosure.
    online: !lastSeenHidden && Boolean(lastSeenAt && now - lastSeenAt.getTime() < PRESENCE_WINDOW_MS),
    lastSeenAt: lastSeenHidden ? null : lastSeenAt,
    // Typing is not gated by it - see the note above.
    typingIn: typing ? (row?.typingConversationId ?? null) : null,
  };
}

export async function readPresenceForUsers(userIds: number[]): Promise<PresenceView[]> {
  if (userIds.length === 0) return [];
  const db = await getDb();
  if (!db) return [];
  try {
    const rows = await db.select().from(presence).where(inArray(presence.userId, userIds));
    const settings = await db.select({ userId: userSettings.userId, lastSeen: userSettings.lastSeen }).from(userSettings).where(inArray(userSettings.userId, userIds));
    const hidden = new Set(settings.filter((row) => row.lastSeen === 0).map((row) => row.userId));
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    const now = Date.now();
    return userIds.map((userId) => presenceViewFor(userId, byUser.get(userId), hidden.has(userId), now));
  } catch (error) {
    console.warn("[Presence] read failed; has the presence table been migrated?", error);
    return [];
  }
}

/** Everyone in a conversation except the viewer. */
export async function listConversationPeerIds(conversationId: string, viewerId: number) {
  const ids = await listConversationMemberIds(conversationId);
  return ids.filter((id) => id !== viewerId);
}

export type PresenceInboxEntry = { conversationId: string; peerId: number | null; online: boolean; lastSeenAt: Date | null; typing: boolean };

/**
 * Presence for every conversation on the chat list, in one pass.
 *
 * Direct chats expose the peer's online state. Groups deliberately do not: a dot meaning "some
 * member is online" would leak one person's activity to every other member, and cannot be
 * attributed to anyone. Typing is reported for both, since that is about this conversation.
 */
export async function readPresenceInbox(viewerId: number): Promise<PresenceInboxEntry[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const mine = await db.select({ conversationId: conversationMembers.conversationId }).from(conversationMembers).where(eq(conversationMembers.userId, viewerId));
    const conversationIds = mine.map((row) => row.conversationId);
    if (conversationIds.length === 0) return [];

    const members = await db
      .select({ conversationId: conversationMembers.conversationId, userId: conversationMembers.userId, kind: conversations.kind })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(inArray(conversationMembers.conversationId, conversationIds));

    const peers = new Map<string, { ids: number[]; group: boolean }>();
    for (const row of members) {
      const entry = peers.get(row.conversationId) ?? { ids: [], group: row.kind === "group" };
      if (row.userId !== viewerId) entry.ids.push(row.userId);
      peers.set(row.conversationId, entry);
    }

    const presenceRows = await readPresenceForUsers([...new Set([...peers.values()].flatMap((entry) => entry.ids))]);
    const byUser = new Map(presenceRows.map((row) => [row.userId, row]));

    return conversationIds.map((conversationId) => {
      const entry = peers.get(conversationId);
      const ids = entry?.ids ?? [];
      const typing = ids.some((id) => byUser.get(id)?.typingIn === conversationId);
      const direct = !entry?.group && ids.length === 1;
      const peer = direct ? byUser.get(ids[0]) : undefined;
      return {
        conversationId,
        peerId: direct ? ids[0] : null,
        online: Boolean(peer?.online),
        lastSeenAt: peer?.lastSeenAt ?? null,
        typing,
      };
    });
  } catch (error) {
    console.warn("[Presence] inbox failed; has the presence table been migrated?", error);
    return [];
  }
}
