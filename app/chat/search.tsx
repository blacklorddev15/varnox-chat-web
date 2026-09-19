import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

function chatTime(value?: string | Date | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Searches real message text across the conversations the user belongs to. */
export default function SearchScreen() {
  const colors = useColors();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const searchQuery = trpc.conversations.search.useQuery(
    { query: debounced },
    { enabled: debounced.length > 0 },
  );
  const results = searchQuery.data ?? [];

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Search messages</Text>
      </View>

      <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <MaterialIcons name="search" size={20} color={colors.muted} />
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder="Search across chats"
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.foreground }]}
        />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {searchQuery.isFetching && debounced.length > 0 ? (
          <ActivityIndicator color={colors.primary} style={styles.spinner} />
        ) : null}

        {results.map((item) => (
          <Pressable
            key={item.id}
            style={[styles.result, { borderBottomColor: colors.border }]}
            onPress={() => router.push({ pathname: "/", params: { conversationId: item.conversationId } })}
          >
            <MaterialIcons name="chat-bubble-outline" size={19} color={colors.primary} />
            <View style={styles.copy}>
              <View style={styles.top}>
                <Text style={[styles.chat, { color: colors.foreground }]}>
                  {item.conversationTitle?.trim() || item.senderName || item.senderUsername || "Chat"}
                </Text>
                <Text style={[styles.time, { color: colors.muted }]}>{chatTime(item.createdAt)}</Text>
              </View>
              <Text style={[styles.message, { color: colors.muted }]}>
                {item.body ?? item.mediaName ?? "Attachment"}
              </Text>
            </View>
          </Pressable>
        ))}

        {debounced.length > 0 && !searchQuery.isFetching && results.length === 0 ? (
          <Text style={[styles.empty, { color: colors.muted }]}>No messages found.</Text>
        ) : null}
        {debounced.length === 0 ? (
          <Text style={[styles.empty, { color: colors.muted }]}>
            Type to search across your conversations.
          </Text>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  search: { height: 50, borderRadius: 16, borderWidth: 1, marginHorizontal: 20, paddingHorizontal: 14, flexDirection: "row", alignItems: "center" },
  input: { flex: 1, marginLeft: 8, fontSize: 15 },
  content: { padding: 20 },
  spinner: { marginTop: 30 },
  result: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth },
  copy: { flex: 1 },
  top: { flexDirection: "row", justifyContent: "space-between" },
  chat: { fontSize: 14, fontWeight: "800" },
  time: { fontSize: 11 },
  message: { fontSize: 13, marginTop: 5 },
  empty: { textAlign: "center", marginTop: 50 },
});
