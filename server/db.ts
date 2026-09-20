import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { appeals, authTokens, blockedContacts, broadcastLists, broadcastRecipients, calls, channelFollowers, channelPosts, channels, communities, communityGroups, conversationIcons, conversationMembers, conversations, groupEvents, InsertUser, inviteLinks, joinRequests, linkPreviews, messageHides, messageKeeps, messageMedia, messageReactions, messageStars, messages, pollVotes, presence, pushTokens, reports, sessions, statusUpdates, statusViews, stickers, userAvatars, userSettings, users } from "../drizzle/schema";
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
    const latest = recent.filter((m) => !hiddenIds.has(m.id) && (!m.expiresAt || m.expiresAt.getTime() > nowMs) && isDeliveredFor(m, userId, nowMs));

    const unreadWhere = mine?.lastReadAt
      ? and(eq(messages.conversationId, conversation.id), ne(messages.senderId, userId), gt(messages.createdAt, mine.lastReadAt))
      : and(eq(messages.conversationId, conversation.id), ne(messages.senderId, userId));
    const unreadRows = await db
      .select({ id: messages.id, expiresAt: messages.expiresAt, senderId: messages.senderId, scheduledAt: messages.scheduledAt })
      .from(messages)
      .where(unreadWhere);
    // A message somebody scheduled for later is not unread yet, and must not raise a badge early.
    const unread = unreadRows.filter((row) => !hiddenIds.has(row.id) && (!row.expiresAt || row.expiresAt.getTime() > nowMs) && isDeliveredFor(row, userId, nowMs));

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
      // Carried on the list rather than behind its own query: the chat screen needs it to decide
      // whether to load media, and the list is already being fetched.
      mediaAutoLoad: member.mediaAutoLoad === 1,
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

/**
 * How much stored media a reader's chats account for, broken down per conversation.
 *
 * "Bytes" here is derived from the length of the stored base64 text rather than measured on disk,
 * because attachments live in a text column: the real figure would mean decoding every row. Base64
 * inflates by about a third, so the stored length is scaled back down - it stays an estimate, and
 * `approximate: true` on the result says so rather than letting the screen imply precision.
 *
 * The sizes are read with `length(data)` in SQL, so the base64 itself is never pulled into memory -
 * a chat full of photos would otherwise be tens of megabytes per request.
 */
const BASE64_TO_BYTES = 3 / 4;
/** `/api/media/<id>` is the only shape the app writes, but parsing defensively costs nothing. */
function mediaIdFromUrl(url: string | null): number | null {
  if (!url) return null;
  const match = /\/api\/media\/(\d+)/.exec(url);
  return match ? Number(match[1]) : null;
}

export async function storageUsageForUser(userId: number) {
  const db = await getDb();
  const empty = {
    approximate: true as const,
    mediaBytes: 0,
    mediaCount: 0,
    messageCount: 0,
    stickerBytes: 0,
    stickerCount: 0,
    avatarBytes: 0,
    conversations: [] as Array<{ conversationId: string; title: string; bytes: number; count: number }>,
  };
  if (!db) return empty;

  const memberships = await db
    .select({ conversationId: conversationMembers.conversationId, title: conversations.title, kind: conversations.kind })
    .from(conversationMembers)
    .leftJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(eq(conversationMembers.userId, userId));
  if (memberships.length === 0) return empty;

  const conversationIds = memberships.map((row) => row.conversationId);

  const withMedia = await db
    .select({ conversationId: messages.conversationId, mediaUrl: messages.mediaUrl })
    .from(messages)
    .where(and(inArray(messages.conversationId, conversationIds), isNotNull(messages.mediaUrl), isNull(messages.deletedAt)));

  // Which media rows belong to which chat. One media row can back at most one message, so the map is
  // a plain reverse index rather than a list.
  const ownerOf = new Map<number, string>();
  for (const row of withMedia) {
    const id = mediaIdFromUrl(row.mediaUrl);
    if (id === null) continue;
    ownerOf.set(id, row.conversationId);
  }

  const sizes = ownerOf.size
    ? await db
        .select({ id: messageMedia.id, stored: sql<number>`length(${messageMedia.data})` })
        .from(messageMedia)
        .where(inArray(messageMedia.id, [...ownerOf.keys()]))
    : [];

  const perConversation = new Map<string, { bytes: number; count: number }>();
  let mediaBytes = 0;
  for (const row of sizes) {
    const conversationId = ownerOf.get(row.id);
    if (!conversationId) continue;
    const bytes = Math.round(Number(row.stored ?? 0) * BASE64_TO_BYTES);
    mediaBytes += bytes;
    const entry = perConversation.get(conversationId) ?? { bytes: 0, count: 0 };
    entry.bytes += bytes;
    entry.count += 1;
    perConversation.set(conversationId, entry);
  }

  // Stickers and a profile photo are also stored as text, and are worth showing for completeness:
  // they are the other two things a person can put in the database.
  const stickerRows = await db.select({ stored: sql<number>`coalesce(sum(length(${stickers.data})), 0)`, count: sql<number>`count(*)` }).from(stickers).where(eq(stickers.userId, userId));
  const avatarRows = await db.select({ stored: sql<number>`coalesce(sum(length(${userAvatars.data})), 0)` }).from(userAvatars).where(eq(userAvatars.userId, userId));

  return {
    approximate: true as const,
    mediaBytes,
    mediaCount: ownerOf.size,
    messageCount: withMedia.length,
    stickerBytes: Math.round(Number(stickerRows[0]?.stored ?? 0) * BASE64_TO_BYTES),
    stickerCount: Number(stickerRows[0]?.count ?? 0),
    avatarBytes: Math.round(Number(avatarRows[0]?.stored ?? 0) * BASE64_TO_BYTES),
    conversations: memberships
      .map((row) => {
        const entry = perConversation.get(row.conversationId);
        return {
          conversationId: row.conversationId,
          // A direct chat has no stored title; the client already knows the other person's name and
          // is better placed to label it, so an empty title is left for it to fill in.
          title: row.title ?? "",
          bytes: entry?.bytes ?? 0,
          count: entry?.count ?? 0,
        };
      })
      .filter((row) => row.count > 0)
      .sort((a, b) => b.bytes - a.bytes),
  };
}

// ---------------------------------------------------------------- group icons
/** Group photos share the profile-photo ceiling; the client enforces the same limit. */
export const MAX_ICON_BYTES = 4 * 1024 * 1024;

export async function getConversationIcon(conversationId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(conversationIcons).where(eq(conversationIcons.conversationId, conversationId)).limit(1);
  return rows[0];
}

/**
 * When each of the reader's group photos last changed.
 *
 * The client puts this in the image URL, so replacing a photo shows up immediately instead of after
 * the previous one expires from the image cache.
 */
export async function conversationIconVersions(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const memberships = await db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.userId, userId));
  if (memberships.length === 0) return [];
  return db
    .select({ conversationId: conversationIcons.conversationId, updatedAt: conversationIcons.updatedAt })
    .from(conversationIcons)
    .where(inArray(conversationIcons.conversationId, memberships.map((row) => row.conversationId)));
}

export async function setConversationIcon(conversationId: string, userId: number, mimeType: string, base64: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  if (!(await isConversationMember(conversationId, userId))) return false;
  const values = { conversationId, mimeType, data: base64, updatedAt: new Date() };
  await db.insert(conversationIcons).values(values).onConflictDoUpdate({ target: conversationIcons.conversationId, set: values });
  return true;
}

export async function clearConversationIcon(conversationId: string, userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  if (!(await isConversationMember(conversationId, userId))) return false;
  await db.delete(conversationIcons).where(eq(conversationIcons.conversationId, conversationId));
  return true;
}

