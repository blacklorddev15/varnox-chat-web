import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/**
 * Starred messages, read from the server.
 *
 * This screen used to render a hardcoded empty array with a comment saying no star backend
 * existed, while the chat's "Star" button raised a toast and saved nothing. Both are now real.
 */
export default function StarredScreen() {
  const colors = useColors();
  const router = useRouter();
  const starred = trpc.conversations.starred.useQuery();
  const unstar = trpc.conversations.star.useMutation({ onSuccess: () => void starred.refetch() });
  const items = starred.data ?? [];

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Starred messages</Text>
        <MaterialIcons name="star" size={23} color={colors.primary} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {starred.isLoading ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}
        {items.map((item) => (
          <Pressable
            key={item.id}
            onPress={() => router.push({ pathname: "/(tabs)", params: { conversationId: item.conversationId } })}
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <View style={styles.cardTop}>
              <Text style={[styles.chat, { color: colors.primary }]}>{item.conversationTitle ?? "Chat"}</Text>
              <Text style={[styles.time, { color: colors.muted }]}>{new Date(item.createdAt).toLocaleDateString()}</Text>
            </View>
            <Text style={[styles.sender, { color: colors.muted }]}>{item.senderName}</Text>
            <Text style={[styles.message, { color: colors.foreground }]}>
              {item.body ?? item.mediaName ?? (item.kind === "voice" ? "Voice note" : "Shared media")}
            </Text>
            <Pressable
              onPress={() => unstar.mutate({ messageId: item.id, starred: false })}
              hitSlop={10}
              style={styles.star}
            >
              <MaterialIcons name="star" size={18} color={colors.primary} />
            </Pressable>
          </Pressable>
        ))}
        {!starred.isLoading && items.length === 0 ? (
          <Text style={[styles.note, { color: colors.muted }]}>
            No starred messages yet. Long-press any message and tap Star to keep it here.
          </Text>
        ) : null}
        {items.length > 0 ? (
          <Text style={[styles.note, { color: colors.muted }]}>
            Tap the star on a message to remove it from this list.
          </Text>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({ header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 }, title: { flex: 1, fontSize: 21, fontWeight: "800" }, content: { padding: 20, gap: 12 }, spinner: { marginTop: 20 }, card: { borderRadius: 18, borderWidth: 1, padding: 16 }, cardTop: { flexDirection: "row", justifyContent: "space-between" }, chat: { fontSize: 13, fontWeight: "800" }, time: { fontSize: 11 }, sender: { fontSize: 11.5, marginTop: 8 }, message: { fontSize: 15, lineHeight: 21, marginTop: 4, paddingRight: 22 }, star: { position: "absolute", right: 15, bottom: 15 }, note: { textAlign: "center", fontSize: 12, marginTop: 12 } });
