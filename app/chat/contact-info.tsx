import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { avatarUrl } from "@/lib/media-url";
import { trpc } from "@/lib/trpc";

/**
 * The info screen for a one-to-one chat.
 *
 * It exists because there was only ever a group screen, and the chat header opened it for every
 * conversation. Tapping the name of a private chat therefore landed on "Group info" - a member list,
 * a group photo, an invite link and a Leave group button - which reads as the app having classified
 * your 1:1 as a group.
 *
 * The other half of that report was that the person on the other end could not see the messages at
 * all. This screen is where that becomes visible instead of silent: if the conversation turns out to
 * have nobody else in it, it says so plainly, because a chat whose only member is you is a chat where
 * every message goes nowhere.
 */

type Member = {
  userId: number;
  role: string;
  name?: string | null;
  username?: string | null;
  avatarUpdatedAt?: string | null;
};

function initialsOf(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function ContactInfoScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();

  const membersQuery = trpc.conversations.members.useQuery(
    { conversationId: conversationId ?? "" },
    { enabled: Boolean(conversationId) },
  );

  const members = (membersQuery.data?.members ?? []) as Member[];
  const me = user?.id;
  const peer = members.find((member) => member.userId !== me) ?? null;
  const alone = !membersQuery.isLoading && !membersQuery.error && members.length > 0 && !peer;
  const title = membersQuery.data?.title?.trim() || peer?.name?.trim() || peer?.username || "This chat";

  const avatar = peer ? avatarUrl(peer.userId, peer.avatarUpdatedAt) : undefined;

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          Contact info
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {membersQuery.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
        {membersQuery.error ? <Text style={[styles.error, { color: colors.error }]}>{membersQuery.error.message}</Text> : null}

        {peer ? (
          <>
            <View style={styles.identity}>
              {avatar ? (
                <Image source={{ uri: avatar }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarEmpty, { backgroundColor: colors.primary }]}>
                  <Text style={styles.avatarInitial}>{initialsOf(title)}</Text>
                </View>
              )}
              <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
                {title}
              </Text>
              {peer.username ? (
                <Text style={[styles.handle, { color: colors.muted }]}>@{peer.username}</Text>
              ) : null}
              <Text style={[styles.kindNote, { color: colors.muted }]}>
                One-to-one chat. Only you and {title} can read it.
              </Text>
            </View>

            <View style={styles.actions}>
              <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.action, { backgroundColor: colors.primary }, pressed && styles.pressed]}>
                <MaterialIcons name="chat-bubble-outline" size={18} color="#FFFFFF" />
                <Text style={styles.actionText}>Message</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push({ pathname: "/chat/chat-settings", params: { conversationId: conversationId ?? "" } })}
                style={({ pressed }) => [styles.action, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }, pressed && styles.pressed]}
              >
                <MaterialIcons name="tune" size={18} color={colors.primary} />
                <Text style={[styles.actionText, { color: colors.foreground }]}>Chat settings</Text>
              </Pressable>
            </View>
          </>
        ) : null}

        {/*
          The state that produced the "he cannot see my messages" report. A conversation can exist
          with only its creator in it - a group whose every invitee was refused by their own privacy
          setting used to be created anyway - and until now nothing on screen distinguished it from a
          normal chat. Every message typed here is delivered to nobody.
        */}
        {alone ? (
          <View style={[styles.warning, { backgroundColor: colors.surface, borderColor: colors.warning }]}>
            <MaterialIcons name="error-outline" size={20} color={colors.warning} />
            <Text style={[styles.warningTitle, { color: colors.foreground }]}>Nobody else is in this chat</Text>
            <Text style={[styles.warningBody, { color: colors.muted }]}>
              You are its only member, so messages you send here are not delivered to anyone. Close this chat and start it
              again from the entry for that person in the new-conversation sheet - that creates a one-to-one chat, which is
              not affected by group privacy settings.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 20, fontWeight: "800" },
  content: { padding: 24, paddingBottom: 60 },
  identity: { alignItems: "center", marginBottom: 30 },
  avatar: { width: 116, height: 116, borderRadius: 58, alignItems: "center", justifyContent: "center" },
  avatarEmpty: {},
  avatarInitial: { color: "#FFFFFF", fontSize: 40, fontWeight: "800" },
  name: { fontSize: 22, fontWeight: "800", marginTop: 16 },
  handle: { fontSize: 14, marginTop: 5 },
  kindNote: { fontSize: 12.5, marginTop: 12, textAlign: "center", lineHeight: 18 },
  actions: { gap: 10 },
  action: { height: 50, borderRadius: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  actionText: { color: "#FFFFFF", fontSize: 14.5, fontWeight: "800" },
  pressed: { opacity: 0.7 },
  error: { fontSize: 13, fontWeight: "700", marginBottom: 16 },
  warning: { marginTop: 28, borderWidth: 1, borderRadius: 16, padding: 16, gap: 8 },
  warningTitle: { fontSize: 15, fontWeight: "800" },
  warningBody: { fontSize: 13, lineHeight: 19 },
});
