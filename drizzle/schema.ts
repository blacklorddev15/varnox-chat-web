import { doublePrecision, integer, jsonb, pgEnum, pgTable, primaryKey, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["user", "admin"]);
export const conversationKindEnum = pgEnum("conversation_kind", ["direct", "group"]);
export const messageKindEnum = pgEnum("message_kind", ["text", "image", "video", "file", "voice", "poll", "location", "contact", "sticker"]);
/**
 * What a poll, location or contact message carries.
 *
 * These three have no file behind them like the media kinds do, so their payload rides in
 * `messages.meta` instead of adding three sets of near-empty columns to a table every message read
 * touches. Poll *votes* deliberately do not live here: two people answering at the same instant
 * would overwrite each other in a JSON blob, so they get their own table.
 */
export type MessageMeta =
  | { kind: "poll"; question: string; options: string[] }
  | { kind: "location"; lat: number; lng: number; label?: string }
  | { kind: "contact"; userId: number; name: string; username?: string; phone?: string };

export const users = pgTable("users", {
  id: serial("id").primaryKey(), openId: varchar("openId", { length: 64 }).notNull().unique(), name: text("name"), email: varchar("email", { length: 320 }), emailVerifiedAt: timestamp("emailVerifiedAt"), username: varchar("username", { length: 32 }).unique(), passwordHash: text("passwordHash"), loginMethod: varchar("loginMethod", { length: 64 }), role: roleEnum("role").default("user").notNull(), moderationStatus: varchar("moderationStatus", { length: 16 }).default("active").notNull(), suspendedUntil: timestamp("suspendedUntil"), moderationReason: text("moderationReason"), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull(), lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(), about: text("about"), avatarUpdatedAt: timestamp("avatarUpdatedAt"), phone: varchar("phone", { length: 24 }),
});
// Group settings that only admins can change. Each is "all" or "admins"; defaults are permissive so
// a group created before these columns existed behaves exactly as it did.
export const conversations = pgTable("conversations", { id: varchar("id", { length: 64 }).primaryKey(), title: varchar("title", { length: 255 }), description: varchar("description", { length: 255 }), kind: conversationKindEnum("kind").default("direct").notNull(), createdBy: integer("createdBy").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull(), disappearSeconds: integer("disappearSeconds"), whoCanSend: varchar("whoCanSend", { length: 16 }).default("all").notNull(), whoCanEditInfo: varchar("whoCanEditInfo", { length: 16 }).default("all").notNull(), whoCanAddMembers: varchar("whoCanAddMembers", { length: 16 }).default("all").notNull(), approveNewMembers: integer("approveNewMembers").default(0).notNull(), // Moderation, mirroring `channels`: a group an owner has suspended. Only an owner account can set it.
suspendedAt: timestamp("suspendedAt"), suspendedReason: text("suspendedReason") });

// Pending requests from invite links, in groups that review people before letting them in.
//
// A request is its own row rather than a member row with a pending flag, because a pending person is
// deliberately not a member: they must not show up in the member list, be counted in it, or be able to
// read the chat. The pair is the key, so asking twice changes nothing.
// inviteCode records which link the request came from, because the link's use is only spent when an
// admin approves - the row has to remember where it came from for that to be possible.
export const joinRequests = pgTable("joinRequests", { conversationId: varchar("conversationId", { length: 64 }).notNull(), userId: integer("userId").notNull(), status: varchar("status", { length: 16 }).default("pending").notNull(), inviteCode: varchar("inviteCode", { length: 32 }), requestedAt: timestamp("requestedAt").defaultNow().notNull(), decidedAt: timestamp("decidedAt"), decidedBy: integer("decidedBy") }, (table) => ({ pk: primaryKey({ columns: [table.conversationId, table.userId] }) }));
// Per-person state for a chat lives here rather than in shared columns: archiving, muting,
// pinning and drafts are personal, and one member's choices must not rewrite everyone's row.
export const conversationMembers = pgTable("conversationMembers", { conversationId: varchar("conversationId", { length: 64 }).notNull(), userId: integer("userId").notNull(), joinedAt: timestamp("joinedAt").defaultNow().notNull(), lastReadAt: timestamp("lastReadAt"), lastDeliveredAt: timestamp("lastDeliveredAt"), role: varchar("role", { length: 16 }).default("member").notNull(), archived: integer("archived").default(0).notNull(), muted: integer("muted").default(0).notNull(), pinned: integer("pinned").default(0).notNull(), draft: text("draft"), mediaAutoLoad: integer("mediaAutoLoad").default(1).notNull(), // "Chat lock": this reader must re-enter the app PIN to open this thread.
  // Per person, because locking a chat is a decision about one screen, not about the conversation -
  // one participant locking it must not lock it for everybody.
  lockedAt: timestamp("lockedAt") }, (table) => ({ pk: primaryKey({ columns: [table.conversationId, table.userId] }) }));
