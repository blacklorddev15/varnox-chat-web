import { z } from "zod";
import { isObjectStorageConfigured } from "./storage";
import { MAX_DB_MEDIA_BYTES } from "./_core/mediaRoutes";
import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createRoomToken, isLiveKitConfigured, liveKitUrl } from "./livekit";
import { addConversationMembers, clearUserAvatar, createAppeal, createCallRecord, createGroupConversation, createMessage, createConversation, findOrCreateDirectConversation, expireStaleCalls, getCallRecord, getConversationRole, getIncomingCallForUser, getUserByUsername, getUserById, getUserSettings, isConversationMember, listRecentCalls, setCallStatus, listAppealsForAdmin, listAppealsForUser, listBlockedContacts, listConversationMembersDetailed, listConversationsForUser, listMessages, listUsersForAdmin, markConversationRead, moderateUser, registerPushToken, removeConversationMember, reviewAppeal, searchMessages, searchUsers, setBlockedContact, setConversationMemberRole, setUserAvatar, updateUserProfile, updateUserSettings, adminRemoveStatus, createChannel, createChannelPost, createStatus, deleteStatus, deleteChannel, followChannel, getChannel, getChannelDetail, getChannelPost, getStatus, isChannelFollower, saveMessageMedia, listActiveStatusesByAuthors, listChannelFollowers, listChannelPosts, listChannelPostsForAdmin, listChannelsForAdmin, listChannelsForUser, listContactIdsForUser, listStatusesForAdmin, listStatusViewers, listViewedStatusIds, markChannelRead, markStatusViewed, removeChannelPost, searchChannels, setChannelSuspended, unfollowChannel } from "./db";
import { storagePut } from "./storage";
import { notifyConversationMembers } from "./push";
import { messages } from "../drizzle/schema";
// Message actions (reactions, stars, edits, deletes, per-chat preferences) sit with the other
// row-level operations in db.ts; imported on their own line so the list above stays readable.
import { consumeViewOnce, conversationDisappearSeconds, deleteMessageForEveryone, editMessageBody, getMessageById, hideMessageForUser, listStarredMessages, markConversationDelivered, reactToMessage, setConversationDescription, setConversationDisappearing, setConversationMemberFlags, setMessageStar } from "./db";
// Presence: who is around right now, and who is mid-sentence. Also in db.ts, for the same reason.
import { listConversationMemberIds, listConversationPeerIds, readPresenceForUsers, readPresenceInbox, recordPresence } from "./db";
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

const messageKind = z.enum(["text", "image", "video", "file", "voice"]);

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
      return { role, members };
    }),
    addMembers: protectedProcedure.input(z.object({ conversationId: z.string().min(1), userIds: z.array(z.number().int().positive()).min(1).max(256) })).mutation(async ({ ctx, input }) => {
      const role = await getConversationRole(input.conversationId, ctx.user.id);
      if (role !== "owner" && role !== "admin") throw new Error("Only the group owner or an admin can add members");
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
    send: protectedProcedure.input(z.object({ conversationId: z.string().min(1), body: z.string().max(10000).optional(), kind: messageKind.default("text"), mediaUrl: z.string().max(2000).optional(), mediaMime: z.string().max(160).optional(), mediaName: z.string().max(255).optional(), voiceDurationMs: z.number().int().min(0).max(3600000).optional(), replyToId: z.string().max(64).optional(), forwardedFromId: z.string().max(64).optional(), viewOnce: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
      if (!(await isConversationMember(input.conversationId, ctx.user.id))) throw new Error("You are not a member of this conversation");
      // The disappearing clock is stamped at send time, so changing the setting later cannot
      // retroactively expire messages somebody already received.
      const disappearSeconds = await conversationDisappearSeconds(input.conversationId);
      const message: typeof messages.$inferInsert = { id: crypto.randomUUID(), conversationId: input.conversationId, senderId: ctx.user.id, body: input.body ?? null, kind: input.kind, mediaUrl: input.mediaUrl ?? null, mediaMime: input.mediaMime ?? null, mediaName: input.mediaName ?? null, voiceDurationMs: input.voiceDurationMs ?? null, replyToId: input.replyToId ?? null, forwardedFromId: input.forwardedFromId ?? null, viewOnce: input.viewOnce ? 1 : 0, expiresAt: disappearSeconds ? new Date(Date.now() + disappearSeconds * 1000) : null };
      const created = await createMessage(message);
      // A view-once photo must not be described in the notification body.
      const preview = input.viewOnce ? "Photo (view once)" : input.body ?? (input.kind === "voice" ? "Voice note" : "Shared media");
      void notifyConversationMembers({ conversationId: input.conversationId, senderId: ctx.user.id, title: ctx.user.name ?? "New message", body: preview });
      void nudgeConversation(input.conversationId, ctx.user.id, "message");
      return created;
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
    setFlags: protectedProcedure.input(z.object({ conversationId: z.string().min(1), archived: z.boolean().optional(), muted: z.boolean().optional(), pinned: z.boolean().optional(), draft: z.string().max(2000).nullable().optional() })).mutation(async ({ ctx, input }) => {
      if (!(await isConversationMember(input.conversationId, ctx.user.id))) throw new Error("You are not a member of this conversation");
      await setConversationMemberFlags(input.conversationId, ctx.user.id, { archived: input.archived, muted: input.muted, pinned: input.pinned, draft: input.draft });
      return { ok: true as const };
    }),
    markDelivered: protectedProcedure.input(z.object({ conversationId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      if (!(await isConversationMember(input.conversationId, ctx.user.id))) throw new Error("You are not a member of this conversation");
      await markConversationDelivered(input.conversationId, ctx.user.id);
      return { ok: true as const };
    }),
    setDescription: protectedProcedure.input(z.object({ conversationId: z.string().min(1), description: z.string().trim().max(255).nullable() })).mutation(async ({ ctx, input }) => {
      const role = await getConversationRole(input.conversationId, ctx.user.id);
      if (role !== "owner" && role !== "admin") throw new Error("Only the group owner or an admin can change the description");
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
    update: protectedProcedure.input(z.object({ readReceipts: z.boolean().optional(), lastSeen: z.boolean().optional(), darkTheme: z.boolean().optional(), notificationsMessages: z.boolean().optional(), notificationsGroups: z.boolean().optional(), notificationsCalls: z.boolean().optional() })).mutation(({ ctx, input }) => updateUserSettings(ctx.user.id, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, value ? 1 : 0])) as any)),
  }),
  blocks: router({
    list: protectedProcedure.query(({ ctx }) => listBlockedContacts(ctx.user.id)),
    block: protectedProcedure.input(z.object({ userId: z.number().int().positive() })).mutation(({ ctx, input }) => setBlockedContact(ctx.user.id, input.userId, true)),
    unblock: protectedProcedure.input(z.object({ userId: z.number().int().positive() })).mutation(({ ctx, input }) => setBlockedContact(ctx.user.id, input.userId, false)),
  }),
  appeals: router({
    mine: protectedProcedure.query(({ ctx }) => listAppealsForUser(ctx.user.id)),
    submit: publicProcedure.input(z.object({ username: z.string().min(3).max(32), reason: z.string().min(3).max(1000) })).mutation(async ({ input }) => { const user = await getUserByUsername(input.username.trim().toLowerCase()); if (!user) throw new Error("Account not found"); return createAppeal(user.id, input.reason.trim()); }),
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
      const id = await createChannelPost({ id: crypto.randomUUID(), channelId: channel.id, authorId: ctx.user.id, body: input.body, mediaUrl: input.mediaUrl ?? null });
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
