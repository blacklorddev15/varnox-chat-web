import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { isObjectStorageConfigured } from "./storage";
import { MAX_DB_MEDIA_BYTES } from "./_core/mediaRoutes";
import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { hashPassword, sendEmail, verifyPassword } from "./_core/passwordAuth";
import { normalizePhone } from "./_core/phoneAuth";
import { sdk } from "./_core/sdk";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createRoomToken, isLiveKitConfigured, liveKitUrl } from "./livekit";
import { addConversationMembers, appealStatusForUsername, clearUserAvatar, createAppeal, createCallRecord, createGroupConversation, createMessage, createConversation, findOrCreateDirectConversation, expireStaleCalls, getCallRecord, getConversationRole, getIncomingCallForUser, getUserByUsername, getUserById, getUserSettings, isConversationMember, listRecentCalls, setCallStatus, listAppealsForAdmin, listAppealsForUser, listBlockedContacts, listConversationMembersDetailed, listConversationsForUser, listMessages, listUsersForAdmin, markConversationRead, moderateUser, registerPushToken, removeConversationMember, reviewAppeal, searchMessages, searchUsers, setBlockedContact, setConversationMemberRole, setUserAvatar, updateUserProfile, updateUserSettings, adminRemoveStatus, createChannel, createChannelPost, createStatus, deleteStatus, deleteChannel, followChannel, getChannel, getChannelDetail, getChannelPost, getStatus, isChannelFollower, saveMessageMedia, listActiveStatusesByAuthors, listChannelFollowers, listChannelPosts, listChannelPostsForAdmin, listChannelsForAdmin, listChannelsForUser, listContactIdsForUser, listStatusesForAdmin, listStatusViewers, listViewedStatusIds, markChannelRead, markStatusViewed, removeChannelPost, searchChannels, setChannelSuspended, unfollowChannel } from "./db";
import { storagePut } from "./storage";
import { notifyConversationMembers } from "./push";
import { messages, type User } from "../drizzle/schema";
// Message actions (reactions, stars, edits, deletes, per-chat preferences) sit with the other
// row-level operations in db.ts; imported on their own line so the list above stays readable.
import { castPollVote, chatSettingsFor, consumeViewOnce, conversationNeedsApproval, createInviteLink, decideJoinRequest, deleteMessageForEveryone, editMessageBody, effectiveDisappearSeconds, exportConversationTranscript, getConversationAccess, getConversationPermissions, getMessageById, hideMessageForUser, listInviteLinks, listJoinRequests, listStarredMessages, markConversationDelivered, permitted, reactToMessage, redeemInviteLink, revokeInviteLink, setConversationDescription, setConversationDisappearing, setConversationMemberFlags, setConversationPermissions, setMessageStar } from "./db";
// Presence: who is around right now, and who is mid-sentence. Also in db.ts, for the same reason.
import {
  addSticker, broadcastRecipientsFor, communityDetail, consumeAuthToken, createAuthToken, createBroadcastList, createCommunity,
  deleteBroadcastList, deleteCommunity, deleteUserAccount, getPinHash, linkCommunityGroup, listBroadcastLists, listCommunitiesForUser,
  listSessions, listStickers, MAX_STICKER_BYTES, removeSticker, revokeOtherSessions, revokeSession, setPinHash,
  unlinkCommunityGroup,
} from "./db";
import { getConversationSummary, leaveGroup, listConversationMemberIds, listConversationPeerIds, readPresenceForUsers, readPresenceInbox, recordPresence } from "./db";
// Server-Sent Events nudge channel; see nudgeConversation below.
import { isRealtimeEnabled, publishToUsers } from "./realtime";

/**
 * Loads a message and proves the caller can see the conversation it lives in. Every message-level
 * action needs exactly this, and skipping it would let anyone edit or delete any message simply by
 * guessing an id.
 */
async function requireVisibleMessage(messageId: string, userId: number) {
  const message = await getMessageById(messageId);
  if (!message || !(await isConversationMember(message.conversationId, userId))) throw new Error("That message is not in one of your chats");
  return message;
}

/**
 * Pokes the other members of a conversation over the realtime stream, so their client can refetch
 * immediately instead of waiting for its next poll.
 *
 * Fire-and-forget on purpose: a failed nudge must never fail the write that caused it. Events are a
 * latency optimisation, not a delivery guarantee - every client keeps a slow safety-net poll, so a
 * dropped event costs a few seconds rather than the message.
 */
async function nudgeConversation(conversationId: string, actorId: number, type: string) {
  if (!isRealtimeEnabled()) return;
  try {
    const members = (await listConversationMemberIds(conversationId)).filter((id) => id !== actorId);
    publishToUsers(members, { type, conversationId });
  } catch (error) {
    console.warn("[Realtime] nudge failed", error);
  }
}

const messageKind = z.enum(["text", "image", "video", "file", "voice", "poll", "location", "contact", "sticker"]);

// ---- poll / location / contact payloads --------------------------------------------------------
// These three kinds carry no file, so their content rides in `messages.meta`. It is validated here
// rather than trusted from the client: a poll with a single option, or a latitude of 900, would be
// a row that every other client then has to defend itself against.
const pollMetaSchema = z.object({ question: z.string().trim().min(1).max(300), options: z.array(z.string().trim().min(1).max(120)).min(2).max(12) });
const locationMetaSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().trim().max(120).optional() });
const contactMetaSchema = z.object({ userId: z.number().int().positive(), name: z.string().trim().min(1).max(120), username: z.string().trim().max(32).optional(), phone: z.string().trim().max(24).optional() });

/** Narrows a payload to the kind it claims to be, and returns null for the kinds that carry none. */
function normalizeMessageMeta(kind: string, raw: unknown) {
  if (kind === "poll") {
    const parsed = pollMetaSchema.parse(raw);
    // Two options differing only in case or spacing are the same answer offered twice, which makes
    // the result meaningless. Rejected outright rather than silently merged.
    const seen = new Set<string>();
    for (const option of parsed.options) {
      const key = option.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) throw new Error("A poll cannot offer the same answer twice");
      seen.add(key);
    }
    return { kind: "poll" as const, question: parsed.question, options: parsed.options };
  }
  if (kind === "location") { const parsed = locationMetaSchema.parse(raw); return { kind: "location" as const, ...parsed }; }
  if (kind === "contact") { const parsed = contactMetaSchema.parse(raw); return { kind: "contact" as const, ...parsed }; }
  return null;
}

/** Who a group setting allows to act: everyone in the group, or only its admins. */
/** PIN failures per account. See verifyPin for why this is a speed bump rather than a wall. */
const pinAttempts = new Map<number, { failures: number; lockedUntil: number }>();

function lockedForMsOf(lockedUntil: number, now: number) {
  return lockedUntil > now ? lockedUntil - now : 0;
}

/** Confirms the account password before anything irreversible or security-relevant happens. */
async function requireAccountPassword(user: User, password: string) {
  if (!user.passwordHash) throw new Error("This account does not sign in with a password, so this cannot be confirmed here");
  if (!(await verifyPassword(password, user.passwordHash))) throw new Error("That password is not right");
}

/**
 * Binds a one-time code to the number it was requested for, by hashing the two together.
 *
 * The table stores only the hash, so a code that leaks on its own cannot be spent on a different
 * number - the confirmation has to present the same pair.
 */