// ---------------------------------------------------------------- group activity
export type GroupEventKind =
  | "created"
  | "member-add"
  | "member-remove"
  | "member-leave"
  | "role-change"
  | "info-change"
  | "icon-change"
  | "join-approved";

/**
 * Records a membership or settings change for the group log.
 *
 * Callers fire this without awaiting it: a failure to write the log must never fail the action it
 * describes, and an action that happened but was not logged is far better than one that did not
 * happen because the log was unavailable.
 */
export async function logGroupEvent(
  conversationId: string,
  actorId: number | null,
  kind: GroupEventKind,
  targetUserId?: number | null,
  detail?: string | null,
) {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(groupEvents)
    .values({ conversationId, actorId, kind, targetUserId: targetUserId ?? null, detail: detail ? detail.slice(0, 255) : null });
}

export async function listGroupEvents(conversationId: string, userId: number, limit = 60) {
  const db = await getDb();
  if (!db || !(await isConversationMember(conversationId, userId))) return [];
  return db
    .select({
      id: groupEvents.id,
      kind: groupEvents.kind,
      detail: groupEvents.detail,
      createdAt: groupEvents.createdAt,
      targetUserId: groupEvents.targetUserId,
      actorName: users.name,
      actorUsername: users.username,
    })
    .from(groupEvents)
    .leftJoin(users, eq(users.id, groupEvents.actorId))
    .where(eq(groupEvents.conversationId, conversationId))
    .orderBy(desc(groupEvents.createdAt))
    .limit(limit);
}

// ---------------------------------------------------------------- self chat
/**
 * The conversation you have with yourself.
 *
 * Stored as an ordinary direct conversation whose only member is you, so sending, starring, search,
 * export and the unread counts all work on it with no special cases anywhere else. The id is derived
 * from the user id, which makes creation idempotent without a lookup race.
 */
export async function getOrCreateSelfConversation(userId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Chat storage is not available");

  const mine = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
    .where(and(eq(conversations.kind, "direct"), eq(conversationMembers.userId, userId)));

  const ids = mine.map((row) => row.id);
  if (ids.length > 0) {
    // A direct conversation with one member is a self chat; one with two is a real conversation.
    const counts = await db
      .select({ conversationId: conversationMembers.conversationId, n: sql<number>`count(*)` })
      .from(conversationMembers)
      .where(inArray(conversationMembers.conversationId, ids))
      .groupBy(conversationMembers.conversationId);
    const solo = counts.find((row) => Number(row.n) === 1);
    if (solo) return solo.conversationId;
  }

  const id = `self-${userId}`;
  await db.insert(conversations).values({ id, kind: "direct", createdBy: userId }).onConflictDoNothing();
  await db.insert(conversationMembers).values({ conversationId: id, userId, role: "member" }).onConflictDoNothing();
  return id;
}

// ---------------------------------------------------------------- chat lock
/**
 * "Chat lock": require the app PIN again before this thread opens.
 *
 * Only the reader's own membership row is touched, so locking a chat is private to the person who
 * did it and never affects anybody else in the conversation.
 */
export async function setChatLocked(conversationId: string, userId: number, locked: boolean): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .update(conversationMembers)
    .set({ lockedAt: locked ? new Date() : null })
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
    .returning({ conversationId: conversationMembers.conversationId });
  return rows.length > 0;
}

/** Which of the reader's chats are locked, so the gate knows what to cover. */
export async function lockedConversationIds(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.userId, userId), isNotNull(conversationMembers.lockedAt)));
  return rows.map((row) => row.conversationId);
}

// ---------------------------------------------------------------- scheduled messages
/**
 * Whether a message is visible to this reader yet.
 *
 * A scheduled message is visible to its own sender immediately - so they can see it waiting in the
 * thread and change their mind - and to everybody else only once its time arrives.
 *
 * This lives in one place on purpose. Three separate queries need the same answer: the thread, the
 * conversation preview, and the unread badge. A rule written out three times is a rule that will
 * eventually disagree with itself, and the disagreement would look like a message that shows in the
 * chat but not in the list, or counts as unread a day before it arrives.
 *
 * Declared at the end of the file and used above; function declarations hoist, so the order is only
 * cosmetic.
 */
function isDeliveredFor(row: { senderId: number; scheduledAt: Date | null }, userId: number, nowMs: number): boolean {
  if (row.senderId === userId) return true;
  if (!row.scheduledAt) return true;
  return row.scheduledAt.getTime() <= nowMs;
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
/** The three group settings an admin can turn, and what each of them allows. */
export type GroupPermissions = { whoCanSend: string; whoCanEditInfo: string; whoCanAddMembers: string; approveNewMembers: number };

/**
 * Role and group settings for one person in one conversation, read together.
 *
 * A setting on its own means nothing until you know the role to test it against, and the two live in
 * different tables, so they come back in one join instead of two round trips on every send.
 */
export async function getConversationAccess(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({ role: conversationMembers.role, whoCanSend: conversations.whoCanSend, whoCanEditInfo: conversations.whoCanEditInfo, whoCanAddMembers: conversations.whoCanAddMembers, approveNewMembers: conversations.approveNewMembers })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function getConversationPermissions(conversationId: string): Promise<GroupPermissions> {
  const db = await getDb();
  if (!db) return { whoCanSend: "all", whoCanEditInfo: "all", whoCanAddMembers: "all", approveNewMembers: 0 };
  const [row] = await db.select({ whoCanSend: conversations.whoCanSend, whoCanEditInfo: conversations.whoCanEditInfo, whoCanAddMembers: conversations.whoCanAddMembers, approveNewMembers: conversations.approveNewMembers }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  return row ?? { whoCanSend: "all", whoCanEditInfo: "all", whoCanAddMembers: "all", approveNewMembers: 0 };
}

export async function setConversationPermissions(conversationId: string, patch: Partial<GroupPermissions>) {
  const db = await getDb();
  if (!db) return false;
  await db.update(conversations).set(patch).where(eq(conversations.id, conversationId));
  return true;
}

/** Whether a setting lets this role act. "all" covers every member; admins may always act. */
export function permitted(setting: string, role: string | null | undefined) {
  return setting !== "admins" || role === "admin" || role === "owner";
}

// ---- invite links ------------------------------------------------------------------------------
/**
 * Creates an invite link for a group.
 *
 * The code is random rather than derived from the conversation, so a revoked link cannot be guessed
 * back into existence. Both limits are optional, and a missing limit means "until an admin revokes
 * it", which is what a group's permanent link is.
 */
export async function createInviteLink(params: { conversationId: string; createdBy: number; expiresInMs?: number | null; maxUses?: number | null }) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .insert(inviteLinks)
    .values({ code: crypto.randomUUID().replace(/-/g, ""), conversationId: params.conversationId, createdBy: params.createdBy, role: "member", expiresAt: params.expiresInMs ? new Date(Date.now() + params.expiresInMs) : null, maxUses: params.maxUses ?? null })
    .returning();
  return row ?? null;
}

export async function listInviteLinks(conversationId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(inviteLinks).where(eq(inviteLinks.conversationId, conversationId)).orderBy(desc(inviteLinks.createdAt));
}

export async function revokeInviteLink(conversationId: string, code: string) {
  const db = await getDb();
  if (!db) return false;
  const removed = await db.delete(inviteLinks).where(and(eq(inviteLinks.conversationId, conversationId), eq(inviteLinks.code, code))).returning();
  return removed.length > 0;
}

/**
 * Redeems an invite: adds the caller to the group and counts the use.
 *
 * The use is claimed with a conditional UPDATE before the membership is written, so two people
 * redeeming a one-use link at the same instant cannot both get in - the second update matches no row
 * and is refused. If the membership write then failed the use would be spent, which is the safer
 * direction to lose in.
 */
export async function redeemInviteLink(code: string, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const [invite] = await db.select().from(inviteLinks).where(eq(inviteLinks.code, code)).limit(1);
  if (!invite) throw new Error("That invite link is not valid");
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) throw new Error("That invite link has expired");
  // Already in the group: nothing to do, and no use spent on a link they did not need.
  if (await isConversationMember(invite.conversationId, userId)) return invite.conversationId;

  // A group that reviews people files a request instead. Checked before any use is claimed, so asking
  // cannot exhaust the link; the use is spent on approval instead.
  if (await conversationNeedsApproval(invite.conversationId)) {
    await db
      .insert(joinRequests)
      .values({ conversationId: invite.conversationId, userId, inviteCode: invite.code })
      .onConflictDoUpdate({ target: [joinRequests.conversationId, joinRequests.userId], set: { status: "pending", inviteCode: invite.code, requestedAt: new Date(), decidedAt: null, decidedBy: null } });
    return invite.conversationId;
  }

  const claimed = await db
    .update(inviteLinks)
    .set({ uses: sql`${inviteLinks.uses} + 1` })
    .where(and(eq(inviteLinks.code, code), or(isNull(inviteLinks.maxUses), lt(inviteLinks.uses, inviteLinks.maxUses))))
    .returning();
  if (claimed.length === 0) throw new Error("That invite link has reached its limit");

  await addConversationMember(invite.conversationId, userId);
  return invite.conversationId;
}

export async function conversationNeedsApproval(conversationId: string) {
  const db = await getDb();
  if (!db) return false;
  const [row] = await db.select({ approve: conversations.approveNewMembers }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  return (row?.approve ?? 0) !== 0;
}

/** Requests still waiting on a decision, newest first, with the name needed to render each one. */
export async function listJoinRequests(conversationId: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ userId: joinRequests.userId, requestedAt: joinRequests.requestedAt, name: users.name, username: users.username })
    .from(joinRequests)
    .leftJoin(users, eq(users.id, joinRequests.userId))
    .where(and(eq(joinRequests.conversationId, conversationId), eq(joinRequests.status, "pending")))
    .orderBy(desc(joinRequests.requestedAt));
}