export const messages = pgTable("messages", { id: varchar("id", { length: 64 }).primaryKey(), conversationId: varchar("conversationId", { length: 64 }).notNull(), senderId: integer("senderId").notNull(), body: text("body"), kind: messageKindEnum("kind").default("text").notNull(), mediaUrl: text("mediaUrl"), mediaMime: varchar("mediaMime", { length: 160 }), mediaName: varchar("mediaName", { length: 255 }), voiceDurationMs: integer("voiceDurationMs"), replyToId: varchar("replyToId", { length: 64 }), forwardedFromId: varchar("forwardedFromId", { length: 64 }), viewOnce: integer("viewOnce").default(0).notNull(), editedAt: timestamp("editedAt"), deletedAt: timestamp("deletedAt"), expiresAt: timestamp("expiresAt"), meta: jsonb("meta").$type<MessageMeta>(), createdAt: timestamp("createdAt").defaultNow().notNull(), // A pin belongs to the conversation, not to the person who set it: everyone sees the same banner.
  // Whoever pinned it last is recorded so the sheet can say who did, and unpinning clears both.
  pinnedAt: timestamp("pinnedAt"), pinnedBy: integer("pinnedBy"), // When this message should become visible to everybody other than its sender. Null means now.
  // The sender sees it straight away so they can watch it waiting and change their mind; see
  // isDeliveredFor in db.ts, which is the single place that decides who may see it.
  scheduledAt: timestamp("scheduledAt") });