function bindCodeToPhone(code: string, phone: string) {
  return createHash("sha256").update(`${code}:${phone}`).digest("hex");
}

function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  if (!domain) return "your email";
  return `${name.slice(0, 1)}${"*".repeat(Math.max(1, name.length - 1))}@${domain}`;
}

const permissionWho = z.enum(["all", "admins"]);

/** Options of a stored poll, read defensively: `meta` is JSON that an older or newer build wrote. */
function pollOptionsOf(meta: unknown): string[] {
  const options = (meta as { options?: unknown } | null)?.options;
  return Array.isArray(options) ? options.filter((option): option is string => typeof option === "string") : [];
}

/** One row of listActiveStatusesByAuthors, used to type the grouped feed. */
type StatusRow = Awaited<ReturnType<typeof listActiveStatusesByAuthors>>[number];

export const appRouter = router({
  system: router({ health: publicProcedure.query(() => ({ status: "ok" as const })) }),
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  conversations: router({
    list: protectedProcedure.query(({ ctx }) => listConversationsForUser(ctx.user.id)),
    markRead: protectedProcedure.input(z.object({ conversationId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      const result = await markConversationRead(input.conversationId, ctx.user.id);
      // Lets the sender's ticks turn blue without waiting for their next poll.
      void nudgeConversation(input.conversationId, ctx.user.id, "read");
      return result;
    }),
    search: protectedProcedure.input(z.object({ query: z.string().trim().min(1).max(100) })).query(({ ctx, input }) => searchMessages(ctx.user.id, input.query)),
    // ---- groups: the creator owns the group, and only the owner manages admins ----------
    createGroup: protectedProcedure.input(z.object({ title: z.string().trim().min(1).max(80), memberIds: z.array(z.number().int().positive()).max(256).default([]) })).mutation(async ({ ctx, input }) => {
      const conversationId = await createGroupConversation(ctx.user.id, input.title, input.memberIds);
      return { conversationId };
    }),
    members: protectedProcedure.input(z.object({ conversationId: z.string().min(1) })).query(async ({ ctx, input }) => {
      const role = await getConversationRole(input.conversationId, ctx.user.id);
      if (!role) throw new Error("You are not a member of this group");
      const members = await listConversationMembersDetailed(input.conversationId);
      // The description column and the mutation that writes it both existed, but nothing ever read
      // it back, so a group description could be set and never seen.
      const summary = await getConversationSummary(input.conversationId);
      return { role, members, title: summary?.title ?? null, description: summary?.description ?? null };
    }),
    addMembers: protectedProcedure.input(z.object({ conversationId: z.string().min(1), userIds: z.array(z.number().int().positive()).min(1).max(256) })).mutation(async ({ ctx, input }) => {
      const access = await getConversationAccess(input.conversationId, ctx.user.id);
      if (!access) throw new Error("You are not a member of this group");
      if (!permitted(access.whoCanAddMembers, access.role)) throw new Error("Only group admins can add members");
      const added = await addConversationMembers(input.conversationId, input.userIds);
      return { added };
    }),
    removeMember: protectedProcedure.input(z.object({ conversationId: z.string().min(1), userId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const role = await getConversationRole(input.conversationId, ctx.user.id);
      if (!role) throw new Error("You are not a member of this group");
      if (input.userId === ctx.user.id) throw new Error("You cannot remove yourself from the group");
      const targetRole = await getConversationRole(input.conversationId, input.userId);
      if (!targetRole) throw new Error("That person is not in this group");
      if (targetRole === "owner") throw new Error("The group owner cannot be removed");
      // The owner can remove anyone below them; an admin can only remove plain members.
      if (role !== "owner" && !(role === "admin" && targetRole === "member")) throw new Error("Only the group owner can remove an admin");
      await removeConversationMember(input.conversationId, input.userId);
      return { removed: input.userId };
    }),
    setRole: protectedProcedure.input(z.object({ conversationId: z.string().min(1), userId: z.number().int().positive(), role: z.enum(["admin", "member"]) })).mutation(async ({ ctx, input }) => {
      const role = await getConversationRole(input.conversationId, ctx.user.id);
      if (role !== "owner") throw new Error("Only the group owner can manage admins");
      const targetRole = await getConversationRole(input.conversationId, input.userId);
      if (!targetRole) throw new Error("That person is not in this group");
      if (targetRole === "owner") throw new Error("The group owner role cannot be changed");
      await setConversationMemberRole(input.conversationId, input.userId, input.role);
      return { userId: input.userId, role: input.role };
    }),
    // ---- group settings and invite links ---------------------------------------------------
    /** The group's settings together with my own role: one decides what the info screen may offer,
     *  the other decides whether it offers anything at all. */
    settings: protectedProcedure.input(z.object({ conversationId: z.string().min(1) })).query(async ({ ctx, input }) => {
      const access = await getConversationAccess(input.conversationId, ctx.user.id);
      if (!access) throw new Error("You are not a member of this group");
      return { role: access.role, isAdmin: access.role === "admin" || access.role === "owner", whoCanSend: access.whoCanSend, whoCanEditInfo: access.whoCanEditInfo, whoCanAddMembers: access.whoCanAddMembers, approveNewMembers: access.approveNewMembers !== 0 };
    }),

    /** Turns one or more group settings. Admins only, because that is precisely what they gate. */
    setPermissions: protectedProcedure.input(z.object({ conversationId: z.string().min(1), whoCanSend: permissionWho.optional(), whoCanEditInfo: permissionWho.optional(), whoCanAddMembers: permissionWho.optional(), approveNewMembers: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
      const access = await getConversationAccess(input.conversationId, ctx.user.id);
      if (!access) throw new Error("You are not a member of this group");
      if (!permitted("admins", access.role)) throw new Error("Only group admins can change these settings");
      const patch: { whoCanSend?: string; whoCanEditInfo?: string; whoCanAddMembers?: string; approveNewMembers?: number } = {};
      if (input.whoCanSend) patch.whoCanSend = input.whoCanSend;
      if (input.whoCanEditInfo) patch.whoCanEditInfo = input.whoCanEditInfo;
      if (input.whoCanAddMembers) patch.whoCanAddMembers = input.whoCanAddMembers;
      if (input.approveNewMembers !== undefined) patch.approveNewMembers = input.approveNewMembers ? 1 : 0;
      if (Object.keys(patch).length > 0) {
        await setConversationPermissions(input.conversationId, patch);
        void nudgeConversation(input.conversationId, ctx.user.id, "group-updated");
      }
      return { ok: true as const };
    }),

    /** People waiting on an admin before they can get in. Admins only; others get an empty list. */
    joinRequests: protectedProcedure.input(z.object({ conversationId: z.string().min(1) })).query(async ({ ctx, input }) => {
      const access = await getConversationAccess(input.conversationId, ctx.user.id);
      if (!access || !permitted("admins", access.role)) return [];
      return listJoinRequests(input.conversationId);
    }),

    /** Approves or rejects one request. Approving is what actually creates the membership. */
    decideJoinRequest: protectedProcedure.input(z.object({ conversationId: z.string().min(1), userId: z.number().int().positive(), approve: z.boolean() })).mutation(async ({ ctx, input }) => {
      const access = await getConversationAccess(input.conversationId, ctx.user.id);
      if (!access) throw new Error("You are not a member of this group");
      if (!permitted("admins", access.role)) throw new Error("Only group admins can answer join requests");
      await decideJoinRequest({ conversationId: input.conversationId, userId: input.userId, approve: input.approve, decidedBy: ctx.user.id });
      void nudgeConversation(input.conversationId, ctx.user.id, "group-updated");
      return { ok: true as const };
    }),

    /** Existing invite links. Non-admins get an empty list rather than an error, so the screen can
     *  simply not draw the section. */
    invites: protectedProcedure.input(z.object({ conversationId: z.string().min(1) })).query(async ({ ctx, input }) => {
      const access = await getConversationAccess(input.conversationId, ctx.user.id);
      if (!access || !permitted("admins", access.role)) return [];
      const rows = await listInviteLinks(input.conversationId);
      return rows.map((row) => ({ code: row.code, uses: row.uses, maxUses: row.maxUses, expiresAt: row.expiresAt, createdAt: row.createdAt }));
    }),

    /** Mints an invite link. Zero for either limit means "no limit". */
    createInvite: protectedProcedure.input(z.object({ conversationId: z.string().min(1), expiresInHours: z.number().int().min(0).max(8760).default(0), maxUses: z.number().int().min(0).max(10000).default(0) })).mutation(async ({ ctx, input }) => {
      const access = await getConversationAccess(input.conversationId, ctx.user.id);
      if (!access) throw new Error("You are not a member of this group");
      if (!permitted("admins", access.role)) throw new Error("Only group admins can create an invite link");
      const row = await createInviteLink({ conversationId: input.conversationId, createdBy: ctx.user.id, expiresInMs: input.expiresInHours > 0 ? input.expiresInHours * 3_600_000 : null, maxUses: input.maxUses > 0 ? input.maxUses : null });
      if (!row) throw new Error("Could not create an invite link");
      return { code: row.code, uses: row.uses, maxUses: row.maxUses, expiresAt: row.expiresAt };
    }),

    revokeInvite: protectedProcedure.input(z.object({ conversationId: z.string().min(1), code: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      const access = await getConversationAccess(input.conversationId, ctx.user.id);
      if (!access) throw new Error("You are not a member of this group");
      if (!permitted("admins", access.role)) throw new Error("Only group admins can revoke an invite link");
      const revoked = await revokeInviteLink(input.conversationId, input.code);
      if (!revoked) throw new Error("That link no longer exists");
      return { ok: true as const };
    }),

    /** Redeems an invite link: whoever holds the code joins, or asks to if the group reviews people. */
    redeemInvite: protectedProcedure.input(z.object({ code: z.string().trim().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      const conversationId = await redeemInviteLink(input.code, ctx.user.id);
      // Joined outright, or filed a request the admins still have to answer. The caller is told which,
      // because "you joined" would be a lie in the second case.
      const pending = await conversationNeedsApproval(conversationId) && !(await isConversationMember(conversationId, ctx.user.id));
      void nudgeConversation(conversationId, ctx.user.id, pending ? "join-request" : "group-updated");
      return { conversationId, pending };
    }),

    /** What this chat's settings screen needs: the chat's own values plus the defaults behind them. */
    chatSettings: protectedProcedure.input(z.object({ conversationId: z.string().min(1) })).query(async ({ ctx, input }) => {
      const settings = await chatSettingsFor(input.conversationId, ctx.user.id);
      if (!settings) throw new Error("You are not a member of this conversation");
      return settings;
    }),

    /** A readable transcript of the chat, for the export screen to show and save. */
    exportChat: protectedProcedure.input(z.object({ conversationId: z.string().min(1) })).mutation(async ({ ctx, input }) => exportConversationTranscript(input.conversationId, ctx.user.id)),

    messages: protectedProcedure.input(z.object({ conversationId: z.string().min(1), since: z.string().datetime().optional() })).query(({ ctx, input }) => listMessages(input.conversationId, ctx.user.id, input.since ? new Date(input.since) : undefined)),
    ensure: protectedProcedure.input(z.object({ conversationId: z.string().min(1), title: z.string().max(255).optional() })).mutation(async ({ ctx, input }) => {
      if (!(await isConversationMember(input.conversationId, ctx.user.id))) await createConversation(input.conversationId, ctx.user.id, input.title);
      return { conversationId: input.conversationId };
    }),
    // Opening a chat with a person has to create the conversation, otherwise the client has
    // nothing to attach a composer to. Idempotent: reuses the existing 1:1 thread.
    startDirect: protectedProcedure.input(z.object({ userId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) throw new Error("Pick someone other than yourself to chat with");
      if (!(await getUserById(input.userId))) throw new Error("That account no longer exists");
      const result = await findOrCreateDirectConversation(ctx.user.id, input.userId);
      if (!result) throw new Error("Could not start that conversation");
      return result;
    }),
    send: protectedProcedure.input(z.object({ conversationId: z.string().min(1), body: z.string().max(10000).optional(), kind: messageKind.default("text"), mediaUrl: z.string().max(2000).optional(), mediaMime: z.string().max(160).optional(), mediaName: z.string().max(255).optional(), voiceDurationMs: z.number().int().min(0).max(3600000).optional(), replyToId: z.string().max(64).optional(), forwardedFromId: z.string().max(64).optional(), viewOnce: z.boolean().default(false), meta: z.unknown().optional() })).mutation(async ({ ctx, input }) => {
      const access = await getConversationAccess(input.conversationId, ctx.user.id);
      if (!access) throw new Error("You are not a member of this conversation");
      // Announcement-style groups restrict sending to admins; the setting starts at "all", so every
      // group that existed before it behaves exactly as it did.
      if (!permitted(access.whoCanSend, access.role)) throw new Error("Only admins can send messages in this group");
      // The disappearing clock is stamped at send time, so changing the setting later cannot
      // retroactively expire messages somebody already received.
      // Falls back to the sender's account-wide default when the chat itself has no setting. Without
      // the fallback that default would be a control that changes nothing.
      const disappearSeconds = await effectiveDisappearSeconds(input.conversationId, ctx.user.id);
      // Polls, locations and contacts carry their content in `meta`; the media kinds carry none.
      const meta = normalizeMessageMeta(input.kind, input.meta);
      if (!meta && (input.kind === "poll" || input.kind === "location" || input.kind === "contact")) throw new Error("That message arrived without its content");
      const message: typeof messages.$inferInsert = { id: randomUUID(), conversationId: input.conversationId, senderId: ctx.user.id, body: input.body ?? null, kind: input.kind, mediaUrl: input.mediaUrl ?? null, mediaMime: input.mediaMime ?? null, mediaName: input.mediaName ?? null, voiceDurationMs: input.voiceDurationMs ?? null, replyToId: input.replyToId ?? null, forwardedFromId: input.forwardedFromId ?? null, viewOnce: input.viewOnce ? 1 : 0, meta, expiresAt: disappearSeconds ? new Date(Date.now() + disappearSeconds * 1000) : null };
      const created = await createMessage(message);
      // A view-once photo must not be described in the notification body.
      const preview = input.viewOnce ? "Photo (view once)" : input.body ?? (input.kind === "voice" ? "Voice note" : meta?.kind === "poll" ? `Poll: ${meta.question}` : meta?.kind === "location" ? "Location" : meta?.kind === "contact" ? `Contact: ${meta.name}` : "Shared media");
      void notifyConversationMembers({ conversationId: input.conversationId, senderId: ctx.user.id, title: ctx.user.name ?? "New message", body: preview });
      void nudgeConversation(input.conversationId, ctx.user.id, "message");
      return created;
    }),

    // ---- polls ---------------------------------------------------------------------------
    /**
     * Answers a poll, or replaces an earlier answer. One row per person is enforced by the primary
     * key rather than by this code, so two taps racing each other cannot produce two votes.
     */
    votePoll: protectedProcedure.input(z.object({ messageId: z.string().min(1), optionIndex: z.number().int().min(0).max(63) })).mutation(async ({ ctx, input }) => {
      const message = await requireVisibleMessage(input.messageId, ctx.user.id);
      if (message.kind !== "poll") throw new Error("That message is not a poll");
      if (message.deletedAt) throw new Error("That poll was deleted");
      if (input.optionIndex >= pollOptionsOf(message.meta).length) throw new Error("That answer is not part of this poll");
      await castPollVote(message.id, ctx.user.id, input.optionIndex);
      void nudgeConversation(message.conversationId, ctx.user.id, "message-updated");
      return { ok: true as const };
    }),

    // ---- the message menu: react, star, edit, delete, view-once --------------------------
    react: protectedProcedure.input(z.object({ messageId: z.string().min(1), emoji: z.string().max(16).nullable() })).mutation(async ({ ctx, input }) => {
      const message = await requireVisibleMessage(input.messageId, ctx.user.id);
      await reactToMessage(message.id, ctx.user.id, input.emoji);
      void nudgeConversation(message.conversationId, ctx.user.id, "message-updated");
      return { ok: true as const };
    }),
    star: protectedProcedure.input(z.object({ messageId: z.string().min(1), starred: z.boolean() })).mutation(async ({ ctx, input }) => {
      const message = await requireVisibleMessage(input.messageId, ctx.user.id);
      await setMessageStar(message.id, ctx.user.id, input.starred);
      return { ok: true as const, starred: input.starred };
    }),
    starred: protectedProcedure.query(({ ctx }) => listStarredMessages(ctx.user.id)),
    editMessage: protectedProcedure.input(z.object({ messageId: z.string().min(1), body: z.string().trim().min(1).max(10000) })).mutation(async ({ ctx, input }) => {
      const message = await requireVisibleMessage(input.messageId, ctx.user.id);
      if (message.senderId !== ctx.user.id) throw new Error("You can only edit your own messages");
      if (message.kind !== "text") throw new Error("Only text messages can be edited");
      const ok = await editMessageBody(message.id, ctx.user.id, input.body);
      if (!ok) throw new Error("That message can no longer be edited");
      void nudgeConversation(message.conversationId, ctx.user.id, "message-updated");
      return { ok: true as const };
    }),
    deleteMessage: protectedProcedure.input(z.object({ messageId: z.string().min(1), forEveryone: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
      const message = await requireVisibleMessage(input.messageId, ctx.user.id);
      if (!input.forEveryone) {
        await hideMessageForUser(message.id, ctx.user.id);
        return { ok: true as const, forEveryone: false };
      }
      if (message.senderId !== ctx.user.id) throw new Error("Only the sender can delete a message for everyone");
      const ok = await deleteMessageForEveryone(message.id, ctx.user.id);
      if (!ok) throw new Error("That message was already deleted");
      void nudgeConversation(message.conversationId, ctx.user.id, "message-updated");
      return { ok: true as const, forEveryone: true };
    }),
    openViewOnce: protectedProcedure.input(z.object({ messageId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      const message = await requireVisibleMessage(input.messageId, ctx.user.id);
      const opened = await consumeViewOnce(message.id, ctx.user.id);
      if (!opened) throw new Error("That photo has already been opened");
      return opened;
    }),

    // ---- per-chat preferences and receipts ----------------------------------------------
    setFlags: protectedProcedure.input(z.object({ conversationId: z.string().min(1), archived: z.boolean().optional(), muted: z.boolean().optional(), pinned: z.boolean().optional(), draft: z.string().max(2000).nullable().optional(), mediaAutoLoad: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
      if (!(await isConversationMember(input.conversationId, ctx.user.id))) throw new Error("You are not a member of this conversation");
      await setConversationMemberFlags(input.conversationId, ctx.user.id, { archived: input.archived, muted: input.muted, pinned: input.pinned, draft: input.draft, mediaAutoLoad: input.mediaAutoLoad });
      return { ok: true as const };
    }),
    markDelivered: protectedProcedure.input(z.object({ conversationId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      if (!(await isConversationMember(input.conversationId, ctx.user.id))) throw new Error("You are not a member of this conversation");
      await markConversationDelivered(input.conversationId, ctx.user.id);
      return { ok: true as const };
    }),
    /**
     * Leave a group.
     *
     * There was no way out before this: `removeMember` refuses to remove yourself, so anyone added
     * by someone else was stuck in the group permanently.
     */
    leave: protectedProcedure.input(z.object({ conversationId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      const role = await getConversationRole(input.conversationId, ctx.user.id);
      if (!role) throw new Error("You are not a member of this group");
      const outcome = await leaveGroup(input.conversationId, ctx.user.id);
      // Tell the others, so their member list is right without waiting for a poll.
      void nudgeConversation(input.conversationId, ctx.user.id, "members");
      return outcome;
    }),
    setDescription: protectedProcedure.input(z.object({ conversationId: z.string().min(1), description: z.string().trim().max(255).nullable() })).mutation(async ({ ctx, input }) => {
      const access = await getConversationAccess(input.conversationId, ctx.user.id);
      if (!access) throw new Error("You are not a member of this group");
      if (!permitted(access.whoCanEditInfo, access.role)) throw new Error("Only group admins can change the description");
      await setConversationDescription(input.conversationId, input.description || null);
      return { ok: true as const };
    }),
    setDisappearing: protectedProcedure.input(z.object({ conversationId: z.string().min(1), seconds: z.number().int().min(0).max(7776000).nullable() })).mutation(async ({ ctx, input }) => {
      if (!(await isConversationMember(input.conversationId, ctx.user.id))) throw new Error("You are not a member of this conversation");
      await setConversationDisappearing(input.conversationId, input.seconds && input.seconds > 0 ? input.seconds : null);
      return { ok: true as const };
    }),
  }),
  presence: router({
    /**
     * Beaten on a timer by every signed-in client, and again whenever someone starts or stops
     * typing. One upsert and no history, because this is called often and must stay cheap.
     */
    heartbeat: protectedProcedure
      .input(z.object({ typingConversationId: z.string().min(1).max(64).nullish() }))
      .mutation(async ({ ctx, input }) => {
        await recordPresence(ctx.user.id, input.typingConversationId ?? null);
        // Only typing is nudged. Heartbeats happen every 20s for every user, and announcing those
        // would put a constant stream of pointless wake-ups on the wire.
        if (input.typingConversationId) void nudgeConversation(input.typingConversationId, ctx.user.id, "presence");
        return { ok: true } as const;
      }),
    /** Presence for the other members of one chat, which the conversation header reads. */
    forConversation: protectedProcedure
      .input(z.object({ conversationId: z.string().min(1).max(64) }))
      .query(async ({ ctx, input }) => {
        if (!(await isConversationMember(input.conversationId, ctx.user.id))) return [];
        return readPresenceForUsers(await listConversationPeerIds(input.conversationId, ctx.user.id));
      }),
    /** Presence for the whole chat list, so rows can show a typing line and an online dot. */
    inbox: protectedProcedure.query(({ ctx }) => readPresenceInbox(ctx.user.id)),
  }),
  media: router({
    upload: protectedProcedure.input(z.object({ fileName: z.string().min(1).max(255), contentType: z.string().min(1).max(160), base64: z.string().min(1).max(30_000_000) })).mutation(async ({ ctx, input }) => {
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");

      if (isObjectStorageConfigured()) {
        const key = `varnox/${ctx.user.id}/${Date.now()}-${safeName}`;
        const result = await storagePut(key, Buffer.from(input.base64, "base64"), input.contentType);
        return { ...result, fileName: input.fileName, contentType: input.contentType };
      }

      // No object storage on this deployment (no BUILT_IN_FORGE_API_*), which used to make
      // every photo and voice note fail with "Storage config missing". Small attachments now
      // live in the database and are served from /api/media/<id>; anything over the limit is
      // refused with a message that says what to do about it.
      const bytes = Buffer.from(input.base64, "base64");
      if (bytes.length > MAX_DB_MEDIA_BYTES) {
        throw new Error(
          `Attachment is ${(bytes.length / 1e6).toFixed(1)} MB. Photos and voice notes up to ${MAX_DB_MEDIA_BYTES / 1e6} MB work today; larger files need object storage configured.`,
        );
      }
      const id = await saveMessageMedia(ctx.user.id, input.contentType, input.fileName, input.base64);
      return { key: `db:${id}`, url: `/api/media/${id}`, fileName: input.fileName, contentType: input.contentType };
    }),
  }),
  push: router({
    register: protectedProcedure.input(z.object({ token: z.string().min(1).max(512), platform: z.string().max(32).optional() })).mutation(({ ctx, input }) => registerPushToken(ctx.user.id, input.token, input.platform)),
  }),
  // ---- calls: LiveKit carries the audio/video, this carries ringing state and history ---
  calls: router({
    config: protectedProcedure.query(() => ({ configured: isLiveKitConfigured(), url: liveKitUrl() })),
    start: protectedProcedure.input(z.object({ conversationId: z.string().min(1), kind: z.enum(["audio", "video"]).default("audio") })).mutation(async ({ ctx, input }) => {
      if (!(await isConversationMember(input.conversationId, ctx.user.id))) throw new Error("You are not in this conversation");
      await expireStaleCalls(input.conversationId);
      const room = `call_${crypto.randomUUID()}`;
      const callId = await createCallRecord(input.conversationId, ctx.user.id, room, input.kind);
      // Ring the other side now rather than at their next poll.
      void nudgeConversation(input.conversationId, ctx.user.id, "call");
      const displayName = ctx.user.name?.trim() || ctx.user.username || `User ${ctx.user.id}`;
      const token = await createRoomToken(`user-${ctx.user.id}`, displayName, room);
      return { callId, room, token, url: liveKitUrl(), kind: input.kind, status: "ringing" as const };
    }),
    answer: protectedProcedure.input(z.object({ callId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      const call = await getCallRecord(input.callId);
      if (!call) throw new Error("That call has ended");
      if (!(await isConversationMember(call.conversationId, ctx.user.id))) throw new Error("You are not in this conversation");
      await setCallStatus(call.id, "active");
      // The caller needs to stop ringing the moment this lands.
      void nudgeConversation(call.conversationId, ctx.user.id, "call");
      const displayName = ctx.user.name?.trim() || ctx.user.username || `User ${ctx.user.id}`;
      const token = await createRoomToken(`user-${ctx.user.id}`, displayName, call.room);
      return { callId: call.id, room: call.room, token, url: liveKitUrl(), kind: call.kind, status: "active" as const };
    }),
    decline: protectedProcedure.input(z.object({ callId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      const call = await getCallRecord(input.callId);
      if (!call) return { ok: true as const };
      if (!(await isConversationMember(call.conversationId, ctx.user.id))) throw new Error("You are not in this conversation");
      await setCallStatus(call.id, "declined");
      return { ok: true as const };
    }),
    end: protectedProcedure.input(z.object({ callId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      const call = await getCallRecord(input.callId);
      if (!call) return { ok: true as const };
      if (!(await isConversationMember(call.conversationId, ctx.user.id))) throw new Error("You are not in this conversation");
      // A call that was never answered is a missed call, not an ended one.
      await setCallStatus(call.id, call.status === "ringing" ? "missed" : "ended");
      return { ok: true as const };
    }),
    incoming: protectedProcedure.query(async ({ ctx }) => (await getIncomingCallForUser(ctx.user.id)) ?? null),
    history: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(50).default(30) }).optional()).query(({ ctx, input }) => listRecentCalls(ctx.user.id, input?.limit ?? 30)),
    // A shareable room. The link carries only an unguessable room name and anyone signed in
    // who opens it gets their own token, so no row is written until somebody actually joins.
    createLink: protectedProcedure.input(z.object({ kind: z.enum(["audio", "video"]).default("audio") })).mutation(async ({ ctx, input }) => {
      if (!isLiveKitConfigured()) throw new Error("Calls are not configured on this server.");
      const room = `link_${crypto.randomUUID()}`;
      const displayName = ctx.user.name?.trim() || ctx.user.username || `User ${ctx.user.id}`;
      const token = await createRoomToken(`user-${ctx.user.id}`, displayName, room);
      return { room, token, url: liveKitUrl(), kind: input.kind };
    }),
    joinLink: protectedProcedure.input(z.object({ room: z.string().min(8).max(128) })).mutation(async ({ ctx, input }) => {
      if (!input.room.startsWith("link_")) throw new Error("That call link is not valid.");
      const displayName = ctx.user.name?.trim() || ctx.user.username || `User ${ctx.user.id}`;
      const token = await createRoomToken(`user-${ctx.user.id}`, displayName, input.room);
      return { room: input.room, token, url: liveKitUrl(), kind: "audio" as const };
    }),
  }),
  profile: router({
    update: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(60).optional(), about: z.string().trim().max(140).optional(), phone: z.string().trim().regex(/^\+?\d{7,15}$/, "Enter a valid phone number").optional() })).mutation(({ ctx, input }) => updateUserProfile(ctx.user.id, input)),
    setAvatar: protectedProcedure.input(z.object({ base64: z.string().min(1).max(4_000_000), mimeType: z.string().regex(/^image\/(png|jpe?g|webp)$/) })).mutation(async ({ ctx, input }) => {
      const updatedAt = await setUserAvatar(ctx.user.id, input.mimeType, input.base64);
      return { avatarUpdatedAt: updatedAt.toISOString() };
    }),
    clearAvatar: protectedProcedure.mutation(async ({ ctx }) => {
      await clearUserAvatar(ctx.user.id);
      return { ok: true as const };
    }),
  }),
  settings: router({
    get: protectedProcedure.query(({ ctx }) => getUserSettings(ctx.user.id)),
    update: protectedProcedure.input(z.object({ readReceipts: z.boolean().optional(), lastSeen: z.boolean().optional(), darkTheme: z.boolean().optional(), notificationsMessages: z.boolean().optional(), notificationsGroups: z.boolean().optional(), notificationsCalls: z.boolean().optional(), autoDownloadMedia: z.boolean().optional() })).mutation(({ ctx, input }) => updateUserSettings(ctx.user.id, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, value ? 1 : 0])) as any)),
    /**
     * The account-wide message timer, kept apart from `update` because that route treats every field
     * as a boolean and would flatten a number of seconds into 1.
     */
    setMessageTimer: protectedProcedure.input(z.object({ seconds: z.number().int().min(0).max(7776000) })).mutation(({ ctx, input }) => updateUserSettings(ctx.user.id, { defaultDisappearSeconds: input.seconds })),
  }),

  security: router({
    /** Whether a two-step PIN is set, so the lock screen knows whether it has anything to ask for. */
    status: protectedProcedure.query(async ({ ctx }) => ({ pinSet: Boolean(await getPinHash(ctx.user.id)) })),

    /** Every device currently signed in, with the one asking marked so it cannot be ended by mistake. */
    devices: protectedProcedure.query(async ({ ctx }) => {
      const [rows, current] = await Promise.all([listSessions(ctx.user.id), sdk.sessionIdFromRequest(ctx.req)]);
      return rows.map((row) => ({ id: row.id, userAgent: row.userAgent, platform: row.platform, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, current: row.id === current }));
    }),

    revokeDevice: protectedProcedure.input(z.object({ sessionId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      const revoked = await revokeSession(ctx.user.id, input.sessionId);
      if (!revoked) throw new Error("That device is not signed in any more");
      return { ok: true as const };
    }),

    revokeOtherDevices: protectedProcedure.mutation(async ({ ctx }) => {
      const count = await revokeOtherSessions(ctx.user.id, await sdk.sessionIdFromRequest(ctx.req));
      return { count };
    }),

    setPin: protectedProcedure.input(z.object({ password: z.string().min(1).max(128), pin: z.string().regex(/^\d{4,8}$/, "Use 4 to 8 digits") })).mutation(async ({ ctx, input }) => {
      await requireAccountPassword(ctx.user, input.password);
      await setPinHash(ctx.user.id, await hashPassword(input.pin));
      return { ok: true as const };
    }),

    removePin: protectedProcedure.input(z.object({ password: z.string().min(1).max(128) })).mutation(async ({ ctx, input }) => {
      await requireAccountPassword(ctx.user, input.password);
      await setPinHash(ctx.user.id, null);
      return { ok: true as const };
    }),

    /**
     * Checks a PIN to unlock the app.
     *
     * Failures are counted in memory per account and the fifth attempt onwards is refused for a while.
     * A per-instance counter is a speed bump rather than a wall - it resets when the serverless function
     * recycles - but the alternative is unlimited guesses at a four digit code, and the session is
     * already required to get this far.
     */
    verifyPin: protectedProcedure.input(z.object({ pin: z.string().min(1).max(16) })).mutation(async ({ ctx, input }) => {
      const hash = await getPinHash(ctx.user.id);
      if (!hash) return { ok: true, pinSet: false };
      const now = Date.now();
      const record = pinAttempts.get(ctx.user.id);
      if (record && record.lockedUntil > now) {
        return { ok: false, pinSet: true, lockedForMs: record.lockedUntil - now };
      }
      const ok = await verifyPassword(input.pin, hash);
      if (ok) {
        pinAttempts.delete(ctx.user.id);
        return { ok: true, pinSet: true };
      }
      const failures = (record && record.lockedUntil <= now ? record.failures : 0) + 1;
      // Five tries, then a pause that doubles from a minute up to fifteen.
      const lockedUntil = failures >= 5 ? now + Math.min(60_000 * 2 ** (failures - 5), 15 * 60_000) : 0;
      pinAttempts.set(ctx.user.id, { failures, lockedUntil });
      return { ok: false, pinSet: true, attemptsLeft: Math.max(0, 5 - failures), lockedForMs: lockedForMsOf(lockedUntil, now) };
    }),
  }),

  account: router({
    /**
     * Starts a phone-number change. The code goes to the email on the account and is bound to the number
     * being claimed, so a code that leaks cannot be used to move the account somewhere else.
     */
    startNumberChange: protectedProcedure.input(z.object({ password: z.string().min(1).max(128), phone: z.string().trim().regex(/^\+?\d{7,15}$/, "Enter a valid phone number") })).mutation(async ({ ctx, input }) => {
      await requireAccountPassword(ctx.user, input.password);
      if (!ctx.user.email) throw new Error("This account has no email address to send a code to");
      const normalized = normalizePhone(input.phone);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await createAuthToken(ctx.user.id, "change-phone", bindCodeToPhone(code, normalized), new Date(Date.now() + 30 * 60 * 1000));
      const delivered = await sendEmail(ctx.user.email, "Confirm your new Varnox number", code, "number change");
      return { sent: true, phone: normalized, delivered, devCode: delivered ? undefined : code, emailHint: maskEmail(ctx.user.email) };
    }),

    confirmNumberChange: protectedProcedure.input(z.object({ code: z.string().trim().min(4).max(8), phone: z.string().trim().regex(/^\+?\d{7,15}$/) })).mutation(async ({ ctx, input }) => {
      const normalized = normalizePhone(input.phone);
      const record = await consumeAuthToken("change-phone", bindCodeToPhone(input.code, normalized));
      if (!record || record.userId !== ctx.user.id) throw new Error("That code is not valid or has expired");
      await updateUserProfile(ctx.user.id, { phone: normalized });
      return { phone: normalized };
    }),

    /**
     * Deletes the account for good.
     *
     * Two confirmations on purpose: the account password, and a phrase typed out in full. A single
     * button next to "Sign out" is how people delete an account they meant to keep.
     */
    deleteAccount: protectedProcedure.input(z.object({ password: z.string().min(1).max(128), confirm: z.string() })).mutation(async ({ ctx, input }) => {
      if (input.confirm.trim() !== "DELETE") throw new Error('Type DELETE to confirm');
      await requireAccountPassword(ctx.user, input.password);
      await deleteUserAccount(ctx.user.id);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { ok: true as const };
    }),
  }),

  stickers: router({
    list: protectedProcedure.query(({ ctx }) => listStickers(ctx.user.id)),

    /**
     * Keeps a sticker. The image arrives as base64 exactly like an attachment, but with a much lower
     * ceiling: a sticker is a small graphic, and letting photographs in would turn a picker into a
     * second photo library.
     */
    add: protectedProcedure.input(z.object({ base64: z.string().min(1).max(4_000_000), mimeType: z.string().regex(/^image\/(png|jpe?g|webp|gif)$/) })).mutation(async ({ ctx, input }) => {
      const bytes = Buffer.from(input.base64, "base64");
      if (bytes.length > MAX_STICKER_BYTES) throw new Error(`Stickers have to be under ${Math.round(MAX_STICKER_BYTES / 1024)} KB. Try a smaller image.`);
      const sticker = await addSticker({ userId: ctx.user.id, mimeType: input.mimeType, data: input.base64 });
      if (!sticker) throw new Error("Could not save that sticker");
      // The client sends this straight back as the message's mediaUrl, so it is absolute from here.
      return { id: sticker.id, url: `/api/sticker/${sticker.id}`, createdAt: sticker.createdAt };
    }),

    remove: protectedProcedure.input(z.object({ id: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      const removed = await removeSticker(ctx.user.id, input.id);
      if (!removed) throw new Error("That sticker is not in your library");
      return { ok: true as const };
    }),
  }),

  broadcasts: router({
    list: protectedProcedure.query(({ ctx }) => listBroadcastLists(ctx.user.id)),

    create: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(64), memberIds: z.array(z.number().int().positive()).min(1).max(256) })).mutation(async ({ ctx, input }) => {
      const blocked = new Set((await listBlockedContacts(ctx.user.id)).map((row) => row.id));
      const allowed = input.memberIds.filter((id) => !blocked.has(id) && id !== ctx.user.id);
      if (allowed.length === 0) throw new Error("A list needs at least one contact you have not blocked");
      return createBroadcastList(ctx.user.id, input.name.trim(), allowed);
    }),

    remove: protectedProcedure.input(z.object({ listId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      const removed = await deleteBroadcastList(ctx.user.id, input.listId);
      if (!removed) throw new Error("That list does not exist");
      return { ok: true as const };
    }),

    /**
     * Sends one message to everybody on a list.
     *
     * Each recipient gets an ordinary direct message, and nothing in it says it went to more than one
     * person - that is the point of the feature. A recipient who cannot be reached (never messaged
     * before, or now blocked) is reported rather than silently dropped.
     */
    send: protectedProcedure.input(z.object({ listId: z.string().min(1).max(64), body: z.string().trim().min(1).max(10000) })).mutation(async ({ ctx, input }) => {
      const list = await broadcastRecipientsFor(ctx.user.id, input.listId);
      if (!list) throw new Error("That list does not exist");
      if (list.recipientIds.length === 0) throw new Error("That list has nobody on it");

      const blocked = new Set((await listBlockedContacts(ctx.user.id)).map((row) => row.id));
      let delivered = 0;
      const failed: number[] = [];
      for (const recipientId of list.recipientIds) {
        if (blocked.has(recipientId)) {
          failed.push(recipientId);
          continue;
        }
        try {
          const direct = await findOrCreateDirectConversation(ctx.user.id, recipientId);
          if (!direct) {
            failed.push(recipientId);
            continue;
          }
          const conversationId = direct.conversationId;
          const message = await createMessage({
            id: randomUUID(),
            conversationId,
            senderId: ctx.user.id,
            kind: "text",
            body: input.body,
            expiresAt: null,
          });
          if (message) {
            delivered += 1;
            void nudgeConversation(conversationId, ctx.user.id, "message");
          } else {
            failed.push(recipientId);
          }
        } catch {
          failed.push(recipientId);
        }
      }
      return { delivered, failed, listName: list.name };
    }),
  }),

  communities: router({
    list: protectedProcedure.query(({ ctx }) => listCommunitiesForUser(ctx.user.id)),

    create: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(255).optional() })).mutation(async ({ ctx, input }) => {
      const created = await createCommunity(ctx.user.id, input.name.trim(), input.description?.trim() || null);
      if (!created) throw new Error("Could not create that community");
      return { id: created.id, name: created.name };
    }),

    detail: protectedProcedure.input(z.object({ communityId: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
      const detail = await communityDetail(input.communityId, ctx.user.id);
      if (!detail) throw new Error("You cannot see that community");
      return detail;
    }),

    linkGroup: protectedProcedure.input(z.object({ communityId: z.string().min(1).max(64), conversationId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      await linkCommunityGroup(input.communityId, input.conversationId, ctx.user.id);
      void nudgeConversation(input.conversationId, ctx.user.id, "group-updated");
      return { ok: true as const };
    }),

    unlinkGroup: protectedProcedure.input(z.object({ communityId: z.string().min(1).max(64), conversationId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      const removed = await unlinkCommunityGroup(input.communityId, input.conversationId, ctx.user.id);
      if (!removed) throw new Error("That group is not in this community");
      return { ok: true as const };
    }),

    remove: protectedProcedure.input(z.object({ communityId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      const removed = await deleteCommunity(input.communityId, ctx.user.id);
      if (!removed) throw new Error("That community does not exist");
      return { ok: true as const };
    }),
  }),

  blocks: router({
    list: protectedProcedure.query(({ ctx }) => listBlockedContacts(ctx.user.id)),
    block: protectedProcedure.input(z.object({ userId: z.number().int().positive() })).mutation(({ ctx, input }) => setBlockedContact(ctx.user.id, input.userId, true)),
    unblock: protectedProcedure.input(z.object({ userId: z.number().int().positive() })).mutation(({ ctx, input }) => setBlockedContact(ctx.user.id, input.userId, false)),
  }),
  appeals: router({
    mine: protectedProcedure.query(({ ctx }) => listAppealsForUser(ctx.user.id)),
    /**
     * Files a request for review and returns the deadline the person is told to expect.
     *
     * The details are optional, the way the field says on screen. This used to demand three characters,
     * so pressing Submit with an empty box failed validation and no request was ever filed.
     */
    submit: publicProcedure
      .input(z.object({ username: z.string().min(3).max(32), reason: z.string().max(1000).optional() }))
      .mutation(async ({ input }) => {
        const user = await getUserByUsername(input.username.trim().toLowerCase());
        if (!user) throw new Error("Account not found");
        const appeal = await createAppeal(user.id, input.reason?.trim() || "No additional details given.");
        return { reviewDueAt: appeal.reviewDueAt, state: appeal.status as "pending" | "approved" | "rejected" };
      }),

    /**
     * Polled by the ban screen, so a restored account finds out without having to guess.
     *
     * Public because the person asking is signed out by definition - the ban is what stopped them
     * getting in. It answers with a state and two dates for one username, and says nothing else.
     */
    status: publicProcedure
      .input(z.object({ username: z.string().min(3).max(32) }))
      .query(({ input }) => appealStatusForUsername(input.username.trim().toLowerCase())),
  }),
  people: router({
    search: protectedProcedure.input(z.object({ query: z.string().min(2).max(80) })).query(({ ctx, input }) => searchUsers(input.query, ctx.user.id)),
  }),
  support: router({
    ask: protectedProcedure.input(z.object({ message: z.string().min(1).max(1000) })).mutation(({ input }) => {
      const message = input.message.toLowerCase();
      if (message.includes("login") || message.includes("code")) return { text: "For login help, enter your phone and email, then use the one-time code sent by Varnox through Resend." };
      if (message.includes("report") || message.includes("block")) return { text: "You can block contacts from Privacy settings. For a safety report, include the account name and what happened." };
      if (message.includes("group")) return { text: "Open Chats → menu → New group. You can add members by phone or share an invite link." };
      return { text: "I’m Varnox Support. I can help with login, groups, privacy, blocking, reports, calls, and media. What do you need?" };
    }),
  }),
  // ---- status: "stories" that expire 24 hours after they are posted --------------------
  // Visible to the author and to anyone they share a conversation with. Images go through
  // media.upload first, so the bytes live in messageMedia and only the URL is stored here.
  status: router({
    feed: protectedProcedure.query(async ({ ctx }) => {
      const authorIds = [ctx.user.id, ...(await listContactIdsForUser(ctx.user.id))];
      const rows = await listActiveStatusesByAuthors(authorIds);
      const viewed = new Set(await listViewedStatusIds(rows.map((row) => row.id), ctx.user.id));
      const byAuthor = new Map<number, { userId: number; name: string; username: string | null; avatarUpdatedAt: Date | null; allSeen: boolean; items: (StatusRow & { seen: boolean })[] }>();
      for (const row of rows) {
        const seen = row.userId === ctx.user.id || viewed.has(row.id);
        const entry = byAuthor.get(row.userId) ?? { userId: row.userId, name: row.authorName ?? row.authorUsername ?? `User ${row.userId}`, username: row.authorUsername, avatarUpdatedAt: row.authorAvatarUpdatedAt, allSeen: true, items: [] as (StatusRow & { seen: boolean })[] };
        entry.items.push({ ...row, seen });
        if (!seen) entry.allSeen = false;
        byAuthor.set(row.userId, entry);
      }
      // The author's own statuses lead the row, as they do in the apps this follows.
      return Array.from(byAuthor.values()).sort((a, b) => Number(b.userId === ctx.user.id) - Number(a.userId === ctx.user.id));
    }),
    create: protectedProcedure.input(z.object({ kind: z.enum(["text", "image"]).default("text"), body: z.string().trim().max(700).optional(), mediaUrl: z.string().max(2000).optional(), background: z.string().max(16).default("amber") })).mutation(async ({ ctx, input }) => {
      if (input.kind === "text" && !input.body) throw new Error("Write something for your status");
      if (input.kind === "image" && !input.mediaUrl) throw new Error("Add a photo to your status");
      const id = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await createStatus({ id, userId: ctx.user.id, kind: input.kind, body: input.body ?? null, mediaUrl: input.mediaUrl ?? null, background: input.background, expiresAt });
      return { id, expiresAt };
    }),
    view: protectedProcedure.input(z.object({ statusId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      await markStatusViewed(input.statusId, ctx.user.id);
      return { ok: true as const };
    }),
    viewers: protectedProcedure.input(z.object({ statusId: z.string().min(1) })).query(async ({ ctx, input }) => {
      const status = await getStatus(input.statusId);
      if (!status) throw new Error("That status has expired");
      if (status.userId !== ctx.user.id) throw new Error("Only the author can see who viewed a status");
      return listStatusViewers(input.statusId);
    }),
    remove: protectedProcedure.input(z.object({ statusId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      await deleteStatus(input.statusId, ctx.user.id);
      return { ok: true as const };
    }),
  }),
  // ---- channels: one-to-many broadcasts anyone can follow ------------------------------
  channels: router({
    list: protectedProcedure.query(({ ctx }) => listChannelsForUser(ctx.user.id)),
    search: protectedProcedure.input(z.object({ query: z.string().trim().min(1).max(80) })).query(({ ctx, input }) => searchChannels(input.query, ctx.user.id)),
    get: protectedProcedure.input(z.object({ channelId: z.string().min(1) })).query(async ({ ctx, input }) => {
      const channel = await getChannelDetail(input.channelId, ctx.user.id);
      if (!channel) throw new Error("That channel no longer exists");
      return channel;
    }),
    create: protectedProcedure.input(z.object({ name: z.string().trim().min(3).max(80), description: z.string().trim().max(255).optional() })).mutation(async ({ ctx, input }) => {
      const channelId = await createChannel(ctx.user.id, input.name, input.description?.trim() || null);
      return { channelId };
    }),
    follow: protectedProcedure.input(z.object({ channelId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      const channel = await getChannel(input.channelId);
      if (!channel) throw new Error("That channel no longer exists");
      if (channel.suspendedAt) throw new Error("This channel has been suspended");
      await followChannel(channel.id, ctx.user.id);
      return { ok: true as const };
    }),
    unfollow: protectedProcedure.input(z.object({ channelId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      await unfollowChannel(input.channelId, ctx.user.id);
      return { ok: true as const };
    }),
    posts: protectedProcedure.input(z.object({ channelId: z.string().min(1), limit: z.number().int().min(1).max(100).default(50) })).query(({ input }) => listChannelPosts(input.channelId, input.limit)),
    post: protectedProcedure.input(z.object({ channelId: z.string().min(1), body: z.string().trim().min(1).max(2000), mediaUrl: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => {
      const channel = await getChannel(input.channelId);
      if (!channel) throw new Error("That channel no longer exists");
      if (channel.ownerId !== ctx.user.id) throw new Error("Only the channel owner can post");
      if (channel.suspendedAt) throw new Error("This channel is suspended, so it cannot post");
      const id = await createChannelPost({ id: randomUUID(), channelId: channel.id, authorId: ctx.user.id, body: input.body, mediaUrl: input.mediaUrl ?? null });
      return { id };
    }),
    removePost: protectedProcedure.input(z.object({ postId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      const post = await getChannelPost(input.postId);
      if (!post) return { ok: true as const };
      const channel = await getChannel(post.channelId);
      if (post.authorId !== ctx.user.id && channel?.ownerId !== ctx.user.id) throw new Error("Only the author or the channel owner can delete a post");
      await removeChannelPost(post.id, ctx.user.id);
      return { ok: true as const };
    }),
    followers: protectedProcedure.input(z.object({ channelId: z.string().min(1) })).query(({ input }) => listChannelFollowers(input.channelId)),
    read: protectedProcedure.input(z.object({ channelId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      await markChannelRead(input.channelId, ctx.user.id);
      return { ok: true as const };
    }),
  }),
  admin: router({
    users: adminProcedure.query(() => listUsersForAdmin()),
    appeals: adminProcedure.query(() => listAppealsForAdmin()),
    reviewAppeal: adminProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["approved", "rejected"]), note: z.string().max(1000).optional() })).mutation(({ ctx, input }) => reviewAppeal(input.id, ctx.user.id, input.status, input.note?.trim() || null)),
    moderate: adminProcedure.input(z.object({ userId: z.number().int().positive(), status: z.enum(["active", "suspended", "banned"]), durationHours: z.number().int().min(1).max(8760).optional(), reason: z.string().max(500).optional() })).mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) throw new Error("Administrators cannot moderate their own account");
      const until = input.status === "suspended" ? new Date(Date.now() + (input.durationHours ?? 24) * 60 * 60 * 1000) : null;
      const user = await moderateUser(input.userId, input.status, until, input.reason?.trim() || null);
      if (!user) throw new Error("User not found");
      return { id: user.id, status: user.moderationStatus, suspendedUntil: user.suspendedUntil };
    }),
    // ---- status + channel moderation: list, then remove or suspend ----------------------
    statuses: adminProcedure.query(() => listStatusesForAdmin()),
    removeStatus: adminProcedure.input(z.object({ statusId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      await adminRemoveStatus(input.statusId, ctx.user.id);
      return { ok: true as const };
    }),
    channels: adminProcedure.query(() => listChannelsForAdmin()),
    channelPosts: adminProcedure.query(() => listChannelPostsForAdmin()),
    suspendChannel: adminProcedure.input(z.object({ channelId: z.string().min(1), suspended: z.boolean(), reason: z.string().max(500).optional() })).mutation(async ({ input }) => {
      await setChannelSuspended(input.channelId, input.suspended, input.reason?.trim() || null);
      return { ok: true as const };
    }),
    removeChannelPost: adminProcedure.input(z.object({ postId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      await removeChannelPost(input.postId, ctx.user.id);
      return { ok: true as const };
    }),
    deleteChannel: adminProcedure.input(z.object({ channelId: z.string().min(1) })).mutation(async ({ input }) => {
      await deleteChannel(input.channelId);
      return { ok: true as const };
    }),
  }),
});

export type AppRouter = typeof appRouter;