/**
 * Approves or rejects a request.
 *
 * The request is moved out of "pending" with a conditional UPDATE before anything else happens, so two
 * admins tapping approve at the same moment cannot both act on it - the second matches no row and is
 * refused. Only an approval creates a member.
 *
 * An approval is also where a limited invite link spends its use, which is why the request carries the
 * code it came from. Asking to join must not consume the link: with a one-use link and five people
 * asking, spending a use per request would let the first person to ask exhaust a link that had not
 * admitted anybody yet. If the link has since been revoked or has run out, the approval is refused
 * rather than quietly adding someone the link no longer authorises.
 */
export async function decideJoinRequest(params: { conversationId: string; userId: number; approve: boolean; decidedBy: number }) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const claimed = await db
    .update(joinRequests)
    .set({ status: params.approve ? "approved" : "rejected", decidedAt: new Date(), decidedBy: params.decidedBy })
    .where(and(eq(joinRequests.conversationId, params.conversationId), eq(joinRequests.userId, params.userId), eq(joinRequests.status, "pending")))
    .returning();
  if (claimed.length === 0) throw new Error("That request has already been answered");

  if (params.approve) {
    const code = claimed[0].inviteCode;
    if (code) {
      const spent = await db
        .update(inviteLinks)
        .set({ uses: sql`${inviteLinks.uses} + 1` })
        .where(and(eq(inviteLinks.code, code), or(isNull(inviteLinks.maxUses), lt(inviteLinks.uses, inviteLinks.maxUses))))
        .returning();
      if (spent.length === 0) throw new Error("The invite link that person used has expired or been revoked");
    }
    await addConversationMember(params.conversationId, params.userId);
  }
  return true;
}

// ---- per-chat settings and export ---------------------------------------------------------------
/**
 * The settings one chat answers to, including the account defaults it may be following.
 *
 * A chat that has never been touched has no values of its own, so the screen needs both the chat's
 * value and the default behind it to be able to say "following the default" instead of showing the
 * default as though the chat had chosen it.
 */
