import { integer, pgEnum, pgTable, primaryKey, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["user", "admin"]);
export const conversationKindEnum = pgEnum("conversation_kind", ["direct", "group"]);
export const messageKindEnum = pgEnum("message_kind", ["text", "image", "video", "file", "voice"]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(), openId: varchar("openId", { length: 64 }).notNull().unique(), name: text("name"), email: varchar("email", { length: 320 }), emailVerifiedAt: timestamp("emailVerifiedAt"), username: varchar("username", { length: 32 }).unique(), passwordHash: text("passwordHash"), loginMethod: varchar("loginMethod", { length: 64 }), role: roleEnum("role").default("user").notNull(), moderationStatus: varchar("moderationStatus", { length: 16 }).default("active").notNull(), suspendedUntil: timestamp("suspendedUntil"), moderationReason: text("moderationReason"), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull(), lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(), about: text("about"), avatarUpdatedAt: timestamp("avatarUpdatedAt"), phone: varchar("phone", { length: 24 }),
});
export const conversations = pgTable("conversations", { id: varchar("id", { length: 64 }).primaryKey(), title: varchar("title", { length: 255 }), description: varchar("description", { length: 255 }), kind: conversationKindEnum("kind").default("direct").notNull(), createdBy: integer("createdBy").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull(), disappearSeconds: integer("disappearSeconds") });
// Per-person state for a chat lives here rather than in shared columns: archiving, muting,
// pinning and drafts are personal, and one member's choices must not rewrite everyone's row.
export const conversationMembers = pgTable("conversationMembers", { conversationId: varchar("conversationId", { length: 64 }).notNull(), userId: integer("userId").notNull(), joinedAt: timestamp("joinedAt").defaultNow().notNull(), lastReadAt: timestamp("lastReadAt"), lastDeliveredAt: timestamp("lastDeliveredAt"), role: varchar("role", { length: 16 }).default("member").notNull(), archived: integer("archived").default(0).notNull(), muted: integer("muted").default(0).notNull(), pinned: integer("pinned").default(0).notNull(), draft: text("draft") }, (table) => ({ pk: primaryKey({ columns: [table.conversationId, table.userId] }) }));
export const messages = pgTable("messages", { id: varchar("id", { length: 64 }).primaryKey(), conversationId: varchar("conversationId", { length: 64 }).notNull(), senderId: integer("senderId").notNull(), body: text("body"), kind: messageKindEnum("kind").default("text").notNull(), mediaUrl: text("mediaUrl"), mediaMime: varchar("mediaMime", { length: 160 }), mediaName: varchar("mediaName", { length: 255 }), voiceDurationMs: integer("voiceDurationMs"), replyToId: varchar("replyToId", { length: 64 }), forwardedFromId: varchar("forwardedFromId", { length: 64 }), viewOnce: integer("viewOnce").default(0).notNull(), editedAt: timestamp("editedAt"), deletedAt: timestamp("deletedAt"), expiresAt: timestamp("expiresAt"), createdAt: timestamp("createdAt").defaultNow().notNull() });
export const pushTokens = pgTable("pushTokens", { id: serial("id").primaryKey(), userId: integer("userId").notNull(), token: varchar("token", { length: 512 }).notNull().unique(), platform: varchar("platform", { length: 32 }), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
// ---------------------------------------------------------------- message extras
// Reactions, stars and per-user hides are separate tables rather than columns on `messages`.
// They are per-person, and a column would force a rewrite of a row everybody else is reading.
// One reaction per person per message, replaced on change - which is what the apps this follows do.
export const messageReactions = pgTable("messageReactions", { messageId: varchar("messageId", { length: 64 }).notNull(), userId: integer("userId").notNull(), emoji: varchar("emoji", { length: 16 }).notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.messageId, table.userId] }) }));
export const messageStars = pgTable("messageStars", { messageId: varchar("messageId", { length: 64 }).notNull(), userId: integer("userId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.messageId, table.userId] }) }));
// "Delete for me": the message row survives for everybody else, it is only hidden from one reader.
export const messageHides = pgTable("messageHides", { messageId: varchar("messageId", { length: 64 }).notNull(), userId: integer("userId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.messageId, table.userId] }) }));
export const userSettings = pgTable("userSettings", { userId: integer("userId").primaryKey(), readReceipts: integer("readReceipts").default(1).notNull(), lastSeen: integer("lastSeen").default(1).notNull(), darkTheme: integer("darkTheme").default(0).notNull(), notificationsMessages: integer("notificationsMessages").default(1).notNull(), notificationsGroups: integer("notificationsGroups").default(1).notNull(), notificationsCalls: integer("notificationsCalls").default(1).notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
// ---------------------------------------------------------------- presence
// "Is this person reachable right now." One upserted row per user rather than an append-only log,
// because only the latest value is ever read - history would grow for data nothing consumes.
// Typing is a short lease on the same row: it expires by itself, so a client that drops out
// mid-sentence cannot leave the indicator stuck on for everyone else.
export const presence = pgTable("presence", { userId: integer("userId").primaryKey(), lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(), typingConversationId: varchar("typingConversationId", { length: 64 }), typingUntil: timestamp("typingUntil") });
export type Presence = typeof presence.$inferSelect;
export const blockedContacts = pgTable("blockedContacts", { userId: integer("userId").notNull(), blockedUserId: integer("blockedUserId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.userId, table.blockedUserId] }) }));
export const appeals = pgTable("appeals", { id: serial("id").primaryKey(), userId: integer("userId").notNull(), reason: text("reason").notNull(), status: varchar("status", { length: 16 }).default("pending").notNull(), reviewedBy: integer("reviewedBy"), reviewNote: text("reviewNote"), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
export const authTokens = pgTable("authTokens", { id: serial("id").primaryKey(), userId: integer("userId").notNull(), kind: varchar("kind", { length: 32 }).notNull(), tokenHash: varchar("tokenHash", { length: 128 }).notNull().unique(), expiresAt: timestamp("expiresAt").notNull(), usedAt: timestamp("usedAt"), createdAt: timestamp("createdAt").defaultNow().notNull() });

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessageReaction = typeof messageReactions.$inferSelect;
export type PushToken = typeof pushTokens.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;
export type Appeal = typeof appeals.$inferSelect;
// Profile photos are stored here (base64) rather than in object storage: this deployment has
// no BUILT_IN_FORGE_API_* credentials, so the generic upload path cannot be used. Served by
// GET /api/avatar/:userId.
export const userAvatars = pgTable("userAvatars", { userId: integer("userId").primaryKey(), mimeType: text("mimeType").notNull(), data: text("data").notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
export type UserAvatar = typeof userAvatars.$inferSelect;
// Attachments (photos, voice notes) for deployments with no object storage, served by
// GET /api/media/:id. Kept out of the messages table so message payloads stay small.
export const messageMedia = pgTable("messageMedia", { id: serial("id").primaryKey(), ownerId: integer("ownerId").notNull(), mimeType: text("mimeType").notNull(), fileName: text("fileName"), data: text("data").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() });
export type MessageMedia = typeof messageMedia.$inferSelect;
// Call records. Audio/video itself runs through LiveKit; this table carries the ringing state,
// who started it, and the history the Calls tab shows.
export const calls = pgTable("calls", { id: varchar("id", { length: 64 }).primaryKey(), conversationId: varchar("conversationId", { length: 64 }).notNull(), initiatorId: integer("initiatorId").notNull(), room: text("room").notNull(), kind: varchar("kind", { length: 8 }).default("audio").notNull(), status: varchar("status", { length: 12 }).default("ringing").notNull(), startedAt: timestamp("startedAt").defaultNow().notNull(), answeredAt: timestamp("answeredAt"), endedAt: timestamp("endedAt") });
export type Call = typeof calls.$inferSelect;

// ---------------------------------------------------------------- status updates
// "Stories": short-lived posts that expire after a day. An image status keeps its bytes in
// messageMedia (the same base64 store chat attachments use) and only the URL here, so it
// inherits that size cap and is already served by GET /api/media/<id>.
export const statusUpdates = pgTable("statusUpdates", { id: varchar("id", { length: 64 }).primaryKey(), userId: integer("userId").notNull(), kind: varchar("kind", { length: 8 }).default("text").notNull(), body: text("body"), mediaUrl: text("mediaUrl"), background: varchar("background", { length: 16 }).default("amber").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(), expiresAt: timestamp("expiresAt").notNull(), removedAt: timestamp("removedAt"), removedBy: integer("removedBy") });
export const statusViews = pgTable("statusViews", { statusId: varchar("statusId", { length: 64 }).notNull(), viewerId: integer("viewerId").notNull(), viewedAt: timestamp("viewedAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.statusId, table.viewerId] }) }));

// ---------------------------------------------------------------- channels
// One-to-many broadcast feeds: anyone can follow, only the owner posts.
export const channels = pgTable("channels", { id: varchar("id", { length: 64 }).primaryKey(), ownerId: integer("ownerId").notNull(), name: varchar("name", { length: 80 }).notNull(), description: varchar("description", { length: 255 }), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull(), suspendedAt: timestamp("suspendedAt"), suspendedReason: text("suspendedReason") });
export const channelPosts = pgTable("channelPosts", { id: varchar("id", { length: 64 }).primaryKey(), channelId: varchar("channelId", { length: 64 }).notNull(), authorId: integer("authorId").notNull(), body: text("body").notNull(), mediaUrl: text("mediaUrl"), createdAt: timestamp("createdAt").defaultNow().notNull(), removedAt: timestamp("removedAt"), removedBy: integer("removedBy") });
export const channelFollowers = pgTable("channelFollowers", { channelId: varchar("channelId", { length: 64 }).notNull(), userId: integer("userId").notNull(), followedAt: timestamp("followedAt").defaultNow().notNull(), lastReadAt: timestamp("lastReadAt") }, (table) => ({ pk: primaryKey({ columns: [table.channelId, table.userId] }) }));

export type StatusUpdate = typeof statusUpdates.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type ChannelPost = typeof channelPosts.$inferSelect;
