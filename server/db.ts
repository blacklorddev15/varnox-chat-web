import { and, desc, eq, gt, inArray, like, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { appeals, authTokens, blockedContacts, conversationMembers, conversations, InsertUser, messages, pushTokens, userAvatars, userSettings, users } from "../drizzle/schema";
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
  const textFields = ["name", "email", "username", "passwordHash", "loginMethod", "moderationReason"] as const;
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

export async function listConversationsForUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select({ conversation: conversations }).from(conversationMembers).innerJoin(conversations, eq(conversationMembers.conversationId, conversations.id)).where(eq(conversationMembers.userId, userId)).orderBy(desc(conversations.updatedAt));
}

export async function listMessages(conversationId: string, userId: number, since?: Date) {
  const db = await getDb();
  if (!db || !(await isConversationMember(conversationId, userId))) return [];
  const whereClause = since ? and(eq(messages.conversationId, conversationId), gt(messages.createdAt, since)) : eq(messages.conversationId, conversationId);
  return db.select().from(messages).where(whereClause).orderBy(messages.createdAt);
}

export async function createConversation(conversationId: string, createdBy: number, title?: string, memberIds: number[] = []) {
  const db = await getDb();
  if (!db) return;
  await db.insert(conversations).values({ id: conversationId, createdBy, title: title ?? null, kind: memberIds.length > 1 ? "group" : "direct" });
  await db.insert(conversationMembers).values([{ conversationId, userId: createdBy }, ...memberIds.filter((id) => id !== createdBy).map((userId) => ({ conversationId, userId }))]);
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

export async function updateUserProfile(userId: number, patch: { name?: string; about?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Account storage is not available");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.about !== undefined) set.about = patch.about;
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