export async function chatSettingsFor(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({
      title: conversations.title,
      kind: conversations.kind,
      conversationDisappear: conversations.disappearSeconds,
      mediaAutoLoad: conversationMembers.mediaAutoLoad,
      autoDownloadMedia: userSettings.autoDownloadMedia,
      defaultDisappearSeconds: userSettings.defaultDisappearSeconds,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .leftJoin(userSettings, eq(userSettings.userId, conversationMembers.userId))
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
    .limit(1);
  if (!row) return null;
  const mediaAutoLoad = row.mediaAutoLoad !== 0;
  const autoDownloadMedia = (row.autoDownloadMedia ?? 1) !== 0;
  const defaultDisappearSeconds = row.defaultDisappearSeconds ?? 0;
  return {
    title: row.title,
    kind: row.kind,
    // null means "follow the account default", which is what an untouched chat is.
    conversationDisappear: row.conversationDisappear ?? null,
    mediaAutoLoad,
    autoDownloadMedia,
    defaultDisappearSeconds,
    effectiveDisappearSeconds: row.conversationDisappear ?? (defaultDisappearSeconds > 0 ? defaultDisappearSeconds : null),
    effectiveMediaAutoLoad: mediaAutoLoad && autoDownloadMedia,
  };
}

/**
 * The timer a message should be stamped with: the chat's own setting if it has one, otherwise the
 * account default. Without the fallback the account-wide default would change nothing.
 */
export async function effectiveDisappearSeconds(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({ conversationDisappear: conversations.disappearSeconds, defaultDisappearSeconds: userSettings.defaultDisappearSeconds })
    .from(conversations)
    .leftJoin(userSettings, eq(userSettings.userId, userId))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) return null;
  if (row.conversationDisappear) return row.conversationDisappear;
  return (row.defaultDisappearSeconds ?? 0) > 0 ? row.defaultDisappearSeconds : null;
}

function transcriptStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A readable transcript of a chat, for the export feature.
 *
 * Built from the same rows the chat itself reads, so an exported file cannot contain anything the
 * exporter could not already see. Media becomes a placeholder carrying its name: the bytes live inline
 * in the database, and inlining them here would produce a file too large to be of any use.
 */
export async function exportConversationTranscript(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  if (!(await isConversationMember(conversationId, userId))) throw new Error("You are not a member of this conversation");

  const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conversation) throw new Error("That conversation no longer exists");

  const members = await listConversationMembersDetailed(conversationId);
  const nameFor = new Map<number, string>();
  for (const entry of members) nameFor.set(entry.userId, entry.name?.trim() || entry.username || `User ${entry.userId}`);
  const me = nameFor.get(userId) ?? "You";

  const history = await listMessages(conversationId, userId);
  const sorted = history.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const others = Array.from(nameFor.entries()).filter(([id]) => id !== userId).map(([, name]) => name);

  let lastDay = "";
  const lines: string[] = [];
  for (const message of sorted) {
    const day = transcriptStamp(message.createdAt).split(",")[0];
    if (day !== lastDay) {
      lines.push(lines.length ? `\n--- ${day} ---` : `--- ${day} ---`);
      lastDay = day;
    }
    let text: string;
    if (message.deletedAt) text = "This message was deleted";
    else if (message.kind === "voice") text = `<voice note> ${Math.round((message.voiceDurationMs ?? 0) / 1000)}s`;
    else if (message.kind === "poll") text = `<poll> ${message.body ?? ""}`;
    else if (message.kind === "location") text = "<location shared>";
    else if (message.kind === "contact") text = "<contact card shared>";
    else if (message.mediaUrl) text = `<${message.kind}>${message.mediaName ? ` ${message.mediaName}` : ""}`;
    else text = message.body ?? "";
    const suffix = `${message.starred ? " ★" : ""}${message.editedAt ? " (edited)" : ""}`;
    const who = message.senderId === userId ? "You" : nameFor.get(message.senderId) ?? `User ${message.senderId}`;
    const time = transcriptStamp(message.createdAt).split(", ")[1];
    lines.push(`[${time}] ${who}: ${text}${suffix}`);
  }

  const [conversationRow] = await db.select({ title: conversations.title, kind: conversations.kind }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  const heading = conversationRow?.kind === "group" ? `Group: ${conversationRow.title ?? "Untitled group"}` : `Chat with ${others.join(", ") || me}`;
  const header = [heading, `Exported: ${transcriptStamp(new Date())}`, `Participants: ${Array.from(nameFor.values()).join(", ")}`, `Messages: ${sorted.length}`].join("\n");

  return {
    filename: `varnox-${conversationRow?.kind === "group" ? "group" : "chat"}-${new Date().toISOString().slice(0, 10)}.txt`,
    heading,
    content: `${header}\n\n${lines.join("\n")}\n`,
    messageCount: sorted.length,
  };
}

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
      // Editing the group's info and adding people start admin-only, which is what these routes
      // enforced before the settings existed, so no existing group changes behaviour. An admin can
      // open either one up afterwards; sending starts open to everyone either way.
      await tx.insert(conversations).values({ id, kind: "group", title, createdBy: creatorId, whoCanSend: "all", whoCanEditInfo: "admins", whoCanAddMembers: "admins" });
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
  // Messages this reader asked to keep. They survive the disappearing timer below.
  const keptIds = await keptMessageIds(userId, ids);

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

  // Poll answers, same shape of bulk fetch as reactions and only for the polls on this page, so a
  // chat with no polls costs no extra query. The tally itself is built by the client, which already
  // knows how to group per-person rows for reactions.
  const pollIds = rows.filter((row) => row.kind === "poll").map((row) => row.id);
  const voteRows = pollIds.length
    ? await db
        .select({ messageId: pollVotes.messageId, userId: pollVotes.userId, optionIndex: pollVotes.optionIndex, name: users.name, username: users.username })
        .from(pollVotes)
        .leftJoin(users, eq(users.id, pollVotes.userId))
        .where(inArray(pollVotes.messageId, pollIds))
    : [];

  const votesByMessage = new Map<string, Array<{ userId: number; optionIndex: number; name: string }>>();
  for (const row of voteRows) {
    const list = votesByMessage.get(row.messageId) ?? [];
    list.push({ userId: row.userId, optionIndex: row.optionIndex, name: row.name ?? row.username ?? "Someone" });
    votesByMessage.set(row.messageId, list);
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
    // A kept message outlives its timer for this reader only; everyone else's copy still expires.
    // A message scheduled for later is withheld from everyone but its sender.
    .filter(
      (row) =>
        !hiddenIds.has(row.id) &&
        (!row.expiresAt || row.expiresAt.getTime() > nowMs || keptIds.has(row.id)) &&
        isDeliveredFor(row, userId, nowMs),
    )
    .map((row) => {
      const quote = row.replyToId ? quotedById.get(row.replyToId) ?? null : null;
      const mine = row.senderId === userId;
      const status: "sent" | "delivered" | "read" | null = !mine ? null : allReadAt && allReadAt >= row.createdAt ? "read" : allDeliveredAt && allDeliveredAt >= row.createdAt ? "delivered" : "sent";
      return {
        ...row,
        starred: starredIds.has(row.id),
        kept: keptIds.has(row.id),
        reactions: reactionsByMessage.get(row.id) ?? [],
        votes: votesByMessage.get(row.id) ?? [],
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

/** How long someone asking for a review is told to expect. One constant, so the window shown on screen
 *  and the deadline stored on the row cannot disagree. */
export const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Files a request for review, or updates the one already waiting.
 *
 * A second request while one is pending replaces its details and restarts the clock, rather than piling
 * up rows an admin would have to read twice. A request that has already been answered is left alone:
 * otherwise asking again would be a way to keep a decided case open forever.
 */
export async function createAppeal(userId: number, reason: string) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");

  const [pending] = await db
    .select({ id: appeals.id })
    .from(appeals)
    .where(and(eq(appeals.userId, userId), eq(appeals.status, "pending")))
    .orderBy(desc(appeals.createdAt))
    .limit(1);

  const reviewDueAt = new Date(Date.now() + REVIEW_WINDOW_MS);
  if (pending) {
    await db.update(appeals).set({ reason, reviewDueAt, updatedAt: new Date() }).where(eq(appeals.id, pending.id));
  } else {
    await db.insert(appeals).values({ userId, reason, reviewDueAt });
  }

  const rows = await db.select().from(appeals).where(eq(appeals.userId, userId)).orderBy(desc(appeals.createdAt)).limit(1);
  return rows[0];
}

/**
 * What to tell someone about their own case, looked up by the username they tried to sign in with.
 *
 * A state and two dates only - no reason, no reviewer, no notes. This answer is reachable without a
 * session, so it must not say more than the login screen already tells that same person.
 */
export async function appealStatusForUsername(username: string) {
  const db = await getDb();
  if (!db) return { state: "none" as const, reviewDueAt: null, decidedAt: null };

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (!user) return { state: "none" as const, reviewDueAt: null, decidedAt: null };

  const [appeal] = await db.select().from(appeals).where(eq(appeals.userId, user.id)).orderBy(desc(appeals.createdAt)).limit(1);
  if (!appeal) return { state: "none" as const, reviewDueAt: null, decidedAt: null };

  return {
    state: appeal.status as "pending" | "approved" | "rejected",
    reviewDueAt: appeal.reviewDueAt,
    decidedAt: appeal.status === "pending" ? null : appeal.updatedAt,
  };
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

// ---------------------------------------------------------------- abuse reports
/** The categories a report can carry. Kept as a closed set so the moderator queue can be grouped. */
export const REPORT_CATEGORIES = ["spam", "abuse", "scam", "impersonation", "other"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * Files a report.
 *
 * The excerpt is copied at this moment rather than read later: the message can be edited or deleted
 * after the report lands, and a moderator who cannot see what was reported has nothing to judge.
 * A report that names no target and no message is refused, since there would be nothing to act on.
 */
export async function submitReport(input: {
  reporterId: number;
  targetUserId?: number | null;
  conversationId?: string | null;
  messageId?: string | null;
  category: ReportCategory;
  note?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Reports are not available");

  let excerpt: string | null = null;
  let targetUserId = input.targetUserId ?? null;

  if (input.messageId) {
    const message = await getMessageById(input.messageId);
    if (!message) throw new Error("That message no longer exists");
    // The reporter must be able to see the message they are reporting.
    if (!(await isConversationMember(message.conversationId, input.reporterId))) throw new Error("That message is not in a chat you are in");
    // Fall back to the authored kind when there is no text, so the queue shows something useful.
    excerpt = message.body ?? message.mediaName ?? `[${message.kind}]`;
    targetUserId = targetUserId ?? message.senderId;
  }

  if (!targetUserId && !input.conversationId) throw new Error("Nothing was reported");

  const rows = await db
    .insert(reports)
    .values({
      reporterId: input.reporterId,
      targetUserId,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      category: input.category,
      note: input.note?.trim() || null,
      excerpt,
    })
    .returning({ id: reports.id });

  return { id: rows[0]?.id ?? null };
}

/** The moderator queue, newest first, with enough identity to act on. */
export async function listReportsForAdmin(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: reports.id,
      category: reports.category,
      note: reports.note,
      excerpt: reports.excerpt,
      status: reports.status,
      conversationId: reports.conversationId,
      messageId: reports.messageId,
      createdAt: reports.createdAt,
      reviewedAt: reports.updatedAt,
      reporterId: reports.reporterId,
      targetUserId: reports.targetUserId,
      reviewNote: reports.reviewNote,
      reporterName: users.name,
      reporterUsername: users.username,
    })
    .from(reports)
    .leftJoin(users, eq(users.id, reports.reporterId))
    .orderBy(desc(reports.createdAt))
    .limit(limit);
}

/**
 * Records a moderator's decision.
 *
 * Deciding is what the report asks for, so `status` moves to closed or actioned and the record
 * remembers who decided. The report row itself is the decision log - there is no second table that
 * could disagree with it.
 */
export async function reviewReport(id: number, reviewerId: number, status: "closed" | "actioned", note: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Reports are not available");
  const rows = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
  const report = rows[0];
  if (!report) throw new Error("Report not found");
  await db.update(reports).set({ status, reviewedBy: reviewerId, reviewNote: note, updatedAt: new Date() }).where(eq(reports.id, id));
  return report;
}

// ---------------------------------------------------------------- link previews
/**
 * A cached preview for a URL, or null when it has never been fetched.
 *
 * A row with `failedAt` set is a cached miss: it is returned so the caller can decide not to retry,
 * rather than being treated as absent and fetched again on every render.
 */
export async function getLinkPreview(url: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(linkPreviews).where(eq(linkPreviews.url, url)).limit(1);
  return rows[0] ?? null;
}

/** Stores a fetched preview, or a miss when `preview` is null. */
export async function saveLinkPreview(
  url: string,
  preview: { title?: string | null; description?: string | null; siteName?: string | null; imageUrl?: string | null } | null,
) {
  const db = await getDb();
  if (!db) return;
  const values = preview
    ? {
        url,
        title: preview.title ?? null,
        description: preview.description ?? null,
        siteName: preview.siteName ?? null,
        imageUrl: preview.imageUrl ?? null,
        fetchedAt: new Date(),
        failedAt: null,
      }
    : { url, title: null, description: null, siteName: null, imageUrl: null, fetchedAt: null, failedAt: new Date() };

  await db
    .insert(linkPreviews)
    .values(values)
    .onConflictDoUpdate({ target: linkPreviews.url, set: values });
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

export async function createStatus(input: {
  id: string;
  userId: number;
  kind: string;
  body: string | null;
  mediaUrl: string | null;
  // Only meaningful for a video status; the viewer needs it to hand the file to a player.
  mediaMime?: string | null;
  // Only meaningful for a voice status; lets the viewer draw progress without loading the file.
  voiceDurationMs?: number | null;
  background: string;
  expiresAt: Date;
}) {
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
    .select({ id: statusUpdates.id, userId: statusUpdates.userId, kind: statusUpdates.kind, body: statusUpdates.body, mediaUrl: statusUpdates.mediaUrl, mediaMime: statusUpdates.mediaMime, voiceDurationMs: statusUpdates.voiceDurationMs, background: statusUpdates.background, createdAt: statusUpdates.createdAt, expiresAt: statusUpdates.expiresAt, authorName: users.name, authorUsername: users.username, authorAvatarUpdatedAt: users.avatarUpdatedAt })
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
/**
 * Records a poll answer, replacing whatever that person answered before.
 *
 * The upsert is keyed on the primary key rather than on a lookup, so "one answer per person" is a
 * database rule instead of something the UI has to remember, and changing your mind is the same
 * call as answering the first time. Answers are changed, never withdrawn - matching the apps this
 * follows, where a poll answer is a choice rather than a toggle.
 */
export async function castPollVote(messageId: string, userId: number, optionIndex: number) {
  const db = await getDb();
  if (!db) return false;
  await db
    .insert(pollVotes)
    .values({ messageId, userId, optionIndex })
    .onConflictDoUpdate({ target: [pollVotes.messageId, pollVotes.userId], set: { optionIndex } });
  return true;
}

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
    // The pin goes with the body: a banner pointing at a tombstone helps nobody.
    .set({ deletedAt: new Date(), body: null, mediaUrl: null, mediaName: null, mediaMime: null, voiceDurationMs: null, pinnedAt: null, pinnedBy: null })
    .where(and(eq(messages.id, messageId), eq(messages.senderId, userId), isNull(messages.deletedAt)))
    .returning({ id: messages.id });
  if (rows.length === 0) return false;
  // Reactions and keeps attached to a tombstone are noise.
  await db.delete(messageReactions).where(eq(messageReactions.messageId, messageId));
  await db.delete(messageKeeps).where(eq(messageKeeps.messageId, messageId));
  return true;
}

/** "Delete for me": hides the row from one reader, leaving it intact for everybody else. */
export async function hideMessageForUser(messageId: string, userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.insert(messageHides).values({ messageId, userId }).onConflictDoNothing();
}

/** How many messages a conversation may pin at once, matching the apps this follows. */
export const MAX_PINNED_MESSAGES = 3;

export type PinResult = { ok: true } | { ok: false; reason: "not-found" | "limit" };

/**
 * Pins or unpins a message for the whole conversation.
 *
 * A pin is shared, so any member may set one - but the cap is checked here rather than in the UI, so
 * a second client cannot sidestep it. Pinning something already pinned is a no-op that leaves the
 * timestamp alone; otherwise a second person agreeing would reshuffle the banner under everyone.
 */
export async function setMessagePinned(messageId: string, userId: number, pinned: boolean): Promise<PinResult> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "not-found" };

  const message = await getMessageById(messageId);
  // A tombstone, or a message the caller cannot see, is reported the same way: nothing to pin.
  if (!message || message.deletedAt) return { ok: false, reason: "not-found" };
  if (!(await isConversationMember(message.conversationId, userId))) return { ok: false, reason: "not-found" };

  if (!pinned) {
    await db.update(messages).set({ pinnedAt: null, pinnedBy: null }).where(eq(messages.id, messageId));
    return { ok: true };
  }

  if (message.pinnedAt) return { ok: true };

  const existing = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, message.conversationId), isNotNull(messages.pinnedAt), isNull(messages.deletedAt)));
  if (existing.length >= MAX_PINNED_MESSAGES) return { ok: false, reason: "limit" };

  await db.update(messages).set({ pinnedAt: new Date(), pinnedBy: userId }).where(eq(messages.id, messageId));
  return { ok: true };
}

/**
 * The pins one reader can see in a conversation.
 *
 * Deleted and expired messages are left out, and so are messages this reader has hidden. The banner
 * must never offer to jump to something that is no longer there.
 */
export async function listPinnedMessages(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db || !(await isConversationMember(conversationId, userId))) return [];

  const now = new Date();
  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      kind: messages.kind,
      mediaName: messages.mediaName,
      senderId: messages.senderId,
      pinnedAt: messages.pinnedAt,
      name: users.name,
      username: users.username,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNotNull(messages.pinnedAt),
        isNull(messages.deletedAt),
        or(isNull(messages.expiresAt), gt(messages.expiresAt, now)),
      ),
    )
    .orderBy(desc(messages.pinnedAt))
    .limit(MAX_PINNED_MESSAGES);
  if (rows.length === 0) return [];

  const hidden = await db
    .select({ messageId: messageHides.messageId })
    .from(messageHides)
    .where(and(eq(messageHides.userId, userId), inArray(messageHides.messageId, rows.map((row) => row.id))));
  const hiddenIds = new Set(hidden.map((row) => row.messageId));

  return rows
    .filter((row) => !hiddenIds.has(row.id))
    .map((row) => ({
      id: row.id,
      body: row.body,
      kind: row.kind,
      mediaName: row.mediaName,
      senderId: row.senderId,
      senderName: row.name ?? row.username ?? "Someone",
    }));
}

