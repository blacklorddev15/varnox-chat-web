import * as db from "./db";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

type PushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: "default";
  channelId?: string;
};

export async function notifyConversationMembers(input: {
  conversationId: string;
  senderId: number;
  title: string;
  body: string;
  category?: "messages" | "groups" | "calls";
}) {
  const memberIds = (await db.listConversationMemberIds(input.conversationId)).filter((id) => id !== input.senderId);
  const tokens = await db.listPushTokensForPreference(memberIds, input.category ?? "messages");
  if (tokens.length === 0) return { delivered: 0 };

  const payload: PushMessage[] = tokens.map((token) => ({
    to: token,
    title: input.title,
    body: input.body,
    sound: "default",
    channelId: "messages",
    data: { conversationId: input.conversationId },
  }));

  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    console.warn(`[Push] Expo delivery failed: ${response.status}`);
    return { delivered: 0 };
  }
  return { delivered: payload.length };
}
