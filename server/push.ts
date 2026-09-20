import * as db from "./db";
import { sendWebPush } from "./webPush";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

type PushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: "default";
  channelId?: string;
};

type Category = "messages" | "groups" | "calls";

/**
 * Tells the other members about a message, over every channel that can reach them.
 *
 * Two channels, because they cover different situations and neither replaces the other. A browser
 * subscription is what delivers while the page is closed; a native token covers builds that are not
 * browsers at all.
 *
 * They run together rather than in sequence, and each is guarded on its own, so a channel that is
 * down cannot suppress the other or turn a stored message into a failed one. The number returned is
 * what was actually delivered, not what was attempted.
 */
export async function notifyConversationMembers(input: {
  conversationId: string;
  senderId: number;
  title: string;
  body: string;
  category?: Category;
}) {
  const category: Category = input.category ?? "messages";
  const memberIds = (await db.listConversationMemberIds(input.conversationId)).filter((id) => id !== input.senderId);
  if (memberIds.length === 0) return { delivered: 0 };

  const [native, web] = await Promise.all([
    sendExpoPush(memberIds, category, input),
    sendWebPush({
      userIds: memberIds,
      category,
      title: input.title,
      body: input.body,
      data: { conversationId: input.conversationId },
    }),
  ]);

  return { delivered: native + web };
}

/**
 * The Expo path.
 *
 * Kept separate so its failures are counted separately. It is currently inert: the token it needs
 * comes from getExpoPushTokenAsync with an EAS project id, and this app has none, so no token is
 * ever stored and this returns zero immediately. It is left in place because it is the correct
 * channel for an EAS-built native client, which is a plausible next step for the Android app.
 */
async function sendExpoPush(
  memberIds: number[],
  category: Category,
  input: { conversationId: string; title: string; body: string },
): Promise<number> {
  const tokens = await db.listPushTokensForPreference(memberIds, category);
  if (tokens.length === 0) return 0;

  const payload: PushMessage[] = tokens.map((token) => ({
    to: token,
    title: input.title,
    body: input.body,
    sound: "default",
    channelId: "messages",
    data: { conversationId: input.conversationId },
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.warn(`[Push] Expo delivery failed: ${response.status}`);
      return 0;
    }
    return payload.length;
  } catch (error) {
    // Without this the rejection would surface as an unhandled one, since callers fire and forget.
    console.warn("[Push] Expo delivery threw:", error instanceof Error ? error.message : error);
    return 0;
  }
}