/**
 * "Keep in chat": a reader asks that a disappearing message stay for them.
 *
 * The keep is personal. Keeping is idempotent, and keeping something that was never on a timer is
 * harmless - it simply records the intent.
 */
export async function setMessageKept(messageId: string, userId: number, kept: boolean) {
  const db = await getDb();
  if (!db) return false;

  const message = await getMessageById(messageId);
  if (!message || message.deletedAt) return false;
  if (!(await isConversationMember(message.conversationId, userId))) return false;

  if (kept) {
    await db.insert(messageKeeps).values({ messageId, userId }).onConflictDoNothing();
    return true;
  }

  await db.delete(messageKeeps).where(and(eq(messageKeeps.messageId, messageId), eq(messageKeeps.userId, userId)));
  return true;
}

/** Which of these messages the reader has kept, so the thread can mark them. */
export async function keptMessageIds(userId: number, messageIds: string[]) {
  const db = await getDb();
  if (!db || messageIds.length === 0) return new Set<string>();
  const rows = await db
    .select({ messageId: messageKeeps.messageId })
    .from(messageKeeps)
    .where(and(eq(messageKeeps.userId, userId), inArray(messageKeeps.messageId, messageIds)));
  return new Set(rows.map((row) => row.messageId));
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
  flags: { archived?: boolean; muted?: boolean; pinned?: boolean; draft?: string | null; mediaAutoLoad?: boolean },
) {
  const db = await getDb();
  if (!db) return;
  const patch: Record<string, unknown> = {};
  if (flags.archived !== undefined) patch.archived = flags.archived ? 1 : 0;
  if (flags.muted !== undefined) patch.muted = flags.muted ? 1 : 0;
  if (flags.pinned !== undefined) patch.pinned = flags.pinned ? 1 : 0;
  if (flags.mediaAutoLoad !== undefined) patch.mediaAutoLoad = flags.mediaAutoLoad ? 1 : 0;
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

/** Title, kind and description for a single conversation. */
export async function getConversationSummary(conversationId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ id: conversations.id, title: conversations.title, kind: conversations.kind, description: conversations.description })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return rows[0] ?? null;
}

