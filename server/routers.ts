import { z } from "zod";
import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { clearUserAvatar, createAppeal, createMessage, createConversation, getUserByUsername, getUserSettings, isConversationMember, listAppealsForAdmin, listAppealsForUser, listBlockedContacts, listConversationsForUser, listMessages, listUsersForAdmin, moderateUser, registerPushToken, reviewAppeal, searchUsers, setBlockedContact, setUserAvatar, updateUserProfile, updateUserSettings } from "./db";
import { storagePut } from "./storage";
import { notifyConversationMembers } from "./push";
import { messages } from "../drizzle/schema";

const messageKind = z.enum(["text", "image", "video", "file", "voice"]);

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
    messages: protectedProcedure.input(z.object({ conversationId: z.string().min(1), since: z.string().datetime().optional() })).query(({ ctx, input }) => listMessages(input.conversationId, ctx.user.id, input.since ? new Date(input.since) : undefined)),
    ensure: protectedProcedure.input(z.object({ conversationId: z.string().min(1), title: z.string().max(255).optional() })).mutation(async ({ ctx, input }) => {
      if (!(await isConversationMember(input.conversationId, ctx.user.id))) await createConversation(input.conversationId, ctx.user.id, input.title);
      return { conversationId: input.conversationId };
    }),
    send: protectedProcedure.input(z.object({ conversationId: z.string().min(1), body: z.string().max(10000).optional(), kind: messageKind.default("text"), mediaUrl: z.string().max(2000).optional(), mediaMime: z.string().max(160).optional(), mediaName: z.string().max(255).optional(), voiceDurationMs: z.number().int().min(0).max(3600000).optional() })).mutation(async ({ ctx, input }) => {
      if (!(await isConversationMember(input.conversationId, ctx.user.id))) throw new Error("You are not a member of this conversation");
      const message: typeof messages.$inferInsert = { id: crypto.randomUUID(), conversationId: input.conversationId, senderId: ctx.user.id, body: input.body ?? null, kind: input.kind, mediaUrl: input.mediaUrl ?? null, mediaMime: input.mediaMime ?? null, mediaName: input.mediaName ?? null, voiceDurationMs: input.voiceDurationMs ?? null };
      const created = await createMessage(message);
      void notifyConversationMembers({ conversationId: input.conversationId, senderId: ctx.user.id, title: ctx.user.name ?? "New message", body: input.body ?? (input.kind === "voice" ? "Voice note" : "Shared media") });
      return created;
    }),
  }),
  media: router({
    upload: protectedProcedure.input(z.object({ fileName: z.string().min(1).max(255), contentType: z.string().min(1).max(160), base64: z.string().min(1).max(30_000_000) })).mutation(async ({ ctx, input }) => {
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const result = await storagePut(`varnox/${ctx.user.id}/${Date.now()}-${safeName}`, Buffer.from(input.base64, "base64"), input.contentType);
      return { ...result, fileName: input.fileName, contentType: input.contentType };
    }),
  }),
  push: router({
    register: protectedProcedure.input(z.object({ token: z.string().min(1).max(512), platform: z.string().max(32).optional() })).mutation(({ ctx, input }) => registerPushToken(ctx.user.id, input.token, input.platform)),
  }),
  profile: router({
    update: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(60).optional(), about: z.string().trim().max(140).optional() })).mutation(({ ctx, input }) => updateUserProfile(ctx.user.id, input)),
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
  }),
});

export type AppRouter = typeof appRouter;
