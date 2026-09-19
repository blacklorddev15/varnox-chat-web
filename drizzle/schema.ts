import { integer, pgEnum, pgTable, primaryKey, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["user", "admin"]);
export const conversationKindEnum = pgEnum("conversation_kind", ["direct", "group"]);
export const messageKindEnum = pgEnum("message_kind", ["text", "image", "video", "file", "voice"]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(), openId: varchar("openId", { length: 64 }).notNull().unique(), name: text("name"), email: varchar("email", { length: 320 }), emailVerifiedAt: timestamp("emailVerifiedAt"), username: varchar("username", { length: 32 }).unique(), passwordHash: text("passwordHash"), loginMethod: varchar("loginMethod", { length: 64 }), role: roleEnum("role").default("user").notNull(), moderationStatus: varchar("moderationStatus", { length: 16 }).default("active").notNull(), suspendedUntil: timestamp("suspendedUntil"), moderationReason: text("moderationReason"), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull(), lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(), about: text("about"), avatarUpdatedAt: timestamp("avatarUpdatedAt"),
});
export const conversations = pgTable("conversations", { id: varchar("id", { length: 64 }).primaryKey(), title: varchar("title", { length: 255 }), kind: conversationKindEnum("kind").default("direct").notNull(), createdBy: integer("createdBy").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
export const conversationMembers = pgTable("conversationMembers", { conversationId: varchar("conversationId", { length: 64 }).notNull(), userId: integer("userId").notNull(), joinedAt: timestamp("joinedAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.conversationId, table.userId] }) }));
export const messages = pgTable("messages", { id: varchar("id", { length: 64 }).primaryKey(), conversationId: varchar("conversationId", { length: 64 }).notNull(), senderId: integer("senderId").notNull(), body: text("body"), kind: messageKindEnum("kind").default("text").notNull(), mediaUrl: text("mediaUrl"), mediaMime: varchar("mediaMime", { length: 160 }), mediaName: varchar("mediaName", { length: 255 }), voiceDurationMs: integer("voiceDurationMs"), createdAt: timestamp("createdAt").defaultNow().notNull() });
export const pushTokens = pgTable("pushTokens", { id: serial("id").primaryKey(), userId: integer("userId").notNull(), token: varchar("token", { length: 512 }).notNull().unique(), platform: varchar("platform", { length: 32 }), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
export const userSettings = pgTable("userSettings", { userId: integer("userId").primaryKey(), readReceipts: integer("readReceipts").default(1).notNull(), lastSeen: integer("lastSeen").default(1).notNull(), darkTheme: integer("darkTheme").default(0).notNull(), notificationsMessages: integer("notificationsMessages").default(1).notNull(), notificationsGroups: integer("notificationsGroups").default(1).notNull(), notificationsCalls: integer("notificationsCalls").default(1).notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
export const blockedContacts = pgTable("blockedContacts", { userId: integer("userId").notNull(), blockedUserId: integer("blockedUserId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.userId, table.blockedUserId] }) }));
export const appeals = pgTable("appeals", { id: serial("id").primaryKey(), userId: integer("userId").notNull(), reason: text("reason").notNull(), status: varchar("status", { length: 16 }).default("pending").notNull(), reviewedBy: integer("reviewedBy"), reviewNote: text("reviewNote"), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
export const authTokens = pgTable("authTokens", { id: serial("id").primaryKey(), userId: integer("userId").notNull(), kind: varchar("kind", { length: 32 }).notNull(), tokenHash: varchar("tokenHash", { length: 128 }).notNull().unique(), expiresAt: timestamp("expiresAt").notNull(), usedAt: timestamp("usedAt"), createdAt: timestamp("createdAt").defaultNow().notNull() });

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type PushToken = typeof pushTokens.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;
export type Appeal = typeof appeals.$inferSelect;
// Profile photos are stored here (base64) rather than in object storage: this deployment has
// no BUILT_IN_FORGE_API_* credentials, so the generic upload path cannot be used. Served by
// GET /api/avatar/:userId.
export const userAvatars = pgTable("userAvatars", { userId: integer("userId").primaryKey(), mimeType: text("mimeType").notNull(), data: text("data").notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
export type UserAvatar = typeof userAvatars.$inferSelect;