export const pushTokens = pgTable("pushTokens", { id: serial("id").primaryKey(), userId: integer("userId").notNull(), token: varchar("token", { length: 512 }).notNull().unique(), platform: varchar("platform", { length: 32 }), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
// ---------------------------------------------------------------- group invites
// The table already exists in the database from an earlier build; it was dropped from this schema at
// some point, which is why the re-creation is left out of the generated migration. Declaring it here
// again is what makes the invite routes possible without a second, competing table.
export const inviteLinks = pgTable("inviteLinks", { code: varchar("code", { length: 32 }).primaryKey(), conversationId: varchar("conversationId", { length: 64 }).notNull(), createdBy: integer("createdBy").notNull(), role: varchar("role", { length: 16 }).default("member").notNull(), expiresAt: timestamp("expiresAt"), maxUses: integer("maxUses"), uses: integer("uses").default(0).notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() });

// ---------------------------------------------------------------- message extras
// Reactions, stars and per-user hides are separate tables rather than columns on `messages`.
// They are per-person, and a column would force a rewrite of a row everybody else is reading.
// One reaction per person per message, replaced on change - which is what the apps this follows do.
export const messageReactions = pgTable("messageReactions", { messageId: varchar("messageId", { length: 64 }).notNull(), userId: integer("userId").notNull(), emoji: varchar("emoji", { length: 16 }).notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.messageId, table.userId] }) }));
export const messageStars = pgTable("messageStars", { messageId: varchar("messageId", { length: 64 }).notNull(), userId: integer("userId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.messageId, table.userId] }) }));
// "Delete for me": the message row survives for everybody else, it is only hidden from one reader.
export const messageHides = pgTable("messageHides", { messageId: varchar("messageId", { length: 64 }).notNull(), userId: integer("userId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.messageId, table.userId] }) }));
// "Keep in chat": a disappearing message one reader has asked to keep.
//
// Per-person, because two people in the same chat can disagree about whether to keep something, and
// the sender's timer must not be able to delete a copy the recipient was promised. The expiry check
// consults this table, so a kept row survives for that reader only - everybody else's timer still
// runs out on schedule.
export const messageKeeps = pgTable("messageKeeps", { messageId: varchar("messageId", { length: 64 }).notNull(), userId: integer("userId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.messageId, table.userId] }) }));
// One vote per person per poll, replaced when they change their answer. `optionIndex` is kept
// rather than a foreign key to an option row, because the options are part of the message and never
// change after it is sent - editing a poll is not supported, and a stale index simply lands out of
// range and is ignored when the tally is built.
export const pollVotes = pgTable("pollVotes", { messageId: varchar("messageId", { length: 64 }).notNull(), userId: integer("userId").notNull(), optionIndex: integer("optionIndex").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.messageId, table.userId] }) }));
// autoDownloadMedia and defaultDisappearSeconds are the account-wide defaults that any single chat can
// override. Both start at what the app did before they could be changed: downloads on, timer off.
export const userSettings = pgTable("userSettings", { userId: integer("userId").primaryKey(), readReceipts: integer("readReceipts").default(1).notNull(), lastSeen: integer("lastSeen").default(1).notNull(), darkTheme: integer("darkTheme").default(0).notNull(), notificationsMessages: integer("notificationsMessages").default(1).notNull(), notificationsGroups: integer("notificationsGroups").default(1).notNull(), notificationsCalls: integer("notificationsCalls").default(1).notNull(), autoDownloadMedia: integer("autoDownloadMedia").default(1).notNull(), defaultDisappearSeconds: integer("defaultDisappearSeconds").default(0).notNull(), // Who may see each part of the profile, and who may add this person to a group.
  // Stored as a word rather than a number so the value is readable in the database and a new tier
  // can be added without renumbering what is already stored.
  profilePhotoVisibility: varchar("profilePhotoVisibility", { length: 16 }).default("everyone").notNull(),
  aboutVisibility: varchar("aboutVisibility", { length: 16 }).default("everyone").notNull(),
  statusVisibility: varchar("statusVisibility", { length: 16 }).default("everyone").notNull(),
  // Being added to groups by strangers is the complaint people change first.
  groupAddPolicy: varchar("groupAddPolicy", { length: 16 }).default("everyone").notNull(),
  silenceUnknownCallers: integer("silenceUnknownCallers").default(0).notNull(), // Hashed with the same scrypt scheme as the account password. Null means no two-step PIN is set.
  pinHash: text("pinHash"), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
// ---------------------------------------------------------------- presence
// "Is this person reachable right now." One upserted row per user rather than an append-only log,
// because only the latest value is ever read - history would grow for data nothing consumes.
// Typing is a short lease on the same row: it expires by itself, so a client that drops out
// mid-sentence cannot leave the indicator stuck on for everyone else.
export const presence = pgTable("presence", { userId: integer("userId").primaryKey(), lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(), typingConversationId: varchar("typingConversationId", { length: 64 }), typingUntil: timestamp("typingUntil") });
export type Presence = typeof presence.$inferSelect;
export const blockedContacts = pgTable("blockedContacts", { userId: integer("userId").notNull(), blockedUserId: integer("blockedUserId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.userId, table.blockedUserId] }) }));
// reviewDueAt is when the person who asked for a review is told to expect an answer by. It is a promise
// made as the request is filed, not a schedule: nothing restores an account on a timer. The account comes
// back only when someone actually approves the review.
export const appeals = pgTable("appeals", { id: serial("id").primaryKey(), userId: integer("userId").notNull(), reason: text("reason").notNull(), status: varchar("status", { length: 16 }).default("pending").notNull(), reviewedBy: integer("reviewedBy"), reviewNote: text("reviewNote"), reviewDueAt: timestamp("reviewDueAt"), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
export const authTokens = pgTable("authTokens", { id: serial("id").primaryKey(), userId: integer("userId").notNull(), kind: varchar("kind", { length: 32 }).notNull(), tokenHash: varchar("tokenHash", { length: 128 }).notNull().unique(), expiresAt: timestamp("expiresAt").notNull(), usedAt: timestamp("usedAt"), createdAt: timestamp("createdAt").defaultNow().notNull() });

// ---------------------------------------------------------------- abuse reports
// A report is filed by a user and decided by a moderator, which is why `status` and `reviewedBy`
// sit on the same row as the complaint: the queue and the decision are one record, so nothing can
// be adjudicated twice or forgotten between two tables.
//
// `excerpt` is a copy of what was reported. The message itself can be edited or deleted after the
// report lands, and a moderator who cannot see the original has nothing to judge. A target is
// optional because a report can be about an account with no single message behind it.
export const reports = pgTable("reports", { id: serial("id").primaryKey(), reporterId: integer("reporterId").notNull(), targetUserId: integer("targetUserId"), conversationId: varchar("conversationId", { length: 64 }), messageId: varchar("messageId", { length: 64 }), category: varchar("category", { length: 32 }).notNull(), note: text("note"), excerpt: text("excerpt"), status: varchar("status", { length: 16 }).default("open").notNull(), reviewedBy: integer("reviewedBy"), reviewNote: text("reviewNote"), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });

// ---------------------------------------------------------------- link previews
// One row per URL, shared by every message that contains it, so a link pasted into fifty chats is
// fetched once. `failedAt` caches a dead link: without it, a URL that 404s would be refetched on
// every render of every message that mentions it.
export const linkPreviews = pgTable("linkPreviews", { url: varchar("url", { length: 1024 }).primaryKey(), title: varchar("title", { length: 300 }), description: text("description"), siteName: varchar("siteName", { length: 120 }), imageUrl: varchar("imageUrl", { length: 1024 }), fetchedAt: timestamp("fetchedAt"), failedAt: timestamp("failedAt") });

// ---------------------------------------------------------------- signed-in devices
// One row per issued session, so a person can see where their account is signed in and end any of it.
//
// Sessions are otherwise stateless JWTs, which are impossible to withdraw: the token stays valid until
// it expires, and nothing can tell it apart from a token that was issued legitimately. The row is what
// makes "sign out that device" mean something - the id travels in the token as `jti`, and a request
// whose session row is revoked or gone is refused.
export const sessions = pgTable("sessions", { id: varchar("id", { length: 64 }).primaryKey(), userId: integer("userId").notNull(), userAgent: varchar("userAgent", { length: 255 }), platform: varchar("platform", { length: 32 }), createdAt: timestamp("createdAt").defaultNow().notNull(), lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(), revokedAt: timestamp("revokedAt"), expiresAt: timestamp("expiresAt").notNull() });

// ---------------------------------------------------------------- stickers
// A personal sticker library. There is no artwork to ship and no object storage to host a pack in, so a
// sticker is something the person makes: an image they already sent or received, kept in their own
// library and trimmed to a square by the client before it is stored. That keeps the feature real without
// inventing a pack gallery that has no images behind it.
export const stickers = pgTable("stickers", { id: varchar("id", { length: 64 }).primaryKey(), userId: integer("userId").notNull(), mimeType: text("mimeType").notNull(), data: text("data").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() });

// ---------------------------------------------------------------- broadcast lists
// A list is personal and one-way: it names a set of people, and sending to it delivers an ordinary
// direct message to each of them. Nobody sees that the message went to more than one person, which is
// the whole point of the feature and the reason recipients are just user ids rather than a conversation.
export const broadcastLists = pgTable("broadcastLists", { id: varchar("id", { length: 64 }).primaryKey(), userId: integer("userId").notNull(), name: varchar("name", { length: 64 }).notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });
export const broadcastRecipients = pgTable("broadcastRecipients", { listId: varchar("listId", { length: 64 }).notNull(), userId: integer("userId").notNull() }, (table) => ({ pk: primaryKey({ columns: [table.listId, table.userId] }) }));

// ---------------------------------------------------------------- communities
// A community gathers existing groups rather than owning its own membership. Who belongs is therefore
// derived from the linked groups instead of being stored again: a second roster would drift the moment
// somebody left a group, and there would be two answers to the same question.
export const communities = pgTable("communities", { id: varchar("id", { length: 64 }).primaryKey(), name: varchar("name", { length: 80 }).notNull(), description: varchar("description", { length: 255 }), createdBy: integer("createdBy").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() });
export const communityGroups = pgTable("communityGroups", { communityId: varchar("communityId", { length: 64 }).notNull(), conversationId: varchar("conversationId", { length: 64 }).notNull() }, (table) => ({ pk: primaryKey({ columns: [table.communityId, table.conversationId] }) }));

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
// A group or community photo, stored exactly the way a profile photo is: one row per conversation.
// Groups used to be initials only, because `conversations` has no image column to hold one.
export const conversationIcons = pgTable("conversationIcons", { conversationId: varchar("conversationId", { length: 64 }).primaryKey(), mimeType: text("mimeType").notNull(), data: text("data").notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull() });

// ---------------------------------------------------------------- group activity
// Who joined, who left, who changed what. The `detail` column holds the shape of the change and
// never message content, because every member can read this log.
export const groupEvents = pgTable("groupEvents", { id: serial("id").primaryKey(), conversationId: varchar("conversationId", { length: 64 }).notNull(), actorId: integer("actorId"), kind: varchar("kind", { length: 32 }).notNull(), targetUserId: integer("targetUserId"), detail: varchar("detail", { length: 255 }), createdAt: timestamp("createdAt").defaultNow().notNull() });
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
export const statusUpdates = pgTable("statusUpdates", { id: varchar("id", { length: 64 }).primaryKey(), userId: integer("userId").notNull(), kind: varchar("kind", { length: 8 }).default("text").notNull(), body: text("body"), mediaUrl: text("mediaUrl"), background: varchar("background", { length: 16 }).default("amber").notNull(), // Video and voice statuses need to know what the media is and how long a clip runs.
  mediaMime: varchar("mediaMime", { length: 100 }), voiceDurationMs: integer("voiceDurationMs"), createdAt: timestamp("createdAt").defaultNow().notNull(), expiresAt: timestamp("expiresAt").notNull(), removedAt: timestamp("removedAt"), removedBy: integer("removedBy") });
export const statusViews = pgTable("statusViews", { statusId: varchar("statusId", { length: 64 }).notNull(), viewerId: integer("viewerId").notNull(), viewedAt: timestamp("viewedAt").defaultNow().notNull() }, (table) => ({ pk: primaryKey({ columns: [table.statusId, table.viewerId] }) }));

// ---------------------------------------------------------------- channels
// One-to-many broadcast feeds: anyone can follow, only the owner posts.
export const channels = pgTable("channels", { id: varchar("id", { length: 64 }).primaryKey(), ownerId: integer("ownerId").notNull(), name: varchar("name", { length: 80 }).notNull(), description: varchar("description", { length: 255 }), createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().notNull(), suspendedAt: timestamp("suspendedAt"), suspendedReason: text("suspendedReason") });
export const channelPosts = pgTable("channelPosts", { id: varchar("id", { length: 64 }).primaryKey(), channelId: varchar("channelId", { length: 64 }).notNull(), authorId: integer("authorId").notNull(), body: text("body").notNull(), mediaUrl: text("mediaUrl"), createdAt: timestamp("createdAt").defaultNow().notNull(), removedAt: timestamp("removedAt"), removedBy: integer("removedBy") });
export const channelFollowers = pgTable("channelFollowers", { channelId: varchar("channelId", { length: 64 }).notNull(), userId: integer("userId").notNull(), followedAt: timestamp("followedAt").defaultNow().notNull(), lastReadAt: timestamp("lastReadAt") }, (table) => ({ pk: primaryKey({ columns: [table.channelId, table.userId] }) }));

export type StatusUpdate = typeof statusUpdates.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type ChannelPost = typeof channelPosts.$inferSelect;

// ---------------------------------------------------------------- live location
// A location that keeps moving, as opposed to the static `location` message meta, which is a fixed
// point sent once. This row is updated repeatedly and expires on its own.
export const liveLocations = pgTable("liveLocations", {
  id: varchar("id", { length: 64 }).primaryKey(),
  conversationId: varchar("conversationId", { length: 64 }).notNull(),
  userId: integer("userId").notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  label: varchar("label", { length: 120 }),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  // The share ends by itself, which is the difference between sharing a location live and being
  // tracked: even if the sender forgets about it, the row stops being served.
  expiresAt: timestamp("expiresAt").notNull(),
  stoppedAt: timestamp("stoppedAt"),
});

// ---------------------------------------------------------------- saved contacts
// A name only its owner sees. Kept apart from users.name deliberately: renaming somebody in your own
// list must not rename them for everybody else.
export const contacts = pgTable(
  "contacts",
  { ownerId: integer("ownerId").notNull(), targetId: integer("targetId").notNull(), displayName: varchar("displayName", { length: 80 }).notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() },
  (table) => ({ pk: primaryKey({ columns: [table.ownerId, table.targetId] }) }),
);

// ---------------------------------------------------------------- events
export const events = pgTable("events", {
  id: varchar("id", { length: 64 }).primaryKey(),
  conversationId: varchar("conversationId", { length: 64 }).notNull(),
  creatorId: integer("creatorId").notNull(),
  title: varchar("title", { length: 120 }).notNull(),
  description: text("description"),
  startsAt: timestamp("startsAt").notNull(),
  endsAt: timestamp("endsAt"),
  location: varchar("location", { length: 200 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  cancelledAt: timestamp("cancelledAt"),
});

// One row per person per event. The composite key is what stops somebody answering twice, so a
// change of mind updates the answer rather than adding a second one.
export const eventRsvps = pgTable(
  "eventRsvps",
  { eventId: varchar("eventId", { length: 64 }).notNull(), userId: integer("userId").notNull(), response: varchar("response", { length: 16 }).notNull(), createdAt: timestamp("createdAt").defaultNow().notNull() },
  (table) => ({ pk: primaryKey({ columns: [table.eventId, table.userId] }) }),
);

// ---------------------------------------------------------------- business catalog
// A plain list of things a person offers. The price is an integer of minor units because money is
// not a floating point number, and storing it as one is how you get 0.30000000000000004.
export const catalogItems = pgTable("catalogItems", {
  id: varchar("id", { length: 64 }).primaryKey(),
  ownerId: integer("ownerId").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  priceCents: integer("priceCents"),
  currency: varchar("currency", { length: 8 }).default("USD").notNull(),
  imageUrl: text("imageUrl"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  archivedAt: timestamp("archivedAt"),
});

// ---------------------------------------------------------------- device linking
// A short-lived code that signs a second device in without a password.
//
// The code is the entire credential, so it is single-use, short-lived and deliberately short enough
// to type: whoever holds it can add a device to the account that issued it.
// A browser push subscription, for notifications with the page closed.
//
// Three parts and none are interchangeable: the endpoint is the delivery address, and the two keys
// are what encrypt the payload so that only that browser can read it - the push service relays a
// blob it cannot open. `endpoint` is text rather than varchar because FCM endpoints are long and a
// truncation here would be a subscription that silently never receives anything.
//
// Its own table rather than a row in pushTokens: a native push token is one opaque string, while
// this is a compound value, and squeezing it into a varchar would mean encoding and decoding it.
export const webPushSubscriptions = pgTable("webPushSubscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const deviceLinkCodes = pgTable("deviceLinkCodes", {
  code: varchar("code", { length: 16 }).primaryKey(),
  userId: integer("userId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
});