export type LeaveGroupOutcome = { remaining: number; transferredTo: number | null };

/**
 * Removes a member from a group, handing ownership on if they were the owner.
 *
 * Ownership has to transfer rather than leave with the leaver: every management action checks the
 * caller's role, so a group with no owner is frozen - nobody can promote, remove or rename anyone
 * ever again. Admins are preferred as successors, then whoever has been in the group longest.
 *
 * Direct chats are refused on purpose. Leaving one would mean hiding it per member, which needs a
 * per-member flag that does not exist yet, and pretending to leave while it reappears would be
 * worse than saying so.
 */
export async function leaveGroup(conversationId: string, userId: number): Promise<LeaveGroupOutcome> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.transaction(async (tx) => {
    const conversation = await tx.select({ kind: conversations.kind }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!conversation[0]) throw new Error("That group no longer exists");
    if (conversation[0].kind !== "group") throw new Error("Only groups can be left");

    const before = await tx
      .select({ role: conversationMembers.role })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
      .limit(1);
    if (!before[0]) throw new Error("You are not a member of this group");
    const wasOwner = before[0].role === "owner";

    await tx.delete(conversationMembers).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));

    const remaining = await tx
      .select({ userId: conversationMembers.userId, role: conversationMembers.role })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId))
      .orderBy(conversationMembers.joinedAt);

    let transferredTo: number | null = null;
    if (wasOwner && remaining.length > 0) {
      const successor = remaining.find((row) => row.role === "admin") ?? remaining[0];
      await tx
        .update(conversationMembers)
        .set({ role: "owner" })
        .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, successor.userId)));
      transferredTo = successor.userId;
    }

    return { remaining: remaining.length, transferredTo };
  });
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

// ================================================================ signed-in devices
/** Records a session as it is issued. Called from the auth flows, never by a route. */
export async function createSessionRow(params: { id: string; userId: number; userAgent?: string | null; platform?: string | null; expiresAt: Date }) {
  const db = await getDb();
  if (!db) return;
  await db.insert(sessions).values({ id: params.id, userId: params.userId, userAgent: params.userAgent ?? null, platform: params.platform ?? null, expiresAt: params.expiresAt });
}

/**
 * Whether a session may still be used.
 *
 * This is what makes signing a device out real: without it the token would keep working until it
 * expired, because a JWT cannot be taken back. An unknown id counts as inactive - a session whose row
 * has been pruned is one nobody can vouch for.
 */
export async function isSessionActive(sessionId: string) {
  const db = await getDb();
  if (!db) return false;
  const [row] = await db.select({ revokedAt: sessions.revokedAt, expiresAt: sessions.expiresAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!row) return false;
  if (row.revokedAt) return false;
  return row.expiresAt.getTime() > Date.now();
}

/**
 * Notes that a device was seen, at most once every five minutes.
 *
 * The guard is in the WHERE clause rather than in code so the common case is a no-op the database
 * decides on, instead of a write on every single request.
 */
export async function touchSession(sessionId: string) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(sessions.id, sessionId), lt(sessions.lastSeenAt, new Date(Date.now() - 5 * 60 * 1000))));
}

export async function listSessions(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.lastSeenAt));
}

/** Ends one session, refusing to touch anybody else's. */
export async function revokeSession(userId: number, sessionId: string) {
  const db = await getDb();
  if (!db) return false;
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .returning();
  return revoked.length > 0;
}

/** Ends every session except the one asking, which is how "sign out everywhere else" behaves. */
export async function revokeOtherSessions(userId: number, keepSessionId: string | null) {
  const db = await getDb();
  if (!db) return 0;
  const where = keepSessionId
    ? and(eq(sessions.userId, userId), isNull(sessions.revokedAt), ne(sessions.id, keepSessionId))
    : and(eq(sessions.userId, userId), isNull(sessions.revokedAt));
  const revoked = await db.update(sessions).set({ revokedAt: new Date() }).where(where).returning();
  return revoked.length;
}

/** Drops rows that can no longer be used, so the table does not grow forever. */
export async function pruneExpiredSessions() {
  const db = await getDb();
  if (!db) return 0;
  const removed = await db.delete(sessions).where(lt(sessions.expiresAt, new Date(Date.now() - 30 * 24 * 3600 * 1000))).returning();
  return removed.length;
}

// ================================================================ two-step PIN
export async function getPinHash(userId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select({ pinHash: userSettings.pinHash }).from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  return row?.pinHash ?? null;
}

export async function setPinHash(userId: number, pinHash: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  await db.insert(userSettings).values({ userId, pinHash }).onConflictDoUpdate({ target: userSettings.userId, set: { pinHash, updatedAt: new Date() } });
}

// ================================================================ conversation and account removal
/**
 * Erases one conversation and everything hanging off its messages.
 *
 * Written by hand rather than left to the database: this schema declares no foreign keys, so nothing
 * cascades, and a deleted conversation that left its messages behind would quietly reappear in a search.
 */
export async function deleteConversationData(conversationId: string) {
  const db = await getDb();
  if (!db) return;
  const messageIds = (await db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, conversationId))).map((row) => row.id);
  if (messageIds.length > 0) {
    await db.delete(messageReactions).where(inArray(messageReactions.messageId, messageIds));
    await db.delete(messageStars).where(inArray(messageStars.messageId, messageIds));
    await db.delete(messageHides).where(inArray(messageHides.messageId, messageIds));
    await db.delete(pollVotes).where(inArray(pollVotes.messageId, messageIds));
  }
  await db.delete(messages).where(eq(messages.conversationId, conversationId));
  await db.delete(calls).where(eq(calls.conversationId, conversationId));
  await db.delete(inviteLinks).where(eq(inviteLinks.conversationId, conversationId));
  await db.delete(joinRequests).where(eq(joinRequests.conversationId, conversationId));
  await db.delete(communityGroups).where(eq(communityGroups.conversationId, conversationId));
  await db.delete(conversationMembers).where(eq(conversationMembers.conversationId, conversationId));
  await db.delete(conversations).where(eq(conversations.id, conversationId));
}

/**
 * Deletes an account and everything that was only theirs.
 *
 * Two decisions are worth knowing about. Groups survive: somebody else has to own them, so ownership
 * passes to the longest-standing owner-adjacent member rather than the group vanishing for everyone
 * still in it. Messages the person sent also survive, in other people's chats - the account is gone and
 * their name resolves to nothing, but rewriting history other people received would be a different
 * feature. Direct chats are deleted outright, because there is nobody left on the other end.
 */
export async function deleteUserAccount(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");

  // Settle conversations first: deciding who owns what needs the memberships still in place.
  const memberships = await db.select({ conversationId: conversationMembers.conversationId }).from(conversationMembers).where(eq(conversationMembers.userId, userId));
  for (const { conversationId } of memberships) {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!conversation) continue;
    const others = await db
      .select({ userId: conversationMembers.userId, role: conversationMembers.role, joinedAt: conversationMembers.joinedAt })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, conversationId), ne(conversationMembers.userId, userId)))
      .orderBy(conversationMembers.joinedAt);

    if (conversation.kind === "group" && others.length > 0) {
      const successor = others.find((other) => other.role === "owner") ?? others.find((other) => other.role === "admin") ?? others[0];
      if (conversation.createdBy === userId) {
        await db.update(conversations).set({ createdBy: successor.userId }).where(eq(conversations.id, conversationId));
      }
      if (!others.some((other) => other.role === "owner")) {
        await db.update(conversationMembers).set({ role: "owner" }).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, successor.userId)));
      }
    } else {
      // Nothing left of it: an empty group, or a direct chat whose other half no longer exists.
      await deleteConversationData(conversationId);
    }
  }

  // The person's own rows.
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(authTokens).where(eq(authTokens.userId, userId));
  await db.delete(presence).where(eq(presence.userId, userId));
  await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  await db.delete(userAvatars).where(eq(userAvatars.userId, userId));
  await db.delete(stickers).where(eq(stickers.userId, userId));
  await db.delete(blockedContacts).where(or(eq(blockedContacts.userId, userId), eq(blockedContacts.blockedUserId, userId)));
  await db.delete(appeals).where(eq(appeals.userId, userId));
  await db.delete(calls).where(eq(calls.initiatorId, userId));
  await db.delete(messageReactions).where(eq(messageReactions.userId, userId));
  await db.delete(messageStars).where(eq(messageStars.userId, userId));
  await db.delete(messageHides).where(eq(messageHides.userId, userId));
  await db.delete(pollVotes).where(eq(pollVotes.userId, userId));
  await db.delete(messageMedia).where(eq(messageMedia.ownerId, userId));

  // Status updates take their views with them.
  const statusIds = (await db.select({ id: statusUpdates.id }).from(statusUpdates).where(eq(statusUpdates.userId, userId))).map((row) => row.id);
  if (statusIds.length > 0) await db.delete(statusViews).where(inArray(statusViews.statusId, statusIds));
  await db.delete(statusUpdates).where(eq(statusUpdates.userId, userId));
  await db.delete(statusViews).where(eq(statusViews.viewerId, userId));

  // Broadcast lists are personal, and being named as somebody's recipient is not a membership.
  const listIds = (await db.select({ id: broadcastLists.id }).from(broadcastLists).where(eq(broadcastLists.userId, userId))).map((row) => row.id);
  if (listIds.length > 0) await db.delete(broadcastRecipients).where(inArray(broadcastRecipients.listId, listIds));
  await db.delete(broadcastLists).where(eq(broadcastLists.userId, userId));
  await db.delete(broadcastRecipients).where(eq(broadcastRecipients.userId, userId));

  // Channels and communities the person ran.
  const channelIds = (await db.select({ id: channels.id }).from(channels).where(eq(channels.ownerId, userId))).map((row) => row.id);
  if (channelIds.length > 0) {
    await db.delete(channelPosts).where(inArray(channelPosts.channelId, channelIds));
    await db.delete(channelFollowers).where(inArray(channelFollowers.channelId, channelIds));
  }
  await db.delete(channels).where(eq(channels.ownerId, userId));
  await db.delete(channelFollowers).where(eq(channelFollowers.userId, userId));
  const communityIds = (await db.select({ id: communities.id }).from(communities).where(eq(communities.createdBy, userId))).map((row) => row.id);
  if (communityIds.length > 0) await db.delete(communityGroups).where(inArray(communityGroups.communityId, communityIds));
  await db.delete(communities).where(eq(communities.createdBy, userId));

  // Requests they made, and decisions they signed off on - the pointer is cleared, not the request,
  // so the other admins can still see who is waiting.
  await db.delete(joinRequests).where(eq(joinRequests.userId, userId));
  await db.update(joinRequests).set({ decidedBy: null }).where(eq(joinRequests.decidedBy, userId));

  await db.delete(conversationMembers).where(eq(conversationMembers.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

// ================================================================ stickers
/** The largest sticker that will be stored: small by design, since a sticker is not a photograph. */
export const MAX_STICKER_BYTES = 512 * 1024;

export async function addSticker(params: { userId: number; mimeType: string; data: string; id?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const id = params.id ?? crypto.randomUUID();
  const [row] = await db
    .insert(stickers)
    .values({ id, userId: params.userId, mimeType: params.mimeType, data: params.data })
    .returning({ id: stickers.id, mimeType: stickers.mimeType, createdAt: stickers.createdAt });
  return row ?? null;
}

export async function listStickers(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select({ id: stickers.id, mimeType: stickers.mimeType, createdAt: stickers.createdAt }).from(stickers).where(eq(stickers.userId, userId)).orderBy(desc(stickers.createdAt)).limit(200);
}

export async function getSticker(id: string) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select().from(stickers).where(eq(stickers.id, id)).limit(1);
  return row ?? null;
}

export async function removeSticker(userId: number, id: string) {
  const db = await getDb();
  if (!db) return false;
  const removed = await db.delete(stickers).where(and(eq(stickers.userId, userId), eq(stickers.id, id))).returning();
  return removed.length > 0;
}

// ================================================================ broadcast lists
export async function createBroadcastList(userId: number, name: string, recipientIds: number[]) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const id = crypto.randomUUID();
  // Yourself is never a recipient: sending to a list must not deliver to the sender.
  const recipients = Array.from(new Set(recipientIds)).filter((value) => Number.isInteger(value) && value !== userId);
  await db.transaction(async (tx) => {
    await tx.insert(broadcastLists).values({ id, userId, name });
    if (recipients.length > 0) await tx.insert(broadcastRecipients).values(recipients.map((value) => ({ listId: id, userId: value })));
  });
  return { id, recipientCount: recipients.length };
}

export async function listBroadcastLists(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const lists = await db.select().from(broadcastLists).where(eq(broadcastLists.userId, userId)).orderBy(desc(broadcastLists.updatedAt));
  if (lists.length === 0) return [];
  const recipients = await db
    .select({ listId: broadcastRecipients.listId, userId: broadcastRecipients.userId, name: users.name, username: users.username })
    .from(broadcastRecipients)
    .leftJoin(users, eq(users.id, broadcastRecipients.userId))
    .where(inArray(broadcastRecipients.listId, lists.map((list) => list.id)));
  return lists.map((list) => ({
    id: list.id,
    name: list.name,
    createdAt: list.createdAt,
    recipients: recipients.filter((row) => row.listId === list.id).map((row) => ({ userId: row.userId, name: row.name ?? row.username ?? `User ${row.userId}` })),
  }));
}

export async function deleteBroadcastList(userId: number, listId: string) {
  const db = await getDb();
  if (!db) return false;
  const [list] = await db.select({ id: broadcastLists.id }).from(broadcastLists).where(and(eq(broadcastLists.id, listId), eq(broadcastLists.userId, userId))).limit(1);
  if (!list) return false;
  await db.delete(broadcastRecipients).where(eq(broadcastRecipients.listId, listId));
  await db.delete(broadcastLists).where(eq(broadcastLists.id, listId));
  return true;
}

/** Recipients of one list, refusing to read somebody else's list. */
export async function broadcastRecipientsFor(userId: number, listId: string) {
  const db = await getDb();
  if (!db) return null;
  const [list] = await db.select().from(broadcastLists).where(and(eq(broadcastLists.id, listId), eq(broadcastLists.userId, userId))).limit(1);
  if (!list) return null;
  const rows = await db.select({ userId: broadcastRecipients.userId }).from(broadcastRecipients).where(eq(broadcastRecipients.listId, listId));
  await db.update(broadcastLists).set({ updatedAt: new Date() }).where(eq(broadcastLists.id, listId));
  return { name: list.name, recipientIds: rows.map((row) => row.userId) };
}

// ================================================================ communities
/**
 * Communities the person can see: ones they created, plus ones with a group they are in.
 *
 * Membership is derived rather than stored - see the note on the tables - so somebody who leaves the
 * last group of a community stops seeing it without any roster to update.
 */
export async function listCommunitiesForUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const mine = await db.select({ conversationId: conversationMembers.conversationId }).from(conversationMembers).where(eq(conversationMembers.userId, userId));
  const groupIds = mine.map((row) => row.conversationId);
  const links = groupIds.length
    ? await db.select({ communityId: communityGroups.communityId }).from(communityGroups).where(inArray(communityGroups.conversationId, groupIds))
    : [];
  const visibleIds = new Set(links.map((row) => row.communityId));
  const rows = await db.select().from(communities).orderBy(desc(communities.createdAt));
  const visible = rows.filter((row) => visibleIds.has(row.id) || row.createdBy === userId);
  return visible.map((row) => ({ id: row.id, name: row.name, description: row.description, createdBy: row.createdBy, createdAt: row.createdAt, isOwner: row.createdBy === userId }));
}

export async function createCommunity(userId: number, name: string, description: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const id = crypto.randomUUID();
  const [row] = await db.insert(communities).values({ id, name, description, createdBy: userId }).returning();
  return row ?? null;
}

/** Whether this person may act on the community: its creator, or an admin of one of its groups. */
export async function canManageCommunity(communityId: string, userId: number) {
  const db = await getDb();
  if (!db) return false;
  const [community] = await db.select({ createdBy: communities.createdBy }).from(communities).where(eq(communities.id, communityId)).limit(1);
  if (!community) return false;
  if (community.createdBy === userId) return true;
  const links = await db.select({ conversationId: communityGroups.conversationId }).from(communityGroups).where(eq(communityGroups.communityId, communityId));
  if (links.length === 0) return false;
  const rows = await db
    .select({ role: conversationMembers.role })
    .from(conversationMembers)
    .where(and(inArray(conversationMembers.conversationId, links.map((link) => link.conversationId)), eq(conversationMembers.userId, userId)));
  return rows.some((row) => row.role === "owner" || row.role === "admin");
}

export async function canSeeCommunity(communityId: string, userId: number) {
  const db = await getDb();
  if (!db) return false;
  const [community] = await db.select({ createdBy: communities.createdBy }).from(communities).where(eq(communities.id, communityId)).limit(1);
  if (!community) return false;
  if (community.createdBy === userId) return true;
  const links = await db.select({ conversationId: communityGroups.conversationId }).from(communityGroups).where(eq(communityGroups.communityId, communityId));
  if (links.length === 0) return false;
  const rows = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(and(inArray(conversationMembers.conversationId, links.map((link) => link.conversationId)), eq(conversationMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** A community with its groups and the people in them. */
export async function communityDetail(communityId: string, userId: number) {
  const db = await getDb();
  if (!db) return null;
  if (!(await canSeeCommunity(communityId, userId))) return null;
  const [community] = await db.select().from(communities).where(eq(communities.id, communityId)).limit(1);
  if (!community) return null;

  const links = await db.select({ conversationId: communityGroups.conversationId }).from(communityGroups).where(eq(communityGroups.communityId, communityId));
  const groupIds = links.map((link) => link.conversationId);
  const groups = groupIds.length
    ? await db
        .select({ id: conversations.id, title: conversations.title, kind: conversations.kind })
        .from(conversations)
        .where(inArray(conversations.id, groupIds))
    : [];
  const memberRows = groupIds.length
    ? await db
        .select({ userId: conversationMembers.userId, name: users.name, username: users.username })
        .from(conversationMembers)
        .innerJoin(users, eq(users.id, conversationMembers.userId))
        .where(inArray(conversationMembers.conversationId, groupIds))
    : [];
  // One entry per person, however many of the community's groups they are in.
  const members = new Map<number, string>();
  for (const row of memberRows) members.set(row.userId, row.name ?? row.username ?? `User ${row.userId}`);

  return {
    id: community.id,
    name: community.name,
    description: community.description,
    createdBy: community.createdBy,
    isOwner: community.createdBy === userId,
    canManage: await canManageCommunity(communityId, userId),
    groups,
    members: Array.from(members.entries()).map(([id, name]) => ({ userId: id, name })),
  };
}

/** Links a group into a community. Only a group admin acting on a community they can manage may do it. */
export async function linkCommunityGroup(communityId: string, conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  if (!(await canManageCommunity(communityId, userId))) throw new Error("Only a community admin can do that");
  const [conversation] = await db.select({ id: conversations.id, kind: conversations.kind }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conversation) throw new Error("That group no longer exists");
  if (conversation.kind !== "group") throw new Error("Only groups can join a community");
  const access = await getConversationAccess(conversationId, userId);
  if (!access || !permitted("admins", access.role)) throw new Error("Only an admin of that group can add it to a community");
  await db.insert(communityGroups).values({ communityId, conversationId }).onConflictDoNothing();
  return true;
}

export async function unlinkCommunityGroup(communityId: string, conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return false;
  if (!(await canManageCommunity(communityId, userId))) throw new Error("Only a community admin can do that");
  const removed = await db.delete(communityGroups).where(and(eq(communityGroups.communityId, communityId), eq(communityGroups.conversationId, conversationId))).returning();
  return removed.length > 0;
}

export async function deleteCommunity(communityId: string, userId: number) {
  const db = await getDb();
  if (!db) return false;
  const [community] = await db.select({ createdBy: communities.createdBy }).from(communities).where(eq(communities.id, communityId)).limit(1);
  if (!community) return false;
  // Only the creator may dissolve it, not merely any group admin.
  if (community.createdBy !== userId) throw new Error("Only the person who created this community can delete it");
  await db.delete(communityGroups).where(eq(communityGroups.communityId, communityId));
  await db.delete(communities).where(eq(communities.id, communityId));
  return true;
}
